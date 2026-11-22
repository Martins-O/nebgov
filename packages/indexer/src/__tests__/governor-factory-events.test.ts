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
const FACTORY = "CFACTORY";

function toScVal(value: unknown): xdr.ScVal {
  if (
    value !== null &&
    typeof value === "object" &&
    !(value instanceof Uint8Array)
  ) {
    const entries = Object.entries(value).map(
      ([key, item]) =>
        new xdr.ScMapEntry({
          key: nativeToScVal(key, { type: "symbol" }),
          val: toScVal(item),
        }),
    );
    return xdr.ScVal.scvMap(entries);
  }
  return nativeToScVal(value);
}

function makeEvent(
  id: string,
  ledger: number,
  eventType: string,
  value: unknown,
  deployer: string,
  contractId = FACTORY,
): SorobanRpc.Api.EventResponse {
  return {
    id,
    type: "contract",
    ledger,
    contractId,
    txHash: `tx-${ledger}`,
    topic: [
      nativeToScVal(eventType, { type: "symbol" }),
      nativeToScVal(deployer),
    ],
    value: toScVal(value),
  } as unknown as SorobanRpc.Api.EventResponse;
}

describe("governor factory event indexing", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (pool.query as jest.Mock).mockResolvedValue({ rows: [], rowCount: 1 });
  });

  it("records a deployed governor and invalidates the deployment list", async () => {
    const deployment = {
      id: 7n,
      governor: "CGOVERNOR7",
      timelock: "CTIMELOCK7",
      token_votes: "CVOTES7",
      deployer: "GDEPLOYER",
      timestamp: 1_800_000_000n,
    };
    const server = {
      getEvents: jest.fn().mockResolvedValue({
        events: [
          makeEvent("deployed-7", 100, "GovernorDeployed", deployment, "GDEPLOYER"),
        ],
      }),
    } as unknown as SorobanRpc.Server;

    await processEvents(
      server,
      {
        rpcUrl: "http://fake",
        governorAddress: GOVERNOR,
        governorFactoryAddress: FACTORY,
        pollIntervalMs: 1,
      },
      100,
    );

    expect(server.getEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: [{ type: "contract", contractIds: [GOVERNOR, FACTORY] }],
      }),
    );
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO factory_governors"),
      [
        "7",
        "CGOVERNOR7",
        "CTIMELOCK7",
        "CVOTES7",
        "GDEPLOYER",
        1_800_000_000,
        100,
        "deployed-7",
        "tx-100",
      ],
    );
    expect(invalidatePattern).toHaveBeenCalledWith("factory:governors:");
    expect(broadcast).toHaveBeenCalledWith({
      type: "governor_deployed",
      data: {
        governor_id: "7",
        governor: "CGOVERNOR7",
        timelock: "CTIMELOCK7",
        token_votes: "CVOTES7",
        deployer: "GDEPLOYER",
        deployed_at: 1_800_000_000,
        ledger: 100,
      },
    });
  });

  it("does not index the deployment topic from a different contract", async () => {
    const server = {
      getEvents: jest.fn().mockResolvedValue({
        events: [
          makeEvent(
            "wrong-contract",
            200,
            "GovernorDeployed",
            {
              id: 7n,
              governor: "CGOVERNOR7",
              timelock: "CTIMELOCK7",
              token_votes: "CVOTES7",
              deployer: "GDEPLOYER",
              timestamp: 1_800_000_000n,
            },
            "GDEPLOYER",
            GOVERNOR,
          ),
        ],
      }),
    } as unknown as SorobanRpc.Server;

    await processEvents(
      server,
      {
        rpcUrl: "http://fake",
        governorAddress: GOVERNOR,
        governorFactoryAddress: FACTORY,
        pollIntervalMs: 1,
      },
      200,
    );

    expect(pool.query).not.toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO factory_governors"),
      expect.anything(),
    );
    expect(broadcast).not.toHaveBeenCalled();
  });
});
