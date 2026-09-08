// Design note #1300: one board is in effect, and it is the state's board.
//
// Three properties, each the failure it guards against:
//   1. `withBoard` RESTORES -- a reducer arm that threw would otherwise leave the wrong board in effect for
//      the next room the server dispatches.
//   2. `boardMemo` NEVER SERVES THE OTHER BOARD'S ANSWER -- a cache keyed on anything but the board object
//      is a module-load constant with extra steps.
//   3. NO MODULE-SCOPE DERIVATION OVER A BOARD TABLE -- `const X = new Set(STATIC_BOARD_HEXES...)` captures
//      whichever board was in effect when the module loaded, silently, for the life of the process.

import * as fs from "fs";
import * as path from "path";
import {
  STANDARD_BOARD,
  STATIC_BOARD_HEXES,
  activateBoard,
  boardInEffect,
  boardMemo,
  withBoard,
  type BoardDefinition,
} from "../components/hexBoardData";
import { EXPANDED_BOARD } from "../components/hexBoardDataPlus";
import { boardFor } from "./boardSelection";
import { STANDARD_VARIANTS, resolveVariants } from "./gameVariants";
import { isBoardHex } from "../components/hexGeometry";

const OTHER: BoardDefinition = { ...STANDARD_BOARD, id: "expanded", hexes: STANDARD_BOARD.hexes.slice(0, 3) };

describe("the board in effect (design note #1300)", () => {
  afterEach(() => activateBoard(STANDARD_BOARD));

  it("defaults to 1830, and the standard variants select it", () => {
    expect(boardInEffect()).toBe(STANDARD_BOARD);
    expect(boardFor(STANDARD_VARIANTS)).toBe(STANDARD_BOARD);
    expect(boardFor(resolveVariants({}))).toBe(STANDARD_BOARD);
    expect(boardFor(resolveVariants({ expandedMap: true }))).toBe(EXPANDED_BOARD);
  });

  it("moves the live bindings with the board, and back", () => {
    const before = STATIC_BOARD_HEXES;
    const seen = withBoard(OTHER, () => STATIC_BOARD_HEXES);
    expect(seen).toBe(OTHER.hexes);
    expect(seen).not.toBe(before);
    expect(STATIC_BOARD_HEXES).toBe(before);
    expect(boardInEffect()).toBe(STANDARD_BOARD);
  });

  it("restores the previous board even when the scoped work throws", () => {
    expect(() =>
      withBoard(OTHER, () => {
        throw new Error("an arm failed");
      }),
    ).toThrow("an arm failed");
    expect(boardInEffect()).toBe(STANDARD_BOARD);
  });

  it("nests: an inner scope restores the OUTER board, not the default", () => {
    withBoard(OTHER, () => {
      withBoard(STANDARD_BOARD, () => expect(boardInEffect()).toBe(STANDARD_BOARD));
      expect(boardInEffect()).toBe(OTHER);
    });
  });

  it("memoises per board object and never crosses them", () => {
    let builds = 0;
    const count = boardMemo((board) => {
      builds += 1;
      return board.hexes.length;
    });
    expect(count()).toBe(STANDARD_BOARD.hexes.length);
    expect(count()).toBe(STANDARD_BOARD.hexes.length);
    expect(builds).toBe(1);
    expect(withBoard(OTHER, count)).toBe(3);
    expect(builds).toBe(2);
    expect(count()).toBe(STANDARD_BOARD.hexes.length);
    expect(builds).toBe(2);
  });

  it("reaches a helper that used to read a module-load constant", () => {
    // `isBoardHex` was `BOARD_COORD_KEYS.has(...)` over a Set built at import time.
    const [a, b, c] = OTHER.hexes;
    const missing = STANDARD_BOARD.hexes[10];
    expect(isBoardHex(missing.q, missing.r)).toBe(true);
    withBoard(OTHER, () => {
      expect(isBoardHex(a.q, a.r)).toBe(true);
      expect(isBoardHex(b.q, b.r)).toBe(true);
      expect(isBoardHex(c.q, c.r)).toBe(true);
      expect(isBoardHex(missing.q, missing.r)).toBe(false);
    });
    expect(isBoardHex(missing.q, missing.r)).toBe(true);
  });
});

describe("no module-scope derivation over a board table", () => {
  const TABLES =
    "STATIC_BOARD_HEXES|GRAY_HEXES|OFFBOARD_LABELS|OFFBOARD_TRACKS|OFFBOARD_REVENUE|OFFBOARD_HIDDEN_EDGES|" +
    "NAMED_HEX_LABELS|HEX_START_VALUE_OVERRIDE|YELLOW_OO_HEXES|TO_HEXES|LANDMARK_HEXES|LANDMARK_TRACKS|IMPASSABLE_BORDER_EDGES";
  const TOP_LEVEL_DERIVATION = new RegExp(`^(export )?(const|let) [^=]+=[^;]*\\b(${TABLES})\\b`, "m");

  function sourceFiles(dir: string): string[] {
    return fs.readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) return sourceFiles(full);
      if (!/\.(ts|tsx)$/.test(name) || /\.test\.tsx?$/.test(name)) return [];
      return [full];
    });
  }

  it("finds only the module that owns the tables", () => {
    const src = path.join(__dirname, "..");
    const offenders = sourceFiles(src).filter((file) => {
      if (file.endsWith("hexBoardData.ts")) return false;
      const text = fs
        .readFileSync(file, "utf8")
        // Strip comments so a design note quoting the old shape is not a hit.
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      // Only lines at column 0 are module scope; a derivation inside a function or a `boardMemo(...)`
      // callback is indented.
      return TOP_LEVEL_DERIVATION.test(text);
    });
    expect(offenders.map((file) => path.relative(src, file))).toEqual([]);
  });
});
