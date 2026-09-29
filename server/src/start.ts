// server/src/start.ts
//
// The entry point. Reads its settings from the environment and starts one server.
//
// ==================================================================
//  DESIGN NOTE 1213: THE PROCESS, AND THE ONE SETTING THAT MATTERS
// ==================================================================
//
// `createGameServer` takes an identity configuration and has no default (#1210), which means this file has to
// choose one -- and choosing is exactly what an entry point is for.
//
// LIVE-2B: THE CHOICE IS `GS_MODE`, AND IT HAS NO DEFAULT (`identity/mode.ts`). `development` runs the loopback-only
// development authenticator (`?dev_claim=`, local tabs only -- NEVER behind a tunnel); `production` authenticates
// the `__Host-gs_session` cookie and refuses to start, exit 2, on any insecure setting. A missing or invalid mode is
// exit 2 too. Every check built in Phase 2 rests on the server knowing who is speaking, so a process that is not
// told how to know refuses rather than guesses.
//
// Usage (local play, two tabs on this machine):
//   GS_MODE=development BUILD_ID=$(git rev-parse --short HEAD) node dist/server/src/start.js
//   node dist/server/src/start.js --mode development --build dev          (PowerShell / cmd)

import * as path from "path";

import { createGameServer, GAME_SERVER_BIND_HOST } from "./gameServer";
import { createFileRecordStore } from "./rooms/recordStore";
import { createFileLogStore } from "./fileLogStore";
import { SESSION_COOKIE_NAME } from "./identity/cookies";
import { createDevAuthenticator } from "./identity/devAuthenticator";
import { createJournalIdentityStore, type JournalIdentityStore } from "./identity/journalStore";
import { createFileHoldStore } from "./rooms/holdStore";
import { createFileFinancialGameStore } from "./escrow/financialGameStore";
import { thisDeploymentCapability } from "./deploymentCapability";
import { createSettlementCoordinator } from "./escrow/settlementCoordinator";
import { serverPrefixReplay } from "./escrow/settlementEvidence";
import { createFileChainIntentStore } from "./escrow/chainIntents";
import { openFileSigningJournal } from "./escrow/signingJournal";
import { createFileWalletTicketStore } from "./escrow/walletTicketFileStore";
import { createWalletTicketLedger } from "./escrow/walletTickets";
import { JunoConfigError, parseJunoBackendConfig, pinOf, type JunoBackendConfig } from "./escrow/juno/junoConfig";
import { openJunoBackend, type JunoBackend } from "./escrow/juno/junoBackend";
import { createMoneyTables, MONEY_TABLES_SWITCH, type MoneyTables } from "./escrow/moneyTables";
import type { WalletTicketLedger } from "./escrow/walletTickets";
import { seatOf } from "./rooms/gameRecord";
import { NoMoneyRosterSource } from "./rooms/roomService";
import { APP_NAME } from "../../frontend/src/config";
import { createFileOpsRecorder } from "./persistence/opsRecorder";
import { resolveServerConfig } from "./identity/mode";
import { IdentityService } from "./identity/sessions";
import { DEFAULT_INGRESS_LIMITS } from "./ingress/limits";
import { acquireDataLock, LOCK_STALE_AFTER_MS, type DataLock } from "./persistence/processLock";
import { RULES_ENGINE_VERSION, SUPPORTED_RULES_ENGINE_VERSIONS } from "../../frontend/src/gameEngine/rulesVersion";

/* ==================================================================
    FLAGS AS WELL AS ENVIRONMENT, AND THE REASON IS WINDOWS
   ==================================================================
   `FOO=1 npm start` is shell syntax that PowerShell and cmd do not have, so an instruction written that way
   works for half the people who read it and quietly fails for the other half. Flags work everywhere.
   THE ENVIRONMENT STILL WINS WHERE IT IS SET, because that is what a deployment will use. */
const flags = process.argv.slice(2);
const flagValue = (name: string): string | undefined => {
  const at = flags.indexOf(name);
  return at >= 0 ? flags[at + 1] : undefined;
};

const port = Number(process.env.PORT ?? flagValue("--port") ?? 8917);

/** MUST MATCH THE CLIENT'S `REACT_APP_BUILD_ID` (#1206), and the two are compared exactly. A mismatch is
 *  answered with `build-skew` rather than treated as a divergence -- but only if both sides were told. */
const build = process.env.BUILD_ID ?? flagValue("--build") ?? "dev";

/* ==================================================================
    LIVE-2B (LIVE-2 §4.8): THE MODE, AND EVERY INSECURE SETTING PRODUCTION REFUSES -- BEFORE ANYTHING ELSE RUNS
   ==================================================================
   Refused, never warned about: exit 2 with the reason. See `identity/mode.ts` for the whole list. */
const resolved = resolveServerConfig(flags, process.env);
if (!resolved.ok) {
  // eslint-disable-next-line no-console
  console.error(`Refusing to start: ${resolved.reason}`);
  process.exit(2);
}
const config = resolved.config;
/* ==================================================================
    LIVE-2D (LIVE-2 §13.4 step 4): PRODUCTION IS STARTABLE -- THE LEGACY ROOM PROTOCOL IS GONE
   ==================================================================
   LIVE-2C refused `GS_MODE=production` here while the build still carried the legacy room handlers. LIVE-2D deleted
   them (`LEGACY_ROOM_HANDLERS` is empty and pinned so by a test), so a production start with a valid, secure
   configuration now runs -- every LIVE-2B refusal above is unchanged: the mode is required, insecure flags exit 2,
   origins must be https and exact, the trusted proxy hops must be stated, and the development authenticator can
   never be built here. */
/* `createDevAuthenticator` reads GS_MODE at call time; a mode given as `--mode` is made the environment's too. */
process.env.GS_MODE = config.mode;

/** #1250: where the rooms live between restarts. A directory beside the server by default, so `cat` is the
 *  whole of the tooling needed to read a game back; `--data <dir>` or `DATA_DIR` to put it elsewhere. */
const dataDir = path.resolve(process.env.DATA_DIR ?? flagValue("--data") ?? path.join(process.cwd(), "data"));

/* #1520: THE ONE WAY A ROOM DEALT BEFORE RULES-ENGINE VERSIONING IS LOADED. Absent, such a room is held: a
   deal with no `rules_engine_version` is never read as "the current version". `--legacy-logs
   development-corpus` (or `LEGACY_LOGS=development-corpus`) admits the local playtest rooms under the engine
   this process carries, and says so at startup and per room -- in DEVELOPMENT mode only (LIVE-2B: production
   refuses it). Parsed with the mode, in `identity/mode.ts`; any other value is refused there. */
const legacyLogs = config.legacyLogs;

/* ==================================================================
    LIVE-3B (§8.8, F-12): ONE SERVER PER DATA DIRECTORY
   ==================================================================
   Two servers on one `data/` fork every log they both write. So before anything is read, this process takes the
   directory's lock (`persistence/processLock.ts`): a lock directory with a heartbeat, taken over only when its
   heartbeat is stale, by an atomic rename only one racer can win. Refused -> exit 2, like every other startup
   refusal here. Lost later (another process took it over) -> this one is FENCED and exits 3 at once, writing
   nothing more. A write the store cannot settle even by redoing it -> exit 4 after telling the table: the load
   after a restart is the only safe way to learn what the disk holds (§8.2 step 7, the fsyncgate rule). */
const EXIT_LOCK_REFUSED = 2;
const EXIT_FENCED = 3;
const EXIT_STORE_UNCERTAIN = 4;

let lock: DataLock | null = null;
let stopping = false;

async function main(): Promise<void> {
  const acquired = await acquireDataLock(dataDir, {
    // eslint-disable-next-line no-console
    log: (line) => console.warn(line),
    onLost: (reason) => {
      // eslint-disable-next-line no-console
      console.error(
        `\nFENCED: ${reason}\nAnother game server owns ${dataDir} now. This process stops writing and exits (${EXIT_FENCED}).`,
      );
      process.exit(EXIT_FENCED);
    },
  });
  if (!acquired.ok) {
    // eslint-disable-next-line no-console
    console.error(
      [
        `Refusing to start: ${acquired.reason}.`,
        "",
        "Only one game server may use a data directory at a time. If that server is still running, stop it first",
        "(or pass --data <another directory>). If it crashed, its lock goes stale after " +
          `${LOCK_STALE_AFTER_MS / 1000} s without a heartbeat and the next start takes it over.`,
      ].join("\n"),
    );
    process.exit(EXIT_LOCK_REFUSED);
  }
  const held = acquired.lock;
  lock = held;
  if (acquired.tookOver) {
    // eslint-disable-next-line no-console
    console.warn(
      `  took over a stale data-directory lock (no heartbeat for ${Math.round(acquired.tookOver.ageMs / 1000)} s` +
        `${acquired.tookOver.previous ? `, last held by pid ${acquired.tookOver.previous.pid} on ${acquired.tookOver.previous.host}` : ""})`,
    );
  }

  const failFast = (room: string, detail: string) => {
    if (stopping) return;
    stopping = true;
    // eslint-disable-next-line no-console
    console.error(
      `\nSTORE UNCERTAIN in ${room}: ${detail}\n` +
        "The server could not confirm that a write reached the disk, even after redoing it. It stops now rather than\n" +
        "write anything behind it; restart it, and the load will read what the disk really holds (LIVE-3 §8.2).",
    );
    // A moment for the `unavailable` frames already queued to reach the table, then out.
    setTimeout(() => {
      held.releaseSync();
      process.exit(EXIT_STORE_UNCERTAIN);
    }, 1_500).unref();
  };

  /* LIVE-3C: the operator's audit lines and status snapshot (`ops/`), written only while this process holds the lock. */
  const ops = createFileOpsRecorder(dataDir, { build, instanceId: held.instanceId, writerCheck: () => held.verify() });

  /* LIVE-2B: principals and sessions live beside the rooms, under the same lock -- written only for guests who own
     something (activation), durably, and a file that cannot be read without guessing refuses the start.
     LIVE-3C (M3): as a SNAPSHOT and a JOURNAL (`identity/journalStore.ts`): each change is one synced line, checked
     against an index in O(the change), folded into a new snapshot every thousand changes. A LIVE-2E `identity.json` is
     migrated at this load, before any line is written, so an older server refuses the directory rather than miss the
     journal. */
  let identity: IdentityService;
  let identityStore: JournalIdentityStore;
  try {
    identityStore = createJournalIdentityStore(dataDir, {
      writerCheck: () => held.verify(),
      onRestartRequired: (detail) => failFast("the identity store", detail),
      onCompacted: (info) => ops.audit("identity.compacted", { seq: info.seq, records: info.records, bytes: info.bytes }),
    });
    identity = await IdentityService.open(identityStore);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(`Refusing to start: the identity store in ${dataDir} cannot be read -- ${error instanceof Error ? error.message : String(error)}`);
    held.releaseSync();
    process.exit(EXIT_LOCK_REFUSED);
  }
  /* ESCROW-3A: the money lifecycle (`escrow/`): one durable record per money game (`games/money/`), the settlement seam
     made idempotent by (game, seal.log_len) and crash-safe by a startup walk, and the continuation policy for funded
     games across builds. Money games are DISABLED (every record's `money` is null), so all of this is inert today: no
     game is financial, `games/money/` is never created, nothing is loaded for it. */
  const financialStore = createFileFinancialGameStore(dataDir, { writerCheck: () => held.verify() });
  /* LIVE-3B: the log store is hoisted so the escrow service reads a sealed game's durable log through the SAME store the
     game server writes (its reads are serialized with its appends). */
  const logStore = createFileLogStore(dataDir, { onRestartRequired: failFast, writerCheck: () => held.verify() });

  /* ==================================================================
      ESCROW-3B: THE JUNO FINANCIAL BACKEND -- ONLY WHEN CONFIGURED, AND NEVER A PLAYER PATH
     ==================================================================
     `ESCROW_JUNO_CONFIG=<file>` (or `--escrow-config <file>`) names the backend's configuration (`escrow/juno/
     junoConfig.ts`: no secrets; key references or development key-file paths). Absent: nothing below exists. Present:
     a configuration that does not check refuses the start in production (exit 2) and is switched off in development;
     the backend then stays UNVERIFIED -- signing and broadcasting nothing -- until the chain agrees with every pin.
     Money games stay DISABLED to players either way (a stake is refused; ESCROW-4 builds the player flow). */
  const escrowConfigPath = process.env.ESCROW_JUNO_CONFIG ?? flagValue("--escrow-config");
  let escrow: JunoBackend | null = null;
  const serverRef: { current: ReturnType<typeof createGameServer> | null } = { current: null };
  /* ESCROW-4: REAL-MONEY TABLES, behind the operator's explicit switch -- `ESCROW_MONEY_TABLES=nonmainnet` (or
     `--money-tables nonmainnet`) -- AND a configured, verified Juno backend that is not mainnet. Anything else: no money
     table can be created (`money-games-disabled`); tables that exist keep their money actions while the backend runs.
     Production stays fail-closed: its keys are KMS (LIVE-5), so its backend does not open in this build. */
  const moneySwitch = process.env.ESCROW_MONEY_TABLES ?? flagValue("--money-tables");
  const moneyRef: { current: MoneyTables | null } = { current: null };
  let junoConfigUsed: JunoBackendConfig | null = null;
  let ledgerUsed: WalletTicketLedger | null = null;
  if (moneySwitch !== undefined && moneySwitch !== MONEY_TABLES_SWITCH) {
    // eslint-disable-next-line no-console
    console.warn(`  money: ESCROW_MONEY_TABLES=${moneySwitch} is not "${MONEY_TABLES_SWITCH}"; real-money tables stay OFF`);
  }
  if (escrowConfigPath !== undefined) {
    try {
      const { readFileSync } = await import("fs");
      const junoConfig = parseJunoBackendConfig(JSON.parse(readFileSync(path.resolve(escrowConfigPath), "utf8")), { serverMode: config.mode, dataDir });
      const ledger = createWalletTicketLedger({
        store: createFileWalletTicketStore(dataDir, { writerCheck: () => held.verify() }),
        standing: (context) => identity.securityStanding(context),
        /* No rebind exists: this is a consistency check on the GameRecord (never a transfer). */
        holdsSeat: (gameId, principalId, playerId) => {
          const record = serverRef.current?.lifecycle.financialRecords().find((entry) => entry.game_id === gameId);
          return record !== undefined && seatOf(record, principalId)?.player_id === playerId;
        },
        now: () => Date.now(),
      });
      /* ESCROW-3A F-2 / ESCROW-3B §15: a security event is recorded against the tickets it ends (standing is derived
         from identity anyway, so a lost event loses nothing). */
      identity.setHooks({
        onSecurityEvent: (event) => {
          void ledger
            .gamesOfPrincipal(event.principalId)
            .then(async (games) => {
              for (const gameId of games) {
                const ended = await ledger.revokeForSecurityEvent(gameId);
                if (ended > 0) ops.audit("wallet-ticket.revoked", { game_id: gameId, kind: event.kind, tickets: ended });
              }
            })
            .catch(() => undefined)
            /* ESCROW-4 (W-8): every money table the principal sits at is re-projected and pushed at once. */
            .finally(() => moneyRef.current?.onSecurityEvent(event.principalId));
        },
      });
      escrow = await openJunoBackend({
        config: junoConfig,
        serverMode: config.mode,
        financial: financialStore,
        intents: createFileChainIntentStore(dataDir, { writerCheck: () => held.verify() }),
        journal: await openFileSigningJournal(junoConfig.journalDir, { writerCheck: () => held.verify() }),
        tickets: ledger,
        readLog: (gameId) => logStore.loadLog(gameId),
        replay: serverPrefixReplay(build),
        now: () => Date.now(),
        // eslint-disable-next-line no-console
        warn: (line) => console.warn(line),
        // eslint-disable-next-line no-console
        log: (line) => console.log(line),
        ops,
        /* ESCROW-4: the join admission's precondition is the proof the wallet-link route recorded on the grant. */
        walletProofs: ledger,
      });
      junoConfigUsed = junoConfig;
      ledgerUsed = ledger;
    } catch (error) {
      const reason = error instanceof JunoConfigError ? error.message : `the Juno backend could not be opened -- ${error instanceof Error ? error.message : String(error)}`;
      if (config.mode === "production") {
        // eslint-disable-next-line no-console
        console.error(`Refusing to start: ${reason}`);
        held.releaseSync();
        process.exit(EXIT_LOCK_REFUSED);
      }
      // eslint-disable-next-line no-console
      console.warn(`  escrow: ${reason} -- the Juno backend is OFF for this development run`);
      escrow = null;
    }
  }

  const settlement = createSettlementCoordinator({
    store: financialStore,
    replay: serverPrefixReplay(build),
    now: () => Date.now(),
    // eslint-disable-next-line no-console
    warn: (line) => console.warn(line),
    ops,
    ...(escrow !== null ? { onIntentPrepared: (gameId: string) => escrow?.service.onIntentPrepared(gameId) } : {}),
  });
  await settlement.load();
  /* ==================================================================
      LIVE-4 (L4-2): THIS POOL'S DEPLOYMENT CAPABILITY, BUILT ONCE
     ==================================================================
     This build's constants (rules, hosted and financial protocols, codecs, the escrow contract code it speaks) and the
     escrow deployment its configuration serves -- the configured Juno backend's pin when that backend opened, none
     otherwise. Every game's continuation verdict and dealing identity is judged against exactly this descriptor
     (`continuationWiring.ts`); `BUILD_ID` is not in it. A descriptor this build cannot canonicalize refuses the start. */
  let capability: ReturnType<typeof thisDeploymentCapability>;
  try {
    capability = thisDeploymentCapability(escrow !== null && junoConfigUsed !== null ? [pinOf(junoConfigUsed)] : []);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(`Refusing to start: this server's deployment capability cannot be built -- ${error instanceof Error ? error.message : String(error)}`);
    held.releaseSync();
    process.exit(EXIT_LOCK_REFUSED);
  }
  /* ESCROW-4: a money table's deal is the escrow's roster source (the chain re-checked at the deal); every other table's
     is the ordinary one. Without a backend, a money table never deals. */
  const noMoneyRoster = new NoMoneyRosterSource();
  const server = createGameServer({
    port,
    build,
    settlement,
    rosterSource: {
      plan: (record, ctx) =>
        record.money === null
          ? noMoneyRoster.plan(record, ctx)
          : escrow !== null
            ? escrow.service.rosterSource.plan(record, ctx)
            : Promise.resolve({ refusal: "wrong-state" as const, code: "wrong-state" as const, reason: "This server has no Juno escrow configured." }),
    },
    money: () => moneyRef.current,
    ...(escrow !== null ? { escrow: { onGameplayCommitted: (input) => escrow?.service.onGameplayCommitted(input), isRosterFrozen: (gameId) => escrow?.service.isRosterFrozen(gameId) ?? false } } : {}),
    /* LIVE-4 (L4-2): the pool's capability, and the settlement index's money facts -- judged for every money table at
       every rebuild, whatever build dealt it (ESCROW-3A's build-keyed `continuationPolicyOf` is retired). */
    capability,
    moneyFacts: settlement,
    identity: {
      mode: config.mode,
      allowedOrigins: config.allowedOrigins,
      trustedProxyHops: config.trustedProxyHops,
      service: identity,
      ...(config.mode === "development" ? { devAuthenticator: createDevAuthenticator() } : {}),
    },
    /* #1225: local play explains itself -- development only; production refuses it (LIVE-2B). */
    explainDivergence: config.explainDivergence,
    /* #1250: the log is on disk and synced before any client is answered, so a restart restores every room
       it was serving. LIVE-3B: positional, looped, synced writes; a torn tail repaired at load; a damaged log held
       for `tools/logDoctor.ts`; and every write first checks that this process still holds the lock. */
    store: logStore,
    /* LIVE-2C: the server-owned GameRecords and the join-code index, beside the rooms under the same lock:
       `games/<game_id>.json` and `games/join-codes.json`, each replaced whole and durably (LIVE-3B §8.7). */
    records: createFileRecordStore(dataDir, {
      writerCheck: () => held.verify(),
      onRestartRequired: (key, detail) => failFast(`the game records (${key})`, detail),
    }),
    legacyLogs,
    onRestartRequired: failFast,
    /* LIVE-3C: durable holds (`games/holds/`), found by discovery or a load and lifted only by an operator's verified
       release (`npm run gamesDoctor -- release`); the audit lines and the status snapshot (`ops/`). */
    holds: createFileHoldStore(dataDir, { writerCheck: () => held.verify() }),
    ops,
    statusExtras: () => {
      const health = identityStore.health();
      return {
        identity: {
          loaded: health.loaded,
          poisoned: health.poisoned !== null,
          snapshot_seq: health.snapshotSeq,
          last_seq: health.lastSeq,
          journal_records: health.journalRecords,
          journal_bytes: health.journalBytes,
          compactions: health.compactions,
          counts: health.sizes,
        },
        lock: { instance_id: held.instanceId, pid: process.pid },
      };
    },
  });

  /* ESCROW-3A (brief §6): once every game is discovered, every money game that is not yet settled-to-intent is loaded
     -- a completed one announces its seal even if nobody ever reopens it -- and quiet funded games are looked at every
     five minutes (liveness is a state, never a refund). */
  serverRef.current = server;
  if (escrow !== null && junoConfigUsed !== null && ledgerUsed !== null) {
    const backend = escrow;
    moneyRef.current = createMoneyTables(
      {
        enabled: moneySwitch === MONEY_TABLES_SWITCH,
        service: backend.service,
        pin: pinOf(junoConfigUsed),
        symbol: junoConfigUsed.symbol,
        rest: backend.rest,
        tickets: ledgerUsed,
        financial: financialStore,
        appName: APP_NAME,
        now: () => Date.now(),
        // eslint-disable-next-line no-console
        warn: (line) => console.warn(line),
        ops,
      },
      server.rooms.moneyPort,
    );
    moneyRef.current.start();
    // eslint-disable-next-line no-console
    console.log(`  money: real-money tables are ${moneySwitch === MONEY_TABLES_SWITCH ? (junoConfigUsed.networkClass === "mainnet" ? "REFUSED (mainnet)" : `ENABLED on ${junoConfigUsed.chainId} (${junoConfigUsed.networkClass}) once the backend is verified`) : "OFF (ESCROW_MONEY_TABLES is not set)"}`);
  }

  void server.lifecycle.ready
    .then(async () => {
      /* ESCROW-3B: verify the chain, then resume every money game's chain work (before the settlement walk re-announces). */
      /* Review #2: a backend that cannot start yet (the chain unreachable, a load that failed) never stops the settlement
         walk below; it retries on its own verification timer. */
      if (escrow !== null) {
        await escrow.start().catch((error) => {
          // eslint-disable-next-line no-console
          console.warn(`  escrow: the Juno backend did not start -- ${error instanceof Error ? error.message : String(error)}; it retries with its verification`);
        });
      }
      const report = await settlement.reconcileAtStartup({ financialGameIds: server.lifecycle.financialGameIds(), loadGame: server.lifecycle.loadGame });
      /* And one sweep at once: a record left at funding for a game that was dealt moves on now, not in five minutes. */
      await settlement.sweepLiveness(server.lifecycle.financialRecords());
      if (report.financialGames > 0 || report.failed.length > 0) {
        // eslint-disable-next-line no-console
        console.log(`  settlement: ${report.financialGames} money games -- ${report.loaded} loaded, ${report.alreadyPrepared} already prepared, ${report.failed.length} could not be read (ESCROW-3A)`);
      }
    })
    .catch((error) => {
      // eslint-disable-next-line no-console
      console.warn(`  settlement: the startup walk failed -- ${error instanceof Error ? error.message : String(error)}; each money game is announced at its next load`);
    });
  setInterval(() => void settlement.sweepLiveness(server.lifecycle.financialRecords()).catch(() => undefined), 5 * 60_000).unref();
  /* ESCROW-3B: what the chain did to every bound money game (a dispute, consents, a liveness exit, finality). */
  if (escrow !== null) setInterval(() => void escrow?.service.sweepChain().catch(() => undefined), 5 * 60_000).unref();

  const release = (code: number) => {
    if (stopping) return;
    stopping = true;
    settlement.stop();
    moneyRef.current?.stop();
    escrow?.stop();
    /* LIVE-3C: the audit lines already queued are written (while the lock is still ours), then the lock goes. */
    void ops
      .flush()
      .catch(() => undefined)
      .then(() => held.release())
      .finally(() => process.exit(code));
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"] as const) {
    try {
      process.on(signal, () => release(0));
    } catch {
      // a signal this platform does not have
    }
  }
  /* LIVE-2F/3D (WINDOWS): no signal reaches another process on Windows except as a hard kill (TerminateProcess -- the
     lock is left behind, the audit not flushed). A parent that spawned this server with an IPC channel -- a process
     manager (PM2's convention there) or a test harness -- asks for the same clean stop by message. Only that parent
     holds the channel; a server started from a console has none, and Ctrl+C there is SIGINT as before. */
  if (typeof process.send === "function") {
    process.on("message", (message) => {
      if (message === "shutdown") release(0);
    });
  }
  process.on("exit", () => held.releaseSync());

  printBanner(held.instanceId);
}

/* ==================================================================
    THE STARTUP LINE CARRIES A STAMP, AND THE REASON IS #1238's PLAYTEST
   ==================================================================
   A fix landed in `derivedActions.ts`, the client hot-reloaded it, the server did not -- and the resulting
   half-fixed game was diagnosed from the first entry's id being `s58`: the mint counter proving the same
   process had served the previous room. That is evidence, but it is archaeology. A process should say when it
   was built, so "did you restart?" is answered by the window and not by inference. */
const builtAt = (() => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { statSync } = require("fs") as typeof import("fs");
    return statSync(__filename).mtime.toISOString().replace("T", " ").slice(0, 19);
  } catch {
    return "unknown";
  }
})();

/** LIVE-2 §4.8 item 6: the mode and the security posture, said at startup. */
function identityBanner(): string {
  const limits = DEFAULT_INGRESS_LIMITS.identity;
  const posture =
    config.mode === "development"
      ? "  DEVELOPMENT IDENTITY: each tab is who its ?dev_claim= says, loopback only (Origin, Host and peer) -- NEVER point a tunnel at this server\n" +
        "  profiles: each development claim has a synthetic development profile (never stored); the same profile gate as production\n" +
        "  rooms: the server-owned protocol (room-op, GameRecords in games/) -- the same one production runs\n" +
        "  remote playtests: run GS_MODE=production behind the tunnel (see PLAYTEST_TRANSPORT.md), never this mode\n"
      : `  PRODUCTION IDENTITY: the ${SESSION_COOKIE_NAME} cookie (Secure; HttpOnly; SameSite=Strict), bootstrapped at POST /gs/api/session; trusted proxy hops ${config.trustedProxyHops}\n` +
        "  profiles: REQUIRED to play (LIVE-2E) -- create, recover (recovery key) or link a device at /gs/api/profile/*; an unprofiled browser opens no game socket\n" +
        "  rooms: the server-owned protocol (room-op, GameRecords in games/)\n";
  return (
    posture +
    `  allowed origins: ${config.allowedOrigins.join(", ")}${config.notes.length > 0 ? ` (${config.notes.join("; ")})` : ""}\n` +
    `  limits: ${limits.maxSocketsGlobal} sockets, ${limits.maxSocketsPerIp} per address, ${limits.maxSocketsPerSession} per browser, ` +
    `${limits.maxSocketsPerPrincipal} per player (${limits.maxSocketsPerProvisionalPrincipal} before a first table); upgrades 60/min per address, 50/s in all\n`
  );
}

function printBanner(instanceId: string): void {
  // eslint-disable-next-line no-console
  console.log(
    `1830 game server listening on ws://${GAME_SERVER_BIND_HOST}:${port} (build "${build}", GS_MODE=${config.mode})\n` +
      identityBanner() +
      `  compiled ${builtAt} UTC -- if a fix you just made is not in this stamp, the server was not rebuilt\n` +
      `  games stored in ${dataDir} -- one .log.jsonl per game and games/<game_id>.json records, synced before any client is answered (#1250)\n` +
      `  data directory locked by instance ${instanceId} (pid ${process.pid}); a second server on it is refused (LIVE-3B)\n` +
      "  every game is discovered and classified before any is served; a held game stays held until `npm run gamesDoctor -- release` (LIVE-3C)\n" +
      `  rules engine version ${RULES_ENGINE_VERSION} (supports [${SUPPORTED_RULES_ENGINE_VERSIONS.join(", ")}]); ` +
      (legacyLogs === "development-corpus"
        ? "LEGACY LOGS ADMITTED (--legacy-logs development-corpus): an unpinned log replays under this engine (#1520)"
        : "an unpinned (legacy) log is held, not replayed (#1520)") +
      "\n  legacy JUNO-XXX rooms are not served (LIVE-2D); read their logs with `npm run replay` / `npm run logDoctor`",
  );
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("Refusing to start:", error);
  lock?.releaseSync();
  process.exit(EXIT_LOCK_REFUSED);
});
