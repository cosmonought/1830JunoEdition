// frontend/src/utils/phase3W3JRed.test.ts
//
// ==================================================================
//  PHASE 3 W3-J: THE OD-12 RED-REGION EDITS, ONE BLOCK PER COMMIT
// ==================================================================
//
// `runGameplayAction`'s submit half (RED R1) and the link drain (RED R5) cannot be executed outside the shell, so each
// edit is pinned at its line here AND its behaviour is exercised through the real model it feeds (the notice reducer,
// the submission-answer helper, the real room link). Each `describe` is one separately reviewed RED commit.

import { readShell, sliceBetween } from "./sourceScan";
import { NO_ROOM_NOTICES, TURN_REFUSAL, roomNoticesReducer, type RoomNoticeAction, type RoomNotices } from "./roomNotices";

const shell = readShell();
const run = (...actions: RoomNoticeAction[]): RoomNotices => actions.reduce(roomNoticesReducer, NO_ROOM_NOTICES);

/** The shell's landed branch, between the null answer and the cursor advance. */
const landedBranch = () => sliceBetween(shell, "if (allocated === null) {", "if (allocated !== null && appliedIndexRef.current === appendAt) {");

describe("RED R1 (AUD-25.03): a landed PLAYER decision retires the refusal, automatic-flagged or not", () => {
  it("the landed branch gates `submission-landed` on `derived`, not on `automatic`", () => {
    const landed = landedBranch();
    expect(landed).toContain("if (options?.derived !== true) {");
    expect(landed).not.toContain("if (options?.automatic !== true) {");
    expect(landed).toContain('dispatchRoomNotice({ type: "submission-landed" });');
  });

  it.each([
    ["the B&O par", "SetBoPar"],
    ["the home station", "PlaceHomeStation"],
    ["the M&H exchange", "ExchangePrivate"],
    ["Undo", "RevertTo"],
  ])("%s is a player decision sent `automatic: true` -- and its landing retires a standing refusal", (_label, message) => {
    // The dispatch sites (outside RED) still send these `automatic` (the turn gate must not judge them) and never `derived`.
    const at = shell.indexOf(`${message}: {`);
    expect(at).toBeGreaterThan(-1);
    const site = shell.slice(at, shell.indexOf(");", at) + 2);
    expect(site).toContain("{ automatic: true }");
    expect(site).not.toContain("derived: true");
    // The R1 rule for that dispatch: not derived -> `submission-landed`, which retires the refusal (P3-N004).
    const landedDispatches: RoomNoticeAction[] = [{ type: "submission-landed" }];
    expect(run({ type: "refusal", text: TURN_REFUSAL }, ...landedDispatches).refusal).toBeNull();
  });
});

/** The #1407 catching-up guard: the first `if (` after its note, up to its body. */
const catchingUpGuard = () => {
  const from = shell.indexOf("setSandboxRoomError(CATCHING_UP_BANNER);");
  const start = shell.lastIndexOf("if (", from);
  return shell.slice(start, from);
};

describe("RED R1 (AUD-25.13, W2-D deferred): an `automatic` player decision no longer bypasses the catching-up guard", () => {
  it("the guard exempts only the replay and the derived actions -- not `automatic`", () => {
    const guard = catchingUpGuard();
    expect(guard).toContain("options?.isRemoteReplay !== true");
    expect(guard).toContain("options?.derived !== true");
    expect(guard).toContain("replayingRef.current");
    expect(guard).not.toContain("options?.automatic");
  });

  it("the same distinction as the landed branch (AUD-25.03): one rule, not two mechanisms", () => {
    expect(landedBranch()).toContain("if (options?.derived !== true) {");
    expect(catchingUpGuard()).toContain("options?.derived !== true");
  });

  it("the turn gate keeps its own exemptions: an automatic decision is still not judged by whose turn it is (#536)", () => {
    const turnGate = sliceBetween(shell, "const onTurnNow =", "setSandboxRoomError(TURN_REFUSAL);");
    expect(turnGate).toContain("options?.automatic !== true");
    expect(turnGate).toContain("options?.offTurn !== true");
  });
});
