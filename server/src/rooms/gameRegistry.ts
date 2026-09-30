// server/src/rooms/gameRegistry.ts
//
// LIVE-3A: at most one actor per game in this process (E-12), created once however many ask at once.
//
// ==================================================================
//  LIVE-3 P2: TWO FIRST-TOUCH HELLOS, TWO SESSIONS, ONE ACKNOWLEDGED MOVE LOST FROM MEMORY
// ==================================================================
//
// `roomFor` checked its map, awaited the store, then wrote the map. Two `hello`s for a room nobody had touched
// since the restart both missed, both loaded, and the second session replaced the first -- after the first had
// already applied and acknowledged a move. That move vanished from memory, the next one was minted at its
// index, and the file held `[0,1,1]`.
//
// SINGLE-FLIGHT, IN ONE SYNCHRONOUS STEP. `get` looks the game up and, only on a miss, creates its actor and
// records it before returning -- no `await` between the look and the write -- so every later caller finds the
// same actor and waits on the same load (§3.6). The load is the actor's first task; nothing runs before it.
//
// EVICTION IS ALWAYS SAFE, BECAUSE AN ACTOR IS NEVER DIRTY. Outside a running task it holds only what the store
// holds (E-4), so dropping an idle one loses nothing: the next request builds a fresh actor that loads from the
// store. Idle means nothing queued or running, nobody subscribed, and no commit whose outcome is unknown (E-13);
// it is evicted after 30 minutes of that, or sooner, least recently used first, past 300 resident. The check and
// the removal are one synchronous step. WITHOUT A STORE NOTHING IS EVICTED: an in-memory game (a test, the smoke
// run) has nowhere to be reloaded from.

import type { GameActor } from "./gameActor";

/** §3.6 */
export const IDLE_EVICTION_MS = 30 * 60_000;
export const MAX_RESIDENT_ACTORS = 300;
export const EVICTION_SWEEP_MS = 60_000;

export interface GameRegistryOptions {
  /** Builds an actor, which starts its own load. */
  create(gameId: string): GameActor;
  /** Whether a game can be reloaded after eviction -- true only with a durable store. */
  evictable: boolean;
  /** LIVE-3C: called once per successful load, BEFORE any caller waiting on `get` resumes -- so whatever it queues on
   *  the actor (the load's reconciliation) runs ahead of every task those callers queue. */
  onLoaded?(gameId: string, actor: GameActor): void;
  /** LIVE-5 L5-3: an idle actor was EVICTED (not closed, not discarded) -- called in the same synchronous step that drops
   *  it, so whatever it asks (a release of the game's ownership) is asked before any later load of the game can start. */
  onEvicted?(gameId: string, actor: GameActor): void;
  now(): number;
  idleMs?: number;
  maxResident?: number;
  sweepMs?: number;
}

export class GameRegistry {
  private readonly actors = new Map<string, GameActor>();
  private readonly options: GameRegistryOptions;
  private readonly sweep: ReturnType<typeof setInterval> | null;
  /** How many actors this registry has created, for diagnostics and tests. */
  created = 0;

  constructor(options: GameRegistryOptions) {
    this.options = options;
    if (options.evictable) {
      this.sweep = setInterval(() => this.evictIdle(options.now()), options.sweepMs ?? EVICTION_SWEEP_MS);
      (this.sweep as { unref?: () => void }).unref?.();
    } else {
      this.sweep = null;
    }
  }

  /** The game's actor, once it has loaded. Single-flight: concurrent callers share one actor and one load. */
  get(gameId: string): Promise<GameActor> {
    let actor = this.actors.get(gameId);
    if (actor === undefined) {
      const created = this.options.create(gameId);
      this.created += 1;
      this.actors.set(gameId, created);
      /* Attached before any caller's continuation, so it runs first (promise reactions run in the order attached). */
      created.ready.then(
        () => {
          try {
            if (this.actors.get(gameId) === created) this.options.onLoaded?.(gameId, created);
          } catch {
            /* the hook reports its own failures; a load is never undone by one */
          }
        },
        () => undefined,
      );
      /* A load that failed leaves nothing behind: the actor is dropped here, so the next request tries again,
         and everybody who was waiting on it hears the failure. */
      created.ready.catch(() => {
        if (this.actors.get(gameId) === created) this.actors.delete(gameId);
        created.dispose();
      });
      actor = created;
    }
    const found = actor;
    return found.ready.then(() => found);
  }

  /** The resident actor, if any, without creating or loading one. */
  peek(gameId: string): GameActor | undefined {
    return this.actors.get(gameId);
  }

  forEach(visit: (actor: GameActor, gameId: string) => void): void {
    this.actors.forEach((actor, gameId) => visit(actor, gameId));
  }

  get size(): number {
    return this.actors.size;
  }

  /** Drop idle actors: after the idle period, and least recently used first past the resident cap. */
  evictIdle(now: number): string[] {
    if (!this.options.evictable) return [];
    const idleMs = this.options.idleMs ?? IDLE_EVICTION_MS;
    const maxResident = this.options.maxResident ?? MAX_RESIDENT_ACTORS;
    const evicted: string[] = [];
    this.actors.forEach((actor, gameId) => {
      if (actor.idle && now - actor.lastActiveAt >= idleMs) evicted.push(gameId);
    });
    for (const gameId of evicted) this.evict(gameId);
    if (this.actors.size > maxResident) {
      const idle = [...this.actors.entries()]
        .filter(([, actor]) => actor.idle)
        .sort(([, a], [, b]) => a.lastActiveAt - b.lastActiveAt);
      for (const [gameId] of idle) {
        if (this.actors.size <= maxResident) break;
        this.evict(gameId);
        evicted.push(gameId);
      }
    }
    return evicted;
  }

  /**
   * LIVE-5 L5-3: drop `actor` now, whatever it holds, if it is still `gameId`'s resident actor -- a write of it was
   * refused by the ownership fence, so another writer owns the game and nothing this actor holds may be served or built
   * on. Its queued tasks are answered, never run (`dispose`). The next ask builds a fresh actor, which claims afresh.
   * Not an eviction: nothing is released (the game is not this task's). True when it was dropped.
   */
  discard(gameId: string, actor: GameActor): boolean {
    if (this.actors.get(gameId) !== actor) return false;
    this.actors.delete(gameId);
    actor.dispose();
    return true;
  }

  private evict(gameId: string): void {
    const actor = this.actors.get(gameId);
    if (actor === undefined) return;
    this.actors.delete(gameId);
    actor.dispose();
    try {
      this.options.onEvicted?.(gameId, actor);
    } catch {
      /* the hook reports its own failures; an eviction is never undone by one */
    }
  }

  /** The server is closing: no sweep, and every actor answers what it still holds queued. */
  close(): void {
    if (this.sweep !== null) clearInterval(this.sweep);
    this.actors.forEach((actor) => actor.dispose());
    this.actors.clear();
  }
}
