// server/src/start.ts
//
// The entry point. Reads its settings from the environment and starts one server.
//
// ==================================================================
//  DESIGN NOTE 1213: THE PROCESS, AND THE ONE SETTING THAT MATTERS
// ==================================================================
//
// `createGameServer` takes an identity resolver and has no default (#1210), which means this file has to
// choose one -- and choosing is exactly what an entry point is for. It chooses the INSECURE one only when
// told to, in as many words, and refuses to start otherwise.
//
// THAT REFUSAL IS THE POINT. Every check built in Phase 2 rests on the server knowing who is speaking:
// #1207 keeps the actor off the wire so a client cannot claim a seat, and `turnAuthority` then enforces the
// rules on the strength of that identity. A process that quietly believed whatever a client said would keep
// every test green while enforcing the rules on behalf of the wrong person.
//
// Usage:
//   BUILD_ID=$(git rev-parse --short HEAD) INSECURE_LOCAL_IDENTITY=1 node dist/server/src/start.js

import * as path from "path";

import { createGameServer, GAME_SERVER_BIND_HOST, trustClaimedIdentity } from "./gameServer";
import { createFileLogStore } from "./fileLogStore";
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

if (process.env.INSECURE_LOCAL_IDENTITY !== "1" && !flags.includes("--insecure-local-identity")) {
  // eslint-disable-next-line no-console
  console.error(
    [
      "Refusing to start: no identity resolver is configured.",
      "",
      "For local play, pass --insecure-local-identity (or set INSECURE_LOCAL_IDENTITY=1). Every client is",
      "then believed about who it is, which is fine at a kitchen table and is not fine anywhere a payout",
      "can happen (design note #1210).",
      "For anything else, wire a real `resolveIdentity` into `createGameServer` first.",
    ].join("\n"),
  );
  process.exit(2);
}

/** #1250: where the rooms live between restarts. A directory beside the server by default, so `cat` is the
 *  whole of the tooling needed to read a game back; `--data <dir>` or `DATA_DIR` to put it elsewhere. */
const dataDir = path.resolve(process.env.DATA_DIR ?? flagValue("--data") ?? path.join(process.cwd(), "data"));

/* #1520: THE ONE WAY A ROOM DEALT BEFORE RULES-ENGINE VERSIONING IS LOADED. Absent, such a room is held: a
   deal with no `rules_engine_version` is never read as "the current version". `--legacy-logs
   development-corpus` (or `LEGACY_LOGS=development-corpus`) admits the local playtest rooms under the engine
   this process carries, and says so at startup and per room. Any other value is refused here rather than
   silently read as "refuse", so a typo cannot hide a policy. */
const legacyLogsFlag = process.env.LEGACY_LOGS ?? flagValue("--legacy-logs") ?? "refuse";
if (legacyLogsFlag !== "refuse" && legacyLogsFlag !== "development-corpus") {
  // eslint-disable-next-line no-console
  console.error(`Refusing to start: --legacy-logs must be "refuse" or "development-corpus", not "${legacyLogsFlag}".`);
  process.exit(2);
}
const legacyLogs: "refuse" | "development-corpus" = legacyLogsFlag;

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

  createGameServer({
    port,
    build,
    resolveIdentity: trustClaimedIdentity,
    /* #1225: local play explains itself. The same condition as the insecure identity, because they describe
       the same situation -- a table at a kitchen table, where the cost of a verbose frame is nothing and the
       cost of an unexplained divergence is an evening. */
    explainDivergence: true,
    /* #1250: the log is on disk and synced before any client is answered, so a restart restores every room
       it was serving. LIVE-3B: positional, looped, synced writes; a torn tail repaired at load; a damaged log held
       for `tools/logDoctor.ts`; and every write first checks that this process still holds the lock. */
    store: createFileLogStore(dataDir, { onRestartRequired: failFast, writerCheck: () => held.verify() }),
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

function printBanner(instanceId: string): void {
  // eslint-disable-next-line no-console
  console.log(
    `1830 game server listening on ws://${GAME_SERVER_BIND_HOST}:${port} (build "${build}", INSECURE local identity)\n` +
      `  compiled ${builtAt} UTC -- if a fix you just made is not in this stamp, the server was not rebuilt\n` +
      `  rooms stored in ${dataDir} -- one .log.jsonl per room, synced before any client is answered (#1250)\n` +
      `  data directory locked by instance ${instanceId} (pid ${process.pid}); a second server on it is refused (LIVE-3B)\n` +
      `  rules engine version ${RULES_ENGINE_VERSION} (supports [${SUPPORTED_RULES_ENGINE_VERSIONS.join(", ")}]); ` +
      (legacyLogs === "development-corpus"
        ? "LEGACY LOGS ADMITTED (--legacy-logs development-corpus): unpinned rooms replay under this engine (#1520)"
        : "unpinned (legacy) rooms are held, not replayed -- pass --legacy-logs development-corpus for local playtests (#1520)"),
  );
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("Refusing to start:", error);
  lock?.releaseSync();
  process.exit(EXIT_LOCK_REFUSED);
});
