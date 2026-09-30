/** @jest-environment node */
// ESCROW-4: what the browser checks for itself before Keplr signs, and the exact messages it builds. A server cannot
// get a link for another site, network, table, seat or wallet signed through this page; a deposit is never built from
// server bytes; a Join admission is used only when every field is this seat's and its signature checks out; a Join is
// never sent into an escrow whose terms disagree with the table.

// Route v12 R12-2 moved the rules engine to 12 (R12-3 certified it for settlement): this page's rules are the engine's.
import { RULES_ENGINE_VERSION } from "../gameEngine/rulesVersion";
import { walletLinkChallengeText } from "../gameEngine/escrow/walletLinkChallengeV1";
import { WALLET_EXECUTE } from "../gameEngine/escrow/junoWalletMessages";
import { joinAdmissionDigestV1 } from "../gameEngine/escrow/junoJoinAdmissionV1";
import { variantsDigestV1 } from "../gameEngine/escrow/variantsDigest";
import { resolveVariants } from "../gameEngine/gameVariants";
import {
  admissionProblem,
  cancelMessage,
  chainGameFactsOf,
  chainGameProblemForJoin,
  challengeMessage,
  checkLinkChallenge,
  createGameMessage,
  finalizeMessage,
  joinMessage,
  livenessSettleMessage,
  rulesVersionForEscrow,
  setConsentKeyMessage,
  tableSigningProblem,
  withdrawMessage,
  type ChainGameFacts,
} from "./walletChecks";
import { linked, moneyView, testKey, TEST_CONTRACT, TEST_PIN, TEST_WALLET, TICKET, T0 } from "./moneyTestSupport";
import type { JoinAdmission } from "./moneyApi";

const VARIANTS = resolveVariants({} as never);
const CONSENT = `02${"11".repeat(32)}`;

const challengeFields = { appName: "Project 18XX", site: "https://play.example", chainId: "uni-7", contract: TEST_CONTRACT, gameId: "g_table", playerId: "p-me", wallet: TEST_WALLET, nonce: "ab".repeat(16), expiresAt: T0 + 300_000 };
const expectation = { appName: "Project 18XX", site: "https://play.example", pin: TEST_PIN, gameId: "g_table", playerId: "p-me", wallet: TEST_WALLET, now: T0 };

describe("ESCROW-4: the link challenge is read before Keplr signs it", () => {
  it("exactly this request's text is accepted", () => {
    expect(checkLinkChallenge(walletLinkChallengeText(challengeFields), expectation)).toEqual({ ok: true, value: challengeFields });
  });

  it("anything naming another app, site, network, contract, table, seat or wallet -- or expired, or not v1 -- is refused", () => {
    const refused = (over: Partial<typeof challengeFields>, match: RegExp) => {
      const answer = checkLinkChallenge(walletLinkChallengeText({ ...challengeFields, ...over }), expectation);
      expect(answer.ok ? "signed" : answer.reason).toMatch(match);
    };
    refused({ appName: "Evil" }, /another app/);
    refused({ site: "https://evil.example" }, /another site/);
    refused({ chainId: "juno-1" }, /another network/);
    refused({ contract: "juno1other" }, /another escrow contract/);
    refused({ gameId: "g_other" }, /another table/);
    refused({ playerId: "p-other" }, /another seat/);
    refused({ wallet: "juno1someoneelse" }, /another wallet/);
    refused({ expiresAt: T0 - 1 }, /expired/);
    const text = walletLinkChallengeText(challengeFields);
    expect(checkLinkChallenge(text.replace("WALLET-LINK/v1", "WALLET-LINK/v2"), expectation).ok).toBe(false);
    expect(checkLinkChallenge(`${text}\nTransfer: everything`, expectation).ok).toBe(false);
  });
});

describe("ESCROW-4: the table and the messages, built here from neutral fields", () => {
  it("a table on another escrow, with a malformed stake or seat count, is never signed for", () => {
    expect(tableSigningProblem(TEST_PIN, moneyView())).toBeNull();
    expect(tableSigningProblem(TEST_PIN, moneyView({ deployment: { ...moneyView().deployment, contract: "juno1evil" } }))).toMatch(/contract differs/);
    expect(tableSigningProblem(TEST_PIN, moneyView({ deployment: { ...moneyView().deployment, codeChecksum: "0".repeat(64) } }))).toMatch(/codeChecksum differs/);
    expect(tableSigningProblem(TEST_PIN, moneyView({ terms: { anteGross: "1.5" } }))).toMatch(/whole amount/);
    expect(tableSigningProblem(TEST_PIN, moneyView({ terms: { seats: 9 } }))).toMatch(/seat count/);
  });

  it("CreateGame commits to the table's frozen rules version, this browser's variants digest, the exact seats and pace, the seat's ticket and a key held here", () => {
    const view = moneyView({ you: linked([CONSENT]) });
    const built = createGameMessage(TEST_PIN, view, VARIANTS, CONSENT);
    if (!built.ok) throw new Error(built.reason);
    expect(built.value.msgJson).toBe(WALLET_EXECUTE.createGame({ maxPlayers: 2, mode: 0, rulesEngineVersion: RULES_ENGINE_VERSION, variantsDigest: variantsDigestV1(VARIANTS), consentPubkey: CONSENT, joinTicket: TICKET }));
    expect(built.value.funds).toEqual([{ denom: "ujunox", amount: "1000000" }]);
    expect(built.value.hint).toBe("create");
    expect(createGameMessage(TEST_PIN, moneyView(), VARIANTS, CONSENT)).toEqual({ ok: false, reason: expect.stringMatching(/Link your wallet/) });
    expect(createGameMessage(TEST_PIN, moneyView({ you: linked(), terms: { rulesEngineVersion: 99 } }), VARIANTS, CONSENT)).toEqual({ ok: false, reason: expect.stringMatching(/rules version this page doesn't/) });
    expect(rulesVersionForEscrow(moneyView({ terms: { rulesEngineVersion: null } })).ok).toBe(false);
  });

  it("every other wallet message is the canonical builder's JSON, with funds only where the contract takes them", () => {
    const ok = <T>(value: { ok: true; value: T } | { ok: false; reason: string }): T => {
      if (!value.ok) throw new Error(value.reason);
      return value.value;
    };
    expect(ok(withdrawMessage(TEST_PIN, "7"))).toMatchObject({ msgJson: WALLET_EXECUTE.withdraw("7"), funds: [], hint: "withdraw" });
    expect(ok(cancelMessage(TEST_PIN, "7"))).toMatchObject({ msgJson: WALLET_EXECUTE.cancel("7"), funds: [], hint: "cancel" });
    expect(ok(setConsentKeyMessage(TEST_PIN, "7", CONSENT))).toMatchObject({ msgJson: WALLET_EXECUTE.setConsentKey("7", CONSENT), funds: [], consentKey: CONSENT });
    expect(ok(challengeMessage(TEST_PIN, "7", "cd".repeat(32), "500000"))).toMatchObject({ msgJson: WALLET_EXECUTE.challenge("7", "cd".repeat(32)), funds: [{ denom: "ujunox", amount: "500000" }] });
    expect(challengeMessage(TEST_PIN, "7", "cd".repeat(32), null).ok).toBe(false);
    expect(ok(livenessSettleMessage(TEST_PIN, "7"))).toMatchObject({ msgJson: WALLET_EXECUTE.livenessSettle("7", null), funds: [] });
    expect(ok(finalizeMessage(TEST_PIN, "7"))).toMatchObject({ msgJson: WALLET_EXECUTE.finalize("7"), funds: [] });
    expect(withdrawMessage(TEST_PIN, null).ok).toBe(false);
    expect(withdrawMessage(TEST_PIN, "07").ok).toBe(false);
  });
});

describe("ESCROW-4: a Join admission is this seat's, fresh and properly signed -- or it isn't used", () => {
  async function admissionFor(over: Partial<JoinAdmission> = {}): Promise<JoinAdmission> {
    const key = await testKey("admission");
    const base = { chain_id: "uni-7", contract: TEST_CONTRACT, chain_game_id: "7", wallet: TEST_WALLET, join_ticket: TICKET, expires_at: String(Math.floor(T0 / 1000) + 600) };
    const merged = { ...base, ...over };
    const digest = joinAdmissionDigestV1({ chain_id: merged.chain_id, contract_addr: merged.contract, chain_game_id: BigInt(merged.chain_game_id), wallet: merged.wallet, join_ticket: merged.join_ticket, expires_at: BigInt(merged.expires_at) });
    return { ...merged, signature: await key.sign(digest), admission_pubkey: key.pubkey, ...(over.signature ? { signature: over.signature } : {}) };
  }
  const view = moneyView({ you: linked([CONSENT]), escrow: { chainGameId: "7", state: "FUNDING" } });

  it("a good one passes and builds the Join with it", async () => {
    const admission = await admissionFor();
    const chainKey = (await testKey("admission")).pubkey;
    expect(await admissionProblem(TEST_PIN, view, admission, { wallet: TEST_WALLET, now: T0, admissionKey: chainKey })).toBeNull();
    const built = joinMessage(TEST_PIN, view, admission, CONSENT);
    if (!built.ok) throw new Error(built.reason);
    expect(built.value.msgJson).toBe(WALLET_EXECUTE.join("7", CONSENT, TICKET, { expiresAt: admission.expires_at, signature: admission.signature }));
    expect(built.value.funds).toEqual([{ denom: "ujunox", amount: "1000000" }]);
  });

  it("another network, contract, escrow game, wallet or ticket; a lapsing one; a forged signature; a key Juno doesn't trust: refused", async () => {
    const chainKey = (await testKey("admission")).pubkey;
    const check = async (admission: JoinAdmission, wallet = TEST_WALLET, now = T0, admissionKey: string | null = chainKey) => admissionProblem(TEST_PIN, view, admission, { wallet, now, admissionKey });
    /* Review S-L2: the key is Juno's (the escrow's own configuration), never the server's word -- an approval a server
       signed with a key of its own choosing, however valid its signature, is not used. */
    const rogue = await testKey("rogue-admission");
    expect(await check(await admissionFor(), TEST_WALLET, T0, rogue.pubkey)).toMatch(/isn't signed by the key Juno's escrow trusts/);
    expect(await check(await admissionFor(), TEST_WALLET, T0, null)).toMatch(/isn't signed by the key Juno's escrow trusts/);
    expect(await check(await admissionFor({ chain_id: "juno-1" }))).toMatch(/another network/);
    expect(await check(await admissionFor({ contract: "juno1evil" }))).toMatch(/another escrow contract/);
    expect(await check(await admissionFor({ chain_game_id: "8" }))).toMatch(/another escrow game/);
    expect(await check(await admissionFor({ wallet: "juno1someoneelse" }))).toMatch(/another wallet/);
    expect(await check(await admissionFor(), "juno1keplrisonanother")).toMatch(/another wallet/);
    expect(await check(await admissionFor({ join_ticket: "cd".repeat(32) }))).toMatch(/another seat ticket/);
    expect(await check(await admissionFor(), TEST_WALLET, T0 + 590_000)).toMatch(/about to expire/);
    const forged = await admissionFor();
    const flipped = (forged.signature[0] === "0" ? "1" : "0") + forged.signature.slice(1);
    expect(await check({ ...forged, signature: flipped })).toMatch(/signature doesn't check out/);
  });
});

describe("ESCROW-4: the chain game as Juno answers it (read tolerantly, only the checked fields)", () => {
  it("reads the seats, the domain, the trusted sequence and the stored settlement", () => {
    const facts = chainGameFactsOf({
      game: { state: "settleable", creator: "juno1host", max_players: 2, mode: "live", rules_engine_version: 11, variants_digest: "AB".repeat(32), denom: "ujunox", ante_gross: "1000000", seats: [{ wallet: "juno1host", join_ticket: "EF".repeat(32), consent_pubkey: `02${"1A".repeat(32)}` }], domain: "CC".repeat(32), settlement: { source: "terminal_payload", payload: { seq: "25", payload_digest: "DD".repeat(32) }, window_end: "0" } },
      deadlines: { funding_deadline: "1000000000" },
      paused: false,
      trusted_seq: "23",
    });
    expect(facts).toMatchObject({ state: "SETTLEABLE", domain: "cc".repeat(32), trustedSeq: "23", settlement: { seq: "25", payloadDigest: "dd".repeat(32) }, seats: [{ consentPubkey: `02${"1a".repeat(32)}` }] });
    expect(chainGameFactsOf({ game: { ...{ state: "in_progress", creator: "c", max_players: 2, mode: "live", rules_engine_version: 11, variants_digest: "ab", denom: "u", ante_gross: "1", seats: [] } }, deadlines: {}, trusted_seq: "x" })).toMatchObject({ domain: null, trustedSeq: null, settlement: null });
  });
});

describe("ESCROW-4: the chain game, read by this browser, must be exactly the table's before a Join", () => {
  const view = moneyView({ you: linked([CONSENT]), escrow: { chainGameId: "7", state: "FUNDING" } });
  const facts: ChainGameFacts = {
    state: "FUNDING",
    creator: "juno1host",
    maxPlayers: 2,
    mode: "live",
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
  };
  it("matching terms pass; every disagreement is refused with its reason", () => {
    const problem = (over: Partial<ChainGameFacts>, wallet = TEST_WALLET) => chainGameProblemForJoin(TEST_PIN, view, VARIANTS, { ...facts, ...over }, wallet, T0);
    expect(problem({})).toBeNull();
    expect(problem({ state: "FUNDED" })).toMatch(/isn't taking deposits/);
    expect(problem({ paused: true })).toMatch(/paused/);
    expect(problem({ fundingDeadlineMs: T0 - 1 })).toMatch(/closed/);
    expect(problem({ anteGross: "999999" })).toMatch(/different deposit/);
    expect(problem({ denom: "ujuno" })).toMatch(/different deposit/);
    expect(problem({ maxPlayers: 3 })).toMatch(/different table/);
    expect(problem({ mode: "async" })).toMatch(/different table/);
    expect(problem({ rulesEngineVersion: 10 })).toMatch(/different rules version/);
    expect(problem({ variantsDigest: "00".repeat(32) })).toMatch(/different house rules/);
    expect(problem({ seats: [...facts.seats, { wallet: TEST_WALLET, joinTicket: TICKET, consentPubkey: CONSENT }] })).toMatch(/already holds a seat/);
  });
});
