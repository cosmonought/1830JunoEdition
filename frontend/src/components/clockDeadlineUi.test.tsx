/** @jest-environment jsdom */
//
// PHASE 3 FINAL CLOCKS: where the deadline is chosen and acknowledged -- the host's Action Deadline on an Async table
// (a pace, or No deadline; a Live table states its 20:00 clock), sent with the create; and the No-deadline disclosure,
// shown conspicuously in the owner's words before any ante, acknowledged with the protocol's op.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { ModalLayerHost } from "./ModalPortal";
import HostSetupCard from "./HostSetupCard";
import { NoDeadlineNotice } from "./money/MoneyPanel";
import { NO_DEADLINE_DISCLOSURE, type RoomClockView } from "../utils/clockProtocol";
import type { GameVariants } from "../gameEngine/gameVariants";
import type { RoomSetup } from "../utils/sandboxRoomSummary";
import type { RoomOpBody, RoomOpResult } from "../utils/roomProtocol";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
  host.remove();
  act(() => layerRoot.unmount());
  layerHost.remove();
});

const byTestId = <T extends HTMLElement = HTMLElement>(id: string): T | null => document.querySelector<T>(`[data-testid="${id}"]`);
const click = (node: HTMLElement | null) => act(() => node?.click());

describe("Phase 3 final clocks: the host's action deadline", () => {
  it("an Async table's pace (or No deadline) is chosen in the house rules and sent with the create", () => {
    const created: Array<{ variants: GameVariants; setup: RoomSetup }> = [];
    act(() => root.render(<HostSetupCard busy={false} error={null} onClose={() => {}} onCreate={(variants, setup) => created.push({ variants, setup })} />));
    const pace = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="radio"]')).find((node) => /async/i.test(node.textContent ?? ""));
    click(pace ?? null);
    click(byTestId("host-continue"));
    const select = byTestId<HTMLSelectElement>("host-deadline");
    expect(select).not.toBeNull();
    expect(Array.from(select!.options).map((option) => option.textContent)).toEqual(["12 hours per action", "24 hours per action", "2 days per action", "3 days per action", "7 days per action", "No deadline"]);
    act(() => {
      select!.value = "259200";
      select!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    click(byTestId("host-create-room"));
    expect(created[0].variants.mode).toBe("async");
    expect(created[0].setup).toMatchObject({ deadline: "async-pace", paceSecs: 259_200 });
  });

  it("a Live table states its 20:00 action clock (nothing to choose)", () => {
    act(() => root.render(<HostSetupCard busy={false} error={null} onClose={() => {}} onCreate={() => {}} />));
    click(byTestId("host-continue"));
    expect(byTestId("host-deadline")).toBeNull();
    expect(byTestId("host-deadline-live")?.textContent).toMatch(/20:00 for each required action/);
  });
});

describe("Phase 3 final clocks: the No-deadline disclosure before the ante", () => {
  const clock = (acks: string[]): RoomClockView =>
    ({ v: 2, deadline: "no-deadline", paceSecs: null, policyFrozen: false, money: true, state: "setup", serverNow: 1, revision: 1, responsible: null, action: null, trade: null, overdue: null, strikes: {}, pause: { paused: false, request: null }, system: null, ended: null, remedy: null, declines: [], annul: null, noDeadlineAcks: acks, seats: [] }) as RoomClockView;

  it("conspicuous, verbatim, until this seat acknowledges it with the protocol's op", async () => {
    const sent: RoomOpBody[] = [];
    const sendOp = (op: RoomOpBody): Promise<RoomOpResult> => {
      sent.push(op);
      return Promise.resolve({ ok: true, data: {} });
    };
    act(() => root.render(<NoDeadlineNotice gameId="g_t" clock={clock([])} playerId="p-me" sendOp={sendOp} />));
    expect(byTestId("no-deadline-notice")?.getAttribute("role")).toBe("alert");
    expect(byTestId("no-deadline-disclosure")?.textContent).toBe(NO_DEADLINE_DISCLOSURE);
    await act(async () => {
      byTestId("no-deadline-ack")?.click();
      await Promise.resolve();
    });
    expect(sent).toEqual([{ type: "clock-ack" }]);
    act(() => root.render(<NoDeadlineNotice gameId="g_t" clock={clock(["p-me"])} playerId="p-me" sendOp={sendOp} />));
    expect(byTestId("no-deadline-notice")).toBeNull();
    expect(byTestId("no-deadline-acknowledged")?.textContent).toContain(NO_DEADLINE_DISCLOSURE);
  });

  it("nothing for a table with a deadline", () => {
    act(() => root.render(<NoDeadlineNotice gameId="g_t" clock={{ ...clock([]), deadline: "async-pace", paceSecs: 86_400 }} playerId="p-me" />));
    expect(host.textContent).toBe("");
  });
});
