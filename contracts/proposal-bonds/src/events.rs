use soroban_sdk::{Address, BytesN, Env, Symbol};

pub const BOND_LOCKED_TOPIC: &str = "BondLocked";
pub const BOND_REFUNDED_TOPIC: &str = "BondRefunded";
pub const BOND_SLASHED_TOPIC: &str = "BondSlashed";
pub const BOND_AMOUNT_UPDATED_TOPIC: &str = "BondAmountUpdated";
pub const SETTINGS_UPDATED_TOPIC: &str = "SettingsUpdated";
pub const ADMIN_UPDATED_TOPIC: &str = "AdminUpdated";

pub fn emit_bond_locked(env: &Env, proposer: &Address, description_hash: &BytesN<32>, amount: i128) {
    env.events().publish(
        (Symbol::new(env, BOND_LOCKED_TOPIC), proposer.clone()),
        (description_hash.clone(), amount),
    );
}

pub fn emit_bond_refunded(env: &Env, description_hash: &BytesN<32>, proposer: &Address, amount: i128) {
    env.events().publish(
        (Symbol::new(env, BOND_REFUNDED_TOPIC), proposer.clone()),
        (description_hash.clone(), amount),
    );
}

pub fn emit_bond_slashed(
    env: &Env,
    description_hash: &BytesN<32>,
    proposer: &Address,
    amount: i128,
    recipient: &Address,
) {
    env.events().publish(
        (Symbol::new(env, BOND_SLASHED_TOPIC), proposer.clone()),
        (description_hash.clone(), amount, recipient.clone()),
    );
}

pub fn emit_bond_amount_updated(env: &Env, admin: &Address, old_amount: i128, new_amount: i128) {
    env.events().publish(
        (Symbol::new(env, BOND_AMOUNT_UPDATED_TOPIC), admin.clone()),
        (old_amount, new_amount),
    );
}

pub fn emit_settings_updated(
    env: &Env,
    admin: &Address,
    bond_token: &Address,
    governor: &Address,
    refund_grace_ledgers: u32,
    max_lock_ledgers: u32,
) {
    env.events().publish(
        (Symbol::new(env, SETTINGS_UPDATED_TOPIC), admin.clone()),
        (
            bond_token.clone(),
            governor.clone(),
            refund_grace_ledgers,
            max_lock_ledgers,
        ),
    );
}

pub fn emit_admin_updated(env: &Env, old_admin: &Address, new_admin: &Address) {
    env.events().publish(
        (Symbol::new(env, ADMIN_UPDATED_TOPIC), old_admin.clone()),
        new_admin.clone(),
    );
}
