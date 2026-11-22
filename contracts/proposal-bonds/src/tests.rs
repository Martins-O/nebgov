use super::*;
use soroban_sdk::{
    testutils::{Address as _, Events as _, Ledger as _},
    token, Env, TryIntoVal,
};

#[contract]
pub struct MockGovernorContract;

#[contracttype]
enum MockGovKey {
    Proposal(u64),
    State(u64),
}

#[contractimpl]
impl MockGovernorContract {
    pub fn set_proposal(env: Env, proposal_id: u64, description_hash: BytesN<32>) {
        let proposal = Proposal {
            id: proposal_id,
            proposer: Address::generate(&env),
            description: String::from_str(&env, "d"),
            description_hash,
            metadata_uri: String::from_str(&env, ""),
            targets: Vec::new(&env),
            fn_names: Vec::new(&env),
            calldatas: Vec::new(&env),
            start_ledger: 0,
            end_ledger: 0,
            votes_for: 0,
            votes_against: 0,
            votes_abstain: 0,
            executed: false,
            cancelled: false,
            queued: false,
            op_ids: Vec::new(&env),
        };
        env.storage()
            .instance()
            .set(&MockGovKey::Proposal(proposal_id), &proposal);
    }

    pub fn set_state(env: Env, proposal_id: u64, state: ProposalState) {
        env.storage()
            .instance()
            .set(&MockGovKey::State(proposal_id), &state);
    }

    pub fn get_proposal(env: Env, proposal_id: u64) -> Proposal {
        env.storage()
            .instance()
            .get(&MockGovKey::Proposal(proposal_id))
            .unwrap()
    }

    pub fn state(env: Env, proposal_id: u64) -> ProposalState {
        env.storage()
            .instance()
            .get(&MockGovKey::State(proposal_id))
            .unwrap()
    }
}

const BOND_AMOUNT: i128 = 1_000;
const GRACE_LEDGERS: u32 = 100;
const MAX_LOCK_LEDGERS: u32 = 1_000;

/// Deploy a fresh SAC token, a mock governor, and an initialized
/// proposal-bonds contract. Returns (client, token, proposer, governor_id).
fn setup(env: &Env) -> (ProposalBondsContractClient<'static>, Address, Address, Address) {
    let (client, token_addr, proposer, governor_id, _admin) = setup_with_admin(env);
    (client, token_addr, proposer, governor_id)
}

/// Same as [`setup`], also returning the admin address.
fn setup_with_admin(
    env: &Env,
) -> (
    ProposalBondsContractClient<'static>,
    Address,
    Address,
    Address,
    Address,
) {
    let admin = Address::generate(env);
    let proposer = Address::generate(env);

    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let token_addr = sac.address();
    token::StellarAssetClient::new(env, &token_addr).mint(&proposer, &(BOND_AMOUNT * 10));

    let governor_id = env.register(MockGovernorContract, ());

    let contract_id = env.register(ProposalBondsContract, ());
    let client = ProposalBondsContractClient::new(env, &contract_id);
    client.initialize(
        &admin,
        &token_addr,
        &BOND_AMOUNT,
        &governor_id,
        &GRACE_LEDGERS,
        &MAX_LOCK_LEDGERS,
    );

    (client, token_addr, proposer, governor_id, admin)
}

fn hash(env: &Env, seed: u8) -> BytesN<32> {
    BytesN::from_array(env, &[seed; 32])
}

#[test]
fn test_lock_bond_fresh_hash() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, token_addr, proposer, _gov) = setup(&env);
    let tok = token::TokenClient::new(&env, &token_addr);
    let h = hash(&env, 1);

    client.lock_bond(&proposer, &h);

    assert_eq!(tok.balance(&proposer), BOND_AMOUNT * 10 - BOND_AMOUNT);
    assert_eq!(tok.balance(&client.address), BOND_AMOUNT);
    let bond = client.get_bond(&h).unwrap();
    assert_eq!(bond.state, BondState::Locked);
    assert_eq!(bond.amount, BOND_AMOUNT);
    assert_eq!(bond.proposer, proposer);
}

#[test]
#[should_panic]
fn test_lock_bond_twice_same_hash_panics() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _token, proposer, _gov) = setup(&env);
    let h = hash(&env, 1);

    client.lock_bond(&proposer, &h);
    client.lock_bond(&proposer, &h);
}

#[test]
#[should_panic]
fn test_refund_before_grace_elapsed_panics() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _token, proposer, gov) = setup(&env);
    let h = hash(&env, 1);
    client.lock_bond(&proposer, &h);

    let gov_client = MockGovernorContractClient::new(&env, &gov);
    gov_client.set_proposal(&1u64, &h);
    gov_client.set_state(&1u64, &ProposalState::Executed);

    // No ledgers advanced past proposal.end_ledger (0) + grace (100) yet.
    client.refund_bond(&proposer, &h, &1u64);
}

#[test]
fn test_refund_succeeds_after_terminal_state_and_grace() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, token_addr, proposer, gov) = setup(&env);
    let tok = token::TokenClient::new(&env, &token_addr);
    let h = hash(&env, 1);
    client.lock_bond(&proposer, &h);

    let gov_client = MockGovernorContractClient::new(&env, &gov);
    gov_client.set_proposal(&1u64, &h);
    gov_client.set_state(&1u64, &ProposalState::Executed);

    let balance_before_refund = tok.balance(&proposer);

    env.ledger().with_mut(|l| l.sequence_number += GRACE_LEDGERS + 1);
    client.refund_bond(&proposer, &h, &1u64);

    assert_eq!(tok.balance(&proposer), balance_before_refund + BOND_AMOUNT);
    assert_eq!(tok.balance(&client.address), 0);
    let bond = client.get_bond(&h).unwrap();
    assert_eq!(bond.state, BondState::Refunded);
}

#[test]
#[should_panic]
fn test_slash_by_non_governor_panics() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _token, proposer, _gov) = setup(&env);
    let h = hash(&env, 1);
    client.lock_bond(&proposer, &h);

    let attacker = Address::generate(&env);
    let recipient = Address::generate(&env);
    client.slash(&attacker, &h, &recipient);
}

#[test]
fn test_slash_succeeds_with_governor_self_auth() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, token_addr, proposer, gov) = setup(&env);
    let tok = token::TokenClient::new(&env, &token_addr);
    let h = hash(&env, 1);
    client.lock_bond(&proposer, &h);

    let recipient = Address::generate(&env);

    client.slash(&gov, &h, &recipient);

    assert_eq!(tok.balance(&recipient), BOND_AMOUNT);
    assert_eq!(tok.balance(&client.address), 0);
    let bond = client.get_bond(&h).unwrap();
    assert_eq!(bond.state, BondState::Slashed);
}

#[test]
#[should_panic]
fn test_refund_on_already_slashed_bond_panics() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _token, proposer, gov) = setup(&env);
    let h = hash(&env, 1);
    client.lock_bond(&proposer, &h);

    let recipient = Address::generate(&env);
    client.slash(&gov, &h, &recipient);

    let gov_client = MockGovernorContractClient::new(&env, &gov);
    gov_client.set_proposal(&1u64, &h);
    gov_client.set_state(&1u64, &ProposalState::Executed);
    env.ledger().with_mut(|l| l.sequence_number += GRACE_LEDGERS + 1);

    client.refund_bond(&proposer, &h, &1u64);
}

#[test]
#[should_panic]
fn test_slash_on_already_refunded_bond_panics() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _token, proposer, gov) = setup(&env);
    let h = hash(&env, 1);
    client.lock_bond(&proposer, &h);

    let gov_client = MockGovernorContractClient::new(&env, &gov);
    gov_client.set_proposal(&1u64, &h);
    gov_client.set_state(&1u64, &ProposalState::Executed);
    env.ledger().with_mut(|l| l.sequence_number += GRACE_LEDGERS + 1);
    client.refund_bond(&proposer, &h, &1u64);

    let recipient = Address::generate(&env);
    client.slash(&gov, &h, &recipient);
}

#[test]
#[should_panic]
fn test_refund_before_terminal_state_panics() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _token, proposer, gov) = setup(&env);
    let h = hash(&env, 1);
    client.lock_bond(&proposer, &h);

    let gov_client = MockGovernorContractClient::new(&env, &gov);
    gov_client.set_proposal(&1u64, &h);
    gov_client.set_state(&1u64, &ProposalState::Active);

    client.refund_bond(&proposer, &h, &1u64);
}

#[test]
#[should_panic]
fn test_refund_with_mismatched_description_hash_panics() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _token, proposer, gov) = setup(&env);
    let h = hash(&env, 1);
    let other_hash = hash(&env, 2);
    client.lock_bond(&proposer, &h);

    let gov_client = MockGovernorContractClient::new(&env, &gov);
    gov_client.set_proposal(&1u64, &other_hash);
    gov_client.set_state(&1u64, &ProposalState::Executed);

    client.refund_bond(&proposer, &h, &1u64);
}

#[test]
fn test_update_bond_amount_by_admin() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let token_addr = sac.address();
    let governor_id = env.register(MockGovernorContract, ());
    let contract_id = env.register(ProposalBondsContract, ());
    let client = ProposalBondsContractClient::new(&env, &contract_id);
    client.initialize(
        &admin,
        &token_addr,
        &BOND_AMOUNT,
        &governor_id,
        &GRACE_LEDGERS,
        &MAX_LOCK_LEDGERS,
    );

    client.update_bond_amount(&admin, &2_000i128);

    let proposer = Address::generate(&env);
    token::StellarAssetClient::new(&env, &token_addr).mint(&proposer, &5_000i128);
    let h = hash(&env, 1);
    client.lock_bond(&proposer, &h);
    assert_eq!(client.get_bond(&h).unwrap().amount, 2_000);
}

#[test]
#[should_panic]
fn test_uninitialized_lock_bond_panics() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(ProposalBondsContract, ());
    let client = ProposalBondsContractClient::new(&env, &contract_id);
    let proposer = Address::generate(&env);
    client.lock_bond(&proposer, &hash(&env, 1));
}

#[test]
#[should_panic]
fn test_initialize_rejects_reinitialization() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let token_addr = sac.address();
    let governor_id = env.register(MockGovernorContract, ());
    let contract_id = env.register(ProposalBondsContract, ());
    let client = ProposalBondsContractClient::new(&env, &contract_id);
    client.initialize(
        &admin,
        &token_addr,
        &BOND_AMOUNT,
        &governor_id,
        &GRACE_LEDGERS,
        &MAX_LOCK_LEDGERS,
    );
    client.initialize(
        &admin,
        &token_addr,
        &BOND_AMOUNT,
        &governor_id,
        &GRACE_LEDGERS,
        &MAX_LOCK_LEDGERS,
    );
}

#[test]
#[should_panic]
fn test_initialize_rejects_zero_bond_amount() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let token_addr = sac.address();
    let governor_id = env.register(MockGovernorContract, ());
    let contract_id = env.register(ProposalBondsContract, ());
    let client = ProposalBondsContractClient::new(&env, &contract_id);
    client.initialize(&admin, &token_addr, &0i128, &governor_id, &GRACE_LEDGERS, &MAX_LOCK_LEDGERS);
}

#[test]
#[should_panic]
fn test_update_bond_amount_rejects_zero() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let token_addr = sac.address();
    let governor_id = env.register(MockGovernorContract, ());
    let contract_id = env.register(ProposalBondsContract, ());
    let client = ProposalBondsContractClient::new(&env, &contract_id);
    client.initialize(
        &admin,
        &token_addr,
        &BOND_AMOUNT,
        &governor_id,
        &GRACE_LEDGERS,
        &MAX_LOCK_LEDGERS,
    );
    client.update_bond_amount(&admin, &0i128);
}

/// A proposal stuck in `Queued` forever (its timelock execution window
/// closed without `execute()` ever being called) has no path to a
/// governor-reported terminal state — see the doc comment on
/// `refund_bond`. Once `MaxLockLedgers` has elapsed since `lock_bond`,
/// refund must succeed regardless, so the bond isn't locked up forever.
#[test]
fn test_refund_escape_hatch_after_max_lock_ledgers_even_if_stuck_queued() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, token_addr, proposer, gov) = setup(&env);
    let tok = token::TokenClient::new(&env, &token_addr);
    let h = hash(&env, 1);
    client.lock_bond(&proposer, &h);

    let gov_client = MockGovernorContractClient::new(&env, &gov);
    gov_client.set_proposal(&1u64, &h);
    gov_client.set_state(&1u64, &ProposalState::Queued);

    let balance_before_refund = tok.balance(&proposer);

    env.ledger().with_mut(|l| l.sequence_number += MAX_LOCK_LEDGERS + 1);
    client.refund_bond(&proposer, &h, &1u64);

    assert_eq!(tok.balance(&proposer), balance_before_refund + BOND_AMOUNT);
    let bond = client.get_bond(&h).unwrap();
    assert_eq!(bond.state, BondState::Refunded);
}

#[test]
#[should_panic]
fn test_refund_stuck_queued_before_max_lock_ledgers_panics() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _token, proposer, gov) = setup(&env);
    let h = hash(&env, 1);
    client.lock_bond(&proposer, &h);

    let gov_client = MockGovernorContractClient::new(&env, &gov);
    gov_client.set_proposal(&1u64, &h);
    gov_client.set_state(&1u64, &ProposalState::Queued);

    // Still well before MAX_LOCK_LEDGERS — Queued must not be refundable
    // early, since the proposal could still be executed.
    client.refund_bond(&proposer, &h, &1u64);
}

#[test]
fn test_get_settings_reflects_initialize_args() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, token_addr, _proposer, gov) = setup(&env);

    let settings = client.get_settings();
    assert_eq!(settings.bond_token, token_addr);
    assert_eq!(settings.bond_amount, BOND_AMOUNT);
    assert_eq!(settings.governor, gov);
    assert_eq!(settings.refund_grace_ledgers, GRACE_LEDGERS);
    assert_eq!(settings.max_lock_ledgers, MAX_LOCK_LEDGERS);
}

// ── #1537: update_settings / set_admin ──────────────────────────────────────

fn last_event_topic(env: &Env) -> Symbol {
    env.events()
        .all()
        .last()
        .unwrap()
        .1
        .get(0)
        .unwrap()
        .try_into_val(env)
        .unwrap()
}

#[test]
fn test_update_settings_by_admin_replaces_settings_and_emits_event() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _token, _proposer, _gov, admin) = setup_with_admin(&env);

    let new_token = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();
    let new_governor = env.register(MockGovernorContract, ());
    client.update_settings(&admin, &new_token, &new_governor, &50u32, &2_000u32);
    assert_eq!(last_event_topic(&env), Symbol::new(&env, "SettingsUpdated"));

    assert_eq!(
        client.get_settings(),
        BondSettings {
            bond_token: new_token,
            bond_amount: BOND_AMOUNT,
            governor: new_governor,
            refund_grace_ledgers: 50,
            max_lock_ledgers: 2_000,
        }
    );
}

#[test]
fn test_update_settings_by_non_admin_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, token_addr, _proposer, gov, _admin) = setup_with_admin(&env);
    let attacker = Address::generate(&env);

    assert_eq!(
        client.try_update_settings(
            &attacker,
            &token_addr,
            &gov,
            &GRACE_LEDGERS,
            &MAX_LOCK_LEDGERS
        ),
        Err(Ok(ProposalBondsError::NotAuthorized.into())),
    );
}

#[test]
fn test_update_settings_rejects_unsafe_lock_windows() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, token_addr, _proposer, gov, admin) = setup_with_admin(&env);

    for (grace, max_lock) in [
        (GRACE_LEDGERS, 0),
        (GRACE_LEDGERS, GRACE_LEDGERS),
        (GRACE_LEDGERS, GRACE_LEDGERS - 1),
        (GRACE_LEDGERS, BOND_TTL_LEDGERS + 1),
    ] {
        assert_eq!(
            client.try_update_settings(&admin, &token_addr, &gov, &grace, &max_lock),
            Err(Ok(ProposalBondsError::InvalidLockWindow.into())),
            "grace {} / max lock {}",
            grace,
            max_lock,
        );
    }

    // The bond entry's TTL bump itself is still a valid upper bound.
    client.update_settings(&admin, &token_addr, &gov, &GRACE_LEDGERS, &BOND_TTL_LEDGERS);
    assert_eq!(client.get_settings().max_lock_ledgers, BOND_TTL_LEDGERS);
}

#[test]
fn test_refund_queries_the_updated_governor() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, token_addr, proposer, _old_gov, admin) = setup_with_admin(&env);
    let tok = token::TokenClient::new(&env, &token_addr);
    let h = hash(&env, 1);
    client.lock_bond(&proposer, &h);

    // The old governor knows nothing about proposal 1; only the new one does.
    let new_gov = env.register(MockGovernorContract, ());
    let new_gov_client = MockGovernorContractClient::new(&env, &new_gov);
    new_gov_client.set_proposal(&1u64, &h);
    new_gov_client.set_state(&1u64, &ProposalState::Defeated);
    client.update_settings(
        &admin,
        &token_addr,
        &new_gov,
        &GRACE_LEDGERS,
        &MAX_LOCK_LEDGERS,
    );

    env.ledger()
        .with_mut(|l| l.sequence_number += GRACE_LEDGERS + 1);
    let before = tok.balance(&proposer);
    client.refund_bond(&proposer, &h, &1u64);
    assert_eq!(tok.balance(&proposer), before + BOND_AMOUNT);
}

#[test]
fn test_slash_accepts_only_the_updated_governor() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, token_addr, proposer, old_gov, admin) = setup_with_admin(&env);
    let h = hash(&env, 1);
    client.lock_bond(&proposer, &h);

    let new_gov = env.register(MockGovernorContract, ());
    client.update_settings(
        &admin,
        &token_addr,
        &new_gov,
        &GRACE_LEDGERS,
        &MAX_LOCK_LEDGERS,
    );

    let recipient = Address::generate(&env);
    assert_eq!(
        client.try_slash(&old_gov, &h, &recipient),
        Err(Ok(ProposalBondsError::NotAuthorized.into())),
    );
    client.slash(&new_gov, &h, &recipient);
    assert_eq!(
        token::TokenClient::new(&env, &token_addr).balance(&recipient),
        BOND_AMOUNT
    );
}

#[test]
fn test_bond_token_change_keeps_locked_bonds_in_their_own_token() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, old_token, proposer, gov, admin) = setup_with_admin(&env);
    let old_tok = token::TokenClient::new(&env, &old_token);
    let h_old = hash(&env, 1);
    client.lock_bond(&proposer, &h_old);

    let new_token = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();
    let new_tok = token::TokenClient::new(&env, &new_token);
    token::StellarAssetClient::new(&env, &new_token).mint(&proposer, &BOND_AMOUNT);
    client.update_settings(&admin, &new_token, &gov, &GRACE_LEDGERS, &MAX_LOCK_LEDGERS);

    // A bond locked after the change is posted in the new token.
    let h_new = hash(&env, 2);
    client.lock_bond(&proposer, &h_new);
    assert_eq!(new_tok.balance(&client.address), BOND_AMOUNT);

    // The earlier bond is still refunded in the token it was locked in, and
    // the new-token bond's funds are left alone.
    let old_before = old_tok.balance(&proposer);
    env.ledger()
        .with_mut(|l| l.sequence_number += MAX_LOCK_LEDGERS + 1);
    client.refund_bond(&proposer, &h_old, &1u64);
    assert_eq!(old_tok.balance(&proposer), old_before + BOND_AMOUNT);
    assert_eq!(old_tok.balance(&client.address), 0);
    assert_eq!(new_tok.balance(&client.address), BOND_AMOUNT);

    // Slashing the new bond pays out in the new token.
    let recipient = Address::generate(&env);
    client.slash(&gov, &h_new, &recipient);
    assert_eq!(new_tok.balance(&recipient), BOND_AMOUNT);
}

#[test]
fn test_set_admin_rotates_admin_and_emits_event() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, token_addr, _proposer, gov, admin) = setup_with_admin(&env);
    let next = Address::generate(&env);

    client.set_admin(&admin, &next);
    assert_eq!(last_event_topic(&env), Symbol::new(&env, "AdminUpdated"));

    // The old admin has lost the role; the new one has it.
    assert_eq!(
        client.try_update_bond_amount(&admin, &2_000i128),
        Err(Ok(ProposalBondsError::NotAuthorized.into())),
    );
    client.update_bond_amount(&next, &2_000i128);
    client.update_settings(&next, &token_addr, &gov, &GRACE_LEDGERS, &MAX_LOCK_LEDGERS);
    assert_eq!(client.get_settings().bond_amount, 2_000);
}

#[test]
fn test_set_admin_by_non_admin_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _token, _proposer, _gov) = setup(&env);
    let attacker = Address::generate(&env);

    assert_eq!(
        client.try_set_admin(&attacker, &attacker),
        Err(Ok(ProposalBondsError::NotAuthorized.into())),
    );
}
