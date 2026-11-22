#![no_std]

mod error;
mod events;

pub use error::OptimisticGovernorError;

use soroban_sdk::{
    contract, contractclient, contractimpl, contracttype, token, xdr::FromXdr, Address, Bytes,
    BytesN, Env, Symbol, Val, Vec,
};

const BPS: i128 = 10_000;

/// A locked proposal/bond/objection record must outlive the full
/// challenge-window lifecycle plus a generous safety margin, so its TTL is
/// bumped by a large fixed buffer rather than trying to read the configured
/// `ChallengeWindowLedgers` at every storage write site.
const RECORD_TTL_LEDGERS: u32 = 1_000_000;

/// Reads voting power from `contracts/token-votes` read-only, identically to
/// how `contracts/conviction-voting` wires the same dependency — this trait
/// is intentionally re-declared locally (not shared via a crate dependency)
/// to match that precedent.
#[contractclient(name = "VotesClient")]
pub trait VotesTrait {
    fn get_past_votes(env: Env, account: Address, ledger: u32) -> i128;
    fn get_past_total_supply(env: Env, ledger: u32) -> i128;
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum OptimisticProposalState {
    ChallengeWindow,
    Objected,
    Passed,
    Executed,
    Cancelled,
    Expired,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct OptimisticProposal {
    pub id: u64,
    pub proposer: Address,
    pub target: Address,
    pub fn_name: Symbol,
    pub calldata: Bytes,
    pub description_hash: BytesN<32>,
    pub created_ledger: u32,
    pub challenge_end_ledger: u32,
    pub objection_votes: i128,
    pub state: OptimisticProposalState,
}

/// Read-only settings snapshot — lets callers (e.g. the frontend) render an
/// objection-weight progress bar or work out the current challenge window
/// without guessing, mirroring `contracts/proposal-bonds`'s `get_settings`.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct OptimisticGovernorConfig {
    pub votes_token: Address,
    pub challenge_window_ledgers: u32,
    pub objection_threshold_bps: u32,
    pub proposer_bond_amount: i128,
    pub proposer_bond_token: Address,
    pub execution_window_ledgers: u32,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    VotesToken,
    NextProposalId,
    Proposal(u64),
    ObjectorVoted(u64, Address),
    ChallengeWindowLedgers,
    ObjectionThresholdBps,
    ProposerBondAmount,
    ProposerBondToken,
    ExecutionWindowLedgers,
    Bond(u64),
    BondToken(u64),
}

#[contract]
pub struct OptimisticGovernorContract;

#[contractimpl]
impl OptimisticGovernorContract {
    /// Configure the optimistic governance track. May only be called once.
    /// `proposer_bond_amount` of `0` disables the anti-spam bond entirely.
    pub fn initialize(
        env: Env,
        admin: Address,
        votes_token: Address,
        challenge_window_ledgers: u32,
        objection_threshold_bps: u32,
        proposer_bond_amount: i128,
        proposer_bond_token: Address,
        execution_window_ledgers: u32,
    ) {
        admin.require_auth();
        if env.storage().instance().has(&DataKey::Admin) {
            env.panic_with_error(OptimisticGovernorError::AlreadyInitialized);
        }
        if challenge_window_ledgers == 0
            || objection_threshold_bps == 0
            || objection_threshold_bps > BPS as u32
            || proposer_bond_amount < 0
            || execution_window_ledgers == 0
        {
            env.panic_with_error(OptimisticGovernorError::InvalidConfiguration);
        }
        let storage = env.storage().instance();
        storage.set(&DataKey::Admin, &admin);
        storage.set(&DataKey::VotesToken, &votes_token);
        storage.set(&DataKey::NextProposalId, &1u64);
        storage.set(&DataKey::ChallengeWindowLedgers, &challenge_window_ledgers);
        storage.set(&DataKey::ObjectionThresholdBps, &objection_threshold_bps);
        storage.set(&DataKey::ProposerBondAmount, &proposer_bond_amount);
        storage.set(&DataKey::ProposerBondToken, &proposer_bond_token);
        storage.set(&DataKey::ExecutionWindowLedgers, &execution_window_ledgers);
    }

    /// Schedule a proposal for execution by default; it only fails if
    /// enough token holders object within the challenge window.
    pub fn propose(
        env: Env,
        proposer: Address,
        target: Address,
        fn_name: Symbol,
        calldata: Bytes,
        description_hash: BytesN<32>,
    ) -> u64 {
        proposer.require_auth();
        Self::require_initialized(&env);
        if !calldata.is_empty() && Vec::<Val>::from_xdr(&env, &calldata).is_err() {
            env.panic_with_error(OptimisticGovernorError::InvalidCalldata);
        }

        let id: u64 = env
            .storage()
            .instance()
            .get(&DataKey::NextProposalId)
            .unwrap_or_else(|| env.panic_with_error(OptimisticGovernorError::NotInitialized));
        let next = id
            .checked_add(1)
            .unwrap_or_else(|| env.panic_with_error(OptimisticGovernorError::ArithmeticOverflow));
        env.storage()
            .instance()
            .set(&DataKey::NextProposalId, &next);

        let bond_amount: i128 = env
            .storage()
            .instance()
            .get(&DataKey::ProposerBondAmount)
            .unwrap_or_else(|| env.panic_with_error(OptimisticGovernorError::NotInitialized));
        if bond_amount > 0 {
            let bond_token: Address = env
                .storage()
                .instance()
                .get(&DataKey::ProposerBondToken)
                .unwrap_or_else(|| env.panic_with_error(OptimisticGovernorError::NotInitialized));
            token::TokenClient::new(&env, &bond_token).transfer(
                &proposer,
                &env.current_contract_address(),
                &bond_amount,
            );
            env.storage()
                .persistent()
                .set(&DataKey::Bond(id), &bond_amount);
            env.storage()
                .persistent()
                .set(&DataKey::BondToken(id), &bond_token);
            env.storage().persistent().extend_ttl(
                &DataKey::Bond(id),
                RECORD_TTL_LEDGERS,
                RECORD_TTL_LEDGERS,
            );
            env.storage().persistent().extend_ttl(
                &DataKey::BondToken(id),
                RECORD_TTL_LEDGERS,
                RECORD_TTL_LEDGERS,
            );
        }

        let created_ledger = env.ledger().sequence();
        let challenge_window_ledgers: u32 = env
            .storage()
            .instance()
            .get(&DataKey::ChallengeWindowLedgers)
            .unwrap_or_else(|| env.panic_with_error(OptimisticGovernorError::NotInitialized));
        let challenge_end_ledger = created_ledger
            .checked_add(challenge_window_ledgers)
            .unwrap_or_else(|| env.panic_with_error(OptimisticGovernorError::ArithmeticOverflow));

        let proposal = OptimisticProposal {
            id,
            proposer: proposer.clone(),
            target,
            fn_name,
            calldata,
            description_hash,
            created_ledger,
            challenge_end_ledger,
            objection_votes: 0,
            state: OptimisticProposalState::ChallengeWindow,
        };
        Self::save_proposal(&env, &proposal);

        events::emit_proposal_created(&env, id, &proposer, challenge_end_ledger);
        id
    }

    /// Cast an objection against a proposal still in its challenge window,
    /// weighted by the objector's voting power at the proposal's
    /// `created_ledger` (not current balance, to prevent last-minute
    /// flash-acquired tokens from objecting). Immediately freezes the
    /// proposal the moment the running objection total crosses the
    /// configured threshold.
    pub fn object(env: Env, objector: Address, proposal_id: u64) {
        objector.require_auth();
        let mut proposal = Self::must_get_proposal(&env, proposal_id);
        if proposal.state != OptimisticProposalState::ChallengeWindow {
            env.panic_with_error(OptimisticGovernorError::NotInChallengeWindow);
        }
        if env.ledger().sequence() >= proposal.challenge_end_ledger {
            env.panic_with_error(OptimisticGovernorError::ChallengeWindowElapsed);
        }

        let voted_key = DataKey::ObjectorVoted(proposal_id, objector.clone());
        if env.storage().persistent().has(&voted_key) {
            env.panic_with_error(OptimisticGovernorError::AlreadyObjected);
        }

        let weight = Self::votes_client(&env).get_past_votes(&objector, &proposal.created_ledger);
        if weight <= 0 {
            env.panic_with_error(OptimisticGovernorError::NoVotingPower);
        }

        env.storage().persistent().set(&voted_key, &true);
        env.storage()
            .persistent()
            .extend_ttl(&voted_key, RECORD_TTL_LEDGERS, RECORD_TTL_LEDGERS);

        let running_total = proposal
            .objection_votes
            .checked_add(weight)
            .unwrap_or_else(|| env.panic_with_error(OptimisticGovernorError::ArithmeticOverflow));
        proposal.objection_votes = running_total;
        events::emit_objection_cast(&env, proposal_id, &objector, weight, running_total);

        let threshold_bps: u32 = env
            .storage()
            .instance()
            .get(&DataKey::ObjectionThresholdBps)
            .unwrap_or_else(|| env.panic_with_error(OptimisticGovernorError::NotInitialized));
        let total_supply = Self::votes_client(&env).get_past_total_supply(&proposal.created_ledger);
        let crossed = total_supply > 0
            && running_total
                .checked_mul(BPS)
                .and_then(|v| v.checked_div(total_supply))
                .map(|ratio| ratio >= threshold_bps as i128)
                .unwrap_or_else(|| {
                    env.panic_with_error(OptimisticGovernorError::ArithmeticOverflow)
                });

        if crossed {
            proposal.state = OptimisticProposalState::Objected;
            Self::save_proposal(&env, &proposal);
            events::emit_proposal_objected(&env, proposal_id);
        } else {
            Self::save_proposal(&env, &proposal);
        }
    }

    /// Permissionless: transitions a `ChallengeWindow` proposal to `Passed`
    /// once its window has elapsed unobjected. (The `Objected` transition
    /// itself already happens instantly inside `object()` the moment the
    /// threshold is crossed, so a proposal still in `ChallengeWindow` here
    /// is, by construction, one that was never objected enough to freeze.)
    /// Refunds any locked proposer bond on the `Passed` transition, which
    /// covers the later `Executed` state too since every execution passes
    /// through `Passed` first.
    pub fn finalize(env: Env, proposal_id: u64) {
        let mut proposal = Self::must_get_proposal(&env, proposal_id);
        if proposal.state != OptimisticProposalState::ChallengeWindow {
            env.panic_with_error(OptimisticGovernorError::ProposalAlreadyFinalized);
        }
        if env.ledger().sequence() < proposal.challenge_end_ledger {
            env.panic_with_error(OptimisticGovernorError::ChallengeWindowNotElapsed);
        }
        proposal.state = OptimisticProposalState::Passed;
        Self::save_proposal(&env, &proposal);
        Self::pay_out_bond(&env, proposal_id, &proposal.proposer);
        events::emit_proposal_passed(&env, proposal_id);
    }

    /// Permissionless, like `finalize`: invoke the proposal's target once it
    /// has cleared its challenge window unobjected. Anyone may trigger this
    /// once a proposal is `Passed`; there is no meaningful caller identity to
    /// gate on since the target invocation runs with the contract's own
    /// authority, not the caller's. Must be executed within the execution
    /// window, or the proposal expires.
    pub fn execute(env: Env, proposal_id: u64) {
        let mut proposal = Self::must_get_proposal(&env, proposal_id);
        if proposal.state != OptimisticProposalState::Passed {
            env.panic_with_error(OptimisticGovernorError::ProposalNotPassed);
        }

        let execution_window_ledgers: u32 = env
            .storage()
            .instance()
            .get(&DataKey::ExecutionWindowLedgers)
            .unwrap_or_else(|| env.panic_with_error(OptimisticGovernorError::NotInitialized));
        let expiration_ledger = proposal
            .challenge_end_ledger
            .checked_add(execution_window_ledgers)
            .unwrap_or_else(|| env.panic_with_error(OptimisticGovernorError::ArithmeticOverflow));
        if env.ledger().sequence() >= expiration_ledger {
            proposal.state = OptimisticProposalState::Expired;
            Self::save_proposal(&env, &proposal);
            events::emit_proposal_expired(&env, proposal_id);
            env.panic_with_error(OptimisticGovernorError::ProposalExpired);
        }

        proposal.state = OptimisticProposalState::Executed;
        Self::save_proposal(&env, &proposal);

        let args = if proposal.calldata.is_empty() {
            Vec::<Val>::new(&env)
        } else {
            Vec::<Val>::from_xdr(&env, &proposal.calldata)
                .unwrap_or_else(|_| env.panic_with_error(OptimisticGovernorError::InvalidCalldata))
        };
        env.invoke_contract::<Val>(&proposal.target, &proposal.fn_name, args);
        events::emit_proposal_executed(&env, proposal_id);
    }

    /// The proposer may withdraw their own proposal any time before it has
    /// passed, including while it is frozen in `Objected` (for example to
    /// re-propose after addressing the objection).
    ///
    /// The bond follows the state the proposal is cancelled from:
    /// - from `ChallengeWindow`, nobody has successfully objected yet, so the
    ///   bond is refunded as a voluntary withdrawal;
    /// - from `Objected`, the bond stays locked. Cancelling does not get an
    ///   objected proposer their bond back, or the anti-spam bond would cost
    ///   nothing. Governance decides its fate with `release_bond` or
    ///   `slash_bond`.
    pub fn cancel(env: Env, caller: Address, proposal_id: u64) {
        caller.require_auth();
        let mut proposal = Self::must_get_proposal(&env, proposal_id);
        if caller != proposal.proposer {
            env.panic_with_error(OptimisticGovernorError::Unauthorized);
        }
        if !matches!(
            proposal.state,
            OptimisticProposalState::ChallengeWindow | OptimisticProposalState::Objected
        ) {
            env.panic_with_error(OptimisticGovernorError::ProposalNotCancellable);
        }
        let was_objected = proposal.state == OptimisticProposalState::Objected;
        proposal.state = OptimisticProposalState::Cancelled;
        Self::save_proposal(&env, &proposal);
        if !was_objected {
            Self::pay_out_bond(&env, proposal_id, &proposal.proposer);
        }
        events::emit_proposal_cancelled(&env, proposal_id, &caller);
    }

    /// Admin-only (the admin is expected to be governance, e.g. the governor
    /// or timelock): return an objected proposal's locked bond to its
    /// proposer, for an objection the community judges was not about spam.
    ///
    /// Only callable once the proposal is `Objected`, or `Cancelled` after
    /// being objected. A bond is never at risk before an objection.
    pub fn release_bond(env: Env, admin: Address, proposal_id: u64) {
        Self::require_admin(&env, &admin);
        let proposal = Self::must_get_settleable_bond(&env, proposal_id);
        let amount = Self::pay_out_bond(&env, proposal_id, &proposal.proposer);
        events::emit_bond_released(&env, proposal_id, &proposal.proposer, amount);
    }

    /// Admin-only (the admin is expected to be governance, e.g. the governor
    /// or timelock): send an objected proposal's locked bond to `recipient`
    /// instead of the proposer, mirroring `contracts/proposal-bonds::slash`.
    ///
    /// Only callable once the proposal is `Objected`, or `Cancelled` after
    /// being objected. A bond is never at risk before an objection.
    pub fn slash_bond(env: Env, admin: Address, proposal_id: u64, recipient: Address) {
        Self::require_admin(&env, &admin);
        Self::must_get_settleable_bond(&env, proposal_id);
        let amount = Self::pay_out_bond(&env, proposal_id, &recipient);
        events::emit_bond_slashed(&env, proposal_id, &recipient, amount);
    }

    pub fn get_proposal(env: Env, proposal_id: u64) -> OptimisticProposal {
        Self::must_get_proposal(&env, proposal_id)
    }

    pub fn get_config(env: Env) -> OptimisticGovernorConfig {
        Self::require_initialized(&env);
        let storage = env.storage().instance();
        OptimisticGovernorConfig {
            votes_token: storage
                .get(&DataKey::VotesToken)
                .unwrap_or_else(|| env.panic_with_error(OptimisticGovernorError::NotInitialized)),
            challenge_window_ledgers: storage
                .get(&DataKey::ChallengeWindowLedgers)
                .unwrap_or_else(|| env.panic_with_error(OptimisticGovernorError::NotInitialized)),
            objection_threshold_bps: storage
                .get(&DataKey::ObjectionThresholdBps)
                .unwrap_or_else(|| env.panic_with_error(OptimisticGovernorError::NotInitialized)),
            proposer_bond_amount: storage
                .get(&DataKey::ProposerBondAmount)
                .unwrap_or_else(|| env.panic_with_error(OptimisticGovernorError::NotInitialized)),
            proposer_bond_token: storage
                .get(&DataKey::ProposerBondToken)
                .unwrap_or_else(|| env.panic_with_error(OptimisticGovernorError::NotInitialized)),
            execution_window_ledgers: storage
                .get(&DataKey::ExecutionWindowLedgers)
                .unwrap_or_else(|| env.panic_with_error(OptimisticGovernorError::NotInitialized)),
        }
    }

    /// Admin-only tuning of the challenge window, objection threshold, and
    /// execution window for future proposals; does not retroactively affect
    /// proposals already in flight.
    pub fn update_config(
        env: Env,
        admin: Address,
        challenge_window_ledgers: u32,
        objection_threshold_bps: u32,
        execution_window_ledgers: u32,
    ) {
        let stored_admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .unwrap_or_else(|| env.panic_with_error(OptimisticGovernorError::NotInitialized));
        admin.require_auth();
        if admin != stored_admin {
            env.panic_with_error(OptimisticGovernorError::Unauthorized);
        }
        if challenge_window_ledgers == 0
            || objection_threshold_bps == 0
            || objection_threshold_bps > BPS as u32
            || execution_window_ledgers == 0
        {
            env.panic_with_error(OptimisticGovernorError::InvalidConfiguration);
        }
        let storage = env.storage().instance();
        storage.set(&DataKey::ChallengeWindowLedgers, &challenge_window_ledgers);
        storage.set(&DataKey::ObjectionThresholdBps, &objection_threshold_bps);
        storage.set(&DataKey::ExecutionWindowLedgers, &execution_window_ledgers);
        events::emit_config_updated(
            &env,
            challenge_window_ledgers,
            objection_threshold_bps,
            execution_window_ledgers,
        );
    }

    /// Admin-only bond settings for future proposals. Existing bonds retain
    /// the token and amount captured when they were locked.
    pub fn update_bond_config(env: Env, admin: Address, amount: i128, token: Address) {
        Self::require_admin(&env, &admin);
        if amount < 0 {
            env.panic_with_error(OptimisticGovernorError::InvalidConfiguration);
        }
        let storage = env.storage().instance();
        storage.set(&DataKey::ProposerBondAmount, &amount);
        storage.set(&DataKey::ProposerBondToken, &token);
        events::emit_bond_config_updated(&env, amount, &token);
    }

    pub fn set_admin(env: Env, admin: Address, new_admin: Address) {
        Self::require_admin(&env, &admin);
        env.storage().instance().set(&DataKey::Admin, &new_admin);
        events::emit_admin_updated(&env, &admin, &new_admin);
    }

    fn require_initialized(env: &Env) {
        if !env.storage().instance().has(&DataKey::Admin) {
            env.panic_with_error(OptimisticGovernorError::NotInitialized);
        }
    }

    fn require_admin(env: &Env, admin: &Address) {
        let stored: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .unwrap_or_else(|| env.panic_with_error(OptimisticGovernorError::NotInitialized));
        admin.require_auth();
        if admin != &stored {
            env.panic_with_error(OptimisticGovernorError::Unauthorized);
        }
    }

    fn votes_client(env: &Env) -> VotesClient<'_> {
        let address: Address = env
            .storage()
            .instance()
            .get(&DataKey::VotesToken)
            .unwrap_or_else(|| env.panic_with_error(OptimisticGovernorError::NotInitialized));
        VotesClient::new(env, &address)
    }

    fn must_get_proposal(env: &Env, id: u64) -> OptimisticProposal {
        env.storage()
            .persistent()
            .get(&DataKey::Proposal(id))
            .unwrap_or_else(|| env.panic_with_error(OptimisticGovernorError::ProposalNotFound))
    }

    fn save_proposal(env: &Env, proposal: &OptimisticProposal) {
        env.storage()
            .persistent()
            .set(&DataKey::Proposal(proposal.id), proposal);
        env.storage().persistent().extend_ttl(
            &DataKey::Proposal(proposal.id),
            RECORD_TTL_LEDGERS,
            RECORD_TTL_LEDGERS,
        );
    }

    /// The proposal behind a bond that may be released or slashed: one that
    /// still holds a bond and was objected. Every path out of
    /// `ChallengeWindow` other than an objection (`finalize`, or `cancel`
    /// before any objection) refunds the bond, so a `Cancelled` proposal that
    /// still holds one was cancelled while `Objected`.
    fn must_get_settleable_bond(env: &Env, proposal_id: u64) -> OptimisticProposal {
        let proposal = Self::must_get_proposal(env, proposal_id);
        if !env.storage().persistent().has(&DataKey::Bond(proposal_id)) {
            env.panic_with_error(OptimisticGovernorError::BondNotFound);
        }
        if !matches!(
            proposal.state,
            OptimisticProposalState::Objected | OptimisticProposalState::Cancelled
        ) {
            env.panic_with_error(OptimisticGovernorError::BondNotSettleable);
        }
        proposal
    }

    /// Transfer a proposal's locked bond, if any, to `to` in the token it was
    /// locked in, and clear it. Returns the amount paid (0 if none was held).
    fn pay_out_bond(env: &Env, proposal_id: u64, to: &Address) -> i128 {
        let key = DataKey::Bond(proposal_id);
        let Some(amount) = env.storage().persistent().get::<_, i128>(&key) else {
            return 0;
        };
        let token_address = env
            .storage()
            .persistent()
            .get(&DataKey::BondToken(proposal_id))
            .unwrap_or_else(|| {
                env.storage()
                    .instance()
                    .get(&DataKey::ProposerBondToken)
                    .unwrap_or_else(|| {
                        env.panic_with_error(OptimisticGovernorError::NotInitialized)
                    })
            });
        // Clear the bond before the transfer, so a re-entrant token
        // contract cannot pay the same bond out twice.
        env.storage().persistent().remove(&key);
        env.storage()
            .persistent()
            .remove(&DataKey::BondToken(proposal_id));
        token::TokenClient::new(env, &token_address).transfer(
            &env.current_contract_address(),
            to,
            &amount,
        );
        amount
    }
}

#[cfg(test)]
mod tests;
