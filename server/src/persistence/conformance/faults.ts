// server/src/persistence/conformance/faults.ts
//
// ==================================================================
//  LIVE-5 L5-1: DETERMINISTIC FAULT INJECTION FOR PERSISTENCE OPERATIONS
// ==================================================================
//
// Every fault here is SCRIPTED, never random and never timed. A test says which operation fails, on which matching
// call, and how; the script consumes that rule on exactly that call, records every call it saw, and can say afterwards
// which scripted faults never fired (a fault that never fires is a test that proved nothing, so the conformance
// runner fails such a case: `FaultScript.unfired`). There is no sleep anywhere: a "timeout" is a STALL behind a
// `Gate` that the test itself opens, so "the caller gave up, and the operation finished later" is an ordering the test
// controls, not a race it hopes to win.
//
// THE FAULT CLASSES (what a later LIVE-5 slice needs to be able to say):
//
//   fail          the operation fails BEFORE it has any effect (a transient read or write failure, a refused
//                 connection, throttling): nothing reached storage.
//   lose-answer   the operation RUNS TO COMPLETION and then the caller is told it failed (a timeout after the server
//                 applied the write, a dropped response): it landed, and the caller cannot know. This is the class that
//                 separates an idempotent retry from a double write.
//   stall         the operation waits at a gate the test opens (a timeout from the caller's point of view: the caller
//                 may give up and issue the next operation while this one is still pending).
//   duplicate     the operation is delivered twice (an at-least-once transport, a retried request whose first copy
//                 also landed): the second answer is returned.
//   partial       (file seam only) the first N bytes of a write reach the file, then an error: a torn write.
//   short         (file seam only) a write reports fewer bytes than asked, without an error.
//
// Conditional-write conflicts and stale fences are NOT faults of the transport: they are the store's own answers,
// produced by real concurrent writers (a second handle that writes first; `ControlledFence.takeOver`). The conformance
// modules create them that way, so the same case runs unchanged against DynamoDB, where the condition is evaluated by
// the service.

import type { StoreFileHandle, StoreFs } from "../../fileLogStore";

/* ------------------------------------------------------------------ */
/* Gates: the only way anything here waits                             */
/* ------------------------------------------------------------------ */

export interface Gate {
  /** Resolves when an operation has arrived at the gate (so the test knows it is stalled there, not merely queued). */
  readonly reached: Promise<void>;
  readonly isReached: boolean;
  /** Let the stalled operation continue. Idempotent. */
  release(): void;
  /** Resolves once `release` has been called (what the stalled operation awaits). */
  readonly opened: Promise<void>;
}

export function gate(): Gate {
  let markReached: () => void = () => undefined;
  let open: () => void = () => undefined;
  let isReached = false;
  const reached = new Promise<void>((resolve) => {
    markReached = () => {
      isReached = true;
      resolve();
    };
  });
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  const state = {
    reached,
    opened,
    get isReached() {
      return isReached;
    },
    release: () => open(),
    /** internal: called by the injector when an operation arrives */
    arrive: () => markReached(),
  };
  return state as Gate;
}

/** Mark a gate reached (for injectors outside this file). */
export const arrive = (g: Gate): void => (g as unknown as { arrive(): void }).arrive();

/* ------------------------------------------------------------------ */
/* The script                                                          */
/* ------------------------------------------------------------------ */

export class InjectedFault extends Error {
  constructor(
    message: string,
    /** Node-style error code, so code that classifies by `code` (ENOENT, EIO...) sees a realistic one. */
    readonly code: string = "EIO",
  ) {
    super(message);
    this.name = "InjectedFault";
  }
}

export type FaultAction =
  | { readonly kind: "fail"; readonly code?: string }
  | { readonly kind: "lose-answer"; readonly code?: string }
  | { readonly kind: "stall"; readonly gate: Gate }
  | { readonly kind: "duplicate" }
  | { readonly kind: "partial"; readonly bytes: number; readonly code?: string }
  | { readonly kind: "short"; readonly bytes: number };

export interface FaultRule {
  /** The operation name (a `StoreFs` method, a handle method -- `write`, `sync`, `truncate`, `stat`, `close` -- or a
   *  port method for `faultyPort`). */
  readonly op: string;
  /** Narrows the matching calls (for the file seam: the path). Every call is matched when absent. */
  readonly where?: (detail: string) => boolean;
  /** The 1-based matching call this rule fires on (default 1: the first). Counted per rule, from when it was added. */
  readonly nth?: number;
  readonly action: FaultAction;
  /** A label for the unfired report. */
  readonly label?: string;
}

interface LiveRule {
  readonly rule: FaultRule;
  seen: number;
  fired: boolean;
}

export interface ObservedCall {
  readonly op: string;
  readonly detail: string;
  readonly fault: FaultAction["kind"] | null;
}

export class FaultScript {
  private readonly rules: LiveRule[] = [];
  /** Every call the injectors saw, in order, and which fault (if any) it got. */
  readonly calls: ObservedCall[] = [];

  constructor(rules: readonly FaultRule[] = []) {
    for (const rule of rules) this.add(rule);
  }

  add(rule: FaultRule): this {
    if (rule.nth !== undefined && !(Number.isSafeInteger(rule.nth) && rule.nth >= 1)) throw new Error(`fault rule nth must be a positive integer (${rule.nth})`);
    this.rules.push({ rule, seen: 0, fired: false });
    return this;
  }

  /** The fault for this call, consumed; `null` when no rule fires on it. Every matching rule counts the call. */
  take(op: string, detail: string): FaultAction | null {
    let chosen: FaultAction | null = null;
    for (const live of this.rules) {
      if (live.fired || live.rule.op !== op || (live.rule.where !== undefined && !live.rule.where(detail))) continue;
      live.seen += 1;
      if (chosen === null && live.seen === (live.rule.nth ?? 1)) {
        live.fired = true;
        chosen = live.rule.action;
      }
    }
    this.calls.push({ op, detail, fault: chosen?.kind ?? null });
    return chosen;
  }

  /** The scripted faults that never fired, by label (a case that scripts a fault it never triggers proves nothing). */
  unfired(): string[] {
    return this.rules.filter((live) => !live.fired).map((live) => live.rule.label ?? `${live.rule.op}#${live.rule.nth ?? 1}:${live.rule.action.kind}`);
  }

  count(op: string): number {
    return this.calls.filter((call) => call.op === op).length;
  }
}

/* ------------------------------------------------------------------ */
/* The file seam (`StoreFs`): every file store the server has goes through it                                    */
/* ------------------------------------------------------------------ */

const injected = (op: string, detail: string, code = "EIO") => new InjectedFault(`injected ${op} failure on ${detail}`, code);

/** `inner` with the script's faults applied. Paths are the `detail` rules match on. */
export function faultyStoreFs(inner: StoreFs, script: FaultScript): StoreFs {
  async function around<T>(op: string, detail: string, run: () => Promise<T>): Promise<T> {
    const action = script.take(op, detail);
    if (action === null) return run();
    switch (action.kind) {
      case "fail":
        throw injected(op, detail, action.code);
      case "lose-answer":
        await run();
        throw injected(op, detail, action.code);
      case "stall":
        arrive(action.gate);
        await action.gate.opened;
        return run();
      case "duplicate":
        await run().catch(() => undefined);
        return run();
      default:
        throw new Error(`fault ${action.kind} does not apply to ${op}`);
    }
  }

  const wrapHandle = (file: string, handle: StoreFileHandle): StoreFileHandle => ({
    async write(buffer, offset, length, position) {
      const action = script.take("write", file);
      if (action === null) return handle.write(buffer, offset, length, position);
      switch (action.kind) {
        case "fail":
          throw injected("write", file, action.code);
        case "partial": {
          const part = Math.min(action.bytes, length);
          if (part > 0) await handle.write(buffer, offset, part, position);
          throw injected("write", file, action.code);
        }
        case "short":
          return handle.write(buffer, offset, Math.max(1, Math.min(action.bytes, length)), position);
        case "lose-answer":
          await handle.write(buffer, offset, length, position);
          throw injected("write", file, action.code);
        case "stall":
          arrive(action.gate);
          await action.gate.opened;
          return handle.write(buffer, offset, length, position);
        default:
          throw new Error(`fault ${action.kind} does not apply to write`);
      }
    },
    stat: () => around("stat", file, () => handle.stat()),
    truncate: (length) => around("truncate", file, () => handle.truncate(length)),
    sync: () => around("sync", file, () => handle.sync()),
    close: () => around("close", file, () => handle.close()),
  });

  return {
    open: async (file, flags) => wrapHandle(file, await around("open", file, () => inner.open(file, flags))),
    readFile: (file) => around("readFile", file, () => inner.readFile(file)),
    rename: (from, to) => around("rename", to, () => inner.rename(from, to)),
    unlink: (file) => around("unlink", file, () => inner.unlink(file)),
    mkdir: (directory) => around("mkdir", directory, () => inner.mkdir(directory)),
    readdir: (directory) => around("readdir", directory, () => inner.readdir(directory)),
    appendFile: (file, text) => around("appendFile", file, () => inner.appendFile(file, text)),
  };
}

/* ------------------------------------------------------------------ */
/* Any store port: the caller's view of a transport                     */
/* ------------------------------------------------------------------ */

/** `port` with the script applied to its async methods (op = the method name, detail = the first argument when it
 *  is a string, else the method name). `partial` and `short` do not apply here. */
export function faultyPort<T extends object>(port: T, script: FaultScript): T {
  return new Proxy(port, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== "function" || typeof property !== "string") return value;
      return (...args: unknown[]) => {
        const detail = typeof args[0] === "string" ? args[0] : property;
        const action = script.take(property, detail);
        const call = () => (value as (...a: unknown[]) => unknown).apply(target, args);
        if (action === null) return call();
        switch (action.kind) {
          case "fail":
            return Promise.reject(injected(property, detail, action.code));
          case "lose-answer":
            return Promise.resolve(call()).then(() => {
              throw injected(property, detail, action.code);
            });
          case "stall":
            arrive(action.gate);
            return action.gate.opened.then(call);
          case "duplicate":
            return Promise.resolve(call())
              .catch(() => undefined)
              .then(call);
          default:
            return Promise.reject(new Error(`fault ${action.kind} does not apply to a port method`));
        }
      };
    },
  });
}

/* ------------------------------------------------------------------ */
/* Fencing: newest writer wins                                          */
/* ------------------------------------------------------------------ */

/**
 * The writer epoch of whatever owns the data (today: the data directory's lock; LIVE-5: a pool epoch on the `HEAD`
 * item). A writer is issued at the current epoch; `takeOver` starts a newer one, and from then on every writer issued
 * before it is STALE. For the file stores a writer is their `writerCheck` (a check made before the write -- F-L5-4's
 * time-of-check/time-of-use gap, which the conformance matrix records as a capability those stores lack); a DynamoDB
 * subject carries its epoch into the condition of every write instead, and moves a durable fence item on `takeOver`.
 */
export class ControlledFence {
  private current = 1;
  /** `takeOver` hooks: a DynamoDB subject moves its durable fence item here. */
  private readonly hooks: Array<(epoch: number) => Promise<void>> = [];

  get epoch(): number {
    return this.current;
  }

  /** A `writerCheck` bound to the epoch at this moment. */
  writer(): () => Promise<boolean> {
    const mine = this.current;
    return async () => mine === this.current;
  }

  onTakeOver(hook: (epoch: number) => Promise<void>): void {
    this.hooks.push(hook);
  }

  /** A newer writer takes over: every writer issued before this call is stale from now on. */
  async takeOver(): Promise<number> {
    this.current += 1;
    for (const hook of this.hooks) await hook(this.current);
    return this.current;
  }
}
