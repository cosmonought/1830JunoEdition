/** @jest-environment node */
// frontend/src/utils/live2aRevert.test.ts
//
// ==================================================================
//  LIVE-2A (LIVE-2 §9.2): ONE REVERT PREDICATE, FOR THE BUTTON AND THE SERVER
// ==================================================================
//
// RV-2 ... RV-7 in `revertRefusal`, asked by `turnAuthority` for every submitted `RevertTo` and by `undoReachFor` for
// the Undo button. The property that matters most is the last describe: over thousands of generated logs, the ONE
// index the button offers is the ONE index the server accepts -- so no crafted `RevertTo` reaches further than the
// button (brief test 34), and the button never offers what the server refuses.

import {
  REVERT_DEAL_FLOOR,
  REVERT_GAME_ENDED,
  REVERT_NOTHING_DEALT,
  REVERT_NOT_YOURS,
  REVERT_NO_TARGET,
  REVERT_ONE_STEP,
  revertRefusal,
  undoReachFor,
  type RevertableAction,
} from "../gameEngine/logRevert";
import { normalizeForCommit } from "./serverIngress";

const A = "p-a";
const B = "p-b";
const deal = (index = 0, actor = A): RevertableAction => ({
  index,
  id: `d${index}`,
  actor,
  payload: JSON.stringify({ SetupGame: { players: [] } }),
});
const act = (index: number, actor: string, derived = false): RevertableAction => ({
  index,
  id: `a${index}`,
  actor,
  payload: JSON.stringify({ PassTurn: { game_id: 0 } }),
  ...(derived ? { derived: true } : {}),
});
const rev = (index: number, target: number, actor: string): RevertableAction => ({
  index,
  id: `r${index}`,
  actor,
  payload: JSON.stringify({ RevertTo: { index: target, player: actor } }),
});
const ask = (log: RevertableAction[], index: number, actor: string, isHost: boolean, board?: object) =>
  revertRefusal({ log, index, actor, isHost, board });

describe("RV-2 ... RV-7", () => {
  it("RV-2: nothing dealt, nothing to undo -- for the host too", () => {
    expect(ask([act(0, A)], 0, A, true)).toBe(REVERT_NOTHING_DEALT);
    // A deal that was itself reverted (stored history) is no deal.
    expect(ask([deal(0), act(1, A), rev(2, 0, A), act(3, A)], 3, A, true)).toBe(REVERT_NOTHING_DEALT);
    // A board SEEDED already dealt (a harness or scenario, never a server room) has its deal before the log.
    expect(ask([act(0, A)], 0, A, true, { player_addresses: [A, B] })).toBeNull();
    expect(ask([act(0, A)], 0, A, true, { player_addresses: [] })).toBe(REVERT_NOTHING_DEALT);
  });

  it("RV-3 (tests 32, 33): no undo once the game has ended or the room is closed", () => {
    const log = [deal(0), act(1, A)];
    expect(ask(log, 1, A, true, { current_round_type: "GameEnd" })).toBe(REVERT_GAME_ENDED);
    expect(ask(log, 1, A, false, { current_round_type: "GameEnd" })).toBe(REVERT_GAME_ENDED);
    expect(ask(log, 1, A, true, { current_round_type: "OperatingRound", room_closed: true })).toBe(REVERT_GAME_ENDED);
    expect(ask(log, 1, A, true, { current_round_type: "OperatingRound" })).toBeNull();
    // The button agrees: it disables with the same sentence.
    expect(undoReachFor(log, A, true, () => "x", { current_round_type: "GameEnd" }).blockedReason).toBe(REVERT_GAME_ENDED);
    expect(undoReachFor(log, A, true, () => "x", { room_closed: true }).blockedReason).toBe(REVERT_GAME_ENDED);
  });

  it("RV-4: the target is a live, non-revert entry -- no negative, past-the-end, dead or redo target", () => {
    const log = [deal(0), act(1, A), act(2, B), rev(3, 2, B), act(4, B)];
    expect(ask(log, -5, A, true)).toBe(REVERT_NO_TARGET);
    expect(ask(log, 99, A, true)).toBe(REVERT_NO_TARGET);
    expect(ask(log, 2, A, true)).toBe(REVERT_NO_TARGET); // dead: struck by the revert
    expect(ask(log, 3, A, true)).toBe(REVERT_NO_TARGET); // the revert itself: no redo (#591a)
    expect(ask(log, 1.5, A, true)).toBe(REVERT_NO_TARGET);
  });

  it("RV-5 (tests 30, 31): the deal and everything before it are the floor", () => {
    expect(ask([deal(0)], 0, A, true)).toBe(REVERT_DEAL_FLOOR);
    expect(ask([deal(0), act(1, A, true)], 0, A, true)).toBe(REVERT_DEAL_FLOOR);
    // A stored pre-deal entry (older rooms) is below the floor too.
    expect(ask([act(0, A), deal(1), act(2, A)], 0, A, true)).toBe(REVERT_DEAL_FLOOR);
    // The button right after Start used to target the deal itself; it now disables with the sentence.
    expect(undoReachFor([deal(0)], A, true, () => "x")).toEqual({ index: null, summary: "", blockedReason: REVERT_DEAL_FLOOR });
  });

  it("RV-6: one step at a time, for everyone -- the host too", () => {
    const log = [deal(0), act(1, A), act(2, B), act(3, B, true)];
    expect(ask(log, 1, A, true)).toBe(REVERT_ONE_STEP);
    expect(ask(log, 2, A, true)).toBeNull();
    expect(ask(log, 3, A, true)).toBe(REVERT_ONE_STEP); // a derived entry is never the landing
    expect(ask(log, 1, A, false)).toBe(REVERT_NOT_YOURS);
  });

  it("RV-7: a player who is not the host undoes only their own action; the host, anyone's (OD-L2-1 (a))", () => {
    const log = [deal(0), act(1, A), act(2, B)];
    expect(ask(log, 2, B, false)).toBeNull();
    expect(ask(log, 2, A, false)).toBe(REVERT_NOT_YOURS);
    expect(ask(log, 2, A, true)).toBeNull();
  });
});

describe("the button's reach is exactly what the server accepts (test 34)", () => {
  /** A small deterministic generator, so a failure names its seed. */
  const rng = (seed: number) => () => {
    seed = (seed * 1103515245 + 12345) >>> 0;
    return seed / 4294967296;
  };

  it("over 3,000 generated logs, every actor, host or not, every index from -3 to past the end", () => {
    let offered = 0;
    for (let seed = 1; seed <= 3000; seed += 1) {
      const random = rng(seed);
      const log: RevertableAction[] = [];
      const length = Math.floor(random() * 9);
      const dealAt = random() < 0.85 ? Math.floor(random() * Math.max(1, length)) : -1;
      for (let index = 0; index < length; index += 1) {
        const who = random() < 0.5 ? A : B;
        if (index === dealAt) log.push(deal(index, who));
        else if (index > 0 && random() < 0.15) log.push(rev(index, Math.floor(random() * index), who));
        else log.push(act(index, who, random() < 0.25));
      }
      const boards = [
        undefined,
        { current_round_type: "StockRound" },
        { current_round_type: "GameEnd" },
        { room_closed: true },
        { current_round_type: "OperatingRound", player_addresses: [A, B] },
      ];
      const board = boards[Math.floor(random() * boards.length)];
      for (const actor of [A, B]) {
        for (const isHost of [true, false]) {
          const reach = undoReachFor(log, actor, isHost, () => "x", board);
          for (let index = -3; index <= length + 2; index += 1) {
            const refusal = revertRefusal({ log, index, actor, isHost, board });
            if (index === reach.index) {
              expect([seed, actor, isHost, index, refusal]).toEqual([seed, actor, isHost, index, null]);
              offered += 1;
            } else {
              expect([seed, actor, isHost, index, refusal === null]).toEqual([seed, actor, isHost, index, false]);
            }
          }
        }
      }
    }
    expect(offered).toBeGreaterThan(500); // the property is not vacuous: the button offered, and was accepted
  });
});

describe("what the server commits for a RevertTo, and for proposal narration (LIVE-2 §9.2, §11.2)", () => {
  it("names the actor who pressed Undo and sanitizes the summary", () => {
    const committed = normalizeForCommit(
      { RevertTo: { index: 3, player: "p-somebody-else", summary: "Undo ‮\u0007— Buy" } },
      { board: {}, rawLog: [], actor: A },
    ) as { RevertTo: { player: string; summary: string } };
    expect(committed.RevertTo.player).toBe(A);
    expect(committed.RevertTo.summary).toBe("Undo — Buy");
  });

  it("re-derives a proposal's narration from the board, and is byte-neutral for an honest client", () => {
    const board = {
      private_companies: [{ private_id: 2, name: "Champlain & St.Lawrence", owner: B }],
      public_companies: [
        { company_id: 1, ticker: "PRR", president: A },
        { company_id: 4, ticker: "NYC", president: B },
      ],
    };
    const honest = { ProposePrivatePurchase: { private_id: 2, private_name: "Champlain & St.Lawrence", owner: B, buyer_protocol_id: 1, buyer_ticker: "PRR", price: "40" } };
    expect(normalizeForCommit(honest, { board, rawLog: [] })).toEqual(honest);
    const spoofed = { ProposePrivatePurchase: { private_id: 2, private_name: "FREE MONEY ‮", owner: "p-mallory", buyer_protocol_id: 1, buyer_ticker: "LOL", price: "40" } };
    expect(normalizeForCommit(spoofed, { board, rawLog: [] })).toEqual(honest);
    const train = { ProposeTrainPurchase: { seller_protocol_id: 4, seller_ticker: "XXX", seller_president: "p-mallory", buyer_protocol_id: 1, buyer_ticker: "YYY", model_type: "3", price: "100" } };
    expect(normalizeForCommit(train, { board, rawLog: [] })).toEqual({
      ProposeTrainPurchase: { seller_protocol_id: 4, seller_ticker: "NYC", seller_president: B, buyer_protocol_id: 1, buyer_ticker: "PRR", model_type: "3", price: "100" },
    });
    // A field the board has no value for is dropped (optional), never kept as free text.
    const unknownBuyer = { ProposePrivatePurchase: { private_id: 2, owner: B, buyer_protocol_id: 99, buyer_ticker: "ZZZ", price: "40" } };
    expect(normalizeForCommit(unknownBuyer, { board, rawLog: [] })).toEqual({ ProposePrivatePurchase: { private_id: 2, owner: B, buyer_protocol_id: 99, price: "40" } });
  });
});
