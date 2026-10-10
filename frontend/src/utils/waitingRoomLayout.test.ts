/** @jest-environment node */
// frontend/src/utils/waitingRoomLayout.test.ts
//
// ==================================================================
//  PLAY WAITING ROOM (approved design, "play-host-waiting-handoff" §4-§9, §14, §16): THE PAGE'S SHAPE, PINNED
// ==================================================================
//
// SUPERSEDES design notes #1443-#1446 (one surface, two columns, a rail for the rules): the owner approved a new waiting
// room -- the table's own departure sign, YOUR BOARDING PASS across the sign's full width carrying everything you do
// before departure, the Boarding board, Game settings and Variants, the Ludum footer. What these cases keep from the
// old ones is what a re-layout is most likely to break by accident: the controls a viewer is or is not entitled to,
// the role read from the server, and the absences that would let a removed control back in.

import { readStripped } from "./sourceScan";

const WAITING = readStripped("components/SandboxWaitingRoom.tsx");
const PARTS = readStripped("components/room/RoomParts.tsx");
const CSS = readStripped("components/room/roomDesignCss.ts");

const order = (text: string, ...marks: string[]) => {
  let at = -1;
  for (const mark of marks) {
    const next = text.indexOf(mark, at + 1);
    expect([mark, next > at]).toEqual([mark, true]);
    at = next;
  }
};

describe("§4: the page, top to bottom", () => {
  it("is the sign, your pass, the Boarding board, the settings and the Ludum footer -- and no Before departure section", () => {
    order(WAITING, "<TopBar onLeaveGame={onLeave}", 'data-testid="room-sign"', 'className="rm-you-row"', 'data-testid="boarding-board"', 'data-testid="game-settings"', "<RoomFooter />");
    expect(WAITING).not.toContain("<h2 id=\"rm-dep-h\">");
    expect(PARTS).toContain("Project 18XX on Ludum ↗");
    /* Footer fix (owner, 2026-10-10): the credit is Play's own AppFooter (the animated mark and its words), not text. */
    expect(PARTS).toContain('<AppFooter surface="meta" />');
  });

  it("paints its own ground, with no photograph", () => {
    expect(WAITING).toContain('backgroundColor: "#080808"');
    expect(WAITING).not.toContain("waiting-room.jpg");
    expect(WAITING).toContain('position: "relative"');
    expect(WAITING).toContain('isolation: "isolate"');
  });
});

describe("§6: your boarding pass carries everything you do before departure", () => {
  it("has two halves: who you are (left), and the actions (right), in the design's order", () => {
    expect(PARTS).toContain('<div className={big ? "rm-p-id" : "rm-p-flat"}>');
    expect(PARTS).toContain("{props.actions}");
    const right = WAITING.slice(WAITING.indexOf("actions={"), WAITING.indexOf("            </BoardingPass>"));
    order(
      right,
      'className="rm-p-say" role="status"',
      "The host can still change the ante until the first deposit.",
      'data-testid="ante-editor"',
      "passAction()",
      "Change ante",
      "Give up seat",
      'data-testid="money-progress"',
      'label="Terms of real-money play"',
      "<MoneyPanelView",
      'role="alert" data-testid="waiting-room-error"',
    );
    /* The left half: the name (a button that opens the player panel), the tags, the terms line, your colour. */
    expect(WAITING).toContain("<span id=\"rm-colour-l\">Set player colour:</span>");
    expect(WAITING).toContain("const termsLine = `${GAME_TYPE_COPY[type].label} · ${paceText(pace)} · ${bankText(variants.length)}`;");
  });

  it("puts Start game in the Ante's place once the host has anted, and Withdraw deposit for a funded guest", () => {
    const action = WAITING.slice(WAITING.indexOf("const passAction"), WAITING.indexOf("const keplrLine"));
    expect(action).toContain('isHost || guestStart ? startButton(canStart, "money-action-start") : null');
    expect(action).toContain('title="Locks the seats with the escrow and starts the game on Juno."');
    expect(action).toContain('data-testid="money-action-withdraw"');
    expect(action).toContain("Approve in Keplr…");
    expect(action).toContain("Sent · waiting for Juno");
  });

  it("opens the ante editor in the Ante's place, with Set ante and Keep", () => {
    expect(WAITING).toContain("{anteEditable && anteEditing ? null : passAction()}");
    expect(WAITING).toContain('{anteSending ? "Setting…" : "Set ante"}');
    expect(WAITING).toContain("Keep {ante}");
    expect(WAITING).toContain('void sendOp({ type: "set-ante", stake: anteBase }, room.gameId)');
  });

  it("has no name field and no five-step progress line", () => {
    for (const gone of ["Set name", "Your nickname", "nicknameText", 'data-testid="money-steps"', "FUNDING_STEPS"]) {
      expect([gone, WAITING.includes(gone)]).toEqual([gone, false]);
    }
  });
});

describe("what a viewer is entitled to (kept from design note #1443, LIVE-2D)", () => {
  it("gives the pass and its actions to a SEAT; a watcher and a removed player get a dashed panel that says so", () => {
    expect(WAITING).toContain("{me !== null && room !== null ? (");
    expect(WAITING).toContain(") : wasKicked ? (");
    expect(WAITING).toContain('data-testid="waiting-room-watching"');
    expect(WAITING).toContain('data-testid="waiting-room-removed"');
    expect(WAITING).toContain("You are watching this table. Take a seat to play.");
    expect(WAITING).toContain("You are watching this table. Every seat is taken.");
    expect(WAITING).toContain("You can keep watching; the game is shown here when it starts.");
    expect(WAITING).toContain("You no longer hold a seat at this table.");
    expect(WAITING).toContain("The host removed you from this table. You cannot rejoin it; leave and join or host another.");
  });

  it("offers a watcher a seat by one op, and no seat-PIN door survives", () => {
    expect(WAITING).toContain("{onTakeSeat ? (");
    expect(WAITING).toContain('data-testid="take-seat"');
    expect(WAITING).toContain("onClick={onTakeSeat}");
    for (const gone of ["SeatPinModal", "setSeatPin", "Set PIN", "PIN set", "hasPin", "upsertSandboxPlayer", "joinSandboxRoom"]) {
      expect([gone, WAITING.includes(gone)]).toEqual([gone, false]);
    }
    /* The one op this screen sends itself besides the deadline chooser's is the ante editor's, through `sendOp`. */
    expect(WAITING).not.toContain("roomOp(");
  });

  it("reads who it is at the table from the server's view, never from a stored id", () => {
    expect(WAITING).toContain('const isHost = room?.you.role === "host";');
    expect(WAITING).toContain("const wasKicked = room !== null && room.you.kicked;");
    expect(WAITING).toContain("const canStartFree = isHost && (room?.you.canStart ?? false) && players.length >= needed && allReady;");
    expect(WAITING).toContain('const canStart = !departing && (money !== null ? flow?.primary?.kind === "start" : canStartFree);');
    expect(WAITING).not.toContain("room?.hostId === localPlayerId");
  });

  it("reads every displayed value from the authority it already had", () => {
    expect(WAITING).toContain("const resolvedColors = resolveSeatColors(players);");
    expect(WAITING).toContain("const cash = startingCashForPlayers(players.length, variants);");
    expect(WAITING).toContain("const certs = certLimitForPlayers(players.length, variants);");
    expect(WAITING).toContain("VARIANT_COPY.plusTiles.blurb");
    expect(WAITING).toContain("const needed = seatsNeeded(room, MIN_PLAYERS);");
  });
});

describe("§5, §10, §16: what the waiting room no longer offers", () => {
  it("has no visibility and no code control (the server ops stand, unoffered here)", () => {
    for (const gone of ["Make private", "Make public", "Change code", "New code", "onSetVisibility(", "onRotateCode(", 'data-testid="rotate-code"', 'data-testid="toggle-visibility"']) {
      expect([gone, WAITING.includes(gone)]).toEqual([gone, false]);
    }
    expect(readStripped("App.tsx")).not.toContain("onSetVisibility={");
    expect(readStripped("App.tsx")).not.toContain("onRotateCode={");
  });
});

describe("§9.1: Game settings", () => {
  it("lists Pace, Visibility and Bank, then Skip the opening titles, Report a player, and the host's Cancel table under a hairline", () => {
    const settings = WAITING.slice(WAITING.indexOf('data-testid="game-settings"'));
    order(settings, "<dt>Pace</dt>", "<ClockRules", "<dt>Visibility</dt>", "<dt>Bank</dt>", "Skip the opening titles", "<ReportPlayerControl", 'className="rm-host-end"', "Cancel table");
    expect(settings).toContain("Fixed when the table opened");
    expect(settings).toContain("Close this table for everyone?");
    expect(settings).toContain('"Every deposit comes back to its wallet, minus the fee."');
    expect(settings).toContain('"Nobody has anted, so nothing moves."');
    /* Before the escrow opens it is the room's cancel; after, Play's CANCEL_FLOW on Juno. */
    expect(settings).toContain('if (cancelEscrow !== null) void table.run("cancel-escrow");');
    expect(CSS).toContain(".rm-host-end { display: grid; gap: 10px; justify-items: start; padding-top: 14px; border-top: 1px solid var(--rm-line); }");
  });
});

describe("§14: the widths", () => {
  it("keeps the torn stub inside the page at 1240 and below, stacks the halves at 1080, and goes to one column at 760", () => {
    order(CSS, "@media (max-width: 1240px)", ".rm-pass.rm-big { margin-right: 14px; }", "@media (max-width: 1080px)", ".rm-pass.rm-big > .rm-p-main { grid-template-columns: minmax(0, 1fr);", "@media (max-width: 760px)", ".rm-passes { padding: 16px 14px; grid-template-columns: minmax(0, 1fr); }");
    expect(WAITING).toContain("<style>{zoomAwareMediaCss(ROOM_DESIGN_CSS, uiScale)}</style>");
  });
});

describe("the footer fits the window it is in (design note #1443)", () => {
  it("caps the mark that has a 300px default when it cannot decode", () => {
    const mark = readStripped("components/NetaMark.tsx");
    expect(mark).toContain('maxWidth: "100%"');
    expect(mark).toContain("minWidth: 0");
    expect(mark).toContain('flex: "0 1 auto"');
    const credit = readStripped("styles/appStyles.ts");
    expect(credit.slice(credit.indexOf("netaCredit: {"), credit.indexOf("netaCredit: {") + 400)).toContain('maxWidth: "100%"');
    expect(readStripped("components/AppFooter.tsx")).toContain("const MARK_HEIGHT = 28;");
  });
});
