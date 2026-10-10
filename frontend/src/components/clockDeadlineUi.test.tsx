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
import { installSessionPort } from "../utils/sessionBootstrap";
import { resetPinnedDeploymentForTests } from "../money/escrowDeployment";
import { scriptedPort, TEST_CONTRACT, TEST_PIN } from "../money/moneyTestSupport";

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
  installSessionPort(null);
  delete process.env.REACT_APP_ESCROW_DEPLOYMENT;
  resetPinnedDeploymentForTests();
});

/* CONSOLIDATED FINAL INTEGRATION: every player game is anted (the final account lane, `utils/tablePolicy.ts`), so the
   host card creates only with a real-money offer and a valid stake -- the deadline is chosen on that card. */
function offerMoneyTables(): void {
  process.env.REACT_APP_ESCROW_DEPLOYMENT = JSON.stringify(TEST_PIN);
  resetPinnedDeploymentForTests();
  const port = scriptedPort();
  port.answer("money/config", 200, {
    ok: true,
    enabled: true,
    why: null,
    reason: null,
    deployment: { backend: "juno-cosmwasm", chainId: "uni-7", networkClass: "testnet", contract: TEST_CONTRACT, codeChecksum: TEST_PIN.codeChecksum, denom: "ujunox", symbol: "JUNOX", exponent: 6 },
    feeBps: 100,
    minAnte: "1000",
  });
  installSessionPort(port);
}
const settle = async () => {
  await act(async () => {
    for (let round = 0; round < 3; round += 1) {
      for (let n = 0; n < 40; n += 1) await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
};
const typeInto = (input: HTMLInputElement | null, value: string) => {
  expect(input).toBeTruthy();
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input!.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

const byTestId = <T extends HTMLElement = HTMLElement>(id: string): T | null => document.querySelector<T>(`[data-testid="${id}"]`);
const click = (node: HTMLElement | null) => act(() => node?.click());

describe("Phase 3 final clocks: the host's action deadline", () => {
  /* PLAY HOST A GAME (handoff §3.1): the deadline is chosen on step 1, inside the Async pace card (12h-7d, or None);
     picking a chip also chooses Async. A money table needs an exact count until the corrected escrow (§11). */
  it("an Async table's pace (or No deadline) is chosen on the pace card and sent with the create", async () => {
    offerMoneyTables();
    const created: Array<{ variants: GameVariants; setup: RoomSetup }> = [];
    act(() => root.render(<HostSetupCard busy={false} error={null} onClose={() => {}} onCreate={(variants, setup) => created.push({ variants, setup })} />));
    await settle();
    const chips = byTestId("host-deadline");
    expect(chips).not.toBeNull();
    expect(Array.from(chips!.querySelectorAll('[role="radio"]')).map((node) => node.textContent)).toEqual(["12hper action", "24hper action", "2dper action", "3dper action", "7dper action", "Noneno deadline"]);
    click(byTestId("host-deadline-259200"));
    expect(byTestId("host-pace-async")?.getAttribute("aria-checked")).toBe("true");
    click(byTestId("host-continue"));
    await settle();
    click(byTestId("host-players-4"));
    typeInto(byTestId<HTMLInputElement>("host-stake-amount"), "2.5");
    await settle();
    click(byTestId("host-create-room"));
    expect(created[0].variants.mode).toBe("async");
    expect(created[0].setup).toMatchObject({ deadline: "async-pace", paceSecs: 259_200, anteUjuno: "2500000", playerCount: 4 });
  });

  it("an Async No-deadline table with its required stake waits for the host's acknowledgement of the disclosure, and sends it with the create", async () => {
    offerMoneyTables();
    const created: Array<{ variants: GameVariants; setup: RoomSetup }> = [];
    act(() => root.render(<HostSetupCard busy={false} error={null} onClose={() => {}} onCreate={(variants, setup) => created.push({ variants, setup })} />));
    await settle();
    click(byTestId("host-deadline-none"));
    /* The acknowledgement moved to step 1: Continue waits for it, and the footer says why. */
    expect(byTestId<HTMLButtonElement>("host-continue")?.disabled).toBe(true);
    expect(byTestId("host-summary")?.textContent).toBe("Tick the no-deadline acknowledgement to continue.");
    const ack = byTestId<HTMLInputElement>("host-no-deadline-ack");
    expect(ack).not.toBeNull();
    click(ack);
    expect(byTestId<HTMLButtonElement>("host-continue")?.disabled).toBe(false);
    click(byTestId("host-continue"));
    await settle();
    click(byTestId("host-players-2"));
    typeInto(byTestId<HTMLInputElement>("host-stake-amount"), "2.5");
    await settle();
    click(byTestId("host-create-room"));
    expect(created).toHaveLength(1);
    expect(created[0].setup).toMatchObject({ deadline: "no-deadline", paceSecs: null, noDeadlineAck: true, anteUjuno: "2500000" });
  });

  it("a Live table states its 20:00 action clock (nothing to choose)", () => {
    act(() => root.render(<HostSetupCard busy={false} error={null} onClose={() => {}} onCreate={() => {}} />));
    expect(byTestId("host-pace-live")?.getAttribute("aria-checked")).toBe("true");
    expect(byTestId("host-deadline-live")?.textContent).toBe("20mper action");
    /* No chip is checked while the table is Live. */
    expect(Array.from(byTestId("host-deadline")!.querySelectorAll('[aria-checked="true"]'))).toHaveLength(0);
    expect(byTestId("host-clock")?.textContent).toMatch(/Live: 20:00 for each required action\./);
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
