// server/src/aws/ledger/dynamoSigningLedger.ts
//
// ==================================================================
//  LIVE-5 L5-5: THE SIGNING LEDGER -- THE `SigningJournal` PORT OVER ONE DYNAMODB TABLE OUTSIDE THE APP'S RESTORE DOMAIN
// ==================================================================
//
// The primary invariant: NO restart, retry, stale writer, ambiguous write outcome, concurrent reservation or KMS failure
// may let two DIFFERENT digests be validly signed for the same signing slot. The settlement signer signs only after this
// ledger answers `reserved` or `same` for its digest (`signer.ts`), and the relayer broadcasts only after this ledger
// recorded the attempt (`relayer.ts`); so the invariant is this file's: a slot is taken by exactly one digest, decided by
// DynamoDB's conditions -- never by a check this process made first -- and an answer is given only when it is KNOWN.
//
// THE TABLE (preflight §3.4; `pk`/`sk` strings; nothing is ever updated or deleted except the two fence items):
//
//   APPGEN / APPGEN                              {schema 1, current_generation N} -- the adopted app generation. EVERY
//                                                write carries `ConditionCheck APPGEN: schema = 1 AND current_generation =
//                                                :mine`, so a task still pointed at a superseded (restored) game table
//                                                can reserve and record nothing. Written only by an operator (never here).
//   FENCE#relayer#<account> / FENCE              {schema 1, epoch r, relayer, token t} -- THE authoritative relayer fence:
//                                                every attempt write carries `ConditionCheck FENCE: schema = 1 AND epoch =
//                                                :r AND relayer = :account AND token = :t` -- (r, t) is held only by the
//                                                task whose `takeOverRelayer` minted it (t is that write's request token),
//                                                never by an epoch number alone. Minted r+1 by compare-and-swap (never
//                                                backwards: the ledger is never restored with the app).
//   SETTLE#<instance> / SEQ#<seq:20>#K#<key:05>  a settlement reservation {codec, digest_hex, ...}: `attribute_not_exists`
//                                                -- the FIRST digest wins the slot (instance, seq, signer key) for good.
//   TXID#<tx> / TXID                             an attempt, by transaction id: a tx id is recorded once, with one set of
//   ATTEMPT#<account> / SEQ#<seq:20>#TX#<tx>     facts (intent, account, sequence, expiry); the same attempt by account
//   ATTI#<intent> / SEQ#<seq:20>#TX#<tx>         (the startup guard) and by intent (`attemptsOf`). All three in ONE
//                                                transaction, each `attribute_not_exists`.
//
// Every item carries `schema` (1), `generation`, `token` (the ClientRequestToken of the write that created it) and `at`.
// Zero-padded numbers make every sort key order numerically (seq, sequence ≤ u64 max: 20 digits).
//
// WRITES (D-3): one `TransactWriteItems` per logical write, with a fresh random ClientRequestToken, SDK retries off.
//   succeeded                     -> committed.
//   cancelled (conditions)        -> a fence term failed: FENCED (definite: this writer writes nothing more, even where
//                                    the slot already holds its own digest -- a stale writer is never answered `same`);
//                                    a slot/attempt term failed: the fences, then the targets, are READ and decide -- a
//                                    moved fence: FENCED (whatever the service reported); otherwise the stored value
//                                    (`same` / `conflict` / the same attempt again / a collision / unreadable) -- read
//                                    strongly, never guessed;
//                                    ONLY transaction conflicts: nothing applied -- tried again as a NEW request (a new
//                                    token), a bounded few times, then definite;
//                                    any other reason (validation...): definite, nothing applied.
//   refused by the service        -> definite (throttling, validation, a missing table, auth, a reused token).
//   no answer (timeout, 5xx...)   -> UNKNOWN: the IDENTICAL request -- the same token -- is resent (TransactionInProgress:
//                                    wait, then resend), a bounded few times, well inside the token's 10-minute window.
//                                    Then the fences, then the targets, are READ, and SETTLE it -- in this order:
//                                    our token on every target -> committed (it landed, and passed the fences when it did);
//                                    a fence has moved -> fenced (ours can never land now; a stale writer is told so);
//                                    another value on a target -> that value decides (ours can never land now);
//                                    nothing there and the fences stand -> UNCERTAIN (it may still land): refused, and the
//                                    slot decides later -- first writer wins. An ambiguous write is never reported as not
//                                    written, and never becomes a fresh attempt with a new identity inside this call.
//   (Those reads: each fence by a consistent GetItem -- never a transactional read of APPGEN, which every write names --
//   and the targets after them as one snapshot. Fences only move forward and nothing is ever deleted, so a fence seen
//   moved can never be passed afterwards, and a write of ours that landed before that read is on the targets after it.)
//
// READS: strongly consistent, paged, and STRICT: every item a read touches is validated (shape, key <-> content,
// schema); a damaged item or a newer build's item refuses the whole answer (`unreadable`), never skipped -- fence items
// included: damage is never taken for a newer writer, and every field the parsers check is in the writes' conditions.
//
// NOT HERE (later slices): reading `APPGEN` from the game table's generation (L5-7), the relayer takeover SEQUENCE and its
// app-side mirror (L5-6: `aws/ownership/relayerRole.ts`, which reads this ledger's fence back through `relayerFenceHeld`
// for the pool writer's self-check), the self-check that exits a fenced task (L5-3 -- `onFenced` is the hook; L5-6's
// `ledgerFencedHook` turns it into the pool writer's loss), wiring into `start.ts` (L5-7: until then `start.ts` refuses a
// `dynamodb` journal rather than fall back to a file journal).

import { randomUUID } from "crypto";
import {
  GetItemCommand,
  QueryCommand,
  TransactGetItemsCommand,
  TransactWriteItemsCommand,
  type AttributeValue,
  type DynamoDBClient,
  type TransactWriteItem,
} from "@aws-sdk/client-dynamodb";

import { deadline } from "../awsClients";
import { SigningJournalError, type InspectableSigningJournal, type JournalledAttempt, type SigningReservation } from "../../escrow/signingJournal";

export const LEDGER_SCHEMA = 1;

type Item = Record<string, AttributeValue>;
type Key = { readonly pk: AttributeValue; readonly sk: AttributeValue };

const S = (value: string): AttributeValue => ({ S: value });
const N = (value: number | bigint | string): AttributeValue => ({ N: String(value) });

const DEC = /^(0|[1-9][0-9]{0,19})$/;
const U64_MAX = BigInt("18446744073709551615");
const HEX64 = /^[0-9a-f]{64}$/;
const TX_ID = /^[0-9A-F]{64}$/;
/** A bech32 account in lower case (the relayer's `juno1…`): letters and digits only, so it can never break a key. */
const ACCOUNT = /^[a-z][a-z0-9]{2,89}$/;
const TOKEN = /^[\x21-\x7e]{1,36}$/;
const CODEC = /^[\x21-\x7e]{1,64}$/;
const TABLE = /^[A-Za-z0-9_.-]{3,255}$/;
const TABLE_ARN = /^arn:aws:dynamodb:[a-z0-9-]+:[0-9]{12}:table\/[A-Za-z0-9_.-]{3,255}$/;

const pad = (value: string | number, width: number) => String(value).padStart(width, "0");
export const LEDGER_KEYS = Object.freeze({
  appgen: (): Key => ({ pk: S("APPGEN"), sk: S("APPGEN") }),
  fence: (account: string): Key => ({ pk: S(`FENCE#relayer#${account}`), sk: S("FENCE") }),
  settle: (instance: string, seq: string, key: number): Key => ({ pk: S(`SETTLE#${instance}`), sk: S(`SEQ#${pad(seq, 20)}#K#${pad(key, 5)}`) }),
  txid: (tx: string): Key => ({ pk: S(`TXID#${tx}`), sk: S("TXID") }),
  attempt: (account: string, sequence: string, tx: string): Key => ({ pk: S(`ATTEMPT#${account}`), sk: S(`SEQ#${pad(sequence, 20)}#TX#${tx}`) }),
  atti: (intent: string, sequence: string, tx: string): Key => ({ pk: S(`ATTI#${intent}`), sk: S(`SEQ#${pad(sequence, 20)}#TX#${tx}`) }),
});

/* ------------------------------------------------------------------ */
/* Errors                                                               */
/* ------------------------------------------------------------------ */

const definite = (message: string) => new SigningJournalError(message, "definite");
const uncertain = (message: string) => new SigningJournalError(message, "uncertain");
const fenced = (message: string) => new SigningJournalError(message, "fenced");

/** A stored item this build cannot read: `corrupt` (damaged) or `newer` (a later schema). Never guessed at. */
export class LedgerUnreadableError extends SigningJournalError {
  constructor(
    message: string,
    readonly format: "corrupt" | "newer",
  ) {
    super(message, "unreadable");
  }
}

/* ------------------------------------------------------------------ */
/* Canonical values                                                     */
/* ------------------------------------------------------------------ */

function u64(value: unknown, what: string): string {
  if (typeof value !== "string" || !DEC.test(value) || BigInt(value) > U64_MAX) throw definite(`${what} ${JSON.stringify(value)} is not a canonical u64 decimal`);
  return value;
}

function instanceOf(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > 1024 || /[\u0000-\u001f\u007f]/.test(value)) throw definite("an instance is a non-empty string of at most 1024 bytes without control characters");
  return value;
}

function positiveInt(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw definite(`${what} must be a positive integer`);
  return value;
}

/* ------------------------------------------------------------------ */
/* Strict item parsing (reads fail closed)                              */
/* ------------------------------------------------------------------ */

function unreadable(item: Item, why: string): never {
  const where = `${item.pk?.S ?? "?"} / ${item.sk?.S ?? "?"}`;
  const schema = item.schema?.N;
  if (schema !== undefined && /^[0-9]{1,9}$/.test(schema) && Number(schema) > LEDGER_SCHEMA) {
    throw new LedgerUnreadableError(`the ledger item ${where} is schema ${schema}, written by a newer build: never read or overwritten here`, "newer");
  }
  throw new LedgerUnreadableError(`the ledger item ${where} is damaged (${why}): signing stays stopped rather than guess`, "corrupt");
}

const str = (item: Item, name: string): string | undefined => (typeof item[name]?.S === "string" ? item[name].S : undefined);
const num = (item: Item, name: string): string | undefined => (typeof item[name]?.N === "string" ? item[name].N : undefined);
const intAttr = (item: Item, name: string, min: number, max: number): number | null => {
  const text = num(item, name);
  if (text === undefined || !/^(0|[1-9][0-9]{0,15})$/.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : null;
};

function checkSchema(item: Item): void {
  if (num(item, "schema") !== String(LEDGER_SCHEMA)) unreadable(item, "no readable schema");
}

function checkCommon(item: Item): void {
  checkSchema(item);
  if (intAttr(item, "generation", 1, Number.MAX_SAFE_INTEGER) === null) unreadable(item, "generation");
  if (intAttr(item, "at", 0, Number.MAX_SAFE_INTEGER) === null) unreadable(item, "at");
  const token = str(item, "token");
  if (token === undefined || !TOKEN.test(token)) unreadable(item, "token");
}

interface StoredSettle {
  readonly instance: string;
  readonly seq: string;
  readonly signer_key_id: number;
  readonly codec: string;
  readonly digest_hex: string;
  readonly token: string;
}

function parseSettle(item: Item): StoredSettle {
  checkCommon(item);
  if (str(item, "kind") !== "settle") unreadable(item, "kind");
  const instance = str(item, "instance");
  const seq = str(item, "seq");
  const key = intAttr(item, "signer_key_id", 0, 65535);
  const codec = str(item, "codec");
  const digest = str(item, "digest_hex");
  if (instance === undefined || instance.length === 0) unreadable(item, "instance");
  if (seq === undefined || !DEC.test(seq) || BigInt(seq) > U64_MAX) unreadable(item, "seq");
  if (key === null) unreadable(item, "signer_key_id");
  if (codec === undefined || !CODEC.test(codec)) unreadable(item, "codec");
  if (digest === undefined || !HEX64.test(digest)) unreadable(item, "digest_hex");
  const expected = LEDGER_KEYS.settle(instance, seq, key);
  if (item.pk?.S !== expected.pk.S || item.sk?.S !== expected.sk.S) unreadable(item, "its key does not match its content");
  return { instance, seq, signer_key_id: key, codec, digest_hex: digest, token: str(item, "token") as string };
}

interface StoredAttempt {
  readonly intent_id: string;
  readonly tx_id: string;
  readonly account: string;
  readonly sequence: string;
  readonly expires_after_height: string | null;
  readonly token: string;
}

function parseAttempt(item: Item, as: "txid" | "attempt" | "atti"): StoredAttempt {
  checkCommon(item);
  if (str(item, "kind") !== "attempt") unreadable(item, "kind");
  if (intAttr(item, "relayer_epoch", 1, Number.MAX_SAFE_INTEGER) === null) unreadable(item, "relayer_epoch");
  const intent = str(item, "intent_id");
  const tx = str(item, "tx_id");
  const account = str(item, "account");
  const sequence = str(item, "sequence");
  const expiresAttr = item.expires_after_height;
  if (intent === undefined || !HEX64.test(intent)) unreadable(item, "intent_id");
  if (tx === undefined || !TX_ID.test(tx)) unreadable(item, "tx_id");
  if (account === undefined || !ACCOUNT.test(account)) unreadable(item, "account");
  if (sequence === undefined || !DEC.test(sequence) || BigInt(sequence) > U64_MAX) unreadable(item, "sequence");
  let expires: string | null = null;
  if (expiresAttr !== undefined) {
    const text = str(item, "expires_after_height");
    if (text === undefined || !DEC.test(text) || BigInt(text) > U64_MAX) unreadable(item, "expires_after_height");
    expires = text;
  }
  const expected = as === "txid" ? LEDGER_KEYS.txid(tx) : as === "attempt" ? LEDGER_KEYS.attempt(account, sequence, tx) : LEDGER_KEYS.atti(intent, sequence, tx);
  if (item.pk?.S !== expected.pk.S || item.sk?.S !== expected.sk.S) unreadable(item, "its key does not match its content");
  return { intent_id: intent, tx_id: tx, account, sequence, expires_after_height: expires, token: str(item, "token") as string };
}

function parseAppGen(item: Item): number {
  checkSchema(item);
  const generation = intAttr(item, "current_generation", 1, Number.MAX_SAFE_INTEGER);
  if (generation === null) unreadable(item, "current_generation");
  return generation;
}

function parseFence(item: Item, account: string): { readonly epoch: number; readonly token: string | null } {
  checkSchema(item);
  if (str(item, "kind") !== "relayer-fence") unreadable(item, "kind");
  if (str(item, "relayer") !== account) unreadable(item, "relayer");
  const epoch = intAttr(item, "epoch", 1, Number.MAX_SAFE_INTEGER);
  if (epoch === null) unreadable(item, "epoch");
  const token = str(item, "token");
  if (token !== undefined && !TOKEN.test(token)) unreadable(item, "token");
  return { epoch, token: token ?? null };
}

/* ------------------------------------------------------------------ */
/* The ledger                                                           */
/* ------------------------------------------------------------------ */

export interface DynamoSigningLedgerOptions {
  /** The ledger table: a name, or (cross-account, preflight §10.1) its full table ARN. */
  readonly table: string;
  /** The adopted app generation this task was started for: `APPGEN.current_generation` must equal it, at open and in
   *  every write. There is no default: a task must know its generation. */
  readonly generation: number;
  /** The relayer account whose attempts this task may record. Production takes the relayer fence ONLY through
   *  `takeOverRelayer` (a restarted task mints a new epoch): absent `held`, this task records no attempt until it does.
   *  `held` -- TESTS ONLY (the conformance harness writes its own fence items): a fence this instance is to act as
   *  holding, the epoch AND the token that minted it. The token is readable in the fence item, so a value read back
   *  from the ledger must NEVER be passed here: that is adoption, two holders of one fence (L5-6 / L5-7 handoff). An
   *  epoch number alone is never held. */
  readonly relayer?: { readonly address: string; readonly held?: { readonly epoch: number; readonly token: string } };
  readonly now?: () => number;
  /** Tests only: the ClientRequestToken source of reservations and attempts (default: a random UUID per attempt of a
   *  write). Never used for a relayer mint, which always draws a random UUID (its token names the minter). */
  readonly newToken?: () => string;
  /** How many times an UNKNOWN outcome is resent (the identical request, the same token) before the snapshot settles it.
   *  Default 3. Bounded far inside the token's 10-minute idempotency window. */
  readonly resends?: number;
  /** How many times a write cancelled ONLY by a transaction conflict (nothing applied; every ledger write names APPGEN,
   *  so concurrent writes conflict there) is tried again as a new request. Default 3 (preflight §4: retry internally). */
  readonly conflictRetries?: number;
  /** Tests: the waits (default: 250 ms × 2^n before resend n, capped at 2 s; 20-80 ms × 2^n after a conflict). */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Called when a write is refused because a NEWER writer holds a fence this instance still believed it held -- once
   *  per fence value (a generation, a relayer epoch). Not called for a fence this instance itself moved past (its own
   *  takeover). The owner of the process decides (L5-3: exit). */
  readonly onFenced?: (which: "generation" | "relayer", detail: string) => void;
}

export interface DynamoSigningLedger extends InspectableSigningJournal {
  readonly table: string;
  readonly generation: number;
  /** The relayer account this instance was opened for (`null`: none -- it records no attempt, it mints no fence). */
  readonly relayer: string | null;
  /** The relayer fence epoch this instance holds (`null`: none -- it records no attempt). */
  relayerEpoch(): number | null;
  /** LIVE-5 L5-6: whether this instance could still record an attempt: the adopted generation (`APPGEN`) is still this
   *  instance's AND the relayer fence it holds is still the ledger's -- strongly consistent reads, the fence compared by
   *  epoch AND minting token (for the pool writer's self-check). Read only: it never writes, never adopts what it reads,
   *  and never changes what this instance holds. Throws when a read fails or an item cannot be read
   *  (`LedgerUnreadableError`): unknown, never "moved", never "held". */
  relayerFenceHeld(): Promise<{ readonly held: true } | { readonly held: false; readonly detail: string }>;
  /** The ledger half of a relayer takeover (preflight §12.2 step 1): mint `FENCE#relayer#<account>` epoch + 1 under the
   *  generation check, by compare-and-swap, stamped with this call's token. From then on every earlier holder's attempt
   *  writes are refused (the fence is (epoch, token)), and this instance records attempts under the new fence. L5-6
   *  runs the rest of the takeover sequence. */
  takeOverRelayer(): Promise<{ readonly epoch: number }>;
}

type Sent =
  | { readonly kind: "ok" }
  | { readonly kind: "cancelled"; readonly reasons: ReadonlyArray<{ readonly code: string }> }
  | { readonly kind: "in-progress"; readonly detail: string }
  | { readonly kind: "mismatch"; readonly detail: string }
  | { readonly kind: "definite"; readonly detail: string }
  | { readonly kind: "unknown"; readonly detail: string };

/** Service answers that mean "this request was refused before it had any effect". */
const DEFINITE = new Set([
  "ThrottlingException",
  "ProvisionedThroughputExceededException",
  "RequestLimitExceeded",
  "ValidationException",
  "ResourceNotFoundException",
  "TransactionConflictException",
  "ConditionalCheckFailedException",
  "AccessDeniedException",
  "UnrecognizedClientException",
  "InvalidSignatureException",
  "MissingAuthenticationTokenException",
  "ExpiredTokenException",
]);

const describe = (error: unknown) => (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).slice(0, 300);

type Fenced = { readonly kind: "fenced"; readonly which: "generation" | "relayer"; readonly value: number; readonly detail: string };

/** What one logical write came to (with the token of its final attempt). `exists`: a target already holds a value that
 *  is not ours -- the operation decides. `conflicted`: cancelled only by a transaction conflict -- nothing applied. */
type Verdict =
  | { readonly kind: "committed"; readonly redone: boolean }
  | { readonly kind: "exists"; readonly targets: ReadonlyArray<Item | null> }
  | Fenced
  | { readonly kind: "definite"; readonly detail: string }
  | { readonly kind: "uncertain"; readonly detail: string }
  | { readonly kind: "conflicted"; readonly detail: string };

interface WriteSpec {
  /** The request for one attempt: its items, every Put stamped with that attempt's token. */
  readonly build: (token: string) => TransactWriteItem[];
  /** The fence ConditionChecks: their index in the items, the item they read, whether a stored item still holds this
   *  writer's fence, and the fence value the write carries (the generation, or the relayer epoch). */
  readonly fences: ReadonlyArray<{ readonly index: number; readonly which: "generation" | "relayer"; readonly value: number; readonly key: Key; readonly holds: (item: Item | null) => boolean }>;
  /** The `attribute_not_exists` Puts: their index in the items, and their keys. */
  readonly targets: ReadonlyArray<{ readonly index: number; readonly key: Key }>;
}

export async function openDynamoSigningLedger(client: DynamoDBClient, options: DynamoSigningLedgerOptions): Promise<DynamoSigningLedger> {
  const table = options.table;
  if (typeof table !== "string" || !(TABLE.test(table) || TABLE_ARN.test(table))) throw definite(`${JSON.stringify(table)} is not a DynamoDB table name or table ARN`);
  const generation = positiveInt(options.generation, "the ledger generation");
  const relayerAddress = options.relayer === undefined ? null : options.relayer.address;
  if (relayerAddress !== null && !ACCOUNT.test(relayerAddress)) throw definite(`${JSON.stringify(relayerAddress)} is not a relayer account`);
  const given = options.relayer?.held;
  if (given !== undefined && (typeof given.token !== "string" || !TOKEN.test(given.token))) throw definite("a held relayer fence names the token that minted it");
  /** The relayer fence this instance holds: the epoch and the token that minted it. */
  let held: { readonly epoch: number; readonly token: string } | null = given === undefined ? null : { epoch: positiveInt(given.epoch, "the relayer epoch"), token: given.token };
  const clock = options.now ?? (() => Date.now());
  /** A whole, non-negative millisecond time (diagnostic only; a value this ledger could not read back is never written). */
  const now = (): number => {
    const at = Math.floor(clock());
    if (!Number.isSafeInteger(at) || at < 0) throw definite("the clock gave no usable time; nothing was written");
    return at;
  };
  const newToken = (): string => {
    const token = (options.newToken ?? (() => randomUUID()))();
    if (typeof token !== "string" || !TOKEN.test(token)) throw definite("the request token is not 1-36 printable characters");
    return token;
  };
  const resends = options.resends ?? 3;
  if (!Number.isSafeInteger(resends) || resends < 0 || resends > 10) throw definite("resends must be 0..10");
  const conflictRetries = options.conflictRetries ?? 3;
  if (!Number.isSafeInteger(conflictRetries) || conflictRetries < 0 || conflictRetries > 10) throw definite("conflictRetries must be 0..10");
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const reported = new Set<string>();
  const reportFenced = (which: "generation" | "relayer", value: number, detail: string) => {
    /* A relayer fence this instance itself moved past (its own takeover) is not news: nothing to report. */
    if (which === "relayer" && held?.epoch !== value) return;
    const key = `${which}:${value}`;
    if (reported.has(key)) return;
    reported.add(key);
    try {
      options.onFenced?.(which, detail);
    } catch {
      /* the hook's own failure never changes the answer */
    }
  };

  /* ---------------- fences ---------------- */

  /* Whether a fence item READ BACK still holds this writer's fence. Strict: an item this build cannot read throws
     `LedgerUnreadableError` -- damage is never taken for a newer writer (nor for a held fence). The conditions inside the
     writes test every field these parsers check, so a damaged fence item never passes a write either. */
  const generationHolds = (item: Item | null): boolean => item !== null && parseAppGen(item) === generation;
  const relayerHolds = (fence: { readonly epoch: number; readonly token: string }) => (item: Item | null): boolean => {
    if (item === null || relayerAddress === null) return false;
    const stored = parseFence(item, relayerAddress);
    return stored.epoch === fence.epoch && stored.token === fence.token;
  };
  const generationCheck = (): TransactWriteItem => ({
    ConditionCheck: {
      TableName: table,
      Key: LEDGER_KEYS.appgen(),
      ConditionExpression: "#schema = :schema AND #gen = :gen",
      ExpressionAttributeNames: { "#schema": "schema", "#gen": "current_generation" },
      ExpressionAttributeValues: { ":schema": N(LEDGER_SCHEMA), ":gen": N(generation) },
    },
  });
  /** The relayer fence is (epoch, token): only the task that minted the epoch holds it. Every field `parseFence` checks
   *  is in the condition (`kind` too), so a damaged fence item refuses the write -- it never passes one. */
  const relayerCheck = (account: string, fence: { readonly epoch: number; readonly token: string }): TransactWriteItem => ({
    ConditionCheck: {
      TableName: table,
      Key: LEDGER_KEYS.fence(account),
      ConditionExpression: "#schema = :schema AND #kind = :kind AND #epoch = :epoch AND #relayer = :relayer AND #token = :token",
      ExpressionAttributeNames: { "#schema": "schema", "#kind": "kind", "#epoch": "epoch", "#relayer": "relayer", "#token": "token" },
      ExpressionAttributeValues: { ":schema": N(LEDGER_SCHEMA), ":kind": S("relayer-fence"), ":epoch": N(fence.epoch), ":relayer": S(account), ":token": S(fence.token) },
    },
  });

  /* ---------------- transport ---------------- */

  async function send(items: TransactWriteItem[], token: string): Promise<Sent> {
    try {
      await client.send(new TransactWriteItemsCommand({ TransactItems: items, ClientRequestToken: token }), { abortSignal: deadline() });
      return { kind: "ok" };
    } catch (error) {
      const name = (error as { name?: string }).name ?? "";
      if (name === "TransactionCanceledException") {
        const reasons = ((error as { CancellationReasons?: Array<{ Code?: string }> }).CancellationReasons ?? []).map((reason) => ({ code: reason.Code ?? "None" }));
        return { kind: "cancelled", reasons };
      }
      if (name === "TransactionInProgressException") return { kind: "in-progress", detail: describe(error) };
      if (name === "IdempotentParameterMismatchException") return { kind: "mismatch", detail: describe(error) };
      if (DEFINITE.has(name)) return { kind: "definite", detail: describe(error) };
      return { kind: "unknown", detail: describe(error) };
    }
  }

  /** A transactional read of `keys`, all at one instant: `null` for an absent item. Throws when the read itself fails. */
  async function snapshot(keys: readonly Key[]): Promise<Array<Item | null>> {
    const answer = await client.send(new TransactGetItemsCommand({ TransactItems: keys.map((key) => ({ Get: { TableName: table, Key: { pk: key.pk, sk: key.sk } } })) }), { abortSignal: deadline() });
    const responses = answer.Responses ?? [];
    if (responses.length !== keys.length) throw new Error(`the snapshot answered ${responses.length} of ${keys.length} items`);
    return responses.map((response) => (response.Item === undefined ? null : response.Item));
  }

  async function readItem(key: Key): Promise<Item | null> {
    const answer = await client.send(new GetItemCommand({ TableName: table, Key: { pk: key.pk, sk: key.sk }, ConsistentRead: true }), { abortSignal: deadline() });
    return answer.Item ?? null;
  }

  /* What a write that did not simply succeed is judged by: its FENCES, then its TARGETS, read in that order.
     - The fences are read one strongly consistent GetItem each: a GetItem never conflicts with a transaction, while a
       transactional read of APPGEN -- which every ledger write names -- would conflict with every write in flight.
     - The targets are read after the fences, as ONE snapshot (a ledger transaction writes all of them or none, so a
       partial view is never seen): a single target by GetItem; several by TransactGetItems, retried a bounded few times
       while a transaction on one of them is in flight (a read is always safe to repeat).
     The order is what makes separate reads sound: fences only ever move forward and nothing is ever deleted, so a fence
     seen moved at the first read can never be passed by a write afterwards, and a write of ours that landed before it is
     still on the targets at the second read. */
  async function readFences(spec: WriteSpec): Promise<Array<Item | null>> {
    const out: Array<Item | null> = [];
    for (const fence of spec.fences) out.push(await readItem(fence.key));
    return out;
  }
  async function readTargets(spec: WriteSpec): Promise<Array<Item | null>> {
    if (spec.targets.length === 1) return [await readItem(spec.targets[0].key)];
    for (let round = 0; ; round += 1) {
      try {
        return await snapshot(spec.targets.map((target) => target.key));
      } catch (error) {
        if ((error as { name?: string }).name !== "TransactionCanceledException" || round >= 3) throw error;
        await sleep((20 + Math.floor(Math.random() * 60)) * 2 ** round);
      }
    }
  }

  /** Settles a write whose outcome was unknown: the fences, then the targets. */
  async function settle(spec: WriteSpec, token: string, lastDetail: string): Promise<Verdict> {
    let fences: Array<Item | null>;
    let targets: Array<Item | null>;
    try {
      fences = await readFences(spec);
      targets = await readTargets(spec);
    } catch (error) {
      return { kind: "uncertain", detail: `${lastDetail}; the settling read failed (${describe(error)})` };
    }
    /* 1. Ours landed (our token on every target): committed -- it passed the fence when it was applied. */
    if (targets.length > 0 && targets.every((item) => item !== null && item.token?.S === token)) return { kind: "committed", redone: true };
    /* 2. A fence has moved: ours can never land now, and a stale writer is told so -- never `same`, never "recorded".
          (A fence item this build cannot read refuses as `unreadable` here.) */
    const moved = spec.fences.findIndex((fence, at) => !fence.holds(fences[at]));
    if (moved >= 0) {
      const fence = spec.fences[moved];
      return { kind: "fenced", which: fence.which, value: fence.value, detail: `${lastDetail}; nothing of ours is stored and a newer writer holds the ${fence.which} fence, so it can never land` };
    }
    /* 3. Another value holds a target: ours can never land (its condition fails); that value decides. */
    if (targets.some((item) => item !== null)) return { kind: "exists", targets };
    /* 4. Nothing is there and the fences stand: it may still land. */
    return { kind: "uncertain", detail: `${lastDetail}; nothing of ours is visible yet and the fences stand: it may still land` };
  }

  /** A FIRST send's cancellation (no earlier attempt of ours can explain it): the reasons decide. */
  async function cancelledFirst(spec: WriteSpec, reasons: ReadonlyArray<{ readonly code: string }>): Promise<Verdict> {
    const code = (index: number) => reasons[index]?.code ?? "None";
    /* A fence term first: a stale writer is refused even where a target also exists (it is never answered `same`). The
       fence is read back to tell a newer writer from damage: an item this build cannot read refuses as `unreadable` (it
       is never reported as a takeover); if the read itself fails, `fenced` stands -- the condition did fail. */
    const fence = spec.fences.find((entry) => code(entry.index) === "ConditionalCheckFailed");
    if (fence !== undefined) {
      const seen = await readFences(spec).catch(() => null);
      /* `holds` throws LedgerUnreadableError for a fence item this build cannot read. */
      if (seen !== null) for (const [at, entry] of spec.fences.entries()) entry.holds(seen[at]);
      return { kind: "fenced", which: fence.which, value: fence.value, detail: `a newer writer holds the ${fence.which} fence; nothing was written` };
    }
    /* Only transaction conflicts (another transaction on one of these items, APPGEN included): nothing applied, and a
       new request may well succeed. */
    if (reasons.some((reason) => reason.code === "TransactionConflict") && reasons.every((reason) => reason.code === "TransactionConflict" || reason.code === "None")) {
      return { kind: "conflicted", detail: `the transaction was cancelled by a conflicting transaction (${reasons.map((reason) => reason.code).join(",")}); nothing was written` };
    }
    /* Any other cause (throttling, validation...): the whole transaction was not applied. */
    const other = reasons.find((reason) => reason.code !== "None" && reason.code !== "ConditionalCheckFailed");
    if (other !== undefined) return { kind: "definite", detail: `the transaction was cancelled (${other.code}); nothing was written` };
    if (!spec.targets.some((target) => code(target.index) === "ConditionalCheckFailed")) return { kind: "definite", detail: "the transaction was cancelled without a reason this ledger knows; nothing was written" };
    /* A target exists: the STORED value decides, read strongly (the cancellation's own copy is not relied on) -- and the
       fences are read first, so a stale writer is refused even where the service reported only the target's failure
       (nothing documents that every failed condition is reported). Nothing is ever deleted from the ledger, so what made
       the condition fail is still there. */
    let fences: Array<Item | null>;
    let targets: Array<Item | null>;
    try {
      fences = await readFences(spec);
      targets = await readTargets(spec);
    } catch (error) {
      return { kind: "definite", detail: `a target is taken, and it could not be read (${describe(error)}); nothing was written` };
    }
    const moved = spec.fences.findIndex((entry, at) => !entry.holds(fences[at]));
    if (moved >= 0) {
      const entry = spec.fences[moved];
      return { kind: "fenced", which: entry.which, value: entry.value, detail: `a newer writer holds the ${entry.which} fence (read with the taken target); nothing was written` };
    }
    return { kind: "exists", targets };
  }

  /** One attempt: sent once; an unknown outcome resent identically (the same items, the same token), then settled. */
  async function attempt(spec: WriteSpec, token: string): Promise<Verdict> {
    const items = spec.build(token);
    const first = await send(items, token);
    switch (first.kind) {
      case "ok":
        return { kind: "committed", redone: false };
      case "cancelled":
        return cancelledFirst(spec, first.reasons);
      case "definite":
        return { kind: "definite", detail: first.detail };
      case "mismatch":
        /* A fresh token that DynamoDB already knows for another request: this request was not applied. */
        return { kind: "definite", detail: `the request token was already used for another request (${first.detail}); nothing of this request was written` };
      default:
        break;
    }
    /* Unknown (or already in progress): the IDENTICAL request -- the same items, the same token. */
    let detail = first.detail;
    for (let resend = 0; resend < resends; resend += 1) {
      await sleep(Math.min(2_000, 250 * 2 ** resend));
      const again = await send(items, token);
      if (again.kind === "ok") return { kind: "committed", redone: true };
      if (again.kind === "unknown" || again.kind === "in-progress") {
        detail = `${detail}; resend ${resend + 1}: ${again.detail}`;
        continue;
      }
      detail = `${detail}; resend ${resend + 1}: ${again.kind === "cancelled" ? `cancelled (${again.reasons.map((reason) => reason.code).join(",")})` : again.detail}`;
      break;
    }
    /* Whatever the last resend said -- still unknown; a cancellation (perhaps by our own first attempt, which landed); a
       refusal, which proves nothing about the first attempt -- the snapshot settles it. */
    return settle(spec, token, `the write's outcome was unknown (${detail})`);
  }

  /** One logical write. Only an attempt that was DEFINITELY not applied (cancelled by nothing but a transaction
   *  conflict) is followed by another -- a new request with a new token; an unknown attempt never is: it is resent as
   *  itself and settled, so an ambiguous attempt never turns into a fresh one. */
  async function write(spec: WriteSpec): Promise<{ readonly verdict: Exclude<Verdict, { kind: "conflicted" }>; readonly token: string }> {
    for (let round = 0; ; round += 1) {
      const token = newToken();
      const verdict = await attempt(spec, token);
      if (verdict.kind !== "conflicted") return { verdict, token };
      if (round >= conflictRetries) return { verdict: { kind: "definite", detail: `${verdict.detail} (${round + 1} times)` }, token };
      await sleep((20 + Math.floor(Math.random() * 60)) * 2 ** round);
    }
  }

  function refuse(verdict: Exclude<Verdict, { kind: "committed" } | { kind: "exists" } | { kind: "conflicted" }>, what: string): never {
    if (verdict.kind === "fenced") {
      reportFenced(verdict.which, verdict.value, verdict.detail);
      throw fenced(`${what}: ${verdict.detail}`);
    }
    if (verdict.kind === "definite") throw definite(`${what}: ${verdict.detail}`);
    throw uncertain(`${what}: ${verdict.detail}; nothing is signed or broadcast on it, and the slot decides later (first writer wins)`);
  }

  /* ---------------- reads ---------------- */

  async function query(pk: string): Promise<Item[]> {
    const out: Item[] = [];
    let start: Item | undefined;
    do {
      const page = await client.send(
        new QueryCommand({ TableName: table, KeyConditionExpression: "#pk = :pk", ExpressionAttributeNames: { "#pk": "pk" }, ExpressionAttributeValues: { ":pk": S(pk) }, ConsistentRead: true, ExclusiveStartKey: start }),
        { abortSignal: deadline() },
      );
      out.push(...(page.Items ?? []));
      start = page.LastEvaluatedKey;
    } while (start !== undefined);
    return out;
  }

  async function reservationsOf(instance: string): Promise<StoredSettle[]> {
    return (await query(`SETTLE#${instanceOf(instance)}`)).map(parseSettle);
  }

  const sameAttempt = (stored: StoredAttempt, wanted: Omit<StoredAttempt, "token">) =>
    stored.intent_id === wanted.intent_id && stored.tx_id === wanted.tx_id && stored.account === wanted.account && stored.sequence === wanted.sequence && stored.expires_after_height === wanted.expires_after_height;

  /* ---------------- open: the generation (and a held relayer fence) must be this task's ---------------- */

  const openRead = async (key: Key, what: string): Promise<Item | null> => {
    try {
      return await readItem(key);
    } catch (error) {
      throw definite(`the ledger ${table} could not be read (${what}: ${describe(error)})`);
    }
  };
  const appgen = await openRead(LEDGER_KEYS.appgen(), "APPGEN");
  if (appgen === null) throw fenced(`the ledger ${table} has no adopted generation (APPGEN): an operator initialises it; nothing is written until then`);
  const adopted = parseAppGen(appgen);
  if (adopted !== generation) throw fenced(`the ledger's adopted generation is ${adopted}; this task was started for generation ${generation}`);
  if (relayerAddress !== null && held !== null) {
    const item = await openRead(LEDGER_KEYS.fence(relayerAddress), "the relayer fence");
    if (item === null) throw fenced(`the relayer fence of ${relayerAddress} does not exist; no epoch ${held.epoch} was ever minted`);
    const fence = parseFence(item, relayerAddress);
    if (fence.epoch !== held.epoch || fence.token !== held.token) throw fenced(`the relayer fence of ${relayerAddress} is at epoch ${fence.epoch}${fence.epoch === held.epoch ? " minted by another task" : ""}, not this task's ${held.epoch}`);
  }

  return {
    table,
    generation,
    relayer: relayerAddress,
    relayerEpoch: () => held?.epoch ?? null,

    async relayerFenceHeld() {
      const fence = held;
      if (relayerAddress === null || fence === null) return { held: false as const, detail: "this ledger instance holds no relayer fence" };
      /* The generation first (every attempt write carries it too): a restore adopted since fences this instance. */
      const appgen = await readItem(LEDGER_KEYS.appgen());
      if (appgen === null) return { held: false as const, detail: "the ledger has no adopted generation" };
      const adoptedNow = parseAppGen(appgen); // strict: an item this build cannot read throws (unknown)
      if (adoptedNow !== generation) return { held: false as const, detail: `the ledger's adopted generation is ${adoptedNow}, not this instance's ${generation}` };
      const item = await readItem(LEDGER_KEYS.fence(relayerAddress));
      if (item === null) return { held: false as const, detail: `the relayer fence of ${relayerAddress} is gone` };
      const stored = parseFence(item, relayerAddress); // strict: an item this build cannot read throws (unknown)
      if (stored.epoch === fence.epoch && stored.token === fence.token) return { held: true as const };
      return { held: false as const, detail: `the relayer fence of ${relayerAddress} is at epoch ${stored.epoch}${stored.epoch === fence.epoch ? " minted by another task" : ""}, not this task's ${fence.epoch}` };
    },

    async reserveSettlement(entry) {
      const instance = instanceOf(entry.instance);
      const seq = u64(entry.seq, "seq");
      const key = entry.signer_key_id;
      if (!Number.isSafeInteger(key) || key < 0 || key > 65535) throw definite("a signer key id is 0..65535");
      const digest = entry.digest as { readonly codec?: unknown; readonly purpose?: unknown; readonly hex?: unknown };
      if (typeof digest?.codec !== "string" || !CODEC.test(digest.codec) || digest.purpose !== "settle" || typeof digest.hex !== "string" || !HEX64.test(digest.hex)) throw definite("a reservation needs a settle digest (codec, 32 bytes of lowercase hex)");
      const codec = digest.codec;
      const hex = digest.hex;
      const slot = LEDGER_KEYS.settle(instance, seq, key);
      const at = now();
      const { verdict, token } = await write({
        build: (stamp) => [
          generationCheck(),
          {
            Put: {
              TableName: table,
              Item: { ...slot, schema: N(LEDGER_SCHEMA), kind: S("settle"), instance: S(instance), seq: S(seq), signer_key_id: N(key), codec: S(codec), digest_hex: S(hex), at: N(at), generation: N(generation), token: S(stamp) },
              ConditionExpression: "attribute_not_exists(pk)",
              ReturnValuesOnConditionCheckFailure: "ALL_OLD",
            },
          },
        ],
        fences: [{ index: 0, which: "generation", value: generation, key: LEDGER_KEYS.appgen(), holds: generationHolds }],
        targets: [{ index: 1, key: slot }],
      });
      if (verdict.kind === "committed") return { kind: "reserved" as const };
      if (verdict.kind === "exists") {
        const stored = verdict.targets[0];
        if (stored === null) throw uncertain(`seq ${seq}: the slot is taken, and then read empty (impossible: nothing is ever deleted)`);
        const occupant = parseSettle(stored);
        if (occupant.token === token) return { kind: "reserved" as const };
        const same = occupant.codec === codec && occupant.digest_hex === hex;
        return same ? { kind: "same" as const } : { kind: "conflict" as const, digest_hex: occupant.digest_hex };
      }
      refuse(verdict, `the reservation of seq ${seq} under signer key ${key}`);
    },

    async recordAttempt(entry) {
      if (typeof entry.intent_id !== "string" || !HEX64.test(entry.intent_id)) throw definite("an intent id is 32 bytes of lowercase hex");
      if (typeof entry.tx_id !== "string" || !TX_ID.test(entry.tx_id)) throw definite("a transaction id is 32 bytes of upper-case hex");
      if (typeof entry.account !== "string" || !ACCOUNT.test(entry.account)) throw definite(`${JSON.stringify(entry.account)} is not an account`);
      const sequence = u64(entry.account_sequence, "the account sequence");
      const expires = entry.expires_after_height === undefined ? null : u64(entry.expires_after_height, "the expiry height");
      if (relayerAddress === null || entry.account !== relayerAddress) throw definite(`this ledger instance records attempts of ${relayerAddress ?? "no relayer account"} only, not ${entry.account}`);
      const fence = held;
      if (fence === null) throw definite(`this task holds no relayer fence for ${relayerAddress}: it records no attempt (take the relayer role first)`);
      const wanted = { intent_id: entry.intent_id, tx_id: entry.tx_id, account: entry.account, sequence, expires_after_height: expires };
      const at = now();
      const keys = { txid: LEDGER_KEYS.txid(wanted.tx_id), attempt: LEDGER_KEYS.attempt(wanted.account, sequence, wanted.tx_id), atti: LEDGER_KEYS.atti(wanted.intent_id, sequence, wanted.tx_id) };
      const put = (key: Key, stamp: string): TransactWriteItem => ({
        Put: {
          TableName: table,
          Item: {
            ...key,
            schema: N(LEDGER_SCHEMA),
            kind: S("attempt"),
            intent_id: S(wanted.intent_id),
            tx_id: S(wanted.tx_id),
            account: S(wanted.account),
            sequence: S(sequence),
            ...(expires !== null ? { expires_after_height: S(expires) } : {}),
            at: N(at),
            generation: N(generation),
            relayer_epoch: N(fence.epoch),
            token: S(stamp),
          },
          ConditionExpression: "attribute_not_exists(pk)",
          ReturnValuesOnConditionCheckFailure: "ALL_OLD",
        },
      });
      const { verdict } = await write({
        build: (stamp) => [generationCheck(), relayerCheck(wanted.account, fence), put(keys.txid, stamp), put(keys.attempt, stamp), put(keys.atti, stamp)],
        fences: [
          { index: 0, which: "generation", value: generation, key: LEDGER_KEYS.appgen(), holds: generationHolds },
          { index: 1, which: "relayer", value: fence.epoch, key: LEDGER_KEYS.fence(wanted.account), holds: relayerHolds(fence) },
        ],
        targets: [
          { index: 2, key: keys.txid },
          { index: 3, key: keys.attempt },
          { index: 4, key: keys.atti },
        ],
      });
      if (verdict.kind === "committed") return;
      if (verdict.kind === "exists") {
        /* The transaction id is recorded already: it is the SAME attempt only if every one of its three records exists and
           says exactly these facts. Anything else -- another intent, sequence or expiry for this tx id, a partial record,
           damage -- is refused, and the first record stands. */
        const [txid, attempt, atti] = verdict.targets;
        if (txid !== null) {
          const stored = parseAttempt(txid, "txid");
          if (!sameAttempt(stored, wanted)) throw definite(`transaction ${wanted.tx_id} is already recorded for intent ${stored.intent_id} at sequence ${stored.sequence}; a different record of it is refused`);
        }
        if (txid === null || attempt === null || atti === null) throw new LedgerUnreadableError(`the records of transaction ${wanted.tx_id} are incomplete (a ledger transaction writes all three): refused rather than guessed`, "corrupt");
        const all = [parseAttempt(txid, "txid"), parseAttempt(attempt, "attempt"), parseAttempt(atti, "atti")];
        if (!all.every((stored) => sameAttempt(stored, wanted))) throw definite(`transaction ${wanted.tx_id} is recorded with other facts; refused`);
        return; // the same attempt, recorded before: idempotent by transaction identity
      }
      refuse(verdict, `the attempt ${wanted.tx_id} at sequence ${sequence}`);
    },

    async highestReserved(instance) {
      let best: bigint | null = null;
      for (const entry of await reservationsOf(instance)) {
        const seq = BigInt(entry.seq);
        if (best === null || seq > best) best = seq;
      }
      return best === null ? null : { seq: best.toString() };
    },

    async reservations(instance): Promise<ReadonlyArray<SigningReservation>> {
      if (instance === undefined) throw definite("the ledger lists reservations of one instance at a time");
      return (await reservationsOf(instance)).map((entry) => ({ instance: entry.instance, seq: entry.seq, signer_key_id: entry.signer_key_id, digest_hex: entry.digest_hex }));
    },

    async attemptsOf(intentId): Promise<ReadonlyArray<JournalledAttempt>> {
      if (typeof intentId !== "string" || !HEX64.test(intentId)) throw definite("an intent id is 32 bytes of lowercase hex");
      return (await query(`ATTI#${intentId}`))
        .map((item) => parseAttempt(item, "atti"))
        .map((entry) => ({ tx_id: entry.tx_id, account: entry.account, sequence: entry.sequence, ...(entry.expires_after_height !== null ? { expires_after_height: entry.expires_after_height } : {}) }));
    },

    async allAttempts(account) {
      const which = account ?? relayerAddress;
      if (which === null || which === undefined || !ACCOUNT.test(which)) throw definite("the ledger lists the attempts of one account at a time");
      return (await query(`ATTEMPT#${which}`))
        .map((item) => parseAttempt(item, "attempt"))
        .map((entry) => ({ intent_id: entry.intent_id, tx_id: entry.tx_id, account: entry.account, sequence: entry.sequence, ...(entry.expires_after_height !== null ? { expires_after_height: entry.expires_after_height } : {}) }));
    },

    async takeOverRelayer() {
      if (relayerAddress === null) throw definite("this ledger instance was opened without a relayer account");
      const account = relayerAddress;
      const fenceKey = LEDGER_KEYS.fence(account);
      const current = await readItem(fenceKey);
      const was = current === null ? 0 : parseFence(current, account).epoch;
      const next = was + 1;
      /* ALWAYS a fresh random token, whatever `newToken` a test injected: the token NAMES who minted the epoch, and two
         identical mint requests would be answered as ONE idempotent write -- two holders of one fence. */
      const token = randomUUID();
      const item: Item = { ...fenceKey, schema: N(LEDGER_SCHEMA), kind: S("relayer-fence"), relayer: S(account), epoch: N(next), at: N(now()), generation: N(generation), token: S(token) };
      const condition =
        current === null
          ? { ConditionExpression: "attribute_not_exists(pk)" }
          : {
              ConditionExpression: "#schema = :schema AND #kind = :kind AND #epoch = :was AND #relayer = :relayer",
              ExpressionAttributeNames: { "#schema": "schema", "#kind": "kind", "#epoch": "epoch", "#relayer": "relayer" },
              ExpressionAttributeValues: { ":schema": N(LEDGER_SCHEMA), ":kind": S("relayer-fence"), ":was": N(was), ":relayer": S(account) },
            };
      const items: TransactWriteItem[] = [generationCheck(), { Put: { TableName: table, Item: item, ...condition } }];
      const mint = () => {
        held = { epoch: next, token };
        return { epoch: next };
      };
      let sent = await send(items, token);
      let detail = "";
      if (sent.kind === "unknown" || sent.kind === "in-progress") {
        detail = sent.detail;
        for (let resend = 0; resend < resends && (sent.kind === "unknown" || sent.kind === "in-progress"); resend += 1) {
          await sleep(Math.min(2_000, 250 * 2 ** resend));
          sent = await send(items, token);
          if (sent.kind !== "ok") detail = `${detail}; resend ${resend + 1}: ${sent.kind}`;
        }
        if (sent.kind !== "ok") {
          /* Settle by the fence itself: OUR token at our epoch -> minted; anything else -> not ours (an epoch number
             alone proves nothing: another task may have minted that very number). APPGEN is read first, then the fence
             (GetItems: they never conflict with a transaction in flight): a generation seen moved can never be passed
             afterwards, and a mint of ours that landed before that read is on the fence at the second. */
          let appgen: Item | null;
          let stored: Item | null;
          try {
            appgen = await readItem(LEDGER_KEYS.appgen());
            stored = await readItem(fenceKey);
          } catch (error) {
            throw uncertain(`the relayer takeover's outcome is unknown (${detail}; the settling read failed: ${describe(error)}); this task holds no new relayer epoch`);
          }
          const fence = stored === null ? null : parseFence(stored, account);
          if (fence !== null && fence.epoch === next && fence.token === token) return mint();
          if (fence !== null && fence.epoch > was) throw definite(`another task took the relayer fence first (epoch ${fence.epoch}); this task holds no new epoch`);
          if (!generationHolds(appgen)) {
            reportFenced("generation", generation, "the adopted generation moved during a relayer takeover");
            throw fenced(`the relayer takeover's outcome was unknown, and the ledger's generation is no longer ${generation}: it can never land`);
          }
          throw uncertain(`the relayer takeover's outcome is unknown (${detail}) and nothing of it is visible yet; this task holds no new relayer epoch`);
        }
      }
      if (sent.kind === "ok") return mint();
      if (sent.kind === "cancelled") {
        const codes = sent.reasons.map((reason) => reason.code);
        if (codes[0] === "ConditionalCheckFailed") {
          reportFenced("generation", generation, "a relayer takeover was refused by the generation fence");
          throw fenced(`the ledger's adopted generation is no longer ${generation}; no relayer epoch is minted`);
        }
        if (codes[1] === "ConditionalCheckFailed") throw definite(`another task moved the relayer fence of ${account} first (it was at ${was}); this task holds no new epoch`);
        throw definite(`the relayer takeover was cancelled (${codes.join(",")}); nothing was written and this task holds no new epoch`);
      }
      throw definite(`the relayer takeover was refused (${sent.detail}); this task holds no new epoch`);
    },
  };
}

/**
 * LIVE-5 L5-3: the ledger's adopted app generation (`APPGEN.current_generation`), read strongly -- `null` when none was
 * ever adopted. For the PoolWriter's self-check (preflight §5.5: a task whose generation is no longer the adopted one
 * exits). Strict, as every ledger read: an APPGEN item this build cannot read throws, and is never read as some other
 * generation. Reads only; the ledger's own writes keep carrying the generation inside every write.
 */
export async function readAdoptedGeneration(client: DynamoDBClient, table: string): Promise<number | null> {
  const key = LEDGER_KEYS.appgen();
  const answer = await client.send(new GetItemCommand({ TableName: table, Key: { pk: key.pk, sk: key.sk }, ConsistentRead: true }), { abortSignal: deadline() });
  return answer.Item === undefined ? null : parseAppGen(answer.Item as Item);
}
