// server/src/persistence/conformance/subjects.ts
//
// ==================================================================
//  LIVE-5 L5-1: EVERY IMPLEMENTATION THE CONFORMANCE SUITES RUN TODAY, AS A SUBJECT
// ==================================================================
//
// One place for the memory, reference and file subjects, so the conformance test files and the F-L5-4 pins
// (`fenceGap.test.ts`) use the SAME hooks. A file subject reaches storage through the fault seam (`faultyStoreFs` over
// Node's own), and its hooks aim scripted faults at exactly the operation a case names:
//
//   stallNextWrite       the first file operation AFTER the store's `writerCheck` (a temporary's open, or the log's /
//                        journal's own open): F-L5-4's gap, where a DynamoDB adapter's condition would still refuse.
//   armLostAnswer        the commit point (a rename; a log's or journal's sync) completes, then fails: landed, answer lost.
//   armTransientFailure  the first operation fails before any byte is written.
//   armUnresolvedWrite   the attempt and its redo both fail after bytes may have landed.
//
// No test registers here. The DynamoDB-Local subject lives in `dynamoLocal.conformance.test.ts` (it needs a service).

import * as fs from "fs";
import * as path from "path";

import { createFileLogStore, nodeStoreFs } from "../../fileLogStore";
import { createFileHoldStore, createMemoryHoldStore, holdDirectory } from "../../rooms/holdStore";
import { createFileRecordStore, createMemoryRecordStore } from "../../rooms/recordStore";
import { createFileFinancialGameStore, createMemoryFinancialGameStore, financialDirectory } from "../../escrow/financialGameStore";
import { FINANCIAL_FORMAT } from "../../escrow/moneyLifecycle";
import { chainIntentDirectory, CHAIN_INTENT_FORMAT, createFileChainIntentStore, createMemoryChainIntentStore } from "../../escrow/chainIntents";
import { createMemoryWalletTicketStore } from "../../escrow/walletTickets";
import { createFileWalletTicketStore, walletTicketDirectory, WALLET_TICKET_FILE_FORMAT } from "../../escrow/walletTicketFileStore";
import { createFileIdentityStore, IDENTITY_FILE } from "../../identity/fileStore";
import { createJournalIdentityStore, IDENTITY_JOURNAL_FILE } from "../../identity/journalStore";
import { createMemoryIdentityStore } from "../../identity/store";
import { createMemoryGrantStore } from "../../identity/grants";
import { createMemorySecurityJournal } from "../../identity/securityEvents";
import { createMemorySigningJournal, JOURNAL_FILE, openFileSigningJournal } from "../../escrow/signingJournal";
import { faultyStoreFs, gate } from "./faults";
import { perCase, replaceHooks } from "./fileHooks";
import { gameRecord, grant } from "./fixtures";
import type { CaseContext } from "./harness";
import type { LogSubject } from "./logStore.conformance";
import type { HoldSubject, Planted, RecordSubject } from "./roomStores.conformance";
import type { FinancialSubject, IntentSubject, TicketSubject } from "./escrowStores.conformance";
import type { IdentitySubject, JournalSubject } from "./identityJournal.conformance";
import type { GrantSubject, SecuritySubject } from "./identitySecurity.conformance";
import { createReferenceLogStore, newReferenceLogBacking } from "./referenceLogStore";

const quiet = { warn: () => undefined };
const read = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file) : null);
const faultFs = (ctx: CaseContext) => faultyStoreFs(nodeStoreFs, ctx.faults);
const writer = (options?: { readonly writerCheck?: () => Promise<boolean> }) => (options?.writerCheck ? { writerCheck: options.writerCheck } : {});
const scriptOf = (ctx: CaseContext) => ctx.faults;

/** Hooks for a store that opens one file per key itself, positionally (the log, the identity journal, the signing journal). */
function ownFileHooks<K>(file: (ctx: CaseContext, key: K) => string) {
  const on = (ctx: CaseContext, key: K) => (at: string) => at === file(ctx, key);
  return {
    stallNextWrite(ctx: CaseContext, key: K) {
      const stall = gate();
      ctx.faults.add({ op: "open", where: on(ctx, key), action: { kind: "stall", gate: stall }, label: "the write stalls at its open" });
      return stall;
    },
    armLostAnswer(ctx: CaseContext, key: K) {
      ctx.faults.add({ op: "sync", where: on(ctx, key), action: { kind: "lose-answer" }, label: "the write is synced, its answer lost" });
    },
    armTransientFailure(ctx: CaseContext, key: K) {
      ctx.faults.add({ op: "open", where: on(ctx, key), action: { kind: "fail" }, label: "the file cannot be opened" });
    },
    armUnresolvedWrite(ctx: CaseContext, key: K) {
      ctx.faults.add({ op: "write", where: on(ctx, key), action: { kind: "partial", bytes: 17 }, label: "the write tears" });
      ctx.faults.add({ op: "open", where: on(ctx, key), nth: 2, action: { kind: "fail" }, label: "the redo cannot open the file" });
    },
  };
}

/* ================================================================== */
/*  Log                                                                */
/* ================================================================== */

const logBackingOf = perCase(newReferenceLogBacking);

/** The reference model: a backing map outlives each opened store (as a table outlives a task); its fence is evaluated at
 *  the apply itself, so it keeps the fence-inside-the-write contract a DynamoDB adapter must keep. */
export const referenceLogSubject: LogSubject = {
  name: "reference model (memory)",
  backend: "reference",
  capabilities: ["durable", "fence", "fence-in-write", "stall-write"],
  async open(ctx, options) {
    const mine = ctx.fence.epoch;
    return createReferenceLogStore(logBackingOf(ctx), options?.writerCheck ? { writerCheck: options.writerCheck, fenceHolds: () => ctx.fence.epoch === mine } : {});
  },
  async stored(ctx, room) {
    const log = logBackingOf(ctx).logs.get(room);
    return log === undefined ? null : log.join("\n");
  },
  stallNextWrite(ctx, room) {
    const stall = gate();
    logBackingOf(ctx).stalls.set(room, stall);
    return stall;
  },
};

const logFile = (ctx: CaseContext, room: string) => path.join(ctx.dir, `${room}.log.jsonl`);

export const fileLogSubject: LogSubject = {
  name: "file (fileLogStore)",
  backend: "file",
  capabilities: ["durable", "fence", "plant", "fs-faults", "stall-write", "ordered-under-stall", "torn-tail", "inject-lost-answer", "inject-transient-failure", "inject-unresolved"],
  async open(ctx, options) {
    return createFileLogStore(ctx.dir, { ...quiet, fs: faultFs(ctx), ...writer(options) });
  },
  async plant(ctx, room, bytes) {
    fs.writeFileSync(logFile(ctx, room), bytes);
  },
  async stored(ctx, room) {
    return read(logFile(ctx, room));
  },
  ...ownFileHooks(logFile),
  logPath: (ctx, room) => logFile(ctx, room),
};

/* ================================================================== */
/*  GameRecord + holds                                                 */
/* ================================================================== */

const recordFile = (ctx: CaseContext, gameId: string) => path.join(ctx.dir, "games", `${gameId}.json`);
const recordBytes = (gameId: string, what: Planted): string => {
  if (what === "corrupt") return '{"record_schema":1,"game_id":';
  return `${JSON.stringify({ ...gameRecord(1), game_id: gameId, record_schema: what === "newer" ? 3 : 0 })}\n`;
};

const memoryRecordsOf = perCase(createMemoryRecordStore);
export const memoryRecordSubject: RecordSubject = {
  name: "memory (createMemoryRecordStore)",
  backend: "memory",
  capabilities: ["validates-shape"],
  async open(ctx) {
    return memoryRecordsOf(ctx);
  },
  async stored(ctx, gameId) {
    const record = memoryRecordsOf(ctx).records.get(gameId);
    return record === undefined ? null : JSON.stringify(record);
  },
};

export const fileRecordSubject: RecordSubject = {
  name: "file (createFileRecordStore)",
  backend: "file",
  capabilities: ["durable", "fence", "plant", "fs-faults", "stall-write", "ordered-under-stall", "validates-shape", "inject-lost-answer", "inject-transient-failure"],
  async open(ctx, options) {
    return createFileRecordStore(ctx.dir, { ...quiet, fs: faultFs(ctx), ...writer(options) });
  },
  async plant(ctx, gameId, what) {
    fs.mkdirSync(path.join(ctx.dir, "games"), { recursive: true });
    fs.writeFileSync(recordFile(ctx, gameId), recordBytes(gameId, what));
  },
  async stored(ctx, gameId) {
    return read(recordFile(ctx, gameId));
  },
  ...replaceHooks(scriptOf, recordFile),
};

const holdFile = (ctx: CaseContext, gameId: string) => path.join(holdDirectory(ctx.dir), `${gameId}.json`);

const memoryHoldsOf = perCase(createMemoryHoldStore);
export const memoryHoldSubject: HoldSubject = {
  name: "memory (createMemoryHoldStore)",
  backend: "memory",
  capabilities: ["plant"],
  async open(ctx) {
    return memoryHoldsOf(ctx);
  },
  async stored(ctx, gameId) {
    const held = memoryHoldsOf(ctx).holds.get(gameId);
    return held === undefined ? null : JSON.stringify(held);
  },
  async releasedCopies(ctx, gameId) {
    return memoryHoldsOf(ctx).released.filter((entry) => entry.game_id === gameId).length;
  },
  async plant(ctx, gameId) {
    memoryHoldsOf(ctx).holds.set(gameId, "unreadable");
  },
};

export const fileHoldSubject: HoldSubject = {
  name: "file (createFileHoldStore)",
  backend: "file",
  capabilities: ["durable", "fence", "plant", "fs-faults", "stall-write", "validates-shape", "inject-lost-answer", "inject-transient-failure"],
  async open(ctx, options) {
    return createFileHoldStore(ctx.dir, { ...quiet, fs: faultFs(ctx), ...writer(options) });
  },
  async plant(ctx, gameId) {
    fs.mkdirSync(holdDirectory(ctx.dir), { recursive: true });
    fs.writeFileSync(holdFile(ctx, gameId), '{"format":"gs-game-hold",');
  },
  async stored(ctx, gameId) {
    return read(holdFile(ctx, gameId));
  },
  async releasedCopies(ctx, gameId) {
    const released = path.join(holdDirectory(ctx.dir), "released");
    return fs.existsSync(released) ? fs.readdirSync(released).filter((name) => name.startsWith(`${gameId}.`)).length : 0;
  },
  holdPath: (ctx, gameId) => holdFile(ctx, gameId),
  ...replaceHooks(scriptOf, holdFile),
};

/* ================================================================== */
/*  Financial record, chain intents, wallet tickets                    */
/* ================================================================== */

export const financialBytes = (gameId: string, what: Planted): string =>
  what === "corrupt" ? `{"format":"${FINANCIAL_FORMAT}","version":` : JSON.stringify({ format: FINANCIAL_FORMAT, version: what === "newer" ? 99 : 1, game_id: gameId });

const memoryFinancialOf = perCase(createMemoryFinancialGameStore);
export const memoryFinancialSubject: FinancialSubject = {
  name: "memory (createMemoryFinancialGameStore)",
  backend: "memory",
  capabilities: ["plant", "inject-transient-failure", "validates-shape"],
  async open(ctx) {
    return memoryFinancialOf(ctx);
  },
  async stored(ctx, gameId) {
    const record = memoryFinancialOf(ctx).records.get(gameId);
    return record === undefined ? null : JSON.stringify(record);
  },
  async plant(ctx, gameId, what) {
    memoryFinancialOf(ctx).records.set(gameId, what === "corrupt" ? "unreadable" : what === "newer" ? "newer" : "older-unread");
  },
  armTransientFailure(ctx) {
    memoryFinancialOf(ctx).failNext.push("definite");
  },
};

const finFile = (ctx: CaseContext, gameId: string) => path.join(financialDirectory(ctx.dir), `${gameId}.json`);
export const fileFinancialSubject: FinancialSubject = {
  name: "file (createFileFinancialGameStore)",
  backend: "file",
  capabilities: ["durable", "fence", "plant", "fs-faults", "stall-write", "ordered-under-stall", "inject-lost-answer", "inject-transient-failure", "validates-shape"],
  async open(ctx, options) {
    return createFileFinancialGameStore(ctx.dir, { ...quiet, fs: faultFs(ctx), ...writer(options) });
  },
  async plant(ctx, gameId, what) {
    fs.mkdirSync(financialDirectory(ctx.dir), { recursive: true });
    fs.writeFileSync(finFile(ctx, gameId), financialBytes(gameId, what));
  },
  async stored(ctx, gameId) {
    return read(finFile(ctx, gameId));
  },
  ...replaceHooks(scriptOf, finFile),
};

const memoryIntentsOf = perCase(createMemoryChainIntentStore);
export const memoryIntentSubject: IntentSubject = {
  name: "memory (createMemoryChainIntentStore)",
  backend: "memory",
  capabilities: ["plant", "validates-shape"],
  async open(ctx) {
    return memoryIntentsOf(ctx);
  },
  async stored(ctx, key) {
    const record = memoryIntentsOf(ctx).records.get(key);
    return record === undefined ? null : JSON.stringify(record);
  },
  async plant(ctx, gameId, intentId, what) {
    memoryIntentsOf(ctx).records.set(`${gameId}/${intentId}`, what === "corrupt" ? "unreadable" : what === "newer" ? "newer" : "older-unread");
  },
};

/** `key` is `<game>/<intent>`. */
const intentFile = (ctx: CaseContext, key: string) => {
  const [gameId, intentId] = key.split("/");
  return path.join(chainIntentDirectory(ctx.dir), gameId, `${intentId}.json`);
};
export const fileIntentSubject: IntentSubject = {
  name: "file (createFileChainIntentStore)",
  backend: "file",
  capabilities: ["durable", "fence", "plant", "fs-faults", "stall-write", "inject-lost-answer", "inject-transient-failure", "validates-shape"],
  differences: { "INT-07-older": "CHAIN_INTENT_SCHEMA is 1, the first schema: no older intent file can exist to plant (the memory marker still exercises the class)" },
  async open(ctx, options) {
    return createFileChainIntentStore(ctx.dir, { ...quiet, fs: faultFs(ctx), ...writer(options) });
  },
  async plant(ctx, gameId, intentId, what) {
    fs.mkdirSync(path.join(chainIntentDirectory(ctx.dir), gameId), { recursive: true });
    const text = what === "corrupt" ? `{"format":"${CHAIN_INTENT_FORMAT}",` : JSON.stringify({ format: CHAIN_INTENT_FORMAT, schema: 9, game_id: gameId, intent_id: intentId });
    fs.writeFileSync(intentFile(ctx, `${gameId}/${intentId}`), text);
  },
  async stored(ctx, key) {
    return read(intentFile(ctx, key));
  },
  ...replaceHooks(scriptOf, intentFile),
};

const memoryTicketsOf = perCase(createMemoryWalletTicketStore);
export const memoryTicketSubject: TicketSubject = {
  name: "memory (createMemoryWalletTicketStore)",
  backend: "memory",
  capabilities: [],
  async open(ctx) {
    return memoryTicketsOf(ctx);
  },
  async stored(ctx, gameId) {
    const stored = memoryTicketsOf(ctx).games.get(gameId);
    return stored === undefined ? null : JSON.stringify(stored);
  },
};

const ticketFile = (ctx: CaseContext, gameId: string) => path.join(walletTicketDirectory(ctx.dir), `${gameId}.json`);
export const fileTicketSubject: TicketSubject = {
  name: "file (createFileWalletTicketStore)",
  backend: "file",
  capabilities: ["durable", "fence", "plant", "fs-faults", "stall-write", "validates-shape", "inject-lost-answer", "inject-transient-failure", "inject-unresolved"],
  async open(ctx, options) {
    return createFileWalletTicketStore(ctx.dir, { ...quiet, fs: faultFs(ctx), ...writer(options) });
  },
  async plant(ctx, gameId, what) {
    fs.mkdirSync(walletTicketDirectory(ctx.dir), { recursive: true });
    if (what === "corrupt") {
      fs.writeFileSync(ticketFile(ctx, gameId), `{"format":"${WALLET_TICKET_FILE_FORMAT}",`);
      return;
    }
    /* A financial-protocol-2 ledger: ESCROW-JOIN's grant shape (no proof, consent keys, relink or floor). */
    const { proof: _p, consent_keys: _c, relinked_from: _r, create_floor: _f, ...protocol2 } = grant(1, 1, 1);
    fs.writeFileSync(ticketFile(ctx, gameId), JSON.stringify({ format: WALLET_TICKET_FILE_FORMAT, version: 1, game_id: gameId, document: { frozen_at: null, grants: [{ ...protocol2, game_id: gameId }] } }));
  },
  async stored(ctx, gameId) {
    return read(ticketFile(ctx, gameId));
  },
  ...replaceHooks(scriptOf, ticketFile),
};

/* ================================================================== */
/*  Identity                                                           */
/* ================================================================== */

const memoryIdentityOf = perCase(() => createMemoryIdentityStore());
export const memoryIdentitySubject: IdentitySubject = {
  name: "memory (createMemoryIdentityStore)",
  backend: "memory",
  capabilities: ["validates-shape"],
  async open(ctx) {
    return memoryIdentityOf(ctx);
  },
  async stored(ctx) {
    return JSON.stringify(memoryIdentityOf(ctx).snapshot());
  },
};

const identityFiles = (ctx: CaseContext) => Buffer.concat([read(path.join(ctx.dir, IDENTITY_FILE)) ?? Buffer.alloc(0), Buffer.from("\n--journal--\n"), read(path.join(ctx.dir, IDENTITY_JOURNAL_FILE)) ?? Buffer.alloc(0)]);
const identityJournalFile = (ctx: CaseContext) => path.join(ctx.dir, IDENTITY_JOURNAL_FILE);
const identityJournalHooks = ownFileHooks<void>((ctx) => identityJournalFile(ctx));

export const journalIdentitySubject: IdentitySubject = {
  name: "journal (createJournalIdentityStore, production)",
  backend: "file",
  capabilities: ["durable", "fence", "plant", "fs-faults", "stall-write", "validates-shape", "inject-lost-answer", "inject-transient-failure", "inject-unresolved"],
  async open(ctx, options) {
    return createJournalIdentityStore(ctx.dir, { ...quiet, fs: faultFs(ctx), ...writer(options) });
  },
  async stored(ctx) {
    return identityFiles(ctx);
  },
  /* Damage in the middle of the journal: a valid line follows it (not a torn tail). */
  async plant(ctx) {
    const file = identityJournalFile(ctx);
    const lines = fs.readFileSync(file, "utf8").split("\n").filter((line) => line !== "");
    fs.writeFileSync(file, `${[...lines.slice(0, -1), '{"seq":', lines[lines.length - 1]].join("\n")}\n`);
  },
  stallNextWrite: (ctx) => identityJournalHooks.stallNextWrite(ctx),
  armLostAnswer: (ctx) => identityJournalHooks.armLostAnswer(ctx),
  armTransientFailure: (ctx) => identityJournalHooks.armTransientFailure(ctx),
  /* LIVE-5 L5-4 (ID-18): the append tears and its redo cannot even open the file -- the store holds itself. */
  armUnresolvedWrite: (ctx) => identityJournalHooks.armUnresolvedWrite(ctx),
};

/* The LIVE-2E whole-file writer. NOT A PRODUCTION STORE: `start.ts` opens the journal store, which only READS this
   format to migrate it (`migrateIdentityDocument`). Kept in the matrix so its differences stay visible: it predates
   ESCROW-3A's session families (it writes format v2 and derives "legacy" families on every load), so a family's
   revocation does not survive its restart -- which is why it must never be wired into a server. */
export const wholeFileIdentitySubject: IdentitySubject = {
  name: "whole file (createFileIdentityStore; legacy v2, test-only)",
  backend: "file",
  capabilities: ["durable", "fence", "plant", "fs-faults", "validates-shape"],
  exemptions: {
    "stall-write": "legacy test-only writer: not a LIVE-5 input; its fault behaviour is LIVE-3B's durable replacement, covered through the GameRecord store",
    "inject-lost-answer": "as above",
    "inject-transient-failure": "as above",
  },
  differences: {
    "ID-02": "legacy v2 format: session families are not stored; every load derives an 'origin: legacy' family",
    "ID-04": "legacy v2 format: a family's revocation is not stored, so the revoked-family term cannot be exercised after its write",
    "ID-07": "legacy v2 format: a family's revocation is not stored, so it does not survive a restart (never a production store)",
    "ID-15": "legacy v2 format: a family's revocation is not stored, so the whole-family sign-out cannot be read back (never a production store)",
    "ID-08": "legacy writer: a relation failure escapes as IdentityStoreCorruptError (read as an unknown outcome), not StoreDefiniteError",
  },
  async open(ctx, options) {
    return createFileIdentityStore(ctx.dir, { ...quiet, fs: faultFs(ctx), ...writer(options) });
  },
  async stored(ctx) {
    return read(path.join(ctx.dir, IDENTITY_FILE));
  },
  async plant(ctx) {
    fs.writeFileSync(path.join(ctx.dir, IDENTITY_FILE), '{"version":');
  },
};

/* ================================================================== */
/*  LIVE-5 L5-4: sensitive-auth grants and the security-event journal   */
/*  (memory: the reference models; the DynamoDB subjects need a service */
/*  and live in identityDynamoLocal.conformance.test.ts)                 */
/* ================================================================== */

const memoryGrantsOf = perCase(createMemoryGrantStore);
export const memoryGrantSubject: GrantSubject = {
  name: "memory (createMemoryGrantStore)",
  backend: "memory",
  capabilities: ["validates-shape", "inject-transient-failure"],
  async open(ctx) {
    return memoryGrantsOf(ctx);
  },
  async stored(ctx) {
    return JSON.stringify(memoryGrantsOf(ctx).snapshot());
  },
  armTransientFailure(ctx) {
    memoryGrantsOf(ctx).failNext.push("definite");
  },
};

const memorySecurityOf = perCase(createMemorySecurityJournal);
export const memorySecuritySubject: SecuritySubject = {
  name: "memory (createMemorySecurityJournal)",
  backend: "memory",
  capabilities: ["validates-shape", "inject-transient-failure", "plant"],
  async open(ctx) {
    return memorySecurityOf(ctx);
  },
  async stored(ctx) {
    return JSON.stringify(memorySecurityOf(ctx).snapshot());
  },
  armTransientFailure(ctx) {
    memorySecurityOf(ctx).failNext.push("definite");
  },
  async plant(ctx, event) {
    const journal = memorySecurityOf(ctx);
    const key = [...journal.bodies.keys()].find((stored) => stored.startsWith(`${event.principal_id}|`) && stored.endsWith(event.event_id));
    if (key === undefined) throw new Error("plant: no such event");
    journal.bodies.set(key, (journal.bodies.get(key) as string).replace('"version":1', '"version":2'));
  },
};

/* ================================================================== */
/*  Signing journal                                                    */
/* ================================================================== */

const memoryJournalOf = new WeakMap<object, ReturnType<typeof createMemorySigningJournal>>();
const memoryJournal = (ctx: CaseContext) => {
  let journal = memoryJournalOf.get(ctx);
  if (journal === undefined) {
    journal = createMemorySigningJournal(() => ctx.now());
    memoryJournalOf.set(ctx, journal);
  }
  return journal;
};

export const memoryJournalSubject: JournalSubject = {
  name: "memory (createMemorySigningJournal)",
  backend: "memory",
  capabilities: ["inject-transient-failure"],
  async open(ctx) {
    return memoryJournal(ctx);
  },
  async stored(ctx) {
    return JSON.stringify(memoryJournal(ctx).lines);
  },
  armTransientFailure(ctx) {
    memoryJournal(ctx).failNext.push("injected append failure");
  },
};

const signingJournalFile = (ctx: CaseContext) => path.join(ctx.dir, "journal", JOURNAL_FILE);
const signingJournalHooks = ownFileHooks<void>((ctx) => signingJournalFile(ctx));
export const fileJournalSubject: JournalSubject = {
  name: "file (openFileSigningJournal)",
  backend: "file",
  capabilities: ["durable", "fence", "plant", "fs-faults", "stall-write", "inject-transient-failure", "inject-lost-answer"],
  async open(ctx, options) {
    return openFileSigningJournal(path.join(ctx.dir, "journal"), { now: () => ctx.now(), fs: faultFs(ctx), ...quiet, ...writer(options) });
  },
  async stored(ctx) {
    return read(signingJournalFile(ctx));
  },
  async plant(ctx, bytes) {
    fs.mkdirSync(path.dirname(signingJournalFile(ctx)), { recursive: true });
    fs.writeFileSync(signingJournalFile(ctx), bytes);
  },
  stallNextWrite: (ctx) => signingJournalHooks.stallNextWrite(ctx),
  armLostAnswer: (ctx) => signingJournalHooks.armLostAnswer(ctx),
  armTransientFailure: (ctx) => signingJournalHooks.armTransientFailure(ctx),
  stallAtByteWrite(ctx) {
    const stall = gate();
    ctx.faults.add({ op: "write", where: (at) => at === signingJournalFile(ctx), action: { kind: "stall", gate: stall }, label: "the append stalls at its byte write" });
    return stall;
  },
};
