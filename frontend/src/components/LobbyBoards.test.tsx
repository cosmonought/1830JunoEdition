// frontend/src/components/LobbyBoards.test.tsx -- PLAY LOBBY (approved design, "play-lobby-handoff"), rendered.
//
// The two boards over Play's real public list shape: the order (oldest first; a newer table at the bottom; a change
// never moves a row), Play's Join / Watch rules and their handlers, the refusal on its row, the edition and mode filters
// (radio groups) over both boards, the Under way fold, the seated list (a labelled dialog: names, host, funding, open
// seats, the public history on a tap, Escape closes and focus returns), and the departure -- held, folded, moved --
// with reduced motion moving it at once.

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { LobbyBoards, DEPART_FOLD_MS, DEPART_HOLD_MS } from "./LobbyBoards";
import { STANDARD_VARIANTS, withGameType } from "../gameEngine/gameVariants";
import type { RoomSummary } from "../utils/roomProtocol";
import type { PublicSeatHistory } from "../utils/lobbyBoard";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
global.IS_REACT_ACT_ENVIRONMENT = true;

const T = Date.UTC(2026, 9, 10, 6, 0);
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
const gid = (n: number) => `g_${Array.from({ length: 25 }, (_, i) => ALPHABET[(n * 7 + i * 13) % 32]).join("")}0`;
const stake = { anteGross: "10000000", symbol: "JUNOX", exponent: 6, networkClass: "testnet" as const, funded: 1, seats: 4 };

const room = (n: number, over: Partial<RoomSummary> = {}): RoomSummary => ({
  gameId: gid(n),
  code: `JUNO-AAAA-BB${String.fromCharCode(65 + n)}${n % 10}`,
  status: "waiting",
  hostNickname: `Host${n}`,
  nicknames: [`Host${n}`, `Guest${n}`],
  readyCount: 0,
  seated: 2,
  seatCap: 6,
  playerCount: 4,
  variants: STANDARD_VARIANTS,
  createdAtMs: T + n * 60_000,
  hostSeat: 0,
  stake: { ...stake, seatFunded: [true, false] },
  ...over,
});

let container: HTMLDivElement;
let root: Root;
const calls = { join: [] as string[], watch: [] as string[], players: [] as string[] };
let players: (gameId: string) => Promise<PublicSeatHistory[] | null>;

function render(rooms: RoomSummary[], extra: Partial<React.ComponentProps<typeof LobbyBoards>> = {}) {
  act(() =>
    root.render(
      <LobbyBoards
        rooms={rooms}
        loading={false}
        error={null}
        available
        busy={false}
        refusal={null}
        onJoin={(code) => calls.join.push(code)}
        onWatch={(gameId) => calls.watch.push(gameId)}
        noAnteSeats={false}
        readPlayers={(gameId) => {
          calls.players.push(gameId);
          return players(gameId);
        }}
        {...extra}
      />,
    ),
  );
}
const q = (sel: string) => container.querySelector(sel) as HTMLElement | null;
const qa = (sel: string) => Array.from(container.querySelectorAll(sel)) as HTMLElement[];
const byTestId = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const departureCodes = () => qa('[data-testid="lobby-group-open"] > li.lb-row').map((li) => li.dataset.testid);
const underCodes = () => qa('[data-testid="lobby-group-ongoing"] li.lb-row').map((li) => li.dataset.testid);
const settle = async () => {
  await act(async () => {
    for (let n = 0; n < 20; n += 1) await Promise.resolve();
  });
};

function setReducedMotion(on: boolean) {
  window.matchMedia = ((query: string) => ({ matches: on && query.includes("reduce"), media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
}

beforeEach(() => {
  jest.useFakeTimers();
  setReducedMotion(true);
  calls.join = [];
  calls.watch = [];
  calls.players = [];
  players = async () => [
    { seat: 0, name: "Host1", host: true, history: { completed: 47, firstMonth: "2025-05", wins: 13, places: { first: 13, second: 12, third: 11, rest: 11 }, placed: 47, recent: [{ endedOn: "2026-10-09", edition: "standard", place: 2, of: 4 }] } },
    { seat: 1, name: "Guest1", host: false, history: { completed: 0, firstMonth: null, wins: 0, places: { first: 0, second: 0, third: 0, rest: 0 }, placed: 0, recent: [] } },
  ];
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  jest.useRealTimers();
});

describe("the two boards", () => {
  it("Departures oldest first, Under way by start; counts; a newer table joins the bottom and a change moves nothing", () => {
    render([room(3), room(1), room(2, { status: "playing", startedAtMs: T + 99 * 60_000 }), room(4, { status: "playing", startedAtMs: T + 5 * 60_000 })]);
    expect(departureCodes()).toEqual(["lobby-room-JUNO-AAAA-BBB1", "lobby-room-JUNO-AAAA-BBD3"]);
    expect(underCodes()).toEqual(["lobby-room-JUNO-AAAA-BBE4", "lobby-room-JUNO-AAAA-BBC2"]);
    expect(byTestId("lobby-rooms-count")?.textContent).toBe("2 tables");
    expect(byTestId("lobby-under-count")?.textContent).toBe("2 games");
    render([room(3, { seated: 3, nicknames: ["Host3", "Guest3", "Third"] }), room(1), room(5)]);
    expect(departureCodes()).toEqual(["lobby-room-JUNO-AAAA-BBB1", "lobby-room-JUNO-AAAA-BBD3", "lobby-room-JUNO-AAAA-BBF5"]);
  });

  it("each row: edition, bank, host, mode, variants; seats as n/cap; the ante and funding; the status word", () => {
    render([room(1, { variants: withGameType({ ...STANDARD_VARIANTS, mode: "async", gentleRust: true } as typeof STANDARD_VARIANTS, "plus"), clock: { deadline: "async-pace", paceSecs: 86_400 } })]);
    const row = byTestId("lobby-room-JUNO-AAAA-BBB1")!;
    expect(row.querySelector(".lb-nm")?.textContent).toBe("18XX+");
    expect(row.querySelector(".lb-bank")?.textContent).toBe("(Standard)");
    expect(row.querySelector(".lb-meta")?.textContent).toBe("HostHost1ModeAsync: 24h");
    expect(row.textContent).toContain("Gentle Rust");
    expect(row.querySelector(".lb-ante")?.textContent).toBe("Ante10 JUNOX1/4 funded");
    expect(byTestId("lobby-seats-JUNO-AAAA-BBB1")?.getAttribute("aria-label")).toBe("2 of 4 seats taken. Show who is seated.");
    expect(byTestId("lobby-status-JUNO-AAAA-BBB1")?.textContent).toContain("Boarding");
  });

  it("Join where Play allows it (a free anted seat), Watch always -- through the Lobby's own handlers, naming the table", () => {
    render([room(1), room(2, { stake: undefined }), room(3, { seated: 4, nicknames: ["a", "b", "c", "d"] }), room(4, { status: "playing" })]);
    expect(byTestId("lobby-join-JUNO-AAAA-BBB1")?.getAttribute("aria-label")).toBe("Join 18XX, hosted by Host1");
    expect(byTestId("lobby-join-JUNO-AAAA-BBC2")).toBeNull();
    expect(byTestId("lobby-no-ante-JUNO-AAAA-BBC2")?.textContent).toBe("Watch only");
    expect(byTestId("lobby-join-JUNO-AAAA-BBD3")).toBeNull();
    expect(byTestId("lobby-full-JUNO-AAAA-BBD3")?.textContent).toContain("Full");
    expect(byTestId("lobby-join-JUNO-AAAA-BBE4")).toBeNull();
    for (const code of ["BBB1", "BBC2", "BBD3", "BBE4"]) expect(byTestId(`lobby-watch-JUNO-AAAA-${code}`)).toBeTruthy();
    act(() => byTestId("lobby-join-JUNO-AAAA-BBB1")!.click());
    act(() => byTestId("lobby-watch-JUNO-AAAA-BBE4")!.click());
    expect(calls.join).toEqual(["JUNO-AAAA-BBB1"]);
    expect(calls.watch).toEqual([gid(4)]);
    render([room(1)], { refusal: { code: "JUNO-AAAA-BBB1", reason: "That table is full." } });
    expect(byTestId("lobby-refusal-JUNO-AAAA-BBB1")?.textContent).toBe("That table is full.");
    render([room(1)], { busy: true });
    expect((byTestId("lobby-join-JUNO-AAAA-BBB1") as HTMLButtonElement).disabled).toBe(true);
  });

  it("the edition and mode filters are radio groups and apply to both boards; Under way folds", () => {
    const async = { ...STANDARD_VARIANTS, mode: "async" as const };
    render([room(1), room(2, { variants: withGameType(STANDARD_VARIANTS, "plus") }), room(3, { status: "playing", variants: async })]);
    const plus = byTestId("lobby-edition-plus")!;
    expect(plus.getAttribute("role")).toBe("radio");
    expect(plus.closest('[role="radiogroup"]')?.getAttribute("aria-label")).toBe("Edition");
    act(() => plus.click());
    expect(plus.getAttribute("aria-checked")).toBe("true");
    expect(departureCodes()).toEqual(["lobby-room-JUNO-AAAA-BBC2"]);
    expect(underCodes()).toEqual([]);
    act(() => byTestId("lobby-edition-all")!.click());
    act(() => byTestId("lobby-pace-async")!.click());
    expect(departureCodes()).toEqual([]);
    expect(underCodes()).toEqual(["lobby-room-JUNO-AAAA-BBD3"]);
    expect(q('[data-testid="lobby-rooms-empty"]')?.textContent).toBe("No tables taking seats match these filters.");
    const toggle = byTestId("lobby-under-toggle")!;
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    act(() => toggle.click());
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.textContent).toBe("Show");
    expect(q('[data-testid="lobby-group-ongoing"]')?.getAttribute("data-open")).toBe("false");
  });

  it("empty: the design's sentences", () => {
    render([]);
    expect(byTestId("lobby-rooms-empty")?.textContent).toBe("No tables taking seats right now. Host one, or join a private game by its code.");
    expect(container.textContent).toContain("No games under way.");
  });
});

describe("the seated list", () => {
  it("a labelled dialog: seated n of cap, the funding total, host and funding per seat, open seats; Escape closes, focus returns", async () => {
    render([room(1)]);
    const seats = byTestId("lobby-seats-JUNO-AAAA-BBB1")!;
    expect(seats.getAttribute("aria-haspopup")).toBe("dialog");
    act(() => seats.click());
    await settle();
    const dialog = byTestId("lobby-seated")!;
    expect(dialog.getAttribute("role")).toBe("dialog");
    expect(document.getElementById(dialog.getAttribute("aria-labelledby")!)?.textContent).toContain("Seated · 2 of 4");
    expect(seats.getAttribute("aria-expanded")).toBe("true");
    expect(dialog.textContent).toContain("Antes funded1 of 4 seats · 10 of 40 JUNOX");
    expect(byTestId("lobby-seated-0")?.textContent).toBe("Host1hostante paid");
    expect(byTestId("lobby-seated-1")?.textContent).toBe("Guest1not funded");
    expect(Array.from(dialog.querySelectorAll("li.lb-open")).map((li) => li.textContent)).toEqual(["Open seat", "Open seat"]);
    expect(calls.players).toEqual([gid(1)]);
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(byTestId("lobby-seated")).toBeNull();
    expect(document.activeElement).toBe(seats);
  });

  it("a name opens that player's public history in place -- the approved facts only; none: 'No completed games yet.'", async () => {
    render([room(1)]);
    act(() => byTestId("lobby-seats-JUNO-AAAA-BBB1")!.click());
    await settle();
    act(() => byTestId("lobby-seated-0")!.click());
    act(() => byTestId("lobby-seated-1")!.click());
    const histories = Array.from(document.querySelectorAll('[data-testid="lobby-history"]')).map((el) => el.textContent);
    expect(histories[0]).toBe("Public game history47 completed games since May 202513 winsStandings1st ×132nd ×123rd ×114th or lower ×11Recent results9 Oct18XX2nd of 4");
    expect(histories[1]).toBe("Public game historyNo completed games yet.");
    expect(byTestId("lobby-seated-0")?.getAttribute("aria-expanded")).toBe("true");
    const text = byTestId("lobby-seated")!.textContent ?? "";
    for (const never of ["username", "wallet", "juno1", "since 2025-", "dispute", "Member since"]) expect(text).not.toContain(never);
  });

  it("an any-count table says seats stay open; a game under way: 'Playing · n' and the ante total; a failed read says so", async () => {
    players = async () => null;
    render([room(1, { playerCount: null }), room(2, { status: "playing", seated: 3, nicknames: ["a", "b", "c"], stake: { ...stake, funded: 3, seats: 3 } })]);
    act(() => byTestId("lobby-seats-JUNO-AAAA-BBB1")!.click());
    await settle();
    expect(byTestId("lobby-seated")?.textContent).toContain("Seats stay open until the host starts. Up to 6.");
    act(() => byTestId("lobby-seated-0")!.click());
    expect(byTestId("lobby-seated")?.textContent).toContain("Could not be read just now.");
    act(() => byTestId("lobby-seats-JUNO-AAAA-BBC2")!.click());
    await settle();
    const dialog = byTestId("lobby-seated")!;
    expect(dialog.textContent).toContain("Playing · 3");
    expect(dialog.textContent).toContain("Antes10 JUNOX × 3 seats = 30 JUNOX");
    expect(dialog.textContent).not.toContain("not funded");
  });
});

describe("a table that starts", () => {
  it("flaps to UNDER WAY, holds, folds, and joins the bottom of Under way (motion)", () => {
    setReducedMotion(false);
    render([room(1), room(2), room(9, { status: "playing", startedAtMs: T })]);
    render([room(1, { status: "playing", startedAtMs: T + 60 * 60_000 }), room(2), room(9, { status: "playing", startedAtMs: T })]);
    expect(departureCodes()).toEqual(["lobby-room-JUNO-AAAA-BBB1", "lobby-room-JUNO-AAAA-BBC2"]);
    expect(byTestId("lobby-join-JUNO-AAAA-BBB1")).toBeNull();
    expect(byTestId("lobby-status-JUNO-AAAA-BBB1")?.textContent).toContain("Under way");
    expect(underCodes()).toEqual(["lobby-room-JUNO-AAAA-BBJ9"]);
    act(() => jest.advanceTimersByTime(DEPART_HOLD_MS));
    expect(byTestId("lobby-room-JUNO-AAAA-BBB1")?.classList.contains("lb-leaving")).toBe(true);
    act(() => jest.advanceTimersByTime(DEPART_FOLD_MS));
    expect(departureCodes()).toEqual(["lobby-room-JUNO-AAAA-BBC2"]);
    expect(underCodes()).toEqual(["lobby-room-JUNO-AAAA-BBJ9", "lobby-room-JUNO-AAAA-BBB1"]);
  });

  it("reduced motion: it simply moves", () => {
    setReducedMotion(true);
    render([room(1), room(2)]);
    render([room(1, { status: "playing", startedAtMs: T }), room(2)]);
    expect(departureCodes()).toEqual(["lobby-room-JUNO-AAAA-BBC2"]);
    expect(underCodes()).toEqual(["lobby-room-JUNO-AAAA-BBB1"]);
  });
});
