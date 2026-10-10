/** @jest-environment node */
// frontend/src/utils/lobbyBoard.test.ts -- PLAY LOBBY (approved design, "play-lobby-handoff"): the boards' facts.
//
// Pure: a row from the server's public summary (account names, host seat, capacity, mode and deadline, ante and each
// seat's funding), the status words, Play's unchanged Join rule, the filters, the orders that never move a row, the
// snapshot diff that drives flashes and departures, UTC times, amounts, the public history (read strictly, said in
// the design's words) and the split-flap drum.

import { STANDARD_VARIANTS, withGameType } from "../gameEngine/gameVariants";
import {
  FLAP_DRUM,
  FLAP_MAX_STEPS,
  anteOf,
  anteTimes,
  boardRowOf,
  boardTime,
  canJoin,
  clockText,
  departuresOrder,
  diffSnapshots,
  flapPath,
  flapText,
  groupAmount,
  historyLines,
  ordinal,
  publicPlayersOf,
  shown,
  statusOf,
  underWayOrder,
  type BoardRow,
} from "./lobbyBoard";
import type { RoomSummary } from "./roomProtocol";

const T = Date.UTC(2026, 9, 10, 6, 9, 29);
const room = (over: Partial<RoomSummary> = {}): RoomSummary => ({
  gameId: "g_0000000000000000000000000",
  code: "JUNO-GTGQ-AUR6",
  status: "waiting",
  hostNickname: "Marlowe",
  nicknames: ["Marlowe", "Lena", "Kofi"],
  readyCount: 0,
  seated: 3,
  seatCap: 6,
  playerCount: 4,
  variants: STANDARD_VARIANTS,
  createdAtMs: T - 4 * 60_000,
  ...over,
});
const stake = { anteGross: "10000000", symbol: "JUNOX", exponent: 6, networkClass: "testnet" as const, funded: 2, seats: 4 };

describe("a row, from the public summary alone", () => {
  it("names the edition, its colour, the bank, the mode, the host and each seat (host flagged; funding yes / no)", () => {
    const row = boardRowOf(room({ hostSeat: 0, stake: { ...stake, seatFunded: [true, true, false] } }));
    expect(row).toMatchObject({ editionName: "18XX", color: "#D7B56E", bank: "Standard", modeLabel: "Live", host: "Marlowe", codeTail: "AUR6", capacity: 4, exactCount: true, full: false });
    expect(row.seats).toEqual([
      { name: "Marlowe", host: true, funded: true },
      { name: "Lena", host: false, funded: true },
      { name: "Kofi", host: false, funded: false },
    ]);
    expect(row.stake).toMatchObject({ ante: "10 JUNOX", funded: 2, seats: 4 });
  });

  it("the editions: 18XX+, 18XX+ LPF; and their colours", () => {
    expect(boardRowOf(room({ variants: withGameType(STANDARD_VARIANTS, "plus") }))).toMatchObject({ editionName: "18XX+", color: "#59B578" });
    expect(boardRowOf(room({ variants: withGameType(STANDARD_VARIANTS, "levelPlayingField") }))).toMatchObject({ editionName: "18XX+ LPF", color: "#5B8EF0" });
  });

  it("an async table's deadline only as the server read it -- never guessed", () => {
    const async = { ...STANDARD_VARIANTS, mode: "async" as const };
    expect(boardRowOf(room({ variants: async, clock: { deadline: "async-pace", paceSecs: 172_800 } })).modeLabel).toBe("Async: 2d");
    expect(boardRowOf(room({ variants: async, clock: { deadline: "async-pace", paceSecs: 43_200 } })).modeLabel).toBe("Async: 12h");
    expect(boardRowOf(room({ variants: async, clock: { deadline: "no-deadline", paceSecs: null } })).modeLabel).toBe("Async");
    expect(boardRowOf(room({ variants: async })).modeLabel).toBe("Async");
  });

  it("a seat's funding is unknown (no tag) until the server sends it; no ante, no funding", () => {
    expect(boardRowOf(room({ stake })).seats.map((s) => s.funded)).toEqual([null, null, null]);
    expect(boardRowOf(room()).seats.map((s) => s.funded)).toEqual([null, null, null]);
    expect(boardRowOf(room()).stake).toBeNull();
  });

  it("an any-count table holds the board's maximum; without `hostSeat` the host is found by its (unique) name", () => {
    const row = boardRowOf(room({ playerCount: null, nicknames: ["Ada", "Marlowe"], seated: 2 }));
    expect(row.capacity).toBe(6);
    expect(row.exactCount).toBe(false);
    expect(row.seats.map((s) => s.host)).toEqual([false, true]);
  });
});

describe("status, from the summary (no backend field)", () => {
  const r = (seated: number, exact: boolean, status: RoomSummary["status"] = "waiting") => boardRowOf(room({ seated, nicknames: Array(seated).fill("x"), playerCount: exact ? 4 : null, status }));
  it("Boarding, Final call (an exact table, one seat left), Full, Under way (playing, or departing)", () => {
    expect(statusOf(r(2, true))).toBe("boarding");
    expect(statusOf(r(3, true))).toBe("final-call");
    expect(statusOf(r(5, false))).toBe("boarding");
    expect(statusOf(r(4, true))).toBe("full");
    expect(statusOf(r(6, false))).toBe("full");
    expect(statusOf(r(4, true, "playing"))).toBe("under-way");
    expect(statusOf(r(2, true), true)).toBe("under-way");
  });
});

describe("Play's Join rule, unchanged (#1441; PHASE 3 FINAL §13)", () => {
  it("a waiting table with a free seat; never while departing; a no-ante table only where free tables are offered", () => {
    const anted = boardRowOf(room({ stake }));
    const free = boardRowOf(room());
    const full = boardRowOf(room({ stake, seated: 4, nicknames: ["a", "b", "c", "d"] }));
    expect(canJoin(anted, false)).toBe(true);
    expect(canJoin(anted, false, true)).toBe(false);
    expect(canJoin(free, false)).toBe(false);
    expect(canJoin(free, true)).toBe(true);
    expect(canJoin(full, true)).toBe(false);
    expect(canJoin(boardRowOf(room({ stake, status: "playing" })), true)).toBe(false);
  });
});

describe("filters and order", () => {
  it("edition and mode, together", () => {
    const row = boardRowOf(room({ variants: withGameType(STANDARD_VARIANTS, "plus") }));
    expect(shown(row, "all", "all")).toBe(true);
    expect(shown(row, "plus", "live")).toBe(true);
    expect(shown(row, "standard", "all")).toBe(false);
    expect(shown(row, "all", "async")).toBe(false);
  });

  it("Departures oldest first; Under way by start time; a newer table joins the bottom; contents never reorder", () => {
    const a = boardRowOf(room({ gameId: "g_a", createdAtMs: T - 3_000, startedAtMs: T - 100 }));
    const b = boardRowOf(room({ gameId: "g_b", createdAtMs: T - 2_000, startedAtMs: T - 900 }));
    const c = boardRowOf(room({ gameId: "g_c", createdAtMs: T - 1_000 }));
    expect(departuresOrder([c, a, b]).map((x) => x.gameId)).toEqual(["g_a", "g_b", "g_c"]);
    expect(underWayOrder([a, b]).map((x) => x.gameId)).toEqual(["g_b", "g_a"]);
    const busier = boardRowOf(room({ gameId: "g_a", createdAtMs: T - 3_000, seated: 1, nicknames: ["x"] }));
    expect(departuresOrder([c, busier, b]).map((x) => x.gameId)).toEqual(["g_a", "g_b", "g_c"]);
  });
});

describe("between two snapshots", () => {
  it("the first flashes nothing; a change or a new table flashes; waiting -> playing departs", () => {
    const one = boardRowOf(room({ gameId: "g_1" }));
    const two = boardRowOf(room({ gameId: "g_2" }));
    expect(diffSnapshots(null, [one])).toEqual({ changed: new Set(), departed: new Set() });
    const before = new Map<string, BoardRow>([[one.gameId, one]]);
    const fuller = boardRowOf(room({ gameId: "g_1", seated: 4, nicknames: ["a", "b", "c", "d"] }));
    expect(diffSnapshots(before, [fuller, two])).toEqual({ changed: new Set(["g_1", "g_2"]), departed: new Set() });
    expect(diffSnapshots(before, [one])).toEqual({ changed: new Set(), departed: new Set() });
    const started = boardRowOf(room({ gameId: "g_1", status: "playing" }));
    expect(diffSnapshots(before, [started])).toEqual({ changed: new Set(), departed: new Set(["g_1"]) });
  });
});

describe("times and amounts", () => {
  it("UTC HH:MM, a weekday past 20 hours; the clock with seconds", () => {
    expect(boardTime(Date.UTC(2026, 9, 10, 5, 23), T)).toBe("05:23");
    expect(boardTime(Date.UTC(2026, 9, 8, 22, 0), T)).toBe("Thu");
    expect(clockText(T)).toBe("06:09:29 UTC");
  });

  it("groups thousands; multiplies the ante exactly (no floating point); 'n of m'", () => {
    expect(groupAmount("3500 JUNOX")).toBe("3,500 JUNOX");
    expect(groupAmount("1234567.5 JUNOX")).toBe("1,234,567.5 JUNOX");
    const s = boardRowOf(room({ stake: { ...stake, anteGross: "500000000" } })).stake!;
    expect(anteTimes(s, 7)).toBe("3,500 JUNOX");
    expect(anteOf(boardRowOf(room({ stake })).stake!, 2, 4)).toBe("20 of 40 JUNOX");
  });
});

describe("the public history: read strictly, said in the design's words", () => {
  const good = {
    ok: true,
    gameId: "g_x",
    players: [
      { seat: 0, name: "Marlowe", host: true, history: { completed: 47, firstMonth: "2025-05", wins: 13, places: { first: 13, second: 12, third: 11, rest: 11 }, placed: 47, recent: [{ endedOn: "2026-10-09", edition: "standard", place: 2, of: 4 }] } },
      { seat: 1, name: "Luca", host: false, history: { completed: 0, firstMonth: null, wins: 0, places: { first: 0, second: 0, third: 0, rest: 0 }, placed: 0, recent: [] } },
    ],
  };

  it("keeps exactly the approved fields; anything else is not read", () => {
    const players = publicPlayersOf({ ...good, players: [{ ...good.players[0], username: "secret", history: { ...good.players[0].history, accountAgeDays: 9 } }] })!;
    expect(JSON.stringify(players)).not.toContain("secret");
    expect(JSON.stringify(players)).not.toContain("accountAgeDays");
    expect(players[0].history.recent).toEqual([{ endedOn: "2026-10-09", edition: "standard", place: 2, of: 4 }]);
  });

  it("refuses a malformed answer rather than guessing", () => {
    expect(publicPlayersOf(null)).toBeNull();
    expect(publicPlayersOf({ players: "x" })).toBeNull();
    expect(publicPlayersOf({ players: [{ ...good.players[0], history: { ...good.players[0].history, wins: -1 } }] })).toBeNull();
    expect(publicPlayersOf({ players: [{ ...good.players[0], history: { ...good.players[0].history, firstMonth: "May 2025" } }] })).toBeNull();
  });

  it("'47 completed games since May 2025', '13 wins', standings, recent; none: 'No completed games yet'; partial places said", () => {
    const players = publicPlayersOf(good)!;
    expect(historyLines(players[0].history)).toEqual({
      none: false,
      summary: "47 completed games since May 2025",
      wins: "13 wins",
      standings: ["1st ×13", "2nd ×12", "3rd ×11", "4th or lower ×11"],
      partial: null,
      recent: [{ day: "9 Oct", edition: "18XX", result: "2nd of 4" }],
    });
    expect(historyLines(players[1].history)).toEqual({ none: true });
    const partial = historyLines({ ...players[0].history, placed: 40 });
    expect(partial.none === false && partial.partial).toBe("Places known for 40 of 47 games.");
    expect(historyLines({ ...players[0].history, completed: 1, wins: 1 })).toMatchObject({ summary: "1 completed game since May 2025", wins: "1 win" });
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 101].map(ordinal)).toEqual(["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "101st"]);
  });
});

describe("the split-flap drum", () => {
  it("steps forward to the character, at most 14 steps, and ends on it", () => {
    for (const [from, to] of [[" ", "B"], ["A", "Z"], ["Z", "A"], ["4", "4"], [" ", "-"]]) {
      const path = flapPath(from, to, () => 0.5);
      expect(path[path.length - 1]).toBe(to);
      expect(path.length).toBeLessThanOrEqual(FLAP_MAX_STEPS + 1);
      for (const c of path) expect(FLAP_DRUM).toContain(c);
    }
  });

  it("pads, cuts and upper-cases a field; a character off the drum is a blank", () => {
    expect(flapText("Final call", 10)).toBe("FINAL CALL");
    expect(flapText("Full", 10)).toBe("FULL      ");
    expect(flapText("3/4", 3)).toBe("3/4");
    expect(flapText("é!", 2)).toBe("  ");
  });
});
