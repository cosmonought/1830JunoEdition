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

import { createGameServer, trustClaimedIdentity } from "./gameServer";

const port = Number(process.env.PORT ?? 8917);

/** MUST MATCH THE CLIENT'S `REACT_APP_BUILD_ID` (#1206), and the two are compared exactly. A mismatch is
 *  answered with `build-skew` rather than treated as a divergence -- but only if both sides were told. */
const build = process.env.BUILD_ID ?? "dev";

if (process.env.INSECURE_LOCAL_IDENTITY !== "1") {
  // eslint-disable-next-line no-console
  console.error(
    [
      "Refusing to start: no identity resolver is configured.",
      "",
      "For local play, set INSECURE_LOCAL_IDENTITY=1 -- every client will then be believed about who it is,",
      "which is fine at a kitchen table and is not fine anywhere a payout can happen (design note #1210).",
      "For anything else, wire a real `resolveIdentity` into `createGameServer` first.",
    ].join("\n"),
  );
  process.exit(2);
}

createGameServer({
  port,
  build,
  resolveIdentity: trustClaimedIdentity,
  /* NO `loadLog` YET, so a restart starts an empty room. The store is a seam `RoomSession.restore` already
     knows how to fill (#1209) -- Firestore stays the log's home per the migration plan, and wiring it is its
     own step rather than a detail smuggled into the transport. */
});

// eslint-disable-next-line no-console
console.log(
  `1830 game server listening on ws://127.0.0.1:${port} (build "${build}", INSECURE local identity)`,
);
