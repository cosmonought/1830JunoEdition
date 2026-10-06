/** @jest-environment jsdom */
//
// ==================================================================
//  PHASE 3 -- ACCOUNT POLICY / RECOVERY FOLLOW-UP (owner rulings 2026-10-05): THE BROWSER'S SIDE
// ==================================================================
//
// The real Lobby, the real account dialog and the real profile menu over a session port answered by a fake server (the
// same `httpSessionPort` the app installs). What is pinned:
//
//   CREATE ACCOUNT  signed in at once; then ONE screen with the account's recovery key (account-recovery wording, Copy,
//                   "I have saved my recovery key somewhere safe") -- left only by acknowledging it (no Escape, no
//                   scrim, no close button), never asking for the key to be typed back; then the action that asked
//                   for an account resumes. The key is in no storage and gone from the page afterwards.
//   ROUTINE PLAY    a later Log in, Host and Join never ask for the key.
//   FORGOT PASSWORD from Log in: the recovery key + a new password (no username, no email) -> signed in, the action
//                   resumes; a wrong key is one sentence; a short password is refused before anything is sent; a
//                   password account's key typed into the legacy "recovery key" sign-in is sent to "Forgot password?".
//   PROFILE MENU    "Change password" (the current password, or the recovery key, in the request; the other devices
//                   signed out, this one kept); "Make a new recovery key" asks "Confirm it's you" with the PASSWORD and
//                   shows the new key once; a password account has no legacy link-code options.
//   NO GATE         the public site stays public-first: no ProfileGate anywhere.

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { Lobby } from "./Lobby";
import { ModalLayerHost } from "./ModalPortal";
import { AccountPromptHost } from "./AccountDialog";
import { ProfileMenu } from "./ProfileMenu";
import { WalletProvider } from "../context/WalletContext";
import { httpSessionPort, installSessionPort, type SessionPort } from "../utils/sessionBootstrap";
import { resetAccountPromptForTests } from "../utils/accountPrompt";
import { roomLinkRenewals } from "../utils/roomLink";
import { readStripped } from "../utils/sourceScan";
import { PASSWORD_MIN_LENGTH } from "../utils/profileApi";

jest.mock("../config/backend", () => ({ isBackendConfigured: () => true, backendConfigError: () => null }));

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
global.IS_REACT_ACT_ENVIRONMENT = true;

const ENDPOINT = "https://play.example/gs/api/session";
const KEY = "rk_0123456789abcdefghjkmnpqr0.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const NEW_KEY = "rk_abcdefghjkmnpqrstvwxyz0120.BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const ACCOUNT_ME = { ok: true, account: { name: "Ann", otherSessions: 2, username: "Ann", recoveryKey: true, wallet: null, memberSince: Date.UTC(2026, 9, 5) } };

type Answer = { status: number; body?: unknown; then?: () => void; wait?: Promise<void> };

function fakeServer(initial: { name: string; otherSessions: number } | null) {
  let profile = initial;
  const calls: Array<{ path: string; body: string }> = [];
  const queued = new Map<string, Answer[]>();
  const port = httpSessionPort({
    endpoint: ENDPOINT,
    replacedRetryMs: 0,
    fetch: async (input, init) => {
      const path = new URL(input).pathname;
      calls.push({ path, body: init.body });
      if (path === "/gs/api/session") return { status: 200, json: async () => ({ ok: true, expiresAt: 1, profile }) };
      const next = queued.get(path)?.shift();
      if (!next) throw new Error(`nothing queued for ${path}`);
      if (next.wait) await next.wait;
      next.then?.();
      return { status: next.status, json: async () => next.body ?? {} };
    },
  });
  return {
    port,
    calls,
    signIn: (name: string, otherSessions = 0) => {
      profile = { name, otherSessions };
    },
    queue: (path: string, answer: Answer) => queued.set(path, [...(queued.get(path) ?? []), answer]),
    bodiesOf: (path: string) => calls.filter((call) => call.path === path).map((call) => JSON.parse(call.body) as Record<string, unknown>),
  };
}

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  resetAccountPromptForTests();
  window.localStorage.clear();
  window.sessionStorage.clear();
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  installSessionPort(null);
  jest.restoreAllMocks();
});

const settle = async () => {
  await act(async () => {
    for (let n = 0; n < 40; n += 1) await Promise.resolve();
  });
};
const all = () => document.body;
const byTestId = <T extends HTMLElement = HTMLElement>(id: string) => all().querySelector(`[data-testid="${id}"]`) as T | null;
const buttonNamed = (label: string) => Array.from(all().querySelectorAll("button")).find((button) => button.textContent?.trim() === label) as HTMLButtonElement | undefined;
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
const submit = async (form: HTMLElement | null) => {
  expect(form).toBeTruthy();
  act(() => {
    form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  await settle();
};
const storageText = () => JSON.stringify({ ...window.localStorage }) + JSON.stringify({ ...window.sessionStorage });

async function homepage(port: SessionPort) {
  installSessionPort(port);
  act(() =>
    root.render(
      <>
        <WalletProvider>
          <Lobby onEnterSandbox={() => undefined} onWatchSandbox={() => undefined} />
        </WalletProvider>
        <ModalLayerHost />
        <AccountPromptHost />
      </>,
    ),
  );
  await settle();
}

async function createAnn(server: ReturnType<typeof fakeServer>) {
  await click(byTestId("account-tab-create"));
  type(byTestId<HTMLInputElement>("account-username"), "Ann");
  type(byTestId<HTMLInputElement>("account-password"), "a long enough secret");
  type(byTestId<HTMLInputElement>("account-name"), "Ann");
  server.queue("/gs/api/account/create", { status: 201, body: { ok: true, profile: { name: "Ann", otherSessions: 0 }, username: "Ann", recoveryKey: KEY }, then: () => server.signIn("Ann") });
  await submit(byTestId("account-form"));
}

describe("account policy: creating an account shows its recovery key ONCE, then the site", () => {
  it("the reveal: account-recovery wording, Copy, an acknowledgement before leaving, nothing typed back; then the action resumes and the key is gone", async () => {
    const writeText = jest.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const server = fakeServer(null);
    await homepage(server.port);
    const renewals = roomLinkRenewals();
    await click(buttonNamed("Host game"));
    await createAnn(server);
    /* Signed in at once (the sockets move to the new session now), and the reveal is up. */
    expect(server.port.state).toBe("ready");
    expect(roomLinkRenewals()).toBeGreaterThan(renewals);
    expect(byTestId("recovery-key-value")?.textContent).toBe(KEY);
    const purpose = byTestId("recovery-key-purpose")?.textContent ?? "";
    expect(purpose).toContain("Save this recovery key somewhere safe");
    expect(purpose).toContain("If you ever forget your password, it lets you choose a new one");
    expect(purpose).toContain("You don't need it to log in or to play");
    expect(byTestId("recovery-key-reveal")?.textContent).toContain("There is no email reset");
    /* Copy. */
    await click(buttonNamed("Copy"));
    expect(writeText).toHaveBeenCalledWith(KEY);
    /* Nothing asks for the key back: the only input is the acknowledgement. */
    const inputs = Array.from(byTestId("recovery-key-reveal")?.querySelectorAll("input") ?? []);
    expect(inputs.map((input) => input.type)).toEqual(["checkbox"]);
    /* Left only by acknowledging it: no close button, Escape refused, Continue disabled until the box is ticked. */
    expect(all().querySelector('[aria-label="Close"]')).toBeNull();
    expect(byTestId("account-dialog")?.getAttribute("closedby")).toBe("none");
    expect(byTestId<HTMLButtonElement>("recovery-key-continue")?.disabled).toBe(true);
    expect(byTestId("host-body")).toBeNull();
    /* The site is behind it, public-first as ever (the reveal is not a gate around the app). */
    expect(buttonNamed("Host game")).toBeTruthy();
    expect(storageText()).not.toContain(KEY.split(".")[1]);
    await click(byTestId("recovery-key-saved"));
    expect(byTestId<HTMLButtonElement>("recovery-key-continue")?.textContent).toBe("Continue");
    await click(byTestId("recovery-key-continue"));
    expect(byTestId("host-body")).toBeTruthy();
    expect(byTestId("account-dialog")).toBeNull();
    expect(all().innerHTML).not.toContain(KEY);
    expect(storageText()).not.toContain(KEY.split(".")[1]);
  });

  it("review M1: while Create account is on its way the dialog cannot be closed (its answer is the key's one appearance)", async () => {
    const server = fakeServer(null);
    await homepage(server.port);
    await click(byTestId("account-create"));
    await click(byTestId("account-tab-create"));
    type(byTestId<HTMLInputElement>("account-username"), "Ann");
    type(byTestId<HTMLInputElement>("account-password"), "a long enough secret");
    type(byTestId<HTMLInputElement>("account-name"), "Ann");
    let answer: () => void = () => undefined;
    const wait = new Promise<void>((resolve) => (answer = resolve));
    server.queue("/gs/api/account/create", { status: 201, body: { ok: true, profile: { name: "Ann", otherSessions: 0 }, username: "Ann", recoveryKey: KEY }, then: () => server.signIn("Ann"), wait });
    await submit(byTestId("account-form"));
    expect(byTestId("account-dialog")?.getAttribute("closedby")).toBe("none");
    expect((all().querySelector('[aria-label="Close"]') as HTMLButtonElement | null)?.disabled).toBe(true);
    answer();
    await settle();
    expect(byTestId("recovery-key-value")?.textContent).toBe(KEY);
  });

  it("from the homepage's own Create account (nothing to resume): Continue to the site", async () => {
    const server = fakeServer(null);
    await homepage(server.port);
    await click(byTestId("account-create"));
    await createAnn(server);
    expect(byTestId<HTMLButtonElement>("recovery-key-continue")?.textContent).toBe("Continue to the site");
    await click(byTestId("recovery-key-saved"));
    await click(byTestId("recovery-key-continue"));
    expect(byTestId("account-dialog")).toBeNull();
    expect(byTestId("profile-chip")?.textContent).toBe("Ann");
  });

  it("the new-account form says 12 characters, and an 11-character password is refused before anything is sent", async () => {
    const server = fakeServer(null);
    await homepage(server.port);
    await click(byTestId("account-create"));
    await click(byTestId("account-tab-create"));
    expect(all().textContent).toContain(`Password (at least ${PASSWORD_MIN_LENGTH} characters)`);
    expect(PASSWORD_MIN_LENGTH).toBe(12);
    type(byTestId<HTMLInputElement>("account-username"), "Cy");
    type(byTestId<HTMLInputElement>("account-password"), "abcdefghijk");
    type(byTestId<HTMLInputElement>("account-name"), "Cy");
    await submit(byTestId("account-form"));
    expect(byTestId("account-error")?.textContent).toBe("A password is at least 12 characters.");
    expect(server.calls.some((call) => call.path === "/gs/api/account/create")).toBe(false);
  });

  it("no ProfileGate returns: the app renders for everyone, and the reveal lives inside the account dialog", () => {
    expect(readStripped("index.tsx")).not.toContain("ProfileGate");
    expect(readStripped("components/AccountDialog.tsx")).toContain("RecoveryKeyReveal");
  });
});

describe("account policy: routine play never asks for the key", () => {
  it("a later Log in is the username and password only, and the action resumes", async () => {
    const server = fakeServer(null);
    await homepage(server.port);
    await click(buttonNamed("Host game"));
    expect(byTestId("account-forgot")).toBeTruthy();
    expect(all().querySelector('[data-testid="account-dialog"] [data-testid="account-secret"]')).toBeNull();
    type(byTestId<HTMLInputElement>("account-username"), "Ann");
    type(byTestId<HTMLInputElement>("account-password"), "a long enough secret");
    server.queue("/gs/api/account/login", { status: 200, body: { ok: true, profile: { name: "Ann" } }, then: () => server.signIn("Ann") });
    await submit(byTestId("account-form"));
    expect(server.bodiesOf("/gs/api/account/login")).toEqual([{ username: "Ann", password: "a long enough secret" }]);
    expect(byTestId("host-body")).toBeTruthy();
    expect(byTestId("recovery-key-reveal")).toBeNull();
  });

  it("signed in: Host and Join open straight away -- no key, no confirmation", async () => {
    const server = fakeServer({ name: "Ann", otherSessions: 0 });
    await server.port.ensure();
    await homepage(server.port);
    await click(buttonNamed("Host game"));
    expect(byTestId("account-dialog")).toBeNull();
    expect(byTestId("host-body")).toBeTruthy();
    await click(buttonNamed("Join game"));
    expect(byTestId("account-dialog")).toBeNull();
    expect(server.calls.some((call) => /reauth|recover|reset|recovery-key/.test(call.path) || call.body.includes("rk_"))).toBe(false);
  });
});

describe("account policy: Forgot password? (the recovery key, no username, no email)", () => {
  it("the key and a new password sign this browser in, and the action resumes", async () => {
    const server = fakeServer(null);
    await homepage(server.port);
    await click(buttonNamed("Host game"));
    await click(byTestId("account-forgot"));
    expect(byTestId("account-username")).toBeNull();
    expect(byTestId("account-forgot-nokey")?.textContent).toContain("There is no email reset");
    type(byTestId<HTMLInputElement>("account-forgot-key"), ` ${KEY}\n`);
    type(byTestId<HTMLInputElement>("account-forgot-password"), "my brand new passphrase");
    server.queue("/gs/api/account/reset", { status: 200, body: { ok: true, profile: { name: "Ann" }, signedOut: 2 }, then: () => server.signIn("Ann") });
    await submit(byTestId("account-form"));
    expect(server.bodiesOf("/gs/api/account/reset")).toEqual([{ recoveryKey: KEY, newPassword: "my brand new passphrase" }]);
    expect(byTestId("host-body")).toBeTruthy();
    expect(all().innerHTML).not.toContain(KEY);
  });

  it("a wrong key is one sentence and the fields are cleared; a short new password is refused before anything is sent", async () => {
    const server = fakeServer(null);
    await homepage(server.port);
    await click(byTestId("account-login"));
    await click(byTestId("account-forgot"));
    type(byTestId<HTMLInputElement>("account-forgot-key"), KEY);
    type(byTestId<HTMLInputElement>("account-forgot-password"), "short");
    await submit(byTestId("account-form"));
    expect(byTestId("account-error")?.textContent).toBe("A password is at least 12 characters.");
    expect(server.calls.some((call) => call.path === "/gs/api/account/reset")).toBe(false);
    type(byTestId<HTMLInputElement>("account-forgot-key"), KEY);
    type(byTestId<HTMLInputElement>("account-forgot-password"), "my brand new passphrase");
    server.queue("/gs/api/account/reset", { status: 403, body: { error: "invalid-credential" } });
    await submit(byTestId("account-form"));
    expect(byTestId("account-error")?.textContent).toBe("That recovery key doesn't work. Check it and try again — a key you replaced no longer works.");
    expect(byTestId<HTMLInputElement>("account-forgot-key")?.value).toBe("");
    expect(byTestId<HTMLInputElement>("account-forgot-password")?.value).toBe("");
    expect(server.port.state).not.toBe("ready");
  });

  it("a password account's key typed into the legacy recovery-key sign-in is sent to Forgot password? (it recovers, it never signs in)", async () => {
    const server = fakeServer(null);
    await homepage(server.port);
    await click(byTestId("account-login"));
    await click(byTestId("account-other-recovery"));
    type(byTestId<HTMLInputElement>("account-secret"), KEY);
    server.queue("/gs/api/profile/recover", { status: 409, body: { error: "use-password-reset" } });
    await submit(byTestId("account-form"));
    expect(server.port.state).not.toBe("ready");
    expect(byTestId("account-forgot-key")).toBeTruthy();
    expect(byTestId("account-error")?.textContent).toContain("Use “Forgot password?”");
  });
});

/* ==================================================================
    THE PROFILE MENU
   ================================================================== */

async function signedInMenu(otherSessions = 2) {
  const server = fakeServer({ name: "Ann", otherSessions });
  await server.port.ensure();
  server.queue("/gs/api/account/me", { status: 200, body: ACCOUNT_ME });
  installSessionPort(server.port);
  act(() => root.render(<ProfileMenu port={server.port} />));
  await settle();
  await click(byTestId("profile-chip"));
  return server;
}

describe("account policy: the profile menu of a password account", () => {
  it("shows Change password and Make a new recovery key -- and no legacy link-code options", async () => {
    await signedInMenu();
    expect(byTestId("profile-menu-password")?.textContent).toBe("Change password");
    expect(byTestId("profile-menu-rotate")?.textContent).toBe("Make a new recovery key");
    expect(byTestId("profile-menu-key-note")?.textContent).toContain("never need it to log in or play");
    expect(byTestId("profile-menu-older")).toBeNull();
    expect(byTestId("profile-menu-link")).toBeNull();
  });

  it("Change password with the current password: one request carrying both, the other devices signed out, this one kept (fresh session, sockets renewed)", async () => {
    const server = await signedInMenu(2);
    await click(byTestId("profile-menu-password"));
    type(byTestId<HTMLInputElement>("profile-current-secret"), "the old passphrase");
    type(byTestId<HTMLInputElement>("profile-changed-password"), "the new passphrase!");
    server.queue("/gs/api/account/password", { status: 200, body: { ok: true, signedOut: 2 }, then: () => server.signIn("Ann", 0) });
    server.queue("/gs/api/account/me", { status: 200, body: ACCOUNT_ME });
    const renewals = roomLinkRenewals();
    await submit(byTestId("profile-password-form"));
    expect(server.bodiesOf("/gs/api/account/password")).toEqual([{ currentPassword: "the old passphrase", newPassword: "the new passphrase!" }]);
    expect(byTestId("profile-password-done")?.textContent).toBe("Password changed. Signed out 2 other devices. This device stays signed in.");
    expect(roomLinkRenewals()).toBeGreaterThan(renewals);
    expect(server.port.state).toBe("ready");
    expect(server.port.account?.otherSessions).toBe(0);
    expect(all().innerHTML).not.toContain("the new passphrase!");
  });

  it("security review M2 (residual): after a change, the kept verified wallet is shown with 'Forget this wallet'", async () => {
    const withWallet = { ok: true, account: { ...ACCOUNT_ME.account, wallet: { address: "juno1qyqszqgpqyqszqgpqyqszqgpqyqszqgpypz92q", verifiedAt: Date.UTC(2026, 9, 1) } } };
    const server = fakeServer({ name: "Ann", otherSessions: 0 });
    await server.port.ensure();
    server.queue("/gs/api/account/me", { status: 200, body: withWallet });
    installSessionPort(server.port);
    act(() => root.render(<ProfileMenu port={server.port} />));
    await settle();
    await click(byTestId("profile-chip"));
    await click(byTestId("profile-menu-password"));
    type(byTestId<HTMLInputElement>("profile-current-secret"), "the old passphrase");
    type(byTestId<HTMLInputElement>("profile-changed-password"), "the new passphrase!");
    server.queue("/gs/api/account/password", { status: 200, body: { ok: true, signedOut: 0 } });
    server.queue("/gs/api/account/me", { status: 200, body: withWallet });
    await submit(byTestId("profile-password-form"));
    expect(byTestId("profile-password-wallet")?.textContent).toContain("Not yours?");
    await click(byTestId("profile-password-forget-wallet"));
    expect(byTestId("profile-forget-wallet-summary")).toBeTruthy();
  });

  it("Change password with the recovery key instead (a forgotten current password)", async () => {
    const server = await signedInMenu();
    await click(byTestId("profile-menu-password"));
    await click(byTestId("profile-password-use-key"));
    type(byTestId<HTMLInputElement>("profile-current-secret"), `${KEY}\n`);
    type(byTestId<HTMLInputElement>("profile-changed-password"), "the new passphrase!");
    server.queue("/gs/api/account/password", { status: 200, body: { ok: true, signedOut: 0 }, then: () => server.signIn("Ann", 0) });
    server.queue("/gs/api/account/me", { status: 200, body: ACCOUNT_ME });
    await submit(byTestId("profile-password-form"));
    expect(server.bodiesOf("/gs/api/account/password")).toEqual([{ recoveryKey: KEY, newPassword: "the new passphrase!" }]);
    expect(byTestId("profile-password-done")).toBeTruthy();
  });

  it("a wrong current password is one sentence, both fields cleared, nothing changed; a short new one is refused before anything is sent", async () => {
    const server = await signedInMenu();
    await click(byTestId("profile-menu-password"));
    type(byTestId<HTMLInputElement>("profile-current-secret"), "wrong passphrase");
    type(byTestId<HTMLInputElement>("profile-changed-password"), "short");
    await submit(byTestId("profile-password-form"));
    expect(all().querySelector('[role="alert"]')?.textContent).toBe("A password is at least 12 characters.");
    expect(server.calls.some((call) => call.path === "/gs/api/account/password")).toBe(false);
    type(byTestId<HTMLInputElement>("profile-current-secret"), "wrong passphrase");
    type(byTestId<HTMLInputElement>("profile-changed-password"), "the new passphrase!");
    server.queue("/gs/api/account/password", { status: 403, body: { error: "invalid-credential" } });
    await submit(byTestId("profile-password-form"));
    expect(all().querySelector('[role="alert"]')?.textContent).toBe("That current password or recovery key doesn't match this account. Check it and try again.");
    expect(byTestId<HTMLInputElement>("profile-current-secret")?.value).toBe("");
    expect(byTestId<HTMLInputElement>("profile-changed-password")?.value).toBe("");
  });

  it("Make a new recovery key: Confirm it's you with the PASSWORD (never the key), then the new key once with account-recovery wording", async () => {
    const server = await signedInMenu();
    await click(byTestId("profile-menu-rotate"));
    expect(all().textContent).toContain("You'll confirm with your password first.");
    server.queue("/gs/api/profile/recovery-key", { status: 403, body: { error: "reauth-required" } });
    await click(byTestId("profile-rotate-confirm"));
    expect(all().textContent).toContain("To make a new recovery key, enter your password.");
    expect(byTestId("profile-reauth-switch")).toBeNull();
    type(byTestId<HTMLInputElement>("profile-reauth-key"), "the passphrase");
    server.queue("/gs/api/profile/reauth", { status: 200, body: { ok: true, expiresAt: 1 } });
    server.queue("/gs/api/profile/recovery-key", { status: 200, body: { ok: true, recoveryKey: NEW_KEY } });
    await click(byTestId("profile-reauth-confirm"));
    expect(server.bodiesOf("/gs/api/profile/reauth")).toEqual([{ password: "the passphrase" }]);
    expect(byTestId("recovery-key-value")?.textContent).toBe(NEW_KEY);
    expect(all().textContent).toContain("Your old recovery key no longer works.");
    expect(byTestId("recovery-key-purpose")?.textContent).toContain("If you ever forget your password");
    await click(byTestId("recovery-key-saved"));
    await click(byTestId("recovery-key-continue"));
    expect(all().innerHTML).not.toContain(NEW_KEY);
  });
});
