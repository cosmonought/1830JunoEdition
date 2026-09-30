// server/src/rooms/live4ClientCompatibility.test.ts
//
// ==================================================================
//  LIVE-4 (L4-3): CLIENT COMPATIBILITY AT THE SERVER -- THE ANNOUNCEMENT, THE VERDICT, THE ANSWERS, THE LEGACY WIRE
// ==================================================================
//
// The process-level half of L4-3 (the client half and the pure mapping are `frontend/src/utils/
// live4ClientCompatibility.test.ts`). Real servers, real sockets, the development authenticator:
//   1. T-14: a protocol-1 tab on ANOTHER BUILD of the same rules says hello and SUBMITS -- no `build-skew`; the same
//      build difference on the legacy wire (no announcement) is still `build-skew` (OD-L4-1).
//   2. T-15 / T-21: a client protocol this pool does not accept, or an announcement it cannot read (missing or
//      malformed `cr`, a repeated parameter), is told `reload` at once and closed 4426; nothing it sends is handled.
//   3. The per-game check: a protocol-1 tab whose rules do not include a dealt game's pin gets `reload/client-rules`
//      at the hello (no catch-up, no entry) and at the room hello (no view), then 4426.
//   4. T-16: the deal is judged in the push that carries it -- a stale subscriber of a waiting table gets ONE
//      `reload` instead of the deal (log and room channels alike), is closed, and nothing further reaches it.
//   5. `route`: a game whose rules this release does not carry, before LIVE-6 (no destination), is answered exactly as a
//      game this pool does not continue -- `incompatible` with its reason -- never a `route` frame, never 4426.
//   6. The legacy wire: never a LIVE-4 frame or 4426; and on a pool that retired protocol 0 (`legacy-refused`), only
//      frames a legacy bundle already understands, the socket neither closed nor reaped.
//   7. The standing notice's reason: a not-continued game's RoomView carries its frame's sentence (`holdReason`).

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { createMemoryRecordStore } from "./recordStore";
import { thisDeploymentCapability } from "../deploymentCapability";
import { deploymentCapability } from "../../../frontend/src/gameEngine/compat/deploymentCapability";
import { clientAnnouncementQuery } from "../../../frontend/src/gameEngine/compat/clientCompatibility";
import { ACCEPTED_CLIENT_PROTOCOLS } from "../../../frontend/src/gameEngine/protocolVersions";
import { RULES_ENGINE_VERSION } from "../../../frontend/src/gameEngine/rulesVersion";
import { CLIENT_ANSWER_CLOSE_CODE, CLIENT_ANSWER_SENTENCES } from "../../../frontend/src/utils/clientAnswers";
import type { ServerLogEntry } from "../../../frontend/src/utils/roomSession";
import type { GameServerOptions } from "../gameServer";
import {
  ALICE,
  BOB,
  BUILD,
  BUY,
  CAROL,
  Client,
  controlledStore,
  openGame,
  quietConsole,
  seedGame,
  startServer,
  stopServer,
  storedLog,
  until,
  sleep,
  type Frame,
} from "./testSupport";

quietConsole();

/* Route v12 R12-2 moved the rules engine from 11 to 12. The cases below were written against 11 as "this release's
   rules" and 12 as "a release after it"; they now read the engine -- NOW, PREV (a release before it) and NEXT (one
   after) -- so they stay the same cases. */
const NOW = RULES_ENGINE_VERSION;
const PREV = RULES_ENGINE_VERSION - 1;
const NEXT = RULES_ENGINE_VERSION + 1;

/** A protocol-1 tab's announcement (the canonical query a LIVE-4 bundle sends). */
const announce = (rules: readonly number[] = [NOW], build: string | null = "tab-build-b") => clientAnnouncementQuery(1, rules, build);
/** Frames only a protocol-1 client understands. The legacy wire must never see one. */
const LIVE4_ONLY = new Set(["reload", "route"]);

/** A deal rewritten (a stored log's first entry). */
function withDeal(entries: readonly ServerLogEntry[], change: (setup: Record<string, unknown>) => void): ServerLogEntry[] {
  const payload = JSON.parse(entries[0].payload) as { SetupGame: Record<string, unknown> };
  change(payload.SetupGame);
  return [{ ...entries[0], payload: JSON.stringify(payload) }, ...entries.slice(1)];
}

/** A server over memory stores with one dealt v11 game (ALICE host, BOB) -- and more, when asked. */
async function world(over: Partial<GameServerOptions> = {}, extra: { v12?: boolean; hosted2?: boolean } = {}) {
  const control = controlledStore();
  const records = createMemoryRecordStore();
  const dealt = await seedGame(records, [ALICE, BOB], { dealt: true });
  control.logs.set(dealt, storedLog(0));
  let v12: string | null = null;
  if (extra.v12) {
    v12 = await seedGame(records, [ALICE, BOB], { dealt: true });
    control.logs.set(v12, withDeal(storedLog(0), (setup) => (setup.rules_engine_version = NEXT)));
    const record = records.records.get(v12);
    if (record) records.records.set(v12, { ...record, rules_engine_version: NEXT });
  }
  let hosted2: string | null = null;
  if (extra.hosted2) {
    hosted2 = await seedGame(records, [ALICE, BOB], { dealt: true });
    control.logs.set(hosted2, withDeal(storedLog(0), (setup) => (setup.hosted_protocol = 2)));
  }
  const { server, port } = await startServer({ store: control.store, records, ...over });
  return { control, records, dealt, v12, hosted2, server, port };
}

const kinds = (client: Client): string[] => client.frames.map((frame) => frame.kind);
const noLive4Frame = (client: Client, label: string) =>
  assert.deepEqual(kinds(client).filter((kind) => LIVE4_ONLY.has(kind)), [], `${label}: the legacy wire saw a LIVE-4 frame`);

/** The code a socket was closed with -- bounded, so a regression that leaves it open FAILS here (with the frames it did
 *  get) instead of hanging the run. */
async function closeOf(client: Client, label: string, ms = 10_000): Promise<number> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: still open after ${ms} ms (frames: ${kinds(client).join(",") || "none"})`)), ms);
  });
  try {
    return await Promise.race([client.closed, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** The frame a hello's catch-up (or any first answer) arrives as. */
const firstAnswer = (client: Client, label: string): Promise<Frame> =>
  client.next((frame) => ["catch-up", "reload", "route", "incompatible", "error", "room"].includes(frame.kind), label);

describe("L4-3 at the server: the announcement, the verdict, the answers", () => {
  test("T-14: a protocol-1 tab on another build of the same rules says hello and SUBMITS -- no build-skew; the legacy wire still compares", async () => {
    const { server, port, dealt } = await world();
    try {
      /* Alice's tab: protocol 1, this release's rules, a build that is not the server's. */
      const alice = await Client.open(port, ALICE, announce([NOW], "tab-build-b"));
      alice.hello(dealt);
      const caught = await firstAnswer(alice, "alice's catch-up");
      assert.equal(caught.kind, "catch-up");
      const deal = (caught.entries as Array<{ index: number; id: string }>).at(-1) as { index: number; id: string };
      alice.submit(BUY, { baseIndex: deal.index, baseId: deal.id, submissionId: "p1-buy", build: "tab-build-b" });
      const answered = await alice.answerTo("p1-buy");
      assert.equal(answered.kind, "applied", `a protocol-1 tab on another build is played (${JSON.stringify(answered)})`);
      assert.notEqual(BUILD, "tab-build-b");

      /* Bob's tab: the legacy wire (no announcement) with the same kind of build difference -- exactly today's answer. */
      const bob = await Client.open(port, BOB);
      bob.hello(dealt);
      const bobCaught = await firstAnswer(bob, "bob's catch-up");
      assert.equal(bobCaught.kind, "catch-up");
      /* Alice's buy is in Bob's catch-up (it committed before his hello): Bob is on turn now. */
      const head = (bobCaught.entries as Array<{ index: number; id: string }>).at(-1) as { index: number; id: string };
      assert.ok(head.index > deal.index);
      bob.submit(BUY, { baseIndex: head.index, baseId: head.id, submissionId: "legacy-buy", build: "tab-build-b" });
      const skew = await bob.answerTo("legacy-buy");
      assert.deepEqual([skew.kind, skew.clientBuild, skew.serverBuild], ["build-skew", "tab-build-b", BUILD]);
      noLive4Frame(bob, "the legacy tab");
      /* ... and on the server's own build it is played as before. */
      bob.submit(BUY, { baseIndex: head.index, baseId: head.id, submissionId: "legacy-buy-2" });
      assert.equal((await bob.answerTo("legacy-buy-2")).kind, "applied");
      noLive4Frame(bob, "the legacy tab");
      assert.equal(bob.open, true, "the legacy socket is not closed");
      await Promise.all([alice.close(), bob.close()]);
    } finally {
      await stopServer(server);
    }
  });

  test("T-15: a client protocol this pool does not accept is told `reload/client-protocol` at once, closed 4426, and nothing it sends is handled", async () => {
    const { server, port, dealt } = await world();
    try {
      const future = await Client.open(port, CAROL, "cp=9&cr=11&cb=tab-from-the-future");
      const close = await closeOf(future, "future");
      assert.equal(close, CLIENT_ANSWER_CLOSE_CODE);
      assert.deepEqual(kinds(future), ["reload"]);
      assert.deepEqual(future.frames[0], { kind: "reload", code: "client-protocol", reason: CLIENT_ANSWER_SENTENCES["client-protocol"], accepted: [0, 1] });
      assert.deepEqual([...ACCEPTED_CLIENT_PROTOCOLS], [0, 1]);
      assert.equal(server.clientAnswers.connectionReload, 1);
      /* A second one that manages to send a hello before the close lands is still told nothing else. */
      const eager = await Client.open(port, CAROL, "cp=2&cr=11");
      eager.hello(dealt);
      assert.equal(await closeOf(eager, "eager"), CLIENT_ANSWER_CLOSE_CODE);
      assert.deepEqual(kinds(eager), ["reload"]);
    } finally {
      await stopServer(server);
    }
  });

  test("T-21: an announcement from a LIVE-4 tab that cannot be read -- no cr, a malformed cr, a repeated parameter -- is `reload/client-announcement`, 4426", async () => {
    const { server, port } = await world();
    try {
      const broken = [
        "cp=1",
        "cp=1&cr=",
        "cp=1&cr=11,11",
        "cp=1&cr=abc",
        "cp=1&cr=0",
        "cp=1&cr=011",
        "cp=1&cr=11,",
        "cp=1&cp=1&cr=11",
        "cp=1&cr=11&cr=11",
        "cp=x&cr=11",
        "cp=01&cr=11",
        "cp=&cr=11",
      ];
      for (const query of broken) {
        const tab = await Client.open(port, CAROL, query);
        assert.equal(await closeOf(tab, "tab"), CLIENT_ANSWER_CLOSE_CODE, query);
        assert.equal(tab.frames.length, 1, query);
        assert.equal(tab.frames[0].kind, "reload", query);
        assert.equal(tab.frames[0].code, "client-announcement", query);
        assert.deepEqual(tab.frames[0].accepted, [0, 1], query);
      }
      assert.equal(server.clientAnswers.connectionReload, broken.length);
    } finally {
      await stopServer(server);
    }
  });

  test("the per-game check: a tab whose rules lack a dealt game's pin gets `reload/client-rules` -- no entry at the hello, no view at the room hello -- then 4426", async () => {
    const { server, port, dealt } = await world();
    try {
      for (const rules of [[PREV], [NEXT], [9, PREV]]) {
        const stale = await Client.open(port, ALICE, announce(rules));
        stale.hello(dealt);
        assert.equal(await closeOf(stale, "stale"), CLIENT_ANSWER_CLOSE_CODE, `hello with rules ${rules}`);
        assert.deepEqual(stale.frames, [{ kind: "reload", code: "client-rules", reason: CLIENT_ANSWER_SENTENCES["client-rules"], gameId: dealt }]);
        assert.deepEqual(stale.seen(), [], "not one entry reached a tab that cannot interpret it");

        const staleRoom = await Client.open(port, ALICE, announce(rules));
        staleRoom.roomHello(dealt);
        assert.equal(await closeOf(staleRoom, "staleRoom"), CLIENT_ANSWER_CLOSE_CODE, `room hello with rules ${rules}`);
        assert.deepEqual(kinds(staleRoom), ["reload"]);
      }
      /* A tab that carries the pin (alone or among others) is served. */
      for (const rules of [[NOW], [PREV, NOW], [NOW, NEXT]]) {
        const fine = await Client.open(port, ALICE, announce(rules));
        fine.hello(dealt);
        assert.equal((await firstAnswer(fine, `rules ${rules}`)).kind, "catch-up");
        fine.roomHello(dealt);
        assert.equal((await fine.next((frame) => frame.kind === "room", "the view")).kind, "room");
        noLive4Frame(fine, `rules ${rules}`);
        await fine.close();
      }
      assert.equal(server.clientAnswers.gameReload, 6);
    } finally {
      await stopServer(server);
    }
  });

  test("a socket told `reload` for a game handles nothing it sent after the refused hello -- a queued room op does not run (review F4)", async () => {
    const { server, port, records } = await world();
    try {
      /* A real table (server-minted player ids -- `transfer-host` names one), dealt: the host may hand the role on
         mid-game (LIVE-2E). */
      const table = await openGame(port, ALICE, [BOB]);
      const before = records.records.get(table.gameId);
      assert.ok(before);
      assert.equal(before.status, "active");
      /* The host's stale tab: its channel sends its standing room-hello and its backlog in one breath, as the room link
         does. */
      const stale = await Client.open(port, ALICE, announce([PREV]));
      stale.roomHello(table.gameId);
      const requestId = stale.roomOp({ type: "transfer-host", toPlayerId: table.playerIds[BOB] }, table.gameId);
      assert.equal(await closeOf(stale, "stale"), CLIENT_ANSWER_CLOSE_CODE);
      assert.deepEqual(kinds(stale), ["reload"], "no ack, no view: nothing after the reload");
      assert.equal(stale.frames.some((frame) => frame.requestId === requestId), false);
      await sleep(50);
      assert.equal(records.records.get(table.gameId)?.host_player_id, before.host_player_id, "the queued op did not run");
      /* The same op from a tab the pool may serve does run (so the assertion above is not vacuous). */
      const fine = await Client.open(port, ALICE, announce([NOW]));
      fine.roomHello(table.gameId);
      await fine.next((frame) => frame.kind === "room", "the view");
      const done = await fine.op({ type: "transfer-host", toPlayerId: table.playerIds[BOB] }, table.gameId);
      assert.equal(done.ok, true, JSON.stringify(done));
      assert.equal(records.records.get(table.gameId)?.host_player_id, table.playerIds[BOB]);
      await fine.close();
    } finally {
      await stopServer(server);
    }
  });

  test("T-16: the deal is judged in the push that carries it -- a stale subscriber gets ONE reload instead of the deal, on both channels; the others get the deal", async () => {
    const { server, port } = await world();
    try {
      const table = await openGame(port, ALICE, [BOB], { start: false });
      /* Bob's stale tab (rules [10]) subscribed to the waiting table's log and room -- undealt, so it was served. */
      const staleLog = await Client.open(port, BOB, announce([PREV]));
      staleLog.hello(table.gameId);
      assert.equal((await firstAnswer(staleLog, "the waiting table's catch-up")).kind, "catch-up");
      const staleRoom = await Client.open(port, BOB, announce([PREV]));
      staleRoom.roomHello(table.gameId);
      await staleRoom.next((frame) => frame.kind === "room", "the waiting room");
      /* Alice's current tab and a legacy watcher tab, for contrast. */
      const aliceLog = await Client.open(port, ALICE, announce([NOW]));
      aliceLog.hello(table.gameId);
      await firstAnswer(aliceLog, "alice's catch-up");
      const legacyLog = await Client.open(port, ALICE);
      legacyLog.hello(table.gameId);
      await firstAnswer(legacyLog, "the legacy catch-up");

      const host = await Client.open(port, ALICE, announce([NOW]));
      const started = await host.op({ type: "start-game" }, table.gameId);
      assert.equal(started.ok, true, JSON.stringify(started));

      assert.equal(await closeOf(staleLog, "staleLog"), CLIENT_ANSWER_CLOSE_CODE);
      assert.deepEqual(staleLog.frames.slice(1), [{ kind: "reload", code: "client-rules", reason: CLIENT_ANSWER_SENTENCES["client-rules"], gameId: table.gameId }]);
      assert.deepEqual(staleLog.seen(), [], "the deal never reached the stale tab");
      assert.equal(await closeOf(staleRoom, "staleRoom"), CLIENT_ANSWER_CLOSE_CODE);
      const afterReload = staleRoom.frames.slice(staleRoom.frames.findIndex((frame) => frame.kind === "reload"));
      assert.deepEqual(afterReload.map((frame) => frame.kind), ["reload"], "nothing follows the reload on the room channel");
      assert.equal(staleRoom.frames.filter((frame) => frame.kind === "room" && (frame.view as { status: string }).status === "playing").length, 0, "the dealt view never reached it");

      await until(() => aliceLog.seen().length > 0 && legacyLog.seen().length > 0, "the deal reaches the others");
      assert.equal(aliceLog.seen()[0].index, 0);
      noLive4Frame(legacyLog, "the legacy tab");
      assert.equal(legacyLog.open && aliceLog.open, true);
      await Promise.all([aliceLog.close(), legacyLog.close(), host.close()]);
    } finally {
      await stopServer(server);
    }
  });

  test("route before LIVE-6: a game this release's bundle cannot play is answered as not continued here -- never a route frame, never 4426", async () => {
    const { server, port, v12 } = await world({}, { v12: true });
    try {
      assert.ok(v12 !== null);
      /* The game's pin (NEXT) is neither the tab's nor this release's -- the verdict is route/client-rules. */
      for (const query of [announce([NOW]), announce([NEXT]), announce([NOW, NEXT])]) {
        const tab = await Client.open(port, ALICE, query);
        tab.hello(v12);
        const answer = await firstAnswer(tab, query);
        assert.equal(answer.kind, "incompatible", query);
        assert.equal(answer.why, "rules-not-supported", query);
        assert.equal(answer.pinnedRulesEngineVersion, NEXT, query);
        tab.roomHello(v12);
        const view = (await tab.next((frame) => frame.kind === "room", "the view")).view as { holdKind: string; holdReason?: string };
        assert.equal(view.holdKind, "incompatible");
        assert.equal(view.holdReason, answer.reason, "the standing notice says the frame's own reason");
        await sleep(20);
        noLive4Frame(tab, query);
        assert.equal(tab.open, true, "the server did not close it 4426");
        await tab.close();
      }
    } finally {
      await stopServer(server);
    }
  });

  test("the standing notice says the actual reason: a hosted-protocol game's view carries its sentence -- no rules wording; a continued game's carries none", async () => {
    const { server, port, hosted2, dealt } = await world({}, { hosted2: true });
    try {
      assert.ok(hosted2 !== null);
      const tab = await Client.open(port, ALICE, announce([NOW]));
      tab.hello(hosted2);
      const answer = await firstAnswer(tab, "the hosted-2 hello");
      assert.deepEqual([answer.kind, answer.why], ["incompatible", "hosted-protocol"]);
      tab.roomHello(hosted2);
      const view = (await tab.next((frame) => frame.kind === "room", "the hosted-2 view")).view as { holdKind: string; holdReason?: string };
      assert.equal(view.holdKind, "incompatible");
      assert.equal(view.holdReason, answer.reason);
      assert.match(view.holdReason ?? "", /game-server protocol/);
      assert.doesNotMatch(view.holdReason ?? "", /rules/i);
      await tab.close();
      const live = await Client.open(port, ALICE, announce([NOW]));
      live.roomHello(dealt);
      const liveView = (await live.next((frame) => frame.kind === "room", "the live view")).view as Record<string, unknown>;
      assert.equal(liveView.holdKind, null);
      assert.equal("holdReason" in liveView, false);
      await live.close();
    } finally {
      await stopServer(server);
    }
  });

  test("protocol 0 retired (`legacy-refused`): only frames a legacy bundle understands -- never reload, route or 4426 -- and the socket is neither closed nor reaped", async () => {
    const retired = deploymentCapability({ ...thisDeploymentCapability([]), client_protocols: [1] });
    const { server, port, dealt } = await world({ capability: retired, limits: { rooms: { unsubscribedReapMs: 150 } } });
    try {
      const legacy = await Client.open(port, ALICE);
      legacy.hello(dealt);
      const told = await firstAnswer(legacy, "the legacy hello");
      assert.equal(told.kind, "incompatible");
      assert.equal(told.why, "client-protocol");
      assert.equal(told.pinnedRulesEngineVersion, null);
      assert.match(told.reason as string, /Reload the page/);
      legacy.submit(BUY, { baseIndex: 0, submissionId: "legacy-submit" });
      const submitAnswer = await legacy.answerTo("legacy-submit");
      assert.equal(submitAnswer.kind, "incompatible");
      const refusedOp = await legacy.op({ type: "my-tables" });
      assert.deepEqual([refusedOp.ok, refusedOp.code], [false, "unavailable"]);
      legacy.send({ kind: "rooms-watch", on: true });
      const listError = await legacy.next((frame) => frame.kind === "error", "the list refusal");
      assert.equal(listError.code, "unavailable");
      /* Past the unsubscribed-socket reap: still open (a close would only make a legacy bundle reconnect). */
      await sleep(400);
      assert.equal(legacy.open, true);
      noLive4Frame(legacy, "the refused legacy tab");
      assert.equal(kinds(legacy).includes("catch-up"), false, "no history reached it");
      assert.ok(server.clientAnswers.legacyRefused >= 4);

      /* On the same pool a protocol-1 tab is served. */
      const current = await Client.open(port, BOB, announce([NOW]));
      current.hello(dealt);
      assert.equal((await firstAnswer(current, "the protocol-1 hello")).kind, "catch-up");
      await Promise.all([legacy.close(), current.close()]);
    } finally {
      await stopServer(server);
    }
  });

  test("the legacy wire on this build's own pool: never a LIVE-4 frame or 4426, whatever it does; an unsubscribed legacy socket is reaped as before", async () => {
    const { server, port, dealt } = await world({ limits: { rooms: { unsubscribedReapMs: 150 } } });
    try {
      /* A pre-LIVE-4 tab with a stale build and a stale idea of the game: every answer is a legacy one. */
      const legacy = await Client.open(port, BOB);
      legacy.hello(dealt);
      await firstAnswer(legacy, "the legacy hello");
      legacy.roomHello(dealt);
      await legacy.next((frame) => frame.kind === "room", "the legacy view");
      legacy.submit(BUY, { baseIndex: 0, submissionId: "stale", build: "an-old-build" });
      assert.equal((await legacy.answerTo("stale")).kind, "build-skew");
      noLive4Frame(legacy, "the legacy tab");
      /* The reap is the legacy wire's too (only a REFUSED legacy socket is spared it). */
      const idle = await Client.open(port, CAROL);
      assert.equal(await closeOf(idle, "idle"), 1000);
      noLive4Frame(idle, "the idle legacy tab");
      assert.equal(server.clientAnswers.connectionReload + server.clientAnswers.gameReload + server.clientAnswers.legacyRefused, 0);
      await legacy.close();
    } finally {
      await stopServer(server);
    }
  });
});
