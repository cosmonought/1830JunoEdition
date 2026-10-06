// server/src/tools/jx3bEvidence.test.ts
//
// ==================================================================
//  JX-3B (C-4): THE JX-3 EVIDENCE TOOLING -- THE REDACTED WALLET-GRANT VIEW AND THE OFFLINE LINK VERIFIER
// ==================================================================
//
// Synthetic captures only (test wallets, a test server): no real user data is a fixture. What is pinned:
//   - `gamesDoctor wallet-grants` (file mode, as a CLI over a real data directory) and the shared view: every grant's
//     seat, epoch, wallet, proof digests, standing as the server judges it, revoke reason and freeze; contexts only as
//     fingerprints (a re-home shows a new family fingerprint and the SAME ticket fingerprint); no session id, selector,
//     password (PHASE 3 FINAL: no recovery key exists), cookie or raw principal/family id anywhere in the output;
//   - (`gamesDoctor aws wallet-grants` -- the same view over DynamoDB -- is pinned in `aws/operator/jx3bWalletGrants.test.ts`);
//   - `jx3VerifyLink`: a captured wallet-challenge answer + wallet-link body recompute the canonical text,
//     challenge_digest, the ADR-036 sign doc, the wallet from the key, the signature and proof_hash -- PASS against the
//     server's own record, FAIL with a specific reason for each tampering -- and it opens no network connection.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { apiRequest, quietConsole } from "../rooms/testSupport";
import { testWallet } from "../escrow/escrow4Support";
import { assertRedacted, evidenceWorld } from "../escrow/jx3bSupport";
import { createFileWalletTicketStore } from "../escrow/walletTicketFileStore";
import { createFileRecordStore } from "../rooms/recordStore";
import { IDENTITY_FILE } from "../identity/fileStore";
import { snapshotBytes } from "../identity/journalStore";
import { collectWalletGrants, fingerprint, type WalletGrantsView } from "./walletGrants";
import { runJx3VerifyLink, verifyCapturedLink } from "./jx3VerifyLink";

quietConsole();

/* The real module objects (an `import * as` namespace is a frozen copy: its properties cannot be replaced). */
/* eslint-disable @typescript-eslint/no-var-requires */
const dns: typeof import("dns") = require("dns");
const http: typeof import("http") = require("http");
const https: typeof import("https") = require("https");
const net: typeof import("net") = require("net");
/* eslint-enable @typescript-eslint/no-var-requires */

describe("JX-3B C-4a: the wallet-grant view", () => {
  test("file mode, as the CLI: every grant with its proof, standing as the server judges it, contexts as fingerprints -- a re-home is visible, nothing private is printed", async () => {
    const e = await evidenceWorld();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jx3b-grants-"));
    try {
      /* The data directory a file-mode server would have written: the ledger, the GameRecord, the identity snapshot. */
      const { version, document } = await e.world.ticketStore.load(e.table.gameId);
      const tickets = createFileWalletTicketStore(dir, { warn: () => undefined });
      for (let v = 0; v < version; v += 1) assert.equal(await tickets.put(e.table.gameId, document, v), "committed");
      const record = e.world.server.rooms.moneyPort.recordOf(e.table.gameId)!;
      assert.equal((await createFileRecordStore(dir, { warn: () => undefined }).put({ ...record, record_version: 1 }, null)).kind, "committed");
      fs.writeFileSync(path.join(dir, IDENTITY_FILE), snapshotBytes(e.world.identityStore.snapshot(), 0));
      const run = spawnSync(process.execPath, [path.join(__dirname, "gamesDoctor.js"), "wallet-grants", e.table.gameId, "--data", dir, "--json"], { encoding: "utf8" });
      assert.equal(run.status, 0, run.stderr);
      const view = JSON.parse(run.stdout) as WalletGrantsView;
      assert.equal(view.source, "file");
      assert.equal(view.identity.read, true);
      assert.equal(view.record.read, true);
      const seat = view.grants.filter((grant) => grant.player_id === e.playerId);
      assert.deepEqual(seat.map((grant) => [grant.epoch, grant.newest, grant.standing, grant.revoke_reason]), [[1, false, false, "superseded"], [2, true, true, null]]);
      const [old, current] = seat;
      assert.equal(old.ticket, current.ticket, "the re-home re-adopted the same ticket (same fingerprint)");
      assert.equal(old.context.principal, current.context.principal, "the same principal");
      assert.notEqual(old.context.family, current.context.family, "a different family: the proving device's");
      assert.equal(old.context.family, fingerprint("family", e.families.laptop));
      assert.equal(current.context.family, fingerprint("family", e.families.phone));
      assert.deepEqual([old.context.verdict, current.context.verdict], ["ended:family", "current"], "the laptop signed out; the phone stands");
      assert.equal(current.relinked_from, 1);
      assert.equal(current.wallet, e.w1.address);
      assert.equal(current.proof?.kind, "adr036");
      assert.equal(current.proof?.pubkey, e.w1.pubkey.toString("hex"));
      assert.equal(current.consent_keys, 2);
      assert.equal(current.seat_held, true);
      assert.equal(view.frozen_at, null);
      /* Nothing private, in either form. */
      const text = spawnSync(process.execPath, [path.join(__dirname, "gamesDoctor.js"), "wallet-grants", e.table.gameId, "--data", dir], { encoding: "utf8" });
      assert.equal(text.status, 0, text.stderr);
      assert.match(text.stdout, /epoch 2 \(newest\)\s+STANDING\s+wallet juno1/);
      assert.match(text.stdout, /re-adopted from epoch 1/);
      const secrets = [e.families.laptop, e.families.phone, e.joiner.browser.password, e.joiner.browser.cookie, e.phoneCookie, document.grants[0].ticket, document.grants[0].issued_under.recovery_selector, document.grants[0].issued_under.principal_id];
      assertRedacted(run.stdout, secrets);
      assertRedacted(text.stdout, secrets);
      /* The CLI only reads: the directory is byte-identical afterwards. */
      const before = fs.readdirSync(dir, { recursive: true }).sort().join("|");
      spawnSync(process.execPath, [path.join(__dirname, "gamesDoctor.js"), "wallet-grants", e.table.gameId, "--data", dir], { encoding: "utf8" });
      assert.equal(fs.readdirSync(dir, { recursive: true }).sort().join("|"), before);
      /* No identity store: the grants are still shown, standing "not evaluated" (exit 1: a finding). */
      fs.rmSync(path.join(dir, IDENTITY_FILE));
      const blind = spawnSync(process.execPath, [path.join(__dirname, "gamesDoctor.js"), "wallet-grants", e.table.gameId, "--data", dir, "--json"], { encoding: "utf8" });
      assert.equal(blind.status, 1);
      const blindView = JSON.parse(blind.stdout) as WalletGrantsView;
      assert.ok(blindView.grants.every((grant) => grant.standing === null && grant.context.verdict === "not-evaluated"));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      await e.world.close();
    }
  });

  test("the shared view judges standing exactly as the ledger does (identity + the seat), and refuses a malformed game id", async () => {
    const e = await evidenceWorld();
    try {
      const view = await collectWalletGrants({
        gameId: e.table.gameId,
        source: "file",
        loadLedger: () => e.world.ticketStore.load(e.table.gameId),
        loadIdentity: async () => e.world.identityStore.snapshot(),
        loadRecord: async () => e.world.server.rooms.moneyPort.recordOf(e.table.gameId),
        now: e.world.clock.now,
      });
      const live = (await e.world.ledger.snapshot(e.table.gameId)).grants;
      assert.deepEqual(
        view.grants.map((grant) => [grant.player_id, grant.epoch, grant.standing]).sort(),
        live.map((grant) => [grant.player_id, grant.epoch, grant.standing]).sort(),
        "the view's standing is the server's",
      );
      /* A record that cannot be read: the seat is never presumed -- standing not evaluated. */
      const noRecord = await collectWalletGrants({ gameId: e.table.gameId, source: "file", loadLedger: () => e.world.ticketStore.load(e.table.gameId), loadIdentity: async () => e.world.identityStore.snapshot(), loadRecord: async () => { throw new Error("disk"); }, now: 0 });
      assert.equal(noRecord.record.read, false);
      assert.ok(noRecord.grants.every((grant) => grant.standing === null && grant.seat_held === null));
      await assert.rejects(collectWalletGrants({ gameId: "../etc", source: "file", loadLedger: async () => ({ version: 0, document: { frozen_at: null, grants: [] } }), loadIdentity: async () => null, loadRecord: async () => null, now: 0 }), /not a game id/);
    } finally {
      await e.world.close();
    }
  });
});

describe("JX-3B C-4b: jx3VerifyLink, the offline proof verifier", () => {
  test("a captured link recomputes the canonical text, challenge_digest, sign doc, wallet, signature and proof_hash -- and agrees with the server's record", async () => {
    const e = await evidenceWorld();
    try {
      const { document } = await e.world.ticketStore.load(e.table.gameId);
      const view = await collectWalletGrants({ gameId: e.table.gameId, source: "file", loadLedger: () => e.world.ticketStore.load(e.table.gameId), loadIdentity: async () => e.world.identityStore.snapshot(), loadRecord: async () => e.world.server.rooms.moneyPort.recordOf(e.table.gameId), now: e.world.clock.now });
      for (const [name, capture] of [["laptop", e.laptop], ["phone (re-home)", e.phone]] as const) {
        const report = verifyCapturedLink({ challenge: capture.challenge, link: capture.link, grant: view, expect: { site: "https://play.example", network: e.world.chain.chainId, contract: e.world.chain.options.contract, game: e.table.gameId, seat: e.playerId, wallet: e.w1.address } });
        assert.equal(report.verdict, "PASS", `${name}: ${JSON.stringify(report.checks.filter((check) => !check.ok))}`);
        const recorded = document.grants.find((grant) => grant.proof?.challenge_digest === report.recomputed.challenge_digest)!;
        assert.equal(report.recomputed.proof_hash, recorded.proof!.proof_hash);
        assert.equal(report.recomputed.wallet_from_pubkey, e.w1.address);
        assert.match(report.recomputed.sign_doc_sha256 ?? "", /^[0-9a-f]{64}$/);
      }
      /* The single-use challenge holds for a re-home too: the exact captured body again (a lost answer) gets the SAME
         answer and writes nothing; the same nonce with another signature is refused. */
      const grants = document.grants.length;
      const replay = await apiRequest(e.world.port, "/gs/api/money/wallet-link", { cookie: e.phoneCookie, body: e.phone.link });
      assert.equal(replay.status, 200, replay.text);
      assert.deepEqual(replay.body, e.phone.answer.body, "the same answer");
      const reused = await apiRequest(e.world.port, "/gs/api/money/wallet-link", { cookie: e.phoneCookie, body: { ...e.phone.link, signature: e.laptop.link.signature } });
      assert.equal(reused.body?.error, "challenge-used");
      assert.equal((await e.world.ticketStore.load(e.table.gameId)).document.grants.length, grants, "no grant written by either");
    } finally {
      await e.world.close();
    }
  });

  test("each tampering FAILS with its own reason", async () => {
    const e = await evidenceWorld();
    try {
      const { document } = await e.world.ticketStore.load(e.table.gameId);
      const grant = document.grants.find((entry) => entry.player_id === e.playerId && entry.epoch === 2)!;
      const base = { challenge: e.phone.challenge, link: e.phone.link, grant };
      const failed = (over: Partial<typeof base> & { expect?: Record<string, string> }) => {
        const report = verifyCapturedLink({ ...base, ...over });
        assert.equal(report.verdict, "FAIL");
        return report.checks.filter((check) => !check.ok).map((check) => check.name);
      };
      assert.equal(verifyCapturedLink(base).verdict, "PASS");
      const text = e.phone.challenge.text as string;
      /* Another signature (the laptop's, over the laptop's challenge). */
      assert.ok(failed({ link: { ...e.phone.link, signature: e.laptop.link.signature } }).includes("signature"));
      /* One character of the text changed: no longer canonical (or no longer the text signed). */
      assert.ok(failed({ challenge: { ...e.phone.challenge, text: `${text}\n` } }).includes("challenge-canonical"), "a trailing newline is not the canonical text");
      assert.ok(failed({ challenge: { ...e.phone.challenge, text: text.replace(/^Nonce: ([0-9a-f]{32})$/m, (_m, n: string) => `Nonce: ${n.toUpperCase()}`) } }).includes("challenge-canonical"));
      assert.ok(failed({ challenge: { ...e.phone.challenge, text: text.replace("Seat: p-", "Seat: q-") } }).includes("signature"), "another seat is not the text the wallet signed");
      const otherSite = text.replace(/^Site: .*$/m, "Site: https://evil.example");
      assert.ok(failed({ challenge: { ...e.phone.challenge, text: otherSite } }).includes("signature"), "a re-written site breaks the signature");
      /* The link answers another nonce. */
      assert.ok(failed({ link: { ...e.phone.link, nonce: "f".repeat(32) } }).includes("nonce-link"));
      /* Another wallet's key. */
      const other = testWallet("mallory");
      const forged = other.signArbitrary(text, e.w1.address);
      assert.deepEqual(failed({ link: { ...e.phone.link, pubKey: forged.pubKey, signature: forged.signature } }).filter((name) => name === "wallet-from-pubkey" || name === "signature"), ["wallet-from-pubkey", "signature"]);
      /* An expectation the capture does not meet. */
      assert.deepEqual(failed({ expect: { site: "https://other.example" } }), ["expect-site"]);
      /* The server's record disagrees. */
      assert.ok(failed({ grant: { ...grant, proof: { ...grant.proof!, proof_hash: "0".repeat(64) } } }).includes("grant-proof_hash"));
      assert.ok(failed({ grant: { ...grant, proof: { ...grant.proof!, challenge_digest: "0".repeat(64) } } }).includes("grant-challenge_digest"));
      assert.ok(failed({ grant: { format: "x", grants: [] } as never }).includes("grant-found"), "a wallet-grants view with no grant of this digest");
      /* A malformed consent key, an extra body field, a missing field. */
      assert.ok(failed({ link: { ...e.phone.link, consentKey: "04" + "a".repeat(64) } }).includes("consent-key-form"));
      assert.ok(failed({ link: { ...e.phone.link, playerId: "p-0000000000000009" } }).includes("link-closed-body"));
      assert.deepEqual(failed({ link: { gameId: e.table.gameId } }), ["link-shape"]);
    } finally {
      await e.world.close();
    }
  });

  test("the CLI reads only the files it is given and opens no network connection; PASS exits 0, FAIL 1, usage 2", async () => {
    const e = await evidenceWorld();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jx3b-verify-"));
    const originals = { connect: net.Socket.prototype.connect, request: http.request, get: http.get, srequest: https.request, sget: https.get, lookup: dns.lookup, fetch: globalThis.fetch };
    const attempts: string[] = [];
    const refuse = (what: string) =>
      function refused(): never {
        attempts.push(what);
        throw new Error(`jx3VerifyLink must not use the network (${what})`);
      };
    try {
      const { document } = await e.world.ticketStore.load(e.table.gameId);
      fs.writeFileSync(path.join(dir, "challenge.json"), JSON.stringify(e.phone.challenge));
      fs.writeFileSync(path.join(dir, "link.json"), JSON.stringify(e.phone.link));
      fs.writeFileSync(path.join(dir, "grant.json"), JSON.stringify(document.grants.find((grant) => grant.player_id === e.playerId && grant.epoch === 2)));
      fs.writeFileSync(path.join(dir, "bad-link.json"), JSON.stringify({ ...e.phone.link, signature: e.laptop.link.signature }));
      net.Socket.prototype.connect = refuse("net.connect") as never;
      (http as { request: unknown }).request = refuse("http.request");
      (http as { get: unknown }).get = refuse("http.get");
      (https as { request: unknown }).request = refuse("https.request");
      (https as { get: unknown }).get = refuse("https.get");
      (dns as { lookup: unknown }).lookup = refuse("dns.lookup");
      globalThis.fetch = refuse("fetch") as never;
      const out: string[] = [];
      const io = { out: (line: string) => out.push(line), err: (line: string) => out.push(line) };
      const at = (name: string) => path.join(dir, name);
      assert.equal(await runJx3VerifyLink(["--challenge", at("challenge.json"), "--link", at("link.json"), "--grant", at("grant.json"), "--expect-wallet", e.w1.address], io), 0, out.join("\n"));
      assert.match(out[0], /^jx3VerifyLink: PASS/);
      assert.ok(out.some((line) => line.includes("proof_hash")));
      out.length = 0;
      assert.equal(await runJx3VerifyLink(["--challenge", at("challenge.json"), "--link", at("bad-link.json"), "--json"], io), 1);
      assert.equal(JSON.parse(out.join("\n")).verdict, "FAIL");
      assert.equal(await runJx3VerifyLink(["--challenge", at("challenge.json")], io), 2, "the link is required");
      assert.equal(await runJx3VerifyLink(["--challenge", at("challenge.json"), "--link", at("link.json"), "--fetch"], io), 2, "unknown options refused");
      assert.equal(await runJx3VerifyLink(["--challenge", at("missing.json"), "--link", at("link.json")], io), 2);
      assert.deepEqual(attempts, [], "no network was attempted");
    } finally {
      await e.world.close().catch(() => undefined);
      net.Socket.prototype.connect = originals.connect;
      (http as { request: unknown }).request = originals.request;
      (http as { get: unknown }).get = originals.get;
      (https as { request: unknown }).request = originals.srequest;
      (https as { get: unknown }).get = originals.sget;
      (dns as { lookup: unknown }).lookup = originals.lookup;
      globalThis.fetch = originals.fetch;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
