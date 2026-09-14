// frontend/src/gameEngine/stationPlacementGate.ts
//
// When a paid station placement is legal -- the authority's question, asked before the arm runs.
//
// ==================================================================
//  DESIGN NOTE 1511 (gate): THE PLACEMENT RULES EXISTED AND THE REDUCER NEVER ASKED THEM
// ==================================================================
//
// `evaluateStationPlacement` has held the placement rules since design note #2 of `stationTokens.ts`: the
// allowance, an empty circle, one per city per corporation, home reservations, and connectivity through a
// walled board (#1006). It was called by the click, by the veil, and by the auto-skip -- never by the arm.
// The `PlaceStationToken` arm checked one thing, "not already on this hex", and charged. The rules audit
// (M6) and Batch 2 (#1449) both recorded it; the live game (JUNO-FCJ 95, 547, 551, 1058) produced it.
//
// #757's SHAPE, FOR THE TOKEN. That note closed the same door for the tile lay: "every placement rule in this
// game lived in a filter that decides which chips the radial selector OFFERS. A message built by hand,
// replayed from a stale tab, or dispatched by any second control written later went straight through." The
// lay's predicate arrives injected, because its engine lives in `components/`. The token's engine is already
// in `gameEngine/` and already reads the board tables, so this gate asks it directly -- one fewer injection
// for a caller to forget (#1194).
//
// WHAT IS ASKED HERE THAT THE MODEL DOES NOT ASK. `evaluateStationPlacement` deliberately "does NOT model the
// one-token-per-turn rule, the treasury check, or whose turn it is" (design note #2). Whose turn it is is
// `operatingIdentityRefusal`'s (#1510) and runs first. The other two are this file's: the step, which is
// the one-token rule (the cursor leaves Tokens on the first placement, so a second arrives at a step that
// does not own it -- #774's reasoning for dividends), and the treasury, which `adjustTreasury` clamps at
// zero and so would otherwise overspend in silence (audit §3). `stationPlacementBlockReason` already treats
// both as blocking for the auto-skip; the authority now agrees with it.
//
// THE GRID IS THE ONE INPUT THE STATE DOES NOT HOLD. Tiles live on a separate atom (`ctx.mapGrid`), and every
// live path supplies it -- `RoomEngine.apply` and the shell alike. Absent, the board-dependent arms are not
// asked, on #757's rule that absence is "no opinion" rather than refusal; the state-only arms still are.
// A fixture that hands in no grid is exercising other rules and keeps its answers.
//
// A REFUSAL IS A SENTENCE, for #438's reason, and the reducer turns it into an identity return (#778).

import type { GameStateResponse } from "./gameState";
import type { OperatingSubPhase } from "./operatingSubPhase";
import type { MapGridResponse } from "../components/hexContractTypes";
import { evaluateStationPlacement, nextStationTokenCost } from "./stationTokens";
import { barredHexesFor } from "./kanawhaLicense";

/** The step at which a paid station token is placed. */
export const STATION_SUB_PHASE: OperatingSubPhase = "Tokens";

export interface StationPlacementRequest {
  protocol_id: number;
  q: number;
  r: number;
  city_index?: number | null;
}

/** Why this paid placement must not be applied, or `null` if it may be. */
export function stationPlacementRefusal(
  state: GameStateResponse,
  placement: StationPlacementRequest,
  mapGrid: MapGridResponse | undefined,
): string | null {
  const { protocol_id, q, r } = placement;

  if (state.current_round_type !== "OperatingRound") {
    return "Station tokens are placed during an Operating Round.";
  }

  const company = state.public_companies.find((entry) => entry.company_id === protocol_id);
  if (!company) return "That corporation is not on this board.";
  if (!company.is_floated) return `${company.ticker} has not floated and holds no station tokens to place.`;

  /* AN UNKNOWN CURSOR IS ALLOWED THROUGH, matching `dividendGate` exactly: a seeded or legacy state can arrive
     without a step, and refusing on the missing field would brick the board rather than enforce a rule. */
  const step = state.operating_sub_phase;
  if (step !== undefined && step !== STATION_SUB_PHASE) {
    return `${company.ticker} places a station token at the Place Token step, not during this one.`;
  }

  /* THE ALLOWANCE, WITH OR WITHOUT A GRID: a corporation with every marker on the board has nothing to
     place, and the arm would otherwise conjure one. `nextStationTokenCost` reads the same limit and the
     same schedule the arm charges. */
  const cost = nextStationTokenCost(company);
  if (cost === null) {
    return `Every one of ${company.ticker}'s ${company.station_token_limit} station tokens is already on the board.`;
  }
  const treasury = Number(company.treasury) || 0;
  if (treasury < cost) {
    return `${company.ticker}'s treasury holds $${treasury} and the next station costs $${cost}.`;
  }

  if (mapGrid === undefined) {
    // No board to judge the circle on -- the state-only rule the arm always had.
    if (company.station_token_hexes.some(([hq, hr]) => hq === q && hr === r)) {
      return `${company.ticker} already has a station token in this city.`;
    }
    return null;
  }

  const verdict = evaluateStationPlacement({
    mapGrid,
    q,
    r,
    company,
    allCompanies: state.public_companies,
    cityIndex: placement.city_index ?? null,
    barredHexes: barredHexesFor(state, protocol_id), // #1323
  });
  return verdict.allowed ? null : verdict.reason ?? "That station placement is not legal.";
}
