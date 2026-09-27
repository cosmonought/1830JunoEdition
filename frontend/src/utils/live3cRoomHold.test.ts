// frontend/src/utils/live3cRoomHold.test.ts
//
// LIVE-3C: what a player reads when a room will not take a change -- held for maintenance, incompatible with this
// server's rules engine, dealt on another build, or waiting on an unconfirmed write -- and when a table is gone.

import { GONE_REASONS, HOLD_NOTICES, holdNoticeFor, refusalMessage, type RoomHoldKind } from "./roomProtocol";

describe("LIVE-3C: the standing notice of a room that will not take a change", () => {
  const KINDS: Array<Exclude<RoomHoldKind, null>> = ["maintenance", "incompatible", "read-only", "unavailable"];

  it("each hold kind has its own sentence; a live room has none", () => {
    expect(holdNoticeFor({ holdKind: null })).toBeNull();
    expect(holdNoticeFor(null)).toBeNull();
    expect(holdNoticeFor(undefined)).toBeNull();
    expect(holdNoticeFor({ holdKind: "a-kind-from-a-newer-server" as RoomHoldKind })).toBeNull();
    const said = KINDS.map((kind) => holdNoticeFor({ holdKind: kind }));
    expect(new Set(said).size).toBe(KINDS.length);
    for (const sentence of said) {
      expect(sentence).toMatch(/^[A-Z].*\.$/);
      expect(sentence).not.toMatch(/g_[0-9a-z]{26}|p-[0-9a-z]{16}|pr_|pf_|se_|ref [0-9A-Z]{6}/);
    }
  });

  it("a maintenance hold says the seat and the game so far are kept, and who restores it", () => {
    expect(HOLD_NOTICES.maintenance).toMatch(/paused for maintenance/);
    expect(HOLD_NOTICES.maintenance).toMatch(/operator/);
    expect(HOLD_NOTICES.maintenance).toMatch(/seat and the game so far are kept/);
  });

  it("an incompatible game says it cannot continue here; a read-only one says it can be watched", () => {
    expect(HOLD_NOTICES.incompatible).toMatch(/cannot continue on this server/);
    expect(HOLD_NOTICES["read-only"]).toMatch(/You can watch it/);
    expect(HOLD_NOTICES.unavailable).toMatch(/could not confirm/);
  });

  it("the server's held sentence and the client's are the same words", () => {
    // server/src/rooms/lifecycle.ts HELD_PLAYER_SENTENCE -- a refused move and the standing notice agree.
    expect(refusalMessage("held", "anything the server sent")).toBe(HOLD_NOTICES.maintenance);
  });

  it("`gone` passes on the server's own sentence for what ended the table, and nothing else", () => {
    for (const reason of GONE_REASONS) expect(refusalMessage("gone", reason)).toBe(reason);
    expect(refusalMessage("gone", "That game is over and gone.")).toBe("That table has closed.");
    expect(refusalMessage("gone", "internal text at roomHost.ts:12")).toBe("That table has closed.");
    expect(refusalMessage("gone")).toBe("That table has closed.");
  });
});
