// server/src/tools/gamesDoctor.ts
//
// ==================================================================
//  LIVE-3C: THE OPERATOR'S TOOL FOR A DATA DIRECTORY'S GAMES -- inspect, status, release, gc
// ==================================================================
//
// No dashboard, no admin transport (LIVE-6 / later): a CLI that reads the same files the server reads, with the same
// code, and that CHANGES anything only while it holds the data directory's lock itself -- so no server can start
// beside it, and it can never race a live writer.
//
//   status               print `ops/status.json`: what the RUNNING server says about its games (safe at any time)
//   inspect [--deep]     OFFLINE (refused while a server holds the directory): every game classified from its files
//                        -- discovery's cheap pass, or with --deep the full load: the whole log scanned, replayed and
//                        reconciled -- plus the identity store's health (snapshot and journal, read-only)
//   release <game_id> --note "<why it is safe now>"
//                        OFFLINE, LOCK HELD: lift one durable hold -- only after the game VERIFIES from its files as
//                        the full load would load it (a clean or torn-only log, a replay under this engine, the
//                        reconciliation table passing, its join code held by no other live record). The hold is moved
//                        to `holds/released/` with the verification and the note; an audit line is appended. There is
//                        no force: a game that does not verify stays held, and the tool says why.
//   gc [--apply]         OFFLINE, LOCK HELD with --apply (a dry run otherwise): the conservative lifecycle below.
//   reconcile-duplicate-code <game_a> <game_b> [--keep <game_id>] --note "<why>"
//                        ESCROW-3A (LIVE-2F/3D C4-02), OFFLINE, LOCK HELD: two games held `duplicate-join-code` can never be
//                        released by `release` (each verification finds the other). This verifies BOTH games' authoritative
//                        history exactly as `release` does (the duplicate aside), then makes the one METADATA change the
//                        conflict needs -- the join code is kept by one record and cleared (compare-and-swap, record_version
//                        + 1) from the other -- and releases both holds through the ordinary verified release. It decides
//                        alone only when the answer is unambiguous (exactly one of the two is still WAITING: it keeps the
//                        code a dealt game no longer needs); otherwise `--keep` must say which. No log is read for writing,
//                        no gameplay entry and no seat changes, and it refuses if anything does not verify.
//   money [<game_id>] [--json] [--escrow-config <file>] [--chain]
//                        ESCROW-3A/3B, READ-ONLY: the money games' lifecycle records (`games/money/`) -- and, since
//                        ESCROW-3B, each game's continuation identity, its chain binding (chain, contract, code checksum,
//                        denom, chain game), its frozen roster, what the chain confirmed (start, checkpoints, settle,
//                        outcome) and every chain intent (`games/chain-intents/`) with its evidence in words: not
//                        attempted / attempted, outcome unknown / known failed / confirmed / held -- phase, the terminal
//                        seal, the prepared evidence's hashes, a hold. No identity id is stored there or printed.
//                        LIVE-4 (L4-4): each game's CANONICAL continuation verdict against this build and the escrow
//                        deployment `--escrow-config` (or ESCROW_JUNO_CONFIG) serves -- continued, deployment
//                        unavailable / unverified, financial-protocol, newer / older format, malformed, conflict, ... --
//                        the classes of its financial record, ticket ledger and intents, and whether this configuration
//                        owns it. A money GameRecord whose financial record is missing is listed too. `--chain` also
//                        reads the configured deployment's facts at verification grade (so a deployment CONFLICT can be
//                        concluded); without it none is. Writes nothing, holds nothing.
//   money-release <game_id> --note "<why>" [--escrow-config <file>] [--chain]
//                        ESCROW-3A, OFFLINE, LOCK HELD: lift a HELD money game back to the phase it was held from -- only
//                        after the game verifies (as `release`), this deployment CONTINUES it (L4-4: the canonical
//                        verdict, its escrow served by the configuration given; a deployment-conflict hold only against a
//                        `--chain` read that agrees), and, when it is sealed, the settlement evidence re-derives from its
//                        sealed prefix. Audited; history is never edited.
//   wallet-grants <game_id> [--json]
//                        JX-3B, READ-ONLY (no lock, writes nothing, safe beside a running server): one game's wallet
//                        grants (`walletGrants.ts`) -- seat, epoch, wallet, proof (kind, public key, challenge_digest,
//                        proof_hash, verified_at), standing as the server judges it, revoke reason, freeze -- with every
//                        security context as a stable fingerprint and its verdict (current / ended). No session id,
//                        selector, cookie or raw principal/family id is printed. `gamesDoctor aws wallet-grants` is the
//                        same view over DynamoDB.
//   aws money <game_id> [--chain] [--json] [--tx-bytes <intent_id> [--attempt <n> | --tx-hash <HASH>]] --aws-config <arn>
//                        JX-4B, READ-ONLY: one AWS money game's evidence for a live JX-4 run -- FIN (phase, version, hold,
//                        binding, the complete roster hash and expected domain, every roster seat), the JX-3B wallet grants,
//                        every chain intent with EVERY attempt, the relayer's RELAYQ# membership and the signing journal's
//                        ATTI# / TXID# correlation, judged as explicit verdicts (JOURNAL MATCH / MISMATCH, ...); --chain adds
//                        read-only Juno queries of the bound deployment (ROSTER MATCH, CHAIN BINDING MATCH); --tx-bytes
//                        exports one attempt's exact stored TxRaw for `frontend/scripts/jx2VerifyTx.js`. Refuses --apply.
//                        File mode's `money` keeps its own (lifecycle) shape -- see `aws/operator/moneyEvidence.ts`.
//   aws <command> ...    LIVE-6 L6-3: the AWS storage mode's operator surface (`aws/operator/operatorMain.ts`): read-only
//                        inspection of the DynamoDB deployment (routing, APPGEN, pools, roles, a game's owner) and the
//                        controlled mutations (the routing CAS; an operator run's claim / take / release of a game), each a
//                        dry run unless --apply. Must be the FIRST word; loaded only then (file mode loads no AWS code).
//   scan-v10 [--json]    DA-8, READ-ONLY (takes no lock, writes nothing, safe beside a running server): every stored log --
//                        live and archived, server-owned and legacy JUNO-XXX -- classified by its rules-engine pin, and each
//                        v10 game's committed entries checked for the ones rules engine 11 reads differently
//                        (`frontend/src/utils/rulesBoundaryScan.ts`). A v11 server holds a v10 game; this says what it holds.
//
// WHAT GC DOES, AND WHAT IT NEVER DOES (brief §10):
//   retained live   every waiting, active, completed, cancelled, expired, held, incompatible or read-only game; every
//                   game archived fewer than 90 days ago; every money game (`retentionOf`); the identity store; the
//                   audit trail; every legacy `JUNO-XXX` file (the development corpus reads them); anything unrecognised
//   archived        a no-money game archived at least 90 days ago (`archived_at`, set by the server's sweep) is MOVED --
//                   record first (so the server can never find a record whose log has gone), then log, chat and
//                   released holds -- into `archive/<game_id>/`, each file hashed before and after, with a manifest
//                   (files, sizes, SHA-256, the log's entry count and logHash). Moved by rename; nothing is copied or
//                   deleted. A move interrupted by a crash is resumed by the next run.
//   deleted         ONLY transient files nothing can refer to: the temporaries of an interrupted durable replacement
//                   (`*.<pid>.<hex>.tmp`, while the lock is held no writer exists) and data-directory lock asides older
//                   than ten minutes (`LOCK.stale.*`). Never a log, a record, a hold, a chat, an archive or the audit.
//   eligible for deletion under a future policy: reported, never acted on (none exists in LIVE-3C).

import { createHash } from "crypto";
import { promises as fs } from "fs";
import * as path from "path";

import { logHash } from "../../../frontend/src/gameEngine";
import { RULES_ENGINE_VERSION } from "../../../frontend/src/gameEngine/rulesVersion";
import type { ServerLogEntry } from "../../../frontend/src/utils/roomSession";
import { createFileLogStore, nodeStoreFs, readFileChunked } from "../fileLogStore";
import { IDENTITY_FILE } from "../identity/fileStore";
import { IDENTITY_JOURNAL_FILE, parseSnapshotDocument, scanJournal } from "../identity/journalStore";
import { checkSnapshot, IdentityIndex } from "../identity/store";
import { scanLog } from "../persistence/logFormat";
import { dealIdentityOnDisk, logFormatOnDisk } from "../escrow/dealIdentity";
import { durableReplace } from "../persistence/durableReplace";
import { createFileOpsRecorder, OPS_DIRECTORY, STATUS_FILE, type OpsRecorder } from "../persistence/opsRecorder";
import { acquireDataLock, describeOwner, lockStatus, LOCK_DIRECTORY, type DataLock } from "../persistence/processLock";
import { isStoreCorrupt, isStoreIncompatible } from "../persistence/storeResult";
import { countByClass, discoverGames, type DiscoveredGame } from "../rooms/discovery";
import { effectiveStatus, GAME_ID_PATTERN, type GameRecord } from "../rooms/gameRecord";
import { createFileHoldStore, holdDirectory } from "../rooms/holdStore";
import { movableAt, NO_MONEY_SETTLEMENT, type GameClass } from "../rooms/lifecycle";
import { createFileRecordStore } from "../rooms/recordStore";
import { reconcileLoaded, type Verdict } from "../rooms/reconcile";
import { factsFromEntries, sessionBoardFacts } from "../rooms/roomHost";
import { verifySession } from "./verifySession";
import { createFileFinancialGameStore, FinancialRecordUnreadableError } from "../escrow/financialGameStore";
import { transitionFinancial, type FinancialGameRecord } from "../escrow/moneyLifecycle";
import { createFileChainIntentStore, type ChainIntentRecord } from "../escrow/chainIntents";
import { createFileWalletTicketStore } from "../escrow/walletTicketFileStore";
import { classifiesArtifacts, createMoneyServing, moneyTermsKey, noMoneyServing, servingCapability, type ArtifactClasses, type MoneyServing, type MoneyServingDecision } from "../escrow/moneyServing";
import { readVerifiedChainFacts, type ChainFactsRead } from "../escrow/juno/chainFacts";
import { parseJunoBackendConfig, pinOf } from "../escrow/juno/junoConfig";
import { createJunoRest } from "../escrow/juno/junoRest";
import { createContinuationWiring, type ContinuationWiring } from "../continuationWiring";
import { compatibilityDescriptorText, operatorDescriptor, type CompatibilityDescriptor } from "../compatibilityDescriptor";
import { createSettlementCoordinator, type SettlementCoordinator } from "../escrow/settlementCoordinator";
import { listOrEmpty, readOnlyStoreFs } from "./readOnlyFs";
import { collectWalletGrants, readFileIdentitySnapshot, walletGrantsText } from "./walletGrants";
import type { GameIdentityFacts } from "../../../frontend/src/gameEngine/compat/continuationIdentity";
import type { ContinuationVerdict, FormatFact } from "../../../frontend/src/gameEngine/compat/continuationVerdict";
import { isGameMoneyTerms } from "../rooms/gameRecord";
import { prepareTerminalEvidence, serverPrefixReplay } from "../escrow/settlementEvidence";
import {
  BOUNDARY_SCAN_VERSION,
  scanPinnedHistory,
  summarizeBoundaryScan,
  type BoundaryScanSummary,
  type GameBoundaryScan,
} from "../../../frontend/src/utils/rulesBoundaryScan";

export const TOOL_BUILD = "gamesDoctor";

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const quiet = () => undefined;
/** LIVE-4 (L4-6): every store an inspection opens reads through this -- writes refused, no directory made. */
const READ_ONLY = readOnlyStoreFs();

async function readOptional(file: string): Promise<Buffer | null> {
  try {
    return await readFileChunked(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/* ==================================================================
    THE FULL VERIFICATION (the load, offline): shared by `inspect --deep` and `release`
   ================================================================== */

export interface GameVerification {
  readonly gameId: string;
  /** What the full load would make of this game, the durable hold aside. */
  readonly cls: GameClass;
  readonly ok: boolean;
  readonly reason: string;
  readonly verdict: Verdict | null;
  readonly entries: number;
  readonly logHash: string | null;
  readonly logClassification: "absent" | "clean" | "torn-tail" | "corrupt" | "newer-format";
}

export async function verifyGame(dataDir: string, gameId: string, options: { build?: string; ignoreDuplicateCodeWith?: string } = {}): Promise<GameVerification> {
  const fail = (cls: GameClass, reason: string, extra: Partial<GameVerification> = {}): GameVerification => ({
    gameId,
    cls,
    ok: false,
    reason,
    verdict: null,
    entries: 0,
    logHash: null,
    logClassification: "absent",
    ...extra,
  });
  if (!GAME_ID_PATTERN.test(gameId)) return fail("attention", "that is not a game id");
  let record: GameRecord | null;
  try {
    record = await createFileRecordStore(dataDir, { warn: quiet, fs: READ_ONLY }).load(gameId);
  } catch (error) {
    if (isStoreIncompatible(error)) return fail("incompatible", `the record is from a newer build: ${describe(error)}`);
    if (isStoreCorrupt(error)) return fail("held", `the record cannot be read: ${describe(error)}`);
    throw error;
  }
  if (record === null) return fail("attention", "there is no game record");
  const bytes = await readOptional(path.join(dataDir, `${gameId}.log.jsonl`));
  let entries: ServerLogEntry[] = [];
  let logClassification: GameVerification["logClassification"] = "absent";
  if (bytes !== null) {
    const scan = scanLog(bytes);
    logClassification = scan.classification;
    if (scan.classification === "corrupt") return fail("held", `the log is corrupt: ${scan.detail}`, { logClassification });
    /* LIVE-4 (N-3): a newer build's log is not damage and not this build's to replay: incompatible, untouched. */
    if (scan.classification === "newer-format") return fail("incompatible", `the log is a newer build's format: ${scan.detail}`, { logClassification });
    entries = scan.entries; // a torn tail is what the load truncates; the complete batches are the history
  }
  const hash = entries.length === 0 ? null : logHash(entries);
  const replay = verifySession(entries, options.build ?? TOOL_BUILD);
  if (!replay.ok) return fail("held", `the log does not replay: ${replay.reason}`, { entries: entries.length, logHash: hash, logClassification });
  const board = replay.incompatible ? null : sessionBoardFacts(replay.session);
  const verdict = reconcileLoaded(record, { entries, board });
  if (verdict.kind === "hold") {
    return { gameId, cls: "held", ok: false, reason: `${verdict.code}: ${verdict.detail}`, verdict, entries: entries.length, logHash: hash, logClassification };
  }
  /* A join code another live record also holds (§14.4 item 8). */
  if (record.join_code !== null && record.archived_at === null) {
    const records = createFileRecordStore(dataDir, { warn: quiet, fs: READ_ONLY });
    for (const other of await listOrEmpty(() => records.list())) {
      if (other === gameId || other === options.ignoreDuplicateCodeWith) continue;
      const peer = await records.load(other).catch(() => null);
      if (peer !== null && peer.join_code === record.join_code && peer.archived_at === null && peer.status !== "cancelled" && peer.status !== "expired") {
        return { gameId, cls: "held", ok: false, reason: `duplicate-join-code: ${other} holds ${record.join_code} too`, verdict, entries: entries.length, logHash: hash, logClassification };
      }
    }
  }
  /* Deep verification IS the load's reconciliation, offline: the class is what the LOG implies (a record that only
     lags is what the load will repair), never the record's own claim. */
  const cls: GameClass = replay.incompatible
    ? "incompatible"
    : record.archived_at !== null
      ? "archived"
      : effectiveStatus(record, factsFromEntries(entries, board?.ended ?? false, board?.closed ?? false), Date.now());
  return {
    gameId,
    cls,
    ok: true,
    reason: verdict.kind === "repair" ? `verifies; the load will repair the record from its log (${verdict.fields.join(", ")})` : "verifies",
    verdict,
    entries: entries.length,
    logHash: hash,
    logClassification,
  };
}

/* ==================================================================
    INSPECT
   ================================================================== */

export interface IdentityInspection {
  readonly ok: boolean;
  readonly detail: string;
  readonly snapshotVersion: number | null;
  readonly snapshotSeq: number | null;
  readonly journal: { readonly records: number; readonly bytes: number; readonly classification: string; readonly skipped: number } | null;
  readonly counts: { principals: number; sessions: number; profiles: number; links: number } | null;
}

/** The identity store, READ-ONLY: the snapshot, the journal scanned and applied in memory, the whole set validated. */
export async function inspectIdentity(dataDir: string): Promise<IdentityInspection> {
  try {
    const raw = await readOptional(path.join(dataDir, IDENTITY_FILE));
    const journal = await readOptional(path.join(dataDir, IDENTITY_JOURNAL_FILE));
    if (raw === null) {
      return {
        ok: journal === null || journal.length === 0,
        detail: journal === null || journal.length === 0 ? "no identity store yet" : "a journal with no snapshot (the server refuses to start)",
        snapshotVersion: null,
        snapshotSeq: null,
        journal: journal === null ? null : { records: 0, bytes: journal.length, classification: "orphan", skipped: 0 },
        counts: null,
      };
    }
    const parsed = parseSnapshotDocument(JSON.parse(raw.toString("utf8")), IDENTITY_FILE);
    const scan = scanJournal(journal ?? Buffer.alloc(0), parsed.seq);
    const index = IdentityIndex.from(parsed.snapshot);
    for (const { seq, change } of scan.changes) {
      const problem = index.check(change, `journal seq ${seq}`);
      if (problem !== null) throw new Error(problem);
      index.apply(change);
    }
    checkSnapshot(index.snapshot(), "identity (inspected)");
    const healthy = scan.classification !== "corrupt";
    return {
      ok: healthy,
      detail:
        scan.classification === "clean"
          ? "valid"
          : scan.classification === "torn"
            ? `valid; the next start truncates a torn final change (${scan.detail})`
            : `CORRUPT journal: ${scan.detail} (the server refuses to start)`,
      snapshotVersion: parsed.version,
      snapshotSeq: parsed.seq,
      journal: journal === null ? null : { records: scan.changes.length + scan.skipped, bytes: journal.length, classification: scan.classification, skipped: scan.skipped },
      counts: index.sizes(),
    };
  } catch (error) {
    return { ok: false, detail: `UNREADABLE: ${describe(error)} (the server refuses to start)`, snapshotVersion: null, snapshotSeq: null, journal: null, counts: null };
  }
}

export interface Inspection {
  readonly games: ReadonlyArray<{ gameId: string; cls: GameClass; code: string | null; detail: string | null; logBytes: number; deep?: GameVerification }>;
  readonly byClass: Record<GameClass, number>;
  readonly storeErrors: readonly string[];
  readonly identity: IdentityInspection;
  readonly legacyFiles: number;
}

/** Every game classified from its files (read-only: no hold is written, no index repaired, nothing truncated -- every
 *  store reads through `READ_ONLY`). LIVE-4 (L4-6): discovery is given the POOL'S gameplay verdict exactly as the room
 *  host gives it (`continuation.gameplayVerdictOf` and the capability's `rules.supported`), over the configuration the
 *  operator names (`serving`; default: this build serving no escrow) -- never a local approximation. */
export async function inspectData(dataDir: string, options: { deep?: boolean; now?: number; serving?: MoneyServing } = {}): Promise<Inspection> {
  const now = options.now ?? Date.now();
  const records = createFileRecordStore(dataDir, { warn: quiet, fs: READ_ONLY });
  const wiring = toolWiring(options.serving ?? noMoneyServing(), NO_TOOL_MONEY_FACTS, () => null, now);
  /* Discovery's own pass, with every write turned into a no-op: a hold is reported, never written. */
  const report = await discoverGames({
    records: { ...records, reconcileIndex: undefined, list: () => listOrEmpty(() => records.list()), load: (id) => records.load(id) },
    logs: createFileLogStore(dataDir, { warn: quiet, fs: READ_ONLY }),
    holds: readOnlyHolds(dataDir),
    build: TOOL_BUILD,
    rulesEngineVersion: RULES_ENGINE_VERSION,
    gameplayVerdict: wiring.gameplayVerdictOf,
    rulesSupported: wiring.capability.rules.supported,
    now: () => now,
    warn: quiet,
    ops: { audit: quiet, status: quiet, flush: async () => undefined },
  });
  const games: Array<Inspection["games"][number]> = [];
  for (const game of [...report.games.values()].sort((a, b) => a.gameId.localeCompare(b.gameId))) {
    const entry = { gameId: game.gameId, cls: game.cls, code: game.code, detail: game.detail, logBytes: game.logBytes };
    games.push(options.deep && game.record !== null ? { ...entry, deep: await verifyGame(dataDir, game.gameId) } : entry);
  }
  let legacyFiles = 0;
  try {
    legacyFiles = (await fs.readdir(dataDir)).filter((name) => /^JUNO-/i.test(name) || name === "lobby.json").length;
  } catch {
    legacyFiles = 0;
  }
  return { games, byClass: countByClass(games), storeErrors: report.storeErrors, identity: await inspectIdentity(dataDir), legacyFiles };
}

/** The file hold store with its writes refused: `inspect` reports holds, never writes one. */
function readOnlyHolds(dataDir: string) {
  const holds = createFileHoldStore(dataDir, { warn: quiet, fs: READ_ONLY });
  return {
    list: () => holds.list(),
    load: (id: string) => holds.load(id),
    create: async () => ({ outcome: { kind: "definite" as const, detail: "inspect writes nothing" }, existing: null }),
    release: async () => ({ kind: "definite" as const, detail: "inspect writes nothing" }),
  };
}

/* ==================================================================
    RELEASE
   ================================================================== */

export type ReleaseResult =
  | { readonly ok: true; readonly verification: GameVerification; readonly releasedCode: string }
  | { readonly ok: false; readonly reason: string; readonly verification?: GameVerification };

/** Lift one durable hold -- the lock must already be held by this process (`withLock`). */
export async function releaseHold(dataDir: string, gameId: string, note: string, options: { lock: DataLock; ops: OpsRecorder; now?: number }): Promise<ReleaseResult> {
  const trimmed = note.trim();
  if (trimmed.length === 0 || trimmed.length > 500) return { ok: false, reason: "a release needs --note \"<why it is safe now>\" (1-500 characters)" };
  const holds = createFileHoldStore(dataDir, { writerCheck: () => options.lock.verify(), warn: quiet });
  let hold;
  try {
    hold = await holds.load(gameId);
  } catch (error) {
    return { ok: false, reason: `the hold file cannot be read (${describe(error)}); move it aside by hand only after inspecting it` };
  }
  if (hold === null) return { ok: false, reason: `${gameId} is not held` };
  const verification = await verifyGame(dataDir, gameId);
  if (!verification.ok) return { ok: false, reason: `${gameId} does not verify, so it stays held: ${verification.reason}`, verification };
  const at = options.now ?? Date.now();
  const outcome = await holds.release(gameId, {
    released_at: at,
    note: trimmed,
    verification: { class: verification.cls, entries: verification.entries, log_hash: verification.logHash },
    build: TOOL_BUILD,
  });
  if (outcome.kind !== "committed") return { ok: false, reason: `the release was not written (${outcome.detail}); ${gameId} is still held`, verification };
  options.ops.audit("hold.released", { game_id: gameId, code: hold.code, note: trimmed, class: verification.cls, entries: verification.entries, log_hash: verification.logHash });
  await options.ops.flush();
  return { ok: true, verification, releasedCode: hold.code };
}

/* ==================================================================
    ESCROW-3A: DUPLICATE JOIN-CODE TWINS (LIVE-2F/3D C4-02)
   ================================================================== */

export type DuplicateCodeResult =
  | { readonly ok: true; readonly code: string; readonly kept: string; readonly cleared: string; readonly released: readonly string[] }
  | { readonly ok: false; readonly reason: string };

/** Reconcile two games that hold one join code -- the lock must already be held by this process (`withLock`). */
export async function reconcileDuplicateCode(
  dataDir: string,
  gameA: string,
  gameB: string,
  note: string,
  options: { lock: DataLock; ops: OpsRecorder; keep?: string; now?: number },
): Promise<DuplicateCodeResult> {
  const trimmed = note.trim();
  if (trimmed.length === 0 || trimmed.length > 500) return { ok: false, reason: "a reconciliation needs --note \"<why it is safe now>\" (1-500 characters)" };
  if (gameA === gameB || !GAME_ID_PATTERN.test(gameA) || !GAME_ID_PATTERN.test(gameB)) return { ok: false, reason: "two different game ids are needed" };
  if (!(await options.lock.verify())) return { ok: false, reason: "this process does not hold the data directory's lock" };
  const records = createFileRecordStore(dataDir, { warn: quiet, writerCheck: () => options.lock.verify() });
  const [a, b] = await Promise.all([records.load(gameA).catch(() => null), records.load(gameB).catch(() => null)]);
  if (a === null || b === null) return { ok: false, reason: "both games must have a readable record" };
  if (a.join_code === null || a.join_code !== b.join_code) return { ok: false, reason: "the two records do not hold one join code" };
  /* Both histories verify exactly as `release` verifies them -- their twin's claim to the code aside. */
  for (const [id, twin] of [[gameA, gameB], [gameB, gameA]] as const) {
    const verification = await verifyGame(dataDir, id, { ignoreDuplicateCodeWith: twin });
    if (!verification.ok) return { ok: false, reason: `${id} does not verify, so nothing is changed: ${verification.reason}` };
  }
  /* Which record keeps the code: said by the operator, or unambiguous (exactly one is still waiting). */
  let keep = options.keep ?? null;
  if (keep === null) {
    const waiting = [a, b].filter((record) => record.status === "waiting" && record.started_at === null);
    if (waiting.length !== 1) return { ok: false, reason: "ambiguous: say which game keeps the code with --keep <game_id> (nothing was changed)" };
    keep = waiting[0].game_id;
  }
  if (keep !== gameA && keep !== gameB) return { ok: false, reason: "--keep must name one of the two games" };
  const cleared = keep === gameA ? b : a;
  const code = a.join_code;
  const next: GameRecord = { ...cleared, record_version: cleared.record_version + 1, join_code: null };
  const written = await records.put(next, cleared.record_version);
  if (written.kind !== "committed") return { ok: false, reason: `the record of ${cleared.game_id} was not written (${written.detail}); nothing else changed` };
  options.ops.audit("record.duplicate-code-reconciled", { game_id: cleared.game_id, twin: keep, code, kept_by: keep, record_version: next.record_version, note: trimmed });
  const released: string[] = [];
  for (const id of [gameA, gameB]) {
    const hold = await createFileHoldStore(dataDir, { warn: quiet }).load(id).catch(() => null);
    /* Only the duplicate-code hold this reconciles is lifted; any other hold (an operator's, a damaged log's) stays for
       its own `release`. */
    if (hold === null || hold.code !== "duplicate-join-code") continue;
    const result = await releaseHold(dataDir, id, `${trimmed} (duplicate join code reconciled; ${keep} keeps it)`, { lock: options.lock, ops: options.ops, now: options.now });
    if (!result.ok) return { ok: false, reason: `the code was reconciled but ${id} stays held: ${result.reason}` };
    released.push(id);
  }
  await options.ops.flush();
  return { ok: true, code, kept: keep, cleared: cleared.game_id, released };
}

/* ==================================================================
    ESCROW-3A: MONEY GAMES (`games/money/`), READ-ONLY AND THE VERIFIED RELEASE
   ================================================================== */

/** ESCROW-3B: one chain intent as the operator reads it. `evidence` says, in words, which of the four things is true:
 *  not attempted / attempted, outcome unknown / known failed / confirmed (or held, or not needed). */
export interface MoneyIntentView {
  readonly intent_id: string;
  readonly op: string;
  readonly seq: string | null;
  readonly status: string;
  readonly evidence: "not attempted" | "attempted, outcome unknown" | "known failed (retrying)" | "confirmed" | "not needed (superseded)" | "held";
  readonly attempts: number;
  readonly newest: { readonly tx_hash: string; readonly phase: string; readonly sequence: string; readonly timeout_height: string; readonly broadcast_code: number | null; readonly inclusion_height: string | null; readonly error: string | null } | null;
  readonly confirmation: { readonly how: string; readonly tx_hash: string | null; readonly height: string | null } | null;
  readonly why: string | null;
}

/** LIVE-4 (L4-4): the operator's word for a money game's canonical verdict on this build + configuration. */
export type MoneyClass =
  | "continued"
  | "deployment-unavailable"
  | "deployment-unverified"
  | "financial-protocol"
  | "newer-format"
  | "older-format"
  | "malformed"
  | "conflict"
  | "rules-not-supported"
  | "rules-not-certified"
  | "hosted-protocol"
  | "settlement-codec"
  | "legacy-unpinned"
  /** The files could not be read at all (a store fault, not a format): nothing can be decided -- listed, never dropped. */
  | "store-fault";

export interface MoneyInspection {
  /** LIVE-4 (L4-4): what the games were classified against (the configured escrow deployment, if any, and whether its
   *  chain facts were read at verification grade). */
  readonly against: { readonly deployments: readonly string[]; readonly chain: ChainFactsRead | null };
  readonly games: ReadonlyArray<{
    readonly gameId: string;
    readonly phase: string | null;
    readonly readable: boolean;
    /** LIVE-4 (L4-4): the canonical verdict and its class; the artifacts' classes; whether this configuration serves
     *  the game's escrow (owns it: the only server that may write its conflict hold). */
    readonly verdict: { readonly kind: string; readonly why: string | null; readonly detail: string | null };
    readonly class: MoneyClass;
    readonly owner: boolean;
    readonly formats: { readonly fin: FormatFact | "missing" | "unknown"; readonly tickets: FormatFact | null; readonly intents: FormatFact | null };
    readonly terminal: { readonly log_len: number; readonly sealed_at: number } | null;
    readonly intent: { readonly log_hash: string; readonly appraisal_state_hash: string; readonly rules_engine_version: number } | null;
    readonly hold: { readonly code: string; readonly detail: string; readonly from: string } | null;
    readonly continues: boolean | null;
    /* ESCROW-3B */
    readonly continuation: { readonly rules_engine_version: number; readonly hosted_protocol: number; readonly financial_protocol: number; readonly settlement_codec: string } | null;
    readonly binding: { readonly chain_id: string; readonly network_class: string; readonly contract: string; readonly code_checksum: string; readonly denom: string; readonly chain_game_id: string | null } | null;
    /** ESCROW-3B: the frozen roster, its epoch, and whether the freeze is PROVISIONAL (Start not yet confirmed on chain:
     *  released only if the chain proves that Start never happened) or PERMANENT (the chain started it). */
    readonly roster: { readonly roster_hash: string; readonly domain: string; readonly seats: number; readonly epoch: number; readonly freeze: "provisional" | "permanent" } | null;
    readonly chain: {
      readonly started_height: string | null;
      readonly checkpoint_prepared: { readonly seq: string; readonly log_len: number; readonly round_key: string } | null;
      readonly checkpoint_confirmed: { readonly seq: string; readonly log_len: number } | null;
      readonly settle_confirmed: { readonly seq: string; readonly window_end_secs: string } | null;
      readonly outcome: { readonly state: string; readonly route: string } | null;
    } | null;
    readonly intents: readonly MoneyIntentView[];
    readonly intents_unreadable: boolean;
  }>;
}

function intentView(intent: ChainIntentRecord): MoneyIntentView {
  const newest = intent.attempts[intent.attempts.length - 1];
  const live = newest !== undefined && (newest.phase === "signed" || newest.phase === "broadcast");
  const evidence: MoneyIntentView["evidence"] =
    intent.status === "confirmed"
      ? "confirmed"
      : intent.status === "superseded"
        ? "not needed (superseded)"
        : intent.status === "held"
          ? "held"
          : live
            ? "attempted, outcome unknown"
            : newest === undefined
              ? "not attempted"
              : "known failed (retrying)";
  return {
    intent_id: intent.intent_id,
    op: intent.op.kind,
    seq: "seq" in intent.op ? intent.op.seq : null,
    status: intent.status,
    evidence,
    attempts: intent.attempts.length,
    newest:
      newest === undefined
        ? null
        : {
            tx_hash: newest.tx_hash,
            phase: newest.phase,
            sequence: newest.sequence,
            timeout_height: newest.timeout_height,
            broadcast_code: newest.broadcast?.code ?? null,
            inclusion_height: newest.inclusion?.height ?? null,
            error: newest.error === null ? null : `${newest.error.code} (${newest.error.native.name})`,
          },
    confirmation: intent.confirmation === null ? null : { how: intent.confirmation.how, tx_hash: intent.confirmation.tx_hash, height: intent.confirmation.height },
    why: intent.hold !== null ? `${intent.hold.code}: ${intent.hold.detail}` : intent.superseded?.why ?? null,
  };
}

/* ------------------------------------------------------------------ */
/* LIVE-4 (L4-4): the canonical verdict, offline and read-only          */
/* ------------------------------------------------------------------ */

/** The operator's configuration: the escrow deployment `--escrow-config` names (none: this build serving no escrow, on
 *  which every money game is not continued -- it speaks no financial protocol), and -- with `--chain` -- its
 *  verification-grade chain facts. */
export async function moneyToolServing(dataDir: string, options: { readonly configPath?: string; readonly chain?: boolean } = {}): Promise<{ readonly serving: MoneyServing; readonly chain: ChainFactsRead | null }> {
  if (options.configPath === undefined) return { serving: noMoneyServing(), chain: null };
  let text: string;
  try {
    text = (await fs.readFile(path.resolve(options.configPath))).toString("utf8");
  } catch (error) {
    throw new Error(`the escrow configuration ${options.configPath} cannot be read (${describe(error)})`);
  }
  const raw = JSON.parse(text) as unknown;
  let config: ReturnType<typeof parseJunoBackendConfig>;
  try {
    config = parseJunoBackendConfig(raw, { serverMode: "production", dataDir });
  } catch {
    config = parseJunoBackendConfig(raw, { serverMode: "development", dataDir });
  }
  const pin = pinOf(config);
  /* LIVE-4 (L4-6): the escrow service's own constructor (`servingCapability([backend.pin])`), so the tool's key is the
     key a server started with this configuration serves. */
  const serving = createMoneyServing({ capability: servingCapability([pin]) });
  if (options.chain !== true) return { serving, chain: null };
  const rest = createJunoRest({ endpoints: config.endpoints, expectedChainId: config.chainId, allowInsecureLocalHttp: config.allowInsecureLocalHttp, timeoutMs: config.timeoutMs, maxResponseBytes: 256 * 1024, maxCodeBytes: 4 * 1024 * 1024 });
  const read = await readVerifiedChainFacts(pin, rest);
  serving.recordChainFacts(read);
  return { serving, chain: read };
}

/** The class an operator reads off a decision. */
export function moneyClassOf(decision: MoneyServingDecision): MoneyClass {
  const verdict = decision.verdict;
  return verdict.kind === "continues" ? "continued" : verdict.kind === "conflict" ? "conflict" : verdict.why;
}

/** A GameRecord's money terms, read straight from its file (no store: nothing is created, prepared or cached), or null. */
async function moneyTermsOnDisk(dataDir: string, gameId: string): Promise<{ readonly backend: string; readonly chain_id: string; readonly contract_address: string } | null> {
  const bytes = await readOptional(path.join(dataDir, "games", `${gameId}.json`)).catch(() => null);
  if (bytes === null) return null;
  try {
    const record = JSON.parse(bytes.toString("utf8")) as { record_schema?: unknown; money?: unknown };
    return record.record_schema === 2 && isGameMoneyTerms(record.money) ? record.money : null;
  } catch {
    return null;
  }
}

/** The deal's identity from a game's log file, read-only, exactly as the server reads it (`dealIdentity.ts`): no log is
 *  undealt, a log damaged before its deal is malformed, and a log that cannot be read at all throws (a store fault). */
const identityOnDisk = (dataDir: string, gameId: string): Promise<GameIdentityFacts> => dealIdentityOnDisk(dataDir, gameId);

/** One money game's canonical decision from its files, exactly as the server's load decides it: the financial record's
 *  class, the ledger's and intents' classes (only for a financial protocol this build speaks), the deal's identity, the
 *  GameRecord's terms (who owns a missing record). Reads only. */
export async function moneyDecisionOnDisk(
  dataDir: string,
  gameId: string,
  serving: MoneyServing,
): Promise<{ readonly decision: MoneyServingDecision; readonly record: FinancialGameRecord | null; readonly fin: FormatFact | "missing"; readonly tickets: FormatFact | null; readonly intents: FormatFact | null; readonly moneyTable: boolean }> {
  let record: FinancialGameRecord | null = null;
  let fin: FormatFact | "missing" = "current";
  try {
    record = await createFileFinancialGameStore(dataDir, { warn: quiet, fs: READ_ONLY }).load(gameId);
    if (record === null) fin = "missing";
  } catch (error) {
    if (!(error instanceof FinancialRecordUnreadableError)) throw error;
    fin = error.format;
  }
  const classes = await artifactClassesOnDisk(dataDir, serving, gameId, record);
  const tickets: FormatFact | null = classes.tickets ?? null;
  const intents: FormatFact | null = classes.intents ?? null;
  /* LIVE-4 (L4-6, review F2): the GameRecord's money terms name the owner whenever the financial record does not (missing
     or unreadable) -- exactly the `ownerKey` the settlement coordinator's step -1 and the money routes pass. */
  const terms = await moneyTermsOnDisk(dataDir, gameId);
  const decision = serving.decide({
    fin: fin === "missing" ? undefined : fin,
    record,
    /* As the server: an unreadable record's class decides first, so its deal is not read. */
    identity: fin !== "current" && fin !== "missing" ? { kind: "undealt" } : await identityOnDisk(dataDir, gameId),
    /* LIVE-4 (integration, review N-1): the log's class too, exactly as the server's money seams read it (N-3, T-25). */
    log: fin !== "current" && fin !== "missing" ? "current" : await logFormatOnDisk(dataDir, gameId),
    ...(tickets !== null ? { tickets } : {}),
    ...(intents !== null ? { intents } : {}),
    ownerKey: moneyTermsKey(terms),
  });
  /* A game with neither a financial record nor money terms is not a money game at all. */
  return { decision, record, fin, tickets, intents, moneyTable: fin !== "missing" || terms !== null };
}

/** LIVE-4 (L4-6): the ledger's and intents' classes beside a financial record, read-only -- the escrow service's
 *  `artifactFormatsOf` over the file stores (only for a financial protocol this pool speaks; the intents' class is
 *  `current` when the store has none to give), which is what `start.ts` hands the settlement coordinator. */
export async function artifactClassesOnDisk(dataDir: string, serving: MoneyServing, gameId: string, record: FinancialGameRecord | null): Promise<ArtifactClasses> {
  if (!classifiesArtifacts(serving.capability, record)) return {};
  return Object.freeze({
    tickets: await createFileWalletTicketStore(dataDir, { warn: quiet, fs: READ_ONLY }).formatOf(gameId),
    intents: (await createFileChainIntentStore(dataDir, { warn: quiet, fs: READ_ONLY }).formatOf(gameId)) ?? "current",
  });
}

/** Money GameRecords (record_schema 2) whose financial record does not exist: listed so the operator sees them. */
async function moneyRecordsWithoutFinancial(dataDir: string, known: ReadonlySet<string>): Promise<string[]> {
  const out: string[] = [];
  for (const name of await listOptional(path.join(dataDir, "games"))) {
    if (!name.endsWith(".json") || !GAME_ID_PATTERN.test(name.slice(0, -5))) continue;
    const gameId = name.slice(0, -5);
    if (known.has(gameId)) continue;
    if ((await moneyTermsOnDisk(dataDir, gameId)) !== null) out.push(gameId);
  }
  return out.sort();
}

export async function inspectMoney(dataDir: string, only?: string, options: { readonly serving?: MoneyServing; readonly chain?: ChainFactsRead | null } = {}): Promise<MoneyInspection> {
  const serving = options.serving ?? noMoneyServing();
  const store = createFileFinancialGameStore(dataDir, { warn: quiet, fs: READ_ONLY });
  const intentStore = createFileChainIntentStore(dataDir, { warn: quiet, fs: READ_ONLY });
  const listed = (await store.list()).sort();
  const ids = only !== undefined ? [only] : [...listed, ...(await moneyRecordsWithoutFinancial(dataDir, new Set(listed)))];
  const games: Array<MoneyInspection["games"][number]> = [];
  for (const gameId of ids) {
    let intents: MoneyIntentView[] = [];
    let intentsUnreadable = false;
    try {
      intents = (await intentStore.listGame(gameId)).map(intentView);
    } catch {
      intentsUnreadable = true;
    }
    let decided: Awaited<ReturnType<typeof moneyDecisionOnDisk>>;
    try {
      decided = await moneyDecisionOnDisk(dataDir, gameId, serving);
    } catch (error) {
      /* A store fault, not a format class (review R-4): nothing can be decided, and the game is LISTED -- never dropped
         from the view or from the exit code. */
      games.push({
        gameId,
        phase: null,
        readable: false,
        verdict: { kind: "undecided", why: "store-fault", detail: describe(error).slice(0, 300) },
        class: "store-fault",
        owner: false,
        formats: { fin: "unknown", tickets: null, intents: null },
        terminal: null,
        intent: null,
        hold: null,
        continues: null,
        continuation: null,
        binding: null,
        roster: null,
        chain: null,
        intents,
        intents_unreadable: intentsUnreadable,
      });
      continue;
    }
    const { decision } = decided;
    if (!decided.moneyTable) continue; // not a money game at all
    const verdictView = { kind: decision.verdict.kind, why: decision.verdict.kind === "continues" ? null : decision.verdict.why, detail: decision.verdict.kind === "continues" ? null : decision.verdict.detail };
    const classView = { verdict: verdictView, class: moneyClassOf(decision), owner: decision.owner, formats: { fin: decided.fin, tickets: decided.tickets, intents: decided.intents } };
    const record = decided.record;
    if (record === null) {
      games.push({ gameId, phase: null, readable: false, ...classView, terminal: null, intent: null, hold: null, continues: false, continuation: null, binding: null, roster: null, chain: null, intents, intents_unreadable: intentsUnreadable });
      continue;
    }
    {
      const escrow = record.binding?.escrow ?? null;
      games.push({
        gameId,
        phase: record.phase,
        readable: true,
        ...classView,
        terminal: record.terminal === null ? null : { log_len: record.terminal.log_len, sealed_at: record.terminal.sealed_at },
        intent: record.intent === null ? null : { log_hash: record.intent.log_hash, appraisal_state_hash: record.intent.appraisal_state_hash, rules_engine_version: record.intent.rules_engine_version },
        hold: record.hold === null ? null : { code: record.hold.code, detail: record.hold.detail, from: record.hold.from },
        continues: decision.verdict.kind === "continues",
        continuation: record.continuation === null ? null : { rules_engine_version: record.continuation.rules_engine_version, hosted_protocol: record.continuation.hosted_protocol, financial_protocol: record.continuation.financial_protocol, settlement_codec: record.continuation.settlement_codec },
        binding:
          record.binding === null
            ? null
            : { chain_id: record.binding.deployment.chain_id, network_class: record.binding.deployment.network_class, contract: record.binding.deployment.contract_address, code_checksum: record.binding.deployment.code_checksum, denom: record.binding.deployment.denom, chain_game_id: escrow?.chain_game_id ?? null },
        roster:
          record.roster === null
            ? null
            : { roster_hash: record.roster.roster_hash, domain: record.roster.expected_domain, seats: record.roster.roster.length, epoch: record.roster_epoch, freeze: record.chain.started === null ? "provisional" : "permanent" },
        chain: {
          started_height: record.chain.started?.height ?? null,
          checkpoint_prepared: record.chain.checkpoint_prepared === null ? null : { seq: record.chain.checkpoint_prepared.seq, log_len: record.chain.checkpoint_prepared.log_len, round_key: record.chain.checkpoint_prepared.round_key },
          checkpoint_confirmed: record.chain.checkpoint_confirmed === null ? null : { seq: record.chain.checkpoint_confirmed.seq, log_len: record.chain.checkpoint_confirmed.log_len },
          settle_confirmed: record.chain.settle_confirmed === null ? null : { seq: record.chain.settle_confirmed.seq, window_end_secs: record.chain.settle_confirmed.window_end_secs },
          outcome: record.chain_outcome === null ? null : { state: record.chain_outcome.state, route: record.chain_outcome.route },
        },
        intents,
        intents_unreadable: intentsUnreadable,
      });
    }
  }
  return { against: { deployments: serving.capability.escrow_deployments.map((deployment) => deployment.key), chain: options.chain ?? null }, games };
}

export type MoneyReleaseResult = { readonly ok: true; readonly to: string } | { readonly ok: false; readonly reason: string };

/** Lift a HELD money game -- the lock must already be held by this process (`withLock`). `serving` (L4-4): the
 *  configuration the release is judged against (default: none served, so nothing is released). */
export async function releaseMoneyHold(dataDir: string, gameId: string, note: string, options: { lock: DataLock; ops: OpsRecorder; now?: number; serving?: MoneyServing }): Promise<MoneyReleaseResult> {
  const trimmed = note.trim();
  if (trimmed.length === 0 || trimmed.length > 500) return { ok: false, reason: "a release needs --note \"<why it is safe now>\" (1-500 characters)" };
  if (!(await options.lock.verify())) return { ok: false, reason: "this process does not hold the data directory's lock" };
  const store = createFileFinancialGameStore(dataDir, { warn: quiet, writerCheck: () => options.lock.verify() });
  let record;
  try {
    record = await store.load(gameId);
  } catch (error) {
    return { ok: false, reason: `the money record cannot be read (${describe(error)}); it is never overwritten -- inspect it by hand` };
  }
  if (record === null) return { ok: false, reason: `${gameId} has no money record` };
  if (record.phase !== "held" || record.hold === null) return { ok: false, reason: `${gameId} is not held (${record.phase})` };
  if (record.hold.code === "financial-record-missing" || record.continuation === null) {
    return { ok: false, reason: `${gameId}'s money record is a placeholder for a record that was missing: it is never released -- stop the server and restore the original games/money/${gameId}.json` };
  }
  /* 1. The game itself verifies, as `release` verifies it; a game-level durable hold is lifted by `release` first. */
  if ((await createFileHoldStore(dataDir, { warn: quiet }).load(gameId).catch(() => "unreadable")) !== null) {
    return { ok: false, reason: `${gameId} itself is held (games/holds/): run \`release\` for the game first` };
  }
  const verification = await verifyGame(dataDir, gameId);
  if (!verification.ok) return { ok: false, reason: `${gameId} does not verify, so its money stays held: ${verification.reason}` };
  /* LIVE-4 (integration, review N-1): a game this build does not continue (a newer build's log, say) is never released
     from here -- its own build's operator decides. */
  if (verification.cls === "incompatible") return { ok: false, reason: `${gameId} is not continued by this build (${verification.reason}), so its money stays held` };
  /* 2. This deployment CONTINUES it (L4-4): the canonical verdict -- the money identity, the artifacts' formats, the deal,
     and the escrow served by the configuration given -- exactly as the server's load will decide it. A hold for a
     deployment conflict is lifted only against a verification-grade chain read (`--chain`) that no longer contradicts
     the game: offline, nothing can show the contradiction is gone. */
  const serving = options.serving ?? noMoneyServing();
  let onDisk: Awaited<ReturnType<typeof moneyDecisionOnDisk>>;
  try {
    onDisk = await moneyDecisionOnDisk(dataDir, gameId, serving);
  } catch (error) {
    return { ok: false, reason: `${gameId}'s money files cannot be read (${describe(error)}); nothing can be decided, so it stays held` };
  }
  const { decision } = onDisk;
  const verdict = decision.verdict;
  /* A hold for a deployment conflict is lifted only against a verification-grade read of the deployment this run. Without
     one the canonical verdict itself says so (L4-7: the durable conflict hold keeps a game `deployment-unverified` until
     the chain is read -- and a verified conflict supersedes a weaker hold, so it is always this code), and the operator
     is told what to run. */
  const needsChainRead = record.hold.code === "binding-mismatch" && (decision.key === null || serving.chainFactsReadAt(decision.key) === null);
  const chainReadMessage = `${gameId} is held for a deployment conflict: it is released only against a verification-grade chain read that agrees with its binding (run with --escrow-config and --chain); it stays held`;
  if (verdict.kind !== "continues") {
    if (needsChainRead && verdict.kind === "not-continued" && verdict.why === "deployment-unverified") return { ok: false, reason: chainReadMessage };
    return { ok: false, reason: `this deployment may not continue ${gameId} (${verdict.kind === "conflict" ? `conflict: ${verdict.why}` : verdict.why}: ${verdict.detail}); it stays held -- run a compatible build with the escrow it is bound to configured` };
  }
  if (needsChainRead) {
    return { ok: false, reason: chainReadMessage };
  }
  /* 3. A sealed game's evidence re-derives from its sealed prefix. */
  if (record.terminal !== null) {
    const bytes = await readOptional(path.join(dataDir, `${gameId}.log.jsonl`));
    const entries = bytes === null ? [] : scanLog(bytes).entries;
    const evidence = prepareTerminalEvidence({ gameId, entries, seal: { log_len: record.terminal.log_len, at: record.terminal.sealed_at }, replay: serverPrefixReplay(TOOL_BUILD) });
    if (!evidence.ok) return { ok: false, reason: `the settlement evidence does not re-derive (${evidence.code}: ${evidence.detail}); it stays held` };
    if (record.intent !== null && JSON.stringify(record.intent) !== JSON.stringify(evidence.evidence)) {
      return { ok: false, reason: "the recorded intent differs from what the sealed prefix derives; it stays held" };
    }
  }
  const at = options.now ?? Date.now();
  /* The deal, from the GameRecord (log-implied): a game dealt while held never resumes at funding. */
  const gameRecord = await createFileRecordStore(dataDir, { warn: quiet }).load(gameId).catch(() => null);
  if (gameRecord === null) return { ok: false, reason: `${gameId}'s record cannot be read; its money stays held` };
  const decided = transitionFinancial(record, { kind: "operator-release", at, note: trimmed, dealt: gameRecord.started_at !== null });
  if (decided.kind !== "moved") return { ok: false, reason: decided.kind === "refused" ? decided.reason : "nothing to release" };
  const written = await store.put(decided.next, record.record_version);
  if (written.kind !== "committed") return { ok: false, reason: `the release was not written (${written.kind === "conflict" ? "the record changed" : written.detail}); it is still held` };
  /* L4-7: a verified deployment conflict may have superseded a weaker hold; releasing it lifts both, so both are named. */
  const superseded = /\(supersedes ([a-z-]+)\)$/.exec([...record.transitions].reverse().find((line) => line.to === "held")?.why ?? "")?.[1] ?? null;
  options.ops.audit("money.released", { game_id: gameId, code: record.hold.code, ...(superseded !== null ? { superseded } : {}), to: decided.next.phase, note: trimmed, log_hash: verification.logHash });
  await options.ops.flush();
  return { ok: true, to: decided.next.phase };
}

/* ==================================================================
    LIVE-4 (L4-6): THE CANONICAL CONTINUATION VERDICT OF EVERY STORED GAME, OFFLINE AND READ-ONLY
   ==================================================================
   The same pool `start.ts` assembles, built from the same modules over READ-ONLY stores: the money serving (the
   capability of the configuration the operator names, and -- with `--chain` -- its verification-grade chain facts),
   the settlement coordinator over the financial store (the money facts' index; only `load()` and `factsOf` are used:
   no job, no sweep, no seal, no placeholder, and its store refuses every write anyway), and the continuation wiring
   (`createContinuationWiring`) over that capability, runtime and index. Each game's verdict is `wiring.verdictOf` --
   the question every session asks at every rebuild -- with the deal's identity and the log's format class read
   exactly as the server's money seams read them (`dealIdentityOnDisk`, `logFormatOnDisk`: N-3's newer-format lines
   and T-25's unknown kinds). Nothing here reimplements a rule; a money game's answer is also asked of the money seam
   (`moneyDecisionOnDisk`) and the two are printed side by side: both are the canonical verdict, so their KIND must
   agree; their reason may differ when several artifacts are unreadable (the money seam stops at an unreadable
   financial record before reading the log). */

/** No money index: every money GameRecord then reads as one whose financial record is missing (the wiring's own
 *  fail-closed default). Discovery needs only the gameplay half, which never reads it. */
const NO_TOOL_MONEY_FACTS = Object.freeze({ factsOf: () => undefined, refresh: async () => undefined });

/** The continuation wiring as `gameServer.ts` builds it: this serving's capability and live runtime; the legacy-log
 *  policy every production pool runs with (`refuse`); a primary pool (every pool is one until LIVE-6). */
function toolWiring(
  serving: MoneyServing,
  moneyFacts: Parameters<typeof createContinuationWiring>[0]["moneyFacts"],
  recordOf: (gameId: string) => Readonly<GameRecord> | null,
  now: number,
): ContinuationWiring {
  return createContinuationWiring({ capability: serving.capability, runtime: serving.runtime(), policy: { legacyLogs: "refuse" }, moneyFacts, recordOf, now: () => now });
}

/** The tool's pool (see the section header). The caller stops the coordinator. */
export async function toolPool(dataDir: string, serving: MoneyServing, now: number = Date.now()): Promise<{ readonly wiring: ContinuationWiring; readonly coordinator: SettlementCoordinator; readonly records: Map<string, GameRecord> }> {
  const records = new Map<string, GameRecord>();
  const coordinator = createSettlementCoordinator({
    store: createFileFinancialGameStore(dataDir, { warn: quiet, fs: READ_ONLY }),
    replay: serverPrefixReplay(TOOL_BUILD),
    now: () => now,
    warn: quiet,
    serving,
    readDeal: (gameId) => dealIdentityOnDisk(dataDir, gameId),
    readLogFormat: (gameId) => logFormatOnDisk(dataDir, gameId),
    artifactFormats: (gameId, record) => artifactClassesOnDisk(dataDir, serving, gameId, record),
    /* No timer: the tool never queues a job. */
    schedule: () => ({ cancel: () => undefined }),
  });
  await coordinator.load();
  const wiring = toolWiring(serving, coordinator, (gameId) => records.get(gameId) ?? null, now);
  return { wiring, coordinator, records };
}

/** The operator's word for one stored game's continuation: the canonical verdict's (`continues`,
 *  `not-continued/<why>`, `conflict/<why>`), or why no verdict could be asked (an artifact class this build cannot
 *  read, or a store fault). */
export type ContinuationClass = "continues" | `not-continued/${string}` | `conflict/${string}` | "record-newer-format" | "record-malformed" | "no-record" | "store-fault";

export interface StoredGameContinuation {
  readonly gameId: string;
  readonly money: boolean;
  readonly class: ContinuationClass;
  /** The canonical verdict (`wiring.verdictOf`); null when none could be asked (`class` says why). */
  readonly verdict: { readonly kind: ContinuationVerdict["kind"]; readonly why: string | null; readonly detail: string | null } | null;
  /** The artifacts' classes as read: the record's store class, the log's (`scanLog`: absent, clean, torn-tail, corrupt,
   *  newer-format) and its format fact (`logFormatOnDisk`), and -- for a money game -- the financial record's, the
   *  ledger's and the intents'. */
  readonly artifacts: {
    readonly record: "current" | "newer" | "corrupt" | "missing";
    readonly log: GameVerification["logClassification"] | "unreadable";
    readonly log_format: FormatFact | null;
    readonly fin?: FormatFact | "missing" | "unknown";
    readonly tickets?: FormatFact | null;
    readonly intents?: FormatFact | null;
  };
  /** The deal as read from the log: dealt (rules / hosted), undealt, legacy or malformed. */
  readonly deal: string | null;
  /** A durable game hold (`games/holds/`), if one exists -- reported, never written or lifted here. */
  readonly hold: string | null;
  /** A damaged log (`corrupt`) is held by the server's load for `logDoctor`, whatever the verdict. */
  readonly damaged_log: boolean;
  /** What the server's own startup discovery concludes from the files (read-only here: `inspect`'s pass, over this
   *  pool's gameplay verdict) -- a record-against-deal disagreement, say, is HELD there before any continuation
   *  question is asked (an unpinned server deal is `rules-pin-mismatch`, #1520). `unreconciled` means only the load,
   *  which replays the whole log, decides; the verdict above is the question it asks. */
  readonly discovery: { readonly cls: GameClass; readonly code: string | null } | null;
  /** L4-4's money view, for a money game: the money seam's own verdict over the same files, whether this
   *  configuration owns the game (the only pool that may write its conflict hold), and the deployment it is bound to. */
  readonly money_seam: {
    readonly class: MoneyClass;
    readonly owner: boolean;
    readonly deployment: string | null;
    /** The same KIND of answer (continues / not continued / conflict) as the session verdict -- what decides whether
     *  anything is played or written. A defect if false. */
    readonly agrees: boolean;
    /** And the same reason. Not always so, and not a defect: with several unreadable artifacts the two seams can name a
     *  different FIRST one (the money seam reads no log once its financial record is unreadable), both "not continued". */
    readonly same_reason: boolean;
  } | null;
}

export interface ContinuationInspection {
  readonly compatibility: CompatibilityDescriptor;
  readonly chain: ChainFactsRead | null;
  readonly games: readonly StoredGameContinuation[];
  readonly byClass: Readonly<Record<string, number>>;
}

const verdictClass = (verdict: ContinuationVerdict): ContinuationClass => (verdict.kind === "continues" ? "continues" : `${verdict.kind}/${verdict.why}`);
const dealWords = (identity: GameIdentityFacts): string =>
  identity.kind === "dealt" ? `dealt (rules ${identity.gci.rules_engine_version}, hosted ${identity.gci.hosted_protocol})` : identity.kind === "malformed" ? `malformed (${identity.detail.slice(0, 120)})` : identity.kind;

/** Every stored game (its GameRecord, or its financial record) judged by the canonical continuation verdict, read-only. */
export async function inspectContinuation(
  dataDir: string,
  options: { readonly serving?: MoneyServing; readonly chain?: ChainFactsRead | null; readonly only?: string; readonly now?: number; readonly diagnosticFlag?: string } = {},
): Promise<ContinuationInspection> {
  const serving = options.serving ?? noMoneyServing();
  const now = options.now ?? Date.now();
  /* The server's discovery over the same files and the same pool's gameplay verdict, read-only (`inspect`'s pass). */
  const discovered = new Map((await inspectData(dataDir, { now, serving })).games.map((game) => [game.gameId, { cls: game.cls, code: game.code }] as const));
  const { wiring, coordinator, records } = await toolPool(dataDir, serving, now);
  try {
    const recordStore = createFileRecordStore(dataDir, { warn: quiet, fs: READ_ONLY });
    const holds = createFileHoldStore(dataDir, { warn: quiet, fs: READ_ONLY });
    const recordIds = (await listOrEmpty(() => fs.readdir(path.join(dataDir, "games")))).filter((name) => name.endsWith(".json") && GAME_ID_PATTERN.test(name.slice(0, -5))).map((name) => name.slice(0, -5));
    const financialIds = await createFileFinancialGameStore(dataDir, { warn: quiet, fs: READ_ONLY }).list();
    /* Every stored game (review F3): a log or a hold with no record is listed too -- the server never serves it
       (discovery: `orphan-log`), and it is said so rather than dropped. */
    const logIds = (await listOrEmpty(() => fs.readdir(dataDir))).filter((name) => name.endsWith(".log.jsonl") && GAME_ID_PATTERN.test(name.slice(0, -".log.jsonl".length))).map((name) => name.slice(0, -".log.jsonl".length));
    const holdIds = await holds.list();
    const ids = options.only !== undefined ? [options.only] : [...new Set([...recordIds, ...financialIds, ...logIds, ...holdIds])].sort();
    /* Every record first, so the wiring knows which games are money tables (a record's money terms) before any verdict. */
    const recordClass = new Map<string, StoredGameContinuation["artifacts"]["record"]>();
    for (const gameId of ids) {
      try {
        const record = await recordStore.load(gameId);
        if (record === null) recordClass.set(gameId, "missing");
        else {
          records.set(gameId, record);
          recordClass.set(gameId, "current");
        }
      } catch (error) {
        if (isStoreIncompatible(error)) recordClass.set(gameId, "newer");
        else if (isStoreCorrupt(error)) recordClass.set(gameId, "corrupt");
        else throw error;
      }
    }
    const games: StoredGameContinuation[] = [];
    for (const gameId of ids) {
      const record = recordClass.get(gameId) ?? "missing";
      const hold = await holds.load(gameId).then((held) => (held === null ? null : `${held.code}: ${held.detail}`), () => "unreadable hold file");
      const bytes = await readOptional(path.join(dataDir, `${gameId}.log.jsonl`)).catch(() => undefined);
      const log: StoredGameContinuation["artifacts"]["log"] = bytes === undefined ? "unreadable" : bytes === null ? "absent" : scanLog(bytes).classification;
      const money = wiring.isMoney(gameId);
      const base = { gameId, money, hold, damaged_log: log === "corrupt", discovery: discovered.get(gameId) ?? null };
      if (record === "missing" && !money) {
        /* No GameRecord and no financial record: no seat, no host -- never served (discovery's class says which). */
        games.push({ ...base, class: "no-record", verdict: null, artifacts: { record, log, log_format: null }, deal: null, money_seam: null });
        continue;
      }
      if (record === "newer" || record === "corrupt") {
        /* The server never reaches a verdict for a record it cannot read: discovery calls a newer record incompatible
           (`record-schema-newer`) and holds a damaged one (`record-unreadable`). Said as such, not guessed at. */
        games.push({ ...base, class: record === "newer" ? "record-newer-format" : "record-malformed", verdict: null, artifacts: { record, log, log_format: null }, deal: null, money_seam: null });
        continue;
      }
      let identity: GameIdentityFacts;
      let logFormat: FormatFact;
      try {
        identity = await dealIdentityOnDisk(dataDir, gameId);
        logFormat = await logFormatOnDisk(dataDir, gameId);
      } catch (error) {
        /* A read that failed (not a format): nothing can be decided now -- listed, never dropped, never a verdict. */
        games.push({ ...base, class: "store-fault", verdict: null, artifacts: { record, log, log_format: null }, deal: `unread (${describe(error).slice(0, 200)})`, money_seam: null });
        continue;
      }
      const verdict = wiring.verdictOf(gameId, identity, logFormat);
      const cls = verdictClass(verdict);
      let moneySeam: StoredGameContinuation["money_seam"] = null;
      let moneyArtifacts: Pick<StoredGameContinuation["artifacts"], "fin" | "tickets" | "intents"> = {};
      if (money) {
        try {
          const decided = await moneyDecisionOnDisk(dataDir, gameId, serving);
          const seamClass = moneyClassOf(decided.decision);
          moneySeam = {
            class: seamClass,
            owner: decided.decision.owner,
            deployment: decided.decision.key,
            /* Both are the canonical verdict. Their KIND must agree (a disagreement is a defect, printed loudly); the reason
               may differ when several artifacts are unreadable, because the money seam stops at an unreadable financial
               record before reading the log (review F1). */
            agrees: decided.decision.verdict.kind === verdict.kind,
            same_reason: verdictClass(decided.decision.verdict) === cls,
          };
          moneyArtifacts = { fin: decided.fin, tickets: decided.tickets, intents: decided.intents };
        } catch {
          moneyArtifacts = { fin: "unknown", tickets: null, intents: null };
        }
      }
      games.push({
        ...base,
        class: cls,
        verdict: { kind: verdict.kind, why: verdict.kind === "continues" ? null : verdict.why, detail: verdict.kind === "continues" ? null : verdict.detail },
        artifacts: { record, log, log_format: logFormat, ...moneyArtifacts },
        deal: dealWords(identity),
        money_seam: moneySeam,
      });
    }
    const byClass: Record<string, number> = {};
    for (const game of games) byClass[game.class] = (byClass[game.class] ?? 0) + 1;
    return { compatibility: operatorDescriptor(serving.capability, options.diagnosticFlag), chain: options.chain ?? null, games, byClass };
  } finally {
    coordinator.stop();
  }
}

/* ==================================================================
    GC
   ================================================================== */

export const LOCK_ASIDE_MAX_AGE_MS = 10 * 60 * 1000;
/** The temporaries of LIVE-3B's durable replacement and LIVE-2B's identity file: `<target>.<pid>.[<n>.]<hex>.tmp`. */
const TEMPORARY = /\.\d+\.(?:\d+\.)?[0-9a-f]{8,12}\.tmp$/;

export interface GcPlan {
  readonly move: ReadonlyArray<{ gameId: string; archivedAt: number; files: string[] }>;
  readonly resume: readonly string[];
  readonly temporaries: readonly string[];
  readonly lockAsides: readonly string[];
  readonly retained: Record<string, number>;
  readonly legacyFiles: number;
}

export interface GcResult extends GcPlan {
  readonly applied: boolean;
  readonly moved: ReadonlyArray<{ gameId: string; files: number }>;
  readonly errors: readonly string[];
}

async function listOptional(directory: string): Promise<string[]> {
  try {
    return await fs.readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function planGc(dataDir: string, options: { now?: number } = {}): Promise<GcPlan> {
  const now = options.now ?? Date.now();
  const inspection = await inspectData(dataDir, { now });
  const records = createFileRecordStore(dataDir, { warn: quiet, fs: READ_ONLY });
  const retained: Record<string, number> = {};
  const move: Array<{ gameId: string; archivedAt: number; files: string[] }> = [];
  for (const game of inspection.games) {
    let movable = false;
    if (game.cls === "archived") {
      const record = await records.load(game.gameId).catch(() => null);
      const due = record === null ? null : movableAt(record, NO_MONEY_SETTLEMENT.retentionOf(record));
      if (record !== null && due !== null && now >= due) {
        movable = true;
        move.push({ gameId: game.gameId, archivedAt: record.archived_at as number, files: await gameFiles(dataDir, game.gameId) });
      }
    }
    if (!movable) retained[game.cls] = (retained[game.cls] ?? 0) + 1;
  }
  /* Archives a crash interrupted -- and ONLY those (review E12): the game's record is already inside `archive/<id>/`
     (a move takes the record first), no manifest yet, that record is an archived no-money game past its hot period,
     and nothing of it is live any more that could say otherwise (no live record, no hold). A stray or hand-made
     directory never pulls a game's files out of the live directories. */
  const resume: string[] = [];
  for (const name of await listOptional(path.join(dataDir, "archive"))) {
    if (!GAME_ID_PATTERN.test(name)) continue;
    const inside = await listOptional(path.join(dataDir, "archive", name));
    if (inside.includes("manifest.json") || !inside.includes(`${name}.json`)) continue;
    if ((await readOptional(path.join(dataDir, "games", `${name}.json`))) !== null) continue;
    if ((await readOptional(path.join(holdDirectory(dataDir), `${name}.json`))) !== null) continue;
    const moved = await readOptional(path.join(dataDir, "archive", name, `${name}.json`));
    let record: GameRecord | null = null;
    try {
      record = moved === null ? null : (JSON.parse(moved.toString("utf8")) as GameRecord);
    } catch {
      record = null;
    }
    if (record === null || record.game_id !== name || typeof record.archived_at !== "number") continue;
    const due = movableAt(record, NO_MONEY_SETTLEMENT.retentionOf(record));
    if (due !== null && now >= due) resume.push(name);
  }
  const temporaries: string[] = [];
  for (const directory of [dataDir, path.join(dataDir, "games"), holdDirectory(dataDir), path.join(holdDirectory(dataDir), "released"), path.join(dataDir, OPS_DIRECTORY)]) {
    for (const name of await listOptional(directory)) if (TEMPORARY.test(name)) temporaries.push(path.join(directory, name));
  }
  const lockAsides: string[] = [];
  for (const name of await listOptional(dataDir)) {
    if (!name.startsWith(`${LOCK_DIRECTORY}.stale.`)) continue;
    const stat = await fs.stat(path.join(dataDir, name)).catch(() => null);
    if (stat !== null && stat.isDirectory() && now - stat.mtimeMs >= LOCK_ASIDE_MAX_AGE_MS) lockAsides.push(path.join(dataDir, name));
  }
  return { move, resume, temporaries, lockAsides, retained, legacyFiles: inspection.legacyFiles };
}

/** The files of one game in the live directories, record first (the order they are moved in). */
async function gameFiles(dataDir: string, gameId: string): Promise<string[]> {
  const candidates = [path.join(dataDir, "games", `${gameId}.json`), path.join(dataDir, `${gameId}.log.jsonl`), path.join(dataDir, `${gameId}.chat.jsonl`)];
  const released = path.join(holdDirectory(dataDir), "released");
  for (const name of await listOptional(released)) if (name.startsWith(`${gameId}.`) && name.endsWith(".json")) candidates.push(path.join(released, name));
  const present: string[] = [];
  for (const file of candidates) if ((await readOptional(file)) !== null) present.push(file);
  return present;
}

/** Move one archived game: every file hashed, renamed into `archive/<id>/`, hashed again; then the manifest. */
async function moveGame(dataDir: string, gameId: string, archivedAt: number | null, now: number): Promise<{ files: number }> {
  const destination = path.join(dataDir, "archive", gameId);
  await fs.mkdir(destination, { recursive: true });
  const moved: Array<{ name: string; from: string; bytes: number; sha256: string }> = [];
  /* Anything already moved by an interrupted run is part of the manifest too. */
  for (const name of await listOptional(destination)) {
    if (name === "manifest.json") continue;
    const bytes = await fs.readFile(path.join(destination, name));
    moved.push({ name, from: "(an earlier, interrupted run)", bytes: bytes.length, sha256: sha256(bytes) });
  }
  for (const file of await gameFiles(dataDir, gameId)) {
    const before = await fs.readFile(file);
    const target = path.join(destination, path.basename(file));
    if ((await readOptional(target)) !== null) throw new Error(`${target} already exists; nothing was overwritten`);
    await fs.rename(file, target);
    const after = await fs.readFile(target);
    if (sha256(after) !== sha256(before)) throw new Error(`${path.basename(file)} changed while it was moved`);
    moved.push({ name: path.basename(file), from: path.relative(dataDir, file), bytes: after.length, sha256: sha256(after) });
  }
  const log = moved.find((file) => file.name === `${gameId}.log.jsonl`);
  let logSummary: { entries: number; log_hash: string | null } | null = null;
  if (log !== undefined) {
    const scan = scanLog(await readFileChunked(path.join(destination, log.name)));
    logSummary = { entries: scan.entries.length, log_hash: scan.entries.length === 0 ? null : logHash(scan.entries) };
  }
  const manifest = { format: "gs-game-archive", version: 1, game_id: gameId, archived_at: archivedAt, moved_at: now, files: moved, log: logSummary };
  const outcome = await durableReplace(nodeStoreFs, path.join(destination, "manifest.json"), Buffer.from(`${JSON.stringify(manifest, null, 1)}\n`, "utf8"));
  if (outcome.kind !== "committed") throw new Error(`the manifest was not written (${outcome.detail})`);
  return { files: moved.length };
}

export async function runGc(dataDir: string, options: { apply: boolean; lock?: DataLock; ops?: OpsRecorder; now?: number }): Promise<GcResult> {
  const now = options.now ?? Date.now();
  const plan = await planGc(dataDir, { now });
  if (!options.apply) return { ...plan, applied: false, moved: [], errors: [] };
  if (options.lock === undefined || !(await options.lock.verify())) throw new Error("gc --apply needs the data directory's lock");
  const ops = options.ops;
  const moved: Array<{ gameId: string; files: number }> = [];
  const errors: string[] = [];
  for (const gameId of plan.resume) {
    if (!(await options.lock.verify())) {
      errors.push("the lock was lost; stopped");
      break;
    }
    try {
      const result = await moveGame(dataDir, gameId, null, now);
      moved.push({ gameId, files: result.files });
      ops?.audit("gc.archive-resumed", { game_id: gameId, files: result.files });
    } catch (error) {
      errors.push(`${gameId}: ${describe(error)}`);
    }
  }
  for (const game of plan.move) {
    if (!(await options.lock.verify())) {
      errors.push("the lock was lost; stopped");
      break;
    }
    try {
      const result = await moveGame(dataDir, game.gameId, game.archivedAt, now);
      moved.push({ gameId: game.gameId, files: result.files });
      ops?.audit("gc.archived", { game_id: game.gameId, files: result.files, archived_at: game.archivedAt });
    } catch (error) {
      errors.push(`${game.gameId}: ${describe(error)}`);
    }
  }
  for (const file of plan.temporaries) {
    try {
      await fs.unlink(file);
      ops?.audit("gc.temporary-removed", { file: path.relative(dataDir, file) });
    } catch (error) {
      errors.push(`${path.basename(file)}: ${describe(error)}`);
    }
  }
  for (const directory of plan.lockAsides) {
    try {
      await fs.rm(directory, { recursive: true, force: true });
      ops?.audit("gc.lock-aside-removed", { directory: path.basename(directory) });
    } catch (error) {
      errors.push(`${path.basename(directory)}: ${describe(error)}`);
    }
  }
  await ops?.flush();
  return { ...plan, applied: true, moved, errors };
}

/* ==================================================================
    THE LOCK: an offline tool that changes anything holds it for the whole run
   ================================================================== */

export async function withLock<T>(dataDir: string, work: (lock: DataLock) => Promise<T>): Promise<T | { refused: string }> {
  const acquired = await acquireDataLock(dataDir, { log: quiet, onLost: quiet });
  if (!acquired.ok) return { refused: acquired.reason };
  try {
    return await work(acquired.lock);
  } finally {
    await acquired.lock.release();
  }
}

/* ==================================================================
    DA-8: scan-v10 -- THE v10 -> v11 BOUNDARY, READ-ONLY
   ==================================================================
   Reads every `*.log.jsonl` in the data directory and under `archive/<id>/`, with the same line reader the server
   loads with (`scanLog`: stamped and legacy lines, a torn tail cut at its last complete batch, a corrupt log reported and
   skipped). Takes no lock and writes nothing -- not a hold, not an ops line, not a record -- so it may run beside a live
   server; it then reads what was on disk at that moment, and says so. Principal ids are never printed: a game is named
   by its file, an entry by its index and message kind. */

export interface BoundaryScanReport {
  readonly dataDir: string;
  readonly version: number;
  /** A server held the directory while the scan read it (its later appends are not in this report). */
  readonly serverRunning: boolean;
  readonly games: readonly GameBoundaryScan[];
  readonly unreadable: ReadonlyArray<{ readonly file: string; readonly reason: string }>;
  readonly summary: BoundaryScanSummary;
}

async function listDirectory(directory: string): Promise<string[]> {
  try {
    return (await fs.readdir(directory)).sort();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw error;
  }
}

export async function scanRulesBoundary(dataDir: string): Promise<BoundaryScanReport> {
  const files: Array<{ name: string; file: string }> = [];
  for (const name of await listDirectory(dataDir)) if (name.endsWith(".log.jsonl")) files.push({ name, file: path.join(dataDir, name) });
  const archive = path.join(dataDir, "archive");
  for (const game of await listDirectory(archive)) {
    for (const name of await listDirectory(path.join(archive, game))) {
      if (name.endsWith(".log.jsonl")) files.push({ name: `archive/${game}/${name}`, file: path.join(archive, game, name) });
    }
  }
  const games: GameBoundaryScan[] = [];
  const unreadable: Array<{ file: string; reason: string }> = [];
  for (const { name, file } of files) {
    const bytes = await readOptional(file);
    if (bytes === null) continue;
    const scan = scanLog(bytes);
    if (scan.classification === "corrupt") {
      unreadable.push({ file: name, reason: `corrupt: ${scan.detail}` });
      continue;
    }
    games.push(scanPinnedHistory(name, scan.entries));
  }
  const lock = await lockStatus(dataDir);
  return { dataDir, version: BOUNDARY_SCAN_VERSION, serverRunning: lock.held, games, unreadable, summary: summarizeBoundaryScan(games) };
}

function printBoundaryScan(report: BoundaryScanReport): void {
  const { summary } = report;
  const pins = Object.entries(summary.byPin).map(([pin, n]) => `${n} ${pin}`).join(", ") || "none";
  console.log(`scan-v10 (READ-ONLY) of ${report.dataDir}: ${summary.logs} logs -- ${pins}`);
  if (report.serverRunning) console.log("  note: a game server holds this directory; this is what was on disk when it was read");
  console.log(`  v${report.version} games replayed for inspection: ${summary.scanned} (revenue all-passes seen: ${summary.revenueAllPasses})`);
  console.log(`    A  BeginOperatingRound committed ................ ${summary.counts.A}`);
  console.log(`    B  PassTurn committed inside the auction ........ ${summary.counts.B}`);
  console.log(`    C  SV marked down to $0 and taken (DA-F5) ....... ${summary.counts.C}`);
  console.log(`    F12 revenue all-pass resumed off the holder ..... ${summary.counts.F12}`);
  console.log(`    X  other entries the current engine would refuse  ${summary.counts.X}`);
  console.log(`    D  harmless duplicate answers (informational) ... ${summary.counts.D}`);
  for (const game of report.games) {
    if (!game.scanned) continue;
    const head = `  ${game.name}: ${game.effective} effective entries${game.error ? ` -- REPLAY STOPPED: ${game.error}` : ""}`;
    console.log(game.hits.length === 0 ? `${head}, nothing flagged` : head);
    for (const hit of game.hits) console.log(`    ${hit.pattern.padEnd(3)} #${hit.index} ${hit.kind} [round before: ${hit.roundBefore ?? "?"}] -- ${hit.detail}`);
  }
  for (const bad of report.unreadable) console.log(`  UNREADABLE ${bad.file}: ${bad.reason}`);
  console.log(
    summary.clean && report.unreadable.length === 0
      ? `VERDICT: CLEAN -- no stored v${report.version} entry reads differently under the current engine.`
      : "VERDICT: REVIEW -- the entries above read differently under the current engine; the v11 server holds these games, nothing was changed.",
  );
}

/* ==================================================================
    THE CLI
   ================================================================== */

const USAGE = [
  "usage: gamesDoctor <command> [--data <dir>]",
  "  status                              what the running server reports (ops/status.json)",
  "  inspect [--deep] [--json]           every game classified from its files (server stopped)",
  "  release <game_id> --note \"<text>\"   lift one durable hold after verifying the game (server stopped)",
  "  gc [--apply] [--json]               the conservative lifecycle: a dry run unless --apply (server stopped)",
  "  reconcile-duplicate-code <game_a> <game_b> [--keep <game_id>] --note \"<text>\"",
  "                                      ESCROW-3A: two games held on one join code (server stopped)",
  "  money [<game_id>] [--json] [--escrow-config <file>] [--chain]",
  "                                      ESCROW-3A/3B + LIVE-4: the money games' lifecycle records, chain binding, chain intents and",
  "                                      canonical continuation verdict against the configured escrow (read-only, any time)",
  "  money-release <game_id> --note \"<text>\" [--escrow-config <file>] [--chain]",
  "                                      ESCROW-3A + LIVE-4: lift a held money game this configuration continues (server stopped)",
  "  wallet-grants <game_id> [--json]    JX-3B: one game's wallet grants -- epoch, seat, wallet, proof digests, standing, revoke",
  "                                      reason, freeze; security contexts as fingerprints only (read-only, any time)",
  "  scan-v10 [--json]                   DA-8: the v10 -> v11 boundary scan of every stored log (read-only, any time)",
  "  compat [--escrow-config <file>] [--build <id>]",
  "                                      LIVE-4: this build's canonical compatibility descriptor and key, as canonical JSON",
  "                                      (for the escrow configuration given, or none); the build id is diagnostic only",
  "  continuation [<game_id>] [--json] [--escrow-config <file>] [--chain]",
  "                                      LIVE-4: every stored game's CANONICAL continuation verdict on this build and",
  "                                      configuration -- continues / not continued (why) / conflict (why) / unreadable",
  "                                      artifact -- plus the money seam's own view of each money game (read-only, any time).",
  "                                      Judged as a production pool runs: legacy (unpinned) logs refused, as without",
  "                                      --legacy-logs; `compat` names the key a server with that configuration serves",
  "                                      once its escrow backend opens (the banner and ops/status.json are the authority)",
  "  aws <command> ...                   LIVE-6 L6-3: the AWS (DynamoDB) deployment -- `gamesDoctor aws` lists its commands",
  "                                      (status, game, games read-only; set-primary, claim, take, release -- dry runs unless --apply;",
  "                                      JX-4B: money <game_id> [--chain] [--tx-bytes <intent_id>] -- one money game's evidence, read-only)",
].join("\n");

function line(game: Inspection["games"][number]): string {
  const deep = game.deep ? `  [deep: ${game.deep.cls}${game.deep.ok ? "" : ` -- ${game.deep.reason}`}; ${game.deep.entries} entries, log ${game.deep.logClassification}]` : "";
  return `  ${game.gameId}  ${game.cls.padEnd(12)}${game.code ? ` ${game.code}` : ""}${game.detail ? ` -- ${game.detail}` : ""}${deep}`;
}

async function main(argv: readonly string[]): Promise<number> {
  /* LIVE-6 L6-3: the AWS mode (`gamesDoctor aws ...`) -- DynamoDB, through the deployment's runtime document. Loaded only
     for `aws`: every file-mode command below runs exactly as before and loads no AWS code. */
  if (argv[0] === "aws") {
    const { runAwsOperator } = await import("../aws/operator/operatorMain");
    return runAwsOperator(argv.slice(1), process.env, { out: (line) => console.log(line), err: (line) => console.error(line) });
  }
  const dataAt = argv.indexOf("--data");
  const dataDir = path.resolve(dataAt !== -1 && argv[dataAt + 1] ? argv[dataAt + 1] : (process.env.DATA_DIR ?? path.join(process.cwd(), "data")));
  const noteAt = argv.indexOf("--note");
  const keepAt = argv.indexOf("--keep");
  const configAt = argv.indexOf("--escrow-config");
  const positional = argv.filter((arg, at) => !arg.startsWith("--") && argv[at - 1] !== "--data" && argv[at - 1] !== "--note" && argv[at - 1] !== "--keep" && argv[at - 1] !== "--escrow-config" && argv[at - 1] !== "--build");
  /* LIVE-4 (L4-4): the escrow deployment the money commands judge against (the server's own configuration file). */
  const escrowConfig = configAt !== -1 && argv[configAt + 1] ? argv[configAt + 1] : process.env.ESCROW_JUNO_CONFIG || undefined;
  const toolServing = () => moneyToolServing(dataDir, { configPath: escrowConfig, chain: argv.includes("--chain") });
  const [command, target, second] = positional;
  const json = argv.includes("--json");
  if (command === "status") {
    const raw = await readOptional(path.join(dataDir, OPS_DIRECTORY, STATUS_FILE));
    if (raw === null) {
      console.log(`No status file in ${dataDir} yet (the server writes ${OPS_DIRECTORY}/${STATUS_FILE} once it has started).`);
      return 1;
    }
    console.log(raw.toString("utf8").trim());
    return 0;
  }
  if (command === "scan-v10") {
    const report = await scanRulesBoundary(dataDir);
    if (json) console.log(JSON.stringify(report, null, 2));
    else printBoundaryScan(report);
    return report.summary.clean && report.unreadable.length === 0 ? 0 : 1;
  }
  /* LIVE-4 (L4-6): what compatibility identity a server started with this build and this configuration serves. The
     key is production's (`compatibilityKey` over `servingCapability`); the build id rides along as a diagnostic. */
  if (command === "compat") {
    /* `--build <id>`: printed as the descriptor's diagnostic only (else the environment's, else none). */
    const flagAt = argv.indexOf("--build");
    const { serving } = await moneyToolServing(dataDir, { configPath: escrowConfig, chain: false });
    console.log(compatibilityDescriptorText(operatorDescriptor(serving.capability, flagAt === -1 ? undefined : argv[flagAt + 1])));
    return 0;
  }
  /* LIVE-4 (L4-6): every stored game's canonical continuation verdict, read-only (safe beside a running server: it then
     reads what was on disk at that moment). */
  if (command === "continuation") {
    const { serving, chain } = await toolServing();
    const report = await inspectContinuation(dataDir, { serving, chain, ...(target !== undefined ? { only: target } : {}) });
    if (json) console.log(JSON.stringify(report, null, 2));
    else {
      const lock = await lockStatus(dataDir);
      const counts = Object.entries(report.byClass).map(([cls, n]) => `${n} ${cls}`).join(", ") || "none";
      console.log(`continuation (READ-ONLY) of ${dataDir}: ${report.games.length} games -- ${counts}`);
      console.log(`  judged against compatibility key ${report.compatibility.compatibility_key} (escrow: ${report.compatibility.axes.escrow_deployments.join(", ") || "none configured"})` + (chain === null ? "; chain facts NOT read (add --chain to conclude a deployment conflict)" : chain.kind === "read" ? "; chain facts read at verification grade" : `; chain facts UNAVAILABLE (${chain.detail})`));
      if (lock.held) console.log("  note: a game server holds this directory; this is what was on disk when it was read");
      for (const game of report.games) {
        const a = game.artifacts;
        console.log(
          `  ${game.gameId}  ${game.class}${game.money ? " [money]" : ""}` +
            (game.deal !== null ? ` -- ${game.deal}` : "") +
            `; record ${a.record}, log ${a.log}${a.log_format !== null && a.log_format !== "current" ? ` (${a.log_format})` : ""}` +
            (a.fin !== undefined ? `, financial ${a.fin}, tickets ${a.tickets ?? "-"}, intents ${a.intents ?? "-"}` : "") +
            (game.hold !== null ? `; HELD ${game.hold}` : "") +
            (game.discovery !== null && game.discovery.cls !== "unreconciled" && game.discovery.cls !== "active" && game.discovery.cls !== "waiting" && game.discovery.cls !== "completed" ? `; discovery: ${game.discovery.cls}${game.discovery.code !== null ? ` ${game.discovery.code}` : ""}` : "") +
            (game.damaged_log ? "; the log is DAMAGED: the server holds it at load (logDoctor)" : ""),
        );
        if (game.verdict !== null && game.verdict.detail !== null) console.log(`      ${game.verdict.kind}/${game.verdict.why}: ${game.verdict.detail}`);
        if (game.money_seam !== null) {
          console.log(
            `      money seam    ${game.money_seam.class}; ${game.money_seam.owner ? "owned here" : "not owned here"}; deployment ${game.money_seam.deployment ?? "none named"}` +
              (!game.money_seam.agrees ? " -- DISAGREES WITH THE SESSION VERDICT (a defect: report it)" : game.money_seam.same_reason ? "" : " (the same answer; the money seam names another unreadable artifact first)"),
          );
        }
      }
    }
    return report.games.every((game) => game.class === "continues" && game.hold === null && !game.damaged_log && game.discovery?.cls !== "held" && (game.money_seam === null || game.money_seam.agrees)) ? 0 : 1;
  }
  if (command === "money") {
    const { serving, chain } = await toolServing();
    const money = await inspectMoney(dataDir, target, { serving, chain });
    if (json) console.log(JSON.stringify(money, null, 2));
    else {
      console.log(`money games in ${dataDir}: ${money.games.length}`);
      console.log(
        `  judged against: ${money.against.deployments.length === 0 ? "NO escrow deployment (pass --escrow-config <file> or set ESCROW_JUNO_CONFIG)" : money.against.deployments.join(", ")}` +
          (chain === null ? "; chain facts NOT read (no deployment conflict can be concluded: add --chain)" : chain.kind === "read" ? `; chain facts read at verification grade: code ${chain.facts.code_checksum.slice(0, 16)}…, denom ${chain.facts.denom}` : `; chain facts UNAVAILABLE (${chain.detail})`),
      );
      for (const game of money.games) {
        console.log(
          `  ${game.gameId}  ${game.readable ? (game.phase ?? "?").padEnd(17) : `${game.formats.fin === "missing" ? "MISSING" : game.formats.fin.toUpperCase()}`.padEnd(17)}` +
            ` [${game.class}${game.verdict.kind === "conflict" ? `/${game.verdict.why}` : ""}${game.owner ? "" : game.verdict.kind === "continues" ? "" : ", not owned here"}]` +
            (game.terminal ? ` sealed@${game.terminal.log_len}` : "") +
            (game.intent ? ` intent log_hash ${game.intent.log_hash.slice(0, 16)}… state ${game.intent.appraisal_state_hash.slice(0, 16)}… v${game.intent.rules_engine_version}` : "") +
            (game.hold ? ` HELD ${game.hold.code} (from ${game.hold.from}) -- ${game.hold.detail}` : ""),
        );
        if (game.verdict.detail !== null) console.log(`      verdict       ${game.verdict.kind}/${game.verdict.why}: ${game.verdict.detail}`);
        if (game.formats.tickets !== null || game.formats.intents !== null) console.log(`      formats       record ${game.formats.fin}, tickets ${game.formats.tickets ?? "-"}, intents ${game.formats.intents ?? "-"}`);
        /* ESCROW-3B: the chain side. */
        if (game.continuation !== null) console.log(`      continuation  rules v${game.continuation.rules_engine_version}, hosted ${game.continuation.hosted_protocol}, financial ${game.continuation.financial_protocol}, codec ${game.continuation.settlement_codec}`);
        if (game.binding !== null) console.log(`      binding       ${game.binding.chain_id} (${game.binding.network_class}) ${game.binding.contract} code ${game.binding.code_checksum.slice(0, 16)}… ${game.binding.denom}; chain game ${game.binding.chain_game_id ?? "not bound"}`);
        if (game.roster !== null) console.log(`      roster        ${game.roster.seats} seats, roster ${game.roster.roster_hash.slice(0, 16)}…, domain ${game.roster.domain.slice(0, 16)}…, epoch ${game.roster.epoch}, ${game.roster.freeze} freeze`);
        if (game.chain !== null) {
          const c = game.chain;
          console.log(
            `      chain         started ${c.started_height ?? "no"}; checkpoint prepared ${c.checkpoint_prepared ? `seq ${c.checkpoint_prepared.seq} (log ${c.checkpoint_prepared.log_len}, ${c.checkpoint_prepared.round_key})` : "none"}, confirmed ${c.checkpoint_confirmed ? `seq ${c.checkpoint_confirmed.seq}` : "none"}` +
              `; settle ${c.settle_confirmed ? `seq ${c.settle_confirmed.seq}, window ends ${c.settle_confirmed.window_end_secs}` : "not on chain"}${c.outcome ? `; CLOSED ${c.outcome.state} (${c.outcome.route})` : ""}`,
          );
        }
        if (game.intents_unreadable) console.log("      intents       UNREADABLE (games/chain-intents/): inspect by hand; nothing is submitted for this game");
        for (const intent of game.intents.filter((entry) => entry.status !== "confirmed" && entry.status !== "superseded").concat(game.intents.filter((entry) => entry.status === "confirmed" || entry.status === "superseded").slice(-3))) {
          const n = intent.newest;
          console.log(
            `      ${intent.op.padEnd(10)} ${intent.seq !== null ? `seq ${intent.seq}`.padEnd(10) : "".padEnd(10)} ${intent.evidence}` +
              (n !== null ? ` -- tx ${n.tx_hash.slice(0, 16)}… ${n.phase} at sequence ${n.sequence} (expires above height ${n.timeout_height})${n.inclusion_height ? ` in block ${n.inclusion_height}` : ""}${n.error ? ` ${n.error}` : ""}` : "") +
              (intent.confirmation ? ` [confirmed by ${intent.confirmation.how}${intent.confirmation.tx_hash ? ` ${intent.confirmation.tx_hash.slice(0, 16)}…` : ""}]` : "") +
              (intent.why ? ` (${intent.why})` : ""),
          );
        }
      }
    }
    return money.games.some((game) => !game.readable || game.phase === "held" || game.class !== "continued" || game.intents_unreadable || game.intents.some((intent) => intent.status === "held")) ? 1 : 0;
  }
  /* JX-3B: one game's wallet grants, read-only and redacted (safe beside a running server: what was on disk then). */
  if (command === "wallet-grants") {
    if (!target) {
      console.error(USAGE);
      return 2;
    }
    const view = await collectWalletGrants({
      gameId: target,
      source: "file",
      loadLedger: () => createFileWalletTicketStore(dataDir, { warn: quiet, fs: READ_ONLY }).load(target),
      loadIdentity: () => readFileIdentitySnapshot(dataDir),
      loadRecord: () => createFileRecordStore(dataDir, { warn: quiet, fs: READ_ONLY }).load(target),
      now: Date.now(),
    });
    if (json) console.log(JSON.stringify(view, null, 2));
    else for (const text of walletGrantsText(view)) console.log(text);
    return view.identity.read && view.record.read ? 0 : 1;
  }
  if (command !== "inspect" && command !== "release" && command !== "gc" && command !== "reconcile-duplicate-code" && command !== "money-release") {
    console.error(USAGE);
    return 2;
  }
  const lock = await lockStatus(dataDir);
  if (lock.held) {
    console.error(
      `Refusing: a game server holds ${dataDir} (${describeOwner(lock.owner)}, heartbeat ${Math.round((lock.ageMs ?? 0) / 1000)} s ago). ` +
        "gamesDoctor reads and changes games only while no server runs -- stop it first (`gamesDoctor status` works while it runs).",
    );
    return 2;
  }
  if (command === "inspect") {
    const inspection = await inspectData(dataDir, { deep: argv.includes("--deep") });
    if (json) {
      console.log(JSON.stringify(inspection, null, 2));
    } else {
      const counts = (Object.entries(inspection.byClass) as Array<[string, number]>).filter(([, n]) => n > 0).map(([cls, n]) => `${n} ${cls}`);
      console.log(`${inspection.games.length} games in ${dataDir}${counts.length > 0 ? ` -- ${counts.join(", ")}` : ""}`);
      for (const game of inspection.games) console.log(line(game));
      for (const error of inspection.storeErrors) console.log(`  STORE: ${error}`);
      const id = inspection.identity;
      console.log(
        `identity: ${id.ok ? "OK" : "NOT OK"} -- ${id.detail}` +
          (id.counts ? ` (${id.counts.principals} principals, ${id.counts.profiles} profiles, ${id.counts.sessions} sessions, ${id.counts.links} link codes)` : "") +
          (id.snapshotVersion !== null ? `; snapshot v${id.snapshotVersion} at seq ${id.snapshotSeq}` : "") +
          (id.journal ? `; journal ${id.journal.records} records, ${id.journal.bytes} bytes` : ""),
      );
      if (inspection.legacyFiles > 0) console.log(`legacy: ${inspection.legacyFiles} JUNO-XXX / lobby files (never read by the server, never touched by gc)`);
    }
    const bad = inspection.games.some((game) => game.cls === "held" || game.cls === "unavailable" || (game.deep !== undefined && !game.deep.ok)) || !inspection.identity.ok;
    return bad ? 1 : 0;
  }
  if (command === "release") {
    if (!target || noteAt === -1 || !argv[noteAt + 1]) {
      console.error(USAGE);
      return 2;
    }
    const result = await withLock(dataDir, async (held) => {
      const ops = createFileOpsRecorder(dataDir, { build: TOOL_BUILD, instanceId: held.instanceId, writerCheck: () => held.verify() });
      return releaseHold(dataDir, target, argv[noteAt + 1], { lock: held, ops });
    });
    if ("refused" in result) {
      console.error(`Refusing: ${result.refused}`);
      return 2;
    }
    if (!result.ok) {
      console.error(result.reason);
      return 1;
    }
    console.log(
      `RELEASED ${target} (was held: ${result.releasedCode}). It verifies as ${result.verification.cls}: ${result.verification.entries} entries, logHash ${result.verification.logHash ?? "(empty)"}.\n` +
        "The hold is kept under games/holds/released/, and the audit line is in ops/audit.jsonl. Start the server: the game loads through the full validated load.",
    );
    return 0;
  }
  if (command === "reconcile-duplicate-code" || command === "money-release") {
    if (!target || (command === "reconcile-duplicate-code" && !second) || noteAt === -1 || !argv[noteAt + 1]) {
      console.error(USAGE);
      return 2;
    }
    const outcome = await withLock(dataDir, async (held) => {
      const ops = createFileOpsRecorder(dataDir, { build: TOOL_BUILD, instanceId: held.instanceId, writerCheck: () => held.verify() });
      return command === "money-release"
        ? releaseMoneyHold(dataDir, target, argv[noteAt + 1], { lock: held, ops, serving: (await toolServing()).serving })
        : reconcileDuplicateCode(dataDir, target, second, argv[noteAt + 1], { lock: held, ops, keep: keepAt !== -1 ? argv[keepAt + 1] : undefined });
    });
    if ("refused" in outcome) {
      console.error(`Refusing: ${outcome.refused}`);
      return 2;
    }
    if (!outcome.ok) {
      console.error(outcome.reason);
      return 1;
    }
    console.log(
      "to" in outcome
        ? `RELEASED money game ${target} back to ${outcome.to}. The audit line is in ops/audit.jsonl; the server continues it at its next load.`
        : `RECONCILED join code ${outcome.code}: ${outcome.kept} keeps it, ${outcome.cleared} no longer holds it; released ${outcome.released.join(", ") || "no holds"}. The audit lines are in ops/audit.jsonl.`,
    );
    return 0;
  }
  const apply = argv.includes("--apply");
  const result = apply
    ? await withLock(dataDir, async (held) => runGc(dataDir, { apply: true, lock: held, ops: createFileOpsRecorder(dataDir, { build: TOOL_BUILD, instanceId: held.instanceId, writerCheck: () => held.verify() }) }))
    : await runGc(dataDir, { apply: false });
  if ("refused" in result) {
    console.error(`Refusing: ${result.refused}`);
    return 2;
  }
  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`${result.applied ? "GC" : "GC (dry run -- nothing changed; --apply to act)"} in ${dataDir}`);
    console.log(`  retained live: ${Object.entries(result.retained).map(([cls, n]) => `${n} ${cls}`).join(", ") || "none"}`);
    console.log(`  archive (move to archive/): ${result.move.map((game) => `${game.gameId} (${game.files.length} files)`).join(", ") || "none"}${result.resume.length > 0 ? `; resume ${result.resume.join(", ")}` : ""}`);
    console.log(`  delete (transient only): ${result.temporaries.length} temporaries, ${result.lockAsides.length} old lock asides`);
    console.log("  eligible for deletion under a future policy: none (LIVE-3C deletes no game material)");
    if (result.legacyFiles > 0) console.log(`  legacy: ${result.legacyFiles} JUNO-XXX / lobby files kept`);
    for (const error of result.errors) console.log(`  ERROR: ${error}`);
  }
  return result.errors.length > 0 ? 1 : 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      /* An operator's mistake (a configuration file that cannot be read, say) is one line; anything else keeps its trace. */
      const message = error instanceof Error ? error.message : String(error);
      if (/^the escrow configuration .* cannot be read/.test(message)) console.error(`gamesDoctor: ${message}`);
      else console.error("gamesDoctor failed:", error);
      process.exit(2);
    },
  );
}
