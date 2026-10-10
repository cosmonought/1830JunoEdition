/** @jest-environment jsdom */
//
// LIVE-2E / P3-ACCT / PHASE 3 FINAL: THE ACCOUNT CORNER AND THE SIGNED-OUT NOTICE. Signed out, the corner offers Log in
// and Create account. Signed in, the chip names the account; its menu shows the account (username, member since) and
// its ONE Authorization Wallet (shortened, since when); "Confirm it's you" is the PASSWORD, sent once and never kept; it
// says how many other devices are signed in before signing them out and how many were, and asks before signing this
// device out -- then reloads to the public homepage. A development build offers no credential actions. The signed-out
// notice says nothing of guests: the account and its seats are kept.
//
// PHASE 3 FINAL (owner ruling 2026-10-06) removed from this menu: "Link another device" (a second device LOGS IN), the
// recovery key and its rotation (none exists), the legacy profile's "set a username and password" (legacy profiles are
// retired) and "Forget this wallet" (nothing remembers a wallet; the Authorization Wallet is replaced, never
// forgotten). The Authorization Wallet's replacement order is pinned in `p3FinalAccountWallet.test.tsx`.

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { ProfileMenu } from "./ProfileMenu";
import { SessionEndedNotice } from "./SessionEndedNotice";
import { httpSessionPort, readySessionPort } from "../utils/sessionBootstrap";
import { readStripped } from "../utils/sourceScan";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
global.IS_REACT_ACT_ENVIRONMENT = true;

const ENDPOINT = "https://play.example/gs/api/session";
const AUTHORIZATION_WALLET = "juno1qyqszqgpqyqszqgpqyqszqgpqyqszqgpypz92q";

type Queued = { status: number; body?: unknown; then?: () => void };

function fakeServer(initial: { name: string; otherSessions: number } | null, ended: string | null = null) {
  let profile = initial;
  const calls: Array<{ path: string; body: string }> = [];
  const answers = new Map<string, Queued[]>();
  const port = httpSessionPort({
    endpoint: ENDPOINT,
    replacedRetryMs: 0,
    fetch: async (input, init) => {
      const where = new URL(input).pathname;
      calls.push({ path: where, body: init.body });
      if (where === "/gs/api/session") {
        if (ended !== null && init.body !== '{"fresh":true}') return { status: 401, json: async () => ({ error: "session-ended", reason: ended }) };
        return { status: init.body === '{"fresh":true}' ? 201 : 200, json: async () => ({ ok: true, expiresAt: 1, profile: init.body === '{"fresh":true}' ? null : profile }) };
      }
      const next = answers.get(where)?.shift();
      if (!next) throw new Error(`nothing queued for ${where}`);
      next.then?.();
      return { status: next.status, json: async () => next.body ?? {} };
    },
  });
  return {
    port,
    calls,
    setProfile: (next: typeof profile) => {
      profile = next;
    },
    queue: (where: string, status: number, body?: unknown, then?: () => void) => answers.set(where, [...(answers.get(where) ?? []), { status, body, then }]),
  };
}

let container: HTMLDivElement;
let root: Root;
let reloads = 0;
const realLocation = window.location;

beforeEach(() => {
  reloads = 0;
  delete (window as unknown as { location?: Location }).location;
  (window as unknown as { location: unknown }).location = { ...realLocation, reload: () => (reloads += 1) };
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  (window as unknown as { location: Location }).location = realLocation;
  jest.useRealTimers();
  jest.restoreAllMocks();
});

const flush = async () => {
  for (let n = 0; n < 20; n += 1) await Promise.resolve();
};
const settle = () => act(flush);
const render = async (element: React.ReactElement) => {
  act(() => root.render(element));
  await settle();
};
const byTestId = <T extends HTMLElement = HTMLElement>(id: string) => container.querySelector(`[data-testid="${id}"]`) as T | null;
const buttonNamed = (label: string) =>
  Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.trim() === label) as HTMLButtonElement | undefined;
const click = async (element: Element | null | undefined) => {
  expect(element).toBeTruthy();
  act(() => (element as HTMLElement).click());
  await settle();
};

const type = (input: HTMLInputElement | null, value: string) => {
  expect(input).toBeTruthy();
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input!.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

/** PHASE 3 FINAL: what `/gs/api/account/me` tells an account's own session. */
const accountMe = (otherSessions: number) => ({
  ok: true,
  account: { name: "Brad", otherSessions, username: "Brad.Player", authorizationWallet: { address: AUTHORIZATION_WALLET, since: Date.UTC(2026, 9, 1) }, memberSince: Date.UTC(2026, 8, 30) },
});

async function profiled(otherSessions = 2): Promise<ReturnType<typeof fakeServer>> {
  const server = fakeServer({ name: "Brad", otherSessions });
  await server.port.ensure();
  return server;
}

describe("the profile menu (LIVE-2E)", () => {
  /* PHASE 3 FINAL: "'Link another device' shows a code large, with Copy and a live countdown" and "'Make a new recovery
     key' asks first, then shows the new key once" are removed with link codes and the recovery key -- a second
     device logs in; a forgotten password is "Forgot password?" with the Authorization Wallet (`p3AccountPolicy`). */
  it("names the account, its username and its Authorization Wallet (shortened, since when) -- and nothing of link codes or recovery keys", async () => {
    const server = await profiled();
    server.queue("/gs/api/account/me", 200, accountMe(2));
    await render(<ProfileMenu port={server.port} />);
    expect(byTestId("profile-chip")?.textContent).toBe("Brad");
    await click(byTestId("profile-chip"));
    expect(byTestId("profile-menu-account")?.textContent).toBe("Username Brad.Player · Member since 2026-09-30");
    expect(byTestId("profile-menu-authorization-wallet")?.textContent).toBe("juno1qyqsz…ypz92q · since 2026-10-01");
    expect(byTestId("profile-menu-authorization-wallet")?.querySelector("span")?.getAttribute("title")).toBe(AUTHORIZATION_WALLET);
    expect(byTestId("profile-menu-authorization-note")?.textContent).toContain("the wallet Keplr has selected never changes who you are");
    expect(byTestId("profile-menu-replace-wallet")?.textContent).toBe("Change Authorization Wallet");
    expect(byTestId("profile-menu-password")?.textContent).toBe("Change password");
    for (const gone of ["profile-menu-older", "profile-menu-link", "profile-menu-rotate", "profile-menu-credentials", "profile-menu-wallet", "link-code-value", "recovery-key-value"]) {
      expect([gone, byTestId(gone)]).toEqual([gone, null]);
    }
    expect(buttonNamed("Link another device")).toBeUndefined();
    expect(container.textContent).not.toMatch(/recovery[\s-]?key|link code|forget this wallet/i);
  });

  it("'Sign out other devices' says how many are signed in, asks, then says how many were signed out", async () => {
    const server = await profiled(2);
    await render(<ProfileMenu port={server.port} />);
    await click(byTestId("profile-chip"));
    expect(byTestId("profile-menu-others-count")?.textContent).toBe("2 other devices signed in.");
    await click(buttonNamed("Sign out other devices"));
    expect(byTestId("profile-others-summary")?.textContent).toContain("2 other devices are signed in to this account.");
    server.queue("/gs/api/profile/sign-out-others", 200, { ok: true, signedOut: 2 }, () => server.setProfile({ name: "Brad", otherSessions: 0 }));
    await click(byTestId("profile-others-confirm"));
    expect(byTestId("profile-others-done")?.textContent).toBe("Signed out 2 other devices.");
    expect(server.port.account?.otherSessions).toBe(0);
  });

  it("'Sign out this device' asks first -- the account and its seats are kept -- then revokes and reloads", async () => {
    const server = await profiled();
    await render(<ProfileMenu port={server.port} />);
    await click(byTestId("profile-chip"));
    await click(buttonNamed("Sign out this device"));
    expect(container.textContent).toContain("Your account, games, seats and deposits are kept.");
    expect(container.textContent).toContain("log in again");
    expect(container.textContent).not.toContain("recovery key");
    expect(reloads).toBe(0);
    server.queue("/gs/api/session/revoke", 204);
    await click(byTestId("profile-signout-confirm"));
    expect(server.calls.map((call) => call.path)).toContain("/gs/api/session/revoke");
    expect(reloads).toBe(1);
  });

  it("PHASE 3 FINAL: 'Change Authorization Wallet' always asks 'Confirm it's you' with the PASSWORD first -- a wrong one is one sentence and dropped; the right one opens the first step", async () => {
    const server = await profiled();
    server.queue("/gs/api/account/me", 200, accountMe(2));
    await render(<ProfileMenu port={server.port} />);
    await click(byTestId("profile-chip"));
    await click(byTestId("profile-menu-replace-wallet"));
    /* Asked before anything is minted: a sign-in's standing grant never begins a replacement. */
    expect(server.calls.some((call) => call.path.startsWith("/gs/api/account/authorization-wallet"))).toBe(false);
    expect(container.textContent).toContain("Confirm it’s you");
    expect(container.textContent).toContain("To change your Authorization Wallet, enter your password.");
    const input = byTestId<HTMLInputElement>("profile-reauth-key");
    expect(input?.type).toBe("password");
    expect(input?.autocomplete).toBe("current-password");
    expect(byTestId<HTMLButtonElement>("profile-reauth-confirm")?.disabled).toBe(true);
    /* A wrong password: one sentence, the typed password is dropped, and nothing else happens. */
    server.queue("/gs/api/profile/reauth", 403, { error: "invalid-credential" });
    type(input, "not the password");
    await click(byTestId("profile-reauth-confirm"));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("That password doesn't match this account. Check it and try again.");
    expect(byTestId<HTMLInputElement>("profile-reauth-key")?.value).toBe("");
    expect(byTestId("profile-replace-step-new")).toBeNull();
    /* The right password: the first step -- Keplr on the NEW wallet -- with the current one named. */
    server.queue("/gs/api/profile/reauth", 200, { ok: true, expiresAt: 1 });
    type(byTestId<HTMLInputElement>("profile-reauth-key"), "correct horse battery");
    await click(byTestId("profile-reauth-confirm"));
    expect(byTestId("profile-replace-step-new")?.textContent).toContain("Your current one, juno1qyqsz…ypz92q, approves next.");
    expect(server.calls.filter((call) => call.path === "/gs/api/profile/reauth").map((call) => JSON.parse(call.body))).toEqual([{ password: "not the password" }, { password: "correct horse battery" }]);
    expect(container.innerHTML).not.toContain("correct horse battery");
    expect(server.calls.some((call) => call.path.startsWith("/gs/api/account/authorization-wallet"))).toBe(false);
  });

  /* PHASE 3 FINAL: "'Sign out other devices' held for re-authentication asks a LEGACY profile for its key" is removed --
     legacy profiles are retired (their sessions end `retired`; their password answers `legacy-account`), and every
     account confirms with its password (the next case). */
  it("P3-ACCT: 'Sign out other devices' held for re-authentication confirms with the PASSWORD (sent once, never kept), then signs them out", async () => {
    const server = await profiled(1);
    server.queue("/gs/api/account/me", 200, accountMe(1));
    await render(<ProfileMenu port={server.port} />);
    await click(byTestId("profile-chip"));
    expect(byTestId("profile-menu-account")?.textContent).toBe("Username Brad.Player · Member since 2026-09-30");
    /* No recovery key anywhere: no key rotation, no link code, no remembered "verified wallet". */
    expect(byTestId("profile-menu-older")).toBeNull();
    expect(byTestId("profile-menu-wallet")).toBeNull();
    expect(buttonNamed("Rotate recovery key")).toBeUndefined();
    await click(buttonNamed("Sign out other devices"));
    server.queue("/gs/api/profile/sign-out-others", 403, { error: "reauth-required" });
    await click(byTestId("profile-others-confirm"));
    expect(container.textContent).toContain("To sign out your other devices, enter your password.");
    expect(byTestId<HTMLInputElement>("profile-reauth-key")?.autocomplete).toBe("current-password");
    server.queue("/gs/api/profile/reauth", 200, { ok: true, expiresAt: 1 });
    server.queue("/gs/api/profile/sign-out-others", 200, { ok: true, signedOut: 1 }, () => server.setProfile({ name: "Brad", otherSessions: 0 }));
    type(byTestId<HTMLInputElement>("profile-reauth-key"), "correct horse battery");
    await click(byTestId("profile-reauth-confirm"));
    expect(byTestId("profile-others-done")?.textContent).toBe("Signed out 1 other device.");
    expect(server.calls.filter((call) => call.path === "/gs/api/profile/reauth").map((call) => JSON.parse(call.body))).toEqual([{ password: "correct horse battery" }]);
    expect(container.innerHTML).not.toContain("correct horse battery");
  });

  /* PHASE 3 FINAL: "a legacy profile sets a username and password -- its recovery key confirms it" is removed: no legacy
     credential migration exists (owner ruling: legacy profiles are disposable test profiles, retired with no
     migration). What the menu offers instead -- "Change password" with the CURRENT password -- is the next case. */
  it("PHASE 3 FINAL: 'Change password' sends the current password and the new one in one request (the new one checked first); every other device is signed out, this one stays", async () => {
    const server = await profiled(2);
    server.queue("/gs/api/account/me", 200, accountMe(2));
    await render(<ProfileMenu port={server.port} />);
    await click(byTestId("profile-chip"));
    await click(byTestId("profile-menu-password"));
    expect(byTestId<HTMLInputElement>("profile-current-secret")?.autocomplete).toBe("current-password");
    expect(byTestId<HTMLInputElement>("profile-changed-password")?.autocomplete).toBe("new-password");
    /* PHASE 4: a forgotten current password is one press away, signed in -- the Authorization Wallet resets it. */
    expect(byTestId("profile-password-forgot-note")?.textContent).toBe("Don't know your current password? Reset it with your Authorization Wallet");
    expect(byTestId("profile-password-use-key")).toBeNull();
    type(byTestId<HTMLInputElement>("profile-current-secret"), "the old passphrase");
    type(byTestId<HTMLInputElement>("profile-changed-password"), "too short");
    await click(byTestId("profile-password-save"));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("A password is at least 12 characters.");
    expect(server.calls.some((call) => call.path === "/gs/api/account/password")).toBe(false);
    type(byTestId<HTMLInputElement>("profile-changed-password"), "the new passphrase!");
    server.queue("/gs/api/account/password", 200, { ok: true, signedOut: 2 }, () => server.setProfile({ name: "Brad", otherSessions: 0 }));
    server.queue("/gs/api/account/me", 200, accountMe(0));
    await click(byTestId("profile-password-save"));
    expect(server.calls.filter((call) => call.path === "/gs/api/account/password").map((call) => JSON.parse(call.body))).toEqual([{ currentPassword: "the old passphrase", newPassword: "the new passphrase!" }]);
    expect(byTestId("profile-password-done")?.textContent).toBe("Password changed. Signed out 2 other devices. This device stays signed in.");
    expect(server.port.state).toBe("ready");
    expect(container.innerHTML).not.toContain("the new passphrase!");
    expect(container.innerHTML).not.toContain("the old passphrase");
  });

  it("a development build names the tab's profile and offers no credential actions", async () => {
    await render(<ProfileMenu port={readySessionPort()} />);
    expect(byTestId("profile-chip")?.textContent).toBe("Development profile (this tab)");
    expect(container.querySelector("button")).toBeNull();
  });

  it("P3-ACCT: a signed-out visitor sees Log in and Create account (no chip); an ended session shows nothing (its notice explains)", async () => {
    const server = fakeServer(null);
    await server.port.ensure();
    await render(<ProfileMenu port={server.port} />);
    expect(byTestId("profile-chip")).toBeNull();
    expect(byTestId("account-login")?.textContent).toBe("Log in");
    expect(byTestId("account-create")?.textContent).toBe("Create account");
    const ended = fakeServer({ name: "Brad", otherSessions: 0 }, "logout");
    await ended.port.ensure();
    await render(<ProfileMenu port={ended.port} />);
    expect(container.innerHTML).toBe("");
  });

  it("is in the lobby's account corner and in the shared top bar", () => {
    expect(readStripped("components/Lobby.tsx")).toContain("<ProfileMenu />");
    expect(readStripped("components/TopBar.tsx")).toContain("<ProfileMenu />");
  });

  /* PHASE 3 FINAL: "counts down on this device's clock" (`linkCodeDeadline` / `countdownText`) is removed with link
     codes. */
});

describe("the signed-out notice (LIVE-2E)", () => {
  it("says the account and seats are kept, never says guest, and Continue leads back to the public homepage", async () => {
    const server = fakeServer({ name: "Brad", otherSessions: 0 }, "signed-out-remotely");
    await server.port.ensure();
    expect(server.port.state).toBe("ended");
    await render(<SessionEndedNotice port={server.port} />);
    const text = container.textContent ?? "";
    expect(container.querySelector("#session-ended-title")?.textContent).toBe("You're signed out on this browser");
    expect(text).toContain("It was signed out from another of your devices.");
    expect(text).toContain("Your account and its seats are kept.");
    expect(text).toMatch(/log in again/);
    expect(text).not.toMatch(/recovery key/);
    expect(text).not.toMatch(/guest/i);
    expect(Array.from(container.querySelectorAll("button")).map((button) => button.textContent)).toEqual(["Continue"]);
    await click(buttonNamed("Continue"));
    expect(server.calls[server.calls.length - 1]).toEqual({ path: "/gs/api/session", body: '{"fresh":true}' });
    expect(server.port.state).toBe("unprofiled");
    expect(reloads).toBe(1);
  });

  it("says 'replaced' in its own words", async () => {
    const server = fakeServer({ name: "Brad", otherSessions: 0 }, "replaced");
    await server.port.ensure();
    await render(<SessionEndedNotice port={server.port} />);
    expect(container.textContent).toContain("This browser signed in to an account, which replaced its earlier session.");
  });

  it("PHASE 3 FINAL: says 'retired' in its own words -- an account made before Authorization Wallets; make a new one", async () => {
    const server = fakeServer({ name: "Brad", otherSessions: 0 }, "retired");
    await server.port.ensure();
    await render(<SessionEndedNotice port={server.port} />);
    expect(container.textContent).toContain("It belonged to an account made before Authorization Wallets. That account is retired: create a new account to keep playing.");
    expect(container.textContent).not.toMatch(/recovery key|guest/i);
  });
});
