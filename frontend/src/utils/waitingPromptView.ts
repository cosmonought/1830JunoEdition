// frontend/src/utils/waitingPromptView.ts
//
// Who gets the CONTROLS of a forced prompt, and who gets the read-only status instead.
//
// ==================================================================
//  PHASE 3 W2-H (OD-1): ONE VIEWER POLICY FOR THE PROMPTS THAT STOP THE TABLE
// ==================================================================
//
// OD-1 (owner, 2026-10-03): ordinary inactive-player behaviour is NOT redesigned. For the prompts that stop the
// whole table, the actual actor gets the controls and every other viewer gets a read-only status surface with a
// focus target. Three prompts share that shape:
//
//   - the home station      -- the named President of the operating corporation acts;
//   - the B&O par           -- the named owner of the B&O private acts;
//   - the auction handoff   -- any SEATED player may open the Stock Round (the server's `submit` row is "seated
//                              only"), so a seated player acts and a watcher waits;
//   - (not this slice) the emergency purchase: the obligated President acts, everyone else reads a simplified
//     status. `viewerIsNamedActor` is already that rule, so W2-G can call it unchanged.
//
// THE SAFE DIRECTION IS ALWAYS "WAITING". Every arm below that cannot prove this viewer is the actor answers
// false: a spectator (whatever wallet it holds), a seatless watcher (id ""), a tab that has not learned its seat
// (null / undefined), and a board that names nobody. A waiting surface offers no control, and the actor's own
// client still has the form -- so a wrong "false" costs a sentence, while a wrong "true" hands a watcher a form
// the server refuses.

/** Is this viewer the one player the board names as the actor? */
export interface NamedActorInput {
  /** `mode === "spectate"`: a read-only viewer, whatever address its wallet holds. */
  spectator: boolean;
  /** The player the board names (the President who owes the home, the B&O par's owner). */
  actor: string | null | undefined;
  /** This tab's in-game id: the room seat in a room (`""` for a watcher), the wallet address on the chain path. */
  viewerAddress: string | null | undefined;
}

/** True only for the named actor's own, non-spectating screen. No escape arm: `""` is a watcher's id, so it is
 *  excluded by the same test rather than by a separate falsy arm (W1-J, A-2). */
export function viewerIsNamedActor({ spectator, actor, viewerAddress }: NamedActorInput): boolean {
  if (spectator) return false;
  if (typeof actor !== "string" || actor.length === 0) return false;
  return actor === viewerAddress;
}

/** Is this viewer one of the seated players -- the actor for a step any seat may take? */
export interface SeatedActorInput {
  spectator: boolean;
  viewerAddress: string | null | undefined;
  /** The board's seats (`player_addresses`). */
  seats: ReadonlyArray<string> | null | undefined;
}

/** True only for a non-spectating viewer whose id is one of the board's seats. */
export function viewerIsSeatedPlayer({ spectator, viewerAddress, seats }: SeatedActorInput): boolean {
  if (spectator) return false;
  if (typeof viewerAddress !== "string" || viewerAddress.length === 0) return false;
  return (seats ?? []).includes(viewerAddress);
}
