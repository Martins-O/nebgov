/**
 * `MockSorobanServer` — a stateful, in-memory stand-in for
 * `SorobanRpc.Server`, wired in by `SimulationHarness.boot()` via
 * `jest.mock("@stellar/stellar-sdk", ...)` (the same seam
 * `sdk/src/__tests__/governor.test.ts` uses).
 *
 * `@nebgov/sdk`'s `GovernorClient`/`TimelockClient`/`VotesClient` build real
 * Soroban operations via `Contract.call()` + `TransactionBuilder`, so this
 * class decodes the real XDR operation off the transaction it's handed
 * (contract address, function name, args) and dispatches to the matching
 * in-memory executor, rather than short-circuiting the SDK's own encoding.
 */
import { Address, nativeToScVal, scValToNative, SorobanDataBuilder, xdr } from "@stellar/stellar-sdk";
import { LedgerClock } from "../ledger";
import { cloneStore, BudgetStreamRecord, CoSponsorshipDraftRecord, MockLedgerStore, OptimisticProposalRecord, ProposalRecord, StreamSpendRecord } from "./store";
import { MockContractError } from "./errors";
import { governorExecutor } from "./governor-executor";
import { timelockExecutor } from "./timelock-executor";
import { tokenVotesExecutor } from "./token-votes-executor";
import { coSponsorshipExecutor } from "./co-sponsorship-executor";
import { optimisticGovernorExecutor } from "./optimistic-governor-executor";
import { treasuryExecutor, StreamBudgetReportRecord, TreasuryBudgetSummaryRecord } from "./treasury-executor";
import {
  encAddress,
  encBool,
  encBytes,
  encEnum,
  encI128,
  encMap,
  encString,
  encSymbol,
  encU32,
  encU64,
  encVec,
  encVoid,
} from "./codec";

interface DecodedInvocation {
  contractAddress: string;
  functionName: string;
  args: unknown[];
  caller: string;
}

interface StoredTxResult {
  status: "SUCCESS" | "FAILED";
  returnValue?: xdr.ScVal;
  error?: string;
}

/**
 * Duck-typed `Account` (the trio `TransactionBuilder` actually calls:
 * `accountId()`/`sequenceNumber()`/`incrementSequenceNumber()`). Several SDK
 * read paths call `getAccount()` with a contract ("C...") address as a
 * throwaway simulation source, which the real `Account` class's strkey
 * validation would reject — this accepts any id.
 */
class MockAccount {
  constructor(
    private readonly id: string,
    private sequence: bigint,
  ) {}

  accountId(): string {
    return this.id;
  }

  sequenceNumber(): string {
    return this.sequence.toString();
  }

  incrementSequenceNumber(): void {
    this.sequence += 1n;
  }
}

function decodeInvocation(tx: { operations: unknown[]; source: string }): DecodedInvocation {
  const op = tx.operations[0] as { type?: string; func?: xdr.HostFunction; source?: string };
  if (!op || op.type !== "invokeHostFunction" || !op.func) {
    throw new Error("MockSorobanServer only supports a single invokeHostFunction operation");
  }
  const invoke = op.func.invokeContract();
  const contractAddress = Address.fromScAddress(invoke.contractAddress()).toString();
  const rawName = invoke.functionName();
  const functionName = typeof rawName === "string" ? rawName : Buffer.from(rawName).toString();
  const args = invoke.args().map((arg) => scValToNative(arg));
  return { contractAddress, functionName, args, caller: op.source ?? tx.source };
}

function encodeGovernorSettings(settings: MockLedgerStore["governor"]["settings"]): xdr.ScVal {
  return encMap({
    voting_delay: encU32(settings.votingDelay),
    voting_period: encU32(settings.votingPeriod),
    quorum_numerator: encU32(settings.quorumNumerator),
    proposal_threshold: encI128(settings.proposalThreshold),
    guardian: encAddress(settings.guardian),
    vote_type: encEnum(settings.voteType),
    proposal_grace_period: encU32(settings.proposalGracePeriod),
    use_dynamic_quorum: encBool(settings.useDynamicQuorum),
    reflector_oracle: settings.reflectorOracle ? encAddress(settings.reflectorOracle) : encVoid(),
    min_quorum_usd: encI128(settings.minQuorumUsd),
    max_calldata_size: encU32(settings.maxCalldataSize),
    proposal_cooldown: encU32(settings.proposalCooldown),
    max_proposals_per_period: encU32(settings.maxProposalsPerPeriod),
    proposal_period_duration: encU32(settings.proposalPeriodDuration),
  });
}

function encodeProposal(proposal: ProposalRecord): xdr.ScVal {
  return encMap({
    id: encU64(proposal.id),
    proposer: encAddress(proposal.proposer),
    description: encString(proposal.description),
    description_hash: encBytes(Buffer.from(proposal.descriptionHash, "hex")),
    metadata_uri: encString(proposal.metadataUri),
    targets: encVec(proposal.targets.map(encAddress)),
    fn_names: encVec(proposal.fnNames.map(encSymbol)),
    calldatas: encVec(proposal.calldatas.map(encBytes)),
    start_ledger: encU32(proposal.startLedger),
    end_ledger: encU32(proposal.endLedger),
    votes_for: encI128(proposal.votesFor),
    votes_against: encI128(proposal.votesAgainst),
    votes_abstain: encI128(proposal.votesAbstain),
    executed: encBool(proposal.executed),
    cancelled: encBool(proposal.cancelled),
    queued: encBool(proposal.queued),
    op_ids: encVec(proposal.opIds.map((id) => encBytes(Buffer.from(id, "hex")))),
  });
}

function encodeCoSponsorshipDraft(draft: CoSponsorshipDraftRecord): xdr.ScVal {
  return encMap({
    id: encU64(draft.id),
    creator: encAddress(draft.creator),
    description: encString(draft.description),
    description_hash: encBytes(draft.descriptionHash),
    metadata_uri: encString(draft.metadataUri),
    targets: encVec(draft.targets.map(encAddress)),
    fn_names: encVec(draft.fnNames.map(encSymbol)),
    calldatas: encVec(draft.calldatas.map(encBytes)),
    created_ledger: encU32(draft.createdLedger),
    expiry_ledger: encU32(draft.expiryLedger),
    co_sponsors: encVec(draft.coSponsors.map(encAddress)),
    co_sponsor_power: encVec(draft.coSponsorPower.map(encI128)),
    total_power: encI128(draft.totalPower),
    finalized: encBool(draft.finalized),
    cancelled: encBool(draft.cancelled),
  });
}

function encodeOptimisticProposal(proposal: OptimisticProposalRecord): xdr.ScVal {
  return encMap({
    id: encU64(proposal.id),
    proposer: encAddress(proposal.proposer),
    target: encAddress(proposal.target),
    fn_name: encSymbol(proposal.fnName),
    calldata: encBytes(proposal.calldata),
    description_hash: encBytes(proposal.descriptionHash),
    created_ledger: encU32(proposal.createdLedger),
    challenge_end_ledger: encU32(proposal.challengeEndLedger),
    objection_votes: encI128(proposal.objectionVotes),
    state: encEnum(proposal.state),
  });
}

function encodeBudgetStream(stream: BudgetStreamRecord): xdr.ScVal {
  return encMap({
    id: encU64(stream.id),
    name: encSymbol(stream.name),
    owner: encAddress(stream.owner),
    token: encAddress(stream.token),
    total_allocated: encI128(stream.totalAllocated),
    total_spent: encI128(stream.totalSpent),
    start_ledger: encU32(stream.startLedger),
    end_ledger: encU32(stream.endLedger),
    is_active: encBool(stream.isActive),
    is_revoked: encBool(stream.isRevoked),
    // `Option<u32>`: `None` goes on the wire as `ScvVoid`.
    revoked_at_ledger: stream.revokedAtLedger != null ? encU32(stream.revokedAtLedger) : encVoid(),
    max_single_spend: encI128(stream.maxSingleSpend),
    cooldown_ledgers: encU32(stream.cooldownLedgers),
    last_spend_ledger: encU32(stream.lastSpendLedger),
    spend_count: encU32(stream.spendCount),
    created_by_proposal_id: encU64(stream.createdByProposalId),
  });
}

function encodeStreamSpend(spend: StreamSpendRecord): xdr.ScVal {
  return encMap({
    stream_id: encU64(spend.streamId),
    spend_index: encU32(spend.spendIndex),
    recipient: encAddress(spend.recipient),
    amount: encI128(spend.amount),
    memo: encString(spend.memo),
    executed_at_ledger: encU32(spend.executedAtLedger),
    executed_by: encAddress(spend.executedBy),
  });
}

function encodeStreamBudgetReport(report: StreamBudgetReportRecord): xdr.ScVal {
  return encMap({
    stream_id: encU64(report.streamId),
    name: encSymbol(report.name),
    total_allocated: encI128(report.totalAllocated),
    total_spent: encI128(report.totalSpent),
    remaining: encI128(report.remaining),
    utilization_bps: encU32(report.utilizationBps),
    is_active: encBool(report.isActive),
    days_remaining: encU32(report.daysRemaining),
    spend_count: encU32(report.spendCount),
    avg_spend: encI128(report.avgSpend),
  });
}

function encodeTokenAmounts(pairs: Array<[string, bigint]>): xdr.ScVal {
  return encVec(pairs.map(([token, amount]) => encVec([encAddress(token), encI128(amount)])));
}

function encodeTreasuryBudgetSummary(summary: TreasuryBudgetSummaryRecord): xdr.ScVal {
  return encMap({
    total_streams: encU32(summary.totalStreams),
    active_streams: encU32(summary.activeStreams),
    total_allocated_by_token: encodeTokenAmounts(summary.totalAllocatedByToken),
    total_spent_by_token: encodeTokenAmounts(summary.totalSpentByToken),
    total_remaining_by_token: encodeTokenAmounts(summary.totalRemainingByToken),
  });
}

function encodeReturn(
  contract: "governor" | "timelock" | "votes" | "coSponsorship" | "optimisticGovernor" | "treasury",
  fnName: string,
  value: unknown,
): xdr.ScVal {
  if (contract === "treasury") {
    switch (fnName) {
      case "create_stream":
        return encU64(value as bigint);
      case "stream_spend":
      case "top_up_stream":
        return encVoid();
      case "get_stream":
        return encodeBudgetStream(value as BudgetStreamRecord);
      case "get_streams":
        return encVec((value as BudgetStreamRecord[]).map(encodeBudgetStream));
      case "get_stream_spends":
        return encVec((value as StreamSpendRecord[]).map(encodeStreamSpend));
      case "get_stream_report":
        return encodeStreamBudgetReport(value as StreamBudgetReportRecord);
      case "get_stream_remaining":
        return encI128(value as bigint);
      case "get_budget_summary":
        return encodeTreasuryBudgetSummary(value as TreasuryBudgetSummaryRecord);
      default:
        throw new Error(`MockSorobanServer: no encoder for treasury.${fnName}`);
    }
  }
  if (contract === "optimisticGovernor") {
    switch (fnName) {
      case "propose":
        return encU64(value as bigint);
      case "object":
      case "finalize":
      case "execute":
      case "cancel":
      case "update_config":
        return encVoid();
      case "get_proposal":
        return encodeOptimisticProposal(value as OptimisticProposalRecord);
      case "get_config": {
        const config = value as {
          votesToken: string;
          challengeWindowLedgers: number;
          objectionThresholdBps: number;
          proposerBondAmount: bigint;
          proposerBondToken: string;
        };
        return encMap({
          votes_token: encAddress(config.votesToken),
          challenge_window_ledgers: encU32(config.challengeWindowLedgers),
          objection_threshold_bps: encU32(config.objectionThresholdBps),
          proposer_bond_amount: encI128(config.proposerBondAmount),
          proposer_bond_token: encAddress(config.proposerBondToken),
        });
      }
      default:
        throw new Error(`MockSorobanServer: no encoder for optimisticGovernor.${fnName}`);
    }
  }
  if (contract === "coSponsorship") {
    switch (fnName) {
      case "create_draft":
      case "finalize_draft":
        return encU64(value as bigint);
      case "co_sponsor":
        return encVoid();
      case "get_draft":
        return encodeCoSponsorshipDraft(value as CoSponsorshipDraftRecord);
      default:
        throw new Error(`MockSorobanServer: no encoder for coSponsorship.${fnName}`);
    }
  }
  if (contract === "governor") {
    switch (fnName) {
      case "propose":
      case "proposal_count":
        return encU64(value as bigint);
      case "cast_vote":
      case "queue":
      case "execute":
      case "cancel":
      case "cancel_queued":
      case "update_config":
      case "set_guardian":
      case "set_voting_strategy":
      case "migrate":
      case "pause":
      case "unpause":
        return encVoid();
      case "state":
        return encEnum(value as string);
      case "get_settings":
        return encodeGovernorSettings(value as MockLedgerStore["governor"]["settings"]);
      case "get_quorum":
      case "proposal_threshold":
        return encI128(value as bigint);
      case "is_quorum_reached":
        return encBool(value as boolean);
      case "proposal_votes":
        return encVec((value as bigint[]).map(encI128));
      case "has_voted":
        return encBool(value as boolean);
      case "get_proposal":
        return encodeProposal(value as ProposalRecord);
      case "proposals_count_by_state":
        return encVoid();
      default:
        throw new Error(`MockSorobanServer: no encoder for governor.${fnName}`);
    }
  }
  if (contract === "timelock") {
    switch (fnName) {
      case "is_ready":
      case "is_pending":
        return encBool(value as boolean);
      case "min_delay":
      case "execution_window":
        return encU64(value as bigint);
      case "schedule_with_deps":
        return value ? encAddress(value as string) : encVoid();
      case "validate_dependency_dag":
      case "execute_batch_partial":
      case "retry_failed_operation":
      case "skip_failed_operation":
        return encVoid();
      default:
        throw new Error(`MockSorobanServer: no encoder for timelock.${fnName}`);
    }
  }
  switch (fnName) {
    case "delegate":
      return encVoid();
    case "get_votes":
    case "get_base_votes":
    case "get_past_votes":
    case "get_past_total_supply":
      return encI128(value as bigint);
    case "delegates":
      return value ? encAddress(value as string) : encVoid();
    default:
      throw new Error(`MockSorobanServer: no encoder for votes.${fnName}`);
  }
}

export class MockSorobanServer {
  private readonly results = new Map<string, StoredTxResult>();

  constructor(
    private store: MockLedgerStore,
    private readonly clock: LedgerClock,
  ) {}

  /** Swap in a restored store (e.g. after `SimulationHarness.restore()`). */
  setStore(store: MockLedgerStore): void {
    this.store = store;
    this.results.clear();
  }

  private resolveContract(
    address: string,
  ): "governor" | "timelock" | "votes" | "coSponsorship" | "optimisticGovernor" | "treasury" {
    if (address === this.store.addresses.governor) return "governor";
    if (address === this.store.addresses.timelock) return "timelock";
    if (address === this.store.addresses.votes) return "votes";
    if (address === this.store.addresses.coSponsorship) return "coSponsorship";
    if (address === this.store.addresses.optimisticGovernor) return "optimisticGovernor";
    if (address === this.store.addresses.treasury) return "treasury";
    throw new Error(`MockSorobanServer: unknown contract address ${address}`);
  }

  private dispatch(invocation: DecodedInvocation, store: MockLedgerStore): unknown {
    const contract = this.resolveContract(invocation.contractAddress);
    if (contract === "governor") {
      const handler = (governorExecutor as Record<string, (...a: unknown[]) => unknown>)[invocation.functionName];
      if (!handler) throw new Error(`MockSorobanServer: unknown governor function ${invocation.functionName}`);
      return handler(store, this.clock, invocation.caller, invocation.args);
    }
    if (contract === "timelock") {
      const handler = (timelockExecutor as Record<string, (...a: unknown[]) => unknown>)[invocation.functionName];
      if (!handler) throw new Error(`MockSorobanServer: unknown timelock function ${invocation.functionName}`);
      return handler(store.timelock, this.clock, invocation.caller, invocation.args);
    }
    if (contract === "coSponsorship") {
      const handler = (coSponsorshipExecutor as Record<string, (...a: unknown[]) => unknown>)[invocation.functionName];
      if (!handler) throw new Error(`MockSorobanServer: unknown co-sponsorship function ${invocation.functionName}`);
      return handler(store, this.clock, invocation.caller, invocation.args);
    }
    if (contract === "optimisticGovernor") {
      const handler = (optimisticGovernorExecutor as Record<string, (...a: unknown[]) => unknown>)[invocation.functionName];
      if (!handler) {
        throw new Error(`MockSorobanServer: unknown optimistic-governor function ${invocation.functionName}`);
      }
      return handler(store, this.clock, invocation.caller, invocation.args);
    }
    if (contract === "treasury") {
      const handler = (treasuryExecutor as Record<string, (...a: unknown[]) => unknown>)[invocation.functionName];
      if (!handler) {
        throw new Error(`MockSorobanServer: unknown treasury function ${invocation.functionName}`);
      }
      return handler(store, this.clock, invocation.caller, invocation.args);
    }
    const handler = (tokenVotesExecutor as Record<string, (...a: unknown[]) => unknown>)[invocation.functionName];
    if (!handler) throw new Error(`MockSorobanServer: unknown votes function ${invocation.functionName}`);
    return handler(store.votes, this.clock, invocation.caller, invocation.args);
  }

  async getAccount(accountId: string): Promise<MockAccount> {
    return new MockAccount(accountId, 0n);
  }

  async getLatestLedger(): Promise<{ id: string; protocolVersion: number; sequence: number }> {
    return { id: "mock-ledger", protocolVersion: 21, sequence: this.clock.sequence };
  }

  async prepareTransaction<T>(tx: T): Promise<T> {
    return tx;
  }

  async simulateTransaction(tx: { operations: unknown[]; source: string }): Promise<Record<string, unknown>> {
    const invocation = decodeInvocation(tx);
    const contract = this.resolveContract(invocation.contractAddress);
    const scratch = cloneStore(this.store);

    try {
      const value = this.dispatch(invocation, scratch);
      const retval = encodeReturn(contract, invocation.functionName, value);
      return {
        _parsed: true,
        id: "1",
        latestLedger: this.clock.sequence,
        events: [],
        transactionData: new SorobanDataBuilder(),
        minResourceFee: "100000",
        cost: { cpuInsns: "0", memBytes: "0" },
        result: { auth: [], retval },
      };
    } catch (e) {
      return {
        _parsed: true,
        id: "1",
        latestLedger: this.clock.sequence,
        events: [],
        error: e instanceof MockContractError ? e.toSorobanErrorString() : String(e instanceof Error ? e.message : e),
      };
    }
  }

  async sendTransaction(tx: { operations: unknown[]; source: string; hash(): Buffer }): Promise<Record<string, unknown>> {
    const invocation = decodeInvocation(tx);
    const contract = this.resolveContract(invocation.contractAddress);
    const hash = tx.hash().toString("hex");

    try {
      const value = this.dispatch(invocation, this.store);
      const returnValue = encodeReturn(contract, invocation.functionName, value);
      this.results.set(hash, { status: "SUCCESS", returnValue });
      return { status: "PENDING", hash, latestLedgerCloseTime: String(Math.floor(this.clock.timestamp)) };
    } catch (e) {
      const message = e instanceof MockContractError ? e.toSorobanErrorString() : String(e instanceof Error ? e.message : e);
      this.results.set(hash, { status: "FAILED", error: message });
      return { status: "ERROR", hash, error: message };
    }
  }

  async getTransaction(hash: string): Promise<Record<string, unknown>> {
    const result = this.results.get(hash);
    if (!result) {
      return { status: "NOT_FOUND" };
    }
    if (result.status === "FAILED") {
      return { status: "FAILED" };
    }
    return { status: "SUCCESS", returnValue: result.returnValue, latestLedger: this.clock.sequence };
  }
}

// Re-exported so callers building raw operations (functions not yet wrapped
// by @nebgov/sdk, e.g. `cancel_queued`) can reuse the same native<->ScVal
// helpers the executors were verified against.
export { nativeToScVal, scValToNative };
