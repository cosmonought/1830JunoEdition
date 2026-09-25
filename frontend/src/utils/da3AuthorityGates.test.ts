/** @jest-environment node */
//
// ==================================================================
//  DA-3: THE PRIVATE AUCTION'S AUTHORITY GATES (Delayed Auction certification)
// ==================================================================
//
// `VARIANT_CERT_DELAYED_AUCTION_AUDIT_2026-09-25.md` DA-F1, DA-F2 and DA-F7. Every case below failed before DA-3,
// in the standard game as well as under the Delayed Auction (DA-1's probes P2-P5, Q1, R2):
//   DA-F1  an auction message was judged against the atom, never against whether an auction was OPEN;
//   DA-F2  `SetBoPar` asked the B&O private's owner only when there was one;
//   DA-F7  nothing but the auction modal made the B&O par come before the handoff.
// Refusals are asserted at BOTH locks -- ingress (`turnRefusal`) and the reducer, BY IDENTITY -- and through the
// room, where a refusal appends nothing. The corresponding legal moves are asserted alongside, so a gate that
// refused everything could not pass.

export {};

type State = import("../gameEngine/gameState").GameStateResponse;
type Engine = InstanceType<typeof import("../gameEngine/replayLog").RoomEngine>;

const RL = require("../gameEngine/replayLog") as typeof import("../gameEngine/replayLog");
const { sandboxReplayProviders } = require("../gameEngine/replayProviders") as typeof import("../gameEngine/replayProviders");
const { withEmptyRoster, waterfallForRoster } = require("../gameEngine/gameSetup") as typeof import("../gameEngine/gameSetup");
const SS = require("../gameEngine/sandboxState") as typeof import("../gameEngine/sandboxState");
const { turnRefusal } = require("../gameEngine/turnAuthority") as typeof import("../gameEngine/turnAuthority");
const { applySandboxAction, operatingRoundSequenceLength } =
  require("../gameEngine/sandboxSession") as typeof import("../gameEngine/sandboxSession");
const { actingAddress } = require("../gameEngine/gameState") as typeof import("../gameEngine/gameState");
const { stateDigest } = require("../gameEngine/stateDigest") as typeof import("../gameEngine/stateDigest");
const { auctionClosedRefusal, auctionHandoffRefusal, boParOwedTo, boParRefusal } =
  require("../gameEngine/auctionAuthority") as typeof import("../gameEngine/auctionAuthority");
const { RoomSession } = require("./roomSession") as typeof import("./roomSession");

const A = "p-da3-a01";
const B = "p-da3-b02";
const C = "p-da3-c03";
const SV = 1;
const BO = 6;
const BUILD = "b-da3";

const SETUP = (delayed: boolean) => ({
  SetupGame: {
    players: [
      { id: A, nickname: "A" },
      { id: B, nickname: "B" },
      { id: C, nickname: "C" },
    ],
    variants: { delayedAuction: delayed, length: "standard", rules: 1 },
  },
});
const BUY = { WaterfallBuyLowest: { game_id: 0 } };
const PASS = { WaterfallPass: { game_id: 0 } };
const OPEN = { OpenStockRound: {} };
const PAR = (player: string, par = "100") => ({ SetBoPar: { player, par_value: par } });

const seed = () => ({
  state: withEmptyRoster(SS.sandboxScenarioState(SS.DEFAULT_SANDBOX_SCENARIO, 0, "default")),
  waterfall: waterfallForRoster(SS.sandboxWaterfallState(SS.sandboxScenario(SS.DEFAULT_SANDBOX_SCENARIO).phase, 0, true), []),
});

let serial = 0;
const entry = (actor: string, msg: unknown) =>
  RL.entriesFromExport([{ index: serial, id: `da3-${serial}`, actor, at: (serial += 1), msg: msg as never }])[0];

function engineFrom(start: { state: State; waterfall: State["waterfall"] | null }): Engine {
  return new RL.RoomEngine(sandboxReplayProviders(), start as never);
}
function dealt(delayed: boolean): Engine {
  const engine = engineFrom(seed() as never);
  engine.apply(entry(A, SETUP(delayed)));
  return engine;
}
const boardOf = (engine: Engine): State =>
  ({ ...engine.snapshot.state, waterfall: engine.snapshot.waterfall }) as State;
const seatOf = (board: State) => board.player_addresses[board.active_player_index];
const cursorOf = (board: State) => actingAddress(board, board.waterfall ?? null) as string;
const cashOf = (board: State) => board.player_cash.map((row) => `${row.player}:${row.cash_vgp}`).join(" ");
const privateOwner = (board: State, id: number) =>
  board.private_companies.find((entry) => entry.private_id === id)?.owner ?? null;
const boCorp = (board: State) => board.public_companies.find((company) => company.ticker === "B&O");

/** Both locks on one board: what ingress answers, and what the reducer hands back. */
function attempt(board: State, actor: string, msg: unknown) {
  const ingress = turnRefusal({ state: board, waterfall: board.waterfall ?? null, actor, msg: msg as never });
  const after = applySandboxAction(board, msg as never, { actor } as never);
  return { ingress, after };
}
function expectRefusedAtBothLocks(board: State, actor: string, msg: unknown): string {
  const { ingress, after } = attempt(board, actor, msg);
  expect(typeof ingress).toBe("string");
  expect((ingress as string).length).toBeGreaterThan(10);
  expect(after).toBe(board); // refused BY IDENTITY at the board gate: nothing moved, not even a copy
  return ingress as string;
}
/** Plays the whole auction by face-value buys, each by whoever the auction is waiting on. */
function buyOut(engine: Engine): string[] {
  const buyers: string[] = [];
  for (let guard = 0; (engine.snapshot.waterfall?.privates.length ?? 0) > 0; guard += 1) {
    if (guard > 12) throw new Error(`the auction did not advance (round ${engine.snapshot.state.current_round_type})`);
    const who = cursorOf(boardOf(engine));
    buyers.push(who);
    engine.apply(entry(who, BUY));
  }
  return buyers;
}

/* ================================================================================================== */
describe("DA-F1: an auction message is refused unless a private company auction is open", () => {
  it("1. refuses an auction buy in the Delayed Auction's Stock Round 1 -- nobody pays for the SV", () => {
    const board = boardOf(dealt(true));
    expect(board.current_round_type).toBe("StockRound");
    const reason = expectRefusedAtBothLocks(board, seatOf(board), BUY);
    expect(reason).toBe(auctionClosedRefusal(board, board.waterfall ?? null));
    expect(privateOwner(board, SV)).toBeNull();
  });

  it("2. refuses an auction pass in Stock Round 1 -- the SV is not marked down", () => {
    const board = boardOf(dealt(true));
    for (const actor of [seatOf(board)]) expectRefusedAtBothLocks(board, actor, PASS);
    expect(board.waterfall?.privates.find((entry) => entry.private_id === SV)?.face_value).toBe("20");
  });

  it("3. a pass after a completed standard auction pays no private income -- closed atom, then Stock Round 1", () => {
    const engine = dealt(false);
    buyOut(engine);
    const closed = boardOf(engine);
    expect(closed.current_round_type).toBe("WaterfallAuction");
    expect(closed.waterfall?.waterfall_auction_active).toBe(false);
    const actor = cursorOf(closed);
    expectRefusedAtBothLocks(closed, actor, PASS);

    const owner = privateOwner(closed, BO) as string;
    engine.apply(entry(owner, PAR(owner)));
    engine.apply(entry(owner, OPEN));
    const sr1 = boardOf(engine);
    expect(sr1.current_round_type).toBe("StockRound");
    const before = cashOf(sr1);
    expectRefusedAtBothLocks(sr1, seatOf(sr1), PASS);
    expect(cashOf(sr1)).toBe(before);
  });

  it("4 + 6. the Delayed Auction is refused during the Operating Round and accepted once the first 3-train's set ends", () => {
    const base = boardOf(dealt(true));
    const roster = base.player_addresses;
    const prr = base.public_companies.find((company) => company.ticker === "PRR")!;
    const orEnd = {
      ...base,
      current_round_type: "OperatingRound",
      macro_round_number: 2,
      sub_round_index: operatingRoundSequenceLength({ public_companies: [{ company_id: 1, owned_trains: ["3"] }] } as never),
      active_operating_order: [prr.company_id],
      active_corporation_index: 0,
      active_player_index: 2,
      public_companies: base.public_companies.map((company) =>
        company.company_id === prr.company_id
          ? {
              ...company,
              is_floated: true,
              president: roster[2],
              par_value: "100",
              owned_trains: ["2", "3"],
              player_holdings: [{ player: roster[2], percentage: 60 }],
              ipo_pool_percentage: 40,
            }
          : company,
      ),
    } as State;
    // 4. Before the trigger: the operating president passes the seat check and meets the auction gate.
    expectRefusedAtBothLocks(orEnd, roster[2], BUY);
    // The set ends: the auction is inserted and armed.
    const armed = applySandboxAction(orEnd, { PassTurn: { game_id: 0 } } as never, { actor: roster[2] } as never);
    expect(armed.current_round_type).toBe("WaterfallAuction");
    expect(armed.waterfall?.waterfall_auction_active).toBe(true);
    // 6. The legitimate delayed-auction move now applies, for the player the auction is waiting on.
    const buyer = cursorOf(armed);
    const { ingress, after } = attempt(armed, buyer, BUY);
    expect(ingress).toBeNull();
    expect(privateOwner(after, SV)).toBe(buyer);
  });

  it("5. the ordinary standard auction still runs: a bid, a pass and a buy all apply", () => {
    let board = boardOf(dealt(false));
    const bidder = cursorOf(board);
    let step = attempt(board, bidder, { WaterfallBidHigher: { private_id: 3, bid_amount: "75" } });
    expect(step.ingress).toBeNull();
    expect(step.after.waterfall?.privates.find((entry) => entry.private_id === 3)?.bids).toEqual([
      { bidder, bid_amount: "75" },
    ]);
    board = step.after;
    step = attempt(board, cursorOf(board), PASS);
    expect(step.ingress).toBeNull();
    expect(step.after.waterfall?.consecutive_waterfall_passes).toBe(1);
    board = step.after;
    const buyer = cursorOf(board);
    step = attempt(board, buyer, BUY);
    expect(step.ingress).toBeNull();
    expect(privateOwner(step.after, SV)).toBe(buyer);
  });
});

/* ================================================================================================== */
describe("DA-F2: SetBoPar belongs to the B&O private's owner", () => {
  it("7. is refused while the B&O private is unsold -- the Delayed Auction's SR1 and the standard auction alike", () => {
    for (const delayed of [true, false]) {
      const board = boardOf(dealt(delayed));
      const actor = seatOf(board);
      const reason = expectRefusedAtBothLocks(board, actor, PAR(actor));
      expect(reason).toBe(boParRefusal(board, actor));
      expect(boCorp(board)?.president ?? null).toBeNull();
    }
  });

  it("8. the owner's par applies once the private is won, and the B&O then trades as an ordinary company", () => {
    const engine = dealt(true);
    const base = boardOf(engine);
    // Run the delayed game to its auction (the same inserted-auction shape as case 4), then buy it out.
    const roster = base.player_addresses;
    const prr = base.public_companies.find((company) => company.ticker === "PRR")!;
    const orEnd = {
      ...base,
      current_round_type: "OperatingRound",
      macro_round_number: 2,
      sub_round_index: operatingRoundSequenceLength({ public_companies: [{ company_id: 1, owned_trains: ["3"] }] } as never),
      active_operating_order: [prr.company_id],
      active_corporation_index: 0,
      active_player_index: 2,
      public_companies: base.public_companies.map((company) =>
        company.company_id === prr.company_id
          ? { ...company, is_floated: true, president: roster[2], par_value: "100", owned_trains: ["2", "3"],
              player_holdings: [{ player: roster[2], percentage: 60 }], ipo_pool_percentage: 40 }
          : company,
      ),
    } as State;
    // The set ends through the reducer (as in case 4); the room engine then plays the auction from that board.
    const armed = applySandboxAction(orEnd, { PassTurn: { game_id: 0 } } as never, { actor: roster[2] } as never);
    expect(armed.current_round_type).toBe("WaterfallAuction");
    const game = engineFrom({ state: armed, waterfall: armed.waterfall ?? null });
    buyOut(game);
    const won = boardOf(game);
    const owner = privateOwner(won, BO) as string;
    const other = roster.find((player) => player !== owner) as string;
    expectRefusedAtBothLocks(won, other, PAR(other));
    expect(attempt(won, owner, PAR(owner)).ingress).toBeNull();
    game.apply(entry(owner, PAR(owner)));
    expect(boCorp(boardOf(game))?.president).toBe(owner);
    game.apply(entry(owner, OPEN));
    const sr = boardOf(game);
    expect(sr.current_round_type).toBe("StockRound");
    expect(sr.private_auction_complete).toBe(true);
    // The lock is gone: an ordinary B&O share from the initial offering, bought by the Stock Round seat.
    const buyer = seatOf(sr);
    const bo = boCorp(sr)!;
    const share = { BuyStock: { game_id: 0, protocol_id: bo.company_id, source: "Ipo" } };
    expect(turnRefusal({ state: sr, waterfall: sr.waterfall ?? null, actor: buyer, msg: share as never })).toBeNull();
    game.apply(entry(buyer, share));
    const held = (board: State) => boCorp(board)?.player_holdings.find((row) => row.player === buyer)?.percentage ?? 0;
    expect(held(boardOf(game))).toBe(held(sr) + 10);
  });
});

/* ================================================================================================== */
describe("DA-F7: the B&O par is owed before the auction goes on", () => {
  function wonStandard() {
    const engine = dealt(false);
    buyOut(engine);
    const board = boardOf(engine);
    return { engine, board, owner: privateOwner(board, BO) as string };
  }

  it("9. winning the B&O private owes its par to the winner", () => {
    const { board, owner } = wonStandard();
    expect(boParOwedTo(board)).toBe(owner);
    expect(boCorp(board)?.president ?? null).toBeNull();
  });

  it("10. nobody else may take it -- in their own name or in the owner's", () => {
    const { board, owner } = wonStandard();
    const other = board.player_addresses.find((player) => player !== owner) as string;
    expectRefusedAtBothLocks(board, other, PAR(other));
    expect(attempt(board, other, PAR(owner)).ingress).toBe("Only the B&O private's owner pars the B&O.");
  });

  it("11. the handoff and every auction message wait for it", () => {
    const { board, owner } = wonStandard();
    for (const actor of board.player_addresses) {
      const reason = expectRefusedAtBothLocks(board, actor, OPEN);
      expect(reason).toBe(auctionHandoffRefusal(board, board.waterfall ?? null));
    }
    expectRefusedAtBothLocks(board, owner, PASS);
    expect(board.current_round_type).toBe("WaterfallAuction");
  });

  it("12. the owner's par clears it, and the handoff then proceeds", () => {
    const { engine, owner } = wonStandard();
    engine.apply(entry(owner, PAR(owner)));
    const parred = boardOf(engine);
    expect(boParOwedTo(parred)).toBeNull();
    expect(boCorp(parred)?.president).toBe(owner);
    expect(attempt(parred, owner, OPEN).ingress).toBeNull();
    engine.apply(entry(owner, OPEN));
    expect(boardOf(engine).current_round_type).toBe("StockRound");
  });

  it("13. restore and RevertTo rebuild the obligation from the log alone", () => {
    let n = 0;
    const room = new RoomSession({ providers: sandboxReplayProviders(), seed: seed() as never, build: BUILD, mintId: () => `r${(n += 1)}` });
    const submit = (actor: string, msg: unknown) =>
      room.submit({ actor, build: BUILD, msg: msg as never, baseIndex: room.nextIndex - 1, host: A });
    expect(submit(A, SETUP(false)).kind).toBe("applied");
    for (let guard = 0; (room.state.waterfall?.privates.length ?? 0) > 0; guard += 1) {
      if (guard > 12) throw new Error("the room's auction did not advance");
      expect(submit(actingAddress(room.state, room.state.waterfall ?? null) as string, BUY).kind).toBe("applied");
    }
    const owner = privateOwner(room.state, BO) as string;
    // Restore: a fresh room rebuilt from the stored entries owes the same par.
    let m = 0;
    const restored = new RoomSession({ providers: sandboxReplayProviders(), seed: seed() as never, build: BUILD, mintId: () => `q${(m += 1)}` });
    restored.restore(room.entries);
    expect(boParOwedTo(restored.state)).toBe(owner);
    expect(stateDigest(restored.state)).toBe(stateDigest(room.state));
    // The par, then its undo: the obligation comes back, and the handoff is refused again without an entry.
    const parIndex = room.nextIndex;
    expect(submit(owner, PAR(owner)).kind).toBe("applied");
    expect(boParOwedTo(room.state)).toBeNull();
    expect(submit(owner, { RevertTo: { index: parIndex, player: owner, summary: "the par" } }).kind).toBe("applied");
    expect(boParOwedTo(room.state)).toBe(owner);
    const length = room.entries.length;
    expect(submit(owner, OPEN).kind).toBe("refused");
    expect(room.entries).toHaveLength(length);
  });
});

/* ================================================================================================== */
describe("server path: the room refuses what the reducer refuses, and appends nothing", () => {
  function delayedRoom() {
    let n = 0;
    const room = new RoomSession({ providers: sandboxReplayProviders(), seed: seed() as never, build: BUILD, mintId: () => `s${(n += 1)}` });
    expect(room.submit({ actor: A, build: BUILD, msg: SETUP(true) as never, baseIndex: -1, host: A }).kind).toBe("applied");
    return room;
  }

  it("a forged Stock Round auction buy, pass or B&O par is answered `refused` and never reaches the log", () => {
    const room = delayedRoom();
    const seat = room.state.player_addresses[room.state.active_player_index];
    for (const msg of [BUY, PASS, PAR(seat)]) {
      const before = { log: room.entries.length, digest: stateDigest(room.state) };
      const answer = room.submit({ actor: seat, build: BUILD, msg: msg as never, baseIndex: room.nextIndex - 1, host: A });
      expect(answer.kind).toBe("refused");
      expect(room.entries).toHaveLength(before.log);
      expect(stateDigest(room.state)).toBe(before.digest);
    }
  });
});
