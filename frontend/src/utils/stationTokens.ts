// frontend/src/utils/stationTokens.ts
//
// What a station token costs, and where one may go.
//
// ===================================================================
//  DESIGN NOTE 0: THE PRICE ESCALATES; IT WAS A CONSTANT
// ===================================================================
//
// Every station placement charged `SANDBOX_NOMINAL_TOKEN_COST` -- a flat $40
// reached for as a stand-in when nothing else about tokens was wired, and
// never revisited. 1830's schedule is not flat, and the shape of it is the
// whole decision a president makes about tokens:
//
//   THE HOME TOKEN IS FREE. It is granted automatically when the corporation
//   floats, so it is not bought at all. $0.
//   THE SECOND COSTS $40.
//   EVERY ONE AFTER THAT COSTS $100.
//
// So a corporation's third token is two and a half times its second, and the
// UI was quoting $40 for it. That is not a rounding error in a readout -- it
// is the difference between a placement a treasury can afford and one it
// cannot, presented as though the choice were cheap.
//
// `RulesReference.tsx` already carried the correct schedule in prose ("The
// next one placed costs $40 from the company treasury, and every one after
// that costs $100"), which is worth noting: the rules screen and the action
// button disagreed, and the rules screen was right.
//
// ===================================================================
//  DESIGN NOTE 1: THE ALLOWANCE IS PER CORPORATION, NOT A CONSTANT
// ===================================================================
//
// `PublicCompanyState.station_token_limit` is the authority and this file
// reads it rather than restating 1830's table. For reference, that table is
// PRR/NYC/CPR 4, B&O/C&O/ERIE 3, NNH/B&M 2 -- home token included -- which
// is why "how many can I still buy" is `limit - 1` slots deep and not a
// fixed three everywhere.
//
// ===================================================================
//  DESIGN NOTE 2: WHAT THIS ENFORCES, AND WHAT STAYS THE CONTRACT'S
// ===================================================================
//
// `hexmap::execute_place_station_token` is the authority on placement and
// rejects anything illegal that reaches it. What this adds is the same three
// refusals BEFORE a transaction is signed, with a sentence saying which one
// bit -- because a click that silently does nothing, or costs a signature to
// learn "no", is the failure this file exists to prevent:
//
//   a) CONNECTIVITY. The city must be one the corporation's own track
//      already reaches. Shares `reachableNetwork` with the tile-lay veil, so
//      the two cannot disagree about where a network ends.
//   b) A FREE SLOT. Every city has a fixed number of token circles; when
//      they are full the city is closed to new tokens (and blocks other
//      companies' trains from running THROUGH it).
//   c) RESERVATIONS. A corporation's home city holds a slot for it from the
//      start of the game. Until that company floats and places its home
//      token, nobody else may take the reservation.
//
// It does NOT model the one-token-per-turn rule, the treasury check, or
// whether it is this corporation's turn -- those are elsewhere in the UI or
// on chain, and duplicating them here would be a second opinion.

import {
  archetypeForHex,
  axialToPixel,
  twoNodePositions,
} from "../components/hexGeometry";
import { STATION_HOME_HEXES } from "../components/hexContractTypes";
import type { MapGridResponse } from "../components/hexContractTypes";
import { tileCitySlotCounts, tileCitySlotPoints } from "../components/TileGraphics";
import { hexKey, reachableNetwork } from "./trackReach";

/** The home token, granted at float rather than bought. */
export const STATION_TOKEN_HOME_COST = 0;
/** The second token a corporation places. */
export const STATION_TOKEN_SECOND_COST = 40;
/** The third and every one after it. */
export const STATION_TOKEN_LATER_COST = 100;

/** What the token at `placedIndex` costs -- design note #0. `placedIndex` is
 *  0-based, so `0` is the home token. */
export function stationTokenPrice(placedIndex: number): number {
  if (placedIndex <= 0) return STATION_TOKEN_HOME_COST;
  if (placedIndex === 1) return STATION_TOKEN_SECOND_COST;
  return STATION_TOKEN_LATER_COST;
}

/** One circle in the token row. */
export interface StationTokenSlot {
  /** 0-based position in the corporation's allowance. */
  index: number;
  cost: number;
  /** Already on the board -- rendered greyed. */
  placed: boolean;
  /** Index 0, the free token granted at float. */
  isHome: boolean;
  /** The next one that would be bought, for the button's price and for
   *  highlighting which circle the player is about to spend. */
  isNext: boolean;
}

export interface StationTokenCompanyLike {
  station_token_hexes: ReadonlyArray<readonly [number, number]>;
  station_token_limit: number;
}

/** The corporation's whole allowance, one entry per token -- design note #1.
 *
 *  ALL of them, placed and unplaced, because the row is a picture of the
 *  corporation's capacity rather than a to-do list: seeing that two of four
 *  are spent is the point, and a row that dropped the spent ones would shrink
 *  as the game went on and say nothing about what had been used. */
export function stationTokenSlots(
  company: StationTokenCompanyLike | null | undefined,
): StationTokenSlot[] {
  if (!company) return [];
  const placedCount = company.station_token_hexes.length;
  // A chain reporting more tokens than the limit is a contract bug; showing
  // a row shorter than the tokens on the board would report it as a UI one.
  const total = Math.max(company.station_token_limit, placedCount);
  return Array.from({ length: total }, (_, index) => ({
    index,
    cost: stationTokenPrice(index),
    placed: index < placedCount,
    isHome: index === 0,
    isNext: index === placedCount,
  }));
}

/** What the NEXT placement costs this corporation, or `null` when every
 *  token is already on the board. */
export function nextStationTokenCost(
  company: StationTokenCompanyLike | null | undefined,
): number | null {
  if (!company) return null;
  const placedCount = company.station_token_hexes.length;
  if (placedCount >= company.station_token_limit) return null;
  return stationTokenPrice(placedCount);
}

/* ------------------------------------------------------------------ */
/* Placement legality -- design note #2                                */
/* ------------------------------------------------------------------ */

/** How many token circles this hex has in total, across all its cities.
 *
 *  A laid tile knows its own slot counts (`tileCitySlotCounts`, mirrored
 *  from `hexmap::tile_city_slot_counts`). A preprinted hex has one circle
 *  per printed city -- one for an ordinary city, two for an "OO" pair or
 *  New York. A hex with no city has none, which is what makes the "no city
 *  here" refusal fall out of the same lookup. */
export function stationSlotCount(mapGrid: MapGridResponse, q: number, r: number): number {
  const laid = mapGrid.tiles.find((tile) => tile.q === q && tile.r === r);
  if (laid) {
    const counts = tileCitySlotCounts(laid.tile_id);
    if (counts.length > 0) return counts.reduce((sum, n) => sum + n, 0);
  }
  const archetype = archetypeForHex(mapGrid, q, r);
  if (archetype === "SingleCity") return 1;
  if (archetype === "DoubleCity") return 2;
  return 0;
}

export interface StationPlacementCompany {
  company_id: number;
  is_floated: boolean;
  station_token_hexes: ReadonlyArray<readonly [number, number]>;
  station_token_limit: number;
}

export interface StationPlacementInput {
  mapGrid: MapGridResponse;
  q: number;
  r: number;
  /** The corporation trying to place. */
  company: StationPlacementCompany;
  /** Every corporation, for slot occupancy and reservations. */
  allCompanies: readonly StationPlacementCompany[];
}

export interface StationPlacementResult {
  allowed: boolean;
  /** Player-facing, written to explain rather than merely refuse. `null`
   *  when allowed. */
  reason: string | null;
}

const ALLOWED: StationPlacementResult = { allowed: true, reason: null };

export function evaluateStationPlacement(
  input: StationPlacementInput,
): StationPlacementResult {
  const { mapGrid, q, r, company, allCompanies } = input;
  const here = (hexes: ReadonlyArray<readonly [number, number]>) =>
    hexes.some(([hq, hr]) => hq === q && hr === r);

  // ---- The corporation's own allowance. ----
  if (company.station_token_hexes.length >= company.station_token_limit) {
    return {
      allowed: false,
      reason: `Every one of this corporation's ${company.station_token_limit} station tokens is already on the board.`,
    };
  }

  // ---- Is there a city here at all? ----
  const slots = stationSlotCount(mapGrid, q, r);
  if (slots === 0) {
    return {
      allowed: false,
      reason: "There is no city here. Pick a city hex, or lay a city tile there first.",
    };
  }

  // ---- One token per corporation per city. ----
  if (here(company.station_token_hexes)) {
    return {
      allowed: false,
      reason: "This corporation already has a station token in this city.",
    };
  }

  // ---- Slot occupancy. ----
  //
  // A city closed by other companies' tokens is the single most consequential
  // board state in 1830 -- it blocks their trains from running THROUGH -- so
  // the refusal names it rather than saying "illegal".
  const occupied = allCompanies.filter((entry) => here(entry.station_token_hexes)).length;
  if (occupied >= slots) {
    return {
      allowed: false,
      reason:
        slots === 1
          ? "This city's only station slot is taken."
          : `All ${slots} of this city's station slots are taken.`,
    };
  }

  /* ---- Reservations. ----
   *
   * Every corporation's home city holds a slot for it from the start of the
   * game, whether or not it has floated. `STATION_HOME_HEXES` is that table.
   *
   * THE RESERVATION IS RELEASED BY USE, not by floating: a company that has
   * floated AND placed its home token is occupying the slot rather than
   * reserving it, and its token is already counted above. So the test is
   * "does this hex reserve a slot for somebody who has not taken it yet",
   * and each such reservation consumes one of the remaining slots.
   *
   * That distinction matters on the shared OO hexes: ERIE's home is a
   * two-city hex, so before ERIE floats another corporation may still take
   * the OTHER circle -- reserving both would over-block it. */
  const unclaimedReservations = STATION_HOME_HEXES.filter((home) => {
    if (home.q !== q || home.r !== r) return false;
    if (home.companyId === company.company_id) return false;
    const owner = allCompanies.find((entry) => entry.company_id === home.companyId);
    // No record of the company at all: treat the reservation as standing.
    if (!owner) return true;
    return !here(owner.station_token_hexes);
  }).length;

  if (occupied + unclaimedReservations >= slots) {
    const reserver = STATION_HOME_HEXES.find(
      (home) => home.q === q && home.r === r && home.companyId !== company.company_id,
    );
    return {
      allowed: false,
      reason: `This city's remaining slot is reserved as a home station${
        reserver ? ` for company #${reserver.companyId}` : ""
      } and cannot be taken.`,
    };
  }

  /* ---- Connectivity. ----
   *
   * Last, deliberately. The three refusals above are properties of the CITY
   * and are true for everybody; this one is about the acting corporation, and
   * a player who has been told "that city is full" does not also need to be
   * told their track does not reach it.
   *
   * A corporation with no token yet has no network to measure, and its first
   * placement is its home city -- which the contract grants at float rather
   * than asking for. Rather than guess, that case is allowed through and left
   * to the chain. */
  if (company.station_token_hexes.length > 0) {
    const network = reachableNetwork(mapGrid, company.station_token_hexes);
    if (!network.has(hexKey(q, r))) {
      return {
        allowed: false,
        reason:
          "This corporation's track does not reach this city. Station tokens may only be placed on the network it already runs.",
      };
    }
  }

  return ALLOWED;
}

/** Every hex this corporation may place a token on right now, keyed by
 *  `hexKey` -- the board-highlight set for the Tokens sub-phase, and the
 *  same shape the tile-lay veil consumes. */
export function placeableStationHexes(input: {
  mapGrid: MapGridResponse;
  company: StationPlacementCompany | null | undefined;
  allCompanies: readonly StationPlacementCompany[];
  /** Every hex on the board, as `(q, r)` pairs. */
  boardHexes: ReadonlyArray<readonly [number, number]>;
}): Set<string> {
  const { mapGrid, company, allCompanies, boardHexes } = input;
  const out = new Set<string>();
  if (!company) return out;
  for (const [q, r] of boardHexes) {
    if (evaluateStationPlacement({ mapGrid, q, r, company, allCompanies }).allowed) {
      out.add(hexKey(q, r));
    }
  }
  return out;
}

/* ==================================================================
 *  DESIGN NOTE 438: WHY THIS CORPORATION CANNOT PLACE A STATION
 * ==================================================================
 *
 * `null` when it can. The three blocking conditions are checked in the
 * order a player discovers them -- do I have a token, can I pay for it, is
 * there anywhere to put it -- so the reason reported is the first that
 * actually stops them rather than whichever is cheapest to test.
 *
 * THE TOPOLOGICAL CHECK IS THE REAL ONE, and it reuses
 * `placeableStationHexes`, which is the same set the targeting veil lights
 * (App design note #240). A cheaper approximation -- "does the network
 * touch any city" -- would disagree with the veil about reservations,
 * occupied slots and OO tiles, and the failure would be the worst kind: a
 * step skipped for a corporation the map would have let place, or a player
 * held on a step whose veil lights nothing.
 *
 * IT IS THE EXPENSIVE ONE TOO -- it walks every board hex -- so it runs
 * last, after the two cheap facts have had their chance to answer.
 *
 * PHRASED AS A REASON, NOT A BOOLEAN. The caller puts this in an
 * "Auto-Skip — ..." log line, and the three cases call for different
 * responses: an exhausted allowance is permanent, a short treasury is
 * fixable next turn, and no reachable slot is a fact about the map that a
 * tile lay might change. A bare `true` would collapse them. */
export function stationPlacementBlockReason(input: {
  mapGrid: MapGridResponse;
  company: (StationPlacementCompany & { treasury: string }) | null | undefined;
  allCompanies: readonly StationPlacementCompany[];
  boardHexes: ReadonlyArray<readonly [number, number]>;
}): string | null {
  const { mapGrid, company, allCompanies, boardHexes } = input;
  // No corporation resolved: not a block, an absence. The caller must not
  // skip a step over missing data -- see App design note #293b's reasoning
  // about ignorance permitting rather than refusing.
  if (!company) return null;

  const placed = company.station_token_hexes.length;
  if (placed >= company.station_token_limit) {
    return `all ${company.station_token_limit} of its station tokens are already on the board`;
  }

  const cost = nextStationTokenCost(company);
  const treasury = Number(company.treasury) || 0;
  if (cost !== null && treasury < cost) {
    return `its treasury holds $${treasury} and the next station costs $${cost}`;
  }

  if (placeableStationHexes({ mapGrid, company, allCompanies, boardHexes }).size === 0) {
    return "its network reaches no city with a free station slot";
  }
  return null;
}

/* ==================================================================
 *  DESIGN NOTE 453: WHICH CITY NODE THE POINTER LANDED ON
 * ==================================================================
 *
 * A hex can carry more than one city -- New York's #54/#62, every OO tile --
 * and `PlaceStationToken.city_index` exists precisely so a player can say
 * which. Nothing was answering the question, so every placement omitted the
 * field and the contract fell back to "lowest-indexed city with a free
 * slot": always legal, and on a two-city hex a coin toss against what the
 * player actually clicked.
 *
 * HOW IT DECIDES. Each city's slot points are already computed for drawing
 * (`tileCitySlotPoints` -- the same geometry that positions the tokens), so
 * a city's position is the centroid of its own slots. The click resolves to
 * whichever centroid is nearest. That reuses the drawing geometry rather
 * than describing the tile a second time, which is what keeps "where the
 * token appears" and "which city you clicked" from drifting apart.
 *
 * NEAREST, WITH NO RADIUS. A click has already been established as landing
 * inside this hex before this runs, and every point inside a hex is nearer
 * one of its cities than the other. Adding a hit radius would create dead
 * zones between the cities where a click inside a legal hex resolved to
 * nothing -- a worse answer than the nearest city, and one the player
 * cannot see the boundary of.
 *
 * `null` FOR "COULD NOT TELL", never a defaulted `0`:
 *
 *   - no tile laid. An untiled preprinted double city (New York before it
 *     is tiled) has no per-city geometry to measure against. Guessing here
 *     would send a confident wrong index; omitting the field lets the
 *     contract apply its documented fallback.
 *   - a tile this catalog does not know, or one with no cities at all.
 *
 * A ONE-CITY TILE SHORT-CIRCUITS TO `0` without measuring. Its index is not
 * a guess -- there is only one -- and the arithmetic would be wasted on the
 * overwhelming majority of hexes.
 */
export function cityIndexAtPoint(
  mapGrid: MapGridResponse,
  q: number,
  r: number,
  pointX: number,
  pointY: number,
  hexSize: number,
): number | null {
  const center = axialToPixel(q, r, hexSize);
  const laid = mapGrid.tiles.find((tile) => tile.q === q && tile.r === r);

  /* ==================================================================
   *  DESIGN NOTE 459: A PREPRINTED OO HEX IS STILL TWO CITIES
   * ==================================================================
   *
   * REPORTED: clicking the upper-right city on the Erie's home tile places
   * the token on the lower-left one.
   *
   * This function bailed to `null` for any hex with no LAID tile, on the
   * reasoning that an untiled hex has no per-city geometry to measure. That
   * is true of an ordinary blank hex and false of the four preprinted OO
   * hexes -- E5, D10, E11 and H18 -- which arrive with two station circles
   * already printed on them. E11 is the Erie's home, so the one hex a new
   * president is guaranteed to click was in the gap.
   *
   * The consequence was silent and looked like a targeting bug rather than
   * a missing branch: `null` means "I cannot tell", the caller correctly
   * omits `city_index`, and the contract applies its documented fallback of
   * the lowest-indexed free city -- which is 0. So every click on either
   * circle resolved to city 0, and `stationMarkerPoint`'s own OO branch
   * then drew that token at the BOTTOM-LEFT circle. Two independently
   * reasonable defaults compounding into "the upper-right node does not
   * work".
   *
   * `twoNodePositions` is the tuple the board actually draws those two
   * circles from (`drawOOCityMarkers` reads the same one), so hit-testing
   * against it cannot disagree with what the player sees. Index 0 is the
   * north-east circle and index 1 the south-west, which is the order the
   * geometry module documents and the order the city indices follow. */
  if (!laid) {
    if (archetypeForHex(mapGrid, q, r) !== "DoubleCity") return null;
    const nodes = twoNodePositions(center, hexSize);
    const d0 = (nodes[0].x - pointX) ** 2 + (nodes[0].y - pointY) ** 2;
    const d1 = (nodes[1].x - pointX) ** 2 + (nodes[1].y - pointY) ** 2;
    return d0 <= d1 ? 0 : 1;
  }

  const cityCount = tileCitySlotCounts(laid.tile_id).length;
  if (cityCount === 0) return null;
  if (cityCount === 1) return 0;

  let best: { index: number; distanceSq: number } | null = null;

  for (let city = 0; city < cityCount; city += 1) {
    const points = tileCitySlotPoints(laid.tile_id, city, laid.orientation, center, hexSize);
    if (points.length === 0) continue;
    // The city's own position: the centroid of the slots it draws tokens in.
    const cx = points.reduce((sum, p) => sum + p.x, 0) / points.length;
    const cy = points.reduce((sum, p) => sum + p.y, 0) / points.length;
    const distanceSq = (cx - pointX) ** 2 + (cy - pointY) ** 2;
    if (best === null || distanceSq < best.distanceSq) best = { index: city, distanceSq };
  }

  return best?.index ?? null;
}

/* ==================================================================
 *  DESIGN NOTE 463: THE NODES A CLICK CAN LAND ON
 * ==================================================================
 *
 * Every city node on a hex, as points in the hex layer's own coordinate
 * space, in CITY INDEX ORDER.
 *
 * REPORTED: valid city markers do not glow, so the specific node that can
 * be clicked is not obvious -- NNH's home is the case named, and every
 * two-city hex has the same problem.
 *
 * WHY THIS SHARES `cityIndexAtPoint`'S GEOMETRY, and why that is the whole
 * point rather than mere tidiness. A glow is a promise about what a click
 * will do. If the glow were drawn from one source of node positions and the
 * hit-test resolved against another, the two could disagree -- and the
 * failure would be the cruellest kind: a marker that pulses invitingly and
 * then places the token somewhere else. Both now read the same two
 * branches, in the same order:
 *
 *   LAID TILE      `tileCitySlotPoints` per city, centroid per city.
 *   PREPRINTED OO  `twoNodePositions`, index 0 north-east, 1 south-west.
 *
 * `[]` for a hex with no cities, which draws nothing -- correct, and the
 * same silence the hit-test's `null` produces.
 */
export function cityNodePoints(
  mapGrid: MapGridResponse,
  q: number,
  r: number,
  hexSize: number,
): Array<{ x: number; y: number }> {
  const center = axialToPixel(q, r, hexSize);
  const laid = mapGrid.tiles.find((tile) => tile.q === q && tile.r === r);

  if (!laid) {
    const archetype = archetypeForHex(mapGrid, q, r);
    if (archetype === "DoubleCity") return [...twoNodePositions(center, hexSize)];
    if (archetype === "SingleCity") return [center];
    return [];
  }

  const cityCount = tileCitySlotCounts(laid.tile_id).length;
  const out: Array<{ x: number; y: number }> = [];
  for (let city = 0; city < cityCount; city += 1) {
    const points = tileCitySlotPoints(laid.tile_id, city, laid.orientation, center, hexSize);
    if (points.length === 0) continue;
    out.push({
      x: points.reduce((sum, p) => sum + p.x, 0) / points.length,
      y: points.reduce((sum, p) => sum + p.y, 0) / points.length,
    });
  }
  return out;
}
