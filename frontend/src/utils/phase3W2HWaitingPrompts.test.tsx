/** @jest-environment jsdom */
//
// ==================================================================
//  PHASE 3 W2-H (OD-1, H5, K-21 / U-32): THE WAITING-PLAYER PROMPTS
// ==================================================================
//
// OD-1: the actor of a prompt that stops the table gets the controls; every other viewer gets a READ-ONLY,
// NON-MODAL status with a focus target. Ordinary inactive-player behaviour is not redesigned. Pinned here:
//   1. the shared viewer policy, over actor / non-actor / third seat / watcher / spectator / an unlearned seat --
//      including the shape W2-G's emergency purchase will need (president interactive, everyone else a status);
//   2. the home station, from a REAL owed-home board: the President's card (timing-true copy, never "has floated"),
//      and the waiting status for the other seats and a watcher -- no control, no scrim, focusable, not focus-stealing;
//   3. reload: a board restored from storage raises the same prompt for the same seats, and a placed home clears it;
//   4. the auction: the par owner's and a seated player's card renders through the modal boundary with a live control
//      (H5's zero-tabbable state is gone); a non-owner seat, a third seat and a watcher read a status instead.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { AuctionPromptModal } from "../components/AuctionPromptModal";
import { HomeStationPrompt } from "../components/HomeStationPrompt";
import { ModalLayerHost } from "../components/ModalPortal";
import { NATIVE_MODAL_ATTRIBUTE, tabbableWithin } from "../components/NativeModal";
import { WAITING_STATUS_ATTRIBUTE } from "../components/WaitingStatusBanner";
import { STATIC_BOARD_HEXES, activateBoard, STANDARD_BOARD } from "../components/hexBoardData";
import type { GameStateResponse } from "../gameEngine/gameState";
import { boardHomeHexToAxial } from "../gameEngine/homeStationAuthority";
import { homeTokenBlock } from "../gameEngine/homeTokenGate";
import { pendingHomeTokens } from "../gameEngine/sandboxSession";
import { homeStationViewerIsPresident } from "./homeStationAskView";
import { board, P1, P2, P3, PRR } from "./offerFixtures74";
import { applyAsRoom, GRID, withCorp } from "./offerMatrix74Support";
import { readShell, sliceBetween } from "./sourceScan";
import { viewerIsNamedActor, viewerIsSeatedPlayer } from "./waitingPromptView";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
global.IS_REACT_ACT_ENVIRONMENT = true;

afterAll(() => activateBoard(STANDARD_BOARD));

const BO = 4;
const LABELS: Record<string, string> = { [P1]: "Ann", [P2]: "Ben", [P3]: "Cy" };
const SEATS = [P1, P2, P3];
const WATCHER = ""; // a seatless watcher's id in a room (LIVE-2D)

/* ================================================================================================== */
describe("the shared viewer policy (waitingPromptView)", () => {
  it("a named actor: only the actor's own, non-spectating screen", () => {
    expect(viewerIsNamedActor({ spectator: false, actor: P2, viewerAddress: P2 })).toBe(true);
    expect(viewerIsNamedActor({ spectator: false, actor: P2, viewerAddress: P1 })).toBe(false); // non-actor
    expect(viewerIsNamedActor({ spectator: false, actor: P2, viewerAddress: P3 })).toBe(false); // third seat
    expect(viewerIsNamedActor({ spectator: false, actor: P2, viewerAddress: WATCHER })).toBe(false); // watcher
    expect(viewerIsNamedActor({ spectator: true, actor: P2, viewerAddress: P2 })).toBe(false); // spectator, owner's wallet
    expect(viewerIsNamedActor({ spectator: false, actor: P2, viewerAddress: null })).toBe(false); // seat not learned yet
    expect(viewerIsNamedActor({ spectator: false, actor: P2, viewerAddress: undefined })).toBe(false);
  });

  it("a board that names nobody asks nobody (no \"\" === \"\", no null === null)", () => {
    for (const actor of [null, undefined, ""]) {
      for (const viewerAddress of [null, undefined, "", P2]) {
        expect(viewerIsNamedActor({ spectator: false, actor, viewerAddress })).toBe(false);
      }
    }
  });

  it("any seated player: every seat, never a watcher or a spectator", () => {
    for (const seat of SEATS) {
      expect(viewerIsSeatedPlayer({ spectator: false, viewerAddress: seat, seats: SEATS })).toBe(true);
      expect(viewerIsSeatedPlayer({ spectator: true, viewerAddress: seat, seats: SEATS })).toBe(false);
    }
    expect(viewerIsSeatedPlayer({ spectator: false, viewerAddress: WATCHER, seats: SEATS })).toBe(false);
    expect(viewerIsSeatedPlayer({ spectator: false, viewerAddress: "p-stranger", seats: SEATS })).toBe(false);
    expect(viewerIsSeatedPlayer({ spectator: false, viewerAddress: null, seats: SEATS })).toBe(false);
    expect(viewerIsSeatedPlayer({ spectator: false, viewerAddress: P1, seats: null })).toBe(false);
    // "" is never a seat, even on a malformed board that lists it.
    expect(viewerIsSeatedPlayer({ spectator: false, viewerAddress: "", seats: [""] })).toBe(false);
  });

  it("the home-station rule is the shared rule, unchanged (W1-J)", () => {
    for (const viewerAddress of [P1, P2, P3, WATCHER, null]) {
      for (const spectator of [false, true]) {
        expect(homeStationViewerIsPresident({ spectator, president: P2, viewerAddress })).toBe(
          viewerIsNamedActor({ spectator, actor: P2, viewerAddress }),
        );
      }
    }
  });

  it("stays compatible with W2-G's shape: the obligated President interactive, everyone else a simplified status", () => {
    const interactive = (viewer: string | null, spectator = false) =>
      viewerIsNamedActor({ spectator, actor: P1, viewerAddress: viewer });
    expect(interactive(P1)).toBe(true);
    expect([P2, P3, WATCHER, null].map((viewer) => interactive(viewer))).toEqual([false, false, false, false]);
    expect(interactive(P1, true)).toBe(false);
  });
});

/* ================================================================================================== */
/* A real owed-home board: Operating Round, B&O (president P2) under the cursor at the start of its first turn,
   home I15 not on the board. PRR's home is down. The fixture is `homeStationAuthority.test.ts`'s. */
function hexAt(label: string) {
  const hex = STATIC_BOARD_HEXES.find((entry) => entry.label === label);
  if (!hex) throw new Error(`no ${label} on the board in effect`);
  return hex;
}
function owedBoard(): GameStateResponse {
  const state = board({
    round: "OperatingRound",
    corps: [
      { id: PRR, ticker: "PRR", president: P1, trains: ["2"], treasury: "500", price: 100 },
      { id: BO, ticker: "B&O", president: P2, trains: [], treasury: "900", price: 90 },
    ],
    operating: BO,
    step: "Track",
  });
  const prrHome = hexAt("H12");
  return withCorp(withCorp(state, PRR, { home_hex_label: "H12", station_token_hexes: [[prrHome.q, prrHome.r]] }), BO, {
    home_hex_label: "I15",
  });
}
const placeHome = (state: GameStateResponse) => {
  const hex = hexAt("I15");
  return applyAsRoom(
    state,
    { PlaceHomeStation: { game_id: 1, company_id: BO, q: hex.q, r: hex.r, kind: "home", city_index: null, hex_label: "I15" } },
    P2,
    GRID,
  );
};
/** The shell's memo: the board's answer, identical on every client (#788). */
const owedOn = (state: GameStateResponse) => pendingHomeTokens(state, boardHomeHexToAxial, GRID)[0] ?? null;

describe("the home station, rendered per seat from a real board", () => {
  let container: HTMLDivElement;
  let root: Root;
  let chat: HTMLInputElement;
  beforeEach(() => {
    chat = document.createElement("input"); // something the waiting player was typing in
    document.body.appendChild(chat);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    chat.remove();
  });

  const draw = (state: GameStateResponse, viewerAddress: string | null, spectator = false) => {
    const pending = owedOn(state);
    const onPlace = jest.fn();
    act(() => {
      root.render(
        <HomeStationPrompt
          pending={pending}
          presidentLabel={pending?.president ? LABELS[pending.president] ?? null : null}
          viewerIsPresident={homeStationViewerIsPresident({ spectator, president: pending?.president, viewerAddress })}
          liveryColor="#0a3a7a"
          liveryInk="#eaf2ff"
          onPlace={onPlace}
        />,
      );
    });
    return onPlace;
  };
  const waiting = () => container.querySelector<HTMLElement>(`[${WAITING_STATUS_ATTRIBUTE}]`);

  it("the board owes B&O's home to its President, and the authority's hold sentence says when", () => {
    const state = owedBoard();
    expect(owedOn(state)).toMatchObject({ companyId: BO, ticker: "B&O", president: P2, hexLabel: "I15" });
    expect(homeTokenBlock({ state, homeHexToAxial: boardHomeHexToAxial, labelForAddress: (a) => LABELS[a] ?? a })).toBe(
      "B&O is starting its first operating turn and its home station is not on the board yet. Ben must place it on I15 before B&O can operate.",
    );
  });

  it("actor (the President): the blocking card with the one control, and timing-true copy (K-21 / U-32)", () => {
    const onPlace = draw(owedBoard(), P2);
    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog?.getAttribute("aria-modal")).toBe("true");
    expect(container.textContent).toContain("Ben — place the home station");
    expect(container.textContent).toContain(
      "The B&O is starting its first operating turn and its home station is not on the board yet.",
    );
    expect(container.textContent).toContain("As President you place its first station token");
    expect(container.textContent).not.toContain("has floated");
    expect(waiting()).toBeNull();
    const buttons = container.querySelectorAll("button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0].textContent).toContain("Place Home Station on I15");
    act(() => buttons[0].click());
    expect(onPlace).toHaveBeenCalledWith(BO, hexAt("I15").q, hexAt("I15").r, undefined);
  });

  const expectWaiting = () => {
    const status = waiting();
    expect(status).not.toBeNull();
    // Read-only and non-modal: no control of any kind, no dialog, no scrim.
    expect(container.querySelectorAll("button, input, select, textarea, a[href]")).toHaveLength(0);
    expect(container.querySelector('[role="dialog"], [aria-modal], dialog')).toBeNull();
    // Who, which corporation, where, and why -- the truthful timing, never the float.
    expect(status!.textContent).toContain("B&O must place its home station");
    expect(status!.textContent).toContain("Waiting for Ben to place the B&O home station on I15.");
    expect(status!.textContent).toContain("The B&O is starting its first operating turn and cannot operate until");
    expect(status!.textContent).toContain("Play resumes as soon as it is down.");
    expect(status!.textContent).not.toContain("has floated");
    expect(status!.textContent).not.toContain("As President");
    // A focus target: a named region the keyboard reaches, with a polite live status inside.
    expect(status!.tagName).toBe("SECTION");
    expect(status!.tabIndex).toBe(0);
    const headingId = status!.getAttribute("aria-labelledby");
    expect(headingId).toBeTruthy();
    expect(document.getElementById(headingId!)?.textContent).toBe("B&O must place its home station");
    expect(status!.querySelector('[role="status"]')?.getAttribute("aria-live")).toBe("polite");
    return status!;
  };

  it("non-actor (another seat): the waiting status, no control", () => {
    draw(owedBoard(), P1);
    expectWaiting();
  });

  it("third seat: the same waiting status", () => {
    draw(owedBoard(), P3);
    expectWaiting();
  });

  it("watcher (seatless, id \"\") and spectator (even holding the President's wallet): never the President's form", () => {
    draw(owedBoard(), WATCHER);
    expectWaiting();
    draw(owedBoard(), P2, true);
    expectWaiting();
    draw(owedBoard(), null);
    expectWaiting();
  });

  it("the status is reachable by focus but does not take it: the waiting player keeps what they were doing", () => {
    act(() => chat.focus());
    draw(owedBoard(), P1);
    const status = expectWaiting();
    expect(document.activeElement).toBe(chat);
    act(() => status.focus());
    expect(document.activeElement).toBe(status);
  });

  it("reload: a board restored from storage raises the same prompt for the same seats; a placed home clears it for all", () => {
    const stored = JSON.stringify(owedBoard());
    const restored = JSON.parse(stored) as GameStateResponse;
    expect(owedOn(restored)).toEqual(owedOn(owedBoard()));
    // A fresh tab has no placement errand: the President is asked again, the others told again.
    draw(restored, P2);
    expect(container.querySelectorAll("button")).toHaveLength(1);
    for (const viewer of [P1, P3, WATCHER]) {
      draw(restored, viewer);
      expectWaiting();
    }
    // The President places it; every seat's surface goes, and a restore of THAT board raises nothing.
    const placed = placeHome(restored);
    expect(owedOn(placed)).toBeNull();
    const reloadedAfter = JSON.parse(JSON.stringify(placed)) as GameStateResponse;
    for (const viewer of [P2, P1, P3, WATCHER]) {
      draw(reloadedAfter, viewer);
      expect(container.innerHTML).toBe("");
    }
  });
});

/* ================================================================================================== */
describe("the auction: the actor's card through the modal boundary; everybody else a status", () => {
  let layerHost: HTMLDivElement;
  let layerRoot: Root;
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    layerHost = document.createElement("div");
    document.body.appendChild(layerHost);
    layerRoot = createRoot(layerHost);
    act(() => {
      layerRoot.render(<ModalLayerHost />);
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    act(() => layerRoot.unmount());
    layerHost.remove();
  });

  /** As the shell mounts it: `owner` owes the par (or nobody), the handoff is pending or not, for `viewer`. */
  const draw = (opts: { owner: string | null; handoff: boolean; viewer: string | null; spectator?: boolean }) => {
    const spectator = opts.spectator ?? false;
    const isOwner = viewerIsNamedActor({ spectator, actor: opts.owner, viewerAddress: opts.viewer });
    const onProceed = jest.fn();
    act(() => {
      root.render(
        <AuctionPromptModal
          parPending={isOwner}
          parWinnerLabel={opts.owner ? LABELS[opts.owner] : ""}
          onConfirmPar={() => undefined}
          handoffPending={opts.handoff}
          awaitingParFrom={opts.owner !== null && !isOwner ? LABELS[opts.owner] : null}
          viewerActsOnHandoff={viewerIsSeatedPlayer({ spectator, viewerAddress: opts.viewer, seats: SEATS })}
          onProceed={onProceed}
        />,
      );
    });
    return onProceed;
  };
  const dialog = () => document.querySelector<HTMLDialogElement>(`dialog[${NATIVE_MODAL_ATTRIBUTE}]`);
  const status = () => document.querySelector<HTMLElement>(`[${WAITING_STATUS_ATTRIBUTE}]`);
  const text = () => document.body.textContent ?? "";

  it("actor (the par owner): the par card in the modal boundary, forced, with live controls (H5 gone)", () => {
    draw({ owner: P2, handoff: true, viewer: P2 });
    const node = dialog();
    expect(node).not.toBeNull();
    expect(node!.getAttribute("aria-label")).toBe("Set the B&O par value");
    expect(node!.getAttribute("closedby")).toBe("none");
    expect(text()).toContain("Ben wins the Baltimore & Ohio");
    expect(tabbableWithin(node!).length).toBeGreaterThan(0);
    expect(status()).toBeNull();
    expect(text()).not.toContain("Proceed to");
  });

  it("non-actor seat and third seat while the par is owed: the status names the owner, no control, no dialog", () => {
    for (const viewer of [P1, P3]) {
      draw({ owner: P2, handoff: true, viewer });
      expect(dialog()).toBeNull();
      expect(status()).not.toBeNull();
      expect(status()!.tabIndex).toBe(0);
      expect(status()!.textContent).toContain("The Waterfall Auction is complete");
      expect(status()!.textContent).toContain("Waiting for Ben to set the B&O’s par price.");
      // Truthful timing: the Stock Round opens after the par, by a player's Proceed -- not "next" by itself.
      expect(status()!.textContent).toContain("Stock Round 1 can open once the par is set.");
      expect(document.querySelectorAll("button")).toHaveLength(0);
    }
  });

  it("a par owed mid-auction: the owner is asked; everyone else reads that the auction goes on after it", () => {
    draw({ owner: P2, handoff: false, viewer: P2 });
    expect(dialog()).not.toBeNull();
    draw({ owner: P2, handoff: false, viewer: P1 });
    expect(dialog()).toBeNull();
    expect(status()!.textContent).toContain("The B&O par comes first");
    expect(status()!.textContent).toContain("Waiting for Ben to set the B&O’s par price. The auction goes on once the par is set.");
    expect(text()).not.toContain("Stock Round");
  });

  it("nothing owed: every seat (actor) gets a live Proceed; it is the only action and it sends", () => {
    for (const viewer of SEATS) {
      const onProceed = draw({ owner: null, handoff: true, viewer });
      const node = dialog();
      expect(node?.getAttribute("aria-label")).toBe("The Waterfall Auction is complete");
      const proceed = Array.from(node!.querySelectorAll("button")).find((b) => /^Proceed to Stock Round 1/.test(b.textContent ?? ""));
      expect(proceed?.disabled).toBe(false);
      expect(tabbableWithin(node!)).toContain(proceed);
      act(() => proceed!.click());
      expect(onProceed).toHaveBeenCalledTimes(1);
      expect(status()).toBeNull();
    }
  });

  it("watcher and spectator: never the card or a Proceed the server refuses -- a status saying a player opens the round", () => {
    for (const [viewer, spectator] of [[WATCHER, false], [null, false], [P1, true]] as const) {
      draw({ owner: null, handoff: true, viewer, spectator });
      expect(dialog()).toBeNull();
      expect(document.querySelectorAll("button")).toHaveLength(0);
      expect(status()!.textContent).toContain("Waiting for a player to open Stock Round 1.");
    }
    // ...and while the par is owed, a watcher is told who it waits on, like any other non-owner.
    draw({ owner: P2, handoff: true, viewer: WATCHER });
    expect(status()!.textContent).toContain("Waiting for Ben to set the B&O’s par price.");
    // The owner's own seat opened as a spectator is not asked.
    draw({ owner: P2, handoff: true, viewer: P2, spectator: true });
    expect(dialog()).toBeNull();
    expect(status()!.textContent).toContain("Waiting for Ben to set the B&O’s par price.");
  });

  it("outside the auction's two decisions it renders nothing for anybody", () => {
    for (const viewer of [P1, WATCHER]) {
      draw({ owner: null, handoff: false, viewer });
      expect(container.innerHTML).toBe("");
      expect(dialog()).toBeNull();
    }
  });
});

/* ================================================================================================== */
describe("the shell wires both prompts through the one viewer policy", () => {
  const APP = readShell();

  it("the auction's par and handoff are decided by the shared rules, from the live board's seats", () => {
    expect(APP).toContain("const boParViewerIsOwner = viewerIsNamedActor({ spectator, actor: boParOwner, viewerAddress });");
    const handoff = sliceBetween(APP, "const auctionHandoffViewerActs = viewerIsSeatedPlayer({", "});");
    expect(handoff).toContain("spectator,");
    expect(handoff).toContain("seats: liveState?.player_addresses,");
    const mount = sliceBetween(APP, "<AuctionPromptModal", "/>");
    expect(mount).toContain("parPending={boParViewerIsOwner}");
    expect(mount).toContain("viewerActsOnHandoff={auctionHandoffViewerActs}");
  });

  it("the home station still asks W1-J's rule, and the President's errand still hides the card for the map (#440)", () => {
    const mount = sliceBetween(APP, "<HomeStationPrompt", "onPlace={handlePlaceHomeStation}");
    // Phase 3 W3-J (AUD-25.04): the errand still hides the card (`homeStationPlacement !== null`), and so does that
    // corporation's placement in flight (`homePromptPending`, phase3W3JRollbacks.test.ts).
    expect(mount).toContain("pending={homePromptPending(pendingHomeToken, homeStationPlacement !== null, freeStationInFlight)}");
    expect(mount).toContain("viewerIsPresident={homeStationViewerIsPresident({");
  });
});
