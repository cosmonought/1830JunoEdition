// frontend/src/utils/boardSelection.ts
//
// Which board a table's variants name. Design note #1300 (hexBoardData.ts) for why a board is a value.
//
// SEPARATE FROM `hexBoardData.ts` BECAUSE OF IMPORT DIRECTION: that module is a leaf that must not learn
// about `GameVariants`, and `gameVariants.ts` must not learn about hexes. This file is the one place both
// are known, and it is a few lines long on purpose.

import {
  STANDARD_BOARD,
  STANDARD_BOARD_PRE_V12,
  activateBoard,
  withBoard,
  type BoardDefinition,
} from "../components/hexBoardData";
import { EXPANDED_BOARD, EXPANDED_BOARD_PRE_V12 } from "../components/hexBoardDataPlus";
import { LPF_BOARD, LPF_BOARD_PRE_V12 } from "../components/hexBoardDataLpf";
import { STANDARD_TRAY, activateTray, withTray, type TileTray } from "../components/tileTray";
import { PLUS_TRAY } from "../components/tileTrayPlus";
import { LPF_TRAY } from "../components/tileTrayLpf";
import { activateMarketChart, chartFor, withMarketChart } from "../components/marketChart";
import type { GameVariants } from "./gameVariants";

type BoardVariants = Pick<GameVariants, "expandedMap" | "levelPlayingField">;
type TrayVariants = Pick<GameVariants, "plusTiles" | "levelPlayingField">;
/** #1435: Dynamic Market adds a row above the chart's top (`marketChart.ts`). */
type ChartVariants = Pick<GameVariants, "dynamicStockMarket">;

/* ==================================================================
    ROUTE v12 R12-2: WHICH ROUTE RULES A BOARD PLAYS -- A FACT OF THE STATE, NOT OF THE VARIANTS
   ==================================================================
   v12 repairs the route law, the route search and the 1830+ board data (Montreal / Norfolk). A PINNED board --
   every game a server has dealt since #1520, which on this engine means v12, since `replayRefusal` holds any other
   pin before an entry is applied -- plays them. An UNPINNED board is a legacy development record (the corpus the
   tests and the frozen SET-0A settlement goldens replay), and keeps the rules it was played under, exactly as
   Stage 10.6's lay authority does (#1696: presence, not a version number). The choice travels as the board in
   effect (`BoardDefinition.preV12RouteRules`), so every reader the scope reaches -- the walk, the search, the
   pricing, the slot counts -- answers for the same revision without being handed it. The variants (and so the
   settlement's variants digest) are untouched. */
export type RouteRulesRevision = "v12" | "pre-v12";

/** The route rules a board plays: `"v12"` when it carries a rules-engine pin, `"pre-v12"` when it carries none. Pass
 *  the state -- or, for `SetupGame`, the message itself, which is where the deal's pin is written. */
export function routeRulesRevisionOf(board: { rules_engine_version?: number | null } | null | undefined): RouteRulesRevision {
  return typeof board?.rules_engine_version === "number" ? "v12" : "pre-v12";
}

/** The board `variants` selects. #1320: the Level Playing Field is the expansion with its own changes, and
 *  `resolveVariants` already forces `expandedMap` on under it -- so it is asked first. R12-2: `revision` picks the
 *  route rules (default v12, what every live table plays). */
export function boardFor(variants: BoardVariants, revision: RouteRulesRevision = "v12"): BoardDefinition {
  const legacy = revision === "pre-v12";
  if (variants.levelPlayingField) return legacy ? LPF_BOARD_PRE_V12 : LPF_BOARD;
  if (variants.expandedMap) return legacy ? EXPANDED_BOARD_PRE_V12 : EXPANDED_BOARD;
  return legacy ? STANDARD_BOARD_PRE_V12 : STANDARD_BOARD;
}

/** Design note #1311: the tray `variants` selects. #1415: `plusTiles` no longer implies the map -- the tray is
 *  offered on the printed board too, and this picks it there just the same. */
export function trayFor(variants: TrayVariants): TileTray {
  if (variants.levelPlayingField) return LPF_TRAY;
  return variants.plusTiles ? PLUS_TRAY : STANDARD_TRAY;
}

/** Put this table's board, tray AND market chart in effect -- the shell's once-per-game call. */
export function activateRules(variants: BoardVariants & TrayVariants & ChartVariants, revision: RouteRulesRevision = "v12"): void {
  activateBoard(boardFor(variants, revision));
  activateTray(trayFor(variants));
  activateMarketChart(chartFor(variants)); // #1435
}

/** Run `fn` with this table's board, tray and chart in effect, restoring all three after -- the reducer's call. */
export function withRules<T>(
  variants: BoardVariants & TrayVariants & ChartVariants,
  fn: () => T,
  /** R12-2: the route rules; `routeRulesRevisionOf(state)` wherever a state is at hand. */
  revision: RouteRulesRevision = "v12",
): T {
  return withBoard(boardFor(variants, revision), () => withTray(trayFor(variants), () => withMarketChart(chartFor(variants), fn)));
}
