/** @jest-environment jsdom */
//
// PHASE 3 FINAL CLOCKS: the room strip's clock chip, rendered -- it counts on from the server's view by the monotonic
// time since it arrived, shows no figure while its room link is down, asks the server for pause / resume / the system
// resume / the N-1 vote / "Annul game" with exactly the op the protocol names, signs a money table's YES on this device
// before sending it, and shows a refusal without changing the clock.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { GameClockChip, type ClockApprovalSigner } from "./GameClockChip";
import type { RoomClockView } from "../utils/clockProtocol";
import type { RoomOpBody, RoomOpResult } from "../utils/roomProtocol";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MIN = 60_000;
const players = [
  { id: "p-me", nickname: "Me", isReady: true, online: true },
  { id: "p-bob", nickname: "Bob", isReady: true, online: true },
  { id: "p-carol", nickname: "Carol", isReady: true, online: true },
];

function view(over: Partial<RoomClockView> = {}): RoomClockView {
  return {
    v: 2,
    deadline: "live",
    paceSecs: null,
    policyFrozen: true,
    money: false,
    state: "running",
    serverNow: 1_800_000_000_000,
    revision: 7,
    responsible: { seat: "p-bob", kind: "turn" },
    action: { remainingMs: 20 * MIN, running: true },
    trade: null,
    overdue: null,
    strikes: {},
    pause: { paused: false, request: null },
    system: null,
    ended: null,
    remedy: null,
    declines: [],
    annul: null,
    noDeadlineAcks: [],
    seats: ["p-me", "p-bob", "p-carol"],
    ...over,
  };
}

const overdueView = (money: boolean) =>
  view({
    money,
    state: "overdue",
    action: { remainingMs: 0, running: false },
    overdue: { seat: "p-bob", strike: 1, epoch: 4, overdueAt: 1_800_000_000_000, logLen: 12, logHash: "ab".repeat(32), finality: { remainingMs: 10 * MIN, running: true }, outcomeIfUncured: "timeout-annul", cure: "turn", proposal: null },
    strikes: { "p-bob": 1 },
  });

describe("Phase 3 final clocks: the clock chip", () => {
  let host: HTMLDivElement;
  let root: Root;
  let mono = 1_000;
  let linkListener: ((open: boolean) => void) | null = null;
  const sent: Array<{ op: RoomOpBody; gameId?: string }> = [];
  let answer: RoomOpResult = { ok: true, data: {} };

  const render = (clock: RoomClockView, over: { signApproval?: ClockApprovalSigner; current?: boolean } = {}) =>
    act(() => {
      root.render(
        <GameClockChip
          gameId="g_test"
          clock={clock}
          players={players}
          viewerPlayerId="p-me"
          current={over.current ?? true}
          {...(over.signApproval !== undefined ? { signApproval: over.signApproval } : {})}
          monotonic={() => mono}
          sendOp={(op, gameId) => {
            sent.push({ op, gameId });
            return Promise.resolve(answer);
          }}
          watchLink={(_gameId, listener) => {
            linkListener = listener;
            listener(true);
            return () => undefined;
          }}
          receivedAtOf={() => 1_000}
        />,
      );
    });

  const q = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
  const click = async (id: string) => {
    await act(async () => {
      q(id)?.click();
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });
  };

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

  it("one action clock, counting on from the view's arrival; nothing current while the link is down", () => {
    render(view());
    expect(q("game-clock-mode")?.textContent).toBe("Live");
    expect(q("game-clock-label")?.textContent).toBe("Bob to act");
    expect(q("game-clock-value")?.textContent).toBe("20:00");
    mono += 61_000;
    act(() => {
      jest.advanceTimersByTime(1_000);
    });
    expect(q("game-clock-value")?.textContent).toBe("18:59");
    act(() => linkListener?.(false));
    expect(q("game-clock")?.getAttribute("data-state")).toBe("not-current");
    expect(q("game-clock-value")).toBeNull();
  });

  it("asks to pause with the protocol's op; answers a standing request; a refusal is shown, the clock unchanged", async () => {
    render(view());
    await click("game-clock-toggle");
    await click("game-clock-request-pause");
    expect(sent[0]).toEqual({ op: { type: "clock-pause", action: "request", kind: "pause" }, gameId: "g_test" });
    render(view({ pause: { paused: false, request: { kind: "pause", id: 2, by: "p-bob", yes: ["p-bob"], needed: ["p-me", "p-bob", "p-carol"] } } }));
    answer = { ok: false, code: "clock-stale", reason: "That request is no longer open." };
    await click("game-clock-agree");
    expect(sent[1]).toEqual({ op: { type: "clock-pause", action: "yes", kind: "pause", id: 2 }, gameId: "g_test" });
    expect(q("game-clock-refusal")?.textContent).toBe("That request is no longer open.");
    expect(q("game-clock-value")?.textContent).toBe("20:00");
  });

  it("system pause: the owner's sentences and the resume vote", async () => {
    render(view({ state: "system-paused", action: { remainingMs: 6 * MIN + 12_000, running: false }, system: { since: 2, preservedAt: 1, yes: [], needed: ["p-me", "p-bob", "p-carol"] } }));
    await click("game-clock-toggle");
    const text = q("game-clock-panel")?.textContent ?? "";
    expect(text).toContain("Game paused because server continuity was interrupted.");
    expect(text).toContain("All players must agree to resume.");
    expect(text).toContain("6:12");
    await click("game-clock-system-resume");
    expect(sent[0].op).toEqual({ type: "clock-sysresume" });
  });

  it("a free table's vote needs no signature; a money table's YES is signed on this device first", async () => {
    render(overdueView(false));
    await click("game-clock-toggle");
    await click("game-clock-propose-foreclose");
    expect(sent[0].op).toEqual({ type: "clock-propose", kind: "foreclose" });

    const asked: Array<Parameters<ClockApprovalSigner>[0]> = [];
    const signer: ClockApprovalSigner = async (input) => {
      asked.push(input);
      return { ok: true, approveUntil: 1_800_021_540, signature: "cd".repeat(64) };
    };
    render(overdueView(true), { signApproval: signer });
    await click("game-clock-propose-foreclose");
    expect(asked[0]).toMatchObject({ remedy: 2, live: true, overdue: { seat: "p-bob", epoch: 4, logLen: 12 } });
    expect(sent[1].op).toEqual({ type: "clock-propose", kind: "foreclose", approveUntil: 1_800_021_540, signature: "cd".repeat(64) });

    render(overdueView(true));
    await click("game-clock-propose-foreclose");
    expect(sent.length).toBe(2);
    expect(q("game-clock-refusal")?.textContent).toMatch(/can't sign the approval/);
  });

  it("'Annul game' on a free table, with the count of agreements", async () => {
    render(view({ annul: { yes: ["p-bob"], needed: ["p-me", "p-bob", "p-carol"] } }));
    await click("game-clock-toggle");
    expect(q("game-clock-annul")?.textContent).toBe("Annul game (1 of 3 agree)");
    await click("game-clock-annul");
    expect(sent[0].op).toEqual({ type: "clock-annul", yes: true });
  });

  it("the second strike's warning is prominent for the seat it concerns", async () => {
    render(view({ strikes: { "p-me": 2 }, responsible: { seat: "p-me", kind: "turn" } }));
    expect(q("game-clock-warning-mark")).not.toBeNull();
    await click("game-clock-toggle");
    expect(q("game-clock-warning")?.textContent).toBe("Next action-clock expiry results in automatic foreclosure.");
  });
});
