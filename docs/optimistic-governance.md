# Optimistic Governance

## Overview

The **Optimistic Governance** feature (`contracts/optimistic-governor`) implements an **optimistic proposal track** that allows proposals to pass unless someone actively objects during a challenge window. This mechanism:

- **Speeds up low-risk decisions** by avoiding extended voting periods for routine matters
- **Reduces participation barriers** for proposals that are unlikely to face opposition
- **Preserves veto rights** by allowing any stakeholder to block a proposal during the challenge window
- **Complements standard voting** by offering an alternative track alongside the main governance system

## How It Works

### The Optimistic Governance Lifecycle

```
Proposal created → Challenge window opens → No objections? → Execute
                        ↓
                  Someone objects?
                        ↓
                    Proposal blocked
```

### Key Concepts

**Challenge Window**: A fixed period (e.g., 3-7 days) during which any stakeholder with voting power can object to a proposal. Objections prevent automatic execution.

**Optimistic Pass**: If the challenge window closes with no objections, the proposal automatically passes and can be executed immediately—without waiting for formal voting.

**Objection**: Any holder of governance tokens can lodge an objection during the challenge window. A single valid objection blocks automatic execution. The proposal can then:
- Be formally voted on through the standard governor track
- Be resubmitted with modifications
- Be abandoned

**Voting Power Snapshot**: Objections are validated against a historical snapshot of voting power at the proposal creation ledger, preventing last-minute vote-buying.

## Proposal States

An optimistic proposal moves through these states:

1. **ChallengeWindow** — Newly created, accepting objections
2. **Objected** — Someone challenged the proposal
3. **Passed** — Challenge window closed with no objections
4. **Executed** — The proposal's actions were executed on-chain
5. **Cancelled** — Manually cancelled or expired

## Proposer Bond

`initialize` takes a `proposer_bond_amount` and `proposer_bond_token`; `propose` locks that bond from the proposer
(an amount of `0` disables it). The bond is an anti-spam deposit, so what happens to it depends on whether the
proposal was objected:

| Path | Bond |
|---|---|
| `finalize` after an unobjected challenge window (`Passed`) | Refunded to the proposer |
| `cancel` while still in `ChallengeWindow` | Refunded to the proposer |
| Objected (`Objected`, including if the proposer then cancels) | **Stays locked** until governance settles it |

Cancelling an objected proposal is still allowed, so the proposer can withdraw it and re-propose, but it doesn't
return the bond. Otherwise "propose, get objected, cancel" would cost nothing and the bond wouldn't deter spam.

An objected proposal's bond is settled by the admin, which should be governance (the governor or timelock), so each
outcome is a governance decision:

- `release_bond(admin, proposal_id)` returns the bond to the proposer, for an objection that wasn't about spam.
- `slash_bond(admin, proposal_id, recipient)` sends the bond to `recipient`, for example the treasury, as
  `contracts/proposal-bonds::slash` does.

Both pay out in the token the bond was locked in, even if `update_bond_config` has changed it since. Both fail with
`BondNotSettleable` before the proposal has been objected, and with `BondNotFound` once there is no bond left to
settle.

| Code | Error | Meaning |
|---|---|---|
| 18 | `BondNotFound` | No bond is held for the proposal: none was taken, or it was already refunded, released or slashed. |
| 19 | `BondNotSettleable` | The proposal hasn't been objected, so its bond isn't at risk. |

Events: `BondReleased` (`proposal_id` topic; `proposer`, `amount`) and `BondSlashed` (`proposal_id` topic;
`recipient`, `amount`).

## Integration with NebGov

### Single vs. Multi-Track Governance

**Single-track optimistic governance**:
```
Optimistic Governor (all proposals)
    ↓
Challenge window → Pass or object
```

**Multi-track governance** (recommended for important DAOs):
```
Governor (formal voting)      Optimistic Governor (routine decisions)
    ↓                               ↓
Voting period                Challenge window
    ↓                               ↓
Execution                      Execution
```

### Reading Voting Power

The optimistic-governor contract reads historical voting power from `contracts/token-votes` at the proposal creation ledger:

```rust
let past_votes = votes_client.get_past_votes(&proposer_addr, creation_ledger);
```

This prevents vote-buying schemes where an attacker:
1. Creates an optimistic proposal
2. Acquires large token holdings
3. Attempts to block objections

## Usage Example

### Creating an Optimistic Proposal (SDK)

```typescript
import { OptimisticGovernorClient } from '@nebgov/sdk';

const client = new OptimisticGovernorClient({
  rpc: stellarRpc,
  contractId: optimisticGovAddress,
});

// Create an optimistic proposal
const result = await client.propose({
  proposer: userAddress,
  target: treasuryAddress,
  functionName: 'transfer',
  calldata: transferCalldata,
  description: 'Allocate 1000 XLM to marketing bounties',
  descriptionHash: crypto.hash(description),
});

// Check if it passed after challenge window closes
const proposal = await client.getProposal(proposalId);
if (proposal.state === 'Passed') {
  // Execute immediately
  await client.execute(proposalId);
}
```

### Objecting to a Proposal

```typescript
// Object to a proposal during the challenge window
await client.object({
  objector: userAddress,
  proposalId: proposalId,
});

// After objection, the proposal can be voted on formally
// or resubmitted later
```

## Configuration

Each governance instance can tune:

- **Challenge Window Duration** — How long the challenge window remains open (e.g., 10,000–50,000 ledgers ≈ 1–5 days)
- **Proposal Threshold** — Minimum voting power required to create an optimistic proposal
- **Objection Threshold** — Minimum voting power required to object (typically 0 or very low)

## Security Considerations

### Attack Vectors and Mitigations

**Silenced Objectors**: If governance token holders are unaware of proposals, no one may object in time. Mitigation: Integrate with notification systems and provide governance dashboards.

**Voting Power Snapshots**: Historical voting power is fixed at proposal creation. An attacker cannot acquire tokens after creating a proposal and then block objections. Mitigation: Snapshot-based validation is built-in.

**Rushed Execution**: A proposer with poor intentions could create a proposal and immediately execute it if the challenge window closes. Mitigation: Governance should use proposal bonds (see [Proposal Bonds](./proposal-bonds.md)) to raise the cost of spam.

**Free Spam via Cancel**: If cancelling an objected proposal refunded its bond, spamming would cost nothing. Mitigation: once a proposal is objected its bond stays locked until governance releases or slashes it (see [Proposer Bond](#proposer-bond)).

**Consensus Breakdown**: If the community fundamentally disagrees on what constitutes "safe," optimistic governance may execute unpopular proposals. Mitigation: Governance should start with formal voting and only use optimistic tracks for truly routine matters.

## Best Practices

1. **Reserve for Routine Decisions** — Use optimistic governance for low-risk proposals (e.g., parameter adjustments, minor budget allocations, technical maintenance).

2. **Combine with Formal Voting** — Keep the standard governor contract for major decisions. Allow proposers to choose their track.

3. **Educate the Community** — Ensure token holders understand:
   - How optimistic governance works
   - What kinds of proposals use this track
   - How to object and when to do so

4. **Monitor Challenge Windows** — Maintain visibility into active challenges. Set up alerts for proposals in the challenge window.

5. **Tune Challenge Duration** — Balance speed with community review time. Give stakeholders enough time to notice and react to proposals.

## Related Features

- **[Conviction Voting](./conviction-voting.md)** — Another alternative governance track
- **[Proposal Bonds](./proposal-bonds.md)** — Complements optimistic governance by increasing proposal costs
- **[Governor](./architecture.md)** — The formal voting system that can handle contested proposals

## See Also

- Smart contract: `contracts/optimistic-governor`
- Architecture: [docs/architecture.md](./architecture.md)
- Deployment guide: [docs/deployment.md](./deployment.md)
- Parameter tuning: [docs/parameter-guide.md](./parameter-guide.md)
