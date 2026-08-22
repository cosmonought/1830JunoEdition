// frontend/src/utils/cityBlocking.ts
//
// Which cities a corporation may not run through.
//
// ==================================================================
//  DESIGN NOTE 729: THE NETWORK IS A RUN
// ==================================================================
//
// REPORTED: "In Lay Track, corporations' networks are not being blocked by tokened out cities. A network is
// defined in the rulebook as the hexes a theoretical infinite-length train could reach on its run, so tokened
// out hexes block this train as they should all other trains."
//
// THE DEFINITION IS THE FIX. The walk in `trackReach.ts` modelled TRACK and nothing else -- it knew about
// rails, edges, crossovers and two-city tiles, and had never heard of a station token. So a corporation's
// network ran straight through cities its trains may not pass, and the tile-lay glow offered hexes on the far
// side of a wall: places no train of theirs could reach, in a step whose entire purpose is extending where
// their trains can go.
//
// WHY IT WENT UNNOTICED -- and the first version of this paragraph got the arithmetic wrong, so it is worth
// stating correctly. It said blocking "needs a small city and two rival tokens". REPORTED back: "a blocked
// city does not need 'two rival tokens', it just needs rival tokens equal to station slots. This might be at a
// city with only one station: it still blocks all other corporations." Exactly so -- and "small city" was
// worse than imprecise, because in 18xx "small town" names the black dots that hold no tokens at all, which
// is the one thing that can never be blocked.
//
// THE HONEST ANSWER IS THAT IT WAS ALWAYS WRONG, from the first rival token standing between a corporation and
// anywhere it wanted to go. Most 1830 yellow city tiles have ONE slot, so a single rival token is a wall --
// this was never a late-game condition. What varies is whether the board's geography puts such a city on a
// path anybody cared about, and that is not a threshold worth naming. The walk simply never consulted tokens.
//
// THREE RULES, AND ALL THREE MATTER:
//
//   1. A CITY IS BLOCKED WHEN ITS SLOTS ARE FULL -- rival tokens EQUAL TO the slot count, whatever that count
//      is. A one-slot city with one rival token is blocked; a two-slot city with one rival token has room, and
//      a train may pass through room. The predicate is `others >= slots`, not a number.
//   2. NEVER BY YOUR OWN TOKEN. A corporation occupying a city passes through it however full it is; that is
//      what its own token buys. This is the rule that makes the check `others fill every slot` rather than
//      `every slot is filled`.
//   3. TOWNS DO NOT BLOCK. A city is a revenue stop drawn as a white circle or pill and it holds station
//      markers; a small town is the black dot, and it holds none. Nothing with no slots can be full of
//      anything. A `slots` of zero must read as "not a city", never as "a city with no room" -- those two are
//      one sign apart in the obvious implementation and the wrong one walls off half the board.
//
// BLOCKED IS NOT UNREACHABLE, which is the half a naive fix gets wrong. A train may END its run in a city it
// cannot pass through, and a corporation may still upgrade that tile. `reachableTrack` therefore keeps the hex
// and drops its exits -- see #729 there. This module only answers "may I pass".
//
// See docs/ai_architecture/hex_tile_math.md, cityBlocking.ts #729.

/** One corporation's tokens, as the board records them. */
export interface TokenHolder {
  company_id: number;
  station_token_hexes: ReadonlyArray<readonly [number, number]>;
}

export interface CityBlockingInput {
  /** The corporation whose network is being walked. */
  actingCompanyId: number | null;
  /** Everybody with tokens on the board, including the acting corporation. */
  companies: readonly TokenHolder[];
  /** How many station slots this city has. `0` for a town, a dot, or bare track. */
  slotsAt: (q: number, r: number, cityIndex: number) => number;
  /** Which city on `(q, r)` holds a given company's token, when the chain has said. */
  cityOf: (company: TokenHolder, q: number, r: number) => number | undefined;
}

/** Whether `actingCompanyId` is barred from running THROUGH city `cityIndex` on `(q, r)`.
 *
 *  Returns `false` on every uncertain input rather than `true`. A wrong `false` shows a corporation track it
 *  cannot use, which the reducer and the contract still refuse; a wrong `true` silently deletes legal track
 *  from the board and gives the player no way to discover it. Between a visible refusal and an invisible
 *  prohibition, the visible one is the recoverable mistake. */
export function cityBlocksThrough(
  input: CityBlockingInput,
  q: number,
  r: number,
  cityIndex: number,
): boolean {
  const slots = input.slotsAt(q, r, cityIndex);
  // Rule 3: no slots means no city. Zero is "nothing to fill", not "full".
  if (!Number.isFinite(slots) || slots <= 0) return false;

  let others = 0;
  for (const company of input.companies) {
    const here = company.station_token_hexes.some(([tq, tr]) => tq === q && tr === r);
    if (!here) continue;
    /* A token recorded without a city index is on this HEX but of unknown city. Counted against the city being
       asked about only when the hex has one city to be in -- on a two-city hex, guessing would either invent a
       wall or miss one, and #134's rule is that `undefined` stays distinguishable from `0`. */
    const city = input.cityOf(company, q, r);
    if (city !== undefined && city !== cityIndex) continue;
    if (city === undefined && input.slotsAt(q, r, 1) > 0) continue;

    // Rule 2: your own token is a key, not a wall.
    if (company.company_id === input.actingCompanyId) return false;
    others += 1;
  }

  // Rule 1: full, and full of somebody else.
  return others >= slots;
}

/** The callback `reachableTrack` wants, bound to one corporation's board. */
export function cityBlockerFor(
  input: CityBlockingInput,
): (q: number, r: number, cityIndex: number) => boolean {
  return (q, r, cityIndex) => cityBlocksThrough(input, q, r, cityIndex);
}
