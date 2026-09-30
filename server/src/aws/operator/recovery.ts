// server/src/aws/operator/recovery.ts
//
// ==================================================================
//  LIVE-6 L6-2: GAMES LEFT ON THE DEMOTED POOL'S OLD EPOCH -- A BOUNDED, RESUMABLE, SUPERSEDED-ONLY RECOVERY PASS
// ==================================================================
//
// `gamesDoctor aws recover <A> --note "..." [--apply] [--limit <n>] [--money-wait-seconds <s>] [--flip-record <file>]`
//
// WHAT IT RECOVERS. A clean demotion (L6-1) releases A's resident, loaded, no-money games. It deliberately leaves owned by
// A: its money games, a game whose load was in flight at the flip, and every game of a task demoted by a fence (exit 3).
// Once A's task has restarted, POOL#A is at a newer epoch, so every HEAD still naming A at an older epoch is SUPERSEDED --
// exactly the state L6-3 proved safe for an operator `take` (the displaced task can never claim again: its pool fence is
// false forever, so none of its writes -- however late -- can land after the take, the release, or the new primary's
// claim). Owner decision: there is NO take from a CURRENT owner (the ABA of L6-3 §6); the supported path is "supersede
// the old epoch first (the restart), then take". This pass never builds another path.
//
// THE PASS (per game, from the directory DIRKEYS -> DIR# and the open money games FINKEYS -> FINIDX#; sorted; at most
// `limit` acted on per run):
//   superseded, owner A        L6-3's `take` (its own operator run: evidence first, the superseded proof INSIDE the
//                              transaction, the run's fence retired) then L6-3's `release` of that run's hold. The next
//                              claim is the new primary's -- its load, or, for an open money game, its money claim sweep.
//   operator, held by a run of THIS recovery for A (the run's OPRUN# evidence: command `take` of this game, note carrying
//                              `[l6-2-recover from=A]`) -- an interrupted pass: RELEASED now (resume).
//   operator, any other run    UNRESOLVED (never touched: another operator's work).
//   current, owner A           UNRESOLVED -- A's CURRENT task owns it (a non-primary task never claims, so this means A has
//                              not restarted, or A is still primary): never taken here (the live-owner take is stopped).
//   orphaned / ahead / inconsistent / unknown / unreadable
//                              UNRESOLVED (damage or a failed read: never acted on).
//   released, owned by another pool, no HEAD
//                              nothing to do (counted).
// Then, for every OPEN MONEY game released by this pass (or found released), it waits -- bounded -- for the new primary's
// money claim sweep to CLAIM it (the HEAD names the primary at its current epoch: the sweep's claim is the first step of
// its load); one still unclaimed at the bound is UNRESOLVED (e.g. a money game the new primary does not continue).
//
// IDEMPOTENT AND RESUMABLE: every decision is re-derived from the tables (nothing but the tables and the OPRUN# evidence
// is state), a re-run after an interruption releases this recovery's own holds and takes what is still superseded, and a
// finished pass re-run does nothing. A lost / unknown mutation outcome keeps L6-3's semantics (the result says how to
// settle it) and is UNRESOLVED for this pass. Operator holds do not freeze the relayer (ROLE_RL-fenced, owner decision).
//
// A pass that ends with nothing unresolved and nothing remaining (the limit not reached) SETTLES the recovery -- with
// `--flip-record`, it closes the planned-flip observability window (L6-5B).

import { NO_OWNER } from "../game/gameTable";
import { createDynamoFinancialStore } from "../game/dynamoFinancialStore";
import { primaryPoolProblem, readRouting } from "../game/routing";
import { listGames, ownerOf, readAs, readHeadView, readOperatorRun, readPoolView, type OwnerClass } from "./inspect";
import { noteProblem, releaseGameAsOperator, takeGameAsOperator, type MutationContext, type MutationResult } from "./mutations";

export const RECOVERY_MARKER = (from: string): string => `[l6-2-recover from=${from}]`;
export const DEFAULT_RECOVERY_LIMIT = 200;
export const DEFAULT_MONEY_WAIT_MS = 180_000;

export type RecoveryAction =
  | { readonly game_id: string; readonly action: "taken-and-released"; readonly take_run: string; readonly release_run: string; readonly money: boolean }
  | { readonly game_id: string; readonly action: "resumed-release"; readonly hold_run: string; readonly release_run: string; readonly money: boolean };

export interface RecoveryReport {
  readonly from: string;
  readonly primary: string | null;
  readonly apply: boolean;
  /** Superseded games of `from` a dry run WOULD take and release (or an --apply pass could not reach: the limit). */
  readonly planned: readonly string[];
  readonly acted: readonly RecoveryAction[];
  /** Open money games released (by this pass or earlier) and claimed by the primary within the wait. */
  readonly money_claimed: readonly string[];
  readonly unresolved: ReadonlyArray<{ readonly game_id: string; readonly class: OwnerClass | "mutation" | "money-unclaimed" | "financial"; readonly detail: string }>;
  readonly counts: Readonly<Record<string, number>>;
  /** More candidates than the limit: run the pass again. */
  readonly remaining: number;
  readonly problems: readonly string[];
  /** Nothing unresolved, nothing remaining: the recovery is complete (--flip-record: the window closes). */
  readonly settled: boolean;
}

export interface RecoveryDeps {
  readonly context: MutationContext;
  readonly sleep: (ms: number) => Promise<void>;
  readonly progress?: (line: string) => void;
}

export interface RecoveryInput {
  readonly from: string;
  readonly note: string;
  readonly apply: boolean;
  readonly limit?: number;
  readonly moneyWaitMs?: number;
  readonly pollMs?: number;
}

const describeResult = (result: MutationResult): string => (result.kind === "refused" ? result.reason : result.kind === "planned" ? "planned" : result.detail);

/** Whether `gameId` is an OPEN money game (its financial record, through its own store's `load`). */
async function openMoney(context: MutationContext, gameId: string): Promise<boolean | "unreadable"> {
  const read = await readAs(() => createDynamoFinancialStore({ client: context.target.app, table: context.target.tables.game, fence: { pool: "op:read-only-inspection", epoch: 1 } }).load(gameId));
  if (read.state === "absent") return false;
  if (read.state !== "ok") return "unreadable";
  return read.value.phase !== "closed" && read.value.phase !== "cancelled";
}

export async function recoverFromPool(deps: RecoveryDeps, input: RecoveryInput): Promise<RecoveryReport> {
  const { context } = deps;
  const { target } = context;
  const problems: string[] = [];
  const marker = RECOVERY_MARKER(input.from);
  const base = { from: input.from, apply: input.apply };
  const empty = (primary: string | null, extra: string[]): RecoveryReport => ({ ...base, primary, planned: [], acted: [], money_claimed: [], unresolved: [], counts: {}, remaining: 0, problems: extra, settled: false });

  const poolProblem = primaryPoolProblem(input.from);
  if (poolProblem !== null) return empty(null, [`${input.from}: ${poolProblem}`]);
  const noteBad = noteProblem(input.note);
  if (noteBad !== null) return empty(null, [noteBad]);
  /* The note carries the marker FIRST (so it survives the 300-character bound): a resumed pass recognises its holds. */
  const note = `${marker} ${input.note.trim()}`.slice(0, 300);
  const routing = await readAs(() => readRouting(target.app, target.tables.game));
  if (routing.state !== "ok") return empty(null, [`SYSTEM/ROUTING ${routing.state}: nothing is recovered without knowing the primary`]);
  const primary = routing.value.primary_pool;
  if (primary === input.from) return empty(primary, [`${input.from} is the primary: its games are served by it (recovery is for a DEMOTED pool, after its task restarted)`]);
  const poolItem = await readPoolView(target.app, target.tables.game, input.from);
  if (poolItem.state !== "ok" || poolItem.value.extra.length > 0) return empty(primary, [`POOL#${input.from} is ${poolItem.state === "ok" ? `carrying [${poolItem.value.extra.join(", ")}]` : poolItem.state}: nothing is acted on`]);

  /* The candidates: the directory and the open money games (a money game may have only its financial record). */
  const directory = await listGames(target);
  const money = await listGames(target, { money: true });
  problems.push(...directory.problems, ...money.problems);
  const ids = [...new Set([...directory.games, ...money.games].map((g) => g.game_id))].sort();
  const moneyIds = new Set(money.games.map((g) => g.game_id));

  const counts: Record<string, number> = {};
  const planned: string[] = [];
  const acted: RecoveryAction[] = [];
  const unresolved: Array<RecoveryReport["unresolved"][number]> = [];
  const waitFor: string[] = [];
  let budget = input.limit ?? DEFAULT_RECOVERY_LIMIT;
  let remaining = 0;
  const pools = new Map();
  const count = (k: string) => (counts[k] = (counts[k] ?? 0) + 1);

  for (const gameId of ids) {
    const head = await readHeadView(target.app, target.tables.game, gameId);
    const owner = await ownerOf(target, head, pools);
    const mine = owner.owner_pool === input.from;
    count(mine ? `${owner.class} (${input.from})` : owner.class);
    if (owner.class === "released") {
      if (moneyIds.has(gameId)) waitFor.push(gameId);
      continue;
    }
    if (owner.class === "operator") {
      const run = owner.owner_pool as string;
      const evidence = await readOperatorRun(target, run);
      const ours = evidence.state === "ok" && evidence.value.command === "take" && evidence.value.subject === gameId && (evidence.value.note ?? "").startsWith(marker);
      if (!ours) {
        unresolved.push({ game_id: gameId, class: "operator", detail: `held by ${run}, not a run of this recovery for ${input.from}: never touched` });
        continue;
      }
      if (budget <= 0) {
        remaining += 1;
        continue;
      }
      if (!input.apply) {
        planned.push(gameId);
        continue;
      }
      budget -= 1;
      const released = await releaseGameAsOperator(context, { gameId, run, note, apply: true });
      if (released.kind !== "applied") {
        unresolved.push({ game_id: gameId, class: "mutation", detail: `the resumed release of ${run} was ${released.kind}: ${describeResult(released)}` });
        continue;
      }
      acted.push({ game_id: gameId, action: "resumed-release", hold_run: run, release_run: released.run, money: moneyIds.has(gameId) });
      if (moneyIds.has(gameId)) waitFor.push(gameId);
      continue;
    }
    if (!mine) {
      if (owner.class === "orphaned" || owner.class === "ahead" || owner.class === "inconsistent" || owner.class === "unknown") {
        if (owner.owner_pool === null || owner.class === "unknown") unresolved.push({ game_id: gameId, class: owner.class, detail: owner.detail });
      }
      continue; // another pool's game (current or superseded): not this recovery's
    }
    if (owner.class === "current") {
      unresolved.push({ game_id: gameId, class: "current", detail: `owned by ${input.from}'s CURRENT task (epoch ${owner.owner_epoch}): never taken here -- ${input.from}'s task must restart (supersede the epoch) first` });
      continue;
    }
    if (owner.class !== "superseded") {
      unresolved.push({ game_id: gameId, class: owner.class, detail: owner.detail });
      continue;
    }
    /* Superseded, owner A: take then release (L6-3's primitives, unchanged). */
    if (budget <= 0) {
      remaining += 1;
      continue;
    }
    const isMoney = moneyIds.has(gameId) || (await openMoney(context, gameId)) === true;
    if (!input.apply) {
      planned.push(gameId);
      continue;
    }
    budget -= 1;
    const taken = await takeGameAsOperator(context, { gameId, note, apply: true });
    if (taken.kind !== "applied") {
      unresolved.push({ game_id: gameId, class: "mutation", detail: `take ${taken.kind}: ${describeResult(taken)}` });
      continue;
    }
    const released = await releaseGameAsOperator(context, { gameId, run: taken.run, note, apply: true });
    if (released.kind !== "applied") {
      unresolved.push({ game_id: gameId, class: "mutation", detail: `taken by ${taken.run}; its release was ${released.kind}: ${describeResult(released)} -- re-run the recovery (it releases this recovery's own holds)` });
      continue;
    }
    acted.push({ game_id: gameId, action: "taken-and-released", take_run: taken.run, release_run: released.run, money: isMoney });
    deps.progress?.(`  ${gameId}: taken from ${input.from}@${owner.owner_epoch} (${taken.run}) and released${isMoney ? " -- an open money game: waiting for the primary's money sweep" : ""}`);
    if (isMoney) waitFor.push(gameId);
  }

  /* The open money games now released: the primary's money claim sweep must CLAIM them (bounded wait). */
  const moneyClaimed: string[] = [];
  if (input.apply && waitFor.length > 0) {
    const deadline = context.now() + (input.moneyWaitMs ?? DEFAULT_MONEY_WAIT_MS);
    const pending = new Set(waitFor);
    for (;;) {
      const primaryPool = await readPoolView(target.app, target.tables.game, primary);
      for (const gameId of [...pending]) {
        const head = await readHeadView(target.app, target.tables.game, gameId);
        if (head.state === "ok" && head.value.owner_pool === primary && primaryPool.state === "ok" && head.value.pool_epoch === primaryPool.value.writer_epoch) {
          pending.delete(gameId);
          moneyClaimed.push(gameId);
        }
      }
      if (pending.size === 0 || context.now() >= deadline) break;
      await deps.sleep(input.pollMs ?? 5_000);
    }
    for (const gameId of [...pending].sort()) {
      const head = await readHeadView(target.app, target.tables.game, gameId);
      unresolved.push({
        game_id: gameId,
        class: "money-unclaimed",
        detail: `an open money game ${head.state === "ok" ? (head.value.owner_pool === NO_OWNER ? "still released" : `now owned by ${head.value.owner_pool}@${head.value.pool_epoch}`) : head.state}: the primary ${primary}'s money sweep has not claimed it (does ${primary} continue its financial record?)`,
      });
    }
  }
  const settled = input.apply && unresolved.length === 0 && remaining === 0 && problems.length === 0;
  context.audit("operator.recovery", { from: input.from, primary, apply: input.apply, acted: acted.length, money_claimed: moneyClaimed.length, unresolved: unresolved.length, remaining, settled });
  return { ...base, primary, planned, acted, money_claimed: moneyClaimed.sort(), unresolved, counts, remaining, problems, settled };
}
