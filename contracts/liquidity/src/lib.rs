#![no_std]
#![allow(clippy::too_many_arguments)]

//! Protocol-owned liquidity management for NebGov markets.
//!
//! This contract maintains simple two-asset pools used to support market
//! liquidity around governance-controlled prediction or outcome tokens. End
//! users can add liquidity, remove liquidity, and swap against a pool using a
//! constant-product pricing curve with configurable fees.
//!
//! The contract integrates with NebGov governance through a stored governor
//! address. Day-to-day user actions are self-authorized by the caller, while
//! privileged configuration changes such as fee updates are restricted to the
//! governor and are intended to be executed through the governor -> timelock ->
//! liquidity proposal flow.
//!
//! Access control model:
//! - liquidity providers must authorize `add_liquidity` and `remove_liquidity`
//! - traders must authorize `swap`
//! - only the configured governor may call `create_pool`, `initialize_pool`, and `update_pool_fee`

mod events;
use events::*;

use soroban_sdk::token::TokenClient;
use soroban_sdk::{contract, contracterror, contractimpl, contracttype, Address, Env};

const MIN_LIQUIDITY: i128 = 1_000;
const MAX_FEE_BPS: u32 = 1_000;
const TTL_LEDGERS: u32 = 6_307_200;
/// Re-extend the instance entry once its remaining TTL drops below this many ledgers.
pub const INSTANCE_TTL_THRESHOLD: u32 = 100_000;
/// Number of ledgers the instance entry (governor address) is extended to.
pub const INSTANCE_EXTEND_TTL: u32 = 300_000;

/// Keep the contract instance (which holds the governor address) alive so the
/// contract is not archived after a quiet period.
fn extend_instance_ttl(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_EXTEND_TTL);
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Pool {
    pub reserve_a: i128,
    pub reserve_b: i128,
    pub total_lp_supply: i128,
    pub fee_bps: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PoolMetadata {
    pub created_by: Address,
    pub created_ledger: u32,
    pub created_timestamp: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LPPosition {
    pub lp_tokens: i128,
}

#[contracttype]
enum DataKey {
    Governor,
    Pool(u32, u32),
    PoolMetadata(u32, u32),
    Position(Address, u32, u32),
    PoolTokens(u32, u32),
}

/// Liquidity contract error codes.
#[contracterror]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LiquidityError {
    /// Amount must be positive (not zero or negative).
    InvalidAmount = 1,
    /// Caller does not have sufficient LP shares for this operation.
    InsufficientShares = 2,
    /// Subsequent deposit does not maintain the pool's current reserve ratio.
    ImbalancedDeposit = 3,
    /// Arithmetic overflow while calculating or updating pool accounting.
    ArithmeticOverflow = 4,
    /// Pool does not exist for the given outcome pair.
    PoolNotFound = 5,
    /// Pool reserve is zero, cannot swap.
    InsufficientReserves = 6,
    /// Input and output outcomes must be different.
    SameOutcome = 7,
    /// Withdrawn liquidity is below the minimum required.
    BelowMinLiquidity = 8,
    /// The contract has already been initialized.
    AlreadyInitialized = 9,
    /// Swap fee exceeds the allowed maximum.
    FeeTooHigh = 10,
    /// LP tokens minted are below the caller's minimum.
    SlippageExceeded = 11,
    /// Caller is not the governor.
    NotGovernor = 12,
    /// Deposit amount is below the minimum required.
    DepositTooSmall = 13,
    /// Token pair for an existing pool is missing from storage.
    PoolTokensNotFound = 14,
}

#[contract]
pub struct LiquidityContract;

#[contractimpl]
impl LiquidityContract {
    /// Initialize the contract with the governor that owns privileged actions.
    pub fn initialize(env: Env, governor: Address) {
        extend_instance_ttl(&env);
        governor.require_auth();
        if env.storage().instance().has(&DataKey::Governor) {
            env.panic_with_error(LiquidityError::AlreadyInitialized);
        }
        env.storage().instance().set(&DataKey::Governor, &governor);
    }

    /// Return the configured governor address.
    pub fn governor(env: Env) -> Address {
        extend_instance_ttl(&env);
        env.storage()
            .instance()
            .get(&DataKey::Governor)
            .unwrap_or_else(|| env.panic_with_error(LiquidityError::PoolNotFound))
    }

    /// Register a new pool's token addresses. Must be called once before adding liquidity.
    pub fn create_pool(
        env: Env,
        caller: Address,
        outcome_a: u32,
        outcome_b: u32,
        token_a: Address,
        token_b: Address,
    ) {
        extend_instance_ttl(&env);
        caller.require_auth();
        Self::require_governor(&env, &caller);

        // Normalize outcome ordering so Pool(a,b) and Pool(b,a) map to the same slot.
        // token_lo is the token for the smaller outcome id, token_hi for the larger.
        let (lo, hi, tok_lo, tok_hi) = if outcome_a <= outcome_b {
            (outcome_a, outcome_b, token_a, token_b)
        } else {
            (outcome_b, outcome_a, token_b, token_a)
        };

        let tokens_key = DataKey::PoolTokens(lo, hi);
        if env.storage().persistent().has(&tokens_key) {
            env.panic_with_error(LiquidityError::AlreadyInitialized);
        }
        env.storage()
            .persistent()
            .set(&tokens_key, &(tok_lo, tok_hi));
    }

    /// Initialize an explicitly approved pool with its starting fee.
    ///
    /// Token addresses are registered separately with `create_pool`; both steps
    /// are governor-gated, and `add_liquidity` requires both records to exist.
    pub fn initialize_pool(
        env: Env,
        caller: Address,
        outcome_a: u32,
        outcome_b: u32,
        fee_bps: u32,
    ) {
        extend_instance_ttl(&env);
        caller.require_auth();
        Self::require_governor(&env, &caller);

        if fee_bps > MAX_FEE_BPS {
            env.panic_with_error(LiquidityError::FeeTooHigh);
        }

        let pool_key = Self::pool_key(outcome_a, outcome_b);
        if env.storage().persistent().has(&pool_key) {
            env.panic_with_error(LiquidityError::AlreadyInitialized);
        }

        let pool = Pool {
            reserve_a: 0,
            reserve_b: 0,
            total_lp_supply: 0,
            fee_bps,
        };
        let metadata = PoolMetadata {
            created_by: caller,
            created_ledger: env.ledger().sequence(),
            created_timestamp: env.ledger().timestamp(),
        };

        env.storage().persistent().set(&pool_key, &pool);
        env.storage().persistent().extend_ttl(&pool_key, TTL_LEDGERS, TTL_LEDGERS);
        let metadata_key = Self::pool_metadata_key(outcome_a, outcome_b);
        env.storage()
            .persistent()
            .set(&metadata_key, &metadata);
        env.storage().persistent().extend_ttl(&metadata_key, TTL_LEDGERS, TTL_LEDGERS);
    }

    /// Add liquidity to a pool and mint LP shares.
    ///
    /// Returns `(lp_tokens, deposit_b)`. `deposit_b` is the amount of B actually
    /// credited to the pool (equal to `required_b` for subsequent deposits, or
    /// `amount_b` for the first deposit). Callers should use `deposit_b` to
    /// reconcile their balance — any `amount_b` in excess of `deposit_b` was not
    /// consumed.
    pub fn add_liquidity(
        env: Env,
        provider: Address,
        outcome_a: u32,
        outcome_b: u32,
        amount_a: i128,
        amount_b: i128,
        min_lp_tokens_out: i128,
    ) -> (i128, i128) {
        extend_instance_ttl(&env);
        provider.require_auth();

        if amount_a <= 0 || amount_b <= 0 {
            env.panic_with_error(LiquidityError::InvalidAmount);
        }

        // Normalize outcome pair so Pool(a,b) and Pool(b,a) share the same storage slot.
        // lo_amount is the deposit for the smaller outcome id (→ reserve_a),
        // hi_amount is the deposit for the larger outcome id (→ reserve_b).
        let swapped = outcome_a > outcome_b;
        let (lo, hi, lo_amount, hi_amount) = if !swapped {
            (outcome_a, outcome_b, amount_a, amount_b)
        } else {
            (outcome_b, outcome_a, amount_b, amount_a)
        };

        if lo_amount < MIN_LIQUIDITY {
            env.panic_with_error(LiquidityError::BelowMinLiquidity);
        }

        // Checks & Reads
        let tokens_key = DataKey::PoolTokens(lo, hi);
        let stored_tokens: Option<(Address, Address)> = env.storage().persistent().get(&tokens_key);
        let (token_lo, token_hi) = match stored_tokens {
            Some(t) => t,
            None => env.panic_with_error(LiquidityError::PoolNotFound),
        };

        let pool_key = Self::pool_key(lo, hi);
        let mut pool: Pool = match env.storage().persistent().get(&pool_key) {
            Some(p) => p,
            None => env.panic_with_error(LiquidityError::PoolNotFound),
        };
        let position_key = Self::position_key(provider.clone(), lo, hi);
        let mut position: LPPosition = env
            .storage()
            .persistent()
            .get(&position_key)
            .unwrap_or(LPPosition { lp_tokens: 0 });

        // For subsequent deposits, enforce the current reserve ratio so that
        // callers cannot shift the pool price by providing an arbitrary hi_amount.
        // `required_hi` is the exact hi-side amount that keeps reserve_b/reserve_a constant.
        // `hi_amount` acts as a caller-supplied maximum (slippage guard): if the pool
        // has moved so that required_hi exceeds hi_amount, the call is rejected.
        // Only `required_hi` is credited to the pool regardless of how large hi_amount is,
        // preventing value extraction through inflated reserve_b contributions.
        let (lp_tokens, deposit_hi) = if pool.total_lp_supply == 0 {
            if hi_amount < MIN_LIQUIDITY {
                env.panic_with_error(LiquidityError::BelowMinLiquidity);
            }
            (lo_amount, hi_amount)
        } else {
            let required_hi = Self::checked_mul(&env, lo_amount, pool.reserve_b) / pool.reserve_a;
            if required_hi < MIN_LIQUIDITY {
                env.panic_with_error(LiquidityError::BelowMinLiquidity);
            }
            if hi_amount < required_hi {
                env.panic_with_error(LiquidityError::ImbalancedDeposit);
            }
            let lp = Self::checked_mul(&env, lo_amount, pool.total_lp_supply) / pool.reserve_a;
            if lp == 0 {
                env.panic_with_error(LiquidityError::DepositTooSmall);
            }
            (lp, required_hi)
        };

        if lp_tokens < min_lp_tokens_out {
            env.panic_with_error(LiquidityError::SlippageExceeded);
        }

        // Effects
        pool.reserve_a = Self::checked_add(&env, pool.reserve_a, lo_amount);
        pool.reserve_b = Self::checked_add(&env, pool.reserve_b, deposit_hi);
        pool.total_lp_supply = Self::checked_add(&env, pool.total_lp_supply, lp_tokens);
        position.lp_tokens = Self::checked_add(&env, position.lp_tokens, lp_tokens);

        env.storage().persistent().set(&pool_key, &pool);
        env.storage().persistent().extend_ttl(&pool_key, TTL_LEDGERS, TTL_LEDGERS);
        env.storage().persistent().set(&position_key, &position);
        env.storage().persistent().extend_ttl(&position_key, TTL_LEDGERS, TTL_LEDGERS);

        // Interactions
        TokenClient::new(&env, &token_lo).transfer(
            &provider,
            &env.current_contract_address(),
            &lo_amount,
        );
        TokenClient::new(&env, &token_hi).transfer(
            &provider,
            &env.current_contract_address(),
            &deposit_hi,
        );

        emit_liquidity_added(&env, &provider, lo, hi, lo_amount, deposit_hi, lp_tokens);

        // Return (lp_tokens, deposit for the caller's "b" side).
        // When the pair is not swapped, caller's b = hi → deposit_hi.
        // When swapped, caller's b = lo → lo_amount (lo side is always fully consumed).
        let deposit_b_caller = if !swapped { deposit_hi } else { lo_amount };
        (lp_tokens, deposit_b_caller)
    }

    /// Remove liquidity from a pool and burn LP shares.
    pub fn remove_liquidity(
        env: Env,
        provider: Address,
        outcome_a: u32,
        outcome_b: u32,
        lp_tokens: i128,
    ) -> (i128, i128) {
        extend_instance_ttl(&env);
        provider.require_auth();

        // Security: validate caller inputs before any state mutation or token transfer.
        // A failed check here leaves contract state unchanged.
        if lp_tokens <= 0 {
            env.panic_with_error(LiquidityError::InvalidAmount);
        }

        let provider_shares =
            Self::get_lp_position(env.clone(), provider.clone(), outcome_a, outcome_b);
        if lp_tokens > provider_shares {
            env.panic_with_error(LiquidityError::InsufficientShares);
        }

        // Normalize outcome pair so Pool(a,b) and Pool(b,a) share the same storage slot.
        let swapped = outcome_a > outcome_b;
        let (lo, hi) = if !swapped {
            (outcome_a, outcome_b)
        } else {
            (outcome_b, outcome_a)
        };

        // Checks & Reads
        let pool_key = Self::pool_key(lo, hi);
        let mut pool: Pool = env
            .storage()
            .persistent()
            .get(&pool_key)
            .unwrap_or_else(|| env.panic_with_error(LiquidityError::PoolNotFound));

        let position_key = Self::position_key(provider.clone(), lo, hi);
        let mut position: LPPosition = env
            .storage()
            .persistent()
            .get(&position_key)
            .unwrap_or_else(|| env.panic_with_error(LiquidityError::InsufficientShares));

        let tokens_key = DataKey::PoolTokens(lo, hi);
        let stored_tokens: Option<(Address, Address)> = env.storage().persistent().get(&tokens_key);
        let (token_lo, token_hi) = stored_tokens
            .unwrap_or_else(|| env.panic_with_error(LiquidityError::PoolTokensNotFound));

        let amount_lo = (lp_tokens * pool.reserve_a) / pool.total_lp_supply;
        let amount_hi = (lp_tokens * pool.reserve_b) / pool.total_lp_supply;

        // Ensure post-removal reserves don't drop below MIN_LIQUIDITY unless fully drained
        let remaining_lo = pool.reserve_a - amount_lo;
        let remaining_hi = pool.reserve_b - amount_hi;
        if (remaining_lo > 0 && remaining_lo < MIN_LIQUIDITY)
            || (remaining_hi > 0 && remaining_hi < MIN_LIQUIDITY)
        {
            env.panic_with_error(LiquidityError::BelowMinLiquidity);
        }

        // Effects
        pool.reserve_a -= amount_lo;
        pool.reserve_b -= amount_hi;
        pool.total_lp_supply -= lp_tokens;
        position.lp_tokens -= lp_tokens;

        env.storage().persistent().set(&pool_key, &pool);
        env.storage().persistent().extend_ttl(&pool_key, TTL_LEDGERS, TTL_LEDGERS);
        env.storage().persistent().set(&position_key, &position);
        env.storage().persistent().extend_ttl(&position_key, TTL_LEDGERS, TTL_LEDGERS);

        // Interactions
        TokenClient::new(&env, &token_lo).transfer(
            &env.current_contract_address(),
            &provider,
            &amount_lo,
        );
        TokenClient::new(&env, &token_hi).transfer(
            &env.current_contract_address(),
            &provider,
            &amount_hi,
        );

        emit_liquidity_removed(&env, &provider, lo, hi, amount_lo, amount_hi, lp_tokens);

        // Return amounts in the caller's original ordering.
        if !swapped {
            (amount_lo, amount_hi)
        } else {
            (amount_hi, amount_lo)
        }
    }

    /// Swap `amount_in` of one pool asset for the other.
    pub fn swap(
        env: Env,
        trader: Address,
        outcome_in: u32,
        outcome_out: u32,
        amount_in: i128,
        min_amount_out: i128,
    ) -> i128 {
        extend_instance_ttl(&env);
        trader.require_auth();

        if outcome_in == outcome_out {
            env.panic_with_error(LiquidityError::SameOutcome);
        }

        if amount_in <= 0 {
            env.panic_with_error(LiquidityError::InvalidAmount);
        }

        // Normalize outcome pair: pool is always stored under Pool(lo, hi).
        // Determine which reserve is "in" and which is "out" based on direction.
        let lo_is_in = outcome_in < outcome_out;
        let (lo, hi) = if lo_is_in {
            (outcome_in, outcome_out)
        } else {
            (outcome_out, outcome_in)
        };

        // Checks & Reads
        let pool_key = Self::pool_key(lo, hi);
        let mut pool: Pool = env
            .storage()
            .persistent()
            .get(&pool_key)
            .unwrap_or_else(|| env.panic_with_error(LiquidityError::PoolNotFound));

        if pool.reserve_a == 0 || pool.reserve_b == 0 {
            env.panic_with_error(LiquidityError::InsufficientReserves);
        }

        // PoolTokens(lo, hi) stores (token_lo, token_hi).
        let tokens_key = DataKey::PoolTokens(lo, hi);
        let stored_tokens: Option<(Address, Address)> = env.storage().persistent().get(&tokens_key);
        let (token_lo, token_hi) = stored_tokens
            .unwrap_or_else(|| env.panic_with_error(LiquidityError::PoolTokensNotFound));

        // If outcome_in is lo, we sell into reserve_a and receive from reserve_b,
        // and vice versa for the reverse direction.
        let (reserve_in, reserve_out, token_in, token_out) = if lo_is_in {
            (pool.reserve_a, pool.reserve_b, token_lo, token_hi)
        } else {
            (pool.reserve_b, pool.reserve_a, token_hi, token_lo)
        };

        let (amount_out_with_fee, fee) =
            Self::calculate_amount_out(amount_in, reserve_in, reserve_out, pool.fee_bps);

        if amount_out_with_fee < min_amount_out {
            env.panic_with_error(LiquidityError::SlippageExceeded);
        }

        // Effects: update the correct reserves based on direction.
        if lo_is_in {
            pool.reserve_a += amount_in;
            pool.reserve_b -= amount_out_with_fee;
        } else {
            pool.reserve_b += amount_in;
            pool.reserve_a -= amount_out_with_fee;
        }
        env.storage().persistent().set(&pool_key, &pool);
        env.storage().persistent().extend_ttl(&pool_key, TTL_LEDGERS, TTL_LEDGERS);

        // Interactions
        TokenClient::new(&env, &token_in).transfer(
            &trader,
            &env.current_contract_address(),
            &amount_in,
        );
        TokenClient::new(&env, &token_out).transfer(
            &env.current_contract_address(),
            &trader,
            &amount_out_with_fee,
        );

        emit_swap(&env, &trader, outcome_in, outcome_out, amount_in, amount_out_with_fee, fee);

        amount_out_with_fee
    }

    /// Update a pool fee. Only the configured governor may call this.
    pub fn update_pool_fee(
        env: Env,
        caller: Address,
        outcome_a: u32,
        outcome_b: u32,
        fee_bps: u32,
    ) {
        extend_instance_ttl(&env);
        caller.require_auth();
        Self::require_governor(&env, &caller);

        if fee_bps > MAX_FEE_BPS {
            env.panic_with_error(LiquidityError::FeeTooHigh);
        }

        let pool_key = Self::pool_key(outcome_a, outcome_b);
        let mut pool: Pool = env
            .storage()
            .persistent()
            .get(&pool_key)
            .unwrap_or_else(|| env.panic_with_error(LiquidityError::PoolNotFound));
        let old_fee_bps = pool.fee_bps;
        pool.fee_bps = fee_bps;
        env.storage().persistent().set(&pool_key, &pool);
        env.storage().persistent().extend_ttl(&pool_key, TTL_LEDGERS, TTL_LEDGERS);
        emit_pool_fee_updated(&env, outcome_a, outcome_b, old_fee_bps, fee_bps);
    }

    /// Get the current pool state.
    pub fn get_pool(env: Env, outcome_a: u32, outcome_b: u32) -> Pool {
        extend_instance_ttl(&env);
        env.storage()
            .persistent()
            .get(&Self::pool_key(outcome_a, outcome_b))
            .unwrap_or_else(|| env.panic_with_error(LiquidityError::PoolNotFound))
    }

    /// Get the current pool state without panicking if the pool does not exist.
    ///
    /// Returns `Some(Pool)` if a pool for the given outcome pair has been
    /// created, or `None` otherwise. Use this to check pool existence before
    /// attempting operations like `add_liquidity` or `swap`, which require an
    /// already-initialized pool.
    pub fn get_pool_safe(env: Env, outcome_a: u32, outcome_b: u32) -> Option<Pool> {
        extend_instance_ttl(&env);
        env.storage()
            .persistent()
            .get(&Self::pool_key(outcome_a, outcome_b))
    }

    /// Get immutable metadata recorded when the pool was initialized.
    pub fn get_pool_metadata(env: Env, outcome_a: u32, outcome_b: u32) -> PoolMetadata {
        extend_instance_ttl(&env);
        env.storage()
            .persistent()
            .get(&Self::pool_metadata_key(outcome_a, outcome_b))
            .unwrap_or_else(|| env.panic_with_error(LiquidityError::PoolNotFound))
    }

    /// Get the LP token balance for a provider in a specific pool.
    pub fn get_lp_position(env: Env, provider: Address, outcome_a: u32, outcome_b: u32) -> i128 {
        extend_instance_ttl(&env);
        let position: LPPosition = env
            .storage()
            .persistent()
            .get(&Self::position_key(provider, outcome_a, outcome_b))
            .unwrap_or(LPPosition { lp_tokens: 0 });
        position.lp_tokens
    }

    /// Calculate the current pool price as reserve_b / reserve_a scaled by 10_000.
    pub fn get_price(env: Env, outcome_a: u32, outcome_b: u32) -> i128 {
        extend_instance_ttl(&env);
        let pool = Self::get_pool(env, outcome_a, outcome_b);
        if pool.reserve_a == 0 {
            return 0;
        }
        (pool.reserve_b * 10_000) / pool.reserve_a
    }

    /// Calculate quote for swapping `amount_in` of `outcome_in` to `outcome_out`.
    /// Returns (amount_out_with_fee, fee).
    pub fn get_amount_out(
        env: Env,
        outcome_in: u32,
        outcome_out: u32,
        amount_in: i128,
    ) -> (i128, i128) {
        extend_instance_ttl(&env);
        if outcome_in == outcome_out {
            env.panic_with_error(LiquidityError::SameOutcome);
        }

        if amount_in <= 0 {
            env.panic_with_error(LiquidityError::InvalidAmount);
        }

        let lo_is_in = outcome_in < outcome_out;
        let (lo, hi) = if lo_is_in {
            (outcome_in, outcome_out)
        } else {
            (outcome_out, outcome_in)
        };

        let pool_key = Self::pool_key(lo, hi);
        let pool: Pool = env
            .storage()
            .persistent()
            .get(&pool_key)
            .unwrap_or_else(|| env.panic_with_error(LiquidityError::PoolNotFound));

        if pool.reserve_a == 0 || pool.reserve_b == 0 {
            env.panic_with_error(LiquidityError::InsufficientReserves);
        }

        let (reserve_in, reserve_out) = if lo_is_in {
            (pool.reserve_a, pool.reserve_b)
        } else {
            (pool.reserve_b, pool.reserve_a)
        };

        Self::calculate_amount_out(amount_in, reserve_in, reserve_out, pool.fee_bps)
    }

    fn calculate_amount_out(
        amount_in: i128,
        reserve_in: i128,
        reserve_out: i128,
        fee_bps: u32,
    ) -> (i128, i128) {
        let amount_out = (amount_in * reserve_out) / (reserve_in + amount_in);
        let fee = (amount_out * fee_bps as i128) / 10_000;
        let amount_out_with_fee = amount_out - fee;
        (amount_out_with_fee, fee)
    }

    fn require_governor(env: &Env, caller: &Address) {
        if caller != &Self::governor(env.clone()) {
            env.panic_with_error(LiquidityError::NotGovernor);
        }
    }

    fn pool_key(outcome_a: u32, outcome_b: u32) -> DataKey {
        let (lo, hi) = if outcome_a <= outcome_b {
            (outcome_a, outcome_b)
        } else {
            (outcome_b, outcome_a)
        };
        DataKey::Pool(lo, hi)
    }

    fn pool_metadata_key(outcome_a: u32, outcome_b: u32) -> DataKey {
        let (lo, hi) = if outcome_a <= outcome_b {
            (outcome_a, outcome_b)
        } else {
            (outcome_b, outcome_a)
        };
        DataKey::PoolMetadata(lo, hi)
    }

    fn position_key(provider: Address, outcome_a: u32, outcome_b: u32) -> DataKey {
        let (lo, hi) = if outcome_a <= outcome_b {
            (outcome_a, outcome_b)
        } else {
            (outcome_b, outcome_a)
        };
        DataKey::Position(provider, lo, hi)
    }

    fn checked_add(env: &Env, lhs: i128, rhs: i128) -> i128 {
        lhs.checked_add(rhs)
            .unwrap_or_else(|| env.panic_with_error(LiquidityError::ArithmeticOverflow))
    }

    fn checked_mul(env: &Env, lhs: i128, rhs: i128) -> i128 {
        lhs.checked_mul(rhs)
            .unwrap_or_else(|| env.panic_with_error(LiquidityError::ArithmeticOverflow))
    }
}

#[cfg(test)]
mod tests;
