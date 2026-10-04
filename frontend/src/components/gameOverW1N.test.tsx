/** @jest-environment jsdom */
//
// ==================================================================
//  W1-N (harness): GAME OVER, ROOM CLOSE AND LOG EXPORT
// ==================================================================
//
// H-06 (AUD-12.04) every tied first place is a WINNER, ranking unchanged · A-12 (AUD-18.01) Leave goes to the
// Lobby · A-11 (AUD-18.03) Close Room reads the LIVE board, not the scrubbed one · A-10 (AUD-18.02) the close
// deadline is the server's game-end stamp · AUD-01.09 a visible "Copy game log" in the top bar and on the crash
// screen. (K-24's no-op payout and the deadline helper are pinned in `utils/closeRoomPayout.test.ts`.)
//
// NOT HERE, ON PURPOSE: the `settleRoomPayout(...)` call site inside `runGameplayAction`'s apply half (RED R2) is
// untouched -- deleting it needs owner decision OD-12. `shellMessageArms.test.ts` still pins it, once.

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { ModalLayerHost } from "./ModalPortal";
import GameOverModal from "./GameOverModal";
import { CrashScreen } from "./CrashScreen";
import { rankPlayers, type PlayerStanding } from "../gameEngine/endgame";
import { setGameLogExportSource } from "../utils/gameLogExportSource";
import { readShell, readStripped, sliceBetween } from "../utils/sourceScan";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
global.IS_REACT_ACT_ENVIRONMENT = true;

const row = (over: Partial<PlayerStanding>): PlayerStanding => ({
  address: "0xa",
  label: "Ann",
  cash: 100,
  stockValue: 400,
  privateValue: 0,
  netWorth: 500,
  rank: 1,
  isWinner: false,
  isBankrupt: false,
  ...over,
});

let layerHost: HTMLDivElement;
let layerRoot: Root;
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  layerHost = document.createElement("div");
  document.body.appendChild(layerHost);
  layerRoot = createRoot(layerHost);
  act(() => layerRoot.render(<ModalLayerHost />));
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  act(() => layerRoot.unmount());
  host.remove();
  layerHost.remove();
  setGameLogExportSource(null);
  jest.restoreAllMocks();
});

function renderGameOver(standings: PlayerStanding[], viewerAddress: string | null) {
  act(() =>
    root.render(
      <GameOverModal
        reason="bank-broken"
        standings={standings}
        viewerAddress={viewerAddress}
        bankruptLabel={null}
        onDismiss={() => undefined}
        onCloseRoom={() => undefined}
        autoCloseIn={null}
        roomClosed={false}
      />,
    ),
  );
}

const winnerBadges = () =>
  Array.from(document.querySelectorAll('[role="row"]')).filter((el) => /WINNER/.test(el.textContent ?? ""));

describe("H-06: every first place is a WINNER; the ranking is unchanged", () => {
  it("badges both tied rows, and only them", () => {
    renderGameOver(
      [
        row({ address: "0xa", label: "Ann", rank: 1, isWinner: true }),
        row({ address: "0xb", label: "Bo", rank: 1, isWinner: false }),
        row({ address: "0xc", label: "Cy", rank: 3, netWorth: 200 }),
      ],
      "0xb",
    );
    const winners = winnerBadges().map((el) => el.textContent ?? "");
    expect(winners).toHaveLength(2);
    expect(winners.some((text) => text.includes("Ann"))).toBe(true);
    expect(winners.some((text) => text.includes("Bo"))).toBe(true);
    // The tied player who did NOT sort first is told they won too.
    expect(document.body.textContent).toContain("You Won! (tied for 1st)");
  });

  it("a sole winner reads as before", () => {
    renderGameOver([row({ address: "0xa", rank: 1, isWinner: true }), row({ address: "0xb", label: "Bo", rank: 2, netWorth: 300 })], "0xa");
    expect(winnerBadges()).toHaveLength(1);
    expect(document.body.textContent).toContain("You Won!");
    expect(document.body.textContent).not.toContain("tied for 1st");
  });

  it("rankPlayers still shares rank 1 on a tie and still names one champion -- the display, not the ranking, changed", () => {
    const state = {
      player_addresses: ["0xa", "0xb", "0xc"],
      player_cash: [
        { player: "0xa", cash_vgp: 900 },
        { player: "0xb", cash_vgp: 900 },
        { player: "0xc", cash_vgp: 400 },
      ],
      public_companies: [],
      private_companies: [],
    } as never;
    const ranked = rankPlayers({ state, priceForCompany: () => null, labelForAddress: (a) => a, totalAnte: 100 });
    expect(ranked.map((r) => [r.address, r.rank, r.netWorth])).toEqual([
      ["0xa", 1, 900],
      ["0xb", 1, 900],
      ["0xc", 3, 400],
    ]);
    expect(ranked.filter((r) => r.isWinner).map((r) => r.address)).toEqual(["0xa"]);
    // K-24: no payout field, at any ante.
    for (const r of ranked) expect(Object.keys(r)).not.toContain("expectedPayout");
  });
});

describe("the shell (W1-N's App regions)", () => {
  const APP = readShell();

  it("A-12: Game Over's Leave leaves the table and then goes to the Lobby", () => {
    expect(APP).toContain("onLeaveGame={handleLeaveTableToLobby}");
    expect(APP).not.toContain("onLeaveGame={handleLeaveSandboxRoom}");
    const handler = sliceBetween(APP, "const handleLeaveTableToLobby = useCallback(() => {", "}, [handleLeaveSandboxRoom, onLeaveGame]);");
    expect(handler.indexOf("handleLeaveSandboxRoom();")).toBeGreaterThanOrEqual(0);
    expect(handler.indexOf("onLeaveGame();")).toBeGreaterThan(handler.indexOf("handleLeaveSandboxRoom();"));
  });

  it("A-11: roomClosed reads the live board, never the scrubbed snapshot", () => {
    expect(APP).toContain("const roomClosed = liveState?.room_closed === true;");
    expect(APP).not.toContain("const roomClosed = gameState?.room_closed");
    // And `gameState` is the scrubbed one -- the reason this matters.
    expect(APP).toContain("const gameState = replaySnapshot?.state ?? liveState;");
  });

  it("A-10: the deadline is the server's stamp, not this tab's first sight", () => {
    expect(APP).toContain("setGameEndedAt(gameEndedAtFromLog(sandboxLogRef.current));");
    expect(APP).not.toContain("setGameEndedAt((current) => current ?? Date.now())");
    expect(APP).toContain("const autoCloseRemaining = autoCloseRemainingMs(gameEndedAt, roomClosed, now);");
  });

  it("AUD-01.09: the top bar gets the same copySandboxLog, only in a room; the crash screen gets its source", () => {
    expect(APP).toContain("onCopyGameLog={isInSandboxRoom ? copySandboxLog : undefined}");
    const source = sliceBetween(APP, "if (!isInSandboxRoom) return undefined;\n    setGameLogExportSource(", "}, [isInSandboxRoom]);");
    expect(source).toContain("buildSandboxLogExport(sandboxLogRef.current, sandboxRoomRef.current)");
    // Cleared on leaving the room and on unmount: no later crash elsewhere can hand over this table's log.
    expect(source).toContain("return () => setGameLogExportSource(null);");
    const topBar = readStripped("components/TopBar.tsx");
    expect(topBar).toContain("onClick={onCopyGameLog}");
    expect(topBar).toContain("Copy game log");
  });
});

describe("AUD-01.09: the crash screen can copy the game log", () => {
  function Boom(): React.ReactElement {
    throw new Error("render exploded");
  }

  function crash() {
    jest.spyOn(console, "error").mockImplementation(() => undefined);
    act(() =>
      root.render(
        <CrashScreen>
          <Boom />
        </CrashScreen>,
      ),
    );
  }

  it("offers the registered export and copies exactly it", async () => {
    const writeText = jest.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    setGameLogExportSource(() => '{"roomCode":"JUNO-ABC","actionCount":3}');
    crash();
    const button = host.querySelector<HTMLButtonElement>('[data-testid="crash-copy-game-log"]');
    expect(button).not.toBeNull();
    await act(async () => {
      button!.click();
    });
    expect(writeText).toHaveBeenCalledWith('{"roomCode":"JUNO-ABC","actionCount":3}');
    expect(host.querySelector('[role="status"]')?.textContent).toBe("Game log copied to the clipboard.");
  });

  it("falls back to the console when the clipboard refuses, and says so", async () => {
    Object.defineProperty(navigator, "clipboard", { value: { writeText: () => Promise.reject(new Error("no")) }, configurable: true });
    const log = jest.spyOn(console, "log").mockImplementation(() => undefined);
    setGameLogExportSource(() => "LOG");
    crash();
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="crash-copy-game-log"]')!.click();
    });
    expect(log).toHaveBeenCalledWith("LOG");
    expect(host.querySelector('[role="status"]')?.textContent).toContain("printed to the browser console");
  });

  it("snapshots the log as it catches, so the shell's cleanup clearing the source does not take it away", async () => {
    const writeText = jest.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    /* The crashing child registers the source on mount and clears it on unmount -- as the shell does. The boundary
       must still offer the text it read before that cleanup ran. */
    function Shell(): React.ReactElement {
      React.useEffect(() => {
        setGameLogExportSource(() => "SHELL-LOG");
        return () => setGameLogExportSource(null);
      }, []);
      return <Bomb />;
    }
    let armed = false;
    function Bomb(): React.ReactElement {
      if (armed) throw new Error("later render exploded");
      return <span>ok</span>;
    }
    jest.spyOn(console, "error").mockImplementation(() => undefined);
    act(() => root.render(<CrashScreen><Shell /></CrashScreen>));
    armed = true;
    act(() => root.render(<CrashScreen><Shell key="same" /></CrashScreen>));
    const button = host.querySelector<HTMLButtonElement>('[data-testid="crash-copy-game-log"]');
    expect(button).not.toBeNull();
    await act(async () => {
      button!.click();
    });
    expect(writeText).toHaveBeenCalledWith("SHELL-LOG");
  });

  it("offers no previous table's log once the shell has left it", () => {
    setGameLogExportSource(() => "OLD-TABLE");
    setGameLogExportSource(null); // the shell's cleanup on leaving
    crash();
    expect(host.querySelector('[data-testid="crash-copy-game-log"]')).toBeNull();
  });

  it("shows no log button outside a room", () => {
    setGameLogExportSource(null);
    crash();
    expect(host.textContent).toContain("Copy error details");
    expect(host.querySelector('[data-testid="crash-copy-game-log"]')).toBeNull();
  });
});
