// frontend/src/utils/kanawhaLicense.ts
//
// The Kanawha Coal River licence -- design note #1323.
//
// ==================================================================
//  DESIGN NOTE 1323: A LICENCE IS A KEY TO ONE HEX
// ==================================================================
//
// RULED: "A corporation's route may only pass through the L8 (Coal River) hex if that corporation holds a
// Kanawha License ... During a corporation's Lay Track action step, it may purchase a Kanawha License from
// the Bank for $120. This is an optional extra action that does not replace the normal track lay. Licenses
// are non-transferable ... L8 is impassable without a license: a network may not extend past it ... there
// are only 4 licenses in the game, plus the one from JK."
//
// ONE PREDICATE, THREE WALKS. Every route walk in this codebase already takes a `blocksThrough(q, r, city)`
// callback bound to the acting corporation (#729, #820), and a licence is exactly that kind of fact -- a hex
// one corporation may cross and another may not. So the licence does not get a walk of its own: it is folded
// into that callback (`CityBlockingInput.barredHexes`), and the auto-tracer, the manual planner and the
// network reach all refuse L8 for an unlicensed corporation by the mechanism they already had for a full
// city. The reducer's `RunMultipleRoutes` arm is the authority behind that, and refuses a run whose path
// names L8 for a corporation without a licence.
//
// THE SUPPLY IS COUNTED ON THE GAME, not derived from the corporations, because the JK's free licence is not
// one of the four and a derivation would have to know which held licence came from where.

import { COAL_RIVER_LABEL, COAL_RIVER_EDGES } from "../components/hexBoardDataLpf";
import { STATIC_BOARD_HEXES, boardMemo } from "../components/hexBoardData";
import { HEX_NEIGHBOR_OFFSETS } from "../components/hexGeometry";
import type { GameStateResponse, PublicCompanyState } from "./gameState";
import { resolveVariants } from "./gameVariants";
import { operatingCorporationId } from "./dividendGate";
import { JK_PRIVATE_ID } from "./levelPlayingField";

export const KANAWHA_LICENSE_COST = 120;
/** Purchasable from the Bank. The JK's grant is a fifth, outside this count. */
export const KANAWHA_LICENSES_FOR_SALE = 4;
/** The ability key a `LayTile` carries when it is the JK's half-price lay beside Coal River. */
export const JK_TILE_ABILITY_KEY = "jk-tile";
/** The sub-phase in which a licence may be bought -- the request's "Lay Track action step". */
export const KANAWHA_LICENSE_SUB_PHASE = "Track";

/** Whether the licence rule is in force at all. */
export function kanawhaLicensesInPlay(state: Pick<GameStateResponse, "variants">): boolean {
  return resolveVariants(state.variants).levelPlayingField;
}

export function licensesHeldBy(
  company: Pick<PublicCompanyState, "kanawha_licenses"> | null | undefined,
): number {
  const held = company?.kanawha_licenses;
  return typeof held === "number" && Number.isFinite(held) && held > 0 ? Math.floor(held) : 0;
}

export function licensesRemainingForSale(state: Pick<GameStateResponse, "kanawha_licenses_sold">): number {
  const sold = state.kanawha_licenses_sold ?? 0;
  return Math.max(0, KANAWHA_LICENSES_FOR_SALE - sold);
}

/** Whether `companyId` may cross Coal River -- true whenever the rule is off. */
export function mayCrossCoalRiver(state: GameStateResponse, companyId: number | null): boolean {
  if (!kanawhaLicensesInPlay(state)) return true;
  if (companyId === null) return false;
  const company = state.public_companies.find((entry) => entry.company_id === companyId);
  return licensesHeldBy(company) > 0;
}

/* ---- the hex ------------------------------------------------------------------ */

const coalRiverCoords = boardMemo((board) => {
  const hex = board.hexes.find((entry) => entry.label === COAL_RIVER_LABEL && entry.revenueTiers !== undefined);
  return hex ? { q: hex.q, r: hex.r } : null;
});

/** Coal River's coordinate on the board in effect, or `null` when this board does not print it. */
export function coalRiverAt(): { q: number; r: number } | null {
  return coalRiverCoords();
}

/** `"q,r"` keys of every hex `companyId` may not cross -- Coal River, when unlicensed. Bound into
 *  `cityBlockerFor` (`cityBlocking.ts`) so the walks refuse it. Empty whenever nothing is barred. */
export function barredHexesFor(state: GameStateResponse | null, companyId: number | null): ReadonlySet<string> {
  const empty: ReadonlySet<string> = new Set();
  if (!state || mayCrossCoalRiver(state, companyId)) return empty;
  const at = coalRiverAt();
  return at ? new Set([`${at.q},${at.r}`]) : empty;
}

/** Whether a route path (hex labels) touches Coal River. */
export function routeCrossesCoalRiver(path: ReadonlyArray<{ hex: string }>): boolean {
  return path.some((stop) => stop.hex === COAL_RIVER_LABEL);
}

/** The hexes beside Coal River, where the JK's half-price lay may go. Read off the board's own edges. */
const coalRiverNeighbours = boardMemo((board): ReadonlySet<string> => {
  const at = board.hexes.find((entry) => entry.label === COAL_RIVER_LABEL && entry.revenueTiers !== undefined);
  if (!at) return new Set();
  const keys = new Set<string>();
  for (const edge of COAL_RIVER_EDGES) {
    const [dq, dr] = HEX_NEIGHBOR_OFFSETS[edge];
    const q = at.q + dq;
    const r = at.r + dr;
    if (STATIC_BOARD_HEXES.some((hex) => hex.q === q && hex.r === r)) keys.add(`${q},${r}`);
  }
  return keys;
});

export function isCoalRiverNeighbour(q: number, r: number): boolean {
  return coalRiverNeighbours().has(`${q},${r}`);
}

/* ---- refusals ------------------------------------------------------------------ */

export const LICENSE_REFUSALS = {
  notInPlay: "Kanawha Licences exist only in the Level Playing Field variant.",
  notOperating: "Licences are bought during a corporation's own Operating Round turn.",
  wrongStep: "A licence is bought at the Lay Track step.",
  alreadyHeld: "This corporation already holds a Kanawha Licence.",
  soldOut: "The Bank has sold all four Kanawha Licences.",
  cannotAfford: `A Kanawha Licence costs $${KANAWHA_LICENSE_COST}.`,
  unlicensedRoute: "A route may not cross Coal River (L8) without a Kanawha Licence.",
} as const;

/** Why `companyId` may not buy a licence right now, or `null` when it may. The reducer arm, the action bar
 *  and the log line all ask this one function. */
export function kanawhaLicenseRefusal(state: GameStateResponse, companyId: number): string | null {
  if (!kanawhaLicensesInPlay(state)) return LICENSE_REFUSALS.notInPlay;
  const acting = operatingCorporationId(state);
  if (acting === null || acting !== companyId) return LICENSE_REFUSALS.notOperating;
  const step = state.operating_sub_phase;
  if (step !== undefined && step !== KANAWHA_LICENSE_SUB_PHASE) return LICENSE_REFUSALS.wrongStep;
  const company = state.public_companies.find((entry) => entry.company_id === companyId);
  if (!company) return LICENSE_REFUSALS.notOperating;
  /* One per corporation: a second licence opens nothing a first did not, and "the button can be removed
     for that corporation" is the request's own reading. */
  if (licensesHeldBy(company) > 0) return LICENSE_REFUSALS.alreadyHeld;
  if (licensesRemainingForSale(state) <= 0) return LICENSE_REFUSALS.soldOut;
  const treasury = Number(company.treasury);
  if (!Number.isFinite(treasury) || treasury < KANAWHA_LICENSE_COST) return LICENSE_REFUSALS.cannotAfford;
  return null;
}

export const JK_TILE_REFUSALS = {
  notInPlay: "The JK's power exists only in the Level Playing Field variant.",
  notOwner: "Only the corporation that owns the JK may use its power.",
  closed: "The JK has already closed.",
  notAdjacent: "The JK's half-price lay must be on a hex beside Coal River (L8).",
} as const;

/** Why `companyId` may not make the JK's half-price lay at `(q, r)`, or `null`. Connectivity and every
 *  ordinary lay rule still apply on top -- this answers only what the power adds. */
export function jkTileRefusal(state: GameStateResponse, companyId: number, q: number, r: number): string | null {
  if (!kanawhaLicensesInPlay(state)) return JK_TILE_REFUSALS.notInPlay;
  const jk = state.private_companies.find((entry) => entry.private_id === JK_PRIVATE_ID);
  if (!jk || jk.owner_protocol_id !== companyId) return JK_TILE_REFUSALS.notOwner;
  if (jk.closed) return JK_TILE_REFUSALS.closed;
  if (!isCoalRiverNeighbour(q, r)) return JK_TILE_REFUSALS.notAdjacent;
  return null;
}

/** The JK's lay pays half the terrain fee, rounded down -- integer arithmetic per the project rule. */
export function jkHalfFee(fee: number): number {
  return Math.floor(Math.max(0, fee) / 2);
}
