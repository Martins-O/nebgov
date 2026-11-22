# Voting Rewards

## Overview

The voting-rewards contract incentivizes voter participation by distributing rewards to addresses that cast votes during governance epochs. This contract works in conjunction with the governor contract to track voting activity and distribute tokens proportionally to voting power exercised.

## Problem Statement

Governance protocols often face the challenge of low voter turnout. The voting-rewards contract addresses this by creating an economic incentive for participation: voters who cast votes during an epoch receive a share of the epoch's reward pool, proportional to their voting power.

## Architecture

### Epoch-Based Model

Voting rewards are organized into fixed-duration epochs:

- **Epoch Duration**: Configurable number of ledgers per epoch (set during initialization)
- **Epoch ID**: Incrementing counter starting from 0
- **Epoch Lifecycle**:
  1. **Open**: A new epoch begins and runs for the specified duration
  2. **Ended**: The epoch's end ledger has passed
  3. **Finalized**: A Merkle root of eligible voters is published with a reward allocation
  4. **Claimed**: Voters claim their individual rewards

### Merkle-Based Claims

Instead of computing eligibility on-chain, voting rewards uses a Merkle tree approach:

1. **Off-chain Computation**: The backend analyzes the governor's `votes` table and computes an `(address, amount)` set
2. **Root Publication**: A governance-authorized administrator publishes a Merkle root and total reward amount for an epoch
3. **Individual Claims**: Each voter proves their eligibility with a Merkle proof and claims their reward

This approach keeps the voting-rewards contract small and avoids expensive on-chain iteration over unbounded voter lists.

Leaves are hashed as `sha256(0x00 || claimant_xdr || epoch_id_le || amount_le)` and internal nodes as `sha256(0x01 || min(child_a, child_b) || max(child_a, child_b))`. This domain-separated encoding replaces the original scheme. Coordinate the contract and backend rollout at an epoch boundary, and do not upgrade while any rewards published with the old encoding still have outstanding claims: those existing roots cannot verify against the new leaf encoding. Resolve them by allowing claims to complete or sweeping the remaining allocation before activation.

## Core Concepts

### Admin Authority

The `Admin` is authorized to:
- Publish epoch roots with reward allocations
- Propose a new admin address; the current admin remains active until the proposal is accepted
- Update epoch duration (applies to next epoch onward)

The admin address is typically the governor contract itself, making root publication a governance action.

Admin rotation is a two-step transfer: the current admin calls `propose_admin(admin, new_admin)`, then the proposed address calls `accept_admin(new_admin)` with its own authorization. Until acceptance, `get_admin` continues to return the current admin and publishing authorization is unchanged. `get_pending_admin` reports the proposed address, if any. A subsequent proposal replaces the pending address.

### Reward Pool

Rewards are funded by transferring tokens to the contract address. The available pool is calculated as:

```
available_pool = token_balance - allocated_to_epochs
```

The `allocated_to_epochs` counter prevents double-committing rewards to multiple epochs.

### Epochs and Finalization

Each epoch tracks:
- `start_ledger`, `end_ledger`: The ledger range for the epoch
- `merkle_root`: The root of the voter rewards tree (only set after finalization)
- `total_reward_amount`: The amount allocated to this epoch's rewards
- `claimed_amount`: The sum of claims processed so far
- `finalized`: Whether the root has been published and the epoch is locked

## API Reference

### Initialization

```rust
pub fn initialize(
    env: Env,
    admin: Address,
    reward_token: Address,
    epoch_duration_ledgers: u32
)
```

Initialize the contract with an admin address, reward token, and epoch duration. This function is called once to set up the contract and open epoch 0.

**Parameters:**
- `admin`: The address authorized to publish epoch roots
- `reward_token`: The SEP-41 token used for rewards
- `epoch_duration_ledgers`: The number of ledgers per epoch (must be > 0)

---

### Epoch Management

#### `start_next_epoch(env: Env)`

Permissionlessly advance to the next epoch. The current epoch's `end_ledger` must have passed.

The new epoch starts at the previous epoch's `end_ledger`, ensuring no ledger range is skipped.

---

#### `publish_epoch_root(env: Env, admin: Address, epoch_id: u64, merkle_root: BytesN<32>, total_reward_amount: i128)`

Publish the Merkle root and reward allocation for an ended epoch.

**Requirements:**
- Caller must be the authorized admin
- Epoch must have ended (current ledger >= epoch's `end_ledger`)
- Epoch must not be finalized already
- `total_reward_amount` must not exceed the available pool

**Effect:**
- Locks the epoch's merkle_root and marks the epoch finalized, including when `total_reward_amount` is `0` (an epoch
  with no voters is still final, so its root can't be replaced)
- Allocates `total_reward_amount` from the pool
- Emits `EpochRootPublished` event

---

### Rewards and Claims

#### `fund_pool(env: Env, funder: Address, amount: i128)`

Transfer reward tokens into the contract's pool. This is a convenience wrapper around direct token transfers that ensures funding is tracked in events and the indexer.

**Parameters:**
- `funder`: The address funding the pool
- `amount`: The amount to transfer (must be > 0)

---

#### `claim(env: Env, claimant: Address, epoch_id: u64, amount: i128, proof: Vec<BytesN<32>>)`

Claim voting rewards for an epoch using a Merkle proof.

**Requirements:**
- Epoch must be finalized
- Claimant must not have claimed from this epoch before
- Proof must be valid (proves membership of `sha256(0x00 || claimant_xdr || epoch_id_le || amount_le)` in the epoch's tree)
- `new_claimed_amount` must not exceed `epoch.total_reward_amount`

**Effect:**
- Marks the claimant as having claimed
- Transfers reward tokens from contract to claimant
- Emits `RewardClaimed` event

---

### Queries

#### `get_epoch(env: Env, epoch_id: u64) -> Option<Epoch>`

Retrieve an epoch's full state (ledger range, root, allocations, claim status).

---

#### `get_current_epoch_id(env: Env) -> u64`

Get the ID of the currently-active epoch.

---

#### `get_admin(env: Env) -> Address`

Get the current admin address. Useful for off-chain code determining whether it can submit roots directly or must package calls as governance proposals.

---

#### `get_pending_admin(env: Env) -> Option<Address>`

Get the proposed admin address during a two-step admin transfer, or `None` when no transfer is pending.

---

#### `get_available_pool(env: Env) -> i128`

Get the amount of unallocated rewards currently available for new epochs.

---

#### `has_claimed(env: Env, epoch_id: u64, claimant: Address) -> bool`

Check whether a claimant has already claimed from an epoch.

---

## Events

All state changes emit events for indexing and monitoring:

- **EpochStarted**: A new epoch begins
- **EpochRootPublished**: A root is published with reward allocation
- **RewardClaimed**: A claimant receives their reward
- **PoolFunded**: Reward tokens are transferred in
- **AdminProposed**: The current admin proposes a new admin
- **AdminAccepted**: The proposed admin accepts the transfer

## Deployment and Configuration

### Stellar Testnet

1. Deploy the voting-rewards contract
2. Deploy or identify the governor contract
3. Call `initialize` with:
   - `admin`: Governor contract address (or a temporary multisig during setup)
   - `reward_token`: A governance token contract address
   - `epoch_duration_ledgers`: Suggested value: ~1000 ledgers (~80 minutes at 5s/block)

### Funding

- Transfer reward tokens to the contract address to increase the available pool
- Use `fund_pool` to fund with an attributed funder address (tracked in events)

### Admin Rotation

If the governor is upgraded or redeployed, call `propose_admin` with the current admin and new governor address, then execute `accept_admin` as the new governor so it becomes active. This is typically carried out through governance. The new governor must be able to authorize the acceptance call.

## Technical Details

### TTL Management

Epoch records and claim markers are persisted with a maximum TTL of ~180 days. All writes extend the TTL to ensure voting records survive a full epoch lifecycle: end → backend computation → root publication → voter claims.

### Prevention of Double-Claiming

A claim marker is written to persistent storage before transferring tokens. This prevents reentrancy attacks via malicious token contracts.

### Rounding and Arithmetic

Off-chain reward computation may leave a small amount (a few stroops) unallocated due to rounding. The contract allows claims up to the exact `total_reward_amount` to prevent dust accumulation.

## Security Considerations

- **Admin Authority**: Only the admin can publish roots. Ensure the admin address is correct before governance operations.
- **Pool Overflow**: Never allocate more than the available pool to an epoch.
- **Immutable Roots**: Once published, an epoch's root cannot be changed. Verify off-chain eligibility before publishing.
- **Token Safety**: The contract assumes the reward token is a standard SEP-41 token. Ensure the token is trusted before deployment.

See [docs/security.md](./security.md) for additional security analysis.

## Example Workflow

1. **Setup**: Deploy voting-rewards with governor as admin, USDC as reward token, 1000 ledgers per epoch
2. **Fund**: Transfer 10,000 USDC to the contract
3. **Epoch 0 Runs**: Addresses cast votes during ledgers 0–999
4. **Epoch 1 Starts**: After ledger 1000, call `start_next_epoch`
5. **Eligibility Computed**: Backend analyzes Epoch 0 votes and produces a Merkle root
6. **Root Published**: Governor proposes and executes a transaction calling `publish_epoch_root` with the root and 5,000 USDC allocation
7. **Claims**: Voters query the backend for their proof and call `claim` to receive their share
8. **Repeat**: Epochs continue rolling, new roots published, new claims processed

## See Also

- [docs/architecture.md](./architecture.md) — NebGov architecture and component relationships
- [docs/deployment.md](./deployment.md) — Production deployment walkthrough
- [docs/security.md](./security.md) — Security considerations and audits
