/** @jest-environment jsdom */
//
// ==================================================================
//  PHASE 3 FINAL (§9 / §12): AN OPEN TABLE NEVER BECOMES SOMEBODY ELSE SILENTLY
// ==================================================================
//
// `utils/tableAccountGuard.ts` and `components/TableAccountNotice.tsx`, driven directly. What is pinned:
//
//   the KEY is the session's account -- a visitor; an account by its username (NFKC, lower case: the server's own
//   canonical form, so a renamed display name is the same account and two accounts sharing a display name are not);
//   the development stand-in by its name; "unknown" (bootstrapping) and "ended" (the session-ended notice's business)
//   are not answers;
//   the HOOK takes the first answer while the table is open as the account it was opened as; a different account is a
//   change {from, to}; signed out is a change to null; `accept()` makes the browser's account now the table's; an
//   inactive guard (a Watch tab, or no table open) never reports a change;
//   A KEPLR ACCOUNT SWITCH NEVER PRODUCES A CHANGE: the hook reads the session and nothing else (owner ruling: a wallet
//   is not who anyone is);
//   the NOTICE says who the table was opened as and who the browser is now, and offers exactly two ways on; it cannot
//   be dismissed;
//   the SHELL wires it to the waiting room and the table (never a Watch tab) and refuses every move while it is up.

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { ACCOUNT_CHANGED_NO_SEND, tableAccountKey, useTableAccountGuard, type TableAccountChange, type TableAccountGuard } from "./tableAccountGuard";
import { httpSessionPort, type SessionAccount, type SessionPort, type SessionState } from "./sessionBootstrap";
import { useSession } from "./useSession";
import { occurrences, readShell, readStripped } from "./sourceScan";
import { TableAccountNotice, tableAccountSentence } from "../components/TableAccountNotice";
import { ModalLayerHost } from "../components/ModalPortal";
import { installMoneyServicesForTests, moneySession, updateMoneySession } from "../money/moneySession";
import { OTHER_WALLET, TEST_WALLET, testServices } from "../money/moneyTestSupport";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
global.IS_REACT_ACT_ENVIRONMENT = true;

const account = (name: string, username?: string, over: Partial<SessionAccount> = {}): SessionAccount => ({ name, otherSessions: 0, ...(username === undefined ? {} : { username }), ...over });
const BRAD = account("Brad", "Brad.Player");
const ANN = account("Ann", "Ann.Player");
type View = { state: SessionState; account: SessionAccount | null };
const ready = (who: SessionAccount): View => ({ state: "ready", account: who });
const VISITOR: View = { state: "unprofiled", account: null };
const UNKNOWN: View = { state: "unknown", account: null };
const ENDED: View = { state: "ended", account: null };

let container: HTMLDivElement;
let root: Root;
let layerHost: HTMLDivElement | null = null;
let layerRoot: Root | null = null;
beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  act(() => layerRoot?.unmount());
  layerHost?.remove();
  layerRoot = null;
  layerHost = null;
  installMoneyServicesForTests(null);
});

describe("tableAccountKey: which account a session view is", () => {
  it("a visitor; an account by its canonical username; the development stand-in by its name; bootstrapping and ended are no answer", () => {
    expect(tableAccountKey("unprofiled", null)).toBe("visitor");
    expect(tableAccountKey("ready", BRAD)).toBe("account:brad.player");
    /* The server's canonical form: NFKC, lower case -- the same account however its username was typed. */
    expect(tableAccountKey("ready", account("Brad", "BRAD.PLAYER"))).toBe("account:brad.player");
    expect(tableAccountKey("ready", account("Brad", "Ｂｒａｄ.Player"))).toBe("account:brad.player");
    /* A display name is not who anyone is: a renamed account is the same key; two accounts sharing a name are not. */
    expect(tableAccountKey("ready", account("Bradley", "Brad.Player"))).toBe(tableAccountKey("ready", BRAD));
    expect(tableAccountKey("ready", account("Brad", "Other.Brad"))).not.toBe(tableAccountKey("ready", BRAD));
    /* The always-ready development port names no username: its stand-in is keyed by name. */
    expect(tableAccountKey("ready", account("Development", undefined, { development: true }))).toBe("name:Development");
    expect(tableAccountKey("ready", account("Brad", ""))).toBe("name:Brad");
    expect(tableAccountKey("unknown", null)).toBeNull();
    expect(tableAccountKey("ended", null)).toBeNull();
    expect(tableAccountKey("unknown", BRAD)).toBeNull();
    expect(tableAccountKey("ready", null)).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* The hook                                                            */
/* ------------------------------------------------------------------ */

let guard: TableAccountGuard | null = null;
function Probe({ view, active }: { view: View; active: boolean }) {
  guard = useTableAccountGuard(view, active);
  return null;
}
const show = (view: View, active = true) => act(() => root.render(<Probe view={view} active={active} />));
const change = (): TableAccountChange | null => guard?.change ?? null;

describe("useTableAccountGuard: the account the table was opened as, and a change of it", () => {
  beforeEach(() => {
    guard = null;
  });

  it("the first answer while the table is open is the baseline; the same account (renamed, other devices) is no change; another account is {from, to}", () => {
    show(UNKNOWN);
    expect(change()).toBeNull(); // bootstrapping: no baseline yet
    show(ready(BRAD));
    expect(change()).toBeNull();
    show(ready(account("Brad", "Brad.Player", { otherSessions: 3 })));
    expect(change()).toBeNull();
    show(ready(account("Bradley", "Brad.Player")));
    expect(change()).toBeNull();
    show(ready(ANN));
    expect(change()).toEqual({ from: "Brad", to: "Ann" });
  });

  it("two accounts that share a display name are two accounts", () => {
    show(ready(BRAD));
    show(ready(account("Brad", "Another.Brad")));
    expect(change()).toEqual({ from: "Brad", to: "Brad" });
  });

  it("signed out in another tab: a change to null; opened signed out and then signed in: a change from null", () => {
    show(ready(BRAD));
    show(VISITOR);
    expect(change()).toEqual({ from: "Brad", to: null });
    act(() => root.unmount());
    root = createRoot(container);
    show(VISITOR);
    expect(change()).toBeNull();
    show(ready(ANN));
    expect(change()).toEqual({ from: null, to: "Ann" });
  });

  it("bootstrapping and an ended session are not answers: they change nothing, either way", () => {
    show(ready(BRAD));
    show(UNKNOWN);
    expect(change()).toBeNull();
    show(ENDED);
    expect(change()).toBeNull();
    show(ready(BRAD));
    expect(change()).toBeNull();
  });

  it("accept() makes the browser's account now the table's -- and a later change is measured from it", () => {
    show(ready(BRAD));
    show(ready(ANN));
    expect(change()).toEqual({ from: "Brad", to: "Ann" });
    act(() => guard!.accept());
    expect(change()).toBeNull();
    show(ready(ANN));
    expect(change()).toBeNull();
    show(ready(BRAD));
    expect(change()).toEqual({ from: "Ann", to: "Brad" });
  });

  it("inactive (a Watch tab, or no table open) never reports a change -- and re-opening takes a fresh baseline", () => {
    show(ready(BRAD), false);
    expect(change()).toBeNull();
    show(ready(ANN), false);
    expect(change()).toBeNull();
    show(VISITOR, false);
    expect(change()).toBeNull();
    /* Opened again (active): its first answer is the baseline -- the earlier, inactive views left none behind. */
    show(ready(ANN), true);
    expect(change()).toBeNull();
    show(ready(BRAD), true);
    expect(change()).toEqual({ from: "Ann", to: "Brad" });
    /* Closed (inactive) with a change pending: the change goes with it. */
    show(ready(BRAD), false);
    expect(change()).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* A Keplr switch is not an account change                              */
/* ------------------------------------------------------------------ */

const ENDPOINT = "https://play.example/gs/api/session";

/** The real port and the real `useSession`, over a fake bootstrap answering the CURRENT profile. */
function sessionWorld(initial: { name: string; otherSessions: number; username?: string }) {
  let profile: { name: string; otherSessions: number; username?: string } | null = initial;
  const port = httpSessionPort({
    endpoint: ENDPOINT,
    replacedRetryMs: 0,
    fetch: async (input) => {
      if (new URL(input).pathname !== "/gs/api/session") throw new Error(`unexpected ${input}`);
      return { status: 200, json: async () => ({ ok: true, expiresAt: 1, profile }) };
    },
  });
  return {
    port,
    setProfile: (next: typeof profile) => {
      profile = next;
    },
  };
}

function LiveProbe({ port, active = true }: { port: SessionPort; active?: boolean }) {
  guard = useTableAccountGuard(useSession(port), active);
  return null;
}
const flush = () =>
  act(async () => {
    for (let n = 0; n < 20; n += 1) await Promise.resolve();
  });

describe("a Keplr account switch never changes who plays at the table (owner ruling: a wallet is not the player)", () => {
  it("Keplr's account-change event and a different wallet on this page produce no change; a real account change still does (the probe is live)", async () => {
    guard = null;
    const services = testServices();
    installMoneyServicesForTests(services);
    const world = sessionWorld({ name: "Brad", otherSessions: 0, username: "Brad.Player" });
    await act(async () => {
      await world.port.ensure();
    });
    act(() => root.render(<LiveProbe port={world.port} />));
    await flush();
    expect(change()).toBeNull();
    /* Keplr switches account: its window event, the page's money session following it, and the wallet itself. */
    act(() => {
      updateMoneySession({ wallet: "connected", address: TEST_WALLET });
    });
    act(() => {
      services.wallet.address = OTHER_WALLET;
      window.dispatchEvent(new Event("keplr_keystorechange"));
      updateMoneySession({ wallet: "connected", address: OTHER_WALLET });
    });
    await flush();
    expect(moneySession().address).toBe(OTHER_WALLET);
    expect(change()).toBeNull();
    /* Nothing asked the server either: the session is not re-read on a Keplr switch. */
    expect(world.port.state).toBe("ready");
    expect(world.port.account?.username).toBe("Brad.Player");
    /* THE NEGATIVE CONTROL: another tab signs this browser in as an account with the SAME display name -- the
       session's username differs, `useSession` re-renders on it, and the guard says so. */
    world.setProfile({ name: "Brad", otherSessions: 0, username: "Another.Brad" });
    await act(async () => {
      await world.port.ensure(true);
    });
    await flush();
    expect(change()).toEqual({ from: "Brad", to: "Brad" });
  });

  it("the guard's source reads the session only -- nothing about Keplr, wallets, the money session or window events", () => {
    const code = readStripped("utils/tableAccountGuard.ts");
    for (const banned of ["keplr", "Keplr", "wallet", "Wallet", "moneySession", "addEventListener", "window."]) {
      expect([banned, code.includes(banned)]).toEqual([banned, false]);
    }
    expect(code).toContain('import type { SessionAccount, SessionState } from "./sessionBootstrap";');
  });
});

/* ------------------------------------------------------------------ */
/* The notice                                                          */
/* ------------------------------------------------------------------ */

function mountLayer() {
  layerHost = document.createElement("div");
  document.body.appendChild(layerHost);
  layerRoot = createRoot(layerHost);
  act(() => layerRoot!.render(<ModalLayerHost />));
}
const byTestId = <T extends HTMLElement = HTMLElement>(id: string) => document.body.querySelector(`[data-testid="${id}"]`) as T | null;

describe("TableAccountNotice: asked, never assumed", () => {
  it("renders nothing without a change", () => {
    mountLayer();
    act(() => root.render(<TableAccountNotice change={null} onContinue={() => undefined} onLeave={() => undefined} />));
    expect(byTestId("table-account-notice")).toBeNull();
    expect(container.innerHTML).toBe("");
  });

  it("another account: says who the table was opened as and who the browser is now; Continue as them, or Back to the lobby; never dismissible", () => {
    mountLayer();
    const calls: string[] = [];
    act(() => root.render(<TableAccountNotice change={{ from: "Brad", to: "Ann" }} onContinue={() => calls.push("continue")} onLeave={() => calls.push("lobby")} />));
    const notice = byTestId("table-account-notice");
    expect(notice).toBeTruthy();
    expect(notice?.getAttribute("closedby")).toBe("none");
    expect(notice?.getAttribute("role")).toBe("alertdialog");
    expect(notice?.querySelector("#table-account-title")?.textContent).toBe("You're now signed in as Ann");
    expect(notice?.querySelector("#table-account-text")?.textContent).toBe(
      "This table was opened as Brad, but this browser is now signed in as Ann (another tab changed account). Nothing was sent as either account. Continue to see this table as Ann — their seat if they have one — or go back to the lobby.",
    );
    expect(Array.from(notice?.querySelectorAll("button") ?? []).map((button) => [button.getAttribute("data-testid"), button.textContent])).toEqual([
      ["table-account-continue", "Continue as Ann"],
      ["table-account-lobby", "Back to the lobby"],
    ]);
    act(() => byTestId("table-account-continue")!.click());
    act(() => byTestId("table-account-lobby")!.click());
    expect(calls).toEqual(["continue", "lobby"]);
  });

  it("signed out in another tab: 'You signed out in another tab', Keep watching or Back to the lobby", () => {
    mountLayer();
    const out: TableAccountChange = { from: "Brad", to: null };
    act(() => root.render(<TableAccountNotice change={out} onContinue={() => undefined} onLeave={() => undefined} />));
    expect(byTestId("table-account-notice")?.querySelector("#table-account-title")?.textContent).toBe("You signed out in another tab");
    expect(tableAccountSentence(out)).toBe(
      "This table was opened as Brad, but this browser is now signed out (another tab signed out). Nothing was sent as either account. You can keep watching signed out, or go back to the lobby.",
    );
    expect(byTestId("table-account-continue")?.textContent).toBe("Keep watching");
    expect(byTestId("table-account-lobby")?.textContent).toBe("Back to the lobby");
  });

  it("opened signed out: the sentence says so", () => {
    expect(tableAccountSentence({ from: null, to: "Ann" })).toBe(
      "This table was opened while signed out, but this browser is now signed in as Ann (another tab changed account). Nothing was sent as either account. Continue to see this table as Ann — their seat if they have one — or go back to the lobby.",
    );
  });
});

/* ------------------------------------------------------------------ */
/* The shell's wiring                                                  */
/* ------------------------------------------------------------------ */

describe("the shell asks at the waiting room and the table -- never in a Watch tab -- and sends nothing meanwhile", () => {
  it("is wired to the session, active only for a seat-holding table, shown twice, and gates every send", () => {
    const shell = readShell();
    expect(shell).toContain("const sessionView = useSession();");
    expect(shell).toContain("useTableAccountGuard(sessionView, sandbox && sandboxRoomCode !== null && !watchOnly)");
    expect(occurrences(shell, "<TableAccountNotice change={tableAccount.change} onContinue={tableAccount.accept} onLeave={handleLeaveTableToLobby} />")).toHaveLength(2);
    expect(shell).toMatch(/boardSendRefusalRef\.current = \(\) => \(tableAccountChangeRef\.current !== null \? ACCOUNT_CHANGED_NO_SEND :/);
    expect(ACCOUNT_CHANGED_NO_SEND).toBe("This browser's account changed in another tab. Choose how to continue before you play.");
  });
});
