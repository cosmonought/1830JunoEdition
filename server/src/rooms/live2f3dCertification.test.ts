// server/src/rooms/live2f3dCertification.test.ts
//
// LIVE-2F / LIVE-3D: the combined hosted-authority certification's regressions -- one test per finding the pass fixed,
// each failing on the tree it certified (`6a367cb`) and passing after its fix. The fencing beacon's own cases live in
// `persistence/processLock.test.ts` ("the liveness beacon"); the reconciling refusal's code in `live3cRestore.test.ts`.
// See claude/LIVE2F_LIVE3D_HOSTED_AUTHORITY_CERTIFICATION_2026-09-27.md.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { createFileLogStore, type LogStore } from "../fileLogStore";
import type { GameServerOptions } from "../gameServer";
import { journalLine, scanJournal } from "../identity/journalStore";
import type { IdentityChange } from "../identity/store";
import { createFileHoldStore } from "./holdStore";
import { createFileRecordStore } from "./recordStore";
import { FROZEN_GAME_SENTENCE } from "./lifecycle";
import type { MyTableSummary as ServerMyTableSummary } from "./gameRecord";
import type { MyTableSummary as ClientMyTableSummary } from "../../../frontend/src/utils/roomProtocol";
import {
  ALICE,
  BOB,
  CAROL,
  Client,
  PROD_ORIGIN,
  apiRequest,
  cookieFromAnswer,
  openGame,
  profiledBrowser,
  quietConsole,
  sleep,
  startServer,
  stopServer,
  until,
  type Frame,
} from "./testSupport";

quietConsole();

/* C9-01: the client's "Your tables" entry is the server's, field for field (both directions, at compile time). */
const serverTable: ServerMyTableSummary = { gameId: "g_x", state: "resume", visibility: "private", hostNickname: "", nicknames: [], you: "player", createdAtMs: 0, lastActivityMs: 0 };
const _tableToClient: ClientMyTableSummary = serverTable;
const _tableToServer: ServerMyTableSummary = _tableToClient;
void _tableToServer;

const DAY = 24 * 60 * 60 * 1000;
const quiet = { warn: () => undefined };

function withDir<T>(tag: string, body: (dir: string) => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `live2f3d-${tag}-`));
  return body(dir).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

/** A server over file stores in `dir` (a restart is another `boot` of the same directory). */
async function boot(dir: string, over: Partial<GameServerOptions> = {}) {
  const store: LogStore = createFileLogStore(dir, quiet);
  const started = await startServer({ store, records: createFileRecordStore(dir, quiet), holds: createFileHoldStore(dir, quiet), ...over });
  await started.server.lifecycle.ready;
  return started;
}

async function opAs(port: number, claim: string, body: Record<string, unknown>, gameId?: string): Promise<Frame> {
  const client = await Client.open(port, claim);
  try {
    return await client.op(body, gameId);
  } finally {
    await client.close();
  }
}

type Table = { gameId: string; state: string; visibility: string; you: string; hostNickname: string; nicknames: string[] };
const myTables = async (port: number, claim: string): Promise<Table[]> => {
  const answer = await opAs(port, claim, { type: "my-tables" });
  assert.equal(answer.ok, true, JSON.stringify(answer));
  return (answer.data as { tables: Table[] }).tables;
};

/* ==================================================================
    C2-01 (High): BEFORE THE DEAL NOTHING IS GAMEPLAY
   ================================================================== */
describe("LIVE-2F/3D C2-01: a waiting game takes no gameplay", () => {
  test("a seated host's or guest's pre-deal submit is refused wrong-state and appends nothing; the server's deal is entry 0", async () => {
    const { server, port } = await startServer();
    try {
      const table = await openGame(port, ALICE, [BOB], { start: false });
      /* The six kinds the undealt seed board accepted on 6a367cb (offer answers, BeginOperatingRound, PassTurn). */
      const kinds: object[] = [
        { AnswerFundingPrivateOffer: { private_id: 0, accept: true } },
        { AnswerPrivatePurchase: { private_id: 0, accept: true } },
        { AnswerPrivateTrade: { private_id: 0, accept: true } },
        { AnswerTrainPurchase: { seller_protocol_id: 0, accept: true } },
        { BeginOperatingRound: {} },
        { PassTurn: {} },
      ];
      let n = 0;
      for (const claim of [ALICE, BOB]) {
        const client = await Client.open(port, claim);
        client.hello(table.gameId);
        await client.next((frame) => frame.kind === "catch-up", "the empty catch-up");
        for (const msg of kinds) {
          n += 1;
          client.submit(msg, { baseIndex: -1, submissionId: `pre-${n}` });
          const answer = await client.answerTo(`pre-${n}`);
          assert.deepEqual([answer.kind, answer.code], ["refused", "wrong-state"], `${claim} ${JSON.stringify(msg)}: ${JSON.stringify(answer)}`);
        }
        assert.equal(client.seen().length, 0, "nothing was appended");
        await client.close();
      }
      const started = await opAs(port, ALICE, { type: "start-game" }, table.gameId);
      assert.equal(started.ok, true, JSON.stringify(started));
      const reader = await Client.open(port, BOB);
      reader.hello(table.gameId);
      await until(() => reader.seen().length > 0, "the deal");
      const first = reader.seen()[0] as unknown as { index: number; payload: string };
      assert.equal(first.index, 0);
      assert.equal(Object.keys(JSON.parse(first.payload))[0], "SetupGame", "the server's deal is the first entry");
      await reader.close();
    } finally {
      await stopServer(server);
    }
  });
});

/* ==================================================================
    C9-01 (High, reachability): "YOUR TABLES"
   ================================================================== */
describe("LIVE-2F/3D C9-01: every seat is reachable from the lobby", () => {
  test("my-tables lists exactly the caller's seated tables (private and dealt included; kicked, outsider and cancelled not) -- ids only as game ids", () =>
    withDir("mine", async (dir) => {
      let booted = await boot(dir);
      let privateDealt = "";
      try {
        privateDealt = (await openGame(booted.port, ALICE, [BOB], { visibility: "private" })).gameId;
        const kicked = await openGame(booted.port, ALICE, [CAROL], { start: false });
        const cancelled = await openGame(booted.port, BOB, [], { start: false });
        const kick = await opAs(booted.port, ALICE, { type: "kick", playerId: kicked.playerIds[CAROL] }, kicked.gameId);
        assert.equal(kick.ok, true, JSON.stringify(kick));
        assert.equal((await opAs(booted.port, BOB, { type: "cancel-room" }, cancelled.gameId)).ok, true);

        const alice = await myTables(booted.port, ALICE);
        assert.deepEqual(alice.map((table) => [table.gameId, table.state, table.visibility, table.you]).sort(), [
          [kicked.gameId, "waiting", "public", "host"],
          [privateDealt, "playing", "private", "host"],
        ].sort());
        const bob = await myTables(booted.port, BOB);
        assert.deepEqual(bob.map((table) => [table.gameId, table.state, table.you]), [[privateDealt, "playing", "player"]], "the cancelled table is gone");
        assert.deepEqual(await myTables(booted.port, CAROL), [], "a kicked principal holds no seat, and an outsider none");
        const raw = JSON.stringify(alice);
        assert.ok(!/pr_|pf_|se_|JUNO-/.test(raw), `no principal id or code: ${raw}`);
      } finally {
        await stopServer(booted.server);
      }
      /* After a restart the dealt table is not reconciled until it is opened: listed (never its record's claim as
         its state), and opening it by game id restores the seat -- the path a new browser, tab or device takes. */
      booted = await boot(dir);
      try {
        const listed = await myTables(booted.port, BOB);
        assert.deepEqual(listed.map((table) => [table.gameId, table.state]), [[privateDealt, "resume"]]);
        const bob = await Client.open(booted.port, BOB);
        bob.roomHello(privateDealt);
        const view = (await bob.next((frame) => frame.kind === "room" || frame.kind === "error", "the view")) as Frame;
        assert.equal(view.kind, "room", JSON.stringify(view));
        assert.equal((view.view as { you: { role: string } }).you.role, "player");
        await bob.close();
        await until(() => booted.server.lifecycle.inventory().games.find((game) => game.gameId === privateDealt)?.cls === "active", "reconciled");
        assert.deepEqual((await myTables(booted.port, BOB)).map((table) => table.state), ["playing"]);
      } finally {
        await stopServer(booted.server);
      }
    }));
});

describe("LIVE-2F/3D independent review IR-02: a table discovery could not read is still reachable", () => {
  test("a seated game whose record read failed at startup is listed (as not yet reconciled) once the store answers", () =>
    withDir("unread", async (dir) => {
      let booted = await boot(dir);
      let gameId = "";
      try {
        gameId = (await openGame(booted.port, ALICE, [BOB], { visibility: "private" })).gameId;
      } finally {
        await stopServer(booted.server);
      }
      const files = createFileRecordStore(dir, quiet);
      let failures = 1;
      const flaky = {
        ...files,
        list: () => files.list(),
        load: async (id: string) => {
          if (id === gameId && failures > 0) {
            failures -= 1;
            throw Object.assign(new Error("EIO: injected read failure"), { code: "EIO" });
          }
          return files.load(id);
        },
        put: (record: Parameters<typeof files.put>[0], expected: Parameters<typeof files.put>[1]) => files.put(record, expected),
        lookupCode: (code: string) => files.lookupCode(code),
        claimCode: (code: string, id: string) => files.claimCode(code, id),
        releaseCode: (code: string, id: string) => files.releaseCode(code, id),
        reconcileIndex: files.reconcileIndex?.bind(files),
      };
      booted = await boot(dir, { records: flaky });
      try {
        assert.equal(booted.server.lifecycle.inventory().games.find((game) => game.gameId === gameId)?.cls, "unavailable", "control: discovery could not read it");
        assert.deepEqual((await myTables(booted.port, BOB)).map((table) => [table.gameId, table.state]), [[gameId, "resume"]]);
      } finally {
        await stopServer(booted.server);
      }
    }));
});

/* ==================================================================
    C4-01 / C4-05 (Medium / Low): A GAME DEALT ON ANOTHER BUILD IS FROZEN, AND FROZEN GAMES HOLD NO CAPS
   ================================================================== */
describe("LIVE-2F/3D C4-01 / C4-05: read-only games", () => {
  test("a game dealt on another build takes no open-table cap and no room change (its host too); a leave only unsubscribes", () =>
    withDir("read-only", async (dir) => {
      const caps = { limits: { rooms: { maxHostedRooms: 1 } } } as Partial<GameServerOptions>;
      let booted = await boot(dir, { build: "build-one", ...caps });
      let gameId = "";
      let bob = "";
      try {
        const game = await openGame(booted.port, ALICE, [BOB]);
        gameId = game.gameId;
        bob = game.playerIds[BOB];
        assert.equal((await opAs(booted.port, ALICE, { type: "create", visibility: "public", exactPlayers: null, variants: {}, nickname: "A" })).code, "limit-reached", "control: the cap is one hosted table");
      } finally {
        await stopServer(booted.server);
      }
      booted = await boot(dir, { build: "build-two", ...caps });
      try {
        const alice = await Client.open(booted.port, ALICE);
        alice.roomHello(gameId);
        const view = await alice.next((frame) => frame.kind === "room", "the view");
        assert.equal((view.view as { holdKind: string }).holdKind, "read-only");
        await until(() => booted.server.lifecycle.inventory().games.find((entry) => entry.gameId === gameId)?.cls === "read-only", "read-only");
        const before = fs.readFileSync(path.join(dir, "games", `${gameId}.json`));
        const transfer = await alice.op({ type: "transfer-host", toPlayerId: bob }, gameId);
        assert.deepEqual([transfer.ok, transfer.code, transfer.reason], [false, "wrong-state", FROZEN_GAME_SENTENCE]);
        assert.ok(fs.readFileSync(path.join(dir, "games", `${gameId}.json`)).equals(before), "the record is kept exactly as it was");
        assert.equal((await alice.op({ type: "leave" }, gameId)).ok, true, "leave only unsubscribes");
        await alice.close();
        const created = await opAs(booted.port, ALICE, { type: "create", visibility: "public", exactPlayers: null, variants: {}, nickname: "A" });
        assert.equal(created.ok, true, `a read-only game holds no cap: ${JSON.stringify(created)}`);
      } finally {
        await stopServer(booted.server);
      }
    }));
});

/* ==================================================================
    C4-10 (Low): AN EMPTY LOG FILE IS AN EMPTY LOG
   ================================================================== */
describe("LIVE-2F/3D C4-10: a zero-byte log", () => {
  test("readHead reports an empty file as no log, so its waiting table is classified (and listed) from its record", () =>
    withDir("empty-log", async (dir) => {
      let booted = await boot(dir);
      let gameId = "";
      try {
        gameId = (await openGame(booted.port, ALICE, [BOB], { start: false })).gameId;
      } finally {
        await stopServer(booted.server);
      }
      fs.writeFileSync(path.join(dir, `${gameId}.log.jsonl`), "");
      const heads = createFileLogStore(dir, quiet);
      assert.deepEqual(await heads.readHead?.(gameId), { present: false, size: 0, first: null });
      booted = await boot(dir);
      try {
        assert.equal(booted.server.lifecycle.inventory().games.find((entry) => entry.gameId === gameId)?.cls, "waiting");
      } finally {
        await stopServer(booted.server);
      }
    }));
});

/* ==================================================================
    C1-01 / C1-03 (Medium / Low): "SIGN OUT THIS DEVICE" SIGNS THE WHOLE BROWSER OUT
   ================================================================== */
describe("LIVE-2F/3D C1-01 / C1-03: sign-out and rotated sessions", () => {
  const prodServer = async (clock: { now: number }) =>
    startServer({
      identity: {
        mode: "production",
        allowedOrigins: [PROD_ORIGIN],
        trustedProxyHops: 0,
        now: () => clock.now,
      },
    });
  const bootstrap = (port: number, cookie: string) => apiRequest(port, "/gs/api/session", { cookie, body: {} });
  const signOut = (port: number, cookie: string) => apiRequest(port, "/gs/api/session/revoke", { cookie, body: {} });

  test("C1-01: a socket opened on the browser's rotated predecessor -- rotated more than a day ago -- closes 4401 at sign-out", async () => {
    const clock = { now: Date.now() };
    const { server, port } = await prodServer(clock);
    try {
      const ann = await profiledBrowser(port, "Ann");
      const oldTab = await Client.openWithCookie(port, ann.cookie, "ann-old-tab");
      clock.now += 8 * DAY; // another tab bootstraps a week-old session: S1 rotates to S2
      const rotated = await bootstrap(port, ann.cookie);
      assert.equal((rotated.body as { rotated?: boolean }).rotated, true);
      const s2 = cookieFromAnswer(rotated) as string;
      clock.now += 2 * DAY; // past the predecessor's grace
      assert.equal((await signOut(port, s2)).status, 204);
      assert.equal(await Promise.race([oldTab.closed, sleep(2_000).then(() => "still open")]), 4401, "the old tab is signed out with the browser");
    } finally {
      await stopServer(server);
    }
  });

  test("C1-03b: signing out with a rotated cookie still in its grace (its successor's Set-Cookie was lost) signs the browser out", async () => {
    const clock = { now: Date.now() };
    const { server, port } = await prodServer(clock);
    try {
      const ann = await profiledBrowser(port, "Ann");
      clock.now += 8 * DAY;
      const rotated = await bootstrap(port, ann.cookie); // S1 -> S2; this browser never stored S2
      const s2 = cookieFromAnswer(rotated) as string;
      clock.now += 60 * 60 * 1000;
      const out = await signOut(port, ann.cookie);
      assert.equal(out.status, 204, out.text);
      assert.match(String(out.headers["set-cookie"]), /Max-Age=0/, "the cookie is cleared");
      assert.equal((await bootstrap(port, ann.cookie)).status, 401, "the in-grace cookie mints no successor any more");
      assert.equal((await bootstrap(port, s2)).status, 401, "and the successor it rotated into is ended with it");
      const stranger = await signOut(port, "__Host-gs_session=v1.se_0000000000000000000000000.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
      assert.equal(stranger.status, 401);
      assert.match(String(stranger.headers["set-cookie"]), /Max-Age=0/, "a 401 clears the cookie the client will read as signed out");
    } finally {
      await stopServer(server);
    }
  });
});

/* ==================================================================
    C1-02 / C7-04 (Low / Medium): ONLY ONE CHANGE CAN BE TORN
   ================================================================== */
describe("LIVE-2F/3D C1-02 / C7-04: the identity journal's torn tail is one line at most", () => {
  const change = (n: number): IdentityChange => ({ sessions: [], dropLinks: [`${n}`.padStart(64, "0")] }) as unknown as IdentityChange;
  const lines = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, k) => journalLine(from + k, change(from + k))).join("");

  test("a torn final line is torn (control); damage over two lines, or a whole change glued behind damage, is corrupt", () => {
    const good = lines(1, 3);
    const torn = scanJournal(Buffer.from(good + journalLine(4, change(4)).slice(0, 30)), 0);
    assert.deepEqual([torn.classification, torn.changes.length], ["torn", 3]);
    const garbledLast = scanJournal(Buffer.from(good + journalLine(4, change(4)).replace("sha256", "sha25X")), 0);
    assert.deepEqual([garbledLast.classification, garbledLast.changes.length], ["torn", 3], "one whole damaged line is the in-flight one");

    const rotted = journalLine(3, change(3)).replace("sha256", "shaXXX"); // an ACKNOWLEDGED line, damaged
    const twoLines = scanJournal(Buffer.from(lines(1, 2) + rotted + journalLine(4, change(4)).slice(0, 20)), 0);
    assert.equal(twoLines.classification, "corrupt", twoLines.detail);

    const hole = Buffer.concat([Buffer.from(lines(1, 2)), Buffer.alloc(40), Buffer.from(journalLine(3, change(3)))]);
    const glued = scanJournal(hole, 0);
    assert.equal(glued.classification, "corrupt", glued.detail);
  });
});
