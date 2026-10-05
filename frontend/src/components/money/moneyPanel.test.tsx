/** @jest-environment jsdom */
//
// ESCROW-4 (brief §14, §24): the waiting room's money panel, rendered. Each stage shows its own words and only its
// legal buttons; a device without Keplr says why it can't fund (and can still play); "Confirm it's you" names this app
// and site; the terms are on the panel in full before the Ante (P3-ACCT: the one button); the waiting room routes a
// money table to this panel (no Ready, no "refunds ante"); the result's placeholder payout is gone; signing out warns
// about keys.

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { MoneyPanel } from "./MoneyPanel";
import { SettlementBand } from "./SettlementBand";
import { GameOverModal } from "../GameOverModal";
import { ModalLayerHost } from "../ModalPortal";
import { ProfileMenu } from "../ProfileMenu";
import { installMoneyServicesForTests, updateMoneySession } from "../../money/moneySession";
import { createConsentKeys, installConsentKeysForTests, memoryConsentKeyVault } from "../../money/consentKeys";
import { linked, moneyView, scriptedPort, testServices, T0, TEST_CONTRACT, TEST_WALLET } from "../../money/moneyTestSupport";
import { resolveVariants } from "../../gameEngine/gameVariants";
import { httpSessionPort } from "../../utils/sessionBootstrap";
import type { RoomView } from "../../utils/roomProtocol";
import type { RoomMoneyView } from "../../utils/moneyProtocol";
import { readShell, readStripped } from "../../utils/sourceScan";
import { formatMoneyTime } from "../../money/moneyTime";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
global.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  installMoneyServicesForTests(null);
  installConsentKeysForTests(null);
});

const settle = async () => {
  await act(async () => {
    for (let n = 0; n < 30; n += 1) await Promise.resolve();
  });
};
const render = async (element: React.ReactElement) => {
  act(() => root.render(element));
  await settle();
};
const byTestId = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const click = async (element: Element | null) => {
  expect(element).toBeTruthy();
  act(() => (element as HTMLElement).click());
  await settle();
};

function room(money: RoomMoneyView, role: "host" | "player" = "player"): RoomView {
  return {
    gameId: "g_table",
    code: "JUNO-AAAA-BBBB",
    joinable: true,
    visibility: "public",
    status: "waiting",
    lifecycle: "waiting",
    closed: false,
    held: false,
    holdKind: null,
    hostId: role === "host" ? "p-me" : "p-other",
    players: [
      { id: "p-me", nickname: "Brad", isReady: false, online: true },
      { id: "p-other", nickname: "Ana", isReady: false, online: true },
    ],
    playerCount: 2,
    seatCap: 2,
    variants: resolveVariants({} as never),
    createdAtMs: T0,
    undoPolicy: { host_undo: "none" },
    you: { role, playerId: "p-me", kicked: false, canStart: false },
    money,
  };
}

describe("ESCROW-4: the money panel", () => {
  it("a device without Keplr: the terms, the reason, no wallet button -- and nothing blocks play", async () => {
    const services = testServices();
    services.wallet.present = false;
    installMoneyServicesForTests(services);
    updateMoneySession({ wallet: "unavailable" });
    await render(<MoneyPanel room={room(moneyView())} onStart={() => undefined} services={services} />);
    expect(byTestId("money-stake-strip")?.textContent).toMatch(/1 JUNOX per seat.*Juno testnet \(uni-7\).*1% fee.*0 of 2 funded/);
    expect(byTestId("money-blocker")?.textContent).toMatch(/Keplr isn't available in this browser\. You can keep playing here/);
    expect(byTestId("money-action-connect")).toBeNull();
  });

  it("P3-ACCT: one Ante press -- Keplr connects, and only when the server asks (a NEW wallet) 'Confirm it's you' (this app, this site) with the PASSWORD; then the Ante carries on by itself", async () => {
    const services = testServices();
    installMoneyServicesForTests(services);
    act(() => updateMoneySession({ wallet: "disconnected", address: null, confirmedUntil: null }));
    const port = scriptedPort();
    port.answer("money/wallet-challenge", 403, { error: "reauth-required", reason: "Confirm it's you first." });
    port.answer("account/me", 200, { ok: true, account: { name: "Brad", otherSessions: 0, username: "Brad.Player", recoveryKey: false, wallet: null, memberSince: T0 } });
    port.answer("profile/reauth", 200, { ok: true, expiresAt: T0 + 5 * 60 * 1000 });
    const view = moneyView({ escrow: { chainGameId: "7", state: "FUNDING", fundingDeadline: T0 + 3_600_000 } });
    await render(<MoneyPanel room={room(view)} onStart={() => undefined} services={services} port={port} />);
    expect(byTestId("money-headline")?.textContent).toMatch(/A real-money table: 1 JUNOX per seat/);
    /* W2-K (OD-9(b)): the official Keplr logo is pending -- the button is its words alone, no stand-in mark. */
    expect(byTestId("money-action-ante")?.textContent).toBe("Ante 1 JUNOX");
    expect(container.querySelector('[data-testid="keplr-mark"]')).toBeNull();
    /* The terms are on the panel before the press, with the Terms page linked (AUD-20.08). */
    expect(byTestId("money-compact-terms")?.textContent).toMatch(/You send 1 JUNOX · escrow fee 0\.01 JUNOX \(not refunded\)/);
    expect(byTestId("money-compact-terms")?.querySelector('[data-testid="terms-link"]')?.textContent).toBe("Terms");
    await click(byTestId("money-action-ante"));
    expect(services.wallet.calls).toContain("connect");
    expect(byTestId("money-reauth-origin")?.textContent).toMatch(/This is Project 18XX at http:\/\/localhost\. Only enter your password on this site\./);
    expect(container.textContent).toContain("To use this wallet here, enter your password.");
    const key = byTestId("money-reauth-key") as HTMLInputElement;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(key, "correct horse battery");
      key.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(byTestId("money-reauth-confirm"));
    /* The password went once, in the POST body; the Ante then carried on by itself: a fresh challenge. */
    expect(port.requests.map((request) => request.path)).toEqual(["money/wallet-challenge", "account/me", "profile/reauth", "money/wallet-challenge"]);
    expect(port.requests[2].body).toEqual({ password: "correct horse battery" });
    expect(port.requests[3].body).toEqual({ gameId: "g_table", wallet: TEST_WALLET });
    expect(byTestId("money-reauth-form")).toBeNull();
    /* Nothing scripted for that challenge: the panel says the server didn't answer; Keplr was never asked to sign. */
    expect(byTestId("money-error")?.textContent).toMatch(/didn't answer/);
    expect(services.wallet.calls.some((call) => call.startsWith("signLink"))).toBe(false);
    expect(container.innerHTML).not.toContain("correct horse battery");
    act(() => updateMoneySession({ confirmedUntil: null }));
  });

  it("a joiner's full terms show every term before the Ante (the compact line above them; Keplr shows the transaction)", async () => {
    const services = testServices();
    installMoneyServicesForTests(services);
    updateMoneySession({ wallet: "connected", address: TEST_WALLET });
    const view = moneyView({ escrow: { chainGameId: "7", state: "FUNDING", fundingDeadline: T0 + 3_600_000 }, terms: { anteNet: "990000", pot: "1980000" }, you: linked([], { actions: ["deposit", "link-wallet"] }) });
    await render(<MoneyPanel room={room(view)} onStart={() => undefined} services={services} />);
    expect(byTestId("money-action-ante")?.textContent).toBe("Ante 1 JUNOX");
    expect(byTestId("money-compact-terms")?.textContent).toMatch(/You send 1 JUNOX · escrow fee 0\.01 JUNOX \(not refunded\) · pot when full 1\.98 JUNOX · winnings go to juno12gdm…783a/);
    const review = byTestId("money-review");
    expect(review?.closest("details")?.getAttribute("data-testid")).toBe("money-full-terms");
    expect(review?.textContent).toMatch(/You send1 JUNOX from juno12gdm…783a/);
    expect(review?.textContent).toMatch(/Into the pot0\.99 JUNOX/);
    expect(byTestId("money-review-fee")?.textContent).toBe("0.01 JUNOX — not refunded");
    expect(review?.textContent).toMatch(/Pot when full1\.98 JUNOX \(2 seats\)/);
    expect(byTestId("money-review-contract")?.textContent).toBe(TEST_CONTRACT);
    expect(review?.textContent).toMatch(/Deposits on Juno are public/);
  });

  it("funded: withdraw asks first and says what comes back; the host's Start is the room's own Start", async () => {
    const services = testServices();
    installMoneyServicesForTests(services);
    let started = 0;
    const view = moneyView({
      escrow: { chainGameId: "7", state: "FUNDED", fundedSeats: 2 },
      terms: { anteNet: "990000", pot: "1980000" },
      start: { state: "ready", blocker: null, canStart: true },
      you: linked([], { funding: "funded", payoutWallet: TEST_WALLET, chainSeatIndex: 0, actions: ["withdraw", "cancel-escrow", "start"] }),
    });
    await render(<MoneyPanel room={room(view, "host")} onStart={() => (started += 1)} services={services} />);
    expect(byTestId("money-headline")?.textContent).toMatch(/^Ante confirmed — 1 JUNOX from juno12gdm…783a/);
    await click(byTestId("money-action-withdraw"));
    expect(byTestId("money-exit-confirm")?.textContent).toMatch(/You get 0\.99 JUNOX back to juno12gdm…783a; 0\.01 JUNOX isn't returned/);
    await click(Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Keep it") ?? null);
    await click(byTestId("money-action-start"));
    expect(started).toBe(1);
  });
});

describe("ESCROW-4: the waiting room, the result, the profile menu", () => {
  it("the waiting room routes a money seat to the panel: no Ready, funding in the roster, the real stake, no 'refunds ante'", () => {
    const waiting = readStripped("components/SandboxWaitingRoom.tsx");
    expect(waiting).toContain("money !== null && room !== null ? (");
    expect(waiting).toContain("<MoneyPanel room={room} onStart={onStart} busy={busy} />");
    expect(waiting).toContain("fundingTag(money.seats.find((seat) => seat.playerId === player.id)?.funding ?? \"none\")");
    expect(waiting).toContain('label="Stake"');
    expect(waiting).not.toContain("refunds ante");
    /* The hosted Start is shell behaviour (the room handlers), so it is read through the shell source set:
       it keeps being checked when the handler moves out of `App.tsx` (APP-TEST-0A). */
    const shell = readShell();
    expect(shell).toContain("if (sandboxRoom.money == null && !canStartSandboxGame(sandboxRoom, MIN_PLAYERS)) return;");
  });

  it("the result keeps no placeholder payout; a real-money table's band sits under the final standings", async () => {
    const standings = [{ address: "0xa", label: "Ann", cash: 100, stockValue: 400, privateValue: 0, netWorth: 500, rank: 1, isWinner: true, isBankrupt: false, expectedPayout: 60 }];
    const services = testServices();
    installMoneyServicesForTests(services);
    /* The layer is committed before the dialog, on a root of its own (as `GameRouter` does). */
    const layerHost = document.createElement("div");
    document.body.appendChild(layerHost);
    const layerRoot = createRoot(layerHost);
    act(() => layerRoot.render(<ModalLayerHost />));
    const band = <SettlementBand room={room(moneyView({ you: linked([], { funding: "funded", chainSeatIndex: 0, payoutWallet: TEST_WALLET }), settlement: { status: "paid", phase: "closed", chainState: "SETTLED", seq: "9", settleDigest: null, domain: null, source: null, windowEnd: null, livenessAvailableAt: null, resolverTimeoutAt: null, consentedSeats: [], payable: null, amounts: ["1500000", "480000"], route: "settle", trustedSeq: null, annulSigned: [], lastCheckpoint: null, bond: null } }))} services={services} />;
    await render(<GameOverModal reason="bank-broken" standings={standings} viewerAddress="0xa" bankruptLabel={null} onDismiss={() => undefined} onCloseRoom={null} autoCloseIn={null} roomClosed={false} money={band} />);
    const text = document.body.textContent ?? "";
    expect(text).not.toContain("Payout estimated");
    expect(text).not.toContain("$60.00");
    expect(text).not.toContain("settle the payout");
    expect(document.body.querySelector('[data-testid="settlement-headline"]')?.textContent).toBe("Paid: 1.5 JUNOX sent to juno12gdm…783a.");
    act(() => root.render(<></>));
    act(() => layerRoot.unmount());
    layerHost.remove();
  });

  it("signing out warns when this browser holds signing keys, and removes them by default", async () => {
    const vault = memoryConsentKeyVault();
    vault.records.set(`02${"11".repeat(32)}`, { v: 1, pubkey: `02${"11".repeat(32)}`, privkey: "22".repeat(32), chainId: "uni-7", contract: TEST_CONTRACT, gameId: "g", playerId: "p", wallet: TEST_WALLET, createdAt: T0 });
    installConsentKeysForTests(createConsentKeys(vault));
    const calls: string[] = [];
    const port = httpSessionPort({
      endpoint: "https://play.example/gs/api/session",
      fetch: async (input) => {
        const where = new URL(input).pathname;
        calls.push(where);
        if (where === "/gs/api/session") return { status: 200, json: async () => ({ ok: true, expiresAt: 1, profile: { name: "Brad", otherSessions: 0 } }) };
        return { status: 204, json: async () => ({}) };
      },
    });
    await port.ensure();
    const realLocation = window.location;
    delete (window as unknown as { location?: Location }).location;
    (window as unknown as { location: unknown }).location = { ...realLocation, reload: () => undefined };
    try {
      await render(<ProfileMenu port={port} />);
      await click(byTestId("profile-chip"));
      await click(byTestId("profile-menu-signout"));
      expect(byTestId("profile-signout-keys")?.textContent).toMatch(/holds the signing key for 1 real-money seat/);
      expect((byTestId("profile-signout-remove-keys") as HTMLInputElement).checked).toBe(true);
      await click(byTestId("profile-signout-confirm"));
      expect(vault.records.size).toBe(0);
      expect(calls).toContain("/gs/api/session/revoke");
    } finally {
      (window as unknown as { location: Location }).location = realLocation;
    }
  });
});

describe("PHASE 3 W2-K: money times and the panel's place in the waiting room", () => {
  it("every money time on the panel is local time with its zone, from the one formatter -- never a bare HH:MM", async () => {
    const services = testServices();
    installMoneyServicesForTests(services);
    updateMoneySession({ wallet: "connected", address: TEST_WALLET });
    const deadline = T0 + 3_600_000;
    const view = moneyView({ escrow: { chainGameId: "7", state: "FUNDING", fundingDeadline: deadline }, terms: { anteNet: "990000", pot: "1980000" }, you: linked([], { actions: ["deposit", "link-wallet"] }) });
    await render(<MoneyPanel room={room(view)} onStart={() => undefined} services={services} />);
    const local = formatMoneyTime(deadline, { now: T0 });
    expect(local).not.toBe("");
    expect(byTestId("money-stake-strip")?.textContent).toContain(`· funding closes ${local}`);
    expect(byTestId("money-review")?.textContent).toContain(`Funding closes${local}`);
    /* A bare clock -- minutes followed by nothing, a full stop or the strip's separator -- appears nowhere. */
    expect(container.textContent).not.toMatch(/closes ?(at )?\d{1,2}:\d\d(?:$|[.·]|\s*(?:·|$))/m);
  });

  it("is a region of the waiting room: its section label, no boxed surface, the room's focus ring and touch floor", async () => {
    const services = testServices();
    installMoneyServicesForTests(services);
    act(() => updateMoneySession({ wallet: "disconnected", address: null, confirmedUntil: null }));
    await render(<MoneyPanel room={room(moneyView())} onStart={() => undefined} services={services} />);
    const panel = byTestId("money-panel") as HTMLElement;
    expect(panel.getAttribute("aria-label")).toBe("Your deposit");
    expect(panel.classList.contains("money-seat-panel")).toBe(true);
    expect(panel.style.backgroundColor).toBe("");
    expect(panel.style.border).toBe("");
    expect(panel.querySelector("p")?.textContent).toBe("Your deposit");
    expect(panel.querySelector("style")?.textContent).toMatch(/\.money-seat-panel summary:focus-visible[\s\S]*outline: 2px solid #8a8a86; outline-offset: 2px;/);
    const buttons = Array.from(panel.querySelectorAll("button"));
    expect(buttons.length).toBeGreaterThan(0);
    expect(buttons.every((button) => button.classList.contains("wr-touch"))).toBe(true);
  });
});
