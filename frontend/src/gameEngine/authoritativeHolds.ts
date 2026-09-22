// frontend/src/gameEngine/authoritativeHolds.ts
//
// The four authoritative holds, composed once.
//
// ==================================================================
//  DESIGN NOTE 1681 (Stage 10.1, S10-26): THE HOLD COMPOSITION LEAVES THE REDUCER FILE
// ==================================================================
//
// `authoritativeHoldRefusal` was written in `sandboxSession.ts` (design note #1613, Slice 8.2) and is asked
// there before either atom moves. Stage 10.1 adds a second composer that needs the same four holds -- the
// `LayTile` authority (`layTileAuthority.ts`), which the reducer, both tile grids and the live ingress all
// ask -- and `sandboxSession.ts` imports that module. The composition therefore moves HERE, beneath both,
// unchanged in content and order; `sandboxSession.ts` re-exports it so every existing caller and test keeps
// its import. Nothing about which hold applies, or in what priority, moved with it.

import type { GameStateResponse } from "./gameState";
import type { GameplayExecuteMsg } from "../utils/sessionKey";
import type { MapGridResponse } from "../components/hexContractTypes";
import { pendingDiscardBlock } from "./trainDiscard";
import { emergencyFundingBlock } from "./emergencyFunding";
import { pendingOfferBlock } from "./pendingOfferHold";
import { homeStationHold, type HomeHexToAxial } from "./homeStationAuthority";

/** What the hold composition needs from a reducer context: the grid (the funding hold's route walk) and the
 *  board's label table (the home hold). Structurally the same two fields of `SandboxActionContext`. */
export interface HoldContext {
  mapGrid?: MapGridResponse;
  homeHexToAxial?: HomeHexToAxial;
}

/** Design note #1613: the four authoritative holds in their priority -- the excess-train discard (#1530), the
 *  forced train purchase and the finished game (#1540), a standing ordinary offer (#1590), the operating
 *  corporation's home station (#1612) -- the first sentence that applies, or `null`. The same predicates ingress
 *  asks (`turnRefusal`), in the same order. The home hold needs the board's label table, as the placement arm
 *  always has (#550): a caller that hands in none is judged on the other three. */
export function authoritativeHoldRefusal(
  state: GameStateResponse,
  msg: GameplayExecuteMsg,
  ctx?: HoldContext,
): string | null {
  return (
    pendingDiscardBlock(state, msg) ??
    emergencyFundingBlock(state, msg, ctx?.mapGrid) ??
    pendingOfferBlock(state, msg) ??
    (ctx?.homeHexToAxial ? homeStationHold(state, msg, ctx.homeHexToAxial) : null)
  );
}
