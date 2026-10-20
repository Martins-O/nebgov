import { ConvictionLockScenario, DeployedContracts, SimulationHarness } from "../src";
import { ConvictionVotingContractError } from "../src/mock/conviction-voting-executor";
import { buildTestSetup } from "./helpers";

describe("Conviction voting lock (mock runtime)", () => {
  let harness: SimulationHarness;
  let setup: ReturnType<typeof buildTestSetup>;
  let addresses: DeployedContracts;

  beforeAll(async () => {
    setup = buildTestSetup({ proposers: 1, voters: 5 });
    // One 1_000 lock reaches a steady-state conviction of 10_000 under the
    // default 9_000/10_000 decay/weight pair; seed the threshold between that
    // cap and the two-lock cap of 20_000, so only the second lock can execute.
    setup.config.conviction = { minThresholdConviction: 15_000n };
    harness = new SimulationHarness(setup.config);
    harness.registerActors(setup.actors);
    addresses = await harness.boot();
  });

  afterAll(async () => {
    await harness.teardown();
  });

  it("locks voting power, multiplies conviction to its cap, and self-executes once", async () => {
    const result = await harness.run(ConvictionLockScenario, {
      proposer: setup.actors.proposers[0],
      locker: setup.actors.voters[0],
      coSupporter: setup.actors.voters[1],
    });

    expect(result.errors).toEqual([]);
    expect(result.success).toBe(true);
    expect(result.convictionProposalId).toBe(1);
    expect(result.threshold).toBe(15_000n);

    // Partial accrual after 10 ledgers, the steady-state cap once the decay
    // window expires, and the exact crossing score after the second lock —
    // all pinned to the contract's integer accrual math.
    expect(result.midConviction).toBe(6_514n);
    expect(result.expiryConviction).toBe(10_000n);
    expect(result.finalConviction).toBe(16_514n);

    // The proposal's action ran exactly once, on the checkpoint that crossed.
    expect(result.executions).toHaveLength(1);
    expect(result.executions[0]).toMatchObject({
      proposalId: 1n,
      target: addresses.governor,
      fnName: "noop",
    });

    // The executed proposal is closed on-chain, and the lock was finalized.
    const proposal = await harness.convictionClient.getProposal(1);
    expect(proposal.executed).toBe(true);
    expect(proposal.conviction).toBe(result.finalConviction);
    expect(await harness.getConvictionStakes(1)).toEqual([
      { staker: setup.actors.voters[1].publicKey, proposalId: 1n, amount: 1_000n },
    ]);
    expect(harness.getConvictionExecutions()).toHaveLength(1);
  });

  it("prices the dynamic threshold above the minimum for non-zero requests", async () => {
    const minimum = await harness.convictionClient.getRequiredThreshold(0n);
    const small = await harness.convictionClient.getRequiredThreshold(100_000n);
    const large = await harness.convictionClient.getRequiredThreshold(999_999n);

    expect(minimum).toBe(15_000n);
    expect(small).toBeGreaterThan(minimum);
    expect(large).toBeGreaterThan(small);
  });

  it("refuses a lock larger than the staker's voting power", async () => {
    // The votes bound is checked before the proposal's open/closed state, so
    // this rejects even against the executed proposal #1.
    await expect(
      harness.convictionClient.stake(
        setup.actors.voters[2].keypair,
        1,
        1_000_001n, // voters start with 1_000_000 voting power
      ),
    ).rejects.toMatchObject({ code: ConvictionVotingContractError.InsufficientVotingPower });
  });
});
