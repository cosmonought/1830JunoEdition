/** @jest-environment jsdom */
//
// OWNER RULING (2026-10-07): a player's Authorization Wallet MAY also be that player's financial (ante) wallet.
//
// Never blocked, never selected or bound for the player (the financial wallet is the wallet Keplr is on when the player
// presses Ante / Verify wallet / Change wallet). Before that same address is FIRST bound to a seat, the panel warns once
// -- recommending a separate wallet for stronger account-security isolation -- and the player may continue. The
// acknowledgement is kept per ACCOUNT x AUTHORIZATION WALLET on this browser (`sameWalletAck.ts`): it survives a reload
// and a new sign-in, and is not carried to another account or to a replacement Authorization Wallet.

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { anteNow, linkWallet, type AnteHooks, type TableContext } from "./moneyActions";
import { walletChallenge } from "./moneyApi";
import { installMoneyServicesForTests, updateMoneySession } from "./moneySession";
import { linked, memoryStorage, moneyView, scriptedPort, testServices, T0, TEST_CONTRACT, TEST_WALLET, TICKET, type FakeWallet, type ScriptedPort } from "./moneyTestSupport";
import {
  createSameWalletAcks,
  SAME_WALLET_ACK_MAX,
  SAME_WALLET_ACK_STORAGE_KEY,
  SAME_WALLET_SENTENCE,
  SAME_WALLET_TITLE,
  sameWalletAccountKey,
  sameWalletAckDigest,
} from "./sameWalletAck";
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
if (typeof (global as { TextEncoder?: unknown }).TextEncoder === "undefined") (global as { TextEncoder?: unknown }).TextEncoder = require("util").TextEncoder;

const SITE = "http://localhost";
/** Another wallet of the same player (a separate game-funds wallet). */
const WALLET_A = "juno1qyqszqgpqyqszqgpqyqszqgpqyqszqgpypz92q";
const USERNAME = "Brad.Player";
const ACCOUNT = sameWalletAccountKey(USERNAME);

/** The server's challenge for `wallet`; `same`: the server says it is the account's own Authorization Wallet. */
const challenge = (wallet: string, same: boolean) => ({
  ok: true,
  text: walletLinkChallengeText({ appName: "Project 18XX", site: SITE, chainId: "uni-7", contract: TEST_CONTRACT, gameId: "g_table", playerId: "p-me", wallet, nonce: "ab".repeat(16), expiresAt: T0 + 300_000 }),
  nonce: "ab".repeat(16),
  expiresAt: T0 + 300_000,
  replaces: null,
  ...(same ? { authorizationWallet: true } : {}),
});

/** A session port for a signed-in account (its username is what the acknowledgement is kept under). */
function accountPort(username: string = USERNAME): ScriptedPort {
  return Object.assign(scriptedPort(), { account: { name: "Brad", otherSessions: 0, username } });
}

const prompts = (wallet: FakeWallet) => wallet.calls.filter((call) => call === "connect" || call.startsWith("signLink") || call.startsWith("signTx"));
const paths = (port: ScriptedPort) => port.requests.map((request) => request.path);
const unlinkedSeat = () => moneyView({ you: { ...linked([]), link: null, funding: "none", actions: ["link-wallet"] } });

function hooks(view: RoomMoneyView, over: Partial<AnteHooks> = {}): AnteHooks {
  return { status: () => undefined, latest: () => view, proof: null, waitFor: async () => null, ...over };
}

function ctxFor(view: RoomMoneyView, port: ScriptedPort, services: ReturnType<typeof testServices>, isHost = true): TableContext {
  return { gameId: "g_table", view, variants: resolveVariants({} as never), isHost, port, services, site: SITE };
}

describe("owner ruling 2026-10-07: the Authorization Wallet as a game's financial wallet -- warned once, allowed, never chosen", () => {
  afterEach(() => installMoneyServicesForTests(null));

  it("different Authorization and financial wallets: no warning -- Keplr's wallet is linked as usual", async () => {
    const services = testServices();
    services.wallet.address = WALLET_A;
    installMoneyServicesForTests(services);
    updateMoneySession({ wallet: "connected", address: WALLET_A, confirmedUntil: null });
    const port = accountPort();
    port.answer("money/wallet-challenge", 200, challenge(WALLET_A, false));
    port.answer("money/wallet-link", 200, { ok: true, mode: "issued", wallet: WALLET_A, epoch: 1, ticket: TICKET });
    const view = unlinkedSeat();
    const outcome = await anteNow(ctxFor(view, port, services), hooks(view));
    expect(outcome.ok).toBe(true);
    expect(outcome.ok === false ? outcome.needs : null).toBeNull();
    expect(prompts(services.wallet)).toEqual([`signLink:${WALLET_A}:18COSMOS/WALLET-LINK/v1`]);
    expect(paths(port)).toEqual(["money/wallet-challenge", "money/wallet-link"]);
  });

  it("the SAME address: the warning comes BEFORE the first binding -- nothing is signed, nothing is linked, no money moves", async () => {
    const services = testServices();
    installMoneyServicesForTests(services);
    updateMoneySession({ wallet: "connected", address: TEST_WALLET, confirmedUntil: null });
    const port = accountPort();
    port.answer("money/wallet-challenge", 200, challenge(TEST_WALLET, true));
    const view = unlinkedSeat();
    const outcome = await anteNow(ctxFor(view, port, services), hooks(view));
    expect(outcome).toEqual({ ok: false, reason: SAME_WALLET_SENTENCE, needs: "same-wallet", sameWallet: { wallet: TEST_WALLET } });
    expect(prompts(services.wallet)).toEqual([]);
    expect(paths(port)).toEqual(["money/wallet-challenge"]);
    expect(services.pending.all()).toEqual([]);
    /* It is advice, not a refusal of the choice: it never calls the same wallet unsafe or unsupported. */
    expect(SAME_WALLET_SENTENCE).toMatch(/That's allowed\./);
    expect(SAME_WALLET_SENTENCE).not.toMatch(/unsafe|not supported|unsupported|can't|cannot/i);
  });

  it("acknowledged, the same address is NOT refused: the same press links it (one signature) and goes on", async () => {
    const services = testServices();
    installMoneyServicesForTests(services);
    updateMoneySession({ wallet: "connected", address: TEST_WALLET, confirmedUntil: null });
    services.sameWalletAcks?.acknowledge(ACCOUNT, TEST_WALLET);
    const port = accountPort();
    port.answer("money/wallet-challenge", 200, challenge(TEST_WALLET, true));
    port.answer("money/wallet-link", 200, { ok: true, mode: "issued", wallet: TEST_WALLET, epoch: 1, ticket: TICKET });
    const view = unlinkedSeat();
    const outcome = await anteNow(ctxFor(view, port, services), hooks(view));
    expect(outcome).toEqual({ ok: true, notice: "Wallet verified. The table hasn't caught up yet — press Ante again in a moment." });
    expect(prompts(services.wallet)).toEqual([`signLink:${TEST_WALLET}:18COSMOS/WALLET-LINK/v1`]);
    expect(paths(port)).toEqual(["money/wallet-challenge", "money/wallet-link"]);
  });

  it("'Verify wallet (free)' is a first binding too (warned); a re-proof of a seat ALREADY bound to it is not (no warning)", async () => {
    const services = testServices();
    installMoneyServicesForTests(services);
    updateMoneySession({ wallet: "connected", address: TEST_WALLET, confirmedUntil: null });
    const port = accountPort();
    port.answer("money/wallet-challenge", 200, challenge(TEST_WALLET, true));
    const view = unlinkedSeat();
    const verify = await anteNow(ctxFor(view, port, services), hooks(view, { verifyOnly: true }));
    expect(verify.ok === false && verify.needs).toBe("same-wallet");
    /* The seat already holds the Authorization Wallet (linked earlier, e.g. on another device): the free re-proof is
       not a new binding, so nothing is asked. */
    port.answer("money/wallet-challenge", 200, challenge(TEST_WALLET, true));
    port.answer("money/wallet-link", 200, { ok: true, mode: "unchanged", wallet: TEST_WALLET, epoch: 1, ticket: TICKET });
    const again = await linkWallet(ctxFor(moneyView({ you: linked([]) }), port, services), { expectWallet: TEST_WALLET, reprove: true });
    expect(again).toEqual({ ok: true, notice: "Wallet proof renewed: you can deposit now. Nothing was charged." });
    expect(prompts(services.wallet)).toEqual([`signLink:${TEST_WALLET}:18COSMOS/WALLET-LINK/v1`]);
  });

  it("'Change wallet' to the Authorization Wallet: warned before the replacement link is signed", async () => {
    const services = testServices();
    installMoneyServicesForTests(services);
    updateMoneySession({ wallet: "connected", address: TEST_WALLET, confirmedUntil: null });
    const port = accountPort();
    port.answer("money/wallet-challenge", 200, { ...challenge(TEST_WALLET, true), replaces: WALLET_A });
    const seatOnA = moneyView({ you: linked([], { link: { wallet: WALLET_A, epoch: 1, ticket: TICKET, linkedAt: T0, consentKeys: [] } }) });
    const outcome = await linkWallet(ctxFor(seatOnA, port, services, false), { replace: true, expectWallet: TEST_WALLET, expectReplaces: WALLET_A });
    expect(outcome.ok === false && outcome.needs).toBe("same-wallet");
    expect(prompts(services.wallet)).toEqual([]);
  });

  it("the Authorization Wallet is never selected for the player: the financial wallet is the one Keplr is on (no account read, no Authorization Wallet named to the server)", async () => {
    const services = testServices();
    services.wallet.address = WALLET_A;
    installMoneyServicesForTests(services);
    updateMoneySession({ wallet: "connected", address: WALLET_A, confirmedUntil: null });
    const port = accountPort();
    port.answer("money/wallet-challenge", 200, challenge(WALLET_A, false));
    const view = unlinkedSeat();
    await anteNow(ctxFor(view, port, services), hooks(view));
    expect(port.requests[0]).toEqual({ path: "money/wallet-challenge", body: { gameId: "g_table", wallet: WALLET_A } });
    expect(paths(port).some((path) => path.startsWith("account/") || path.startsWith("profile/"))).toBe(false);
    expect(port.requests.some((request) => JSON.stringify(request.body).includes(TEST_WALLET))).toBe(false);
  });
});

describe("owner ruling 2026-10-07: the server's word on the wire", () => {
  it("the challenge answer's `authorizationWallet` is read only as `true`; absent (another wallet, an older server) is none; anything else is a bad answer", async () => {
    const port = accountPort();
    port.answer("money/wallet-challenge", 200, challenge(TEST_WALLET, true));
    port.answer("money/wallet-challenge", 200, challenge(WALLET_A, false));
    port.answer("money/wallet-challenge", 200, { ...challenge(TEST_WALLET, false), authorizationWallet: "yes" });
    const same = await walletChallenge("g_table", TEST_WALLET, port);
    expect(same.ok && same.value.authorizationWallet).toBe(true);
    const other = await walletChallenge("g_table", WALLET_A, port);
    expect(other.ok && "authorizationWallet" in other.value).toBe(false);
    expect((await walletChallenge("g_table", TEST_WALLET, port)).ok).toBe(false);
  });
});

describe("owner ruling 2026-10-07: the acknowledgement's scope -- this account x this Authorization Wallet, on this browser", () => {
  it("survives a reload and a new sign-in (a fresh store on the same storage); not another account; not a replacement Authorization Wallet; nothing readable is kept", () => {
    const storage = memoryStorage();
    const first = createSameWalletAcks(() => storage);
    expect(first.has(ACCOUNT, TEST_WALLET)).toBe(false);
    first.acknowledge(ACCOUNT, TEST_WALLET);
    /* A reload / a new session of the same account: a new store over the same browser storage. */
    const reloaded = createSameWalletAcks(() => storage);
    expect(reloaded.has(ACCOUNT, TEST_WALLET)).toBe(true);
    expect(reloaded.has(sameWalletAccountKey("brad.player"), TEST_WALLET)).toBe(true);
    expect(reloaded.has(sameWalletAccountKey("Someone.Else"), TEST_WALLET)).toBe(false);
    expect(reloaded.has(ACCOUNT, WALLET_A)).toBe(false);
    const raw = storage.getItem(SAME_WALLET_ACK_STORAGE_KEY) ?? "";
    expect(JSON.parse(raw)).toEqual([sameWalletAckDigest(ACCOUNT, TEST_WALLET)]);
    expect(raw).not.toContain(TEST_WALLET);
    expect(raw.toLowerCase()).not.toContain("brad");
  });

  it("bounded to the newest records; an unusable storage keeps it for this page only (never a loop, never a throw)", () => {
    const storage = memoryStorage();
    const acks = createSameWalletAcks(() => storage);
    for (let n = 0; n < SAME_WALLET_ACK_MAX + 4; n += 1) acks.acknowledge(sameWalletAccountKey(`player${n}`), TEST_WALLET);
    expect(JSON.parse(storage.getItem(SAME_WALLET_ACK_STORAGE_KEY) ?? "[]")).toHaveLength(SAME_WALLET_ACK_MAX);
    const blocked = memoryStorage();
    blocked.failWrites = true;
    const page = createSameWalletAcks(() => blocked);
    expect(() => page.acknowledge(ACCOUNT, TEST_WALLET)).not.toThrow();
    expect(page.has(ACCOUNT, TEST_WALLET)).toBe(true);
    const none = createSameWalletAcks(() => null);
    none.acknowledge(ACCOUNT, TEST_WALLET);
    expect(none.has(ACCOUNT, TEST_WALLET)).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* The panel                                                           */
/* ------------------------------------------------------------------ */

let container: HTMLDivElement;
let root: Root;
const settle = async () => {
  await act(async () => {
    for (let n = 0; n < 40; n += 1) await Promise.resolve();
  });
};
const byTestId = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const click = async (element: Element | null) => {
  expect(element).toBeTruthy();
  act(() => (element as HTMLElement).click());
  await settle();
};

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
    hostId: "p-other",
    players: [
      { id: "p-me", nickname: "Brad", isReady: false, online: true },
      { id: "p-other", nickname: "Ana", isReady: false, online: true },
    ],
    playerCount: 2,
    seatCap: 2,
    variants: resolveVariants({} as never),
    createdAtMs: T0,
    undoPolicy: { host_undo: "none" },
    you: { role: "player", playerId: "p-me", kicked: false, canStart: false },
    money,
  };
}

const fundingTable = () => moneyView({ escrow: { chainGameId: "7", state: "FUNDING", fundingDeadline: T0 + 3_600_000 } });

describe("owner ruling 2026-10-07: the panel's warning at the binding boundary", () => {
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

  it("Ante with the Authorization Wallet: a compact warning names both roles and the same address; Continue keeps the acknowledgement and the SAME press goes on to the link", async () => {
    const storage = memoryStorage();
    const services = { ...testServices({ storage }), sameWalletAcks: createSameWalletAcks(() => storage) };
    installMoneyServicesForTests(services);
    act(() => updateMoneySession({ wallet: "connected", address: TEST_WALLET, confirmedUntil: null }));
    const port = accountPort();
    port.answer("money/wallet-challenge", 200, challenge(TEST_WALLET, true));
    port.answer("money/wallet-challenge", 200, challenge(TEST_WALLET, true));
    act(() => root.render(<MoneyPanel room={room(fundingTable())} onStart={() => undefined} services={services} port={port} />));
    await settle();
    await click(byTestId("money-action-ante"));
    const card = byTestId("money-same-wallet");
    expect(card).not.toBeNull();
    expect(byTestId("money-same-wallet-text")?.textContent).toBe(`${SAME_WALLET_TITLE}. ${SAME_WALLET_SENTENCE}`);
    expect(byTestId("money-same-wallet-wallets")?.textContent).toMatch(/^Authorization Wallet: juno12gdm…783a · This game's funds: juno12gdm…783a — the same address\. To use another wallet, switch accounts in Keplr, then press the button again\.$/);
    expect(byTestId("money-error")).toBeNull();
    expect(prompts(services.wallet)).toEqual([]);
    expect(storage.getItem(SAME_WALLET_ACK_STORAGE_KEY)).toBeNull();
    /* Continue: kept for this account and wallet, then the same press runs again (nothing scripted past the second
       challenge's link, so it stops at the server's silence -- after Keplr signed the link). */
    await click(byTestId("money-same-wallet-continue"));
    expect(JSON.parse(storage.getItem(SAME_WALLET_ACK_STORAGE_KEY) ?? "[]")).toEqual([sameWalletAckDigest(ACCOUNT, TEST_WALLET)]);
    expect(paths(port)).toEqual(["money/wallet-challenge", "money/wallet-challenge", "money/wallet-link"]);
    expect(prompts(services.wallet)).toEqual([`signLink:${TEST_WALLET}:18COSMOS/WALLET-LINK/v1`]);
    expect(byTestId("money-same-wallet")).toBeNull();
    /* No account or profile route was touched: the account is not changed by the choice. */
    expect(paths(port).some((path) => path.startsWith("account/") || path.startsWith("profile/"))).toBe(false);
  });

  it("'Not now' closes it: nothing signed, nothing kept -- the next press asks again (no acknowledgement was given)", async () => {
    const storage = memoryStorage();
    const services = { ...testServices({ storage }), sameWalletAcks: createSameWalletAcks(() => storage) };
    installMoneyServicesForTests(services);
    act(() => updateMoneySession({ wallet: "connected", address: TEST_WALLET, confirmedUntil: null }));
    const port = accountPort();
    port.answer("money/wallet-challenge", 200, challenge(TEST_WALLET, true));
    port.answer("money/wallet-challenge", 200, challenge(TEST_WALLET, true));
    act(() => root.render(<MoneyPanel room={room(fundingTable())} onStart={() => undefined} services={services} port={port} />));
    await settle();
    await click(byTestId("money-action-ante"));
    await click(byTestId("money-same-wallet-cancel"));
    expect(byTestId("money-same-wallet")).toBeNull();
    expect(prompts(services.wallet)).toEqual([]);
    expect(storage.getItem(SAME_WALLET_ACK_STORAGE_KEY)).toBeNull();
    await click(byTestId("money-action-ante"));
    expect(byTestId("money-same-wallet")).not.toBeNull();
  });

  it("acknowledged once, a reload / a new sign-in of the same account at ANOTHER table goes straight to the link -- no second warning; another account on this browser is warned", async () => {
    const storage = memoryStorage();
    createSameWalletAcks(() => storage).acknowledge(ACCOUNT, TEST_WALLET);
    /* A new page (fresh services over the same browser storage) and a new session (a fresh port, same account). */
    const services = { ...testServices({ storage }), sameWalletAcks: createSameWalletAcks(() => storage) };
    installMoneyServicesForTests(services);
    act(() => updateMoneySession({ wallet: "connected", address: TEST_WALLET, confirmedUntil: null }));
    const port = accountPort();
    port.answer("money/wallet-challenge", 200, challenge(TEST_WALLET, true));
    act(() => root.render(<MoneyPanel room={room(fundingTable())} onStart={() => undefined} services={services} port={port} />));
    await settle();
    await click(byTestId("money-action-ante"));
    expect(byTestId("money-same-wallet")).toBeNull();
    expect(prompts(services.wallet)).toEqual([`signLink:${TEST_WALLET}:18COSMOS/WALLET-LINK/v1`]);
    act(() => root.unmount());
    root = createRoot(container);
    /* Another account signed in on this browser: its own first binding of its own Authorization Wallet is warned. */
    const other = accountPort("Someone.Else");
    other.answer("money/wallet-challenge", 200, challenge(TEST_WALLET, true));
    act(() => root.render(<MoneyPanel room={room(fundingTable())} onStart={() => undefined} services={services} port={other} />));
    await settle();
    await click(byTestId("money-action-ante"));
    expect(byTestId("money-same-wallet")).not.toBeNull();
  });
});
