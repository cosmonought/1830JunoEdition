// server/src/aws/ownership/poolGameOwnership.ts
//
// ==================================================================
//  LIVE-5 L5-3: PER-GAME OWNERSHIP ON THE GAME TABLE -- CLAIM BEFORE LOAD, ROUTE, RELEASE, THE FENCED REACTION, THE SWEEP
// ==================================================================
//
// The rooms layer's `GameOwnership` port (`rooms/gameOwnership.ts`) in POOL mode, over L5-2's primitives
// (`aws/game/ownership.ts`) and one `PoolWriter`:
//
//   claim(g)    L5-2's `claimGame` with the writer's (pool, epoch, task): ONE transaction [the POOL fence; the HEAD
//               updated COND it exists AND (it is this pool's at this or an older epoch, OR released)]. Its answer is
//               the table's, never this process's opinion:
//                 claimed          this task owns g now. `onClaimed(g)` runs before the claim resolves (L5-7: the escrow
//                                  service's strong read of g's financial record, so `isRosterFrozen(g)` comes from the
//                                  claim's read, preflight §13 step 6); if it fails, the claim fails (the load does).
//                 absent           no HEAD: g does not exist here (a creation makes its HEAD in its first write).
//                 stale-pool       this task's epoch is not its pool's newest: LOST (the pool writer is told; L5-7 exits).
//                 owned-elsewhere  by THIS pool at a NEWER epoch (a number above this task's) -> LOST as well (a newer
//                                  task of the pool claimed it); by another pool or an operator run -> `GameRoutedError`
//                                  (never taken from it: a game moves between pools only by a release, a retirement or an
//                                  operator, preflight §5.6). A HEAD this build cannot read (no owner, no numeric epoch)
//                                  is DAMAGE: thrown as such, never read as a takeover (the load fails; nothing is lost).
//                 unknown          thrown: the load fails, the next ask claims again (a claim is idempotent: a landed one
//                                  is admitted by its own condition).
//   release(g)  L5-2's `releaseGame` (owner := none, only by the writer that owns it) -- for an evicted NO-MONEY game.
//               Best effort: a release that fails leaves g owned by this task (the safe direction: nobody else can
//               write it, and this task claims it again at its next load).
//   onFenced    a write the table refused for its fence: the POOL fence -> LOST at once (the table evaluated
//               `writer_epoch = :E` false; epochs never move back); the GAME fence -> a self-check now (the game was
//               taken -- by an operator, or by a newer task of the pool, which the check then finds).
//
// ORDER PER GAME. A claim and a release of the same game are ASKED one after another in the order they were asked: the
// registry asks the release in the same synchronous step that evicts the actor, so a load that starts after the eviction
// claims after the release was answered. (A release whose answer was lost and which the table evaluates late can still
// land after that claim: the resident actor's next write is then refused by its fence and the actor dropped -- never a
// write under the wrong owner.)
//
// THE MONEY CLAIM SWEEP (`sweepMoneyClaims`, preflight §5.3; L5-7 runs it every 60 s and once at startup): every OPEN
// money game (`FINKEYS` -> each `FINIDX#` partition) that nobody owns -- released, or this pool's at an older epoch -- and
// whose financial record this pool CONTINUES (`continues`: L5-7 passes the money continuation verdict against this
// deployment) is claimed, then handed to `onSwept` (L5-7: load its actor, so its background work has a fenced owner).
// Games owned by another live pool are left alone. A financial record that cannot be read, or is not continued, is not
// claimed. A game owned by a RETIRED pool is not taken here: pool retirement (`POOL#.status`) is L6-1/L6-2's, and the
// retired-pool claim (`ConditionCheck POOL#<old> status = retired`) lands with it.
//   - Before it claims back a game this task did not own at its epoch, the sweep asks `beforeRetake(g)` (L5-7: the game
//     server's `retakeResident`): a RESIDENT actor of g holds memory from before g left this task, and the new claim
//     would re-arm its writes under the same fence -- it is dropped first, and only when quiescent (no write of it in
//     flight); otherwise g is left for the next pass.
//   - A claim that landed but whose hand-on failed (`onClaimed` or `onSwept`) is remembered, and handed on again at the
//     next pass; so is every owned open money game with no resident actor (`isResident`: a player's load whose claim
//     landed and whose load then failed, an actor evicted when idle) -- an owned game is never left without the load that
//     serves its background work. (An idle money actor is therefore evicted and loaded again about every 30 minutes.)

import type { DynamoDBClient } from "@aws-sdk/client-dynamodb";

import type { FinancialGameRecord } from "../../escrow/moneyLifecycle";
import type { FenceScope } from "../../persistence/storeResult";
import { GameOwnershipLostError, GameRoutedError, type ClaimAnswer, type GameOwnership } from "../../rooms/gameOwnership";
import { NO_OWNER, readHead } from "../game/gameTable";
import { claimGame, releaseGame } from "../game/ownership";
import type { ResendTiming } from "../game/transact";
import type { PoolWriter } from "./poolWriter";

export interface PoolGameOwnershipOptions {
  readonly client: DynamoDBClient;
  readonly table: string;
  readonly writer: PoolWriter;
  /** After a claim lands, before it resolves (L5-7: the escrow service's roster refresh from the financial record). */
  readonly onClaimed?: (gameId: string) => Promise<void>;
  readonly timing?: Partial<ResendTiming>;
  readonly warn?: (line: string) => void;
}

/** What the money claim sweep reads (the DynamoDB financial store: `identityKeys`, `openGames`, `load`). */
export interface OpenMoneyGames {
  identityKeys(): Promise<string[]>;
  openGames(identityKey: string): Promise<string[]>;
  load(gameId: string): Promise<FinancialGameRecord | null>;
}

export interface SweepReport {
  /** Claimed by this pass (and handed to `onSwept`). */
  readonly claimed: string[];
  /** Already this task's. */
  readonly owned: number;
  /** Owned by another live pool or an operator run: left alone. */
  readonly elsewhere: number;
  /** Not continued by this pool, or its financial record is gone: not claimed. */
  readonly skipped: number;
  /** Could not be judged or claimed this pass (a read failed, a claim's outcome unknown, `onSwept` failed): tried again
   *  at the next pass. */
  readonly failed: Array<{ readonly gameId: string; readonly detail: string }>;
}

export interface PoolGameOwnership extends GameOwnership {
  readonly mode: "pool";
  /** One pass of the money claim sweep (see the header). Stops early, and reports so, when the writer is lost. */
  sweepMoneyClaims(input: {
    readonly financial: OpenMoneyGames;
    readonly continues: (record: FinancialGameRecord) => boolean;
    /** Before claiming back a game this task did not own: false leaves it for the next pass (see the header). */
    readonly beforeRetake: (gameId: string) => boolean;
    /** Whether the game's actor is resident in this task (L5-7: the game server's `isResident`). An owned game with no
     *  actor -- its load failed after its claim landed, or its actor was evicted -- is handed on again. Absent: only the
     *  games this sweep claimed are handed on again. */
    readonly isResident?: (gameId: string) => boolean;
    readonly onSwept?: (gameId: string) => Promise<void>;
  }): Promise<SweepReport>;
  /** Tests and shutdown: every claim and release asked so far has settled. */
  settled(): Promise<void>;
}

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function createPoolGameOwnership(options: PoolGameOwnershipOptions): PoolGameOwnership {
  const { client, table, writer } = options;
  const warn = options.warn ?? (() => undefined);
  /** The last claim/release asked of each game; the next one runs after it (see "ORDER PER GAME"). */
  const tails = new Map<string, Promise<unknown>>();
  /** Games the sweep claimed whose hand-on (`onClaimed` / `onSwept`) has not yet succeeded. */
  const handOn = new Set<string>();

  function inOrder<T>(gameId: string, work: () => Promise<T>): Promise<T> {
    const previous = tails.get(gameId) ?? Promise.resolve();
    const next = previous.then(work, work);
    const tail = next.then(
      () => undefined,
      () => undefined,
    );
    tails.set(gameId, tail);
    void tail.then(() => {
      if (tails.get(gameId) === tail) tails.delete(gameId);
    });
    return next;
  }

  async function claimNow(gameId: string): Promise<ClaimAnswer> {
    if (writer.lost !== null) throw new GameOwnershipLostError(`this task no longer holds pool ${writer.pool}: ${writer.lost}`);
    const outcome = await claimGame(client, table, gameId, writer.fence, options.timing ?? {});
    switch (outcome.kind) {
      case "claimed":
        if (options.onClaimed !== undefined) await options.onClaimed(gameId);
        return { kind: "claimed" };
      case "absent":
        return { kind: "absent" };
      case "stale-pool": {
        const reason = `the claim of ${gameId} was refused by the pool fence: epoch ${writer.epoch} is no longer pool ${writer.pool}'s newest`;
        writer.markLost(reason);
        throw new GameOwnershipLostError(reason);
      }
      case "owned-elsewhere": {
        const { owner_pool: owner, pool_epoch: epoch } = outcome.head;
        if (owner === null || owner === "") throw new Error(`the HEAD of ${gameId} names no owner: damage, not a takeover (not served)`);
        if (owner === writer.pool) {
          /* Only a NEWER epoch proves a newer task of this pool took it; anything else (no epoch, not a number) is damage. */
          if (epoch === null || !Number.isSafeInteger(epoch) || epoch <= writer.epoch) throw new Error(`the HEAD of ${gameId} names pool ${owner} at epoch ${String(epoch)}: damage, not a takeover (not served)`);
          const reason = `${gameId} is claimed by a newer task of pool ${writer.pool} (epoch ${epoch})`;
          writer.markLost(reason);
          throw new GameOwnershipLostError(reason);
        }
        throw new GameRoutedError(gameId, owner);
      }
    }
  }

  const ownership: PoolGameOwnership = {
    mode: "pool",

    claim(gameId) {
      return inOrder(gameId, () => claimNow(gameId));
    },

    release(gameId) {
      void inOrder(gameId, async () => {
        if (writer.lost !== null) return; // a stale task writes nothing, a release included
        try {
          const released = await releaseGame(client, table, gameId, writer.fence);
          if (!released) warn(`  ownership: ${gameId} was not this task's to release (another writer holds it)`);
        } catch (error) {
          warn(`  ownership: ${gameId} could not be released (${describe(error)}); it stays owned by this task`);
        }
      });
    },

    onFenced(gameId, scope: FenceScope, detail) {
      if (scope === "pool") writer.markLost(`a write to ${gameId} was refused by the pool fence (${detail})`);
      else writer.checkSoon();
    },

    async sweepMoneyClaims(input) {
      const report = { claimed: [] as string[], owned: 0, elsewhere: 0, skipped: 0, failed: [] as Array<{ gameId: string; detail: string }> };
      const keys = await input.financial.identityKeys();
      for (const identityKey of keys) {
        let games: string[];
        try {
          games = await input.financial.openGames(identityKey);
        } catch (error) {
          report.failed.push({ gameId: `FINIDX#${identityKey}`, detail: `the open games could not be listed (${describe(error)})` });
          continue;
        }
        for (const gameId of games) {
          if (writer.lost !== null) {
            report.failed.push({ gameId, detail: `the sweep stopped: ${writer.lost}` });
            return report;
          }
          try {
            const head = await readHead(client, table, gameId);
            if (head === null) {
              report.failed.push({ gameId, detail: "an open money game with no HEAD (a financial record is created with it)" });
              continue;
            }
            const mine = head.owner_pool === writer.pool && head.pool_epoch === writer.epoch;
            if (mine && !handOn.has(gameId) && (input.isResident === undefined || input.isResident(gameId))) {
              report.owned += 1;
              continue;
            }
            if (!mine) {
              if (head.owner_pool === null || (head.owner_pool === writer.pool && (head.pool_epoch === null || !Number.isSafeInteger(head.pool_epoch)))) {
                report.failed.push({ gameId, detail: "its HEAD is not well-formed (damage): not claimed" });
                continue;
              }
              const free = head.owner_pool === NO_OWNER || (head.owner_pool === writer.pool && (head.pool_epoch as number) < writer.epoch);
              if (!free) {
                report.elsewhere += 1;
                continue;
              }
              const record = await input.financial.load(gameId);
              if (record === null || !input.continues(record)) {
                report.skipped += 1;
                continue;
              }
              if (!input.beforeRetake(gameId)) {
                report.failed.push({ gameId, detail: "a resident actor of it is not quiescent yet: left for the next pass" });
                continue;
              }
            }
            /* Claim (or, for a claim whose hand-on failed, claim again: idempotent, and it re-runs `onClaimed`), then hand on. */
            handOn.add(gameId);
            const answer = await ownership.claim(gameId);
            if (answer.kind !== "claimed") {
              handOn.delete(gameId);
              report.skipped += 1;
              continue;
            }
            if (input.onSwept !== undefined) await input.onSwept(gameId);
            handOn.delete(gameId);
            report.claimed.push(gameId);
          } catch (error) {
            if (error instanceof GameRoutedError) {
              handOn.delete(gameId);
              report.elsewhere += 1; // taken by another pool between the read and the claim
              continue;
            }
            report.failed.push({ gameId, detail: describe(error) });
            if (error instanceof GameOwnershipLostError) return report;
          }
        }
      }
      return report;
    },

    async settled() {
      while (tails.size > 0) await Promise.all([...tails.values()]);
    },
  };
  return ownership;
}
