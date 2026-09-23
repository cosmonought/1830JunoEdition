import type { GameStateResponse } from "./gameState";
import type { SandboxLogMsg } from "./gameSetup";
import { homeStationHold, owedHomeStation } from "./homeStationAuthority";

/* ==================================================================
 *  DESIGN NOTE 763: A FLOAT IS NOT FINISHED UNTIL THE TOKEN IS DOWN
 * ==================================================================
 *
 * REPORTED: "While the modal telling P1 to place their corp home station was open, P2 was able to buy a share
 * and the game kept going." Asked which way to resolve it: "I suppose the safest thing is to refuse every
 * action until the home station is placed."
 *
 * IN 1830 THERE IS NO GAP TO ACT IN. Floating a corporation and putting its home token on the board are one
 * event -- the token goes down as the sixth share is bought, and play continues from a board that already has
 * it. Our version splits them because #416 made the placement a PROMPT: "the prompt is not asking which hex,
 * it is making the player witness the placement." That was the right call for a screen and it opened a window
 * the physical game does not have.
 *
 * AND THE WINDOW IS NOT MERELY UNTIDY. Everything downstream reads the board: the operating queue, the
 * network veil, the route tracer, every predicate that asks where a corporation reaches. A purchase settled
 * against a corporation that has floated but has no token is settled against a board that cannot exist, and
 * #762's crash was one consequence of exactly that state persisting across another player's action.
 *
 * SO THE GATE IS IN THE REDUCER, not on the buttons. #712, #736, #748 and #757 all record the same finding
 * from different directions: a rule enforced only where the controls are drawn is a rule with a door beside
 * it. This one runs on every client that replays the log.
 *
 * TWO MESSAGES ARE ALWAYS LET THROUGH, and both matter more than they look:
 *   the PLACEMENT itself, obviously, or the gate would lock the board forever;
 *   UNDO, because a gate with no exit turns any bad state into an unrecoverable one, and undo is the only
 *   thing that can rewind past whatever produced it.
 *
 * ==================================================================
 *  SUPERSEDED BY DESIGN NOTES 1610 / 1612 (Stage 8, Slice 8.2)
 * ==================================================================
 *
 * "IN 1830 THERE IS NO GAP TO ACT IN" IS NOT THE RULE. Floating and placing the home token are NOT one event:
 * 6.3.1 places the home station "at the beginning of a railroad's first turn of operation", and 5.3 has a
 * floated corporation begin operating in the next Operating Round. The gap #763 closed by freezing the whole
 * table was the rulebook's own interval between a Stock Round float and that corporation's first turn -- and
 * freezing it stopped the Stock Round the rules let continue.
 *
 * WHAT SURVIVES. The obligation is derived on the Operating Round cursor (`owedHomeStation`): only the operating
 * corporation, only at the start of its first operating turn, and only until it holds a token. The hold is that
 * corporation's turn-local hold (`homeStationHold`), asked by the reducer before anything moves (#1613), by
 * ingress as its fourth hold (S8-12) and by the derived loop. This file keeps its two names for the shell -- the
 * Pass button's reason and the Auto-Buy guard -- and answers both from that one module, so there is no second
 * pass list here: the placement, #763's Undo, and the room's `RevertTo` / `CloseRoom` (see #1612).
 */

export interface HomeTokenGateInput {
  state: GameStateResponse;
  /** #7's injection rule: the board's label lookup lives in `components/`. */
  homeHexToAxial: (label: string) => readonly [number, number] | null;
  /** The message about to be applied, or `undefined` to ask only whether anything is owed. */
  msg?: SandboxLogMsg;
  /** How to render a wallet as a name. Identity by default. */
  labelForAddress?: (address: string) => string;
}

/** Why nothing may happen yet, or `null`.
 *
 *  A REASON RATHER THAN A BOOLEAN (#619), and it names the corporation AND the president -- the player who
 *  reads it is usually not the one holding things up, and "wait" without "for whom" is the most annoying
 *  message a game can show. */
export function homeTokenBlock(input: HomeTokenGateInput): string | null {
  const { state, homeHexToAxial, msg, labelForAddress } = input;
  /* #1612: the one hold, the one sentence -- "<ticker> is starting its first operating turn and its home
     station is not on the board yet. <who> must place it on <hexes> before <ticker> can operate." */
  return homeStationHold(state, msg, homeHexToAxial, labelForAddress);
}

/** Whether anything is owed at all, for surfaces that only need the fact. */
export function homeTokenOwed(
  state: GameStateResponse,
  homeHexToAxial: (label: string) => readonly [number, number] | null,
): boolean {
  return owedHomeStation(state, homeHexToAxial) !== null;
}
