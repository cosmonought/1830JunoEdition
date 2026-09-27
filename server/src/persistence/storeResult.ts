// server/src/persistence/storeResult.ts
//
// LIVE-3B: what a store write can come back as, and what a store read can refuse with.
//
// ==================================================================
//  LIVE-3 §8.2 / §17: A WRITE IS COMMITTED, DEFINITELY NOT, OR UNKNOWN -- AND THE STORE SAYS WHICH
// ==================================================================
//
// LIVE-3A had to treat every rejected append as "unknown" and read the room back to find out what landed (the
// 3A temporary rule). That read is exactly what LIVE-3 §8.2 step 7 forbids: after a failed `fsync` the kernel may
// keep the pages cached and call them clean, so a re-read can SEE a batch the disk does not hold. The store is the
// only layer that knows whether any byte could have reached storage, so it classifies, and the actor acts on the
// class instead of guessing:
//
//   committed   every byte written and synced (possibly after one REDO of the same batch at the same offset).
//               The actor publishes.
//   definite    nothing reached storage -- the failure came before the first write was issued (an open that
//               failed, a guard that refused). The actor rolls back and answers `retry`.
//   uncertain   bytes may or may not be on disk and the store's own redo did not settle it. The store has marked
//               the game held and refuses further writes to it; the actor holds the game `uncertain` and the
//               process must restart (fail-fast, the fsyncgate rule) -- the load after a restart reads the disk's
//               truth, truncates any stray tail, and syncs before serving.
//
// A store that rejects instead of answering (the legacy `appendLog` / `saveRoomDoc` shape, or a bug) is read as
// UNCERTAIN unless it threw `StoreDefiniteError`: an unclassified failure is never proof that nothing landed.

export type StoreWriteOutcome =
  | { readonly kind: "committed"; readonly redone: boolean }
  | { readonly kind: "definite"; readonly detail: string }
  | { readonly kind: "uncertain"; readonly detail: string };

export const COMMITTED: StoreWriteOutcome = Object.freeze({ kind: "committed", redone: false } as const);

/** Nothing reached storage. Thrown by the legacy throwing wrappers; a retry is safe. */
export class StoreDefiniteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreDefiniteError";
  }
}

/** The outcome is unknown and the store could not settle it. The game is held; the process must restart. */
export class StoreUncertainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreUncertainError";
  }
}

/** A load could not establish a valid history prefix without guessing (LIVE-3 §8.3 / §8.4). The file is left
 *  exactly as found; the game is held `corrupt` until an operator repairs it with `logDoctor`. */
export class StoreCorruptError extends Error {
  constructor(
    message: string,
    readonly file: string,
    readonly offset: number,
  ) {
    super(message);
    this.name = "StoreCorruptError";
  }
}

/** LIVE-3C: a durable item written by a NEWER build than this one (a record schema it does not know). Not damage and
 *  never rewritten: this build cannot interpret it, so the game is `incompatible` until a build that can loads it. */
export class StoreIncompatibleError extends Error {
  constructor(
    message: string,
    readonly file: string,
  ) {
    super(message);
    this.name = "StoreIncompatibleError";
  }
}

export const isStoreIncompatible = (error: unknown): error is StoreIncompatibleError =>
  error instanceof StoreIncompatibleError || (error instanceof Error && error.name === "StoreIncompatibleError");

export const isStoreCorrupt = (error: unknown): error is StoreCorruptError =>
  error instanceof StoreCorruptError || (error instanceof Error && error.name === "StoreCorruptError");

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** How a REJECTED store call is read: definite only when the store said so; anything else is uncertain. */
export function outcomeOf(error: unknown): StoreWriteOutcome {
  if (error instanceof StoreDefiniteError || (error instanceof Error && error.name === "StoreDefiniteError")) {
    return { kind: "definite", detail: describe(error) };
  }
  return { kind: "uncertain", detail: describe(error ?? "the store rejected the write") };
}

/** For the legacy throwing API: resolve on committed, throw the matching error otherwise. */
export function throwUnlessCommitted(outcome: StoreWriteOutcome): void {
  if (outcome.kind === "committed") return;
  if (outcome.kind === "definite") throw new StoreDefiniteError(outcome.detail);
  throw new StoreUncertainError(outcome.detail);
}
