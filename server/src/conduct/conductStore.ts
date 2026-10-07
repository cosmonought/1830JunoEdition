// server/src/conduct/conductStore.ts
//
// ==================================================================
//  PHASE 3 (P3-N035): THE CONDUCT-CASE STORE -- CREATE-IF-ABSENT, THEN CONDITIONAL ON THE CASE'S REVISION
// ==================================================================
//
// One durable record per case (`conductCase.ts`), in a store of its own: no game, identity, money or trust store holds
// one, and none of them is written by anything here.
//
//   create(case)                 CREATE-IF-ABSENT by case id. A case that already stands -- readable or not -- is kept
//                                exactly as it is and answered (`existing`), so a repeated report (a double click, a
//                                second tab, a retry after a lost answer) is one case.
//   save(case, expectedRevision) a reviewer's decision: CONDITIONAL on the stored revision (`definite` when it moved).
//   load(caseId) / list()        a case (`ConductCaseUnreadableError` for one that cannot be read -- never overwritten),
//                                and every case id the store holds (unreadable ones included, so none goes unseen).
//
// Outcomes are the stores' usual three (`persistence/storeResult.ts`): committed, definite (nothing written), uncertain
// (it may have landed). The file adapter writes `conduct/cases/<case_id>.json` with LIVE-3B's durable replacement,
// under the data directory's lock (`writerCheck`); the DynamoDB adapter is `aws/game/dynamoConductStore.ts`.

import * as path from "path";
import { promises as nodeFs } from "fs";

import { nodeStoreFs, type StoreFs } from "../fileLogStore";
import { durableReplace } from "../persistence/durableReplace";
import { COMMITTED, type StoreWriteOutcome } from "../persistence/storeResult";
import { CASE_ID_PATTERN, ConductCaseUnreadableError, isConductCase, parseConductCaseDocument, serializeConductCase, type ConductCase } from "./conductCase";

export interface CreateCaseOutcome {
  readonly outcome: StoreWriteOutcome;
  /** The case that already stood (create-if-absent kept it), when one was readable. */
  readonly existing: ConductCase | null;
  /** A case already stood under this id but could not be read (it is kept, untouched). */
  readonly existingUnreadable?: boolean;
}

export interface ConductCaseStore {
  /** Every case id held (an unreadable case included). */
  list(): Promise<string[]>;
  /** The case, or `null`. Rejects `ConductCaseUnreadableError` for one that cannot be read. */
  load(caseId: string): Promise<ConductCase | null>;
  /** CREATE-IF-ABSENT (revision 1). */
  create(value: ConductCase): Promise<CreateCaseOutcome>;
  /** CONDITIONAL on the stored revision: `expected` is the revision the decision was made on. */
  save(value: ConductCase, expected: number): Promise<StoreWriteOutcome>;
}

/* ---------------------------------------------------------------------------
    IN MEMORY: tests (a server is never given one in production -- reports would not survive a restart)
   --------------------------------------------------------------------------- */

export interface MemoryConductCaseStore extends ConductCaseStore {
  readonly cases: Map<string, ConductCase | "unreadable">;
  /** Faults for the next creates, in order. */
  readonly failCreates: Array<"definite" | "uncertain-landed" | "uncertain-lost">;
  readonly failSaves: Array<"definite" | "uncertain-landed" | "uncertain-lost">;
}

export function createMemoryConductCaseStore(): MemoryConductCaseStore {
  const cases = new Map<string, ConductCase | "unreadable">();
  const failCreates: MemoryConductCaseStore["failCreates"] = [];
  const failSaves: MemoryConductCaseStore["failSaves"] = [];
  const copy = (value: ConductCase): ConductCase => JSON.parse(JSON.stringify(value)) as ConductCase;
  return {
    cases,
    failCreates,
    failSaves,
    async list() {
      return [...cases.keys()].sort();
    },
    async load(caseId) {
      const stored = cases.get(caseId);
      if (stored === "unreadable") throw new ConductCaseUnreadableError(`the conduct case ${caseId} is unreadable`, caseId);
      return stored === undefined ? null : copy(stored);
    },
    async create(value) {
      if (!isConductCase(value) || value.revision !== 1 || serializeConductCase(value) === null) return { outcome: { kind: "definite", detail: "not a new conduct case" }, existing: null };
      const stored = cases.get(value.case_id);
      if (stored === "unreadable") return { outcome: COMMITTED, existing: null, existingUnreadable: true };
      if (stored !== undefined) return { outcome: COMMITTED, existing: copy(stored) };
      const fault = failCreates.shift();
      if (fault === "definite") return { outcome: { kind: "definite", detail: "injected conduct-store failure" }, existing: null };
      if (fault === "uncertain-lost") return { outcome: { kind: "uncertain", detail: "injected conduct-store failure (outcome unknown; not written)" }, existing: null };
      cases.set(value.case_id, copy(value));
      if (fault === "uncertain-landed") return { outcome: { kind: "uncertain", detail: "injected conduct-store failure (outcome unknown; written)" }, existing: null };
      return { outcome: COMMITTED, existing: null };
    },
    async save(value, expected) {
      if (!isConductCase(value) || serializeConductCase(value) === null) return { kind: "definite", detail: "not a conduct case" };
      const stored = cases.get(value.case_id);
      if (stored === undefined) return { kind: "definite", detail: `no conduct case ${value.case_id} is stored` };
      if (stored === "unreadable") return { kind: "definite", detail: "the stored conduct case is unreadable; it is never overwritten" };
      if (stored.revision !== expected || value.revision !== expected + 1) return { kind: "definite", detail: `the conduct case moved (stored revision ${stored.revision}, expected ${expected})` };
      const fault = failSaves.shift();
      if (fault === "definite") return { kind: "definite", detail: "injected conduct-store failure" };
      if (fault === "uncertain-lost") return { kind: "uncertain", detail: "injected conduct-store failure (outcome unknown; not written)" };
      cases.set(value.case_id, copy(value));
      if (fault === "uncertain-landed") return { kind: "uncertain", detail: "injected conduct-store failure (outcome unknown; written)" };
      return COMMITTED;
    },
  };
}

/* ---------------------------------------------------------------------------
    THE FILE ADAPTER: `conduct/cases/<case_id>.json`, replaced whole and durably, under the data directory's lock
   --------------------------------------------------------------------------- */

export interface FileConductCaseStoreOptions {
  fs?: StoreFs;
  platform?: string;
  /** LIVE-3B: every write first checks this process still owns the data directory. */
  writerCheck?: () => Promise<boolean>;
  warn?: (line: string) => void;
}

export function conductDirectory(dataDir: string): string {
  return path.join(dataDir, "conduct", "cases");
}

const codeOf = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | undefined)?.code;
const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function createFileConductCaseStore(dataDir: string, options: FileConductCaseStoreOptions = {}): ConductCaseStore & { readonly directory: string } {
  const io = options.fs ?? nodeStoreFs;
  const directory = conductDirectory(dataDir);
  // eslint-disable-next-line no-console
  const warn = options.warn ?? ((line: string) => console.warn(line));
  const fileOf = (caseId: string) => path.join(directory, `${caseId}.json`);
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

  async function read(caseId: string): Promise<ConductCase | null> {
    let raw: Buffer;
    try {
      raw = await io.readFile(fileOf(caseId));
    } catch (error) {
      if (codeOf(error) === "ENOENT") return null;
      throw error;
    }
    return parseConductCaseDocument(raw.toString("utf8"), caseId);
  }

  const fenced = async (): Promise<boolean> => options.writerCheck !== undefined && !(await options.writerCheck().catch(() => false));

  async function write(value: ConductCase, serialized: string): Promise<StoreWriteOutcome> {
    if (await fenced()) return { kind: "definite", detail: "this server no longer owns the data directory (its lock was taken over); nothing was written" };
    try {
      await io.mkdir(directory);
    } catch (error) {
      return { kind: "definite", detail: `could not make ${directory}: ${describe(error)}` };
    }
    return durableReplace(io, fileOf(value.case_id), Buffer.from(`${serialized}\n`, "utf8"), { platform: options.platform, warn });
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
      return names
        .filter((name) => name.endsWith(".json") && CASE_ID_PATTERN.test(name.slice(0, -5)))
        .map((name) => name.slice(0, -5))
        .sort();
    },
    load(caseId) {
      if (!CASE_ID_PATTERN.test(caseId)) return Promise.resolve(null);
      return serial(caseId, () => read(caseId));
    },
    create(value) {
      return serial(value.case_id, async (): Promise<CreateCaseOutcome> => {
        const serialized = isConductCase(value) && value.revision === 1 ? serializeConductCase(value) : null;
        if (serialized === null) return { outcome: { kind: "definite", detail: "not a new conduct case" }, existing: null };
        try {
          const existing = await read(value.case_id);
          if (existing !== null) return { outcome: COMMITTED, existing };
        } catch (error) {
          /* A case that cannot be read is still a case: it is left exactly as found, and the report is answered as one
             that already stands. */
          if (error instanceof ConductCaseUnreadableError) return { outcome: COMMITTED, existing: null, existingUnreadable: true };
          return { outcome: { kind: "definite", detail: `could not read the conduct case ${value.case_id}: ${describe(error)}` }, existing: null };
        }
        return { outcome: await write(value, serialized), existing: null };
      });
    },
    save(value, expected) {
      return serial(value.case_id, async (): Promise<StoreWriteOutcome> => {
        const serialized = isConductCase(value) ? serializeConductCase(value) : null;
        if (serialized === null) return { kind: "definite", detail: "not a conduct case" };
        let stored: ConductCase | null;
        try {
          stored = await read(value.case_id);
        } catch (error) {
          return { kind: "definite", detail: `the stored conduct case ${value.case_id} could not be read (${describe(error)}); nothing was written` };
        }
        if (stored === null) return { kind: "definite", detail: `no conduct case ${value.case_id} is stored` };
        if (stored.revision !== expected || value.revision !== expected + 1) return { kind: "definite", detail: `the conduct case moved (stored revision ${stored.revision}, expected ${expected})` };
        return write(value, serialized);
      });
    },
  };
}

/** Read-only, for tools: every stored case file's id (no lock, writes nothing). */
export async function listConductCaseFiles(dataDir: string): Promise<string[]> {
  try {
    const names = await nodeFs.readdir(conductDirectory(dataDir));
    return names.filter((name) => name.endsWith(".json") && CASE_ID_PATTERN.test(name.slice(0, -5))).map((name) => name.slice(0, -5)).sort();
  } catch (error) {
    if (codeOf(error) === "ENOENT") return [];
    throw error;
  }
}
