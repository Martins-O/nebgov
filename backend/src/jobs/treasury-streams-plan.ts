/** What the executor knows about one active stream on the current ledger. */
export interface StreamSnapshot {
  id: number;
  paused: boolean;
  cancelled: boolean;
  /** Set once the stream has paid its last interval; it is finished. */
  completed: boolean;
  /** Amount `execute_stream` would pay right now, in base units. */
  claimable: bigint;
}

/**
 * Streams to pay on this tick: live (not paused, cancelled or completed), with
 * at least one interval due, and no uncleared failure recorded against them.
 * The contract drops completed streams from `get_active_streams`, so a
 * completed one only shows up here if it completed mid-tick; it is skipped
 * rather than sent to a call that would revert with `StreamCompleted`. A stream with a recorded failure is
 * skipped until an operator clears that failure.
 */
export function selectExecutableStreams(
  streams: readonly StreamSnapshot[],
  failedStreamIds: ReadonlySet<number>,
): StreamSnapshot[] {
  return streams.filter(
    (stream) =>
      !stream.paused &&
      !stream.cancelled &&
      !stream.completed &&
      stream.claimable > 0n &&
      !failedStreamIds.has(stream.id),
  );
}
