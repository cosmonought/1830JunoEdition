/** @jest-environment jsdom */
//
// LIVE-2E / P3-ACCT: THE ACCOUNT CORNER AND THE SIGNED-OUT NOTICE. Signed out, the corner offers Log in and Create
// account. Signed in, the chip names the account; its menu shows (under "Older sign-in options", for a profile made
// before accounts) a device-link code large with a live countdown and the recovery-key rotation (asked first, the new
// key revealed once); it says how many other devices are signed in before signing them out and how many were, and asks
// before signing this device out -- then reloads to the public homepage. A development build offers no credential
// actions. The signed-out notice says nothing of guests: the account and its seats are kept.

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { ProfileMenu, countdownText, linkCodeDeadline } from "./ProfileMenu";
import { LINK_CODE_HOW } from "./AccountDialog";
import { SessionEndedNotice } from "./SessionEndedNotice";
import { httpSessionPort, readySessionPort } from "../utils/sessionBootstrap";
import { readStripped } from "../utils/sourceScan";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
global.IS_REACT_ACT_ENVIRONMENT = true;

const ENDPOINT = "https://play.example/gs/api/session";
const KEY = "rk_0123456789abcdefghjkmnpqr0.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const CODE = "ABCD-EFGH-JKMN-PQRS-TVWX";

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

async function profiled(otherSessions = 2): Promise<ReturnType<typeof fakeServer>> {
  const server = fakeServer({ name: "Brad", otherSessions });
  await server.port.ensure();
  return server;
}

describe("the profile menu (LIVE-2E)", () => {
  it("names the profile, and 'Link another device' shows a code large, with Copy and a live countdown", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-09-26T12:00:00Z"));
    const server = await profiled();
    await render(<ProfileMenu port={server.port} />);
    expect(byTestId("profile-chip")?.textContent).toBe("Brad");
    await click(byTestId("profile-chip"));
    const now = Date.now();
    server.queue("/gs/api/profile/link-code", 201, { ok: true, code: CODE, expiresAt: now + 10 * 60 * 1000 });
    await click(buttonNamed("Link another device"));
    expect(byTestId("link-code-value")?.textContent).toBe(CODE);
    /* Review L9: the directions name the sign-in dialog's own controls (the old "Link existing profile" is gone). */
    expect(container.textContent).toContain("“Made a profile before accounts? Other ways to sign in” → “Code from a signed-in device”");
    expect(container.textContent).not.toContain("Link existing profile");
    expect(container.textContent).toContain("It works once, for 10 minutes.");
    expect(buttonNamed("Copy")).toBeTruthy();
    expect(byTestId("link-code-countdown")?.textContent).toBe("Expires in 10:00");
    act(() => {
      jest.advanceTimersByTime(61_000);
    });
    expect(byTestId("link-code-countdown")?.textContent).toBe("Expires in 8:59");
    act(() => {
      jest.advanceTimersByTime(9 * 60 * 1000);
    });
    expect(byTestId("link-code-value")).toBeNull();
    expect(container.textContent).toContain("This code has expired.");
    /* Closing the menu drops the code. */
    await click(buttonNamed("Close"));
    expect(container.innerHTML).not.toContain(CODE);
  });

  it("'Rotate recovery key' asks first, then shows the new key once", async () => {
    const server = await profiled();
    await render(<ProfileMenu port={server.port} />);
    await click(byTestId("profile-chip"));
    await click(buttonNamed("Rotate recovery key"));
    expect(container.textContent).toContain("Your current recovery key stops working immediately.");
    expect(server.calls.some((call) => call.path === "/gs/api/profile/recovery-key")).toBe(false);
    server.queue("/gs/api/profile/recovery-key", 200, { ok: true, recoveryKey: KEY });
    await click(buttonNamed("Make a new recovery key"));
    expect(byTestId("recovery-key-value")?.textContent).toBe(KEY);
    expect(container.textContent).toContain("Your old recovery key no longer works.");
    const done = byTestId<HTMLButtonElement>("recovery-key-continue")!;
    expect(done.textContent).toBe("Done");
    expect(done.disabled).toBe(true);
    await click(byTestId("recovery-key-saved"));
    await click(byTestId("recovery-key-continue"));
    expect(container.innerHTML).not.toContain(KEY);
    expect(byTestId("profile-menu-panel")).toBeNull();
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
    expect(container.textContent).toContain("Your account and its seats are kept.");
    expect(container.textContent).toContain("log in again");
    expect(container.textContent).not.toContain("recovery key");
    expect(reloads).toBe(0);
    server.queue("/gs/api/session/revoke", 204);
    await click(byTestId("profile-signout-confirm"));
    expect(server.calls.map((call) => call.path)).toContain("/gs/api/session/revoke");
    expect(reloads).toBe(1);
  });

  it("ESCROW-3A: a rotation the server holds for re-authentication asks 'Confirm it's you', then rotates at once", async () => {
    const server = await profiled();
    const OLD = "rk_0123456789abcdefghjkmnpqr0.BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
    await render(<ProfileMenu port={server.port} />);
    await click(byTestId("profile-chip"));
    await click(buttonNamed("Rotate recovery key"));
    server.queue("/gs/api/profile/recovery-key", 403, { error: "reauth-required" });
    await click(buttonNamed("Make a new recovery key"));
    expect(container.textContent).toContain("Confirm it’s you");
    expect(container.textContent).toContain("To make a new recovery key, paste your current recovery key.");
    const input = byTestId<HTMLInputElement>("profile-reauth-key");
    expect(input?.type).toBe("password");
    expect(byTestId<HTMLButtonElement>("profile-reauth-confirm")?.disabled).toBe(true);
    /* A wrong key: one sentence, the typed key is dropped, and nothing rotates. */
    server.queue("/gs/api/profile/reauth", 403, { error: "invalid-credential" });
    type(input, "rk_wrong");
    await click(byTestId("profile-reauth-confirm"));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("That recovery key doesn't work for this profile. Check it and try again.");
    expect(byTestId<HTMLInputElement>("profile-reauth-key")?.value).toBe("");
    /* The right key: re-authenticated, and the rotation the player chose runs again -- the new key is shown once. */
    server.queue("/gs/api/profile/reauth", 200, { ok: true, expiresAt: 1 });
    server.queue("/gs/api/profile/recovery-key", 200, { ok: true, recoveryKey: KEY });
    type(byTestId<HTMLInputElement>("profile-reauth-key"), ` ${OLD}\n`);
    await click(byTestId("profile-reauth-confirm"));
    expect(byTestId("recovery-key-value")?.textContent).toBe(KEY);
    expect(container.innerHTML).not.toContain(OLD);
    expect(server.calls.filter((call) => call.path === "/gs/api/profile/reauth").map((call) => JSON.parse(call.body))).toEqual([
      { recoveryKey: "rk_wrong" },
      { recoveryKey: OLD },
    ]);
    expect(server.calls.map((call) => call.path).filter((path) => path !== "/gs/api/session" && path !== "/gs/api/account/me" && path !== "/gs/api/trust/me")).toEqual([
      "/gs/api/profile/recovery-key",
      "/gs/api/profile/reauth",
      "/gs/api/profile/reauth",
      "/gs/api/profile/recovery-key",
    ]);
  });

  it("ESCROW-3A / P3-ACCT: 'Sign out other devices' held for re-authentication asks a LEGACY profile for its key, then signs them out", async () => {
    const server = await profiled(1);
    /* The menu reads the account (a profile made before accounts: no username) -- and so does "Confirm it's you". */
    const legacy = { ok: true, account: { name: "Brad", otherSessions: 1, username: null, recoveryKey: true, wallet: null, memberSince: Date.UTC(2026, 0, 2) } };
    server.queue("/gs/api/account/me", 200, legacy);
    await render(<ProfileMenu port={server.port} />);
    await click(byTestId("profile-chip"));
    await click(buttonNamed("Sign out other devices"));
    server.queue("/gs/api/profile/sign-out-others", 403, { error: "reauth-required" });
    server.queue("/gs/api/account/me", 200, legacy);
    await click(byTestId("profile-others-confirm"));
    expect(container.textContent).toContain("To sign out your other devices, paste your current recovery key.");
    server.queue("/gs/api/profile/reauth", 200, { ok: true, expiresAt: 1 });
    server.queue("/gs/api/profile/sign-out-others", 200, { ok: true, signedOut: 1 }, () => server.setProfile({ name: "Brad", otherSessions: 0 }));
    type(byTestId<HTMLInputElement>("profile-reauth-key"), KEY);
    await click(byTestId("profile-reauth-confirm"));
    expect(byTestId("profile-others-done")?.textContent).toBe("Signed out 1 other device.");
    expect(container.innerHTML).not.toContain(KEY);
    expect(server.calls.filter((call) => call.path === "/gs/api/profile/reauth").map((call) => JSON.parse(call.body))).toEqual([{ recoveryKey: KEY }]);
  });

  it("P3-ACCT: a username/password account confirms with its PASSWORD (sent once, never kept), and shows no recovery-key ceremony", async () => {
    const server = await profiled(1);
    const account = { ok: true, account: { name: "Brad", otherSessions: 1, username: "Brad.Player", recoveryKey: false, wallet: { address: "juno1qyqszqgpqyqszqgpqyqszqgpqyqszqgpypz92q", verifiedAt: Date.UTC(2026, 9, 1) }, memberSince: Date.UTC(2026, 9, 1) } };
    server.queue("/gs/api/account/me", 200, account);
    await render(<ProfileMenu port={server.port} />);
    await click(byTestId("profile-chip"));
    expect(byTestId("profile-menu-account")?.textContent).toBe("Username Brad.Player · Member since 2026-10-01");
    expect(byTestId("profile-menu-wallet")?.textContent).toContain("juno1qyqsz…z92q · verified 2026-10-01");
    expect(byTestId("profile-menu-wallet")?.textContent).toContain("never your password");
    /* No recovery key: no "Older sign-in options", no key rotation, no link code. */
    expect(byTestId("profile-menu-older")).toBeNull();
    expect(buttonNamed("Rotate recovery key")).toBeUndefined();
    await click(buttonNamed("Sign out other devices"));
    server.queue("/gs/api/profile/sign-out-others", 403, { error: "reauth-required" });
    server.queue("/gs/api/account/me", 200, account);
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

  it("P3-ACCT: a legacy profile sets a username and password -- its recovery key confirms it -- and is not orphaned", async () => {
    const server = await profiled(0);
    const legacy = { ok: true, account: { name: "Brad", otherSessions: 0, username: null, recoveryKey: true, wallet: null, memberSince: Date.UTC(2026, 0, 2) } };
    server.queue("/gs/api/account/me", 200, legacy);
    await render(<ProfileMenu port={server.port} />);
    await click(byTestId("profile-chip"));
    expect(byTestId("profile-menu-older")).toBeTruthy(); // its recovery key and link code stay reachable
    /* Review L9: the sign-in dialog's directions name exactly what this menu shows. */
    expect(byTestId("profile-menu-older")?.querySelector("summary")?.textContent).toBe("Older sign-in options");
    expect(byTestId("profile-menu-link")?.textContent).toBe("Link another device");
    expect(LINK_CODE_HOW).toContain("“Older sign-in options” → “Link another device”");
    await click(byTestId("profile-menu-credentials"));
    type(byTestId<HTMLInputElement>("profile-new-username"), "Brad.Player");
    type(byTestId<HTMLInputElement>("profile-new-password"), "a long new password");
    server.queue("/gs/api/account/credentials", 403, { error: "reauth-required" });
    await click(byTestId("profile-credentials-save"));
    expect(container.textContent).toContain("To set a username and password, paste your current recovery key.");
    server.queue("/gs/api/profile/reauth", 200, { ok: true, expiresAt: 1 });
    server.queue("/gs/api/account/credentials", 200, { ok: true, username: "Brad.Player" });
    type(byTestId<HTMLInputElement>("profile-reauth-key"), KEY);
    await click(byTestId("profile-reauth-confirm"));
    expect(byTestId("profile-credentials-done")?.textContent).toContain("Log in as Brad.Player");
    const sent = server.calls.filter((call) => call.path === "/gs/api/account/credentials").map((call) => JSON.parse(call.body));
    expect(sent).toEqual([
      { username: "Brad.Player", password: "a long new password" },
      { username: "Brad.Player", password: "a long new password" },
    ]);
    expect(container.innerHTML).not.toContain("a long new password");
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

  it("counts down on this device's clock, whatever the server's clock says", () => {
    expect(linkCodeDeadline(1_000 + 600_000, 1_000)).toBe(601_000);
    expect(linkCodeDeadline(1_000 + 590_000, 1_000)).toBe(591_000);
    expect(linkCodeDeadline(1_000 - 5_000, 1_000)).toBe(601_000); // server behind: never starts expired
    expect(linkCodeDeadline(1_000 + 3_600_000, 1_000)).toBe(601_000); // server ahead: never longer than the lifetime
    expect(countdownText(600_000)).toBe("10:00");
    expect(countdownText(59_001)).toBe("1:00");
    expect(countdownText(0)).toBe("0:00");
  });
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
});
