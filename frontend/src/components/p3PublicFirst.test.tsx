/** @jest-environment jsdom */
//
// ==================================================================
//  PHASE 3 (P3-ACCT): PUBLIC FIRST -- THE HOMEPAGE FOR EVERYONE, AN ACCOUNT ONLY WHERE ONE IS NEEDED
// ==================================================================
//
// The real Lobby (inside the real WalletProvider), the real account dialog and the real Terms/Rules pages, over a
// session port answered by a fake server (the same `httpSessionPort` the app installs). What is pinned:
//
//   a visitor gets the homepage at once -- no gate, no bootstrap in the way -- with Log in, Create account and Rules;
//   Host and Join ask for an account first (saying why), and NOTHING runs underneath;
//   logging in RESUMES the action (the host's setup card opens by itself), on a fresh session, the password sent once
//   in a POST body and kept nowhere; a new account is signed in at once and (P3-ACCT POLICY) shown its recovery key
//   once before the action resumes (`p3AccountPolicy.test.tsx` pins the reveal);
//   a wrong password -- or an unknown username -- is one sentence that names neither;
//   signed in, Host opens straight away (no password, no key);
//   the Terms page is reachable by anyone, says the owner's copy is pending, and carries no invented legal prose;
//   every money/deposit surface links it (AUD-20.08); the trust facts are facts under their three headings, never a
//   score, and carry no id, username or wallet.

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { Lobby } from "./Lobby";
import { ModalLayerHost } from "./ModalPortal";
import { AccountPromptHost } from "./AccountDialog";
import { InfoPagesHost, TERMS_PENDING_SENTENCE } from "./InfoPages";
import { TableTrustFacts, TRUST_FACTS_DISCLAIMER } from "./TrustFacts";
import { WalletProvider } from "../context/WalletContext";
import { httpSessionPort, installSessionPort, type SessionPort } from "../utils/sessionBootstrap";
import { accountSignedIn, requireAccount, resetAccountPromptForTests } from "../utils/accountPrompt";
import { roomLinkRenewals } from "../utils/roomLink";
import { openInfoPage, resetInfoPagesForTests } from "../utils/infoPages";
import { readStripped } from "../utils/sourceScan";
import { scriptedPort } from "../money/moneyTestSupport";

/* This build has a game server (the doors render); its URL is not needed -- the room links are not exercised. */
jest.mock("../config/backend", () => ({ isBackendConfigured: () => true, backendConfigError: () => null }));

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
global.IS_REACT_ACT_ENVIRONMENT = true;

const ENDPOINT = "https://play.example/gs/api/session";
const ID_PATTERN = /\b(?:pr|pf|se|sf|rk)_[0-9a-z]/i;

type Answer = { status: number; body?: unknown; then?: () => void };

/** A fake game server behind the real port: the bootstrap answers the CURRENT profile (null: a visitor). */
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
      next.then?.();
      return { status: next.status, json: async () => next.body ?? {} };
    },
  });
  return {
    port,
    calls,
    signIn: (name: string) => {
      profile = { name, otherSessions: 0 };
    },
    queue: (path: string, answer: Answer) => queued.set(path, [...(queued.get(path) ?? []), answer]),
  };
}

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  resetAccountPromptForTests();
  resetInfoPagesForTests();
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  installSessionPort(null);
});

const settle = async () => {
  await act(async () => {
    for (let n = 0; n < 40; n += 1) await Promise.resolve();
  });
};
const all = () => document.body;
const byTestId = (id: string) => all().querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
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
        <InfoPagesHost />
      </>,
    ),
  );
  await settle();
}

describe("P3-ACCT: a visitor gets the homepage, and an account only where one is needed", () => {
  it("the app has no gate: index renders the app for everyone, with the account dialog and the reading pages beside it", () => {
    const index = readStripped("index.tsx");
    expect(index).not.toContain("ProfileGate");
    expect(index).toMatch(/<App \/>\s*<AccountPromptHost \/>\s*<InfoPagesHost \/>\s*<SessionEndedNotice \/>/);
  });

  it("an anonymous visitor: the homepage at once -- Host, Join, Rules, Log in, Create account; no 'Your tables'; nothing asked", async () => {
    const server = fakeServer(null);
    await homepage(server.port);
    expect(byTestId("profile-gate")).toBeNull();
    expect(buttonNamed("Host game")).toBeTruthy();
    expect(buttonNamed("Join game")).toBeTruthy();
    expect(byTestId("lobby-rules")?.textContent).toBe("Rules");
    expect(byTestId("account-login")?.textContent).toBe("Log in");
    expect(byTestId("account-create")?.textContent).toBe("Create account");
    expect(all().textContent).not.toMatch(/Your tables/);
    expect(byTestId("account-dialog")).toBeNull();
  });

  it("Host asks for an account first (saying why) and opens nothing underneath; Log in RESUMES it -- the host's setup opens by itself, the password sent once and kept nowhere", async () => {
    const server = fakeServer(null);
    await homepage(server.port);
    await click(buttonNamed("Host game"));
    expect(byTestId("account-dialog")).toBeTruthy();
    expect(byTestId("account-reason")?.textContent).toBe("Log in or create an account to host a game.");
    expect(byTestId("host-body")).toBeNull();
    type(byTestId("account-username") as HTMLInputElement, "Brad.Player");
    type(byTestId("account-password") as HTMLInputElement, "correct horse battery");
    expect((byTestId("account-password") as HTMLInputElement).type).toBe("password");
    expect((byTestId("account-form") as HTMLFormElement).method).toBe("post");
    server.queue("/gs/api/account/login", { status: 200, body: { ok: true, profile: { name: "Brad" } }, then: () => server.signIn("Brad") });
    await submit(byTestId("account-form"));
    expect(server.calls.filter((call) => call.path === "/gs/api/account/login").map((call) => JSON.parse(call.body))).toEqual([{ username: "Brad.Player", password: "correct horse battery" }]);
    expect(server.port.state).toBe("ready");
    expect(byTestId("account-dialog")).toBeNull();
    /* Resumed: the setup card is open, and nothing was asked a second time. */
    expect(byTestId("host-body")).toBeTruthy();
    expect(all().innerHTML).not.toContain("correct horse battery");
    expect(byTestId("profile-chip")?.textContent).toBe("Brad");
  });

  it("Join asks for an account too; closing the dialog drops the action (nothing joins later)", async () => {
    const server = fakeServer(null);
    await homepage(server.port);
    await click(buttonNamed("Join game"));
    /* No game server in this build: the code box is inline -- its Join is the gated door. */
    const code = all().querySelector('input[aria-label="Room code"]') as HTMLInputElement | null;
    type(code, "JUNO-AAAA-BBBB");
    await submit(code?.closest("form") ?? null);
    expect(byTestId("account-reason")?.textContent).toBe("Log in or create an account to join a game.");
    await click(byTestId("account-dialog")?.querySelector('button[aria-label="Close"]'));
    expect(byTestId("account-dialog")).toBeNull();
    expect(server.calls.filter((call) => call.path !== "/gs/api/session")).toEqual([]);
  });

  it("review M1: another tab signed this browser in meanwhile (as someone else): the dialog says WHO, and nothing resumes until 'Continue as …'", async () => {
    const server = fakeServer(null);
    await homepage(server.port);
    await click(buttonNamed("Host game"));
    type(byTestId("account-username") as HTMLInputElement, "Brad.Player");
    type(byTestId("account-password") as HTMLInputElement, "correct horse battery");
    server.signIn("Ann"); // the other tab
    server.queue("/gs/api/account/login", { status: 409, body: { error: "already-profiled" } });
    const renewalsBefore = roomLinkRenewals();
    await submit(byTestId("account-form"));
    expect(byTestId("account-pending-sentence")?.textContent).toBe("This browser is already signed in as Ann (from another tab or window).");
    expect(byTestId("host-body")).toBeNull(); // never resumed as Ann on its own
    expect(byTestId("account-continue")?.textContent).toBe("Continue as Ann");
    /* Re-review N2: the other tab replaced this browser's session -- this page's sockets moved to it already. */
    expect(roomLinkRenewals()).toBe(renewalsBefore + 1);
    await click(byTestId("account-continue"));
    expect(byTestId("account-dialog")).toBeNull();
    expect(byTestId("host-body")).toBeTruthy();
  });

  it("review M1: …and 'Not now' drops the action", async () => {
    const server = fakeServer(null);
    await homepage(server.port);
    await click(buttonNamed("Host game"));
    type(byTestId("account-username") as HTMLInputElement, "Brad.Player");
    type(byTestId("account-password") as HTMLInputElement, "correct horse battery");
    server.signIn("Ann");
    server.queue("/gs/api/account/login", { status: 409, body: { error: "already-profiled" } });
    await submit(byTestId("account-form"));
    await click(byTestId("account-pending-close"));
    expect(byTestId("account-dialog")).toBeNull();
    expect(byTestId("host-body")).toBeNull();
  });

  it("review L8: keyboard focus after a sign-in -- the resumed Host card returns focus to 'Host game' when closed; the homepage's own Log in lands on the account chip", async () => {
    const server = fakeServer(null);
    await homepage(server.port);
    const host = buttonNamed("Host game") as HTMLButtonElement;
    act(() => host.focus());
    await click(host);
    type(byTestId("account-username") as HTMLInputElement, "Brad.Player");
    type(byTestId("account-password") as HTMLInputElement, "correct horse battery");
    server.queue("/gs/api/account/login", { status: 200, body: { ok: true, profile: { name: "Brad" } }, then: () => server.signIn("Brad") });
    await submit(byTestId("account-form"));
    expect(byTestId("host-body")).toBeTruthy();
    await click(byTestId("host-body")?.closest('[role="dialog"], dialog')?.querySelector('button[aria-label="Close"]') ?? all().querySelector('button[aria-label="Close"]'));
    expect(byTestId("host-body")).toBeNull();
    expect(document.activeElement).toBe(buttonNamed("Host game"));
    /* Signed out again, the homepage's own "Log in": that button is replaced by the chip -- focus goes there. */
    act(() => root.unmount());
    root = createRoot(container);
    resetAccountPromptForTests();
    const second = fakeServer(null);
    await homepage(second.port);
    const login = buttonNamed("Log in") as HTMLButtonElement;
    act(() => login.focus());
    await click(login);
    type(byTestId("account-username") as HTMLInputElement, "Brad.Player");
    type(byTestId("account-password") as HTMLInputElement, "correct horse battery");
    second.queue("/gs/api/account/login", { status: 200, body: { ok: true, profile: { name: "Brad" } }, then: () => second.signIn("Brad") });
    await submit(byTestId("account-form"));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    expect(document.activeElement).toBe(byTestId("profile-chip"));
  });

  it("re-review L8: the resumed action runs only after the account dialog has left the page (a modal dialog makes everything behind it inert)", async () => {
    const server = fakeServer(null);
    await homepage(server.port);
    let dialogGoneWhenResumed: boolean | null = null;
    act(() => {
      requireAccount(() => (dialogGoneWhenResumed = byTestId("account-dialog") === null), "Log in or create an account to host a game.", { port: server.port });
    });
    await settle();
    expect(byTestId("account-dialog")).toBeTruthy();
    server.signIn("Brad");
    await act(async () => {
      await server.port.ensure(true);
    });
    act(() => accountSignedIn({ renew: () => undefined }));
    await settle();
    /* Ran once, and the dialog was already gone when it did (resumed inside accountSignedIn it would still be there). */
    expect(dialogGoneWhenResumed).toBe(true);
  });

  it("Create account (P3-ACCT POLICY): signed in at once, the recovery key shown ONCE, and the action resumes after the acknowledgement", async () => {
    const KEY = "rk_0123456789abcdefghjkmnpqr0.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const server = fakeServer(null);
    await homepage(server.port);
    await click(buttonNamed("Host game"));
    await click(byTestId("account-tab-create"));
    type(byTestId("account-username") as HTMLInputElement, "Ann");
    type(byTestId("account-password") as HTMLInputElement, "a long enough secret");
    type(byTestId("account-name") as HTMLInputElement, "Ann");
    server.queue("/gs/api/account/create", { status: 201, body: { ok: true, profile: { name: "Ann", otherSessions: 0 }, username: "Ann", recoveryKey: KEY }, then: () => server.signIn("Ann") });
    await submit(byTestId("account-form"));
    expect(server.calls.filter((call) => call.path === "/gs/api/account/create").map((call) => JSON.parse(call.body))).toEqual([{ username: "Ann", password: "a long enough secret", name: "Ann" }]);
    expect(byTestId("recovery-key-value")?.textContent).toBe(KEY);
    expect(byTestId("host-body")).toBeNull();
    await click(byTestId("recovery-key-saved"));
    await click(byTestId("recovery-key-continue"));
    expect(byTestId("host-body")).toBeTruthy();
    expect(all().innerHTML).not.toContain(KEY);
  });

  it("a wrong password and an unknown username are ONE sentence that names neither; a short password is refused before anything is sent", async () => {
    const server = fakeServer(null);
    await homepage(server.port);
    await click(byTestId("account-login"));
    for (const username of ["Brad.Player", "nobody-here"]) {
      type(byTestId("account-username") as HTMLInputElement, username);
      type(byTestId("account-password") as HTMLInputElement, "not the password");
      server.queue("/gs/api/account/login", { status: 403, body: { error: "invalid-credential" } });
      await submit(byTestId("account-form"));
      expect(byTestId("account-error")?.textContent).toBe("That username and password don't match an account. Check them and try again.");
      expect((byTestId("account-password") as HTMLInputElement).value).toBe("");
    }
    await click(byTestId("account-tab-create"));
    type(byTestId("account-username") as HTMLInputElement, "Cy");
    type(byTestId("account-password") as HTMLInputElement, "short");
    type(byTestId("account-name") as HTMLInputElement, "Cy");
    await submit(byTestId("account-form"));
    expect(byTestId("account-error")?.textContent).toBe("A password is at least 12 characters.");
    expect(server.calls.some((call) => call.path === "/gs/api/account/create")).toBe(false);
  });

  it("a profile made before accounts still gets in (its recovery key, under 'Other ways') -- never orphaned", async () => {
    const server = fakeServer(null);
    await homepage(server.port);
    await click(byTestId("account-login"));
    await click(byTestId("account-other-recovery"));
    type(byTestId("account-secret") as HTMLInputElement, "rk_0123456789abcdefghjkmnpqr0.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    server.queue("/gs/api/profile/recover", { status: 200, body: { ok: true, profile: { name: "Old" } }, then: () => server.signIn("Old") });
    await submit(byTestId("account-form"));
    expect(server.port.state).toBe("ready");
    expect(byTestId("account-dialog")).toBeNull();
  });

  it("signed in already: Host opens straight away -- no dialog, no password, no key", async () => {
    const server = fakeServer({ name: "Brad", otherSessions: 0 });
    await server.port.ensure();
    await homepage(server.port);
    await click(buttonNamed("Host game"));
    expect(byTestId("account-dialog")).toBeNull();
    expect(byTestId("host-body")).toBeTruthy();
    expect(server.calls.some((call) => /reauth|login|recover/.test(call.path))).toBe(false);
  });
});

describe("P3-ACCT: the Rules and the Terms (AUD-20.08), for everyone", () => {
  it("Rules opens from the homepage signed out", async () => {
    const server = fakeServer(null);
    await homepage(server.port);
    await click(byTestId("lobby-rules"));
    expect(byTestId("rules-page")).toBeTruthy();
    await click(byTestId("rules-close"));
    expect(byTestId("rules-page")).toBeNull();
  });

  it("review L3: the Terms are reachable signed out, before any money surface -- from the Rules", async () => {
    const server = fakeServer(null);
    await homepage(server.port);
    await click(byTestId("lobby-rules"));
    await click(byTestId("rules-terms-link"));
    expect(byTestId("terms-page")).toBeTruthy();
    expect(byTestId("terms-pending")?.textContent).toBe(TERMS_PENDING_SENTENCE);
    /* Re-review N7: closing the Terms goes back to the Rules it was opened from. */
    await click(byTestId("terms-close"));
    expect(byTestId("terms-page")).toBeNull();
    expect(byTestId("rules-page")).toBeTruthy();
  });

  it("the Terms page is a shell: it says the owner's terms are pending, and invents no legal prose", async () => {
    const server = fakeServer(null);
    await homepage(server.port);
    act(() => openInfoPage("terms"));
    await settle();
    const page = byTestId("terms-page");
    expect(page).toBeTruthy();
    expect(byTestId("terms-pending")?.textContent).toBe(TERMS_PENDING_SENTENCE);
    expect(page?.textContent).not.toMatch(/\b(agree|agreement|liab|warrant|indemn|jurisdiction|governing law|binding|arbitration|you must|you shall)/i);
  });

  it("every money/deposit surface links the Terms", () => {
    for (const file of ["components/money/MoneyPanel.tsx", "components/money/HostStakeSection.tsx", "components/SandboxWaitingRoom.tsx", "components/money/YourDeposits.tsx", "components/money/SettlementBand.tsx", "components/InfoPages.tsx"]) {
      expect([file, readStripped(file).includes("<TermsLink")]).toEqual([file, true]);
    }
  });
});

describe("P3-ACCT: trust facts -- facts under three headings, never a score, never an id", () => {
  it("each seat's facts, grouped; 'established opponents' is the server's count (P3-ACCT POLICY); a malformed answer shows nothing", async () => {
    const port = scriptedPort();
    port.answer("trust/table", 200, {
      ok: true,
      seats: [
        { playerId: "p-me", facts: { memberSince: "2026-09", accountAgeDays: 28, completedMoneyGames: 3, unresolvedDisputes: 0, disputedGames: 1, inactivityExits: 0, walletVerified: true, walletVerifiedSince: "2026-09", establishedOpponents: 2 } },
        { playerId: "p-other", facts: { memberSince: "2026-09-01", accountAgeDays: 1, completedMoneyGames: 0, unresolvedDisputes: 0, disputedGames: 0, inactivityExits: 0, walletVerified: false, walletVerifiedSince: null, establishedOpponents: null } },
      ],
    });
    act(() =>
      root.render(
        <TableTrustFacts
          gameId="g_table"
          port={port}
          players={[
            { id: "p-me", nickname: "Brad" },
            { id: "p-other", nickname: "Ana" },
          ]}
        />,
      ),
    );
    await settle();
    const box = byTestId("table-trust-facts");
    expect(box?.textContent).toContain(TRUST_FACTS_DISCLAIMER);
    const mine = byTestId("trust-facts-p-me");
    expect(Array.from(mine?.querySelectorAll("dt") ?? []).map((dt) => dt.textContent)).toEqual(["Profile history", "Prior relationships", "Identity assurance"]);
    expect(mine?.textContent).toContain("Member since 2026-09 (about 4 weeks)");
    expect(mine?.textContent).toContain("3 completed real-money games");
    expect(mine?.textContent).toContain("Disputes: 0 unresolved now · 1 closed by the resolver");
    expect(mine?.textContent).toContain("Wallet verified since 2026-09");
    expect(byTestId("trust-facts-p-me-relationships")?.textContent).toBe("2 established opponents (completed real-money games together)");
    expect(byTestId("trust-facts-p-other")).toBeNull(); // malformed (an exact day, review L4): dropped, never guessed
    expect(box?.textContent).not.toMatch(/score|rating:|trust level|\d+\s*\/\s*\d+/i);
    expect(ID_PATTERN.test(box?.innerHTML ?? "")).toBe(false);
    expect(box?.innerHTML).not.toMatch(/juno1/);
    expect(port.requests).toEqual([{ path: "trust/table", body: { gameId: "g_table" } }]);
  });
});
