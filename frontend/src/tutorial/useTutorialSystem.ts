// frontend/src/tutorial/useTutorialSystem.ts
//
/* ==================================================================
    PHASE 3 FINAL PLAY TUTORIAL: THE SHELL'S ONE HOOK
   ==================================================================
   Owns this seat's `TutorialLedger`, the automatic-tutorial preference and the coordinator's decision, and hands the
   shell four verbs: `raise` (from a WITNESSED entry -- the caller guarantees that), `acknowledge`, `restart`, and
   `setAuto`. Everything a lesson needs to be shown or held is computed here from what the shell passes in; nothing
   here reads the game log or the server. */

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { GameStateResponse } from "../gameEngine/gameState";
import { coordinateTutorial, type CoordinatorDecision, type TutorialBlockers } from "./coordinator";
import type { LessonId } from "./lessons";
import { DECISION_LESSONS, decisionLessons, lessonRelevant, primerFor, type RaisedLesson } from "./triggers";
import {
  TUTORIAL_AUTO_KEY,
  TutorialLedger,
  setTutorialsAuto,
  tutorialsAutoEnabled,
  type PendingLesson,
} from "./tutorialLedger";

/** How long a decision lesson must stand before the coach shows it. */
export const DECISION_SETTLE_MS = 900;

export interface TutorialSystemInput {
  /** This seat's record key (`tutorialLedgerKey`), or `null` for a watcher / no seat. */
  readonly storageKey: string | null;
  /** The viewer may receive automatic tutorials: a seated player, not spectating. */
  readonly seated: boolean;
  /** This seat's player id ("" when none). */
  readonly viewer: string;
  /** The board on screen (the live one; `null` before the deal). */
  readonly state: GameStateResponse | null;
  readonly blockers: TutorialBlockers;
}

export interface TutorialSystem {
  readonly presented: PendingLesson | null;
  readonly decision: CoordinatorDecision;
  readonly auto: boolean;
  readonly setAuto: (enabled: boolean) => void;
  /** Lessons a witnessed entry raised. Ignored while automatic tutorials are off or nobody is seated -- so turning
   *  tutorials back on teaches from that moment, with no backlog. */
  readonly raise: (lessons: readonly RaisedLesson[]) => void;
  readonly acknowledge: () => void;
  /** Forget this game's progress for this seat and teach again from the orientation and the current round. */
  readonly restart: (extra?: readonly RaisedLesson[]) => void;
  readonly ledger: TutorialLedger;
}

export function useTutorialSystem({ storageKey, seated, viewer, state, blockers }: TutorialSystemInput): TutorialSystem {
  const ledgerRef = useRef<TutorialLedger | null>(null);
  if (ledgerRef.current === null) ledgerRef.current = new TutorialLedger();
  const ledger = ledgerRef.current;
  const [revision, bump] = useReducer((count: number) => count + 1, 0);
  /* Bound during render, as the notice ledger is: idempotent, and the record must be known before this render's
     decision is taken. */
  ledger.bind(seated ? storageKey : null);

  const [auto, setAutoState] = useState<boolean>(() => tutorialsAutoEnabled());
  const autoRef = useRef(auto);
  autoRef.current = auto;
  const seatedRef = useRef(seated);
  seatedRef.current = seated;

  /* Turning automatic tutorials OFF also withdraws whatever is waiting (unacknowledged), so turning them back ON
     teaches from that moment rather than replaying what was skipped. */
  const setAuto = useCallback(
    (enabled: boolean) => {
      setTutorialsAuto(enabled);
      autoRef.current = enabled;
      setAutoState(enabled);
      if (!enabled) {
        for (const entry of [...ledger.pending()]) ledger.withdraw(entry.id);
        bump();
      }
    },
    [ledger],
  );

  const raise = useCallback(
    (lessons: readonly RaisedLesson[]) => {
      if (!autoRef.current || !seatedRef.current) return;
      let changed = false;
      for (const lesson of lessons) changed = ledger.raise(lesson) || changed;
      if (changed) bump();
    },
    [ledger],
  );

  /* Another tab of this seat answered something, or this browser's preference changed elsewhere. */
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === TUTORIAL_AUTO_KEY) {
        const next = tutorialsAutoEnabled();
        autoRef.current = next;
        setAutoState(next);
        return;
      }
      if (event.key !== null && event.key === ledger.storageKey && ledger.reload()) bump();
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [ledger]);

  /* WHILE AUTOMATIC TUTORIALS ARE OFF NOTHING WAITS: whatever another tab, another game's record or an earlier session
     left pending is withdrawn (unacknowledged) when this record is bound or the preference goes off anywhere, so
     turning tutorials back on teaches from that moment -- never a backlog. */
  useEffect(() => {
    if (auto || ledger.pending().length === 0) return;
    for (const entry of [...ledger.pending()]) ledger.withdraw(entry.id);
    bump();
  }, [auto, storageKey, ledger, revision]);

  /* A decision lesson waits a moment before it shows: the shell auto-advances steps that hold no decision (a forced
     withhold, an auto-skipped step), and a card that flashed up for one round trip would be noise. */
  const firstSeenRef = useRef(new Map<string, number>());
  const [, tick] = useReducer((count: number) => count + 1, 0);
  const settling = (entry: PendingLesson): boolean => {
    if (!DECISION_LESSONS.has(entry.id)) return false;
    const seen = firstSeenRef.current.get(entry.id);
    const now = Date.now();
    if (seen === undefined) {
      firstSeenRef.current.set(entry.id, now);
      return true;
    }
    return now - seen < DECISION_SETTLE_MS;
  };
  for (const id of Array.from(firstSeenRef.current.keys())) if (!ledger.isPending(id)) firstSeenRef.current.delete(id);
  const anySettling = ledger.pending().some((entry) => {
    const seen = firstSeenRef.current.get(entry.id);
    return DECISION_LESSONS.has(entry.id) && (seen === undefined || Date.now() - seen < DECISION_SETTLE_MS);
  });
  useEffect(() => {
    if (!anySettling) return undefined;
    const timer = window.setTimeout(tick, DECISION_SETTLE_MS + 20);
    return () => window.clearTimeout(timer);
  });

  const showingRef = useRef<string | null>(null);
  const decision = useMemo(
    () =>
      coordinateTutorial({
        pending: ledger.pending(),
        auto,
        seated: seated && ledger.storageKey !== null,
        blockers,
        relevant: (entry) => lessonRelevant(entry, state, viewer),
        settling,
        showing: showingRef.current,
      }),
    // `revision` stands in for the ledger's contents, which a ref cannot announce.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ledger, revision, auto, seated, storageKey, state, viewer, blockers.cinematic, blockers.nativeDialogOpen, blockers.forcedNoticeDue, blockers.boardInteraction, blockers.scrubbing, Math.floor(Date.now() / DECISION_SETTLE_MS)],
  );

  /* A lesson whose moment passed (a decision that no longer stands) leaves pending UNACKNOWLEDGED. */
  const withdrawKey = decision.withdraw.join("|");
  useEffect(() => {
    if (decision.withdraw.length === 0) return;
    let changed = false;
    for (const id of decision.withdraw) changed = ledger.withdraw(id) || changed;
    if (changed) bump();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [withdrawKey, ledger]);

  const presentedId = decision.present?.id ?? null;
  showingRef.current = presentedId;
  const acknowledge = useCallback(() => {
    if (!presentedId) return;
    ledger.acknowledge(presentedId);
    bump();
  }, [ledger, presentedId]);

  const restart = useCallback((extra: readonly RaisedLesson[] = []) => {
    ledger.restart();
    if (autoRef.current && seatedRef.current) {
      const again: RaisedLesson[] = [...extra, { id: "orientation.goal" }, { id: "orientation.flow" }];
      const primer = primerFor(state?.current_round_type);
      if (primer) again.push({ id: primer });
      if (state) for (const id of decisionLessons(state, viewer)) again.push({ id: id as LessonId });
      for (const lesson of again) ledger.raise(lesson);
    }
    bump();
  }, [ledger, state, viewer]);

  return { presented: decision.present, decision, auto, setAuto, raise, acknowledge, restart, ledger };
}
