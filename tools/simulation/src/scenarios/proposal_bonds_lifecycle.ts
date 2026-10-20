import { BondState, ProposalState } from "@nebgov/sdk";
import { Actor } from "../actors";
import { AssertionError } from "../assertions/errors";
import { SimulationHarness } from "../harness";
import { BaseScenario, ProposalScenarioConfig, SimulationResult } from "./base";

/** `contracts/proposal-bonds` error codes the scenario asserts against. */
const BondError = {
  BondAlreadyLocked: 3,
  BondNotLocked: 5,
  ProposalNotTerminal: 7,
  RefundGraceNotElapsed: 8,
} as const;

export interface ProposalBondsLifecycleScenarioConfig extends ProposalScenarioConfig {
  /** Guardian that veto-cancels the bond's correlated proposal. */
  guardian: Actor;
  /** Recipient of the slashed bond. Defaults to `guardian`. */
  slashRecipient?: Actor;
  /**
   * Overrides for the second, follow-up "slash" proposal. It shares the
   * second bond's description hash (bonds and proposals correlate by hash)
   * but submits the bond-slashing targets/calldata.
   */
  slashProposal?: Partial<
    Pick<ProposalScenarioConfig, "description" | "targets" | "fnNames" | "calldatas" | "voters">
  >;
}

export interface ProposalBondsLifecycleScenarioResult extends SimulationResult {
  /** Description hash of the flow-1 (refunded) proposal/bond pair. */
  descriptionHash: string;
  /** Ledger the flow-1 bond was locked at. */
  bondedLockedLedger: number;
  /** Id of the proposal the flow-1 bond is posted alongside. */
  bondedProposalId: bigint;
  /** Description hash of the flow-2 (slashed) proposal/bond pair. */
  slashDescriptionHash: string;
  /** Id of the follow-up governance proposal that slashes the flow-2 bond. */
  slashProposalId: bigint;
  /** Bond lifecycle state after the refund flow (`Refunded`). */
  refundedBondState: BondState;
  /** Bond lifecycle state after the slash flow (`Slashed`). */
  slashedBondState: BondState;
}

/**
 * Drives the proposal-bonds flow end to end against the mock RPC, asserting
 * bond state after every step. Two independent bonds are posted alongside a
 * pair of proposal lifecycles:
 *
 *   1. Bond posting + refund on success: a proposal is bonded, voted
 *      through, queued, and executed; once the post-terminal refund grace
 *      window elapses the bond is refunded to the proposer.
 *   2. Bond posting + slashing on a governance-triggered cancel: a second
 *      proposal is bonded, becomes Active, and is veto-cancelled by the
 *      guardian (a governance-triggered cancellation). The community then
 *      executes a follow-up proposal (sharing the bond's description hash)
 *      that slashes the bond to a recipient.
 *
 * The harness must seed `settings.proposalBondAmount` (with the proposer
 * holding enough balance) and a `proposalRefundGraceLedgers` window short
 * enough to reach within the scenario.
 */
export class ProposalBondsLifecycleScenario extends BaseScenario {
  constructor(
    harness: SimulationHarness,
    private config: ProposalBondsLifecycleScenarioConfig,
  ) {
    super(harness);
  }

  private expect(condition: boolean, message: string): void {
    if (!condition) throw new AssertionError(message);
  }

  /** Assert a bond's proposer / amount / locked ledger / state at the current ledger. */
  private async expectBond(
    step: string,
    descriptionHash: string,
    expected: { proposer: string; amount: bigint; lockedLedger: number; state: BondState },
  ): Promise<void> {
    const bond = await this.harness.proposalBondsClient.getBond(descriptionHash);
    if (!bond) throw new AssertionError(`${step}: expected a bond for ${descriptionHash}, got none`);
    this.expect(
      bond.proposer === expected.proposer,
      `${step}: bond proposer must be ${expected.proposer}, got ${bond.proposer}`,
    );
    this.expect(
      bond.amount === expected.amount,
      `${step}: bond amount must be ${expected.amount}, got ${bond.amount}`,
    );
    this.expect(
      bond.lockedLedger === expected.lockedLedger,
      `${step}: bond must be locked at ledger ${expected.lockedLedger}, got ${bond.lockedLedger}`,
    );
    this.expect(
      bond.state === expected.state,
      `${step}: bond state must be ${expected.state}, got ${bond.state}`,
    );
  }

  /** Capture the code of an SDK error thrown by `run`, or `undefined` if none is thrown. */
  private async expectRejection(
    step: string,
    expectedCode: number,
    run: () => Promise<unknown>,
  ): Promise<void> {
    let rejection: { code?: number } | undefined;
    try {
      await run();
    } catch (e) {
      rejection = e as { code?: number };
    }
    this.expect(
      rejection?.code === expectedCode,
      `${step}: expected rejection with contract error #${expectedCode}, got ${String(rejection)}`,
    );
  }

  private async expectState(step: string, proposalId: bigint, expected: ProposalState): Promise<void> {
    const actual = await this.harness.governorClient.getProposalState(proposalId);
    this.expect(actual === expected, `${step}: expected proposal state ${expected}, got ${actual}`);
  }

  /** Take a proposal from Succeeded through queue + timelock delay to Executed. */
  private async queueAndExecute(proposer: Actor, proposalId: bigint): Promise<void> {
    await this.harness.governorClient.queue(proposer.keypair, proposalId);
    const delaySeconds = await this.harness.timelockClient.minDelay();
    await this.harness.advanceLedgers(this.harness.clock.secondsToLedgers(Number(delaySeconds)) + 1);
    await this.harness.governorClient.execute(proposer.keypair, proposalId);
  }

  async run(): Promise<ProposalBondsLifecycleScenarioResult> {
    const startLedger = this.harness.clock.sequence;
    const { governorClient, proposalBondsClient, votesClient, addresses } = this.harness;
    const { proposer, guardian } = this.config;
    const descriptionHash = (this.config.descriptionHash ?? "0".repeat(64)).toLowerCase();
    const settings = await proposalBondsClient.getSettings();
    this.expect(
      settings.governor === addresses.governor,
      `the bonds registry must be attached to the governor, got ${settings.governor}`,
    );
    this.expect(settings.bondAmount > 0n, `bond amount must be positive, got ${settings.bondAmount}`);

    // ═══ Flow 1: bond posting + refund on a successful proposal ═══════════

    // ── Step 1: no bond exists before any posting. ─────────────────────────
    const step1 = "pre-lock";
    this.expect(
      (await proposalBondsClient.getBond(descriptionHash)) === null,
      `${step1}: no bond must exist for an unused description hash`,
    );

    // ── Step 2: the proposer posts the bond, moving tokens to the registry. ─
    const step2 = "bond posting";
    const proposerBalanceBefore = await votesClient.getBaseVotes(proposer.publicKey);
    const lockedAt = this.harness.clock.sequence;
    await proposalBondsClient.lockBond(proposer.keypair, descriptionHash);
    await this.expectBond(step2, descriptionHash, {
      proposer: proposer.publicKey,
      amount: settings.bondAmount,
      lockedLedger: lockedAt,
      state: "Locked",
    });
    this.expect(
      (await votesClient.getBaseVotes(proposer.publicKey)) === proposerBalanceBefore - settings.bondAmount,
      `${step2}: locking must debit ${settings.bondAmount} from the proposer`,
    );
    this.expect(
      (await votesClient.getBaseVotes(addresses.proposalBonds)) === settings.bondAmount,
      `${step2}: the registry must hold the locked bond`,
    );
    await this.expectRejection(step2, BondError.BondAlreadyLocked, () =>
      proposalBondsClient.lockBond(proposer.keypair, descriptionHash),
    );

    // ── Step 3: the correlated proposal is submitted and voted through. ────
    const step3 = "proposal & vote";
    const bondedProposalId = await governorClient.propose(
      proposer.keypair,
      this.config.description,
      descriptionHash,
      "ipfs://simulation",
      this.config.targets,
      this.config.fnNames,
      this.config.calldatas,
    );
    const bondedSettings = await governorClient.getSettings();
    await this.harness.advanceLedgers(bondedSettings.votingDelay + 1);
    for (const { actor, support } of this.config.voters) {
      await actor.vote(governorClient, bondedProposalId, support);
    }
    await this.harness.advanceLedgers(bondedSettings.votingPeriod + 1);
    const bondedProposal = await governorClient.getProposal(bondedProposalId);
    await this.expectState(step3, bondedProposalId, ProposalState.Succeeded);
    // Still Locked while the proposal is live — no slashing or refunding yet.
    await this.expectBond(step3, descriptionHash, {
      proposer: proposer.publicKey,
      amount: settings.bondAmount,
      lockedLedger: lockedAt,
      state: "Locked",
    });

    // ── Step 4: terminal proposal still blocks refund until grace elapses. ──
    const step4 = "refund gate";
    // A Succeeded proposal is not yet terminal, so a refund is refused.
    await this.expectRejection(step4, BondError.ProposalNotTerminal, () =>
      proposalBondsClient.refundBond(proposer.keypair, descriptionHash, bondedProposalId),
    );
    // Once executed, the proposal is terminal but the post-terminal grace
    // window (a fixed period after `end_ledger`) still blocks the refund.
    await this.queueAndExecute(proposer, bondedProposalId);
    await this.expectState(step4, bondedProposalId, ProposalState.Executed);
    const refundEligibleLedger = bondedProposal.endLedger + settings.refundGraceLedgers;
    this.expect(
      this.harness.clock.sequence < refundEligibleLedger,
      `${step4}: the scenario must still be inside the refund grace window to test the gate`,
    );
    await this.expectRejection(step4, BondError.RefundGraceNotElapsed, () =>
      proposalBondsClient.refundBond(proposer.keypair, descriptionHash, bondedProposalId),
    );

    // ── Step 5: refund the bond once the grace window elapses. ─────────────
    const step5 = "refund";
    await this.harness.advanceLedgers(refundEligibleLedger - this.harness.clock.sequence);
    const proposerBalanceBeforeRefund = await votesClient.getBaseVotes(proposer.publicKey);
    await proposalBondsClient.refundBond(guardian.keypair, descriptionHash, bondedProposalId);
    await this.expectBond(step5, descriptionHash, {
      proposer: proposer.publicKey,
      amount: settings.bondAmount,
      lockedLedger: lockedAt,
      state: "Refunded",
    });
    this.expect(
      (await votesClient.getBaseVotes(proposer.publicKey)) === proposerBalanceBeforeRefund + settings.bondAmount,
      `${step5}: refund must credit ${settings.bondAmount} back to the proposer`,
    );
    this.expect(
      (await votesClient.getBaseVotes(addresses.proposalBonds)) === 0n,
      `${step5}: the registry must hold no funds after refund`,
    );
    await this.expectRejection(step5, BondError.BondNotLocked, () =>
      proposalBondsClient.refundBond(guardian.keypair, descriptionHash, bondedProposalId),
    );

    // ═══ Flow 2: bond posting + slashing on a governance-triggered cancel ══

    const slashDescriptionHash = rollingDescriptionHash(descriptionHash);
    const slashRecipient = (this.config.slashRecipient ?? guardian).publicKey;
    const slashCalldata = proposalBondsClient.encodeSlashCalldata(
      addresses.governor,
      slashDescriptionHash,
      slashRecipient,
    );
    const slashOverrides = this.config.slashProposal ?? {};
    const slashVoters = slashOverrides.voters ?? this.config.voters;

    // ── Step 6: a fresh bond is posted under a new description hash. ───────
    const step6 = "slash-bond posting";
    const slashLockedAt = this.harness.clock.sequence;
    const slashBalanceBefore = await votesClient.getBaseVotes(proposer.publicKey);
    await proposalBondsClient.lockBond(proposer.keypair, slashDescriptionHash);
    await this.expectBond(step6, slashDescriptionHash, {
      proposer: proposer.publicKey,
      amount: settings.bondAmount,
      lockedLedger: slashLockedAt,
      state: "Locked",
    });
    this.expect(
      (await votesClient.getBaseVotes(proposer.publicKey)) === slashBalanceBefore - settings.bondAmount,
      `${step6}: the second lock must debit ${settings.bondAmount} from the proposer`,
    );
    this.expect(
      (await proposalBondsClient.getBond(descriptionHash))?.state === "Refunded",
      `${step6}: the first bond must remain Refunded`,
    );

    // ── Step 7: the correlated proposal is submitted and veto-cancelled. ───
    const step7 = "proposal cancel";
    const cancelProposalId = await governorClient.propose(
      proposer.keypair,
      "Slash-target proposal",
      slashDescriptionHash,
      "ipfs://simulation",
      slashOverrides.targets ?? this.config.targets,
      slashOverrides.fnNames ?? this.config.fnNames,
      slashOverrides.calldatas ?? this.config.calldatas,
    );
    const cancelSettings = await governorClient.getSettings();
    await this.harness.advanceLedgers(cancelSettings.votingDelay + 1);
    // Guardian vetoes while the proposal is Active — no community vote needed.
    await this.harness.cancelProposalViaGuardian(guardian.keypair, cancelProposalId);
    await this.expectState(step7, cancelProposalId, ProposalState.Cancelled);
    // The bond outlives the cancelled proposal's lifecycle, still Locked.
    await this.expectBond(step7, slashDescriptionHash, {
      proposer: proposer.publicKey,
      amount: settings.bondAmount,
      lockedLedger: slashLockedAt,
      state: "Locked",
    });

    // ── Step 8: a follow-up proposal executes and slashes the bond. ────────
    const step8 = "governance slash";
    // Clear the proposer cooldown between the correlated proposal and the
    // slash proposal (both come from the same proposer).
    await this.harness.advanceLedgers((cancelSettings.proposalCooldown ?? 100) + 1);
    const slashProposalId = await governorClient.propose(
      proposer.keypair,
      slashOverrides.description ?? "Slash malicious proposal bond",
      slashDescriptionHash,
      "ipfs://simulation",
      [addresses.proposalBonds],
      ["slash"],
      [slashCalldata],
    );
    const slashSettings = await governorClient.getSettings();
    await this.harness.advanceLedgers(slashSettings.votingDelay + 1);
    for (const { actor, support } of slashVoters) {
      await actor.vote(governorClient, slashProposalId, support);
    }
    await this.harness.advanceLedgers(slashSettings.votingPeriod + 1);

    const recipientBalanceBefore = await votesClient.getBaseVotes(slashRecipient);
    await this.queueAndExecute(proposer, slashProposalId);
    await this.expectState(step8, slashProposalId, ProposalState.Executed);
    await this.expectBond(step8, slashDescriptionHash, {
      proposer: proposer.publicKey,
      amount: settings.bondAmount,
      lockedLedger: slashLockedAt,
      state: "Slashed",
    });
    this.expect(
      (await votesClient.getBaseVotes(slashRecipient)) === recipientBalanceBefore + settings.bondAmount,
      `${step8}: slashing must credit ${settings.bondAmount} to the recipient`,
    );
    this.expect(
      (await votesClient.getBaseVotes(addresses.proposalBonds)) === 0n,
      `${step8}: the registry must hold no funds after slashing`,
    );

    return {
      success: true,
      proposalId: slashProposalId,
      finalState: ProposalState.Executed,
      descriptionHash,
      bondedLockedLedger: lockedAt,
      bondedProposalId,
      slashDescriptionHash,
      slashProposalId,
      refundedBondState: "Refunded",
      slashedBondState: "Slashed",
      ledgersElapsed: this.harness.clock.sequence - startLedger,
      errors: [],
    };
  }
}

/** Derive a distinct, deterministic 32-byte hex hash from an existing one. */
function rollingDescriptionHash(hex: string): string {
  const bytes = Buffer.from(hex, "hex");
  bytes[0] = (bytes[0] + 1) & 0xff;
  return bytes.toString("hex");
}
