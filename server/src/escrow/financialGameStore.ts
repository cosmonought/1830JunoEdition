// server/src/escrow/financialGameStore.ts
//
// ==================================================================
//  ESCROW-3A (brief §4, §14): WHERE A MONEY GAME'S LIFECYCLE IS KEPT -- CREATE-IF-ABSENT AND COMPARE-AND-SWAP ONLY
// ==================================================================
//
// One record per money game, `games/money/<game_id>.json`, written by LIVE-3B's durable replacement under the data
// directory's lock (after `writerCheck`), exactly as holds are. Two operations change it, and both carry the precondition
// a LIVE-5 store turns into a DynamoDB ConditionExpression:
//
//   create(record)                    CREATE-IF-ABSENT (`attribute_not_exists(pk)`): an existing record is kept and
//                                     returned -- a repeated creation converges on the first one.
//   put(next, expectedVersion)        COMPARE-AND-SWAP on `record_version` (`record_version = :expected`, and
//                                     next.record_version = expected + 1): a writer holding a stale record gets
//                                     `conflict` with the current one and re-decides from it (`transitionFinancial`).
//
// A record file that cannot be read is never guessed at: `load` rejects `FinancialRecordUnreadableError`, and the
// settlement coordinator holds the game rather than re-creating a record over it.
//
// LIVE-4 (L4-4): AN UNREADABLE RECORD HAS A CLASS (`formatFactOf`, the canonical model). The file's own `format` and
// `version` say which build wrote it, and nothing else is read before that is known:
//   current        a version this build reads -- it must then parse exactly, or it is `corrupt`;
//   newer          a version above every one this build reads: a later build wrote it (never damage, never repaired
//                  into this build's format: the pool that reads it continues the game);
//   older-unread   a real version this build no longer reads: an earlier build wrote it (the same, the other way);
//   corrupt        not a record of any version (torn JSON, another artifact, no integer version, a damaged current one).
// The error carries the class, and the continuation verdict reads it (`not-continued/newer-format`, `/older-format`,
// `/malformed`). Whatever the class, the record is never overwritten here: `create` and `put` refuse it.

import * as path from "path";

import { nodeStoreFs, type StoreFs } from "../fileLogStore";
import { durableReplace } from "../persistence/durableReplace";
import { COMMITTED, type StoreWriteOutcome } from "../persistence/storeResult";
import { GAME_ID_PATTERN } from "../rooms/gameRecord";
import { FINANCIAL_FORMAT, FINANCIAL_VERSION, isFinancialGameRecord, type FinancialGameRecord } from "./moneyLifecycle";
import { formatFactOf, type FormatFact } from "../../../frontend/src/gameEngine/compat/continuationVerdict";

/** The class of a stored artifact this build cannot read (every `FormatFact` but `current`). */
export type UnreadableFormat = Exclude<FormatFact, "current">;

export class FinancialRecordUnreadableError extends Error {
  constructor(
    message: string,
    readonly gameId: string,
    /** LIVE-4 (L4-4): which build could read it -- a later one, an earlier one, or none (damage). */
    readonly format: UnreadableFormat = "corrupt",
  ) {
    super(message);
    this.name = "FinancialRecordUnreadableError";
  }
}

/** LIVE-4 (L4-4): the financial-record file versions this build reads and writes (`FINANCIAL_VERSION`). */
export const READABLE_FINANCIAL_VERSIONS: readonly number[] = Object.freeze([FINANCIAL_VERSION]);

/** LIVE-4 (L4-4): the class of a parsed record document, for `gameId`'s file. A newer or older document is classified
 *  by its `format` and `version` alone -- its other fields are another build's and are never read here. */
export function financialRecordFormat(parsed: unknown, gameId: string): FormatFact {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return "corrupt";
  const document = parsed as Record<string, unknown>;
  if (document.format !== FINANCIAL_FORMAT) return "corrupt";
  const fact = formatFactOf(document.version, READABLE_FINANCIAL_VERSIONS);
  if (fact !== "current") return fact;
  return isFinancialGameRecord(parsed) && parsed.game_id === gameId ? "current" : "corrupt";
}

const unreadableMessage = (gameId: string, format: UnreadableFormat): string =>
  format === "newer"
    ? `${gameId}.json in games/money/ is a financial record in a format NEWER than this build reads (a later build wrote it); it is not continued here and never overwritten`
    : format === "older-unread"
      ? `${gameId}.json in games/money/ is a financial record in an OLDER format this build no longer reads; it is not continued here and never overwritten`
      : `${gameId}.json in games/money/ is not the financial record of that game`;

export type FinancialPutOutcome = StoreWriteOutcome | { readonly kind: "conflict"; readonly current: FinancialGameRecord | null };

export interface FinancialGameStore {
  list(): Promise<string[]>;
  load(gameId: string): Promise<FinancialGameRecord | null>;
  create(record: FinancialGameRecord): Promise<{ readonly outcome: StoreWriteOutcome; readonly existing: FinancialGameRecord | null }>;
  put(next: FinancialGameRecord, expectedVersion: number): Promise<FinancialPutOutcome>;
}

/* ---------------------------------------------------------------------------
    IN MEMORY: tests (every write can be failed on demand)
   --------------------------------------------------------------------------- */

export interface MemoryFinancialGameStore extends FinancialGameStore {
  /** A string marks a record this build cannot read: `"unreadable"` (damage), `"newer"` or `"older-unread"` (L4-4). */
  readonly records: Map<string, FinancialGameRecord | "unreadable" | UnreadableFormat>;
  readonly failNext: Array<"definite" | "uncertain">;
  readonly writes: { count: number };
}

export function createMemoryFinancialGameStore(): MemoryFinancialGameStore {
  const records = new Map<string, FinancialGameRecord | "unreadable" | UnreadableFormat>();
  const failNext: Array<"definite" | "uncertain"> = [];
  const writes = { count: 0 };
  const copy = (record: FinancialGameRecord) => JSON.parse(JSON.stringify(record)) as FinancialGameRecord;
  const write = (record: FinancialGameRecord): StoreWriteOutcome => {
    const fault = failNext.shift();
    if (fault === "definite") return { kind: "definite", detail: "injected financial-store failure (nothing written)" };
    records.set(record.game_id, copy(record));
    writes.count += 1;
    if (fault === "uncertain") return { kind: "uncertain", detail: "injected financial-store failure (outcome unknown)" };
    return COMMITTED;
  };
  return {
    records,
    failNext,
    writes,
    async list() {
      return [...records.keys()];
    },
    async load(gameId) {
      const record = records.get(gameId);
      if (typeof record === "string") {
        const format: UnreadableFormat = record === "unreadable" ? "corrupt" : record;
        throw new FinancialRecordUnreadableError(format === "corrupt" ? `the financial record of ${gameId} is unreadable` : unreadableMessage(gameId, format), gameId, format);
      }
      return record === undefined ? null : copy(record);
    },
    async create(record) {
      const existing = records.get(record.game_id);
      if (typeof existing === "string") return { outcome: { kind: "definite", detail: "an unreadable record is never overwritten" }, existing: null };
      if (existing !== undefined) return { outcome: COMMITTED, existing: copy(existing) };
      if (!isFinancialGameRecord(record) || record.record_version !== 1) return { outcome: { kind: "definite", detail: "not a new financial record" }, existing: null };
      return { outcome: write(record), existing: null };
    },
    async put(next, expectedVersion) {
      const current = records.get(next.game_id);
      if (typeof current === "string") return { kind: "definite", detail: "an unreadable record is never overwritten" };
      if (current === undefined || current.record_version !== expectedVersion) return { kind: "conflict", current: current === undefined ? null : copy(current) };
      if (!isFinancialGameRecord(next) || next.record_version !== expectedVersion + 1) return { kind: "definite", detail: "not the next version of the record" };
      return write(next);
    },
  };
}

/* ---------------------------------------------------------------------------
    THE FILE ADAPTER
   --------------------------------------------------------------------------- */

export function financialDirectory(dataDir: string): string {
  return path.join(dataDir, "games", "money");
}

export function createFileFinancialGameStore(
  dataDir: string,
  options: { fs?: StoreFs; platform?: string; writerCheck?: () => Promise<boolean>; warn?: (line: string) => void } = {},
): FinancialGameStore & { readonly directory: string } {
  const io = options.fs ?? nodeStoreFs;
  const directory = financialDirectory(dataDir);
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
  const codeOf = (error: unknown) => (error as NodeJS.ErrnoException | undefined)?.code;
  const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

  async function read(gameId: string): Promise<FinancialGameRecord | null> {
    let raw: Buffer;
    try {
      raw = await io.readFile(fileOf(gameId));
    } catch (error) {
      if (codeOf(error) === "ENOENT") return null;
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString("utf8"));
    } catch {
      throw new FinancialRecordUnreadableError(`${gameId}.json in games/money/ is not JSON`, gameId);
    }
    const format = financialRecordFormat(parsed, gameId);
    if (format !== "current") throw new FinancialRecordUnreadableError(unreadableMessage(gameId, format), gameId, format);
    return parsed as FinancialGameRecord;
  }

  const fenced = async (): Promise<boolean> => options.writerCheck !== undefined && !(await options.writerCheck().catch(() => false));

  async function write(record: FinancialGameRecord): Promise<StoreWriteOutcome> {
    if (await fenced()) return { kind: "definite", detail: "this server no longer owns the data directory (its lock was taken over); nothing was written" };
    try {
      await io.mkdir(directory);
    } catch (error) {
      return { kind: "definite", detail: `could not make ${directory}: ${describe(error)}` };
    }
    return durableReplace(io, fileOf(record.game_id), Buffer.from(`${JSON.stringify(record)}\n`, "utf8"), { platform: options.platform, warn });
  }

  return {
    directory,
    async list() {
      let names: string[];
      try {
        names = await io.readdir(directory);
      } catch (error) {
        if (codeOf(error) === "ENOENT") return [];
        throw error;
      }
      return names.filter((name) => name.endsWith(".json") && GAME_ID_PATTERN.test(name.slice(0, -5))).map((name) => name.slice(0, -5));
    },
    load(gameId) {
      if (!GAME_ID_PATTERN.test(gameId)) return Promise.resolve(null);
      return serial(gameId, () => read(gameId));
    },
    create(record) {
      return serial(record.game_id, async () => {
        if (!GAME_ID_PATTERN.test(record.game_id) || !isFinancialGameRecord(record) || record.record_version !== 1) {
          return { outcome: { kind: "definite" as const, detail: "not a new financial record" }, existing: null };
        }
        try {
          const existing = await read(record.game_id);
          if (existing !== null) return { outcome: COMMITTED, existing };
        } catch (error) {
          return { outcome: { kind: "definite" as const, detail: `the financial record of ${record.game_id} cannot be read (${describe(error)}); it is never overwritten` }, existing: null };
        }
        return { outcome: await write(record), existing: null };
      });
    },
    put(next, expectedVersion) {
      return serial(next.game_id, async (): Promise<FinancialPutOutcome> => {
        let current: FinancialGameRecord | null;
        try {
          current = await read(next.game_id);
        } catch (error) {
          return { kind: "definite", detail: `the financial record of ${next.game_id} cannot be read (${describe(error)}); it is never overwritten` };
        }
        if (current === null || current.record_version !== expectedVersion) return { kind: "conflict", current };
        if (!isFinancialGameRecord(next) || next.record_version !== expectedVersion + 1) return { kind: "definite", detail: "not the next version of the record" };
        return write(next);
      });
    },
  };
}
