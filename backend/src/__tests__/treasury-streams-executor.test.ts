import { selectExecutableStreams, type StreamSnapshot } from "../jobs/treasury-streams-plan";

const live = (id: number, claimable: bigint): StreamSnapshot => ({
  id,
  paused: false,
  cancelled: false,
  completed: false,
  claimable,
});

describe("selectExecutableStreams", () => {
  it("selects live streams with an interval due", () => {
    const due = selectExecutableStreams([live(1, 200n), live(2, 0n)], new Set());

    expect(due.map((stream) => stream.id)).toEqual([1]);
  });

  it("skips paused, cancelled and completed streams even when money is due", () => {
    const streams: StreamSnapshot[] = [
      { id: 1, paused: true, cancelled: false, completed: false, claimable: 100n },
      { id: 2, paused: false, cancelled: true, completed: false, claimable: 100n },
      { id: 3, paused: false, cancelled: false, completed: true, claimable: 100n },
    ];

    expect(selectExecutableStreams(streams, new Set())).toEqual([]);
  });

  it("skips streams with an uncleared failure until an operator clears it", () => {
    const due = selectExecutableStreams([live(1, 100n), live(2, 100n)], new Set([2]));

    expect(due.map((stream) => stream.id)).toEqual([1]);
  });

  it("keeps the order the contract returned the streams in", () => {
    const due = selectExecutableStreams([live(3, 1n), live(1, 1n), live(2, 1n)], new Set());

    expect(due.map((stream) => stream.id)).toEqual([3, 1, 2]);
  });
});
