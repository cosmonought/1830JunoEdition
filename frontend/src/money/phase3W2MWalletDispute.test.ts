/** @jest-environment node */
//
// ==================================================================
//  PHASE 3 W2-M: WALLET AND DISPUTE UX -- the derivations, the sentences and the actions, against a fake Keplr,
//  in-memory keys, a scripted server and a fake Juno
// ==================================================================
//
// AUD-20.02 (JX-3A E-1)  a seat whose wallet proof can't be counted on for a deposit says "re-prove", not "Wallet
//                        linked", and re-proves the SAME wallet (free) -- never through "Change wallet".
// AUD-20.03 (JX-3A E-2)  "Change wallet" asks BEFORE Keplr signs, then signs once (replace stated up front); the same
//                        wallet is no change and asks nothing of Keplr.
// AUD-20.04 (JX-3A E-3)  an ended "Confirm it's you" and an ended link request are said specifically.
// AUD-20.05 (JX-3A B-3)  a decline in Keplr is `rejected` wherever Keplr asked, never `unknown`.
// AUD-20.06 (JX-6C)      a Dispute re-reads Juno through the pinned endpoint and refuses on any difference.
// AUD-20.07 (JX-6E)      the dispute confirm gives the resolver's deadline as a time; the band's record is Juno's.

import { walletLinkChallengeText } from "../gameEngine/escrow/walletLinkChallengeV1";
import { classifyChainError, createKeplrWallet, DECLINED_IN_KEPLR } from "./keplrWallet";
import { approveDeposit, disputeChainFacts, linkWallet, prepareReplace, settlementTx, type TableContext } from "./moneyActions";
import { disputeConfirmSentence, disputeRecordLines, durationText, linkRequestEndedSentence, proofAgedOut, reconfirmSentence, seatFlow, WALLET_PROOF_MAX_AGE_MS, type DisputeRead, type FlowInput } from "./moneyFlow";
import { installMoneyServicesForTests, moneySession, proofKey, updateMoneySession } from "./moneySession";
import { linked, moneyView, OTHER_WALLET, scriptedPort, T0, TEST_CONTRACT, TEST_PIN, TEST_WALLET, TICKET, testServices } from "./moneyTestSupport";
import { formatMoneyTime } from "./moneyTime";
import { resolveVariants } from "../gameEngine/gameVariants";
import { challengeProblem, chainGameFactsOf, withdrawMessage, type ChainGameFacts } from "./walletChecks";
import { shortWallet, type MoneySettlementView } from "../utils/moneyProtocol";

const VARIANTS = resolveVariants({} as never);
const SITE = "https://play.example";
const HOUR = 3_600_000;
const connected = { kind: "connected" as const, address: TEST_WALLET };
const bound = { chainGameId: "7", state: "FUNDING" as const, fundingDeadline: T0 + HOUR };

afterEach(() => {
  installMoneyServicesForTests(null);
});

function ctx(over: Partial<TableContext> & Pick<TableContext, "view">): TableContext {
  return { gameId: "g_table", variants: VARIANTS, isHost: false, site: SITE, ...over };
}
const flowInput = (over: Partial<FlowInput>): FlowInput => ({ view: moneyView(), isHost: false, wallet: connected, confirmed: true, pending: null, holdsChainKey: false, ui: "idle", now: T0, ...over });
const challengeText = (wallet: string, expiresAt = T0 + 300_000) =>
  walletLinkChallengeText({ appName: "Project 18XX", site: SITE, chainId: "uni-7", contract: TEST_CONTRACT, gameId: "g_table", playerId: "p-me", wallet, nonce: "ab".repeat(16), expiresAt });

/* ================================================================== */
/* AUD-20.02 (E-1): the aged proof                                    */
/* ================================================================== */

describe("W2-M AUD-20.02: a proof that can't be counted on reads 're-prove', never 'Wallet verified'", () => {
  /* The server's real action set for a linked joiner at a bound FUNDING table: `deposit` alone (never with
     `link-wallet`: `server/src/escrow/moneyTables.ts` actionsOf). */
  const joinerView = (linkedAt = T0) => moneyView({ escrow: bound, you: linked([], { actions: ["deposit"], link: { wallet: TEST_WALLET, epoch: 1, ticket: TICKET, linkedAt, consentKeys: [] } }) });

  it("the server's limit, with a margin: fresh under it, aged near and past it, aged with no proof at all", () => {
    expect(WALLET_PROOF_MAX_AGE_MS).toBe(24 * HOUR);
    expect(proofAgedOut(T0, T0 + 23 * HOUR)).toBe(false);
    expect(proofAgedOut(T0, T0 + 24 * HOUR - 4 * 60_000)).toBe(true);
    expect(proofAgedOut(T0, T0 + 25 * HOUR)).toBe(true);
    expect(proofAgedOut(null, T0)).toBe(true);
  });

  it("a joiner who can deposit: re-prove headline and the free re-proof of the SAME wallet; Change wallet stays the other option", () => {
    const fresh = seatFlow(flowInput({ view: joinerView(), proof: null }));
    expect([fresh.headline, fresh.primary?.kind]).toEqual([`Wallet verified · ${shortWallet(TEST_WALLET)}`, "ante"]);
    const aged = seatFlow(flowInput({ view: joinerView(), proof: "aged" }));
    expect(aged.headline).toBe(`Re-prove ${shortWallet(TEST_WALLET)} to deposit`);
    expect(aged.headline).not.toMatch(/Wallet (linked|verified)/);
    /* P3-ACCT: the one Ante button stays the primary; the free re-proof of the SAME wallet is offered beside it. */
    expect([aged.step, aged.primary?.kind, aged.primary?.label]).toEqual(["link", "ante", "Ante 1 JUNOX"]);
    expect(aged.detail).toMatch(/linked more than a day ago.*proof from the last 24 hours.*if the server asks.*free, nothing moves/);
    expect(aged.others.map((action) => [action.kind, action.label, action.tone])).toEqual([["reprove", "Re-prove wallet (free)", "secondary"]]);
    const refused = seatFlow(flowInput({ view: joinerView(), proof: "refused" }));
    expect(refused.detail).toMatch(/^The server needs a fresh proof.*Ante asks Keplr to sign one first/);
    /* `refused` is the server's own answer: the Ante re-proves FIRST (moneyActions.anteNow); never a bare deposit. */
    expect([refused.primary?.kind, refused.others.map((action) => action.kind)]).toEqual(["ante", ["reprove"]]);
    expect(refused.others.some((action) => action.kind === "open-review" || action.kind === "approve")).toBe(false);
  });

  it("re-proving needs what a link needs -- the Ante connects Keplr itself, and the server asks for 'Confirm it's you' only when it must; Keplr on another account blocks it", () => {
    const disconnected = seatFlow(flowInput({ view: joinerView(), proof: "aged", wallet: { kind: "disconnected" } }));
    expect([disconnected.step, disconnected.primary?.kind, disconnected.blocker]).toEqual(["link", "ante", null]);
    const unconfirmed = seatFlow(flowInput({ view: joinerView(), proof: "aged", confirmed: false }));
    expect([unconfirmed.step, unconfirmed.primary?.kind]).toEqual(["link", "ante"]);
    const wrong = seatFlow(flowInput({ view: joinerView(), proof: "aged", wallet: { kind: "connected", address: OTHER_WALLET } }));
    expect(wrong.blocker).toMatch(/Switch accounts in Keplr/);
    const phone = seatFlow(flowInput({ view: joinerView(), proof: "aged", wallet: { kind: "unavailable" } }));
    expect(phone.blocker).toMatch(/Keplr isn't available/);
  });

  it("never for the host (CreateGame needs no approval), never before the table can take the deposit, never while Keplr is asked", () => {
    const host = seatFlow(flowInput({ isHost: true, view: moneyView({ you: linked([], { actions: ["open-escrow", "link-wallet"] }) }), proof: "aged" }));
    expect([host.primary?.kind, host.headline]).toEqual(["ante", expect.stringMatching(/^Wallet verified/)]);
    expect(host.others.some((action) => action.kind === "reprove")).toBe(false);
    const unbound = seatFlow(flowInput({ view: moneyView({ you: linked([], { actions: ["link-wallet"] }) }), proof: "aged" }));
    expect([unbound.headline, unbound.primary]).toEqual([expect.stringMatching(/^Wallet verified/), null]);
    /* The older review path (still reachable from the full terms): the review goes ahead (the server decides); a
       refusal holds -- the Ante, which re-proves first. */
    expect(seatFlow(flowInput({ view: joinerView(), proof: "aged", ui: "review" })).primary?.kind).toBe("approve");
    expect(seatFlow(flowInput({ view: joinerView(), proof: "refused", ui: "review" })).primary?.kind).toBe("ante");
    const approving = seatFlow(flowInput({ view: joinerView(), proof: "aged", ui: "approving" }));
    expect(approving.headline).toBe("Approve in Keplr…");
    /* No deposit offered by the server (the escrow isn't taking them): no re-prove either -- nothing to re-prove for. */
    const notTaking = seatFlow(flowInput({ view: moneyView({ escrow: { ...bound, state: "FUNDED" }, you: linked([], { actions: ["link-wallet"] }) }), proof: "refused" }));
    expect(notTaking.headline).toMatch(/^Wallet verified/);
  });

  it("the re-proof signs once for the linked wallet, says so, and the page records the accepted proof", async () => {
    const services = testServices();
    installMoneyServicesForTests(services);
    const port = scriptedPort();
    port.answer("money/wallet-challenge", 200, { ok: true, text: challengeText(TEST_WALLET), nonce: "ab".repeat(16), expiresAt: T0 + 300_000 });
    port.answer("money/wallet-link", 200, { ok: true, mode: "unchanged", wallet: TEST_WALLET, epoch: 1, ticket: TICKET });
    const outcome = await linkWallet(ctx({ view: joinerView(), port, services }), { expectWallet: TEST_WALLET, reprove: true });
    expect(outcome).toEqual({ ok: true, notice: "Wallet proof renewed: you can deposit now. Nothing was charged." });
    expect(services.wallet.calls.filter((call) => call.startsWith("signLink"))).toHaveLength(1);
    expect(port.requests.find((request) => request.path === "money/wallet-link")?.body.replace).toBeUndefined();
    expect(moneySession().proofRenewedAt[proofKey("g_table", "p-me", TEST_WALLET)]).toBe(T0);
  });

  it("Keplr on another account: the re-proof asks Keplr nothing and the server nothing (it would be a replacement)", async () => {
    const services = testServices();
    services.wallet.address = OTHER_WALLET;
    const port = scriptedPort();
    const outcome = await linkWallet(ctx({ view: joinerView(), port, services }), { expectWallet: TEST_WALLET, reprove: true });
    expect(outcome).toEqual({ ok: false, reason: expect.stringMatching(/Keplr is on .* now, not .*Nothing was signed or linked/) });
    expect(port.requests).toEqual([]);
    expect(services.wallet.calls.some((call) => call.startsWith("signLink"))).toBe(false);
  });

  it("the server refuses a deposit's approval for want of a proof (`link-first`): the outcome asks for the re-proof", async () => {
    const services = testServices();
    const port = scriptedPort();
    const key = await services.keys.create({ chainId: "uni-7", contract: TEST_CONTRACT, gameId: "g_table", playerId: "p-me", wallet: TEST_WALLET });
    if (!key.ok) throw new Error(key.reason);
    port.answer("money/join-admission", 409, { error: "link-first", reason: "Link your wallet to this seat again (the proof is missing or too old)." });
    const view = moneyView({ escrow: bound, you: linked([key.pubkey], { actions: ["deposit"] }) });
    expect(await approveDeposit(ctx({ view, port, services }))).toEqual({ ok: false, reason: "Link your wallet to this seat again (the proof is missing or too old).", needs: "reprove" });
    expect(services.wallet.calls.some((call) => call.startsWith("signTx"))).toBe(false);
  });
});

/* ================================================================== */
/* AUD-20.03 (E-2): one prompt for a replacement                      */
/* ================================================================== */

describe("W2-M AUD-20.03: Change wallet asks first, then Keplr signs once", () => {
  /* "Change wallet" is offered while the server allows a link (`link-wallet`: before the host opens the table). */
  const view = moneyView({ you: linked([], { actions: ["link-wallet"] }) });

  it("Keplr on the linked wallet: no change, nothing asked of Keplr beyond its account, nothing asked of the server", async () => {
    const services = testServices();
    const port = scriptedPort();
    const asked = await prepareReplace(ctx({ view, port, services }));
    expect(asked).toEqual({ ok: false, outcome: { ok: false, reason: expect.stringMatching(/already linked to this seat.*switch accounts in Keplr first/) } });
    expect(services.wallet.calls).toEqual(["account"]);
    expect(port.requests).toEqual([]);
  });

  it("Keplr on another wallet: the question names both, and nothing is signed or sent to ask it", async () => {
    const services = testServices();
    services.wallet.address = OTHER_WALLET;
    const port = scriptedPort();
    expect(await prepareReplace(ctx({ view, port, services }))).toEqual({ ok: true, from: TEST_WALLET, to: OTHER_WALLET });
    expect(services.wallet.calls).toEqual(["account"]);
    expect(port.requests).toEqual([]);
  });

  it("confirmed: one challenge, one Keplr signature, the link sent with replace -- for exactly the wallet confirmed", async () => {
    const services = testServices();
    services.wallet.address = OTHER_WALLET;
    const port = scriptedPort();
    port.answer("money/wallet-challenge", 200, { ok: true, text: challengeText(OTHER_WALLET), nonce: "ab".repeat(16), expiresAt: T0 + 300_000 });
    port.answer("money/wallet-link", 200, { ok: true, mode: "issued", wallet: OTHER_WALLET, epoch: 2, ticket: "cd".repeat(32) });
    expect(await linkWallet(ctx({ view, port, services }), { replace: true, expectWallet: OTHER_WALLET })).toEqual({ ok: true, notice: `Wallet linked: ${OTHER_WALLET}.` });
    expect(services.wallet.calls.filter((call) => call.startsWith("signLink"))).toEqual([`signLink:${OTHER_WALLET}:18COSMOS/WALLET-LINK/v1`]);
    expect(port.requests.map((request) => request.path)).toEqual(["money/wallet-challenge", "money/wallet-link"]);
    expect(port.requests[1].body.replace).toBe(true);
  });

  it("Keplr switched between the question and the signature: nothing is linked for the unconfirmed wallet", async () => {
    const services = testServices();
    services.wallet.address = "juno1qyqszqgpqyqszqgpqyqszqgpqyqszqgpjnp7du";
    const port = scriptedPort();
    expect(await linkWallet(ctx({ view, port, services }), { replace: true, expectWallet: OTHER_WALLET })).toEqual({ ok: false, reason: expect.stringMatching(/not juno1q+nrql8a/) });
    expect(port.requests).toEqual([]);
  });

  it("the server still asks to replace (the view hadn't shown the link): the outcome says replace -- the fallback the server's spent request forces", async () => {
    const services = testServices();
    const port = scriptedPort();
    port.answer("money/wallet-challenge", 200, { ok: true, text: challengeText(TEST_WALLET), nonce: "ab".repeat(16), expiresAt: T0 + 300_000 });
    port.answer("money/wallet-link", 409, { error: "replace-required", reason: `This seat is linked to ${OTHER_WALLET}. Replace it with this wallet?` });
    expect(await linkWallet(ctx({ view: moneyView(), port, services }))).toEqual({ ok: false, reason: expect.stringMatching(/Replace it/), needs: "replace" });
  });
});

/* ================================================================== */
/* AUD-20.04 (E-3): what expired, said specifically                   */
/* ================================================================== */

describe("W2-M AUD-20.04: an ended Confirm-it's-you and an ended link request say what happened", () => {
  const reauth = { error: "reauth-required", reason: "Confirm it's you first (your recovery key), then link the wallet." };

  it("the sentences: ended early (believed live), expired at a time (believed until then), none when never confirmed", () => {
    expect(reconfirmSentence(T0 + 120_000, T0)).toMatch(/ended early on the server.*Confirm it's you again.*nothing was changed/);
    /* Within a minute of the believed end: an ordinary lapse (clocks differ), not "ended early". */
    expect(reconfirmSentence(T0 + 30_000, T0)).toMatch(/^Your “Confirm it's you” expired at/);
    expect(reconfirmSentence(T0 - 60_000, T0)).toBe(`Your “Confirm it's you” expired at ${formatMoneyTime(T0 - 60_000, { now: T0 })} (it lasts 5 minutes). Confirm it's you again to continue; nothing was changed.`);
    expect(reconfirmSentence(null, T0)).toBeNull();
    expect(linkRequestEndedSentence(T0 - 1, T0)).toMatch(/^The link request expired at .*Keplr was open longer\). Nothing was linked/);
    expect(linkRequestEndedSentence(T0 + 120_000, T0)).toMatch(/^The server no longer holds that link request.*Nothing was linked/);
    expect(linkRequestEndedSentence(T0 + 30_000, T0)).toMatch(/^The link request expired at/);
  });

  it.each([
    ["believed live (the server ended it early)", T0 + 120_000, /ended early on the server/],
    ["believed until a past time (it lapsed)", T0 - 120_000, /expired at /],
    ["never confirmed on this page", null, /^Confirm it's you first \(your recovery key\)/],
  ] as const)("reauth-required, %s", async (_case, believed, said) => {
    const services = testServices();
    installMoneyServicesForTests(services);
    updateMoneySession({ confirmedUntil: believed });
    const port = scriptedPort();
    port.answer("money/wallet-challenge", 403, reauth);
    expect(await linkWallet(ctx({ view: moneyView(), port, services }))).toEqual({ ok: false, reason: expect.stringMatching(said), needs: "confirm" });
    expect(moneySession().confirmedUntil).toBeNull();
  });

  it.each([
    ["past the request's own expiry", T0 + 400_000, /^The link request expired at/],
    ["before it (the server dropped it)", T0 + 1_000, /^The server no longer holds that link request/],
  ] as const)("challenge-expired %s", async (_case, answeredAt, said) => {
    let clock = T0;
    const services = testServices({ now: () => clock });
    const port = scriptedPort();
    port.answer("money/wallet-challenge", 200, { ok: true, text: challengeText(TEST_WALLET), nonce: "ab".repeat(16), expiresAt: T0 + 300_000 });
    port.answer("money/wallet-link", 409, () => {
      clock = answeredAt;
      return { error: "challenge-expired", reason: "That link request has expired or belongs to another session. Start the link again." };
    });
    const outcome = await linkWallet(ctx({ view: moneyView(), port, services }));
    expect(outcome).toEqual({ ok: false, reason: expect.stringMatching(said) });
  });
});

/* ================================================================== */
/* AUD-20.05 (B-3): a decline is a decline                            */
/* ================================================================== */

describe("W2-M AUD-20.05: a Keplr decline reads as rejected, wherever Keplr asked", () => {
  it("classifyChainError: Keplr's decline is rejected; the chain's own refusals keep their codes", () => {
    for (const text of ["Request rejected", "Transaction declined by the user", "User denied the request"]) {
      expect(classifyChainError(new Error(text))).toEqual({ ok: false, code: "rejected", reason: DECLINED_IN_KEPLR });
    }
    expect(classifyChainError(new Error("execute wasm contract failed: the game was cancelled")).code).toBe("contract-refused");
    expect(classifyChainError(new Error("insufficient funds: 10ujunox is smaller than 25000ujunox")).code).toBe("insufficient-funds");
    expect(classifyChainError(new Error("Failed to fetch")).code).toBe("rpc-unreachable");
    expect(classifyChainError(new Error("something else entirely")).code).toBe("unknown");
    /* A node's refusal of a broadcast is never a player's decline, whatever its words. */
    expect(classifyChainError(new Error("tx rejected by the mempool"), { keplrAsked: false }).code).toBe("unknown");
  });

  it("Keplr declined while handing over a signer (an unlock prompt): rejected, not unsupported", async () => {
    const keplr = {
      enable: async () => undefined,
      getKey: async () => ({ name: "test", bech32Address: TEST_WALLET }),
      getOfflineSignerAuto: async () => {
        throw new Error("Request rejected");
      },
    };
    const wallet = createKeplrWallet({ keplr });
    const message = withdrawMessage(TEST_PIN, "7");
    if (!message.ok) throw new Error(message.reason);
    expect(await wallet.signTx(TEST_PIN, TEST_WALLET, message.value, "memo")).toEqual({ ok: false, code: "rejected", reason: DECLINED_IN_KEPLR });
  });
});

/* ================================================================== */
/* AUD-20.06 (JX-6C): the chain re-read before a Challenge            */
/* ================================================================== */

const DIGEST = "dd".repeat(32);
const recorded = (over: Partial<MoneySettlementView> = {}): MoneySettlementView => ({
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
const settleableFacts = (over: Partial<ChainGameFacts> = {}): ChainGameFacts => ({
  state: "SETTLEABLE",
  creator: "juno1seat0",
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
  challengeWindowEndMs: T0 + 600_000,
  resolverTimeoutAtMs: null,
  resolverTimeoutSecs: 7_200,
  dispute: null,
  ...over,
});
const disputeView = (settlement: MoneySettlementView = recorded()) =>
  moneyView({ escrow: { chainGameId: "7", state: "SETTLEABLE" }, settlement, you: linked([], { funding: "funded", chainSeatIndex: 0, payoutWallet: TEST_WALLET, actions: ["challenge"] }) });

describe("W2-M AUD-20.06: a Dispute is built only against the payout and bond this page showed, as Juno holds them now", () => {
  it("Juno's game answer: the bond, the window, the resolver's window and deadline, and the dispute record are read", () => {
    const nanos = (ms: number) => (BigInt(ms) * BigInt(1_000_000)).toString();
    const facts = chainGameFactsOf({
      game: {
        state: "disputed", creator: "juno1c", max_players: 2, mode: "live", rules_engine_version: 13, variants_digest: "ab".repeat(32), denom: "ujunox", ante_gross: "1000000", seats: [],
        bond: "500000",
        terms: { resolver_timeout_secs: 7200 },
        dispute: { challenger: TEST_WALLET, bond: "500000", evidence_hash: "EE".repeat(32), disputed_at: nanos(T0), resolution: null, resolved_at: null },
      },
      deadlines: { funding_deadline: nanos(T0 - HOUR), challenge_window_end: null, resolver_timeout_at: nanos(T0 + 2 * HOUR) },
      paused: false,
      trusted_seq: "23",
    });
    expect(facts).toMatchObject({ bond: "500000", challengeWindowEndMs: null, resolverTimeoutAtMs: T0 + 2 * HOUR, resolverTimeoutSecs: 7200, dispute: { challenger: TEST_WALLET, bond: "500000", evidenceHash: "ee".repeat(32), disputedAtMs: T0, resolution: null, resolvedAtMs: null } });
    const resolved = chainGameFactsOf({
      game: { state: "settled", creator: "c", max_players: 2, mode: "live", rules_engine_version: 13, variants_digest: "ab", denom: "u", ante_gross: "1", seats: [], dispute: { challenger: TEST_WALLET, bond: "5", evidence_hash: "ee".repeat(32), disputed_at: nanos(T0), resolution: "upheld", resolved_at: nanos(T0 + HOUR) }, terms: { resolver_timeout_secs: "7200" } },
      deadlines: {},
    });
    expect(resolved?.dispute).toMatchObject({ resolution: "upheld", resolvedAtMs: T0 + HOUR });
    expect(resolved?.resolverTimeoutSecs).toBe(7200);
    /* Not a record, not a number: nothing invented. */
    const scrubbed = chainGameFactsOf({ game: { state: "settleable", creator: "c", max_players: 2, mode: "live", rules_engine_version: 13, variants_digest: "ab", denom: "u", ante_gross: "1", seats: [], bond: 5, dispute: { bond: "1" }, terms: { resolver_timeout_secs: -1 } }, deadlines: { challenge_window_end: "soon" } });
    expect(scrubbed).toMatchObject({ bond: null, challengeWindowEndMs: null, resolverTimeoutSecs: null, dispute: null });
  });

  it("challengeProblem: open, the same payout, the same bond, the window open -- else a sentence", () => {
    const view = disputeView();
    expect(challengeProblem(view, settleableFacts(), T0)).toBeNull();
    expect(challengeProblem(view, settleableFacts({ state: "DISPUTED" }), T0)).toMatch(/can't be disputed now \(the escrow is disputed\)/);
    expect(challengeProblem(view, settleableFacts({ settlement: { seq: "27", payloadDigest: DIGEST } }), T0)).toMatch(/isn't the one this page showed you/);
    expect(challengeProblem(view, settleableFacts({ settlement: { seq: "25", payloadDigest: "ee".repeat(32) } }), T0)).toMatch(/isn't the one this page showed you/);
    expect(challengeProblem(view, settleableFacts({ settlement: null }), T0)).toMatch(/isn't the one this page showed you/);
    expect(challengeProblem(view, settleableFacts({ bond: "900000" }), T0)).toMatch(/different dispute bond/);
    expect(challengeProblem(view, settleableFacts({ bond: null }), T0)).toMatch(/different dispute bond/);
    expect(challengeProblem(view, settleableFacts({ challengeWindowEndMs: T0 }), T0)).toMatch(/window on Juno has closed/);
    expect(challengeProblem(view, settleableFacts({ challengeWindowEndMs: null }), T0)).toMatch(/window on Juno has closed/);
    /* The window shown is Juno's to the second (the server reads seconds; Juno's nanoseconds may carry a fraction). */
    expect(challengeProblem(view, settleableFacts({ challengeWindowEndMs: T0 + 600_000 + 400 }), T0)).toBeNull();
    expect(challengeProblem(view, settleableFacts({ challengeWindowEndMs: T0 + 900_000 }), T0)).toMatch(/ends at a different time than this page showed you/);
    expect(challengeProblem(disputeView(recorded({ seq: null })), settleableFacts(), T0)).toMatch(/nothing to dispute yet/);
  });

  it.each([
    ["Juno can't be read", null, /couldn't be reached/],
    ["the payout moved on", settleableFacts({ settlement: { seq: "27", payloadDigest: DIGEST } }), /isn't the one this page showed you/],
    ["the bond differs", settleableFacts({ bond: "1" }), /different dispute bond/],
    ["already disputed", settleableFacts({ state: "DISPUTED" }), /can't be disputed now/],
    ["the window closed", settleableFacts({ challengeWindowEndMs: T0 - 1 }), /has closed/],
  ] as const)("%s: refused before Keplr, nothing signed", async (_case, facts, said) => {
    const services = testServices();
    services.wallet.game = facts;
    expect(await settlementTx(ctx({ view: disputeView(), services }), "challenge")).toEqual({ ok: false, reason: expect.stringMatching(said) });
    expect(services.wallet.calls).toContain("chainGame:7");
    expect(services.wallet.signed).toEqual([]);
  });

  it("everything matches: the chain is read BEFORE Keplr signs, and the bond attached is Juno's", async () => {
    const services = testServices();
    services.wallet.game = settleableFacts();
    expect((await settlementTx(ctx({ view: disputeView(), services }), "challenge")).ok).toBe(true);
    const read = services.wallet.calls.indexOf("chainGame:7");
    const sign = services.wallet.calls.findIndex((call) => call.startsWith("signTx"));
    expect(read).toBeGreaterThanOrEqual(0);
    expect(read).toBeLessThan(sign);
    expect(services.wallet.signed).toHaveLength(1);
    expect(services.wallet.signed[0].kind).toBe("challenge");
    expect(services.wallet.signed[0].funds).toEqual([{ denom: "ujunox", amount: "500000" }]);
  });

  it("release and the inactivity exit are not held to the dispute's check (no chain read is added to them)", async () => {
    const services = testServices();
    services.wallet.game = null;
    await settlementTx(ctx({ view: disputeView(), services }), "liveness-settle");
    expect(services.wallet.calls).not.toContain("chainGame:7");
  });
});

/* ================================================================== */
/* AUD-20.07 (JX-6E): the deadline time and the dispute record        */
/* ================================================================== */

describe("W2-M AUD-20.07: the dispute confirm gives a time; the record is Juno's", () => {
  const view = disputeView();
  const read = (over: Partial<Extract<DisputeRead, { kind: "read" }>> = {}): DisputeRead => ({ kind: "read", resolverTimeoutSecs: 7_200, bond: "500000", dispute: null, seats: [TEST_WALLET, OTHER_WALLET], ...over });

  it("durationText: whole units, two at most, integers only", () => {
    expect(durationText(7_200)).toBe("2 hours");
    expect(durationText(2_592_000)).toBe("30 days");
    expect(durationText(90_000)).toBe("1 day 1 hour");
    expect(durationText(600)).toBe("10 minutes");
    expect(durationText(61)).toBe("1 minute 1 second");
    expect(durationText(0)).toBe("0 seconds");
    expect(durationText(-1)).toBe("");
  });

  it("the confirm: the bond, and the resolver's deadline as a local time with its zone -- or says it is being read, or couldn't be", () => {
    const sentence = disputeConfirmSentence(view, read(), T0);
    expect(sentence).toBe(`Dispute the payout recorded on Juno? Keplr attaches the 0.5 JUNOX bond. If Juno records it now, the resolver has 2 hours to decide: until about ${formatMoneyTime(T0 + 2 * HOUR, { now: T0 })}. If the dispute fails, the bond joins the pool.`);
    expect(sentence).not.toMatch(/its deadline/);
    expect(disputeConfirmSentence(view, { kind: "loading" }, T0)).toMatch(/being read from Juno/);
    expect(disputeConfirmSentence(view, null, T0)).toMatch(/being read from Juno/);
    expect(disputeConfirmSentence(view, { kind: "unavailable", reason: "x" }, T0)).toMatch(/couldn't be read from Juno just now; Juno sets it when the dispute lands/);
    expect(disputeConfirmSentence(view, read({ resolverTimeoutSecs: null }), T0)).toMatch(/couldn't be read from Juno/);
    /* The bond shown is the one Continue holds Juno to; a different one on Juno is said, not silently swapped in. */
    expect(disputeConfirmSentence(view, read({ bond: "900000" }), T0)).toMatch(/^Dispute the payout recorded on Juno\? Keplr attaches the 0\.5 JUNOX bond\. Juno now asks for 0\.9 JUNOX, so the dispute won't be sent until this page shows that\./);
  });

  it("the record: you or which seat, when, the bond, the evidence; how it ended; nothing when there is none", () => {
    const record = { challenger: TEST_WALLET, bond: "500000", evidenceHash: "ee".repeat(32), disputedAtMs: T0, resolution: null, resolvedAtMs: null } as const;
    expect(disputeRecordLines(view, read({ dispute: record }), T0)).toEqual([`Disputed by you at ${formatMoneyTime(T0, { now: T0 })}, with a 0.5 JUNOX bond.`, `Evidence recorded on Juno: ${"ee".repeat(8)}…`]);
    const theirs = disputeRecordLines(view, read({ dispute: { ...record, challenger: OTHER_WALLET } }), T0);
    expect(theirs[0]).toBe(`Disputed by the player whose wallet is ${shortWallet(OTHER_WALLET)} at ${formatMoneyTime(T0, { now: T0 })}, with a 0.5 JUNOX bond.`);
    const upheld = disputeRecordLines(view, read({ dispute: { ...record, resolution: "upheld", resolvedAtMs: T0 + HOUR } }), T0);
    expect(upheld[2]).toBe(`The resolver upheld the recorded payout at ${formatMoneyTime(T0 + HOUR, { now: T0 })}.`);
    expect(disputeRecordLines(view, read({ dispute: { ...record, resolution: "resolver_timeout" } }), T0)[2]).toMatch(/didn't decide in time/);
    expect(disputeRecordLines(view, read({ dispute: { ...record, resolution: "annulled" } }), T0)[2]).toMatch(/annulled the game/);
    expect(disputeRecordLines(view, read({ dispute: { ...record, resolution: "replaced" } }), T0)[2]).toMatch(/replaced the recorded payout/);
    expect(disputeRecordLines(view, read(), T0)).toEqual([]);
    expect(disputeRecordLines(view, { kind: "loading" }, T0)).toEqual([]);
    expect(disputeRecordLines(view, { kind: "unavailable", reason: "x" }, T0)).toEqual(["The dispute's record couldn't be read from Juno just now."]);
    /* A scrubbed record (no time, no bond, no evidence) says only what it has. */
    expect(disputeRecordLines(view, read({ dispute: { challenger: OTHER_WALLET, bond: null, evidenceHash: null, disputedAtMs: null, resolution: null, resolvedAtMs: null } }), T0)).toEqual([`Disputed by the player whose wallet is ${shortWallet(OTHER_WALLET)}.`]);
  });

  it("disputeChainFacts: read through the pinned endpoint; no pin, no table, no answer -- a sentence, never a guess", async () => {
    const services = testServices();
    services.wallet.game = settleableFacts({ dispute: { challenger: OTHER_WALLET, bond: "500000", evidenceHash: null, disputedAtMs: T0, resolution: null, resolvedAtMs: null } });
    expect(await disputeChainFacts(view, services)).toEqual({ kind: "read", resolverTimeoutSecs: 7_200, bond: "500000", dispute: expect.objectContaining({ challenger: OTHER_WALLET }), seats: [TEST_WALLET, OTHER_WALLET] });
    services.wallet.game = null;
    expect(await disputeChainFacts(view, services)).toEqual({ kind: "unavailable", reason: expect.stringMatching(/couldn't be reached/) });
    expect(await disputeChainFacts(moneyView(), services)).toEqual({ kind: "unavailable", reason: "This table isn't open on Juno." });
    expect(await disputeChainFacts(view, testServices({ pinned: false }))).toEqual({ kind: "unavailable", reason: expect.stringMatching(/no Juno escrow configured/) });
  });
});
