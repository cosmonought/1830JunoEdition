/** @jest-environment node */
// frontend/src/utils/hostJoinFlow.test.ts -- design note #1415.
//
// THE TERMS ARE SET BEFORE THE ROOM EXISTS, and three parties read them: the host's setup card writes them,
// the server enforces them (the cap, the kick, the private game nobody watches), and the waiting room and the
// join list read them back. The pure readers are tested as functions; the enforcement and the wiring are
// source scans, because "does the server refuse the seventh seat" is a question about a join between modules.

import { readStripped, sliceBetween } from "./sourceScan";
import {
  DEFAULT_ROOM_SETUP,
  normaliseAnte,
  normalisePlayerCount,
  roomSeatCap,
  roomVisibility,
  seatsNeeded,
  summariseSandboxRoom,
} from "./sandboxRoomSummary";
import { anteBreakdown, formatBps, formatJuno } from "./anteMath";
import {
  STANDARD_VARIANTS,
  plusTilesTagFor,
  recommendedLengthFor,
  recommendedVariantsFor,
  resolveVariants,
  withGameType,
} from "./gameVariants";
import { canStartSandboxGame, waitingRoomBlock, waitingRoomNotice, type SandboxRoomDoc } from "./sandboxRoom";

const LPF = withGameType(STANDARD_VARIANTS, "levelPlayingField");

const room = (
  players: ReadonlyArray<{ id: string; isReady: boolean }>,
  extra: Partial<SandboxRoomDoc> = {},
): SandboxRoomDoc => ({
  code: "JUNO-1A1",
  hostId: "h",
  status: "waiting",
  players: players.map((entry) => ({ id: entry.id, nickname: entry.id, isReady: entry.isReady })),
  variants: STANDARD_VARIANTS,
  forcedSign: null,
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

  it("validates a player count and an ante off the wire", () => {
    expect(normalisePlayerCount(4, STANDARD_VARIANTS)).toBe(4);
    expect(normalisePlayerCount(7, STANDARD_VARIANTS)).toBeNull();
    expect(normalisePlayerCount(7, LPF)).toBe(7);
    expect(normalisePlayerCount(2.5, STANDARD_VARIANTS)).toBeNull();
    expect(normalisePlayerCount("4", STANDARD_VARIANTS)).toBeNull();
    expect(normalisePlayerCount(undefined, STANDARD_VARIANTS)).toBeNull();
    expect(normaliseAnte("1500000")).toBe("1500000");
    expect(normaliseAnte("0001")).toBe("1");
    expect(normaliseAnte("1.5")).toBe("0");
    expect(normaliseAnte(undefined)).toBe("0");
    expect(normaliseAnte(-3)).toBe("0");
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

  it("summarises a room as the public list shows it -- names and readiness, never the PINs", () => {
    const doc = room([{ id: "h", isReady: true }, { id: "b", isReady: false }], {
      visibility: "public",
      playerCount: 4,
      anteUjuno: "2000000",
      createdAtMs: 5,
      seatPins: { h: "1234" },
    });
    const summary = summariseSandboxRoom(doc);
    expect(summary).toEqual({
      code: "JUNO-1A1",
      status: "waiting",
      hostNickname: "h",
      players: [
        { id: "h", nickname: "h", isReady: true },
        { id: "b", nickname: "b", isReady: false },
      ],
      seatCap: 4,
      playerCount: 4,
      variants: STANDARD_VARIANTS,
      anteUjuno: "2000000",
      createdAtMs: 5,
    });
    expect(JSON.stringify(summary)).not.toContain("1234");
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

describe("the server enforces the terms (design note #1415)", () => {
  const fs = require("fs") as typeof import("fs");
  const path = require("path") as typeof import("path");
  const SERVER = fs.readFileSync(path.join(__dirname, "../../../server/src/gameServer.ts"), "utf8");

  it("validates the host's fields rather than casting them", () => {
    expect(SERVER).toContain('visibility: write.visibility === "private" ? "private" : "public"');
    expect(SERVER).toContain("playerCount: normalisePlayerCount(write.playerCount, variants)");
    expect(SERVER).toContain("anteUjuno: normaliseAnte(write.anteUjuno)");
    expect(SERVER).toContain("kicked: []");
  });

  it("refuses a NEW joiner past the cap, after the start, or after a kick -- and tells them", () => {
    const upsert = sliceBetween(SERVER, 'case "upsert-player": {', "break;");
    expect(upsert).toContain("if (at === -1) {");
    expect(upsert).toContain("existing.kicked?.includes(write.player.id)");
    expect(upsert).toContain('existing.status !== "waiting"');
    expect(upsert).toContain("existing.players.length >= roomSeatCap(existing)");
    expect(SERVER).toContain("code: ROOM_WRITE_REFUSED_CODE");
  });

  it("lets only the host kick, only while waiting, never themselves", () => {
    const kick = sliceBetween(SERVER, 'case "kick": {', "break;");
    expect(kick).toContain("actor !== existing.hostId");
    expect(kick).toContain('existing.status !== "waiting"');
    expect(kick).toContain("write.playerId === existing.hostId");
    expect(kick).toContain("kicked: [...(existing.kicked ?? []), write.playerId]");
    expect(SERVER).toContain("applyRoomWrite(frame.room, frame.write, roomDocActors.get(socket))");
  });

  it("lists only rooms that chose to be public, and pushes the list on every write", () => {
    expect(SERVER).toContain('doc.visibility !== "public") continue;');
    expect(SERVER).toContain('{ kind: "rooms", rooms: await sandboxRooms() }');
    expect(SERVER).toContain("await broadcastSandboxRooms();");
  });

  it("admits no spectator to a private game once dealt", () => {
    const hello = sliceBetween(SERVER, 'if (frame.kind === "hello") {', "sockets.set(socket, { room: frame.room, actor });");
    expect(hello).toContain('roomVisibility(privateDoc) === "private"');
    expect(hello).toContain("This is a private game and cannot be watched.");
  });
});

describe("the client reads them back (design note #1415)", () => {
  it("a join awaits the room's answer and shows a refusal on the lobby", () => {
    const lobby = readStripped("components/Lobby.tsx");
    expect(lobby).toContain("const answer = await joinSandboxRoom(code, {");
    expect(lobby).toContain("setSandboxRoomError(answer.reason);");
    expect(lobby).toContain("<HostSetupCard");
    expect(lobby).toContain("<JoinGameCard");
    const link = readStripped("utils/roomDocLink.ts");
    expect(link).toContain("export function joinRoomDoc(");
    expect(link).toContain("code === ROOM_WRITE_REFUSED_CODE && connection.refusals.size > 0");
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
    const app = readStripped("App.tsx");
    expect(app).toContain('if (sandboxRoom.status !== "waiting" || (sandboxRoom.kicked ?? []).includes(localId)) return;');
    expect(app).toContain("onKick={sandboxRoom?.hostId === localId ? handleKickSandboxPlayer : undefined}");
    expect(app).not.toContain("handleSetSandboxVariants");
  });

  it("the join card lists open and ongoing public games and disables a full table", () => {
    const card = readStripped("components/JoinGameCard.tsx");
    expect(card).toContain('room.status === "waiting"');
    expect(card).toContain('room.status === "playing"');
    expect(card).toContain("const full = room.players.length >= room.seatCap;");
    expect(card).toContain("A private game is joined by its code only, and cannot be watched.");
  });
});
