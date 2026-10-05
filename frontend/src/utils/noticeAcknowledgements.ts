// frontend/src/utils/noticeAcknowledgements.ts
//
/* ==================================================================
    W3-A / OD-5(a): "THIS PLAYER HAS ALREADY BEEN SHOWN THIS EVENT FOR THIS GAME"
   ==================================================================
   RULED (OD-5(a), 2026-10-04): persistent acknowledgement PER USER / PER GAME. An acknowledged one-shot notice
   stays acknowledged across reload, reconnect, new tab and remount; late joiners get no backlog of historical
   notices; `sessionStorage` is not the durable authority. The notice system represents "this player has already
   been shown / acknowledged this event for this game" rather than "this browser tab happened to dismiss it".

   WHAT IT REPLACES. Fleet Loss kept its dismissals in `sessionStorage` per room (#1107), so a new tab began empty
   and replayed history (P3-N019); Herald, Phase Three and Private Revenue were plain shell state, so a reload lost
   one the player had not answered yet (AUD-11.02). One ledger now holds both halves for all four:

     ACKNOWLEDGED  the event keys this player answered. Never shown again in this game.
     PENDING       the notices this player WITNESSED and has not answered yet, with what each one needs to
                   render. A reload, a new tab or a remount brings them back; nothing else does.

   NO BACKLOG FOR SOMEONE WHO WAS NOT THERE. A notice raised while this tab is loading a history it did not
   witness (`historyIsUnwitnessed`) counts as already shown unless it is one of this player's own pending ones
   (`has`). That is the whole late-joiner rule, and it is a statement about the viewer, not a derivation from the
   current board.

   THE DURABLE MECHANISM: the app's own `localStorage` namespace (`1830juno.`), the one `TutorialModal` already
   uses for per-profile flags. NOT THE LOG: #896 ruled that whether one viewer clicked a modal is not game state
   and must not enter the log every client replays (and Undo must not rewind it).

   PER GAME AND PER SEAT, AND NOT PER PLAYER ID. The client persists no principal, player id, seat PIN or seat
   token (LIVE-2D, `activeGame.test.ts`): the seat's id is presentation held in memory only. So a record is keyed
   by the game's id and the seat's PUBLIC TABLE POSITION in the room's roster (`seat0`, `seat1`, ... or `watcher`)
   -- the same seat across reload, tab and remount, distinct for every person at the table even on one machine,
   and not an identity. If the roster ever renumbered a seat, that seat would read a fresh record: it would be
   treated as a late joiner (no backlog), which is the harmless direction.

   WRAPPED, because storage throws in a private window and on a browser with site data blocked. An unreadable
   store degrades to this mount's memory: acknowledgements still hold until the page is closed. */

import { noticeDismissKey, type FleetLossNotice } from "./fleetLossNotice";

export const NOTICE_ACK_STORAGE_PREFIX = "1830juno.notice_ack.v1.";

/** How many games' records one browser keeps. The oldest is pruned past this, so finished games cannot fill the
 *  origin's storage; a game that old has nothing left to remind anyone of. */
export const NOTICE_ACK_MAX_GAMES = 40;

export type OneShotNoticeKind = "fleetLoss" | "privateRevenue" | "phaseThree" | "herald";

export interface PendingOneShotNotice {
  readonly kind: OneShotNoticeKind;
  readonly key: string;
  /** What the notice needs to render again, exactly as the shell held it. */
  readonly payload: unknown;
}

/** A kind whose shell state is ONE slot: a newer raise replaces the older one there, so it replaces it here too. */
const SINGLE_SLOT_KINDS: ReadonlySet<OneShotNoticeKind> = new Set<OneShotNoticeKind>([
  "privateRevenue",
  "phaseThree",
  "herald",
]);

/* ------------------------------------------------------------------ */
/* Event keys                                                          */
/* ------------------------------------------------------------------ */

/** Phase 3 begins once per game. */
export const PHASE_THREE_NOTICE_KEY = "phase-three";

/** One payout phase per Operating Round, and the round label names the round ("OR 3.1"). */
export function privateRevenueNoticeKey(roundLabel: string | null): string {
  return `private-revenue:${roundLabel ?? "unlabelled"}`;
}

/** A corporation floats once. */
export function heraldFloatNoticeKey(companyId: number): string {
  return `herald-float:${companyId}`;
}

/** Fleet Loss keeps #1032's event key unchanged, so the raiser's own `has(key)` checks read the same keys. */
export function fleetLossNoticeKey(notice: FleetLossNotice): string {
  return noticeDismissKey(notice);
}

/* ------------------------------------------------------------------ */
/* Whose record                                                        */
/* ------------------------------------------------------------------ */

/** The slice of the server's room view this needs. */
export interface NoticeLedgerViewer {
  readonly gameId: string;
  readonly players: ReadonlyArray<{ readonly id: string }>;
  readonly you: { readonly playerId: string | null };
}

/** The storage key for this viewer's record in this game, or `null` while there is no game to key it by. */
export function noticeLedgerKey(view: NoticeLedgerViewer | null | undefined): string | null {
  if (!view || !view.gameId) return null;
  const playerId = view.you.playerId;
  const seat = playerId ? view.players.findIndex((player) => player.id === playerId) : -1;
  return `${NOTICE_ACK_STORAGE_PREFIX}${view.gameId}.${seat >= 0 ? `seat${seat}` : "watcher"}`;
}

/* ------------------------------------------------------------------ */
/* What may be stored -- LIVE-2D                                       */
/* ------------------------------------------------------------------ */

/** The payout payload with every name that is a seat's id (or the shortened form of one) replaced by that seat's
 *  nickname, or "Seat N" when it has none. The payout names players as the shell labels them, and a seat whose
 *  nickname had not resolved is labelled by its shortened id -- which the client must not persist (LIVE-2D). */
export function privateRevenuePayloadForStorage<T extends { viewerName: string; others: ReadonlyArray<{ name: string }> }>(
  payload: T,
  roster: ReadonlyArray<{ readonly id: string; readonly nickname: string }>,
  shorten: (id: string) => string,
): T {
  const safe = (name: string): string => {
    const index = roster.findIndex((player) => player.id === name || shorten(player.id) === name || name.includes(player.id));
    if (index < 0) return name;
    const nickname = roster[index].nickname.trim();
    return nickname && nickname !== name && !nickname.includes(roster[index].id) ? nickname : `Seat ${index + 1}`;
  };
  return { ...payload, viewerName: safe(payload.viewerName), others: payload.others.map((other) => ({ ...other, name: safe(other.name) })) };
}

/* ------------------------------------------------------------------ */
/* Payload checks -- a stored record is untrusted input               */
/* ------------------------------------------------------------------ */

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const isNumberOrNull = (value: unknown) => value === null || typeof value === "number";
const isStringOrNull = (value: unknown) => value === null || typeof value === "string";

export function isFleetLossNoticePayload(value: unknown): value is FleetLossNotice {
  return (
    isObject(value) &&
    typeof value.companyId === "number" &&
    typeof value.ticker === "string" &&
    (value.cause === "rust" || value.cause === "limit") &&
    Array.isArray(value.trains) &&
    value.trains.every((train) => typeof train === "string") &&
    isStringOrNull(value.arrivingTier) &&
    isNumberOrNull(value.trainLimit)
  );
}

export function isPrivateRevenuePayload(value: unknown): boolean {
  return (
    isObject(value) &&
    typeof value.viewerName === "string" &&
    isStringOrNull(value.viewerSeatColor) &&
    Array.isArray(value.lines) &&
    typeof value.total === "number" &&
    isNumberOrNull(value.cashBefore) &&
    isNumberOrNull(value.cashAfter) &&
    Array.isArray(value.others) &&
    isStringOrNull(value.roundLabel)
  );
}

export function isHeraldFloatPayload(value: unknown): boolean {
  return (
    isObject(value) &&
    typeof value.companyId === "number" &&
    typeof value.ticker === "string" &&
    typeof value.hexLabel === "string" &&
    typeof value.place === "string" &&
    typeof value.revenue === "number" &&
    typeof value.firstTokenCost === "number"
  );
}

const PAYLOAD_CHECKS: Readonly<Record<OneShotNoticeKind, (payload: unknown) => boolean>> = {
  fleetLoss: isFleetLossNoticePayload,
  privateRevenue: isPrivateRevenuePayload,
  phaseThree: () => true,
  herald: isHeraldFloatPayload,
};

/* ------------------------------------------------------------------ */
/* Storage                                                             */
/* ------------------------------------------------------------------ */

interface StoredRecord {
  acknowledged: string[];
  pending: PendingOneShotNotice[];
}

const EMPTY_RECORD: StoredRecord = { acknowledged: [], pending: [] };

function isPendingEntry(value: unknown): value is PendingOneShotNotice {
  if (!isObject(value) || typeof value.key !== "string") return false;
  const kind = value.kind;
  if (kind !== "fleetLoss" && kind !== "privateRevenue" && kind !== "phaseThree" && kind !== "herald") return false;
  return PAYLOAD_CHECKS[kind](value.payload);
}

function readRecord(key: string): StoredRecord {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return EMPTY_RECORD;
    const parsed: unknown = JSON.parse(raw);
    if (!isObject(parsed)) return EMPTY_RECORD;
    const acknowledged = Array.isArray(parsed.acknowledged)
      ? parsed.acknowledged.filter((entry): entry is string => typeof entry === "string")
      : [];
    const pending = Array.isArray(parsed.pending) ? parsed.pending.filter(isPendingEntry) : [];
    return { acknowledged, pending };
  } catch {
    return EMPTY_RECORD;
  }
}

function storedAt(key: string): number {
  try {
    const raw = window.localStorage.getItem(key);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return isObject(parsed) && typeof parsed.updatedAt === "number" ? parsed.updatedAt : 0;
  } catch {
    return 0;
  }
}

/** Keeps the newest `NOTICE_ACK_MAX_GAMES` records (by last write), the current one always among them. */
function pruneRecords(keep: string): void {
  try {
    const keys: string[] = [];
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (key && key.startsWith(NOTICE_ACK_STORAGE_PREFIX) && key !== keep) keys.push(key);
    }
    if (keys.length < NOTICE_ACK_MAX_GAMES) return;
    const oldestFirst = keys
      .map((key) => ({ key, at: storedAt(key) }))
      .sort((a, b) => a.at - b.at || a.key.localeCompare(b.key));
    for (const { key } of oldestFirst.slice(0, keys.length - (NOTICE_ACK_MAX_GAMES - 1))) {
      window.localStorage.removeItem(key);
    }
  } catch {
    /* Pruning is housekeeping; a store that refuses it keeps working. */
  }
}

/* ------------------------------------------------------------------ */
/* The ledger                                                          */
/* ------------------------------------------------------------------ */

export class NoticeLedger {
  private key: string | null = null;
  /** Whether the ledger has ever been bound to a real record (see `bind`). */
  private everBound = false;
  private acknowledged = new Set<string>();
  private pending: PendingOneShotNotice[] = [];
  /** Events this mount treated as history the viewer did not witness. IN MEMORY ONLY: a reload suppresses them
   *  again during its own load, and keeping them here is what stops a LATER full replay -- an Undo, a #668
   *  reorder -- from queueing them as new once the first load has finished. */
  private historical = new Set<string>();

  /** `historyIsUnwitnessed`: true while this mount is loading a history it did not watch happen. Read at call
   *  time, because the raiser asks it in the middle of the replay. */
  constructor(private readonly historyIsUnwitnessed: () => boolean = () => false) {}

  /** The storage key this ledger reads and writes, or `null` while it is in memory only. */
  get storageKey(): string | null {
    return this.key;
  }

  /** Points the ledger at a record. Answers whether anything changed. Idempotent, so it may run during render.
   *
   *  Acknowledgements and pending notices gathered before the viewer's record was known (`null` key) are carried
   *  into it -- a notice answered in the moment before the room view arrived stays answered. Moving between two
   *  records carries nothing: they are different games or different seats. */
  bind(key: string | null): boolean {
    if (key === this.key) return false;
    /* Only what was gathered before the FIRST real record is carried; after that, a null key is a gap between two
       tables and anything left in memory belongs to the one that ended. */
    const fromMemory = this.key === null && !this.everBound;
    if (key !== null) this.everBound = true;
    if (!fromMemory) this.historical = new Set<string>();
    const carriedAcknowledged = fromMemory ? Array.from(this.acknowledged) : [];
    const carriedPending = fromMemory ? this.pending : [];
    this.key = key;
    const stored = key ? readRecord(key) : EMPTY_RECORD;
    this.acknowledged = new Set<string>([...stored.acknowledged, ...carriedAcknowledged]);
    this.pending = [];
    for (const entry of [...stored.pending, ...carriedPending]) this.addPending(entry);
    if (key && (carriedAcknowledged.length > 0 || carriedPending.length > 0)) this.persist();
    return true;
  }

  /** Re-reads the record (another tab wrote it). Acknowledgements only ever accumulate; pending follows the store,
   *  less anything acknowledged. Answers whether anything this mount reads changed. */
  reload(): boolean {
    if (!this.key) return false;
    const stored = readRecord(this.key);
    const before = this.signature();
    for (const key of stored.acknowledged) this.acknowledged.add(key);
    this.pending = [];
    for (const entry of stored.pending) this.addPending(entry);
    return this.signature() !== before;
  }

  isAcknowledged(key: string): boolean {
    return this.acknowledged.has(key);
  }

  isPending(key: string): boolean {
    return this.pending.some((entry) => entry.key === key);
  }

  /** The fleet-loss raiser's question: should this event NOT be queued? Answered, or historical to this viewer. */
  has(key: string): boolean {
    if (this.acknowledged.has(key)) return true;
    if (this.historical.has(key)) return true;
    if (this.isPending(key)) return false;
    if (!this.historyIsUnwitnessed()) return false;
    this.historical.add(key);
    return true;
  }

  /** The player answered this event. */
  acknowledge(key: string): void {
    if (this.acknowledged.has(key)) return;
    this.acknowledged.add(key);
    this.pending = this.pending.filter((entry) => entry.key !== key);
    this.persist();
  }

  /** A notice this player witnessed is now waiting for them. Answers whether the record changed. */
  remember(entry: PendingOneShotNotice): boolean {
    if (this.acknowledged.has(entry.key)) return false;
    if (this.pending.some((candidate) => candidate.key === entry.key)) return false;
    if (!PAYLOAD_CHECKS[entry.kind](entry.payload)) return false;
    this.addPending(entry);
    this.persist();
    return true;
  }

  /** This player's own unanswered notices of one kind, oldest first. */
  pendingOf(kind: OneShotNoticeKind): readonly PendingOneShotNotice[] {
    return this.pending.filter((entry) => entry.kind === kind);
  }

  private addPending(entry: PendingOneShotNotice): void {
    if (this.acknowledged.has(entry.key)) return;
    if (this.pending.some((candidate) => candidate.key === entry.key)) return;
    if (SINGLE_SLOT_KINDS.has(entry.kind)) {
      this.pending = this.pending.filter((candidate) => candidate.kind !== entry.kind);
    }
    this.pending = [...this.pending, entry];
  }

  private signature(): string {
    return JSON.stringify([Array.from(this.acknowledged).sort(), this.pending.map((entry) => entry.key)]);
  }

  private persist(): void {
    const key = this.key;
    if (!key) return;
    /* READ, MERGE, WRITE: another of this player's tabs may have acknowledged something this one has not heard about
       yet, and a blind write of this tab's memory would drop it. Acknowledgements only accumulate. */
    const stored = readRecord(key);
    for (const acknowledgedKey of stored.acknowledged) this.acknowledged.add(acknowledgedKey);
    this.pending = this.pending.filter((entry) => !this.acknowledged.has(entry.key));
    const record = {
      v: 1,
      updatedAt: Date.now(),
      acknowledged: Array.from(this.acknowledged),
      pending: this.pending,
    };
    try {
      window.localStorage.setItem(key, JSON.stringify(record));
    } catch {
      /* A browser that refuses storage keeps this mount's memory -- see the header. */
      return;
    }
    pruneRecords(key);
  }
}
