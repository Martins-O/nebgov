import {
  BASE_FEE,
  Contract,
  Keypair,
  SorobanRpc,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
  type xdr,
} from "@stellar/stellar-sdk";
import { getNetworkPassphrase, getRpcUrl } from "./network";
import type { Network } from "./types";

/** Error codes mirror `TreasuryStreamsError` in `contracts/treasury-streams/src/error.rs`. */
export enum TreasuryStreamsErrorCode {
  AlreadyInitialized = 1,
  NotInitialized = 2,
  NotAuthorized = 3,
  InvalidAmount = 4,
  InvalidInterval = 5,
  InvalidSchedule = 6,
  StreamNotFound = 7,
  StreamCancelled = 8,
  StreamPaused = 9,
  AlreadyPaused = 10,
  NotPaused = 11,
  StreamNotDue = 12,
  InsufficientBalance = 13,
  ArithmeticOverflow = 14,
  StreamCompleted = 15,
  SimulationFailed = 100,
  TransactionFailed = 101,
  TransactionTimeout = 102,
}

const TREASURY_STREAMS_MESSAGES: Partial<Record<TreasuryStreamsErrorCode, string>> = {
  [TreasuryStreamsErrorCode.AlreadyInitialized]: "Treasury streams contract is already initialized",
  [TreasuryStreamsErrorCode.NotInitialized]: "Treasury streams contract is not initialized",
  [TreasuryStreamsErrorCode.NotAuthorized]: "Caller is not authorized to manage this stream",
  [TreasuryStreamsErrorCode.InvalidAmount]: "Amount per interval must be positive",
  [TreasuryStreamsErrorCode.InvalidInterval]: "Interval must be at least one ledger",
  [TreasuryStreamsErrorCode.InvalidSchedule]: "End ledger must be after the start ledger and in the future",
  [TreasuryStreamsErrorCode.StreamNotFound]: "No stream exists with this id",
  [TreasuryStreamsErrorCode.StreamCancelled]: "Stream has been cancelled",
  [TreasuryStreamsErrorCode.StreamPaused]: "Stream is paused",
  [TreasuryStreamsErrorCode.AlreadyPaused]: "Stream is already paused",
  [TreasuryStreamsErrorCode.NotPaused]: "Stream is not paused",
  [TreasuryStreamsErrorCode.StreamNotDue]: "No interval has come due on this stream yet",
  [TreasuryStreamsErrorCode.InsufficientBalance]: "The streams contract does not hold enough of the asset",
  [TreasuryStreamsErrorCode.ArithmeticOverflow]: "Arithmetic overflow in stream accounting",
  [TreasuryStreamsErrorCode.StreamCompleted]: "Stream has paid its last interval and is finished",
};

export class TreasuryStreamsError extends Error {
  readonly name = "TreasuryStreamsError";

  constructor(
    public readonly code: TreasuryStreamsErrorCode,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    Object.setPrototypeOf(this, TreasuryStreamsError.prototype);
  }
}

/** A recurring payment as stored on-chain. Amounts are base units. */
export interface TreasuryStream {
  id: number;
  recipient: string;
  asset: string;
  amountPerInterval: bigint;
  intervalLedgers: number;
  startLedger: number;
  endLedger: number;
  lastStreamedLedger: number;
  totalStreamed: bigint;
  paused: boolean;
  cancelled: boolean;
  /** Set once the stream has paid its last whole interval; it pays nothing more. */
  completed: boolean;
  createdBy: string;
}

export interface TreasuryStreamsConfig {
  /** Contract address of the treasury-streams contract */
  treasuryStreamsAddress: string;
  /** Stellar network to connect to */
  network: Network;
  /** RPC URL override (optional) */
  rpcUrl?: string;
  /** Funded classic account used as the source of read-only simulations. */
  simulationAccount?: string;
}

const POLL_ATTEMPTS = 30;
const POLL_INTERVAL_MS = 1_000;

export function mapTreasuryStream(raw: any): TreasuryStream {
  return {
    id: Number(raw.id),
    recipient: raw.recipient,
    asset: raw.asset,
    amountPerInterval: BigInt(raw.amount_per_interval ?? 0),
    intervalLedgers: Number(raw.interval_ledgers),
    startLedger: Number(raw.start_ledger),
    endLedger: Number(raw.end_ledger),
    lastStreamedLedger: Number(raw.last_streamed_ledger),
    totalStreamed: BigInt(raw.total_streamed ?? 0),
    paused: Boolean(raw.paused),
    cancelled: Boolean(raw.cancelled),
    completed: Boolean(raw.completed),
    createdBy: raw.created_by,
  };
}

/** Maps a contract error number from a failed simulation or submission to a typed error. */
export function parseTreasuryStreamsError(message: string, cause?: unknown): TreasuryStreamsError {
  const match = /Error\(Contract, #(\d+)\)/.exec(message);
  if (match) {
    const code = Number(match[1]) as TreasuryStreamsErrorCode;
    return new TreasuryStreamsError(
      code,
      TREASURY_STREAMS_MESSAGES[code] ?? `Treasury streams contract error #${code}`,
      cause,
    );
  }
  return new TreasuryStreamsError(
    TreasuryStreamsErrorCode.SimulationFailed,
    `Treasury streams call failed: ${message}`,
    cause,
  );
}

/**
 * TreasuryStreamsClient — recurring treasury payments created and cancelled by
 * governance (`contracts/treasury-streams`).
 *
 * `create_stream` is governor-only, so it is normally submitted by a governance
 * proposal rather than by an SDK consumer. The write methods here cover
 * permissionless execution, plus pause, resume and cancel for the treasury or
 * the stream's creator.
 *
 * @example
 * ```ts
 * const streams = new TreasuryStreamsClient({
 *   treasuryStreamsAddress: "CABC...",
 *   network: "testnet",
 * });
 *
 * const due = await streams.getClaimableAmount(1);
 * if (due > 0n) await streams.executeStream(executorKeypair, 1);
 * ```
 */
export class TreasuryStreamsClient {
  private readonly server: SorobanRpc.Server;
  private readonly contract: Contract;
  private readonly passphrase: string;

  constructor(private readonly config: TreasuryStreamsConfig) {
    this.server = new SorobanRpc.Server(getRpcUrl(config.network, config.rpcUrl), {
      allowHttp: false,
    });
    this.contract = new Contract(config.treasuryStreamsAddress);
    this.passphrase = getNetworkPassphrase(config.network);
  }

  /** Create a stream. Requires the governor to sign, so it returns the new stream id. */
  async createStream(
    requester: Keypair,
    recipient: string,
    asset: string,
    amountPerInterval: bigint,
    intervalLedgers: number,
    startLedger: number,
    endLedger: number,
  ): Promise<number> {
    const result = await this.submit(
      requester,
      "create_stream",
      nativeToScVal(requester.publicKey(), { type: "address" }),
      nativeToScVal(recipient, { type: "address" }),
      nativeToScVal(asset, { type: "address" }),
      nativeToScVal(amountPerInterval, { type: "i128" }),
      nativeToScVal(intervalLedgers, { type: "u32" }),
      nativeToScVal(startLedger, { type: "u32" }),
      nativeToScVal(endLedger, { type: "u32" }),
    );
    return Number(scValToNative(result.returnValue!));
  }

  /** Pay every whole interval that has come due. Permissionless. Returns the tx hash. */
  async executeStream(executor: Keypair, streamId: number): Promise<string> {
    return (await this.submit(
      executor,
      "execute_stream",
      nativeToScVal(streamId, { type: "u64" }),
    )).hash;
  }

  /** Pause a stream. Callable by the treasury or the stream's creator. */
  async pauseStream(requester: Keypair, streamId: number): Promise<string> {
    return (await this.submit(
      requester,
      "pause_stream",
      nativeToScVal(requester.publicKey(), { type: "address" }),
      nativeToScVal(streamId, { type: "u64" }),
    )).hash;
  }

  /** Resume a paused stream. Callable by the treasury or the stream's creator. */
  async resumeStream(requester: Keypair, streamId: number): Promise<string> {
    return (await this.submit(
      requester,
      "resume_stream",
      nativeToScVal(requester.publicKey(), { type: "address" }),
      nativeToScVal(streamId, { type: "u64" }),
    )).hash;
  }

  /** Cancel a stream permanently. Execute any due intervals first, since they are forfeited. */
  async cancelStream(requester: Keypair, streamId: number): Promise<string> {
    return (await this.submit(
      requester,
      "cancel_stream",
      nativeToScVal(requester.publicKey(), { type: "address" }),
      nativeToScVal(streamId, { type: "u64" }),
    )).hash;
  }

  async getStream(streamId: number): Promise<TreasuryStream> {
    const raw = await this.simulate("get_stream", nativeToScVal(streamId, { type: "u64" }));
    return mapTreasuryStream(raw);
  }

  /** Amount that `executeStream` would pay right now, or 0n if nothing is due. */
  async getClaimableAmount(streamId: number): Promise<bigint> {
    const raw = await this.simulate(
      "get_claimable_amount",
      nativeToScVal(streamId, { type: "u64" }),
    );
    return BigInt(raw as bigint | number | string);
  }

  /** One page of streams that have not been cancelled, in creation order. */
  async getActiveStreams(offset = 0, limit = 50): Promise<TreasuryStream[]> {
    const raw = await this.simulate(
      "get_active_streams",
      nativeToScVal(offset, { type: "u32" }),
      nativeToScVal(limit, { type: "u32" }),
    );
    return (raw as any[]).map(mapTreasuryStream);
  }

  /** One page of every stream created for `recipient`, including cancelled ones. */
  async getStreamsForRecipient(
    recipient: string,
    offset = 0,
    limit = 50,
  ): Promise<TreasuryStream[]> {
    const raw = await this.simulate(
      "get_streams_for_recipient",
      nativeToScVal(recipient, { type: "address" }),
      nativeToScVal(offset, { type: "u32" }),
      nativeToScVal(limit, { type: "u32" }),
    );
    return (raw as any[]).map(mapTreasuryStream);
  }

  private readAccount(): string {
    return this.config.simulationAccount ?? this.config.treasuryStreamsAddress;
  }

  private async simulate(fnName: string, ...args: xdr.ScVal[]): Promise<unknown> {
    const account = await this.server.getAccount(this.readAccount());
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.passphrase,
    })
      .addOperation(this.contract.call(fnName, ...args))
      .setTimeout(30)
      .build();

    const result = await this.server.simulateTransaction(tx);
    if (SorobanRpc.Api.isSimulationError(result)) {
      throw parseTreasuryStreamsError(result.error);
    }
    const retval = (result as SorobanRpc.Api.SimulateTransactionSuccessResponse).result?.retval;
    if (!retval) {
      throw new TreasuryStreamsError(
        TreasuryStreamsErrorCode.SimulationFailed,
        `No return value from ${fnName}`,
      );
    }
    return scValToNative(retval);
  }

  private async submit(
    signer: Keypair,
    fnName: string,
    ...args: xdr.ScVal[]
  ): Promise<{ hash: string; returnValue?: xdr.ScVal }> {
    const account = await this.server.getAccount(signer.publicKey());
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.passphrase,
    })
      .addOperation(this.contract.call(fnName, ...args))
      .setTimeout(30)
      .build();

    const prepared = await this.server.prepareTransaction(tx);
    prepared.sign(signer);

    const sent = await this.server.sendTransaction(prepared);
    if (sent.status === "ERROR") {
      throw parseTreasuryStreamsError(JSON.stringify(sent.errorResult ?? sent), sent);
    }

    for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
      const status = await this.server.getTransaction(sent.hash);
      if (status.status === "SUCCESS") {
        return {
          hash: sent.hash,
          returnValue: (status as SorobanRpc.Api.GetSuccessfulTransactionResponse).returnValue,
        };
      }
      if (status.status === "FAILED") {
        throw new TreasuryStreamsError(
          TreasuryStreamsErrorCode.TransactionFailed,
          `${fnName} transaction ${sent.hash} failed`,
          status,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    throw new TreasuryStreamsError(
      TreasuryStreamsErrorCode.TransactionTimeout,
      `${fnName} transaction ${sent.hash} was not confirmed in time`,
    );
  }
}
