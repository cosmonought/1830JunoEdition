// server/src/escrow/dealIdentity.ts
//
// ==================================================================
//  LIVE-4 (L4-4): A MONEY GAME'S DEAL IDENTITY, READ FROM ITS DURABLE LOG -- READ-ONLY
// ==================================================================
//
// The continuation verdict needs the deal's identity (`gameIdentityOfEntries`: legacy, malformed, or dealt under which
// rules engine and hosted protocol). The money seams ask for it far more often than a room loads its log -- every job,
// every relayer classification, every money route, for games this pool may not continue at all -- so it is NOT read
// through the log store's load, which repairs a torn tail (a write), syncs the file and records the room's store
// state. It is read here, from the file's bytes, and nothing is ever written, synced or remembered:
//
//   - a torn tail (a batch in flight, or a crash's leftover) is not repaired: only the valid prefix is read, and the
//     deal is its first batch;
//   - a log damaged before its first complete batch is `malformed` (derived: nothing is written for the game while
//     it is so -- the room host holds it and the operator repairs it);
//   - no log at all is `undealt`;
//   - a read that FAILS (EMFILE, EIO, EACCES...) throws: the verdict cannot be computed now, and every caller treats
//     that as "undecided" -- nothing written, asked again later -- never as a verdict.
//
// LIVE-5 moves the log to other storage; this reader moves with it.

import * as path from "path";

import { gameIdentityOfEntries, type GameIdentityFacts } from "../../../frontend/src/gameEngine/compat/continuationIdentity";
import type { FormatFact } from "../../../frontend/src/gameEngine/compat/continuationVerdict";
import { logFormatOf } from "../../../frontend/src/gameEngine/compat/sessionContinuation";
import { readFileChunked } from "../fileLogStore";
import { scanLog } from "../persistence/logFormat";
import { GAME_ID_PATTERN } from "../rooms/gameRecord";

/** The deal's identity in a log file's bytes (its valid prefix only; never throws on content). */
export function dealIdentityOfLog(bytes: Uint8Array): GameIdentityFacts {
  const scan = scanLog(bytes);
  /* LIVE-4 (integration, N-3): a log with complete lines this build cannot read is a newer build's: its deal is not
     judged from the prefix this build happens to read (the money side does not act on a game its gameplay side cannot
     load -- derived, nothing written). */
  if (scan.classification === "newer-format") {
    return { kind: "malformed", detail: `the game's log is a newer build's format and is not read here (${scan.detail.slice(0, 200)})` };
  }
  if (scan.entries.length === 0 && scan.classification === "corrupt") {
    return { kind: "malformed", detail: `the game's log is damaged before its first complete batch (${scan.detail.slice(0, 200)})` };
  }
  try {
    return gameIdentityOfEntries(scan.entries);
  } catch (error) {
    return { kind: "malformed", detail: `the game's deal could not be read (${error instanceof Error ? error.message.slice(0, 200) : String(error)})` };
  }
}

/**
 * LIVE-4 (integration): the log's FORMAT class, read-only, exactly as its reader classifies it -- so a money seam judges
 * a game on the same log facts the game's session does. `newer` for a log with complete lines this build cannot read
 * (N-3: the store's `newer-format` class) or, on a pinned deal, a message kind or rules revision this build cannot have
 * written (T-25, `logFormatOf`, the session's own reader); `current` otherwise (damage is the store's concern: the
 * money side never repairs anything, and a corrupt prefix's deal reads as `malformed` above).
 */
export function logFormatOfLog(bytes: Uint8Array): FormatFact {
  const scan = scanLog(bytes);
  if (scan.classification === "newer-format") return "newer";
  try {
    return logFormatOf(scan.entries, gameIdentityOfEntries(scan.entries));
  } catch {
    return "current"; // a deal no server could have written: the identity says `malformed`, which decides first
  }
}

/** `logFormatOfLog` of `gameId`'s log in the data directory, read-only. A missing log is `current` (nothing to read);
 *  throws only when the file cannot be read at all (nothing is decided then). */
export async function logFormatOnDisk(dataDir: string, gameId: string): Promise<FormatFact> {
  if (!GAME_ID_PATTERN.test(gameId)) throw new Error(`${gameId} is not a game id`);
  let bytes: Buffer;
  try {
    bytes = await readFileChunked(path.join(dataDir, `${gameId}.log.jsonl`)); // chunked: no single-read ceiling
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "current";
    throw error;
  }
  return logFormatOfLog(bytes);
}

/** The deal's identity of `gameId`'s log in the data directory `dataDir`, read-only. Throws only when the file cannot
 *  be read at all (a transient fault: the caller decides nothing now). */
export async function dealIdentityOnDisk(dataDir: string, gameId: string): Promise<GameIdentityFacts> {
  if (!GAME_ID_PATTERN.test(gameId)) throw new Error(`${gameId} is not a game id`);
  let bytes: Buffer;
  try {
    bytes = await readFileChunked(path.join(dataDir, `${gameId}.log.jsonl`)); // chunked: no single-read ceiling
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "undealt" };
    throw error;
  }
  return dealIdentityOfLog(bytes);
}
