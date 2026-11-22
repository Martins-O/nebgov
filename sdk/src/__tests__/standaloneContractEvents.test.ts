import {
  parseOptimisticProposalCreatedEvent,
  parseOptimisticObjectionCastEvent,
  parseOptimisticProposalPassedEvent,
  parseOptimisticConfigUpdatedEvent,
  parseStrategyRegisteredEvent,
  parseStrategyWithdrawalRequestedEvent,
  parseBondLockedEvent,
  parseBondSlashedEvent,
  parseRecurringStreamCreatedEvent,
  parseRecurringStreamExecutedEvent,
  parseRecurringStreamPausedEvent,
  parseRecurringStreamCancelledEvent,
  type SorobanEvent,
} from "../events";

const event = (topic: string[], value: unknown): SorobanEvent => ({
  ledger: 42,
  contractId: "CONTRACT",
  topic,
  value,
});

describe("standalone governance and treasury event parsers", () => {
  it("decodes optimistic proposal and objection tuples", () => {
    expect(parseOptimisticProposalCreatedEvent(event(["ProposalCreated", "7"], ["GPROPOSER", 100]))).toEqual({
      proposalId: 7n, proposer: "GPROPOSER", challengeEndLedger: 100,
    });
    expect(parseOptimisticObjectionCastEvent(event(["ObjectionCast", "7"], ["GOBJECTOR", 12n, 34n]))).toEqual({
      proposalId: 7n, objector: "GOBJECTOR", weight: 12n, runningTotal: 34n,
    });
    expect(parseOptimisticProposalPassedEvent(event(["ProposalPassed", "7"], []))).toEqual({ proposalId: 7n });
    expect(parseOptimisticConfigUpdatedEvent(event(["ConfigUpdated"], [10, 500, 30]))).toEqual({
      challengeWindowLedgers: 10, objectionThresholdBps: 500, executionWindowLedgers: 30,
    });
  });

  it("decodes treasury strategy contracttype records", () => {
    expect(parseStrategyRegisteredEvent(event(["StratReg", "1"], {
      strategy_id: 1n, adapter: "CADAPTER", token: "CTOKEN",
    }))).toEqual({ strategyId: 1n, adapter: "CADAPTER", token: "CTOKEN" });
    expect(parseStrategyWithdrawalRequestedEvent(event(["WdrawReq", "4"], {
      withdrawal_id: 4n, strategy_id: 1n, amount: 80n, claimable_ledger: 90,
    }))).toEqual({ withdrawalId: 4n, strategyId: 1n, amount: 80n, claimableLedger: 90 });
  });

  it("decodes proposal bond topics and tuples", () => {
    expect(parseBondLockedEvent(event(["BondLocked", "GPROPOSER"], ["HASH", 25n]))).toEqual({
      proposer: "GPROPOSER", descriptionHash: "HASH", amount: 25n,
    });
    expect(parseBondSlashedEvent(event(["BondSlashed", "GPROPOSER"], ["HASH", 25n, "GTREASURY"]))).toEqual({
      proposer: "GPROPOSER", descriptionHash: "HASH", amount: 25n, recipient: "GTREASURY",
    });
  });

  it("decodes recurring streams independently of budget stream events", () => {
    expect(parseRecurringStreamCreatedEvent(event(["StrmCreated", "3"], {
      stream_id: 3n, recipient: "GRECIPIENT", amount_per_interval: 5n, interval_ledgers: 10,
    }))).toEqual({ streamId: 3n, recipient: "GRECIPIENT", amountPerInterval: 5n, intervalLedgers: 10 });
    expect(parseRecurringStreamExecutedEvent(event(["StrmExec", "3"], {
      stream_id: 3n, amount: 5n, executed_at_ledger: 200,
    }))).toEqual({ streamId: 3n, amount: 5n, executedAtLedger: 200 });
    expect(parseRecurringStreamPausedEvent(event(["StrmPaused", "3"], []))).toEqual({ streamId: 3n });
    expect(parseRecurringStreamCancelledEvent(event(["StrmCancel", "3"], {
      stream_id: 3n, total_streamed: 15n,
    }))).toEqual({ streamId: 3n, totalStreamed: 15n });
  });

  it("rejects unrelated topics and malformed payloads", () => {
    expect(parseOptimisticObjectionCastEvent(event(["VoteCast", "7"], ["G", 1, 2]))).toBeNull();
    expect(parseStrategyRegisteredEvent(event(["StratReg", "1"], { strategy_id: "invalid" }))).toBeNull();
    expect(parseBondLockedEvent(event(["BondLocked", "G"], []))).toBeNull();
    expect(parseRecurringStreamExecutedEvent(event(["StrmExec", "3"], { stream_id: 3 }))).toBeNull();
  });
});
