// server/src/aws/awsClients.ts
//
// ==================================================================
//  LIVE-5 L5-1: THE ONE WAY THIS SERVER MAKES AN AWS CLIENT
// ==================================================================
//
// Every LIVE-5 slice (the game-table adapters L5-2, identity L5-4, the ledger and KMS L5-5, the wiring L5-7) gets its
// clients HERE, so there is one convention for the things that decide safety, not one per slice. The convention is
// documented in `server/src/aws/README.md`; in short:
//
//   TARGET          explicit, never inferred. `dynamodb-local` (tests and development only) names a LOOPBACK http
//                   endpoint and gets fixed dummy credentials and a fake region, so it can never reach AWS and never
//                   uses the machine's AWS keys, profile credentials or instance metadata. `aws` names a region and
//                   takes the task role's credentials from the SDK's default chain. BOTH pin every setting the shared
//                   config file or environment could otherwise change (`PINNED_CLIENT_SETTINGS`: no configured endpoint
//                   URL, no FIPS / dual-stack endpoint, the standard retry mode), so neither can be pointed elsewhere,
//                   or made to wait in an adaptive rate limiter, by a stray variable or profile line.
//   RETRIES         OFF in the SDK (`maxAttempts: 1`). LIVE-5 D-3: an authoritative write is resent only by its adapter,
//                   with the SAME `ClientRequestToken`, and a conditional failure on a resend is settled by a strong
//                   read -- a generic retry that re-signs a request with a fresh token could turn one write into two.
//   TIMEOUTS        bounded at the socket: connect 2 s, request 5 s (the actor's E-11 store deadline), with the request
//                   timeout made to THROW (`throwOnRequestTimeout`; otherwise the SDK only logs it). A timeout is an
//                   UNKNOWN outcome to the adapter, never a failure.
//   ABORT           every call can carry `deadline()`, an AbortSignal that bounds the whole call (default 8 s).
//   CLIENTS         only the services a slice actually uses. DynamoDB (L5-1: the conformance substrate; L5-5: the signing
//                   ledger) and KMS (L5-5: the three Juno keys sign through it -- `createKmsClient`, same rules, its own
//                   tighter call bounds, preflight §11.2). SSM and Secrets Manager are added by L5-7, through this file.

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { KMSClient } from "@aws-sdk/client-kms";

import { isAwsRegion } from "./arns";

export type AwsTarget =
  /** Tests and development: DynamoDB Local on this machine. */
  | { readonly kind: "dynamodb-local"; readonly endpoint: string }
  /** A real AWS region (LIVE-5 L5-7 wires this; nothing in L5-1 constructs it). */
  | { readonly kind: "aws"; readonly region: string };

export const AWS_CALL_POLICY = Object.freeze({
  /** The SDK never retries on its own (D-3): adapters resend with the same client request token. */
  maxAttempts: 1,
  connectionTimeoutMs: 2_000,
  requestTimeoutMs: 5_000,
  /** The default bound on one whole call, for `deadline()`. */
  callDeadlineMs: 8_000,
});

/** Not secrets and not AWS credentials: DynamoDB Local accepts any alphanumeric key (it refuses other characters since
 *  2.0). Fixed, so the default credential chain is never consulted. */
export const LOCAL_TEST_CREDENTIALS = Object.freeze({ accessKeyId: "gslocaltest", secretAccessKey: "gslocaltest" });
/** Not an AWS region: the SDK signs with it, and nothing in AWS answers to it. */
export const LOCAL_TEST_REGION = "gs-local";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Why `endpoint` is not an acceptable local test endpoint (`null`: it is). Only plain http on a loopback host with an
 *  explicit port and nothing else -- no credentials, path, query or fragment -- is accepted. (`service` only names the
 *  stand-in in the message: DynamoDB Local, or the KMS stand-in the KMS tests serve.) */
export function localEndpointProblem(endpoint: string, service = "DynamoDB Local"): string | null {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return `${JSON.stringify(endpoint)} is not a URL`;
  }
  if (url.protocol !== "http:") return `the ${service} endpoint must be plain http (got ${url.protocol}); an https endpoint is a real service`;
  if (!LOOPBACK_HOSTS.has(url.hostname)) return `the ${service} endpoint must be on this machine (localhost, 127.0.0.1 or [::1]), not ${url.hostname}`;
  if (url.port === "") return `the ${service} endpoint must name its port explicitly`;
  if (url.username !== "" || url.password !== "") return `the ${service} endpoint must not carry credentials`;
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") return `the ${service} endpoint must be only a scheme, host and port`;
  return null;
}

/* Regions: the one pattern (`aws/arns.ts`, which the configuration shares without loading a client). */
export { isAwsRegion } from "./arns";

/** Settings the SDK would otherwise take from the machine's shared config file (`AWS_CONFIG_FILE`, `~/.aws/config`) or
 *  environment: stated here instead, so no profile setting can change where a client goes or how it retries. (FIPS and
 *  dual-stack endpoints are a deliberate choice, made here if production ever needs them.) */
export const PINNED_CLIENT_SETTINGS = Object.freeze({
  useFipsEndpoint: false,
  useDualstackEndpoint: false,
  retryMode: "standard",
  ignoreConfiguredEndpointUrls: true,
});

/** The request handler options every client gets (the SDK's own object form of NodeHttpHandler's options). */
export const REQUEST_HANDLER_OPTIONS = Object.freeze({
  connectionTimeout: AWS_CALL_POLICY.connectionTimeoutMs,
  requestTimeout: AWS_CALL_POLICY.requestTimeoutMs,
  throwOnRequestTimeout: true,
});

export function createDynamoDbClient(target: AwsTarget): DynamoDBClient {
  if (target.kind === "dynamodb-local") {
    const problem = localEndpointProblem(target.endpoint);
    if (problem !== null) throw new Error(`refusing to create a DynamoDB Local client: ${problem}`);
    return new DynamoDBClient({
      ...PINNED_CLIENT_SETTINGS,
      endpoint: target.endpoint,
      region: LOCAL_TEST_REGION,
      credentials: { ...LOCAL_TEST_CREDENTIALS },
      maxAttempts: AWS_CALL_POLICY.maxAttempts,
      requestHandler: { ...REQUEST_HANDLER_OPTIONS },
    });
  }
  if (!isAwsRegion(target.region)) throw new Error(`refusing to create a DynamoDB client: ${JSON.stringify(target.region)} is not an AWS region`);
  return new DynamoDBClient({
    ...PINNED_CLIENT_SETTINGS,
    region: target.region,
    maxAttempts: AWS_CALL_POLICY.maxAttempts,
    requestHandler: { ...REQUEST_HANDLER_OPTIONS },
  });
}

/* ------------------------------------------------------------------ */
/* KMS (LIVE-5 L5-5)                                                    */
/* ------------------------------------------------------------------ */

export type KmsTarget =
  /** Tests only: the KMS stand-in a test serves on this machine (`aws/kms/kmsDigestClient.test.ts`). A loopback http
   *  endpoint, the fake region and the dummy keys, exactly as DynamoDB Local's: it can never reach AWS. */
  | { readonly kind: "kms-local"; readonly endpoint: string }
  /** The real AWS KMS of one region. The key ARNs a digest client accepts must name this same region
   *  (`kmsDigestClient`); L5-7 wires it from the configuration's key ARNs. */
  | { readonly kind: "aws"; readonly region: string };

/** KMS calls are bounded tighter than DynamoDB's (preflight §11.2: 3 s per call). A timeout is an UNKNOWN outcome, never
 *  a retry inside the SDK: `maxAttempts: 1` -- a Sign is repeated only by its caller, for the same key and digest. */
export const KMS_CALL_POLICY = Object.freeze({
  maxAttempts: 1,
  connectionTimeoutMs: 2_000,
  requestTimeoutMs: 3_000,
  callDeadlineMs: 4_000,
});

export const KMS_REQUEST_HANDLER_OPTIONS = Object.freeze({
  connectionTimeout: KMS_CALL_POLICY.connectionTimeoutMs,
  requestTimeout: KMS_CALL_POLICY.requestTimeoutMs,
  throwOnRequestTimeout: true,
});

export function createKmsClient(target: KmsTarget): KMSClient {
  if (target.kind === "kms-local") {
    const problem = localEndpointProblem(target.endpoint, "KMS stand-in");
    if (problem !== null) throw new Error(`refusing to create a local KMS client: ${problem}`);
    return new KMSClient({
      ...PINNED_CLIENT_SETTINGS,
      endpoint: target.endpoint,
      region: LOCAL_TEST_REGION,
      credentials: { ...LOCAL_TEST_CREDENTIALS },
      maxAttempts: KMS_CALL_POLICY.maxAttempts,
      requestHandler: { ...KMS_REQUEST_HANDLER_OPTIONS },
    });
  }
  if (target.kind !== "aws" || !isAwsRegion(target.region)) throw new Error(`refusing to create a KMS client: ${JSON.stringify((target as { region?: unknown }).region)} is not an AWS region`);
  return new KMSClient({
    ...PINNED_CLIENT_SETTINGS,
    region: target.region,
    maxAttempts: KMS_CALL_POLICY.maxAttempts,
    requestHandler: { ...KMS_REQUEST_HANDLER_OPTIONS },
  });
}

/** An AbortSignal bounding one whole call (pass it as `send(command, { abortSignal: deadline() })`). */
export function deadline(ms: number = AWS_CALL_POLICY.callDeadlineMs): AbortSignal {
  return AbortSignal.timeout(ms);
}

/** The environment variable that points the DynamoDB Local suites at a running DynamoDB Local. */
export const DYNAMODB_LOCAL_ENV = "GS_DYNAMODB_LOCAL_ENDPOINT";

/** The DynamoDB Local target named by the environment, `null` when unset. A SET but unacceptable value throws: a typo
 *  must never quietly skip the suite, and nothing but a loopback endpoint is ever used. */
export function dynamoLocalTargetFromEnv(env: NodeJS.ProcessEnv = process.env): { readonly kind: "dynamodb-local"; readonly endpoint: string } | null {
  const endpoint = env[DYNAMODB_LOCAL_ENV];
  if (endpoint === undefined || endpoint === "") return null;
  const problem = localEndpointProblem(endpoint);
  if (problem !== null) throw new Error(`${DYNAMODB_LOCAL_ENV}: ${problem}`);
  return { kind: "dynamodb-local", endpoint };
}
