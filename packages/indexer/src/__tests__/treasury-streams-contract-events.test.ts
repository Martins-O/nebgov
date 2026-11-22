import { nativeToScVal, SorobanRpc, xdr } from "@stellar/stellar-sdk";
import { processEvents } from "../events";
import { pool } from "../db";
import { broadcast } from "../ws";

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
const TREASURY_STREAMS = "CTREASURYSTREAMS";

function structScVal(fields: Record<string, xdr.ScVal>): xdr.ScVal {
  return xdr.ScVal.scvMap(
    Object.entries(fields).map(
      ([key, val]) =>
        new xdr.ScMapEntry({ key: nativeToScVal(key, { type: "symbol" }), val }),
    ),
  );
}

function makeEvent(
  id: string,
  eventType: string,
  streamId: number,
  value: xdr.ScVal,
  contractId = TREASURY_STREAMS,
): SorobanRpc.Api.EventResponse {
  return {
    id,
    type: "contract",
    ledger: 200,
    contractId,
    txHash: "tx-200",
    topic: [
      nativeToScVal(eventType, { type: "symbol" }),
      nativeToScVal(streamId, { type: "u64" }),
    ],
    value,
  } as unknown as SorobanRpc.Api.EventResponse;
}

function completed(streamId: number, totalStreamed: number): xdr.ScVal {
  return structScVal({
    stream_id: nativeToScVal(streamId, { type: "u64" }),
    total_streamed: nativeToScVal(totalStreamed, { type: "i128" }),
  });
}

function run(events: SorobanRpc.Api.EventResponse[], treasuryStreamsAddress?: string) {
  const server = {
    getEvents: jest.fn().mockResolvedValue({ events }),
  } as unknown as SorobanRpc.Server;
  return {
    server,
    done: processEvents(
      server,
      {
        rpcUrl: "http://fake",
        governorAddress: GOVERNOR,
        treasuryStreamsAddress,
        pollIntervalMs: 1,
      },
      100,
    ),
  };
}

describe("treasury-streams contract event indexing", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (pool.query as jest.Mock).mockResolvedValue({ rows: [] });
  });

  it("subscribes to the treasury-streams contract when its address is configured", async () => {
    const { server, done } = run([], TREASURY_STREAMS);
    await done;

    const filters = (server.getEvents as jest.Mock).mock.calls[0][0].filters;
    expect(filters[0].contractIds).toEqual([GOVERNOR, TREASURY_STREAMS]);
  });

  it("logs StrmCompleted to event_log and broadcasts treasury_stream_completed", async () => {
    const { done } = run([makeEvent("e1", "StrmCompleted", 7, completed(7, 900))], TREASURY_STREAMS);
    await done;

    const logInsert = (pool.query as jest.Mock).mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO event_log"),
    );
    expect(logInsert).toBeDefined();
    expect(logInsert![1].slice(0, 5)).toEqual(["e1", "StrmCompleted", 200, "tx-200", TREASURY_STREAMS]);

    expect(broadcast).toHaveBeenCalledWith({
      type: "treasury_stream_completed",
      data: { stream_id: "7", total_streamed: "900", ledger: 200 },
    });
  });

  it("logs other stream events without broadcasting or touching budget-stream tables", async () => {
    const executed = structScVal({
      stream_id: nativeToScVal(7, { type: "u64" }),
      amount: nativeToScVal(100, { type: "i128" }),
      executed_at_ledger: nativeToScVal(200, { type: "u32" }),
    });
    const { done } = run([makeEvent("e2", "StrmExec", 7, executed)], TREASURY_STREAMS);
    await done;

    const queries = (pool.query as jest.Mock).mock.calls.map(([sql]) => String(sql));
    expect(queries.some((sql) => sql.includes("INSERT INTO event_log"))).toBe(true);
    expect(queries.some((sql) => sql.includes("treasury_stream"))).toBe(false);
    expect(broadcast).not.toHaveBeenCalled();
  });
});
