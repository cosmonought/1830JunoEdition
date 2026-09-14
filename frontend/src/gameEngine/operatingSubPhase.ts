// frontend/src/gameEngine/operatingSubPhase.ts
//
// ==================================================================
//  DESIGN NOTE 1502: THE OR TURN'S STEPS, OUT OF THE STRIP THAT DRAWS THEM
// ==================================================================
//
// LIFTED OUT OF `components/OperatingSubPhaseStepper.tsx` UNCHANGED -- same text, same order, same
// behaviour. Only the file changed.
//
// #656 ALREADY SAID WHY THIS BELONGS HERE. "The turn cursor is GAME STATE, not React state" is that
// note's first line, and `operatingCursor.ts` was written to make it true -- but the rules it reasons
// with (which steps a game HAS, which step a turn OPENS on, whether a private is still buyable) stayed
// in the component, so the reducer reached them by importing a `.tsx`. That is one of the three paths
// by which the authoritative engine imported React.
//
// WHAT STAYED BEHIND is the strip: the props, the layout and the rendering. It imports these back and
// re-exports every one of them, so no importer in the app or the tests moved.
//
// See docs/ai_architecture/state_machine.md, operatingCursor.ts #656.
/** The legal, chronologically-ordered action sub-phases within one corporation's Operating Round turn. Mirrors
 *  `or_phase::OR_PHASE_ORDER`, which is the AUTHORITY rather than a description (design note #1). Lives here
 *  rather than in `App.tsx` so the stepper, the action bar and the labels all read one definition;
 *  `RulesReference.tsx` keeps its own independent copy on purpose -- that file takes no game-state coupling. */
export type OperatingSubPhase =
  | "BuyPrivate"
  | "Track"
  | "Tokens"
  | "Routes"
  | "Dividends"
  | "Hardware";

/** Canonical order. The strip, the numbering and every "is this step done"
 *  comparison read this array, so there is one sequence in the app. */
/* ==================================================================
    DESIGN NOTE 1440: BUYING A PRIVATE IS NOT A STEP
   ==================================================================
   CORRECTED: "I had the 'Buy Private Companies' action added as a sixth step at the start of an Operating
   Round from Phase 3 ... In fact, the rules allow corporations to buy private companies AT ANY TIME during
   their turn." So `BuyPrivate` leaves the sequence: five steps, a turn opens on Track in every phase, and the
   purchase is a standing button on the action bar (`ContextualActionBar`, the left rail) for as long as
   there is a private to buy and the phase allows it. The TYPE keeps the member so a log written before this
   note still settles (`operatingCursor.settleSubPhase` lands a `BuyPrivate` cursor on Track). */
export const OPERATING_SUB_PHASE_ORDER: readonly OperatingSubPhase[] = [
  "Track",
  "Tokens",
  "Routes",
  "Dividends",
  "Hardware",
];

/** Display metadata. `name` is the short form the action bar's header uses;
 *  `stepLabel` is the longer, verb-led form for the strip, where there is
 *  room and where a newcomer benefits from being told what the step IS
 *  ("Lay Track") rather than what it is called ("Track"). */
export const OPERATING_SUB_PHASE_LABELS: Readonly<
  Record<OperatingSubPhase, { index: number; name: string; stepLabel: string }>
> = {
  BuyPrivate: { index: 1, name: "Buy Private", stepLabel: "Buy Private" },
  Track: { index: 2, name: "Track", stepLabel: "Lay Track" },
  Tokens: { index: 3, name: "Tokens", stepLabel: "Station Tokens" },
  // Design note #142 (App.tsx): `Routes` is its own phase. Running trains
  // COMPUTES the revenue; declaring dividends chooses what to do with it.
  Routes: { index: 4, name: "Routes", stepLabel: "Run Routes" },
  Dividends: { index: 5, name: "Dividends", stepLabel: "Dividends" },
  Hardware: { index: 6, name: "Hardware", stepLabel: "Buy Trains" },
};

export const OPERATING_SUB_PHASE_TOTAL = OPERATING_SUB_PHASE_ORDER.length;

/** Where a corporation's turn starts, mirroring
 *  `or_phase::initial_sub_phase` -- `Track` before Phase 3, because
 *  `BuyPrivate`'s action is locked until then and the contract's cursor
 *  starts there too. */
export function initialOrSubPhase(era: string | null | undefined): OperatingSubPhase {
  void era; // #1440: every turn opens on Track now, whatever the era
  return "Track";
}

/** The shape `visibleSubPhases` needs off a private company -- structural,
 *  so callers can pass `PrivateCompanyState` without this module importing
 *  the whole game-state vocabulary. */
export interface PrivateAvailability {
  closed: boolean;
  /** Set when a CORPORATION holds it; such a private can never be bought
   *  again (`trading.rs` reads `private.owner` and fails without one). */
  owner_protocol_id: number | null;
}

/** Is there anything left for a corporation to buy? Design note #385: A STEP WITH NOTHING IN IT IS NOT A STEP.
 *  The step was gated on the ERA alone, so from Phase 3 it appeared on every corporation's turn for the rest of
 *  the game -- and by the mid-game it is usually empty. Six corporations each skipping a dead step every
 *  Operating Round is a lot of clicks spent proving a negative.
 *  A PRIVATE IS BUYABLE IF a player still holds it -- not closed, not already inside a corporation. That is the
 *  same predicate `PrivateTradePanel.tsx` applies, deliberately: the step exists to open that picker, so it
 *  should be present exactly when the picker would have rows.
 *  PHASE 5 NEEDS NO SPECIAL CASE -- it closes all privates, so this returns false on its own, and testing the
 *  phase too would be a second rule to keep in agreement with the first.
 *  AN UNKNOWN ROSTER SHOWS THE STEP: hiding it because data has not arrived would make the strip flicker as it
 *  loads, and would hide a legal action from a player whose privates simply had not loaded yet. */
export function hasBuyablePrivate(
  privates: readonly PrivateAvailability[] | null | undefined,
): boolean {
  if (privates === null || privates === undefined) return true;
  return privates.some((entry) => !entry.closed && entry.owner_protocol_id === null);
}

/* Design note #613: THE RULE IS A PHASE NUMBER, SO SAY THE PHASE NUMBER. Corporations may buy privates from the
   first 3-train until the first 5-train closes them. The old test approximated that in two hops -- an era check
   for the lower bound and #385's "is anything still buyable" for the upper -- correct only because the second
   hop happens to be true whenever the first is wrong.
   WHY THAT WAS WORTH TIGHTENING even though it behaved: the upper bound was enforced by a CONSEQUENCE of Phase
   5 rather than by Phase 5, which is a correct reading of a state the contract has to have written first -- so
   during any window where the phase has advanced and the closures have not yet arrived, the step would offer
   itself. Testing the phase closes that window and makes the rule legible.
   THE ERA STAYS AS THE FALLBACK, NOT AS THE RULE: `derivePhase` reports `known: false` when no corporation has
   reported trains, and there is then no phase number to test.
   `initialOrSubPhase` IS DELIBERATELY UNCHANGED. It mirrors the contract's `initial_sub_phase`, which decides
   where the CURSOR starts, and a mirror that stops matching its original is worse than an imprecise one. */
export function visibleSubPhases(
  era: string | null | undefined,
  privates?: readonly PrivateAvailability[] | null,
  /** The phase number from `derivePhase`. Omitted or `null` falls back to
   *  the era test -- see the note above. */
  tier?: string | null,
): readonly OperatingSubPhase[] {
  // #1440: the private purchase is a standing button, not a step -- see `privatesBuyableNow` for the rule.
  void era;
  void privates;
  void tier;
  return OPERATING_SUB_PHASE_ORDER;
}

/** #1440: whether a corporation may buy a private RIGHT NOW -- Phases 3 and 4 (the first 3-train opens it,
 *  the first 5-train closes the privates), with something left to buy. The era is the fallback while no
 *  corporation has reported trains. */
export function privatesBuyableNow(
  era: string | null | undefined,
  privates: readonly PrivateAvailability[] | null | undefined,
  tier: string | null | undefined,
): boolean {
  const phaseAllows = tier === null || tier === undefined ? !(era === "Yellow" || !era) : tier === "3" || tier === "4";
  return phaseAllows && hasBuyablePrivate(privates);
}

