// server/src/rooms/gameOwnership.ts
//
// ==================================================================
//  LIVE-5 L5-3: WHO MAY WRITE A GAME -- THE PORT THE ROOMS LAYER SEES
// ==================================================================
//
// Two kinds of ownership, one port:
//
//   PROCESS  (file and memory stores, today's production): one server owns the whole data directory through its lock
//            (`persistence/processLock.ts`). Every game it can reach is its own; there is nothing to claim, route or
//            release. `PROCESS_OWNERSHIP` is that: every claim answers `claimed`, nothing else ever happens.
//   POOL     (DynamoDB, LIVE-5; `aws/ownership/`, wired by L5-7): a game is written only by the task that CLAIMED it --
//            its HEAD names (pool, epoch), and every write carries that fence inside itself (L5-2). So:
//              - a game is CLAIMED BEFORE ITS LOAD reads anything (the load's first step), and a claim that finds
//                another live pool owning the game answers `GameRoutedError` -- the load fails and nothing is served;
//              - a claim that finds this task stale (a newer task took the pool) answers `GameOwnershipLostError` and the
//                pool writer gives the whole pool up (L5-7: exit 3);
//              - `absent` -- no HEAD: a game that does not exist yet (a table being created makes its HEAD in its first,
//                pool-fenced write). A load that nevertheless finds a record or a log is refused: data without a HEAD
//                could never be written here (every write would be fenced), so it is not served as if it could;
//              - a write the table refused for its FENCE (`persistence/storeResult.ts` `fenceScopeOf`) is reported
//                (`onFenced`): the game's actor is dropped, never retried -- another writer owns the game now;
//              - an idle NO-MONEY game is released when its actor is evicted; a money game stays owned (its background
//                work -- checkpoints, sweeps, chain observation -- needs a fenced owner, preflight §5.3).
//
// Nothing here decides anything on its own: the storage decides (the claim is one conditional write; the fence is inside
// every write). This port only carries those answers to the rooms layer, and it never turns an unknown into a verdict.

import type { FenceScope } from "../persistence/storeResult";

export type ClaimAnswer =
  /** This task owns the game now (its HEAD names this task's pool and epoch). */
  | { readonly kind: "claimed" }
  /** No such game in the ownership store (no HEAD): only a game about to be created may be loaded on this answer. */
  | { readonly kind: "absent" };

export interface GameOwnership {
  /** `process`: the data-directory lock is the whole fence; `pool`: per-game claims (DynamoDB). */
  readonly mode: "process" | "pool";
  /** Claim `gameId` for this task -- before anything of it is read. Rejects `GameRoutedError` (another pool, or an
   *  operator run, owns it), `GameOwnershipLostError` (this task is stale), or any other error when the claim's outcome
   *  is not known (the load fails and the next ask claims again: a claim is idempotent). */
  claim(gameId: string): Promise<ClaimAnswer>;
  /** An idle game's actor was evicted: give a NO-MONEY game back. Never throws; a release that fails leaves the game
   *  owned by this task, which is the safe direction. */
  release(gameId: string): void;
  /** A write to `gameId` was refused by a fence (`scope` says which). */
  onFenced(gameId: string, scope: FenceScope, detail: string): void;
}

/** The game is owned by another pool (or an operator run): not served here. L6-1 turns this into a `route` answer with a
 *  destination; until then it is answered like any load that could not complete ("unavailable", tried again later). */
export class GameRoutedError extends Error {
  constructor(
    readonly gameId: string,
    readonly ownerPool: string,
  ) {
    super(`game ${gameId} is owned by ${ownerPool.startsWith("op:") ? "an operator run" : "another pool"} (${ownerPool}); it is not served here`);
    this.name = "GameRoutedError";
  }
}

/** This task no longer holds its pool (a newer task took it over, or its epoch was never the pool's): it may claim and
 *  write nothing, and gives the whole pool up. */
export class GameOwnershipLostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GameOwnershipLostError";
  }
}

/** A claim found no HEAD, but the game's record or log exists: data this task could never write (every write would be
 *  fenced). Refused, never served; an importer must write the game's HEAD first (the L5-2 handoff). */
export class GameWithoutHeadError extends Error {
  constructor(readonly gameId: string) {
    super(`game ${gameId} has a record or a log but no ownership HEAD: it cannot be claimed, so it is not served (an importer must write its HEAD)`);
    this.name = "GameWithoutHeadError";
  }
}

/** The file and memory stores' ownership: the process lock is the whole fence. */
export const PROCESS_OWNERSHIP: GameOwnership = Object.freeze({
  mode: "process" as const,
  claim: async (): Promise<ClaimAnswer> => ({ kind: "claimed" }),
  release: () => undefined,
  onFenced: () => undefined,
});
