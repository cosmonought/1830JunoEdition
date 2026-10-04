// frontend/src/utils/noServerDerivedForwarding.ts
//
// ==================================================================
//  DESIGN NOTE 1247, EXTENDED (Phase 3 W3-K, review finding 2): WHICH DERIVED ACTIONS THE NO-SERVER SHELL SENDS
// ==================================================================
//
// On the server path the server generates every derived action (#1203) and the shell never sends one (#1213). On
// the Firestore path there is nobody else to owe them, so the on-turn client sends the ones no other shell effect
// already performs: the purchase an ACCEPTED OFFER owes (#1247), and -- rules engine v13, OD-4 -- the automatic
// emergency train purchase (`forced-purchase`), without which a funded emergency obligation would stall there.
//
// NOT A SECOND RULES ENGINE. The decision is `nextDerivedAction`'s, exactly the one the server asks: the same
// message, the same durable key (`emergency-purchase:<turn key>` for the purchase), the same board. This module
// only filters by kind; the caller sends at most one dispatch per key and the reducer re-judges what it receives.
// The automatic BANKRUPTCY needs no forwarding: it is not a derived action but the reducer's own settlement inside
// whichever transition proved it (`settleBankruptcy`), on every path alike.
//
// The other derived kinds (`skip`, `end-turn`, `forced-withhold`) have their own shell effects (the auto-skip, the
// automatic end of turn, the forced withhold) and are deliberately not forwarded here -- a second sender would be
// #774's double dispatch.

import type { GameStateResponse } from "../gameEngine/gameState";
import type { MapGridResponse } from "../components/hexContractTypes";
import { nextDerivedAction, type DerivedAction } from "../gameEngine/derivedActions";
import { automaticFundingInForce } from "../gameEngine/emergencyFunding";
import { TRAIN_PURCHASE_SUB_PHASE } from "../gameEngine/trainPurchaseGate";

/** The derived kinds the no-server shell forwards through this path. */
export const NO_SERVER_FORWARDED_DERIVED_KINDS: readonly DerivedAction["kind"][] = ["accepted-offer", "forced-purchase"];

/** The derived action this client should send now, or `null`: only on my turn, only a forwarded kind, never a key
 *  already sent. A cheap board check first, so the derivation runs only where one of the two can be owed. */
export function noServerDerivedToSend(input: {
  state: GameStateResponse | null | undefined;
  mapGrid: MapGridResponse;
  emitted: ReadonlySet<string>;
  isMyTurn: boolean;
}): DerivedAction | null {
  const { state, mapGrid, emitted, isMyTurn } = input;
  if (!state || !isMyTurn) return null;
  const acceptedOffer = state.private_purchase_offer?.accepted === true || state.train_purchase_offer?.accepted === true;
  const emergencyPossible =
    automaticFundingInForce(state) && state.current_round_type === "OperatingRound" && state.operating_sub_phase === TRAIN_PURCHASE_SUB_PHASE;
  if (!acceptedOffer && !emergencyPossible) return null;
  const owed = nextDerivedAction({ state, mapGrid, emitted });
  if (!owed || !NO_SERVER_FORWARDED_DERIVED_KINDS.includes(owed.kind)) return null;
  return owed;
}
