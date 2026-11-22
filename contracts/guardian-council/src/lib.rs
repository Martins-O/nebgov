#![no_std]

//! Guardian Council (Issue #995).
//!
//! An M-of-N multisig that can stand in as `contracts/governor`'s emergency
//! `guardian` instead of a single key. Governor is **not** modified: its
//! `guardian` is already a plain `Address`, and a contract-initiated call is
//! authorized by Soroban as coming from the calling contract's own address
//! with no signature. So governance sets this contract as its guardian via
//! governor's existing `set_guardian()`, and thereafter this contract calls
//! `governor.pause(&self_address)` / `cancel(&self_address, id)` / etc. from
//! inside `execute_action` once `threshold` members have approved.
//!
//! Membership rotation and threshold changes are themselves council actions —
//! there is no bare setter.

pub mod error;
mod events;

use crate::error::GuardianCouncilError;
use soroban_sdk::{
    contract, contractclient, contractimpl, contracttype, Address, Env, Symbol, Vec,
};

// ── Governor interface (mirrored, no crate dependency — governor is near the
//    CI WASM size cap and must not be touched) ──────────────────────────────
#[contractclient(name = "GovernorClient")]
pub trait GovernorTrait {
    fn pause(env: Env, caller: Address);
    fn unpause(env: Env, caller: Address);
    fn cancel(env: Env, caller: Address, proposal_id: u64);
    fn cancel_queued(env: Env, caller: Address, proposal_id: u64);
    fn is_paused(env: Env) -> bool;
}

/// Swap one sitting member (`old`) for a newcomer (`new`) in a single action.
/// A dedicated struct because `#[contracttype]` enum variants cannot carry
/// named fields.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct MemberRotation {
    pub old: Address,
    pub new: Address,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum GuardianAction {
    Pause,
    Unpause,
    CancelActive(u64),
    CancelQueued(u64),
    RotateMember(MemberRotation),
    SetThreshold(u32),
    /// Update the per-action expiry window (ledgers). A value of `0` disables
    /// expiry entirely — pending actions will never expire.
    SetActionTtl(u32),
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct PendingAction {
    pub id: u64,
    pub action: GuardianAction,
    pub proposer: Address,
    pub created_ledger: u32,
    /// Snapshotted when proposed; zero means no expiry.
    pub expires_ledger: u32,
    pub approvals: Vec<Address>,
    pub cancellation_approvals: Vec<Address>,
    pub executed: bool,
    pub cancelled: bool,
}

#[contracttype]
pub enum DataKey {
    Deployer,
    Members,
    Threshold,
    Governor,
    NextActionId,
    Action(u64),
    ActionTtlLedgers,
}

/// Pending actions and the members list are long-lived; bump their TTL by this
/// on every write. ~1.2M ledgers ≈ 70 days at ~5s close time.
const COUNCIL_TTL_LEDGERS: u32 = 1_200_000;

#[contract]
pub struct GuardianCouncilContract;

pub const INSTANCE_TTL_THRESHOLD: u32 = 100_000;
pub const INSTANCE_EXTEND_TTL: u32 = 300_000;

pub(crate) fn extend_instance_ttl(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_EXTEND_TTL);
}

#[contractimpl]
impl GuardianCouncilContract {
    /// Bind the initializer to the deploy transaction before the first call.
    pub fn __constructor(env: Env, deployer: Address) {
        env.storage().instance().set(&DataKey::Deployer, &deployer);
    }

    pub fn initialize(
        env: Env,
        deployer: Address,
        members: Vec<Address>,
        threshold: u32,
        governor: Address,
        action_ttl_ledgers: u32,
    ) {
        deployer.require_auth();
        let expected_deployer: Address = env
            .storage()
            .instance()
            .get(&DataKey::Deployer)
            .unwrap_or_else(|| env.panic_with_error(GuardianCouncilError::NotAuthorized));
        if deployer != expected_deployer {
            env.panic_with_error(GuardianCouncilError::NotAuthorized);
        }
        if env.storage().instance().has(&DataKey::Governor) {
            env.panic_with_error(GuardianCouncilError::AlreadyInitialized);
        }
        if members.is_empty() {
            env.panic_with_error(GuardianCouncilError::InvalidMembers);
        }
        if threshold == 0 || threshold > members.len() {
            env.panic_with_error(GuardianCouncilError::InvalidThreshold);
        }
        // Reject duplicate members so approval counting stays sound.
        for i in 0..members.len() {
            for j in (i + 1)..members.len() {
                if members.get_unchecked(i) == members.get_unchecked(j) {
                    env.panic_with_error(GuardianCouncilError::DuplicateMember);
                }
            }
        }

        env.storage().instance().set(&DataKey::Members, &members);
        env.storage()
            .instance()
            .set(&DataKey::Threshold, &threshold);
        env.storage().instance().set(&DataKey::Governor, &governor);
        env.storage().instance().set(&DataKey::NextActionId, &0u64);
        env.storage()
            .instance()
            .set(&DataKey::ActionTtlLedgers, &action_ttl_ledgers);
    }

    /// A member proposes an action and auto-approves it as the first signer.
    pub fn propose_action(env: Env, proposer: Address, action: GuardianAction) -> u64 {
        extend_instance_ttl(&env);
        proposer.require_auth();
        Self::require_member(&env, &proposer);

        let id: u64 = env
            .storage()
            .instance()
            .get(&DataKey::NextActionId)
            .unwrap_or(0);
        env.storage()
            .instance()
            .set(&DataKey::NextActionId, &(id + 1));

        let mut approvals = Vec::new(&env);
        approvals.push_back(proposer.clone());

        let created_ledger = env.ledger().sequence();
        let ttl: u32 = env
            .storage()
            .instance()
            .get(&DataKey::ActionTtlLedgers)
            .unwrap_or(0);
        let pending = PendingAction {
            id,
            action: action.clone(),
            proposer: proposer.clone(),
            created_ledger,
            expires_ledger: if ttl == 0 {
                0
            } else {
                created_ledger.saturating_add(ttl)
            },
            approvals,
            cancellation_approvals: Vec::new(&env),
            executed: false,
            cancelled: false,
        };
        Self::put_action(&env, &pending);

        events::emit_action_proposed(&env, id, &proposer, Self::action_kind(&env, &action));
        events::emit_action_approved(&env, id, &proposer, 1);
        id
    }

    pub fn approve_action(env: Env, member: Address, action_id: u64) {
        extend_instance_ttl(&env);
        member.require_auth();
        Self::require_member(&env, &member);

        let mut pending = Self::must_get_action(&env, action_id);
        if pending.executed {
            env.panic_with_error(GuardianCouncilError::AlreadyExecuted);
        }
        if pending.cancelled {
            env.panic_with_error(GuardianCouncilError::ActionCancelled);
        }
        // Double-approval from the same member does not double-count.
        if !pending.approvals.contains(&member) {
            pending.approvals.push_back(member.clone());
            Self::put_action(&env, &pending);
        }
        events::emit_action_approved(&env, action_id, &member, pending.approvals.len());
    }

    pub fn revoke_approval(env: Env, member: Address, action_id: u64) {
        extend_instance_ttl(&env);
        member.require_auth();

        let mut pending = Self::must_get_action(&env, action_id);
        if pending.executed {
            env.panic_with_error(GuardianCouncilError::AlreadyExecuted);
        }
        match pending.approvals.first_index_of(&member) {
            Some(idx) => {
                pending.approvals.remove(idx);
                Self::put_action(&env, &pending);
                events::emit_approval_revoked(&env, action_id, &member);
            }
            None => env.panic_with_error(GuardianCouncilError::NotApproved),
        }
    }

    /// The proposer may withdraw immediately. Other members record cancellation
    /// approvals; the action is cancelled once the council threshold is met.
    pub fn cancel_action(env: Env, member: Address, action_id: u64) {
        extend_instance_ttl(&env);
        member.require_auth();
        Self::require_member(&env, &member);
        let mut pending = Self::must_get_action(&env, action_id);
        if pending.executed {
            env.panic_with_error(GuardianCouncilError::AlreadyExecuted);
        }
        if pending.cancelled {
            env.panic_with_error(GuardianCouncilError::ActionCancelled);
        }
        if member == pending.proposer {
            pending.cancelled = true;
        } else {
            if !pending.cancellation_approvals.contains(&member) {
                pending.cancellation_approvals.push_back(member.clone());
            }
            pending.cancelled = pending.cancellation_approvals.len() >= Self::threshold(&env);
        }
        Self::put_action(&env, &pending);
        if pending.cancelled {
            events::emit_action_cancelled(&env, action_id, &member);
        }
    }

    /// Permissionless once approvals ≥ threshold and the action is still
    /// within its TTL window. Dispatches on the action variant.
    pub fn execute_action(env: Env, action_id: u64) {
        extend_instance_ttl(&env);
        let mut pending = Self::must_get_action(&env, action_id);
        if pending.executed {
            env.panic_with_error(GuardianCouncilError::AlreadyExecuted);
        }
        if pending.cancelled {
            env.panic_with_error(GuardianCouncilError::ActionCancelled);
        }

        // Only members who are *still* members at execution time count — a
        // rotation could have removed an earlier approver.
        let members = Self::members(&env);
        let live_approvals: u32 = pending
            .approvals
            .iter()
            .filter(|a| members.contains(a))
            .count() as u32;
        if live_approvals < Self::threshold(&env) {
            env.panic_with_error(GuardianCouncilError::ThresholdNotMet);
        }

        if pending.expires_ledger > 0 && env.ledger().sequence() > pending.expires_ledger {
            env.panic_with_error(GuardianCouncilError::ActionExpired);
        }

        match pending.action.clone() {
            GuardianAction::Pause => {
                Self::governor_client(&env).pause(&env.current_contract_address())
            }
            GuardianAction::Unpause => {
                Self::governor_client(&env).unpause(&env.current_contract_address())
            }
            GuardianAction::CancelActive(pid) => {
                Self::governor_client(&env).cancel(&env.current_contract_address(), &pid)
            }
            GuardianAction::CancelQueued(pid) => {
                Self::governor_client(&env).cancel_queued(&env.current_contract_address(), &pid)
            }
            GuardianAction::RotateMember(r) => Self::do_rotate(&env, &r.old, &r.new),
            GuardianAction::SetThreshold(new_threshold) => {
                Self::do_set_threshold(&env, new_threshold)
            }
            GuardianAction::SetActionTtl(new_ttl) => Self::do_set_action_ttl(&env, new_ttl),
        }

        pending.executed = true;
        Self::put_action(&env, &pending);
        events::emit_action_executed(&env, action_id);
    }

    // ── Views ────────────────────────────────────────────────────────────
    pub fn get_action(env: Env, action_id: u64) -> PendingAction {
        extend_instance_ttl(&env);
        Self::must_get_action(&env, action_id)
    }

    pub fn get_action_count(env: Env) -> u64 {
        extend_instance_ttl(&env);
        env.storage()
            .instance()
            .get(&DataKey::NextActionId)
            .unwrap_or(0)
    }

    pub fn get_actions(env: Env, offset: u64, limit: u32) -> Vec<PendingAction> {
        extend_instance_ttl(&env);
        let count = Self::get_action_count(env.clone());
        let end = offset.saturating_add(limit as u64).min(count);
        let mut actions = Vec::new(&env);
        for id in offset..end {
            actions.push_back(Self::must_get_action(&env, id));
        }
        actions
    }

    pub fn get_members(env: Env) -> Vec<Address> {
        extend_instance_ttl(&env);
        Self::members(&env)
    }

    pub fn get_threshold(env: Env) -> u32 {
        extend_instance_ttl(&env);
        Self::threshold(&env)
    }

    pub fn get_governor(env: Env) -> Address {
        extend_instance_ttl(&env);
        env.storage()
            .instance()
            .get(&DataKey::Governor)
            .unwrap_or_else(|| env.panic_with_error(GuardianCouncilError::NotInitialized))
    }

    /// Returns the current action TTL in ledgers. `0` means no expiry.
    pub fn get_action_ttl(env: Env) -> u32 {
        extend_instance_ttl(&env);
        env.storage()
            .instance()
            .get(&DataKey::ActionTtlLedgers)
            .unwrap_or(0)
    }

    // ── Internals ────────────────────────────────────────────────────────
    fn members(env: &Env) -> Vec<Address> {
        env.storage()
            .instance()
            .get(&DataKey::Members)
            .unwrap_or_else(|| env.panic_with_error(GuardianCouncilError::NotInitialized))
    }

    fn threshold(env: &Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::Threshold)
            .unwrap_or_else(|| env.panic_with_error(GuardianCouncilError::NotInitialized))
    }

    fn require_member(env: &Env, who: &Address) {
        if !Self::members(env).contains(who) {
            env.panic_with_error(GuardianCouncilError::NotAMember);
        }
    }

    fn governor_client(env: &Env) -> GovernorClient {
        GovernorClient::new(env, &Self::get_governor(env.clone()))
    }

    fn must_get_action(env: &Env, action_id: u64) -> PendingAction {
        env.storage()
            .persistent()
            .get(&DataKey::Action(action_id))
            .unwrap_or_else(|| env.panic_with_error(GuardianCouncilError::ActionNotFound))
    }

    fn put_action(env: &Env, pending: &PendingAction) {
        let key = DataKey::Action(pending.id);
        env.storage().persistent().set(&key, pending);
        env.storage()
            .persistent()
            .extend_ttl(&key, COUNCIL_TTL_LEDGERS, COUNCIL_TTL_LEDGERS);
    }

    fn do_rotate(env: &Env, old: &Address, new: &Address) {
        let mut members = Self::members(env);
        match members.first_index_of(old) {
            Some(idx) => {
                members.remove(idx);
            }
            None => env.panic_with_error(GuardianCouncilError::MemberNotFound),
        }
        if members.contains(new) {
            env.panic_with_error(GuardianCouncilError::DuplicateMember);
        }
        members.push_back(new.clone());
        // Rotating out a member can leave threshold > N; clamp it.
        let threshold = Self::threshold(env);
        if threshold > members.len() {
            env.storage()
                .instance()
                .set(&DataKey::Threshold, &members.len());
        }
        env.storage().instance().set(&DataKey::Members, &members);
        events::emit_membership_rotated(env, old, new);
    }

    fn do_set_threshold(env: &Env, new_threshold: u32) {
        let members_len = Self::members(env).len();
        if new_threshold == 0 || new_threshold > members_len {
            env.panic_with_error(GuardianCouncilError::InvalidThreshold);
        }
        let old = Self::threshold(env);
        env.storage()
            .instance()
            .set(&DataKey::Threshold, &new_threshold);
        events::emit_threshold_updated(env, old, new_threshold);
    }

    /// Update the action expiry window through the council's own approval
    /// threshold — no single member can unilaterally change it.
    /// `new_ttl == 0` disables expiry: actions will never expire.
    fn do_set_action_ttl(env: &Env, new_ttl: u32) {
        let old_ttl: u32 = env
            .storage()
            .instance()
            .get(&DataKey::ActionTtlLedgers)
            .unwrap_or(0);
        env.storage()
            .instance()
            .set(&DataKey::ActionTtlLedgers, &new_ttl);
        events::emit_action_ttl_updated(env, old_ttl, new_ttl);
    }

    fn action_kind(env: &Env, action: &GuardianAction) -> Symbol {
        match action {
            GuardianAction::Pause => Symbol::new(env, "Pause"),
            GuardianAction::Unpause => Symbol::new(env, "Unpause"),
            GuardianAction::CancelActive(_) => Symbol::new(env, "CancelActive"),
            GuardianAction::CancelQueued(_) => Symbol::new(env, "CancelQueued"),
            GuardianAction::RotateMember(_) => Symbol::new(env, "RotateMember"),
            GuardianAction::SetThreshold(_) => Symbol::new(env, "SetThreshold"),
            GuardianAction::SetActionTtl(_) => Symbol::new(env, "SetActionTtl"),
        }
    }
}

#[cfg(test)]
mod tests;
