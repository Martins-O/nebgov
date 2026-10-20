import { TreasuryErrorCode } from "@nebgov/sdk";
import { DeployedContracts, SimulationHarness, TreasuryStreamsScenario } from "../src";
import { buildTestSetup } from "./helpers";

describe("Treasury budget streams (mock runtime)", () => {
  let harness: SimulationHarness;
  let setup: ReturnType<typeof buildTestSetup>;
  let addresses: DeployedContracts;
  let streamId: bigint;
  let recipient: string;

  beforeAll(async () => {
    setup = buildTestSetup({ proposers: 1, voters: 5 });
    // The treasury contract authorises `create_stream`/`top_up_stream` from
    // `treasuryGovernor`; the harness defaults it to the governor contract
    // address, so point it at an actor we can sign with.
    setup.config.treasuryGovernor = setup.actors.proposers[0].publicKey;
    setup.config.treasuryBalance = 5_000_000n;
    harness = new SimulationHarness(setup.config);
    harness.registerActors(setup.actors);
    addresses = await harness.boot();
    recipient = setup.actors.voters[1].publicKey;
  });

  afterAll(async () => {
    await harness.teardown();
  });

  it("runs create → partial spend → top-up → final spend end to end", async () => {
    const result = await harness.run(TreasuryStreamsScenario, {
      governor: setup.actors.proposers[0],
      owner: setup.actors.voters[0],
      recipient: setup.actors.voters[1],
      token: addresses.votes,
    });

    expect(result.errors).toEqual([]);
    expect(result.success).toBe(true);
    streamId = result.streamId;
    expect(streamId).toBe(1n);

    // 1_000_000 created + 250_000 topped up, all of it withdrawn.
    expect(result.finalStream.totalAllocated).toBe(1_250_000n);
    expect(result.finalStream.totalSpent).toBe(1_250_000n);
    expect(result.finalStream.spendCount).toBe(2);
    expect(result.finalStream.isActive).toBe(false);
    expect(result.finalStream.isRevoked).toBe(false);
    expect(await harness.treasuryClient.getStreamRemaining(streamId)).toBe(0n);

    // The single token ledger moved with the withdrawals.
    expect(await harness.votesClient.getBaseVotes(recipient)).toBe(1_000_000n + 1_250_000n);
    expect(await harness.votesClient.getBaseVotes(addresses.treasury)).toBe(5_000_000n - 1_250_000n);

    const spends = await harness.treasuryClient.getStreamSpends(streamId);
    expect(spends.map((s) => [s.spendIndex, s.amount, s.memo])).toEqual([
      [0, 250_000n, "partial withdrawal"],
      [1, 1_000_000n, "final withdrawal"],
    ]);
  });

  it("refuses to create a stream from anyone but the treasury governor", async () => {
    await expect(
      harness.treasuryClient.createStream(setup.actors.voters[0].keypair, {
        name: "unauthorized",
        owner: setup.actors.voters[0].publicKey,
        token: addresses.votes,
        totalAllocated: 1_000n,
        startLedger: harness.clock.sequence,
        endLedger: harness.clock.sequence + 100,
        maxSingleSpend: 1_000n,
        cooldownLedgers: 10,
        proposalId: 0n,
      }),
    ).rejects.toMatchObject({ code: TreasuryErrorCode.TransactionFailed, message: expect.stringContaining("not authorized") });
  });

  it("refuses a withdrawal from a stream that is already drained", async () => {
    await expect(
      harness.treasuryClient.streamSpend(setup.actors.voters[0].keypair, streamId, recipient, 1n, "empty"),
    ).rejects.toMatchObject({ code: TreasuryErrorCode.StreamNotActive });

    const stream = await harness.treasuryClient.getStream(streamId);
    expect(stream.totalSpent).toBe(1_250_000n);
    expect(stream.spendCount).toBe(2);
  });
});
