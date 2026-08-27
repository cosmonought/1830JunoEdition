// frontend/src/utils/stationTokens.ts
//
// What a station token costs, and where one may go.
//
// Design note #0: THE PRICE ESCALATES; IT WAS A CONSTANT. Every placement charged a flat $40 -- a stand-in
// reached for when nothing else about tokens was wired. 1830's schedule is not flat, and the shape of it is
// the whole decision: the HOME token is FREE (granted at float, not bought), the SECOND costs $40, and EVERY
// ONE AFTER THAT costs $100. So a corporation's third token is two and a half times its second and the UI was
// quoting $40 -- the difference between a placement a treasury can afford and one it cannot, presented as
// though the choice were cheap. `RulesReference.tsx` already carried the correct schedule in prose: the rules
// screen and the action button disagreed, and the rules screen was right.
//
// Design note #1: the allowance is PER CORPORATION -- `station_token_limit` is the authority and this file
// reads it rather than restating 1830's table (PRR/NYC/CPR 4, B&O/C&O/ERIE 3, NNH/B&M 2, home included).
//
// Design note #2: what this enforces and what stays the contract's -- connectivity, a free slot, and
// reservations, refused BEFORE a transaction is signed with a sentence saying which one bit. It does NOT model
// the one-token-per-turn rule, the treasury check, or whose turn it is.
//
// Design notes #438/#453/#459/#463/#580: see `docs/ai_architecture/contract_economy.md`.

import {
  archetypeForHex,
  axialToPixel,
  twoNodePositions,
} from "../components/hexGeometry";
import {
  STATION_HOME_HEXES,
  tokenCityIndex,
  type StationTokenCompany,
} from "../components/hexContractTypes";
import type { MapGridResponse } from "../components/hexContractTypes";
import {
  NEW_YORK_PRINTED_ARTWORK,
  printedArtwork,
  tileCitySlotCounts,
  tileCitySlotPoints,
} from "../components/TileGraphics";
import { LANDMARK_HEXES, STATIC_BOARD_HEXES, YELLOW_OO_HEXES } from "../components/hexBoardData";
import { hexKey, reachableNetwork, stationTokensOf } from "./trackReach";

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

/** The corporation's whole allowance, one entry per token -- design note #1. ALL of them, placed and unplaced,
 *  because the row is a picture of the corporation's capacity rather than a to-do list: seeing that two of four
 *  are spent is the point, and a row that dropped the spent ones would shrink as the game went on and say
 *  nothing about what had been used. */
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

/** How many token circles this hex has in total, across all its cities. A laid tile knows its own slot counts
 *  (mirrored from `hexmap::tile_city_slot_counts`); a preprinted hex has one circle per printed city -- one for
 *  an ordinary city, two for an "OO" pair or New York. A hex with no city has none, which is what makes the "no
 *  city here" refusal fall out of the same lookup. */
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

  // Slot occupancy. A city closed by other companies' tokens is the single most consequential board state in
  // 1830 -- it blocks their trains from running THROUGH -- so the refusal names it rather than saying "illegal".
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

  /* Reservations. Every corporation's home city holds a slot for it from the start of the game, floated or not.
     THE RESERVATION IS RELEASED BY USE, not by floating: a company that has floated AND placed its home token is
     occupying the slot rather than reserving it, and its token is already counted above. So the test is "does
     this hex reserve a slot for somebody who has not taken it yet".
     That distinction matters on the shared OO hexes: ERIE's home is a two-city hex, so before ERIE floats another
     corporation may still take the OTHER circle -- reserving both would over-block it. */
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

  /* Connectivity, LAST and deliberately. The three refusals above are properties of the CITY and are true for
     everybody; this one is about the acting corporation, and a player who has been told "that city is full" does
     not also need to be told their track does not reach it.
     A corporation with no token yet has no network to measure, and its first placement is its home city -- which
     the contract grants at float rather than asking for. Rather than guess, that case is allowed through. */
  if (company.station_token_hexes.length > 0) {
    // Design note #686: the recorded city slot, same resolver as the veil.
    const network = reachableNetwork(mapGrid, stationTokensOf(company));
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

/* Design note #438: WHY THIS CORPORATION CANNOT PLACE A STATION. `null` when it can. The three blocking
   conditions are checked in the order a player discovers them -- do I have a token, can I pay for it, is there
   anywhere to put it -- so the reason reported is the first that actually stops them.
   THE TOPOLOGICAL CHECK IS THE REAL ONE, and it reuses the same set the targeting veil lights. A cheaper
   approximation -- "does the network touch any city" -- would disagree with the veil about reservations,
   occupied slots and OO tiles, and the failure would be the worst kind: a step skipped for a corporation the
   map would have let place, or a player held on a step whose veil lights nothing.
   IT IS THE EXPENSIVE ONE TOO -- it walks every board hex -- so it runs last.
   PHRASED AS A REASON, NOT A BOOLEAN: an exhausted allowance is permanent, a short treasury is fixable next
   turn, and no reachable slot is a fact about the map that a tile lay might change. A bare `true` would
   collapse them. */
/* ==================================================================
 *  DESIGN NOTE 781: A FREE TOKEN THIS PREDICATE COULD NOT SEE
 * ==================================================================
 *
 * REPORTED, twice and as two bugs: "as soon as the track was laid the subphase autoskipped to Run Routes
 * (skipping the Station Token step)", and "on the turn after using its special Lay Track power, the Place
 * Station special power suddenly became available. I believe these are supposed to be done on the same turn".
 *
 * ONE CAUSE. This function is what the auto-skip asks, and every one of its arms describes an ORDINARY
 * placement: a token the corporation pays for, dropped on a city its network reaches. The D&H's token is
 * neither -- it is free and it ignores connectivity entirely (`dhPower.ts`: "drop a station there in one go,
 * connected to nothing"). So a corporation whose only available placement was the D&H's reported "its network
 * reaches no city with a free station slot", the step skipped itself, and the player never reached the
 * control. The power then looked available the NEXT turn only because that was the next time the Tokens step
 * was reachable at all.
 *
 * #776'S SHAPE, FOR THE TOKEN. That note made the C&StL's lay extra; this one makes the D&H's token visible
 * to the thing that decides whether the step has anything in it. Both are the same underlying error: a
 * private's power is an exception to a rule, and the code enforcing the rule had never been told.
 *
 * WHICH ARMS IT BYPASSES, AND WHICH IT DOES NOT. Free, so the treasury arm does not apply; unconnected, so
 * the network arm does not apply. THE TOKEN LIMIT STILL APPLIES -- a corporation has a finite pile of station
 * markers and the D&H does not conjure one, so bypassing that would let it place a token it does not own. */
export function stationPlacementBlockReason(input: {
  mapGrid: MapGridResponse;
  company: (StationPlacementCompany & { treasury: string }) | null | undefined;
  allCompanies: readonly StationPlacementCompany[];
  boardHexes: ReadonlyArray<readonly [number, number]>;
  /** Design note #781: a placement this corporation may make that is free and ignores connectivity -- the
   *  D&H's station. `false`/omitted keeps the ordinary rules exactly as they were. */
  extraTokenAvailable?: boolean;
}): string | null {
  const { mapGrid, company, allCompanies, boardHexes, extraTokenAvailable = false } = input;
  // No corporation resolved: not a block, an absence. The caller must not
  // skip a step over missing data -- see App design note #293b's reasoning
  // about ignorance permitting rather than refusing.
  if (!company) return null;

  const placed = company.station_token_hexes.length;
  if (placed >= company.station_token_limit) {
    return `all ${company.station_token_limit} of its station tokens are already on the board`;
  }

  /* Design note #781: BOTH REMAINING ARMS ARE ABOUT AN ORDINARY PLACEMENT, and the D&H's is not one. Placed
     after the token-limit check on purpose -- that arm is a fact about the corporation's own pile of markers
     and no private power adds to it. */
  if (extraTokenAvailable) return null;

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

/* Design note #453: WHICH CITY NODE THE POINTER LANDED ON. A hex can carry more than one city, and
   `PlaceStationToken.city_index` exists precisely so a player can say which -- but nothing was answering the
   question, so every placement omitted the field and the contract fell back to "lowest-indexed city with a free
   slot": always legal, and on a two-city hex a coin toss against what the player actually clicked.
   HOW IT DECIDES: each city's slot points are already computed for drawing, so a city's position is the
   centroid of its own slots and the click resolves to the nearest -- which reuses the drawing geometry rather
   than describing the tile a second time.
   NEAREST, WITH NO RADIUS: a click has already been established as landing inside this hex, and every point
   inside a hex is nearer one of its cities than the other. A hit radius would create dead zones between the
   cities where a click inside a legal hex resolved to nothing.
   `null` FOR "COULD NOT TELL", never a defaulted `0` -- an untiled preprinted double city has no per-city
   geometry, and guessing would send a confident wrong index. A ONE-CITY TILE SHORT-CIRCUITS TO `0` without
   measuring: its index is not a guess, there is only one. */
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

  /* Design note #459: A PREPRINTED OO HEX IS STILL TWO CITIES. This bailed to `null` for any hex with no LAID
     tile -- true of an ordinary blank hex and false of the four preprinted OO hexes (E5, D10, E11, H18), which
     arrive with two station circles already printed. E11 is the Erie's home, so the one hex a new president is
     guaranteed to click was in the gap.
     The consequence was silent and looked like a targeting bug rather than a missing branch: `null` means "I
     cannot tell", the caller correctly omits `city_index`, and the contract applies its fallback of the
     lowest-indexed free city -- which is 0. So every click on either circle resolved to city 0, and
     `stationMarkerPoint`'s OO branch drew that token at the BOTTOM-LEFT circle. Two independently reasonable
     defaults compounding into "the upper-right node does not work".
     `twoNodePositions` is the tuple the board actually draws those circles from, so hit-testing against it cannot
     disagree with what the player sees. Index 0 is the north-east circle, index 1 the south-west. */
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

/* ------------------------------------------------------------------ */
/* Where a token WILL sit -- design note #698                          */
/* ------------------------------------------------------------------ */

/** Which city bucket a company's token on `(q, r)` belongs to.
 *
 *  Design note #698: EXTRACTED, because two surfaces have to agree about it. The draw pass buckets every
 *  placed token by this rule to pick its slot; the PREVIEW has to count the same buckets to know which slot is
 *  next. Written twice, they drift -- and the drift is invisible, because both answers look like a token on a
 *  city and only one of them is where the token will actually land.
 *  `station_tokens` is #560's recorded CITY; a hex with no entry falls to city 0.
 *
 *  ONE DELIBERATE ASYMMETRY, recorded so it is not "fixed" later: on a MULTI-city hex with no recorded index
 *  this answers 0 while the draw pass answers `undefined` and falls back to the hex centroid. That is not a
 *  disagreement about where the token goes -- a token the draw pass cannot place in a city is never drawn from
 *  a slot list, so its bucket entry is inert. Bucketing it somewhere keeps the map total honest; refusing to
 *  draw it in a guessed city keeps the picture honest. Both are the behaviour that was already here. */
export function tokenCityBucket(
  company: StationTokenCompany,
  q: number,
  r: number,
): number {
  return tokenCityIndex(company, q, r) ?? 0;
}

/** The point a token placed in this city NEXT would occupy.
 *
 *  Design note #698: THE PREVIEW WAS ANCHORING TO THE CITY AND THE PLACEMENT DOCKS TO A SLOT.
 *
 *  REPORTED twice in one breath: "the Place Station preview is putting the station in the middle of the tile,
 *  though it moves to a correct position after placement", and the tile picker "shows the existing station
 *  simply in the middle of the pill, not on the actual station."
 *
 *  ONE FAULT, TWO SURFACES. `cityNodePoints` returns the CENTROID OF A CITY'S SLOTS -- exactly right for the
 *  question it was built for (#463: which city did this click land in) and exactly wrong for "where does the
 *  piece go". On a one-slot city the two coincide, which is why this survived: it is only visible on a pill,
 *  where the centroid is the gap BETWEEN the two circles a token can sit in.
 *  The placed token has always been right (`HexGridRenderer` #134/#251 resolves `tileCitySlotPoints` and picks
 *  a slot from the occupant bucket), which is what "it moves to a correct position after placement" is
 *  describing: not a token that moved, but two different anchors, one previewed and one drawn.
 *
 *  `null` when the geometry cannot say -- an unlaid hex, an unknown tile, a city with no slot points. The
 *  caller keeps its existing centroid fallback, which is the honest answer where there is no artwork to dock
 *  into and is what a preprinted OO hex needs. */
export function nextCitySlotPoint(
  mapGrid: MapGridResponse,
  publicCompanies: readonly StationTokenCompany[],
  q: number,
  r: number,
  cityIndex: number | null,
  center: { x: number; y: number },
  hexSize: number,
): { x: number; y: number } | null {
  const laid = mapGrid.tiles.find((tile) => tile.q === q && tile.r === r);
  if (!laid) return null;
  const cityCount = tileCitySlotCounts(laid.tile_id).length;
  if (cityCount === 0) return null;
  /* Same resolution the draw pass makes: a stated index, or the only city there is. A multi-city hex with no
     index cannot be guessed, and guessing would put the preview on the wrong city -- which is worse than the
     centroid it currently falls back to. */
  const city = cityIndex ?? (cityCount === 1 ? 0 : null);
  if (city === null) return null;

  const points = tileCitySlotPoints(laid.tile_id, city, laid.orientation, center, hexSize);
  if (points.length === 0) return null;

  /* How many are already in it. The NEXT slot is the one this placement takes -- the same order the draw pass
     assigns, so the preview promises the circle the token then appears in. */
  let taken = 0;
  for (const company of publicCompanies) {
    if (!company.is_floated) continue;
    for (const [tq, tr] of company.station_token_hexes) {
      if (tq !== q || tr !== r) continue;
      if (tokenCityBucket(company, q, r) === city) taken += 1;
    }
  }
  // Clamped rather than absent: a full city should still preview somewhere, and the last slot is the least
  // misleading place -- the same reasoning #251 gives for clamping the draw pass's own slot index.
  return points[Math.min(taken, points.length - 1)];
}

/* Design note #463: THE NODES A CLICK CAN LAND ON -- every city node on a hex, in CITY INDEX ORDER.
   WHY THIS SHARES `cityIndexAtPoint`'S GEOMETRY, and why that is the whole point rather than mere tidiness: a
   glow is a promise about what a click will do. If the glow were drawn from one source of node positions and
   the hit-test resolved against another, the failure would be the cruellest kind -- a marker that pulses
   invitingly and then places the token somewhere else. Both read the same two branches, in the same order.
   `[]` for a hex with no cities, which draws nothing -- the same silence the hit-test's `null` produces. */
export function cityNodePoints(
  mapGrid: MapGridResponse,
  q: number,
  r: number,
  hexSize: number,
): Array<{ x: number; y: number }> {
  const center = axialToPixel(q, r, hexSize);
  const laid = mapGrid.tiles.find((tile) => tile.q === q && tile.r === r);

  if (!laid) {
    /* Design note #580: THE OTHER HALF OF DESIGN NOTE #221. That note fixed `stationMarkerPoint` and described the
       cause precisely -- preprinted hexes used to draw their city at the hex CENTRE and then began rendering from
       authored artwork, so any function still returning `center` went on pointing at empty tile fill.
       THIS FUNCTION WAS NEVER TOLD. It is the other answer to "where are this hex's cities", used by the pulsing
       placement rings and the click hit-test, and it kept both of the guesses #221 removed: `center` for a single
       city, and `twoNodePositions`' fixed NE/SW diagonal for two. That diagonal is why New York's rings are close
       but wrong -- the authored endpoints and the diagonal agree in DIRECTION while disagreeing in DISTANCE.
       So it reads the artwork, from the same tables `stationMarkerPoint` reads. Two functions answering one
       question, one of them fixed -- the pattern this codebase keeps finding, and the reason the fix is to consult
       the same source rather than to copy the same maths.
       THE FALLBACKS SURVIVE for a hex with no authored artwork at all, the only case the old guesses were right. */
    const hex = STATIC_BOARD_HEXES.find((entry) => entry.q === q && entry.r === r);
    const landmark = LANDMARK_HEXES.find((entry) => entry.q === q && entry.r === r);
    const label = hex?.label ?? landmark?.label;

    // New York prints TWO stations and has its own catalog entry, because
    // `PrintedArtwork.marker` is singular and cannot express a pair.
    if (label === "G19") {
      return NEW_YORK_PRINTED_ARTWORK.markers.map((marker) => ({
        x: center.x + hexSize * marker.at.x,
        y: center.y + hexSize * marker.at.y,
      }));
    }

    // The yellow OO hexes are blank until tiled: no artwork to read, and
    // `twoNodePositions` is the tuple `drawOOCityMarkers` actually draws.
    if (hex && YELLOW_OO_HEXES.has(hex.label)) {
      return [...twoNodePositions(center, hexSize)];
    }

    const printed = label === undefined ? undefined : printedArtwork(label);
    if (printed?.marker) {
      return [
        {
          x: center.x + hexSize * printed.marker.at.x,
          y: center.y + hexSize * printed.marker.at.y,
        },
      ];
    }

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

/* ==================================================================
    DESIGN NOTE 866: THE SLOT A FREE STATION LANDS IN, RESOLVED ONCE
   ==================================================================

   REPORTED of the D&H: "clicking F16 to place the free station token is still calling up the tileselector
   radial menu. Why don't we just have the station automatically placed there with the green checkmark and
   red x above it, since there's no other placement possible in this private power?"

   RIGHT, AND THE CLICK WAS NEVER CARRYING INFORMATION. F16 is Scranton -- a single-city Mountain hex -- so
   by the time the D&H's station step is live there is exactly one slot the token can occupy. The click was
   asking a question with one answer, and because it was a click it also reached the tile inspector, which
   answered a different question on top of it.

   SO THE ANCHOR HAS TO BE COMPUTABLE WITHOUT A POINTER, which it was not: the arithmetic lived inside the
   canvas's own pointer handler, over `view.zoom`/`view.panX` that only the renderer has. This function is
   that arithmetic lifted out whole, so the click path and the auto-staged path resolve the same point by
   construction rather than by two copies agreeing -- the rule this codebase keeps arriving at (#686, #852,
   and #862 for what happens when two surfaces answer one question separately).

   THE FALLBACK CHAIN IS #698'S, UNCHANGED AND IN ITS ORDER: the next free SLOT, then the CITY's own anchor,
   then the sole node, then the hex centroid. Each is a strictly worse answer than the one before and each is
   right when the one before cannot be computed. */
export interface StationSlotAnchor {
  /** Board-relative canvas pixels, through the live pan/zoom -- what a ring anchors to. */
  nodeX: number;
  nodeY: number;
  centroidX: number;
  centroidY: number;
}

export function stationSlotAnchor(input: {
  mapGrid: MapGridResponse;
  publicCompanies: readonly StationTokenCompany[];
  q: number;
  r: number;
  cityIndex: number | null;
  hexSize: number;
  zoom: number;
  panX: number;
  panY: number;
}): StationSlotAnchor {
  const { mapGrid, publicCompanies, q, r, cityIndex, hexSize, zoom, panX, panY } = input;
  const centre = axialToPixel(q, r, hexSize);
  const centroidX = centre.x * zoom + panX;
  const centroidY = centre.y * zoom + panY;
  const nodes = cityNodePoints(mapGrid, q, r, hexSize);
  /* #557: ONE CITY IS NOT AN AMBIGUOUS CITY -- the centroid fallback is right when the geometry cannot say
     and wrong when there is exactly one node. */
  const soleNode = nodes.length === 1 ? nodes[0] : undefined;
  const slotPoint = nextCitySlotPoint(mapGrid, publicCompanies, q, r, cityIndex, centre, hexSize);
  const chosenNode = slotPoint ?? (cityIndex === null ? undefined : nodes[cityIndex]) ?? soleNode;
  return {
    nodeX: chosenNode ? chosenNode.x * zoom + panX : centroidX,
    nodeY: chosenNode ? chosenNode.y * zoom + panY : centroidY,
    centroidX,
    centroidY,
  };
}

/** The one city on this hex, or `null` where the choice is real.
 *
 *  THE GUARD ON AUTO-STAGING, and #858's lesson pointed forwards. That report was "a player can select
 *  G19's other city and place the home station there", and its fix was that a token is in a CITY, not on a
 *  hex. Auto-staging is only honest where the hex has one city to stage into -- so this returns `null` for
 *  two, and the caller falls back to asking. F16 has one today; a future tile catalogue is not this
 *  function's promise to keep. */
export function soleCityIndex(
  mapGrid: MapGridResponse,
  q: number,
  r: number,
  hexSize: number,
): number | null {
  /* `hexSize` is passed through rather than assumed: it does not change the COUNT, but `cityNodePoints` is
     the authority on what a city is here and calling it with a made-up size would be a second opinion about
     that -- the shape of bug #862 caught twice this session. */
  return cityNodePoints(mapGrid, q, r, hexSize).length === 1 ? 0 : null;
}
