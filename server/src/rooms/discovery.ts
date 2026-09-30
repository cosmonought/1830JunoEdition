// server/src/rooms/discovery.ts
//
// ==================================================================
//  LIVE-3C (brief §4): WHAT IS ON DISK, AND WHAT EACH GAME IS -- FOUND AT STARTUP, WITHOUT LOADING ANY OF THEM
// ==================================================================
//
// A restarted server must not depend on anybody remembering which games existed. So before it serves a single game
// frame it ENUMERATES every durable game -- the union of the game records (`games/<id>.json`), the server-owned logs
// (`<id>.log.jsonl`) and the durable holds (`games/holds/<id>.json`) -- and CLASSIFIES each one (`lifecycle.ts`).
//
// CHEAP ON PURPOSE (the lazy half is the actor's load). Per game discovery reads the record, the hold, and only the
// FIRST LINE of the log: every server-owned game is dealt at index 0, so the deal -- its roster, its rules-engine pin,
// its build -- is there, and a thousand games cost a thousand small reads, not a thousand replays. What needs the
// whole log (a torn tail, damage past it, a foreign actor, whether the board has ended, whether the record's lifecycle
// and seal agree with the last committed entry) is decided when the game is first touched, by the actor's load
// (`gameActor.ts` + `reconcile.ts` `reconcileLoaded`), which writes down any hold it finds. Nothing here instantiates an
// actor, replays a move, truncates a file or rewrites a record.
//
// SO DISCOVERY NEVER CALLS A STARTED GAME HEALTHY. What the first line can PROVE it says: a disagreement (held), an
// unsupported pin (incompatible), a table that was never dealt (an empty log: waiting / cancelled / expired from its
// record). A started game it has not replayed is `unreconciled` (`lifecycle.ts`, stage one) -- its record's claim
// noted in the code, never believed -- until the load reconciles it.
//
// WHAT DISCOVERY DOES WRITE: a durable hold for a game whose record and deal already disagree (create-if-absent, so a
// restart finds the same hold again, never a second opinion), and the join-code index where it disagrees with the
// records (the records are the authority; the index is derived). Both are audited. LIVE-5 L5-3: under POOL ownership
// (DynamoDB) it writes NOTHING (`readOnly`): it runs before any claim, and a write to a game this task has not claimed is
// not this task's to make.
//
// ONE BAD GAME NEVER STOPS THE OTHERS. Every per-game failure is caught and classified -- `held` for evidence that
// something is wrong, `unavailable` for a read that failed and may succeed next time, `attention` for material no
// player can reach -- and the scan moves on. Only a store that cannot be LISTED is reported as a store-level fault.

import type { LogHeadRead } from "../fileLogStore";
import { isStoreCorrupt, isStoreIncompatible } from "../persistence/storeResult";
import type { OpsRecorder } from "../persistence/opsRecorder";
import type { GameRecord } from "./gameRecord";
import { HoldUnreadableError, makeHold, type HoldStore } from "./holdStore";
import { classOfRecord, type GameClass, type HoldCode } from "./lifecycle";
import type { IndexReconciliation, RecordStore } from "./recordStore";
import { dealInfoOf, reconcileHead } from "./reconcile";
import { SUPPORTED_RULES_ENGINE_VERSIONS } from "../../../frontend/src/gameEngine/rulesVersion";
import { gameIdentityOfDeal, type GameIdentityFacts } from "../../../frontend/src/gameEngine/compat/continuationIdentity";
import type { ContinuationVerdict, FormatFact, NotContinuedWhy } from "../../../frontend/src/gameEngine/compat/continuationVerdict";
import { dealFormatOf, historyNotReadHere, localContinuationVerdict } from "../../../frontend/src/gameEngine/compat/sessionContinuation";

export type DiscoveryCode =
  | HoldCode
  | "rules-version-older"
  | "rules-version-newer"
  | "record-schema-newer"
  /* LIVE-4 (L4-2): every other reason the gameplay verdict gives for not continuing a deal (derived, never a hold) */
  | Exclude<NotContinuedWhy, "rules-not-supported">
  /* unreconciled (stage one, `lifecycle.ts`): what the record claims, or why only the load can decide */
  | "claims-active"
  | "claims-completed"
  | "needs-repair"
  | "log-head-unreadable"
  | "log-head-unknown"
  | "orphan-log"
  | "read-failed";

export interface DiscoveredGame {
  readonly gameId: string;
  readonly cls: GameClass;
  /** Why, for every class but the plain healthy/terminal ones. */
  readonly code: DiscoveryCode | null;
  /** Operator-facing. Never a principal id. */
  readonly detail: string | null;
  /** The record as read (null when there is none, or it cannot be read). */
  readonly record: GameRecord | null;
  /** The log's size in bytes (0 when there is none). */
  readonly logBytes: number;
}

export interface DiscoveryReport {
  readonly games: ReadonlyMap<string, DiscoveredGame>;
  readonly index: IndexReconciliation | null;
  /** Store-level faults (a directory that could not be listed): the scan continued with what it could read. */
  readonly storeErrors: readonly string[];
  /** Holds this scan wrote down. */
  readonly holdsCreated: number;
  readonly startedAt: number;
  readonly finishedAt: number;
}

export interface DiscoveryDeps {
  readonly records: RecordStore;
  readonly logs: { listGameLogs?(): Promise<string[]>; readHead?(gameId: string): Promise<LogHeadRead> };
  readonly holds: HoldStore;
  /** Stamped on a hold this scan writes (diagnostic: which server found it). Never a classification input. */
  readonly build: string;
  readonly rulesEngineVersion: number;
  /** LIVE-4 (L4-2): the POOL'S gameplay verdict for a deal read from a log's first line (`ContinuationWiring.
   *  gameplayVerdictOf`): the deal's rules pin and hosted protocol against the pool's capability, with the deal line's
   *  own format fact (T-25: a rules revision above this build's, `dealFormatOf`). Money facts are the load's (the full
   *  verdict), so discovery never calls a money game continued -- it leaves it unreconciled. Absent (an offline tool):
   *  this code's own gameplay half (`localContinuationVerdict`, refusing legacy logs). */
  readonly gameplayVerdict?: (identity: GameIdentityFacts, log?: FormatFact) => ContinuationVerdict;
  /** LIVE-4 (L4-2): the rules engines the pool plays (its capability's `rules.supported`), for #1520's direction code
   *  (`rules-version-newer` / `-older`) on a pin it does not play. Absent: this code's own. */
  readonly rulesSupported?: readonly number[];
  readonly now: () => number;
  readonly warn: (line: string) => void;
  readonly ops: OpsRecorder;
  /** Games classified at once (8 when absent). */
  readonly concurrency?: number;
  /** How long one game's reads may take before it is classed `unavailable` and the scan moves on (10 s when absent). */
  readonly perGameTimeoutMs?: number;
  /** LIVE-5 L5-3 (POOL ownership, preflight §13 step 3, F-L5-10): discovery runs before this task has claimed anything, so
   *  it WRITES NOTHING -- a hold it finds is reported (the lobby's classification), never written; the game's load, after
   *  its claim, decides from what it reads then (its durable hold, and its own reconciliation, which writes any hold it
   *  finds). The join-code index is left as found (its rebuild is an operator command in AWS). Absent / false: today's
   *  behaviour. */
  readonly readOnly?: boolean;
}

export const DISCOVERY_PER_GAME_TIMEOUT_MS = 10_000;

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** LIVE-4 (L4-2): the `SetupGame` body of a deal entry's payload (`undefined` when it is not one; the caller has already
 *  found a deal there, so that answer never reaches the verdict). */
function setupOf(payload: string): unknown {
  try {
    const parsed = JSON.parse(payload) as unknown;
    return typeof parsed === "object" && parsed !== null && "SetupGame" in parsed ? (parsed as { SetupGame: unknown }).SetupGame : undefined;
  } catch {
    return undefined;
  }
}

/** The healthy / terminal classes: no code, no detail. */
const plain = (gameId: string, cls: GameClass, record: GameRecord | null, logBytes: number): DiscoveredGame => ({ gameId, cls, code: null, detail: null, record, logBytes });
/** Stage one: discovered, not yet reconciled against the whole log. */
const unreconciled = (gameId: string, code: DiscoveryCode, detail: string, record: GameRecord, logBytes: number): DiscoveredGame => ({ gameId, cls: "unreconciled", code, detail, record, logBytes });

export async function discoverGames(deps: DiscoveryDeps): Promise<DiscoveryReport> {
  const startedAt = deps.now();
  const storeErrors: string[] = [];
  const listed = async (what: string, list: (() => Promise<string[]>) | undefined): Promise<string[]> => {
    if (list === undefined) return [];
    try {
      return await list();
    } catch (error) {
      storeErrors.push(`${what} could not be listed: ${describe(error)}`);
      return [];
    }
  };
  const ids = new Set<string>([
    ...(await listed("the game records", () => deps.records.list())),
    ...(await listed("the game logs", deps.logs.listGameLogs?.bind(deps.logs))),
    ...(await listed("the holds", () => deps.holds.list())),
  ]);
  const games = new Map<string, DiscoveredGame>();
  let holdsCreated = 0;

  const holdIt = async (gameId: string, code: HoldCode, detail: string, record: GameRecord | null, logBytes: number): Promise<DiscoveredGame> => {
    const hold = makeHold({
      gameId,
      code,
      detail,
      at: deps.now(),
      source: "discovery",
      build: deps.build,
      rulesEngineVersion: deps.rulesEngineVersion,
      evidence: { record_version: record?.record_version ?? null, record_status: record?.status ?? null, log_bytes: logBytes },
    });
    /* LIVE-5 L5-3: a read-only scan writes nothing; the hold is reported, enforced in memory, and written at the load. */
    if (deps.readOnly === true) return { gameId, cls: "held", code, detail, record, logBytes };
    try {
      const created = await deps.holds.create(hold);
      if (created.outcome.kind === "committed" && created.existing === null) {
        holdsCreated += 1;
        deps.ops.audit("hold.created", { game_id: gameId, code, detail, source: "discovery" });
      } else if (created.outcome.kind !== "committed") {
        deps.warn(`  discovery: ${gameId}: the hold (${code}) could not be written down (${created.outcome.detail}); it is held for this run, and found again at the next start`);
      }
    } catch (error) {
      deps.warn(`  discovery: ${gameId}: the hold (${code}) could not be written down (${describe(error)})`);
    }
    return { gameId, cls: "held", code, detail, record, logBytes };
  };

  async function classify(gameId: string): Promise<DiscoveredGame> {
    /* 1. A durable hold decides, whatever the files look like now. */
    let heldBy: { code: HoldCode; detail: string } | null = null;
    try {
      const hold = await deps.holds.load(gameId);
      if (hold !== null) heldBy = { code: hold.code, detail: hold.detail };
    } catch (error) {
      if (!(error instanceof HoldUnreadableError)) return { gameId, cls: "unavailable", code: "read-failed", detail: `its hold could not be read: ${describe(error)}`, record: null, logBytes: 0 };
      heldBy = { code: "hold-unreadable", detail: describe(error) };
    }
    /* 2. The log's head: its size and its first line (the deal), read-only. A store that cannot peek at its logs (the
       in-memory one) leaves the head UNKNOWN -- nothing is judged against a log discovery could not see; the load does. */
    let head: LogHeadRead = { present: false, size: 0, first: undefined };
    const headKnown = deps.logs.readHead !== undefined;
    if (deps.logs.readHead) {
      try {
        head = await deps.logs.readHead(gameId);
      } catch (error) {
        return { gameId, cls: "unavailable", code: "read-failed", detail: `its log could not be read: ${describe(error)}`, record: null, logBytes: 0 };
      }
    }
    /* 3. The record. */
    let record: GameRecord | null = null;
    try {
      record = await deps.records.load(gameId);
    } catch (error) {
      if (heldBy !== null) return { gameId, cls: "held", code: heldBy.code, detail: heldBy.detail, record: null, logBytes: head.size };
      if (isStoreIncompatible(error)) return { gameId, cls: "incompatible", code: "record-schema-newer", detail: describe(error), record: null, logBytes: head.size };
      if (isStoreCorrupt(error)) return holdIt(gameId, "record-unreadable", describe(error), null, head.size);
      return { gameId, cls: "unavailable", code: "read-failed", detail: `its record could not be read: ${describe(error)}`, record: null, logBytes: head.size };
    }
    if (heldBy !== null) return { gameId, cls: "held", code: heldBy.code, detail: heldBy.detail, record, logBytes: head.size };
    if (record === null) {
      /* A log with no record: no seat, no host, nobody can be authorized to read it -- never served, never deleted. */
      return head.present
        ? { gameId, cls: "attention", code: "orphan-log", detail: `a log of ${head.size} bytes with no game record`, record: null, logBytes: head.size }
        : plain(gameId, "attention", null, 0);
    }
    /* 4. LIVE-4 (L4-2): THE POOL'S GAMEPLAY VERDICT ON THE DEAL LINE -- the canonical verdict on the deal's semantic
       identity (its rules pin AND its hosted protocol, absent = 1) against the pool's capability, with the deal line's
       own format fact (T-25: a rules revision above this build's). A deal whose server-stamped fields are not versions
       at all is `malformed`. The deal's build is not read. DERIVED, like every "not continued": no hold file, and a
       rules pin keeps #1520's codes (`rules-version-newer` / `-older`, against the pool's own rules). The rest of T-25
       -- a message kind this build does not know -- needs the whole log: the load's verdict says it. */
    const deal = head.first ? dealInfoOf(head.first) : null;
    let gameplay: ContinuationVerdict | null = null;
    if (deal && deal.pin !== null && head.first) {
      const setup = setupOf(head.first.payload);
      const identity = gameIdentityOfDeal(setup);
      const log: FormatFact = identity.kind === "dealt" ? dealFormatOf(setup) : "current";
      gameplay = (deps.gameplayVerdict ?? ((facts: GameIdentityFacts, format?: FormatFact) => localContinuationVerdict(facts, { legacyLogs: "refuse" }, format)))(identity, log);
    }
    const pin = deal?.pin ?? null;
    const notContinued = (verdict: Exclude<ContinuationVerdict, { readonly kind: "continues" }>): DiscoveredGame => {
      if (verdict.kind === "not-continued" && verdict.why === "rules-not-supported" && pin !== null) {
        const newest = Math.max(...(deps.rulesSupported ?? SUPPORTED_RULES_ENGINE_VERSIONS));
        const code: DiscoveryCode = pin > newest ? "rules-version-newer" : "rules-version-older";
        return { gameId, cls: "incompatible", code, detail: `dealt under rules-engine version ${pin}`, record, logBytes: head.size };
      }
      return { gameId, cls: "incompatible", code: verdict.why as DiscoveryCode, detail: verdict.detail, record, logBytes: head.size };
    };
    /* A deal whose HISTORY this pool does not read at all (another hosted protocol, a newer or an older build's
       format) is never judged by this pool's reading of it: the record-against-deal checks below would read it under
       this pool's meaning, and a hold concluded from a misreading would freeze the game for the pool that continues it
       (`HISTORY_NOT_READ_HERE`). Derived; nothing is written. */
    if (gameplay !== null && gameplay.kind !== "continues" && historyNotReadHere(gameplay)) return notContinued(gameplay);
    /* 5. The record against the deal (`reconcile.ts`, tier 1): a disagreement the first line already proves is held. */
    const verdict = reconcileHead(record, { present: head.present, first: head.first });
    if (verdict.kind === "hold") return holdIt(gameId, verdict.code, verdict.detail, record, head.size);
    const base = classOfRecord(record, deps.now());
    /* A pin (or a hosted protocol, or a deal) this pool does not continue is FAIL-CLOSED from the deal alone: nothing
       later in the log can make it playable here. (The load may still find the file damaged and hold it instead --
       both refuse everything.) Checked BEFORE the archive mark (review E1): lifecycle tooling never acts on a game
       this build cannot interpret, archived or not. */
    if (gameplay !== null && gameplay.kind !== "continues") return notContinued(gameplay);
    /* `archived_at` is record-owned (set only by this lifecycle, on a reconciled record) and an archived game is served
       to nobody -- every reader is told it is gone -- so it needs nothing more from its log. */
    if (base === "archived") return plain(gameId, base, record, head.size);
    /* 6. TWO STAGES (`lifecycle.ts`): only a table whose log is known to be EMPTY is classified from its record here --
       there is no history for the record to disagree with (a record that claims one was held above). Everything else
       -- a deal on the first line, a first line that does not parse, a log this store cannot peek at -- needs facts
       from the whole log, so it is `unreconciled` until its first load: the record's claim is noted, never believed. */
    if (headKnown && !head.present) return plain(gameId, base, record, head.size);
    /* LIVE-4 (L4-2): the dealing build is noted for the operator as HISTORY (a forensic replay's image); it no longer
       makes a game read-only (#1252 is retired: continuation follows the deal's rules pin and hosted protocol). */
    const pinned = deal && deal.build !== null && deal.build !== deps.build ? `; dealt on build "${deal.build}", this server is "${deps.build}" (diagnostic only)` : "";
    if (!headKnown) return unreconciled(gameId, "log-head-unknown", `this store cannot read a log's head; the record says ${base}`, record, head.size);
    if (head.first === undefined || deal === null) return unreconciled(gameId, "log-head-unreadable", `the log has ${head.size} bytes and its first line is not a whole deal (the load scans it); the record says ${base}`, record, head.size);
    if (verdict.kind === "repair") return unreconciled(gameId, "needs-repair", `the record lags its log's deal: ${verdict.fields.join(", ")}${pinned}`, record, head.size);
    return unreconciled(
      gameId,
      base === "completed" ? "claims-completed" : "claims-active",
      `dealt; the record says ${base} -- not believed until the load replays the whole log${pinned}`,
      record,
      head.size,
    );
  }

  /* Bounded fan-out: a handful of games at a time, every failure contained to its game. */
  const queue = [...ids].sort();
  const workers = Array.from({ length: Math.max(1, Math.min(deps.concurrency ?? 8, queue.length)) }, async () => {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      const gameId = next;
      /* A read that never answers (a hung mount, a FIFO where a log should be) stalls ONE game, never the start
         (review E5): past the per-game timeout the game is `unavailable` -- tried again when it is first asked for. */
      const limit = deps.perGameTimeoutMs ?? DISCOVERY_PER_GAME_TIMEOUT_MS;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<DiscoveredGame>((resolve) => {
        timer = setTimeout(
          () => resolve({ gameId, cls: "unavailable", code: "read-failed", detail: `its files did not answer within ${limit} ms at startup`, record: null, logBytes: 0 }),
          limit,
        );
      });
      try {
        games.set(gameId, await Promise.race([classify(gameId), late]));
      } catch (error) {
        games.set(gameId, { gameId, cls: "unavailable", code: "read-failed", detail: describe(error), record: null, logBytes: 0 });
      } finally {
        clearTimeout(timer);
      }
    }
  });
  await Promise.all(workers);

  /* 5. Two LIVE records holding one join code (§14.4 item 8): both held -- neither is guessed to be the owner. */
  const byCode = new Map<string, string[]>();
  for (const game of games.values()) {
    const record = game.record;
    if (record === null || record.join_code === null || record.archived_at !== null) continue;
    if (game.cls === "cancelled" || game.cls === "expired" || game.cls === "archived") continue;
    byCode.set(record.join_code, [...(byCode.get(record.join_code) ?? []), game.gameId]);
  }
  for (const [code, holders] of byCode) {
    if (holders.length < 2) continue;
    for (const gameId of holders) {
      const game = games.get(gameId) as DiscoveredGame;
      if (game.cls === "held") continue;
      games.set(gameId, await holdIt(gameId, "duplicate-join-code", `join code ${code} is held by ${holders.length} live records`, game.record, game.logBytes));
    }
  }

  /* 6. The join-code index, made to agree with the records (the authority): every live record's code resolves to it. */
  let index: IndexReconciliation | null = null;
  if (deps.records.reconcileIndex && deps.readOnly !== true) {
    const live = new Map<string, string>();
    for (const game of games.values()) {
      const record = game.record;
      if (record === null || record.join_code === null || record.archived_at !== null) continue;
      if (game.code === "duplicate-join-code") continue;
      live.set(record.join_code, game.gameId);
    }
    try {
      index = await deps.records.reconcileIndex(live);
      if (index.rebuilt || index.added > 0 || index.repointed > 0) {
        deps.ops.audit("index.reconciled", { rebuilt: index.rebuilt, added: index.added, repointed: index.repointed, orphans: index.orphans, outcome: index.outcome.kind });
      }
      if (index.outcome.kind !== "committed") storeErrors.push(`the join-code index could not be written: ${index.outcome.detail}`);
    } catch (error) {
      storeErrors.push(`the join-code index could not be reconciled: ${describe(error)}`);
    }
  }

  return { games, index, storeErrors, holdsCreated, startedAt, finishedAt: deps.now() };
}

/** Counts by class, every class present (zero when none). */
export function countByClass(games: Iterable<{ readonly cls: GameClass }>): Record<GameClass, number> {
  const counts = {
    unreconciled: 0,
    waiting: 0,
    active: 0,
    completed: 0,
    cancelled: 0,
    expired: 0,
    archived: 0,
    held: 0,
    incompatible: 0,
    "read-only": 0,
    unavailable: 0,
    attention: 0,
  } satisfies Record<GameClass, number>;
  for (const game of games) counts[game.cls] += 1;
  return counts;
}

/** The one startup line an operator reads first. */
export function summaryLine(report: DiscoveryReport): string {
  const counts = countByClass(report.games.values());
  const parts = (Object.entries(counts) as Array<[GameClass, number]>).filter(([, n]) => n > 0).map(([cls, n]) => `${n} ${cls}`);
  const took = report.finishedAt - report.startedAt;
  return `  discovery: ${report.games.size} game${report.games.size === 1 ? "" : "s"} found${parts.length > 0 ? ` -- ${parts.join(", ")}` : ""} (${took} ms)`;
}
