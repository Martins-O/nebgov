/**
 * Mock replica of `contracts/governor/src/lib.rs`'s proposal state machine.
 *
 * Bounded scope (see harness plan "deliberate scope reductions"): no
 * proposer-reputation-adjusted threshold, no Reflector-oracle dynamic
 * quorum, `Single` voting strategy only (no `MultiToken`), single-action
 * proposals only (no batch/multi-target `queue`/`execute`).
 */
import { scValToNative, xdr } from "@stellar/stellar-sdk";
import { LedgerClock } from "../ledger";
import { GovernorState, MockLedgerStore, ProposalRecord } from "./store";
import { MockContractError } from "./errors";
import { tokenVotesExecutor } from "./token-votes-executor";
import { cancelOperation, executeOperation, scheduleOperation } from "./timelock-executor";
import { proposalBondsExecutor } from "./proposal-bonds-executor";
import { GovernorErrorCode } from "@nebgov/sdk";

export type ProposalStateName =
  | "Pending"
  | "Active"
  | "Defeated"
  | "Succeeded"
  | "Queued"
  | "Executed"
  | "Cancelled"
  | "Expired";

function isqrt(n: bigint): bigint {
  if (n <= 0n) return 0n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}

function applyVoteType(voteType: GovernorState["settings"]["voteType"], rawWeight: bigint): bigint {
  if (voteType === "Quadratic") return isqrt(rawWeight);
  return rawWeight;
}

export function computeQuorum(store: MockLedgerStore, clock: LedgerClock, proposal: ProposalRecord): bigint {
  const { quorumNumerator } = store.governor.settings;
  if (quorumNumerator === 0) return 0n;
  const supply = tokenVotesExecutor.get_past_total_supply(store.votes, clock, "", [proposal.startLedger]);
  return (supply * BigInt(quorumNumerator)) / 100n;
}

export function computeProposalState(store: MockLedgerStore, clock: LedgerClock, proposal: ProposalRecord): ProposalStateName {
  if (proposal.cancelled) return "Cancelled";
  if (proposal.executed) return "Executed";
  if (proposal.queued) return "Queued";

  const current = clock.sequence;
  if (current < proposal.startLedger) return "Pending";
  if (current <= proposal.endLedger) return "Active";

  const quorumReq = computeQuorum(store, clock, proposal);
  const quorumMet = proposal.votesFor + proposal.votesAbstain >= quorumReq;
  const forWins = proposal.votesFor > proposal.votesAgainst;

  if (quorumMet && forWins) {
    const graceEnd = proposal.endLedger + store.governor.settings.proposalGracePeriod;
    if (current > graceEnd) return "Expired";
    return "Succeeded";
  }
  return "Defeated";
}

function createProposal(
  store: MockLedgerStore,
  clock: LedgerClock,
  proposer: string,
  description: string,
  descriptionHash: Uint8Array,
  metadataUri: string,
  targets: string[],
  fnNames: string[],
  calldatas: Uint8Array[],
  checkThreshold: boolean,
): bigint {
  const gov = store.governor;
  if (gov.settings.isPaused) {
    throw new MockContractError(GovernorErrorCode.ContractPaused, "propose: contract is paused");
  }
  if (targets.length !== fnNames.length || targets.length !== calldatas.length) {
    throw new MockContractError(GovernorErrorCode.InvalidVectorLengths, "propose: length mismatch");
  }
  if (targets.length === 0) {
    throw new MockContractError(GovernorErrorCode.NoTargets, "propose: no targets");
  }
  if (calldatas.some((calldata) => calldata.length > gov.settings.maxCalldataSize)) {
    throw new MockContractError(GovernorErrorCode.CalldataTooLarge, "propose: calldata exceeds maximum size");
  }
  if (calldatas.length > 10) {
    throw new MockContractError(GovernorErrorCode.TooManyCalldataEntries, "propose: too many calldata entries");
  }
  if (
    checkThreshold &&
    tokenVotesExecutor.get_votes(store.votes, clock, proposer, [proposer]) < gov.settings.proposalThreshold
  ) {
    throw new MockContractError(GovernorErrorCode.ProposalThresholdNotMet, "propose: proposal threshold not met");
  }

  const current = clock.sequence;
  const lastProposalLedger = gov.lastProposalLedger.get(proposer);
  if (lastProposalLedger !== undefined && current < lastProposalLedger + gov.settings.proposalCooldown) {
    throw new MockContractError(GovernorErrorCode.ProposalRateLimited, "propose: proposer is in cooldown");
  }
  const currentPeriod = Math.floor(current / gov.settings.proposalPeriodDuration);
  const periodKey = `${proposer}:${currentPeriod}`;
  const proposalsInPeriod = gov.proposalsInPeriod.get(periodKey) ?? 0;
  if (proposalsInPeriod >= gov.settings.maxProposalsPerPeriod) {
    throw new MockContractError(GovernorErrorCode.ProposalRateLimited, "propose: max proposals per period reached");
  }

  const id = gov.proposalCount + 1n;
  const proposal: ProposalRecord = {
    id,
    proposer,
    description,
    descriptionHash: Buffer.from(descriptionHash).toString("hex"),
    metadataUri,
    targets,
    fnNames,
    calldatas,
    startLedger: current + gov.settings.votingDelay,
    endLedger: current + gov.settings.votingDelay + gov.settings.votingPeriod,
    votesFor: 0n,
    votesAgainst: 0n,
    votesAbstain: 0n,
    executed: false,
    cancelled: false,
    queued: false,
    opIds: [],
    hasVoted: {},
  };
  gov.proposals.set(id, proposal);
  gov.proposalCount = id;
  gov.lastProposalLedger.set(proposer, current);
  gov.proposalsInPeriod.set(periodKey, proposalsInPeriod + 1);
  return id;
}

function mustGetProposal(store: MockLedgerStore, id: bigint): ProposalRecord {
  const proposal = store.governor.proposals.get(id);
  if (!proposal) throw new MockContractError(GovernorErrorCode.ProposalNotFound, `proposal ${id} not found`);
  return proposal;
}

/**
 * Narrow exception to the timelock executor's "record, don't invoke"
 * simplification: `contracts/proposal-bonds`'s `slash` is only ever
 * reachable as the target of an executed governance proposal (the governor
 * contract must be the caller), so the mock dispatches proposal-bonds
 * targets in-process with the governor itself as the caller, mirroring the
 * real cross-contract invoke. The scheduled action's calldata is the
 * `ScVal` XDR the proposal was queued with (see
 * `ProposalBondsClient.encodeSlashCalldata`). Every other target stays
 * recorded-only.
 */
function dispatchProposalBondsAction(store: MockLedgerStore, clock: LedgerClock, proposal: ProposalRecord): void {
  const opId = proposal.opIds[0];
  const op = opId ? store.timelock.operations.get(opId) : undefined;
  if (!op || op.target !== store.addresses.proposalBonds) return;

  const handler = (proposalBondsExecutor as Record<string, (...a: unknown[]) => unknown>)[op.fnName];
  if (!handler) {
    throw new Error(`execute: unknown proposal-bonds action ${op.fnName}`);
  }
  const args = scValToNative(xdr.ScVal.fromXDR(Buffer.from(op.data))) as unknown[];
  handler(store, clock, store.addresses.governor, args);
}

export const governorExecutor = {
  propose(store: MockLedgerStore, clock: LedgerClock, caller: string, args: unknown[]): bigint {
    const [proposer, description, descriptionHash, metadataUri, targets, fnNames, calldatas] = args as [
      string,
      string,
      Uint8Array,
      string,
      string[],
      string[],
      Uint8Array[],
    ];
    if (caller !== proposer) {
      throw new MockContractError(100, "propose: proposer must authorize this call");
    }
    return createProposal(
      store,
      clock,
      proposer,
      description,
      descriptionHash,
      metadataUri,
      targets,
      fnNames,
      calldatas,
      true,
    );
  },

  propose_via_registry(store: MockLedgerStore, clock: LedgerClock, caller: string, args: unknown[]): bigint {
    const [registry, proposer, description, descriptionHash, metadataUri, targets, fnNames, calldatas] = args as [
      string,
      string,
      string,
      Uint8Array,
      string,
      string[],
      string[],
      Uint8Array[],
    ];
    if (caller !== store.addresses.coSponsorship || registry !== caller) {
      throw new MockContractError(100, "propose_via_registry: unauthorized registry");
    }
    return createProposal(
      store,
      clock,
      proposer,
      description,
      descriptionHash,
      metadataUri,
      targets,
      fnNames,
      calldatas,
      false,
    );
  },

  cast_vote(store: MockLedgerStore, clock: LedgerClock, caller: string, args: unknown[]): null {
    const [voter, proposalId, supportVariant] = args as [string, bigint, string[]];
    if (caller !== voter) {
      throw new MockContractError(100, "cast_vote: voter must authorize this call");
    }

    const gov = store.governor;

    // Check if contract is paused (Issue #885)
    if (gov.settings.isPaused) {
      throw new MockContractError(GovernorErrorCode.ContractPaused, "cast_vote: contract is paused");
    }

    const support = supportVariant[0];
    const proposal = mustGetProposal(store, proposalId);

    if (proposal.hasVoted[voter]) {
      throw new MockContractError(GovernorErrorCode.AlreadyVoted, "cast_vote: already voted");
    }

    const voteType = gov.settings.voteType;
    if (voteType === "Simple" && support === "Abstain") {
      throw new MockContractError(GovernorErrorCode.InvalidSupport, "cast_vote: abstain not allowed for Simple vote type");
    }

    const current = clock.sequence;
    if (proposal.cancelled || proposal.executed || proposal.queued || current < proposal.startLedger || current > proposal.endLedger) {
      throw new MockContractError(GovernorErrorCode.ProposalNotActive, "cast_vote: proposal is not active");
    }

    const rawWeight = tokenVotesExecutor.get_past_votes(store.votes, clock, voter, [voter, proposal.startLedger]);
    const weight = applyVoteType(voteType, rawWeight);

    if (weight > 0n) {
      if (support === "For") proposal.votesFor += weight;
      else if (support === "Against") proposal.votesAgainst += weight;
      else if (support === "Abstain") proposal.votesAbstain += weight;
    }
    proposal.hasVoted[voter] = true;
    return null;
  },

  queue(store: MockLedgerStore, clock: LedgerClock, _caller: string, args: unknown[]): null {
    const [proposalId] = args as [bigint];
    const proposal = mustGetProposal(store, proposalId);
    const state = computeProposalState(store, clock, proposal);

    if (state === "Expired") {
      throw new MockContractError(GovernorErrorCode.ProposalExpired, "queue: proposal expired");
    }
    if (state !== "Succeeded") {
      throw new MockContractError(GovernorErrorCode.ProposalNotSucceeded, "queue: proposal not succeeded");
    }

    const requiredQuorum = computeQuorum(store, clock, proposal);
    const quorumMet = proposal.votesFor + proposal.votesAbstain >= requiredQuorum;
    const forWins = proposal.votesFor > proposal.votesAgainst;
    if (!quorumMet || !forWins) {
      throw new MockContractError(GovernorErrorCode.ProposalNotSucceeded, "queue: quorum/majority not met");
    }

    if (proposal.targets.length === 0) {
      throw new MockContractError(GovernorErrorCode.NoTargets, "queue: no targets");
    }

    const delay = store.timelock.minDelay;
    const opId = scheduleOperation(store.timelock, clock, proposal.targets[0], proposal.calldatas[0], proposal.fnNames[0], delay);

    proposal.opIds = [opId];
    proposal.queued = true;
    store.governor.queueTime.set(proposalId, clock.sequence);
    return null;
  },

  execute(store: MockLedgerStore, clock: LedgerClock, _caller: string, args: unknown[]): null {
    const [proposalId] = args as [bigint];
    const proposal = mustGetProposal(store, proposalId);
    const state = computeProposalState(store, clock, proposal);
    if (state !== "Queued") {
      throw new MockContractError(GovernorErrorCode.ProposalNotQueued, "execute: proposal not queued");
    }
    if (proposal.executed) {
      throw new MockContractError(GovernorErrorCode.ProposalAlreadyExecuted, "execute: already executed");
    }
    if (proposal.opIds.length === 0) {
      throw new MockContractError(GovernorErrorCode.MissingOpIds, "execute: missing op ids");
    }
    executeOperation(store.timelock, clock, proposal.opIds[0]);
    dispatchProposalBondsAction(store, clock, proposal);
    proposal.executed = true;
    return null;
  },

  cancel(store: MockLedgerStore, clock: LedgerClock, caller: string, args: unknown[]): null {
    const [cancelCaller, proposalId] = args as [string, bigint];
    if (caller !== cancelCaller) {
      throw new MockContractError(100, "cancel: caller must authorize this call");
    }
    const proposal = mustGetProposal(store, proposalId);
    const state = computeProposalState(store, clock, proposal);
    const guardian = store.governor.settings.guardian;
    const canCancel =
      (cancelCaller === proposal.proposer && state === "Pending") || (cancelCaller === guardian && state === "Active");
    if (!canCancel) {
      throw new MockContractError(GovernorErrorCode.UnauthorizedCancel, "cancel: unauthorized");
    }
    proposal.cancelled = true;
    return null;
  },

  cancel_queued(store: MockLedgerStore, clock: LedgerClock, caller: string, args: unknown[]): null {
    const [cancelCaller, proposalId] = args as [string, bigint];
    if (caller !== cancelCaller) {
      throw new MockContractError(100, "cancel_queued: caller must authorize this call");
    }
    const proposal = mustGetProposal(store, proposalId);
    if (!proposal.queued || proposal.cancelled) {
      throw new MockContractError(GovernorErrorCode.ProposalNotQueued, "cancel_queued: proposal not queued");
    }
    const guardian = store.governor.settings.guardian;
    if (cancelCaller !== guardian) {
      throw new MockContractError(GovernorErrorCode.UnauthorizedGuardian, "cancel_queued: only guardian may veto");
    }
    const queueTime = store.governor.queueTime.get(proposalId);
    if (queueTime === undefined) {
      throw new MockContractError(GovernorErrorCode.ProposalNotQueued, "cancel_queued: missing queue time");
    }
    const delayLedgers = Math.floor(Number(store.timelock.minDelay) / LedgerClock.SECONDS_PER_LEDGER);
    const vetoWindowEndLedger = queueTime + delayLedgers;
    if (clock.sequence >= vetoWindowEndLedger) {
      throw new MockContractError(GovernorErrorCode.VetoWindowClosed, "cancel_queued: veto window closed");
    }

    proposal.cancelled = true;
    for (const opId of proposal.opIds) {
      cancelOperation(store.timelock, opId);
    }
    return null;
  },

  state(store: MockLedgerStore, clock: LedgerClock, _caller: string, args: unknown[]): ProposalStateName {
    const [proposalId] = args as [bigint];
    const proposal = mustGetProposal(store, proposalId);
    return computeProposalState(store, clock, proposal);
  },

  get_settings(store: MockLedgerStore): GovernorState["settings"] {
    return store.governor.settings;
  },

  get_proposal(store: MockLedgerStore, _clock: LedgerClock, _caller: string, args: unknown[]): ProposalRecord {
    const [proposalId] = args as [bigint];
    return mustGetProposal(store, proposalId);
  },

  get_quorum(store: MockLedgerStore, clock: LedgerClock, _caller: string, args: unknown[]): bigint {
    const [proposalId] = args as [bigint];
    const proposal = mustGetProposal(store, proposalId);
    return computeQuorum(store, clock, proposal);
  },

  is_quorum_reached(store: MockLedgerStore, clock: LedgerClock, _caller: string, args: unknown[]): boolean {
    const [proposalId] = args as [bigint];
    const proposal = mustGetProposal(store, proposalId);
    const requiredQuorum = computeQuorum(store, clock, proposal);
    return proposal.votesFor + proposal.votesAbstain >= requiredQuorum;
  },

  proposal_threshold(store: MockLedgerStore): bigint {
    return store.governor.settings.proposalThreshold;
  },

  proposal_votes(store: MockLedgerStore, _clock: LedgerClock, _caller: string, args: unknown[]): [bigint, bigint, bigint] {
    const [proposalId] = args as [bigint];
    const proposal = mustGetProposal(store, proposalId);
    return [proposal.votesFor, proposal.votesAgainst, proposal.votesAbstain];
  },

  has_voted(store: MockLedgerStore, _clock: LedgerClock, _caller: string, args: unknown[]): boolean {
    const [proposalId, voter] = args as [bigint, string];
    const proposal = mustGetProposal(store, proposalId);
    return Boolean(proposal.hasVoted[voter]);
  },

  proposal_count(store: MockLedgerStore): bigint {
    return store.governor.proposalCount;
  },

  pause(store: MockLedgerStore, _clock: LedgerClock, caller: string, _args: unknown[]): null {
    const gov = store.governor;
    if (caller !== gov.settings.pauser) {
      throw new MockContractError(GovernorErrorCode.UnauthorizedPause, "pause: only pauser can pause");
    }
    gov.settings.isPaused = true;
    return null;
  },

  unpause(store: MockLedgerStore, _clock: LedgerClock, caller: string, _args: unknown[]): null {
    const gov = store.governor;
    if (caller !== gov.settings.pauser) {
      throw new MockContractError(GovernorErrorCode.UnauthorizedPause, "unpause: only pauser can unpause");
    }
    gov.settings.isPaused = false;
    return null;
  },
};

export type GovernorFunction = keyof typeof governorExecutor;
