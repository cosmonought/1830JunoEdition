// server/src/aws/deploy/hostcert/controlPlane.ts
//
// ==================================================================
//  COST-2C: THE AUTHORITIES, READ-ONLY -- WHO WRITES POOL p1, WHO HOLDS THE IDENTITY-WRITER AND RELAYER ROLES, WHAT MONEY
//  AND RELAYER WORK IS OPEN -- AND THE JUDGES OVER WHAT WAS READ
// ==================================================================
//
// Every read here goes through the deployment's OWN reader of that item, bound by `tools/awsDeploy.ts` (never a second
// parser): LIVE-6's `RotationReaders` (L5-3's `readRouting`, L5-2's `readPool`, L5-6's `readRelayerRole`, the ledger's
// `readRelayerFence`, L6-5A's `readTaskStatus`, the rotation gate's own RELAYQ# queue reader) and L5-4's `readIdentityRole`. The
// generation (APPGEN, SYSTEM/GENERATION, L6-4's startup rule) is read and judged by LIVE-6's `readGenerationEvidence` /
// `judgeGeneration` -- the staging certification's data-plane assertions, reused, not copied.
//
// The ONE read implemented here is the open-money count, and it parses NOTHING: FINKEYS (a set of identity keys), then
// every FINIDX#<key> partition, every page, strongly consistent; ANY item there is an open money game (as the rotation
// gate counts any RELAYQ# entry as open work). A FINKEYS item that is not a string set, or a read that fails, is UNKNOWN
// -- a disruptive drill is refused rather than run over money it could not count.
//
// Every answer keeps its four states (ok / absent / unreadable / unavailable): a read that failed is never "no holder",
// never "the expected holder". The judges below turn an unavailable read into NOT EVALUATED, an unreadable (damaged)
// item or a wrong value into FAIL.

import type { DynamoDBClient } from "@aws-sdk/client-dynamodb";

import { FINKEYS_KEY, getItem, queryAll } from "../../game/gameTable";
import type { RelayQueueState } from "../relayerRotation";
import { HOLDER_STATUS_MAX_AGE_MS, type HolderStatus, type ProofRead, type RotationReaders } from "../staging/rotationProof";
import type { RecoveryReaders } from "../staging/recovery";
import { decide, failed, passed, unknown, type CertCheck } from "./verdict";

/** The deployment's readers (bound in tools/awsDeploy.ts; absent: every authority read is NOT EVALUATED). */
export interface HostCertReaders {
  readonly rotation: RotationReaders;
  readonly recovery: RecoveryReaders;
  /** L5-4's `readIdentityRole` (the identity table's ROLE#identity-writer item, strongly; null: never taken). */
  readonly identityRole: (client: DynamoDBClient, identityTable: string) => Promise<{ readonly epoch: number; readonly task: string; readonly pool: string; readonly taken_at: number } | null>;
}

export type NotConfigured = { readonly state: "not-configured" };
export type MoneyState = { readonly state: "none" } | { readonly state: "open"; readonly count: number } | { readonly state: "unknown"; readonly detail: string };

export interface AuthoritySnapshot {
  readonly read_at_ms: number;
  readonly routing: ProofRead<{ readonly primary_pool: string; readonly routing_version: number }>;
  readonly pool: ProofRead<{ readonly writer_epoch: number; readonly writer_task: string | null }>;
  readonly identity: ProofRead<{ readonly epoch: number; readonly task: string; readonly pool: string }>;
  readonly relayer: ProofRead<{ readonly epoch: number; readonly task: string; readonly pool: string; readonly pool_epoch: number }> | NotConfigured;
  readonly relayer_fence: ProofRead<{ readonly epoch: number }> | NotConfigured;
  readonly holder: ProofRead<{ readonly task: string; readonly pool: string; readonly pool_epoch: number; readonly generation: number; readonly environment: string; readonly role: string; readonly ready: boolean; readonly updated_at: number }>;
  readonly relay_queue: { readonly state: "empty" } | { readonly state: "open"; readonly entries: number } | { readonly state: "unknown"; readonly detail: string } | NotConfigured;
  readonly open_money: MoneyState;
}

const UNREADABLE = /Unreadable|Corrupt|Newer|Damage|Malformed/;
const describe = (error: unknown): string => `${(error as { name?: string } | null)?.name ?? "Error"}: ${error instanceof Error ? error.message : String(error)}`.replace(/\s+/g, " ").slice(0, 240);

async function readAs<T>(run: () => Promise<T | null>): Promise<ProofRead<T>> {
  try {
    const value = await run();
    return value === null ? { state: "absent" } : { state: "ok", value };
  } catch (error) {
    return { state: UNREADABLE.test((error as { name?: string } | null)?.name ?? "") ? "unreadable" : "unavailable", detail: describe(error) };
  }
}

const notBound = { state: "unavailable", detail: "the deployment's readers are not bound in this build (tools/awsDeploy.ts)" } as const;

/** Every OPEN money game, counted without parsing (see the header). */
export async function openMoneyState(client: DynamoDBClient, table: string): Promise<MoneyState> {
  try {
    const keysItem = await getItem(client, table, FINKEYS_KEY);
    if (keysItem === null) return { state: "none" };
    const keys = keysItem.keys?.SS;
    if (!Array.isArray(keys) || keys.some((k) => typeof k !== "string" || k.length === 0 || k.length > 200)) return { state: "unknown", detail: "FINKEYS is not a set of identity keys: the open money games cannot be counted" };
    let count = 0;
    for (const identity of [...keys].sort()) count += (await queryAll(client, table, `FINIDX#${identity}`)).length;
    return count === 0 ? { state: "none" } : { state: "open", count };
  } catch (error) {
    return { state: "unknown", detail: `the open-money index could not be read completely (${describe(error)})` };
  }
}

export interface AuthorityTarget {
  readonly clients: { readonly app: DynamoDBClient; readonly ledger: DynamoDBClient };
  readonly tables: { readonly game: string; readonly identity: string; readonly ledger: string };
  readonly pool: string;
  /** The configured relayer account (null: no escrow in this deployment). */
  readonly relayer: string | null;
}

/** One reading of every authority (never throws: every failure is kept as what it was). */
export async function readAuthority(readers: HostCertReaders | undefined, target: AuthorityTarget, now: () => number): Promise<AuthoritySnapshot> {
  const { clients, tables } = target;
  const money = await openMoneyState(clients.app, tables.game);
  if (readers === undefined) {
    return { read_at_ms: now(), routing: notBound, pool: notBound, identity: notBound, relayer: notBound, relayer_fence: notBound, holder: notBound, relay_queue: { state: "unknown", detail: notBound.detail }, open_money: money };
  }
  const r = readers.rotation;
  const routing = await readAs(() => r.routing(clients.app, tables.game).then((v) => (v === null ? null : { primary_pool: v.primary_pool, routing_version: v.routing_version })));
  const pool = await readAs(() => r.pool(clients.app, tables.game, target.pool).then((v) => (v === null ? null : { writer_epoch: v.writer_epoch, writer_task: v.writer_task })));
  const identity = await readAs(() => readers.identityRole(clients.app, tables.identity).then((v) => (v === null ? null : { epoch: v.epoch, task: v.task, pool: v.pool })));
  const relayer: AuthoritySnapshot["relayer"] = target.relayer === null ? { state: "not-configured" } : await readAs(() => r.relayerRole(clients.app, tables.game, target.relayer as string).then((v) => (v === null ? null : { epoch: v.epoch, task: v.task, pool: v.pool, pool_epoch: v.pool_epoch })));
  const fence: AuthoritySnapshot["relayer_fence"] = target.relayer === null ? { state: "not-configured" } : await readAs(() => r.relayerFence(clients.ledger, tables.ledger, target.relayer as string).then((v) => (v === null ? null : { epoch: v.epoch })));
  const writer = pool.state === "ok" ? pool.value.writer_task : null;
  const holder: AuthoritySnapshot["holder"] =
    writer === null
      ? { state: "unavailable", detail: "no pool writer was read" }
      : await readAs(() =>
          r.taskStatus(clients.app, tables.game, writer).then((v: HolderStatus | null) => (v === null ? null : { task: v.task, pool: v.pool, pool_epoch: v.poolEpoch, generation: v.generation, environment: v.environment, role: v.role, ready: v.ready, updated_at: v.updatedAt })),
        );
  let queue: AuthoritySnapshot["relay_queue"];
  if (target.relayer === null) queue = { state: "not-configured" };
  else {
    try {
      const q: RelayQueueState = await r.relayQueue(clients.app, tables.game, target.relayer);
      queue = q.state === "empty" ? { state: "empty" } : q.state === "open" ? { state: "open", entries: q.entries } : { state: "unknown", detail: q.detail };
    } catch (error) {
      queue = { state: "unknown", detail: describe(error) };
    }
  }
  return { read_at_ms: now(), routing, pool, identity, relayer, relayer_fence: fence, holder, relay_queue: queue, open_money: money };
}

/* ------------------------------------------------------------------ */
/* Judges                                                               */
/* ------------------------------------------------------------------ */

const readCheck = (name: string, r: { readonly state: string; readonly detail?: string }, what: string): CertCheck =>
  r.state === "absent" ? failed(name, `${what} is absent`) : r.state === "unreadable" ? failed(name, `${what} exists but cannot be read (${r.detail ?? "damaged"}): never taken for a value`) : unknown(name, `${what} could not be read (${r.detail ?? "unavailable"})`);

export interface WriterExpect {
  readonly label: string;
  readonly pool: string;
  readonly environment: string;
  readonly generation: number;
  /** The task that must be the writer (the host's own process, from its banner), or null: whoever it is, judged as one. */
  readonly task: string | null;
  /** Whether the writer's own heartbeat must say READY (a serving host; false while a rival holds the pool). */
  readonly requireReady: boolean;
  readonly now: number;
}

/**
 * ONE current writer: the routing names the pool; POOL#<pool> names a writer (`expect.task` when given); the identity
 * writer and the relayer are held by THAT task, the relayer at THAT pool epoch with the ledger's fence at the mirror's
 * epoch; the writer's own heartbeat is this generation and environment, fresh (and ready, when required).
 */
export function judgeSingleWriter(snap: AuthoritySnapshot, expect: WriterExpect): CertCheck[] {
  const L = expect.label;
  const checks: CertCheck[] = [];
  const s = snap;
  checks.push(s.routing.state === "ok" ? decide(`${L}: SYSTEM/ROUTING names ${expect.pool}`, s.routing.value.primary_pool === expect.pool, `primary ${s.routing.value.primary_pool} (v${s.routing.value.routing_version})`, `the routing names ${s.routing.value.primary_pool}, not ${expect.pool}`) : readCheck(`${L}: SYSTEM/ROUTING`, s.routing, "SYSTEM/ROUTING"));
  if (s.pool.state !== "ok") {
    checks.push(readCheck(`${L}: POOL#${expect.pool}`, s.pool, `POOL#${expect.pool}`));
    return checks;
  }
  const writer = s.pool.value.writer_task;
  const epoch = s.pool.value.writer_epoch;
  checks.push(decide(`${L}: POOL#${expect.pool} has a writer`, writer !== null && epoch >= 1, `writer ${String(writer)} at epoch ${epoch}`, "the pool item names no writer"));
  if (writer === null) return checks;
  if (expect.task !== null) checks.push(decide(`${L}: the pool writer is the expected process`, writer === expect.task, `${writer}`, `the pool is written by ${writer}, not ${expect.task}`));
  checks.push(s.identity.state === "ok" ? decide(`${L}: the identity writer is the pool writer`, s.identity.value.task === writer && s.identity.value.pool === expect.pool, `${s.identity.value.task} (identity epoch ${s.identity.value.epoch})`, `the identity writer is ${s.identity.value.task} of ${s.identity.value.pool}, the pool writer ${writer}`) : readCheck(`${L}: the identity writer`, s.identity, "ROLE#identity-writer"));
  if (s.relayer.state === "not-configured") checks.push(passed(`${L}: the relayer`, "no escrow in this deployment: no relayer role"));
  else if (s.relayer.state !== "ok") checks.push(readCheck(`${L}: the relayer role`, s.relayer, "the relayer mirror"));
  else {
    const m = s.relayer.value;
    checks.push(decide(`${L}: the relayer is the pool writer, at its pool epoch`, m.task === writer && m.pool === expect.pool && m.pool_epoch === epoch, `${m.task} (relayer epoch ${m.epoch}, pool epoch ${m.pool_epoch})`, `the relayer mirror names ${m.task} of ${m.pool} at pool epoch ${m.pool_epoch}; the pool writer is ${writer} at ${epoch}`));
    if (s.identity.state === "ok") checks.push(decide(`${L}: the identity writer and the relayer agree`, s.identity.value.task === m.task, `both ${m.task}`, `the identity writer is ${s.identity.value.task}, the relayer ${m.task}: ownership moved inconsistently`));
    if (s.relayer_fence.state === "ok") checks.push(decide(`${L}: the ledger's relayer fence is the mirror's epoch`, s.relayer_fence.value.epoch === m.epoch, `fence epoch ${m.epoch}`, `the ledger's fence is ${s.relayer_fence.value.epoch}, the mirror's ${m.epoch} (a newer mint, or damage)`));
    else if (s.relayer_fence.state !== "not-configured") checks.push(readCheck(`${L}: the ledger's relayer fence`, s.relayer_fence, "FENCE#relayer"));
  }
  if (s.holder.state !== "ok") checks.push(readCheck(`${L}: the writer's own heartbeat (TASK#)`, s.holder, `TASK#${writer}`));
  else {
    const h = s.holder.value;
    const age = expect.now - h.updated_at;
    checks.push(decide(`${L}: the writer's heartbeat is this deployment`, h.task === writer && h.pool === expect.pool && h.pool_epoch === epoch && h.generation === expect.generation && h.environment === expect.environment, `${h.task}: ${h.environment} g${h.generation} ${h.pool} epoch ${h.pool_epoch}`, `the heartbeat says ${h.task}: ${h.environment} g${h.generation} ${h.pool} epoch ${h.pool_epoch}`));
    checks.push(decide(`${L}: the writer's heartbeat is fresh`, age >= -120_000 && age <= HOLDER_STATUS_MAX_AGE_MS, `${Math.round(age / 1000)} s old`, `the heartbeat is ${Math.round(age / 1000)} s old (more than ${HOLDER_STATUS_MAX_AGE_MS / 1000} s, or from the future)`));
    if (expect.requireReady) checks.push(decide(`${L}: the writer says it is the ready primary`, h.ready && h.role === "primary", "ready, primary", `ready ${String(h.ready)}, role ${h.role}`));
  }
  return checks;
}

/** Ownership MOVED from `before` to `after`: a new writer at a STRICTLY newer pool epoch, and both roles re-taken by it at
 *  strictly newer epochs. (Each snapshot must also pass `judgeSingleWriter` on its own.) */
export function judgeOwnershipMoved(label: string, before: AuthoritySnapshot, after: AuthoritySnapshot): CertCheck[] {
  const checks: CertCheck[] = [];
  if (before.pool.state !== "ok" || after.pool.state !== "ok") return [unknown(`${label}: the pool epoch moved`, "a pool reading is missing (before or after)")];
  const b = before.pool.value;
  const a = after.pool.value;
  checks.push(decide(`${label}: POOL epoch strictly newer`, a.writer_epoch > b.writer_epoch, `${b.writer_epoch} -> ${a.writer_epoch}`, `the pool epoch did not increase (${b.writer_epoch} -> ${a.writer_epoch}): the new process did not take the pool`));
  checks.push(decide(`${label}: a different writer process`, a.writer_task !== null && a.writer_task !== b.writer_task, `${String(b.writer_task)} -> ${String(a.writer_task)}`, `the writer is still ${String(a.writer_task)}`));
  if (before.identity.state === "ok" && after.identity.state === "ok") checks.push(decide(`${label}: identity-writer epoch strictly newer`, after.identity.value.epoch > before.identity.value.epoch, `${before.identity.value.epoch} -> ${after.identity.value.epoch}`, `the identity-writer epoch did not increase (${before.identity.value.epoch} -> ${after.identity.value.epoch})`));
  else checks.push(unknown(`${label}: identity-writer epoch strictly newer`, "an identity-writer reading is missing"));
  if (before.relayer.state === "not-configured" && after.relayer.state === "not-configured") checks.push(passed(`${label}: relayer epoch strictly newer`, "no escrow: no relayer"));
  else if (before.relayer.state === "ok" && after.relayer.state === "ok") checks.push(decide(`${label}: relayer epoch strictly newer`, after.relayer.value.epoch > before.relayer.value.epoch, `${before.relayer.value.epoch} -> ${after.relayer.value.epoch}`, `the relayer epoch did not increase (${before.relayer.value.epoch} -> ${after.relayer.value.epoch})`));
  else checks.push(unknown(`${label}: relayer epoch strictly newer`, "a relayer reading is missing"));
  return checks;
}

/** The pool did NOT move between two readings (a refused start, a preflight, a reboot on HOLD: no takeover happened). */
export function judgeOwnershipUnchanged(label: string, before: AuthoritySnapshot, after: AuthoritySnapshot): CertCheck {
  if (before.pool.state !== "ok" || after.pool.state !== "ok") return unknown(`${label}: no takeover`, "a pool reading is missing (before or after)");
  const b = before.pool.value;
  const a = after.pool.value;
  return decide(`${label}: no takeover`, a.writer_epoch === b.writer_epoch && a.writer_task === b.writer_task, `POOL still ${String(a.writer_task)} at epoch ${a.writer_epoch}`, `the pool moved ${String(b.writer_task)}@${b.writer_epoch} -> ${String(a.writer_task)}@${a.writer_epoch}`);
}

/** The disruptive drills' money preconditions: 0 open money games, RELAYQ empty (unknown is a refusal, never "none"). */
export function judgeQuiet(snap: AuthoritySnapshot, require: { readonly money: boolean; readonly relayQueue: boolean }): CertCheck[] {
  const checks: CertCheck[] = [];
  const m = snap.open_money;
  if (require.money) checks.push(m.state === "none" ? passed("no open money game", "FINKEYS / FINIDX#: none") : m.state === "open" ? failed("no open money game", `${m.count} open money game(s): a disruptive drill is refused`) : failed("no open money game", `UNKNOWN (${m.detail}): refused, never taken for none`));
  const q = snap.relay_queue;
  if (require.relayQueue) checks.push(q.state === "empty" || q.state === "not-configured" ? passed("RELAYQ empty", q.state === "empty" ? "RELAYQ#<relayer>: no entry (strongly consistent, every page)" : "no escrow: no relayer queue") : q.state === "open" ? failed("RELAYQ empty", `${q.entries} open relayer entr${q.entries === 1 ? "y" : "ies"}: a disruptive drill is refused`) : failed("RELAYQ empty", `UNKNOWN (${q.detail}): refused, never taken for empty`));
  return checks;
}

/** What the evidence keeps of a snapshot (identifiers, epochs, states; nothing else). */
export function authorityEvidence(snap: AuthoritySnapshot): Record<string, unknown> {
  const v = <T>(r: ProofRead<T> | NotConfigured): unknown => (r.state === "ok" ? r.value : r.state === "not-configured" ? "not-configured" : r.state === "absent" ? "absent" : `${r.state}: ${r.detail}`);
  return {
    read_at: new Date(snap.read_at_ms).toISOString(),
    routing: v(snap.routing),
    pool: v(snap.pool),
    identity_writer: v(snap.identity),
    relayer: v(snap.relayer),
    relayer_fence: v(snap.relayer_fence),
    writer_heartbeat: v(snap.holder),
    relay_queue: snap.relay_queue.state === "open" ? { state: "open", entries: snap.relay_queue.entries } : snap.relay_queue.state === "unknown" ? `unknown: ${snap.relay_queue.detail}` : snap.relay_queue.state,
    open_money: snap.open_money.state === "open" ? { state: "open", count: snap.open_money.count } : snap.open_money.state === "unknown" ? `unknown: ${snap.open_money.detail}` : "none",
  };
}

export const writerOf = (snap: AuthoritySnapshot): { readonly task: string | null; readonly epoch: number | null } => (snap.pool.state === "ok" ? { task: snap.pool.value.writer_task, epoch: snap.pool.value.writer_epoch } : { task: null, epoch: null });
