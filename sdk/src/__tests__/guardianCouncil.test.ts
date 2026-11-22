import {
  Account,
  Keypair,
  SorobanRpc,
  StrKey,
  nativeToScVal,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import {
  GuardianCouncilClient,
  encodeGuardianAction,
  decodeGuardianAction,
  type GuardianAction,
} from "../index";

const signer = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 7));
const address = StrKey.encodeContract(Buffer.alloc(32, 1));
const actions: GuardianAction[] = [
  { tag: "Pause" },
  { tag: "Unpause" },
  { tag: "CancelActive", proposalId: 18446744073709551615n },
  { tag: "CancelQueued", proposalId: 4n },
  { tag: "RotateMember", old: signer.publicKey(), new: address },
  { tag: "SetThreshold", threshold: 2 },
  { tag: "SetActionTtl", ttlLedgers: 0 },
];

it.each(actions)(
  "round-trips $tag with contract-compatible types",
  (action) => {
    const encoded = encodeGuardianAction(action);
    expect(encoded.vec()![0].switch().name).toBe("scvSymbol");
    expect(decodeGuardianAction(scValToNative(encoded))).toEqual(action);
    if (action.tag === "RotateMember") {
      expect(
        encoded
          .vec()![1]
          .map()!
          .map((entry) => entry.val().switch().name),
      ).toEqual(["scvAddress", "scvAddress"]);
    }
  },
);
it("rejects unknown action variants", () => {
  expect(() => decodeGuardianAction(["Unknown"])).toThrow(
    "Unknown GuardianAction",
  );
});

describe("GuardianCouncilClient RPC", () => {
  const client = () =>
    new GuardianCouncilClient({
      guardianCouncilAddress: address,
      network: "testnet",
      simulationAccount: signer.publicKey(),
    });
  let calls: Array<{ function: string; args: xdr.ScVal[] }>;
  let retval: xdr.ScVal;
  beforeEach(() => {
    calls = [];
    retval = nativeToScVal(9n, { type: "u64" });
    jest
      .spyOn(SorobanRpc.Server.prototype, "getAccount")
      .mockResolvedValue(new Account(signer.publicKey(), "0"));
    jest
      .spyOn(SorobanRpc.Server.prototype, "prepareTransaction")
      .mockImplementation(async (tx) => {
        const op = tx.operations[0] as { func: xdr.HostFunction };
        const args = op.func.invokeContract();
        calls.push({
          function: args.functionName().toString(),
          args: args.args(),
        });
        return tx as Awaited<
          ReturnType<SorobanRpc.Server["prepareTransaction"]>
        >;
      });
    jest
      .spyOn(SorobanRpc.Server.prototype, "sendTransaction")
      .mockResolvedValue({ status: "PENDING", hash: "hash" } as Awaited<
        ReturnType<SorobanRpc.Server["sendTransaction"]>
      >);
    jest
      .spyOn(SorobanRpc.Server.prototype, "getTransaction")
      .mockImplementation(
        async () =>
          ({ status: "SUCCESS", returnValue: retval }) as Awaited<
            ReturnType<SorobanRpc.Server["getTransaction"]>
          >,
      );
    jest
      .spyOn(SorobanRpc.Server.prototype, "simulateTransaction")
      .mockImplementation(
        async () =>
          ({ result: { retval } }) as Awaited<
            ReturnType<SorobanRpc.Server["simulateTransaction"]>
          >,
      );
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });
  async function finish<T>(promise: Promise<T>): Promise<T> {
    await jest.runAllTimersAsync();
    return promise;
  }
  it("submits initialization and all action mutations with exact arguments", async () => {
    const c = client();
    await finish(c.initialize(signer, [signer.publicKey()], 1, address, 100));
    expect(await finish(c.proposeAction(signer, actions[2]))).toBe(9n);
    await finish(c.approveAction(signer, 9n));
    await finish(c.revokeApproval(signer, 9n));
    await finish(c.executeAction(signer, 9n));
    expect(calls.map((call) => call.function)).toEqual([
      "initialize",
      "propose_action",
      "approve_action",
      "revoke_approval",
      "execute_action",
    ]);
    expect(calls.map((call) => call.args.length)).toEqual([5, 2, 2, 2, 1]);
    expect(scValToNative(calls[0].args[0])).toBe(signer.publicKey());
    expect(calls[0].args[1].vec()![0].switch().name).toBe("scvAddress");
    expect(scValToNative(calls[2].args[0])).toBe(signer.publicKey());
    expect(scValToNative(calls[4].args[0])).toBe(9n);
  });
  it("submits wallet-signed mutations through the supplied signer", async () => {
    const c = client();
    const signed: string[] = [];
    const sign = async (unsignedXdr: string) => {
      signed.push(unsignedXdr);
      return unsignedXdr;
    };
    const who = signer.publicKey();
    expect(
      await finish(c.proposeActionWithSign(who, actions[6], sign)),
    ).toBe(9n);
    await finish(c.approveActionWithSign(who, 9n, sign));
    await finish(c.revokeApprovalWithSign(who, 9n, sign));
    await finish(c.executeActionWithSign(who, 9n, sign));
    expect(signed).toHaveLength(4);
    expect(calls.map((call) => call.function)).toEqual([
      "propose_action",
      "approve_action",
      "revoke_approval",
      "execute_action",
    ]);
    expect(calls.map((call) => call.args.length)).toEqual([2, 2, 2, 1]);
    expect(scValToNative(calls[1].args[0])).toBe(who);
    expect(scValToNative(calls[3].args[0])).toBe(9n);
  });
  it("reads the action TTL", async () => {
    retval = nativeToScVal(120, { type: "u32" });
    expect(await client().getActionTtl()).toBe(120);
  });
  it("lists actions until the contract reports ActionNotFound", async () => {
    const c = client();
    const action = (id: bigint): GuardianAction => ({
      tag: "CancelActive",
      proposalId: id,
    });
    jest.spyOn(c, "getAction").mockImplementation(async (id) => {
      if (id >= 3n)
        throw new Error(
          "Guardian council simulation failed: HostError: Error(Contract, #4)",
        );
      return {
        id,
        action: action(id),
        proposer: signer.publicKey(),
        createdLedger: 1,
        approvals: [],
        executed: false,
      };
    });
    expect((await c.listActions()).map((a) => a.id)).toEqual([0n, 1n, 2n]);
    expect((await c.listActions(1n, 1)).map((a) => a.id)).toEqual([1n]);
  });
  it("rethrows unexpected failures while listing actions", async () => {
    const c = client();
    jest.spyOn(c, "getAction").mockRejectedValue(new Error("rpc offline"));
    await expect(c.listActions()).rejects.toThrow("rpc offline");
  });
  it("maps views and full-width IDs", async () => {
    const c = client();
    retval = xdr.ScVal.scvMap(
      Object.entries({
        action: encodeGuardianAction(actions[2]),
        id: nativeToScVal(18446744073709551615n, { type: "u64" }),
        proposer: nativeToScVal(signer.publicKey(), { type: "address" }),
        created_ledger: nativeToScVal(12, { type: "u32" }),
        approvals: xdr.ScVal.scvVec([
          nativeToScVal(signer.publicKey(), { type: "address" }),
        ]),
        executed: nativeToScVal(false),
      })
        .sort(([a], [b]) => a.localeCompare(b))
        .map(
          ([key, val]) =>
            new xdr.ScMapEntry({
              key: nativeToScVal(key, { type: "symbol" }),
              val,
            }),
        ),
    );
    expect(await c.getAction(18446744073709551615n)).toEqual({
      id: 18446744073709551615n,
      action: actions[2],
      proposer: signer.publicKey(),
      createdLedger: 12,
      approvals: [signer.publicKey()],
      executed: false,
    });
    retval = xdr.ScVal.scvVec([
      nativeToScVal(signer.publicKey(), { type: "address" }),
    ]);
    expect(await c.getMembers()).toEqual([signer.publicKey()]);
    retval = nativeToScVal(2, { type: "u32" });
    expect(await c.getThreshold()).toBe(2);
    retval = nativeToScVal(address, { type: "address" });
    expect(await c.getGovernor()).toBe(address);
  });
  it("requires a funded simulation account", async () => {
    await expect(
      new GuardianCouncilClient({
        guardianCouncilAddress: address,
        network: "testnet",
      }).getMembers(),
    ).rejects.toThrow("simulationAccount is required");
  });
  it("reports simulation errors", async () => {
    jest
      .mocked(SorobanRpc.Server.prototype.simulateTransaction)
      .mockResolvedValue({ error: "contract error" } as Awaited<
        ReturnType<SorobanRpc.Server["simulateTransaction"]>
      >);
    await expect(client().getMembers()).rejects.toThrow("contract error");
  });
  it("reports send rejection without polling", async () => {
    jest.mocked(SorobanRpc.Server.prototype.sendTransaction).mockResolvedValue({
      status: "ERROR",
      hash: "hash",
    } as Awaited<ReturnType<SorobanRpc.Server["sendTransaction"]>>);
    await expect(client().executeAction(signer, 1n)).rejects.toThrow(
      "transaction rejected",
    );
    expect(SorobanRpc.Server.prototype.getTransaction).not.toHaveBeenCalled();
  });
  it("reports missing simulation values", async () => {
    jest
      .mocked(SorobanRpc.Server.prototype.simulateTransaction)
      .mockResolvedValue({
        result: {},
      } as Awaited<ReturnType<SorobanRpc.Server["simulateTransaction"]>>);
    await expect(client().getThreshold()).rejects.toThrow("returned no value");
  });
  it.each(["FAILED", "NOT_FOUND"])(
    "reports %s confirmation",
    async (status) => {
      jest
        .mocked(SorobanRpc.Server.prototype.getTransaction)
        .mockResolvedValue({ status } as Awaited<
          ReturnType<SorobanRpc.Server["getTransaction"]>
        >);
      const promise = client().executeAction(signer, 1n);
      const assertion = expect(promise).rejects.toThrow(
        status === "FAILED" ? "transaction failed" : "timed out",
      );
      await jest.runAllTimersAsync();
      await assertion;
    },
  );
});
