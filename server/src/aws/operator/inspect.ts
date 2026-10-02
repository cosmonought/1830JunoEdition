// server/src/aws/operator/inspect.ts
//
// ==================================================================
//  LIVE-6 L6-3: WHAT THE AWS DEPLOYMENT HOLDS, READ-ONLY -- ROUTING, APPGEN, POOLS, ROLES, AND WHO OWNS A GAME
// ==================================================================
//
// Every answer here is a STRONG read of the item that decides it, through the production reader of that item wherever
// one exists (`readRouting`, `readAdoptedGeneration`, `readIdentityRole`, `readRelayerRole`, the ledger's
// `readRelayerFence`, the L5-2 record / hold / financial stores' own `load`), and every answer says which of FOUR things
// it is -- never collapsing them:
//
//   absent        there is no such item;
//   ok            the item, as this build reads it;
//   unreadable    the item EXISTS and this build cannot read it -- damaged (`corrupt`) or a later build's (`newer`). It is
//                 never read as absent, never as some other value, and nothing is ever written over it;
//   unavailable   the READ failed (a timeout, throttling, access denied): nothing is known.
//
// Two items have no strict production reader, because their production readers are the conditions inside the writes
// (`gameFence`, `poolFence`) and the pool writer's tolerant self-check: the game's HEAD and the pool item. They are
// parsed here exactly as their writers write them (`gameTable.ts` `headCreateOrMine`, the log's HEAD update, `claimGame`,
// `releaseGame`; `takeOverPool`), and an attribute this build never writes makes the HEAD `unreadable` (`newer`) -- the
// HEAD is the fence item, so the operator never acts on one it does not fully understand -- and is listed as `extra` on
// a pool item (a later slice may add pool status; every mutation still refuses a pool item it does not fully read).
//
// OWNERSHIP (`ownerOf`) is decided from the HEAD and the owner pool's item together, as the fences decide it:
//   released     `owner_pool` = "#none": nobody writes it; the next claim takes it;
//   current      the owner's epoch IS its pool's newest: that pool's current task may be serving it now (whether the
//                process is alive, the table cannot say -- and nothing here needs to);
//   superseded   the owner's pool has a NEWER epoch: the owning task is stale (fenced from any pool-fenced write, and from
//                this game the moment anyone else claims it) -- its pool's current task, or an operator, may take it;
//   operator     an operator run (`op:<run>`) holds it: players are routed away until the run releases it;
//   orphaned     the HEAD names a pool that has no pool item: nothing proves the owner stale -- never taken;
//   ahead        the HEAD names an epoch its pool never reached: damage -- never taken;
//   inconsistent the HEAD's epoch is the pool's newest but names another task: damage -- never taken;
//   unknown      the HEAD or the pool item could not be read or understood.

import type { DynamoDBClient } from "@aws-sdk/client-dynamodb";

import { DIRKEYS_KEY, FINKEYS_KEY, gamePk, getItem, headKey, key, NO_OWNER, poolKey, queryAll, TICKETS_SK, type Item } from "../game/gameTable";
import { createDynamoFinancialStore } from "../game/dynamoFinancialStore";
import { createDynamoHoldStore } from "../game/dynamoHoldStore";
import { createDynamoRecordStore } from "../game/dynamoRecordStore";
import { decodeItem, keyAttributes, keys as identityKeys, type DecodedItem } from "../identity/identityItems";
import { parseWalletTicketFile } from "../../escrow/walletTicketFileStore";
import type { WalletTicketDocument } from "../../escrow/walletTickets";
import type { IdentitySnapshot, Principal, Profile, SessionFamily } from "../../identity/store";
import { collectWalletGrants, type WalletGrantsView } from "../../tools/walletGrants";
import { readRelayerRole, RelayerRoleUnreadableError, type RelayerRoleRecord } from "../game/relayerRole";
import { primaryPoolProblem, readRouting, RoutingUnreadableError, type RoutingRecord } from "../game/routing";
import { readIdentityRole } from "../identity/dynamoIdentityStore";
import type { RoleRecord } from "../identity/identityItems";
import { LedgerUnreadableError, readAdoptedGeneration, readRelayerFence } from "../ledger/dynamoSigningLedger";
import { FinancialRecordUnreadableError } from "../../escrow/financialGameStore";
import { moneyContinuationVerdict, THIS_DEPLOYMENT } from "../../escrow/moneyContinuation";
import { IdentityStoreCorruptError } from "../../identity/store";
import { StoreCorruptError, StoreIncompatibleError } from "../../persistence/storeResult";
import { GAME_ID_PATTERN } from "../../rooms/gameRecord";
import { HoldUnreadableError } from "../../rooms/holdStore";
import type { OperatorTarget } from "./operatorTarget";

/* ------------------------------------------------------------------ */
/* The four answers                                                     */
/* ------------------------------------------------------------------ */

export type Read<T> =
  | { readonly state: "absent" }
  | { readonly state: "ok"; readonly value: T }
  | { readonly state: "unreadable"; readonly format: "corrupt" | "newer"; readonly detail: string }
  | { readonly state: "unavailable"; readonly detail: string };

const describe = (error: unknown): string => (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).slice(0, 300);

/** An item exists and this build cannot read it (thrown by the parsers below). */
export class ItemUnreadableError extends Error {
  constructor(
    message: string,
    readonly format: "corrupt" | "newer",
  ) {
    super(message);
    this.name = "ItemUnreadableError";
  }
}

/** Which production errors mean "the item is there and cannot be read" (anything else is a failed read). */
function unreadableOf(error: unknown): { readonly format: "corrupt" | "newer"; readonly detail: string } | null {
  if (error instanceof ItemUnreadableError) return { format: error.format, detail: error.message };
  if (error instanceof LedgerUnreadableError) return { format: error.format, detail: error.message };
  if (error instanceof StoreIncompatibleError) return { format: "newer", detail: error.message };
  if (error instanceof FinancialRecordUnreadableError) return { format: error.format === "newer" ? "newer" : "corrupt", detail: `${error.message} (${error.format})` };
  if (error instanceof RoutingUnreadableError || error instanceof RelayerRoleUnreadableError || error instanceof IdentityStoreCorruptError || error instanceof StoreCorruptError || error instanceof HoldUnreadableError) {
    return { format: "corrupt", detail: error.message };
  }
  return null;
}

/** Run one read and say which of the four answers it gave. */
export async function readAs<T>(read: () => Promise<T | null>): Promise<Read<T>> {
  try {
    const value = await read();
    return value === null ? { state: "absent" } : { state: "ok", value };
  } catch (error) {
    const unreadable = unreadableOf(error);
    if (unreadable !== null) return { state: "unreadable", format: unreadable.format, detail: unreadable.detail.slice(0, 300) };
    return { state: "unavailable", detail: describe(error) };
  }
}

/* ------------------------------------------------------------------ */
/* The HEAD and the pool item, parsed as their writers write them        */
/* ------------------------------------------------------------------ */

const CANONICAL = /^(0|[1-9][0-9]{0,15})$/;
const POOL_ID = /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,63}$/;
const TEXT = /^[\x21-\x7e]{1,128}$/;

function wholeNumber(item: Item, name: string, min: number): number | null {
  const text = item[name]?.N;
  if (text === undefined || !CANONICAL.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) && value >= min ? value : null;
}

export interface HeadView {
  /** A pool id, an operator run (`op:<run>`), or `#none` (released). */
  readonly owner_pool: string;
  readonly pool_epoch: number;
  /** The task that last CLAIMED it (absent on a HEAD made by a creation and never claimed since). Diagnostic. */
  readonly owner_task: string | null;
  readonly log_next_index: number;
  readonly log_bytes: number;
}

/** Every attribute a HEAD's writers ever write (`gameTable.ts`, `dynamoLogStore.ts`, `ownership.ts`). */
export const HEAD_ATTRIBUTES: ReadonlySet<string> = new Set(["pk", "sk", "owner_pool", "pool_epoch", "owner_task", "log_next_index", "log_bytes"]);

export function parseHeadItem(item: Item, gameId: string): HeadView {
  const where = `the HEAD of ${gameId}`;
  const extra = Object.keys(item).filter((name) => !HEAD_ATTRIBUTES.has(name));
  if (extra.length > 0) throw new ItemUnreadableError(`${where} carries [${extra.sort().join(", ")}], which this build never writes (a later build's HEAD, or damage): the fence item is never acted on unless fully understood`, "newer");
  const expected = headKey(gameId);
  if (item.pk?.S !== expected.pk.S || item.sk?.S !== expected.sk.S) throw new ItemUnreadableError(`${where} is not stored under its own key`, "corrupt");
  const owner = item.owner_pool?.S;
  if (owner === undefined || (owner !== NO_OWNER && !POOL_ID.test(owner))) throw new ItemUnreadableError(`${where} names no well-formed owner (${JSON.stringify(owner ?? null)})`, "corrupt");
  const epoch = wholeNumber(item, "pool_epoch", 1);
  if (epoch === null) throw new ItemUnreadableError(`${where} carries no positive whole pool_epoch (${JSON.stringify(item.pool_epoch ?? null)})`, "corrupt");
  const task = item.owner_task === undefined ? null : item.owner_task.S;
  if (task === undefined || (task !== null && !TEXT.test(task))) throw new ItemUnreadableError(`${where}'s owner_task is not well-formed`, "corrupt");
  const next = wholeNumber(item, "log_next_index", 0);
  const bytes = wholeNumber(item, "log_bytes", 0);
  if (next === null || bytes === null) throw new ItemUnreadableError(`${where}'s log_next_index or log_bytes is not a whole number`, "corrupt");
  return { owner_pool: owner, pool_epoch: epoch, owner_task: task, log_next_index: next, log_bytes: bytes };
}

export interface PoolView {
  readonly pool: string;
  readonly writer_epoch: number;
  readonly writer_task: string;
  readonly taken_at: number | null;
  /** Attributes this build never writes (a later slice's pool status, say). Listed; every mutation refuses them. */
  readonly extra: readonly string[];
}

const POOL_ATTRIBUTES: ReadonlySet<string> = new Set(["pk", "sk", "writer_epoch", "writer_task", "taken_at"]);

/** The pool item as `takeOverPool` writes it and the pool writer's self-check reads it (epoch and task required). */
export function parsePoolItem(item: Item, pool: string): PoolView {
  const where = `the pool item POOL#${pool}`;
  const expected = poolKey(pool);
  if (item.pk?.S !== expected.pk.S || item.sk?.S !== expected.sk.S) throw new ItemUnreadableError(`${where} is not stored under its own key`, "corrupt");
  const epoch = wholeNumber(item, "writer_epoch", 1);
  const task = item.writer_task?.S;
  if (epoch === null || task === undefined || !TEXT.test(task)) throw new ItemUnreadableError(`${where} is not well-formed (writer_epoch ${JSON.stringify(item.writer_epoch ?? null)}, writer_task ${JSON.stringify(item.writer_task ?? null)})`, "corrupt");
  const takenAt = item.taken_at === undefined ? null : wholeNumber(item, "taken_at", 0);
  if (item.taken_at !== undefined && takenAt === null) throw new ItemUnreadableError(`${where}'s taken_at is not a whole number`, "corrupt");
  return { pool, writer_epoch: epoch, writer_task: task, taken_at: takenAt, extra: Object.keys(item).filter((name) => !POOL_ATTRIBUTES.has(name)).sort() };
}

export const readHeadView = (client: DynamoDBClient, table: string, gameId: string): Promise<Read<HeadView>> =>
  readAs(async () => {
    const item = await getItem(client, table, headKey(gameId));
    return item === null ? null : parseHeadItem(item, gameId);
  });

export const readPoolView = (client: DynamoDBClient, table: string, pool: string): Promise<Read<PoolView>> =>
  readAs(async () => {
    if (!POOL_ID.test(pool)) throw new ItemUnreadableError(`${JSON.stringify(pool)} is not a pool id`, "corrupt");
    const item = await getItem(client, table, poolKey(pool));
    return item === null ? null : parsePoolItem(item, pool);
  });

/* ------------------------------------------------------------------ */
/* Ownership                                                            */
/* ------------------------------------------------------------------ */

export type OwnerClass = "no-head" | "released" | "current" | "superseded" | "operator" | "orphaned" | "ahead" | "inconsistent" | "unknown";

export interface OwnerStatus {
  readonly class: OwnerClass;
  readonly owner_pool: string | null;
  readonly owner_epoch: number | null;
  readonly owner_task: string | null;
  /** The owner pool's item as read (null when there was no owner pool to read). */
  readonly pool: Read<PoolView> | null;
  readonly detail: string;
}

/** Who owns the game, decided from its HEAD and the owner pool's item (see the header). `pools` caches pool reads. */
export async function ownerOf(target: OperatorTarget, head: Read<HeadView>, pools: Map<string, Promise<Read<PoolView>>> = new Map()): Promise<OwnerStatus> {
  const none = { owner_pool: null, owner_epoch: null, owner_task: null, pool: null };
  if (head.state === "absent") return { class: "no-head", ...none, detail: "there is no HEAD: the game does not exist in this table (a creation makes its HEAD in its first write)" };
  if (head.state === "unreadable") return { class: "unknown", ...none, detail: `the HEAD is unreadable (${head.format}): ${head.detail}` };
  if (head.state === "unavailable") return { class: "unknown", ...none, detail: `the HEAD could not be read: ${head.detail}` };
  const h = head.value;
  const owner = { owner_pool: h.owner_pool, owner_epoch: h.pool_epoch, owner_task: h.owner_task };
  if (h.owner_pool === NO_OWNER) return { class: "released", ...owner, pool: null, detail: `released (the last owner's epoch ${h.pool_epoch} is kept on the HEAD); the next claim takes it` };
  let read = pools.get(h.owner_pool);
  if (read === undefined) {
    read = readPoolView(target.app, target.tables.game, h.owner_pool);
    pools.set(h.owner_pool, read);
  }
  const pool = await read;
  if (h.owner_pool.startsWith("op:")) {
    return { class: "operator", ...owner, pool, detail: `held by operator run ${h.owner_pool}: every pool is routed away from it until the run releases it (\`gamesDoctor aws release <game> --run ${h.owner_pool}\`)` };
  }
  if (pool.state === "absent") return { class: "orphaned", ...owner, pool, detail: `the HEAD names pool ${h.owner_pool}, which has no pool item: nothing proves its owner stale` };
  if (pool.state !== "ok") return { class: "unknown", ...owner, pool, detail: `the owner pool's item ${pool.state === "unreadable" ? `is unreadable (${pool.format}): ${pool.detail}` : `could not be read: ${pool.detail}`}` };
  const p = pool.value;
  if (p.writer_epoch > h.pool_epoch) {
    return { class: "superseded", ...owner, pool, detail: `owned by pool ${h.owner_pool} at epoch ${h.pool_epoch}; the pool is at epoch ${p.writer_epoch} (${p.writer_task}): the owning task is stale` };
  }
  if (p.writer_epoch < h.pool_epoch) return { class: "ahead", ...owner, pool, detail: `the HEAD names epoch ${h.pool_epoch} of pool ${h.owner_pool}, which is only at epoch ${p.writer_epoch}: damage (or a table restored under a newer HEAD)` };
  if (h.owner_task !== null && h.owner_task !== p.writer_task) {
    return { class: "inconsistent", ...owner, pool, detail: `the HEAD names task ${h.owner_task} at epoch ${h.pool_epoch}, but that epoch is ${p.writer_task}'s: damage` };
  }
  return { class: "current", ...owner, pool, detail: `owned by pool ${h.owner_pool}'s current epoch ${h.pool_epoch} (${p.writer_task}): that task may be serving it now` };
}

/* ------------------------------------------------------------------ */
/* What the production rules allow an operator to do with a game        */
/* ------------------------------------------------------------------ */

export interface ActionVerdict {
  readonly allowed: boolean;
  readonly why: string;
}

/** The report's name for the one path this slice does not build (see `mutations.ts`, "THE LIVE-OWNER TAKE"). */
export const LIVE_OWNER_TAKE_STOPPED =
  "a take from a CURRENT owner is not available: after the operator released it, the same (pool, epoch) task could claim it back and a write of its still in flight could land under that same fence -- it needs a per-claim generation carried by every game fence (L6-3 report, the live-owner take); stop or replace the owning task first (a new task of the pool supersedes the epoch), or wait for the pool to release the game";

export function claimVerdict(head: Read<HeadView>, owner: OwnerStatus): ActionVerdict {
  if (head.state !== "ok") return { allowed: false, why: owner.detail };
  if (owner.class !== "released") return { allowed: false, why: owner.class === "superseded" ? "the game is owned by a superseded epoch: use `take`" : owner.class === "current" ? LIVE_OWNER_TAKE_STOPPED : owner.detail };
  return { allowed: true, why: "released: its last owner settled every write before it released the game (L5-3 §7 point 1), and a claim binds the HEAD exactly as read" };
}

export function takeVerdict(head: Read<HeadView>, owner: OwnerStatus): ActionVerdict {
  if (head.state !== "ok") return { allowed: false, why: owner.detail };
  if (owner.class === "released") return { allowed: false, why: "released: use `claim`" };
  if (owner.class === "current") return { allowed: false, why: LIVE_OWNER_TAKE_STOPPED };
  if (owner.class !== "superseded") return { allowed: false, why: owner.detail };
  if (owner.pool?.state === "ok" && owner.pool.value.extra.length > 0) {
    return { allowed: false, why: `the owner pool's item carries [${owner.pool.value.extra.join(", ")}], which this build never writes: not acted on` };
  }
  return {
    allowed: true,
    why: `the owner (${owner.owner_pool}, epoch ${owner.owner_epoch}) is superseded: that task can never claim again (its pool fence fails), so no write of it can land after the take; the take proves the newer epoch INSIDE its own transaction`,
  };
}

export function releaseVerdict(head: Read<HeadView>, owner: OwnerStatus, run: string | null): ActionVerdict {
  if (head.state !== "ok") return { allowed: false, why: owner.detail };
  if (owner.class !== "operator") return { allowed: false, why: owner.class === "released" ? "already released" : "only an operator run's hold is released here (a pool releases its own games)" };
  if (run === null) return { allowed: true, why: `held by ${owner.owner_pool}: release it with --run ${owner.owner_pool}` };
  if (run !== owner.owner_pool) return { allowed: false, why: `held by ${owner.owner_pool}, not ${run}` };
  return { allowed: true, why: `held by ${run}: the release names that run and its epoch exactly` };
}

/* ------------------------------------------------------------------ */
/* One game                                                             */
/* ------------------------------------------------------------------ */

/** Read-only views of the L5-2 stores: their own `load` (their own parsers). The fence is one no task ever holds, and
 *  only `load` is ever called -- a write through these would be refused by the table anyway. */
const READ_ONLY_FENCE = Object.freeze({ pool: "op:read-only-inspection", epoch: 1 });

export interface OperatorRunEvidence {
  readonly run: string;
  readonly command: string | null;
  readonly subject: string | null;
  readonly note: string | null;
  readonly started_at: number | null;
  readonly outcome: string | null;
}

export interface GameInspection {
  readonly game_id: string;
  readonly head: Read<HeadView>;
  readonly owner: OwnerStatus;
  readonly record: Read<{ readonly record_version: number; readonly record_schema: number; readonly status: string; readonly money: boolean }>;
  readonly hold: Read<{ readonly code: string; readonly detail: string }>;
  readonly financial: Read<{ readonly phase: string; readonly record_version: number; readonly continues_here: boolean; readonly why: string | null }>;
  /** When an operator run holds the game: its evidence item (`OPRUN#<run>`), as read. */
  readonly operator_run: Read<OperatorRunEvidence> | null;
  readonly actions: { readonly claim: ActionVerdict; readonly take: ActionVerdict; readonly release: ActionVerdict };
}

export async function inspectGame(target: OperatorTarget, gameId: string): Promise<GameInspection> {
  if (!GAME_ID_PATTERN.test(gameId)) throw new Error(`${JSON.stringify(gameId)} is not a game id`);
  const base = { client: target.app, table: target.tables.game, fence: READ_ONLY_FENCE };
  const head = await readHeadView(target.app, target.tables.game, gameId);
  const owner = await ownerOf(target, head);
  const [record, hold, financial] = await Promise.all([
    readAs(async () => {
      const r = await createDynamoRecordStore(base).load(gameId);
      return r === null ? null : { record_version: r.record_version, record_schema: r.record_schema, status: r.status, money: r.record_schema === 2 };
    }),
    readAs(async () => {
      const h = await createDynamoHoldStore(base).load(gameId);
      return h === null ? null : { code: h.code, detail: h.detail.slice(0, 200) };
    }),
    readAs(async () => {
      const f = await createDynamoFinancialStore(base).load(gameId);
      if (f === null) return null;
      const verdict = moneyContinuationVerdict(f.continuation, THIS_DEPLOYMENT);
      return { phase: f.phase, record_version: f.record_version, continues_here: verdict.continues, why: verdict.continues ? null : `${verdict.why}: ${verdict.detail}` };
    }),
  ]);
  const operatorRun = owner.class === "operator" && owner.owner_pool !== null ? await readOperatorRun(target, owner.owner_pool) : null;
  return {
    game_id: gameId,
    head,
    owner,
    record,
    hold,
    financial,
    operator_run: operatorRun,
    actions: { claim: claimVerdict(head, owner), take: takeVerdict(head, owner), release: releaseVerdict(head, owner, null) },
  };
}

/** JX-3B: one game's ticket ledger, read as its item (`GAME#<g>/TICKETS`): the document the L5-2 ticket store writes,
 *  parsed by the ledger's own parser, its version agreeing with the item's attribute (else the item is damage). A
 *  reader: the operator never holds the ticket store (a writer). */
export async function readTicketLedger(target: OperatorTarget, gameId: string): Promise<{ readonly version: number; readonly document: WalletTicketDocument }> {
  if (!GAME_ID_PATTERN.test(gameId)) throw new Error(`${JSON.stringify(gameId)} is not a game id`);
  const item = await getItem(target.app, target.tables.game, key(gamePk(gameId), TICKETS_SK));
  if (item === null) return { version: 0, document: { frozen_at: null, grants: [] } };
  if (typeof item.body?.S !== "string") throw new ItemUnreadableError(`the ticket ledger of ${gameId} holds no document`, "corrupt");
  const parsed = parseWalletTicketFile(item.body.S, gameId);
  if (item.version?.N !== String(parsed.version)) throw new ItemUnreadableError(`the ticket ledger of ${gameId} disagrees with its item's version attribute`, "corrupt");
  return parsed;
}

/** JX-3B: exactly the identity records `securityStanding` reads for these contexts -- each principal, its profile
 *  (`account_link`) and each family -- by consistent GetItem, decoded strictly. A missing record is simply absent (a
 *  missing family or principal is an ENDED context, as identity says). Nothing else of the identity table is read. */
export async function readIdentitySlice(target: OperatorTarget, contexts: ReadonlyArray<{ readonly principalId: string; readonly familyId: string }>): Promise<IdentitySnapshot> {
  const read = async (itemKey: { pk: string; sk: string }, kind: DecodedItem["kind"]): Promise<DecodedItem | null> => {
    const item = await getItem(target.app, target.tables.identity, keyAttributes(itemKey));
    if (item === null) return null;
    const decoded = decodeItem(item);
    if ("problem" in decoded || decoded.kind !== kind) throw new ItemUnreadableError(`identity: ${"problem" in decoded ? decoded.problem : `an item of class ${decoded.kind}, not ${kind}`}`, "corrupt");
    return decoded;
  };
  const principals: Principal[] = [];
  const profiles: Profile[] = [];
  const families: SessionFamily[] = [];
  for (const principalId of new Set(contexts.map((context) => context.principalId))) {
    const found = await read(identityKeys.principal(principalId), "principal");
    if (found?.kind !== "principal") continue;
    const principal = found.record;
    principals.push(principal);
    if (principal.account_link !== null) {
      const profile = await read(identityKeys.profile(principal.account_link), "profile");
      if (profile?.kind === "profile") profiles.push(profile.record);
    }
  }
  const known = new Set(principals.map((principal) => principal.principal_id));
  for (const familyId of new Set(contexts.map((context) => context.familyId))) {
    const family = await read(identityKeys.family(familyId), "family");
    if (family?.kind === "family" && known.has(family.record.principal_id)) families.push(family.record);
  }
  return { principals, sessions: [], profiles, links: [], families };
}

/** JX-3B: one game's wallet grants, redacted (`tools/walletGrants.ts`) -- the ticket ledger and record items (reads
 *  only; the record through the L5-2 store's `load`), and identity's standing from just the records its contexts
 *  name. If identity cannot be read, the grants are still shown, standing "not evaluated". */
export async function awsWalletGrants(target: OperatorTarget, gameId: string, now: number): Promise<WalletGrantsView> {
  if (!GAME_ID_PATTERN.test(gameId)) throw new Error(`${JSON.stringify(gameId)} is not a game id`);
  return collectWalletGrants({
    gameId,
    source: "aws",
    loadLedger: () => readTicketLedger(target, gameId),
    loadIdentity: (contexts) => readIdentitySlice(target, contexts),
    loadRecord: () => createDynamoRecordStore({ client: target.app, table: target.tables.game, fence: READ_ONLY_FENCE }).load(gameId),
    now,
  });
}

/* ------------------------------------------------------------------ */
/* Operator runs' evidence items (`OPRUN#<run>`, preflight §18.6)        */
/* ------------------------------------------------------------------ */

export const OPRUN_FORMAT = 1;
export const oprunKey = (run: string): Item => key(`OPRUN#${run}`, "OPRUN");
export const oprunResultKey = (run: string): Item => key(`OPRUN#${run}`, "RESULT");

export async function readOperatorRun(target: OperatorTarget, run: string): Promise<Read<OperatorRunEvidence>> {
  return readAs(async () => {
    const [item, result] = await Promise.all([getItem(target.app, target.tables.game, oprunKey(run)), getItem(target.app, target.tables.game, oprunResultKey(run))]);
    if (item === null) return null;
    if (wholeNumber(item, "fmt", 1) !== OPRUN_FORMAT) throw new ItemUnreadableError(`the operator run item OPRUN#${run} is format ${JSON.stringify(item.fmt?.N ?? null)}, not ${OPRUN_FORMAT}`, wholeNumber(item, "fmt", 1) === null ? "corrupt" : "newer");
    return {
      run,
      command: item.command?.S ?? null,
      subject: item.subject?.S ?? null,
      note: item.note?.S ?? null,
      started_at: wholeNumber(item, "started_at", 0),
      outcome: result?.outcome?.S ?? null,
    };
  });
}

/* ------------------------------------------------------------------ */
/* The deployment                                                        */
/* ------------------------------------------------------------------ */

export interface RoleHolderStatus {
  /** `current`: the holder is its pool's newest task; `superseded`: a newer task of its pool exists (the holder is lost,
   *  and the role waits for the primary's next task to take it); `unknown`: the pool item could not tell. */
  readonly holder: "current" | "superseded" | "unknown";
  /** Whether the holder's pool is the routing's primary. */
  readonly primary: boolean | null;
  readonly detail: string;
}

export interface RelayerInspection {
  readonly account: string;
  readonly mirror: Read<RelayerRoleRecord>;
  readonly fence: Read<{ readonly epoch: number; readonly token: string | null }>;
  /** mirrored: the mirror names the ledger's epoch; minted-not-mirrored: the ledger minted a newer epoch the mirror does
   *  not carry (a takeover in progress, or one whose mirror failed: nobody holds the role); mirror-ahead: the mirror names
   *  an epoch the ledger never minted (damage); none: neither exists; unknown: one of them could not be read. */
  readonly consistency: "mirrored" | "minted-not-mirrored" | "mirror-ahead" | "none" | "unknown";
  readonly holder: RoleHolderStatus | null;
}

export interface DeploymentInspection {
  readonly target: {
    readonly kind: OperatorTarget["kind"];
    readonly environment: string;
    readonly region: string;
    readonly configured_pool: string;
    readonly generation: number;
    readonly game_table: string;
    readonly identity_table: string;
    readonly ledger_table: string;
    readonly config: OperatorTarget["source"];
    readonly escrow: OperatorTarget["escrow"];
  };
  readonly routing: Read<RoutingRecord>;
  readonly appgen: Read<{ readonly current_generation: number; readonly matches_configuration: boolean }>;
  /** Every pool this inspection could name (the configured pool, the primary, the role holders): no table scan. */
  readonly pools: ReadonlyArray<{ readonly pool: string; readonly named_as: readonly string[]; readonly item: Read<PoolView> }>;
  readonly identity_writer: { readonly role: Read<RoleRecord>; readonly holder: RoleHolderStatus | null };
  /** null: no escrow (no relayer) or its account is not known (the escrow configuration says why). */
  readonly relayer: RelayerInspection | null;
  /** Plain statements of anything that is not as a serving deployment needs it. Empty: nothing found. */
  readonly findings: readonly string[];
}

async function holderStatus(target: OperatorTarget, pool: string, task: string, routing: Read<RoutingRecord>, pools: Map<string, Promise<Read<PoolView>>>): Promise<RoleHolderStatus> {
  let read = pools.get(pool);
  if (read === undefined) {
    read = readPoolView(target.app, target.tables.game, pool);
    pools.set(pool, read);
  }
  const item = await read;
  const primary = routing.state === "ok" ? routing.value.primary_pool === pool : null;
  if (item.state !== "ok") return { holder: "unknown", primary, detail: `the holder's pool ${pool} ${item.state === "absent" ? "has no pool item" : `could not be read (${item.state})`}` };
  if (item.value.writer_task === task) return { holder: "current", primary, detail: `held by ${task}, pool ${pool}'s current task (epoch ${item.value.writer_epoch})` };
  return { holder: "superseded", primary, detail: `held by ${task}, but pool ${pool}'s current task is ${item.value.writer_task} (epoch ${item.value.writer_epoch}): the holder is lost, and the role waits for the primary's current task to take it` };
}

export async function inspectDeployment(target: OperatorTarget): Promise<DeploymentInspection> {
  const findings: string[] = [];
  const pools = new Map<string, Promise<Read<PoolView>>>();
  const [routing, appgenRaw, identityRole] = await Promise.all([
    readAs(() => readRouting(target.app, target.tables.game)),
    readAs(() => readAdoptedGeneration(target.ledger, target.tables.ledger)),
    readAs(() => readIdentityRole(target.app, target.tables.identity)),
  ]);
  const appgen: DeploymentInspection["appgen"] =
    appgenRaw.state === "ok" ? { state: "ok", value: { current_generation: appgenRaw.value, matches_configuration: appgenRaw.value === target.config.generation } } : appgenRaw;

  /* The routing. */
  if (routing.state === "absent") findings.push("SYSTEM/ROUTING does not exist: no pool is primary, so no task takes the identity-writer or relayer role (the deployment bootstrap -- L5-8 -- writes the first routing)");
  else if (routing.state === "unreadable") findings.push(`SYSTEM/ROUTING is unreadable (${routing.format}): no task takes a role while it stays so, and nothing here writes over it`);
  else if (routing.state === "unavailable") findings.push(`SYSTEM/ROUTING could not be read: ${routing.detail}`);
  else if (routing.value.primary_pool !== target.config.pool) findings.push(`the routing's primary is ${routing.value.primary_pool}, not this configuration's pool ${target.config.pool}: a task started with this configuration is a standby`);

  /* APPGEN. */
  if (appgen.state === "absent") findings.push("the ledger has no APPGEN: no task starts (the deployment bootstrap -- L5-8 -- initialises it)");
  else if (appgen.state === "unreadable") findings.push(`the ledger's APPGEN is unreadable (${appgen.format}): no task starts, and nothing here writes over it`);
  else if (appgen.state === "unavailable") findings.push(`the ledger's APPGEN could not be read: ${appgen.detail}`);
  else if (!appgen.value.matches_configuration) findings.push(`the ledger's adopted generation is ${appgen.value.current_generation}, not this configuration's ${target.config.generation}: a task started with it refuses to start (exit 2); generation adoption is L6-4's`);

  /* The identity-writer role. */
  let identityHolder: RoleHolderStatus | null = null;
  if (identityRole.state === "ok") {
    identityHolder = await holderStatus(target, identityRole.value.pool, identityRole.value.task, routing, pools);
    if (identityHolder.primary === false) findings.push(`the identity-writer role is held by pool ${identityRole.value.pool}, which is not the primary: the primary's current task takes it at its next start`);
    if (identityHolder.holder !== "current") findings.push(`identity writer: ${identityHolder.detail}`);
  } else if (identityRole.state === "absent") findings.push("no task has ever taken the identity-writer role");
  else findings.push(`the identity-writer role ${identityRole.state === "unreadable" ? `is unreadable (${identityRole.format})` : `could not be read (${identityRole.detail})`}`);

  /* The relayer: the game table's mirror against the ledger's fence. */
  let relayer: RelayerInspection | null = null;
  if (target.escrow.state === "ok") {
    const account = target.escrow.relayer;
    const [mirror, fence] = await Promise.all([readAs(() => readRelayerRole(target.app, target.tables.game, account)), readAs(() => readRelayerFence(target.ledger, target.tables.ledger, account))]);
    let consistency: RelayerInspection["consistency"];
    if (mirror.state === "absent" && fence.state === "absent") consistency = "none";
    else if (mirror.state === "unreadable" || mirror.state === "unavailable" || fence.state === "unreadable" || fence.state === "unavailable") consistency = "unknown";
    else if (fence.state === "absent") consistency = "mirror-ahead";
    else if (mirror.state === "absent") consistency = "minted-not-mirrored";
    else if (mirror.state === "ok" && fence.state === "ok") consistency = mirror.value.epoch === fence.value.epoch ? "mirrored" : mirror.value.epoch < fence.value.epoch ? "minted-not-mirrored" : "mirror-ahead";
    else consistency = "unknown";
    const holder = mirror.state === "ok" ? await holderStatus(target, mirror.value.pool, mirror.value.task, routing, pools) : null;
    relayer = { account, mirror, fence, consistency, holder };
    if (consistency === "minted-not-mirrored") findings.push("the ledger minted a newer relayer epoch than the mirror carries: no task holds the relayer role until a takeover mirrors it (a takeover in progress, or one whose mirror failed)");
    if (consistency === "mirror-ahead") findings.push("the relayer mirror names an epoch the ledger never minted: damage (or a game table restored from another deployment)");
    if (consistency === "unknown") findings.push("the relayer's mirror or ledger fence could not be read or understood");
    if (consistency === "none") findings.push("no relayer role was ever taken");
    if (holder !== null && holder.holder !== "current") findings.push(`relayer: ${holder.detail}`);
    if (holder !== null && holder.primary === false) findings.push(`the relayer role is held by pool ${mirror.state === "ok" ? mirror.value.pool : "?"}, which is not the primary`);
  } else if (target.escrow.state === "unreadable") findings.push(`the escrow configuration ${target.escrow.arn ?? ""} is not usable (${target.escrow.detail}): the relayer is not inspected`);
  else if (target.escrow.state === "not-read") findings.push("DynamoDB Local: the document's escrow is not read; name the relayer account with --relayer to inspect it");

  /* Every pool it could name. */
  const named = new Map<string, string[]>();
  const name = (pool: string, as: string) => named.set(pool, [...(named.get(pool) ?? []), as]);
  name(target.config.pool, "configured");
  if (routing.state === "ok") name(routing.value.primary_pool, "primary");
  if (identityRole.state === "ok") name(identityRole.value.pool, "identity-writer");
  if (relayer?.mirror.state === "ok") name(relayer.mirror.value.pool, "relayer");
  const poolList: Array<DeploymentInspection["pools"][number]> = [];
  for (const [pool, as] of named) {
    let read = pools.get(pool);
    if (read === undefined) {
      read = readPoolView(target.app, target.tables.game, pool);
      pools.set(pool, read);
    }
    const item = await read;
    poolList.push({ pool, named_as: as, item });
    if (item.state === "absent" && as.includes("primary")) findings.push(`the primary pool ${pool} has no pool item: no task of it has ever started`);
    if (item.state === "unreadable" || item.state === "unavailable") findings.push(`the pool item POOL#${pool} ${item.state === "unreadable" ? `is unreadable (${item.format})` : "could not be read"}`);
  }
  if (primaryPoolProblem(target.config.pool) !== null) findings.push(`the configured pool ${target.config.pool} is not a pool id a task can run as`);

  return {
    target: {
      kind: target.kind,
      environment: target.config.environment,
      region: target.config.region,
      configured_pool: target.config.pool,
      generation: target.config.generation,
      game_table: target.tables.game,
      identity_table: target.tables.identity,
      ledger_table: target.tables.ledger,
      config: target.source,
      escrow: target.escrow,
    },
    routing,
    appgen,
    pools: poolList,
    identity_writer: { role: identityRole, holder: identityHolder },
    relayer,
    findings,
  };
}

/* ------------------------------------------------------------------ */
/* Many games: the directory (DIRKEYS -> DIR#) or the open money games (FINKEYS -> FINIDX#)   */
/* ------------------------------------------------------------------ */

export interface GameListing {
  readonly source: "directory" | "open-money";
  readonly games: ReadonlyArray<{ readonly game_id: string; readonly owner: OwnerClass; readonly owner_pool: string | null; readonly owner_epoch: number | null; readonly detail: string }>;
  /** Index items that could not be read or named no game (listed, never dropped). */
  readonly problems: readonly string[];
}

export async function listGames(target: OperatorTarget, options: { readonly money?: boolean; readonly month?: string } = {}): Promise<GameListing> {
  const problems: string[] = [];
  const ids = new Set<string>();
  if (options.money === true) {
    const keys = [...((await getItem(target.app, target.tables.game, FINKEYS_KEY))?.keys?.SS ?? [])].sort();
    for (const identityKey of keys) {
      for (const item of await queryAll(target.app, target.tables.game, `FINIDX#${identityKey}`)) {
        const id = item.game_id?.S;
        if (id !== undefined && GAME_ID_PATTERN.test(id)) ids.add(id);
        else problems.push(`FINIDX#${identityKey} / ${item.sk?.S ?? "?"} names no game`);
      }
    }
  } else {
    if (options.month !== undefined && !/^[0-9]{6}$/.test(options.month)) throw new Error("--month is yyyymm");
    const months = options.month !== undefined ? [options.month] : [...((await getItem(target.app, target.tables.game, DIRKEYS_KEY))?.months?.SS ?? [])].sort();
    for (const month of months) {
      for (const item of await queryAll(target.app, target.tables.game, `DIR#${month}`)) {
        const id = item.game_id?.S;
        if (id !== undefined && GAME_ID_PATTERN.test(id)) ids.add(id);
        else problems.push(`DIR#${month} / ${item.sk?.S ?? "?"} names no game`);
      }
    }
  }
  const pools = new Map<string, Promise<Read<PoolView>>>();
  const games: Array<GameListing["games"][number]> = [];
  for (const id of [...ids].sort()) {
    const owner = await ownerOf(target, await readHeadView(target.app, target.tables.game, id), pools);
    games.push({ game_id: id, owner: owner.class, owner_pool: owner.owner_pool, owner_epoch: owner.owner_epoch, detail: owner.detail });
  }
  return { source: options.money === true ? "open-money" : "directory", games, problems };
}
