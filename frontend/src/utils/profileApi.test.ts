/** @jest-environment jsdom */
// frontend/src/utils/profileApi.test.ts
//
// LIVE-2E / PHASE 3 FINAL: the account routes, client side. Every call is a same-origin POST with a closed JSON body --
// the bootstrap's own terms -- to one fixed path, so no password, signature or operation ever reaches a URL; each
// answer is one typed result (never a rejection); and every call that changes the session re-bootstraps before it
// resolves, so the port's `state` and `account` are the server's by then.
//
// PHASE 3 FINAL (owner ruling 2026-10-06): the profile-era routes are gone from the client -- `createProfile`,
// `recoverProfile`, `linkProfile`, `createLinkCode`, `rotateRecoveryKey`, `reauthenticate(recoveryKey)` and the creation
// receipt (`mintCreationReceipt`). What replaced each is pinned here instead: `mintAuthorization` + `createAccount` (the
// Authorization Wallet's CREATE signature), `recoverAccount` ("Forgot password?" by the Authorization Wallet),
// `changePassword` (the current password), `replacementChallenge` + `replaceAuthorizationWallet`, and
// `reauthenticateWithPassword` ("Confirm it's you" by the password).

import {
  accountDetails,
  changePassword,
  createAccount,
  logIn,
  mintAuthorization,
  profileErrorSentence,
  profileNickname,
  reauthenticateWithPassword,
  recoverAccount,
  replaceAuthorizationWallet,
  replacementChallenge,
  signOutOtherDevices,
  signOutThisDevice,
  type ProfileErrorCode,
  type ProfileFailure,
} from "./profileApi";
import { httpSessionPort, readySessionPort, type SessionPort } from "./sessionBootstrap";

interface Call {
  input: string;
  init: { method: string; credentials: string; cache: string; headers: Record<string, string>; body: string };
}

const ENDPOINT = "https://play.example/gs/api/session";
const OPERATION = "0123456789abcdef0123456789abcdef";
const WALLET = "juno12gdmst084pz888ds7g80nv27p9wadknwdl783a";
const NEW_WALLET = "juno1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqnrql8a";
const SIGNED = { pubKey: "Ai1R5vzeZFvF73ROli+IbV7OuNG7bM6HeI0rthBGJzvf", signature: "c2lnbmF0dXJl" };
const PASSWORD = " a long password ";
const NEW_PASSWORD = "a brand new passphrase";

/** One server-minted authorization answer (the texts' content is `profileAuthorizationV1.test`-style business; the
 *  client only reads the shape here). */
const minted = (texts: Array<{ purpose: string; signer: string; text: string }>, operation = OPERATION) => ({ ok: true, operation, texts, expiresAt: 600_000 });
const CREATE_TEXTS = [{ purpose: "CREATE", signer: WALLET, text: "the CREATE text" }];
const REPLACE_TEXTS = [
  { purpose: "REPLACE-APPROVE", signer: WALLET, text: "the APPROVE text" },
  { purpose: "REPLACE-ACCEPT", signer: NEW_WALLET, text: "the ACCEPT text" },
];
const ME = { ok: true, account: { name: "Brad", username: "Brad.Player", authorizationWallet: { address: WALLET, since: 5 }, memberSince: 4, otherSessions: 1 } };

/** A server stand-in: the bootstrap answers with the current `profile`; each other path with what the test queued. */
function fakeServer(initialProfile: { name: string; otherSessions: number; username?: string } | null = null) {
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
    posted: () => calls.filter((call) => !call.input.endsWith("/gs/api/session")).map((call) => [new URL(call.input).pathname, JSON.parse(call.init.body)] as const),
  };
}

async function ready(server: ReturnType<typeof fakeServer>): Promise<SessionPort> {
  await server.port.ensure();
  return server.port;
}

const create = (port: SessionPort, over: Partial<Parameters<typeof createAccount>[0]> = {}) =>
  createAccount({ username: " Brad.Player ", password: PASSWORD, name: "  Brad ", operation: OPERATION, signed: SIGNED, ...over }, port);

describe("request shape (LIVE-2E, PHASE 3 FINAL)", () => {
  it("every call is a same-origin JSON POST with a closed body, to a fixed path that carries no credential", async () => {
    const server = fakeServer({ name: "Brad", otherSessions: 1 });
    await ready(server);
    server.queue("/gs/api/account/authorization", 200, minted(CREATE_TEXTS));
    server.queue("/gs/api/account/create", 201, { ok: true, profile: { name: "Brad", otherSessions: 0 }, username: "Brad.Player" });
    server.queue("/gs/api/account/login", 200, { ok: true, profile: { name: "Brad" } });
    server.queue("/gs/api/account/recover", 200, { ok: true, profile: { name: "Brad" }, signedOut: 1 });
    server.queue("/gs/api/account/password", 200, { ok: true, signedOut: 1 });
    server.queue("/gs/api/account/authorization-wallet/challenge", 200, minted(REPLACE_TEXTS));
    server.queue("/gs/api/account/authorization-wallet/replace", 200, { ok: true, authorizationWallet: { address: NEW_WALLET, since: 9 } });
    server.queue("/gs/api/account/me", 200, ME);
    server.queue("/gs/api/profile/reauth", 200, { ok: true, expiresAt: 5 });
    server.queue("/gs/api/profile/sign-out-others", 200, { ok: true, signedOut: 1 });
    server.queue("/gs/api/session/revoke", 204);
    await mintAuthorization({ purpose: "create", username: "  Brad.Player ", wallet: WALLET }, server.port);
    await create(server.port);
    await logIn({ username: " Brad.Player ", password: PASSWORD }, server.port);
    await recoverAccount({ operation: OPERATION, signed: SIGNED, newPassword: NEW_PASSWORD }, server.port);
    await changePassword({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD }, server.port);
    await replacementChallenge(NEW_WALLET, server.port);
    await replaceAuthorizationWallet({ operation: OPERATION, approve: { pubKey: "approve-key", signature: "approve-sig" }, accept: { pubKey: "accept-key", signature: "accept-sig" } }, server.port);
    await accountDetails(server.port);
    await reauthenticateWithPassword(PASSWORD, server.port);
    await signOutOtherDevices(server.port);
    await signOutThisDevice(server.port);

    /* The username is trimmed; a password never is (spaces are part of it). */
    expect(Object.fromEntries(server.posted())).toEqual({
      "/gs/api/account/authorization": { purpose: "create", username: "Brad.Player", wallet: WALLET },
      "/gs/api/account/create": { username: "Brad.Player", password: PASSWORD, name: "Brad", operation: OPERATION, pubKey: SIGNED.pubKey, signature: SIGNED.signature },
      "/gs/api/account/login": { username: "Brad.Player", password: PASSWORD },
      "/gs/api/account/recover": { operation: OPERATION, pubKey: SIGNED.pubKey, signature: SIGNED.signature, newPassword: NEW_PASSWORD },
      "/gs/api/account/password": { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
      "/gs/api/account/authorization-wallet/challenge": { newWallet: NEW_WALLET },
      "/gs/api/account/authorization-wallet/replace": { operation: OPERATION, approvePubKey: "approve-key", approveSignature: "approve-sig", acceptPubKey: "accept-key", acceptSignature: "accept-sig" },
      "/gs/api/account/me": {},
      "/gs/api/profile/reauth": { password: PASSWORD },
      "/gs/api/profile/sign-out-others": {},
      "/gs/api/session/revoke": {},
    });
    expect(server.posted()).toHaveLength(11);
    for (const call of server.calls) {
      const url = new URL(call.input);
      expect(url.origin).toBe("https://play.example");
      expect(url.search).toBe("");
      expect(url.hash).toBe("");
      for (const secret of [PASSWORD.trim(), NEW_PASSWORD, SIGNED.signature, OPERATION, "approve-sig", "accept-sig"]) expect(call.input).not.toContain(secret);
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
        await mintAuthorization({ purpose: "create", username: "Brad", wallet: WALLET }, port),
        await create(port),
        await logIn({ username: "Brad", password: PASSWORD }, port),
        await recoverAccount({ operation: OPERATION, signed: SIGNED, newPassword: NEW_PASSWORD }, port),
        await changePassword({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD }, port),
        await replacementChallenge(NEW_WALLET, port),
        await replaceAuthorizationWallet({ operation: OPERATION, approve: SIGNED, accept: SIGNED }, port),
        await accountDetails(port),
        await reauthenticateWithPassword(PASSWORD, port),
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
    expect(await create(server.port, { name: "   " })).toEqual({ ok: false, error: "bad-name" });
    expect(await create(server.port, { name: "x".repeat(25) })).toEqual({ ok: false, error: "bad-name" });
    expect(await create(server.port, { username: "two words" })).toEqual({ ok: false, error: "bad-username" });
    expect(await create(server.port, { username: "  " })).toEqual({ ok: false, error: "bad-username" });
    expect(await create(server.port, { username: "u".repeat(65) })).toEqual({ ok: false, error: "bad-username" });
    /* Twelve characters are the floor (the owner's ruling); counted in code points, as the server counts them. */
    expect(await create(server.port, { password: "elevenchars" })).toEqual({ ok: false, error: "bad-password", problem: "too-short" });
    expect(await create(server.port, { password: "\u{1F600}".repeat(11) })).toEqual({ ok: false, error: "bad-password", problem: "too-short" });
    /* CREATE says "bad username" before anything is minted; RECOVER says nothing about any username. */
    expect(await mintAuthorization({ purpose: "create", username: "two words", wallet: WALLET }, server.port)).toEqual({ ok: false, error: "bad-username" });
    expect(await mintAuthorization({ purpose: "recover", username: "two words", wallet: WALLET }, server.port)).toEqual({ ok: false, error: "invalid-credential" });
    expect(await logIn({ username: "", password: PASSWORD }, server.port)).toEqual({ ok: false, error: "invalid-credential" });
    expect(await logIn({ username: "Brad", password: "" }, server.port)).toEqual({ ok: false, error: "invalid-credential" });
    expect(await recoverAccount({ operation: OPERATION, signed: SIGNED, newPassword: "short" }, server.port)).toEqual({ ok: false, error: "bad-password", problem: "too-short" });
    expect(await changePassword({ currentPassword: PASSWORD, newPassword: "short" }, server.port)).toEqual({ ok: false, error: "bad-password", problem: "too-short" });
    expect(await changePassword({ currentPassword: "", newPassword: NEW_PASSWORD }, server.port)).toEqual({ ok: false, error: "invalid-credential" });
    expect(await reauthenticateWithPassword("", server.port)).toEqual({ ok: false, error: "invalid-credential" });
    expect(server.calls.length).toBe(before);
  });
});

describe("results and the re-bootstrap (LIVE-2E, PHASE 3 FINAL)", () => {
  it("create: the port is 'ready' as the new account before the call resolves -- and nothing like a recovery key comes back", async () => {
    const server = fakeServer(null);
    await ready(server);
    expect(server.port.state).toBe("unprofiled");
    /* Even an answer that carried a key (an older server) reveals none: the result is the name, nothing else. */
    server.queue("/gs/api/account/create", 201, { ok: true, profile: { name: "Brad", otherSessions: 0 }, username: "Brad.Player", recoveryKey: "rk_0123456789abcdefghjkmnpqr0.AAAA" }, () =>
      server.setProfile({ name: "Brad", otherSessions: 0, username: "Brad.Player" }),
    );
    const result = await create(server.port);
    expect(result).toEqual({ ok: true, name: "Brad" });
    expect(JSON.stringify(result)).not.toContain("rk_");
    expect(server.port.state).toBe("ready");
    expect(server.port.account).toEqual({ name: "Brad", otherSessions: 0, username: "Brad.Player" });
    expect(server.bootstraps()).toBe(2);
  });

  it("create answering already-profiled (another tab, or a lost response) re-bootstraps, and says which profile", async () => {
    const server = fakeServer(null);
    await ready(server);
    server.setProfile({ name: "Brad", otherSessions: 0 });
    server.queue("/gs/api/account/create", 409, { error: "already-profiled", profile: { name: "Brad" } });
    expect(await create(server.port)).toEqual({ ok: false, error: "already-profiled", name: "Brad" });
    expect(server.port.state).toBe("ready");
    expect(server.bootstraps()).toBe(2);
  });

  it("create: each refusal maps to its own result -- the Authorization Wallet's included -- and none changes the session", async () => {
    const server = fakeServer(null);
    await ready(server);
    const cases: Array<[number, Record<string, unknown> | undefined, ProfileFailure]> = [
      [400, { error: "bad-name" }, { ok: false, error: "bad-name" }],
      [400, { error: "bad-username" }, { ok: false, error: "bad-username" }],
      [400, { error: "bad-password", problem: "too-long" }, { ok: false, error: "bad-password", problem: "too-long" }],
      [409, { error: "username-taken" }, { ok: false, error: "username-taken" }],
      [403, { error: "authorization-invalid" }, { ok: false, error: "authorization-invalid" }],
      [409, { error: "authorization-used" }, { ok: false, error: "authorization-used" }],
      [409, { error: "has-tables" }, { ok: false, error: "has-tables" }],
      [410, { error: "retired" }, { ok: false, error: "retired" }],
      [429, { error: "rate-limited", retryAfterMs: 12_300 }, { ok: false, error: "rate-limited", retryAfterMs: 12_300 }],
      [503, { error: "busy" }, { ok: false, error: "busy" }],
      [503, { error: "unavailable" }, { ok: false, error: "unavailable" }],
      [403, { error: "origin-forbidden" }, { ok: false, error: "unavailable" }],
    ];
    for (const [status, body, expected] of cases) {
      server.queue("/gs/api/account/create", status, body);
      expect([status, body?.error, await create(server.port)]).toEqual([status, body?.error, expected]);
    }
    expect(profileErrorSentence({ ok: false, error: "rate-limited", retryAfterMs: 12_300 })).toBe("Too many attempts. Wait 13 seconds and try again.");
    expect(profileErrorSentence({ ok: false, error: "has-tables" }, "account")).toMatch(/Create account/);
    expect(server.port.state).toBe("unprofiled");
    expect(server.bootstraps()).toBe(1); // nothing about the session changed
  });

  it("mint: the texts exactly as the server minted them; a malformed answer is 'unavailable'; a taken username or a bad wallet is said before anything is signed", async () => {
    const server = fakeServer(null);
    await ready(server);
    server.queue("/gs/api/account/authorization", 200, minted(CREATE_TEXTS));
    expect(await mintAuthorization({ purpose: "create", username: "Brad", wallet: WALLET }, server.port)).toEqual({ ok: true, minted: { operation: OPERATION, texts: CREATE_TEXTS, expiresAt: 600_000 } });
    server.queue("/gs/api/account/authorization", 200, minted(CREATE_TEXTS, "NOT-HEX"));
    expect(await mintAuthorization({ purpose: "create", username: "Brad", wallet: WALLET }, server.port)).toEqual({ ok: false, error: "unavailable" });
    server.queue("/gs/api/account/authorization", 200, minted([...REPLACE_TEXTS, ...CREATE_TEXTS]));
    expect(await mintAuthorization({ purpose: "create", username: "Brad", wallet: WALLET }, server.port)).toEqual({ ok: false, error: "unavailable" });
    server.queue("/gs/api/account/authorization", 200, minted([{ purpose: "CREATE", signer: WALLET } as never]));
    expect(await mintAuthorization({ purpose: "create", username: "Brad", wallet: WALLET }, server.port)).toEqual({ ok: false, error: "unavailable" });
    server.queue("/gs/api/account/authorization", 409, { error: "username-taken" });
    expect(await mintAuthorization({ purpose: "create", username: "Brad", wallet: WALLET }, server.port)).toEqual({ ok: false, error: "username-taken" });
    server.queue("/gs/api/account/authorization", 400, { error: "bad-wallet" });
    expect(await mintAuthorization({ purpose: "recover", username: "Brad", wallet: "juno1nope" }, server.port)).toEqual({ ok: false, error: "bad-wallet" });
    expect(server.bootstraps()).toBe(1);
  });

  it("recover ('Forgot password?'): success re-bootstraps into the account and says how many devices were signed out; a refusal is one answer that names nothing", async () => {
    const server = fakeServer(null);
    await ready(server);
    server.queue("/gs/api/account/recover", 403, { error: "invalid-credential" });
    const wrong = await recoverAccount({ operation: OPERATION, signed: SIGNED, newPassword: NEW_PASSWORD }, server.port);
    expect(wrong).toEqual({ ok: false, error: "invalid-credential" });
    expect(profileErrorSentence(wrong as ProfileFailure, "recover")).toBe(
      "That didn't recover an account. Check the username, and that Keplr is on the account's Authorization Wallet — a wallet you only used for games can't recover it.",
    );
    expect(server.port.state).toBe("unprofiled");
    server.queue("/gs/api/account/recover", 200, { ok: true, profile: { name: "Brad" }, signedOut: 2 }, () => server.setProfile({ name: "Brad", otherSessions: 0, username: "Brad.Player" }));
    expect(await recoverAccount({ operation: OPERATION, signed: SIGNED, newPassword: NEW_PASSWORD }, server.port)).toEqual({ ok: true, name: "Brad", signedOut: 2 });
    expect(server.port.state).toBe("ready");
    expect(server.port.account).toEqual({ name: "Brad", otherSessions: 0, username: "Brad.Player" });
    expect(server.bootstraps()).toBe(2);
  });

  it("recover: authorization-used, not-authenticated, rate-limited, already-profiled and a network failure", async () => {
    const server = fakeServer(null);
    await ready(server);
    const recover = (port: SessionPort) => recoverAccount({ operation: OPERATION, signed: SIGNED, newPassword: NEW_PASSWORD }, port);
    server.queue("/gs/api/account/recover", 409, { error: "authorization-used" });
    expect(await recover(server.port)).toEqual({ ok: false, error: "authorization-used" });
    server.queue("/gs/api/account/recover", 429, { error: "rate-limited", retryAfterMs: 1_000 });
    expect(await recover(server.port)).toEqual({ ok: false, error: "rate-limited", retryAfterMs: 1_000 });
    expect(server.bootstraps()).toBe(1);
    server.queue("/gs/api/account/recover", 401, { error: "not-authenticated" });
    expect(await recover(server.port)).toEqual({ ok: false, error: "not-authenticated" });
    expect(server.bootstraps()).toBe(2); // a stale picture of the session is refreshed
    server.setProfile({ name: "Brad", otherSessions: 0 });
    server.queue("/gs/api/account/recover", 409, { error: "already-profiled" });
    expect(await recover(server.port)).toEqual({ ok: false, error: "already-profiled" });
    expect(server.port.state).toBe("ready");
    const offline = httpSessionPort({ endpoint: ENDPOINT, fetch: () => Promise.reject(new TypeError("Failed to fetch")) });
    expect(await recover(offline)).toEqual({ ok: false, error: "network" });
  });

  it("log in: a wrong password is one answer; an account made before Authorization Wallets is 'legacy-account' -- retired, said plainly; nothing signs in", async () => {
    const server = fakeServer(null);
    await ready(server);
    server.queue("/gs/api/account/login", 403, { error: "invalid-credential" });
    const wrong = await logIn({ username: "Brad", password: PASSWORD }, server.port);
    expect(wrong).toEqual({ ok: false, error: "invalid-credential" });
    expect(profileErrorSentence(wrong as ProfileFailure, "login")).toBe("That username and password don't match an account. Check them and try again.");
    server.queue("/gs/api/account/login", 409, { error: "legacy-account" });
    const legacy = await logIn({ username: "Old.Timer", password: PASSWORD }, server.port);
    expect(legacy).toEqual({ ok: false, error: "legacy-account" });
    expect(profileErrorSentence(legacy as ProfileFailure, "login")).toBe("That account was made before Authorization Wallets and is retired. Create a new account to keep playing.");
    expect(server.port.state).toBe("unprofiled");
    expect(server.bootstraps()).toBe(1);
    server.queue("/gs/api/account/login", 200, { ok: true, profile: { name: "Brad" } }, () => server.setProfile({ name: "Brad", otherSessions: 1, username: "Brad.Player" }));
    expect(await logIn({ username: "Brad.Player", password: PASSWORD }, server.port)).toEqual({ ok: true, name: "Brad" });
    expect(server.port.state).toBe("ready");
    expect(server.bootstraps()).toBe(2);
  });

  it("change password: both passwords in one request; the other devices signed out and this browser re-bootstrapped; a wrong current password is one answer", async () => {
    const server = fakeServer({ name: "Brad", otherSessions: 2, username: "Brad.Player" });
    await ready(server);
    server.queue("/gs/api/account/password", 403, { error: "invalid-credential" });
    const wrong = await changePassword({ currentPassword: "not it", newPassword: NEW_PASSWORD }, server.port);
    expect(wrong).toEqual({ ok: false, error: "invalid-credential" });
    expect(profileErrorSentence(wrong as ProfileFailure, "change")).toBe("That current password doesn't match this account. Check it and try again.");
    expect(server.bootstraps()).toBe(1);
    server.queue("/gs/api/account/password", 200, { ok: true, signedOut: 2 }, () => server.setProfile({ name: "Brad", otherSessions: 0, username: "Brad.Player" }));
    expect(await changePassword({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD }, server.port)).toEqual({ ok: true, signedOut: 2 });
    expect(server.bootstraps()).toBe(2);
    expect(server.port.account?.otherSessions).toBe(0);
  });

  it("Authorization Wallet replacement: the challenge carries exactly two texts; the replace answers the new wallet; refusals are their own results; the session is untouched", async () => {
    const server = fakeServer({ name: "Brad", otherSessions: 0, username: "Brad.Player" });
    await ready(server);
    server.queue("/gs/api/account/authorization-wallet/challenge", 403, { error: "reauth-required" });
    expect(await replacementChallenge(NEW_WALLET, server.port)).toEqual({ ok: false, error: "reauth-required" });
    server.queue("/gs/api/account/authorization-wallet/challenge", 200, minted(CREATE_TEXTS));
    expect(await replacementChallenge(NEW_WALLET, server.port)).toEqual({ ok: false, error: "unavailable" }); // one text is not a replacement
    server.queue("/gs/api/account/authorization-wallet/challenge", 409, { error: "same-wallet" });
    expect(await replacementChallenge(WALLET, server.port)).toEqual({ ok: false, error: "same-wallet" });
    server.queue("/gs/api/account/authorization-wallet/challenge", 200, minted(REPLACE_TEXTS));
    expect(await replacementChallenge(NEW_WALLET, server.port)).toEqual({ ok: true, minted: { operation: OPERATION, texts: REPLACE_TEXTS, expiresAt: 600_000 } });
    const replace = () => replaceAuthorizationWallet({ operation: OPERATION, approve: SIGNED, accept: SIGNED }, server.port);
    server.queue("/gs/api/account/authorization-wallet/replace", 409, { error: "stale" });
    expect(await replace()).toEqual({ ok: false, error: "stale" });
    server.queue("/gs/api/account/authorization-wallet/replace", 403, { error: "authorization-invalid" });
    expect(await replace()).toEqual({ ok: false, error: "authorization-invalid" });
    server.queue("/gs/api/account/authorization-wallet/replace", 200, { ok: true });
    expect(await replace()).toEqual({ ok: false, error: "unavailable" });
    server.queue("/gs/api/account/authorization-wallet/replace", 200, { ok: true, authorizationWallet: { address: NEW_WALLET, since: 77 } });
    expect(await replace()).toEqual({ ok: true, authorizationWallet: { address: NEW_WALLET, since: 77 } });
    expect(server.bootstraps()).toBe(1);
  });

  it("account details: the name, username, Authorization Wallet and since when -- an answer without the Authorization Wallet is 'unavailable'", async () => {
    const server = fakeServer({ name: "Brad", otherSessions: 1 });
    await ready(server);
    server.queue("/gs/api/account/me", 200, ME);
    expect(await accountDetails(server.port)).toEqual({ ok: true, account: ME.account });
    /* The retired shape (a recovery-key flag and a remembered "verified wallet"): not an account this build reads. */
    server.queue("/gs/api/account/me", 200, { ok: true, account: { name: "Brad", username: "Brad.Player", recoveryKey: true, wallet: { address: WALLET, verifiedAt: 1 }, memberSince: 4, otherSessions: 1 } });
    expect(await accountDetails(server.port)).toEqual({ ok: false, error: "unavailable" });
    server.queue("/gs/api/account/me", 200, { ok: true, account: { ...ME.account, otherSessions: -3, extra: "dropped" } });
    expect(await accountDetails(server.port)).toEqual({ ok: true, account: { ...ME.account, otherSessions: 0 } });
    server.queue("/gs/api/account/me", 403, { error: "profile-required" });
    expect(await accountDetails(server.port)).toEqual({ ok: false, error: "profile-required" });
  });

  it("sign-outs: their results, and which of them re-bootstrap", async () => {
    const server = fakeServer({ name: "Brad", otherSessions: 2 });
    await ready(server);
    server.queue("/gs/api/profile/sign-out-others", 200, { ok: true, signedOut: 2 }, () => server.setProfile({ name: "Brad", otherSessions: 0 }));
    expect(await signOutOtherDevices(server.port)).toEqual({ ok: true, signedOut: 2 });
    expect(server.bootstraps()).toBe(2);
    expect(server.port.account?.otherSessions).toBe(0);
    server.queue("/gs/api/profile/sign-out-others", 403, { error: "profile-required" });
    expect(await signOutOtherDevices(server.port)).toEqual({ ok: false, error: "profile-required" });
    server.queue("/gs/api/session/revoke", 204);
    expect(await signOutThisDevice(server.port)).toEqual({ ok: true });
    server.queue("/gs/api/session/revoke", 401, { error: "not-authenticated" });
    expect(await signOutThisDevice(server.port)).toEqual({ ok: true }); // no session to end: signed out already
  });

  it("PHASE 3 FINAL: a retired route (a page from an older build) is 'retired' -- reload, one sentence", async () => {
    const server = fakeServer({ name: "Brad", otherSessions: 0 });
    await ready(server);
    server.queue("/gs/api/account/me", 410, { error: "retired" });
    const retired = await accountDetails(server.port);
    expect(retired).toEqual({ ok: false, error: "retired" });
    expect(profileErrorSentence(retired as ProfileFailure)).toBe("This page is out of date. Reload it and try again.");
  });
});

describe("ESCROW-3A: sensitive actions ask this session to confirm it's you -- with the PASSWORD", () => {
  it("sign-out-others answers reauth-required; the password grants the window; a wrong password is one answer; no re-bootstrap", async () => {
    const server = fakeServer({ name: "Brad", otherSessions: 1 });
    await ready(server);
    server.queue("/gs/api/profile/sign-out-others", 403, { error: "reauth-required" });
    const held = await signOutOtherDevices(server.port);
    expect(held).toEqual({ ok: false, error: "reauth-required" });
    expect(profileErrorSentence(held as ProfileFailure)).toBe("For your security, confirm it's you first.");
    server.queue("/gs/api/profile/reauth", 403, { error: "invalid-credential" });
    const wrong = await reauthenticateWithPassword("not the password", server.port);
    expect(wrong).toEqual({ ok: false, error: "invalid-credential" });
    expect(profileErrorSentence(wrong as ProfileFailure, "password")).toBe("That password doesn't match this account. Check it and try again.");
    server.queue("/gs/api/profile/reauth", 429, { error: "rate-limited", retryAfterMs: 2_000 });
    expect(await reauthenticateWithPassword(PASSWORD, server.port)).toEqual({ ok: false, error: "rate-limited", retryAfterMs: 2_000 });
    server.queue("/gs/api/profile/reauth", 200, { ok: true, expiresAt: 300_000 });
    expect(await reauthenticateWithPassword(PASSWORD, server.port)).toEqual({ ok: true, expiresAt: 300_000 });
    server.queue("/gs/api/profile/reauth", 200, { ok: true });
    expect(await reauthenticateWithPassword(PASSWORD, server.port)).toEqual({ ok: false, error: "unavailable" });
    expect(server.posted().filter(([path]) => path === "/gs/api/profile/reauth").map(([, body]) => body)).toEqual([
      { password: "not the password" },
      { password: PASSWORD },
      { password: PASSWORD },
      { password: PASSWORD },
    ]);
    expect(server.bootstraps()).toBe(1);
  });
});

/* ESCROW-3A's creation receipt (the lost-create-response rescue: `mintCreationReceipt`, `profile/key-received`) is gone
   with the recovery key it rescued -- PHASE 3 FINAL creates the account and its Authorization Wallet in ONE signed
   request (`createAccount` above); a lost response is an `already-profiled` answer, pinned above. */

describe("the words (PHASE 3 FINAL)", () => {
  it("each new refusal reads in account words, and no sentence of any code in any context mentions a recovery key", () => {
    const said = (error: ProfileErrorCode, context?: Parameters<typeof profileErrorSentence>[1]) => profileErrorSentence({ ok: false, error }, context);
    expect(said("authorization-invalid")).toBe("The wallet's signature didn't check out (or it took too long). Nothing was changed — try again and sign the new message.");
    expect(said("authorization-used")).toBe("That signature was already used. Try again and sign the new message.");
    expect(said("bad-wallet")).toBe("That isn't a Juno wallet address.");
    expect(said("same-wallet", "replace")).toBe("That's already your Authorization Wallet. Switch Keplr to the wallet you want to use instead.");
    expect(said("stale", "replace")).toBe("Your Authorization Wallet changed meanwhile. Start again.");
    expect(said("profile-required")).toBe("Log in or create an account first.");
    expect(said("bad-request", "recover")).toBe(said("invalid-credential", "recover"));
    expect(said("bad-request", "change")).toBe(said("invalid-credential", "change"));
    const codes: ProfileErrorCode[] = [
      "invalid-credential",
      "username-taken",
      "bad-username",
      "bad-password",
      "authorization-invalid",
      "authorization-used",
      "bad-wallet",
      "same-wallet",
      "stale",
      "legacy-account",
      "busy",
      "already-profiled",
      "has-tables",
      "bad-name",
      "bad-request",
      "rate-limited",
      "not-authenticated",
      "profile-required",
      "reauth-required",
      "retired",
      "unavailable",
      "network",
    ];
    const contexts = ["create", "reauth", "action", "login", "account", "password", "recover", "change", "replace"] as const;
    for (const code of codes) {
      for (const context of contexts) expect([code, context, /recovery[\s-]?key|link code/i.test(said(code, context))]).toEqual([code, context, false]);
    }
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
      server.queue("/gs/api/account/authorization", 200, minted(CREATE_TEXTS));
      server.queue("/gs/api/account/create", 201, { ok: true, profile: { name: "Brad", otherSessions: 0 }, username: "Brad.Player" }, () => server.setProfile({ name: "Brad", otherSessions: 0 }));
      server.queue("/gs/api/account/password", 200, { ok: true, signedOut: 0 });
      server.queue("/gs/api/profile/reauth", 200, { ok: true, expiresAt: 1 });
      server.queue("/gs/api/account/recover", 200, { ok: true, profile: { name: "Brad" }, signedOut: 0 });
      await mintAuthorization({ purpose: "create", username: "Brad.Player", wallet: WALLET }, server.port);
      await create(server.port);
      await changePassword({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD }, server.port);
      await reauthenticateWithPassword(PASSWORD, server.port);
      await recoverAccount({ operation: OPERATION, signed: SIGNED, newPassword: NEW_PASSWORD }, server.port);
      for (const spy of writes) expect(spy).not.toHaveBeenCalled();
      for (const spy of said) expect(spy).not.toHaveBeenCalled();
      for (const secret of [PASSWORD.trim(), NEW_PASSWORD, SIGNED.signature]) expect(JSON.stringify(server.port)).not.toContain(secret);
    } finally {
      for (const spy of [...writes, ...said]) spy.mockRestore();
    }
  });
});
