// frontend/src/utils/replayProviders.ts
//
// The one set of providers, for every headless consumer.
//
// ==================================================================
//  DESIGN NOTE 1199: THE PROVIDERS LEAVE THE TEST FILE BEFORE THE SERVER ARRIVES
// ==================================================================
//
// PHASE 2 BEGINS BY MOVING THIS, and the move is the point rather than the tidying. These providers lived in
// `replayJuno3XD.test.ts`, which was correct while the harness was the only headless consumer. The Node
// server is the second one -- and a server that assembled its own would be a SECOND IMPLEMENTATION of the
// chart's geometry and the board's legality rules.
//
// THIS PROJECT HAS PAID FOR THAT EXACT MISTAKE THREE TIMES. #1184: `MIN_BID_INCREMENT` hand-mirrored from
// `auction::MIN_BID_INCREMENT`, drifted, shipped to players. #1193: the harness omitted `reconcileParMarks`
// and silently rearranged the operating order. #1194: the harness wrote `marketContext` from the shape of
// the types instead of transcribing `App.tsx`, omitted two refusal predicates, and rearranged it again. Each
// was one rule implemented twice.
//
// SO THE SERVER IMPORTS THIS FILE. Not a copy of it, not something modelled on it. If the geometry ever has
// to change, it changes once and both consumers move together -- and the golden master notices if the change
// altered the game rather than the architecture.
//
// WHAT IS LEFT HERE IS GEOMETRY, and that is Phase 1's whole result. Where the tokens ARE lives on
// `state.market_positions` (#1196); the reducer performs the chart step itself (#1197). What a caller still
// supplies is the shape of the board -- the price ladder, the hex table, the tile legality engine -- which is
// static, identical in every browser, and no more dangerous to hand in than `hexTileCatalog`.
//
// THE ONE THING TO WATCH. `StockMarketRenderer.tsx` is a `.tsx` that imports React, and this file imports the
// ladder's geometry out of it. That is harmless in a bundler and merely untidy in Node, but it means the
// server drags React in for a set of pure lookup functions. Splitting the geometry into its own `.ts` is the
// obvious cleanup and is deliberately NOT done here -- it touches the renderer, which is shell code, and
// Phase 2 has no business editing the shell while it is standing up its replacement.

import type { ReplayProviders } from "./replayLog";
import {
  DEFAULT_SANDBOX_SCENARIO,
  sandboxInitialMarketPrices,
  sandboxScenario,
} from "./sandboxState";
import { MOCK_MAP_GRID } from "./mockFixtures";
import { dividendStepsFor, resolveVariants } from "./gameVariants";
import {
  marketCellForPrice,
  marketZoneForPrice,
  parBoxCellFor,
  projectBloodPriceMove,
  projectDividendCellMove,
  projectRiseMove,
  projectShareSaleMove,
} from "../components/StockMarketRenderer";
import { filterSandboxPlacements } from "../components/sandboxTileLegality";
import { STATIC_BOARD_HEXES } from "../components/hexBoardData";

/** The providers a room replays with.
 *
 *  TRANSCRIBED FROM `App.tsx`'s CALL SITE, never derived from the types. Where this file and the shell
 *  differ, this file is wrong until proven otherwise -- #1194 is what that rule is made of. */
export function sandboxReplayProviders(): ReplayProviders {
  const zeroState = sandboxScenario(DEFAULT_SANDBOX_SCENARIO).zeroState ?? false;

  return {
    initialGrid: MOCK_MAP_GRID,
    /* #757, and the snapshot discipline #766 asked for: the grid and the era are both passed in, so the two
       halves of the predicate judge the same instant. `App.tsx` got this wrong once by giving the grid a ref
       and leaving the phase reading state. */
    layRefused: (grid, q, r, tileId, orientation, era) =>
      filterSandboxPlacements([{ tile_id: tileId, orientation }], {
        mapGrid: grid,
        q,
        r,
        era,
      }).length === 0,

    initialMarket: sandboxInitialMarketPrices(marketCellForPrice, parBoxCellFor, zeroState),

    /* #1197: handed to the reducer rather than applied by a caller. #1193 is why it exists at all -- without
       a par token `buildOperatingOrder` loses both tie-breaks -- but remembering to run it is no longer
       anybody's problem. */
    parCellFor: parBoxCellFor,

    marketContext: (state, msg) => ({
      projectSale: (from, blocks) => projectShareSaleMove(from, blocks),
      projectBloodPrice: (from) => projectBloodPriceMove(from),
      /* #291/#908: the dividend moves the marker by as many cells as the payout earned, measured against the
         price the declaration was made AGAINST -- reading the price after the move would measure the
         multiple against the cell the multiple just chose. */
      projectDividend: (from, choice) => {
        const declaring =
          "DeclareDividends" in msg
            ? state.public_companies.find(
                (entry) => entry.company_id === msg.DeclareDividends.protocol_id,
              )
            : undefined;
        const payout = Number(declaring?.last_route_revenue ?? 0) || 0;
        const steps = dividendStepsFor(
          payout,
          state.market_positions?.[declaring?.company_id ?? -1]?.price ?? null,
          resolveVariants(state.variants),
          choice,
        );
        return projectDividendCellMove(from, choice, steps);
      },
      /* #1197: `dividendRefused` and `saleRefused` are absent BY CONSTRUCTION -- `SandboxActionContext` no
         longer accepts them. The reducer holds the state those predicates read and asks them itself, which
         is the gap #1194 opened by omission, closed by making omission impossible. */
    }),

    chartInjections: (state) => {
      /* #1196: read off the STATE, not off a copy any caller keeps. That is the whole difference Phase 1
         makes -- there is no longer a second chart for these resolvers to disagree with. */
      const positions = state.market_positions ?? {};
      const priceFor = (companyId: number): number | null => positions[companyId]?.price ?? null;
      return {
        /* #363: the board's own label -> (q, r) table. `App.tsx` builds this as a `useCallback` over
           `STATIC_BOARD_HEXES`; the lookup is pure, so headless it is the same two lines without the hook.
           Required by the `PlaceHomeStation` arm (#1189) -- without it a placement returns the state
           unchanged and no corporation ever completes its float. */
        homeHexToAxial: (label: string) => {
          const hex = STATIC_BOARD_HEXES.find((entry) => entry.label === label);
          return hex ? ([hex.q, hex.r] as const) : null;
        },
        // #411 / #1177: the chart this dispatch produced, never a committed copy one step behind.
        marketPriceFor: priceFor,
        // #712: the zone rules travel with the price.
        marketZoneFor: (companyId: number) => marketZoneForPrice(priceFor(companyId)),
        zoneForPrice: marketZoneForPrice,
        marketPricesByCompany: Object.fromEntries(
          Object.entries(positions).map(([id, mark]) => [Number(id), mark?.price ?? null]),
        ) as Record<number, number | null>,
        // #646/#647: the token's column and arrival, for the operating-order tie-break.
        marketMarkFor: (companyId: number) => positions[companyId] ?? null,
        // #746a: the chart's own UP step, before the queue is sorted on the prices it produced.
        projectRise: (from) => projectRiseMove(from),
      };
    },
  };
}
