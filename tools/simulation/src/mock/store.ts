/**
 * In-memory ledger state shared by the mock Governor/Timelock/TokenVotes
 * executors. This is intentionally a plain, structured-cloneable object graph
 * (no class instances, no XDR types) so that `snapshot()`/`restore()` and the
 * side-effect-free `simulateTransaction` dry run can both use
 * `structuredClone`.
 */

export interface ProposalRecord {
  id: bigint;
  proposer: string;
  description: string;
  descriptionHash: string;
  metadataUri: string;
  targets: string[];
  fnNames: string[];
  calldatas: Uint8Array[];
  startLedger: number;
  endLedger: number;
  votesFor: bigint;
  votesAgainst: bigint;
  votesAbstain: bigint;
  executed: boolean;
  cancelled: boolean;
  queued: boolean;
  opIds: string[];
  hasVoted: Record<string, boolean>;
}

export interface GovernorSettingsState {
  votingDelay: number;
  votingPeriod: number;
  quorumNumerator: number;
  proposalThreshold: bigint;
  guardian: string;
  voteType: "Simple" | "Extended" | "Quadratic";
  proposalGracePeriod: number;
  useDynamicQuorum: boolean;
  reflectorOracle: string | null;
  minQuorumUsd: bigint;
  proposalCooldown: number;
  maxProposalsPerPeriod: number;
  proposalPeriodDuration: number;
  maxCalldataSize: number;
  isPaused: boolean;
  pauser: string;
}

export interface GovernorState {
  settings: GovernorSettingsState;
  proposals: Map<bigint, ProposalRecord>;
  proposalCount: bigint;
  queueTime: Map<bigint, number>;
  lastProposalLedger: Map<string, number>;
  proposalsInPeriod: Map<string, number>;
}

export interface TimelockOperationRecord {
  target: string;
  fnName: string;
  data: Uint8Array;
  readyAt: number;
  expiresAt: number;
  executed: boolean;
  cancelled: boolean;
  predecessors?: string[];
}

export interface TimelockState {
  minDelay: bigint;
  executionWindow: bigint;
  operations: Map<string, TimelockOperationRecord>;
  dependencies: Map<string, string[]>;
}

export interface Checkpoint {
  ledger: number;
  votes: bigint;
}

export interface TokenVotesState {
  /** Raw token balance seeded per account (not moved by delegation). */
  balances: Map<string, bigint>;
  /** delegator -> delegatee (self if undelegated/self-delegated). */
  delegates: Map<string, string>;
  /** account -> checkpoint history of its delegated voting power. */
  checkpoints: Map<string, Checkpoint[]>;
  totalSupplyCheckpoints: Checkpoint[];
}

export interface ContractAddresses {
  governor: string;
  timelock: string;
  votes: string;
  coSponsorship: string;
  optimisticGovernor: string;
}

export type OptimisticProposalLifecycle =
  | "ChallengeWindow"
  | "Objected"
  | "Passed"
  | "Executed"
  | "Cancelled";

export interface OptimisticProposalRecord {
  id: bigint;
  proposer: string;
  target: string;
  fnName: string;
  calldata: Uint8Array;
  descriptionHash: Uint8Array;
  createdLedger: number;
  challengeEndLedger: number;
  objectionVotes: bigint;
  state: OptimisticProposalLifecycle;
}

export interface OptimisticGovernorState {
  admin: string;
  votesToken: string;
  challengeWindowLedgers: number;
  objectionThresholdBps: number;
  proposerBondAmount: bigint;
  proposerBondToken: string;
  proposals: Map<bigint, OptimisticProposalRecord>;
  proposalCount: bigint;
  /** `${proposalId}:${address}` entries for objectors who already objected. */
  objectorVoted: Set<string>;
}

export interface CoSponsorshipDraftRecord {
  id: bigint;
  creator: string;
  description: string;
  descriptionHash: Uint8Array;
  metadataUri: string;
  targets: string[];
  fnNames: string[];
  calldatas: Uint8Array[];
  createdLedger: number;
  expiryLedger: number;
  coSponsors: string[];
  coSponsorPower: bigint[];
  totalPower: bigint;
  finalized: boolean;
  cancelled: boolean;
}

export interface CoSponsorshipState {
  drafts: Map<bigint, CoSponsorshipDraftRecord>;
  draftCount: bigint;
}

export interface MockLedgerStore {
  addresses: ContractAddresses;
  governor: GovernorState;
  timelock: TimelockState;
  votes: TokenVotesState;
  coSponsorship: CoSponsorshipState;
  optimisticGovernor: OptimisticGovernorState;
}

export function cloneStore(store: MockLedgerStore): MockLedgerStore {
  return structuredClone(store);
}
