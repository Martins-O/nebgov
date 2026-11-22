use soroban_sdk::contracterror;

#[contracterror]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum GuardianCouncilError {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    NotAMember = 3,
    ActionNotFound = 4,
    AlreadyExecuted = 5,
    ThresholdNotMet = 6,
    ActionExpired = 7,
    NotApproved = 8,
    InvalidThreshold = 9,
    InvalidMembers = 10,
    DuplicateMember = 11,
    MemberNotFound = 12,
    NotAuthorized = 13,
}
