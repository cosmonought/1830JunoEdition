/** @jest-environment node */
//
// Design note #1242 (harness): the room transport lives as long as the room, not as long as one callback.
//
// The subscription effect in `App.tsx` used to list `runGameplayAction` as a dependency. That callback is a
// `useCallback` over `gameState`, so the effect tore the socket down and rebuilt it after every action -- and
// in the commit after an opponent's move there was one effect-body's worth of time in which no link existed
// and a dispatch fell through to Firestore. These are source scans, because the fault is a dependency list.

export {};

const APP = (() => {
  const fs = require("fs") as typeof import("fs");
  const path = require("path") as typeof import("path");
  return fs.readFileSync(path.join(__dirname, "..", "App.tsx"), "utf8");
})();

describe("#1242: the transport effect does not depend on the dispatcher's identity", () => {
  it("lists only the room facts", () => {
    // #1339: `noteCashChanges` left with the cash badge; the room facts are all that remain.
    expect(APP).toContain("}, [sandbox, sandboxRoomCode]);");
    expect(APP).not.toContain("[sandbox, sandboxRoomCode, runGameplayAction");
  });

  it("the drain dispatches through the ref, so it needs no closure over the callback", () => {
    expect(APP).toContain('await runGameplayActionRef.current?.("Sandbox room", msg, {');
    expect(APP).not.toContain('await runGameplayAction("Sandbox room", msg, {');
  });

  it("a server-path build with no link refuses rather than writing to Firestore", () => {
    const start = APP.indexOf("if (!link && GAME_SERVER_URL) {");
    expect(start).toBeGreaterThan(-1);
    const branch = APP.slice(start, start + 700);
    expect(branch).toContain("setPendingAppendIndex((current) => (current === appendAt ? null : current));");
    expect(branch).toContain("return;");
    // The refusal comes BEFORE the transport choice, so the Firestore branch is not reachable from it.
    expect(start).toBeLessThan(APP.indexOf("const allocated = link"));
  });
});
