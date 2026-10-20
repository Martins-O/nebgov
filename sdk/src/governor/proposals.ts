import {
  TransactionBuilder,
  BASE_FEE,
  Keypair,
  nativeToScVal,
  scValToNative,
  xdr,
  SorobanRpc,
  Contract,
} from "@stellar/stellar-sdk";
import {
  GovernorConfig,
  GovernorSettings,
  GovernorSettingsValidationLimits,
  Proposal,
  ProposalAction,
  ProposalSimulationResult,
  ProposalState,
  Network,
} from "../types";
import {
  GovernorError,
  GovernorErrorCode,
  parseGovernorError,
} from "../errors";
import { hexToBytes32 } from "../utils";
import { GovernorClient, scVecAddress, scVecSymbol, scVecBytes, toBigInt } from "./governor-client";
import { TimelockClient } from "../timelock";
import { getProposalState, getSettings } from "./queries";

const DEFAULT_MAX_VOTING_DELAY = 1_209_600;
const DEFAULT_MIN_VOTING_PERIOD = 1;

/**
 * Create a new governance proposal (multi-action, matching on-chain `propose`).
 *
 * @param signer The account proposing the change
 * @param description A brief summary of the proposal
 * @param descriptionHash SHA-256 hash of the full description (hex string)
 * @param metadataUri URI pointing to the full description (ipfs:// or https://)
 * @param targets Calldata targets (same length as `fnNames` / `calldatas`)
 * @param fnNames Function names on each target
 * @param calldatas Encoded arguments for each call
 * @returns The unique identifier of the created proposal
 */
export async function propose(
  client: GovernorClient,
  signer: Keypair,
  description: string,
  descriptionHashOrTargets: string | string[],
  metadataUriOrFnNames: string | string[],
  targetsOrCalldatas: string[] | (Buffer | Uint8Array)[],
  fnNamesArg?: string[],
  calldatasArg?: (Buffer | Uint8Array)[],
): Promise<bigint> {
  return client.retry(async () => {
    const legacyCall = Array.isArray(descriptionHashOrTargets);
    const descriptionHash = legacyCall
      ? "0".repeat(64)
      : descriptionHashOrTargets;
    const metadataUri = legacyCall ? "" : (metadataUriOrFnNames as string);
    const targets = legacyCall
      ? descriptionHashOrTargets
      : (targetsOrCalldatas as string[]);
    const fnNames = legacyCall ? (metadataUriOrFnNames as string[]) : fnNamesArg;
    const calldatas = legacyCall
      ? (targetsOrCalldatas as (Buffer | Uint8Array)[])
      : calldatasArg;

    if (!fnNames || !calldatas) {
      throw new GovernorError(
        GovernorErrorCode.InvalidArguments,
        "targets, fnNames, and calldatas are required",
      );
    }
    if (
      targets.length !== fnNames.length ||
      targets.length !== calldatas.length
    ) {
      throw new GovernorError(
        GovernorErrorCode.InvalidVectorLengths,
        "targets, fnNames, and calldatas must have the same length",
      );
    }
    if (targets.length === 0) {
      throw new GovernorError(
        GovernorErrorCode.NoTargets,
        "At least one on-chain action is required",
      );
    }

    // Convert hex string to BytesN<32>
    const hashBytes = hexToBytes32(descriptionHash);

    const account = await client.server.getAccount(signer.publicKey());

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: client.networkPassphrase,
    })
      .addOperation(
        client.contract.call(
          "propose",
          nativeToScVal(signer.publicKey(), { type: "address" }),
          nativeToScVal(description, { type: "string" }),
          nativeToScVal(hashBytes, { type: "bytes" }),
          nativeToScVal(metadataUri, { type: "string" }),
          scVecAddress(targets),
          scVecSymbol(fnNames),
          scVecBytes(calldatas),
        ),
      )
      .setTimeout(30)
      .build();

    const prepared = await client.server.prepareTransaction(tx);
    prepared.sign(signer);

    const result = await client.server.sendTransaction(prepared);
    if (result.status === "ERROR") {
      throw parseGovernorError(result);
    }

    const confirmed = await client.pollForConfirmation(result.hash);
    const returnVal = confirmed.returnValue;
    return returnVal ? BigInt(scValToNative(returnVal)) : 0n;
  }, (e) => client.isRetryableSubmissionError(e));
}

/**
 * Same as {@link propose} but signs with a wallet callback (unsigned XDR in → signed XDR out).
 *
 * @returns An object containing the new `proposalId` and the Stellar `txHash`,
 *   both suitable for UI display and block-explorer linking.
 */
export async function proposeWithSign(
  client: GovernorClient,
  signerPublicKey: string,
  description: string,
  descriptionHash: string,
  metadataUri: string,
  targets: string[],
  fnNames: string[],
  calldatas: (Buffer | Uint8Array)[],
  signUnsignedXdr: (xdr: string) => Promise<string>,
): Promise<{ proposalId: bigint; txHash: string }> {
  if (
    targets.length !== fnNames.length ||
    targets.length !== calldatas.length
  ) {
    throw new GovernorError(
      GovernorErrorCode.InvalidVectorLengths,
      "targets, fnNames, and calldatas must have the same length",
    );
  }
  if (targets.length === 0) {
    throw new GovernorError(
      GovernorErrorCode.NoTargets,
      "At least one on-chain action is required",
    );
  }

  const hashBytes = hexToBytes32(descriptionHash);

  const account = await client.server.getAccount(signerPublicKey);
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: client.networkPassphrase,
  })
    .addOperation(
      client.contract.call(
        "propose",
        nativeToScVal(signerPublicKey, { type: "address" }),
        nativeToScVal(description, { type: "string" }),
        nativeToScVal(hashBytes, { type: "bytes" }),
        nativeToScVal(metadataUri, { type: "string" }),
        scVecAddress(targets),
        scVecSymbol(fnNames),
        scVecBytes(calldatas),
      ),
    )
    .setTimeout(30)
    .build();

  const prepared = await client.server.prepareTransaction(tx);
  const signedXdr = await signUnsignedXdr(prepared.toXDR());
  const signed = TransactionBuilder.fromXDR(
    signedXdr,
    client.networkPassphrase,
  );
  const result = await client.server.sendTransaction(signed);
  if (result.status === "ERROR") {
    throw parseGovernorError(result);
  }
  const confirmed = await client.pollForConfirmation(result.hash);
  const returnVal = confirmed.returnValue;
  const proposalId = returnVal ? BigInt(scValToNative(returnVal)) : 0n;
  return { proposalId, txHash: result.hash };
}

/**
 * Simulate a single contract invocation (for validating calldata before proposing).
 */
export async function simulateTargetInvocation(
  client: GovernorClient,
  footprintSourceAccount: string,
  contractId: string,
  functionName: string,
  args: xdr.ScVal[],
): Promise<{
  ok: boolean;
  error?: string;
  cpuInsns?: string;
  memBytes?: string;
}> {
  return client.retry(async () => {
    const target = new Contract(contractId);
    const op = target.call(functionName, ...args);
    const result = await client.server.simulateTransaction(
      new TransactionBuilder(
        await client.server.getAccount(footprintSourceAccount),
        { fee: BASE_FEE, networkPassphrase: client.networkPassphrase },
      )
        .addOperation(op)
        .setTimeout(30)
        .build(),
    );

    if (SorobanRpc.Api.isSimulationError(result)) {
      const err = result as unknown as { error?: string };
      return { ok: false, error: err.error ?? "Simulation failed" };
    }
    const ok = result as SorobanRpc.Api.SimulateTransactionSuccessResponse & {
      cost?: { cpuInsns?: string; memBytes?: string };
    };
    return {
      ok: true,
      cpuInsns: ok.cost?.cpuInsns,
      memBytes: ok.cost?.memBytes,
    };
  });
}

/**
 * Simulate each action in a proposal and aggregate compute hints.
 */
export async function simulateProposal(
  client: GovernorClient,
  actions: ProposalAction[],
  sourceAccount?: string,
): Promise<ProposalSimulationResult> {
  return client.retry(async () => {
    try {
      let computeUnits = 0;
      const stateChanges: unknown[] = [];

      for (const action of actions) {
        const target = new Contract(action.target);
        const op = target.call(
          action.function,
          ...action.args.map((arg) => nativeToScVal(arg)),
        );
        const readAccount = client.readAccount(sourceAccount);
        const result = await client.server.simulateTransaction(
          new TransactionBuilder(
            await client.server.getAccount(readAccount),
            { fee: BASE_FEE, networkPassphrase: client.networkPassphrase },
          )
            .addOperation(op)
            .setTimeout(30)
            .build(),
        );

        if (SorobanRpc.Api.isSimulationError(result)) {
          const err = result as unknown as { error?: string };
          return {
            success: false,
            error: `Simulation failed: ${err.error ?? "unknown"}`,
          };
        }

        const success = result as SorobanRpc.Api.SimulateTransactionSuccessResponse & {
          result?: { cost?: { cpuInstructions?: number } } | null;
          cost?: { cpuInstructions?: number; cpuInsns?: string };
        };
        if (!success.result) {
          return { success: false, error: "No simulation result returned" };
        }

        const cost =
          success.result.cost?.cpuInstructions ??
          success.cost?.cpuInstructions ??
          Number(success.cost?.cpuInsns ?? 0);
        computeUnits += Number(cost ?? 0);
      }

      return { success: true, computeUnits, stateChanges };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Simulation failed",
      };
    }
  });
}

/** Resource hints for the full `propose` transaction (simulation only). */
export async function estimateProposeResources(
  client: GovernorClient,
  proposer: string,
  description: string,
  descriptionHash: string,
  metadataUri: string,
  targets: string[],
  fnNames: string[],
  calldatas: (Buffer | Uint8Array)[],
): Promise<{
  ok: boolean;
  error?: string;
  cpuInsns?: string;
  memBytes?: string;
}> {
  return client.retry(async () => {
    try {
      const hashBytes = hexToBytes32(descriptionHash);
      const account = await client.server.getAccount(proposer);
      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: client.networkPassphrase,
      })
        .addOperation(
          client.contract.call(
            "propose",
            nativeToScVal(proposer, { type: "address" }),
            nativeToScVal(description, { type: "string" }),
            nativeToScVal(hashBytes, { type: "bytes" }),
            nativeToScVal(metadataUri, { type: "string" }),
            scVecAddress(targets),
            scVecSymbol(fnNames),
            scVecBytes(calldatas),
          ),
        )
        .setTimeout(30)
        .build();

      const result = await client.server.simulateTransaction(tx);
      if (SorobanRpc.Api.isSimulationError(result)) {
        const err = result as unknown as { error?: string };
        return { ok: false, error: err.error ?? "Simulation failed" };
      }
      const ok = result as SorobanRpc.Api.SimulateTransactionSuccessResponse & {
        cost?: { cpuInsns?: string; memBytes?: string };
      };
      return {
        ok: true,
        cpuInsns: ok.cost?.cpuInsns,
        memBytes: ok.cost?.memBytes,
      };
    } catch (e: unknown) {
      return {
        ok: false,
        error: e instanceof Error ? e.message : "estimate failed",
      };
    }
  });
}

/**
 * Cancel a proposal (can only be done by the proposer while it's Pending).
 */
export async function cancel(
  client: GovernorClient,
  signer: Keypair,
  proposalId: bigint,
): Promise<void> {
  return client.retry(async () => {
    const account = await client.server.getAccount(signer.publicKey());

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: client.networkPassphrase,
    })
      .addOperation(
        client.contract.call(
          "cancel",
          nativeToScVal(signer.publicKey(), { type: "address" }),
          nativeToScVal(proposalId, { type: "u64" }),
        ),
      )
      .setTimeout(30)
      .build();

    const prepared = await client.server.prepareTransaction(tx);
    prepared.sign(signer);

    const result = await client.server.sendTransaction(prepared);
    if (result.status === "ERROR") {
      throw new Error(`Transaction failed: ${JSON.stringify(result)}`);
    }

    await client.pollForConfirmation(result.hash);
  }, (e) => client.isRetryableSubmissionError(e));
}

/**
 * Cancel a proposal via governance (must be called by the governor contract itself).
 *
 * This is typically used as an action in another proposal.
 *
 * @param signer The account authorizing the transaction (must be the governor itself if called directly)
 * @param proposalId The ID of the proposal to cancel
 */
export async function cancelByGovernance(
  client: GovernorClient,
  signer: Keypair,
  proposalId: bigint,
): Promise<void> {
  return client.retry(async () => {
    const account = await client.server.getAccount(signer.publicKey());

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: client.networkPassphrase,
    })
      .addOperation(
        client.contract.call(
          "cancel_by_governance",
          nativeToScVal(proposalId, { type: "u64" }),
        ),
      )
      .setTimeout(30)
      .build();

    const prepared = await client.server.prepareTransaction(tx);
    prepared.sign(signer);

    const result = await client.server.sendTransaction(prepared);
    if (result.status === "ERROR") {
      throw new Error(`Transaction failed: ${JSON.stringify(result)}`);
    }

    await client.pollForConfirmation(result.hash);
  }, (e) => client.isRetryableSubmissionError(e));
}

/**
 * Same as {@link cancelByGovernance} but signs with a wallet callback.
 */
export async function cancelByGovernanceWithSign(
  client: GovernorClient,
  signerPublicKey: string,
  proposalId: bigint,
  signUnsignedXdr: (xdr: string) => Promise<string>,
): Promise<void> {
  const account = await client.server.getAccount(signerPublicKey);

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: client.networkPassphrase,
  })
    .addOperation(
      client.contract.call(
        "cancel_by_governance",
        nativeToScVal(proposalId, { type: "u64" }),
      ),
    )
    .setTimeout(30)
    .build();

  const prepared = await client.server.prepareTransaction(tx);
  const signedXdr = await signUnsignedXdr(prepared.toXDR());
  const signed = TransactionBuilder.fromXDR(
    signedXdr,
    client.networkPassphrase,
  );

  const result = await client.server.sendTransaction(signed);
  if (result.status === "ERROR") {
    throw new Error(`Transaction failed: ${JSON.stringify(result)}`);
  }

  await client.pollForConfirmation(result.hash);
}

/**
 * Poll for a proposal to reach a specific state.
 * @param proposalId The proposal ID to monitor
 * @param targetState The state to wait for
 * @param options Polling options
 * @returns Promise that resolves when the target state is reached
 */
export async function waitForProposalState(
  client: GovernorClient,
  proposalId: bigint,
  targetState: ProposalState,
  options: { timeoutMs?: number; pollIntervalMs?: number } = {}
): Promise<void> {
  const { timeoutMs = 300000, pollIntervalMs = 5000 } = options; // 5 min default timeout, 5 sec poll
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const currentState = await getProposalState(client, proposalId);
    if (currentState === targetState) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error(
    `Timeout waiting for proposal ${proposalId} to reach state ${ProposalState[targetState]}`
  );
}

/**
 * Fetch a proposal by its ID.
 */
export async function getProposal(
  client: GovernorClient,
  proposalId: bigint,
): Promise<Proposal> {
  return client.retry(async () => {
    const result = await client.server.simulateTransaction(
      new TransactionBuilder(
        await client.server.getAccount(client.readAccount()),
        { fee: BASE_FEE, networkPassphrase: client.networkPassphrase }
      )
        .addOperation(
          client.contract.call("get_proposal", nativeToScVal(proposalId, { type: "u64" }))
        )
        .setTimeout(30)
        .build()
    );

    if (SorobanRpc.Api.isSimulationError(result)) {
      throw new Error(`Simulation error: ${result.error}`);
    }

    const raw = (result as SorobanRpc.Api.SimulateTransactionSuccessResponse)
      .result?.retval;
    if (!raw) throw new Error("No return value");

    return mapProposalNative(scValToNative(raw) as Record<string, unknown>);
  });
}

/**
 * Normalize the governor contract's snake_case `Proposal` struct (as returned
 * by `get_proposal`) into the camelCase {@link Proposal} used throughout the
 * SDK. Already-camelCase inputs are passed through unchanged.
 */
export function mapProposalNative(native: Record<string, unknown>): Proposal {
  const pick = <T>(camel: string, snake: string, fallback: T): T => {
    if (native[camel] !== undefined) return native[camel] as T;
    if (native[snake] !== undefined) return native[snake] as T;
    return fallback;
  };

  return {
    id: toBigInt(pick("id", "id", 0)),
    proposer: String(pick("proposer", "proposer", "")),
    description: String(pick("description", "description", "")),
    startLedger: Number(pick("startLedger", "start_ledger", 0)),
    endLedger: Number(pick("endLedger", "end_ledger", 0)),
    votesFor: toBigInt(pick("votesFor", "votes_for", 0)),
    votesAgainst: toBigInt(pick("votesAgainst", "votes_against", 0)),
    votesAbstain: toBigInt(pick("votesAbstain", "votes_abstain", 0)),
    executed: Boolean(pick("executed", "executed", false)),
    cancelled: Boolean(pick("cancelled", "cancelled", false)),
  };
}

/**
 * Fetch the ledger sequence when a proposal was queued.
 * Returns 0 if the proposal was not queued.
 */
export async function getQueueTime(
  client: GovernorClient,
  proposalId: bigint,
): Promise<number> {
  const result = await client.server.simulateTransaction(
    new TransactionBuilder(
      await client.server.getAccount(client.readAccount()),
      { fee: BASE_FEE, networkPassphrase: client.networkPassphrase }
    )
      .addOperation(
        client.contract.call("get_queue_time", nativeToScVal(proposalId, { type: "u64" }))
      )
      .setTimeout(30)
      .build()
  );

  if (SorobanRpc.Api.isSimulationError(result)) return 0;

  const raw = (result as SorobanRpc.Api.SimulateTransactionSuccessResponse)
    .result?.retval;
  return raw ? (scValToNative(raw) as number) : 0;
}

/**
 * Fetch the timelock operation IDs for a queued proposal.
 * Returns an empty array if the proposal has not been queued.
 */
export async function getQueuedOpIds(
  client: GovernorClient,
  proposalId: bigint,
): Promise<string[]> {
  return client.retry(async () => {
    const result = await client.server.simulateTransaction(
      new TransactionBuilder(
        await client.server.getAccount(client.readAccount()),
        { fee: BASE_FEE, networkPassphrase: client.networkPassphrase }
      )
        .addOperation(
          client.contract.call("get_queued_op_ids", nativeToScVal(proposalId, { type: "u64" }))
        )
        .setTimeout(30)
        .build()
    );

    if (SorobanRpc.Api.isSimulationError(result)) return [];

    const raw = (result as SorobanRpc.Api.SimulateTransactionSuccessResponse)
      .result?.retval;
    if (!raw) return [];

    const opIds = scValToNative(raw) as Buffer[] | string[];
    return opIds.map((id) => 
      Buffer.isBuffer(id) ? id.toString("hex") : id
    );
  });
}

/**
 * Fetch timelock-related timings for a queued proposal.
 */
export async function getTimelockInfo(
  client: GovernorClient,
  proposalId: bigint,
): Promise<import("../types").TimelockInfo> {
  const queueLedger = await getQueueTime(client, proposalId);
  if (queueLedger === 0) {
    throw new Error(`Proposal ${proposalId} not queued or not found`);
  }

  const [settings, timelockClient] = await Promise.all([
    getSettings(client),
    Promise.resolve(new TimelockClient(client.config)),
  ]);

  const [minDelay, executionWindow] = await Promise.all([
    timelockClient.minDelay(),
    timelockClient.executionWindow(),
  ]);

  // Conversion logic: roughly 1 ledger per 10 seconds for veto window
  // and for estimating executable/deadline ledgers.
  const votingDelay = settings.votingDelay;
  
  // Per requirement: Use QueueTime + voting_delay/10
  const vetoWindowEndLedger = queueLedger + Math.floor(votingDelay / 10);
  
  // Executable after min_delay
  const executableAtLedger = queueLedger + Math.floor(Number(minDelay) / 10);
  
  // Deadline after execution_window
  const executionDeadlineLedger = executableAtLedger + Math.floor(Number(executionWindow) / 10);

  return {
    queueLedger,
    vetoWindowEndLedger,
    executableAtLedger,
    executionDeadlineLedger,
  };
}

/**
 * Fetch multiple proposals in a single round-trip using parallel Promise.all.
 *
 * Reduces N sequential RPC calls to a single parallel batch. An optional
 * concurrency limit (default 10) prevents overwhelming the RPC endpoint.
 *
 * @param proposalIds Array of proposal IDs to fetch
 * @param concurrency Max simultaneous RPC calls (default 10)
 * @returns Array of results — resolved Proposal or Error for each ID
 */
export async function getProposalsBatch(
  client: GovernorClient,
  proposalIds: bigint[],
  concurrency = 10,
): Promise<Array<{ id: bigint; proposal?: Proposal; error?: Error }>> {
  const results: Array<{ id: bigint; proposal?: Proposal; error?: Error }> = [];

  for (let i = 0; i < proposalIds.length; i += concurrency) {
    const chunk = proposalIds.slice(i, i + concurrency);
    const settled = await Promise.allSettled(
      chunk.map((id) => getProposal(client, id)),
    );
    for (let j = 0; j < chunk.length; j++) {
      const outcome = settled[j];
      if (outcome.status === "fulfilled") {
        results.push({ id: chunk[j], proposal: outcome.value });
      } else {
        results.push({ id: chunk[j], error: outcome.reason as Error });
      }
    }
  }

  return results;
}

/**
 * Get the expiry ledger for a proposal (end ledger + grace period).
 */
export async function getProposalExpiryLedger(
  client: GovernorClient,
  proposalId: bigint,
): Promise<number> {
  const proposal = await getProposal(client, proposalId);
  const settings = await getSettings(client);
  return proposal.endLedger + settings.proposalGracePeriod;
}

/**
 * Validate settings before building or submitting an update_config proposal.
 */
export function validateGovernorSettings(
  newSettings: GovernorSettings,
  limits: GovernorSettingsValidationLimits = {},
): void {
  const maxVotingDelay = limits.maxVotingDelay ?? DEFAULT_MAX_VOTING_DELAY;
  const minVotingPeriod = limits.minVotingPeriod ?? DEFAULT_MIN_VOTING_PERIOD;

  if (
    !Number.isInteger(newSettings.votingDelay) ||
    newSettings.votingDelay < 0 ||
    newSettings.votingDelay > maxVotingDelay
  ) {
    throw new GovernorError(
      GovernorErrorCode.InvalidArguments,
      `votingDelay must be between 0 and ${maxVotingDelay}`,
    );
  }
  if (
    !Number.isInteger(newSettings.votingPeriod) ||
    newSettings.votingPeriod < minVotingPeriod
  ) {
    throw new GovernorError(
      GovernorErrorCode.InvalidArguments,
      `votingPeriod must be at least ${minVotingPeriod}`,
    );
  }
  if (
    !Number.isInteger(newSettings.quorumNumerator) ||
    newSettings.quorumNumerator <= 0 ||
    newSettings.quorumNumerator > 100
  ) {
    throw new GovernorError(
      GovernorErrorCode.InvalidArguments,
      "quorumNumerator must be greater than 0 and at most 100",
    );
  }
  if (newSettings.proposalThreshold < 0n) {
    throw new GovernorError(
      GovernorErrorCode.InvalidArguments,
      "proposalThreshold must be greater than or equal to 0",
    );
  }
  const commitPhaseFraction = newSettings.commitPhaseFraction ?? 5_000;
  if (
    !Number.isInteger(commitPhaseFraction) ||
    commitPhaseFraction <= 0 ||
    commitPhaseFraction >= 10_000
  ) {
    throw new GovernorError(
      GovernorErrorCode.InvalidArguments,
      "commitPhaseFraction must be a BPS value between 1 and 9999",
    );
  }
}

/**
 * Build calldata for an update_config proposal.
 *
 * Returns the target, function name, and encoded calldata to pass to propose().
 */
export function buildUpdateConfigProposal(
  client: GovernorClient,
  newSettings: GovernorSettings,
  limits: GovernorSettingsValidationLimits = {},
): {
  target: string;
  fnName: string;
  calldata: Uint8Array;
} {
  validateGovernorSettings(newSettings, limits);
  const useDynamicQuorum = newSettings.useDynamicQuorum ?? false;
  const minQuorumUsd = newSettings.minQuorumUsd ?? 0n;
  const maxCalldataSize = newSettings.maxCalldataSize ?? 10_000;
  const proposalCooldown = newSettings.proposalCooldown ?? 100;
  const maxProposalsPerPeriod = newSettings.maxProposalsPerPeriod ?? 5;
  const proposalPeriodDuration = newSettings.proposalPeriodDuration ?? 10_000;
  const useCommitReveal = newSettings.useCommitReveal ?? false;
  const commitPhaseFraction = newSettings.commitPhaseFraction ?? 5_000;

  const settingsScVal = xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("voting_delay"),
      val: nativeToScVal(newSettings.votingDelay, { type: "u32" }),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("voting_period"),
      val: nativeToScVal(newSettings.votingPeriod, { type: "u32" }),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("quorum_numerator"),
      val: nativeToScVal(newSettings.quorumNumerator, { type: "u32" }),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("proposal_threshold"),
      val: nativeToScVal(newSettings.proposalThreshold, { type: "i128" }),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("guardian"),
      val: nativeToScVal(newSettings.guardian, { type: "address" }),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("vote_type"),
      val: xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(newSettings.voteType)]),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("proposal_grace_period"),
      val: nativeToScVal(newSettings.proposalGracePeriod, { type: "u32" }),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("use_dynamic_quorum"),
      val: xdr.ScVal.scvBool(useDynamicQuorum),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("reflector_oracle"),
      val: newSettings.reflectorOracle
        ? nativeToScVal(newSettings.reflectorOracle, { type: "address" })
        : xdr.ScVal.scvVoid(),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("min_quorum_usd"),
      val: nativeToScVal(minQuorumUsd, { type: "i128" }),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("max_calldata_size"),
      val: nativeToScVal(maxCalldataSize, { type: "u32" }),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("proposal_cooldown"),
      val: nativeToScVal(proposalCooldown, { type: "u32" }),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("max_proposals_per_period"),
      val: nativeToScVal(maxProposalsPerPeriod, { type: "u32" }),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("proposal_period_duration"),
      val: nativeToScVal(proposalPeriodDuration, { type: "u32" }),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("use_commit_reveal"),
      val: xdr.ScVal.scvBool(useCommitReveal),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("commit_phase_fraction"),
      val: nativeToScVal(commitPhaseFraction, { type: "u32" }),
    }),
  ]);

  return {
    target: client.config.governorAddress,
    fnName: "update_config",
    // `update_config(new_settings: GovernorSettings)` takes exactly one arg.
    // The timelock/governor's calldata decoder always parses calldata bytes
    // as `Vec<Val>::from_xdr` (see contracts/timelock/src/lib.rs's
    // `decode_invocation_args` and governor's `decode_calldata_args`), so
    // the settings map must be wrapped as the single element of that vec —
    // encoding the bare map directly (as this used to do) fails that parse
    // and silently falls back to zero args on-chain, making every
    // update_config proposal revert at execution.
    calldata: xdr.ScVal.scvVec([settingsScVal]).toXDR(),
  };
}
