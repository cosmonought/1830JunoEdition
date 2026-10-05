/** @jest-environment jsdom */
//
// PHASE 3 LANE A (AUD-11.04): the room strip's clock chip, rendered -- it counts on from the server's view by the
// monotonic time since it arrived, shows nothing current while its room link is down, sends the host's pause bound to
// the revision it saw, and shows a refusal without changing the clock.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { GameClockChip } from "./GameClockChip";
import type { RoomClockView } from "../utils/clockProtocol";
import type { RoomOpBody, RoomOpResult } from "../utils/roomProtocol";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MIN = 60_000;
const clock: RoomClockView = {
  mode: "live",
  state: "running",
  seat: "p-bob",
  allowanceMs: 2 * MIN,
  elapsedMs: 30_000,
  remainingMs: 90_000,
  serverNow: 1_800_000_000_000,
  turnStartedAt: 1_800_000_000_000 - 30_000,
  pausedAt: null,
  revision: 7,
};
const players = [
  { id: "p-alice", nickname: "Alice", isReady: true, online: true },
  { id: "p-bob", nickname: "Bob", isReady: true, online: true },
];

describe("Phase 3 lane A: the clock chip", () => {
  let host: HTMLDivElement;
  let root: Root;
  let mono = 1_000;
  let linkListener: ((open: boolean) => void) | null = null;
  const sent: Array<{ op: RoomOpBody; gameId?: string }> = [];
  let answer: RoomOpResult = { ok: true, data: {} };

  const render = (over: Partial<React.ComponentProps<typeof GameClockChip>> = {}) =>
    act(() => {
      root.render(
        <GameClockChip
          gameId="g_test"
          clock={clock}
          players={players}
          viewerPlayerId="p-alice"
          isHost
          current
          boardSeat="p-bob"
          monotonic={() => mono}
          sendOp={(op, gameId) => {
            sent.push({ op, gameId });
            return Promise.resolve(answer);
          }}
          watchLink={(_gameId, listener) => {
            linkListener = listener;
            listener(true);
            return () => {
              linkListener = null;
            };
          }}
          {...over}
        />,
      );
    });

  beforeEach(() => {
    jest.useFakeTimers();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    mono = 1_000;
    sent.length = 0;
    answer = { ok: true, data: {} };
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    jest.useRealTimers();
  });

  const text = (id: string) => host.querySelector(`[data-testid="${id}"]`)?.textContent ?? null;

  test("shows the mode, whose turn, and the server's figure -- counting on by monotonic time, once a second", () => {
    render();
    expect(text("game-clock-mode")).toBe("Live");
    expect(text("game-clock-label")).toBe("Bob's turn");
    expect(text("game-clock-value")).toBe("1:30 left");
    mono += 15_000;
    act(() => {
      jest.advanceTimersByTime(1_000);
    });
    expect(text("game-clock-value")).toBe("1:15 left");
    expect(host.querySelector('[role="timer"]')).not.toBeNull();
  });

  test("a new view from the server resets the count to the server's figure", () => {
    render();
    mono += 20_000;
    render({ clock: { ...clock, elapsedMs: 40_000, remainingMs: 80_000, revision: 8 } });
    expect(text("game-clock-value")).toBe("1:20 left");
  });

  test("a view replayed from the link's cache counts from when its frame ARRIVED, not from when the chip mounted", () => {
    render({ receivedAtOf: () => mono - 20_000 });
    expect(text("game-clock-value")).toBe("1:10 left");
  });

  test("with its room link down it shows no figure and no control (not current)", () => {
    render();
    act(() => linkListener?.(false));
    expect(host.querySelector('[data-testid="game-clock"]')?.getAttribute("data-state")).toBe("not-current");
    expect(text("game-clock-value")).toBeNull();
    expect(host.querySelector('[data-testid="game-clock-pause"]')).toBeNull();
  });

  test("the host's pause names the revision it saw; a refusal is shown and the clock is not changed here", async () => {
    answer = { ok: false, code: "clock-stale", reason: "The clock changed since this tab last saw it. Check the clock and try again." };
    render();
    await act(async () => {
      (host.querySelector('[data-testid="game-clock-pause"]') as HTMLButtonElement).click();
    });
    expect(sent).toEqual([{ op: { type: "clock-pause", revision: 7 }, gameId: "g_test" }]);
    expect(text("game-clock-refusal")).toMatch(/changed since this tab last saw it/);
    expect(host.querySelector('[data-testid="game-clock"]')?.getAttribute("data-state")).toBe("running");
  });

  test("a non-host sees the clock and no control; expiry reads Time expired, not a forfeit", () => {
    render({ isHost: false, clock: { ...clock, state: "expired", elapsedMs: 2 * MIN + 5_000, remainingMs: 0 } });
    expect(host.querySelector("button")).toBeNull();
    expect(text("game-clock-value")).toBe("Time expired");
    expect(host.textContent ?? "").not.toMatch(/forfeit/i);
  });
});
