/**
 * Mock replica of `contracts/proposal-bonds/src/lib.rs`: `lock_bond`,
 * `refund_bond`, `slash` plus the `get_bond`/`get_settings` read paths
 * `ProposalBondsClient` wraps.
 *
 * Scope reductions (mirroring `treasury-executor`'s): there is no separate
 * SEP-41 token contract, so locking/refunding/slashing moves the bond
 * amount on the single ledger the harness models — `store.votes.balances` —
 * between the proposer, the bonds contract's own account, and the slash
 * recipient. `initialize`/`update_bond_amount` are out of scope: the
 * harness boots the configuration in via
 * `GovernorSimulationSettings.proposalBond*` instead.
 *
 * `refund_bond` reads the correlated governor proposal's description hash
 * and state in-process, standing in for the real contract's cross-contract
 * `GovernorClient` calls. `slash` is only reachable as the target of an
 * executed governance proposal — see `governor-executor`'s
 * `execute`, which dispatches proposal-bonds targets with the governor
 * contract itself as the caller.
 */
import { ProposalBondsErrorCode, GovernorErrorCode } from "@nebgov/sdk";
import { LedgerClock } from "../ledger";
import { MockContractError } from "./errors";
import { computeProposalState } from "./governor-executor";
import { MockLedgerStore, ProposalBondRecord } from "./store";

/** Normalize a `BytesN<32>` description hash (bytes or hex) to its hex key. */
function hashKey(descriptionHash: Uint8Array | string): string {
  return typeof descriptionHash === "string"
    ? descriptionHash.toLowerCase()
    : Buffer.from(descriptionHash).toString("hex");
}

/** `require_auth()` — the transaction source must be the declared signer. */
function requireSigner(caller: string, signer: string): void {
  if (caller !== signer) throw new Error("not authorized");
}

function mustGetBond(store: MockLedgerStore, key: string): ProposalBondRecord {
  const bond = store.proposalBonds.bonds.get(key);
  if (!bond) {
    throw new MockContractError(ProposalBondsErrorCode.BondNotFound, `bond ${key} not found`);
  }
  return bond;
}

/** The bond token transfer `lock_bond`/`refund_bond`/`slash` perform. */
function transfer(store: MockLedgerStore, from: string, to: string, amount: bigint): void {
  const fromBalance = store.votes.balances.get(from) ?? 0n;
  if (fromBalance < amount) {
    throw new Error("insufficient balance");
  }
  store.votes.balances.set(from, fromBalance - amount);
  store.votes.balances.set(to, (store.votes.balances.get(to) ?? 0n) + amount);
}

export const proposalBondsExecutor = {
  lock_bond(store: MockLedgerStore, clock: LedgerClock, caller: string, args: unknown[]): null {
    const [proposer, descriptionHash] = args as [string, Uint8Array];
    requireSigner(caller, proposer);

    const key = hashKey(descriptionHash);
    if (store.proposalBonds.bonds.has(key)) {
      throw new MockContractError(
        ProposalBondsErrorCode.BondAlreadyLocked,
        "lock_bond: bond already locked for this description hash",
      );
    }

    // `bondToken` is stored verbatim for `get_settings` reporting; the
    // amount always moves on `store.votes.balances`, the one ledger the mock models.
    const { bondAmount } = store.proposalBonds;
    if (bondAmount <= 0n) {
      throw new MockContractError(ProposalBondsErrorCode.NotInitialized, "lock_bond: invalid bond amount");
    }
    transfer(store, proposer, store.addresses.proposalBonds, bondAmount);

    store.proposalBonds.bonds.set(key, {
      proposer,
      descriptionHash: key,
      amount: bondAmount,
      lockedLedger: clock.sequence,
      state: "Locked",
    });
    return null;
  },

  refund_bond(store: MockLedgerStore, clock: LedgerClock, caller: string, args: unknown[]): null {
    const [refundCaller, descriptionHash, proposalId] = args as [string, Uint8Array, bigint];
    requireSigner(caller, refundCaller);

    const key = hashKey(descriptionHash);
    const bond = mustGetBond(store, key);
    if (bond.state !== "Locked") {
      throw new MockContractError(ProposalBondsErrorCode.BondNotLocked, "refund_bond: bond is not locked");
    }

    // Escape hatch: past `MaxLockLedgers` the refund is unconditional, no
    // governor cross-call (the proposal may be stuck in `Queued` forever).
    const pastMaxLock = clock.sequence >= bond.lockedLedger + store.proposalBonds.maxLockLedgers;
    if (!pastMaxLock) {
      const proposal = store.governor.proposals.get(proposalId);
      if (!proposal) {
        throw new MockContractError(GovernorErrorCode.ProposalNotFound, `refund_bond: proposal ${proposalId} not found`);
      }
      if (proposal.descriptionHash !== key) {
        throw new MockContractError(
          ProposalBondsErrorCode.DescriptionHashMismatch,
          "refund_bond: proposal description hash does not match this bond",
        );
      }

      const state = computeProposalState(store, clock, proposal);
      const isTerminal =
        state === "Executed" || state === "Defeated" || state === "Expired" || state === "Cancelled";
      if (!isTerminal) {
        throw new MockContractError(
          ProposalBondsErrorCode.ProposalNotTerminal,
          `refund_bond: proposal ${proposalId} is not terminal (state ${state})`,
        );
      }

      // The grace window after voting closed gives the community time to
      // submit a `slash` governance proposal before funds move.
      if (clock.sequence < proposal.endLedger + store.proposalBonds.refundGraceLedgers) {
        throw new MockContractError(
          ProposalBondsErrorCode.RefundGraceNotElapsed,
          "refund_bond: refund grace window has not elapsed",
        );
      }
    }

    transfer(store, store.addresses.proposalBonds, bond.proposer, bond.amount);
    bond.state = "Refunded";
    return null;
  },

  slash(store: MockLedgerStore, _clock: LedgerClock, caller: string, args: unknown[]): null {
    const [slashCaller, descriptionHash, recipient] = args as [string, Uint8Array, string];
    requireSigner(caller, slashCaller);
    if (slashCaller !== store.proposalBonds.governor) {
      throw new MockContractError(ProposalBondsErrorCode.NotAuthorized, "slash: only the governor may slash a bond");
    }

    const bond = mustGetBond(store, hashKey(descriptionHash));
    if (bond.state !== "Locked") {
      throw new MockContractError(ProposalBondsErrorCode.BondNotLocked, "slash: bond is not locked");
    }

    transfer(store, store.addresses.proposalBonds, recipient, bond.amount);
    bond.state = "Slashed";
    return null;
  },

  get_bond(store: MockLedgerStore, _clock: LedgerClock, _caller: string, args: unknown[]): ProposalBondRecord | null {
    const [descriptionHash] = args as [Uint8Array];
    return store.proposalBonds.bonds.get(hashKey(descriptionHash)) ?? null;
  },

  get_settings(
    store: MockLedgerStore,
    _clock: LedgerClock,
    _caller: string,
    _args: unknown[],
  ): Pick<
    MockLedgerStore["proposalBonds"],
    "bondToken" | "bondAmount" | "governor" | "refundGraceLedgers" | "maxLockLedgers"
  > {
    const { bondToken, bondAmount, governor, refundGraceLedgers, maxLockLedgers } = store.proposalBonds;
    return { bondToken, bondAmount, governor, refundGraceLedgers, maxLockLedgers };
  },
};

export type ProposalBondsFunction = keyof typeof proposalBondsExecutor;
