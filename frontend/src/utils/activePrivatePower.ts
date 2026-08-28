// frontend/src/utils/activePrivatePower.ts
//
// ==================================================================
//  DESIGN NOTE 887: WHICH PRIVATE POWER IS LIVE, AS A FUNCTION YOU CAN CALL
// ==================================================================
//
// ASKED, after a diagnosis of why feedback turns had got slow: "Let's have that conversation."
//
// THE FINDING THAT PRODUCED THIS FILE: `App.tsx` exports exactly one symbol, its default component. All 56
// suites that read it are SOURCE SCANS, and all 56 have zero runtime import from it -- not one of them chose
// that style, because there is no other door into 7,600 lines of decision logic.
//
// AND A SOURCE SCAN CANNOT ASK A BEHAVIOURAL QUESTION. It can only ask whether a file CONTAINS a string,
// which is why every vacuity this project keeps catching is a property of scanning text: `indexOf` returning
// -1 and comparing less than everything, a backwards slice yielding `""` that satisfies every `not.toContain`
// beside it, a bare count that survives a swap, an anchor placed downstream of its subject. A test that CALLS
// a function and asserts its return value has none of those failure modes available to it.
//
// SO THIS IS THE FIRST EXTRACTION, chosen because the anchors said so: `handlePowerFlowAct`,
// `handlePowerFlowDecline`, `stockRoundPowerOffers`, `runPrivateExchange`, `handleChipPowerOffer` and
// `armPrivateHexErrand` were the six most-anchored identifiers in `App.tsx` across those 56 suites.
//
// ------------------------------------------------------------------
//  WHAT MOVED, AND WHAT DELIBERATELY DID NOT
// ------------------------------------------------------------------
//
// MOVED: the two DERIVATIONS. Both were `useMemo` bodies that read state and returned derived state, which is
// the definition of a pure function wearing a hook. Nothing about them needed React.
//
// STAYED: the handlers. `handlePowerFlowAct` dispatches, arms errands, switches tabs and writes log lines --
// effects, not decisions, and pulling effects into a "pure" module is how a module stops being pure while
// still being described as one. The decision each handler makes is already small enough to read; if that
// stops being true, the next extraction is an INTENT type they return and `App.tsx` performs.
//
// ALSO STAYED, and this is the one worth flagging: `privatePowerOfferList`, the HEX offers. It reads
// `dhPower`/`cslPower`, which read `mapGrid`, and dragging the board's tile state into this module to save a
// memo would trade a small win for a large coupling. Two of the three derivations here; the third is where
// the seam actually is.
//
// ------------------------------------------------------------------
//  THE RULES THESE FUNCTIONS CARRY, ALL PRE-EXISTING
// ------------------------------------------------------------------
//
// Nothing about the game changed in this move. #871's ownership re-check, #883's sandbox gate, #881's
// acronym lookup, #884's chip title, #818/#849's standing D&H obligation and #312's "the M&H reserves no hex"
// are all carried across verbatim, with their notes. What changed is that a test can now ask each of them a
// question instead of searching `App.tsx` for the sentence that implements it.

import { privateAcronym } from "./privateCatalog";
import type { GameStateResponse } from "./gameState";
import {
  privatePowerFlow,
  type PowerAbilityKey,
  type PowerFlow,
  type StationOutcome,
} from "./privatePowerFlow";
import { privateHexFor } from "./privateReservations";

/** Design note #727: whether the ACTING CORPORATION holds a private -- `owner_protocol_id`, not `owner`.
 *  A power belongs to the railroad, not to the president personally (#441), so the player's own certificate
 *  says nothing about whether the corporation now operating may use it.
 *
 *  Design note #887: MOVED FROM `App.tsx`, where it was a module-private function three callers deep. It is
 *  the corporate half of #441's scope rule, and it was one of the things that made the shell's ownership
 *  logic untestable -- not exported, so not callable, so only assertable as a string. */
export function ownsPrivateByCorporation(
  state: GameStateResponse | null,
  privateId: number,
  protocolId: number | null,
): boolean {
  if (protocolId == null) return false;
  const entry = state?.private_companies?.find((row) => row.private_id === privateId);
  return !!entry && entry.owner_protocol_id === protocolId;
}

/** One generic chip the action bar can render. Structurally identical to the hex powers' chip fields, which
 *  is the only thing the bar needs them to share (#871: "Two lists, joined only where the bar takes a
 *  generic chip"). */
export interface ExchangeChipOffer {
  abilityKey: "mh-exchange";
  chipLabel: string;
  chipTitle: string;
}

export interface StockRoundExchangeInput {
  state: GameStateResponse | null;
  /** The seat reading the screen. #441: the exchange belongs to a PLAYER. */
  viewerAddress: string | null;
  /** Design note #883: `ExchangePrivate` is not on the session key's allow-list. */
  sandbox: boolean;
  /** The M&H's `private_id`. Passed rather than imported so the shell keeps one copy of the id constants. */
  mhPrivateId: number;
}

/* ==================================================================
    DESIGN NOTE 871: THE M&H RIDES IN THE BAR, NOT UNDER IT
   ==================================================================
   REPORTED: "In the Stock Round, the MH private power is pinned below the Action Bar rather than sticky
   with it, so it is easy to miss for players not scrolling up and down the page."

   AND THAT IS #785 WORKING AS DESIGNED, which is why it is a placement question rather than a bug in the
   panel. That pass moved every tall panel OUT of the sticky element on the finding that "the two that were
   [reported] are precisely the two that lived INSIDE the sticky element and pushed it past the budget".
   SO THE OFFER TRAVELS. A chip costs a few pixels of resting height (#837 measures it), which is the trade
   #846 already made for the two hex powers: "one list feeds both entry points".
   SEPARATE FROM `privatePowerOffers`, deliberately. That module's note is explicit that it holds HEX powers
   -- "M&H and C&A are share exchanges" -- and that its list "can never hold more than two entries". Growing
   it there would falsify a note that is load-bearing for `privatePowerHexKeys`, which feeds the board's glow
   and must never be handed a power with no hex. Two lists, joined only where the bar takes a generic chip. */
export function stockRoundExchangeOffers(
  input: StockRoundExchangeInput,
): readonly ExchangeChipOffer[] {
  const { state, viewerAddress, sandbox, mhPrivateId } = input;

  /* ==================================================================
     DESIGN NOTE 883: THE SANDBOX GATE THE PANEL WAS CARRYING FOR EVERYONE
     ==================================================================
     FOUND WHILE PRICING THE POWERS PANEL'S REMOVAL, not reported. `PrivatePowerPanel` opened with
     `if (!sandbox) return null`, and its #1 says why in terms about the MESSAGE rather than the panel: a
     button there "CANNOT dispatch ... a control that broadcasts a message certain to be rejected."
     CHECKED RATHER THAN ASSUMED: `sessionKey.ts`'s allow-list carries `LayTile`, `PlaceStationToken` and
     twenty others, and does NOT carry `ExchangePrivate`. #871 moved the control to a chip and left the guard
     behind, so outside sandbox the chip offered a trade the session key would refuse to sign.
     THE TWO HEX POWERS ARE DELIBERATELY NOT GATED, and the difference is a fact about the allow-list rather
     than a judgement: their messages ARE on it. Whether the contract would accept a lay that ignores
     connectivity is a question about `pathfinding.rs` that this frontend cannot answer and must not pre-empt
     by silently withdrawing a control. */
  if (!sandbox) return [];

  /* THE ROUND, read from `current_round_type` -- the same field the shell's round label reads. */
  if (state?.current_round_type !== "StockRound") return [];

  const mh = state?.private_companies?.find((row) => row.private_id === mhPrivateId);
  /* OWNED BY THIS VIEWER AND STILL OPEN. `owner` is the PLAYER field -- #441: "a PLAYER owning the MH may
     exchange it" -- so a corporation holding it offers nobody a chip, which is correct: a corporation
     cannot take the exchange. */
  if (!mh || mh.closed || mh.owner === null || mh.owner !== viewerAddress) return [];

  /* ==================================================================
     DESIGN NOTE 881: THE CHIP LABEL IS BUILT, NOT TYPED
     ==================================================================
     THE OLD LITERAL, on one line per #814: "Exchange M&H for NYC"
     THIS WAS #871's OWN SEAM. Its argument for a second list was about which powers have a HEX, and it had a
     cost nobody priced: `privatePowerOffers` is also where a chip label is ASSEMBLED FROM THE CATALOG, so the
     power that left that list left the acronym rule (#364, no ampersand) with it.
     THE FALLBACK IS THE SHORT FORM, not the old one. `privateAcronym` returns `null` for an id outside the
     six (#423), and a catalog that ever loses this entry should still not reintroduce the spelling #364
     removed. */
  const acronym = privateAcronym(mhPrivateId) ?? "MH";
  return [
    {
      abilityKey: "mh-exchange",
      chipLabel: `Exchange ${acronym} for NYC`,
      /* Design note #884: the hover sentence travels with the label it sits beside, so the bar -- which #848
         says "writes no rules and no copy" -- does not have to choose between two sentences. */
      chipTitle: "Opens the exchange question — nothing is spent until you answer it.",
    },
  ];
}

export interface ActivePowerFlowInput {
  state: GameStateResponse | null;
  /** What a chip or a click asked for, or `null`. */
  request: PowerAbilityKey | null;
  /** Action keys already spent this game. */
  usedAbilities: ReadonlySet<string>;
  /** #818: the free placement was declined by a named button. */
  dhStationForfeited: boolean;
  /** #725: whether the D&H's power was lost to another corporation building on F16 first. */
  dhForfeited: boolean;
  /** The corporation operating, for the corporate scope test and the holder line. */
  actingProtocolId: number | null;
  /** The seat reading the screen, for the player scope test. */
  viewerAddress: string | null;
  dhPrivateId: number;
  cslPrivateId: number;
  mhPrivateId: number;
}

/* ==================================================================
    DESIGN NOTE 849: THE MODAL IS DERIVED, NOT ONLY OPENED
   ==================================================================
   SPECIFIED: "Once a player has clicked the 'Lay Track on F16' button and completed that action, the modal
   should pop back up with the 'Lay Track on F16' button grayed out, and the 'Place Station Token on F16' and
   'Forfeit Station Token' buttons now clickable."

   SO IT CANNOT BE A BOOLEAN SOMEBODY REMEMBERS TO SET. The D&H's second step happens AFTER the lay, and a
   D&H lay ENDS the Track step -- so the reopening spans a sub-phase change, a board dispatch and a re-render.
   An open flag set at the click site would have to survive all three.
   A REQUEST PLUS A STANDING OBLIGATION. `request` is what a click sets; the D&H's unresolved second step
   raises the modal on its own, because at that point the game is WAITING for an answer that no other surface
   asks for. #818's whole reason for existing, made structural.

   DESIGN NOTE 887: AND IT IS A FUNCTION NOW, so the paragraph above can be ASKED rather than searched for.
   `privatePowerFlow.test.ts` used to assert this by looking for the string
   `const key: PowerAbilityKey | null = dhOwed ? "dh-tile" : privatePowerRequest;` in `App.tsx` -- true of the
   code and silent about whether it works. */
export function deriveActivePowerFlow(input: ActivePowerFlowInput): PowerFlow | null {
  const {
    state,
    request,
    usedAbilities,
    dhStationForfeited,
    dhForfeited,
    actingProtocolId,
    viewerAddress,
    dhPrivateId,
    cslPrivateId,
    mhPrivateId,
  } = input;

  const dhStation: StationOutcome = usedAbilities.has("dh-token")
    ? "placed"
    : dhStationForfeited
      ? "forfeited"
      : "pending";

  /* THE STANDING OBLIGATION FIRST. A D&H lay with the station unresolved raises the modal whether or not
     anybody asked for it: the game is waiting on an answer, and #818 exists because a player who is not
     asked does not know they are deciding. */
  const dhLaid = usedAbilities.has("dh-tile");
  const dhOwed =
    dhLaid &&
    dhStation === "pending" &&
    !dhForfeited &&
    ownsPrivateByCorporation(state, dhPrivateId, actingProtocolId);
  const key: PowerAbilityKey | null = dhOwed ? "dh-tile" : request;
  if (key === null) return null;

  /* ==================================================================
     DESIGN NOTE 871: THE EXCHANGE IS NOT A HEX POWER AND LEAVES FIRST
     ==================================================================
     The lines below look up a reserved hex, which the M&H does not have (#312: it "reserves nothing at all
     because its power is the NYC exchange"). Returning before them is not a special case bolted on --
     `PowerFlowInput` is a union (#871a) precisely so this branch cannot be handed a hex it has no use for.
     AND OWNERSHIP IS RE-CHECKED HERE, not merely at the chip that raised it. A flow is derived state read
     every render; the chip is a control clicked once. If the private closes -- or is sold -- between the
     click and the next frame, this is what stops the modal describing a power the viewer no longer has. */
  if (key === "mh-exchange") {
    const mh = state?.private_companies?.find((row) => row.private_id === mhPrivateId);
    if (!mh || mh.closed || mh.owner === null || mh.owner !== viewerAddress) return null;
    const revenue = Number(mh.revenue_per_or);
    return privatePowerFlow({
      abilityKey: key,
      holder: mh.owner,
      /* `undefined` RATHER THAN A GUESS when the figure is unreadable: the sentence then names the loss
         without a number, which is honest, where `|| 0` would tell a player they are giving up nothing. */
      revenuePerOr: Number.isFinite(revenue) ? revenue : undefined,
    });
  }

  const hex = privateHexFor(key === "dh-tile" ? dhPrivateId : cslPrivateId);
  if (!hex) return null;
  return privatePowerFlow({
    abilityKey: key,
    holder:
      state?.public_companies.find((entry) => entry.company_id === actingProtocolId)?.ticker ??
      "This corporation",
    hexLabel: hex.hexLabel,
    layDone: usedAbilities.has(key),
    station: key === "dh-tile" ? dhStation : "none",
  });
}
