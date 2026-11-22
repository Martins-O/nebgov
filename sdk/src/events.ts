import { SorobanRpc, scValToNative, xdr } from "@stellar/stellar-sdk";
import { GovernorSettings, Network, VoteType } from "./types";
import { withRetry } from "./utils";
import { getRpcUrl } from "./network";

const DEFAULT_POLL_INTERVAL_MS = 10_000;

const TOPICS = {
  proposalCreated: "ProposalCreated",
  voteCast: "VoteCast",
  voteCastWithReason: "VoteCastWithReason",
  proposalQueued: "ProposalQueued",
  proposalExecuted: "ProposalExecuted",
  proposalCancelled: "ProposalCancelled",
  proposalExpired: "ProposalExpired",
  governorUpgraded: "GovernorUpgraded",
  configUpdated: "ConfigUpdated",
  paused: "Paused",
  unpaused: "Unpaused",
  reputationUpdated: "ReputationUpdated",
  effectiveThresholdChanged: "EffectiveThresholdChanged",
  legacyProposalCreated: "prop_crtd",
  legacyVoteCast: "vote",
  legacyProposalExecuted: "execute",
} as const;

export interface SorobanEvent {
  ledger: number;
  contractId: string;
  topic: string[];
  value: unknown;
}

export interface ProposalCreatedEventData {
  proposalId: bigint;
  proposer: string;
  description: string;
  descriptionHash: string;
  metadataUri: string;
  targets: unknown[];
  fnNames: unknown[];
  calldatas: unknown[];
  startLedger: number;
  endLedger: number;
}

export interface VoteCastEventData {
  proposalId: bigint;
  voter: string;
  support: number;
  weight: bigint;
}

export interface VoteCastWithReasonEventData {
  proposalId: bigint;
  voter: string;
  support: number;
  weight: bigint;
  reason: string;
}

export interface ProposalQueuedEventData {
  proposalId: bigint;
  opId: unknown;
  eta: bigint;
}

export interface ProposalExecutedEventData {
  proposalId: bigint;
  caller: string;
}

export interface ProposalCancelledEventData {
  proposalId: bigint;
  caller: string;
}

export interface ProposalExpiredEventData {
  proposalId: bigint;
  expiredAtLedger: number;
}

export interface GovernorUpgradedEventData {
  oldHash: unknown;
  newHash: unknown;
}

export interface ConfigUpdatedEventData {
  oldSettings: GovernorSettings;
  newSettings: GovernorSettings;
}

export interface ReputationUpdatedEventData {
  proposer: string;
  oldScore: number;
  newScore: number;
  reason: string;
}

export interface EffectiveThresholdChangedEventData {
  proposer: string;
  oldThreshold: bigint;
  newThreshold: bigint;
}

export interface PauseEventData {
  pauser: string;
  ledger: number;
}

export interface UnpauseEventData {
  ledger: number;
}

export interface SubscriptionOptions {
  network: Network;
  rpcUrl?: string;
  intervalMs?: number;
  /** Maximum number of retry attempts for RPC calls (default: 3) */
  maxAttempts?: number;
  /** Base delay in milliseconds for exponential backoff (default: 1000) */
  baseDelayMs?: number;
}

type EventRecord = Record<string, unknown>;

function isRecord(value: unknown): value is EventRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toBigInt(value: unknown): bigint | null {
  try {
    if (typeof value === "bigint") return value;
    if (typeof value === "number" || typeof value === "string") return BigInt(value);
    return null;
  } catch {
    return null;
  }
}

/** Decoded `veto` (proposal vetoed from queue) event */
export interface ProposalVetoedEventData {
  proposalId: bigint;
  queueTime: bigint;
  currentLedger: bigint;
}

export function parseProposalVetoedEvent(
  event: SorobanEvent
): ProposalVetoedEventData | null {
  if (event.topic[0] !== "veto") return null;
  const raw = event.value;
  if (!Array.isArray(raw) || raw.length < 3) return null;
  try {
    return {
      proposalId: BigInt(raw[0] as number | bigint | string),
      queueTime: BigInt(raw[1] as number | bigint | string),
      currentLedger: BigInt(raw[2] as number | bigint | string),
    };
  } catch {
    return null;
  }
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && value.length > 0) {
    const parsed = Number(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

function toGovernorSettings(value: unknown): GovernorSettings | null {
  if (!isRecord(value)) return null;

  const votingDelay = toNumber(value.voting_delay);
  const votingPeriod = toNumber(value.voting_period);
  const quorumNumerator = toNumber(value.quorum_numerator);
  const proposalThreshold = toBigInt(value.proposal_threshold);
  const proposalGracePeriod = toNumber(value.proposal_grace_period);

  if (
    votingDelay === null ||
    votingPeriod === null ||
    quorumNumerator === null ||
    proposalThreshold === null ||
    proposalGracePeriod === null
  ) {
    return null;
  }

  return {
    votingDelay,
    votingPeriod,
    quorumNumerator,
    proposalThreshold,
    guardian: String(value.guardian ?? ""),
    voteType: VoteType.Extended,
    proposalGracePeriod,
    useDynamicQuorum: Boolean(value.use_dynamic_quorum),
    reflectorOracle:
      value.reflector_oracle === undefined || value.reflector_oracle === null
        ? null
        : String(value.reflector_oracle),
    minQuorumUsd: toBigInt(value.min_quorum_usd) ?? 0n,
    maxCalldataSize: toNumber(value.max_calldata_size) ?? 10_000,
    proposalCooldown: toNumber(value.proposal_cooldown) ?? 100,
    maxProposalsPerPeriod: toNumber(value.max_proposals_per_period) ?? 5,
    proposalPeriodDuration: toNumber(value.proposal_period_duration) ?? 10_000,
  };
}

function decodeEvent(raw: SorobanRpc.Api.EventResponse): SorobanEvent | null {
  try {
    const topic = raw.topic.map((segment) => String(scValToNative(segment)));
    const value = scValToNative(raw.value);

    return {
      ledger: raw.ledger,
      contractId: raw.contractId?.contractId() ?? "",
      topic,
      value,
    };
  } catch (error) {
    return null;
  }
}

function buildServer(opts: SubscriptionOptions): SorobanRpc.Server {
  return new SorobanRpc.Server(getRpcUrl(opts.network, opts.rpcUrl), {
    allowHttp: false,
  });
}

function createTopicSubscription(
  governorAddress: string,
  topicName: string,
  callback: (event: SorobanEvent) => void,
  opts: SubscriptionOptions,
  filter?: (event: SorobanEvent) => boolean
): () => void {
  const server = buildServer(opts);
  const topicFilter = [xdr.ScVal.scvSymbol(topicName)];
  const intervalMs = opts.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  let cursor = 0;
  let initialized = false;
  let stopped = false;

  async function poll(): Promise<void> {
    if (stopped) return;

    try {
      if (!initialized) {
        const latest = await withRetry(async () => await server.getLatestLedger(), {
          maxAttempts: opts.maxAttempts ?? 3,
          baseDelayMs: opts.baseDelayMs ?? 1000,
        });
        cursor = latest.sequence;
        initialized = true;
      }

      const { events, latestLedger } = await fetchEvents(
        server,
        governorAddress,
        topicFilter,
        cursor,
        { maxAttempts: opts.maxAttempts, baseDelayMs: opts.baseDelayMs }
      );

      for (const event of events) {
        if (!stopped && (!filter || filter(event))) callback(event);
      }

      cursor = latestLedger + 1;
    } catch {
      // Retry on the next interval.
    }
  }

  void poll();
  const handle = setInterval(() => void poll(), intervalMs);

  return () => {
    stopped = true;
    clearInterval(handle);
  };
}

export async function fetchEvents(
  server: SorobanRpc.Server,
  contractId: string,
  topicFilter: xdr.ScVal[],
  startLedger: number,
  opts: { maxAttempts?: number; baseDelayMs?: number } = {}
): Promise<{ events: SorobanEvent[]; latestLedger: number }> {
  return withRetry(async () => {
    const response = await server.getEvents({
      startLedger,
      filters: [
        {
          type: "contract",
          contractIds: [contractId],
          topics: [topicFilter.map((segment) => segment.toXDR("base64"))],
        },
      ],
      limit: 100,
    });

    return {
      events: (response.events ?? [])
        .map(decodeEvent)
        .filter((e): e is SorobanEvent => e !== null),
      latestLedger: response.latestLedger ? Number(response.latestLedger) : startLedger,
    };
  }, {
    maxAttempts: opts.maxAttempts ?? 3,
    baseDelayMs: opts.baseDelayMs ?? 1000,
    onRetry: (attempt, error) => {
      console.debug(`[fetchEvents] Retry attempt ${attempt} due to error:`, error);
    }
  });
}

export function parseProposalCreatedEvent(
  event: SorobanEvent
): ProposalCreatedEventData | null {
  if (event.topic[0] === TOPICS.legacyProposalCreated) {
    if (!Array.isArray(event.value) || event.value.length < 7 || event.topic.length < 2) {
      return null;
    }

    const proposalId = toBigInt(event.value[0]);
    const startLedger = toNumber(event.value[5]);
    const endLedger = toNumber(event.value[6]);

    if (proposalId === null || startLedger === null || endLedger === null) return null;

    return {
      proposalId,
      proposer: String(event.topic[1]),
      description: String(event.value[1] ?? ""),
      descriptionHash: "",
      metadataUri: "",
      targets: Array.isArray(event.value[2]) ? event.value[2] : [],
      fnNames: Array.isArray(event.value[3]) ? event.value[3] : [],
      calldatas: Array.isArray(event.value[4]) ? event.value[4] : [],
      startLedger,
      endLedger,
    };
  }

  if (event.topic[0] !== TOPICS.proposalCreated || !isRecord(event.value)) return null;

  const proposalId = toBigInt(event.value.proposal_id);
  const startLedger = toNumber(event.value.start_ledger);
  const endLedger = toNumber(event.value.end_ledger);

  if (proposalId === null || startLedger === null || endLedger === null) return null;

  return {
    proposalId,
    proposer: String(event.value.proposer ?? ""),
    description: String(event.value.description ?? ""),
    descriptionHash: String(event.value.description_hash ?? ""),
    metadataUri: String(event.value.metadata_uri ?? ""),
    targets: Array.isArray(event.value.targets) ? event.value.targets : [],
    fnNames: Array.isArray(event.value.fn_names) ? event.value.fn_names : [],
    calldatas: Array.isArray(event.value.calldatas) ? event.value.calldatas : [],
    startLedger,
    endLedger,
  };
}

export function parseVoteCastEvent(event: SorobanEvent): VoteCastEventData | null {
  if (event.topic[0] === TOPICS.legacyVoteCast) {
    if (!Array.isArray(event.value) || event.value.length < 3 || event.topic.length < 2) {
      return null;
    }

    const proposalId = toBigInt(event.value[0]);
    const weight = toBigInt(event.value[2]);

    if (proposalId === null || weight === null) return null;

    return {
      proposalId,
      voter: String(event.topic[1]),
      support: toNumber(event.value[1]) ?? -1,
      weight,
    };
  }

  if (event.topic[0] !== TOPICS.voteCast || !isRecord(event.value)) return null;

  const proposalId = toBigInt(event.value.proposal_id);
  const support = toNumber(event.value.support);
  const weight = toBigInt(event.value.weight);

  if (proposalId === null || support === null || weight === null) return null;

  return {
    proposalId,
    voter: String(event.value.voter ?? ""),
    support,
    weight,
  };
}

export function parseVoteCastWithReasonEvent(
  event: SorobanEvent
): VoteCastWithReasonEventData | null {
  if (event.topic[0] !== TOPICS.voteCastWithReason || !isRecord(event.value)) return null;

  const proposalId = toBigInt(event.value.proposal_id);
  const support = toNumber(event.value.support);
  const weight = toBigInt(event.value.weight);

  if (proposalId === null || support === null || weight === null) return null;

  return {
    proposalId,
    voter: String(event.value.voter ?? ""),
    support,
    weight,
    reason: String(event.value.reason ?? ""),
  };
}

export function parseProposalQueuedEvent(
  event: SorobanEvent
): ProposalQueuedEventData | null {
  if (event.topic[0] !== TOPICS.proposalQueued) return null;

  if (Array.isArray(event.value)) {
    const proposalId = toBigInt(event.value[0]);
    const eta = toBigInt(event.value[1]);
    if (proposalId === null || eta === null) return null;
    return { proposalId, opId: null, eta };
  }

  if (!isRecord(event.value)) return null;
  const proposalId = toBigInt(event.value.proposal_id);
  const eta = toBigInt(event.value.eta);

  if (proposalId === null || eta === null) return null;

  return {
    proposalId,
    opId: event.value.op_id ?? null,
    eta,
  };
}

export function parseProposalExecutedEvent(
  event: SorobanEvent
): ProposalExecutedEventData | null {
  if (event.topic[0] === TOPICS.legacyProposalExecuted) {
    const proposalId = toBigInt(event.value);
    if (proposalId === null) return null;
    return {
      proposalId,
      caller: "",
    };
  }

  if (event.topic[0] !== TOPICS.proposalExecuted || !isRecord(event.value)) return null;
  const proposalId = toBigInt(event.value.proposal_id);
  if (proposalId === null) return null;

  return {
    proposalId,
    caller: String(event.value.caller ?? ""),
  };
}

export function parseProposalCancelledEvent(
  event: SorobanEvent
): ProposalCancelledEventData | null {
  if (event.topic[0] !== TOPICS.proposalCancelled || !isRecord(event.value)) return null;
  const proposalId = toBigInt(event.value.proposal_id);
  if (proposalId === null) return null;

  return {
    proposalId,
    caller: String(event.value.caller ?? ""),
  };
}

export function parseProposalExpiredEvent(
  event: SorobanEvent
): ProposalExpiredEventData | null {
  if (event.topic[0] !== TOPICS.proposalExpired || !isRecord(event.value)) return null;
  const proposalId = toBigInt(event.value.proposal_id);
  const expiredAtLedger = toNumber(event.value.expired_at_ledger);

  if (proposalId === null || expiredAtLedger === null) return null;

  return {
    proposalId,
    expiredAtLedger,
  };
}

export function parseGovernorUpgradedEvent(
  event: SorobanEvent
): GovernorUpgradedEventData | null {
  if (event.topic[0] !== TOPICS.governorUpgraded || !isRecord(event.value)) return null;

  return {
    oldHash: event.value.old_hash ?? null,
    newHash: event.value.new_hash ?? null,
  };
}

export function parseConfigUpdatedEvent(
  event: SorobanEvent
): ConfigUpdatedEventData | null {
  if (event.topic[0] !== TOPICS.configUpdated || !isRecord(event.value)) return null;

  const oldSettings = toGovernorSettings(event.value.old_settings);
  const newSettings = toGovernorSettings(event.value.new_settings);

  if (!oldSettings || !newSettings) return null;

  return {
    oldSettings,
    newSettings,
  };
}

export function subscribeToProposals(
  governorAddress: string,
  callback: (event: SorobanEvent) => void,
  opts: SubscriptionOptions
): () => void {
  return createTopicSubscription(governorAddress, TOPICS.proposalCreated, callback, opts);
}

export function subscribeToVotes(
  governorAddress: string,
  proposalId: bigint,
  callback: (event: SorobanEvent) => void,
  opts: SubscriptionOptions
): () => void {
  return createTopicSubscription(
    governorAddress,
    TOPICS.voteCast,
    callback,
    opts,
    (event) => parseVoteCastEvent(event)?.proposalId === proposalId
  );
}

export function subscribeToVoteCastWithReason(
  governorAddress: string,
  proposalId: bigint,
  callback: (event: SorobanEvent) => void,
  opts: SubscriptionOptions
): () => void {
  return createTopicSubscription(
    governorAddress,
    TOPICS.voteCastWithReason,
    callback,
    opts,
    (event) => parseVoteCastWithReasonEvent(event)?.proposalId === proposalId
  );
}

export async function getProposalEvents(
  governorAddress: string,
  fromLedger: number,
  opts: SubscriptionOptions
): Promise<SorobanEvent[]> {
  const server = buildServer(opts);
  const latest = (await withRetry(async () => await server.getLatestLedger(), {
    maxAttempts: opts.maxAttempts ?? 3,
    baseDelayMs: opts.baseDelayMs ?? 1000,
  })).sequence;
  const topicFilter = [xdr.ScVal.scvSymbol(TOPICS.proposalCreated)];
  const events: SorobanEvent[] = [];
  let startLedger = Math.max(1, fromLedger);

  while (startLedger <= latest) {
    const { events: page, latestLedger } = await fetchEvents(
      server,
      governorAddress,
      topicFilter,
      startLedger,
      { maxAttempts: opts.maxAttempts, baseDelayMs: opts.baseDelayMs }
    );

    if (page.length === 0) {
      startLedger = latestLedger + 1;
      continue;
    }

    events.push(...page);
    startLedger = Math.max(...page.map((event) => event.ledger)) + 1;
  }

  return events;
}

export function subscribeToProposalQueued(
  governorAddress: string,
  callback: (event: SorobanEvent) => void,
  opts: SubscriptionOptions
): () => void {
  return createTopicSubscription(governorAddress, TOPICS.proposalQueued, callback, opts);
}

export function subscribeToProposalExecuted(
  governorAddress: string,
  callback: (event: SorobanEvent) => void,
  opts: SubscriptionOptions
): () => void {
  return createTopicSubscription(governorAddress, TOPICS.proposalExecuted, callback, opts);
}

export function subscribeToProposalCancelled(
  governorAddress: string,
  callback: (event: SorobanEvent) => void,
  opts: SubscriptionOptions
): () => void {
  return createTopicSubscription(governorAddress, TOPICS.proposalCancelled, callback, opts);
}

export function subscribeToProposalExpired(
  governorAddress: string,
  callback: (event: SorobanEvent) => void,
  opts: SubscriptionOptions
): () => void {
  return createTopicSubscription(governorAddress, TOPICS.proposalExpired, callback, opts);
}

export function subscribeToGovernorUpgraded(
  governorAddress: string,
  callback: (event: SorobanEvent) => void,
  opts: SubscriptionOptions
): () => void {
  return createTopicSubscription(governorAddress, TOPICS.governorUpgraded, callback, opts);
}

export function subscribeToConfigUpdated(
  governorAddress: string,
  callback: (event: SorobanEvent) => void,
  opts: SubscriptionOptions
): () => void {
  return createTopicSubscription(governorAddress, TOPICS.configUpdated, callback, opts);
}

export function parseReputationUpdatedEvent(
  event: SorobanEvent
): ReputationUpdatedEventData | null {
  if (event.topic[0] !== TOPICS.reputationUpdated || !isRecord(event.value)) return null;

  const oldScore = toNumber(event.value.old_score);
  const newScore = toNumber(event.value.new_score);

  if (oldScore === null || newScore === null) return null;

  return {
    proposer: String(event.value.proposer ?? event.topic[1] ?? ""),
    oldScore,
    newScore,
    reason: String(event.value.reason ?? ""),
  };
}

export function subscribeToReputationUpdated(
  governorAddress: string,
  callback: (event: SorobanEvent) => void,
  opts: SubscriptionOptions
): () => void {
  return createTopicSubscription(governorAddress, TOPICS.reputationUpdated, callback, opts);
}

export function parseEffectiveThresholdChangedEvent(
  event: SorobanEvent
): EffectiveThresholdChangedEventData | null {
  if (event.topic[0] !== TOPICS.effectiveThresholdChanged || !isRecord(event.value)) return null;

  const oldThreshold = toBigInt(event.value.old_threshold);
  const newThreshold = toBigInt(event.value.new_threshold);

  if (oldThreshold === null || newThreshold === null) return null;

  return {
    proposer: String(event.value.proposer ?? event.topic[1] ?? ""),
    oldThreshold,
    newThreshold,
  };
}

export function subscribeToEffectiveThresholdChanged(
  governorAddress: string,
  callback: (event: SorobanEvent) => void,
  opts: SubscriptionOptions
): () => void {
  return createTopicSubscription(governorAddress, TOPICS.effectiveThresholdChanged, callback, opts);
}

export function parsePauseEvent(event: SorobanEvent): PauseEventData | null {
  if (event.topic[0] !== TOPICS.paused) return null;
  if (!isRecord(event.value)) return null;

  const ledger = toNumber(event.value.ledger);
  if (ledger === null) return null;

  // The pauser address is the second topic segment when present; fall back to
  // the value field for completeness.
  const pauser = event.topic[1] ?? String(event.value.pauser ?? "");

  return { pauser: String(pauser), ledger };
}

export function parseUnpauseEvent(event: SorobanEvent): UnpauseEventData | null {
  if (event.topic[0] !== TOPICS.unpaused) return null;
  if (!isRecord(event.value)) return null;

  const ledger = toNumber(event.value.ledger);
  if (ledger === null) return null;

  return { ledger };
}

export function subscribeToPauseEvents(
  governorAddress: string,
  callback: (event: SorobanEvent) => void,
  opts: SubscriptionOptions
): () => void {
  return createTopicSubscription(governorAddress, TOPICS.paused, callback, opts);
}

export function subscribeToUnpauseEvents(
  governorAddress: string,
  callback: (event: SorobanEvent) => void,
  opts: SubscriptionOptions
): () => void {
  return createTopicSubscription(governorAddress, TOPICS.unpaused, callback, opts);
}

function toHex(value: unknown): string {
  if (value instanceof Uint8Array) return Buffer.from(value).toString("hex");
  return String(value ?? "");
}

// ── Co-sponsorship draft lifecycle events ───────────────────────────────────

const COSPONSOR_TOPICS = {
  draftCreated: "DraftCreated",
  coSponsored: "CoSponsored",
  coSponsorshipWithdrawn: "CoSponsorshipWithdrawn",
  draftFinalized: "DraftFinalized",
  draftCancelled: "DraftCancelled",
  draftExpired: "DraftExpired",
} as const;

export interface DraftCreatedEventData {
  draftId: bigint;
  creator: string;
  descriptionHash: string;
  metadataUri: string;
  createdLedger: number;
  expiryLedger: number;
}

export function parseDraftCreatedEvent(event: SorobanEvent): DraftCreatedEventData | null {
  if (event.topic[0] !== COSPONSOR_TOPICS.draftCreated || !isRecord(event.value)) return null;

  const draftId = toBigInt(event.value.draft_id);
  const createdLedger = toNumber(event.value.created_ledger);
  const expiryLedger = toNumber(event.value.expiry_ledger);

  if (draftId === null || createdLedger === null || expiryLedger === null) return null;

  return {
    draftId,
    creator: String(event.value.creator ?? event.topic[1] ?? ""),
    descriptionHash: toHex(event.value.description_hash),
    metadataUri: String(event.value.metadata_uri ?? ""),
    createdLedger,
    expiryLedger,
  };
}

export interface CoSponsoredEventData {
  draftId: bigint;
  sponsor: string;
  power: bigint;
  totalPower: bigint;
}

export function parseCoSponsoredEvent(event: SorobanEvent): CoSponsoredEventData | null {
  if (event.topic[0] !== COSPONSOR_TOPICS.coSponsored || !Array.isArray(event.value) || event.value.length < 3) {
    return null;
  }

  const draftId = toBigInt(event.value[0]);
  const power = toBigInt(event.value[1]);
  const totalPower = toBigInt(event.value[2]);

  if (draftId === null || power === null || totalPower === null) return null;

  return { draftId, sponsor: String(event.topic[1] ?? ""), power, totalPower };
}

export interface CoSponsorshipWithdrawnEventData {
  draftId: bigint;
  sponsor: string;
  power: bigint;
  totalPower: bigint;
}

export function parseCoSponsorshipWithdrawnEvent(
  event: SorobanEvent
): CoSponsorshipWithdrawnEventData | null {
  if (
    event.topic[0] !== COSPONSOR_TOPICS.coSponsorshipWithdrawn ||
    !Array.isArray(event.value) ||
    event.value.length < 3
  ) {
    return null;
  }

  const draftId = toBigInt(event.value[0]);
  const power = toBigInt(event.value[1]);
  const totalPower = toBigInt(event.value[2]);

  if (draftId === null || power === null || totalPower === null) return null;

  return { draftId, sponsor: String(event.topic[1] ?? ""), power, totalPower };
}

export interface DraftFinalizedEventData {
  draftId: bigint;
  proposalId: bigint;
}

export function parseDraftFinalizedEvent(event: SorobanEvent): DraftFinalizedEventData | null {
  if (event.topic[0] !== COSPONSOR_TOPICS.draftFinalized || !Array.isArray(event.value) || event.value.length < 2) {
    return null;
  }

  const draftId = toBigInt(event.value[0]);
  const proposalId = toBigInt(event.value[1]);

  if (draftId === null || proposalId === null) return null;

  return { draftId, proposalId };
}

export interface DraftCancelledEventData {
  draftId: bigint;
  caller: string;
}

export function parseDraftCancelledEvent(event: SorobanEvent): DraftCancelledEventData | null {
  if (event.topic[0] !== COSPONSOR_TOPICS.draftCancelled || !Array.isArray(event.value) || event.value.length < 2) {
    return null;
  }

  const draftId = toBigInt(event.value[0]);
  if (draftId === null) return null;

  return { draftId, caller: String(event.value[1] ?? "") };
}

export interface DraftExpiredEventData {
  draftId: bigint;
  expiredAtLedger: number;
}

export function parseDraftExpiredEvent(event: SorobanEvent): DraftExpiredEventData | null {
  if (event.topic[0] !== COSPONSOR_TOPICS.draftExpired || !Array.isArray(event.value) || event.value.length < 2) {
    return null;
  }

  const draftId = toBigInt(event.value[0]);
  const expiredAtLedger = toNumber(event.value[1]);

  if (draftId === null || expiredAtLedger === null) return null;

  return { draftId, expiredAtLedger };
}

export function subscribeToDraftCreated(
  coSponsorshipAddress: string,
  callback: (event: SorobanEvent) => void,
  opts: SubscriptionOptions
): () => void {
  return createTopicSubscription(coSponsorshipAddress, COSPONSOR_TOPICS.draftCreated, callback, opts);
}

export function subscribeToCoSponsored(
  coSponsorshipAddress: string,
  callback: (event: SorobanEvent) => void,
  opts: SubscriptionOptions
): () => void {
  return createTopicSubscription(coSponsorshipAddress, COSPONSOR_TOPICS.coSponsored, callback, opts);
}

export function subscribeToCoSponsorshipWithdrawn(
  coSponsorshipAddress: string,
  callback: (event: SorobanEvent) => void,
  opts: SubscriptionOptions
): () => void {
  return createTopicSubscription(coSponsorshipAddress, COSPONSOR_TOPICS.coSponsorshipWithdrawn, callback, opts);
}

export function subscribeToDraftFinalized(
  coSponsorshipAddress: string,
  callback: (event: SorobanEvent) => void,
  opts: SubscriptionOptions
): () => void {
  return createTopicSubscription(coSponsorshipAddress, COSPONSOR_TOPICS.draftFinalized, callback, opts);
}

export function subscribeToDraftCancelled(
  coSponsorshipAddress: string,
  callback: (event: SorobanEvent) => void,
  opts: SubscriptionOptions
): () => void {
  return createTopicSubscription(coSponsorshipAddress, COSPONSOR_TOPICS.draftCancelled, callback, opts);
}

export function subscribeToDraftExpired(
  coSponsorshipAddress: string,
  callback: (event: SorobanEvent) => void,
  opts: SubscriptionOptions
): () => void {
  return createTopicSubscription(coSponsorshipAddress, COSPONSOR_TOPICS.draftExpired, callback, opts);
}

// ── Token-votes signed ("gasless") delegation events (#913) ────────────────
//
// Struct-encoded events published by contracts/token-votes/src/events.rs's
// emit_delegated_by_sig / emit_permits_invalidated /
// emit_relayer_whitelist_updated, backing DelegationSigClient's
// delegate_by_sig / delegate_batch_by_sig flow.

const DELEGATION_SIG_TOPICS = {
  delegatedBySig: "DelegatedBySig",
  permitsInvalidated: "PermitsInvalidated",
  relayerWhitelistUpdated: "RelayerWhitelistUpdated",
} as const;

export interface DelegatedBySigEventData {
  delegator: string;
  delegatee: string;
  relayer: string;
  nonce: bigint;
}

export function parseDelegatedBySigEvent(
  event: SorobanEvent
): DelegatedBySigEventData | null {
  if (event.topic[0] !== DELEGATION_SIG_TOPICS.delegatedBySig || !isRecord(event.value)) {
    return null;
  }

  const nonce = toBigInt(event.value.nonce);
  if (nonce === null) return null;

  return {
    delegator: String(event.value.delegator ?? event.topic[1] ?? ""),
    delegatee: String(event.value.delegatee ?? ""),
    relayer: String(event.value.relayer ?? ""),
    nonce,
  };
}

export interface PermitsInvalidatedEventData {
  delegator: string;
  newNonce: bigint;
}

export function parsePermitsInvalidatedEvent(
  event: SorobanEvent
): PermitsInvalidatedEventData | null {
  if (event.topic[0] !== DELEGATION_SIG_TOPICS.permitsInvalidated || !isRecord(event.value)) {
    return null;
  }

  const newNonce = toBigInt(event.value.new_nonce);
  if (newNonce === null) return null;

  return {
    delegator: String(event.value.delegator ?? event.topic[1] ?? ""),
    newNonce,
  };
}

export interface RelayerWhitelistUpdatedEventData {
  relayer: string;
  whitelisted: boolean;
}

export function parseRelayerWhitelistUpdatedEvent(
  event: SorobanEvent
): RelayerWhitelistUpdatedEventData | null {
  if (event.topic[0] !== DELEGATION_SIG_TOPICS.relayerWhitelistUpdated || !isRecord(event.value)) {
    return null;
  }

  return {
    relayer: String(event.value.relayer ?? event.topic[1] ?? ""),
    whitelisted: Boolean(event.value.whitelisted),
  };
}

export function subscribeToDelegatedBySig(
  tokenVotesAddress: string,
  callback: (event: SorobanEvent) => void,
  opts: SubscriptionOptions
): () => void {
  return createTopicSubscription(
    tokenVotesAddress,
    DELEGATION_SIG_TOPICS.delegatedBySig,
    callback,
    opts
  );
}

export function subscribeToPermitsInvalidated(
  tokenVotesAddress: string,
  callback: (event: SorobanEvent) => void,
  opts: SubscriptionOptions
): () => void {
  return createTopicSubscription(
    tokenVotesAddress,
    DELEGATION_SIG_TOPICS.permitsInvalidated,
    callback,
    opts
  );
}

export function subscribeToRelayerWhitelistUpdated(
  tokenVotesAddress: string,
  callback: (event: SorobanEvent) => void,
  opts: SubscriptionOptions
): () => void {
  return createTopicSubscription(
    tokenVotesAddress,
    DELEGATION_SIG_TOPICS.relayerWhitelistUpdated,
    callback,
    opts
  );
}

// ── Treasury budget-stream events ───────────────────────────────────────────

const STREAM_TOPICS = {
  streamCreated: "stream_created",
  streamSpend: "stream_spend",
  streamBatchSpend: "stream_batch",
  streamRevoked: "stream_revoked",
  streamExtended: "stream_extended",
  streamToppedUp: "stream_topped_up",
  streamExhausted: "stream_exhausted",
  streamExpired: "stream_expired",
} as const;

export interface StreamCreatedEventData {
  streamId: bigint;
  name: string;
  owner: string;
}

export function parseStreamCreatedEvent(event: SorobanEvent): StreamCreatedEventData | null {
  if (event.topic[0] !== STREAM_TOPICS.streamCreated || !Array.isArray(event.value) || event.value.length < 3) {
    return null;
  }

  const streamId = toBigInt(event.value[0]);
  if (streamId === null) return null;

  return { streamId, name: String(event.value[1] ?? ""), owner: String(event.value[2] ?? "") };
}

export interface StreamSpendEventData {
  streamId: bigint;
  recipient: string;
  amount: bigint;
}

export function parseStreamSpendEvent(event: SorobanEvent): StreamSpendEventData | null {
  if (event.topic[0] !== STREAM_TOPICS.streamSpend || !Array.isArray(event.value) || event.value.length < 3) {
    return null;
  }

  const streamId = toBigInt(event.value[0]);
  const amount = toBigInt(event.value[2]);
  if (streamId === null || amount === null) return null;

  return { streamId, recipient: String(event.value[1] ?? ""), amount };
}

export interface StreamBatchSpendEventData {
  streamId: bigint;
  totalAmount: bigint;
  recipientCount: number;
}

export function parseStreamBatchSpendEvent(event: SorobanEvent): StreamBatchSpendEventData | null {
  if (event.topic[0] !== STREAM_TOPICS.streamBatchSpend || !Array.isArray(event.value) || event.value.length < 3) {
    return null;
  }

  const streamId = toBigInt(event.value[0]);
  const totalAmount = toBigInt(event.value[1]);
  const recipientCount = toNumber(event.value[2]);
  if (streamId === null || totalAmount === null || recipientCount === null) return null;

  return { streamId, totalAmount, recipientCount };
}

export interface StreamRevokedEventData {
  streamId: bigint;
  caller: string;
  unspentReturned: bigint;
}

export function parseStreamRevokedEvent(event: SorobanEvent): StreamRevokedEventData | null {
  if (event.topic[0] !== STREAM_TOPICS.streamRevoked || !Array.isArray(event.value) || event.value.length < 3) {
    return null;
  }

  const streamId = toBigInt(event.value[0]);
  const unspentReturned = toBigInt(event.value[2]);
  if (streamId === null || unspentReturned === null) return null;

  return { streamId, caller: String(event.value[1] ?? ""), unspentReturned };
}

export interface StreamExtendedEventData {
  streamId: bigint;
  oldEnd: number;
  newEnd: number;
}

export function parseStreamExtendedEvent(event: SorobanEvent): StreamExtendedEventData | null {
  if (event.topic[0] !== STREAM_TOPICS.streamExtended || !Array.isArray(event.value) || event.value.length < 3) {
    return null;
  }

  const streamId = toBigInt(event.value[0]);
  const oldEnd = toNumber(event.value[1]);
  const newEnd = toNumber(event.value[2]);
  if (streamId === null || oldEnd === null || newEnd === null) return null;

  return { streamId, oldEnd, newEnd };
}

export interface StreamToppedUpEventData {
  streamId: bigint;
  additional: bigint;
  newTotal: bigint;
}

export function parseStreamToppedUpEvent(event: SorobanEvent): StreamToppedUpEventData | null {
  if (event.topic[0] !== STREAM_TOPICS.streamToppedUp || !Array.isArray(event.value) || event.value.length < 3) {
    return null;
  }

  const streamId = toBigInt(event.value[0]);
  const additional = toBigInt(event.value[1]);
  const newTotal = toBigInt(event.value[2]);
  if (streamId === null || additional === null || newTotal === null) return null;

  return { streamId, additional, newTotal };
}

export interface StreamExhaustedEventData {
  streamId: bigint;
}

export function parseStreamExhaustedEvent(event: SorobanEvent): StreamExhaustedEventData | null {
  if (event.topic[0] !== STREAM_TOPICS.streamExhausted) return null;

  const streamId = toBigInt(event.value);
  if (streamId === null) return null;

  return { streamId };
}

export interface StreamExpiredEventData {
  streamId: bigint;
  unspent: bigint;
}

export function parseStreamExpiredEvent(event: SorobanEvent): StreamExpiredEventData | null {
  if (event.topic[0] !== STREAM_TOPICS.streamExpired || !Array.isArray(event.value) || event.value.length < 2) {
    return null;
  }

  const streamId = toBigInt(event.value[0]);
  const unspent = toBigInt(event.value[1]);
  if (streamId === null || unspent === null) return null;

  return { streamId, unspent };
}

export function subscribeToStreamCreated(
  treasuryAddress: string,
  callback: (event: SorobanEvent) => void,
  opts: SubscriptionOptions
): () => void {
  return createTopicSubscription(treasuryAddress, STREAM_TOPICS.streamCreated, callback, opts);
}

export function subscribeToStreamSpend(
  treasuryAddress: string,
  callback: (event: SorobanEvent) => void,
  opts: SubscriptionOptions
): () => void {
  return createTopicSubscription(treasuryAddress, STREAM_TOPICS.streamSpend, callback, opts);
}

export function subscribeToStreamBatchSpend(
  treasuryAddress: string,
  callback: (event: SorobanEvent) => void,
  opts: SubscriptionOptions
): () => void {
  return createTopicSubscription(treasuryAddress, STREAM_TOPICS.streamBatchSpend, callback, opts);
}

export function subscribeToStreamRevoked(
  treasuryAddress: string,
  callback: (event: SorobanEvent) => void,
  opts: SubscriptionOptions
): () => void {
  return createTopicSubscription(treasuryAddress, STREAM_TOPICS.streamRevoked, callback, opts);
}

export function subscribeToStreamExtended(
  treasuryAddress: string,
  callback: (event: SorobanEvent) => void,
  opts: SubscriptionOptions
): () => void {
  return createTopicSubscription(treasuryAddress, STREAM_TOPICS.streamExtended, callback, opts);
}

export function subscribeToStreamToppedUp(
  treasuryAddress: string,
  callback: (event: SorobanEvent) => void,
  opts: SubscriptionOptions
): () => void {
  return createTopicSubscription(treasuryAddress, STREAM_TOPICS.streamToppedUp, callback, opts);
}

export function subscribeToStreamExhausted(
  treasuryAddress: string,
  callback: (event: SorobanEvent) => void,
  opts: SubscriptionOptions
): () => void {
  return createTopicSubscription(treasuryAddress, STREAM_TOPICS.streamExhausted, callback, opts);
}

export function subscribeToStreamExpired(
  treasuryAddress: string,
  callback: (event: SorobanEvent) => void,
  opts: SubscriptionOptions
): () => void {
  return createTopicSubscription(treasuryAddress, STREAM_TOPICS.streamExpired, callback, opts);
}

// ── Timelock (including DAG partial-execution) events ───────────────────────

const TIMELOCK_TOPICS = {
  operationScheduled: "OperationScheduled",
  operationExecuted: "OperationExecuted",
  operationCancelled: "OperationCancelled",
  batchOperationScheduled: "BatchOperationScheduled",
  batchOperationExecuted: "BatchOperationExecuted",
  batchOperationCancelled: "BatchOperationCancelled",
  minDelayUpdated: "MinDelayUpdated",
  dependencyDagValidated: "DependencyDagValidated",
  cycleDetected: "CycleDetected",
  partialBatchStarted: "PartialBatchStarted",
  partialOpSucceeded: "PartialOpSucceeded",
  partialOpFailed: "PartialOpFailed",
  batchRecoveryEntered: "BatchRecoveryEntered",
  failedOpRetried: "FailedOpRetried",
  failedOpSkipped: "FailedOpSkipped",
  batchFullyComplete: "BatchFullyComplete",
} as const;

export interface OperationScheduledEventData {
  opId: string;
  target: string;
  fnName: string;
  readyAt: bigint;
  expiresAt: bigint;
}

export function parseOperationScheduledEvent(event: SorobanEvent): OperationScheduledEventData | null {
  if (event.topic[0] !== TIMELOCK_TOPICS.operationScheduled || !isRecord(event.value)) return null;

  const readyAt = toBigInt(event.value.ready_at);
  const expiresAt = toBigInt(event.value.expires_at);
  if (readyAt === null || expiresAt === null) return null;

  return {
    opId: toHex(event.value.op_id),
    target: String(event.value.target ?? ""),
    fnName: String(event.value.fn_name ?? ""),
    readyAt,
    expiresAt,
  };
}

export interface OperationExecutedEventData {
  opId: string;
  caller: string;
}

export function parseOperationExecutedEvent(event: SorobanEvent): OperationExecutedEventData | null {
  if (event.topic[0] !== TIMELOCK_TOPICS.operationExecuted || !isRecord(event.value)) return null;

  return { opId: toHex(event.value.op_id), caller: String(event.value.caller ?? "") };
}

export interface OperationCancelledEventData {
  opId: string;
  caller: string;
}

export function parseOperationCancelledEvent(event: SorobanEvent): OperationCancelledEventData | null {
  if (event.topic[0] !== TIMELOCK_TOPICS.operationCancelled || !isRecord(event.value)) return null;

  return { opId: toHex(event.value.op_id), caller: String(event.value.caller ?? "") };
}

export interface BatchOperationScheduledEventData {
  batchOpId: string;
  targets: string[];
  fnNames: string[];
  readyAt: bigint;
  expiresAt: bigint;
}

export function parseBatchOperationScheduledEvent(
  event: SorobanEvent
): BatchOperationScheduledEventData | null {
  if (event.topic[0] !== TIMELOCK_TOPICS.batchOperationScheduled || !isRecord(event.value)) return null;

  const readyAt = toBigInt(event.value.ready_at);
  const expiresAt = toBigInt(event.value.expires_at);
  if (readyAt === null || expiresAt === null) return null;

  return {
    batchOpId: toHex(event.value.batch_op_id),
    targets: Array.isArray(event.value.targets) ? event.value.targets.map((t) => String(t)) : [],
    fnNames: Array.isArray(event.value.fn_names) ? event.value.fn_names.map((f) => String(f)) : [],
    readyAt,
    expiresAt,
  };
}

export interface BatchOperationExecutedEventData {
  batchOpId: string;
  caller: string;
}

export function parseBatchOperationExecutedEvent(
  event: SorobanEvent
): BatchOperationExecutedEventData | null {
  if (event.topic[0] !== TIMELOCK_TOPICS.batchOperationExecuted || !isRecord(event.value)) return null;

  return { batchOpId: toHex(event.value.batch_op_id), caller: String(event.value.caller ?? "") };
}

export interface BatchOperationCancelledEventData {
  batchOpId: string;
  caller: string;
}

export function parseBatchOperationCancelledEvent(
  event: SorobanEvent
): BatchOperationCancelledEventData | null {
  if (event.topic[0] !== TIMELOCK_TOPICS.batchOperationCancelled || !isRecord(event.value)) return null;

  return { batchOpId: toHex(event.value.batch_op_id), caller: String(event.value.caller ?? "") };
}

export interface MinDelayUpdatedEventData {
  oldDelay: bigint;
  newDelay: bigint;
}

export function parseMinDelayUpdatedEvent(event: SorobanEvent): MinDelayUpdatedEventData | null {
  if (event.topic[0] !== TIMELOCK_TOPICS.minDelayUpdated || !isRecord(event.value)) return null;

  const oldDelay = toBigInt(event.value.old_delay);
  const newDelay = toBigInt(event.value.new_delay);
  if (oldDelay === null || newDelay === null) return null;

  return { oldDelay, newDelay };
}

export interface DependencyDagValidatedEventData {
  batchOpId: string;
  opCount: number;
}

export function parseDependencyDagValidatedEvent(
  event: SorobanEvent
): DependencyDagValidatedEventData | null {
  if (
    event.topic[0] !== TIMELOCK_TOPICS.dependencyDagValidated ||
    !Array.isArray(event.value) ||
    event.value.length < 2
  ) {
    return null;
  }

  const opCount = toNumber(event.value[1]);
  if (opCount === null) return null;

  return { batchOpId: toHex(event.value[0]), opCount };
}

export interface CycleDetectedEventData {
  cyclePath: string[];
}

export function parseCycleDetectedEvent(event: SorobanEvent): CycleDetectedEventData | null {
  if (event.topic[0] !== TIMELOCK_TOPICS.cycleDetected || !Array.isArray(event.value)) return null;

  return { cyclePath: event.value.map((segment) => toHex(segment)) };
}

export interface PartialBatchStartedEventData {
  batchOpId: string;
  totalOps: number;
}

export function parsePartialBatchStartedEvent(event: SorobanEvent): PartialBatchStartedEventData | null {
  if (
    event.topic[0] !== TIMELOCK_TOPICS.partialBatchStarted ||
    !Array.isArray(event.value) ||
    event.value.length < 2
  ) {
    return null;
  }

  const totalOps = toNumber(event.value[1]);
  if (totalOps === null) return null;

  return { batchOpId: toHex(event.value[0]), totalOps };
}

export interface PartialOpSucceededEventData {
  batchOpId: string;
  opId: string;
  completed: number;
  total: number;
}

export function parsePartialOpSucceededEvent(event: SorobanEvent): PartialOpSucceededEventData | null {
  if (
    event.topic[0] !== TIMELOCK_TOPICS.partialOpSucceeded ||
    !Array.isArray(event.value) ||
    event.value.length < 4
  ) {
    return null;
  }

  const completed = toNumber(event.value[2]);
  const total = toNumber(event.value[3]);
  if (completed === null || total === null) return null;

  return {
    batchOpId: toHex(event.value[0]),
    opId: toHex(event.value[1]),
    completed,
    total,
  };
}

export interface PartialOpFailedEventData {
  batchOpId: string;
  opId: string;
}

export function parsePartialOpFailedEvent(event: SorobanEvent): PartialOpFailedEventData | null {
  if (
    event.topic[0] !== TIMELOCK_TOPICS.partialOpFailed ||
    !Array.isArray(event.value) ||
    event.value.length < 2
  ) {
    return null;
  }

  return { batchOpId: toHex(event.value[0]), opId: toHex(event.value[1]) };
}

export interface BatchRecoveryEnteredEventData {
  batchOpId: string;
  recoveryDeadline: number;
}

export function parseBatchRecoveryEnteredEvent(
  event: SorobanEvent
): BatchRecoveryEnteredEventData | null {
  if (
    event.topic[0] !== TIMELOCK_TOPICS.batchRecoveryEntered ||
    !Array.isArray(event.value) ||
    event.value.length < 2
  ) {
    return null;
  }

  const recoveryDeadline = toNumber(event.value[1]);
  if (recoveryDeadline === null) return null;

  return { batchOpId: toHex(event.value[0]), recoveryDeadline };
}

export interface FailedOpRetriedEventData {
  batchOpId: string;
  opId: string;
  retryCount: number;
  succeeded: boolean;
}

export function parseFailedOpRetriedEvent(event: SorobanEvent): FailedOpRetriedEventData | null {
  if (
    event.topic[0] !== TIMELOCK_TOPICS.failedOpRetried ||
    !Array.isArray(event.value) ||
    event.value.length < 4
  ) {
    return null;
  }

  const retryCount = toNumber(event.value[2]);
  if (retryCount === null) return null;

  return {
    batchOpId: toHex(event.value[0]),
    opId: toHex(event.value[1]),
    retryCount,
    succeeded: Boolean(event.value[3]),
  };
}

export interface FailedOpSkippedEventData {
  batchOpId: string;
  opId: string;
}

export function parseFailedOpSkippedEvent(event: SorobanEvent): FailedOpSkippedEventData | null {
  if (
    event.topic[0] !== TIMELOCK_TOPICS.failedOpSkipped ||
    !Array.isArray(event.value) ||
    event.value.length < 2
  ) {
    return null;
  }

  return { batchOpId: toHex(event.value[0]), opId: toHex(event.value[1]) };
}

export interface BatchFullyCompleteEventData {
  batchOpId: string;
}

export function parseBatchFullyCompleteEvent(event: SorobanEvent): BatchFullyCompleteEventData | null {
  if (event.topic[0] !== TIMELOCK_TOPICS.batchFullyComplete) return null;

  return { batchOpId: toHex(event.value) };
}

export function subscribeToOperationScheduled(
  timelockAddress: string,
  callback: (event: SorobanEvent) => void,
  opts: SubscriptionOptions
): () => void {
  return createTopicSubscription(timelockAddress, TIMELOCK_TOPICS.operationScheduled, callback, opts);
}

export function subscribeToOperationExecuted(
  timelockAddress: string,
  callback: (event: SorobanEvent) => void,
  opts: SubscriptionOptions
): () => void {
  return createTopicSubscription(timelockAddress, TIMELOCK_TOPICS.operationExecuted, callback, opts);
}

export function subscribeToOperationCancelled(
  timelockAddress: string,
  callback: (event: SorobanEvent) => void,
  opts: SubscriptionOptions
): () => void {
  return createTopicSubscription(timelockAddress, TIMELOCK_TOPICS.operationCancelled, callback, opts);
}

export function subscribeToBatchOperationScheduled(
  timelockAddress: string,
  callback: (event: SorobanEvent) => void,
  opts: SubscriptionOptions
): () => void {
  return createTopicSubscription(timelockAddress, TIMELOCK_TOPICS.batchOperationScheduled, callback, opts);
}

export function subscribeToBatchOperationExecuted(
  timelockAddress: string,
  callback: (event: SorobanEvent) => void,
  opts: SubscriptionOptions
): () => void {
  return createTopicSubscription(timelockAddress, TIMELOCK_TOPICS.batchOperationExecuted, callback, opts);
}

export function subscribeToBatchOperationCancelled(
  timelockAddress: string,
  callback: (event: SorobanEvent) => void,
  opts: SubscriptionOptions
): () => void {
  return createTopicSubscription(timelockAddress, TIMELOCK_TOPICS.batchOperationCancelled, callback, opts);
}

export function subscribeToMinDelayUpdated(
  timelockAddress: string,
  callback: (event: SorobanEvent) => void,
  opts: SubscriptionOptions
): () => void {
  return createTopicSubscription(timelockAddress, TIMELOCK_TOPICS.minDelayUpdated, callback, opts);
}

export function subscribeToDependencyDagValidated(
  timelockAddress: string,
  callback: (event: SorobanEvent) => void,
  opts: SubscriptionOptions
): () => void {
  return createTopicSubscription(timelockAddress, TIMELOCK_TOPICS.dependencyDagValidated, callback, opts);
}

export function subscribeToCycleDetected(
  timelockAddress: string,
  callback: (event: SorobanEvent) => void,
  opts: SubscriptionOptions
): () => void {
  return createTopicSubscription(timelockAddress, TIMELOCK_TOPICS.cycleDetected, callback, opts);
}

export function subscribeToPartialBatchStarted(
  timelockAddress: string,
  callback: (event: SorobanEvent) => void,
  opts: SubscriptionOptions
): () => void {
  return createTopicSubscription(timelockAddress, TIMELOCK_TOPICS.partialBatchStarted, callback, opts);
}

export function subscribeToPartialOpSucceeded(
  timelockAddress: string,
  callback: (event: SorobanEvent) => void,
  opts: SubscriptionOptions
): () => void {
  return createTopicSubscription(timelockAddress, TIMELOCK_TOPICS.partialOpSucceeded, callback, opts);
}

export function subscribeToPartialOpFailed(
  timelockAddress: string,
  callback: (event: SorobanEvent) => void,
  opts: SubscriptionOptions
): () => void {
  return createTopicSubscription(timelockAddress, TIMELOCK_TOPICS.partialOpFailed, callback, opts);
}

export function subscribeToBatchRecoveryEntered(
  timelockAddress: string,
  callback: (event: SorobanEvent) => void,
  opts: SubscriptionOptions
): () => void {
  return createTopicSubscription(timelockAddress, TIMELOCK_TOPICS.batchRecoveryEntered, callback, opts);
}

export function subscribeToFailedOpRetried(
  timelockAddress: string,
  callback: (event: SorobanEvent) => void,
  opts: SubscriptionOptions
): () => void {
  return createTopicSubscription(timelockAddress, TIMELOCK_TOPICS.failedOpRetried, callback, opts);
}

export function subscribeToFailedOpSkipped(
  timelockAddress: string,
  callback: (event: SorobanEvent) => void,
  opts: SubscriptionOptions
): () => void {
  return createTopicSubscription(timelockAddress, TIMELOCK_TOPICS.failedOpSkipped, callback, opts);
}

export function subscribeToBatchFullyComplete(
  timelockAddress: string,
  callback: (event: SorobanEvent) => void,
  opts: SubscriptionOptions
): () => void {
  return createTopicSubscription(timelockAddress, TIMELOCK_TOPICS.batchFullyComplete, callback, opts);
}

const SIGNAL_ANCHOR_TOPICS = {
  resultAnchored: "ResultAnchored",
} as const;

export interface ResultAnchoredEventData {
  pollId: bigint;
  resultHash: string;
  anchoredLedger: number;
  anchorer: string;
}

export function parseResultAnchoredEvent(event: SorobanEvent): ResultAnchoredEventData | null {
  if (event.topic[0] !== SIGNAL_ANCHOR_TOPICS.resultAnchored || !Array.isArray(event.value) || event.value.length < 3) {
    return null;
  }

  const pollId = toBigInt(event.value[0]);
  const anchoredLedger = toNumber(event.value[2]);
  if (pollId === null || anchoredLedger === null) return null;

  const resultHashRaw = event.value[1];
  const resultHash = Buffer.isBuffer(resultHashRaw)
    ? resultHashRaw.toString("hex")
    : String(resultHashRaw ?? "");

  return {
    pollId,
    resultHash,
    anchoredLedger,
    anchorer: String(event.topic[1] ?? ""),
  };
}

export function subscribeToResultAnchored(
  signalAnchorAddress: string,
  callback: (event: SorobanEvent) => void,
  opts: SubscriptionOptions
): () => void {
  return createTopicSubscription(signalAnchorAddress, SIGNAL_ANCHOR_TOPICS.resultAnchored, callback, opts);
}

// ── Vote escrow events ─────────────────────────────────────────────────────

const VOTE_ESCROW_TOPICS = {
  lockCreated: "LockCreated",
  lockIncreased: "LockIncreased",
  lockExtended: "LockExtended",
  lockWithdrawn: "LockWithdrawn",
} as const;

export interface LockCreatedEventData {
  owner: string;
  amount: bigint;
  endLedger: number;
  initialVotingPower: bigint;
}

export interface LockIncreasedEventData {
  owner: string;
  addedAmount: bigint;
  newVotingPower: bigint;
}

export interface LockExtendedEventData {
  owner: string;
  oldEndLedger: number;
  newEndLedger: number;
}

export interface LockWithdrawnEventData {
  owner: string;
  amount: bigint;
}

export function parseLockCreatedEvent(event: SorobanEvent): LockCreatedEventData | null {
  if (event.topic[0] !== VOTE_ESCROW_TOPICS.lockCreated || !isRecord(event.value)) return null;
  const amount = toBigInt(event.value.amount);
  const endLedger = toNumber(event.value.end_ledger);
  const initialVotingPower = toBigInt(event.value.initial_voting_power);
  if (amount === null || endLedger === null || initialVotingPower === null) return null;
  return {
    owner: String(event.value.owner ?? event.topic[1] ?? ""),
    amount,
    endLedger,
    initialVotingPower,
  };
}

export function parseLockIncreasedEvent(event: SorobanEvent): LockIncreasedEventData | null {
  if (event.topic[0] !== VOTE_ESCROW_TOPICS.lockIncreased || !isRecord(event.value)) return null;
  const addedAmount = toBigInt(event.value.added_amount);
  const newVotingPower = toBigInt(event.value.new_voting_power);
  if (addedAmount === null || newVotingPower === null) return null;
  return {
    owner: String(event.value.owner ?? event.topic[1] ?? ""),
    addedAmount,
    newVotingPower,
  };
}

export function parseLockExtendedEvent(event: SorobanEvent): LockExtendedEventData | null {
  if (event.topic[0] !== VOTE_ESCROW_TOPICS.lockExtended || !isRecord(event.value)) return null;
  const oldEndLedger = toNumber(event.value.old_end_ledger);
  const newEndLedger = toNumber(event.value.new_end_ledger);
  if (oldEndLedger === null || newEndLedger === null) return null;
  return {
    owner: String(event.value.owner ?? event.topic[1] ?? ""),
    oldEndLedger,
    newEndLedger,
  };
}

export function parseLockWithdrawnEvent(event: SorobanEvent): LockWithdrawnEventData | null {
  if (event.topic[0] !== VOTE_ESCROW_TOPICS.lockWithdrawn || !isRecord(event.value)) return null;
  const amount = toBigInt(event.value.amount);
  if (amount === null) return null;
  return { owner: String(event.value.owner ?? event.topic[1] ?? ""), amount };
}

export function subscribeToLockCreated(address: string, callback: (event: SorobanEvent) => void, opts: SubscriptionOptions): () => void {
  return createTopicSubscription(address, VOTE_ESCROW_TOPICS.lockCreated, callback, opts);
}
export function subscribeToLockIncreased(address: string, callback: (event: SorobanEvent) => void, opts: SubscriptionOptions): () => void {
  return createTopicSubscription(address, VOTE_ESCROW_TOPICS.lockIncreased, callback, opts);
}
export function subscribeToLockExtended(address: string, callback: (event: SorobanEvent) => void, opts: SubscriptionOptions): () => void {
  return createTopicSubscription(address, VOTE_ESCROW_TOPICS.lockExtended, callback, opts);
}
export function subscribeToLockWithdrawn(address: string, callback: (event: SorobanEvent) => void, opts: SubscriptionOptions): () => void {
  return createTopicSubscription(address, VOTE_ESCROW_TOPICS.lockWithdrawn, callback, opts);
}

// ── Voting rewards events ──────────────────────────────────────────────────

const VOTING_REWARDS_TOPICS = {
  epochStarted: "EpochStarted",
  epochRootPublished: "EpochRootPublished",
  rewardClaimed: "RewardClaimed",
  poolFunded: "PoolFunded",
} as const;

export interface EpochStartedEventData { epochId: bigint; startLedger: number; endLedger: number }
export interface EpochRootPublishedEventData { epochId: bigint; merkleRoot: string; totalRewardAmount: bigint }
export interface RewardClaimedEventData { claimant: string; epochId: bigint; amount: bigint }
export interface PoolFundedEventData { funder: string; amount: bigint }

export function parseEpochStartedEvent(event: SorobanEvent): EpochStartedEventData | null {
  if (event.topic[0] !== VOTING_REWARDS_TOPICS.epochStarted || !Array.isArray(event.value) || event.value.length < 2) return null;
  const epochId = toBigInt(event.topic[1]);
  const startLedger = toNumber(event.value[0]);
  const endLedger = toNumber(event.value[1]);
  return epochId === null || startLedger === null || endLedger === null ? null : { epochId, startLedger, endLedger };
}

export function parseEpochRootPublishedEvent(event: SorobanEvent): EpochRootPublishedEventData | null {
  if (event.topic[0] !== VOTING_REWARDS_TOPICS.epochRootPublished || !Array.isArray(event.value) || event.value.length < 2) return null;
  const epochId = toBigInt(event.topic[1]);
  const totalRewardAmount = toBigInt(event.value[1]);
  if (epochId === null || totalRewardAmount === null) return null;
  return { epochId, merkleRoot: toHex(event.value[0]), totalRewardAmount };
}

export function parseRewardClaimedEvent(event: SorobanEvent): RewardClaimedEventData | null {
  if (event.topic[0] !== VOTING_REWARDS_TOPICS.rewardClaimed || !Array.isArray(event.value) || event.value.length < 2) return null;
  const epochId = toBigInt(event.value[0]);
  const amount = toBigInt(event.value[1]);
  return epochId === null || amount === null ? null : { claimant: String(event.topic[1] ?? ""), epochId, amount };
}

export function parsePoolFundedEvent(event: SorobanEvent): PoolFundedEventData | null {
  if (event.topic[0] !== VOTING_REWARDS_TOPICS.poolFunded) return null;
  const amount = toBigInt(event.value);
  return amount === null ? null : { funder: String(event.topic[1] ?? ""), amount };
}

export function subscribeToEpochStarted(address: string, callback: (event: SorobanEvent) => void, opts: SubscriptionOptions): () => void {
  return createTopicSubscription(address, VOTING_REWARDS_TOPICS.epochStarted, callback, opts);
}
export function subscribeToEpochRootPublished(address: string, callback: (event: SorobanEvent) => void, opts: SubscriptionOptions): () => void {
  return createTopicSubscription(address, VOTING_REWARDS_TOPICS.epochRootPublished, callback, opts);
}
export function subscribeToRewardClaimed(address: string, callback: (event: SorobanEvent) => void, opts: SubscriptionOptions): () => void {
  return createTopicSubscription(address, VOTING_REWARDS_TOPICS.rewardClaimed, callback, opts);
}
export function subscribeToPoolFunded(address: string, callback: (event: SorobanEvent) => void, opts: SubscriptionOptions): () => void {
  return createTopicSubscription(address, VOTING_REWARDS_TOPICS.poolFunded, callback, opts);
}

// ── Standalone governance and treasury contract events ───────────────────────
// Event names are namespaced to avoid collisions with core governor/budget streams.
// Soroban contracttype structs decode to snake_case objects; tuple values to arrays.
function eventFields(value: unknown, fields: string[]): Record<string, unknown> | null {
  if (isRecord(value)) return value;
  if (Array.isArray(value) && value.length >= fields.length) {
    return Object.fromEntries(fields.map((field, index) => [field, value[index]]));
  }
  return null;
}

export interface OptimisticProposalCreatedEventData { proposalId: bigint; proposer: string; challengeEndLedger: number }
export function parseOptimisticProposalCreatedEvent(event: SorobanEvent): OptimisticProposalCreatedEventData | null {
  if (event.topic[0] !== "ProposalCreated") return null;
  const id = toBigInt(event.topic[1]);
  if (id === null) return null;
  const data = eventFields(event.value, ["proposer", "challenge_end_ledger"]);
  if (!data) return null;
  if (typeof data.proposer !== "string") return null;
  const proposer = data.proposer;
  const challengeEndLedger = toNumber(data.challenge_end_ledger);
  if (challengeEndLedger === null || !Number.isFinite(challengeEndLedger)) return null;
  return { proposalId: id, proposer, challengeEndLedger };
}
export function subscribeToOptimisticProposalCreated(
  contractAddress: string,
  callback: (event: OptimisticProposalCreatedEventData) => void,
  opts: SubscriptionOptions
): () => void {
  return createTopicSubscription(contractAddress, "ProposalCreated", (event) => {
    const parsed = parseOptimisticProposalCreatedEvent(event);
    if (parsed) callback(parsed);
  }, opts);
}

export interface OptimisticObjectionCastEventData { proposalId: bigint; objector: string; weight: bigint; runningTotal: bigint }
export function parseOptimisticObjectionCastEvent(event: SorobanEvent): OptimisticObjectionCastEventData | null {
  if (event.topic[0] !== "ObjectionCast") return null;
  const id = toBigInt(event.topic[1]);
  if (id === null) return null;
  const data = eventFields(event.value, ["objector", "weight", "running_total"]);
  if (!data) return null;
  if (typeof data.objector !== "string") return null;
  const objector = data.objector;
  const weight = toBigInt(data.weight);
  if (weight === null) return null;
  const runningTotal = toBigInt(data.running_total);
  if (runningTotal === null) return null;
  return { proposalId: id, objector, weight, runningTotal };
}
export function subscribeToOptimisticObjectionCast(
  contractAddress: string,
  callback: (event: OptimisticObjectionCastEventData) => void,
  opts: SubscriptionOptions
): () => void {
  return createTopicSubscription(contractAddress, "ObjectionCast", (event) => {
    const parsed = parseOptimisticObjectionCastEvent(event);
    if (parsed) callback(parsed);
  }, opts);
}

export interface OptimisticProposalObjectedEventData { proposalId: bigint }
export function parseOptimisticProposalObjectedEvent(event: SorobanEvent): OptimisticProposalObjectedEventData | null {
  if (event.topic[0] !== "ProposalObjected") return null;
  const id = toBigInt(event.topic[1]);
  if (id === null) return null;
  return { proposalId: id };
}
export function subscribeToOptimisticProposalObjected(
  contractAddress: string,
  callback: (event: OptimisticProposalObjectedEventData) => void,
  opts: SubscriptionOptions
): () => void {
  return createTopicSubscription(contractAddress, "ProposalObjected", (event) => {
    const parsed = parseOptimisticProposalObjectedEvent(event);
    if (parsed) callback(parsed);
  }, opts);
}

export interface OptimisticProposalPassedEventData { proposalId: bigint }
export function parseOptimisticProposalPassedEvent(event: SorobanEvent): OptimisticProposalPassedEventData | null {
  if (event.topic[0] !== "ProposalPassed") return null;
  const id = toBigInt(event.topic[1]);
  if (id === null) return null;
  return { proposalId: id };
}
export function subscribeToOptimisticProposalPassed(
  contractAddress: string,
  callback: (event: OptimisticProposalPassedEventData) => void,
  opts: SubscriptionOptions
): () => void {
  return createTopicSubscription(contractAddress, "ProposalPassed", (event) => {
    const parsed = parseOptimisticProposalPassedEvent(event);
    if (parsed) callback(parsed);
  }, opts);
}

export interface OptimisticProposalExecutedEventData { proposalId: bigint }
export function parseOptimisticProposalExecutedEvent(event: SorobanEvent): OptimisticProposalExecutedEventData | null {
  if (event.topic[0] !== "ProposalExecuted") return null;
  const id = toBigInt(event.topic[1]);
  if (id === null) return null;
  return { proposalId: id };
}
export function subscribeToOptimisticProposalExecuted(
  contractAddress: string,
  callback: (event: OptimisticProposalExecutedEventData) => void,
  opts: SubscriptionOptions
): () => void {
  return createTopicSubscription(contractAddress, "ProposalExecuted", (event) => {
    const parsed = parseOptimisticProposalExecutedEvent(event);
    if (parsed) callback(parsed);
  }, opts);
}

export interface OptimisticProposalCancelledEventData { proposalId: bigint; caller: string }
export function parseOptimisticProposalCancelledEvent(event: SorobanEvent): OptimisticProposalCancelledEventData | null {
  if (event.topic[0] !== "ProposalCancelled") return null;
  const id = toBigInt(event.topic[1]);
  if (id === null) return null;
  const data = eventFields(event.value, ["caller"]);
  if (!data) return null;
  if (typeof data.caller !== "string") return null;
  const caller = data.caller;
  return { proposalId: id, caller };
}
export function subscribeToOptimisticProposalCancelled(
  contractAddress: string,
  callback: (event: OptimisticProposalCancelledEventData) => void,
  opts: SubscriptionOptions
): () => void {
  return createTopicSubscription(contractAddress, "ProposalCancelled", (event) => {
    const parsed = parseOptimisticProposalCancelledEvent(event);
    if (parsed) callback(parsed);
  }, opts);
}

export interface OptimisticProposalExpiredEventData { proposalId: bigint }
export function parseOptimisticProposalExpiredEvent(event: SorobanEvent): OptimisticProposalExpiredEventData | null {
  if (event.topic[0] !== "ProposalExpired") return null;
  const id = toBigInt(event.topic[1]);
  if (id === null) return null;
  return { proposalId: id };
}
export function subscribeToOptimisticProposalExpired(
  contractAddress: string,
  callback: (event: OptimisticProposalExpiredEventData) => void,
  opts: SubscriptionOptions
): () => void {
  return createTopicSubscription(contractAddress, "ProposalExpired", (event) => {
    const parsed = parseOptimisticProposalExpiredEvent(event);
    if (parsed) callback(parsed);
  }, opts);
}

export interface OptimisticConfigUpdatedEventData { challengeWindowLedgers: number; objectionThresholdBps: number; executionWindowLedgers: number }
export function parseOptimisticConfigUpdatedEvent(event: SorobanEvent): OptimisticConfigUpdatedEventData | null {
  if (event.topic[0] !== "ConfigUpdated") return null;
  const data = eventFields(event.value, ["challenge_window_ledgers", "objection_threshold_bps", "execution_window_ledgers"]);
  if (!data) return null;
  const challengeWindowLedgers = toNumber(data.challenge_window_ledgers);
  if (challengeWindowLedgers === null || !Number.isFinite(challengeWindowLedgers)) return null;
  const objectionThresholdBps = toNumber(data.objection_threshold_bps);
  if (objectionThresholdBps === null || !Number.isFinite(objectionThresholdBps)) return null;
  const executionWindowLedgers = toNumber(data.execution_window_ledgers);
  if (executionWindowLedgers === null || !Number.isFinite(executionWindowLedgers)) return null;
  return { challengeWindowLedgers, objectionThresholdBps, executionWindowLedgers };
}
export function subscribeToOptimisticConfigUpdated(
  contractAddress: string,
  callback: (event: OptimisticConfigUpdatedEventData) => void,
  opts: SubscriptionOptions
): () => void {
  return createTopicSubscription(contractAddress, "ConfigUpdated", (event) => {
    const parsed = parseOptimisticConfigUpdatedEvent(event);
    if (parsed) callback(parsed);
  }, opts);
}

export interface OptimisticBondConfigUpdatedEventData { amount: bigint; token: string }
export function parseOptimisticBondConfigUpdatedEvent(event: SorobanEvent): OptimisticBondConfigUpdatedEventData | null {
  if (event.topic[0] !== "BondConfigUpdated") return null;
  const data = eventFields(event.value, ["amount", "token"]);
  if (!data) return null;
  const amount = toBigInt(data.amount);
  if (amount === null) return null;
  if (typeof data.token !== "string") return null;
  const token = data.token;
  return { amount, token };
}
export function subscribeToOptimisticBondConfigUpdated(
  contractAddress: string,
  callback: (event: OptimisticBondConfigUpdatedEventData) => void,
  opts: SubscriptionOptions
): () => void {
  return createTopicSubscription(contractAddress, "BondConfigUpdated", (event) => {
    const parsed = parseOptimisticBondConfigUpdatedEvent(event);
    if (parsed) callback(parsed);
  }, opts);
}

export interface OptimisticAdminUpdatedEventData { oldAdmin: string; newAdmin: string }
export function parseOptimisticAdminUpdatedEvent(event: SorobanEvent): OptimisticAdminUpdatedEventData | null {
  if (event.topic[0] !== "AdminUpdated") return null;
  const data = eventFields(event.value, ["old_admin", "new_admin"]);
  if (!data) return null;
  if (typeof data.old_admin !== "string") return null;
  const oldAdmin = data.old_admin;
  if (typeof data.new_admin !== "string") return null;
  const newAdmin = data.new_admin;
  return { oldAdmin, newAdmin };
}
export function subscribeToOptimisticAdminUpdated(
  contractAddress: string,
  callback: (event: OptimisticAdminUpdatedEventData) => void,
  opts: SubscriptionOptions
): () => void {
  return createTopicSubscription(contractAddress, "AdminUpdated", (event) => {
    const parsed = parseOptimisticAdminUpdatedEvent(event);
    if (parsed) callback(parsed);
  }, opts);
}

export interface StrategyRegisteredEventData { strategyId: bigint; adapter: string; token: string }
export function parseStrategyRegisteredEvent(event: SorobanEvent): StrategyRegisteredEventData | null {
  if (event.topic[0] !== "StratReg") return null;
  const data = eventFields(event.value, ["strategy_id", "adapter", "token"]);
  if (!data) return null;
  const strategyId = toBigInt(data.strategy_id);
  if (strategyId === null) return null;
  if (typeof data.adapter !== "string") return null;
  const adapter = data.adapter;
  if (typeof data.token !== "string") return null;
  const token = data.token;
  return { strategyId, adapter, token };
}
export function subscribeToStrategyRegistered(
  contractAddress: string,
  callback: (event: StrategyRegisteredEventData) => void,
  opts: SubscriptionOptions
): () => void {
  return createTopicSubscription(contractAddress, "StratReg", (event) => {
    const parsed = parseStrategyRegisteredEvent(event);
    if (parsed) callback(parsed);
  }, opts);
}

export interface StrategyDeactivatedEventData { strategyId: bigint }
export function parseStrategyDeactivatedEvent(event: SorobanEvent): StrategyDeactivatedEventData | null {
  if (event.topic[0] !== "StratDeact") return null;
  const data = eventFields(event.value, ["strategy_id"]);
  if (!data) return null;
  const strategyId = toBigInt(data.strategy_id);
  if (strategyId === null) return null;
  return { strategyId };
}
export function subscribeToStrategyDeactivated(
  contractAddress: string,
  callback: (event: StrategyDeactivatedEventData) => void,
  opts: SubscriptionOptions
): () => void {
  return createTopicSubscription(contractAddress, "StratDeact", (event) => {
    const parsed = parseStrategyDeactivatedEvent(event);
    if (parsed) callback(parsed);
  }, opts);
}

export interface StrategyDepositedEventData { strategyId: bigint; amount: bigint }
export function parseStrategyDepositedEvent(event: SorobanEvent): StrategyDepositedEventData | null {
  if (event.topic[0] !== "Deposited") return null;
  const data = eventFields(event.value, ["strategy_id", "amount"]);
  if (!data) return null;
  const strategyId = toBigInt(data.strategy_id);
  if (strategyId === null) return null;
  const amount = toBigInt(data.amount);
  if (amount === null) return null;
  return { strategyId, amount };
}
export function subscribeToStrategyDeposited(
  contractAddress: string,
  callback: (event: StrategyDepositedEventData) => void,
  opts: SubscriptionOptions
): () => void {
  return createTopicSubscription(contractAddress, "Deposited", (event) => {
    const parsed = parseStrategyDepositedEvent(event);
    if (parsed) callback(parsed);
  }, opts);
}

export interface StrategyWithdrawalRequestedEventData { withdrawalId: bigint; strategyId: bigint; amount: bigint; claimableLedger: number }
export function parseStrategyWithdrawalRequestedEvent(event: SorobanEvent): StrategyWithdrawalRequestedEventData | null {
  if (event.topic[0] !== "WdrawReq") return null;
  const data = eventFields(event.value, ["withdrawal_id", "strategy_id", "amount", "claimable_ledger"]);
  if (!data) return null;
  const withdrawalId = toBigInt(data.withdrawal_id);
  if (withdrawalId === null) return null;
  const strategyId = toBigInt(data.strategy_id);
  if (strategyId === null) return null;
  const amount = toBigInt(data.amount);
  if (amount === null) return null;
  const claimableLedger = toNumber(data.claimable_ledger);
  if (claimableLedger === null || !Number.isFinite(claimableLedger)) return null;
  return { withdrawalId, strategyId, amount, claimableLedger };
}
export function subscribeToStrategyWithdrawalRequested(
  contractAddress: string,
  callback: (event: StrategyWithdrawalRequestedEventData) => void,
  opts: SubscriptionOptions
): () => void {
  return createTopicSubscription(contractAddress, "WdrawReq", (event) => {
    const parsed = parseStrategyWithdrawalRequestedEvent(event);
    if (parsed) callback(parsed);
  }, opts);
}

export interface StrategyWithdrawalClaimedEventData { withdrawalId: bigint; actualAmount: bigint }
export function parseStrategyWithdrawalClaimedEvent(event: SorobanEvent): StrategyWithdrawalClaimedEventData | null {
  if (event.topic[0] !== "WdrawClaim") return null;
  const data = eventFields(event.value, ["withdrawal_id", "actual_amount"]);
  if (!data) return null;
  const withdrawalId = toBigInt(data.withdrawal_id);
  if (withdrawalId === null) return null;
  const actualAmount = toBigInt(data.actual_amount);
  if (actualAmount === null) return null;
  return { withdrawalId, actualAmount };
}
export function subscribeToStrategyWithdrawalClaimed(
  contractAddress: string,
  callback: (event: StrategyWithdrawalClaimedEventData) => void,
  opts: SubscriptionOptions
): () => void {
  return createTopicSubscription(contractAddress, "WdrawClaim", (event) => {
    const parsed = parseStrategyWithdrawalClaimedEvent(event);
    if (parsed) callback(parsed);
  }, opts);
}

export interface BondLockedEventData { proposer: string; descriptionHash: unknown; amount: bigint }
export function parseBondLockedEvent(event: SorobanEvent): BondLockedEventData | null {
  if (event.topic[0] !== "BondLocked") return null;
  const data = eventFields(event.value, ["description_hash", "amount"]);
  if (!data) return null;
  if (typeof event.topic[1] !== "string") return null;
  const proposer = event.topic[1];
  const descriptionHash = data.description_hash;
  const amount = toBigInt(data.amount);
  if (amount === null) return null;
  return { proposer, descriptionHash, amount };
}
export function subscribeToBondLocked(
  contractAddress: string,
  callback: (event: BondLockedEventData) => void,
  opts: SubscriptionOptions
): () => void {
  return createTopicSubscription(contractAddress, "BondLocked", (event) => {
    const parsed = parseBondLockedEvent(event);
    if (parsed) callback(parsed);
  }, opts);
}

export interface BondRefundedEventData { proposer: string; descriptionHash: unknown; amount: bigint }
export function parseBondRefundedEvent(event: SorobanEvent): BondRefundedEventData | null {
  if (event.topic[0] !== "BondRefunded") return null;
  const data = eventFields(event.value, ["description_hash", "amount"]);
  if (!data) return null;
  if (typeof event.topic[1] !== "string") return null;
  const proposer = event.topic[1];
  const descriptionHash = data.description_hash;
  const amount = toBigInt(data.amount);
  if (amount === null) return null;
  return { proposer, descriptionHash, amount };
}
export function subscribeToBondRefunded(
  contractAddress: string,
  callback: (event: BondRefundedEventData) => void,
  opts: SubscriptionOptions
): () => void {
  return createTopicSubscription(contractAddress, "BondRefunded", (event) => {
    const parsed = parseBondRefundedEvent(event);
    if (parsed) callback(parsed);
  }, opts);
}

export interface BondSlashedEventData { proposer: string; descriptionHash: unknown; amount: bigint; recipient: string }
export function parseBondSlashedEvent(event: SorobanEvent): BondSlashedEventData | null {
  if (event.topic[0] !== "BondSlashed") return null;
  const data = eventFields(event.value, ["description_hash", "amount", "recipient"]);
  if (!data) return null;
  if (typeof event.topic[1] !== "string") return null;
  const proposer = event.topic[1];
  const descriptionHash = data.description_hash;
  const amount = toBigInt(data.amount);
  if (amount === null) return null;
  if (typeof data.recipient !== "string") return null;
  const recipient = data.recipient;
  return { proposer, descriptionHash, amount, recipient };
}
export function subscribeToBondSlashed(
  contractAddress: string,
  callback: (event: BondSlashedEventData) => void,
  opts: SubscriptionOptions
): () => void {
  return createTopicSubscription(contractAddress, "BondSlashed", (event) => {
    const parsed = parseBondSlashedEvent(event);
    if (parsed) callback(parsed);
  }, opts);
}

export interface BondAmountUpdatedEventData { admin: string; oldAmount: bigint; newAmount: bigint }
export function parseBondAmountUpdatedEvent(event: SorobanEvent): BondAmountUpdatedEventData | null {
  if (event.topic[0] !== "BondAmountUpdated") return null;
  const data = eventFields(event.value, ["old_amount", "new_amount"]);
  if (!data) return null;
  if (typeof event.topic[1] !== "string") return null;
  const admin = event.topic[1];
  const oldAmount = toBigInt(data.old_amount);
  if (oldAmount === null) return null;
  const newAmount = toBigInt(data.new_amount);
  if (newAmount === null) return null;
  return { admin, oldAmount, newAmount };
}
export function subscribeToBondAmountUpdated(
  contractAddress: string,
  callback: (event: BondAmountUpdatedEventData) => void,
  opts: SubscriptionOptions
): () => void {
  return createTopicSubscription(contractAddress, "BondAmountUpdated", (event) => {
    const parsed = parseBondAmountUpdatedEvent(event);
    if (parsed) callback(parsed);
  }, opts);
}

export interface RecurringStreamCreatedEventData { streamId: bigint; recipient: string; amountPerInterval: bigint; intervalLedgers: number }
export function parseRecurringStreamCreatedEvent(event: SorobanEvent): RecurringStreamCreatedEventData | null {
  if (event.topic[0] !== "StrmCreated") return null;
  const data = eventFields(event.value, ["stream_id", "recipient", "amount_per_interval", "interval_ledgers"]);
  if (!data) return null;
  const streamId = toBigInt(data.stream_id);
  if (streamId === null) return null;
  if (typeof data.recipient !== "string") return null;
  const recipient = data.recipient;
  const amountPerInterval = toBigInt(data.amount_per_interval);
  if (amountPerInterval === null) return null;
  const intervalLedgers = toNumber(data.interval_ledgers);
  if (intervalLedgers === null || !Number.isFinite(intervalLedgers)) return null;
  return { streamId, recipient, amountPerInterval, intervalLedgers };
}
export function subscribeToRecurringStreamCreated(
  contractAddress: string,
  callback: (event: RecurringStreamCreatedEventData) => void,
  opts: SubscriptionOptions
): () => void {
  return createTopicSubscription(contractAddress, "StrmCreated", (event) => {
    const parsed = parseRecurringStreamCreatedEvent(event);
    if (parsed) callback(parsed);
  }, opts);
}

export interface RecurringStreamExecutedEventData { streamId: bigint; amount: bigint; executedAtLedger: number }
export function parseRecurringStreamExecutedEvent(event: SorobanEvent): RecurringStreamExecutedEventData | null {
  if (event.topic[0] !== "StrmExec") return null;
  const data = eventFields(event.value, ["stream_id", "amount", "executed_at_ledger"]);
  if (!data) return null;
  const streamId = toBigInt(data.stream_id);
  if (streamId === null) return null;
  const amount = toBigInt(data.amount);
  if (amount === null) return null;
  const executedAtLedger = toNumber(data.executed_at_ledger);
  if (executedAtLedger === null || !Number.isFinite(executedAtLedger)) return null;
  return { streamId, amount, executedAtLedger };
}
export function subscribeToRecurringStreamExecuted(
  contractAddress: string,
  callback: (event: RecurringStreamExecutedEventData) => void,
  opts: SubscriptionOptions
): () => void {
  return createTopicSubscription(contractAddress, "StrmExec", (event) => {
    const parsed = parseRecurringStreamExecutedEvent(event);
    if (parsed) callback(parsed);
  }, opts);
}

export interface RecurringStreamPausedEventData { streamId: bigint }
export function parseRecurringStreamPausedEvent(event: SorobanEvent): RecurringStreamPausedEventData | null {
  if (event.topic[0] !== "StrmPaused") return null;
  const streamId = toBigInt(event.topic[1]);
  if (streamId === null) return null;
  return { streamId };
}
export function subscribeToRecurringStreamPaused(
  contractAddress: string,
  callback: (event: RecurringStreamPausedEventData) => void,
  opts: SubscriptionOptions
): () => void {
  return createTopicSubscription(contractAddress, "StrmPaused", (event) => {
    const parsed = parseRecurringStreamPausedEvent(event);
    if (parsed) callback(parsed);
  }, opts);
}

export interface RecurringStreamResumedEventData { streamId: bigint }
export function parseRecurringStreamResumedEvent(event: SorobanEvent): RecurringStreamResumedEventData | null {
  if (event.topic[0] !== "StrmResumed") return null;
  const streamId = toBigInt(event.topic[1]);
  if (streamId === null) return null;
  return { streamId };
}
export function subscribeToRecurringStreamResumed(
  contractAddress: string,
  callback: (event: RecurringStreamResumedEventData) => void,
  opts: SubscriptionOptions
): () => void {
  return createTopicSubscription(contractAddress, "StrmResumed", (event) => {
    const parsed = parseRecurringStreamResumedEvent(event);
    if (parsed) callback(parsed);
  }, opts);
}

export interface RecurringStreamCancelledEventData { streamId: bigint; totalStreamed: bigint }
export function parseRecurringStreamCancelledEvent(event: SorobanEvent): RecurringStreamCancelledEventData | null {
  if (event.topic[0] !== "StrmCancel") return null;
  const data = eventFields(event.value, ["stream_id", "total_streamed"]);
  if (!data) return null;
  const streamId = toBigInt(data.stream_id);
  if (streamId === null) return null;
  const totalStreamed = toBigInt(data.total_streamed);
  if (totalStreamed === null) return null;
  return { streamId, totalStreamed };
}
export function subscribeToRecurringStreamCancelled(
  contractAddress: string,
  callback: (event: RecurringStreamCancelledEventData) => void,
  opts: SubscriptionOptions
): () => void {
  return createTopicSubscription(contractAddress, "StrmCancel", (event) => {
    const parsed = parseRecurringStreamCancelledEvent(event);
    if (parsed) callback(parsed);
  }, opts);
}

