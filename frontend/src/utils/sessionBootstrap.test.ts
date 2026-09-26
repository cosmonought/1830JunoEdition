/** @jest-environment jsdom */
// frontend/src/utils/sessionBootstrap.test.ts
//
// LIVE-2B (LIVE-2 §4.3 "Client behavior"): the session is bootstrapped before any socket opens; three failed opens
// (or a 4401) bootstrap again before the next attempt; a `session-ended` answer stops the links and NEVER becomes a
// new guest on its own; only the explicit decision sends `{fresh: true}`; and nothing in the client reads the
// HttpOnly cookie.

import { connectServerLink, type SocketLike } from "./serverLink";
import { resetRoomDocLinks, sendFrame, setRoomDocSocketFactory } from "./roomDocLink";
import { httpSessionPort, installSessionPort, readySessionPort, sessionEndpointFor, sessionPort } from "./sessionBootstrap";

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

const flush = async () => {
  for (let n = 0; n < 10; n += 1) await Promise.resolve();
};

afterEach(() => {
  installSessionPort(null);
  resetRoomDocLinks();
});

describe("the hosted session bootstrap (LIVE-2B)", () => {
  it("posts to the game server's /gs/api/session -- same origin, JSON, no body but {} -- before any socket exists", async () => {
    const http = manualFetch();
    const session = httpSessionPort({ endpoint: "https://play.example/gs/api/session", fetch: http.fetch });
    const wire = sockets();
    const link = connectServerLink({
      url: "wss://play.example/gs",
      room: "ROOM",
      build: "b",
      claim: "p-alice",
      session,
      onEntries: () => undefined,
      socketFactory: wire.factory,
    });
    expect(wire.made).toHaveLength(0);
    expect(http.calls).toHaveLength(1);
    expect(http.calls[0].input).toBe("https://play.example/gs/api/session");
    expect(http.calls[0].init).toMatchObject({ method: "POST", credentials: "same-origin", cache: "no-store", body: "{}" });
    expect(http.calls[0].init.headers["Content-Type"]).toBe("application/json");
    await http.answer(201, { ok: true });
    expect(wire.made).toHaveLength(1);
    expect(wire.made[0].url).toBe("wss://play.example/gs"); // no dev claim outside a development-identity build
    link.close();
  });

  it("three failed opens bootstrap again before the next attempt, then the backoff resumes; a 4401 does at once", async () => {
    const http = manualFetch();
    const session = httpSessionPort({ endpoint: "https://play.example/gs/api/session", fetch: http.fetch });
    const wire = sockets();
    const later: Array<() => void> = [];
    const link = connectServerLink({
      url: "wss://play.example/gs",
      room: "ROOM",
      build: "b",
      claim: "p-alice",
      session,
      onEntries: () => undefined,
      socketFactory: wire.factory,
      schedule: (callback) => later.push(callback),
    });
    await http.answer(200, { ok: true });
    for (let n = 0; n < 3; n += 1) {
      expect(wire.made).toHaveLength(n + 1);
      wire.made[n].socket.onclose?.({ code: 1006 }); // refused at the upgrade: closed before it opened
      later.shift()?.();
      await flush();
    }
    expect(http.calls).toHaveLength(2); // the re-bootstrap, after the third failure
    expect(wire.made).toHaveLength(3);
    await http.answer(200, { ok: true, rotated: true });
    expect(wire.made).toHaveLength(4);
    wire.made[3].socket.onopen?.({});
    wire.made[3].socket.onclose?.({ code: 4401 });
    later.shift()?.();
    await flush();
    expect(http.calls).toHaveLength(3);
    link.close();
  });

  it("session-ended stops every link and is never turned into a new guest; only the explicit choice sends {fresh: true}", async () => {
    const http = manualFetch();
    const session = httpSessionPort({ endpoint: "https://play.example/gs/api/session", fetch: http.fetch });
    installSessionPort(session);
    const wire = sockets();
    const later: Array<() => void> = [];
    connectServerLink({
      url: "wss://play.example/gs",
      room: "ROOM",
      build: "b",
      claim: "p-alice",
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
    await http.answer(201, { ok: true });
    expect(await fresh).toBe("ready");
  });

  it("the room-document link waits for the session too", async () => {
    const http = manualFetch();
    installSessionPort(httpSessionPort({ endpoint: "https://play.example/gs/api/session", fetch: http.fetch }));
    const wire = sockets();
    setRoomDocSocketFactory(wire.factory as unknown as Parameters<typeof setRoomDocSocketFactory>[0]);
    sendFrame("JUNO-ABC", "p-alice", { kind: "lobby-hello" });
    expect(wire.made).toHaveLength(0);
    await http.answer(201, { ok: true });
    expect(wire.made).toHaveLength(1);
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
      await http.answer(201, { ok: true, expiresAt: 1 });
      expect(await pending).toBe("ready");
      const fresh = session.startFresh();
      await http.answer(201, { ok: true });
      expect(await fresh).toBe("ready");
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
  });
});
