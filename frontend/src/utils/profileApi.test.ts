/** @jest-environment jsdom */
// frontend/src/utils/profileApi.test.ts
//
// LIVE-2E: the profile routes, client side. Every call is a same-origin POST with a closed JSON body -- the
// bootstrap's own terms -- to one fixed path, so no recovery key or link code ever reaches a URL; each answer is one
// typed result (never a rejection); and every call that changes the session re-bootstraps before it resolves, so
// the port's `state` and `account` are the server's by then.

import {
  createLinkCode,
  createProfile,
  linkProfile,
  profileErrorSentence,
  profileNickname,
  recoverProfile,
  rotateRecoveryKey,
  signOutOtherDevices,
  signOutThisDevice,
  type ProfileFailure,
} from "./profileApi";
import { httpSessionPort, readySessionPort, type SessionPort } from "./sessionBootstrap";

interface Call {
  input: string;
  init: { method: string; credentials: string; cache: string; headers: Record<string, string>; body: string };
}

const ENDPOINT = "https://play.example/gs/api/session";
const KEY = "rk_0123456789abcdefghjkmnpqr0.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const CODE = "ABCD-EFGH-JKMN-PQRS-TVWX";

/** A server stand-in: the bootstrap answers with the current `profile`; each other path with what the test queued. */
function fakeServer(initialProfile: { name: string; otherSessions: number } | null = null) {
  const calls: Call[] = [];
  let profile = initialProfile;
  const answers = new Map<string, Array<{ status: number; body?: unknown; then?: () => void }>>();
  const fetch = async (input: string, init: Call["init"]) => {
    calls.push({ input, init });
    const path = new URL(input).pathname;
    if (path === "/gs/api/session") return { status: 200, json: async () => ({ ok: true, expiresAt: 1, profile }) };
    const queued = answers.get(path)?.shift();
    if (!queued) throw new Error(`nothing queued for ${path}`);
    queued.then?.();
    return {
      status: queued.status,
      json: async () => {
        if (queued.body === undefined) throw new SyntaxError("no body");
        return queued.body;
      },
    };
  };
  const port = httpSessionPort({ endpoint: ENDPOINT, fetch });
  return {
    port,
    calls,
    setProfile: (next: typeof profile) => {
      profile = next;
    },
    queue: (path: string, status: number, body?: unknown, then?: () => void) => {
      answers.set(path, [...(answers.get(path) ?? []), { status, body, then }]);
    },
    bootstraps: () => calls.filter((call) => new URL(call.input).pathname === "/gs/api/session").length,
  };
}

async function ready(server: ReturnType<typeof fakeServer>): Promise<SessionPort> {
  await server.port.ensure();
  return server.port;
}

describe("request shape (LIVE-2E)", () => {
  it("every call is a same-origin JSON POST with a closed body, to a fixed path that carries no credential", async () => {
    const server = fakeServer({ name: "Brad", otherSessions: 1 });
    await ready(server);
    server.queue("/gs/api/profile", 201, { ok: true, profile: { name: "Brad", otherSessions: 0 }, recoveryKey: KEY });
    server.queue("/gs/api/profile/recover", 200, { ok: true, profile: { name: "Brad" } });
    server.queue("/gs/api/profile/link", 200, { ok: true, profile: { name: "Brad" } });
    server.queue("/gs/api/profile/link-code", 201, { ok: true, code: CODE, expiresAt: 5 });
    server.queue("/gs/api/profile/recovery-key", 200, { ok: true, recoveryKey: KEY });
    server.queue("/gs/api/profile/sign-out-others", 200, { ok: true, signedOut: 1 });
    server.queue("/gs/api/session/revoke", 204);
    await createProfile("  Brad  ", server.port);
    await recoverProfile(`  ${KEY}\n`, server.port);
    await linkProfile("abcd efgh-jkmn pqrs-tvwx", server.port);
    await createLinkCode(server.port);
    await rotateRecoveryKey(server.port);
    await signOutOtherDevices(server.port);
    await signOutThisDevice(server.port);

    const bodies = new Map(
      server.calls.filter((call) => !call.input.endsWith("/gs/api/session")).map((call) => [new URL(call.input).pathname, JSON.parse(call.init.body)]),
    );
    expect(Object.fromEntries(bodies)).toEqual({
      "/gs/api/profile": { name: "Brad" },
      "/gs/api/profile/recover": { recoveryKey: KEY },
      "/gs/api/profile/link": { code: "ABCDEFGHJKMNPQRSTVWX" },
      "/gs/api/profile/link-code": {},
      "/gs/api/profile/recovery-key": {},
      "/gs/api/profile/sign-out-others": {},
      "/gs/api/session/revoke": {},
    });
    for (const call of server.calls) {
      const url = new URL(call.input);
      expect(url.origin).toBe("https://play.example");
      expect(url.search).toBe("");
      expect(url.hash).toBe("");
      expect(call.input).not.toContain(KEY);
      expect(call.input).not.toMatch(/ABCD|rk_/);
      expect(call.init).toMatchObject({ method: "POST", credentials: "same-origin", cache: "no-store" });
      expect(call.init.headers).toEqual({ "Content-Type": "application/json" });
    }
  });

  it("a development (always-ready) port has no HTTP surface: every action is 'unavailable', and nothing is fetched", async () => {
    const fetchSpy = jest.fn();
    const original = window.fetch;
    (window as unknown as { fetch: unknown }).fetch = fetchSpy;
    try {
      const port = readySessionPort();
      for (const result of [
        await createProfile("Brad", port),
        await recoverProfile(KEY, port),
        await linkProfile(CODE, port),
        await createLinkCode(port),
        await rotateRecoveryKey(port),
        await signOutThisDevice(port),
        await signOutOtherDevices(port),
      ]) {
        expect(result).toEqual({ ok: false, error: "unavailable" });
      }
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      (window as unknown as { fetch: unknown }).fetch = original;
    }
  });

  it("an empty or impossible entry is refused without spending an attempt", async () => {
    const server = fakeServer(null);
    await ready(server);
    const before = server.calls.length;
    expect(await createProfile("   ", server.port)).toEqual({ ok: false, error: "bad-name" });
    expect(await createProfile("x".repeat(25), server.port)).toEqual({ ok: false, error: "bad-name" });
    expect(await recoverProfile("  \n ", server.port)).toEqual({ ok: false, error: "invalid-credential" });
    expect(await linkProfile(" - - ", server.port)).toEqual({ ok: false, error: "invalid-credential" });
    expect(server.calls.length).toBe(before);
  });
});

describe("results and the re-bootstrap (LIVE-2E)", () => {
  it("create: the recovery key once, and the port is 'ready' as the new profile before the call resolves", async () => {
    const server = fakeServer(null);
    await ready(server);
    expect(server.port.state).toBe("unprofiled");
    server.queue("/gs/api/profile", 201, { ok: true, profile: { name: "Brad", otherSessions: 0 }, recoveryKey: KEY }, () =>
      server.setProfile({ name: "Brad", otherSessions: 0 }),
    );
    const result = await createProfile("Brad", server.port);
    expect(result).toEqual({ ok: true, name: "Brad", recoveryKey: KEY });
    expect(server.port.state).toBe("ready");
    expect(server.port.account).toEqual({ name: "Brad", otherSessions: 0 });
    expect(server.bootstraps()).toBe(2);
  });

  it("create answering already-profiled (a lost response) re-bootstraps, and says which profile", async () => {
    const server = fakeServer(null);
    await ready(server);
    server.setProfile({ name: "Brad", otherSessions: 0 });
    server.queue("/gs/api/profile", 409, { error: "already-profiled", profile: { name: "Brad" } });
    expect(await createProfile("Brad", server.port)).toEqual({ ok: false, error: "already-profiled", name: "Brad" });
    expect(server.port.state).toBe("ready");
    expect(server.bootstraps()).toBe(2);
  });

  it("create: bad-name, rate-limited and unavailable map to their own results", async () => {
    const server = fakeServer(null);
    await ready(server);
    server.queue("/gs/api/profile", 400, { error: "bad-name" });
    server.queue("/gs/api/profile", 429, { error: "rate-limited", retryAfterMs: 12_300 });
    server.queue("/gs/api/profile", 503, { error: "unavailable" });
    expect(await createProfile("Brad", server.port)).toEqual({ ok: false, error: "bad-name" });
    const limited = await createProfile("Brad", server.port);
    expect(limited).toEqual({ ok: false, error: "rate-limited", retryAfterMs: 12_300 });
    expect(profileErrorSentence(limited as never)).toBe("Too many attempts. Wait 13 seconds and try again.");
    expect(await createProfile("Brad", server.port)).toEqual({ ok: false, error: "unavailable" });
    expect(server.bootstraps()).toBe(1); // nothing about the session changed
  });

  it("recover and link: success re-bootstraps into the profile; a wrong credential is one answer", async () => {
    for (const [path, act] of [
      ["/gs/api/profile/recover", (port: SessionPort) => recoverProfile(KEY, port)],
      ["/gs/api/profile/link", (port: SessionPort) => linkProfile(CODE, port)],
    ] as const) {
      const server = fakeServer(null);
      await ready(server);
      server.queue(path, 403, { error: "invalid-credential" });
      const wrong = await act(server.port);
      expect(wrong).toEqual({ ok: false, error: "invalid-credential" });
      expect(profileErrorSentence(wrong as never, "credential")).toBe(
        "That key or code doesn't work. Check it and try again — a device-link code works once, for 10 minutes.",
      );
      expect(server.port.state).toBe("unprofiled");
      server.queue(path, 200, { ok: true, profile: { name: "Brad" } }, () => server.setProfile({ name: "Brad", otherSessions: 1 }));
      expect(await act(server.port)).toEqual({ ok: true, name: "Brad" });
      expect(server.port.state).toBe("ready");
      expect(server.port.account).toEqual({ name: "Brad", otherSessions: 1 });
      expect(server.bootstraps()).toBe(2);
    }
  });

  it("recover: already-profiled, not-authenticated, rate-limited and a network failure", async () => {
    const server = fakeServer(null);
    await ready(server);
    server.queue("/gs/api/profile/recover", 429, { error: "rate-limited", retryAfterMs: 1_000 });
    expect(await recoverProfile(KEY, server.port)).toEqual({ ok: false, error: "rate-limited", retryAfterMs: 1_000 });
    server.queue("/gs/api/profile/recover", 401, { error: "not-authenticated" });
    expect(await recoverProfile(KEY, server.port)).toEqual({ ok: false, error: "not-authenticated" });
    expect(server.bootstraps()).toBe(2); // a stale picture of the session is refreshed
    server.setProfile({ name: "Brad", otherSessions: 0 });
    server.queue("/gs/api/profile/recover", 409, { error: "already-profiled" });
    expect(await recoverProfile(KEY, server.port)).toEqual({ ok: false, error: "already-profiled" });
    expect(server.port.state).toBe("ready");
    const offline = httpSessionPort({
      endpoint: ENDPOINT,
      fetch: () => Promise.reject(new TypeError("Failed to fetch")),
    });
    expect(await recoverProfile(KEY, offline)).toEqual({ ok: false, error: "network" });
  });

  it("LIVE-2E review M2: a browser holding pre-profile tables is told to create its own profile (has-tables)", async () => {
    const server = fakeServer(null);
    await ready(server);
    server.queue("/gs/api/profile/recover", 409, { error: "has-tables" });
    const refused = await recoverProfile(KEY, server.port);
    expect(refused).toEqual({ ok: false, error: "has-tables" });
    expect(profileErrorSentence(refused as ProfileFailure, "credential")).toMatch(/Create profile/);
    expect(server.port.state).toBe("unprofiled");
  });

  it("link code, key rotation and sign-outs: their results, and which of them re-bootstrap", async () => {
    const server = fakeServer({ name: "Brad", otherSessions: 2 });
    await ready(server);
    server.queue("/gs/api/profile/link-code", 201, { ok: true, code: CODE, expiresAt: 600_000 });
    expect(await createLinkCode(server.port)).toEqual({ ok: true, code: CODE, expiresAt: 600_000 });
    server.queue("/gs/api/profile/recovery-key", 200, { ok: true, recoveryKey: KEY });
    expect(await rotateRecoveryKey(server.port)).toEqual({ ok: true, recoveryKey: KEY });
    expect(server.bootstraps()).toBe(1);
    server.queue("/gs/api/profile/sign-out-others", 200, { ok: true, signedOut: 2 }, () => server.setProfile({ name: "Brad", otherSessions: 0 }));
    expect(await signOutOtherDevices(server.port)).toEqual({ ok: true, signedOut: 2 });
    expect(server.bootstraps()).toBe(2);
    expect(server.port.account?.otherSessions).toBe(0);
    server.queue("/gs/api/profile/link-code", 403, { error: "profile-required" });
    expect(await createLinkCode(server.port)).toEqual({ ok: false, error: "profile-required" });
    server.queue("/gs/api/session/revoke", 204);
    expect(await signOutThisDevice(server.port)).toEqual({ ok: true });
  });
});

describe("the nickname a create sends (LIVE-2E)", () => {
  it("is the player's choice, else the profile's name; a development build leaves it to the server", async () => {
    const server = fakeServer({ name: "Brad", otherSessions: 0 });
    await ready(server);
    expect(profileNickname("  Ann ", server.port)).toBe("Ann");
    expect(profileNickname("", server.port)).toBe("Brad");
    expect(profileNickname(undefined, server.port)).toBe("Brad");
    expect(profileNickname(undefined, readySessionPort())).toBe("");
  });
});

describe("nothing is kept or said (LIVE-2E)", () => {
  it("no call writes storage or the console, whatever it carries", async () => {
    const writes = [jest.spyOn(Storage.prototype, "setItem")];
    const said = (["log", "info", "warn", "error", "debug"] as const).map((level) => jest.spyOn(console, level).mockImplementation(() => undefined));
    try {
      const server = fakeServer(null);
      await ready(server);
      server.queue("/gs/api/profile", 201, { ok: true, profile: { name: "Brad", otherSessions: 0 }, recoveryKey: KEY }, () =>
        server.setProfile({ name: "Brad", otherSessions: 0 }),
      );
      server.queue("/gs/api/profile/link-code", 201, { ok: true, code: CODE, expiresAt: 1 });
      server.queue("/gs/api/profile/recovery-key", 200, { ok: true, recoveryKey: KEY });
      await createProfile("Brad", server.port);
      await createLinkCode(server.port);
      await rotateRecoveryKey(server.port);
      for (const spy of writes) expect(spy).not.toHaveBeenCalled();
      for (const spy of said) expect(spy).not.toHaveBeenCalled();
      expect(JSON.stringify(server.port)).not.toContain(KEY);
    } finally {
      for (const spy of [...writes, ...said]) spy.mockRestore();
    }
  });
});
