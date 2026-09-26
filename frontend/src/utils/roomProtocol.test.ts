/** @jest-environment node */
// frontend/src/utils/roomProtocol.test.ts
//
// LIVE-2D: the pure half of the server-owned room protocol -- the join-code reader (the SAME forgiveness the server
// applies, so a code the box accepts is a code the server can look up), the game-id guard a stored resume pointer
// must pass, and the refusal sentences a player reads. A refusal is said in words: never a code, never a support
// reference, never the server's internal text.

import {
  JOIN_CODE_ALPHABET,
  JOIN_CODE_EXAMPLE,
  ROOM_LOST_CODES,
  isGameId,
  parseJoinCode,
  refusalMessage,
  supportRefOf,
  withoutSupportRef,
} from "./roomProtocol";

const CANONICAL = /^JUNO-[ABCDEFGHJKMNPQRTUVWXYZ2346789]{4}-[ABCDEFGHJKMNPQRTUVWXYZ2346789]{4}$/;

describe("parseJoinCode: forgiving about how a code is typed", () => {
  it.each([
    ["JUNO-7K4M-Q2ZP"],
    ["juno-7k4m-q2zp"],
    ["  JUNO 7K4M Q2ZP  "],
    ["juno7k4mq2zp"],
    ["7K4M-Q2ZP"],
    ["7k4m q2zp"],
    ["7K4MQ2ZP"],
    ["JUNO--7K4M--Q2ZP"],
    ["Juno - 7K4M - Q2ZP"],
  ])("reads %j as JUNO-7K4M-Q2ZP", (typed) => {
    expect(parseJoinCode(typed)).toBe("JUNO-7K4M-Q2ZP");
  });

  it("round-trips its own output, and the placeholder example is a code", () => {
    expect(parseJoinCode(JOIN_CODE_EXAMPLE)).toBe(JOIN_CODE_EXAMPLE);
    const once = parseJoinCode("2346-789a");
    expect(once).toBe("JUNO-2346-789A");
    expect(parseJoinCode(once)).toBe(once);
    expect(once).toMatch(CANONICAL);
  });
});

describe("parseJoinCode: rejects what cannot be a code, rather than inventing a table", () => {
  it.each([
    ["the legacy three-character room code", "JUNO-4T2"],
    ["a code one symbol short", "JUNO-7K4M-Q2Z"],
    ["a code one symbol long", "JUNO-7K4M-Q2ZPA"],
    ["an O (misheard as zero)", "JUNO-7K4M-Q2ZO"],
    ["a zero", "JUNO-7K4M-Q2Z0"],
    ["a one", "JUNO-7K4M-Q2Z1"],
    ["an I", "JUNO-7K4M-Q2ZI"],
    ["an L", "JUNO-7K4M-Q2ZL"],
    ["an S", "JUNO-7K4M-Q2ZS"],
    ["a five", "JUNO-7K4M-Q2Z5"],
    ["punctuation", "JUNO-7K4M-Q2Z!"],
    ["an empty string", ""],
    ["the prefix alone", "JUNO"],
    ["a game id", "g_0123456789abcdefghjkmnpqr0"],
    ["more than 32 characters", `JUNO-7K4M-Q2ZP${" ".repeat(20)}`],
  ])("%s", (_label, typed) => {
    expect(parseJoinCode(typed)).toBeNull();
  });

  it("is null for anything that is not a string", () => {
    for (const value of [null, undefined, 12345678, {}, ["JUNO-7K4M-Q2ZP"], true]) expect(parseJoinCode(value)).toBeNull();
  });

  it("uses the read-aloud alphabet: no 0/O, 1/I/L, 5/S", () => {
    for (const confusable of "0O1IL5S") expect(JOIN_CODE_ALPHABET.includes(confusable)).toBe(false);
    expect(JOIN_CODE_ALPHABET).toHaveLength(29);
  });
});

describe("isGameId: the only thing a stored resume pointer may hold", () => {
  it("accepts a server-minted game id and nothing else", () => {
    expect(isGameId("g_0123456789abcdefghjkmnpqr0")).toBe(true);
    expect(isGameId("g_aaaaaaaaaaaaaaaaaaaaaaaaa4")).toBe(true);
    for (const value of ["JUNO-4T2", "JUNO-7K4M-Q2ZP", "p-0123456789abcdef", "g_", "g_0123456789ABCDEFGHJKMNPQR0", "g_0123456789abcdefghjkmnpqr1", "", null, undefined, 7]) {
      expect([value, isGameId(value)]).toEqual([value, false]);
    }
  });
});

describe("refusalMessage: what a player reads", () => {
  /* What the server may put beside a code: its own sentence, an internal reference, or internal text. */
  const REF_REASON = "The server could not process that request. (ref ABC123)";
  const INTERNAL_REASON = "threw: TypeError: cannot read properties of undefined (reading 'seat') at roomHost.ts:514";

  const FIXED: Array<[string, RegExp]> = [
    ["not-found", /not available to you/],
    ["invalid-or-expired", /does not open a table/],
    ["room-full", /full/],
    ["kicked", /removed you/],
    ["rate-limited", /Too many attempts/],
    ["forbidden", /cannot do that/],
    ["not-seated", /do not have a seat/],
    ["held", /paused on the server/],
    ["money-games-disabled", /stakes are not open/],
    ["session-ended", /session on this browser has ended/],
    /* LIVE-2E: profiles are mandatory; a room frame from an unprofiled browser is told how to play. */
    ["profile-required", /^Sign in to a profile to play\.$/],
    ["internal", /went wrong on the server/],
    ["gone", /closed/],
  ];

  it.each(FIXED)("`%s` is a sentence of its own, whatever the server sent beside it", (code, expected) => {
    for (const reason of [undefined, "", REF_REASON, INTERNAL_REASON]) {
      const said = refusalMessage(code, reason);
      expect(said).toMatch(expected);
      expect(said).not.toMatch(/\(ref [0-9A-Z]{6}\)/);
      expect(said).not.toContain("threw");
      expect(said).not.toContain(code === "session-ended" ? "session-ended" : code);
    }
  });

  it("`limit-reached` passes on the server's sentence only when it names the tables, else says it plainly", () => {
    expect(refusalMessage("limit-reached", "You already have 3 open tables.")).toBe("You already have 3 open tables.");
    for (const reason of [undefined, REF_REASON, INTERNAL_REASON]) {
      expect(refusalMessage("limit-reached", reason)).toBe("You are already at as many open tables as a player may be.");
    }
  });

  it("`wrong-state` prefers the server's player sentence (the start refusal names what the table is short of)", () => {
    expect(refusalMessage("wrong-state", "The table has already started.")).toBe("The table has already started.");
    expect(refusalMessage("wrong-state")).toBe("That cannot be done at this point in the game.");
    expect(refusalMessage("wrong-state", "")).toBe("That cannot be done at this point in the game.");
  });

  it("`timeout` never repeats a reason, and an unknown code never echoes the code or the reason", () => {
    expect(refusalMessage("timeout", REF_REASON)).toBe("The game server did not answer. Check the connection and try again.");
    const unknown = refusalMessage("some-new-code", INTERNAL_REASON);
    expect(unknown).toBe("The server could not do that. Try again.");
  });

  it("`held` and `incompatible` say the same thing: the game waits for the server", () => {
    expect(refusalMessage("incompatible", "pinned r7, supports r8")).toBe(refusalMessage("held"));
  });
});

describe("supportRefOf: the reference is for the console, never the screen", () => {
  it("finds a six-symbol reference, and nothing else", () => {
    expect(supportRefOf("The server could not deal this game. (ref 9QX2KD)")).toBe("9QX2KD");
    expect(supportRefOf("The server could not process that request.")).toBeNull();
    expect(supportRefOf(undefined)).toBeNull();
    expect(supportRefOf("(ref abc123)")).toBeNull();
    expect(supportRefOf("(ref ABC12)")).toBeNull();
  });
});

describe("ROOM_LOST_CODES: the answers after which this table is not coming back for this tab", () => {
  it("is exactly not-found, gone and kicked -- a full table is not a loss, a seat may free up", () => {
    expect(Array.from(ROOM_LOST_CODES).sort()).toEqual(["gone", "kicked", "not-found"]);
    expect(ROOM_LOST_CODES.has("room-full")).toBe(false);
  });
});

describe("a passed-through server sentence never carries a support reference (LIVE-2D review)", () => {
  it("strips `(ref XXXXXX)` from every reason it passes through, and withoutSupportRef does the same for the game link", () => {
    for (const code of ["wrong-state", "not-ready", "bad-frame", "unavailable", "busy", "retry", "limit-reached"]) {
      expect(refusalMessage(code, "You are at 3 open tables (ref AB12CD)")).not.toMatch(/ref [0-9A-Z]{6}/);
    }
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(withoutSupportRef("Something went wrong (ref Q7Z2K9)")).toBe("Something went wrong");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Q7Z2K9"));
    warn.mockRestore();
  });
});
