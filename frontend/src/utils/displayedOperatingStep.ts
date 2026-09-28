// frontend/src/utils/displayedOperatingStep.ts
//
// Which Operating Round step the Action Bar draws.
//
// ==================================================================
//  6.5-B (SI-H01 / H-01a): ON THE SERVER PATH THE BAR DRAWS THE LIVE STEP
// ==================================================================
//
// #1094 / #1145 froze the bar on the step a run of auto-skips started from, because on the Firestore path THIS
// client dispatched each skip and the step moved one network round trip later -- the bar would otherwise have
// painted every step it was walking past. The freeze held `settledSubPhaseRef` while the shell's own verdict
// (`autoSkipReason`) said "skip" and the key was unspent or in flight.
//
// THE HOSTED SERVER PATH HAS NO SUCH GAP. The shell's derived dispatch is dropped there (`App.tsx`,
// `link && options?.derived === true`); the server derives the skips itself (`RoomSession.submit` ->
// `settleOwed`) and every `applied` frame carries the whole burst, which the client drains in one commit -- so the
// board a hosted client commits is a settle point, and its `operating_sub_phase` is already the step the turn is
// really on. A freeze there only ever shows an EARLIER step, and it did so wherever the shell's verdict and the
// server's disagree: at Buy Trains while a train discard is owed (the server derives nothing; the shell says
// "at its train limit"), which after a reload drew Lay Track -- with Lay Track controls the server refuses --
// above the discard prompt the table was actually waiting on (H-01a). The D&H phantom (DH-3) froze it the same
// way.
//
// So on the server path the displayed step IS the live step. The legacy (no game server configured) path keeps
// #1094/#1145 exactly as they were: it is the only path on which this client dispatches its own skips.

import type { OperatingSubPhase } from "../gameEngine/operatingSubPhase";

export interface DisplayedOperatingStepInput {
  /** A game server is configured (`GAME_SERVER_URL`): the server derives every skip and the client commits
   *  settle points only. */
  hostedServerPath: boolean;
  /** The legacy freeze's own condition (`autoSkipPending`): the shell is mid-run through skips it dispatches. */
  freezeHolding: boolean;
  /** The step the legacy freeze holds (`settledSubPhaseRef.current`). */
  settled: OperatingSubPhase;
  /** The live step: `operating_sub_phase` on the board (`orSubPhase`). */
  live: OperatingSubPhase;
}

/** The step the Action Bar draws. On the hosted server path always the live one. */
export function displayedOperatingSubPhase(input: DisplayedOperatingStepInput): OperatingSubPhase {
  if (input.hostedServerPath) return input.live;
  return input.freezeHolding ? input.settled : input.live;
}
