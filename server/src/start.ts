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

import { createGameServer, trustClaimedIdentity } from "./gameServer";
import { createFileLogStore } from "./fileLogStore";

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

createGameServer({
  port,
  build,
  resolveIdentity: trustClaimedIdentity,
  /* #1225: local play explains itself. The same condition as the insecure identity, because they describe
     the same situation -- a table at a kitchen table, where the cost of a verbose frame is nothing and the
     cost of an unexplained divergence is an evening. */
  explainDivergence: true,
  /* #1250: the log is on disk and synced before any client is answered, so a restart restores every room
     it was serving. `start.ts` used to say "a restart starts an empty room"; it no longer does. */
  store: createFileLogStore(dataDir),
});

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

// eslint-disable-next-line no-console
console.log(
  `1830 game server listening on ws://127.0.0.1:${port} (build "${build}", INSECURE local identity)\n` +
    `  compiled ${builtAt} UTC -- if a fix you just made is not in this stamp, the server was not rebuilt\n` +
    `  rooms stored in ${dataDir} -- one .log.jsonl per room, synced before any client is answered (#1250)`,
);
