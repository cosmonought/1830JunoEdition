/** @jest-environment jsdom */
//
// ==================================================================
//  6.5-B (H-02) HARNESS: THE B&O PAR PROMPT FOLLOWS THE BOARD, WHATEVER HAPPENED TO A CLICK
// ==================================================================
//
// The prompt used to be a `useState` latch, raised by the auction win and CLEARED ON THE CLICKING CLIENT BEFORE
// `SetBoPar` WAS SENT. A send that never landed, or one the server refused, took the par control away from the one
// player who owed it and showed them a Proceed the server refuses, while every other seat waited -- until a reload.
//
// The shell now reads one fact: `boParOwner = boParOwedTo(liveBoard)` (DA-3's derived obligation). This drives a
// real standard-game auction through a `RoomSession` to the B&O award and renders `AuctionPromptModal` for each seat
// with the shell's own prop expressions over that board:
//   parPending      = boParOwner !== null && boParOwner === viewer
//   awaitingParFrom = boParOwner !== null && boParOwner !== viewer ? label(boParOwner) : null
// through the award, a lost submission, a refused one, the held button, a successful retry, and a restore.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { AuctionPromptModal, PAR_NOT_LANDED_NOTE, PAR_SEND_HOLD_MS, PAR_SETTLE_GRACE_MS } from "./AuctionPromptModal";
import type { GameStateResponse } from "../gameEngine/gameState";
import { boParOwedTo, auctionHandoffRefusal } from "../gameEngine/auctionAuthority";
import { RoomSession } from "../utils/roomSession";
import { sandboxReplayProviders } from "../gameEngine/replayProviders";
import { stateDigest } from "../gameEngine/stateDigest";
import { actingAddress } from "../gameEngine/gameState";
import { waterfallForRoster, withEmptyRoster } from "../gameEngine/gameSetup";
import * as SS from "../gameEngine/sandboxState";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
global.IS_REACT_ACT_ENVIRONMENT = true;

const A = "p-65b-a01";
const B = "p-65b-b02";
const C = "p-65b-c03";
const LABELS: Record<string, string> = { [A]: "Ann", [B]: "Ben", [C]: "Cy" };
const label = (address: string) => LABELS[address] ?? address;
const BUILD = "b-65b-par";

const SETUP = {
  SetupGame: {
    players: [
      { id: A, nickname: "Ann" },
      { id: B, nickname: "Ben" },
      { id: C, nickname: "Cy" },
    ],
    variants: { delayedAuction: false, length: "standard", rules: 1 },
  },
};
const BUY = { WaterfallBuyLowest: { game_id: 0 } };
const OPEN = { OpenStockRound: {} };
const PAR = (player: string, par = "100") => ({ SetBoPar: { player, par_value: par } });
const seed = () => ({
  state: withEmptyRoster(SS.sandboxScenarioState(SS.DEFAULT_SANDBOX_SCENARIO, 0, "default")),
  waterfall: waterfallForRoster(SS.sandboxWaterfallState(SS.sandboxScenario(SS.DEFAULT_SANDBOX_SCENARIO).phase, 0, true), []),
});

function newRoom(tag: string) {
  let minted = 0;
  const room = new RoomSession({ providers: sandboxReplayProviders(), seed: seed() as never, build: BUILD, mintId: () => `${tag}${(minted += 1)}` });
  const submit = (actor: string, msg: unknown) =>
    room.submit({ actor, build: BUILD, msg: msg as never, baseIndex: room.nextIndex - 1, host: A });
  return { room, submit };
}

/** The standard auction, bought out lowest-first: the B&O private goes last, and its par is then owed. */
function awarded() {
  const t = newRoom("a");
  expect(t.submit(A, SETUP).kind).toBe("applied");
  for (let guard = 0; (t.room.state.waterfall?.privates.length ?? 0) > 0; guard += 1) {
    if (guard > 12) throw new Error("the auction did not advance");
    expect(t.submit(actingAddress(t.room.state, t.room.state.waterfall ?? null) as string, BUY).kind).toBe("applied");
  }
  const owner = boParOwedTo(t.room.state);
  if (!owner) throw new Error("the B&O par is not owed after the award");
  return { ...t, owner };
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host);
  });
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  jest.useRealTimers();
});

/** `AuctionPromptModal` as the shell mounts it for `viewer`, over `board` (live, never scrubbed). */
function drawPrompt(board: GameStateResponse, viewer: string | null, onConfirmPar: (par: string) => void | Promise<unknown>) {
  const boParOwner = boParOwedTo(board);
  act(() => {
    root.render(
      <AuctionPromptModal
        parPending={boParOwner !== null && boParOwner === viewer}
        parWinnerLabel={boParOwner !== null ? label(boParOwner) : ""}
        onConfirmPar={onConfirmPar}
        handoffPending={board.current_round_type === "WaterfallAuction" && (board.waterfall?.privates.length ?? -1) === 0}
        awaitingParFrom={boParOwner !== null && boParOwner !== viewer ? label(boParOwner) : null}
        onProceed={() => undefined}
      />,
    );
  });
}

const confirmButton = () =>
  Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find((button) => /President|Sending/.test(button.textContent ?? ""));
const proceedButton = () =>
  Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find((button) => /^Proceed to/.test(button.textContent ?? ""));
const click = (node: Element | null | undefined) => {
  if (!node) throw new Error("nothing to click");
  act(() => {
    node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
};

describe("H-02: the award raises the par for its owner, and blocks Proceed for everybody else", () => {
  it("owner: the par ladder; others: a blocked Proceed that names the owner", () => {
    const { room, owner } = awarded();
    drawPrompt(room.state, owner, () => undefined);
    expect(host.textContent).toContain(`${label(owner)} wins the Baltimore & Ohio`);
    expect(proceedButton()).toBeUndefined(); // the owner is never offered the handoff while the par is owed
    for (const other of [A, B, C].filter((seat) => seat !== owner)) {
      drawPrompt(room.state, other, () => undefined);
      expect(host.textContent).toContain(`Waiting for ${label(owner)} to set the B&O’s par price.`);
      expect(proceedButton()?.disabled).toBe(true);
    }
    // A seatless watcher too.
    drawPrompt(room.state, null, () => undefined);
    expect(proceedButton()?.disabled).toBe(true);
  });
});

describe("H-02: a SetBoPar that does not land leaves the prompt where it is", () => {
  it("LOST (never reached the server): the board still owes it, so the owner keeps the par and Proceed stays blocked", async () => {
    jest.useFakeTimers();
    const { room, submit, owner } = awarded();
    const presses: string[] = [];
    const lost = (par: string) => {
      presses.push(par); // the send is lost: the link was down, nothing reaches the room
      return Promise.resolve();
    };
    drawPrompt(room.state, owner, lost);
    click(confirmButton());
    expect(presses).toHaveLength(1);
    // The dispatch returns without the par landing; after the settle grace the press is released, with a reason.
    await act(async () => undefined);
    act(() => {
      jest.advanceTimersByTime(PAR_SETTLE_GRACE_MS);
    });
    expect(confirmButton()?.disabled).toBe(false);
    expect(host.textContent).toContain(PAR_NOT_LANDED_NOTE);
    // The next render reads the board, which did not move: the owner still has the par and can press again.
    drawPrompt(room.state, owner, lost);
    expect(host.textContent).toContain("wins the Baltimore & Ohio");
    click(confirmButton());
    expect(presses).toHaveLength(2);
    for (const other of [A, B, C].filter((seat) => seat !== owner)) {
      drawPrompt(room.state, other, () => undefined);
      expect(proceedButton()?.disabled).toBe(true);
    }
    // And the server agrees the handoff must wait.
    expect(auctionHandoffRefusal(room.state, room.state.waterfall ?? null)).toContain("The B&O par comes first");
    expect(submit(owner, OPEN).kind).toBe("refused");
  });

  it("REFUSED by the server: nothing is appended, the obligation stands, and the prompt stays", () => {
    const { room, submit, owner } = awarded();
    const before = stateDigest(room.state);
    const entries = room.entries.length;
    // A par that is not on the ladder is refused at the door.
    const refused = submit(owner, PAR(owner, "7"));
    expect(refused.kind).toBe("refused");
    expect(room.entries).toHaveLength(entries);
    expect(stateDigest(room.state)).toBe(before);
    expect(boParOwedTo(room.state)).toBe(owner);
    drawPrompt(room.state, owner, () => undefined);
    expect(host.textContent).toContain("wins the Baltimore & Ohio");
  });

  it("the confirm is held only while ITS send is in flight: gone when the par lands, released after a settle grace, and by the clock", async () => {
    jest.useFakeTimers();
    const { room, submit, owner } = awarded();
    let settle: () => void = () => undefined;
    drawPrompt(room.state, owner, () => new Promise<void>((resolve) => (settle = resolve)));
    click(confirmButton());
    expect(confirmButton()?.disabled).toBe(true);
    expect(confirmButton()?.textContent).toBe("Sending…");
    // The send settles but nothing has landed yet: still held for the grace (no second SetBoPar in that window).
    await act(async () => {
      settle();
    });
    expect(confirmButton()?.disabled).toBe(true);
    act(() => {
      jest.advanceTimersByTime(PAR_SETTLE_GRACE_MS);
    });
    expect(confirmButton()?.disabled).toBe(false);
    expect(host.textContent).toContain(PAR_NOT_LANDED_NOTE);

    // A send that never answers is released by the hold's own deadline, so the owner can never be stranded.
    drawPrompt(room.state, owner, () => new Promise<void>(() => undefined));
    click(confirmButton());
    expect(confirmButton()?.disabled).toBe(true);
    expect(host.textContent).not.toContain(PAR_NOT_LANDED_NOTE);
    act(() => {
      jest.advanceTimersByTime(PAR_SEND_HOLD_MS);
    });
    expect(confirmButton()?.disabled).toBe(false);

    // A send that LANDS: the board stops owing the par and the par card goes, on the owner's screen too.
    drawPrompt(room.state, owner, () => new Promise<void>(() => undefined));
    click(confirmButton());
    expect(submit(owner, PAR(owner, "100")).kind).toBe("applied");
    drawPrompt(room.state, owner, () => undefined);
    expect(host.textContent).not.toContain("wins the Baltimore & Ohio");
    expect(host.textContent).not.toContain(PAR_NOT_LANDED_NOTE);
  });
});

describe("H-02: a successful retry, and replay", () => {
  it("the owner's retry lands: the prompt goes on every seat, Proceed is live, and the handoff is accepted", () => {
    const { room, submit, owner } = awarded();
    expect(submit(owner, PAR(owner, "7")).kind).toBe("refused"); // the failed first attempt
    expect(submit(owner, PAR(owner, "100")).kind).toBe("applied"); // the retry
    expect(boParOwedTo(room.state)).toBeNull();
    drawPrompt(room.state, owner, () => undefined);
    expect(host.textContent).not.toContain("wins the Baltimore & Ohio");
    expect(proceedButton()?.disabled).toBe(false);
    for (const other of [A, B, C].filter((seat) => seat !== owner)) {
      drawPrompt(room.state, other, () => undefined);
      expect(proceedButton()?.disabled).toBe(false);
      expect(host.textContent).not.toContain("Waiting for");
    }
    expect(submit(owner, OPEN).kind).toBe("applied");
    expect(room.state.current_round_type).toBe("StockRound");
  });

  it("reload: a room restored from the stored entries owes the par to the same owner, and after the par owes nothing", () => {
    const { room, submit, owner } = awarded();
    const restoredBefore = newRoom("r").room;
    restoredBefore.restore(room.entries);
    expect(stateDigest(restoredBefore.state)).toBe(stateDigest(room.state));
    drawPrompt(restoredBefore.state, owner, () => undefined);
    expect(host.textContent).toContain("wins the Baltimore & Ohio");

    expect(submit(owner, PAR(owner, "90")).kind).toBe("applied");
    const restoredAfter = newRoom("s").room;
    restoredAfter.restore(room.entries);
    expect(boParOwedTo(restoredAfter.state)).toBeNull();
    drawPrompt(restoredAfter.state, owner, () => undefined);
    expect(host.textContent).not.toContain("wins the Baltimore & Ohio");
    // An undo of the par brings the obligation -- and the prompt -- back.
    const parIndex = room.entries.findIndex((entry) => JSON.parse(entry.payload).SetBoPar !== undefined);
    expect(submit(owner, { RevertTo: { index: room.entries[parIndex].index, player: owner, summary: "the par" } }).kind).toBe("applied");
    expect(boParOwedTo(room.state)).toBe(owner);
    drawPrompt(room.state, owner, () => undefined);
    expect(host.textContent).toContain("wins the Baltimore & Ohio");
  });
});
