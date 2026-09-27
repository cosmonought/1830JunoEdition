// frontend/src/gameEngine/roundTransitionAuthority.ts
//
// ==================================================================
//  RR2A-F1: THE ROUNDS TURN OVER BY THEMSELVES -- A TABLE THIS ENGINE DEALT TAKES NO REQUEST FOR IT
// ==================================================================
//
// FOUND BY RUST-RETIRE-2A (H2, the retired engine's fourth auction-gate assertion) and confirmed twice through
// `RoomSession.submit` on a freshly dealt v10 game: `BeginOperatingRound`, sent by the seat the auction was waiting
// on, was accepted in any round. The schema admits it (`messageSchema.ts`), `turnRefusal` had no arm for it, and the
// reducer's arm calls `beginOperatingRound` with no round check -- so mid-auction the round became `OperatingRound`
// with an empty queue while the auction atom stayed open and stranded: every auction message was then refused ("no
// auction running"), and so was the handoff. Under the Delayed Auction the same message ended Stock Round 1 by fiat.
//
// ON A PINNED TABLE NOTHING SENDS IT. The Operating Round is opened by the reducer's own round machine -- the
// Stock Round's closing pass (`settleRoundTransitions`, #642: "the round machine belongs to the reducer") -- and the
// next Operating Round of a set by the turn that ends the last one (`advanceCorporation`). No control dispatches the
// message; it survives as a chain-era message and as the #411 repair's name. So it is refused on every board this
// engine dealt, in every round, with a sentence that says what the round is waiting for -- the same shape as
// `RunManualRoute` and `BidOnPrivate` on a pinned board (ruling Q11 / D-23). An UNPINNED board keeps the arm it was
// played on (D-9): `operatingCursorReplay.test.ts`'s harness, and the development corpus, which holds none.
//
// AND THE AUCTION'S ONE OTHER STRAY. The same probe found a second non-auction message the auction's actor could
// commit mid-auction: `PassTurn`. It escapes nothing -- the round does not move, and `OpenStockRound` wipes what it
// touched -- but it was appended as the table's last action (so the host's one-step undo of the auction move before
// it was refused) and wrote a Stock Round turn stage onto the auction's board. The auction's pass is
// `WaterfallPass`, which the dashboard and the Action Bar's Pass already send there (`App.tsx`: `isWaterfallPhase`),
// so the only sender is a stale or hand-built client -- one frame behind the set's end that arms a delayed auction,
// still holding an Operating Round's End Turn.
//
// ONE PREDICATE, ASKED AT BOTH LOCKS AND BY THE REFUSAL LINE: `turnRefusal` asks it after the holds and BEFORE the
// seat rule (so every seat hears why, not "It is not your turn." -- which would imply that on your turn you could);
// the reducer's board gate asks it above both atoms and returns the board BY IDENTITY; `refusalReasonFor` asks it so
// the shell's REFUSED line and the room's post-reducer sentence carry the same words.

import type { GameStateResponse } from "./gameState";
import type { SandboxLogMsg } from "./gameSetup";

/** RR2A-F1: `BeginOperatingRound` during the private company auction (the Delayed Auction's included). */
export const OPERATING_ROUND_FROM_AUCTION_REFUSAL =
  "The Operating Round cannot start from the private company auction. Once every private company is sold, the Stock Round opens, and the Operating Round follows it.";
/** RR2A-F1: `BeginOperatingRound` during a Stock Round. */
export const OPERATING_ROUND_FROM_STOCK_ROUND_REFUSAL =
  "The Operating Round opens by itself when the Stock Round ends — once every player has passed in a row. It cannot be started early.";
/** RR2A-F1: `BeginOperatingRound` during an Operating Round. */
export const OPERATING_ROUND_ALREADY_RUNNING_REFUSAL =
  "The Operating Round is already under way — it moves on by itself as each railroad finishes its turn.";
/** RR2A-F1: `BeginOperatingRound` once the game has ended. */
export const OPERATING_ROUND_AFTER_GAME_END_REFUSAL = "The game is over — there are no more Operating Rounds.";
/** RR2A-F1 (the auction's other stray): `PassTurn` during the private company auction. */
export const TURN_PASS_IN_AUCTION_REFUSAL =
  "This is the private company auction, not a Stock Round or Operating Round turn — pass with the auction's own Pass.";

/** Whether this board was dealt by an engine that pins its rules (#1520). An unpinned board is a legacy log's. */
const isPinned = (state: GameStateResponse): boolean => typeof state.rules_engine_version === "number";

/** Why this round-turn message is refused on this board, or `null`. `null` for every other message, and for every
 *  message on an unpinned board (D-9). */
export function roundTransitionRefusal(state: GameStateResponse, msg: SandboxLogMsg): string | null {
  if (!isPinned(state)) return null;
  if ("BeginOperatingRound" in msg) {
    switch (state.current_round_type) {
      case "WaterfallAuction":
        return OPERATING_ROUND_FROM_AUCTION_REFUSAL;
      case "OperatingRound":
        return OPERATING_ROUND_ALREADY_RUNNING_REFUSAL;
      case "GameEnd":
        return OPERATING_ROUND_AFTER_GAME_END_REFUSAL;
      default:
        return OPERATING_ROUND_FROM_STOCK_ROUND_REFUSAL;
    }
  }
  if ("PassTurn" in msg && state.current_round_type === "WaterfallAuction") return TURN_PASS_IN_AUCTION_REFUSAL;
  return null;
}
