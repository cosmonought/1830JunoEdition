/** @jest-environment jsdom */
// frontend/src/utils/sessionBootstrap.test.ts
//
// LIVE-2B (LIVE-2 §4.3 "Client behavior"): the session is bootstrapped before any socket opens; three failed opens
// (or a 4401) bootstrap again before the next attempt; a `session-ended` answer stops the links and NEVER becomes a
// new session on its own; only the explicit decision sends `{fresh: true}`; and nothing in the client reads the
// HttpOnly cookie.
//
// LIVE-2E: PROFILES ARE MANDATORY. "ready" is a PROFILED session; a bootstrap that answers `profile: null` is
// "unprofiled", which opens no socket anywhere; `account` follows every bootstrap answer, by name only.

import { withClientAnnouncement } from "./clientAnnouncement";
import { connectServerLink, type SocketLike } from "./serverLink";
import { resetRoomLinks, setRoomSocketFactory, watchRoom, type SocketLike as RoomSocketLike } from "./roomLink";
import { httpSessionPort, installSessionPort, readySessionPort, sessionEndedSentence, sessionEndpointFor, sessionPort } from "./sessionBootstrap";
import { readStripped } from "./sourceScan";

/** LIVE-2E: a bootstrap answer for a PROFILED browser -- the only kind a socket opens for. */
const PROFILED = { ok: true, expiresAt: 1, profile: { name: "Brad", otherSessions: 0 } };

interface Call {
  input: string;
  init: { method: string; credentials: string; cache: string; headers: Record<string, string>; body: string };
}

/** A fetch the test answers by hand, one response per call. */
function manualFetch() {
  const calls: Call[] = [];
  const waiting: Array<(response: { status: number; body?: unknown }) => void> = [];
  const fetch = (input: string, init: Call["init"]) =>
    new Promise<{ status: number; json(): Promise<unknown> }>((resolve) => {
      calls.push({ input, init });
      waiting.push((response) => resolve({ status: response.status, json: async () => response.body ?? {} }));
    });
  const answer = async (status: number, body?: unknown) => {
    const next = waiting.shift();
    if (!next) throw new Error("no request is waiting");
    next({ status, body });
    for (let n = 0; n < 5; n += 1) await Promise.resolve();
  };
  return { fetch, calls, answer };
}

function sockets() {
  const made: Array<{ url: string; socket: SocketLike }> = [];
  const factory = (url: string): SocketLike => {
    const socket: SocketLike = { send: () => undefined, close: () => socket.onclose?.({ code: 1000 }), onopen: null, onmessage: null, onclose: null, onerror: null };
    made.push({ url, socket });
    return socket;
  };
  return { made, factory };
}

/** A server-minted game id: LIVE-2D keys every link by one, and names no player in any frame. */
const GAME = "g_0123456789abcdefghjkmnpqr0";

const flush = async () => {
  for (let n = 0; n < 10; n += 1) await Promise.resolve();
};

afterEach(() => {
  installSessionPort(null);
  resetRoomLinks();
});

describe("the hosted session bootstrap (LIVE-2B)", () => {
  it("posts to the game server's /gs/api/session -- same origin, JSON, no body but {} -- before any socket exists", async () => {
    const http = manualFetch();
    const session = httpSessionPort({ endpoint: "https://play.example/gs/api/session", fetch: http.fetch });
    const wire = sockets();
    const link = connectServerLink({
      url: "wss://play.example/gs",
      gameId: GAME,
      build: "b",
      session,
      onEntries: () => undefined,
      socketFactory: wire.factory,
    });
    expect(wire.made).toHaveLength(0);
    expect(http.calls).toHaveLength(1);
    expect(http.calls[0].input).toBe("https://play.example/gs/api/session");
    expect(http.calls[0].init).toMatchObject({ method: "POST", credentials: "same-origin", cache: "no-store", body: "{}" });
    expect(http.calls[0].init.headers["Content-Type"]).toBe("application/json");
    await http.answer(200, PROFILED);
    expect(wire.made).toHaveLength(1);
    /* No dev claim outside a development-identity build. LIVE-4 (L4-3): the one thing on the query is this bundle's
       announcement (`cp` / `cr` / `cb`). */
    expect(wire.made[0].url).toBe(withClientAnnouncement("wss://play.example/gs"));
    expect(wire.made[0].url).not.toContain("dev_claim");
    link.close();
  });

  it("three failed opens bootstrap again before the next attempt, then the backoff resumes; a 4401 does at once", async () => {
    const http = manualFetch();
    const session = httpSessionPort({ endpoint: "https://play.example/gs/api/session", fetch: http.fetch });
    const wire = sockets();
    const later: Array<() => void> = [];
    const link = connectServerLink({
      url: "wss://play.example/gs",
      gameId: GAME,
      build: "b",
      session,
      onEntries: () => undefined,
      socketFactory: wire.factory,
      schedule: (callback) => later.push(callback),
    });
    await http.answer(200, PROFILED);
    for (let n = 0; n < 3; n += 1) {
      expect(wire.made).toHaveLength(n + 1);
      wire.made[n].socket.onclose?.({ code: 1006 }); // refused at the upgrade: closed before it opened
      later.shift()?.();
      await flush();
    }
    expect(http.calls).toHaveLength(2); // the re-bootstrap, after the third failure
    expect(wire.made).toHaveLength(3);
    await http.answer(200, { ...PROFILED, rotated: true });
    expect(wire.made).toHaveLength(4);
    wire.made[3].socket.onopen?.({});
    wire.made[3].socket.onclose?.({ code: 4401 });
    later.shift()?.();
    await flush();
    expect(http.calls).toHaveLength(3);
    link.close();
  });

  it("session-ended stops every link and is never turned into a new session; only the explicit choice sends {fresh: true}", async () => {
    const http = manualFetch();
    const session = httpSessionPort({ endpoint: "https://play.example/gs/api/session", fetch: http.fetch });
    installSessionPort(session);
    const wire = sockets();
    const later: Array<() => void> = [];
    connectServerLink({
      url: "wss://play.example/gs",
      gameId: GAME,
      build: "b",
      onEntries: () => undefined,
      socketFactory: wire.factory,
      schedule: (callback) => later.push(callback),
    });
    await http.answer(401, { error: "session-ended", reason: "expired" });
    expect(session.state).toBe("ended");
    expect(session.endedReason).toBe("expired");
    expect(wire.made).toHaveLength(0);
    while (later.length > 0) later.shift()?.();
    await flush();
    expect(await session.ensure(true)).toBe("ended");
    expect(http.calls).toHaveLength(1);
    expect(http.calls.every((call) => !call.init.body.includes("fresh"))).toBe(true);
    const fresh = session.startFresh();
    expect(http.calls[1].init.body).toBe('{"fresh":true}');
    /* LIVE-2E: a fresh session is a temporary, UNPROFILED one -- the profile gate, never a new player. */
    await http.answer(201, { ok: true, expiresAt: 1, profile: null });
    expect(await fresh).toBe("unprofiled");
    expect(session.account).toBeNull();
    expect(wire.made).toHaveLength(0);
  });

  it("the room link waits for the session too (LIVE-2D: `roomLink`, keyed by game id)", async () => {
    const http = manualFetch();
    installSessionPort(httpSessionPort({ endpoint: "https://play.example/gs/api/session", fetch: http.fetch }));
    const wire = sockets();
    setRoomSocketFactory(wire.factory as unknown as (url: string) => RoomSocketLike);
    const stop = watchRoom(GAME, { onView: () => undefined });
    expect(wire.made).toHaveLength(0);
    await http.answer(200, PROFILED);
    expect(wire.made).toHaveLength(1);
    stop();
  });

  it("the page never reads the cookie: it is HttpOnly and the browser's alone", async () => {
    let reads = 0;
    const descriptor = Object.getOwnPropertyDescriptor(Document.prototype, "cookie");
    Object.defineProperty(document, "cookie", {
      configurable: true,
      get: () => {
        reads += 1;
        return "";
      },
      set: () => undefined,
    });
    try {
      const http = manualFetch();
      const session = httpSessionPort({ endpoint: "https://play.example/gs/api/session", fetch: http.fetch });
      const pending = session.ensure();
      await http.answer(201, { ok: true, expiresAt: 1, profile: null });
      expect(await pending).toBe("unprofiled");
      const again = session.ensure(true);
      await http.answer(200, PROFILED);
      expect(await again).toBe("ready");
      const fresh = session.startFresh();
      await http.answer(201, { ok: true, profile: null });
      expect(await fresh).toBe("unprofiled");
      expect(reads).toBe(0);
      expect(JSON.stringify(session)).not.toMatch(/gs_session|v1\./);
    } finally {
      delete (document as unknown as { cookie?: unknown }).cookie;
      if (descriptor) Object.defineProperty(Document.prototype, "cookie", descriptor);
    }
  });

  it("the endpoint is the game server's origin; tests and dev builds get the always-ready port", () => {
    expect(sessionEndpointFor("wss://play.example/gs")).toBe("https://play.example/gs/api/session");
    expect(sessionEndpointFor("wss://play.example/gs/")).toBe("https://play.example/gs/api/session");
    expect(sessionEndpointFor("ws://127.0.0.1:8917")).toBe("http://127.0.0.1:8917/gs/api/session");
    expect(sessionEndpointFor("https://play.example")).toBeNull();
    expect(sessionPort().state).toBe("ready");
    expect(readySessionPort().refreshable).toBe(false);
    /* LIVE-2E: the always-ready port stands in a development profile, with no credentials behind it. */
    expect(readySessionPort().account).toEqual({ name: "Development", otherSessions: 0, development: true });
  });
});

describe("public first (P3-ACCT; LIVE-2E's mandatory profiles superseded)", () => {
  it("a signed-out browser is 'unprofiled': its sockets open (the public, read-only surface) without asking the server again", async () => {
    const http = manualFetch();
    const session = httpSessionPort({ endpoint: "https://play.example/gs/api/session", fetch: http.fetch });
    installSessionPort(session);
    const wire = sockets();
    const later: Array<() => void> = [];
    const link = connectServerLink({
      url: "wss://play.example/gs",
      gameId: GAME,
      build: "b",
      onEntries: () => undefined,
      socketFactory: wire.factory,
      schedule: (callback) => later.push(callback),
    });
    setRoomSocketFactory(wire.factory as unknown as (url: string) => RoomSocketLike);
    const stop = watchRoom(GAME, { onView: () => undefined });
    await http.answer(201, { ok: true, expiresAt: 1, profile: null });
    await flush();
    expect(session.state).toBe("unprofiled");
    expect(session.account).toBeNull();
    expect(await session.ensure()).toBe("unprofiled");
    for (let n = 0; n < 3; n += 1) {
      later.shift()?.();
      await flush();
    }
    /* P3-ACCT: a visitor's sockets open at once (the server answers them the public list, a public table's view and
       log, and `profile-required` to everything else). */
    expect(wire.made.length).toBeGreaterThanOrEqual(1);
    expect(http.calls).toHaveLength(1); // the first answer stands until a sign-in forces the next bootstrap
    /* A sign-in: the forced bootstrap says so. */
    const forced = session.ensure(true);
    await http.answer(200, { ok: true, expiresAt: 1, profile: { name: "Brad", otherSessions: 2 } });
    expect(await forced).toBe("ready");
    expect(session.account).toEqual({ name: "Brad", otherSessions: 2 });
    link.close();
    stop();
  });

  it("the account follows every bootstrap answer, by name and count only", async () => {
    const http = manualFetch();
    const session = httpSessionPort({ endpoint: "https://play.example/gs/api/session", fetch: http.fetch });
    let notified = 0;
    session.subscribe(() => (notified += 1));
    const first = session.ensure();
    await http.answer(200, { ok: true, expiresAt: 1, profile: { name: "Brad", otherSessions: 1 } });
    expect(await first).toBe("ready");
    expect(session.account).toEqual({ name: "Brad", otherSessions: 1 });
    const second = session.ensure(true);
    await http.answer(200, { ok: true, expiresAt: 1, profile: { name: "Brad", otherSessions: 0 } });
    expect(await second).toBe("ready");
    expect(session.account).toEqual({ name: "Brad", otherSessions: 0 });
    expect(notified).toBe(2);
    /* PHASE 3 FINAL: the account's username rides along (told only to its own session) -- an open table compares it to
       notice another tab changed this browser's account; anything but a short string is left out, never guessed. */
    const named = session.ensure(true);
    await http.answer(200, { ok: true, expiresAt: 1, profile: { name: "Brad", otherSessions: 0, username: "Brad.Player" } });
    expect(await named).toBe("ready");
    expect(session.account).toEqual({ name: "Brad", otherSessions: 0, username: "Brad.Player" });
    for (const username of [7, null, "u".repeat(257)]) {
      const odd = session.ensure(true);
      await http.answer(200, { ok: true, expiresAt: 1, profile: { name: "Brad", otherSessions: 0, username } });
      expect(await odd).toBe("ready");
      expect(session.account).toEqual({ name: "Brad", otherSessions: 0 });
    }
    /* A malformed profile is no profile: the gate, never a guessed one. */
    const third = session.ensure(true);
    await http.answer(200, { ok: true, profile: { name: 7 } });
    expect(await third).toBe("unprofiled");
    expect(session.account).toBeNull();
    /* An ended session names no account. */
    const fourth = session.ensure(true);
    await http.answer(401, { error: "session-ended", reason: "signed-out-remotely" });
    expect(await fourth).toBe("ended");
    expect(session.account).toBeNull();
    expect(session.endedReason).toBe("signed-out-remotely");
  });

  it("a 200 whose body cannot be read is not an answer about the profile: the caller retries", async () => {
    const calls: string[] = [];
    const session = httpSessionPort({
      endpoint: "https://play.example/gs/api/session",
      fetch: async (input) => {
        calls.push(input);
        return { status: 200, json: async () => Promise.reject(new SyntaxError("not json")) };
      },
    });
    expect(await session.ensure()).toBe("unknown");
    expect(session.state).toBe("unknown");
    expect(await session.ensure()).toBe("unknown");
    expect(calls).toHaveLength(2);
  });

  it("a forced bootstrap never joins a request that was already on the wire: it follows it", async () => {
    const http = manualFetch();
    const session = httpSessionPort({ endpoint: "https://play.example/gs/api/session", fetch: http.fetch });
    const early = session.ensure();
    const forcedA = session.ensure(true);
    const forcedB = session.ensure(true);
    expect(http.calls).toHaveLength(1);
    await http.answer(201, { ok: true, profile: null }); // the answer from before the profile existed
    expect(await early).toBe("unprofiled");
    await flush();
    expect(http.calls).toHaveLength(2); // one follow-up, shared by both forced callers
    await http.answer(200, PROFILED);
    expect(await forcedA).toBe("ready");
    expect(await forcedB).toBe("ready");
    expect(session.account?.name).toBe("Brad");
  });

  it("names the LIVE-2E reasons a session ends", () => {
    expect(sessionEndedSentence("replaced")).toBe("This browser signed in to an account, which replaced its earlier session.");
    expect(sessionEndedSentence("signed-out-remotely")).toBe("It was signed out from another of your devices.");
    /* PHASE 3 FINAL: an account made before Authorization Wallets is retired -- its sessions end `retired`. */
    expect(sessionEndedSentence("retired")).toBe("It belonged to an account made before Authorization Wallets. That account is retired: create a new account to keep playing.");
    for (const reason of ["expired", "logout", "evicted", "operator", "principal-disabled", "rotated", "unreadable", "replaced", "signed-out-remotely", "retired", null]) {
      expect(sessionEndedSentence(reason)).not.toMatch(/guest|recovery key/i);
    }
  });

  it("PHASE 3 FINAL: the closed list of account routes names the Authorization-Wallet account's routes, and none of the retired ones", () => {
    const code = readStripped("utils/sessionBootstrap.ts");
    for (const path of ["account/authorization", "account/recover", "account/authorization-wallet/challenge", "account/authorization-wallet/replace", "account/create", "account/login", "account/password", "account/me", "profile/reauth", "profile/sign-out-others"]) {
      expect([path, code.includes(`| "${path}"`)]).toEqual([path, true]);
    }
    for (const path of ["profile", "profile/recover", "profile/link", "profile/link-code", "profile/recovery-key", "profile/key-received", "account/credentials", "account/forget-wallet", "account/reset"]) {
      expect([path, code.includes(`"${path}"`)]).toEqual([path, false]);
    }
  });
});
