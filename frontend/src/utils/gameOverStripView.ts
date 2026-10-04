// frontend/src/utils/gameOverStripView.ts
//
// Phase 3 Wave-1 integration (W1-N follow-up): the game-over strip's result clause, tie-aware like the modal.
//
/* ==================================================================
    THE STRIP NAMES EVERY PLAYER RANKED FIRST, NOT `sorted[0]`
   ==================================================================
   W1-N (H-06, AUD-12.04) made `GameOverModal` badge every rank-1 row a WINNER: `rankPlayers` gives tied players
   one shared rank, while its `isWinner` names a single champion -- whichever tied row happened to sort first. The
   strip that replaces the action bar after the game still read `isWinner`, so on a tie it announced one player as
   "the" winner while the modal beside it said "tied for 1st". It now reads the same fact the modal reads,
   `rank === 1`. Ranking is unchanged and nothing here computes a standing: the rows arrive from `rankPlayers`. */

import type { PlayerStanding } from "../gameEngine/endgame";

/** "A", "A and B", "A, B and C". */
function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** The clause after "🏁 Game over": one winner, a shared first place, or just "." when there are no standings. */
export function gameOverStripResult(standings: readonly PlayerStanding[]): string {
  const first = standings.filter((row) => row.rank === 1);
  if (first.length === 0) return ".";
  if (first.length === 1) return ` — ${first[0].label} wins with $${first[0].netWorth}.`;
  return ` — ${joinNames(first.map((row) => row.label))} tie for first with $${first[0].netWorth} each.`;
}
