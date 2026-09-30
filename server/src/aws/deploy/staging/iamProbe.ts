// server/src/aws/deploy/staging/iamProbe.ts
//
// ==================================================================
//  LIVE-6 L6-6 §3: THE TASK ROLE'S DYNAMODB AUTHORITY, PROBED INSIDE REAL TRANSACTIONS -- AND NOTHING EVER WRITTEN
// ==================================================================
//
// L5-8 grants the task role Put/Update/Delete on the game table EXCEPT the `SYSTEM` partition, and PutItem on the ledger
// EXCEPT `APPGEN` (`dynamodb:LeadingKeys`), and calls those exclusions defence in depth that staging must confirm are
// enforced INSIDE `TransactWriteItems` (infra/aws/README.md "IAM"). This probe is that confirmation, run AS THE TASK ROLE
// (the certifier task: infra/aws/scripts/run-task-probe) against the real tables.
//
// WHY IT CANNOT WRITE. DynamoDB authorises a request before it evaluates any condition. Every write action here carries
//
//     attribute_exists(#l6n) AND #l6n = :nonce        (#l6n = l6_6_probe_nonce, :nonce = 32 random hex, new per run)
//
// on an item that does not carry that attribute -- a condition that can never hold. So:
//
//   IAM refuses          -> AccessDeniedException, nothing evaluated, nothing written        (a FORBIDDEN shape: expected)
//   IAM allows           -> the condition is evaluated and fails: ConditionalCheckFailed,    (an ALLOWED shape: expected;
//                           nothing written                                                    a forbidden one: FAIL)
//
// and the keys are ones no record uses: the game table's `SYSTEM / L6CERT-<run>` (never ROUTING) and the disposable
// `L6CERT#<run> / IAM`; on the ledger, `APPGEN` itself for the forbidden Put (the impossible condition protects it) and
// `L6CERT#<run> / IAM`. The only non-write actions are ConditionChecks of `attribute_exists(pk)` on SYSTEM/ROUTING and
// APPGEN -- the shapes the task genuinely sends. `iamProbeWriteProblem` refuses to send anything else.
//
// IDENTITY. An AccessDenied names the principal: the denial must name `assumed-role/gs-<env>-app-task/`, so the probe is
// attributable to the task role (the bootstrap role, which MAY put SYSTEM/*, would show up as unexpected authority).
//
// OUTCOMES (each probe; the record keeps the raw answer -- error name, cancellation codes, the principal's role name --
// and the certification re-judges it):
//   denied-as-expected / authorized-as-expected                                         PASS
//   unexpected-write-authority    a forbidden shape reached condition evaluation         FAIL
//   unexpected-write-applied      the service answered success (it cannot: the condition is impossible)  FAIL
//   authorized-shape-refused      an allowed shape was denied (the task cannot work)     FAIL
//   denied-not-the-task-role      the denial names another principal                     FAIL
//   malformed-probe               the request itself was refused (validation, no table)  FAIL
//   infrastructure-failure        throttling, a timeout, a fault, a credential problem   FAIL

import { randomBytes } from "crypto";
import { PutItemCommand, TransactWriteItemsCommand, DeleteItemCommand, type AttributeValue, type DynamoDBClient, type TransactWriteItem } from "@aws-sdk/client-dynamodb";

import { deadline } from "../../awsClients";
import type { Check } from "../deployVerify";
import { disposablePartition, forbiddenSystemSortKey, judge, obj, arr, str } from "./evidence";

export const PROBE_NONCE_ATTRIBUTE = "l6_6_probe_nonce";

export type IamExpect = "deny" | "allow";
export type IamOutcome =
  | "denied-as-expected"
  | "authorized-as-expected"
  | "unexpected-write-authority"
  | "unexpected-write-applied"
  | "authorized-shape-refused"
  | "denied-not-the-task-role"
  | "malformed-probe"
  | "infrastructure-failure";

export interface IamProbeSpec {
  readonly id: string;
  readonly table: "game" | "ledger";
  readonly expect: IamExpect;
  readonly what: string;
  /** A transaction (its items) or a single PutItem. */
  readonly transact?: readonly TransactWriteItem[];
  readonly put?: { readonly Item: Record<string, AttributeValue>; readonly ConditionExpression: string; readonly ExpressionAttributeNames: Record<string, string>; readonly ExpressionAttributeValues: Record<string, AttributeValue> };
  /** allow: the action whose impossible condition must be the one that failed. */
  readonly probeIndex: number;
}

/** Who an AccessDenied names: the assumed role's NAME only (never the account or the session), another principal, or
 *  nobody. */
export type IamPrincipal = { readonly kind: "assumed-role"; readonly role: string } | { readonly kind: "other" } | null;

/** The raw answer, as the record keeps it (no message text: only the name, the codes and the principal's role name). */
export type IamAnswer = { readonly kind: "success" } | { readonly kind: "error"; readonly name: string; readonly reasons: readonly string[]; readonly principal: IamPrincipal };

export interface IamProbeResult {
  readonly id: string;
  readonly table: "game" | "ledger";
  readonly expect: IamExpect;
  readonly what: string;
  readonly item_count: number;
  readonly probe_index: number;
  readonly answer: IamAnswer;
  readonly cleanup?: { readonly attempted: boolean; readonly outcome: string };
}

const S = (value: string): AttributeValue => ({ S: value });
const key = (pk: string, sk: string) => ({ pk: S(pk), sk: S(sk) });

const impossible = (nonce: string) => ({
  ConditionExpression: "attribute_exists(#l6n) AND #l6n = :l6n",
  ExpressionAttributeNames: { "#l6n": PROBE_NONCE_ATTRIBUTE },
  ExpressionAttributeValues: { ":l6n": S(nonce) },
});

/** A fresh nonce (the impossible condition's value; it also marks any item a broken authority might have written). */
export const newProbeNonce = (): string => randomBytes(16).toString("hex");

/** The probes, in the order they run. `ledgerTable` is the ledger's table ARN (cross-account). */
export function iamProbeSpecs(ctx: { readonly run: string; readonly gameTable: string; readonly ledgerTable: string; readonly nonce: string }): IamProbeSpec[] {
  const { run, gameTable, ledgerTable, nonce } = ctx;
  const disposable = disposablePartition(run);
  const systemKey = key("SYSTEM", forbiddenSystemSortKey(run));
  const gameDisposableKey = key(disposable, "IAM");
  const ledgerDisposableKey = key(disposable, "IAM");
  const appgenKey = key("APPGEN", "APPGEN");
  const marker = { l6_6_probe: S("iam"), l6_6_run: S(run), [PROBE_NONCE_ATTRIBUTE]: S(nonce) };
  const put = (table: string, k: Record<string, AttributeValue>): TransactWriteItem => ({ Put: { TableName: table, Item: { ...k, ...marker }, ...impossible(nonce) } });
  const update = (table: string, k: Record<string, AttributeValue>): TransactWriteItem => ({
    Update: {
      TableName: table,
      Key: k,
      UpdateExpression: "SET #l6r = :l6r",
      ConditionExpression: "attribute_exists(#l6n) AND #l6n = :l6n",
      ExpressionAttributeNames: { "#l6n": PROBE_NONCE_ATTRIBUTE, "#l6r": "l6_6_run" },
      ExpressionAttributeValues: { ":l6n": S(nonce), ":l6r": S(run) },
    },
  });
  const del = (table: string, k: Record<string, AttributeValue>): TransactWriteItem => ({ Delete: { TableName: table, Key: k, ...impossible(nonce) } });
  const exists = (table: string, k: Record<string, AttributeValue>): TransactWriteItem => ({ ConditionCheck: { TableName: table, Key: k, ConditionExpression: "attribute_exists(pk)" } });
  const routing = key("SYSTEM", "ROUTING");
  return [
    { id: "game-deny-transact-put-system", table: "game", expect: "deny", what: "TransactWriteItems Put on SYSTEM/*", transact: [put(gameTable, systemKey)], probeIndex: 0 },
    { id: "game-deny-transact-update-system", table: "game", expect: "deny", what: "TransactWriteItems Update on SYSTEM/*", transact: [update(gameTable, systemKey)], probeIndex: 0 },
    { id: "game-deny-transact-delete-system", table: "game", expect: "deny", what: "TransactWriteItems Delete on SYSTEM/*", transact: [del(gameTable, systemKey)], probeIndex: 0 },
    {
      id: "game-deny-transact-mixed",
      table: "game",
      expect: "deny",
      what: "one transaction: the routing check + an allowed Put + a SYSTEM Put (the whole transaction is denied)",
      transact: [exists(gameTable, routing), put(gameTable, gameDisposableKey), put(gameTable, systemKey)],
      probeIndex: 2,
    },
    { id: "game-deny-putitem-system", table: "game", expect: "deny", what: "PutItem on SYSTEM/*", put: { Item: { ...systemKey, ...marker }, ...impossible(nonce) }, probeIndex: 0 },
    {
      id: "game-allow-transact-check-routing-put",
      table: "game",
      expect: "allow",
      what: "the task's shape: ConditionCheck SYSTEM/ROUTING + Put on a non-SYSTEM key",
      transact: [exists(gameTable, routing), put(gameTable, gameDisposableKey)],
      probeIndex: 1,
    },
    { id: "game-allow-transact-update", table: "game", expect: "allow", what: "TransactWriteItems Update on a non-SYSTEM key", transact: [update(gameTable, gameDisposableKey)], probeIndex: 0 },
    { id: "game-allow-transact-delete", table: "game", expect: "allow", what: "TransactWriteItems Delete on a non-SYSTEM key", transact: [del(gameTable, gameDisposableKey)], probeIndex: 0 },
    { id: "ledger-deny-transact-put-appgen", table: "ledger", expect: "deny", what: "TransactWriteItems Put on APPGEN", transact: [put(ledgerTable, appgenKey)], probeIndex: 0 },
    { id: "ledger-deny-putitem-appgen", table: "ledger", expect: "deny", what: "PutItem on APPGEN", put: { Item: { ...appgenKey, ...marker }, ...impossible(nonce) }, probeIndex: 0 },
    { id: "ledger-deny-transact-update", table: "ledger", expect: "deny", what: "TransactWriteItems Update on the ledger (no UpdateItem at all)", transact: [update(ledgerTable, ledgerDisposableKey)], probeIndex: 0 },
    { id: "ledger-deny-transact-delete", table: "ledger", expect: "deny", what: "TransactWriteItems Delete on the ledger (no DeleteItem at all)", transact: [del(ledgerTable, ledgerDisposableKey)], probeIndex: 0 },
    {
      id: "ledger-allow-transact-check-appgen-put",
      table: "ledger",
      expect: "allow",
      what: "the ledger's shape: ConditionCheck APPGEN + Put on a non-APPGEN key",
      transact: [exists(ledgerTable, appgenKey), put(ledgerTable, ledgerDisposableKey)],
      probeIndex: 1,
    },
  ];
}

/* ------------------------------------------------------------------ */
/* The guard: nothing but the shapes above is ever sent                 */
/* ------------------------------------------------------------------ */

/** Why `spec` must not be sent (`null`: it may). Every write targets an allowed probe key and carries the impossible
 *  condition with this run's nonce; every check is `attribute_exists(pk)` on SYSTEM/ROUTING or APPGEN. */
export function iamProbeWriteProblem(spec: IamProbeSpec, ctx: { readonly run: string; readonly gameTable: string; readonly ledgerTable: string; readonly nonce: string }): string | null {
  const table = spec.table === "game" ? ctx.gameTable : ctx.ledgerTable;
  const keyText = (k: Record<string, AttributeValue> | undefined) => `${k?.pk?.S ?? "?"}/${k?.sk?.S ?? "?"}`;
  const writable =
    spec.table === "game"
      ? [`SYSTEM/${forbiddenSystemSortKey(ctx.run)}`, `${disposablePartition(ctx.run)}/IAM`]
      : ["APPGEN/APPGEN", `${disposablePartition(ctx.run)}/IAM`];
  const checkable = spec.table === "game" ? ["SYSTEM/ROUTING"] : ["APPGEN/APPGEN"];
  const guardsWrite = (c: { ConditionExpression?: string; ExpressionAttributeNames?: Record<string, string>; ExpressionAttributeValues?: Record<string, AttributeValue> }) =>
    c.ConditionExpression === "attribute_exists(#l6n) AND #l6n = :l6n" && c.ExpressionAttributeNames?.["#l6n"] === PROBE_NONCE_ATTRIBUTE && c.ExpressionAttributeValues?.[":l6n"]?.S === ctx.nonce;
  if (spec.put !== undefined) {
    if (spec.transact !== undefined) return "a probe is a transaction or a PutItem, not both";
    const k = keyText(spec.put.Item);
    if (!writable.includes(k)) return `PutItem on ${k}`;
    if (!guardsWrite(spec.put)) return `PutItem on ${k} without the impossible condition`;
    return null;
  }
  const items = spec.transact ?? [];
  if (items.length === 0) return "an empty transaction";
  for (const item of items) {
    if (item.ConditionCheck !== undefined) {
      const c = item.ConditionCheck;
      if (c.TableName !== table || !checkable.includes(keyText(c.Key)) || c.ConditionExpression !== "attribute_exists(pk)") return `a ConditionCheck on ${keyText(c.Key)}`;
      continue;
    }
    const write = item.Put ?? item.Update ?? item.Delete;
    if (write === undefined) return "an action that is neither a check nor a write";
    const k = keyText(item.Put !== undefined ? item.Put.Item : (write as { Key?: Record<string, AttributeValue> }).Key);
    if (write.TableName !== table) return `a write to ${String(write.TableName)}`;
    if (!writable.includes(k)) return `a write to ${k}`;
    if (item.Put !== undefined && k === "APPGEN/APPGEN" && spec.expect !== "deny") return "APPGEN is only ever the target of a probe expected to be DENIED";
    if (!guardsWrite(write)) return `a write to ${k} without the impossible condition`;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Classification                                                       */
/* ------------------------------------------------------------------ */

const MALFORMED = new Set(["ValidationException", "ResourceNotFoundException", "SerializationException", "IdempotentParameterMismatchException", "ItemCollectionSizeLimitExceededException"]);
const DENIED = "AccessDeniedException";

/** The principal an AccessDenied names (its role name only; the account and session are never kept). */
export function principalOf(message: string): IamPrincipal {
  const assumed = /arn:aws[a-z-]*:sts::\d{12}:assumed-role\/([A-Za-z0-9+=,.@_-]{1,64})\//.exec(message);
  if (assumed !== null) return { kind: "assumed-role", role: assumed[1] };
  if (/arn:aws[a-z-]*:(?:iam|sts)::\d{12}:/.test(message)) return { kind: "other" };
  return null;
}

/** The raw answer of one send (never the message text). */
export function answerOf(error: unknown): IamAnswer {
  if (error === null) return { kind: "success" };
  const name = (error as { name?: string } | null)?.name ?? "Error";
  const message = error instanceof Error ? error.message : String(error);
  const reasons = ((error as { CancellationReasons?: Array<{ Code?: string }> }).CancellationReasons ?? []).map((r) => r.Code ?? "None");
  return { kind: "error", name, reasons, principal: name === DENIED ? principalOf(message) : null };
}

/** One probe's outcome, from its raw answer (pure: the probe and the certification both use it). */
export function classifyIamAnswer(result: Pick<IamProbeResult, "expect" | "answer" | "item_count" | "probe_index">, expectedRole: string): { readonly outcome: IamOutcome; readonly detail: string } {
  const a = result.answer;
  if (a.kind === "success") return { outcome: "unexpected-write-applied", detail: "the service answered success to a write whose condition can never hold" };
  if (a.name === DENIED) {
    if (result.expect === "allow") return { outcome: "authorized-shape-refused", detail: "an allowed shape was denied: the task could not do its own writes" };
    if (a.principal !== null && a.principal.kind === "assumed-role" && a.principal.role === expectedRole) return { outcome: "denied-as-expected", detail: `AccessDenied for assumed-role/${expectedRole}` };
    return { outcome: "denied-not-the-task-role", detail: `the denial names ${a.principal === null ? "no principal" : a.principal.kind === "assumed-role" ? `assumed-role/${a.principal.role}` : "another principal"}, not assumed-role/${expectedRole}` };
  }
  if (a.name === "ConditionalCheckFailedException") {
    return result.expect === "deny"
      ? { outcome: "unexpected-write-authority", detail: "a forbidden write was AUTHORIZED (it reached condition evaluation; nothing was written)" }
      : { outcome: "authorized-as-expected", detail: "authorized; its impossible condition failed; nothing written" };
  }
  if (a.name === "TransactionCanceledException") {
    const codes = a.reasons;
    if (result.expect === "deny") {
      if (codes.includes("ConditionalCheckFailed")) return { outcome: "unexpected-write-authority", detail: `a forbidden transaction was AUTHORIZED (cancelled [${codes.join(",")}]; nothing was written)` };
    } else {
      const shaped = codes.length === result.item_count && codes[result.probe_index] === "ConditionalCheckFailed" && codes.every((c, i) => i === result.probe_index || c === "None");
      if (shaped) return { outcome: "authorized-as-expected", detail: `authorized; cancelled [${codes.join(",")}] by the impossible condition; nothing written` };
      if (codes.some((c) => c === "ValidationError")) return { outcome: "malformed-probe", detail: `cancelled [${codes.join(",")}]` };
      if (codes.some((c, i) => i !== result.probe_index && c === "ConditionalCheckFailed")) return { outcome: "malformed-probe", detail: `a check term failed [${codes.join(",")}] (is SYSTEM/ROUTING or APPGEN missing? the prerequisite requires both)` };
    }
    if (codes.some((c) => c === "ValidationError")) return { outcome: "malformed-probe", detail: `cancelled [${codes.join(",")}]` };
    return { outcome: "infrastructure-failure", detail: `cancelled [${codes.join(",")}] (a conflict or throttling: run it again)` };
  }
  if (MALFORMED.has(a.name)) return { outcome: "malformed-probe", detail: a.name };
  return { outcome: "infrastructure-failure", detail: `${a.name} (throttling, a timeout, a service fault or a credential problem: nothing is concluded)` };
}

const EXPECTED: Readonly<Record<IamExpect, IamOutcome>> = { deny: "denied-as-expected", allow: "authorized-as-expected" };

/** Each probe's shape as THIS build defines it (the certification never takes a probe's expectation from the record). */
const SPEC_SHAPES: ReadonlyMap<string, { readonly expect: IamExpect; readonly itemCount: number; readonly probeIndex: number }> = new Map(
  iamProbeSpecs({ run: "x-x-x-x", gameTable: "g", ledgerTable: "l", nonce: "n" }).map((s) => [s.id, { expect: s.expect, itemCount: s.transact?.length ?? 1, probeIndex: s.probeIndex }] as const),
);

/** The certification's judgement of the recorded results. Every probe in `iamProbeSpecs` must be present, once, and is
 *  judged against the SPEC's expectation, action count and probe index (a record claiming "allow" for a forbidden shape
 *  is a failure, not a pass). */
export function judgeIamProbe(section: unknown, expectedRole: string, expectedIds: readonly string[]): Check[] {
  const results = arr(obj(section).results).map(obj);
  const checks: Check[] = [];
  const seen = new Set<string>();
  for (const r of results) {
    const id = str(r.id) ?? "?";
    const spec = SPEC_SHAPES.get(id);
    if (spec === undefined || seen.has(id)) {
      checks.push(judge(`IAM ${id}`, false, "", spec === undefined ? "not a probe this build defines" : "recorded twice"));
      continue;
    }
    seen.add(id);
    const expect = spec.expect;
    const answer = obj(r.answer);
    if (r.expect !== spec.expect || Number(r.item_count) !== spec.itemCount || Number(r.probe_index) !== spec.probeIndex || (answer.kind !== "success" && answer.kind !== "error")) {
      checks.push(judge(`IAM ${id}`, false, "", `the recorded result is not this probe's (expect ${String(r.expect)}, ${String(r.item_count)} action(s), index ${String(r.probe_index)}; the probe is ${spec.expect}, ${spec.itemCount}, ${spec.probeIndex})`));
      continue;
    }
    const principal = obj(answer.principal);
    const shaped: IamAnswer =
      answer.kind === "success"
        ? { kind: "success" }
        : {
            kind: "error",
            name: String(answer.name),
            reasons: arr(answer.reasons).map(String),
            principal: principal.kind === "assumed-role" ? { kind: "assumed-role", role: String(principal.role) } : principal.kind === "other" ? { kind: "other" } : null,
          };
    const verdict = classifyIamAnswer({ expect, answer: shaped, item_count: spec.itemCount, probe_index: spec.probeIndex }, expectedRole);
    checks.push(judge(`IAM ${id}`, verdict.outcome === EXPECTED[expect], `${verdict.outcome}: ${verdict.detail}`, `${verdict.outcome}: ${verdict.detail}`));
  }
  const missing = expectedIds.filter((id) => !seen.has(id));
  checks.push(judge("IAM: every probe ran", missing.length === 0 && results.length === expectedIds.length, `${expectedIds.length} probes`, `missing [${missing.join(", ")}] (a skipped probe is a failure)`));
  return checks;
}

/* ------------------------------------------------------------------ */
/* Running it                                                           */
/* ------------------------------------------------------------------ */

export interface IamProbeClients {
  readonly game: DynamoDBClient;
  readonly ledger: DynamoDBClient;
}

/** Send every probe once (as whoever the clients' credentials are: the task role, in the certifier task). */
export async function runIamProbe(clients: IamProbeClients, ctx: { readonly run: string; readonly gameTable: string; readonly ledgerTable: string; readonly nonce: string }): Promise<{ readonly results: IamProbeResult[] }> {
  const results: IamProbeResult[] = [];
  for (const spec of iamProbeSpecs(ctx)) {
    const problem = iamProbeWriteProblem(spec, ctx);
    if (problem !== null) throw new Error(`the IAM probe ${spec.id} would send ${problem}: refused before sending`);
    const client = spec.table === "game" ? clients.game : clients.ledger;
    const table = spec.table === "game" ? ctx.gameTable : ctx.ledgerTable;
    let failure: unknown = null;
    try {
      if (spec.put !== undefined) await client.send(new PutItemCommand({ TableName: table, ...spec.put }), { abortSignal: deadline() });
      else await client.send(new TransactWriteItemsCommand({ TransactItems: spec.transact as TransactWriteItem[] }), { abortSignal: deadline() });
    } catch (error) {
      failure = error;
    }
    const answer = answerOf(failure);
    const itemCount = spec.transact?.length ?? 1;
    let cleanup: IamProbeResult["cleanup"];
    if (answer.kind === "success") cleanup = await removeMarked(client, table, spec, ctx.nonce);
    results.push({ id: spec.id, table: spec.table, expect: spec.expect, what: spec.what, item_count: itemCount, probe_index: spec.probeIndex, answer, ...(cleanup === undefined ? {} : { cleanup }) });
  }
  return { results };
}

/** After an (impossible) success: delete exactly the items this run's nonce marks -- never anything else. */
async function removeMarked(client: DynamoDBClient, table: string, spec: IamProbeSpec, nonce: string): Promise<{ attempted: boolean; outcome: string }> {
  const keys: Array<Record<string, AttributeValue>> = [];
  if (spec.put !== undefined) keys.push({ pk: spec.put.Item.pk, sk: spec.put.Item.sk });
  for (const item of spec.transact ?? []) if (item.Put?.Item !== undefined) keys.push({ pk: item.Put.Item.pk, sk: item.Put.Item.sk });
  const outcomes: string[] = [];
  for (const k of keys) {
    try {
      await client.send(new DeleteItemCommand({ TableName: table, Key: k, ConditionExpression: "#l6n = :l6n", ExpressionAttributeNames: { "#l6n": PROBE_NONCE_ATTRIBUTE }, ExpressionAttributeValues: { ":l6n": S(nonce) } }), { abortSignal: deadline() });
      outcomes.push(`${k.pk?.S}/${k.sk?.S} removed`);
    } catch (error) {
      outcomes.push(`${k.pk?.S}/${k.sk?.S}: ${(error as { name?: string }).name ?? "Error"}`);
    }
  }
  return { attempted: keys.length > 0, outcome: outcomes.join("; ") || "nothing to remove" };
}

export const IAM_PROBE_IDS: readonly string[] = Object.freeze(iamProbeSpecs({ run: "x-x-x-x", gameTable: "g", ledgerTable: "l", nonce: "n" }).map((s) => s.id));
