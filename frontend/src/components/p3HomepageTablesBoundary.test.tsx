/** @jest-environment jsdom */
//
// ==================================================================
//  PHASE 3 (P3-N028, REOPENED 2026-10-06): "YOUR TABLES" STARTS BELOW AN EXPLICIT BOUNDARY, IN NORMAL FLOW
// ==================================================================
//
// REPORTED AGAIN BY THE OWNER: "Your Tables" covering Host / Join. The first fix measured the doors and replayed their
// foot as a spacer's height; the boundary was a number that could be late or wrong. The rule now (see `Lobby.tsx`,
// "THE TOP REGION OWNS ITS HEIGHT"):
//   the top region (account corner, title, Host / Join) is a normal-flow block that owns its height;
//   an explicit boundary element follows it;
//   the tables region ("Your tables", its rows / error, the public list and its loading / empty states, the banners)
//   follows the boundary as a normal-flow sibling, and neither it nor anything between it and the shared column is
//   absolutely / fixed / sticky positioned, offset, transformed or pulled up by a negative margin.
//
// jsdom has no layout, so this pins the STRUCTURE that makes the geometry hold, in every state the homepage has; the
// geometry itself -- the first "Your tables" box at or below the doors' foot, at every window, zoom, text size and
// state, in every painted frame -- is checked in real Chromium by
// `docs/phase3/evidence/p3acct/homepage_tables_boundary.mjs` (it fails on the measured layout and passes on this one).

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { Lobby } from "./Lobby";
import { ModalLayerHost } from "./ModalPortal";
import { WalletProvider } from "../context/WalletContext";
import { installSessionPort, readySessionPort, type SessionPort } from "../utils/sessionBootstrap";
import { useMyTables, usePublicRooms, type MyTablesResult, type PublicRoomsResult } from "../utils/lobby";
import type { MyTableSummary, RoomSummary } from "../utils/roomProtocol";
import { readStripped } from "../utils/sourceScan";

jest.mock("../config/backend", () => ({ isBackendConfigured: () => true, backendConfigError: () => null }));
/* The two table data sources, stubbed: what the homepage is given, not how the socket fetched it. */
jest.mock("../utils/lobby", () => ({
  ...jest.requireActual("../utils/lobby"),
  useMyTables: jest.fn(),
  usePublicRooms: jest.fn(),
}));

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
global.IS_REACT_ACT_ENVIRONMENT = true;

const mockMyTables = useMyTables as jest.MockedFunction<typeof useMyTables>;
const mockPublicRooms = usePublicRooms as jest.MockedFunction<typeof usePublicRooms>;

const variants = { length: "standard", expandedMap: false, levelPlayingField: false, delayedAuction: false, gentleRust: false, unpredictableRevenue: false, dynamicStockMarket: false, plusTiles: false } as unknown as RoomSummary["variants"];
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
const gameId = (n: number) => `g_${Array.from({ length: 25 }, (_, i) => ALPHABET[(n * 7 + i * 13) % 32]).join("")}0`;
const rooms = (count: number): RoomSummary[] =>
  Array.from({ length: count }, (_, i) => ({
    gameId: gameId(100 + i),
    code: `JUNO-A${String.fromCharCode(65 + (i % 26))}A${i % 10}-BBB${Math.floor(i / 10)}`,
    status: i % 2 === 0 ? "waiting" : "playing",
    hostNickname: "Ann",
    nicknames: ["Ann", "Bea"],
    readyCount: 1,
    seated: 2,
    seatCap: 4,
    playerCount: null,
    variants,
    createdAtMs: 1_700_000_000_000 - i,
  }));
const tables = (count: number, long = false): MyTableSummary[] =>
  Array.from({ length: count }, (_, i) => ({
    gameId: gameId(i + 1),
    state: (["waiting", "playing", "resume"] as const)[i % 3],
    visibility: i % 2 === 0 ? "private" : "public",
    hostNickname: long ? `Baron_${"Vanderbilt".repeat(6)}` : "Brad",
    nicknames: long ? ["Brad", `Commodore_${"Gould".repeat(10)}`, "Jay Cooke and the Northern Pacific Syndicate"] : ["Brad", "Ann"],
    you: i === 0 ? "host" : "player",
    createdAtMs: 1_700_000_000_000,
    lastActivityMs: 1_700_000_100_000,
    ...(long ? { money: { anteGross: "1250000000", symbol: "JUNOX", exponent: 6, networkClass: "testnet" as const, status: "deposit" as const, actionNeeded: true } } : {}),
  }));

const signedOut: SessionPort = { ...readySessionPort(), account: null };

interface State {
  name: string;
  session: SessionPort;
  mine: MyTablesResult;
  list: PublicRoomsResult;
  /** Whether "Your tables" is expected on screen. */
  yourTables: boolean;
}
const STATES: State[] = [
  { name: "signed out (public list loading)", session: signedOut, mine: { tables: [], error: null }, list: { rooms: [], loading: true, error: null, available: true }, yourTables: false },
  { name: "signed out (public list)", session: signedOut, mine: { tables: [], error: null }, list: { rooms: rooms(6), loading: false, error: null, available: true }, yourTables: false },
  { name: "signed in, zero tables (empty list)", session: readySessionPort(), mine: { tables: [], error: null }, list: { rooms: [], loading: false, error: null, available: true }, yourTables: false },
  { name: "signed in, one table", session: readySessionPort(), mine: { tables: tables(1), error: null }, list: { rooms: rooms(3), loading: false, error: null, available: true }, yourTables: true },
  { name: "signed in, many tables", session: readySessionPort(), mine: { tables: tables(14), error: null }, list: { rooms: rooms(24), loading: false, error: null, available: true }, yourTables: true },
  { name: "signed in, tables error", session: readySessionPort(), mine: { tables: [], error: "Could not load your tables. Try again." }, list: { rooms: [], loading: false, error: "The list is unavailable.", available: true }, yourTables: true },
  { name: "signed in, long table metadata", session: readySessionPort(), mine: { tables: tables(4, true), error: null }, list: { rooms: rooms(2), loading: true, error: null, available: true }, yourTables: true },
];

let container: HTMLDivElement;
let root: Root;

function render(state: State) {
  installSessionPort(state.session);
  mockMyTables.mockReturnValue(state.mine);
  mockPublicRooms.mockReturnValue(state.list);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root.render(
      <>
        <WalletProvider>
          <Lobby onEnterSandbox={() => undefined} />
        </WalletProvider>
        <ModalLayerHost />
      </>,
    ),
  );
}

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  installSessionPort(null);
});

const byTestId = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

/** What may never appear on the tables region or on anything between it and the shared column. */
function flowProblems(el: HTMLElement): string[] {
  const s = el.style;
  const problems: string[] = [];
  const name = el.getAttribute("data-testid") ?? el.tagName.toLowerCase();
  if (["absolute", "fixed", "sticky"].includes(s.position)) problems.push(`${name}: position ${s.position}`);
  for (const side of ["marginTop", "marginBottom", "marginLeft", "marginRight", "margin"] as const) {
    if (/(^|\s|\()-\d/.test(s[side])) problems.push(`${name}: negative ${side} ${s[side]}`);
  }
  if (s.transform && s.transform !== "none") problems.push(`${name}: transform ${s.transform}`);
  if (s.translate) problems.push(`${name}: translate ${s.translate}`);
  for (const offset of ["top", "bottom", "inset"] as const) if (s[offset]) problems.push(`${name}: ${offset} ${s[offset]}`);
  return problems;
}

describe("P3-N028 (reopened): the tables region follows the top region in normal flow, after an explicit boundary", () => {
  it.each(STATES)("$name", (state) => {
    render(state);
    const top = byTestId("lobby-top");
    const actions = byTestId("lobby-actions");
    const boundary = byTestId("lobby-boundary");
    const region = byTestId("lobby-tables");
    expect(top).not.toBeNull();
    expect(actions).not.toBeNull();
    expect(boundary).not.toBeNull();
    expect(region).not.toBeNull();

    /* 1. THE TOP REGION OWNS THE CORNER, THE TITLE AND THE DOORS. */
    const buttons = Array.from(actions!.querySelectorAll("button")).map((b) => b.textContent?.trim());
    expect(buttons).toEqual(expect.arrayContaining(["Host game", "Join game"]));
    expect(top!.contains(actions)).toBe(true);
    expect(top!.contains(byTestId("lobby-rules"))).toBe(true);
    expect(top!.querySelector("h1")?.textContent).toBe("Project 18XX");

    /* 2. THE ORDER IS THE BOUNDARY: top region, then the boundary element, then the tables region -- adjacent
       siblings of one column, nothing between them. */
    const column = top!.parentElement!;
    expect(boundary!.parentElement).toBe(column);
    expect(region!.parentElement).toBe(column);
    expect(top!.nextElementSibling).toBe(boundary);
    expect(boundary!.nextElementSibling).toBe(region);
    expect(boundary!.childElementCount).toBe(0);

    /* 3. EVERY TABLE-RELATED BOX IS IN THE TABLES REGION, NONE IN THE TOP REGION, AND ALL COME AFTER THE DOORS. */
    const tableBoxes = Array.from(container.querySelectorAll<HTMLElement>('[data-testid="my-tables"], [data-testid="my-table-row"], [data-testid="my-table-money"], [data-testid="your-deposits"], [data-testid="lobby-public-games"], [data-testid="lobby-rooms-status"]'));
    expect(tableBoxes.length).toBeGreaterThan(0);
    for (const box of tableBoxes) {
      expect([box.getAttribute("data-testid"), region!.contains(box)]).toEqual([box.getAttribute("data-testid"), true]);
      expect(top!.contains(box)).toBe(false);
      expect(actions!.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(boundary!.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    const mine = byTestId("my-tables");
    if (state.yourTables) {
      expect(mine).not.toBeNull();
      expect(mine!.querySelector("h2")?.textContent).toBe("Your tables");
    } else {
      expect(mine).toBeNull();
    }

    /* 4. NOTHING LIFTS THE TABLES OUT OF THE FLOW: the boundary, the region, every element from the region down to each
       table box, and the column itself. */
    const problems: string[] = [...flowProblems(boundary!), ...flowProblems(column)];
    for (const box of tableBoxes) {
      for (let el: HTMLElement | null = box; el && el !== column; el = el.parentElement) problems.push(...flowProblems(el));
    }
    expect(Array.from(new Set(problems))).toEqual([]);

    /* 5. THE TOP REGION IS IN THE FLOW TOO, AND OWNS ITS HEIGHT: not positioned out of the column, no fixed height (a
       floor only), and the doors and the title are flow content inside it -- not absolute, not offset, not translated. */
    expect(["absolute", "fixed", "sticky"]).not.toContain(top!.style.position);
    expect(top!.style.height).toBe("");
    expect(top!.style.maxHeight).toBe("");
    expect(top!.style.overflow).toBe("");
    expect(top!.style.minHeight).toBe("var(--lobby-hero-window)");
    const title = top!.querySelector("h1")!.parentElement as HTMLElement;
    for (let el: HTMLElement | null = actions; el && el !== top; el = el.parentElement) expect([el.className, flowProblems(el)]).toEqual([el.className, []]);
    for (let el: HTMLElement | null = title; el && el !== top; el = el.parentElement) expect(flowProblems(el)).toEqual([]);

    /* 6. THE PHOTOGRAPH IS DECORATION: inside the top region, hidden from assistive tech, click-through, and holding no
       control, heading or table content. */
    const layers = Array.from(top!.children).filter((child) => (child as HTMLElement).style.position === "absolute") as HTMLElement[];
    expect(layers).toHaveLength(1);
    const [scene] = layers;
    expect(scene.getAttribute("aria-hidden")).toBe("true");
    expect(scene.style.pointerEvents).toBe("none");
    expect(scene.querySelector("button, a, input, h1, h2, section, li, [data-testid]")).toBeNull();
  });
});

describe("P3-N028 (reopened): nothing on the homepage is measured", () => {
  const LOBBY = readStripped("components/Lobby.tsx");
  it("has no observer, no client rect and no measured spacer", () => {
    expect(LOBBY).not.toContain("ResizeObserver");
    expect(LOBBY).not.toContain("getBoundingClientRect");
    expect(LOBBY).not.toContain("offsetHeight");
    expect(LOBBY).not.toContain("--lobby-hero-flow");
    expect(LOBBY).not.toContain("styles.heroFlow");
    expect(LOBBY).not.toContain('addEventListener("resize"');
  });

  it("keeps the table lists free of positioning that could lift them", () => {
    for (const file of ["components/MyTablesList.tsx", "components/LobbyRoomList.tsx"]) {
      const source = readStripped(file);
      expect([file, /position: "(absolute|fixed|sticky)"/.test(source)]).toEqual([file, false]);
      expect([file, /margin(Top)?: "-/.test(source)]).toEqual([file, false]);
      expect([file, /transform: "translate/.test(source)]).toEqual([file, false]);
    }
  });
});
