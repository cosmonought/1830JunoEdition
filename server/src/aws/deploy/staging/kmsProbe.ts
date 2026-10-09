// server/src/aws/deploy/staging/kmsProbe.ts
//
// ==================================================================
//  LIVE-6 L6-6 §8: KMS SIGN LATENCY -- THE REAL KEYS, THE REAL SIGNER, A DISPOSABLE DIGEST, NO CHAIN, NO LEDGER
// ==================================================================
//
// Through the production binding exactly as a task uses it -- `kmsDigestClient` (the key ARN, the region, the spec /
// usage / algorithm checked on every answer) under `openKmsDigestSigner` (DER -> r||s, low-s, verify-before-use) --
// for EACH of the configuration's signing keys: the three original purposes (relayer, settlement, admission) and -- Phase
// 3 escrow 2.1 -- the dedicated REMEDY key WHENEVER the configuration names one (a first-class fourth purpose):
//
//   1. GetPublicKey, and the public keys checked against the configuration by the backend's own
//      `checkSignerIdentities` (the relayer key controls the relayer address; the settlement, admission and -- when
//      configured -- remedy keys are the configured public keys, the remedy key distinct from the other three);
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
//
// THE REMEDY KEY (Phase 3 escrow 2.1). The record says whether the configuration names one (`remedy_configured`, always
// written) and lists the purposes probed. Absent: the three keys exactly as before -- timed-money release is then
// intentionally unavailable (the backend signs no remedy: fail closed). Configured: the remedy key is opened, its public
// key checked, its Signs verified against the CONFIGURED remedy public key and timed, exactly as the other three. A remedy
// key that is not KMS, names the same KMS key as another purpose, will not open, or answers the wrong public key FAILS
// the probe, and the failure names REMEDY. The judge requires the coverage field: a record that does not say whether a
// remedy key was configured (an older image) is not evidence, and a configured remedy key with no remedy entry -- or a
// remedy entry nobody configured -- fails. The certification also holds the record to the verified configuration's own
// remedy key (`expected`), so a probe cannot skip REMEDY by misreporting the configuration.

import { createHash, randomBytes } from "crypto";

import { KMS_CALL_POLICY } from "../../awsClients";
import { addressOfPublicKey } from "../../../escrow/juno/cosmosTx";
import { checkSignerIdentities, settlementKeyConfigOf, type JunoBackendConfig } from "../../../escrow/juno/junoConfig";
import { verifyDigest } from "../../../escrow/juno/secp256k1";
import { openKmsDigestSigner, type KmsClient } from "../../../escrow/juno/signer";
import type { Check } from "../deployVerify";
import { arr, fingerprint, judge, num, obj, str } from "./evidence";

export const KMS_PROBE_DOMAIN = "18COSMOS/L6-6/KMS-LATENCY-PROBE/v1";
/** The bound: the runtime's own per-call Sign bound (3 000 ms). A sample at or above it fails. */
export const KMS_LATENCY_BOUND_MS = KMS_CALL_POLICY.requestTimeoutMs;

export type KmsPurpose = "relayer" | "settlement" | "admission" | "remedy";
/** The three original purposes, probed for every escrow configuration. */
export const BASE_KMS_PURPOSES: readonly KmsPurpose[] = Object.freeze(["relayer", "settlement", "admission"] as const);
/** The purposes a configuration's probe covers: the three, plus REMEDY exactly when the configuration names a remedy key. */
export const kmsPurposesOf = (config: Pick<JunoBackendConfig, "remedyKey">): readonly KmsPurpose[] => (config.remedyKey !== null ? [...BASE_KMS_PURPOSES, "remedy"] : BASE_KMS_PURPOSES);

/** What the certification knows independently of the record: the verified configuration's remedy key (its fingerprint),
 *  or null when the configuration names none. Omitted (the offline host-role judge): the record's own coverage field
 *  decides, and is still required. */
export interface KmsProbeExpectation {
  readonly remedy: { readonly key: string | null } | null;
}
/** The expectation from a verified configuration: its remedy key's fingerprint (null if it is not a KMS key), or none. */
export function kmsProbeExpectationOf(config: Pick<JunoBackendConfig, "remedyKey">): KmsProbeExpectation {
  const remedy = config.remedyKey;
  if (remedy === null) return { remedy: null };
  return { remedy: { key: remedy.signer.kind === "kms" ? fingerprint(remedy.signer.key_ref) : null } };
}

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
  const purposes = kmsPurposesOf(config);
  const refs: Partial<Record<KmsPurpose, { kind: string; key_ref?: string }>> = {
    relayer: config.relayer.signer as { kind: string; key_ref?: string },
    settlement: config.settlementKey.signer as { kind: string; key_ref?: string },
    admission: config.admissionKey.signer as { kind: string; key_ref?: string },
    ...(config.remedyKey !== null ? { remedy: config.remedyKey.signer as { kind: string; key_ref?: string } } : {}),
  };
  const keys: Record<string, unknown> = {};
  const publicKeys = new Map<KmsPurpose, Buffer>();
  const signers = new Map<KmsPurpose, Awaited<ReturnType<typeof openKmsDigestSigner>>>();
  for (const purpose of purposes) {
    const ref = refs[purpose] as { kind: string; key_ref?: string };
    if (ref.kind !== "kms" || typeof ref.key_ref !== "string") {
      keys[purpose] = { opened: false, error: `the ${purpose} key is a ${ref.kind} signer (AWS storage signs only with KMS keys)` };
      continue;
    }
    /* The REMEDY key is never another purpose's key: the configuration refuses that, and the probe refuses it again rather
       than sign "for REMEDY" with the relayer, settlement or admission key. */
    if (purpose === "remedy") {
      const same = BASE_KMS_PURPOSES.filter((other) => refs[other]?.kind === "kms" && refs[other]?.key_ref === ref.key_ref);
      if (same.length > 0) {
        keys[purpose] = { opened: false, key: fingerprint(ref.key_ref), error: `the remedy key names the same KMS key as the ${same.join(" and ")} key (never substituted for REMEDY)` };
        continue;
      }
    }
    try {
      const signer = await openKmsDigestSigner(deps.kms, ref.key_ref);
      signers.set(purpose, signer);
      publicKeys.set(purpose, signer.publicKey);
      keys[purpose] = { opened: true, key: fingerprint(ref.key_ref) };
    } catch (error) {
      keys[purpose] = { opened: false, key: fingerprint(ref.key_ref), error: `the ${purpose} key: ${errorText(error)}` };
    }
  }
  let identities: { ok: boolean; detail: string };
  const relayer = publicKeys.get("relayer");
  const settlement = publicKeys.get("settlement");
  const admission = publicKeys.get("admission");
  /* null: no remedy key is configured (none was opened); undefined: one is configured and did not open. */
  const remedy = config.remedyKey === null ? null : publicKeys.get("remedy");
  const unopened = purposes.filter((purpose) => !publicKeys.has(purpose));
  if (relayer === undefined || settlement === undefined || admission === undefined || remedy === undefined || config.settlementKey.signer.kind !== "kms") identities = { ok: false, detail: unopened.length > 0 ? `not every key could be opened (${unopened.join(", ")})` : "the settlement key is not a KMS key" };
  else {
    try {
      checkSignerIdentities(config, relayer, settlement, settlementKeyConfigOf(config, config.settlementKey.signer.key_ref), admission, remedy);
      identities = {
        ok: true,
        detail: `the relayer key controls the configured address; the settlement and admission keys are the configured public keys${remedy === null ? "" : "; the dedicated remedy key is the configured remedy public key"}`,
      };
    } catch (error) {
      identities = { ok: false, detail: errorText(error) };
    }
  }
  /* The configured public keys (hex) the signatures are verified against AGAIN: the configuration's, not KMS's word. Each
     purpose against ITS OWN configured identity (the settlement, admission and remedy public keys are the configuration's;
     the relayer's is the KMS key only if it controls the configured address), so one key that fails -- a REMEDY key that
     will not open, say -- is blamed alone instead of failing every key's samples; `identities` above still fails the
     probe whenever any key disagrees. */
  const relayerAnchored = relayer !== undefined && addressOfPublicKey(relayer, "juno") === config.relayer.address;
  const configured: Partial<Record<KmsPurpose, Buffer>> = {
    ...(relayerAnchored ? { relayer } : {}),
    settlement: Buffer.from(config.settlementKey.publicKeyHex, "hex"),
    admission: Buffer.from(config.admissionKey.publicKeyHex, "hex"),
    ...(config.remedyKey !== null ? { remedy: Buffer.from(config.remedyKey.publicKeyHex, "hex") } : {}),
  };
  for (const purpose of purposes) {
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
  return { bound_ms: KMS_LATENCY_BOUND_MS, samples_per_key: options.samples, remedy_configured: config.remedyKey !== null, purposes: [...purposes], identities, keys };
}

/** The certification's judgement: every configured key opened (the three, plus REMEDY when configured), identities
 *  checked, every sample verified and below the bound. `expected` (the certification's verified configuration) holds the
 *  record's remedy coverage to the configuration's own; without it the record's required coverage field decides. */
export function judgeKmsProbe(section: unknown, expected?: KmsProbeExpectation): Check[] {
  const s = obj(section);
  if (s.status === "not-run") return [judge("KMS", false, "", `not run (${String(s.reason ?? "no escrow configuration")}): the KMS latency gate is required`)];
  const r = obj(s.results);
  const bound = KMS_LATENCY_BOUND_MS;
  const checks: Check[] = [];
  checks.push(judge("KMS: the recorded bound is the runtime's", r.bound_ms === bound, `${bound} ms`, `the record's bound is ${String(r.bound_ms)} ms, not ${bound} ms`));
  const identities = obj(r.identities);
  checks.push(judge("KMS: public keys = the configuration's", identities.ok === true, String(identities.detail), String(identities.detail ?? "not checked")));
  const wanted = num(r.samples_per_key) ?? 0;
  const recordedKeys = obj(r.keys);
  /* REMEDY coverage: the record must say whether a remedy key was configured; the certification's configuration, when
     given, must agree; and the keys the record holds must be exactly the purposes that coverage implies. */
  const coverage = r.remedy_configured;
  const remedyWanted = expected !== undefined ? expected.remedy !== null : coverage === true;
  const coverageProblems: string[] = [];
  if (typeof coverage !== "boolean") coverageProblems.push("the record does not say whether a remedy key is configured (remedy_configured): an image that predates the REMEDY purpose is not evidence");
  else if (expected !== undefined && coverage !== remedyWanted) coverageProblems.push(remedyWanted ? "the configuration names a remedy key but the probe recorded none: REMEDY was not probed" : "the probe recorded a remedy key the configuration does not name");
  if (!remedyWanted && "remedy" in recordedKeys) coverageProblems.push("the record holds a remedy key entry but no remedy key is configured");
  if (remedyWanted && !("remedy" in recordedKeys)) coverageProblems.push("a remedy key is configured but the record holds no remedy key entry: REMEDY was skipped");
  const purposes: readonly KmsPurpose[] = remedyWanted ? [...BASE_KMS_PURPOSES, "remedy"] : BASE_KMS_PURPOSES;
  if (JSON.stringify(r.purposes) !== JSON.stringify(purposes)) coverageProblems.push(`the record's probed purposes ${JSON.stringify(r.purposes ?? null)} are not ${JSON.stringify(purposes)}`);
  checks.push(
    judge(
      "KMS remedy: coverage",
      coverageProblems.length === 0,
      remedyWanted ? "the dedicated remedy key is configured and probed as a fourth signing purpose" : "no remedy key is configured (timed-money release unavailable: fail closed); the three keys are probed",
      coverageProblems.join("; "),
    ),
  );
  for (const purpose of purposes) {
    const k = obj(recordedKeys[purpose]);
    if (k.opened !== true) {
      checks.push(judge(`KMS ${purpose}`, false, "", `the ${purpose} key did not open: ${String(k.error ?? "not in the record")}`));
      continue;
    }
    if (purpose === "remedy") {
      /* The remedy entry is the configured remedy key's (by fingerprint), and never another purpose's key. */
      const own = str(k.key);
      const others = BASE_KMS_PURPOSES.filter((other) => own !== null && str(obj(recordedKeys[other]).key) === own);
      const want = expected?.remedy?.key;
      const problems = [
        own === null ? "the remedy entry names no key" : null,
        others.length > 0 ? `the remedy entry is the ${others.join(" and ")} key (never substituted for REMEDY)` : null,
        expected !== undefined && want !== undefined && own !== want ? `the remedy entry is key ${String(own)}, not the configured remedy key ${String(want)}` : null,
      ].filter((p): p is string => p !== null);
      checks.push(judge(`KMS remedy (${own ?? "?"}): the configured remedy key`, problems.length === 0, `key ${String(own)}, distinct from the relayer, settlement and admission keys`, problems.join("; ")));
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
