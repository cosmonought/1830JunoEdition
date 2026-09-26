// server/src/rooms/recordStore.ts
//
// ==================================================================
//  LIVE-2C (LIVE-2 §14.1, §14.5): WHERE GAME RECORDS AND THE JOIN-CODE INDEX LIVE
// ==================================================================
//
// THE CONTRACT (the interface every implementation keeps; LIVE-3 will add a DynamoDB one behind it):
//   put(record, expected)   CONDITIONAL on `record_version`: `expected` is the version the store must hold now
//                           (`null`: the record must not exist yet), and the new record is `expected + 1` (1 on
//                           create). A mismatch is a DEFINITE failure -- nothing written. Writes for one game come
//                           only from that game's actor (LIVE-3A), so a mismatch means a bug, and it refuses loudly.
//   claimCode(code, game)   CONDITIONAL insert into the join-code index: "taken" when another game holds it.
//   releaseCode(code, game) removes the entry only if it still names `game`.
//
// ORDERED WRITES, SAFE PARTIAL FAILURES (§14.5): create claims the code FIRST, then puts the record; a record put
// that fails leaves an orphan index entry, which resolves to a missing game and is answered `invalid-or-expired`.
// Every lookup through the index is CHECKED against the record (`record.join_code === code`), so an orphan, a
// rotated or a released code is never authoritative. Rotation claims the new code first and releases the old one
// only after the record holds the new one.
//
// THE FILE ADAPTER (interim, closed playtests): one `games/<game_id>.json` per record and `games/join-codes.json`,
// each replaced whole by `persistence/durableReplace.ts` under the data directory's lock. Failures surface as
// classified outcomes; an unresolved one holds that file and asks for a restart. A record that is not exactly the
// frozen shape refuses to load.

import * as path from "path";

import { nodeStoreFs, type StoreFs } from "../fileLogStore";
import { durableReplace } from "../persistence/durableReplace";
import { COMMITTED, StoreCorruptError, StoreDefiniteError, type StoreWriteOutcome } from "../persistence/storeResult";
import { GAME_ID_PATTERN, isGameRecord, JOIN_CODE_PATTERN, type GameRecord } from "./gameRecord";

export interface RecordStore {
  /** Every stored game id (the startup index). */
  list(): Promise<string[]>;
  load(gameId: string): Promise<GameRecord | null>;
  put(record: GameRecord, expected: number | null): Promise<StoreWriteOutcome>;
  lookupCode(code: string): Promise<string | null>;
  claimCode(code: string, gameId: string): Promise<"claimed" | "taken">;
  releaseCode(code: string, gameId: string): Promise<void>;
}

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function versionCheck(record: GameRecord, expected: number | null, current: number | null): string | null {
  if (!isGameRecord(record)) return "not a game record";
  if (expected === null) {
    if (current !== null) return `game ${record.game_id} already exists`;
    if (record.record_version !== 1) return "a new record starts at version 1";
    return null;
  }
  if (current !== expected) return `version conflict on ${record.game_id}: expected ${expected}, the store holds ${current ?? "nothing"}`;
  if (record.record_version !== expected + 1) return `a record write must advance the version by exactly one`;
  return null;
}

/* ---------------------------------------------------------------------------
    IN MEMORY: for tests and the smoke run. Every write can be failed on demand.
   --------------------------------------------------------------------------- */

export interface MemoryRecordStore extends RecordStore {
  readonly records: Map<string, GameRecord>;
  readonly codes: Map<string, string>;
  /** Failures to inject into the next record puts: "definite" (nothing written) or "uncertain" (written, unknown). */
  readonly failPuts: Array<"definite" | "uncertain">;
  /** Failures to inject into the next code claims. */
  readonly failClaims: number[];
  readonly stats: { puts: number; loads: number; lookups: number };
}

export function createMemoryRecordStore(): MemoryRecordStore {
  const records = new Map<string, GameRecord>();
  const codes = new Map<string, string>();
  const failPuts: Array<"definite" | "uncertain"> = [];
  const failClaims: number[] = [];
  const stats = { puts: 0, loads: 0, lookups: 0 };
  return {
    records,
    codes,
    failPuts,
    failClaims,
    stats,
    async list() {
      return [...records.keys()];
    },
    async load(gameId) {
      stats.loads += 1;
      const record = records.get(gameId);
      return record === undefined ? null : copy(record);
    },
    async put(record, expected) {
      const problem = versionCheck(record, expected, records.get(record.game_id)?.record_version ?? null);
      if (problem !== null) return { kind: "definite", detail: problem };
      const fault = failPuts.shift();
      if (fault === "definite") return { kind: "definite", detail: "injected record-store failure (nothing written)" };
      records.set(record.game_id, copy(record));
      stats.puts += 1;
      if (fault === "uncertain") return { kind: "uncertain", detail: "injected record-store failure (outcome unknown)" };
      return COMMITTED;
    },
    async lookupCode(code) {
      stats.lookups += 1;
      return codes.get(code) ?? null;
    },
    async claimCode(code, gameId) {
      if (failClaims.length > 0) {
        failClaims.shift();
        throw new StoreDefiniteError("injected join-code index failure (nothing written)");
      }
      const holder = codes.get(code);
      if (holder !== undefined && holder !== gameId) return "taken";
      codes.set(code, gameId);
      return "claimed";
    },
    async releaseCode(code, gameId) {
      if (codes.get(code) === gameId) codes.delete(code);
    },
  };
}

/* ---------------------------------------------------------------------------
    THE INTERIM FILE ADAPTER
   --------------------------------------------------------------------------- */

export interface FileRecordStoreOptions {
  fs?: StoreFs;
  platform?: string;
  writerCheck?: () => Promise<boolean>;
  onRestartRequired?: (key: string, detail: string) => void;
  warn?: (line: string) => void;
}

const INDEX_FORMAT = "gs-join-codes";

export function createFileRecordStore(
  dataDir: string,
  options: FileRecordStoreOptions = {},
): RecordStore & { readonly directory: string; sizes(): { chains: number; versions: number } } {
  const io = options.fs ?? nodeStoreFs;
  const directory = path.join(dataDir, "games");
  // eslint-disable-next-line no-console
  const warn = options.warn ?? ((line: string) => console.warn(line));
  const versions = new Map<string, number | null>();
  const poisoned = new Map<string, string>();
  const chains = new Map<string, Promise<unknown>>();
  let index: Map<string, string> | null = null;
  let ready: Promise<void> | null = null;
  const prepare = () => (ready ??= io.mkdir(directory));
  /** One chain per key -- dropped once it drains, so ids nobody holds cost nothing (review M1: a flood of unknown
   *  game ids must not grow this map). */
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
  const recordFile = (gameId: string) => path.join(directory, `${gameId}.json`);
  const indexFile = path.join(directory, "join-codes.json");

  async function readRecord(gameId: string): Promise<GameRecord | null> {
    if (!GAME_ID_PATTERN.test(gameId)) return null;
    await prepare();
    let raw: Buffer;
    try {
      raw = await io.readFile(recordFile(gameId));
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return null;
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString("utf8"));
    } catch {
      throw new StoreCorruptError(`${gameId}.json is not JSON`, recordFile(gameId), 0);
    }
    if (!isGameRecord(parsed) || parsed.game_id !== gameId) {
      throw new StoreCorruptError(`${gameId}.json is not a game record`, recordFile(gameId), 0);
    }
    return parsed;
  }

  async function write(key: string, target: string, contents: string): Promise<StoreWriteOutcome> {
    const held = poisoned.get(key);
    if (held) return { kind: "definite", detail: `${path.basename(target)} is held after an unresolved write (${held}); nothing was written` };
    if (options.writerCheck && !(await options.writerCheck().catch(() => false))) {
      return { kind: "definite", detail: "this server no longer owns the data directory (its lock was taken over); nothing was written" };
    }
    const outcome = await durableReplace(io, target, Buffer.from(contents, "utf8"), { platform: options.platform, warn });
    if (outcome.kind === "uncertain") {
      poisoned.set(key, outcome.detail);
      options.onRestartRequired?.(key, outcome.detail);
    }
    return outcome;
  }

  async function loadIndex(): Promise<Map<string, string>> {
    if (index !== null) return index;
    await prepare();
    let raw: Buffer | null = null;
    try {
      raw = await io.readFile(indexFile);
    } catch (error) {
      if ((error as { code?: string }).code !== "ENOENT") throw error;
    }
    const loaded = new Map<string, string>();
    if (raw !== null) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString("utf8"));
      } catch {
        throw new StoreCorruptError("join-codes.json is not JSON", indexFile, 0);
      }
      const document = parsed as { format?: unknown; version?: unknown; codes?: unknown };
      if (document?.format !== INDEX_FORMAT || document.version !== 1 || typeof document.codes !== "object" || document.codes === null) {
        throw new StoreCorruptError("join-codes.json is not a join-code index", indexFile, 0);
      }
      for (const [code, gameId] of Object.entries(document.codes as Record<string, unknown>)) {
        if (!JOIN_CODE_PATTERN.test(code) || typeof gameId !== "string" || !GAME_ID_PATTERN.test(gameId)) {
          throw new StoreCorruptError("join-codes.json holds an entry that is not a code and a game id", indexFile, 0);
        }
        loaded.set(code, gameId);
      }
    }
    index = loaded;
    return loaded;
  }

  const saveIndex = (next: Map<string, string>) =>
    write(
      "join-codes",
      indexFile,
      `${JSON.stringify({ format: INDEX_FORMAT, version: 1, codes: Object.fromEntries([...next.entries()].sort()) })}\n`,
    );

  const indexOutcome = (outcome: StoreWriteOutcome): void => {
    if (outcome.kind === "committed") return;
    throw outcome.kind === "definite" ? new StoreDefiniteError(outcome.detail) : new Error(`join-code index write unresolved: ${outcome.detail}`);
  };

  return {
    directory,
    /** What the adapter holds in memory per key -- bounded by the games that exist (tests read it). */
    sizes: () => ({ chains: chains.size, versions: versions.size }),
    async list() {
      await prepare();
      return (await io.readdir(directory))
        .filter((name) => name.endsWith(".json") && GAME_ID_PATTERN.test(name.slice(0, -5)))
        .map((name) => name.slice(0, -5));
    },
    load(gameId) {
      return serial(gameId, async () => {
        const record = await readRecord(gameId);
        /* Only a record that exists is remembered; a miss leaves nothing behind (review M1). */
        if (record === null) versions.delete(gameId);
        else versions.set(gameId, record.record_version);
        return record;
      });
    },
    put(record, expected) {
      return serial(record.game_id, async () => {
        await prepare();
        if (!versions.has(record.game_id)) versions.set(record.game_id, (await readRecord(record.game_id))?.record_version ?? null);
        const problem = versionCheck(record, expected, versions.get(record.game_id) ?? null);
        if (problem !== null) return { kind: "definite", detail: problem };
        const outcome = await write(record.game_id, recordFile(record.game_id), `${JSON.stringify(record)}\n`);
        if (outcome.kind === "committed") versions.set(record.game_id, record.record_version);
        return outcome;
      });
    },
    lookupCode(code) {
      /* The committed index answers at once -- a join never queues behind index rewrites (review L6). It is replaced
         only after a write committed, so it is never ahead of the disk. */
      if (index !== null) return Promise.resolve(index.get(code) ?? null);
      return serial("join-codes", async () => (await loadIndex()).get(code) ?? null);
    },
    claimCode(code, gameId) {
      return serial("join-codes", async () => {
        const current = await loadIndex();
        const holder = current.get(code);
        if (holder !== undefined) return holder === gameId ? "claimed" : "taken";
        const next = new Map(current);
        next.set(code, gameId);
        indexOutcome(await saveIndex(next));
        index = next;
        return "claimed";
      });
    },
    releaseCode(code, gameId) {
      return serial("join-codes", async () => {
        const current = await loadIndex();
        if (current.get(code) !== gameId) return;
        const next = new Map(current);
        next.delete(code);
        indexOutcome(await saveIndex(next));
        index = next;
      });
    },
  };
}
