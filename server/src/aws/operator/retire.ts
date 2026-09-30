// server/src/aws/operator/retire.ts
//
// ==================================================================
//  LIVE-6 L6-2: POOL RETIREMENT -- THE PROOF THAT A DEMOTED POOL IS NO LONGER NEEDED (PROCEDURAL; NO DURABLE MARKER)
// ==================================================================
//
// `gamesDoctor aws retire-check <pool> [--evidence <dir>]` -- READ-ONLY. A FLIP only demotes: the pool stays deployed as a
// non-primary router. RETIREMENT is later and explicit, and this is its gate.
//
// THE DURABLE MARKER IS NOT BUILT (the report's owner decision). The architecture preflight names `POOL#.status`
// (primary / draining / retired) and a retired-pool claim (`ConditionCheck POOL#<old> status = retired`), but no
// authoritative schema exists: L5-3 moved "primary" to SYSTEM/ROUTING instead of the pool item, so the preflight's status
// enum no longer fits; nothing defines who writes `status`, how `takeOverPool` (which rewrites the item on every task
// start) keeps or refuses it -- the resurrection question -- or how the certified `claimGame` would carry the retired-pool
// condition; and L6-3's strict pool parser deliberately treats `status` as an unknown attribute that every mutation
// refuses. Inventing it here would change the certified ownership substrate by the back door. So retirement is the
// strongest PROCEDURE the current schema supports, and its durable record is the Terraform state (desired_count 0).
//
// THE PREREQUISITES (every one a strong read of the authoritative item; `ready` only if all hold):
//   R1 the pool is not the primary (SYSTEM/ROUTING);
//   R2 it holds no singleton role: the identity writer, and (with escrow) the relayer mirror, name another pool;
//   R3 NO game HEAD names it -- at its current epoch or a superseded one (run `recover <pool>` first) -- in the directory
//      or the open money games; an operator hold that is an unresolved migration from it (a run of `recover <pool>`) also
//      blocks;
//   R4 its financial work has moved: no open money game is released-and-unclaimed (the primary's sweep claims them; a
//      game nobody claims may still need this pool);
//   R5 no route needs it: with R1 and R3 no route frame can name it (a route names the owner, or the primary for a
//      released game) -- its route entry and ALB rule are dead, removable at the next planned (drain-first) deployment;
//   R6 (with --evidence) it is DRAINED by L5-8's drain-first rule: its service is desired 0, running 0, pending 0,
//      settled, and its target group has no target.
// Verdicts: `blocked` (a prerequisite fails), `ready-to-drain` (R1-R5 hold; run drain-pool, capture, re-check), `retired`
// (R1-R6 hold). The procedure (infra/aws/README.md "Retirement"): recover -> retire-check -> drain-pool -> capture ->
// retire-check --evidence -> Terraform `desired_count = 0` for the pool (the durable record; its image, task definition,
// target group and log group are KEPT -- recreating a pool is the recovery for a removed last-compatible version). The
// flip preflight refuses to make a drained (desired 0) pool primary; scaling it up again only brings back a non-primary
// router that claims nothing.

import { readRelayerRole } from "../game/relayerRole";
import { primaryPoolProblem, readRouting } from "../game/routing";
import { readIdentityRole } from "../identity/dynamoIdentityStore";
import { checkDrained, checkTargetHealth, POOL_EVIDENCE_FILES, readEvidence, type Check } from "../controlPlane/evidence";
import { listGames, ownerOf, readAs, readHeadView, readOperatorRun, readPoolView } from "./inspect";
import type { OperatorTarget } from "./operatorTarget";
import { RECOVERY_MARKER } from "./recovery";

export type RetirementVerdict = "blocked" | "ready-to-drain" | "retired";

export interface RetirementReport {
  readonly pool: string;
  readonly verdict: RetirementVerdict;
  readonly checks: readonly Check[];
}

const pass = (name: string, detail: string): Check => ({ name, status: "pass", detail });
const fail = (name: string, detail: string): Check => ({ name, status: "fail", detail });

export async function retirementCheck(target: OperatorTarget, pool: string, evidence: string | null): Promise<RetirementReport> {
  const checks: Check[] = [];
  const problem = primaryPoolProblem(pool);
  if (problem !== null) return { pool, verdict: "blocked", checks: [fail("pool id", problem)] };
  const item = await readPoolView(target.app, target.tables.game, pool);
  checks.push(item.state === "ok" && item.value.extra.length === 0 ? pass(`POOL#${pool}`, `epoch ${item.value.writer_epoch}, ${item.value.writer_task}`) : fail(`POOL#${pool}`, item.state === "ok" ? `carries [${item.value.extra.join(", ")}]` : item.state));

  /* R1 */
  const routing = await readAs(() => readRouting(target.app, target.tables.game));
  checks.push(routing.state === "ok" && routing.value.primary_pool !== pool ? pass("R1 not the primary", `the primary is ${routing.value.primary_pool}`) : fail("R1 not the primary", routing.state === "ok" ? `${pool} IS the primary: flip first` : `SYSTEM/ROUTING ${routing.state}`));
  /* R2 */
  const role = await readAs(() => readIdentityRole(target.app, target.tables.identity));
  checks.push(role.state === "ok" && role.value.pool !== pool ? pass("R2 no identity-writer role", `held by ${role.value.pool}`) : role.state === "absent" ? pass("R2 no identity-writer role", "never taken") : fail("R2 no identity-writer role", role.state === "ok" ? `held by ${pool} (${role.value.task})` : `the role ${role.state}`));
  if (target.escrow.state === "ok") {
    const mirror = await readAs(() => readRelayerRole(target.app, target.tables.game, (target.escrow as { relayer: string }).relayer));
    checks.push(mirror.state === "ok" && mirror.value.pool !== pool ? pass("R2 no relayer role", `held by ${mirror.value.pool}`) : mirror.state === "absent" ? pass("R2 no relayer role", "never taken") : fail("R2 no relayer role", mirror.state === "ok" ? `held by ${pool}` : `the mirror ${mirror.state}`));
  }
  /* R3, R4 */
  const directory = await listGames(target);
  const money = await listGames(target, { money: true });
  const moneyIds = new Set(money.games.map((g) => g.game_id));
  const owned: string[] = [];
  const holds: string[] = [];
  const unclaimed: string[] = [];
  const unreadable: string[] = [...directory.problems, ...money.problems];
  const pools = new Map();
  for (const gameId of [...new Set([...directory.games, ...money.games].map((g) => g.game_id))].sort()) {
    const owner = await ownerOf(target, await readHeadView(target.app, target.tables.game, gameId), pools);
    if (owner.owner_pool === pool) owned.push(`${gameId} (${owner.class} @${owner.owner_epoch})`);
    else if (owner.class === "operator") {
      const run = await readOperatorRun(target, owner.owner_pool as string);
      if (run.state !== "ok" || (run.value.note ?? "").startsWith(RECOVERY_MARKER(pool))) holds.push(`${gameId} (${owner.owner_pool}${run.state === "ok" ? "" : `, its evidence ${run.state}`})`);
    } else if (owner.class === "released" && moneyIds.has(gameId)) unclaimed.push(gameId);
    else if (owner.class === "unknown") unreadable.push(`${gameId}: ${owner.detail}`);
  }
  checks.push(owned.length === 0 ? pass("R3 no game names it", "no HEAD names it at any epoch") : fail("R3 no game names it", `${owned.length}: ${owned.slice(0, 10).join(", ")}${owned.length > 10 ? ", ..." : ""} -- superseded ones: run \`recover ${pool}\`; a current one: its task must restart first`));
  checks.push(holds.length === 0 ? pass("R3 no unresolved migration", "no operator hold of a recovery from it") : fail("R3 no unresolved migration", `${holds.join(", ")}: re-run \`recover ${pool}\``));
  checks.push(unclaimed.length === 0 ? pass("R4 financial work moved", "no open money game waits unclaimed") : fail("R4 financial work moved", `open money games released and not claimed: ${unclaimed.join(", ")}`));
  checks.push(unreadable.length === 0 ? pass("reads", "every index and HEAD read") : fail("reads", `${unreadable.length} could not be read: ${unreadable.slice(0, 5).join("; ")}`));
  const r5 = checks.filter((c) => /^R[13] /.test(c.name)).every((c) => c.status === "pass");
  checks.push(r5 ? pass("R5 no route needs it", "not the primary and no HEAD names it: no route frame can name it") : fail("R5 no route needs it", "R1 / R3 do not hold"));
  const dataReady = checks.every((c) => c.status === "pass");

  /* R6 */
  if (evidence === null) return { pool, verdict: dataReady ? "ready-to-drain" : "blocked", checks: [...checks, { name: "R6 drained", status: "skipped", detail: "no --evidence: run infra/aws/scripts/drain-pool, capture-evidence, then retire-check --evidence" }] };
  const services = readEvidence(evidence, POOL_EVIDENCE_FILES.services);
  checks.push(services.ok ? checkDrained(services.value, target.config.environment, pool) : services.check);
  const health = readEvidence(evidence, POOL_EVIDENCE_FILES.targetHealth(pool));
  checks.push(health.ok ? checkTargetHealth(pool, health.value, 0) : health.check);
  const all = checks.every((c) => c.status === "pass");
  return { pool, verdict: all ? "retired" : dataReady ? "ready-to-drain" : "blocked", checks };
}
