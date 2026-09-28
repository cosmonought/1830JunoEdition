// server/src/escrow/signingJournal.ts
//
// ==================================================================
//  ESCROW-3B (GNOLAND-1 F1): THE SIGNING JOURNAL -- APPEND-ONLY, OUTSIDE THE GAME STORE, WRITTEN BEFORE EVERY SIGNATURE
// ==================================================================
//
// A point-in-time restore of the game store rolls a game's log, its financial record and its chain intents back
// TOGETHER, so nothing inside the store can prove the store was rolled back -- and a rolled-back server would happily
// sign a DIFFERENT history at a sequence it already signed. This journal lives OUTSIDE that restore domain and only
// grows. Before the settlement key signs anything, `(instance, seq, signer_key_id) -> digest` is reserved here (first
// writer wins; the same digest again is `same`; another digest is a CONFLICT and the caller HOLDS); before any relayer
// transaction is broadcast its id and account sequence are recorded here. On every load of a money game and before
// every signature, a journal (or chain) sequence ahead of the durable log HOLDS the game (`journal-ahead`).
//
// This is the LOCAL adapter: JSON lines in its own directory, each append fsynced before it is acknowledged; a torn
// final line (a crash mid-append, never acknowledged, so never followed by a signature) is cut at open; any other
// damage refuses to open (signing stops). PRODUCTION (OD-G1-2, LIVE-5): the same port over a conditional-put table in
// a separate AWS account, or an S3 Object-Lock bucket -- anything a game-store restore cannot reach. The directory
// must therefore NOT be inside the data directory in production (`junoConfig.ts` refuses that).

import { promises as fsp } from "fs";
import * as path from "path";

import type { CodecDigest } from "../../../frontend/src/gameEngine/escrow/escrowCodec";
import type { SigningJournal } from "./escrowPorts";

export const JOURNAL_FILE = "signing-journal.jsonl";

type Line =
  | { readonly t: "settle"; readonly instance: string; readonly seq: string; readonly key: number; readonly digest: CodecDigest<"settle">; readonly at: number }
  | { readonly t: "attempt"; readonly intent_id: string; readonly tx_id: string; readonly account: string; readonly sequence: string; readonly at: number; readonly expires_after_height?: string };

export class SigningJournalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SigningJournalError";
  }
}

export interface InspectableSigningJournal extends SigningJournal {
  /** Every reservation, for the operator view (digests only; nothing secret is ever in the journal). */
  reservations(instance?: string): ReadonlyArray<{ readonly instance: string; readonly seq: string; readonly signer_key_id: number; readonly digest_hex: string }>;
  attemptsOf(intentId: string): ReadonlyArray<{ readonly tx_id: string; readonly account: string; readonly sequence: string; readonly expires_after_height?: string }>;
  /** ESCROW-3B review #1: every journalled attempt (a restored intent store may have forgotten some; the relayer's
   *  startup guard reads these). */
  allAttempts(): ReadonlyArray<{ readonly intent_id: string; readonly tx_id: string; readonly account: string; readonly sequence: string; readonly expires_after_height?: string }>;
}

function indexer() {
  const reserved = new Map<string, { instance: string; seq: string; key: number; digest: CodecDigest<"settle"> }>();
  const highest = new Map<string, bigint>();
  const attempts = new Map<string, Array<{ tx_id: string; account: string; sequence: string; expires_after_height?: string }>>();
  const slot = (instance: string, seq: string, key: number) => JSON.stringify([instance, seq, key]);
  return {
    apply(line: Line) {
      if (line.t === "settle") {
        const key = slot(line.instance, line.seq, line.key);
        if (!reserved.has(key)) reserved.set(key, { instance: line.instance, seq: line.seq, key: line.key, digest: line.digest });
        const seq = BigInt(line.seq);
        if ((highest.get(line.instance) ?? BigInt(-1)) < seq) highest.set(line.instance, seq);
      } else {
        const list = attempts.get(line.intent_id) ?? [];
        if (!list.some((entry) => entry.tx_id === line.tx_id)) list.push({ tx_id: line.tx_id, account: line.account, sequence: line.sequence, ...(line.expires_after_height !== undefined ? { expires_after_height: line.expires_after_height } : {}) });
        attempts.set(line.intent_id, list);
      }
    },
    lookup: (instance: string, seq: string, key: number) => reserved.get(slot(instance, seq, key)),
    highest: (instance: string) => highest.get(instance),
    reservations: (instance?: string) =>
      [...reserved.values()].filter((entry) => instance === undefined || entry.instance === instance).map((entry) => ({ instance: entry.instance, seq: entry.seq, signer_key_id: entry.key, digest_hex: entry.digest.hex })),
    attemptsOf: (intentId: string) => [...(attempts.get(intentId) ?? [])],
    allAttempts: () => [...attempts.entries()].flatMap(([intent_id, list]) => list.map((entry) => ({ intent_id, ...entry }))),
  };
}

const DEC = /^(0|[1-9][0-9]{0,19})$/;

function parseLine(text: string): Line | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (v.t === "settle" && typeof v.instance === "string" && typeof v.seq === "string" && DEC.test(v.seq) && Number.isInteger(v.key) && typeof v.digest === "object" && v.digest !== null && typeof v.at === "number") {
    const d = v.digest as Record<string, unknown>;
    if (typeof d.codec === "string" && d.purpose === "settle" && typeof d.hex === "string" && /^[0-9a-f]{64}$/.test(d.hex)) return v as unknown as Line;
  }
  if (v.t === "attempt" && typeof v.intent_id === "string" && typeof v.tx_id === "string" && /^[0-9A-F]{64}$/.test(v.tx_id) && typeof v.account === "string" && typeof v.sequence === "string" && typeof v.at === "number" && (v.expires_after_height === undefined || (typeof v.expires_after_height === "string" && DEC.test(v.expires_after_height)))) {
    return v as unknown as Line;
  }
  return null;
}

function journalOf(index: ReturnType<typeof indexer>, append: (line: Line) => Promise<void>, now: () => number): InspectableSigningJournal {
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task, task);
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
  return {
    reserveSettlement(entry) {
      return serial(async () => {
        if (!DEC.test(entry.seq)) throw new SigningJournalError(`seq ${entry.seq} is not canonical`);
        const existing = index.lookup(entry.instance, entry.seq, entry.signer_key_id);
        if (existing !== undefined) {
          const same = existing.digest.codec === entry.digest.codec && existing.digest.hex === entry.digest.hex;
          return same ? { kind: "same" as const } : { kind: "conflict" as const, digest_hex: existing.digest.hex };
        }
        const line: Line = { t: "settle", instance: entry.instance, seq: entry.seq, key: entry.signer_key_id, digest: { codec: entry.digest.codec, purpose: "settle", hex: entry.digest.hex }, at: now() };
        await append(line); // durable BEFORE the answer: the caller signs only after this resolves
        index.apply(line);
        return { kind: "reserved" as const };
      });
    },
    recordAttempt(entry) {
      return serial(async () => {
        if (index.attemptsOf(entry.intent_id).some((known) => known.tx_id === entry.tx_id)) return;
        const expires = entry.expires_after_height;
        if (expires !== undefined && !DEC.test(expires)) throw new SigningJournalError(`expiry height ${expires} is not canonical`);
        const line: Line = { t: "attempt", intent_id: entry.intent_id, tx_id: entry.tx_id, account: entry.account, sequence: entry.account_sequence, at: now(), ...(expires !== undefined ? { expires_after_height: expires } : {}) };
        await append(line);
        index.apply(line);
      });
    },
    async highestReserved(instance) {
      const seq = index.highest(instance);
      return seq === undefined ? null : { seq: seq.toString() };
    },
    reservations: (instance) => index.reservations(instance),
    attemptsOf: (intentId) => index.attemptsOf(intentId),
    allAttempts: () => index.allAttempts(),
  };
}

/** Tests: an in-memory journal (optionally failing the next append). */
export function createMemorySigningJournal(now: () => number = () => Date.now()): InspectableSigningJournal & { readonly lines: Line[]; readonly failNext: string[] } {
  const index = indexer();
  const lines: Line[] = [];
  const failNext: string[] = [];
  const journal = journalOf(
    index,
    async (line) => {
      const fault = failNext.shift();
      if (fault !== undefined) throw new SigningJournalError(fault);
      lines.push(line);
    },
    now,
  );
  return Object.assign(journal, { lines, failNext });
}

/** The local file adapter. Refuses to open a damaged journal (signing stops rather than guess). */
export async function openFileSigningJournal(directory: string, options: { now?: () => number; writerCheck?: () => Promise<boolean> } = {}): Promise<InspectableSigningJournal & { readonly file: string }> {
  const file = path.join(directory, JOURNAL_FILE);
  await fsp.mkdir(directory, { recursive: true });
  const index = indexer();
  let raw = "";
  try {
    raw = await fsp.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const complete = raw.lastIndexOf("\n") + 1;
  if (complete < raw.length) {
    /* A torn final line: a crash mid-append. It was never acknowledged, so nothing was signed after it: cut it. */
    const handle = await fsp.open(file, "r+");
    try {
      await handle.truncate(Buffer.byteLength(raw.slice(0, complete), "utf8"));
      await handle.sync();
    } finally {
      await handle.close();
    }
    raw = raw.slice(0, complete);
  }
  const lines = raw.split("\n").filter((line) => line.length > 0);
  lines.forEach((text, at) => {
    const line = parseLine(text);
    if (line === null) throw new SigningJournalError(`the signing journal ${file} is damaged at line ${at + 1}; signing stays stopped until an operator inspects it`);
    index.apply(line);
  });
  const append = async (line: Line) => {
    if (options.writerCheck !== undefined && !(await options.writerCheck().catch(() => false))) throw new SigningJournalError("this server no longer owns its data directory; nothing is journalled or signed");
    const handle = await fsp.open(file, "a");
    try {
      await handle.write(`${JSON.stringify(line)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
  };
  return Object.assign(journalOf(index, append, options.now ?? (() => Date.now())), { file });
}
