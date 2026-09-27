// server/src/rooms/holdStore.ts
//
// ==================================================================
//  LIVE-3C (LIVE-3 §8.5, §14.4, OD-L3-3): THE DURABLE HOLD
// ==================================================================
//
// Before LIVE-3C a hold was an incidental in-memory state: a load that met a damaged log held the room for as long as
// that process lived, and the next start decided again from whatever the files said then. That is not good enough
// once reconciliation can find a record and a log that DISAGREE: a disagreement is evidence, and evidence must not
// evaporate because a process restarted -- nor be "fixed" by the next load quietly deciding differently (a log that
// an earlier load truncated, a record some later write happened to line up). So a hold is written down, and from then
// on it is the hold, not the next load's opinion, that decides:
//
//   A HELD GAME   serves no history, takes no move and no room change (a `leave` only unsubscribes), answers every
//                 player with one fixed sentence (`HELD_PLAYER_SENTENCE` -- never the operator's detail, never a
//                 record's contents), keeps every file exactly as found, and stays held across every restart.
//   ONE WAY OUT   the operator tool (`tools/gamesDoctor.ts release`), OFFLINE: it takes the data directory's lock (so no
//                 server can run beside it), re-verifies the game from its files with the full load (a clean log scan,
//                 the replay, and the reconciliation table all passing), and only then moves the hold to
//                 `holds/released/` with the verification and the operator's note, and appends an audit line. A game
//                 that still fails verification stays held; there is no force.
//
// LAYOUT: `games/holds/<game_id>.json` (live), `games/holds/released/<game_id>.<held_at>.<released_at>.json` (kept as
// evidence -- a release never deletes the hold's content, it moves it). Written by LIVE-3B's durable replacement, under
// the data directory's lock, after `writerCheck`. A hold is CREATE-IF-ABSENT: the first hold of a game is the one kept
// (its code, detail and evidence are what the game looked like when it was first held); a later detection of the same
// game finds it and changes nothing.
//
// A HOLD FILE THAT CANNOT BE READ HOLDS ITS GAME (`hold-unreadable`): a hold is never lifted by being unreadable.
//
// LIVE-5: a `GAME#<id>/HOLD` item, `Put ... attribute_not_exists` to create; release is an operator transaction that
// writes the released copy and deletes the live item together.

import * as path from "path";

import { nodeStoreFs, type StoreFs } from "../fileLogStore";
import { durableReplace } from "../persistence/durableReplace";
import { COMMITTED, type StoreWriteOutcome } from "../persistence/storeResult";
import { GAME_ID_PATTERN } from "./gameRecord";
import { HOLD_CODES, type HoldCode } from "./lifecycle";

export const HOLD_FORMAT = "gs-game-hold";
export const HOLD_VERSION = 1;
const MAX_DETAIL = 500;

export interface HoldEvidence {
  readonly record_version: number | null;
  readonly record_status: string | null;
  readonly log_entries: number | null;
  readonly log_bytes: number | null;
}

export interface GameHold {
  readonly format: typeof HOLD_FORMAT;
  readonly version: typeof HOLD_VERSION;
  readonly game_id: string;
  readonly code: HoldCode;
  /** Operator-facing; never a principal, profile or session id; never sent to a client. */
  readonly detail: string;
  readonly held_at: number;
  /** What found it: startup discovery, a game's load, or the operator. */
  readonly source: "discovery" | "load" | "operator";
  /** The server build and rules-engine version that found it. */
  readonly build: string;
  readonly rules_engine_version: number;
  readonly evidence: HoldEvidence;
}

export interface HoldRelease {
  readonly released_at: number;
  /** The operator's own words: why it is safe now. Required, 1-500 characters. */
  readonly note: string;
  /** What the verification found (from `gamesDoctor`): the class, the entries, the log's hash. */
  readonly verification: { readonly class: string; readonly entries: number; readonly log_hash: string | null };
  readonly build: string;
}

export class HoldUnreadableError extends Error {
  constructor(
    message: string,
    readonly gameId: string,
  ) {
    super(message);
    this.name = "HoldUnreadableError";
  }
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const HOLD_KEYS = ["format", "version", "game_id", "code", "detail", "held_at", "source", "build", "rules_engine_version", "evidence"];
const EVIDENCE_KEYS = ["record_version", "record_status", "log_entries", "log_bytes"];
const intOrNull = (value: unknown) => value === null || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);

export function isGameHold(value: unknown): value is GameHold {
  if (!isObject(value)) return false;
  if (Object.keys(value).length !== HOLD_KEYS.length || !HOLD_KEYS.every((key) => key in value)) return false;
  const evidence = value.evidence;
  return (
    value.format === HOLD_FORMAT &&
    value.version === HOLD_VERSION &&
    typeof value.game_id === "string" &&
    GAME_ID_PATTERN.test(value.game_id) &&
    (HOLD_CODES as readonly unknown[]).includes(value.code) &&
    typeof value.detail === "string" &&
    value.detail.length <= MAX_DETAIL &&
    typeof value.held_at === "number" &&
    Number.isSafeInteger(value.held_at) &&
    (value.source === "discovery" || value.source === "load" || value.source === "operator") &&
    typeof value.build === "string" &&
    typeof value.rules_engine_version === "number" &&
    isObject(evidence) &&
    Object.keys(evidence).length === EVIDENCE_KEYS.length &&
    EVIDENCE_KEYS.every((key) => key in evidence) &&
    intOrNull(evidence.record_version) &&
    (evidence.record_status === null || typeof evidence.record_status === "string") &&
    intOrNull(evidence.log_entries) &&
    intOrNull(evidence.log_bytes)
  );
}

/** A hold, built by the server (the detail is cut to the stored bound). */
export function makeHold(input: {
  gameId: string;
  code: HoldCode;
  detail: string;
  at: number;
  source: GameHold["source"];
  build: string;
  rulesEngineVersion: number;
  evidence?: Partial<HoldEvidence>;
}): GameHold {
  return {
    format: HOLD_FORMAT,
    version: HOLD_VERSION,
    game_id: input.gameId,
    code: input.code,
    detail: input.detail.slice(0, MAX_DETAIL),
    held_at: input.at,
    source: input.source,
    build: input.build,
    rules_engine_version: input.rulesEngineVersion,
    evidence: {
      record_version: input.evidence?.record_version ?? null,
      record_status: input.evidence?.record_status ?? null,
      log_entries: input.evidence?.log_entries ?? null,
      log_bytes: input.evidence?.log_bytes ?? null,
    },
  };
}

export interface CreateHoldOutcome {
  readonly outcome: StoreWriteOutcome;
  /** The hold that was already there (create-if-absent kept it), when there was one. */
  readonly existing: GameHold | null;
}

export interface HoldStore {
  /** Game ids with a live hold (an unreadable hold file is listed too: it holds its game). */
  list(): Promise<string[]>;
  /** The live hold, `null` when none. Rejects `HoldUnreadableError` for a hold file that cannot be read. */
  load(gameId: string): Promise<GameHold | null>;
  /** CREATE-IF-ABSENT: an existing hold is kept and returned, never overwritten. */
  create(hold: GameHold): Promise<CreateHoldOutcome>;
  /** OPERATOR ONLY (the offline tool): the released copy is written, then the live hold removed. */
  release(gameId: string, release: HoldRelease): Promise<StoreWriteOutcome>;
}

/* ---------------------------------------------------------------------------
    IN MEMORY: tests
   --------------------------------------------------------------------------- */

export interface MemoryHoldStore extends HoldStore {
  readonly holds: Map<string, GameHold | "unreadable">;
  readonly released: Array<GameHold & { released: HoldRelease }>;
  readonly failCreates: Array<"definite" | "uncertain">;
}

export function createMemoryHoldStore(): MemoryHoldStore {
  const holds = new Map<string, GameHold | "unreadable">();
  const released: Array<GameHold & { released: HoldRelease }> = [];
  const failCreates: Array<"definite" | "uncertain"> = [];
  return {
    holds,
    released,
    failCreates,
    async list() {
      return [...holds.keys()];
    },
    async load(gameId) {
      const hold = holds.get(gameId);
      if (hold === "unreadable") throw new HoldUnreadableError(`the hold of ${gameId} is unreadable`, gameId);
      return hold ?? null;
    },
    async create(hold) {
      const existing = holds.get(hold.game_id);
      if (existing === "unreadable") return { outcome: COMMITTED, existing: null };
      if (existing !== undefined) return { outcome: COMMITTED, existing };
      const fault = failCreates.shift();
      if (fault === "definite") return { outcome: { kind: "definite", detail: "injected hold-store failure" }, existing: null };
      holds.set(hold.game_id, hold);
      if (fault === "uncertain") return { outcome: { kind: "uncertain", detail: "injected hold-store failure (outcome unknown)" }, existing: null };
      return { outcome: COMMITTED, existing: null };
    },
    async release(gameId, release) {
      const hold = holds.get(gameId);
      if (hold === undefined || hold === "unreadable") return { kind: "definite", detail: `${gameId} holds no readable hold` };
      released.push({ ...hold, released: release });
      holds.delete(gameId);
      return COMMITTED;
    },
  };
}

/* ---------------------------------------------------------------------------
    THE FILE ADAPTER
   --------------------------------------------------------------------------- */

export interface FileHoldStoreOptions {
  fs?: StoreFs;
  platform?: string;
  writerCheck?: () => Promise<boolean>;
  warn?: (line: string) => void;
}

const codeOf = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | undefined)?.code;
const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function holdDirectory(dataDir: string): string {
  return path.join(dataDir, "games", "holds");
}

export function createFileHoldStore(dataDir: string, options: FileHoldStoreOptions = {}): HoldStore & { readonly directory: string } {
  const io = options.fs ?? nodeStoreFs;
  const directory = holdDirectory(dataDir);
  const releasedDirectory = path.join(directory, "released");
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

  async function read(gameId: string): Promise<GameHold | null> {
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
      throw new HoldUnreadableError(`${gameId}.json in holds/ is not JSON`, gameId);
    }
    if (!isGameHold(parsed) || parsed.game_id !== gameId) throw new HoldUnreadableError(`${gameId}.json in holds/ is not a hold of that game`, gameId);
    return parsed;
  }

  const fenced = async (): Promise<boolean> => options.writerCheck !== undefined && !(await options.writerCheck().catch(() => false));

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
    create(hold) {
      return serial(hold.game_id, async (): Promise<CreateHoldOutcome> => {
        if (!isGameHold(hold)) return { outcome: { kind: "definite", detail: "not a hold" }, existing: null };
        try {
          const existing = await read(hold.game_id);
          if (existing !== null) return { outcome: COMMITTED, existing };
        } catch (error) {
          /* An unreadable hold is already a hold (it holds its game); it is left exactly as found. */
          if (error instanceof HoldUnreadableError) return { outcome: COMMITTED, existing: null };
          return { outcome: { kind: "definite", detail: `could not read the hold of ${hold.game_id}: ${describe(error)}` }, existing: null };
        }
        if (await fenced()) {
          return { outcome: { kind: "definite", detail: "this server no longer owns the data directory (its lock was taken over); nothing was written" }, existing: null };
        }
        try {
          await io.mkdir(directory);
        } catch (error) {
          return { outcome: { kind: "definite", detail: `could not make ${directory}: ${describe(error)}` }, existing: null };
        }
        const outcome = await durableReplace(io, fileOf(hold.game_id), Buffer.from(`${JSON.stringify(hold)}\n`, "utf8"), { platform: options.platform, warn });
        return { outcome, existing: null };
      });
    },
    release(gameId, release) {
      return serial(gameId, async (): Promise<StoreWriteOutcome> => {
        const hold = await read(gameId).catch(() => null);
        if (hold === null) return { kind: "definite", detail: `${gameId} holds no readable hold` };
        if (await fenced()) return { kind: "definite", detail: "this process does not own the data directory; nothing was written" };
        await io.mkdir(releasedDirectory);
        const target = path.join(releasedDirectory, `${gameId}.${hold.held_at}.${release.released_at}.json`);
        const written = await durableReplace(io, target, Buffer.from(`${JSON.stringify({ ...hold, released: release })}\n`, "utf8"), { platform: options.platform, warn });
        if (written.kind !== "committed") return written;
        try {
          await io.unlink(fileOf(gameId));
        } catch (error) {
          /* The released copy is there and the live hold too: still held. The operator runs the release again. */
          return { kind: "uncertain", detail: `the released copy was written but the live hold could not be removed: ${describe(error)}` };
        }
        return COMMITTED;
      });
    },
  };
}
