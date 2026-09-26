// server/src/persistence/logFormat.ts
//
// LIVE-3B: the on-disk shape of a room's log, and the one reader that decides what of it is history.
//
// ==================================================================
//  LIVE-3 §8.1: ONE LINE PER ENTRY, AS TODAY -- STAMPED WITH ITS BATCH
// ==================================================================
//
// A submission and its consequences (repair, the move, its derived burst) are ONE commit (L3-4). On disk they
// stay one JSON line per entry -- eleven corpus tests, the smoke run and every operator's `cat` read the log that
// way -- and each line of a batch carries the same store stamp:
//
//   {"index":7,...,"batch":[7,9]}
//   {"index":8,...,"derived":true,"batch":[7,9]}
//   {"index":9,...,"derived":true,"batch":[7,9]}
//
// THE STAMP IS STORE METADATA ONLY. It is added on write and stripped on read, here, before an entry reaches
// `RoomSession`, replay, the wire, `logHash` or a digest. A legacy line (no stamp) is a batch of one. Gameplay
// bytes and meaning are unchanged: the stamp is the only addition, and the fields of the entry are serialized in
// exactly the order and form they always were.
//
// ==================================================================
//  LIVE-3 §8.3: THE LOADER -- ONLY COMPLETE BATCHES ARE HISTORY, AND ONLY THE LAST ONE MAY BE TORN
// ==================================================================
//
// The actor has at most one batch in flight per game and awaits its `fsync` (E-1, E-6), and the writer is
// positional (never `O_APPEND`), so at a crash only the LAST batch can be damaged, and only within its own byte
// range -- whatever pages the disk kept. The scan therefore:
//   - accepts lines while indices run 0,1,2,... contiguously, each batch beginning at its first index and every
//     line of a batch carrying the same range; a batch is history only once its last line is read;
//   - stops at the first line that does not fit;
//   - looks at everything after the last complete batch: if it can ALL be the one in-flight batch (lines stamped
//     with a range starting at the next index, garbage, NULs, a torn final line), the damage is a torn tail and
//     may be truncated; if ANY of it is history that cannot be the in-flight batch -- a whole line of a later or
//     earlier batch, an unstamped line, or an entry glued behind a torn fragment (today's F-8 "poisoned" shape) --
//     the file is CORRUPT and is held untouched until an operator repairs it (`tools/logDoctor.ts`).
// Nothing here writes; the store decides what to do with the verdict.

import type { ServerLogEntry } from "../../../frontend/src/utils/roomSession";

/** A batch is at most 65 entries by construction (LIVE-3 §6.2); the reader accepts up to 100 per range. */
export const MAX_BATCH_SPAN = 99;

export type BatchRange = readonly [number, number];

export type LogClassification = "clean" | "torn-tail" | "corrupt";

export interface LogScan {
  /** Every entry of every COMPLETE batch, in order, with the store stamp stripped. */
  readonly entries: ServerLogEntry[];
  /** The byte offset just past the last complete batch: the durable prefix, `committedEnd` after a load. */
  readonly end: number;
  readonly size: number;
  readonly classification: LogClassification;
  /** For torn-tail and corrupt: the first byte that is not part of the valid prefix (== `end`). */
  readonly damageAt: number | null;
  /** For corrupt: the byte offset of the line that proves the damage is not confined to the in-flight batch. */
  readonly evidenceAt: number | null;
  readonly detail: string;
  readonly stampedLines: number;
  readonly legacyLines: number;
}

export interface ParsedLine {
  readonly entry: ServerLogEntry;
  readonly range: BatchRange;
  readonly stamped: boolean;
}

const isIndex = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

/** The entry without its store stamp. Every other field is kept exactly, in its original order. */
export function stripStoreMetadata(raw: Record<string, unknown>): ServerLogEntry {
  if (!("batch" in raw)) return raw as unknown as ServerLogEntry;
  const { batch: _batch, ...entry } = raw;
  return entry as unknown as ServerLogEntry;
}

/** One line as an entry, or `null` if it is not structurally one. The range is validated here: a stamp that is
 *  not `[first, last]` with `0 <= first <= index <= last` and a span of at most 100 is not a line of any batch. */
export function parseEntryLine(text: string): ParsedLine | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (!isIndex(record.index) || typeof record.id !== "string" || record.id === "") return null;
  const index = record.index;
  if (!("batch" in record)) return { entry: record as unknown as ServerLogEntry, range: [index, index], stamped: false };
  const batch = record.batch;
  if (!Array.isArray(batch) || batch.length !== 2 || !isIndex(batch[0]) || !isIndex(batch[1])) return null;
  const [first, last] = batch as [number, number];
  if (first > index || index > last || last - first > MAX_BATCH_SPAN) return null;
  return { entry: stripStoreMetadata(record), range: [first, last], stamped: true };
}

const sameRange = (a: BatchRange, b: BatchRange): boolean => a[0] === b[0] && a[1] === b[1];

/** The serialized lines of one batch. Every entry keeps its own bytes and gains `"batch":[first,last]` last. */
export function serializeBatch(entries: readonly ServerLogEntry[]): string {
  if (entries.length === 0) return "";
  const first = entries[0].index;
  const last = first + entries.length - 1;
  entries.forEach((entry, at) => {
    if (entry.index !== first + at) {
      throw new Error(`a batch must be contiguous: entry ${at} has index ${entry.index}, expected ${first + at}`);
    }
  });
  if (last - first > MAX_BATCH_SPAN) throw new Error(`a batch of ${entries.length} entries is larger than a batch may be`);
  return entries.map((entry) => `${JSON.stringify({ ...stripStoreMetadata(entry as never), batch: [first, last] })}\n`).join("");
}

/** A malformed line whose SUFFIX parses as a whole entry: the F-8 shape, where an entry was appended behind the torn
 *  fragment an earlier crash left. The leftmost `{` after the line's start that begins a parseable entry. */
export function recoverSuffix(text: string): { readonly offset: number; readonly parsed: ParsedLine } | null {
  for (let at = text.indexOf("{", 1); at !== -1; at = text.indexOf("{", at + 1)) {
    const parsed = parseEntryLine(text.slice(at));
    if (parsed !== null) return { offset: at, parsed };
  }
  return null;
}

/** LIVE-3 §8.3, exactly: which bytes are history, which are a torn in-flight batch, and whether anything else is. */
export function scanLog(bytes: Uint8Array): LogScan {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const size = buffer.length;
  const entries: ServerLogEntry[] = [];
  let pending: ServerLogEntry[] = [];
  let current: BatchRange | null = null;
  let expected = 0;
  let end = 0;
  let pos = 0;
  let stampedLines = 0;
  let legacyLines = 0;
  let stopReason = "";

  while (pos < size) {
    const newline = buffer.indexOf(0x0a, pos);
    if (newline === -1) {
      stopReason = `an unterminated final line at byte ${pos}`;
      break;
    }
    const parsed = parseEntryLine(buffer.toString("utf8", pos, newline));
    if (parsed === null) {
      stopReason = `the line at byte ${pos} is not an entry`;
      break;
    }
    const { entry, range } = parsed;
    const fits =
      entry.index === expected &&
      (current === null ? range[0] === entry.index : sameRange(range, current));
    if (!fits) {
      stopReason = `the line at byte ${pos} (index ${entry.index}, batch [${range[0]},${range[1]}]) does not continue index ${expected - 1}`;
      break;
    }
    if (parsed.stamped) stampedLines += 1;
    else legacyLines += 1;
    pending.push(entry);
    expected += 1;
    current = range;
    if (entry.index === range[1]) {
      // THE BATCH IS COMPLETE: this is the commit point on disk.
      for (const done of pending) entries.push(done);
      pending = [];
      current = null;
      end = newline + 1;
    }
    pos = newline + 1;
  }

  if (end === size) {
    return {
      entries,
      end,
      size,
      classification: "clean",
      damageAt: null,
      evidenceAt: null,
      detail: `${entries.length} entries, no damage`,
      stampedLines,
      legacyLines,
    };
  }

  /* EVERYTHING AFTER THE LAST COMPLETE BATCH MUST BE ABLE TO BE THE ONE BATCH IN FLIGHT. */
  const inflightFirst = entries.length;
  let inflight: BatchRange | null = null;
  const corrupt = (at: number, why: string): LogScan => ({
    entries,
    end,
    size,
    classification: "corrupt",
    damageAt: end,
    evidenceAt: at,
    detail: `${why}; the valid prefix ends at byte ${end} (index ${inflightFirst - 1})`,
    stampedLines,
    legacyLines,
  });
  const belongsInFlight = (line: ParsedLine): boolean => {
    if (!line.stamped || line.range[0] !== inflightFirst) return false;
    if (inflight !== null && !sameRange(inflight, line.range)) return false;
    inflight = line.range;
    return true;
  };
  for (let at = end; at < size; ) {
    const newline = buffer.indexOf(0x0a, at);
    if (newline === -1) break; // an unterminated fragment: the torn end of the in-flight write
    const text = buffer.toString("utf8", at, newline);
    const parsed = parseEntryLine(text);
    if (parsed !== null) {
      if (!belongsInFlight(parsed)) {
        return corrupt(
          at,
          `a whole entry (index ${parsed.entry.index}, ${parsed.stamped ? `batch [${parsed.range[0]},${parsed.range[1]}]` : "unstamped"}) ` +
            `lies after the damage and cannot belong to the batch in flight at index ${inflightFirst} -- ${stopReason}`,
        );
      }
    } else {
      const glued = recoverSuffix(text);
      if (glued !== null && !belongsInFlight(glued.parsed)) {
        return corrupt(
          at + Buffer.byteLength(text.slice(0, glued.offset), "utf8"),
          `an entry (index ${glued.parsed.entry.index}) was written behind a torn fragment at byte ${at} -- ` +
            `acknowledged history appended after a crash (the F-8 shape)`,
        );
      }
    }
    at = newline + 1;
  }
  return {
    entries,
    end,
    size,
    classification: "torn-tail",
    damageAt: end,
    evidenceAt: null,
    detail: `${size - end} bytes of an incomplete final batch after index ${inflightFirst - 1} (${stopReason || "the batch never completed"})`,
    stampedLines,
    legacyLines,
  };
}
