import {
  BASE_FEE,
  Contract,
  Keypair,
  Networks,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  type xdr,
} from "@stellar/stellar-sdk";
import pool from "../db/pool";
import { logger } from "../logger";
import { jobHealthTracker } from "./health-tracker";
import { selectExecutableStreams, type StreamSnapshot } from "./treasury-streams-plan";

const JOB_NAME = "treasury-streams-executor";
const PAGE_SIZE = 50;
const DEFAULT_INTERVAL_MS = 60_000;

const NETWORK_PASSPHRASES: Record<string, string> = {
  mainnet: Networks.PUBLIC,
  public: Networks.PUBLIC,
  testnet: Networks.TESTNET,
  futurenet: Networks.FUTURENET,
};

interface RawStream {
  id: number | bigint;
  paused: boolean;
  cancelled: boolean;
  completed?: boolean;
}

function networkPassphrase(): string {
  const key = (process.env.STELLAR_NETWORK ?? "testnet").toLowerCase();
  return NETWORK_PASSPHRASES[key] ?? Networks.TESTNET;
}

function rpcServer(): rpc.Server {
  const url = process.env.STELLAR_RPC_URL ?? "https://soroban-testnet.stellar.org";
  return new rpc.Server(url, { allowHttp: false });
}

function streamsContract(): Contract {
  const address = process.env.TREASURY_STREAMS_CONTRACT_ID;
  if (!address) {
    throw new Error("TREASURY_STREAMS_CONTRACT_ID is not configured");
  }
  return new Contract(address);
}

function getRelayerKeypair(): Keypair {
  const secret = process.env.RELAYER_SECRET_KEY;
  if (!secret) {
    throw new Error("RELAYER_SECRET_KEY is not configured");
  }
  return Keypair.fromSecret(secret);
}

/** Runs a read-only contract call and returns its decoded return value. */
async function view(
  server: rpc.Server,
  contract: Contract,
  fnName: string,
  ...args: xdr.ScVal[]
): Promise<unknown> {
  const relayer = getRelayerKeypair();
  const account = await server.getAccount(relayer.publicKey());
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: networkPassphrase(),
  })
    .addOperation(contract.call(fnName, ...args))
    .setTimeout(30)
    .build();

  const simulated = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(simulated)) {
    throw new Error(`${fnName} simulation failed: ${simulated.error}`);
  }
  const retval = (simulated as rpc.Api.SimulateTransactionSuccessResponse).result?.retval;
  if (!retval) {
    throw new Error(`${fnName} returned no value`);
  }
  return scValToNative(retval);
}

async function fetchActiveStreams(server: rpc.Server, contract: Contract): Promise<RawStream[]> {
  const streams: RawStream[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const page = (await view(
      server,
      contract,
      "get_active_streams",
      nativeToScVal(offset, { type: "u32" }),
      nativeToScVal(PAGE_SIZE, { type: "u32" }),
    )) as RawStream[];
    streams.push(...page);
    if (page.length < PAGE_SIZE) {
      return streams;
    }
  }
}

async function executeOnChain(streamId: number): Promise<string> {
  const server = rpcServer();
  const relayer = getRelayerKeypair();
  const account = await server.getAccount(relayer.publicKey());
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: networkPassphrase(),
  })
    .addOperation(
      streamsContract().call("execute_stream", nativeToScVal(streamId, { type: "u64" })),
    )
    .setTimeout(30)
    .build();

  const prepared = await server.prepareTransaction(tx);
  prepared.sign(relayer);
  const sent = await server.sendTransaction(prepared);
  if (sent.status === "ERROR") {
    throw new Error(`execute_stream submission failed: ${JSON.stringify(sent.errorResult ?? sent)}`);
  }
  return sent.hash;
}

async function loadOpenFailureIds(): Promise<Set<number>> {
  const { rows } = await pool.query(
    `SELECT DISTINCT stream_id FROM treasury_stream_failures WHERE cleared_at IS NULL`,
  );
  return new Set(rows.map((row) => Number(row.stream_id)));
}

/** Records a failed attempt, bumping the count if the stream already has an open failure. */
async function recordFailure(streamId: number, ledger: number, message: string): Promise<void> {
  const updated = await pool.query(
    `UPDATE treasury_stream_failures
     SET attempt_count = attempt_count + 1, last_failure_at = NOW(),
         failed_at_ledger = $2, error_message = $3
     WHERE stream_id = $1 AND cleared_at IS NULL`,
    [streamId, ledger, message],
  );
  if (updated.rowCount === 0) {
    await pool.query(
      `INSERT INTO treasury_stream_failures (stream_id, failed_at_ledger, error_message)
       VALUES ($1, $2, $3)`,
      [streamId, ledger, message],
    );
  }
}

/**
 * Pays due intervals on every live treasury stream. Each tick reads the
 * active streams and their claimable amounts from the contract, then calls
 * `execute_stream` for those with something due. A failed execution is
 * recorded in `treasury_stream_failures`, and that stream is skipped until an
 * operator clears the failure.
 *
 * Set `TREASURY_STREAMS_CONTRACT_ID` to enable the job. It also needs
 * `RELAYER_SECRET_KEY`, the same service account the signal-anchor job uses.
 */
export class TreasuryStreamsExecutor {
  private interval: NodeJS.Timeout | null = null;
  private isProcessing = false;

  start() {
    const intervalMs = Number(process.env.TREASURY_STREAMS_INTERVAL_MS ?? DEFAULT_INTERVAL_MS);
    logger.info({ intervalMs }, "Starting treasury streams executor");
    jobHealthTracker.registerJob(JOB_NAME, intervalMs);
    this.interval = setInterval(() => this.tick(), intervalMs);
    this.tick();
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  private async tick() {
    if (this.isProcessing) return;
    this.isProcessing = true;
    jobHealthTracker.markJobStart(JOB_NAME);
    try {
      await this.executeDueStreams();
      jobHealthTracker.markJobSuccess(JOB_NAME);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error({ err: error }, "Treasury streams tick failed");
      jobHealthTracker.markJobError(JOB_NAME, errorMessage);
    } finally {
      this.isProcessing = false;
    }
  }

  private async executeDueStreams(): Promise<void> {
    const server = rpcServer();
    const contract = streamsContract();
    const { sequence: ledger } = await server.getLatestLedger();
    const failedStreamIds = await loadOpenFailureIds();

    const snapshots: StreamSnapshot[] = [];
    for (const raw of await fetchActiveStreams(server, contract)) {
      // A finished stream has nothing left to pay; don't spend an RPC call on it.
      if (raw.completed) continue;
      const id = Number(raw.id);
      const claimable = await view(
        server,
        contract,
        "get_claimable_amount",
        nativeToScVal(id, { type: "u64" }),
      );
      snapshots.push({
        id,
        paused: raw.paused,
        cancelled: raw.cancelled,
        completed: Boolean(raw.completed),
        claimable: BigInt(claimable as bigint | number | string),
      });
    }

    for (const stream of selectExecutableStreams(snapshots, failedStreamIds)) {
      try {
        const hash = await executeOnChain(stream.id);
        logger.info({ streamId: stream.id, claimable: stream.claimable.toString(), hash }, "Executed treasury stream");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error({ err, streamId: stream.id }, "Failed to execute treasury stream");
        await recordFailure(stream.id, ledger, message);
      }
    }
  }
}

export const treasuryStreamsExecutor = new TreasuryStreamsExecutor();
