#![cfg(test)]

use crate::error::GuardianCouncilError;
use crate::{
    GuardianAction, GuardianCouncilContract, GuardianCouncilContractClient, MemberRotation,
};
use soroban_sdk::testutils::{Address as _, Ledger as _};
use soroban_sdk::{contract, contractimpl, symbol_short, Address, Env, Symbol, Vec};

// ── Minimal mock governor: just enough of the guardian surface to prove the
//    cross-contract call lands. `pause`/`unpause` require auth from `caller`
//    exactly like the real governor's contract-self-auth path. ─────────────
#[contract]
pub struct MockGovernor;

#[contractimpl]
impl MockGovernor {
    pub fn pause(env: Env, caller: Address) {
        caller.require_auth();
        env.storage().instance().set(&PAUSED, &true);
    }
    pub fn unpause(env: Env, caller: Address) {
        caller.require_auth();
        env.storage().instance().set(&PAUSED, &false);
    }
    pub fn cancel(env: Env, caller: Address, proposal_id: u64) {
        caller.require_auth();
        env.storage().instance().set(&LAST_CANCELLED, &proposal_id);
    }
    pub fn cancel_queued(env: Env, caller: Address, proposal_id: u64) {
        caller.require_auth();
        env.storage()
            .instance()
            .set(&LAST_CANCELLED_QUEUED, &proposal_id);
    }
    pub fn is_paused(env: Env) -> bool {
        env.storage().instance().get(&PAUSED).unwrap_or(false)
    }
    pub fn last_cancelled(env: Env) -> u64 {
        env.storage().instance().get(&LAST_CANCELLED).unwrap_or(0)
    }
}

const PAUSED: Symbol = symbol_short!("paused");
const LAST_CANCELLED: Symbol = symbol_short!("lc");
const LAST_CANCELLED_QUEUED: Symbol = symbol_short!("lcq");

struct Setup {
    env: Env,
    council: GuardianCouncilContractClient<'static>,
    governor_id: Address,
    m: [Address; 3],
}

fn setup(threshold: u32, ttl: u32) -> Setup {
    let env = Env::default();
    env.mock_all_auths();

    let governor_id = env.register(MockGovernor, ());
    let m = [
        Address::generate(&env),
        Address::generate(&env),
        Address::generate(&env),
    ];
    let council_id = env.register(GuardianCouncilContract, (m[0].clone(),));
    let council = GuardianCouncilContractClient::new(&env, &council_id);
    let mut members = Vec::new(&env);
    for a in &m {
        members.push_back(a.clone());
    }
    council.initialize(&m[0], &members, &threshold, &governor_id, &ttl);

    Setup {
        env,
        council,
        governor_id,
        m,
    }
}

#[test]
fn initialize_requires_deployer_authorization() {
    let env = Env::default();
    let governor = env.register(MockGovernor, ());
    let deployer = Address::generate(&env);
    let council_id = env.register(GuardianCouncilContract, (deployer.clone(),));
    let council = GuardianCouncilContractClient::new(&env, &council_id);
    let member = Address::generate(&env);
    let mut members = Vec::new(&env);
    members.push_back(member);

    assert!(council
        .try_initialize(&deployer, &members, &1u32, &governor, &0u32)
        .is_err());

    env.mock_all_auths();
    let other = Address::generate(&env);
    assert!(council
        .try_initialize(&other, &members, &1u32, &governor, &0u32)
        .is_err());
    council.initialize(&deployer, &members, &1u32, &governor, &0u32);
}

fn mock_governor(env: &Env, id: &Address) -> MockGovernorClient<'static> {
    MockGovernorClient::new(env, id)
}

#[test]
fn pause_executes_only_after_threshold_and_lands_on_governor() {
    let s = setup(2, 0);
    let id = s.council.propose_action(&s.m[0], &GuardianAction::Pause); // auto-approves m0

    // 1 of 2 — not executable yet.
    let err = s.council.try_execute_action(&id).unwrap_err().unwrap();
    assert_eq!(err, GuardianCouncilError::ThresholdNotMet.into());

    s.council.approve_action(&s.m[1], &id);
    s.council.execute_action(&id);

    assert!(mock_governor(&s.env, &s.governor_id).is_paused());
    assert!(s.council.get_action(&id).executed);
}

#[test]
fn action_expiry_is_snapshotted_when_proposed() {
    let s = setup(2, 10);
    let id = s.council.propose_action(&s.m[0], &GuardianAction::Pause);
    s.council.approve_action(&s.m[1], &id);
    let change = s
        .council
        .propose_action(&s.m[0], &GuardianAction::SetActionTtl(0));
    s.council.approve_action(&s.m[1], &change);
    s.council.execute_action(&change);
    s.env.ledger().with_mut(|l| l.sequence_number += 11);
    let err = s.council.try_execute_action(&id).unwrap_err().unwrap();
    assert_eq!(err, GuardianCouncilError::ActionExpired.into());
}

#[test]
fn shortening_ttl_does_not_expire_an_existing_action() {
    let s = setup(2, 100);
    let id = s.council.propose_action(&s.m[0], &GuardianAction::Pause);
    s.council.approve_action(&s.m[1], &id);
    let change = s
        .council
        .propose_action(&s.m[0], &GuardianAction::SetActionTtl(1));
    s.council.approve_action(&s.m[1], &change);
    s.council.execute_action(&change);
    s.env.ledger().with_mut(|l| l.sequence_number += 2);
    s.council.execute_action(&id);
    assert!(s.council.get_action(&id).executed);
}

#[test]
fn proposer_can_cancel_and_cancelled_action_rejects_approval_and_execution() {
    let s = setup(2, 0);
    let id = s.council.propose_action(&s.m[0], &GuardianAction::Pause);
    s.council.cancel_action(&s.m[0], &id);
    assert!(s.council.get_action(&id).cancelled);
    assert_eq!(
        s.council
            .try_approve_action(&s.m[1], &id)
            .unwrap_err()
            .unwrap(),
        GuardianCouncilError::ActionCancelled.into()
    );
    assert_eq!(
        s.council.try_execute_action(&id).unwrap_err().unwrap(),
        GuardianCouncilError::ActionCancelled.into()
    );
}

#[test]
fn threshold_of_members_can_cancel() {
    let s = setup(2, 0);
    let id = s.council.propose_action(&s.m[0], &GuardianAction::Pause);
    s.council.cancel_action(&s.m[1], &id);
    assert!(!s.council.get_action(&id).cancelled);
    s.council.cancel_action(&s.m[2], &id);
    assert!(s.council.get_action(&id).cancelled);
}

#[test]
fn action_count_and_page_are_exposed() {
    let s = setup(2, 0);
    s.council.propose_action(&s.m[0], &GuardianAction::Pause);
    s.council.propose_action(&s.m[0], &GuardianAction::Unpause);
    assert_eq!(s.council.get_action_count(), 2);
    let page = s.council.get_actions(&1, &10);
    assert_eq!(page.len(), 1);
    assert_eq!(page.get_unchecked(0).id, 1);
}

#[test]
fn non_member_cannot_propose_or_approve() {
    let s = setup(2, 0);
    let stranger = Address::generate(&s.env);

    let e1 = s
        .council
        .try_propose_action(&stranger, &GuardianAction::Pause)
        .unwrap_err()
        .unwrap();
    assert_eq!(e1, GuardianCouncilError::NotAMember.into());

    let id = s.council.propose_action(&s.m[0], &GuardianAction::Pause);
    let e2 = s
        .council
        .try_approve_action(&stranger, &id)
        .unwrap_err()
        .unwrap();
    assert_eq!(e2, GuardianCouncilError::NotAMember.into());
}

#[test]
fn double_approval_does_not_double_count() {
    let s = setup(3, 0);
    let id = s.council.propose_action(&s.m[0], &GuardianAction::Pause); // m0 approved

    s.council.approve_action(&s.m[0], &id); // same member again
    assert_eq!(s.council.get_action(&id).approvals.len(), 1);

    let err = s.council.try_execute_action(&id).unwrap_err().unwrap();
    assert_eq!(err, GuardianCouncilError::ThresholdNotMet.into());
}

#[test]
fn revoke_drops_below_threshold_and_blocks_until_reapproved() {
    let s = setup(2, 0);
    let id = s.council.propose_action(&s.m[0], &GuardianAction::Pause);
    s.council.approve_action(&s.m[1], &id); // now 2/2

    s.council.revoke_approval(&s.m[1], &id); // back to 1/2
    let err = s.council.try_execute_action(&id).unwrap_err().unwrap();
    assert_eq!(err, GuardianCouncilError::ThresholdNotMet.into());

    s.council.approve_action(&s.m[2], &id); // 2/2 again
    s.council.execute_action(&id);
    assert!(mock_governor(&s.env, &s.governor_id).is_paused());
}

#[test]
fn execution_after_ttl_elapsed_panics() {
    let s = setup(2, 100);
    let id = s
        .council
        .propose_action(&s.m[0], &GuardianAction::CancelActive(7));
    s.council.approve_action(&s.m[1], &id);

    s.env.ledger().with_mut(|l| l.sequence_number += 101);

    let err = s.council.try_execute_action(&id).unwrap_err().unwrap();
    assert_eq!(err, GuardianCouncilError::ActionExpired.into());
}

#[test]
fn rotate_member_updates_membership_after_execution() {
    let s = setup(2, 0);
    let newcomer = Address::generate(&s.env);

    let id = s.council.propose_action(
        &s.m[0],
        &GuardianAction::RotateMember(MemberRotation {
            old: s.m[2].clone(),
            new: newcomer.clone(),
        }),
    );
    s.council.approve_action(&s.m[1], &id);
    s.council.execute_action(&id);

    let members = s.council.get_members();
    assert!(!members.contains(&s.m[2]));
    assert!(members.contains(&newcomer));

    // The rotated-in member can now act.
    let id2 = s.council.propose_action(&newcomer, &GuardianAction::Pause);
    s.council.approve_action(&s.m[0], &id2);
    s.council.execute_action(&id2);
    assert!(mock_governor(&s.env, &s.governor_id).is_paused());
}

#[test]
fn cancel_active_forwards_proposal_id_to_governor() {
    let s = setup(1, 0);
    let id = s
        .council
        .propose_action(&s.m[0], &GuardianAction::CancelActive(42));
    s.council.execute_action(&id);
    assert_eq!(mock_governor(&s.env, &s.governor_id).last_cancelled(), 42);
}

#[test]
fn set_threshold_goes_through_a_council_action() {
    let s = setup(2, 0);
    let id = s
        .council
        .propose_action(&s.m[0], &GuardianAction::SetThreshold(3));
    s.council.approve_action(&s.m[1], &id);
    s.council.execute_action(&id);
    assert_eq!(s.council.get_threshold(), 3);
}

#[test]
fn cannot_execute_twice() {
    let s = setup(1, 0);
    let id = s.council.propose_action(&s.m[0], &GuardianAction::Pause);
    s.council.execute_action(&id);
    let err = s.council.try_execute_action(&id).unwrap_err().unwrap();
    assert_eq!(err, GuardianCouncilError::AlreadyExecuted.into());
}

#[test]
fn initialize_rejects_bad_threshold_and_duplicate_members() {
    let env = Env::default();
    env.mock_all_auths();
    let governor_id = env.register(MockGovernor, ());
    let a = Address::generate(&env);
    let council_id = env.register(GuardianCouncilContract, (a.clone(),));
    let council = GuardianCouncilContractClient::new(&env, &council_id);
    let mut dupes = Vec::new(&env);
    dupes.push_back(a.clone());
    dupes.push_back(a.clone());
    let e = council
        .try_initialize(&a, &dupes, &1u32, &governor_id, &0u32)
        .unwrap_err()
        .unwrap();
    assert_eq!(e, GuardianCouncilError::DuplicateMember.into());

    let mut one = Vec::new(&env);
    one.push_back(a.clone());
    let e2 = council
        .try_initialize(&a, &one, &5u32, &governor_id, &0u32)
        .unwrap_err()
        .unwrap();
    assert_eq!(e2, GuardianCouncilError::InvalidThreshold.into());
}

// ── #1380: SetActionTtl action and expiry tests ──────────────────────────────

/// The TTL can be changed via a council action gated by threshold approval.
/// 0 means no expiry (documented in do_set_action_ttl).
#[test]
fn set_action_ttl_updates_via_council_action() {
    let s = setup(2, 0);

    // Initial TTL is 0 (no expiry).
    assert_eq!(s.council.get_action_ttl(), 0);

    let id = s
        .council
        .propose_action(&s.m[0], &GuardianAction::SetActionTtl(500));
    // 1 of 2 — threshold not yet met.
    let err = s.council.try_execute_action(&id).unwrap_err().unwrap();
    assert_eq!(err, GuardianCouncilError::ThresholdNotMet.into());

    s.council.approve_action(&s.m[1], &id);
    s.council.execute_action(&id);

    assert_eq!(s.council.get_action_ttl(), 500);
}

/// Setting TTL to 0 via a council action disables expiry.
#[test]
fn set_action_ttl_to_zero_disables_expiry() {
    // Start with a TTL of 100 ledgers.
    let s = setup(1, 100);
    assert_eq!(s.council.get_action_ttl(), 100);

    let id = s
        .council
        .propose_action(&s.m[0], &GuardianAction::SetActionTtl(0));
    s.council.execute_action(&id);

    // TTL is now 0 — no expiry.
    assert_eq!(s.council.get_action_ttl(), 0);

    // A new action proposed now should NOT expire even after the old TTL
    // window (100 ledgers) has passed — TTL == 0 means never expires.
    let id2 = s.council.propose_action(&s.m[0], &GuardianAction::Pause);
    // Advance just past the old TTL (101) to prove it no longer applies.
    // Keep the bump small so instance storage does not get archived in tests.
    s.env.ledger().with_mut(|l| l.sequence_number += 200);
    // With TTL == 0, execution must succeed (no expiry).
    s.council.execute_action(&id2);
    assert!(mock_governor(&s.env, &s.governor_id).is_paused());
}

/// Propose an action, advance the ledger past its TTL, assert ActionExpired.
/// This is the core expiry regression test for #1380.
#[test]
fn action_expires_after_ttl_ledgers_elapse() {
    // TTL = 50 ledgers.
    let s = setup(2, 50);

    let id = s.council.propose_action(&s.m[0], &GuardianAction::Pause);
    s.council.approve_action(&s.m[1], &id);

    // Advance past the TTL.
    s.env.ledger().with_mut(|l| l.sequence_number += 51);

    let err = s.council.try_execute_action(&id).unwrap_err().unwrap();
    assert_eq!(err, GuardianCouncilError::ActionExpired.into());
}

/// A SetActionTtl action itself expires if it is not executed in time,
/// just like any other action.
#[test]
fn set_action_ttl_action_itself_can_expire() {
    let s = setup(2, 100);

    let id = s
        .council
        .propose_action(&s.m[0], &GuardianAction::SetActionTtl(999));
    s.council.approve_action(&s.m[1], &id);

    // Advance past the current TTL of 100.
    s.env.ledger().with_mut(|l| l.sequence_number += 101);

    let err = s.council.try_execute_action(&id).unwrap_err().unwrap();
    assert_eq!(err, GuardianCouncilError::ActionExpired.into());
}

#[test]
fn test_instance_ttl_extended() {
    let s = setup(2, 50);

    // Advance ledger past default instance TTL
    s.env.ledger().with_mut(|l| {
        l.sequence_number += 10_000;
    });

    // Contract still answers queries
    assert_eq!(s.council.get_threshold(), 2);
    assert_eq!(s.council.get_action_count(), 0);
    assert_eq!(s.council.get_members().len(), 3);
}
