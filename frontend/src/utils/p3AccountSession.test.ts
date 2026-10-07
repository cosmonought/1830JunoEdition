/** @jest-environment jsdom */
//
// PHASE 3 (P3-ACCT): the session under a sign-in, and the account prompt's resume. A sign-in REPLACES this browser's
// session (the server revokes the old one `replaced` and closes its sockets 4401), so:
//
//   a bootstrap asked while a sign-in is on the wire waits for its answer -- a socket that closed under the old cookie
//   comes back on the NEW one, never as "signed out";
//   a bootstrap told `replaced` asks once more (another tab's sign-in may still be landing in the cookie jar) -- and
//   only once: a session that really ended stays ended;
//   `requireAccount` runs the action at once for a signed-in page, and otherwise holds it until the sign-in -- the
//   sockets renewed first, then the action, exactly once; closing the dialog drops it.
//   The account API sends each credential once, in a POST body, to a closed list of paths.
//
// PHASE 3 FINAL (owner ruling 2026-10-06): the session-replacing routes are the four sign-ins of the Authorization-Wallet
// account (create, log in, "Forgot password?" = `account/recover`, change password); the profile-era ones
// (`profile/recover`, `profile/link`, `account/reset`) are retired.

import { httpSessionPort, SESSION_REPLACING_PATHS } from "./sessionBootstrap";
import { accountSignedIn, accountPromptState, closeAccountDialog, requireAccount, resetAccountPromptForTests } from "./accountPrompt";
import { accountDetails, createAccount, logIn, profileErrorSentence, reauthenticateWithPassword, type ProfileFailure } from "./profileApi";

const ENDPOINT = "https://play.example/gs/api/session";

function manualFetch() {
  const calls: Array<{ path: string; body: string }> = [];
  const waiting: Array<{ path: string; resolve: (response: { status: number; body?: unknown }) => void }> = [];
  const fetch = (input: string, init: { body: string }) =>
    new Promise<{ status: number; json(): Promise<unknown> }>((resolve) => {
      const path = new URL(input).pathname;
      calls.push({ path, body: init.body });
      waiting.push({ path, resolve: (response) => resolve({ status: response.status, json: async () => response.body ?? {} }) });
    });
  const answer = async (path: string, status: number, body?: unknown) => {
    const index = waiting.findIndex((entry) => entry.path === path);
    if (index < 0) throw new Error(`no request to ${path} is waiting`);
    const [next] = waiting.splice(index, 1);
    next.resolve({ status, body });
    for (let n = 0; n < 10; n += 1) await Promise.resolve();
  };
  return { fetch, calls, answer, pending: () => waiting.map((entry) => entry.path) };
}

const flush = async () => {
  for (let n = 0; n < 10; n += 1) await Promise.resolve();
};
/** The `replaced` retry waits a (zero-length, in tests) timer: let it fire. */
const tick = async () => {
  await new Promise((resolve) => setTimeout(resolve, 1));
  await flush();
};

describe("P3-ACCT: the session under a sign-in", () => {
  it("the routes that replace a session are exactly the sign-ins (PHASE 3 FINAL: create, log in, recover by the Authorization Wallet, change password)", () => {
    expect(Array.from(SESSION_REPLACING_PATHS).sort()).toEqual(["account/create", "account/login", "account/password", "account/recover"]);
  });

  it("a bootstrap asked while a sign-in is on the wire waits for it, then asks -- with the new cookie in place", async () => {
    const http = manualFetch();
    const port = httpSessionPort({ endpoint: ENDPOINT, fetch: http.fetch, replacedRetryMs: 0 });
    const first = port.ensure();
    await http.answer("/gs/api/session", 200, { ok: true, profile: null });
    expect(await first).toBe("unprofiled");
    const login = logIn({ username: "Brad", password: "a password here" }, port);
    await flush();
    /* A socket closed under the old session (4401) forces a bootstrap now: it must NOT go out yet. */
    const forced = port.ensure(true);
    await flush();
    expect(http.pending()).toEqual(["/gs/api/account/login"]);
    await http.answer("/gs/api/account/login", 200, { ok: true, profile: { name: "Brad" } });
    await flush();
    expect(http.pending()).toContain("/gs/api/session");
    await http.answer("/gs/api/session", 200, { ok: true, profile: { name: "Brad", otherSessions: 0 } });
    await flush();
    if (http.pending().includes("/gs/api/session")) await http.answer("/gs/api/session", 200, { ok: true, profile: { name: "Brad", otherSessions: 0 } });
    expect(await forced).toBe("ready");
    expect((await login).ok).toBe(true);
    expect(port.state).toBe("ready");
  });

  it("told `replaced`, a bootstrap asks once more (another tab's sign-in landing) -- and a session that really ended stays ended", async () => {
    const http = manualFetch();
    const port = httpSessionPort({ endpoint: ENDPOINT, fetch: http.fetch, replacedRetryMs: 0 });
    const first = port.ensure();
    await http.answer("/gs/api/session", 401, { error: "session-ended", reason: "replaced" });
    await tick();
    await http.answer("/gs/api/session", 200, { ok: true, profile: { name: "Brad", otherSessions: 1 } });
    expect(await first).toBe("ready");
    const other = httpSessionPort({ endpoint: ENDPOINT, fetch: http.fetch, replacedRetryMs: 0 });
    const ended = other.ensure();
    await http.answer("/gs/api/session", 401, { error: "session-ended", reason: "replaced" });
    await tick();
    await http.answer("/gs/api/session", 401, { error: "session-ended", reason: "replaced" });
    expect(await ended).toBe("ended");
    expect(other.endedReason).toBe("replaced");
    /* Any other reason is final at once. */
    const third = httpSessionPort({ endpoint: ENDPOINT, fetch: http.fetch, replacedRetryMs: 0 });
    const logout = third.ensure();
    await http.answer("/gs/api/session", 401, { error: "session-ended", reason: "logout" });
    expect(await logout).toBe("ended");
    expect(http.pending()).toEqual([]);
  });
});

describe("P3-ACCT independent-review fixes: the session", () => {
  it("review M3: a sign-in that never answers is given up after the timeout -- the dialog's call answers 'network', and the bootstraps it held go out", async () => {
    const http = manualFetch();
    const port = httpSessionPort({ endpoint: ENDPOINT, fetch: http.fetch, replacedRetryMs: 0, signInTimeoutMs: 5 });
    const first = port.ensure();
    await http.answer("/gs/api/session", 200, { ok: true, profile: null });
    await first;
    const login = port.api("account/login", { username: "Brad", password: "a password here" });
    const held = port.ensure(true);
    await flush();
    expect(http.pending()).toEqual(["/gs/api/account/login"]); // held while the sign-in is on the wire...
    await new Promise((resolve) => setTimeout(resolve, 20));
    await flush();
    expect(await login).toEqual({ kind: "network" }); // ...but never past the timeout
    expect(http.pending()).toContain("/gs/api/session");
    await http.answer("/gs/api/session", 200, { ok: true, profile: null });
    expect(await held).toBe("unprofiled");
  });
});

describe("P3-ACCT: requireAccount -- asked at the action, resumed after the sign-in", () => {
  beforeEach(() => resetAccountPromptForTests());

  it("signed in: the action runs at once, and no dialog opens", async () => {
    const http = manualFetch();
    const port = httpSessionPort({ endpoint: ENDPOINT, fetch: http.fetch });
    const ready = port.ensure();
    await http.answer("/gs/api/session", 200, { ok: true, profile: { name: "Brad", otherSessions: 0 } });
    await ready;
    let ran = 0;
    expect(requireAccount(() => (ran += 1), "to host", { port })).toBe(true);
    expect(ran).toBe(1);
    expect(accountPromptState().open).toBe(false);
  });

  it("signed out: the dialog opens with the reason; a sign-in renews the sockets FIRST, then runs the action once; a close drops it", () => {
    const order: string[] = [];
    const visitor = { state: "unprofiled", account: null } as never;
    expect(requireAccount(() => order.push("host"), "Log in or create an account to host a game.", { port: visitor })).toBe(false);
    expect(accountPromptState()).toEqual({ open: true, mode: "login", reason: "Log in or create an account to host a game." });
    expect(order).toEqual([]);
    accountSignedIn({ renew: () => order.push("renew") });
    expect(order).toEqual(["renew", "host"]);
    expect(accountPromptState().open).toBe(false);
    accountSignedIn({ renew: () => order.push("renew") });
    expect(order).toEqual(["renew", "host", "renew"]); // never twice
    requireAccount(() => order.push("join"), "to join", { port: visitor });
    closeAccountDialog();
    accountSignedIn({ renew: () => undefined });
    expect(order).not.toContain("join");
  });

  it("re-review N6: two presses before the page knows it is signed in are ONE action -- the last one pressed", async () => {
    const http = manualFetch();
    const port = httpSessionPort({ endpoint: ENDPOINT, fetch: http.fetch });
    const ran: string[] = [];
    requireAccount(() => ran.push("first"), "to join", { port });
    requireAccount(() => ran.push("second"), "to join", { port });
    expect(http.pending()).toEqual(["/gs/api/session"]); // one question
    await http.answer("/gs/api/session", 200, { ok: true, profile: { name: "Brad", otherSessions: 0 } });
    await flush();
    expect(ran).toEqual(["second"]);
  });

  it("review L6: a page that doesn't know yet asks the server first -- signed in, the action runs and no dialog opens; a visitor gets the dialog", async () => {
    const http = manualFetch();
    const port = httpSessionPort({ endpoint: ENDPOINT, fetch: http.fetch });
    let ran = 0;
    expect(requireAccount(() => (ran += 1), "to join", { port })).toBe(false);
    expect(accountPromptState().open).toBe(false); // never "Log in" before the answer
    await http.answer("/gs/api/session", 200, { ok: true, profile: { name: "Brad", otherSessions: 0 } });
    await flush();
    expect(ran).toBe(1);
    expect(accountPromptState().open).toBe(false);
    const other = httpSessionPort({ endpoint: ENDPOINT, fetch: http.fetch });
    requireAccount(() => (ran += 1), "to join", { port: other });
    await http.answer("/gs/api/session", 200, { ok: true, profile: null });
    await flush();
    expect(ran).toBe(1);
    expect(accountPromptState()).toEqual({ open: true, mode: "login", reason: "to join" });
  });
});

describe("P3-ACCT: the account API -- one POST body per credential, a closed list of paths", () => {
  const OPERATION = "0123456789abcdef0123456789abcdef";
  const SIGNED = { pubKey: "Ai1R5vzeZFvF73ROli+IbV7OuNG7bM6HeI0rthBGJzvf", signature: "c2lnbmF0dXJl" };
  const WALLET = "juno12gdmst084pz888ds7g80nv27p9wadknwdl783a";

  it("create (with the Authorization Wallet's signature), log in, details and the password re-check", async () => {
    const http = manualFetch();
    const port = httpSessionPort({ endpoint: ENDPOINT, fetch: http.fetch });
    const created = createAccount({ username: " Ann ", password: " spaces count ", name: "Ann", operation: OPERATION, signed: SIGNED }, port);
    await flush();
    await http.answer("/gs/api/account/create", 201, { ok: true, profile: { name: "Ann", otherSessions: 0 }, username: "Ann" });
    await http.answer("/gs/api/session", 200, { ok: true, profile: { name: "Ann", otherSessions: 0, username: "Ann" } });
    /* PHASE 3 FINAL: nothing is revealed after creation -- there is no recovery key. */
    expect(await created).toEqual({ ok: true, name: "Ann" });
    expect(port.account).toEqual({ name: "Ann", otherSessions: 0, username: "Ann" });
    /* The username is trimmed; the password never is (spaces are part of it). */
    expect(JSON.parse(http.calls[0].body)).toEqual({ username: "Ann", password: " spaces count ", name: "Ann", operation: OPERATION, pubKey: SIGNED.pubKey, signature: SIGNED.signature });

    const taken = createAccount({ username: "Bea", password: "long enough now", name: "Bea", operation: OPERATION, signed: SIGNED }, port);
    await flush();
    await http.answer("/gs/api/account/create", 409, { error: "username-taken" });
    await flush();
    if (http.pending().includes("/gs/api/session")) await http.answer("/gs/api/session", 200, { ok: true, profile: { name: "Ann", otherSessions: 0 } });
    const takenAnswer = (await taken) as ProfileFailure;
    expect(takenAnswer.error).toBe("username-taken");
    expect(profileErrorSentence(takenAnswer, "account")).toBe("That username is taken. Choose another.");

    const details = accountDetails(port);
    await flush();
    const account = { name: "Ann", username: "Ann", authorizationWallet: { address: WALLET, since: 4 }, memberSince: 5, otherSessions: 0 };
    await http.answer("/gs/api/account/me", 200, { ok: true, account });
    expect(await details).toEqual({ ok: true, account });

    /* Removed here with the model they belonged to (PHASE 3 FINAL): `establishCredentials` (a legacy profile's
       username + password -- legacy profiles are retired, `legacy-account`) and `forgetWallet` (no remembered
       wallet: the Authorization Wallet is replaced, never forgotten -- `profileApi.test.ts`). */

    const check = reauthenticateWithPassword("the password", port);
    await flush();
    await http.answer("/gs/api/profile/reauth", 200, { ok: true, expiresAt: 99 });
    expect(await check).toEqual({ ok: true, expiresAt: 99 });
    expect(JSON.parse(http.calls.find((call) => call.path === "/gs/api/profile/reauth")!.body)).toEqual({ password: "the password" });
    /* Nothing went anywhere but /gs/api, and no credential was ever in a URL. */
    for (const call of http.calls) {
      expect(call.path.startsWith("/gs/api/")).toBe(true);
      expect(call.path).not.toMatch(/password|spaces|Ann\b|c2lnbmF0dXJl|0123456789abcdef/);
    }
  });

  it("log in: an empty field is the wrong-password answer without a request; a busy server says so", async () => {
    const http = manualFetch();
    const port = httpSessionPort({ endpoint: ENDPOINT, fetch: http.fetch });
    expect(await logIn({ username: "", password: "x" }, port)).toEqual({ ok: false, error: "invalid-credential" });
    expect(await logIn({ username: "Brad", password: "" }, port)).toEqual({ ok: false, error: "invalid-credential" });
    expect(http.calls).toEqual([]);
    const busy = logIn({ username: "Brad", password: "a password here" }, port);
    await flush();
    await http.answer("/gs/api/account/login", 503, { error: "busy" });
    const answer = (await busy) as ProfileFailure;
    expect(answer.error).toBe("busy");
    expect(profileErrorSentence(answer, "login")).toMatch(/busy/);
  });
});
