// frontend/src/utils/turnClock.ts
//
// How long turns actually take, measured from a log.
//
// ==================================================================
//  DESIGN NOTE 1190: THE CLOCK'S NUMBERS ARE A MEASUREMENT, NOT A GUESS
// ==================================================================
//
// THE SETTLEMENT CLOCK NEEDS TWO NUMBERS -- a per-turn allowance and a disconnect reserve -- and the first
// attempt at them was invented. Proposed 20 minutes, then argued down to 15, on nothing but intuition about
// how long an 1830 turn feels. The objection that followed was also intuition: that a 15-minute reserve
// "would have every player timed out by Operating Round 4".
//
// BOTH WERE ANSWERABLE FROM A LOG WE ALREADY HAD. `JUNO-3XD` carries a server timestamp on every entry, so
// the distribution of real turn lengths is arithmetic, not opinion. Measured: median 40s, p95 2.5 min,
// longest turn in the session 6.9 min. At a 10-minute allowance the worst-affected player burned ZERO
// reserve across 1.9 hours of play. The objection was wrong, and so was the original guess -- in the same
// direction, for the same reason.
//
// SO THIS FILE EXISTS TO STOP THE NEXT ONE. The numbers go in `SetupGame` beside the other variants and will
// be revisited; every playtest from here answers the question for itself, and the answer arrives as a table
// rather than as an argument.
//
// THE RESERVE IS NOT CONSUMED BY THINKING, which is the property the whole design rests on and the one the
// objection lost sight of. `burnByActor` charges `max(0, duration - allowance)` and nothing else: a player
// who deliberates for fourteen minutes under a fifteen-minute allowance burns none of it. The reserve is
// there for absence, not for deliberation.
//
// A TURN IS A CONSECUTIVE RUN BY ONE ACTOR, INCLUDING THE WAIT BEFORE ITS FIRST ACTION. That lead-in is the
// part that matters -- it is the player reading the board and deciding, before anything reaches the log --
// and a measurement that started at the first action would miss exactly the interval the allowance exists to
// cover. It is also why the longest turns in the sample are single-action ones.

/** The fields this module needs. Structurally a `SandboxAction` or an exported entry; restated so a log read
 *  from a file, from a room, or from a replay all measure identically. */
export interface ClockEntry {
  index: number;
  id: string;
  actor: string;
  /** The server stamp. An entry without one cannot be timed and is skipped rather than guessed at (#232:
   *  absent is not a value -- and a zero here would read as an instantaneous turn). */
  at?: number;
}

export interface MeasuredTurn {
  actor: string;
  /** How many log entries the turn contained. */
  actions: number;
  /** Wall-clock seconds, including the wait before the turn's first action. */
  seconds: number;
}

export interface ClockStats {
  turns: number;
  medianSeconds: number;
  p90Seconds: number;
  p95Seconds: number;
  p99Seconds: number;
  maxSeconds: number;
}

/** Sort into the order the app replays -- index, then document id (#1026's tie-break). Measuring a log in
 *  any other sequence would time a game nobody played. */
function ordered<T extends ClockEntry>(entries: readonly T[]): T[] {
  return [...entries].sort((a, b) => a.index - b.index || a.id.localeCompare(b.id));
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = ((sorted.length - 1) * p) / 100;
  const low = Math.floor(rank);
  const high = Math.min(low + 1, sorted.length - 1);
  return sorted[low] + (sorted[high] - sorted[low]) * (rank - low);
}

/** Split a log into turns: consecutive runs by one actor, each carrying the wait that preceded it. */
export function turnsFromLog(entries: readonly ClockEntry[]): MeasuredTurn[] {
  const rows = ordered(entries).filter((entry) => typeof entry.at === "number");
  const turns: MeasuredTurn[] = [];
  let start = 0;

  for (let at = 1; at <= rows.length; at += 1) {
    if (at < rows.length && rows[at].actor === rows[start].actor) continue;
    if (rows.length === 0) break;
    const first = rows[start];
    const last = rows[at - 1];
    /* THE LEAD-IN IS THE DELIBERATION, so it belongs to this turn and not to the previous one -- the previous
       actor had already finished acting. Clamped at zero because two entries can share a millisecond and a
       clock that ran backwards would silently credit a turn with negative time. */
    const leadIn = start > 0 ? Math.max(0, (first.at as number) - (rows[start - 1].at as number)) : 0;
    turns.push({
      actor: first.actor,
      actions: at - start,
      seconds: ((last.at as number) - (first.at as number) + leadIn) / 1000,
    });
    start = at;
  }

  return turns;
}

/** The distribution, for deciding what an allowance should be. */
export function clockStats(turns: readonly MeasuredTurn[]): ClockStats {
  const sorted = turns.map((turn) => turn.seconds).sort((a, b) => a - b);
  return {
    turns: turns.length,
    medianSeconds: percentile(sorted, 50),
    p90Seconds: percentile(sorted, 90),
    p95Seconds: percentile(sorted, 95),
    p99Seconds: percentile(sorted, 99),
    maxSeconds: sorted.length === 0 ? 0 : sorted[sorted.length - 1],
  };
}

/** Reserve each player would have burned under a given allowance, in seconds.
 *
 *  THE ONE FORMULA THE SETTLEMENT DEPENDS ON, and it is deliberately the only thing this function does.
 *  `max(0, duration - allowance)` is what makes the reserve insurance against absence rather than a second,
 *  stricter budget for thinking -- and it is what a client recomputes to check a forfeit claim, so it must
 *  stay a pure function of the log and the two recorded numbers. */
export function burnByActor(
  turns: readonly MeasuredTurn[],
  allowanceSeconds: number,
): Record<string, number> {
  const burn: Record<string, number> = {};
  for (const turn of turns) {
    burn[turn.actor] = (burn[turn.actor] ?? 0) + Math.max(0, turn.seconds - allowanceSeconds);
  }
  return burn;
}

/** The worst-affected player's burn, which is the figure that decides whether an allowance is generous
 *  enough: if the worst player burns nothing, nobody was ever at risk. */
export function worstBurnSeconds(
  turns: readonly MeasuredTurn[],
  allowanceSeconds: number,
): number {
  const values = Object.values(burnByActor(turns, allowanceSeconds));
  return values.length === 0 ? 0 : Math.max(...values);
}

/** The Live-mode allowance, in seconds. Chosen against `JUNO-3XD` (see #1190) and expected to be revisited
 *  once a full-length game has been logged -- late Operating Rounds are heavier than anything in that
 *  sample, which stopped at macro round 7. */
export const LIVE_ALLOWANCE_SECONDS = 15 * 60;
