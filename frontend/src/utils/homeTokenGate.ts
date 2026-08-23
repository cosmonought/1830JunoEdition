import { pendingHomeTokens } from "./sandboxSession";
import type { GameStateResponse } from "./gameState";

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
 */

/** Messages that may still be dispatched while a home token is owed. */
const ALWAYS_ALLOWED: readonly string[] = ["PlaceHomeStation", "UndoLastAction"];

export interface HomeTokenGateInput {
  state: GameStateResponse;
  /** #7's injection rule: the board's label lookup lives in `components/`. */
  homeHexToAxial: (label: string) => readonly [number, number] | null;
  /** The message about to be applied, or `undefined` to ask only whether anything is owed. */
  msg?: unknown;
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

  const owed = pendingHomeTokens(state, homeHexToAxial)[0];
  if (!owed) return null;

  if (msg !== undefined) {
    const key =
      typeof msg === "object" && msg !== null ? (Object.keys(msg)[0] ?? "") : String(msg ?? "");
    if (ALWAYS_ALLOWED.includes(key)) return null;
  }

  const who = owed.president
    ? (labelForAddress?.(owed.president) ?? owed.president)
    : "its President";
  return (
    `${owed.ticker} has floated and its home station is not on the board yet. ` +
    `${who} must place it on ${owed.hexLabel} before play continues.`
  );
}

/** Whether anything is owed at all, for surfaces that only need the fact. */
export function homeTokenOwed(
  state: GameStateResponse,
  homeHexToAxial: (label: string) => readonly [number, number] | null,
): boolean {
  return pendingHomeTokens(state, homeHexToAxial).length > 0;
}
