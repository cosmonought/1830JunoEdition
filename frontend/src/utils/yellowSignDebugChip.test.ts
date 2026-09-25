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

describe("the shell: the chip and its shortcut ask forcedSignToolInForce (source pins -- App.tsx cannot be mounted headless)", () => {
  const APP = readStripped("App.tsx");

  it("the chip renders only for a sandbox host on a board where the force can act", () => {
    const gate = anchorIndex(APP, "{isSandboxHost && forcedSignToolInForce(sandboxState) && (");
    const chip = anchorIndex(APP, '{forcedSign ? `⚠ SIGN: ${forcedSign.toUpperCase()}` : "SIGN: OFF"}');
    expect(gate).toBeLessThan(chip);
    // No other render path for the chip: exactly one readout.
    expect(APP.split('"SIGN: OFF"').length - 1).toBe(1);
    expect(APP).not.toContain("{isSandboxHost && (");
  });

  it("every tooltip naming a phase window or whom the Sign visits sits inside that gated button", () => {
    const gate = anchorIndex(APP, "{isSandboxHost && forcedSignToolInForce(sandboxState) && (");
    const end = anchorIndex(APP, '{forcedSign ? `⚠ SIGN: ${forcedSign.toUpperCase()}` : "SIGN: OFF"}');
    for (const phrase of ["phases 2-4", "phases 5-D", "MARKED corporation's next run", "Carcosan corporation's next run"]) {
      const at = anchorIndex(APP, phrase);
      expect([phrase, at > gate && at < end]).toEqual([phrase, true]);
      expect([phrase, APP.split(phrase).length - 1]).toEqual([phrase, 1]);
    }
  });

  it("the shortcut's cycle writes nothing on such a board: host, then the board, before the room document", () => {
    const cycle = APP.slice(
      anchorIndex(APP, "const cycleForcedSign = useCallback(() => {"),
      anchorIndex(APP, "}, [forcedSign, isSandboxHost]);"),
    );
    expect(cycle).toContain("if (!isSandboxHost) return;");
    expect(cycle).toContain("if (!forcedSignToolInForce(state)) return;");
    expect(cycle.indexOf("if (!forcedSignToolInForce(state)) return;")).toBeLessThan(cycle.indexOf("setSandboxForcedSign("));
  });

  it("the shortcut is not even swallowed on such a board: the listener leaves Ctrl+Shift+Y to the browser there", () => {
    const listener = APP.slice(
      anchorIndex(APP, 'if (event.key.toLowerCase() !== "y") return;'),
      anchorIndex(APP, "}, [isSandboxHost, cycleForcedSign]);"),
    );
    expect(listener.indexOf("if (!forcedSignToolInForce(sandboxStateRef.current)) return;")).toBeGreaterThanOrEqual(0);
    expect(listener.indexOf("if (!forcedSignToolInForce(sandboxStateRef.current)) return;")).toBeLessThan(listener.indexOf("event.preventDefault();"));
  });

  it("the narration still arms the waiver only on a local board, as S9-1 left it", () => {
    expect(APP).toContain("const signLocal = before?.rules_engine_version == null;");
    expect(APP).toContain("const signArmed = sandbox && signLocal ?");
  });
});
