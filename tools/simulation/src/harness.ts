import { createHash } from "node:crypto";
import { Address, BASE_FEE, Contract, Keypair, nativeToScVal, SorobanRpc, scValToNative, TransactionBuilder } from "@stellar/stellar-sdk";
import {
  CoSponsorshipClient,
  ConvictionVotingClient,
  GovernorClient,
  GovernorConfig,
  Network,
  OptimisticGovernorClient,
  ProposalBondsClient,
  TimelockClient,
  TreasuryClient,
  VoteType,
  VotesClient,
  getNetworkPassphrase,
  getRpcUrl,
} from "@nebgov/sdk";
import { LedgerClock } from "./ledger";
import { Actor, ActorSet } from "./actors";
import { ConvictionExecutionRecord, GovernorSettingsState, MockLedgerStore } from "./mock/store";
import { MockSorobanServer } from "./mock/server";
import { setActiveMockServer } from "./mock/registry";
import { applyDelegation, seedBalances } from "./mock/token-votes-executor";
import { BaseScenario, SimulationResult } from "./scenarios/base";

export interface GovernorSimulationSettings {
  votingDelay: number;
  votingPeriod: number;
  quorumNumerator: number;
  proposalThreshold: bigint;
  /** Timelock minimum delay, in seconds. */
  timelockDelay: bigint;
  /** Timelock execution window, in seconds. Defaults to 14 days. */
  executionWindow?: bigint;
  voteType: VoteType;
  /** Address authorized to veto proposals. Defaults to a deterministic synthetic guardian. */
  guardian?: string;
  /** Ledgers a Succeeded-but-unqueued proposal has before it expires. Defaults to 120_960 (~7 days). */
  proposalGracePeriod?: number;
  /** Whether quorum is derived from an oracle-backed USD floor. */
  useDynamicQuorum?: boolean;
  /** Reflector oracle contract used for dynamic quorum. */
  reflectorOracle?: string | null;
  /** Minimum USD quorum amount when dynamic quorum is enabled. */
  minQuorumUsd?: bigint;
  /** Minimum ledgers between proposals from the same proposer. Defaults to 100. */
  proposalCooldown?: number;
  /** Maximum proposals per proposer per period. Defaults to 5. */
  maxProposalsPerPeriod?: number;
  /** Period length in ledgers for the max-proposals-per-period cap. Defaults to 10_000. */
  proposalPeriodDuration?: number;
  /** Maximum calldata size per action in bytes. Defaults to 10_000. */
  maxCalldataSize?: number;
  /** Address authorized to pause/unpause the contract. Defaults to the guardian. */
  pauser?: string;
  /** Optimistic-governor challenge window, in ledgers. Defaults to 17_280 (~1 day). */
  optimisticChallengeWindowLedgers?: number;
  /** Objection threshold in basis points of past total supply. Defaults to 1000 (10%). */
  optimisticObjectionThresholdBps?: number;
  /** Optimistic proposer bond; the mock models only a disabled (0) bond. Defaults to 0. */
  optimisticProposerBondAmount?: bigint;
  /** Optimistic proposer bond token address. Defaults to the votes contract. */
  optimisticProposerBondToken?: string;
  /** Amount `lock_bond` posts per proposal on the proposal-bonds registry. Defaults to 10_000. */
  proposalBondAmount?: bigint;
  /** Token the proposal-bonds registry is denominated in. Defaults to the votes contract. */
  proposalBondToken?: string;
  /**
   * Ledgers after a correlated proposal's `end_ledger` during which
   * `refund_bond` is blocked, giving a `slash` governance proposal time to
   * land first. Defaults to 2_000.
   */
  proposalRefundGraceLedgers?: number;
  /**
   * Ledgers after `lock_bond` after which `refund_bond` succeeds
   * unconditionally. Defaults to 1_000_000, mirroring the contract's
   * `BOND_TTL_LEDGERS`.
   */
  proposalMaxLockLedgers?: number;
}

/** Parameters the conviction-voting track boots with (mirrors `contracts/conviction-voting`'s `initialize`). */
export interface ConvictionSimulationSettings {
  /** Per-ledger conviction decay, in bps of the retained score. Defaults to 9_000. */
  decayBps: number;
  /** Largest share of total supply a proposal may request, in bps. Defaults to 2_000 (20%). */
  maxRatioBps: number;
  /** Conviction floor for a proposal requesting a zero amount. Defaults to 100n. */
  minThresholdConviction: bigint;
  /** Accrual weight applied to staked power, in bps. Defaults to 10_000. */
  weightBps: number;
}

export interface SimulationConfig {
  /** Whether to run against the built-in mock Soroban runtime or a live/testnet RPC. */
  mode: "mock" | "testnet";
  settings: GovernorSimulationSettings;
  /** Initial token holders: address -> raw token amount. */
  tokenBalances: Record<string, bigint>;
  /** Delegation map: delegator -> delegatee (self-delegation activates voting power). */
  delegations: Record<string, string>;
  /** Starting ledger sequence number. Defaults to 1000. */
  initialLedger?: number;
  /**
   * Address authorized to sign the treasury contract's governance-gated stream
   * calls (`create_stream`, `top_up_stream`). Defaults to the governor contract
   * address, which the SDK's signer-based `TreasuryClient` writes cannot
   * satisfy — set it to an actor's public key to drive streams directly.
   */
  treasuryGovernor?: string;
  /**
   * Balance credited to the treasury contract on the single token ledger the
   * mock models, so stream spends have funds to debit. Defaults to 0.
   */
  treasuryBalance?: bigint;
  /** Conviction-voting track parameters. Defaults mirror the contract's own test fixture. */
  conviction?: Partial<ConvictionSimulationSettings>;
  /** Required when mode === "testnet". */
  rpcUrl?: string;
  network?: Network;
}

export interface DeployedContracts {
  governor: string;
  timelock: string;
  votes: string;
  coSponsorship: string;
  optimisticGovernor: string;
  treasury: string;
  convictionVoting: string;
  proposalBonds: string;
}

interface ClockSnapshot {
  current: number;
  genesisTimestamp: number;
}

export interface ContractStateSnapshot {
  store: MockLedgerStore;
  clock: ClockSnapshot;
}

const DEFAULT_EXECUTION_WINDOW = 1_209_600n; // 14 days, matches contracts/timelock's own default.
const DEFAULT_GRACE_PERIOD = 120_960; // ~7 days at 5s/ledger.
const DEFAULT_COOLDOWN = 100;
const DEFAULT_MAX_PER_PERIOD = 5;
const DEFAULT_PERIOD_DURATION = 10_000;
const DEFAULT_MAX_CALLDATA_SIZE = 10_000;
const DEFAULT_OPTIMISTIC_CHALLENGE_WINDOW = 17_280; // ~1 day at 5s/ledger.
const DEFAULT_OPTIMISTIC_OBJECTION_THRESHOLD_BPS = 1000; // 10% of past total supply.
const DEFAULT_CONVICTION_DECAY_BPS = 9_000;
const DEFAULT_CONVICTION_MAX_RATIO_BPS = 2_000;
const DEFAULT_CONVICTION_MIN_THRESHOLD = 100n;
const DEFAULT_CONVICTION_WEIGHT_BPS = 10_000;
const DEFAULT_PROPOSAL_BOND_AMOUNT = 10_000n;
const DEFAULT_PROPOSAL_REFUND_GRACE_LEDGERS = 2_000;
const DEFAULT_PROPOSAL_MAX_LOCK_LEDGERS = 1_000_000; // mirrors contracts/proposal-bonds' BOND_TTL_LEDGERS.
const DEFAULT_GUARDIAN = Keypair.fromRawEd25519Seed(
  createHash("sha256").update("nebgov-simulation-actor:default-guardian").digest(),
).publicKey();
// Read-only simulation calls (getSettings, getProposalState, ...) build a
// throwaway transaction and need a valid classic ("G...") source account —
// contract addresses aren't valid transaction sources. `@nebgov/sdk`
// defaults to the governor's own (contract) address unless a
// `simulationAccount` is configured, so the harness always supplies one.
const SIMULATION_ACCOUNT = Keypair.fromRawEd25519Seed(
  createHash("sha256").update("nebgov-simulation-actor:simulation-account").digest(),
).publicKey();

function contractAddress(marker: number): string {
  return Address.contract(Buffer.alloc(32, marker)).toString();
}

export class SimulationHarness {
  readonly clock: LedgerClock;
  readonly actors = new Map<string, Actor>();
  readonly config: SimulationConfig;

  governorClient!: GovernorClient;
  coSponsorshipClient!: CoSponsorshipClient;
  timelockClient!: TimelockClient;
  votesClient!: VotesClient;
  optimisticGovernorClient!: OptimisticGovernorClient;
  treasuryClient!: TreasuryClient;
  convictionClient!: ConvictionVotingClient;
  proposalBondsClient!: ProposalBondsClient;

  /** Conviction-voting track parameters the harness booted with. */
  convictionSettings!: ConvictionSimulationSettings;

  private store!: MockLedgerStore;
  private mockServer?: MockSorobanServer;
  /** Addresses returned by `boot()`, also handy for scenarios that need them mid-run. */
  addresses!: DeployedContracts;

  constructor(config: SimulationConfig) {
    if (config.mode === "testnet" && !config.rpcUrl) {
      throw new Error("SimulationConfig.rpcUrl is required when mode is 'testnet'");
    }
    this.config = config;
    this.clock = new LedgerClock(config.initialLedger ?? 1000);
  }

  /** Register actors (e.g. from `createActors()`) so scenarios/tests can look them up by name. */
  registerActors(actorSet: ActorSet): void {
    for (const [name, actor] of actorSet.all) {
      this.actors.set(name, actor);
    }
  }

  private buildSettingsState(): GovernorSettingsState {
    const s = this.config.settings;
    const guardian = s.guardian ?? DEFAULT_GUARDIAN;
    return {
      votingDelay: s.votingDelay,
      votingPeriod: s.votingPeriod,
      quorumNumerator: s.quorumNumerator,
      proposalThreshold: s.proposalThreshold,
      guardian,
      voteType: s.voteType,
      proposalGracePeriod: s.proposalGracePeriod ?? DEFAULT_GRACE_PERIOD,
      useDynamicQuorum: s.useDynamicQuorum ?? false,
      reflectorOracle: s.reflectorOracle ?? null,
      minQuorumUsd: s.minQuorumUsd ?? 0n,
      proposalCooldown: s.proposalCooldown ?? DEFAULT_COOLDOWN,
      maxProposalsPerPeriod: s.maxProposalsPerPeriod ?? DEFAULT_MAX_PER_PERIOD,
      proposalPeriodDuration: s.proposalPeriodDuration ?? DEFAULT_PERIOD_DURATION,
      maxCalldataSize: s.maxCalldataSize ?? DEFAULT_MAX_CALLDATA_SIZE,
      isPaused: false,
      pauser: s.pauser ?? guardian,
    };
  }

  private buildStore(): MockLedgerStore {
    const addresses = this.addresses;
    const store: MockLedgerStore = {
      addresses,
      governor: {
        settings: this.buildSettingsState(),
        proposals: new Map(),
        proposalCount: 0n,
        queueTime: new Map(),
        lastProposalLedger: new Map(),
        proposalsInPeriod: new Map(),
      },
      timelock: {
        minDelay: this.config.settings.timelockDelay,
        executionWindow: this.config.settings.executionWindow ?? DEFAULT_EXECUTION_WINDOW,
        operations: new Map(),
        dependencies: new Map(),
      },
      votes: {
        balances: new Map(),
        delegates: new Map(),
        checkpoints: new Map(),
        totalSupplyCheckpoints: [],
      },
      coSponsorship: {
        drafts: new Map(),
        draftCount: 0n,
      },
      optimisticGovernor: {
        admin: this.config.settings.guardian ?? DEFAULT_GUARDIAN,
        votesToken: this.addresses.votes,
        challengeWindowLedgers:
          this.config.settings.optimisticChallengeWindowLedgers ?? DEFAULT_OPTIMISTIC_CHALLENGE_WINDOW,
        objectionThresholdBps:
          this.config.settings.optimisticObjectionThresholdBps ?? DEFAULT_OPTIMISTIC_OBJECTION_THRESHOLD_BPS,
        proposerBondAmount: this.config.settings.optimisticProposerBondAmount ?? 0n,
        proposerBondToken: this.config.settings.optimisticProposerBondToken ?? this.addresses.votes,
        proposals: new Map(),
        proposalCount: 0n,
        objectorVoted: new Set(),
      },
      treasury: {
        governor: this.config.treasuryGovernor ?? this.addresses.governor,
        streams: new Map(),
        streamCount: 0n,
        spends: new Map(),
        tokenList: [],
        totalStreamedByToken: new Map(),
        totalSpentByToken: new Map(),
      },
      convictionVoting: {
        admin: this.config.settings.guardian ?? DEFAULT_GUARDIAN,
        votesToken: this.addresses.votes,
        decayBps: this.config.conviction?.decayBps ?? DEFAULT_CONVICTION_DECAY_BPS,
        maxRatioBps: this.config.conviction?.maxRatioBps ?? DEFAULT_CONVICTION_MAX_RATIO_BPS,
        minThresholdConviction: this.config.conviction?.minThresholdConviction ?? DEFAULT_CONVICTION_MIN_THRESHOLD,
        weightBps: this.config.conviction?.weightBps ?? DEFAULT_CONVICTION_WEIGHT_BPS,
        nextProposalId: 1n,
        proposals: new Map(),
        stakes: new Map(),
        totalStaked: new Map(),
        stakeByStaker: new Map(),
        executions: [],
      },
      proposalBonds: {
        admin: this.config.settings.guardian ?? DEFAULT_GUARDIAN,
        bondToken: this.config.settings.proposalBondToken ?? this.addresses.votes,
        bondAmount: this.config.settings.proposalBondAmount ?? DEFAULT_PROPOSAL_BOND_AMOUNT,
        governor: this.addresses.governor,
        refundGraceLedgers:
          this.config.settings.proposalRefundGraceLedgers ?? DEFAULT_PROPOSAL_REFUND_GRACE_LEDGERS,
        maxLockLedgers:
          this.config.settings.proposalMaxLockLedgers ?? DEFAULT_PROPOSAL_MAX_LOCK_LEDGERS,
        bonds: new Map(),
      },
    };

    seedBalances(store.votes, this.config.tokenBalances);
    // Stream spends debit this account on the one ledger the mock models.
    store.votes.balances.set(addresses.treasury, this.config.treasuryBalance ?? 0n);
    for (const [delegator, delegatee] of Object.entries(this.config.delegations)) {
      applyDelegation(store.votes, this.clock, delegator, delegatee);
    }

    return store;
  }

  /** Boot the harness: seed state and (in mock mode) intercept Soroban RPC construction. */
  async boot(): Promise<DeployedContracts> {
    this.addresses = {
      governor: contractAddress(1),
      timelock: contractAddress(2),
      votes: contractAddress(3),
      coSponsorship: contractAddress(4),
      optimisticGovernor: contractAddress(5),
      treasury: contractAddress(6),
      convictionVoting: contractAddress(7),
      proposalBonds: contractAddress(8),
    };
    this.store = this.buildStore();
    this.convictionSettings = {
      decayBps: this.store.convictionVoting.decayBps,
      maxRatioBps: this.store.convictionVoting.maxRatioBps,
      minThresholdConviction: this.store.convictionVoting.minThresholdConviction,
      weightBps: this.store.convictionVoting.weightBps,
    };

    const clientConfig: GovernorConfig = {
      governorAddress: this.addresses.governor,
      timelockAddress: this.addresses.timelock,
      votesAddress: this.addresses.votes,
      coSponsorshipAddress: this.addresses.coSponsorship,
      network: this.config.network ?? "testnet",
      rpcUrl: this.config.mode === "testnet" ? this.config.rpcUrl : "https://mock.invalid",
      simulationAccount: this.config.mode === "mock" ? SIMULATION_ACCOUNT : undefined,
      proposalBondsAddress: this.addresses.proposalBonds,
      maxAttempts: 1,
    };

    if (this.config.mode === "mock") {
      this.mockServer = new MockSorobanServer(this.store, this.clock);
      setActiveMockServer(this.mockServer);
    }

    this.governorClient = new GovernorClient(clientConfig);
    this.coSponsorshipClient = new CoSponsorshipClient(clientConfig);
    this.timelockClient = new TimelockClient(clientConfig);
    this.votesClient = new VotesClient(clientConfig);
    this.optimisticGovernorClient = new OptimisticGovernorClient({
      optimisticGovernorAddress: this.addresses.optimisticGovernor,
      network: clientConfig.network,
      rpcUrl: clientConfig.rpcUrl,
      simulationAccount: clientConfig.simulationAccount,
      maxAttempts: 1,
    });
    this.treasuryClient = new TreasuryClient({
      treasuryAddress: this.addresses.treasury,
      network: clientConfig.network,
      rpcUrl: clientConfig.rpcUrl,
      simulationAccount: clientConfig.simulationAccount,
      maxAttempts: 1,
    });
    this.convictionClient = new ConvictionVotingClient({
      convictionVotingAddress: this.addresses.convictionVoting,
      network: clientConfig.network,
      rpcUrl: clientConfig.rpcUrl,
      simulationAccount: clientConfig.simulationAccount,
      maxAttempts: 1,
    });
    this.proposalBondsClient = new ProposalBondsClient(clientConfig);

    return this.addresses;
  }

  /** Advance the simulated ledger by `n` ledgers. */
  async advanceLedgers(n: number): Promise<void> {
    this.clock.advance(n);
  }

  /**
   * Run a scenario against this harness.
   *
   * The return type is narrowed to the scenario's own `run()` result, so
   * scenarios that expose extra fields (e.g. the treasury scenario's
   * `streamId`) stay typed.
   */
  async run<T extends BaseScenario, A extends unknown[]>(
    ScenarioClass: new (harness: SimulationHarness, ...args: A) => T,
    ...args: A
  ): Promise<Awaited<ReturnType<T["run"]>>> {
    const scenario = new ScenarioClass(this, ...args);
    // `scenario.run()` is exactly `T["run"]`; TS just cannot see that through
    // the `BaseScenario` constraint on `T`.
    return scenario.run() as Promise<Awaited<ReturnType<T["run"]>>>;
  }

  /**
   * Invoke `cancel_queued` on the governor contract — a guardian veto of a
   * queued proposal. Not yet wrapped by `@nebgov/sdk`'s `GovernorClient`, so
   * built the same way the SDK's own write methods build theirs.
   */
  async cancelQueuedProposal(guardian: Keypair, proposalId: bigint): Promise<void> {
    await this.invokeGovernorCancel("cancel_queued", guardian, proposalId);
  }

  /**
   * Invoke `cancel` on the governor contract — a guardian cancelling a
   * currently-`Active` proposal (also how a proposer cancels a `Pending`
   * one). Not yet wrapped by `@nebgov/sdk`'s `GovernorClient`.
   */
  async cancelProposalViaGuardian(guardian: Keypair, proposalId: bigint): Promise<void> {
    await this.invokeGovernorCancel("cancel", guardian, proposalId);
  }

  /** Shared plumbing for the guardian-gated `cancel`/`cancel_queued` writes. */
  private async invokeGovernorCancel(
    fnName: "cancel" | "cancel_queued",
    guardian: Keypair,
    proposalId: bigint,
  ): Promise<void> {
    const server = this.governorClient.server;
    const contract = this.governorClient.contract;
    const account = await server.getAccount(guardian.publicKey());
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.governorClient.networkPassphrase,
    })
      .addOperation(
        contract.call(
          fnName,
          nativeToScVal(guardian.publicKey(), { type: "address" }),
          nativeToScVal(proposalId, { type: "u64" }),
        ),
      )
      .setTimeout(30)
      .build();

    const prepared = await server.prepareTransaction(tx);
    prepared.sign(guardian);

    const result = await server.sendTransaction(prepared);
    if (result.status === "ERROR") {
      throw new Error(`${fnName} failed: ${JSON.stringify(result)}`);
    }
    await this.governorClient.pollForConfirmation(result.hash);
  }

  /**
   * Self-executions recorded by the conviction-voting track (mock mode only).
   * The mock models `checkpoint_conviction`'s target invocation the same way
   * the timelock executor models `execute()` — as a recorded call rather than
   * a dispatched cross-contract invoke.
   */
  getConvictionExecutions(): ConvictionExecutionRecord[] {
    if (this.config.mode !== "mock") {
      throw new Error("getConvictionExecutions() is only supported in mock mode");
    }
    return [...this.store.convictionVoting.executions];
  }

  /**
   * Read a conviction proposal's stake list. `ConvictionVotingClient` does not
   * wrap `get_stakes`, so this builds the read the same way the SDK's own read
   * paths do and decodes the simulated return value.
   */
  async getConvictionStakes(
    proposalId: number,
    offset = 0,
    limit = 100,
  ): Promise<Array<{ staker: string; proposalId: bigint; amount: bigint }>> {
    const server = new SorobanRpc.Server(
      getRpcUrl(this.config.network ?? "testnet", this.config.mode === "testnet" ? this.config.rpcUrl : "https://mock.invalid"),
    );
    const contract = new Contract(this.addresses.convictionVoting);
    const account = await server.getAccount(SIMULATION_ACCOUNT);
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: getNetworkPassphrase(this.config.network ?? "testnet"),
    })
      .addOperation(
        contract.call(
          "get_stakes",
          nativeToScVal(BigInt(proposalId), { type: "u64" }),
          nativeToScVal(BigInt(offset), { type: "u64" }),
          nativeToScVal(BigInt(limit), { type: "u64" }),
        ),
      )
      .setTimeout(30)
      .build();
    const simulated = await server.simulateTransaction(tx);
    const parsed = simulated as { error?: string; result?: { retval?: unknown } };
    if (parsed.error || !parsed.result?.retval) {
      throw new Error(`get_stakes simulation failed: ${parsed.error ?? "no return value"}`);
    }
    const native = scValToNative(parsed.result.retval as Parameters<typeof scValToNative>[0]) as Array<{
      staker: string;
      proposal_id: bigint;
      amount: bigint;
    }>;
    return native.map((entry) => ({
      staker: entry.staker,
      proposalId: entry.proposal_id,
      amount: entry.amount,
    }));
  }

  /** Snapshot full contract state for later deterministic replay. */
  async snapshot(): Promise<ContractStateSnapshot> {
    if (this.config.mode !== "mock") {
      throw new Error("snapshot() is only supported in mock mode");
    }
    return {
      store: structuredClone(this.store),
      clock: this.clock.snapshot(),
    };
  }

  /** Restore a previously captured snapshot. */
  async restore(snap: ContractStateSnapshot): Promise<void> {
    if (this.config.mode !== "mock") {
      throw new Error("restore() is only supported in mock mode");
    }
    this.store = structuredClone(snap.store);
    this.clock.restore(snap.clock);
    this.mockServer?.setStore(this.store);
  }

  /** Tear down the harness, releasing it as the active mock Soroban RPC target. */
  async teardown(): Promise<void> {
    if (this.mockServer) {
      setActiveMockServer(undefined);
      this.mockServer = undefined;
    }
  }
}
