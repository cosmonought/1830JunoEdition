// frontend/src/tutorial/coordinator.ts
//
/* ==================================================================
    PHASE 3 FINAL PLAY TUTORIAL: THE COORDINATOR -- WHICH ONE LESSON MAY TAKE THE COACH NOW
   ==================================================================
   ONE COACH, ONE LESSON. Tutorials no longer open themselves whenever a boolean turns true (the four independent
   `TutorialModal`s did); every raised lesson waits in this player's ledger and this function picks the one that
   may show, or none.

   TUTORIALS YIELD TO MANDATORY INFORMATION, NEVER THE REVERSE. A lesson never shows over or under:
     - a cinematic (the intro or the outro film),
     - any open native dialog -- every forced notice (Emergency, Fleet Loss, Private Revenue, Phase Three,
       Herald), the stale-board notice, Game Over, the library itself, any other `NativeModal`,
     - a forced notice that is DUE but held (waiting behind another dialog),
     - the Home Station prompt or any other mandatory board-interaction surface,
     - a replay scrub.
   A blocked lesson is SUSPENDED, not acknowledged: it stays pending and comes back when the way is clear, if it is
   still relevant. This is NOT a sixth forced-notice kind -- the notice chain (`utils/noticeChain.ts`) neither knows
   nor waits for a tutorial; the dependency runs one way only.

   PRESENTATION ONLY. Whether a lesson is due is the ledger's (witnessed, unanswered); whether it still belongs on
   screen is `lessonRelevant` (triggers.ts). */

import type { PendingLesson } from "./tutorialLedger";
import type { Relevance } from "./triggers";

export interface TutorialBlockers {
  /** The intro or outro film is playing. */
  readonly cinematic: boolean;
  /** Any native dialog is open (forced notices, the stale-board notice, the library, Game Over, ...). */
  readonly nativeDialogOpen: boolean;
  /** A forced notice is due, presented or held. */
  readonly forcedNoticeDue: boolean;
  /** A mandatory board-interaction surface (the Home Station prompt) is up. */
  readonly boardInteraction: boolean;
  /** The board is a replay scrub, not the live game. */
  readonly scrubbing: boolean;
}

export type TutorialHold = "off" | "not-seated" | keyof TutorialBlockers;

export interface CoordinatorInput {
  readonly pending: readonly PendingLesson[];
  /** Automatic tutorials are on. */
  readonly auto: boolean;
  /** This viewer is a seated player (watchers get no automatic tutorials). */
  readonly seated: boolean;
  readonly blockers: TutorialBlockers;
  /** `true` / `false`, or "unknown" while the board is not a dealt game: an unknown lesson is held, never withdrawn. */
  readonly relevant: (entry: PendingLesson) => Relevance;
  /** Decision lessons not yet steady: raised this instant, possibly for a step the shell is about to auto-advance.
   *  Held, not withdrawn, until they have stood a moment (the shell's timer re-asks). */
  readonly settling?: (entry: PendingLesson) => boolean;
  /** The lesson on screen now, if any: it stays until answered, withdrawn or held, so a card being read is never
   *  swapped for another that became eligible a moment later. */
  readonly showing?: string | null;
}

export interface CoordinatorDecision {
  /** The one lesson the coach shows, or `null`. */
  readonly present: PendingLesson | null;
  /** Why nothing is shown, when a lesson is waiting and something holds it. */
  readonly hold: TutorialHold | null;
  /** Pending lessons whose moment has passed: withdraw them, unacknowledged. */
  readonly withdraw: readonly string[];
}

const BLOCKER_ORDER: readonly (keyof TutorialBlockers)[] = [
  "cinematic",
  "nativeDialogOpen",
  "forcedNoticeDue",
  "boardInteraction",
  "scrubbing",
];

export function coordinateTutorial({ pending, auto, seated, blockers, relevant, settling, showing }: CoordinatorInput): CoordinatorDecision {
  if (!seated) return { present: null, hold: pending.length > 0 ? "not-seated" : null, withdraw: [] };
  if (!auto) return { present: null, hold: pending.length > 0 ? "off" : null, withdraw: [] };
  const blocker = BLOCKER_ORDER.find((name) => blockers[name]) ?? null;
  /* While a scrub shows a past board, relevance cannot be judged against it: hold everything, withdraw nothing. */
  if (blockers.scrubbing) return { present: null, hold: pending.length > 0 ? "scrubbing" : null, withdraw: [] };
  const withdraw: string[] = [];
  let first: PendingLesson | null = null;
  for (const entry of pending) {
    const relevance = relevant(entry);
    if (relevance === false) {
      withdraw.push(entry.id);
      continue;
    }
    if (relevance !== true || settling?.(entry)) continue;
    if (!first || entry.id === showing) first = entry;
  }
  if (!first) return { present: null, hold: null, withdraw };
  if (blocker) return { present: null, hold: blocker, withdraw };
  return { present: first, hold: null, withdraw };
}
