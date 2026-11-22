extern crate std;

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Events as _, Ledger as _},
    token::{StellarAssetClient, TokenClient},
    Env, Symbol, TryIntoVal,
};

const AMOUNT_PER_INTERVAL: i128 = 100;
const INTERVAL_LEDGERS: u32 = 10;
const START_LEDGER: u32 = 1;
const END_LEDGER: u32 = 100;
const TREASURY_FUNDS: i128 = 10_000;

struct Fixture {
    env: Env,
    contract_id: Address,
    treasury: Address,
    governor: Address,
    recipient: Address,
    asset: Address,
}

fn setup() -> Fixture {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_sequence_number(1);

    let treasury = Address::generate(&env);
    let governor = Address::generate(&env);
    let recipient = Address::generate(&env);
    let asset = env
        .register_stellar_asset_contract_v2(Address::generate(&env))
        .address();
    let contract_id = env.register(TreasuryStreamsContract, ());

    let client = TreasuryStreamsContractClient::new(&env, &contract_id);
    client.initialize(&treasury, &governor);

    // The treasury funds the streams contract; streams pay out of this balance.
    StellarAssetClient::new(&env, &asset).mint(&contract_id, &TREASURY_FUNDS);

    Fixture {
        env,
        contract_id,
        treasury,
        governor,
        recipient,
        asset,
    }
}

fn create_default_stream(f: &Fixture) -> u64 {
    let client = TreasuryStreamsContractClient::new(&f.env, &f.contract_id);
    client.create_stream(
        &f.governor,
        &f.recipient,
        &f.asset,
        &AMOUNT_PER_INTERVAL,
        &INTERVAL_LEDGERS,
        &START_LEDGER,
        &END_LEDGER,
    )
}

fn recipient_balance(f: &Fixture) -> i128 {
    TokenClient::new(&f.env, &f.asset).balance(&f.recipient)
}

#[test]
fn test_create_stream_stores_config_and_indexes_it() {
    let f = setup();
    let client = TreasuryStreamsContractClient::new(&f.env, &f.contract_id);

    let stream_id = create_default_stream(&f);
    assert_eq!(stream_id, 1);

    let stream = client.get_stream(&stream_id);
    assert_eq!(stream.recipient, f.recipient);
    assert_eq!(stream.asset, f.asset);
    assert_eq!(stream.amount_per_interval, AMOUNT_PER_INTERVAL);
    assert_eq!(stream.interval_ledgers, INTERVAL_LEDGERS);
    assert_eq!(stream.start_ledger, START_LEDGER);
    assert_eq!(stream.end_ledger, END_LEDGER);
    assert_eq!(stream.last_streamed_ledger, START_LEDGER);
    assert_eq!(stream.total_streamed, 0);
    assert!(!stream.paused);
    assert!(!stream.cancelled);
    assert!(!stream.completed);
    assert_eq!(stream.created_by, f.governor);

    assert_eq!(
        client
            .get_streams_for_recipient(&f.recipient, &0, &10)
            .len(),
        1
    );
    assert_eq!(client.get_active_streams(&0, &10).len(), 1);
}

#[test]
#[should_panic(expected = "Error(Contract, #3)")]
fn test_create_stream_rejects_non_governor() {
    let f = setup();
    let client = TreasuryStreamsContractClient::new(&f.env, &f.contract_id);
    client.create_stream(
        &f.recipient,
        &f.recipient,
        &f.asset,
        &AMOUNT_PER_INTERVAL,
        &INTERVAL_LEDGERS,
        &START_LEDGER,
        &END_LEDGER,
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #4)")]
fn test_create_stream_rejects_non_positive_amount() {
    let f = setup();
    let client = TreasuryStreamsContractClient::new(&f.env, &f.contract_id);
    client.create_stream(
        &f.governor,
        &f.recipient,
        &f.asset,
        &0,
        &INTERVAL_LEDGERS,
        &START_LEDGER,
        &END_LEDGER,
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #5)")]
fn test_create_stream_rejects_zero_interval() {
    let f = setup();
    let client = TreasuryStreamsContractClient::new(&f.env, &f.contract_id);
    client.create_stream(
        &f.governor,
        &f.recipient,
        &f.asset,
        &AMOUNT_PER_INTERVAL,
        &0,
        &START_LEDGER,
        &END_LEDGER,
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #6)")]
fn test_create_stream_rejects_end_before_start() {
    let f = setup();
    let client = TreasuryStreamsContractClient::new(&f.env, &f.contract_id);
    client.create_stream(
        &f.governor,
        &f.recipient,
        &f.asset,
        &AMOUNT_PER_INTERVAL,
        &INTERVAL_LEDGERS,
        &50,
        &40,
    );
}

#[test]
fn test_execute_pays_each_whole_interval_that_came_due() {
    let f = setup();
    let client = TreasuryStreamsContractClient::new(&f.env, &f.contract_id);
    let stream_id = create_default_stream(&f);

    // Ledger 25: intervals complete at 11 and 21, so two are due.
    f.env.ledger().set_sequence_number(25);
    assert_eq!(client.get_claimable_amount(&stream_id), 2 * AMOUNT_PER_INTERVAL);

    client.execute_stream(&stream_id);
    assert_eq!(recipient_balance(&f), 2 * AMOUNT_PER_INTERVAL);

    let stream = client.get_stream(&stream_id);
    assert_eq!(stream.last_streamed_ledger, 21);
    assert_eq!(stream.total_streamed, 2 * AMOUNT_PER_INTERVAL);
    assert_eq!(client.get_claimable_amount(&stream_id), 0);
}

#[test]
#[should_panic(expected = "Error(Contract, #12)")]
fn test_execute_rejects_before_first_interval() {
    let f = setup();
    let client = TreasuryStreamsContractClient::new(&f.env, &f.contract_id);
    let stream_id = create_default_stream(&f);

    // The first interval completes at ledger 11.
    f.env.ledger().set_sequence_number(5);
    assert_eq!(client.get_claimable_amount(&stream_id), 0);
    client.execute_stream(&stream_id);
}

#[test]
fn test_claimable_stops_at_end_ledger_and_drops_partial_interval() {
    let f = setup();
    let client = TreasuryStreamsContractClient::new(&f.env, &f.contract_id);
    let stream_id = create_default_stream(&f);

    // From start 1 to end 100 is 99 ledgers: nine whole intervals, and the
    // trailing 9 ledgers are not paid.
    f.env.ledger().set_sequence_number(500);
    assert_eq!(client.get_claimable_amount(&stream_id), 9 * AMOUNT_PER_INTERVAL);
}

#[test]
fn test_pause_blocks_execution_and_resume_releases_what_came_due() {
    let f = setup();
    let client = TreasuryStreamsContractClient::new(&f.env, &f.contract_id);
    let stream_id = create_default_stream(&f);

    client.pause_stream(&f.treasury, &stream_id);
    assert!(client.get_stream(&stream_id).paused);

    f.env.ledger().set_sequence_number(25);
    assert_eq!(client.get_claimable_amount(&stream_id), 0);

    client.resume_stream(&f.governor, &stream_id);
    assert!(!client.get_stream(&stream_id).paused);
    assert_eq!(client.get_claimable_amount(&stream_id), 2 * AMOUNT_PER_INTERVAL);

    client.execute_stream(&stream_id);
    assert_eq!(recipient_balance(&f), 2 * AMOUNT_PER_INTERVAL);
}

#[test]
#[should_panic(expected = "Error(Contract, #9)")]
fn test_execute_rejects_paused_stream() {
    let f = setup();
    let client = TreasuryStreamsContractClient::new(&f.env, &f.contract_id);
    let stream_id = create_default_stream(&f);

    client.pause_stream(&f.governor, &stream_id);
    f.env.ledger().set_sequence_number(25);
    client.execute_stream(&stream_id);
}

#[test]
#[should_panic(expected = "Error(Contract, #3)")]
fn test_pause_rejects_unrelated_caller() {
    let f = setup();
    let client = TreasuryStreamsContractClient::new(&f.env, &f.contract_id);
    let stream_id = create_default_stream(&f);

    client.pause_stream(&f.recipient, &stream_id);
}

#[test]
#[should_panic(expected = "Error(Contract, #11)")]
fn test_resume_rejects_stream_that_is_not_paused() {
    let f = setup();
    let client = TreasuryStreamsContractClient::new(&f.env, &f.contract_id);
    let stream_id = create_default_stream(&f);

    client.resume_stream(&f.treasury, &stream_id);
}

#[test]
fn test_cancel_removes_stream_from_active_list() {
    let f = setup();
    let client = TreasuryStreamsContractClient::new(&f.env, &f.contract_id);
    let stream_id = create_default_stream(&f);

    client.cancel_stream(&f.governor, &stream_id);

    assert!(client.get_stream(&stream_id).cancelled);
    assert_eq!(client.get_active_streams(&0, &10).len(), 0);
    // A cancelled stream stays visible to its recipient.
    assert_eq!(
        client
            .get_streams_for_recipient(&f.recipient, &0, &10)
            .len(),
        1
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #8)")]
fn test_execute_rejects_cancelled_stream() {
    let f = setup();
    let client = TreasuryStreamsContractClient::new(&f.env, &f.contract_id);
    let stream_id = create_default_stream(&f);

    client.cancel_stream(&f.treasury, &stream_id);
    f.env.ledger().set_sequence_number(25);
    client.execute_stream(&stream_id);
}

#[test]
#[should_panic(expected = "Error(Contract, #8)")]
fn test_cancel_rejects_second_cancel() {
    let f = setup();
    let client = TreasuryStreamsContractClient::new(&f.env, &f.contract_id);
    let stream_id = create_default_stream(&f);

    client.cancel_stream(&f.governor, &stream_id);
    client.cancel_stream(&f.governor, &stream_id);
}

#[test]
#[should_panic(expected = "Error(Contract, #13)")]
fn test_execute_reverts_when_treasury_balance_is_short() {
    let f = setup();
    let client = TreasuryStreamsContractClient::new(&f.env, &f.contract_id);
    // 6000 per interval, two due at ledger 25: 12000 is owed but only 10000 is held.
    let stream_id = client.create_stream(
        &f.governor,
        &f.recipient,
        &f.asset,
        &6_000,
        &INTERVAL_LEDGERS,
        &START_LEDGER,
        &END_LEDGER,
    );

    f.env.ledger().set_sequence_number(25);
    client.execute_stream(&stream_id);
}

#[test]
fn test_active_streams_are_paged_in_creation_order() {
    let f = setup();
    let client = TreasuryStreamsContractClient::new(&f.env, &f.contract_id);
    create_default_stream(&f);
    let second = create_default_stream(&f);
    create_default_stream(&f);

    let page = client.get_active_streams(&1, &1);
    assert_eq!(page.len(), 1);
    assert_eq!(page.get(0).unwrap().id, second);
    assert_eq!(client.get_active_streams(&5, &10).len(), 0);
}

// ── #1542: completed streams leave ActiveStreams ────────────────────────────

fn active_ids(client: &TreasuryStreamsContractClient) -> std::vec::Vec<u64> {
    client
        .get_active_streams(&0, &100)
        .iter()
        .map(|stream| stream.id)
        .collect()
}

#[test]
fn test_paying_the_last_interval_completes_the_stream() {
    let f = setup();
    let client = TreasuryStreamsContractClient::new(&f.env, &f.contract_id);
    let stream_id = create_default_stream(&f);

    // Past end_ledger: all nine whole intervals are paid in one call.
    f.env.ledger().set_sequence_number(500);
    client.execute_stream(&stream_id);

    let topic: Symbol = f
        .env
        .events()
        .all()
        .last()
        .unwrap()
        .1
        .get(0)
        .unwrap()
        .try_into_val(&f.env)
        .unwrap();
    assert_eq!(topic, Symbol::new(&f.env, STREAM_COMPLETED_TOPIC));

    let stream = client.get_stream(&stream_id);
    assert!(stream.completed);
    assert_eq!(stream.last_streamed_ledger, 91);
    assert_eq!(stream.total_streamed, 9 * AMOUNT_PER_INTERVAL);
    assert_eq!(recipient_balance(&f), 9 * AMOUNT_PER_INTERVAL);
    assert_eq!(client.get_claimable_amount(&stream_id), 0);
    assert!(active_ids(&client).is_empty());
    // A completed stream stays visible to its recipient.
    assert_eq!(
        client
            .get_streams_for_recipient(&f.recipient, &0, &10)
            .len(),
        1
    );
}

#[test]
fn test_partial_payment_keeps_the_stream_active() {
    let f = setup();
    let client = TreasuryStreamsContractClient::new(&f.env, &f.contract_id);
    let stream_id = create_default_stream(&f);

    f.env.ledger().set_sequence_number(25);
    client.execute_stream(&stream_id);

    assert!(!client.get_stream(&stream_id).completed);
    assert_eq!(active_ids(&client), std::vec![stream_id]);
}

#[test]
fn test_stream_completes_on_the_call_that_pays_its_final_interval() {
    let f = setup();
    let client = TreasuryStreamsContractClient::new(&f.env, &f.contract_id);
    let stream_id = create_default_stream(&f);

    f.env.ledger().set_sequence_number(85);
    client.execute_stream(&stream_id);
    assert!(!client.get_stream(&stream_id).completed);

    // The ninth and last interval completes at ledger 91.
    f.env.ledger().set_sequence_number(91);
    client.execute_stream(&stream_id);
    assert!(client.get_stream(&stream_id).completed);
    assert!(active_ids(&client).is_empty());
}

#[test]
fn test_interval_ending_exactly_on_end_ledger_completes_the_stream() {
    let f = setup();
    let client = TreasuryStreamsContractClient::new(&f.env, &f.contract_id);
    // 1 -> 101 is exactly ten 10-ledger intervals.
    let stream_id = client.create_stream(
        &f.governor,
        &f.recipient,
        &f.asset,
        &AMOUNT_PER_INTERVAL,
        &INTERVAL_LEDGERS,
        &START_LEDGER,
        &101,
    );

    f.env.ledger().set_sequence_number(101);
    client.execute_stream(&stream_id);

    let stream = client.get_stream(&stream_id);
    assert!(stream.completed);
    assert_eq!(stream.last_streamed_ledger, 101);
    assert_eq!(stream.total_streamed, 10 * AMOUNT_PER_INTERVAL);
}

#[test]
fn test_completing_one_stream_leaves_the_others_active_in_order() {
    let f = setup();
    let client = TreasuryStreamsContractClient::new(&f.env, &f.contract_id);
    let first = create_default_stream(&f);
    let short = client.create_stream(
        &f.governor,
        &f.recipient,
        &f.asset,
        &AMOUNT_PER_INTERVAL,
        &INTERVAL_LEDGERS,
        &START_LEDGER,
        &30,
    );
    let third = create_default_stream(&f);

    f.env.ledger().set_sequence_number(30);
    client.execute_stream(&short);

    assert!(client.get_stream(&short).completed);
    assert_eq!(active_ids(&client), std::vec![first, third]);
}

#[test]
#[should_panic(expected = "Error(Contract, #15)")]
fn test_execute_rejects_completed_stream() {
    let f = setup();
    let client = TreasuryStreamsContractClient::new(&f.env, &f.contract_id);
    let stream_id = create_default_stream(&f);

    f.env.ledger().set_sequence_number(500);
    client.execute_stream(&stream_id);
    client.execute_stream(&stream_id);
}

#[test]
fn test_completed_stream_cannot_be_paused_resumed_or_cancelled() {
    let f = setup();
    let client = TreasuryStreamsContractClient::new(&f.env, &f.contract_id);
    let stream_id = create_default_stream(&f);

    f.env.ledger().set_sequence_number(500);
    client.execute_stream(&stream_id);

    let completed: soroban_sdk::Error = TreasuryStreamsError::StreamCompleted.into();
    assert_eq!(
        client.try_pause_stream(&f.treasury, &stream_id),
        Err(Ok(completed))
    );
    assert_eq!(
        client.try_resume_stream(&f.treasury, &stream_id),
        Err(Ok(completed))
    );
    assert_eq!(
        client.try_cancel_stream(&f.treasury, &stream_id),
        Err(Ok(completed))
    );
}
