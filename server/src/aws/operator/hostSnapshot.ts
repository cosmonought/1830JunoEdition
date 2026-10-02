// server/src/aws/operator/hostSnapshot.ts
//
// ==================================================================
//  COST-2A: `gamesDoctor aws host-snapshot --out <file>` -- THE RUNTIME HALF OF THE HOST EVIDENCE (READ-ONLY)
// ==================================================================
//
// The host verifier (`awsDeploy verify --topology coexist | single-host`, aws/deploy/hostVerify.ts) runs with the
// bootstrap / verifier role, which reads the control records but not the pool, role and money items. The operator role
// reads them (`gamesDoctor aws status`, `games --money`). This command writes exactly those answers, with the operator's
// own readers, into ONE file of the host evidence directory -- nothing new is read and nothing is written to AWS:
//   status        `inspectDeployment` (SYSTEM/ROUTING, APPGEN, the pools it can name, the identity-writer role and its
//                 holder, the relayer mirror against the ledger fence, findings) -- the `status --json` structure;
//   route_pools   POOL#<pool> for EVERY pool of the runtime document's route table (coexistence: the ECS era's p2 too);
//   money         `listGames({ money: true })` -- every OPEN money game and its owner class (the `games --money --json`
//                 structure); a listing that fails is recorded as such, never as an empty one.
// The verifier judges it (fresh, this deployment's, the roles held by the host pool's current task). Every answer keeps its
// absent / ok / unreadable / unavailable state; no item content beyond what `status` already prints.

import * as fs from "fs";
import * as path from "path";

import { inspectDeployment, listGames, readPoolView, type DeploymentInspection, type GameListing, type PoolView, type Read } from "./inspect";
import type { OperatorTarget } from "./operatorTarget";

/** Must equal aws/deploy/hostVerify.ts's (the operator tooling never imports the deploy tool; a test pins the two). */
export const HOST_RUNTIME_SNAPSHOT_FORMAT = "18COSMOS/HOST-RUNTIME-SNAPSHOT/v1";

export interface HostRuntimeSnapshot {
  readonly format: typeof HOST_RUNTIME_SNAPSHOT_FORMAT;
  readonly captured_at: string;
  readonly environment: string;
  readonly region: string;
  readonly generation: number;
  readonly configured_pool: string;
  readonly status: DeploymentInspection;
  readonly route_pools: ReadonlyArray<{ readonly pool: string; readonly item: Read<PoolView> }>;
  readonly money: GameListing | { readonly source: "open-money"; readonly error: string };
}

export async function hostSnapshot(target: OperatorTarget, now: () => number): Promise<HostRuntimeSnapshot> {
  const status = await inspectDeployment(target);
  const pools = [...new Set([target.config.pool, ...Object.keys(target.config.routes)])].sort();
  const route_pools: Array<HostRuntimeSnapshot["route_pools"][number]> = [];
  for (const pool of pools) route_pools.push({ pool, item: await readPoolView(target.app, target.tables.game, pool) });
  let money: HostRuntimeSnapshot["money"];
  try {
    money = await listGames(target, { money: true });
  } catch (error) {
    money = { source: "open-money", error: `${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`.slice(0, 300) };
  }
  return {
    format: HOST_RUNTIME_SNAPSHOT_FORMAT,
    captured_at: new Date(now()).toISOString(),
    environment: target.config.environment,
    region: target.config.region,
    generation: target.config.generation,
    configured_pool: target.config.pool,
    status,
    route_pools,
    money,
  };
}

/** Written whole or not at all (a partial file never stands where a complete one is expected). */
export function writeHostSnapshot(file: string, snapshot: HostRuntimeSnapshot): void {
  const full = path.resolve(file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(`${full}.partial`, `${JSON.stringify(snapshot, null, 2)}\n`);
  fs.renameSync(`${full}.partial`, full);
}
