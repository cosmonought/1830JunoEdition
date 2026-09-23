// frontend/src/gameEngine/privateLayClaim.ts
//
// ==================================================================
//  DESIGN NOTE 1693 (Stage 10.6, S6-6): THE MESSAGE CHOOSES WHICH LAY; THE BOARD DECIDES WHETHER IT EXISTS
// ==================================================================
//
// A `LayTile` may carry two claims about itself: `bonus_lay: true` (#776 -- "this is the C&SL's EXTRA lay, the
// Track step stays open") and `ability_key` (#1204 -- "this lay spends that private power"). #776 and #885 are
// right that the SHELL must say which lay it is: a connected B20 lay by a corporation owning the C&SL can be its
// bonus OR its ordinary lay, and inferring the choice from the hex would hand out a free second tile. What was
// wrong is that NOTHING CHECKED THE CLAIM. `layEndsTrackStep` read the flag and kept the cursor on Track for any
// lay that said `bonus_lay: true`, so a crafted message bought any corporation a second lay, and a third, on any
// hex; and a `csl-tile` / `dh-tile` key was recorded as spent (`abilitySpentBy`) by whoever sent it, spending
// another corporation's power and -- with the connectivity rule now judged (#1692) -- would have been the key to
// skipping it.
//
// SO A CLAIM IS VALIDATED, AT ONE BOUNDARY, AGAINST THE BOARD: this function, the first lay-specific question
// after identity and timing in `layTileLegalityRefusal`, asked by the reducer, both grids and ingress. The two
// representations must AGREE (the C&SL's key is always a bonus lay, a bonus lay is only ever the C&SL's) and the
// power they name must be REAL for this corporation, now:
//
//   C&SL (`bonus_lay: true`, `ability_key: "csl-tile"` or -- a log written before #1204 -- absent):
//     the C&SL is open and owned by THIS corporation (`owner_protocol_id`); the lay is on the C&SL's printed hex
//     (B20, `privateHexFor`); the power is live (`cslPowerState`: not yet used, and B20 still bare on the grid the
//     lay is judged against -- #1671, it is a lay, not an upgrade right).
//   D&H (`ability_key: "dh-tile"`, never a bonus):
//     the D&H is open and owned by this corporation; the lay is on F16; the power is live (`dhPowerState`: not
//     used, not forfeited by somebody else's tile on F16).
//   JK (`ability_key: "jk-tile"`, never a bonus): `jkTileRefusal` (#1323), asked where it always was (question 4).
//   Any other key: refused -- a `LayTile` spends a TILE power or none.
//
// An absent or `false` flag and no key is the ORDINARY lay, and none of this is asked of it.
//
// WHAT A VALID CLAIM EARNS, and nothing more: the C&SL's bonus does not end the Track step (#776); the C&SL's and
// the D&H's lays are exempt from connectivity (their printed text: "ignoring track connection rules" -- #725 /
// #726); the JK's is half-price (#1323) and ordinary in every other respect. The D&H's and the JK's lays end the
// step as the corporation's own lay (#548, #1323). ONE VALID BONUS PER GAME: a used C&SL records `csl-tile`
// (#1204), and B20 is then built, so the same claim cannot be made twice.

import type { GameStateResponse } from "./gameState";
import type { MapGridResponse } from "../components/hexContractTypes";
import { CSL_ABILITY_KEY } from "./bonusLay";
import { CSL_PRIVATE_ID, DH_PRIVATE_ID, cslPowerState, dhPowerState } from "./dhPower";
import { JK_TILE_ABILITY_KEY } from "./kanawhaLicense";
import { privateHexFor } from "./privateReservations";

/** The D&H's tile-lay key, as the private-power flow spells it (`privatePowerFlow.PowerAbilityKey`). */
export const DH_TILE_ABILITY_KEY = "dh-tile";

/** The only keys a `LayTile` may carry: the three tile-laying private powers. */
export const TILE_LAY_ABILITY_KEYS: readonly string[] = [CSL_ABILITY_KEY, DH_TILE_ABILITY_KEY, JK_TILE_ABILITY_KEY];

/** The claim fields of `ExecuteMsg::LayTile`. Structural, so the reducer hands `msg.LayTile` over unchanged. */
export interface PrivateLayClaimBody {
  protocol_id: number;
  q: number;
  r: number;
  ability_key?: unknown;
  bonus_lay?: unknown;
}

/** The key this lay names, read exactly as `abilitySpentBy` reads it: a non-empty string, or nothing. */
export function claimedLayAbilityKey(lay: Pick<PrivateLayClaimBody, "ability_key">): string | null {
  const key = lay.ability_key;
  return typeof key === "string" && key !== "" ? key : null;
}

/** Whether this lay CLAIMS the C&SL's bonus -- the flag, or the C&SL's key. Validated by `privateLayClaimRefusal`. */
export function claimsCslBonus(lay: Pick<PrivateLayClaimBody, "ability_key" | "bonus_lay">): boolean {
  return lay.bonus_lay === true || claimedLayAbilityKey(lay) === CSL_ABILITY_KEY;
}

function tickerOf(state: GameStateResponse, companyId: number): string {
  return state.public_companies.find((entry) => entry.company_id === companyId)?.ticker ?? `Corporation ${companyId}`;
}

function hexBuiltOn(grid: MapGridResponse | undefined, hex: { q: number; r: number }): boolean {
  return grid !== undefined && grid.tiles.some((tile) => tile.q === hex.q && tile.r === hex.r);
}

/** #1697: whether `companyId` still holds a live C&SL bonus lay on `grid` -- the C&SL open and owned by it, the power
 *  unused, B20 still bare. The same facts `cslClaimRefusal` asks, as a yes/no for the cursor. */
export function cslBonusEntitlement(state: GameStateResponse, companyId: number, grid?: MapGridResponse): boolean {
  const csl = state.private_companies.find((entry) => entry.private_id === CSL_PRIVATE_ID);
  if (!csl || csl.closed || csl.owner_protocol_id !== companyId) return false;
  const hex = privateHexFor(CSL_PRIVATE_ID);
  if (!hex) return false;
  const power = cslPowerState({
    hexBuilt: hexBuiltOn(grid, hex),
    layUsed: (state.used_private_abilities ?? []).includes(CSL_ABILITY_KEY),
  });
  return !power.forfeited && power.layAvailable;
}

/** #1697: a second ORDINARY lay in the turn -- the corporation already made one and stayed on Track only for its
 *  C&SL bonus. `null` for a bonus claim (validated by `privateLayClaimRefusal`) and for any other corporation. */
export function ordinaryLayTakenRefusal(
  state: GameStateResponse,
  lay: Pick<PrivateLayClaimBody, "protocol_id" | "ability_key" | "bonus_lay">,
): string | null {
  if (claimsCslBonus(lay)) return null;
  if (state.ordinary_lay_taken !== lay.protocol_id) return null;
  return `${tickerOf(state, lay.protocol_id)} has already made its ordinary tile lay this turn; only its Champlain & St. Lawrence bonus lay remains.`;
}

function cslClaimRefusal(state: GameStateResponse, lay: PrivateLayClaimBody, grid: MapGridResponse | undefined): string | null {
  const who = tickerOf(state, lay.protocol_id);
  const csl = state.private_companies.find((entry) => entry.private_id === CSL_PRIVATE_ID);
  if (!csl || csl.closed) return `The Champlain & St. Lawrence is closed, so ${who} has no bonus lay.`;
  if (csl.owner_protocol_id !== lay.protocol_id) {
    return `${who} does not own the Champlain & St. Lawrence, so it has no bonus lay.`;
  }
  const hex = privateHexFor(CSL_PRIVATE_ID);
  if (!hex || hex.q !== lay.q || hex.r !== lay.r) {
    return `The Champlain & St. Lawrence's bonus lay is on ${hex?.hexLabel ?? "its own hex"} only.`;
  }
  const power = cslPowerState({
    hexBuilt: hexBuiltOn(grid, hex),
    layUsed: (state.used_private_abilities ?? []).includes(CSL_ABILITY_KEY),
  });
  if (power.forfeited || !power.layAvailable) {
    return power.layBlockedReason ?? "The Champlain & St. Lawrence's bonus lay is not available.";
  }
  return null;
}

function dhClaimRefusal(state: GameStateResponse, lay: PrivateLayClaimBody, grid: MapGridResponse | undefined): string | null {
  const who = tickerOf(state, lay.protocol_id);
  const dh = state.private_companies.find((entry) => entry.private_id === DH_PRIVATE_ID);
  if (!dh || dh.closed) return `The Delaware & Hudson is closed, so ${who} cannot use its lay.`;
  if (dh.owner_protocol_id !== lay.protocol_id) {
    return `${who} does not own the Delaware & Hudson, so it cannot use its lay.`;
  }
  const hex = privateHexFor(DH_PRIVATE_ID);
  if (!hex || hex.q !== lay.q || hex.r !== lay.r) {
    return `The Delaware & Hudson's lay is on ${hex?.hexLabel ?? "its own hex"} only.`;
  }
  const used = state.used_private_abilities ?? [];
  const power = dhPowerState({
    hexBuilt: hexBuiltOn(grid, hex),
    layUsed: used.includes(DH_TILE_ABILITY_KEY),
    tokenUsed: used.includes("dh-token"),
  });
  if (power.forfeited || !power.layAvailable) {
    return power.layBlockedReason ?? "The Delaware & Hudson's lay is not available.";
  }
  return null;
}

/** Why this lay's private-power claim is refused, or `null` (no claim, or a claim the board makes good).
 *  `grid` is the grid the lay is judged against -- BEFORE it lands; without one (a fixture) only the state-held
 *  facts are asked, on #757's rule. The JK's eligibility is `jkTileRefusal`'s, asked later in the same composition. */
export function privateLayClaimRefusal(
  state: GameStateResponse,
  lay: PrivateLayClaimBody,
  grid?: MapGridResponse,
): string | null {
  const key = claimedLayAbilityKey(lay);
  const bonus = lay.bonus_lay === true;
  if (key !== null && !TILE_LAY_ABILITY_KEYS.includes(key)) {
    return `"${key}" is not a private power that lays a tile.`;
  }
  // The two representations of one intent must agree (S6-6): the bonus IS the C&SL's lay, and only its.
  if (bonus && key !== null && key !== CSL_ABILITY_KEY) {
    return `Only the Champlain & St. Lawrence's lay is a bonus lay; a ${key} lay is the corporation's own lay.`;
  }
  if (key === CSL_ABILITY_KEY && !bonus) {
    return "The Champlain & St. Lawrence's lay is a bonus lay and is sent as one.";
  }
  if (bonus) return cslClaimRefusal(state, lay, grid);
  if (key === DH_TILE_ABILITY_KEY) return dhClaimRefusal(state, lay, grid);
  return null;
}

/** Whether this lay, its claim already validated, is exempt from connectivity: the C&SL's bonus and the D&H's lay
 *  ("ignoring track connection rules"). The JK's lay is not -- it is the corporation's normal lay at half price. */
export function privateLayWaivesConnectivity(lay: Pick<PrivateLayClaimBody, "ability_key" | "bonus_lay">): boolean {
  return claimsCslBonus(lay) || claimedLayAbilityKey(lay) === DH_TILE_ABILITY_KEY;
}
