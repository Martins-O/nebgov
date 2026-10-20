/**
 * Mock replica of `contracts/treasury/src/streams.rs`'s budget-stream module:
 * `create_stream`, `stream_spend`, `top_up_stream` plus the read paths the
 * SDK exposes (`get_stream`, `get_streams`, `get_stream_spends`,
 * `get_stream_report`, `get_stream_remaining`, `get_budget_summary`).
 *
 * Scope reductions (mirroring `token-votes-executor`'s): there is no separate
 * SEP-41 token contract, so a spend debits the treasury contract's balance and
 * credits the recipient on the one ledger the harness models —
 * `store.votes.balances`. The stream's `token` field is stored verbatim for
 * reporting but only ever moves that ledger. Spending caps, multi-sig
 * treasury transactions, `revoke_stream`, `extend_stream` and
 * `stream_batch_spend` are out of scope — calling them reports an unknown
 * treasury function.
 *
 * Failures mirror the contract: `panic_with_error(TreasuryError::..)` becomes
 * `MockContractError` with the contract's own code, while Rust `assert!`/
 * `require_auth()` panics surface as plain errors with their message.
 */
import { LedgerClock } from "../ledger";
import { BudgetStreamRecord, MockLedgerStore, StreamSpendRecord } from "./store";
import { MockContractError } from "./errors";

/** `require_auth()` — the transaction source must be the declared signer. */
function requireSigner(caller: string, signer: string): void {
  if (caller !== signer) throw new Error("not authorized");
}

/** `require_governor` — `assert!(caller == governor, "not authorized")`. */
function requireGovernor(store: MockLedgerStore, caller: string): void {
  if (caller !== store.treasury.governor) {
    throw new Error("not authorized");
  }
}

function loadStream(store: MockLedgerStore, streamId: bigint): BudgetStreamRecord {
  const stream = store.treasury.streams.get(streamId);
  if (!stream) throw new MockContractError(10, `stream ${streamId} not found`);
  return stream;
}

function addToTotal(map: Map<string, bigint>, token: string, amount: bigint): void {
  map.set(token, (map.get(token) ?? 0n) + amount);
}

/** `stream_spend`'s pre-transfer validation block, in the contract's order. */
function validateSpend(
  store: MockLedgerStore,
  clock: LedgerClock,
  stream: BudgetStreamRecord,
  owner: string,
  amount: bigint,
): void {
  if (stream.isRevoked) throw new MockContractError(13, "stream has been revoked");
  if (!stream.isActive) throw new MockContractError(11, "stream is not active");
  if (owner !== stream.owner) {
    throw new MockContractError(17, "caller is not the authorized stream owner");
  }
  const currentLedger = clock.sequence;
  if (currentLedger < stream.startLedger || currentLedger > stream.endLedger) {
    throw new MockContractError(12, "stream has expired");
  }
  if (amount <= 0n) throw new Error("amount must be positive");
  if (amount > stream.maxSingleSpend) {
    throw new MockContractError(15, "spend exceeds the maximum single spend");
  }
  if (amount > stream.totalAllocated - stream.totalSpent) {
    throw new MockContractError(14, "stream has no remaining funds");
  }
  if (stream.cooldownLedgers > 0 && stream.spendCount > 0) {
    if (currentLedger - stream.lastSpendLedger < stream.cooldownLedgers) {
      throw new MockContractError(16, "cooldown period between spends has not elapsed");
    }
  }
}

/** The single token ledger: debit the treasury, credit the recipient. */
function transferFromTreasury(store: MockLedgerStore, recipient: string, amount: bigint): void {
  const treasuryAccount = store.addresses.treasury;
  const treasuryBalance = store.votes.balances.get(treasuryAccount) ?? 0n;
  if (treasuryBalance < amount) {
    throw new MockContractError(18, "treasury has insufficient balance");
  }
  store.votes.balances.set(treasuryAccount, treasuryBalance - amount);
  store.votes.balances.set(recipient, (store.votes.balances.get(recipient) ?? 0n) + amount);
}

/** Derived result of `get_stream_report` (mirrors `StreamBudgetReport`). */
export interface StreamBudgetReportRecord {
  streamId: bigint;
  name: string;
  totalAllocated: bigint;
  totalSpent: bigint;
  remaining: bigint;
  utilizationBps: number;
  isActive: boolean;
  daysRemaining: number;
  spendCount: number;
  avgSpend: bigint;
}

/** Derived result of `get_budget_summary` (mirrors `TreasuryBudgetSummary`). */
export interface TreasuryBudgetSummaryRecord {
  totalStreams: number;
  activeStreams: number;
  totalAllocatedByToken: Array<[string, bigint]>;
  totalSpentByToken: Array<[string, bigint]>;
  totalRemainingByToken: Array<[string, bigint]>;
}

export const treasuryExecutor = {
  create_stream(store: MockLedgerStore, clock: LedgerClock, caller: string, args: unknown[]): bigint {
    const [signer, name, owner, token, totalAllocated, startLedger, endLedger, maxSingleSpend, cooldownLedgers, proposalId] =
      args as [string, string, string, string, bigint, number, number, bigint, number, bigint];
    requireSigner(caller, signer);
    requireGovernor(store, signer);
    if (totalAllocated <= 0n) throw new Error("allocation must be positive");
    if (maxSingleSpend <= 0n) throw new Error("max single spend must be positive");
    if (endLedger <= startLedger) throw new MockContractError(20, "stream end ledger is before start ledger");
    if (endLedger <= clock.sequence) throw new MockContractError(12, "stream has expired");

    const id = store.treasury.streamCount + 1n;
    const stream: BudgetStreamRecord = {
      id,
      name,
      owner,
      token,
      totalAllocated,
      totalSpent: 0n,
      startLedger,
      endLedger,
      isActive: true,
      isRevoked: false,
      revokedAtLedger: null,
      maxSingleSpend,
      cooldownLedgers,
      lastSpendLedger: 0,
      spendCount: 0,
      createdByProposalId: proposalId,
    };
    store.treasury.streams.set(id, stream);
    store.treasury.streamCount = id;
    if (!store.treasury.tokenList.includes(token)) store.treasury.tokenList.push(token);
    addToTotal(store.treasury.totalStreamedByToken, token, totalAllocated);
    return id;
  },

  stream_spend(store: MockLedgerStore, clock: LedgerClock, caller: string, args: unknown[]): null {
    const [owner, streamId, recipient, amount, memo] = args as [string, bigint, string, bigint, string];
    requireSigner(caller, owner);
    const stream = loadStream(store, streamId);
    validateSpend(store, clock, stream, owner, amount);

    transferFromTreasury(store, recipient, amount);
    stream.totalSpent += amount;
    stream.lastSpendLedger = clock.sequence;
    stream.spendCount += 1;

    const records = store.treasury.spends.get(streamId) ?? [];
    const record: StreamSpendRecord = {
      streamId,
      spendIndex: records.length,
      recipient,
      amount,
      memo,
      executedAtLedger: clock.sequence,
      executedBy: owner,
    };
    store.treasury.spends.set(streamId, [...records, record]);
    addToTotal(store.treasury.totalSpentByToken, stream.token, amount);

    if (stream.totalAllocated - stream.totalSpent === 0n) {
      stream.isActive = false;
    }
    return null;
  },

  top_up_stream(store: MockLedgerStore, clock: LedgerClock, caller: string, args: unknown[]): null {
    const [signer, streamId, additionalAmount] = args as [string, bigint, bigint];
    requireSigner(caller, signer);
    requireGovernor(store, signer);
    if (additionalAmount <= 0n) throw new Error("additional must be positive");

    const stream = loadStream(store, streamId);
    if (stream.isRevoked) throw new MockContractError(13, "stream has been revoked");

    stream.totalAllocated += additionalAmount;
    // Reactivate a stream that only stopped because its budget ran out.
    if (!stream.isActive && !stream.isRevoked && clock.sequence <= stream.endLedger) {
      stream.isActive = true;
    }
    addToTotal(store.treasury.totalStreamedByToken, stream.token, additionalAmount);
    return null;
  },

  get_stream(store: MockLedgerStore, _clock: LedgerClock, _caller: string, args: unknown[]): BudgetStreamRecord {
    const [streamId] = args as [bigint];
    return loadStream(store, streamId);
  },

  get_streams(store: MockLedgerStore, _clock: LedgerClock, _caller: string, args: unknown[]): BudgetStreamRecord[] {
    const [offset, limit] = args as [bigint, bigint];
    const count = Number(store.treasury.streamCount);
    const start = Math.min(Number(offset), count);
    const end = Math.min(start + Number(limit), count);
    const streams: BudgetStreamRecord[] = [];
    for (let id = start + 1; id <= end; id++) {
      streams.push(loadStream(store, BigInt(id)));
    }
    return streams;
  },

  get_stream_spends(store: MockLedgerStore, _clock: LedgerClock, _caller: string, args: unknown[]): StreamSpendRecord[] {
    const [streamId, offset, limit] = args as [bigint, number, number];
    const records = store.treasury.spends.get(streamId) ?? [];
    return records.slice(offset, offset + limit);
  },

  get_stream_remaining(store: MockLedgerStore, _clock: LedgerClock, _caller: string, args: unknown[]): bigint {
    const [streamId] = args as [bigint];
    const stream = loadStream(store, streamId);
    return stream.totalAllocated - stream.totalSpent;
  },

  get_stream_report(store: MockLedgerStore, clock: LedgerClock, _caller: string, args: unknown[]): StreamBudgetReportRecord {
    const [streamId] = args as [bigint];
    const stream = loadStream(store, streamId);
    const remaining = stream.totalAllocated - stream.totalSpent;
    const utilizationBps =
      stream.totalAllocated > 0n ? Number((stream.totalSpent * 10_000n) / stream.totalAllocated) : 0;
    const naturallyExpired = clock.sequence > stream.endLedger;
    const daysRemaining =
      stream.isRevoked || naturallyExpired || clock.sequence < stream.startLedger
        ? 0
        : Math.floor((stream.endLedger - clock.sequence) / 17_280);
    return {
      streamId,
      name: stream.name,
      totalAllocated: stream.totalAllocated,
      totalSpent: stream.totalSpent,
      remaining,
      utilizationBps,
      isActive: stream.isActive && !stream.isRevoked && !naturallyExpired,
      daysRemaining,
      spendCount: stream.spendCount,
      avgSpend: stream.spendCount > 0 ? stream.totalSpent / BigInt(stream.spendCount) : 0n,
    };
  },

  get_budget_summary(store: MockLedgerStore, clock: LedgerClock, _caller: string, _args: unknown[]): TreasuryBudgetSummaryRecord {
    const streams = [...store.treasury.streams.values()];
    const activeStreams = streams.filter(
      (stream) => stream.isActive && !stream.isRevoked && clock.sequence <= stream.endLedger,
    ).length;
    const pair = (map: Map<string, bigint>): Array<[string, bigint]> =>
      store.treasury.tokenList.map((token): [string, bigint] => [token, map.get(token) ?? 0n]);
    const remaining = (token: string): bigint =>
      (store.treasury.totalStreamedByToken.get(token) ?? 0n) - (store.treasury.totalSpentByToken.get(token) ?? 0n);
    return {
      totalStreams: streams.length,
      activeStreams,
      totalAllocatedByToken: pair(store.treasury.totalStreamedByToken),
      totalSpentByToken: pair(store.treasury.totalSpentByToken),
      totalRemainingByToken: store.treasury.tokenList.map(
        (token): [string, bigint] => [token, remaining(token)],
      ),
    };
  },
};

export type TreasuryFunction = keyof typeof treasuryExecutor;
