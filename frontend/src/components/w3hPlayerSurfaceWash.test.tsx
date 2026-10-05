/** @jest-environment jsdom */
// W3-H, AUD-12.05 (U-7) and AUD-12.06 (U-8), ruled in by OD-14(b) ("use the cash/payout player-colour wash")
// and OD-14(c) ("give the seventh LPF/player a distinct colour").
//
// Both were found ALREADY IMPLEMENTED when W3-H opened them: the #1347 wash reaches the cash slide-out
// (`MoneyMachinePanel`, player kind) and the payout modal's player cards (`PrivateRevenueModal`, the viewer's
// own card and every other collector's), and #1344's seventh seat colour (Raspberry) is in the palette with
// the seven-wide separation guards in `utils/seatColor.test.ts`. U-7's "not yet reaching" line in Part C was
// stale. What was missing was a pin: nothing rendered either surface and asked what colour it was. This does,
// with the seventh seat's colour, so the two rulings are held together.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { MoneyMachinePanel } from "./MoneyMachinePanel";
import PrivateRevenueModal from "./PrivateRevenueModal";
import { ModalLayerHost } from "./ModalPortal";
import { CARD_SURFACE, washedPlayerSurface } from "../styles/palette";
import { SEAT_COLORS, resolveSeatColors } from "../utils/playerLabels";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
global.IS_REACT_ACT_ENVIRONMENT = true;

const RASPBERRY = SEAT_COLORS[6];
const SLATE = SEAT_COLORS[0];

/** jsdom reports a hex background as `rgb(r, g, b)`. */
function rgb(hex: string): string {
  const n = (at: number) => parseInt(hex.slice(1 + at, 3 + at), 16);
  return `rgb(${n(0)}, ${n(2)}, ${n(4)})`;
}
const backgrounds = (root: ParentNode) =>
  Array.from(root.querySelectorAll<HTMLElement>("*")).map((node) => node.style.backgroundColor);

let host: HTMLDivElement;
let root: Root;
let layerHost: HTMLDivElement;
let layerRoot: Root;
beforeEach(() => {
  layerHost = document.createElement("div");
  document.body.appendChild(layerHost);
  layerRoot = createRoot(layerHost);
  act(() => layerRoot.render(<ModalLayerHost />));
  host = document.createElement("div");
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host);
  });
});
afterEach(() => {
  act(() => root.unmount());
  act(() => layerRoot.unmount());
  host.remove();
  layerHost.remove();
});

describe("AUD-12.06 (U-8): seven seats, seven distinct colours", () => {
  it("a full Level Playing Field table resolves to seven different colours, the seventh Raspberry", () => {
    const seats = Array.from({ length: 7 }, (_, index) => ({ id: `p${index}` }));
    const colours = Object.values(resolveSeatColors(seats));
    expect(new Set(colours).size).toBe(7);
    expect(colours[6]).toBe(RASPBERRY);
  });
});

describe("AUD-12.05 (U-7): the player-colour wash reaches the cash slide-out", () => {
  const panel = (kind: "player" | "corporation", fill: string) => (
    <MoneyMachinePanel
      token={1}
      phase="merged"
      kind={kind}
      header={{ label: kind === "player" ? "Ann" : "PRR", fill, ink: "#ffffff" }}
      mover={{ label: "Dividend", amountText: "+$54", ink: "#2c6e4a" }}
      holder={{ label: kind === "player" ? "Cash" : "Treasury", before: 100, after: 154 }}
    />
  );

  it("a player's slide-out is the parchment washed toward their seat colour -- the seventh seat's too", () => {
    act(() => root.render(panel("player", RASPBERRY)));
    const status = host.querySelector<HTMLElement>('[role="status"]');
    expect(status?.style.backgroundColor).toBe(rgb(washedPlayerSurface(CARD_SURFACE, RASPBERRY)));
    expect(washedPlayerSurface(CARD_SURFACE, RASPBERRY)).not.toBe(CARD_SURFACE);
  });

  it("a corporation's slide-out keeps the plain parchment (the wash means 'a player')", () => {
    act(() => root.render(panel("corporation", "#c8102e")));
    const status = host.querySelector<HTMLElement>('[role="status"]');
    expect(status?.style.backgroundColor).toBe(rgb(CARD_SURFACE));
  });
});

describe("AUD-12.05 (U-7): the player-colour wash reaches the payout modal's player cards", () => {
  it("the viewer's own card and another collector's card are each washed in their own seat colour", () => {
    const round = {
      viewerName: "Ann",
      viewerSeatColor: RASPBERRY,
      lines: [{ privateId: 1, label: "Schuylkill Valley", value: "$5" }],
      total: 5,
      cashBefore: 100,
      cashAfter: 105,
      others: [
        {
          name: "Bob",
          seatColor: SLATE,
          lines: [{ privateId: 2, label: "Champlain & St.Lawrence", value: "$10" }],
          total: 10,
          cashBefore: 200,
          cashAfter: 210,
        },
      ],
    } as never;
    act(() => root.render(<PrivateRevenueModal round={round} roundLabel="OR 1" onAcknowledge={jest.fn()} />));
    const painted = backgrounds(document.body);
    expect(painted).toContain(rgb(washedPlayerSurface(CARD_SURFACE, RASPBERRY)));
    expect(painted).toContain(rgb(washedPlayerSurface(CARD_SURFACE, SLATE)));
  });
});
