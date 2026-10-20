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
import { GovernorConfig, ProposalBond, BondState, ProposalBondSettings } from "./types";
import {
  ProposalBondsError,
  ProposalBondsErrorCode,
  parseProposalBondsError,
} from "./errors";
import { createRetry, isNetworkError, hexToBytes32, type RetryFunction } from "./utils";
import { getNetworkPassphrase, getRpcUrl } from "./network";

export type ProposalBondsConfig = GovernorConfig;

interface SubmitResult {
  hash: string;
  confirmed: SorobanRpc.Api.GetSuccessfulTransactionResponse;
}

/**
 * ProposalBondsClient — interact with a deployed NebGov proposal-bonds
 * contract (Issue #996).
 *
 * Proposing costs nothing beyond meeting `proposal_threshold` in the base
 * governor; this contract adds an optional economic deterrent against
 * low-effort or malicious proposals: proposers post a refundable token bond
 * alongside their proposal (correlated off-chain by a shared
 * `descriptionHash` — bonding and proposing are two separate transactions,
 * not enforced atomically on-chain). The bond is refunded once the
 * correlated proposal reaches a terminal state and a post-terminal grace
 * window elapses, or slashed by a follow-up governance vote if the
 * community judges the proposal to have been spam, duplicated, or
 * malicious.
 *
 * Note: unlike the sketch in Issue #996, `refundBond` also takes the
 * governor `proposalId` — governor has no `description_hash → proposal_id`
 * lookup (and adding one was out of scope, see the contract's doc comment),
 * so the caller must supply it so the contract can verify
 * `get_proposal(proposalId).descriptionHash === descriptionHash` itself.
 *
 * @example
 * const client = new ProposalBondsClient({
 *   governorAddress: "CABC...",
 *   timelockAddress: "CDEF...",
 *   votesAddress: "CGHI...",
 *   proposalBondsAddress: "CJKL...",
 *   network: "testnet",
 * });
 *
 * await client.lockBond(signer, descriptionHash);
 * // ... submit the correlated proposal via GovernorClient.propose ...
 * await client.refundBond(signer, descriptionHash, proposalId);
 */
export class ProposalBondsClient {
  private readonly config: ProposalBondsConfig;
  private readonly server: SorobanRpc.Server;
  private readonly contract: Contract;
  private readonly networkPassphrase: string;
  private readonly retry: RetryFunction;

  constructor(config: ProposalBondsConfig) {
    if (!config.proposalBondsAddress) {
      throw new ProposalBondsError(
        ProposalBondsErrorCode.TransactionFailed,
        "ProposalBondsClient requires config.proposalBondsAddress",
      );
    }
    this.config = config;
    const rpcUrl = getRpcUrl(config.network, config.rpcUrl);
    this.server = new SorobanRpc.Server(rpcUrl, { allowHttp: false });
    this.contract = new Contract(config.proposalBondsAddress);
    this.networkPassphrase = getNetworkPassphrase(config.network);
    this.retry = createRetry(config, { retryOn: isNetworkError });
  }

  private readAccount(): string {
    return this.config.simulationAccount ?? this.config.proposalBondsAddress!;
  }

  private parseBond(native: Record<string, unknown>): ProposalBond {
    const rawDescriptionHash = native.description_hash;
    const descriptionHash =
      typeof rawDescriptionHash === "string"
        ? rawDescriptionHash
        : Buffer.from(rawDescriptionHash as Uint8Array).toString("hex");

    // `BondState` is a unit enum, which decodes to a one-element
    // `Vec<Symbol>` (`["Locked"]`) rather than a bare string.
    const rawState = native.state;
    const state = (
      Array.isArray(rawState) && typeof rawState[0] === "string" ? rawState[0] : rawState
    ) as BondState;

    return {
      proposer: String(native.proposer),
      descriptionHash,
      amount: BigInt(native.amount as bigint | number | string),
      lockedLedger: Number(native.locked_ledger),
      state,
    };
  }

  private async submit(
    signer: Keypair,
    fnName: string,
    ...args: xdr.ScVal[]
  ): Promise<SubmitResult> {
    return this.retry(async () => {
      const account = await this.server.getAccount(signer.publicKey());
      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(this.contract.call(fnName, ...args))
        .setTimeout(30)
        .build();

      const prepared = await this.server.prepareTransaction(tx);
      prepared.sign(signer);

      const result = await this.server.sendTransaction(prepared);
      if (result.status === "ERROR") {
        throw parseProposalBondsError(result);
      }
      const confirmed = await this.pollForConfirmation(result.hash);
      return { hash: result.hash, confirmed };
    });
  }

  /**
   * Same as {@link submit}, but for wallet-extension signing flows: takes
   * the signer's public key plus a callback that signs an unsigned XDR
   * envelope instead of a raw {@link Keypair}.
   */
  private async submitWithSign(
    signerPublicKey: string,
    signUnsignedXdr: (xdr: string) => Promise<string>,
    fnName: string,
    ...args: xdr.ScVal[]
  ): Promise<SubmitResult> {
    return this.retry(async () => {
      const account = await this.server.getAccount(signerPublicKey);
      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(this.contract.call(fnName, ...args))
        .setTimeout(30)
        .build();

      const prepared = await this.server.prepareTransaction(tx);
      const signedXdr = await signUnsignedXdr(prepared.toXDR());
      const signed = TransactionBuilder.fromXDR(signedXdr, this.networkPassphrase);

      const result = await this.server.sendTransaction(signed);
      if (result.status === "ERROR") {
        throw parseProposalBondsError(result);
      }
      const confirmed = await this.pollForConfirmation(result.hash);
      return { hash: result.hash, confirmed };
    });
  }

  /**
   * Lock the configured bond amount from `signer`, keyed by
   * `descriptionHash`. Call this alongside (before or after)
   * `GovernorClient.propose`/`proposeWithSign` using the same
   * `descriptionHash` so the two can be correlated later. Returns the tx hash.
   */
  async lockBond(signer: Keypair, descriptionHash: string): Promise<string> {
    const { hash } = await this.submit(
      signer,
      "lock_bond",
      nativeToScVal(signer.publicKey(), { type: "address" }),
      nativeToScVal(hexToBytes32(descriptionHash), { type: "bytes" }),
    );
    return hash;
  }

  /** Wallet-signing variant of {@link lockBond} */
  async lockBondWithSign(
    signerPublicKey: string,
    descriptionHash: string,
    signUnsignedXdr: (xdr: string) => Promise<string>,
  ): Promise<string> {
    const { hash } = await this.submitWithSign(
      signerPublicKey,
      signUnsignedXdr,
      "lock_bond",
      nativeToScVal(signerPublicKey, { type: "address" }),
      nativeToScVal(hexToBytes32(descriptionHash), { type: "bytes" }),
    );
    return hash;
  }

  /**
   * Refund a locked bond once its correlated governor proposal (`proposalId`,
   * whose on-chain `descriptionHash` must match this bond's) has reached a
   * terminal state and the post-terminal refund grace window has elapsed.
   * Permissionless — any address may call this — but funds always return to
   * the original proposer. Returns the tx hash.
   */
  async refundBond(
    caller: Keypair,
    descriptionHash: string,
    proposalId: bigint,
  ): Promise<string> {
    const { hash } = await this.submit(
      caller,
      "refund_bond",
      nativeToScVal(caller.publicKey(), { type: "address" }),
      nativeToScVal(hexToBytes32(descriptionHash), { type: "bytes" }),
      nativeToScVal(proposalId, { type: "u64" }),
    );
    return hash;
  }

  /** Wallet-signing variant of {@link refundBond} */
  async refundBondWithSign(
    callerPublicKey: string,
    descriptionHash: string,
    proposalId: bigint,
    signUnsignedXdr: (xdr: string) => Promise<string>,
  ): Promise<string> {
    const { hash } = await this.submitWithSign(
      callerPublicKey,
      signUnsignedXdr,
      "refund_bond",
      nativeToScVal(callerPublicKey, { type: "address" }),
      nativeToScVal(hexToBytes32(descriptionHash), { type: "bytes" }),
      nativeToScVal(proposalId, { type: "u64" }),
    );
    return hash;
  }

  /**
   * Encode calldata for a `slash` action targeting this bonds contract, for
   * use as one of a governance proposal's `targets`/`fnNames`/`calldatas` —
   * `slash` is only callable as the target of an executed governance
   * proposal (the governor contract must be the caller), so it is not
   * exposed as a directly-signable client method the way `lockBond`/
   * `refundBond` are.
   */
  encodeSlashCalldata(
    governorAddress: string,
    descriptionHash: string,
    recipient: string,
  ): Buffer {
    // Built directly with explicit per-arg type hints rather than
    // encodeCalldata(): that helper only special-cases "0x"-prefixed
    // strings as bytes and otherwise infers the ScVal type from the JS
    // value, so a plain address string encodes as ScVal.scvString instead
    // of ScVal.scvAddress — slash()'s `Address` params would trap on
    // execution. Mirrors calldataArgRowToScVal in treasury-calldata.ts.
    const args = xdr.ScVal.scvVec([
      nativeToScVal(governorAddress, { type: "address" }),
      nativeToScVal(hexToBytes32(descriptionHash), { type: "bytes" }),
      nativeToScVal(recipient, { type: "address" }),
    ]);
    return Buffer.from(args.toXDR());
  }

  /** Get a bond by description hash, or `null` if none has been locked. */
  async getBond(descriptionHash: string): Promise<ProposalBond | null> {
    return this.retry(async () => {
      const result = await this.server.simulateTransaction(
        new TransactionBuilder(
          await this.server.getAccount(this.readAccount()),
          { fee: BASE_FEE, networkPassphrase: this.networkPassphrase },
        )
          .addOperation(
            this.contract.call(
              "get_bond",
              nativeToScVal(hexToBytes32(descriptionHash), { type: "bytes" }),
            ),
          )
          .setTimeout(30)
          .build(),
      );

      if (SorobanRpc.Api.isSimulationError(result)) {
        throw parseProposalBondsError({ status: "ERROR", error: result.error });
      }

      const raw = (result as SorobanRpc.Api.SimulateTransactionSuccessResponse)
        .result?.retval;
      if (!raw) return null;

      const native = scValToNative(raw);
      if (native === null || native === undefined) return null;
      return this.parseBond(native as Record<string, unknown>);
    });
  }

  /**
   * Read the contract's configuration — bond token/amount, governor
   * address, `RefundGraceLedgers`, and `MaxLockLedgers`. Use this to work
   * out whether a `Locked` bond is currently refund-eligible without
   * hardcoding those values client-side.
   */
  async getSettings(): Promise<ProposalBondSettings> {
    return this.retry(async () => {
      const result = await this.server.simulateTransaction(
        new TransactionBuilder(
          await this.server.getAccount(this.readAccount()),
          { fee: BASE_FEE, networkPassphrase: this.networkPassphrase },
        )
          .addOperation(this.contract.call("get_settings"))
          .setTimeout(30)
          .build(),
      );

      if (SorobanRpc.Api.isSimulationError(result)) {
        throw parseProposalBondsError({ status: "ERROR", error: result.error });
      }

      const raw = (result as SorobanRpc.Api.SimulateTransactionSuccessResponse)
        .result?.retval;
      if (!raw) {
        throw new ProposalBondsError(
          ProposalBondsErrorCode.MissingReturnValue,
          "No return value from get_settings",
        );
      }

      const native = scValToNative(raw) as Record<string, unknown>;
      return {
        bondToken: String(native.bond_token),
        bondAmount: BigInt(native.bond_amount as bigint | number | string),
        governor: String(native.governor),
        refundGraceLedgers: Number(native.refund_grace_ledgers),
        maxLockLedgers: Number(native.max_lock_ledgers),
      };
    });
  }

  private async pollForConfirmation(
    hash: string,
    retries = 10,
    delayMs = 2000,
  ): Promise<SorobanRpc.Api.GetSuccessfulTransactionResponse> {
    for (let i = 0; i < retries; i++) {
      await new Promise((r) => setTimeout(r, delayMs));
      const status = await this.retry(() => this.server.getTransaction(hash));
      if (status.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
        return status as SorobanRpc.Api.GetSuccessfulTransactionResponse;
      }
      if (status.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
        throw new ProposalBondsError(
          ProposalBondsErrorCode.TransactionFailed,
          `Transaction failed: ${hash}`,
        );
      }
    }
    throw new ProposalBondsError(
      ProposalBondsErrorCode.TransactionTimeout,
      `Transaction not confirmed after ${retries} retries`,
    );
  }

  // ─── Indexer-backed query methods ────────────────────────────────────────

  private async indexerRequest<T>(path: string): Promise<T> {
    if (!this.config.indexerUrl) {
      throw new ProposalBondsError(
        ProposalBondsErrorCode.SimulationFailed,
        `ProposalBondsClient.${path} requires config.indexerUrl to be set`,
      );
    }
    return this.retry(async () => {
      const resp = await fetch(`${this.config.indexerUrl}${path}`);
      if (!resp.ok) {
        throw new ProposalBondsError(
          ProposalBondsErrorCode.TransactionFailed,
          `Indexer request failed: ${resp.status} ${resp.statusText}`,
        );
      }
      return resp.json() as Promise<T>;
    });
  }

  /**
   * List bonds from the indexer with optional state filtering and
   * pagination — unlike a direct on-chain scan, this is O(1) in terms of
   * on-chain resources.
   */
  async listBonds(
    options: { state?: "locked" | "refunded" | "slashed"; page?: number; limit?: number } = {},
  ): Promise<{ data: ProposalBond[]; pagination: { page: number; limit: number; hasMore: boolean } }> {
    const params = new URLSearchParams();
    if (options.state) params.set("state", options.state);
    if (options.page) params.set("page", String(options.page));
    if (options.limit) params.set("limit", String(options.limit));

    const query = params.toString() ? `?${params.toString()}` : "";
    const raw = await this.indexerRequest<{
      data: any[];
      pagination: { page: number; limit: number; hasMore: boolean };
    }>(`/proposal-bonds${query}`);

    return {
      data: raw.data.map(mapBondFromIndexer),
      pagination: {
        page: raw.pagination.page,
        limit: raw.pagination.limit,
        hasMore: raw.pagination.hasMore,
      },
    };
  }

  /** Return all bonds posted by a specific proposer, most-recent first. */
  async getBondsByProposer(address: string): Promise<ProposalBond[]> {
    const raw = await this.indexerRequest<{ data: any[] }>(
      `/proposal-bonds/by-proposer/${address}`,
    );
    return raw.data.map(mapBondFromIndexer);
  }

  /**
   * Resolve the governor proposal id correlated with a given
   * `descriptionHash`, via the indexer — needed to call {@link refundBond},
   * since governor has no on-chain description_hash → id lookup. Returns
   * `null` if no matching proposal has been indexed yet.
   */
  async getProposalIdForDescriptionHash(descriptionHash: string): Promise<bigint | null> {
    if (!this.config.indexerUrl) {
      throw new ProposalBondsError(
        ProposalBondsErrorCode.SimulationFailed,
        "ProposalBondsClient.getProposalIdForDescriptionHash requires config.indexerUrl to be set",
      );
    }
    return this.retry(async () => {
      const resp = await fetch(
        `${this.config.indexerUrl}/proposals/by-description-hash/${descriptionHash}`,
      );
      if (resp.status === 404) return null;
      if (!resp.ok) {
        throw new ProposalBondsError(
          ProposalBondsErrorCode.TransactionFailed,
          `Indexer request failed: ${resp.status} ${resp.statusText}`,
        );
      }
      const proposal = (await resp.json()) as { id: string | number };
      return BigInt(proposal.id);
    });
  }
}

/**
 * Map a raw snake_case indexer bond record to the camelCase ProposalBond
 * interface used throughout the SDK.
 */
function mapBondFromIndexer(raw: any): ProposalBond {
  const stateMap: Record<string, BondState> = {
    locked: "Locked",
    refunded: "Refunded",
    slashed: "Slashed",
  };

  return {
    proposer: String(raw.proposer_address ?? raw.proposer),
    descriptionHash: String(raw.description_hash ?? ""),
    amount: BigInt(raw.amount ?? 0),
    lockedLedger: Number(raw.locked_ledger ?? 0),
    state: stateMap[String(raw.state).toLowerCase()] ?? "Locked",
  };
}
