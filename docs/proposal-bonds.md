# Proposal Bonds

## Overview

The **Proposal Bonds** feature (`contracts/proposal-bonds`) enables governance systems to require proposers to post refundable bonds before creating proposals. This mechanism:

- **Prevents spam** by increasing the cost for low-quality proposals
- **Aligns incentives** by penalizing malicious or frivolous governance participation
- **Refunds participation** by returning bonds when proposals succeed or are fairly rejected
- **Supports slashing** by allowing the DAO to slash (confiscate) bonds in response to proposal violations

## How It Works

### Proposal Lifecycle with Bonds

```
Proposer posts bond → Proposal created → Voting occurs → Execution or cancellation
                          ↓
                    Governance decides
                    ↓
              Bond refunded or slashed
```

### Key Concepts

**Bond Amount**: The required amount of governance tokens (or other approved collateral) that a proposer must lock before creating a proposal. This is configurable per governance instance.

**Bond Refund**: Bonds are automatically returned to the proposer when:
- The proposal succeeds and is executed
- The proposal is defeated but was not frivolous (standard rejection)

**Bond Slashing**: Bonds can be slashed (confiscated) by governance when:
- A proposal violates community standards
- The proposer engages in bad-faith behavior
- Governance explicitly votes to slash the bond

### Smart Contract Interface

The proposal-bonds contract acts as a **bond escrow** between the proposer and the governance system. It:

1. Accepts bond deposits from proposers
2. Holds bonds in escrow during the proposal lifecycle
3. Returns or slashes bonds based on proposal outcomes
4. Mirrors the governor contract's proposal types to track proposal state

## Integration with NebGov

### With Governor

The proposal-bonds contract integrates with the core governor contract:

```
Governor (proposal lifecycle)
    ↓
Proposal-Bonds (manages proposer bonds)
```

When a proposal is created, the proposer's bond is locked. When the proposal reaches a terminal state (executed, defeated, or cancelled), the bonds contract is notified to either refund or slash.

### Configuration

`initialize(admin, bond_token, bond_amount, governor, refund_grace_ledgers, max_lock_ledgers)` sets:

- **Bond amount**: the amount locked per proposal.
- **Bond token**: the token bonds are posted in.
- **Governor**: the contract `refund_bond` reads proposal state from, and the only caller `slash` accepts.
- **Refund grace** (`refund_grace_ledgers`): ledgers after voting ends before a refund is allowed. This is the window
  in which governance can `slash` instead.
- **Max lock** (`max_lock_ledgers`): ledgers after `lock_bond` after which a refund is always allowed, whatever the
  proposal's state. This is the escape hatch for a proposal stuck in `Queued`.

### Changing settings after initialize

All of these are admin-only.

| Function | Changes | Event |
|---|---|---|
| `update_bond_amount(admin, new_amount)` | Bond amount for bonds locked from now on. Must be positive. | `BondAmountUpdated` |
| `update_settings(admin, bond_token, governor, refund_grace_ledgers, max_lock_ledgers)` | Bond token, governor and both refund windows | `SettingsUpdated` |
| `set_admin(admin, new_admin)` | The admin. Takes effect immediately. | `AdminUpdated` |

`update_settings` rejects `max_lock_ledgers` with `InvalidLockWindow` when it is:

- `0`, which would open the escape hatch in the ledger the bond was locked;
- not greater than `refund_grace_ledgers`, which would let the escape hatch open before the slashing window closes;
- greater than the bond entry's TTL (1,000,000 ledgers), which would let the bond be archived before the escape hatch
  opens.

How each setting affects bonds that are already locked:

- **Bond token**: each bond is refunded or slashed in the token it was locked in, so changing the token only affects
  bonds locked afterwards.
- **Governor**: `refund_bond` and `slash` use the current governor. After redeploying the governor, point the bonds
  contract at the new one. Proposals that only exist on the old governor can't be looked up on the new one, so their
  bonds become refundable once `max_lock_ledgers` has passed.
- **Refund grace and max lock**: these are read at refund time, so they apply to bonds that are already locked.

## Usage Example

### Creating a Proposal with a Bond (SDK)

```typescript
import { GovernorClient } from '@nebgov/sdk';

const client = new GovernorClient({
  rpc: stellarRpc,
  contractId: governorAddress,
});

// Propose with a bond requirement
const result = await client.propose({
  proposer: userAddress,
  description: 'Add liquidity to XLM/USDC pool',
  targets: [treasuryAddress],
  functionNames: ['transfer'],
  calldatas: [calldata],
  bondAmount: 1000n, // Must post 1000 tokens as bond
});
```

### Refunding Bonds

Bonds are refunded automatically when proposals reach terminal states. The governance system can optionally implement additional logic to:

- Refund at different rates based on proposal performance
- Donate slashed bonds to a community fund
- Use slashing as a penalty mechanism

## Security Considerations

### Attack Vectors and Mitigations

**Sybil Attacks**: Proposal bonds increase the cost of launching many low-quality proposals, reducing the feasibility of coordination attacks.

**Bond Liquidity**: If bond amounts are too high, honest proposers may struggle to participate. Governance should tune bonds to balance participation and protection.

**Griefing**: An attacker could post valid proposals and accept slashing. Governance should reserve slashing for genuine violations, not disagreements.

## Errors

| Code | Error | Meaning |
|---|---|---|
| 1 | `AlreadyInitialized` | |
| 2 | `NotInitialized` | |
| 3 | `BondAlreadyLocked` | A bond for this description hash is still locked. |
| 4 | `BondNotFound` | |
| 5 | `BondNotLocked` | The bond was already refunded or slashed. |
| 6 | `DescriptionHashMismatch` | The governor proposal's description hash is not this bond's. |
| 7 | `ProposalNotTerminal` | The proposal can still change state. |
| 8 | `RefundGraceNotElapsed` | The refund grace window has not passed. |
| 9 | `NotAuthorized` | Caller is not the admin, or `slash` was not called by the governor. |
| 10 | `InvalidBondAmount` | Bond amount is not positive. |
| 11 | `InvalidLockWindow` | `max_lock_ledgers` is outside the bounds above. |

## Events

- `BondLocked`, `BondRefunded`, `BondSlashed`: a bond was locked, refunded or slashed
- `BondAmountUpdated`: `(old_amount, new_amount)`
- `SettingsUpdated`: `(bond_token, governor, refund_grace_ledgers, max_lock_ledgers)`, with the admin as a topic
- `AdminUpdated`: the new admin, with the old admin as a topic

## SDK and CLI

`ProposalBondsClient` exposes `updateSettings(admin, { bondToken, governor, refundGraceLedgers, maxLockLedgers })`
and `setAdmin(admin, newAdmin)`. The CLI has the same two commands:

```bash
nebgov proposal-bonds update-settings --bond-token C... --governor C... \
  --refund-grace-ledgers 17280 --max-lock-ledgers 518400 --keypair admin.json
nebgov proposal-bonds set-admin G... --keypair admin.json
```

## Related Features

- **[Conviction Voting](./conviction-voting.md)** — Combines with proposal bonds to create multi-track governance
- **[Governor](./architecture.md#proposal-lifecycle)** — Core proposal lifecycle that bonds integrate with
- **[Treasury](./architecture.md#treasury)** — Often stores slashed bonds or refund budgets

## See Also

- Smart contract: `contracts/proposal-bonds`
- Deployment guide: [docs/deployment.md](./deployment.md)
- Parameter tuning: [docs/parameter-guide.md](./parameter-guide.md)
