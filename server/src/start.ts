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
import { createFileIdentityStore } from "./identity/fileStore";
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

  /* LIVE-2B: principals and sessions live beside the rooms, under the same lock -- written only for guests who own
     something (activation), durably (LIVE-3B's replacement protocol), and a file that cannot be read without
     guessing refuses the start. */
  let identity: IdentityService;
  try {
    identity = await IdentityService.open(
      createFileIdentityStore(dataDir, {
        writerCheck: () => held.verify(),
        onRestartRequired: (detail) => failFast("the identity store", detail),
      }),
    );
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(`Refusing to start: the identity store in ${dataDir} cannot be read -- ${error instanceof Error ? error.message : String(error)}`);
    held.releaseSync();
    process.exit(EXIT_LOCK_REFUSED);
  }
  createGameServer({
    port,
    build,
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
    store: createFileLogStore(dataDir, { onRestartRequired: failFast, writerCheck: () => held.verify() }),
    /* LIVE-2C: the server-owned GameRecords and the join-code index, beside the rooms under the same lock:
       `games/<game_id>.json` and `games/join-codes.json`, each replaced whole and durably (LIVE-3B §8.7). */
    records: createFileRecordStore(dataDir, {
      writerCheck: () => held.verify(),
      onRestartRequired: (key, detail) => failFast(`the game records (${key})`, detail),
    }),
    legacyLogs,
    onRestartRequired: failFast,
  });

  const release = (code: number) => {
    if (stopping) return;
    stopping = true;
    void held.release().finally(() => process.exit(code));
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"] as const) {
    try {
      process.on(signal, () => release(0));
    } catch {
      // a signal this platform does not have
    }
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
        "  rooms: the server-owned protocol (room-op, GameRecords in games/) -- the same one production runs\n" +
        "  remote playtests: run GS_MODE=production behind the tunnel (see PLAYTEST_TRANSPORT.md), never this mode\n"
      : `  PRODUCTION IDENTITY: the ${SESSION_COOKIE_NAME} cookie (Secure; HttpOnly; SameSite=Strict), bootstrapped at POST /gs/api/session; trusted proxy hops ${config.trustedProxyHops}\n` +
        "  rooms: the server-owned protocol (room-op, GameRecords in games/)\n";
  return (
    posture +
    `  allowed origins: ${config.allowedOrigins.join(", ")}${config.notes.length > 0 ? ` (${config.notes.join("; ")})` : ""}\n` +
    `  limits: ${limits.maxSocketsGlobal} sockets, ${limits.maxSocketsPerIp} per address, ${limits.maxSocketsPerPrincipal} per player ` +
    `(${limits.maxSocketsPerProvisionalPrincipal} new guest); upgrades 60/min per address, 50/s in all\n`
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
