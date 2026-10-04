// frontend/src/utils/tileRingView.ts
//
// Phase 3 W1-E (AUD-05.01 U-38, P3-N010, P3-N011 / LOW-4): what the tile ring's Confirm may say, asked of the
// one lay authority rather than restated in the shell.
//
// ==================================================================
//  W1-E: THE RING OPENS ON A FACING THE AUTHORITY KEEPS, AND CANNOT CONFIRM ONE IT REFUSES
// ==================================================================
// THE FAULT (P3-N010). The ring handed `onSelectCandidate` the candidate's FIRST RAW orientation -- the first
// placement `filterSandboxPlacements` produced for that tile -- and two comments claimed it was the first LEGAL
// one. The rotate cycle (`legalRotations`) and the thumbnails (`radialStationMarkersFor`) both ask
// `stationLegalFacings`, so on a tokened upgrade the opening preview could sit on a facing neither of them would
// ever return to, and Confirm was lit because it asked only whether a lay was allowed NOW (`canLayTileNow`) and
// whether the fee was short -- never whether THIS lay would be accepted.
//
// THE REPAIR IS TWO QUESTIONS, BOTH THE AUTHORITY'S:
//   * the seed is the lowest facing `stationLegalFacings` keeps (`seedRingFacing`) -- the facing the thumbnail
//     already draws (#879: "the marker on the thumbnail is the marker they then see on the board");
//   * Confirm asks `layTileRefusal` -- the composition the reducer, the server's grid and the shell's grid step
//     ask -- about the lay the ring would send (`ringLayPreviewRefusal`), on the table's board, tray AND route
//     rules revision (LOW-4: `withRules` was asked without the revision; harmless today because the revision
//     changes no tile-lay rule, and passed here so it cannot become a disagreement later).
//
// NO RULE LIVES HERE. Every sentence below is produced by `gameEngine/`; this file chooses only which one the
// ring shows, and in what order.

import type { MapGridResponse } from "../components/hexContractTypes";
import { canonicalTileName } from "../components/hexTileCatalog";
import type { GameStateResponse } from "../gameEngine/gameState";
import { layAuthorityContext } from "../gameEngine/actionContext";
import { layTileRefusal } from "../gameEngine/layTileAuthority";
import { routeRulesRevisionOf, withRules } from "../gameEngine/boardSelection";
import { resolveVariants } from "../gameEngine/gameVariants";
import type { ReplayProviders } from "../gameEngine/replayLog";

/** The facing the preview opens on: the lowest the station authority keeps, which is the facing the ring's
 *  thumbnail draws its markers at. When the authority keeps none (no facing of this tile can seat the hex's
 *  tokens) the ring's own offer is kept -- there is no legal facing to prefer -- and Confirm is then greyed by
 *  `ringLayPreviewRefusal` with the authority's sentence rather than the candidate silently vanishing. */
export function seedRingFacing(offered: number, legalFacings: readonly number[]): number {
  return legalFacings.length > 0 ? legalFacings[0] : offered;
}

/** The fields of the `LayTile` the ring would send, built from the same inputs `handleConfirmRadialLay` sends
 *  them from. Optional fields are omitted exactly where that handler omits them (#232: absent is "not said"). */
export interface RingLayPreview {
  gameId: number;
  protocolId: number;
  q: number;
  r: number;
  tileId: number;
  orientation: number;
  bonusLay: boolean;
  abilityKey: string | undefined;
  tokenCity: number | undefined;
  tokenCities: ReadonlyArray<readonly [number, number]>;
}

export function ringLayMessage(lay: RingLayPreview) {
  return {
    LayTile: {
      game_id: lay.gameId,
      protocol_id: lay.protocolId,
      q: lay.q,
      r: lay.r,
      tile_id: lay.tileId,
      orientation: lay.orientation,
      ...(lay.bonusLay ? { bonus_lay: true } : {}),
      ...(lay.abilityKey ? { ability_key: lay.abilityKey } : {}),
      ...(lay.tokenCity !== undefined ? { token_city: lay.tokenCity } : {}),
      ...(lay.tokenCities.length > 0 ? { token_cities: lay.tokenCities } : {}),
    },
  };
}

/** The authority's verdict on the previewed lay, or `null`. The same call the grid step makes
 *  (`layTileRefusal` with `layAuthorityContext` over the shell's provider set), on the render's state and the
 *  grid the lay would land on, scoped to this table's rules AND route revision. The sentence is the authority's;
 *  only the previewed tile's id is shown by its canonical name (`withCanonicalTileName`). */
export function ringLayPreviewRefusal(
  providers: Pick<ReplayProviders, "layRefused" | "chartInjections">,
  state: GameStateResponse,
  mapGrid: MapGridResponse,
  lay: RingLayPreview,
): string | null {
  const refusal = withRules(
    resolveVariants(state.variants),
    () => layTileRefusal(state, ringLayMessage(lay), layAuthorityContext(providers, state, mapGrid)),
    routeRulesRevisionOf(state),
  );
  return refusal === null ? null : withCanonicalTileName(refusal, lay.tileId);
}

/* ==================================================================
    WAVE-1 INTEGRATION (W1-E follow-up, copy only): THE REFUSAL NAMES THE TILE THE WAY THE RING DOES
   ==================================================================
   The lay authority writes the tile by its STORAGE id -- `Tile #626 cannot be laid at ...` -- because that is the
   id the message carries. The player knows that tile as `#8861` (errata #1630): the ring's aria labels, the
   receipt and the Tiles tab already say so (`canonicalTileName`, U-38). So the ring's Confirm tooltip shows the
   authority's sentence with the previewed tile's own id token renamed and NOTHING else changed: the verdict, the
   rest of the wording and the lay's legality are the authority's. A tile whose canonical name is its id (every
   tile but the three errata identities) is returned untouched. */
export function withCanonicalTileName(sentence: string, tileId: number): string {
  const raw = `#${tileId}`;
  const canonical = canonicalTileName(tileId);
  if (canonical === raw) return sentence;
  return sentence.replace(new RegExp(`${raw}(?!\\d)`, "g"), canonical);
}

/** One answer for the ring's Confirm and its tooltip, in the order a player can act on: why nobody may lay now
 *  (`tileLayDisabledReason`), then the last press still travelling, then why THIS lay would be refused. */
export function ringConfirmState(input: {
  layDisabledReason: string | null;
  inFlight: boolean;
  previewRefusal: string | null;
}): { canConfirm: boolean; reason: string | undefined } {
  if (input.layDisabledReason !== null) return { canConfirm: false, reason: input.layDisabledReason };
  if (input.inFlight) return { canConfirm: false, reason: RING_IN_FLIGHT_REASON };
  if (input.previewRefusal !== null) return { canConfirm: false, reason: input.previewRefusal };
  return { canConfirm: true, reason: undefined };
}

/** The in-flight sentence the shell's other latched controls already use (`PlayerPrivateTradePrompt`). */
export const RING_IN_FLIGHT_REASON = "Sending your last action — one moment.";
