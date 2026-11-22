#![no_std]

pub mod error;
mod events;

use crate::error::ProposalBondsError;
use soroban_sdk::{
    contract, contractclient, contractimpl, contracttype, token, Address, Bytes, BytesN, Env,
    String, Symbol, Vec,
};

/// Mirrors `contracts/governor`'s `Proposal` and `ProposalState` types
/// field-for-field so cross-contract calls decode correctly, without taking
/// a crate dependency on governor (which is already near the CI WASM size
/// cap and must not be modified for this feature).
#[contracttype]
#[derive(Clone)]
pub struct Proposal {
    pub id: u64,
    pub proposer: Address,
    pub description: String,
    pub description_hash: BytesN<32>,
    pub metadata_uri: String,
    pub targets: Vec<Address>,
    pub fn_names: Vec<Symbol>,
    pub calldatas: Vec<Bytes>,
    pub start_ledger: u32,
    pub end_ledger: u32,
    pub votes_for: i128,
    pub votes_against: i128,
    pub votes_abstain: i128,
    pub executed: bool,
    pub cancelled: bool,
    pub queued: bool,
    pub op_ids: Vec<Bytes>,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum ProposalState {
    Pending,
    Active,
    Defeated,
    Succeeded,
    Queued,
    Executed,
    Cancelled,
    Expired,
}

#[contractclient(name = "GovernorClient")]
pub trait GovernorTrait {
    fn get_proposal(env: Env, proposal_id: u64) -> Proposal;
    fn state(env: Env, proposal_id: u64) -> ProposalState;
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum BondState {
    Locked,
    Refunded,
    Slashed,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct Bond {
    pub proposer: Address,
    pub description_hash: BytesN<32>,
    pub amount: i128,
    pub locked_ledger: u32,
    pub state: BondState,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct BondSettings {
    pub bond_token: Address,
    pub bond_amount: i128,
    pub governor: Address,
    pub refund_grace_ledgers: u32,
    pub max_lock_ledgers: u32,
}

#[contracttype]
pub enum DataKey {
    Admin,
    BondToken,
    BondAmount,
    Governor,
    Bond(BytesN<32>),
    RefundGraceLedgers,
    MaxLockLedgers,
    /// The token a bond was locked in, captured at `lock_bond` time so a
    /// later `update_settings` that changes `BondToken` can never make
    /// `refund_bond`/`slash` pay out an asset the bond was not posted in.
    BondTokenOf(BytesN<32>),
}

/// ~1,000,000 ledgers (~58 days at the network's ~5s ledger close time),
/// generously covering the longest realistic proposal lifecycle plus its
/// post-terminal refund grace window.
const BOND_TTL_LEDGERS: u32 = 1_000_000;

#[contract]
pub struct ProposalBondsContract;

#[contractimpl]
impl ProposalBondsContract {
    pub fn initialize(
        env: Env,
        admin: Address,
        bond_token: Address,
        bond_amount: i128,
        governor: Address,
        refund_grace_ledgers: u32,
        max_lock_ledgers: u32,
    ) {
        admin.require_auth();
        if env.storage().instance().has(&DataKey::Admin) {
            env.panic_with_error(ProposalBondsError::AlreadyInitialized);
        }
        if bond_amount <= 0 {
            env.panic_with_error(ProposalBondsError::InvalidBondAmount);
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::BondToken, &bond_token);
        env.storage().instance().set(&DataKey::BondAmount, &bond_amount);
        env.storage().instance().set(&DataKey::Governor, &governor);
        env.storage()
            .instance()
            .set(&DataKey::RefundGraceLedgers, &refund_grace_ledgers);
        env.storage()
            .instance()
            .set(&DataKey::MaxLockLedgers, &max_lock_ledgers);
    }

    fn must_get_bond(env: &Env, description_hash: &BytesN<32>) -> Bond {
        env.storage()
            .persistent()
            .get(&DataKey::Bond(description_hash.clone()))
            .unwrap_or_else(|| env.panic_with_error(ProposalBondsError::BondNotFound))
    }

    fn get_governor(env: &Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Governor)
            .unwrap_or_else(|| env.panic_with_error(ProposalBondsError::NotInitialized))
    }

    fn get_bond_token(env: &Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::BondToken)
            .unwrap_or_else(|| env.panic_with_error(ProposalBondsError::NotInitialized))
    }

    /// The token `description_hash`'s bond was locked in. Falls back to the
    /// current `BondToken` for a bond with no recorded token.
    fn locked_bond_token(env: &Env, description_hash: &BytesN<32>) -> Address {
        env.storage()
            .persistent()
            .get(&DataKey::BondTokenOf(description_hash.clone()))
            .unwrap_or_else(|| Self::get_bond_token(env))
    }

    fn require_admin(env: &Env, admin: &Address) {
        let stored_admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .unwrap_or_else(|| env.panic_with_error(ProposalBondsError::NotInitialized));
        admin.require_auth();
        if admin != &stored_admin {
            env.panic_with_error(ProposalBondsError::NotAuthorized);
        }
    }

    /// Bounds on the refund windows. A `max_lock_ledgers` of 0 would open the
    /// refund escape hatch in the same ledger a bond is locked, one no longer
    /// than `refund_grace_ledgers` would let the escape hatch pre-empt the
    /// slashing window, and one longer than `BOND_TTL_LEDGERS` would let the
    /// bond entry be archived before the escape hatch opens.
    fn validate_lock_window(env: &Env, refund_grace_ledgers: u32, max_lock_ledgers: u32) {
        if max_lock_ledgers == 0
            || max_lock_ledgers <= refund_grace_ledgers
            || max_lock_ledgers > BOND_TTL_LEDGERS
        {
            env.panic_with_error(ProposalBondsError::InvalidLockWindow);
        }
    }

    /// Lock the configured bond amount from `proposer`, keyed by
    /// `description_hash` so it correlates 1:1 with the governor proposal
    /// the caller submits alongside it (bonding and proposing are two
    /// separate transactions, correlated off-chain by this shared hash).
    /// If a bond already exists for this hash in a terminal state (Refunded
    /// or Slashed), it will be overwritten.
    pub fn lock_bond(env: Env, proposer: Address, description_hash: BytesN<32>) {
        proposer.require_auth();

        if let Some(existing_bond) = env
            .storage()
            .persistent()
            .get::<_, Bond>(&DataKey::Bond(description_hash.clone()))
        {
            if existing_bond.state == BondState::Locked {
                env.panic_with_error(ProposalBondsError::BondAlreadyLocked);
            }
        }

        let bond_amount: i128 = env
            .storage()
            .instance()
            .get(&DataKey::BondAmount)
            .unwrap_or_else(|| env.panic_with_error(ProposalBondsError::NotInitialized));
        let bond_token = Self::get_bond_token(&env);

        token::TokenClient::new(&env, &bond_token).transfer(
            &proposer,
            &env.current_contract_address(),
            &bond_amount,
        );

        let bond = Bond {
            proposer: proposer.clone(),
            description_hash: description_hash.clone(),
            amount: bond_amount,
            locked_ledger: env.ledger().sequence(),
            state: BondState::Locked,
        };
        env.storage()
            .persistent()
            .set(&DataKey::Bond(description_hash.clone()), &bond);
        env.storage()
            .persistent()
            .set(&DataKey::BondTokenOf(description_hash.clone()), &bond_token);
        // A locked bond must outlive the full governor proposal lifecycle
        // (voting delay + voting period + grace period) plus this contract's
        // own post-terminal RefundGraceLedgers window before refund_bond or
        // slash can act on it, so bump its TTL by a generous fixed buffer
        // rather than trying to read governor's settings cross-contract here.
        env.storage().persistent().extend_ttl(
            &DataKey::Bond(description_hash.clone()),
            BOND_TTL_LEDGERS,
            BOND_TTL_LEDGERS,
        );
        env.storage().persistent().extend_ttl(
            &DataKey::BondTokenOf(description_hash.clone()),
            BOND_TTL_LEDGERS,
            BOND_TTL_LEDGERS,
        );

        events::emit_bond_locked(&env, &proposer, &description_hash, bond_amount);
    }

    /// Refund a locked bond once its matching governor proposal (identified
    /// by `proposal_id`, whose `description_hash` must match this bond's)
    /// has reached a terminal, non-malicious state and the post-terminal
    /// `RefundGraceLedgers` window — during which the community can instead
    /// submit a `slash` governance proposal — has elapsed. Permissionless:
    /// anyone may trigger it, but funds always return to the original
    /// proposer.
    ///
    /// Escape hatch: `ProposalState::Queued` is deliberately *not* treated
    /// as terminal here — a queued proposal can still be executed, so
    /// refunding early would let a proposer walk away from their bond while
    /// their proposal might still land. But governor's `state()` has no
    /// path out of `Queued` if the timelock operation's execution window
    /// closes without `execute()` ever being called (querying that
    /// correctly would mean cross-calling into `contracts/timelock` too,
    /// mirroring its ready/expiry math — out of scope here), so a bond
    /// behind such a proposal would otherwise be locked forever. Once
    /// `MaxLockLedgers` has elapsed since `lock_bond`, refund is allowed
    /// unconditionally, regardless of the correlated proposal's state.
    pub fn refund_bond(env: Env, caller: Address, description_hash: BytesN<32>, proposal_id: u64) {
        caller.require_auth();

        let mut bond = Self::must_get_bond(&env, &description_hash);
        if bond.state != BondState::Locked {
            env.panic_with_error(ProposalBondsError::BondNotLocked);
        }

        let max_lock_ledgers: u32 = env
            .storage()
            .instance()
            .get(&DataKey::MaxLockLedgers)
            .unwrap_or(BOND_TTL_LEDGERS);
        let escape_hatch_ledger = bond.locked_ledger.saturating_add(max_lock_ledgers);
        let past_max_lock = env.ledger().sequence() >= escape_hatch_ledger;

        if !past_max_lock {
            let governor = Self::get_governor(&env);
            let governor_client = GovernorClient::new(&env, &governor);

            let proposal = governor_client.get_proposal(&proposal_id);
            if proposal.description_hash != description_hash {
                env.panic_with_error(ProposalBondsError::DescriptionHashMismatch);
            }

            let state = governor_client.state(&proposal_id);
            let is_terminal = matches!(
                state,
                ProposalState::Executed
                    | ProposalState::Defeated
                    | ProposalState::Expired
                    | ProposalState::Cancelled
            );
            if !is_terminal {
                env.panic_with_error(ProposalBondsError::ProposalNotTerminal);
            }

            // Gate refunds on `proposal.end_ledger` (the ledger voting closed
            // and the proposal became terminal-bound) rather than tracking a
            // separate "first observed terminal" ledger locally: it's
            // already returned by `get_proposal`, deterministic across
            // repeated calls, and gives the community a fixed
            // `RefundGraceLedgers` window after voting ends to submit a
            // `slash` proposal before funds move.
            let grace_ledgers: u32 = env
                .storage()
                .instance()
                .get(&DataKey::RefundGraceLedgers)
                .unwrap_or(0);
            let refund_eligible_ledger = proposal.end_ledger.saturating_add(grace_ledgers);
            if env.ledger().sequence() < refund_eligible_ledger {
                env.panic_with_error(ProposalBondsError::RefundGraceNotElapsed);
            }
        }

        let bond_token = Self::locked_bond_token(&env, &description_hash);
        token::TokenClient::new(&env, &bond_token).transfer(
            &env.current_contract_address(),
            &bond.proposer,
            &bond.amount,
        );

        bond.state = BondState::Refunded;
        env.storage()
            .persistent()
            .set(&DataKey::Bond(description_hash.clone()), &bond);

        events::emit_bond_refunded(&env, &description_hash, &bond.proposer, bond.amount);
    }

    /// Slash a locked bond, sending its funds to `recipient` instead of the
    /// proposer. Only callable as the target of an executed governance
    /// proposal (i.e. `caller` must be the governor contract's own
    /// address) — this is how the community judges a proposal to have been
    /// spam, duplicated, or malicious.
    pub fn slash(env: Env, caller: Address, description_hash: BytesN<32>, recipient: Address) {
        caller.require_auth();

        let governor = Self::get_governor(&env);
        if caller != governor {
            env.panic_with_error(ProposalBondsError::NotAuthorized);
        }

        let mut bond = Self::must_get_bond(&env, &description_hash);
        if bond.state != BondState::Locked {
            env.panic_with_error(ProposalBondsError::BondNotLocked);
        }

        let bond_token = Self::locked_bond_token(&env, &description_hash);
        token::TokenClient::new(&env, &bond_token).transfer(
            &env.current_contract_address(),
            &recipient,
            &bond.amount,
        );

        bond.state = BondState::Slashed;
        env.storage()
            .persistent()
            .set(&DataKey::Bond(description_hash.clone()), &bond);

        events::emit_bond_slashed(&env, &description_hash, &bond.proposer, bond.amount, &recipient);
    }

    pub fn get_bond(env: Env, description_hash: BytesN<32>) -> Option<Bond> {
        env.storage()
            .persistent()
            .get(&DataKey::Bond(description_hash))
    }

    pub fn update_bond_amount(env: Env, admin: Address, new_amount: i128) {
        let stored_admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .unwrap_or_else(|| env.panic_with_error(ProposalBondsError::NotInitialized));
        admin.require_auth();
        if admin != stored_admin {
            env.panic_with_error(ProposalBondsError::NotAuthorized);
        }
        if new_amount <= 0 {
            env.panic_with_error(ProposalBondsError::InvalidBondAmount);
        }
        let old_amount: i128 = env
            .storage()
            .instance()
            .get(&DataKey::BondAmount)
            .unwrap_or(0);
        env.storage().instance().set(&DataKey::BondAmount, &new_amount);
        events::emit_bond_amount_updated(&env, &admin, old_amount, new_amount);
    }

    /// Admin-only: replace the bond token, governor, `RefundGraceLedgers` and
    /// `MaxLockLedgers` (the bond amount has its own `update_bond_amount`).
    ///
    /// - `bond_token` applies to bonds locked from now on. A bond that is
    ///   already locked is always refunded or slashed in the token it was
    ///   locked in.
    /// - `governor` is the contract `refund_bond` queries and the only caller
    ///   `slash` accepts, so point it at a redeployed governor here. Bonds
    ///   whose proposals live on the old governor can no longer be looked up
    ///   there and are refundable once `MaxLockLedgers` has passed.
    /// - `refund_grace_ledgers` and `max_lock_ledgers` are read when a bond is
    ///   refunded, so they apply to bonds that are already locked too.
    pub fn update_settings(
        env: Env,
        admin: Address,
        bond_token: Address,
        governor: Address,
        refund_grace_ledgers: u32,
        max_lock_ledgers: u32,
    ) {
        Self::require_admin(&env, &admin);
        Self::validate_lock_window(&env, refund_grace_ledgers, max_lock_ledgers);

        let storage = env.storage().instance();
        storage.set(&DataKey::BondToken, &bond_token);
        storage.set(&DataKey::Governor, &governor);
        storage.set(&DataKey::RefundGraceLedgers, &refund_grace_ledgers);
        storage.set(&DataKey::MaxLockLedgers, &max_lock_ledgers);

        events::emit_settings_updated(
            &env,
            &admin,
            &bond_token,
            &governor,
            refund_grace_ledgers,
            max_lock_ledgers,
        );
    }

    /// Admin-only: hand the admin role to `new_admin`. Takes effect
    /// immediately; `admin` loses the role in the same call.
    pub fn set_admin(env: Env, admin: Address, new_admin: Address) {
        Self::require_admin(&env, &admin);
        env.storage().instance().set(&DataKey::Admin, &new_admin);
        events::emit_admin_updated(&env, &admin, &new_admin);
    }

    /// Read-only settings snapshot — lets callers (e.g. the frontend) work
    /// out refund eligibility for a `Locked` bond without guessing at
    /// `RefundGraceLedgers`/`MaxLockLedgers`.
    pub fn get_settings(env: Env) -> BondSettings {
        BondSettings {
            bond_token: Self::get_bond_token(&env),
            bond_amount: env
                .storage()
                .instance()
                .get(&DataKey::BondAmount)
                .unwrap_or_else(|| env.panic_with_error(ProposalBondsError::NotInitialized)),
            governor: Self::get_governor(&env),
            refund_grace_ledgers: env
                .storage()
                .instance()
                .get(&DataKey::RefundGraceLedgers)
                .unwrap_or(0),
            max_lock_ledgers: env
                .storage()
                .instance()
                .get(&DataKey::MaxLockLedgers)
                .unwrap_or(BOND_TTL_LEDGERS),
        }
    }
}

#[cfg(test)]
mod tests;
