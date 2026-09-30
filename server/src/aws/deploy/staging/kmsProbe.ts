// server/src/aws/deploy/staging/kmsProbe.ts
//
// ==================================================================
//  LIVE-6 L6-6 §8: KMS SIGN LATENCY -- THE REAL KEYS, THE REAL SIGNER, A DISPOSABLE DIGEST, NO CHAIN, NO LEDGER
// ==================================================================
//
// Through the production binding exactly as a task uses it -- `kmsDigestClient` (the key ARN, the region, the spec /
// usage / algorithm checked on every answer) under `openKmsDigestSigner` (DER -> r||s, low-s, verify-before-use) --
// for EACH of the configuration's three keys (relayer, settlement, admission):
//
//   1. GetPublicKey, and the three public keys checked against the configuration by the backend's own
//      `checkSignerIdentities` (the relayer key controls the relayer address; the settlement and admission keys are the
//      configured public keys);
//   2. `samples` Signs of an exact 32-byte DISPOSABLE digest, each timed end to end (the KMS call plus the signer's own
//      verification), each signature verified AGAIN here against the CONFIGURED public key;
//   3. every sample must finish below the bound: `KMS_CALL_POLICY.requestTimeoutMs` (3 s, preflight §11.2) -- the
//      bound the runtime itself enforces on a Sign.
//
// THE DIGEST IS NEVER CHOSEN BY ANYONE: SHA-256("18COSMOS/L6-6/KMS-LATENCY-PROBE/v1" || run || purpose || sample ||
// 32 random bytes), made here. It cannot be a settlement payload, an admission, or a Cosmos sign-doc hash (those are
// domain-separated preimages this string never is), so the signatures authorise nothing -- and they are not kept: the
// record holds latencies, verified booleans and lengths. No transaction is built, no relayer sequence is read or used,
// the signing ledger (journal) is not touched, no chain endpoint is called. Keys are named in the record by purpose and
// a 12-hex fingerprint, never by ARN.

import { createHash, randomBytes } from "crypto";

import { KMS_CALL_POLICY } from "../../awsClients";
import { checkSignerIdentities, settlementKeyConfigOf, type JunoBackendConfig } from "../../../escrow/juno/junoConfig";
import { verifyDigest } from "../../../escrow/juno/secp256k1";
import { openKmsDigestSigner, type KmsClient } from "../../../escrow/juno/signer";
import type { Check } from "../deployVerify";
import { arr, fingerprint, judge, num, obj, str } from "./evidence";

export const KMS_PROBE_DOMAIN = "18COSMOS/L6-6/KMS-LATENCY-PROBE/v1";
/** The bound: the runtime's own per-call Sign bound (3 000 ms). A sample at or above it fails. */
export const KMS_LATENCY_BOUND_MS = KMS_CALL_POLICY.requestTimeoutMs;

export type KmsPurpose = "relayer" | "settlement" | "admission";
const PURPOSES: readonly KmsPurpose[] = ["relayer", "settlement", "admission"];

/** The disposable digest (see the header): 32 bytes nobody chose. */
export function probeDigest(run: string, purpose: KmsPurpose, sample: number, entropy: Uint8Array = randomBytes(32)): Buffer {
  return createHash("sha256").update(`${KMS_PROBE_DOMAIN}\u0000${run}\u0000${purpose}\u0000${sample}\u0000`, "utf8").update(entropy).digest();
}

export interface KmsProbeDeps {
  readonly kms: KmsClient;
  /** A monotonic clock in milliseconds (`performance.now`). */
  readonly clock: () => number;
}

const errorText = (error: unknown): string => `${(error as { name?: string; code?: string } | null)?.name ?? "Error"}${(error as { code?: string }).code !== undefined ? `/${(error as { code?: string }).code}` : ""}: ${(error instanceof Error ? error.message : String(error)).replace(/arn:aws[a-z-]*:kms:[^\s,;)]+/g, "<key>").slice(0, 200)}`;

export async function runKmsProbe(config: JunoBackendConfig, deps: KmsProbeDeps, options: { readonly run: string; readonly samples: number }): Promise<Record<string, unknown>> {
  const refs: Record<KmsPurpose, { kind: string; key_ref?: string }> = {
    relayer: config.relayer.signer as { kind: string; key_ref?: string },
    settlement: config.settlementKey.signer as { kind: string; key_ref?: string },
    admission: config.admissionKey.signer as { kind: string; key_ref?: string },
  };
  const keys: Record<string, unknown> = {};
  const publicKeys = new Map<KmsPurpose, Buffer>();
  const signers = new Map<KmsPurpose, Awaited<ReturnType<typeof openKmsDigestSigner>>>();
  for (const purpose of PURPOSES) {
    const ref = refs[purpose];
    if (ref.kind !== "kms" || typeof ref.key_ref !== "string") {
      keys[purpose] = { opened: false, error: `a ${ref.kind} signer (AWS storage signs only with KMS keys)` };
      continue;
    }
    try {
      const signer = await openKmsDigestSigner(deps.kms, ref.key_ref);
      signers.set(purpose, signer);
      publicKeys.set(purpose, signer.publicKey);
      keys[purpose] = { opened: true, key: fingerprint(ref.key_ref) };
    } catch (error) {
      keys[purpose] = { opened: false, key: fingerprint(ref.key_ref), error: errorText(error) };
    }
  }
  let identities: { ok: boolean; detail: string };
  const relayer = publicKeys.get("relayer");
  const settlement = publicKeys.get("settlement");
  const admission = publicKeys.get("admission");
  if (relayer === undefined || settlement === undefined || admission === undefined || config.settlementKey.signer.kind !== "kms") identities = { ok: false, detail: "not every key could be opened" };
  else {
    try {
      checkSignerIdentities(config, relayer, settlement, settlementKeyConfigOf(config, config.settlementKey.signer.key_ref), admission);
      identities = { ok: true, detail: "the relayer key controls the configured address; the settlement and admission keys are the configured public keys" };
    } catch (error) {
      identities = { ok: false, detail: errorText(error) };
    }
  }
  /* The configured public keys (hex) the signatures are verified against AGAIN: the configuration's, not KMS's word. */
  const configured: Partial<Record<KmsPurpose, Buffer>> = identities.ok ? { relayer, settlement: Buffer.from(config.settlementKey.publicKeyHex, "hex"), admission: Buffer.from(config.admissionKey.publicKeyHex, "hex") } : {};
  for (const purpose of PURPOSES) {
    const signer = signers.get(purpose);
    const entry = obj(keys[purpose]) as Record<string, unknown>;
    if (signer === undefined) continue;
    const samples: Array<{ ms: number; verified: boolean; signature_bytes: number | null; error?: string }> = [];
    for (let i = 0; i < options.samples; i += 1) {
      const digest = probeDigest(options.run, purpose, i);
      const started = deps.clock();
      try {
        const signature = await signer.sign(digest);
        const ms = Math.ceil(deps.clock() - started);
        const against = configured[purpose];
        samples.push({ ms, verified: against !== undefined && signature.length === 64 && verifyDigest(against, digest, signature), signature_bytes: signature.length });
      } catch (error) {
        samples.push({ ms: Math.ceil(deps.clock() - started), verified: false, signature_bytes: null, error: errorText(error) });
      }
    }
    entry.samples = samples;
    keys[purpose] = entry;
  }
  return { bound_ms: KMS_LATENCY_BOUND_MS, samples_per_key: options.samples, identities, keys };
}

/** The certification's judgement: the three keys opened, identities checked, every sample verified and below the bound. */
export function judgeKmsProbe(section: unknown): Check[] {
  const s = obj(section);
  if (s.status === "not-run") return [judge("KMS", false, "", `not run (${String(s.reason ?? "no escrow configuration")}): the KMS latency gate is required`)];
  const r = obj(s.results);
  const bound = KMS_LATENCY_BOUND_MS;
  const checks: Check[] = [];
  checks.push(judge("KMS: the recorded bound is the runtime's", r.bound_ms === bound, `${bound} ms`, `the record's bound is ${String(r.bound_ms)} ms, not ${bound} ms`));
  const identities = obj(r.identities);
  checks.push(judge("KMS: public keys = the configuration's", identities.ok === true, String(identities.detail), String(identities.detail ?? "not checked")));
  const wanted = num(r.samples_per_key) ?? 0;
  for (const purpose of PURPOSES) {
    const k = obj(obj(r.keys)[purpose]);
    if (k.opened !== true) {
      checks.push(judge(`KMS ${purpose}`, false, "", `the key did not open: ${String(k.error ?? "not in the record")}`));
      continue;
    }
    const samples = arr(k.samples).map(obj);
    const times = samples.map((x) => num(x.ms));
    const worst = Math.max(...times.map((t) => (t === null ? Number.POSITIVE_INFINITY : t)));
    const failed = samples.filter((x) => x.verified !== true);
    checks.push(
      judge(
        `KMS ${purpose} (${str(k.key) ?? "?"}): Sign verified`,
        samples.length >= 1 && samples.length === wanted && failed.length === 0,
        `${samples.length} signature(s) over disposable digests, each verified against the configured public key`,
        samples.length === 0 ? "no sample" : `${failed.length} of ${samples.length} not verified (${failed.map((x) => String(x.error ?? "the signature does not verify")).join("; ")})`,
      ),
    );
    const sorted = [...times].filter((t): t is number => t !== null).sort((a, b) => a - b);
    const p50 = sorted.length === 0 ? null : sorted[Math.floor((sorted.length - 1) / 2)];
    checks.push(
      judge(
        `KMS ${purpose}: Sign latency below ${bound} ms`,
        samples.length >= 1 && Number.isFinite(worst) && worst < bound,
        `max ${worst} ms, p50 ${String(p50)} ms over ${samples.length}`,
        `max ${Number.isFinite(worst) ? `${worst} ms` : "unmeasured"} (bound ${bound} ms, exclusive)`,
      ),
    );
  }
  return checks;
}
