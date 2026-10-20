/**
 * In-memory ledger state shared by the mock Governor/Timelock/TokenVotes/
 * Treasury executors. This is intentionally a plain, structured-cloneable object
 * graph (no class instances, no XDR types) so that `snapshot()`/`restore()` and
 * the side-effect-free `simulateTransaction` dry run can both use
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
  treasury: string;
  convictionVoting: string;
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

/** A budget stream allocated by the treasury contract (`contracts/treasury/src/streams.rs`). */
export interface BudgetStreamRecord {
  id: bigint;
  name: string;
  owner: string;
  token: string;
  totalAllocated: bigint;
  totalSpent: bigint;
  startLedger: number;
  endLedger: number;
  isActive: boolean;
  isRevoked: boolean;
  revokedAtLedger: number | null;
  maxSingleSpend: bigint;
  cooldownLedgers: number;
  lastSpendLedger: number;
  spendCount: number;
  createdByProposalId: bigint;
}

/** A single withdrawal recorded against a budget stream. */
export interface StreamSpendRecord {
  streamId: bigint;
  spendIndex: number;
  recipient: string;
  amount: bigint;
  memo: string;
  executedAtLedger: number;
  executedBy: string;
}

export interface TreasuryState {
  /** Address authorised to sign the governance-gated stream calls. */
  governor: string;
  streams: Map<bigint, BudgetStreamRecord>;
  streamCount: bigint;
  /** Stream ID -> spend records in execution order. */
  spends: Map<bigint, StreamSpendRecord[]>;
  /** Tokens any stream has been denominated in, in order of first use. */
  tokenList: string[];
  totalStreamedByToken: Map<string, bigint>;
  totalSpentByToken: Map<string, bigint>;
}

/** A continuously-supported proposal on the conviction-voting track. */
export interface ConvictionProposalRecord {
  id: bigint;
  proposer: string;
  target: string;
  fnName: string;
  calldata: Uint8Array;
  requestedAmount: bigint;
  createdLedger: number;
  conviction: bigint;
  lastUpdatedLedger: number;
  executed: boolean;
  cancelled: boolean;
}

/** One supporter's voting-power commitment on a conviction proposal. */
export interface ConvictionStakeRecord {
  staker: string;
  proposalId: bigint;
  amount: bigint;
}

/**
 * A conviction proposal's self-executed action. The mock records the
 * cross-contract invocation rather than dispatching it (the same
 * simplification the timelock executor makes for `execute()`).
 */
export interface ConvictionExecutionRecord {
  proposalId: bigint;
  target: string;
  fnName: string;
  calldata: Uint8Array;
  ledger: number;
}

export interface ConvictionVotingState {
  admin: string;
  /** TokenVotes contract the track reads live voting power from. */
  votesToken: string;
  /** Per-ledger conviction decay, in bps of the retained score. */
  decayBps: number;
  /** Largest share of total supply a proposal may request, in bps. */
  maxRatioBps: number;
  /** Conviction floor for a proposal requesting a zero amount. */
  minThresholdConviction: bigint;
  /** Accrual weight applied to staked power, in bps. */
  weightBps: number;
  nextProposalId: bigint;
  proposals: Map<bigint, ConvictionProposalRecord>;
  /** proposalId -> (staker -> committed amount). */
  stakes: Map<bigint, Map<string, bigint>>;
  totalStaked: Map<bigint, bigint>;
  /** staker -> proposal their voting power is currently locked onto. */
  stakeByStaker: Map<string, bigint>;
  /** Self-executed actions, in execution order. */
  executions: ConvictionExecutionRecord[];
}

export interface MockLedgerStore {
  addresses: ContractAddresses;
  governor: GovernorState;
  timelock: TimelockState;
  votes: TokenVotesState;
  coSponsorship: CoSponsorshipState;
  optimisticGovernor: OptimisticGovernorState;
  treasury: TreasuryState;
  convictionVoting: ConvictionVotingState;
}

export function cloneStore(store: MockLedgerStore): MockLedgerStore {
  return structuredClone(store);
}
