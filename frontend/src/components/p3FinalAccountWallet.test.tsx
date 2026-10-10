/** @jest-environment jsdom */
//
// ==================================================================
//  PHASE 3 FINAL (owner ruling 2026-10-06): THE ACCOUNT IS THE PLAYER; ONE AUTHORIZATION WALLET; EVERY GAME ANTED
// ==================================================================
//
// The browser's half of the final account model, on the real components over the real `httpSessionPort` (a fake server
// behind it) with Keplr played by the money test support's fake wallet. What is pinned:
//
//   CREATE ACCOUNT     the Authorization Wallet step explains what the wallet is (the owner's substance), needs Keplr
//                      connected by an explicit press before anything is minted, shows "Will be designated:", and has
//                      the CREATE text CHECKED before Keplr signs it -- a text for another site, account, signer, action,
//                      an expired one or a malformed one is refused and nothing is signed or created;
//   LOG IN             username + password only: the wallet port is never connected or asked to sign;
//   FORGOT PASSWORD?   username -> the account's Authorization Wallet (Keplr signs a RECOVER text) -> a new password;
//   THE PROFILE MENU   shows the Authorization Wallet; "Change Authorization Wallet" runs in the owner's order:
//                      "Confirm it's you" with the password, then the NEW wallet signs ACCEPT, then the CURRENT wallet
//                      signs APPROVE -- each text checked first, the approval refused while Keplr is on another wallet;
//   CONFIRM IT'S YOU   the password, and nothing else;
//   NO RECOVERY KEY    nowhere on any of these surfaces (one sentence says there is none -- see the case);
//   EVERY GAME ANTED   (§13) the host card requires a stake and cannot create a table without a real-money offer; the
//                      public list offers a no-ante table to Watch only; the Lobby takes that position;
//   NO WALLET "WHO"    (§12) the Lobby and the top bar show no Keplr address, balance, Connect or Disconnect -- even
//                      with a wallet connected underneath.

import React, { useState } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { AccountDialog, AUTHORIZATION_WALLET_EXPLAINED } from "./AccountDialog";
import { ConfirmItsYou, type ConfirmItsYouProps } from "./ConfirmItsYou";
import { HostSetupCard } from "./HostSetupCard";
import { Lobby } from "./Lobby";
import { LobbyRoomList } from "./LobbyRoomList";
import { ModalLayerHost } from "./ModalPortal";
import { ProfileMenu } from "./ProfileMenu";
import TopBar from "./TopBar";
import { httpSessionPort, installSessionPort, type SessionPort } from "../utils/sessionBootstrap";
import { resetAccountPromptForTests, type AccountMode } from "../utils/accountPrompt";
import { profileAuthorizationText, type ProfileAuthorizationFields, type ProfileAuthorizationPurpose } from "../utils/profileAuthorizationV1";
import { ANTE_UNAVAILABLE_SENTENCE, ANY_COUNT_BLOCKED_SENTENCE, FREE_TABLES_OFFERED, NO_ANTE_WATCH_ONLY } from "../utils/tablePolicy";
import { readStripped } from "../utils/sourceScan";
import type { RoomSummary } from "../utils/roomProtocol";
import type { GameVariants } from "../gameEngine/gameVariants";
import type { RoomSetup } from "../utils/sandboxRoom";
import { installMoneyServicesForTests, updateMoneySession } from "../money/moneySession";
import { resetPinnedDeploymentForTests } from "../money/escrowDeployment";
import { OTHER_WALLET, scriptedPort, T0, TEST_CONTRACT, TEST_PIN, TEST_WALLET, testServices, type FakeWallet } from "../money/moneyTestSupport";
import { APP_NAME } from "../config";

jest.mock("../config/backend", () => ({ isBackendConfigured: () => true, backendConfigError: () => null }));
/* §12's trap: a CONNECTED wallet and a ready session key underneath. The Lobby and the top bar no longer read either;
   if one ever did again, this address, its balance and a Disconnect would appear on screen and the cases below fail. */
jest.mock("../context/WalletContext", () => ({
  ...jest.requireActual("../context/WalletContext"),
  useWallet: () => ({
    status: "connected",
    error: null,
    address: "juno1keplrselectedwallet0000000000000000000x",
    nativeBalance: { denom: "ujuno", amount: "123456789" },
    connect: async () => undefined,
    disconnect: () => undefined,
  }),
}));
jest.mock("../context/GameSessionContext", () => ({
  ...jest.requireActual("../context/GameSessionContext"),
  useGameSession: () => ({ sessionStatus: "ready", sessionError: null, sessionAddress: "juno1sessionkeyaddress000000000000000000000y", initializeSessionKey: () => undefined }),
}));

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
global.IS_REACT_ACT_ENVIRONMENT = true;

const KEPLR_SELECTED = "juno1keplrselectedwallet0000000000000000000x";
const SESSION_KEY_ADDRESS = "juno1sessionkeyaddress000000000000000000000y";
const ENDPOINT = "https://play.example/gs/api/session";
const OPERATION = "0123456789abcdef0123456789abcdef";
const NONCE = "fedcba9876543210fedcba9876543210";
const PASSWORD = "a long enough secret";
/** The signature the fake Keplr returns unless a case sets another. */
const KEPLR_PUBKEY = "Ai1R5vzeZFvF73ROli+IbV7OuNG7bM6HeI0rthBGJzvf";
/** The forgot view's sentence about what can (and can't) reset a password. It names no recovery key: none exists. */
const NO_RECOVERY_SENTENCE = "Only your Authorization Wallet can reset your password — there is no email reset. Without your password and your Authorization Wallet, the account can't be recovered.";

type Answer = { status: number; body?: unknown; then?: () => void };
type Profile = { name: string; otherSessions: number; username?: string };

function fakeServer(initial: Profile | null) {
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
      next.then?.();
      return { status: next.status, json: async () => next.body ?? {} };
    },
  });
  return {
    port,
    calls,
    signIn: (next: Profile | null) => {
      profile = next;
    },
    queue: (path: string, answer: Answer) => queued.set(path, [...(queued.get(path) ?? []), answer]),
    bodiesOf: (path: string) => calls.filter((call) => call.path === path).map((call) => JSON.parse(call.body) as Record<string, unknown>),
    /** The account routes asked, in order (the bootstrap, the menu's reads and the trust facts left out). CONSOLIDATED
     *  FINAL INTEGRATION: player reporting's menu read -- `conduct/me`, "does this account review conduct reports?" --
     *  is one of the menu's reads, never an account action. */
    actions: () => calls.map((call) => call.path).filter((path) => !["/gs/api/session", "/gs/api/account/me", "/gs/api/trust/me", "/gs/api/conduct/me"].includes(path)),
  };
}

/** The text the server mints for one account action, naming this page's own site unless told otherwise. */
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
const mintedWith = (texts: Array<{ purpose: ProfileAuthorizationPurpose; signer: string; text: string }>): Answer => ({
  status: 200,
  body: { ok: true, operation: OPERATION, texts, expiresAt: T0 + 300_000 },
});
const minted = (purpose: ProfileAuthorizationPurpose, over: Partial<ProfileAuthorizationFields> = {}): Answer =>
  mintedWith([{ purpose, signer: over.signer ?? over.authorizationWallet ?? TEST_WALLET, text: authorizationText(purpose, over) }]);

let container: HTMLDivElement;
let root: Root;
let layerHost: HTMLDivElement | null = null;
let layerRoot: Root | null = null;
let wallet: FakeWallet;
/** Every text Keplr was asked to sign, whole, with the wallet asked to sign it. */
let signed: Array<{ signer: string; text: string }>;

beforeEach(() => {
  resetAccountPromptForTests();
  const services = testServices();
  wallet = services.wallet;
  signed = [];
  const sign = wallet.signLink.bind(wallet);
  wallet.signLink = async (pin, signer, text) => {
    signed.push({ signer, text });
    return sign(pin, signer, text);
  };
  installMoneyServicesForTests(services);
  /* The shared modal layer is committed before any dialog, on a root of its own, as the application does. */
  layerHost = document.createElement("div");
  document.body.appendChild(layerHost);
  layerRoot = createRoot(layerHost);
  act(() => layerRoot!.render(<ModalLayerHost />));
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  act(() => layerRoot?.unmount());
  layerHost?.remove();
  installSessionPort(null);
  installMoneyServicesForTests(null);
  delete process.env.REACT_APP_ESCROW_DEPLOYMENT;
  resetPinnedDeploymentForTests();
  jest.restoreAllMocks();
});

/** Microtasks and a few macrotasks: one press can run Keplr, a mint, a signature and a create. */
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
const buttonsNamed = (pattern: RegExp) => Array.from(all().querySelectorAll("button")).filter((button) => pattern.test(button.textContent?.trim() ?? ""));
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
/** `a` comes before `b` in the document. */
const before = (a: Element | null, b: Element | null) => {
  expect(a).toBeTruthy();
  expect(b).toBeTruthy();
  return (a!.compareDocumentPosition(b!) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
};
const signLinks = () => wallet.calls.filter((call) => call.startsWith("signLink"));

/* ------------------------------------------------------------------ */
/* The account dialog                                                  */
/* ------------------------------------------------------------------ */

function DialogHarness({ port, initial, onSignedIn }: { port: SessionPort; initial: AccountMode; onSignedIn: () => void }) {
  const [mode, setMode] = useState<AccountMode>(initial);
  return <AccountDialog mode={mode} reason={null} port={port} onModeChange={setMode} onSignedIn={onSignedIn} onClose={() => undefined} />;
}

async function dialog(initial: AccountMode, server = fakeServer(null)) {
  await act(async () => {
    await server.port.ensure();
  });
  const signedIn = jest.fn();
  act(() => root.render(<DialogHarness port={server.port} initial={initial} onSignedIn={signedIn} />));
  await settle();
  return { server, signedIn };
}

function fillCreate() {
  type(byTestId<HTMLInputElement>("account-username"), "Ann");
  type(byTestId<HTMLInputElement>("account-password"), PASSWORD);
  type(byTestId<HTMLInputElement>("account-name"), "Ann");
}
const createdAnswer = (server: ReturnType<typeof fakeServer>): Answer => ({
  status: 201,
  body: { ok: true, profile: { name: "Ann", otherSessions: 0 }, username: "Ann" },
  then: () => server.signIn({ name: "Ann", otherSessions: 0, username: "Ann" }),
});

describe("Create account: the Authorization Wallet step", () => {
  it("explains the Authorization Wallet in the owner's words, after the account fields, and asks for Keplr only on an explicit press", async () => {
    await dialog("create");
    const step = byTestId("account-wallet-step");
    expect(step).toBeTruthy();
    expect(step?.textContent).toContain("Authorization Wallet");
    expect(byTestId("account-wallet-explain")?.textContent).toBe(AUTHORIZATION_WALLET_EXPLAINED[0]);
    expect(byTestId("account-wallet-explain-more")?.textContent).toBe(AUTHORIZATION_WALLET_EXPLAINED[1]);
    expect(AUTHORIZATION_WALLET_EXPLAINED[0]).toBe(
      `This wallet proves ownership of your account and lets you recover it if you forget your password. It does not need to be your main wallet. ${APP_NAME} never controls it and cannot access its funds — the private key and seed phrase never leave Keplr.`,
    );
    expect(AUTHORIZATION_WALLET_EXPLAINED[1]).toBe(
      "You may prefer a dedicated Keplr wallet just for account authorization, and other wallets for your games. Signing is free: it is not a transaction and moves nothing.",
    );
    /* The order a player meets: username, password, display name, then the wallet, then Create. */
    expect(before(byTestId("account-username"), byTestId("account-password"))).toBe(true);
    expect(before(byTestId("account-password"), byTestId("account-name"))).toBe(true);
    expect(before(byTestId("account-name"), step)).toBe(true);
    expect(before(step, byTestId("account-submit"))).toBe(true);
    expect(byTestId("account-wallet-connect")?.textContent).toBe("Connect Keplr");
    expect(byTestId("account-submit")?.textContent).toBe("Sign with Keplr and create account");
    expect(byTestId("account-wallet-address")).toBeNull();
    /* Rendering the step asked Keplr nothing. */
    expect(wallet.calls).toEqual([]);
  });

  it("Create needs a connected wallet first: without one nothing is minted, signed or created; Connect shows the wallet that will be designated", async () => {
    const { server } = await dialog("create");
    fillCreate();
    await submit(byTestId("account-form"));
    expect(byTestId("account-error")?.textContent).toBe("Connect Keplr first: the account needs its Authorization Wallet.");
    expect(server.actions()).toEqual([]);
    expect(wallet.calls).toEqual([]);
    await click(byTestId("account-wallet-connect"));
    expect(wallet.calls).toEqual(["connect"]);
    expect(byTestId("account-wallet-address")?.textContent).toBe("Will be designated: juno12gdms…dl783a");
    expect(byTestId("account-wallet-address")?.querySelector("span")?.getAttribute("title")).toBe(TEST_WALLET);
    expect(byTestId("account-wallet-connect")?.textContent).toBe("Use the wallet Keplr is on now");
    expect(server.actions()).toEqual([]);
  });

  it("the CREATE text is checked BEFORE Keplr signs: another site, account, signer or action, an expired or a malformed text is refused -- nothing signed, nothing created; the right text is signed and creates the account", async () => {
    const { server, signedIn } = await dialog("create");
    fillCreate();
    await click(byTestId("account-wallet-connect"));
    const refusals: Array<[string, Answer, string]> = [
      ["another site", minted("CREATE", { site: "https://evil.example" }), "The authorization message names another site, so nothing was signed."],
      ["another account", minted("CREATE", { account: "Mallory" }), "The authorization message names another account, so nothing was signed."],
      ["another signer", minted("CREATE", { authorizationWallet: OTHER_WALLET }), "The authorization message is for another wallet than the one Keplr is on, so nothing was signed."],
      ["another action", minted("RECOVER"), "The server asked Keplr to sign for a different account action, so nothing was signed."],
      ["expired", minted("CREATE", { expiresAt: T0 }), "The authorization message has expired. Start again."],
      ["malformed", mintedWith([{ purpose: "CREATE", signer: TEST_WALLET, text: "Please sign this to log in." }]), "The server's authorization message wasn't in the expected form, so nothing was signed."],
    ];
    for (const [label, answer, sentence] of refusals) {
      server.queue("/gs/api/account/authorization", answer);
      await submit(byTestId("account-form"));
      expect([label, byTestId("account-error")?.textContent]).toEqual([label, sentence]);
      expect([label, signLinks()]).toEqual([label, []]);
      expect([label, server.bodiesOf("/gs/api/account/create")]).toEqual([label, []]);
    }
    expect(signedIn).not.toHaveBeenCalled();
    /* The right text: Keplr signs exactly it, with the wallet shown, and the account is created with that signature. */
    server.queue("/gs/api/account/authorization", minted("CREATE"));
    server.queue("/gs/api/account/create", createdAnswer(server));
    await submit(byTestId("account-form"));
    expect(signed).toEqual([{ signer: TEST_WALLET, text: authorizationText("CREATE") }]);
    expect(server.bodiesOf("/gs/api/account/authorization")).toHaveLength(refusals.length + 1);
    for (const body of server.bodiesOf("/gs/api/account/authorization")) expect(body).toEqual({ purpose: "create", username: "Ann", wallet: TEST_WALLET });
    expect(server.bodiesOf("/gs/api/account/create")).toEqual([{ username: "Ann", password: PASSWORD, name: "Ann", operation: OPERATION, pubKey: KEPLR_PUBKEY, signature: "c2ln" }]);
    expect(server.port.state).toBe("ready");
    expect(signedIn).toHaveBeenCalledTimes(1);
  });

  it("Keplr switched to another wallet after Connect: the page says so and signs nothing; the next press designates the wallet now shown", async () => {
    const { server } = await dialog("create");
    fillCreate();
    await click(byTestId("account-wallet-connect"));
    wallet.address = OTHER_WALLET;
    await submit(byTestId("account-form"));
    expect(byTestId("account-error")?.textContent).toBe("Keplr is now on juno1qqqqq…nrql8a. Check that's the wallet you mean, then press the button again.");
    expect(byTestId("account-wallet-address")?.textContent).toBe("Will be designated: juno1qqqqq…nrql8a");
    expect(server.actions()).toEqual([]);
    expect(signLinks()).toEqual([]);
    server.queue("/gs/api/account/authorization", minted("CREATE", { authorizationWallet: OTHER_WALLET }));
    server.queue("/gs/api/account/create", createdAnswer(server));
    await submit(byTestId("account-form"));
    expect(server.bodiesOf("/gs/api/account/authorization")).toEqual([{ purpose: "create", username: "Ann", wallet: OTHER_WALLET }]);
    expect(signed.map((entry) => entry.signer)).toEqual([OTHER_WALLET]);
    expect(server.port.state).toBe("ready");
  });
});

describe("Log in never touches Keplr", () => {
  it("username + password only: the wallet port is never connected, read or asked to sign -- whatever Keplr is on", async () => {
    const { server, signedIn } = await dialog("login");
    /* Keplr is connected on this page, on some wallet: irrelevant to who logs in. */
    act(() => updateMoneySession({ wallet: "connected", address: OTHER_WALLET }));
    expect(byTestId("account-wallet-step")).toBeNull();
    expect(byTestId("account-wallet-connect")).toBeNull();
    expect(buttonsNamed(/Keplr/)).toEqual([]);
    type(byTestId<HTMLInputElement>("account-username"), "Ann");
    type(byTestId<HTMLInputElement>("account-password"), PASSWORD);
    server.queue("/gs/api/account/login", { status: 200, body: { ok: true, profile: { name: "Ann" } }, then: () => server.signIn({ name: "Ann", otherSessions: 0, username: "Ann" }) });
    await submit(byTestId("account-form"));
    expect(server.bodiesOf("/gs/api/account/login")).toEqual([{ username: "Ann", password: PASSWORD }]);
    expect(server.actions()).toEqual(["/gs/api/account/login"]);
    expect(wallet.calls).toEqual([]);
    expect(signed).toEqual([]);
    expect(server.port.account?.name).toBe("Ann");
    expect(signedIn).toHaveBeenCalledTimes(1);
  });
});

describe("Forgot password? -- username, then the Authorization Wallet, then a new password", () => {
  it("the steps in order; Keplr signs exactly the RECOVER text for this username; the new password goes with that signature; signed in", async () => {
    const { server, signedIn } = await dialog("login");
    await click(byTestId("account-forgot"));
    expect(byTestId("account-form")?.closest("dialog")?.querySelector("h2")?.textContent).toBe("Forgot password");
    const username = byTestId("account-forgot-username");
    const step = byTestId("account-forgot-wallet-step");
    const newPassword = byTestId("account-forgot-password");
    expect(before(username, step)).toBe(true);
    expect(before(step, newPassword)).toBe(true);
    expect(byTestId("account-forgot-submit")?.textContent).toBe("Sign with Keplr and set the new password");
    type(username as HTMLInputElement, "Ann");
    await click(byTestId("account-forgot-connect"));
    expect(byTestId("account-forgot-address")?.textContent).toBe("Keplr is on: juno12gdms…dl783a");
    type(newPassword as HTMLInputElement, "my brand new passphrase");
    server.queue("/gs/api/account/authorization", minted("RECOVER"));
    server.queue("/gs/api/account/recover", { status: 200, body: { ok: true, profile: { name: "Ann" }, signedOut: 1 }, then: () => server.signIn({ name: "Ann", otherSessions: 0, username: "Ann" }) });
    await submit(byTestId("account-form"));
    expect(server.actions()).toEqual(["/gs/api/account/authorization", "/gs/api/account/recover"]);
    expect(server.bodiesOf("/gs/api/account/authorization")).toEqual([{ purpose: "recover", username: "Ann", wallet: TEST_WALLET }]);
    expect(wallet.calls).toEqual(["connect", "account", `signLink:${TEST_WALLET}:18COSMOS/PROFILE-AUTHORIZATION/v1`]);
    expect(signed).toEqual([{ signer: TEST_WALLET, text: authorizationText("RECOVER") }]);
    expect(server.bodiesOf("/gs/api/account/recover")).toEqual([{ operation: OPERATION, pubKey: KEPLR_PUBKEY, signature: "c2ln", newPassword: "my brand new passphrase" }]);
    expect(server.port.state).toBe("ready");
    expect(signedIn).toHaveBeenCalledTimes(1);
    expect(all().innerHTML).not.toContain("my brand new passphrase");
  });

  it("a RECOVER text for another wallet than the one Keplr is on is refused before signing", async () => {
    const { server } = await dialog("login");
    await click(byTestId("account-forgot"));
    type(byTestId<HTMLInputElement>("account-forgot-username"), "Ann");
    await click(byTestId("account-forgot-connect"));
    type(byTestId<HTMLInputElement>("account-forgot-password"), "my brand new passphrase");
    server.queue("/gs/api/account/authorization", minted("RECOVER", { authorizationWallet: OTHER_WALLET }));
    await submit(byTestId("account-form"));
    expect(byTestId("account-error")?.textContent).toBe("The authorization message is for another wallet than the one Keplr is on, so nothing was signed.");
    expect(signLinks()).toEqual([]);
    expect(server.bodiesOf("/gs/api/account/recover")).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* The profile menu: the Authorization Wallet and its replacement      */
/* ------------------------------------------------------------------ */

const CURRENT = TEST_WALLET;
const NEXT = OTHER_WALLET;
const meWith = (address: string, since: number) => ({
  status: 200,
  body: { ok: true, account: { name: "Ann", otherSessions: 0, username: "Ann.Player", authorizationWallet: { address, since }, memberSince: Date.UTC(2026, 8, 1) } },
});
const replacementTexts = (over: Partial<ProfileAuthorizationFields> = {}) => {
  const common = { account: "Ann.Player", authorizationWallet: NEXT, replaces: CURRENT };
  return mintedWith([
    { purpose: "REPLACE-APPROVE", signer: CURRENT, text: authorizationText("REPLACE-APPROVE", { ...common, signer: CURRENT }) },
    { purpose: "REPLACE-ACCEPT", signer: NEXT, text: authorizationText("REPLACE-ACCEPT", { ...common, signer: NEXT, ...over }) },
  ]);
};

async function signedInMenu() {
  const server = fakeServer({ name: "Ann", otherSessions: 0, username: "Ann.Player" });
  await act(async () => {
    await server.port.ensure();
  });
  server.queue("/gs/api/account/me", meWith(CURRENT, Date.UTC(2026, 8, 2)));
  act(() => root.render(<ProfileMenu port={server.port} />));
  await settle();
  await click(byTestId("profile-chip"));
  return server;
}

describe("the profile menu: the Authorization Wallet, and 'Change Authorization Wallet' in the owner's order", () => {
  it("shows the Authorization Wallet (shortened, since when) and says it is not a game wallet", async () => {
    await signedInMenu();
    expect(byTestId("profile-menu-authorization")?.textContent).toContain("Authorization Wallet");
    expect(byTestId("profile-menu-authorization-wallet")?.textContent).toBe("juno12gdms…dl783a · since 2026-09-02");
    expect(byTestId("profile-menu-authorization-note")?.textContent).toBe(
      "It recovers this account if you forget your password. It isn't a game wallet: each table pays out to the wallet you anted with there, and the wallet Keplr has selected never changes who you are.",
    );
    expect(wallet.calls).toEqual([]);
  });

  it("Confirm it's you (password) -> the NEW wallet signs ACCEPT -> the CURRENT wallet signs APPROVE -> replaced; each text checked; the approval refused while Keplr is on another wallet", async () => {
    const server = await signedInMenu();
    await click(byTestId("profile-menu-replace-wallet"));
    /* 1. "Confirm it's you": the password -- always, even right after signing in. Nothing minted before it. */
    expect(server.actions()).toEqual([]);
    type(byTestId<HTMLInputElement>("profile-reauth-key"), "correct horse battery");
    server.queue("/gs/api/profile/reauth", { status: 200, body: { ok: true, expiresAt: T0 + 300_000 } });
    await click(byTestId("profile-reauth-confirm"));
    expect(byTestId("profile-replace-step-new")?.textContent).toBe(
      "1. In Keplr, switch to the wallet you want as your new Authorization Wallet, then press the button. It signs once to accept (free: not a transaction). Your current one, juno12gdms…dl783a, approves next.",
    );
    expect(wallet.calls).toEqual([]);

    /* 2a. Keplr on the new wallet; the server's ACCEPT text names another site: refused before Keplr signs it. */
    wallet.address = NEXT;
    server.queue("/gs/api/account/authorization-wallet/challenge", replacementTexts({ site: "https://evil.example" }));
    await click(byTestId("profile-replace-use-new"));
    expect(all().querySelector('[role="alert"]')?.textContent).toBe("The authorization message names another site, so nothing was signed.");
    expect(signLinks()).toEqual([]);
    expect(byTestId("profile-replace-step-new")).toBeTruthy();

    /* 2b. The right texts: the NEW wallet signs its ACCEPT -- and only that, first. */
    wallet.linkAnswer = { ok: true, value: { pubKey: "accept-pub", signature: "accept-sig" } };
    server.queue("/gs/api/account/authorization-wallet/challenge", replacementTexts());
    await click(byTestId("profile-replace-use-new"));
    const texts = (replacementTexts().body as { texts: Array<{ text: string }> }).texts;
    expect(signed).toEqual([{ signer: NEXT, text: texts[1].text }]);
    expect(byTestId("profile-replace-step-approve")?.textContent).toBe(
      "2. The new wallet, juno1qqqqq…nrql8a, accepted. Now switch Keplr back to your current Authorization Wallet, juno12gdms…dl783a, and approve the change.",
    );

    /* 3a. Keplr still on the new wallet: the approval is refused, and nothing is signed or sent. */
    await click(byTestId("profile-replace-approve"));
    expect(all().querySelector('[role="alert"]')?.textContent).toBe("Keplr is on juno1qqqqq…nrql8a. Switch Keplr to your current Authorization Wallet, juno12gdms…dl783a, to approve.");
    expect(signed).toHaveLength(1);
    expect(server.actions()).not.toContain("/gs/api/account/authorization-wallet/replace");

    /* 3b. Keplr on the CURRENT wallet: it signs the APPROVE text; both signatures go in one replacement. */
    wallet.address = CURRENT;
    wallet.linkAnswer = { ok: true, value: { pubKey: "approve-pub", signature: "approve-sig" } };
    server.queue("/gs/api/account/authorization-wallet/replace", { status: 200, body: { ok: true, authorizationWallet: { address: NEXT, since: Date.UTC(2026, 9, 6) } } });
    server.queue("/gs/api/account/me", meWith(NEXT, Date.UTC(2026, 9, 6)));
    await click(byTestId("profile-replace-approve"));
    expect(signed).toEqual([
      { signer: NEXT, text: texts[1].text },
      { signer: CURRENT, text: texts[0].text },
    ]);
    expect(texts[1].text).toContain("Purpose: REPLACE-ACCEPT");
    expect(texts[0].text).toContain("Purpose: REPLACE-APPROVE");
    expect(server.actions()).toEqual([
      "/gs/api/profile/reauth",
      "/gs/api/account/authorization-wallet/challenge",
      "/gs/api/account/authorization-wallet/challenge",
      "/gs/api/account/authorization-wallet/replace",
    ]);
    expect(server.bodiesOf("/gs/api/profile/reauth")).toEqual([{ password: "correct horse battery" }]);
    expect(server.bodiesOf("/gs/api/account/authorization-wallet/challenge")).toEqual([{ newWallet: NEXT }, { newWallet: NEXT }]);
    expect(server.bodiesOf("/gs/api/account/authorization-wallet/replace")).toEqual([
      { operation: OPERATION, approvePubKey: "approve-pub", approveSignature: "approve-sig", acceptPubKey: "accept-pub", acceptSignature: "accept-sig" },
    ]);
    expect(byTestId("profile-replace-done")?.textContent).toBe(
      "Your Authorization Wallet is now juno1qqqqq…nrql8a. The old one can no longer recover this account. Your tables, seats and game wallets haven't changed.",
    );
    expect(all().innerHTML).not.toContain("correct horse battery");
  });

  it("the new wallet is the current one: said before anything is minted or signed", async () => {
    const server = await signedInMenu();
    await click(byTestId("profile-menu-replace-wallet"));
    type(byTestId<HTMLInputElement>("profile-reauth-key"), "correct horse battery");
    server.queue("/gs/api/profile/reauth", { status: 200, body: { ok: true, expiresAt: T0 + 300_000 } });
    await click(byTestId("profile-reauth-confirm"));
    wallet.address = CURRENT;
    await click(byTestId("profile-replace-use-new"));
    expect(all().querySelector('[role="alert"]')?.textContent).toBe("That's already your Authorization Wallet. Switch Keplr to the wallet you want to use instead.");
    expect(server.actions()).toEqual(["/gs/api/profile/reauth"]);
    expect(signLinks()).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* "Confirm it's you" and the recovery key that no longer exists       */
/* ------------------------------------------------------------------ */

describe("Confirm it's you takes only a password", () => {
  it("one password field; the password sent once and dropped; no other way to confirm", async () => {
    /* No `method`: the password is the only way (PHASE 3 FINAL). This is checked by the type-checker. */
    const props: ConfirmItsYouProps = {
      purpose: "To test this",
      onConfirmed: () => undefined,
      // @ts-expect-error -- PHASE 3 FINAL: "Confirm it's you" has no method (no recovery key, no wallet)
      method: "recovery-key",
    };
    expect(props.purpose).toBe("To test this");
    const port = scriptedPort();
    port.answer("profile/reauth", 200, { ok: true, expiresAt: 4242 });
    const confirmed = jest.fn();
    act(() => root.render(<ConfirmItsYou purpose="To test this" port={port} onConfirmed={confirmed} onCancel={() => undefined} />));
    const form = byTestId("profile-reauth-form");
    const inputs = Array.from(form?.querySelectorAll("input") ?? []);
    expect(inputs.map((input) => [input.type, input.autocomplete])).toEqual([["password", "current-password"]]);
    expect(form?.querySelector("label")?.textContent).toBe("To test this, enter your password. It is checked once and not kept on this device.");
    expect(form?.textContent).not.toMatch(/recovery|key|Keplr|wallet/i);
    expect(byTestId<HTMLButtonElement>("profile-reauth-confirm")?.disabled).toBe(true);
    type(inputs[0], "correct horse battery");
    await click(byTestId("profile-reauth-confirm"));
    expect(port.requests).toEqual([{ path: "profile/reauth", body: { password: "correct horse battery" } }]);
    expect(confirmed).toHaveBeenCalledWith(4242);
    expect(byTestId<HTMLInputElement>("profile-reauth-key")?.value).toBe("");
    expect(wallet.calls).toEqual([]);
  });
});

describe("no recovery key anywhere", () => {
  it("the dialog's three views, the menu's views and Confirm it's you never mention a recovery key", async () => {
    const seen: string[] = [];
    const look = (label: string) => {
      expect([label, all().querySelectorAll('[data-testid*="recovery"], [id*="recovery"], [name*="recovery"]').length]).toEqual([label, 0]);
      seen.push(`${label}: ${all().textContent ?? ""}`);
    };
    await dialog("login");
    look("log in");
    await click(byTestId("account-tab-create"));
    await click(byTestId("account-wallet-connect"));
    look("create account");
    await click(byTestId("account-tab-login"));
    await click(byTestId("account-forgot"));
    await click(byTestId("account-forgot-connect"));
    expect(byTestId("account-forgot-nowallet")?.textContent).toBe(NO_RECOVERY_SENTENCE);
    look("forgot password");
    act(() => root.unmount());
    root = createRoot(container);
    const server = await signedInMenu();
    look("menu");
    await click(byTestId("profile-menu-password"));
    look("change password");
    await click(buttonsNamed(/^Back$/)[0]);
    await click(byTestId("profile-menu-replace-wallet"));
    look("confirm it's you");
    server.queue("/gs/api/profile/reauth", { status: 200, body: { ok: true, expiresAt: T0 + 300_000 } });
    type(byTestId<HTMLInputElement>("profile-reauth-key"), "correct horse battery");
    await click(byTestId("profile-reauth-confirm"));
    look("change authorization wallet");
    await click(buttonsNamed(/^Back$/)[0]);
    await click(byTestId("profile-menu-others"));
    look("sign out other devices");
    await click(buttonsNamed(/^Back$/)[0]);
    await click(byTestId("profile-menu-signout"));
    look("sign out this device");
    expect(seen).toHaveLength(9);
    for (const page of seen) {
      /* Owner: the recovery-key product is gone -- no surface names one, not even to say there is none. */
      expect([page.split(":")[0], /recovery[\s-]?key/i.test(page)]).toEqual([page.split(":")[0], false]);
    }
  });
});

/* ------------------------------------------------------------------ */
/* §13: every player game is anted                                     */
/* ------------------------------------------------------------------ */

async function hostCard(onCreate: (variants: GameVariants, setup: RoomSetup) => void) {
  act(() => root.render(<HostSetupCard busy={false} error={null} onClose={() => undefined} onCreate={onCreate} />));
  await settle();
  await click(byTestId("host-continue"));
}

describe("§13: the host card requires a stake", () => {
  it("this build offers no no-ante tables (only a development-identity build does)", () => {
    expect(FREE_TABLES_OFFERED).toBe(false);
  });

  it("with no real-money offer: the card says a game can't be hosted, and Create Room is disabled -- pressing it creates nothing", async () => {
    const created = jest.fn();
    await hostCard(created);
    expect(byTestId("host-ante-unavailable")?.textContent).toBe(ANTE_UNAVAILABLE_SENTENCE);
    expect(byTestId("host-stake")).toBeNull();
    expect(byTestId("host-stake-on")).toBeNull();
    expect(all().querySelector('input[aria-label="Ante"]')).toBeNull(); // no "0 JUNO" free-play row
    const create = byTestId<HTMLButtonElement>("host-create-room");
    expect(create?.disabled).toBe(true);
    act(() => create!.click());
    expect(created).not.toHaveBeenCalled();
  });

  /* PLAY HOST A GAME (handoff §3.2, §11): Any is the default and is NOT turned into an exact count -- on a money table
     Create table says why it is blocked until the host chooses one (Escrow 2.1 needs every seat it was created for). */
  it("with an offer: the stake is required -- no toggle, no 'played for fun' -- Any stays the default but is gated, and Create table waits for a valid stake and an exact count", async () => {
    process.env.REACT_APP_ESCROW_DEPLOYMENT = JSON.stringify(TEST_PIN);
    resetPinnedDeploymentForTests();
    const port = scriptedPort();
    port.answer("money/config", 200, {
      ok: true,
      enabled: true,
      why: null,
      reason: null,
      deployment: { backend: "juno-cosmwasm", chainId: "uni-7", networkClass: "testnet", contract: TEST_CONTRACT, codeChecksum: TEST_PIN.codeChecksum, denom: "ujunox", symbol: "JUNOX", exponent: 6 },
      feeBps: 100,
      minAnte: "1000",
    });
    installSessionPort(port);
    const created = jest.fn();
    await hostCard(created);
    expect(byTestId("host-stake")).toBeTruthy();
    expect(byTestId("host-ante-unavailable")).toBeNull();
    expect(byTestId("host-stake-on")).toBeNull();
    expect(all().textContent).not.toContain("played for fun");
    expect(byTestId("host-players-any")?.getAttribute("aria-checked")).toBe("true");
    expect(byTestId<HTMLButtonElement>("host-create-room")?.disabled).toBe(true);
    expect(byTestId("host-stake-problem")?.textContent).toBe("Enter the ante in JUNOX, like 10 or 2.5 (above zero).");
    type(byTestId<HTMLInputElement>("host-stake-amount"), "2.5");
    await settle();
    expect(byTestId("host-stake-problem")).toBeNull();
    /* The fee is the deployment's own (100 bps here), never a constant. */
    expect(byTestId("host-stake-summary")?.textContent).toBe("Each seat deposits 2.5 JUNOX; the 1% developer fee (0.025 JUNOX) isn't refunded. You can change the ante in the waiting room until the first deposit.");
    /* Any, with an ante: blocked, said, and pressing creates nothing. */
    expect(byTestId("host-players-any")?.getAttribute("aria-checked")).toBe("true");
    expect(byTestId("host-create-why")?.textContent).toBe(ANY_COUNT_BLOCKED_SENTENCE);
    expect(byTestId<HTMLButtonElement>("host-create-room")?.disabled).toBe(true);
    await click(byTestId("host-create-room"));
    expect(created).not.toHaveBeenCalled();
    await click(byTestId("host-players-2"));
    const create = byTestId<HTMLButtonElement>("host-create-room");
    expect(create?.disabled).toBe(false);
    await click(create);
    expect(created).toHaveBeenCalledTimes(1);
    expect(created.mock.calls[0][1]).toEqual({ visibility: "public", playerCount: 2, anteUjuno: "2500000" });
  });
});

describe("§13: the public list offers a no-ante table to Watch only", () => {
  const STANDARD = {} as GameVariants;
  const room = (code: string, over: Partial<RoomSummary> = {}): RoomSummary => ({
    gameId: `g_${code.toLowerCase().replace(/-/g, "")}`,
    code,
    status: "waiting",
    hostNickname: "Owner",
    nicknames: ["Owner"],
    readyCount: 0,
    seated: 1,
    seatCap: 6,
    playerCount: 2,
    variants: STANDARD,
    createdAtMs: 1,
    ...over,
  });
  const ROOMS: RoomSummary[] = [
    room("JUNO-FREE-0001"),
    room("JUNO-ANTE-0002", { stake: { anteGross: "1000000", symbol: "JUNOX", exponent: 6, networkClass: "testnet", funded: 1, seats: 2 }, createdAtMs: 2 }),
    room("JUNO-FREE-0003", { status: "playing", seated: 2, createdAtMs: 3 }),
  ];

  function list(noAnteSeats?: boolean) {
    const joined: string[] = [];
    const watched: string[] = [];
    act(() =>
      root.render(
        <LobbyRoomList rooms={ROOMS} loading={false} error={null} available busy={false} refusal={null} onJoin={(code) => joined.push(code)} onWatch={(id) => watched.push(id)} {...(noAnteSeats === undefined ? {} : { noAnteSeats })} />,
      ),
    );
    return { joined, watched };
  }

  it("noAnteSeats=false (the Lobby's position): a no-ante waiting table says 'No ante — watch only' and has no Join; an anted one has Join; both can be watched", () => {
    const { joined, watched } = list(false);
    expect(byTestId("lobby-no-ante-JUNO-FREE-0001")?.textContent).toBe(NO_ANTE_WATCH_ONLY);
    expect(NO_ANTE_WATCH_ONLY).toBe("No ante — watch only");
    expect(byTestId("lobby-no-ante-JUNO-FREE-0001")?.tagName).toBe("SPAN");
    expect(byTestId("lobby-join-JUNO-FREE-0001")).toBeNull();
    expect(byTestId("lobby-join-JUNO-ANTE-0002")?.textContent).toBe("Join");
    expect(byTestId("lobby-no-ante-JUNO-ANTE-0002")).toBeNull();
    /* A dealt table offers no seat either way, and is not labelled. */
    expect(byTestId("lobby-join-JUNO-FREE-0003")).toBeNull();
    expect(byTestId("lobby-no-ante-JUNO-FREE-0003")).toBeNull();
    act(() => byTestId("lobby-join-JUNO-ANTE-0002")!.click());
    act(() => byTestId("lobby-watch-JUNO-FREE-0001")!.click());
    expect(joined).toEqual(["JUNO-ANTE-0002"]);
    expect(watched).toEqual(["g_junofree0001"]);
  });

  it("on its own the list takes no position (default true): Join for both", () => {
    list();
    expect(byTestId("lobby-join-JUNO-FREE-0001")).toBeTruthy();
    expect(byTestId("lobby-join-JUNO-ANTE-0002")).toBeTruthy();
    expect(byTestId("lobby-no-ante-JUNO-FREE-0001")).toBeNull();
  });

  it("the Lobby passes the build's policy (false outside a development-identity build)", () => {
    expect(readStripped("components/Lobby.tsx")).toContain("noAnteSeats={FREE_TABLES_OFFERED}");
  });
});

/* ------------------------------------------------------------------ */
/* §12: no Keplr address answers "who am I"                            */
/* ------------------------------------------------------------------ */

describe("§12: the Lobby and the top bar show no wallet chip -- the account chip is the only 'who'", () => {
  function noWalletChip(label: string) {
    const text = all().textContent ?? "";
    const html = all().innerHTML;
    for (const address of [KEPLR_SELECTED, SESSION_KEY_ADDRESS]) {
      expect([label, html.includes(address)]).toEqual([label, false]);
      expect([label, html.includes(address.slice(0, 10))]).toEqual([label, false]);
      expect([label, html.includes(address.slice(-4))]).toEqual([label, false]);
    }
    expect([label, /123\.456789|123\.46/.test(text)]).toEqual([label, false]); // the balance
    expect([label, buttonsNamed(/^(Connect|Connect Keplr|Connect wallet|Disconnect|Session Key|Initializing\.\.\.)$/i).map((button) => button.textContent)]).toEqual([label, []]);
    expect([label, all().querySelectorAll('[aria-label^="Wallet "], [aria-label^="Session key"]').length]).toEqual([label, 0]);
  }

  it("the Lobby, signed in, with a wallet connected underneath: the account chip, and no address, balance, Connect or Disconnect", async () => {
    const server = fakeServer({ name: "Ann", otherSessions: 0, username: "Ann.Player" });
    await act(async () => {
      await server.port.ensure();
    });
    installSessionPort(server.port);
    act(() => root.render(<Lobby onEnterSandbox={() => undefined} onWatchSandbox={() => undefined} />));
    await settle();
    expect(byTestId("profile-chip")?.textContent).toBe("Ann");
    noWalletChip("lobby");
    expect(wallet.calls).toEqual([]);
  });

  it("the top bar, signed in, with a wallet connected underneath: the account chip, and no address, balance, wallet dot, session key, Connect or Disconnect", async () => {
    const server = fakeServer({ name: "Ann", otherSessions: 0, username: "Ann.Player" });
    await act(async () => {
      await server.port.ensure();
    });
    installSessionPort(server.port);
    act(() => root.render(<TopBar roomName="JUNO-ABCD-EFGH" onLeaveGame={() => undefined} />));
    await settle();
    expect(byTestId("profile-chip")?.textContent).toBe("Ann");
    noWalletChip("top bar");
    expect(wallet.calls).toEqual([]);
  });

  it("neither reads the wallet context or the session key any more (the source)", () => {
    for (const file of ["components/Lobby.tsx", "components/TopBar.tsx"]) {
      const code = readStripped(file);
      for (const banned of ["useWallet(", "useGameSession(", "<ConnectWalletButton", "truncateAddress(", "wallet.disconnect", "nativeBalance"]) {
        expect([file, banned, code.includes(banned)]).toEqual([file, banned, false]);
      }
      expect([file, code.includes("<ProfileMenu />")]).toEqual([file, true]);
    }
  });
});
