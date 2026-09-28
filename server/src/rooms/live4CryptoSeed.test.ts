// server/src/rooms/live4CryptoSeed.test.ts
//
// LIVE-4 L4-5 (D-43), T-18: THE HOSTED REVENUE SEED IS A CRYPTOGRAPHIC DRAW -- AND ONLY ITS SOURCE CHANGED.
//
// #1662 made the server the only author of a turn's `revenue_seed`. `normalizeForCommit` draws it at ingress (or finds
// this turn's earlier draw in the RAW log after an undo, #1051), the accepted `RunMultipleRoutes` commits it, and a
// replay reads the committed number and never draws. D-43 changes where a NEW draw comes from: `createGameServer`'s
// session factory passed no `mintSeed`, so every hosted draw fell to `randomTurnSeed` -- `Math.random`. It now passes
// `mintHostedRevenueSeed`, `crypto.randomInt(0, 2 ** 32)`.
//
//   (1) THE WIRING, against the real server. A game loaded through the production actor path is handed a session whose
//       seed source IS `mintHostedRevenueSeed` -- not absent (which is `randomTurnSeed`), not `randomTurnSeed` -- and
//       every draw of it, with `Math.random` rigged to throw, is one `crypto.randomInt(0, 2 ** 32)` whose answer it
//       returns unchanged (observed by a pass-through spy on node's own `randomInt`, which alters nothing it sees). A
//       refactor that drops the option, narrows the range, or swaps in any other source fails here.
//   (2) THE COMMIT, THE REPLAY AND THE UNDO, through `RoomSession` -- the class the server runs -- drawing from that
//       source, on UR-7's constructed operating board (the default deal cannot reach a run in a test's budget). The
//       accepted run commits exactly the source's draw in place of the client's seed; a restore and `replayLog` reach the same
//       board without drawing; an undo's re-run reuses the committed draw and asks the source nothing.
//
// Nothing here is probabilistic: every assertion holds for every value the source can return. The client's seed is
// 2^32 + 7, a number the source can never produce, so "replaced" is a fact rather than a likelihood.

import { describe, mock, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";

import { mintHostedRevenueSeed } from "../gameServer";
import { createMemoryRecordStore } from "./recordStore";
import { ALICE, BOB, controlledStore, quietConsole, seedGame, startServer, stopServer, storedLog } from "./testSupport";
import type { RoomSession, RoomSessionOptions, ServerLogEntry } from "../../../frontend/src/utils/roomSession";
import type { ServerMessage } from "../../../frontend/src/utils/serverProtocol";
import type { GameStateResponse } from "../../../frontend/src/gameEngine/gameState";
import type { SandboxLogMsg } from "../../../frontend/src/gameEngine/gameSetup";
import { randomTurnSeed } from "../../../frontend/src/gameEngine/gameVariants";
import { replayLog } from "../../../frontend/src/gameEngine/replayLog";
import { SERVER_REPLAY_POLICY } from "../../../frontend/src/gameEngine/rulesVersion";
import { stateDigest } from "../../../frontend/src/gameEngine/stateDigest";
import { seedAlreadyRolled, turnSeedKey } from "../../../frontend/src/utils/turnSeed";
import { roomProviders } from "../../../frontend/src/utils/yellowSignRunBoundSupport";
import {
  ADVANCE,
  BO,
  BUILD as UR_BUILD,
  CO,
  DECLARE,
  NETWORK,
  P1,
  PASS,
  REVERT,
  RUN,
  boRun,
  certificationRoom,
  certificationStart,
  coRun,
  operatingCorp,
} from "../../../frontend/src/utils/unpredictableRevenueCertificationGame";

quietConsole();

/** The unsigned 32-bit seed space `randomTurnSeed` covers, restated here rather than imported from what it checks. */
const SEED_SPACE = 2 ** 32;
/** What the client puts in its run: outside the seed space, so the source can never have drawn it. */
const CLIENT_SEED = SEED_SPACE + 7;

const isSeed = (value: unknown): boolean => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) < SEED_SPACE;

/** `body`, with `Math.random` rigged to throw for its length. */
function withoutMathRandom<T>(body: () => T): T {
  const real = Math.random;
  Math.random = () => {
    throw new Error("D-43: a hosted revenue seed consulted Math.random");
  };
  try {
    return body();
  } finally {
    Math.random = real;
  }
}

/** The seed source a session was built with. `RoomSession` keeps its options private and has no reader for this one,
 *  and T-18 has to see the source the PRODUCTION factory passed, not one a test built -- so it reads the field, and
 *  says so loudly if the field is ever renamed rather than passing without having looked. */
function seedSourceOf(session: RoomSession): RoomSessionOptions["mintSeed"] {
  const options = (session as unknown as { options?: RoomSessionOptions }).options;
  assert.ok(options !== undefined && typeof options === "object", "RoomSession no longer keeps `options`: re-point T-18's reader");
  assert.equal(typeof options.mintId, "function", "the object read is RoomSession's options");
  return options.mintSeed;
}

/* ==================================================================
    (1) THE PRODUCTION HOSTED SESSION FACTORY
   ================================================================== */
describe("T-18 (1): the production hosted session factory draws the revenue seed with node crypto (D-43)", () => {
  test("a game the real server loads is handed a session whose seed source is `mintHostedRevenueSeed`", async () => {
    const control = controlledStore();
    const records = createMemoryRecordStore();
    const gameId = await seedGame(records, [ALICE, BOB], { dealt: true });
    control.logs.set(gameId, storedLog(0));
    /* LIVE-3C's test seam hands over the session the load reconciles: the one `newRoomSession` built for this game. */
    const built: RoomSession[] = [];
    const { server } = await startServer({
      store: control.store,
      records,
      faults: {
        boardEnded: (id, session) => {
          if (id === gameId) built.push(session);
          return false;
        },
      },
    });
    try {
      await server.lifecycle.ready;
      await server.lifecycle.loadGame(gameId);
      assert.ok(built.length > 0, "the load reconciled the game's board");
      const session = built[built.length - 1];
      assert.equal(session.entries.length, 1, "the loaded game's session: its stored deal, restored");
      assert.equal(session.incompatible, null, "a v11 deal on this server: played, not held");

      const source = seedSourceOf(session);
      assert.notEqual(source, undefined, "absent is RoomSession's default -- randomTurnSeed, which is Math.random");
      assert.notEqual(source, randomTurnSeed, "randomTurnSeed is Math.random");
      assert.equal(source, mintHostedRevenueSeed, "the factory passes the crypto source");

      /* Node's own `randomInt`, watched rather than replaced: the spy calls through and changes nothing it sees. */
      const randomInt = mock.method(crypto, "randomInt");
      try {
        const draws = withoutMathRandom(() => Array.from({ length: 64 }, () => source!()));
        assert.equal(randomInt.mock.callCount(), draws.length, "one crypto.randomInt per draw");
        randomInt.mock.calls.forEach((call, n) => {
          assert.deepEqual(call.arguments, [0, SEED_SPACE], "the whole unsigned 32-bit space, [0, 2^32)");
          assert.equal(call.result, draws[n], "the source answers exactly what crypto drew");
        });
        for (const draw of draws) assert.ok(isSeed(draw), `${draw} is not a whole number in [0, 2^32)`);
      } finally {
        randomInt.mock.restore();
      }
    } finally {
      await stopServer(server);
    }
  });
});

/* ==================================================================
    (2) THE COMMIT, THE REPLAY AND THE UNDO, THROUGH `RoomSession`
   ================================================================== */
type Run = { routes: Parameters<typeof RUN>[1]; trains: string[]; indices: number[] };

const submitAs = (room: RoomSession, actor: string, msg: SandboxLogMsg): ServerMessage =>
  room.submit({ actor, build: UR_BUILD, host: P1, msg, baseIndex: room.nextIndex - 1 });

const companyOf = (state: GameStateResponse, id: number) => state.public_companies.find((entry) => entry.company_id === id)!;

const runFor = (state: GameStateResponse, corp: number): Run | null => (corp === CO ? coRun(state) : corp === BO ? boRun(state) : null);

const runsIn = (entries: readonly ServerLogEntry[]): ServerLogEntry[] =>
  entries.filter((entry) => "RunMultipleRoutes" in JSON.parse(entry.payload));

const runBody = (entry: ServerLogEntry): { revenue_seed: unknown; revenue_turn: unknown } =>
  JSON.parse(entry.payload).RunMultipleRoutes;

/** Plays UR-7's constructed board to the first corporation standing at Run Routes that has a route: the Stock Round
 *  seats pass, Lay Track and Place Tokens are left, dividends are withheld and turns ended -- none of which draws. */
function toFirstRun(room: RoomSession): { corp: number; president: string; run: Run } {
  for (let guard = 0; guard < 200; guard += 1) {
    const state = room.state;
    const expectApplied = (actor: string, msg: SandboxLogMsg, label: string) => {
      const answer = submitAs(room, actor, msg);
      assert.equal(answer.kind, "applied", `${label}: ${JSON.stringify(answer)}`);
    };
    if (state.current_round_type === "StockRound") {
      expectApplied(state.player_addresses[state.active_player_index], PASS, "a Stock Round pass");
      continue;
    }
    assert.equal(state.current_round_type, "OperatingRound");
    const corp = operatingCorp(state)!;
    const president = companyOf(state, corp).president!;
    const sub = state.operating_sub_phase;
    if (sub === "Track" || sub === "Tokens") expectApplied(president, ADVANCE(corp), `leave ${sub}`);
    else if (sub === "Routes") {
      const run = runFor(state, corp);
      assert.ok(run !== null, `corporation ${corp} stands at Run Routes with no route`);
      return { corp, president, run };
    } else if (sub === "Dividends") expectApplied(president, DECLARE(corp, Number(companyOf(state, corp).last_route_revenue ?? 0), false), "withhold");
    else expectApplied(president, PASS, "end the turn");
  }
  throw new Error("no corporation reached Run Routes");
}

describe("T-18 (2): the crypto draw is committed, replayed and reused -- never drawn again", () => {
  test("the accepted run commits the source's draw in place of the client's seed; a restore and a replay reach the same board without drawing", () => {
    const drawn: number[] = [];
    const source = () => {
      const seed = mintHostedRevenueSeed();
      drawn.push(seed);
      return seed;
    };
    /* G1 (Unpredictable Revenue on): the committed seed decides the run's revenue, so the board a replay reaches is
       the board of THIS draw. */
    const room = certificationRoom(certificationStart(), source);
    const { corp, president, run } = toFirstRun(room);
    assert.equal(drawn.length, 0, "nothing before the run drew");
    const key = turnSeedKey(room.state.macro_round_number ?? 0, room.state.sub_round_index ?? 0, corp);

    const answer = withoutMathRandom(() => submitAs(room, president, RUN(corp, run.routes, run.trains, run.indices, CLIENT_SEED)));
    assert.equal(answer.kind, "applied", JSON.stringify(answer));
    assert.equal(drawn.length, 1, "the run drew once");
    const [committed] = runsIn(room.entries);
    const body = runBody(committed);
    assert.equal(body.revenue_seed, drawn[0], "the committed seed is exactly the source's draw");
    assert.ok(isSeed(body.revenue_seed), `the committed seed ${String(body.revenue_seed)} is not in [0, 2^32)`);
    assert.notEqual(body.revenue_seed, CLIENT_SEED, "the client's seed never reaches the log");
    assert.equal(body.revenue_turn, key, "keyed by the server's own turn");
    assert.equal(seedAlreadyRolled(room.entries, key), body.revenue_seed, "the raw log answers this turn with the draw");

    /* A restore is a server restart: through `apply`, never `submit` -- so never through the draw. */
    const restored = certificationRoom(certificationStart(), () => {
      throw new Error("a restore drew a revenue seed");
    });
    withoutMathRandom(() => restored.restore(room.entries));
    assert.equal(stateDigest(restored.state), stateDigest(room.state), "the restore reached the same board");
    assert.equal(runBody(runsIn(restored.entries)[0]).revenue_seed, body.revenue_seed, "and holds the same committed seed");

    /* The client's drain and the replay harness: the same function, from the committed entries alone. */
    const start = certificationStart();
    const replayed = withoutMathRandom(() =>
      replayLog(
        room.entries.map((entry) => ({ index: entry.index, id: entry.id, actor: entry.actor, payload: entry.payload })),
        roomProviders(start, NETWORK),
        { state: start, waterfall: null },
        undefined,
        SERVER_REPLAY_POLICY,
      ),
    );
    assert.equal(stateDigest(replayed.state), stateDigest(room.state), "the replay reached the same board");
    assert.equal(drawn.length, 1, "neither the restore nor the replay asked the source");
  });

  test("an undo's re-run reuses the committed draw (#1051's raw-log rule, unchanged): the source is asked once for the turn", () => {
    const drawn: number[] = [];
    const source = () => {
      const seed = mintHostedRevenueSeed();
      drawn.push(seed);
      return seed;
    };
    /* G0 (Unpredictable Revenue off), so the undo's reach does not depend on which face the draw showed. The seed is
       drawn and committed all the same: ingress does not ask the variants. */
    const room = certificationRoom(certificationStart({ unpredictableRevenue: false }), source);
    const { corp, president, run } = toFirstRun(room);
    const send = (seed: number) => withoutMathRandom(() => submitAs(room, president, RUN(corp, run.routes, run.trains, run.indices, seed)));

    assert.equal(send(CLIENT_SEED).kind, "applied");
    const [first] = runsIn(room.entries);
    const seed = runBody(first).revenue_seed;
    const board = stateDigest(room.state);
    assert.deepEqual(drawn, [seed], "the run drew once, and committed that draw");

    const undo = submitAs(room, president, REVERT(first.index, president));
    assert.equal(undo.kind, "applied", JSON.stringify(undo));
    assert.equal(room.state.operating_sub_phase, "Routes", "the undo rewound to Run Routes");

    assert.equal(send(CLIENT_SEED + 1).kind, "applied");
    assert.equal(drawn.length, 1, "the re-run drew nothing");
    const runs = runsIn(room.entries);
    assert.equal(runs.length, 2, "both runs are in the raw log");
    assert.equal(runBody(runs[1]).revenue_seed, seed, "the re-run committed the turn's first draw");
    assert.equal(stateDigest(room.state), board, "and reached the same board");
  });
});
