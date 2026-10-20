/**
 * Mock replica of `contracts/optimistic-governor/src/lib.rs`'s lifecycle
 * (`propose` -> `object` -> `finalize` -> `execute` / `cancel`).
 *
 * Voting power for objections is read straight out of the shared
 * `TokenVotesState` checkpoints (`get_past_votes` at the proposal's
 * `created_ledger`), exactly like the on-chain `VotesTrait` wiring.
 *
 * Simplification: `proposer_bond_amount` must be configured as `0` — this
 * mock has no SEP-41 token contract to transfer the bond through (same
 * scope boundary as the harness's token-votes simplification), so a
 * non-zero bond is rejected as `InvalidConfiguration` at `propose` time.
 * Error codes 1–99 mirror `OptimisticGovernorError` so
 * `@nebgov/sdk`'s `parseOptimisticGovernorError` recovers the typed error.
 */
import { LedgerClock } from "../ledger";
import { MockLedgerStore, OptimisticProposalRecord } from "./store";
import { MockContractError } from "./errors";
import { tokenVotesExecutor } from "./token-votes-executor";

const BPS = 10_000n;

const ERR = {
  InvalidConfiguration: 3,
  ProposalNotFound: 5,
  NotInChallengeWindow: 6,
  ChallengeWindowNotElapsed: 7,
  ChallengeWindowElapsed: 8,
  AlreadyObjected: 9,
  NoVotingPower: 10,
  ProposalAlreadyFinalized: 13,
  Unauthorized: 14,
  ProposalNotPassed: 12,
  ProposalNotCancellable: 16,
} as const;

function mustGetProposal(store: MockLedgerStore, id: bigint): OptimisticProposalRecord {
  const proposal = store.optimisticGovernor.proposals.get(id);
  if (!proposal) {
    throw new MockContractError(ERR.ProposalNotFound, `proposal ${id} not found`);
  }
  return proposal;
}

export const optimisticGovernorExecutor = {
  propose(
    store: MockLedgerStore,
    clock: LedgerClock,
    _caller: string,
    args: unknown[],
  ): bigint {
    const [proposer, target, fnName, calldata, descriptionHash] = args as [
      string,
      string,
      string,
      Buffer,
      Buffer,
    ];
    const config = store.optimisticGovernor;
    if (config.proposerBondAmount !== 0n) {
      throw new MockContractError(
        ERR.InvalidConfiguration,
        "mock optimistic governor only supports proposerBondAmount = 0",
      );
    }

    config.proposalCount += 1n;
    const id = config.proposalCount;
    const createdLedger = clock.sequence;
    const proposal: OptimisticProposalRecord = {
      id,
      proposer,
      target,
      fnName,
      calldata: new Uint8Array(calldata),
      descriptionHash: new Uint8Array(descriptionHash),
      createdLedger,
      challengeEndLedger: createdLedger + config.challengeWindowLedgers,
      objectionVotes: 0n,
      state: "ChallengeWindow",
    };
    config.proposals.set(id, proposal);
    return id;
  },

  object(store: MockLedgerStore, clock: LedgerClock, caller: string, args: unknown[]): null {
    const [objector, rawId] = args as [string, bigint];
    const id = BigInt(rawId);
    const config = store.optimisticGovernor;
    const proposal = mustGetProposal(store, id);

    if (proposal.state !== "ChallengeWindow") {
      throw new MockContractError(ERR.NotInChallengeWindow, "proposal is not in the challenge window");
    }
    if (clock.sequence >= proposal.challengeEndLedger) {
      throw new MockContractError(ERR.ChallengeWindowElapsed, "challenge window has elapsed");
    }

    const votedKey = `${id}:${objector}`;
    if (config.objectorVoted.has(votedKey)) {
      throw new MockContractError(ERR.AlreadyObjected, "address already objected");
    }

    const weight = tokenVotesExecutor.get_past_votes(store.votes, clock, caller, [
      objector,
      proposal.createdLedger,
    ]) as bigint;
    if (weight <= 0n) {
      throw new MockContractError(ERR.NoVotingPower, "objector has no voting power");
    }
    config.objectorVoted.add(votedKey);

    proposal.objectionVotes += weight;
    const totalSupply = tokenVotesExecutor.get_past_total_supply(store.votes, clock, caller, [
      proposal.createdLedger,
    ]) as bigint;
    const crossed =
      totalSupply > 0n && (proposal.objectionVotes * BPS) / totalSupply >= BigInt(config.objectionThresholdBps);
    if (crossed) {
      proposal.state = "Objected";
    }
    return null;
  },

  finalize(store: MockLedgerStore, clock: LedgerClock, _caller: string, args: unknown[]): null {
    const [rawId] = args as [bigint];
    const proposal = mustGetProposal(store, BigInt(rawId));
    if (proposal.state !== "ChallengeWindow") {
      throw new MockContractError(ERR.ProposalAlreadyFinalized, "proposal already finalized or objected");
    }
    if (clock.sequence < proposal.challengeEndLedger) {
      throw new MockContractError(
        ERR.ChallengeWindowNotElapsed,
        "challenge window has not elapsed yet",
      );
    }
    proposal.state = "Passed";
    return null;
  },

  execute(store: MockLedgerStore, _clock: LedgerClock, _caller: string, args: unknown[]): null {
    const [rawId] = args as [bigint];
    const proposal = mustGetProposal(store, BigInt(rawId));
    if (proposal.state !== "Passed") {
      throw new MockContractError(ERR.ProposalNotPassed, "proposal has not passed");
    }
    proposal.state = "Executed";
    // The on-chain contract invokes `proposal.target` here; the mock models
    // the state transition only (targets in simulations are no-ops).
    return null;
  },

  cancel(store: MockLedgerStore, _clock: LedgerClock, _caller: string, args: unknown[]): null {
    const [caller, rawId] = args as [string, bigint];
    const proposal = mustGetProposal(store, BigInt(rawId));
    if (caller !== proposal.proposer) {
      throw new MockContractError(ERR.Unauthorized, "only the proposer may cancel");
    }
    if (proposal.state !== "ChallengeWindow" && proposal.state !== "Objected") {
      throw new MockContractError(ERR.ProposalNotCancellable, "proposal is not cancellable");
    }
    proposal.state = "Cancelled";
    return null;
  },

  get_proposal(store: MockLedgerStore, _clock: LedgerClock, _caller: string, args: unknown[]): OptimisticProposalRecord {
    const [rawId] = args as [bigint];
    return mustGetProposal(store, BigInt(rawId));
  },

  get_config(store: MockLedgerStore): {
    votesToken: string;
    challengeWindowLedgers: number;
    objectionThresholdBps: number;
    proposerBondAmount: bigint;
    proposerBondToken: string;
  } {
    const config = store.optimisticGovernor;
    return {
      votesToken: config.votesToken,
      challengeWindowLedgers: config.challengeWindowLedgers,
      objectionThresholdBps: config.objectionThresholdBps,
      proposerBondAmount: config.proposerBondAmount,
      proposerBondToken: config.proposerBondToken,
    };
  },

  update_config(store: MockLedgerStore, _clock: LedgerClock, _caller: string, args: unknown[]): null {
    const [admin, challengeWindowLedgers, objectionThresholdBps] = args as [string, number, number];
    const config = store.optimisticGovernor;
    if (admin !== config.admin) {
      throw new MockContractError(ERR.Unauthorized, "caller is not the admin");
    }
    if (
      challengeWindowLedgers === 0 ||
      objectionThresholdBps === 0 ||
      BigInt(objectionThresholdBps) > BPS
    ) {
      throw new MockContractError(ERR.InvalidConfiguration, "invalid configuration");
    }
    config.challengeWindowLedgers = challengeWindowLedgers;
    config.objectionThresholdBps = objectionThresholdBps;
    return null;
  },
};

export type OptimisticGovernorFunction = keyof typeof optimisticGovernorExecutor;
