// frontend/src/gameEngine/actionContext.ts
//
// ==================================================================
//  DESIGN NOTE 1690 (Stage 10.3, S10-4): ONE COMPOSITION OF THE REDUCER'S CONTEXT, FOR EVERY CALLER
// ==================================================================
//
// `applySandboxAction` takes a `SandboxActionContext`: the author, the grid, the era, and the static geometry
// the reducer may not import (the chart ladder, the par box, the board's label table, the tile legality engine).
// Until this note TWO callers assembled it, independently: `RoomEngine` (the server, every replay) from
// `sandboxReplayProviders()`, and `App.tsx`'s dispatch from its own inline closures -- the same geometry
// transcribed twice, the #1184 / #1193 / #1194 shape that `replayProviders.ts` exists to end. They had already
// drifted once: the shell handed the chart step `isCarcosanSale` and the providers never did (#1690 in
// `sandboxSession.ts`).
//
// SO THE CONTEXT IS BUILT HERE, from a provider set, and both callers call this. What stays with a caller is
// only what genuinely differs between them:
//   * WHICH BOARD -- the state the reducer is about to be handed (chart and auction atoms on it);
//   * WHICH GRIDS -- the grid after this entry's lay (routes and tokens are judged on it, #1380) and the grid
//     before it (the lay's own geometry is judged on that snapshot, #766);
//   * WHO -- the log's author (#549).
// Everything else -- the market geometry, the chart resolvers, the par box and the message's own par (#579),
// the label table, the era, the lay geometry -- is derived here, once. Adding an injection is an edit to this
// file, and both callers receive it; there is no second transcription to forget.
//
// The `LayTile` authority's grid-step context is built here too (`layAuthorityContext`), so the grid the shell
// writes and the grid the engine writes are asked with the same injections the reducer is about to receive
// (#1683: "the same injections the reducer is about to be handed").

import type { ReplayProviders } from "./replayLog";
import type { SandboxActionContext } from "./sandboxSession";
import type { LayTileAuthorityContext } from "./layTileAuthority";
import type { GameStateResponse } from "./gameState";
import type { SandboxLogMsg } from "./gameSetup";
import type { MapGridResponse } from "../components/hexContractTypes";
import { tileEraFor } from "./gameConstants";
import { resolveVariants } from "./gameVariants";
import { withRules } from "./boardSelection";
import type { LayNetwork } from "./layConnectivity";

/** What a caller supplies. See the header: exactly the facts that differ between the shell and the engine. */
export interface SandboxActionContextInput {
  /** The board the reducer is handed -- `market_positions` and `waterfall` on it (#1196, #1340). */
  state: GameStateResponse;
  msg: SandboxLogMsg;
  /** The log's author (#549). `undefined` only where there is none (solo play, fixtures). */
  actor: string | null | undefined;
  /** The grid INCLUDING this entry's lay: what the reducer prices routes and judges tokens on (#1380). */
  grid: MapGridResponse;
  /** The grid as it stood BEFORE this entry: what the lay's geometry is judged on (#766). */
  gridBefore: MapGridResponse;
}

/** #757 / #766: the board geometry for one lay, bound to the pre-entry grid and the era of the board the entry is
 *  judged against. Both halves of the predicate see the same instant.
 *
 *  #1279: SCOPED TO THE STATE'S OWN BOARD AND TRAY, as `App.tsx`'s closure always was. Every current caller already
 *  asks it inside that same scope (the reducer's `withRules`, `RoomEngine.apply`'s, the shell's grid step's), so
 *  this changes no answer -- it makes the injection a function of its inputs rather than of its caller's scope. */
export function layGeometryFor(
  providers: Pick<ReplayProviders, "layRefused">,
  gridBefore: MapGridResponse,
  state: GameStateResponse | null,
): (q: number, r: number, tileId: number, orientation: number, network?: LayNetwork) => boolean {
  const era = tileEraFor(state); // #1279/#1312: the board and the era the state itself names
  const rules = resolveVariants(state?.variants);
  // #1692: the network, when the authority hands one, passes straight through to rule 6 of the same filter.
  return (q, r, tileId, orientation, network) =>
    withRules(rules, () => providers.layRefused(gridBefore, q, r, tileId, orientation, era, network));
}

/** #1683: the injections the `LayTile` authority is asked with at the GRID step, before the reducer runs. */
export function layAuthorityContext(
  providers: Pick<ReplayProviders, "layRefused" | "chartInjections">,
  state: GameStateResponse,
  gridBefore: MapGridResponse,
): LayTileAuthorityContext {
  return {
    mapGrid: gridBefore,
    homeHexToAxial: providers.chartInjections(state).homeHexToAxial,
    layRefused: layGeometryFor(providers, gridBefore, state),
    // #1692: `mapGrid` IS the pre-lay grid here; stated anyway so the two builders read alike.
    layGrid: gridBefore,
  };
}

/** #579 / #398: a `BuyStock`'s par comes from the MESSAGE's own `par_value`, never from an ambient ladder
 *  selection. `undefined` for every other message and for a missing or non-positive par. */
export function parValueFromMessage(msg: SandboxLogMsg): number | undefined {
  if (!("BuyStock" in msg)) return undefined;
  const fromMsg = Number(msg.BuyStock.par_value ?? NaN);
  return Number.isFinite(fromMsg) && fromMsg > 0 ? fromMsg : undefined;
}

/** The reducer's whole context, for one entry. `RoomEngine.apply` and `App.tsx`'s dispatch both call this. */
export function sandboxActionContext(
  providers: ReplayProviders,
  input: SandboxActionContextInput,
): SandboxActionContext {
  const { state, msg, actor, grid, gridBefore } = input;
  return {
    /* #1196: the chart resolvers read `state.market_positions` -- the positions this entry is handed -- and the
       board's label table (#363). */
    ...providers.chartInjections(state),
    actor,
    mapGrid: grid,
    era: tileEraFor(state),
    /* #1197: the ladder's shape only; the reducer asks the refusals itself (#1690 adds the Blood Price's). */
    marketContext: providers.marketContext(state, msg, actor),
    parCellFor: providers.parCellFor,
    parValue: parValueFromMessage(msg),
    layRefused: layGeometryFor(providers, gridBefore, state),
    /* #1692 (Stage 10.6): the grid the LAY is judged against. `mapGrid` above includes this entry's lay (#1380);
       the `LayTile` authority's power claims and connectivity must see the board as it stood before it. */
    layGrid: gridBefore,
  };
}
