// server/src/rooms/clock/clockStore.ts
//
// ==================================================================
//  PHASE 3 FINAL CLOCKS: THE TABLE-CLOCK STORE PORT -- MEMORY, FILE (`games/clocks/<g>.json`); DYNAMODB ELSEWHERE
// ==================================================================
//
// Ported from the lane-A reference's store (`8559393`, which the owner kept as reusable infrastructure), unchanged in
// its contract: `save` is CONDITIONAL on the stored revision (`expected`: the revision the writer read; `null`: none may
// exist), answers `committed` / `definite` (nothing written) / `uncertain` (unknown -- reread before the next decision),
// and NEVER overwrites a stored clock it cannot read. Every file write first checks the data-directory lock (LIVE-3B); the
// DynamoDB adapter (`aws/game/dynamoClockStore.ts`) fences every write by the game's HEAD (L5-3), so a stale actor --
// after a takeover -- can neither write a clock nor, therefore, sign a remedy from one.

import { promises as nodeFs } from "fs";
import * as path from "path";

import { nodeStoreFs, type StoreFs } from "../../fileLogStore";
import { durableReplace } from "../../persistence/durableReplace";
import { COMMITTED, type StoreWriteOutcome } from "../../persistence/storeResult";
import { GAME_ID_PATTERN } from "../gameRecord";
import { ClockUnreadableError, isGameClockRecord, parseClockDocument, type GameClockRecord } from "./clockRecord";

export interface ClockStore {
  /** The stored clock, or `null`. Rejects `ClockUnreadableError` for one that cannot be read. */
  load(gameId: string): Promise<GameClockRecord | null>;
  save(record: GameClockRecord, expected: number | null): Promise<StoreWriteOutcome>;
}

/* ---- in memory (tests, and a server built without a durable store) ---- */

export interface MemoryClockStore extends ClockStore {
  readonly clocks: Map<string, GameClockRecord | "unreadable">;
  readonly saves: GameClockRecord[];
  /** Faults for the next saves, in order. */
  readonly failSaves: Array<"definite" | "uncertain-landed" | "uncertain-lost">;
  readonly failLoads: Array<"error">;
}

export function createMemoryClockStore(): MemoryClockStore {
  const clocks = new Map<string, GameClockRecord | "unreadable">();
  const saves: GameClockRecord[] = [];
  const failSaves: Array<"definite" | "uncertain-landed" | "uncertain-lost"> = [];
  const failLoads: Array<"error"> = [];
  return {
    clocks,
    saves,
    failSaves,
    failLoads,
    async load(gameId) {
      if (failLoads.shift() === "error") throw new Error("injected clock-store read failure");
      const stored = clocks.get(gameId);
      if (stored === "unreadable") throw new ClockUnreadableError(`the clock of ${gameId} is unreadable`, gameId);
      return stored ?? null;
    },
    async save(record, expected) {
      if (!isGameClockRecord(record)) return { kind: "definite", detail: "not a clock record" };
      const stored = clocks.get(record.game_id);
      if (stored === "unreadable") return { kind: "definite", detail: "the stored clock is unreadable; it is never overwritten" };
      const revision = stored === undefined ? null : stored.revision;
      if (revision !== expected) return { kind: "definite", detail: `the clock moved (stored revision ${revision ?? "none"}, expected ${expected ?? "none"})` };
      const fault = failSaves.shift();
      if (fault === "definite") return { kind: "definite", detail: "injected clock-store failure" };
      if (fault === "uncertain-lost") return { kind: "uncertain", detail: "injected clock-store failure (outcome unknown; not written)" };
      clocks.set(record.game_id, record);
      saves.push(record);
      if (fault === "uncertain-landed") return { kind: "uncertain", detail: "injected clock-store failure (outcome unknown; written)" };
      return COMMITTED;
    },
  };
}

/* ---- the file adapter: `games/clocks/<game_id>.json`, replaced whole and durably ---- */

export interface FileClockStoreOptions {
  fs?: StoreFs;
  platform?: string;
  /** LIVE-3B: every write first checks this process still owns the data directory. */
  writerCheck?: () => Promise<boolean>;
  warn?: (line: string) => void;
}

export function clockDirectory(dataDir: string): string {
  return path.join(dataDir, "games", "clocks");
}

const codeOf = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | undefined)?.code;
const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function createFileClockStore(dataDir: string, options: FileClockStoreOptions = {}): ClockStore & { readonly directory: string } {
  const io = options.fs ?? nodeStoreFs;
  const directory = clockDirectory(dataDir);
  // eslint-disable-next-line no-console
  const warn = options.warn ?? ((line: string) => console.warn(line));
  const fileOf = (gameId: string) => path.join(directory, `${gameId}.json`);
  const chains = new Map<string, Promise<unknown>>();
  const serial = <T>(key: string, task: () => Promise<T>): Promise<T> => {
    const run = (chains.get(key) ?? Promise.resolve()).then(task, task);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    chains.set(key, tail);
    void tail.then(() => {
      if (chains.get(key) === tail) chains.delete(key);
    });
    return run;
  };

  async function read(gameId: string): Promise<GameClockRecord | null> {
    let raw: Buffer;
    try {
      raw = await io.readFile(fileOf(gameId));
    } catch (error) {
      if (codeOf(error) === "ENOENT") return null;
      throw error;
    }
    return parseClockDocument(raw.toString("utf8"), gameId);
  }

  const fenced = async (): Promise<boolean> => options.writerCheck !== undefined && !(await options.writerCheck().catch(() => false));

  return {
    directory,
    load(gameId) {
      if (!GAME_ID_PATTERN.test(gameId)) return Promise.resolve(null);
      return serial(gameId, () => read(gameId));
    },
    save(record, expected) {
      return serial(record.game_id, async (): Promise<StoreWriteOutcome> => {
        if (!isGameClockRecord(record)) return { kind: "definite", detail: "not a clock record" };
        let stored: GameClockRecord | null;
        try {
          stored = await read(record.game_id);
        } catch (error) {
          return { kind: "definite", detail: `the stored clock of ${record.game_id} could not be read (${describe(error)}); nothing was written` };
        }
        const revision = stored === null ? null : stored.revision;
        if (revision !== expected) return { kind: "definite", detail: `the clock moved (stored revision ${revision ?? "none"}, expected ${expected ?? "none"})` };
        if (await fenced()) return { kind: "definite", detail: "this server no longer owns the data directory (its lock was taken over); nothing was written" };
        try {
          await io.mkdir(directory);
        } catch (error) {
          return { kind: "definite", detail: `could not make ${directory}: ${describe(error)}` };
        }
        return durableReplace(io, fileOf(record.game_id), Buffer.from(`${JSON.stringify(record)}\n`, "utf8"), { platform: options.platform, warn });
      });
    },
  };
}

/** Read-only, for the operator tool and the startup sweep: every stored clock file's game id. */
export async function listClockFiles(dataDir: string): Promise<string[]> {
  try {
    const names = await nodeFs.readdir(clockDirectory(dataDir));
    return names.filter((name) => name.endsWith(".json") && GAME_ID_PATTERN.test(name.slice(0, -5))).map((name) => name.slice(0, -5)).sort();
  } catch (error) {
    if (codeOf(error) === "ENOENT") return [];
    throw error;
  }
}
