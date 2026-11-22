# Treasury Streams

`contracts/treasury-streams` pays recurring amounts from the treasury without a new governance proposal for each payment.
Governance creates a stream once. After that, any caller can trigger each interval as it comes due.

## Lifecycle

```
Governor: create_stream(recipient, asset, amount_per_interval, interval_ledgers, start, end)
Treasury: transfers the asset into the streams contract (create_stream moves no funds)
Anyone:   execute_stream(id) once an interval has come due  → pays recipient
          ... the call that pays the last whole interval marks the stream completed
Treasury or creator: pause_stream / resume_stream / cancel_stream
```

Streams pay out of the streams contract's own balance. Creating a stream does not lock funds, and the treasury only needs
to hold enough of the asset for the intervals it funds. If the balance is short, `execute_stream` reverts with
`InsufficientBalance` and nothing moves.

## Schedule

- The first interval completes `interval_ledgers` after `start_ledger`. `last_streamed_ledger` starts at `start_ledger`.
- `execute_stream` pays every whole interval that has come due, up to `end_ledger`. Two intervals due means two
  payments in one call.
- A trailing partial interval before `end_ledger` is not paid. For example, a stream from ledger 1 to 100 with a
  10-ledger interval pays nine intervals in total.

## Completion

When `execute_stream` pays the last whole interval, meaning `last_streamed_ledger + interval_ledgers > end_ledger`
afterwards, the stream is finished:

- `completed` is set to `true` on the stream;
- its id is removed from `get_active_streams`, so the active list (and the backend executor's polling) holds only
  streams that can still pay;
- `StrmCompleted` is emitted after the final `StrmExec`.

A completed stream stays readable through `get_stream` and `get_streams_for_recipient`. `execute_stream`,
`pause_stream`, `resume_stream` and `cancel_stream` reject it with `StreamCompleted`.

## Pause, resume and cancel

- **Pause** stops execution. Intervals that come due while paused are paid after `resume_stream`, so pausing holds
  payouts and does not forfeit them.
- **Cancel** is permanent. Intervals that are due but not yet executed are forfeited, so execute them before cancelling.
  A cancelled stream stays readable and is removed from `get_active_streams`.

## Entrypoints

| Function | Caller | Notes |
|---|---|---|
| `initialize(admin, governor)` | `admin` | `admin` is the treasury. `governor` is the only address that can create streams. |
| `create_stream(requester, recipient, asset, amount_per_interval, interval_ledgers, start_ledger, end_ledger) -> u64` | governor | Rejects non-positive amounts, a zero interval, and a schedule that ends before it starts or has already ended. |
| `execute_stream(stream_id)` | anyone | Reverts with `StreamNotDue` when no whole interval has come due. |
| `pause_stream` / `resume_stream` / `cancel_stream` | treasury or creator | |
| `get_stream(stream_id) -> Stream` | view | |
| `get_claimable_amount(stream_id) -> i128` | view | What `execute_stream` would pay right now. |
| `get_streams_for_recipient(recipient, offset, limit)` | view | Includes cancelled and completed streams. |
| `get_active_streams(offset, limit)` | view | Streams that are neither cancelled nor completed, in creation order. |

Because creation is governor-only, `created_by` on a stream is always the governor.

## Errors

| Code | Error | Meaning |
|---|---|---|
| 1 | `AlreadyInitialized` | |
| 2 | `NotInitialized` | |
| 3 | `NotAuthorized` | Caller is not the governor, or not the treasury or creator. |
| 4 | `InvalidAmount` | `amount_per_interval` is not positive. |
| 5 | `InvalidInterval` | `interval_ledgers` is zero. |
| 6 | `InvalidSchedule` | `end_ledger` is not after `start_ledger`, or has already passed. |
| 7 | `StreamNotFound` | |
| 8 | `StreamCancelled` | |
| 9 | `StreamPaused` | Returned by `execute_stream` while paused. |
| 10 | `AlreadyPaused` | |
| 11 | `NotPaused` | |
| 12 | `StreamNotDue` | No whole interval has come due. |
| 13 | `InsufficientBalance` | The streams contract holds less than the amount due. |
| 14 | `ArithmeticOverflow` | |
| 15 | `StreamCompleted` | The stream has paid its last whole interval. |

## Events

- `StrmCreated`: stream created (`stream_id`, `recipient`, `amount_per_interval`, `interval_ledgers`)
- `StrmExec`: intervals paid (`stream_id`, `amount`, `executed_at_ledger`)
- `StrmPaused` / `StrmResumed`: stream paused or resumed
- `StrmCancel`: stream cancelled (`stream_id`, `total_streamed`)
- `StrmCompleted`: last whole interval paid, stream removed from the active list (`stream_id`, `total_streamed`)

## Backend executor

`backend/src/jobs/treasury-streams-executor.ts` runs on each tick. It reads active streams and their claimable amounts
from the contract, then calls `execute_stream` for those with something due. It is started only when
`TREASURY_STREAMS_CONTRACT_ID` is set, and it signs with `RELAYER_SECRET_KEY`, the same service account as the
signal-anchor job.

The executor also skips any stream marked `completed`. The contract already drops completed streams from
`get_active_streams`, so this only matters for a stream that completes during a tick.

When `execute_stream` fails, the executor writes a row to `treasury_stream_failures` (migration 014) and skips that stream
until an operator sets `cleared_at` on its rows. A failure is not retried on every tick.

## Indexer

Set `TREASURY_STREAMS_ADDRESS` on the indexer to subscribe to this contract. Its events are written to `event_log`,
the feed the backend notification engine reads, and `StrmCompleted` is also broadcast over the WebSocket as
`treasury_stream_completed` (`stream_id`, `total_streamed`, `ledger`).

## SDK

`TreasuryStreamsClient` (`sdk/src/treasuryStreams.ts`) maps `completed` onto `TreasuryStream`, and exposes the views above and the write methods
`createStream`, `executeStream`, `pauseStream`, `resumeStream` and `cancelStream`.

## Deployment

Deploy and initialize the streams contract after the governor. Set its `admin` to the treasury and its `governor` to the
governor address. Then fund the contract from the treasury for the streams it will pay.
