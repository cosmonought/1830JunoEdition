/** @jest-environment node */
//
// ==================================================================
//  DA-4: WHO OPENS THE PRIVATE AUCTION, AND WHO HOLDS THE PRIORITY DEAL AFTER IT (Delayed Auction certification)
// ==================================================================
//
// `VARIANT_CERT_DELAYED_AUCTION_AUDIT_2026-09-25.md` DA-F3, DA-F4 and DA-F5, against 2018 §1.2 / §1.2.2 / §1.2.3 (the
// 48-page book's C-2.2 prints the same text): the buy-bid-turn sequence starts with the Priority Deal holder; a
// face-value purchase of the lowest private hands the card to "the player to your left"; the SV marked down to $0
// is bought by the next player "for $0 (i.e., it is free but is treated as a purchase)"; a bid award -- a lone bid
// in the cascade or a contest's winner -- does not move the card, and the sequence then "resumes with the player
// with the priority deal card". So the Priority Deal the auction hands to the Stock Round is the seat to the left
// of the auction's LAST DIRECT PURCHASER.
//
// Before DA-4:
//   DA-F3  the Delayed Auction opened on dealt seat 0, not on the holder (probe Q1);
//   DA-F4  `OpenStockRound` read the board's seat, which under the variant began on the last operating president
//          -- the card went to the last buyer himself (probe Q1);
//   DA-F5  in ANY game, the $0 taking moved the auction's cursor two seats and the seat one -- SR1 opened with the
//          last buyer instead of his left neighbour (probe R1, legitimate standard play).
// The cases are written RELATIVE TO THE OPENER (O, then L on his left, then R), so one script runs in the standard
// game and in the Delayed Auction; each script is played by whoever the auction is waiting on, with ingress asked
// before every message. The standard runs without a $0 taking are the controls: they hand off exactly as before.

import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";

export {};

type State = import("../gameEngine/gameState").GameStateResponse;
type Engine = InstanceType<typeof import("../gameEngine/replayLog").RoomEngine>;
type ExportedEntry = import("../gameEngine/replayLog").ExportedEntry;

const RL = require("../gameEngine/replayLog") as typeof import("../gameEngine/replayLog");
const { sandboxReplayProviders } = require("../gameEngine/replayProviders") as typeof import("../gameEngine/replayProviders");
const { withEmptyRoster, waterfallForRoster } = require("../gameEngine/gameSetup") as typeof import("../gameEngine/gameSetup");
const SS = require("../gameEngine/sandboxState") as typeof import("../gameEngine/sandboxState");
const { turnRefusal } = require("../gameEngine/turnAuthority") as typeof import("../gameEngine/turnAuthority");
const { applySandboxAction, operatingRoundSequenceLength } =
  require("../gameEngine/sandboxSession") as typeof import("../gameEngine/sandboxSession");
const { actingAddress } = require("../gameEngine/gameState") as typeof import("../gameEngine/gameState");
const { stateDigest } = require("../gameEngine/stateDigest") as typeof import("../gameEngine/stateDigest");
const { auctionCursorSeat, auctionPriorityDealSeat } =
  require("../gameEngine/auctionAuthority") as typeof import("../gameEngine/auctionAuthority");
const { DEVELOPMENT_CORPUS_POLICY, RULES_ENGINE_VERSION } =
  require("../gameEngine/rulesVersion") as typeof import("../gameEngine/rulesVersion");
const { RoomSession } = require("./roomSession") as typeof import("./roomSession");

const A = "p-da4-a01";
const B = "p-da4-b02";
const C = "p-da4-c03";
const SV = 1;
const CS = 2;
const DH = 3;
const MH = 4;
const CA = 5;
const BO = 6;
const BUILD = "b-da4";

const SETUP = (delayed: boolean) => ({
  SetupGame: {
    players: [
      { id: A, nickname: "A" },
      { id: B, nickname: "B" },
      { id: C, nickname: "C" },
    ],
    variants: { delayedAuction: delayed, length: "standard", rules: 1 },
    rules_engine_version: RULES_ENGINE_VERSION,
  },
});
const BUY = { WaterfallBuyLowest: { game_id: 0 } };
const PASS = { WaterfallPass: { game_id: 0 } };
const MINI_PASS = { WaterfallMiniAuctionPass: { game_id: 0 } };
const BID = (privateId: number, amount: number) => ({
  WaterfallBidHigher: { game_id: 0, private_id: privateId, bid_amount: String(amount) },
});
const OPEN = { OpenStockRound: {} };
const PAR = (player: string) => ({ SetBoPar: { player, par_value: "100" } });
const PASS_TURN = { PassTurn: { game_id: 0 } };

const seed = () => ({
  state: withEmptyRoster(SS.sandboxScenarioState(SS.DEFAULT_SANDBOX_SCENARIO, 0, "default")),
  waterfall: waterfallForRoster(SS.sandboxWaterfallState(SS.sandboxScenario(SS.DEFAULT_SANDBOX_SCENARIO).phase, 0, true), []),
});

let serial = 0;
const entry = (actor: string, msg: unknown) =>
  RL.entriesFromExport([{ index: serial, id: `da4-${serial}`, actor, at: (serial += 1), msg: msg as never }])[0];

const engineFrom = (start: { state: State; waterfall: State["waterfall"] | null }): Engine =>
  new RL.RoomEngine(sandboxReplayProviders(), start as never);
const boardOf = (engine: Engine): State =>
  ({ ...engine.snapshot.state, waterfall: engine.snapshot.waterfall }) as State;
const seatOf = (board: State) => board.player_addresses[board.active_player_index];
const holderOf = (board: State) => board.player_addresses[board.priority_deal_index];
const actorOf = (board: State) => actingAddress(board, board.waterfall ?? null) as string;
const cursorOf = (board: State) => board.waterfall?.current_turn ?? null;
const leftOf = (board: State, player: string) =>
  board.player_addresses[(board.player_addresses.indexOf(player) + 1) % board.player_addresses.length];
const ownerOf = (board: State, id: number) =>
  board.private_companies.find((entry) => entry.private_id === id)?.owner ?? null;
const priceOf = (board: State, id: number) =>
  (board.private_companies.find((entry) => entry.private_id === id) as { settled_price?: number } | undefined)
    ?.settled_price ?? null;

/** Sends one message as `actor` through BOTH locks: ingress must accept it and the room engine applies it. */
function send(engine: Engine, actor: string, msg: unknown) {
  const board = boardOf(engine);
  expect([Object.keys(msg as object)[0], turnRefusal({ state: board, waterfall: board.waterfall ?? null, actor, msg: msg as never })])
    .toEqual([Object.keys(msg as object)[0], null]);
  engine.apply(entry(actor, msg));
}

type Step = "buy" | "pass" | "mini-pass" | [number, number];
/** Plays auction steps for whoever the auction is waiting on; returns each direct purchaser, in order -- the buyer
 *  of a face-value purchase, and the taker of the SV at $0 (§1.2.3: "treated as a purchase"). */
function play(engine: Engine, steps: readonly Step[]): string[] {
  const direct: string[] = [];
  for (const step of steps) {
    const before = boardOf(engine);
    const actor = actorOf(before);
    const msg = step === "buy" ? BUY : step === "pass" ? PASS : step === "mini-pass" ? MINI_PASS : BID(step[0], step[1]);
    send(engine, actor, msg);
    const after = boardOf(engine);
    if (step === "buy") direct.push(actor);
    if (step === "pass" && ownerOf(before, SV) === null && ownerOf(after, SV) !== null) {
      expect(priceOf(after, SV)).toBe(0);
      direct.push(ownerOf(after, SV) as string);
    }
    // THE MIRROR: after every message the board's seat names the player the auction is waiting on next.
    if (after.waterfall?.mini_auction == null) expect(seatOf(after)).toBe(cursorOf(after));
  }
  return direct;
}

/** The B&O's owner pars it (owed first, DA-3), then the handoff; returns the board of the Stock Round it opens. */
function handOff(engine: Engine): State {
  const closed = boardOf(engine);
  expect(closed.waterfall?.privates).toHaveLength(0);
  const owner = ownerOf(closed, BO) as string;
  send(engine, owner, PAR(owner));
  send(engine, owner, OPEN);
  const sr = boardOf(engine);
  expect(sr.current_round_type).toBe("StockRound");
  expect(seatOf(sr)).toBe(holderOf(sr)); // the holder opens the round (#353)
  return sr;
}

/* ---- the two games ------------------------------------------------------------------------------ */

function dealtStandard(): Engine {
  const engine = engineFrom(seed() as never);
  engine.apply(entry(A, SETUP(false)));
  return engine;
}

/** A REAL Stock Round 1 of the Delayed Auction moves the Priority Deal off dealt seat 0: A starts the PRR and the
 *  table passes, so the card goes to the left of the last trader (§5.0) -- B. No corporation floats, so the
 *  Operating Round is skipped and Stock Round 2 opens with B. */
function delayedAfterStockRound1(): State {
  const engine = engineFrom(seed() as never);
  engine.apply(entry(A, SETUP(true)));
  const prr = boardOf(engine).public_companies.find((company) => company.ticker === "PRR")!;
  expect(holderOf(boardOf(engine))).toBe(A);
  send(engine, A, PASS_TURN); // Sell -> Buy (#1443)
  send(engine, A, { BuyStock: { game_id: 0, protocol_id: prr.company_id, source: "Ipo", par_value: "100" } });
  send(engine, A, PASS_TURN); // ends A's turn
  for (let guard = 0; boardOf(engine).macro_round_number === 1; guard += 1) {
    if (guard > 8) throw new Error("Stock Round 1 did not end");
    send(engine, seatOf(boardOf(engine)), PASS_TURN);
  }
  const sr2 = boardOf(engine);
  expect(sr2.current_round_type).toBe("StockRound");
  expect(sr2.macro_round_number).toBe(2);
  expect(holderOf(sr2)).toBe(B); // 1. the Priority Deal moved during Stock Round 1
  return sr2;
}

/** The end of the Operating Round set in which the first 3-train was bought -- HAND-BUILT on the real board above:
 *  the NYC floated, president C (the last operating president), trains 2 + 3, home station down, the set's last OR
 *  at its end. The one piece of the path not played for real (DA-7's certification game plays all of it). */
function delayedOperatingRoundEnd(): State {
  const real = delayedAfterStockRound1();
  const roster = real.player_addresses;
  const nyc = real.public_companies.find((company) => company.ticker === "NYC")!;
  return {
    ...real,
    current_round_type: "OperatingRound",
    sub_round_index: operatingRoundSequenceLength({ public_companies: [{ company_id: 1, owned_trains: ["3"] }] } as never),
    active_operating_order: [nyc.company_id],
    active_corporation_index: 0,
    active_player_index: roster.indexOf(C),
    public_companies: real.public_companies.map((company) =>
      company.company_id === nyc.company_id
        ? {
            ...company,
            is_floated: true,
            president: C,
            par_value: "100",
            owned_trains: ["2", "3"],
            player_holdings: [{ player: C, percentage: 60 }],
            ipo_pool_percentage: 40,
            station_token_hexes: ["G19"],
          }
        : company,
    ),
  } as State;
}

/** The set ends through the room engine: the delayed auction is inserted and armed by the reducer's own transition. */
function delayedArmed(): Engine {
  const orEnd = delayedOperatingRoundEnd();
  const engine = engineFrom({ state: orEnd, waterfall: orEnd.waterfall ?? null });
  expect(actorOf(orEnd)).toBe(C);
  send(engine, C, PASS_TURN);
  const armed = boardOf(engine);
  expect(armed.current_round_type).toBe("WaterfallAuction");
  expect(armed.waterfall?.waterfall_auction_active).toBe(true);
  return engine;
}

const GAMES: Array<["standard" | "delayed", () => Engine]> = [
  ["standard", dealtStandard],
  ["delayed", delayedArmed],
];

/** O (the opener), L on his left, R on L's left -- the relative seats every script below is written in. */
function seatsFrom(board: State) {
  const O = actorOf(board);
  const L = leftOf(board, O);
  const R = leftOf(board, L);
  return { O, L, R };
}

/* ================================================================================================== */
describe("DA-F3: the auction opens with the Priority Deal holder", () => {
  it("1. the Delayed Auction seats its cursor on the holder (B) -- not dealt seat 0 (A), not the last operating president (C)", () => {
    const armed = boardOf(delayedArmed());
    expect(holderOf(armed)).toBe(B);
    expect(cursorOf(armed)).toBe(B);
    expect(cursorOf(armed)).not.toBe(armed.player_addresses[0]);
    expect(cursorOf(armed)).not.toBe(C);
  });

  it("2. the acting player, the board's seat and the auction's cursor agree at the opening -- and only he may act", () => {
    const armed = boardOf(delayedArmed());
    expect(actorOf(armed)).toBe(B);
    expect(seatOf(armed)).toBe(B);
    expect(auctionCursorSeat(armed)).toBe(armed.priority_deal_index);
    for (const player of [A, C]) {
      expect(turnRefusal({ state: armed, waterfall: armed.waterfall ?? null, actor: player, msg: BUY as never })).not.toBeNull();
    }
    const bought = applySandboxAction(armed, BUY as never, { actor: B } as never);
    expect(ownerOf(bought, SV)).toBe(B);
    expect(cursorOf(bought)).toBe(C);
    expect(seatOf(bought)).toBe(C);
  });

  it("3. the standard deal still opens on the initial holder, dealt seat 0 -- unchanged", () => {
    const dealt = boardOf(dealtStandard());
    expect(dealt.priority_deal_index).toBe(0);
    expect(cursorOf(dealt)).toBe(dealt.player_addresses[0]);
    expect(seatOf(dealt)).toBe(dealt.player_addresses[0]);
    expect(actorOf(dealt)).toBe(dealt.player_addresses[0]);
  });
});

/* ================================================================================================== */
describe("DA-F4: the Priority Deal after the auction is the auction's own record", () => {
  it("4. a Delayed Auction after an Operating Round whose last president is not the holder hands the card to the left of its last buyer", () => {
    const engine = delayedArmed();
    const direct = play(engine, ["buy", "buy", "buy", "buy", "buy", "buy"]);
    expect(direct[0]).toBe(B); // the holder opened it
    const last = direct[direct.length - 1];
    const sr = handOff(engine);
    expect(holderOf(sr)).toBe(leftOf(sr, last));
    expect(holderOf(sr)).not.toBe(last); // probe Q1: the card went to the last buyer himself
  });

  it("4b. with no auction atom on the board there is no auction record, so the handoff leaves the card where it was -- never on the seat", () => {
    const dealt = boardOf(dealtStandard());
    const { waterfall: _atom, ...atomless } = dealt;
    const board = { ...atomless, active_player_index: 2, priority_deal_index: 1 } as State;
    expect(auctionPriorityDealSeat(board)).toBe(1);
    const sr = applySandboxAction(board, OPEN as never, { actor: A } as never);
    expect(sr.current_round_type).toBe("StockRound");
    expect(sr.priority_deal_index).toBe(1); // before DA-4: the seat, 2
  });

  for (const [game, start] of GAMES) {
    it(`5. [${game}] each face-value purchase moves the card to the buyer's left, and the sequence goes on from there`, () => {
      const engine = start();
      for (let n = 0; n < 6; n += 1) {
        const buyer = actorOf(boardOf(engine));
        play(engine, ["buy"]);
        const after = boardOf(engine);
        expect(cursorOf(after)).toBe(leftOf(after, buyer));
        expect(auctionPriorityDealSeat(after)).toBe(after.player_addresses.indexOf(leftOf(after, buyer)));
      }
    });

    it(`6. [${game}] a contest's award does not move it`, () => {
      const engine = start();
      const { O, L, R } = seatsFrom(boardOf(engine));
      // O SV, L CS, R DH, O MH; L and R bid on the B&O; O buys the C&A and the B&O's contest opens; L passes, R wins.
      const direct = play(engine, ["buy", "buy", "buy", "buy", [BO, 225], [BO, 230], "buy"]);
      expect(boardOf(engine).waterfall?.mini_auction?.private_id).toBe(BO);
      play(engine, ["mini-pass"]);
      const closed = boardOf(engine);
      expect(ownerOf(closed, BO)).toBe(R);
      expect(direct).toEqual([O, L, R, O, O]);
      const sr = handOff(engine);
      expect(holderOf(sr)).toBe(L); // left of O, the last direct purchaser
      expect(holderOf(sr)).not.toBe(leftOf(sr, R)); // not left of the winner
    });

    it(`7. [${game}] a lone-bid cascade award does not move it`, () => {
      const engine = start();
      const { O, L, R } = seatsFrom(boardOf(engine));
      // O SV, L CS, R DH; O bids on the C&A, L on the B&O; R buys the M&H and the cascade awards both lone bids.
      const direct = play(engine, ["buy", "buy", "buy", [CA, 165], [BO, 225], "buy"]);
      const closed = boardOf(engine);
      expect(ownerOf(closed, CA)).toBe(O);
      expect(ownerOf(closed, BO)).toBe(L);
      expect(closed.waterfall?.privates).toHaveLength(0);
      expect(direct).toEqual([O, L, R, R]);
      const sr = handOff(engine);
      expect(holderOf(sr)).toBe(O); // left of R
      expect(holderOf(sr)).not.toBe(leftOf(sr, L)); // not left of the last award
    });

    it(`8. [${game}] after a contest the sequence resumes on the holder, and the next direct purchase moves the card`, () => {
      const engine = start();
      const { O, L, R } = seatsFrom(boardOf(engine));
      // O SV; L and R bid on the D&H; O buys the C&SL and the D&H's contest opens; L passes, R wins it.
      play(engine, ["buy", [DH, 75], [DH, 80], "buy", "mini-pass"]);
      const resumed = boardOf(engine);
      expect(ownerOf(resumed, DH)).toBe(R);
      expect(actorOf(resumed)).toBe(L); // §1.2.2: "resumes with the player with the priority deal card" -- left of O
      expect(seatOf(resumed)).toBe(L);
      const direct = play(engine, ["buy", "buy", "buy"]); // L M&H, R C&A, O B&O
      expect(direct).toEqual([L, R, O]);
      const sr = handOff(engine);
      expect(holderOf(sr)).toBe(L); // left of O
    });
  }
});

/* ================================================================================================== */
describe("DA-F5: the $0 SV taking is a purchase, and the pointer survives it", () => {
  for (const [game, start] of GAMES) {
    it(`9. [${game}] the SV walked to $0, taken, then five purchases: the card goes to the left of the last buyer`, () => {
      const engine = start();
      const opening = boardOf(engine);
      const { O, L, R } = seatsFrom(opening);
      const holderBefore = holderOf(opening);
      expect(holderBefore).toBe(O); // 1. the holder before the taking opened the auction
      // Four laps of passes: 20 -> 15 -> 10 -> 5 -> 0, and the next player to take a turn -- O -- takes it.
      const taking = play(engine, Array(12).fill("pass"));
      const taken = boardOf(engine);
      expect(taking).toEqual([O]); // 2. who takes it: the next player after the last passer
      expect(ownerOf(taken, SV)).toBe(O);
      expect(priceOf(taken, SV)).toBe(0);
      expect(cursorOf(taken)).toBe(L); // 3. the cursor passes the taker -- "treated as a purchase"
      expect(seatOf(taken)).toBe(L); //    and the seat mirrors it (it fell one behind before DA-4)
      expect(actorOf(taken)).toBe(L); // 4. the next buy-bid turn is L's
      const later = play(engine, ["buy", "buy", "buy", "buy", "buy"]); // 6. later face-value purchases
      expect(later).toEqual([L, R, O, L, R]);
      const sr = handOff(engine);
      expect(holderOf(sr)).toBe(O); // 7. left of R, the last buyer -- probe R1 gave R himself
      expect(holderOf(sr)).not.toBe(R);
    });

    it(`10. [${game}] a $0 taking that cascades through every standing bid stays coherent to the end`, () => {
      const engine = start();
      const { O, L, R } = seatsFrom(boardOf(engine));
      // Five standing bids, then four laps of passes from R: L's twelfth pass puts the SV at $0 and R takes it; the
      // cascade (5. bid resolution) awards every lone bid and the auction ends inside the taking.
      play(engine, [[CS, 45], [DH, 75], [MH, 115], [CA, 165], [BO, 225]]);
      const taking = play(engine, Array(12).fill("pass"));
      const closed = boardOf(engine);
      expect(taking).toEqual([R]);
      expect(ownerOf(closed, SV)).toBe(R);
      expect([CS, DH, MH, CA, BO].map((id) => ownerOf(closed, id))).toEqual([O, L, R, O, L]);
      expect(closed.waterfall?.privates).toHaveLength(0);
      expect(cursorOf(closed)).toBe(O); // left of R: the awards did not move it
      expect(seatOf(closed)).toBe(O);
      const sr = handOff(engine);
      expect(holderOf(sr)).toBe(O);
      expect(holderOf(sr)).not.toBe(R); // before DA-4: the taker himself
    });
  }

  it("11. a standard auction without a $0 taking hands off exactly as before: the #1235 seat and the auction's pointer agree", () => {
    const engine = dealtStandard();
    const { O, L, R } = seatsFrom(boardOf(engine));
    // O SV; L and R bid on the M&H; O passes; L C&SL, R D&H -- the M&H's contest opens; L passes, R wins; then
    // O and L buy the last two. Bids, a pass, a contest and face-value buys -- no markdown.
    play(engine, ["buy", [MH, 115], [MH, 120], "pass", "buy", "buy", "mini-pass"]);
    expect(ownerOf(boardOf(engine), MH)).toBe(R);
    const direct = play(engine, ["buy", "buy"]);
    expect(direct).toEqual([O, L]);
    const closed = boardOf(engine);
    expect(closed.waterfall?.privates).toHaveLength(0);
    // The two readings -- the seat #1235 read, and the auction's own pointer DA-4 reads -- name one player.
    expect(auctionPriorityDealSeat(closed)).toBe(closed.active_player_index);
    const sr = handOff(engine);
    expect(holderOf(sr)).toBe(leftOf(sr, direct[direct.length - 1]));
    expect(holderOf(sr)).toBe(R); // left of L, the last buyer -- what the seat read before DA-4 as well
  });
});

/* ================================================================================================== */
describe("replay, restore and RevertTo rebuild the pointer from the log alone", () => {
  function roomFrom(start: State) {
    let n = 0;
    const room = new RoomSession({
      providers: sandboxReplayProviders(),
      seed: { state: start, waterfall: start.waterfall ?? null } as never,
      build: BUILD,
      mintId: () => `r${(n += 1)}`,
    });
    const submit = (actor: string, msg: unknown) =>
      room.submit({ actor, build: BUILD, msg: msg as never, baseIndex: room.nextIndex - 1, host: A });
    const next = () => actingAddress(room.state, room.state.waterfall ?? null) as string;
    return { room, submit, next };
  }
  const restoredFrom = (start: State, entries: ReadonlyArray<unknown>) => {
    let m = 0;
    const restored = new RoomSession({
      providers: sandboxReplayProviders(),
      seed: { state: start, waterfall: start.waterfall ?? null } as never,
      build: BUILD,
      mintId: () => `q${(m += 1)}`,
    });
    restored.restore(entries as never);
    return restored.state;
  };
  const pointers = (board: State) => ({
    round: board.current_round_type,
    cursor: cursorOf(board),
    seat: seatOf(board),
    holder: holderOf(board),
  });

  it("12. a restored Delayed Auction room has the same cursor, seat and digest", () => {
    const orEnd = delayedOperatingRoundEnd();
    const { room, submit, next } = roomFrom(orEnd);
    expect(submit(C, PASS_TURN).kind).toBe("applied");
    for (const msg of [BUY, BID(DH, 75), BID(DH, 80), BUY, MINI_PASS, BUY]) expect(submit(next(), msg).kind).toBe("applied");
    const restored = restoredFrom(orEnd, room.entries);
    expect(stateDigest(restored)).toBe(stateDigest(room.state));
    expect(pointers(restored)).toEqual(pointers(room.state));
    expect(cursorOf(room.state)).toBe(A); // B, C, A: B SV, C and A bid, B C&SL, C passes the contest, C M&H -> A
  });

  it("13. RevertTo behind the arming removes the auction; replaying into it seats the restored holder; RevertTo inside it rebuilds the pointer", () => {
    const orEnd = delayedOperatingRoundEnd();
    const { room, submit, next } = roomFrom(orEnd);
    const armingIndex = room.nextIndex;
    expect(submit(C, PASS_TURN).kind).toBe("applied");
    expect(pointers(room.state)).toEqual({ round: "WaterfallAuction", cursor: B, seat: B, holder: B });
    // Behind the trigger: no auction, the Operating Round's seat, the dormant atom as dealt.
    expect(submit(C, { RevertTo: { index: armingIndex, player: C, summary: "the set's end" } }).kind).toBe("applied");
    expect(room.state.current_round_type).toBe("OperatingRound");
    expect(room.state.waterfall?.waterfall_auction_active).toBe(false);
    expect(seatOf(room.state)).toBe(C);
    // Back into it: armed again, on the holder the rebuilt board carries.
    expect(submit(C, PASS_TURN).kind).toBe("applied");
    expect(pointers(room.state)).toEqual({ round: "WaterfallAuction", cursor: B, seat: B, holder: B });
    // Inside it: three buys, the third undone -- the pointer is back on the third buyer, then the auction finishes.
    for (let n = 0; n < 2; n += 1) expect(submit(next(), BUY).kind).toBe("applied");
    const thirdIndex = room.nextIndex;
    expect(submit(next(), BUY).kind).toBe("applied");
    expect(cursorOf(room.state)).toBe(B);
    expect(submit(A, { RevertTo: { index: thirdIndex, player: A, summary: "the D&H" } }).kind).toBe("applied");
    expect(pointers(room.state)).toEqual({ round: "WaterfallAuction", cursor: A, seat: A, holder: B });
    for (let n = 0; n < 4; n += 1) expect(submit(next(), BUY).kind).toBe("applied"); // A, B, C, A
    const owner = ownerOf(room.state, BO) as string;
    expect(submit(owner, PAR(owner)).kind).toBe("applied");
    expect(submit(owner, OPEN).kind).toBe("applied");
    expect(holderOf(room.state)).toBe(leftOf(room.state, A));
    expect(stateDigest(restoredFrom(orEnd, room.entries))).toBe(stateDigest(room.state));
  });

  it("13b. the standard $0 path survives RevertTo and restore", () => {
    const start = seed() as unknown as { state: State; waterfall: State["waterfall"] | null };
    const board = { ...start.state, waterfall: start.waterfall } as State;
    const { room, submit, next } = roomFrom(board);
    expect(submit(A, SETUP(false)).kind).toBe("applied");
    for (let n = 0; n < 11; n += 1) expect(submit(next(), PASS).kind).toBe("applied");
    const takingIndex = room.nextIndex;
    expect(submit(next(), PASS).kind).toBe("applied"); // C's pass: A takes the SV at $0
    expect(pointers(room.state)).toMatchObject({ cursor: B, seat: B });
    expect(submit(C, { RevertTo: { index: takingIndex, player: C, summary: "the twelfth pass" } }).kind).toBe("applied");
    expect(ownerOf(room.state, SV)).toBeNull();
    expect(pointers(room.state)).toMatchObject({ cursor: C, seat: C });
    expect(submit(next(), PASS).kind).toBe("applied");
    expect(ownerOf(room.state, SV)).toBe(A);
    expect(pointers(room.state)).toMatchObject({ cursor: B, seat: B });
    for (let n = 0; n < 5; n += 1) expect(submit(next(), BUY).kind).toBe("applied"); // B, C, A, B, C
    const owner = ownerOf(room.state, BO) as string;
    expect(submit(owner, PAR(owner)).kind).toBe("applied");
    expect(submit(owner, OPEN).kind).toBe("applied");
    expect(holderOf(room.state)).toBe(A); // left of C
    expect(stateDigest(restoredFrom(board, room.entries))).toBe(stateDigest(room.state));
  });

  it("14. the room's applied log, a replay of it and the reducer applied directly agree on the Priority Deal", () => {
    const orEnd = delayedOperatingRoundEnd();
    const { room, submit, next } = roomFrom(orEnd);
    expect(submit(C, PASS_TURN).kind).toBe("applied");
    for (const msg of [BUY, BID(CA, 165), BID(BO, 225), BUY]) expect(submit(next(), msg).kind).toBe("applied");
    for (let n = 0; n < 12; n += 1) expect(submit(next(), PASS).kind).toBe("applied"); // not a markdown: the SV is sold
    let lastBuyer = "";
    while ((room.state.waterfall?.privates.length ?? 0) > 0) {
      lastBuyer = next();
      expect(submit(lastBuyer, BUY).kind).toBe("applied");
    }
    const owner = ownerOf(room.state, BO) as string;
    expect(submit(owner, PAR(owner)).kind).toBe("applied");
    expect(submit(owner, OPEN).kind).toBe("applied");
    const roomBoard = room.state;
    // The room hands the card to the left of the last direct purchaser -- the lone-bid awards after it do not count.
    expect(lastBuyer).toBe(A);
    expect(holderOf(roomBoard)).toBe(leftOf(roomBoard, lastBuyer));
    // Replayed from the stored entries.
    const replayed = RL.replayLog(
      room.entries as never,
      sandboxReplayProviders(),
      { state: orEnd, waterfall: orEnd.waterfall ?? null } as never,
    ).state as State;
    expect(stateDigest(replayed)).toBe(stateDigest(roomBoard));
    // The reducer, message by message, with no room and no engine.
    let direct: State = orEnd;
    for (const stored of room.entries) {
      direct = applySandboxAction(direct, JSON.parse(stored.payload), { actor: stored.actor } as never);
    }
    expect(holderOf(direct)).toBe(holderOf(roomBoard));
    expect(holderOf(roomBoard)).toBe(holderOf(replayed));
  });
});

/* ================================================================================================== */
describe("the stored corpus: every handoff keeps its Priority Deal (the standard proof), and no $0 taking is stored", () => {
  /* Replays every stored log this checkout carries -- the frozen goldens always; the local development corpus
     (`server/data`, the export files, the FCJ prefix) when present, as `presidencyCorpus.test.ts` does -- and asks,
     at every `OpenStockRound` the reducer applies, whether the auction's pointer (DA-4) and the seat (#1235) name
     the same player. They must: DA-4 changes a standard handoff only after a $0 taking, and the corpus is asserted
     to hold none. A stored log that ever does is NAMED here -- DA-F5's certified correction applies to it, and DA-8's
     all-v10 scan owns what that means for the room -- rather than silently reinterpreted. Nothing is written. */
  const FROZEN_DIR = join(__dirname, "__fixtures__", "replayGolden", "logs");
  const SERVER_DIR = join(__dirname, "..", "..", "..", "server", "data");
  const EXPORT_DIR = join(__dirname, "..", "..");
  const jsonl = (file: string): ExportedEntry[] =>
    readFileSync(file, "utf8").split("\n").filter((line) => line.trim().length > 0).map((line) => JSON.parse(line) as ExportedEntry);
  const exported = (file: string): ExportedEntry[] => {
    const raw = JSON.parse(readFileSync(file, "utf8")) as { actions?: ExportedEntry[]; entries?: ExportedEntry[] };
    return raw.actions ?? raw.entries ?? [];
  };
  function corpus(): Array<{ name: string; entries: ExportedEntry[] }> {
    const out: Array<{ name: string; entries: ExportedEntry[] }> = [];
    for (const file of readdirSync(FROZEN_DIR).filter((f) => f.endsWith(".log.jsonl")).sort()) {
      out.push({ name: `golden/${file}`, entries: jsonl(join(FROZEN_DIR, file)) });
    }
    if (existsSync(SERVER_DIR)) {
      for (const file of readdirSync(SERVER_DIR).filter((f) => f.endsWith(".log.jsonl")).sort()) {
        out.push({ name: `server/${file}`, entries: jsonl(join(SERVER_DIR, file)) });
      }
    }
    if (existsSync(EXPORT_DIR)) {
      for (const file of readdirSync(EXPORT_DIR).filter((f) => /^sandbox-log-JUNO-.*\.json$/.test(f)).sort()) {
        out.push({ name: `export/${file}`, entries: exported(join(EXPORT_DIR, file)) });
      }
    }
    const prefix = join(__dirname, "__fixtures__", "JUNO-FCJ-prefix96.log.jsonl");
    if (existsSync(prefix)) out.push({ name: "prefix/JUNO-FCJ-96", entries: jsonl(prefix) });
    return out;
  }

  it("agrees at every stored handoff", () => {
    const logs = corpus();
    expect(logs.length).toBeGreaterThanOrEqual(3);
    let handoffs = 0;
    const disagreements: string[] = [];
    const zeroTakings: string[] = [];
    for (const { name, entries } of logs) {
      const observed: Array<{ index: number; msg: Record<string, unknown>; before: State }> = [];
      const result = RL.replayLog(
        RL.entriesFromExport(entries),
        sandboxReplayProviders(),
        seed() as never,
        (event) => observed.push({ index: event.entry.index, msg: event.msg as never, before: event.stateBefore }),
        DEVELOPMENT_CORPUS_POLICY,
      );
      const finalBoard = result.state as State;
      if ((finalBoard.private_companies.find((entry) => entry.private_id === SV) as { settled_price?: number } | undefined)?.settled_price === 0) {
        zeroTakings.push(name);
      }
      for (const { index, msg, before } of observed) {
        if (!("OpenStockRound" in msg) || before.current_round_type !== "WaterfallAuction") continue;
        if ((before.waterfall?.privates.length ?? 0) > 0) continue; // refused (DA-3): nothing is handed off
        handoffs += 1;
        if (auctionPriorityDealSeat(before) !== before.active_player_index) {
          disagreements.push(`${name}@${index}: pointer ${auctionPriorityDealSeat(before)} vs seat ${before.active_player_index}`);
        }
      }
    }
    expect(zeroTakings).toEqual([]);
    expect(disagreements).toEqual([]);
    expect(handoffs).toBeGreaterThanOrEqual(1);
  });
});
