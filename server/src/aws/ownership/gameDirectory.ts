// server/src/aws/ownership/gameDirectory.ts
//
// ==================================================================
//  LIVE-6 L6-1: WHO OWNS A GAME, AND WHICH POOL IS PRIMARY -- STRONG READS FOR A TASK THAT CLAIMS NOTHING
// ==================================================================
//
// A non-primary task (`routerServer.ts`) must answer "where is this game served?" without claiming the game (a claim is
// a write, and would take the game from its owner's future loads) and without trusting anything but the table as it is
// NOW. So this is three strongly consistent reads and nothing else:
//
//   ownerOf(g)     `GAME#<g>/HEAD` (L5-2's `readHead`): no item -> `absent`; `owner_pool = #none` -> `released`; a pool
//                  (or an operator run `op:<run>`) with a positive integer epoch -> `owned`. Anything else -- no owner, no
//                  epoch, an owner that is not a pool id -- is DAMAGE: thrown, never read as released or as anyone's.
//   primaryPool()  `SYSTEM/ROUTING` (L5-3's `readRouting`: strict; an item this build cannot read throws) -> its primary
//                  pool, or `null` when no routing was ever written.
//   record(g)      the game's `META` through L5-2's record store's own `load` (its strict classification: a damaged or a
//                  newer record throws `StoreCorruptError` / `StoreIncompatibleError`) -- for the read authorization only.
//                  Only `load` is reachable from here: the object handed out has no other method.
//
// No write, no transaction, no condition, no claim, no release. A read that fails rethrows; the caller fails closed.

import type { DynamoDBClient } from "@aws-sdk/client-dynamodb";

import type { GameRecord } from "../../rooms/gameRecord";
import type { GameDirectory, GameOwnerRead } from "../../rooms/gameRoutes";
import { createDynamoRecordStore } from "../game/dynamoRecordStore";
import { fenceProblem, NO_OWNER, readHead, type WriterFence } from "../game/gameTable";
import { readRouting } from "../game/routing";

export class GameHeadDamagedError extends Error {
  constructor(gameId: string, what: string) {
    super(`the ownership HEAD of ${gameId} ${what}: damage, not an owner (no destination is derived from it)`);
    this.name = "GameHeadDamagedError";
  }
}

export interface PoolGameDirectory extends GameDirectory {
  /** The game's record, read strongly now (read-only; for the read authorization). */
  readonly records: { load(gameId: string): Promise<GameRecord | null> };
}

/** The read-only directory over the game table. `fence` is only what L5-2's record store is constructed with (its
 *  `load` never uses it); nothing here writes. */
export function poolGameDirectory(options: { readonly client: DynamoDBClient; readonly table: string; readonly fence: WriterFence }): PoolGameDirectory {
  const { client, table } = options;
  const store = createDynamoRecordStore({ client, table, fence: options.fence });
  return {
    async ownerOf(gameId): Promise<GameOwnerRead> {
      const head = await readHead(client, table, gameId);
      if (head === null) return { kind: "absent" };
      const owner = head.owner_pool;
      if (owner === null || owner === "") throw new GameHeadDamagedError(gameId, "names no owner");
      if (owner === NO_OWNER) return { kind: "released" };
      const epoch = head.pool_epoch;
      if (epoch === null || !Number.isSafeInteger(epoch) || epoch < 1) throw new GameHeadDamagedError(gameId, "has no well-formed epoch");
      if (fenceProblem({ pool: owner, epoch }) !== null) throw new GameHeadDamagedError(gameId, "names an owner that is not a pool id");
      return { kind: "owned", pool: owner };
    },
    async primaryPool() {
      const routing = await readRouting(client, table);
      return routing === null ? null : routing.primary_pool;
    },
    records: Object.freeze({ load: (gameId: string) => store.load(gameId) }),
  };
}
