/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 1026 (harness): THE LOG STOPS LOSING ACTIONS
// ==================================================================
//
// REPORTED: "restarting the server caused the active game room to roll back to a much earlier state. The
// server is holding too much state in-memory without persisting it."
//
// THE DIAGNOSIS THAT SURVIVED THE AUDIT is not the one in the report, and it is worth stating here because
// this file exists to prove the replacement. There is no server holding game state: no Node, no WebSocket, no
// Redux -- the Firestore log IS the persistence, every action was already written as its own document at
// dispatch time, and `subscribeSandboxLog` already returned the WHOLE log rather than a delta. A restart
// loses nothing that was written.
//
// WHAT A RESTART DOES IS FORCE A REPLAY, and a replay is where a log that has been quietly damaged stops
// agreeing with the client that was holding the game in memory. The damage was duplicate indices:
// `appendSandboxAction` took the index from its CALLER and wrote it unchecked, and `effectiveActions` keyed
// its dead-set on that index -- so one undo aimed at a shared number destroyed both entries sitting on it,
// permanently, from the next replay onward.
//
// SO THE CASES BELOW ARE ABOUT UNIQUENESS AND IDENTITY, not about saving. The first describe is the data-loss
// bug reproduced against the real `effectiveActions`; the second is the allocator that stops it arising.

export {};

const { effectiveActions } = require("./logRevert") as typeof import("./logRevert");
const { readStripped, readSource } = require("./sourceScan") as typeof import("./sourceScan");

type Entry = { index: number; id: string; actor: string; payload: string };

const act = (index: number, id: string): Entry => ({
  index,
  id,
  actor: "p1",
  payload: JSON.stringify({ BuyStock: { game_id: 1 } }),
});

const revert = (index: number, id: string, to: number): Entry => ({
  index,
  id,
  actor: "p1",
  payload: JSON.stringify({ RevertTo: { index: to, player: "p1", summary: "x" } }),
});

describe("a collision no longer destroys the entry nobody undid", () => {
  it("keeps a colliding entry that the revert's range does not cover", () => {
    /* THE REPORTED DATA LOSS, as a log. Two actions raced onto index 2 -- which is what a caller-supplied
       index permits and what `SandboxAction`'s own field comment has always described ("the deterministic
       tie-break for two entries that raced onto the same index"). The revert reaches back to 3, so neither
       entry at 2 is in its range; the old dead-set marked the NUMBER 2 and dropped both. */
    const log = [
      act(0, "a0"),
      act(1, "a1"),
      act(2, "a2-first"),
      act(2, "a2-second"),
      act(3, "a3"),
      revert(4, "r4", 3),
    ];
    const live = effectiveActions(log).map((entry) => entry.id);
    expect(live).toContain("a2-first");
    expect(live).toContain("a2-second");
  });

  it("still kills exactly what the revert reaches", () => {
    /* THE RULE THAT MUST SURVIVE. A fix that stopped killing anything would pass the case above and break
       undo -- so the range is asserted from both ends in the same log. */
    const log = [act(0, "a0"), act(1, "a1"), act(2, "a2"), revert(3, "r3", 1)];
    const live = effectiveActions(log).map((entry) => entry.id);
    expect(live).toEqual(["a0"]);
  });

  it("still lets a later revert take back an earlier one", () => {
    /* #591a's REDO, unchanged: reading backward, the last revert is authoritative and a killed revert takes
       nothing back. Keyed by id now, so this is worth re-asserting rather than assuming. */
    const log = [
      act(0, "a0"),
      act(1, "a1"),
      revert(2, "r2", 1),
      revert(3, "r3", 2),
    ];
    const live = effectiveActions(log).map((entry) => entry.id);
    expect(live).toEqual(["a0", "a1"]);
  });

  it("keys the dead-set on identity, not on position", () => {
    /* THE MECHANISM, pinned. A `Set<number>` here is the bug; the type is the fix. */
    const source = readStripped("utils/logRevert.ts");
    expect(source).toContain("const dead = new Set<string>();");
    expect(source).toContain("dead.add(action.id);");
    expect(source).toContain("dead.add(other.id);");
  });

  it("requires an id rather than defaulting one", () => {
    /* AN OPTIONAL `id` WITH A FALLBACK TO `index` would reproduce the bug for every caller that forgot it,
       silently. Required turns each such caller into a type error -- which is what found the three fixtures
       this batch had to update. */
    expect(readStripped("utils/logRevert.ts")).toContain("id: string;");
    expect(readStripped("utils/logRevert.ts")).not.toContain("id?: string");
  });
});

describe("the index is allocated, not supplied", () => {
  const ROOM = readSource("utils/sandboxRoom.ts");

  it("writes the entry inside a transaction", () => {
    /* THE ONE GUARANTEE A TRANSACTION BUYS HERE: two clients appending at once both read the room's counter,
       so the second is aborted and retried against the value the first wrote. The old note argued a re-read
       was pointless because ORDERING is unobtainable -- true, and never the question. Uniqueness is. */
    expect(ROOM).toContain("return runTransaction(db, async (tx) => {");
    expect(ROOM).toContain("const room = await tx.get(roomRef);");
  });

  it("advances the counter in the same write", () => {
    /* THE COUNTER AND THE ENTRY, ATOMICALLY. A counter bumped outside the transaction could be incremented by
       a write that then failed, which loses an index -- harmless -- or incremented after the entry, which
       hands the same number out twice and is the bug returning. */
    expect(ROOM).toContain("tx.set(roomRef, { [SANDBOX_NEXT_INDEX_FIELD]: allocated + 1 }, { merge: true });");
    expect(ROOM).toContain("tx.set(doc(actionsRef), {");
  });

  it("mints the document id locally", () => {
    /* `addDoc` CANNOT RUN INSIDE A TRANSACTION -- a transaction needs its writes named up front -- so the ref
       is created first and set. Asserted because reaching for `addDoc` here is the obvious edit and it would
       silently move the write back outside the atomic step. */
    expect(ROOM).toContain("tx.set(doc(actionsRef), {");
  });

  it("uses the caller's figure only as a floor", () => {
    /* A ROOM CREATED BEFORE THIS FIELD EXISTED HAS NO COUNTER, and seeding from zero would hand out indices
       the log already contains. The client's view of the log length is the only evidence available there. */
    expect(ROOM).toContain(
      "const allocated = Number.isFinite(counter) ? Math.max(counter, nextIndex) : nextIndex;",
    );
  });

  it("returns the index it used", () => {
    /* THE CALLER'S GUESS MAY NOT BE WHAT IT GOT. A caller advancing its cursor by its own guess would desync
       on the first collision this change prevents, which would be a poor way to pay for the fix. */
    expect(ROOM).toContain("): Promise<number | null> {");
  });
});

describe("the shell reads that return correctly", () => {
  const APP = readStripped("App.tsx");

  it("treats null as the failure, not falsiness", () => {
    /* THE FAULT THE FIX NEARLY INTRODUCED. `if (!ok)` was correct against a boolean and is wrong against an
       index: `0` is a real allocation -- the `SetupGame` event that deals the game -- so a truthiness test
       would report the first action of every room as a failed write. Both call sites, because one of them is
       precisely the index-0 case. */
    expect(APP).toContain("if (allocated === null) {");
    expect(APP.split("if (allocated === null) {").length - 1).toBe(2);
  });

  it("no longer coerces the result to a boolean on the error path", () => {
    expect(APP).not.toContain(").catch(() => false);");
  });
});
