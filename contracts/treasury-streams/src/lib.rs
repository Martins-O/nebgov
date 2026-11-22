#![no_std]
#![allow(clippy::too_many_arguments)]

//! Recurring payments out of the treasury, created and cancelled by governance.
//!
//! A stream says "pay `recipient` `amount_per_interval` every `interval_ledgers`
//! ledgers, from `start_ledger` until `end_ledger`". Creating a stream does not
//! move funds: the treasury transfers the asset into this contract, and each
//! `execute_stream` pays out of that balance. Execution is permissionless, so a
//! backend job or any recipient can trigger due intervals.
//!
//! Access control model:
//! - only the configured governor may `create_stream`
//! - the configured admin (the treasury) or the stream's creator may
//!   `pause_stream`, `resume_stream` and `cancel_stream`
//! - `execute_stream` is permissionless while the stream is live
//!
//! A stream completes when `execute_stream` pays its last whole interval: it
//! is marked `completed`, removed from `get_active_streams`, and can no longer
//! be executed, paused, resumed or cancelled.
//!
//! Only whole intervals are paid. A trailing partial interval before
//! `end_ledger` is not paid. A paused stream pays nothing while paused, and
//! intervals that came due during the pause are paid once it resumes.

mod error;
mod events;

pub use error::TreasuryStreamsError;
pub use events::*;

use soroban_sdk::{contract, contractimpl, contracttype, token, Address, Env, Vec};

const TTL_LEDGERS: u32 = 6_307_200;

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct Stream {
    pub id: u64,
    pub recipient: Address,
    pub asset: Address,
    pub amount_per_interval: i128,
    pub interval_ledgers: u32,
    pub start_ledger: u32,
    pub end_ledger: u32,
    /// Ledger up to which intervals have been paid. The next interval
    /// completes at `last_streamed_ledger + interval_ledgers`.
    pub last_streamed_ledger: u32,
    pub total_streamed: i128,
    pub paused: bool,
    pub cancelled: bool,
    /// Set once `execute_stream` has paid the last whole interval before
    /// `end_ledger`. A completed stream pays nothing more.
    pub completed: bool,
    /// The address that created the stream. Creation is governor-only, so
    /// this is the governor, recorded so it can later pause or cancel.
    pub created_by: Address,
}

#[contracttype]
enum DataKey {
    Admin,
    Governor,
    NextStreamId,
    Stream(u64),
    StreamsByRecipient(Address),
    /// Ids of streams that are neither cancelled nor completed, in creation
    /// order.
    ActiveStreams,
}

#[contract]
pub struct TreasuryStreamsContract;

#[contractimpl]
impl TreasuryStreamsContract {
    /// `admin` is the treasury address, which may pause, resume and cancel
    /// streams. `governor` is the only address that may create them.
    pub fn initialize(env: Env, admin: Address, governor: Address) {
        admin.require_auth();
        if env.storage().instance().has(&DataKey::Admin) {
            env.panic_with_error(TreasuryStreamsError::AlreadyInitialized);
        }

        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Governor, &governor);
        env.storage().instance().set(&DataKey::NextStreamId, &1u64);
    }

    /// Create a stream and return its id. The stream's first interval
    /// completes `interval_ledgers` after `start_ledger`.
    pub fn create_stream(
        env: Env,
        requester: Address,
        recipient: Address,
        asset: Address,
        amount_per_interval: i128,
        interval_ledgers: u32,
        start_ledger: u32,
        end_ledger: u32,
    ) -> u64 {
        requester.require_auth();
        Self::require_governor(&env, &requester);

        if amount_per_interval <= 0 {
            env.panic_with_error(TreasuryStreamsError::InvalidAmount);
        }
        if interval_ledgers == 0 {
            env.panic_with_error(TreasuryStreamsError::InvalidInterval);
        }
        if end_ledger <= start_ledger || end_ledger <= env.ledger().sequence() {
            env.panic_with_error(TreasuryStreamsError::InvalidSchedule);
        }

        let stream_id: u64 = env
            .storage()
            .instance()
            .get(&DataKey::NextStreamId)
            .unwrap_or(1u64);
        env.storage()
            .instance()
            .set(&DataKey::NextStreamId, &(stream_id + 1));

        let stream = Stream {
            id: stream_id,
            recipient: recipient.clone(),
            asset,
            amount_per_interval,
            interval_ledgers,
            start_ledger,
            end_ledger,
            last_streamed_ledger: start_ledger,
            total_streamed: 0,
            paused: false,
            cancelled: false,
            completed: false,
            created_by: requester,
        };
        Self::save_stream(&env, &stream);

        let recipient_key = DataKey::StreamsByRecipient(recipient.clone());
        let mut by_recipient: Vec<u64> = env
            .storage()
            .persistent()
            .get(&recipient_key)
            .unwrap_or(Vec::new(&env));
        by_recipient.push_back(stream_id);
        env.storage().persistent().set(&recipient_key, &by_recipient);
        env.storage()
            .persistent()
            .extend_ttl(&recipient_key, TTL_LEDGERS, TTL_LEDGERS);

        let mut active = Self::active_ids(&env);
        active.push_back(stream_id);
        Self::save_active_ids(&env, &active);

        emit_stream_created(
            &env,
            stream_id,
            &recipient,
            amount_per_interval,
            interval_ledgers,
        );
        stream_id
    }

    /// Pay every whole interval that has come due since the last payment.
    /// Permissionless: anyone may trigger payment once an interval is due.
    ///
    /// When this pays the stream's last whole interval (no further interval
    /// fits before `end_ledger`), the stream is marked `completed`, removed
    /// from `ActiveStreams`, and `StrmCompleted` is emitted.
    pub fn execute_stream(env: Env, stream_id: u64) {
        let mut stream = Self::load_stream(&env, stream_id);
        Self::require_live(&env, &stream);
        if stream.paused {
            env.panic_with_error(TreasuryStreamsError::StreamPaused);
        }

        let (intervals, amount) = Self::accrued(&env, &stream);
        if intervals == 0 {
            env.panic_with_error(TreasuryStreamsError::StreamNotDue);
        }

        let this_contract = env.current_contract_address();
        let asset = token::TokenClient::new(&env, &stream.asset);
        if asset.balance(&this_contract) < amount {
            env.panic_with_error(TreasuryStreamsError::InsufficientBalance);
        }

        // Effects before the transfer, so a failed transfer reverts them too.
        let new_last_streamed = intervals
            .checked_mul(stream.interval_ledgers)
            .and_then(|span| stream.last_streamed_ledger.checked_add(span))
            .unwrap_or_else(|| env.panic_with_error(TreasuryStreamsError::ArithmeticOverflow));
        stream.last_streamed_ledger = new_last_streamed;
        stream.total_streamed = stream
            .total_streamed
            .checked_add(amount)
            .unwrap_or_else(|| env.panic_with_error(TreasuryStreamsError::ArithmeticOverflow));
        // No further whole interval fits before `end_ledger` (an overflowing
        // next boundary is past it by definition).
        stream.completed = stream
            .last_streamed_ledger
            .checked_add(stream.interval_ledgers)
            .is_none_or(|next| next > stream.end_ledger);
        Self::save_stream(&env, &stream);
        if stream.completed {
            Self::remove_active_id(&env, stream_id);
        }

        asset.transfer(&this_contract, &stream.recipient, &amount);
        emit_stream_executed(&env, stream_id, amount, env.ledger().sequence());
        if stream.completed {
            emit_stream_completed(&env, stream_id, stream.total_streamed);
        }
    }

    /// Stop payments on a stream without cancelling it.
    pub fn pause_stream(env: Env, requester: Address, stream_id: u64) {
        requester.require_auth();
        let mut stream = Self::load_stream(&env, stream_id);
        Self::require_admin_or_creator(&env, &requester, &stream);

        Self::require_live(&env, &stream);
        if stream.paused {
            env.panic_with_error(TreasuryStreamsError::AlreadyPaused);
        }

        stream.paused = true;
        Self::save_stream(&env, &stream);
        emit_stream_paused(&env, stream_id);
    }

    pub fn resume_stream(env: Env, requester: Address, stream_id: u64) {
        requester.require_auth();
        let mut stream = Self::load_stream(&env, stream_id);
        Self::require_admin_or_creator(&env, &requester, &stream);

        Self::require_live(&env, &stream);
        if !stream.paused {
            env.panic_with_error(TreasuryStreamsError::NotPaused);
        }

        stream.paused = false;
        Self::save_stream(&env, &stream);
        emit_stream_resumed(&env, stream_id);
    }

    /// Cancel a stream permanently. Intervals that are due but not yet
    /// executed are forfeited, so execute them before cancelling.
    pub fn cancel_stream(env: Env, requester: Address, stream_id: u64) {
        requester.require_auth();
        let mut stream = Self::load_stream(&env, stream_id);
        Self::require_admin_or_creator(&env, &requester, &stream);

        Self::require_live(&env, &stream);

        stream.cancelled = true;
        Self::save_stream(&env, &stream);
        Self::remove_active_id(&env, stream_id);

        emit_stream_cancelled(&env, stream_id, stream.total_streamed);
    }

    pub fn get_stream(env: Env, stream_id: u64) -> Stream {
        Self::load_stream(&env, stream_id)
    }

    /// Amount that `execute_stream` would pay right now, or 0 if nothing is due.
    pub fn get_claimable_amount(env: Env, stream_id: u64) -> i128 {
        let stream = Self::load_stream(&env, stream_id);
        Self::accrued(&env, &stream).1
    }

    /// One page of the streams created for `recipient`, including cancelled
    /// and completed ones.
    pub fn get_streams_for_recipient(
        env: Env,
        recipient: Address,
        offset: u32,
        limit: u32,
    ) -> Vec<Stream> {
        let ids: Vec<u64> = env
            .storage()
            .persistent()
            .get(&DataKey::StreamsByRecipient(recipient))
            .unwrap_or(Vec::new(&env));
        Self::page(&env, ids, offset, limit)
    }

    /// One page of streams that are neither cancelled nor completed, in
    /// creation order.
    pub fn get_active_streams(env: Env, offset: u32, limit: u32) -> Vec<Stream> {
        Self::page(&env, Self::active_ids(&env), offset, limit)
    }

    /// Intervals that have come due, and the amount they pay. Paused,
    /// cancelled and completed streams accrue nothing.
    fn accrued(env: &Env, stream: &Stream) -> (u32, i128) {
        if stream.paused || stream.cancelled || stream.completed {
            return (0, 0);
        }

        let until = env.ledger().sequence().min(stream.end_ledger);
        if until <= stream.last_streamed_ledger {
            return (0, 0);
        }

        let intervals = (until - stream.last_streamed_ledger) / stream.interval_ledgers;
        if intervals == 0 {
            return (0, 0);
        }

        let amount = (intervals as i128)
            .checked_mul(stream.amount_per_interval)
            .unwrap_or_else(|| env.panic_with_error(TreasuryStreamsError::ArithmeticOverflow));
        (intervals, amount)
    }

    fn page(env: &Env, ids: Vec<u64>, offset: u32, limit: u32) -> Vec<Stream> {
        let mut result = Vec::new(env);
        let len = ids.len();
        if offset >= len || limit == 0 {
            return result;
        }

        let end = offset.saturating_add(limit).min(len);
        for index in offset..end {
            let id = ids
                .get(index)
                .unwrap_or_else(|| env.panic_with_error(TreasuryStreamsError::StreamNotFound));
            result.push_back(Self::load_stream(env, id));
        }
        result
    }

    fn load_stream(env: &Env, stream_id: u64) -> Stream {
        env.storage()
            .persistent()
            .get(&DataKey::Stream(stream_id))
            .unwrap_or_else(|| env.panic_with_error(TreasuryStreamsError::StreamNotFound))
    }

    fn save_stream(env: &Env, stream: &Stream) {
        let key = DataKey::Stream(stream.id);
        env.storage().persistent().set(&key, stream);
        env.storage()
            .persistent()
            .extend_ttl(&key, TTL_LEDGERS, TTL_LEDGERS);
    }

    fn active_ids(env: &Env) -> Vec<u64> {
        env.storage()
            .persistent()
            .get(&DataKey::ActiveStreams)
            .unwrap_or(Vec::new(env))
    }

    fn save_active_ids(env: &Env, ids: &Vec<u64>) {
        env.storage()
            .persistent()
            .set(&DataKey::ActiveStreams, ids);
        env.storage()
            .persistent()
            .extend_ttl(&DataKey::ActiveStreams, TTL_LEDGERS, TTL_LEDGERS);
    }

    fn remove_active_id(env: &Env, stream_id: u64) {
        let mut remaining: Vec<u64> = Vec::new(env);
        for id in Self::active_ids(env).iter() {
            if id != stream_id {
                remaining.push_back(id);
            }
        }
        Self::save_active_ids(env, &remaining);
    }

    /// Reject a stream that has ended, by cancellation or completion.
    fn require_live(env: &Env, stream: &Stream) {
        if stream.cancelled {
            env.panic_with_error(TreasuryStreamsError::StreamCancelled);
        }
        if stream.completed {
            env.panic_with_error(TreasuryStreamsError::StreamCompleted);
        }
    }

    fn require_governor(env: &Env, caller: &Address) {
        let governor: Address = env
            .storage()
            .instance()
            .get(&DataKey::Governor)
            .unwrap_or_else(|| env.panic_with_error(TreasuryStreamsError::NotInitialized));
        if caller != &governor {
            env.panic_with_error(TreasuryStreamsError::NotAuthorized);
        }
    }

    fn require_admin_or_creator(env: &Env, caller: &Address, stream: &Stream) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .unwrap_or_else(|| env.panic_with_error(TreasuryStreamsError::NotInitialized));
        if caller != &admin && caller != &stream.created_by {
            env.panic_with_error(TreasuryStreamsError::NotAuthorized);
        }
    }
}

#[cfg(test)]
mod tests;
