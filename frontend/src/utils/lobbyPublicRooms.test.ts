/** @jest-environment node */
// frontend/src/utils/lobbyPublicRooms.test.ts -- design note #1440.
//
// ==================================================================
//  THE TWO DOORS, AND WHICH FACTS EACH ONE IS ALLOWED TO KNOW
// ==================================================================
//
// #1415 built one door with both jobs behind it: a modal holding the public list AND the code box. #1440
// splits them along the line the feature always had -- a public room is something you FIND, a private room is
// something you were TOLD -- and the split is only worth anything if it cannot leak:
//
//   the LOBBY LIST may show only rooms the server chose to broadcast, and it has no visibility field to
//   filter on, which is exactly why the filtering has to stay where it is (the server);
//   the CODE DIALOG may hold no room summary at all, because a second rendering of a room is a second thing
//   to keep in step -- and because a private room in any list is the bug this whole arrangement prevents.
//
// The row actions are asked of the pure derivation rather than of a rendered tree, because the rules they
// encode are the SERVER's (a full table is refused, a dealt game takes no new seat) and a test that clicked a
// button would be testing React rather than the agreement.

import { readStripped } from "./sourceScan";
import { summariseSandboxRoom, type SandboxRoomSummary } from "./sandboxRoomSummary";
import { filterByPace, publicRoomRow, ruleTitlesFor, sortRooms } from "../components/LobbyRoomList";
import {
  BANK_SIZE_BY_LENGTH,
  GAME_LENGTH_BLURB,
  STANDARD_VARIANTS,
  bankSizeLabel,
  recommendedVariantsFor,
  withGameType,
  type GameLength,
  type GameMode,
  type GameVariants,
} from "../gameEngine/gameVariants";

const LIST = readStripped("components/LobbyRoomList.tsx");
const CARD = readStripped("components/JoinGameCard.tsx");
const LOBBY = readStripped("components/Lobby.tsx");
const HOST = readStripped("components/HostSetupCard.tsx");
const WAITING = readStripped("components/SandboxWaitingRoom.tsx");

const seat = (id: string, isReady = false) => ({ id, nickname: id, isReady });

function room(over: {
  code: string;
  status?: "waiting" | "playing";
  seats?: number;
  playerCount?: number | null;
  variants?: Partial<GameVariants>;
  anteUjuno?: string;
  createdAtMs?: number;
}): SandboxRoomSummary {
  const players = [];
  for (let index = 0; index < (over.seats ?? 1); index += 1) players.push(seat(`p${index}`, index === 0));
  return summariseSandboxRoom({
    code: over.code,
    status: over.status ?? "waiting",
    hostId: "p0",
    players,
    variants: { ...STANDARD_VARIANTS, ...over.variants },
    playerCount: over.playerCount ?? null,
    anteUjuno: over.anteUjuno ?? "0",
    createdAtMs: over.createdAtMs ?? 0,
  });
}

describe("public is browsed, private is told (design note #1440)", () => {
  it("keeps the list on the page and the code box in the dialog", () => {
    /* THE DIALOG'S SIDE IS ASSERTED AS AN ABSENCE, which is the only way this claim can be held: a card that
       merely "does not show" a list today is one prop away from showing one again. */
    expect(LOBBY).toContain("<LobbyRoomList");
    expect(LOBBY).toContain("rooms={sandboxRooms.rooms}");
    expect(CARD).not.toContain("SandboxRoomSummary");
    expect(CARD).not.toContain("rooms");
    expect(CARD).not.toContain("onSpectate");
    expect(CARD).not.toContain("join-tab-");
    // What the card keeps is the one thing a list cannot do.
    expect(CARD).toContain('data-testid="join-by-code"');
    expect(CARD).toContain('data-testid="rejoin-by-code"');
    expect(CARD).toContain("the code is their only door, and they cannot be watched");
  });

  it("leaves the visibility filter where the only copy of the fact lives", () => {
    /* THE SUMMARY HAS NO `visibility`, and that is deliberate (#1415): the server drops a private room before
       the frame is built, so a client-side filter would be a second opinion with no data behind it. This case
       exists so that a future reader who goes looking for the filter on this side finds the reason instead. */
    const summary = room({ code: "JUNO-1A1" });
    expect(Object.keys(summary)).not.toContain("visibility");
    expect(LIST).not.toContain("visibility");
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const server = fs.readFileSync(path.join(__dirname, "../../../server/src/gameServer.ts"), "utf8");
    expect(server).toContain('doc.visibility !== "public") continue;');
  });

  it("lets the picture fall into shadow rather than stop at a line", () => {
    /* The hero is bounded now (#1440), so without this the photograph ends on a hard edge across the barons'
       chests. The fade is on the CLIP because the crop line is the hero's; the scene runs past it. */
    expect(LOBBY).toContain('<div style={styles.heroFade} aria-hidden="true" />');
    expect(LOBBY).toContain("linear-gradient(rgba(8, 8, 8, 0), #080808)");
  });

  it("rejoin stays its own door, not a row in the list", () => {
    /* RULED: "Keep Rejoin Game / Rejoin Seat findable as a distinct returning-player path; do not make
       someone browse public rooms to reclaim a seat." Both survive: the bar's own PIN-first button (#1355)
       and the by-code rejoin inside the dialog (#1352). */
    expect(LOBBY).toContain("onRejoinByPin={roomDocOnServer() ? () => setRejoinByPin(true) : undefined}");
    expect(LOBBY).toContain("<RejoinByPinCard");
    expect(LIST).not.toContain("Rejoin");
  });
});

describe("a row offers what the server would allow (design note #1440)", () => {
  it("open tables take a seat; a full one says so as a fact rather than as a refusal", () => {
    const empty = publicRoomRow(room({ code: "JUNO-1A1", seats: 2 }));
    expect(empty.status).toBe("waiting");
    expect(empty.full).toBe(false);
    expect(empty.seated).toBe(2);
    expect(empty.seatCap).toBe(6);
    expect(empty.exactCount).toBe(false);

    const full = publicRoomRow(room({ code: "JUNO-1A2", seats: 6 }));
    expect(full.full).toBe(true);

    // "Exactly four" is a cap of four, so the fourth seat fills it.
    const exact = publicRoomRow(room({ code: "JUNO-1A3", seats: 4, playerCount: 4 }));
    expect(exact.seatCap).toBe(4);
    expect(exact.exactCount).toBe(true);
    expect(exact.full).toBe(true);
  });

  it("offers Watch on every public room, and Join on the one that can take a seat", () => {
    /* ==================================================================
        DESIGN NOTE 1441: THREE ROOMS, THREE ANSWERS
       ==================================================================
       RULED: an open room with a seat offers Join (primary) and Watch (secondary); a FULL open room offers
       Watch, with "Full" as status text rather than a disabled control; an ongoing room offers Watch.
       THE SERVER HAS ALWAYS ALLOWED ALL THREE. It refuses a SEAT past the cap and a SEAT after the deal, and
       refuses a WATCHER only for a private room after the deal -- which is the promise the Host card makes:
       "Anyone can join, and anyone can watch." */
    expect(publicRoomRow(room({ code: "JUNO-1B1", status: "playing", seats: 4 })).status).toBe("playing");
    // Join is drawn only for a waiting room that is not full; Watch is unconditional.
    expect(LIST).toContain('{row.status === "waiting" &&');
    expect(LIST).toContain("row.full ? (");
    expect(LIST).toContain("data-testid={`lobby-full-${row.code}`}");
    expect(LIST).toContain("data-testid={`lobby-join-${row.code}`}");
    expect(LIST).toContain("data-testid={`lobby-watch-${row.code}`}");
    // No disabled-because-full control survives: fullness gates whether Join is RENDERED, not whether it works.
    expect(LIST).not.toContain("disabled={busy || row.full}");
    expect(LIST).toContain("disabled={busy}");
    // The Watch button is outside the waiting branch, so every row has one.
    const watchAt = LIST.indexOf("data-testid={`lobby-watch-");
    const joinAt = LIST.indexOf("data-testid={`lobby-join-");
    expect(joinAt).toBeGreaterThan(-1);
    expect(watchAt).toBeGreaterThan(joinAt);
  });

  it("ranks the pair so a seat is not lost to the rail by accident", () => {
    /* Join is filled at 700; Watch is an outline at 600 in the muted ink. Asserted as the DIFFERENCE, since
       either one alone could drift into looking like the other. */
    const join = LIST.slice(LIST.indexOf("joinButton: {"));
    const watch = LIST.slice(LIST.indexOf("watchButton: {"));
    expect(join.slice(0, join.indexOf("},"))).toContain('backgroundColor: "#1d4030"');
    expect(join.slice(0, join.indexOf("},"))).toContain("fontWeight: 700");
    expect(watch.slice(0, watch.indexOf("},"))).toContain('backgroundColor: "transparent"');
    expect(watch.slice(0, watch.indexOf("},"))).toContain("fontWeight: 600");
    expect(watch.slice(0, watch.indexOf("},"))).toContain("INK_TEXT_MUTED");
  });

  it("holds the seat claim for a viewer who pressed Watch on a room still waiting", () => {
    /* ==================================================================
        #1415's INFERENCE EXPIRED WITH THE DOOR #1441 OPENED
       ==================================================================
       The shell claims a seat on arriving at a `waiting` room -- it decided who was a spectator from the
       room's STATUS, which was true of every door that existed then. Watch on an OPEN table is the first one
       it is wrong about, and without the flag the button would have seated the very player it invited to
       watch. Same path, told which of the two things it is. */
    const app = readStripped("App.tsx");
    /* Design note #1442: THE SEED IS THE ROOM, not a flag -- see the lifecycle cases below for why. */
    expect(app).toContain("sandboxWatchSeed?: string | null;");
    expect(app).toContain("sandboxWatchRoom === sandboxRoomCode ||");
    expect(app).toContain('sandboxRoom.status !== "waiting" ||');
    expect(app).toContain("(sandboxRoom.kicked ?? []).includes(localId)");
    expect(app).toContain("const handleEnterSandbox = useCallback((roomCode?: string | null, watchOnly?: boolean) => {");
    expect(app).toContain('sandboxWatchSeed={activeGame.mode === "sandbox" ? sandboxWatchRoom : null}');
    expect(LOBBY).toContain("onWatch={(code) => onEnterSandbox(code, true)}");
    // And the room they land in says why none of its controls are theirs.
    expect(readStripped("components/SandboxWaitingRoom.tsx")).toContain(
      "const isWatching = room !== null && me === null && !wasKicked;",
    );
    expect(readStripped("components/SandboxWaitingRoom.tsx")).toContain("You are watching this table.");
  });

  it("names the facts the room actually carries, and no others", () => {
    const row = publicRoomRow(
      room({
        code: "JUNO-1C1",
        seats: 3,
        anteUjuno: "1500000",
        variants: { mode: "async", length: "long", expandedMap: true, gentleRust: true },
      }),
    );
    expect(row.typeLabel).toBe("18XX+");
    expect(row.paceLabel).toBe("Async");
    expect(row.bankLabel).toBe("$20,000");
    expect(row.anteLabel).toBe("1.5 JUNO");
    expect(row.rules).toEqual(["Gentle Rust"]);
    // A playtest ante of zero is not a fact anybody chooses on; it is left out rather than printed 24 times.
    expect(publicRoomRow(room({ code: "JUNO-1C2" })).anteLabel).toBeNull();
  });

  it("does not name the tray the type already brings", () => {
    const lpf = withGameType(STANDARD_VARIANTS, "levelPlayingField");
    expect(lpf.plusTiles).toBe(true);
    expect(ruleTitlesFor(lpf)).not.toContain("18XX+ tiles");
    expect(ruleTitlesFor({ ...STANDARD_VARIANTS, plusTiles: true })).toContain("18XX+ tiles");
  });

  it("normalises the variants the server stored without checking", () => {
    /* `gameServer.ts` keeps `write.variants ?? STANDARD_VARIANTS` verbatim, so the one field this list
       formats as a NUMBER arrives unchecked -- and `BANK_SIZE_BY_LENGTH[nonsense].toLocaleString()` would
       throw on the front door. `resolveVariants` is the normaliser every replay already runs. */
    expect(LIST).toContain("resolveVariants(room.variants)");
    const bad = room({ code: "JUNO-1D1" });
    const wire = { ...bad, variants: { ...bad.variants, length: "enormous" as unknown as GameLength } };
    expect(publicRoomRow(wire).bankLabel).toBe("$12,000");
  });
});

describe("twenty-four rooms stay scannable (design note #1440)", () => {
  const rooms = [
    room({ code: "JUNO-A01", seats: 6, createdAtMs: 900 }),
    room({ code: "JUNO-A02", seats: 2, createdAtMs: 100 }),
    room({ code: "JUNO-A03", seats: 3, createdAtMs: 500, variants: { mode: "async" } }),
    room({ code: "JUNO-A04", status: "playing", seats: 4, createdAtMs: 700 }),
  ].map(publicRoomRow);

  it("filters on the one axis a room can be unusable on", () => {
    expect(filterByPace(rooms, "all")).toHaveLength(4);
    expect(filterByPace(rooms, "async").map((row) => row.code)).toEqual(["JUNO-A03"]);
    expect(filterByPace(rooms, "live").map((row) => row.code)).toEqual(["JUNO-A01", "JUNO-A02", "JUNO-A04"]);
  });

  it("sorts newest first, with the rows that cannot be acted on below", () => {
    /* The server builds the frame newest first (#1415) and that order is kept -- the one adjustment is that a
       full table, whose only button is disabled, does not get to lead the list. */
    expect(sortRooms(rooms).map((row) => row.code)).toEqual(["JUNO-A04", "JUNO-A03", "JUNO-A02", "JUNO-A01"]);
    // Pure: the caller's array is not reordered underneath it.
    expect(rooms.map((row) => row.code)).toEqual(["JUNO-A01", "JUNO-A02", "JUNO-A03", "JUNO-A04"]);
  });

  it("counts the rooms without claiming what they are waiting for", () => {
    /* #1441: "16 waiting for players" was wrong about three of them -- a full table waits for its host, not
       for players. The summary counts; joinability is said by the seat column, the Full status and the
       action, each of which is true of the row it sits on. */
    expect(LIST).toContain('title="Open"');
    expect(LIST).toContain('subtitle="waiting rooms"');
    expect(LIST).toContain('title="Under way"');
    expect(LIST).toContain('subtitle="games in progress"');
    expect(LIST).not.toContain("waiting for players");
    expect(LIST).toContain("<h2");
    expect(LIST).toContain("<h3");
  });

  it("adapts the row instead of shrinking a table, and cannot push the page sideways", () => {
    /* ==================================================================
        THE LESSON FROM #1436, APPLIED BEFORE IT COSTS A SECOND INVESTIGATION
       ==================================================================
       A grid track's default `min-width: auto` is the widest unbreakable thing in it, so a long host name or
       a four-rule game would widen the column and, with no scroller of its own, the PAGE. `minmax(0, ...)` on
       every flexible track plus `overflow-wrap` on the text is what holds it.
       AND THERE IS ONE MARKUP: `display: contents` lets the same five cells be grid tracks on the wide
       layout and a wrapping flex row on the narrow one, so the two shapes cannot drift. */
    expect(LIST).toContain("grid-template-columns: minmax(0, 1.7fr)");
    expect(LIST).toContain("grid-template-columns: minmax(0, 1fr) max-content;");
    expect(LIST).toContain(".lobby-rooms-facts { display: contents; }");
    expect(LIST).toContain("@media (max-width: 899px)");
    expect(LIST).toContain('overflowWrap: "anywhere"');
    // No fixed pixel width: a hard width is how a row stops fitting a 430px screen. (`100%` is not one.)
    expect(LIST).not.toMatch(/width: "\d+px"/);
    expect(LIST).not.toMatch(/minWidth: "\d+px"/);
    expect(LIST).not.toContain("overflowX");
  });

  it("says something honest in every state the subscription can be in", () => {
    for (const line of [
      "Looking for public games",
      "No public games right now. Host one, or join a private game by its code.",
    ]) {
      expect(LIST).toContain(line);
    }
    // The list's own failure is the server's sentence, not a swallowed empty state.
    expect(LIST).toContain("error: string | null;");
    /* #521a: with no game server the section is ABSENT, not a heading over an explanation of a build
       variable -- and the gate is inside the component so a caller cannot forget it. `SandboxRoomBar` says
       what this build cannot do, once, where the two doors would have been. */
    expect(LIST).toContain("if (!available) return null;");
    expect(readStripped("components/SandboxRoomBar.tsx")).toContain(
      "Sandbox multiplayer needs Firestore, which this build has not been configured with.",
    );
  });

  it("gives the row's one control a real target on a phone", () => {
    /* The desktop button is 25px tall, which is a mouse's problem and not a thumb's. At the narrow layout the
       row is already 73px, so the action can take a 44px target without moving anything. */
    expect(LIST).toContain("min-height: 44px;");
    expect(LIST).toContain(".lobby-rooms-filter { min-height: 32px; }");
    /* #1441: two controls in the cell now, so the narrow padding gives way before the target does -- and the
       padding override has to be `!important` to beat the button's inline shorthand. */
    expect(LIST).toContain("padding-left: 14px !important;");
    expect(LIST).toContain(".lobby-rooms-action { gap: 6px !important; }");
  });

  it("reports a refusal on the row it was asked from", () => {
    /* A join attempted eight hundred pixels down the page cannot answer beside the buttons at the top of it.
       `handleJoinSandboxRoom` returns the reason as well as setting the bar's error, so both callers can say
       it where the player is looking. */
    expect(LOBBY).toContain("async (raw: string): Promise<string | null> =>");
    expect(LOBBY).toContain("return answer.reason;");
    expect(LOBBY).toContain("setRoomRefusal(reason === null ? null : { code, reason });");
    expect(LIST).toContain("refusal.code === row.code");
  });
});

describe("one bank, named once (design note #1440)", () => {
  it("opens every blurb with the amount the table holds", () => {
    /* THE EXPORTED CONTRADICTION WAS A CAPTURE ARTEFACT -- React sets a `<select>`'s value as a DOM property
       and `outerHTML` does not serialise it, so a static export shows the first option whatever was chosen.
       WHAT WAS REAL is that the sentence's digits were hand-typed with nothing reading them back, which no
       test could have caught: a wrong "$12,000" is only wrong relative to a number in another file. */
    const lengths: readonly GameLength[] = ["short", "standard", "long"];
    for (const length of lengths) {
      expect(bankSizeLabel(length)).toBe(`$${BANK_SIZE_BY_LENGTH[length].toLocaleString("en-US")}`);
      expect(GAME_LENGTH_BLURB[length].startsWith(`${bankSizeLabel(length)} bank.`)).toBe(true);
    }
    expect(bankSizeLabel("standard")).toBe("$12,000");
    expect(GAME_LENGTH_BLURB.standard).toBe("$12,000 bank. The standard game, as printed.");
  });

  it("gives the option, the helper and the waiting room's terms the same read", () => {
    expect(HOST).toContain("{bankSizeLabel(length)}");
    expect(HOST).toContain("{GAME_LENGTH_BLURB[variants.length]}");
    expect(WAITING).toContain("value={bankSizeLabel(variants.length)}");
    /* `toLocaleString()` with no locale renders "12.000" on a German browser -- the same bank, a different
       number in the reader's own notation, on two screens that must agree. */
    expect(WAITING).not.toContain("toLocaleString()");
    expect(HOST).not.toContain("toLocaleString()");
  });

  it("never selects a length the control cannot display", () => {
    /* The select offers exactly three options; a `variants.length` outside them would leave the browser
       showing the first one -- the shape the exported contradiction LOOKED like. The two writers of that
       field are the standard defaults and the type's recommendation. */
    const options: readonly GameLength[] = ["short", "standard", "long"];
    expect(options).toContain(STANDARD_VARIANTS.length);
    expect(STANDARD_VARIANTS.length).toBe("standard");
    const modes: readonly GameMode[] = ["live", "async"];
    for (const mode of modes) {
      for (const type of ["standard", "plus", "levelPlayingField"] as const) {
        expect(options).toContain(recommendedVariantsFor(type, mode).length);
      }
    }
    expect(recommendedVariantsFor("levelPlayingField", "live").length).toBe("long");
    expect(recommendedVariantsFor("standard", "live").length).toBe("standard");
  });
});

describe("the three doors fit the window (design note #1441)", () => {
  /* ==================================================================
      REPORTED: at 430 "Host game begins outside the viewport and Rejoin game is cut off"
     ==================================================================
     THE ROW IS ANCHORED IN THE SCENE, AND THE SCENE IS NOT THE WINDOW. #1131 hung it on the photograph on
     purpose -- 60% of a box centred at 0.5 is the table on every aspect -- but the scene is `cover`, so on a
     tall narrow window it is 1669px wide against a 430px viewport and "60% of the picture" starts 285px to
     the left of the screen. Measured before the fix: Host game at x −34.7, Rejoin game ending at 464.7.
     THE CONVERSION IS EXACT, NOT AN ESTIMATE. The scene's left edge sits `(sceneW − viewportW) / 2` outside
     the window, which in this box's own percentages is `50% − 50vw` -- the same "put both sides in one
     space" move #1144 made for the cover arithmetic itself. */
  it("re-hangs the action row on the viewport at narrow widths, and only there", () => {
    expect(LOBBY).toContain('"--lobby-actions-left": `calc(50% - ${50 / scale}vw + 16px)`');
    expect(LOBBY).toContain('"--lobby-actions-width": `calc(${100 / scale}vw - 32px)`');
    expect(LOBBY).toContain('<div className="lobby-table-anchor" style={styles.tableAnchor}>');
    expect(LOBBY).toContain("left: var(--lobby-actions-left) !important;");
    expect(LOBBY).toContain("width: var(--lobby-actions-width) !important;");
    // The authored desktop position is untouched -- #1131's coordinates still read as written.
    expect(LOBBY).toContain('left: "20%"');
    expect(LOBBY).toContain('width: "60%"');
    expect(LOBBY).toContain('top: "70%"');
  });

  it("needs `!important`, because an inline length outranks an ordinary rule", () => {
    /* #46's exception says a stylesheet carries what an inline style cannot express, and a media query is on
       that list. What it did not have to say before is that the two are not peers: `styles.tableAnchor` is an
       inline declaration, so the narrow layout needs the one form of rule that can win against it. This case
       exists because a later tidy-up that "removes the shouty !important" would silently restore the bug. */
    for (const rule of [
      "left: var(--lobby-actions-left) !important;",
      "width: var(--lobby-actions-width) !important;",
    ]) {
      expect(LOBBY).toContain(rule);
    }
    const bar = readStripped("components/SandboxRoomBar.tsx");
    expect(bar).toContain(".sandbox-bare-bar { flex-wrap: wrap !important; gap: 10px !important; }");
    expect(bar).toContain(".sandbox-bare-btn { padding-left: 16px !important; padding-right: 16px !important; }");
    expect(bar).toContain('className={bare ? "sandbox-bare-bar" : undefined}');
  });

  it("spends the padding rather than the type, and wraps rather than clipping", () => {
    /* #1165 put the presence in the padding and not in the font ("the type stays on the scale"), so the
       padding is what a narrow window may spend. The 16px type and the 45px control height do not move, and
       a label that still will not fit takes a second line instead of going off the screen. */
    const bar = readStripped("components/SandboxRoomBar.tsx");
    const button = bar.slice(bar.indexOf("bareButton: {"));
    const body = button.slice(0, button.indexOf("\n  },"));
    expect(body).toContain("fontSize: FONT_SIZE.heading");
    expect(body).toContain('padding: "13px 30px"');
    expect(bar).toContain("flex-wrap: wrap !important");
    // The desktop rule #1136 wrote is kept: the inline form must not reflow under the button that opened it.
    expect(bar).toContain('flexWrap: "nowrap"');
  });

  it("keeps every CSS block free of the character that would end it", () => {
    /* Three of this pass's four build failures were one backtick inside a template literal -- twice in prose
       quoting a CSS keyword. The rule is older than this batch; the tripwire is not. */
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    for (const [file, marker] of [
      ["components/Lobby.tsx", "const LOBBY_CSS = `"],
      ["components/LobbyRoomList.tsx", "const LOBBY_ROOMS_CSS = `"],
      ["components/SandboxRoomBar.tsx", "const BARE_BUTTON_CSS = `"],
    ] as const) {
      const raw = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
      const start = raw.indexOf(marker) + marker.length;
      const end = raw.indexOf("\n`;", start);
      expect([file, raw.slice(start, end).includes("`")]).toEqual([file, false]);
    }
  });
});
