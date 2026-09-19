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
  homeReservationStands,
  stationHomeHexes,
  tokenCityIndex,
  type HomeStationEntry,
  type StationTokenCompany,
} from "../components/hexContractTypes";
/* Design note #1511: the reservation's circle is decided by the SAME function the board's ring and click use
   (#858's `homeSlotIndex`), read through the same marker point, so the circle the badge marks, the circle the
   President may click, and the circle the authority holds against everybody else are one answer. */
import { homeSlotIndex, homeSlotsAreOpen, stationMarkerPoint } from "../components/hexCanvasPrimitives";
import type { MapGridResponse } from "../components/hexContractTypes";
import {
  NEW_YORK_PRINTED_ARTWORK,
  printedArtwork,
  printedMarkersFor,
  tileCitySlotCounts,
  tileCitySlotPoints,
} from "../components/TileGraphics";
import {
  LANDMARK_HEXES,
  STATIC_BOARD_HEXES,
  YELLOW_OO_HEXES,
  boardInEffect,
  heraldHexFor,
  type StationTokenSchedule,
} from "../components/hexBoardData";
import { hexKey, reachableCities, reachableNetwork, stationTokensOf } from "./trackReach";
// Design note #1006: the wall the placement gate never asked about.
import { cityBlockerFor } from "./cityBlocking";

/** The home token, granted at float rather than bought. */
export const STATION_TOKEN_HOME_COST = 0;
/** The second token a corporation places. */
export const STATION_TOKEN_SECOND_COST = 40;
/** The third and every one after it. */
export const STATION_TOKEN_LATER_COST = 100;

/** 1830's printed schedule: the home token free, the second $40, every one after $100. */
export const STANDARD_STATION_TOKEN_SCHEDULE: StationTokenSchedule = {
  home: STATION_TOKEN_HOME_COST,
  second: STATION_TOKEN_SECOND_COST,
  later: STATION_TOKEN_LATER_COST,
};

/** Design note #1320: THE SCHEDULE IS THE BOARD'S. The Level Playing Field prices every station after the
 *  home one at $100, and the board is already the value every rule reads under `withRules` -- so the price
 *  follows the board the same way the herald and the home hexes do, and no caller has to thread variants. */
export function stationTokenScheduleInEffect(): StationTokenSchedule {
  return boardInEffect().stationTokenSchedule ?? STANDARD_STATION_TOKEN_SCHEDULE;
}

/** What the token at `placedIndex` costs -- design note #0. `placedIndex` is
 *  0-based, so `0` is the home token. */
export function stationTokenPrice(
  placedIndex: number,
  heraldHome = false,
  schedule: StationTokenSchedule = stationTokenScheduleInEffect(),
): number {
  /* Design note #1302: a corporation whose home is a printed herald (1830+'s PRR) never places a free home
     token -- the herald consumes none -- so its first placement is its SECOND station and costs $40. */
  const index = heraldHome ? placedIndex + 1 : placedIndex;
  if (index <= 0) return schedule.home;
  if (index === 1) return schedule.second;
  return schedule.later;
}

/** Whether `company`'s home is a printed herald on the board in effect (#1302). */
export function hasHeraldHome(company: { company_id?: number } | null | undefined): boolean {
  return company?.company_id !== undefined && heraldHexFor(company.company_id) !== null;
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
  /** #1302: optional so a bare token list still prices; a herald home is only findable by id. */
  company_id?: number;
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
  const heraldHome = hasHeraldHome(company);
  return Array.from({ length: total }, (_, index) => ({
    index,
    cost: stationTokenPrice(index, heraldHome),
    placed: index < placedCount,
    // #1302: with a herald for a home, no slot in the row is the home one.
    isHome: !heraldHome && index === 0,
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
  return stationTokenPrice(placedCount, hasHeraldHome(company));
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

/** How many token circles ONE city on this hex has -- `stationSlotCount` split by circle.
 *
 *  ==================================================================
 *   DESIGN NOTE 1006: THE PER-CITY COUNT MOVES HERE, WHERE THE GATE CAN REACH IT
 *  ==================================================================
 *
 *  This is `App.tsx`'s `citySlotsAt` (#729), lifted verbatim. It lived in the shell because #729's blocker was
 *  ASSEMBLED there -- and being assembled at a call site is precisely what let this batch's bug in, so the
 *  count has to be somewhere a `utils/` module can ask for it.
 *
 *  WHY THIS FILE MAY HOLD IT AND `cityBlocking.ts` MAY NOT. That module's note says the slot counts "live in
 *  the tile catalog under `components/`, which `utils/` may not import for its tables". True of that module,
 *  which imports nothing. This one already imports `tileCitySlotCounts`, `archetypeForHex`, `STATIC_BOARD_HEXES`
 *  and `tokenCityIndex` -- the constraint was never about this file, and `stationSlotCount` directly above has
 *  been reading the catalog since #2.
 *
 *  PREPRINTED CITIES COUNT, which is #729's own warning and the reason the reported hex is Baltimore: New York,
 *  Baltimore and Boston hold tokens before anybody lays anything, so a resolver reading only `tiles` reports
 *  zero slots on exactly the three hexes most worth blocking -- and #729's rule 3 then reads zero as "not a
 *  city" and opens the wall. */
export function citySlotCount(
  mapGrid: MapGridResponse,
  q: number,
  r: number,
  cityIndex: number,
): number {
  const laid = mapGrid.tiles.find((tile) => tile.q === q && tile.r === r);
  if (laid) return tileCitySlotCounts(laid.tile_id)[cityIndex] ?? 0;
  const hex = STATIC_BOARD_HEXES.find((entry) => entry.q === q && entry.r === r);
  if (!hex) return 0;
  const cities = printedMarkersFor(hex.label).filter((marker) => marker.kind === "city");
  if (cities.length > 0) return cities[cityIndex]?.slots ?? (cities.length > cityIndex ? 1 : 0);
  /* Design note #1511: A BARE HEX WITH NO AUTHORED ARTWORK STILL HAS ITS PRINTED CIRCLES. The yellow OO
     hexes (E11, D10, H18, E5) are not in the printed catalog -- they carry no track until a tile is laid --
     and this returned 0 for both of their circles while `stationSlotCount`, one function up, answered 2 for
     the hex. The same archetype answers here, so the per-circle count and the per-hex count agree, and a
     hex-level "two slots" can never be split into two circles of none. */
  const archetype = archetypeForHex(mapGrid, q, r);
  if (archetype === "DoubleCity") return cityIndex === 0 || cityIndex === 1 ? 1 : 0;
  if (archetype === "SingleCity") return cityIndex === 0 ? 1 : 0;
  return 0;
}

export interface StationPlacementCompany {
  company_id: number;
  is_floated: boolean;
  station_token_hexes: ReadonlyArray<readonly [number, number]>;
  station_token_limit: number;
  /** Design note #1511: the recorded `(q, r, city_index)` mirror, so occupancy can be counted per CIRCLE.
   *  Optional for the same reason it is on `StationTokenCompany`: absent means "not recorded", and a token
   *  with no recorded circle is bucketed to city 0 -- `tokenCityBucket`'s convention, not a new one. */
  station_tokens?: ReadonlyArray<readonly [number, number, number]> | null;
}

export interface StationPlacementInput {
  mapGrid: MapGridResponse;
  q: number;
  r: number;
  /** The corporation trying to place. */
  company: StationPlacementCompany;
  /** Every corporation, for slot occupancy and reservations. */
  allCompanies: readonly StationPlacementCompany[];
  /** Design note #893: WHICH CIRCLE, on a hex that has more than one. `null`/absent means "the caller cannot
   *  say", which is the veil's honest position -- it lights hexes -- and keeps the pre-#893 hex-level answer.
   *  The click knows, and passing it is what closes the OO gap. */
  cityIndex?: number | null;
  /** Design note #1323: hexes the placing corporation's network may not cross (`"q,r"` keys). Optional so
   *  every pre-#1323 caller keeps its answer; `barredHexesFor` supplies it. */
  barredHexes?: ReadonlySet<string>;
  /** ==================================================================
   *   DESIGN NOTE 1660 (Stage 9, Slice 9.4b, S9-12): ONE PRINTED EXEMPTION, NAMED RATHER THAN GUESSED
   *  ==================================================================
   *  Every other refusal this function asks -- the corporation's own allowance, whether a city exists, one
   *  token per corporation per city, slot occupancy, the OO-home closure, home reservations, and the circle
   *  question -- is a property of the CITY or of the corporation's own supply, true for the D&H's free
   *  station exactly as it is true for an ordinary paid one. Connectivity is the one printed exception (the
   *  D&H description: "ignoring track connection rules"), and only for the hex the power names -- so it is a
   *  caller's OPT-IN, not a second code path. Absent or `false` is every existing caller's answer, unchanged;
   *  `dhStationAuthority.ts` is the only caller that ever passes `true`, and only after confirming the hex is
   *  F16 and the D&H's own conditions hold, so the exemption cannot travel to a placement this function was
   *  never asked to exempt. */
  skipConnectivity?: boolean;
}

export interface StationPlacementResult {
  allowed: boolean;
  /** Player-facing, written to explain rather than merely refuse. `null`
   *  when allowed. */
  reason: string | null;
}

const ALLOWED: StationPlacementResult = { allowed: true, reason: null };

/** Design note #893: one sentence for the connectivity refusal, so the hex arm and the city arm cannot come
 *  to phrase it two ways. */
const NOT_REACHED: StationPlacementResult = {
  allowed: false,
  reason:
    "This corporation's track does not reach this city. Station tokens may only be placed on the network it already runs.",
};

export function evaluateStationPlacement(
  input: StationPlacementInput,
): StationPlacementResult {
  const { mapGrid, q, r, company, allCompanies, cityIndex, barredHexes, skipConnectivity } = input;
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

  /* ==================================================================
      DESIGN NOTE 1617: A TILED OO HOME HEX IS CLOSED TO EVERY OTHER CORPORATION UNTIL ITS HOME IS PLACED (S8-14)
     ==================================================================
     OWNER RULING (Stage 8, Slice 8.2, S8-14, 2026-09-17), made against the updated revised rulebook and the full
     48-page rulebook, whose base game states the Erie's rule in this conditional form (7.3.2, p. 20) and whose
     OO-starting-hex variant applies the Erie's rules to the Pere Marquette on E5 (V-7.3, p. 32). The Erie may
     put its home in either city of its yellow OO hex (E11), and so may the Level Playing Field's PMQ on E5 (#1611).
     What the home is protected by depends on the hex:
       * BEFORE A TILE IS LAID THERE, the ordinary future-home rule is enough (§6.3.2): another corporation may take
         one of the two cities if it is otherwise legal, but never the last one -- the hex-level reservation arm
         below keeps one slot for the home corporation.
       * ONCE A TILE HAS BEEN LAID OR UPGRADED THERE, and until the home corporation places its home, NO OTHER
         corporation may place a station anywhere on the hex -- in either city, however many slots are free. A
         foreign station placed legally before the tile stays where it is (an upgrade keeps the stations on the
         hex); nothing may be added beside it.
       * ONCE THE HOME IS PLACED the reservation is spent (`homeReservationStands`) and ordinary rules govern.
     The home corporation is never refused by its own reservation and needs no tile first: its home goes in either
     free city of the hex, tiled or not (#1611). "A tile has been laid" means a tile on the grid that the board did
     not print there (#1301's `printed`); no board prints one on E11 or E5. The OO homes are the entries on a hex
     where the president picks the circle (`homeSlotsAreOpen`, #742) -- the Erie's E11 and the PMQ's E5 -- so New
     York's locked circle (#858 / #1511) and the C&O's two cities (#1325) are untouched. One predicate, asked by the
     reducer's gate, by ingress (through `stationPlacementRefusal`), by the veil and by the click. */
  const closedHome = closedOoHomeAt(mapGrid, q, r, company, allCompanies);
  if (closedHome !== null) {
    const owner = allCompanies.find((entry) => entry.company_id === closedHome.companyId) as
      | (StationPlacementCompany & { ticker?: string })
      | undefined;
    const who = owner?.ticker ?? `Company #${closedHome.companyId}`;
    return {
      allowed: false,
      reason:
        `${who} has not placed its home station on ${closedHome.label} yet and a tile has been laid there, ` +
        `so no other corporation may place a station on ${closedHome.label} until it does.`,
    };
  }

  /* Reservations. Every corporation's home city holds a slot for it from the start of the game, floated or not.
     THE RESERVATION IS RELEASED BY USE, not by floating: a company that has floated AND placed its home token is
     occupying the slot rather than reserving it, and its token is already counted above. So the test is "does
     this hex reserve a slot for somebody who has not taken it yet".
     That distinction matters on the shared OO hexes: ERIE's home is a two-city hex, so before ERIE floats another
     corporation may still take the OTHER circle -- reserving both would over-block it. (Slice 8.2, #1617: true
     until a tile is laid there; from then until the home is placed, the arm above closes the whole hex.) */
  const unclaimedReservations = stationHomeHexes().filter((home) => {
    if (home.q !== q || home.r !== r) return false;
    if (home.companyId === company.company_id) return false;
    // Design note #1325: an unenforced reservation (C&O at Cleveland) draws a marker and holds nothing.
    if (home.enforced === false) return false;
    const owner = allCompanies.find((entry) => entry.company_id === home.companyId);
    // #1325: released by use -- of THIS hex, or of any hex for a corporation with two homes.
    return homeReservationStands(owner, home);
  }).length;

  if (occupied + unclaimedReservations >= slots) {
    const reserver = stationHomeHexes().find(
      (home) => home.q === q && home.r === r && home.companyId !== company.company_id,
    );
    return {
      allowed: false,
      reason: `This city's remaining slot is reserved as a home station${
        reserver ? ` for company #${reserver.companyId}` : ""
      } and cannot be taken.`,
    };
  }

  /* ==================================================================
      DESIGN NOTE 1511: A TOKEN IS IN A CIRCLE, AND SO IS A RESERVATION
     ==================================================================
     REPORTED, from live play (JUNO-FCJ index 95): B&M placed a paid token in NNH's home station at New York.
     NNH had not floated; its reservation stood; the placement was allowed by this function, and the arm
     applied it. Three more tokens followed into the same one-slot circle over the game.

     THE THREE ARMS ABOVE ARE HEX-LEVEL, and that is the whole fault. New York is two cities of one slot
     each, so `slots` is 2. The reservation arm counts NNH's home as ONE slot held somewhere on the hex --
     right for an OO hex, where the President chooses either circle (#43, #1283) -- and B&M's token in the
     circle the badge is drawn in left "one slot for NNH" arithmetically true and physically false. #858
     had already settled that NNH's home is LOCKED to one circle and made the click honour it; the gate that
     judges everybody else's clicks had never been told. And once a circle is full, the occupancy arm above
     still sees a hex with room, so the second, third and fourth tokens landed in the same circle too.

     SO WHEN THE CALLER NAMES A CIRCLE, THE CIRCLE IS JUDGED: its own slot count, its own occupants, and any
     home reservation locked to it. The hex-level arms stay, because they are still right about what they
     measure -- an OO reservation really is "one slot somewhere on this hex" -- and because a caller that
     cannot name a circle (the veil) needs a hex answer. That answer is refined below rather than replaced:
     a multi-city hex is worth lighting when SOME circle on it may be taken, which is what a hex-level
     question means when it is asked about a hex with more than one city. */
  const cityCount = cityCountAt(mapGrid, q, r);
  if (cityIndex === null || cityIndex === undefined) {
    if (cityCount > 1) {
      let firstRefusal: StationPlacementResult | null = null;
      for (let index = 0; index < cityCount; index += 1) {
        const verdict = evaluateStationPlacement({ ...input, cityIndex: index });
        if (verdict.allowed) return verdict;
        if (firstRefusal === null) firstRefusal = verdict;
      }
      return firstRefusal ?? NOT_REACHED;
    }
  } else {
    const citySlots = citySlotCount(mapGrid, q, r, cityIndex);
    if (citySlots === 0) {
      return {
        allowed: false,
        reason: `There is no city ${cityIndex + 1} on this hex.`,
      };
    }
    const occupiedInCity = allCompanies.reduce(
      (count, entry) => count + (here(entry.station_token_hexes) && tokenCircleOf(entry, q, r) === cityIndex ? 1 : 0),
      0,
    );
    if (occupiedInCity >= citySlots) {
      return {
        allowed: false,
        reason:
          citySlots === 1
            ? "This city's only station slot is taken."
            : `All ${citySlots} of this city's station slots are taken.`,
      };
    }
    const lockedHere = stationHomeHexes().filter((home) => {
      if (home.q !== q || home.r !== r) return false;
      if (home.companyId === company.company_id) return false;
      if (home.enforced === false) return false;
      const owner = allCompanies.find((entry) => entry.company_id === home.companyId);
      if (!homeReservationStands(owner, home)) return false;
      return homeReservedCityIndex(mapGrid, home) === cityIndex;
    });
    if (occupiedInCity + lockedHere.length >= citySlots) {
      return {
        allowed: false,
        reason: `This station is reserved as the home station for company #${lockedHere[0].companyId} and cannot be taken.`,
      };
    }
  }

  /* Design note #1660 (S9-12): THE ONE OPT-IN EXEMPTION, ASKED LAST FOR THE SAME REASON CONNECTIVITY ITSELF
     IS ASKED LAST. Every refusal above this line is a property of the city or of the corporation's own
     supply and applies to the D&H's free station exactly as to an ordinary paid one; this line is the only
     place `skipConnectivity` has anything to skip, so it changes nothing else about the function. */
  if (skipConnectivity) return ALLOWED;

  /* Connectivity, LAST and deliberately. The three refusals above are properties of the CITY and are true for
     everybody; this one is about the acting corporation, and a player who has been told "that city is full" does
     not also need to be told their track does not reach it.
     A corporation with no token yet has no network to measure, and its first placement is its home city -- which
     the contract grants at float rather than asking for. Rather than guess, that case is allowed through.
     ==================================================================
      DESIGN NOTE 1277: A HERALD IS A NETWORK, EVEN WITH NO TOKEN DOWN
     ==================================================================
     REPORTED (LPF): "when PRR is prompted to place a station, every hex on the board with an open city is
     illuminated ... it is only able to place a station where it has connectivity." PRR's home on 1830+ is
     #1302's herald -- a root in `stationTokensOf` but never an entry in `station_token_hexes` -- so the test
     above read "no token yet", took the allowed-through arm, and the veil lit the whole board. The exemption
     is for a corporation with NO NETWORK, and a herald is one; so the question is asked of the reader that
     knows about heralds, and PRR's first token is measured from H12 like everybody else's from their home. */
  if (stationTokensOf(company).length > 0) {
    /* ==================================================================
       DESIGN NOTE 893: THE QUESTION IS ABOUT A CIRCLE, NOT ABOUT A HEX
       ==================================================================
       REPORTED: "on OO tiles, corporations are allowed to place stations on cities they don't actually have
       connectivity to (e.g., D10/E11) ... the Station Marker subphase allows it to place a station in almost
       any city on the board, including the discontinuous jump from E11 to D10."
       THIS ASKED `network.has(hexKey(q, r))` -- the HEX-level set -- and a hex is in that set when the
       network reaches EITHER of its circles. On an OO tile whose two cities do not join, reaching the left
       one read as permission to stand in the right one. The walk was never wrong; it was answering a coarser
       question than a token asks.
       #852 FOUND THIS IN THE ROUTE SEARCH and #686 in this walk's own start, both on New York. This is the
       third caller and the same sentence applies: a token is in a CITY, not on a hex.
       `cityIndex` IS OPTIONAL AND THE ABSENT CASE IS DELIBERATELY THE OLD ONE. `placeableStationHexes` lights
       HEXES and cannot name a circle -- a hex with one reachable city is a hex worth lighting -- so a caller
       that does not say which circle it means still gets the hex-level answer. The caller that DOES know is
       the click, and #893 in `App.tsx` is where it started saying so.
       SINGLE-CITY HEXES ARE UNAFFECTED either way: their one circle and their hex are the same question. */
    /* ==================================================================
       DESIGN NOTE 1006: THE GATE WAS THE FOURTH CALLER, AND #729 NEVER REACHED IT
       ==================================================================
       REPORTED: "C&O was able to place a station marker on hexes J14 and K15 by tracing a route through the
       Baltimore hex. However, Baltimore was completely tokened out by B&O."

       #729 TAUGHT THE WALK ABOUT TOKENS AND THE WALK WAS NEVER THE PROBLEM. `reachableTrack` has taken a
       `blocksThrough` predicate since that note, drops a blocked city's exits, and `cityBlocking.ts` states the
       three rules correctly. What #729 could not do is make anybody PASS it: the predicate is an optional
       third argument whose omitted case is "no blocking", and these two lines omitted it. So the tile-lay veil
       walked a walled board, the token veil's network tier walked a walled board, the route tracer walked a
       walled board (#730), and the one function that decides whether a placement is LEGAL walked an open one.

       AN OPTIONAL ARGUMENT IS AN OPT-IN RULE, which is the real lesson and the reason the fix is shaped this
       way. #729 threaded the blocker through three call sites in `App.tsx` and this fourth caller simply never
       came up -- not overruled, not exempted, never asked. The predicate is now BUILT HERE, from `company`,
       `allCompanies` and `mapGrid`, all three of which this function already has in hand. There is no call
       site left to forget it at, and `placeableStationHexes` and `stationPlacementBlockReason` inherit the
       rule by construction rather than by a second edit that could be missed the same way.

       #891's SHAPE, ONE MORE TIME: two surfaces answering one question two ways. The veil BEHIND the token
       highlight already dimmed the far side of Baltimore -- `App.tsx` passes `blocksThroughCity` to
       `reachableNetwork` for exactly that tier -- while the highlight ON TOP of it lit J14. The board was
       drawing the wall and the gate was letting the player walk through it, in the same frame.

       THE DESTINATION CITY IS NOT AFFECTED, deliberately. #729's "REACHED, BUT NOT PASSED" keeps a blocked
       city in `hexes` and in `cities`, because a train may END in a city it cannot cross -- so this does not
       start refusing placements in Baltimore itself. Those are already refused, several checks above, by the
       slot-occupancy arm that counts every corporation's tokens. Two rules, two refusals, two sentences.

       AND NEVER AGAINST ITS OWN TOKENS: `cityBlockerFor` is bound to `company.company_id`, so rule 2 exempts
       the corporation from its own walls -- and from any city it shares. A blocker bound to the wrong
       corporation would wall a company out of its own network, which is the failure mode that argues for
       building it here from `company` rather than accepting one from a caller who may mean somebody else. */
    const blocksThrough = cityBlockerFor({
      actingCompanyId: company.company_id,
      companies: allCompanies,
      slotsAt: (bq, br, bCity) => citySlotCount(mapGrid, bq, br, bCity),
      cityOf: (holder, hq, hr) =>
        tokenCityIndex(holder as unknown as StationTokenCompany, hq, hr),
      barredHexes, // #1323
    });
    const tokens = stationTokensOf(company);
    if (cityIndex === null || cityIndex === undefined) {
      const network = reachableNetwork(mapGrid, tokens, blocksThrough);
      if (!network.has(hexKey(q, r))) return NOT_REACHED;
    } else {
      const cities = reachableCities(mapGrid, tokens, blocksThrough);
      if (!cities.has(`${hexKey(q, r)}:${cityIndex}`)) return NOT_REACHED;
    }
  }

  return ALLOWED;
}

/** Design note #1617: the OO home that closes `(q, r)` to `company`, or `null`. Closed means: another corporation's
 *  home entry on this hex, on a hex where the president picks the circle (the Erie's E11, the Level Playing Field's
 *  PMQ E5), with its reservation still standing (that corporation has placed no home), and a tile laid on the hex
 *  in play (a printed tile does not count). */
export function closedOoHomeAt(
  mapGrid: MapGridResponse,
  q: number,
  r: number,
  company: Pick<StationPlacementCompany, "company_id">,
  allCompanies: readonly StationPlacementCompany[],
): HomeStationEntry | null {
  const tiled = mapGrid.tiles.some((tile) => tile.q === q && tile.r === r && tile.printed !== true);
  if (!tiled) return null;
  return (
    stationHomeHexes().find((home) => {
      if (home.q !== q || home.r !== r) return false;
      if (home.companyId === company.company_id) return false;
      if (home.enforced === false) return false;
      if (!homeSlotsAreOpen(home.label)) return false;
      const owner = allCompanies.find((entry) => entry.company_id === home.companyId);
      return homeReservationStands(owner, home);
    }) ?? null
  );
}

/** How many cities this hex has -- `citySlotCount` split the other way. A laid tile knows; a preprinted hex
 *  has one per printed city marker; a hex with no city has none. */
export function cityCountAt(mapGrid: MapGridResponse, q: number, r: number): number {
  const laid = mapGrid.tiles.find((tile) => tile.q === q && tile.r === r);
  if (laid) return tileCitySlotCounts(laid.tile_id).length;
  const hex = STATIC_BOARD_HEXES.find((entry) => entry.q === q && entry.r === r);
  if (!hex) return 0;
  const printed = printedMarkersFor(hex.label).filter((marker) => marker.kind === "city").length;
  if (printed > 0) return printed;
  const archetype = archetypeForHex(mapGrid, q, r);
  return archetype === "DoubleCity" ? 2 : archetype === "SingleCity" ? 1 : 0;
}

/** Which circle a company's token on `(q, r)` sits in, for the gate -- `tokenCityBucket`'s rule (#698) over
 *  the gate's own company shape: the recorded index, else city 0. */
function tokenCircleOf(company: StationPlacementCompany, q: number, r: number): number {
  const entry = company.station_tokens?.find(([tq, tr]) => tq === q && tr === r);
  return entry ? entry[2] : 0;
}

/** Design note #1511: WHICH CIRCLE A HOME RESERVATION HOLDS, or `null` where it holds "one of them".
 *
 *  THE SAME ANSWER THE BOARD GIVES. `homeSlotIndex` (#858) is what lights the ring for a Place Home Station
 *  prompt and what the click is checked against: `null` on an OO hex, where the President chooses either
 *  circle (#742), and otherwise the circle nearest the reservation badge -- on New York, the first. It is
 *  asked here through the same two readers (`cityNodePoints`, `stationMarkerPoint`) so the circle the badge
 *  marks and the circle held against other corporations cannot drift apart.
 *
 *  THE SIZE IS NOMINAL. Both readers scale with it and the nearest-node question is invariant under scale,
 *  so any positive size gives the index the renderer gives at its own. A hex with no city returns `null`:
 *  there is no circle to hold, and the hex-level arms have already said so. */
const RESERVATION_GEOMETRY_SIZE = 100;

export function homeReservedCityIndex(mapGrid: MapGridResponse, home: HomeStationEntry): number | null {
  const nodes = cityNodePoints(mapGrid, home.q, home.r, RESERVATION_GEOMETRY_SIZE);
  if (nodes.length === 0) return null;
  if (nodes.length === 1) return 0;
  const laid = mapGrid.tiles.find((tile) => tile.q === home.q && tile.r === home.r);
  return homeSlotIndex(
    home.label,
    nodes,
    stationMarkerPoint(home.q, home.r, RESERVATION_GEOMETRY_SIZE, laid),
  );
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

/* ==================================================================
    DESIGN NOTE 1181: THE RING LIT THE CITY WHILE THE TOKEN DOCKED IN A SLOT
   ==================================================================
   REPORTED: "when placing Home Station tokens on green/brown tiles, the station glow ring is just centered on
   the tile, not set on the stations."
   #698 DIAGNOSED THIS EXACT THING ON THE OTHER SURFACE and fixed only that one. Its words: "the preview
   anchored HERE, to a city, and the placed token docks into a SLOT ... On a one-slot city those are the same
   point, which is why this held for so long; on a pill the city's anchor is the gap BETWEEN the two circles a
   token can occupy." That is why it is a green/brown report: yellow cities are single slots, and an upgrade
   is what turns a city into a pill.
   SO #698 GAVE THE ANCHOR `nextCitySlotPoint` AND LEFT THE GLOW ON `cityNodePoints`. The confirm ring landed
   on the circle and the pulsing ring stayed in the gap -- two surfaces answering "where does this token go"
   with two functions, which is the fault this codebase finds most (#584, #858, #862, #866 all in this file).
   ONE FUNCTION, CALLED BY BOTH. #858 already argued this for `homeSlotIndex`: "the circle that lights and the
   circle that may be clicked cannot diverge." The same sentence applies to the circle that lights and the
   circle the token docks into, and this is that function.
   THE FALLBACK IS THE CITY NODE, deliberately and in #698's order: a preprinted OO hex has no artwork to dock
   into, and a city whose slots cannot be resolved is still better rung at its own anchor than not at all. */
export function homeRingPoints(input: {
  mapGrid: MapGridResponse;
  publicCompanies: readonly StationTokenCompany[];
  q: number;
  r: number;
  hexSize: number;
  /** The city a home station is locked to, or `null` where the president may choose (#742/#858). */
  homeCityIndex: number | null;
}): Array<{ x: number; y: number }> {
  const { mapGrid, publicCompanies, q, r, hexSize, homeCityIndex } = input;
  const centre = axialToPixel(q, r, hexSize);
  const nodes = cityNodePoints(mapGrid, q, r, hexSize);
  /* `null` MEANS EVERY CITY HERE, not "unknown" -- #742's distinction, carried through rather than re-derived.
     On an OO hex both slots are the president's to pick, so both light. */
  const cities = homeCityIndex === null ? nodes.map((_, index) => index) : [homeCityIndex];
  const out: Array<{ x: number; y: number }> = [];
  for (const city of cities) {
    const slot = nextCitySlotPoint(mapGrid, publicCompanies, q, r, city, centre, hexSize);
    const point = slot ?? nodes[city];
    if (point) out.push(point);
  }
  return out;
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
