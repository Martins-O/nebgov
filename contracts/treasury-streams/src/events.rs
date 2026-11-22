use soroban_sdk::{contracttype, Address, Env, Symbol};

pub const STREAM_CREATED_TOPIC: &str = "StrmCreated";
pub const STREAM_EXECUTED_TOPIC: &str = "StrmExec";
pub const STREAM_PAUSED_TOPIC: &str = "StrmPaused";
pub const STREAM_RESUMED_TOPIC: &str = "StrmResumed";
pub const STREAM_CANCELLED_TOPIC: &str = "StrmCancel";
pub const STREAM_COMPLETED_TOPIC: &str = "StrmCompleted";

#[derive(Clone)]
#[contracttype]
pub struct StreamCreatedEvent {
    pub stream_id: u64,
    pub recipient: Address,
    pub amount_per_interval: i128,
    pub interval_ledgers: u32,
}

#[derive(Clone)]
#[contracttype]
pub struct StreamExecutedEvent {
    pub stream_id: u64,
    pub amount: i128,
    pub executed_at_ledger: u32,
}

#[derive(Clone)]
#[contracttype]
pub struct StreamCancelledEvent {
    pub stream_id: u64,
    pub total_streamed: i128,
}

#[derive(Clone)]
#[contracttype]
pub struct StreamCompletedEvent {
    pub stream_id: u64,
    pub total_streamed: i128,
}

pub fn emit_stream_created(
    env: &Env,
    stream_id: u64,
    recipient: &Address,
    amount_per_interval: i128,
    interval_ledgers: u32,
) {
    env.events().publish(
        (Symbol::new(env, STREAM_CREATED_TOPIC), stream_id),
        StreamCreatedEvent {
            stream_id,
            recipient: recipient.clone(),
            amount_per_interval,
            interval_ledgers,
        },
    );
}

pub fn emit_stream_executed(env: &Env, stream_id: u64, amount: i128, executed_at_ledger: u32) {
    env.events().publish(
        (Symbol::new(env, STREAM_EXECUTED_TOPIC), stream_id),
        StreamExecutedEvent {
            stream_id,
            amount,
            executed_at_ledger,
        },
    );
}

pub fn emit_stream_paused(env: &Env, stream_id: u64) {
    env.events()
        .publish((Symbol::new(env, STREAM_PAUSED_TOPIC), stream_id), ());
}

pub fn emit_stream_resumed(env: &Env, stream_id: u64) {
    env.events()
        .publish((Symbol::new(env, STREAM_RESUMED_TOPIC), stream_id), ());
}

pub fn emit_stream_cancelled(env: &Env, stream_id: u64, total_streamed: i128) {
    env.events().publish(
        (Symbol::new(env, STREAM_CANCELLED_TOPIC), stream_id),
        StreamCancelledEvent {
            stream_id,
            total_streamed,
        },
    );
}

pub fn emit_stream_completed(env: &Env, stream_id: u64, total_streamed: i128) {
    env.events().publish(
        (Symbol::new(env, STREAM_COMPLETED_TOPIC), stream_id),
        StreamCompletedEvent {
            stream_id,
            total_streamed,
        },
    );
}
