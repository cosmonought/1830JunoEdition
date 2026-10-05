/** @jest-environment node */
//
// PHASE 3 (W1-K, AUD-19.02): the cross-tab Keplr lock, adversarially. Two "tabs" are two locks over one shared
// mechanism (one Web Locks manager, or one localStorage), as two real tabs of one origin share them. Every case asks
// the same question: can two tabs ever hold Keplr at once -- and can a dead tab hold it for ever?

import { createKeplrLock, KEPLR_LEASE_KEY, KEPLR_LEASE_MS, KEPLR_LEASE_RENEW_MS, KEPLR_LEASE_SETTLE_MS, KEPLR_LOCK_NAME, KEPLR_MAX_HOLD_MS, type LockManagerLike } from "./keplrLock";
import { memoryStorage } from "./moneyTestSupport";

const instant = (): Promise<void> => Promise.resolve();

function gate(): { wait: Promise<void>; open: () => void } {
  let open: () => void = () => undefined;
  const wait = new Promise<void>((resolve) => (open = resolve));
  return { wait, open };
}

function fakeLocks(): LockManagerLike & { held: Set<string> } {
  const held = new Set<string>();
  return {
    held,
    async request(name, _options, callback) {
      if (held.has(name)) return callback(null);
      held.add(name);
      try {
        return await callback({ name });
      } finally {
        held.delete(name);
      }
    },
  };
}

describe("W1-K: Web Locks (where the browser has them)", () => {
  it("one tab at a time; the second is told at once (never queued); free again when the first finishes -- even when it throws", async () => {
    const locks = fakeLocks();
    const a = createKeplrLock({ locks });
    const b = createKeplrLock({ locks });
    expect(a.mechanism).toBe("web-locks");
    const hold = gate();
    const first = a.withLock(async () => {
      await hold.wait;
      return "a";
    });
    await Promise.resolve();
    expect(locks.held.has(KEPLR_LOCK_NAME)).toBe(true);
    expect(await b.withLock(async () => "b")).toEqual({ kind: "busy" });
    expect(await a.withLock(async () => "a-again")).toEqual({ kind: "busy" }); // the same tab's second click too
    hold.open();
    expect(await first).toEqual({ kind: "ran", value: "a" });
    expect(await b.withLock(async () => "b")).toEqual({ kind: "ran", value: "b" });
    await expect(a.withLock(async () => Promise.reject(new Error("Keplr closed")))).rejects.toThrow("Keplr closed");
    expect(locks.held.size).toBe(0);
  });
});

describe("W1-K: the localStorage lease (no Web Locks)", () => {
  it("two tabs over one storage: the second is busy while the first runs, the lease is renewed while it runs and removed after", async () => {
    const storage = memoryStorage();
    let now = 1_000;
    const renewals: Array<() => void> = [];
    const every = (run: () => void) => {
      renewals.push(run);
      return () => renewals.splice(renewals.indexOf(run), 1);
    };
    const a = createKeplrLock({ settle: instant, storage, now: () => now, tag: () => "tab-a", every });
    const b = createKeplrLock({ settle: instant, storage, now: () => now, tag: () => "tab-b", every });
    expect(a.mechanism).toBe("storage-lease");
    const hold = gate();
    const first = a.withLock(async () => {
      await hold.wait;
      return 1;
    });
    await Promise.resolve();
    expect(JSON.parse(storage.map.get(KEPLR_LEASE_KEY) as string)).toEqual({ owner: "tab-a", until: 1_000 + KEPLR_LEASE_MS });
    expect(await b.withLock(async () => 2)).toEqual({ kind: "busy" });
    /* Long after the first lease would have lapsed, the running tab's renewal keeps it. */
    now += KEPLR_LEASE_MS - 1;
    renewals.forEach((renew) => renew());
    now += KEPLR_LEASE_MS - 1;
    expect(await b.withLock(async () => 2)).toEqual({ kind: "busy" });
    hold.open();
    expect(await first).toEqual({ kind: "ran", value: 1 });
    expect(storage.map.has(KEPLR_LEASE_KEY)).toBe(false);
    expect(renewals).toHaveLength(0);
    expect(await b.withLock(async () => 2)).toEqual({ kind: "ran", value: 2 });
  });

  it("a tab that died holding it frees Keplr when its lease runs out -- never for ever", async () => {
    const storage = memoryStorage();
    let now = 5_000;
    storage.setItem(KEPLR_LEASE_KEY, JSON.stringify({ owner: "dead-tab", until: now + KEPLR_LEASE_MS }));
    const b = createKeplrLock({ settle: instant, storage, now: () => now, tag: () => "tab-b", every: () => () => undefined });
    expect(await b.withLock(async () => "b")).toEqual({ kind: "busy" });
    now += KEPLR_LEASE_MS + 1;
    expect(await b.withLock(async () => "b")).toEqual({ kind: "ran", value: "b" });
  });

  it("two tabs writing in the same instant: the one whose write lost (read back as the other's) stands down", async () => {
    const storage = memoryStorage();
    const now = 9_000;
    /* Tab A's write lands, then -- before A reads it back -- tab B's write overwrites it. */
    const racing = {
      ...storage,
      setItem: (key: string, value: string) => {
        storage.setItem(key, value);
        if (JSON.parse(value).owner === "tab-a") storage.setItem(key, JSON.stringify({ owner: "tab-b", until: now + KEPLR_LEASE_MS }));
      },
      getItem: storage.getItem,
      removeItem: storage.removeItem,
    };
    const a = createKeplrLock({ settle: instant, storage: racing, now: () => now, tag: () => "tab-a", every: () => () => undefined });
    let ran = false;
    expect(
      await a.withLock(async () => {
        ran = true;
      }),
    ).toEqual({ kind: "busy" });
    expect(ran).toBe(false);
    /* And A never removes B's lease. */
    expect(JSON.parse(storage.map.get(KEPLR_LEASE_KEY) as string).owner).toBe("tab-b");
  });

  it("a garbled lease is no lease; a storage that refuses writes still lets this page act (it cannot coordinate, never blocks)", async () => {
    const storage = memoryStorage();
    storage.setItem(KEPLR_LEASE_KEY, "{not json");
    const a = createKeplrLock({ settle: instant, storage, now: () => 1, tag: () => "tab-a", every: () => () => undefined });
    expect(await a.withLock(async () => "ok")).toEqual({ kind: "ran", value: "ok" });
    const refusing = memoryStorage();
    refusing.failWrites = true;
    const c = createKeplrLock({ settle: instant, storage: refusing, now: () => 1, tag: () => "tab-c", every: () => () => undefined });
    expect(await c.withLock(async () => "ok")).toEqual({ kind: "ran", value: "ok" });
  });

  it("no storage at all: this page's own single flight", async () => {
    const page = createKeplrLock({});
    expect(page.mechanism).toBe("page");
    const hold = gate();
    const first = page.withLock(async () => {
      await hold.wait;
      return 1;
    });
    expect(await page.withLock(async () => 2)).toEqual({ kind: "busy" });
    hold.open();
    expect(await first).toEqual({ kind: "ran", value: 1 });
  });

  it("the lease holds no credential and no account: an opaque tag and a time", async () => {
    const storage = memoryStorage();
    const a = createKeplrLock({ settle: instant, storage, now: () => 1, every: () => () => undefined });
    await a.withLock(async () => {
      const lease = JSON.parse(storage.map.get(KEPLR_LEASE_KEY) as string);
      expect(Object.keys(lease).sort()).toEqual(["owner", "until"]);
      expect(lease.owner).toMatch(/^[0-9a-z]+$/);
    });
  });
});

describe("W1-K hardening (independent review L3)", () => {
  it("a lock manager that REJECTS (the action never started) falls back to the lease -- never blocks the player; the action's own rejection stays the action's", async () => {
    const storage = memoryStorage();
    const refusing: LockManagerLike = {
      request: () => Promise.reject(new DOMException("The request is not allowed", "SecurityError")),
    };
    const a = createKeplrLock({ locks: refusing, storage, settle: instant, tag: () => "tab-a", every: () => () => undefined });
    const b = createKeplrLock({ locks: refusing, storage, settle: instant, tag: () => "tab-b", every: () => () => undefined });
    const hold = gate();
    let runs = 0;
    const first = a.withLock(async () => {
      runs += 1;
      await hold.wait;
      return "a";
    });
    for (let n = 0; n < 5; n += 1) await Promise.resolve();
    expect(JSON.parse(storage.map.get(KEPLR_LEASE_KEY) as string).owner).toBe("tab-a");
    expect(await b.withLock(async () => "b")).toEqual({ kind: "busy" }); // still one tab at a time, through the lease
    hold.open();
    expect(await first).toEqual({ kind: "ran", value: "a" });
    expect(runs).toBe(1);
    const locks = fakeLocks();
    const c = createKeplrLock({ locks, storage, settle: instant });
    await expect(c.withLock(async () => Promise.reject(new Error("Request rejected")))).rejects.toThrow("Request rejected");
    expect(storage.map.has(KEPLR_LEASE_KEY)).toBe(false); // an action's own failure never fell through to a second run
  });

  it("a Keplr request that never answers frees Keplr for the OTHER tabs after the max hold (Web Locks); the hung action's answer still reaches its own tab", async () => {
    const locks = fakeLocks();
    const timers: Array<{ run: () => void; ms: number }> = [];
    const after = (run: () => void, ms: number) => {
      const timer = { run, ms };
      timers.push(timer);
      return () => timers.splice(timers.indexOf(timer), 1);
    };
    const a = createKeplrLock({ locks, after });
    const b = createKeplrLock({ locks, after });
    const hung = gate();
    const first = a.withLock(async () => {
      await hung.wait;
      return "late";
    });
    for (let n = 0; n < 5; n += 1) await Promise.resolve();
    expect(await b.withLock(async () => "b")).toEqual({ kind: "busy" });
    expect(timers.map((timer) => timer.ms)).toEqual([KEPLR_MAX_HOLD_MS]);
    timers[0].run(); // the max hold passes
    for (let n = 0; n < 5; n += 1) await Promise.resolve();
    expect(locks.held.size).toBe(0);
    expect(await b.withLock(async () => "b")).toEqual({ kind: "ran", value: "b" });
    /* ...but never a second Keplr window from THIS page while its own action still runs (re-review NIT). */
    expect(await a.withLock(async () => "same page")).toEqual({ kind: "busy" });
    hung.open();
    expect(await first).toEqual({ kind: "ran", value: "late" });
    expect(await a.withLock(async () => "after")).toEqual({ kind: "ran", value: "after" });
  });

  it("the lease is renewed only up to the max hold: a hung tab's lease then lapses for the others", async () => {
    const storage = memoryStorage();
    let now = 1_000;
    const renewals: Array<() => void> = [];
    const every = (run: () => void) => {
      renewals.push(run);
      return () => renewals.splice(renewals.indexOf(run), 1);
    };
    const a = createKeplrLock({ storage, settle: instant, now: () => now, tag: () => "tab-a", every });
    const b = createKeplrLock({ storage, settle: instant, now: () => now, tag: () => "tab-b", every });
    const hung = gate();
    void a.withLock(async () => hung.wait);
    for (let n = 0; n < 5; n += 1) await Promise.resolve();
    for (let elapsed = 0; elapsed < KEPLR_MAX_HOLD_MS; elapsed += KEPLR_LEASE_RENEW_MS) {
      now += KEPLR_LEASE_RENEW_MS;
      renewals.forEach((renew) => renew());
      if (now - 1_000 < KEPLR_MAX_HOLD_MS) expect(await b.withLock(async () => "b")).toEqual({ kind: "busy" });
    }
    now += KEPLR_LEASE_MS + 1;
    renewals.forEach((renew) => renew());
    expect(await b.withLock(async () => "b")).toEqual({ kind: "ran", value: "b" });
    hung.open();
  });

  it("another tab's write that arrives AFTER this tab's own read-back (storage events lag between processes): the settle's re-read sees it, and this tab stands down", async () => {
    const storage = memoryStorage();
    const now = 3_000;
    let delivered: (() => void) | null = null;
    /* Tab B's write is on its way: it lands only during A's settle. */
    const settle = async (ms: number) => {
      expect(ms).toBe(KEPLR_LEASE_SETTLE_MS);
      delivered?.();
    };
    delivered = () => storage.setItem(KEPLR_LEASE_KEY, JSON.stringify({ owner: "tab-b", until: now + KEPLR_LEASE_MS }));
    const a = createKeplrLock({ storage, settle, now: () => now, tag: () => "tab-a", every: () => () => undefined });
    let ran = false;
    expect(
      await a.withLock(async () => {
        ran = true;
      }),
    ).toEqual({ kind: "busy" });
    expect(ran).toBe(false);
    expect(JSON.parse(storage.map.get(KEPLR_LEASE_KEY) as string).owner).toBe("tab-b");
    /* A double click on THIS page during the settle is the page's own single flight. */
    let release: () => void = () => undefined;
    const slow = createKeplrLock({ storage: memoryStorage(), settle: () => new Promise<void>((resolve) => (release = resolve)), tag: () => "tab-c", every: () => () => undefined });
    const pending = slow.withLock(async () => "c");
    expect(await slow.withLock(async () => "again")).toEqual({ kind: "busy" });
    release();
    expect(await pending).toEqual({ kind: "ran", value: "c" });
  });
});
