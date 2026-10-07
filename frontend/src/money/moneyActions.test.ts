/** @jest-environment node */
// ESCROW-4: what each money button does, against a fake Keplr, in-memory keys and pending records, and a scripted
// server. The order is the contract: the browser's own checks first; Keplr signs only what this browser built; the
// signed bytes are KEPT before they are broadcast (and nothing is broadcast if they can't be); the server is only
// hinted; a consent is signed by the seat's own key over this browser's own digest, and relayed without re-auth.

// Route v12 R12-2 moved the rules engine to 12 (R12-3 certified it for settlement): this page's rules are the engine's.
import { RULES_ENGINE_VERSION } from "../gameEngine/rulesVersion";
import { walletLinkChallengeText } from "../gameEngine/escrow/walletLinkChallengeV1";
import { joinAdmissionDigestV1 } from "../gameEngine/escrow/junoJoinAdmissionV1";
import { variantsDigestV1 } from "../gameEngine/escrow/variantsDigest";
import { resolveVariants } from "../gameEngine/gameVariants";
import { annulDigestV1, consentDigestV1 } from "../gameEngine/settlementPayload";
import { Secp256k1, Secp256k1Signature } from "@cosmjs/crypto";
import { fromHex, toHex } from "@cosmjs/encoding";
import { createConsentKeys, memoryConsentKeyVault } from "./consentKeys";
import { agreeToAnnul, approveDeposit, approvePayout, confirmItsYou, escrowExit, LANDED_WAIT_MS, linkWallet, moveSigningKeyHere, reconcilePending, resendPending, settleLandedDeposits, type TableContext } from "./moneyActions";
import { moneySession, installMoneyServicesForTests, updateMoneySession } from "./moneySession";
import { LEADING_ZERO_KEY, LEADING_ZERO_VECTORS, linked, moneyView, scriptedPort, testKey, testServices, memoryStorage, TEST_CONTRACT, TEST_WALLET, TICKET, T0 } from "./moneyTestSupport";
import type { ChainGameFacts } from "./walletChecks";

const VARIANTS = resolveVariants({} as never);
const SITE = "https://play.example";

afterEach(() => installMoneyServicesForTests(null));

function ctx(over: Partial<TableContext> & Pick<TableContext, "view">): TableContext {
  return { gameId: "g_table", variants: VARIANTS, isHost: false, site: SITE, ...over };
}

const chainFacts = (over: Partial<ChainGameFacts> = {}): ChainGameFacts => ({
  state: "FUNDING",
  creator: "juno1host",
  maxPlayers: 2,
  mode: "live",
  rulesEngineVersion: RULES_ENGINE_VERSION,
  variantsDigest: variantsDigestV1(VARIANTS),
  denom: "ujunox",
  anteGross: "1000000",
  seats: [{ wallet: "juno1host", joinTicket: "ef".repeat(32), consentPubkey: `02${"11".repeat(32)}` }],
  fundingDeadlineMs: T0 + 3_600_000,
  paused: false,
  domain: null,
  trustedSeq: null,
  settlement: null,
  /* W2-M: the dispute facts (JX-6C/6E); a funding game has none. */
  bond: null,
  policy: "timed_remedy_v1",
  allowanceSecs: 1200,
  challengeWindowEndMs: null,
  resolverTimeoutAtMs: null,
  resolverTimeoutSecs: null,
  dispute: null,
  ...over,
});

async function admission(over: { wallet?: string; chainGameId?: string } = {}) {
  const key = await testKey("admission");
  const expires = String(Math.floor(T0 / 1000) + 600);
  const wallet = over.wallet ?? TEST_WALLET;
  const chainGameId = over.chainGameId ?? "7";
  const digest = joinAdmissionDigestV1({ chain_id: "uni-7", contract_addr: TEST_CONTRACT, chain_game_id: BigInt(chainGameId), wallet, join_ticket: TICKET, expires_at: BigInt(expires) });
  return { chain_id: "uni-7", contract: TEST_CONTRACT, chain_game_id: chainGameId, wallet, join_ticket: TICKET, expires_at: expires, signature: await key.sign(digest), admission_pubkey: key.pubkey };
}

describe("ESCROW-4: link -- the challenge is read, then Keplr signs, then the link carries a key this browser keeps", () => {
  it("a challenge for another site is never signed; this request's is, and the link names a stored key", async () => {
    const services = testServices();
    const port = scriptedPort();
    const view = moneyView();
    const text = (site: string) => walletLinkChallengeText({ appName: "Project 18XX", site, chainId: "uni-7", contract: TEST_CONTRACT, gameId: "g_table", playerId: "p-me", wallet: TEST_WALLET, nonce: "ab".repeat(16), expiresAt: T0 + 300_000 });
    port.answer("money/wallet-challenge", 200, { ok: true, text: text("https://evil.example"), nonce: "ab".repeat(16), expiresAt: T0 + 300_000 });
    const refused = await linkWallet(ctx({ view, port, services }));
    expect(refused).toEqual({ ok: false, reason: expect.stringMatching(/another site/) });
    expect(services.wallet.calls.some((call) => call.startsWith("signLink"))).toBe(false);

    port.answer("money/wallet-challenge", 200, { ok: true, text: text(SITE), nonce: "ab".repeat(16), expiresAt: T0 + 300_000 });
    port.answer("money/wallet-link", 200, { ok: true, mode: "issued", wallet: TEST_WALLET, epoch: 1, ticket: TICKET });
    const done = await linkWallet(ctx({ view, port, services }));
    expect(done).toEqual({ ok: true, notice: `Wallet linked: ${TEST_WALLET}.` });
    const link = port.requests.find((request) => request.path === "money/wallet-link");
    expect(Object.keys(link?.body ?? {}).sort()).toEqual(["consentKey", "gameId", "nonce", "pubKey", "signature"]);
    expect(await services.keys.holds(link?.body.consentKey as string)).toBe(true);
    expect(moneySession().address).toBe(TEST_WALLET);
  });

  it("the server's answers that need a step say which: Confirm it's you, or Replace", async () => {
    const services = testServices();
    const port = scriptedPort();
    port.answer("money/wallet-challenge", 403, { error: "reauth-required", reason: "Confirm it's you first." }); // the server's own words (`server/src/escrow/moneyTables.ts`)
    expect(await linkWallet(ctx({ view: moneyView(), port, services }))).toEqual({ ok: false, reason: expect.any(String), needs: "confirm" });
  });
});

describe("ESCROW-4: a joiner's deposit -- admission and chain checked here; kept before broadcast; only a hint to the server", () => {
  async function joinerWorld() {
    const services = testServices();
    const port = scriptedPort();
    const key = await services.keys.create({ chainId: "uni-7", contract: TEST_CONTRACT, gameId: "g_table", playerId: "p-me", wallet: TEST_WALLET });
    if (!key.ok) throw new Error(key.reason);
    const view = moneyView({ escrow: { chainGameId: "7", state: "FUNDING" }, you: linked([key.pubkey], { actions: ["deposit"] }) });
    services.wallet.game = chainFacts();
    services.wallet.config = { ...services.wallet.config, admissionPubkey: (await testKey("admission")).pubkey };
    return { services, port, view, consentKey: key.pubkey };
  }

  it("a good admission + a matching chain game: Keplr signs the Join this browser built; the record exists at broadcast", async () => {
    const { services, port, view, consentKey } = await joinerWorld();
    port.answer("money/join-admission", 200, { ok: true, admission: await admission() });
    port.answer("money/deposit-sent", 202, { ok: true, accepted: true });
    let keptAtBroadcast = false;
    services.wallet.onBroadcast = () => {
      keptAtBroadcast = services.pending.all().some((record) => record.kind === "join" && record.stage === "signed" && record.consentKey === consentKey);
    };
    expect(await approveDeposit(ctx({ view, port, services }))).toEqual({ ok: true, notice: "Sent — waiting for Juno." });
    expect(keptAtBroadcast).toBe(true);
    expect(services.wallet.signed.map((message) => message.kind)).toEqual(["join"]);
    expect(services.wallet.signed[0].msgJson).toContain(`"consent_pubkey":"${consentKey}"`);
    expect(services.pending.all()[0].stage).toBe("sent");
    const hint = port.requests.find((request) => request.path === "money/deposit-sent");
    expect(hint?.body).toMatchObject({ gameId: "g_table", kind: "join", chainGameId: "7" });
    /* Single flight: a second deposit while this one may land is refused, and nothing is signed. */
    expect(await approveDeposit(ctx({ view, port, services }))).toEqual({ ok: false, reason: expect.stringMatching(/already on its way/) });
  });

  it("an admission for another wallet, or a chain game that disagrees with the table: refused, nothing signed", async () => {
    const { services, port, view } = await joinerWorld();
    port.answer("money/join-admission", 200, { ok: true, admission: await admission({ wallet: "juno1someoneelse" }) });
    expect(await approveDeposit(ctx({ view, port, services }))).toEqual({ ok: false, reason: expect.stringMatching(/another wallet/) });
    port.answer("money/join-admission", 200, { ok: true, admission: await admission() });
    services.wallet.game = chainFacts({ anteGross: "5000000" });
    expect(await approveDeposit(ctx({ view, port, services }))).toEqual({ ok: false, reason: expect.stringMatching(/different deposit/) });
    expect(services.wallet.signed).toEqual([]);
  });

  it("a browser that can't keep the record broadcasts nothing; a refused broadcast drops the record; a lost answer keeps it", async () => {
    const storage = memoryStorage();
    const { services: base, port, view } = await joinerWorld();
    const services = { ...base, pending: testServices({ storage }).pending };
    storage.failWrites = true;
    port.answer("money/join-admission", 200, { ok: true, admission: await admission() });
    expect(await approveDeposit(ctx({ view, port, services }))).toEqual({ ok: false, reason: expect.stringMatching(/couldn't keep a record/) });
    expect(services.wallet.broadcasts).toEqual([]);
    storage.failWrites = false;
    services.wallet.broadcastAnswer = { kind: "refused", reason: "insufficient fees" };
    port.answer("money/join-admission", 200, { ok: true, admission: await admission() });
    expect(await approveDeposit(ctx({ view, port, services }))).toEqual({ ok: false, reason: expect.stringMatching(/Juno refused the transaction/) });
    expect(services.pending.all()).toEqual([]);
    services.wallet.broadcastAnswer = { kind: "unknown" };
    port.answer("money/join-admission", 200, { ok: true, admission: await admission() });
    expect(await approveDeposit(ctx({ view, port, services }))).toEqual({ ok: true, notice: expect.stringMatching(/answer didn't arrive.*don't send it again/) });
    const kept = services.pending.all()[0];
    expect(kept.stage).toBe("sent");
    /* After a reload: the SAME bytes go out again (they can land once), and the chain's answer drops the record. */
    await resendPending(kept, services, port);
    expect(services.wallet.broadcasts.at(-1)).toEqual(services.wallet.broadcasts.at(-2));
    services.wallet.status = { kind: "expired" };
    expect(await reconcilePending("g_table", services, port)).toMatch(/can never land. Nothing moved/);
    expect(services.pending.all()).toEqual([]);
  });

  it("a deposit from a device whose key the seat never registered makes one, and asks 'Confirm it's you' to register it", async () => {
    const services = testServices();
    const port = scriptedPort();
    const view = moneyView({ escrow: { chainGameId: "7", state: "FUNDING" }, you: linked([`03${"44".repeat(32)}`], { actions: ["deposit"] }) });
    port.answer("money/consent-key", 403, { error: "reauth-required", reason: "Confirm it's you first." });
    expect(await approveDeposit(ctx({ view, port, services }))).toEqual({ ok: false, reason: expect.stringMatching(/Confirm it's you/), needs: "confirm" });
    expect(await services.keys.count()).toBe(1); // stored before anything could carry it
    expect(services.wallet.signed).toEqual([]);
  });
});

describe("ESCROW-4: the host's CreateGame, and the exits", () => {
  it("the host opens the escrow with CreateGame (never while Juno's escrow is paused)", async () => {
    const services = testServices();
    const port = scriptedPort();
    const key = await services.keys.create({ chainId: "uni-7", contract: TEST_CONTRACT, gameId: "g_table", playerId: "p-me", wallet: TEST_WALLET });
    if (!key.ok) throw new Error(key.reason);
    const view = moneyView({ you: linked([key.pubkey], { actions: ["open-escrow"] }) });
    services.wallet.config = { paused: true, minAnte: null, admissionPubkey: null };
    expect(await approveDeposit(ctx({ view, port, services, isHost: true }))).toEqual({ ok: false, reason: expect.stringMatching(/paused/) });
    services.wallet.config = { paused: false, minAnte: "1000", admissionPubkey: null };
    port.answer("money/deposit-sent", 202, { ok: true, accepted: true });
    expect((await approveDeposit(ctx({ view, port, services, isHost: true }))).ok).toBe(true);
    expect(services.wallet.signed.map((message) => [message.kind, message.chainGameId])).toEqual([["createGame", null]]);
  });

  it("withdraw is sent from the depositing wallet, cancel from the creator's; both to the table's escrow game", async () => {
    const services = testServices();
    const port = scriptedPort();
    const view = moneyView({ escrow: { chainGameId: "7", state: "FUNDING" }, you: linked([], { funding: "funded", payoutWallet: TEST_WALLET, chainSeatIndex: 0, actions: ["withdraw", "cancel-escrow"] }) });
    port.answer("money/deposit-sent", 202, { ok: true, accepted: true });
    port.answer("money/deposit-sent", 202, { ok: true, accepted: true });
    expect((await escrowExit(ctx({ view, port, services }), "withdraw")).ok).toBe(true);
    services.wallet.status = { kind: "included", ok: true, log: null };
    await reconcilePending("g_table", services, port);
    expect(services.pending.all()).toEqual([]); // a withdrawal's record is done once included (not a deposit)
    /* Cancel comes from the escrow's creator AS JUNO SAYS IT (read here), whatever this seat's link says. */
    services.wallet.game = chainFacts({ creator: "juno1creatorwallet" });
    expect(await escrowExit(ctx({ view, port, services }), "cancel-escrow")).toEqual({ ok: false, reason: expect.stringMatching(/^Switch Keplr to juno1creatorwallet to sign this action\./) });
    services.wallet.game = chainFacts({ creator: TEST_WALLET });
    expect((await escrowExit(ctx({ view, port, services }), "cancel-escrow")).ok).toBe(true);
    expect(services.wallet.signed.map((message) => message.msgJson)).toEqual(['{"withdraw":{"chain_game_id":7}}', '{"cancel":{"chain_game_id":7}}']);
    expect(services.wallet.calls.filter((call) => call.startsWith("signTx")).every((call) => call.includes(TEST_WALLET))).toBe(true);
    /* The deposit hint says when the transaction can no longer land. */
    expect(port.requests.find((request) => request.path === "money/deposit-sent")?.body).toMatchObject({ kind: "withdraw", timeoutHeight: "1100" });
  });
});

describe("ESCROW-4: consent and annul -- the seat's own key signs this browser's digest; relayed without re-auth", () => {
  it("Approve payout needs a matching on-device check and the chain's current key; the relayed signature verifies", async () => {
    const services = testServices();
    const port = scriptedPort();
    const key = await services.keys.create({ chainId: "uni-7", contract: TEST_CONTRACT, gameId: "g_table", playerId: "p-me", wallet: TEST_WALLET });
    if (!key.ok) throw new Error(key.reason);
    const domain = "aa".repeat(32);
    const settleDigest = "cc".repeat(32);
    const view = moneyView({
      escrow: { chainGameId: "7", state: "SETTLEABLE" },
      you: linked([key.pubkey], { funding: "funded", chainSeatIndex: 0, payoutWallet: TEST_WALLET, chainConsentKey: key.pubkey, actions: ["approve-payout"] }),
      settlement: { status: "recorded", phase: "settleable", chainState: "SETTLEABLE", seq: "9", settleDigest, domain, source: "terminal_payload", windowEnd: T0 + 600_000, livenessAvailableAt: null, resolverTimeoutAt: null, consentedSeats: [], payable: true, amounts: null, route: null, trustedSeq: "8", annulSigned: [], lastCheckpoint: null, bond: "500000" },
    });
    const about = { settleDigest, domain, seq: "9", signingKey: key.pubkey };
    expect(await approvePayout(ctx({ view, port, services }), { result: "unavailable", payouts: null, detail: "", ...about })).toEqual({ ok: false, reason: expect.stringMatching(/hasn't confirmed/) });
    /* A check of ANOTHER recorded payout (the view moved on) approves nothing (review S-H1). */
    expect(await approvePayout(ctx({ view, port, services }), { result: "match", payouts: null, detail: "", ...about, settleDigest: "dd".repeat(32) })).toEqual({ ok: false, reason: expect.stringMatching(/changed since this device checked it/) });
    expect(port.requests).toEqual([]);
    port.answer("money/consent", 200, { ok: true, status: "queued" });
    expect((await approvePayout(ctx({ view, port, services }), { result: "match", payouts: null, detail: "", ...about })).ok).toBe(true);
    const relayed = port.requests.find((request) => request.path === "money/consent");
    expect(Object.keys(relayed?.body ?? {}).sort()).toEqual(["gameId", "signature"]);
    const signature = fromHex(relayed?.body.signature as string);
    expect(await Secp256k1.verifySignature(Secp256k1Signature.fromFixedLength(signature), fromHex(consentDigestV1(domain, BigInt(9), settleDigest)), fromHex(key.pubkey))).toBe(true);
    /* A key this device doesn't hold (the check found none of its own on the chain seat) signs nothing here. */
    expect(await approvePayout(ctx({ view, port, services }), { result: "match", payouts: null, detail: "", ...about, signingKey: `03${"55".repeat(32)}` })).toEqual({ ok: false, reason: expect.stringMatching(/doesn't hold your seat's signing key/) });
    /* ANNUL: signed over the escrow game's own domain and trusted sequence, as Juno says them (the view needn't know). */
    const annulDomain = "bb".repeat(32);
    services.wallet.game = chainFacts({ state: "IN_PROGRESS", domain: annulDomain, trustedSeq: "12", seats: [{ wallet: "juno1host", joinTicket: "ef".repeat(32), consentPubkey: `02${"11".repeat(32)}` }, { wallet: TEST_WALLET, joinTicket: TICKET, consentPubkey: key.pubkey }] });
    port.answer("money/annul", 200, { ok: true, trustedSeq: "12", collected: [1], needed: 2, submitted: false });
    const noSettlementYet = moneyView({ ...view, settlement: null });
    expect(await agreeToAnnul(ctx({ view: noSettlementYet, port, services }))).toEqual({ ok: true, notice: expect.stringMatching(/1 of 2/) });
    const annulled = port.requests.find((request) => request.path === "money/annul");
    expect(await Secp256k1.verifySignature(Secp256k1Signature.fromFixedLength(fromHex(annulled?.body.signature as string)), fromHex(annulDigestV1(annulDomain, BigInt(12))), fromHex(key.pubkey))).toBe(true);
    /* A device none of whose keys is on the escrow's seats signs no ANNUL. */
    services.wallet.game = chainFacts({ state: "IN_PROGRESS", domain: annulDomain, trustedSeq: "12" });
    expect(await agreeToAnnul(ctx({ view, port, services }))).toEqual({ ok: false, reason: expect.stringMatching(/doesn't hold your seat's signing key/) });
  });

  /* Owner broad gate (ESCROW-4 report §21): the seat key's signature threw whenever its 32-byte r or s began with a zero
     byte, so "Approve payout now" and "Agree to cancel" failed for that key and digest on every retry. Fixed vectors:
     both buttons sign through `consentKeys.signDigest` and relay all 64 bytes. */
  it("fixed vectors: Approve payout and Agree to cancel sign and relay a signature whose r or s begins with a zero byte", async () => {
    const key = await testKey(LEADING_ZERO_KEY);
    const vault = memoryConsentKeyVault();
    vault.records.set(key.pubkey, { v: 1, chainId: "uni-7", contract: TEST_CONTRACT, gameId: "g_table", playerId: "p-me", wallet: TEST_WALLET, pubkey: key.pubkey, privkey: toHex(key.privkey), createdAt: T0 });
    const services = testServices({ keys: createConsentKeys(vault, () => T0) });
    const port = scriptedPort();
    const relayed = (path: "money/consent" | "money/annul"): string => {
      const sent = port.requests.filter((request) => request.path === path);
      return sent[sent.length - 1]?.body.signature as string;
    };
    const you = linked([key.pubkey], { funding: "funded", chainSeatIndex: 1, payoutWallet: TEST_WALLET, chainConsentKey: key.pubkey, actions: ["approve-payout"] });
    const { consent, annul } = LEADING_ZERO_VECTORS;
    for (const vector of [consent.rLeadingZero, consent.sLeadingZero, consent.ordinary]) {
      const seq = String(vector.seq);
      const view = moneyView({
        escrow: { chainGameId: "7", state: "SETTLEABLE" },
        you,
        settlement: { status: "recorded", phase: "settleable", chainState: "SETTLEABLE", seq, settleDigest: consent.settleDigest, domain: consent.domain, source: "terminal_payload", windowEnd: T0 + 600_000, livenessAvailableAt: null, resolverTimeoutAt: null, consentedSeats: [], payable: true, amounts: null, route: null, trustedSeq: "8", annulSigned: [], lastCheckpoint: null, bond: "500000" },
      });
      port.answer("money/consent", 200, { ok: true, status: "queued" });
      const answer = await approvePayout(ctx({ view, port, services }), { result: "match", payouts: null, detail: "", settleDigest: consent.settleDigest, domain: consent.domain, seq, signingKey: key.pubkey });
      expect([seq, answer.ok]).toEqual([seq, true]);
      expect([seq, relayed("money/consent")]).toEqual([seq, vector.signature]);
      expect([seq, await Secp256k1.verifySignature(Secp256k1Signature.fromFixedLength(fromHex(vector.signature)), fromHex(consentDigestV1(consent.domain, BigInt(seq), consent.settleDigest)), fromHex(key.pubkey))]).toEqual([seq, true]);
    }
    const seated = moneyView({ escrow: { chainGameId: "7", state: "SETTLEABLE" }, you, settlement: null });
    for (const vector of [annul.rLeadingZero, annul.sLeadingZero, annul.ordinary]) {
      const trustedSeq = String(vector.seq);
      services.wallet.game = chainFacts({ state: "IN_PROGRESS", domain: annul.domain, trustedSeq, seats: [{ wallet: "juno1host", joinTicket: "ef".repeat(32), consentPubkey: `02${"11".repeat(32)}` }, { wallet: TEST_WALLET, joinTicket: TICKET, consentPubkey: key.pubkey }] });
      port.answer("money/annul", 200, { ok: true, trustedSeq, collected: [1], needed: 2, submitted: false });
      const answer = await agreeToAnnul(ctx({ view: seated, port, services }));
      expect([trustedSeq, answer.ok]).toEqual([trustedSeq, true]);
      expect([trustedSeq, relayed("money/annul")]).toEqual([trustedSeq, vector.signature]);
      expect([trustedSeq, await Secp256k1.verifySignature(Secp256k1Signature.fromFixedLength(fromHex(vector.signature)), fromHex(annulDigestV1(annul.domain, BigInt(trustedSeq))), fromHex(key.pubkey))]).toEqual([trustedSeq, true]);
    }
  });
});

describe("ESCROW-4 review fixes: a deposit Juno included is kept until the table shows it; signing moves only with Keplr", () => {
  it("R-M1: included -> landed (no second deposit meanwhile) -> dropped once the view shows it funded; a stale one is let go with a pointer", async () => {
    let now = T0;
    const services = testServices({ now: () => now });
    const port = scriptedPort();
    const key = await services.keys.create({ chainId: "uni-7", contract: TEST_CONTRACT, gameId: "g_table", playerId: "p-me", wallet: TEST_WALLET });
    if (!key.ok) throw new Error(key.reason);
    services.wallet.config = { ...services.wallet.config, admissionPubkey: (await testKey("admission")).pubkey };
    services.wallet.game = chainFacts();
    const view = moneyView({ escrow: { chainGameId: "7", state: "FUNDING" }, you: linked([key.pubkey], { actions: ["deposit"] }) });
    port.answer("money/join-admission", 200, { ok: true, admission: await admission() });
    port.answer("money/deposit-sent", 202, { ok: true, accepted: true });
    expect((await approveDeposit(ctx({ view, port, services }))).ok).toBe(true);
    services.wallet.status = { kind: "included", ok: true, log: null };
    await reconcilePending("g_table", services, port);
    expect(services.pending.all().map((record) => record.stage)).toEqual(["landed"]);
    expect(await approveDeposit(ctx({ view, port, services }))).toEqual({ ok: false, reason: expect.stringMatching(/Juno included this seat's deposit/) });
    /* The view still says linked: the record stays. Once it says funded, the record is done. */
    expect(settleLandedDeposits("g_table", view, services)).toBe(false);
    const funded = moneyView({ escrow: { chainGameId: "7", state: "FUNDING" }, you: linked([key.pubkey], { funding: "funded", chainSeatIndex: 1, payoutWallet: TEST_WALLET }) });
    expect(settleLandedDeposits("g_table", funded, services)).toBe(true);
    expect(services.pending.all()).toEqual([]);
    /* A landed deposit the table never shows is let go after a while, pointing at "Your deposits". */
    services.pending.put({ v: 1, gameId: "g_table", playerId: "p-me", kind: "join", chainId: "uni-7", contract: TEST_CONTRACT, sender: TEST_WALLET, chainGameId: "7", txHash: "EE".repeat(32), txBytes: "AAAA", timeoutHeight: "1100", createdAt: now, stage: "landed", consentKey: null });
    now += LANDED_WAIT_MS + 1;
    expect(await reconcilePending("g_table", services, port)).toMatch(/Your deposits/);
    expect(services.pending.all()).toEqual([]);
  });

  it("R-M3: 'Use this device for signing' makes and registers no key on a device without Keplr (or on the wrong account)", async () => {
    const services = testServices();
    const port = scriptedPort();
    const view = moneyView({ escrow: { chainGameId: "7", state: "IN_PROGRESS" }, you: linked([], { funding: "funded", chainSeatIndex: 1, payoutWallet: TEST_WALLET, actions: ["move-signing-key"] }) });
    services.wallet.present = false;
    expect((await moveSigningKeyHere(ctx({ view, port, services }))).ok).toBe(false);
    services.wallet.present = true;
    services.wallet.address = "juno1another";
    expect(await moveSigningKeyHere(ctx({ view, port, services }))).toEqual({ ok: false, reason: expect.stringMatching(/^Switch Keplr to .+ to sign this action\./), needs: "connect" });
    expect(await services.keys.count()).toBe(0);
    expect(port.requests).toEqual([]);
  });
});

describe("PHASE 3 FINAL: 'Confirm it's you' is the account's PASSWORD", () => {
  it("sends the password once in the POST body; a wrong one is one sentence in password words; the grant is believed for no longer than five minutes from this clock", async () => {
    installMoneyServicesForTests(testServices());
    updateMoneySession({ confirmedUntil: null });
    const port = scriptedPort();
    port.answer("profile/reauth", 403, { error: "invalid-credential" });
    expect(await confirmItsYou("not the password", port, () => T0)).toEqual({ ok: false, reason: "That password doesn't match this account. Check it and try again." });
    expect(moneySession().confirmedUntil).toBeNull();
    port.answer("profile/reauth", 503, { error: "unavailable" });
    expect(await confirmItsYou("correct horse battery", port, () => T0)).toEqual({ ok: false, reason: "The game server couldn't confirm it just now. Try again." });
    /* The server's window is longer than five minutes from this clock: this page believes five minutes, no more. */
    port.answer("profile/reauth", 200, { ok: true, expiresAt: T0 + 60 * 60 * 1000 });
    expect(await confirmItsYou("correct horse battery", port, () => T0)).toEqual({ ok: true });
    expect(moneySession().confirmedUntil).toBe(T0 + 5 * 60 * 1000);
    port.answer("profile/reauth", 200, { ok: true, expiresAt: T0 + 60_000 });
    expect(await confirmItsYou("correct horse battery", port, () => T0)).toEqual({ ok: true });
    expect(moneySession().confirmedUntil).toBe(T0 + 60_000);
    expect(port.requests.map((request) => [request.path, request.body])).toEqual([
      ["profile/reauth", { password: "not the password" }],
      ["profile/reauth", { password: "correct horse battery" }],
      ["profile/reauth", { password: "correct horse battery" }],
      ["profile/reauth", { password: "correct horse battery" }],
    ]);
    /* An empty password is the wrong-password answer, with no request spent. */
    expect(await confirmItsYou("", port, () => T0)).toEqual({ ok: false, reason: "That password doesn't match this account. Check it and try again." });
    expect(port.requests).toHaveLength(4);
  });
});
