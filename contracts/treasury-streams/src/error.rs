use soroban_sdk::contracterror;

#[contracterror]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum TreasuryStreamsError {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    NotAuthorized = 3,
    InvalidAmount = 4,
    InvalidInterval = 5,
    InvalidSchedule = 6,
    StreamNotFound = 7,
    StreamCancelled = 8,
    StreamPaused = 9,
    AlreadyPaused = 10,
    NotPaused = 11,
    StreamNotDue = 12,
    InsufficientBalance = 13,
    ArithmeticOverflow = 14,
    /// The stream has paid its last whole interval and is finished.
    StreamCompleted = 15,
}
