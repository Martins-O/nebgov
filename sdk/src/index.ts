/**
 * @nebgov/sdk — TypeScript SDK for the NebGov governance framework on Stellar.
 *
 * @example
 * import { GovernorClient, VotesClient, ProposalState, VoteSupport } from "@nebgov/sdk";
 *
 * const client = new GovernorClient({
 *   governorAddress: "CABC...",
 *   timelockAddress: "CDEF...",
 *   votesAddress: "CGHI...",
 *   network: "testnet",
 * });
 */

export { GovernorClient, hashDescription, uploadProposalMetadata } from "./governor";
export type { MetadataUploadOptions } from "./governor";
export { VotesClient } from "./votes";
export type { TopDelegatesOptions, TopDelegatesResult } from "./votes";
export { VoteEscrowClient } from "./voteEscrow";
export type { Lock as VoteEscrowLock, VoteEscrowStats } from "./voteEscrow";
export type { VoteEscrowConfig } from "./types";
export { DelegationSigClient } from "./delegation-sig";
export type { DelegationSigConfig, DelegationTxResult } from "./delegation-sig";
export { FactoryClient } from "./factory";
export type { GovernorEntry, DeploySettings } from "./factory";
export { TimelockClient } from "./timelock";
export { TreasuryClient } from "./treasury";
export { LiquidityClient } from "./liquidity";
export { AnalyticsClient } from "./analytics";
export { ReputationClient } from "./reputation";
export { GovernanceTuningClient } from "./governanceTuning";
export { ProposalSimulationClient } from "./proposalSimulation";
export { WrapperClient } from "./wrapper";
export type { WrapperConfig } from "./wrapper";
export { CoSponsorshipClient } from "./coSponsorship";
export type { CoSponsorshipConfig } from "./coSponsorship";
export { SignalingClient, canonicalSignalPayload, sep53Digest } from "./signaling";
export { ProposalBondsClient } from "./proposalBonds";
export type { ProposalBondsConfig } from "./proposalBonds";
export { VotingRewardsClient } from "./votingRewards";
export type { VotingRewardsConfig } from "./votingRewards";
export { TreasuryStrategiesClient } from "./treasuryStrategies";
export type { TreasuryStrategiesConfig } from "./treasuryStrategies";
export {
  TreasuryStreamsClient,
  TreasuryStreamsError,
  TreasuryStreamsErrorCode,
  mapTreasuryStream,
  parseTreasuryStreamsError,
} from "./treasuryStreams";
export type { TreasuryStream, TreasuryStreamsConfig } from "./treasuryStreams";
export { validateNetwork, getRpcUrl, getNetworkPassphrase, RPC_URLS, NETWORK_PASSPHRASES } from "./network";
export {
  GovernorError,
  GovernorErrorCode,
  TimelockError,
  TimelockErrorCode,
  VotesError,
  VotesErrorCode,
  TreasuryError,
  TreasuryErrorCode,
  CoSponsorshipError,
  CoSponsorshipErrorCode,
  SignalingError,
  SignalingErrorCode,
  ProposalBondsError,
  ProposalBondsErrorCode,
  TreasuryStrategiesError,
  TreasuryStrategiesErrorCode,
  VotingRewardsError,
  VotingRewardsErrorCode,
  parseGovernorError,
  parseTimelockError,
  parseVotesError,
  parseTreasuryError,
  parseCoSponsorshipError,
  parseSignalingError,
  parseProposalBondsError,
  parseTreasuryStrategiesError,
  parseVotingRewardsError,
  extractContractErrorCode,
} from "./errors";
export type { SorobanRpcError } from "./errors";
export type { RetryOptions, ClientRetryConfig, RetryFunction } from "./utils";
export {
  subscribeToProposals,
  subscribeToVotes,
  getProposalEvents,
  subscribeToProposalQueued,
  subscribeToProposalExecuted,
  subscribeToProposalCancelled,
  subscribeToProposalExpired,
  subscribeToGovernorUpgraded,
  subscribeToConfigUpdated,
  subscribeToReputationUpdated,
  subscribeToEffectiveThresholdChanged,
  subscribeToPauseEvents,
  subscribeToUnpauseEvents,
  subscribeToDraftCreated,
  subscribeToCoSponsored,
  subscribeToCoSponsorshipWithdrawn,
  subscribeToDraftFinalized,
  subscribeToDraftCancelled,
  subscribeToDraftExpired,
  subscribeToDelegatedBySig,
  subscribeToPermitsInvalidated,
  subscribeToRelayerWhitelistUpdated,
  subscribeToStreamCreated,
  subscribeToStreamSpend,
  subscribeToStreamBatchSpend,
  subscribeToStreamRevoked,
  subscribeToStreamExtended,
  subscribeToStreamToppedUp,
  subscribeToStreamExhausted,
  subscribeToStreamExpired,
  subscribeToOperationScheduled,
  subscribeToOperationExecuted,
  subscribeToOperationCancelled,
  subscribeToBatchOperationScheduled,
  subscribeToBatchOperationExecuted,
  subscribeToBatchOperationCancelled,
  subscribeToMinDelayUpdated,
  subscribeToDependencyDagValidated,
  subscribeToCycleDetected,
  subscribeToPartialBatchStarted,
  subscribeToPartialOpSucceeded,
  subscribeToPartialOpFailed,
  subscribeToBatchRecoveryEntered,
  subscribeToFailedOpRetried,
  subscribeToFailedOpSkipped,
  subscribeToBatchFullyComplete,
  subscribeToResultAnchored,
} from "./events";
export type {
  SorobanEvent,
  SubscriptionOptions,
  ProposalCreatedEventData,
  ProposalVetoedEventData,
  VoteCastEventData,
  ProposalQueuedEventData,
  ProposalExecutedEventData,
  ProposalCancelledEventData,
  ProposalExpiredEventData,
  GovernorUpgradedEventData,
  ConfigUpdatedEventData,
  ReputationUpdatedEventData,
  EffectiveThresholdChangedEventData,
  PauseEventData,
  UnpauseEventData,
  DraftCreatedEventData,
  CoSponsoredEventData,
  CoSponsorshipWithdrawnEventData,
  DraftFinalizedEventData,
  DraftCancelledEventData,
  DraftExpiredEventData,
  DelegatedBySigEventData,
  PermitsInvalidatedEventData,
  RelayerWhitelistUpdatedEventData,
  StreamCreatedEventData,
  StreamSpendEventData,
  StreamBatchSpendEventData,
  StreamRevokedEventData,
  StreamExtendedEventData,
  StreamToppedUpEventData,
  StreamExhaustedEventData,
  StreamExpiredEventData,
  OperationScheduledEventData,
  OperationExecutedEventData,
  OperationCancelledEventData,
  BatchOperationScheduledEventData,
  BatchOperationExecutedEventData,
  BatchOperationCancelledEventData,
  MinDelayUpdatedEventData,
  DependencyDagValidatedEventData,
  CycleDetectedEventData,
  PartialBatchStartedEventData,
  PartialOpSucceededEventData,
  PartialOpFailedEventData,
  BatchRecoveryEnteredEventData,
  FailedOpRetriedEventData,
  FailedOpSkippedEventData,
  BatchFullyCompleteEventData,
} from "./events";
export {
  parseProposalCreatedEvent,
  parseVoteCastEvent,
  parseProposalQueuedEvent,
  parseProposalVetoedEvent,
  parseProposalExecutedEvent,
  parseProposalCancelledEvent,
  parseProposalExpiredEvent,
  parseGovernorUpgradedEvent,
  parseConfigUpdatedEvent,
  parseReputationUpdatedEvent,
  parseEffectiveThresholdChangedEvent,
  parsePauseEvent,
  parseUnpauseEvent,
  parseDraftCreatedEvent,
  parseCoSponsoredEvent,
  parseCoSponsorshipWithdrawnEvent,
  parseDraftFinalizedEvent,
  parseDraftCancelledEvent,
  parseDraftExpiredEvent,
  parseDelegatedBySigEvent,
  parsePermitsInvalidatedEvent,
  parseRelayerWhitelistUpdatedEvent,
  parseStreamCreatedEvent,
  parseStreamSpendEvent,
  parseStreamBatchSpendEvent,
  parseStreamRevokedEvent,
  parseStreamExtendedEvent,
  parseStreamToppedUpEvent,
  parseStreamExhaustedEvent,
  parseStreamExpiredEvent,
  parseOperationScheduledEvent,
  parseOperationExecutedEvent,
  parseOperationCancelledEvent,
  parseBatchOperationScheduledEvent,
  parseBatchOperationExecutedEvent,
  parseBatchOperationCancelledEvent,
  parseMinDelayUpdatedEvent,
  parseDependencyDagValidatedEvent,
  parseCycleDetectedEvent,
  parsePartialBatchStartedEvent,
  parsePartialOpSucceededEvent,
  parsePartialOpFailedEvent,
  parseBatchRecoveryEnteredEvent,
  parseFailedOpRetriedEvent,
  parseFailedOpSkippedEvent,
  parseBatchFullyCompleteEvent,
} from "./events";
export * from "./types";
export { ConvictionVotingClient } from "./convictionVoting";
export { OptimisticGovernorClient } from "./optimisticGovernor";
export { computeQuadraticWeight, hexToBytes32, encodeCalldata, decodeCalldata } from "./utils";
export { streamEvents } from "./streamEvents";
export type { IndexerEvent, WsEventType, StreamEventsOptions, UnsubscribeFn } from "./streamEvents";
export { AmendmentsClient } from "./amendments";
export type { ProposalAmendment, AmendmentInput, JsonMergePatch } from "./amendments";

export { GuardianCouncilClient, encodeGuardianAction, decodeGuardianAction } from "./guardianCouncil";
export type { GuardianCouncilConfig, GuardianAction, PendingAction } from "./guardianCouncil";

// Namespaced standalone contract event helpers.
export {
  parseOptimisticProposalCreatedEvent,
  subscribeToOptimisticProposalCreated,
  parseOptimisticObjectionCastEvent,
  subscribeToOptimisticObjectionCast,
  parseOptimisticProposalObjectedEvent,
  subscribeToOptimisticProposalObjected,
  parseOptimisticProposalPassedEvent,
  subscribeToOptimisticProposalPassed,
  parseOptimisticProposalExecutedEvent,
  subscribeToOptimisticProposalExecuted,
  parseOptimisticProposalCancelledEvent,
  subscribeToOptimisticProposalCancelled,
  parseOptimisticProposalExpiredEvent,
  subscribeToOptimisticProposalExpired,
  parseOptimisticConfigUpdatedEvent,
  subscribeToOptimisticConfigUpdated,
  parseOptimisticBondConfigUpdatedEvent,
  subscribeToOptimisticBondConfigUpdated,
  parseOptimisticAdminUpdatedEvent,
  subscribeToOptimisticAdminUpdated,
  parseStrategyRegisteredEvent,
  subscribeToStrategyRegistered,
  parseStrategyDeactivatedEvent,
  subscribeToStrategyDeactivated,
  parseStrategyDepositedEvent,
  subscribeToStrategyDeposited,
  parseStrategyWithdrawalRequestedEvent,
  subscribeToStrategyWithdrawalRequested,
  parseStrategyWithdrawalClaimedEvent,
  subscribeToStrategyWithdrawalClaimed,
  parseBondLockedEvent,
  subscribeToBondLocked,
  parseBondRefundedEvent,
  subscribeToBondRefunded,
  parseBondSlashedEvent,
  subscribeToBondSlashed,
  parseBondAmountUpdatedEvent,
  subscribeToBondAmountUpdated,
  parseRecurringStreamCreatedEvent,
  subscribeToRecurringStreamCreated,
  parseRecurringStreamExecutedEvent,
  subscribeToRecurringStreamExecuted,
  parseRecurringStreamPausedEvent,
  subscribeToRecurringStreamPaused,
  parseRecurringStreamResumedEvent,
  subscribeToRecurringStreamResumed,
  parseRecurringStreamCancelledEvent,
  subscribeToRecurringStreamCancelled,
} from "./events";
export type {
  OptimisticProposalCreatedEventData,
  OptimisticObjectionCastEventData,
  OptimisticProposalObjectedEventData,
  OptimisticProposalPassedEventData,
  OptimisticProposalExecutedEventData,
  OptimisticProposalCancelledEventData,
  OptimisticProposalExpiredEventData,
  OptimisticConfigUpdatedEventData,
  OptimisticBondConfigUpdatedEventData,
  OptimisticAdminUpdatedEventData,
  StrategyRegisteredEventData,
  StrategyDeactivatedEventData,
  StrategyDepositedEventData,
  StrategyWithdrawalRequestedEventData,
  StrategyWithdrawalClaimedEventData,
  BondLockedEventData,
  BondRefundedEventData,
  BondSlashedEventData,
  BondAmountUpdatedEventData,
  RecurringStreamCreatedEventData,
  RecurringStreamExecutedEventData,
  RecurringStreamPausedEventData,
  RecurringStreamResumedEventData,
  RecurringStreamCancelledEventData,
} from "./events";
