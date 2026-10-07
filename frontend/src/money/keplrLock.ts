// frontend/src/money/keplrLock.ts
//
// ==================================================================
//  PHASE 3 (W1-K, AUD-19.02): ONE KEPLR CONVERSATION AT A TIME, ACROSS EVERY TAB OF THIS SITE
// ==================================================================
//
// THE DEFECT. Each tab's money panel had its own single flight (`useMoneyTable`'s busy latch), so two tabs of the same
// browser -- the same seat, or two tables -- could each start a wallet step at once: two Keplr windows stacked, a link
// signature approved in one tab answering the other tab's challenge order, a second deposit prepared while the first
// was still being approved. Keplr itself does not serialise sites' requests in a way a player can follow.
//
// THE LOCK. Every action that may open Keplr runs inside `withKeplrLock`:
//
//   1. the Web Locks API (`navigator.locks.request(name, {ifAvailable: true})`) where the browser has it -- held by
//      the browser for exactly as long as the action runs, released even when the tab crashes or closes, and shared
//      by every tab and worker of this origin;
//   2. otherwise a LEASE in localStorage: `{owner, until}` written, read back (another tab that wrote in the same
//      instant wins and this one stands down), renewed while the action runs, and removed only by its owner. A tab
//      that died holding it frees it when the lease runs out (90 s) -- no tab waits on a dead one for ever;
//   3. otherwise (no storage at all) a lock for this page alone.
//
// NEVER QUEUED. A second tab is not made to wait and then run a step that may no longer be wanted: it is told at once
// that Keplr is busy in another tab ("busy"), and when the player presses again everything is RE-EVALUATED from the
// server's view and this browser's records (the step the other tab finished is simply not asked again). The lease
// holds no credential and no account: an opaque random owner tag and a time.
//
// HARDENING (independent review, L3):
//   * a browser whose `navigator.locks.request` REJECTS (an opaque origin, a privacy mode) falls back to the lease --
//     the player is never blocked by the lock's own failure (a rejection of the ACTION itself is the action's, and is
//     returned as it was);
//   * the lease is RE-READ after a short settle (`KEPLR_LEASE_SETTLE_MS`), not only at once: another tab's write in the
//     same instant reaches this one's storage only after a moment, and the read-back right after this tab's own write
//     would still show its own. After the settle every tab agrees on the last writer, and only that one runs;
//   * no action holds Keplr past `KEPLR_MAX_HOLD_MS` for the OTHER tabs: a Keplr request that never answers (an
//     extension that hung) frees the lock after it -- the Web Lock is released, the lease is no longer renewed -- while
//     this tab's own panel stays busy until its action ends (its own latch) or the page is reloaded.

import type { KeyValueStorage } from "./pendingTx";

export const KEPLR_LOCK_NAME = "18cosmos-keplr";
export const KEPLR_LEASE_KEY = "18cosmos.keplr-lease.v1";
/** How long a lease holds without renewal (a tab that died mid-action frees Keplr after this). */
export const KEPLR_LEASE_MS = 90_000;
/** How often a running action renews its lease. */
export const KEPLR_LEASE_RENEW_MS = 20_000;
/** How long after writing its lease a tab re-reads it, so a write by another tab in the same instant has arrived. */
export const KEPLR_LEASE_SETTLE_MS = 150;
/** The longest one action holds Keplr for the other tabs (Keplr's own windows answer well within it). */
export const KEPLR_MAX_HOLD_MS = 10 * 60_000;

/** What another tab's player reads. */
export const KEPLR_BUSY_SENTENCE = "Keplr is busy in another tab of this site. Finish or cancel there, then press the button again.";

export type KeplrLockResult<T> = { readonly kind: "ran"; readonly value: T } | { readonly kind: "busy" };

/** The slice of `navigator.locks` this uses. */
export interface LockManagerLike {
  request<T>(name: string, options: { ifAvailable: true }, callback: (lock: unknown) => Promise<T>): Promise<T>;
}

export interface KeplrLockEnvironment {
  readonly locks?: LockManagerLike | null;
  readonly storage?: KeyValueStorage | null;
  readonly now?: () => number;
  /** An opaque owner tag for the lease. */
  readonly tag?: () => string;
  readonly every?: (run: () => void, ms: number) => () => void;
  /** One-shot timer (the max hold); answers its cancel. */
  readonly after?: (run: () => void, ms: number) => () => void;
  /** The lease's settle before its re-read. */
  readonly settle?: (ms: number) => Promise<void>;
}

export interface KeplrLock {
  withLock<T>(task: () => Promise<T>): Promise<KeplrLockResult<T>>;
  /** Which mechanism this lock uses (tests and the report). */
  readonly mechanism: "web-locks" | "storage-lease" | "page";
}

function randomTag(): string {
  const source = (globalThis as { crypto?: { getRandomValues?: (bytes: Uint8Array) => Uint8Array } }).crypto;
  if (typeof source?.getRandomValues === "function") return Array.from(source.getRandomValues(new Uint8Array(12)), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
}

const defaultEvery = (run: () => void, ms: number): (() => void) => {
  const timer = setInterval(run, ms);
  return () => clearInterval(timer);
};
const defaultAfter = (run: () => void, ms: number): (() => void) => {
  const timer = setTimeout(run, ms);
  return () => clearTimeout(timer);
};
const defaultSettle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface Lease {
  readonly owner: string;
  readonly until: number;
}

function readLease(storage: KeyValueStorage): Lease | null {
  let raw: string | null;
  try {
    raw = storage.getItem(KEPLR_LEASE_KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as { owner?: unknown; until?: unknown };
    return typeof parsed.owner === "string" && typeof parsed.until === "number" && Number.isFinite(parsed.until) ? { owner: parsed.owner, until: parsed.until } : null;
  } catch {
    return null;
  }
}

export function createKeplrLock(env: KeplrLockEnvironment = {}): KeplrLock {
  const now = env.now ?? (() => Date.now());
  const every = env.every ?? defaultEvery;
  const after = env.after ?? defaultAfter;
  const settle = env.settle ?? defaultSettle;
  const locks = env.locks ?? null;
  const storage = env.storage ?? null;
  /* This page's own single flight: covers the storage lease's read-then-write gap within one page, and is the whole
     lock when there is nothing else. */
  let pageBusy = false;

  const pageLock = async <T,>(task: () => Promise<T>): Promise<KeplrLockResult<T>> => {
    if (pageBusy) return { kind: "busy" };
    pageBusy = true;
    try {
      return { kind: "ran", value: await task() };
    } finally {
      pageBusy = false;
    }
  };

  const leaseLock = async <T,>(store: KeyValueStorage, task: () => Promise<T>): Promise<KeplrLockResult<T>> => {
    if (pageBusy) return { kind: "busy" };
    const held = readLease(store);
    if (held !== null && held.until > now()) return { kind: "busy" };
    const mine = (env.tag ?? randomTag)();
    const write = () => store.setItem(KEPLR_LEASE_KEY, JSON.stringify({ owner: mine, until: now() + KEPLR_LEASE_MS }));
    let wrote = true;
    try {
      write();
    } catch {
      /* Storage refused the write: this page alone, then (it cannot coordinate, but it never blocks the player). */
      wrote = false;
    }
    pageBusy = true;
    if (wrote) {
      const isMine = () => {
        const check = readLease(store);
        return check === null || check.owner === mine;
      };
      /* At once (a write this page can already see), and again after the settle (one still on its way). */
      let standing = isMine();
      if (standing) {
        await settle(KEPLR_LEASE_SETTLE_MS);
        standing = isMine();
      }
      if (!standing) {
        pageBusy = false;
        return { kind: "busy" }; // another tab wrote in the same instant, and its write stands
      }
    }
    const startedAt = now();
    const stop = every(() => {
      /* Renewed while the action runs -- up to the max hold, after which the lease simply lapses for the other tabs. */
      if (now() - startedAt >= KEPLR_MAX_HOLD_MS) return;
      const current = readLease(store);
      if (current === null || current.owner === mine) {
        try {
          write();
        } catch {
          /* keep running: the lease simply lapses */
        }
      }
    }, KEPLR_LEASE_RENEW_MS);
    try {
      return { kind: "ran", value: await task() };
    } finally {
      stop();
      pageBusy = false;
      const current = readLease(store);
      if (current !== null && current.owner === mine) {
        try {
          store.removeItem(KEPLR_LEASE_KEY);
        } catch {
          /* it lapses on its own */
        }
      }
    }
  };

  const fallbackLock = <T,>(task: () => Promise<T>): Promise<KeplrLockResult<T>> => (storage !== null ? leaseLock(storage, task) : pageLock(task));

  if (locks !== null) {
    return {
      mechanism: "web-locks",
      async withLock<T>(task: () => Promise<T>): Promise<KeplrLockResult<T>> {
        /* Re-review NIT: this page's own single flight too -- after the max hold has freed the Web Lock for the OTHER
           tabs, another panel of THIS page still cannot open a second Keplr window while the first action runs. */
        if (pageBusy) return { kind: "busy" };
        /* The action runs at most once, and its own outcome (a value or a rejection) is kept apart from the lock's. */
        const run: { started: boolean; running: Promise<T> | null } = { started: false, running: null };
        let answer: "busy" | "ran";
        try {
          answer = await locks.request(KEPLR_LOCK_NAME, { ifAvailable: true }, async (lock): Promise<"busy" | "ran"> => {
            if (lock === null || lock === undefined) return "busy";
            run.started = true;
            pageBusy = true;
            let running: Promise<T>;
            try {
              running = task();
            } catch (error) {
              running = Promise.reject(error);
            }
            run.running = running;
            void running.then(
              () => (pageBusy = false),
              () => (pageBusy = false),
            );
            /* Held while the action runs -- but never past the max hold (the lock is released; the action goes on). */
            let cancel: () => void = () => undefined;
            const cap = new Promise<void>((resolve) => (cancel = after(resolve, KEPLR_MAX_HOLD_MS)));
            try {
              await Promise.race([running.then(() => undefined, () => undefined), cap]);
            } finally {
              cancel();
            }
            return "ran";
          });
        } catch (error) {
          /* The lock manager itself refused (the action never started): the lease, then. */
          if (!run.started) return fallbackLock(task);
          throw error;
        }
        if (answer === "busy" || run.running === null) return { kind: "busy" };
        return { kind: "ran", value: await run.running };
      },
    };
  }

  if (storage !== null) {
    return {
      mechanism: "storage-lease",
      withLock: (task) => leaseLock(storage, task),
    };
  }

  return {
    mechanism: "page",
    withLock: pageLock,
  };
}

let installed: KeplrLock | null = null;

/** The page's lock: Web Locks where the browser has them, else the localStorage lease, else this page alone. */
export function browserKeplrLock(): KeplrLock {
  if (installed !== null) return installed;
  const nav = typeof navigator === "undefined" ? undefined : (navigator as unknown as { locks?: LockManagerLike });
  let storage: KeyValueStorage | null = null;
  try {
    storage = typeof window !== "undefined" && window.localStorage ? window.localStorage : null;
  } catch {
    storage = null;
  }
  installed = createKeplrLock({ locks: nav?.locks && typeof nav.locks.request === "function" ? nav.locks : null, storage });
  return installed;
}

/** Tests only. */
export function installKeplrLockForTests(lock: KeplrLock | null): void {
  installed = lock;
}
