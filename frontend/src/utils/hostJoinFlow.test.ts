/** @jest-environment node */
// frontend/src/utils/hostJoinFlow.test.ts -- design note #1415.
//
// THE TERMS ARE SET BEFORE THE ROOM EXISTS, and three parties read them: the host's setup card writes them,
// the server enforces them (the cap, the kick, the private game nobody watches), and the waiting room and the
// join list read them back. The pure readers are tested as functions; the enforcement and the wiring are
// source scans, because "does the server refuse the seventh seat" is a question about a join between modules.
//
// LIVE-2D: the room document and its writes are gone. The server's GameRecord holds the terms
// (`server/src/rooms/roomService.ts`, `roomAuthz.ts`, `gameRecord.ts`), every change is a named `room-op`, and the
// client reads back the server's RoomView and RoomSummary -- it validates nothing off the wire itself any more.

import { readSource, readStripped, sliceBetween, readShell } from "./sourceScan";
import * as sandboxRoomSummary from "./sandboxRoomSummary";
import { DEFAULT_ROOM_SETUP, roomSeatCap, roomVisibility, seatsNeeded } from "./sandboxRoomSummary";
import { anteBreakdown, formatBps, formatJuno } from "./anteMath";
import {
  STANDARD_VARIANTS,
  plusTilesTagFor,
  recommendedLengthFor,
  recommendedVariantsFor,
  resolveVariants,
  withGameType,
} from "../gameEngine/gameVariants";
import { canStartSandboxGame, waitingRoomBlock, waitingRoomNotice, type WaitingRoomLike } from "./sandboxRoom";

const LPF = withGameType(STANDARD_VARIANTS, "levelPlayingField");

/* LIVE-2D: the readers take the server's RoomView -- the fields of it they need (`WaitingRoomLike`). */
const room = (
  players: ReadonlyArray<{ id: string; isReady: boolean }>,
  extra: Partial<WaitingRoomLike> = {},
): WaitingRoomLike => ({
  status: "waiting",
  players: players.map((entry) => ({ id: entry.id, nickname: entry.id, isReady: entry.isReady, online: true })),
  playerCount: null,
  variants: STANDARD_VARIANTS,
  ...extra,
});

describe("the table's terms (design note #1415)", () => {
  it("defaults to a public table, any number of players, no ante", () => {
    expect(DEFAULT_ROOM_SETUP).toEqual({ visibility: "public", playerCount: null, anteUjuno: "0" });
    expect(roomVisibility(null)).toBe("public");
    expect(roomVisibility({ visibility: "private" })).toBe("private");
  });

  it("caps the seats at the host's exact count, else the board's", () => {
    expect(roomSeatCap({ playerCount: null, variants: STANDARD_VARIANTS })).toBe(6);
    expect(roomSeatCap({ playerCount: 4, variants: STANDARD_VARIANTS })).toBe(4);
    expect(roomSeatCap({ playerCount: null, variants: LPF })).toBe(7);
    // An exact count the board cannot seat is clamped, and one below two is ignored.
    expect(roomSeatCap({ playerCount: 9, variants: STANDARD_VARIANTS })).toBe(6);
    expect(roomSeatCap({ playerCount: 1, variants: STANDARD_VARIANTS })).toBe(6);
    expect(roomSeatCap(null)).toBe(6);
  });

  it("validates nothing off the wire any more: the server's GameRecord is the only copy of the terms (LIVE-2D)", () => {
    /* `normalisePlayerCount` / `normaliseAnte` validated a legacy room document's fields as the client read them
       back. There is no document to read back: the server checks `create`'s fields against its schema and its own
       bounds, and answers a RoomView. */
    const exported = Object.keys(sandboxRoomSummary);
    for (const gone of ["normalisePlayerCount", "normaliseAnte", "summariseSandboxRoom"]) {
      expect([gone, exported.includes(gone)]).toEqual([gone, false]);
    }
  });

  it("'exactly N' is what the start gate waits for; 'any' is the game's minimum", () => {
    expect(seatsNeeded({ playerCount: null, variants: STANDARD_VARIANTS }, 2)).toBe(2);
    expect(seatsNeeded({ playerCount: 4, variants: STANDARD_VARIANTS }, 2)).toBe(4);
    const three = room(
      [
        { id: "h", isReady: true },
        { id: "b", isReady: true },
      ],
      { playerCount: 3 },
    );
    expect(canStartSandboxGame(three, 2)).toBe(false);
    expect(waitingRoomBlock(three, 2)).toBe("need-players");
    expect(waitingRoomNotice(three, 2, { isHost: false, isReady: true })).toContain("exactly 3");
    const full = room(
      [
        { id: "h", isReady: true },
        { id: "b", isReady: true },
        { id: "c", isReady: true },
      ],
      { playerCount: 3 },
    );
    expect(canStartSandboxGame(full, 2)).toBe(true);
  });

  it("the public list is the server's summary -- names and readiness, no seat ids, no principals, no PINs", () => {
    /* The client used to summarise its own room document for the list (and had to leave the PINs out). The server
       builds `RoomSummary` from its GameRecord now, and only for a PUBLIC table. */
    const summary = roomSummaryRegion(serverSource("rooms/gameRecord.ts"));
    expect(summaryLeaks(summary)).toEqual([]);
  });

  it("reads roomSummaryOf the same way from a CRLF checkout (R12-W1)", () => {
    /* THE WINDOWS FAILURE THIS PINS. `core.autocrlf=true` checks `gameRecord.ts` out with CRLF, and the raw read this
       suite used to make left `\r\n}\r\n` where the anchor says `\n}\n` -- "end anchor not found". The same REAL
       reader, over a disk that answers CRLF, must give the same region; the raw read it replaced must not. */
    const lf = roomSummaryRegion(serverSource("rooms/gameRecord.ts"));
    asCrlfCheckout(() => {
      const nodeFs = require("fs") as typeof import("fs");
      const nodePath = require("path") as typeof import("path");
      const rawCrlf = nodeFs.readFileSync(nodePath.join(__dirname, "../../../server/src/rooms/gameRecord.ts"), "utf8");
      expect(rawCrlf).toContain("\r\n");
      expect(() => roomSummaryRegion(stripServerComments(rawCrlf))).toThrow(/end anchor not found after start/);
      expect(roomSummaryRegion(serverSource("rooms/gameRecord.ts"))).toBe(lf);
    });
  });

  it("cannot pass on an empty, wrong or leaking region (negative controls)", () => {
    const real = roomSummaryRegion(serverSource("rooms/gameRecord.ts"));
    /* A LEAK IS SEEN. The real function with a principal and a PIN added to the object it returns. */
    const leaking = real.replace("    nicknames: record.seats.map((seat) => seat.nickname),", "    nicknames: record.seats.map((seat) => seat.nickname),\n    principals: record.seats.map((seat) => seat.principal_id),\n    pin: record.join_pin,");
    expect(leaking).not.toBe(real);
    expect(summaryLeaks(leaking)).toEqual(expect.arrayContaining(["principal_id", "pin"]));
    /* A PRIVATE TABLE LISTED IS SEEN. */
    expect(summaryLeaks(real.replace('record.visibility !== "public"', "false"))).toContain('witness: record.visibility !== "public"');
    /* A WRONG OR EMPTY REGION IS NOT A PASS: the witnesses are the function's own, so another function (or nothing)
       fails them rather than satisfying every absence. */
    expect(summaryLeaks("export function somethingElse() {\n  return null;\n}").length).toBeGreaterThan(0);
    expect(() => roomSummaryRegion("export function roomSummaryOf(\n}\n")).toThrow(/empty after its anchor/);
    /* And the un-normalised CRLF text -- the owner's Windows failure, exactly -- throws rather than slicing nothing. */
    const rawCrlf = "export function roomSummaryOf(record) {\r\n  return null;\r\n}\r\n";
    expect(() => roomSummaryRegion(rawCrlf)).toThrow(/end anchor not found after start/);
    /* AND THE REGION IS ONE FUNCTION: it stops at the function's own closing brace, before the next declaration. */
    expect(real.trimEnd().endsWith("};")).toBe(true);
    expect(real).not.toMatch(/\n(export )?(function|const|class|interface|type) /);
  });
});

describe("the ante's arithmetic is integer, six places, floored (design note #1415)", () => {
  it("splits an ante into the treasury's share and the pool's, never losing a ujuno", () => {
    const split = anteBreakdown("1000000", 250);
    expect(split).toEqual({ anteUjuno: "1000000", subsidyUjuno: "25000", netUjuno: "975000", subsidyBps: 250 });
    expect(BigInt(split.subsidyUjuno) + BigInt(split.netUjuno)).toBe(BigInt(split.anteUjuno));
    // Floors: 1 ujuno at 2.5% is 0.025, which is 0 to the treasury and 1 to the pool.
    expect(anteBreakdown("1", 250)).toMatchObject({ subsidyUjuno: "0", netUjuno: "1" });
    // Zero and garbage are zero.
    expect(anteBreakdown("0")).toMatchObject({ anteUjuno: "0", subsidyUjuno: "0", netUjuno: "0" });
    expect(anteBreakdown("abc")).toMatchObject({ anteUjuno: "0" });
    // Past 2^53 without losing a digit.
    expect(anteBreakdown("123456789012345678901", 0).netUjuno).toBe("123456789012345678901");
  });

  it("formats JUNO with trailing zeros trimmed and never more than six places", () => {
    expect(formatJuno("0")).toBe("0 JUNO");
    expect(formatJuno("1500000")).toBe("1.5 JUNO");
    expect(formatJuno("1")).toBe("0.000001 JUNO");
    expect(formatJuno("12345678")).toBe("12.345678 JUNO");
    expect(formatBps(250)).toBe("2.5%");
    expect(formatBps(1000)).toBe("10%");
    expect(formatBps(1)).toBe("0.01%");
  });

  it("never touches a float", () => {
    const source = readStripped("utils/anteMath.ts");
    expect(source).not.toContain("parseFloat");
    expect(source).not.toContain("Number(raw)");
    expect(source).not.toMatch(/\* 0\./);
  });
});

describe("what each type recommends (design note #1415)", () => {
  it("18XX+ turns the tile set on; the Level Playing Field picks the $20,000 bank; 18XX keeps the printed game", () => {
    expect(recommendedVariantsFor("plus", "live")).toMatchObject({ expandedMap: true, plusTiles: true, length: "standard" });
    expect(recommendedVariantsFor("levelPlayingField", "async")).toMatchObject({
      levelPlayingField: true,
      plusTiles: true,
      length: "long",
      mode: "async",
    });
    expect(recommendedVariantsFor("standard", "live")).toEqual(STANDARD_VARIANTS);
    expect(recommendedLengthFor("levelPlayingField")).toBe("long");
    expect(recommendedLengthFor("plus")).toBeNull();
  });

  it("tags the tile set as easier on the printed map, recommended on 18XX+, and not at all under LPF", () => {
    expect(plusTilesTagFor("standard")?.tag).toBe("easier");
    expect(plusTilesTagFor("plus")?.tag).toBe("recommended");
    expect(plusTilesTagFor("plus")?.note).toContain("tighter race for tiles");
    expect(plusTilesTagFor("levelPlayingField")).toBeNull();
  });

  it("keeps the tray as chosen when a host goes back to 18XX", () => {
    expect(withGameType({ ...STANDARD_VARIANTS, plusTiles: true }, "standard").plusTiles).toBe(true);
    expect(resolveVariants({ plusTiles: true }).plusTiles).toBe(true);
  });
});

/** R12-W1: for the duration of `fn`, every text read through `fs.readFileSync` comes back with CRLF line endings --
 *  a Windows checkout under `core.autocrlf=true`. The readers under test reach `fs` through `require`, the same
 *  module object as here, so this exercises the REAL reader rather than a copy normalised by hand. */
function asCrlfCheckout<T>(fn: () => T): T {
  const nodeFs = require("fs") as typeof import("fs");
  const real = nodeFs.readFileSync;
  const spy = jest.spyOn(nodeFs, "readFileSync").mockImplementation(((file: unknown, options?: unknown) => {
    const out = (real as (f: unknown, o?: unknown) => unknown)(file, options);
    return typeof out === "string" ? out.replace(/\r?\n/g, "\r\n") : out;
  }) as typeof nodeFs.readFileSync);
  try {
    return fn();
  } finally {
    spy.mockRestore();
  }
}

/** Where the server's sources sit, relative to `src/` -- the argument `sourceScan.readSource` takes. */
const SERVER_SRC_FROM_SRC = "../../server/src/";

/** A server source, comment-stripped (read-only: this suite never writes the server). R12-W1: read through
 *  `sourceScan.readSource`, which normalises line endings -- a raw `fs.readFileSync` left CRLF in a Windows checkout,
 *  and every `\n}\n` region anchor below then missed. */
function serverSource(relative: string): string {
  return stripServerComments(readSource(SERVER_SRC_FROM_SRC + relative));
}

/** This suite's comment stripper, kept as it was: it also drops TRAILING `//` comments, which some anchors below
 *  rely on and `sourceScan.stripComments` (whole-line only) would not. */
function stripServerComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** `roomSummaryOf`, from its signature to its own closing brace. A top-level function in this code base closes with
 *  a `}` in column 0 and nothing nested does, so on normalised text the first `\n}\n` after the signature IS the
 *  function's end; `sliceBetween` throws on a missing anchor or an empty body rather than handing back `""`. */
function roomSummaryRegion(server: string): string {
  return sliceBetween(server, "export function roomSummaryOf(", "\n}\n");
}

/** What the public list must never carry, and the witnesses that prove the region is the real summary. An empty list
 *  is a pass; each entry names what failed. */
function summaryLeaks(summary: string): string[] {
  const failures: string[] = [];
  for (const witness of ['record.visibility !== "public"', "nicknames: record.seats.map((seat) => seat.nickname),", "return {"]) {
    if (!summary.includes(witness)) failures.push(`witness: ${witness}`);
  }
  for (const secret of ["principal_id", "player_id,", "pin", "token"]) if (summary.includes(secret)) failures.push(secret);
  return failures;
}

describe("the server enforces the terms (design note #1415; LIVE-2D: the GameRecord)", () => {
  const SERVICE = serverSource("rooms/roomService.ts");
  const AUTHZ = serverSource("rooms/roomAuthz.ts");
  const HOST = serverSource("rooms/roomHost.ts");

  it("validates the host's fields rather than casting them", () => {
    expect(HOST).toContain('visibility: op.visibility === "private" ? "private" : "public"');
    const create = sliceBetween(SERVICE, "export function createRecord(", "\n}\n");
    expect(create).toContain("input.exactPlayers < MIN_PLAYERS || input.exactPlayers > seatCap");
    expect(create).toContain("kicked_principals: []");
    /* The host's seat is minted by the server, never taken from the frame. (Phase 3 final clocks: minted once, before
       the record, so a No-deadline money table's host acknowledgement can name the seat; the record takes that id.) */
    expect(HOST).toContain("const hostPlayerId = mintPlayerId();");
    expect(HOST).toContain("          hostPlayerId,\n          money: moneyTerms,");
  });

  it("refuses a NEW joiner past the cap, after the start, or after a kick -- and tells them", () => {
    const join = sliceBetween(SERVICE, "export function joinByCode(", "\n}\n");
    expect(join).toContain('if (isKicked(env.record, env.principalId)) return refused("kicked"');
    expect(join).toContain("const seatWanted = takeSeatToo && waiting && env.record.seats.length < capacityOf(env.record);");
    const take = sliceBetween(SERVICE, "export function takeSeat(", "\n}\n");
    expect(take).toContain('refused("kicked"');
    expect(take).toContain('refused("room-full"');
  });

  it("lets only the host kick, only while waiting, never themselves", () => {
    expect(AUTHZ).toContain('kick: { stages: { W: R("H") }, denial: "forbidden" }');
    const kick = sliceBetween(SERVICE, "export function kick(", "\n}\n");
    expect(kick).toContain('if (playerId === env.record.host_player_id) return refused("forbidden"');
    expect(kick).toContain("draft.kicked_principals.push(target.principal_id)");
  });

  it("admits no outsider to a private game once dealt", () => {
    expect(AUTHZ).toContain('if (role === "M" && stage !== "W") role = "O";');
    expect(AUTHZ).toContain('if (role === "O" && !(op === "join" && stage === "W")) return refuse("not-found", role, stage);');
  });
});

describe("the client reads them back (design note #1415)", () => {
  it("a join awaits the server's answer and shows a refusal on the lobby, in words", () => {
    const lobby = readStripped("components/Lobby.tsx");
    expect(lobby).toContain("const answer = await joinHostedGame(code, true);");
    expect(lobby).toContain("sayRefusal(answer.code, answer.reason)");
    /* A refusal is the sentence for its code; the raw reason (which may carry a support reference) is not shown. */
    expect(lobby).not.toContain("setSandboxRoomError(answer.reason)");
    expect(lobby).toContain("<HostSetupCard");
    expect(lobby).toContain("<JoinGameCard");
    const room = readStripped("utils/sandboxRoom.ts");
    expect(sliceBetween(room, "export function joinHostedGame(", "\n}")).toContain('return roomOp({ type: "join", code, takeSeat });');
  });

  it("the waiting room shows the terms, asks before the ante, and offers the host a kick", () => {
    const waiting = readStripped("components/SandboxWaitingRoom.tsx");
    expect(waiting).toContain("Ready to play — ante into this game?");
    expect(waiting).toContain("onToggleReady(readyConfirm === \"deposit\")");
    expect(waiting).toContain("canKick && player.id !== room?.hostId");
    expect(waiting).toContain("const needed = seatsNeeded(room, MIN_PLAYERS);");
    expect(waiting).toContain("The host removed you from this table.");
  });

  it("a spectator takes no seat, and a kicked seat does not ask for one back", () => {
    /* LIVE-2D: THE AUTO-SEAT IS GONE (#856, #1415, #1441, #1442). Entering a table never takes a seat by itself --
       Host and Join asked the server for one, Watch did not -- so there is no watch intent to carry and nothing to
       hold back. A watcher of a waiting table is OFFERED "Take a seat"; a kicked principal is not. */
    const app = readShell();
    for (const gone of ["seatedRoomRef", "sandboxWatchRoom", "sandboxWatchSeed", "upsertSandboxPlayer"]) {
      expect([gone, app.includes(gone)]).toEqual([gone, false]);
    }
    expect(app.match(/\{ type: "take-seat" \}/g) ?? []).toHaveLength(1);
    /* P3-ACCT (public first): asked for an account first -- a signed-in seat's tab takes it at once. */
    expect(app).toContain('const handleTakeSeat = useCallback(() => void requireAccount(() => void runRoomOp({ type: "take-seat" }), "Log in or create an account to take a seat."), [runRoomOp]);');
    // Phase 3 W3-J (OD-19): and a Watch tab -- a read-only view -- offers none either.
    expect(app).toContain("onTakeSeat={!watchOnly && !seated && !sandboxRoom.you.kicked && sandboxRoom.joinable ? handleTakeSeat : undefined}");
    /* The host is the server's answer (`you.role`), never "my id equals the document's hostId". */
    expect(app).toContain('const isSandboxHost = sandbox && sandboxRoom !== null && sandboxRoom.you.role === "host";');
    expect(app).toContain("onKick={isSandboxHost ? handleKickSandboxPlayer : undefined}");
    expect(app).not.toContain("hostId === localId");
    expect(app).not.toContain("handleSetSandboxVariants");
  });

  it("lists open and ongoing public games on the LOBBY, and every one of them can be watched", () => {
    /* ==================================================================
        DESIGN NOTE 1440 SUPERSEDES #1415's PLACEMENT, NOT ITS RULES
       ==================================================================
       THIS CASE ASKED THE JOIN CARD, because that is where #1415 put the list. The three claims it makes are
       unchanged and are asked of `LobbyRoomList` instead: open is `waiting`, ongoing is `playing`, and a
       table at its cap offers a disabled button rather than a refusal the server would have to send.
       THE FOURTH CLAIM STAYS WITH THE CARD, since it is the card's whole reason for existing now -- and it
       is asserted as a SENTENCE about private rooms rather than as a list the card no longer draws. */
    const list = readStripped("components/LobbyRoomList.tsx");
    expect(list).toContain('row.status === "waiting"');
    expect(list).toContain('row.status === "playing"');
    // LIVE-2D: an "exactly N" table is full at N, not at the board's maximum (the summary's `seatCap`).
    expect(list).toContain("full: seated >= capacity,");
    expect(list).toMatch(/const capacity = typeof room\.playerCount === "number"/);
    /* Design note #1441 SUPERSEDES THE LAST CLAUSE: a full table offered a disabled button, which occupied
       the one place a control can be, said no, and hid the thing the room could still do. "Full" is written
       as status and Watch is drawn as the door it always was -- the server having refused a WATCHER only for
       a private room after the deal, at any point in this file's history. */
    expect(list).toContain("data-testid={`lobby-full-${row.code}`}");
    expect(list).not.toContain("disabled={busy || row.full}");
    const card = readStripped("components/JoinGameCard.tsx");
    expect(card).toContain("the code is their only door, and they cannot be watched");
    // The list is not rendered twice: the card holds no room summary of any kind.
    expect(card).not.toContain("SandboxRoomSummary");
    expect(card).not.toContain("onSpectate");
  });
});
