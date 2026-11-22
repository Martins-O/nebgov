import { Keypair, StrKey, xdr, scValToNative } from "@stellar/stellar-sdk";
import { ProposalBondsClient } from "../proposalBonds";

describe("ProposalBondsClient", () => {
  const contractAddress = StrKey.encodeContract(Buffer.alloc(32, 1));

  function makeClient(): ProposalBondsClient {
    return new ProposalBondsClient({
      governorAddress: contractAddress,
      timelockAddress: contractAddress,
      votesAddress: contractAddress,
      proposalBondsAddress: contractAddress,
      network: "testnet",
    });
  }

  describe("encodeSlashCalldata", () => {
    it("round-trips address args as ScVal.scvAddress, not scvString", () => {
      const client = makeClient();
      const governorAddress = contractAddress;
      const recipient = Keypair.random().publicKey();
      const descriptionHash = "ab".repeat(32);

      const calldata = client.encodeSlashCalldata(
        governorAddress,
        descriptionHash,
        recipient,
      );

      const decodedVec = xdr.ScVal.fromXDR(calldata).vec();
      expect(decodedVec).not.toBeNull();
      const [govArg, hashArg, recipientArg] = decodedVec!;

      // The bug this guards against: encodeCalldata() has no per-arg type
      // hint, so a plain address string silently encodes as scvString
      // instead of scvAddress — the contract's `slash(caller: Address, ...,
      // recipient: Address)` would then trap on execution.
      expect(govArg.switch().name).toBe("scvAddress");
      expect(recipientArg.switch().name).toBe("scvAddress");
      expect(hashArg.switch().name).toBe("scvBytes");

      expect(scValToNative(govArg)).toBe(governorAddress);
      expect(scValToNative(recipientArg)).toBe(recipient);
      expect(Buffer.from(scValToNative(hashArg) as Uint8Array).toString("hex")).toBe(
        descriptionHash,
      );
    });
  });

  describe("admin methods", () => {
    function spySubmit(client: ProposalBondsClient): jest.SpyInstance {
      return jest
        .spyOn(client as unknown as { submit: () => Promise<unknown> }, "submit")
        .mockResolvedValue({ hash: "HASH" });
    }

    it("updateSettings calls update_settings with typed address and u32 args", async () => {
      const client = makeClient();
      const submit = spySubmit(client);
      const admin = Keypair.random();
      const bondToken = StrKey.encodeContract(Buffer.alloc(32, 2));
      const governor = StrKey.encodeContract(Buffer.alloc(32, 3));

      const hash = await client.updateSettings(admin, {
        bondToken,
        governor,
        refundGraceLedgers: 100,
        maxLockLedgers: 1_000,
      });

      expect(hash).toBe("HASH");
      const [signer, fnName, ...args] = submit.mock.calls[0] as [Keypair, string, ...xdr.ScVal[]];
      expect(signer).toBe(admin);
      expect(fnName).toBe("update_settings");
      expect(args.map((arg) => arg.switch().name)).toEqual([
        "scvAddress",
        "scvAddress",
        "scvAddress",
        "scvU32",
        "scvU32",
      ]);
      expect(args.map((arg) => scValToNative(arg))).toEqual([
        admin.publicKey(),
        bondToken,
        governor,
        100,
        1_000,
      ]);
    });

    it("setAdmin calls set_admin with the current and new admin", async () => {
      const client = makeClient();
      const submit = spySubmit(client);
      const admin = Keypair.random();
      const newAdmin = Keypair.random().publicKey();

      await client.setAdmin(admin, newAdmin);

      const [, fnName, ...args] = submit.mock.calls[0] as [Keypair, string, ...xdr.ScVal[]];
      expect(fnName).toBe("set_admin");
      expect(args.map((arg) => scValToNative(arg))).toEqual([admin.publicKey(), newAdmin]);
    });
  });

  describe("indexer-backed query methods", () => {
    const originalFetch = global.fetch;
    let mockFetch: jest.Mock;

    beforeEach(() => {
      mockFetch = jest.fn();
      global.fetch = mockFetch as unknown as typeof fetch;
    });

    afterAll(() => {
      global.fetch = originalFetch;
    });

    it("listBonds propagates the indexer's camelCase hasMore flag", async () => {
      const client = new ProposalBondsClient({
        governorAddress: contractAddress,
        timelockAddress: contractAddress,
        votesAddress: contractAddress,
        proposalBondsAddress: contractAddress,
        network: "testnet",
        indexerUrl: "https://indexer.example.com",
        maxAttempts: 1,
      });

      mockFetch.mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({
          data: [],
          // The indexer's /proposal-bonds endpoint returns camelCase
          // `hasMore` (packages/indexer/src/api.ts), matching every other
          // paginated endpoint in this codebase.
          pagination: { page: 1, limit: 20, hasMore: true },
        }),
      });

      const result = await client.listBonds();

      expect(result.pagination.hasMore).toBe(true);
    });
  });
});
