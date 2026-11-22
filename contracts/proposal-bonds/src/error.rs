use soroban_sdk::contracterror;

#[contracterror]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum ProposalBondsError {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    BondAlreadyLocked = 3,
    BondNotFound = 4,
    BondNotLocked = 5,
    DescriptionHashMismatch = 6,
    ProposalNotTerminal = 7,
    RefundGraceNotElapsed = 8,
    NotAuthorized = 9,
    InvalidBondAmount = 10,
    /// `max_lock_ledgers` is zero, not longer than `refund_grace_ledgers`,
    /// or longer than the bond entry's TTL bump (`BOND_TTL_LEDGERS`).
    InvalidLockWindow = 11,
}
