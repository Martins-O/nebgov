import { VoteSupport } from "@nebgov/sdk";
import {
  assertTokenBalance,
  DeployedContracts,
  ProposalBondsLifecycleScenario,
  ProposalBondsLifecycleScenarioResult,
  SimulationHarness,
} from "../src";
import { buildTestSetup, PLACEHOLDER_CALLDATA } from "./helpers";

/**
 * Proposal-bonds flow end to end: bond posting, refund on a successful
 * proposal, and slashing on a governance-triggered cancel. The scenario
 * asserts bond + token state at every step; these tests assert the terminal
 * outcome and the money movements.
 */
describe("Proposal bonds lifecycle (mock runtime)", () => {
  const BOND_AMOUNT = 5_000n;
  const REFUND_GRACE_LEDGERS = 50;

  let harness: SimulationHarness;
  let addresses: DeployedContracts;
  let setup: ReturnType<typeof buildTestSetup>;

  beforeAll(async () => {
    setup = buildTestSetup({
      proposers: 1,
      voters: 5,
      hasGuardian: true,
      settings: {
        proposalBondAmount: BOND_AMOUNT,
        proposalRefundGraceLedgers: REFUND_GRACE_LEDGERS,
        proposalMaxLockLedgers: 1_000_000,
        // Keep the timelock delay short enough that a proposal can execute
        // while still inside the (deliberately small) refund grace window.
        timelockDelay: 10n,
      },
    });
    harness = new SimulationHarness(setup.config);
    harness.registerActors(setup.actors);
    addresses = await harness.boot();
  });

  afterAll(async () => {
    await harness.teardown();
  });

  const scenarioConfig = () => ({
    proposer: setup.actors.proposers[0],
    guardian: setup.actors.guardian!,
    description: "Bonded upgrade proposal",
    targets: [addresses.governor],
    fnNames: ["noop"],
    calldatas: [PLACEHOLDER_CALLDATA],
    voters: [
      { actor: setup.actors.voters[0], support: VoteSupport.For },
      { actor: setup.actors.voters[1], support: VoteSupport.For },
      { actor: setup.actors.voters[2], support: VoteSupport.For },
    ],
  });

  it("refunds a bond after a successful proposal and slashes one on a governance cancel", async () => {
    // The scenario drives both flows on the one harness instance; the
    // proposer needs enough balance for two bonds.
    const before = await harness.votesClient.getBaseVotes(setup.actors.proposers[0].publicKey);

    const result: ProposalBondsLifecycleScenarioResult = await harness.run(
      ProposalBondsLifecycleScenario,
      scenarioConfig(),
    );

    expect(result.success).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.refundedBondState).toBe("Refunded");
    expect(result.slashedBondState).toBe("Slashed");
    expect(result.descriptionHash).toHaveLength(64);
    expect(result.slashDescriptionHash).not.toBe(result.descriptionHash);

    // Flow 1: the successful proposal executed and its bond was returned.
    expect(result.finalState).toBe("Executed");

    // Flow 2: the slash proposal executed and its bond went to the recipient
    // (the guardian) rather than back to the proposer.
    await assertTokenBalance(
      harness.votesClient,
      setup.actors.guardian!.publicKey,
      1_000_000n + BOND_AMOUNT,
    );

    // The registry holds no residual funds.
    await assertTokenBalance(harness.votesClient, addresses.proposalBonds, 0n);

    // Bonds are terminal: the refunded and slashed bonds stay put.
    const refunded = await harness.proposalBondsClient.getBond(result.descriptionHash);
    expect(refunded?.state).toBe("Refunded");
    expect(refunded?.proposer).toBe(setup.actors.proposers[0].publicKey);
    expect(refunded?.amount).toBe(BOND_AMOUNT);

    const slashed = await harness.proposalBondsClient.getBond(result.slashDescriptionHash);
    expect(slashed?.state).toBe("Slashed");
    expect(slashed?.proposer).toBe(setup.actors.proposers[0].publicKey);
  });

  it("exposes the registry settings the harness booted with", async () => {
    const settings = await harness.proposalBondsClient.getSettings();
    expect(settings.bondAmount).toBe(BOND_AMOUNT);
    expect(settings.governor).toBe(addresses.governor);
    expect(settings.refundGraceLedgers).toBe(REFUND_GRACE_LEDGERS);
    expect(settings.bondToken).toBe(addresses.votes);
  });
});
