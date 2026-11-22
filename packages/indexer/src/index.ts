import { createServer } from "http";
import { Networks, SorobanRpc, StrKey } from "@stellar/stellar-sdk";
import dotenv from "dotenv";
import { initDb, pool } from "./db";
import {
  processEvents,
  getLastIndexedLedger,
  updateLastIndexedLedger,
  maybeTakeGovernanceSnapshot,
} from "./events";
import { maybeTakeConcentrationSnapshot } from "./concentration";
import { createApp } from "./api";
import { createWsServer } from "./ws";
import { createTreasuryStateReader } from "./treasuryReader";
import { bootstrapTreasuryProjection } from "./treasuryProjection";

dotenv.config();

const GOVERNOR_ADDRESS = process.env.GOVERNOR_ADDRESS ?? "";
const GOVERNOR_FACTORY_ADDRESS =
  process.env.GOVERNOR_FACTORY_ADDRESS ?? process.env.FACTORY_ADDRESS ?? "";
const WRAPPER_ADDRESS = process.env.WRAPPER_ADDRESS ?? "";
const TREASURY_ADDRESS = process.env.TREASURY_ADDRESS ?? "";
const LIQUIDITY_ADDRESS = process.env.LIQUIDITY_ADDRESS ?? "";
const CO_SPONSORSHIP_ADDRESS = process.env.CO_SPONSORSHIP_ADDRESS ?? "";
const PROPOSAL_BONDS_ADDRESS = process.env.PROPOSAL_BONDS_ADDRESS ?? "";
const TOKEN_VOTES_ADDRESS = process.env.TOKEN_VOTES_ADDRESS ?? "";
const TIMELOCK_ADDRESS = process.env.TIMELOCK_ADDRESS ?? "";
const CONVICTION_VOTING_ADDRESS = process.env.CONVICTION_VOTING_ADDRESS ?? "";
const SIGNAL_ANCHOR_ADDRESS = process.env.SIGNAL_ANCHOR_ADDRESS ?? "";
const TREASURY_STRATEGIES_ADDRESS =
  process.env.TREASURY_STRATEGIES_ADDRESS ?? "";
const OPTIMISTIC_GOVERNOR_ADDRESS =
  process.env.OPTIMISTIC_GOVERNOR_ADDRESS ?? "";
const VOTE_ESCROW_ADDRESS = process.env.VOTE_ESCROW_ADDRESS ?? "";
const GUARDIAN_COUNCIL_ADDRESS =
  process.env.GUARDIAN_COUNCIL_ADDRESS ?? "";
const TREASURY_SIMULATION_ACCOUNT =
  process.env.TREASURY_SIMULATION_ACCOUNT ?? "";
const NETWORK_PASSPHRASE =
  process.env.STELLAR_NETWORK_PASSPHRASE ?? Networks.TESTNET;
const RPC_URL = process.env.STELLAR_RPC_URL ?? "https://soroban-testnet.stellar.org";
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 5000);
const PORT = Number(process.env.PORT ?? 3001);

export const INDEXED_CONTRACTS = {
  GOVERNOR_ADDRESS,
  GOVERNOR_FACTORY_ADDRESS,
  WRAPPER_ADDRESS,
  TREASURY_ADDRESS,
  LIQUIDITY_ADDRESS,
  CO_SPONSORSHIP_ADDRESS,
  PROPOSAL_BONDS_ADDRESS,
  TOKEN_VOTES_ADDRESS,
  TIMELOCK_ADDRESS,
  CONVICTION_VOTING_ADDRESS,
  SIGNAL_ANCHOR_ADDRESS,
  TREASURY_STRATEGIES_ADDRESS,
  OPTIMISTIC_GOVERNOR_ADDRESS,
  VOTE_ESCROW_ADDRESS,
  GUARDIAN_COUNCIL_ADDRESS,
};

for (const [name, address] of Object.entries(INDEXED_CONTRACTS)) {
  if (!address) console.warn(`[indexer] ${name} is not configured; contract will not be indexed`);
  else if (!StrKey.isValidContract(address))
    console.warn(`[indexer] ${name} is invalid; contract will not be indexed`);
}

// Track indexer startup time for uptime calculation
export const startTime = Date.now();

let pollingInterval: ReturnType<typeof setInterval> | null = null;
let currentBatchPromise: Promise<void> = Promise.resolve();
let isShuttingDown = false;

async function shutdown(): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log("Shutting down gracefully...");

  if (pollingInterval !== null) {
    clearInterval(pollingInterval);
    pollingInterval = null;
  }

  // Wait for the in-flight batch to complete before closing the DB connection
  await currentBatchPromise;

  await pool.end();
  console.log("Database connections closed.");
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

async function runIndexer(): Promise<void> {
  const server = new SorobanRpc.Server(RPC_URL, { allowHttp: false });
  if (TREASURY_ADDRESS && !TREASURY_SIMULATION_ACCOUNT) {
    throw new Error(
      "TREASURY_SIMULATION_ACCOUNT is required when TREASURY_ADDRESS is configured",
    );
  }
  const treasuryStateReader =
    TREASURY_ADDRESS && TREASURY_SIMULATION_ACCOUNT
      ? createTreasuryStateReader({
          server,
          treasuryAddress: TREASURY_ADDRESS,
          simulationAccount: TREASURY_SIMULATION_ACCOUNT,
          networkPassphrase: NETWORK_PASSPHRASE,
        })
      : undefined;

  const config = {
    rpcUrl: RPC_URL,
    governorAddress: GOVERNOR_ADDRESS,
    governorFactoryAddress: GOVERNOR_FACTORY_ADDRESS,
    wrapperAddress: WRAPPER_ADDRESS,
    treasuryAddress: TREASURY_ADDRESS,
    liquidityAddress: LIQUIDITY_ADDRESS,
    coSponsorshipAddress: CO_SPONSORSHIP_ADDRESS,
    proposalBondsAddress: PROPOSAL_BONDS_ADDRESS,
    tokenVotesAddress: TOKEN_VOTES_ADDRESS,
    timelockAddress: TIMELOCK_ADDRESS,
    convictionVotingAddress: CONVICTION_VOTING_ADDRESS,
    signalAnchorAddress: SIGNAL_ANCHOR_ADDRESS,
    treasuryStrategiesAddress: TREASURY_STRATEGIES_ADDRESS,
    optimisticGovernorAddress: OPTIMISTIC_GOVERNOR_ADDRESS,
    voteEscrowAddress: VOTE_ESCROW_ADDRESS,
    guardianCouncilAddress: GUARDIAN_COUNCIL_ADDRESS,
    treasuryStateReader,
    pollIntervalMs: POLL_INTERVAL_MS,
  };

  if (treasuryStateReader) {
    const currentLedger = (await server.getLatestLedger()).sequence;
    const hydrated = await bootstrapTreasuryProjection(
      treasuryStateReader,
      currentLedger,
    );
    console.log(
      `Hydrated ${hydrated.streams} treasury streams and ${hydrated.spends} spends`,
    );
  }

  let lastLedger = await getLastIndexedLedger();

  console.log(`Starting indexer from ledger ${lastLedger}`);

  async function pollOnce(): Promise<void> {
    if (isShuttingDown) return;
    const batchPromise = (async () => {
      const latestLedger = await processEvents(server, config, lastLedger + 1);
      if (latestLedger > lastLedger) {
        await updateLastIndexedLedger(latestLedger);
        lastLedger = latestLedger;
        console.log(`Indexed up to ledger ${lastLedger}`);
        await maybeTakeGovernanceSnapshot(latestLedger);
        await maybeTakeConcentrationSnapshot(latestLedger);
      }
    })();
    currentBatchPromise = batchPromise.catch((err) => {
      console.error("Batch processing error:", err);
    });
    await currentBatchPromise;
  }

  // Run the first poll immediately, then schedule subsequent ones.
  await pollOnce();

  pollingInterval = setInterval(() => {
    currentBatchPromise = pollOnce().catch((err) => {
      console.error("Poll error:", err);
    });
  }, POLL_INTERVAL_MS);
}

async function main(): Promise<void> {
  await initDb();
  console.log("Database initialized");

  // Start REST API + WebSocket server
  const rpcServer = new SorobanRpc.Server(RPC_URL, { allowHttp: false });
  const app = createApp(rpcServer);
  const httpServer = createServer(app);
  createWsServer(httpServer);
  httpServer.listen(PORT, () => {
    console.log(`NebGov indexer API running on port ${PORT}`);
    console.log(`WebSocket endpoint: ws://localhost:${PORT}/events`);
  });

  // Start indexer loop
  runIndexer().catch((err) => {
    console.error("Indexer fatal error:", err);
    process.exit(1);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
