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

describe("governor factory API", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("lists governor deployments with a deployer filter and pagination", async () => {
    const rows = [{ governor_id: "7", deployer: "GDEPLOYER" }];
    query.mockResolvedValueOnce({ rows });

    const response = await request(app).get(
      "/factory/governors?deployer=GDEPLOYER&limit=10&offset=2",
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      data: rows,
      pagination: { limit: 10, offset: 2, hasMore: false },
    });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("WHERE deployer = $1"),
      ["GDEPLOYER", 10, 2],
    );
  });

  it("rejects invalid pagination parameters", async () => {
    const response = await request(app).get(
      "/factory/governors?limit=0&offset=0",
    );

    expect(response.status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });
});
