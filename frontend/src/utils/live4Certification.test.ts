/** @jest-environment node */
//
// ==================================================================
//  LIVE-4 L4-7: THE SOCKET INVENTORY -- EVERY SOCKET THIS BUNDLE OPENS ANNOUNCES IT, EXACTLY ONCE
// ==================================================================
//
// L4-3 proved each link announces this bundle when it opens. The final certification asks the inventory question
// the other way round: WHERE can this bundle open a socket at all, and does every one of those places -- the first
// open, every reconnect, every routed re-attach, the lobby's channel, a room's, a game's log -- carry exactly one
// `cp`, one `cr` and one `cb`, read back by the one parser as this bundle's announcement?
//
//   1. BY SOURCE. Exactly two sockets are constructed in the whole production tree (the room link's default factory
//      and the game link's), each factory is invoked at exactly one place, and that place wraps the URL in
//      `withClientAnnouncement`. No production caller overrides the announcement or the factory.
//   2. BY BEHAVIOUR. Every URL the links open, over an open, an ordinary drop and its reconnect, and a routed
//      re-attach, carries the announcement once (a repeated `cp` or `cr` would make the server's parser call the tab
//      malformed and tell it to reload).
//   3. THE BUILD IS A DIAGNOSTIC. A bundle built with another build id announces the same `cp` and `cr`; only `cb`
//      differs, and the verdict it gets is the same.
//
// The server half (parsed once per connection, by the canonical parser; the query kept by the local proxy; an edge
// that strips it turns the tab into a legacy one) is `server/src/rooms/live4Certification.test.ts` §6.

import { CLIENT_ANNOUNCEMENT_PARAMETERS, clientVerdict, parseClientAnnouncement, rawClientAnnouncementOf } from "../gameEngine/compat/clientCompatibility";
import { DEPLOYMENT_CAPABILITY_FORMAT, deploymentCapability } from "../gameEngine/compat/deploymentCapability";
import { ACCEPTED_CLIENT_PROTOCOLS, ANNOUNCED_CLIENT_PROTOCOL, HOSTED_PROTOCOL_VERSION } from "../gameEngine/protocolVersions";
import { RULES_ENGINE_VERSION, SUPPORTED_RULES_ENGINE_VERSIONS } from "../gameEngine/rulesVersion";
import { SETTLEMENT_CERTIFIED_RULES_ENGINE_VERSIONS } from "../gameEngine/settlementAppraisal";
import { CLIENT_BUILD_ID } from "../config";
import { THIS_BUNDLE_ANNOUNCEMENT } from "./clientAnnouncement";
import type { ClientUpdatePort, ClientUpdateState } from "./clientUpdate";
import { connectServerLink, type SocketLike } from "./serverLink";
import { resetRoomLinks, roomOp, setRoomClientUpdate, setRoomSocketFactory, subscribeChat, watchPublicRooms, watchRoom, type SocketLike as RoomSocketLike } from "./roomLink";
import { discoverSources, readShell, readStripped, shellSourcePaths } from "./sourceScan";

/* The room link opens sockets only where a game server is configured (hoisted above the imports by babel-jest). */
jest.mock("../config", () => ({ ...jest.requireActual("../config"), GAME_SERVER_URL: "wss://play.example/gs" }));

const GAME = "g_0123456789abcdefghjkmnpqr0";
const BUILD_ID = /^[A-Za-z0-9._-]{1,64}$/;

/** Every announcement parameter's values on `url`, and what the one parser reads from them. */
function announcementOn(url: string) {
  const params = new URL(url).searchParams;
  return {
    cp: params.getAll(CLIENT_ANNOUNCEMENT_PARAMETERS.protocol),
    cr: params.getAll(CLIENT_ANNOUNCEMENT_PARAMETERS.rules),
    cb: params.getAll(CLIENT_ANNOUNCEMENT_PARAMETERS.build),
    parsed: parseClientAnnouncement(rawClientAnnouncementOf(params)),
  };
}

/** What every socket this bundle opens must carry: one cp (1), one cr (its reducer's rules), at most one cb (its
 *  build, when it is a build id). */
function expectThisBundle(url: string): void {
  const seen = announcementOn(url);
  expect(seen.cp).toEqual([String(ANNOUNCED_CLIENT_PROTOCOL)]);
  expect(seen.cr).toEqual([SUPPORTED_RULES_ENGINE_VERSIONS.join(",")]);
  expect(seen.cb).toEqual(BUILD_ID.test(CLIENT_BUILD_ID) ? [CLIENT_BUILD_ID] : []);
  expect(seen.parsed).toEqual({ kind: "announced", protocol: ANNOUNCED_CLIENT_PROTOCOL, rules: [...SUPPORTED_RULES_ENGINE_VERSIONS], build: BUILD_ID.test(CLIENT_BUILD_ID) ? CLIENT_BUILD_ID : null });
}

const idlePort = (): ClientUpdatePort => ({
  get state(): ClientUpdateState {
    return { kind: "idle" };
  },
  reload: () => undefined,
  routeToBundle: () => undefined,
  reloadNow: () => undefined,
  backToLobby: () => undefined,
  subscribe: () => () => undefined,
});

/* ================================================================================================= */
/* 1. By source                                                                                       */
/* ================================================================================================= */

describe("the socket inventory, by source", () => {
  const shell = new Set(shellSourcePaths());
  const production = discoverSources("").filter((rel) => !shell.has(rel));
  const texts = new Map(production.map((rel) => [rel, readStripped(rel)] as const));
  /** Every production file (the shell aside) with its comment-stripped text. */
  const entries: ReadonlyArray<readonly [string, string]> = production.map((rel) => [rel, texts.get(rel) as string] as const);
  const SHELL = readShell();

  it("reads the whole production tree (the shell through its reader)", () => {
    expect(production.length).toBeGreaterThan(100);
    expect(texts.has("utils/roomLink.ts") && texts.has("utils/serverLink.ts")).toBe(true);
    expect(SHELL.length).toBeGreaterThan(100_000);
  });

  it("exactly two sockets are constructed -- the room link's factory and the game link's -- and no other transport exists", () => {
    const constructed = entries.flatMap(([rel, text]) => (text.match(/\bnew\s+WebSocket\s*\(/g) ?? []).map(() => rel)).sort();
    expect(constructed).toEqual(["utils/roomLink.ts", "utils/serverLink.ts"]);
    expect(SHELL).not.toMatch(/\bWebSocket\b/);
    const others = entries.filter(([, text]) => /\bEventSource\b|\bRTCPeerConnection\b|\bWebTransport\b/.test(text)).map(([rel]) => rel);
    expect(others).toEqual([]);
    expect(SHELL).not.toMatch(/\bEventSource\b|\bRTCPeerConnection\b|\bWebTransport\b/);
  });

  it("each factory is invoked at exactly one place, and that place announces this bundle", () => {
    const room = texts.get("utils/roomLink.ts") as string;
    expect(room.match(/\bsocketFactory\s*\(/g)).toHaveLength(1);
    expect(room).toMatch(/\bsocketFactory\(socketUrlFor\(announcementOverride === null \? withClientAnnouncement\(url\) : withClientAnnouncement\(url, announcementOverride\)\)\)/);
    const game = texts.get("utils/serverLink.ts") as string;
    expect(game.match(/\bmake\s*\(/g)).toHaveLength(1);
    expect(game).toMatch(/\bmake\(socketUrlFor\(withClientAnnouncement\(currentUrl, announcement\)\)\)/);
    expect(game).toMatch(/const announcement = options\.announcement \?\? THIS_BUNDLE_ANNOUNCEMENT;/);
  });

  it("no production caller overrides the announcement or the socket factory (both are test seams)", () => {
    const callers = (pattern: RegExp) => entries.filter(([rel, text]) => rel !== "utils/roomLink.ts" && pattern.test(text)).map(([rel]) => rel);
    expect(callers(/\bsetRoomClientUpdate\s*\(/)).toEqual([]);
    expect(callers(/\bsetRoomSocketFactory\s*\(/)).toEqual([]);
    expect(SHELL).not.toMatch(/\bsetRoomClientUpdate\s*\(|\bsetRoomSocketFactory\s*\(/);
    /* The one game-link caller is the shell's; it names neither seam. */
    expect(callers(/\bconnectServerLink\s*\(/).filter((rel) => rel !== "utils/serverLink.ts")).toEqual([]);
    expect(SHELL.match(/\bconnectServerLink\s*\(/g)).toHaveLength(1);
    expect(SHELL).not.toMatch(/\bannouncement\s*[:,}]/);
    expect(SHELL).not.toMatch(/\bsocketFactory\s*:/);
  });
});

/* ================================================================================================= */
/* 2. By behaviour                                                                                    */
/* ================================================================================================= */

interface Fake {
  url: string;
  socket: SocketLike & RoomSocketLike;
  open(): void;
  deliver(frame: unknown): void;
  closeWith(code: number): void;
}

function fakeFactory(made: Fake[]) {
  return (url: string) => {
    const fake: Fake = {
      url,
      socket: {
        send: () => undefined,
        close: () => fake.socket.onclose?.({ code: 1000 }),
        onopen: null,
        onmessage: null,
        onclose: null,
        onerror: null,
      } as unknown as SocketLike & RoomSocketLike,
      open: () => fake.socket.onopen?.({} as never),
      deliver: (frame) => fake.socket.onmessage?.({ data: JSON.stringify(frame) } as never),
      closeWith: (code) => fake.socket.onclose?.({ code } as never),
    };
    made.push(fake);
    return fake.socket;
  };
}

describe("the socket inventory, by behaviour: every URL a link opens carries the announcement exactly once", () => {
  it("the game link: its open, the reconnect after an ordinary drop, and a routed re-attach", () => {
    const made: Fake[] = [];
    const scheduled: Array<() => void> = [];
    const link = connectServerLink({
      url: "wss://play.example/gs",
      gameId: GAME,
      build: "tab-build",
      onEntries: () => undefined,
      socketFactory: fakeFactory(made),
      schedule: (callback) => void scheduled.push(callback),
      clientUpdate: idlePort(),
      routeEnvironment: { pageOrigin: "https://play.example", bundleBase: "/" },
    });
    made[0].open();
    made[0].deliver({ kind: "catch-up", build: "server-build", digest: "0".repeat(16), entries: [], inFlight: [] });
    made[0].closeWith(1006);
    expect(scheduled).toHaveLength(1);
    scheduled[0]();
    made[1].open();
    made[1].deliver({ kind: "route", code: "client-rules", reason: "r", gameId: GAME, wsPath: "/gs/p/1" });
    expect(scheduled).toHaveLength(2);
    scheduled[1]();
    expect(made.map((fake) => new URL(fake.url).pathname)).toEqual(["/gs", "/gs", "/gs/p/1"]);
    for (const fake of made) expectThisBundle(fake.url);
    link.close();
  });

  describe("the room link", () => {
    let made: Fake[] = [];
    beforeEach(() => {
      jest.useFakeTimers();
      made = [];
      setRoomClientUpdate({ port: idlePort(), routeEnvironment: { pageOrigin: "https://play.example", bundleBase: "/" } });
      setRoomSocketFactory(fakeFactory(made));
    });
    afterEach(() => {
      resetRoomLinks();
      setRoomClientUpdate({ port: null, routeEnvironment: null });
      jest.useRealTimers();
    });

    it("the lobby's channel, a room's, its chat, an op with no game, and every reconnect after a drop", () => {
      watchPublicRooms(() => undefined);
      watchRoom(GAME, { onView: () => undefined });
      subscribeChat(GAME, () => undefined);
      void roomOp({ type: "my-tables" });
      const first = made.length;
      expect(first).toBeGreaterThanOrEqual(2);
      for (const fake of [...made]) {
        fake.open();
        fake.closeWith(1006);
      }
      jest.advanceTimersByTime(60_000);
      expect(made.length).toBeGreaterThan(first);
      for (const fake of made) expectThisBundle(fake.url);
      expect(new Set(made.map((fake) => new URL(fake.url).pathname))).toEqual(new Set(["/gs"]));
    });
  });
});

/* ================================================================================================= */
/* 3. The build is a diagnostic                                                                       */
/* ================================================================================================= */

describe("a bundle built with another build id", () => {
  it("announces the same cp and cr -- only cb differs -- and is given the same verdict", () => {
    let other = "";
    const saved = process.env.REACT_APP_BUILD_ID;
    process.env.REACT_APP_BUILD_ID = "cert-other-build";
    try {
      /* A fresh module registry with the real configuration: the bundle's constants are evaluated again, as a build
         with this environment would evaluate them. */
      jest.isolateModules(() => {
        jest.dontMock("../config");
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        other = (require("./clientAnnouncement") as typeof import("./clientAnnouncement")).THIS_BUNDLE_ANNOUNCEMENT;
      });
    } finally {
      if (saved === undefined) delete process.env.REACT_APP_BUILD_ID;
      else process.env.REACT_APP_BUILD_ID = saved;
    }
    const here = announcementOn(`wss://h/gs?${THIS_BUNDLE_ANNOUNCEMENT}`);
    const there = announcementOn(`wss://h/gs?${other}`);
    expect(there.cb).toEqual(["cert-other-build"]);
    expect([there.cp, there.cr]).toEqual([here.cp, here.cr]);
    const pool = deploymentCapability({
      format: DEPLOYMENT_CAPABILITY_FORMAT,
      rules: { current: RULES_ENGINE_VERSION, supported: SUPPORTED_RULES_ENGINE_VERSIONS, certified: SETTLEMENT_CERTIFIED_RULES_ENGINE_VERSIONS },
      hosted_protocols: [HOSTED_PROTOCOL_VERSION],
      financial_protocols: [],
      settlement_codecs: ["18JUNO/v1"],
      escrow_abi_checksums: ["5ecc302221a2dab4bb4f0f71b632f2beeafe9523ebd7b33bd0e94d017b8d09e8"],
      escrow_deployments: [],
      client_protocols: ACCEPTED_CLIENT_PROTOCOLS,
    });
    for (const pin of [null, RULES_ENGINE_VERSION]) {
      expect(clientVerdict(there.parsed, pool, pin)).toEqual(clientVerdict(here.parsed, pool, pin));
      expect(clientVerdict(there.parsed, pool, pin)).toEqual({ kind: "ok" });
    }
  });
});
