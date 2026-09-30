// server/src/aws/ownership/roles.ts
//
// ==================================================================
//  LIVE-5 L5-3: TAKING A SINGLETON ROLE ONLY AS THE PRIMARY POOL'S CURRENT TASK -- AND WATCHING IT, AND THE GENERATION
// ==================================================================
//
// Preflight §4 row 27 / §5.3 step 3 / §5.5. The identity writer is ONE task: the current task of the primary pool. The
// role's epoch lives in the identity table (L5-4: so a game-table restore can never roll it back), and it is taken by
// L5-4's `takeOverIdentityWriter` TOGETHER WITH the routing and pool conditions (`aws/game/routing.ts`
// `roleTakeoverChecks`) in one cross-table transaction:
//
//     [ConditionCheck SYSTEM/ROUTING primary_pool = :P;  ConditionCheck POOL#P writer_epoch = :E;  Update ROLE epoch+1]
//
// The routing read before it is only a HINT for whether to try (and for the answer `not-primary`): the conditions decide.
// A refusal of a condition is then explained by reading again -- this task's pool epoch moved (LOST: the pool writer is
// told), or the routing no longer names this pool (`not-primary`) -- and anything it cannot explain is thrown, never
// guessed. Once taken, the role is WATCHED by the pool writer's self-check (`identityRoleProbe`): if a newer primary task
// takes it (an incompatible flip, preflight §15.2), this task is lost and exits -- a demoted identity writer must never
// keep answering from its in-memory index.
//
// The relayer role is L5-6's: the same `roleTakeoverChecks`, on the app-side mirror of the ledger's fence. This file
// does not take it.
//
// `generationProbe`: the ledger's adopted app generation (L5-5's APPGEN) must still be the one this task was started
// for; a restore adopted since (L6-4) makes it lost (preflight §5.5, §17.2).

import type { DynamoDBClient } from "@aws-sdk/client-dynamodb";

import { IdentityRoleRefusedError, readIdentityRole, takeOverIdentityWriter } from "../identity/dynamoIdentityStore";
import { readAdoptedGeneration } from "../ledger/dynamoSigningLedger";
import { readRouting, roleTakeoverChecks } from "../game/routing";
import type { HeldProbe, PoolWriter } from "./poolWriter";

export const IDENTITY_WRITER_ROLE = "identity-writer";

export type RoleTakeover =
  | { readonly kind: "taken"; readonly epoch: number }
  /** The routing does not name this pool primary: this task holds no role (it serves as a non-writer, L5-7/L6-1). */
  | { readonly kind: "not-primary"; readonly primary: string | null };

/** The identity-writer role, as a held probe: still held while the role item names exactly this task, pool and epoch. */
export function identityRoleProbe(client: DynamoDBClient, table: string, held: { readonly epoch: number; readonly task: string; readonly pool: string }): HeldProbe {
  return {
    async check() {
      const role = await readIdentityRole(client, table);
      if (role === null) return { held: false, detail: "the identity-writer role item is gone" };
      if (role.epoch !== held.epoch || role.task !== held.task || role.pool !== held.pool) {
        return { held: false, detail: `the role is at epoch ${role.epoch} (${role.task} of ${role.pool}), not this task's ${held.epoch}` };
      }
      return { held: true };
    },
  };
}

/** The ledger's adopted generation, as a held probe: held while it is still `generation`. */
export function generationProbe(client: DynamoDBClient, table: string, generation: number): HeldProbe {
  if (!Number.isSafeInteger(generation) || generation < 1) throw new Error("generationProbe: the generation must be a positive integer");
  return {
    async check() {
      const adopted = await readAdoptedGeneration(client, table);
      if (adopted === null) return { held: false, detail: "the ledger has no adopted generation" };
      if (adopted !== generation) return { held: false, detail: `the adopted generation is ${adopted}, not this task's ${generation}` };
      return { held: true };
    },
  };
}

/**
 * Take the identity-writer role for `writer`'s task -- only as the primary pool's current task (see the header) -- and
 * put it under the writer's self-check. `identity` is the identity table (same account as the game table; its client
 * sends the cross-table transaction). L5-7 calls this BEFORE loading identity (the store is then opened with the epoch
 * returned: `createDynamoIdentityStore({ epoch })`), never the other way round.
 */
export async function takeIdentityWriterRole(
  writer: PoolWriter,
  identity: { readonly client: DynamoDBClient; readonly table: string },
  options: { readonly now: () => number; readonly maxAttempts?: number; readonly sleep?: (ms: number) => Promise<void> },
): Promise<RoleTakeover> {
  writer.assertCurrent();
  const hint = await readRouting(writer.client, writer.table);
  if (hint === null || hint.primary_pool !== writer.pool) return { kind: "not-primary", primary: hint?.primary_pool ?? null };
  let epoch: number;
  try {
    ({ epoch } = await takeOverIdentityWriter(identity.client, identity.table, {
      task: writer.task,
      pool: writer.pool,
      now: options.now,
      checks: roleTakeoverChecks(writer.table, writer.fence),
      ...(options.maxAttempts !== undefined ? { maxAttempts: options.maxAttempts } : {}),
      ...(options.sleep !== undefined ? { sleep: options.sleep } : {}),
    }));
  } catch (error) {
    if (!(error instanceof IdentityRoleRefusedError)) throw error;
    /* Refused -- or not known (the takeover also gives up when the table kept moving or did not answer, and an attempt
       of ours may have LANDED). Explain it from what the table holds now, never guess: first the role itself (ours ->
       taken, whatever else moved: a role this task holds must be watched, never left unwatched), then this task's pool
       (lost), then the routing (not primary). Anything else stays an error. */
    const role = await readIdentityRole(identity.client, identity.table);
    if (role !== null && role.task === writer.task && role.pool === writer.pool) {
      writer.holdRole(IDENTITY_WRITER_ROLE, identityRoleProbe(identity.client, identity.table, { epoch: role.epoch, task: writer.task, pool: writer.pool }));
      return { kind: "taken", epoch: role.epoch };
    }
    const self = await writer.check();
    if (self.kind === "lost") throw error;
    const routing = await readRouting(writer.client, writer.table);
    if (routing === null || routing.primary_pool !== writer.pool) return { kind: "not-primary", primary: routing?.primary_pool ?? null };
    throw error;
  }
  writer.holdRole(IDENTITY_WRITER_ROLE, identityRoleProbe(identity.client, identity.table, { epoch, task: writer.task, pool: writer.pool }));
  return { kind: "taken", epoch };
}
