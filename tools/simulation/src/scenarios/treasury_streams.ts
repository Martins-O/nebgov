import { BudgetStream, StreamBudgetReport, TreasuryBudgetSummary, TreasuryErrorCode } from "@nebgov/sdk";
import { Actor } from "../actors";
import { AssertionError } from "../assertions/errors";
import { SimulationHarness } from "../harness";
import { BaseScenario, SimulationResult } from "./base";

export interface TreasuryStreamsScenarioConfig {
  /** Signs the governance-gated calls (`create_stream`, `top_up_stream`); must be the harness's `treasuryGovernor`. */
  governor: Actor;
  /** Stream owner — the only signer accepted for `stream_spend`. */
  owner: Actor;
  /** Receives the withdrawn tokens. */
  recipient: Actor;
  /** SEP-41 token the stream is denominated in. */
  token: string;
  /** Budget allocated when the stream is created. Defaults to 1_000_000n. */
  totalAllocated?: bigint;
  /** First withdrawal, taken before the top-up. Defaults to a quarter of the created budget. */
  partialWithdrawal?: bigint;
  /** Budget governance adds after the partial withdrawal. Defaults to a quarter of the created budget. */
  topUpAmount?: bigint;
  /** Stream name (Soroban symbol charset). Defaults to `treasury_ops`. */
  name?: string;
  /** Ledger the stream opens on. Defaults to the current ledger. */
  startLedger?: number;
  /** Ledger the stream closes on. Defaults to `startLedger + 10_000`. */
  endLedger?: number;
  /** Largest amount a single withdrawal may move. Defaults to the topped-up budget. */
  maxSingleSpend?: bigint;
  /** Ledgers that must elapse between withdrawals. Defaults to 10. */
  cooldownLedgers?: number;
  /** Governance proposal that authorised the stream. Defaults to 0n. */
  proposalId?: bigint;
}

export interface TreasuryStreamsScenarioResult extends SimulationResult {
  /** Stream created by the scenario. */
  streamId: bigint;
  /** Stream as read back on-chain after the final withdrawal. */
  finalStream: BudgetStream;
}

/**
 * Drives one treasury budget stream end to end against the mock RPC and
 * asserts its state after every step: governance allocates the budget, the
 * owner withdraws part of it (the cooldown blocks a second withdrawal right
 * away), governance tops the stream up, and the owner drains what is left.
 * Token balances move with each withdrawal.
 */
export class TreasuryStreamsScenario extends BaseScenario {
  constructor(
    harness: SimulationHarness,
    private config: TreasuryStreamsScenarioConfig,
  ) {
    super(harness);
  }

  private expect(condition: boolean, message: string): void {
    if (!condition) throw new AssertionError(message);
  }

  /** Assert the recipient/treasury balances observed at the current ledger. */
  private async expectBalances(
    step: string,
    expected: { recipient: bigint; treasury: bigint },
  ): Promise<void> {
    const { votesClient, addresses } = this.harness;
    const [recipient, treasury] = await Promise.all([
      votesClient.getBaseVotes(this.config.recipient.publicKey),
      votesClient.getBaseVotes(addresses.treasury),
    ]);
    this.expect(
      recipient === expected.recipient && treasury === expected.treasury,
      `${step}: recipient/treasury balances must be ${expected.recipient}/${expected.treasury}, got ${recipient}/${treasury}`,
    );
  }

  /** Assert the treasury-wide budget summary at the current ledger. */
  private async expectSummary(
    step: string,
    expected: { totalStreams: number; activeStreams: number; allocated: bigint; spent: bigint },
  ): Promise<void> {
    const summary: TreasuryBudgetSummary = await this.harness.treasuryClient.getBudgetSummary();
    this.expect(
      summary.totalStreams === expected.totalStreams && summary.activeStreams === expected.activeStreams,
      `${step}: expected ${expected.totalStreams} stream(s) with ${expected.activeStreams} active, got ${summary.totalStreams}/${summary.activeStreams}`,
    );
    const forToken = (entries: Array<{ token: string; amount: bigint }>): bigint =>
      entries.find((entry) => entry.token === this.config.token)?.amount ?? -1n;
    const allocated = forToken(summary.totalAllocatedByToken);
    const spent = forToken(summary.totalSpentByToken);
    const remaining = forToken(summary.totalRemainingByToken);
    this.expect(
      allocated === expected.allocated && spent === expected.spent,
      `${step}: allocated/spent must be ${expected.allocated}/${expected.spent}, got ${allocated}/${spent}`,
    );
    this.expect(
      remaining === expected.allocated - expected.spent,
      `${step}: remaining must be ${expected.allocated - expected.spent}, got ${remaining}`,
    );
  }

  async run(): Promise<TreasuryStreamsScenarioResult> {
    const startLedger = this.harness.clock.sequence;
    const { treasuryClient, votesClient, addresses } = this.harness;
    const { governor, owner, recipient } = this.config;

    const allocated = this.config.totalAllocated ?? 1_000_000n;
    const partial = this.config.partialWithdrawal ?? allocated / 4n;
    const topUp = this.config.topUpAmount ?? allocated / 4n;
    const name = this.config.name ?? "treasury_ops";
    const proposalId = this.config.proposalId ?? 0n;
    const start = this.config.startLedger ?? startLedger;
    const end = this.config.endLedger ?? start + 10_000;
    const maxSingleSpend = this.config.maxSingleSpend ?? allocated + topUp;
    const cooldown = this.config.cooldownLedgers ?? 10;

    const recipientBefore = await votesClient.getBaseVotes(recipient.publicKey);
    const treasuryBefore = await votesClient.getBaseVotes(addresses.treasury);

    // ── Step 1: governance allocates the stream. ─────────────────────────────
    const created = await treasuryClient.createStream(governor.keypair, {
      name,
      owner: owner.publicKey,
      token: this.config.token,
      totalAllocated: allocated,
      startLedger: start,
      endLedger: end,
      maxSingleSpend,
      cooldownLedgers: cooldown,
      proposalId,
    });
    const streamId = created.streamId;
    const step1 = "stream creation";

    let stream = await treasuryClient.getStream(streamId);
    this.expect(stream.id === streamId, `${step1}: stream must be #${streamId}, got ${stream.id}`);
    this.expect(stream.name === name, `${step1}: stream must be named ${name}, got ${stream.name}`);
    this.expect(stream.owner === owner.publicKey, `${step1}: stream owner must be the configured owner`);
    this.expect(stream.token === this.config.token, `${step1}: stream token must be the configured token`);
    this.expect(
      stream.totalAllocated === allocated && stream.totalSpent === 0n,
      `${step1}: a new stream must hold ${allocated} with nothing spent, got ${stream.totalAllocated}/${stream.totalSpent}`,
    );
    this.expect(
      stream.startLedger === start && stream.endLedger === end,
      `${step1}: stream window must be [${start}, ${end}], got [${stream.startLedger}, ${stream.endLedger}]`,
    );
    this.expect(
      stream.isActive && !stream.isRevoked && stream.revokedAtLedger === null,
      `${step1}: a new stream must be active and unrevoked`,
    );
    this.expect(
      stream.maxSingleSpend === maxSingleSpend && stream.cooldownLedgers === cooldown,
      `${step1}: stream spend limit and cooldown must round-trip`,
    );
    this.expect(
      stream.lastSpendLedger === 0 && stream.spendCount === 0 && stream.createdByProposalId === proposalId,
      `${step1}: a new stream must have no spend history and record its authorising proposal`,
    );
    this.expect(
      (await treasuryClient.getStreamRemaining(streamId)) === allocated,
      `${step1}: a new stream must have its full allocation remaining`,
    );
    let report: StreamBudgetReport = await treasuryClient.getStreamReport(streamId);
    this.expect(
      report.totalAllocated === allocated && report.totalSpent === 0n && report.remaining === allocated,
      `${step1}: report must show an untouched budget of ${allocated}, got ${report.totalAllocated}/${report.totalSpent}/${report.remaining}`,
    );
    this.expect(
      report.utilizationBps === 0 && report.isActive && report.spendCount === 0 && report.avgSpend === 0n,
      `${step1}: report must show an active, unused stream`,
    );
    await this.expectSummary(step1, { totalStreams: 1, activeStreams: 1, allocated, spent: 0n });
    await this.expectBalances(step1, { recipient: recipientBefore, treasury: treasuryBefore });

    // ── Step 2: the owner withdraws part of the budget. ──────────────────────
    const step2 = "partial withdrawal";
    await treasuryClient.streamSpend(owner.keypair, streamId, recipient.publicKey, partial, step2);
    const firstSpendLedger = this.harness.clock.sequence;

    stream = await treasuryClient.getStream(streamId);
    this.expect(
      stream.totalSpent === partial && stream.totalAllocated === allocated,
      `${step2}: the withdrawal must spend exactly ${partial}, got ${stream.totalSpent}`,
    );
    this.expect(
      stream.spendCount === 1 && stream.lastSpendLedger === firstSpendLedger,
      `${step2}: the stream must record one spend at ledger ${firstSpendLedger}`,
    );
    this.expect(stream.isActive, `${step2}: a partly-spent stream must stay active`);
    this.expect(
      (await treasuryClient.getStreamRemaining(streamId)) === allocated - partial,
      `${step2}: the stream must have ${allocated - partial} left, got ${await treasuryClient.getStreamRemaining(streamId)}`,
    );
    const spends = await treasuryClient.getStreamSpends(streamId);
    this.expect(spends.length === 1, `${step2}: the stream must record exactly one spend, got ${spends.length}`);
    this.expect(
      spends[0].spendIndex === 0 &&
        spends[0].recipient === recipient.publicKey &&
        spends[0].amount === partial &&
        spends[0].memo === step2 &&
        spends[0].executedBy === owner.publicKey &&
        spends[0].executedAtLedger === firstSpendLedger,
      `${step2}: the recorded spend must match the withdrawal that produced it`,
    );
    report = await treasuryClient.getStreamReport(streamId);
    this.expect(
      report.totalSpent === partial && report.remaining === allocated - partial,
      `${step2}: report must show ${partial} spent and ${allocated - partial} left, got ${report.totalSpent}/${report.remaining}`,
    );
    this.expect(
      report.utilizationBps === Number((partial * 10_000n) / allocated),
      `${step2}: report utilization must reflect the withdrawn share`,
    );
    this.expect(
      report.isActive && report.spendCount === 1 && report.avgSpend === partial,
      `${step2}: report must show one active spend of ${partial}`,
    );
    await this.expectSummary(step2, { totalStreams: 1, activeStreams: 1, allocated, spent: partial });
    await this.expectBalances(step2, { recipient: recipientBefore + partial, treasury: treasuryBefore - partial });

    // ── Step 2b: the cooldown blocks an immediate second withdrawal. ─────────
    const step2b = "cooldown";
    let cooldownRejection: unknown;
    try {
      await treasuryClient.streamSpend(owner.keypair, streamId, recipient.publicKey, partial, "too soon");
    } catch (e) {
      cooldownRejection = e;
    }
    this.expect(
      cooldownRejection !== null &&
        (cooldownRejection as { code?: number }).code === TreasuryErrorCode.StreamCooldownNotElapsed,
      `${step2b}: a withdrawal inside the cooldown window must be rejected with StreamCooldownNotElapsed, got ${String(
        cooldownRejection && typeof cooldownRejection === "object" && "code" in cooldownRejection
          ? (cooldownRejection as { code: number }).code
          : cooldownRejection,
      )}`,
    );
    stream = await treasuryClient.getStream(streamId);
    this.expect(
      stream.totalSpent === partial && stream.spendCount === 1,
      `${step2b}: a rejected withdrawal must leave the stream untouched, got ${stream.totalSpent}/${stream.spendCount}`,
    );
    await this.expectBalances(step2b, { recipient: recipientBefore + partial, treasury: treasuryBefore - partial });

    // ── Step 3: governance tops the stream up. ───────────────────────────────
    await this.harness.advanceLedgers(cooldown + 1);
    const step3 = "top-up";
    await treasuryClient.topUpStream(governor.keypair, streamId, topUp);

    const toppedUp = allocated + topUp;
    stream = await treasuryClient.getStream(streamId);
    this.expect(
      stream.totalAllocated === toppedUp && stream.totalSpent === partial,
      `${step3}: the top-up must raise the allocation to ${toppedUp}, got ${stream.totalAllocated}`,
    );
    this.expect(
      stream.spendCount === 1 && stream.lastSpendLedger === firstSpendLedger,
      `${step3}: a top-up must not add a spend record`,
    );
    this.expect(stream.isActive, `${step3}: a topped-up stream must stay active`);
    this.expect(
      (await treasuryClient.getStreamRemaining(streamId)) === toppedUp - partial,
      `${step3}: the topped-up stream must have ${toppedUp - partial} left`,
    );
    report = await treasuryClient.getStreamReport(streamId);
    this.expect(
      report.totalAllocated === toppedUp && report.remaining === toppedUp - partial,
      `${step3}: report must show the topped-up budget, got ${report.totalAllocated}/${report.remaining}`,
    );
    this.expect(
      report.totalSpent === partial && report.spendCount === 1,
      `${step3}: report spend history must be unchanged, got ${report.totalSpent}/${report.spendCount}`,
    );
    this.expect(
      report.utilizationBps === Number((partial * 10_000n) / toppedUp),
      `${step3}: report utilization must be measured against the larger allocation`,
    );
    await this.expectSummary(step3, { totalStreams: 1, activeStreams: 1, allocated: toppedUp, spent: partial });
    await this.expectBalances(step3, { recipient: recipientBefore + partial, treasury: treasuryBefore - partial });

    // ── Step 4: the owner withdraws everything that is left. ─────────────────
    await this.harness.advanceLedgers(cooldown + 1);
    const step4 = "final withdrawal";
    const finalAmount = toppedUp - partial;
    await treasuryClient.streamSpend(owner.keypair, streamId, recipient.publicKey, finalAmount, step4);
    const finalSpendLedger = this.harness.clock.sequence;

    stream = await treasuryClient.getStream(streamId);
    this.expect(
      stream.totalSpent === toppedUp && stream.totalSpent === stream.totalAllocated,
      `${step4}: the withdrawal must drain the stream, got ${stream.totalSpent}/${stream.totalAllocated}`,
    );
    this.expect(
      stream.spendCount === 2 && stream.lastSpendLedger === finalSpendLedger,
      `${step4}: the stream must record the second spend at ledger ${finalSpendLedger}`,
    );
    this.expect(!stream.isActive && !stream.isRevoked, `${step4}: a drained stream must be inactive but not revoked`);
    this.expect(
      (await treasuryClient.getStreamRemaining(streamId)) === 0n,
      `${step4}: a drained stream must have nothing remaining`,
    );
    const finalSpends = await treasuryClient.getStreamSpends(streamId);
    this.expect(finalSpends.length === 2, `${step4}: the stream must record two spends, got ${finalSpends.length}`);
    this.expect(
      finalSpends[1].spendIndex === 1 &&
        finalSpends[1].recipient === recipient.publicKey &&
        finalSpends[1].amount === finalAmount &&
        finalSpends[1].memo === step4 &&
        finalSpends[1].executedBy === owner.publicKey,
      `${step4}: the second recorded spend must match the final withdrawal`,
    );
    report = await treasuryClient.getStreamReport(streamId);
    this.expect(
      report.remaining === 0n && report.utilizationBps === 10_000,
      `${step4}: report must show a fully used budget, got ${report.remaining} left at ${report.utilizationBps} bps`,
    );
    this.expect(!report.isActive && report.spendCount === 2, `${step4}: report must show the stream as spent out`);
    this.expect(report.avgSpend === toppedUp / 2n, `${step4}: report must average both withdrawals`);
    await this.expectSummary(step4, {
      totalStreams: 1,
      activeStreams: 0,
      allocated: toppedUp,
      spent: toppedUp,
    });
    await this.expectBalances(step4, { recipient: recipientBefore + toppedUp, treasury: treasuryBefore - toppedUp });

    return {
      success: true,
      streamId,
      finalStream: stream,
      ledgersElapsed: this.harness.clock.sequence - startLedger,
      errors: [],
    };
  }
}
