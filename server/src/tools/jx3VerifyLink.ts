// server/src/tools/jx3VerifyLink.ts
//
// ==================================================================
//  JX-3B (C-4b): THE OFFLINE JX-3 WALLET-LINK VERIFIER -- RECOMPUTE A CAPTURED ADR-036 LINK, NO NETWORK
// ==================================================================
//
//   node dist/server/src/tools/jx3VerifyLink.js --challenge <file> --link <file> [--grant <file>] [--json]
//        [--expect-site <origin>] [--expect-network <chain id>] [--expect-contract <addr>] [--expect-game <g_...>]
//        [--expect-seat <p-...>] [--expect-wallet <juno1...>]
//
// Input, as captured in the browser's devtools during a live JX-3 run:
//   --challenge  the `POST /gs/api/money/wallet-challenge` RESPONSE body ({ text, nonce, expiresAt });
//   --link       the `POST /gs/api/money/wallet-link` REQUEST body ({ gameId, nonce, pubKey, signature, consentKey[, replace] });
//   --grant      optional: `gamesDoctor [aws] wallet-grants <g> --json` output (the seat's grant is found by its
//                challenge_digest) or one grant row / one proof object -- its recorded proof is compared field by field.
//
// It recomputes, with the server's OWN code (no crypto is re-implemented here):
//   the canonical challenge text      `parseWalletLinkChallenge` (re-serialized, byte-equal, or refused);
//   challenge_digest                  SHA-256 of the exact text;
//   the ADR-036 sign doc              `adr036SignDocJson(wallet, text)` and its SHA-256 (what the wallet signed);
//   the wallet from the public key    bech32("juno", RIPEMD-160(SHA-256(pubkey)));
//   the signature                     `walletProof.verifyAdr036` -- exactly the link route's verification;
//   proof_hash                        the framed SHA-256 the server records on the grant.
//
// and answers PASS or FAIL with specific reasons. It reads the named files and nothing else: no network, no store, no
// clock-dependent verdict (expiry is reported against the capture, not judged against now). Never commit captured user
// data as a fixture: the tests build synthetic captures.

import { createHash } from "crypto";
import { promises as fs } from "fs";

import { adr036SignDocJson, parseWalletLinkChallenge, type WalletLinkChallengeFields } from "../../../frontend/src/gameEngine/escrow/walletLinkChallengeV1";
import { addressOfPublicKey } from "../escrow/juno/cosmosTx";
import { verifyAdr036 } from "../escrow/walletProof";

export const JX3_VERIFY_FORMAT = "18COSMOS/JX3B/VERIFY-LINK/v1";

export interface Jx3Expectations {
  readonly site?: string;
  readonly network?: string;
  readonly contract?: string;
  readonly game?: string;
  readonly seat?: string;
  readonly wallet?: string;
}

export interface Jx3Check {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface Jx3Report {
  readonly format: typeof JX3_VERIFY_FORMAT;
  readonly verdict: "PASS" | "FAIL";
  readonly checks: readonly Jx3Check[];
  /** What was recomputed (present as far as the inputs allowed). */
  readonly recomputed: {
    readonly fields: Omit<WalletLinkChallengeFields, "expiresAt"> & { readonly expiresAt: string } | null;
    readonly challenge_digest: string | null;
    readonly sign_doc_sha256: string | null;
    readonly pubkey_hex: string | null;
    readonly wallet_from_pubkey: string | null;
    readonly proof_hash: string | null;
  };
}

const sha256Hex = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const LINK_FIELDS = new Set(["gameId", "nonce", "pubKey", "signature", "consentKey", "replace"]);

/** The recorded proof inside whatever `--grant` holds: a wallet-grants view (matched by digest), a row, or a proof. */
function recordedProofOf(grant: unknown, digest: string | null): Record<string, unknown> | null {
  if (!isRecord(grant)) return null;
  if (Array.isArray(grant.grants)) {
    const rows = (grant.grants as unknown[]).filter(isRecord).filter((row) => isRecord(row.proof) && row.proof.challenge_digest === digest);
    return rows.length === 1 ? (rows[0].proof as Record<string, unknown>) : null;
  }
  if (isRecord(grant.proof)) return grant.proof;
  if (typeof grant.challenge_digest === "string") return grant;
  return null;
}

/** Recompute and check one captured link. Pure: no I/O. */
export function verifyCapturedLink(input: { readonly challenge: unknown; readonly link: unknown; readonly grant?: unknown; readonly expect?: Jx3Expectations }): Jx3Report {
  const checks: Jx3Check[] = [];
  const check = (name: string, ok: boolean, detail: string): boolean => {
    checks.push({ name, ok, detail });
    return ok;
  };
  const recomputed: { -readonly [K in keyof Jx3Report["recomputed"]]: Jx3Report["recomputed"][K] } = { fields: null, challenge_digest: null, sign_doc_sha256: null, pubkey_hex: null, wallet_from_pubkey: null, proof_hash: null };
  const finish = (): Jx3Report => ({ format: JX3_VERIFY_FORMAT, verdict: checks.every((entry) => entry.ok) ? "PASS" : "FAIL", checks, recomputed });

  /* 1. The shapes. */
  const challenge = input.challenge;
  const link = input.link;
  const challengeShaped = isRecord(challenge) && typeof challenge.text === "string" && typeof challenge.nonce === "string" && typeof challenge.expiresAt === "number";
  if (!check("challenge-shape", challengeShaped, challengeShaped ? "the wallet-challenge response has { text, nonce, expiresAt }" : "the wallet-challenge response must be { text, nonce, expiresAt }")) return finish();
  const linkShaped = isRecord(link) && typeof link.gameId === "string" && typeof link.nonce === "string" && typeof link.pubKey === "string" && typeof link.signature === "string" && typeof link.consentKey === "string";
  if (!check("link-shape", linkShaped, linkShaped ? "the wallet-link request has gameId, nonce, pubKey, signature, consentKey" : "the wallet-link request must carry gameId, nonce, pubKey, signature, consentKey")) return finish();
  const c = challenge as { text: string; nonce: string; expiresAt: number };
  const l = link as Record<string, unknown> & { gameId: string; nonce: string; pubKey: string; signature: string; consentKey: string };
  const extra = Object.keys(l).filter((key) => !LINK_FIELDS.has(key));
  check("link-closed-body", extra.length === 0, extra.length === 0 ? "only the fields the route accepts" : `fields the route refuses (closed body): ${extra.join(", ")}`);

  /* 2. The canonical text. */
  const fields = parseWalletLinkChallenge(c.text);
  if (!check("challenge-canonical", fields !== null, fields !== null ? "the text parses and re-serializes byte for byte (18COSMOS/WALLET-LINK/v1)" : "the text is not a canonical 18COSMOS/WALLET-LINK/v1 challenge")) return finish();
  const f = fields as WalletLinkChallengeFields;
  recomputed.fields = { ...f, expiresAt: new Date(f.expiresAt).toISOString() };
  recomputed.challenge_digest = sha256Hex(Buffer.from(c.text, "utf8"));
  check("nonce-response", c.nonce === f.nonce, c.nonce === f.nonce ? "the response's nonce is the text's" : `the response's nonce ${c.nonce} is not the text's ${f.nonce}`);
  check("nonce-link", l.nonce === f.nonce, l.nonce === f.nonce ? "the link answers this challenge's nonce" : `the link answers nonce ${l.nonce}, not ${f.nonce}`);
  check("expiry-response", c.expiresAt === f.expiresAt, c.expiresAt === f.expiresAt ? `expires ${recomputed.fields.expiresAt}` : `the response's expiresAt ${c.expiresAt} is not the text's ${f.expiresAt}`);
  check("game", l.gameId === f.gameId, l.gameId === f.gameId ? `game ${f.gameId}` : `the link names game ${l.gameId}, the text ${f.gameId}`);
  const expect = input.expect ?? {};
  const expectations: Array<[keyof Jx3Expectations, string]> = [["site", f.site], ["network", f.chainId], ["contract", f.contract], ["game", f.gameId], ["seat", f.playerId], ["wallet", f.wallet]];
  for (const [name, actual] of expectations) {
    const wanted = expect[name];
    if (wanted !== undefined) check(`expect-${name}`, wanted === actual, wanted === actual ? `${name} is ${actual}` : `${name} is ${actual}, expected ${wanted}`);
  }

  /* 3. The sign doc the wallet signed. */
  recomputed.sign_doc_sha256 = sha256Hex(Buffer.from(adr036SignDocJson(f.wallet, c.text), "utf8"));

  /* 4. The key and the address it controls. */
  const pubkey = /^[A-Za-z0-9+/]{44}$/.test(l.pubKey) ? Buffer.from(l.pubKey, "base64") : Buffer.alloc(0);
  if (check("pubkey-form", pubkey.length === 33 && (pubkey[0] === 2 || pubkey[0] === 3), pubkey.length === 33 ? "a 33-byte compressed secp256k1 key" : "pubKey is not 44 base64 characters of a 33-byte compressed key")) {
    recomputed.pubkey_hex = pubkey.toString("hex");
    try {
      recomputed.wallet_from_pubkey = addressOfPublicKey(pubkey, "juno");
    } catch {
      recomputed.wallet_from_pubkey = null;
    }
    check("wallet-from-pubkey", recomputed.wallet_from_pubkey === f.wallet, recomputed.wallet_from_pubkey === f.wallet ? `the key controls ${f.wallet}` : `the key controls ${recomputed.wallet_from_pubkey ?? "no juno address"}, not the challenge's ${f.wallet}`);
  }

  /* 5. The signature, by the link route's own verifier. */
  const verdict = verifyAdr036({ wallet: f.wallet, text: c.text, pubKeyBase64: l.pubKey, signatureBase64: l.signature, now: 0 });
  const why: Record<string, string> = { "bad-key": "the public key is malformed", "bad-signature": "the signature does not verify over the ADR-036 sign doc of this text", "wrong-wallet": "the key is another wallet's" };
  check("signature", verdict.ok, verdict.ok ? "the ADR-036 signature verifies (secp256k1 over SHA-256 of the sign doc)" : why[verdict.why]);
  if (verdict.ok) {
    recomputed.proof_hash = verdict.proof.proof_hash;
    check("challenge-digest-agrees", verdict.proof.challenge_digest === recomputed.challenge_digest, "the verifier's digest is the text's");
  }

  /* 6. The consent key the link registers. */
  check("consent-key-form", /^0[23][0-9a-f]{64}$/.test(l.consentKey), /^0[23][0-9a-f]{64}$/.test(l.consentKey) ? "a 33-byte compressed key (hex)" : "consentKey is not 66 lowercase hex characters of a compressed key");

  /* 7. The server's record, when given. */
  if (input.grant !== undefined) {
    const recorded = recordedProofOf(input.grant, recomputed.challenge_digest);
    if (check("grant-found", recorded !== null, recorded !== null ? "the recorded proof was found" : "no single recorded proof with this challenge_digest in --grant")) {
      const r = recorded as Record<string, unknown>;
      const pairs: Array<[string, unknown, string | null]> = [
        ["kind", r.kind, "adr036"],
        ["wallet", r.wallet, f.wallet],
        ["pubkey", r.pubkey, recomputed.pubkey_hex],
        ["challenge_digest", r.challenge_digest, recomputed.challenge_digest],
        ["proof_hash", r.proof_hash, recomputed.proof_hash],
      ];
      for (const [name, got, want] of pairs) check(`grant-${name}`, want !== null && got === want, want !== null && got === want ? `${name} matches the server's record` : `${name}: recorded ${JSON.stringify(got)}, recomputed ${JSON.stringify(want)}`);
      if (typeof r.verified_at === "number") check("grant-verified-before-expiry", r.verified_at <= f.expiresAt, r.verified_at <= f.expiresAt ? `verified ${new Date(r.verified_at).toISOString()}, before the challenge expired` : `verified ${new Date(r.verified_at).toISOString()}, AFTER the challenge expired`);
    }
  }
  return finish();
}

export function jx3ReportText(report: Jx3Report): string[] {
  const out = [`jx3VerifyLink: ${report.verdict}`];
  for (const entry of report.checks) out.push(`  ${entry.ok ? "ok  " : "FAIL"} ${entry.name.padEnd(30)} ${entry.detail}`);
  const r = report.recomputed;
  if (r.fields !== null) out.push(`  text: site ${r.fields.site}, network ${r.fields.chainId}, contract ${r.fields.contract}, game ${r.fields.gameId}, seat ${r.fields.playerId}, wallet ${r.fields.wallet}, expires ${r.fields.expiresAt}`);
  if (r.challenge_digest !== null) out.push(`  challenge_digest  ${r.challenge_digest}`);
  if (r.sign_doc_sha256 !== null) out.push(`  sign_doc_sha256   ${r.sign_doc_sha256}`);
  if (r.pubkey_hex !== null) out.push(`  pubkey            ${r.pubkey_hex}`);
  if (r.wallet_from_pubkey !== null) out.push(`  wallet_from_key   ${r.wallet_from_pubkey}`);
  if (r.proof_hash !== null) out.push(`  proof_hash        ${r.proof_hash}`);
  return out;
}

const USAGE = [
  "usage: jx3VerifyLink --challenge <wallet-challenge response.json> --link <wallet-link request.json> [--grant <wallet-grants.json>] [--json]",
  "         [--expect-site <origin>] [--expect-network <chain id>] [--expect-contract <addr>] [--expect-game <g_...>] [--expect-seat <p-...>] [--expect-wallet <juno1...>]",
  "  offline: reads only the files named; PASS exits 0, FAIL 1, a usage or unreadable file 2",
].join("\n");

export async function runJx3VerifyLink(argv: readonly string[], io: { out(line: string): void; err(line: string): void }, readFile: (file: string) => Promise<string> = (file) => fs.readFile(file, "utf8")): Promise<number> {
  const value = (flag: string): string | undefined => {
    const at = argv.indexOf(flag);
    return at !== -1 && argv[at + 1] !== undefined && !argv[at + 1].startsWith("--") ? argv[at + 1] : undefined;
  };
  const known = new Set(["--challenge", "--link", "--grant", "--json", "--expect-site", "--expect-network", "--expect-contract", "--expect-game", "--expect-seat", "--expect-wallet"]);
  const unknown = argv.filter((arg) => arg.startsWith("--") && !known.has(arg));
  const challengeFile = value("--challenge");
  const linkFile = value("--link");
  if (unknown.length > 0 || challengeFile === undefined || linkFile === undefined) {
    io.err(`${unknown.length > 0 ? `unknown option ${unknown.join(", ")}\n` : ""}${USAGE}`);
    return 2;
  }
  const readJson = async (file: string): Promise<unknown> => JSON.parse(await readFile(file));
  let challenge: unknown;
  let link: unknown;
  let grant: unknown;
  try {
    challenge = await readJson(challengeFile);
    link = await readJson(linkFile);
    const grantFile = value("--grant");
    if (grantFile !== undefined) grant = await readJson(grantFile);
  } catch (error) {
    io.err(`jx3VerifyLink: an input could not be read as JSON (${error instanceof Error ? error.message : String(error)})`);
    return 2;
  }
  const expect: Jx3Expectations = {
    ...(value("--expect-site") !== undefined ? { site: value("--expect-site") } : {}),
    ...(value("--expect-network") !== undefined ? { network: value("--expect-network") } : {}),
    ...(value("--expect-contract") !== undefined ? { contract: value("--expect-contract") } : {}),
    ...(value("--expect-game") !== undefined ? { game: value("--expect-game") } : {}),
    ...(value("--expect-seat") !== undefined ? { seat: value("--expect-seat") } : {}),
    ...(value("--expect-wallet") !== undefined ? { wallet: value("--expect-wallet") } : {}),
  };
  const report = verifyCapturedLink({ challenge, link, ...(grant !== undefined ? { grant } : {}), expect });
  if (argv.includes("--json")) io.out(JSON.stringify(report, null, 2));
  else for (const line of jx3ReportText(report)) io.out(line);
  return report.verdict === "PASS" ? 0 : 1;
}

if (require.main === module) {
  runJx3VerifyLink(process.argv.slice(2), { out: (line) => console.log(line), err: (line) => console.error(line) }).then(
    (code) => process.exit(code),
    (error) => {
      console.error("jx3VerifyLink failed:", error);
      process.exit(2);
    },
  );
}
