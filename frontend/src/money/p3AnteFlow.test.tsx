/** @jest-environment jsdom */
//
// ==================================================================
//  PHASE 3 (P3-ACCT): "ANTE X JUNO" -- ONE BUTTON, AND KEPLR ONE TAB AT A TIME (W1-K, AUD-19.02)
// ==================================================================
//
// The one-button ante, driven through its real orchestrator (`anteNow`) and its real hook and panel, against a fake
// Keplr that records every request in order, in-memory keys and a scripted server. No real Keplr, no chain.
//
//   the statuses, in the owner's words, in order: Connecting wallet… -> Verifying wallet… -> Waiting for deposit…;
//   the Keplr prompts, in order and counted: first table -- connect, ONE link signature, ONE transaction; a returning
//   player antes from the account's Authorization Wallet, or within five minutes of signing in -- no password (PHASE 3
//   FINAL: there is no recovery key at all): one link signature, one transaction;
//   the deposit is sent FROM the seat's verified wallet (the wallet the frozen roster pays: server-side test);
//   cancelling in Keplr stops it safely (nothing linked, nothing sent) and pressing again resumes;
//   a double click is one Ante; two tabs pressing at once open Keplr once (the other is told, never queued).

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { anteNow, type AnteHooks } from "./moneyActions";
import { ANTE_STATUS } from "./moneyFlow";
import { installMoneyServicesForTests, moneySession, updateMoneySession, type MoneyServices } from "./moneySession";
import { createKeplrLock, KEPLR_BUSY_SENTENCE, type LockManagerLike } from "./keplrLock";
import { linked, moneyView, scriptedPort, testServices, T0, TEST_CONTRACT, TEST_WALLET, TICKET, type FakeWallet } from "./moneyTestSupport";
import { walletLinkChallengeText } from "../gameEngine/escrow/walletLinkChallengeV1";
import { resolveVariants } from "../gameEngine/gameVariants";
import { MoneyPanel } from "../components/money/MoneyPanel";
import type { RoomMoneyView } from "../utils/moneyProtocol";
import type { RoomView } from "../utils/roomProtocol";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
global.IS_REACT_ACT_ENVIRONMENT = true;
/* jsdom has no TextEncoder; the fake Keplr's signed bytes need one (the browser and Node both have it). */
if (typeof (global as { TextEncoder?: unknown }).TextEncoder === "undefined") (global as { TextEncoder?: unknown }).TextEncoder = require("util").TextEncoder;

const SITE = "http://localhost";
const challenge = (wallet: string = TEST_WALLET) => ({
  ok: true,
  text: walletLinkChallengeText({ appName: "Project 18XX", site: SITE, chainId: "uni-7", contract: TEST_CONTRACT, gameId: "g_table", playerId: "p-me", wallet, nonce: "ab".repeat(16), expiresAt: T0 + 300_000 }),
  nonce: "ab".repeat(16),
  expiresAt: T0 + 300_000,
  replaces: null,
});

/** What Keplr was asked that a player sees: the connect, each message signature, each transaction. */
const prompts = (wallet: FakeWallet) => wallet.calls.filter((call) => call === "connect" || call.startsWith("signLink") || call.startsWith("signTx"));

const hostTable = (over: Partial<RoomMoneyView> = {}) => moneyView({ you: { ...linked([]), link: null, funding: "none", actions: ["link-wallet"] }, ...over });
/** The server's next view once the link landed: the host may open the escrow. */
const hostLinked = (consentKey: string) => moneyView({ you: linked([consentKey], { actions: ["open-escrow", "link-wallet"] }) });

function hooksFor(next: () => RoomMoneyView | null, statuses: string[], initial: RoomMoneyView): AnteHooks {
  let current: RoomMoneyView = initial;
  return {
    status: (text) => statuses.push(text),
    latest: () => current,
    proof: null,
    waitFor: async (predicate) => {
      const pushed = next();
      if (pushed !== null) current = pushed;
      return predicate(current) ? current : null;
    },
  };
}

describe("P3-ACCT anteNow: only the steps still needed, in order, with the owner's statuses", () => {
  afterEach(() => installMoneyServicesForTests(null));

  it("a first table (the host): Connecting -> Verifying -> Waiting for deposit; Keplr: connect, ONE link signature, ONE transaction -- from the verified wallet", async () => {
    const services = testServices();
    installMoneyServicesForTests(services);
    updateMoneySession({ wallet: "disconnected", address: null, confirmedUntil: null });
    const port = scriptedPort();
    port.answer("money/wallet-challenge", 200, challenge());
    port.answer("money/wallet-link", 200, { ok: true, mode: "issued", wallet: TEST_WALLET, epoch: 1, ticket: TICKET });
    port.answer("money/deposit-sent", 202, { ok: true, accepted: true });
    const statuses: string[] = [];
    const view = hostTable();
    const outcome = await anteNow(
      { gameId: "g_table", view, variants: resolveVariants({} as never), isHost: true, port, services, site: SITE },
      hooksFor(() => null, statuses, view),
    );
    /* The link landed but this test's "server" hasn't pushed a view yet: the Ante stops honestly after verifying. */
    expect(outcome).toEqual({ ok: true, notice: "Wallet verified. The table hasn't caught up yet — press Ante again in a moment." });
    expect(statuses).toEqual([ANTE_STATUS.connecting, ANTE_STATUS.verifying]);
    expect(prompts(services.wallet)).toEqual(["connect", `signLink:${TEST_WALLET}:18COSMOS/WALLET-LINK/v1`]);
  });

  it("…and once the server's view shows the link, the same press goes on to the deposit: one transaction, sent from the seat's verified wallet", async () => {
    const services = testServices();
    installMoneyServicesForTests(services);
    updateMoneySession({ wallet: "disconnected", address: null, confirmedUntil: null });
    const port = scriptedPort();
    port.answer("money/wallet-challenge", 200, challenge());
    port.answer("money/wallet-link", 200, { ok: true, mode: "issued", wallet: TEST_WALLET, epoch: 1, ticket: TICKET });
    port.answer("money/deposit-sent", 202, { ok: true, accepted: true });
    const view = hostTable();
    await anteNow({ gameId: "g_table", view, variants: resolveVariants({} as never), isHost: true, port, services, site: SITE }, hooksFor(() => null, [], view));
    /* Re-run with a server that pushes the view: the press resumes from where the seat is (connect and link skipped). */
    const records = await services.keys.forSeat("g_table", "p-me");
    expect(records).toHaveLength(1);
    const statuses2: string[] = [];
    const linkedView = hostLinked(records[0].pubkey);
    const second = await anteNow({ gameId: "g_table", view: linkedView, variants: resolveVariants({} as never), isHost: true, port, services, site: SITE }, hooksFor(() => null, statuses2, linkedView));
    expect(second).toEqual({ ok: true, notice: "Sent — waiting for Juno." });
    expect(statuses2).toEqual([ANTE_STATUS.depositing]);
    expect(prompts(services.wallet)).toEqual(["connect", `signLink:${TEST_WALLET}:18COSMOS/WALLET-LINK/v1`, `signTx:${TEST_WALLET}:createGame`]);
    /* Sent FROM the verified, linked wallet: the escrow's payout for this seat is that wallet. */
    expect(services.pending.all().map((record) => [record.sender, record.kind])).toEqual([[TEST_WALLET, "create"]]);
  });

  it("one press all the way: the link, the pushed view, the transaction -- three statuses, three Keplr prompts, in that order", async () => {
    const services = testServices();
    installMoneyServicesForTests(services);
    updateMoneySession({ wallet: "disconnected", address: null, confirmedUntil: null });
    const port = scriptedPort();
    port.answer("money/wallet-challenge", 200, challenge());
    port.answer("money/wallet-link", 200, { ok: true, mode: "issued", wallet: TEST_WALLET, epoch: 1, ticket: TICKET });
    port.answer("money/deposit-sent", 202, { ok: true, accepted: true });
    const statuses: string[] = [];
    const view = hostTable();
    let pushes = 0;
    const outcome = await anteNow(
      { gameId: "g_table", view, variants: resolveVariants({} as never), isHost: true, port, services, site: SITE },
      {
        ...hooksFor(() => null, statuses, view),
        waitFor: async (predicate) => {
          pushes += 1;
          const records = await services.keys.forSeat("g_table", "p-me");
          const pushed = hostLinked(records[0].pubkey);
          return predicate(pushed) ? pushed : null;
        },
        latest: () => (pushes === 0 ? view : null),
      },
    );
    expect(outcome).toEqual({ ok: true, notice: "Sent — waiting for Juno." });
    expect(statuses).toEqual([ANTE_STATUS.connecting, ANTE_STATUS.verifying, ANTE_STATUS.depositing]);
    expect(prompts(services.wallet)).toEqual(["connect", `signLink:${TEST_WALLET}:18COSMOS/WALLET-LINK/v1`, `signTx:${TEST_WALLET}:createGame`]);
    expect(port.requests.map((request) => request.path)).toEqual(["money/wallet-challenge", "money/wallet-link", "money/deposit-sent"]);
    /* No password: the server never asked (a fresh sign-in, or the account's own Authorization Wallet -- PHASE 3 FINAL
       `linkAuthority: "authorization-wallet"`). */
    expect(port.requests.some((request) => request.path === "profile/reauth")).toBe(false);
  });

  it("a returning player (Keplr already connected on this page; the account's Authorization Wallet): no connect prompt, no password -- one link signature, one transaction", async () => {
    const services = testServices();
    installMoneyServicesForTests(services);
    updateMoneySession({ wallet: "connected", address: TEST_WALLET, confirmedUntil: null });
    const port = scriptedPort();
    port.answer("money/wallet-challenge", 200, challenge());
    port.answer("money/wallet-link", 200, { ok: true, mode: "issued", wallet: TEST_WALLET, epoch: 1, ticket: TICKET });
    port.answer("money/deposit-sent", 202, { ok: true, accepted: true });
    const statuses: string[] = [];
    const view = hostTable();
    const outcome = await anteNow(
      { gameId: "g_table", view, variants: resolveVariants({} as never), isHost: true, port, services, site: SITE },
      {
        ...hooksFor(() => null, statuses, view),
        waitFor: async (predicate) => {
          const records = await services.keys.forSeat("g_table", "p-me");
          const pushed = hostLinked(records[0].pubkey);
          return predicate(pushed) ? pushed : null;
        },
        latest: () => null,
      },
    );
    expect(outcome.ok).toBe(true);
    expect(statuses).toEqual([ANTE_STATUS.verifying, ANTE_STATUS.depositing]);
    expect(prompts(services.wallet)).toEqual([`signLink:${TEST_WALLET}:18COSMOS/WALLET-LINK/v1`, `signTx:${TEST_WALLET}:createGame`]);
    expect(port.requests.map((request) => request.path).filter((path) => path === "profile/reauth" || path === "account/me")).toEqual([]);
  });

  it("money review M2: 'Verify wallet (free)' verifies and STOPS -- even when the host opened the escrow while Keplr was signing, no transaction is asked", async () => {
    const services = testServices();
    installMoneyServicesForTests(services);
    updateMoneySession({ wallet: "connected", address: TEST_WALLET, confirmedUntil: null });
    const port = scriptedPort();
    port.answer("money/wallet-challenge", 200, challenge());
    port.answer("money/wallet-link", 200, { ok: true, mode: "issued", wallet: TEST_WALLET, epoch: 1, ticket: TICKET });
    const statuses: string[] = [];
    const view = hostTable();
    const outcome = await anteNow(
      { gameId: "g_table", view, variants: resolveVariants({} as never), isHost: true, port, services, site: SITE },
      {
        ...hooksFor(() => null, statuses, view),
        verifyOnly: true,
        /* The pushed view: linked, and the escrow may now be opened (the server offers the deposit). */
        waitFor: async (predicate) => {
          const records = await services.keys.forSeat("g_table", "p-me");
          const pushed = hostLinked(records[0].pubkey);
          return predicate(pushed) ? pushed : null;
        },
        latest: () => null,
      },
    );
    expect(outcome).toEqual({ ok: true, notice: "Wallet verified. Nothing was charged." });
    expect(statuses).toEqual([ANTE_STATUS.verifying]);
    expect(prompts(services.wallet)).toEqual([`signLink:${TEST_WALLET}:18COSMOS/WALLET-LINK/v1`]);
    expect(services.pending.all()).toEqual([]);
  });

  it("money review L5: the deposit waits for the view showing THIS link (its ticket and this browser's key) -- an older view of the same wallet is not enough", async () => {
    const services = testServices();
    installMoneyServicesForTests(services);
    updateMoneySession({ wallet: "connected", address: TEST_WALLET, confirmedUntil: null });
    const port = scriptedPort();
    port.answer("money/wallet-challenge", 200, challenge());
    port.answer("money/wallet-link", 200, { ok: true, mode: "issued", wallet: TEST_WALLET, epoch: 2, ticket: "cd".repeat(32) });
    const view = hostTable();
    const stale = moneyView({ you: linked([], { actions: ["open-escrow", "link-wallet"] }) }); // the same wallet, the OLD ticket, no key
    const outcome = await anteNow(
      { gameId: "g_table", view, variants: resolveVariants({} as never), isHost: true, port, services, site: SITE },
      { ...hooksFor(() => null, [], view), waitFor: async (predicate) => (predicate(stale) ? stale : null), latest: () => null },
    );
    expect(outcome).toEqual({ ok: true, notice: "Wallet verified. The table hasn't caught up yet — press Ante again in a moment." });
    expect(prompts(services.wallet).some((call) => call.startsWith("signTx"))).toBe(false);
  });

  it("a seat linked to ANOTHER wallet is never replaced by the Ante: it stops, says so, and asks Keplr and the server nothing", async () => {
    const services = testServices();
    services.wallet.address = "juno1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqnrql8a";
    installMoneyServicesForTests(services);
    updateMoneySession({ wallet: "connected", address: services.wallet.address, confirmedUntil: null });
    const port = scriptedPort();
    const view = moneyView({ you: linked([], { actions: ["open-escrow", "link-wallet"] }) });
    const outcome = await anteNow({ gameId: "g_table", view, variants: resolveVariants({} as never), isHost: true, port, services, site: SITE }, hooksFor(() => null, [], view));
    expect(outcome).toEqual({ ok: false, reason: expect.stringMatching(/^Switch Keplr to juno12gdm.* to sign this action.*Change wallet/), needs: "connect" });
    expect(prompts(services.wallet)).toEqual([]);
    expect(port.requests).toEqual([]);
  });

  it("consolidated integration (review): at a No-deadline table this seat has not acknowledged, the Ante asks Keplr and the server NOTHING -- it says the disclosure first; verifying a wallet alone is not gated", async () => {
    const services = testServices();
    installMoneyServicesForTests(services);
    updateMoneySession({ wallet: "disconnected", address: null, confirmedUntil: null });
    const port = scriptedPort();
    const view = hostTable();
    const deadline = { deadline: "no-deadline" as const, paceSecs: null, acknowledged: false };
    const outcome = await anteNow({ gameId: "g_table", view, variants: resolveVariants({ mode: "async" } as never), isHost: false, port, services, site: SITE, deadline }, hooksFor(() => null, [], view));
    expect(outcome).toEqual({ ok: false, reason: expect.stringMatching(/Acknowledge this before your deposit\.$/) });
    expect(prompts(services.wallet)).toEqual([]);
    expect(port.requests).toEqual([]);
    /* "Verify wallet (free)" commits no money: it goes ahead. */
    port.answer("money/wallet-challenge", 200, challenge());
    port.answer("money/wallet-link", 200, { ok: true, mode: "issued", wallet: TEST_WALLET, epoch: 1, ticket: TICKET });
    const verified = await anteNow({ gameId: "g_table", view, variants: resolveVariants({ mode: "async" } as never), isHost: false, port, services, site: SITE, deadline }, { ...hooksFor(() => null, [], view), verifyOnly: true });
    expect(verified.ok).toBe(true);
    expect(prompts(services.wallet)).toEqual(["connect", `signLink:${TEST_WALLET}:18COSMOS/WALLET-LINK/v1`]);
  });

  it("cancelled in Keplr at the link: nothing is linked or sent; pressing again resumes from there (no second connect)", async () => {
    const services = testServices();
    installMoneyServicesForTests(services);
    updateMoneySession({ wallet: "disconnected", address: null, confirmedUntil: null });
    services.wallet.linkAnswer = { ok: false, code: "rejected", reason: "Keplr didn't sign. Nothing was linked." };
    const port = scriptedPort();
    port.answer("money/wallet-challenge", 200, challenge());
    const view = hostTable();
    const first = await anteNow({ gameId: "g_table", view, variants: resolveVariants({} as never), isHost: true, port, services, site: SITE }, hooksFor(() => null, [], view));
    expect(first).toEqual({ ok: false, reason: "Keplr didn't sign. Nothing was linked." });
    expect(port.requests.map((request) => request.path)).toEqual(["money/wallet-challenge"]);
    expect(services.pending.all()).toEqual([]);
    expect(moneySession().wallet).toBe("connected");
    /* Again: the page is connected now, so Keplr is asked only for the link (a fresh, single-use challenge). */
    services.wallet.linkAnswer = { ok: true, value: { pubKey: "Ai1R5vzeZFvF73ROli+IbV7OuNG7bM6HeI0rthBGJzvf", signature: "c2ln" } };
    port.answer("money/wallet-challenge", 200, challenge());
    port.answer("money/wallet-link", 200, { ok: true, mode: "issued", wallet: TEST_WALLET, epoch: 1, ticket: TICKET });
    await anteNow({ gameId: "g_table", view, variants: resolveVariants({} as never), isHost: true, port, services, site: SITE }, hooksFor(() => null, [], view));
    expect(prompts(services.wallet).filter((call) => call === "connect")).toHaveLength(1);
    expect(port.requests.map((request) => request.path)).toEqual(["money/wallet-challenge", "money/wallet-challenge", "money/wallet-link"]);
  });
});

/* ================================================================== */
/* Rendered: the button, the double click, two tabs                   */
/* ================================================================== */

let container: HTMLDivElement;
let root: Root;
const settle = async () => {
  await act(async () => {
    for (let n = 0; n < 30; n += 1) await Promise.resolve();
  });
};
const byTestId = (scope: ParentNode, id: string) => scope.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

function room(money: RoomMoneyView): RoomView {
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
    hostId: "p-me",
    players: [
      { id: "p-me", nickname: "Brad", isReady: false, online: true },
      { id: "p-other", nickname: "Ana", isReady: false, online: true },
    ],
    playerCount: 2,
    seatCap: 2,
    variants: resolveVariants({} as never),
    createdAtMs: T0,
    undoPolicy: { host_undo: "none" },
    you: { role: "host", playerId: "p-me", kicked: false, canStart: false },
    money,
  };
}

/** A fake `navigator.locks`: one exclusive lock per name, `ifAvailable` answered with null when it is held -- shared by
 *  every "tab" given it, as the browser shares the real one across an origin's tabs. */
function fakeLocks(): LockManagerLike & { held: Set<string> } {
  const held = new Set<string>();
  return {
    held,
    async request(name, _options, callback) {
      if (held.has(name)) return callback(null);
      held.add(name);
      try {
        return await callback({ name });
      } finally {
        held.delete(name);
      }
    },
  };
}

describe("P3-ACCT the Ante button, rendered", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    installMoneyServicesForTests(null);
  });

  it("a double click is ONE Ante: one challenge, one Keplr signature", async () => {
    const services = testServices();
    installMoneyServicesForTests(services);
    act(() => updateMoneySession({ wallet: "connected", address: TEST_WALLET, confirmedUntil: null }));
    const port = scriptedPort();
    port.answer("money/wallet-challenge", 200, challenge());
    port.answer("money/wallet-challenge", 200, challenge());
    act(() => root.render(<MoneyPanel room={room(hostTable())} onStart={() => undefined} services={services} port={port} />));
    await settle();
    const button = byTestId(container, "money-action-ante") as HTMLButtonElement;
    expect(button.textContent).toBe("Ante 1 JUNOX");
    act(() => {
      button.click();
      button.click();
    });
    await settle();
    expect(port.requests.filter((request) => request.path === "money/wallet-challenge")).toHaveLength(1);
    expect(prompts(services.wallet).filter((call) => call.startsWith("signLink"))).toHaveLength(1);
  });

  it("two tabs press Ante at once: Keplr opens ONCE; the other tab is told another tab has it (never queued) -- and can go once it is free", async () => {
    const locks = fakeLocks();
    const wallet = testServices().wallet; // ONE Keplr extension, shared by the two tabs
    let release: () => void = () => undefined;
    const connectGate = new Promise<void>((resolve) => (release = resolve));
    const realConnect = wallet.connect.bind(wallet);
    wallet.connect = async (pin) => {
      wallet.calls.push("connect");
      await connectGate;
      wallet.calls.pop();
      return realConnect(pin);
    };
    const tabA: MoneyServices = { ...testServices({ wallet }), keplrLock: createKeplrLock({ locks }) };
    const tabB: MoneyServices = { ...testServices({ wallet }), keplrLock: createKeplrLock({ locks }) };
    act(() => updateMoneySession({ wallet: "disconnected", address: null, confirmedUntil: null }));
    const portA = scriptedPort();
    const portB = scriptedPort();
    const second = document.createElement("div");
    document.body.appendChild(second);
    const rootB = createRoot(second);
    act(() => {
      root.render(<MoneyPanel room={room(hostTable())} onStart={() => undefined} services={tabA} port={portA} />);
      rootB.render(<MoneyPanel room={room(hostTable())} onStart={() => undefined} services={tabB} port={portB} />);
    });
    await settle();
    act(() => (byTestId(container, "money-action-ante") as HTMLButtonElement).click());
    await settle();
    expect(locks.held.has("18cosmos-keplr")).toBe(true);
    act(() => (byTestId(second, "money-action-ante") as HTMLButtonElement).click());
    await settle();
    expect(byTestId(second, "money-error")?.textContent).toBe(KEPLR_BUSY_SENTENCE);
    expect(wallet.calls.filter((call) => call === "connect")).toHaveLength(1);
    expect(portB.requests).toEqual([]);
    /* Tab A finishes (its challenge isn't scripted: it stops there); the lock is free and tab B may go. */
    release();
    await settle();
    expect(locks.held.size).toBe(0);
    portB.answer("money/wallet-challenge", 200, challenge());
    act(() => (byTestId(second, "money-action-ante") as HTMLButtonElement).click());
    await settle();
    /* Re-evaluated from scratch: its own challenge, its own signature (the link answer isn't scripted here). */
    expect(portB.requests.map((request) => request.path)).toEqual(["money/wallet-challenge", "money/wallet-link"]);
    act(() => rootB.unmount());
    second.remove();
  });
});
