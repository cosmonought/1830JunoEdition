/** @jest-environment node */
// PHASE 3 FINAL CLOCKS on a money table, in the browser: a deposit funds the escrow under EXACTLY the table's recorded
// deadline (Live: the 20-minute action clock; Async: the host's pace, or No-deadline -- the latter only after this
// seat acknowledged the owner's disclosure), a Join is never sent into an escrow funded under another deadline, the
// exceptional review request is its own wallet message (no funds) and its own copy, and a seat's REMEDY-APPROVE is
// built here from facts this browser read itself, bound to exactly one overdue instance.

import { RULES_ENGINE_VERSION } from "../gameEngine/rulesVersion";
import { WALLET_EXECUTE, WALLET_MESSAGE_FUNDS } from "../gameEngine/escrow/junoWalletMessages";
import { remedyApproveDigestV1 } from "../gameEngine/escrow/junoRemedyV1";
import { variantsDigestV1 } from "../gameEngine/escrow/variantsDigest";
import { resolveVariants } from "../gameEngine/gameVariants";
import { NO_DEADLINE_DISCLOSURE } from "../utils/clockProtocol";
import { chainGameProblemForJoin, createGameMessage, deadlineChoiceFor, requestReviewMessage, type ChainGameFacts, type TableDeadline } from "./walletChecks";
import { reviewSentence, settlementFlow, REVIEW_LABEL } from "./moneyFlow";
import { linked, moneyView, T0, TEST_PIN, TICKET, TEST_WALLET } from "./moneyTestSupport";

const VARIANTS = resolveVariants({ mode: "async" } as never);
const CONSENT = `02${"11".repeat(32)}`;
const paced = (paceSecs: number): TableDeadline => ({ deadline: "async-pace", paceSecs, acknowledged: false });
const none = (acknowledged: boolean): TableDeadline => ({ deadline: "no-deadline", paceSecs: null, acknowledged });

describe("Phase 3 final clocks: a deposit funds the escrow under the table's deadline, never a guessed one", () => {
  it("Live tables: the 20-minute action clock; Async: the recorded pace, or No-deadline once acknowledged", () => {
    expect(deadlineChoiceFor("live", null)).toEqual({ ok: true, value: { kind: "live_action_clock" } });
    expect(deadlineChoiceFor("live", { deadline: "live", paceSecs: null, acknowledged: false })).toEqual({ ok: true, value: { kind: "live_action_clock" } });
    expect(deadlineChoiceFor("async", null).ok).toBe(false);
    expect(deadlineChoiceFor("async", paced(172_800))).toEqual({ ok: true, value: { kind: "async_pace", allowanceSecs: 172_800 } });
    expect(deadlineChoiceFor("async", paced(3_600)).ok).toBe(false);
    const unacked = deadlineChoiceFor("async", none(false));
    expect(unacked.ok).toBe(false);
    expect((unacked as { reason: string }).reason.startsWith(NO_DEADLINE_DISCLOSURE)).toBe(true);
    expect(deadlineChoiceFor("async", none(true))).toEqual({ ok: true, value: { kind: "no_deadline" } });
  });

  it("CreateGame for an Async table names its mode and its deadline exactly", () => {
    const view = moneyView({ you: linked([CONSENT]), terms: { mode: "async" } });
    const built = createGameMessage(TEST_PIN, view, VARIANTS, CONSENT, paced(86_400));
    if (!built.ok) throw new Error(built.reason);
    expect(built.value.msgJson).toBe(
      WALLET_EXECUTE.createGame({ maxPlayers: 2, mode: 1, rulesEngineVersion: RULES_ENGINE_VERSION, variantsDigest: variantsDigestV1(VARIANTS), consentPubkey: CONSENT, joinTicket: TICKET, deadline: { kind: "async_pace", allowanceSecs: 86_400 } }),
    );
    const noDeadline = createGameMessage(TEST_PIN, view, VARIANTS, CONSENT, none(true));
    if (!noDeadline.ok) throw new Error(noDeadline.reason);
    expect(noDeadline.value.msgJson.endsWith(`"deadline":{"no_deadline":{}}}}`)).toBe(true);
    expect(createGameMessage(TEST_PIN, view, VARIANTS, CONSENT, none(false)).ok).toBe(false);
  });

  it("a Join is sent only into an escrow funded under exactly the table's deadline", () => {
    const view = moneyView({ you: linked([CONSENT]), terms: { mode: "async" }, escrow: { chainGameId: "7", state: "FUNDING" } });
    const facts: ChainGameFacts = {
      state: "FUNDING",
      creator: "juno1host",
      maxPlayers: 2,
      mode: "async",
      rulesEngineVersion: RULES_ENGINE_VERSION,
      variantsDigest: variantsDigestV1(VARIANTS),
      denom: "ujunox",
      anteGross: "1000000",
      seats: [{ wallet: "juno1host", joinTicket: "ef".repeat(32), consentPubkey: CONSENT }],
      fundingDeadlineMs: T0 + 3_600_000,
      paused: false,
      domain: null,
      trustedSeq: null,
      settlement: null,
      bond: null,
      policy: "timed_remedy_v1",
      allowanceSecs: 86_400,
      challengeWindowEndMs: null,
      resolverTimeoutAtMs: null,
      resolverTimeoutSecs: null,
      dispute: null,
    };
    const problem = (over: Partial<ChainGameFacts>, deadline: TableDeadline | null) => chainGameProblemForJoin(TEST_PIN, view, VARIANTS, { ...facts, ...over }, TEST_WALLET, T0, deadline);
    expect(problem({}, paced(86_400))).toBeNull();
    expect(problem({}, paced(43_200))).toMatch(/this table's deadline terms/);
    expect(problem({}, null)).toMatch(/async table's deadline/);
    expect(problem({ policy: "no_deadline", allowanceSecs: 0 }, none(true))).toBeNull();
    expect(problem({ policy: "no_deadline", allowanceSecs: 0 }, none(false))).toMatch(/locked indefinitely/);
    expect(problem({}, none(true))).toMatch(/this table's deadline terms/);
  });
});

describe("Phase 3 final clocks: the exceptional review is its own message and its own words", () => {
  it("RequestReview: no funds, the contract's own JSON, offered only by the server's legal list", () => {
    expect(WALLET_MESSAGE_FUNDS.requestReview).toBe("none");
    const built = requestReviewMessage(TEST_PIN, "7");
    if (!built.ok) throw new Error(built.reason);
    expect(built.value.msgJson).toBe('{"request_review":{"chain_game_id":7}}');
    expect(built.value.funds).toEqual([]);
    expect(built.value.hint).toBe("request-review");
    const view = moneyView({ you: linked([CONSENT], { chainSeatIndex: 0, payoutWallet: TEST_WALLET, actions: ["request-review", "annul"] }), escrow: { chainGameId: "7", state: "IN_PROGRESS" }, exit: { policy: "no_deadline", review: null } });
    const flow = settlementFlow({ view, holdsChainKey: true, verification: "unavailable", now: T0 });
    const review = flow.actions.find((action) => action.kind === "request-review");
    expect(review?.label).toBe(REVIEW_LABEL);
    expect(flow.actions.find((action) => action.kind === "annul")?.label).not.toBe(REVIEW_LABEL);
  });

  it("the copy never implies the resolver can foreclose, pick a winner or move money; No-deadline keeps the high bar", () => {
    for (const policy of ["no_deadline", "timed_remedy_v1"]) {
      const text = reviewSentence(policy);
      expect(text).toMatch(/7 days/);
      expect(text).toMatch(/annul it neutrally/);
      expect(text).toMatch(/can never foreclose, pick a winner or move money between players/);
    }
    expect(reviewSentence("no_deadline")).toMatch(/simply going quiet is not enough/);
    expect(reviewSentence("timed_remedy_v1")).toMatch(/catastrophic failure/);
  });
});

describe("Phase 3 final clocks: a REMEDY-APPROVE binds one overdue instance", () => {
  it("the digest changes with the instance, the horizon and the approving seat (the browser builds it from what it read)", () => {
    const base = { domain: "aa".repeat(32), chain_game_id: BigInt(7), remedy: 2 as const, defaulting_seat: 0, strike: 1, overdue_epoch: BigInt(1), log_len: BigInt(12), log_hash: "bb".repeat(32), overdue_at: BigInt(1_800_000_001) };
    const digest = remedyApproveDigestV1(base, BigInt(1_800_021_000), 1);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(remedyApproveDigestV1({ ...base, overdue_epoch: BigInt(2) }, BigInt(1_800_021_000), 1)).not.toBe(digest);
    expect(remedyApproveDigestV1({ ...base, log_len: BigInt(13) }, BigInt(1_800_021_000), 1)).not.toBe(digest);
    expect(remedyApproveDigestV1(base, BigInt(1_800_021_001), 1)).not.toBe(digest);
    expect(remedyApproveDigestV1(base, BigInt(1_800_021_000), 2)).not.toBe(digest);
  });
});

/* ---- the seat's REMEDY-APPROVE, end to end on this device (keys, Juno read, roster) ---- */

import { Secp256k1, Secp256k1Signature } from "@cosmjs/crypto";
import { fromHex, toHex } from "@cosmjs/encoding";
import { createConsentKeys, memoryConsentKeyVault } from "./consentKeys";
import { ASYNC_APPROVAL_REACH_SECS, LIVE_APPROVAL_REACH_SECS, signRemedyApproval, type TableContext } from "./moneyActions";
import { installMoneyServicesForTests } from "./moneySession";
import { scriptedPort, testKey, testServices, TEST_CONTRACT } from "./moneyTestSupport";

describe("Phase 3 final clocks: this seat's REMEDY-APPROVE, signed on this device", () => {
  afterEach(() => installMoneyServicesForTests(null));

  it("binds the defaulting seat from the roster, this seat from Juno, the overdue instance from the clock; refuses its own seat", async () => {
    const key = await testKey("remedy-approve");
    const vault = memoryConsentKeyVault();
    vault.records.set(key.pubkey, { v: 1, chainId: "uni-7", contract: TEST_CONTRACT, gameId: "g_table", playerId: "p-me", wallet: TEST_WALLET, pubkey: key.pubkey, privkey: toHex(key.privkey), createdAt: T0 });
    const services = testServices({ keys: createConsentKeys(vault, () => T0), now: () => T0 });
    const port = scriptedPort();
    const domain = "cd".repeat(32);
    services.wallet.game = {
      state: "IN_PROGRESS",
      creator: "juno1host",
      maxPlayers: 2,
      mode: "live",
      rulesEngineVersion: RULES_ENGINE_VERSION,
      variantsDigest: "00".repeat(32),
      denom: "ujunox",
      anteGross: "1000000",
      seats: [
        { wallet: "juno1host", joinTicket: "ef".repeat(32), consentPubkey: `02${"11".repeat(32)}` },
        { wallet: TEST_WALLET, joinTicket: TICKET, consentPubkey: key.pubkey },
      ],
      fundingDeadlineMs: null,
      paused: false,
      domain,
      trustedSeq: "4",
      settlement: null,
      bond: "0",
      policy: "timed_remedy_v1",
      allowanceSecs: 1200,
      challengeWindowEndMs: null,
      resolverTimeoutAtMs: null,
      resolverTimeoutSecs: null,
      dispute: null,
    };
    port.answer("money/escrow-details", 200, { ok: true, checkpoint: null, settlement: null, chain: null, roster: [{ playerId: "p-host", chainSeatIndex: 0 }, { playerId: "p-me", chainSeatIndex: 1 }] });
    const view = moneyView({ you: linked([key.pubkey], { funding: "funded", chainSeatIndex: 1, payoutWallet: TEST_WALLET, chainConsentKey: key.pubkey }), escrow: { chainGameId: "7", state: "IN_PROGRESS" } });
    const ctx: TableContext = { gameId: "g_table", view, variants: resolveVariants({} as never), isHost: false, port, services };
    const overdue = { seat: "p-host", strike: 1, epoch: 3, overdueAt: 1_790_000_000_250, logLen: 42, logHash: "ef".repeat(32) };
    const signed = await signRemedyApproval(ctx, { remedy: 2, overdue, live: true });
    if (!signed.ok) throw new Error(JSON.stringify(signed.outcome));
    const overdueAtSecs = 1_790_000_001; // rounded UP
    expect(signed.approveUntil).toBe(overdueAtSecs + LIVE_APPROVAL_REACH_SECS);
    const digest = remedyApproveDigestV1({ domain, chain_game_id: BigInt(7), remedy: 2, defaulting_seat: 0, strike: 1, overdue_epoch: BigInt(3), log_len: BigInt(42), log_hash: "ef".repeat(32), overdue_at: BigInt(overdueAtSecs) }, BigInt(signed.approveUntil), 1);
    expect(await Secp256k1.verifySignature(Secp256k1Signature.fromFixedLength(fromHex(signed.signature)), fromHex(digest), fromHex(key.pubkey))).toBe(true);
    port.answer("money/escrow-details", 200, { ok: true, checkpoint: null, settlement: null, chain: null, roster: [{ playerId: "p-host", chainSeatIndex: 0 }, { playerId: "p-me", chainSeatIndex: 1 }] });
    const own = await signRemedyApproval(ctx, { remedy: 2, overdue: { ...overdue, seat: "p-me" }, live: true });
    expect(own.ok).toBe(false);
    expect((own as { outcome: { reason: string } }).outcome.reason).toMatch(/your own seat/);
    /* A roster that places this seat somewhere Juno does not: nothing is signed on it. */
    port.answer("money/escrow-details", 200, { ok: true, checkpoint: null, settlement: null, chain: null, roster: [{ playerId: "p-me", chainSeatIndex: 0 }, { playerId: "p-host", chainSeatIndex: 1 }] });
    const swapped = await signRemedyApproval(ctx, { remedy: 2, overdue, live: true });
    expect(swapped.ok).toBe(false);
    expect((swapped as { outcome: { reason: string } }).outcome.reason).toMatch(/roster doesn't match Juno/);
    /* Async: the approval reaches 29 days from now (slow N-1 voters; inside the server's 30-day ceiling). */
    port.answer("money/escrow-details", 200, { ok: true, checkpoint: null, settlement: null, chain: null, roster: [{ playerId: "p-host", chainSeatIndex: 0 }, { playerId: "p-me", chainSeatIndex: 1 }] });
    const n1 = await signRemedyApproval(ctx, { remedy: 4, overdue: { ...overdue, strike: 0 }, live: false });
    if (!n1.ok) throw new Error(JSON.stringify(n1.outcome));
    expect(n1.approveUntil).toBe(Math.floor(T0 / 1000) + ASYNC_APPROVAL_REACH_SECS);
    expect(ASYNC_APPROVAL_REACH_SECS).toBe(29 * 86_400);
    services.wallet.game = { ...services.wallet.game, seats: [services.wallet.game.seats[0]] };
    const noKey = await signRemedyApproval(ctx, { remedy: 2, overdue, live: true });
    expect(noKey.ok).toBe(false);
    expect((noKey as { outcome: { reason: string } }).outcome.reason).toMatch(/signing key/);
  });
});
