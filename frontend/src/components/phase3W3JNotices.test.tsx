/** @jest-environment jsdom */
//
// ==================================================================
//  PHASE 3 W3-J: THE ROOM STRIP'S NOTICES (AUD-25.13 one-slot / one-line NITs, AUD-25.10 link-down line)
// ==================================================================
//
// W3-C's two-slot model (connection | refusal) is kept. What changes:
//   - one-slot NIT: the connection slot held ONE notice, so a later connection notice (reconnecting) replaced a standing
//     one of another kind (the room's pause). It now holds one notice PER KIND.
//   - one-line NIT: the one-slot surfaces (waiting room, gate pages) read the refusal first and only, hiding a standing
//     connection notice. They now read every connection notice, then the refusal.
//   - AUD-25.10 (f): the client's link-down pre-send line restated the reconnecting banner beside it.

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { RoomNoticeSlots } from "./RoomNoticeSlots";
import {
  LINK_DOWN_NOT_SENT,
  NO_ROOM_NOTICES,
  RECONNECTING_BANNER,
  ROOM_PAUSED_BANNER,
  TURN_REFUSAL,
  connectionOf,
  noticeActionFor,
  roomNoticeLine,
  roomNoticesReducer,
  standingConnections,
  type RoomNoticeAction,
  type RoomNotices,
} from "../utils/roomNotices";
import { readShell } from "../utils/sourceScan";
import { BOARD_DIVERGED_NOTICE, BOARD_DRAIN_FAILED_NOTICE } from "../utils/boardCurrency";
import { CATCHING_UP_BANNER, RESYNC_BANNER } from "../utils/roomNotices";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
global.IS_REACT_ACT_ENVIRONMENT = true;

const run = (...actions: RoomNoticeAction[]): RoomNotices => actions.reduce(roomNoticesReducer, NO_ROOM_NOTICES);
const PAUSE = "Maintenance until 14:05 CDT.";
const INCOMPATIBLE = "This table was dealt on rules this server does not continue.";

describe("W3-J AUD-25.13 (W3-C one-slot NIT): one connection notice per kind", () => {
  it("a reconnecting notice no longer replaces the room's pause notice", () => {
    const state = run(
      { type: "connection", kind: "room-status", text: PAUSE },
      { type: "connection", kind: "reconnecting", text: RECONNECTING_BANNER },
    );
    expect(connectionOf(state, "room-status")?.text).toBe(PAUSE);
    expect(connectionOf(state, "reconnecting")?.text).toBe(RECONNECTING_BANNER);
  });

  it("when the wire comes back, the pause is still said -- the room is still paused", () => {
    const back = run(
      { type: "connection", kind: "room-status", text: PAUSE },
      { type: "connection", kind: "reconnecting", text: RECONNECTING_BANNER },
      { type: "clear-connection", kind: "reconnecting" },
    );
    expect(back.connections).toEqual([{ kind: "room-status", text: PAUSE }]);
    expect(roomNoticesReducer(back, { type: "clear-connection", kind: "room-status" }).connections).toEqual([]);
  });

  it("a later notice of the SAME kind replaces the earlier one; an identical one changes nothing", () => {
    const first = run({ type: "connection", kind: "room-status", text: PAUSE });
    const second = roomNoticesReducer(first, { type: "connection", kind: "room-status", text: ROOM_PAUSED_BANNER });
    expect(second.connections).toEqual([{ kind: "room-status", text: ROOM_PAUSED_BANNER }]);
    expect(roomNoticesReducer(second, { type: "connection", kind: "room-status", text: ROOM_PAUSED_BANNER })).toBe(second);
  });

  it("the reading order puts what freezes the room before the wire, whatever arrived first", () => {
    const state = run(
      { type: "connection", kind: "reconnecting", text: RECONNECTING_BANNER },
      { type: "connection", kind: "incompatible", text: INCOMPATIBLE },
      { type: "connection", kind: "room-status", text: PAUSE },
    );
    expect(standingConnections(state).map((entry) => entry.kind)).toEqual(["incompatible", "room-status", "reconnecting"]);
  });

  it("a landed move still retires only catching-up and resync, and leaves the other kinds standing", () => {
    const state = run(
      { type: "connection", kind: "room-status", text: PAUSE },
      { type: "connection", kind: "catching-up", text: "Catching up with the room — try that again in a moment." },
      { type: "refusal", text: TURN_REFUSAL },
      { type: "submission-landed" },
    );
    expect(state).toEqual({ connections: [{ kind: "room-status", text: PAUSE }], refusal: null });
  });
});

describe("W3-J AUD-25.13 (W3-C one-line NIT): the one-slot surfaces say the connection notice too", () => {
  it("a refusal no longer hides a standing connection notice", () => {
    const state = run({ type: "connection", kind: "incompatible", text: INCOMPATIBLE }, { type: "refusal", text: TURN_REFUSAL });
    expect(roomNoticeLine(state)).toBe(`${INCOMPATIBLE} ${TURN_REFUSAL}`);
  });

  it("every standing notice, in reading order, then the refusal -- and no sentence twice", () => {
    const state = run(
      { type: "connection", kind: "reconnecting", text: RECONNECTING_BANNER },
      { type: "connection", kind: "room-status", text: ROOM_PAUSED_BANNER },
      { type: "refusal", text: ROOM_PAUSED_BANNER },
    );
    expect(roomNoticeLine(state)).toBe(`${ROOM_PAUSED_BANNER} ${RECONNECTING_BANNER}`);
  });

  it("the waiting room and the gate pages are handed that line (the shell's one reading)", () => {
    const shell = readShell();
    expect(shell).toContain("const sandboxRoomError = roomNoticeLine(roomNotices);");
  });
});

describe("W3-J AUD-25.10 (f): the link-down pre-send line does not restate the reconnecting banner", () => {
  it("while the reconnecting banner stands, the line adds nothing to the strip", () => {
    const down = run({ type: "connection", kind: "reconnecting", text: RECONNECTING_BANNER });
    expect(roomNoticesReducer(down, noticeActionFor(LINK_DOWN_NOT_SENT))).toBe(down);
  });

  it("without the banner (#1242's should-be-unreachable case) the line is still said", () => {
    expect(run(noticeActionFor(LINK_DOWN_NOT_SENT)).refusal).toBe(LINK_DOWN_NOT_SENT);
  });

  it("the constant is the sentence the shell's link-down gate writes", () => {
    expect(readShell()).toContain(`setSandboxRoomError("${LINK_DOWN_NOT_SENT}");`);
  });
});

describe("W3-J: the strip draws every standing connection notice", () => {
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
  const kinds = () => Array.from(container.querySelectorAll('[data-testid="room-connection-notice"]')).map((node) => node.getAttribute("data-kind"));

  it("the pause and the reconnecting banner side by side, and the refusal after them", () => {
    draw(
      run(
        { type: "connection", kind: "reconnecting", text: RECONNECTING_BANNER },
        { type: "connection", kind: "room-status", text: PAUSE },
        { type: "refusal", text: TURN_REFUSAL },
      ),
    );
    expect(kinds()).toEqual(["room-status", "reconnecting"]);
    expect(container.querySelector('[data-testid="room-refusal-notice"]')?.textContent).toBe(TURN_REFUSAL);
  });

  it("the room's standing hold notice is still never repeated", () => {
    draw(run({ type: "connection", kind: "room-status", text: PAUSE }, { type: "connection", kind: "reconnecting", text: RECONNECTING_BANNER }), PAUSE);
    expect(kinds()).toEqual(["reconnecting"]);
  });
});

describe("W3-J AUD-25.16 (review): a refusal whose sentence IS a connection notice files as that notice", () => {
  it.each([
    ["catching-up", CATCHING_UP_BANNER],
    ["resync", RESYNC_BANNER],
    ["board-behind", BOARD_DRAIN_FAILED_NOTICE],
    ["board-behind", BOARD_DIVERGED_NOTICE],
  ] as const)("%s: the link's or the gate's refusal with that sentence stands in the connection slot, and its clear retires it", (kind, text) => {
    const state = run({ type: "refusal", text });
    expect(state.refusal).toBeNull();
    expect(connectionOf(state, kind)?.text).toBe(text);
    expect(roomNoticesReducer(state, { type: "clear-connection", kind }).connections).toEqual([]);
    expect(noticeActionFor(text)).toEqual({ type: "connection", kind, text });
  });

  it("every other sentence is still a refusal", () => {
    expect(run({ type: "refusal", text: TURN_REFUSAL }).refusal).toBe(TURN_REFUSAL);
  });
});
