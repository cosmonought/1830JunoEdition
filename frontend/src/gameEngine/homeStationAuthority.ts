// frontend/src/gameEngine/homeStationAuthority.ts
//
// When a corporation owes its home station, where it may put it, and what nothing else may do meanwhile.
// Stage 8, Slice 8.2 (S8-5 / S8-6 / S8-12 / S8-13). One module, asked by the reducer, by ingress
// (`turnRefusal`), by the derived-action loop (`nextDerivedAction`), by the replay's development-corpus adapter
// and by the shell's prompt -- so the five cannot come to disagree about the one rule.
//
// ==================================================================
//  DESIGN NOTE 1610: THE HOME STATION IS OWED AT THE START OF THE FIRST OPERATING TURN, AND NOWHERE ELSE
// ==================================================================
//
// RULE (revised 2018 rulebook, the Classic authority). 6.1 Special: "At the start of a railroad's first turn of
// operation, it places one of its tokens in its starting city to create its home station". 6.3.1: "At the
// beginning of a railroad's first turn of operation, it must place a token in its starting city circle to
// create its home station. There is no cost to perform this action." 6.3.1's note: the Erie home station may go
// on either city of its yellow hex, and neither the Erie nor the NYC has to place a tile in its starting hex.
// 6.3.2: "A railroad may not place a token in a city if it would block the creation of the home station of a
// railroad that has not yet operated." 5.3: a floated corporation "begins operating in the next operating
// round".
//
// WHAT THE MACHINE DID (#416 / #763 / #769 / #769a, retired here). The token was owed from the moment of the
// FLOAT, in any round: `pendingHomeTokens` listed every floated corporation without a token, `homeTokenBlock`
// refused every message at the table while one was listed, and the `BuyStock` arm held the buyer's seat until
// the placement released it. That froze a Stock Round for a placement the rules make at an Operating turn,
// and it put the token on the board one Operating Round early -- where it could already be blocked around,
// routed through, or counted.
//
// THE OBLIGATION IS DERIVED, NEVER STORED. A corporation owes its home station iff: the round is an Operating
// Round; it is the corporation under the cursor (`operatingCorporationId`); it is floated; its home resolves
// on the board in effect; its home is not a printed herald (#1302, PRR on Project 18XX+ owes none); and it
// holds no station token yet. "First turn of operation" IS "operating corporation with no token", because the
// hold below guarantees no turn action can precede the placement and a corporation never loses its home
// token. No `needs_home_token` flag: a flag is a second copy of the cursor that can drift from it, and a
// replay, a `RevertTo` and a restart all rebuild the cursor for free.
//
// CONSEQUENCES, each by construction rather than by a special case:
//   * floating in a Stock Round owes nothing and holds nothing -- the SR proceeds, the seat advances as for
//     any purchase, and no token lands;
//   * a corporation that floats but never reaches a turn (game end, bankruptcy) never touches the map;
//   * a corporation floated while an Operating Round is open is outside that round's frozen membership (#1600)
//     and owes nothing until its first turn of the next one;
//   * another corporation lacking its home never holds the corporation that IS operating.
//
// "HOLDS NO TOKEN" IS #1325's TEST, kept: a two-home corporation (the Level Playing Field's C&O) has
// established its home the moment it sits on either candidate, and for a single-home corporation the two tests
// agree because its first token is its home.
//
// ==================================================================
//  DESIGN NOTE 1611: WHERE THE HOME MAY GO -- ONE PREDICATE FOR EVERY CORPORATION AND EVERY BOARD
// ==================================================================
//
// `homePlacementRefusal` is the ONE legality predicate for `PlaceHomeStation{kind: "home"}`. The message's
// `q`, `r` and `city_index` are a CHOICE to be judged, never a fact to be trusted -- #1325's "a log written for a
// single-home corporation keeps replaying to wherever it recorded" is withdrawn (S8-6, S10-17).
//
// In order: the corporation exists; its home is not a herald; its home is not already established; it has a
// home on this board; it is floated; it is the operating corporation (so the obligation is due NOW -- this also
// refuses a Stock Round placement, a second placement and a placement for a corporation that is not operating);
// the hex is one of its candidate homes; then, on a grid, the circle: a one-city hex takes `null` or `0`; a
// hex of several cities must NAME the circle; a circle outside the hex is refused; a fixed home on a two-city
// hex that is not an "either slot" hex (NNH's New York, #858) is locked to its reserved circle; and the circle
// must be AVAILABLE by the same per-circle reader every paid placement is judged by
// (`evaluateStationPlacement`: occupancy, the one-token-per-city rule, the allowance, OTHER corporations' home
// reservations). Connectivity is not asked: a corporation with no token has no network, and the home is where
// its network starts. No tile is required on the hex: an untiled printed city has its printed circles
// (`cityCountAt`), which is 6.3.1's note for E11 and E19.
//
// WITHOUT A GRID the board-dependent arms are not asked, on #757's rule (the grid is the one input the state
// does not hold); every live path -- `RoomEngine`, the server, the shell -- supplies it.
//
// THE CANDIDATE HOMES (`homeHexChoicesFor`), per board:
//   * ORDINARY FIXED HOMES -- the corporation's printed home, one hex.
//   * ERIE (E11, Buffalo/Dunkirk OO) -- one hex, EITHER city: its circle is not locked (`homeSlotsAreOpen`,
//     #742), so whichever circle is free and legal is accepted. 6.3.1.
//   * PMQ (Level Playing Field, Detroit/Windsor E5 OO) -- the full rulebook's Scenario D applies the Erie's
//     starting-hex rules to the Pere Marquette, so PMQ is exactly Erie's case on E5: either city, free, no tile.
//   * N&W (Level Playing Field) -- Scenario D prints Norfolk (L16) as its base city: a normal fixed home. The
//     separate "Multiple Starting Hexes" variant is NOT imported into Scenario D.
//   * NYC (E19) -- a fixed home that needs no tile first (6.3.1's note); the later #57 lay is its own rule.
//   * C&O (Level Playing Field) -- Scenario D: at the start of its first turn C&O places its free home in
//     EITHER Cleveland (F6) or Richmond (K13). The two are NOT symmetric: Richmond is reserved for C&O until C&O
//     places its home; Cleveland is not reserved at all and may be tokened -- even closed out -- by other
//     corporations first, in which case Richmond is C&O's only home. Choosing Cleveland releases Richmond at
//     once; choosing Richmond ends the choice. The unchosen city is forfeited as a home: C&O may later station
//     there only as an ordinary station (connectivity, a free circle, the allowance, the variant's $100). The
//     board encodes the asymmetry (#1325: `LPF_HOME_STATIONS` lists F6 `enforced: false`, K13 enforced), the
//     reservation reader honours it (`evaluateStationPlacement` skips an unenforced entry), and this
//     predicate's availability arm is that same reader -- so "closed-out Cleveland is not a legal home" and
//     "Richmond is still free" are the reservation rule, not a second one.
// A board entry is a candidate for a corporation only when the board table and the state agree about whose
// home it is (the board's list for that company includes the state's `home_hex_label`); otherwise the state's
// label is the one home. That keeps a hand-built fixture whose ids do not match the printed table from
// acquiring another corporation's hex.
//
// NOT HERE: the D&H's free station (`kind: "dh"`). It shares the message and is governed by the D&H's own
// rules (`dhPower.ts`, the owner at ingress); it is not a home placement and never takes the home slot (#1615).
//
// Source authority for the Level Playing Field facts above, checked for Slice 8.2 against the full 48-page
// Lookout/Mayfair rulebook (`1830 FULL RULES with variants.pdf`, repository root), S-1.0 "A Level Playing Field"
// (Scenario D), scenario rules S-1.2: The Stock Market (5.0), p. 34 -- N&W's base city is Norfolk L-16, PMQ's is
// Detroit/Windsor E-5 and PMQ may start in either city; Construct Track (7.2), p. 35 -- the base game's Erie track
// rules apply to the PMQ as well; Place a Station (7.3), p. 35 -- the C&O rule as summarised above (Richmond closed
// to other railroads until C&O lays its first token, Cleveland closable, a Cleveland start frees Richmond, both
// only with a valid connection); Table T-08, p. 47 -- C&O Cleveland F-6 (Richmond K-13), N&W Norfolk L-16, PMQ
// Detroit E-5. The same 7.3 prints a flat $100 station price; the owner's reading, implemented here, keeps the
// home free (the base game's 7.3.1: the home costs nothing) and charges $100 for every ordinary station after it,
// with no $40 first additional station. (The full book's base game states 6.1 / 6.3.1 / 6.3.2 above as 7.1 / 7.3.1
// / 7.3.2, pp. 17 and 20; the revised 2018 book controls the Classic rules it covers.)
//
// ==================================================================
//  DESIGN NOTE 1612: THE HOLD IS TURN-LOCAL, AND IT IS ONE SENTENCE AT BOTH LOCKS
// ==================================================================
//
// While the OPERATING corporation owes its home, nothing but the placement happens: every other message is
// refused -- by identity in the reducer, with this sentence at ingress (S8-12, the fourth hold after the
// discard, funding and offer holds), and the derived-action loop owes nothing (the game must not walk a
// tokenless corporation through Tokens, Routes, Dividends and Hardware on its behalf). The pass list is
// stated here once and asked by both locks: the home placement itself (its legality is the predicate above),
// `RevertTo` (resolved on the log, #1026), `CloseRoom`, and #763's legacy `UndoLastAction` (a no-op arm, kept
// so the hold's exits are exactly what they were). A D&H placement is NOT a pass: a corporation that has not
// placed its home cannot have laid the D&H tile this turn.
// Because the obligation is defined on the cursor, the hold can only engage at the start of that corporation's
// own first turn: it never freezes a Stock Round, another corporation's turn, or a table waiting on a future
// corporation.

import type { GameStateResponse, PublicCompanyState } from "./gameState";
import type { GameplayExecuteMsg } from "../utils/sessionKey";
import type { MapGridResponse } from "../components/hexContractTypes";
import { homeHexesFor } from "../components/hexContractTypes";
import { STATIC_BOARD_HEXES, heraldHexFor } from "../components/hexBoardData";
import { operatingCorporationId } from "./dividendGate";
import { cityCountAt, evaluateStationPlacement, homeReservedCityIndex } from "./stationTokens";

/** A board's `label -> (q, r)` table (#363). */
export type HomeHexToAxial = (label: string) => readonly [number, number] | null;

/** The board in effect's own label table -- the same lookup `App.tsx` (#416) and `replayProviders` (#1189)
 *  hand the reducer, for the askers that have no injection to hand in (ingress, the derived loop). */
export function boardHomeHexToAxial(label: string): readonly [number, number] | null {
  const hex = STATIC_BOARD_HEXES.find((entry) => entry.label === label);
  return hex ? ([hex.q, hex.r] as const) : null;
}

/** One hex a corporation's home station may go on. */
export interface HomeHexChoice {
  hexLabel: string;
  q: number;
  r: number;
}

/** One legal circle for a home station. */
export interface HomeTarget extends HomeHexChoice {
  cityIndex: number;
}

type HomeCompany = Pick<PublicCompanyState, "company_id" | "home_hex_label" | "station_token_hexes">;

/** Design note #1611: every hex this corporation's home station may go on, its printed home first. Empty when
 *  the corporation has no home that resolves on this board (#416: "absent rather than pending"). */
export function homeHexChoicesFor(company: HomeCompany, homeHexToAxial: HomeHexToAxial): HomeHexChoice[] {
  const label = company.home_hex_label;
  if (!label) return [];
  const axial = homeHexToAxial(label);
  if (!axial) return [];
  const primary: HomeHexChoice = { hexLabel: label, q: axial[0], r: axial[1] };
  const printed = homeHexesFor(company.company_id);
  if (!printed.some((home) => home.label === label)) return [primary];
  return [
    primary,
    ...printed
      .filter((home) => home.label !== label)
      .map((home) => ({ hexLabel: home.label, q: home.q, r: home.r })),
  ];
}

/** Design note #1302: a home that is a printed herald owes no token -- there is no city to put one in. */
export function homeIsHerald(companyId: number): boolean {
  return heraldHexFor(companyId) !== null;
}

/** Design note #1325 / #1610: the home is established the moment the corporation holds any token. */
export function homeEstablished(company: Pick<PublicCompanyState, "station_token_hexes">): boolean {
  return (company.station_token_hexes ?? []).length > 0;
}

/** The corporation under the Operating Round cursor, or `null`. Guarded for a board that carries no queue. */
function operatingCompanyOf(state: GameStateResponse): PublicCompanyState | null {
  if (state.current_round_type !== "OperatingRound" || !Array.isArray(state.active_operating_order)) return null;
  const companyId = operatingCorporationId(state);
  if (companyId === null) return null;
  return (state.public_companies ?? []).find((entry) => entry.company_id === companyId) ?? null;
}

/** What the operating corporation owes, when it owes its home station. */
export interface OwedHomeStation {
  companyId: number;
  ticker: string;
  president: string | null;
  /** Every candidate hex, the printed home first (#1611). Not filtered by availability -- that is the grid's
   *  question (`legalHomeTargets`). */
  choices: HomeHexChoice[];
}

/** Design note #1610: the obligation, derived on the cursor. `null` unless the corporation under the Operating
 *  Round cursor is floated, has a resolvable non-herald home and holds no token. */
export function owedHomeStation(state: GameStateResponse, homeHexToAxial: HomeHexToAxial): OwedHomeStation | null {
  const company = operatingCompanyOf(state);
  if (!company || !company.is_floated) return null;
  if (homeIsHerald(company.company_id) || homeEstablished(company)) return null;
  const choices = homeHexChoicesFor(company, homeHexToAxial);
  if (choices.length === 0) return null;
  return { companyId: company.company_id, ticker: company.ticker, president: company.president ?? null, choices };
}

/** Whether `companyId` owes its home station right now. */
export function homeStationOwed(state: GameStateResponse, companyId: number, homeHexToAxial: HomeHexToAxial): boolean {
  return owedHomeStation(state, homeHexToAxial)?.companyId === companyId;
}

/** "F6 or K13". */
export function describeHomeChoices(choices: ReadonlyArray<HomeHexChoice>): string {
  return choices.map((choice) => choice.hexLabel).join(" or ");
}

/** The body of a `PlaceHomeStation`, as far as the rule reads it. */
export interface HomePlacement {
  company_id: number;
  q: number;
  r: number;
  city_index?: number | null;
  kind?: string;
}

function hexLabelAt(q: number, r: number): string {
  return STATIC_BOARD_HEXES.find((hex) => hex.q === q && hex.r === r)?.label ?? `(${q}, ${r})`;
}

/** Design note #1611: why this home placement must not be applied, or `null` if it may be. For `kind: "home"`
 *  (or no kind); a D&H placement is not a home placement and is not judged here. */
export function homePlacementRefusal(
  state: GameStateResponse,
  placement: HomePlacement,
  mapGrid: MapGridResponse | undefined,
  homeHexToAxial: HomeHexToAxial,
): string | null {
  const company = (state.public_companies ?? []).find((entry) => entry.company_id === placement.company_id);
  if (!company) return "That corporation is not in this game.";
  const { ticker } = company;
  if (homeIsHerald(company.company_id)) {
    return `${ticker}'s home is printed on the board, so it places no home station.`;
  }
  if (homeEstablished(company)) return `${ticker}'s home station is already on the board.`;
  const choices = homeHexChoicesFor(company, homeHexToAxial);
  if (choices.length === 0) return `${ticker} has no home station on this board.`;
  if (!company.is_floated) {
    return `${ticker} has not floated. A corporation places its home station at the start of its first operating turn.`;
  }
  if (operatingCompanyOf(state)?.company_id !== company.company_id) {
    return `${ticker} places its home station at the start of its first operating turn, and it is not operating now.`;
  }
  const choice = choices.find((entry) => entry.q === placement.q && entry.r === placement.r);
  if (!choice) {
    return `${ticker}'s home station goes on ${describeHomeChoices(choices)}, not on ${hexLabelAt(placement.q, placement.r)}.`;
  }
  if (mapGrid === undefined) return null; // #757: the board-dependent arms need the grid

  const cities = cityCountAt(mapGrid, choice.q, choice.r);
  if (cities === 0) return `${choice.hexLabel} has no city to place a station in.`;
  const requested = placement.city_index ?? null;
  let cityIndex: number;
  if (cities === 1) {
    if (requested !== null && requested !== 0) return `${choice.hexLabel} has one city; there is no city ${requested + 1} there.`;
    cityIndex = 0;
  } else {
    if (requested === null) {
      return `${choice.hexLabel} has ${cities} cities; the placement must say which one ${ticker}'s home station goes in.`;
    }
    if (!Number.isInteger(requested) || requested < 0 || requested >= cities) {
      return `There is no city ${requested + 1} on ${choice.hexLabel}.`;
    }
    cityIndex = requested;
    /* #858 / #1511: a fixed home on a two-city hex that is not an "either slot" hex is the circle its
       reservation marks; an OO hex (Erie, PMQ) answers `null` -- either circle. */
    const locked = homeReservedCityIndex(mapGrid, {
      companyId: company.company_id,
      q: choice.q,
      r: choice.r,
      label: choice.hexLabel,
    });
    if (locked !== null && locked !== cityIndex) {
      return `${ticker}'s home station on ${choice.hexLabel} is city ${locked + 1}, the one its reservation marks.`;
    }
  }

  const verdict = evaluateStationPlacement({
    mapGrid,
    q: choice.q,
    r: choice.r,
    company,
    allCompanies: state.public_companies,
    cityIndex,
  });
  return verdict.allowed ? null : verdict.reason ?? `${ticker}'s home station cannot be placed there.`;
}

/** Every circle the operating corporation's home station may legally go in right now (the prompt's options
 *  and the replay adapter's check). Empty when nothing is owed. */
export function legalHomeTargets(
  state: GameStateResponse,
  mapGrid: MapGridResponse,
  homeHexToAxial: HomeHexToAxial,
): HomeTarget[] {
  const owed = owedHomeStation(state, homeHexToAxial);
  if (!owed) return [];
  const out: HomeTarget[] = [];
  for (const choice of owed.choices) {
    const cities = cityCountAt(mapGrid, choice.q, choice.r);
    for (let cityIndex = 0; cityIndex < cities; cityIndex += 1) {
      const placement: HomePlacement = { company_id: owed.companyId, q: choice.q, r: choice.r, city_index: cityIndex, kind: "home" };
      if (homePlacementRefusal(state, placement, mapGrid, homeHexToAxial) === null) out.push({ ...choice, cityIndex });
    }
  }
  return out;
}

/** Design note #1614: whether a recorded placement names one of this corporation's candidate homes -- its hex
 *  is a candidate and its circle is a circle of that hex (a one-city hex: `null` or `0`; a hex of several
 *  cities: a named circle). A CANDIDATE, NOT A LEGAL PLACEMENT: availability and timing are judged only when the
 *  choice is used, by `homePlacementRefusal`. */
export function isHomeCandidate(
  company: HomeCompany,
  target: { q: number; r: number; city_index?: number | null },
  homeHexToAxial: HomeHexToAxial,
  mapGrid?: MapGridResponse,
): boolean {
  const choice = homeHexChoicesFor(company, homeHexToAxial).find((entry) => entry.q === target.q && entry.r === target.r);
  if (!choice) return false;
  const index = target.city_index ?? null;
  if (index !== null && (!Number.isInteger(index) || index < 0)) return false;
  if (mapGrid === undefined) return true;
  const cities = cityCountAt(mapGrid, choice.q, choice.r);
  if (cities <= 1) return index === null || index === 0;
  return index !== null && index < cities;
}

/** Design note #1612: the messages that pass the home-station hold. */
export function passesHomeStationHold(msg: GameplayExecuteMsg): boolean {
  if (typeof msg !== "object" || msg === null) return false;
  if ("RevertTo" in msg || "CloseRoom" in msg || "UndoLastAction" in msg) return true;
  if ("PlaceHomeStation" in msg) {
    return (msg as { PlaceHomeStation: { kind?: string } }).PlaceHomeStation.kind !== "dh";
  }
  return false;
}

/** Design note #1612: why this message is held while the operating corporation owes its home station, or
 *  `null`. With no message, whether a hold stands at all (the Pass button's reason). */
export function homeStationHold(
  state: GameStateResponse,
  msg: GameplayExecuteMsg | undefined,
  homeHexToAxial: HomeHexToAxial,
  labelForAddress?: (address: string) => string,
): string | null {
  const owed = owedHomeStation(state, homeHexToAxial);
  if (!owed) return null;
  if (msg !== undefined && passesHomeStationHold(msg)) return null;
  const who = owed.president ? (labelForAddress?.(owed.president) ?? owed.president) : `${owed.ticker}'s president`;
  return (
    `${owed.ticker} is starting its first operating turn and its home station is not on the board yet. ` +
    `${who} must place it on ${describeHomeChoices(owed.choices)} before ${owed.ticker} can operate.`
  );
}
