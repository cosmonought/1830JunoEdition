/** @jest-environment node */
// ESCROW-4: the money routes, client side. Every call resolves (never rejects) to one typed result; a refusal carries
// the server's own code and sentence (never a generic failure); the path is from the port's closed list and the body
// carries exactly the route's fields (a `replace` only when asked for).

import { depositSent, escrowDetails, joinAdmission, moneyConfig, relayConsent, submitAnnul, walletChallenge, walletLink, yourDeposits } from "./moneyApi";
import { scriptedPort, TEST_CONTRACT, TEST_PIN } from "./moneyTestSupport";

describe("ESCROW-4: moneyApi", () => {
  it("answers with the server's own refusal words, and never rejects", async () => {
    const port = scriptedPort();
    /* The server's own words (`server/src/escrow/moneyTables.ts`: "reauth-required" -> "Confirm it's you first."). */
    port.answer("money/wallet-challenge", 403, { error: "reauth-required", reason: "Confirm it's you first." });
    expect(await walletChallenge("g_1", "juno1w", port)).toEqual({ ok: false, code: "reauth-required", reason: "Confirm it's you first.", status: 403 });
    expect(await walletChallenge("g_1", "juno1w", port)).toEqual({ ok: false, code: "network", reason: expect.stringMatching(/didn't answer/), status: null });
    port.answer("money/wallet-link", 429, { error: "rate-limited", retryAfterMs: 4000 });
    expect(await walletLink({ gameId: "g", nonce: "n", pubKey: "k", signature: "s", consentKey: "c" }, port)).toMatchObject({ ok: false, code: "rate-limited", retryAfterMs: 4000 });
    port.answer("money/join-admission", 409, { error: "admission-outstanding", reason: "This seat's join approval hasn't expired yet." });
    expect(await joinAdmission("g", port)).toMatchObject({ ok: false, code: "admission-outstanding", reason: "This seat's join approval hasn't expired yet." });
    port.answer("money/consent", 500, {});
    expect(await relayConsent("g", "sig", port)).toMatchObject({ ok: false, code: "internal" });
    port.answer("money/annul", 200, { ok: true, trustedSeq: 5 });
    expect(await submitAnnul("g", "sig", port)).toMatchObject({ ok: false, code: "bad-answer" });
  });

  it("PHASE 3 FINAL: a refusal without the server's words reads in account words -- an account, and the password (never a recovery key)", async () => {
    const port = scriptedPort();
    port.answer("money/wallet-challenge", 403, { error: "profile-required" });
    expect(await walletChallenge("g_1", "juno1w", port)).toEqual({ ok: false, code: "profile-required", reason: "Log in or create an account first.", status: 403 });
    port.answer("money/wallet-challenge", 403, { error: "reauth-required" });
    expect(await walletChallenge("g_1", "juno1w", port)).toEqual({ ok: false, code: "reauth-required", reason: "Confirm it's you with your password first.", status: 403 });
  });

  it("sends the route's exact fields, with `replace` only when asked for", async () => {
    const port = scriptedPort();
    port.answer("money/wallet-link", 200, { ok: true, mode: "issued", wallet: "juno1w", epoch: 2, ticket: "ab".repeat(32) });
    port.answer("money/wallet-link", 200, { ok: true, mode: "issued", wallet: "juno1w", epoch: 3, ticket: "ab".repeat(32) });
    await walletLink({ gameId: "g", nonce: "n", pubKey: "k", signature: "s", consentKey: "c" }, port);
    await walletLink({ gameId: "g", nonce: "n", pubKey: "k", signature: "s", consentKey: "c", replace: true }, port);
    expect(port.requests.map((request) => [request.path, request.body])).toEqual([
      ["money/wallet-link", { gameId: "g", nonce: "n", pubKey: "k", signature: "s", consentKey: "c" }],
      ["money/wallet-link", { gameId: "g", nonce: "n", pubKey: "k", signature: "s", consentKey: "c", replace: true }],
    ]);
    port.answer("money/deposit-sent", 202, { ok: true, accepted: true });
    expect(await depositSent("g", "join", "AB".repeat(32), null, port)).toEqual({ ok: true, value: { accepted: true } });
    expect(port.requests[2].body).toEqual({ gameId: "g", kind: "join", txHash: "AB".repeat(32) });
  });

  it("reads each success shape, and refuses one that isn't it", async () => {
    const port = scriptedPort();
    const deployment = { backend: "juno-cosmwasm", chainId: "uni-7", networkClass: "testnet", contract: TEST_CONTRACT, codeChecksum: TEST_PIN.codeChecksum, denom: "ujunox", symbol: "JUNOX", exponent: 6 };
    port.answer("money/config", 200, { ok: true, enabled: false, why: "rules-not-certified", reason: "not certified", deployment, feeBps: 100, minAnte: "1000" });
    expect(await moneyConfig(port)).toEqual({ ok: true, value: { enabled: false, why: "rules-not-certified", reason: "not certified", deployment, feeBps: 100, minAnte: "1000" } });
    port.answer("money/join-admission", 200, { ok: true, admission: { chain_id: "uni-7", contract: TEST_CONTRACT, chain_game_id: "7", wallet: "juno1w", join_ticket: "ab".repeat(32), expires_at: "1", signature: "cd".repeat(64), admission_pubkey: `02${"11".repeat(32)}`, extra: "dropped" } });
    const admission = await joinAdmission("g", port);
    expect(admission.ok && Object.keys(admission.value).sort()).toEqual(["admission_pubkey", "chain_game_id", "chain_id", "contract", "expires_at", "join_ticket", "signature", "wallet"]);
    port.answer("money/escrow-details", 200, { ok: true, checkpoint: null, settlement: { seq: "9", log_len: 4, round_key: null, payload: {}, signature: "ab", settle_digest: "cd", status: "confirmed" }, chain: null });
    expect(await escrowDetails("g", port)).toMatchObject({ ok: true, value: { checkpoint: null, settlement: { seq: "9" }, chain: null } });
    port.answer("money/deposits", 200, {
      ok: true,
      deposits: [{ gameId: "g_1", tableOpen: false, deployment, chainGameId: "7", wallet: "juno1w", grossDeposit: "1000000", netDeposit: "990000", chainState: "FUNDING", fundingDeadline: null, relation: "bound", creator: false, actions: ["withdraw"] }, { gameId: 5 }],
    });
    const deposits = await yourDeposits(port);
    expect(deposits.ok && deposits.value.map((entry) => entry.chainGameId)).toEqual(["7"]);
  });
});
