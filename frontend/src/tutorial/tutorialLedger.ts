// frontend/src/tutorial/tutorialLedger.ts
//
/* ==================================================================
    PHASE 3 FINAL PLAY TUTORIAL: WHAT THIS PLAYER HAS BEEN TAUGHT IN THIS GAME
   ==================================================================
   REPLACES the old per-browser "seen forever" flags (`1830juno.tutorial_seen.v1.<topic>`), which let one game's
   tutorial silence every later game and gave a second account on the same browser nothing at all.

   ONE RECORD PER SEAT PER GAME, in the app's own `localStorage` namespace:

       1830juno.tutorial.v2.<gameId>.seat<N>     {v: 2, updatedAt, gen, acknowledged: [lessonId], pending: [{id, subject?}]}

   `gen` counts "Restart tutorials for this game": a restart in one tab bumps it, and another tab of the same seat
   that sees a newer generation ADOPTS that record instead of merging its own older acknowledgements back in.

   WHY THIS KEY SATISFIES THE IDENTITY AND PRIVACY CONSTRAINTS. It is the notice ledger's key shape exactly
   (`utils/noticeAcknowledgements.ts`, owner ruling OD-5(a)): `gameId` is the server-minted room id (`g_…`) the shell
   already holds, and `seat<N>` is the seat's PUBLIC POSITION in the room roster -- never a principal, player id,
   seat PIN or token, which the client must not persist (LIVE-2D). The same seat reads the same record across reload,
   tab and remount; every other seat at the table, even on one machine, has its own; another game has another key.
   A WATCHER HAS NO RECORD AT ALL (`tutorialLedgerKey` answers `null`): watchers receive no automatic tutorials.

   NOT THE LOG, AND NOT THE SERVER: whether one viewer read a teaching card is not game state (the notice ledger's
   #896 rule), and the owner's brief rules out a server-side preferences schema for this pass.

   ACKNOWLEDGED  lessons this player answered ("Got it"). Never raised again in this game -- so an Undo, whose
                 replay re-derives the same edge, cannot teach it twice.
   PENDING       lessons this player WITNESSED and has not answered. A reload, a new tab or a remount brings them
                 back. Nothing historical is ever added: the shell raises lessons only from live entries.

   A NEW DEVICE OR CLEARED STORAGE starts with no record and therefore no pending lessons -- it teaches from the live
   game forward and never replays the table's history.

   WRAPPED, because storage throws in a private window or with site data blocked; an unreadable store degrades to
   this mount's memory. */

import { isLessonId, type LessonId } from "./lessons";

export const TUTORIAL_STORAGE_PREFIX = "1830juno.tutorial.v2.";
/** How many games' records one browser keeps; the oldest is pruned past this. */
export const TUTORIAL_MAX_GAMES = 40;
/** The automatic-tutorial preference. ON unless this key holds "off" -- a standing preference of this browser,
 *  reversible from the Tutorials library at any time (the old `tutorials_off.v1` one-way switch is retired). */
export const TUTORIAL_AUTO_KEY = "1830juno.tutorials_auto.v2";

export interface PendingLesson {
  readonly id: LessonId;
  /** The corporation an event lesson is about, when there is one. */
  readonly subject?: number;
}

/** The slice of the server's room view the key needs (the notice ledger's `NoticeLedgerViewer`). */
export interface TutorialLedgerViewer {
  readonly gameId: string;
  readonly players: ReadonlyArray<{ readonly id: string }>;
  readonly you: { readonly playerId: string | null };
}

/** This seat's record key in this game, or `null` for a watcher or before the room view names the seat. */
export function tutorialLedgerKey(view: TutorialLedgerViewer | null | undefined): string | null {
  if (!view || !view.gameId) return null;
  const playerId = view.you.playerId;
  if (!playerId) return null;
  const seat = view.players.findIndex((player) => player.id === playerId);
  return seat >= 0 ? `${TUTORIAL_STORAGE_PREFIX}${view.gameId}.seat${seat}` : null;
}

/** Whether automatic tutorials are on (the default). */
export function tutorialsAutoEnabled(): boolean {
  try {
    return window.localStorage.getItem(TUTORIAL_AUTO_KEY) !== "off";
  } catch {
    return true;
  }
}

/** Turns automatic tutorials on or off for this browser. */
export function setTutorialsAuto(enabled: boolean): void {
  try {
    if (enabled) window.localStorage.removeItem(TUTORIAL_AUTO_KEY);
    else window.localStorage.setItem(TUTORIAL_AUTO_KEY, "off");
  } catch {
    /* A browser that refuses storage keeps the default for this mount. */
  }
}

interface StoredRecord {
  readonly gen: number;
  readonly acknowledged: readonly string[];
  readonly pending: readonly PendingLesson[];
}

const EMPTY: StoredRecord = { gen: 0, acknowledged: [], pending: [] };

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

function isPendingLesson(value: unknown): value is PendingLesson {
  return (
    isObject(value) &&
    typeof value.id === "string" &&
    isLessonId(value.id) &&
    (value.subject === undefined || typeof value.subject === "number")
  );
}

/** A stored record is untrusted input: unknown lesson ids (an older or newer build) and bad shapes are dropped. */
function readRecord(key: string): StoredRecord {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return EMPTY;
    const parsed: unknown = JSON.parse(raw);
    if (!isObject(parsed)) return EMPTY;
    const acknowledged = Array.isArray(parsed.acknowledged)
      ? parsed.acknowledged.filter((id): id is string => typeof id === "string" && isLessonId(id))
      : [];
    const pending = Array.isArray(parsed.pending) ? parsed.pending.filter(isPendingLesson) : [];
    const gen = typeof parsed.gen === "number" && Number.isFinite(parsed.gen) ? parsed.gen : 0;
    return { gen, acknowledged, pending };
  } catch {
    return EMPTY;
  }
}

function updatedAtOf(key: string): number {
  try {
    const raw = window.localStorage.getItem(key);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return isObject(parsed) && typeof parsed.updatedAt === "number" ? parsed.updatedAt : 0;
  } catch {
    return 0;
  }
}

function pruneRecords(keep: string): void {
  try {
    const keys: string[] = [];
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (key && key.startsWith(TUTORIAL_STORAGE_PREFIX) && key !== keep) keys.push(key);
    }
    if (keys.length < TUTORIAL_MAX_GAMES) return;
    const oldestFirst = keys
      .map((key) => ({ key, at: updatedAtOf(key) }))
      .sort((a, b) => a.at - b.at || a.key.localeCompare(b.key));
    for (const { key } of oldestFirst.slice(0, keys.length - (TUTORIAL_MAX_GAMES - 1))) {
      window.localStorage.removeItem(key);
    }
  } catch {
    /* housekeeping only */
  }
}

export class TutorialLedger {
  private key: string | null = null;
  private gen = 0;
  private acknowledged = new Set<string>();
  private pendingList: PendingLesson[] = [];

  /** The record this ledger reads and writes; `null` means no seat -- nothing is raised. */
  get storageKey(): string | null {
    return this.key;
  }

  /** Points the ledger at a seat's record. Idempotent. Moving between records carries nothing: they are different
   *  games or different seats. Answers whether anything changed. */
  bind(key: string | null): boolean {
    if (key === this.key) return false;
    this.key = key;
    const stored = key ? readRecord(key) : EMPTY;
    this.gen = stored.gen;
    this.acknowledged = new Set(stored.acknowledged);
    this.pendingList = stored.pending.filter((entry) => !this.acknowledged.has(entry.id));
    return true;
  }

  /** Re-reads the record (another tab of this seat wrote it). Acknowledgements only accumulate. */
  reload(): boolean {
    if (!this.key) return false;
    const before = this.signature();
    const stored = readRecord(this.key);
    if (stored.gen > this.gen) {
      /* Another tab restarted this game's tutorials (or this tab is behind one that did): adopt its record. */
      this.gen = stored.gen;
      this.acknowledged = new Set(stored.acknowledged);
    } else {
      for (const id of stored.acknowledged) this.acknowledged.add(id);
    }
    this.pendingList = stored.pending.filter((entry) => !this.acknowledged.has(entry.id));
    return this.signature() !== before;
  }

  isAcknowledged(id: string): boolean {
    return this.acknowledged.has(id);
  }

  isPending(id: string): boolean {
    return this.pendingList.some((entry) => entry.id === id);
  }

  /** This player's witnessed, unanswered lessons, oldest first. */
  pending(): readonly PendingLesson[] {
    return this.pendingList;
  }

  /** A lesson this player witnessed. Refused without a seat, once answered, or while already waiting. Answers
   *  whether the record changed. */
  raise(entry: PendingLesson): boolean {
    if (!this.key || !isLessonId(entry.id)) return false;
    if (this.acknowledged.has(entry.id) || this.isPending(entry.id)) return false;
    this.pendingList = [...this.pendingList, entry.subject === undefined ? { id: entry.id } : entry];
    this.persist();
    return true;
  }

  /** The player answered it: never raised again in this game. */
  /** The id the last `acknowledge` recorded -- kept across a newer generation adopted by `persist`. */
  private lastAcknowledged: string | null = null;

  acknowledge(id: string): void {
    if (!this.key) return;
    this.lastAcknowledged = id;
    this.acknowledged.add(id);
    this.pendingList = this.pendingList.filter((entry) => entry.id !== id);
    this.persist();
  }

  /** The moment passed before the lesson could be shown (a decision that no longer stands). Removed from pending
   *  WITHOUT being acknowledged, so the next live occurrence raises it again. */
  withdraw(id: string): boolean {
    if (!this.isPending(id)) return false;
    this.pendingList = this.pendingList.filter((entry) => entry.id !== id);
    this.persist(true);
    return true;
  }

  /** "Restart tutorials for this game": forget everything this seat was taught in this game. */
  restart(): void {
    if (!this.key) return;
    this.gen = Math.max(this.gen, readRecord(this.key).gen) + 1;
    this.acknowledged = new Set();
    this.pendingList = [];
    this.write();
  }

  private signature(): string {
    return JSON.stringify([Array.from(this.acknowledged).sort(), this.pendingList.map((entry) => entry.id)]);
  }

  /** READ, MERGE, WRITE: another tab of this seat may have answered something this one has not heard about.
   *  `replacePending`: this tab's pending list is the truth (a withdrawal), not a merge with the stored one. */
  private persist(replacePending = false): void {
    const key = this.key;
    if (!key) return;
    const stored = readRecord(key);
    if (stored.gen > this.gen) {
      /* Another tab restarted since this one read: its record is the truth. Only what this tab just did on top of
         it survives -- an acknowledgement made here is kept, nothing older is merged back. */
      const justAnswered = this.lastAcknowledged;
      this.gen = stored.gen;
      this.acknowledged = new Set(stored.acknowledged);
      if (justAnswered) this.acknowledged.add(justAnswered);
      for (const entry of stored.pending) {
        if (!this.isPending(entry.id)) this.pendingList = [...this.pendingList, entry];
      }
    } else if (stored.gen === this.gen) {
      for (const id of stored.acknowledged) this.acknowledged.add(id);
      if (!replacePending) {
        for (const entry of stored.pending) {
          if (!this.isPending(entry.id)) this.pendingList = [...this.pendingList, entry];
        }
      }
    }
    this.pendingList = this.pendingList.filter((entry) => !this.acknowledged.has(entry.id));
    this.lastAcknowledged = null;
    this.write();
  }

  private write(): void {
    const key = this.key;
    if (!key) return;
    try {
      window.localStorage.setItem(
        key,
        JSON.stringify({
          v: 2,
          updatedAt: Date.now(),
          gen: this.gen,
          acknowledged: Array.from(this.acknowledged),
          pending: this.pendingList,
        }),
      );
    } catch {
      return;
    }
    pruneRecords(key);
  }
}
