jest.mock("@nebgov/sdk", () => jest.requireActual("./sdkMock").mockSdk());

import {
  ConvictionVotingClient,
  OptimisticGovernorClient,
  ProposalBondsClient,
  SignalingClient,
  TreasuryStrategiesClient,
} from "@nebgov/sdk";
import { stubClient } from "./sdkMock";
import {
  BASE_CONFIG,
  OTHER_ACCOUNT,
  SIGNER,
  contractAddress,
  runCli,
  useCleanEnvironment,
  writeKeypairFile,
} from "./helpers";

useCleanEnvironment();

const BONDS = contractAddress(40);
const CONVICTION = contractAddress(41);
const OPTIMISTIC = contractAddress(42);
const STRATEGIES = contractAddress(43);
const INDEXER_URL = "https://indexer.example.com";
const BACKEND_URL = "https://backend.example.com";

const config = {
  ...BASE_CONFIG,
  proposalBondsAddress: BONDS,
  convictionVotingAddress: CONVICTION,
  optimisticGovernorAddress: OPTIMISTIC,
  treasuryStrategiesAddress: STRATEGIES,
  indexerUrl: INDEXER_URL,
  backendUrl: BACKEND_URL,
};

describe("proposal-bonds", () => {
  it("list: passes the contract address, indexer URL and limit", async () => {
    const client = stubClient(ProposalBondsClient, {
      listBonds: jest.fn().mockResolvedValue({ data: [], pagination: { page: 1, limit: 5, hasMore: false } }),
    });

    await runCli(["proposal-bonds", "list", "--limit", "5"], config);

    expect(ProposalBondsClient).toHaveBeenCalledWith(
      expect.objectContaining({ proposalBondsAddress: BONDS, indexerUrl: INDEXER_URL, network: "testnet" }),
    );
    expect(client.listBonds).toHaveBeenCalledWith({ limit: 5 });
  });

  it("settings: reads the bond settings", async () => {
    stubClient(ProposalBondsClient, { getSettings: jest.fn().mockResolvedValue({ bondAmount: 5n }) });
    const result = await runCli(["proposal-bonds", "settings"], config);
    expect(result.json()).toEqual({ bondAmount: "5" });
  });

  it("reads the address from NEBGOV_PROPOSAL_BONDS_ADDRESS and requires it", async () => {
    stubClient(ProposalBondsClient, { getSettings: jest.fn().mockResolvedValue({}) });
    await expect(runCli(["proposal-bonds", "settings"])).rejects.toThrow(
      /Missing required config: proposalBondsAddress \(set NEBGOV_PROPOSAL_BONDS_ADDRESS/,
    );

    process.env.NEBGOV_PROPOSAL_BONDS_ADDRESS = BONDS;
    await runCli(["proposal-bonds", "settings"]);
    expect(ProposalBondsClient).toHaveBeenCalledWith(expect.objectContaining({ proposalBondsAddress: BONDS }));
  });

  it("list: validates --limit", async () => {
    await expect(runCli(["proposal-bonds", "list", "--limit", "many"], config)).rejects.toThrow(
      /limit must be a non-negative integer/,
    );
  });

  const BOND_TOKEN = contractAddress(44);
  const NEW_GOVERNOR = contractAddress(45);
  const settingsArgs = [
    "--bond-token",
    BOND_TOKEN,
    "--governor",
    NEW_GOVERNOR,
    "--refund-grace-ledgers",
    "100",
    "--max-lock-ledgers",
    "1000",
  ];

  it("update-settings: submits the parsed settings with the admin keypair", async () => {
    const client = stubClient(ProposalBondsClient, {
      updateSettings: jest.fn().mockResolvedValue("HASH1"),
    });

    const result = await runCli(
      ["proposal-bonds", "update-settings", ...settingsArgs, "--keypair", writeKeypairFile()],
      config,
    );

    const [signer, settings] = client.updateSettings.mock.calls[0];
    expect(signer.publicKey()).toBe(SIGNER.publicKey());
    expect(settings).toEqual({
      bondToken: BOND_TOKEN,
      governor: NEW_GOVERNOR,
      refundGraceLedgers: 100,
      maxLockLedgers: 1000,
    });
    expect(result.json()).toEqual({
      ok: true,
      ...settings,
      admin: SIGNER.publicKey(),
      hash: "HASH1",
    });
  });

  it("update-settings --dry-run prints the plan without submitting", async () => {
    const client = stubClient(ProposalBondsClient, { updateSettings: jest.fn() });

    const result = await runCli(
      ["--dry-run", "proposal-bonds", "update-settings", ...settingsArgs, "--keypair", "unused"],
      config,
    );

    expect(client.updateSettings).not.toHaveBeenCalled();
    expect(result.json()).toEqual({
      action: "proposal-bonds.update-settings",
      bondToken: BOND_TOKEN,
      governor: NEW_GOVERNOR,
      refundGraceLedgers: 100,
      maxLockLedgers: 1000,
    });
  });

  it("update-settings: rejects a max lock that does not exceed the grace window", async () => {
    const client = stubClient(ProposalBondsClient, { updateSettings: jest.fn() });
    const args = [...settingsArgs];
    args[args.indexOf("--max-lock-ledgers") + 1] = "100";

    await expect(
      runCli(["proposal-bonds", "update-settings", ...args, "--keypair", writeKeypairFile()], config),
    ).rejects.toThrow("max-lock-ledgers must be greater than refund-grace-ledgers");
    expect(client.updateSettings).not.toHaveBeenCalled();
  });

  it("set-admin: hands the admin role to the given address", async () => {
    const client = stubClient(ProposalBondsClient, { setAdmin: jest.fn().mockResolvedValue("HASH2") });

    const result = await runCli(
      ["proposal-bonds", "set-admin", OTHER_ACCOUNT, "--keypair", writeKeypairFile()],
      config,
    );

    const [signer, newAdmin] = client.setAdmin.mock.calls[0];
    expect(signer.publicKey()).toBe(SIGNER.publicKey());
    expect(newAdmin).toBe(OTHER_ACCOUNT);
    expect(result.json()).toEqual({
      ok: true,
      admin: SIGNER.publicKey(),
      newAdmin: OTHER_ACCOUNT,
      hash: "HASH2",
    });
  });

  it("set-admin: validates the new admin address", async () => {
    stubClient(ProposalBondsClient, { setAdmin: jest.fn() });
    await expect(
      runCli(["proposal-bonds", "set-admin", "nobody", "--keypair", writeKeypairFile()], config),
    ).rejects.toThrow(/new-admin must be a Stellar account/);
  });
});

describe("conviction-voting", () => {
  it("proposal and history: parse the id and target the conviction contract", async () => {
    const client = stubClient(ConvictionVotingClient, {
      getProposal: jest.fn().mockResolvedValue({ id: 2 }),
      getConvictionHistory: jest.fn().mockResolvedValue([]),
    });

    await runCli(["conviction-voting", "proposal", "2"], config);
    await runCli(["conviction-voting", "history", "2"], config);

    expect(ConvictionVotingClient).toHaveBeenCalledWith(
      expect.objectContaining({ convictionVotingAddress: CONVICTION }),
    );
    expect(client.getProposal).toHaveBeenCalledWith(2);
    expect(client.getConvictionHistory).toHaveBeenCalledWith(2);
  });

  it("rejects bad ids and missing config", async () => {
    await expect(runCli(["conviction-voting", "proposal", "2.5"], config)).rejects.toThrow(/id must be/);
    await expect(runCli(["conviction-voting", "history", "2"])).rejects.toThrow(
      /Missing required config: convictionVotingAddress/,
    );
  });
});

describe("optimistic-governor", () => {
  it("list: normalises --status to the contract's state name", async () => {
    const client = stubClient(OptimisticGovernorClient, { listProposals: jest.fn().mockResolvedValue([]) });

    await runCli(["optimistic-governor", "list", "--status", "challengewindow"], config);
    await runCli(["optimistic-governor", "list"], config);

    expect(OptimisticGovernorClient).toHaveBeenCalledWith(
      expect.objectContaining({ optimisticGovernorAddress: OPTIMISTIC }),
    );
    expect(client.listProposals).toHaveBeenNthCalledWith(1, "ChallengeWindow");
    expect(client.listProposals).toHaveBeenNthCalledWith(2, undefined);
  });

  it("list: rejects an unknown status", async () => {
    await expect(runCli(["optimistic-governor", "list", "--status", "open"], config)).rejects.toThrow(
      /status must be one of: ChallengeWindow, Objected, Passed, Executed, Cancelled/,
    );
  });

  it("get and config: read from the optimistic governor", async () => {
    const client = stubClient(OptimisticGovernorClient, {
      getProposal: jest.fn().mockResolvedValue({ id: 4n }),
      getConfig: jest.fn().mockResolvedValue({ challengeWindow: 100 }),
    });

    const proposal = await runCli(["optimistic-governor", "get", "4"], config);
    const settings = await runCli(["optimistic-governor", "config"], config);

    expect(client.getProposal).toHaveBeenCalledWith(4);
    expect(proposal.json()).toEqual({ id: "4" });
    expect(settings.json()).toEqual({ challengeWindow: 100 });
  });

  it("requires the optimistic governor address", async () => {
    await expect(runCli(["optimistic-governor", "config"])).rejects.toThrow(
      /Missing required config: optimisticGovernorAddress/,
    );
  });
});

describe("treasury-strategies", () => {
  it("list and get: target the strategies contract via the indexer", async () => {
    const client = stubClient(TreasuryStrategiesClient, {
      listStrategies: jest.fn().mockResolvedValue([]),
      getStrategy: jest.fn().mockResolvedValue({ id: 1 }),
    });

    await runCli(["treasury-strategies", "list", "--limit", "3"], config);
    await runCli(["treasury-strategies", "get", "1"], config);

    expect(TreasuryStrategiesClient).toHaveBeenCalledWith(
      expect.objectContaining({ treasuryStrategiesAddress: STRATEGIES, indexerUrl: INDEXER_URL }),
    );
    expect(client.listStrategies).toHaveBeenCalledWith({ limit: 3 });
    expect(client.getStrategy).toHaveBeenCalledWith(1);
  });

  it("validates ids and requires the strategies address", async () => {
    await expect(runCli(["treasury-strategies", "get", "x"], config)).rejects.toThrow(/id must be/);
    await expect(runCli(["treasury-strategies", "list"])).rejects.toThrow(
      /Missing required config: treasuryStrategiesAddress/,
    );
  });
});

describe("signaling-polls", () => {
  it("list, get and results: go through the configured backend", async () => {
    const client = stubClient(SignalingClient, {
      listPolls: jest.fn().mockResolvedValue([]),
      getPoll: jest.fn().mockResolvedValue({ id: 6 }),
      getResults: jest.fn().mockResolvedValue({ totals: [1n, 2n] }),
    });

    await runCli(["signaling-polls", "list", "--status", "ACTIVE"], config);
    await runCli(["signaling-polls", "get", "6"], config);
    const results = await runCli(["signaling-polls", "results", "6"], config);

    expect(SignalingClient).toHaveBeenCalledWith(expect.objectContaining({ backendUrl: BACKEND_URL }));
    expect(client.listPolls).toHaveBeenCalledWith("active");
    expect(client.getPoll).toHaveBeenCalledWith(6);
    expect(client.getResults).toHaveBeenCalledWith(6);
    expect(results.json()).toEqual({ totals: ["1", "2"] });
  });

  it("rejects an unknown status and a missing backend URL", async () => {
    await expect(runCli(["signaling-polls", "list", "--status", "open"], config)).rejects.toThrow(
      'status must be one of: active, closed (got "open")',
    );
    await expect(runCli(["signaling-polls", "list"])).rejects.toThrow(
      /Missing required config: backendUrl \(set NEBGOV_BACKEND_URL/,
    );
  });
});
