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
import {
  NO_ROOM_NOTICES,
  RESYNC_BANNER,
  TURN_REFUSAL,
  connectionOf,
  roomNoticesReducer,
  type RoomNoticeAction,
  type RoomNotices,
} from "./roomNotices";
import { rollBackIfRefused } from "./submissionAnswer";

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

describe("RED R1 (AUD-25.05, pre-send half): the client's own gates answer `false`, so a refused-before-sending move rolls back", () => {
  it("the catching-up, turn and link-down gates each return `false` after saying why", () => {
    const at = (needle: string) => {
      const i = shell.indexOf(needle);
      expect(i).toBeGreaterThan(-1);
      return shell.slice(i, shell.indexOf("}", i));
    };
    expect(at("setSandboxRoomError(CATCHING_UP_BANNER);")).toContain("return false;");
    expect(at("setSandboxRoomError(TURN_REFUSAL);")).toContain("return false;");
    expect(at('setSandboxRoomError("The room link is reconnecting — try that again in a moment.");')).toContain("return false;");
  });

  it("`false` is what the handlers' rollback acts on (W3-C's helper); `undefined` -- the old answer -- rolled back nothing", async () => {
    const rolledBack: string[] = [];
    await rollBackIfRefused(Promise.resolve(false), () => rolledBack.push("gate"));
    await rollBackIfRefused(Promise.resolve(undefined), () => rolledBack.push("old"));
    expect(rolledBack).toEqual(["gate"]);
  });
});

describe("RED R1 (AUD-25.16, OD-19): the send gate refuses a move from a board that is not current, or from a Watch tab", () => {
  const gate = () => {
    const at = shell.indexOf("const notLive = boardSendRefusalRef.current();");
    expect(at).toBeGreaterThan(-1);
    return shell.slice(shell.lastIndexOf("if (", at), shell.indexOf("const boardNow = sandboxStateRef.current;", at));
  };

  it("asks the board's currency for every dispatch but the replay and the derived actions -- automatic player decisions included", () => {
    expect(gate()).toContain("if (options?.isRemoteReplay !== true && options?.derived !== true) {");
    expect(gate()).not.toContain("options?.automatic");
    expect(gate()).toContain("setSandboxRoomError(notLive);");
    expect(gate()).toContain("return false;");
  });

  it("runs after the catching-up gate and BEFORE the turn gate -- a stale view of whose turn it is enables nothing", () => {
    const send = shell.indexOf("const notLive = boardSendRefusalRef.current();");
    expect(send).toBeGreaterThan(shell.indexOf("setSandboxRoomError(CATCHING_UP_BANNER);"));
    expect(send).toBeLessThan(shell.indexOf("const onTurnNow ="));
  });

  it("the answer it reads is the shell's synchronous one (refs, read at the click), assigned outside the RED region", () => {
    expect(shell).toContain("boardSendRefusalRef.current = () => boardSendRefusal({ watchOnly, currency: syncBoardCurrency() });");
    expect(shell).toContain("drainFailed: drainFailedRoomRef.current !== null && drainFailedRoomRef.current === sandboxRoomRef.current,");
    expect(shell).toContain("divergedAt: divergenceReportedAtRef.current,");
  });
});

/* ------------------------------------------------------------------------------------------------ RED R5 */

const { connectServerLink } = require("./serverLink") as typeof import("./serverLink");
type SocketLike = import("./serverLink").SocketLike;

/** The drain effect's body, from its first line to its teardown. */
const drainEffect = () => sliceBetween(shell, "const drain = async (incoming: SandboxAction[]) => {", "return () => {\n      live = false;");

describe("RED R5 (AUD-25.06): the resync notice is retired when the rebuild's drain settles", () => {
  it("the drain's `finally` retires `resync` beside `catching-up`", () => {
    const finallyBlock = sliceBetween(drainEffect(), "} finally {\n        replayingRef.current = false;", "};");
    expect(finallyBlock).toContain('dispatchRoomNotice({ type: "clear-connection", kind: "catching-up" });');
    expect(finallyBlock).toContain('dispatchRoomNotice({ type: "clear-connection", kind: "resync" });');
  });

  it("through the real link, wired as the shell wires it: the resync notice alone during the rebuild, and gone after it", async () => {
    let notices = NO_ROOM_NOTICES;
    const dispatch = (action: RoomNoticeAction) => (notices = roomNoticesReducer(notices, action));
    const socket: SocketLike = { send: () => {}, close: () => {}, onopen: null, onmessage: null, onclose: null, onerror: null };
    let ids = 0;
    const link = connectServerLink({
      url: "ws://test",
      gameId: "g_0123456789abcdefghjkmnpqr0",
      build: "b",
      socketFactory: () => socket,
      mintSubmissionId: () => `n${(ids += 1)}`,
      // The shell's R5 callbacks (the stale sentence, the resync notice), and the drain's end (both clears).
      onStale: () => dispatch({ type: "refusal", text: "The room had moved on — this tab has caught up. Try that again." }),
      onResync: () => dispatch({ type: "connection", kind: "resync", text: RESYNC_BANNER }),
      onEntries: () => {
        dispatch({ type: "clear-connection", kind: "catching-up" });
        dispatch({ type: "clear-connection", kind: "resync" });
      },
    });
    const deliver = (frame: unknown) => socket.onmessage?.({ data: JSON.stringify(frame) });
    socket.onopen?.({});
    deliver({ kind: "catch-up", build: "b", digest: null, entries: [{ index: 0, id: "e0", actor: "a", payload: "{}" }] });
    const move = link.submit({ PassTurn: { game_id: 0 } } as never);
    deliver({ kind: "error", code: "resync", reason: "history mismatch" });
    // During the rebuild: the resync notice, and no contradicting stale refusal beside it.
    expect(connectionOf(notices, "resync")?.text).toBe(RESYNC_BANNER);
    expect(notices.refusal).toBeNull();
    // The fresh catch-up arrives and its drain settles: the notice is retired, whoever's turn it is.
    deliver({ kind: "catch-up", build: "b", digest: null, entries: [{ index: 0, id: "e0", actor: "a", payload: "{}" }] });
    expect(connectionOf(notices, "resync")).toBeNull();
    await expect(move).resolves.toBeNull(); // it did not land -- and only now is that said
    expect(notices.refusal).toBe("The room had moved on — this tab has caught up. Try that again.");
    link.close();
  });
});
