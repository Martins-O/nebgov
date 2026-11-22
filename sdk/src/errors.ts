/**
 * NebGov SDK — typed error system
 *
 * All SDK methods throw one of GovernorError, TimelockError, or VotesError
 * instead of raw Error objects. Each error carries a typed code so callers
 * can branch on specific failure modes without string-matching messages.
 *
 * Contract error codes are taken directly from the on-chain #[contracterror]
 * enums; SDK-level codes (≥ 100) cover RPC/transport failures.
 */

// ─── Governor Errors ──────────────────────────────────────────────────────────

/**
 * Error codes for the Governor contract + SDK transport layer.
 *
 * Codes 1–99 mirror the on-chain GovernorError enum values so that the numeric
 * code you receive matches what is written in the Rust contract.
 */
export enum GovernorErrorCode {
  // On-chain contract errors (match contracts/governor/src/error.rs exactly)
  UnauthorizedCancel = 1,
  InvalidSupport = 2,
  ProposalExpired = 3,
  CalldataTooLarge = 4,
  InvalidCalldata = 5,
  ProposalRateLimited = 6,
  ContractPaused = 7,
  UnauthorizedPause = 8,
  InvalidVectorLengths = 9,
  NoTargets = 10,
  ProposalThresholdNotMet = 11,
  AlreadyVoted = 12,
  ZeroVotingPower = 13,
  ProposalNotSucceeded = 14,
  ProposalNotQueued = 15,
  ProposalAlreadyExecuted = 16,
  MissingOpIds = 17,
  UnauthorizedGuardian = 18,
  VetoWindowClosed = 19,
  ProposalNotFound = 20,
  TimelockNotSet = 21,
  GuardianNotSet = 22,
  TooManyTokens = 23,
  EmptyMetadataUri = 24,
  VotesTokenNotSet = 25,
  PauserNotSet = 26,
  ArithmeticOverflow = 27,
  VotePeriodTooShort = 28,
  ExecutionWindowZero = 29,
  TooManyCalldataEntries = 30,
  ProposalNotActive = 31,
  AlreadyInitialized = 32,
  InvalidVotingDelay = 33,
  InvalidVotingPeriod = 34,
  InvalidQuorumNumerator = 35,
  InvalidProposalThreshold = 36,
  InvalidMaxCalldataSize = 37,
  InvalidMaxProposalsPerPeriod = 38,
  InvalidProposalPeriodDuration = 39,
  EmptyBatch = 40,
  BatchProposalNotQueued = 41,
  ProposalAlreadyCancelled = 42,
  InvalidVoteChoice = 43,
  UnauthorizedRegistry = 44,

  // SDK-level codes
  RpcNotFound = 100,
  SimulationFailed = 101,
  TransactionFailed = 102,
  TransactionTimeout = 103,
  InvalidArguments = 104,
  UnknownState = 105,
}

const GOVERNOR_MESSAGES: Record<GovernorErrorCode, string> = {
  [GovernorErrorCode.UnauthorizedCancel]:
    "Unauthorized: only the proposer or guardian can cancel this proposal",
  [GovernorErrorCode.InvalidSupport]:
    "Invalid vote support: this governance type does not allow abstain votes",
  [GovernorErrorCode.ProposalExpired]:
    "Proposal has expired and can no longer be acted upon",
  [GovernorErrorCode.CalldataTooLarge]:
    "Calldata exceeds the maximum allowed size",
  [GovernorErrorCode.InvalidCalldata]: "Calldata is invalid or malformed",
  [GovernorErrorCode.ProposalRateLimited]:
    "Proposal creation is rate-limited for this proposer",
  [GovernorErrorCode.ContractPaused]: "Contract is paused",
  [GovernorErrorCode.UnauthorizedPause]:
    "Only the pauser may pause the contract",
  [GovernorErrorCode.InvalidVectorLengths]:
    "Targets, function names, and calldatas must have the same length",
  [GovernorErrorCode.NoTargets]: "At least one target is required",
  [GovernorErrorCode.ProposalThresholdNotMet]:
    "Proposer does not meet the proposal threshold",
  [GovernorErrorCode.AlreadyVoted]: "Voter has already voted on this proposal",
  [GovernorErrorCode.ZeroVotingPower]: "Account has zero voting power",
  [GovernorErrorCode.ProposalNotSucceeded]:
    "Proposal is not in Succeeded state",
  [GovernorErrorCode.ProposalNotQueued]: "Proposal is not queued",
  [GovernorErrorCode.ProposalAlreadyExecuted]:
    "Proposal has already been executed",
  [GovernorErrorCode.MissingOpIds]:
    "Missing timelock operation IDs; queue() must be called first",
  [GovernorErrorCode.UnauthorizedGuardian]:
    "Only the guardian may perform this action",
  [GovernorErrorCode.VetoWindowClosed]: "Veto window has closed",
  [GovernorErrorCode.ProposalNotFound]: "Proposal not found",
  [GovernorErrorCode.TimelockNotSet]: "Timelock address is not configured",
  [GovernorErrorCode.GuardianNotSet]: "Guardian address is not configured",
  [GovernorErrorCode.TooManyTokens]:
    "Multi-token strategy supports at most 5 tokens",
  [GovernorErrorCode.EmptyMetadataUri]: "Metadata URI cannot be empty",
  [GovernorErrorCode.VotesTokenNotSet]: "Votes token address is not configured",
  [GovernorErrorCode.PauserNotSet]: "Pauser address is not configured",
  [GovernorErrorCode.ArithmeticOverflow]:
    "Arithmetic overflow while computing governance state",
  [GovernorErrorCode.VotePeriodTooShort]:
    "Voting period is shorter than the minimum required",
  [GovernorErrorCode.ExecutionWindowZero]:
    "Execution window must be greater than zero",
  [GovernorErrorCode.TooManyCalldataEntries]:
    "Proposal exceeds the maximum number of calldata entries (10)",
  [GovernorErrorCode.ProposalNotActive]:
    "Voting has ended for this proposal",
  [GovernorErrorCode.AlreadyInitialized]:
    "Contract is already initialized",
  [GovernorErrorCode.InvalidVotingDelay]:
    "Voting delay must be greater than zero",
  [GovernorErrorCode.InvalidVotingPeriod]:
    "Voting period must be greater than zero",
  [GovernorErrorCode.InvalidQuorumNumerator]:
    "Quorum numerator must be between 0 and 100",
  [GovernorErrorCode.InvalidProposalThreshold]:
    "Proposal threshold must be non-negative",
  [GovernorErrorCode.InvalidMaxCalldataSize]:
    "Max calldata size must be greater than zero",
  [GovernorErrorCode.InvalidMaxProposalsPerPeriod]:
    "Max proposals per period must be greater than zero",
  [GovernorErrorCode.InvalidProposalPeriodDuration]:
    "Proposal period duration must be greater than zero",
  [GovernorErrorCode.EmptyBatch]:
    "Batch proposal cannot be empty",
  [GovernorErrorCode.BatchProposalNotQueued]:
    "Batch proposal is not queued",
  [GovernorErrorCode.ProposalAlreadyCancelled]:
    "Proposal has already been cancelled",
  [GovernorErrorCode.InvalidVoteChoice]:
    "Invalid vote choice: must be 0 (Against), 1 (For), or 2 (Abstain)",
  [GovernorErrorCode.UnauthorizedRegistry]:
    "Caller is not the configured co-sponsorship registry",

  // SDK-level codes
  [GovernorErrorCode.RpcNotFound]: "Proposal not found",
  [GovernorErrorCode.SimulationFailed]: "Simulation failed",
  [GovernorErrorCode.TransactionFailed]: "Transaction failed",
  [GovernorErrorCode.TransactionTimeout]: "Transaction timed out",
  [GovernorErrorCode.InvalidArguments]: "Invalid arguments",
  [GovernorErrorCode.UnknownState]: "Unknown proposal state",
};

export class GovernorError extends Error {
  readonly name = "GovernorError";

  constructor(
    public readonly code: GovernorErrorCode,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    Object.setPrototypeOf(this, GovernorError.prototype);
  }
}

// ─── Timelock Errors ──────────────────────────────────────────────────────────

/**
 * Error codes for the Timelock contract + SDK transport layer.
 *
 * Codes 1–99 mirror the on-chain TimelockError enum values.
 */
export enum TimelockErrorCode {
  // On-chain contract errors (match contracts/timelock/src/lib.rs)
  PredecessorNotDone = 1,
  PredecessorNotFound = 2,
  OperationExpired = 3,
  DependencyCycleDetected = 10,
  PredecessorNotComplete = 11,
  BatchInRecoveryMode = 12,
  BatchRecoveryExpired = 13,
  OperationAlreadyInBatch = 14,
  InvalidPredecessorList = 15,

  // SDK-level codes
  SimulationFailed = 100,
  TransactionFailed = 101,
  TransactionTimeout = 102,
  MissingReturnValue = 103,
}

const TIMELOCK_MESSAGES: Record<TimelockErrorCode, string> = {
  [TimelockErrorCode.PredecessorNotDone]:
    "Cannot execute: predecessor operation has not been executed yet",
  [TimelockErrorCode.PredecessorNotFound]:
    "Cannot schedule: the specified predecessor operation does not exist",
  [TimelockErrorCode.OperationExpired]:
    "Operation has expired and can no longer be executed",
  [TimelockErrorCode.DependencyCycleDetected]:
    "The dependency graph contains a cycle and cannot be scheduled",
  [TimelockErrorCode.PredecessorNotComplete]:
    "A predecessor operation in the batch has not completed yet",
  [TimelockErrorCode.BatchInRecoveryMode]:
    "Batch is in recovery mode and cannot accept this operation",
  [TimelockErrorCode.BatchRecoveryExpired]:
    "Batch recovery deadline has expired",
  [TimelockErrorCode.OperationAlreadyInBatch]:
    "Operation is already part of a batch",
  [TimelockErrorCode.InvalidPredecessorList]:
    "Invalid predecessor list provided",
  [TimelockErrorCode.SimulationFailed]: "Simulation failed",
  [TimelockErrorCode.TransactionFailed]: "Transaction failed",
  [TimelockErrorCode.TransactionTimeout]: "Transaction timed out",
  [TimelockErrorCode.MissingReturnValue]: "No return value from contract",
};

export class TimelockError extends Error {
  readonly name = "TimelockError";

  constructor(
    public readonly code: TimelockErrorCode,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    Object.setPrototypeOf(this, TimelockError.prototype);
  }
}

// ─── Votes Errors ─────────────────────────────────────────────────────────────

/**
 * Error codes for the TokenVotes contract + SDK transport layer.
 *
 * Codes 10-16 mirror the on-chain `TokenVotesError` enum
 * (contracts/token-votes/src/error.rs), introduced for signed delegation
 * (issue #772). Codes 1-9 are reserved on-chain for delegation/checkpoint
 * invariants that still panic via `assert!`/`expect` rather than a typed
 * error. SDK-level codes start at 100.
 */
export enum VotesErrorCode {
  // On-chain contract errors (match contracts/token-votes/src/error.rs)
  InvalidSignature = 10,
  NonceAlreadyUsed = 11,
  PermitExpired = 12,
  InvalidDelegationPermit = 13,
  RelayerNotWhitelisted = 14,
  InvalidChainId = 15,
  InvalidContractId = 16,
  ChainDepthExceeded = 17,
  SplitTooManyTargets = 18,
  SplitDuplicateDelegatee = 19,
  SplitZeroWeight = 20,
  SplitWeightsMustSum10000 = 21,
  SplitTargetsBelowMin = 22,
  SplitEmpty = 23,
  WeightBpsOverflow = 24,
  TokenNotSet = 25,
  FutureLedger = 26,
  AlreadyInitialized = 27,
  InvalidTimeWeightScale = 28,

  // SDK-level codes
  SimulationFailed = 100,
  TransactionFailed = 101,
  TransactionTimeout = 102,
  DelegationFailed = 103,
  EventScanFailed = 104,
}

const VOTES_MESSAGES: Record<VotesErrorCode, string> = {
  [VotesErrorCode.InvalidSignature]:
    "Invalid or missing delegation signature",
  [VotesErrorCode.NonceAlreadyUsed]:
    "Permit nonce has already been used or invalidated",
  [VotesErrorCode.PermitExpired]:
    "Delegation permit has expired",
  [VotesErrorCode.InvalidDelegationPermit]:
    "Delegation permit is malformed or out of order",
  [VotesErrorCode.RelayerNotWhitelisted]:
    "Relayer is not whitelisted to submit signed permits",
  [VotesErrorCode.InvalidChainId]:
    "Permit was signed for a different network",
  [VotesErrorCode.InvalidContractId]:
    "Permit was signed for a different contract",
  [VotesErrorCode.ChainDepthExceeded]:
    "Delegation would exceed the maximum chain depth",
  [VotesErrorCode.SplitTooManyTargets]:
    "Split delegation has more entries than the maximum allowed targets",
  [VotesErrorCode.SplitDuplicateDelegatee]:
    "Split delegation contains a duplicate delegatee",
  [VotesErrorCode.SplitZeroWeight]:
    "Split delegation entry must have a non-zero weight",
  [VotesErrorCode.SplitWeightsMustSum10000]:
    "Split delegation weights must sum to exactly 10000 (100%)",
  [VotesErrorCode.SplitTargetsBelowMin]:
    "Split delegation contains a target below the minimum weight",
  [VotesErrorCode.SplitEmpty]: "Split delegation must contain at least one target",
  [VotesErrorCode.WeightBpsOverflow]: "Split delegation weight arithmetic overflowed",
  [VotesErrorCode.TokenNotSet]: "The voting token is not configured",
  [VotesErrorCode.FutureLedger]: "Snapshot ledger cannot be in the future",
  [VotesErrorCode.AlreadyInitialized]: "TokenVotes contract is already initialized",
  [VotesErrorCode.InvalidTimeWeightScale]:
    "Time-weighting scale must be greater than zero",

  [VotesErrorCode.SimulationFailed]: "Simulation failed",
  [VotesErrorCode.TransactionFailed]: "Transaction failed",
  [VotesErrorCode.TransactionTimeout]: "Transaction timed out",
  [VotesErrorCode.DelegationFailed]: "Delegation transaction failed",
  [VotesErrorCode.EventScanFailed]: "Failed to scan delegation events",
};

export class VotesError extends Error {
  readonly name = "VotesError";

  constructor(
    public readonly code: VotesErrorCode,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    Object.setPrototypeOf(this, VotesError.prototype);
  }
}

// ─── Vote Escrow Errors ────────────────────────────────────────────────────────

/**
 * Error codes for the vote-escrow contract + SDK transport layer.
 *
 * Codes 1-10 mirror the on-chain `VoteEscrowError` enum
 * (contracts/vote-escrow/src/error.rs). SDK-level codes start at 100.
 */
export enum VoteEscrowErrorCode {
  // On-chain contract errors (match contracts/vote-escrow/src/error.rs)
  NotInitialized = 1,
  LockNotFound = 2,
  LockNotMatured = 3,
  LockAlreadyWithdrawn = 4,
  InvalidDuration = 5,
  InvalidAmount = 6,
  InvalidEndLedger = 7,
  ArithmeticOverflow = 8,
  Unauthorized = 9,
  LockAlreadyExists = 10,

  // SDK-level codes
  SimulationFailed = 100,
  TransactionFailed = 101,
  TransactionTimeout = 102,
}

const VOTE_ESCROW_MESSAGES: Record<VoteEscrowErrorCode, string> = {
  [VoteEscrowErrorCode.NotInitialized]: "Vote escrow contract is not initialized",
  [VoteEscrowErrorCode.LockNotFound]: "No active lock found for this account",
  [VoteEscrowErrorCode.LockNotMatured]: "Lock has not yet reached its end ledger",
  [VoteEscrowErrorCode.LockAlreadyWithdrawn]: "Lock has already been withdrawn",
  [VoteEscrowErrorCode.InvalidDuration]: "Lock duration is outside the allowed range",
  [VoteEscrowErrorCode.InvalidAmount]: "Lock amount must be positive",
  [VoteEscrowErrorCode.InvalidEndLedger]: "New end ledger must be after the current end ledger",
  [VoteEscrowErrorCode.Unauthorized]: "Caller is not authorized to perform this action",
  [VoteEscrowErrorCode.ArithmeticOverflow]: "Arithmetic overflow in voting power calculation",
  [VoteEscrowErrorCode.LockAlreadyExists]: "An active lock already exists for this account",

  [VoteEscrowErrorCode.SimulationFailed]: "Simulation failed",
  [VoteEscrowErrorCode.TransactionFailed]: "Transaction failed",
  [VoteEscrowErrorCode.TransactionTimeout]: "Transaction timed out",
};

export class VoteEscrowError extends Error {
  readonly name = "VoteEscrowError";

  constructor(
    public readonly code: VoteEscrowErrorCode,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    Object.setPrototypeOf(this, VoteEscrowError.prototype);
  }
}

export function parseVoteEscrowError(
  raw: SorobanRpcError | string | null | undefined,
  cause?: unknown,
): VoteEscrowError {
  const contractCode = extractContractErrorCode(raw);
  if (contractCode !== null) {
    const code = contractCode as VoteEscrowErrorCode;
    const message = VOTE_ESCROW_MESSAGES[code] ?? `Vote escrow contract error #${contractCode}`;
    return new VoteEscrowError(code, message, cause);
  }

  if (hasErrorStatus(raw)) {
    return new VoteEscrowError(
      VoteEscrowErrorCode.TransactionFailed,
      `${VOTE_ESCROW_MESSAGES[VoteEscrowErrorCode.TransactionFailed]}: ${errorText(raw) || "unknown"}`,
      cause,
    );
  }

  return new VoteEscrowError(
    VoteEscrowErrorCode.SimulationFailed,
    `${VOTE_ESCROW_MESSAGES[VoteEscrowErrorCode.SimulationFailed]}: ${errorText(raw) || "unknown"}`,
    cause,
  );
}

// ─── Contract Error Parsing ───────────────────────────────────────────────────

/** Minimal shape of a Soroban RPC error result used by the parsers below. */
export interface SorobanRpcError {
  status?: string;
  error?: string;
  resultXdr?: string;
}

function errorText(raw: SorobanRpcError | string | null | undefined): string {
  if (typeof raw === "string") return raw;
  if (!raw || typeof raw !== "object") return "";
  return typeof raw.error === "string" ? raw.error : "";
}

function hasErrorStatus(raw: SorobanRpcError | string | null | undefined): boolean {
  return !!raw && typeof raw === "object" && raw.status === "ERROR";
}

/**
 * Extract a numeric contract error code from a Soroban RPC error string.
 *
 * Handles the following formats emitted by Soroban RPC:
 * - `"Error(Contract, #3)"`
 * - `"HostError: Value(ContractError(3))"`
 * - `"contract error: #3"` (older RPC versions)
 */
export function extractContractErrorCode(
  raw: SorobanRpcError | string | null | undefined,
): number | null {
  const str = errorText(raw);
  if (!str) return null;

  // "Error(Contract, #3)"
  const hashMatch = str.match(/Error\(Contract,\s*#(\d+)\)/);
  if (hashMatch) return parseInt(hashMatch[1], 10);

  // "ContractError(3)" or "HostError: Value(ContractError(3))"
  const contractErrMatch = str.match(/ContractError\((\d+)\)/);
  if (contractErrMatch) return parseInt(contractErrMatch[1], 10);

  // "contract error: #3"
  const genericMatch = str.match(/contract error:\s*#?(\d+)/i);
  if (genericMatch) return parseInt(genericMatch[1], 10);

  return null;
}

/**
 * Parse a raw Soroban RPC error into a typed {@link GovernorError}.
 *
 * If the error string encodes a contract error code (e.g. `Error(Contract, #1)`)
 * the corresponding {@link GovernorErrorCode} and human-readable message are used.
 * Otherwise a generic transport-level code is assigned.
 */
export function parseGovernorError(
  raw: SorobanRpcError | string | null | undefined,
  cause?: unknown,
): GovernorError {
  const contractCode = extractContractErrorCode(raw);
  if (contractCode !== null) {
    const code = contractCode as GovernorErrorCode;
    const message =
      GOVERNOR_MESSAGES[code] ?? `Governor contract error #${contractCode}`;
    return new GovernorError(code, message, cause);
  }

  if (hasErrorStatus(raw)) {
    return new GovernorError(
      GovernorErrorCode.TransactionFailed,
      `${GOVERNOR_MESSAGES[GovernorErrorCode.TransactionFailed]}: ${errorText(raw) || "unknown"}`,
      cause,
    );
  }

  return new GovernorError(
    GovernorErrorCode.SimulationFailed,
    `${GOVERNOR_MESSAGES[GovernorErrorCode.SimulationFailed]}: ${errorText(raw) || "unknown"}`,
    cause,
  );
}

/**
 * Parse a raw Soroban RPC error into a typed {@link TimelockError}.
 */
export function parseTimelockError(
  raw: SorobanRpcError | string | null | undefined,
  cause?: unknown,
): TimelockError {
  const contractCode = extractContractErrorCode(raw);
  if (contractCode !== null) {
    const code = contractCode as TimelockErrorCode;
    const message =
      TIMELOCK_MESSAGES[code] ?? `Timelock contract error #${contractCode}`;
    return new TimelockError(code, message, cause);
  }

  if (hasErrorStatus(raw)) {
    return new TimelockError(
      TimelockErrorCode.TransactionFailed,
      `${TIMELOCK_MESSAGES[TimelockErrorCode.TransactionFailed]}: ${errorText(raw) || "unknown"}`,
      cause,
    );
  }

  return new TimelockError(
    TimelockErrorCode.SimulationFailed,
    `${TIMELOCK_MESSAGES[TimelockErrorCode.SimulationFailed]}: ${errorText(raw) || "unknown"}`,
    cause,
  );
}

// ─── Treasury Errors ──────────────────────────────────────────────────────────

/**
 * Error codes for the Treasury contract + SDK transport layer.
 *
 * Codes 1–99 mirror on-chain contract error values; SDK-level codes start at 100.
 */
export enum TreasuryErrorCode {
  // On-chain contract errors (match contracts/treasury/src/lib.rs)
  SingleTransferExceeded = 1,
  DailyLimitExceeded     = 2,
  NotInitialized         = 3,
  NoPendingOwner         = 4,
  TxNotFound             = 5,
  NotAnOwner             = 6,
  ArithmeticOverflow     = 7,
  AlreadyInitialized     = 8,

  // Stream errors (match on-chain TreasuryError enum)
  StreamNotFound = 10,
  StreamNotActive = 11,
  StreamExpired = 12,
  StreamRevoked = 13,
  StreamBudgetExhausted = 14,
  StreamSpendExceedsMax = 15,
  StreamCooldownNotElapsed = 16,
  UnauthorizedStreamOwner = 17,
  InsufficientTreasuryBalance = 18,
  StreamAlreadyRevoked = 19,
  StreamEndBeforeStart = 20,
  StreamSpendNotFound = 21,

  // SDK-level codes
  SimulationFailed = 100,
  TransactionFailed = 101,
  TransactionTimeout = 102,
  MissingReturnValue = 103,
  InvalidArguments = 104,
}

const TREASURY_MESSAGES: Record<TreasuryErrorCode, string> = {
  [TreasuryErrorCode.SingleTransferExceeded]:
    "Transfer exceeds the maximum allowed single-transfer amount",
  [TreasuryErrorCode.DailyLimitExceeded]:
    "Transfer exceeds the configured daily treasury limit",
  [TreasuryErrorCode.NotInitialized]: "Treasury contract has not been initialized",
  [TreasuryErrorCode.NoPendingOwner]: "No pending treasury owner has been proposed",
  [TreasuryErrorCode.TxNotFound]: "Treasury transaction not found",
  [TreasuryErrorCode.NotAnOwner]: "Address is not a treasury owner",
  [TreasuryErrorCode.ArithmeticOverflow]: "Treasury amount calculation overflowed",
  [TreasuryErrorCode.AlreadyInitialized]: "Treasury contract is already initialized",
  [TreasuryErrorCode.StreamNotFound]: "Budget stream not found",
  [TreasuryErrorCode.StreamNotActive]: "Budget stream is not active",
  [TreasuryErrorCode.StreamExpired]: "Budget stream has expired",
  [TreasuryErrorCode.StreamRevoked]: "Budget stream has been revoked",
  [TreasuryErrorCode.StreamBudgetExhausted]: "Budget stream has no remaining funds",
  [TreasuryErrorCode.StreamSpendExceedsMax]: "Spend exceeds the maximum single spend for a stream",
  [TreasuryErrorCode.StreamCooldownNotElapsed]: "Cooldown period between spends has not elapsed",
  [TreasuryErrorCode.UnauthorizedStreamOwner]: "Caller is not the authorized stream owner",
  [TreasuryErrorCode.InsufficientTreasuryBalance]: "Treasury has insufficient balance for the stream spend",
  [TreasuryErrorCode.StreamAlreadyRevoked]: "Stream has already been revoked",
  [TreasuryErrorCode.StreamEndBeforeStart]: "Stream end ledger is before start ledger",
  [TreasuryErrorCode.StreamSpendNotFound]: "Stream spend record not found",
  [TreasuryErrorCode.SimulationFailed]: "Simulation failed",
  [TreasuryErrorCode.TransactionFailed]: "Transaction failed",
  [TreasuryErrorCode.TransactionTimeout]: "Transaction timed out",
  [TreasuryErrorCode.MissingReturnValue]: "No return value from contract",
  [TreasuryErrorCode.InvalidArguments]: "Invalid arguments",
};

export class TreasuryError extends Error {
  readonly name = "TreasuryError";

  constructor(
    public readonly code: TreasuryErrorCode,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    Object.setPrototypeOf(this, TreasuryError.prototype);
  }
}

/**
 * Parse a raw Soroban RPC error into a typed {@link TreasuryError}.
 */
export function parseTreasuryError(
  raw: SorobanRpcError | string | null | undefined,
  cause?: unknown,
): TreasuryError {
  const contractCode = extractContractErrorCode(raw);
  if (contractCode !== null) {
    const code = contractCode as TreasuryErrorCode;
    const message =
      TREASURY_MESSAGES[code] ?? `Treasury contract error #${contractCode}`;
    return new TreasuryError(code, message, cause);
  }

  if (hasErrorStatus(raw)) {
    return new TreasuryError(
      TreasuryErrorCode.TransactionFailed,
      `${TREASURY_MESSAGES[TreasuryErrorCode.TransactionFailed]}: ${errorText(raw) || "unknown"}`,
      cause,
    );
  }

  return new TreasuryError(
    TreasuryErrorCode.SimulationFailed,
    `${TREASURY_MESSAGES[TreasuryErrorCode.SimulationFailed]}: ${errorText(raw) || "unknown"}`,
    cause,
  );
}

// ─── Co-Sponsorship Errors ────────────────────────────────────────────────────

/**
 * Error codes for the CoSponsorship contract + SDK transport layer.
 *
 * Codes 1–99 mirror the on-chain CoSponsorshipError enum values
 * (contracts/co-sponsorship/src/error.rs).
 */
export enum CoSponsorshipErrorCode {
  AlreadyInitialized = 1,
  DraftNotFound = 2,
  DraftExpired = 3,
  DraftClosed = 4,
  AlreadyCoSponsored = 5,
  NotCoSponsored = 6,
  CoSponsorLimitReached = 7,
  DraftThresholdNotMet = 8,
  UnauthorizedDraftCreator = 9,
  ZeroVotingPower = 10,
  InvalidVectorLengths = 11,
  NoTargets = 12,
  CalldataTooLarge = 13,
  TooManyCalldataEntries = 14,
  /** Contract method was called before initialize() ran (on-chain error #15). */
  NotInitialized = 15,

  // SDK-level codes
  SimulationFailed = 100,
  TransactionFailed = 101,
  TransactionTimeout = 102,
  MissingReturnValue = 103,
}

const CO_SPONSORSHIP_MESSAGES: Record<CoSponsorshipErrorCode, string> = {
  [CoSponsorshipErrorCode.AlreadyInitialized]: "Contract is already initialized",
  [CoSponsorshipErrorCode.DraftNotFound]: "Draft not found",
  [CoSponsorshipErrorCode.DraftExpired]: "Draft has expired",
  [CoSponsorshipErrorCode.DraftClosed]: "Draft has already been finalized or cancelled",
  [CoSponsorshipErrorCode.AlreadyCoSponsored]: "Address has already co-sponsored this draft",
  [CoSponsorshipErrorCode.NotCoSponsored]: "Address has not co-sponsored this draft",
  [CoSponsorshipErrorCode.CoSponsorLimitReached]: "Draft has reached its maximum co-sponsor count",
  [CoSponsorshipErrorCode.DraftThresholdNotMet]:
    "Draft's accumulated co-sponsor power does not meet the proposal threshold",
  [CoSponsorshipErrorCode.UnauthorizedDraftCreator]:
    "Only the draft's creator (or admin, for cancellation) may perform this action",
  [CoSponsorshipErrorCode.ZeroVotingPower]: "Account has zero voting power",
  [CoSponsorshipErrorCode.InvalidVectorLengths]:
    "Targets, function names, and calldatas must have the same length",
  [CoSponsorshipErrorCode.NoTargets]: "At least one target is required",
  [CoSponsorshipErrorCode.CalldataTooLarge]: "Calldata exceeds the maximum allowed size",
  [CoSponsorshipErrorCode.TooManyCalldataEntries]: "Too many calldata entries",
  [CoSponsorshipErrorCode.NotInitialized]: "Contract has not been initialized yet",
  [CoSponsorshipErrorCode.SimulationFailed]: "Simulation failed",
  [CoSponsorshipErrorCode.TransactionFailed]: "Transaction failed",
  [CoSponsorshipErrorCode.TransactionTimeout]: "Transaction timed out",
  [CoSponsorshipErrorCode.MissingReturnValue]: "No return value from contract",
};

export class CoSponsorshipError extends Error {
  readonly name = "CoSponsorshipError";

  constructor(
    public readonly code: CoSponsorshipErrorCode,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    Object.setPrototypeOf(this, CoSponsorshipError.prototype);
  }
}

/**
 * Parse a raw Soroban RPC error into a typed {@link CoSponsorshipError}.
 */
export function parseCoSponsorshipError(
  raw: SorobanRpcError | string | null | undefined,
  cause?: unknown,
  operation?: string,
): CoSponsorshipError {
  const contractCode = extractContractErrorCode(raw);
  if (contractCode !== null) {
    if (
      operation === "finalize_draft" &&
      (contractCode === GovernorErrorCode.ProposalRateLimited ||
        contractCode === GovernorErrorCode.ContractPaused)
    ) {
      const governorMessage =
        GOVERNOR_MESSAGES[contractCode as GovernorErrorCode] ??
        `Governor contract error #${contractCode}`;
      return new CoSponsorshipError(
        CoSponsorshipErrorCode.TransactionFailed,
        `Governor rejected the underlying proposal: ${governorMessage}`,
        cause,
      );
    }

    const code = contractCode as CoSponsorshipErrorCode;
    const message =
      CO_SPONSORSHIP_MESSAGES[code] ?? `Co-sponsorship contract error #${contractCode}`;
    return new CoSponsorshipError(code, message, cause);
  }

  if (hasErrorStatus(raw)) {
    return new CoSponsorshipError(
      CoSponsorshipErrorCode.TransactionFailed,
      `${CO_SPONSORSHIP_MESSAGES[CoSponsorshipErrorCode.TransactionFailed]}: ${errorText(raw) || "unknown"}`,
      cause,
    );
  }

  return new CoSponsorshipError(
    CoSponsorshipErrorCode.SimulationFailed,
    `${CO_SPONSORSHIP_MESSAGES[CoSponsorshipErrorCode.SimulationFailed]}: ${errorText(raw) || "unknown"}`,
    cause,
  );
}

// ─── Signaling (signal-anchor) Errors ────────────────────────────────────────

/**
 * Error codes for the signal-anchor contract + SDK transport layer.
 *
 * Codes 1–99 mirror the on-chain SignalAnchorError enum values
 * (contracts/signal-anchor/src/error.rs).
 */
export enum SignalingErrorCode {
  AlreadyInitialized = 1,
  AlreadyAnchored = 2,
  Unauthorized = 3,
  /** Contract method was called before initialize() ran (on-chain error #4). */
  NotInitialized = 4,

  // SDK-level codes
  SimulationFailed = 100,
  TransactionFailed = 101,
  TransactionTimeout = 102,
  MissingReturnValue = 103,
}

const SIGNALING_MESSAGES: Record<SignalingErrorCode, string> = {
  [SignalingErrorCode.AlreadyInitialized]: "Contract is already initialized",
  [SignalingErrorCode.AlreadyAnchored]: "This poll's result has already been anchored",
  [SignalingErrorCode.Unauthorized]: "Only the configured admin may anchor a result",
  [SignalingErrorCode.NotInitialized]: "Contract has not been initialized yet",
  [SignalingErrorCode.SimulationFailed]: "Simulation failed",
  [SignalingErrorCode.TransactionFailed]: "Transaction failed",
  [SignalingErrorCode.TransactionTimeout]: "Transaction timed out",
  [SignalingErrorCode.MissingReturnValue]: "No return value from contract",
};

export class SignalingError extends Error {
  readonly name = "SignalingError";

  constructor(
    public readonly code: SignalingErrorCode,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    Object.setPrototypeOf(this, SignalingError.prototype);
  }
}

/**
 * Parse a raw Soroban RPC error into a typed {@link SignalingError}.
 */
export function parseSignalingError(
  raw: SorobanRpcError | string | null | undefined,
  cause?: unknown,
): SignalingError {
  const contractCode = extractContractErrorCode(raw);
  if (contractCode !== null) {
    const code = contractCode as SignalingErrorCode;
    const message = SIGNALING_MESSAGES[code] ?? `Signal-anchor contract error #${contractCode}`;
    return new SignalingError(code, message, cause);
  }

  if (hasErrorStatus(raw)) {
    return new SignalingError(
      SignalingErrorCode.TransactionFailed,
      `${SIGNALING_MESSAGES[SignalingErrorCode.TransactionFailed]}: ${errorText(raw) || "unknown"}`,
      cause,
    );
  }

  return new SignalingError(
    SignalingErrorCode.SimulationFailed,
    `${SIGNALING_MESSAGES[SignalingErrorCode.SimulationFailed]}: ${errorText(raw) || "unknown"}`,
    cause,
  );
}

// ─── Proposal Bonds Errors ────────────────────────────────────────────────────

/**
 * Error codes for the ProposalBonds contract + SDK transport layer.
 *
 * Codes 1–99 mirror the on-chain ProposalBondsError enum values
 * (contracts/proposal-bonds/src/error.rs).
 */
export enum ProposalBondsErrorCode {
  AlreadyInitialized = 1,
  NotInitialized = 2,
  BondAlreadyLocked = 3,
  BondNotFound = 4,
  BondNotLocked = 5,
  DescriptionHashMismatch = 6,
  ProposalNotTerminal = 7,
  RefundGraceNotElapsed = 8,
  NotAuthorized = 9,
  InvalidBondAmount = 10,
  InvalidLockWindow = 11,

  // SDK-level codes
  SimulationFailed = 100,
  TransactionFailed = 101,
  TransactionTimeout = 102,
  MissingReturnValue = 103,
}

const PROPOSAL_BONDS_MESSAGES: Record<ProposalBondsErrorCode, string> = {
  [ProposalBondsErrorCode.AlreadyInitialized]: "Contract is already initialized",
  [ProposalBondsErrorCode.NotInitialized]: "Contract has not been initialized yet",
  [ProposalBondsErrorCode.BondAlreadyLocked]:
    "A bond has already been locked for this description hash",
  [ProposalBondsErrorCode.BondNotFound]: "Bond not found",
  [ProposalBondsErrorCode.BondNotLocked]: "Bond is not in the Locked state",
  [ProposalBondsErrorCode.DescriptionHashMismatch]:
    "The proposal's description hash does not match this bond",
  [ProposalBondsErrorCode.ProposalNotTerminal]:
    "The correlated proposal has not reached a terminal state",
  [ProposalBondsErrorCode.RefundGraceNotElapsed]:
    "The post-terminal refund grace window has not elapsed yet",
  [ProposalBondsErrorCode.NotAuthorized]: "Caller is not authorized to perform this action",
  [ProposalBondsErrorCode.InvalidBondAmount]: "Bond amount must be positive",
  [ProposalBondsErrorCode.InvalidLockWindow]: "Lock window must exceed grace period and be shorter than bond storage lifetime",
  [ProposalBondsErrorCode.SimulationFailed]: "Simulation failed",
  [ProposalBondsErrorCode.TransactionFailed]: "Transaction failed",
  [ProposalBondsErrorCode.TransactionTimeout]: "Transaction timed out",
  [ProposalBondsErrorCode.MissingReturnValue]: "No return value from contract",
};

export class ProposalBondsError extends Error {
  readonly name = "ProposalBondsError";

  constructor(
    public readonly code: ProposalBondsErrorCode,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    Object.setPrototypeOf(this, ProposalBondsError.prototype);
  }
}

/**
 * Parse a raw Soroban RPC error into a typed {@link ProposalBondsError}.
 */
export function parseProposalBondsError(
  raw: SorobanRpcError | string | null | undefined,
  cause?: unknown,
): ProposalBondsError {
  const contractCode = extractContractErrorCode(raw);
  if (contractCode !== null) {
    const code = contractCode as ProposalBondsErrorCode;
    const message =
      PROPOSAL_BONDS_MESSAGES[code] ?? `Proposal-bonds contract error #${contractCode}`;
    return new ProposalBondsError(code, message, cause);
  }

  if (hasErrorStatus(raw)) {
    return new ProposalBondsError(
      ProposalBondsErrorCode.TransactionFailed,
      `${PROPOSAL_BONDS_MESSAGES[ProposalBondsErrorCode.TransactionFailed]}: ${errorText(raw) || "unknown"}`,
      cause,
    );
  }

  return new ProposalBondsError(
    ProposalBondsErrorCode.SimulationFailed,
    `${PROPOSAL_BONDS_MESSAGES[ProposalBondsErrorCode.SimulationFailed]}: ${errorText(raw) || "unknown"}`,
    cause,
  );
}

/**
 * Parse a raw Soroban RPC error into a typed {@link VotesError}.
 */
export function parseVotesError(
  raw: SorobanRpcError | string | null | undefined,
  cause?: unknown,
): VotesError {
  const contractCode = extractContractErrorCode(raw);
  if (contractCode !== null) {
    const code = contractCode as VotesErrorCode;
    const message = VOTES_MESSAGES[code] ?? `Votes contract error #${contractCode}`;
    return new VotesError(code, message, cause);
  }

  if (hasErrorStatus(raw)) {
    return new VotesError(
      VotesErrorCode.TransactionFailed,
      `${VOTES_MESSAGES[VotesErrorCode.TransactionFailed]}: ${errorText(raw) || "unknown"}`,
      cause,
    );
  }

  return new VotesError(
    VotesErrorCode.SimulationFailed,
    `${VOTES_MESSAGES[VotesErrorCode.SimulationFailed]}: ${errorText(raw) || "unknown"}`,
    cause,
  );
}

// ─── Treasury Strategies Errors ───────────────────────────────────────────────

/**
 * Error codes for the treasury-strategies contract + SDK transport layer.
 *
 * Codes 1–99 mirror the on-chain TreasuryStrategiesError enum values
 * (contracts/treasury-strategies/src/lib.rs).
 */
export enum TreasuryStrategiesErrorCode {
  AlreadyInitialized = 1,
  NotAdmin = 2,
  NotTreasury = 3,
  StrategyNotFound = 4,
  NoActiveStrategy = 5,
  AllocationCapExceeded = 6,
  InsufficientAllocation = 7,
  WithdrawalNotFound = 8,
  WithdrawalAlreadyClaimed = 9,
  WithdrawalNotYetClaimable = 10,
  InvalidAmount = 11,
  InvalidBps = 12,

  // SDK-level codes
  SimulationFailed = 100,
  TransactionFailed = 101,
  TransactionTimeout = 102,
  MissingReturnValue = 103,
}

const TREASURY_STRATEGIES_MESSAGES: Record<TreasuryStrategiesErrorCode, string> = {
  [TreasuryStrategiesErrorCode.AlreadyInitialized]: "Contract is already initialized",
  [TreasuryStrategiesErrorCode.NotAdmin]: "Only the configured admin may perform this action",
  [TreasuryStrategiesErrorCode.NotTreasury]: "Only the configured treasury may perform this action",
  [TreasuryStrategiesErrorCode.StrategyNotFound]: "Strategy not found",
  [TreasuryStrategiesErrorCode.NoActiveStrategy]: "No active strategy is registered for this token",
  [TreasuryStrategiesErrorCode.AllocationCapExceeded]:
    "Deposit would exceed the strategy's max_allocation_bps cap",
  [TreasuryStrategiesErrorCode.InsufficientAllocation]:
    "Withdrawal amount exceeds the strategy's current allocation",
  [TreasuryStrategiesErrorCode.WithdrawalNotFound]: "Withdrawal request not found",
  [TreasuryStrategiesErrorCode.WithdrawalAlreadyClaimed]: "Withdrawal has already been claimed",
  [TreasuryStrategiesErrorCode.WithdrawalNotYetClaimable]:
    "Withdrawal cooldown has not elapsed yet",
  [TreasuryStrategiesErrorCode.InvalidAmount]: "Amount must be greater than zero",
  [TreasuryStrategiesErrorCode.InvalidBps]: "max_allocation_bps must not exceed 10000",
  [TreasuryStrategiesErrorCode.SimulationFailed]: "Simulation failed",
  [TreasuryStrategiesErrorCode.TransactionFailed]: "Transaction failed",
  [TreasuryStrategiesErrorCode.TransactionTimeout]: "Transaction timed out",
  [TreasuryStrategiesErrorCode.MissingReturnValue]: "No return value from contract",
};

export class TreasuryStrategiesError extends Error {
  readonly name = "TreasuryStrategiesError";

  constructor(
    public readonly code: TreasuryStrategiesErrorCode,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    Object.setPrototypeOf(this, TreasuryStrategiesError.prototype);
  }
}

/**
 * Parse a raw Soroban RPC error into a typed {@link TreasuryStrategiesError}.
 */
export function parseTreasuryStrategiesError(
  raw: SorobanRpcError | string | null | undefined,
  cause?: unknown,
): TreasuryStrategiesError {
  const contractCode = extractContractErrorCode(raw);
  if (contractCode !== null) {
    const code = contractCode as TreasuryStrategiesErrorCode;
    const message =
      TREASURY_STRATEGIES_MESSAGES[code] ?? `Treasury-strategies contract error #${contractCode}`;
    return new TreasuryStrategiesError(code, message, cause);
  }

  if (hasErrorStatus(raw)) {
    return new TreasuryStrategiesError(
      TreasuryStrategiesErrorCode.TransactionFailed,
      `${TREASURY_STRATEGIES_MESSAGES[TreasuryStrategiesErrorCode.TransactionFailed]}: ${errorText(raw) || "unknown"}`,
      cause,
    );
  }

  return new TreasuryStrategiesError(
    TreasuryStrategiesErrorCode.SimulationFailed,
    `${TREASURY_STRATEGIES_MESSAGES[TreasuryStrategiesErrorCode.SimulationFailed]}: ${errorText(raw) || "unknown"}`,
    cause,
  );
}

// ─── Conviction Voting Errors ────────────────────────────────────────────

/**
 * Error codes for the ConvictionVoting contract + SDK transport layer.
 *
 * Codes 1–99 mirror the on-chain ConvictionVotingError enum values
 * (contracts/conviction-voting/src/error.rs).
 */
export enum ConvictionVotingErrorCode {
  AlreadyInitialized = 1,
  NotInitialized = 2,
  InvalidConfiguration = 3,
  InvalidAmount = 4,
  ProposalNotFound = 5,
  ProposalClosed = 6,
  InsufficientVotingPower = 7,
  StakeNotFound = 8,
  Unauthorized = 9,
  ArithmeticOverflow = 10,
  InvalidCalldata = 11,

  // SDK-level codes
  SimulationFailed = 100,
  TransactionFailed = 101,
  TransactionTimeout = 102,
}

const CONVICTION_VOTING_MESSAGES: Record<ConvictionVotingErrorCode, string> = {
  [ConvictionVotingErrorCode.AlreadyInitialized]: "Contract is already initialized",
  [ConvictionVotingErrorCode.NotInitialized]: "Contract has not been initialized yet",
  [ConvictionVotingErrorCode.InvalidConfiguration]: "Invalid configuration parameters",
  [ConvictionVotingErrorCode.InvalidAmount]: "Amount must be positive",
  [ConvictionVotingErrorCode.ProposalNotFound]: "Proposal not found",
  [ConvictionVotingErrorCode.ProposalClosed]: "Proposal is closed or already executed",
  [ConvictionVotingErrorCode.InsufficientVotingPower]: "Insufficient voting power for this action",
  [ConvictionVotingErrorCode.StakeNotFound]: "No stake found for this account",
  [ConvictionVotingErrorCode.Unauthorized]: "Caller is not authorized to perform this action",
  [ConvictionVotingErrorCode.ArithmeticOverflow]: "Arithmetic overflow in conviction calculation",
  [ConvictionVotingErrorCode.InvalidCalldata]: "Calldata is invalid or malformed",
  [ConvictionVotingErrorCode.SimulationFailed]: "Simulation failed",
  [ConvictionVotingErrorCode.TransactionFailed]: "Transaction failed",
  [ConvictionVotingErrorCode.TransactionTimeout]: "Transaction timed out",
};

export class ConvictionVotingError extends Error {
  readonly name = "ConvictionVotingError";

  constructor(
    public readonly code: ConvictionVotingErrorCode,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    Object.setPrototypeOf(this, ConvictionVotingError.prototype);
  }
}

/**
 * Parse a raw Soroban RPC error into a typed {@link ConvictionVotingError}.
 */
export function parseConvictionVotingError(
  raw: SorobanRpcError | string | null | undefined,
  cause?: unknown,
): ConvictionVotingError {
  const contractCode = extractContractErrorCode(raw);
  if (contractCode !== null) {
    const code = contractCode as ConvictionVotingErrorCode;
    const message =
      CONVICTION_VOTING_MESSAGES[code] ?? `Conviction-voting contract error #${contractCode}`;
    return new ConvictionVotingError(code, message, cause);
  }

  if (hasErrorStatus(raw)) {
    return new ConvictionVotingError(
      ConvictionVotingErrorCode.TransactionFailed,
      `${CONVICTION_VOTING_MESSAGES[ConvictionVotingErrorCode.TransactionFailed]}: ${errorText(raw) || "unknown"}`,
      cause,
    );
  }

  return new ConvictionVotingError(
    ConvictionVotingErrorCode.SimulationFailed,
    `${CONVICTION_VOTING_MESSAGES[ConvictionVotingErrorCode.SimulationFailed]}: ${errorText(raw) || "unknown"}`,
    cause,
  );
}

// ─── Optimistic Governor Errors ───────────────────────────────────────────

/**
 * Error codes for the OptimisticGovernor contract + SDK transport layer.
 *
 * Codes 1–99 mirror the on-chain OptimisticGovernorError enum values
 * (contracts/optimistic-governor/src/error.rs).
 */
export enum OptimisticGovernorErrorCode {
  AlreadyInitialized = 1,
  NotInitialized = 2,
  InvalidConfiguration = 3,
  InvalidCalldata = 4,
  ProposalNotFound = 5,
  NotInChallengeWindow = 6,
  ChallengeWindowNotElapsed = 7,
  ChallengeWindowElapsed = 8,
  AlreadyObjected = 9,
  NoVotingPower = 10,
  ProposalObjected = 11,
  ProposalNotPassed = 12,
  ProposalAlreadyFinalized = 13,
  Unauthorized = 14,
  ArithmeticOverflow = 15,
  ProposalNotCancellable = 16,
  BondNotFound = 18,
  BondNotSettleable = 19,

  // SDK-level codes
  SimulationFailed = 100,
  TransactionFailed = 101,
  TransactionTimeout = 102,
}

const OPTIMISTIC_GOVERNOR_MESSAGES: Record<OptimisticGovernorErrorCode, string> = {
  [OptimisticGovernorErrorCode.AlreadyInitialized]: "Contract is already initialized",
  [OptimisticGovernorErrorCode.NotInitialized]: "Contract has not been initialized yet",
  [OptimisticGovernorErrorCode.InvalidConfiguration]: "Invalid configuration parameters",
  [OptimisticGovernorErrorCode.InvalidCalldata]: "Calldata is invalid or malformed",
  [OptimisticGovernorErrorCode.ProposalNotFound]: "Proposal not found",
  [OptimisticGovernorErrorCode.NotInChallengeWindow]: "Proposal is not in the challenge window",
  [OptimisticGovernorErrorCode.ChallengeWindowNotElapsed]: "Challenge window has not elapsed yet",
  [OptimisticGovernorErrorCode.ChallengeWindowElapsed]: "Challenge window has already elapsed",
  [OptimisticGovernorErrorCode.AlreadyObjected]: "Address has already objected to this proposal",
  [OptimisticGovernorErrorCode.NoVotingPower]: "Account has zero voting power",
  [OptimisticGovernorErrorCode.ProposalObjected]: "Proposal has been objected and is no longer passing",
  [OptimisticGovernorErrorCode.ProposalNotPassed]: "Proposal has not passed the challenge window",
  [OptimisticGovernorErrorCode.ProposalAlreadyFinalized]: "Proposal has already been finalized or objected",
  [OptimisticGovernorErrorCode.Unauthorized]: "Caller is not authorized to perform this action",
  [OptimisticGovernorErrorCode.ArithmeticOverflow]: "Arithmetic overflow in objection calculation",
  [OptimisticGovernorErrorCode.ProposalNotCancellable]: "Proposal cannot be cancelled in its current state",
  [OptimisticGovernorErrorCode.BondNotFound]: "No proposer bond is held for this proposal",
  [OptimisticGovernorErrorCode.BondNotSettleable]:
    "The bond can only be released or slashed after the proposal was objected",
  [OptimisticGovernorErrorCode.SimulationFailed]: "Simulation failed",
  [OptimisticGovernorErrorCode.TransactionFailed]: "Transaction failed",
  [OptimisticGovernorErrorCode.TransactionTimeout]: "Transaction timed out",
};

export class OptimisticGovernorError extends Error {
  readonly name = "OptimisticGovernorError";

  constructor(
    public readonly code: OptimisticGovernorErrorCode,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    Object.setPrototypeOf(this, OptimisticGovernorError.prototype);
  }
}

/**
 * Parse a raw Soroban RPC error into a typed {@link OptimisticGovernorError}.
 */
export function parseOptimisticGovernorError(
  raw: SorobanRpcError | string | null | undefined,
  cause?: unknown,
): OptimisticGovernorError {
  const contractCode = extractContractErrorCode(raw);
  if (contractCode !== null) {
    const code = contractCode as OptimisticGovernorErrorCode;
    const message =
      OPTIMISTIC_GOVERNOR_MESSAGES[code] ?? `Optimistic-governor contract error #${contractCode}`;
    return new OptimisticGovernorError(code, message, cause);
  }

  if (hasErrorStatus(raw)) {
    return new OptimisticGovernorError(
      OptimisticGovernorErrorCode.TransactionFailed,
      `${OPTIMISTIC_GOVERNOR_MESSAGES[OptimisticGovernorErrorCode.TransactionFailed]}: ${errorText(raw) || "unknown"}`,
      cause,
    );
  }

  return new OptimisticGovernorError(
    OptimisticGovernorErrorCode.SimulationFailed,
    `${OPTIMISTIC_GOVERNOR_MESSAGES[OptimisticGovernorErrorCode.SimulationFailed]}: ${errorText(raw) || "unknown"}`,
    cause,
  );
}

// ─── Voting Rewards Errors ───────────────────────────────────────────────────

/**
 * Error codes for the VotingRewards contract + SDK transport layer.
 *
 * Codes 1–99 mirror the on-chain VotingRewardsError enum values
 * (contracts/voting-rewards/src/error.rs).
 */
export enum VotingRewardsErrorCode {
  AlreadyInitialized = 1,
  NotInitialized = 2,
  NotAuthorized = 3,
  InvalidEpochDuration = 4,
  EpochNotFound = 5,
  EpochNotEnded = 6,
  EpochAlreadyFinalized = 7,
  EpochNotFinalized = 8,
  InsufficientPool = 9,
  InvalidAmount = 10,
  AlreadyClaimed = 11,
  InvalidProof = 12,
  EpochOverclaimed = 13,

  // SDK-level codes
  SimulationFailed = 100,
  TransactionFailed = 101,
  TransactionTimeout = 102,
  MissingReturnValue = 103,
}

const VOTING_REWARDS_MESSAGES: Record<VotingRewardsErrorCode, string> = {
  [VotingRewardsErrorCode.AlreadyInitialized]: "Contract is already initialized",
  [VotingRewardsErrorCode.NotInitialized]: "Contract has not been initialized yet",
  [VotingRewardsErrorCode.NotAuthorized]: "Caller is not authorized to perform this action",
  [VotingRewardsErrorCode.InvalidEpochDuration]: "Epoch duration must be greater than zero",
  [VotingRewardsErrorCode.EpochNotFound]: "Epoch not found",
  [VotingRewardsErrorCode.EpochNotEnded]: "The epoch's end ledger has not been reached yet",
  [VotingRewardsErrorCode.EpochAlreadyFinalized]:
    "This epoch's Merkle root has already been published",
  [VotingRewardsErrorCode.EpochNotFinalized]:
    "This epoch's Merkle root has not been published yet",
  [VotingRewardsErrorCode.InsufficientPool]:
    "The rewards pool does not hold enough unallocated balance for this amount",
  [VotingRewardsErrorCode.InvalidAmount]: "Amount must be greater than zero",
  [VotingRewardsErrorCode.AlreadyClaimed]: "This address has already claimed for this epoch",
  [VotingRewardsErrorCode.InvalidProof]:
    "The Merkle proof does not verify against this epoch's published root",
  [VotingRewardsErrorCode.EpochOverclaimed]:
    "This claim would exceed the epoch's total allocated rewards",
  [VotingRewardsErrorCode.SimulationFailed]: "Simulation failed",
  [VotingRewardsErrorCode.TransactionFailed]: "Transaction failed",
  [VotingRewardsErrorCode.TransactionTimeout]: "Transaction timed out",
  [VotingRewardsErrorCode.MissingReturnValue]: "No return value from contract",
};

export class VotingRewardsError extends Error {
  readonly name = "VotingRewardsError";

  constructor(
    public readonly code: VotingRewardsErrorCode,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    Object.setPrototypeOf(this, VotingRewardsError.prototype);
  }
}

/**
 * Parse a raw Soroban RPC error into a typed {@link VotingRewardsError}.
 */
export function parseVotingRewardsError(
  raw: SorobanRpcError | string | null | undefined,
  cause?: unknown,
): VotingRewardsError {
  const contractCode = extractContractErrorCode(raw);
  if (contractCode !== null) {
    const code = contractCode as VotingRewardsErrorCode;
    const message =
      VOTING_REWARDS_MESSAGES[code] ?? `Voting-rewards contract error #${contractCode}`;
    return new VotingRewardsError(code, message, cause);
  }

  if (hasErrorStatus(raw)) {
    return new VotingRewardsError(
      VotingRewardsErrorCode.TransactionFailed,
      `${VOTING_REWARDS_MESSAGES[VotingRewardsErrorCode.TransactionFailed]}: ${errorText(raw) || "unknown"}`,
      cause,
    );
  }

  return new VotingRewardsError(
    VotingRewardsErrorCode.SimulationFailed,
    `${VOTING_REWARDS_MESSAGES[VotingRewardsErrorCode.SimulationFailed]}: ${errorText(raw) || "unknown"}`,
    cause,
  );
}
