/** @jest-environment node */
//
// ==================================================================
//  UR-4 (harness): THE REDEEMER READS THE COPY THAT WAS SOLD, NOT THE MODEL (UR-F21's statistics coupling)
// ==================================================================
//
// The Redeemer (#1421) credits the president who paid the Blood Price. It read the same MODEL-LEVEL predicate the
// authority did ("the seller's `carcosan_trains` names the model, and a copy of it moved") -- so under OD-UR-5(c) = 5c-2
// a seller holding a gilded and an ordinary copy of one model who sold the ORDINARY one would still have minted a
// Redeemer. UR-4 fixes that one coupling and nothing else: the statistic now reads the transaction's own effect -- the
// seller's gilding of that model burned by the entry -- which is exactly the Blood Price and nothing but.
//
// OD-UR-6 (the statistics' basis) is UR-5's and is NOT implemented here. The Blood Price acquisition stays what it
// always was in the history: an intercorporate purchase by the buyer (train spend, the seller's `sold` fate), which
// OD-UR-6.3 confirms is a genuine purchase.
//
// THE BOARDS ARE THE REDUCER'S OWN; as in UR-3's statistics harness the history's replay engine is replaced by a script
// of those boards (`yellowSignRunBoundStats.test.ts`), and nothing else in `gameHistory.ts` is stubbed.

import type { GameStateResponse, PublicCompanyState } from "../gameEngine/gameState";

export {};

let mockScript: GameStateResponse[] | null = null;

jest.mock("../gameEngine/replayLog", () => {
  const actual = jest.requireActual("../gameEngine/replayLog");
  function RoomEngine(this: unknown, ...args: unknown[]) {
    if (mockScript === null) return new actual.RoomEngine(...args);
    return { snapshot: { state: mockScript[0], grid: { game_id: 1, tiles: [] } } };
  }
  function LegacyLogAdapters(this: unknown, ...args: unknown[]) {
    if (mockScript === null) return new actual.LegacyLogAdapters(...args);
    return {
      apply(engine: { snapshot: { state: GameStateResponse; grid: unknown } }, entry: { index: number }) {
        engine.snapshot = { ...engine.snapshot, state: mockScript![entry.index + 1] };
      },
    };
  }
  return { ...actual, RoomEngine, LegacyLogAdapters };
});

const S = require("./yellowSignRunBoundSupport") as typeof import("./yellowSignRunBoundSupport");
const { applySandboxAction } = require("../gameEngine/sandboxSession") as typeof import("../gameEngine/sandboxSession");
const { sandboxActionContext } = require("../gameEngine/actionContext") as typeof import("../gameEngine/actionContext");
const { sandboxReplayProviders } = require("../gameEngine/replayProviders") as typeof import("../gameEngine/replayProviders");
const { gameHistoryFrom } = require("./gameHistory") as typeof import("./gameHistory");

const { CO, BO, NYC, P1, P3, GULF, urBoard, companyOf } = S;

type Entry = { index: number; id: string; actor: string | null; payload: string; derived?: boolean };
type History = ReturnType<typeof gameHistoryFrom>;

const providers = sandboxReplayProviders();
const reduce = (state: GameStateResponse, msg: unknown, actor: string) =>
  applySandboxAction(state, msg as never, sandboxActionContext(providers, { state, msg: msg as never, actor, grid: GULF, gridBefore: GULF }));

/** The history of `[seed -> board -> after]`: a neutral entry that puts the SELLER's fleet on its roster (so the ledger
 *  has the rows whose fate the sale writes), then the sale. */
function historyOf(board: GameStateResponse, msg: unknown, actor: string, after: GameStateResponse): History {
  const seed = {
    ...board,
    public_companies: board.public_companies.map((c) => (c.company_id === BO ? { ...c, owned_trains: [] } : c)),
  } as GameStateResponse;
  const entries: Entry[] = [
    { index: 0, id: "ur4-seed", actor, payload: JSON.stringify({ UR4LedgerSeed: {} }) },
    { index: 1, id: "ur4-entry", actor, payload: JSON.stringify(msg) },
  ];
  mockScript = [seed, board, after];
  try {
    return gameHistoryFrom(entries.map((e) => ({ ...e, derived: false })) as never);
  } finally {
    mockScript = null;
  }
}

const accolade = (history: History, key: string) => history.accolades.find((entry) => entry.key === key)!;
const top = (history: History, key: string) => [accolade(history, key).holder, accolade(history, key).value];
const ledger = (history: History, companyId: number, model: string) =>
  history.autopsy.find((row) => row.companyId === companyId)!.fleetLedger.find((row) => row.model === model);

const GILDED_6 = { is_carcosan: true, carcosan_trains: ["6"], ghost_trains: ["6"] } as Partial<PublicCompanyState>;

/** Phase 6: B&O holds a REAL 6 and the gilded Carcosa 6; C&O (P1, who presides both) buys at Purchase Trains. */
const mixed = () =>
  urBoard({
    corps: [
      { id: CO, president: P1, trains: ["5"], treasury: 1000 },
      { id: BO, president: P1, trains: ["6", "6"], extra: GILDED_6 },
      { id: NYC, president: P3, trains: ["5", "5"] },
    ],
    step: "Hardware",
    macro: 6,
  });

const sale = (gilded: boolean) => ({
  BuyTrainFromCorporation: { game_id: 1, buyer_protocol_id: CO, seller_protocol_id: BO, model_type: "6", price: "300", gilded },
});

describe("the Redeemer credits the Blood Price, and only the Blood Price", () => {
  it("the gilded copy's sale: the buying president is the Redeemer (OD-UR-5(b): the buyer pays it)", () => {
    const board = mixed();
    const after = reduce(board, sale(true), P1);
    expect(companyOf(after, BO).carcosan_trains).toEqual([]); // the premise: the Blood Price was paid
    const history = historyOf(board, sale(true), P1, after);
    expect(top(history, "redeemer")).toEqual([P1, 1]);
    expect(ledger(history, BO, "6")?.fates).toMatchObject({ sold: 1 });
  });

  it("the ORDINARY copy's sale from the same seller mints no Redeemer (UR-F21: the model is not the copy)", () => {
    const board = mixed();
    const after = reduce(board, sale(false), P1);
    expect(companyOf(after, BO).carcosan_trains).toEqual(["6"]); // the premise: no Blood Price
    expect(companyOf(after, CO).owned_trains).toEqual(["5", "6"]);
    const history = historyOf(board, sale(false), P1, after);
    expect(top(history, "redeemer")).toEqual([null, 0]);
    // Still an ordinary sale in the ledger: the seller's copy is `sold`.
    expect(ledger(history, BO, "6")?.fates).toMatchObject({ sold: 1 });
  });
});
