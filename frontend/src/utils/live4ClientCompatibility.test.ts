/** @jest-environment node */
//
// ==================================================================
//  LIVE-4 (L4-3): CLIENT COMPATIBILITY -- THE ANNOUNCEMENT, THE ANSWERS, RELOAD WITHOUT A LOOP, ROUTE WITHOUT A LEAK
// ==================================================================
//
// WHAT THIS FILE PROVES (the process-level half -- real sockets against a real server -- is
// `server/src/rooms/live4ClientCompatibility.test.ts`):
//   1. THE ANNOUNCEMENT. `cp` / `cr` / `cb` are written by one canonical function and read back by the one parser, as
//      a round trip; this bundle announces protocol 1 with its own rules; a repeated parameter, a missing or malformed
//      `cr`, a non-canonical `cp` are malformed; `cb` is carried only as a build id and never decides anything.
//   2. THE MAPPING, verdict by verdict (`clientAnswerFor`): ok / legacy talk; reload is its frame; route is a frame
//      only with a supplied destination and otherwise the game's own fail-closed answer; legacy-refused gets legacy
//      frames only. The frames carry no build, and a route carries paths only.
//   3. THE SESSION'S BUILD COMPARE IS THE LEGACY WIRE'S ONLY: a protocol-1 submit on another build is played; the
//      legacy wire (and anything that is not a protocol number) keeps `build-skew`.
//   4. RELOAD, ONCE: the page reloads once for an answer, keeps its table (the stored pointer is untouched), writes no
//      gameplay or money state, and the SAME answer after that reload asks instead of reloading again -- also when the
//      clock is set back, and always when the page cannot remember that it tried. Only time clears a marker (a normal
//      answer elsewhere is no evidence), alternating answers cannot defeat each other, and the tab navigates by itself
//      at most `MAX_AUTO_NAVIGATIONS` times in a window; "Back to the lobby" forgets the table and nothing else.
//   5. ROUTE: only a safe path on the page's origin (a bundle) or the game server's (a socket) is followed, at most
//      `MAX_ROUTE_HOPS` per game; an open redirect in any spelling, another game's route, or nothing to follow fails
//      closed as "cannot continue here".
//   6. THE LINKS: every socket announces this bundle; `reload`, `route` and 4426 end the link and never reconnect; a
//      deal this bundle cannot play is never handed over; `error` has its own case and an unknown frame is ignored.
//   7. THE COPY: rules versions are named only when the rules pin is the reason; every other reason says itself.
//   8. IDENTITY: accepted [0, 1], announced 1, and the capability key moved by `client_protocols` alone.

import {
  CLIENT_ANNOUNCEMENT_PARAMETERS,
  MAX_ANNOUNCED_RULES,
  clientAnnouncementQuery,
  clientVerdict,
  parseClientAnnouncement,
  rawClientAnnouncementOf,
  type ClientVerdict,
} from "../gameEngine/compat/clientCompatibility";
import {
  ACCEPTED_CLIENT_PROTOCOLS,
  ANNOUNCED_CLIENT_PROTOCOL,
  CLIENT_PROTOCOL_CHANGELOG,
  CLIENT_PROTOCOL_VERSION,
  FINANCIAL_PROTOCOL_VERSION,
  HOSTED_PROTOCOL_VERSION,
  LEGACY_CLIENT_PROTOCOL,
} from "../gameEngine/protocolVersions";
import { RULES_ENGINE_VERSION, SUPPORTED_RULES_ENGINE_VERSIONS } from "../gameEngine/rulesVersion";
import { SETTLEMENT_CERTIFIED_RULES_ENGINE_VERSIONS } from "../gameEngine/settlementAppraisal";
import { DEPLOYMENT_CAPABILITY_FORMAT, compatibilityKey, deploymentCapability, type DeploymentCapability } from "../gameEngine/compat/deploymentCapability";
import { notContinuedSentence, notServedSentence } from "../gameEngine/compat/sessionContinuation";
import type { ContinuationVerdict, ServeDecision } from "../gameEngine/compat/continuationVerdict";
import { SERVER_REPLAY_POLICY } from "../gameEngine/rulesVersion";
import { CLIENT_BUILD_ID } from "../config";
import { THIS_BUNDLE_ANNOUNCEMENT, withClientAnnouncement } from "./clientAnnouncement";
import {
  CLIENT_ANSWER_CLOSE_CODE,
  CLIENT_ANSWER_SENTENCES,
  MAX_ROUTE_PATH_LENGTH,
  clientAnswerFor,
  reloadFrameFor,
  routeFrameFor,
  routeTargetOf,
  safeRoutePath,
  type RouteEnvironment,
} from "./clientAnswers";
import {
  CLIENT_UPDATE_STORAGE_KEY,
  MAX_AUTO_NAVIGATIONS,
  MAX_ROUTE_HOPS,
  RELOAD_GUARD_MS,
  ROUTE_GUARD_MS,
  clientUpdateNotice,
  createClientUpdatePort,
  type ClientUpdatePort,
  type ClientUpdateState,
  type MarkerStorage,
} from "./clientUpdate";
import { connectServerLink, type SocketLike } from "./serverLink";
import {
  resetRoomLinks,
  roomOp,
  setRoomClientUpdate,
  setRoomSocketFactory,
  subscribeChat,
  watchPublicRooms,
  watchRoom,
  type RoomLoss,
  type SocketLike as RoomSocketLike,
} from "./roomLink";
import { HOLD_NOTICES, RULES_PIN_REASONS, holdNoticeFor, incompatibleNotice, refusalMessage, type RoomView } from "./roomProtocol";
import { ACTIVE_GAME_STORAGE_KEY, ACTIVE_SANDBOX_ROOM_STORAGE_KEY } from "./activeGame";
import { RoomSession } from "./roomSession";
import { sandboxReplayProviders } from "../gameEngine/replayProviders";
import { DEFAULT_SANDBOX_SCENARIO, sandboxScenario, sandboxScenarioState, sandboxWaterfallState } from "../gameEngine/sandboxState";
import { waterfallForRoster, withEmptyRoster } from "../gameEngine/gameSetup";
import { anchorIndex, readStripped } from "./sourceScan";

/* The room link opens sockets only where a game server is configured (hoisted above the imports by babel-jest). */
jest.mock("../config", () => ({ ...jest.requireActual("../config"), GAME_SERVER_URL: "wss://play.example/gs" }));

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const GAME = "g_0123456789abcdefghjkmnpqr0";
const OTHER = "g_aaaaaaaaaaaaaaaaaaaaaaaaa4";
const CHECKSUM = "5ecc302221a2dab4bb4f0f71b632f2beeafe9523ebd7b33bd0e94d017b8d09e8";

/** A pool like this build with no escrow backend, as its capability (the server's `thisDeploymentCapability([])`). */
const thisPool = (change: Partial<DeploymentCapability> = {}): DeploymentCapability =>
  deploymentCapability({
    format: DEPLOYMENT_CAPABILITY_FORMAT,
    rules: { current: RULES_ENGINE_VERSION, supported: SUPPORTED_RULES_ENGINE_VERSIONS, certified: SETTLEMENT_CERTIFIED_RULES_ENGINE_VERSIONS },
    hosted_protocols: [HOSTED_PROTOCOL_VERSION],
    financial_protocols: [],
    settlement_codecs: ["18JUNO/v1"],
    escrow_abi_checksums: [CHECKSUM],
    escrow_deployments: [],
    client_protocols: ACCEPTED_CLIENT_PROTOCOLS,
    ...change,
  });

/* Route v12 R12-2 moved the rules engine to 12. The cases below that are about THIS pool's rules read them from the
   engine (`NOW`, and `NEXT` for a release this one does not carry) rather than naming 11 / 12, so a later bump does
   not turn them into cases about something else; the literal protocol examples elsewhere stay literal. */
const NOW = RULES_ENGINE_VERSION;
const NEXT = RULES_ENGINE_VERSION + 1;

const query = (text: string) => new URLSearchParams(text);
const fromQuery = (text: string) => parseClientAnnouncement(rawClientAnnouncementOf(query(text)));
const verdictOf = (text: string, pin: number | null, pool: DeploymentCapability = thisPool()): ClientVerdict => clientVerdict(fromQuery(text), pool, pin);
const kindOf = (verdict: ClientVerdict): string => (verdict.kind === "reload" || verdict.kind === "route" ? `${verdict.kind}/${verdict.code}` : verdict.kind);

/** An in-memory `sessionStorage`. `fail`: every call throws; `dropWrites`: writes are silently lost. */
function memoryStorage(mode: "ok" | "fail" | "dropWrites" = "ok"): MarkerStorage & { data: Map<string, string>; writes: string[] } {
  const data = new Map<string, string>();
  const writes: string[] = [];
  return {
    data,
    writes,
    getItem: (key) => {
      if (mode === "fail") throw new Error("storage blocked");
      return data.has(key) ? (data.get(key) as string) : null;
    },
    setItem: (key, value) => {
      if (mode === "fail") throw new Error("storage blocked");
      writes.push(key);
      if (mode === "dropWrites") return;
      data.set(key, value);
    },
    removeItem: (key) => {
      if (mode === "fail") throw new Error("storage blocked");
      writes.push(key);
      data.delete(key);
    },
  };
}

/** The page: its storage (with the table pointer set, as `activeGame.ts` sets it), its clock and its navigation. */
function page(storage = memoryStorage(), start = 1_000_000) {
  storage.data.set(ACTIVE_SANDBOX_ROOM_STORAGE_KEY, GAME);
  storage.data.set(ACTIVE_GAME_STORAGE_KEY, JSON.stringify({ gameId: 0, roomId: "offline-sandbox", mode: "sandbox" }));
  storage.writes.length = 0;
  let now = start;
  const navigations: string[] = [];
  const make = () =>
    createClientUpdatePort({
      storage,
      navigate: { reload: () => navigations.push("reload"), assign: (url) => navigations.push(`assign ${url}`) },
      now: () => now,
      /* What the browser port does (`forgetActiveTable`): the router's active game and the table pointer. */
      forgetTable: () => {
        storage.removeItem(ACTIVE_GAME_STORAGE_KEY);
        storage.removeItem(ACTIVE_SANDBOX_ROOM_STORAGE_KEY);
      },
    });
  return {
    storage,
    navigations,
    /** A port for this page load (a reload makes a new one over the same storage). */
    load: make,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

/** A recording port, for the links. */
function recordingPort() {
  const calls: Array<[string, unknown]> = [];
  const port: ClientUpdatePort = {
    get state(): ClientUpdateState {
      return { kind: "idle" };
    },
    reload: (answer) => void calls.push(["reload", answer]),
    routeToBundle: (target) => void calls.push(["routeToBundle", target]),
    reloadNow: () => void calls.push(["reloadNow", null]),
    backToLobby: () => void calls.push(["backToLobby", null]),
    subscribe: () => () => undefined,
  };
  return { port, calls };
}

const ENV: RouteEnvironment = { pageOrigin: "https://play.example", bundleBase: "/", gameServerUrl: "wss://play.example/gs", gameId: GAME };

/* ================================================================================================= */
/* 1. THE ANNOUNCEMENT                                                                                */
/* ================================================================================================= */

describe("the announcement: one canonical writer, one parser, a round trip", () => {
  it("this bundle announces protocol 1, the rules its reducer carries, and its build", () => {
    expect(ANNOUNCED_CLIENT_PROTOCOL).toBe(1);
    const parsed = fromQuery(THIS_BUNDLE_ANNOUNCEMENT);
    expect(parsed).toEqual({ kind: "announced", protocol: 1, rules: [...SUPPORTED_RULES_ENGINE_VERSIONS], build: /^[A-Za-z0-9._-]{1,64}$/.test(CLIENT_BUILD_ID) ? CLIENT_BUILD_ID : null });
    expect(THIS_BUNDLE_ANNOUNCEMENT.startsWith(`cp=1&cr=${NOW}`)).toBe(true);
    expect(CLIENT_ANNOUNCEMENT_PARAMETERS).toEqual({ protocol: "cp", rules: "cr", build: "cb" });
  });

  it("writes the canonical query: ascending rules, a build only when it is a build id; the legacy protocol announces nothing", () => {
    expect(clientAnnouncementQuery(1, [11], "dev")).toBe("cp=1&cr=11&cb=dev");
    expect(clientAnnouncementQuery(1, [12, 10, 11], "abc.1-2_3")).toBe("cp=1&cr=10,11,12&cb=abc.1-2_3");
    expect(clientAnnouncementQuery(1, [11], null)).toBe("cp=1&cr=11");
    for (const build of ["", "has space", "a&cb=evil", "x".repeat(65), "é"]) expect(clientAnnouncementQuery(1, [11], build)).toBe("cp=1&cr=11");
    expect(clientAnnouncementQuery(LEGACY_CLIENT_PROTOCOL, [11], "dev")).toBe("");
    for (const [protocol, rules] of [
      [1, []],
      [1, [11, 11]],
      [1, [0]],
      [1, [-1]],
      [1, [1.5]],
      [1, Array.from({ length: MAX_ANNOUNCED_RULES + 1 }, (_, at) => at + 1)],
      [-1, [11]],
      [1.5, [11]],
      [Number.NaN, [11]],
    ] as Array<[number, number[]]>) {
      expect(() => clientAnnouncementQuery(protocol, rules, "dev")).toThrow(TypeError);
    }
  });

  it("reads back exactly what it wrote, through the URL's own parsing", () => {
    for (const [protocol, rules, build] of [
      [1, [11], "dev"],
      [1, [10, 11], null],
      [2, [11, 12, 13], "b-2"],
      [1, Array.from({ length: MAX_ANNOUNCED_RULES }, (_, at) => at + 1), "full"],
    ] as Array<[number, number[], string | null]>) {
      const url = new URL(withClientAnnouncement("wss://play.example/gs", clientAnnouncementQuery(protocol, rules, build)));
      expect(parseClientAnnouncement(rawClientAnnouncementOf(url.searchParams))).toEqual({ kind: "announced", protocol, rules: [...rules].sort((a, b) => a - b), build });
    }
  });

  it("puts the announcement on a socket URL before any fragment, beside any query, and leaves a legacy URL alone", () => {
    expect(withClientAnnouncement("wss://h/gs", "cp=1&cr=11")).toBe("wss://h/gs?cp=1&cr=11");
    expect(withClientAnnouncement("wss://h/gs?x=1", "cp=1&cr=11")).toBe("wss://h/gs?x=1&cp=1&cr=11");
    expect(withClientAnnouncement("wss://h/gs?", "cp=1&cr=11")).toBe("wss://h/gs?cp=1&cr=11");
    expect(withClientAnnouncement("wss://h/gs#frag", "cp=1&cr=11")).toBe("wss://h/gs?cp=1&cr=11#frag");
    expect(withClientAnnouncement("wss://h/gs", "")).toBe("wss://h/gs");
    expect(withClientAnnouncement("wss://h/gs")).toBe(`wss://h/gs?${THIS_BUNDLE_ANNOUNCEMENT}`);
  });

  it("a parameter given twice is never read as its first value: a repeated cp or cr is malformed; a repeated cb carries no build", () => {
    expect(fromQuery("cp=1&cp=1&cr=11")).toEqual({ kind: "malformed", protocol: null, problem: "cp is given more than once", build: null });
    expect(fromQuery("cp=1&cp=0&cr=11").kind).toBe("malformed"); // never a downgrade to the legacy wire
    expect(fromQuery("cp=1&cr=11&cr=11")).toEqual({ kind: "malformed", protocol: 1, problem: "cr is given more than once", build: null });
    expect(fromQuery("cp=1&cr=10&cr=11").kind).toBe("malformed"); // not quietly read as 10,11 either
    expect(fromQuery("cp=1&cr=11&cb=a&cb=b")).toEqual({ kind: "announced", protocol: 1, rules: [11], build: null });
    /* The legacy wire ignores cr altogether, repeated or not. */
    expect(fromQuery("cr=11&cr=12&cb=old")).toEqual({ kind: "legacy", protocol: 0, build: "old" });
    expect(fromQuery("")).toEqual({ kind: "legacy", protocol: 0, build: null });
    /* The shapes the transport never produces are never read as a value either. */
    expect(parseClientAnnouncement({ cp: 1 as unknown as string, cr: "11" }).kind).toBe("malformed");
    expect(parseClientAnnouncement({ cp: [], cr: "11" }).kind).toBe("legacy");
  });

  it("an unreadable announcement from a LIVE-4 tab is malformed -- never read as legacy, never as some default", () => {
    for (const text of ["cp=1", "cp=1&cr=", "cp=1&cr=11,11", "cp=1&cr=abc", "cp=1&cr=0", "cp=1&cr=011", "cp=1&cr=11,", "cp=1&cr=,11", "cp=1&cr=1%2011", "cp=x&cr=11", "cp=01&cr=11", "cp=&cr=11", "cp=-1&cr=11", "cp=1e0&cr=11"]) {
      expect({ text, kind: fromQuery(text).kind }).toEqual({ text, kind: "malformed" });
    }
    expect(fromQuery(`cp=1&cr=${Array.from({ length: MAX_ANNOUNCED_RULES + 1 }, (_, at) => at + 1).join(",")}`).kind).toBe("malformed");
  });

  it("cb is carried only as a build id -- a stranger's text never rides into a log -- and it never decides the verdict", () => {
    for (const [cb, carried] of [
      ["dev", "dev"],
      ["a.b-c_1", "a.b-c_1"],
      ["", null],
      ["x".repeat(64), "x".repeat(64)],
      ["x".repeat(65), null],
      ["<script>", null],
      ["line\nbreak", null],
    ] as Array<[string, string | null]>) {
      const parsed = parseClientAnnouncement({ cp: "1", cr: "11", cb });
      expect({ cb, build: parsed.build }).toEqual({ cb, build: carried });
      expect(clientVerdict(parsed, thisPool(), 11)).toEqual({ kind: "ok" });
    }
  });
});

/* ================================================================================================= */
/* 2. THE MAPPING, VERDICT BY VERDICT                                                                 */
/* ================================================================================================= */

describe("clientAnswerFor: every meaningful client verdict, and the frame (or the silence) it becomes", () => {
  it("ok: protocol 1 with the game's rules -- whatever build it is -- talks; so does an undealt game", () => {
    for (const cb of ["the-servers-build", "another-build", "dev"]) {
      expect(verdictOf(`cp=1&cr=11&cb=${cb}`, 11)).toEqual({ kind: "ok" });
      expect(clientAnswerFor(verdictOf(`cp=1&cr=11&cb=${cb}`, 11))).toEqual({ kind: "talk" });
    }
    expect(verdictOf("cp=1&cr=11", null)).toEqual({ kind: "ok" });
    expect(verdictOf("cp=1&cr=10,11,12", 11)).toEqual({ kind: "ok" });
  });

  it("legacy: no cp (or cp=0) on a pool that serves protocol 0 talks on the legacy path -- no per-game check", () => {
    for (const text of ["", "cb=old", "cp=0", "cp=0&cr=garbage"]) {
      for (const pin of [null, 10, 11, 12]) expect(clientAnswerFor(verdictOf(text, pin))).toEqual({ kind: "talk" });
      expect(verdictOf(text, 11)).toEqual({ kind: "legacy" });
    }
  });

  it("reload/client-protocol: a protocol this pool does not accept -- a future one, or protocol 1 on a legacy-only pool", () => {
    const future = verdictOf("cp=9&cr=11", 11);
    expect(kindOf(future)).toBe("reload/client-protocol");
    const answer = clientAnswerFor(future);
    expect(answer).toEqual({ kind: "reload", frame: { kind: "reload", code: "client-protocol", reason: CLIENT_ANSWER_SENTENCES["client-protocol"], accepted: [0, 1] } });
    expect(kindOf(verdictOf("cp=1&cr=11", 11, thisPool({ client_protocols: [0] })))).toBe("reload/client-protocol");
  });

  it("reload/client-announcement: a LIVE-4 tab whose announcement cannot be read", () => {
    for (const text of ["cp=1", "cp=1&cr=abc", "cp=x&cr=11", "cp=1&cp=1&cr=11"]) {
      const answer = clientAnswerFor(verdictOf(text, 11));
      expect(answer.kind).toBe("reload");
      expect(answer.kind === "reload" ? answer.frame.code : null).toBe("client-announcement");
      expect(answer.kind === "reload" ? answer.frame.accepted : null).toEqual([0, 1]);
    }
  });

  it("reload/client-rules: the tab lacks the game's rules, and THIS release's bundle carries them -- a per-game frame", () => {
    for (const text of [`cp=1&cr=${NOW - 1}`, `cp=1&cr=${NEXT}`, `cp=1&cr=9,${NOW - 1},${NEXT}`]) {
      const verdict = verdictOf(text, NOW);
      expect(kindOf(verdict)).toBe("reload/client-rules");
      expect(clientAnswerFor(verdict, { gameId: GAME, inReplyTo: "n1" })).toEqual({
        kind: "reload",
        frame: { kind: "reload", code: "client-rules", reason: CLIENT_ANSWER_SENTENCES["client-rules"], gameId: GAME, inReplyTo: "n1" },
      });
    }
  });

  it("route/client-rules: neither the tab nor this release carries the game's rules -- with no destination (before LIVE-6) the game's own fail-closed answer", () => {
    const verdict = verdictOf(`cp=1&cr=${NOW}`, NEXT);
    expect(kindOf(verdict)).toBe("route/client-rules");
    expect(clientAnswerFor(verdict, { gameId: GAME })).toEqual({ kind: "not-continued-here" });
    expect(clientAnswerFor(verdict, { gameId: GAME, destination: null })).toEqual({ kind: "not-continued-here" });
    expect(clientAnswerFor(verdict, { gameId: GAME, destination: {} })).toEqual({ kind: "not-continued-here" });
    /* With a destination (what LIVE-6 will supply): a route frame of PATHS only. */
    expect(clientAnswerFor(verdict, { gameId: GAME, destination: { bundlePath: "/r/12/", wsPath: "/gs/p/twelve" } })).toEqual({
      kind: "route",
      frame: { kind: "route", code: "client-rules", reason: CLIENT_ANSWER_SENTENCES.route, gameId: GAME, bundlePath: "/r/12/", wsPath: "/gs/p/twelve" },
    });
    /* A destination no client would follow is never sent: fail closed. */
    for (const bundlePath of ["https://evil.example/", "//evil.example/x", "/r/../x", "/r/%2e%2e/"]) {
      expect(clientAnswerFor(verdict, { gameId: GAME, destination: { bundlePath } })).toEqual({ kind: "not-continued-here" });
    }
    expect(() => routeFrameFor(verdict as Extract<ClientVerdict, { kind: "route" }>, { wsPath: "wss://evil.example/gs" })).toThrow(TypeError);
  });

  it("legacy-refused: protocol 0 on a pool that retired it -- legacy frames only, never a reload or route", () => {
    const retired = thisPool({ client_protocols: [1] });
    for (const pin of [null, 11, 12]) {
      const verdict = verdictOf("cb=old", pin, retired);
      expect(verdict.kind).toBe("legacy-refused");
      expect(clientAnswerFor(verdict, { gameId: GAME })).toEqual({ kind: "legacy-refused" });
    }
  });

  it("the frames carry no build and no host: a reload names its code, its sentence and (per game) its game; accepted rides only a connection-level one", () => {
    const connection = reloadFrameFor(verdictOf("cp=9&cr=11", null) as Extract<ClientVerdict, { kind: "reload" }>);
    expect(Object.keys(connection).sort()).toEqual(["accepted", "code", "kind", "reason"]);
    const perGame = reloadFrameFor(verdictOf("cp=1&cr=10", 11) as Extract<ClientVerdict, { kind: "reload" }>, { gameId: GAME });
    expect(Object.keys(perGame).sort()).toEqual(["code", "gameId", "kind", "reason"]);
    expect(JSON.stringify([connection, perGame])).not.toMatch(/build|cb|http|wss?:/);
    expect(CLIENT_ANSWER_CLOSE_CODE).toBe(4426);
  });
});

/* ================================================================================================= */
/* 3. THE SESSION'S BUILD COMPARE IS THE LEGACY WIRE'S ONLY                                           */
/* ================================================================================================= */

describe("RoomSession: step 1's build compare is the legacy wire's only", () => {
  const SERVER_BUILD = "server-build";
  const dealt = () => {
    let n = 0;
    const room = new RoomSession({
      providers: sandboxReplayProviders(),
      seed: {
        state: withEmptyRoster(sandboxScenarioState(DEFAULT_SANDBOX_SCENARIO, 0, "default")),
        waterfall: waterfallForRoster(sandboxWaterfallState(sandboxScenario(DEFAULT_SANDBOX_SCENARIO).phase, 0, true), []),
      },
      build: SERVER_BUILD,
      mintId: () => `id${(n += 1)}`,
      now: () => 1_000 + n,
    });
    const deal = { SetupGame: { players: [{ id: "p-alice", nickname: "Alice" }, { id: "p-bob", nickname: "Bob" }], variants: {} } } as never;
    expect(room.submit({ actor: "p-alice", build: SERVER_BUILD, msg: deal, baseIndex: -1 }).kind).toBe("applied");
    return room;
  };
  const BUY = { WaterfallBuyLowest: { game_id: 0 } } as never;

  it("a protocol-1 socket's submit on ANOTHER build is played (the transport judged it by its announcement)", () => {
    for (const clientProtocol of [1, 2, 7]) {
      const room = dealt();
      const answer = room.submit({ actor: room.state.player_addresses[0], build: "another-build", clientProtocol, msg: BUY, baseIndex: room.nextIndex - 1 });
      expect({ clientProtocol, kind: answer.kind }).toEqual({ clientProtocol, kind: "applied" });
    }
  });

  it("the legacy wire -- and anything that is not a protocol number -- keeps the exact build compare", () => {
    for (const clientProtocol of [undefined, 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "1" as unknown as number]) {
      const room = dealt();
      const before = room.entries.length;
      const answer = room.submit({ actor: room.state.player_addresses[0], build: "another-build", ...(clientProtocol === undefined ? {} : { clientProtocol }), msg: BUY, baseIndex: room.nextIndex - 1 });
      expect({ clientProtocol: String(clientProtocol), answer }).toEqual({ clientProtocol: String(clientProtocol), answer: { kind: "build-skew", clientBuild: "another-build", serverBuild: SERVER_BUILD } });
      expect(room.entries.length).toBe(before);
      /* ... and the same socket on the server's own build is played, as always. */
      expect(room.submit({ actor: room.state.player_addresses[0], build: SERVER_BUILD, ...(clientProtocol === undefined ? {} : { clientProtocol }), msg: BUY, baseIndex: room.nextIndex - 1 }).kind).toBe("applied");
    }
  });
});

/* ================================================================================================= */
/* 4. RELOAD, ONCE -- AND THE TABLE KEPT                                                              */
/* ================================================================================================= */

describe("the page's port: a reload happens once, keeps the table, writes nothing else, and never loops", () => {
  it("the first answer reloads the page once, and writes only the port's own marker -- the table pointer is untouched", () => {
    const tab = page();
    const port = tab.load();
    port.reload({ code: "client-rules", gameId: GAME });
    expect(tab.navigations).toEqual(["reload"]);
    expect(port.state).toEqual({ kind: "navigating", to: "reload", gameId: GAME });
    expect(new Set(tab.storage.writes)).toEqual(new Set([CLIENT_UPDATE_STORAGE_KEY]));
    expect(tab.storage.data.get(ACTIVE_SANDBOX_ROOM_STORAGE_KEY)).toBe(GAME);
    expect(JSON.parse(tab.storage.data.get(ACTIVE_GAME_STORAGE_KEY) as string)).toEqual({ gameId: 0, roomId: "offline-sandbox", mode: "sandbox" });
    /* A second answer while the page is leaving decides nothing more. */
    port.reload({ code: "client-protocol", gameId: null });
    port.routeToBundle({ url: "https://play.example/r/12/", gameId: GAME });
    expect(tab.navigations).toEqual(["reload"]);
  });

  it("the SAME answer after that reload does not reload again: the page asks (and says why); no loop", () => {
    const tab = page();
    tab.load().reload({ code: "client-rules", gameId: GAME });
    tab.advance(3_000);
    const reloaded = tab.load(); // the reloaded page, same tab storage
    reloaded.reload({ code: "client-rules", gameId: GAME });
    expect(tab.navigations).toEqual(["reload"]);
    expect(reloaded.state).toEqual({ kind: "needs-reload", code: "client-rules", gameId: GAME, repeated: true });
    const notice = clientUpdateNotice(reloaded.state);
    expect(notice?.body).toMatch(/was reloaded, but the game server still cannot serve it/);
    /* ... and again, and again: still no navigation. */
    for (let n = 0; n < 5; n += 1) {
      tab.advance(1_000);
      tab.load().reload({ code: "client-rules", gameId: GAME });
    }
    expect(tab.navigations).toEqual(["reload"]);
    /* The player's own Reload is always honoured, and re-arms the guard. */
    reloaded.reloadNow();
    expect(tab.navigations).toEqual(["reload", "reload"]);
    tab.load().reload({ code: "client-rules", gameId: GAME });
    expect(tab.navigations).toEqual(["reload", "reload"]);
  });

  it("per game and per code: another game's answer, or another code, reloads once of its own", () => {
    const tab = page();
    tab.load().reload({ code: "client-rules", gameId: GAME });
    tab.load().reload({ code: "client-rules", gameId: OTHER });
    expect(tab.navigations).toEqual(["reload", "reload"]);
    tab.load().reload({ code: "client-protocol", gameId: null });
    expect(tab.navigations).toEqual(["reload", "reload", "reload"]);
    tab.load().reload({ code: "client-protocol", gameId: GAME }); // connection-level: keyed to the page, not the game
    expect(tab.navigations).toHaveLength(3);
  });

  it("nothing but time clears a marker: a normal answer on another link is no evidence the reload helped (review F1)", () => {
    /* Two pools -- or a proxy that drops the query and a stale bundle -- can disagree at EVERY load: one link is answered
       normally while another is told `reload`. Were the normal answer read as "the reload worked", every load would
       re-arm the guard and reload again. The links tell the port nothing on a normal answer (below, sections 6-7), and
       the port has no way to clear a marker but its age. */
    const tab = page();
    for (let load = 0; load < 6; load += 1) {
      tab.advance(2_000);
      tab.load().reload({ code: "client-rules", gameId: GAME });
    }
    expect(tab.navigations).toEqual(["reload"]);
    expect("settled" in tab.load()).toBe(false);
    /* Once the window is over, a genuine update reloads once again. */
    tab.advance(RELOAD_GUARD_MS);
    tab.load().reload({ code: "client-rules", gameId: GAME });
    expect(tab.navigations).toEqual(["reload", "reload"]);
  });

  it("two answers that alternate cannot defeat each other's marker: each reloads at most once in a window", () => {
    const tab = page();
    for (let load = 0; load < 4; load += 1) {
      tab.advance(1_000);
      tab.load().reload({ code: "client-rules", gameId: GAME });
      tab.advance(1_000);
      tab.load().reload({ code: "client-protocol", gameId: null });
    }
    expect(tab.navigations).toEqual(["reload", "reload"]);
  });

  it(`whatever the answers, the tab navigates by itself at most MAX_AUTO_NAVIGATIONS (${MAX_AUTO_NAVIGATIONS}) times in a window -- then it asks`, () => {
    const tab = page();
    const games = ["g_a", "g_b", "g_c", "g_d", "g_e"];
    for (const game of games) tab.load().reload({ code: "client-rules", gameId: game });
    expect(tab.navigations).toHaveLength(MAX_AUTO_NAVIGATIONS);
    const asked = tab.load();
    asked.reload({ code: "client-announcement", gameId: null });
    /* A NEW answer on a spent budget is not "the reload did not help": it asks with the answer's own sentence. */
    expect(asked.state).toEqual({ kind: "needs-reload", code: "client-announcement", gameId: null, repeated: false });
    expect(clientUpdateNotice(asked.state)?.body).toBe(CLIENT_ANSWER_SENTENCES["client-announcement"]);
    asked.routeToBundle({ url: "https://play.example/r/12/", gameId: "g_f" });
    expect(tab.navigations).toHaveLength(MAX_AUTO_NAVIGATIONS);
    /* The player's own Reload is never counted, and is always honoured. */
    asked.reloadNow();
    expect(tab.navigations).toHaveLength(MAX_AUTO_NAVIGATIONS + 1);
    tab.advance(RELOAD_GUARD_MS);
    tab.load().reload({ code: "client-rules", gameId: "g_z" });
    expect(tab.navigations).toHaveLength(MAX_AUTO_NAVIGATIONS + 2);
  });

  it("Back to the lobby: the player's choice -- the tab forgets its table (nothing sent, nothing else written) and reloads into the lobby", () => {
    const tab = page();
    tab.load().reload({ code: "client-rules", gameId: GAME });
    const asked = tab.load();
    asked.reload({ code: "client-rules", gameId: GAME });
    expect(clientUpdateNotice(asked.state)?.lobby).toBe(true);
    tab.storage.writes.length = 0;
    asked.backToLobby();
    expect(tab.navigations).toEqual(["reload", "reload"]);
    expect(tab.storage.data.has(ACTIVE_SANDBOX_ROOM_STORAGE_KEY)).toBe(false);
    expect(tab.storage.data.has(ACTIVE_GAME_STORAGE_KEY)).toBe(false); // the router's too: the reload opens on the lobby
    expect(tab.storage.writes).toEqual([ACTIVE_GAME_STORAGE_KEY, ACTIVE_SANDBOX_ROOM_STORAGE_KEY]); // nothing else written
    expect(asked.state).toEqual({ kind: "navigating", to: "reload", gameId: null });
    /* A connection-level answer is about the whole page: no lobby to go back to. */
    const connection = page();
    connection.load().reload({ code: "client-protocol", gameId: null });
    const again = connection.load();
    again.reload({ code: "client-protocol", gameId: null });
    expect(clientUpdateNotice(again.state)?.lobby).toBe(false);
  });

  it("the guard lasts RELOAD_GUARD_MS; a clock set back counts as fresh (the safe side is to ask)", () => {
    const tab = page();
    tab.load().reload({ code: "client-protocol", gameId: null });
    tab.advance(RELOAD_GUARD_MS - 1);
    tab.load().reload({ code: "client-protocol", gameId: null });
    expect(tab.navigations).toHaveLength(1);
    tab.advance(1);
    tab.load().reload({ code: "client-protocol", gameId: null });
    expect(tab.navigations).toHaveLength(2);
    tab.advance(-10 * RELOAD_GUARD_MS);
    tab.load().reload({ code: "client-protocol", gameId: null });
    expect(tab.navigations).toHaveLength(2);
  });

  it("a page that cannot remember that it tried never reloads by itself: no storage, a blocked one, one that drops writes, a garbled marker it cannot replace", () => {
    for (const storage of [memoryStorage("fail"), memoryStorage("dropWrites")]) {
      const navigations: string[] = [];
      const port = createClientUpdatePort({ storage, navigate: { reload: () => navigations.push("reload"), assign: (url) => navigations.push(url) }, now: () => 1 });
      port.reload({ code: "client-rules", gameId: GAME });
      expect(navigations).toEqual([]);
      expect(port.state).toEqual({ kind: "needs-reload", code: "client-rules", gameId: GAME, repeated: false });
      port.routeToBundle({ url: "https://play.example/r/12/", gameId: GAME });
      expect(navigations).toEqual([]);
    }
    const none = createClientUpdatePort({ storage: null, navigate: { reload: () => { throw new Error("must not navigate"); }, assign: () => { throw new Error("must not navigate"); } }, now: () => 1 });
    none.reload({ code: "client-protocol", gameId: null });
    expect(none.state.kind).toBe("needs-reload");
    /* A garbled marker is dropped and replaced -- the page still reloads once, and only once. */
    const tab = page();
    tab.storage.data.set(CLIENT_UPDATE_STORAGE_KEY, "{not json");
    tab.load().reload({ code: "client-rules", gameId: GAME });
    tab.load().reload({ code: "client-rules", gameId: GAME });
    expect(tab.navigations).toEqual(["reload"]);
    tab.storage.data.set(CLIENT_UPDATE_STORAGE_KEY, JSON.stringify({ reload: { key: 7, at: "soon" }, route: { gameId: GAME, hops: -1, at: 1 } }));
    tab.load().reload({ code: "client-rules", gameId: GAME });
    expect(tab.navigations).toEqual(["reload", "reload"]);
    const other = page();
    other.storage.data.set(
      CLIENT_UPDATE_STORAGE_KEY,
      '{"reloads":{"__proto__":{"polluted":1},"client-rules|g_x":"soon"},"routes":{"__proto__":{"hops":9,"at":1},"g_y":{"hops":-1,"at":1}},"auto":["x",null]}',
    );
    other.load().reload({ code: "client-rules", gameId: GAME });
    expect(other.navigations).toEqual(["reload"]);
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
  });
});

/* ================================================================================================= */
/* 5. ROUTE: ONLY A SAFE PATH, ONLY SO MANY HOPS                                                      */
/* ================================================================================================= */

describe("route: a checked destination on a known origin, at most MAX_ROUTE_HOPS, or fail closed", () => {
  it("a route path is a plain absolute path -- every open-redirect spelling is refused", () => {
    for (const ok of ["/", "/r/11/", "/r/11", "/gs/p/dc1-68c4b829b3a20e63f3e55cde", "/a.b_c~d-e/", "/x".repeat(40)]) expect({ ok, safe: safeRoutePath(ok) }).toEqual({ ok, safe: ok });
    for (const bad of [
      "",
      "r/11",
      "//evil.example/",
      "///evil.example",
      "/\\evil.example",
      "\\\\evil.example",
      "https://evil.example/",
      "http:evil.example",
      // eslint-disable-next-line no-script-url -- the open-redirect spelling this list exists to refuse
      "javascript:alert(1)",
      "/r/../../x",
      "/r/./x",
      "/..",
      "/r//x",
      "/r/%2e%2e/x",
      "/%2F%2Fevil.example",
      "/r?x=1",
      "/r#frag",
      "/r x",
      "/r\tx",
      "/r\nx",
      "/r@evil.example",
      "/r:1",
      "/é",
      "/" + "a".repeat(MAX_ROUTE_PATH_LENGTH),
      7,
      null,
      { path: "/r/" },
    ] as unknown[]) {
      expect({ bad, safe: safeRoutePath(bad) }).toEqual({ bad, safe: null });
    }
  });

  it("routeTargetOf: a bundle on the page's own origin, a socket on the game server's own origin -- nothing else", () => {
    expect(routeTargetOf({ gameId: GAME, bundlePath: "/r/12/" }, ENV)).toEqual({ kind: "bundle", url: "https://play.example/r/12/", path: "/r/12/" });
    expect(routeTargetOf({ bundlePath: "/r/12/" }, ENV)).toEqual({ kind: "bundle", url: "https://play.example/r/12/", path: "/r/12/" });
    expect(routeTargetOf({ gameId: GAME, wsPath: "/gs/p/twelve" }, ENV)).toEqual({ kind: "socket", url: "wss://play.example/gs/p/twelve", path: "/gs/p/twelve" });
    /* This bundle's own base is no bundle route: the socket path decides. */
    expect(routeTargetOf({ gameId: GAME, bundlePath: "/", wsPath: "/gs/p/2" }, ENV)).toEqual({ kind: "socket", url: "wss://play.example/gs/p/2", path: "/gs/p/2" });
    expect(routeTargetOf({ gameId: GAME, bundlePath: "/r/11", wsPath: "/gs/p/2" }, { ...ENV, bundleBase: "/r/11/" }).kind).toBe("socket");
    /* Fail closed. */
    expect(routeTargetOf({ gameId: OTHER, bundlePath: "/r/12/" }, ENV)).toEqual({ kind: "none", why: "other-game" });
    expect(routeTargetOf({ gameId: GAME, bundlePath: "/r/12/" }, { ...ENV, gameId: null })).toEqual({ kind: "none", why: "other-game" });
    expect(routeTargetOf({ gameId: GAME }, ENV)).toEqual({ kind: "none", why: "no-destination" });
    expect(routeTargetOf({ gameId: GAME, bundlePath: "/" }, ENV)).toEqual({ kind: "none", why: "no-destination" });
    expect(routeTargetOf({ gameId: GAME, wsPath: "/gs/p/2" }, { ...ENV, gameServerUrl: null })).toEqual({ kind: "none", why: "no-destination" });
    for (const frame of [
      { gameId: GAME, bundlePath: "//evil.example/r/" },
      { gameId: GAME, bundlePath: "https://evil.example/" },
      { gameId: GAME, wsPath: "wss://evil.example/gs" },
      { gameId: GAME, wsPath: "//evil.example/gs" },
      { gameId: GAME, bundlePath: "/r/12/", wsPath: "https://evil.example" }, // one unsafe path poisons the frame
      { gameId: GAME, bundlePath: 12 },
    ]) {
      expect(routeTargetOf(frame, ENV)).toEqual({ kind: "none", why: "unsafe-destination" });
    }
  });

  it("the page follows a bundle route at most MAX_ROUTE_HOPS times per game in a window -- a ping-pong across loads ends -- keeping the table; then it says so", () => {
    const tab = page();
    for (let hop = 1; hop <= MAX_ROUTE_HOPS; hop += 1) tab.load().routeToBundle({ url: `https://play.example/r/${hop}/`, gameId: GAME });
    expect(tab.navigations).toEqual(Array.from({ length: MAX_ROUTE_HOPS }, (_, at) => `assign https://play.example/r/${at + 1}/`));
    const stuck = tab.load();
    stuck.routeToBundle({ url: "https://play.example/r/9/", gameId: GAME });
    expect(tab.navigations).toHaveLength(MAX_ROUTE_HOPS);
    expect(stuck.state).toEqual({ kind: "cannot-follow", gameId: GAME, why: "hops" });
    expect(clientUpdateNotice(stuck.state)?.title).toBe("This table cannot continue here right now");
    expect(tab.storage.data.get(ACTIVE_SANDBOX_ROOM_STORAGE_KEY)).toBe(GAME);
    /* Another game counts its own hops (the tab's budget allowing); nothing but the window resets them. */
    tab.load().routeToBundle({ url: "https://play.example/r/1/", gameId: OTHER });
    expect(tab.navigations).toHaveLength(MAX_ROUTE_HOPS + 1);
    const later = page();
    for (let hop = 0; hop < MAX_ROUTE_HOPS; hop += 1) later.load().routeToBundle({ url: "https://play.example/r/1/", gameId: GAME });
    later.advance(ROUTE_GUARD_MS - 1);
    later.load().routeToBundle({ url: "https://play.example/r/1/", gameId: GAME });
    expect(later.navigations).toHaveLength(MAX_ROUTE_HOPS);
    later.advance(1);
    later.load().routeToBundle({ url: "https://play.example/r/1/", gameId: GAME });
    expect(later.navigations).toHaveLength(MAX_ROUTE_HOPS + 1);
  });
});

/* ================================================================================================= */
/* 6. THE GAME LINK                                                                                   */
/* ================================================================================================= */

interface FakeSocket {
  url: string;
  socket: SocketLike;
  sent: Array<Record<string, unknown>>;
  open(): void;
  deliver(frame: unknown): void;
  closeWith(code: number): void;
}

function gameLink(over: Partial<Parameters<typeof connectServerLink>[0]> = {}) {
  const sockets: FakeSocket[] = [];
  const scheduled: Array<() => void> = [];
  const entries: unknown[][] = [];
  const incompatible: unknown[][] = [];
  const errors: string[] = [];
  const lost: string[] = [];
  const recorded = recordingPort();
  const client = connectServerLink({
    url: "wss://play.example/gs",
    gameId: GAME,
    build: "tab-build",
    onEntries: (batch) => entries.push([...batch]),
    onIncompatible: (...args) => incompatible.push(args),
    onError: (message) => errors.push(message),
    onAccessLost: (code) => lost.push(code),
    socketFactory: (url) => {
      const fake: FakeSocket = {
        url,
        sent: [],
        socket: {
          send: (data) => fake.sent.push(JSON.parse(data) as Record<string, unknown>),
          close: () => fake.socket.onclose?.({}),
          onopen: null,
          onmessage: null,
          onclose: null,
          onerror: null,
        },
        open: () => fake.socket.onopen?.({}),
        deliver: (frame) => fake.socket.onmessage?.({ data: JSON.stringify(frame) }),
        closeWith: (code) => fake.socket.onclose?.({ code }),
      };
      sockets.push(fake);
      return fake.socket;
    },
    schedule: (callback) => void scheduled.push(callback),
    mintSubmissionId: (() => {
      let n = 0;
      return () => `n${(n += 1)}`;
    })(),
    clientUpdate: recorded.port,
    routeEnvironment: { pageOrigin: "https://play.example", bundleBase: "/" },
    ...over,
  });
  return { client, sockets, scheduled, entries, incompatible, errors, lost, calls: recorded.calls, last: () => sockets[sockets.length - 1] };
}

const entry = (index: number, payload: object = { PassTurn: { game_id: 0 } }) => ({ index, id: `e${index}`, actor: "p-alice", payload: JSON.stringify(payload) });
const catchUp = (entries: unknown[] = []) => ({ kind: "catch-up", build: "server-build", digest: "0".repeat(16), entries, inFlight: [] });
const PASS = { PassTurn: { game_id: 0 } } as never;

describe("the game link speaks client protocol 1", () => {
  it("its socket carries this bundle's announcement; a hello answered normally tells the page's port nothing", () => {
    const { sockets, calls, last } = gameLink();
    expect(sockets).toHaveLength(1);
    expect(sockets[0].url).toBe(`wss://play.example/gs?${THIS_BUNDLE_ANNOUNCEMENT}`);
    const announced = parseClientAnnouncement(rawClientAnnouncementOf(new URL(sockets[0].url).searchParams));
    expect(announced.kind === "announced" ? [announced.protocol, announced.rules] : null).toEqual([1, [NOW]]);
    last().open();
    last().deliver(catchUp([entry(0)]));
    expect(calls).toEqual([]);
  });

  it.each([
    ["client-protocol", null],
    ["client-announcement", null],
    ["client-rules", GAME],
  ])("`reload` (%s) ends the link: pending settles null, nothing reconnects, nothing more is applied, the page decides once", async (code, gameId) => {
    const { client, scheduled, entries, calls, last } = gameLink();
    last().open();
    last().deliver(catchUp([entry(0)]));
    const pending = client.submit(PASS);
    last().deliver({ kind: "reload", code, reason: "whatever the server said", ...(code === "client-rules" ? { gameId: GAME } : { accepted: [0, 1] }) });
    await expect(pending).resolves.toBeNull();
    last().closeWith(CLIENT_ANSWER_CLOSE_CODE);
    last().deliver({ kind: "applied", entries: [entry(1)], digest: "1".repeat(16), build: "b" });
    last().deliver({ kind: "reload", code: "client-protocol", reason: "again" });
    expect(scheduled).toHaveLength(0);
    expect(entries).toHaveLength(1);
    expect(calls).toEqual([["reload", { code, gameId }]]);
  });

  it("a bare 4426 close is `reload/client-protocol`: terminal, never reconnected, never looped on", async () => {
    const { client, scheduled, calls, last, sockets } = gameLink();
    last().open();
    const pending = client.submit(PASS);
    last().closeWith(CLIENT_ANSWER_CLOSE_CODE);
    await expect(pending).resolves.toBeNull();
    expect(scheduled).toHaveLength(0);
    expect(sockets).toHaveLength(1);
    expect(calls).toEqual([["reload", { code: "client-protocol", gameId: null }]]);
    /* An ordinary drop still reconnects -- only 4426 (and 4410) end the link. */
    const ordinary = gameLink();
    ordinary.last().open();
    ordinary.last().closeWith(1006);
    expect(ordinary.scheduled).toHaveLength(1);
    expect(ordinary.calls).toEqual([]);
  });

  it("a `reload` that arrives while the link is resyncing is not dropped", () => {
    const { calls, last } = gameLink();
    last().open();
    last().deliver(catchUp([entry(0)]));
    last().deliver({ kind: "refused", code: "ahead", watermark: -1, reason: "ahead", inReplyTo: "n9" });
    last().deliver({ kind: "reload", code: "client-rules", gameId: GAME, reason: "r" });
    expect(calls.at(-1)).toEqual(["reload", { code: "client-rules", gameId: GAME }]);
  });

  it("`route` to another bundle hands the page a CHECKED url and ends the link", async () => {
    const { client, scheduled, calls, last } = gameLink();
    last().open();
    const pending = client.submit(PASS);
    last().deliver({ kind: "route", code: "client-rules", reason: "r", gameId: GAME, bundlePath: "/r/12/" });
    await expect(pending).resolves.toBeNull();
    last().closeWith(CLIENT_ANSWER_CLOSE_CODE);
    expect(scheduled).toHaveLength(0);
    expect(calls).toEqual([["routeToBundle", { url: "https://play.example/r/12/", gameId: GAME }]]);
  });

  it("`route` to another socket path reconnects THIS link there -- announced, saying hello again -- at most MAX_ROUTE_HOPS times, then fails closed", () => {
    const { sockets, scheduled, incompatible, calls, last } = gameLink();
    last().open();
    last().deliver(catchUp([entry(0)]));
    for (let hop = 1; hop <= MAX_ROUTE_HOPS; hop += 1) {
      last().deliver({ kind: "route", code: "client-rules", reason: "r", gameId: GAME, wsPath: `/gs/p/${hop}` });
      expect(scheduled).toHaveLength(hop);
      scheduled[hop - 1]();
      expect(last().url).toBe(`wss://play.example/gs/p/${hop}?${THIS_BUNDLE_ANNOUNCEMENT}`);
      last().open();
      expect(last().sent[0]).toMatchObject({ kind: "hello", gameId: GAME, baseIndex: 0 });
    }
    expect(sockets).toHaveLength(MAX_ROUTE_HOPS + 1);
    last().deliver({ kind: "route", code: "client-rules", reason: "r", gameId: GAME, wsPath: "/gs/p/again" });
    expect(sockets).toHaveLength(MAX_ROUTE_HOPS + 1);
    expect(incompatible).toEqual([[CLIENT_ANSWER_SENTENCES["route-unavailable"], null, SUPPORTED_RULES_ENGINE_VERSIONS, "client-rules"]]);
    expect(calls).toEqual([]);
  });

  it.each([
    ["no destination", {}],
    ["an off-site bundle", { bundlePath: "https://evil.example/" }],
    ["a protocol-relative bundle", { bundlePath: "//evil.example/r/" }],
    ["an off-site socket", { wsPath: "wss://evil.example/gs" }],
    ["a traversal", { bundlePath: "/r/../../x" }],
    ["another game's route", { gameId: OTHER, bundlePath: "/r/12/" }],
  ])("`route` with %s is followed nowhere: the link ends exactly as for a game this server does not continue", (_label, destination) => {
    const { sockets, scheduled, incompatible, calls, last } = gameLink();
    last().open();
    last().deliver({ kind: "route", code: "client-rules", reason: "r", gameId: GAME, ...destination });
    expect(incompatible).toEqual([[CLIENT_ANSWER_SENTENCES["route-unavailable"], null, SUPPORTED_RULES_ENGINE_VERSIONS, "client-rules"]]);
    expect(calls).toEqual([]);
    expect(scheduled).toHaveLength(0);
    expect(sockets).toHaveLength(1);
    /* The banner this becomes says "cannot continue here", and names no rules version. */
    expect(incompatibleNotice({ reason: incompatible[0][0] as string, pinned: null, supported: [11], why: "client-rules" })).toBe(CLIENT_ANSWER_SENTENCES["route-unavailable"]);
  });

  it("defence in depth: a deal this bundle's reducer does not carry is never handed to the shell; the link ends as reload/client-rules", () => {
    const { entries, calls, scheduled, last } = gameLink();
    last().open();
    const deal = (pin: unknown) => entry(0, { SetupGame: { players: [], variants: {}, rules_engine_version: pin } });
    last().deliver(catchUp([deal(NEXT), entry(1)]));
    expect(entries).toEqual([]);
    expect(calls).toEqual([["reload", { code: "client-rules", gameId: GAME }]]);
    expect(scheduled).toHaveLength(0);
    /* The same in a live push after a normal hello. */
    const live = gameLink();
    live.last().open();
    live.last().deliver(catchUp([]));
    live.last().deliver({ kind: "applied", entries: [deal(10)], digest: "1".repeat(16), build: "b" });
    expect(live.entries).toEqual([[]]);
    expect(live.calls).toEqual([["reload", { code: "client-rules", gameId: GAME }]]);
    /* A pin this bundle carries, or an unpinned (development-corpus) deal, is applied as ever. */
    for (const pin of [NOW, undefined]) {
      const fine = gameLink();
      fine.last().open();
      fine.last().deliver(catchUp([pin === undefined ? entry(0, { SetupGame: { players: [], variants: {} } }) : deal(pin)]));
      expect(fine.entries).toHaveLength(1);
      expect(fine.calls).toEqual([]);
    }
  });

  it("F-L4-7: `error` keeps its own case (resync and the access losses still work), and an unknown frame is ignored", async () => {
    const { client, errors, lost, entries, last } = gameLink();
    last().open();
    last().deliver(catchUp([entry(0)]));
    const pending = client.submit(PASS);
    last().deliver({ kind: "a-frame-from-a-later-server", inReplyTo: "n1", reason: "ignore me" });
    last().deliver({ kind: "a-frame-from-a-later-server" });
    expect(errors).toEqual([]);
    last().deliver({ kind: "applied", entries: [{ ...entry(1), submission_id: "n1" }], digest: "1".repeat(16), build: "b", inReplyTo: "n1" });
    await expect(pending).resolves.toBe(1);
    expect(entries).toHaveLength(2);
    last().deliver({ kind: "error", code: "bad-frame", reason: "The server did not accept that request." });
    expect(errors).toEqual(["The server did not accept that request."]);
    last().deliver({ kind: "error", code: "gone", reason: "That game is over." });
    expect(lost).toEqual(["gone"]);
  });

  it("the build is never the question: no frame the link sends names more than it did (the announcement rides the URL)", () => {
    const { client, last } = gameLink();
    last().open();
    void client.submit(PASS);
    const [hello, submit] = last().sent;
    expect(Object.keys(hello).sort()).toEqual(["baseIndex", "build", "gameId", "kind"]);
    expect(Object.keys(submit).sort()).toEqual(["baseIndex", "build", "kind", "msg", "submissionId"]);
  });
});

/* ================================================================================================= */
/* 7. THE ROOM LINK                                                                                   */
/* ================================================================================================= */

describe("the room link speaks client protocol 1 on every channel, the lobby's included", () => {
  interface RoomFake {
    url: string;
    socket: RoomSocketLike;
    sent: Array<Record<string, unknown>>;
    closed: boolean;
    open(): void;
    deliver(frame: unknown): void;
    closeWith(code: number): void;
  }
  let made: RoomFake[] = [];
  let recorded = recordingPort();

  beforeEach(() => {
    made = [];
    recorded = recordingPort();
    setRoomClientUpdate({ port: recorded.port, routeEnvironment: { pageOrigin: "https://play.example", bundleBase: "/" } });
    setRoomSocketFactory((url) => {
      const fake: RoomFake = {
        url,
        sent: [],
        closed: false,
        socket: {
          send: (data) => fake.sent.push(JSON.parse(data) as Record<string, unknown>),
          close: () => {
            if (fake.closed) return;
            fake.closed = true;
            fake.socket.onclose?.({ code: 1000 });
          },
          onopen: null,
          onmessage: null,
          onclose: null,
          onerror: null,
        },
        open: () => fake.socket.onopen?.(),
        deliver: (frame) => fake.socket.onmessage?.({ data: JSON.stringify(frame) }),
        closeWith: (code) => {
          fake.closed = true;
          fake.socket.onclose?.({ code });
        },
      };
      made.push(fake);
      return fake.socket;
    });
  });

  afterEach(() => {
    resetRoomLinks();
    setRoomClientUpdate({ port: null, routeEnvironment: null });
  });

  const view = (over: Partial<RoomView> = {}): RoomView => ({ gameId: GAME, code: null, joinable: false, visibility: "public", status: "waiting", lifecycle: "waiting", closed: false, held: false, holdKind: null, hostId: "p-1", players: [], playerCount: null, seatCap: 6, variants: {} as never, createdAtMs: 1, undoPolicy: { host_undo: "none" } as never, you: { role: "viewer", playerId: null, kicked: false, canStart: false }, ...over });

  it("every channel's socket announces this bundle; a view or the list answered normally tells the page's port nothing", () => {
    const views: RoomView[] = [];
    watchRoom(GAME, { onView: (next) => views.push(next) });
    watchPublicRooms(() => undefined);
    expect(made.map((fake) => fake.url)).toEqual([`wss://play.example/gs?${THIS_BUNDLE_ANNOUNCEMENT}`, `wss://play.example/gs?${THIS_BUNDLE_ANNOUNCEMENT}`]);
    made[0].open();
    made[0].deliver({ kind: "room", gameId: GAME, view: view() });
    made[1].open();
    made[1].deliver({ kind: "rooms", rooms: [] });
    expect(views).toHaveLength(1);
    expect(recorded.calls).toEqual([]);
  });

  it("a connection-level `reload` on the lobby's channel ends EVERY channel; nothing opens another socket; requests are answered with the sentence", async () => {
    const listErrors: string[] = [];
    const viewErrors: string[] = [];
    watchPublicRooms(() => undefined, (message) => listErrors.push(message));
    watchRoom(GAME, { onView: () => undefined, onError: (_code, reason) => viewErrors.push(reason) });
    made.forEach((fake) => fake.open());
    const pendingOp = roomOp({ type: "set-ready", ready: true }, GAME);
    made[0].deliver({ kind: "reload", code: "client-protocol", reason: "r", accepted: [0, 1] });
    await expect(pendingOp).resolves.toEqual({ ok: false, code: "unavailable", reason: CLIENT_ANSWER_SENTENCES["client-protocol"] });
    expect(made.every((fake) => fake.closed)).toBe(true);
    expect(listErrors).toEqual([CLIENT_ANSWER_SENTENCES["client-protocol"]]);
    expect(recorded.calls).toEqual([["reload", { code: "client-protocol", gameId: null }]]);
    const count = made.length;
    await expect(roomOp({ type: "my-tables" })).resolves.toEqual({ ok: false, code: "unavailable", reason: CLIENT_ANSWER_SENTENCES["client-protocol"] });
    watchRoom(OTHER, { onView: () => undefined, onError: (_code, reason) => viewErrors.push(reason) });
    watchPublicRooms(() => undefined, (message) => listErrors.push(message));
    expect(subscribeChat(OTHER, () => undefined)).toBeInstanceOf(Function);
    expect(made).toHaveLength(count);
    expect(viewErrors).toEqual([CLIENT_ANSWER_SENTENCES["client-protocol"]]);
    expect(listErrors).toHaveLength(2);
  });

  it("a per-game `reload` (client-rules) ends that game's channel only; that game is not asked again, the others are untouched", async () => {
    watchRoom(GAME, { onView: () => undefined });
    watchRoom(OTHER, { onView: () => undefined });
    made.forEach((fake) => fake.open());
    made[0].deliver({ kind: "reload", code: "client-rules", reason: "r", gameId: GAME });
    expect(made[0].closed).toBe(true);
    expect(made[1].closed).toBe(false);
    expect(recorded.calls).toEqual([["reload", { code: "client-rules", gameId: GAME }]]);
    await expect(roomOp({ type: "set-ready", ready: true }, GAME)).resolves.toEqual({ ok: false, code: "unavailable", reason: CLIENT_ANSWER_SENTENCES["client-rules"] });
    const count = made.length;
    void roomOp({ type: "set-ready", ready: true }, OTHER);
    expect(made).toHaveLength(count);
    expect(made[1].sent.filter((frame) => frame.kind === "room-op")).toHaveLength(1);
  });

  it("a bare 4426 on a game channel is a reload too, and nothing reconnects", () => {
    jest.useFakeTimers();
    try {
      watchRoom(GAME, { onView: () => undefined });
      made[0].open();
      made[0].closeWith(CLIENT_ANSWER_CLOSE_CODE);
      jest.advanceTimersByTime(60_000);
      expect(made).toHaveLength(1);
      expect(recorded.calls).toEqual([["reload", { code: "client-protocol", gameId: null }]]);
    } finally {
      jest.useRealTimers();
    }
  });

  it("`route`: to another bundle the page decides; to another socket path the channel re-attaches there and re-states its room-hello; with nowhere to go it is 'cannot continue here', and the table is kept", () => {
    const losses: RoomLoss[] = [];
    watchRoom(GAME, { onView: () => undefined, onLost: (loss) => losses.push(loss) });
    made[0].open();
    made[0].deliver({ kind: "route", code: "client-rules", reason: "r", gameId: GAME, wsPath: "/gs/p/2" });
    expect(made).toHaveLength(2);
    expect(made[1].url).toBe(`wss://play.example/gs/p/2?${THIS_BUNDLE_ANNOUNCEMENT}`);
    made[1].open();
    expect(made[1].sent).toEqual([{ kind: "room-hello", gameId: GAME }]);
    made[1].deliver({ kind: "route", code: "client-rules", reason: "r", gameId: GAME, bundlePath: "/r/12/" });
    expect(recorded.calls).toEqual([["routeToBundle", { url: "https://play.example/r/12/", gameId: GAME }]]);
    expect(made[1].closed).toBe(true);

    /* With nowhere to go: "cannot continue here" -- said to every listener, NOT a loss (review F3): the table is still
       this player's and kept as it was, so nothing tells the shell to forget it; a later subscriber hears it at once,
       and nothing reconnects. */
    const errors: Array<[string, string]> = [];
    const chatErrors: Array<[string, string]> = [];
    watchRoom(OTHER, { onView: () => undefined, onLost: (loss) => losses.push(loss), onError: (code, reason) => errors.push([code, reason]) });
    subscribeChat(OTHER, () => undefined, (code, reason) => chatErrors.push([code, reason]));
    const other = made[made.length - 1];
    other.open();
    other.deliver({ kind: "route", code: "client-rules", reason: "r", gameId: OTHER, bundlePath: "//evil.example/" });
    expect(losses).toEqual([]);
    expect(errors).toEqual([["unavailable", CLIENT_ANSWER_SENTENCES["route-unavailable"]]]);
    expect(refusalMessage(errors[0][0], errors[0][1])).toBe(CLIENT_ANSWER_SENTENCES["route-unavailable"]);
    expect(other.closed).toBe(true);
    expect(chatErrors).toEqual([["unavailable", CLIENT_ANSWER_SENTENCES["route-unavailable"]]]); // the chat is told too
    const count = made.length;
    watchRoom(OTHER, { onView: () => undefined, onLost: (loss) => losses.push(loss), onError: (code, reason) => errors.push([code, reason]) });
    subscribeChat(OTHER, () => undefined, (code, reason) => chatErrors.push([code, reason]));
    expect(errors).toHaveLength(2);
    expect(chatErrors).toHaveLength(2);
    expect(made).toHaveLength(count);
    expect(losses).toEqual([]);
    expect(recorded.calls).toHaveLength(1);
  });

  it("a per-game `reload` for a table this page just left (its channel idle, closing) retires the channel and does not reload the page", () => {
    const stop = watchRoom(GAME, { onView: () => undefined });
    made[0].open();
    stop(); // left the table: the channel closes after its idle moment
    made[0].deliver({ kind: "reload", code: "client-rules", reason: "r", gameId: GAME });
    expect(made[0].closed).toBe(true);
    expect(recorded.calls).toEqual([]);
  });
});

/* ================================================================================================= */
/* 8. THE COPY: THE ACTUAL REASON, AND RULES WORDING ONLY FOR THE RULES                               */
/* ================================================================================================= */

describe("player copy: the actual reason, and rules versions only when the rules pin is the reason", () => {
  const RULES_WORDING = /Pinned rules version|this server supports|rules engine version/;
  const verdicts: Array<Exclude<ContinuationVerdict, { kind: "continues" }>> = [
    { kind: "not-continued", why: "hosted-protocol", detail: "d" },
    { kind: "not-continued", why: "malformed", detail: "d" },
    { kind: "not-continued", why: "newer-format", detail: "d" },
    { kind: "not-continued", why: "older-format", detail: "d" },
    { kind: "not-continued", why: "rules-not-certified", detail: "d" },
    { kind: "not-continued", why: "financial-protocol", detail: "d" },
    { kind: "not-continued", why: "settlement-codec", detail: "d" },
    { kind: "not-continued", why: "deployment-unavailable", detail: "d" },
    { kind: "not-continued", why: "deployment-unverified", detail: "d" },
    { kind: "conflict", why: "deployment-conflict", detail: "d" },
    { kind: "conflict", why: "identity-conflict", detail: "d" },
  ];
  const decisions: Array<Exclude<ServeDecision, { kind: "serve" }>> = [
    { kind: "decline", why: "drain-expired", verdict: null, detail: "d", blocks_retirement: false } as Exclude<ServeDecision, { kind: "serve" }>,
    { kind: "decline", why: "pool-retired", verdict: null, detail: "d", blocks_retirement: false } as Exclude<ServeDecision, { kind: "serve" }>,
    { kind: "release", detail: "d", blocks_retirement: false } as unknown as Exclude<ServeDecision, { kind: "serve" }>,
  ];

  it("L4-2's finding, fixed: a hosted-protocol game on a v11 pool no longer reads 'Pinned rules version: 11; this server supports 11'", () => {
    const reason = notContinuedSentence({ kind: "not-continued", why: "hosted-protocol", detail: "d" }, { kind: "compatible", version: 11 } as never, SERVER_REPLAY_POLICY);
    const banner = incompatibleNotice({ reason, why: "hosted-protocol", pinned: 11, supported: [11] });
    expect(banner).toBe(reason);
    expect(banner).not.toMatch(RULES_WORDING);
    expect(banner).toMatch(/game-server protocol/);
  });

  it("every non-rules reason -- hosted, formats, money, deployments, conflicts, drain, retirement, release, a stale tab -- says itself, with no rules wording", () => {
    const whys: Array<[string, string]> = [
      ...verdicts.map((verdict): [string, string] => [
        verdict.kind === "conflict" ? `conflict/${verdict.why}` : verdict.why,
        notContinuedSentence(verdict, { kind: "compatible", version: 11 } as never, SERVER_REPLAY_POLICY),
      ]),
      ...decisions.map((decision): [string, string] => [decision.kind === "release" ? "release" : (decision as { why: string }).why, notServedSentence(decision)]),
      ["client-rules", CLIENT_ANSWER_SENTENCES["route-unavailable"]],
      ["client-protocol", "This page is out of date for this game server. Reload the page to continue."],
    ];
    for (const [why, reason] of whys) {
      expect(RULES_PIN_REASONS.has(why)).toBe(false);
      const banner = incompatibleNotice({ reason, why, pinned: 11, supported: [11] });
      expect({ why, banner }).toEqual({ why, banner: reason });
      expect({ why, rules: RULES_WORDING.test(banner) }).toEqual({ why, rules: false });
      expect(banner).not.toMatch(/\b(hosted-protocol|drain-expired|conflict\/|client-rules|client-protocol|deployment-unavailable)\b/);
    }
  });

  it("the rules reasons -- and an older server that sent no reason code -- still name the pinned and supported versions (#1520)", () => {
    const pinned = notContinuedSentence({ kind: "not-continued", why: "rules-not-supported", detail: "d" }, { kind: "incompatible", version: 10, supported: [11] } as never, SERVER_REPLAY_POLICY);
    expect(incompatibleNotice({ reason: pinned, why: "rules-not-supported", pinned: 10, supported: [11] })).toBe(`${pinned} (Pinned rules version: 10; this server supports 11.)`);
    const legacy = notContinuedSentence({ kind: "not-continued", why: "legacy-unpinned", detail: "d" }, { kind: "legacy" } as never, SERVER_REPLAY_POLICY);
    expect(incompatibleNotice({ reason: legacy, why: "legacy-unpinned", pinned: null, supported: [11] })).toBe(`${legacy} (Pinned rules version: none; this server supports 11.)`);
    expect(incompatibleNotice({ reason: "Old server words.", pinned: 9, supported: [10] })).toBe("Old server words. (Pinned rules version: 9; this server supports 10.)");
    expect(Array.from(RULES_PIN_REASONS).sort()).toEqual(["legacy-unpinned", "rules-not-supported"]);
  });

  it("a support reference never reaches the banner, and an empty reason reads as 'cannot continue on this server'", () => {
    expect(incompatibleNotice({ reason: "Something failed. (ref ABC123)", why: "malformed", pinned: 11, supported: [11] })).toBe("Something failed.");
    expect(incompatibleNotice({ reason: "", why: "hosted-protocol", pinned: 11, supported: [11] })).toBe(HOLD_NOTICES.incompatible);
  });

  it("the standing notice says the view's own reason when it carries one (only for `incompatible`), the general sentence otherwise", () => {
    const reason = "This game server stopped continuing games like this one seven days after a newer server took over. The game is kept exactly as it was.";
    expect(holdNoticeFor({ holdKind: "incompatible", holdReason: reason })).toBe(reason);
    expect(holdNoticeFor({ holdKind: "incompatible" })).toBe(HOLD_NOTICES.incompatible);
    expect(holdNoticeFor({ holdKind: "incompatible", holdReason: "" })).toBe(HOLD_NOTICES.incompatible);
    expect(holdNoticeFor({ holdKind: "incompatible", holdReason: "x".repeat(401) })).toBe(HOLD_NOTICES.incompatible);
    expect(holdNoticeFor({ holdKind: "incompatible", holdReason: "Kept. (ref ZZZ999)" })).toBe("Kept.");
    expect(holdNoticeFor({ holdKind: "maintenance", holdReason: reason })).toBe(HOLD_NOTICES.maintenance);
    expect(holdNoticeFor({ holdKind: null, holdReason: reason })).toBeNull();
  });

  it("what the page says when it will not reload by itself: plain words, no code, no version number", () => {
    const states: ClientUpdateState[] = [
      { kind: "needs-reload", code: "client-protocol", gameId: null, repeated: false },
      { kind: "needs-reload", code: "client-announcement", gameId: null, repeated: false },
      { kind: "needs-reload", code: "client-rules", gameId: GAME, repeated: false },
      { kind: "needs-reload", code: "client-rules", gameId: GAME, repeated: true },
      { kind: "cannot-follow", gameId: GAME, why: "hops" },
      { kind: "cannot-follow", gameId: GAME, why: "no-storage" },
    ];
    for (const state of states) {
      const notice = clientUpdateNotice(state);
      expect(notice).not.toBeNull();
      const text = `${notice?.title} ${notice?.body}`;
      expect(text).not.toMatch(/client-(protocol|rules|announcement)|reload\/|\b1[0-9]\b|g_[0-9a-z]{26}/);
      expect(text).toMatch(/[Rr]eload|[Tt]ry again/);
    }
    expect(clientUpdateNotice({ kind: "idle" })).toBeNull();
    expect(clientUpdateNotice({ kind: "navigating", to: "reload", gameId: null })).toBeNull();
    for (const sentence of Object.values(CLIENT_ANSWER_SENTENCES)) expect(sentence).not.toMatch(/\b(cp|cr|cb)=|client-|4426|build/);
  });
});

/* ================================================================================================= */
/* 9. IDENTITY: THE CONSTANTS, AND THE KEY MOVED BY CLIENT_PROTOCOLS ALONE                            */
/* ================================================================================================= */

describe("identity: client protocol 1 is spoken; nothing else moved", () => {
  it("accepted [0, 1], announced 1; rules 11 / [11] at L4-3 (12 / [12] since Route v12 R12-2) / certified [10, 11] (+12 since R12-3); hosted 1; financial 3", () => {
    expect([...ACCEPTED_CLIENT_PROTOCOLS]).toEqual([0, 1]);
    expect(ANNOUNCED_CLIENT_PROTOCOL).toBe(1);
    expect(CLIENT_PROTOCOL_VERSION).toBe(1);
    expect(CLIENT_PROTOCOL_CHANGELOG.map((row) => row.version)).toEqual([0, 1]);
    expect(CLIENT_PROTOCOL_CHANGELOG[1].note).toMatch(/spoken from L4-3/);
    // Phase 3 W3-K: rules engine v13 replaced 12 as the one supported version; settlement stays [10, 11, 12] (v13 PENDING).
    expect(RULES_ENGINE_VERSION).toBe(13);
    expect([...SUPPORTED_RULES_ENGINE_VERSIONS]).toEqual([13]);
    expect([...SETTLEMENT_CERTIFIED_RULES_ENGINE_VERSIONS]).toEqual([10, 11, 12]);
    expect(HOSTED_PROTOCOL_VERSION).toBe(1);
    expect(FINANCIAL_PROTOCOL_VERSION).toBe(3);
  });

  it("this build's no-escrow key moved from L4-2's dc1-5e141a8b… to dc1-68c4b829… -- and client_protocols is the only field that did", () => {
    /* The L4-3 move, reproduced on the rules it was made on (11): client_protocols is the only field that differs. */
    const atEleven = (change: Partial<DeploymentCapability> = {}) => thisPool({ rules: { current: 11, supported: [11], certified: [10, 11] }, ...change });
    expect(compatibilityKey(atEleven())).toBe("dc1-68c4b829b3a20e63f3e55cde");
    expect(compatibilityKey(atEleven({ client_protocols: [0] }))).toBe("dc1-5e141a8b20871e5069520928");
  });

  it("Route v12 R12-2 moved the key once more, on the rules axis alone: dc1-68c4b829… -> dc1-ade748b9…; R12-3's certification of 12 moved it again; W3-K's v13 again (dc1-390107d5…)", () => {
    // R12-2: rules 12, certified still [10, 11].
    expect(compatibilityKey(thisPool({ rules: { current: 12, supported: [12], certified: [10, 11] } }))).toBe("dc1-ade748b9407a3db380e5ed72");
    expect(compatibilityKey(thisPool({ rules: { current: 12, supported: [12], certified: [10, 11] }, client_protocols: [0] }))).toBe("dc1-38ec6470f41eb199b158126a");
    // R12-3: the certified list is a rules-axis field, so certifying 12 is a new pool.
    const atTwelve = { current: 12, supported: [12], certified: [10, 11, 12] };
    expect(compatibilityKey(thisPool({ rules: atTwelve }))).toBe("dc1-41eb96a737cd33aa90a62808");
    expect(compatibilityKey(thisPool({ rules: atTwelve, client_protocols: [0] }))).toBe("dc1-5a32b3ba76970f03f558aff4");
    // Phase 3 W3-K: rules engine v13 moves the key once more, on the rules axis alone (13 supported; 13 not certified).
    const now = thisPool();
    expect(now.rules).toEqual({ current: 13, supported: [13], certified: [10, 11, 12] });
    expect(compatibilityKey(now)).toBe("dc1-390107d5e7024f4a9180efeb");
    expect(compatibilityKey(thisPool({ client_protocols: [0] }))).toBe("dc1-de419f731b1a81e7f0d9dbbc");
    // Put the rules back and it is the LIVE-4 key again: nothing but the rules moved.
    expect(compatibilityKey(thisPool({ rules: { current: 11, supported: [11], certified: [10, 11] } }))).toBe("dc1-68c4b829b3a20e63f3e55cde");
  });
});

/* ================================================================================================= */
/* 10. NO BUILD DECIDES COMPATIBILITY                                                                 */
/* ================================================================================================= */

describe("source: no build comparison in the client-compatibility path", () => {
  it("the new modules compare no build; the one remaining compare is the legacy wire's, in RoomSession step 1", () => {
    for (const file of ["utils/clientAnswers.ts", "utils/clientUpdate.ts", "utils/clientAnnouncement.ts", "components/ClientUpdateNotice.tsx"]) {
      const code = readStripped(file);
      expect({ file, compares: /buildsAgree|\.build\s*[!=]==|[!=]==\s*\w*\.build\b|CLIENT_BUILD_ID\s*[!=]==/.test(code) }).toEqual({ file, compares: false });
    }
    const verdict = readStripped("gameEngine/compat/clientCompatibility.ts");
    const verdictBody = verdict.slice(anchorIndex(verdict, "export function clientVerdict", "clientVerdict"));
    expect(verdictBody.length).toBeGreaterThan(500);
    expect(verdictBody).not.toMatch(/\.build\b|\bcb\b/);
    const session = readStripped("utils/roomSession.ts");
    const calls = session.match(/buildsAgree\(/g) ?? [];
    expect(calls).toHaveLength(1);
    expect(session).toMatch(/if \(legacyWire && !buildsAgree\(input\.build, this\.options\.build\)\)/);
  });
});
