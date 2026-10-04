// frontend/src/utils/submissionAnswer.ts
//
/* ==================================================================
    PHASE 3 W3-C (P3-N020): A REFUSED MOVE TAKES BACK THE SHELL STATE ITS HANDLER SET FOR IT
   ==================================================================
   A few handlers write shell-only state for the move they send, before the room has answered: a lay that spends a
   private's power marks it spent in the shell's fallback set and disarms the JK; a run marks the corporation as having
   run (`routesRunThisTurn`, what keeps `skippedRoutes` from reading a skip) and moves the local step cursor. When the
   room REFUSED the move, those writes described a move that did not happen -- the power read as used, the run as
   made. The board itself was never touched (the server path applies nothing until the drain brings the entry).

   THE ANSWER IS THE ROOM'S, PER ACTION. `runGameplayAction`'s room branch resolves `allocated !== null`
   (OD-12 RED R1): `true` -- the room applied it; `false` -- it did not (refused, stale, not sent); `undefined` -- not
   a room submission (the solo sandbox, the chain), where nothing was sent to be refused. Only `false` takes anything
   back. Nothing here judges legality: the refusal is the server's, and its sentence is in the strip. */

/** The room said it did not apply this submission. */
export function submissionRefused(answer: unknown): boolean {
  return answer === false;
}

/** Runs `rollback` once the dispatch answers, and only if the room did not apply it. */
export function rollBackIfRefused(dispatched: unknown, rollback: () => void): Promise<void> {
  return Promise.resolve(dispatched).then((answer) => {
    if (submissionRefused(answer)) rollback();
  });
}
