// frontend/src/utils/boardSelection.ts
//
// Which board a table's variants name. Design note #1300 (hexBoardData.ts) for why a board is a value.
//
// SEPARATE FROM `hexBoardData.ts` BECAUSE OF IMPORT DIRECTION: that module is a leaf that must not learn
// about `GameVariants`, and `gameVariants.ts` must not learn about hexes. This file is the one place both
// are known, and it is a few lines long on purpose.

import {
  STANDARD_BOARD,
  activateBoard,
  withBoard,
  type BoardDefinition,
} from "../components/hexBoardData";
import { EXPANDED_BOARD } from "../components/hexBoardDataPlus";
import { LPF_BOARD } from "../components/hexBoardDataLpf";
import { STANDARD_TRAY, activateTray, withTray, type TileTray } from "../components/tileTray";
import { PLUS_TRAY } from "../components/tileTrayPlus";
import { LPF_TRAY } from "../components/tileTrayLpf";
import { activateMarketChart, chartFor, withMarketChart } from "../components/marketChart";
import type { GameVariants } from "./gameVariants";

type BoardVariants = Pick<GameVariants, "expandedMap" | "levelPlayingField">;
type TrayVariants = Pick<GameVariants, "plusTiles" | "levelPlayingField">;
/** #1435: Dynamic Market adds a row above the chart's top (`marketChart.ts`). */
type ChartVariants = Pick<GameVariants, "dynamicStockMarket">;

/** The board `variants` selects. #1320: the Level Playing Field is the expansion with its own changes, and
 *  `resolveVariants` already forces `expandedMap` on under it -- so it is asked first. */
export function boardFor(variants: BoardVariants): BoardDefinition {
  if (variants.levelPlayingField) return LPF_BOARD;
  return variants.expandedMap ? EXPANDED_BOARD : STANDARD_BOARD;
}

/** Design note #1311: the tray `variants` selects. #1415: `plusTiles` no longer implies the map -- the tray is
 *  offered on the printed board too, and this picks it there just the same. */
export function trayFor(variants: TrayVariants): TileTray {
  if (variants.levelPlayingField) return LPF_TRAY;
  return variants.plusTiles ? PLUS_TRAY : STANDARD_TRAY;
}

/** Put this table's board, tray AND market chart in effect -- the shell's once-per-game call. */
export function activateRules(variants: BoardVariants & TrayVariants & ChartVariants): void {
  activateBoard(boardFor(variants));
  activateTray(trayFor(variants));
  activateMarketChart(chartFor(variants)); // #1435
}

/** Run `fn` with this table's board, tray and chart in effect, restoring all three after -- the reducer's call. */
export function withRules<T>(variants: BoardVariants & TrayVariants & ChartVariants, fn: () => T): T {
  return withBoard(boardFor(variants), () => withTray(trayFor(variants), () => withMarketChart(chartFor(variants), fn)));
}
