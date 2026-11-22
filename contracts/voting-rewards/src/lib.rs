#![no_std]
//! Voting participation rewards (Issue #1011).
//!
//! Turnout is its own reward in this repo today, which is exactly why the
//! indexer bothers to track a quorum-miss count. This contract pays voters
//! for the act of voting: a funded token pool is split per epoch across the
//! addresses that cast a vote during it, proportional to the voting power
//! they cast.
//!
//! Eligibility is *not* computed on-chain. `contracts/governor` has no
//! "every address that voted this epoch" query, and adding one would mean
//! iterating unbounded per-proposal voter lists inside a WASM that already
//! sits within a few hundred bytes of the CI-enforced 100KB cap. Instead the
//! backend computes `(address, amount)` pairs from the indexer's `votes`
//! table, and only a Merkle root of that set is published here; each voter
//! then claims their own reward against it with a proof. `contracts/governor`
//! is untouched.

pub mod error;
mod events;
pub mod merkle;

use crate::error::VotingRewardsError;
use soroban_sdk::{contract, contractimpl, contracttype, token, Address, BytesN, Env, Vec};

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct Epoch {
    pub id: u64,
    pub start_ledger: u32,
    pub end_ledger: u32,
    pub merkle_root: Option<BytesN<32>>,
    pub total_reward_amount: i128,
    pub claimed_amount: i128,
    pub finalized: bool,
}

#[contracttype]
pub enum DataKey {
    /// Authorized to publish an epoch's `merkle_root`. Intended to be set to
    /// the governor's own address, so publishing a root is itself a
    /// governance-executed action rather than a trusted operator key.
    Admin,
    PendingAdmin,
    RewardToken,
    /// Rewards that have been allocated to a published epoch and not yet
    /// claimed. The spendable pool is `token.balance(self) - RewardsPool`,
    /// which is what `publish_epoch_root` checks a new epoch's
    /// `total_reward_amount` against — funding is plain token transfers in
    /// (see `fund_pool`), so the balance is the source of truth and this
    /// counter only guards already-committed rewards from being committed
    /// to a second epoch before their claimants show up.
    RewardsPool,
    EpochDurationLedgers,
    CurrentEpochId,
    Epoch(u64),
    /// `(epoch_id, claimant) -> ()`; presence alone prevents double-claiming.
    Claimed(u64, Address),
    /// `epoch_id -> ()`; presence indicates epoch has been swept.
    Swept(u64),
}

/// Soroban's maximum persistent-entry TTL (~180 days at the network's ~5s
/// ledger close time). Epoch records and claim markers must outlive an
/// epoch's full lifecycle — it ends, the backend computes eligibility, a
/// governance proposal publishes the root, and only then do voters trickle
/// in to claim — so every write here is bumped to the ceiling.
const REWARDS_TTL_LEDGERS: u32 = 3_110_400;

/// Grace period after an epoch ends before its unclaimed rewards can be swept.
/// Set to 7 days (~120,960 ledgers at ~5s per ledger) to give voters time to claim.
const SWEEP_GRACE_PERIOD_LEDGERS: u32 = 120_960;

#[contract]
pub struct VotingRewardsContract;

#[contractimpl]
impl VotingRewardsContract {
    /// Initialize the program and open epoch 0 at the current ledger.
    pub fn initialize(env: Env, admin: Address, reward_token: Address, epoch_duration_ledgers: u32) {
        admin.require_auth();
        if env.storage().instance().has(&DataKey::Admin) {
            env.panic_with_error(VotingRewardsError::AlreadyInitialized);
        }
        if epoch_duration_ledgers == 0 {
            env.panic_with_error(VotingRewardsError::InvalidEpochDuration);
        }

        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&DataKey::RewardToken, &reward_token);
        env.storage()
            .instance()
            .set(&DataKey::EpochDurationLedgers, &epoch_duration_ledgers);
        env.storage().instance().set(&DataKey::RewardsPool, &0i128);

        Self::open_epoch(&env, 0, epoch_duration_ledgers);
    }

    /// Open the next epoch. Permissionless — anyone may roll the program
    /// forward — but only once the current epoch's `end_ledger` has passed.
    ///
    /// The new epoch starts at the previous one's `end_ledger`, not at the
    /// calling ledger, so no ledger range can fall between two epochs and
    /// leave the votes cast in it unrewardable if nobody happens to call
    /// this the moment an epoch closes.
    pub fn start_next_epoch(env: Env) {
        let current_id = Self::current_epoch_id(&env);
        let current = Self::must_get_epoch(&env, current_id);

        if env.ledger().sequence() < current.end_ledger {
            env.panic_with_error(VotingRewardsError::EpochNotEnded);
        }

        let duration: u32 = env
            .storage()
            .instance()
            .get(&DataKey::EpochDurationLedgers)
            .unwrap_or_else(|| env.panic_with_error(VotingRewardsError::NotInitialized));

        let next_id = current_id.checked_add(1).unwrap_or_else(|| {
            env.panic_with_error(VotingRewardsError::EpochOverflow)
        });
        let epoch = Epoch {
            id: next_id,
            start_ledger: current.end_ledger,
            end_ledger: current.end_ledger.saturating_add(duration),
            merkle_root: None,
            total_reward_amount: 0,
            claimed_amount: 0,
            finalized: false,
        };
        Self::store_epoch(&env, &epoch);
        env.storage()
            .instance()
            .set(&DataKey::CurrentEpochId, &next_id);

        events::emit_epoch_started(&env, next_id, epoch.start_ledger, epoch.end_ledger);
    }

    /// Publish the Merkle root of `epoch_id`'s `(address, amount)` set and
    /// allocate `total_reward_amount` out of the unallocated pool to it.
    ///
    /// Admin-only, and only for an epoch that has already ended (its voter
    /// set can't be final before then) and hasn't been published yet — a
    /// root is write-once, so a published epoch's claimants can never have
    /// the ground moved under them.
    ///
    /// Publishing always finalizes the epoch, including with a
    /// `total_reward_amount` of 0: an epoch nobody voted in is still final,
    /// and its root must not be replaceable afterwards.
    pub fn publish_epoch_root(
        env: Env,
        admin: Address,
        epoch_id: u64,
        merkle_root: BytesN<32>,
        total_reward_amount: i128,
    ) {
        admin.require_auth();
        let stored_admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .unwrap_or_else(|| env.panic_with_error(VotingRewardsError::NotInitialized));
        if admin != stored_admin {
            env.panic_with_error(VotingRewardsError::NotAuthorized);
        }
        if total_reward_amount < 0 {
            env.panic_with_error(VotingRewardsError::InvalidAmount);
        }

        let mut epoch = Self::must_get_epoch(&env, epoch_id);
        if epoch.finalized {
            env.panic_with_error(VotingRewardsError::EpochAlreadyFinalized);
        }
        if env.ledger().sequence() < epoch.end_ledger {
            env.panic_with_error(VotingRewardsError::EpochNotEnded);
        }
        if total_reward_amount > Self::available_pool(&env) {
            env.panic_with_error(VotingRewardsError::InsufficientPool);
        }

        let allocated = Self::allocated(&env);
        let new_allocated = allocated
            .checked_add(total_reward_amount)
            .unwrap_or_else(|| env.panic_with_error(VotingRewardsError::ArithmeticOverflow));
        env.storage()
            .instance()
            .set(&DataKey::RewardsPool, &new_allocated);

        epoch.merkle_root = Some(merkle_root.clone());
        epoch.total_reward_amount = total_reward_amount;
        epoch.finalized = true;
        Self::store_epoch(&env, &epoch);

        events::emit_epoch_root_published(&env, epoch_id, &merkle_root, total_reward_amount);
    }

    /// Claim `amount` for `claimant` from a published epoch, proving
    /// membership of `sha256(0x00 || claimant || epoch_id || amount)` in that
    /// epoch's Merkle tree.
    pub fn claim(
        env: Env,
        claimant: Address,
        epoch_id: u64,
        amount: i128,
        proof: Vec<BytesN<32>>,
    ) {
        claimant.require_auth();

        if amount <= 0 {
            env.panic_with_error(VotingRewardsError::InvalidAmount);
        }

        let sweep_key = DataKey::Swept(epoch_id);
        if env.storage().persistent().has(&sweep_key) {
            env.panic_with_error(VotingRewardsError::EpochAlreadySwept);
        }

        let mut epoch = Self::must_get_epoch(&env, epoch_id);
        let root = match epoch.merkle_root.clone() {
            Some(root) if epoch.finalized => root,
            _ => env.panic_with_error(VotingRewardsError::EpochNotFinalized),
        };

        let claimed_key = DataKey::Claimed(epoch_id, claimant.clone());
        if env.storage().persistent().has(&claimed_key) {
            env.panic_with_error(VotingRewardsError::AlreadyClaimed);
        }

        let leaf = merkle::compute_leaf(&env, &claimant, epoch_id, amount);
        if !merkle::verify_proof(&env, &root, &leaf, &proof) {
            env.panic_with_error(VotingRewardsError::InvalidProof);
        }

        // Rounding in the off-chain proportional split can only ever leave a
        // few stroops of an epoch unallocated, never overshoot it — but the
        // root is admin-supplied, so refuse to pay past what the epoch was
        // actually allocated instead of trusting that arithmetic.
        let new_claimed = epoch
            .claimed_amount
            .checked_add(amount)
            .unwrap_or_else(|| env.panic_with_error(VotingRewardsError::ArithmeticOverflow));
        if new_claimed > epoch.total_reward_amount {
            env.panic_with_error(VotingRewardsError::EpochOverclaimed);
        }

        // Mark claimed and debit the allocation before the transfer, so a
        // re-entrant token contract can't be used to claim twice.
        env.storage().persistent().set(&claimed_key, &());
        env.storage().persistent().extend_ttl(
            &claimed_key,
            REWARDS_TTL_LEDGERS,
            REWARDS_TTL_LEDGERS,
        );

        epoch.claimed_amount = new_claimed;
        Self::store_epoch(&env, &epoch);

        let allocated = Self::allocated(&env);
        let new_allocated = allocated
            .checked_sub(amount)
            .unwrap_or_else(|| env.panic_with_error(VotingRewardsError::ArithmeticOverflow));
        env.storage()
            .instance()
            .set(&DataKey::RewardsPool, &new_allocated);

        let reward_token = Self::reward_token(&env);
        token::TokenClient::new(&env, &reward_token).transfer(
            &env.current_contract_address(),
            &claimant,
            &amount,
        );

        events::emit_reward_claimed(&env, epoch_id, &claimant, amount);
    }

    /// Pull `amount` of the reward token from `funder` into this contract.
    ///
    /// A convenience over a bare token transfer, so funding shows up in the
    /// event stream (and therefore the indexer) with an attributed funder.
    /// Direct transfers to this contract's address still count toward the
    /// pool — the balance is what `publish_epoch_root` measures.
    pub fn fund_pool(env: Env, funder: Address, amount: i128) {
        funder.require_auth();
        if amount <= 0 {
            env.panic_with_error(VotingRewardsError::InvalidAmount);
        }

        let reward_token = Self::reward_token(&env);
        token::TokenClient::new(&env, &reward_token).transfer(
            &funder,
            &env.current_contract_address(),
            &amount,
        );

        events::emit_pool_funded(&env, &funder, amount);
    }

    /// Sweep unclaimed rewards from a finalized epoch back into the available pool.
    ///
    /// Admin-only. After a grace period past the epoch's `end_ledger`, returns
    /// any unclaimed rewards to `available_pool()` so they can fund future epochs.
    /// A swept epoch can never be swept twice. Claims after sweep fail with
    /// `EpochAlreadySwept`.
    pub fn sweep_epoch(env: Env, admin: Address, epoch_id: u64) {
        admin.require_auth();

        let stored_admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .unwrap_or_else(|| env.panic_with_error(VotingRewardsError::NotInitialized));
        if admin != stored_admin {
            env.panic_with_error(VotingRewardsError::NotAuthorized);
        }

        let mut epoch = Self::must_get_epoch(&env, epoch_id);

        if !epoch.finalized {
            env.panic_with_error(VotingRewardsError::EpochNotFinalized);
        }

        let sweep_key = DataKey::Swept(epoch_id);
        if env.storage().persistent().has(&sweep_key) {
            env.panic_with_error(VotingRewardsError::EpochAlreadySwept);
        }

        let current_ledger = env.ledger().sequence();
        let sweep_time = epoch.end_ledger.saturating_add(SWEEP_GRACE_PERIOD_LEDGERS);
        if current_ledger < sweep_time {
            env.panic_with_error(VotingRewardsError::EpochNotEnded);
        }

        let unclaimed = epoch.total_reward_amount - epoch.claimed_amount;
        if unclaimed > 0 {
            let allocated = Self::allocated(&env);
            env.storage()
                .instance()
                .set(&DataKey::RewardsPool, &(allocated - unclaimed));
        }

        epoch.total_reward_amount = epoch.claimed_amount;
        Self::store_epoch(&env, &epoch);

        env.storage().persistent().set(&sweep_key, &());
        env.storage()
            .persistent()
            .extend_ttl(&sweep_key, REWARDS_TTL_LEDGERS, REWARDS_TTL_LEDGERS);

        events::emit_epoch_swept(&env, epoch_id, unclaimed);
    }

    pub fn get_epoch(env: Env, epoch_id: u64) -> Option<Epoch> {
        env.storage()
            .persistent()
            .get(&DataKey::Epoch(epoch_id))
    }

    pub fn get_current_epoch_id(env: Env) -> u64 {
        Self::current_epoch_id(&env)
    }

    /// The address allowed to call `publish_epoch_root`.
    ///
    /// Exposed so the off-chain publisher can tell without configuration
    /// whether it may submit a root directly (the admin is its own relayer
    /// key) or has to package the call as a governance proposal (the admin
    /// is the governor contract, the intended deployment).
    pub fn get_admin(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .unwrap_or_else(|| env.panic_with_error(VotingRewardsError::NotInitialized))
    }

    pub fn has_claimed(env: Env, epoch_id: u64, claimant: Address) -> bool {
        env.storage()
            .persistent()
            .has(&DataKey::Claimed(epoch_id, claimant))
    }

    /// Reward tokens held by this contract that aren't already committed to
    /// a published epoch — the ceiling the backend must size the next
    /// epoch's `total_reward_amount` against.
    pub fn get_available_pool(env: Env) -> i128 {
        Self::available_pool(&env)
    }

    /// Propose a new admin address. The current admin remains active until
    /// the proposed address accepts the transfer.
    pub fn propose_admin(env: Env, admin: Address, new_admin: Address) {
        admin.require_auth();
        let stored_admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .unwrap_or_else(|| env.panic_with_error(VotingRewardsError::NotInitialized));
        if admin != stored_admin {
            env.panic_with_error(VotingRewardsError::NotAuthorized);
        }

        env.storage()
            .instance()
            .set(&DataKey::PendingAdmin, &new_admin);
        events::emit_admin_proposed(&env, &new_admin);
    }

    /// Return the proposed next admin, if a transfer is in progress.
    pub fn get_pending_admin(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::PendingAdmin)
    }

    /// Accept an admin transfer. Only the proposed address can complete it.
    pub fn accept_admin(env: Env, new_admin: Address) {
        new_admin.require_auth();
        let pending_admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::PendingAdmin)
            .unwrap_or_else(|| env.panic_with_error(VotingRewardsError::NotAuthorized));
        if new_admin != pending_admin {
            env.panic_with_error(VotingRewardsError::NotAuthorized);
        }

        env.storage().instance().set(&DataKey::Admin, &new_admin);
        env.storage().instance().remove(&DataKey::PendingAdmin);
        events::emit_admin_accepted(&env, &new_admin);
    }

    /// Update the epoch duration for future epochs. Admin-only.
    ///
    /// The new duration applies only to epochs opened after this call.
    /// Already-opened epochs keep their original duration.
    pub fn update_epoch_duration(env: Env, admin: Address, new_duration_ledgers: u32) {
        admin.require_auth();
        let stored_admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .unwrap_or_else(|| env.panic_with_error(VotingRewardsError::NotInitialized));
        if admin != stored_admin {
            env.panic_with_error(VotingRewardsError::NotAuthorized);
        }
        if new_duration_ledgers == 0 {
            env.panic_with_error(VotingRewardsError::InvalidEpochDuration);
        }

        env.storage()
            .instance()
            .set(&DataKey::EpochDurationLedgers, &new_duration_ledgers);
        events::emit_epoch_duration_updated(&env, new_duration_ledgers);
    }

    fn open_epoch(env: &Env, id: u64, duration: u32) {
        let start_ledger = env.ledger().sequence();
        let epoch = Epoch {
            id,
            start_ledger,
            end_ledger: start_ledger.saturating_add(duration),
            merkle_root: None,
            total_reward_amount: 0,
            claimed_amount: 0,
            finalized: false,
        };
        Self::store_epoch(env, &epoch);
        env.storage().instance().set(&DataKey::CurrentEpochId, &id);
        events::emit_epoch_started(env, id, epoch.start_ledger, epoch.end_ledger);
    }

    fn store_epoch(env: &Env, epoch: &Epoch) {
        let key = DataKey::Epoch(epoch.id);
        env.storage().persistent().set(&key, epoch);
        env.storage()
            .persistent()
            .extend_ttl(&key, REWARDS_TTL_LEDGERS, REWARDS_TTL_LEDGERS);
    }

    fn must_get_epoch(env: &Env, epoch_id: u64) -> Epoch {
        env.storage()
            .persistent()
            .get(&DataKey::Epoch(epoch_id))
            .unwrap_or_else(|| env.panic_with_error(VotingRewardsError::EpochNotFound))
    }

    fn current_epoch_id(env: &Env) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::CurrentEpochId)
            .unwrap_or_else(|| env.panic_with_error(VotingRewardsError::NotInitialized))
    }

    fn reward_token(env: &Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::RewardToken)
            .unwrap_or_else(|| env.panic_with_error(VotingRewardsError::NotInitialized))
    }

    fn allocated(env: &Env) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::RewardsPool)
            .unwrap_or(0)
    }

    fn available_pool(env: &Env) -> i128 {
        let reward_token = Self::reward_token(env);
        let balance =
            token::TokenClient::new(env, &reward_token).balance(&env.current_contract_address());
        balance
            .checked_sub(Self::allocated(env))
            .unwrap_or_else(|| env.panic_with_error(VotingRewardsError::ArithmeticOverflow))
    }
}

#[cfg(test)]
mod tests;
