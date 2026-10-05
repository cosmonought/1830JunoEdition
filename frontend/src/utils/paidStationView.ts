// frontend/src/utils/paidStationView.ts
//
/* ==================================================================
    PHASE 3 W3-J (AUD-25.08): THE PAID STATION CONTROL ASKS WHETHER A PAID STATION IS POSSIBLE
   ==================================================================
   At the Place Token step the bar offers "Place Station Token for $X" and the board click stages a paid token. Neither
   asked about the treasury: `stationPlacementBlockReason` -- the predicate that decides whether the step has anything
   in it -- answers `null` as soon as the D&H's free station is available (design note #781: the step must stay open for
   it), and that answer is about the FREE station. So a corporation holding the D&H with a treasury too poor for the
   next paid station saw a live paid control, could stage a paid token on any reachable city, and was refused only by
   the server (`stationPlacementRefusal`'s treasury arm).
   THE PAID QUESTION IS THE SAME PREDICATE WITHOUT THE FREE STATION: the token limit, the treasury against
   `nextStationTokenCost` (the authority's own arm, figure for figure), and a reachable city with a free slot. Nothing
   is judged here that the engine does not judge; the sentence is the step's own clause, given its subject. */

import { stationPlacementBlockReason } from "../gameEngine/stationTokens";

type BlockInput = Parameters<typeof stationPlacementBlockReason>[0];

/** The clause as a sentence about `ticker` ("its treasury holds $30 ..." -> "PRR's treasury holds $30 ..."). */
export function stationClauseSentence(ticker: string, clause: string): string {
  if (clause.startsWith("its ")) return `${ticker}'s ${clause.slice(4)}.`;
  if (clause.startsWith("it ")) return `${ticker} ${clause.slice(3)}.`;
  return `${ticker}: ${clause}.`;
}

/** Why the acting corporation cannot place a PAID station now, or `null` if it may try. The D&H's free station is
 *  never counted here -- it is its own control (the power), not this one. */
export function paidStationRefusal(input: Omit<BlockInput, "extraTokenAvailable"> & { ticker: string }): string | null {
  const clause = stationPlacementBlockReason({ ...input, extraTokenAvailable: false });
  return clause === null ? null : stationClauseSentence(input.ticker, clause);
}
