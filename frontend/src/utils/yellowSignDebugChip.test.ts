/** @jest-environment node */
//
// ==================================================================
//  UR-7 (Variant Certification 1B): UR-N62 -- THE HOST'S YELLOW SIGN DEBUG CHIP, RE-ASSERTED ON A HOSTED TABLE
// ==================================================================
//
// #1128 gave a sandbox HOST a playtest force: the "SIGN" chip beside the sandbox badge and Ctrl+Shift+Y, cycling an armed
// stage on the room document that the acting client's narration turns into `debug_force` on the legacy request. S9-1
// (#1661 / #1662) made it a waiver, not a choice, and a LOCAL tool: a pinned (server-dealt) table drops the field at
// ingress and refuses it in the reducer. UR-6 recorded that the chip still RENDERED for any sandbox host, pinned tables
// included -- inert there, and its tooltips named the Sign's phase windows and whom it visits next (OD-UR-8 keeps the
// trigger conditions and odds hidden, D-42) and described the fog as a run stage (OD-UR-2 retired that).
//
// UR-7's DISPOSITION (no new debug architecture): it is intentionally developer / playtest tooling (#1128); it cannot
// change canonical state on a pinned table (pinned below, hosted); its wording disclosed hidden trigger windows to a
// host who is also a player; so it is shown -- and its shortcut honoured -- only where its force can act:
// `forcedSignToolInForce`, an UNPINNED Unpredictable Revenue board (S10-11's legacy residual, where the waiver is still
// the tool #1128 asked for). The pinned table, the supported authority, carries no chip.

import type { GameStateResponse } from "../gameEngine/gameState";

export {};

const S = require("./yellowSignRunBoundSupport") as typeof import("./yellowSignRunBoundSupport");
const YS = require("../gameEngine/yellowSign") as typeof import("../gameEngine/yellowSign");
const { applySandboxAction } = require("../gameEngine/sandboxSession") as typeof import("../gameEngine/sandboxSession");
const { normalizeForCommit } = require("./serverIngress") as typeof import("./serverIngress");
const { stateDigest } = require("../gameEngine/stateDigest") as typeof import("../gameEngine/stateDigest");
const { anchorIndex, readStripped } = require("./sourceScan") as typeof import("./sourceScan");

const { CO, BO, P1, P2, GULF, TWO_ROUTE, THREE_ROUTE, urBoard, runMsg, companyOf, partsFor } = S;

const CTX = { mapGrid: GULF, era: "Yellow" } as const;
const apply = (state: GameStateResponse, msg: unknown) => applySandboxAction(state, msg as never, CTX);
const board = (over: Partial<Parameters<typeof urBoard>[0]> = {}) =>
  urBoard({
    corps: [
      { id: CO, president: P1, trains: ["2", "3"], treasury: 300 },
      { id: BO, president: P2, trains: ["3"], treasury: 300 },
    ],
    ...over,
  });
const RUN = (seed?: number) => runMsg(CO, [TWO_ROUTE, THREE_ROUTE], [0, 1], ["2", "3"], seed);
const QUIET_110 = S.seedWhere((seed) => S.isQuietDraw(110, partsFor(seed)));
const forced = { YellowSignEvent: { game_id: 1, protocol_id: CO, debug_force: true } };

describe("forcedSignToolInForce: the chip exists only where its force can act", () => {
  it("pinned Unpredictable Revenue table: no chip (the supported authority)", () => {
    expect(YS.forcedSignToolInForce(board())).toBe(false);
  });
  it("pinned standard table: no chip", () => {
    expect(YS.forcedSignToolInForce(board({ ur: false }))).toBe(false);
  });
  it("unpinned Unpredictable Revenue board (a Firestore sandbox room, S10-11's residual): the chip #1128 asked for", () => {
    expect(YS.forcedSignToolInForce(board({ pinned: false }))).toBe(true);
  });
  it("unpinned standard board: no Yellow Sign, so nothing to force", () => {
    expect(YS.forcedSignToolInForce(board({ pinned: false, ur: false }))).toBe(false);
  });
  it("no board dealt yet: no chip", () => {
    expect(YS.forcedSignToolInForce(null)).toBe(false);
    expect(YS.forcedSignToolInForce(undefined)).toBe(false);
  });
  it("it is the authority's own pin predicate, not a second one: true exactly where the reducer honours the request path", () => {
    for (const state of [board(), board({ ur: false }), board({ pinned: false }), board({ pinned: false, ur: false })]) {
      const inForce = YS.forcedSignToolInForce(state);
      const requestPath = YS.yellowSignRequestRefusal(state) === null;
      expect(inForce).toBe(requestPath && state.variants?.unpredictableRevenue === true);
    }
  });
});

describe("on a hosted PINNED table the force cannot change canonical state (no bypass of OD-UR-1)", () => {
  it("the waiver is dropped at ingress and the request refused before anything is appended; the board is untouched", () => {
    const room = S.hostedRoom(board(), GULF, [QUIET_110]);
    expect(S.submitTo(room, P1, RUN()).kind).toBe("applied");
    const settled = stateDigest(room.state);
    const entries = room.entries.length;
    const answer = S.submitTo(room, P1, forced as never);
    expect(answer.kind).toBe("refused");
    expect(answer.reason).toBe(YS.yellowSignRequestRefusal(room.state));
    expect(room.entries).toHaveLength(entries);
    expect(stateDigest(room.state)).toBe(settled);
    expect(companyOf(room.state, CO).has_yellow_sign).toBeUndefined();
    expect(companyOf(room.state, CO).owned_trains).toEqual(["2", "3"]);
    // And even the normalizer's copy of it carries no waiver.
    expect(normalizeForCommit(forced, { board: room.state, rawLog: room.entries as never })).toEqual({
      YellowSignEvent: { game_id: 1, protocol_id: CO },
    });
  });

  it("the reducer refuses it too, on the board a run left -- the rule every replaying client holds", () => {
    const after = apply(board(), RUN(QUIET_110));
    expect(stateDigest(apply(after, forced))).toBe(stateDigest(after));
  });

  it("the unpinned board keeps the legacy playtest force (UR-N28) -- the only place the chip now renders", () => {
    const local = board({ pinned: false });
    const after = apply(local, RUN(QUIET_110));
    const out = companyOf(apply(after, forced), CO);
    expect(out.has_yellow_sign).toBe(true); // the waiver acted: a Mark, derived by the board, not named by the chip
  });
});

/* LIVE-2D (LIVE-2 §9.4, §13.1): THE CHIP, ITS SHORTCUT AND ITS NARRATION HOOK ARE DELETED. The armed stage lived on the
   legacy room DOCUMENT, which is gone; every table is server-dealt and pinned, where the waiver was always dropped at
   ingress and refused by the reducer (pinned above). The engine keeps the unpinned legacy force for replays (UR-N28,
   above); the shell can no longer arm, show or send one. */
describe("the shell: the forced-sign chip is gone with the room document (LIVE-2D)", () => {
  const APP = readStripped("App.tsx");

  it("renders no chip and binds no shortcut", () => {
    for (const gone of ['"SIGN: OFF"', "cycleForcedSign", "forcedSignToolInForce(", "setSandboxForcedSign", 'event.key.toLowerCase() !== "y"', "forcedSignChipArmed", "nextForcedSign("]) {
      expect([gone, APP.includes(gone)]).toEqual([gone, false]);
    }
  });

  it("carries none of the tooltips that named the Sign's hidden windows (OD-UR-8, D-42)", () => {
    for (const phrase of ["phases 2-4", "phases 5-D", "MARKED corporation's next run", "Carcosan corporation's next run"]) {
      expect([phrase, APP.includes(phrase)]).toEqual([phrase, false]);
    }
  });

  it("the narration forces nothing and sends no waiver", () => {
    expect(APP).toContain("const signForced = null;");
    expect(APP).toContain("const signForce = {};");
    expect(APP).not.toContain("debug_force: true");
    expect(APP).not.toContain("sandboxRoomDocRef");
  });
});
