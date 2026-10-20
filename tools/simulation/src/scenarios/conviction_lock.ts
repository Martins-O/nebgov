import { ConvictionProposal } from "@nebgov/sdk";
import { Actor } from "../actors";
import { AssertionError } from "../assertions/errors";
import { SimulationHarness } from "../harness";
import { ConvictionVotingContractError, powBps, projectConviction } from "../mock/conviction-voting-executor";
import { ConvictionExecutionRecord } from "../mock/store";
import { BaseScenario, SimulationResult } from "./base";

export interface ConvictionLockScenarioConfig {
  /** Creates the conviction proposal (non-custodial: no bond, no token transfer). */
  proposer: Actor;
  /** First supporter — locks voting power onto the proposal. */
  locker: Actor;
  /** Second supporter — locks later, tipping conviction past the threshold. */
  coSupporter: Actor;
  /** Voting power the locker commits. Defaults to 1_000n. */
  lockAmount?: bigint;
  /** Voting power the co-supporter commits. Defaults to `lockAmount`. */
  coLockAmount?: bigint;
  /** Token amount the proposal requests (0 -> minimum threshold). Defaults to 0n. */
  requestedAmount?: bigint;
  /** Function the self-executing proposal invokes on the governor. Defaults to "noop". */
  fnName?: string;
}

export interface ConvictionLockScenarioResult extends SimulationResult {
  /** Id of the conviction proposal the scenario created. */
  convictionProposalId: number;
  /** Dynamic threshold the self-executing proposal had to clear. */
  threshold: bigint;
  /** Conviction after the first, partial accrual checkpoint. */
  midConviction: bigint;
  /** Conviction once the lock's decay window expired: the steady-state multiplier cap. */
  expiryConviction: bigint;
  /** Conviction at the checkpoint that self-executed the proposal. */
  finalConviction: bigint;
  /** Self-executions recorded by the mock — exactly one once the threshold is crossed. */
  executions: ConvictionExecutionRecord[];
}

/**
 * Drives one conviction-voting proposal end to end against the mock RPC and
 * asserts its state after every step: a supporter locks voting power onto the
 * proposal (non-custodial — no tokens move), conviction accrues under the
 * time-weighted multiplier until the decay window expires and the score sits
 * at its steady-state cap, a second lock tips the score past the dynamic
 * threshold, and a permissionless checkpoint self-executes the proposal's
 * action exactly once.
 *
 * The harness must seed `config.conviction.minThresholdConviction` above the
 * first lock's steady-state cap and below the two-lock cap, so the expiry
 * checkpoint stays open and only the second lock can execute.
 */
export class ConvictionLockScenario extends BaseScenario {
  constructor(
    harness: SimulationHarness,
    private config: ConvictionLockScenarioConfig,
  ) {
    super(harness);
  }

  private expect(condition: boolean, message: string): void {
    if (!condition) throw new AssertionError(message);
  }

  /** `JSON.stringify` stand-in that renders bigints (stake amounts, ids) as strings. */
  private describe(value: unknown): string {
    return JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? `${v}` : v));
  }

  /** Assert a conviction proposal's state at the current ledger. */
  private async expectProposal(
    step: string,
    proposalId: number,
    expected: {
      conviction: bigint;
      lastUpdatedLedger: number;
      executed: boolean;
    },
  ): Promise<ConvictionProposal> {
    const proposal = await this.harness.convictionClient.getProposal(proposalId);
    this.expect(
      Number(proposal.id) === proposalId,
      `${step}: proposal must be #${proposalId}, got ${proposal.id}`,
    );
    this.expect(
      proposal.conviction === expected.conviction,
      `${step}: conviction must be ${expected.conviction}, got ${proposal.conviction}`,
    );
    this.expect(
      proposal.lastUpdatedLedger === expected.lastUpdatedLedger,
      `${step}: conviction must have last accrued at ledger ${expected.lastUpdatedLedger}, got ${proposal.lastUpdatedLedger}`,
    );
    this.expect(
      proposal.executed === expected.executed,
      `${step}: proposal executed flag must be ${expected.executed}`,
    );
    this.expect(!proposal.cancelled, `${step}: proposal must not be cancelled`);
    return proposal;
  }

  async run(): Promise<ConvictionLockScenarioResult> {
    const startLedger = this.harness.clock.sequence;
    const { convictionClient: client, convictionSettings, votesClient, addresses } = this.harness;
    const { proposer, locker, coSupporter } = this.config;
    const lock = this.config.lockAmount ?? 1_000n;
    const coLock = this.config.coLockAmount ?? lock;
    const requested = this.config.requestedAmount ?? 0n;
    const fnName = this.config.fnName ?? "noop";
    const target = addresses.governor;
    const calldata = Buffer.from([]);

    // ── Step 1: the proposal is created on the conviction track. ────────────
    const step1 = "proposal creation";
    const proposalId = await client.createProposal(proposer.keypair, target, fnName, calldata, requested);
    const createdAt = this.harness.clock.sequence;
    let proposal = await this.expectProposal(step1, proposalId, {
      conviction: 0n,
      lastUpdatedLedger: createdAt,
      executed: false,
    });
    this.expect(
      proposal.proposer === proposer.publicKey,
      `${step1}: proposer must be ${proposer.publicKey}, got ${proposal.proposer}`,
    );
    this.expect(
      proposal.target === target && proposal.fnName === fnName,
      `${step1}: action must be ${target}.${fnName}, got ${proposal.target}.${proposal.fnName}`,
    );
    this.expect(
      proposal.requestedAmount === requested && proposal.createdLedger === createdAt,
      `${step1}: requested amount / creation ledger must round-trip`,
    );
    const threshold = await client.getRequiredThreshold(requested);
    this.expect(threshold > 0n, `${step1}: threshold must be positive, got ${threshold}`);

    // ── Step 2: the locker locks voting power onto the proposal. ────────────
    const step2 = "vote with lock";
    const lockerVotesBefore = await votesClient.getVotes(locker.publicKey);
    await client.stake(locker.keypair, proposalId, lock);
    const stakes = await this.harness.getConvictionStakes(proposalId);
    this.expect(
      stakes.length === 1 &&
        stakes[0].staker === locker.publicKey &&
        stakes[0].amount === lock &&
        stakes[0].proposalId === BigInt(proposalId),
      `${step2}: the lock must be recorded as ${lock} from ${locker.publicKey}, got ${this.describe(stakes)}`,
    );
    // No ledgers elapsed, so nothing has accrued yet.
    proposal = await this.expectProposal(step2, proposalId, {
      conviction: 0n,
      lastUpdatedLedger: createdAt,
      executed: false,
    });
    this.expect(proposal.conviction < threshold, `${step2}: conviction must start below the threshold`);
    // The lock is non-custodial: voting power is committed, not transferred.
    this.expect(
      (await votesClient.getVotes(locker.publicKey)) === lockerVotesBefore,
      `${step2}: locking must not move the locker's voting power`,
    );
    // A lock is bounded by the staker's live voting power.
    const coSupporterVotes = await votesClient.getVotes(coSupporter.publicKey);
    let overLockRejection: unknown;
    try {
      await client.stake(coSupporter.keypair, proposalId, coSupporterVotes + 1n);
    } catch (e) {
      overLockRejection = e;
    }
    this.expect(
      (overLockRejection as { code?: number } | null)?.code === ConvictionVotingContractError.InsufficientVotingPower,
      `${step2}: a lock larger than the co-supporter's voting power must be rejected with InsufficientVotingPower, got ${String(overLockRejection)}`,
    );
    this.expect(
      (await this.harness.getConvictionStakes(proposalId)).length === 1,
      `${step2}: a rejected lock must leave the stake list untouched`,
    );

    // ── Step 3: conviction partially accrues under the time multiplier. ─────
    const step3 = "partial conviction accrual";
    const accrualLedgers = 10;
    await this.harness.advanceLedgers(accrualLedgers);
    const partial = await client.checkpointConviction(locker.keypair, proposalId);
    const midConviction = projectConviction(0n, lock, accrualLedgers, convictionSettings);
    this.expect(
      partial.conviction === midConviction && midConviction > 0n,
      `${step3}: conviction must be the exact accrual ${midConviction}, got ${partial.conviction}`,
    );
    this.expect(
      !partial.executed && midConviction < threshold,
      `${step3}: a partial accrual of ${midConviction} must stay below the ${threshold} threshold`,
    );
    proposal = await this.expectProposal(step3, proposalId, {
      conviction: midConviction,
      lastUpdatedLedger: this.harness.clock.sequence,
      executed: false,
    });

    // ── Step 4: at the decay window's expiry the multiplier hits its cap. ───
    const step4 = "conviction multiplier at decay-window expiry";
    const expiryHorizon = 91;
    await this.harness.advanceLedgers(expiryHorizon);
    this.expect(
      powBps(convictionSettings.decayBps, expiryHorizon) === 0n,
      `${step4}: the expiry horizon must exhaust the decay multiplier for decayBps=${convictionSettings.decayBps}`,
    );
    const atExpiry = await client.checkpointConviction(locker.keypair, proposalId);
    const steadyState =
      (lock * BigInt(convictionSettings.weightBps)) / (10_000n - BigInt(convictionSettings.decayBps));
    const expiryConviction = projectConviction(midConviction, lock, expiryHorizon, convictionSettings);
    this.expect(
      expiryConviction === steadyState,
      `${step4}: with decay exhausted conviction must sit at its steady-state cap ${steadyState}, got ${expiryConviction}`,
    );
    this.expect(
      expiryConviction > midConviction,
      `${step4}: the multiplier must keep growing conviction past the partial accrual ${midConviction}`,
    );
    this.expect(
      !atExpiry.executed && expiryConviction < threshold,
      `${step4}: the ${expiryConviction} cap must stay below the ${threshold} threshold — one lock cannot execute`,
    );
    proposal = await this.expectProposal(step4, proposalId, {
      conviction: expiryConviction,
      lastUpdatedLedger: this.harness.clock.sequence,
      executed: false,
    });

    // ── Step 5: a second lock tips conviction past the threshold. ───────────
    const step5 = "second lock tips conviction past the threshold";
    await client.stake(coSupporter.keypair, proposalId, coLock);
    const allStakes = await this.harness.getConvictionStakes(proposalId);
    this.expect(
      allStakes.length === 2 &&
        allStakes.some((s) => s.staker === coSupporter.publicKey && s.amount === coLock),
      `${step5}: the co-supporter's lock of ${coLock} must join the stake list, got ${this.describe(allStakes)}`,
    );
    // Staking at the current ledger accrues nothing — same-ledger bookkeeping only.
    proposal = await this.expectProposal(step5, proposalId, {
      conviction: expiryConviction,
      lastUpdatedLedger: this.harness.clock.sequence,
      executed: false,
    });

    const totalLock = lock + coLock;
    const approachLedgers = 5;
    await this.harness.advanceLedgers(approachLedgers);
    const approaching = await client.checkpointConviction(locker.keypair, proposalId);
    const approachConviction = projectConviction(expiryConviction, totalLock, approachLedgers, convictionSettings);
    this.expect(
      approaching.conviction === approachConviction,
      `${step5}: conviction must be the exact accrual ${approachConviction}, got ${approaching.conviction}`,
    );
    this.expect(
      !approaching.executed && approachConviction < threshold,
      `${step5}: ${approachConviction} must still fall short of the ${threshold} threshold`,
    );

    // ── Step 6: the next checkpoint self-executes the proposal. ─────────────
    const step6 = "self-execution";
    const executeLedgers = 5;
    const executingAt = this.harness.clock.sequence + executeLedgers;
    await this.harness.advanceLedgers(executeLedgers);
    const executing = await client.checkpointConviction(locker.keypair, proposalId);
    const finalConviction = projectConviction(approachConviction, totalLock, executeLedgers, convictionSettings);
    this.expect(
      executing.conviction === finalConviction && finalConviction >= threshold,
      `${step6}: conviction must reach ${finalConviction}, clearing the ${threshold} threshold`,
    );
    this.expect(executing.executed, `${step6}: crossing the threshold must self-execute the proposal`);
    proposal = await this.expectProposal(step6, proposalId, {
      conviction: finalConviction,
      lastUpdatedLedger: executingAt,
      executed: true,
    });
    const executions = this.harness.getConvictionExecutions();
    this.expect(
      executions.length === 1 &&
        executions[0].proposalId === BigInt(proposalId) &&
        executions[0].target === target &&
        executions[0].fnName === fnName &&
        executions[0].ledger === executingAt,
      `${step6}: the action must self-execute exactly once at ledger ${executingAt}, got ${this.describe(executions)}`,
    );

    // ── Step 7: the closed proposal rejects new locks and re-checkpoints. ───
    const step7 = "post-execution";
    let closedRejection: unknown;
    try {
      await client.stake(coSupporter.keypair, proposalId, coLock);
    } catch (e) {
      closedRejection = e;
    }
    this.expect(
      (closedRejection as { code?: number } | null)?.code === ConvictionVotingContractError.ProposalClosed,
      `${step7}: locking onto an executed proposal must be rejected with ProposalClosed, got ${String(closedRejection)}`,
    );
    const afterExecution = await client.checkpointConviction(locker.keypair, proposalId);
    this.expect(
      afterExecution.conviction === finalConviction && afterExecution.executed,
      `${step7}: checkpointing an executed proposal must be a no-op`,
    );
    this.expect(
      this.harness.getConvictionExecutions().length === 1,
      `${step7}: the action must never re-execute`,
    );
    // Withdrawing finalizes the lock — non-custodial, so no tokens return.
    await client.withdrawStake(locker.keypair);
    const remainingStakes = await this.harness.getConvictionStakes(proposalId);
    this.expect(
      remainingStakes.length === 1 && remainingStakes[0].staker === coSupporter.publicKey,
      `${step7}: withdrawing must remove only the locker's stake, got ${this.describe(remainingStakes)}`,
    );
    let doubleWithdrawRejection: unknown;
    try {
      await client.withdrawStake(locker.keypair);
    } catch (e) {
      doubleWithdrawRejection = e;
    }
    this.expect(
      (doubleWithdrawRejection as { code?: number } | null)?.code === ConvictionVotingContractError.StakeNotFound,
      `${step7}: a second withdrawal must be rejected with StakeNotFound, got ${String(doubleWithdrawRejection)}`,
    );

    return {
      success: true,
      convictionProposalId: proposalId,
      threshold,
      midConviction,
      expiryConviction,
      finalConviction,
      executions,
      ledgersElapsed: this.harness.clock.sequence - startLedger,
      errors: [],
    };
  }
}
