// frontend/src/gameEngine/stationAnchorAuthority.ts
//
// Revised 6.2.2 ❹ in the authority, not in the shell.
//
// ==================================================================
//  DESIGN NOTE 1623 (Slice 9.2, S9-17 / F-5): A CORRECT RULE IN THE WRONG PLACE
// ==================================================================
//
// THE RULE, verbatim (2018 revised Classic rulebook, 6.2.2 ❹): "When a tile is replaced, all stations on the
// replaced tile must be placed on the new tile with the same connections as before."
//
// IT IS ALREADY IMPLEMENTED, AND IMPLEMENTED WELL. `stationConnectivity.fitStationsToUpgrade` (#878) anchors
// a token to its EDGE SET rather than to a city index, refuses a facing that strands one, and since #1315
// refuses a facing that would overfill a city's slots. `tokenMigration.planTokenUpgrade` wraps it with the
// board reads. Stage 9.1's finding is not that the rule is wrong; it is WHERE IT LIVES: the only caller is
// `App.tsx`'s `legalRotations` memo, whose own design note #879 says "SO THE FILTER IS PART OF LEGALITY, not
// a courtesy" -- and a memo in the browser shell is not the authority. `layRefused` never asks it, the Node
// server never asks it, and a replay re-validates the tile and the facing but not the token landing.
//
// SO THE MACHINERY IS RE-SITED, NOT REWRITTEN. A second implementation of ❹ would be the divergence class
// this project exists to end (`replayProviders.ts` #1199 lists three times it was paid for). This module
// calls the SAME `planTokenUpgrade` the shell calls, and adds the half the shell never needed: the message's
// own landings are checked against the plan, because a crafted or replayed `LayTile` carries `token_cities`
// that nobody derived.
//
// WHY NOT IN `filterSandboxPlacements`. That predicate's whole input is `{ mapGrid, q, r, era }` -- it has no
// game state, and tokens are state. Widening it to take the corporations would put state into the one pure
// board-geometry module in the codebase. The reducer already holds both, and `applySandboxActionCore` already
// refuses `LayTile` there, ahead of every mutation -- so that is where ❹ goes.
//
// TWO REFUSALS, AND THEY ARE DIFFERENT QUESTIONS:
//   (1) NO LEGAL LANDING EXISTS. `planTokenUpgrade` returns `null`: some standing token's city has no
//       successor on the candidate that keeps its connections, or the landings do not fit the slots. The
//       facing is illegal no matter what the message asks for.
//   (2) THE MESSAGE ASKS FOR A DIFFERENT LANDING THAN THE ONE THE BOARD ALLOWS. A plan that anchors a token
//       at city k is not advice; ❹ says that is where the token goes. A message naming another city moves a
//       station onto a city with different prior connections, which is the rule's exact prohibition.
//
// EVERY STATION COUNTS, NOT EVERY MAPPING (#1625, the 9.2 review follow-up). `token_cities` and `token_city`
// are optional on the message and `station_tokens` is optional on the state, so a direct client can simply
// send less. It cannot buy legality by doing so: a station the message does not name is judged at the city
// the arm will actually leave it on (its stored index, clamped exactly as `clampCity` clamps it), and a
// station no one has ever indexed is counted at `planTokenUpgrade`'s own derived anchor. When even that is
// undecided -- a `free` token on a bare printed OO hex, where the president still chooses -- the total-slot
// floor applies: a tile cannot seat more stations than it has slots, whichever city each one ends up in.
//
// WHAT IS DELIBERATELY NOT HERE. #59's "the pre-printed exits on a (59) tile can never be connected in the
// tile upgrade" is the TRACK half of the same clause and a separate finding (S9-19, Slice 9.3); nothing in
// this file constrains a facing on track grounds. The D&H's free station (S9-12) is Slice 9.4. And a token
// the message does not name is left to #1315's `clampCity`, because an older log carries no `token_cities`
// at all and refusing one would re-adjudicate a game already played -- see `stage92Authority.test.ts` for
// the measurement that says the corpus never needs it.

import type { GameStateResponse } from "./gameState";
import type { MapGridResponse, StationTokenCompany } from "../components/hexContractTypes";
import { tokenCityIndex } from "../components/hexContractTypes";
import { tileCitySlotCounts } from "../components/TileGraphics";
import { planTokenUpgrade } from "../utils/tokenMigration";

/** The fields of `ExecuteMsg::LayTile` this gate reads. Declared structurally so the reducer can hand over
 *  `msg.LayTile` unchanged and a test can hand over a literal. */
export interface StationAnchorLay {
  q: number;
  r: number;
  tile_id: number;
  orientation: number;
  /** Design note #824's old spelling: ONE index applied to every token on the hex. */
  token_city?: number;
  /** Design note #880: `[company_id, city_index]` per token standing on the hex. */
  token_cities?: ReadonlyArray<readonly [number, number]> | null;
}

/** The landing the reducer will actually apply for one token, resolved exactly as its `LayTile` arm resolves
 *  it: the map first, then the old single-index spelling, then the index the token already carries -- and
 *  `clampCity` over all three (#1315). Exported because the test pins the mirror rather than trusting it. */
export function effectiveLandingCity(
  company: StationTokenCompany,
  q: number,
  r: number,
  lay: StationAnchorLay,
  cityCap: number,
): number | undefined {
  const perCompany = new Map<number, number>(lay.token_cities ?? []);
  const named = perCompany.has(company.company_id)
    ? perCompany.get(company.company_id)
    : perCompany.size === 0
      ? lay.token_city
      : undefined;
  const raw = named === undefined ? tokenCityIndex(company, q, r) : named;
  if (raw === undefined) return undefined;
  return Math.min(Math.max(0, raw), cityCap - 1);
}

/** Why this `LayTile` violates revised 6.2.2 ❹, or `null` when it does not.
 *
 *  `mapGrid` ABSENT MEANS NO OPINION, on design note #757's rule: a caller with no board cannot tell a
 *  preserved connection from a severed one, and guessing would either forbid a legal upgrade or wave an
 *  illegal one through. Every live path supplies it. */
export function stationAnchorRefusal(
  state: GameStateResponse,
  lay: StationAnchorLay,
  mapGrid: MapGridResponse | undefined,
): string | null {
  if (!mapGrid) return null;
  const { q, r, tile_id, orientation } = lay;

  const companies = state.public_companies as unknown as readonly StationTokenCompany[];
  const here = companies.filter((company) =>
    (company.station_token_hexes ?? []).some(([tq, tr]) => tq === q && tr === r),
  );
  // No token on the hex, nothing to preserve -- and ❹ is a rule about stations.
  if (here.length === 0) return null;

  const plan = planTokenUpgrade(mapGrid, q, r, companies, tile_id, orientation);
  if (plan === null) {
    return `Tile #${tile_id} at this rotation does not keep every station on this hex connected to the track it already reaches.`;
  }

  const slots = tileCitySlotCounts(tile_id);
  const cityCap = Math.max(1, slots.length);
  const occupancy = new Map<number, number>();

  for (const company of here) {
    const landing = plan.landings.find((entry) => entry.companyId === company.company_id);
    /* (2) THE PLAN IS THE LAW WHERE IT SPEAKS. `toCityIndex === null` is a token with no connections to
       preserve -- ERIE's home before any track (#878) -- and there the president genuinely chooses, so any
       city of the tile is legal and only the capacity tests below apply. */
    const anchored = landing?.toCityIndex ?? null;
    const written = effectiveLandingCity(company, q, r, lay, cityCap);

    if (written !== undefined) {
      if (anchored !== null && written !== anchored) {
        return `${company.ticker}'s station must stay with the track it already reaches; city ${written} of tile #${tile_id} at this rotation does not carry those connections.`;
      }
      occupancy.set(written, (occupancy.get(written) ?? 0) + 1);
      continue;
    }

    /* ==================================================================
        DESIGN NOTE 1625: A STATION NOBODY NAMED IS STILL A STATION
       ==================================================================
       `written === undefined` means the message named no city for this company AND the chain never recorded
       one (`station_tokens` absent -- design note #560's third state, which all three placement arms produce
       from a `city_index: null`). The mutation will write nothing for it, so there is no "landing the arm
       chooses" to mirror; what the BOARD says is `planTokenUpgrade`'s own derived anchor, which is the
       canonical remap and not a second algorithm. Count that where it exists.
       WHERE IT DOES NOT EXIST the token is `free` (#878: no live edges, so nothing to preserve) and
       `fitStationsToUpgrade` deliberately counts a free token against no city on a multi-city candidate --
       "the president still chooses" (#1315). Correct for the plan, and it is the gap a crafted message walked
       through: every token on a bare printed OO hex is free, so an upgrade could seat three of them on #59's
       two slots by simply saying nothing. The total-capacity floor below closes it without inventing a
       destination for a token whose destination is genuinely undecided. */
    if (anchored !== null) occupancy.set(anchored, (occupancy.get(anchored) ?? 0) + 1);
  }

  /* A tile the artwork catalog does not describe reports no slots at all -- unknown, so unchecked, rather
     than "zero slots", which would refuse every legal upgrade of it. */
  if (slots.length > 0) {
    /* THE FLOOR, and it is a physical fact rather than a rule about mappings: a tile cannot hold more
       stations than it has slots, whichever city each one ends up in. This is the ONLY capacity statement
       available for a token whose destination is still the president's to choose, and it is what makes
       "every station on the hex counts" true regardless of what the message names. */
    const totalSlots = slots.reduce((sum, count) => sum + count, 0);
    if (here.length > totalSlots) {
      return `Tile #${tile_id} has ${totalSlots} station slot${totalSlots === 1 ? "" : "s"} in all and this hex carries ${here.length} station${here.length === 1 ? "" : "s"}.`;
    }
    for (const [city, count] of Array.from(occupancy.entries())) {
      const capacity = slots[city] ?? 0;
      if (count > capacity) {
        return `City ${city} of tile #${tile_id} has ${capacity} station slot${capacity === 1 ? "" : "s"} and this lay would seat ${count}.`;
      }
    }
  }

  return null;
}
