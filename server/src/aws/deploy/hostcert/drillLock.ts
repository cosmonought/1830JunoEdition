// server/src/aws/deploy/hostcert/drillLock.ts
//
// ==================================================================
//  COST-2C: THE STAGING DRILL LOCK -- ONE MUTATING HOST DRILL AT A TIME, A BOUNDED LEASE, EXPLICIT STALE-LOCK RECOVERY
// ==================================================================
//
// ONE item in the serving game table: pk `OPRUN#host-cert`, sk `LOCK` -- in the operator's own evidence partition
// (`OPRUN#*`, the operator role's PutItem grant, with exactly the attributes that grant allows: fmt, run, task, command,
// subject, note, started_at, tool, build, outcome, detail, at, claim). Operator runs are `OPRUN#op:r-<16 hex>`, so the
// name never collides with one, and no production path reads this partition: the lock is NEVER money authority, never a
// serving authority, never read by the server -- it only serialises operators of this tool.
//
//   acquire   PutItem, condition: no lock item, or the last one RELEASED. A lock HELD by anyone -- expired or not -- is
//             never taken silently: the caller is refused and told who holds it and until when.
//   reclaim   (stale-lock recovery) only with `--reclaim-stale-lock <that run id>`, naming the holder EXACTLY, and only
//             once its lease has EXPIRED (by more than the clock-skew allowance): PutItem, condition: held by exactly that
//             run AND its lease ended. The reclaimed run's claim token no longer matches, so its own renew / release
//             fails and it stops (fail closed).
//   renew     at every phase boundary of a running drill: PutItem, condition: held by THIS claim. A failed renew stops the
//             drill's mutations (cleanup still runs).
//   release   PutItem `outcome = released`, condition: held by THIS claim. Normal completion always releases.
//
// A write whose answer is lost is settled by reading the item back (strongly): ours (this claim) -> it applied; anything
// else -> it did not; an unreadable item -> UNKNOWN (refused). The lease is bounded (`at`, ms since the epoch); clocks
// differ, so an expiry is honoured only CLOCK_SKEW_MS after it.

import { randomBytes } from "crypto";

import { ConditionalCheckFailedException, GetItemCommand, PutItemCommand, type AttributeValue, type DynamoDBClient } from "@aws-sdk/client-dynamodb";

import { deadline } from "../../awsClients";

export const LOCK_FORMAT = 1;
export const LOCK_PK = "OPRUN#host-cert";
export const LOCK_SK = "LOCK";
export const CLOCK_SKEW_MS = 120_000;
/** Longest lease any scenario asks (a replacement spans two commands and a Terraform apply). */
export const MAX_LEASE_MS = 6 * 60 * 60_000;

export interface LockHolder {
  readonly run: string;
  readonly scenario: string;
  readonly instance: string;
  readonly operator: string;
  readonly started_at: number;
  readonly expires_at: number;
  readonly outcome: "held" | "released" | "reclaimed";
  readonly claim: string;
  readonly source_commit: string;
}

export type LockRead = { readonly state: "absent" } | { readonly state: "ok"; readonly holder: LockHolder } | { readonly state: "unreadable"; readonly detail: string } | { readonly state: "unavailable"; readonly detail: string };

export type LockOutcome = { readonly kind: "held"; readonly holder: LockHolder } | { readonly kind: "refused"; readonly detail: string; readonly holder: LockHolder | null } | { readonly kind: "unknown"; readonly detail: string };

const key = { pk: { S: LOCK_PK }, sk: { S: LOCK_SK } };
const describe = (error: unknown): string => `${(error as { name?: string } | null)?.name ?? "Error"}: ${error instanceof Error ? error.message : String(error)}`.replace(/\s+/g, " ").slice(0, 200);
const isConditionFailure = (error: unknown): boolean => error instanceof ConditionalCheckFailedException || (error as { name?: string } | null)?.name === "ConditionalCheckFailedException";

const NAMES = ["at", "build", "claim", "command", "detail", "fmt", "note", "outcome", "pk", "run", "sk", "started_at", "subject", "task", "tool"];

function decode(item: Record<string, AttributeValue>): LockHolder | string {
  const names = Object.keys(item).sort();
  if (names.join(",") !== NAMES.join(",")) return `the lock item has the attributes [${names.join(",").slice(0, 200)}], not this tool's`;
  const n = (name: string): number | null => (item[name]?.N !== undefined && /^[0-9]{1,16}$/.test(item[name].N as string) ? Number(item[name].N) : null);
  const s = (name: string): string | null => (typeof item[name]?.S === "string" ? (item[name].S as string) : null);
  const fmt = n("fmt");
  if (fmt !== LOCK_FORMAT) return `the lock item is format ${String(item.fmt?.N)}, not ${LOCK_FORMAT}`;
  const outcome = s("outcome");
  const started = n("started_at");
  const expires = n("at");
  const fields = [s("run"), s("task"), s("subject"), s("note"), s("claim"), s("build")];
  if (outcome !== "held" && outcome !== "released" && outcome !== "reclaimed") return "the lock item's outcome is not held / released / reclaimed";
  if (started === null || expires === null || fields.some((f) => f === null) || s("command") !== "host-cert-lock" || s("tool") !== "awsDeploy host-cert") return "the lock item is not well-formed";
  return { run: s("run") as string, scenario: s("task") as string, instance: s("subject") as string, operator: s("note") as string, started_at: started, expires_at: expires, outcome, claim: s("claim") as string, source_commit: s("build") as string };
}

export async function readLock(client: DynamoDBClient, table: string): Promise<LockRead> {
  try {
    const answer = await client.send(new GetItemCommand({ TableName: table, Key: key, ConsistentRead: true }), { abortSignal: deadline() });
    if (answer.Item === undefined) return { state: "absent" };
    const decoded = decode(answer.Item);
    return typeof decoded === "string" ? { state: "unreadable", detail: decoded } : { state: "ok", holder: decoded };
  } catch (error) {
    return { state: "unavailable", detail: describe(error) };
  }
}

function item(h: LockHolder, detail: string): Record<string, AttributeValue> {
  return {
    ...key,
    fmt: { N: String(LOCK_FORMAT) },
    run: { S: h.run },
    task: { S: h.scenario },
    command: { S: "host-cert-lock" },
    subject: { S: h.instance },
    note: { S: h.operator },
    started_at: { N: String(h.started_at) },
    tool: { S: "awsDeploy host-cert" },
    build: { S: h.source_commit },
    outcome: { S: h.outcome },
    detail: { S: detail.slice(0, 300) || "-" },
    at: { N: String(h.expires_at) },
    claim: { S: h.claim },
  };
}

const holderText = (h: LockHolder, now: number): string =>
  `run ${h.run} (${h.scenario} on ${h.instance}, operator ${h.operator}, ${h.outcome}${h.outcome === "held" ? `, lease ${h.expires_at > now ? `until ${new Date(h.expires_at).toISOString()}` : `EXPIRED at ${new Date(h.expires_at).toISOString()}`}` : ""})`;

/** One conditional put, its lost answer settled by reading back (ours = applied). */
async function put(client: DynamoDBClient, table: string, holder: LockHolder, detail: string, condition: { readonly expression: string; readonly values: Record<string, AttributeValue>; readonly names?: Record<string, string> }): Promise<"applied" | "condition" | { readonly unknown: string }> {
  try {
    await client.send(new PutItemCommand({ TableName: table, Item: item(holder, detail), ConditionExpression: condition.expression, ExpressionAttributeValues: condition.values, ...(condition.names !== undefined ? { ExpressionAttributeNames: condition.names } : {}) }), { abortSignal: deadline() });
    return "applied";
  } catch (error) {
    if (isConditionFailure(error)) return "condition";
    const back = await readLock(client, table);
    if (back.state === "ok" && back.holder.claim === holder.claim && back.holder.outcome === holder.outcome && back.holder.expires_at === holder.expires_at) return "applied";
    if (back.state === "ok" || back.state === "absent") return "condition";
    return { unknown: `the lock write's answer was lost (${describe(error)}) and the lock cannot be read back (${back.detail})` };
  }
}

export interface AcquireInput {
  readonly run: string;
  readonly scenario: string;
  readonly instance: string;
  readonly operator: string;
  readonly sourceCommit: string;
  readonly leaseMs: number;
  readonly now: number;
  /** Stale-lock recovery: the run id of the EXPIRED holder to take over (never a generic override). */
  readonly reclaim: string | null;
  /** Tests: a fixed claim token. */
  readonly claim?: string;
}

export async function acquireLock(client: DynamoDBClient, table: string, input: AcquireInput): Promise<LockOutcome> {
  if (!Number.isSafeInteger(input.leaseMs) || input.leaseMs < 60_000 || input.leaseMs > MAX_LEASE_MS) return { kind: "refused", detail: `a lease of ${input.leaseMs} ms is not between 1 minute and ${MAX_LEASE_MS / 3_600_000} hours`, holder: null };
  const mine: LockHolder = {
    run: input.run,
    scenario: input.scenario,
    instance: input.instance,
    operator: input.operator,
    started_at: input.now,
    expires_at: input.now + input.leaseMs,
    outcome: "held",
    claim: input.claim ?? randomBytes(16).toString("hex"),
    source_commit: input.sourceCommit,
  };
  const current = await readLock(client, table);
  if (current.state === "unreadable" || current.state === "unavailable") return { kind: "unknown", detail: `the drill lock cannot be read (${current.detail}): refused` };
  if (input.reclaim !== null) {
    if (current.state !== "ok" || current.holder.outcome !== "held") return { kind: "refused", detail: `--reclaim-stale-lock ${input.reclaim}: there is no HELD lock to reclaim (${current.state === "ok" ? current.holder.outcome : "no lock item"}); run without it`, holder: current.state === "ok" ? current.holder : null };
    if (current.holder.run !== input.reclaim) return { kind: "refused", detail: `--reclaim-stale-lock names ${input.reclaim}, but the lock is held by ${holderText(current.holder, input.now)}`, holder: current.holder };
    if (current.holder.expires_at + CLOCK_SKEW_MS >= input.now) return { kind: "refused", detail: `the lock of ${holderText(current.holder, input.now)} has not expired (plus ${CLOCK_SKEW_MS / 1000} s of clock skew): it is not stale`, holder: current.holder };
    const r = await put(client, table, mine, `reclaimed from ${current.holder.run} (lease ended ${new Date(current.holder.expires_at).toISOString()})`, {
      expression: "#run = :stale AND #outcome = :held AND #at < :limit",
      names: { "#run": "run", "#at": "at", "#outcome": "outcome" },
      values: { ":stale": { S: current.holder.run }, ":held": { S: "held" }, ":limit": { N: String(input.now - CLOCK_SKEW_MS) } },
    });
    if (r === "applied") return { kind: "held", holder: mine };
    return r === "condition" ? { kind: "refused", detail: "the stale lock changed while it was being reclaimed (another operator?): refused", holder: null } : { kind: "unknown", detail: r.unknown };
  }
  if (current.state === "ok" && current.holder.outcome === "held") {
    const stale = current.holder.expires_at + CLOCK_SKEW_MS < input.now;
    return { kind: "refused", detail: `another host-cert drill holds the lock: ${holderText(current.holder, input.now)}${stale ? `. Its lease ended: if that run is truly gone (check the host: no gs-cert drop-in, no rival container), recover with --reclaim-stale-lock ${current.holder.run}` : ""}`, holder: current.holder };
  }
  const r = await put(client, table, mine, `acquired for ${input.scenario}`, { expression: "attribute_not_exists(#pk) OR #outcome <> :held", names: { "#pk": "pk", "#outcome": "outcome" }, values: { ":held": { S: "held" } } });
  if (r === "applied") return { kind: "held", holder: mine };
  if (r === "condition") {
    const now = await readLock(client, table);
    return { kind: "refused", detail: `another host-cert drill took the lock first${now.state === "ok" ? `: ${holderText(now.holder, input.now)}` : ""}`, holder: now.state === "ok" ? now.holder : null };
  }
  return { kind: "unknown", detail: r.unknown };
}

/** Extend THIS claim's lease (a held lock whose claim is ours; never anyone else's). */
export async function renewLock(client: DynamoDBClient, table: string, held: LockHolder, now: number, leaseMs: number): Promise<LockOutcome> {
  const next: LockHolder = { ...held, expires_at: now + Math.min(leaseMs, MAX_LEASE_MS) };
  const r = await put(client, table, next, `renewed for ${held.scenario}`, { expression: "#claim = :claim AND #outcome = :held", names: { "#claim": "claim", "#outcome": "outcome" }, values: { ":claim": { S: held.claim }, ":held": { S: "held" } } });
  if (r === "applied") return { kind: "held", holder: next };
  return r === "condition" ? { kind: "refused", detail: "the drill lock is no longer this run's (reclaimed as stale, or released): stop", holder: null } : { kind: "unknown", detail: r.unknown };
}

/** Release THIS claim's lock (normal completion; also after a refusal or a failure). */
export async function releaseLock(client: DynamoDBClient, table: string, held: LockHolder, now: number, detail: string): Promise<LockOutcome> {
  const done: LockHolder = { ...held, outcome: "released", expires_at: now };
  const r = await put(client, table, done, detail, { expression: "#claim = :claim AND #outcome = :held", names: { "#claim": "claim", "#outcome": "outcome" }, values: { ":claim": { S: held.claim }, ":held": { S: "held" } } });
  if (r === "applied") return { kind: "held", holder: done };
  return r === "condition" ? { kind: "refused", detail: "the drill lock was no longer this run's at release (reclaimed?)", holder: null } : { kind: "unknown", detail: r.unknown };
}
