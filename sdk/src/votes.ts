import {
  Contract,
  SorobanRpc,
  TransactionBuilder,
  BASE_FEE,
  Keypair,
  nativeToScVal,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import {
  GovernorConfig,
  DelegateInfo,
  TopDelegate,
  VotingPowerDistribution,
  DelegatorInfo,
  VotesSettings,
  DelegatorRecord,
  DelegationEntry,
  DelegationHistoryEntry,
  RegistryDelegatorInfo,
  DelegateProfile,
  SplitDelegation,
} from "./types";
import { VotesError, VotesErrorCode, parseVotesError } from "./errors";
import { createRetry, isNetworkError, type RetryFunction } from "./utils";
import { getRpcUrl, getNetworkPassphrase } from "./network";

/**
 * Ledger window used when no fromLedger is specified for analytics queries.
 * 17,280 ledgers ≈ 24 hours at ~5 s/ledger on testnet.
 */
const DEFAULT_SCAN_WINDOW = 17_280;

/**
 * VotesClient — interact with the token-votes contract.
 * Handles delegation, voting power queries, and governance health analytics.
 */
export class VotesClient {
  private readonly server: SorobanRpc.Server;
  private readonly contract: Contract;
  private readonly networkPassphrase: string;
  private readonly retry: RetryFunction;

  constructor(private readonly config: GovernorConfig) {
    const rpcUrl = getRpcUrl(config.network, config.rpcUrl);
    this.server = new SorobanRpc.Server(rpcUrl, { allowHttp: false });
    this.contract = new Contract(config.votesAddress);
    this.networkPassphrase = getNetworkPassphrase(config.network);
    this.retry = createRetry(config, { retryOn: isNetworkError });
  }

  private isRetryableSubmissionError(e: unknown): boolean {
    if (isNetworkError(e)) return true;
    if (e instanceof VotesError) {
      // Don't retry on contract logic errors (codes < 100)
      return (
        e.code >= 100 &&
        e.code !== VotesErrorCode.TransactionFailed &&
        e.code !== VotesErrorCode.DelegationFailed
      );
    }
    const msg = String(e);
    if (msg.includes("TransactionAlreadyInMempool")) return false;
    return false;
  }

  /**
   * Explicitly revoke delegation and move voting power back to self.
   *
   * @returns The Stellar transaction hash, suitable for linking to a block explorer.
   */
  async undelegate(signer: Keypair): Promise<string> {
    return this.retry(async () => {
      const account = await this.server.getAccount(signer.publicKey());

      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          this.contract.call(
            "undelegate",
            nativeToScVal(signer.publicKey(), { type: "address" }),
          ),
        )
        .setTimeout(30)
        .build();

      const prepared = await this.server.prepareTransaction(tx);
      prepared.sign(signer);
      const result = await this.server.sendTransaction(prepared);
      if (result.status === "ERROR") {
        throw parseVotesError(result);
      }
      return result.hash;
    }, (e) => this.isRetryableSubmissionError(e));
  }

  /**
   * Backwards-compatible alias for {@link undelegate}.
   *
   * @returns The Stellar transaction hash, suitable for linking to a block explorer.
   */
  async revokeDelegation(signer: Keypair): Promise<string> {
    return this.undelegate(signer);
  }

  /**
   * Wallet-signing variant of {@link undelegate}: takes the signer's public
   * key plus a callback that signs an unsigned XDR envelope (e.g. a
   * wallet-kit `signTransaction`) instead of a raw Keypair. Mirrors
   * `submitWithSign` in `coSponsorship.ts`.
   *
   * @returns The Stellar transaction hash, suitable for linking to a block explorer.
   */
  async undelegateWithSign(
    signerPublicKey: string,
    signUnsignedXdr: (xdr: string) => Promise<string>,
  ): Promise<string> {
    return this.retry(async () => {
      const account = await this.server.getAccount(signerPublicKey);

      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          this.contract.call(
            "undelegate",
            nativeToScVal(signerPublicKey, { type: "address" }),
          ),
        )
        .setTimeout(30)
        .build();

      const prepared = await this.server.prepareTransaction(tx);
      const signedXdr = await signUnsignedXdr(prepared.toXDR());
      const signed = TransactionBuilder.fromXDR(signedXdr, this.networkPassphrase);

      const result = await this.server.sendTransaction(signed);
      if (result.status === "ERROR") {
        throw parseVotesError(result);
      }
      return result.hash;
    }, (e) => this.isRetryableSubmissionError(e));
  }

  /**
   * Delegate voting power to another address (or self-delegate to activate votes).
   *
   * @returns The Stellar transaction hash, suitable for linking to a block explorer.
   */
  async delegate(signer: Keypair, delegatee: string): Promise<string> {
    return this.retry(async () => {
      const account = await this.server.getAccount(signer.publicKey());

      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          this.contract.call(
            "delegate",
            nativeToScVal(signer.publicKey(), { type: "address" }),
            nativeToScVal(delegatee, { type: "address" }),
          ),
        )
        .setTimeout(30)
        .build();

      const prepared = await this.server.prepareTransaction(tx);
      prepared.sign(signer);
      const result = await this.server.sendTransaction(prepared);
      if (result.status === "ERROR") {
        throw parseVotesError(result);
      }
      return result.hash;
    }, (e) => this.isRetryableSubmissionError(e));
  }

  /**
   * Wallet-signing variant of {@link delegate}: takes the signer's public
   * key plus a callback that signs an unsigned XDR envelope (e.g. a
   * wallet-kit `signTransaction`) instead of a raw Keypair. Mirrors
   * `submitWithSign` in `coSponsorship.ts`.
   *
   * @returns The Stellar transaction hash, suitable for linking to a block explorer.
   */
  async delegateWithSign(
    signerPublicKey: string,
    delegatee: string,
    signUnsignedXdr: (xdr: string) => Promise<string>,
  ): Promise<string> {
    return this.retry(async () => {
      const account = await this.server.getAccount(signerPublicKey);

      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          this.contract.call(
            "delegate",
            nativeToScVal(signerPublicKey, { type: "address" }),
            nativeToScVal(delegatee, { type: "address" }),
          ),
        )
        .setTimeout(30)
        .build();

      const prepared = await this.server.prepareTransaction(tx);
      const signedXdr = await signUnsignedXdr(prepared.toXDR());
      const signed = TransactionBuilder.fromXDR(signedXdr, this.networkPassphrase);

      const result = await this.server.sendTransaction(signed);
      if (result.status === "ERROR") {
        throw parseVotesError(result);
      }
      return result.hash;
    }, (e) => this.isRetryableSubmissionError(e));
  }

  /**
   * Transfer voting tokens and delegate in one atomic transaction.
   * Auth is required only from `signer` (`from`).
   */
  async transferAndDelegate(
    signer: Keypair,
    to: string,
    amount: bigint,
    delegatee: string,
  ): Promise<void> {
    return this.retry(async () => {
      const account = await this.server.getAccount(signer.publicKey());

      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          this.contract.call(
            "transfer_and_delegate",
            nativeToScVal(signer.publicKey(), { type: "address" }),
            nativeToScVal(to, { type: "address" }),
            nativeToScVal(amount, { type: "i128" }),
            nativeToScVal(delegatee, { type: "address" }),
          ),
        )
        .setTimeout(30)
        .build();

      const prepared = await this.server.prepareTransaction(tx);
      prepared.sign(signer);
      const result = await this.server.sendTransaction(prepared);
      if (result.status === "ERROR") {
        throw parseVotesError(result);
      }
    }, (e) => this.isRetryableSubmissionError(e));
  }

  /**
   * Struct fields are serialized as a map sorted alphabetically by field
   * name (`delegatee` then `weight_bps`) — soroban-sdk's `#[contracttype]`
   * derive convention. Mirrors `permitToScVal` in delegation-sig.ts.
   */
  private splitDelegationToScVal(split: SplitDelegation): xdr.ScVal {
    return nativeToScVal(
      { delegatee: split.delegatee, weight_bps: split.weightBps },
      { type: { delegatee: ["symbol", "address"], weight_bps: ["symbol", "u32"] } },
    );
  }

  private parseSplitDelegation(native: Record<string, unknown>): SplitDelegation {
    return {
      delegatee: String(native.delegatee),
      weightBps: Number(native.weight_bps),
    };
  }

  /**
   * Delegate arbitrary basis-point percentages of the caller's voting power
   * across multiple delegatees at once (issue #994). `splits` must sum to
   * exactly 10000 (100%); see `delegate_split` in the token-votes contract
   * for the full validation rules. Replaces (not merges with) any prior
   * split or legacy single delegation.
   *
   * @returns The Stellar transaction hash.
   */
  async delegateSplit(signer: Keypair, splits: SplitDelegation[]): Promise<string> {
    return this.retry(async () => {
      const account = await this.server.getAccount(signer.publicKey());

      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          this.contract.call(
            "delegate_split",
            nativeToScVal(signer.publicKey(), { type: "address" }),
            xdr.ScVal.scvVec(splits.map((s) => this.splitDelegationToScVal(s))),
          ),
        )
        .setTimeout(30)
        .build();

      const prepared = await this.server.prepareTransaction(tx);
      prepared.sign(signer);
      const result = await this.server.sendTransaction(prepared);
      if (result.status === "ERROR") {
        throw parseVotesError(result);
      }
      return result.hash;
    }, (e) => this.isRetryableSubmissionError(e));
  }

  /**
   * Wallet-signing variant of {@link delegateSplit}: takes the signer's
   * public key plus a callback that signs an unsigned XDR envelope instead
   * of a raw Keypair. Mirrors {@link delegateWithSign}.
   *
   * @returns The Stellar transaction hash.
   */
  async delegateSplitWithSign(
    signerPublicKey: string,
    splits: SplitDelegation[],
    signUnsignedXdr: (xdr: string) => Promise<string>,
  ): Promise<string> {
    return this.retry(async () => {
      const account = await this.server.getAccount(signerPublicKey);

      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          this.contract.call(
            "delegate_split",
            nativeToScVal(signerPublicKey, { type: "address" }),
            xdr.ScVal.scvVec(splits.map((s) => this.splitDelegationToScVal(s))),
          ),
        )
        .setTimeout(30)
        .build();

      const prepared = await this.server.prepareTransaction(tx);
      const signedXdr = await signUnsignedXdr(prepared.toXDR());
      const signed = TransactionBuilder.fromXDR(signedXdr, this.networkPassphrase);

      const result = await this.server.sendTransaction(signed);
      if (result.status === "ERROR") {
        throw parseVotesError(result);
      }
      return result.hash;
    }, (e) => this.isRetryableSubmissionError(e));
  }

  /**
   * Revoke split delegation and return full voting power to the caller
   * across all previously-split entries (issue #994). No-op if the caller
   * has never delegated or is already self-delegated.
   *
   * @returns The Stellar transaction hash.
   */
  async undelegateSplit(signer: Keypair): Promise<string> {
    return this.retry(async () => {
      const account = await this.server.getAccount(signer.publicKey());

      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          this.contract.call(
            "undelegate_split",
            nativeToScVal(signer.publicKey(), { type: "address" }),
          ),
        )
        .setTimeout(30)
        .build();

      const prepared = await this.server.prepareTransaction(tx);
      prepared.sign(signer);
      const result = await this.server.sendTransaction(prepared);
      if (result.status === "ERROR") {
        throw parseVotesError(result);
      }
      return result.hash;
    }, (e) => this.isRetryableSubmissionError(e));
  }

  /**
   * Wallet-signing variant of {@link undelegateSplit}: takes the signer's
   * public key plus a callback that signs an unsigned XDR envelope instead
   * of a raw Keypair. Mirrors {@link undelegateWithSign}.
   *
   * @returns The Stellar transaction hash.
   */
  async undelegateSplitWithSign(
    signerPublicKey: string,
    signUnsignedXdr: (xdr: string) => Promise<string>,
  ): Promise<string> {
    return this.retry(async () => {
      const account = await this.server.getAccount(signerPublicKey);

      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          this.contract.call(
            "undelegate_split",
            nativeToScVal(signerPublicKey, { type: "address" }),
          ),
        )
        .setTimeout(30)
        .build();

      const prepared = await this.server.prepareTransaction(tx);
      const signedXdr = await signUnsignedXdr(prepared.toXDR());
      const signed = TransactionBuilder.fromXDR(signedXdr, this.networkPassphrase);

      const result = await this.server.sendTransaction(signed);
      if (result.status === "ERROR") {
        throw parseVotesError(result);
      }
      return result.hash;
    }, (e) => this.isRetryableSubmissionError(e));
  }

  /**
   * Get a delegator's current split delegations (issue #994). Falls back to
   * reporting a legacy single delegation (if any) as a single 100% entry, so
   * callers don't need to know which path the delegator used.
   */
  async getSplitDelegations(delegator: string): Promise<SplitDelegation[]> {
    return this.simulateRead(
      "get_split_delegations",
      [nativeToScVal(delegator, { type: "address" })],
      (raw) =>
        (scValToNative(raw) as Record<string, unknown>[]).map((e) => this.parseSplitDelegation(e)),
      [],
    );
  }

  /**
   * Get the current voting power of an address.
   *
   * @param account Stellar address to query.
   * @returns Raw voting-power units (divide by token decimals for display).
   *   Returns `0n` if the address has not self-delegated.
   */
  async getVotes(account: string): Promise<bigint> {
    return this.retry(async () => {
      const result = await this.server.simulateTransaction(
        new TransactionBuilder(await this.server.getAccount(this.readAccount(account)), {
          fee: BASE_FEE,
          networkPassphrase: this.networkPassphrase,
        })
          .addOperation(
            this.contract.call(
              "get_votes",
              nativeToScVal(account, { type: "address" }),
            ),
          )
          .setTimeout(30)
          .build(),
      );

      if (SorobanRpc.Api.isSimulationError(result)) return 0n;
      const raw = (result as SorobanRpc.Api.SimulateTransactionSuccessResponse)
        .result?.retval;
      return raw ? BigInt(scValToNative(raw)) : 0n;
    });
  }

  /**
   * Get voting power of an address at a past ledger sequence.
   *
   * @param account Stellar address to query.
   * @param ledger Ledger sequence number to query at.
   * @returns Raw voting-power units at the specified ledger, or `0n` on error.
   */
  async getPastVotes(account: string, ledger: number): Promise<bigint> {
    return this.retry(async () => {
      const result = await this.server.simulateTransaction(
        new TransactionBuilder(await this.server.getAccount(this.readAccount(account)), {
          fee: BASE_FEE,
          networkPassphrase: this.networkPassphrase,
        })
          .addOperation(
            this.contract.call(
              "get_past_votes",
              nativeToScVal(account, { type: "address" }),
              nativeToScVal(ledger, { type: "u32" }),
            ),
          )
          .setTimeout(30)
          .build(),
      );

      if (SorobanRpc.Api.isSimulationError(result)) return 0n;
      const raw = (result as SorobanRpc.Api.SimulateTransactionSuccessResponse)
        .result?.retval;
      return raw ? BigInt(scValToNative(raw)) : 0n;
    });
  }

  /**
   * Get current base voting power (raw tokens) of an address.
   */
  async getBaseVotes(account: string): Promise<bigint> {
    const result = await this.server.simulateTransaction(
      new TransactionBuilder(await this.server.getAccount(this.readAccount(account)), {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          this.contract.call(
            "get_base_votes",
            nativeToScVal(account, { type: "address" }),
          ),
        )
        .setTimeout(30)
        .build(),
    );

    if (SorobanRpc.Api.isSimulationError(result)) return 0n;
    const raw = (result as SorobanRpc.Api.SimulateTransactionSuccessResponse)
      .result?.retval;
    return raw ? BigInt(scValToNative(raw)) : 0n;
  }

  /**
   * Get base voting power at a past ledger sequence.
   */
  async getPastBaseVotes(account: string, ledger: number): Promise<bigint> {
    const result = await this.server.simulateTransaction(
      new TransactionBuilder(await this.server.getAccount(this.readAccount(account)), {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          this.contract.call(
            "get_past_base_votes",
            nativeToScVal(account, { type: "address" }),
            nativeToScVal(ledger, { type: "u32" }),
          ),
        )
        .setTimeout(30)
        .build(),
    );

    if (SorobanRpc.Api.isSimulationError(result)) return 0n;
    const raw = (result as SorobanRpc.Api.SimulateTransactionSuccessResponse)
      .result?.retval;
    return raw ? BigInt(scValToNative(raw)) : 0n;
  }

  /**
   * Get current delegatee of an account.
   */
  async getDelegatee(account: string): Promise<string | null> {
    return this.retry(async () => {
      const result = await this.server.simulateTransaction(
        new TransactionBuilder(await this.server.getAccount(this.readAccount(account)), {
          fee: BASE_FEE,
          networkPassphrase: this.networkPassphrase,
        })
          .addOperation(
            this.contract.call(
              "delegates",
              nativeToScVal(account, { type: "address" }),
            ),
          )
          .setTimeout(30)
          .build(),
      );

      if (SorobanRpc.Api.isSimulationError(result)) return null;
      const raw = (result as SorobanRpc.Api.SimulateTransactionSuccessResponse)
        .result?.retval;
      return raw ? (scValToNative(raw) as string) : null;
    });
  }

  /**
   * Get total supply of the voting token.
   */
  async getTotalSupply(): Promise<bigint> {
    return this.retry(async () => {
      const result = await this.server.simulateTransaction(
        new TransactionBuilder(
          await this.server.getAccount(this.readAccount()),
          { fee: BASE_FEE, networkPassphrase: this.networkPassphrase },
        )
          .addOperation(this.contract.call("total_supply"))
          .setTimeout(30)
          .build(),
      );

      if (SorobanRpc.Api.isSimulationError(result)) return 0n;
      const raw = (result as SorobanRpc.Api.SimulateTransactionSuccessResponse)
        .result?.retval;
      return raw ? BigInt(scValToNative(raw)) : 0n;
    });
  }

  /**
   * Get total delegated supply at a past ledger sequence.
   */
  async getPastTotalSupply(ledger: number): Promise<bigint> {
    return this.retry(async () => {
      const result = await this.server.simulateTransaction(
        new TransactionBuilder(
          await this.server.getAccount(this.readAccount()),
          { fee: BASE_FEE, networkPassphrase: this.networkPassphrase },
        )
          .addOperation(
            this.contract.call(
              "get_past_total_supply",
              nativeToScVal(ledger, { type: "u32" }),
            ),
          )
          .setTimeout(30)
          .build(),
      );

      if (SorobanRpc.Api.isSimulationError(result)) return 0n;
      const raw = (result as SorobanRpc.Api.SimulateTransactionSuccessResponse)
        .result?.retval;
      return raw ? BigInt(scValToNative(raw)) : 0n;
    });
  }

  /**
   * Get top N delegates sorted by current voting power.
   *
   * Scans `del_chsh` (delegate changed) events emitted by the token-votes
   * contract to discover all accounts that have ever delegated, then queries
   * their current voting power and returns the top `limit` entries.
   *
   * Backwards-compatible overload:
   * - `getTopDelegates(limit, fromLedger?)` returns `TopDelegate[]`
   *
   * Cursor-based overload:
   * - `getTopDelegates({ limit, fromLedger, cursor, maxEventsToScan, delegationMap })`
   *   returns `{ delegates, nextCursor, delegationMap }`
   *
   * The cursor is an opaque string produced by this method; callers should
   * persist and pass it back to scan only new events incrementally.
   */
  async getTopDelegates(
    limit: number,
    fromLedger?: number,
  ): Promise<TopDelegate[]>;
  async getTopDelegates(options?: TopDelegatesOptions): Promise<TopDelegatesResult>;
  async getTopDelegates(
    arg1?: number | TopDelegatesOptions,
    arg2?: number,
  ): Promise<TopDelegate[] | TopDelegatesResult> {
    // Legacy signature: (limit, fromLedger?)
    if (typeof arg1 === "number") {
      const { delegates } = await this.getTopDelegates({
        limit: arg1,
        fromLedger: arg2,
      });
      return delegates;
    }

    const options = arg1 ?? {};
    const limit = Math.max(1, Math.min(options.limit ?? 50, 100));
    const offset = Math.max(0, options.offset ?? 0);

    const delegationMap =
      options.delegationMap ??
      new Map<string, string>();

    const { nextCursor } = await this.buildDelegationMapIncremental({
      fromLedger: options.fromLedger,
      cursor: options.cursor,
      maxEventsToScan: options.maxEventsToScan,
      delegationMap,
    });

    if (delegationMap.size === 0) {
      const empty: TopDelegatesResult = {
        delegates: [],
        nextCursor,
        delegationMap,
      };
      return empty;
    }

    // Group delegators by their current delegatee
    const byDelegate = new Map<string, Set<string>>();
    for (const [delegator, delegatee] of delegationMap) {
      if (!byDelegate.has(delegatee)) byDelegate.set(delegatee, new Set());
      byDelegate.get(delegatee)!.add(delegator);
    }

    // Query current voting power in batches to avoid OOM on large delegate sets
    const delegateAddresses = Array.from(byDelegate.keys());
    const POWER_BATCH_SIZE = 20;
    const powerEntries: Array<{
      address: string;
      votingPower: bigint;
      baseVotes: bigint;
      delegatorCount: number;
    }> = [];

    for (let i = 0; i < delegateAddresses.length; i += POWER_BATCH_SIZE) {
      const batch = delegateAddresses.slice(i, i + POWER_BATCH_SIZE);
      const batchResults = await Promise.all(
        batch.map(async (addr) => {
          const [votingPower, baseVotes] = await Promise.all([
            this.getVotes(addr),
            this.getBaseVotes(addr),
          ]);
          return {
            address: addr,
            votingPower,
            baseVotes,
            delegatorCount: byDelegate.get(addr)!.size,
          };
        }),
      );
      powerEntries.push(...batchResults);
    }

    const delegates = powerEntries
      .filter((d) => d.votingPower > 0n)
      .sort((a, b) =>
        b.votingPower > a.votingPower
          ? 1
          : b.votingPower < a.votingPower
            ? -1
            : 0,
      )
      .slice(offset, offset + limit);

    const result: TopDelegatesResult = {
      delegates,
      nextCursor,
      delegationMap,
    };

    return result;
  }

  /**
   * Get voting power distribution statistics for governance health dashboards.
   *
   * Computes:
   * - `totalDelegated`  — sum of all actively-delegated voting power
   * - `totalSupply`     — total token supply from the contract
   * - `delegationRate`  — fraction of supply that is delegated (0–1)
   * - `giniCoefficient` — concentration of voting power (0 = equal, 1 = concentrated)
   *
   * @param fromLedger - Earliest ledger to scan events from.
   */
  async getVotingPowerDistribution(
    fromLedger?: number,
  ): Promise<VotingPowerDistribution> {
    const delegationMap = await this.buildDelegationMap(fromLedger);
    const totalSupply = await this.getTotalSupply();

    if (delegationMap.size === 0) {
      return {
        totalDelegated: 0n,
        totalSupply,
        delegationRate: 0,
        giniCoefficient: 0,
      };
    }

    // Group delegators by delegatee and query their voting power
    const byDelegate = new Map<string, Set<string>>();
    for (const [delegator, delegatee] of delegationMap) {
      if (!byDelegate.has(delegatee)) byDelegate.set(delegatee, new Set());
      byDelegate.get(delegatee)!.add(delegator);
    }

    const powers = await Promise.all(
      Array.from(byDelegate.keys()).map((addr) => this.getVotes(addr)),
    );

    const activePowers = powers.filter((p) => p > 0n);
    const totalDelegated = activePowers.reduce((sum, p) => sum + p, 0n);

    const delegationRate =
      totalSupply > 0n ? Number(totalDelegated) / Number(totalSupply) : 0;

    const giniCoefficient = computeGini(activePowers);

    return { totalDelegated, totalSupply, delegationRate, giniCoefficient };
  }

  /**
   * Get all accounts currently delegating to a specific delegate address.
   *
   * Scans `del_chsh` events to find every delegator whose most recent
   * delegation points to `delegateAddress`, then queries each delegator's
   * current voting power contribution.
   *
   * @param delegateAddress - Strkey address of the delegate to look up
   * @param fromLedger      - Earliest ledger to scan events from.
   */
  async getDelegators(
    delegateAddress: string,
    fromLedger?: number,
  ): Promise<DelegatorInfo[]> {
    const delegationMap = await this.buildDelegationMap(fromLedger);

    const delegators: string[] = [];
    for (const [delegator, delegatee] of delegationMap) {
      if (delegatee === delegateAddress) delegators.push(delegator);
    }

    if (delegators.length === 0) return [];

    const results: any[] = [];
    for (const delegator of delegators) {
      results.push({
        delegator,
        power: await this.getVotes(delegator),
      });
    }

    return results
      .filter((d) => d.power > 0n)
      .sort((a, b) => (b.power > a.power ? 1 : b.power < a.power ? -1 : 0));
  }

  /**
   * Get top delegates by voting power using a pre-supplied address list.
   *
   * Useful when you already have a known set of delegate addresses (e.g. from
   * an off-chain indexer) and want to rank them without scanning chain events.
   *
   * @param addresses - Known delegate addresses to query
   * @param limit     - Maximum number to return (default 20)
   */
  async getTopDelegatesByAddresses(
    addresses: string[],
    limit = 20,
  ): Promise<DelegateInfo[]> {
    const totalSupply = await this.getTotalSupply();
    if (totalSupply === 0n) return [];

    const delegates: any[] = [];
    for (const address of addresses) {
      const votes = await this.getVotes(address);
      delegates.push({
          address,
          votes,
          percentOfSupply:
            totalSupply > 0n ? Number((votes * 10000n) / totalSupply) / 100 : 0,
      });
    }

    return delegates
      .filter((d) => d.votes > 0n)
      .sort((a, b) => (b.votes > a.votes ? 1 : b.votes < a.votes ? -1 : 0))
      .slice(0, limit);
  }

  /**
   * Get the current votes contract settings.
   */
  async getVotesSettings(): Promise<VotesSettings> {
    const retentionResult = await this.server.simulateTransaction(
      new TransactionBuilder(await this.server.getAccount(this.readAccount()), {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(this.contract.call("checkpoint_retention_period"))
        .setTimeout(30)
        .build(),
    );
    const enabledResult = await this.server.simulateTransaction(
      new TransactionBuilder(await this.server.getAccount(this.readAccount()), {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(this.contract.call("time_weight_enabled"))
        .setTimeout(30)
        .build(),
    );
    const scaleResult = await this.server.simulateTransaction(
      new TransactionBuilder(await this.server.getAccount(this.readAccount()), {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(this.contract.call("time_weight_scale"))
        .setTimeout(30)
        .build(),
    );

    if (SorobanRpc.Api.isSimulationError(retentionResult)) {
      throw new VotesError(VotesErrorCode.SimulationFailed, "Failed to get checkpoint retention period");
    }
    if (SorobanRpc.Api.isSimulationError(enabledResult)) {
      throw new VotesError(VotesErrorCode.SimulationFailed, "Failed to get time weight enabled");
    }
    if (SorobanRpc.Api.isSimulationError(scaleResult)) {
      throw new VotesError(VotesErrorCode.SimulationFailed, "Failed to get time weight scale");
    }

    return {
      checkpointRetentionPeriod: scValToNative((retentionResult as SorobanRpc.Api.SimulateTransactionSuccessResponse).result!.retval),
      timeWeightEnabled: scValToNative((enabledResult as SorobanRpc.Api.SimulateTransactionSuccessResponse).result!.retval),
      timeWeightScale: scValToNative((scaleResult as SorobanRpc.Api.SimulateTransactionSuccessResponse).result!.retval),
    };
  }

  /**
   * Get the checkpoint retention period in ledgers.
   */
  async getCheckpointRetentionPeriod(): Promise<number> {
    const result = await this.server.simulateTransaction(
      new TransactionBuilder(await this.server.getAccount(this.readAccount()), {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(this.contract.call("checkpoint_retention_period"))
        .setTimeout(30)
        .build(),
    );

    if (SorobanRpc.Api.isSimulationError(result)) {
      throw new VotesError(
        VotesErrorCode.SimulationFailed,
        "Failed to get checkpoint retention period",
      );
    }

    const retval = (result as SorobanRpc.Api.SimulateTransactionSuccessResponse)
      .result?.retval;
    if (!retval) {
      throw new VotesError(
        VotesErrorCode.SimulationFailed,
        "Failed to get checkpoint retention period",
      );
    }
    return Number(scValToNative(retval));
  }

  /**
   * Set the checkpoint retention period in ledgers (admin only).
   */
  async setCheckpointRetentionPeriod(
    signer: Keypair,
    ledgers: number,
  ): Promise<void> {
    const account = await this.server.getAccount(signer.publicKey());
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        this.contract.call(
          "set_checkpoint_retention_period",
          nativeToScVal(ledgers, { type: "u32" }),
        ),
      )
      .setTimeout(30)
      .build();

    const prepared = await this.server.prepareTransaction(tx);
    prepared.sign(signer);
    const result = await this.server.sendTransaction(prepared);
    if (result.status === "ERROR") {
      throw parseVotesError(result);
    }
  }

  /**
   * Prune checkpoints no longer needed by active proposals (admin only).
   *
   * @param minActiveProposalLedger - Oldest ledger still needed by an active proposal
   */
  async pruneCheckpoints(
    signer: Keypair,
    minActiveProposalLedger?: number,
  ): Promise<void> {
    const account = await this.server.getAccount(signer.publicKey());
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        this.contract.call(
          "prune_checkpoints",
          minActiveProposalLedger === undefined
            ? xdr.ScVal.scvVoid()
            : nativeToScVal(minActiveProposalLedger, { type: "u32" }),
        ),
      )
      .setTimeout(30)
      .build();

    const prepared = await this.server.prepareTransaction(tx);
    prepared.sign(signer);
    const result = await this.server.sendTransaction(prepared);
    if (result.status === "ERROR") {
      throw parseVotesError(result);
    }
  }

  /**
   * Enable or disable time-weighted voting (admin only).
   */
  async setTimeWeightEnabled(signer: Keypair, enabled: boolean): Promise<void> {
    const account = await this.server.getAccount(signer.publicKey());
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        this.contract.call("set_time_weight_enabled", nativeToScVal(enabled)),
      )
      .setTimeout(30)
      .build();

    const prepared = await this.server.prepareTransaction(tx);
    prepared.sign(signer);
    const result = await this.server.sendTransaction(prepared);
    if (result.status === "ERROR") {
      throw parseVotesError(result);
    }
  }

  /**
   * Set the time-weighting scale (admin only).
   */
  async setTimeWeightScale(signer: Keypair, scale: number): Promise<void> {
    if (!Number.isInteger(scale) || scale <= 0 || scale > 0xffffffff) {
      throw new VotesError(
        VotesErrorCode.InvalidTimeWeightScale,
        "Time-weighting scale must be a positive u32",
      );
    }

    const account = await this.server.getAccount(signer.publicKey());
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        this.contract.call(
          "set_time_weight_scale",
          nativeToScVal(scale, { type: "u32" }),
        ),
      )
      .setTimeout(30)
      .build();

    const prepared = await this.server.prepareTransaction(tx);
    prepared.sign(signer);
    const result = await this.server.sendTransaction(prepared);
    if (result.status === "ERROR") {
      throw parseVotesError(result);
    }
  }

  /**
   * Get the delegator record (balance and start ledger) for an address.
   */
  async getDelegatorRecord(account: string): Promise<DelegatorRecord | null> {
    // Note: This requires the contract to expose a way to read the DelegatorRecord
    // Currently, it's in storage but not explicitly exposed via a getter.
    // I previously added DelegatorRecord to DataKey, but didn't add a getter.
    // Let's assume we add a getter `get_delegator_record` to the contract.
    const result = await this.server.simulateTransaction(
      new TransactionBuilder(await this.server.getAccount(this.readAccount(account)), {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          this.contract.call(
            "get_delegator_record",
            nativeToScVal(account, { type: "address" }),
          ),
        )
        .setTimeout(30)
        .build(),
    );

    if (SorobanRpc.Api.isSimulationError(result)) return null;
    const raw = (result as SorobanRpc.Api.SimulateTransactionSuccessResponse)
      .result?.retval;
    if (!raw) return null;
    const native = scValToNative(raw);
    return {
      balance: BigInt(native.balance),
      startLedger: native.start_ledger,
    };
  }

  // Gasless ("delegate by signature") delegation lives in
  // DelegationSigClient (./delegation-sig.ts) — it needs a full
  // SorobanAuthorizationEntry, not a raw signature, because verification is
  // done through Soroban's native auth framework. See that module's docs.

  // ─── Delegation registry (issue #769) ──────────────────────────────────────
  //
  // These wrap the on-chain `delegation_registry` module's query/admin
  // functions directly (single simulated call each), as opposed to the
  // event-scanning helpers above (getDelegators, getTopDelegates, etc.)
  // which reconstruct delegation state from `del_chsh`/`del_revk` events.

  private async simulateRead<T>(
    method: string,
    args: xdr.ScVal[],
    parse: (raw: xdr.ScVal) => T,
    defaultValue: T,
  ): Promise<T> {
    return this.retry(async () => {
      const result = await this.server.simulateTransaction(
        new TransactionBuilder(await this.server.getAccount(this.readAccount()), {
          fee: BASE_FEE,
          networkPassphrase: this.networkPassphrase,
        })
          .addOperation(this.contract.call(method, ...args))
          .setTimeout(30)
          .build(),
      );

      if (SorobanRpc.Api.isSimulationError(result)) return defaultValue;
      const raw = (result as SorobanRpc.Api.SimulateTransactionSuccessResponse)
        .result?.retval;
      return raw ? parse(raw) : defaultValue;
    });
  }

  private parseDelegationEntry(native: Record<string, unknown>): DelegationEntry {
    return {
      delegator: String(native.delegator),
      delegatee: String(native.delegatee),
      delegatedAtLedger: Number(native.delegated_at_ledger),
      votingPowerAtDelegation: BigInt(native.voting_power_at_delegation as bigint),
      active: Boolean(native.active),
      revokedAtLedger:
        native.revoked_at_ledger === undefined || native.revoked_at_ledger === null
          ? null
          : Number(native.revoked_at_ledger),
    };
  }

  private parseDelegationHistoryEntry(native: Record<string, unknown>): DelegationHistoryEntry {
    return {
      delegatee: String(native.delegatee),
      delegatedAtLedger: Number(native.delegated_at_ledger),
      revokedAtLedger:
        native.revoked_at_ledger === undefined || native.revoked_at_ledger === null
          ? null
          : Number(native.revoked_at_ledger),
      powerAtDelegation: BigInt(native.power_at_delegation as bigint),
      sequence: Number(native.sequence),
    };
  }

  private parseRegistryDelegatorInfo(native: Record<string, unknown>): RegistryDelegatorInfo {
    return {
      address: String(native.address),
      delegatedPower: BigInt(native.delegated_power as bigint),
      delegatedAtLedger: Number(native.delegated_at_ledger),
      chainDepth: Number(native.chain_depth),
    };
  }

  /** Get full delegation history for a delegator. */
  async getDelegationHistory(delegator: string): Promise<DelegationHistoryEntry[]> {
    return this.simulateRead(
      "get_delegation_history",
      [nativeToScVal(delegator, { type: "address" })],
      (raw) => (scValToNative(raw) as Record<string, unknown>[]).map((e) => this.parseDelegationHistoryEntry(e)),
      [],
    );
  }

  /**
   * Get all current delegators of a delegatee with their power and depth.
   *
   * Named `getRegistryDelegators` (rather than `getDelegators`) to avoid
   * colliding with the existing event-scan-based {@link getDelegators}.
   */
  async getRegistryDelegators(
    delegatee: string,
    offset = 0,
    limit = 50,
  ): Promise<RegistryDelegatorInfo[]> {
    return this.simulateRead(
      "get_delegators",
      [
        nativeToScVal(delegatee, { type: "address" }),
        nativeToScVal(offset, { type: "u32" }),
        nativeToScVal(limit, { type: "u32" }),
      ],
      (raw) => (scValToNative(raw) as Record<string, unknown>[]).map((e) => this.parseRegistryDelegatorInfo(e)),
      [],
    );
  }

  /** Get total number of current delegators of a delegatee. */
  async getDelegatorCount(delegatee: string): Promise<number> {
    return this.simulateRead(
      "get_delegator_count",
      [nativeToScVal(delegatee, { type: "address" })],
      (raw) => Number(scValToNative(raw)),
      0,
    );
  }

  /** Get the full delegation chain from delegator to the final tip. */
  async getDelegationChain(delegator: string): Promise<string[]> {
    return this.simulateRead(
      "get_delegation_chain",
      [nativeToScVal(delegator, { type: "address" })],
      (raw) => scValToNative(raw) as string[],
      [],
    );
  }

  /** Get depth of the delegation chain from this address. */
  async getChainDepth(delegator: string): Promise<number> {
    return this.simulateRead(
      "get_chain_depth",
      [nativeToScVal(delegator, { type: "address" })],
      (raw) => Number(scValToNative(raw)),
      0,
    );
  }

  /** Get a comprehensive delegate profile (voting power, delegators, depth limit). */
  async getDelegateProfile(address: string): Promise<DelegateProfile> {
    return this.simulateRead(
      "get_delegate_profile",
      [nativeToScVal(address, { type: "address" })],
      (raw) => {
        const native = scValToNative(raw) as Record<string, unknown>;
        return {
          address: String(native.address),
          currentVotingPower: BigInt(native.current_voting_power as bigint),
          baseVotingPower: BigInt(native.base_voting_power as bigint),
          totalDelegators: Number(native.total_delegators),
          totalDelegatedPower: BigInt(native.total_delegated_power as bigint),
          delegationDepthLimit: Number(native.delegation_depth_limit),
          firstDelegatedAtLedger:
            native.first_delegated_at_ledger === undefined ||
            native.first_delegated_at_ledger === null
              ? null
              : Number(native.first_delegated_at_ledger),
        };
      },
      {
        address,
        currentVotingPower: 0n,
        baseVotingPower: 0n,
        totalDelegators: 0,
        totalDelegatedPower: 0n,
        delegationDepthLimit: 1,
        firstDelegatedAtLedger: null,
      },
    );
  }

  /** Get all active delegations received by a delegatee (paginated). */
  async getReceivedDelegations(
    delegatee: string,
    offset = 0,
    limit = 50,
  ): Promise<DelegationEntry[]> {
    return this.simulateRead(
      "get_received_delegations",
      [
        nativeToScVal(delegatee, { type: "address" }),
        nativeToScVal(offset, { type: "u32" }),
        nativeToScVal(limit, { type: "u32" }),
      ],
      (raw) => (scValToNative(raw) as Record<string, unknown>[]).map((e) => this.parseDelegationEntry(e)),
      [],
    );
  }

  /** Check whether delegating from `delegator` to `delegatee` would create a cycle. */
  async wouldCreateCycle(delegator: string, delegatee: string): Promise<boolean> {
    return this.simulateRead(
      "would_create_cycle",
      [
        nativeToScVal(delegator, { type: "address" }),
        nativeToScVal(delegatee, { type: "address" }),
      ],
      (raw) => Boolean(scValToNative(raw)),
      false,
    );
  }

  /** Get a snapshot of the full delegation graph for a delegatee at a past ledger (for audit). */
  async getDelegationSnapshot(
    delegatee: string,
    atLedger: number,
    offset: number = 0,
    limit: number = 100,
  ): Promise<RegistryDelegatorInfo[]> {
    return this.simulateRead(
      "get_delegation_snapshot",
      [
        nativeToScVal(delegatee, { type: "address" }),
        nativeToScVal(atLedger, { type: "u32" }),
        nativeToScVal(offset, { type: "u32" }),
        nativeToScVal(limit, { type: "u32" }),
      ],
      (raw) => (scValToNative(raw) as Record<string, unknown>[]).map((e) => this.parseRegistryDelegatorInfo(e)),
      [],
    );
  }

  /** Get the current delegation depth limit. */
  async getDelegationDepthLimit(): Promise<number> {
    return this.simulateRead(
      "get_delegation_depth_limit",
      [],
      (raw) => Number(scValToNative(raw)),
      1,
    );
  }

  /**
   * Update the maximum delegation chain depth (admin only).
   *
   * @returns The Stellar transaction hash, suitable for linking to a block explorer.
   */
  async setDelegationDepthLimit(signer: Keypair, newLimit: number): Promise<string> {
    return this.retry(async () => {
      const account = await this.server.getAccount(signer.publicKey());

      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          this.contract.call(
            "set_delegation_depth_limit",
            nativeToScVal(signer.publicKey(), { type: "address" }),
            nativeToScVal(newLimit, { type: "u32" }),
          ),
        )
        .setTimeout(30)
        .build();

      const prepared = await this.server.prepareTransaction(tx);
      prepared.sign(signer);
      const result = await this.server.sendTransaction(prepared);
      if (result.status === "ERROR") {
        throw parseVotesError(result);
      }
      return result.hash;
    }, (e) => this.isRetryableSubmissionError(e));
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  private readAccount(fallback?: string): string {
    return this.config.simulationAccount ?? fallback ?? this.contract.contractId();
  }

  /**
   * Scan all `del_chsh` (delegate changed) events from the token-votes
   * contract and return a Map of delegator → current delegatee.
   *
   * The contract emits this event on every `delegate()` call:
   *   topics: (symbol "del_chsh", delegator_address)
   *   data:   (previous_delegatee | null, new_delegatee)
   *
   * We take the last event per delegator to get the current delegation state.
   *
   * @throws {VotesError} with code EventScanFailed on RPC failure.
   */
  private async buildDelegationMap(
    fromLedger?: number,
  ): Promise<Map<string, string>> {
    const delegationMap = new Map<string, string>();
    await this.buildDelegationMapIncremental({
      fromLedger,
      delegationMap,
    });
    return delegationMap;
  }

  private encodeDelegationCursor(nextStartLedger: number): string {
    const payload = JSON.stringify({ nextStartLedger });
    if (typeof Buffer !== "undefined") {
      return Buffer.from(payload, "utf8").toString("base64");
    }
    // Browser fallback
    return btoa(unescape(encodeURIComponent(payload)));
  }

  private decodeDelegationCursor(cursor: string): number | null {
    try {
      const raw =
        typeof Buffer !== "undefined"
          ? Buffer.from(cursor, "base64").toString("utf8")
          : decodeURIComponent(escape(atob(cursor)));
      const parsed = JSON.parse(raw) as { nextStartLedger?: unknown };
      const next = Number(parsed.nextStartLedger);
      return Number.isFinite(next) && next > 0 ? Math.floor(next) : null;
    } catch {
      return null;
    }
  }

  private async buildDelegationMapIncremental({
    fromLedger,
    cursor,
    maxEventsToScan,
    delegationMap,
  }: {
    fromLedger?: number;
    cursor?: string;
    maxEventsToScan?: number;
    delegationMap: Map<string, string>;
  }): Promise<{ nextCursor: string | null }> {
    let startLedger: number | undefined = fromLedger;
    if (cursor) {
      const decoded = this.decodeDelegationCursor(cursor);
      if (decoded) startLedger = decoded;
    }

    if (startLedger === undefined) {
      const info = await this.retry(() => this.server.getLatestLedger());
      startLedger = Math.max(1, info.sequence - DEFAULT_SCAN_WINDOW);
    }

    const contractId = this.contract.contractId();
    const topicFilter = [
      xdr.ScVal.scvSymbol("del_chsh"),
      xdr.ScVal.scvSymbol("del_revk"),
    ];

    const scanCap =
      maxEventsToScan === undefined
        ? Number.POSITIVE_INFINITY
        : Math.max(0, Math.floor(maxEventsToScan));

    try {
      let cursorLedger = startLedger;
      const latest = (await this.server.getLatestLedger()).sequence;
      let scanned = 0;

      while (cursorLedger <= latest && scanned < scanCap) {
        const remaining = scanCap - scanned;
        const limit = Math.max(1, Math.min(100, remaining));
        const response = await this.retry(() =>
          this.server.getEvents({
            startLedger: cursorLedger,
            filters: [
              {
                type: "contract",
                contractIds: [contractId],
                topics: [topicFilter.map((v) => v.toXDR("base64"))],
              },
            ],
            limit,
          }),
        );

        const events = response.events ?? [];
        if (events.length === 0) {
          return { nextCursor: null };
        }

        let maxLedger = cursorLedger;

        for (const event of events) {
          scanned += 1;
          try {
            const symbol = scValToNative(event.topic[0]);
            const delegator = scValToNative(event.topic[1]) as string;
            if (symbol === "del_chsh") {
              const data = scValToNative(event.value) as [
                string | null,
                string,
              ];
              const newDelegatee = data[1];
              if (
                typeof delegator === "string" &&
                typeof newDelegatee === "string"
              ) {
                delegationMap.set(delegator, newDelegatee);
              }
            } else if (symbol === "del_revk") {
              if (typeof delegator === "string") {
                delegationMap.delete(delegator);
              }
            }
          } catch {
            // Malformed event — skip
          }
          if (event.ledger > maxLedger) maxLedger = event.ledger;
        }

        cursorLedger = maxLedger + 1;
      }

      if (cursorLedger > latest) return { nextCursor: null };
      return { nextCursor: this.encodeDelegationCursor(cursorLedger) };
    } catch (err) {
      throw new VotesError(
        VotesErrorCode.EventScanFailed,
        `Failed to scan delegation events: ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    }
  }
}

export interface TopDelegatesOptions {
  /** Maximum number of delegates to return (default 50). */
  limit?: number;
  /** Number of delegates to skip before returning results (default 0). */
  offset?: number;
  /** Earliest ledger to scan events from (default latest - DEFAULT_SCAN_WINDOW). */
  fromLedger?: number;
  /** Opaque pagination cursor returned by a prior call. */
  cursor?: string;
  /** Safety cap to prevent unbounded scans. */
  maxEventsToScan?: number;
  /**
   * Optional delegation map to reuse across calls.
   * Pass the returned map back in to avoid rebuilding from scratch.
   */
  delegationMap?: Map<string, string>;
}

export interface TopDelegatesResult {
  delegates: TopDelegate[];
  nextCursor: string | null;
  delegationMap: Map<string, string>;
}

// ─── Pure helpers ─────────────────────────────────────────────────────────────

/**
 * Compute the Gini coefficient for an array of voting power values.
 *
 * Returns 0 when the array is empty or all values are equal (perfectly
 * uniform distribution), and approaches 1 when all power is concentrated
 * in a single account.
 */
function computeGini(powers: bigint[]): number {
  if (powers.length === 0) return 0;

  const sorted = [...powers].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const n = sorted.length;
  const total = sorted.reduce((s, v) => s + v, 0n);
  if (total === 0n) return 0;

  let weightedSum = 0n;
  for (let i = 0; i < n; i++) {
    weightedSum += BigInt(i + 1) * sorted[i];
  }

  return (2 * Number(weightedSum)) / (n * Number(total)) - (n + 1) / n;
}
