// frontend/src/utils/logHash.ts
//
// The settlement commitment: one hash over everything the reducer or the clock reads from a room's log.
//
// ==================================================================
//  DESIGN NOTE 1251: THE HASH COVERS EVERY FIELD A RULE READS
// ==================================================================
//
// THE PLAN SAID "ordered concatenation of `payload` strings" and the audit (§6) said what that leaves out:
// "`actor`, `at`, `derived`, and `index`. The clock reads `at`; the forfeit reads `actor`; the reducer reads
// `derived`. An operator could alter timestamps without changing the hash." So the line hashed for each entry
// is `(index, actor, at, derived)` as one canonical JSON array, a tab, the payload verbatim, a newline.
//
// THE PAYLOAD IS VERBATIM, and #1188 is why that is safe without a canonicalisation scheme: it is JSON text
// minted once by the dispatching client and never re-serialised anywhere in the system. The prefix is a JSON
// array of primitives, which `JSON.stringify` writes one way. Neither half can contain a raw newline (JSON
// escapes them), so the line boundary is unambiguous and the tab between the halves cannot occur in the
// prefix.
//
// `at` ABSENT HASHES AS `null`, `derived` ABSENT AS `false` -- #232's rule, made explicit at the one place
// where "absent" and "false" have to be the same bit on every machine. `submission_id` and `id` are NOT
// hashed: the first is a transport nonce, the second the store's own name for the entry, and neither is read
// by any rule. Hashing them would let two logs that play identically commit to different values.
//
// SORTED BY INDEX, AND A DUPLICATE INDEX IS A REFUSAL, NOT A TIE-BREAK. The Firestore path's `(index, id)`
// order existed because racing browsers could allocate the same index (#1026); the server allocates every
// index, so a duplicate on the server path is corruption. A hash that silently ordered two entries claiming
// one position would commit to a history nobody can replay unambiguously -- the `throw` is the commitment
// refusing to be made.
//
// A PREFIX IS HASHABLE ON ITS OWN, which is what a checkpoint is (audit §2: `{appraisal, log_hash, log_len}`
// at every boundary): the hash of the first `length` entries depends on nothing after them, so any client
// holding that prefix recomputes it. The whole log, reverts and reverted entries included -- the log is the
// evidence, and the effective view is derived from it by everybody the same way.

import { Sha256, utf8Bytes } from "./sha256";

/** The fields the hash reads. Every log entry shape in this project satisfies it. */
export interface HashableLogEntry {
  index: number;
  actor: string;
  payload: string;
  at?: number | null;
  derived?: boolean;
}

/** One entry's line, exactly as it is fed to the digest. Exported so a test can pin the format itself. */
export function logEntryLine(entry: HashableLogEntry): string {
  const prefix = JSON.stringify([
    entry.index,
    entry.actor,
    entry.at === undefined || entry.at === null ? null : entry.at,
    entry.derived === true,
  ]);
  return `${prefix}\t${entry.payload}\n`;
}

/** The text the hash is taken over: the first `length` entries (all of them by default), by index. */
export function logHashInput(entries: readonly HashableLogEntry[], length = entries.length): string {
  const ordered = [...entries].sort((left, right) => left.index - right.index).slice(0, Math.max(0, length));
  let text = "";
  for (let at = 0; at < ordered.length; at += 1) {
    if (at > 0 && ordered[at].index === ordered[at - 1].index) {
      throw new Error(`log hash refused: two entries claim index ${ordered[at].index}`);
    }
    text += logEntryLine(ordered[at]);
  }
  return text;
}

/** The first `length` entries in index order: `entries` itself when it is already strictly increasing (a server log
 *  always is -- no copy), else a sorted copy. A duplicate index is refused (see the header). */
function orderedPrefix<T extends HashableLogEntry>(entries: readonly T[], length: number): readonly T[] {
  const n = Math.max(0, Math.min(length, entries.length));
  let sorted = true;
  for (let at = 1; at < entries.length && sorted; at += 1) if (entries[at].index <= entries[at - 1].index) sorted = false;
  const ordered = sorted ? entries : [...entries].sort((left, right) => left.index - right.index);
  for (let at = 1; at < n; at += 1) {
    if (ordered[at].index === ordered[at - 1].index) throw new Error(`log hash refused: two entries claim index ${ordered[at].index}`);
  }
  return n === ordered.length ? ordered : ordered.slice(0, n);
}

/** SHA-256 over `logHashInput`, as 64 lowercase hex characters. The empty log has a hash too. STREAMED (Phase 3 final
 *  clocks, owner ruling 2026-10-07: a history has no length limit): each entry's line is fed to the digest as it is
 *  read -- the same bytes, the same digest, without ever building the whole text. */
export function logHash(entries: readonly HashableLogEntry[], length = entries.length): string {
  const hasher = new Sha256();
  for (const entry of orderedPrefix(entries, length)) hasher.update(utf8Bytes(logEntryLine(entry)));
  return hasher.digestHex();
}

/* ==================================================================
    PHASE 3 FINAL CLOCKS: THE CUMULATIVE LOG HASH, CHECKPOINTED BY SEGMENT
   ==================================================================
   THE SAME COMMITMENT, NEVER RE-READ. `logHash(entries, n)` is SHA-256 over the lines of the first `n` entries, so the
   digest state after `k` lines is a checkpoint from which any longer prefix is finished by feeding only the rest. A
   `LogHashCursor` keeps such checkpoints at every `LOG_HASH_SEGMENT` entries (the completed segments, never touched
   again) and at the last prefix it hashed (the hot tip), each bound to the IDENTITY of the entry it ends at (index and
   id). A prefix whose anchor no longer matches -- a log rolled back and appended again -- drops that checkpoint and
   everything after it; a prefix that is not strictly increasing is hashed from scratch by `logHash`, which keeps its
   ordering and duplicate rules. The answer is always exactly `logHash(entries, length)`: only the work changes, from
   the whole history to the entries since the nearest checkpoint. */
export const LOG_HASH_SEGMENT = 4096;

interface HashCheckpoint {
  /** Entries hashed. */
  readonly length: number;
  /** The identity of entry `length - 1`. */
  readonly index: number;
  readonly id: string | undefined;
  readonly state: Sha256;
}

type IdentifiedEntry = HashableLogEntry & { readonly id?: string };

export class LogHashCursor {
  private checkpoints: HashCheckpoint[] = [];

  /** `logHash(entries, length)`, finished from the nearest checkpoint that `entries` still begins with. */
  hash(entries: readonly IdentifiedEntry[], length = entries.length): string {
    const n = Math.max(0, Math.min(length, entries.length));
    let start: HashCheckpoint | null = null;
    for (let k = 0; k < this.checkpoints.length; k += 1) {
      const mark = this.checkpoints[k];
      /* Beyond what this call was given (a shorter prefix of the same history): neither confirmed nor refuted. */
      if (mark.length > entries.length) continue;
      const at = entries[mark.length - 1];
      if (at.index !== mark.index || at.id !== mark.id) {
        /* Not this history any more (rolled back and appended again): this checkpoint and every later one are gone. */
        this.checkpoints = this.checkpoints.slice(0, k);
        break;
      }
      if (mark.length <= n) start = mark;
    }
    const state = start === null ? new Sha256() : start.state.clone();
    let previous = start === null ? null : start.index;
    for (let at = start === null ? 0 : start.length; at < n; at += 1) {
      const entry = entries[at];
      /* Not strictly increasing: not a server history -- `logHash` sorts and refuses duplicates; nothing is kept. */
      if (previous !== null && entry.index <= previous) {
        this.checkpoints = [];
        return logHash(entries, length);
      }
      previous = entry.index;
      state.update(utf8Bytes(logEntryLine(entry)));
      if ((at + 1) % LOG_HASH_SEGMENT === 0 && !this.checkpoints.some((mark) => mark.length === at + 1)) {
        this.remember({ length: at + 1, index: entry.index, id: entry.id, state: state.clone() });
      }
    }
    if (n > 0 && n % LOG_HASH_SEGMENT !== 0) {
      const last = entries[n - 1];
      /* The hot tip: only the latest one is kept beside the segment checkpoints. */
      this.checkpoints = this.checkpoints.filter((mark) => mark.length % LOG_HASH_SEGMENT === 0);
      this.remember({ length: n, index: last.index, id: last.id, state: state.clone() });
    }
    return state.digestHex();
  }

  private remember(mark: HashCheckpoint): void {
    this.checkpoints.push(mark);
    this.checkpoints.sort((a, b) => a.length - b.length);
  }
}

/** One cursor per history, keyed by its FIRST entry object (a server game's entries are frozen objects shared by every
 *  committed view of it, so every view of one game finds the same cursor, and the cursor goes with the game). */
const cursors = new WeakMap<object, LogHashCursor>();

/** `logHash(entries, length)`, computed from the history's cumulative checkpoints when it has been hashed before. */
export function cumulativeLogHash(entries: readonly IdentifiedEntry[], length = entries.length): string {
  const first = entries[0];
  if (first === undefined || typeof first !== "object") return logHash(entries, length);
  let cursor = cursors.get(first);
  if (cursor === undefined) {
    cursor = new LogHashCursor();
    cursors.set(first, cursor);
  }
  return cursor.hash(entries, length);
}
