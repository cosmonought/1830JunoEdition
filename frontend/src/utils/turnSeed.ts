// The die a turn already rolled, found again after an undo.
//
// ==================================================================
//  DESIGN NOTE 1051: THE ROLL SURVIVES THE UNDO BECAUSE THE LOG DOES
// ==================================================================
//
// THE SLOT MACHINE IS THE THING TO PREVENT, and it was named before the feature was built: "the die rolls
// need to be un-undoable -- once a player Runs Routes, the die should roll and Undoing it should not change
// their roll, otherwise players would just slot machine their way to +20%."
//
// A HASH OF THE TURN GAVE THAT AWAY FOR FREE and cost the whole feature to get it (`gameVariants.ts` #1051).
// A real roll has to earn it, and this module is where.
//
// THE FACT THAT MAKES IT POSSIBLE: undo does not delete anything. `RevertTo { index }` is itself an appended
// entry meaning "everything from here on did not happen" (`logRevert.ts` #591), and `effectiveActions`
// filters those out when rebuilding the board. The entries are still in the log. The drain keeps the
// unfiltered list in `sandboxLogRef.current` precisely because it needs to re-derive the effective history
// from it on every snapshot.
//
// SO A NUMBER WRITTEN INTO AN ACTION OUTLIVES THE ACTION. Run routes and the draw is recorded; undo and the
// run stops counting; re-run and the draw is still there to be found. The player gets the same face, which is
// the physical game exactly -- the die is on the table, and taking your move back does not let you roll it
// again.
//
// THIS READS THE RAW LOG, NOT THE EFFECTIVE ONE, and that is the entire point rather than an oversight. Every
// other consumer in this codebase wants `effectiveActions` and would be wrong to read the raw list; this one
// is wrong to read anything else, because the entry it is looking for is by definition one an undo has
// killed. Worth stating loudly: a later tidy-up that "corrects" the caller to pass the effective log would
// reinstate the slot machine, and nothing would fail.
//
// See docs/ai_architecture/firebase_middleware.md, turnSeed.ts #1051.

/** The shape this needs from a log entry.
 *
 *  Declared here rather than imported from the Firestore bridge, matching `logRevert.ts`'s reasoning: a pure
 *  function over history should not drag in the transport that happens to store it. `SandboxAction` is
 *  structurally compatible. */
export interface SeededEntry {
  payload: string;
}

/** The turn a roll belongs to, as one string.
 *
 *  Design note #1051: THE SAME THREE PARTS THE HASH USED TO EAT (#941), and for the same reason -- a roll is
 *  scoped to a corporation's operating turn, so that is what identifies it. It travels on the message beside
 *  the seed because the message alone cannot say it: `protocol_id` names the corporation, but the round and
 *  sub-round live in the STATE, and a client scanning the raw log for an earlier draw has only the log.
 *
 *  A STRING, NOT THREE FIELDS. It is compared and never decomposed, so one value cannot half-match -- and it
 *  reads identically to the key `revenueSeedHash` built, which is what a reader comparing the two will expect.
 */
export function turnSeedKey(macroRound: number, subRound: number, companyId: number): string {
  return `${macroRound}.${subRound}.${companyId}`;
}

/** The seed this turn has already drawn, or `null` if it has not drawn one.
 *
 *  SEARCHED BACKWARDS, so the answer is the most recent draw for that turn. It matters when a player undoes
 *  twice: the log then holds several entries for the same key, and the one that should govern is the one the
 *  player last saw on screen. Forwards would hand back the oldest, which is a face nobody has looked at since.
 *
 *  `null` RATHER THAN A FRESH DRAW, so the caller decides. Rolling here would make this function impure and
 *  untestable in the one case that matters -- "did it find the earlier roll" and "did it invent one" would
 *  become the same observation. */
export function seedAlreadyRolled(
  rawLog: readonly SeededEntry[],
  key: string,
): number | null {
  for (let at = rawLog.length - 1; at >= 0; at -= 1) {
    const found = seedOnEntry(rawLog[at], key);
    if (found !== null) return found;
  }
  return null;
}

/** The seed carried by one entry, if it is a run for `key` that recorded one. */
function seedOnEntry(entry: SeededEntry, key: string): number | null {
  let parsed: unknown;
  /* A CORRUPT PAYLOAD READS AS "NO SEED HERE", never as a throw. `logRevert.ts` takes the same line about the
     same log and states the reason: an entry nobody can parse must not be able to break the game. The cost of
     being wrong here is one extra draw; the cost of throwing is a dispatch that dies. */
  try {
    parsed = JSON.parse(entry.payload);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const run = (parsed as { RunMultipleRoutes?: unknown }).RunMultipleRoutes;
  if (typeof run !== "object" || run === null) return null;
  const body = run as { revenue_seed?: unknown; revenue_turn?: unknown };
  if (body.revenue_turn !== key) return null;
  /* ==================================================================
      BOTH FIELDS ARE CHECKED, AND THE TURN IS CHECKED FIRST
     ==================================================================
     An entry from before #1051 has neither, and one written by a client mid-upgrade could have the turn and
     not the seed. Reading `revenue_seed` off an entry that never claimed to carry one is how `undefined`
     becomes `NaN` becomes a die face of `NaN`, which #232's rule is written to prevent: absent is not a
     value. A non-finite number is treated as absent for the same reason. */
  const seed = body.revenue_seed;
  if (typeof seed !== "number" || !Number.isFinite(seed)) return null;
  return seed;
}
