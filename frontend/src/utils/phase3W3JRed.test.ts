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
