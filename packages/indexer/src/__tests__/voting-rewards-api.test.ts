import request from "supertest";
import { createApp } from "../api";
import { pool } from "../db";

jest.mock("../db", () => ({
  pool: { query: jest.fn() },
}));

jest.mock("../cache", () => ({
  cached: jest.fn((_key, _ttl, fn) => fn()),
  getMetrics: jest.fn(() => ({ hits: 0, misses: 0, size: 0 })),
}));

jest.mock("../events", () => ({
  getLastIndexedLedger: jest.fn().mockResolvedValue(100),
}));

jest.mock("../index", () => ({
  startTime: Date.now(),
  INDEXED_CONTRACTS: {},
}));

const app = createApp({
  getLatestLedger: jest.fn().mockResolvedValue({ sequence: 100 }),
} as any);
const query = pool.query as jest.Mock;

describe("voting rewards API", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns paginated claims for an epoch", async () => {
    const claims = [{ event_id: "claim-1", claimant: "GCLAIMANT", amount: "25" }];
    query
      .mockResolvedValueOnce({
        rows: [{
          epoch_id: "1",
          total_reward_amount: "100",
          total_claimed: "25",
          swept_amount: "0",
        }],
      })
      .mockResolvedValueOnce({ rows: claims });

    const response = await request(app).get(
      "/voting-rewards/epochs/1/claims?limit=10&offset=2",
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      epoch: {
        epoch_id: "1",
        total_reward_amount: "100",
        total_claimed: "25",
        swept_amount: "0",
      },
      data: claims,
      pagination: { limit: 10, offset: 2, hasMore: false },
    });
    expect(query).toHaveBeenLastCalledWith(
      expect.stringContaining("FROM reward_claims"),
      ["1", 10, 2],
    );
  });

  it("rejects invalid epoch IDs and reports unknown epochs", async () => {
    const invalid = await request(app).get(
      "/voting-rewards/epochs/nope/claims",
    );
    query.mockResolvedValueOnce({ rows: [] });
    const missing = await request(app).get(
      "/voting-rewards/epochs/99/claims",
    );

    expect(invalid.status).toBe(400);
    expect(missing.status).toBe(404);
  });
});
