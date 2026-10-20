/**
 * Mock replica of `contracts/conviction-voting/src/lib.rs`'s self-executing
 * track: proposals accumulate a time-weighted conviction score from staked
 * voting power, and `checkpoint_conviction` executes the proposal the moment
 * that score clears the dynamic threshold.
 *
 * Voting power is read straight out of the shared `TokenVotesState`
 * (`get_votes` for the stake bound, `get_past_total_supply` for the dynamic
 * threshold), exactly like the on-chain `VotesTrait` wiring. Staking is
 * non-custodial: no tokens move, only a per-staker commitment pointer.
 *
 * Simplification: `checkpoint_conviction`'s target invocation is recorded in
 * `store.convictionVoting.executions` rather than dispatched — the harness has
 * no general-purpose cross-contract dispatcher (same scope boundary the
 * timelock executor documents for `execute()`). Error codes 1–11 mirror
 * `ConvictionVotingError` so `@nebgov/sdk`'s `parseConvictionVotingError`
 * recovers the typed error a real deployment would produce.
 */
import { LedgerClock } from "../ledger";
import {
  ConvictionProposalRecord,
  ConvictionVotingState,
  MockLedgerStore,
} from "./store";
import { MockContractError } from "./errors";
import { tokenVotesExecutor } from "./token-votes-executor";

const BPS = 10_000n;
const I128_MAX = (1n << 127n) - 1n;

/** Mirrors `ConvictionVotingError` (`contracts/conviction-voting/src/error.rs`). */
export const ConvictionVotingContractError = {
  AlreadyInitialized: 1,
  NotInitialized: 2,
  InvalidConfiguration: 3,
  InvalidAmount: 4,
  ProposalNotFound: 5,
  ProposalClosed: 6,
  InsufficientVotingPower: 7,
  StakeNotFound: 8,
  Unauthorized: 9,
  ArithmeticOverflow: 10,
  InvalidCalldata: 11,
} as const;

/**
 * `base^exponent` in basis-point fixed point, via exponentiation by squaring
 * — an exact replica of the contract's `pow_bps` (integer division
 * truncates toward zero at every step, matching Soroban's i128 semantics for
 * the non-negative values this function ever sees).
 */
export function powBps(base: number, exponent: number): bigint {
  let result = BPS;
  let b = BigInt(base);
  let e = exponent;
  while (e > 0) {
    if (e & 1) result = (result * b) / BPS;
    e >>= 1;
    if (e > 0) b = (b * b) / BPS;
  }
  return result;
}

/**
 * One step of the contract's conviction accrual, exported so scenarios can
 * compute the exact score a checkpoint must produce:
 * `retained = conviction * decay / BPS`, `accrued = steady * (BPS - decay) / BPS`
 * where `steady = totalStaked * weightBps / (BPS - decayBps)`.
 */
export function projectConviction(
  conviction: bigint,
  totalStaked: bigint,
  elapsed: number,
  config: { decayBps: number; weightBps: number },
): bigint {
  const decay = powBps(config.decayBps, elapsed);
  // Mirrors the contract's `(BPS - decay_bps).max(1)` denominator clamp.
  const decayGap = BPS - BigInt(config.decayBps);
  const steady = (totalStaked * BigInt(config.weightBps)) / (decayGap > 0n ? decayGap : 1n);
  const retained = (conviction * decay) / BPS;
  const accrued = (steady * (BPS - decay)) / BPS;
  return retained + accrued;
}

function mustGetProposal(store: MockLedgerStore, id: bigint): ConvictionProposalRecord {
  const proposal = store.convictionVoting.proposals.get(id);
  if (!proposal) {
    throw new MockContractError(ConvictionVotingContractError.ProposalNotFound, `proposal ${id} not found`);
  }
  return proposal;
}

function mustGetOpenProposal(store: MockLedgerStore, id: bigint): ConvictionProposalRecord {
  const proposal = mustGetProposal(store, id);
  if (proposal.executed || proposal.cancelled) {
    throw new MockContractError(ConvictionVotingContractError.ProposalClosed, `proposal ${id} is closed`);
  }
  return proposal;
}

function totalStaked(state: ConvictionVotingState, proposalId: bigint): bigint {
  return state.totalStaked.get(proposalId) ?? 0n;
}

function stakesFor(state: ConvictionVotingState, proposalId: bigint): Map<string, bigint> {
  let stakes = state.stakes.get(proposalId);
  if (!stakes) {
    stakes = new Map();
    state.stakes.set(proposalId, stakes);
  }
  return stakes;
}

function updateConviction(store: MockLedgerStore, clock: LedgerClock, proposal: ConvictionProposalRecord): void {
  const elapsed = clock.sequence - proposal.lastUpdatedLedger;
  if (elapsed <= 0 || proposal.executed || proposal.cancelled) {
    return;
  }
  const state = store.convictionVoting;
  proposal.conviction = projectConviction(proposal.conviction, totalStaked(state, proposal.id), elapsed, state);
  proposal.lastUpdatedLedger = clock.sequence;
  state.proposals.set(proposal.id, proposal);
}

function removeStake(state: ConvictionVotingState, staker: string, proposalId: bigint): void {
  const stakes = stakesFor(state, proposalId);
  const amount = stakes.get(staker);
  if (amount !== undefined) {
    stakes.delete(staker);
    state.totalStaked.set(proposalId, (state.totalStaked.get(proposalId) ?? 0n) - amount);
  }
  state.stakeByStaker.delete(staker);
}

function requiredThreshold(store: MockLedgerStore, clock: LedgerClock, requestedAmount: bigint): bigint {
  const state = store.convictionVoting;
  if (requestedAmount < 0n) {
    throw new MockContractError(ConvictionVotingContractError.InvalidAmount, "threshold: negative amount");
  }
  if (requestedAmount === 0n) {
    return state.minThresholdConviction;
  }
  const supply = tokenVotesExecutor.get_past_total_supply(store.votes, clock, "", [clock.sequence]);
  if (supply <= 0n) {
    return I128_MAX;
  }
  const maxRatio = BigInt(state.maxRatioBps);
  const ratio = (requestedAmount * BPS) / supply;
  if (ratio >= maxRatio) {
    return I128_MAX;
  }
  const gap = maxRatio - ratio;
  return (state.minThresholdConviction * maxRatio * maxRatio) / (gap * gap);
}

export const convictionVotingExecutor = {
  create_proposal(store: MockLedgerStore, clock: LedgerClock, caller: string, args: unknown[]): bigint {
    const [proposer, target, fnName, calldata, requestedAmount] = args as [
      string,
      string,
      string,
      Uint8Array,
      bigint,
    ];
    if (caller !== proposer) {
      throw new MockContractError(100, "create_proposal: proposer must authorize this call");
    }
    if (requestedAmount < 0n) {
      throw new MockContractError(ConvictionVotingContractError.InvalidAmount, "create_proposal: negative amount");
    }

    const state = store.convictionVoting;
    const id = state.nextProposalId;
    state.nextProposalId = id + 1n;
    const ledger = clock.sequence;
    state.proposals.set(id, {
      id,
      proposer,
      target,
      fnName,
      calldata: new Uint8Array(calldata),
      requestedAmount,
      createdLedger: ledger,
      conviction: 0n,
      lastUpdatedLedger: ledger,
      executed: false,
      cancelled: false,
    });
    state.stakes.set(id, new Map());
    state.totalStaked.set(id, 0n);
    return id;
  },

  stake(store: MockLedgerStore, clock: LedgerClock, caller: string, args: unknown[]): null {
    const [staker, proposalId, amount] = args as [string, bigint, bigint];
    if (caller !== staker) {
      throw new MockContractError(100, "stake: staker must authorize this call");
    }
    if (amount <= 0n) {
      throw new MockContractError(ConvictionVotingContractError.InvalidAmount, "stake: amount must be positive");
    }
    const votes = tokenVotesExecutor.get_votes(store.votes, clock, "", [staker]);
    if (votes < amount) {
      throw new MockContractError(
        ConvictionVotingContractError.InsufficientVotingPower,
        "stake: insufficient voting power",
      );
    }

    const state = store.convictionVoting;
    const target = mustGetOpenProposal(store, proposalId);
    updateConviction(store, clock, target);

    const oldId = state.stakeByStaker.get(staker);
    if (oldId !== undefined && oldId !== proposalId) {
      const old = mustGetProposal(store, oldId);
      updateConviction(store, clock, old);
      removeStake(state, staker, oldId);
    }

    const stakes = stakesFor(state, proposalId);
    const delta = amount - (stakes.get(staker) ?? 0n);
    stakes.set(staker, amount);
    state.totalStaked.set(proposalId, totalStaked(state, proposalId) + delta);
    state.stakeByStaker.set(staker, proposalId);
    return null;
  },

  withdraw_stake(store: MockLedgerStore, clock: LedgerClock, caller: string, args: unknown[]): null {
    const [staker] = args as [string];
    if (caller !== staker) {
      throw new MockContractError(100, "withdraw_stake: staker must authorize this call");
    }
    const state = store.convictionVoting;
    const proposalId = state.stakeByStaker.get(staker);
    if (proposalId === undefined) {
      throw new MockContractError(ConvictionVotingContractError.StakeNotFound, "withdraw_stake: no stake found");
    }
    const proposal = mustGetProposal(store, proposalId);
    updateConviction(store, clock, proposal);
    removeStake(state, staker, proposalId);
    return null;
  },

  checkpoint_conviction(store: MockLedgerStore, clock: LedgerClock, _caller: string, args: unknown[]): bigint {
    const [proposalId] = args as [bigint];
    const proposal = mustGetProposal(store, proposalId);
    if (proposal.executed || proposal.cancelled) {
      return proposal.conviction;
    }
    updateConviction(store, clock, proposal);
    if (proposal.conviction >= requiredThreshold(store, clock, proposal.requestedAmount)) {
      proposal.executed = true;
      store.convictionVoting.proposals.set(proposal.id, proposal);
      store.convictionVoting.executions.push({
        proposalId: proposal.id,
        target: proposal.target,
        fnName: proposal.fnName,
        calldata: proposal.calldata,
        ledger: clock.sequence,
      });
    }
    return proposal.conviction;
  },

  get_proposal(store: MockLedgerStore, _clock: LedgerClock, _caller: string, args: unknown[]): ConvictionProposalRecord {
    const [proposalId] = args as [bigint];
    return mustGetProposal(store, proposalId);
  },

  get_stakes(store: MockLedgerStore, _clock: LedgerClock, _caller: string, args: unknown[]) {
    const [proposalId, offset, limit] = args as [bigint, bigint, bigint];
    mustGetProposal(store, proposalId);
    if (limit === 0n) return [];
    const entries = Array.from(stakesFor(store.convictionVoting, proposalId), ([staker, amount]) => ({
      staker,
      proposalId,
      amount,
    }));
    return entries.slice(Number(offset), Number(offset + limit));
  },

  get_required_threshold(store: MockLedgerStore, clock: LedgerClock, _caller: string, args: unknown[]): bigint {
    const [requestedAmount] = args as [bigint];
    return requiredThreshold(store, clock, requestedAmount);
  },
};

export type ConvictionVotingFunction = keyof typeof convictionVotingExecutor;
