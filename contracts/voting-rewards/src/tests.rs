extern crate std;

use super::*;
use crate::merkle::{compute_leaf, hash_pair};
use soroban_sdk::{
    testutils::{Address as _, Events as _, Ledger as _},
    token, vec, Env, String as SorobanString,
};

const EPOCH_DURATION: u32 = 1_000;
const POOL_FUNDING: i128 = 1_000_000;

/// Fixed, deterministically derived accounts so the golden-vector test below
/// pins the exact same input set as `backend/src/__tests__/voting-rewards-merkle.test.ts`.
///
/// Listed in ascending address order, which is the canonical leaf order
/// `merkle.ts`'s `buildMerkleTree` sorts every epoch into — the tree, and so
/// the root that goes on-chain, is a function of the `(address, amount)` set
/// and never of the order rows came back from the database in.
const GOLDEN_ADDRESSES: [&str; 5] = [
    "GA3I6MVQC2EXERDKLVWNFGGYEHII5ZVWFS4ZUQGKAP3XRJWR7P5FUGQJ",
    "GAKXV3A3HTPD6VG63VDC7YHEGXFUW64PGVOKPIOYMIXLZRAXLQMG22CN",
    "GAS6QC6USQHIUKQH4EY6KC62IN7Q4NX3M73L3PI7YWQZYHDFQCTB4LZY",
    "GBVOQAK3E3EW5ULNEE6R5E63HKSGPH7AWPM75CTWI5IES7JPI54L5M57",
    "GCAY5IGF2CMHCG56BR7FBJZOMRGP7UJKSOESULXEJ5XHB3U4ELYJG4IC",
];
const GOLDEN_EPOCH_ID: u64 = 7;
const GOLDEN_AMOUNTS: [i128; 5] = [250_000, 42, 1, 999_999_999, 7_500];

fn hex(bytes: &BytesN<32>) -> std::string::String {
    use std::fmt::Write as _;
    let mut out = std::string::String::new();
    for b in bytes.to_array().iter() {
        let _ = write!(out, "{:02x}", b);
    }
    out
}

/// Reference tree builder, mirroring `merkle.ts`: hash sorted pairs level by
/// level, promoting an odd trailing node unchanged.
fn build_root(env: &Env, leaves: &Vec<BytesN<32>>) -> BytesN<32> {
    let mut level = leaves.clone();
    while level.len() > 1 {
        let mut next: Vec<BytesN<32>> = Vec::new(env);
        let mut i = 0;
        while i < level.len() {
            if i + 1 < level.len() {
                next.push_back(hash_pair(
                    env,
                    &level.get(i).unwrap(),
                    &level.get(i + 1).unwrap(),
                ));
            } else {
                next.push_back(level.get(i).unwrap());
            }
            i += 2;
        }
        level = next;
    }
    level.get(0).unwrap()
}

fn build_proof(env: &Env, leaves: &Vec<BytesN<32>>, index: u32) -> Vec<BytesN<32>> {
    let mut proof: Vec<BytesN<32>> = Vec::new(env);
    let mut level = leaves.clone();
    let mut idx = index;
    while level.len() > 1 {
        let sibling = if idx & 1 == 0 { idx + 1 } else { idx - 1 };
        if sibling < level.len() {
            proof.push_back(level.get(sibling).unwrap());
        }
        let mut next: Vec<BytesN<32>> = Vec::new(env);
        let mut i = 0;
        while i < level.len() {
            if i + 1 < level.len() {
                next.push_back(hash_pair(
                    env,
                    &level.get(i).unwrap(),
                    &level.get(i + 1).unwrap(),
                ));
            } else {
                next.push_back(level.get(i).unwrap());
            }
            i += 2;
        }
        level = next;
        idx /= 2;
    }
    proof
}

struct Fixture {
    client: VotingRewardsContractClient<'static>,
    admin: Address,
    token_admin_client: token::StellarAssetClient<'static>,
    token_client: token::TokenClient<'static>,
    contract_id: Address,
}

fn setup(env: &Env) -> Fixture {
    env.mock_all_auths();

    let admin = Address::generate(env);
    let sac_admin = Address::generate(env);
    let sac = env.register_stellar_asset_contract_v2(sac_admin);
    let token_addr = sac.address();

    let contract_id = env.register(VotingRewardsContract, ());
    let client = VotingRewardsContractClient::new(env, &contract_id);
    client.initialize(&admin, &token_addr, &EPOCH_DURATION);

    Fixture {
        client,
        admin,
        token_admin_client: token::StellarAssetClient::new(env, &token_addr),
        token_client: token::TokenClient::new(env, &token_addr),
        contract_id,
    }
}

fn advance_to(env: &Env, ledger: u32) {
    env.ledger().with_mut(|l| l.sequence_number = ledger);
}

/// A two-voter epoch: `a` and `b` share the allocation, with a proof for each.
fn published_two_voter_epoch(
    env: &Env,
    f: &Fixture,
    a: &Address,
    a_amount: i128,
    b: &Address,
    b_amount: i128,
) -> (u64, Vec<BytesN<32>>, Vec<BytesN<32>>) {
    let epoch_id = f.client.get_current_epoch_id();
    let epoch = f.client.get_epoch(&epoch_id).unwrap();

    let leaves = vec![
        env,
        compute_leaf(env, a, epoch_id, a_amount),
        compute_leaf(env, b, epoch_id, b_amount),
    ];
    let root = build_root(env, &leaves);

    f.token_admin_client.mint(&f.contract_id, &POOL_FUNDING);
    advance_to(env, epoch.end_ledger);
    f.client
        .publish_epoch_root(&f.admin, &epoch_id, &root, &(a_amount + b_amount));

    (
        epoch_id,
        build_proof(env, &leaves, 0),
        build_proof(env, &leaves, 1),
    )
}

#[test]
fn initialize_opens_epoch_zero() {
    let env = Env::default();
    let f = setup(&env);

    assert_eq!(f.client.get_current_epoch_id(), 0);
    let epoch = f.client.get_epoch(&0).unwrap();
    assert_eq!(epoch.id, 0);
    assert_eq!(epoch.end_ledger, epoch.start_ledger + EPOCH_DURATION);
    assert_eq!(epoch.merkle_root, None);
    assert!(!epoch.finalized);
}

#[test]
fn get_admin_returns_the_configured_admin() {
    let env = Env::default();
    let f = setup(&env);
    assert_eq!(f.client.get_admin(), f.admin);
}

#[test]
#[should_panic(expected = "Error(Contract, #1)")]
fn initialize_twice_panics() {
    let env = Env::default();
    let f = setup(&env);
    let token = Address::generate(&env);
    f.client.initialize(&f.admin, &token, &EPOCH_DURATION);
}

#[test]
#[should_panic(expected = "Error(Contract, #4)")]
fn initialize_with_zero_duration_panics() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(VotingRewardsContract, ());
    let client = VotingRewardsContractClient::new(&env, &contract_id);
    client.initialize(&Address::generate(&env), &Address::generate(&env), &0);
}

#[test]
#[should_panic(expected = "Error(Contract, #6)")]
fn start_next_epoch_before_end_ledger_panics() {
    let env = Env::default();
    let f = setup(&env);

    let epoch = f.client.get_epoch(&0).unwrap();
    advance_to(&env, epoch.end_ledger - 1);
    f.client.start_next_epoch();
}

#[test]
fn start_next_epoch_is_permissionless_and_contiguous() {
    let env = Env::default();
    let f = setup(&env);

    let first = f.client.get_epoch(&0).unwrap();
    // Roll forward well past the boundary: the next epoch must still start
    // exactly where the previous one ended, so no ledger goes unrewardable.
    advance_to(&env, first.end_ledger + 500);
    f.client.start_next_epoch();

    assert_eq!(f.client.get_current_epoch_id(), 1);
    let second = f.client.get_epoch(&1).unwrap();
    assert_eq!(second.start_ledger, first.end_ledger);
    assert_eq!(second.end_ledger, first.end_ledger + EPOCH_DURATION);
}

#[test]
fn fund_pool_transfers_in_and_counts_toward_available() {
    let env = Env::default();
    let f = setup(&env);

    let funder = Address::generate(&env);
    f.token_admin_client.mint(&funder, &POOL_FUNDING);
    f.client.fund_pool(&funder, &(POOL_FUNDING / 2));

    assert_eq!(f.token_client.balance(&f.contract_id), POOL_FUNDING / 2);
    assert_eq!(f.client.get_available_pool(), POOL_FUNDING / 2);
}

#[test]
#[should_panic(expected = "Error(Contract, #10)")]
fn fund_pool_rejects_non_positive_amount() {
    let env = Env::default();
    let f = setup(&env);
    let funder = Address::generate(&env);
    f.client.fund_pool(&funder, &0);
}

#[test]
fn claim_succeeds_with_a_correct_proof() {
    let env = Env::default();
    let f = setup(&env);

    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    let (epoch_id, alice_proof, bob_proof) =
        published_two_voter_epoch(&env, &f, &alice, 700, &bob, 300);

    f.client.claim(&alice, &epoch_id, &700, &alice_proof);
    assert_eq!(f.token_client.balance(&alice), 700);
    assert!(f.client.has_claimed(&epoch_id, &alice));
    assert_eq!(f.client.get_epoch(&epoch_id).unwrap().claimed_amount, 700);

    f.client.claim(&bob, &epoch_id, &300, &bob_proof);
    assert_eq!(f.token_client.balance(&bob), 300);
    assert_eq!(f.client.get_epoch(&epoch_id).unwrap().claimed_amount, 1_000);

    // Everything allocated has now been paid out, so the whole remaining
    // balance is available for the next epoch again.
    assert_eq!(f.client.get_available_pool(), POOL_FUNDING - 1_000);
}

#[test]
#[should_panic(expected = "Error(Contract, #12)")]
fn claim_with_a_tampered_amount_panics() {
    let env = Env::default();
    let f = setup(&env);

    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    let (epoch_id, alice_proof, _) = published_two_voter_epoch(&env, &f, &alice, 700, &bob, 300);

    f.client.claim(&alice, &epoch_id, &701, &alice_proof);
}

#[test]
#[should_panic(expected = "Error(Contract, #12)")]
fn claim_with_another_claimants_proof_panics() {
    let env = Env::default();
    let f = setup(&env);

    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    let mallory = Address::generate(&env);
    let (epoch_id, alice_proof, _) = published_two_voter_epoch(&env, &f, &alice, 700, &bob, 300);

    // Alice's own proof and amount, submitted by someone else: the leaf is
    // bound to the claimant, so it can't reach the root.
    f.client.claim(&mallory, &epoch_id, &700, &alice_proof);
}

#[test]
#[should_panic(expected = "Error(Contract, #11)")]
fn double_claim_panics() {
    let env = Env::default();
    let f = setup(&env);

    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    let (epoch_id, alice_proof, _) = published_two_voter_epoch(&env, &f, &alice, 700, &bob, 300);

    f.client.claim(&alice, &epoch_id, &700, &alice_proof);
    f.client.claim(&alice, &epoch_id, &700, &alice_proof);
}

#[test]
#[should_panic(expected = "Error(Contract, #8)")]
fn claim_before_the_root_is_published_panics() {
    let env = Env::default();
    let f = setup(&env);

    let alice = Address::generate(&env);
    let proof: Vec<BytesN<32>> = Vec::new(&env);
    f.client.claim(&alice, &0, &1, &proof);
}

#[test]
#[should_panic(expected = "Error(Contract, #3)")]
fn publish_epoch_root_from_a_non_admin_panics() {
    let env = Env::default();
    let f = setup(&env);

    let epoch = f.client.get_epoch(&0).unwrap();
    f.token_admin_client.mint(&f.contract_id, &POOL_FUNDING);
    advance_to(&env, epoch.end_ledger);

    let stranger = Address::generate(&env);
    let root = BytesN::from_array(&env, &[7u8; 32]);
    f.client.publish_epoch_root(&stranger, &0, &root, &100);
}

#[test]
#[should_panic(expected = "Error(Contract, #9)")]
fn publish_epoch_root_beyond_the_pool_balance_panics() {
    let env = Env::default();
    let f = setup(&env);

    let epoch = f.client.get_epoch(&0).unwrap();
    f.token_admin_client.mint(&f.contract_id, &1_000);
    advance_to(&env, epoch.end_ledger);

    let root = BytesN::from_array(&env, &[7u8; 32]);
    f.client.publish_epoch_root(&f.admin, &0, &root, &1_001);
}

#[test]
#[should_panic(expected = "Error(Contract, #9)")]
fn a_second_epoch_cannot_re_commit_an_unclaimed_allocation() {
    let env = Env::default();
    let f = setup(&env);

    let epoch = f.client.get_epoch(&0).unwrap();
    f.token_admin_client.mint(&f.contract_id, &1_000);
    advance_to(&env, epoch.end_ledger);

    let root = BytesN::from_array(&env, &[7u8; 32]);
    f.client.publish_epoch_root(&f.admin, &0, &root, &1_000);
    assert_eq!(f.client.get_available_pool(), 0);

    f.client.start_next_epoch();
    let second = f.client.get_epoch(&1).unwrap();
    advance_to(&env, second.end_ledger);
    // Nobody has claimed epoch 0 yet, so its 1_000 is still spoken for even
    // though the tokens are physically still here.
    f.client.publish_epoch_root(&f.admin, &1, &root, &1);
}

#[test]
#[should_panic(expected = "Error(Contract, #6)")]
fn publish_epoch_root_before_the_epoch_ends_panics() {
    let env = Env::default();
    let f = setup(&env);

    f.token_admin_client.mint(&f.contract_id, &POOL_FUNDING);
    let root = BytesN::from_array(&env, &[7u8; 32]);
    f.client.publish_epoch_root(&f.admin, &0, &root, &100);
}

#[test]
#[should_panic(expected = "Error(Contract, #7)")]
fn republishing_an_epoch_root_panics() {
    let env = Env::default();
    let f = setup(&env);

    let epoch = f.client.get_epoch(&0).unwrap();
    f.token_admin_client.mint(&f.contract_id, &POOL_FUNDING);
    advance_to(&env, epoch.end_ledger);

    let root = BytesN::from_array(&env, &[7u8; 32]);
    f.client.publish_epoch_root(&f.admin, &0, &root, &100);
    f.client.publish_epoch_root(&f.admin, &0, &root, &100);
}

#[test]
fn get_epoch_for_an_unknown_epoch_returns_none() {
    let env = Env::default();
    let f = setup(&env);
    assert_eq!(f.client.get_epoch(&99), None);
}

#[test]
fn zero_participation_epoch_publishes_an_empty_allocation() {
    let env = Env::default();
    let f = setup(&env);

    let epoch = f.client.get_epoch(&0).unwrap();
    advance_to(&env, epoch.end_ledger);
    // No voters: the backend publishes a zero allocation rather than
    // skipping the epoch, so the on-chain epoch history stays contiguous.
    let root = BytesN::from_array(&env, &[0u8; 32]);
    f.client.publish_epoch_root(&f.admin, &0, &root, &0);

    let published = f.client.get_epoch(&0).unwrap();
    assert!(published.finalized);
    assert_eq!(published.total_reward_amount, 0);
}

#[test]
fn zero_amount_root_cannot_be_overwritten() {
    let env = Env::default();
    let f = setup(&env);

    let epoch = f.client.get_epoch(&0).unwrap();
    advance_to(&env, epoch.end_ledger);
    let root = BytesN::from_array(&env, &[0u8; 32]);
    f.client.publish_epoch_root(&f.admin, &0, &root, &0);

    // A second publish, with a different root, is refused and leaves the
    // first root in place.
    let other_root = BytesN::from_array(&env, &[9u8; 32]);
    assert_eq!(
        f.client
            .try_publish_epoch_root(&f.admin, &0, &other_root, &0)
            .unwrap_err()
            .unwrap(),
        VotingRewardsError::EpochAlreadyFinalized.into(),
    );
    assert_eq!(f.client.get_epoch(&0).unwrap().merkle_root, Some(root));
}

/// Golden vectors shared with `backend/src/__tests__/voting-rewards-merkle.test.ts`.
///
/// This is the cross-language pin the issue asks for: the leaf encoding, the
/// sorted-pair internal hashing and the odd-node promotion rule all have to
/// be byte-identical in Rust and TypeScript, or every proof the backend
/// serves would be rejected on-chain. Change one side's expectations and the
/// other side's test fails.
#[test]
fn golden_merkle_vectors() {
    let env = Env::default();

    let mut leaves: Vec<BytesN<32>> = Vec::new(&env);
    for (i, addr) in GOLDEN_ADDRESSES.iter().enumerate() {
        let address = Address::from_string(&SorobanString::from_str(&env, addr));
        leaves.push_back(compute_leaf(
            &env,
            &address,
            GOLDEN_EPOCH_ID,
            GOLDEN_AMOUNTS[i],
        ));
    }

    for (i, expected) in GOLDEN_LEAVES.iter().enumerate() {
        assert_eq!(hex(&leaves.get(i as u32).unwrap()), *expected, "leaf {}", i);
    }

    let root = build_root(&env, &leaves);
    assert_eq!(hex(&root), GOLDEN_ROOT);

    // Every leaf, not just the first and last — with an odd leaf count the
    // promoted trailing node is the easiest thing to get wrong.
    for i in 0..leaves.len() {
        let proof = build_proof(&env, &leaves, i);
        assert!(
            merkle::verify_proof(&env, &root, &leaves.get(i).unwrap(), &proof),
            "proof for leaf {} did not verify",
            i
        );
        let hexed: std::vec::Vec<std::string::String> = proof.iter().map(|p| hex(&p)).collect();
        assert_eq!(hexed, GOLDEN_PROOFS[i as usize], "proof {}", i);
    }
}

const GOLDEN_LEAVES: [&str; 5] = [
    "0bf621a13487fe1aef039095a25b40ee9bdfb526a4d8054f28ae10adc8041ba0",
    "1fce2eed9c80e1236b401ba2ee8c066884e30c087d319c92931be01e9bd4ea71",
    "9cb87f75012885e109a0b81775abf2caf209889fc96d2bd0aef10c8568b9858e",
    "74094b403e4eceefca4967acc71ea28977f617335555778ebbcc86e1999616ee",
    "19fd2f38ad9e87bf4436f675ea354c32c3d399beb72037580b1c74f7ec80e3ca",
];
const GOLDEN_ROOT: &str = "09f6d53699eda9c424859b1cabf7b12279ca966e0c45e9e49d1fc47e1867bd35";
const GOLDEN_PROOFS: [&[&str]; 5] = [
    &[
        "1fce2eed9c80e1236b401ba2ee8c066884e30c087d319c92931be01e9bd4ea71",
        "984fbfd69220764e60b0539ae477e6b1f7419d9ccd0b7655f8f25d27070a8eb2",
        "19fd2f38ad9e87bf4436f675ea354c32c3d399beb72037580b1c74f7ec80e3ca",
    ],
    &[
        "0bf621a13487fe1aef039095a25b40ee9bdfb526a4d8054f28ae10adc8041ba0",
        "984fbfd69220764e60b0539ae477e6b1f7419d9ccd0b7655f8f25d27070a8eb2",
        "19fd2f38ad9e87bf4436f675ea354c32c3d399beb72037580b1c74f7ec80e3ca",
    ],
    &[
        "74094b403e4eceefca4967acc71ea28977f617335555778ebbcc86e1999616ee",
        "8774ae760b584499953da69296ccb9eca937d3bdf8866420c21806cc3aa849e0",
        "19fd2f38ad9e87bf4436f675ea354c32c3d399beb72037580b1c74f7ec80e3ca",
    ],
    &[
        "9cb87f75012885e109a0b81775abf2caf209889fc96d2bd0aef10c8568b9858e",
        "8774ae760b584499953da69296ccb9eca937d3bdf8866420c21806cc3aa849e0",
        "19fd2f38ad9e87bf4436f675ea354c32c3d399beb72037580b1c74f7ec80e3ca",
    ],
    &[
        "6ea80d6c6732a9803a42f6946621bc2169894c95f12aaa15f78f6388611f14ac",
    ],
];

#[test]
fn proposed_admin_only_becomes_active_after_acceptance() {
    let env = Env::default();
    let f = setup(&env);

    let new_admin = Address::generate(&env);
    f.client.propose_admin(&f.admin, &new_admin);

    assert_eq!(f.client.get_admin(), f.admin);
    assert_eq!(f.client.get_pending_admin(), Some(new_admin.clone()));

    f.client.accept_admin(&new_admin);

    assert_eq!(f.client.get_admin(), new_admin);
    assert_eq!(f.client.get_pending_admin(), None);
}

#[test]
#[should_panic(expected = "Error(Contract, #3)")]
fn propose_admin_rejects_non_admin_caller() {
    let env = Env::default();
    let f = setup(&env);

    let non_admin = Address::generate(&env);
    let new_admin = Address::generate(&env);
    f.client.propose_admin(&non_admin, &new_admin);
}

#[test]
#[should_panic(expected = "Error(Contract, #3)")]
fn accept_admin_rejects_an_address_that_was_not_proposed() {
    let env = Env::default();
    let f = setup(&env);

    let new_admin = Address::generate(&env);
    let other_admin = Address::generate(&env);
    f.client.propose_admin(&f.admin, &new_admin);
    f.client.accept_admin(&other_admin);
}

#[test]
fn admin_transfer_emits_events_for_both_steps() {
    use soroban_sdk::{testutils::Events, Symbol, TryIntoVal};

    let env = Env::default();
    let f = setup(&env);

    let new_admin = Address::generate(&env);
    f.client.propose_admin(&f.admin, &new_admin);

    let proposed = env.events().all().last().unwrap();
    let proposed_topic: Symbol = proposed
        .1
        .get(0)
        .unwrap()
        .try_into_val(&env)
        .unwrap();
    assert_eq!(proposed_topic, Symbol::new(&env, "AdminProposed"));

    f.client.accept_admin(&new_admin);

    let accepted = env.events().all().last().unwrap();
    let accepted_topic: Symbol = accepted
        .1
        .get(0)
        .unwrap()
        .try_into_val(&env)
        .unwrap();
    assert_eq!(accepted_topic, Symbol::new(&env, "AdminAccepted"));
}

#[test]
fn update_epoch_duration_changes_duration_for_next_epochs() {
    let env = Env::default();
    let f = setup(&env);

    let new_duration = 2_000u32;
    f.client.update_epoch_duration(&f.admin, &new_duration);

    let current_epoch = f.client.get_epoch(&0).unwrap();
    // Current epoch should retain original duration
    assert_eq!(
        current_epoch.end_ledger - current_epoch.start_ledger,
        EPOCH_DURATION
    );

    // Start next epoch
    advance_to(&env, current_epoch.end_ledger);
    f.client.start_next_epoch();

    let next_epoch = f.client.get_epoch(&1).unwrap();
    // Next epoch should use new duration
    assert_eq!(next_epoch.end_ledger - next_epoch.start_ledger, new_duration);
}

#[test]
#[should_panic(expected = "Error(Contract, #3)")]
fn update_epoch_duration_rejects_non_admin_caller() {
    let env = Env::default();
    let f = setup(&env);

    let non_admin = Address::generate(&env);
    f.client.update_epoch_duration(&non_admin, &2_000);
}

#[test]
#[should_panic(expected = "Error(Contract, #4)")]
fn update_epoch_duration_rejects_zero_duration() {
    let env = Env::default();
    let f = setup(&env);

    f.client.update_epoch_duration(&f.admin, &0);
}

#[test]
fn update_epoch_duration_emits_event() {
    let env = Env::default();
    let f = setup(&env);

    let new_duration = 2_000u32;
    f.client.update_epoch_duration(&f.admin, &new_duration);

    let events = env.events().all();
    let event = events.last().unwrap();

    assert_eq!(event.1.len(), 1);
}

#[test]
fn available_pool_reflects_a_correctly_negative_result_when_allocated_exceeds_balance() {
    let env = Env::default();
    let f = setup(&env);

    // Force RewardsPool above the contract's actual token balance (0) - an
    // invariant that should never hold in practice. checked_sub doesn't
    // panic here (balance - allocated still fits in i128), but it does
    // guarantee the arithmetic itself can no longer silently misbehave on
    // true overflow; the correctly negative result then flows into
    // publish_epoch_root's `total_reward_amount > available_pool()` check
    // and correctly blocks even a zero-amount publish while the pool is in
    // this state.
    env.as_contract(&f.contract_id, || {
        env.storage()
            .instance()
            .set(&DataKey::RewardsPool, &1_000i128);
    });

    assert_eq!(f.client.get_available_pool(), -1_000);

    let root = BytesN::from_array(&env, &[0u8; 32]);
    let epoch = f.client.get_epoch(&0).unwrap();
    advance_to(&env, epoch.end_ledger);

    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        f.client.publish_epoch_root(&f.admin, &0, &root, &0);
    }));
    assert!(result.is_err());
}

