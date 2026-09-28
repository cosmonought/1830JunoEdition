/** @jest-environment jsdom */
//
// ==================================================================
//  6.5-B (SI-H01 / H-01a) HARNESS: ON THE SERVER PATH THE BAR DRAWS THE LIVE OPERATING STEP
// ==================================================================
//
// 6.5-A's H-01 probe found one live disagreement between the shell's auto-skip verdict and the server's: at Buy Trains,
// right after the purchase that changes the phase, while ANOTHER corporation owes a discard and the buyer is at its
// own new limit. The server derives nothing (the discard hold); the shell says "at its train limit". Live, the bar
// happened to be right; after a RELOAD the shell's freeze started from `Track` and drew Lay Track -- with Lay Track
// controls the server refuses -- above the discard prompt the table was actually waiting on.
//
// This builds that board through a real `RoomSession` (the purchase, the phase change, the owed discard, a restore,
// the off-turn discard and the server's own turn ending) and asks `displayedOperatingSubPhase` -- the function the
// shell's Action Bar step now comes from -- at every settle point, with the legacy freeze's inputs set exactly as the
// shell would set them after a reload.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { displayedOperatingSubPhase } from "./displayedOperatingStep";
import { RoomSession } from "./roomSession";
import { sandboxReplayProviders } from "../gameEngine/replayProviders";
import { nextDerivedAction, buyTrainsAutoSkipReason, TRAIN_LIMIT_SKIP_REASON } from "../gameEngine/derivedActions";
import { pendingTrainDiscards } from "../gameEngine/trainDiscard";
import { derivePhase } from "../gameEngine/gamePhase";
import { initialOrSubPhase, type OperatingSubPhase } from "../gameEngine/operatingSubPhase";
import { stateDigest } from "../gameEngine/stateDigest";
import type { GameStateResponse } from "../gameEngine/gameState";
import { TrainDiscardPrompt } from "../components/TrainPurchasePanel";
import * as F from "./offerFixtures74";
import * as S from "./offerMatrix74Support";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
global.IS_REACT_ACT_ENVIRONMENT = true;

const { P1, P2, P3, PRR, NYC, CO } = F;
const BUILD = "b-65b-si";

/** Phase 4, every 4-train sold: PRR (Alice) operating at Buy Trains with one 4-train and $900; NYC (Bob) holds a
 *  3 and two 4s; C&O (Carol) a 4. PRR's depot purchase is the first 5-train: phase 5, limit 2. PRR ends exactly at its
 *  limit; NYC is one over and owes a discard. */
const phaseChangeBoard = (): GameStateResponse =>
  F.board({
    round: "OperatingRound",
    corps: [
      { id: PRR, ticker: "PRR", president: P1, trains: ["4"], treasury: "900" },
      { id: NYC, ticker: "NYC", president: P2, trains: ["3", "4", "4"], treasury: "400", price: 90 },
      { id: CO, ticker: "C&O", president: P3, trains: ["4"], treasury: "300", price: 80 },
    ],
    operating: PRR,
    step: "Hardware",
  });

function newRoom(seed: GameStateResponse, tag: string) {
  let minted = 0;
  const room = new RoomSession({
    providers: { ...sandboxReplayProviders(), initialGrid: S.GRID },
    seed: { state: seed, waterfall: null },
    build: BUILD,
    mintId: () => `${tag}${(minted += 1)}`,
  });
  const submit = (actor: string, msg: unknown) =>
    room.submit({ actor, build: BUILD, host: P1, msg: msg as never, baseIndex: room.nextIndex - 1 });
  return { room, submit };
}

const kinds = (answer: ReturnType<RoomSession["submit"]>) =>
  ((answer as { entries?: Array<{ payload: string; derived?: boolean }> }).entries ?? []).map(
    (entry) => `${Object.keys(JSON.parse(entry.payload))[0]}${entry.derived ? "*" : ""}`,
  );

/** What the shell's freeze would hold on this board for the ACTING president (its `autoSkipReason` at Buy Trains is
 *  the engine's `buyTrainsAutoSkipReason`, #1701): the legacy freeze's own condition. */
const shellFreezeWouldHold = (board: GameStateResponse): boolean =>
  board.operating_sub_phase === "Hardware" &&
  buyTrainsAutoSkipReason(board, board.active_operating_order[board.active_corporation_index]) !== null;

const live = (board: GameStateResponse) => board.operating_sub_phase as OperatingSubPhase;

/** The server's fresh verdict: what it would derive next on this board (6.5-A's "server owes?"). */
const owes = (board: GameStateResponse) => nextDerivedAction({ state: board, mapGrid: S.GRID, emitted: new Set<string>() });

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
});

describe("SI-H01 / H-01a: the discard-hold board at Buy Trains", () => {
  it("builds the board 6.5-A found: phase 5, PRR at its limit at Buy Trains, NYC owing a discard, the server owing nothing", () => {
    const { room, submit } = newRoom(phaseChangeBoard(), "a");
    expect(kinds(submit(P1, S.M.depot(PRR)))).toEqual(["BuyHardwareFromPool"]);
    const board = room.state;
    expect(derivePhase(board)?.tier).toBe("5");
    expect(S.trains(board, PRR)).toEqual(["4", "5"]);
    expect(board.operating_sub_phase).toBe("Hardware");
    expect(pendingTrainDiscards(board)?.required).toMatchObject({ companyId: NYC, president: P2, excess: 1, limit: 2 });
    // The server owes nothing here: this is a settle point.
    expect(owes(board)).toBeNull();
    // ...and the shell's own verdict disagrees -- which is the whole of H-01's one live difference.
    expect(buyTrainsAutoSkipReason(board, PRR)).toBe(TRAIN_LIMIT_SKIP_REASON);
    expect(shellFreezeWouldHold(board)).toBe(true);
  });

  it("after a reload, the hosted bar draws Buy Trains (the legacy freeze drew Lay Track); the discard prompt is up for NYC's president", () => {
    const first = newRoom(phaseChangeBoard(), "b");
    first.submit(P1, S.M.depot(PRR));
    // RELOAD: a fresh room restored from the stored entries -- the board a reloading client catches up to.
    const reloaded = newRoom(phaseChangeBoard(), "c");
    reloaded.room.restore(first.room.entries);
    const board = reloaded.room.state;
    expect(stateDigest(board)).toBe(stateDigest(first.room.state));

    // The shell after a reload: fresh latches, the freeze's held step starting at the pre-board cursor (`Track`).
    const afterReload = { freezeHolding: shellFreezeWouldHold(board), settled: initialOrSubPhase(null), live: live(board) };
    expect(afterReload).toEqual({ freezeHolding: true, settled: "Track", live: "Hardware" });
    // H-01a, the defect: the no-server path's freeze draws Lay Track.
    expect(displayedOperatingSubPhase({ hostedServerPath: false, ...afterReload })).toBe("Track");
    // SI-H01, the fix: the hosted server path draws the step the board is on.
    expect(displayedOperatingSubPhase({ hostedServerPath: true, ...afterReload })).toBe("Hardware");

    // The discard prompt, rendered as the shell renders it: live for NYC's president, a notice for everybody else.
    const due = pendingTrainDiscards(board)!.required;
    const prompt = (viewer: string) =>
      act(() => {
        root.render(
          <TrainDiscardPrompt
            due={{ ...due, presidentLabel: "Bob", finalRun: [] }}
            viewerIsPresident={due.president === viewer}
            onDiscard={() => undefined}
          />,
        );
      });
    prompt(P2);
    const choices = Array.from(host.querySelectorAll<HTMLButtonElement>("button")).filter((button) => !button.disabled);
    expect(choices.length).toBeGreaterThan(0);
    prompt(P1);
    expect(host.textContent).toContain("Bob");
    expect(Array.from(host.querySelectorAll<HTMLButtonElement>("button")).filter((button) => !button.disabled)).toHaveLength(0);
  });

  it("after the discard, the server ends PRR's turn by itself, and the hosted bar follows the board at every settle point", () => {
    const { room, submit } = newRoom(phaseChangeBoard(), "d");
    const settlePoints: GameStateResponse[] = [];
    submit(P1, S.M.depot(PRR));
    settlePoints.push(room.state);
    // NYC's president discards, off-turn; the same burst carries the server's own End Turn for PRR.
    const answer = submit(P2, S.M.discard(NYC, "3"));
    expect(answer.kind).toBe("applied");
    const burst = kinds(answer);
    expect(burst[0]).toBe("DiscardTrain");
    expect(burst.slice(1).some((kind) => kind.endsWith("*"))).toBe(true); // derived by the server, not by a client
    settlePoints.push(room.state);
    expect(pendingTrainDiscards(room.state)).toBeNull();
    // PRR's turn is over: the next corporation operates, and its turn opens on Lay Track (#1440).
    expect(room.state.active_operating_order[room.state.active_corporation_index]).not.toBe(PRR);
    expect(room.state.operating_sub_phase).toBe("Track");

    // THE INVARIANT, at every settle point, whatever the freeze's inputs would have been.
    for (const board of settlePoints) {
      expect(owes(board)).toBeNull();
      for (const freezeHolding of [false, true]) {
        for (const settled of ["Track", "Tokens", "Routes", "Dividends", "Hardware"] as OperatingSubPhase[]) {
          expect(displayedOperatingSubPhase({ hostedServerPath: true, freezeHolding, settled, live: live(board) })).toBe(board.operating_sub_phase);
        }
      }
    }
  });

  it("the no-server path keeps #1094/#1145 exactly: held while the freeze holds, live otherwise", () => {
    expect(displayedOperatingSubPhase({ hostedServerPath: false, freezeHolding: true, settled: "Routes", live: "Dividends" })).toBe("Routes");
    expect(displayedOperatingSubPhase({ hostedServerPath: false, freezeHolding: false, settled: "Routes", live: "Dividends" })).toBe("Dividends");
  });
});
