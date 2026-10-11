/**
 * Total order of one fact over all sources (02 4.3): time first, then the rank of the event kind, then a
 * string that makes the order total. The data design stores it as `turns.end_rank` / `end_tie` (last write wins).
 */
export interface Stamp {
  at: number;
  rank: number;
  tie: string;
}

/** Negative when `a` sorts before `b`, positive when after, 0 only for identical stamps. */
export function compareStamp(a: Stamp, b: Stamp): -1 | 0 | 1 {
  if (a.at !== b.at) return a.at < b.at ? -1 : 1;
  if (a.rank !== b.rank) return a.rank < b.rank ? -1 : 1;
  if (a.tie !== b.tie) return a.tie < b.tie ? -1 : 1;
  return 0;
}
