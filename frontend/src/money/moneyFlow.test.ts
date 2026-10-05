/** @jest-environment node */
// ESCROW-4 (brief §14, §21, §23): a money seat's state is DERIVED -- from the server's view, this browser's pending
// transaction and signing key, and this page's Keplr connection and grant -- so every reload lands in the right step.
// One state per step; one primary button at a time; funded only when the server says the chain shows it.

import { seatFlow, settlementFlow, startBlockerSentence, type FlowInput } from "./moneyFlow";
import { linked, moneyView, you, T0, TEST_WALLET, TICKET } from "./moneyTestSupport";
import { formatMoneyTime } from "./moneyTime";
import type { PendingWalletTx } from "./pendingTx";
import type { MoneySettlementView } from "../utils/moneyProtocol";

const connected = { kind: "connected" as const, address: TEST_WALLET };
const input = (over: Partial<FlowInput>): FlowInput => ({ view: moneyView(), isHost: false, wallet: { kind: "disconnected" }, confirmed: false, pending: null, holdsChainKey: false, ui: "idle", now: T0, ...over });
const pendingTx = (stage: "signed" | "sent" | "landed", kind: PendingWalletTx["kind"] = "join"): PendingWalletTx => ({ v: 1, gameId: "g", playerId: "p-me", kind, chainId: "uni-7", contract: "juno1c", sender: TEST_WALLET, chainGameId: "7", txHash: "AB".repeat(32), txBytes: "AAAA", timeoutHeight: "1100", createdAt: T0, stage, consentKey: null });
const bound = { chainGameId: "7", state: "FUNDING" as const, fundingDeadline: T0 + 3_600_000 };

describe("ESCROW-4: the funding progression, reload by reload", () => {
  it("P3-ACCT: no link yet -- ONE button, Ante, whether Keplr is connected or not, with no client-side 'Confirm it's you' step (the server asks only when it must)", () => {
    const disconnected = seatFlow(input({ view: moneyView({ escrow: bound }) }));
    expect([disconnected.step, disconnected.primary?.kind, disconnected.primary?.label]).toEqual(["connect", "ante", "Ante 1 JUNOX"]);
    const connectedUnconfirmed = seatFlow(input({ wallet: connected, view: moneyView({ escrow: bound }) }));
    expect([connectedUnconfirmed.step, connectedUnconfirmed.primary?.kind]).toEqual(["link", "ante"]);
    expect(connectedUnconfirmed.detail).toMatch(/verifies your wallet with a free signature, then deposits/);
    /* Before the host opens the table, a joiner's one button verifies the wallet only (free). */
    const early = seatFlow(input({ wallet: connected }));
    expect([early.primary?.kind, early.primary?.label]).toEqual(["verify", "Verify wallet (free)"]);
    expect(early.detail).toMatch(/The host opens the table on Juno first/);
  });

  it("a device without Keplr, or a build with no escrow, can't do the wallet steps -- and says why", () => {
    const phone = seatFlow(input({ wallet: { kind: "unavailable" } }));
    expect(phone.primary).toBeNull();
    expect(phone.blocker).toMatch(/Keplr isn't available.*keep playing here/);
    const unpinned = seatFlow(input({ wallet: { kind: "no-pin", reason: "This build has no Juno escrow configured." } }));
    expect(unpinned.blocker).toBe("This build has no Juno escrow configured.");
  });

  it("linked: the host antes to open the escrow; a joiner waits for it, then antes; the older review path still reaches Approve in Keplr", () => {
    const host = seatFlow(input({ isHost: true, view: moneyView({ you: linked([], { actions: ["open-escrow"] }) }) }));
    expect([host.step, host.primary?.kind, host.primary?.label]).toEqual(["review", "ante", "Ante 1 JUNOX"]);
    const waiting = seatFlow(input({ view: moneyView({ you: linked([], { actions: ["link-wallet"] }) }) }));
    expect([waiting.step, waiting.primary]).toEqual(["review", null]);
    expect(waiting.detail).toMatch(/Waiting for the host to open the table on Juno/);
    const joiner = seatFlow(input({ view: moneyView({ escrow: bound, you: linked([], { actions: ["deposit", "link-wallet"] }) }) }));
    expect([joiner.primary?.kind, joiner.primary?.label]).toEqual(["ante", "Ante 1 JUNOX"]);
    expect(joiner.others.map((action) => action.kind)).toEqual(["replace-link"]);
    const review = seatFlow(input({ ui: "review", wallet: connected, view: moneyView({ escrow: bound, you: linked([], { actions: ["deposit"] }) }) }));
    expect([review.step, review.primary?.kind]).toEqual(["review", "approve"]);
    const approving = seatFlow(input({ ui: "approving", view: moneyView({ escrow: bound, you: linked([], { actions: ["deposit"] }) }) }));
    expect([approving.step, approving.headline]).toEqual(["approve", "Approve in Keplr…"]);
    const wrongAccount = seatFlow(input({ ui: "review", wallet: { kind: "connected", address: "juno1another" }, view: moneyView({ escrow: bound, you: linked([], { actions: ["deposit"] }) }) }));
    expect(wrongAccount.blocker).toMatch(/Switch accounts in Keplr/);
  });

  it("signed locally, then broadcast (or unknown): 'Sent' -- and NEVER funded from local persistence", () => {
    const view = moneyView({ escrow: bound, you: linked([], { actions: ["deposit"] }) });
    const signed = seatFlow(input({ view, pending: pendingTx("signed") }));
    expect([signed.step, signed.headline, signed.primary?.kind]).toEqual(["sent", "Signed — not sent yet.", "resend"]);
    expect(signed.detail).toMatch(/can land only once/);
    const sent = seatFlow(input({ view, pending: pendingTx("sent") }));
    expect([sent.step, sent.headline, sent.primary]).toEqual(["sent", "Sent — waiting for Juno.", null]);
    expect(sent.detail).toMatch(/don't send it again/);
    /* The server's hint (this device may have dropped its record): it says sent, and claims nothing about which device. */
    const serverHint = seatFlow(input({ view: moneyView({ escrow: bound, you: linked([], { funding: "sent", pending: { kind: "join", txHash: "CD".repeat(32), at: T0 } }) }) }));
    expect(serverHint.headline).toBe("Sent — waiting for Juno.");
    /* Included by Juno, not yet shown by the table (review R-M1): still no second deposit offered. */
    const landed = seatFlow(input({ view, pending: pendingTx("landed") }));
    expect([landed.step, landed.headline, landed.primary]).toEqual(["sent", "Juno included your deposit — the table shows it in a moment.", null]);
    for (const flow of [signed, sent, serverHint, landed]) expect(flow.step).not.toBe("funded");
    /* A withdrawal signed but never sent is offered again, whatever the seat's step. */
    const unsentWithdraw = seatFlow(input({ view: moneyView({ escrow: bound, you: linked([], { funding: "funded", payoutWallet: TEST_WALLET, chainSeatIndex: 1, actions: ["withdraw"] }) }), pending: pendingTx("signed", "withdraw") }));
    expect(unsentWithdraw.others.map((action) => action.kind)).toEqual(["resend", "withdraw"]);
  });

  it("funded (the chain says so): withdraw; the host may cancel; Start only when the server's view allows it", () => {
    const fundedYou = linked([], { funding: "funded", chainSeatIndex: 1, payoutWallet: TEST_WALLET, actions: ["withdraw"] });
    const funded = seatFlow(input({ view: moneyView({ escrow: { ...bound, fundedSeats: 1 }, start: { blocker: "need-funding" }, you: fundedYou }) }));
    expect([funded.step, funded.primary]).toEqual(["funded", null]);
    expect(funded.others.map((action) => action.kind)).toEqual(["withdraw"]);
    expect(funded.detail).toMatch(/Waiting for 1 player to fund/);
    /* The host is the escrow's creator: Cancel, never Withdraw (the server's list says so; review R-H1). */
    const host = seatFlow(input({ isHost: true, view: moneyView({ escrow: { ...bound, state: "FUNDED", fundedSeats: 2 }, start: { state: "ready", blocker: null, canStart: true }, you: { ...fundedYou, actions: ["cancel-escrow", "start"] } }) }));
    expect([host.primary?.kind, host.others.map((action) => action.kind)]).toEqual(["start", ["cancel-escrow"]]);
    expect(host.detail).toMatch(/cancel the table on Juno/);
    const rolledBack = seatFlow(input({ view: moneyView({ escrow: bound, start: { state: "rolled-back", blocker: "need-funding", epoch: 1 }, you: fundedYou }) }));
    expect(rolledBack.detail).toMatch(/last Start didn't go through on Juno; the table is back to funding/);
    /* A funded joiner while the host hasn't started: when they may (review R-H2). */
    const waiting = seatFlow(input({ view: moneyView({ escrow: { ...bound, state: "FUNDED", fundedSeats: 2 }, start: { state: "ready", blocker: null, canStart: false, anyoneMayStartAt: T0 + 600_000 }, you: fundedYou }) }));
    /* W2-K (OD-9(a)): local time with its zone, from the one formatter -- never a bare HH:MM. */
    expect(waiting.detail).toContain(`The host can start now; if they haven't by ${formatMoneyTime(T0 + 600_000, { now: T0 })}, you can.`);
    expect(waiting.detail).not.toMatch(/by \d{1,2}:\d\d,/);
    /* A host whose deposit left the escrow (the contract lets a creator withdraw): Cancel, with why. */
    const emptied = seatFlow(input({ isHost: true, wallet: connected, view: moneyView({ escrow: bound, you: linked([], { actions: ["cancel-escrow"] }) }) }));
    expect([emptied.primary, emptied.others.map((action) => action.kind)]).toEqual([null, ["cancel-escrow"]]);
    expect(emptied.detail).toMatch(/isn't in this table's escrow on Juno anymore/);
    /* ...but only when Juno was actually read: an unreadable chain is said as such, never guessed (verification pass). */
    const unreadable = seatFlow(input({ isHost: true, wallet: connected, view: moneyView({ escrow: { chainGameId: "7", state: "unknown" }, start: { blocker: "chain-unavailable" }, you: linked([], { actions: [] }) }) }));
    expect(unreadable.detail).toMatch(/Juno can't be read right now/);
  });

  it("frozen/starting, started, held, cancelled: the seat's money says so, and offers nothing that can't be done", () => {
    const starting = seatFlow(input({ view: moneyView({ escrow: { ...bound, state: "FUNDED" }, start: { state: "starting", blocker: null }, you: linked([], { funding: "funded" }) }) }));
    expect([starting.stage, starting.step, starting.primary, starting.others]).toEqual(["starting", "locked", null, []]);
    const started = seatFlow(input({ view: moneyView({ escrow: { ...bound, state: "IN_PROGRESS" }, start: { state: "started", blocker: null }, you: linked([], { funding: "funded" }) }) }));
    expect([started.stage, started.others]).toEqual(["started", []]);
    /* Started on Juno but not dealt (the table stays here): the escrow's own exits, when legal (review R-M10). */
    const stuck = seatFlow(input({ wallet: connected, view: moneyView({ escrow: { ...bound, state: "IN_PROGRESS" }, start: { state: "started", blocker: null }, you: linked([], { funding: "funded", actions: ["liveness-settle", "annul"] }) }) }));
    expect(stuck.others.map((action) => action.kind)).toEqual(["liveness-settle", "annul"]);
    const held = seatFlow(input({ view: moneyView({ held: true, you: linked([], { funding: "funded" }) }) }));
    expect([held.stage, held.headline]).toEqual(["held", "This table's money is on hold for review."]);
    expect(held.detail).toMatch(/Juno's own exits still work/);
    /* Held before the Start: Juno's exits stay offered (review R-M7); a seat with no deposit is told it has none. */
    const heldExit = seatFlow(input({ wallet: connected, view: moneyView({ held: true, escrow: bound, you: linked([], { funding: "funded", chainSeatIndex: 1, actions: ["withdraw"] }) }) }));
    expect(heldExit.others.map((action) => action.kind)).toEqual(["withdraw"]);
    const heldNone = seatFlow(input({ view: moneyView({ held: true, you: linked([], { funding: "linked" }) }) }));
    expect(heldNone.detail).toMatch(/You have no deposit in its escrow/);
    const cancelled = seatFlow(input({ view: moneyView({ escrow: { state: "CANCELLED" } }) }));
    expect(cancelled.stage).toBe("cancelled");
  });

  it("a deposit whose link a security event ended is relinked (free) or withdrawn -- never reassigned", () => {
    const unlinkedYou = you({ funding: "unlinked", chainSeatIndex: 1, unlinkedDeposit: { wallet: TEST_WALLET }, actions: ["relink", "withdraw"] });
    const needConnect = seatFlow(input({ view: moneyView({ escrow: bound, you: unlinkedYou }) }));
    expect([needConnect.headline, needConnect.primary?.kind]).toEqual(["Your deposit isn't linked to your seat anymore.", "connect"]);
    const relink = seatFlow(input({ wallet: connected, confirmed: true, view: moneyView({ escrow: bound, you: unlinkedYou }) }));
    expect([relink.primary?.kind, relink.others.map((action) => action.kind)]).toEqual(["relink", ["withdraw"]]);
  });

  it("a watcher reads the table's terms and what it waits for", () => {
    const watcher = seatFlow(input({ view: moneyView({ you: null }) }));
    expect([watcher.stage, watcher.primary]).toEqual(["watching", null]);
    expect(watcher.headline).toMatch(/1 JUNOX per seat/);
    expect(startBlockerSentence(moneyView(), "unknown-deposit")).toMatch(/unknown wallet/);
    expect(TICKET).toHaveLength(64);
  });
});

describe("ESCROW-4: the financial band under the result (the result is final; the band never says otherwise)", () => {
  const settlement = (over: Partial<MoneySettlementView>): MoneySettlementView => ({
    status: "none",
    phase: "in-progress",
    chainState: "IN_PROGRESS",
    seq: null,
    settleDigest: null,
    domain: "aa".repeat(32),
    source: null,
    windowEnd: null,
    livenessAvailableAt: null,
    resolverTimeoutAt: null,
    consentedSeats: [],
    payable: null,
    amounts: null,
    route: null,
    trustedSeq: "4",
    annulSigned: [],
    lastCheckpoint: null,
    bond: "500000",
    ...over,
  });
  const seated = (actions: string[]) => linked([], { funding: "funded", chainSeatIndex: 0, payoutWallet: TEST_WALLET, chainConsentKey: `02${"11".repeat(32)}`, actions: actions as never });
  const band = (s: MoneySettlementView, actions: string[], holdsChainKey = true, verification: "match" | "mismatch" | "unavailable" = "match") => settlementFlow({ view: moneyView({ settlement: s, you: seated(actions) }), holdsChainKey, verification, now: T0 });

  it("in play: nothing is needed; the inactivity exit and annul are offered only when legal", () => {
    const playing = band(settlement({ lastCheckpoint: { seq: "8", logLen: 4, roundKey: "OR 2.1", confirmed: true }, livenessAvailableAt: T0 + 86_400_000 }), ["annul"]);
    expect(playing.headline).toBe("Standings last recorded on Juno at OR 2.1.");
    expect(playing.detail).toMatch(/closing the browser changes nothing about your deposit/);
    expect(playing.actions.map((action) => action.kind)).toEqual(["annul"]);
  });

  it("recorded: approve early only on the key's device and only when this device's check matches; a mismatch leads with Dispute", () => {
    const recorded = settlement({ status: "recorded", chainState: "SETTLEABLE", seq: "9", settleDigest: "cc".repeat(32), windowEnd: T0 + 600_000 });
    expect(band(recorded, ["approve-payout", "challenge"]).actions.map((action) => action.kind)).toEqual(["approve-payout", "challenge"]);
    const elsewhere = band(recorded, ["approve-payout", "challenge", "move-signing-key"], false);
    expect(elsewhere.actions.map((action) => action.kind)).toEqual(["move-signing-key", "challenge"]);
    expect(elsewhere.detail).toMatch(/device holding this table's signing key/);
    const mismatch = band(recorded, ["approve-payout", "challenge"], true, "mismatch");
    expect(mismatch.actions[0]).toMatchObject({ kind: "challenge", tone: "danger" });
    expect(mismatch.detail).toMatch(/doesn't match what Juno received/);
    expect(band(recorded, ["approve-payout", "challenge"], true, "unavailable").actions.map((action) => action.kind)).toEqual(["challenge"]);
  });

  it("every other status has its own words", () => {
    expect(band(settlement({ status: "preparing" }), []).headline).toBe("Result final. Preparing the settlement on Juno…");
    expect(band(settlement({ status: "submitted" }), []).headline).toBe("Result sent to Juno — confirming…");
    expect(band(settlement({ status: "release-available" }), ["release-payout"]).actions[0].kind).toBe("release-payout");
    expect(band(settlement({ status: "paused" }), []).headline).toMatch(/paused/);
    expect(band(settlement({ status: "disputed", resolverTimeoutAt: T0 + 3_600_000 }), []).headline).toMatch(/resolver decides/);
    expect(band(settlement({ status: "paid", amounts: ["1500000", "480000"] }), []).headline).toBe(`Paid: 1.5 JUNOX sent to juno12gdm…783a.`);
    expect(band(settlement({ status: "paid", amounts: ["0", "1980000"] }), []).headline).toBe("No payout for this seat.");
    expect(band(settlement({ status: "refunded", amounts: ["990000", "990000"] }), []).headline).toMatch(/Refunded: 0.99 JUNOX/);
    expect(band(settlement({ status: "annulled", amounts: ["990000", "990000"] }), []).headline).toMatch(/Annulled/);
    expect(band(settlement({ status: "held" }), []).headline).toBe("Payout on hold for review.");
  });

  it("held or paused: Juno's own exits stay offered (reviews R-M2, R-M7)", () => {
    const held = band(settlement({ status: "held", chainState: "SETTLEABLE", windowEnd: T0 + 600_000 }), ["challenge", "liveness-settle"]);
    expect(held.actions.map((action) => action.kind)).toEqual(["challenge", "liveness-settle"]);
    const paused = band(settlement({ status: "paused", chainState: "SETTLEABLE", windowEnd: T0 + 600_000 }), ["challenge"]);
    expect(paused.actions.map((action) => action.kind)).toEqual(["challenge"]);
  });

  it("a device without Keplr offers only what its own key signs, and says where the rest is done (review R-M3)", () => {
    const recorded = settlement({ status: "recorded", chainState: "SETTLEABLE", seq: "9", settleDigest: "cc".repeat(32), windowEnd: T0 + 600_000 });
    const view = moneyView({ settlement: recorded, you: seated(["approve-payout", "challenge", "move-signing-key", "annul"]) });
    const phone = settlementFlow({ view, holdsChainKey: true, verification: "match", now: T0, keplr: false });
    expect(phone.actions.map((action) => action.kind)).toEqual(["approve-payout", "annul"]);
    expect(phone.detail).toMatch(/sent with Keplr: use a device that has it/);
    const desk = settlementFlow({ view, holdsChainKey: true, verification: "match", now: T0, keplr: true });
    expect(desk.actions.map((action) => action.kind)).toEqual(["approve-payout", "challenge", "annul"]);
  });
});
