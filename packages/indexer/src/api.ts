import express, { Request, Response, NextFunction } from "express";
import { SorobanRpc } from "@stellar/stellar-sdk";
import { pool } from "./db";
import { cached } from "./cache";
import { getLastIndexedLedger } from "./events";
import { startTime, INDEXED_CONTRACTS } from "./index";
import swaggerUi from "swagger-ui-express";
import { generateOpenApiDocument } from "./openapi";

// ---------------------------------------------------------------------------
// In-process rate limiter (issue #437)
//
// Tracks request counts per IP in a sliding window. No external dependency
// required — the store is a plain Map that is pruned on every request so
// memory usage stays bounded.
// ---------------------------------------------------------------------------

interface RateLimitEntry {
  count: number;
  windowStart: number;
}

/**
 * Build an Express middleware that limits each IP to `max` requests within
 * a rolling `windowMs` millisecond window.
 *
 * When the limit is exceeded the middleware responds with HTTP 429 and a
 * JSON body that includes a `Retry-After` header (seconds until the window
 * resets) so well-behaved clients can back off automatically.
 */
function createRateLimiter(options: {
  windowMs: number;
  max: number;
  message?: string;
}) {
  const { windowMs, max, message = "Too many requests, please try again later." } = options;
  const store = new Map<string, RateLimitEntry>();

  return function rateLimitMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    const ip =
      (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0].trim() ??
      req.socket.remoteAddress ??
      "unknown";

    const now = Date.now();

    // Prune stale entries to keep the store from growing unboundedly.
    for (const [key, entry] of store.entries()) {
      if (now - entry.windowStart > windowMs) {
        store.delete(key);
      }
    }

    const entry = store.get(ip);

    if (!entry || now - entry.windowStart > windowMs) {
      // First request in this window (or window has expired).
      store.set(ip, { count: 1, windowStart: now });
      res.setHeader("X-RateLimit-Limit", max);
      res.setHeader("X-RateLimit-Remaining", max - 1);
      res.setHeader("X-RateLimit-Reset", Math.ceil((now + windowMs) / 1000));
      next();
      return;
    }

    entry.count += 1;
    const remaining = Math.max(0, max - entry.count);
    const resetAt = Math.ceil((entry.windowStart + windowMs) / 1000);

    res.setHeader("X-RateLimit-Limit", max);
    res.setHeader("X-RateLimit-Remaining", remaining);
    res.setHeader("X-RateLimit-Reset", resetAt);

    if (entry.count > max) {
      const retryAfter = Math.ceil((entry.windowStart + windowMs - now) / 1000);
      res.setHeader("Retry-After", retryAfter);
      res.status(429).json({ error: message });
      return;
    }

    next();
  };
}

/** General-purpose limiter: 100 requests per 15-minute window per IP. */
const generalLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
});

/**
 * Stricter limiter for expensive / enumeration-prone endpoints.
 *
 * Applied to:
 *   - GET /delegates  (N+1 query risk)
 *   - GET /profile/:address  (enumeration attack surface)
 *
 * Allows 30 requests per 15-minute window per IP.
 */
const strictLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: "Too many requests to this endpoint, please slow down.",
});

const TTL = {
  proposals: 30_000, // 30 seconds
  proposalVotes: 15_000, // 15 seconds
  delegates: 60_000, // 60 seconds
  profile: 30_000, // 30 seconds
  stats: 60_000, // 60 seconds
  delegationRegistry: 30_000, // 30 seconds
  delegationSig: 30_000, // 30 seconds
  analytics: 30_000, // 30 seconds
  reputation: 30_000, // 30 seconds
  treasury: 30_000, // 30 seconds
  proposalBonds: 30_000, // 30 seconds
  factory: 60_000, // 60 seconds
};

function parsePagination(
  limitValue: unknown,
  offsetValue: unknown,
  defaultLimit: number,
  maxLimit: number,
): { limit: number; offset: number } | null {
  const limit = Number(limitValue ?? defaultLimit);
  const offset = Number(offsetValue ?? 0);
  if (
    !Number.isInteger(limit) ||
    !Number.isInteger(offset) ||
    limit < 1 ||
    limit > maxLimit ||
    offset < 0
  ) {
    return null;
  }
  return { limit, offset };
}

const HEALTH_LAG_THRESHOLD = Number(process.env.HEALTH_LAG_THRESHOLD ?? 100);
const STELLAR_LEDGER_CLOSE_TIME_SECONDS = 5; // Stellar ledgers close approximately every 5 seconds

interface HealthResponse {
  status: "ok" | "degraded";
  last_indexed_ledger: number;
  current_ledger: number;
  lag_ledgers: number;
  lag_seconds: number;
  total_proposals_indexed: number;
  total_votes_indexed: number;
  total_delegates_indexed: number;
  uptime_seconds: number;
  timestamp: string;
  subscribed_contracts: string[];
}

async function getHealthStatus(server: SorobanRpc.Server): Promise<HealthResponse> {
  // Fetch current ledger from RPC
  const latestLedger = await server.getLatestLedger();
  const currentLedger = latestLedger.sequence;

  // Get last indexed ledger from database
  const lastIndexedLedger = await getLastIndexedLedger();

  // Calculate lag
  const lagLedgers = Math.max(0, currentLedger - lastIndexedLedger);
  const lagSeconds = lagLedgers * STELLAR_LEDGER_CLOSE_TIME_SECONDS;

  // Get counts from database
  const [proposalsResult, votesResult, delegatesResult] = await Promise.all([
    pool.query("SELECT COUNT(*) as count FROM proposals"),
    pool.query("SELECT COUNT(*) as count FROM votes"),
    pool.query("SELECT COUNT(DISTINCT delegator) as count FROM delegates"),
  ]);

  const totalProposals = Number(proposalsResult.rows[0]?.count ?? 0);
  const totalVotes = Number(votesResult.rows[0]?.count ?? 0);
  const totalDelegates = Number(delegatesResult.rows[0]?.count ?? 0);

  // Calculate uptime
  const uptimeSeconds = Math.floor((Date.now() - startTime) / 1000);

  // Determine status
  const status = lagLedgers > HEALTH_LAG_THRESHOLD ? "degraded" : "ok";

  return {
    status,
    last_indexed_ledger: lastIndexedLedger,
    current_ledger: currentLedger,
    lag_ledgers: lagLedgers,
    lag_seconds: lagSeconds,
    total_proposals_indexed: totalProposals,
    total_votes_indexed: totalVotes,
    total_delegates_indexed: totalDelegates,
    uptime_seconds: uptimeSeconds,
    timestamp: new Date().toISOString(),
    subscribed_contracts: Object.entries(INDEXED_CONTRACTS)
      .filter(([, address]) => Boolean(address))
      .map(([name]) => name),
  };
}

interface StatsResponse {
  total_proposals: number;
  active_proposals: number;
  total_votes_cast: number;
  unique_voters: number;
  total_delegates: number;
  participation_rate: number;
  last_updated: string;
}

async function getStatsStatus(server: SorobanRpc.Server): Promise<StatsResponse> {
  const latestLedger = await server.getLatestLedger();
  const currentLedger = latestLedger.sequence;

  const [
    totalProposalsRes,
    activeProposalsRes,
    totalVotesRes,
    uniqueVotersRes,
    totalDelegatesRes,
    executedProposalsRes,
  ] = await Promise.all([
    pool.query("SELECT COUNT(*)::int AS count FROM proposals"),
    pool.query(
      `SELECT COUNT(*)::int AS count FROM proposals
       WHERE start_ledger <= $1 AND end_ledger >= $1 AND executed = false AND cancelled = false`,
      [currentLedger],
    ),
    pool.query("SELECT COUNT(*)::int AS count FROM votes"),
    pool.query("SELECT COUNT(DISTINCT voter)::int AS count FROM votes"),
    pool.query("SELECT COUNT(DISTINCT delegator)::int AS count FROM delegates"),
    pool.query(
      `SELECT
         COALESCE(SUM(votes_for + votes_against + votes_abstain), 0)::float8 AS total,
         COUNT(*)::int AS count
       FROM proposals WHERE executed = true`,
    ),
  ]);

  const totalProposals = Number(totalProposalsRes.rows[0]?.count ?? 0);
  const activeProposals = Number(activeProposalsRes.rows[0]?.count ?? 0);
  const totalVotes = Number(totalVotesRes.rows[0]?.count ?? 0);
  const uniqueVoters = Number(uniqueVotersRes.rows[0]?.count ?? 0);
  const totalDelegates = Number(totalDelegatesRes.rows[0]?.count ?? 0);
  const executedProposals = executedProposalsRes.rows[0];

  const totalVotesOnExecuted = Number(executedProposals?.total ?? 0);
  const executedCount = Number(executedProposals?.count ?? 0);

  const participationRate =
    executedCount > 0 ? totalVotesOnExecuted / executedCount : 0;

  return {
    total_proposals: totalProposals,
    active_proposals: activeProposals,
    total_votes_cast: totalVotes,
    unique_voters: uniqueVoters,
    total_delegates: totalDelegates,
    participation_rate: Math.round(participationRate * 100) / 100,
    last_updated: new Date().toISOString(),
  };
}

export function createApp(server: SorobanRpc.Server): express.Application {
  const app = express();
  app.use(express.json());

  // Apply general rate limiting to all routes (issue #437).
  // Health and docs endpoints are intentionally included so that monitoring
  // probes cannot be weaponised to exhaust the database connection pool.
  app.use(generalLimiter);

  // Swagger documentation
  app.get("/openapi.json", (_req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.send(generateOpenApiDocument(app));
  });
  app.use("/docs", swaggerUi.serve, swaggerUi.setup(generateOpenApiDocument()));

  // GET /health
  app.get("/health", async (_req: Request, res: Response): Promise<void> => {
    try {
      const health = await getHealthStatus(server);
      const httpStatus = health.status === "ok" ? 200 : 503;
      res.status(httpStatus).json(health);
    } catch (error) {
      console.error("Health check error:", error);
      res.status(503).json({
        status: "degraded",
        error: "Failed to retrieve health status",
        timestamp: new Date().toISOString(),
      });
    }
  });

  // GET /stats
  app.get("/stats", async (_req: Request, res: Response): Promise<void> => {
    const key = "stats";
    try {
      const data = await cached(key, TTL.stats, async () => getStatsStatus(server));
      res.json(data);
    } catch (error) {
      console.error("Stats error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/vote-escrow/locks", async (req: Request, res: Response): Promise<void> => {
    const pagination = parsePagination(req.query.limit, req.query.offset, 20, 100);
    if (!pagination) { res.status(400).json({ error: "Invalid pagination parameters" }); return; }
    const { limit, offset } = pagination;
    const withdrawn = req.query.withdrawn === undefined ? undefined : String(req.query.withdrawn) === "true";
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (withdrawn !== undefined) { params.push(withdrawn); conditions.push(`withdrawn = $${params.length}`); }
    params.push(limit, offset);
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    try {
      const result = await pool.query(
        `SELECT owner_address, amount, start_ledger, end_ledger, initial_voting_power, withdrawn, updated_ledger
         FROM vote_escrow_locks ${where} ORDER BY amount DESC OFFSET $${params.length - 1} LIMIT $${params.length}`,
        [params[0], offset, limit].filter((value) => value !== undefined),
      );
      res.json({ locks: result.rows, pagination: { limit, offset, hasMore: result.rows.length === limit } });
    } catch { res.status(500).json({ error: "Internal server error" }); }
  });

  app.get("/vote-escrow/locks/:address", async (req: Request, res: Response): Promise<void> => {
    try {
      const result = await pool.query("SELECT * FROM vote_escrow_locks WHERE owner_address = $1", [req.params.address]);
      if (!result.rows[0]) { res.status(404).json({ error: "Lock not found" }); return; }
      res.json(result.rows[0]);
    } catch { res.status(500).json({ error: "Internal server error" }); }
  });

  app.get("/vote-escrow/stats", async (_req: Request, res: Response): Promise<void> => {
    try {
      const result = await pool.query(`SELECT COALESCE(SUM(amount) FILTER (WHERE withdrawn = false), 0) AS total_locked,
        COUNT(*) FILTER (WHERE withdrawn = false)::int AS active_lock_count FROM vote_escrow_locks`);
      res.json(result.rows[0] ?? { total_locked: "0", active_lock_count: 0 });
    } catch { res.status(500).json({ error: "Internal server error" }); }
  });

  // GET /analytics/summary
  app.get(
    "/analytics/summary",
    async (_req: Request, res: Response): Promise<void> => {
      const key = "analytics:summary";
      try {
        const data = await cached(key, TTL.proposals, async () => {
          const [
            totalProposalsRes,
            uniqueVotersRes,
            avgVotesRes,
            mostActiveProposersRes,
            outcomesRes,
            stateRes,
          ] = await Promise.all([
            pool.query("SELECT COUNT(*)::int AS total FROM proposals"),
            pool.query("SELECT COUNT(DISTINCT voter)::int AS total FROM votes"),
            pool.query(
              "SELECT COALESCE(AVG(votes_for + votes_against + votes_abstain), 0)::float AS avg FROM proposals",
            ),
            pool.query(
              `SELECT proposer, COUNT(*)::int AS count
               FROM proposals
               GROUP BY proposer
               ORDER BY count DESC
               LIMIT 5`,
            ),
            pool.query(
              `SELECT
                SUM(CASE WHEN executed THEN 1 ELSE 0 END)::int AS executed,
                SUM(CASE WHEN cancelled THEN 1 ELSE 0 END)::int AS cancelled,
                SUM(CASE WHEN queued THEN 1 ELSE 0 END)::int AS queued
               FROM proposals`,
            ),
            pool.query("SELECT last_ledger::int AS last_ledger FROM indexer_state WHERE id = 1"),
          ]);

          return {
            totalProposals: totalProposalsRes.rows[0]?.total ?? 0,
            totalUniqueVoters: uniqueVotersRes.rows[0]?.total ?? 0,
            averageVotesPerProposal: avgVotesRes.rows[0]?.avg ?? 0,
            mostActiveProposers: mostActiveProposersRes.rows ?? [],
            outcomes: outcomesRes.rows[0] ?? { executed: 0, cancelled: 0, queued: 0 },
            lastIndexedLedger: stateRes.rows[0]?.last_ledger ?? 0,
          };
        });
        res.json(data);
      } catch {
        res.status(500).json({ error: "Internal server error" });
      }
    },
  );

  // GET /factory/governors?deployer=G...&limit=20&offset=0
  app.get(
    "/factory/governors",
    async (req: Request, res: Response): Promise<void> => {
      const pagination = parsePagination(
        req.query.limit,
        req.query.offset,
        20,
        100,
      );
      if (!pagination) {
        res.status(400).json({ error: "Invalid pagination parameters" });
        return;
      }
      const { limit, offset } = pagination;
      const deployer =
        typeof req.query.deployer === "string" && req.query.deployer.length > 0
          ? req.query.deployer
          : undefined;
      const key = `factory:governors:${deployer ?? "all"}:${limit}:${offset}`;
      try {
        const data = await cached(key, TTL.factory, async () => {
          const params: unknown[] = [];
          let where = "";
          if (deployer) {
            params.push(deployer);
            where = `WHERE deployer = $${params.length}`;
          }
          params.push(limit, offset);
          const result = await pool.query(
            `SELECT * FROM factory_governors
             ${where}
             ORDER BY governor_id ASC
             LIMIT $${params.length - 1} OFFSET $${params.length}`,
            params,
          );
          return {
            data: result.rows,
            pagination: {
              limit,
              offset,
              hasMore: result.rows.length === limit,
            },
          };
        });
        res.json(data);
      } catch {
        res.status(500).json({ error: "Internal server error" });
      }
    },
  );

  // GET /proposals?offset=0&limit=20
  //       or ?before=47&limit=20
  //       or ?after=10&limit=20
  //       or ?state=Active&current_ledger=5000
  //       or ?proposer=G...
  //       or ?page=2&limit=20
  app.get("/proposals", async (req: Request, res: Response): Promise<void> => {
    const limit = Math.min(Number(req.query.limit ?? 20), 100);
    const before = req.query.before ? Number(req.query.before) : undefined;
    const after = req.query.after ? Number(req.query.after) : undefined;
    const offset = Number(req.query.offset ?? 0);
    const state = req.query.state ? String(req.query.state).trim() : undefined;
    const proposer = req.query.proposer ? String(req.query.proposer).trim() : undefined;
    const currentLedger = req.query.current_ledger ? Number(req.query.current_ledger) : undefined;
    const page = req.query.page ? Math.max(1, Number(req.query.page)) : undefined;

    try {
      const conditions: string[] = [];
      const params: any[] = [];
      let paramIndex = 1;

      // Build WHERE clauses from filters
      if (proposer) {
        conditions.push(`proposer = $${paramIndex++}`);
        params.push(proposer);
      }

      if (state) {
        switch (state) {
          case "Active":
            if (currentLedger) {
              conditions.push(`start_ledger <= $${paramIndex}`);
              params.push(currentLedger);
              paramIndex++;
              conditions.push(`end_ledger > $${paramIndex}`);
              params.push(currentLedger);
              paramIndex++;
              conditions.push(`executed = false AND cancelled = false`);
            }
            break;
          case "Pending":
            if (currentLedger) {
              conditions.push(`start_ledger > $${paramIndex}`);
              params.push(currentLedger);
              paramIndex++;
              conditions.push(`executed = false AND cancelled = false`);
            }
            break;
          case "Succeeded":
            if (currentLedger) {
              conditions.push(`end_ledger <= $${paramIndex}`);
              params.push(currentLedger);
              paramIndex++;
              conditions.push(`executed = false AND cancelled = false AND queued = false`);
              conditions.push(`votes_for > votes_against`);
            }
            break;
          case "Defeated":
            if (currentLedger) {
              conditions.push(`end_ledger <= $${paramIndex}`);
              params.push(currentLedger);
              paramIndex++;
              conditions.push(`executed = false AND cancelled = false AND queued = false`);
              conditions.push(`votes_for <= votes_against`);
            }
            break;
          case "Queued":
            conditions.push(`queued = true AND executed = false`);
            break;
          case "Executed":
            conditions.push(`executed = true`);
            break;
          case "Cancelled":
            conditions.push(`cancelled = true`);
            break;
        }
      }

      let query: string;
      let key: string;

      if (page !== undefined) {
        // Page-based pagination
        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
        query = `SELECT * FROM proposals ${whereClause} ORDER BY id DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
        params.push(limit, (page - 1) * limit);
        key = `proposals:page:${page}:${limit}:${state ?? ""}:${proposer ?? ""}:${currentLedger ?? ""}`;
      } else if (before !== undefined || after !== undefined) {
        // Cursor-based pagination
        if (before !== undefined) {
          conditions.push(`id < $${paramIndex++}`);
          params.push(before);
          query = `SELECT * FROM proposals ${conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""} ORDER BY id DESC LIMIT $${paramIndex}`;
          params.push(limit);
          key = `proposals:before:${before}:${limit}:${state ?? ""}:${proposer ?? ""}:${currentLedger ?? ""}`;
        } else {
          conditions.push(`id > $${paramIndex++}`);
          params.push(after);
          query = `SELECT * FROM proposals ${conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""} ORDER BY id ASC LIMIT $${paramIndex}`;
          params.push(limit);
          key = `proposals:after:${after}:${limit}:${state ?? ""}:${proposer ?? ""}:${currentLedger ?? ""}`;
        }
      } else {
        // Fall back to offset-based pagination for backwards compatibility
        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
        query = `SELECT * FROM proposals ${whereClause} ORDER BY id DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
        params.push(limit, offset);
        key = `proposals:${offset}:${limit}:${state ?? ""}:${proposer ?? ""}:${currentLedger ?? ""}`;
      }

      const data = await cached(key, TTL.proposals, async () => {
        const result = await pool.query(query, params);
        const proposals = result.rows;

        // For cursor pagination, calculate next/prev cursors and hasMore
        if (before !== undefined || after !== undefined) {
          let nextCursor: number | undefined;
          let prevCursor: number | undefined;
          let hasMore = false;

          if (proposals.length > 0) {
            if (before !== undefined) {
              // For "before" queries, next cursor is the smallest ID in results
              nextCursor = Math.min(...proposals.map(p => p.id));
              prevCursor = Math.max(...proposals.map(p => p.id));
              
              // Check if there are more proposals with smaller IDs
              const hasMoreResult = await pool.query(
                "SELECT 1 FROM proposals WHERE id < $1 LIMIT 1",
                [nextCursor]
              );
              hasMore = hasMoreResult.rows.length > 0;
            } else {
              // For "after" queries, reverse the order to match DESC ordering
              proposals.reverse();
              nextCursor = Math.min(...proposals.map(p => p.id));
              prevCursor = Math.max(...proposals.map(p => p.id));
              
              // Check if there are more proposals with larger IDs
              const hasMoreResult = await pool.query(
                "SELECT 1 FROM proposals WHERE id > $1 LIMIT 1",
                [prevCursor]
              );
              hasMore = hasMoreResult.rows.length > 0;
            }
          }

          return { 
            proposals, 
            nextCursor, 
            prevCursor, 
            hasMore 
          };
        } else {
          // For offset pagination, return legacy format
          return { proposals, total: result.rowCount ?? 0 };
        }
      });

      res.json(data);
    } catch {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /proposals/:id
  app.get("/proposals/:id", async (req: Request, res: Response): Promise<void> => {
    const id = parseInt(req.params.id);
    
    // Validate ID is a valid integer
    if (isNaN(id) || id < 1) {
      res.status(400).json({ error: "Invalid proposal ID" });
      return;
    }

    try {
      const result = await pool.query('SELECT * FROM proposals WHERE id = $1', [id]);
      if (!result.rows[0]) {
        res.status(404).json({ error: 'Proposal not found' });
        return;
      }
      res.json(result.rows[0]);
    } catch {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /proposals/by-description-hash/:hash — used by proposal-bonds
  // refund flow to resolve the proposal_id a bond correlates with, since
  // the bonds contract's refund_bond requires it (governor has no
  // description_hash → id lookup on-chain, see contracts/proposal-bonds).
  app.get(
    "/proposals/by-description-hash/:hash",
    async (req: Request, res: Response): Promise<void> => {
      const { hash } = req.params;
      try {
        const result = await pool.query(
          `SELECT * FROM proposals WHERE description_hash = $1`,
          [hash],
        );
        if (!result.rows[0]) {
          res.status(404).json({ error: "Proposal not found" });
          return;
        }
        res.json(result.rows[0]);
      } catch {
        res.status(500).json({ error: "Internal server error" });
      }
    },
  );

  // GET /proposals/:id/votes
  app.get(
    "/proposals/:id/votes",
    async (req: Request, res: Response): Promise<void> => {
      const { id } = req.params;
      const key = `proposal_votes:${id}`;
      try {
        const data = await cached(key, TTL.proposalVotes, async () => {
          const result = await pool.query(
            "SELECT * FROM votes WHERE proposal_id = $1 ORDER BY created_at DESC",
            [id],
          );
          return { votes: result.rows };
        });
        res.json(data);
      } catch {
        res.status(500).json({ error: "Internal server error" });
      }
    },
  );

  // GET /delegates?top=20
  app.get("/delegates", strictLimiter, async (req: Request, res: Response): Promise<void> => {
    const top = Math.min(Number(req.query.top ?? 20), 100);
    const key = `delegates:${top}`;
    try {
      const data = await cached(key, TTL.delegates, async () => {
        const result = await pool.query(
          `SELECT new_delegatee as address, COUNT(*) as delegator_count
           FROM delegates d1
           WHERE ledger = (
             SELECT MAX(d2.ledger) FROM delegates d2 WHERE d2.delegator = d1.delegator
           )
           GROUP BY new_delegatee
           ORDER BY delegator_count DESC
           LIMIT $1`,
          [top],
        );
        return { delegates: result.rows };
      });
      res.json(data);
    } catch {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /profile/:address
  app.get(
    "/profile/:address",
    strictLimiter,
    async (req: Request, res: Response): Promise<void> => {
      const { address } = req.params;
      const key = `profile:${address}`;
      try {
        const data = await cached(key, TTL.profile, async () => {
          const [
            proposalsRes,
            votesRes,
            delegationsRes,
            wrapperDepositsRes,
            wrapperWithdrawalsRes,
          ] = await Promise.all([
            pool.query("SELECT COUNT(*) FROM proposals WHERE proposer = $1", [
              address,
            ]),
            pool.query(
              "SELECT COUNT(*), SUM(weight) FROM votes WHERE voter = $1",
              [address],
            ),
            pool.query(
              "SELECT new_delegatee FROM delegates WHERE delegator = $1 ORDER BY ledger DESC LIMIT 1",
              [address],
            ),
            pool.query(
              "SELECT COALESCE(SUM(amount), 0) AS sum FROM wrapper_deposits WHERE account = $1",
              [address],
            ),
            pool.query(
              "SELECT COALESCE(SUM(amount), 0) AS sum FROM wrapper_withdrawals WHERE account = $1",
              [address],
            ),
          ]);

          const depositTotal = BigInt(wrapperDepositsRes.rows[0]?.sum ?? 0);
          const withdrawalTotal = BigInt(
            wrapperWithdrawalsRes.rows[0]?.sum ?? 0,
          );
          const wrappedBalance = depositTotal - withdrawalTotal;

          return {
            address,
            proposalsCreated: Number(proposalsRes.rows[0].count),
            votescast: Number(votesRes.rows[0].count),
            totalVotingPowerUsed: String(votesRes.rows[0].sum ?? 0),
            currentDelegatee: delegationsRes.rows[0]?.new_delegatee ?? address,
            wrapper: {
              depositTotal: depositTotal.toString(),
              withdrawalTotal: withdrawalTotal.toString(),
              wrappedBalance: wrappedBalance.toString(),
            },
          };
        });
        res.json(data);
      } catch {
        res.status(500).json({ error: "Internal server error" });
      }
    },
  );

  // --- Delegation registry endpoints (issue #769) ---
  //
  // Backed by the `delegation_entries` table populated from the token-votes
  // contract's DelegationRegistered/DelegationRevoked events. This is a
  // registry-level view distinct from the governor's own `delegates` table
  // used by GET /delegates and GET /profile/:address above.

  // GET /delegates/:address/profile
  app.get(
    "/delegates/:address/profile",
    strictLimiter,
    async (req: Request, res: Response): Promise<void> => {
      const { address } = req.params;
      const key = `delegate_profile:${address}`;
      try {
        const data = await cached(key, TTL.delegationRegistry, async () => {
          const result = await pool.query(
            `SELECT
               COUNT(*)::int AS total_delegators,
               COALESCE(SUM(power_at_delegation), 0) AS total_delegated_power,
               MIN(delegated_at_ledger) AS first_delegated_at_ledger
             FROM delegation_entries
             WHERE delegatee_address = $1 AND active = TRUE`,
            [address],
          );
          const row = result.rows[0];
          return {
            address,
            total_delegators: row?.total_delegators ?? 0,
            total_delegated_power: String(row?.total_delegated_power ?? 0),
            first_delegated_at_ledger: row?.first_delegated_at_ledger ?? null,
          };
        });
        res.json(data);
      } catch {
        res.status(500).json({ error: "Internal server error" });
      }
    },
  );

  // GET /delegates/:address/delegators?offset=0&limit=50
  app.get(
    "/delegates/:address/delegators",
    strictLimiter,
    async (req: Request, res: Response): Promise<void> => {
      const { address } = req.params;
      const offset = Math.max(Number(req.query.offset ?? 0), 0);
      const limit = Math.min(Math.max(Number(req.query.limit ?? 50), 1), 200);
      try {
        const result = await pool.query(
          `SELECT delegator_address, power_at_delegation, delegated_at_ledger, chain_depth
           FROM delegation_entries
           WHERE delegatee_address = $1 AND active = TRUE
           ORDER BY delegated_at_ledger ASC
           OFFSET $2 LIMIT $3`,
          [address, offset, limit],
        );
        res.json({ delegators: result.rows });
      } catch {
        res.status(500).json({ error: "Internal server error" });
      }
    },
  );

  // GET /delegates/:address/history?offset=0&limit=50 — full history of
  // delegations received, including revoked entries.
  app.get(
    "/delegates/:address/history",
    strictLimiter,
    async (req: Request, res: Response): Promise<void> => {
      const { address } = req.params;
      const offset = Math.max(Number(req.query.offset ?? 0), 0);
      const limit = Math.min(Math.max(Number(req.query.limit ?? 50), 1), 200);
      try {
        const result = await pool.query(
          `SELECT delegator_address, delegated_at_ledger, revoked_at_ledger, power_at_delegation, active
           FROM delegation_entries
           WHERE delegatee_address = $1
           ORDER BY delegated_at_ledger ASC
           OFFSET $2 LIMIT $3`,
          [address, offset, limit],
        );
        res.json({
          history: result.rows,
          pagination: { limit, offset, hasMore: result.rows.length === limit },
        });
      } catch {
        res.status(500).json({ error: "Internal server error" });
      }
    },
  );

  // GET /delegates/:address/chain — resolve the delegation chain starting at
  // `address` by following active delegation_entries edges to the tip.
  app.get(
    "/delegates/:address/chain",
    strictLimiter,
    async (req: Request, res: Response): Promise<void> => {
      const { address } = req.params;
      const MAX_HOPS = 64;
      try {
        const chain: string[] = [address];
        const visited = new Set([address]);
        let current = address;
        for (let i = 0; i < MAX_HOPS; i++) {
          const result = await pool.query(
            `SELECT delegatee_address FROM delegation_entries
             WHERE delegator_address = $1 AND active = TRUE
             LIMIT 1`,
            [current],
          );
          const next = result.rows[0]?.delegatee_address as string | undefined;
          if (!next || visited.has(next)) break;
          chain.push(next);
          visited.add(next);
          current = next;
        }
        res.json({ chain });
      } catch {
        res.status(500).json({ error: "Internal server error" });
      }
    },
  );

  // GET /delegators/:address/history?offset=0&limit=50 — history of
  // delegations made by this address as a delegator.
  app.get(
    "/delegators/:address/history",
    strictLimiter,
    async (req: Request, res: Response): Promise<void> => {
      const { address } = req.params;
      const offset = Math.max(Number(req.query.offset ?? 0), 0);
      const limit = Math.min(Math.max(Number(req.query.limit ?? 50), 1), 200);
      try {
        const result = await pool.query(
          `SELECT delegatee_address, delegated_at_ledger, revoked_at_ledger, power_at_delegation, active
           FROM delegation_entries
           WHERE delegator_address = $1
           ORDER BY delegated_at_ledger ASC
           OFFSET $2 LIMIT $3`,
          [address, offset, limit],
        );
        res.json({
          history: result.rows,
          pagination: { limit, offset, hasMore: result.rows.length === limit },
        });
      } catch {
        res.status(500).json({ error: "Internal server error" });
      }
    },
  );

  // --- Split delegation endpoints (issue #994) ---

  // GET /delegates/:address/split-delegations — the delegatee's inbound
  // split delegations, with per-delegator weight_bps.
  app.get(
    "/delegates/:address/split-delegations",
    strictLimiter,
    async (req: Request, res: Response): Promise<void> => {
      const { address } = req.params;
      const offset = Math.max(Number(req.query.offset ?? 0), 0);
      const limit = Math.min(Math.max(Number(req.query.limit ?? 50), 1), 200);
      const key = `split-delegations:delegatee:${address}:${offset}:${limit}`;
      try {
        const data = await cached(key, TTL.delegationRegistry, async () => {
          const result = await pool.query(
            `SELECT delegator_address, weight_bps, delegated_power, created_at
             FROM split_delegations
             WHERE delegatee_address = $1 AND active = TRUE
             ORDER BY created_at ASC
             OFFSET $2 LIMIT $3`,
            [address, offset, limit],
          );
          return {
            splitDelegations: result.rows,
            pagination: { limit, offset, hasMore: result.rows.length === limit },
          };
        });
        res.json(data);
      } catch {
        res.status(500).json({ error: "Internal server error" });
      }
    },
  );

  // GET /delegators/:address/split-delegations — the delegator's outbound splits.
  app.get(
    "/delegators/:address/split-delegations",
    strictLimiter,
    async (req: Request, res: Response): Promise<void> => {
      const { address } = req.params;
      const key = `split-delegations:delegator:${address}`;
      try {
        const data = await cached(key, TTL.delegationRegistry, async () => {
          const result = await pool.query(
            `SELECT delegatee_address, weight_bps, delegated_power, created_at
             FROM split_delegations
             WHERE delegator_address = $1 AND active = TRUE
             ORDER BY weight_bps DESC`,
            [address],
          );
          return { splitDelegations: result.rows };
        });
        res.json(data);
      } catch {
        res.status(500).json({ error: "Internal server error" });
      }
    },
  );

  // GET /delegation-graph?top=100 — top delegatees by active delegator count.
  app.get(
    "/delegation-graph",
    strictLimiter,
    async (req: Request, res: Response): Promise<void> => {
      const top = Math.min(Math.max(Number(req.query.top ?? 100), 1), 500);
      const key = `delegation_graph:${top}`;
      try {
        const data = await cached(key, TTL.delegationRegistry, async () => {
          const result = await pool.query(
            `SELECT
               delegatee_address AS address,
               COUNT(*)::int AS delegator_count,
               COALESCE(SUM(power_at_delegation), 0) AS total_delegated_power
             FROM delegation_entries
             WHERE active = TRUE
             GROUP BY delegatee_address
             ORDER BY delegator_count DESC
             LIMIT $1`,
            [top],
          );
          return {
            nodes: result.rows.map((r) => ({
              address: r.address,
              delegator_count: r.delegator_count,
              total_delegated_power: String(r.total_delegated_power),
            })),
          };
        });
        res.json(data);
      } catch {
        res.status(500).json({ error: "Internal server error" });
      }
    },
  );

  // --- Signed ("gasless") delegation / relayer endpoints (issue #910) ---
  //
  // Backed by `delegated_by_sig_events` and `relayer_whitelist_history`,
  // populated from the token-votes contract's DelegatedBySig and
  // RelayerWhitelistUpdated events (delegate_by_sig / delegate_batch_by_sig
  // and set_relayer_whitelisted). Distinct from the delegation-registry
  // endpoints above, which track single-hop delegation ownership rather than
  // who relayed a signed permit.

  // GET /relayers?whitelisted=true|false — current whitelist status per
  // relayer, derived from the latest row per relayer_address.
  app.get(
    "/relayers",
    strictLimiter,
    async (req: Request, res: Response): Promise<void> => {
      const whitelistedFilter =
        req.query.whitelisted === "true"
          ? true
          : req.query.whitelisted === "false"
          ? false
          : undefined;
      const key = `relayers:${whitelistedFilter ?? "all"}`;
      try {
        const data = await cached(key, TTL.delegationSig, async () => {
          const result = await pool.query(
            `SELECT relayer_address, whitelisted, ledger
             FROM relayer_whitelist_history r1
             WHERE ledger = (
               SELECT MAX(r2.ledger) FROM relayer_whitelist_history r2
               WHERE r2.relayer_address = r1.relayer_address
             )
             ORDER BY relayer_address ASC`,
          );
          const relayers =
            whitelistedFilter === undefined
              ? result.rows
              : result.rows.filter(
                  (r: { whitelisted: boolean }) => r.whitelisted === whitelistedFilter,
                );
          return { relayers };
        });
        res.json(data);
      } catch {
        res.status(500).json({ error: "Internal server error" });
      }
    },
  );

  // GET /delegations/by-sig?relayer=...&offset=0&limit=50 — signed
  // delegations applied via delegate_by_sig / delegate_batch_by_sig,
  // optionally filtered to a single relayer.
  app.get(
    "/delegations/by-sig",
    strictLimiter,
    async (req: Request, res: Response): Promise<void> => {
      const pagination = parsePagination(req.query.limit, req.query.offset, 50, 200);
      if (!pagination) {
        res.status(400).json({ error: "Invalid pagination parameters" });
        return;
      }
      const { limit, offset } = pagination;
      const relayer =
        typeof req.query.relayer === "string" && req.query.relayer.length > 0
          ? req.query.relayer
          : undefined;
      const key = `delegations_by_sig:${relayer ?? "all"}:${limit}:${offset}`;
      try {
        const data = await cached(key, TTL.delegationSig, async () => {
          const params: unknown[] = [];
          let where = "";
          if (relayer) {
            params.push(relayer);
            where = `WHERE relayer_address = $${params.length}`;
          }
          params.push(limit, offset);
          const result = await pool.query(
            `SELECT delegator_address, delegatee_address, relayer_address, nonce, ledger, created_at
             FROM delegated_by_sig_events
             ${where}
             ORDER BY ledger DESC
             LIMIT $${params.length - 1} OFFSET $${params.length}`,
            params,
          );
          return {
            data: result.rows,
            pagination: { limit, offset, hasMore: result.rows.length === limit },
          };
        });
        res.json(data);
      } catch {
        res.status(500).json({ error: "Internal server error" });
      }
    },
  );

  // --- Governance analytics endpoints (issue #765) ---
  //
  // Entirely indexer-side — there's no on-chain analytics module (no room
  // in the governor's WASM budget alongside proposer reputation). `/analytics/
  // snapshots*` are backed by `governance_snapshots`, a votes-cast-over-time
  // series computed periodically from the indexer's own `votes` table (see
  // `maybeTakeGovernanceSnapshot` in events.ts). `/analytics/all-time-stats`,
  // `/analytics/proposals/:id/participation`, `/analytics/voters/:address/history`,
  // and `/analytics/top-voters` are all derived live from the existing
  // `proposals`/`votes` tables, since those are already event-sourced and
  // give an always-current answer.

  // GET /analytics/snapshots?limit=30&offset=0
  // GET /analytics/snapshots?ledger=12345 — single snapshot by ledger.
  app.get(
    "/analytics/snapshots",
    async (req: Request, res: Response): Promise<void> => {
      const limit = Math.min(Math.max(Number(req.query.limit ?? 30), 1), 200);
      const offset = Math.max(Number(req.query.offset ?? 0), 0);
      const ledger = req.query.ledger !== undefined ? Number(req.query.ledger) : undefined;
      const key = ledger !== undefined
        ? `analytics:snapshots:ledger:${ledger}`
        : `analytics:snapshots:${limit}:${offset}`;
      try {
        const data = await cached(key, TTL.analytics, async () => {
          if (ledger !== undefined) {
            const result = await pool.query(
              `SELECT * FROM governance_snapshots WHERE ledger = $1`,
              [ledger],
            );
            return { data: result.rows };
          }
          const result = await pool.query(
            `SELECT * FROM governance_snapshots ORDER BY ledger DESC LIMIT $1 OFFSET $2`,
            [limit, offset],
          );
          return {
            data: result.rows,
            pagination: { limit, offset, hasMore: result.rows.length === limit },
          };
        });
        res.json(data);
      } catch {
        res.status(500).json({ error: "Internal server error" });
      }
    },
  );

  // GET /analytics/snapshots/latest
  app.get(
    "/analytics/snapshots/latest",
    async (_req: Request, res: Response): Promise<void> => {
      try {
        const data = await cached("analytics:snapshots:latest", TTL.analytics, async () => {
          const result = await pool.query(
            `SELECT * FROM governance_snapshots ORDER BY ledger DESC LIMIT 1`,
          );
          return result.rows[0] ?? null;
        });
        res.json(data);
      } catch {
        res.status(500).json({ error: "Internal server error" });
      }
    },
  );

  // GET /analytics/all-time-stats — live from proposals/votes.
  //
  // `quorum_hit_count`/`quorum_miss_count`/`pass_rate_bps` are always 0:
  // determining them requires the eligible supply (and, for dynamic
  // quorum, a live oracle price) at each proposal's start ledger, which
  // the indexer doesn't track and no on-chain function exposes anymore
  // (cut for WASM-size budget — see git history for
  // contracts/governor/src/analytics.rs).
  app.get(
    "/analytics/all-time-stats",
    async (_req: Request, res: Response): Promise<void> => {
      try {
        const data = await cached("analytics:all-time-stats", TTL.analytics, async () => {
          const [proposalsResult, votesResult] = await Promise.all([
            pool.query(`SELECT COUNT(*)::int AS count FROM proposals`),
            pool.query(
              `SELECT COALESCE(SUM(weight), 0) AS total_weight_cast,
                      COUNT(DISTINCT voter)::int AS unique_voters
               FROM votes`,
            ),
          ]);
          return {
            total_proposals: String(proposalsResult.rows[0]?.count ?? 0),
            total_votes_cast: String(votesResult.rows[0]?.total_weight_cast ?? 0),
            unique_voters: votesResult.rows[0]?.unique_voters ?? 0,
            quorum_hit_count: "0",
            quorum_miss_count: "0",
            pass_rate_bps: 0,
          };
        });
        res.json(data);
      } catch {
        res.status(500).json({ error: "Internal server error" });
      }
    },
  );

  // GET /analytics/proposals/:id/participation — live from proposals/votes.
  app.get(
    "/analytics/proposals/:id/participation",
    strictLimiter,
    async (req: Request, res: Response): Promise<void> => {
      const { id } = req.params;
      const key = `analytics:participation:${id}`;
      try {
        const data = await cached(key, TTL.proposalVotes, async () => {
          const proposalResult = await pool.query(
            `SELECT votes_for, votes_against, votes_abstain FROM proposals WHERE id = $1`,
            [id],
          );
          const proposal = proposalResult.rows[0];
          if (!proposal) return null;

          const votersResult = await pool.query(
            `SELECT COUNT(DISTINCT voter)::int AS unique_voters FROM votes WHERE proposal_id = $1`,
            [id],
          );
          const uniqueVoters = Number(votersResult.rows[0]?.unique_voters ?? 0);

          const votesFor = Number(proposal.votes_for);
          const votesAgainst = Number(proposal.votes_against);
          const votesAbstain = Number(proposal.votes_abstain);
          const totalVotesCast = votesFor + votesAgainst + votesAbstain;
          const bpsOf = (part: number) =>
            totalVotesCast > 0 ? Math.round((part * 10_000) / totalVotesCast) : 0;

          return {
            proposal_id: id,
            total_votes_cast: String(totalVotesCast),
            unique_voters: uniqueVoters,
            for_bps: bpsOf(votesFor),
            against_bps: bpsOf(votesAgainst),
            abstain_bps: bpsOf(votesAbstain),
          };
        });
        if (!data) {
          res.status(404).json({ error: "Proposal not found" });
          return;
        }
        res.json(data);
      } catch {
        res.status(500).json({ error: "Internal server error" });
      }
    },
  );

  // GET /analytics/voters/:address/history — live from votes.
  app.get(
    "/analytics/voters/:address/history",
    strictLimiter,
    async (req: Request, res: Response): Promise<void> => {
      const { address } = req.params;
      const key = `analytics:voter-history:${address}`;
      try {
        const data = await cached(key, TTL.proposalVotes, async () => {
          const [voteResult, proposalsResult] = await Promise.all([
            pool.query(
              `SELECT
                 COUNT(*)::int AS proposals_voted,
                 COALESCE(SUM(weight), 0) AS total_weight_cast,
                 COUNT(*) FILTER (WHERE support = 1)::int AS for_count,
                 COUNT(*) FILTER (WHERE support = 0)::int AS against_count,
                 COUNT(*) FILTER (WHERE support = 2)::int AS abstain_count,
                 COALESCE(MAX(ledger), 0)::int AS last_voted_ledger
               FROM votes WHERE voter = $1`,
              [address],
            ),
            pool.query(`SELECT COUNT(*)::int AS count FROM proposals`),
          ]);
          const row = voteResult.rows[0];
          const proposalsVoted = row?.proposals_voted ?? 0;
          const proposalsEligible = proposalsResult.rows[0]?.count ?? 0;
          const participationRateBps =
            proposalsEligible > 0
              ? Math.round((proposalsVoted / proposalsEligible) * 10_000)
              : 0;
          return {
            voter: address,
            proposals_voted: proposalsVoted,
            proposals_eligible: proposalsEligible,
            participation_rate_bps: participationRateBps,
            total_weight_cast: String(row?.total_weight_cast ?? 0),
            for_count: row?.for_count ?? 0,
            against_count: row?.against_count ?? 0,
            abstain_count: row?.abstain_count ?? 0,
            last_voted_ledger: row?.last_voted_ledger ?? 0,
          };
        });
        res.json(data);
      } catch {
        res.status(500).json({ error: "Internal server error" });
      }
    },
  );

  // GET /analytics/top-voters?limit=20 — live from votes, ordered by total weight cast.
  app.get(
    "/analytics/top-voters",
    async (req: Request, res: Response): Promise<void> => {
      const limit = Math.min(Math.max(Number(req.query.limit ?? 20), 1), 100);
      const key = `analytics:top-voters:${limit}`;
      try {
        const data = await cached(key, TTL.analytics, async () => {
          const result = await pool.query(
            `SELECT
               voter,
               COUNT(*)::int AS proposals_voted,
               COALESCE(SUM(weight), 0) AS total_weight_cast
             FROM votes
             GROUP BY voter
             ORDER BY total_weight_cast DESC
             LIMIT $1`,
            [limit],
          );
          return {
            top_voters: result.rows.map((r, i) => ({
              rank: i + 1,
              voter: r.voter,
              proposals_voted: r.proposals_voted,
              total_weight_cast: String(r.total_weight_cast),
            })),
          };
        });
        res.json(data);
      } catch {
        res.status(500).json({ error: "Internal server error" });
      }
    },
  );

  // --- Proposer reputation endpoints (issue #771) ---
  //
  // Backed by `proposer_reputation` / `reputation_score_history`, populated
  // from the governor's ReputationUpdated and EffectiveThresholdChanged
  // events. Scoring parameters are fixed contract-side constants (not
  // governance-tunable, to stay under Soroban's WASM size budget), so
  // there's no config endpoint to mirror. The authoritative source for an
  // individual address is always the on-chain contract (see
  // ReputationClient in the SDK) — these endpoints exist for fast,
  // aggregate reads such as the leaderboard and score history timeline.

  // GET /reputation/leaderboard?limit=50&offset=0
  app.get(
    "/reputation/leaderboard",
    async (req: Request, res: Response): Promise<void> => {
      const limit = Math.min(Math.max(Number(req.query.limit ?? 50), 1), 200);
      const offset = Math.max(Number(req.query.offset ?? 0), 0);
      const key = `reputation:leaderboard:${limit}:${offset}`;
      try {
        const data = await cached(key, TTL.reputation, async () => {
          const result = await pool.query(
            `SELECT proposer_address, reputation_score, last_updated_ledger
             FROM proposer_reputation
             ORDER BY reputation_score DESC
             LIMIT $1 OFFSET $2`,
            [limit, offset],
          );
          return {
            leaderboard: result.rows.map((r, i) => ({
              rank: offset + i + 1,
              address: r.proposer_address,
              reputation_score: r.reputation_score,
              last_updated_ledger: r.last_updated_ledger,
            })),
          };
        });
        res.json(data);
      } catch {
        res.status(500).json({ error: "Internal server error" });
      }
    },
  );

  // GET /reputation/:address
  app.get(
    "/reputation/:address",
    strictLimiter,
    async (req: Request, res: Response): Promise<void> => {
      const { address } = req.params;
      const key = `reputation:${address}`;
      try {
        const data = await cached(key, TTL.reputation, async () => {
          const result = await pool.query(
            `SELECT proposer_address, reputation_score, last_updated_ledger
             FROM proposer_reputation WHERE proposer_address = $1`,
            [address],
          );
          const row = result.rows[0];
          return {
            address,
            reputation_score: row?.reputation_score ?? 0,
            last_updated_ledger: row?.last_updated_ledger ?? null,
          };
        });
        res.json(data);
      } catch {
        res.status(500).json({ error: "Internal server error" });
      }
    },
  );

  // GET /reputation/:address/history?offset=0&limit=50
  //
  // Pages backwards from the newest entry, so offset 0 is always the most
  // recent `limit` rows. Each page is returned oldest-first for charting.
  app.get(
    "/reputation/:address/history",
    strictLimiter,
    async (req: Request, res: Response): Promise<void> => {
      const { address } = req.params;
      const offset = Math.max(Number(req.query.offset ?? 0), 0);
      const limit = Math.min(Math.max(Number(req.query.limit ?? 50), 1), 200);
      try {
        const result = await pool.query(
          `SELECT ledger, score, change, reason
           FROM (
             SELECT ledger, score, change, reason
             FROM reputation_score_history
             WHERE proposer_address = $1
             ORDER BY ledger DESC
             OFFSET $2 LIMIT $3
           ) recent
           ORDER BY ledger ASC`,
          [address, offset, limit],
        );
        res.json({
          history: result.rows,
          pagination: { limit, offset, hasMore: result.rows.length === limit },
        });
      } catch {
        res.status(500).json({ error: "Internal server error" });
      }
    },
  );

  // GET /reputation/:address/threshold-history?offset=0&limit=50
  app.get(
    "/reputation/:address/threshold-history",
    strictLimiter,
    async (req: Request, res: Response): Promise<void> => {
      const { address } = req.params;
      const offset = Math.max(Number(req.query.offset ?? 0), 0);
      const limit = Math.min(Math.max(Number(req.query.limit ?? 50), 1), 200);
      try {
        const result = await pool.query(
          `SELECT ledger, old_threshold, new_threshold, created_at
           FROM effective_threshold_history
           WHERE proposer_address = $1
           ORDER BY ledger DESC
           OFFSET $2 LIMIT $3`,
          [address, offset, limit],
        );
        res.json({
          history: result.rows,
          pagination: { limit, offset, hasMore: result.rows.length === limit },
        });
      } catch {
        res.status(500).json({ error: "Internal server error" });
      }
    },
  );

  // GET /wrapper/deposits?account=G...&limit&offset
  app.get(
    "/wrapper/deposits",
    async (req: Request, res: Response): Promise<void> => {
      const account =
        typeof req.query.account === "string" ? req.query.account : undefined;
      const limit = Math.min(Number(req.query.limit ?? 50), 200);
      const offset = Number(req.query.offset ?? 0);
      try {
        const params: any[] = [];
        let where = "";
        if (account) {
          where = "WHERE account = $1";
          params.push(account);
        }
        params.push(limit, offset);
        const limitIdx = params.length - 1;
        const offsetIdx = params.length;

        const result = await pool.query(
          `SELECT * FROM wrapper_deposits ${where} ORDER BY ledger DESC, id DESC LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
          params,
        );
        res.json({
          data: result.rows,
          pagination: { limit, offset, hasMore: result.rows.length === limit },
        });
      } catch {
        res.status(500).json({ error: "Internal server error" });
      }
    },
  );

  // GET /wrapper/withdrawals?account=G...&limit&offset
  app.get(
    "/wrapper/withdrawals",
    async (req: Request, res: Response): Promise<void> => {
      const account =
        typeof req.query.account === "string" ? req.query.account : undefined;
      const limit = Math.min(Number(req.query.limit ?? 50), 200);
      const offset = Number(req.query.offset ?? 0);
      try {
        const params: any[] = [];
        let where = "";
        if (account) {
          where = "WHERE account = $1";
          params.push(account);
        }
        params.push(limit, offset);
        const limitIdx = params.length - 1;
        const offsetIdx = params.length;

        const result = await pool.query(
          `SELECT * FROM wrapper_withdrawals ${where} ORDER BY ledger DESC, id DESC LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
          params,
        );
        res.json({
          data: result.rows,
          pagination: { limit, offset, hasMore: result.rows.length === limit },
        });
      } catch {
        res.status(500).json({ error: "Internal server error" });
      }
    },
  );

  // GET /treasury/transfers?limit&offset — paginated treasury batch transfer history
  app.get(
    "/treasury/transfers",
    async (req: Request, res: Response): Promise<void> => {
      const limit = Math.min(Number(req.query.limit ?? 20), 100);
      const offset = Number(req.query.offset ?? 0);
      try {
        const result = await pool.query(
          `SELECT * FROM treasury_transfers ORDER BY ledger DESC, id DESC LIMIT $1 OFFSET $2`,
          [limit, offset],
        );
        res.json({
          data: result.rows,
          pagination: { limit, offset, hasMore: result.rows.length === limit },
        });
      } catch {
        res.status(500).json({ error: "Internal server error" });
      }
    },
  );

  app.get(
    "/streams",
    async (req: Request, res: Response): Promise<void> => {
      const pagination = parsePagination(
        req.query.limit,
        req.query.offset,
        20,
        100,
      );
      if (!pagination) {
        res.status(400).json({ error: "Invalid pagination parameters" });
        return;
      }
      const { limit, offset } = pagination;
      const owner =
        typeof req.query.owner === "string" && req.query.owner.length > 0
          ? req.query.owner
          : undefined;
      const key = `treasury:streams:${owner ?? "all"}:${limit}:${offset}`;
      try {
        const data = await cached(key, TTL.treasury, async () => {
          const params: unknown[] = [];
          let where = "";
          if (owner) {
            params.push(owner);
            where = `WHERE owner = $${params.length}`;
          }
          params.push(limit, offset);
          const result = await pool.query(
            `SELECT * FROM treasury_streams
             ${where}
             ORDER BY stream_id ASC
             LIMIT $${params.length - 1} OFFSET $${params.length}`,
            params,
          );
          return {
            data: result.rows,
            pagination: {
              limit,
              offset,
              hasMore: result.rows.length === limit,
            },
          };
        });
        res.json(data);
      } catch {
        res.status(500).json({ error: "Internal server error" });
      }
    },
  );

  app.get(
    "/streams/:id/spends",
    async (req: Request, res: Response): Promise<void> => {
      const { id } = req.params;
      if (!/^\d+$/.test(id)) {
        res.status(400).json({ error: "Invalid stream ID" });
        return;
      }
      const pagination = parsePagination(
        req.query.limit,
        req.query.offset,
        50,
        200,
      );
      if (!pagination) {
        res.status(400).json({ error: "Invalid pagination parameters" });
        return;
      }
      const { limit, offset } = pagination;
      const key = `treasury:stream:${id}:spends:${limit}:${offset}`;
      try {
        const stream = await pool.query(
          "SELECT 1 FROM treasury_streams WHERE stream_id = $1",
          [id],
        );
        if (stream.rows.length === 0) {
          res.status(404).json({ error: "Stream not found" });
          return;
        }
        const data = await cached(key, TTL.treasury, async () => {
          const result = await pool.query(
            `SELECT * FROM treasury_stream_spends
             WHERE stream_id = $1
             ORDER BY spend_index ASC
             LIMIT $2 OFFSET $3`,
            [id, limit, offset],
          );
          return {
            data: result.rows,
            pagination: {
              limit,
              offset,
              hasMore: result.rows.length === limit,
            },
          };
        });
        res.json(data);
      } catch {
        res.status(500).json({ error: "Internal server error" });
      }
    },
  );

  app.get(
    "/voting-rewards/epochs/:id/claims",
    async (req: Request, res: Response): Promise<void> => {
      const { id } = req.params;
      if (!/^\d+$/.test(id)) {
        res.status(400).json({ error: "Invalid epoch ID" });
        return;
      }
      const pagination = parsePagination(
        req.query.limit,
        req.query.offset,
        50,
        200,
      );
      if (!pagination) {
        res.status(400).json({ error: "Invalid pagination parameters" });
        return;
      }
      const { limit, offset } = pagination;
      try {
        const epoch = await pool.query(
          `SELECT epoch_id, total_reward_amount, total_claimed, swept_amount
           FROM reward_epochs
           WHERE epoch_id = $1`,
          [id],
        );
        if (epoch.rows.length === 0) {
          res.status(404).json({ error: "Reward epoch not found" });
          return;
        }
        const result = await pool.query(
          `SELECT * FROM reward_claims
           WHERE epoch_id = $1
           ORDER BY ledger DESC, event_id DESC
           LIMIT $2 OFFSET $3`,
          [id, limit, offset],
        );
        res.json({
          epoch: epoch.rows[0],
          data: result.rows,
          pagination: { limit, offset, hasMore: result.rows.length === limit },
        });
      } catch {
        res.status(500).json({ error: "Internal server error" });
      }
    },
  );

  app.get(
    "/streams/:id",
    async (req: Request, res: Response): Promise<void> => {
      const { id } = req.params;
      if (!/^\d+$/.test(id)) {
        res.status(400).json({ error: "Invalid stream ID" });
        return;
      }
      try {
        const data = await cached(
          `treasury:stream:${id}`,
          TTL.treasury,
          async () => {
            const result = await pool.query(
              "SELECT * FROM treasury_streams WHERE stream_id = $1",
              [id],
            );
            return result.rows[0] ?? null;
          },
        );
        if (!data) {
          res.status(404).json({ error: "Stream not found" });
          return;
        }
        res.json(data);
      } catch {
        res.status(500).json({ error: "Internal server error" });
      }
    },
  );

  app.get(
    "/treasury/stream-events",
    async (req: Request, res: Response): Promise<void> => {
      const streamId =
        typeof req.query.stream_id === "string"
          ? req.query.stream_id
          : undefined;
      if (!streamId || !/^\d+$/.test(streamId)) {
        res.status(400).json({ error: "stream_id is required" });
        return;
      }
      const pagination = parsePagination(
        req.query.limit,
        req.query.offset,
        20,
        100,
      );
      if (!pagination) {
        res.status(400).json({ error: "Invalid pagination parameters" });
        return;
      }
      const { limit, offset } = pagination;
      const key = `treasury:stream:${streamId}:events:${limit}:${offset}`;
      try {
        const data = await cached(key, TTL.treasury, async () => {
          const result = await pool.query(
            `SELECT
               event_type, stream_id, name, owner, recipient, amount,
               total_amount, recipient_count, caller, unspent_returned,
               old_end_ledger, new_end_ledger, additional_amount,
               new_total_amount, unspent, ledger, transaction_hash
             FROM treasury_stream_events
             WHERE stream_id = $1
             ORDER BY ledger DESC, event_id DESC
             LIMIT $2 OFFSET $3`,
            [streamId, limit, offset],
          );
          return {
            data: result.rows,
            pagination: {
              limit,
              offset,
              hasMore: result.rows.length === limit,
            },
          };
        });
        res.json(data);
      } catch {
        res.status(500).json({ error: "Internal server error" });
      }
    },
  );

  app.get(
    "/treasury/budget-summary",
    async (_req: Request, res: Response): Promise<void> => {
      try {
        const data = await cached(
          "treasury:budget-summary",
          TTL.treasury,
          async () => {
            const [counts, amounts] = await Promise.all([
              pool.query(
                `SELECT
                   COUNT(*)::int AS total_streams,
                   COUNT(*) FILTER (
                     WHERE is_active = TRUE AND is_revoked = FALSE
                   )::int AS active_streams
                 FROM treasury_streams`,
              ),
              pool.query(
                `SELECT
                   token,
                   SUM(total_allocated)::text AS total_allocated,
                   SUM(total_spent)::text AS total_spent,
                   SUM(total_allocated - total_spent)::text AS total_remaining
                 FROM treasury_streams
                 GROUP BY token
                 ORDER BY token`,
              ),
            ]);
            const count = counts.rows[0] ?? {
              total_streams: 0,
              active_streams: 0,
            };
            return {
              total_streams: count.total_streams,
              active_streams: count.active_streams,
              total_allocated_by_token: amounts.rows.map((row) => ({
                token: row.token,
                amount: row.total_allocated,
              })),
              total_spent_by_token: amounts.rows.map((row) => ({
                token: row.token,
                amount: row.total_spent,
              })),
              total_remaining_by_token: amounts.rows.map((row) => ({
                token: row.token,
                amount: row.total_remaining,
              })),
            };
          },
        );
        res.json(data);
      } catch {
        res.status(500).json({ error: "Internal server error" });
      }
    },
  );

  // GET /config-history?limit&offset — paginated list of config updates
  app.get(
    "/config-history",
    async (req: Request, res: Response): Promise<void> => {
      const limit = Math.min(Number(req.query.limit ?? 20), 100);
      const offset = Number(req.query.offset ?? 0);
      try {
        const result = await pool.query(
          `SELECT * FROM config_updates ORDER BY ledger DESC, id DESC LIMIT $1 OFFSET $2`,
          [limit, offset],
        );
        res.json({
          data: result.rows,
          pagination: { limit, offset, hasMore: result.rows.length === limit },
        });
      } catch {
        res.status(500).json({ error: "Internal server error" });
      }
    },
  );

  // GET /upgrade-history?limit&offset — paginated list of governor upgrades
  app.get(
    "/upgrade-history",
    async (req: Request, res: Response): Promise<void> => {
      const limit = Math.min(Number(req.query.limit ?? 20), 100);
      const offset = Number(req.query.offset ?? 0);
      try {
        const result = await pool.query(
          `SELECT * FROM governor_upgrades ORDER BY ledger DESC, id DESC LIMIT $1 OFFSET $2`,
          [limit, offset],
        );
        res.json({
          data: result.rows,
          pagination: { limit, offset, hasMore: result.rows.length === limit },
        });
      } catch {
        res.status(500).json({ error: "Internal server error" });
      }
    },
  );

  // GET /leaderboard/voters?limit=20&offset=0 — voters ranked by participation count
  app.get(
    "/leaderboard/voters",
    async (req: Request, res: Response): Promise<void> => {
      const limit = Math.min(Number(req.query.limit ?? 20), 100);
      const offset = Number(req.query.offset ?? 0);
      const key = `leaderboard:voters:${limit}:${offset}`;

      try {
        const data = await cached(key, TTL.delegates, async () => {
          const result = await pool.query(
            `SELECT
              voter,
              COUNT(*)::int AS proposals_voted,
              SUM(weight)::bigint AS total_voting_weight,
              SUM(CASE WHEN support = 1 THEN 1 ELSE 0 END)::int AS for_count,
              SUM(CASE WHEN support = 0 THEN 1 ELSE 0 END)::int AS against_count,
              SUM(CASE WHEN support = 2 THEN 1 ELSE 0 END)::int AS abstain_count
            FROM votes
            GROUP BY voter
            ORDER BY proposals_voted DESC
            LIMIT $1 OFFSET $2`,
            [limit, offset],
          );

          // Get total count
          const countResult = await pool.query(
            `SELECT COUNT(DISTINCT voter)::int AS total FROM votes`,
          );
          const total = countResult.rows[0]?.total ?? 0;

          return {
            voters: result.rows,
            total,
            limit,
            offset,
            hasMore: offset + limit < total,
          };
        });

        res.json(data);
      } catch (error) {
        console.error("Leaderboard voters error:", error);
        res.status(500).json({ error: "Internal server error" });
      }
    },
  );

  // GET /drafts?status=active&page=1&limit=20 — co-sponsorship drafts
  app.get("/drafts", async (req: Request, res: Response): Promise<void> => {
    const limit = Math.min(Number(req.query.limit ?? 20), 100);
    const page = Math.max(1, Number(req.query.page ?? 1));
    const status = req.query.status ? String(req.query.status).trim() : undefined;
    const key = `drafts:list:${status ?? ""}:${page}:${limit}`;

    try {
      const conditions: string[] = [];
      if (status === "active") {
        // expired = false is a defense-in-depth backstop: DraftExpired is emitted
        // lazily on-chain (only when a stale draft is next read), so it can lag
        // behind reality. Also require expiry_ledger to still be in the future
        // relative to the indexer's last-seen ledger.
        conditions.push(
          "finalized = false AND cancelled = false AND expired = false AND expiry_ledger > (SELECT last_ledger FROM indexer_state WHERE id = 1)",
        );
      } else if (status === "finalized") {
        conditions.push("finalized = true");
      } else if (status === "cancelled") {
        conditions.push("cancelled = true");
      } else if (status === "expired") {
        conditions.push("expired = true");
      }
      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

      const data = await cached(key, TTL.proposals, async () => {
        const result = await pool.query(
          `SELECT * FROM drafts ${whereClause} ORDER BY draft_id DESC LIMIT $1 OFFSET $2`,
          [limit, (page - 1) * limit],
        );
        return {
          data: result.rows,
          pagination: { page, limit, hasMore: result.rows.length === limit },
        };
      });
      res.json(data);
    } catch {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /drafts/by-creator/:address
  app.get(
    "/drafts/by-creator/:address",
    async (req: Request, res: Response): Promise<void> => {
      const { address } = req.params;
      try {
        const result = await pool.query(
          `SELECT * FROM drafts WHERE creator_address = $1 ORDER BY draft_id DESC`,
          [address],
        );
        res.json({ data: result.rows });
      } catch {
        res.status(500).json({ error: "Internal server error" });
      }
    },
  );

  // GET /drafts/:id
  app.get("/drafts/:id", async (req: Request, res: Response): Promise<void> => {
    const draftId = req.params.id;
    try {
      const result = await pool.query(`SELECT * FROM drafts WHERE draft_id = $1`, [
        draftId,
      ]);
      if (!result.rows[0]) {
        res.status(404).json({ error: "Draft not found" });
        return;
      }
      res.json(result.rows[0]);
    } catch {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /drafts/:id/co-sponsors
  app.get(
    "/drafts/:id/co-sponsors",
    async (req: Request, res: Response): Promise<void> => {
      const draftId = req.params.id;
      try {
        const result = await pool.query(
          `SELECT * FROM draft_co_sponsors WHERE draft_id = $1 AND withdrawn = false ORDER BY pledged_at_ledger ASC`,
          [draftId],
        );
        res.json({ data: result.rows });
      } catch {
        res.status(500).json({ error: "Internal server error" });
      }
    },
  );

  // --- Signaling endpoints (#999) ---

  // GET /signal-anchors/:pollId — independently verify a finalized signaling
  // poll's published result_hash against the indexed on-chain anchor.
  app.get(
    "/signal-anchors/:pollId",
    async (req: Request, res: Response): Promise<void> => {
      const pollId = req.params.pollId;
      try {
        const result = await pool.query(
          `SELECT * FROM signal_anchors WHERE poll_id = $1`,
          [pollId],
        );
        if (!result.rows[0]) {
          res.status(404).json({ error: "Anchor not found" });
          return;
        }
        res.json(result.rows[0]);
      } catch {
        res.status(500).json({ error: "Internal server error" });
      }
    },
  );

  // --- Proposal bonds endpoints (#996) ---

  // GET /proposal-bonds?state=locked|refunded|slashed
  app.get("/proposal-bonds", async (req: Request, res: Response): Promise<void> => {
    const limit = Math.min(Number(req.query.limit ?? 20), 100);
    const page = Math.max(1, Number(req.query.page ?? 1));
    const state = req.query.state ? String(req.query.state).trim() : undefined;
    const validStates = ["locked", "refunded", "slashed"];
    if (state && !validStates.includes(state)) {
      res.status(400).json({ error: "Invalid state filter" });
      return;
    }
    const key = `proposal-bonds:list:${state ?? ""}:${page}:${limit}`;

    try {
      const whereClause = state ? "WHERE state = $3" : "";
      const params = state
        ? [limit, (page - 1) * limit, state]
        : [limit, (page - 1) * limit];
      const data = await cached(key, TTL.proposalBonds, async () => {
        const result = await pool.query(
          `SELECT * FROM proposal_bonds ${whereClause} ORDER BY id DESC LIMIT $1 OFFSET $2`,
          params,
        );
        return {
          data: result.rows,
          pagination: { page, limit, hasMore: result.rows.length === limit },
        };
      });
      res.json(data);
    } catch {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /proposal-bonds/by-proposer/:address
  app.get(
    "/proposal-bonds/by-proposer/:address",
    async (req: Request, res: Response): Promise<void> => {
      const { address } = req.params;
      try {
        const result = await pool.query(
          `SELECT * FROM proposal_bonds WHERE proposer_address = $1 ORDER BY id DESC`,
          [address],
        );
        res.json({ data: result.rows });
      } catch {
        res.status(500).json({ error: "Internal server error" });
      }
    },
  );

  // GET /proposal-bonds/:descriptionHash
  app.get(
    "/proposal-bonds/:descriptionHash",
    async (req: Request, res: Response): Promise<void> => {
      const { descriptionHash } = req.params;
      try {
        const result = await pool.query(
          `SELECT * FROM proposal_bonds WHERE description_hash = $1`,
          [descriptionHash],
        );
        if (!result.rows[0]) {
          res.status(404).json({ error: "Bond not found" });
          return;
        }
        res.json(result.rows[0]);
      } catch {
        res.status(500).json({ error: "Internal server error" });
      }
    },
  );

  // --- Timelock endpoints (#906) ---

  // GET /timelock/operations/:opId
  app.get(
    "/timelock/operations/:opId",
    async (req: Request, res: Response): Promise<void> => {
      const { opId } = req.params;
      const key = `timelock:op:${opId}`;
      try {
        const data = await cached(key, TTL.proposals, async () => {
          const result = await pool.query(
            `SELECT * FROM timelock_operations WHERE op_id = $1`,
            [opId],
          );
          return result.rows[0] ?? null;
        });
        if (!data) {
          res.status(404).json({ error: "Operation not found" });
          return;
        }
        res.json(data);
      } catch {
        res.status(500).json({ error: "Internal server error" });
      }
    },
  );

  // GET /timelock/batches/:batchOpId
  app.get(
    "/timelock/batches/:batchOpId",
    async (req: Request, res: Response): Promise<void> => {
      const { batchOpId } = req.params;
      const key = `timelock:batch:${batchOpId}`;
      try {
        const data = await cached(key, TTL.proposals, async () => {
          const result = await pool.query(
            `SELECT * FROM timelock_batch_operations WHERE batch_op_id = $1`,
            [batchOpId],
          );
          return result.rows[0] ?? null;
        });
        if (!data) {
          res.status(404).json({ error: "Batch operation not found" });
          return;
        }
        res.json(data);
      } catch {
        res.status(500).json({ error: "Internal server error" });
      }
    },
  );

  // GET /timelock/batches/:batchOpId/dag
  app.get(
    "/timelock/batches/:batchOpId/dag",
    async (req: Request, res: Response): Promise<void> => {
      const { batchOpId } = req.params;
      const key = `timelock:dag:${batchOpId}`;
      try {
        const data = await cached(key, TTL.proposals, async () => {
          const result = await pool.query(
            `SELECT * FROM timelock_dependency_graphs
             WHERE batch_op_id = $1
             ORDER BY ledger DESC
             LIMIT 1`,
            [batchOpId],
          );
          return result.rows[0] ?? null;
        });
        if (!data) {
          res.status(404).json({ error: "Dependency DAG not found" });
          return;
        }
        res.json(data);
      } catch {
        res.status(500).json({ error: "Internal server error" });
      }
    },
  );

  // GET /timelock/batches/:batchOpId/partial-state
  app.get(
    "/timelock/batches/:batchOpId/partial-state",
    async (req: Request, res: Response): Promise<void> => {
      const { batchOpId } = req.params;
      const key = `timelock:partial_state:${batchOpId}`;
      try {
        const data = await cached(key, TTL.proposals, async () => {
          const result = await pool.query(
            `SELECT * FROM timelock_partial_batch_state WHERE batch_op_id = $1`,
            [batchOpId],
          );
          return result.rows[0] ?? null;
        });
        if (!data) {
          res.status(404).json({ error: "Partial batch state not found" });
          return;
        }
        res.json(data);
      } catch {
        res.status(500).json({ error: "Internal server error" });
      }
    },
  );

  app.get("/conviction/proposals", async (req: Request, res: Response): Promise<void> => {
    const status = String(req.query.status ?? "active");
    const predicates: Record<string, string> = {
      active: "executed = FALSE AND cancelled = FALSE",
      executed: "executed = TRUE",
      cancelled: "cancelled = TRUE",
    };
    if (!predicates[status]) {
      res.status(400).json({ error: "status must be active, executed, or cancelled" });
      return;
    }
    try {
      const result = await pool.query(
        `SELECT * FROM conviction_proposals WHERE ${predicates[status]} ORDER BY proposal_id DESC`,
      );
      res.json({ data: result.rows });
    } catch {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/conviction/proposals/:id", async (req: Request, res: Response): Promise<void> => {
    try {
      const result = await pool.query(
        "SELECT * FROM conviction_proposals WHERE proposal_id = $1",
        [req.params.id],
      );
      if (!result.rows[0]) {
        res.status(404).json({ error: "Conviction proposal not found" });
        return;
      }
      res.json(result.rows[0]);
    } catch {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/conviction/proposals/:id/conviction-history", async (req: Request, res: Response): Promise<void> => {
    try {
      const result = await pool.query(
        "SELECT proposal_id, ledger, conviction FROM conviction_snapshots WHERE proposal_id = $1 ORDER BY ledger ASC",
        [req.params.id],
      );
      res.json({ data: result.rows });
    } catch {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/conviction/proposals/:id/stakes", async (req: Request, res: Response): Promise<void> => {
    const pagination = parsePagination(req.query.limit, req.query.offset, 50, 200);
    if (!pagination) {
      res.status(400).json({ error: "Invalid pagination parameters" });
      return;
    }
    const { limit, offset } = pagination;
    try {
      const result = await pool.query(
        "SELECT * FROM conviction_stakes WHERE proposal_id = $1 ORDER BY amount DESC LIMIT $2 OFFSET $3",
        [req.params.id, limit, offset],
      );
      res.json({
        data: result.rows,
        pagination: { limit, offset, hasMore: result.rows.length === limit },
      });
    } catch {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/conviction/stakers/:address", async (req: Request, res: Response): Promise<void> => {
    try {
      const result = await pool.query(
        "SELECT * FROM conviction_stakes WHERE staker = $1",
        [req.params.address],
      );
      res.json(result.rows[0] ?? null);
    } catch {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // --- Optimistic governance endpoints (#993) ---

  app.get("/optimistic/proposals", async (req: Request, res: Response): Promise<void> => {
    const status = req.query.status
      ? String(req.query.status)
      : undefined;
    const validStates = ["challenge_window", "objected", "passed", "executed", "cancelled"];
    if (status && !validStates.includes(status)) {
      res.status(400).json({
        error: `status must be one of: ${validStates.join(", ")}`,
      });
      return;
    }
    try {
      const result = status
        ? await pool.query(
            "SELECT * FROM optimistic_proposals WHERE state = $1 ORDER BY proposal_id DESC",
            [status],
          )
        : await pool.query(
            "SELECT * FROM optimistic_proposals ORDER BY proposal_id DESC",
          );
      res.json({ data: result.rows });
    } catch {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/optimistic/proposals/:id", async (req: Request, res: Response): Promise<void> => {
    try {
      const result = await pool.query(
        "SELECT * FROM optimistic_proposals WHERE proposal_id = $1",
        [req.params.id],
      );
      if (!result.rows[0]) {
        res.status(404).json({ error: "Optimistic proposal not found" });
        return;
      }
      res.json(result.rows[0]);
    } catch {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get(
    "/optimistic/proposals/:id/objections",
    async (req: Request, res: Response): Promise<void> => {
      try {
        const result = await pool.query(
          "SELECT * FROM optimistic_objections WHERE proposal_id = $1 ORDER BY ledger ASC",
          [req.params.id],
        );
        res.json({ data: result.rows });
      } catch {
        res.status(500).json({ error: "Internal server error" });
      }
    },
  );

  // --- Treasury strategies endpoints (#997) ---

  // GET /treasury-strategies?token=&active=&limit=&offset=
  app.get(
    "/treasury-strategies",
    async (req: Request, res: Response): Promise<void> => {
      const pagination = parsePagination(
        req.query.limit,
        req.query.offset,
        20,
        100,
      );
      if (!pagination) {
        res.status(400).json({ error: "Invalid pagination parameters" });
        return;
      }
      const { limit, offset } = pagination;
      const token =
        typeof req.query.token === "string" && req.query.token.length > 0
          ? req.query.token
          : undefined;
      const active =
        typeof req.query.active === "string"
          ? req.query.active === "true"
          : undefined;
      const key = `treasury-strategies:${token ?? "all"}:${active ?? "all"}:${limit}:${offset}`;
      try {
        const data = await cached(key, TTL.treasury, async () => {
          const params: unknown[] = [];
          const conditions: string[] = [];
          if (token) {
            params.push(token);
            conditions.push(`token = $${params.length}`);
          }
          if (active !== undefined) {
            params.push(active);
            conditions.push(`active = $${params.length}`);
          }
          const where = conditions.length
            ? `WHERE ${conditions.join(" AND ")}`
            : "";
          params.push(limit, offset);
          const result = await pool.query(
            `SELECT * FROM treasury_strategies
             ${where}
             ORDER BY strategy_id ASC
             LIMIT $${params.length - 1} OFFSET $${params.length}`,
            params,
          );
          return {
            strategies: result.rows,
            pagination: { limit, offset, hasMore: result.rows.length === limit },
          };
        });
        res.json(data);
      } catch {
        res.status(500).json({ error: "Internal server error" });
      }
    },
  );

  // GET /treasury-strategies/withdrawals?status=pending|claimable|claimed&strategy_id=&limit=&offset=
  // "claimable" is derived (pending + claimable_ledger reached) against the
  // indexer's own last-indexed ledger, the same defense-in-depth pattern
  // used for draft expiry.
  app.get(
    "/treasury-strategies/withdrawals",
    async (req: Request, res: Response): Promise<void> => {
      const pagination = parsePagination(
        req.query.limit,
        req.query.offset,
        20,
        100,
      );
      if (!pagination) {
        res.status(400).json({ error: "Invalid pagination parameters" });
        return;
      }
      const { limit, offset } = pagination;
      const status =
        typeof req.query.status === "string" ? req.query.status : undefined;
      if (status && !["pending", "claimable", "claimed"].includes(status)) {
        res.status(400).json({ error: "Invalid status filter" });
        return;
      }
      const strategyId =
        typeof req.query.strategy_id === "string"
          ? req.query.strategy_id
          : undefined;
      const key = `treasury-strategies:withdrawals:${status ?? "all"}:${strategyId ?? "all"}:${limit}:${offset}`;
      try {
        const data = await cached(key, TTL.treasury, async () => {
          const lastLedgerResult = await pool.query(
            "SELECT last_ledger FROM indexer_state WHERE id = 1",
          );
          const lastLedger = lastLedgerResult.rows[0]?.last_ledger ?? 0;

          const params: unknown[] = [];
          const conditions: string[] = [];
          if (strategyId) {
            params.push(strategyId);
            conditions.push(`strategy_id = $${params.length}`);
          }
          if (status === "claimed") {
            conditions.push("claimed_ledger IS NOT NULL");
          } else if (status === "pending") {
            params.push(lastLedger);
            conditions.push(
              `claimed_ledger IS NULL AND claimable_ledger > $${params.length}`,
            );
          } else if (status === "claimable") {
            params.push(lastLedger);
            conditions.push(
              `claimed_ledger IS NULL AND claimable_ledger <= $${params.length}`,
            );
          }
          const where = conditions.length
            ? `WHERE ${conditions.join(" AND ")}`
            : "";
          const statusLedgerParamIndex = params.length + 1;
          params.push(lastLedger, limit, offset);
          const result = await pool.query(
            `SELECT *,
               CASE
                 WHEN claimed_ledger IS NOT NULL THEN 'claimed'
                 WHEN claimable_ledger <= $${statusLedgerParamIndex} THEN 'claimable'
                 ELSE 'pending'
               END AS status
             FROM strategy_withdrawals
             ${where}
             ORDER BY withdrawal_id ASC
             LIMIT $${params.length - 1} OFFSET $${params.length}`,
            params,
          );
          return {
            withdrawals: result.rows,
            pagination: { limit, offset, hasMore: result.rows.length === limit },
          };
        });
        res.json(data);
      } catch {
        res.status(500).json({ error: "Internal server error" });
      }
    },
  );

  // GET /treasury-strategies/:id
  app.get(
    "/treasury-strategies/:id",
    async (req: Request, res: Response): Promise<void> => {
      const { id } = req.params;
      const key = `treasury-strategies:detail:${id}`;
      try {
        const data = await cached(key, TTL.treasury, async () => {
          const result = await pool.query(
            `SELECT * FROM treasury_strategies WHERE strategy_id = $1`,
            [id],
          );
          return result.rows[0] ?? null;
        });
        if (!data) {
          res.status(404).json({ error: "Strategy not found" });
          return;
        }
        res.json(data);
      } catch {
        res.status(500).json({ error: "Internal server error" });
      }
    },
  );

  // GET /treasury-strategies/:id/performance?limit=&offset=
  // Returns the indexed principal-deposited time series for this strategy.
  // Current *value* (principal plus/minus accrued yield or loss) is a live
  // on-chain read (StrategyAdapterTrait::adapter_balance via
  // get_total_value) rather than an indexed event, so it isn't reflected
  // here — callers wanting a live value should pair this history with the
  // SDK's TreasuryStrategiesClient.getTotalValue(token) call, the same
  // documented indexer/live-read split used by the analytics and reputation
  // modules elsewhere in this API.
  app.get(
    "/treasury-strategies/:id/performance",
    async (req: Request, res: Response): Promise<void> => {
      const { id } = req.params;
      const pagination = parsePagination(
        req.query.limit,
        req.query.offset,
        50,
        200,
      );
      if (!pagination) {
        res.status(400).json({ error: "Invalid pagination parameters" });
        return;
      }
      const { limit, offset } = pagination;
      const key = `treasury-strategies:performance:${id}:${limit}:${offset}`;
      try {
        const data = await cached(key, TTL.treasury, async () => {
          const strategyResult = await pool.query(
            `SELECT strategy_id FROM treasury_strategies WHERE strategy_id = $1`,
            [id],
          );
          if (!strategyResult.rows[0]) {
            return null;
          }
          const result = await pool.query(
            `SELECT amount, ledger, created_at
             FROM strategy_allocations
             WHERE strategy_id = $1
             ORDER BY ledger ASC
             OFFSET $2 LIMIT $3`,
            [id, offset, limit],
          );
          return {
            principal_history: result.rows,
            pagination: { limit, offset, hasMore: result.rows.length === limit },
          };
        });
        if (!data) {
          res.status(404).json({ error: "Strategy not found" });
          return;
        }
        res.json(data);
      } catch {
        res.status(500).json({ error: "Internal server error" });
      }
    },
  );

  // --- Voting-power concentration endpoints (issue #1012) ---
  //
  // Backed by `concentration_snapshots`, written on a schedule by
  // `maybeTakeConcentrationSnapshot` in concentration.ts. `top-holders` /
  // `top-delegates` are derived live from the same indexed vote-weight and
  // delegation data the snapshot is computed from.

  // GET /analytics/concentration/latest
  app.get(
    "/analytics/concentration/latest",
    async (_req: Request, res: Response): Promise<void> => {
      try {
        const data = await cached(
          "analytics:concentration:latest",
          TTL.analytics,
          async () => {
            const result = await pool.query(
              `SELECT * FROM concentration_snapshots ORDER BY ledger DESC LIMIT 1`,
            );
            return result.rows[0] ?? null;
          },
        );
        res.json(data);
      } catch {
        res.status(500).json({ error: "Internal server error" });
      }
    },
  );

  // GET /analytics/concentration/history?limit=90
  app.get(
    "/analytics/concentration/history",
    async (req: Request, res: Response): Promise<void> => {
      const limit = Math.min(Math.max(Number(req.query.limit ?? 90), 1), 365);
      const key = `analytics:concentration:history:${limit}`;
      try {
        const data = await cached(key, TTL.analytics, async () => {
          const result = await pool.query(
            `SELECT * FROM concentration_snapshots ORDER BY ledger DESC LIMIT $1`,
            [limit],
          );
          return { snapshots: result.rows };
        });
        res.json(data);
      } catch {
        res.status(500).json({ error: "Internal server error" });
      }
    },
  );

  // GET /analytics/concentration/top-holders?limit=20 — live from votes.
  app.get(
    "/analytics/concentration/top-holders",
    async (req: Request, res: Response): Promise<void> => {
      const limit = Math.min(Math.max(Number(req.query.limit ?? 20), 1), 100);
      const key = `analytics:concentration:top-holders:${limit}`;
      try {
        const data = await cached(key, TTL.analytics, async () => {
          const result = await pool.query(
            `WITH latest AS (
               SELECT DISTINCT ON (voter) voter, weight
                 FROM votes
                ORDER BY voter, ledger DESC, id DESC
             )
             SELECT voter, weight FROM latest
              WHERE weight > 0
              ORDER BY weight DESC
              LIMIT $1`,
            [limit],
          );
          const total = result.rows.reduce(
            (acc: bigint, r: { weight: string | number }) => acc + BigInt(r.weight),
            0n,
          );
          return {
            top_holders: result.rows.map(
              (r: { voter: string; weight: string | number }, i: number) => ({
                rank: i + 1,
                address: r.voter,
                voting_power: String(r.weight),
              }),
            ),
            listed_total: total.toString(),
          };
        });
        res.json(data);
      } catch {
        res.status(500).json({ error: "Internal server error" });
      }
    },
  );

  // GET /analytics/concentration/top-delegates?limit=20 — live from delegates + votes.
  app.get(
    "/analytics/concentration/top-delegates",
    async (req: Request, res: Response): Promise<void> => {
      const limit = Math.min(Math.max(Number(req.query.limit ?? 20), 1), 100);
      const key = `analytics:concentration:top-delegates:${limit}`;
      try {
        const data = await cached(key, TTL.analytics, async () => {
          const result = await pool.query(
            `WITH latest_delegation AS (
               SELECT DISTINCT ON (delegator) delegator, new_delegatee
                 FROM delegates
                ORDER BY delegator, ledger DESC, id DESC
             ),
             latest_power AS (
               SELECT DISTINCT ON (voter) voter, weight
                 FROM votes
                ORDER BY voter, ledger DESC, id DESC
             )
             SELECT d.new_delegatee AS delegatee,
                    COALESCE(SUM(p.weight), 0) AS received_power
               FROM latest_delegation d
               LEFT JOIN latest_power p ON p.voter = d.delegator
              WHERE d.new_delegatee <> ''
              GROUP BY d.new_delegatee
              HAVING COALESCE(SUM(p.weight), 0) > 0
              ORDER BY received_power DESC
              LIMIT $1`,
            [limit],
          );
          return {
            top_delegates: result.rows.map(
              (r: { delegatee: string; received_power: string | number }, i: number) => ({
                rank: i + 1,
                address: r.delegatee,
                received_voting_power: String(r.received_power),
              }),
            ),
          };
        });
        res.json(data);
      } catch {
        res.status(500).json({ error: "Internal server error" });
      }
    },
  );

  return app;
}
