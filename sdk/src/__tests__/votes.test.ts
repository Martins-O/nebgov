// Define mocks with 'mock' prefix and use 'var' for hoisting support
var mockScValToNative = jest.fn();
var mockNativeToScVal = jest.fn();
var mockSimulate = jest.fn();
var mockGetAccount = jest.fn();
var mockPrepareTransaction = jest.fn();
var mockSendTransaction = jest.fn();
var mockIsSimulationError = jest.fn();
var mockGetLatestLedger = jest.fn();
var mockGetEvents = jest.fn();
var mockContractCall = jest.fn().mockReturnValue({});

import { VotesClient } from "../votes";
import { VotesError, VotesErrorCode } from "../errors";

jest.mock("@stellar/stellar-sdk", () => {
  const actual = jest.requireActual("@stellar/stellar-sdk");
  return {
    ...actual,
    scValToNative: mockScValToNative,
    nativeToScVal: mockNativeToScVal,
    SorobanRpc: {
      ...actual.SorobanRpc,
      Server: jest.fn().mockImplementation(() => ({
        simulateTransaction: mockSimulate,
        getAccount: mockGetAccount,
        prepareTransaction: mockPrepareTransaction,
        sendTransaction: mockSendTransaction,
        getLatestLedger: mockGetLatestLedger,
        getEvents: mockGetEvents,
      })),
      Api: {
        isSimulationError: mockIsSimulationError,
      },
    },
    Contract: jest.fn().mockImplementation((addr) => ({
      call: mockContractCall,
      address: () => addr,
      contractId: () => addr,
    })),
    TransactionBuilder: jest.fn().mockImplementation(() => ({
      addOperation: jest.fn().mockReturnThis(),
      setTimeout: jest.fn().mockReturnThis(),
      build: jest.fn().mockReturnValue({}),
    })),
  };
});

import { xdr, Account, Keypair } from "@stellar/stellar-sdk";

describe("VotesClient", () => {
  let client: VotesClient;
  const validGAddr = "GBFUUXATVOGXGD4KS3I423QFZSPE4ZFOQ3TCJVWFUYSIPULXIRVRE2DT";
  const validCAddr = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
  const mockKeypair = Keypair.random();

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAccount.mockResolvedValue(new Account(validGAddr, "1"));
    mockIsSimulationError.mockReturnValue(false);
    mockNativeToScVal.mockReturnValue({} as xdr.ScVal);
    mockGetLatestLedger.mockResolvedValue({ sequence: 100000 });
    mockGetEvents.mockResolvedValue({ events: [] });

    client = new VotesClient({
      governorAddress: validCAddr,
      timelockAddress: validCAddr,
      votesAddress: validCAddr,
      network: "testnet",
    });
  });

  describe("delegate()", () => {
    const delegateeAddr = "GBTESTDELEGATEEADDRESSEXAMPLEFORUNITTESTSTESTING";

    beforeEach(() => {
      const mockTx = { sign: jest.fn() };
      mockPrepareTransaction.mockResolvedValue(mockTx);
      mockSendTransaction.mockResolvedValue({
        status: "PENDING",
        hash: "delegate123",
      });
    });

    it("successfully delegates voting power", async () => {
      await client.delegate(mockKeypair, delegateeAddr);

      expect(mockSendTransaction).toHaveBeenCalled();
      expect(mockPrepareTransaction).toHaveBeenCalled();
    });

    it("successfully self-delegates", async () => {
      await client.delegate(mockKeypair, mockKeypair.publicKey());

      expect(mockSendTransaction).toHaveBeenCalled();
    });

    it("throws VotesError when transaction fails", async () => {
      mockSendTransaction.mockResolvedValue({
        status: "ERROR",
        error: "Invalid delegatee",
      });

      await expect(client.delegate(mockKeypair, delegateeAddr)).rejects.toThrow(
        VotesError
      );

      try {
        await client.delegate(mockKeypair, delegateeAddr);
      } catch (e) {
        expect(e).toBeInstanceOf(VotesError);
        expect((e as VotesError).code).toBe(VotesErrorCode.TransactionFailed);
      }
    });

    it("calls contract with correct parameters", async () => {
      await client.delegate(mockKeypair, delegateeAddr);

      expect(mockNativeToScVal).toHaveBeenCalledWith(mockKeypair.publicKey(), { type: "address" });
      expect(mockNativeToScVal).toHaveBeenCalledWith(delegateeAddr, { type: "address" });
    });
  });

  describe("setTimeWeightScale()", () => {
    it("rejects zero before submitting a transaction", async () => {
      await expect(
        client.setTimeWeightScale(mockKeypair, 0),
      ).rejects.toMatchObject({
        code: VotesErrorCode.InvalidTimeWeightScale,
      });
      expect(mockGetAccount).not.toHaveBeenCalled();
      expect(mockSendTransaction).not.toHaveBeenCalled();
    });
  });

  describe("checkpoint retention and pruning", () => {
    beforeEach(() => {
      const mockTx = { sign: jest.fn() };
      mockPrepareTransaction.mockResolvedValue(mockTx);
      mockSendTransaction.mockResolvedValue({
        status: "PENDING",
        hash: "checkpointAdmin123",
      });
    });

    it("gets the checkpoint retention period", async () => {
      mockSimulate.mockResolvedValue({ result: { retval: {} } });
      mockScValToNative.mockReturnValue(50000);

      await expect(client.getCheckpointRetentionPeriod()).resolves.toBe(50000);
      expect(mockContractCall).toHaveBeenCalledWith(
        "checkpoint_retention_period",
      );
    });

    it("throws when getting the retention period fails", async () => {
      mockIsSimulationError.mockReturnValue(true);
      mockSimulate.mockResolvedValue({ error: "not found" });

      await expect(client.getCheckpointRetentionPeriod()).rejects.toMatchObject({
        code: VotesErrorCode.SimulationFailed,
      });
    });

    it("sets the checkpoint retention period", async () => {
      await client.setCheckpointRetentionPeriod(mockKeypair, 50000);

      expect(mockNativeToScVal).toHaveBeenCalledWith(50000, { type: "u32" });
      expect(mockContractCall).toHaveBeenCalledWith(
        "set_checkpoint_retention_period",
        {},
      );
      expect(mockPrepareTransaction).toHaveBeenCalled();
      expect(mockSendTransaction).toHaveBeenCalled();
    });

    it("throws when setting the retention period fails", async () => {
      mockSendTransaction.mockResolvedValue({
        status: "ERROR",
        error: "unauthorized",
      });

      await expect(
        client.setCheckpointRetentionPeriod(mockKeypair, 50000),
      ).rejects.toThrow(VotesError);
    });

    it("prunes checkpoints without a minimum active proposal ledger", async () => {
      await client.pruneCheckpoints(mockKeypair);

      expect(mockContractCall).toHaveBeenCalledWith(
        "prune_checkpoints",
        xdr.ScVal.scvVoid(),
      );
      expect(mockPrepareTransaction).toHaveBeenCalled();
      expect(mockSendTransaction).toHaveBeenCalled();
    });

    it("prunes checkpoints while retaining the specified ledger", async () => {
      await client.pruneCheckpoints(mockKeypair, 1200);

      expect(mockNativeToScVal).toHaveBeenCalledWith(1200, { type: "u32" });
      expect(mockContractCall).toHaveBeenCalledWith("prune_checkpoints", {});
    });

    it("throws when pruning fails", async () => {
      mockSendTransaction.mockResolvedValue({
        status: "ERROR",
        error: "unauthorized",
      });

      await expect(client.pruneCheckpoints(mockKeypair)).rejects.toThrow(
        VotesError,
      );
    });
  });

  describe("transferAndDelegate()", () => {
    const toAddr = "GBTESTRECIPIENTADDRESSEXAMPLEFORUNITTESTSTESTING";
    const delegateeAddr = "GBTESTDELEGATEEADDRESSEXAMPLEFORUNITTESTSTESTING";
    const amount = 250n;

    beforeEach(() => {
      const mockTx = { sign: jest.fn() };
      mockPrepareTransaction.mockResolvedValue(mockTx);
      mockSendTransaction.mockResolvedValue({
        status: "PENDING",
        hash: "transferAndDelegate123",
      });
    });

    it("submits atomic transfer+delegate transaction", async () => {
      await client.transferAndDelegate(mockKeypair, toAddr, amount, delegateeAddr);

      expect(mockPrepareTransaction).toHaveBeenCalled();
      expect(mockSendTransaction).toHaveBeenCalled();
      expect(mockNativeToScVal).toHaveBeenCalledWith(mockKeypair.publicKey(), {
        type: "address",
      });
      expect(mockNativeToScVal).toHaveBeenCalledWith(toAddr, {
        type: "address",
      });
      expect(mockNativeToScVal).toHaveBeenCalledWith(amount, { type: "i128" });
      expect(mockNativeToScVal).toHaveBeenCalledWith(delegateeAddr, {
        type: "address",
      });
    });

    it("throws VotesError on failed submission", async () => {
      mockSendTransaction.mockResolvedValue({
        status: "ERROR",
        error: "insufficient balance",
      });

      await expect(
        client.transferAndDelegate(mockKeypair, toAddr, amount, delegateeAddr),
      ).rejects.toThrow(VotesError);
    });
  });

  describe("getVotes()", () => {
    const accountAddr = "GBTESTACCOUNTADDRESSEXAMPLEFORUNITTESTSTESTING";

    it("returns current voting power", async () => {
      const scv = {} as xdr.ScVal;
      mockSimulate.mockResolvedValue({
        result: { retval: scv },
      });
      mockScValToNative.mockReturnValue(1000);

      const votes = await client.getVotes(accountAddr);

      expect(votes).toBe(1000n);
    });

    it("returns 0n when account has no voting power", async () => {
      const scv = {} as xdr.ScVal;
      mockSimulate.mockResolvedValue({
        result: { retval: scv },
      });
      mockScValToNative.mockReturnValue(0);

      const votes = await client.getVotes(accountAddr);

      expect(votes).toBe(0n);
    });

    it("returns 0n when simulation fails", async () => {
      mockIsSimulationError.mockReturnValue(true);
      mockSimulate.mockResolvedValue({
        error: "Account not found",
      });

      const votes = await client.getVotes(accountAddr);

      expect(votes).toBe(0n);
    });

    it("returns 0n when no return value", async () => {
      mockSimulate.mockResolvedValue({
        result: {},
      });

      const votes = await client.getVotes(accountAddr);

      expect(votes).toBe(0n);
    });

    it("handles large voting power values", async () => {
      const scv = {} as xdr.ScVal;
      const largeValue = 999999999999n;
      mockSimulate.mockResolvedValue({
        result: { retval: scv },
      });
      mockScValToNative.mockReturnValue(largeValue);

      const votes = await client.getVotes(accountAddr);

      expect(votes).toBe(largeValue);
    });
  });

  describe("getPastVotes()", () => {
    const accountAddr = "GBTESTACCOUNTADDRESSEXAMPLEFORUNITTESTSTESTING";
    const ledgerSeq = 12345;

    it("returns historical voting power", async () => {
      const scv = {} as xdr.ScVal;
      mockSimulate.mockResolvedValue({
        result: { retval: scv },
      });
      mockScValToNative.mockReturnValue(500);

      const votes = await client.getPastVotes(accountAddr, ledgerSeq);

      expect(votes).toBe(500n);
    });

    it("returns 0n when account had no voting power at ledger", async () => {
      const scv = {} as xdr.ScVal;
      mockSimulate.mockResolvedValue({
        result: { retval: scv },
      });
      mockScValToNative.mockReturnValue(0);

      const votes = await client.getPastVotes(accountAddr, ledgerSeq);

      expect(votes).toBe(0n);
    });

    it("returns 0n when simulation fails", async () => {
      mockIsSimulationError.mockReturnValue(true);
      mockSimulate.mockResolvedValue({
        error: "Ledger too old",
      });

      const votes = await client.getPastVotes(accountAddr, ledgerSeq);

      expect(votes).toBe(0n);
    });

    it("returns 0n when no return value", async () => {
      mockSimulate.mockResolvedValue({
        result: {},
      });

      const votes = await client.getPastVotes(accountAddr, ledgerSeq);

      expect(votes).toBe(0n);
    });

    it("calls contract with correct ledger parameter", async () => {
      const scv = {} as xdr.ScVal;
      mockSimulate.mockResolvedValue({
        result: { retval: scv },
      });
      mockScValToNative.mockReturnValue(100);

      await client.getPastVotes(accountAddr, ledgerSeq);

      expect(mockNativeToScVal).toHaveBeenCalledWith(accountAddr, { type: "address" });
      expect(mockNativeToScVal).toHaveBeenCalledWith(ledgerSeq, { type: "u32" });
    });
  });

  describe("getDelegatee()", () => {
    const accountAddr = "GBTESTACCOUNTADDRESSEXAMPLEFORUNITTESTSTESTING";
    const delegateeAddr = "GBTESTDELEGATEEADDRESSEXAMPLEFORUNITTESTSTESTING";

    it("returns current delegatee address", async () => {
      const scv = {} as xdr.ScVal;
      mockSimulate.mockResolvedValue({
        result: { retval: scv },
      });
      mockScValToNative.mockReturnValue(delegateeAddr);

      const delegatee = await client.getDelegatee(accountAddr);

      expect(delegatee).toBe(delegateeAddr);
    });

    it("returns null when account has no delegatee", async () => {
      const scv = {} as xdr.ScVal;
      mockSimulate.mockResolvedValue({
        result: { retval: scv },
      });
      mockScValToNative.mockReturnValue(null);

      const delegatee = await client.getDelegatee(accountAddr);

      expect(delegatee).toBeNull();
    });

    it("returns null when simulation fails", async () => {
      mockIsSimulationError.mockReturnValue(true);
      mockSimulate.mockResolvedValue({
        error: "Account not found",
      });

      const delegatee = await client.getDelegatee(accountAddr);

      expect(delegatee).toBeNull();
    });

    it("returns null when no return value", async () => {
      mockSimulate.mockResolvedValue({
        result: {},
      });

      const delegatee = await client.getDelegatee(accountAddr);

      expect(delegatee).toBeNull();
    });

    it("handles self-delegation", async () => {
      const scv = {} as xdr.ScVal;
      mockSimulate.mockResolvedValue({
        result: { retval: scv },
      });
      mockScValToNative.mockReturnValue(accountAddr);

      const delegatee = await client.getDelegatee(accountAddr);

      expect(delegatee).toBe(accountAddr);
    });
  });

  // ─── Analytics ────────────────────────────────────────────────────────────

  /**
   * Helper to set up mock events for del_chsh event scanning.
   *
   * scValToNative is called in strict order per event:
   *   1. topic[1]  → delegator address (string)
   *   2. value     → [previousDelegate | null, newDelegatee] (tuple)
   *
   * Use mockReturnValueOnce for each call after invoking this helper to
   * append getVotes / getTotalSupply return values in execution order.
   */
  function setupDelegationEvents(
    events: Array<{
      delegator: string;
      previousDelegate: string | null;
      newDelegatee: string;
      ledger: number;
    }>
  ) {
    mockGetLatestLedger.mockResolvedValue({ sequence: 100000 });
    mockGetEvents
      .mockResolvedValueOnce({
        events: events.map((e) => ({
          ledger: e.ledger,
          topic: [{}, {}],
          value: {},
        })),
      })
      .mockResolvedValue({ events: [] });

    // Queue scValToNative return values for event decoding phase
    for (const e of events) {
      mockScValToNative
        .mockReturnValueOnce("del_chsh")                                    // topic[0] — symbol
        .mockReturnValueOnce(e.delegator)                                   // topic[1] — delegator
        .mockReturnValueOnce([e.previousDelegate, e.newDelegatee]);        // value — tuple
    }
  }

  describe("getTopDelegates()", () => {
    it("returns top N delegates sorted by voting power", async () => {
      const delegatorA = "GDELEGATORA";
      const delegatorB = "GDELEGATORB";
      const delegatorC = "GDELEGATORC";
      const delegateX = "GDELEGATEX";
      const delegateY = "GDELEGATEY";

      setupDelegationEvents([
        { delegator: delegatorA, previousDelegate: null, newDelegatee: delegateX, ledger: 99000 },
        { delegator: delegatorB, previousDelegate: null, newDelegatee: delegateX, ledger: 99001 },
        { delegator: delegatorC, previousDelegate: null, newDelegatee: delegateY, ledger: 99002 },
      ]);

      // getVotes(delegateX) = 200, getVotes(delegateY) = 50
      // getBaseVotes(delegateX) and getBaseVotes(delegateY) also called
      mockSimulate
        .mockResolvedValueOnce({ result: { retval: {} } })
        .mockResolvedValueOnce({ result: { retval: {} } })
        .mockResolvedValueOnce({ result: { retval: {} } })
        .mockResolvedValueOnce({ result: { retval: {} } });
      mockScValToNative
        .mockReturnValueOnce(200n)    // getVotes(delegateX)
        .mockReturnValueOnce(100n)    // getBaseVotes(delegateX)
        .mockReturnValueOnce(50n)     // getVotes(delegateY)
        .mockReturnValueOnce(25n);    // getBaseVotes(delegateY)

      const top = await client.getTopDelegates(2, 99000);

      expect(top).toHaveLength(2);
      expect(top[0].address).toBe(delegateX);
      expect(top[0].votingPower).toBe(200n);
      expect(top[0].delegatorCount).toBe(2);
      expect(top[1].address).toBe(delegateY);
      expect(top[1].votingPower).toBe(50n);
      expect(top[1].delegatorCount).toBe(1);
    });

    it("returns empty array when no delegation events exist", async () => {
      mockGetLatestLedger.mockResolvedValue({ sequence: 100000 });
      mockGetEvents.mockResolvedValue({ events: [] });

      const top = await client.getTopDelegates(10, 99000);

      expect(top).toEqual([]);
    });

    it("respects the limit parameter", async () => {
      setupDelegationEvents([
        { delegator: "GDA", previousDelegate: null, newDelegatee: "GDELEGATEX", ledger: 99000 },
        { delegator: "GDB", previousDelegate: null, newDelegatee: "GDELEGATEY", ledger: 99001 },
        { delegator: "GDC", previousDelegate: null, newDelegatee: "GDELEGATEZ", ledger: 99002 },
      ]);

      mockSimulate
        .mockResolvedValueOnce({ result: { retval: {} } })
        .mockResolvedValueOnce({ result: { retval: {} } })
        .mockResolvedValueOnce({ result: { retval: {} } })
        .mockResolvedValueOnce({ result: { retval: {} } })
        .mockResolvedValueOnce({ result: { retval: {} } })
        .mockResolvedValueOnce({ result: { retval: {} } });
      mockScValToNative
        .mockReturnValueOnce(300n)    // getVotes(GDELEGATEX)
        .mockReturnValueOnce(150n)    // getBaseVotes(GDELEGATEX)
        .mockReturnValueOnce(200n)    // getVotes(GDELEGATEY)
        .mockReturnValueOnce(100n)    // getBaseVotes(GDELEGATEY)
        .mockReturnValueOnce(100n)    // getVotes(GDELEGATEZ)
        .mockReturnValueOnce(50n);    // getBaseVotes(GDELEGATEZ)

      const top = await client.getTopDelegates(1, 99000);

      expect(top).toHaveLength(1);
      expect(top[0].votingPower).toBe(300n);
    });

    it("throws VotesError(EventScanFailed) when event scanning fails", async () => {
      mockGetLatestLedger.mockResolvedValue({ sequence: 100000 });
      mockGetEvents.mockRejectedValue(new Error("RPC unavailable"));

      await expect(client.getTopDelegates(10, 99000)).rejects.toThrow(VotesError);

      try {
        await client.getTopDelegates(10, 99000);
      } catch (e) {
        expect((e as VotesError).code).toBe(VotesErrorCode.EventScanFailed);
      }
    });
  });

  describe("getDelegators()", () => {
    it("returns delegators for a given delegate address", async () => {
      const delegateX = "GDELEGATEX";
      const delegatorA = "GDELEGATORA";
      const delegatorB = "GDELEGATORB";

      setupDelegationEvents([
        { delegator: delegatorA, previousDelegate: null, newDelegatee: delegateX, ledger: 99000 },
        { delegator: delegatorB, previousDelegate: null, newDelegatee: delegateX, ledger: 99001 },
        { delegator: "GDELEGATORC", previousDelegate: null, newDelegatee: "GDELEGATEY", ledger: 99002 },
      ]);

      // getVotes for delegatorA and delegatorB
      mockSimulate
        .mockResolvedValueOnce({ result: { retval: {} } })
        .mockResolvedValueOnce({ result: { retval: {} } });
      mockScValToNative
        .mockReturnValueOnce(150n)
        .mockReturnValueOnce(75n);

      const delegators = await client.getDelegators(delegateX, 99000);

      expect(delegators).toHaveLength(2);
      expect(delegators.map((d) => d.delegator)).toContain(delegatorA);
      expect(delegators.map((d) => d.delegator)).toContain(delegatorB);
      // sorted descending by power
      expect(delegators[0].power).toBeGreaterThanOrEqual(delegators[1].power);
    });

    it("returns empty array when no one delegates to the address", async () => {
      mockGetLatestLedger.mockResolvedValue({ sequence: 100000 });
      mockGetEvents.mockResolvedValue({ events: [] });

      const delegators = await client.getDelegators("GDELEGATEX", 99000);

      expect(delegators).toEqual([]);
    });

    it("reflects re-delegation (only the most recent delegation counts)", async () => {
      const delegateX = "GDELEGATEX";
      const delegateY = "GDELEGATEY";
      const delegatorA = "GDELEGATORA";

      mockGetLatestLedger.mockResolvedValue({ sequence: 100000 });
      mockGetEvents
        .mockResolvedValueOnce({
          events: [
            { ledger: 99000, topic: [{}, {}], value: {} },
            { ledger: 99001, topic: [{}, {}], value: {} },
          ],
        })
        .mockResolvedValue({ events: [] });

      // Event 0: delegatorA → delegateX
      // Event 1: delegatorA → delegateY (re-delegation)
      mockScValToNative
        .mockReturnValueOnce("del_chsh")          // topic[0] — symbol
        .mockReturnValueOnce(delegatorA)           // topic[1] — delegator
        .mockReturnValueOnce([null, delegateX])    // value — tuple
        .mockReturnValueOnce("del_chsh")          // topic[0] — symbol
        .mockReturnValueOnce(delegatorA)           // topic[1] — delegator
        .mockReturnValueOnce([delegateX, delegateY]); // value — tuple

      // getDelegators(delegateX) should be empty — delegatorA moved to Y
      const delegatorsX = await client.getDelegators(delegateX, 99000);
      expect(delegatorsX).toEqual([]);
    });

    it("throws VotesError(EventScanFailed) when event scanning fails", async () => {
      mockGetLatestLedger.mockResolvedValue({ sequence: 100000 });
      mockGetEvents.mockRejectedValue(new Error("network error"));

      await expect(client.getDelegators("GDELEGATEX", 99000)).rejects.toThrow(
        VotesError
      );
    });
  });

  describe("getVotingPowerDistribution()", () => {
    it("returns zero stats when no delegation events exist", async () => {
      mockGetLatestLedger.mockResolvedValue({ sequence: 100000 });
      mockGetEvents.mockResolvedValue({ events: [] });

      // getTotalSupply simulation
      mockSimulate.mockResolvedValue({ result: { retval: {} } });
      mockScValToNative.mockReturnValue(1_000_000n);

      const dist = await client.getVotingPowerDistribution(99000);

      expect(dist.totalDelegated).toBe(0n);
      expect(dist.delegationRate).toBe(0);
      expect(dist.giniCoefficient).toBe(0);
    });

    it("computes delegation rate correctly", async () => {
      const delegateX = "GDELEGATEX";

      setupDelegationEvents([
        { delegator: "GDA", previousDelegate: null, newDelegatee: delegateX, ledger: 99000 },
      ]);

      // Promise.all runs getTotalSupply and buildDelegationMap concurrently.
      // getTotalSupply: one simulate call + scValToNative(retval)
      // getVotes(delegateX): one simulate call + scValToNative(retval)
      mockSimulate
        .mockResolvedValueOnce({ result: { retval: {} } }) // getTotalSupply
        .mockResolvedValueOnce({ result: { retval: {} } }); // getVotes(delegateX)
      mockScValToNative
        .mockReturnValueOnce(1_000_000n)   // getTotalSupply result
        .mockReturnValueOnce(500_000n);    // getVotes(delegateX) result

      const dist = await client.getVotingPowerDistribution(99000);

      expect(dist.totalSupply).toBe(1_000_000n);
      expect(dist.totalDelegated).toBe(500_000n);
      expect(dist.delegationRate).toBeCloseTo(0.5);
    });

    it("returns giniCoefficient=0 for a single delegate", async () => {
      const delegateX = "GDELEGATEX";

      setupDelegationEvents([
        { delegator: "GDA", previousDelegate: null, newDelegatee: delegateX, ledger: 99000 },
      ]);

      mockSimulate
        .mockResolvedValueOnce({ result: { retval: {} } })
        .mockResolvedValueOnce({ result: { retval: {} } });
      mockScValToNative
        .mockReturnValueOnce(1_000_000n)
        .mockReturnValueOnce(100n);

      const dist = await client.getVotingPowerDistribution(99000);

      expect(dist.giniCoefficient).toBe(0);
    });

    it("throws VotesError(EventScanFailed) when event scanning fails", async () => {
      mockGetLatestLedger.mockResolvedValue({ sequence: 100000 });
      mockGetEvents.mockRejectedValue(new Error("timeout"));

      mockSimulate.mockResolvedValue({ result: { retval: {} } });
      mockScValToNative.mockReturnValue(0n);

      await expect(
        client.getVotingPowerDistribution(99000)
      ).rejects.toThrow(VotesError);
    });
  });

  describe("getTopDelegatesByAddresses() (legacy address-list API)", () => {
    it("returns sorted delegates with percentOfSupply", async () => {
      const addr1 = "GDELEGATEA";
      const addr2 = "GDELEGATEB";

      // getTotalSupply
      mockSimulate
        .mockResolvedValueOnce({ result: { retval: {} } }) // total supply
        .mockResolvedValueOnce({ result: { retval: {} } }) // getVotes addr1
        .mockResolvedValueOnce({ result: { retval: {} } }); // getVotes addr2

      let cIdx = 0;
      const responses = [1_000n, 400n, 200n];
      mockScValToNative.mockImplementation(() => responses[cIdx++]);

      const top = await client.getTopDelegatesByAddresses([addr1, addr2], 10);

      expect(top).toHaveLength(2);
      expect(top[0].address).toBe(addr1);
      expect(top[0].votes).toBe(400n);
      expect(top[1].address).toBe(addr2);
    });

    it("returns empty array when total supply is 0", async () => {
      mockSimulate.mockResolvedValue({ result: { retval: {} } });
      mockScValToNative.mockReturnValue(0n);

      const top = await client.getTopDelegatesByAddresses(["GDELEGATEA"], 10);

      expect(top).toEqual([]);
    });
  });

  describe("delegation registry (issue #769)", () => {
    const delegatorAddr = "GBTESTDELEGATORADDRESSEXAMPLEFORUNITTESTSTESTING";
    const delegateeAddr = "GBTESTDELEGATEEADDRESSEXAMPLEFORUNITTESTSTESTING";

    it("getDelegationHistory() maps native history entries to camelCase", async () => {
      mockSimulate.mockResolvedValue({ result: { retval: {} } });
      mockScValToNative.mockReturnValue([
        {
          delegatee: delegateeAddr,
          delegated_at_ledger: 10,
          revoked_at_ledger: 20,
          power_at_delegation: 500n,
          sequence: 0,
        },
      ]);

      const history = await client.getDelegationHistory(delegatorAddr);

      expect(history).toEqual([
        {
          delegatee: delegateeAddr,
          delegatedAtLedger: 10,
          revokedAtLedger: 20,
          powerAtDelegation: 500n,
          sequence: 0,
        },
      ]);
    });

    it("getDelegationHistory() returns [] on simulation error", async () => {
      mockIsSimulationError.mockReturnValue(true);
      mockSimulate.mockResolvedValue({ error: "not found" });

      const history = await client.getDelegationHistory(delegatorAddr);

      expect(history).toEqual([]);
    });

    it("getRegistryDelegators() paginates and parses entries", async () => {
      mockSimulate.mockResolvedValue({ result: { retval: {} } });
      mockScValToNative.mockReturnValue([
        {
          address: delegatorAddr,
          delegated_power: 750n,
          delegated_at_ledger: 5,
          chain_depth: 1,
        },
      ]);

      const delegators = await client.getRegistryDelegators(delegateeAddr, 0, 50);

      expect(delegators).toEqual([
        {
          address: delegatorAddr,
          delegatedPower: 750n,
          delegatedAtLedger: 5,
          chainDepth: 1,
        },
      ]);
      expect(mockNativeToScVal).toHaveBeenCalledWith(delegateeAddr, { type: "address" });
      expect(mockNativeToScVal).toHaveBeenCalledWith(0, { type: "u32" });
      expect(mockNativeToScVal).toHaveBeenCalledWith(50, { type: "u32" });
    });

    it("getDelegatorCount() returns the count", async () => {
      mockSimulate.mockResolvedValue({ result: { retval: {} } });
      mockScValToNative.mockReturnValue(3);

      await expect(client.getDelegatorCount(delegateeAddr)).resolves.toBe(3);
    });

    it("getDelegatorCount() returns 0 on simulation error", async () => {
      mockIsSimulationError.mockReturnValue(true);
      mockSimulate.mockResolvedValue({ error: "not found" });

      await expect(client.getDelegatorCount(delegateeAddr)).resolves.toBe(0);
    });

    it("getDelegationChain() returns the address chain", async () => {
      mockSimulate.mockResolvedValue({ result: { retval: {} } });
      mockScValToNative.mockReturnValue([delegatorAddr, delegateeAddr]);

      await expect(client.getDelegationChain(delegatorAddr)).resolves.toEqual([
        delegatorAddr,
        delegateeAddr,
      ]);
    });

    it("getChainDepth() returns the depth", async () => {
      mockSimulate.mockResolvedValue({ result: { retval: {} } });
      mockScValToNative.mockReturnValue(2);

      await expect(client.getChainDepth(delegatorAddr)).resolves.toBe(2);
    });

    it("getDelegateProfile() maps all native fields to camelCase", async () => {
      mockSimulate.mockResolvedValue({ result: { retval: {} } });
      mockScValToNative.mockReturnValue({
        address: delegateeAddr,
        current_voting_power: 1000n,
        base_voting_power: 1000n,
        total_delegators: 2,
        total_delegated_power: 1000n,
        delegation_depth_limit: 1,
        first_delegated_at_ledger: 5,
      });

      const profile = await client.getDelegateProfile(delegateeAddr);

      expect(profile).toEqual({
        address: delegateeAddr,
        currentVotingPower: 1000n,
        baseVotingPower: 1000n,
        totalDelegators: 2,
        totalDelegatedPower: 1000n,
        delegationDepthLimit: 1,
        firstDelegatedAtLedger: 5,
      });
    });

    it("getDelegateProfile() returns a zeroed default on simulation error", async () => {
      mockIsSimulationError.mockReturnValue(true);
      mockSimulate.mockResolvedValue({ error: "not found" });

      const profile = await client.getDelegateProfile(delegateeAddr);

      expect(profile).toEqual({
        address: delegateeAddr,
        currentVotingPower: 0n,
        baseVotingPower: 0n,
        totalDelegators: 0,
        totalDelegatedPower: 0n,
        delegationDepthLimit: 1,
        firstDelegatedAtLedger: null,
      });
    });

    it("getReceivedDelegations() parses entries including null revokedAtLedger", async () => {
      mockSimulate.mockResolvedValue({ result: { retval: {} } });
      mockScValToNative.mockReturnValue([
        {
          delegator: delegatorAddr,
          delegatee: delegateeAddr,
          delegated_at_ledger: 1,
          voting_power_at_delegation: 100n,
          active: true,
          revoked_at_ledger: null,
        },
      ]);

      const received = await client.getReceivedDelegations(delegateeAddr);

      expect(received).toEqual([
        {
          delegator: delegatorAddr,
          delegatee: delegateeAddr,
          delegatedAtLedger: 1,
          votingPowerAtDelegation: 100n,
          active: true,
          revokedAtLedger: null,
        },
      ]);
    });

    it("wouldCreateCycle() returns the boolean result", async () => {
      mockSimulate.mockResolvedValue({ result: { retval: {} } });
      mockScValToNative.mockReturnValue(true);

      await expect(
        client.wouldCreateCycle(delegatorAddr, delegateeAddr),
      ).resolves.toBe(true);
    });

    it("getDelegationSnapshot() parses a past-ledger snapshot", async () => {
      mockSimulate.mockResolvedValue({ result: { retval: {} } });
      mockScValToNative.mockReturnValue([
        {
          address: delegatorAddr,
          delegated_power: 300n,
          delegated_at_ledger: 8,
          chain_depth: 0,
        },
      ]);

      const snapshot = await client.getDelegationSnapshot(delegateeAddr, 15);

      expect(snapshot).toEqual([
        {
          address: delegatorAddr,
          delegatedPower: 300n,
          delegatedAtLedger: 8,
          chainDepth: 0,
        },
      ]);
    });

    it("getDelegationDepthLimit() returns the current limit", async () => {
      mockSimulate.mockResolvedValue({ result: { retval: {} } });
      mockScValToNative.mockReturnValue(1);

      await expect(client.getDelegationDepthLimit()).resolves.toBe(1);
    });

    it("getDelegationDepthLimit() defaults to 1 on simulation error", async () => {
      mockIsSimulationError.mockReturnValue(true);
      mockSimulate.mockResolvedValue({ error: "not found" });

      await expect(client.getDelegationDepthLimit()).resolves.toBe(1);
    });

    describe("setDelegationDepthLimit()", () => {
      beforeEach(() => {
        const mockTx = { sign: jest.fn() };
        mockPrepareTransaction.mockResolvedValue(mockTx);
        mockSendTransaction.mockResolvedValue({
          status: "PENDING",
          hash: "setDepthLimit123",
        });
      });

      it("submits the admin transaction and returns the tx hash", async () => {
        const hash = await client.setDelegationDepthLimit(mockKeypair, 3);

        expect(hash).toBe("setDepthLimit123");
        expect(mockNativeToScVal).toHaveBeenCalledWith(mockKeypair.publicKey(), {
          type: "address",
        });
        expect(mockNativeToScVal).toHaveBeenCalledWith(3, { type: "u32" });
      });

      it("throws VotesError when the transaction fails", async () => {
        mockSendTransaction.mockResolvedValue({
          status: "ERROR",
          error: "unauthorized",
        });

        await expect(
          client.setDelegationDepthLimit(mockKeypair, 3),
        ).rejects.toThrow(VotesError);
      });
    });
  });
});
