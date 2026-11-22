extern crate std;

use super::*;
use soroban_sdk::{
    contract, contractimpl, contracttype,
    testutils::{Address as _, Ledger as _},
    token, Address, Env,
};

#[contracttype]
enum VotesKey {
    Votes(Address),
    Supply,
}

#[contract]
struct MockVotes;

#[contractimpl]
impl MockVotes {
    pub fn set_votes(env: Env, account: Address, votes: i128) {
        env.storage()
            .instance()
            .set(&VotesKey::Votes(account), &votes);
    }

    pub fn set_supply(env: Env, supply: i128) {
        env.storage().instance().set(&VotesKey::Supply, &supply);
    }

    pub fn get_past_votes(env: Env, account: Address, _ledger: u32) -> i128 {
        env.storage()
            .instance()
            .get(&VotesKey::Votes(account))
            .unwrap_or(0)
    }

    pub fn get_past_total_supply(env: Env, _ledger: u32) -> i128 {
        env.storage().instance().get(&VotesKey::Supply).unwrap_or(0)
    }
}

#[contract]
struct Target;

#[contractimpl]
impl Target {
    pub fn execute(env: Env) -> u32 {
        let calls: u32 = env.storage().instance().get(&0u32).unwrap_or(0);
        env.storage().instance().set(&0u32, &(calls + 1));
        calls + 1
    }

    pub fn calls(env: Env) -> u32 {
        env.storage().instance().get(&0u32).unwrap_or(0)
    }
}

const CHALLENGE_WINDOW: u32 = 100;
const OBJECTION_THRESHOLD_BPS: u32 = 300; // 3%
const TOTAL_SUPPLY: i128 = 1_000_000;
const BOND_AMOUNT: i128 = 1_000;
const EXECUTION_WINDOW: u32 = 1_000;

struct Fixture {
    env: Env,
    client_id: Address,
    votes_id: Address,
    target_id: Address,
    bond_token: Address,
    admin: Address,
    proposer: Address,
}

fn setup(bond_amount: i128) -> Fixture {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().with_mut(|l| l.sequence_number = 1);

    let votes_id = env.register(MockVotes, ());
    let target_id = env.register(Target, ());
    let admin = Address::generate(&env);
    let proposer = Address::generate(&env);

    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let bond_token = sac.address();
    if bond_amount > 0 {
        token::StellarAssetClient::new(&env, &bond_token).mint(&proposer, &(bond_amount * 10));
    }

    let client_id = env.register(OptimisticGovernorContract, ());
    let client = OptimisticGovernorContractClient::new(&env, &client_id);
    client.initialize(
        &admin,
        &votes_id,
        &CHALLENGE_WINDOW,
        &OBJECTION_THRESHOLD_BPS,
        &bond_amount,
        &bond_token,
        &EXECUTION_WINDOW,
    );

    let votes = MockVotesClient::new(&env, &votes_id);
    votes.set_supply(&TOTAL_SUPPLY);

    Fixture {
        env,
        client_id,
        votes_id,
        target_id,
        bond_token,
        admin,
        proposer,
    }
}

fn client(f: &Fixture) -> OptimisticGovernorContractClient<'static> {
    OptimisticGovernorContractClient::new(&f.env, &f.client_id)
}

fn propose(f: &Fixture) -> u64 {
    client(f).propose(
        &f.proposer,
        &f.target_id,
        &Symbol::new(&f.env, "execute"),
        &Bytes::new(&f.env),
        &BytesN::from_array(&f.env, &[7u8; 32]),
    )
}

#[test]
fn clean_pass_after_window_elapses_with_zero_objections() {
    let f = setup(0);
    let c = client(&f);
    let id = propose(&f);

    f.env
        .ledger()
        .with_mut(|l| l.sequence_number += CHALLENGE_WINDOW + 1);
    c.finalize(&id);

    let proposal = c.get_proposal(&id);
    assert_eq!(proposal.state, OptimisticProposalState::Passed);
}

#[test]
fn single_large_objector_immediately_crosses_threshold_and_freezes() {
    let f = setup(0);
    let c = client(&f);
    let id = propose(&f);

    let objector = Address::generate(&f.env);
    MockVotesClient::new(&f.env, &f.votes_id).set_votes(&objector, &(TOTAL_SUPPLY * 5 / 100));

    c.object(&objector, &id);

    let proposal = c.get_proposal(&id);
    assert_eq!(proposal.state, OptimisticProposalState::Objected);
}

#[test]
fn objections_summed_correctly_across_multiple_distinct_objectors() {
    let f = setup(0);
    let c = client(&f);
    let id = propose(&f);

    let o1 = Address::generate(&f.env);
    let o2 = Address::generate(&f.env);
    let votes = MockVotesClient::new(&f.env, &f.votes_id);
    votes.set_votes(&o1, &(TOTAL_SUPPLY / 100));
    votes.set_votes(&o2, &(TOTAL_SUPPLY / 100));

    c.object(&o1, &id);
    let proposal = c.get_proposal(&id);
    assert_eq!(proposal.state, OptimisticProposalState::ChallengeWindow);
    assert_eq!(proposal.objection_votes, TOTAL_SUPPLY / 100);

    c.object(&o2, &id);
    let proposal = c.get_proposal(&id);
    assert_eq!(proposal.objection_votes, TOTAL_SUPPLY * 2 / 100);
    // 2% < 3% threshold, still open.
    assert_eq!(proposal.state, OptimisticProposalState::ChallengeWindow);
}

#[test]
#[should_panic]
fn double_objecting_from_same_address_rejected() {
    let f = setup(0);
    let c = client(&f);
    let id = propose(&f);

    let objector = Address::generate(&f.env);
    MockVotesClient::new(&f.env, &f.votes_id).set_votes(&objector, &1_000);

    c.object(&objector, &id);
    c.object(&objector, &id);
}

#[test]
#[should_panic]
fn execute_rejected_before_finalize_has_run() {
    let f = setup(0);
    let c = client(&f);
    let id = propose(&f);

    f.env
        .ledger()
        .with_mut(|l| l.sequence_number += CHALLENGE_WINDOW + 1);
    // finalize() was never called, so state is still ChallengeWindow.
    c.execute(&id);
}

#[test]
#[should_panic]
fn execute_rejected_on_objected_proposal() {
    let f = setup(0);
    let c = client(&f);
    let id = propose(&f);

    let objector = Address::generate(&f.env);
    MockVotesClient::new(&f.env, &f.votes_id).set_votes(&objector, &(TOTAL_SUPPLY * 5 / 100));
    c.object(&objector, &id);

    f.env
        .ledger()
        .with_mut(|l| l.sequence_number += CHALLENGE_WINDOW + 1);
    c.execute(&id);
}

#[test]
#[should_panic]
fn finalize_called_early_before_window_elapses_rejected() {
    let f = setup(0);
    let c = client(&f);
    let id = propose(&f);
    c.finalize(&id);
}

#[test]
fn bond_locked_on_propose_and_refunded_on_passed_and_executed() {
    let f = setup(BOND_AMOUNT);
    let c = client(&f);
    let tok = token::TokenClient::new(&f.env, &f.bond_token);
    let balance_before = tok.balance(&f.proposer);

    let id = propose(&f);
    assert_eq!(tok.balance(&f.proposer), balance_before - BOND_AMOUNT);
    assert_eq!(tok.balance(&f.client_id), BOND_AMOUNT);

    f.env
        .ledger()
        .with_mut(|l| l.sequence_number += CHALLENGE_WINDOW + 1);
    c.finalize(&id);

    // Bond refunds at the Passed transition, ahead of execute().
    assert_eq!(tok.balance(&f.proposer), balance_before);
    assert_eq!(tok.balance(&f.client_id), 0);

    c.execute(&id);
    let proposal = c.get_proposal(&id);
    assert_eq!(proposal.state, OptimisticProposalState::Executed);
    assert_eq!(TargetClient::new(&f.env, &f.target_id).calls(), 1);
}

#[test]
#[should_panic]
fn cancel_rejected_once_a_proposal_has_already_passed() {
    let f = setup(0);
    let c = client(&f);
    let id = propose(&f);

    f.env
        .ledger()
        .with_mut(|l| l.sequence_number += CHALLENGE_WINDOW + 1);
    c.finalize(&id);

    c.cancel(&f.proposer, &id);
}

/// Push `id` over the objection threshold so it freezes in `Objected`.
fn object_past_threshold(f: &Fixture, id: u64) {
    let c = client(f);
    let objector = Address::generate(&f.env);
    MockVotesClient::new(&f.env, &f.votes_id).set_votes(&objector, &(TOTAL_SUPPLY * 5 / 100));
    c.object(&objector, &id);
    assert_eq!(c.get_proposal(&id).state, OptimisticProposalState::Objected);
}

#[test]
fn cancel_before_any_objection_refunds_bond() {
    let f = setup(BOND_AMOUNT);
    let c = client(&f);
    let tok = token::TokenClient::new(&f.env, &f.bond_token);
    let balance_before = tok.balance(&f.proposer);
    let id = propose(&f);

    c.cancel(&f.proposer, &id);
    assert_eq!(
        c.get_proposal(&id).state,
        OptimisticProposalState::Cancelled
    );
    assert_eq!(tok.balance(&f.proposer), balance_before);
    assert_eq!(tok.balance(&f.client_id), 0);
}

#[test]
fn cancel_is_allowed_while_objected_but_keeps_bond_locked() {
    let f = setup(BOND_AMOUNT);
    let c = client(&f);
    let tok = token::TokenClient::new(&f.env, &f.bond_token);
    let balance_before = tok.balance(&f.proposer);
    let id = propose(&f);
    object_past_threshold(&f, id);

    c.cancel(&f.proposer, &id);
    assert_eq!(
        c.get_proposal(&id).state,
        OptimisticProposalState::Cancelled
    );
    // Propose, get objected, cancel must not be free: the bond stays put.
    assert_eq!(tok.balance(&f.proposer), balance_before - BOND_AMOUNT);
    assert_eq!(tok.balance(&f.client_id), BOND_AMOUNT);
}

#[test]
#[should_panic]
fn object_after_challenge_window_elapsed_rejected() {
    let f = setup(0);
    let c = client(&f);
    let id = propose(&f);

    let objector = Address::generate(&f.env);
    MockVotesClient::new(&f.env, &f.votes_id).set_votes(&objector, &1_000);
    f.env
        .ledger()
        .with_mut(|l| l.sequence_number += CHALLENGE_WINDOW + 1);
    c.object(&objector, &id);
}

#[test]
#[should_panic]
fn object_with_no_voting_power_rejected() {
    let f = setup(0);
    let c = client(&f);
    let id = propose(&f);

    let objector = Address::generate(&f.env);
    // No votes set for this objector -> defaults to 0.
    c.object(&objector, &id);
}

#[test]
#[should_panic]
fn initialize_rejects_reinitialization() {
    let f = setup(0);
    let c = client(&f);
    c.initialize(
        &f.admin,
        &f.votes_id,
        &CHALLENGE_WINDOW,
        &OBJECTION_THRESHOLD_BPS,
        &0,
        &f.bond_token,
        &EXECUTION_WINDOW,
    );
}

#[test]
#[should_panic]
fn propose_before_initialize_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(OptimisticGovernorContract, ());
    let client = OptimisticGovernorContractClient::new(&env, &contract_id);
    let target_id = env.register(Target, ());
    let proposer = Address::generate(&env);
    client.propose(
        &proposer,
        &target_id,
        &Symbol::new(&env, "execute"),
        &Bytes::new(&env),
        &BytesN::from_array(&env, &[1u8; 32]),
    );
}

#[test]
fn update_config_by_admin_applies_to_future_proposals() {
    let f = setup(0);
    let c = client(&f);
    c.update_config(
        &f.admin,
        &(CHALLENGE_WINDOW * 2),
        &(OBJECTION_THRESHOLD_BPS * 2),
        &EXECUTION_WINDOW,
    );

    let id = propose(&f);
    let proposal = c.get_proposal(&id);
    assert_eq!(
        proposal.challenge_end_ledger,
        proposal.created_ledger + CHALLENGE_WINDOW * 2
    );
}

#[test]
fn get_config_reflects_initialize_args() {
    let f = setup(BOND_AMOUNT);
    let c = client(&f);
    let config = c.get_config();
    assert_eq!(config.votes_token, f.votes_id);
    assert_eq!(config.challenge_window_ledgers, CHALLENGE_WINDOW);
    assert_eq!(config.objection_threshold_bps, OBJECTION_THRESHOLD_BPS);
    assert_eq!(config.proposer_bond_amount, BOND_AMOUNT);
    assert_eq!(config.proposer_bond_token, f.bond_token);
}

#[test]
#[should_panic]
fn update_config_by_non_admin_rejected() {
    let f = setup(0);
    let c = client(&f);
    let attacker = Address::generate(&f.env);
    c.update_config(
        &attacker,
        &CHALLENGE_WINDOW,
        &OBJECTION_THRESHOLD_BPS,
        &EXECUTION_WINDOW,
    );
}

#[test]
fn bond_updates_do_not_change_existing_refund_token() {
    let f = setup(BOND_AMOUNT);
    let c = client(&f);
    let id = propose(&f);
    let replacement = f
        .env
        .register_stellar_asset_contract_v2(f.admin.clone())
        .address();
    c.update_bond_config(&f.admin, &(BOND_AMOUNT * 2), &replacement);
    f.env
        .ledger()
        .with_mut(|l| l.sequence_number += CHALLENGE_WINDOW + 1);
    c.finalize(&id);
    assert_eq!(
        token::TokenClient::new(&f.env, &f.bond_token).balance(&f.proposer),
        BOND_AMOUNT * 10
    );
}

#[test]
fn admin_can_be_rotated() {
    let f = setup(0);
    let c = client(&f);
    let next = Address::generate(&f.env);
    c.set_admin(&f.admin, &next);
    c.update_bond_config(&next, &1, &f.bond_token);
    assert_eq!(c.get_config().proposer_bond_amount, 1);
}

// ── #1377: refund_bond ProposerBondToken typed-error path ───────────────────

/// When a bond was locked, finalize() must successfully refund it, proving the
/// ProposerBondToken read in pay_out_bond works correctly. The `NotInitialized`
/// error path is indirectly guarded by the require_initialized() gate that
/// fires before any bond can ever be written.
#[test]
fn refund_bond_returns_tokens_on_finalize() {
    let f = setup(BOND_AMOUNT);
    let c = client(&f);
    let tok = token::TokenClient::new(&f.env, &f.bond_token);
    let balance_before = tok.balance(&f.proposer);

    let id = propose(&f);
    // Bond is now held by the contract.
    assert_eq!(tok.balance(&f.client_id), BOND_AMOUNT);

    f.env
        .ledger()
        .with_mut(|l| l.sequence_number += CHALLENGE_WINDOW + 1);
    c.finalize(&id);

    // pay_out_bond() ran without panicking — bond is back with the proposer.
    assert_eq!(tok.balance(&f.proposer), balance_before);
    assert_eq!(tok.balance(&f.client_id), 0);
}

/// A contract that was never initialized cannot reach pay_out_bond because
/// propose() itself panics with NotInitialized first — the gate is upstream.
#[test]
fn refund_bond_not_reachable_before_initialization() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(OptimisticGovernorContract, ());
    let c = OptimisticGovernorContractClient::new(&env, &contract_id);
    let target_id = env.register(Target, ());
    let proposer = Address::generate(&env);

    let err = c
        .try_propose(
            &proposer,
            &target_id,
            &Symbol::new(&env, "execute"),
            &Bytes::new(&env),
            &BytesN::from_array(&env, &[9u8; 32]),
        )
        .unwrap_err()
        .unwrap();
    assert_eq!(err, OptimisticGovernorError::NotInitialized.into());
}

// ── #1539: objected bonds stay locked until governance settles them ─────────

#[test]
fn slash_bond_on_objected_proposal_pays_recipient() {
    let f = setup(BOND_AMOUNT);
    let c = client(&f);
    let tok = token::TokenClient::new(&f.env, &f.bond_token);
    let id = propose(&f);
    object_past_threshold(&f, id);

    let recipient = Address::generate(&f.env);
    c.slash_bond(&f.admin, &id, &recipient);
    assert_eq!(tok.balance(&recipient), BOND_AMOUNT);
    assert_eq!(tok.balance(&f.client_id), 0);
}

#[test]
fn slash_bond_after_cancel_while_objected_pays_recipient() {
    let f = setup(BOND_AMOUNT);
    let c = client(&f);
    let tok = token::TokenClient::new(&f.env, &f.bond_token);
    let id = propose(&f);
    object_past_threshold(&f, id);
    c.cancel(&f.proposer, &id);

    let recipient = Address::generate(&f.env);
    c.slash_bond(&f.admin, &id, &recipient);
    assert_eq!(tok.balance(&recipient), BOND_AMOUNT);
    assert_eq!(tok.balance(&f.client_id), 0);
}

#[test]
fn release_bond_on_objected_proposal_returns_it_to_proposer() {
    let f = setup(BOND_AMOUNT);
    let c = client(&f);
    let tok = token::TokenClient::new(&f.env, &f.bond_token);
    let balance_before = tok.balance(&f.proposer);
    let id = propose(&f);
    object_past_threshold(&f, id);

    c.release_bond(&f.admin, &id);
    assert_eq!(tok.balance(&f.proposer), balance_before);
    assert_eq!(tok.balance(&f.client_id), 0);
}

#[test]
fn settled_bond_cannot_be_settled_again() {
    let f = setup(BOND_AMOUNT);
    let c = client(&f);
    let id = propose(&f);
    object_past_threshold(&f, id);
    let recipient = Address::generate(&f.env);
    c.slash_bond(&f.admin, &id, &recipient);

    assert_eq!(
        c.try_slash_bond(&f.admin, &id, &recipient)
            .unwrap_err()
            .unwrap(),
        OptimisticGovernorError::BondNotFound.into(),
    );
    assert_eq!(
        c.try_release_bond(&f.admin, &id).unwrap_err().unwrap(),
        OptimisticGovernorError::BondNotFound.into(),
    );
}

#[test]
fn bond_cannot_be_slashed_before_an_objection() {
    let f = setup(BOND_AMOUNT);
    let c = client(&f);
    let id = propose(&f);
    let recipient = Address::generate(&f.env);

    assert_eq!(
        c.try_slash_bond(&f.admin, &id, &recipient)
            .unwrap_err()
            .unwrap(),
        OptimisticGovernorError::BondNotSettleable.into(),
    );
    assert_eq!(
        c.try_release_bond(&f.admin, &id).unwrap_err().unwrap(),
        OptimisticGovernorError::BondNotSettleable.into(),
    );
}

#[test]
fn bond_of_a_passed_proposal_is_already_refunded_and_cannot_be_slashed() {
    let f = setup(BOND_AMOUNT);
    let c = client(&f);
    let id = propose(&f);
    f.env
        .ledger()
        .with_mut(|l| l.sequence_number += CHALLENGE_WINDOW + 1);
    c.finalize(&id);

    let recipient = Address::generate(&f.env);
    assert_eq!(
        c.try_slash_bond(&f.admin, &id, &recipient)
            .unwrap_err()
            .unwrap(),
        OptimisticGovernorError::BondNotFound.into(),
    );
}

#[test]
fn slash_and_release_bond_require_admin() {
    let f = setup(BOND_AMOUNT);
    let c = client(&f);
    let id = propose(&f);
    object_past_threshold(&f, id);
    let attacker = Address::generate(&f.env);

    assert_eq!(
        c.try_slash_bond(&attacker, &id, &attacker)
            .unwrap_err()
            .unwrap(),
        OptimisticGovernorError::Unauthorized.into(),
    );
    assert_eq!(
        c.try_release_bond(&attacker, &id).unwrap_err().unwrap(),
        OptimisticGovernorError::Unauthorized.into(),
    );
    assert_eq!(
        token::TokenClient::new(&f.env, &f.bond_token).balance(&f.client_id),
        BOND_AMOUNT
    );
}

#[test]
fn slash_bond_pays_out_in_the_token_the_bond_was_locked_in() {
    let f = setup(BOND_AMOUNT);
    let c = client(&f);
    let id = propose(&f);
    object_past_threshold(&f, id);

    let replacement = f
        .env
        .register_stellar_asset_contract_v2(f.admin.clone())
        .address();
    c.update_bond_config(&f.admin, &BOND_AMOUNT, &replacement);

    let recipient = Address::generate(&f.env);
    c.slash_bond(&f.admin, &id, &recipient);
    assert_eq!(
        token::TokenClient::new(&f.env, &f.bond_token).balance(&recipient),
        BOND_AMOUNT
    );
}
