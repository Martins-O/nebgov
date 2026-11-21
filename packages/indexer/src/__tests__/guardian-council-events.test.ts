import { nativeToScVal, SorobanRpc, xdr } from "@stellar/stellar-sdk";
import { processEvents } from "../events";
import { pool } from "../db";
import { broadcast } from "../ws";
import { invalidatePattern } from "../cache";

jest.mock("../db", () => ({
  pool: { query: jest.fn() },
}));

jest.mock("../cache", () => ({
  invalidate: jest.fn(),
  invalidatePattern: jest.fn(),
}));

jest.mock("../ws", () => ({
  broadcast: jest.fn(),
}));

const GOVERNOR = "CGOVERNOR";
const GUARDIAN_COUNCIL = "CGUARDIANCOUNCIL";

function toScVal(value: unknown): any {
  if (Array.isArray(value)) return xdr.ScVal.scvVec(value.map(toScVal));
  if (value !== null && typeof value === "object" && !(value instanceof xdr.ScVal)) {
    const mapEntries = Object.entries(value).map(([k, v]) =>
      new xdr.ScMapEntry({
        key: nativeToScVal(k, { type: "symbol" }),
        val: toScVal(v),
      }),
    );
    return xdr.ScVal.scvMap(mapEntries);
  }
  return nativeToScVal(value);
}

interface GuardianCouncilEventOptions {
  topicValue?: unknown[];
}

function makeGuardianCouncilEvent(
  id: string,
  ledger: number,
  eventType: string,
  value: unknown,
  options?: GuardianCouncilEventOptions,
  contractId = GUARDIAN_COUNCIL,
): SorobanRpc.Api.EventResponse {
  const topics: any[] = [];

  // First topic is always the event type
  topics.push(nativeToScVal(eventType, { type: "symbol" }));
  if (options?.topicValue) {
    for (const tv of options.topicValue) {
      topics.push(nativeToScVal(tv));
    }
  }

  return {
    id,
    type: "contract",
    ledger,
    contractId,
    txHash: `tx-${ledger}`,
    topic: topics,
    value: toScVal(value),
  } as unknown as SorobanRpc.Api.EventResponse;
}

describe("guardian council event indexing", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (pool.query as jest.Mock).mockResolvedValue({ rows: [] });
  });

  function run(events: SorobanRpc.Api.EventResponse[]) {
    const server = {
      getEvents: jest.fn().mockResolvedValue({ events }),
    } as unknown as SorobanRpc.Server;
    return processEvents(
      server,
      {
        rpcUrl: "http://fake",
        governorAddress: GOVERNOR,
        guardianCouncilAddress: GUARDIAN_COUNCIL,
        pollIntervalMs: 1,
      },
      100,
    );
  }

  it("handles ActionProposed event", async () => {
    await run([
      makeGuardianCouncilEvent(
        "e1",
        100,
        "ActionProposed",
        [1000n, { sym: "Pause" }],
        { topicValue: ["GPROPOSER1"] },
      ),
    ]);

    const insertQuery = (pool.query as jest.Mock).mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO guardian_council_actions"),
    );
    expect(insertQuery).toBeDefined();
    expect(insertQuery![1]).toEqual([
      "1000",
      "Pause",
      "GPROPOSER1",
      100,
    ]);
    expect(invalidatePattern).toHaveBeenCalledWith("guardian-council:");
    expect(broadcast).toHaveBeenCalledWith({
      type: "action_proposed",
      data: { action_id: "1000", proposer: "GPROPOSER1", action_kind: "Pause", ledger: 100 },
    });
  });

  it("handles ActionApproved event", async () => {
    await run([
      makeGuardianCouncilEvent(
        "e2",
        101,
        "ActionApproved",
        [1000n, 2n],
        { topicValue: ["GMEMBER1"] },
      ),
    ]);

    const insertQuery = (pool.query as jest.Mock).mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO guardian_council_approvals") ||
      String(sql).includes("UPDATE guardian_council_approvals"),
    );
    expect(insertQuery).toBeDefined();
    // The handler uses TRUE as a SQL literal, so params are [actionId, member, ledger]
    expect(insertQuery![1]).toEqual(["1000", "GMEMBER1", 101]);
    expect(invalidatePattern).toHaveBeenCalledWith("guardian-council:");
    expect(broadcast).toHaveBeenCalledWith({
      type: "action_approved",
      data: { action_id: "1000", member: "GMEMBER1", approvals_count: 2, ledger: 101 },
    });
  });

  it("handles ApprovalRevoked event", async () => {
    await run([
      makeGuardianCouncilEvent(
        "e3",
        102,
        "ApprovalRevoked",
        1000n,
        { topicValue: ["GMEMBER1"] },
      ),
    ]);

    const updateQuery = (pool.query as jest.Mock).mock.calls.find(([sql]) =>
      String(sql).includes("UPDATE guardian_council_approvals") &&
      String(sql).includes("approved = FALSE"),
    );
    expect(updateQuery).toBeDefined();
    expect(updateQuery![1]).toEqual([102, "1000", "GMEMBER1"]);
    expect(invalidatePattern).toHaveBeenCalledWith("guardian-council:");
    expect(broadcast).toHaveBeenCalledWith({
      type: "approval_revoked",
      data: { action_id: "1000", member: "GMEMBER1", ledger: 102 },
    });
  });

  it("handles ActionExecuted event", async () => {
    // First insert the action
    (pool.query as jest.Mock).mockImplementation((sql: string) => {
      if (String(sql).includes("SELECT action_kind FROM guardian_council_actions")) {
        return Promise.resolve({ rows: [{ action_kind: "Pause" }] });
      }
      return Promise.resolve({ rows: [] });
    });

    await run([
      makeGuardianCouncilEvent("e4", 103, "ActionExecuted", 1000n),
    ]);

    const updateQuery = (pool.query as jest.Mock).mock.calls.find(([sql]) =>
      String(sql).includes("UPDATE guardian_council_actions") &&
      String(sql).includes("executed = TRUE"),
    );
    expect(updateQuery).toBeDefined();
    expect(updateQuery![1]).toEqual([103, "1000"]);
    expect(invalidatePattern).toHaveBeenCalledWith("guardian-council:");
    expect(broadcast).toHaveBeenCalledWith({
      type: "action_executed",
      data: { action_id: "1000", action_kind: "Pause", ledger: 103 },
    });
  });

  it("handles MembershipRotated event", async () => {
    await run([
      makeGuardianCouncilEvent(
        "e5",
        104,
        "MembershipRotated",
        [{ address: "GOLDMEMBER" }, { address: "GNEWMEMBER" }],
      ),
    ]);

    const updateQuery = (pool.query as jest.Mock).mock.calls.find(([sql]) =>
      String(sql).includes("UPDATE guardian_council_members") &&
      String(sql).includes("removed_at_ledger"),
    );
    expect(updateQuery).toBeDefined();

    const insertQuery = (pool.query as jest.Mock).mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO guardian_council_members"),
    );
    expect(insertQuery).toBeDefined();
    expect(insertQuery![1]).toEqual(["GNEWMEMBER", 104]);
    expect(invalidatePattern).toHaveBeenCalledWith("guardian-council:");
    expect(broadcast).toHaveBeenCalledWith({
      type: "membership_rotated",
      data: { old_member: "GOLDMEMBER", new_member: "GNEWMEMBER", ledger: 104 },
    });
  });

  it("handles ThresholdUpdated event", async () => {
    await run([
      makeGuardianCouncilEvent(
        "e6",
        105,
        "ThresholdUpdated",
        [2n, 3n],
      ),
    ]);

    expect(broadcast).toHaveBeenCalledWith({
      type: "threshold_updated",
      data: { old_threshold: 2, new_threshold: 3, ledger: 105 },
    });
    expect(invalidatePattern).toHaveBeenCalledWith("guardian-council:");
  });

  it("handles ActionTtlUpdated event", async () => {
    await run([
      makeGuardianCouncilEvent(
        "e7",
        106,
        "ActionTtlUpdated",
        [100000n, 200000n],
      ),
    ]);

    expect(broadcast).toHaveBeenCalledWith({
      type: "action_ttl_updated",
      data: { old_ttl: 100000, new_ttl: 200000, ledger: 106 },
    });
    expect(invalidatePattern).toHaveBeenCalledWith("guardian-council:");
  });

  it("does not process guardian-council events from another contract", async () => {
    await run([
      makeGuardianCouncilEvent(
        "e8",
        110,
        "ActionProposed",
        [1000n, { sym: "Pause" }],
        { topicValue: ["GPROPOSER1"] },
        GOVERNOR, // Wrong contract
      ),
    ]);

    const insertQuery = (pool.query as jest.Mock).mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO guardian_council_actions"),
    );
    expect(insertQuery).toBeUndefined();
    expect(invalidatePattern).not.toHaveBeenCalled();
  });
});