// server/src/aws/kms/kmsDigestClient.ts
//
// ==================================================================
//  LIVE-5 L5-5: THE AWS KMS BINDING OF THE SIGNER SEAM -- ONE KEY ARN, ONE ALGORITHM, EVERY ANSWER CHECKED
// ==================================================================
//
// `signer.ts` (ESCROW-3B) already does everything a KMS signature needs except the call: SPKI -> compressed key, DER ->
// r‖s, low-s, and verify-before-use against the key's own public key. This file is the call: the `KmsClient` port over
// `@aws-sdk/client-kms`, through the one factory (`aws/awsClients.ts`: explicit region, SDK retries off, bounded throwing
// timeouts, nothing taken from the machine's AWS configuration).
//
// What it guarantees, so a failure can never change WHO signs or WHAT is signed:
//
//   KEY IDENTITY   a key is named by its full KMS key ARN (`arn:aws:kms:<region>:<account>:key/<id>`) -- never an alias
//                  (an alias can be repointed), a bare key id, or another service's ARN -- in THIS client's region. Every
//                  answer must name that same ARN (`KeyId`); `GetPublicKey` must say ECC_SECG_P256K1 / SIGN_VERIFY /
//                  ECDSA_SHA_256. No fallback exists: an error never tries another key, region or signer.
//   BYTES          `Sign` is sent exactly the caller's 32 bytes (copied first), `MessageType=DIGEST`,
//                  `SigningAlgorithm=ECDSA_SHA_256`, no grant tokens, never a dry run. The digest is never hashed again,
//                  truncated, re-encoded or derived here.
//   CLASSES        every failure is a `KmsCallError` with an explicit class (below). `signer.ts` maps it to its
//                  `SignerError` codes; the answer is still verified there against the key's public key before use.
//
// THE FAILURE CLASSES (`KmsCallError.failure`), and what a retry may do:
//
//   transient       KMS (or the path to it) did not answer usably now: throttling, an internal or dependency fault, the
//                   key temporarily unavailable, a timeout or a network error, the task's credentials or permission
//                   refused (IAM changes are operational). A retry is safe ONLY as the same request -- the same key, the
//                   same digest: the settlement digest was reserved in the ledger first (a second signature over the SAME
//                   digest is the same statement), and a relayer signature that was lost never became a transaction.
//                   `signatureMayExist` says whether KMS may have produced a signature the caller never saw (a timeout
//                   after sending): harmless for the reasons above, and recorded so nobody has to guess.
//   refused         KMS refuses THIS key for this request (not found, disabled, pending deletion, wrong key usage,
//                   an invalid ARN or request): an operator must act. Nothing was signed.
//   invalid-answer  KMS answered, but not as this key, this algorithm or this key spec -- or with no usable bytes. The
//                   answer is never used (`signer.ts` reports `verify-failed`).

import { GetPublicKeyCommand, SignCommand, type KMSClient } from "@aws-sdk/client-kms";

import { parseKmsKeyArn, type KmsKeyArn } from "../arns";
import { deadline, KMS_CALL_POLICY } from "../awsClients";
import type { KmsClient } from "../../escrow/juno/signer";

export const KMS_KEY_SPEC = "ECC_SECG_P256K1";
export const KMS_KEY_USAGE = "SIGN_VERIFY";
export const KMS_SIGNING_ALGORITHM = "ECDSA_SHA_256";
export const KMS_MESSAGE_TYPE = "DIGEST";

export type KmsFailureClass = "transient" | "refused" | "invalid-answer";

export class KmsCallError extends Error {
  constructor(
    readonly failure: KmsFailureClass,
    /** KMS may have produced a signature whose answer never arrived (the request was sent and its outcome is unknown). */
    readonly signatureMayExist: boolean,
    /** The service's error name, or a local reason (`local:*`). Safe to log. */
    readonly native: string,
    message: string,
  ) {
    super(message);
    this.name = "KmsCallError";
  }
}

/* Key ARNs: parsed by `aws/arns.ts` (no SDK import there, so the configuration shares the one parser). */
export { parseKmsKeyArn, type KmsKeyArn } from "../arns";

/* ------------------------------------------------------------------ */
/* Classification                                                       */
/* ------------------------------------------------------------------ */

/** Throttled before processing: nothing was signed. */
const THROTTLED = new Set(["ThrottlingException", "LimitExceededException", "TooManyRequestsException", "RequestLimitExceeded"]);
/** The key itself (or the request naming it) is unusable: an operator must act. Nothing was signed. */
const KEY_REFUSED = new Set([
  "NotFoundException",
  "DisabledException",
  "KMSInvalidStateException",
  "InvalidKeyUsageException",
  "InvalidArnException",
  "InvalidGrantTokenException",
  "UnsupportedOperationException",
  "IncorrectKeyException",
  "ValidationException",
  "DryRunOperationException",
]);
/** The task's credentials or permission (operational, possibly transient: IAM propagation, an expired session).
 *  Refused before processing: nothing was signed. */
const ACCESS = new Set(["AccessDeniedException", "UnrecognizedClientException", "InvalidSignatureException", "IncompleteSignature", "MissingAuthenticationToken", "ExpiredTokenException", "InvalidClientTokenId"]);
/** KMS's own faults: the request reached KMS, and its outcome inside KMS is unknown. */
const SERVER_FAULTS = new Set(["KMSInternalException", "DependencyTimeoutException", "InternalFailure", "ServiceUnavailable", "ServiceUnavailableException", "InternalServerError"]);

/** Every error a KMS call can end with, as one explicit class. Unknown errors are TRANSIENT with a possible signature:
 *  never "refused" (that would hold work on a guess) and never "not signed" (that would be a guess too). */
export function classifyKmsError(error: unknown, operation: "GetPublicKey" | "Sign"): KmsCallError {
  if (error instanceof KmsCallError) return error;
  const name = typeof (error as { name?: unknown })?.name === "string" ? (error as { name: string }).name : "Error";
  const message = error instanceof Error ? error.message : String(error);
  const status = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
  const fault = (error as { $fault?: unknown })?.$fault;
  const say = (what: string) => `KMS ${operation}: ${what} (${name}: ${message.slice(0, 200)})`;
  if (THROTTLED.has(name)) return new KmsCallError("transient", false, name, say("throttled; retry later with the same key and digest"));
  if (name === "KeyUnavailableException") return new KmsCallError("transient", false, name, say("the key is temporarily unavailable"));
  if (KEY_REFUSED.has(name)) return new KmsCallError("refused", false, name, say("KMS refuses this key for this request; an operator must act"));
  if (ACCESS.has(name)) return new KmsCallError("transient", false, name, say("the task's credentials or permissions were refused"));
  if (SERVER_FAULTS.has(name) || fault === "server" || (typeof status === "number" && status >= 500)) return new KmsCallError("transient", true, name, say("a KMS fault; the outcome is unknown"));
  if (fault === "client" && typeof status === "number" && status >= 400 && status < 500) return new KmsCallError("refused", false, name, say("KMS refused the request"));
  /* No answer at all: a timeout (connect, request or the call's deadline), an abort, a dropped connection. The request
     may have reached KMS: a signature may exist in the lost answer. */
  return new KmsCallError("transient", true, name, say("no answer; the outcome is unknown"));
}

/* ------------------------------------------------------------------ */
/* The port                                                             */
/* ------------------------------------------------------------------ */

export interface KmsDigestClientOptions {
  /** The region this client was created for (`createKmsClient`); every key ARN must name it. */
  readonly region: string;
  /** Tests: the bound on one whole call (default `KMS_CALL_POLICY.callDeadlineMs`). */
  readonly callDeadlineMs?: number;
}

/**
 * The `KmsClient` port (`signer.ts`) over one SDK client. Construct the SDK client with `createKmsClient` -- never here.
 * The client's own region is compared with `options.region` on first use (a client configured elsewhere is refused).
 */
export function kmsDigestClient(client: KMSClient, options: KmsDigestClientOptions): KmsClient & { readonly region: string } {
  const callMs = options.callDeadlineMs ?? KMS_CALL_POLICY.callDeadlineMs;
  let regionChecked: Promise<void> | null = null;

  const local = (what: string) => new KmsCallError("refused", false, "local:config", what);

  function keyOf(keyRef: string): KmsKeyArn {
    const parsed = parseKmsKeyArn(keyRef);
    if ("problem" in parsed) throw local(parsed.problem);
    if (parsed.region !== options.region) throw local(`the key ${keyRef} is in ${parsed.region}; this KMS client serves ${options.region} (no other region is ever tried)`);
    return parsed;
  }

  async function checkRegion(): Promise<void> {
    regionChecked ??= (async () => {
      const actual = await client.config.region();
      if (actual !== options.region) throw local(`the KMS client is configured for ${actual}, not ${options.region}`);
    })();
    try {
      await regionChecked;
    } catch (error) {
      regionChecked = null;
      throw error;
    }
  }

  const bytes = (value: unknown): value is Uint8Array => value instanceof Uint8Array;

  return {
    region: options.region,

    async getPublicKey(keyRef) {
      const key = keyOf(keyRef);
      await checkRegion();
      let answer;
      try {
        answer = await client.send(new GetPublicKeyCommand({ KeyId: key.arn }), { abortSignal: deadline(callMs) });
      } catch (error) {
        throw classifyKmsError(error, "GetPublicKey");
      }
      const wrong = (what: string) => new KmsCallError("invalid-answer", false, "local:answer", `KMS GetPublicKey for ${key.arn}: ${what}`);
      if (answer.KeyId !== key.arn) throw wrong(`the answer names ${JSON.stringify(answer.KeyId ?? null)}, not the requested key`);
      if (answer.KeySpec !== KMS_KEY_SPEC) throw wrong(`the key spec is ${JSON.stringify(answer.KeySpec ?? null)}, not ${KMS_KEY_SPEC}`);
      if (answer.KeyUsage !== KMS_KEY_USAGE) throw wrong(`the key usage is ${JSON.stringify(answer.KeyUsage ?? null)}, not ${KMS_KEY_USAGE}`);
      if (!(answer.SigningAlgorithms ?? []).includes(KMS_SIGNING_ALGORITHM)) throw wrong(`the key does not offer ${KMS_SIGNING_ALGORITHM}`);
      if (!bytes(answer.PublicKey) || answer.PublicKey.length === 0) throw wrong("no public key");
      return Uint8Array.from(answer.PublicKey);
    },

    async signDigest(keyRef, digest) {
      const key = keyOf(keyRef);
      if (!bytes(digest) || digest.length !== 32) throw local("a digest to sign is exactly 32 bytes");
      /* The exact bytes, copied at once (before any await): nothing a caller or the SDK does afterwards changes what is
         asked. */
      const message = Uint8Array.from(digest);
      await checkRegion();
      let answer;
      try {
        answer = await client.send(new SignCommand({ KeyId: key.arn, Message: message, MessageType: KMS_MESSAGE_TYPE, SigningAlgorithm: KMS_SIGNING_ALGORITHM }), { abortSignal: deadline(callMs) });
      } catch (error) {
        throw classifyKmsError(error, "Sign");
      }
      const wrong = (what: string) => new KmsCallError("invalid-answer", true, "local:answer", `KMS Sign with ${key.arn}: ${what}; the answer is never used`);
      if (answer.KeyId !== key.arn) throw wrong(`the answer names ${JSON.stringify(answer.KeyId ?? null)}, not the requested key`);
      if (answer.SigningAlgorithm !== KMS_SIGNING_ALGORITHM) throw wrong(`the algorithm is ${JSON.stringify(answer.SigningAlgorithm ?? null)}, not ${KMS_SIGNING_ALGORITHM}`);
      if (!bytes(answer.Signature) || answer.Signature.length < 8 || answer.Signature.length > 72) throw wrong("no DER signature");
      return Uint8Array.from(answer.Signature);
    },
  };
}
