// server/src/persistence/conformance/fileHooks.ts
//
// LIVE-5 L5-1: shared subject plumbing for the conformance test files (no test registers here).

import { gate, type FaultScript } from "./faults";
import type { CaseContext } from "./harness";

/** A memory store has nothing to reopen: one instance per case, returned by every `open`. */
export function perCase<T>(make: () => T): (ctx: object) => T {
  const instances = new WeakMap<object, T>();
  return (ctx) => {
    let instance = instances.get(ctx);
    if (instance === undefined) {
      instance = make();
      instances.set(ctx, instance);
    }
    return instance;
  };
}

/** The hooks every whole-file store shares (`persistence/durableReplace.ts`): the temporary is opened after the store's
 *  own `writerCheck` (so a stall there sits exactly in F-L5-4's gap), and the rename is the commit point. */
export function replaceHooks(script: (ctx: CaseContext) => FaultScript, target: (ctx: CaseContext, key: string) => string) {
  const temporary = (ctx: CaseContext, key: string) => (at: string) => at.startsWith(`${target(ctx, key)}.`) && at.endsWith(".tmp");
  return {
    stallNextWrite(ctx: CaseContext, key: string) {
      const stall = gate();
      script(ctx).add({ op: "open", where: temporary(ctx, key), action: { kind: "stall", gate: stall }, label: "the write stalls at its temporary" });
      return stall;
    },
    armLostAnswer(ctx: CaseContext, key: string) {
      script(ctx).add({ op: "rename", where: (at) => at === target(ctx, key), action: { kind: "lose-answer" }, label: "the rename lands, its answer is lost" });
    },
    armTransientFailure(ctx: CaseContext, key: string) {
      script(ctx).add({ op: "open", where: temporary(ctx, key), action: { kind: "fail" }, label: "the temporary cannot be opened" });
    },
    armUnresolvedWrite(ctx: CaseContext, key: string) {
      script(ctx).add({ op: "rename", where: (at) => at === target(ctx, key), action: { kind: "fail" }, label: "the rename fails" });
      script(ctx).add({ op: "rename", where: (at) => at === target(ctx, key), nth: 2, action: { kind: "fail" }, label: "the redo's rename fails too" });
    },
  };
}
