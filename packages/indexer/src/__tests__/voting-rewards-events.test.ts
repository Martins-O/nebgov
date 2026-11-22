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
const VOTING_REWARDS = "CVOTINGREWARDS";

function toScVal(value: unknown): xdr.ScVal {
  if (Array.isArray(value)) return xdr.ScVal.scvVec(value.map(toScVal));
  if (value instanceof Uint8Array) return xdr.ScVal.scvBytes(Buffer.from(value));
  return nativeToScVal(value);
}

function makeEvent(
  id: string,
  ledger: number,
  eventType: string,
  value: unknown,
  topic1: bigint | string,
  contractId = VOTING_REWARDS,
): SorobanRpc.Api.EventResponse {
  const topic = typeof topic1 === "bigint"
    ? nativeToScVal(topic1, { type: "u64" })
    : nativeToScVal(topic1);
  return {
    id,
    type: "contract",
    ledger,
    contractId,
    txHash: `tx-${ledger}`,
    topic: [nativeToScVal(eventType, { type: "symbol" }), topic],
    value: toScVal(value),
  } as unknown as SorobanRpc.Api.EventResponse;
}

describe("voting rewards event indexing", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (pool.query as jest.Mock).mockImplementation((sql: string) =>
      String(sql).includes("INSERT INTO reward_claims") ||
      String(sql).includes("INSERT INTO reward_pool_fundings")
        ? { rows: [{ event_id: "new-event" }], rowCount: 1 }
        : { rows: [], rowCount: null },
    );
  });

  it("indexes epoch lifecycle, claims and pool funding", async () => {
    const events = [
      makeEvent("epoch-start", 100, "EpochStarted", [80, 120], 1n),
      makeEvent(
        "root-published",
        121,
        "EpochRootPublished",
        [new Uint8Array(32).fill(1), 1000n],
        1n,
      ),
      makeEvent("claim-1", 122, "RewardClaimed", [1n, 25n], "GCLAIMANT"),
      makeEvent("fund-1", 123, "PoolFunded", 50n, "GFUNDER"),
      makeEvent("sweep-1", 124, "EpochSwept", 5n, 1n),
    ];
    const server = {
      getEvents: jest.fn().mockResolvedValue({ events }),
    } as unknown as SorobanRpc.Server;

    await processEvents(
      server,
      {
        rpcUrl: "http://fake",
        governorAddress: GOVERNOR,
        votingRewardsAddress: VOTING_REWARDS,
        pollIntervalMs: 1,
      },
      100,
    );

    expect(server.getEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: [{ type: "contract", contractIds: [GOVERNOR, VOTING_REWARDS] }],
      }),
    );
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO reward_epochs"),
      ["1", 80, 120, 100],
    );
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO reward_claims"),
      ["claim-1", "1", "GCLAIMANT", "25", 122, "tx-122"],
    );
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("total_claimed = total_claimed +"),
      ["1", "25", 122],
    );
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO reward_pool_fundings"),
      ["fund-1", "GFUNDER", "50", 123, "tx-123"],
    );
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("swept_amount = $2"),
      ["1", "5", 124],
    );
    expect(invalidatePattern).toHaveBeenCalledTimes(5);
    expect(broadcast).toHaveBeenCalledTimes(5);
  });

  it("does not index matching event topics from another contract", async () => {
    const server = {
      getEvents: jest.fn().mockResolvedValue({
        events: [
          makeEvent("other-contract", 200, "PoolFunded", 50n, "GFUNDER", GOVERNOR),
        ],
      }),
    } as unknown as SorobanRpc.Server;

    await processEvents(
      server,
      {
        rpcUrl: "http://fake",
        governorAddress: GOVERNOR,
        votingRewardsAddress: VOTING_REWARDS,
        pollIntervalMs: 1,
      },
      200,
    );

    expect(pool.query).not.toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO reward_pool_fundings"),
      expect.anything(),
    );
    expect(broadcast).not.toHaveBeenCalled();
  });
});
