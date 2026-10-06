// server/src/conduct/conductLogReader.ts
//
// PHASE 3 (P3-N032): the stored log of a game, READ for re-verifying a conduct case's log pointer -- the bytes and the
// scan only, as `gamesDoctor` reads them: no open for writing, no repair of a torn tail, no claim or load of the game.
// A torn tail's complete batches are its committed history; a damaged or newer-format log answers null ("cannot be read
// here"), as does a game with no log file.

import { promises as fs } from "fs";
import * as path from "path";

import type { ServerLogEntry } from "../../../frontend/src/utils/roomSession";
import { scanLog } from "../persistence/logFormat";
import { GAME_ID_PATTERN } from "../rooms/gameRecord";

export async function readStoredLogForReview(dataDir: string, gameId: string): Promise<readonly ServerLogEntry[] | null> {
  if (!GAME_ID_PATTERN.test(gameId)) return null;
  let bytes: Buffer;
  try {
    bytes = await fs.readFile(path.join(dataDir, `${gameId}.log.jsonl`));
  } catch {
    return null;
  }
  const scan = scanLog(bytes);
  return scan.classification === "clean" || scan.classification === "torn-tail" ? scan.entries : null;
}
