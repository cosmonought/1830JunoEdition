/** @jest-environment jsdom */
//
// ==================================================================
//  PHASE 3 W2-M: WALLET AND DISPUTE UX, RENDERED -- the waiting room's money panel and the result's band
// ==================================================================
//
// The panel and the band driven through their real hook (`useMoneyTable`) against a fake Keplr, in-memory keys, a
// scripted server and a fake Juno -- the same seams the ESCROW-4 suites use. What a player sees and what Keplr is
// asked to sign, row by row:
//
//   AUD-20.02  an aged (or server-refused) proof: "Re-prove …", the free re-proof of the same wallet, then the deposit
//              (P3-ACCT: the one "Ante" button runs it -- first when the server's word says so, after the server's
//              refusal when it is only this page's inference -- and "Re-prove wallet (free)" stays beside it);
//   AUD-20.03  "Change wallet": the question first (both wallets named, nothing signed), then ONE Keplr signature;
//   AUD-20.07  "Dispute": the resolver's deadline as a time; the band's dispute record and how it ended, from Juno;
//   AUD-20.06  Juno re-read at "Continue in Keplr": a payout or bond that moved since the confirm signs nothing;
//   and the boundaries: a no-money table has no money surface and reads no chain; the money surfaces share no state
//   with the room strip's connection and refusal slots (W3-C).

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { MoneyPanel } from "./MoneyPanel";
import { SettlementBand } from "./SettlementBand";
import { installMoneyServicesForTests, updateMoneySession } from "../../money/moneySession";
import { linked, moneyView, OTHER_WALLET, scriptedPort, testServices, T0, TEST_CONTRACT, TEST_WALLET, TICKET } from "../../money/moneyTestSupport";
import { formatMoneyTime } from "../../money/moneyTime";
import type { ChainGameFacts } from "../../money/walletChecks";
import { walletLinkChallengeText } from "../../gameEngine/escrow/walletLinkChallengeV1";
import { resolveVariants } from "../../gameEngine/gameVariants";
import { shortWallet, type MoneySettlementView, type RoomMoneyView } from "../../utils/moneyProtocol";
import type { RoomView } from "../../utils/roomProtocol";
import { readStripped } from "../../utils/sourceScan";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
global.IS_REACT_ACT_ENVIRONMENT = true;

const HOUR = 3_600_000;
const SITE = "http://localhost";

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
const signLinks = (calls: readonly string[]) => calls.filter((call) => call.startsWith("signLink"));

function room(money: RoomMoneyView | undefined, over: Partial<RoomView> = {}): RoomView {
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
    ...(money === undefined ? {} : { money }),
    ...over,
  };
}

const challengeAnswer = (wallet: string) => ({
  ok: true,
  text: walletLinkChallengeText({ appName: "Project 18XX", site: SITE, chainId: "uni-7", contract: TEST_CONTRACT, gameId: "g_table", playerId: "p-me", wallet, nonce: "ab".repeat(16), expiresAt: T0 + 300_000 }),
  nonce: "ab".repeat(16),
  expiresAt: T0 + 300_000,
});

/** A joiner at a bound FUNDING table, linked to TEST_WALLET at `linkedAt`: the server's action set there is `deposit`
 *  alone (never with `link-wallet`). */
const joinerMoney = (linkedAt: number, consentKeys: string[] = []) =>
  moneyView({
    escrow: { chainGameId: "7", state: "FUNDING", fundingDeadline: T0 + HOUR },
    start: { blocker: "need-funding" },
    you: linked(consentKeys, { actions: ["deposit"], link: { wallet: TEST_WALLET, epoch: 1, ticket: TICKET, linkedAt, consentKeys } }),
  });
/** A joiner linked before the host opened the table: the server allows a link (`link-wallet`), so Change wallet shows. */
const unboundMoney = () => moneyView({ you: linked([], { actions: ["link-wallet"] }) });

function connectedWorld(address: string = TEST_WALLET) {
  const services = testServices();
  services.wallet.address = address;
  installMoneyServicesForTests(services);
  act(() => updateMoneySession({ wallet: "connected", address, confirmedUntil: T0 + 5 * 60 * 1000 }));
  return { services, port: scriptedPort() };
}

/* ================================================================== */
/* AUD-20.02                                                          */
/* ================================================================== */

describe("W2-M AUD-20.02, rendered: an aged proof reads re-prove, and re-proving brings the deposit back", () => {
  it("linked more than a day ago: no 'Wallet linked' -- 'Re-prove' first (Deposit only beside it), one signature for the same wallet, then Deposit", async () => {
    const { services, port } = connectedWorld();
    port.answer("money/wallet-challenge", 200, challengeAnswer(TEST_WALLET));
    port.answer("money/wallet-link", 200, { ok: true, mode: "unchanged", wallet: TEST_WALLET, epoch: 1, ticket: TICKET });
    await render(<MoneyPanel room={room(joinerMoney(T0 - 25 * HOUR))} onStart={() => undefined} services={services} port={port} />);
    expect(byTestId("money-headline")?.textContent).toBe(`Re-prove ${shortWallet(TEST_WALLET)} to deposit`);
    expect(container.textContent).not.toMatch(/Wallet linked/);
    expect(byTestId("money-action-reprove")?.textContent).toBe("Re-prove wallet (free)");
    /* P3-ACCT: the Ante stays the primary (a re-proof elsewhere keeps the link's time; the server decides). */
    expect(byTestId("money-action-ante")?.textContent).toBe("Ante 1 JUNOX");
    await click(byTestId("money-action-reprove"));
    expect(signLinks(services.wallet.calls)).toEqual([`signLink:${TEST_WALLET}:18COSMOS/WALLET-LINK/v1`]);
    expect(port.requests.find((request) => request.path === "money/wallet-link")?.body.replace).toBeUndefined();
    expect(byTestId("money-notice")?.textContent).toBe("Wallet proof renewed: you can deposit now. Nothing was charged.");
    /* The view's linkedAt didn't move (a same-wallet re-proof keeps it); the page's own record of the accepted proof does. */
    expect(byTestId("money-headline")?.textContent).toBe(`Wallet verified · ${shortWallet(TEST_WALLET)}`);
    expect(byTestId("money-action-ante")?.textContent).toBe("Ante 1 JUNOX");
  });

  it("the server refuses the approval for want of a proof: Ante re-proves the SAME wallet once (no replace) and asks again -- refused again, the panel turns to re-prove, no transaction signed, and a room update doesn't undo it", async () => {
    const { services, port } = connectedWorld();
    const key = await services.keys.create({ chainId: "uni-7", contract: TEST_CONTRACT, gameId: "g_table", playerId: "p-me", wallet: TEST_WALLET });
    if (!key.ok) throw new Error(key.reason);
    const money = joinerMoney(T0, [key.pubkey]);
    port.answer("money/join-admission", 409, { error: "link-first", reason: "Link your wallet to this seat again (the proof is missing or too old)." });
    port.answer("money/wallet-challenge", 200, challengeAnswer(TEST_WALLET));
    port.answer("money/wallet-link", 200, { ok: true, mode: "unchanged", wallet: TEST_WALLET, epoch: 1, ticket: TICKET });
    port.answer("money/join-admission", 409, { error: "link-first", reason: "Link your wallet to this seat again (the proof is missing or too old)." });
    await render(<MoneyPanel room={room(money)} onStart={() => undefined} services={services} port={port} />);
    expect(byTestId("money-headline")?.textContent).toMatch(/^Wallet verified/);
    await click(byTestId("money-action-ante"));
    expect(services.wallet.calls.some((call) => call.startsWith("signTx"))).toBe(false);
    expect(signLinks(services.wallet.calls)).toEqual([`signLink:${TEST_WALLET}:18COSMOS/WALLET-LINK/v1`]);
    expect(port.requests.filter((request) => request.path === "money/wallet-link").map((request) => request.body.replace)).toEqual([undefined]);
    expect(port.requests.map((request) => request.path)).toEqual(["money/join-admission", "money/wallet-challenge", "money/wallet-link", "money/join-admission"]);
    expect(byTestId("money-error")?.textContent).toBe("Link your wallet to this seat again (the proof is missing or too old).");
    expect(byTestId("money-headline")?.textContent).toBe(`Re-prove ${shortWallet(TEST_WALLET)} to deposit`);
    expect(byTestId("money-detail")?.textContent).toMatch(/^The server needs a fresh proof/);
    expect(byTestId("money-action-open-review")).toBeNull();
    expect(byTestId("money-action-approve")).toBeNull();
    /* Something else in the room changed (a player went offline): the money state is the money's own. */
    await render(<MoneyPanel room={room(money, { players: [{ id: "p-me", nickname: "Brad", isReady: false, online: true }, { id: "p-other", nickname: "Ana", isReady: false, online: false }] })} onStart={() => undefined} services={services} port={port} />);
    expect(byTestId("money-headline")?.textContent).toBe(`Re-prove ${shortWallet(TEST_WALLET)} to deposit`);
    port.answer("money/wallet-challenge", 200, challengeAnswer(TEST_WALLET));
    port.answer("money/wallet-link", 200, { ok: true, mode: "unchanged", wallet: TEST_WALLET, epoch: 1, ticket: TICKET });
    await click(byTestId("money-action-reprove"));
    expect(byTestId("money-headline")?.textContent).not.toMatch(/^Re-prove/);
    expect(byTestId("money-action-ante")).toBeTruthy();
  });

  it("aged: Ante goes to the deposit without a re-proof signature first (only this page's inference; the server then decides)", async () => {
    const { services, port } = connectedWorld();
    const key = await services.keys.create({ chainId: "uni-7", contract: TEST_CONTRACT, gameId: "g_table", playerId: "p-me", wallet: TEST_WALLET });
    if (!key.ok) throw new Error(key.reason);
    await render(<MoneyPanel room={room(joinerMoney(T0 - 25 * HOUR, [key.pubkey]))} onStart={() => undefined} services={services} port={port} />);
    expect(byTestId("money-headline")?.textContent).toMatch(/^Re-prove/);
    await click(byTestId("money-action-ante"));
    /* It reached the deposit step: the server's approval was asked (nothing scripted: the server didn't answer) -- and
       no message signature was asked for first. */
    expect(port.requests.map((request) => request.path)).toContain("money/join-admission");
    expect(signLinks(services.wallet.calls)).toEqual([]);
    expect(services.wallet.calls.some((call) => call.startsWith("signTx"))).toBe(false);
  });

  it("P3-ACCT (money review L2): a seat linked on ANOTHER device (no registered key here): Ante re-proves the SAME wallet -- one free signature that registers this browser's key with the link -- never the password route", async () => {
    const { services, port } = connectedWorld();
    act(() => updateMoneySession({ wallet: "connected", address: TEST_WALLET, confirmedUntil: null }));
    port.answer("money/wallet-challenge", 200, challengeAnswer(TEST_WALLET));
    port.answer("money/wallet-link", 200, { ok: true, mode: "unchanged", wallet: TEST_WALLET, epoch: 1, ticket: TICKET });
    const elsewhere = `02${"77".repeat(32)}`;
    await render(<MoneyPanel room={room(joinerMoney(T0, [elsewhere]))} onStart={() => undefined} services={services} port={port} />);
    expect(byTestId("money-headline")?.textContent).toMatch(/^Wallet verified/);
    await click(byTestId("money-action-ante"));
    expect(signLinks(services.wallet.calls)).toEqual([`signLink:${TEST_WALLET}:18COSMOS/WALLET-LINK/v1`]);
    expect(port.requests.map((request) => request.path)).toEqual(["money/wallet-challenge", "money/wallet-link"]);
    expect(port.requests[1].body.replace).toBeUndefined();
    const registered = String(port.requests[1].body.consentKey);
    expect(typeof registered).toBe("string");
    /* The Ante waits for the server's next view to show THIS browser's key on the link; nothing more is asked until then. */
    await settle();
    expect(port.requests).toHaveLength(2);
    await render(<MoneyPanel room={room(joinerMoney(T0, [elsewhere, registered]))} onStart={() => undefined} services={services} port={port} />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    await settle();
    const paths = port.requests.map((request) => request.path);
    expect(paths).toContain("money/join-admission");
    expect(paths).not.toContain("money/consent-key");
    expect(byTestId("money-reauth")).toBeNull();
    expect(services.wallet.calls.some((call) => call.startsWith("signTx"))).toBe(false);
  });

  it("a device without Keplr: the re-prove state says why it can't be done here, and nothing is pressed", async () => {
    const services = testServices();
    services.wallet.present = false;
    installMoneyServicesForTests(services);
    act(() => updateMoneySession({ wallet: "unavailable", address: null, confirmedUntil: null }));
    await render(<MoneyPanel room={room(joinerMoney(T0 - 25 * HOUR))} onStart={() => undefined} services={services} />);
    expect(byTestId("money-headline")?.textContent).toMatch(/^Re-prove/);
    expect(byTestId("money-blocker")?.textContent).toMatch(/Keplr isn't available in this browser/);
    expect((byTestId("money-action-connect") as HTMLButtonElement | null)?.disabled ?? true).toBe(true);
    expect(signLinks(services.wallet.calls)).toEqual([]);
  });
});

/* ================================================================== */
/* AUD-20.03                                                          */
/* ================================================================== */

describe("W2-M AUD-20.03, rendered: Change wallet asks first, then one signature", () => {
  it("the question names both wallets and signs nothing; Replace signs once with replace; Keep closes it", async () => {
    const { services, port } = connectedWorld(OTHER_WALLET);
    await render(<MoneyPanel room={room(unboundMoney())} onStart={() => undefined} services={services} port={port} />);
    await click(byTestId("money-action-replace-link"));
    expect(byTestId("money-replace-question")?.textContent).toBe(
      `This seat is linked to ${shortWallet(TEST_WALLET)}. Replace it with ${shortWallet(OTHER_WALLET)}? The old link stops working; nothing is charged. Keplr then asks you to sign one link message.`,
    );
    expect(signLinks(services.wallet.calls)).toEqual([]);
    expect(port.requests).toEqual([]);
    expect(byTestId("money-error")).toBeNull();
    /* Keep: nothing happened. */
    await click(Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Keep the linked wallet") ?? null);
    expect(byTestId("money-replace")).toBeNull();
    expect(port.requests).toEqual([]);
    /* Ask again, and Replace: one challenge, one signature, the link with replace. */
    port.answer("money/wallet-challenge", 200, challengeAnswer(OTHER_WALLET));
    port.answer("money/wallet-link", 200, { ok: true, mode: "issued", wallet: OTHER_WALLET, epoch: 2, ticket: "cd".repeat(32) });
    await click(byTestId("money-action-replace-link"));
    await click(byTestId("money-replace-confirm"));
    expect(signLinks(services.wallet.calls)).toEqual([`signLink:${OTHER_WALLET}:18COSMOS/WALLET-LINK/v1`]);
    expect(port.requests.map((request) => request.path)).toEqual(["money/wallet-challenge", "money/wallet-link"]);
    expect(port.requests[1].body.replace).toBe(true);
    expect(byTestId("money-notice")?.textContent).toBe(`Wallet linked: ${OTHER_WALLET}.`);
    expect(byTestId("money-replace")).toBeNull();
  });

  it("Keplr on the linked wallet: Change wallet says to switch accounts first, and asks Keplr and the server nothing", async () => {
    const { services, port } = connectedWorld(TEST_WALLET);
    await render(<MoneyPanel room={room(unboundMoney())} onStart={() => undefined} services={services} port={port} />);
    await click(byTestId("money-action-replace-link"));
    expect(byTestId("money-error")?.textContent).toMatch(/already linked to this seat.*switch accounts in Keplr first/);
    expect(byTestId("money-replace")).toBeNull();
    expect(signLinks(services.wallet.calls)).toEqual([]);
    expect(port.requests).toEqual([]);
  });

  it("the server asks to replace (the view hadn't shown the link): one question, saying Keplr signs once more -- no second error beside it", async () => {
    const { services, port } = connectedWorld(TEST_WALLET);
    port.answer("money/wallet-challenge", 200, challengeAnswer(TEST_WALLET));
    port.answer("money/wallet-link", 409, { error: "replace-required", reason: `This seat is linked to ${OTHER_WALLET}. Replace it with this wallet?` });
    await render(<MoneyPanel room={room(moneyView())} onStart={() => undefined} services={services} port={port} />);
    await click(byTestId("money-action-verify"));
    /* The server's sentence names the wallet that really stands (the view didn't know it). */
    expect(byTestId("money-replace-question")?.textContent).toBe(`This seat is linked to ${OTHER_WALLET}. Replace it with this wallet? The old link stops working; nothing is charged. Keplr asks you to sign the link message once more.`);
    expect(byTestId("money-error")).toBeNull();
    expect(byTestId("money-replace-confirm")).toBeTruthy();
  });
});

/* ================================================================== */
/* AUD-20.06 / AUD-20.07                                              */
/* ================================================================== */

const DIGEST = "dd".repeat(32);
const settlementView = (over: Partial<MoneySettlementView> = {}): MoneySettlementView => ({
  status: "recorded",
  phase: "settleable",
  chainState: "SETTLEABLE",
  seq: "25",
  settleDigest: DIGEST,
  domain: "cc".repeat(32),
  source: "terminal_payload",
  windowEnd: T0 + 600_000,
  livenessAvailableAt: null,
  resolverTimeoutAt: null,
  consentedSeats: [],
  payable: true,
  amounts: null,
  route: null,
  trustedSeq: "23",
  annulSigned: [],
  bond: "500000",
  lastCheckpoint: null,
  ...over,
});
const chainFacts = (over: Partial<ChainGameFacts> = {}): ChainGameFacts => ({
  state: "SETTLEABLE",
  creator: OTHER_WALLET,
  maxPlayers: 2,
  mode: "live",
  rulesEngineVersion: 13,
  variantsDigest: "00".repeat(32),
  denom: "ujunox",
  anteGross: "1000000",
  seats: [
    { wallet: TEST_WALLET, joinTicket: TICKET, consentPubkey: `02${"11".repeat(32)}` },
    { wallet: OTHER_WALLET, joinTicket: "ef".repeat(32), consentPubkey: `02${"22".repeat(32)}` },
  ],
  fundingDeadlineMs: null,
  paused: false,
  domain: "cc".repeat(32),
  trustedSeq: "23",
  settlement: { seq: "25", payloadDigest: DIGEST },
  bond: "500000",
  policy: "timed_remedy_v1",
  allowanceSecs: 1200,
  challengeWindowEndMs: T0 + 600_000,
  resolverTimeoutAtMs: null,
  resolverTimeoutSecs: 7_200,
  dispute: null,
  ...over,
});
const bandMoney = (settlement: MoneySettlementView, state: RoomMoneyView["escrow"]["state"] = "SETTLEABLE") =>
  moneyView({ escrow: { chainGameId: "7", state }, terms: { pot: "1980000" }, settlement, you: linked([], { funding: "funded", chainSeatIndex: 0, payoutWallet: TEST_WALLET, actions: ["challenge"] }) });
/* The band reads only the room's money (it sits under the final result, and in the bar while the game is played). */
const finished = (money: RoomMoneyView) => room(money);

describe("W2-M AUD-20.07 / 20.06, rendered: the dispute's deadline, Juno re-read at Continue, and the record", () => {
  it("Dispute: the confirm reads Juno and gives the resolver's deadline as a time; Continue signs once with Juno's bond", async () => {
    const { services, port } = connectedWorld();
    services.wallet.game = chainFacts();
    await render(<SettlementBand room={finished(bandMoney(settlementView()))} port={port} services={services} />);
    await click(byTestId("settlement-action-challenge"));
    const confirm = byTestId("settlement-confirm")?.textContent ?? "";
    expect(confirm).toContain(`the resolver has 2 hours to decide: until about ${formatMoneyTime(T0 + 2 * HOUR, { now: T0 })}.`);
    expect(confirm).not.toMatch(/its deadline/);
    await click(byTestId("settlement-continue"));
    const challenges = services.wallet.signed.filter((message) => message.kind === "challenge");
    expect(challenges).toHaveLength(1);
    expect(challenges[0].funds).toEqual([{ denom: "ujunox", amount: "500000" }]);
  });

  it("the bond on Juno moved between the confirm and Continue: nothing is signed, and the band says why", async () => {
    const { services, port } = connectedWorld();
    services.wallet.game = chainFacts();
    await render(<SettlementBand room={finished(bandMoney(settlementView()))} port={port} services={services} />);
    await click(byTestId("settlement-action-challenge"));
    services.wallet.game = chainFacts({ bond: "900000" });
    await click(byTestId("settlement-continue"));
    expect(services.wallet.signed).toEqual([]);
    expect(byTestId("settlement-error")?.textContent).toMatch(/different dispute bond/);
  });

  it("disputed: the band shows Juno's record (you, when, the bond, the evidence) under the server's headline", async () => {
    const { services, port } = connectedWorld();
    services.wallet.game = chainFacts({ state: "DISPUTED", challengeWindowEndMs: null, resolverTimeoutAtMs: T0 + 2 * HOUR, dispute: { challenger: TEST_WALLET, bond: "500000", evidenceHash: "ee".repeat(32), disputedAtMs: T0, resolution: null, resolvedAtMs: null } });
    const money = bandMoney(settlementView({ status: "disputed", phase: "disputed", chainState: "DISPUTED", windowEnd: null, resolverTimeoutAt: T0 + 2 * HOUR }), "DISPUTED");
    await render(<SettlementBand room={finished(money)} port={port} services={services} />);
    expect(byTestId("settlement-headline")?.textContent).toMatch(/^A player disputed the payout\. The resolver decides by /);
    expect(byTestId("settlement-dispute-record")?.textContent).toBe(`Disputed by you at ${formatMoneyTime(T0, { now: T0 })}, with a 0.5 JUNOX bond.Evidence recorded on Juno: ${"ee".repeat(8)}…`);
  });

  it("resolved by the resolver: the record says how it ended; Juno unreadable: one honest line, the headline unchanged", async () => {
    const { services, port } = connectedWorld();
    services.wallet.game = chainFacts({ state: "SETTLED", challengeWindowEndMs: null, dispute: { challenger: OTHER_WALLET, bond: "500000", evidenceHash: null, disputedAtMs: T0, resolution: "upheld", resolvedAtMs: T0 + HOUR } });
    const paid = bandMoney(settlementView({ status: "paid", phase: "closed", chainState: "SETTLED", route: "resolver_uphold", amounts: ["1480000", "500000"] }), "SETTLED");
    await render(<SettlementBand room={finished(paid)} port={port} services={services} />);
    expect(byTestId("settlement-headline")?.textContent).toBe(`Paid: 1.48 JUNOX sent to ${shortWallet(TEST_WALLET)}.`);
    expect(byTestId("settlement-dispute-record")?.textContent).toContain(`Disputed by the player whose wallet is ${shortWallet(OTHER_WALLET)}`);
    expect(byTestId("settlement-dispute-record")?.textContent).toContain(`The resolver upheld the recorded payout at ${formatMoneyTime(T0 + HOUR, { now: T0 })}.`);
    act(() => root.unmount());
    root = createRoot(container);
    services.wallet.game = null;
    await render(<SettlementBand room={finished(paid)} port={port} services={services} />);
    expect(byTestId("settlement-headline")?.textContent).toBe(`Paid: 1.48 JUNOX sent to ${shortWallet(TEST_WALLET)}.`);
    expect(byTestId("settlement-dispute-record")?.textContent).toBe("The dispute's record couldn't be read from Juno just now.");
  });

  it("a payout with no dispute reads no dispute record (no chain read for it)", async () => {
    const { services, port } = connectedWorld();
    services.wallet.game = chainFacts({ state: "SETTLED" });
    const paid = bandMoney(settlementView({ status: "paid", phase: "closed", chainState: "SETTLED", route: "consent_completed", amounts: ["1480000", "500000"] }), "SETTLED");
    await render(<SettlementBand room={finished(paid)} port={port} services={services} />);
    expect(byTestId("settlement-dispute-record")).toBeNull();
    expect(services.wallet.calls).not.toContain("chainGame:7");
  });
});

describe("W2-M review fixes, rendered", () => {
  it.each([
    ["the server's challenge answer names the wallet now standing", true],
    ["a server that doesn't say: the view's link is the check", false],
  ] as const)("Replace refuses if the seat's link moved after the question (%s): nothing signed, never a wallet the player wasn't asked about", async (_case, serverSays) => {
    const third = "juno1qyqszqgpqyqszqgpqyqszqgpqyqszqgpjnp7du";
    const { services, port } = connectedWorld(OTHER_WALLET);
    await render(<MoneyPanel room={room(unboundMoney())} onStart={() => undefined} services={services} port={port} />);
    await click(byTestId("money-action-replace-link"));
    expect(byTestId("money-replace-question")?.textContent).toContain(shortWallet(TEST_WALLET));
    /* Another device relinked the seat to a third wallet meanwhile. */
    const moved = moneyView({ you: linked([], { actions: ["link-wallet"], link: { wallet: third, epoch: 2, ticket: TICKET, linkedAt: T0, consentKeys: [] } }) });
    await render(<MoneyPanel room={room(serverSays ? unboundMoney() : moved)} onStart={() => undefined} services={services} port={port} />);
    port.answer("money/wallet-challenge", 200, serverSays ? { ...challengeAnswer(OTHER_WALLET), replaces: third } : challengeAnswer(OTHER_WALLET));
    await click(byTestId("money-replace-confirm"));
    expect(byTestId("money-error")?.textContent).toMatch(/linked wallet changed since you were asked, so nothing was signed/);
    expect(signLinks(services.wallet.calls)).toEqual([]);
    expect(port.requests.map((request) => request.path)).toEqual(["money/wallet-challenge"]);
  });

  it("the table bar's strip never reads Juno for the dispute record it doesn't show", async () => {
    const { services, port } = connectedWorld();
    services.wallet.game = chainFacts({ state: "DISPUTED", challengeWindowEndMs: null, dispute: { challenger: TEST_WALLET, bond: "500000", evidenceHash: null, disputedAtMs: T0, resolution: null, resolvedAtMs: null } });
    const money = bandMoney(settlementView({ status: "disputed", phase: "disputed", chainState: "DISPUTED", windowEnd: null, resolverTimeoutAt: T0 + 2 * HOUR }), "DISPUTED");
    await render(<SettlementBand room={finished(money)} compact port={port} services={services} />);
    expect(byTestId("money-strip")?.textContent).toMatch(/A player disputed the payout/);
    expect(services.wallet.calls).not.toContain("chainGame:7");
  });
});

/* ================================================================== */
/* Owner-approved follow-ups: AUD-20.13, AUD-20.14                    */
/* ================================================================== */

/** A joiner at a bound FUNDING table linked at `linkedAt`, with the server's proof time when given (`proofVerifiedAt`
 *  absent: an older server). */
const provenMoney = (linkedAt: number, proofVerifiedAt?: unknown) =>
  moneyView({
    escrow: { chainGameId: "7", state: "FUNDING", fundingDeadline: T0 + HOUR },
    start: { blocker: "need-funding" },
    you: linked([], { actions: ["deposit"], link: { wallet: TEST_WALLET, epoch: 1, ticket: TICKET, linkedAt, consentKeys: [], ...(proofVerifiedAt !== undefined ? { proofVerifiedAt: proofVerifiedAt as number } : {}) } }),
  });

describe("W2-M AUD-20.13, rendered: the server's proof time decides freshness after a reload", () => {
  it("an old link re-proven an hour ago: a fresh page (no record of its own) reads Wallet verified and Ante -- no Re-prove", async () => {
    const { services, port } = connectedWorld();
    await render(<MoneyPanel room={room(provenMoney(T0 - 48 * HOUR, T0 - HOUR))} onStart={() => undefined} services={services} port={port} />);
    expect(byTestId("money-headline")?.textContent).toBe(`Wallet verified · ${shortWallet(TEST_WALLET)}`);
    expect(byTestId("money-action-ante")?.textContent).toBe("Ante 1 JUNOX");
    expect(byTestId("money-action-reprove")).toBeNull();
  });

  it("a proof the server shows as over a day old: Re-prove, the server's word -- Ante re-proves FIRST (one signature), no bare Deposit beside it", async () => {
    const { services, port } = connectedWorld();
    await render(<MoneyPanel room={room(provenMoney(T0 - 48 * HOUR, T0 - 25 * HOUR))} onStart={() => undefined} services={services} port={port} />);
    expect(byTestId("money-headline")?.textContent).toBe(`Re-prove ${shortWallet(TEST_WALLET)} to deposit`);
    expect(byTestId("money-detail")?.textContent).toMatch(/^The server needs a fresh proof/);
    expect(byTestId("money-action-reprove")).toBeTruthy();
    expect(byTestId("money-action-open-review")).toBeNull();
    port.answer("money/wallet-challenge", 200, { ...challengeAnswer(TEST_WALLET), replaces: null });
    port.answer("money/wallet-link", 200, { ok: true, mode: "unchanged", wallet: TEST_WALLET, epoch: 1, ticket: TICKET });
    await click(byTestId("money-action-ante"));
    expect(signLinks(services.wallet.calls)).toEqual([`signLink:${TEST_WALLET}:18COSMOS/WALLET-LINK/v1`]);
    expect(port.requests.slice(0, 2).map((request) => request.path)).toEqual(["money/wallet-challenge", "money/wallet-link"]);
  });

  it("the server's time beats the link's own: a link made an hour ago whose proof the server shows as stale still asks", async () => {
    const { services, port } = connectedWorld();
    await render(<MoneyPanel room={room(provenMoney(T0 - HOUR, T0 - 25 * HOUR))} onStart={() => undefined} services={services} port={port} />);
    expect(byTestId("money-headline")?.textContent).toMatch(/^Re-prove/);
  });

  it("re-proven on this page before the server's next view: the page's accepted proof counts; the pushed view then agrees", async () => {
    const { services, port } = connectedWorld();
    port.answer("money/wallet-challenge", 200, { ...challengeAnswer(TEST_WALLET), replaces: null });
    port.answer("money/wallet-link", 200, { ok: true, mode: "unchanged", wallet: TEST_WALLET, epoch: 1, ticket: TICKET });
    await render(<MoneyPanel room={room(provenMoney(T0 - 48 * HOUR, T0 - 25 * HOUR))} onStart={() => undefined} services={services} port={port} />);
    await click(byTestId("money-action-reprove"));
    expect(signLinks(services.wallet.calls)).toHaveLength(1);
    expect(byTestId("money-headline")?.textContent).toBe(`Wallet verified · ${shortWallet(TEST_WALLET)}`);
    await render(<MoneyPanel room={room(provenMoney(T0 - 48 * HOUR, T0))} onStart={() => undefined} services={services} port={port} />);
    expect(byTestId("money-headline")?.textContent).toBe(`Wallet verified · ${shortWallet(TEST_WALLET)}`);
  });

  it("near the limit by the server's time (inside the margin): an inference, so the Ante (straight to the deposit) stays beside Re-prove", async () => {
    const { services, port } = connectedWorld();
    await render(<MoneyPanel room={room(provenMoney(T0 - 48 * HOUR, T0 - (24 * HOUR - 2 * 60_000)))} onStart={() => undefined} services={services} port={port} />);
    expect(byTestId("money-headline")?.textContent).toMatch(/^Re-prove/);
    expect(byTestId("money-action-ante")?.textContent).toBe("Ante 1 JUNOX");
    expect(byTestId("money-action-reprove")).toBeTruthy();
  });

  it("the host's CreateGame needs no approval: a server-stale proof never hides the host's deposit", async () => {
    const { services, port } = connectedWorld();
    const hostMoney = moneyView({ you: linked([], { actions: ["open-escrow", "link-wallet"], link: { wallet: TEST_WALLET, epoch: 1, ticket: TICKET, linkedAt: T0 - 48 * HOUR, consentKeys: [], proofVerifiedAt: T0 - 48 * HOUR } }) });
    await render(<MoneyPanel room={room(hostMoney, { hostId: "p-me", you: { role: "host", playerId: "p-me", kicked: false, canStart: false } })} onStart={() => undefined} services={services} port={port} />);
    expect(byTestId("money-action-ante")?.textContent).toBe("Ante 1 JUNOX");
    expect(byTestId("money-action-reprove")).toBeNull();
  });

  it.each([
    ["absent (an older server)", undefined],
    ["not a number", "yesterday"],
    ["not finite", Number.NaN],
  ] as const)("the field %s: the page falls back to the link's own time -- Re-prove with the Ante beside it, never a false 'fresh'", async (_case, value) => {
    const { services, port } = connectedWorld();
    await render(<MoneyPanel room={room(provenMoney(T0 - 25 * HOUR, value))} onStart={() => undefined} services={services} port={port} />);
    expect(byTestId("money-headline")?.textContent).toMatch(/^Re-prove/);
    expect(byTestId("money-action-ante")?.textContent).toBe("Ante 1 JUNOX");
    expect(byTestId("money-action-reprove")).toBeTruthy();
  });
});

describe("W2-M AUD-20.14, rendered: the wallet a link would replace is named before Keplr signs", () => {
  it("disclosed first: the question names both wallets and nothing is signed; Keep the linked wallet ends it with nothing sent", async () => {
    const { services, port } = connectedWorld(TEST_WALLET);
    port.answer("money/wallet-challenge", 200, { ...challengeAnswer(TEST_WALLET), replaces: OTHER_WALLET });
    await render(<MoneyPanel room={room(moneyView())} onStart={() => undefined} services={services} port={port} />);
    await click(byTestId("money-action-verify"));
    expect(byTestId("money-replace-question")?.textContent).toBe(
      `This seat is linked to ${shortWallet(OTHER_WALLET)}. Replace it with ${shortWallet(TEST_WALLET)}? The old link stops working; nothing is charged. Keplr then asks you to sign one link message.`,
    );
    expect(byTestId("money-error")).toBeNull();
    expect(signLinks(services.wallet.calls)).toEqual([]);
    await click(Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Keep the linked wallet") ?? null);
    expect(byTestId("money-replace")).toBeNull();
    expect(port.requests.map((request) => request.path)).toEqual(["money/wallet-challenge"]);
    expect(signLinks(services.wallet.calls)).toEqual([]);
  });

  it("confirmed: a fresh challenge (still naming that wallet), ONE Keplr signature, the link sent with replace", async () => {
    const { services, port } = connectedWorld(TEST_WALLET);
    port.answer("money/wallet-challenge", 200, { ...challengeAnswer(TEST_WALLET), replaces: OTHER_WALLET });
    port.answer("money/wallet-challenge", 200, { ...challengeAnswer(TEST_WALLET), replaces: OTHER_WALLET });
    port.answer("money/wallet-link", 200, { ok: true, mode: "issued", wallet: TEST_WALLET, epoch: 2, ticket: "cd".repeat(32) });
    await render(<MoneyPanel room={room(moneyView())} onStart={() => undefined} services={services} port={port} />);
    await click(byTestId("money-action-verify"));
    await click(byTestId("money-replace-confirm"));
    expect(signLinks(services.wallet.calls)).toEqual([`signLink:${TEST_WALLET}:18COSMOS/WALLET-LINK/v1`]);
    expect(port.requests.map((request) => request.path)).toEqual(["money/wallet-challenge", "money/wallet-challenge", "money/wallet-link"]);
    expect(port.requests[2].body.replace).toBe(true);
    expect(byTestId("money-notice")?.textContent).toBe(`Wallet linked: ${TEST_WALLET}.`);
  });

  it("a link made between the challenge and the signature (the race): the server's own replace-required still answers, and the question says Keplr signs once more", async () => {
    const { services, port } = connectedWorld(TEST_WALLET);
    port.answer("money/wallet-challenge", 200, { ...challengeAnswer(TEST_WALLET), replaces: null });
    port.answer("money/wallet-link", 409, { error: "replace-required", reason: `This seat is linked to ${OTHER_WALLET}. Replace it with this wallet?` });
    await render(<MoneyPanel room={room(moneyView())} onStart={() => undefined} services={services} port={port} />);
    await click(byTestId("money-action-verify"));
    expect(signLinks(services.wallet.calls)).toHaveLength(1);
    expect(byTestId("money-replace-question")?.textContent).toMatch(/^This seat is linked to juno1q+nrql8a\. Replace it with this wallet\? .*once more\.$/);
  });

  it("the race, then a second change before the confirm: the fresh challenge names the wallet now standing and the player is asked about THAT one -- never a silent replace", async () => {
    const third = "juno1qyqszqgpqyqszqgpqyqszqgpqyqszqgpjnp7du";
    const { services, port } = connectedWorld(TEST_WALLET);
    port.answer("money/wallet-challenge", 200, { ...challengeAnswer(TEST_WALLET), replaces: null });
    port.answer("money/wallet-link", 409, { error: "replace-required", reason: `This seat is linked to ${OTHER_WALLET}. Replace it with this wallet?` });
    port.answer("money/wallet-challenge", 200, { ...challengeAnswer(TEST_WALLET), replaces: third });
    await render(<MoneyPanel room={room(moneyView())} onStart={() => undefined} services={services} port={port} />);
    await click(byTestId("money-action-verify"));
    await click(byTestId("money-replace-confirm"));
    expect(signLinks(services.wallet.calls)).toHaveLength(1);
    expect(byTestId("money-replace-question")?.textContent).toMatch(new RegExp(`^This seat is linked to ${shortWallet(third)}\\. Replace it with ${shortWallet(TEST_WALLET)}\\?.*sign one link message\\.$`));
    port.answer("money/wallet-challenge", 200, { ...challengeAnswer(TEST_WALLET), replaces: third });
    port.answer("money/wallet-link", 200, { ok: true, mode: "issued", wallet: TEST_WALLET, epoch: 3, ticket: "cd".repeat(32) });
    await click(byTestId("money-replace-confirm"));
    expect(signLinks(services.wallet.calls)).toHaveLength(2);
    expect(port.requests.at(-1)?.body.replace).toBe(true);
  });

  it("confirmed, but the link has gone meanwhile (the fresh hint is null): nothing signed, asked to look again", async () => {
    const { services, port } = connectedWorld(TEST_WALLET);
    port.answer("money/wallet-challenge", 200, { ...challengeAnswer(TEST_WALLET), replaces: OTHER_WALLET });
    port.answer("money/wallet-challenge", 200, { ...challengeAnswer(TEST_WALLET), replaces: null });
    await render(<MoneyPanel room={room(moneyView())} onStart={() => undefined} services={services} port={port} />);
    await click(byTestId("money-action-verify"));
    await click(byTestId("money-replace-confirm"));
    expect(byTestId("money-error")?.textContent).toMatch(/linked wallet changed since you were asked, so nothing was signed/);
    expect(signLinks(services.wallet.calls)).toEqual([]);
  });

  it("Re-prove meets a link it didn't know of: the question names the standing wallet before anything is signed", async () => {
    const { services, port } = connectedWorld(TEST_WALLET);
    port.answer("money/wallet-challenge", 200, { ...challengeAnswer(TEST_WALLET), replaces: OTHER_WALLET });
    await render(<MoneyPanel room={room(provenMoney(T0 - 48 * HOUR))} onStart={() => undefined} services={services} port={port} />);
    await click(byTestId("money-action-reprove"));
    expect(byTestId("money-replace-question")?.textContent).toMatch(new RegExp(`^This seat is linked to ${shortWallet(OTHER_WALLET)}\\.`));
    expect(signLinks(services.wallet.calls)).toEqual([]);
  });

  it("the answer is read strictly: a malformed hint is a bad answer, and nothing is signed", async () => {
    const { services, port } = connectedWorld(TEST_WALLET);
    port.answer("money/wallet-challenge", 200, { ...challengeAnswer(TEST_WALLET), replaces: 42 });
    await render(<MoneyPanel room={room(moneyView())} onStart={() => undefined} services={services} port={port} />);
    await click(byTestId("money-action-verify"));
    expect(byTestId("money-error")).toBeTruthy();
    expect(signLinks(services.wallet.calls)).toEqual([]);
  });
});

/* ================================================================== */
/* The boundaries                                                     */
/* ================================================================== */

describe("W2-M boundaries: no-money tables, and the room strip's own slots", () => {
  it("a no-money table: no money panel, no band in the bar, and no wallet or chain read at all", async () => {
    const services = testServices();
    installMoneyServicesForTests(services);
    await render(
      <>
        <MoneyPanel room={room(undefined)} onStart={() => undefined} services={services} />
        <SettlementBand room={room(undefined)} compact services={services} />
      </>,
    );
    expect(container.textContent).toBe("");
    expect(services.wallet.calls.filter((call) => call !== "account")).toEqual([]);
    expect(services.wallet.signed).toEqual([]);
  });

  it("the money surfaces keep their own sentences: they never write the room strip's connection or refusal slots (W3-C), and those never read money state", () => {
    const money = ["money/moneyFlow.ts", "money/moneyActions.ts", "money/useMoneyTable.ts", "money/moneySession.ts", "money/keplrWallet.ts", "money/walletChecks.ts", "components/money/MoneyPanel.tsx", "components/money/SettlementBand.tsx"];
    for (const file of money) {
      const source = readStripped(file);
      expect({ file, slots: /roomNotices|RoomNoticeSlots|submissionAnswer|refusedAction/.test(source) }).toEqual({ file, slots: false });
    }
    for (const file of ["utils/roomNotices.ts", "components/RoomNoticeSlots.tsx", "utils/submissionAnswer.ts"]) {
      expect({ file, money: /from "\.\.?\/(\.\.\/)?money\//.test(readStripped(file)) }).toEqual({ file, money: false });
    }
  });
});
