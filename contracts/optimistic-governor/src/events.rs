use soroban_sdk::{Address, Env, Symbol};

pub fn emit_proposal_created(env: &Env, id: u64, proposer: &Address, challenge_end_ledger: u32) {
    env.events().publish(
        (Symbol::new(env, "ProposalCreated"), id),
        (proposer.clone(), challenge_end_ledger),
    );
}

pub fn emit_objection_cast(
    env: &Env,
    proposal_id: u64,
    objector: &Address,
    weight: i128,
    running_total: i128,
) {
    env.events().publish(
        (Symbol::new(env, "ObjectionCast"), proposal_id),
        (objector.clone(), weight, running_total),
    );
}

pub fn emit_proposal_objected(env: &Env, proposal_id: u64) {
    env.events()
        .publish((Symbol::new(env, "ProposalObjected"), proposal_id), ());
}

pub fn emit_proposal_passed(env: &Env, proposal_id: u64) {
    env.events()
        .publish((Symbol::new(env, "ProposalPassed"), proposal_id), ());
}

pub fn emit_proposal_executed(env: &Env, proposal_id: u64) {
    env.events()
        .publish((Symbol::new(env, "ProposalExecuted"), proposal_id), ());
}

pub fn emit_proposal_cancelled(env: &Env, proposal_id: u64, caller: &Address) {
    env.events().publish(
        (Symbol::new(env, "ProposalCancelled"), proposal_id),
        caller.clone(),
    );
}

pub fn emit_proposal_expired(env: &Env, proposal_id: u64) {
    env.events()
        .publish((Symbol::new(env, "ProposalExpired"), proposal_id), ());
}

pub fn emit_config_updated(
    env: &Env,
    challenge_window_ledgers: u32,
    objection_threshold_bps: u32,
    execution_window_ledgers: u32,
) {
    env.events().publish(
        (Symbol::new(env, "ConfigUpdated"),),
        (
            challenge_window_ledgers,
            objection_threshold_bps,
            execution_window_ledgers,
        ),
    );
}

pub fn emit_bond_config_updated(env: &Env, amount: i128, token: &Address) {
    env.events().publish(
        (Symbol::new(env, "BondConfigUpdated"),),
        (amount, token.clone()),
    );
}

pub fn emit_admin_updated(env: &Env, old_admin: &Address, new_admin: &Address) {
    env.events().publish(
        (Symbol::new(env, "AdminUpdated"),),
        (old_admin.clone(), new_admin.clone()),
    );
}

pub fn emit_bond_released(env: &Env, proposal_id: u64, proposer: &Address, amount: i128) {
    env.events().publish(
        (Symbol::new(env, "BondReleased"), proposal_id),
        (proposer.clone(), amount),
    );
}

pub fn emit_bond_slashed(env: &Env, proposal_id: u64, recipient: &Address, amount: i128) {
    env.events().publish(
        (Symbol::new(env, "BondSlashed"), proposal_id),
        (recipient.clone(), amount),
    );
}
