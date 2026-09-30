// server/src/aws/game/transact.ts
//
// ==================================================================
//  LIVE-5 L5-2: ONE AUTHORITATIVE WRITE -- ONE TOKEN, RESENT UNTIL DYNAMODB HAS EVALUATED IT, NEVER GUESSED
// ==================================================================
//
// Every authoritative write of the game-table adapters is ONE `TransactWriteItems` (even a single item: preflight D-3),
// sent with a `ClientRequestToken` minted for THAT logical write and kept for every resend of it. The SDK never retries
// (`awsClients.ts`: `maxAttempts: 1`); this engine is the only thing that resends, and it resends the IDENTICAL request.
//
// What an answer means:
//
//   success                          applied. After an unknown outcome, the success of an identical resend is the
//                                    original's success (DynamoDB answers an identical, already-applied request with
//                                    success for ten minutes) or the resend's own: either way the write happened ONCE.
//   TransactionCanceled, a condition failed
//                                    EVALUATED and refused: nothing of this request was applied. On the FIRST attempt the
//                                    reasons say which term failed (the fence, or the CAS term): a DEFINITE answer.
//                                    On a RESEND it also proves no earlier attempt with this token was applied (DynamoDB
//                                    would have answered success); the caller still settles it by a STRONG READ, never at
//                                    face value (preflight §4), so what it reports is what the table holds.
//   TransactionCanceled otherwise, throttling, validation, a transaction conflict
//                                    refused WITHOUT being applied. On the first attempt: DEFINITE (the caller retries
//                                    with a new logical write) -- except a TRANSACTION CONFLICT (another transaction was
//                                    touching one of the same items: the pool item every creation checks, the DIRKEYS /
//                                    FINKEYS sets), which is retried here a few times, with the same token and a jittered
//                                    pause, before it is answered definite (preflight §4: "retry once internally").
//                                    Throttling is not retried here: the caller's retry is the port's contract. After an
//                                    unknown outcome none of these proves anything about the earlier attempt: keep
//                                    resending.
//   TransactionInProgress            an earlier attempt with this token is still being processed: wait, then resend the
//                                    same request -- never a new token (that would be a second, independent write).
//   IdempotentParameterMismatch      the token was used with other parameters: impossible here (the request object is
//                                    never rebuilt), so it is treated as unknown and settled like one.
//   anything else (a timeout, a dropped connection, a 5xx, an internal error)
//                                    UNKNOWN: the request may or may not have been applied. Resend the identical request,
//                                    with a bounded backoff, until DynamoDB has evaluated it -- and stop STARTING resends
//                                    before the token's ten-minute idempotency window can close (`windowMs`, 8 minutes
//                                    by default: a resend near the edge would run as a new request). If the window ends
//                                    without an evaluated answer, the caller's strong read decides: this write's token
//                                    visible -> committed; not visible -> UNCERTAIN, never "nothing was written".
//
// WHAT `uncertain` MEANS (the L5-5 handoff, and the same here): the write MAY STILL LAND LATER. It is not "no attempt
// remains in flight", and nothing in these adapters is built on that stronger reading: after an uncertain answer an
// adapter forgets what it assumed (the log re-validates before its next append) and every later write is conditioned
// on what it reads then, so a late landing can only make a later write refused -- never a fork, never an overwrite.
// A DEFINITE answer after a lost one is given only when DynamoDB EVALUATED a resend of the identical request and refused
// it (an applied original would have made that resend answer success; one still in progress would have made it answer
// TransactionInProgress), and the strong read agrees.
//
// A request that could not safely fit (item or transaction size, action count: `gameTable.ts` SIZE_POLICY) is never
// sent: it is refused DEFINITE here, before the first byte leaves.

import { randomUUID } from "crypto";
import { TransactWriteItemsCommand, type AttributeValue, type DynamoDBClient, type TransactWriteItem } from "@aws-sdk/client-dynamodb";

import { deadline } from "../awsClients";
import { transactionProblem } from "./gameTable";

export interface ResendTiming {
  /** Stop STARTING resends this long after the first attempt (the token is honoured for ten minutes). */
  readonly windowMs: number;
  /** At most this many resends (the window is the real bound; tests make both small). */
  readonly maxResends: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  now(): number;
  sleep(ms: number): Promise<void>;
  /** A fresh ClientRequestToken (1-36 printable characters). */
  token(): string;
}

/** DynamoDB honours a ClientRequestToken for ten minutes; a resend must START well inside it. */
export const IDEMPOTENCY_WINDOW_MS = 10 * 60_000;
/** A first attempt refused for a transaction conflict is retried this many times before it is answered definite. */
export const CONFLICT_RETRIES = 3;

export const DEFAULT_RESEND_TIMING: ResendTiming = Object.freeze({
  windowMs: 8 * 60_000,
  maxResends: Number.POSITIVE_INFINITY,
  baseDelayMs: 50,
  maxDelayMs: 2_000,
  now: () => Date.now(),
  sleep: (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      (timer as { unref?: () => void }).unref?.();
    }),
  token: () => randomUUID(),
});

export interface CancellationReason {
  readonly code: string;
  /** The item as it was when its condition failed (ReturnValuesOnConditionCheckFailure ALL_OLD), when returned. */
  readonly item: Record<string, AttributeValue> | null;
}

export type WriteAnswer =
  /** Applied (once). `redone`: only after an unknown outcome. */
  | { readonly kind: "applied"; readonly redone: boolean; readonly token: string }
  /** Evaluated and refused by a condition. `resend`: the refusal answered a resend after an unknown outcome -- the
   *  caller settles it by a strong read. `reasons` align with the request's actions. */
  | { readonly kind: "refused"; readonly resend: boolean; readonly reasons: readonly CancellationReason[]; readonly token: string; readonly detail: string }
  /** The first attempt was refused WITHOUT being applied (throttling, validation, a transaction conflict, too large). */
  | { readonly kind: "not-applied"; readonly detail: string; readonly token: string }
  /** The resends ended without an evaluated answer: the caller's strong read decides (committed, or uncertain). */
  | { readonly kind: "unknown"; readonly detail: string; readonly token: string };

/** Service answers that mean: this request was refused and nothing of it was applied. */
const NOT_APPLIED = new Set([
  "ThrottlingException",
  "ProvisionedThroughputExceededException",
  "RequestLimitExceeded",
  "ValidationException",
  "ResourceNotFoundException",
  "TransactionConflictException",
  "AccessDeniedException",
  "UnrecognizedClientException",
  "MissingAuthenticationTokenException",
  "InvalidSignatureException",
]);

/** One send's outcome (`classifyTransactFailure` for a failed one). Exported for LIVE-6 L6-6's staging probe, which
 *  certifies that the REAL service's answers land in the classes this engine assumes; the engine itself is unchanged. */
export type Sent =
  | { readonly kind: "applied" }
  | { readonly kind: "refused"; readonly reasons: CancellationReason[]; readonly detail: string }
  | { readonly kind: "not-applied"; readonly detail: string; readonly conflict: boolean }
  | { readonly kind: "in-progress"; readonly detail: string }
  | { readonly kind: "unknown"; readonly detail: string };

const describe = (error: unknown): string => (error instanceof Error ? `${error.name}: ${error.message}` : String(error));

/** What one failed `TransactWriteItems` means (see the header). Pure: the engine's single reading of an error. */
export function classifyTransactFailure(error: unknown): Exclude<Sent, { readonly kind: "applied" }> {
  const name = (error as { name?: string } | null)?.name ?? "";
  if (name === "TransactionCanceledException") {
    const raw = (error as { CancellationReasons?: Array<{ Code?: string; Item?: Record<string, AttributeValue> }> }).CancellationReasons ?? [];
    const reasons = raw.map((reason) => ({ code: reason.Code ?? "None", item: reason.Item ?? null }));
    if (reasons.some((reason) => reason.code === "ConditionalCheckFailed")) return { kind: "refused", reasons, detail: describe(error) };
    /* Cancelled for another reason (a conflicting transaction, throttling on an item, a validation error): nothing of
       this request was applied, and nothing was evaluated that says anything about an earlier attempt. */
    return { kind: "not-applied", detail: `${describe(error)} [${reasons.map((reason) => reason.code).join(",")}]`, conflict: reasons.some((reason) => reason.code === "TransactionConflict") };
  }
  if (name === "TransactionInProgressException") return { kind: "in-progress", detail: describe(error) };
  if (NOT_APPLIED.has(name)) return { kind: "not-applied", detail: describe(error), conflict: name === "TransactionConflictException" };
  return { kind: "unknown", detail: describe(error) };
}

async function sendOnce(client: DynamoDBClient, items: readonly TransactWriteItem[], token: string): Promise<Sent> {
  try {
    await client.send(new TransactWriteItemsCommand({ TransactItems: items as TransactWriteItem[], ClientRequestToken: token }), { abortSignal: deadline() });
    return { kind: "applied" };
  } catch (error) {
    return classifyTransactFailure(error);
  }
}

/** Send one logical write (see the header): one token, the identical request on every resend. */
export async function transactWrite(client: DynamoDBClient, items: readonly TransactWriteItem[], timing: ResendTiming = DEFAULT_RESEND_TIMING): Promise<WriteAnswer> {
  const token = timing.token();
  const problem = transactionProblem(items);
  if (problem !== null) return { kind: "not-applied", detail: `refused before sending: ${problem}`, token };
  const windowProblem = timingProblem(timing);
  if (windowProblem !== null) throw new Error(`transactWrite: ${windowProblem}`);
  const started = timing.now();
  let unknown: string | null = null;
  let resends = 0;
  let conflicts = 0;
  let delay = timing.baseDelayMs;
  for (;;) {
    const sent = await sendOnce(client, items, token);
    switch (sent.kind) {
      case "applied":
        return { kind: "applied", redone: unknown !== null, token };
      case "refused":
        return { kind: "refused", resend: unknown !== null, reasons: sent.reasons, token, detail: sent.detail };
      case "not-applied":
        if (unknown === null) {
          /* Nothing was applied. A transaction conflict is contention on a shared item: try again, a few times. */
          if (!sent.conflict || conflicts >= CONFLICT_RETRIES) return { kind: "not-applied", detail: sent.detail, token };
          conflicts += 1;
          await timing.sleep(timing.baseDelayMs * conflicts + Math.floor(Math.random() * Math.max(1, timing.baseDelayMs)));
          continue;
        }
        break; // proves nothing about the earlier attempt: resend
      case "in-progress":
        unknown ??= sent.detail;
        break;
      case "unknown":
        unknown = sent.detail;
        break;
    }
    if (resends >= timing.maxResends || timing.now() - started + delay >= timing.windowMs) {
      return { kind: "unknown", detail: `${unknown}; the resends ended (${resends} resent) without an evaluated answer`, token };
    }
    await timing.sleep(delay);
    delay = Math.min(delay * 2, timing.maxDelayMs);
    resends += 1;
  }
}

/** Why this timing is unsafe (`null`: it is safe). A resend started past the idempotency window would run as a NEW
 *  request -- a second logical write -- so the window must end well inside it (the call deadline is 8 s). */
export function timingProblem(timing: ResendTiming): string | null {
  if (!(Number.isFinite(timing.windowMs) && timing.windowMs >= 0 && timing.windowMs <= IDEMPOTENCY_WINDOW_MS - 60_000)) return `a resend window of ${timing.windowMs} ms is not inside the token's ten-minute idempotency window (at most ${IDEMPOTENCY_WINDOW_MS - 60_000} ms)`;
  if (!(timing.maxResends >= 0) || !(timing.baseDelayMs >= 0) || !(timing.maxDelayMs >= timing.baseDelayMs)) return "the resend pacing is not a bounded, non-negative backoff";
  return null;
}

/** The resend timing with a caller's overrides (tests shorten the window and make the sleep immediate). */
export function resendTiming(overrides: Partial<ResendTiming> = {}): ResendTiming {
  const timing = { ...DEFAULT_RESEND_TIMING, ...overrides };
  const problem = timingProblem(timing);
  if (problem !== null) throw new Error(`resend timing: ${problem}`);
  return timing;
}
