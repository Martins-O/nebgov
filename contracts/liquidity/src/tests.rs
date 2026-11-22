use super::{DataKey, LiquidityContract, LiquidityContractClient, LiquidityError};
use soroban_sdk::xdr::ToXdr;
use soroban_sdk::{
    contract, contractimpl, contracttype,
    testutils::{Address as _, Ledger as _},
    Address, Bytes, Env, IntoVal, String, Symbol, Val, Vec,
};
use sorogov_governor::{GovernorContract, GovernorContractClient, VoteSupport, VoteType};
use sorogov_timelock::{TimelockContract, TimelockContractClient};

#[contracttype]
#[derive(Clone)]
enum MockVotesDataKey {
    Votes(Address),
    TotalSupply,
}

#[contract]
pub struct MockVotesContract;

#[contractimpl]
impl MockVotesContract {
    pub fn set_votes(env: Env, account: Address, votes: i128) {
        env.storage()
            .instance()
            .set(&MockVotesDataKey::Votes(account), &votes);
    }

    pub fn set_total_supply(env: Env, total_supply: i128) {
        env.storage()
            .instance()
            .set(&MockVotesDataKey::TotalSupply, &total_supply);
    }

    pub fn get_votes(env: Env, account: Address) -> i128 {
        env.storage()
            .instance()
            .get(&MockVotesDataKey::Votes(account))
            .unwrap_or(0)
    }

    pub fn get_past_votes(env: Env, account: Address, _ledger: u32) -> i128 {
        Self::get_votes(env, account)
    }

    pub fn get_past_total_supply(env: Env, _ledger: u32) -> i128 {
        env.storage()
            .instance()
            .get(&MockVotesDataKey::TotalSupply)
            .unwrap_or(0)
    }
}

use soroban_sdk::token::StellarAssetClient;

fn setup_liquidity() -> (Env, Address, Address, Address, Address, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(LiquidityContract, ());
    let client = LiquidityContractClient::new(&env, &contract_id);

    let governor = Address::generate(&env);
    let provider = Address::generate(&env);
    let trader = Address::generate(&env);
    let admin = Address::generate(&env);

    let token_a = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();
    let token_b = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();

    let sac_a = StellarAssetClient::new(&env, &token_a);
    let sac_b = StellarAssetClient::new(&env, &token_b);
    sac_a.mint(&provider, &1_000_000);
    sac_b.mint(&provider, &1_000_000);
    sac_a.mint(&trader, &1_000_000);
    sac_b.mint(&trader, &1_000_000);

    client.initialize(&governor);

    (
        env,
        contract_id,
        governor,
        provider,
        trader,
        token_a,
        token_b,
    )
}

fn setup_pool(
    client: &LiquidityContractClient<'_>,
    governor: &Address,
    outcome_a: u32,
    outcome_b: u32,
    token_a: &Address,
    token_b: &Address,
) {
    client.create_pool(governor, &outcome_a, &outcome_b, token_a, token_b);
    client.initialize_pool(governor, &outcome_a, &outcome_b, &30);
}

fn mint_pair(
    env: &Env,
    token_a: &Address,
    token_b: &Address,
    account: &Address,
    amount_a: i128,
    amount_b: i128,
) {
    StellarAssetClient::new(env, token_a).mint(account, &amount_a);
    StellarAssetClient::new(env, token_b).mint(account, &amount_b);
}

#[test]
fn test_initialize_sets_governor() {
    let (env, contract_id, governor, _, _, _token_a, _token_b) = setup_liquidity();
    let client = LiquidityContractClient::new(&env, &contract_id);
    assert_eq!(client.governor(), governor);
}

#[test]
fn test_add_liquidity_creates_pool_and_position() {
    let (env, contract_id, governor, provider, _, token_a, token_b) = setup_liquidity();
    let client = LiquidityContractClient::new(&env, &contract_id);

    setup_pool(&client, &governor, 0, 1, &token_a, &token_b);
    let (lp_tokens, deposit_b) = client.add_liquidity(&provider, &0, &1, &10_000, &10_000, &0);
    assert_eq!(lp_tokens, 10_000);
    assert_eq!(deposit_b, 10_000);

    let pool = client.get_pool(&0, &1);
    assert_eq!(pool.reserve_a, 10_000);
    assert_eq!(pool.reserve_b, 10_000);
    assert_eq!(pool.total_lp_supply, 10_000);
    assert_eq!(pool.fee_bps, 30);
    assert_eq!(client.get_lp_position(&provider, &0, &1), 10_000);
}

#[test]
fn test_get_lp_position_defaults_to_zero() {
    let (env, contract_id, _, _, _, _token_a, _token_b) = setup_liquidity();
    let client = LiquidityContractClient::new(&env, &contract_id);
    let unknown_provider = Address::generate(&env);
    assert_eq!(client.get_lp_position(&unknown_provider, &0, &1), 0);
}

#[test]
fn test_initialize_pool_records_zero_reserve_pool_and_metadata() {
    let (env, contract_id, governor, _, _, token_a, token_b) = setup_liquidity();
    let client = LiquidityContractClient::new(&env, &contract_id);

    setup_pool(&client, &governor, 0, 1, &token_a, &token_b);

    let pool = client.get_pool(&0, &1);
    assert_eq!(pool.reserve_a, 0);
    assert_eq!(pool.reserve_b, 0);
    assert_eq!(pool.total_lp_supply, 0);
    assert_eq!(pool.fee_bps, 30);

    let metadata = client.get_pool_metadata(&0, &1);
    assert_eq!(metadata.created_by, governor);
    assert_eq!(metadata.created_ledger, env.ledger().sequence());
    assert_eq!(metadata.created_timestamp, env.ledger().timestamp());
}

#[test]
#[should_panic(expected = "#5")]
fn test_add_liquidity_rejects_uninitialized_pool() {
    let (env, contract_id, governor, provider, _, token_a, token_b) = setup_liquidity();
    let client = LiquidityContractClient::new(&env, &contract_id);

    client.create_pool(&governor, &0, &1, &token_a, &token_b);
    client.add_liquidity(&provider, &0, &1, &10_000, &10_000, &0);
}

#[test]
#[should_panic(expected = "#12")]
fn test_initialize_pool_rejects_non_governor() {
    let (env, contract_id, _, provider, _, _token_a, _token_b) = setup_liquidity();
    let client = LiquidityContractClient::new(&env, &contract_id);

    client.initialize_pool(&provider, &0, &1, &30);
}

#[test]
#[should_panic(expected = "#12")]
fn test_create_pool_rejects_non_governor() {
    let (env, contract_id, _, provider, _, token_a, token_b) = setup_liquidity();
    let client = LiquidityContractClient::new(&env, &contract_id);

    client.create_pool(&provider, &0, &1, &token_a, &token_b);
}

#[test]
fn test_remove_liquidity_burns_lp_tokens() {
    let (env, contract_id, governor, provider, _, token_a, token_b) = setup_liquidity();
    let client = LiquidityContractClient::new(&env, &contract_id);

    setup_pool(&client, &governor, 0, 1, &token_a, &token_b);
    client.add_liquidity(&provider, &0, &1, &10_000, &10_000, &0);
    let (amount_a, amount_b) = client.remove_liquidity(&provider, &0, &1, &4_000);

    assert_eq!(amount_a, 4_000);
    assert_eq!(amount_b, 4_000);

    let pool = client.get_pool(&0, &1);
    assert_eq!(pool.reserve_a, 6_000);
    assert_eq!(pool.reserve_b, 6_000);
    assert_eq!(pool.total_lp_supply, 6_000);
    assert_eq!(client.get_lp_position(&provider, &0, &1), 6_000);
}

#[test]
fn test_swap_updates_reserves_and_price() {
    let (env, contract_id, governor, provider, trader, token_a, token_b) = setup_liquidity();
    let client = LiquidityContractClient::new(&env, &contract_id);

    setup_pool(&client, &governor, 0, 1, &token_a, &token_b);
    client.add_liquidity(&provider, &0, &1, &10_000, &10_000, &0);
    let price_before = client.get_price(&0, &1);
    let amount_out = client.swap(&trader, &0, &1, &1_000, &0);
    let price_after = client.get_price(&0, &1);

    assert!(amount_out > 0);
    assert!(amount_out < 1_000);
    assert!(price_after < price_before);
}

#[test]
fn test_update_pool_fee_changes_fee_for_governor() {
    let (env, contract_id, governor, provider, _, token_a, token_b) = setup_liquidity();
    let client = LiquidityContractClient::new(&env, &contract_id);

    setup_pool(&client, &governor, 0, 1, &token_a, &token_b);
    client.add_liquidity(&provider, &0, &1, &10_000, &10_000, &0);
    client.update_pool_fee(&governor, &0, &1, &75);

    let pool = client.get_pool(&0, &1);
    assert_eq!(pool.fee_bps, 75);
}

#[test]
#[should_panic(expected = "#12")]
fn test_update_pool_fee_rejects_non_governor() {
    let (env, contract_id, governor, provider, _, token_a, token_b) = setup_liquidity();
    let client = LiquidityContractClient::new(&env, &contract_id);
    let unauthorized = Address::generate(&env);

    setup_pool(&client, &governor, 0, 1, &token_a, &token_b);
    client.add_liquidity(&provider, &0, &1, &10_000, &10_000, &0);
    client.update_pool_fee(&unauthorized, &0, &1, &75);
}

#[test]
#[should_panic(expected = "#1")]
fn test_add_liquidity_rejects_zero_amounts() {
    let (env, contract_id, governor, provider, _, token_a, token_b) = setup_liquidity();
    let client = LiquidityContractClient::new(&env, &contract_id);
    setup_pool(&client, &governor, 0, 1, &token_a, &token_b);
    client.add_liquidity(&provider, &0, &1, &0, &10_000, &0);
}

#[test]
#[should_panic(expected = "Error(Contract, #4)")]
fn test_add_liquidity_rejects_arithmetic_overflow() {
    let (env, contract_id, governor, _, _, token_a, token_b) = setup_liquidity();
    let client = LiquidityContractClient::new(&env, &contract_id);
    let whale = Address::generate(&env);
    let provider2 = Address::generate(&env);

    setup_pool(&client, &governor, 0, 1, &token_a, &token_b);
    StellarAssetClient::new(&env, &token_a).mint(&whale, &i128::MAX);
    StellarAssetClient::new(&env, &token_b).mint(&whale, &i128::MAX);

    client.add_liquidity(&whale, &0, &1, &i128::MAX, &i128::MAX, &0);
    client.add_liquidity(&provider2, &0, &1, &1_000, &1_000, &0);
}

#[test]
#[should_panic(expected = "#10")]
fn test_update_pool_fee_rejects_excessive_fee() {
    let (env, contract_id, governor, provider, _, token_a, token_b) = setup_liquidity();
    let client = LiquidityContractClient::new(&env, &contract_id);

    setup_pool(&client, &governor, 0, 1, &token_a, &token_b);
    client.add_liquidity(&provider, &0, &1, &10_000, &10_000, &0);
    client.update_pool_fee(&governor, &0, &1, &1_001);
}

#[test]
fn test_governor_proposal_executes_liquidity_fee_update() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();

    let admin = Address::generate(&env);
    let guardian = Address::generate(&env);
    let proposer = Address::generate(&env);
    let voter = Address::generate(&env);
    let provider = Address::generate(&env);

    let votes_id = env.register(MockVotesContract, ());
    let votes_client = MockVotesContractClient::new(&env, &votes_id);
    votes_client.set_votes(&proposer, &500);
    votes_client.set_votes(&voter, &500);
    votes_client.set_total_supply(&1_000);

    let token_a = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();
    let token_b = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();
    soroban_sdk::token::StellarAssetClient::new(&env, &token_a).mint(&provider, &1_000_000);
    soroban_sdk::token::StellarAssetClient::new(&env, &token_b).mint(&provider, &1_000_000);

    let liquidity_id = env.register(LiquidityContract, ());
    let liquidity_client = LiquidityContractClient::new(&env, &liquidity_id);

    let timelock_id = env.register(TimelockContract, ());
    let governor_id = env.register(GovernorContract, ());

    let timelock_client = TimelockContractClient::new(&env, &timelock_id);
    let governor_client = GovernorContractClient::new(&env, &governor_id);

    liquidity_client.initialize(&governor_id);
    liquidity_client.create_pool(&governor_id, &0, &1, &token_a, &token_b);
    liquidity_client.initialize_pool(&governor_id, &0, &1, &30);
    liquidity_client.add_liquidity(&provider, &0, &1, &10_000, &10_000, &0);

    timelock_client.initialize(&admin, &governor_id, &1, &1_209_600);
    governor_client.initialize(
        &admin,
        &votes_id,
        &timelock_id,
        &0,
        &5,
        &0,
        &0,
        &guardian,
        &VoteType::Extended,
        &120_960,
    );

    let description = String::from_str(&env, "Update liquidity pool fee");
    let description_hash = env
        .crypto()
        .sha256(&Bytes::from_slice(&env, b"update-liquidity-pool-fee"))
        .into();
    let metadata_uri = String::from_str(&env, "ipfs://liquidity-fee-update");

    let mut targets = Vec::new(&env);
    targets.push_back(liquidity_id.clone());

    let mut fn_names = Vec::new(&env);
    fn_names.push_back(Symbol::new(&env, "update_pool_fee"));

    let mut args: Vec<Val> = Vec::new(&env);
    args.push_back(governor_id.clone().into_val(&env));
    args.push_back(0u32.into_val(&env));
    args.push_back(1u32.into_val(&env));
    args.push_back(75u32.into_val(&env));

    let mut calldatas = Vec::new(&env);
    calldatas.push_back(args.to_xdr(&env));

    let proposal_id = governor_client.propose(
        &proposer,
        &description,
        &description_hash,
        &metadata_uri,
        &targets,
        &fn_names,
        &calldatas,
    );

    governor_client.cast_vote(&voter, &proposal_id, &VoteSupport::For);
    env.ledger().with_mut(|ledger| ledger.sequence_number = 6);

    governor_client.queue(&proposal_id);
    let queued_pool = liquidity_client.get_pool(&0, &1);
    assert_eq!(queued_pool.fee_bps, 30);

    let queue_timestamp = env.ledger().timestamp();
    env.ledger()
        .with_mut(|ledger| ledger.timestamp = queue_timestamp + 2);

    governor_client.execute(&proposal_id);

    let updated_pool = liquidity_client.get_pool(&0, &1);
    assert_eq!(updated_pool.fee_bps, 75);
}
// ============================================================================
// TESTS FOR RATIO ENFORCEMENT IN ADD_LIQUIDITY (Issue #588)
// ============================================================================

#[test]
#[should_panic(expected = "#3")]
fn test_add_liquidity_rejects_amount_b_below_ratio() {
    // Pool has a 1:2 ratio (A:B). A subsequent deposit providing too little B
    // must be rejected so the pool price cannot be manipulated downward.
    let (env, contract_id, governor, provider, _, token_a, token_b) = setup_liquidity();
    let client = LiquidityContractClient::new(&env, &contract_id);
    let provider2 = Address::generate(&env);

    setup_pool(&client, &governor, 0, 1, &token_a, &token_b);
    client.add_liquidity(&provider, &0, &1, &10_000, &20_000, &0); // ratio 1:2
                                                               // required_b = 1_000 * 20_000 / 10_000 = 2_000; providing only 1_000 must panic
    client.add_liquidity(&provider2, &0, &1, &1_000, &1_000, &0);
}

#[test]
fn test_add_liquidity_excess_amount_b_only_credits_required() {
    // When amount_b exceeds what the reserve ratio requires, only the
    // proportionally correct required_b is credited to pool reserves.
    // This prevents reserve_b inflation while allowing a caller-supplied
    // slippage buffer (excess is silently trimmed).
    let (env, contract_id, governor, provider, _, token_a, token_b) = setup_liquidity();
    let client = LiquidityContractClient::new(&env, &contract_id);
    let provider2 = Address::generate(&env);

    setup_pool(&client, &governor, 0, 1, &token_a, &token_b);
    client.add_liquidity(&provider, &0, &1, &10_000, &20_000, &0); // ratio 1:2
    mint_pair(&env, &token_a, &token_b, &provider2, 1_000, 2_000);

    // Provider2 declares amount_b = 99_990 (far above required 2_000 for 1_000 A).
    // Only required_b = 1_000 * 20_000 / 10_000 = 2_000 should be credited.
    client.add_liquidity(&provider2, &0, &1, &1_000, &99_990, &0);

    let pool = client.get_pool(&0, &1);
    assert_eq!(pool.reserve_a, 11_000);
    assert_eq!(pool.reserve_b, 22_000); // 20_000 + 2_000, not 20_000 + 99_990
                                        // Ratio 1:2 preserved
    assert_eq!(pool.reserve_b / pool.reserve_a, 2);
}

#[test]
fn test_add_liquidity_proportional_second_deposit_exact() {
    // A deposit providing exactly the proportional amount_b passes and
    // maintains the pool ratio without any rounding drift.
    let (env, contract_id, governor, provider, _, token_a, token_b) = setup_liquidity();
    let client = LiquidityContractClient::new(&env, &contract_id);
    let provider2 = Address::generate(&env);

    setup_pool(&client, &governor, 0, 1, &token_a, &token_b);
    client.add_liquidity(&provider, &0, &1, &10_000, &20_000, &0); // ratio 1:2
    mint_pair(&env, &token_a, &token_b, &provider2, 5_000, 10_000);
    client.add_liquidity(&provider2, &0, &1, &5_000, &10_000, &0); // exact: 5000*2=10000

    let pool = client.get_pool(&0, &1);
    assert_eq!(pool.reserve_a, 15_000);
    assert_eq!(pool.reserve_b, 30_000);
    assert_eq!(pool.reserve_b / pool.reserve_a, 2);
}

#[test]
fn test_add_liquidity_lp_tokens_minted_correctly_for_second_deposit() {
    // LP tokens for a second deposit must be proportional to amount_a only,
    // ensuring both providers hold fair shares of the pool.
    let (env, contract_id, governor, provider, _, token_a, token_b) = setup_liquidity();
    let client = LiquidityContractClient::new(&env, &contract_id);
    let provider2 = Address::generate(&env);

    setup_pool(&client, &governor, 0, 1, &token_a, &token_b);
    let (lp1, _) = client.add_liquidity(&provider, &0, &1, &10_000, &20_000, &0);
    assert_eq!(lp1, 10_000);

    // 5_000 A is 50% of reserve_a=10_000 → should mint 5_000 LP tokens
    mint_pair(&env, &token_a, &token_b, &provider2, 5_000, 10_000);
    let (lp2, _) = client.add_liquidity(&provider2, &0, &1, &5_000, &10_000, &0);
    assert_eq!(lp2, 5_000);

    let pool = client.get_pool(&0, &1);
    assert_eq!(pool.total_lp_supply, 15_000);
    assert_eq!(client.get_lp_position(&provider, &0, &1), 10_000);
    assert_eq!(client.get_lp_position(&provider2, &0, &1), 5_000);
}

#[test]
fn test_add_liquidity_first_deposit_accepts_any_ratio() {
    // The first deposit (total_lp_supply == 0) sets the initial price and must
    // not be subject to any ratio check.
    let (env, contract_id, governor, provider, _, token_a, token_b) = setup_liquidity();
    let client = LiquidityContractClient::new(&env, &contract_id);

    setup_pool(&client, &governor, 0, 1, &token_a, &token_b);
    let (lp, deposit_b) = client.add_liquidity(&provider, &0, &1, &1_000, &99_000, &0);
    assert_eq!(lp, 1_000);
    assert_eq!(deposit_b, 99_000);
    let pool = client.get_pool(&0, &1);
    assert_eq!(pool.reserve_a, 1_000);
    assert_eq!(pool.reserve_b, 99_000);
}

#[test]
fn test_add_liquidity_poc_attack_prevented() {
    // Reproduction of the PoC from issue #588:
    //   Alice seeds the pool at ratio 1:2.
    //   Bob calls add_liquidity with proportional amount_a but a massive amount_b.
    //
    // Before the fix, Bob's deposit inflated reserve_b, corrupting the pool price
    // and letting Alice extract far more B than she deposited.
    //
    // After the fix, only required_b is credited for Bob's deposit, the pool
    // ratio stays at 1:2, and Alice's withdrawal recovers exactly what she put in.
    let (env, contract_id, governor, alice, _, token_a, token_b) = setup_liquidity();
    let client = LiquidityContractClient::new(&env, &contract_id);
    let bob = Address::generate(&env);

    setup_pool(&client, &governor, 0, 1, &token_a, &token_b);
    // Alice: 10_000 A + 20_000 B → 10_000 LP, ratio 1:2
    client.add_liquidity(&alice, &0, &1, &10_000, &20_000, &0);

    // Bob: 1_000 A + 100_000 B (attack: amount_b far exceeds the 1:2 ratio).
    // required_b = 1_000 * 20_000 / 10_000 = 2_000 → only 2_000 B credited.
    mint_pair(&env, &token_a, &token_b, &bob, 1_000, 2_000);
    client.add_liquidity(&bob, &0, &1, &1_000, &100_000, &0);

    let pool = client.get_pool(&0, &1);
    // Pool must reflect only the proportional deposit, not the inflated one
    assert_eq!(pool.reserve_a, 11_000);
    assert_eq!(pool.reserve_b, 22_000); // 20_000 + 2_000, not 20_000 + 100_000
    assert_eq!(pool.reserve_b / pool.reserve_a, 2); // ratio intact

    // Bob holds 1_000 LP tokens (1_000 * 10_000 / 10_000 = 1_000)
    assert_eq!(client.get_lp_position(&bob, &0, &1), 1_000);

    // Alice removes her 10_000 LP and must recover approximately what she put in
    let (alice_a, alice_b) = client.remove_liquidity(&alice, &0, &1, &10_000);
    // 10_000/11_000 of reserve_a=11_000 = 10_000 A
    // 10_000/11_000 of reserve_b=22_000 = 20_000 B
    assert_eq!(alice_a, 10_000);
    assert_eq!(alice_b, 20_000);
}

#[test]
fn test_add_liquidity_returns_actual_deposit_b() {
    // add_liquidity now returns (lp_tokens, deposit_b). deposit_b is the amount
    // of B actually credited — equal to required_b, not the caller-supplied amount_b.
    // Integrators must use deposit_b to reconcile their balance.
    let (env, contract_id, governor, provider, _, token_a, token_b) = setup_liquidity();
    let client = LiquidityContractClient::new(&env, &contract_id);
    let provider2 = Address::generate(&env);

    setup_pool(&client, &governor, 0, 1, &token_a, &token_b);
    client.add_liquidity(&provider, &0, &1, &10_000, &20_000, &0); // ratio 1:2

    // required_b = 5_000 * 20_000 / 10_000 = 10_000; caller passes 50_000 as slippage buffer
    mint_pair(&env, &token_a, &token_b, &provider2, 5_000, 10_000);
    let (lp_tokens, deposit_b) = client.add_liquidity(&provider2, &0, &1, &5_000, &50_000, &0);
    assert_eq!(lp_tokens, 5_000);
    assert_eq!(deposit_b, 10_000); // only proportional amount credited, not 50_000
}

#[test]
#[should_panic(expected = "#8")]
fn test_add_liquidity_rejects_required_b_below_minimum() {
    // On a heavily skewed pool (large reserve_a, tiny reserve_b), required_b for
    // a small deposit rounds down below MIN_LIQUIDITY. This must be rejected even
    // when amount_b is well above MIN_LIQUIDITY (the old guard was insufficient).
    let (env, contract_id, governor, provider, _, token_a, token_b) = setup_liquidity();
    let client = LiquidityContractClient::new(&env, &contract_id);
    let provider2 = Address::generate(&env);

    setup_pool(&client, &governor, 0, 1, &token_a, &token_b);
    // Seed pool: 1_000_000 A vs 1_000 B (heavily skewed)
    client.add_liquidity(&provider, &0, &1, &1_000_000, &1_000, &0);
    // required_b = 1_000 * 1_000 / 1_000_000 = 1 — below MIN_LIQUIDITY (1_000)
    // amount_b = 5_000 passes the old guard but required_b does not
    client.add_liquidity(&provider2, &0, &1, &1_000, &5_000, &0);
}

#[test]
#[should_panic(expected = "Error(Contract, #11)")]
fn test_add_liquidity_rejects_slippage_below_min_lp() {
    let (env, contract_id, governor, provider, _, token_a, token_b) = setup_liquidity();
    let client = LiquidityContractClient::new(&env, &contract_id);

    setup_pool(&client, &governor, 0, 1, &token_a, &token_b);
    StellarAssetClient::new(&env, &token_a).mint(&provider, &100_000);
    StellarAssetClient::new(&env, &token_b).mint(&provider, &100_000);

    // First deposit as initial LP
    client.add_liquidity(&provider, &0, &1, &10_000, &10_000, &0);

    // Second deposit with min_lp_tokens_out higher than the calculated lp
    // After first deposit (10_000 A + 10_000 B), a second deposit of
    // 1_000 A mints 1_000 LP tokens, so asking for 2_000 should fail
    client.add_liquidity(&provider, &0, &1, &1_000, &1_000, &2_000);
}

#[test]
#[should_panic(expected = "#13")]
fn test_add_liquidity_rejects_deposit_that_mints_zero_lp_tokens() {
    // When reserve_a >> total_lp (which occurs after heavy A-in swaps), integer
    // division in `lp = amount_a * total_lp / reserve_a` yields 0 even for a
    // minimum-sized deposit. Without the guard the caller loses both amounts with
    // no LP tokens to show for it.
    //
    // Setup (pool 2/3, separate from the test's default pool 0/1):
    //   First deposit: 1_000 A + 1_000_000_000 B → total_lp = 1_000
    //   Swap 1_000_000 A in:
    //     amount_out = 1_000_000 * 1_000_000_000 / 1_001_000 = 999_000_999
    //     fee        = 999_000_999 * 30 / 10_000 = 2_997_002
    //     net_out    = 996_003_997
    //     → reserve_a = 1_001_000, reserve_b = 3_996_003, total_lp = 1_000
    //   Second deposit (1_000 A):
    //     required_b = 1_000 * 3_996_003 / 1_001_000 = 3_992  (≥ MIN_LIQUIDITY ✓)
    //     lp         = 1_000 * 1_000 / 1_001_000 = 0          (1_001_000 > 1_000_000)
    let (env, contract_id, governor, provider, _, token_a, token_b) = setup_liquidity();
    let client = LiquidityContractClient::new(&env, &contract_id);
    let provider2 = Address::generate(&env);

    setup_pool(&client, &governor, 2, 3, &token_a, &token_b);
    StellarAssetClient::new(&env, &token_a).mint(&provider, &1_000_000);
    StellarAssetClient::new(&env, &token_b).mint(&provider, &1_000_000_000);
    client.add_liquidity(&provider, &2, &3, &1_000, &1_000_000_000, &0);
    client.swap(&provider, &2, &3, &1_000_000, &0);
    // amount_b = 4_000 ≥ required_b = 3_992; only lp = 0 triggers the panic
    client.add_liquidity(&provider2, &2, &3, &1_000, &4_000, &0);
}

// ============================================================================
// SECURITY TESTS FOR REMOVE_LIQUIDITY GUARDS (Issue #471)
// ============================================================================

#[test]
#[should_panic(expected = "#1")]
fn test_remove_liquidity_rejects_zero_shares() {
    let (env, contract_id, governor, provider, _, token_a, token_b) = setup_liquidity();
    let client = LiquidityContractClient::new(&env, &contract_id);

    setup_pool(&client, &governor, 0, 1, &token_a, &token_b);
    client.add_liquidity(&provider, &0, &1, &10_000, &10_000, &0);

    // Attempt to remove zero shares - should panic with InvalidAmount
    client.remove_liquidity(&provider, &0, &1, &0);
}

#[test]
#[should_panic(expected = "#1")]
fn test_remove_liquidity_rejects_negative_shares() {
    let (env, contract_id, governor, provider, _, token_a, token_b) = setup_liquidity();
    let client = LiquidityContractClient::new(&env, &contract_id);

    setup_pool(&client, &governor, 0, 1, &token_a, &token_b);
    client.add_liquidity(&provider, &0, &1, &10_000, &10_000, &0);

    // Attempt to remove negative shares - should panic with InvalidAmount
    client.remove_liquidity(&provider, &0, &1, &-1);
}

#[test]
#[should_panic(expected = "#2")]
fn test_remove_liquidity_rejects_excessive_shares() {
    let (env, contract_id, governor, provider, _, token_a, token_b) = setup_liquidity();
    let client = LiquidityContractClient::new(&env, &contract_id);

    // Provider adds 100 LP tokens
    setup_pool(&client, &governor, 0, 1, &token_a, &token_b);
    client.add_liquidity(&provider, &0, &1, &10_000, &10_000, &0);
    assert_eq!(client.get_lp_position(&provider, &0, &1), 10_000);

    // Attempt to remove 10_001 shares (exceeds balance of 10_000) - should panic with InsufficientShares
    client.remove_liquidity(&provider, &0, &1, &10_001);
}

#[test]
#[should_panic(expected = "#2")]
fn test_remove_liquidity_rejects_zero_share_provider_positive_amount() {
    let (env, contract_id, governor, provider, _, token_a, token_b) = setup_liquidity();
    let client = LiquidityContractClient::new(&env, &contract_id);
    let other_provider = Address::generate(&env);

    // Setup: provider1 adds liquidity
    setup_pool(&client, &governor, 0, 1, &token_a, &token_b);
    client.add_liquidity(&provider, &0, &1, &10_000, &10_000, &0);

    // other_provider has zero LP shares (never added liquidity)
    assert_eq!(client.get_lp_position(&other_provider, &0, &1), 0);

    // Attempt to remove positive shares as other_provider (who has 0 balance) - should panic with InsufficientShares
    client.remove_liquidity(&other_provider, &0, &1, &1);
}

#[test]
fn test_remove_liquidity_valid_exact_balance() {
    let (env, contract_id, governor, provider, _, token_a, token_b) = setup_liquidity();
    let client = LiquidityContractClient::new(&env, &contract_id);

    // Setup: provider adds 10_000 LP tokens
    setup_pool(&client, &governor, 0, 1, &token_a, &token_b);
    client.add_liquidity(&provider, &0, &1, &10_000, &10_000, &0);
    assert_eq!(client.get_lp_position(&provider, &0, &1), 10_000);

    // Remove exact balance (10_000 shares)
    let (amount_a, amount_b) = client.remove_liquidity(&provider, &0, &1, &10_000);

    // Verify correct amounts returned (should be proportional to 100% of reserves)
    assert_eq!(amount_a, 10_000);
    assert_eq!(amount_b, 10_000);

    // Verify provider's balance is now 0
    assert_eq!(client.get_lp_position(&provider, &0, &1), 0);

    // Verify pool reserves are depleted
    let pool = client.get_pool(&0, &1);
    assert_eq!(pool.reserve_a, 0);
    assert_eq!(pool.reserve_b, 0);
    assert_eq!(pool.total_lp_supply, 0);
}

#[test]
fn test_remove_liquidity_valid_partial_removal() {
    let (env, contract_id, governor, provider, _, token_a, token_b) = setup_liquidity();
    let client = LiquidityContractClient::new(&env, &contract_id);

    // Setup: provider adds 10_000 LP tokens
    setup_pool(&client, &governor, 0, 1, &token_a, &token_b);
    client.add_liquidity(&provider, &0, &1, &10_000, &10_000, &0);
    assert_eq!(client.get_lp_position(&provider, &0, &1), 10_000);

    // Remove 50% (5_000 shares)
    let (amount_a, amount_b) = client.remove_liquidity(&provider, &0, &1, &5_000);

    // Verify correct amounts returned (50% of reserves)
    assert_eq!(amount_a, 5_000);
    assert_eq!(amount_b, 5_000);

    // Verify provider's remaining balance is 50%
    assert_eq!(client.get_lp_position(&provider, &0, &1), 5_000);

    // Verify pool reserves are reduced by 50%
    let pool = client.get_pool(&0, &1);
    assert_eq!(pool.reserve_a, 5_000);
    assert_eq!(pool.reserve_b, 5_000);
    assert_eq!(pool.total_lp_supply, 5_000);
}

#[test]
fn test_remove_liquidity_state_unchanged_on_invalid_amount_guard() {
    let (env, contract_id, governor, provider, _, token_a, token_b) = setup_liquidity();
    let client = LiquidityContractClient::new(&env, &contract_id);

    // Setup: provider adds 10_000 LP tokens
    setup_pool(&client, &governor, 0, 1, &token_a, &token_b);
    client.add_liquidity(&provider, &0, &1, &10_000, &10_000, &0);

    // Record initial state
    let initial_balance = client.get_lp_position(&provider, &0, &1);
    let initial_pool = client.get_pool(&0, &1);

    // Attempt invalid removal (zero shares) - will panic
    let result = client.try_remove_liquidity(&provider, &0, &1, &0);
    assert!(result.is_err());

    // Verify state is unchanged after failed guard
    assert_eq!(client.get_lp_position(&provider, &0, &1), initial_balance);
    let pool_after = client.get_pool(&0, &1);
    assert_eq!(pool_after.reserve_a, initial_pool.reserve_a);
    assert_eq!(pool_after.reserve_b, initial_pool.reserve_b);
    assert_eq!(pool_after.total_lp_supply, initial_pool.total_lp_supply);
}

#[test]
fn test_remove_liquidity_state_unchanged_on_insufficient_shares_guard() {
    let (env, contract_id, governor, provider, _, token_a, token_b) = setup_liquidity();
    let client = LiquidityContractClient::new(&env, &contract_id);

    // Setup: provider adds 10_000 LP tokens
    setup_pool(&client, &governor, 0, 1, &token_a, &token_b);
    client.add_liquidity(&provider, &0, &1, &10_000, &10_000, &0);

    // Record initial state
    let initial_balance = client.get_lp_position(&provider, &0, &1);
    let initial_pool = client.get_pool(&0, &1);

    // Attempt invalid removal (balance exceeded) - will panic
    let result = client.try_remove_liquidity(&provider, &0, &1, &10_001);
    assert!(result.is_err());

    // Verify state is unchanged after failed guard
    assert_eq!(client.get_lp_position(&provider, &0, &1), initial_balance);
    let pool_after = client.get_pool(&0, &1);
    assert_eq!(pool_after.reserve_a, initial_pool.reserve_a);
    assert_eq!(pool_after.reserve_b, initial_pool.reserve_b);
    assert_eq!(pool_after.total_lp_supply, initial_pool.total_lp_supply);
}

#[test]
fn test_liquidity_error_codes_snapshot() {
    // Snapshot: each LiquidityError variant maps to a stable u32.
    assert_eq!(LiquidityError::InvalidAmount as u32, 1);
    assert_eq!(LiquidityError::InsufficientShares as u32, 2);
    assert_eq!(LiquidityError::ImbalancedDeposit as u32, 3);
    assert_eq!(LiquidityError::ArithmeticOverflow as u32, 4);
    assert_eq!(LiquidityError::PoolNotFound as u32, 5);
    assert_eq!(LiquidityError::InsufficientReserves as u32, 6);
    assert_eq!(LiquidityError::SameOutcome as u32, 7);
    assert_eq!(LiquidityError::BelowMinLiquidity as u32, 8);
    assert_eq!(LiquidityError::AlreadyInitialized as u32, 9);
    assert_eq!(LiquidityError::FeeTooHigh as u32, 10);
    assert_eq!(LiquidityError::SlippageExceeded as u32, 11);
    assert_eq!(LiquidityError::NotGovernor as u32, 12);
    assert_eq!(LiquidityError::DepositTooSmall as u32, 13);
    assert_eq!(LiquidityError::PoolTokensNotFound as u32, 14);
}

#[test]
fn test_remove_liquidity_missing_pool_tokens_returns_typed_error() {
    let (env, contract_id, governor, provider, _, token_a, token_b) = setup_liquidity();
    let client = LiquidityContractClient::new(&env, &contract_id);

    setup_pool(&client, &governor, 0, 1, &token_a, &token_b);
    client.add_liquidity(&provider, &0, &1, &10_000, &10_000, &0);

    env.as_contract(&contract_id, || {
        env.storage()
            .persistent()
            .remove(&DataKey::PoolTokens(0, 1));
    });

    assert!(matches!(
        client.try_remove_liquidity(&provider, &0, &1, &10_000),
        Err(Ok(LiquidityError::PoolTokensNotFound))
    ));
}

#[test]
fn test_swap_missing_pool_tokens_returns_typed_error() {
    let (env, contract_id, governor, provider, trader, token_a, token_b) = setup_liquidity();
    let client = LiquidityContractClient::new(&env, &contract_id);

    setup_pool(&client, &governor, 0, 1, &token_a, &token_b);
    client.add_liquidity(&provider, &0, &1, &10_000, &10_000, &0);

    env.as_contract(&contract_id, || {
        env.storage()
            .persistent()
            .remove(&DataKey::PoolTokens(0, 1));
    });

    assert!(matches!(
        client.try_swap(&trader, &0, &1, &100, &0),
        Err(Ok(LiquidityError::PoolTokensNotFound))
    ));
}

// ============================================================================
// TESTS FOR INITIAL DEPOSIT LP TOKEN MINTING (Issue #709)
// ============================================================================

#[test]
fn test_initial_deposit_returns_exactly_amount_a_lp_tokens() {
    let (env, contract_id, governor, provider, _, token_a, token_b) = setup_liquidity();
    let client = LiquidityContractClient::new(&env, &contract_id);

    setup_pool(&client, &governor, 0, 1, &token_a, &token_b);

    // Initial deposit (total_lp_supply == 0): must return amount_a as LP tokens
    let (lp_tokens, deposit_b) = client.add_liquidity(&provider, &0, &1, &50_000, &50_000, &0);
    assert_eq!(
        lp_tokens, 50_000,
        "initial deposit must mint exactly amount_a LP tokens"
    );
    assert_eq!(deposit_b, 50_000);

    let pool = client.get_pool(&0, &1);
    assert_eq!(pool.reserve_a, 50_000);
    assert_eq!(pool.reserve_b, 50_000);
    assert_eq!(pool.total_lp_supply, 50_000);
}

#[test]
fn test_second_deposit_returns_proportional_lp_tokens() {
    let (env, contract_id, governor, provider, _, token_a, token_b) = setup_liquidity();
    let client = LiquidityContractClient::new(&env, &contract_id);
    let provider2 = Address::generate(&env);

    setup_pool(&client, &governor, 0, 1, &token_a, &token_b);

    // First deposit: 100_000 A + 100_000 B → total_lp_supply = 100_000
    let (lp1, _) = client.add_liquidity(&provider, &0, &1, &100_000, &100_000, &0);
    assert_eq!(lp1, 100_000);

    // Second deposit: 25_000 A → lp = 25_000 * 100_000 / 100_000 = 25_000
    mint_pair(&env, &token_a, &token_b, &provider2, 25_000, 25_000);
    let (lp2, _) = client.add_liquidity(&provider2, &0, &1, &25_000, &25_000, &0);
    assert_eq!(
        lp2, 25_000,
        "second deposit must mint proportional LP tokens"
    );

    let pool = client.get_pool(&0, &1);
    assert_eq!(pool.reserve_a, 125_000);
    assert_eq!(pool.reserve_b, 125_000);
}

#[test]
fn test_total_lp_supply_equals_sum_of_minted_lp_tokens() {
    let (env, contract_id, governor, provider, _, token_a, token_b) = setup_liquidity();
    let client = LiquidityContractClient::new(&env, &contract_id);
    let provider2 = Address::generate(&env);

    setup_pool(&client, &governor, 0, 1, &token_a, &token_b);

    let (lp1, _) = client.add_liquidity(&provider, &0, &1, &100_000, &100_000, &0);
    mint_pair(&env, &token_a, &token_b, &provider2, 50_000, 50_000);
    let (lp2, _) = client.add_liquidity(&provider2, &0, &1, &50_000, &50_000, &0);

    let pool = client.get_pool(&0, &1);
    assert_eq!(
        pool.total_lp_supply,
        lp1 + lp2,
        "pool.total_lp_supply ({}) must equal lp1 ({}) + lp2 ({})",
        pool.total_lp_supply,
        lp1,
        lp2
    );
}

// ============================================================================
// CONSTANT-PRODUCT INVARIANT TESTS (Issue #654)
// ============================================================================

#[test]
fn test_constant_product_invariant_preserved_after_swap() {
    let (env, contract_id, governor, provider, trader, token_a, token_b) = setup_liquidity();
    let client = LiquidityContractClient::new(&env, &contract_id);

    setup_pool(&client, &governor, 0, 1, &token_a, &token_b);
    client.add_liquidity(&provider, &0, &1, &100_000, &100_000, &0);

    let pool = client.get_pool(&0, &1);
    let k_before = pool.reserve_a * pool.reserve_b;

    client.swap(&trader, &0, &1, &10_000, &0);

    let pool_after = client.get_pool(&0, &1);
    let k_after = pool_after.reserve_a * pool_after.reserve_b;

    // k must not decrease: fee is retained in reserves
    assert!(k_after >= k_before, "k decreased: {} < {}", k_after, k_before);
}

#[test]
fn test_constant_product_invariant_with_zero_fee() {
    let (env, contract_id, governor, provider, trader, token_a, token_b) = setup_liquidity();
    let client = LiquidityContractClient::new(&env, &contract_id);

    setup_pool(&client, &governor, 0, 1, &token_a, &token_b);
    client.update_pool_fee(&governor, &0, &1, &0);
    client.add_liquidity(&provider, &0, &1, &100_000, &100_000, &0);

    let pool = client.get_pool(&0, &1);
    let k_before = pool.reserve_a * pool.reserve_b;

    client.swap(&trader, &0, &1, &10_000, &0);

    let pool_after = client.get_pool(&0, &1);
    let k_after = pool_after.reserve_a * pool_after.reserve_b;

    // With no fee, k must not decrease (integer division rounding increases k slightly)
    assert!(k_after >= k_before, "zero-fee swap must preserve k: {} < {}", k_after, k_before);
}

#[test]
fn test_constant_product_invariant_with_max_fee() {
    let (env, contract_id, governor, provider, trader, token_a, token_b) = setup_liquidity();
    let client = LiquidityContractClient::new(&env, &contract_id);

    setup_pool(&client, &governor, 0, 1, &token_a, &token_b);
    client.update_pool_fee(&governor, &0, &1, &1000);
    client.add_liquidity(&provider, &0, &1, &100_000, &100_000, &0);

    let pool = client.get_pool(&0, &1);
    let k_before = pool.reserve_a * pool.reserve_b;

    client.swap(&trader, &0, &1, &10_000, &0);

    let pool_after = client.get_pool(&0, &1);
    let k_after = pool_after.reserve_a * pool_after.reserve_b;

    // With max fee (10%), k must increase
    assert!(k_after > k_before, "max-fee swap must increase k: {} <= {}", k_after, k_before);
}

#[test]
fn test_constant_product_invariant_large_swap() {
    let (env, contract_id, governor, provider, trader, token_a, token_b) = setup_liquidity();
    let client = LiquidityContractClient::new(&env, &contract_id);

    setup_pool(&client, &governor, 0, 1, &token_a, &token_b);
    client.add_liquidity(&provider, &0, &1, &1_000_000, &1_000_000, &0);

    // Mint more tokens for a large swap
    mint_pair(&env, &token_a, &token_b, &trader, 500_000, 0);

    let pool = client.get_pool(&0, &1);
    let k_before = pool.reserve_a * pool.reserve_b;

    client.swap(&trader, &0, &1, &500_000, &0);

    let pool_after = client.get_pool(&0, &1);
    let k_after = pool_after.reserve_a * pool_after.reserve_b;

    // k must not decrease even for large swaps
    assert!(k_after >= k_before, "k decreased on large swap: {} < {}", k_after, k_before);
}

#[test]
fn test_constant_product_invariant_small_swap() {
    let (env, contract_id, governor, provider, trader, token_a, token_b) = setup_liquidity();
    let client = LiquidityContractClient::new(&env, &contract_id);

    setup_pool(&client, &governor, 0, 1, &token_a, &token_b);
    client.add_liquidity(&provider, &0, &1, &1_000_000, &1_000_000, &0);

    let pool = client.get_pool(&0, &1);
    let k_before = pool.reserve_a * pool.reserve_b;

    // Small swap (1 unit)
    client.swap(&trader, &0, &1, &1, &0);

    let pool_after = client.get_pool(&0, &1);
    let k_after = pool_after.reserve_a * pool_after.reserve_b;

    assert!(k_after >= k_before, "k decreased on small swap: {} < {}", k_after, k_before);
}

// ============================================================================
// TESTS FOR CANONICAL POOL KEY ORDERING (Issue #589)
// ============================================================================

#[test]
fn test_swap_reverse_direction_finds_pool() {
    // Pool created with (outcome_a=2, outcome_b=1). A swap submitted as
    // (outcome_in=1, outcome_out=2) must succeed — it is the reverse direction
    // against the same pool, not a missing pool.
    let (env, contract_id, governor, provider, trader, token_a, token_b) = setup_liquidity();
    let client = LiquidityContractClient::new(&env, &contract_id);

    // Create pool with reversed ordering (hi, lo)
    setup_pool(&client, &governor, 2, 1, &token_b, &token_a);
    // Add liquidity using the same reversed ordering
    client.add_liquidity(&provider, &2, &1, &10_000, &10_000, &0i128);

    // Swap in the forward direction (lo → hi) against the pool stored as (1, 2)
    let amount_out = client.swap(&trader, &1, &2, &1_000, &0);
    assert!(amount_out > 0, "reverse-direction swap should succeed and return tokens");

    let pool = client.get_pool(&1, &2);
    assert!(pool.reserve_a > 10_000, "reserve_a (outcome 1) should increase after swap in");
    assert!(pool.reserve_b < 10_000, "reserve_b (outcome 2) should decrease after swap out");
}

#[test]
fn test_swap_both_directions_share_same_pool() {
    // Swapping A→B and then B→A should both operate on the single canonical pool,
    // not on two separate storage slots.
    let (env, contract_id, governor, provider, trader, token_a, token_b) = setup_liquidity();
    let client = LiquidityContractClient::new(&env, &contract_id);

    setup_pool(&client, &governor, 0, 1, &token_a, &token_b);
    client.add_liquidity(&provider, &0, &1, &100_000, &100_000, &0i128);

    // Swap 0 → 1
    let out_1 = client.swap(&trader, &0, &1, &1_000, &0);
    assert!(out_1 > 0);

    // Swap 1 → 0 (reverse direction, same pool)
    let out_2 = client.swap(&trader, &1, &0, &1_000, &0);
    assert!(out_2 > 0, "reverse-direction swap must succeed on the same pool");

    // Both swaps affect the same pool; reserves must reflect two trades.
    let pool = client.get_pool(&0, &1);
    // After (0→1): reserve_a grew, reserve_b shrank.
    // After (1→0): reserve_b grew, reserve_a shrank.
    // Net: the pool should still satisfy k ≥ original k.
    let k = pool.reserve_a * pool.reserve_b;
    assert!(k >= 100_000 * 100_000, "k must not decrease after two opposing swaps");
}

#[test]
fn test_pool_key_canonical_ordering_lookup() {
    // get_pool with either (a,b) or (b,a) ordering must return the same pool.
    let (env, contract_id, governor, provider, _, token_a, token_b) = setup_liquidity();
    let client = LiquidityContractClient::new(&env, &contract_id);

    setup_pool(&client, &governor, 3, 5, &token_a, &token_b);
    client.add_liquidity(&provider, &3, &5, &10_000, &20_000, &0i128);

    let pool_35 = client.get_pool(&3, &5);
    let pool_53 = client.get_pool(&5, &3);

    assert_eq!(pool_35.reserve_a, pool_53.reserve_a);
    assert_eq!(pool_35.reserve_b, pool_53.reserve_b);
    assert_eq!(pool_35.total_lp_supply, pool_53.total_lp_supply);
}

#[test]
fn test_get_amount_out_matches_swap() {
    let (env, contract_id, governor, provider, trader, token_a, token_b) = setup_liquidity();
    let client = LiquidityContractClient::new(&env, &contract_id);

    setup_pool(&client, &governor, 0, 1, &token_a, &token_b);
    client.add_liquidity(&provider, &0, &1, &10_000, &10_000, &0);

    let (quote_amount_out, quote_fee) = client.get_amount_out(&0, &1, &1_000);
    assert!(quote_amount_out > 0);
    assert!(quote_fee > 0);

    let actual_amount_out = client.swap(&trader, &0, &1, &1_000, &0);
    assert_eq!(quote_amount_out, actual_amount_out);
}

#[test]
#[should_panic]
fn test_get_amount_out_same_outcome_panics() {
    let (env, contract_id, governor, provider, _, token_a, token_b) = setup_liquidity();
    let client = LiquidityContractClient::new(&env, &contract_id);
    setup_pool(&client, &governor, 0, 1, &token_a, &token_b);
    client.get_amount_out(&0, &0, &1_000);
}

#[test]
#[should_panic]
fn test_get_amount_out_invalid_amount_panics() {
    let (env, contract_id, governor, provider, _, token_a, token_b) = setup_liquidity();
    let client = LiquidityContractClient::new(&env, &contract_id);
    setup_pool(&client, &governor, 0, 1, &token_a, &token_b);
    client.get_amount_out(&0, &1, &0);
}

#[test]
fn test_instance_ttl_extended_on_calls() {
    let (env, contract_id, _governor, _, _, _token_a, _token_b) = setup_liquidity();

    // initialize bumps the instance entry well past the default instance TTL.
    let ttl = env.as_contract(&contract_id, || env.storage().instance().get_ttl());
    assert!(ttl >= crate::INSTANCE_TTL_THRESHOLD);
    assert_eq!(ttl, crate::INSTANCE_EXTEND_TTL);
}

#[test]
fn test_instance_ttl_extended_contract_still_answers() {
    let (env, contract_id, governor, provider, trader, token_a, token_b) = setup_liquidity();
    let client = LiquidityContractClient::new(&env, &contract_id);

    setup_pool(&client, &governor, 0, 1, &token_a, &token_b);
    client.add_liquidity(&provider, &0, &1, &10_000, &10_000, &0);

    // Advance the ledger past the default instance TTL.
    env.ledger().with_mut(|l| {
        l.sequence_number += 10_000;
    });

    // View functions still answer.
    assert_eq!(client.governor(), governor);
    let pool = client.get_pool(&0, &1);
    assert_eq!(pool.reserve_a, 10_000);
    assert_eq!(client.get_lp_position(&provider, &0, &1), 10_000);

    // State-changing calls still work and re-extend the instance TTL.
    let amount_out = client.swap(&trader, &0, &1, &1_000, &0);
    assert!(amount_out > 0);
    client.update_pool_fee(&governor, &0, &1, &50);
    assert_eq!(client.get_pool(&0, &1).fee_bps, 50);

    let ttl = env.as_contract(&contract_id, || env.storage().instance().get_ttl());
    assert!(ttl >= crate::INSTANCE_TTL_THRESHOLD);
}
