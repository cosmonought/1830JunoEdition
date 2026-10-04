// frontend/src/utils/dockHoldView.ts
//
// What the shell's controls must say while an authoritative hold stands.
//
// ==================================================================
//  PHASE 3 W2-A (OD-1, AUD-04.01 / K-13 / U-22, AUD-06.02 / K-21, P3-N001, P3-N002, P3-N009): ONE HOLD ANSWER
// ==================================================================
//
// THE AUTHORITY IS `authoritativeHoldRefusal` (`gameEngine/authoritativeHolds.ts`): the excess-train discard, the
// forced train purchase / funding offer / finished game, a standing ordinary offer, and the operating corporation's
// home station -- in that priority, the same composition the reducer and ingress ask. It answers per MESSAGE: a hold
// refuses every message except the closed list that resolves it (the discard, the offer's own answer / rescission /
// settlement, the home placement, the emergency purchase family, the room's own `RevertTo` / `CloseRoom`).
//
// THIS FILE RESTATES NONE OF THAT. It asks the authority once per shell control, with the exact message KIND that
// control dispatches, and hands the shell the answer as a sentence (or `null`). So:
//   - a control whose message the hold refuses is greyed with the hold's own sentence, on every seat;
//   - a control whose message the hold lets through (the discard, the answer, the rescission, the home placement,
//     an emergency trade under the funding hold) is never greyed by this view -- the resolver cannot be blocked
//     by their own hold, because the authority does not block them;
//   - WHO may send a resolving message is not this file's question either. The existing seat authorities answer
//     it (`offerConsentView`, `waitingPromptView`, the discard / funding prompts' named president), and this view
//     hands no seat any control: it can only grey. A watcher or a spectator is therefore never made an actor here.
//
// WHY A PROBE MESSAGE IS ENOUGH. For every kind asked below, the pass-list checks it meets read only the message's
// KEY -- plus `PlaceHomeStation.kind`, which the two station probes set ("home" passes the home hold; "dh" does not).
// Two probes ARE on a pass list, and that is the point of asking: `ProposeTrainPurchase` passes the v12 funding hold
// (a corporate trade is one way out, D-6) and `PlaceHomeStation` "home" passes the home hold. The body comparisons
// (which offer an answer is for, a settlement's price) apply only to the answer / rescission / settlement kinds, which
// no probe here is. The probe bodies are the minimal well-formed shape of each message and carry no decision.
//
// ONE CALL SITE. `App.tsx` derives this view once per board (the "holds/purchase" group) and threads its fields to
// the bar (`turnHoldReason`), the Stock Round / auction Pass (`passDisabledReason`), the tile-lay gate, the token ring,
// the train panel and the private-purchase panel. None of those asks the hold a second, subtly different question.
// OUTSIDE THIS SLICE, and recorded rather than widened into: the Stock Round's share controls still read 6.5-B's
// `privateTradeHoldReason` (the trade offer's hold, the only one a Stock Round can carry, so the answers agree on every
// reachable board). Folding them into this view is W2-F's surface, not W2-A's.
// PHASE 3 W2-D: THE M&H CHIP READS THIS VIEW NOW (`exchangePrivate`, the authority's refusal of `ExchangePrivate`).
// Once the request is offered in the Operating Round (AUD-10.05) the trade offer is no longer the only hold it can
// meet -- a discard, the funding hold, a standing train / private offer and the home hold all refuse it, and refuse
// rather than queue (`mohawkExchange.ts`) -- so the narrower 6.5-B answer would leave the chip live under them.
//
// NOT HERE: the emergency purchase modal and its viewer scope (W2-G), the one global "Waiting on X" strip (W2-F), the
// v13 emergency semantics (W3-K). Ordinary off-turn behaviour (OD-1) is untouched: this view greys only while a hold
// stands, and every field is `null` otherwise.

import type { MapGridResponse } from "../components/hexContractTypes";
import { authoritativeHoldRefusal } from "../gameEngine/authoritativeHolds";
import type { SandboxLogMsg } from "../gameEngine/gameSetup";
import type { GameStateResponse } from "../gameEngine/gameState";
import { boardHomeHexToAxial, type HomeHexToAxial } from "../gameEngine/homeStationAuthority";
import { labelSentence } from "./stockRoundPrivateTrade";

export interface DockHoldInput {
  state: GameStateResponse | null | undefined;
  /** The live tile grid -- the funding hold's route walk needs it (#1540). */
  mapGrid?: MapGridResponse;
  /** The board's label table -- the home hold needs it (#1612). Defaults to the board's own, as ingress asks. */
  homeHexToAxial?: HomeHexToAxial;
  /** How a seat id reads on screen. The authority's sentences name seats by id; the shell shows names. */
  labelFor: (address: string) => string;
  /** A past board is being scrubbed (#1425): it is nobody's turn and nothing is live, so no hold is reported. */
  scrubbing?: boolean;
}

/** One sentence per shell control: why the hold refuses that control's message, or `null` when nothing does. */
export interface DockHoldView {
  /** The turn's own moves on the bar -- Pass / End Turn (`PassTurn`), Skip (`AdvanceOperatingSubPhase`), Pay /
   *  Withhold (`DeclareDividends`) and Run (`RunMultipleRoutes`). The first refusal among them, so the one prop the
   *  bar takes can never leave one of them live while the authority refuses it. Every seat reads the same sentence. */
  turnHoldReason: string | null;
  /** `PassTurn` alone (the Stock Round's Pass and the Operating Round's End Turn). */
  pass: string | null;
  /** `AdvanceOperatingSubPhase` (the bar's Skip). */
  skip: string | null;
  /** `LayTile` (the tile-lay gate and the ring's tick). */
  layTile: string | null;
  /** `PlaceStationToken` (the paid token ring). */
  placeStationToken: string | null;
  /** `PlaceHomeStation` with `kind: "home"` (the free ring of the compulsory home station). */
  placeHomeStation: string | null;
  /** `PlaceHomeStation` with `kind: "dh"` (the D&H's free station ring). */
  placeDhStation: string | null;
  /** `BuyHardwareFromPool` (the Bank Depot's Buy and the returned-train Buy). */
  buyTrainFromBank: string | null;
  /** `ExchangeTrainForDiesel` (the Diesel trade-in). */
  exchangeForDiesel: string | null;
  /** `ProposeTrainPurchase` (a train offer to another corporation). */
  proposeTrainPurchase: string | null;
  /** `ProposePrivatePurchase` (the embedded Buy Private Company panel). */
  proposePrivatePurchase: string | null;
  /** `ExchangePrivate` (the M&H's exchange-request chip, in either round -- Phase 3 W2-D). */
  exchangePrivate: string | null;
}

export const NO_DOCK_HOLD: DockHoldView = Object.freeze({
  turnHoldReason: null,
  pass: null,
  skip: null,
  layTile: null,
  placeStationToken: null,
  placeHomeStation: null,
  placeDhStation: null,
  buyTrainFromBank: null,
  exchangeForDiesel: null,
  proposeTrainPurchase: null,
  proposePrivatePurchase: null,
  exchangePrivate: null,
});

/** The probe each control's dispatch is judged by -- the kind it sends, in its minimal shape. */
function probes(gameId: number): Record<Exclude<keyof DockHoldView, "turnHoldReason"> | "declareDividends" | "runRoutes", SandboxLogMsg> {
  const at = { game_id: gameId, protocol_id: 0 };
  return {
    pass: { PassTurn: { game_id: gameId } },
    skip: { AdvanceOperatingSubPhase: { ...at } },
    declareDividends: { DeclareDividends: { ...at, pay_out: false } },
    runRoutes: { RunMultipleRoutes: { ...at, routes: [] } },
    layTile: { LayTile: { ...at, q: 0, r: 0, tile_id: 0, orientation: 0 } },
    placeStationToken: { PlaceStationToken: { ...at, q: 0, r: 0 } },
    placeHomeStation: { PlaceHomeStation: { company_id: 0, q: 0, r: 0, kind: "home" } },
    placeDhStation: { PlaceHomeStation: { company_id: 0, q: 0, r: 0, kind: "dh" } },
    buyTrainFromBank: { BuyHardwareFromPool: { ...at } },
    exchangeForDiesel: { ExchangeTrainForDiesel: { ...at, model_type: "" } },
    proposeTrainPurchase: {
      ProposeTrainPurchase: { game_id: gameId, buyer_protocol_id: 0, seller_protocol_id: 0, model_type: "", price: "0" },
    },
    proposePrivatePurchase: {
      ProposePrivatePurchase: { game_id: gameId, protocol_id: 0, private_id: 0, price: "0" },
    },
    exchangePrivate: { ExchangePrivate: { game_id: gameId, private_id: 0, company_id: 0, player: "", source: "Ipo" } },
  } as unknown as Record<Exclude<keyof DockHoldView, "turnHoldReason"> | "declareDividends" | "runRoutes", SandboxLogMsg>;
}

/** The shell's one hold answer for this board. Every field is `null` when no hold stands (or nothing is live). */
export function dockHoldView(input: DockHoldInput): DockHoldView {
  const { state, mapGrid, labelFor, scrubbing = false } = input;
  if (!state || scrubbing) return NO_DOCK_HOLD;
  const ctx = { mapGrid, homeHexToAxial: input.homeHexToAxial ?? boardHomeHexToAxial };
  const players = state.player_addresses ?? [];
  const ask = (msg: SandboxLogMsg): string | null => {
    const held = authoritativeHoldRefusal(state, msg, ctx);
    return held === null ? null : labelSentence(held, players, labelFor);
  };
  const p = probes(typeof state.game_id === "number" ? state.game_id : 0);
  const pass = ask(p.pass);
  const skip = ask(p.skip);
  return {
    turnHoldReason: pass ?? skip ?? ask(p.declareDividends) ?? ask(p.runRoutes),
    pass,
    skip,
    layTile: ask(p.layTile),
    placeStationToken: ask(p.placeStationToken),
    placeHomeStation: ask(p.placeHomeStation),
    placeDhStation: ask(p.placeDhStation),
    buyTrainFromBank: ask(p.buyTrainFromBank),
    exchangeForDiesel: ask(p.exchangeForDiesel),
    proposeTrainPurchase: ask(p.proposeTrainPurchase),
    proposePrivatePurchase: ask(p.proposePrivatePurchase),
    exchangePrivate: ask(p.exchangePrivate),
  };
}
