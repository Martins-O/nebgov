import { DeployedContracts, OptimisticChallengeScenario, SimulationHarness } from "../src";
import { buildTestSetup, PLACEHOLDER_CALLDATA } from "./helpers";

describe("Optimistic challenge window (mock runtime)", () => {
  let harness: SimulationHarness;
  let setup: ReturnType<typeof buildTestSetup>;
  let addresses: DeployedContracts;

  beforeAll(async () => {
    setup = buildTestSetup({
      proposers: 1,
      voters: 5,
      settings: {
        optimisticChallengeWindowLedgers: 50,
        optimisticObjectionThresholdBps: 2500,
      },
    });
    harness = new SimulationHarness(setup.config);
    harness.registerActors(setup.actors);
    addresses = await harness.boot();
  });

  afterAll(async () => {
    await harness.teardown();
  });

  it("finalizes and executes an unchallenged proposal after the challenge window", async () => {
    const result = await harness.run(OptimisticChallengeScenario, {
      proposer: setup.actors.proposers[0],
      executor: setup.actors.voters[0],
      target: addresses.governor,
      fnName: "noop",
      calldata: PLACEHOLDER_CALLDATA,
    });

    expect(result.errors).toEqual([]);
    expect(result.success).toBe(true);
    expect(result.optimisticState).toBe("Executed");

    const proposal = await harness.optimisticGovernorClient.getProposal(Number(result.proposalId));
    expect(proposal.state).toBe("Executed");
    expect(proposal.challengeEndLedger).toBe(proposal.createdLedger + 50);
    expect(proposal.objectionVotes).toBe(0n);
  });

  it("keeps the proposal in ChallengeWindow and blocks execution before the window elapses", async () => {
    const client = harness.optimisticGovernorClient;
    const proposalId = await client.propose(
      setup.actors.proposers[0].keypair,
      addresses.governor,
      "noop",
      PLACEHOLDER_CALLDATA,
      "0".repeat(64),
    );

    const proposal = await client.getProposal(proposalId);
    expect(proposal.state).toBe("ChallengeWindow");
    expect(proposal.createdLedger).toBe(harness.clock.sequence);
    expect(proposal.challengeEndLedger).toBe(harness.clock.sequence + 50);

    await expect(
      client.finalize(setup.actors.voters[0].keypair, proposalId),
    ).rejects.toMatchObject({ code: 7 }); // ChallengeWindowNotElapsed
    await expect(
      client.execute(setup.actors.voters[0].keypair, proposalId),
    ).rejects.toMatchObject({ code: 12 }); // ProposalNotPassed
  });

  it("freezes a proposal as Objected once objections cross the threshold", async () => {
    const client = harness.optimisticGovernorClient;
    const proposalId = await client.propose(
      setup.actors.proposers[0].keypair,
      addresses.governor,
      "noop",
      PLACEHOLDER_CALLDATA,
      "0".repeat(64),
    );

    // Two of six 1_000_000-power voters object: one voter alone is
    // 1_000_000 / 6_000_000 ≈ 16.7%, under the 25% (2500 bps) threshold;
    // the second pushes the running total to ≈33%, freezing the proposal.
    await client.object(setup.actors.voters[0].keypair, proposalId);
    let proposal = await client.getProposal(proposalId);
    expect(proposal.state).toBe("ChallengeWindow");
    expect(proposal.objectionVotes).toBe(1_000_000n);

    await client.object(setup.actors.voters[1].keypair, proposalId);
    proposal = await client.getProposal(proposalId);
    expect(proposal.state).toBe("Objected");
    expect(proposal.objectionVotes).toBe(2_000_000n);

    // Even after the window would have elapsed, an Objected proposal can
    // never be finalized or executed.
    await harness.advanceLedgers(100);
    await expect(
      client.finalize(setup.actors.proposers[0].keypair, proposalId),
    ).rejects.toMatchObject({ code: 13 }); // ProposalAlreadyFinalized
    await expect(
      client.execute(setup.actors.proposers[0].keypair, proposalId),
    ).rejects.toMatchObject({ code: 12 }); // ProposalNotPassed

    // The proposer can still withdraw it.
    await client.cancel(setup.actors.proposers[0].keypair, proposalId);
    proposal = await client.getProposal(proposalId);
    expect(proposal.state).toBe("Cancelled");
  });
});
