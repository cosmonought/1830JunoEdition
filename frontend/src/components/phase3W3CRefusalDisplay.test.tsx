/** @jest-environment jsdom */
//
// ==================================================================
//  PHASE 3 W3-C: THE REFUSAL DISPLAY MODEL
// ==================================================================
//
// AUD-14.01 -- one error slot with ~28 writers and exact-text clears became two slots (`roomNotices.ts`): the link's
//   notice, with its KIND, and the last refusal of this tab's own action. Every clear names a kind.
// P3-N004 -- a non-turn server refusal stayed in the strip after the turn was played on: a landed move now retires the
//   refusal slot, whatever the refusal said (OD-12 RED R1).
// P3-N020 -- a refused lay kept its spent power and a refused run its "has run" mark: the room's per-action answer
//   (`allocated !== null`, OD-12 RED R1) goes back to the handler, which takes back exactly what it set.

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { RoomNoticeSlots } from "./RoomNoticeSlots";
import {
  CATCHING_UP_BANNER,
  NO_ROOM_NOTICES,
  RECONNECTING_BANNER,
  RESYNC_BANNER,
  ROOM_PAUSED_BANNER,
  TURN_REFUSAL,
  noticeActionFor,
  roomNoticeLine,
  roomNoticesReducer,
  type RoomNoticeAction,
  type RoomNotices,
} from "../utils/roomNotices";
import { rollBackIfRefused, submissionRefused } from "../utils/submissionAnswer";
import { expectOrder, readShell, sliceBetween } from "../utils/sourceScan";

const { connectServerLink } = require("../utils/serverLink") as typeof import("../utils/serverLink");
type SocketLike = import("../utils/serverLink").SocketLike;

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
global.IS_REACT_ACT_ENVIRONMENT = true;

const run = (...actions: RoomNoticeAction[]): RoomNotices => actions.reduce(roomNoticesReducer, NO_ROOM_NOTICES);
const SERVER_REFUSAL = "The B&O cannot buy that train: its treasury holds $40.";
const STALE = "The room had moved on — this tab has caught up. Try that again.";

/* ================================================================================================ */

describe("AUD-14.01: two slots, and every clear names a kind", () => {
  it("a refusal does not replace the reconnecting banner, and the banner does not replace the refusal", () => {
    const state = run(
      { type: "refusal", text: SERVER_REFUSAL },
      { type: "connection", kind: "reconnecting", text: RECONNECTING_BANNER },
    );
    expect(state).toEqual({ connection: { kind: "reconnecting", text: RECONNECTING_BANNER }, refusal: SERVER_REFUSAL });
    const later = roomNoticesReducer(state, { type: "refusal", text: TURN_REFUSAL });
    expect(later.connection?.text).toBe(RECONNECTING_BANNER); // the link's fact stands
    expect(later.refusal).toBe(TURN_REFUSAL); // the newer refusal replaces the older one
  });

  it("the link's own clear retires its kind whatever the sentence -- a server-written pause reason included", () => {
    const paused = run({ type: "connection", kind: "room-status", text: "Maintenance until 14:05 CDT." });
    expect(roomNoticesReducer(paused, { type: "clear-connection", kind: "room-status" }).connection).toBeNull();
    // ... and a clear for another kind leaves it.
    expect(roomNoticesReducer(paused, { type: "clear-connection", kind: "reconnecting" })).toBe(paused);
    const reconnecting = run({ type: "connection", kind: "reconnecting", text: RECONNECTING_BANNER });
    expect(roomNoticesReducer(reconnecting, { type: "clear-connection", kind: "reconnecting" }).connection).toBeNull();
  });

  it("the shell's bare-sentence writers are routed by the constants' identity; every other sentence is a refusal", () => {
    expect(noticeActionFor(CATCHING_UP_BANNER)).toEqual({ type: "connection", kind: "catching-up", text: CATCHING_UP_BANNER });
    expect(noticeActionFor(RECONNECTING_BANNER)).toEqual({ type: "connection", kind: "reconnecting", text: RECONNECTING_BANNER });
    expect(noticeActionFor(RESYNC_BANNER)).toEqual({ type: "connection", kind: "resync", text: RESYNC_BANNER });
    for (const refusal of [TURN_REFUSAL, SERVER_REFUSAL, "Could not reach the room — that action was not sent.", "The room link is reconnecting — try that again in a moment."]) {
      expect(noticeActionFor(refusal)).toEqual({ type: "refusal", text: refusal });
    }
  });

  it("the one-line surfaces (waiting room, gate) read the refusal first, then the link's notice", () => {
    expect(roomNoticeLine(NO_ROOM_NOTICES)).toBeNull();
    expect(roomNoticeLine(run({ type: "connection", kind: "resync", text: RESYNC_BANNER }))).toBe(RESYNC_BANNER);
    expect(roomNoticeLine(run({ type: "connection", kind: "resync", text: RESYNC_BANNER }, { type: "refusal", text: STALE }))).toBe(STALE);
  });

  it("leaving resets both slots; a new room op retires only the refusal", () => {
    const both = run({ type: "connection", kind: "reconnecting", text: RECONNECTING_BANNER }, { type: "refusal", text: STALE });
    expect(roomNoticesReducer(both, { type: "reset" })).toBe(NO_ROOM_NOTICES);
    expect(roomNoticesReducer(both, { type: "clear-refusal" })).toEqual({ connection: both.connection, refusal: null });
  });
});

describe("P3-N004: a landed move retires the refusal -- any refusal -- and nothing about the link", () => {
  it.each([
    ["the turn gate's refusal", TURN_REFUSAL],
    ["a server refusal (the case that stayed up)", SERVER_REFUSAL],
    ["a stale answer", STALE],
    ["a send that never left", "Could not reach the room — that action was not sent."],
  ])("%s is retired by the next landed move", (_label, text) => {
    expect(run({ type: "refusal", text }, { type: "submission-landed" }).refusal).toBeNull();
  });

  it("the link's notices about other facts stand; catching-up and resync, which a landed move contradicts, go", () => {
    for (const kind of ["reconnecting", "room-status", "build-skew", "incompatible", "divergence", "transport"] as const) {
      expect(run({ type: "connection", kind, text: `notice:${kind}` }, { type: "submission-landed" }).connection).toEqual({ kind, text: `notice:${kind}` });
    }
    expect(run({ type: "connection", kind: "catching-up", text: CATCHING_UP_BANNER }, { type: "submission-landed" }).connection).toBeNull();
    expect(run({ type: "connection", kind: "resync", text: RESYNC_BANNER }, { type: "submission-landed" }).connection).toBeNull();
  });

  it("no stale refusal survives a transition: refused, then the room applies the next move", async () => {
    /* Driven through the REAL server link: its refused frame settles the submission null and raises `onRefused` with
       the server's sentence; the next submission is applied. The dispatches are the shell's (RED R5's `onRefused`, RED
       R1's `submission-landed` on a non-null allocation). */
    let state = NO_ROOM_NOTICES;
    const dispatch = (action: RoomNoticeAction) => (state = roomNoticesReducer(state, action));
    const sent: string[] = [];
    const socket: SocketLike = { send: (data) => sent.push(data), close: () => socket.onclose?.({}), onopen: null, onmessage: null, onclose: null, onerror: null };
    let ids = 0;
    const link = connectServerLink({
      url: "ws://test",
      gameId: "g_0123456789abcdefghjkmnpqr0",
      build: "build-1",
      onEntries: () => undefined,
      onRefused: (reason) => dispatch({ type: "refusal", text: reason }),
      socketFactory: () => socket,
      mintSubmissionId: () => `n${(ids += 1)}`,
    });
    socket.onopen?.({});
    const deliver = (frame: unknown) => socket.onmessage?.({ data: JSON.stringify(frame) });
    deliver({ kind: "catch-up", build: "build-1", digest: "0".repeat(16), entries: [] });

    const first = link.submit({ BuyStock: { game_id: 0 } } as never);
    deliver({ kind: "refused", build: "build-1", reason: SERVER_REFUSAL, inReplyTo: "n1" });
    const firstAnswer = (await first) !== null; // RED R1: `return allocated !== null`
    expect(firstAnswer).toBe(false);
    expect(submissionRefused(firstAnswer)).toBe(true);
    expect(state.refusal).toBe(SERVER_REFUSAL);

    const second = link.submit({ PassTurn: { game_id: 0 } } as never);
    deliver({
      kind: "applied",
      build: "build-1",
      digest: "0".repeat(16),
      entries: [{ index: 0, id: "e0", actor: "p", payload: "{}", submission_id: "n2" }],
      inReplyTo: "n2",
    });
    const allocated = await second;
    expect(allocated).toBe(0);
    if (allocated !== null) dispatch({ type: "submission-landed" }); // RED R1
    expect(state.refusal).toBeNull();
    link.close();
  });
});

/* ================================================================================================ */

describe("the strip renders the two slots", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });
  const draw = (notices: RoomNotices, holdNotice: string | null = null) =>
    act(() => root.render(<RoomNoticeSlots notices={notices} holdNotice={holdNotice} />));
  const slot = (id: string) => container.querySelector(`[data-testid="${id}"]`);

  it("nothing when the room has nothing to say", () => {
    draw(NO_ROOM_NOTICES);
    expect(container.textContent).toBe("");
  });

  it("both slots at once, each with its own sentence -- the reconnecting banner and the refusal", () => {
    draw(run({ type: "connection", kind: "reconnecting", text: RECONNECTING_BANNER }, { type: "refusal", text: SERVER_REFUSAL }));
    expect(slot("room-connection-notice")?.textContent).toBe(RECONNECTING_BANNER);
    expect(slot("room-connection-notice")?.getAttribute("data-kind")).toBe("reconnecting");
    expect(slot("room-refusal-notice")?.textContent).toBe(SERVER_REFUSAL);
  });

  it("re-renders with the slot gone once the landed move retires it -- no stale copy", () => {
    const refused = run({ type: "refusal", text: SERVER_REFUSAL });
    draw(refused);
    expect(slot("room-refusal-notice")).not.toBeNull();
    draw(roomNoticesReducer(refused, { type: "submission-landed" }));
    expect(slot("room-refusal-notice")).toBeNull();
    expect(container.textContent).toBe("");
  });

  it("never repeats the room's standing hold notice, and never prints one sentence twice", () => {
    const held = "The table is held while the server checks the log.";
    draw(run({ type: "connection", kind: "room-status", text: held }, { type: "refusal", text: held }), held);
    expect(container.textContent).toBe("");
    draw(run({ type: "connection", kind: "room-status", text: ROOM_PAUSED_BANNER }, { type: "refusal", text: ROOM_PAUSED_BANNER }));
    expect(container.textContent).toBe(ROOM_PAUSED_BANNER);
  });
});

/* ================================================================================================ */

describe("P3-N020: a refused move takes back the shell state its handler set", () => {
  it("only the room's `false` takes anything back -- `true` (applied) and `undefined` (no room) do not", async () => {
    const calls: string[] = [];
    await rollBackIfRefused(Promise.resolve(true), () => calls.push("applied"));
    await rollBackIfRefused(Promise.resolve(undefined), () => calls.push("solo"));
    await rollBackIfRefused(undefined, () => calls.push("void"));
    expect(calls).toEqual([]);
    await rollBackIfRefused(Promise.resolve(false), () => calls.push("refused"));
    expect(calls).toEqual(["refused"]);
  });

  it("a refused power lay: the key added to the fallback set comes out, and the JK is armed again", async () => {
    // The handler's own writes, then its rollback, on a state like the shell's.
    let used = new Set<string>(["csl-tile"]);
    let jkArmed = true;
    const errandKey = "dh-tile";
    used = new Set(used).add(errandKey); // the lay's write
    jkArmed = false; // the JK's disarm before sending
    await rollBackIfRefused(Promise.resolve(false), () => {
      const next = new Set(used);
      next.delete(errandKey);
      used = next;
      jkArmed = true;
    });
    expect(Array.from(used)).toEqual(["csl-tile"]); // a power spent EARLIER stays spent
    expect(jkArmed).toBe(true);
  });

  it("the shell wires it: the run returns before marking, the lay rolls back exactly what it set", () => {
    const shell = readShell();
    const runTail = sliceBetween(shell, "const runAnswer = await runGameplayAction(\"RunMultipleRoutes\", {", "setLiveOrSubPhase(\"Dividends\");");
    expect(runTail).toContain("if (submissionRefused(runAnswer)) return;");
    // The return precedes the mark.
    expectOrder(runTail, "if (submissionRefused(runAnswer)) return;", "setRoutesRunThisTurn({ protocolId: actingProtocolId, ran: true });");
    const lay = sliceBetween(shell, "let layAnswer: unknown;", "handleRingConfirmed();");
    expect(lay).toContain("layAnswer = handleSandboxLayTile(");
    expect(lay).toContain("layAnswer = runGameplayAction(\"LayTile\", {");
    expect(lay).toContain("void rollBackIfRefused(layAnswer, () => {");
    expect(lay).toContain("next.delete(errandKey);");
    expect(lay).toContain("if (spentAbility === JK_TILE_ABILITY_KEY) setJkLayArmed(true);");
    const sandboxLay = sliceBetween(shell, "const answer = runGameplayAction(\"LayTile (sandbox)\", {", "[runGameplayAction, gameId, actingProtocolId],");
    expect(sandboxLay).toContain("return answer;");
  });
});

/* ================================================================================================ */

describe("RED wiring (OD-12)", () => {
  const shell = readShell();

  it("RED R1: the landed branch dispatches `submission-landed` (no TURN_REFUSAL compare) and answers the caller", () => {
    const landed = sliceBetween(shell, "if (allocated === null) {", "if (allocated !== null && appliedIndexRef.current === appendAt) {");
    expect(landed).toContain('dispatchRoomNotice({ type: "submission-landed" });');
    expect(landed).not.toMatch(/current === TURN_REFUSAL/);
    expect(shell).toContain("return allocated !== null;");
  });

  it("RED R5: the link callbacks name their slot and kind; nothing clears by comparing a sentence", () => {
    expect(shell).not.toMatch(/setSandboxRoomError\(\(/); // no functional (exact-text) clear anywhere
    expect(shell).not.toContain("roomStatusBanner");
    const callbacks = sliceBetween(shell, "onRefused: (reason) => {", "serverLinkRef.current = link;");
    expect(callbacks).toContain('dispatchRoomNotice({ type: "refusal", text: withoutSupportRef(reason) });');
    expect(callbacks).toContain('kind: "build-skew"');
    expect(callbacks).toContain('dispatchRoomNotice({ type: "connection", kind: "incompatible"');
    expect(callbacks).toContain('{ type: "connection", kind: "reconnecting", text: RECONNECTING_BANNER }');
    expect(callbacks).toContain('dispatchRoomNotice({ type: "connection", kind: "resync", text: RESYNC_BANNER });');
    expect(callbacks).toContain('dispatchRoomNotice({ type: "clear-connection", kind: "room-status" });');
    expect(callbacks).toContain('dispatchRoomNotice({ type: "clear-connection", kind: "reconnecting" });');
    expect(shell).toContain('dispatchRoomNotice({ type: "clear-connection", kind: "catching-up" });');
    expect(shell).toContain('dispatchRoomNotice({ type: "connection", kind: "divergence", text: verdict.message });');
  });

  it("the shell keeps one model: a reducer, a one-line reading, and a sentence-only setter", () => {
    expect(shell).toContain("useReducer(roomNoticesReducer, NO_ROOM_NOTICES)");
    expect(shell).toContain("const sandboxRoomError = roomNoticeLine(roomNotices);");
    expect(shell).toContain("useCallback((sentence: string) => dispatchRoomNotice(noticeActionFor(sentence)), [])");
    expect(shell).toContain("{sandboxRoomCode && <RoomNoticeSlots notices={roomNotices} holdNotice={holdNoticeFor(sandboxRoom)} />}");
  });
});
