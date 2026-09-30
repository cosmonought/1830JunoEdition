// server/src/aws/runtime/kmsGate.ts
//
// ==================================================================
//  LIVE-5 L5-7: EVERY KMS `Sign` OF AN AWS TASK PASSES THE POOL WRITER'S SIDE-EFFECT GATE FIRST -- AND IS COUNTED
// ==================================================================
//
// The L5-3 / L5-5 / L5-6 handoffs: `writer.beforeSideEffect()` immediately before every external side effect the table's
// fences cannot reach -- a KMS Sign (the settlement key's, the join admission key's, the relayer key's), a broadcast, a
// join admission. The relayer already asks its role (L5-6: `RelayerRole.beforeSideEffect`, which asks the same pool
// writer) before its Sign, its first broadcast and every rebroadcast; the settlement and admission signatures have no
// role object of their own. So the gate is put where every signature passes: the one `KmsClient` port the three KMS
// signers of this task sign through (`signer.ts` `openKmsDigestSigner`). It is the SAME gate -- the pool writer's -- not a
// second freshness mechanism: for the relayer it is asked twice in a row, and the second answer is the first's (a good
// check within 5 s passes at once, with no read).
//
// A WITHHELD SIGN is `SignerError("unavailable", ..., { signatureMayExist: false })`: nothing was sent to KMS, nothing can
// have been signed. Each caller already treats `unavailable` as "not now" -- the settlement job retries later (its digest
// is reserved already), the join admission answers `admission-unavailable`, the relayer backs off without spending its
// failure budget (F-L5-2) -- and none of them ever turns it into another key or another digest.
//
// OBSERVABILITY (not the L6-5 alarms): every KMS failure is counted by its class (`transient` / `refused` /
// `invalid-answer`, as `aws/kms/kmsDigestClient.ts` classes them), and withheld signatures separately. The first failure of each class
// is said once; every `refused` (a key the service will not use: disabled, deleted, wrong policy) is said each time, since
// an operator must act. The counters go into the status snapshot for the later alarm (L6-5's "signer unavailable >= 5
// min" page reads them). L6-5A: they are THE KMS counters -- `runtimeMetrics.ts` sends their deltas at each status tick
// (`KmsSigns`, `KmsSignWithheld`, `KmsTransient`, `KmsRefused`, `KmsInvalidAnswer`, `KmsOtherFailure`) and counts nothing
// of its own.

import { SignerError, type KmsClient } from "../../escrow/juno/signer";

export interface KmsCounters {
  signs: number;
  withheld: number;
  transient: number;
  refused: number;
  invalidAnswer: number;
  other: number;
  lastFailureAt: number | null;
}

export interface GatedKms {
  readonly client: KmsClient;
  readonly counters: Readonly<KmsCounters>;
}

const failureOf = (error: unknown): "transient" | "refused" | "invalid-answer" | null => {
  const failure = (error as { name?: unknown; failure?: unknown } | null)?.name === "KmsCallError" ? (error as { failure?: unknown }).failure : null;
  return failure === "transient" || failure === "refused" || failure === "invalid-answer" ? failure : null;
};

/**
 * `kms`, with the pool writer's gate before every `signDigest` (see the header). `gate` is `writer.beforeSideEffect`;
 * its rejection withholds the signature. `getPublicKey` (no side effect) is not gated, only counted.
 */
export function gatedKmsClient(kms: KmsClient, options: { readonly gate: () => Promise<void>; readonly now: () => number; readonly warn: (line: string) => void }): GatedKms {
  const counters: KmsCounters = { signs: 0, withheld: 0, transient: 0, refused: 0, invalidAnswer: 0, other: 0, lastFailureAt: null };
  const said = new Set<string>();

  function count(error: unknown, operation: "GetPublicKey" | "Sign"): void {
    counters.lastFailureAt = options.now();
    const failure = failureOf(error);
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 300);
    if (failure === "transient") counters.transient += 1;
    else if (failure === "refused") counters.refused += 1;
    else if (failure === "invalid-answer") counters.invalidAnswer += 1;
    else counters.other += 1;
    const kind = failure ?? "other";
    if (kind === "refused" || !said.has(kind)) {
      said.add(kind);
      options.warn(`  kms: ${operation} failed (${kind}${kind === "refused" ? ": an operator must act -- the key is not usable" : ""}) -- ${message}`);
    }
  }

  const client: KmsClient = {
    async getPublicKey(keyRef) {
      try {
        return await kms.getPublicKey(keyRef);
      } catch (error) {
        count(error, "GetPublicKey");
        throw error;
      }
    },
    async signDigest(keyRef, digest) {
      /* The exact bytes, copied before any await (L5-5's rule): nothing the caller does while the gate runs changes them. */
      const exact = Uint8Array.from(digest);
      try {
        await options.gate();
      } catch (error) {
        counters.withheld += 1;
        throw new SignerError("unavailable", `KMS Sign withheld: this task could not be shown to be its pool's current writer just now (${error instanceof Error ? error.message : String(error)})`, {
          signatureMayExist: false,
          native: "PoolWriterNotCurrent",
        });
      }
      try {
        const signature = await kms.signDigest(keyRef, exact);
        counters.signs += 1;
        return signature;
      } catch (error) {
        count(error, "Sign");
        throw error;
      }
    },
  };
  return { client, counters };
}
