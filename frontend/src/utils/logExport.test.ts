/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 1160 (harness): A REPORTING TOOL HAS TO BE TRUSTWORTHY
// ==================================================================
//
// This exists because a reported Undo fault could not be reproduced from the code. Five mechanisms were ruled
// out by RUNNING the reducer -- the accumulator survives every arm and a fresh replay, the revenue die spans
// 80-120% and cannot move a figure by a third, `appendSandboxAction` is a transaction on a shared counter,
// #934 removed the shell's revenue cache, and the reporter established one train and no route worth the
// figure shown. `perShare` is `floor(revenue / 10)`, so the panel had read $10-$19: a number that never
// existed on that turn.
//
// SO THE NEXT STEP IS THE LOG ITSELF, and the thing carrying it has to be exactly right -- an export that
// reordered, dropped or silently mangled an entry would send the investigation somewhere the game never went,
// which is worse than having no tool. These cases are about fidelity, and nothing else.

export {};

const { buildSandboxLogExport, duplicateIndicesIn } =
  require("./logExport") as typeof import("./logExport");
const { readStripped, sliceBetween } = require("./sourceScan") as typeof import("./sourceScan");

const entry = (index: number, id: string, msg: unknown, over: Record<string, unknown> = {}) =>
  ({ index, id, actor: "p1", derived: false, payload: JSON.stringify(msg), ...over }) as never;

describe("the export is the log, in the order the app replays it", () => {
  it("sorts by index and then by id, which is the app's own order", () => {
    /* `sortActions`' tie-break is the document id, and #1026 records why it matters: two entries that raced
       onto one index are ordered by it. An export in a different sequence would describe a different game. */
    const out = buildSandboxLogExport(
      [entry(2, "b", { PassTurn: {} }), entry(1, "z", { LayTile: {} }), entry(1, "a", { BuyStock: {} })],
      "ROOM",
    );
    expect(out.actions.map((a) => `${a.index}${a.id}`)).toEqual(["1a", "1z", "2b"]);
  });

  it("parses each payload but never loses one it cannot", () => {
    /* An entry this app cannot parse is exactly the kind worth seeing, so it survives as its raw string
       rather than being dropped or turned into `null`. */
    const out = buildSandboxLogExport([entry(0, "a", null, { payload: "{not json" })], null);
    expect(out.actions[0].msg).toBe("{not json");
    expect(out.actionCount).toBe(1);
  });

  it("keeps the fields an investigation needs and invents none", () => {
    const out = buildSandboxLogExport(
      [entry(4, "id4", { DeclareDividends: { protocol_id: 1, distribute: true } }, { derived: true, at: 9 })],
      "ROOM",
    );
    expect(out.actions[0]).toEqual({
      index: 4,
      id: "id4",
      actor: "p1",
      derived: true,
      at: 9,
      msg: { DeclareDividends: { protocol_id: 1, distribute: true } },
    });
    expect(out.roomCode).toBe("ROOM");
  });

  it("omits a missing timestamp rather than stamping one", () => {
    /* A `at: undefined` in the JSON would read as "this entry has no time"; inventing `Date.now()` would read
       as a time it was written at. Absent is the only honest third option. */
    const out = buildSandboxLogExport([entry(0, "a", { PassTurn: {} })], null);
    expect("at" in out.actions[0]).toBe(false);
  });
});

describe("duplicate indices, the one fault the export can see by itself", () => {
  it("finds entries that share an index", () => {
    /* THE LIVE SUSPECT. `effectiveActions` kills a revert's range by INDEX (`other.index >= target`) while
       #1026 made only the revert's own identity an id -- so two entries on one index are still undone
       together, which is #1026's own reported symptom ("rolled back to a much earlier state"). */
    expect(duplicateIndicesIn([entry(0, "a", {}), entry(1, "b", {}), entry(1, "c", {})])).toEqual([1]);
  });

  it("says nothing about a healthy log", () => {
    /* The point of naming them is that an empty list rules the whole family out at a glance. A false positive
       would send the investigation after a fault that is not there. */
    expect(duplicateIndicesIn([entry(0, "a", {}), entry(1, "b", {}), entry(2, "c", {})])).toEqual([]);
    expect(buildSandboxLogExport([entry(0, "a", {})], null).duplicateIndices).toEqual([]);
  });

  it("reports every offending index, ascending", () => {
    const dupes = duplicateIndicesIn([
      entry(5, "a", {}), entry(5, "b", {}), entry(2, "c", {}), entry(2, "d", {}), entry(9, "e", {}),
    ]);
    expect(dupes).toEqual([2, 5]);
  });
});

describe("the trigger is the host's, and it cannot fail silently", () => {
  const APP = readStripped("App.tsx");

  it("is gated the way the other debug tool is", () => {
    /* Host and sandbox both, for the Yellow Sign's own reasons: a chain game has no room document, and the
       host gate is the ruling. */
    const tool = sliceBetween(APP, "const copySandboxLog = useCallback(() => {", "}, [isSandboxHost, logInfo]);");
    expect(tool).toContain("if (!isSandboxHost) return;");
  });

  it("says what happened either way", () => {
    /* `navigator.clipboard` is absent on an insecure origin and rejects without a gesture in some browsers. A
       debug tool that fails silently is worse than none, so both paths reach the Activity Log. */
    const tool = sliceBetween(APP, "const copySandboxLog = useCallback(() => {", "}, [isSandboxHost, logInfo]);");
    expect(tool).toContain("copied to the clipboard");
    expect(tool).toContain("printed to the browser console");
    expect(tool).toContain("catch");
  });

  it("stays out of the Yellow Sign's handler", () => {
    /* Merging them would have put this several hundred lines above `logInfo`, which is what the first draft
       did and `tsc` refused. They share a modifier key and nothing else. */
    const sign = sliceBetween(APP, 'if (event.key.toLowerCase() !== "y") return;', "}, [isSandboxHost, cycleForcedSign]);");
    expect(sign).not.toContain("copySandboxLog");
    expect(APP).toContain('if (event.key.toLowerCase() !== "l") return;');
  });
});
