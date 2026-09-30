// server/src/aws/operator/mutations.ts
//
// ==================================================================
//  LIVE-6 L6-3: THE OPERATOR'S CONTROLLED MUTATIONS -- THE ROUTING CAS, AND AN OPERATOR RUN'S CLAIM / TAKE / RELEASE OF A GAME
// ==================================================================
//
// Only operations the LIVE-5 architecture already names (preflight §4 rows 1-2, §5.2, §18.2, §18.6; L5-3 `setPrimaryPool`):
//
//   set-primary <pool>   SYSTEM/ROUTING -> <pool>: L5-3's `setPrimaryPool`, a compare-and-swap on EXACTLY the item read
//                        (version AND claim), at the version the operator names (`--expect-version`). Never creates the
//                        first routing (that is the deployment bootstrap's -- L5-8), never names an `op:` pool, never a
//                        pool no task has ever taken, never the pool that is already primary. The FLIP PROCEDURE around it
//                        (draining, promotion, retirement) is L6-2's; this is only the primitive.
//   claim <game>         an operator run takes a RELEASED game: its HEAD, exactly as read (owner "#none", the kept epoch and
//                        task), becomes (op:<run>, 1, <run task>).
//   take <game>          an operator run takes a game whose owner epoch is SUPERSEDED: the HEAD exactly as read, AND --
//                        inside the same transaction -- `ConditionCheck POOL#<owner> writer_epoch > :E` (the owner's pool
//                        has a newer task). Never from a CURRENT owner (below).
//   release <game> --run <op:run>
//                        the run's hold ends: L5-2's `releaseGame` with the run's (pool, epoch) -- only the holder releases.
//
// EVERY MUTATION: explicit (`--apply`; without it the plan is printed and NOTHING is written -- not even the run's evidence);
// reads the item it will change and binds the write to that exact state; refuses an item it cannot fully read (unreadable,
// a later build's, an unknown attribute on the HEAD or the pool item); carries its fence inside its own transaction; settles
// a lost answer from the table (the write's token / claim / run on the item), never from the error; writes the run's
// evidence item FIRST (`OPRUN#<run>` / `OPRUN`, preflight §18.6 -- a mutation whose evidence cannot be written is not made)
// and its outcome after (`OPRUN#<run>` / `RESULT`), and an `AUDIT` line. There is no force mode.
//
// THE OPERATOR RUN. A run is a pool named `op:r-<16 hex>` (new for every mutating command) whose first task takes it at
// epoch 1 (L5-2's `takeOverPool`) -- so an operator's hold is the SAME fence every writer uses: `ConditionCheck POOL#<run>
// writer_epoch = 1` inside its claim, and on the HEAD (owner_pool, pool_epoch). A run id is never reused, so a released
// operator hold can never come back. And the run's pool fence is RETIRED (moved past epoch 1) as soon as its one claim
// has an answer, whatever the answer (review M1): a released game's HEAD can recur EXACTLY (the same pool task reclaiming
// and releasing it again), so without that a late copy of the operator's own claim -- an original whose answer was lost,
// or a copy delayed past the token's window -- could still land later and silently hold the game. After the retirement
// nothing of that claim can ever land, and the HEAD alone settles a lost answer, definitely. The hold is untouched (it is
// the HEAD's (run, 1); nothing but `release` names it).
//
// WHAT THE CLAIM BINDS: owner_pool, pool_epoch and owner_task exactly as read (and nothing else is written). The whole HEAD
// is checked for attributes this build never writes before anything is sent; a later slice that adds a per-claim
// generation to the HEAD (below) must add it to this condition too.
//
// ==================================================================
//  WHY THESE ARE SAFE -- AND WHY THE LIVE-OWNER TAKE IS NOT BUILT (the L5-3 §7 handoff)
// ==================================================================
//
// L6-3 is the first mechanism that moves a game off (P, E) while the task (P, E) may still have writes in flight. L5-3 §7
// closed the same-task release -> reclaim residual with point 1: "nothing that could land later is still in flight when a
// game is released" -- and its case "definite after a lost answer" rests on the HEAD staying at (P, E) until the release.
// An operator's fence breaks exactly that premise: a resend of the owner's write can be refused BY THE OPERATOR'S FENCE
// (DEFINITE, "nothing written" -- the actor tells its player so), while the original request is still somewhere between the
// client and the service and is evaluated later. Whether that late original can land decides everything, and it can land
// only if (P, E) is ever written back onto the HEAD (every game write carries `owner_pool = P AND pool_epoch = E`).
//
//   claim (released)   the owner released the game only after its actor was evicted, and eviction needs the actor idle:
//                      every write it sent had SETTLED while the HEAD still said (P, E) -- L5-3 §7 point 1 applies as
//                      written, and the operator's claim adds nothing to the window a pool's own next claim already has.
//   take (superseded)  POOL#P is at an epoch > E. The task (P, E) can never claim anything again (`claimGame` carries
//                      `POOL#P writer_epoch = E`, which is false forever: epochs only move forward), and nothing else ever
//                      writes (P, E) onto a HEAD: after the take, and after the run's release, (P, E) NEVER RETURNS -- every
//                      write of that task, however late, is refused by its own fence. The newer epoch is proven INSIDE the
//                      take's transaction, so a take can never land on a HEAD whose owner became current again (it cannot:
//                      nothing lowers a pool epoch) or on one that moved since it was read.
//   release            the HEAD goes to "#none" with the run's epoch kept; the run id is never used again, so the run's
//                      fence never returns either. The next claim (the pool's load, or its money claim sweep) takes it.
//
//   THE LIVE-OWNER TAKE (from a CURRENT owner) IS STOPPED. After an operator took a game from the current (P, E) and
//   released it, the same task (P, E) claims it back (its pool fence still holds) -- and a write of its that was in flight
//   at the take, whose resend the operator's fence refused (so the player was told "nothing written"), can then land under
//   (P, E) again. That is the ABA L5-3 warned of. Today's fence cannot tell the reclaimed (P, E) from the displaced one.
//   It needs ONE more value, decided by a claim: a per-claim generation `claim_gen` on the HEAD, incremented by every claim
//   and carried by EVERY game fence (`gameFence`, the log's HEAD update, `headCreateOrMine`; `claimGame` returns it) --
//   then a reclaim by the same (P, E) is (P, E, G+1) and no write carrying G ever lands again. (The alternative that needs no
//   schema change: supersede the owner's POOL epoch itself -- which stops that pool's task, every game of it -- a
//   separately reviewed "fence the pool" command.) Neither is built here: the L6-3 report states the design.

import { randomBytes } from "crypto";
import { PutItemCommand, type TransactWriteItem } from "@aws-sdk/client-dynamodb";

import { deadline } from "../awsClients";
import { getItem, headKey, N, NO_OWNER, poolFence, poolKey, S, type Item } from "../game/gameTable";
import { releaseGame, takeOverPool } from "../game/ownership";
import { primaryPoolProblem, readRouting, RoutingUnreadableError, setPrimaryPool } from "../game/routing";
import { resendTiming, transactWrite, type ResendTiming } from "../game/transact";
import { GAME_ID_PATTERN } from "../../rooms/gameRecord";
import {
  claimVerdict,
  OPRUN_FORMAT,
  oprunKey,
  oprunResultKey,
  ownerOf,
  readAs,
  readHeadView,
  readPoolView,
  releaseVerdict,
  takeVerdict,
  type HeadView,
  type OwnerStatus,
} from "./inspect";
import type { OperatorTarget } from "./operatorTarget";

/* ------------------------------------------------------------------ */
/* Runs, notes, results                                                 */
/* ------------------------------------------------------------------ */

export interface OperatorRun {
  /** The run's pool id: `op:r-<16 hex>`. */
  readonly run: string;
  /** The run's task name (on the pool item and, for a claim, the HEAD's owner_task). */
  readonly task: string;
}

export const OPERATOR_RUN = /^op:r-[0-9a-f]{16}$/;

export function newOperatorRun(random: () => string = () => randomBytes(8).toString("hex")): OperatorRun {
  const hex = random();
  if (!/^[0-9a-f]{16}$/.test(hex)) throw new Error("an operator run id is 16 lower-case hex digits");
  return { run: `op:r-${hex}`, task: `gamesDoctor-${hex}` };
}

/** Why a note is refused (null: it is fine). A note is evidence written into the table and the audit: printable text,
 *  1-300 characters, and never something shaped like a credential. */
export function noteProblem(note: string | undefined): string | null {
  const text = (note ?? "").trim();
  if (text.length === 0 || text.length > 300) return 'a mutation needs --note "<why it is safe now>" (1-300 characters)';
  if (!/^[\x20-\x7e]+$/.test(text)) return "the note must be printable ASCII text on one line";
  if (/(?:AKIA|ASIA)[0-9A-Z]{16}|-----BEGIN|aws_secret_access_key/i.test(text)) return "the note looks like it carries a credential; it is written into the table and the audit, so it is refused";
  return null;
}

export interface Plan {
  readonly command: "set-primary" | "claim" | "take" | "release";
  readonly subject: string;
  /** The item's fields this write changes, as read. */
  readonly before: Readonly<Record<string, unknown>>;
  /** And as they would be written. */
  readonly after: Readonly<Record<string, unknown>>;
  /** The conditions the write carries INSIDE itself (what DynamoDB checks at the write). */
  readonly conditions: readonly string[];
  readonly why: string;
  readonly notes: readonly string[];
}

export type MutationResult =
  /** Dry run: the plan; NOTHING was written. */
  | { readonly kind: "planned"; readonly plan: Plan }
  /** Refused before its write (the rules, an unreadable item, a stale expectation): no change was made. `run` is set
   *  when the run's evidence had already been written. */
  | { readonly kind: "refused"; readonly reason: string; readonly plan: Plan | null; readonly run: string | null }
  | { readonly kind: "applied"; readonly plan: Plan; readonly run: string; readonly detail: string }
  /** The item moved between the read and the write: the write was evaluated and refused -- nothing of it landed, and
   *  nothing that moved it was overwritten. */
  | { readonly kind: "conflict"; readonly plan: Plan; readonly run: string; readonly detail: string }
  /** No evaluated answer: the write may still land (only while its conditions still hold). Re-inspect; see `detail`. */
  | { readonly kind: "unknown"; readonly plan: Plan; readonly run: string; readonly detail: string };

export interface MutationContext {
  readonly target: OperatorTarget;
  readonly now: () => number;
  /** Recorded on the run's evidence (the image's BUILD_ID, or the tool's name). */
  readonly build: string;
  /** An AUDIT line (the CLI writes it to stderr: CloudWatch Logs on an ECS run). Never given a secret. */
  readonly audit: (event: string, fields: Record<string, unknown>) => void;
  readonly newRun?: () => OperatorRun;
  /** Tests: resend pacing of the game-table engine. */
  readonly timing?: Partial<ResendTiming>;
}

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 300);

/** The run's evidence, written FIRST: a mutation whose evidence cannot be written is not made. Create-only (a run id is
 *  never reused); a lost answer is settled by reading the item back (this run's task there -> written). */
async function recordRun(context: MutationContext, run: OperatorRun, plan: Plan, note: string): Promise<void> {
  const { target } = context;
  const item: Item = {
    ...oprunKey(run.run),
    fmt: N(OPRUN_FORMAT),
    run: S(run.run),
    task: S(run.task),
    command: S(plan.command),
    subject: S(plan.subject),
    note: S(note.trim()),
    started_at: N(context.now()),
    tool: S("gamesDoctor"),
    build: S(context.build.slice(0, 128) || "gamesDoctor"),
  };
  try {
    await target.app.send(new PutItemCommand({ TableName: target.tables.game, Item: item, ConditionExpression: "attribute_not_exists(pk)" }), { abortSignal: deadline() });
    return;
  } catch (error) {
    const stored = await getItem(target.app, target.tables.game, oprunKey(run.run)).catch(() => null);
    if (stored?.task?.S === run.task) return;
    throw new Error(`the run's evidence item OPRUN#${run.run} could not be written (${describe(error)}); nothing was changed`);
  }
}

/** The run's outcome, after the mutation (best effort: the AUDIT line carries it too). Returns a problem, or null. */
async function recordResult(context: MutationContext, run: OperatorRun, outcome: string, detail: string): Promise<string | null> {
  try {
    await context.target.app.send(
      new PutItemCommand({
        TableName: context.target.tables.game,
        Item: { ...oprunResultKey(run.run), fmt: N(OPRUN_FORMAT), outcome: S(outcome), detail: S(detail.slice(0, 300) || "-"), at: N(context.now()) },
        ConditionExpression: "attribute_not_exists(pk)",
      }),
      { abortSignal: deadline() },
    );
    return null;
  } catch (error) {
    return `the run's result item could not be written (${describe(error)}); the AUDIT line is the record`;
  }
}

/** Every applied / refused-after-evidence / conflict / unknown result: its outcome item and its AUDIT line. */
async function finish(context: MutationContext, run: OperatorRun, plan: Plan, note: string, result: Exclude<MutationResult, { kind: "planned" }>, written?: Readonly<Record<string, unknown>>): Promise<MutationResult> {
  const detail = result.kind === "refused" ? result.reason : result.detail;
  const problem = await recordResult(context, run, result.kind, detail);
  context.audit(`operator.${plan.command}`, {
    run: run.run,
    outcome: result.kind,
    subject: plan.subject,
    before: plan.before,
    after: result.kind === "applied" ? (written ?? plan.after) : null,
    detail,
    note: note.trim(),
    environment: context.target.config.environment,
    table: context.target.tables.game,
    ...(problem !== null ? { evidence: problem } : {}),
  });
  return result;
}

/* ------------------------------------------------------------------ */
/* set-primary: the routing CAS                                          */
/* ------------------------------------------------------------------ */

export async function setPrimary(context: MutationContext, input: { readonly pool: string; readonly expectVersion: number; readonly note: string; readonly apply: boolean }): Promise<MutationResult> {
  const { target } = context;
  const problem = noteProblem(input.note);
  if (problem !== null) return { kind: "refused", reason: problem, plan: null, run: null };
  if (!Number.isSafeInteger(input.expectVersion) || input.expectVersion < 1) {
    return { kind: "refused", reason: "--expect-version must be the routing_version you inspected (a positive whole number): the first routing is the deployment bootstrap's (L5-8), never this tool's", plan: null, run: null };
  }
  const poolProblem = primaryPoolProblem(input.pool);
  if (poolProblem !== null) return { kind: "refused", reason: poolProblem, plan: null, run: null };
  const routing = await readAs(() => readRouting(target.app, target.tables.game));
  if (routing.state === "absent") return { kind: "refused", reason: "SYSTEM/ROUTING does not exist: the first routing is written by the deployment bootstrap (L5-8), never by this tool", plan: null, run: null };
  if (routing.state === "unreadable") return { kind: "refused", reason: `SYSTEM/ROUTING is unreadable (${routing.format}: ${routing.detail}); it is never written over`, plan: null, run: null };
  if (routing.state === "unavailable") return { kind: "refused", reason: `SYSTEM/ROUTING could not be read (${routing.detail}); nothing was written`, plan: null, run: null };
  const current = routing.value;
  const before = { primary_pool: current.primary_pool, routing_version: current.routing_version, updated_by: current.updated_by, updated_at: current.updated_at, claim: current.claim };
  if (current.routing_version !== input.expectVersion) {
    return { kind: "refused", reason: `the routing is at version ${current.routing_version} (primary ${current.primary_pool}, set by ${current.updated_by}), not --expect-version ${input.expectVersion}: inspect it again; nothing was written`, plan: null, run: null };
  }
  if (current.primary_pool === input.pool) return { kind: "refused", reason: `${input.pool} is already the primary (routing version ${current.routing_version}); nothing to change`, plan: null, run: null };
  const poolItem = await readPoolView(target.app, target.tables.game, input.pool);
  if (poolItem.state === "absent") return { kind: "refused", reason: `pool ${input.pool} has no pool item: no task of it has ever started, so a routing naming it would leave no task able to take the identity-writer or relayer role`, plan: null, run: null };
  if (poolItem.state !== "ok") return { kind: "refused", reason: `the pool item POOL#${input.pool} ${poolItem.state === "unreadable" ? `is unreadable (${poolItem.format})` : `could not be read (${poolItem.detail})`}`, plan: null, run: null };
  if (poolItem.value.extra.length > 0) return { kind: "refused", reason: `the pool item POOL#${input.pool} carries [${poolItem.value.extra.join(", ")}], which this build never writes: not acted on`, plan: null, run: null };
  const plan: Plan = {
    command: "set-primary",
    subject: `SYSTEM/ROUTING -> ${input.pool}`,
    before,
    after: { primary_pool: input.pool, routing_version: current.routing_version + 1, updated_by: "gamesDoctor/<this run>", claim: "<a fresh claim>" },
    conditions: [`SYSTEM/ROUTING: fmt = 1 AND routing_version = ${current.routing_version} AND claim = ${current.claim} (setPrimaryPool: a compare-and-swap on exactly the item read)`],
    why: `pool ${input.pool} exists (epoch ${poolItem.value.writer_epoch}, ${poolItem.value.writer_task}) and is not the primary`,
    notes: [
      "A routing change decides only WHO MAY TAKE a role: no game write is fenced by it, and no game needs releasing.",
      `The roles move when ${input.pool}'s current task takes them -- a standby is promoted by restarting it (L5-7); until then ${current.primary_pool}'s holders keep them, and they are lost at their next self-check once the new primary's task takes them.`,
      "The flip procedure around this write (draining, promotion, retirement) is L6-2's runbook: this is only its primitive.",
    ],
  };
  if (!input.apply) return { kind: "planned", plan };
  const run = (context.newRun ?? (() => newOperatorRun()))();
  try {
    await recordRun(context, run, plan, input.note);
  } catch (error) {
    return { kind: "refused", reason: describe(error), plan, run: null };
  }
  let outcome;
  try {
    outcome = await setPrimaryPool(target.app, target.tables.game, { pool: input.pool, expectedVersion: input.expectVersion, by: `gamesDoctor/${run.run}`, now: context.now() });
  } catch (error) {
    if (error instanceof RoutingUnreadableError) {
      /* Read strictly before the write (then nothing was sent) or after it (then whether it landed cannot be told from an
         item nobody can read): never guessed, and nothing here writes over it. */
      return finish(context, run, plan, input.note, { kind: "unknown", plan, run: run.run, detail: `SYSTEM/ROUTING became unreadable around this write (${error.message}); whether it landed cannot be told from it, and nothing here writes over it` });
    }
    if (/nothing was sent/.test(describe(error))) return finish(context, run, plan, input.note, { kind: "refused", reason: describe(error), plan, run: run.run });
    return finish(context, run, plan, input.note, {
      kind: "unknown",
      plan,
      run: run.run,
      detail: `${describe(error)} -- run the same command again with --expect-version ${input.expectVersion}: it can never move the routing twice (a landed write shows as routing version ${input.expectVersion + 1}, updated_by gamesDoctor/${run.run})`,
    });
  }
  if (outcome.kind === "set") {
    const set = outcome.routing;
    return finish(
      context,
      run,
      plan,
      input.note,
      { kind: "applied", plan, run: run.run, detail: `the primary is ${set.primary_pool} at routing version ${set.routing_version}` },
      { primary_pool: set.primary_pool, routing_version: set.routing_version, updated_by: set.updated_by, claim: set.claim },
    );
  }
  const now = outcome.current;
  return finish(context, run, plan, input.note, {
    kind: "conflict",
    plan,
    run: run.run,
    detail:
      now === null
        ? "the routing is gone (nothing here deletes it); this run wrote nothing over anything"
        : `the routing is not at version ${input.expectVersion} any more (now version ${now.routing_version}, primary ${now.primary_pool}, set by ${now.updated_by}): this run's write was refused by its compare-and-swap -- or, had its answer been lost, it may have landed and been superseded by that change; either way nothing was overwritten, and the routing is as shown`,
  });
}

/* ------------------------------------------------------------------ */
/* claim / take: an operator run takes a game                            */
/* ------------------------------------------------------------------ */

function headBefore(head: HeadView): Record<string, unknown> {
  return { owner_pool: head.owner_pool, pool_epoch: head.pool_epoch, owner_task: head.owner_task };
}

function takeNotes(owner: OwnerStatus): string[] {
  return [
    "Every pool is routed away from the game while the run holds it (players see it unavailable); nothing else of the game is written by this command.",
    "The relayer's writes to the game's chain intents are fenced by the relayer role, not by the HEAD: an operator hold does not stop a relayer pass on them.",
    `End the hold with \`gamesDoctor aws release <game> --run <this run> --note ...\`; the next claim then takes it -- the load of any pool that continues it, or (an open money game) the money claim sweep of a pool that continues it; after a routing flip that may be another pool than the one it left.`,
    ...(owner.class === "superseded" ? [`The displaced epoch ${owner.owner_epoch} of ${owner.owner_pool} can never claim again: none of its writes can land after this take.`] : []),
  ];
}

async function operatorTake(context: MutationContext, input: { readonly gameId: string; readonly note: string; readonly apply: boolean }, mode: "claim" | "take"): Promise<MutationResult> {
  const { target } = context;
  const problem = noteProblem(input.note);
  if (problem !== null) return { kind: "refused", reason: problem, plan: null, run: null };
  if (!GAME_ID_PATTERN.test(input.gameId)) return { kind: "refused", reason: `${JSON.stringify(input.gameId)} is not a game id`, plan: null, run: null };
  const head = await readHeadView(target.app, target.tables.game, input.gameId);
  const owner = await ownerOf(target, head);
  const verdict = mode === "claim" ? claimVerdict(head, owner) : takeVerdict(head, owner);
  if (!verdict.allowed || head.state !== "ok") return { kind: "refused", reason: verdict.why, plan: null, run: null };
  const was = head.value;
  const plan: Plan = {
    command: mode,
    subject: input.gameId,
    before: headBefore(was),
    after: { owner_pool: "<this run: op:r-...>", pool_epoch: 1, owner_task: "<this run's task>" },
    conditions: [
      "POOL#<this run>: writer_epoch = 1 (the run's own fence: it is taken just before, at epoch 1)",
      ...(mode === "take" ? [`POOL#${was.owner_pool}: writer_epoch > ${was.pool_epoch} (the owner is superseded -- proven inside this transaction)`] : []),
      `GAME#${input.gameId}/HEAD: owner_pool = ${was.owner_pool} AND pool_epoch = ${was.pool_epoch} AND ${was.owner_task === null ? "no owner_task" : `owner_task = ${was.owner_task}`} (exactly as read)`,
    ],
    why: verdict.why,
    notes: takeNotes(owner),
  };
  if (!input.apply) return { kind: "planned", plan };
  const run = (context.newRun ?? (() => newOperatorRun()))();
  try {
    await recordRun(context, run, plan, input.note);
  } catch (error) {
    return { kind: "refused", reason: describe(error), plan, run: null };
  }
  /* The run's fence: its pool, at epoch 1. */
  let taken;
  try {
    taken = await takeOverPool(target.app, target.tables.game, run.run, run.task, context.now());
  } catch (error) {
    return finish(context, run, plan, input.note, { kind: "refused", reason: `the run's pool could not be taken (${describe(error)}); the game was not touched`, plan, run: run.run });
  }
  if (taken.kind !== "taken" || taken.epoch !== 1) {
    return finish(context, run, plan, input.note, { kind: "refused", reason: `the run's pool ${run.run} was already taken (a reused run id?); the game was not touched`, plan, run: run.run });
  }
  const written = { owner_pool: run.run, pool_epoch: 1, owner_task: run.task };
  const items: TransactWriteItem[] = [poolFence(target.tables.game, { pool: run.run, epoch: 1 })];
  if (mode === "take") {
    items.push({
      ConditionCheck: {
        TableName: target.tables.game,
        Key: poolKey(was.owner_pool),
        ConditionExpression: "#we > :E",
        ExpressionAttributeNames: { "#we": "writer_epoch" },
        ExpressionAttributeValues: { ":E": N(was.pool_epoch) },
        ReturnValuesOnConditionCheckFailure: "ALL_OLD",
      },
    });
  }
  items.push({
    Update: {
      TableName: target.tables.game,
      Key: headKey(input.gameId),
      UpdateExpression: "SET #op = :run, #pe = :one, #ot = :task",
      ConditionExpression: `#op = :wasP AND #pe = :wasE AND ${was.owner_task === null ? "attribute_not_exists(#ot)" : "#ot = :wasT"}`,
      ExpressionAttributeNames: { "#op": "owner_pool", "#pe": "pool_epoch", "#ot": "owner_task" },
      ExpressionAttributeValues: {
        ":run": S(run.run),
        ":one": N(1),
        ":task": S(run.task),
        ":wasP": S(was.owner_pool),
        ":wasE": N(was.pool_epoch),
        ...(was.owner_task === null ? {} : { ":wasT": S(was.owner_task) }),
      },
      ReturnValuesOnConditionCheckFailure: "ALL_OLD",
    },
  });
  const answer = await transactWrite(target.app, items, resendTiming(context.timing));
  /* THE RUN'S FENCE IS RETIRED as soon as its one claim has an answer (review M1): `POOL#<run>` moves past epoch 1, so no
     copy of this claim -- a late original after a lost answer, or a copy delayed past the token's window -- can EVER land,
     whatever the HEAD later looks like (a released game's HEAD can recur exactly: the same pool task reclaiming and
     releasing it again). The hold itself is untouched: it is the HEAD's (run, 1), which only `release` names. After the
     retirement, the HEAD alone says whether the claim landed: definitely, either way. */
  const retired = await retireRun(target, run, context.now);
  const retiredNote = retired ? "" : " The run's fence could NOT be retired: a delayed copy of this claim could still land if the HEAD ever returns exactly to the state read -- inspect the game later.";
  if (answer.kind === "applied") {
    return finish(context, run, plan, input.note, { kind: "applied", plan, run: run.run, detail: `${input.gameId} is held by ${run.run}${answer.redone ? " (settled after a lost answer)" : ""}.${retiredNote}` }, written);
  }
  if (answer.kind === "not-applied") return finish(context, run, plan, input.note, { kind: "refused", reason: `the write was refused unapplied (${answer.detail}); nothing was written -- try again (a new run).${retiredNote}`, plan, run: run.run });
  if (answer.kind === "refused" && !answer.resend) {
    const failed = answer.reasons.findIndex((reason) => reason.code === "ConditionalCheckFailed");
    const which = failed === 0 ? "the run's own pool fence (damage?)" : mode === "take" && failed === 1 ? `POOL#${was.owner_pool} is no longer ahead of epoch ${was.pool_epoch} (changed or unreadable)` : "the HEAD changed since it was read";
    return finish(context, run, plan, input.note, { kind: "conflict", plan, run: run.run, detail: `refused by ${which}; nothing was written and nothing was overwritten -- inspect the game again.${retiredNote}` });
  }
  /* A lost answer: the HEAD decides -- definitely once the run's fence is retired (nothing of this claim can land after). */
  const now = await readHeadView(target.app, target.tables.game, input.gameId);
  if (now.state === "ok" && now.value.owner_pool === run.run && now.value.owner_task === run.task) {
    return finish(context, run, plan, input.note, { kind: "applied", plan, run: run.run, detail: `${input.gameId} is held by ${run.run} (settled from the HEAD after a lost answer).${retiredNote}` }, written);
  }
  /* Only this run's claim ever writes this run's task onto a HEAD (re-review): a HEAD that carries it but no longer names
     the run was claimed by it and has since been released (by `release --run`, from another operator's console). */
  if (now.state === "ok" && now.value.owner_task === run.task) {
    return finish(context, run, plan, input.note, { kind: "applied", plan, run: run.run, detail: `${input.gameId} was claimed by ${run.run} (settled from the HEAD after a lost answer) and has since been released (the HEAD is ${now.value.owner_pool}).${retiredNote}` }, written);
  }
  if (retired && (now.state === "ok" || now.state === "absent")) {
    return finish(context, run, plan, input.note, { kind: "conflict", plan, run: run.run, detail: `the answer was lost; the run's fence is retired and the HEAD does not name ${run.run}, so this claim did not land and never can -- nothing was written; inspect the game again` });
  }
  return finish(context, run, plan, input.note, {
    kind: "unknown",
    plan,
    run: run.run,
    detail: `${answer.kind === "unknown" ? answer.detail : answer.detail.slice(0, 200)}; the HEAD does not name this run ${now.state === "unavailable" ? "(it could not be read)" : "yet"}.${retiredNote} Inspect the game -- if it shows ${run.run}, release it with --run ${run.run}`,
  });
}

/** Move the run's pool past epoch 1 (review M1: the claim it fenced can never land after this). A few attempts; true once
 *  the pool item is seen past epoch 1 (by this call or any other -- anything past 1 retires it). */
async function retireRun(target: OperatorTarget, run: OperatorRun, now: () => number): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await takeOverPool(target.app, target.tables.game, run.run, `${run.task}-retired`, now());
    } catch {
      /* unknown: the read below decides */
    }
    const pool = await readPoolView(target.app, target.tables.game, run.run);
    if (pool.state === "ok" && pool.value.writer_epoch > 1) return true;
  }
  return false;
}

export const claimGameAsOperator = (context: MutationContext, input: { readonly gameId: string; readonly note: string; readonly apply: boolean }) => operatorTake(context, input, "claim");
export const takeGameAsOperator = (context: MutationContext, input: { readonly gameId: string; readonly note: string; readonly apply: boolean }) => operatorTake(context, input, "take");

/* ------------------------------------------------------------------ */
/* release: an operator run's hold ends                                  */
/* ------------------------------------------------------------------ */

export async function releaseGameAsOperator(context: MutationContext, input: { readonly gameId: string; readonly run: string; readonly note: string; readonly apply: boolean }): Promise<MutationResult> {
  const { target } = context;
  const problem = noteProblem(input.note);
  if (problem !== null) return { kind: "refused", reason: problem, plan: null, run: null };
  if (!GAME_ID_PATTERN.test(input.gameId)) return { kind: "refused", reason: `${JSON.stringify(input.gameId)} is not a game id`, plan: null, run: null };
  if (!OPERATOR_RUN.test(input.run)) return { kind: "refused", reason: `--run must name the operator run holding the game (op:r-<16 hex>), not ${JSON.stringify(input.run)}`, plan: null, run: null };
  const head = await readHeadView(target.app, target.tables.game, input.gameId);
  const owner = await ownerOf(target, head);
  const verdict = releaseVerdict(head, owner, input.run);
  if (!verdict.allowed || head.state !== "ok") return { kind: "refused", reason: verdict.why, plan: null, run: null };
  const was = head.value;
  const plan: Plan = {
    command: "release",
    subject: input.gameId,
    before: headBefore(was),
    after: { owner_pool: NO_OWNER, pool_epoch: was.pool_epoch, owner_task: was.owner_task },
    conditions: [`GAME#${input.gameId}/HEAD: owner_pool = ${was.owner_pool} AND pool_epoch = ${was.pool_epoch} (L5-2 releaseGame: only the holder releases)`],
    why: verdict.why,
    notes: [
      `${input.run} is never used again, so its hold can never return.`,
      "The next claim takes the game: the load of any pool that continues it, or -- an open money game -- the money claim sweep (every minute) of a pool that continues it; after a routing flip that may be another pool than the one it came from.",
    ],
  };
  if (!input.apply) return { kind: "planned", plan };
  const run = (context.newRun ?? (() => newOperatorRun()))();
  try {
    await recordRun(context, run, plan, input.note);
  } catch (error) {
    return { kind: "refused", reason: describe(error), plan, run: null };
  }
  try {
    const released = await releaseGame(target.app, target.tables.game, input.gameId, { pool: was.owner_pool, epoch: was.pool_epoch });
    if (released) return finish(context, run, plan, input.note, { kind: "applied", plan, run: run.run, detail: `${input.gameId} is released (held by ${input.run} until now)` }, plan.after);
    return finish(context, run, plan, input.note, { kind: "conflict", plan, run: run.run, detail: `${input.gameId} is no longer held by ${input.run}; nothing was written` });
  } catch (error) {
    return finish(context, run, plan, input.note, { kind: "unknown", plan, run: run.run, detail: `${describe(error)} -- run the same release again (it is conditional on ${input.run}'s hold: it can never release anyone else's)` });
  }
}
