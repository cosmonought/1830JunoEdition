// frontend/src/gameEngine/layTileAuthority.ts
//
// One verdict for a tile lay, asked before anything moves.
//
// ==================================================================
//  DESIGN NOTE 1683 (Stage 10.1, S10-26): A REFUSED LAY CHANGES NOTHING, ON EVERY ATOM
// ==================================================================
//
// FOUND BY THE STAGE-10 ORIENTATION AUDIT, and proved on the frozen JUNO-CV4 golden: B&O's $80 river lay at
// index 27, replayed with the treasury zeroed, left the treasury at $0 (the arm's #891 refusal), LANDED THE
// TILE ON THE GRID, and moved `operating_sub_phase` from Track to Tokens. Three atoms, three answers.
//
// THE GRID AND THE BOARD WERE ASKING DIFFERENT QUESTIONS. `RoomEngine.applyOnBoard` and `App.tsx`'s grid
// step refused a lay for the four holds (#1613), the operating identity (#1510) and the tile geometry
// (#757) -- and for nothing else. The reducer refused, in addition, on station anchoring (#1623, in the core
// gate block, ahead of the cursor) and on the JK's eligibility and the terrain fee (#1323, #891 -- INSIDE the
// arm, after `abilitySpentBy` had already recorded the power and, for a JK lay, after the JK had already been
// closed, and before `settleOperatingCursor` stepped the turn regardless). The live ingress (`turnRefusal`)
// had no `LayTile` arm at all, so a crafted lay met none of this until the atoms had already parted.
//
// SO THE LAY-SPECIFIC LEGALITY IS ONE FUNCTION, `layTileLegalityRefusal`, in the reducer's own order:
//
//   1. the operating identity        (#1510, `operatingIdentity.ts`)         -- the corporation named
//   1a. the Lay Track step           (#1684, below)                          -- on a pinned board
//   2. the board geometry            (#757, injected: `filterSandboxPlacements` is the shell's, per #273)
//   3. station anchoring / capacity  (#1623 / #1625, `stationAnchorAuthority.ts`)
//   4. the JK's half-price lay       (#1323, `kanawhaLicense.ts`)            -- when the key is spent
//   5. the terrain fee, affordable   (#891, `terrainFee.ts` + the board's fee table)
//
// and `layTileRefusal` composes it after the four authoritative holds (`authoritativeHolds.ts`), which is the
// whole of what any atom may ask about a `LayTile`:
//
//   * the reducer asks the holds where it asks them for every message (`applySandboxActionOnBoard`) and
//     `layTileLegalityRefusal` in the core gate block, AHEAD of `abilitySpentBy`, the arm, the transfer and
//     `settleOperatingCursor`, so a refusal returns the board by identity with the step where it was;
//   * `RoomEngine.applyOnBoard` and `App.tsx`'s grid step ask `layTileRefusal` on the same snapshot the
//     reducer is about to see, and lay the tile only when it answers `null`;
//   * `turnRefusal` asks `layTileLegalityRefusal` after its own holds, so a crafted lay is answered `refused`
//     with this sentence before the log grows.
//
// NO RULE MOVED. Every predicate here is the one that already judged the lay somewhere; this file decides
// only WHERE it is asked -- once, and before any mutation. `filterSandboxPlacements` stays injected rather
// than imported: the pure board-geometry module is the shell's (#273), and the reducer's context already
// carries it as `layRefused`. Connectivity to the corporation's network is still not judged by the authority
// (S6-5, a recorded Stage-6 item), and a `bonus_lay` / `csl-tile` / `dh-tile` claim is still message-carried
// (S6-6 / S10-17); neither is this note's to change.

import type { GameStateResponse } from "./gameState";
import type { GameplayExecuteMsg } from "../utils/sessionKey";
import { authoritativeHoldRefusal, type HoldContext } from "./authoritativeHolds";
import { operatingIdentityRefusal } from "./operatingIdentity";
import { stationAnchorRefusal, type StationAnchorLay } from "./stationAnchorAuthority";
import { JK_TILE_ABILITY_KEY, jkHalfFee, jkTileRefusal } from "./kanawhaLicense";
import { terrainFeeDue } from "./terrainFee";
import { STATIC_BOARD_HEXES, terrainBuildFeeAt } from "../components/hexBoardData";
import { OPERATING_SUB_PHASE_LABELS } from "./operatingSubPhase";

/** The fields of `ExecuteMsg::LayTile` this authority reads. Structural, so the reducer hands over
 *  `msg.LayTile` unchanged and a test hands over a literal. */
export interface LayTileBody extends StationAnchorLay {
  protocol_id: number;
  /** #1204: the private power this lay spends, when it spends one. */
  ability_key?: unknown;
}

/** What the composition needs beyond the state: the grid, the board's label table (the home hold), and the
 *  shell's geometry predicate, era-bound by the caller exactly as `SandboxActionContext.layRefused` is. A
 *  caller that hands in no `layRefused` gets no opinion on geometry (#757), as the reducer always has. */
export interface LayTileAuthorityContext extends HoldContext {
  layRefused?: (q: number, r: number, tileId: number, orientation: number) => boolean;
}

/** Whether this lay spends the JK's half-price power (#1323). */
export function isJkLay(lay: Pick<LayTileBody, "ability_key">): boolean {
  return lay.ability_key === JK_TILE_ABILITY_KEY;
}

/** The terrain fee this lay owes: the hex's fee unless already paid (#723), halved for a JK lay (#1323).
 *  The one computation the arm charges and the gate judges, so they cannot disagree about the amount. */
export function layTerrainFee(state: GameStateResponse, lay: Pick<LayTileBody, "q" | "r" | "ability_key">): number {
  const full = terrainFeeDue(state.terrain_fees_paid, lay.q, lay.r, terrainBuildFeeAt);
  return isJkLay(lay) ? jkHalfFee(full) : full;
}

function hexLabel(q: number, r: number): string {
  return STATIC_BOARD_HEXES.find((hex) => hex.q === q && hex.r === r)?.label ?? `(${q}, ${r})`;
}

/** Design note #891, asked BEFORE the record is built: a corporation that cannot pay the terrain cost may not
 *  build there. `null` when nothing is owed or the treasury covers it. */
export function terrainAffordabilityRefusal(state: GameStateResponse, lay: LayTileBody): string | null {
  const fee = layTerrainFee(state, lay);
  if (fee <= 0) return null;
  const company = state.public_companies.find((entry) => entry.company_id === lay.protocol_id);
  const treasury = Number(company?.treasury ?? 0);
  if (Number.isFinite(treasury) && treasury >= fee) return null;
  const who = company?.ticker ?? `Corporation ${lay.protocol_id}`;
  return `${who} holds $${Number.isFinite(treasury) ? treasury : 0} in its treasury and cannot pay the $${fee} terrain cost at ${hexLabel(lay.q, lay.r)}.`;
}

/* ==================================================================
    DESIGN NOTE 1684 (Stage 10.1b): A TILE IS LAID AT THE LAY TRACK STEP, AND THE STEP IS A FACT ABOUT THE BOARD
   ==================================================================
   FOUND BY 10.1's CORPUS MEASUREMENT: the reducer had no timing question for `LayTile` at all. Every OTHER
   operating action is asked its step (`stationPlacementRefusal` the Tokens step, `routeSetRefusal` Routes,
   `trainPurchaseRefusal` the Hardware step) -- a lay was accepted at Tokens, Routes, Dividends or Hardware
   whenever the corporation named was the one operating, the geometry fit and the fee was affordable. The
   shell never offers one (`tileLayDisabledReason` reads the step), so a live room only met it from a crafted
   message: a president who had skipped Lay Track, or run trains, could still put a tile down.

   THE RULE. Rulebook 6.2 / 6.3: a corporation's turn is Lay Track, then Station Tokens, then Run Trains, then
   Dividends, then Purchase Trains, in that order. EVERY tile that leaves a president's hand does so at Lay
   Track, and the inventory behind this note found no exception: the ordinary lay ends the step (`layEndsTrackStep`);
   the C&SL's bonus lay (`bonus_lay: true`, #776) is "in addition to its normal tile lay" and leaves the step on
   Track so the ordinary lay can follow; the D&H's lay (`dh-tile`, #548) consumes the ordinary placement; the JK's
   half-price lay (`jk-tile`, #1323) "counts as the corporation's normal tile lay action" and the shell arms it
   only at Track. A power key is a claim about WHICH lay this is, never about WHEN -- so no key bypasses this
   question. `BuyPrivate` is accepted as Track: it is the cursor a log written before #1440 may still carry, a
   turn that has not reached its lay, and `settleSubPhase` lands it on Track anyway.

   ON A PINNED BOARD ONLY, and this is the whole of the versioning care. Sixty-eight stored lays in the
   development corpus (JUNO-CV4 106 and its like, JUNO-Z6C 109 …, JUNO-FCJ 94/172) were APPLIED while the
   replayed cursor read Tokens or Hardware. Each is a lay the table made legally: those games were played when
   a Phase-3 turn OPENED on `BuyPrivate` and the first press of the turn -- a manual `AdvanceOperatingSubPhase`
   -- stepped it onto Track; #1440 (2026-09-14) made every turn open on Track, so the same stored press now
   steps Track -> Tokens and the lay that follows reads as mistimed. That is a representation the current engine
   puts on a legal history, not an illegality in it. Refusing those entries would change what six canonical
   files replay to; so, exactly as #1551 does for `RunManualRoute` and `routeSkipRefusal` does for the skip, a
   LEGACY board (no `rules_engine_version`) keeps the arm it was played on and a PINNED board -- every room a
   server has dealt since #1520 -- is judged. Corpus-neutral by construction; the live hole closed. */
const LAY_TRACK_STEPS: ReadonlySet<string> = new Set(["Track", "BuyPrivate"]);

/** Why this lay is mistimed on a pinned board, or `null`: at Lay Track (or a pre-#1440 `BuyPrivate` cursor), on
 *  a legacy board, or with no cursor to read (a fixture; the reducer settles one). Outside an Operating Round
 *  the identity question has already refused (#1510). */
export function layTimingRefusal(state: GameStateResponse, lay: Pick<LayTileBody, "protocol_id">): string | null {
  if (typeof state.rules_engine_version !== "number") return null;
  const step = state.operating_sub_phase;
  if (step === undefined || step === null || LAY_TRACK_STEPS.has(step)) return null;
  const ticker = state.public_companies.find((entry) => entry.company_id === lay.protocol_id)?.ticker ?? `Corporation ${lay.protocol_id}`;
  const label = OPERATING_SUB_PHASE_LABELS[step]?.stepLabel ?? String(step);
  return `${ticker} lays track only at its Lay Track step — its turn is at ${label}.`;
}

/** The lay-specific legality, in the reducer's order (see the header). `null` when nothing objects. */
export function layTileLegalityRefusal(
  state: GameStateResponse,
  lay: LayTileBody,
  ctx?: LayTileAuthorityContext,
): string | null {
  const { q, r, tile_id, orientation } = lay;
  const identity = operatingIdentityRefusal(state, { LayTile: lay } as unknown as GameplayExecuteMsg);
  if (identity !== null) return identity;
  const timing = layTimingRefusal(state, lay);
  if (timing !== null) return timing;
  if (ctx?.layRefused && ctx.layRefused(q, r, tile_id, orientation)) {
    return `Tile #${tile_id} cannot be laid at ${hexLabel(q, r)} at that rotation.`;
  }
  const anchored = stationAnchorRefusal(state, lay, ctx?.mapGrid);
  if (anchored !== null) return anchored;
  if (isJkLay(lay)) {
    const jk = jkTileRefusal(state, lay.protocol_id, q, r);
    if (jk !== null) return jk;
  }
  return terrainAffordabilityRefusal(state, lay);
}

/** The whole verdict an atom may apply a `LayTile` on: the four holds, then the lay's own legality. The two
 *  tile grids and the reducer ask this composition (the reducer with the holds where it asks them for every
 *  message); ingress asks the holds first for every message and `layTileLegalityRefusal` after them. */
export function layTileRefusal(
  state: GameStateResponse,
  msg: GameplayExecuteMsg,
  ctx?: LayTileAuthorityContext,
): string | null {
  if (!("LayTile" in msg)) return null;
  const held = authoritativeHoldRefusal(state, msg, ctx);
  if (held !== null) return held;
  return layTileLegalityRefusal(state, msg.LayTile as LayTileBody, ctx);
}
