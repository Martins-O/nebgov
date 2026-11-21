import { SorobanRpc, scValToNative } from "@stellar/stellar-sdk";
import { createHash } from "crypto";
import { pool } from "./db";
import { invalidate, invalidatePattern } from "./cache";
import { broadcast, type WsEventType } from "./ws";
import {
  getAllStreamSpends,
  type TreasuryStateReader,
} from "./treasuryReader";
import {
  persistTreasuryStreamEvent,
  treasuryStreamEventExists,
  type TreasuryStreamEventRecord,
} from "./treasuryProjection";

/**
 * Normalises both legacy short-symbol topics (e.g. "prop_crtd") and the newer
 * PascalCase topics (e.g. "ProposalCreated") to a single canonical name so the
 * switch-case below can handle both contract versions without duplication.
 */
const TOPIC_MAP: Record<string, string> = {
  // Legacy → canonical
  prop_crtd: "ProposalCreated",
  vote: "VoteCast",
  vote_rsn: "VoteCastWithReason",
  queued: "ProposalQueued",
  executed: "ProposalExecuted",
  cancelled: "ProposalCancelled",
  delegate: "DelegateChanged",
  del_chsh: "DelegateChanged",
  config_updated: "ConfigUpdated",
  upgraded: "GovernorUpgraded",
  // New-form (already canonical — identity mappings keep the map exhaustive)
  ProposalCreated: "ProposalCreated",
  VoteCast: "VoteCast",
  VoteCastWithReason: "VoteCastWithReason",
  ProposalQueued: "ProposalQueued",
  ProposalExecuted: "ProposalExecuted",
  ProposalCancelled: "ProposalCancelled",
  DelegateChanged: "DelegateChanged",
  ConfigUpdated: "ConfigUpdated",
  GovernorUpgraded: "GovernorUpgraded",
  ReputationUpdated: "ReputationUpdated",
  EffectiveThresholdChanged: "EffectiveThresholdChanged",
  DelegatedBySig: "DelegatedBySig",
  PermitsInvalidated: "PermitsInvalidated",
  RelayerWhitelistUpdated: "RelayerWhitelistUpdated",
  stream_created: "stream_created",
  stream_spend: "stream_spend",
  stream_batch: "stream_batch",
  stream_revoked: "stream_revoked",
  stream_extended: "stream_extended",
  stream_topped_up: "stream_topped_up",
  stream_exhausted: "stream_exhausted",
  stream_expired: "stream_expired",
  ActionProposed: "ActionProposed",
  ActionApproved: "ActionApproved",
  ApprovalRevoked: "ApprovalRevoked",
  ActionExecuted: "ActionExecuted",
  MembershipRotated: "MembershipRotated",
  ThresholdUpdated: "ThresholdUpdated",
  ActionTtlUpdated: "ActionTtlUpdated",
};

export interface IndexerConfig {
  rpcUrl: string;
  governorAddress: string;
  wrapperAddress?: string;
  treasuryAddress?: string;
  liquidityAddress?: string;
  coSponsorshipAddress?: string;
  proposalBondsAddress?: string;
  tokenVotesAddress?: string;
  timelockAddress?: string;
  convictionVotingAddress?: string;
  signalAnchorAddress?: string;
  treasuryStrategiesAddress?: string;
  optimisticGovernorAddress?: string;
  voteEscrowAddress?: string;
  guardianCouncilAddress?: string;
  treasuryStateReader?: TreasuryStateReader;
  pollIntervalMs: number;
}

export async function getLastIndexedLedger(): Promise<number> {
  const res = await pool.query(
    "SELECT last_ledger FROM indexer_state WHERE id = 1",
  );
  return res.rows[0]?.last_ledger ?? 0;
}

export async function updateLastIndexedLedger(ledger: number): Promise<void> {
  await pool.query("UPDATE indexer_state SET last_ledger = $1 WHERE id = 1", [
    ledger,
  ]);
}

export async function processEvents(
  server: SorobanRpc.Server,
  config: IndexerConfig,
  startLedger: number,
): Promise<number> {
  let latestLedger = startLedger - 1;

  try {
    const contractIds = [config.governorAddress].filter(Boolean);
    if (config.wrapperAddress) contractIds.push(config.wrapperAddress);
    if (config.treasuryAddress) contractIds.push(config.treasuryAddress);
    if (config.liquidityAddress) contractIds.push(config.liquidityAddress);
    if (config.coSponsorshipAddress) contractIds.push(config.coSponsorshipAddress);
    if (config.proposalBondsAddress) contractIds.push(config.proposalBondsAddress);
    if (config.tokenVotesAddress) contractIds.push(config.tokenVotesAddress);
    if (config.timelockAddress) contractIds.push(config.timelockAddress);
    if (config.convictionVotingAddress) contractIds.push(config.convictionVotingAddress);
    if (config.signalAnchorAddress) contractIds.push(config.signalAnchorAddress);
    if (config.optimisticGovernorAddress)
      contractIds.push(config.optimisticGovernorAddress);
    if (config.voteEscrowAddress) contractIds.push(config.voteEscrowAddress);
    if (config.guardianCouncilAddress)
      contractIds.push(config.guardianCouncilAddress);

    const response = await server.getEvents({
      startLedger,
      filters: [
        {
          type: "contract",
          contractIds,
        },
      ],
      limit: 200,
    });

    for (const event of response.events) {
      const ledger = event.ledger;

      const topics = event.topic.map((t) => scValToNative(t));
      const rawEventType = topics[0] as string;
      const eventType = TOPIC_MAP[rawEventType] ?? rawEventType;
      // Soroban EventResponse includes contractId for contract events.
      const contractId = (event as any).contractId as string | undefined;
      const isWrapper = !!(
        contractId &&
        config.wrapperAddress &&
        contractId === config.wrapperAddress
      );
      const isTreasury = !!(
        contractId &&
        config.treasuryAddress &&
        contractId === config.treasuryAddress
      );
      const isLiquidity = !!(
        contractId &&
        config.liquidityAddress &&
        contractId === config.liquidityAddress
      );
      const isCoSponsorship = !!(
        contractId &&
        config.coSponsorshipAddress &&
        contractId === config.coSponsorshipAddress
      );
      const isProposalBonds = !!(
        contractId &&
        config.proposalBondsAddress &&
        contractId === config.proposalBondsAddress
      );
      const isTokenVotes = !!(
        contractId &&
        config.tokenVotesAddress &&
        contractId === config.tokenVotesAddress
      );
      const isTimelock = !!(
        contractId &&
        config.timelockAddress &&
        contractId === config.timelockAddress
      );
      const isConvictionVoting = !!(
        contractId &&
        config.convictionVotingAddress &&
        contractId === config.convictionVotingAddress
      );
      const isSignalAnchor = !!(
        contractId &&
        config.signalAnchorAddress &&
        contractId === config.signalAnchorAddress
      );
      const isTreasuryStrategies = !!(
        contractId &&
        config.treasuryStrategiesAddress &&
        contractId === config.treasuryStrategiesAddress
      );
      const isOptimisticGovernor = !!(
        contractId &&
        config.optimisticGovernorAddress &&
        contractId === config.optimisticGovernorAddress
      );
      const isVoteEscrow = !!(
        contractId && config.voteEscrowAddress && contractId === config.voteEscrowAddress
      );
      const isGuardianCouncil = !!(
        contractId &&
        config.guardianCouncilAddress &&
        contractId === config.guardianCouncilAddress
      );

      try {
        await logToEventLog(eventType, ledger, contractId, event, topics);
      } catch (err) {
        console.error(`Failed to write event_log entry for ${eventType}:`, err);
        throw err;
      }

      try {
        if (isConvictionVoting) {
          await handleConvictionEvent(event, eventType, topics);
        } else if (isTreasury) {
          switch (eventType) {
            case "bat_xfer":
              await handleTreasuryBatchTransfer(event, topics);
              break;
            case "stream_created":
            case "stream_spend":
            case "stream_batch":
            case "stream_revoked":
            case "stream_extended":
            case "stream_topped_up":
            case "stream_exhausted":
            case "stream_expired":
              await handleTreasuryStreamEvent(
                event,
                eventType,
                config.treasuryStateReader,
              );
              break;
            default:
              break;
          }
        } else if (isWrapper) {
          switch (eventType) {
            case "deposit":
            case "Deposit":
              await handleWrapperDeposit(event, topics);
              break;
            case "withdraw":
            case "Withdraw":
              await handleWrapperWithdraw(event, topics);
              break;
            case "DelegateChanged":
              await handleDelegateChanged(event, topics);
              break;
            default:
              break;
          }
        } else if (isLiquidity) {
          switch (eventType) {
            case "LiquidityAdded":
              await handleLiquidityAdded(event, topics);
              break;
            case "LiquidityRemoved":
              await handleLiquidityRemoved(event, topics);
              break;
            case "Swap":
              await handleSwap(event, topics);
              break;
            case "PoolFeeUpdated":
              await handlePoolFeeUpdated(event, topics);
              break;
            default:
              break;
          }
        } else if (isCoSponsorship) {
          switch (eventType) {
            case "DraftCreated":
              await handleDraftCreated(event, topics);
              break;
            case "CoSponsored":
              await handleCoSponsored(event, topics);
              break;
            case "CoSponsorshipWithdrawn":
              await handleCoSponsorshipWithdrawn(event, topics);
              break;
            case "DraftFinalized":
              await handleDraftFinalized(event);
              break;
            case "DraftCancelled":
              await handleDraftCancelled(event);
              break;
            case "DraftExpired":
              await handleDraftExpired(event);
              break;
            default:
              break;
          }
        } else if (isProposalBonds) {
          switch (eventType) {
            case "BondLocked":
              await handleBondLocked(event, topics);
              break;
            case "BondRefunded":
              await handleBondRefunded(event, topics);
              break;
            case "BondSlashed":
              await handleBondSlashed(event, topics);
              break;
            default:
              break;
          }
        } else if (isTokenVotes) {
          switch (eventType) {
            case "DelegateChanged":
              await handleDelegateChanged(event, topics);
              break;
            case "DelegationRegistered":
              await handleDelegationRegistered(event, topics);
              break;
            case "DelegationRevoked":
              await handleDelegationRevoked(event, topics);
              break;
            case "DelegationDepthLimitUpdated":
              await handleDelegationDepthLimitUpdated(event, topics);
              break;
            case "DelegatedBySig":
              await handleDelegatedBySig(event, topics);
              break;
            case "PermitsInvalidated":
              await handlePermitsInvalidated(event, topics);
              break;
            case "RelayerWhitelistUpdated":
              await handleRelayerWhitelistUpdated(event, topics);
              break;
            case "SplitDelegated":
              await handleSplitDelegated(event, topics);
              break;
            case "SplitUndelegated":
              await handleSplitUndelegated(event, topics);
              break;
            default:
              break;
          }
        } else if (isTimelock) {
          switch (eventType) {
            case "OperationScheduled":
              await handleTimelockOperationScheduled(event, topics);
              break;
            case "OperationExecuted":
              await handleTimelockOperationExecuted(event, topics);
              break;
            case "OperationCancelled":
              await handleTimelockOperationCancelled(event, topics);
              break;
            case "BatchOperationScheduled":
              await handleTimelockBatchOperationScheduled(event, topics);
              break;
            case "BatchOperationExecuted":
              await handleTimelockBatchOperationExecuted(event, topics);
              break;
            case "BatchOperationCancelled":
              await handleTimelockBatchOperationCancelled(event, topics);
              break;
            case "MinDelayUpdated":
              await handleTimelockMinDelayUpdated(event, topics);
              break;
            case "DependencyDagValidated":
              await handleTimelockDependencyDagValidated(event, topics);
              break;
            case "CycleDetected":
              await handleTimelockCycleDetected(event, topics);
              break;
            case "PartialBatchStarted":
              await handleTimelockPartialBatchStarted(event, topics);
              break;
            case "PartialOpSucceeded":
              await handleTimelockPartialOpSucceeded(event, topics);
              break;
            case "PartialOpFailed":
              await handleTimelockPartialOpFailed(event, topics);
              break;
            case "BatchRecoveryEntered":
              await handleTimelockBatchRecoveryEntered(event, topics);
              break;
            case "FailedOpRetried":
              await handleTimelockFailedOpRetried(event, topics);
              break;
            case "FailedOpSkipped":
              await handleTimelockFailedOpSkipped(event, topics);
              break;
            case "BatchFullyComplete":
              await handleTimelockBatchFullyComplete(event, topics);
              break;
            default:
              break;
          }
        } else if (isSignalAnchor) {
          switch (eventType) {
            case "ResultAnchored":
              await handleResultAnchored(event, topics);
              break;
            default:
              break;
          }
        } else if (isTreasuryStrategies) {
          switch (eventType) {
            case "StratReg":
              await handleStrategyRegistered(event, topics);
              break;
            case "StratDeact":
              await handleStrategyDeactivated(event, topics);
              break;
            case "Deposited":
              await handleStrategyDeposited(event, topics);
              break;
            case "WdrawReq":
              await handleStrategyWithdrawalRequested(event, topics);
              break;
            case "WdrawClaim":
              await handleStrategyWithdrawalClaimed(event, topics);
              break;
            default:
              break;
          }
        } else if (isOptimisticGovernor) {
          await handleOptimisticGovernorEvent(event, eventType, topics);
        } else if (isVoteEscrow) {
          await handleVoteEscrowEvent(event, eventType, topics);
        } else if (isGuardianCouncil) {
          await handleGuardianCouncilEvent(event, eventType, topics);
        } else {
          switch (eventType) {
            case "ProposalCreated":
              await handleProposalCreated(event, topics);
              break;
            case "VoteCast":
              await handleVoteCast(event, topics, false);
              break;
            case "VoteCastWithReason":
              await handleVoteCast(event, topics, true);
              break;
            case "ProposalQueued":
              await handleProposalQueued(topics);
              break;
            case "ProposalExecuted":
              await handleProposalExecuted(topics);
              break;
            case "ProposalCancelled":
              await handleProposalCancelled(event);
              break;
            case "DelegateChanged":
              await handleDelegateChanged(event, topics);
              break;
            case "ConfigUpdated":
              await handleConfigUpdated(event, topics);
              break;
            case "GovernorUpgraded":
              await handleGovernorUpgraded(event, topics);
              break;
            case "ReputationUpdated":
              await handleReputationUpdated(event, topics);
              break;
            case "EffectiveThresholdChanged":
              await handleEffectiveThresholdChanged(event, topics);
              break;
            default:
              break;
          }
        }
      } catch (err) {
        console.error(`Failed to process event ${eventType}:`, err);
        throw err;
      }
      if (ledger > latestLedger) latestLedger = ledger;
    }
  } catch (err) {
    console.error("Error fetching events:", err);
    throw err;
  }

  return latestLedger;
}

async function handleConvictionEvent(
  event: SorobanRpc.Api.EventResponse,
  eventType: string,
  topics: unknown[],
): Promise<void> {
  const proposalId = String(topics[1]);
  const raw = scValToNative(event.value) as unknown;
  const values = Array.isArray(raw) ? raw : [raw];

  switch (eventType) {
    case "ProposalCreated":
      await pool.query(
        `INSERT INTO conviction_proposals
           (proposal_id, proposer, target, requested_amount, created_ledger, last_updated_ledger)
         VALUES ($1, $2, $3, $4, $5, $5)
         ON CONFLICT (proposal_id) DO NOTHING`,
        [proposalId, String(values[0]), String(values[1]), String(values[2]), event.ledger],
      );
      break;
    case "StakeUpdated": {
      const staker = String(values[0]);
      const amount = BigInt(String(values[1]));
      if (amount === 0n) {
        await pool.query(
          "DELETE FROM conviction_stakes WHERE staker = $1 AND proposal_id = $2",
          [staker, proposalId],
        );
      } else {
        await pool.query(
          `INSERT INTO conviction_stakes (staker, proposal_id, amount, updated_at_ledger)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (staker) DO UPDATE SET proposal_id = EXCLUDED.proposal_id,
             amount = EXCLUDED.amount, updated_at_ledger = EXCLUDED.updated_at_ledger,
             updated_at = NOW()`,
          [staker, proposalId, amount.toString(), event.ledger],
        );
      }
      break;
    }
    case "ConvictionUpdated":
      await pool.query(
        `UPDATE conviction_proposals SET conviction = $2, last_updated_ledger = $3,
           updated_at = NOW() WHERE proposal_id = $1`,
        [proposalId, String(values[0]), event.ledger],
      );
      await pool.query(
        `INSERT INTO conviction_snapshots (proposal_id, ledger, conviction)
         VALUES ($1, $2, $3) ON CONFLICT (proposal_id, ledger)
         DO UPDATE SET conviction = EXCLUDED.conviction`,
        [proposalId, event.ledger, String(values[0])],
      );
      break;
    case "ProposalExecuted":
      await pool.query(
        "UPDATE conviction_proposals SET executed = TRUE, updated_at = NOW() WHERE proposal_id = $1",
        [proposalId],
      );
      break;
    case "ProposalCancelled":
      await pool.query(
        "UPDATE conviction_proposals SET cancelled = TRUE, updated_at = NOW() WHERE proposal_id = $1",
        [proposalId],
      );
      break;
    default:
      return;
  }
  invalidatePattern("conviction:");
  const wsTypes: Record<string, WsEventType> = {
    ProposalCreated: "conviction_proposal_created",
    StakeUpdated: "conviction_stake_updated",
    ConvictionUpdated: "conviction_conviction_updated",
    ProposalExecuted: "conviction_proposal_executed",
    ProposalCancelled: "conviction_proposal_cancelled",
  };
  broadcast({
    type: wsTypes[eventType],
    data: { proposal_id: proposalId, ledger: event.ledger },
  });
}

async function handleOptimisticGovernorEvent(
  event: SorobanRpc.Api.EventResponse,
  eventType: string,
  topics: unknown[],
): Promise<void> {
  const proposalId = String(topics[1]);
  const raw = scValToNative(event.value) as unknown;
  const values = Array.isArray(raw) ? raw : [raw];

  switch (eventType) {
    case "ProposalCreated": {
      const proposer = String(values[0]);
      const challengeEndLedger = String(values[1]);
      await pool.query(
        `INSERT INTO optimistic_proposals
           (proposal_id, proposer, created_ledger, challenge_end_ledger)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (proposal_id) DO NOTHING`,
        [proposalId, proposer, event.ledger, challengeEndLedger],
      );
      break;
    }
    case "ObjectionCast": {
      const objector = String(values[0]);
      const weight = String(values[1]);
      const runningTotal = String(values[2]);
      await pool.query(
        `INSERT INTO optimistic_objections (proposal_id, objector, weight, running_total, ledger)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (proposal_id, objector) DO NOTHING`,
        [proposalId, objector, weight, runningTotal, event.ledger],
      );
      await pool.query(
        `UPDATE optimistic_proposals SET objection_votes = $2, updated_at = NOW()
         WHERE proposal_id = $1`,
        [proposalId, runningTotal],
      );
      break;
    }
    case "ProposalObjected":
      await pool.query(
        "UPDATE optimistic_proposals SET state = 'objected', updated_at = NOW() WHERE proposal_id = $1",
        [proposalId],
      );
      break;
    case "ProposalPassed":
      await pool.query(
        "UPDATE optimistic_proposals SET state = 'passed', updated_at = NOW() WHERE proposal_id = $1",
        [proposalId],
      );
      break;
    case "ProposalExecuted":
      await pool.query(
        "UPDATE optimistic_proposals SET state = 'executed', updated_at = NOW() WHERE proposal_id = $1",
        [proposalId],
      );
      break;
    case "ProposalCancelled":
      await pool.query(
        "UPDATE optimistic_proposals SET state = 'cancelled', updated_at = NOW() WHERE proposal_id = $1",
        [proposalId],
      );
      break;
    default:
      return;
  }
  invalidatePattern("optimistic:");
  const wsTypes: Record<string, WsEventType> = {
    ProposalCreated: "optimistic_proposal_created",
    ObjectionCast: "optimistic_objection_cast",
    ProposalObjected: "optimistic_proposal_objected",
    ProposalPassed: "optimistic_proposal_passed",
    ProposalExecuted: "optimistic_proposal_executed",
    ProposalCancelled: "optimistic_proposal_cancelled",
  };
  broadcast({
    type: wsTypes[eventType],
    data: { proposal_id: proposalId, ledger: event.ledger },
  });
}

function indexerEventId(
  event: SorobanRpc.Api.EventResponse,
  eventType: string,
  contractAddress: string | undefined,
  serializedPayload: string,
): string {
  const rpcEventId = (event as SorobanRpc.Api.EventResponse & { id?: string }).id;
  if (rpcEventId) return rpcEventId;
  const digest = createHash("sha256")
    .update(
      [
        event.txHash ?? "",
        String(event.ledger),
        contractAddress ?? "",
        eventType,
        serializedPayload,
      ].join(":"),
    )
    .digest("hex");
  return `synthetic:${digest}`;
}

/**
 * Persists every parsed governance event to `event_log`, independent of
 * whether a dedicated handler exists for its type. This is the durable feed
 * the backend's notification engine polls to evaluate user-defined rules
 * (issue #774) without needing its own RPC subscription.
 */
async function logToEventLog(
  eventType: string,
  ledger: number,
  contractAddress: string | undefined,
  event: SorobanRpc.Api.EventResponse,
  topics: unknown[],
): Promise<void> {
  const payload = {
    topics,
    value: scValToNative(event.value),
    tx_hash: event.txHash,
  };
  const serializedPayload = stringifyJson(payload);
  const eventId = indexerEventId(
    event,
    eventType,
    contractAddress,
    serializedPayload,
  );

  await pool.query(
    `INSERT INTO event_log (
       event_id, event_type, ledger, transaction_hash, contract_address, payload
     )
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (event_id) DO NOTHING`,
    [
      eventId,
      eventType,
      ledger,
      event.txHash ?? null,
      contractAddress ?? "",
      serializedPayload,
    ],
  );
}

async function handleProposalCreated(
  event: SorobanRpc.Api.EventResponse,
  topics: unknown[],
): Promise<void> {
  const raw = scValToNative(event.value);
  let id: bigint;
  let proposer: string;
  let description: string;
  let descriptionHash: string | null;
  let startLedger: number;
  let endLedger: number;

  if (Array.isArray(raw)) {
    // Legacy tuple format from raw env.events().publish()
    id = raw[0] as bigint;
    proposer = topics[1] as string;
    description = String(raw[1] ?? "");
    descriptionHash = null;
    startLedger = raw[5] as number;
    endLedger = raw[6] as number;
  } else {
    // Struct format from emit_proposal_created()
    const data = raw as Record<string, unknown>;
    id = data.proposal_id as bigint;
    proposer = String(data.proposer ?? "");
    description = String(data.description ?? "");
    const descriptionHashRaw = data.description_hash as Uint8Array | undefined;
    descriptionHash = descriptionHashRaw
      ? Buffer.from(descriptionHashRaw).toString("hex")
      : null;
    startLedger = Number(data.start_ledger);
    endLedger = Number(data.end_ledger);
  }

  invalidatePattern("proposals:");
  await pool.query(
    `INSERT INTO proposals (id, proposer, description, description_hash, start_ledger, end_ledger)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (id) DO NOTHING`,
    [String(id), proposer, description, descriptionHash, startLedger, endLedger],
  );
  invalidate(`profile:${proposer}`);
  broadcast({
    type: "proposal_created",
    data: { id: String(id), proposer, description, start_ledger: startLedger, end_ledger: endLedger },
  });
}

async function handleVoteCast(
  event: SorobanRpc.Api.EventResponse,
  topics: unknown[],
  withReason: boolean,
): Promise<void> {
  const voter = topics[1] as string;
  const data = scValToNative(event.value) as unknown[];
  const proposalId = String(data[0] as bigint);
  const support = Number(data[1]);
  const weight = String(withReason ? data[3] : data[2]);
  const reason = withReason ? String(data[2]) : null;

  // Upsert vote
  await pool.query(
    `INSERT INTO votes (proposal_id, voter, support, weight, reason, ledger)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (proposal_id, voter) DO UPDATE SET
       support = EXCLUDED.support,
       weight = EXCLUDED.weight,
       reason = COALESCE(EXCLUDED.reason, votes.reason)`,
    [proposalId, voter, support, weight, reason, event.ledger],
  );

  // Update proposal vote tallies
  const col =
    support === 1
      ? "votes_for"
      : support === 0
        ? "votes_against"
        : "votes_abstain";
  await pool.query(`UPDATE proposals SET ${col} = ${col} + $1 WHERE id = $2`, [
    weight,
    proposalId,
  ]);
  invalidate(`proposal_votes:${proposalId}`, `profile:${voter}`);
  invalidatePattern("proposals:");
  broadcast({
    type: "vote_cast",
    data: { proposal_id: proposalId, voter, support, weight, reason: reason ?? undefined },
  });
}

async function handleProposalQueued(topics: unknown[]): Promise<void> {
  const proposalId = String(topics[1] as bigint);
  await pool.query("UPDATE proposals SET queued = true WHERE id = $1", [
    proposalId,
  ]);
  invalidate(`proposal_votes:${proposalId}`);
  invalidatePattern("proposals:");
  broadcast({ type: "proposal_queued", data: { proposal_id: proposalId } });
}

async function handleProposalExecuted(topics: unknown[]): Promise<void> {
  const proposalId = String(topics[1] as bigint);
  await pool.query("UPDATE proposals SET executed = true WHERE id = $1", [
    proposalId,
  ]);
  invalidate(`proposal_votes:${proposalId}`);
  invalidatePattern("proposals:");
  broadcast({ type: "proposal_executed", data: { proposal_id: proposalId } });
}

async function handleProposalCancelled(
  event: SorobanRpc.Api.EventResponse,
): Promise<void> {
  const data = scValToNative(event.value) as
    | [bigint, bigint, bigint]
    | { proposal_id?: bigint }
    | Map<string, bigint>;
  const proposalId = Array.isArray(data)
    ? data[0]
    : data instanceof Map
      ? data.get("proposal_id")
      : data?.proposal_id;

  if (proposalId === undefined) {
    throw new Error("ProposalCancelled event is missing proposal_id");
  }

  const id = String(proposalId);
  await pool.query("UPDATE proposals SET cancelled = true WHERE id = $1", [id]);
  invalidate(`proposal_votes:${id}`);
  invalidatePattern("proposals:");
  broadcast({ type: "proposal_cancelled", data: { proposal_id: id } });
}

async function handleDelegateChanged(
  event: SorobanRpc.Api.EventResponse,
  topics: unknown[],
): Promise<void> {
  const delegator = topics[1] as string;
  const data = scValToNative(event.value) as [string, string];
  const [oldDelegatee, newDelegatee] = data;

  await pool.query(
    `INSERT INTO delegates (delegator, old_delegatee, new_delegatee, ledger)
     VALUES ($1, $2, $3, $4)`,
    [delegator, oldDelegatee, newDelegatee, event.ledger],
  );
  invalidatePattern("delegates:");
  invalidate(`profile:${delegator}`);
  broadcast({
    type: "delegate_changed",
    data: { delegator, old_delegatee: oldDelegatee, new_delegatee: newDelegatee, ledger: event.ledger },
  });
}

async function handleDelegationRegistered(
  event: SorobanRpc.Api.EventResponse,
  topics: unknown[],
): Promise<void> {
  const delegator = topics[1] as string;
  const data = scValToNative(event.value) as [string, bigint, number];
  const [delegatee, power, chainDepth] = data;

  await pool.query(
    `INSERT INTO delegation_entries
       (delegator_address, delegatee_address, delegated_at_ledger, power_at_delegation, chain_depth, active)
     VALUES ($1, $2, $3, $4, $5, TRUE)`,
    [delegator, delegatee, event.ledger, String(power), chainDepth],
  );
  invalidatePattern("delegates:");
  invalidate(`profile:${delegator}`, `profile:${delegatee}`);
  broadcast({
    type: "delegation_registered",
    data: { delegator, delegatee, power: String(power), chain_depth: chainDepth, ledger: event.ledger },
  });
}

async function handleDelegationRevoked(
  event: SorobanRpc.Api.EventResponse,
  topics: unknown[],
): Promise<void> {
  const delegator = topics[1] as string;
  const data = scValToNative(event.value) as [string, number];
  const [previousDelegatee, atLedger] = data;

  await pool.query(
    `UPDATE delegation_entries
     SET active = FALSE, revoked_at_ledger = $3
     WHERE delegator_address = $1 AND delegatee_address = $2 AND active = TRUE`,
    [delegator, previousDelegatee, atLedger],
  );
  invalidatePattern("delegates:");
  invalidate(`profile:${delegator}`, `profile:${previousDelegatee}`);
  broadcast({
    type: "delegation_revoked",
    data: { delegator, previous_delegatee: previousDelegatee, ledger: atLedger },
  });
}

async function handleDelegationDepthLimitUpdated(
  event: SorobanRpc.Api.EventResponse,
  _topics: unknown[],
): Promise<void> {
  const data = scValToNative(event.value) as [number, number];
  const [oldLimit, newLimit] = data;

  broadcast({
    type: "delegation_depth_limit_updated",
    data: { old_limit: oldLimit, new_limit: newLimit, ledger: event.ledger },
  });
}

// --- Split delegation events (#994) ---
//
// `SplitDelegated` reports the delegator's full new set of (delegatee,
// weight_bps) targets, replacing (not merging with) whatever this delegator
// had on file. The contract emits per-entry `DelegationRegistered`/
// `DelegationRevoked` events immediately before/after (same tx) via the same
// delegation-registry bookkeeping the legacy single-delegate path uses, so
// `delegation_entries` (and therefore `/delegates/:address/delegators`)
// already reflects fractional split power with no extra handling here — we
// just look those rows up to get each entry's absolute `delegated_power`
// for the split-specific `split_delegations` table.

async function handleSplitDelegated(
  event: SorobanRpc.Api.EventResponse,
  topics: unknown[],
): Promise<void> {
  const delegator = topics[1] as string;
  const splits = scValToNative(event.value) as Array<{
    delegatee: string;
    weight_bps: number;
  }>;

  await pool.query(
    `UPDATE split_delegations SET active = FALSE, revoked_at = NOW()
     WHERE delegator_address = $1 AND active = TRUE`,
    [delegator],
  );

  for (const entry of splits) {
    const powerResult = await pool.query(
      `SELECT power_at_delegation FROM delegation_entries
       WHERE delegator_address = $1 AND delegatee_address = $2 AND active = TRUE
       ORDER BY id DESC LIMIT 1`,
      [delegator, entry.delegatee],
    );
    const delegatedPower = powerResult.rows[0]?.power_at_delegation ?? "0";

    await pool.query(
      `INSERT INTO split_delegations
         (delegator_address, delegatee_address, weight_bps, delegated_power, active)
       VALUES ($1, $2, $3, $4, TRUE)`,
      [delegator, entry.delegatee, entry.weight_bps, delegatedPower],
    );
  }

  invalidatePattern("delegates:");
  invalidatePattern("split-delegations:");
  invalidate(`profile:${delegator}`);
  broadcast({
    type: "split_delegated",
    data: { delegator, splits, ledger: event.ledger },
  });
}

async function handleSplitUndelegated(
  event: SorobanRpc.Api.EventResponse,
  topics: unknown[],
): Promise<void> {
  const delegator = topics[1] as string;

  await pool.query(
    `UPDATE split_delegations SET active = FALSE, revoked_at = NOW()
     WHERE delegator_address = $1 AND active = TRUE`,
    [delegator],
  );

  invalidatePattern("delegates:");
  invalidatePattern("split-delegations:");
  invalidate(`profile:${delegator}`);
  broadcast({
    type: "split_undelegated",
    data: { delegator, ledger: event.ledger },
  });
}

// --- Signed ("gasless") delegation events (#910) ---
//
// Backed by `delegated_by_sig_events` (one row per applied permit, powering
// GET /delegations/by-sig) and `relayer_whitelist_history` (append-only, so
// GET /relayers can report current status via a MAX(ledger)-per-relayer
// query while still preserving the whitelist/dewhitelist audit trail).
// PermitsInvalidated gets no dedicated table — like DelegationDepthLimitUpdated
// above, it's broadcast-only; the raw event is still captured in `event_log`.

async function handleDelegatedBySig(
  event: SorobanRpc.Api.EventResponse,
  topics: unknown[],
): Promise<void> {
  const delegator = topics[1] as string;
  const data = scValToNative(event.value) as {
    delegator: string;
    delegatee: string;
    relayer: string;
    nonce: bigint | number | string;
  };
  const nonce = String(data.nonce);

  await pool.query(
    `INSERT INTO delegated_by_sig_events
       (delegator_address, delegatee_address, relayer_address, nonce, ledger)
     VALUES ($1, $2, $3, $4, $5)`,
    [delegator, data.delegatee, data.relayer, nonce, event.ledger],
  );
  invalidatePattern("delegations_by_sig:");
  broadcast({
    type: "delegated_by_sig",
    data: {
      delegator,
      delegatee: data.delegatee,
      relayer: data.relayer,
      nonce,
      ledger: event.ledger,
    },
  });
}

async function handlePermitsInvalidated(
  event: SorobanRpc.Api.EventResponse,
  topics: unknown[],
): Promise<void> {
  const delegator = topics[1] as string;
  const data = scValToNative(event.value) as {
    delegator: string;
    new_nonce: bigint | number | string;
  };

  broadcast({
    type: "permits_invalidated",
    data: { delegator, new_nonce: String(data.new_nonce), ledger: event.ledger },
  });
}

async function handleRelayerWhitelistUpdated(
  event: SorobanRpc.Api.EventResponse,
  topics: unknown[],
): Promise<void> {
  const relayer = topics[1] as string;
  const data = scValToNative(event.value) as {
    relayer: string;
    whitelisted: boolean;
  };

  await pool.query(
    `INSERT INTO relayer_whitelist_history (relayer_address, whitelisted, ledger)
     VALUES ($1, $2, $3)`,
    [relayer, data.whitelisted, event.ledger],
  );
  invalidatePattern("relayers:");
  broadcast({
    type: "relayer_whitelist_updated",
    data: { relayer, whitelisted: data.whitelisted, ledger: event.ledger },
  });
}

// --- Proposer reputation events (#771) ---
//
// Backed by the `proposer_reputation` / `reputation_score_history` tables.
// `proposer_reputation` is a running snapshot upserted on every
// ReputationUpdated event, tracking just the score/ledger fields the event
// itself carries. Per-outcome breakdown counts (succeeded/executed/
// defeated/...) aren't tracked on-chain or here either — they're cheap to
// derive client-side from `reputation_score_history`'s `reason` column
// (see the profile page's outcome tally).

async function handleReputationUpdated(
  event: SorobanRpc.Api.EventResponse,
  topics: unknown[],
): Promise<void> {
  // The contract emits a #[contracttype] struct, which decodes to an object.
  const data = scValToNative(event.value) as {
    proposer: string;
    old_score: number;
    new_score: number;
    reason: string;
  };
  const proposer = String(data.proposer ?? topics[1]);
  const oldScore = Number(data.old_score);
  const newScore = Number(data.new_score);
  const reason = String(data.reason);

  await pool.query(
    `INSERT INTO proposer_reputation (proposer_address, reputation_score, last_updated_ledger)
     VALUES ($1, $2, $3)
     ON CONFLICT (proposer_address) DO UPDATE
       SET reputation_score = $2, last_updated_ledger = $3, updated_at = NOW()`,
    [proposer, newScore, event.ledger],
  );
  await pool.query(
    `INSERT INTO reputation_score_history (proposer_address, ledger, score, change, reason)
     VALUES ($1, $2, $3, $4, $5)`,
    [proposer, event.ledger, newScore, newScore - oldScore, reason],
  );
  invalidate(`reputation:${proposer}`);
  invalidatePattern("reputation:leaderboard");
  broadcast({
    type: "reputation_updated",
    data: { proposer, old_score: oldScore, new_score: newScore, reason, ledger: event.ledger },
  });
}

async function handleEffectiveThresholdChanged(
  event: SorobanRpc.Api.EventResponse,
  topics: unknown[],
): Promise<void> {
  // The contract emits a #[contracttype] struct, which decodes to an object.
  const data = scValToNative(event.value) as {
    proposer: string;
    old_threshold: bigint;
    new_threshold: bigint;
  };
  const proposer = String(data.proposer ?? topics[1]);
  const oldThreshold = BigInt(data.old_threshold);
  const newThreshold = BigInt(data.new_threshold);

  await pool.query(
    `INSERT INTO effective_threshold_history (proposer_address, ledger, old_threshold, new_threshold)
     VALUES ($1, $2, $3, $4)`,
    [proposer, event.ledger, oldThreshold.toString(), newThreshold.toString()],
  );

  broadcast({
    type: "effective_threshold_changed",
    data: {
      proposer,
      old_threshold: String(oldThreshold),
      new_threshold: String(newThreshold),
      ledger: event.ledger,
    },
  });
}


async function handleWrapperDeposit(
  event: SorobanRpc.Api.EventResponse,
  topics: unknown[],
): Promise<void> {
  const account = topics[1] as string;
  const data = scValToNative(event.value) as unknown[];
  const amount = String(data[1] as bigint);

  await pool.query(
    `INSERT INTO wrapper_deposits (account, amount, ledger)
     VALUES ($1, $2, $3)`,
    [account, amount, event.ledger],
  );
  invalidate(`profile:${account}`);
  broadcast({ type: "wrapper_deposit", data: { account, amount, ledger: event.ledger } });
}

async function handleWrapperWithdraw(
  event: SorobanRpc.Api.EventResponse,
  topics: unknown[],
): Promise<void> {
  const account = topics[1] as string;
  const data = scValToNative(event.value) as unknown[];
  const amount = String(data[1] as bigint);

  await pool.query(
    `INSERT INTO wrapper_withdrawals (account, amount, ledger)
     VALUES ($1, $2, $3)`,
    [account, amount, event.ledger],
  );
  invalidate(`profile:${account}`);
  broadcast({ type: "wrapper_withdrawal", data: { account, amount, ledger: event.ledger } });
}

async function handleTreasuryBatchTransfer(
  event: SorobanRpc.Api.EventResponse,
  topics: unknown[],
): Promise<void> {
  // Event: topics = ("bat_xfer", token_address)
  //        value  = (op_hash: Bytes, recipient_count: u32, total_amount: i128)
  const token = topics[1] as string;
  const data = scValToNative(event.value) as unknown[];
  const opHashBytes = data[0] as Uint8Array;
  const opHash = Buffer.from(opHashBytes).toString("hex");
  const recipientCount = Number(data[1]);
  const totalAmount = String(data[2] as bigint);

  await pool.query(
    `INSERT INTO treasury_transfers (op_hash, token, recipient_count, total_amount, ledger)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT DO NOTHING`,
    [opHash, token, recipientCount, totalAmount, event.ledger],
  );
}

type TreasuryStreamEventType =
  | "stream_created"
  | "stream_spend"
  | "stream_batch"
  | "stream_revoked"
  | "stream_extended"
  | "stream_topped_up"
  | "stream_exhausted"
  | "stream_expired";

function decodeTreasuryStreamEvent(
  event: SorobanRpc.Api.EventResponse,
  eventType: TreasuryStreamEventType,
): TreasuryStreamEventRecord {
  const raw = scValToNative(event.value);
  const data = Array.isArray(raw) ? raw : [raw];
  const expectedFields: Record<TreasuryStreamEventType, number> = {
    stream_created: 3,
    stream_spend: 3,
    stream_batch: 3,
    stream_revoked: 3,
    stream_extended: 3,
    stream_topped_up: 3,
    stream_exhausted: 1,
    stream_expired: 2,
  };
  if (data.length !== expectedFields[eventType]) {
    throw new Error(
      `${eventType} expected ${expectedFields[eventType]} fields, received ${data.length}`,
    );
  }
  const streamId = String(data[0]);
  if (!streamId || streamId === "undefined") {
    throw new Error(`${eventType} is missing stream_id`);
  }
  const payload = stringifyJson({
    topics: event.topic.map((topic) => scValToNative(topic)),
    value: raw,
    tx_hash: event.txHash,
  });
  const record: TreasuryStreamEventRecord = {
    eventId: indexerEventId(
      event,
      eventType,
      (event as SorobanRpc.Api.EventResponse & { contractId?: string })
        .contractId,
      payload,
    ),
    eventType,
    streamId,
    ledger: event.ledger,
    transactionHash: event.txHash,
    payload,
  };

  switch (eventType) {
    case "stream_created":
      record.name = String(data[1]);
      record.owner = String(data[2]);
      break;
    case "stream_spend":
      record.recipient = String(data[1]);
      record.amount = String(data[2]);
      break;
    case "stream_batch":
      record.totalAmount = String(data[1]);
      record.recipientCount = Number(data[2]);
      if (!Number.isSafeInteger(record.recipientCount)) {
        throw new Error(`${eventType} has an invalid recipient_count`);
      }
      break;
    case "stream_revoked":
      record.caller = String(data[1]);
      record.unspentReturned = String(data[2]);
      break;
    case "stream_extended":
      record.oldEndLedger = Number(data[1]);
      record.newEndLedger = Number(data[2]);
      if (
        !Number.isSafeInteger(record.oldEndLedger) ||
        !Number.isSafeInteger(record.newEndLedger)
      ) {
        throw new Error(`${eventType} has an invalid ledger value`);
      }
      break;
    case "stream_topped_up":
      record.additionalAmount = String(data[1]);
      record.newTotalAmount = String(data[2]);
      break;
    case "stream_expired":
      record.unspent = String(data[1]);
      break;
    case "stream_exhausted":
      break;
  }
  return record;
}

function treasuryBroadcastData(
  event: TreasuryStreamEventRecord,
): Record<string, unknown> {
  const data: Record<string, unknown> = {
    stream_id: event.streamId,
    ledger: event.ledger,
  };
  const fields: Array<[string, unknown]> = [
    ["name", event.name],
    ["owner", event.owner],
    ["recipient", event.recipient],
    ["amount", event.amount],
    ["total_amount", event.totalAmount],
    ["recipient_count", event.recipientCount],
    ["caller", event.caller],
    ["unspent_returned", event.unspentReturned],
    ["old_end_ledger", event.oldEndLedger],
    ["new_end_ledger", event.newEndLedger],
    ["additional_amount", event.additionalAmount],
    ["new_total_amount", event.newTotalAmount],
    ["unspent", event.unspent],
  ];
  for (const [key, value] of fields) {
    if (value !== undefined) data[key] = value;
  }
  return data;
}

async function handleTreasuryStreamEvent(
  rpcEvent: SorobanRpc.Api.EventResponse,
  eventType: TreasuryStreamEventType,
  reader: TreasuryStateReader | undefined,
): Promise<void> {
  if (!reader) {
    throw new Error(
      "Treasury stream indexing requires TREASURY_SIMULATION_ACCOUNT",
    );
  }
  const event = decodeTreasuryStreamEvent(rpcEvent, eventType);
  if (await treasuryStreamEventExists(event.eventId)) return;

  const stream = await reader.getStream(event.streamId);
  const spends =
    eventType === "stream_spend" || eventType === "stream_batch"
      ? await getAllStreamSpends(reader, stream)
      : [];
  const inserted = await persistTreasuryStreamEvent({
    event,
    stream,
    spends,
  });
  if (!inserted) return;

  invalidate(
    `treasury:stream:${event.streamId}`,
    "treasury:budget-summary",
  );
  invalidatePattern("treasury:streams:");
  invalidatePattern(`treasury:stream:${event.streamId}:spends:`);
  invalidatePattern(`treasury:stream:${event.streamId}:events:`);
  broadcast({
    type: eventType,
    data: treasuryBroadcastData(event),
  });
}

// --- Co-sponsorship / draft events (#767) ---

async function handleDraftCreated(
  event: SorobanRpc.Api.EventResponse,
  topics: unknown[],
): Promise<void> {
  const creator = topics[1] as string;
  const data = scValToNative(event.value) as Record<string, unknown>;
  const draftId = String(data.draft_id as bigint);
  const descriptionHashRaw = data.description_hash as Uint8Array | undefined;
  const descriptionHash = descriptionHashRaw
    ? Buffer.from(descriptionHashRaw).toString("hex")
    : null;
  const metadataUri = (data.metadata_uri as string) ?? null;
  const createdLedger = Number(data.created_ledger);
  const expiryLedger = Number(data.expiry_ledger);

  await pool.query(
    `INSERT INTO drafts (draft_id, creator_address, description_hash, metadata_uri, created_ledger, expiry_ledger)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (draft_id) DO NOTHING`,
    [draftId, creator, descriptionHash, metadataUri, createdLedger, expiryLedger],
  );
  invalidatePattern("drafts:");
  broadcast({
    type: "draft_created",
    data: { draft_id: draftId, creator, metadata_uri: metadataUri, ledger: event.ledger },
  });
}

async function handleCoSponsored(
  event: SorobanRpc.Api.EventResponse,
  topics: unknown[],
): Promise<void> {
  const sponsor = topics[1] as string;
  const data = scValToNative(event.value) as unknown[];
  const draftId = String(data[0] as bigint);
  const power = String(data[1] as bigint);
  const totalPower = String(data[2] as bigint);

  await pool.query(
    `INSERT INTO draft_co_sponsors (draft_id, sponsor_address, pledged_power, pledged_at_ledger)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (draft_id, sponsor_address)
     DO UPDATE SET pledged_power = EXCLUDED.pledged_power, withdrawn = FALSE`,
    [draftId, sponsor, power, event.ledger],
  );
  await pool.query(`UPDATE drafts SET total_power = $1 WHERE draft_id = $2`, [
    totalPower,
    draftId,
  ]);
  invalidatePattern("drafts:");
  broadcast({
    type: "co_sponsored",
    data: { draft_id: draftId, sponsor, power, total_power: totalPower, ledger: event.ledger },
  });
}

/**
 * Indexes a signal-anchor contract's ResultAnchored event so the anchor is
 * independently queryable from the indexer even if the backend's own copy
 * (backend/src/routes/signaling.ts's `anchored_tx_hash` column) is ever
 * disputed.
 */
async function handleResultAnchored(
  event: SorobanRpc.Api.EventResponse,
  topics: unknown[],
): Promise<void> {
  const anchorer = topics[1] as string;
  const data = scValToNative(event.value) as unknown[];
  const pollId = String(data[0] as bigint);
  const resultHash = Buffer.from(data[1] as Uint8Array).toString("hex");
  const anchoredLedger = Number(data[2] as number);

  await pool.query(
    `INSERT INTO signal_anchors (poll_id, result_hash, anchored_ledger, anchorer, tx_hash)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (poll_id) DO NOTHING`,
    [pollId, resultHash, anchoredLedger, anchorer, event.txHash ?? null],
  );
  invalidatePattern("signal-anchors:");
  broadcast({
    type: "result_anchored",
    data: { poll_id: pollId, result_hash: resultHash, anchored_ledger: anchoredLedger, anchorer },
  });
}

async function handleStrategyRegistered(
  event: SorobanRpc.Api.EventResponse,
  topics: unknown[],
): Promise<void> {
  const strategyId = String(topics[1] as bigint);
  const data = scValToNative(event.value) as Record<string, unknown>;
  const adapter = data.adapter as string;
  const token = data.token as string;
  await pool.query(
    `INSERT INTO treasury_strategies (strategy_id, adapter, token, active, registered_ledger)
     VALUES ($1, $2, $3, TRUE, $4)
     ON CONFLICT (strategy_id) DO NOTHING`,
    [strategyId, adapter, token, event.ledger],
  );
  invalidatePattern("treasury-strategies:");
  broadcast({
    type: "strategy_registered",
    data: { strategy_id: strategyId, adapter, token, ledger: event.ledger },
  });
}

async function handleStrategyDeactivated(
  event: SorobanRpc.Api.EventResponse,
  topics: unknown[],
): Promise<void> {
  const strategyId = String(topics[1] as bigint);
  await pool.query(
    `UPDATE treasury_strategies SET active = FALSE WHERE strategy_id = $1`,
    [strategyId],
  );
  invalidatePattern("treasury-strategies:");
  broadcast({
    type: "strategy_deactivated",
    data: { strategy_id: strategyId, ledger: event.ledger },
  });
}

async function handleStrategyDeposited(
  event: SorobanRpc.Api.EventResponse,
  topics: unknown[],
): Promise<void> {
  const strategyId = String(topics[1] as bigint);
  const data = scValToNative(event.value) as Record<string, unknown>;
  const amount = String(data.amount as bigint);
  await pool.query(
    `INSERT INTO strategy_allocations (strategy_id, amount, ledger) VALUES ($1, $2, $3)`,
    [strategyId, amount, event.ledger],
  );
  await pool.query(
    `UPDATE treasury_strategies SET current_allocation = current_allocation + $2 WHERE strategy_id = $1`,
    [strategyId, amount],
  );
  invalidatePattern("treasury-strategies:");
  broadcast({
    type: "strategy_deposited",
    data: { strategy_id: strategyId, amount, ledger: event.ledger },
  });
}

/**
 * `current_allocation` is decremented here (at request time) rather than at
 * claim time, mirroring the on-chain contract's own accounting: the
 * requested amount is reserved out of `Allocation.amount` as soon as
 * `request_withdrawal` succeeds, so a second concurrent request against the
 * same strategy sees the already-reduced balance.
 */
async function handleStrategyWithdrawalRequested(
  event: SorobanRpc.Api.EventResponse,
  topics: unknown[],
): Promise<void> {
  const withdrawalId = String(topics[1] as bigint);
  const data = scValToNative(event.value) as Record<string, unknown>;
  const strategyId = String(data.strategy_id as bigint);
  const amount = String(data.amount as bigint);
  const claimableLedger = Number(data.claimable_ledger as number);
  await pool.query(
    `INSERT INTO strategy_withdrawals
       (withdrawal_id, strategy_id, amount, requested_ledger, claimable_ledger)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (withdrawal_id) DO NOTHING`,
    [withdrawalId, strategyId, amount, event.ledger, claimableLedger],
  );
  await pool.query(
    `UPDATE treasury_strategies SET current_allocation = current_allocation - $2 WHERE strategy_id = $1`,
    [strategyId, amount],
  );
  invalidatePattern("treasury-strategies:");
  broadcast({
    type: "strategy_withdrawal_requested",
    data: {
      withdrawal_id: withdrawalId,
      strategy_id: strategyId,
      amount,
      claimable_ledger: claimableLedger,
    },
  });
}

async function handleStrategyWithdrawalClaimed(
  event: SorobanRpc.Api.EventResponse,
  topics: unknown[],
): Promise<void> {
  const withdrawalId = String(topics[1] as bigint);
  const data = scValToNative(event.value) as Record<string, unknown>;
  const actualAmount = String(data.actual_amount as bigint);
  await pool.query(
    `UPDATE strategy_withdrawals SET actual_amount = $2, claimed_ledger = $3 WHERE withdrawal_id = $1`,
    [withdrawalId, actualAmount, event.ledger],
  );
  invalidatePattern("treasury-strategies:");
  broadcast({
    type: "strategy_withdrawal_claimed",
    data: { withdrawal_id: withdrawalId, actual_amount: actualAmount, ledger: event.ledger },
  });
}

async function handleVoteEscrowEvent(
  event: SorobanRpc.Api.EventResponse,
  eventType: string,
  topics: unknown[],
): Promise<void> {
  const raw = scValToNative(event.value) as unknown;
  const data = (raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw
    : {}) as Record<string, unknown>;
  const owner = String(data.owner ?? topics[1] ?? "");
  if (!owner) return;

  if (eventType === "LockWithdrawn") {
    await pool.query(
      "UPDATE vote_escrow_locks SET withdrawn = true, updated_ledger = $2 WHERE owner_address = $1",
      [owner, event.ledger],
    );
    invalidatePattern("vote-escrow:");
    return;
  }

  const amount = String(data.amount ?? 0);
  const startLedger = Number(data.start_ledger ?? data.start ?? event.ledger);
  const endLedger = Number(data.end_ledger ?? data.end ?? 0);
  const initialVotingPower = String(
    data.initial_voting_power ?? data.voting_power ?? amount,
  );
  await pool.query(
    `INSERT INTO vote_escrow_locks
       (owner_address, amount, start_ledger, end_ledger, initial_voting_power, withdrawn, updated_ledger)
     VALUES ($1, $2, $3, $4, $5, false, $6)
     ON CONFLICT (owner_address) DO UPDATE SET
       amount = $2, end_ledger = $4, initial_voting_power = $5,
       withdrawn = false, updated_ledger = $6`,
    [owner, amount, startLedger, endLedger, initialVotingPower, event.ledger],
  );
  invalidatePattern("vote-escrow:");
}

// --- Guardian Council event handlers (#995) ---
//
// The guardian council tables are defined in migrations/021_add_guardian_council.sql:
// - guardian_council_actions: pending actions with their kind, proposer, ledger info, etc.
// - guardian_council_approvals: member approvals for each action
// - guardian_council_members: current member rotation history

async function handleGuardianCouncilEvent(
  event: SorobanRpc.Api.EventResponse,
  eventType: string,
  topics: unknown[],
): Promise<void> {
  // Parse action_id based on event type
  // ActionProposed, ActionApproved: value is [action_id, additional_data]
  // ActionExecuted, ApprovalRevoked: value is just action_id (not wrapped in array)
  let actionId: string;
  switch (eventType) {
    case "ActionExecuted":
    case "ApprovalRevoked":
      // These events emit just the action_id directly
      actionId = String(scValToNative(event.value) as bigint);
      break;
    case "ActionProposed":
    case "ActionApproved":
      // These events emit [action_id, ...]
      const data = scValToNative(event.value) as unknown[];
      actionId = String(data[0] as bigint);
      break;
    default:
      actionId = "";
  }

  switch (eventType) {
    case "ActionProposed": {
      const data = scValToNative(event.value) as unknown[];
      const actionKind = String((data[1] as { sym?: string })?.sym ?? data[1]);

      await pool.query(
        `INSERT INTO guardian_council_actions
           (action_id, action_kind, proposer, created_at_ledger, executed)
         VALUES ($1, $2, $3, $4, FALSE)`,
        [actionId, actionKind, String(topics[1]), event.ledger],
      );
      invalidatePattern("guardian-council:");
      broadcast({
        type: "action_proposed",
        data: { action_id: actionId, proposer: String(topics[1]), action_kind: actionKind, ledger: event.ledger },
      });
      break;
    }

    case "ActionApproved": {
      const data = scValToNative(event.value) as unknown[];
      const member = String(topics[1]);
      const approvalsCount = Number(data[1] as bigint | number);

      // Upsert approval record
      await pool.query(
        `INSERT INTO guardian_council_approvals (action_id, member, approved, approved_at_ledger)
         VALUES ($1, $2, TRUE, $3)
         ON CONFLICT (action_id, member) DO UPDATE SET
           approved = TRUE, revoked_at_ledger = NULL`,
        [actionId, member, event.ledger],
      );

      invalidatePattern("guardian-council:");
      broadcast({
        type: "action_approved",
        data: { action_id: actionId, member, approvals_count: approvalsCount, ledger: event.ledger },
      });
      break;
    }

    case "ApprovalRevoked": {
      const member = String(topics[1]);

      await pool.query(
        `UPDATE guardian_council_approvals
         SET approved = FALSE, revoked_at_ledger = $1
         WHERE action_id = $2 AND member = $3`,
        [event.ledger, actionId, member],
      );

      invalidatePattern("guardian-council:");
      broadcast({
        type: "approval_revoked",
        data: { action_id: actionId, member, ledger: event.ledger },
      });
      break;
    }

    case "ActionExecuted": {
      const actionKindResult = await pool.query(
        "SELECT action_kind FROM guardian_council_actions WHERE action_id = $1",
        [actionId],
      );
      const actionKind = actionKindResult.rows[0]?.action_kind ?? "Unknown";

      await pool.query(
        `UPDATE guardian_council_actions
         SET executed = TRUE, executed_at_ledger = $1
         WHERE action_id = $2`,
        [event.ledger, actionId],
      );

      invalidatePattern("guardian-council:");
      broadcast({
        type: "action_executed",
        data: { action_id: actionId, action_kind: actionKind, ledger: event.ledger },
      });
      break;
    }

    case "MembershipRotated": {
      const data = scValToNative(event.value) as unknown[];
      // data is [old_address, new_address] as Address objects
      const oldMember = String((data[0] as unknown as { address?: string })?.address ?? data[0]);
      const newMember = String((data[1] as unknown as { address?: string })?.address ?? data[1]);

      // Mark old member as removed if they exist
      await pool.query(
        `UPDATE guardian_council_members
         SET removed_at_ledger = $1
         WHERE member = $2 AND removed_at_ledger IS NULL`,
        [event.ledger, oldMember],
      );

      // Add new member
      await pool.query(
        `INSERT INTO guardian_council_members (member, added_at_ledger)
         VALUES ($1, $2)
         ON CONFLICT (member) DO UPDATE SET
           removed_at_ledger = NULL, added_at_ledger = LEAST(added_at_ledger, $2)`,
        [newMember, event.ledger],
      );

      invalidatePattern("guardian-council:");
      broadcast({
        type: "membership_rotated",
        data: { old_member: oldMember, new_member: newMember, ledger: event.ledger },
      });
      break;
    }

    case "ThresholdUpdated": {
      const data = scValToNative(event.value) as unknown[];
      const oldThreshold = Number(data[0]);
      const newThreshold = Number(data[1]);

      broadcast({
        type: "threshold_updated",
        data: { old_threshold: oldThreshold, new_threshold: newThreshold, ledger: event.ledger },
      });
      break;
    }

    case "ActionTtlUpdated": {
      const data = scValToNative(event.value) as unknown[];
      const oldTtl = Number(data[0]);
      const newTtl = Number(data[1]);

      broadcast({
        type: "action_ttl_updated",
        data: { old_ttl: oldTtl, new_ttl: newTtl, ledger: event.ledger },
      });
      break;
    }

    default:
      return;
  }

  invalidatePattern("guardian-council:");
}

async function handleCoSponsorshipWithdrawn(
  event: SorobanRpc.Api.EventResponse,
  topics: unknown[],
): Promise<void> {
  const sponsor = topics[1] as string;
  const data = scValToNative(event.value) as unknown[];
  const draftId = String(data[0] as bigint);
  const totalPower = String(data[2] as bigint);

  await pool.query(
    `UPDATE draft_co_sponsors SET withdrawn = TRUE WHERE draft_id = $1 AND sponsor_address = $2`,
    [draftId, sponsor],
  );
  await pool.query(`UPDATE drafts SET total_power = $1 WHERE draft_id = $2`, [
    totalPower,
    draftId,
  ]);
  invalidatePattern("drafts:");
  broadcast({
    type: "co_sponsorship_withdrawn",
    data: { draft_id: draftId, sponsor, total_power: totalPower, ledger: event.ledger },
  });
}

async function handleDraftFinalized(
  event: SorobanRpc.Api.EventResponse,
): Promise<void> {
  const data = scValToNative(event.value) as unknown[];
  const draftId = String(data[0] as bigint);
  const proposalId = String(data[1] as bigint);

  await pool.query(
    `UPDATE drafts SET finalized = TRUE, resulting_proposal_id = $1 WHERE draft_id = $2`,
    [proposalId, draftId],
  );
  invalidatePattern("drafts:");
  broadcast({
    type: "draft_finalized",
    data: { draft_id: draftId, proposal_id: proposalId, ledger: event.ledger },
  });
}

async function handleDraftCancelled(
  event: SorobanRpc.Api.EventResponse,
): Promise<void> {
  const data = scValToNative(event.value) as unknown[];
  const draftId = String(data[0] as bigint);

  await pool.query(`UPDATE drafts SET cancelled = TRUE WHERE draft_id = $1`, [
    draftId,
  ]);
  invalidatePattern("drafts:");
  broadcast({
    type: "draft_cancelled",
    data: { draft_id: draftId, ledger: event.ledger },
  });
}

async function handleDraftExpired(
  event: SorobanRpc.Api.EventResponse,
): Promise<void> {
  const data = scValToNative(event.value) as unknown[];
  const draftId = String(data[0] as bigint);

  await pool.query(`UPDATE drafts SET expired = TRUE WHERE draft_id = $1`, [
    draftId,
  ]);
  invalidatePattern("drafts:");
  broadcast({
    type: "draft_expired",
    data: { draft_id: draftId, ledger: event.ledger },
  });
}

async function handleBondLocked(
  event: SorobanRpc.Api.EventResponse,
  topics: unknown[],
): Promise<void> {
  const proposer = topics[1] as string;
  const data = scValToNative(event.value) as unknown[];
  const descriptionHash = Buffer.from(data[0] as Uint8Array).toString("hex");
  const amount = String(data[1] as bigint);

  await pool.query(
    `INSERT INTO proposal_bonds (description_hash, proposer_address, amount, state, locked_ledger)
     VALUES ($1, $2, $3, 'locked', $4)
     ON CONFLICT (description_hash) DO NOTHING`,
    [descriptionHash, proposer, amount, event.ledger],
  );
  invalidatePattern("proposal-bonds:");
  broadcast({
    type: "bond_locked",
    data: { description_hash: descriptionHash, proposer, amount, ledger: event.ledger },
  });
}

async function handleBondRefunded(
  event: SorobanRpc.Api.EventResponse,
  topics: unknown[],
): Promise<void> {
  const proposer = topics[1] as string;
  const data = scValToNative(event.value) as unknown[];
  const descriptionHash = Buffer.from(data[0] as Uint8Array).toString("hex");
  const amount = String(data[1] as bigint);

  await pool.query(
    `UPDATE proposal_bonds SET state = 'refunded', refunded_ledger = $1 WHERE description_hash = $2`,
    [event.ledger, descriptionHash],
  );
  invalidatePattern("proposal-bonds:");
  broadcast({
    type: "bond_refunded",
    data: { description_hash: descriptionHash, proposer, amount, ledger: event.ledger },
  });
}

async function handleBondSlashed(
  event: SorobanRpc.Api.EventResponse,
  topics: unknown[],
): Promise<void> {
  const proposer = topics[1] as string;
  const data = scValToNative(event.value) as unknown[];
  const descriptionHash = Buffer.from(data[0] as Uint8Array).toString("hex");
  const amount = String(data[1] as bigint);
  const recipient = data[2] as string;

  await pool.query(
    `UPDATE proposal_bonds SET state = 'slashed', slashed_ledger = $1, slash_recipient = $2 WHERE description_hash = $3`,
    [event.ledger, recipient, descriptionHash],
  );
  invalidatePattern("proposal-bonds:");
  broadcast({
    type: "bond_slashed",
    data: { description_hash: descriptionHash, proposer, amount, recipient, ledger: event.ledger },
  });
}

interface GovernorSettings {
  voting_delay: number;
  voting_period: number;
  quorum_numerator: number;
  proposal_threshold: bigint;
  guardian: string;
  voteType: number;
  proposal_grace_period: number;
  use_dynamic_quorum?: boolean;
  reflector_oracle?: string | null;
  min_quorum_usd?: bigint;
  max_calldata_size?: number;
  proposal_cooldown?: number;
  max_proposals_per_period?: number;
  proposal_period_duration?: number;
}

function stringifyJson(value: unknown): string {
  return JSON.stringify(value, (_key, current) =>
    typeof current === "bigint" ? current.toString() : current,
  );
}

function parseLedgerClosedAt(value: unknown): Date | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
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
  if (!value || typeof value !== "object") return null;

  const obj = value as Record<string, unknown>;
  const votingDelay = toNumber(obj.voting_delay);
  const votingPeriod = toNumber(obj.voting_period);
  const quorumNumerator = toNumber(obj.quorum_numerator);
  const proposalThreshold =
    typeof obj.proposal_threshold === "bigint"
      ? Number(obj.proposal_threshold)
      : obj.proposal_threshold
      ? Number(obj.proposal_threshold)
      : null;
  const proposalGracePeriod = toNumber(obj.proposal_grace_period);

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
    voting_delay: votingDelay,
    voting_period: votingPeriod,
    quorum_numerator: quorumNumerator,
    proposal_threshold: BigInt(proposalThreshold),
    guardian: String(obj.guardian ?? ""),
    voteType: 0,
    proposal_grace_period: proposalGracePeriod,
    use_dynamic_quorum: Boolean(obj.use_dynamic_quorum),
    reflector_oracle:
      obj.reflector_oracle === undefined || obj.reflector_oracle === null
        ? null
        : String(obj.reflector_oracle),
    min_quorum_usd: obj.min_quorum_usd
      ? BigInt(Number(obj.min_quorum_usd))
      : 0n,
    max_calldata_size: toNumber(obj.max_calldata_size) ?? 10000,
    proposal_cooldown: toNumber(obj.proposal_cooldown) ?? 100,
    max_proposals_per_period: toNumber(obj.max_proposals_per_period) ?? 5,
    proposal_period_duration:
      toNumber(obj.proposal_period_duration) ?? 10000,
  };
}

// --- Liquidity event stubs (pre-existing references) ---

async function legacyHandleLiquidityAdded(
  event: SorobanRpc.Api.EventResponse,
  topics: unknown[],
): Promise<void> {
  const account = topics[1] as string;
  const data = scValToNative(event.value) as unknown[];
  const amount = String(data[0] as bigint);
  broadcast({ type: "liquidity_added", data: { account, amount, ledger: event.ledger } });
}

async function legacyHandleLiquidityRemoved(
  event: SorobanRpc.Api.EventResponse,
  topics: unknown[],
): Promise<void> {
  const account = topics[1] as string;
  const data = scValToNative(event.value) as unknown[];
  const amount = String(data[0] as bigint);
  broadcast({ type: "liquidity_removed", data: { account, amount, ledger: event.ledger } });
}

async function legacyHandleSwap(
  event: SorobanRpc.Api.EventResponse,
  topics: unknown[],
): Promise<void> {
  const trader = topics[1] as string;
  broadcast({ type: "swap", data: { trader, ledger: event.ledger } });
}

async function legacyHandlePoolFeeUpdated(
  event: SorobanRpc.Api.EventResponse,
  _topics: unknown[],
): Promise<void> {
  broadcast({ type: "pool_fee_updated", data: { ledger: event.ledger } });
}

async function legacyMaybeTakeGovernanceSnapshot(_ledger: number): Promise<void> {
  // Placeholder — governance snapshot logic not yet implemented.
}

// --- Timelock event handlers (#846) ---

function bufToHex(v: unknown): string {
  if (v instanceof Uint8Array) return Buffer.from(v).toString("hex");
  if (Buffer.isBuffer(v)) return v.toString("hex");
  return String(v ?? "");
}

async function logTimelockEvent(
  _eventType: string,
  _ledger: number,
  _data: Record<string, unknown>,
): Promise<void> {
  // No-op: the generic logToEventLog handler at line 130 already writes
  // every event into the event_log table. Timelock-specific table inserts
  // are handled by each dedicated handler.
}

async function legacyHandleTimelockOperationScheduled(
  event: SorobanRpc.Api.EventResponse,
  _topics: unknown[],
): Promise<void> {
  const data = scValToNative(event.value) as Record<string, unknown>;
  const opId = bufToHex(data.op_id);
  const target = String(data.target ?? "");
  const fnName = String(data.fn_name ?? "");
  const readyAt = String(data.ready_at ?? "0");
  const expiresAt = String(data.expires_at ?? "0");

  await pool.query(
    `INSERT INTO timelock_operations (op_id, target, fn_name, ready_at, expires_at, status, ledger)
     VALUES ($1, $2, $3, $4, $5, 'scheduled', $6)
     ON CONFLICT (op_id) DO NOTHING`,
    [opId, target, fnName, readyAt, expiresAt, event.ledger],
  );
  broadcast({
    type: "timelock_operation_scheduled",
    data: { op_id: opId, target, fn_name: fnName, ready_at: readyAt, expires_at: expiresAt, ledger: event.ledger },
  });
}

async function legacyHandleTimelockOperationExecuted(
  event: SorobanRpc.Api.EventResponse,
  _topics: unknown[],
): Promise<void> {
  const data = scValToNative(event.value) as Record<string, unknown>;
  const opId = bufToHex(data.op_id);
  const caller = String(data.caller ?? "");

  await pool.query(
    `UPDATE timelock_operations SET status = 'executed' WHERE op_id = $1`,
    [opId],
  );
  await logTimelockEvent("timelock_operation_executed", event.ledger, { op_id: opId, caller });
  broadcast({
    type: "timelock_operation_executed",
    data: { op_id: opId, caller, ledger: event.ledger },
  });
}

async function legacyHandleTimelockOperationCancelled(
  event: SorobanRpc.Api.EventResponse,
  _topics: unknown[],
): Promise<void> {
  const data = scValToNative(event.value) as Record<string, unknown>;
  const opId = bufToHex(data.op_id);
  const caller = String(data.caller ?? "");

  await pool.query(
    `UPDATE timelock_operations SET status = 'cancelled' WHERE op_id = $1`,
    [opId],
  );
  await logTimelockEvent("timelock_operation_cancelled", event.ledger, { op_id: opId, caller });
  broadcast({
    type: "timelock_operation_cancelled",
    data: { op_id: opId, caller, ledger: event.ledger },
  });
}

async function legacyHandleTimelockBatchOperationScheduled(
  event: SorobanRpc.Api.EventResponse,
  _topics: unknown[],
): Promise<void> {
  const data = scValToNative(event.value) as Record<string, unknown>;
  const batchOpId = bufToHex(data.batch_op_id);
  const targets = (data.targets ?? []) as string[];
  const fnNames = (data.fn_names ?? []) as string[];
  const readyAt = String(data.ready_at ?? "0");
  const expiresAt = String(data.expires_at ?? "0");

  await pool.query(
    `INSERT INTO timelock_batch_operations (batch_op_id, target_count, fn_names, ready_at, expires_at, status, ledger)
     VALUES ($1, $2, $3, $4, $5, 'scheduled', $6)
     ON CONFLICT (batch_op_id) DO NOTHING`,
    [batchOpId, targets.length, JSON.stringify(fnNames), readyAt, expiresAt, event.ledger],
  );
  await logTimelockEvent("timelock_batch_operation_scheduled", event.ledger, {
    batch_op_id: batchOpId, target_count: targets.length, ready_at: readyAt, expires_at: expiresAt,
  });
  broadcast({
    type: "timelock_batch_operation_scheduled",
    data: { batch_op_id: batchOpId, target_count: targets.length, ready_at: readyAt, expires_at: expiresAt, ledger: event.ledger },
  });
}

async function legacyHandleTimelockBatchOperationExecuted(
  event: SorobanRpc.Api.EventResponse,
  _topics: unknown[],
): Promise<void> {
  const data = scValToNative(event.value) as Record<string, unknown>;
  const batchOpId = bufToHex(data.batch_op_id);
  const caller = String(data.caller ?? "");

  await pool.query(
    `UPDATE timelock_batch_operations SET status = 'executed' WHERE batch_op_id = $1`,
    [batchOpId],
  );
  await logTimelockEvent("timelock_batch_operation_executed", event.ledger, { batch_op_id: batchOpId, caller });
  broadcast({
    type: "timelock_batch_operation_executed",
    data: { batch_op_id: batchOpId, caller, ledger: event.ledger },
  });
}

async function legacyHandleTimelockBatchOperationCancelled(
  event: SorobanRpc.Api.EventResponse,
  _topics: unknown[],
): Promise<void> {
  const data = scValToNative(event.value) as Record<string, unknown>;
  const batchOpId = bufToHex(data.batch_op_id);
  const caller = String(data.caller ?? "");

  await pool.query(
    `UPDATE timelock_batch_operations SET status = 'cancelled' WHERE batch_op_id = $1`,
    [batchOpId],
  );
  await logTimelockEvent("timelock_batch_operation_cancelled", event.ledger, { batch_op_id: batchOpId, caller });
  broadcast({
    type: "timelock_batch_operation_cancelled",
    data: { batch_op_id: batchOpId, caller, ledger: event.ledger },
  });
}

async function legacyHandleTimelockMinDelayUpdated(
  event: SorobanRpc.Api.EventResponse,
  _topics: unknown[],
): Promise<void> {
  const data = scValToNative(event.value) as Record<string, unknown>;
  const oldDelay = String(data.old_delay ?? "0");
  const newDelay = String(data.new_delay ?? "0");

  await logTimelockEvent("timelock_min_delay_updated", event.ledger, { old_delay: oldDelay, new_delay: newDelay });
  broadcast({
    type: "timelock_min_delay_updated",
    data: { old_delay: oldDelay, new_delay: newDelay, ledger: event.ledger },
  });
}

async function legacyHandleTimelockDependencyDagValidated(
  event: SorobanRpc.Api.EventResponse,
  _topics: unknown[],
): Promise<void> {
  const data = scValToNative(event.value) as unknown[];
  const batchOpId = bufToHex(data[0]);
  const opCount = Number(data[1] ?? 0);

  await pool.query(
    `INSERT INTO timelock_dependency_graphs (batch_op_id, op_count, valid, ledger)
     VALUES ($1, $2, true, $3)
     ON CONFLICT (batch_op_id) DO UPDATE SET op_count = $2, valid = true`,
    [batchOpId, opCount, event.ledger],
  );
  await logTimelockEvent("timelock_dependency_dag_validated", event.ledger, { batch_op_id: batchOpId, op_count: opCount });
  broadcast({
    type: "timelock_dependency_dag_validated",
    data: { batch_op_id: batchOpId, op_count: opCount, ledger: event.ledger },
  });
}

async function legacyHandleTimelockCycleDetected(
  event: SorobanRpc.Api.EventResponse,
  _topics: unknown[],
): Promise<void> {
  const cyclePath = scValToNative(event.value) as Uint8Array[];
  const pathHex = cyclePath.map((b) => bufToHex(b));

  await pool.query(
    `INSERT INTO timelock_dependency_graphs (batch_op_id, op_count, valid, cycle_path, ledger)
     VALUES ($1, $2, false, $3, $4)
     ON CONFLICT (batch_op_id) DO UPDATE SET valid = false, cycle_path = $3`,
    ["", pathHex.length, JSON.stringify(pathHex), event.ledger],
  );
  await logTimelockEvent("timelock_cycle_detected", event.ledger, { cycle_path: pathHex });
  broadcast({
    type: "timelock_cycle_detected",
    data: { cycle_path: pathHex, ledger: event.ledger },
  });
}

async function legacyHandleTimelockPartialBatchStarted(
  event: SorobanRpc.Api.EventResponse,
  _topics: unknown[],
): Promise<void> {
  const data = scValToNative(event.value) as unknown[];
  const batchOpId = bufToHex(data[0]);
  const totalOps = Number(data[1] ?? 0);

  await pool.query(
    `INSERT INTO timelock_partial_batch_state (batch_op_id, total_ops, completed_count, failed_count, pending_count, recovery_mode, ledger)
     VALUES ($1, $2, 0, 0, $2, false, $3)
     ON CONFLICT (batch_op_id) DO UPDATE SET total_ops = $2, pending_count = $2`,
    [batchOpId, totalOps, event.ledger],
  );
  await logTimelockEvent("timelock_partial_batch_started", event.ledger, { batch_op_id: batchOpId, total_ops: totalOps });
  broadcast({
    type: "timelock_partial_batch_started",
    data: { batch_op_id: batchOpId, total_ops: totalOps, ledger: event.ledger },
  });
}

async function legacyHandleTimelockPartialOpSucceeded(
  event: SorobanRpc.Api.EventResponse,
  _topics: unknown[],
): Promise<void> {
  const data = scValToNative(event.value) as unknown[];
  const batchOpId = bufToHex(data[0]);
  const opId = bufToHex(data[1]);
  const completed = Number(data[2] ?? 0);
  const total = Number(data[3] ?? 0);

  await pool.query(
    `UPDATE timelock_partial_batch_state
     SET completed_count = $1, pending_count = $2 - $1
     WHERE batch_op_id = $3`,
    [completed, total, batchOpId],
  );
  await logTimelockEvent("timelock_partial_op_succeeded", event.ledger, {
    batch_op_id: batchOpId, op_id: opId, completed, total,
  });
  broadcast({
    type: "timelock_partial_op_succeeded",
    data: { batch_op_id: batchOpId, op_id: opId, completed, total, ledger: event.ledger },
  });
}

async function legacyHandleTimelockPartialOpFailed(
  event: SorobanRpc.Api.EventResponse,
  _topics: unknown[],
): Promise<void> {
  const data = scValToNative(event.value) as unknown[];
  const batchOpId = bufToHex(data[0]);
  const opId = bufToHex(data[1]);

  await pool.query(
    `UPDATE timelock_partial_batch_state
     SET failed_count = failed_count + 1, pending_count = pending_count - 1
     WHERE batch_op_id = $1`,
    [batchOpId],
  );
  await logTimelockEvent("timelock_partial_op_failed", event.ledger, { batch_op_id: batchOpId, op_id: opId });
  broadcast({
    type: "timelock_partial_op_failed",
    data: { batch_op_id: batchOpId, op_id: opId, ledger: event.ledger },
  });
}

async function legacyHandleTimelockBatchRecoveryEntered(
  event: SorobanRpc.Api.EventResponse,
  _topics: unknown[],
): Promise<void> {
  const data = scValToNative(event.value) as unknown[];
  const batchOpId = bufToHex(data[0]);
  const recoveryDeadline = Number(data[1] ?? 0);

  await pool.query(
    `UPDATE timelock_partial_batch_state
     SET recovery_mode = true, recovery_deadline = $1
     WHERE batch_op_id = $2`,
    [recoveryDeadline, batchOpId],
  );
  await logTimelockEvent("timelock_batch_recovery_entered", event.ledger, {
    batch_op_id: batchOpId, recovery_deadline: recoveryDeadline,
  });
  broadcast({
    type: "timelock_batch_recovery_entered",
    data: { batch_op_id: batchOpId, recovery_deadline: recoveryDeadline, ledger: event.ledger },
  });
}

async function legacyHandleTimelockFailedOpRetried(
  event: SorobanRpc.Api.EventResponse,
  _topics: unknown[],
): Promise<void> {
  const data = scValToNative(event.value) as unknown[];
  const batchOpId = bufToHex(data[0]);
  const opId = bufToHex(data[1]);
  const retryCount = Number(data[2] ?? 0);
  const succeeded = Boolean(data[3]);

  await logTimelockEvent("timelock_failed_op_retried", event.ledger, {
    batch_op_id: batchOpId, op_id: opId, retry_count: retryCount, succeeded,
  });
  broadcast({
    type: "timelock_failed_op_retried",
    data: { batch_op_id: batchOpId, op_id: opId, retry_count: retryCount, succeeded, ledger: event.ledger },
  });
}

async function legacyHandleTimelockFailedOpSkipped(
  event: SorobanRpc.Api.EventResponse,
  _topics: unknown[],
): Promise<void> {
  const data = scValToNative(event.value) as unknown[];
  const batchOpId = bufToHex(data[0]);
  const opId = bufToHex(data[1]);

  await logTimelockEvent("timelock_failed_op_skipped", event.ledger, { batch_op_id: batchOpId, op_id: opId });
  broadcast({
    type: "timelock_failed_op_skipped",
    data: { batch_op_id: batchOpId, op_id: opId, ledger: event.ledger },
  });
}

async function legacyHandleTimelockBatchFullyComplete(
  event: SorobanRpc.Api.EventResponse,
  _topics: unknown[],
): Promise<void> {
  const batchOpId = bufToHex(scValToNative(event.value));

  await pool.query(
    `UPDATE timelock_batch_operations SET status = 'completed' WHERE batch_op_id = $1`,
    [batchOpId],
  );
  await logTimelockEvent("timelock_batch_fully_complete", event.ledger, { batch_op_id: batchOpId });
  broadcast({
    type: "timelock_batch_fully_complete",
    data: { batch_op_id: batchOpId, ledger: event.ledger },
  });
}

async function handleConfigUpdated(
  event: SorobanRpc.Api.EventResponse,
  _topics: unknown[],
): Promise<void> {
  const data = scValToNative(event.value) as Record<string, unknown>;
  const oldSettings =
    data.old_settings === undefined || data.old_settings === null
      ? null
      : toGovernorSettings(data.old_settings);
  const newSettings = toGovernorSettings(data.new_settings);

  if ((data.old_settings !== undefined && data.old_settings !== null) && !oldSettings) {
    console.error("Failed to parse old_settings from ConfigUpdated event");
    return;
  }

  if (!newSettings) {
    console.error("Failed to parse new_settings from ConfigUpdated event");
    return;
  }

  const ledgerClosedAt = parseLedgerClosedAt((event as any).ledgerClosedAt);

  await pool.query(
    `INSERT INTO config_updates (ledger, old_settings, new_settings, ledger_closed_at)
     VALUES ($1, $2, $3, $4)`,
    [
      event.ledger,
      oldSettings ? stringifyJson(oldSettings) : null,
      stringifyJson(newSettings),
      ledgerClosedAt,
    ],
  );
}

async function handleGovernorUpgraded(
  event: SorobanRpc.Api.EventResponse,
  _topics: unknown[],
): Promise<void> {
  const data = scValToNative(event.value) as Record<string, unknown>;
  const newHash = data.new_hash;

  const hashStr =
    newHash instanceof Uint8Array
      ? Buffer.from(newHash).toString("hex")
      : String(newHash ?? "");

  await pool.query(
    `INSERT INTO governor_upgrades (ledger, new_wasm_hash)
     VALUES ($1, $2)`,
    [event.ledger, hashStr],
  );
}

const SNAPSHOT_INTERVAL_LEDGERS = 100;

export async function maybeTakeGovernanceSnapshot(
  currentLedger: number,
): Promise<void> {
  const lastResult = await pool.query(
    "SELECT ledger FROM governance_snapshots ORDER BY ledger DESC LIMIT 1",
  );
  const lastLedger = lastResult.rows[0]?.ledger ?? 0;
  if (currentLedger - lastLedger < SNAPSHOT_INTERVAL_LEDGERS) return;

  const votesResult = await pool.query(
    "SELECT COALESCE(SUM(weight), 0) AS total FROM votes",
  );
  const totalVotesCast = String(votesResult.rows[0]?.total ?? 0);
  await pool.query(
    `INSERT INTO governance_snapshots (ledger, total_votes_cast)
     VALUES ($1, $2)
     ON CONFLICT (ledger) DO NOTHING`,
    [currentLedger, totalVotesCast],
  );
  invalidatePattern("analytics:");
  broadcast({
    type: "analytics_snapshot_taken",
    data: { ledger: currentLedger, total_votes_cast: totalVotesCast },
  });
}

async function handleLiquidityAdded(
  event: SorobanRpc.Api.EventResponse,
  topics: unknown[],
): Promise<void> {
  const provider = topics[1] as string;
  const data = scValToNative(event.value) as Record<string, unknown>;
  const outcomeA = Number(data.outcome_a);
  const outcomeB = Number(data.outcome_b);
  const amountA = String(data.amount_a as bigint);
  const amountB = String(data.amount_b as bigint);
  const lpTokens = String(data.lp_tokens_minted as bigint);
  await pool.query(
    `INSERT INTO liquidity_events
       (event_type, provider, outcome_a, outcome_b, amount_a, amount_b, lp_tokens, ledger)
     VALUES ('add', $1, $2, $3, $4, $5, $6, $7)`,
    [provider, outcomeA, outcomeB, amountA, amountB, lpTokens, event.ledger],
  );
  broadcast({
    type: "liquidity_added",
    data: {
      provider,
      outcome_a: outcomeA,
      outcome_b: outcomeB,
      amount_a: amountA,
      amount_b: amountB,
      lp_tokens: lpTokens,
      ledger: event.ledger,
    },
  });
}

async function handleLiquidityRemoved(
  event: SorobanRpc.Api.EventResponse,
  topics: unknown[],
): Promise<void> {
  const provider = topics[1] as string;
  const data = scValToNative(event.value) as Record<string, unknown>;
  const outcomeA = Number(data.outcome_a);
  const outcomeB = Number(data.outcome_b);
  const amountA = String(data.amount_a as bigint);
  const amountB = String(data.amount_b as bigint);
  const lpTokens = String(data.lp_tokens_burned as bigint);
  await pool.query(
    `INSERT INTO liquidity_events
       (event_type, provider, outcome_a, outcome_b, amount_a, amount_b, lp_tokens, ledger)
     VALUES ('remove', $1, $2, $3, $4, $5, $6, $7)`,
    [provider, outcomeA, outcomeB, amountA, amountB, lpTokens, event.ledger],
  );
  broadcast({
    type: "liquidity_removed",
    data: {
      provider,
      outcome_a: outcomeA,
      outcome_b: outcomeB,
      amount_a: amountA,
      amount_b: amountB,
      lp_tokens: lpTokens,
      ledger: event.ledger,
    },
  });
}

async function handleSwap(
  event: SorobanRpc.Api.EventResponse,
  topics: unknown[],
): Promise<void> {
  const trader = topics[1] as string;
  const data = scValToNative(event.value) as Record<string, unknown>;
  const outcomeIn = Number(data.outcome_in);
  const outcomeOut = Number(data.outcome_out);
  const amountIn = String(data.amount_in as bigint);
  const amountOut = String(data.amount_out as bigint);
  const fee = String(data.fee as bigint);
  await pool.query(
    `INSERT INTO swap_events
       (trader, outcome_in, outcome_out, amount_in, amount_out, fee, ledger)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [trader, outcomeIn, outcomeOut, amountIn, amountOut, fee, event.ledger],
  );
  broadcast({
    type: "swap",
    data: {
      trader,
      outcome_in: outcomeIn,
      outcome_out: outcomeOut,
      amount_in: amountIn,
      amount_out: amountOut,
      fee,
      ledger: event.ledger,
    },
  });
}

async function handlePoolFeeUpdated(
  event: SorobanRpc.Api.EventResponse,
  _topics: unknown[],
): Promise<void> {
  const data = scValToNative(event.value) as Record<string, unknown>;
  const outcomeA = Number(data.outcome_a);
  const outcomeB = Number(data.outcome_b);
  const oldFeeBps = Number(data.old_fee_bps);
  const newFeeBps = Number(data.new_fee_bps);
  await pool.query(
    `INSERT INTO pool_fee_updates
       (outcome_a, outcome_b, old_fee_bps, new_fee_bps, ledger)
     VALUES ($1, $2, $3, $4, $5)`,
    [outcomeA, outcomeB, oldFeeBps, newFeeBps, event.ledger],
  );
  broadcast({
    type: "pool_fee_updated",
    data: {
      outcome_a: outcomeA,
      outcome_b: outcomeB,
      old_fee_bps: oldFeeBps,
      new_fee_bps: newFeeBps,
      ledger: event.ledger,
    },
  });
}

async function handleLockCreated(
  event: SorobanRpc.Api.EventResponse,
  topics: unknown[],
): Promise<void> {
  const owner = (topics[1] as string) ?? "";
  const raw = scValToNative(event.value) as Record<string, unknown>;
  const amount = String(raw.amount as bigint | number | string);
  const endLedger = Number(raw.end_ledger);
  const initialVotingPower = String(
    raw.initial_voting_power as bigint | number | string,
  );

  const existing = await pool.query(
    "SELECT id FROM vote_escrow_locks WHERE owner_address = $1 AND start_ledger = $2",
    [owner, event.ledger],
  );
  if (existing.rows.length > 0) return;

  await pool.query(
    `INSERT INTO vote_escrow_locks
       (owner_address, amount, start_ledger, end_ledger, initial_voting_power, withdrawn)
     VALUES ($1, $2, $3, $4, $5, FALSE)`,
    [owner, amount, event.ledger, endLedger, initialVotingPower],
  );
  invalidatePattern("vote_escrow:");
  broadcast({
    type: "vote_escrow_lock_created",
    data: {
      owner,
      amount,
      start_ledger: event.ledger,
      end_ledger: endLedger,
      initial_voting_power: initialVotingPower,
      ledger: event.ledger,
    },
  });
}

async function handleLockIncreased(
  event: SorobanRpc.Api.EventResponse,
  topics: unknown[],
): Promise<void> {
  const owner = (topics[1] as string) ?? "";
  const raw = scValToNative(event.value) as Record<string, unknown>;
  const addedAmount = String(raw.added_amount as bigint | number | string);
  const newVotingPower = String(
    raw.new_voting_power as bigint | number | string,
  );

  await pool.query(
    `UPDATE vote_escrow_locks
     SET amount = amount + $2,
         initial_voting_power = $3,
         updated_at = NOW()
     WHERE owner_address = $1 AND withdrawn = FALSE`,
    [owner, addedAmount, newVotingPower],
  );
  invalidatePattern("vote_escrow:");
  broadcast({
    type: "vote_escrow_lock_increased",
    data: {
      owner,
      added_amount: addedAmount,
      new_voting_power: newVotingPower,
      ledger: event.ledger,
    },
  });
}

async function handleLockExtended(
  event: SorobanRpc.Api.EventResponse,
  topics: unknown[],
): Promise<void> {
  const owner = (topics[1] as string) ?? "";
  const raw = scValToNative(event.value) as Record<string, unknown>;
  const oldEndLedger = Number(raw.old_end_ledger);
  const newEndLedger = Number(raw.new_end_ledger);

  await pool.query(
    `UPDATE vote_escrow_locks
     SET end_ledger = $2,
         updated_at = NOW()
     WHERE owner_address = $1 AND withdrawn = FALSE`,
    [owner, newEndLedger],
  );
  invalidatePattern("vote_escrow:");
  broadcast({
    type: "vote_escrow_lock_extended",
    data: {
      owner,
      old_end_ledger: oldEndLedger,
      new_end_ledger: newEndLedger,
      ledger: event.ledger,
    },
  });
}

async function handleLockWithdrawn(
  event: SorobanRpc.Api.EventResponse,
  topics: unknown[],
): Promise<void> {
  const owner = (topics[1] as string) ?? "";
  const raw = scValToNative(event.value) as Record<string, unknown>;
  const amount = String(raw.amount as bigint | number | string);

  await pool.query(
    `UPDATE vote_escrow_locks
     SET withdrawn = TRUE,
         updated_at = NOW()
     WHERE owner_address = $1 AND withdrawn = FALSE`,
    [owner],
  );
  invalidatePattern("vote_escrow:");
  broadcast({
    type: "vote_escrow_lock_withdrawn",
    data: {
      owner,
      amount,
      ledger: event.ledger,
    },
  });
}

function bytesToHex(value: unknown): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("hex");
  if (value instanceof Uint8Array || Array.isArray(value)) {
    return Buffer.from(value as Uint8Array).toString("hex");
  }
  return String(value);
}

function timelockObject(
  event: SorobanRpc.Api.EventResponse,
): Record<string, unknown> | unknown[] {
  return scValToNative(event.value) as Record<string, unknown> | unknown[];
}

function timelockEventId(
  event: SorobanRpc.Api.EventResponse,
  eventType: string,
): string {
  return (
    (event as SorobanRpc.Api.EventResponse & { id?: string }).id ??
    `${event.txHash ?? "ledger"}:${event.ledger}:${eventType}`
  );
}

async function handleTimelockOperationScheduled(
  event: SorobanRpc.Api.EventResponse,
  _topics: unknown[],
): Promise<void> {
  const raw = timelockObject(event);
  const data = Array.isArray(raw) ? raw : null;
  const object = Array.isArray(raw) ? null : raw;
  const opId = bytesToHex(data?.[0] ?? object?.op_id);
  const target = String(data?.[1] ?? object?.target ?? "");
  const fnName = String(data?.[2] ?? object?.fn_name ?? "");
  const readyAt = String(data?.[3] ?? object?.ready_at ?? 0);
  const expiresAt = String(data?.[4] ?? object?.expires_at ?? 0);
  await pool.query(
    `INSERT INTO timelock_operations
       (op_id, target, fn_name, ready_at, expires_at, status, ledger)
     VALUES ($1, $2, $3, $4, $5, 'scheduled', $6)
     ON CONFLICT (op_id) DO UPDATE SET
       target = EXCLUDED.target,
       fn_name = EXCLUDED.fn_name,
       ready_at = EXCLUDED.ready_at,
       expires_at = EXCLUDED.expires_at,
       ledger = EXCLUDED.ledger`,
    [opId, target, fnName, readyAt, expiresAt, event.ledger],
  );
  invalidate(`timelock:op:${opId}`);
  invalidatePattern("timelock:ops:");
  broadcast({
    type: "timelock_operation_scheduled",
    data: {
      op_id: opId,
      target,
      fn_name: fnName,
      ready_at: readyAt,
      expires_at: expiresAt,
      ledger: event.ledger,
    },
  });
}

async function handleTimelockOperationExecuted(
  event: SorobanRpc.Api.EventResponse,
  _topics: unknown[],
): Promise<void> {
  const raw = timelockObject(event);
  const data = Array.isArray(raw) ? raw : null;
  const object = Array.isArray(raw) ? null : raw;
  const opId = bytesToHex(data?.[0] ?? object?.op_id);
  const caller = String(data?.[1] ?? object?.caller ?? "");
  await pool.query(
    `UPDATE timelock_operations
     SET status = 'executed', executed_by = $2, executed_at_ledger = $3
     WHERE op_id = $1`,
    [opId, caller, event.ledger],
  );
  invalidate(`timelock:op:${opId}`);
  invalidatePattern("timelock:ops:");
  broadcast({
    type: "timelock_operation_executed",
    data: { op_id: opId, caller, ledger: event.ledger },
  });
}

async function handleTimelockOperationCancelled(
  event: SorobanRpc.Api.EventResponse,
  _topics: unknown[],
): Promise<void> {
  const raw = timelockObject(event);
  const data = Array.isArray(raw) ? raw : null;
  const object = Array.isArray(raw) ? null : raw;
  const opId = bytesToHex(data?.[0] ?? object?.op_id);
  const caller = String(data?.[1] ?? object?.caller ?? "");
  await pool.query(
    `UPDATE timelock_operations
     SET status = 'cancelled', cancelled_by = $2, cancelled_at_ledger = $3
     WHERE op_id = $1`,
    [opId, caller, event.ledger],
  );
  invalidate(`timelock:op:${opId}`);
  invalidatePattern("timelock:ops:");
  broadcast({
    type: "timelock_operation_cancelled",
    data: { op_id: opId, caller, ledger: event.ledger },
  });
}

async function handleTimelockBatchOperationScheduled(
  event: SorobanRpc.Api.EventResponse,
  _topics: unknown[],
): Promise<void> {
  const raw = timelockObject(event);
  const data = Array.isArray(raw) ? raw : null;
  const object = Array.isArray(raw) ? null : raw;
  const batchOpId = bytesToHex(data?.[0] ?? object?.batch_op_id);
  const targets = ((data?.[1] ?? object?.targets ?? []) as unknown[]).map(String);
  const fnNames = ((data?.[2] ?? object?.fn_names ?? []) as unknown[]).map(String);
  const readyAt = String(data?.[3] ?? object?.ready_at ?? 0);
  const expiresAt = String(data?.[4] ?? object?.expires_at ?? 0);
  await pool.query(
    `INSERT INTO timelock_batch_operations
       (batch_op_id, targets, fn_names, ready_at, expires_at, status, ledger)
     VALUES ($1, $2, $3, $4, $5, 'scheduled', $6)
     ON CONFLICT (batch_op_id) DO UPDATE SET
       targets = EXCLUDED.targets,
       fn_names = EXCLUDED.fn_names,
       ready_at = EXCLUDED.ready_at,
       expires_at = EXCLUDED.expires_at,
       ledger = EXCLUDED.ledger`,
    [
      batchOpId,
      JSON.stringify(targets),
      JSON.stringify(fnNames),
      readyAt,
      expiresAt,
      event.ledger,
    ],
  );
  invalidate(`timelock:batch:${batchOpId}`);
  invalidatePattern("timelock:batches:");
  broadcast({
    type: "timelock_batch_operation_scheduled",
    data: {
      batch_op_id: batchOpId,
      targets,
      fn_names: fnNames,
      ready_at: readyAt,
      expires_at: expiresAt,
      ledger: event.ledger,
    },
  });
}

async function handleTimelockBatchOperationExecuted(
  event: SorobanRpc.Api.EventResponse,
  _topics: unknown[],
): Promise<void> {
  const raw = timelockObject(event);
  const data = Array.isArray(raw) ? raw : null;
  const object = Array.isArray(raw) ? null : raw;
  const batchOpId = bytesToHex(data?.[0] ?? object?.batch_op_id);
  const caller = String(data?.[1] ?? object?.caller ?? "");
  await pool.query(
    `UPDATE timelock_batch_operations
     SET status = 'executed', executed_by = $2, executed_at_ledger = $3
     WHERE batch_op_id = $1`,
    [batchOpId, caller, event.ledger],
  );
  invalidate(`timelock:batch:${batchOpId}`);
  invalidatePattern("timelock:batches:");
  broadcast({
    type: "timelock_batch_operation_executed",
    data: { batch_op_id: batchOpId, caller, ledger: event.ledger },
  });
}

async function handleTimelockBatchOperationCancelled(
  event: SorobanRpc.Api.EventResponse,
  _topics: unknown[],
): Promise<void> {
  const raw = timelockObject(event);
  const data = Array.isArray(raw) ? raw : null;
  const object = Array.isArray(raw) ? null : raw;
  const batchOpId = bytesToHex(data?.[0] ?? object?.batch_op_id);
  const caller = String(data?.[1] ?? object?.caller ?? "");
  await pool.query(
    `UPDATE timelock_batch_operations
     SET status = 'cancelled', cancelled_by = $2, cancelled_at_ledger = $3
     WHERE batch_op_id = $1`,
    [batchOpId, caller, event.ledger],
  );
  invalidate(`timelock:batch:${batchOpId}`);
  invalidatePattern("timelock:batches:");
  broadcast({
    type: "timelock_batch_operation_cancelled",
    data: { batch_op_id: batchOpId, caller, ledger: event.ledger },
  });
}

async function handleTimelockMinDelayUpdated(
  event: SorobanRpc.Api.EventResponse,
  _topics: unknown[],
): Promise<void> {
  const raw = timelockObject(event);
  const data = Array.isArray(raw) ? raw : null;
  const object = Array.isArray(raw) ? null : raw;
  const oldDelay = String(data?.[0] ?? object?.old_delay ?? 0);
  const newDelay = String(data?.[1] ?? object?.new_delay ?? 0);
  broadcast({
    type: "timelock_min_delay_updated",
    data: {
      old_delay: oldDelay,
      new_delay: newDelay,
      ledger: event.ledger,
    },
  });
}

async function handleTimelockDependencyDagValidated(
  event: SorobanRpc.Api.EventResponse,
  _topics: unknown[],
): Promise<void> {
  const raw = timelockObject(event);
  const data = Array.isArray(raw) ? raw : null;
  const object = Array.isArray(raw) ? null : raw;
  const batchOpId = bytesToHex(data?.[0] ?? object?.batch_op_id);
  const opCount = Number(data?.[1] ?? object?.op_count ?? 0);
  await pool.query(
    `INSERT INTO timelock_dependency_graphs
       (validation_id, batch_op_id, op_count, has_cycle, ledger)
     VALUES ($1, $2, $3, FALSE, $4)
     ON CONFLICT (validation_id) DO NOTHING`,
    [
      timelockEventId(event, "DependencyDagValidated"),
      batchOpId || null,
      opCount,
      event.ledger,
    ],
  );
  if (batchOpId) invalidate(`timelock:dag:${batchOpId}`);
  broadcast({
    type: "timelock_dependency_dag_validated",
    data: { batch_op_id: batchOpId, op_count: opCount, ledger: event.ledger },
  });
}

async function handleTimelockCycleDetected(
  event: SorobanRpc.Api.EventResponse,
  _topics: unknown[],
): Promise<void> {
  const raw = scValToNative(event.value);
  const cyclePath = Array.isArray(raw) ? raw.map(bytesToHex) : [];
  await pool.query(
    `INSERT INTO timelock_dependency_graphs
       (validation_id, batch_op_id, op_count, has_cycle, cycle_path, ledger)
     VALUES ($1, NULL, $2, TRUE, $3, $4)
     ON CONFLICT (validation_id) DO NOTHING`,
    [
      timelockEventId(event, "CycleDetected"),
      cyclePath.length,
      JSON.stringify(cyclePath),
      event.ledger,
    ],
  );
  broadcast({
    type: "timelock_cycle_detected",
    data: { cycle_path: cyclePath, ledger: event.ledger },
  });
}

async function handleTimelockPartialBatchStarted(
  event: SorobanRpc.Api.EventResponse,
  _topics: unknown[],
): Promise<void> {
  const raw = timelockObject(event);
  const data = Array.isArray(raw) ? raw : null;
  const object = Array.isArray(raw) ? null : raw;
  const batchOpId = bytesToHex(data?.[0] ?? object?.batch_op_id);
  const totalOps = Number(data?.[1] ?? object?.total_ops ?? 0);
  await pool.query(
    `INSERT INTO timelock_partial_batch_state
       (batch_op_id, total_ops, completed_ops, status, started_at_ledger, updated_at_ledger)
     VALUES ($1, $2, 0, 'in_progress', $3, $3)
     ON CONFLICT (batch_op_id) DO UPDATE SET
       total_ops = EXCLUDED.total_ops,
       status = 'in_progress',
       updated_at_ledger = EXCLUDED.updated_at_ledger`,
    [batchOpId, totalOps, event.ledger],
  );
  invalidate(`timelock:partial_state:${batchOpId}`);
  broadcast({
    type: "timelock_partial_batch_started",
    data: { batch_op_id: batchOpId, total_ops: totalOps, ledger: event.ledger },
  });
}

async function handleTimelockPartialOpSucceeded(
  event: SorobanRpc.Api.EventResponse,
  _topics: unknown[],
): Promise<void> {
  const raw = timelockObject(event);
  const data = Array.isArray(raw) ? raw : null;
  const object = Array.isArray(raw) ? null : raw;
  const batchOpId = bytesToHex(data?.[0] ?? object?.batch_op_id);
  const opId = bytesToHex(data?.[1] ?? object?.op_id);
  const completed = Number(data?.[2] ?? object?.completed ?? 0);
  const total = Number(data?.[3] ?? object?.total ?? 0);
  await pool.query(
    `UPDATE timelock_partial_batch_state
     SET completed_ops = $2, total_ops = $3, last_op_id = $4,
         last_status = 'succeeded', updated_at_ledger = $5
     WHERE batch_op_id = $1`,
    [batchOpId, completed, total, opId, event.ledger],
  );
  invalidate(`timelock:partial_state:${batchOpId}`);
  broadcast({
    type: "timelock_partial_op_succeeded",
    data: {
      batch_op_id: batchOpId,
      op_id: opId,
      completed,
      total,
      ledger: event.ledger,
    },
  });
}

async function handleTimelockPartialOpFailed(
  event: SorobanRpc.Api.EventResponse,
  _topics: unknown[],
): Promise<void> {
  const raw = timelockObject(event);
  const data = Array.isArray(raw) ? raw : null;
  const object = Array.isArray(raw) ? null : raw;
  const batchOpId = bytesToHex(data?.[0] ?? object?.batch_op_id);
  const opId = bytesToHex(data?.[1] ?? object?.op_id);
  await pool.query(
    `UPDATE timelock_partial_batch_state
     SET last_op_id = $2, last_status = 'failed', updated_at_ledger = $3
     WHERE batch_op_id = $1`,
    [batchOpId, opId, event.ledger],
  );
  invalidate(`timelock:partial_state:${batchOpId}`);
  broadcast({
    type: "timelock_partial_op_failed",
    data: { batch_op_id: batchOpId, op_id: opId, ledger: event.ledger },
  });
}

async function handleTimelockBatchRecoveryEntered(
  event: SorobanRpc.Api.EventResponse,
  _topics: unknown[],
): Promise<void> {
  const raw = timelockObject(event);
  const data = Array.isArray(raw) ? raw : null;
  const object = Array.isArray(raw) ? null : raw;
  const batchOpId = bytesToHex(data?.[0] ?? object?.batch_op_id);
  const recoveryDeadline = Number(
    data?.[1] ?? object?.recovery_deadline ?? 0,
  );
  await pool.query(
    `UPDATE timelock_partial_batch_state
     SET status = 'recovery', recovery_deadline = $2, updated_at_ledger = $3
     WHERE batch_op_id = $1`,
    [batchOpId, recoveryDeadline, event.ledger],
  );
  invalidate(`timelock:partial_state:${batchOpId}`);
  broadcast({
    type: "timelock_batch_recovery_entered",
    data: {
      batch_op_id: batchOpId,
      recovery_deadline: recoveryDeadline,
      ledger: event.ledger,
    },
  });
}

async function handleTimelockFailedOpRetried(
  event: SorobanRpc.Api.EventResponse,
  _topics: unknown[],
): Promise<void> {
  const raw = timelockObject(event);
  const data = Array.isArray(raw) ? raw : null;
  const object = Array.isArray(raw) ? null : raw;
  const batchOpId = bytesToHex(data?.[0] ?? object?.batch_op_id);
  const opId = bytesToHex(data?.[1] ?? object?.op_id);
  const retryCount = Number(data?.[2] ?? object?.retry_count ?? 0);
  const succeeded = Boolean(data?.[3] ?? object?.succeeded ?? false);
  await pool.query(
    `UPDATE timelock_partial_batch_state
     SET last_op_id = $2, retry_count = $3, last_status = $4,
         updated_at_ledger = $5
     WHERE batch_op_id = $1`,
    [
      batchOpId,
      opId,
      retryCount,
      succeeded ? "succeeded" : "failed",
      event.ledger,
    ],
  );
  invalidate(`timelock:partial_state:${batchOpId}`);
  broadcast({
    type: "timelock_failed_op_retried",
    data: {
      batch_op_id: batchOpId,
      op_id: opId,
      retry_count: retryCount,
      succeeded,
      ledger: event.ledger,
    },
  });
}

async function handleTimelockFailedOpSkipped(
  event: SorobanRpc.Api.EventResponse,
  _topics: unknown[],
): Promise<void> {
  const raw = timelockObject(event);
  const data = Array.isArray(raw) ? raw : null;
  const object = Array.isArray(raw) ? null : raw;
  const batchOpId = bytesToHex(data?.[0] ?? object?.batch_op_id);
  const opId = bytesToHex(data?.[1] ?? object?.op_id);
  await pool.query(
    `UPDATE timelock_partial_batch_state
     SET last_op_id = $2, last_status = 'skipped', updated_at_ledger = $3
     WHERE batch_op_id = $1`,
    [batchOpId, opId, event.ledger],
  );
  invalidate(`timelock:partial_state:${batchOpId}`);
  broadcast({
    type: "timelock_failed_op_skipped",
    data: { batch_op_id: batchOpId, op_id: opId, ledger: event.ledger },
  });
}

async function handleTimelockBatchFullyComplete(
  event: SorobanRpc.Api.EventResponse,
  _topics: unknown[],
): Promise<void> {
  const raw = scValToNative(event.value);
  const batchOpId = Array.isArray(raw)
    ? bytesToHex(raw[0])
    : typeof raw === "object" && raw !== null && "batch_op_id" in raw
      ? bytesToHex((raw as Record<string, unknown>).batch_op_id)
      : bytesToHex(raw);
  await pool.query(
    `UPDATE timelock_partial_batch_state
     SET status = 'completed', completed_at_ledger = $2,
         updated_at_ledger = $2
     WHERE batch_op_id = $1`,
    [batchOpId, event.ledger],
  );
  await pool.query(
    `UPDATE timelock_batch_operations
     SET status = 'executed',
         executed_at_ledger = COALESCE(executed_at_ledger, $2)
     WHERE batch_op_id = $1`,
    [batchOpId, event.ledger],
  );
  invalidate(
    `timelock:partial_state:${batchOpId}`,
    `timelock:batch:${batchOpId}`,
  );
  invalidatePattern("timelock:batches:");
  broadcast({
    type: "timelock_batch_fully_complete",
    data: { batch_op_id: batchOpId, ledger: event.ledger },
  });
}
