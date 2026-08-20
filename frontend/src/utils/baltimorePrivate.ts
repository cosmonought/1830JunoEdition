// frontend/src/utils/baltimorePrivate.ts
//
/* ==================================================================
 *  DESIGN NOTE 660: THE B&O PRIVATE HAS TWO RULES AND HAD NEITHER
 * ==================================================================
 *
 * REPORTED: "the rules prohibit B&O (private company) being sold to a
 * corporation and does not change hands if the owner loses the Presidency of
 * the B&O (the corporation) ... B&O (private company) closes as soon as B&O
 * (corporation) purchases its first train, and in my playthrough B&O (corp)
 * has purchased a train and is still appearing in this modal and the Player
 * card on multiple screens and Player Assets in Game Ledger."
 *
 * Both rules were already WRITTEN DOWN, in `privateCatalog.ts`, in this
 * codebase's own words: "It can never be sold to a corporation, and it stays
 * with its owner even if they later lose the B&O presidency. It closes the
 * moment the B&O buys its first train." That text has been on screen in the
 * powers panel the whole time. Nothing enforced any of it.
 *
 * A rule stated in prose and nowhere else is worse than one not stated at
 * all, because the game teaches the player a rule and then does not keep it.
 * That is the same complaint as the "GAME END" tooltip on a cell that ended
 * nothing (#652), and it is the reason this module exists rather than two
 * conditions inlined at their call sites.
 *
 * THE THIRD RULE NEEDS NO CODE. "It stays with its owner even if they later
 * lose the B&O presidency" is true by construction: `owner` is a wallet and
 * nothing in the reducer reassigns a private's owner on a presidency change.
 * Recorded here so that a later pass adding presidency-transfer side effects
 * finds out that this is deliberate, rather than discovering it as a gap.
 *
 * WHY A MODULE FOR TWO PREDICATES. Both answers are needed in three places
 * each -- the reducer, the offer list, and the tests -- and the one thing
 * that must not happen is the modal and the reducer disagreeing about whether
 * a sale is legal. A player offered a purchase the reducer then refuses has
 * been lied to by the UI; a player refused one the reducer would have allowed
 * has lost a legal move. One source for both.
 */

import { derivePhase } from "./gamePhase";
import type { GameStateResponse, PrivateCompanyState } from "./gameState";

/** The Baltimore & Ohio PRIVATE company -- `private_id` 6 in
 *  `privateCatalog.ts`, the $220/$30 certificate at the top of the auction. */
export const BAO_PRIVATE_ID = 6;

/** The Baltimore & Ohio CORPORATION -- `company_id` 4.
 *
 *  The two share a name and nothing else, which is the whole reason the rules
 *  below are easy to state and easy to get wrong. Named as separate constants
 *  so a reader of any call site can see which B&O is meant. */
export const BAO_COMPANY_ID = 4;

/** Can a corporation buy this private at all?
 *
 *  Everything except the B&O, which 1830 forbids outright. The rule has no
 *  conditions -- not a price, not a phase, not a presidency -- so it is a
 *  property of the certificate rather than of the situation. */
export function isSellableToCorporation(privateId: number): boolean {
  return privateId !== BAO_PRIVATE_ID;
}

/** Should the B&O private be closed, given the board?
 *
 *  "The moment the B&O buys its first train" -- so the test is simply whether
 *  the B&O corporation owns any train at all. Not "did a purchase happen",
 *  which would need an event; the FLEET is the evidence, and a state whose
 *  B&O has a train and whose B&O private is open is wrong however it got
 *  there.
 *
 *  `owned_trains == null` is "not reported" rather than "no trains" -- the
 *  same distinction `gamePhase.ts` draws -- and returns `false`. A board we
 *  know nothing about must not close a company on suspicion. */
export function baoPrivateShouldClose(state: GameStateResponse): boolean {
  const bao = state.public_companies.find((company) => company.company_id === BAO_COMPANY_ID);
  const trains = bao?.owned_trains;
  if (trains == null) return false;
  return trains.length > 0;
}

/** The state with the B&O private closed if it is time, or the same state.
 *
 *  Returned by identity when nothing changes, so this can be applied after
 *  every action without churning references -- the settle pattern design note
 *  #657 used for `current_global_era`, and for the same reason: the rule is a
 *  FUNCTION of the board, so recomputing it means no message can change the
 *  fleet and forget the closure.
 *
 *  `owner` and `owner_protocol_id` are released with it, matching what
 *  `applyPrivateExchange` does on the Mohawk & Hudson's exchange (design note
 *  #573a). A closed private with an owner still attached shows up in
 *  certificate counts and player assets, which is half the reported symptom.
 *
 *  PHASE 5 CLOSES EVERY PRIVATE and is a different rule with a different
 *  trigger; it is not implemented here and this does not implement it. The
 *  B&O's closure is earlier and specific, and the two must not be conflated
 *  -- a game that reaches Phase 5 with the B&O still open has a second bug,
 *  not this one. */
export function settleBaoPrivate(state: GameStateResponse): GameStateResponse {
  if (!baoPrivateShouldClose(state)) return state;
  const entry = state.private_companies.find((p) => p.private_id === BAO_PRIVATE_ID);
  if (!entry || entry.closed) return state;
  return {
    ...state,
    private_companies: state.private_companies.map((p) =>
      p.private_id === BAO_PRIVATE_ID
        ? { ...p, closed: true, owner: null, owner_protocol_id: null }
        : p,
    ),
  };
}

/** Why a corporation may not buy this private, or `null` when it may.
 *
 *  Sits beside `privatePurchaseBlockReason` in `PrivateTradePanel.tsx` rather
 *  than replacing it: that one answers about the SITUATION (unsold, already
 *  corporate-owned), this one about the CERTIFICATE. Kept apart because a
 *  reason that can never change should not be re-evaluated as though it
 *  might. */
export function corporateSaleBlockReason(entry: PrivateCompanyState): string | null {
  if (!isSellableToCorporation(entry.private_id)) {
    return "The B&O private can never be sold to a corporation.";
  }
  return null;
}

/** True once the phase has reached the point where privates close wholesale.
 *
 *  Exported unused by the reducer today, and deliberately: it is the check a
 *  future Phase 5 closure needs, and writing it beside the B&O's own rule is
 *  how the two stay distinguishable. See the note on `settleBaoPrivate`. */
export function phaseClosesAllPrivates(state: GameStateResponse): boolean {
  const phase = derivePhase(state);
  if (!phase?.known) return false;
  return phase.tier === "5" || phase.tier === "6" || phase.tier === "D";
}
