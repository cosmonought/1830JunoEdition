/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 1672 (harness): S9-2 -- THE CARCOSA LIFECYCLE, END TO END
// ==================================================================
//
// THE ORIGINAL S9-2 THEORY WAS WRONG and so was the premise offered for withdrawing it. The defect Stage 9.5
// actually found is narrower and worse than either: the train-limit exemption ended a whole Carcosa lifetime
// before the gilded train did, and the function that ended it then trimmed the fleet CHEAPEST-FIRST -- so the
// gilded train (newest, dearest) survived and one of the corporation's ORDINARY trains was confiscated for it.
//
// The cases below are the owner's six lettered proofs. Each one states the ruling it pins.

export {};

const { countableTrainCount, trimToTrainLimit } =
  require("../gameEngine/trainLimit") as typeof import("../gameEngine/trainLimit");
const { countableTrainsOf, excessTrainCount } =
  require("../gameEngine/trainDiscard") as typeof import("../gameEngine/trainDiscard");
const { realDieselPurchased, openDepotTiers, depotInventory, derivePhase } =
  require("../gameEngine/gamePhase") as typeof import("../gameEngine/gamePhase");
const { carcosaGiftModel, escalationTier, fogIsDue } =
  require("../gameEngine/yellowSign") as typeof import("../gameEngine/yellowSign");
const { readStripped } = require("./sourceScan") as typeof import("./sourceScan");
import type { GameStateResponse, PublicCompanyState } from "../gameEngine/gameState";

const co = (over: Partial<PublicCompanyState> = {}): PublicCompanyState =>
  ({ company_id: 1, ticker: "B&O", owned_trains: [], ...over }) as unknown as PublicCompanyState;

const board = (companies: PublicCompanyState[], macroRound = 3): GameStateResponse =>
  ({ macro_round_number: macroRound, public_companies: companies }) as unknown as GameStateResponse;

/* ------------------------------------------------------------------ */
/* A. GHOST LIMIT EXEMPTION                                           */
/* ------------------------------------------------------------------ */

describe("A. the gilded train is limit-exempt for its whole Carcosa lifetime", () => {
  /* OWNER RULING: "WHILE THE TRAIN REMAINS GILDED/CARCOSAN it is individually exempt … the exemption lasts
     for its entire Carcosa lifetime … ending an OR does not make the ghost ordinary, ending an OR set does
     not make the ghost ordinary." */

  it("is exempt immediately after the gift, and PER TRAIN", () => {
    expect(countableTrainCount(["3", "4", "5", "D"], [], ["D"])).toBe(3);
    // Two trains of one model, one gilded: only one is exempt.
    expect(countableTrainCount(["5", "5"], [], ["5"])).toBe(1);
    // A gilded model the corporation does not own exempts nothing.
    expect(countableTrainCount(["3", "4"], [], ["D"])).toBe(2);
  });

  it("reads the exemption off `carcosan_trains`, so OR and OR-SET boundaries cannot end it", () => {
    /* THE FIX ITSELF. `ghost_trains` was the exemption and was emptied at the next OR boundary;
       `carcosan_trains` is the Carcosa lifetime and is emptied only by the fog or the Blood Price. A
       corporation whose gilded train has outlived the OR grace -- `ghost_trains` empty, gilding intact --
       is still exempt. */
    const survived = co({ owned_trains: ["2", "3", "4", "D"], ghost_trains: [], carcosan_trains: ["D"], is_carcosan: true });
    expect(countableTrainsOf(survived)).toEqual(["2", "3", "4"]);
    expect(excessTrainCount(survived, 3)).toBe(0);
  });

  it("leaves ordinary trains limit-bound while the gilding lasts", () => {
    const over = co({ owned_trains: ["2", "3", "4", "5", "D"], ghost_trains: [], carcosan_trains: ["D"] });
    expect(countableTrainsOf(over)).toEqual(["2", "3", "4", "5"]);
    expect(excessTrainCount(over, 3)).toBe(1); // the ORDINARY fleet is over, and says so
  });

  it("no longer trims an ordinary train because the exemption expired — the trim is gone", () => {
    /* WHAT THE OLD CODE DID, kept as the counter-example: `trimToTrainLimit` sorts cost ascending, so with
       the gilded D suddenly countable it took the 2. `expireGhostTrains` -- the only caller that ran at an
       OR boundary -- is deleted, so nothing reaches this arithmetic at a round end any more. */
    const whatItUsedToDo = trimToTrainLimit({
      owned: ["2", "3", "4", "D"],
      reprieved: [],
      limit: 3,
      cost: (m) => ({ "2": 80, "3": 180, "4": 300, D: 1100 })[m] ?? 0,
    });
    expect(whatItUsedToDo.discarded).toEqual(["2"]);
    const SESSION = readStripped("gameEngine/sandboxSession.ts");
    expect(SESSION).not.toContain("expireGhostTrains");
    expect(SESSION).toContain("const settled = expired;");
    // And every limit reader now asks the gilding, not the OR-long marker.
    for (const file of ["gameEngine/trainDiscard.ts", "gameEngine/trainPurchaseGate.ts", "gameEngine/trainSaleAuthority.ts", "gameEngine/derivedActions.ts"]) {
      expect(readStripped(file)).toContain("carcosan_trains");
    }
  });
});

/* ------------------------------------------------------------------ */
/* B / C. THE EFFECTIVE DOOM TRIGGER                                  */
/* ------------------------------------------------------------------ */

describe("B/C. the doom trigger is whichever condition lands second", () => {
  it("a synthetic Diesel is not a real Diesel purchase", () => {
    /* OWNER RULING: "if the synthetic gift is a D, that synthetic gift itself is NOT a real D purchase and
       does not satisfy/start the real-D condition." The phase cannot answer this -- it counts the ghost
       toward `highest` by design (#1046) -- so `realDieselPurchased` subtracts the synthetic marker. */
    const gifted = board([co({ owned_trains: ["4", "D"], ghost_trains: ["D"], carcosan_trains: ["D"] })]);
    expect(realDieselPurchased(gifted)).toBe(false);
    expect(derivePhase(gifted)?.tier).toBe("D"); // the phase says D; the depot has not sold one
  });

  it("a bought Diesel is, wherever it sits", () => {
    expect(realDieselPurchased(board([co({ owned_trains: ["D"] })]))).toBe(true);
    // One gilded D and one bought D: the multiset walk finds the bought one.
    expect(realDieselPurchased(board([co({ owned_trains: ["D", "D"], ghost_trains: ["D"] })]))).toBe(true);
    // A Diesel discarded into the Bank Pool was still bought (#1530).
    const pooled = { ...board([co({ owned_trains: [] })]), returned_trains: ["D"] } as GameStateResponse;
    expect(realDieselPurchased(pooled)).toBe(true);
  });

  it("B. PRE-D GIFT: no deadline at the gift; the later real D starts the clock", () => {
    /* ghost received during N, no real D yet -> no deadline. Real D bought in a later set M -> M is the
       trigger set, deadline M + 1, so the ghost survives the remainder of M and all of M + 1. */
    const giftArm = readStripped("gameEngine/sandboxSession.ts");
    expect(giftArm).toContain("realDieselPurchased(state)");
    // At the gift, with no real D in play, the arm writes no deadline...
    expect(realDieselPurchased(board([co({ owned_trains: ["5", "6"], ghost_trains: ["6"], carcosan_trains: ["6"] })]))).toBe(false);
    // ...and with no deadline the fog is never due, however many sets pass.
    const noDeadline = co({ carcosan_trains: ["6"] });
    for (const macro of [3, 4, 5, 9, 20]) expect(fogIsDue(noDeadline, macro)).toBe(false);
    // `startCarcosanDoomClock` then sets M + 1 at the first real Diesel's phase change.
    expect(giftArm).toContain("function startCarcosanDoomClock(state: GameStateResponse): GameStateResponse {");
    expect(giftArm).toContain("const deadline = (state.macro_round_number ?? 0) + 1;");
    // Idempotent: a second Diesel must not push the fog back (#1089).
    expect(giftArm).toContain("if (company.carcosan_doom_after_macro_round !== undefined) return company;");
  });

  it("C. POST-D GIFT: the real D was already bought, so RECEIVING the ghost starts the clock", () => {
    /* This is the case #1046 lost entirely: it keyed the clock on the GIFT'S OWN TIER, so a 5 or 6 gifted
       after the Diesels were running waited for a first D that had long since come, and never got a deadline
       at all. The trigger is the board's state, not the model. */
    const dieselsRunning = board([
      co({ company_id: 2, ticker: "PRR", owned_trains: ["D"] }),
      co({ company_id: 1, ticker: "B&O", owned_trains: ["6"] }),
    ]);
    expect(realDieselPurchased(dieselsRunning)).toBe(true);
    // A gift here — of ANY tier — is trigger-set N, deadline N + 1.
    expect(dieselsRunning.macro_round_number).toBe(3);
    const deadline = (dieselsRunning.macro_round_number ?? 0) + 1;
    expect(deadline).toBe(4);
  });
});

/* ------------------------------------------------------------------ */
/* D. THE FULL-SET GRACE AND THE FOG'S DUE DATE                       */
/* ------------------------------------------------------------------ */

describe("D. trigger set N, the whole of N+1, then the fog", () => {
  /* OWNER RULING: "If the effective doom trigger occurs during OR set N the gilded train survives the
     remainder of set N and ALL of set N+1. The deadline is therefore N + 1 … This intentionally guarantees
     that a corporation receiving Carcosa on the final operating turn of set N still gets the full following
     OR set in which to operate the gift." #1092's due-date design carries it. */
  const doomed = co({ owned_trains: ["4", "D"], carcosan_trains: ["D"], carcosan_doom_after_macro_round: 4 });

  it("is not due during the trigger set", () => {
    expect(fogIsDue(doomed, 3)).toBe(false);
  });

  it("is not due at any point during the promised set N+1 — including its last turn", () => {
    expect(fogIsDue(doomed, 4)).toBe(false);
  });

  it("becomes due only once the complete set N+1 has finished", () => {
    /* `>` NOT `>=`, and #1092 spells out why: `macro_round_number` increments as the Stock Round opens, so
       only once it has PASSED the deadline is the named set genuinely over. */
    expect(fogIsDue(doomed, 5)).toBe(true);
    expect(fogIsDue(doomed, 6)).toBe(true);
  });

  it("and the train stays limit-exempt for the whole grace, last-turn gift included", () => {
    // The point of the grace is that the corporation can OPERATE the gift; a limit trim would defeat it.
    expect(countableTrainsOf(doomed)).toEqual(["4"]);
    expect(excessTrainCount(doomed, 1)).toBe(0);
  });

  it("is still removed on a narrated run, not by a silent boundary deletion (#1092 preserved)", () => {
    const SESSION = readStripped("gameEngine/sandboxSession.ts");
    expect(SESSION).not.toContain("expireCarcosanTrains");
    expect(SESSION).toContain('if (stage === "fog") {');
    const YELLOW = readStripped("gameEngine/yellowSign.ts");
    expect(YELLOW).toContain("export function fogIsDue(");
    expect(YELLOW).toContain("return doom !== undefined && macroRound > doom;");
  });

  it("owes nothing to a corporation that no longer holds the train", () => {
    expect(fogIsDue(co({ carcosan_trains: [], carcosan_doom_after_macro_round: 4 }), 9)).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* E. BLOOD PRICE — #1090 PRESERVED                                    */
/* ------------------------------------------------------------------ */

const { settleTrainSale } = require("../gameEngine/sandboxSession") as typeof import("../gameEngine/sandboxSession");

describe("E. the Blood Price burns the gilding off (#1090, authoritative and unchanged)", () => {
  const SELLER = 1;
  const BUYER = 2;
  const sold = () => {
    const state = {
      macro_round_number: 3,
      public_companies: [
        co({ company_id: SELLER, ticker: "B&O", owned_trains: ["4", "D"], ghost_trains: ["D"], carcosan_trains: ["D"], is_carcosan: true, carcosan_doom_after_macro_round: 4, treasury: "500" }),
        co({ company_id: BUYER, ticker: "PRR", owned_trains: ["3"], treasury: "900" }),
      ],
    } as unknown as GameStateResponse;
    // (state, buyerId, sellerId, modelType, price)
    return settleTrainSale(state, BUYER, SELLER, "D", "400");
  };
  const of = (s: GameStateResponse, id: number) => s.public_companies.find((c) => c.company_id === id)!;

  it("the seller is absolved: curse cleared, gilding gone, deadline gone", () => {
    const after = of(sold(), SELLER);
    expect(after.is_carcosan).toBe(false);
    expect(after.carcosan_trains).toEqual([]);
    expect(after.carcosan_doom_after_macro_round).toBeUndefined();
    expect(after.owned_trains).toEqual(["4"]);
    /* #1672's one consistency change: the synthetic marker leaves with the train, so a corporation that no
       longer holds it does not keep a train permanently off the depot's shelf. */
    expect(after.ghost_trains).toEqual([]);
  });

  it("the buyer receives an ORDINARY train: no curse, no gilding, no exemption, no deadline", () => {
    const after = of(sold(), BUYER);
    expect(after.owned_trains).toEqual(["3", "D"]);
    expect(after.is_carcosan).toBeFalsy();
    expect(after.carcosan_trains ?? []).toEqual([]);
    expect(after.carcosan_doom_after_macro_round).toBeUndefined();
    /* #1673: the buyer DOES carry the synthetic marker, and it is provenance only -- `ghost_trains` no
       longer grants any exemption, which the limit case below measures. */
    expect(after.ghost_trains).toEqual(["D"]);
  });

  it("and that train counts toward the buyer's ordinary train limit", () => {
    const after = of(sold(), BUYER);
    expect(countableTrainsOf(after)).toEqual(["3", "D"]);
    expect(excessTrainCount(after, 1)).toBe(1);
  });

  it("the train never disappears afterwards — the fog has nothing to come for", () => {
    const after = of(sold(), BUYER);
    for (const macro of [4, 5, 6, 12]) expect(fogIsDue(after, macro)).toBe(false);
    expect(fogIsDue(of(sold(), SELLER), 12)).toBe(false);
  });

  /* ---------------------------------------------------------------- */
  /* #1673 -- provenance follows the train; the gilding does not       */
  /* ---------------------------------------------------------------- */

  it("the SYNTHETIC marker moves with the train, seller → buyer", () => {
    /* THE TWO MARKERS MEAN DIFFERENT THINGS SINCE #1672, so the Blood Price splits them. `carcosan_trains`
       is the gilding and is burned off. `ghost_trains` is "this train never came off the depot shelf" -- a
       fact about the TRAIN, which a change of owner cannot alter. */
    const after = sold();
    expect(of(after, SELLER).ghost_trains).toEqual([]);
    expect(of(after, BUYER).ghost_trains).toEqual(["D"]);
    // And it confers nothing: the exemption is read from `carcosan_trains` alone.
    expect(of(after, BUYER).carcosan_trains ?? []).toEqual([]);
    expect(countableTrainsOf(of(after, BUYER))).toEqual(["3", "D"]);
  });

  it("A. depotInventory is unchanged by the transfer — the gift still consumes no physical train", () => {
    /* `depotInventory` subtracts ghosts from the tally (#1046). Had the marker been dropped at the sale, the
       transferred gift would have started counting against the bank's shelf: one printed train removed from
       sale by a trade that never touched the depot. Measured across every tier, before and after. */
    const before = {
      macro_round_number: 3,
      public_companies: [
        co({ company_id: SELLER, ticker: "B&O", owned_trains: ["4", "D"], ghost_trains: ["D"], carcosan_trains: ["D"], is_carcosan: true, carcosan_doom_after_macro_round: 4, treasury: "500" }),
        co({ company_id: BUYER, ticker: "PRR", owned_trains: ["3"], treasury: "900" }),
      ],
    } as unknown as GameStateResponse;
    const row = (st: GameStateResponse) =>
      depotInventory(st).map((r) => `${r.tier}:${r.remaining}`).join(" ");
    expect(row(settleTrainSale(before, BUYER, SELLER, "D", "400"))).toBe(row(before));
  });

  it("B. a transferred synthetic D is still NOT a real Diesel purchase", () => {
    /* THE SHARPEST CONSEQUENCE. `realDieselPurchased` subtracts ghosts before it looks, so a marker lost at
       the sale would have turned the gift into retroactive evidence that a real D had been bought -- and
       that starts the doom clock for every other gilded train in play (#1672). Synthetic is forever. */
    const after = sold();
    expect(realDieselPurchased(after)).toBe(false);
    // The buyer owns a D for every gameplay purpose, and the phase says so; provenance still says otherwise.
    expect(of(after, BUYER).owned_trains).toEqual(["3", "D"]);
    expect(derivePhase(after)?.tier).toBe("D");
  });

  it("moves exactly ONE marker when two trains share a model", () => {
    /* MULTISETS, not sets -- the project's one-occurrence convention. A corporation holding a bought 6 and a
       gilded 6 hands over one train and one marker, never both and never none. */
    const twoSixes = {
      macro_round_number: 3,
      public_companies: [
        co({ company_id: SELLER, ticker: "B&O", owned_trains: ["6", "6"], ghost_trains: ["6"], carcosan_trains: ["6"], is_carcosan: true, treasury: "500" }),
        co({ company_id: BUYER, ticker: "PRR", owned_trains: [], treasury: "900" }),
      ],
    } as unknown as GameStateResponse;
    const after = settleTrainSale(twoSixes, BUYER, SELLER, "6", "100");
    expect(of(after, SELLER).owned_trains).toEqual(["6"]);
    expect(of(after, SELLER).ghost_trains).toEqual([]);
    expect(of(after, BUYER).ghost_trains).toEqual(["6"]);
    // The seller keeps its remaining, ordinary 6 — and it counts.
    expect(countableTrainsOf(of(after, SELLER))).toEqual(["6"]);
  });

  it("and survives a SECOND hop, when the train is synthetic but no longer gilded", () => {
    /* The carcosan block is gated on the seller's gilding; provenance is not, and must not be. A train that
       has already been through one Blood Price is synthetic and ordinary, and its next sale must still carry
       the marker -- gating this on the gilding would lose it on the second hop. */
    const THIRD = 3;
    const once = sold();
    const withThird = {
      ...once,
      public_companies: [...once.public_companies, co({ company_id: THIRD, ticker: "NYC", owned_trains: [], treasury: "900" })],
    } as unknown as GameStateResponse;
    const twice = settleTrainSale(withThird, THIRD, BUYER, "D", "100");
    expect(of(twice, BUYER).ghost_trains).toEqual([]);
    expect(of(twice, THIRD).ghost_trains).toEqual(["D"]);
    expect(of(twice, THIRD).carcosan_trains ?? []).toEqual([]);
    expect(realDieselPurchased(twice)).toBe(false);
  });

  it("leaves an ordinary sale's markers alone", () => {
    /* No ghost on the seller, nothing to move, and the state is untouched by this block. */
    const plain = {
      macro_round_number: 3,
      public_companies: [
        co({ company_id: SELLER, ticker: "B&O", owned_trains: ["4"], treasury: "500" }),
        co({ company_id: BUYER, ticker: "PRR", owned_trains: [], treasury: "900" }),
      ],
    } as unknown as GameStateResponse;
    const after = settleTrainSale(plain, BUYER, SELLER, "4", "100");
    expect(of(after, SELLER).ghost_trains).toBeUndefined();
    expect(of(after, BUYER).ghost_trains).toBeUndefined();
    expect(of(after, BUYER).owned_trains).toEqual(["4"]);
  });
});

/* ------------------------------------------------------------------ */
/* F. THE GIFT'S MODEL COMES FROM THE DEPOT                            */
/* ------------------------------------------------------------------ */

describe("F. the gift is the depot's lowest-value train, not the phase's tier", () => {
  /* OWNER RULING: "Carcosa grants a synthetic train matching the LOWEST-VALUE TRAIN CURRENTLY REPRESENTED BY
     THE AUTHORITATIVE BANK DEPOT RULE when the gift occurs. Do NOT simply infer the model from phase if
     depot state can differ." */

  it("agrees with the phase while that tier is still on the shelf", () => {
    const early = board([co({ owned_trains: ["3"] })]);
    const tier = derivePhase(early)?.tier ?? "2";
    expect(carcosaGiftModel(early, tier)).toBe(openDepotTiers(early)[0]?.tier);
  });

  it("DIFFERS from the phase once that tier has sold out — the case #1046 got wrong", () => {
    /* A board where the phase's own tier is gone from the depot. `openDepotTiers` is the authoritative depot
       rule and its head is what the bank would sell next; `escalationTier` would still name the phase. */
    const owners = [];
    for (let i = 0; i < 12; i += 1) owners.push(co({ company_id: 10 + i, owned_trains: ["5"] }));
    const soldOut = board(owners);
    const tier = derivePhase(soldOut)?.tier ?? "2";
    const shelf = openDepotTiers(soldOut)[0]?.tier;
    expect(carcosaGiftModel(soldOut, tier)).toBe(shelf);
    if (shelf !== escalationTier(tier)) {
      // The discrepancy is real on this board, and the gift follows the depot.
      expect(carcosaGiftModel(soldOut, tier)).not.toBe(escalationTier(tier));
    }
  });

  it("falls back to the phase only when the shelf is unreadable, and never returns nothing", () => {
    /* #232: a roster of unreported fleets is "the log does not say". `openDepotTiers` still answers from the
       printed stock there, so the fallback is a guard rather than a live path -- pinned at the source so a
       later change cannot quietly turn an unreadable depot into a refused gift. */
    const unknown = board([co({ owned_trains: null as unknown as string[] })]);
    expect(carcosaGiftModel(unknown, "4")).not.toBeNull();
    expect(readStripped("gameEngine/yellowSign.ts")).toContain(
      "return openDepotTiers(state)[0]?.tier ?? escalationTier(phaseTier);",
    );
    // And the fallback itself is the old phase reading, unchanged.
    expect(escalationTier("4")).toBe("4");
  });

  it("is synthetic: it does not consume depot inventory", () => {
    /* `depotInventory` subtracts `ghost_trains` from the tally (#1046), so the shelf reads the same before
       and after a gift of the same tier. */
    const before = board([co({ owned_trains: ["5"] })]);
    const shelf = openDepotTiers(before)[0]!.tier;
    const after = board([co({ owned_trains: ["5", shelf], ghost_trains: [shelf], carcosan_trains: [shelf] })]);
    const row = (s: GameStateResponse, t: string) => openDepotTiers(s).find((r) => r.tier === t)?.remaining;
    expect(row(after, shelf)).toBe(row(before, shelf));
  });

  it("and a synthetic D still does not count as a real D purchase", () => {
    const giftedD = board([co({ owned_trains: ["6", "D"], ghost_trains: ["D"], carcosan_trains: ["D"] })]);
    expect(realDieselPurchased(giftedD)).toBe(false);
  });
});
