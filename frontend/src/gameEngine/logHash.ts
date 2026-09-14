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

import { sha256Hex } from "./sha256";

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

/** SHA-256 over `logHashInput`, as 64 lowercase hex characters. The empty log has a hash too. */
export function logHash(entries: readonly HashableLogEntry[], length = entries.length): string {
  return sha256Hex(logHashInput(entries, length));
}
