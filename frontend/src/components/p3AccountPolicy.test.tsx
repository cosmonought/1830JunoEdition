/** @jest-environment jsdom */
//
// ==================================================================
//  PHASE 3 -- ACCOUNT POLICY (owner rulings 2026-10-05, as superseded by PHASE 3 FINAL 2026-10-06): THE BROWSER'S SIDE
// ==================================================================
//
// The real Lobby, the real account dialog and the real profile menu over a session port answered by a fake server (the
// same `httpSessionPort` the app installs), with Keplr played by the money test support's fake wallet. What is pinned:
//
//   CREATE ACCOUNT  username + password (12+) + display name + the AUTHORIZATION WALLET: Keplr connects on an explicit
//                   press, and that wallet signs the CREATE text the server minted for this browser and this username.
//                   Signed in at once, and the action that asked for an account resumes. PHASE 3 FINAL: NO recovery
//                   key is issued, shown, acknowledged or kept -- the reveal screen of the 2026-10-05 policy is gone.
//   ROUTINE PLAY    a later Log in is the username and password only (Keplr is never asked); Host and Join never ask
//                   for any key.
//   FORGOT PASSWORD from Log in: the username + the account's Authorization Wallet (Keplr signs a RECOVER text) + a new
//                   password -> signed in, the action resumes; a refusal is one sentence that names nothing; a short
//                   password is refused before anything is signed or sent; a RECOVER text for another account is
//                   refused before Keplr signs it.
//   PROFILE MENU    "Change password" (the CURRENT password, in the request; the other devices signed out, this one
//                   kept); "Change Authorization Wallet" asks "Confirm it's you" with the PASSWORD; no recovery key, no
//                   link code, no "Forget this wallet".
//   NO GATE         the public site stays public-first: no ProfileGate anywhere.

import fs from "fs";
import path from "path";

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
import { profileAuthorizationText, type ProfileAuthorizationFields, type ProfileAuthorizationPurpose } from "../utils/profileAuthorizationV1";
import { installMoneyServicesForTests } from "../money/moneySession";
import { T0, TEST_WALLET, testServices, type FakeWallet } from "../money/moneyTestSupport";
import { APP_NAME } from "../config";

jest.mock("../config/backend", () => ({ isBackendConfigured: () => true, backendConfigError: () => null }));

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
global.IS_REACT_ACT_ENVIRONMENT = true;

const ENDPOINT = "https://play.example/gs/api/session";
const OPERATION = "0123456789abcdef0123456789abcdef";
const NONCE = "fedcba9876543210fedcba9876543210";
const PASSWORD = "a long enough secret";
const ACCOUNT_ME = {
  ok: true,
  account: { name: "Ann", otherSessions: 2, username: "Ann", authorizationWallet: { address: TEST_WALLET, since: Date.UTC(2026, 9, 5) }, memberSince: Date.UTC(2026, 9, 5) },
};

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

/** The text the server mints for one account action (`profileAuthorizationV1.ts`), naming this page's own site. */
function authorizationText(purpose: ProfileAuthorizationPurpose, over: Partial<ProfileAuthorizationFields> = {}): string {
  const wallet = over.authorizationWallet ?? TEST_WALLET;
  return profileAuthorizationText({
    appName: APP_NAME,
    purpose,
    site: window.location.origin,
    account: "Ann",
    authorizationWallet: wallet,
    replaces: null,
    signer: wallet,
    operation: OPERATION,
    nonce: NONCE,
    expiresAt: T0 + 300_000,
    ...over,
  });
}

/** The mint route's answer for one text. */
const minted = (purpose: ProfileAuthorizationPurpose, over: Partial<ProfileAuthorizationFields> = {}): Answer => ({
  status: 200,
  body: { ok: true, operation: OPERATION, texts: [{ purpose, signer: over.signer ?? TEST_WALLET, text: authorizationText(purpose, over) }], expiresAt: T0 + 300_000 },
});

let container: HTMLDivElement;
let root: Root;
let wallet: FakeWallet;
/** Every text Keplr was asked to sign, whole. */
let signedTexts: string[];
beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  resetAccountPromptForTests();
  window.localStorage.clear();
  window.sessionStorage.clear();
  const services = testServices();
  wallet = services.wallet;
  signedTexts = [];
  const sign = wallet.signLink.bind(wallet);
  wallet.signLink = async (pin, signer, text) => {
    signedTexts.push(text);
    return sign(pin, signer, text);
  };
  installMoneyServicesForTests(services);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  installSessionPort(null);
  installMoneyServicesForTests(null);
  jest.restoreAllMocks();
});

/** Microtasks and a few macrotasks: a create runs Keplr, the mint, the signature and the create in one press. */
const settle = async () => {
  await act(async () => {
    for (let round = 0; round < 3; round += 1) {
      for (let n = 0; n < 40; n += 1) await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
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
const signLinks = () => wallet.calls.filter((call) => call.startsWith("signLink"));

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

/** The create form filled in, Keplr connected on the Authorization Wallet step, the server's answers queued. */
async function fillCreate(server: ReturnType<typeof fakeServer>, create: Answer = { status: 201, body: { ok: true, profile: { name: "Ann", otherSessions: 0 }, username: "Ann" }, then: () => server.signIn("Ann") }) {
  await click(byTestId("account-tab-create"));
  type(byTestId<HTMLInputElement>("account-username"), "Ann");
  type(byTestId<HTMLInputElement>("account-password"), PASSWORD);
  type(byTestId<HTMLInputElement>("account-name"), "Ann");
  await click(byTestId("account-wallet-connect"));
  server.queue("/gs/api/account/authorization", minted("CREATE"));
  server.queue("/gs/api/account/create", create);
}

describe("account policy (PHASE 3 FINAL): creating an account designates its Authorization Wallet -- and shows no recovery key", () => {
  it("one signed request: signed in at once, the sockets renewed, the action resumes -- no key shown, acknowledged or kept", async () => {
    const server = fakeServer(null);
    await homepage(server.port);
    const renewals = roomLinkRenewals();
    await click(buttonNamed("Host game"));
    await fillCreate(server);
    expect(byTestId("account-wallet-address")?.textContent).toBe("Will be designated: juno12gdms…dl783a");
    await submit(byTestId("account-form"));
    /* The CREATE text was the one Keplr signed, with the wallet shown, after the mint and before the create. */
    expect(signedTexts).toEqual([authorizationText("CREATE")]);
    expect(signLinks()).toEqual([`signLink:${TEST_WALLET}:18COSMOS/PROFILE-AUTHORIZATION/v1`]);
    expect(server.bodiesOf("/gs/api/account/authorization")).toEqual([{ purpose: "create", username: "Ann", wallet: TEST_WALLET }]);
    expect(server.bodiesOf("/gs/api/account/create")).toEqual([{ username: "Ann", password: PASSWORD, name: "Ann", operation: OPERATION, pubKey: "Ai1R5vzeZFvF73ROli+IbV7OuNG7bM6HeI0rthBGJzvf", signature: "c2ln" }]);
    /* Signed in at once (the sockets move to the new session), and the action that asked resumed -- no reveal between. */
    expect(server.port.state).toBe("ready");
    expect(roomLinkRenewals()).toBeGreaterThan(renewals);
    expect(byTestId("account-dialog")).toBeNull();
    expect(byTestId("host-body")).toBeTruthy();
    for (const gone of ["recovery-key-reveal", "recovery-key-value", "recovery-key-saved", "recovery-key-continue"]) expect([gone, byTestId(gone)]).toEqual([gone, null]);
    expect(all().textContent).not.toMatch(/recovery key/i);
    expect(all().innerHTML).not.toContain(PASSWORD);
    expect(storageText()).not.toContain(PASSWORD);
  });

  it("review M1: while Create account is on its way the dialog cannot be closed (its answer signs this browser in)", async () => {
    const server = fakeServer(null);
    await homepage(server.port);
    await click(byTestId("account-create"));
    let answer: () => void = () => undefined;
    const wait = new Promise<void>((resolve) => (answer = resolve));
    await fillCreate(server, { status: 201, body: { ok: true, profile: { name: "Ann", otherSessions: 0 }, username: "Ann" }, then: () => server.signIn("Ann"), wait });
    await submit(byTestId("account-form"));
    expect(byTestId("account-submit")?.textContent).toBe("Creating…");
    expect(byTestId("account-dialog")?.getAttribute("closedby")).toBe("none");
    expect((all().querySelector('[aria-label="Close"]') as HTMLButtonElement | null)?.disabled).toBe(true);
    answer();
    await settle();
    expect(server.port.state).toBe("ready");
    expect(byTestId("account-dialog")).toBeNull();
  });

  it("from the homepage's own Create account (nothing to resume): the dialog closes and the corner names the account", async () => {
    const server = fakeServer(null);
    await homepage(server.port);
    await click(byTestId("account-create"));
    await fillCreate(server);
    await submit(byTestId("account-form"));
    expect(byTestId("account-dialog")).toBeNull();
    expect(byTestId("profile-chip")?.textContent).toBe("Ann");
    expect(byTestId("host-body")).toBeNull();
  });

  it("the new-account form says 12 characters, and an 11-character password is refused before Keplr or the server is asked", async () => {
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
    expect(server.calls.some((call) => call.path === "/gs/api/account/create" || call.path === "/gs/api/account/authorization")).toBe(false);
    expect(wallet.calls).toEqual([]);
  });

  it("no ProfileGate returns, and the recovery-key reveal is gone from the tree (PHASE 3 FINAL)", () => {
    expect(readStripped("index.tsx")).not.toContain("ProfileGate");
    expect(readStripped("components/AccountDialog.tsx")).not.toContain("RecoveryKeyReveal");
    expect(readStripped("components/ProfileMenu.tsx")).not.toContain("RecoveryKeyReveal");
    expect(fs.existsSync(path.join(__dirname, "RecoveryKeyReveal.tsx"))).toBe(false);
  });
});

describe("account policy: routine play never asks for a wallet or a key", () => {
  it("a later Log in is the username and password only -- Keplr is never asked -- and the action resumes", async () => {
    const server = fakeServer(null);
    await homepage(server.port);
    await click(buttonNamed("Host game"));
    expect(byTestId("account-forgot")).toBeTruthy();
    expect(all().querySelector('[data-testid="account-dialog"] [data-testid="account-secret"]')).toBeNull();
    expect(byTestId("account-wallet-step")).toBeNull(); // the wallet step is Create account's alone
    type(byTestId<HTMLInputElement>("account-username"), "Ann");
    type(byTestId<HTMLInputElement>("account-password"), PASSWORD);
    server.queue("/gs/api/account/login", { status: 200, body: { ok: true, profile: { name: "Ann" } }, then: () => server.signIn("Ann") });
    await submit(byTestId("account-form"));
    expect(server.bodiesOf("/gs/api/account/login")).toEqual([{ username: "Ann", password: PASSWORD }]);
    expect(byTestId("host-body")).toBeTruthy();
    expect(wallet.calls).toEqual([]);
    expect(server.calls.some((call) => call.path === "/gs/api/account/authorization")).toBe(false);
  });

  it("signed in: Host and Join open straight away -- no key, no wallet, no confirmation", async () => {
    const server = fakeServer({ name: "Ann", otherSessions: 0 });
    await server.port.ensure();
    await homepage(server.port);
    await click(buttonNamed("Host game"));
    expect(byTestId("account-dialog")).toBeNull();
    expect(byTestId("host-body")).toBeTruthy();
    await click(buttonNamed("Join game"));
    expect(byTestId("account-dialog")).toBeNull();
    expect(server.calls.some((call) => /reauth|recover|reset|recovery-key|authorization/.test(call.path) || call.body.includes("rk_"))).toBe(false);
    expect(wallet.calls).toEqual([]);
  });
});

describe("account policy (PHASE 3 FINAL): Forgot password? -- the username and the Authorization Wallet, no email, no key", () => {
  async function openForgot(server: ReturnType<typeof fakeServer>, via: "host" | "login") {
    await homepage(server.port);
    await click(via === "host" ? buttonNamed("Host game") : byTestId("account-login"));
    await click(byTestId("account-forgot"));
  }

  it("the username, Keplr on the Authorization Wallet signing RECOVER, and a new password sign this browser in -- and the action resumes", async () => {
    const server = fakeServer(null);
    await openForgot(server, "host");
    expect(byTestId("account-username")).toBeNull();
    expect(byTestId("account-forgot-username")).toBeTruthy();
    expect(byTestId("account-forgot-explain")?.textContent).toContain("a wallet you only used for games can't recover it");
    expect(byTestId("account-forgot-nowallet")?.textContent).toBe(
      "There is no email reset and no recovery key: without your password and your Authorization Wallet, the account can't be recovered.",
    );
    type(byTestId<HTMLInputElement>("account-forgot-username"), "Ann");
    await click(byTestId("account-forgot-connect"));
    expect(byTestId("account-forgot-address")?.textContent).toBe("Keplr is on: juno12gdms…dl783a");
    type(byTestId<HTMLInputElement>("account-forgot-password"), "my brand new passphrase");
    server.queue("/gs/api/account/authorization", minted("RECOVER"));
    server.queue("/gs/api/account/recover", { status: 200, body: { ok: true, profile: { name: "Ann" }, signedOut: 2 }, then: () => server.signIn("Ann") });
    await submit(byTestId("account-form"));
    expect(server.bodiesOf("/gs/api/account/authorization")).toEqual([{ purpose: "recover", username: "Ann", wallet: TEST_WALLET }]);
    expect(signedTexts).toEqual([authorizationText("RECOVER")]);
    expect(server.bodiesOf("/gs/api/account/recover")).toEqual([{ operation: OPERATION, pubKey: "Ai1R5vzeZFvF73ROli+IbV7OuNG7bM6HeI0rthBGJzvf", signature: "c2ln", newPassword: "my brand new passphrase" }]);
    expect(server.port.state).toBe("ready");
    expect(byTestId("host-body")).toBeTruthy();
    expect(all().innerHTML).not.toContain("my brand new passphrase");
  });

  it("a refusal is one sentence that names nothing, and the new password is cleared; a short new password is refused before Keplr or the server is asked", async () => {
    const server = fakeServer(null);
    await openForgot(server, "login");
    type(byTestId<HTMLInputElement>("account-forgot-username"), "Ann");
    type(byTestId<HTMLInputElement>("account-forgot-password"), "short");
    await submit(byTestId("account-form"));
    expect(byTestId("account-error")?.textContent).toBe("A password is at least 12 characters.");
    expect(server.calls.some((call) => call.path === "/gs/api/account/recover" || call.path === "/gs/api/account/authorization")).toBe(false);
    expect(wallet.calls).toEqual([]);
    await click(byTestId("account-forgot-connect"));
    type(byTestId<HTMLInputElement>("account-forgot-password"), "my brand new passphrase");
    server.queue("/gs/api/account/authorization", minted("RECOVER"));
    server.queue("/gs/api/account/recover", { status: 403, body: { error: "invalid-credential" } });
    await submit(byTestId("account-form"));
    expect(byTestId("account-error")?.textContent).toBe(
      "That didn't recover an account. Check the username, and that Keplr is on the account's Authorization Wallet — a wallet you only used for games can't recover it.",
    );
    expect(byTestId<HTMLInputElement>("account-forgot-password")?.value).toBe("");
    expect(server.port.state).not.toBe("ready");
  });

  it("a RECOVER text naming another account is refused BEFORE Keplr signs it: nothing is signed, nothing recovered", async () => {
    const server = fakeServer(null);
    await openForgot(server, "login");
    type(byTestId<HTMLInputElement>("account-forgot-username"), "Ann");
    await click(byTestId("account-forgot-connect"));
    type(byTestId<HTMLInputElement>("account-forgot-password"), "my brand new passphrase");
    server.queue("/gs/api/account/authorization", minted("RECOVER", { account: "Mallory" }));
    await submit(byTestId("account-form"));
    expect(byTestId("account-error")?.textContent).toBe("The authorization message names another account, so nothing was signed.");
    expect(signLinks()).toEqual([]);
    expect(server.calls.some((call) => call.path === "/gs/api/account/recover")).toBe(false);
    expect(server.port.state).not.toBe("ready");
  });

  /* PHASE 3 FINAL: "a password account's key typed into the legacy recovery-key sign-in is sent to Forgot password?" is
     removed -- there is no recovery-key sign-in (no "Other ways", no `account-secret` field) and no recovery key. */
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

describe("account policy: the profile menu of an account", () => {
  it("shows Change password and the Authorization Wallet -- and no recovery key, link code or 'Forget this wallet'", async () => {
    await signedInMenu();
    expect(byTestId("profile-menu-password")?.textContent).toBe("Change password");
    expect(byTestId("profile-menu-authorization-wallet")?.textContent).toBe("juno12gdms…dl783a · since 2026-10-05");
    expect(byTestId("profile-menu-replace-wallet")?.textContent).toBe("Change Authorization Wallet");
    for (const gone of ["profile-menu-rotate", "profile-menu-key-note", "profile-menu-older", "profile-menu-link", "profile-menu-wallet", "profile-menu-forget-wallet"]) {
      expect([gone, byTestId(gone)]).toEqual([gone, null]);
    }
    expect(all().textContent).not.toMatch(/recovery key|link another device|forget this wallet/i);
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

  /* PHASE 3 FINAL: "security review M2 (residual): after a change, the kept verified wallet is shown with 'Forget this
     wallet'" is removed -- the profile remembers no wallet (`account/forget-wallet` is retired, 410), so a password
     change has no wallet to show. "Change password with the recovery key instead" is removed with the recovery key;
     a forgotten current password is "Forgot password?" by the Authorization Wallet, which the form says: */
  it("a forgotten current password: the form points to 'Forgot password?' with the Authorization Wallet -- no key option", async () => {
    await signedInMenu();
    await click(byTestId("profile-menu-password"));
    expect(byTestId("profile-password-use-key")).toBeNull();
    expect(byTestId("profile-password-forgot-note")?.textContent).toBe("Forgot your current password? Sign out, then use “Forgot password?” with your Authorization Wallet.");
    expect(byTestId("profile-password-form")?.querySelectorAll("input")).toHaveLength(2);
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
    expect(all().querySelector('[role="alert"]')?.textContent).toBe("That current password doesn't match this account. Check it and try again.");
    expect(byTestId<HTMLInputElement>("profile-current-secret")?.value).toBe("");
    expect(byTestId<HTMLInputElement>("profile-changed-password")?.value).toBe("");
    expect(server.port.account?.otherSessions).toBe(2);
  });

  /* PHASE 3 FINAL: "Make a new recovery key: Confirm it's you with the PASSWORD, then the new key once" is replaced by
     the one credential action that now asks "Confirm it's you" every time: */
  it("Change Authorization Wallet: Confirm it's you with the PASSWORD (no other way offered), then the first step -- nothing minted before", async () => {
    const server = await signedInMenu();
    await click(byTestId("profile-menu-replace-wallet"));
    expect(all().textContent).toContain("To change your Authorization Wallet, enter your password.");
    expect(byTestId("profile-reauth-switch")).toBeNull();
    expect(byTestId("profile-reauth-form")?.querySelectorAll("input")).toHaveLength(1);
    type(byTestId<HTMLInputElement>("profile-reauth-key"), "the passphrase");
    server.queue("/gs/api/profile/reauth", { status: 200, body: { ok: true, expiresAt: 1 } });
    await click(byTestId("profile-reauth-confirm"));
    expect(server.bodiesOf("/gs/api/profile/reauth")).toEqual([{ password: "the passphrase" }]);
    expect(byTestId("profile-replace-step-new")).toBeTruthy();
    expect(server.calls.some((call) => call.path.startsWith("/gs/api/account/authorization-wallet"))).toBe(false);
    expect(wallet.calls).toEqual([]);
    expect(all().innerHTML).not.toContain("the passphrase");
  });
});
