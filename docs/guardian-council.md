# Guardian Council

The Guardian Council is an M-of-N emergency authority for the NebGov Governor.
It is deployed as a separate Soroban contract and configured as the
Governor's guardian address. The council can then coordinate emergency actions
without relying on one guardian key.

## Deployment and initialization

Deploy `contracts/guardian-council` with its constructor argument `deployer`
set to the trusted deployment account. The deploy transaction stores this
address before any separate initialization transaction can execute. Then call:

```text
initialize(deployer, members, threshold, governor, action_ttl_ledgers)
```

`members` must be non-empty and contain no duplicates. `threshold` must be at
least one and no greater than the member count. The council stores the
Governor address and rejects all actions from non-members. `deployer` must
match the constructor address and authorize initialization. Deploying without
the constructor argument or using a different initializer is invalid.

After initialization, set the council contract address as the Governor's
guardian. The council's calls to `pause`, `unpause`, `cancel`, and
`cancel_queued` are then recognized as coming from the configured guardian.

## Action lifecycle

1. A member calls `propose_action`; the proposer is automatically the first
   approval.
2. Other members call `approve_action`. Repeated approvals are idempotent.
3. Once the threshold is reached, any member may call `execute_action`.
4. The action is marked executed before the external Governor call is made.

Supported actions are `Pause`, `Unpause`, `CancelActive`, `CancelQueued`,
`RotateMember`, `SetThreshold`, and `SetActionTtl`. Membership and threshold changes are
themselves council actions, so there is no unauthenticated administrative
setter.

## Dashboard

The app serves the council at `/guardian`. Set
`NEXT_PUBLIC_GUARDIAN_COUNCIL_ADDRESS` (docker-compose maps it from
`GUARDIAN_COUNCIL_ADDRESS`) and connect a wallet. The page lists the members,
the approval threshold, and every action with its approval progress.

- Council members see **Approve** on actions they have not approved and
  **Revoke approval** on ones they have.
- Any connected wallet sees **Execute** once an action has enough approvals,
  matching the contract, where `execute_action` is permissionless.
- Only approvals from current members count toward the threshold; approvals
  from rotated-out members are shown separately as not counted.
- Executed actions are hidden by default; tick **Show executed** to list them.

The contract has no action counter, so the page reads actions by id until the
first one that does not exist (up to 100).

## Operational safety

- `revoke_approval` removes a member's approval before execution.
- Executed actions cannot be approved, revoked, or executed again.
- Pending actions receive a storage TTL. Set `action_ttl_ledgers` long enough
  for the expected approval window; expired storage cannot be recovered.
- Keep the council threshold below the total member count if emergency
  recovery must remain possible when one signer is unavailable.
- Monitor `action_proposed`, `action_approved`, `approval_revoked`, and
  `action_executed` events and alert on unexpected membership rotation or
  threshold changes.

## Recovery procedure

If an action is not yet approved, revoke any stale approval and create a new
action with the corrected parameters. If an action has executed, use the
corresponding Governor recovery path; the council intentionally does not
provide a rollback that could bypass Governor authorization.
