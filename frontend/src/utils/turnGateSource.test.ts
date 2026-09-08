/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 1231 (harness): THE GATE AND THE DISPATCH READ THE SAME BOARD
// ==================================================================
//
// REPORTED: "it said it was Host's turn, but when Host clicked to buy a share, it printed 'it's not your
// turn.' The other player cannot do anything, so the game is locked." Replaying that log through the
// corrected engine said Host WAS on turn and the move WAS legal. The client's own gate refused it anyway.
//
// THE GATE READ `isMyTurnRef`, a boolean mirrored by an effect from React's committed state. THE DISPATCH READ
// `sandboxStateRef`, written synchronously. Two boards, one step apart, and the gate asked its question of
// the older one. An undo is where the step opens widest: the drain rebuilds the refs and replays, and every
// replayed action writes the ref at once and the state in a batch.
//
// SO THE GATE NOW COMPUTES FROM THE REFS, WITH THE SAME FUNCTION THE MEMO USES. These cases pin the wiring,
// because the rule (`actingAddress`) is already pinned elsewhere and was never the fault.

export {};

const { readStripped, sliceBetween } = require("./sourceScan") as typeof import("./sourceScan");

const APP = readStripped("App.tsx");
const gate = sliceBetween(
  APP,
  "const boardNow = sandboxStateRef.current;",
  'setSandboxRoomError("It is not your turn.");',
);

describe("the client's turn gate, #1231", () => {
  it("judges the synchronous board, not the mirrored boolean", () => {
    /* `actingAddress(boardNow, sandboxWaterfallRef.current)` -- the refs the dispatch itself acts on. */
    expect(gate).toContain("actingAddress(boardNow, sandboxWaterfallRef.current)");
    expect(gate).toContain("=== viewerAddressRef.current");
    expect(gate).toContain("!onTurnNow");
  });

  it("does not refuse on the mirrored boolean when a board exists", () => {
    /* `isMyTurnRef.current` may appear ONLY as the fallback for a null board and in #1229's diagnostic line.
       If it reappears as the condition itself, the lag is back. */
    const condition = sliceBetween(gate, "if (", ") {");
    expect(condition).not.toContain("isMyTurnRef");
  });

  it("keeps the three exemptions the gate always had", () => {
    /* #536 / #701: a replayed entry, an automatic dispatch and an owed consent answer are never gated. The
       fix is to the board the gate reads, not to which actions it reads it for. */
    const condition = sliceBetween(gate, "if (", ") {");
    expect(condition).toContain("options?.isRemoteReplay !== true");
    expect(condition).toContain("options?.automatic !== true");
    expect(condition).toContain("options?.offTurn !== true");
  });

  it("still prints #1229's evidence on a refusal", () => {
    expect(gate).toContain("[turn-gate] refused locally");
  });
});
