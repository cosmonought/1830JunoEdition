/** @jest-environment node */
// frontend/src/utils/moneyConservation.test.ts -- design note #1562 (Batch 7.1).
//
// ==================================================================
//  MONEY ON THE TABLE DOES NOT CHANGE
// ==================================================================
//
// Bank + every player's cash + every corporate treasury. Nothing else holds VGP: auction bids are ESCROWED
// rather than spent (#334a), and shares, trains and privates are not money. Every gameplay action must leave
// that total exactly as it found it.
//
// TWO EXCEPTIONS, AND THEY ARE THE ONLY TWO. `SetupGame` deals the money onto the table, and the Yellow
// Sign's cash award mints (`stage === "mark"`: "award the corporation cash equal to 0.5x the deleted train's
// depot value" with no payer). UR-5 (2026-09-25): that mint is INTENDED VARIANT LAW, not an open defect -- the
// owner ruled OD-UR-4 = 4-A (backlog D-40): the award is found money, created outside the Bank. (This header once
// called it "Stage 9's S9-1, deliberately NOT fixed here"; S9-1 closed the Sign's derivation, and the mint stayed
// by ruling.) On a pinned table the Mark rides the run's own entry (UR-3); the corpus is unpinned and holds only
// the legacy request's shape, which is what `MINTS_BY_DESIGN` names. Anything else that moves the total is a
// defect, and this sweep is how it gets found instead of being discovered as a bank that broke four Operating
// Rounds early.
//
// BEFORE THIS BATCH THE CORPUS FAILED THIS EVERYWHERE: 23 non-conserving entries in JUNO-FCJ, 27 in JUNO-Z6C,
// 17 in JUNO-3XD, 10 in JUNO-CV4. Every one was an auction purchase the bank was never credited for, a
// terrain fee paid to nobody, or a share bought with money the buyer did not have.

import { readFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";

import { entriesFromExport, replayLog, type ExportedEntry } from "../gameEngine/replayLog";
import { DEVELOPMENT_CORPUS_POLICY } from "../gameEngine/rulesVersion";
import { sandboxReplayProviders } from "../gameEngine/replayProviders";
import {
  DEFAULT_SANDBOX_SCENARIO,
  sandboxScenario,
  sandboxScenarioState,
  sandboxWaterfallState,
} from "../gameEngine/sandboxState";
import { waterfallForRoster, withEmptyRoster } from "../gameEngine/gameSetup";
import { applySandboxAction } from "../gameEngine/sandboxSession";
import { moneyTotal, moneyConservationBreach } from "../gameEngine/cashLedger";
import { fieldDigests } from "../gameEngine/stateDigest";
import type { GameStateResponse } from "../gameEngine/gameState";

/* THE FROZEN LOGS, for the assertions that name an index. `replayGolden`'s own note explains why: the live
   `server/data` store held a game that was still being played, so a fixture built on it was "wrong" eighteen
   entries later. The SWEEP below reads every log it can find, because a conservation invariant cannot be
   falsified by a log growing -- only by a rule breaking.

   EVERY LOG FILE, NOT EVERY ROOM. Four of the eighteen files are second copies or prefixes of a room that is
   also swept from somewhere else -- `replayGolden/logs` holds frozen copies of three `server/data` logs,
   `sandbox-log-JUNO-CV4.json` is a SHORTER client-side capture of the same room (120 applied entries against
   the store's 141), `JUNO-FCJ-prefix96.log.jsonl` is FCJ's first 96 entries and `__fixtures__z6cLog.json` is
   Z6C through index 494. They are swept separately and named by their path, because a prefix reaches
   different boards from the full log and a stale copy is exactly the thing a sweep should notice. */
const FROZEN_DIR = join(__dirname, "__fixtures__", "replayGolden", "logs");
const SERVER_DIR = join(__dirname, "..", "..", "..", "server", "data");
const EXPORT_DIR = join(__dirname, "..", "..");
const PREFIX_DIR = join(__dirname, "__fixtures__");

const jsonl = (file: string): ExportedEntry[] =>
  readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as ExportedEntry);

/** The two client-side export shapes: `{ actions }` from the Ctrl+Shift+L export, `{ entries }` from the
 *  #1411 timeline fixture. Both hold the same rows. */
const exported = (file: string): ExportedEntry[] => {
  const raw = JSON.parse(readFileSync(file, "utf8")) as {
    actions?: ExportedEntry[];
    entries?: ExportedEntry[];
  };
  return raw.actions ?? raw.entries ?? [];
};

function corpus(): Array<{ name: string; entries: ExportedEntry[] }> {
  const out: Array<{ name: string; entries: ExportedEntry[] }> = [];
  const add = (name: string, entries: ExportedEntry[]) => out.push({ name, entries });
  if (existsSync(FROZEN_DIR)) {
    for (const file of readdirSync(FROZEN_DIR).filter((f) => f.endsWith(".log.jsonl")).sort()) {
      add(`golden/${file.replace(".log.jsonl", "")}`, jsonl(join(FROZEN_DIR, file)));
    }
  }
  if (existsSync(SERVER_DIR)) {
    for (const file of readdirSync(SERVER_DIR).filter((f) => f.endsWith(".log.jsonl")).sort()) {
      add(`server/${file.replace(".log.jsonl", "")}`, jsonl(join(SERVER_DIR, file)));
    }
  }
  if (existsSync(EXPORT_DIR)) {
    for (const file of readdirSync(EXPORT_DIR).filter((f) => /^sandbox-log-JUNO-.*\.json$/.test(f)).sort()) {
      add(`export/${file.replace("sandbox-log-", "").replace(".json", "")}`, exported(join(EXPORT_DIR, file)));
    }
  }
  const prefix = join(PREFIX_DIR, "JUNO-FCJ-prefix96.log.jsonl");
  if (existsSync(prefix)) add("prefix/JUNO-FCJ-96", jsonl(prefix));
  const z6c = join(__dirname, "__fixtures__z6cLog.json");
  if (existsSync(z6c)) add("fixture/JUNO-Z6C-494", exported(z6c));
  return out;
}

interface Step {
  index: number;
  kind: string;
  bank: number;
  money: number;
  state: GameStateResponse;
}

function walk(entries: ExportedEntry[]): Step[] {
  const seedState = withEmptyRoster(sandboxScenarioState(DEFAULT_SANDBOX_SCENARIO, 0, "default"));
  const seedWaterfall = waterfallForRoster(
    sandboxWaterfallState(sandboxScenario(DEFAULT_SANDBOX_SCENARIO).phase, 0, true),
    [],
  );
  const steps: Step[] = [];
  const result = replayLog(
    entriesFromExport(entries),
    sandboxReplayProviders(),
    { state: seedState, waterfall: seedWaterfall },
    ({ entry, msg, stateBefore }) => {
      steps.push({
        index: entry.index,
        kind: Object.keys(msg as object)[0] ?? "(unparsed)",
        bank: Number(stateBefore.virtual_bank_vgp),
        money: moneyTotal(stateBefore),
        state: stateBefore,
      });
    },
    DEVELOPMENT_CORPUS_POLICY,
  );
  steps.push({
    index: -1,
    kind: "(final)",
    bank: Number(result.state.virtual_bank_vgp),
    money: moneyTotal(result.state),
    state: result.state,
  });
  return steps;
}

/** The only two messages allowed to move the total, and why. */
const MINTS_BY_DESIGN = new Set(["SetupGame", "YellowSignEvent"]);

const logs = corpus();

describe("the whole corpus conserves money after every replayed entry", () => {
  it("sweeps every log file in the repository, named", () => {
    /* NAMED RATHER THAN COUNTED, so a log that stops being swept fails here instead of quietly shrinking the
       sweep. Twelve rooms, eighteen files: three frozen golden copies, the eight in the server's store, five
       client exports (JUNO-CV4 appears three times -- store, frozen copy and a shorter client capture), FCJ's
       96-entry prefix and Z6C through 494. */
    expect(logs.map((entry) => entry.name)).toEqual([
      "golden/JUNO-7NZ",
      "golden/JUNO-CV4",
      "golden/JUNO-G6J",
      "server/JUNO-7NZ",
      "server/JUNO-8E8",
      "server/JUNO-CV4",
      "server/JUNO-CW7",
      "server/JUNO-FCJ",
      "server/JUNO-G6J",
      "server/JUNO-TQQ",
      "server/JUNO-Z6C",
      "export/JUNO-3XD",
      "export/JUNO-CV4",
      "export/JUNO-JJD",
      "export/JUNO-QVC",
      "export/JUNO-Y8V",
      "prefix/JUNO-FCJ-96",
      "fixture/JUNO-Z6C-494",
    ]);
  });

  for (const { name, entries } of logs) {
    it(`${name}: every entry but the deal and the Yellow Sign leaves the total alone`, () => {
      const steps = walk(entries);
      const breaches: string[] = [];
      for (let i = 1; i < steps.length; i += 1) {
        const from = steps[i - 1];
        if (steps[i].money === from.money) continue;
        const delta = steps[i].money - from.money;
        if (MINTS_BY_DESIGN.has(from.kind)) continue;
        breaches.push(`idx ${from.index} ${from.kind} ${delta >= 0 ? "+" : ""}${delta}`);
      }
      /* NOT WHITELISTED, LISTED. A new non-conserving action must fail this and be reported, never quietly
         added to `MINTS_BY_DESIGN` -- which is why the failure message names the entry and the amount. */
      expect(breaches).toEqual([]);
    });
  }

  it("the Yellow Sign award is still the one minting rule left, and it is Stage 9's (S9-1)", () => {
    /* UR-5 (2026-09-25; UR audit Appendix B item 11): OD-UR-4 = 4-A (backlog D-40) rules the Mark's award MINTED --
       "found money, created outside the Bank" -- so this case pins intended variant law, not a defect awaiting S9-1.
       The two sentences below that expected S9-1 to take the exemption away are corrected in place; the case's title is
       kept as it was, because the Batch 7.3 / 7.5 records cite it by name -- read its "(S9-1)" as history. */
    /* Recorded as a POSITIVE assertion rather than as a silent exemption. Batch 7.1 wrote it on JUNO-Z6C 203,
       where the Mark awards the C&O half the taken train's depot value with no payer.

       BATCH 7.5 (version 5): THE CORPUS NO LONGER REACHES THAT ENTRY, SO THE TRIPWIRE MOVES TO A BOARD THAT
       DOES. On the board JUNO-Z6C's log derives under version 5 nothing changes after index 33:
         9   7.3 (C5, S7-2, D-21): the all-pass with the SV already sold no longer marks the B&O down, so it stays
             $220 and p-lzjh2r6u pays $220 for it at 14 instead of $210;
         31  that player then holds $95 and cannot pay $100 for his B&O share (7.1 ledger / 7.2 affordability);
             32, his home station, finds B&O unfloated; and 33 (p-je0gw2v0's B&O share) floats it one entry
             later than the table did;
         34+ the pre-existing home-token hold (`homeTokenGate.ts`) now owes B&O's home station, which no
             later entry in the log places, so every later entry -- 203's Mark included -- is a reducer no-op.
       So the stored corpus mints nothing at all under version 5: not because S9-1 was fixed (it was not), but
       because the one log that exercised it stops at 34. What this case pins is therefore both halves: the
       corpus list is empty for the reason above, AND the Mark still mints on a board that reaches it. (UR-5: S9-1
       closed (#1661) without touching the mint, and OD-UR-4 keeps it -- the exemption in `MINTS_BY_DESIGN` stays; it
       would come out only with a ruling that the award has a payer.) The freeze itself is characterized step by step
       in `gameHistory.test.ts` (Batch 7.5).

       SLICE 8.2 RE-PIN (S8-5, #1610 / #1614; the Stage-8 design's corpus table predicted it): THE CORPUS REACHES 203
       AGAIN. The freeze at 34 was the float-time home hold, which is retired: B&O floated at 33 owes nothing in the
       Stock Round, and its home is owed at its first operating turn (after 40), where the development corpus's policy
       supplies the choice recorded at 32 (I15). The log runs on, and at 203 C&O's Mark (`YellowSignEvent`, stage
       "mark", its 3-train taken) credits C&O $90 -- half the train's depot value, with no payer: the Batch 7.1
       observation, back on the stored corpus. (UR-5: the mint is variant law -- OD-UR-4, D-40 -- not S9-1's open
       item.) The corpus list below names that one entry, and the synthetic board after it still pins the rule itself.
       Nothing else in the corpus mints. */
    const z6c = logs.find((entry) => entry.name === "server/JUNO-Z6C");
    if (z6c) {
      const steps = walk(z6c.entries);
      const minted = steps
        .map((step, i) => ({ step, next: steps[i + 1] }))
        .filter(({ step, next }) => next && next.money !== step.money && step.kind !== "SetupGame");
      expect(minted.map(({ step, next }) => `${step.index} ${step.kind} +${next.money - step.money}`)).toEqual(["203 YellowSignEvent +90"]);
      // Slice 8.2: no longer frozen at 34 -- the board at 203 is not the board at 34, and the Mark lands on C&O.
      const at = (index: number) => steps.find((step) => step.index === index)!.state;
      expect(JSON.stringify(at(203))).not.toBe(JSON.stringify(at(34)));
      const mark = steps.findIndex((step) => step.index === 203);
      const co = (state: GameStateResponse) => state.public_companies.find((entry) => entry.ticker === "C&O")!;
      expect(Number(co(steps[mark + 1].state).treasury) - Number(co(steps[mark].state).treasury)).toBe(90);
    }

    const BO = 6;
    const board = {
      current_round_type: "OperatingRound",
      macro_round_number: 3,
      sub_round_index: 1,
      operating_sub_phase: "Routes",
      active_operating_order: [BO],
      active_corporation_index: 0,
      player_addresses: ["p1"],
      player_cash: [{ player: "p1", cash_vgp: "0" }],
      active_player_index: 0,
      priority_deal_index: 0,
      consecutive_passes: 0,
      virtual_bank_vgp: "5000",
      private_companies: [],
      variants: { unpredictableRevenue: true },
      public_companies: [
        { company_id: BO, ticker: "B&O", president: "p1", treasury: "340", last_route_revenue: "0", owned_trains: ["3", "4"] },
      ],
    } as unknown as GameStateResponse;
    const marked = applySandboxAction(board, {
      YellowSignEvent: { game_id: 0, protocol_id: BO, stage: "mark", model: "3", cash: "90" },
    } as never);
    expect(marked.public_companies[0].owned_trains).toEqual(["4"]);
    expect(moneyTotal(marked) - moneyTotal(board)).toBe(90);
    expect(moneyConservationBreach(board, marked)).not.toBeNull();
  });
});

describe("the auction pays the Bank (S7-10, owner ruling D-15/Q1a)", () => {
  /* Every private bought or won in the initial auction was debited from the player and credited to NOBODY,
     so the bank was short by the whole auction in every game this engine has ever played and broke early
     because of it. The assertions below are on a frozen log, so they name indices. */
  const steps = walk(jsonl(join(FROZEN_DIR, "JUNO-CV4.log.jsonl")));
  const at = (index: number) => {
    const i = steps.findIndex((step) => step.index === index);
    expect(i).toBeGreaterThanOrEqual(0);
    return { before: steps[i], after: steps[i + 1] };
  };

  it("credits the bank exactly what the buyer paid, on the first face-value purchase", () => {
    const { before, after } = at(1);
    expect(before.kind).toBe("WaterfallBuyLowest");
    expect(after.bank - before.bank).toBe(20);
    expect(after.money).toBe(before.money);
  });

  it("credits the bank for a mini-auction win as well as for a buy", () => {
    const { before, after } = at(8);
    expect(before.kind).toBe("WaterfallMiniAuctionPass");
    expect(after.bank - before.bank).toBe(135);
    expect(after.money).toBe(before.money);
  });

  it("credits the bank for the whole auction, and the deal's money never leaves the table", () => {
    const auction = steps.filter((step) => step.kind.startsWith("Waterfall"));
    const credited = auction.reduce((total, step, i) => {
      const next = steps[steps.indexOf(step) + 1];
      return total + (next ? next.bank - step.bank : 0);
    }, 0);
    expect(credited).toBe(755); // 20 + 40 + 70 + 110 + 135 + 160 + 220
    const dealt = steps[1];
    expect(steps[steps.length - 1].money).toBe(dealt.money);
  });
});

describe("a terrain cost pays the Bank (S7-10)", () => {
  const steps = walk(jsonl(join(FROZEN_DIR, "JUNO-CV4.log.jsonl")));
  const terrainLays = [27, 78, 163];

  for (const index of terrainLays) {
    it(`idx ${index}: the treasury pays $80 and the bank receives it`, () => {
      const i = steps.findIndex((step) => step.index === index);
      const before = steps[i];
      const after = steps[i + 1];
      expect(before.kind).toBe("LayTile");
      expect(after.bank - before.bank).toBe(80);
      expect(after.money).toBe(before.money);
      /* The fee is still the authoritative one and is still charged ONCE per hex (#723): the treasury falls
         by exactly what the bank gains. */
      const treasuryOf = (state: GameStateResponse) =>
        state.public_companies.reduce((sum, c) => sum + (Number(c.treasury) || 0), 0);
      expect(treasuryOf(before.state) - treasuryOf(after.state)).toBe(80);
    });
  }
});

describe("a corporate private purchase has a seller, and pays him (S7-12)", () => {
  /* Batch 7.1 hardens the MONEY of `transferPrivateToCorporation` and nothing else: the phase, the 1/2-2x
     band, the operating-corporation check and consent are rules, and they are Batch 7.4's. What is fixed
     here is that the payment cannot vanish and cannot run backwards. */
  const SV = 1;
  /* Batch 7.4 (#1591) put the purchase's authority in front of the ledger, so the board is a legal one -- PRR
     operating (the queue names it), phase 3 (NYC holds a 3-train), the SV's $20 face inside its $10-$40 band.
     The consent rule is skipped for these attribution-less calls (#549b); what each case asks is the money. */
  const board = (over: Partial<GameStateResponse> = {}): GameStateResponse =>
    ({
      current_round_type: "OperatingRound",
      current_global_era: "Green",
      active_operating_order: [1, 2],
      active_corporation_index: 0,
      virtual_bank_vgp: "5000",
      player_addresses: ["p1", "p2"],
      player_cash: [
        { player: "p1", cash_vgp: "100" },
        { player: "p2", cash_vgp: "0" },
      ],
      public_companies: [
        { company_id: 1, ticker: "PRR", treasury: "300", is_floated: true, president: "p1", owned_trains: [] },
        { company_id: 2, ticker: "NYC", treasury: "300", is_floated: true, president: "p2", owned_trains: ["3"] },
      ],
      private_companies: [
        { private_id: SV, name: "Schuylkill Valley", cost: "20", revenue_per_or: "5", owner: "p2", owner_protocol_id: null },
      ],
      ...over,
    }) as unknown as GameStateResponse;

  const buy = (state: GameStateResponse, price: string, companyId = 1) =>
    applySandboxAction(state, { BuyPrivateCompany: { game_id: 0, protocol_id: companyId, private_id: SV, price } } as never);

  /* ==================================================================
      A REFUSAL IS READ FROM THE MONEY, NOT FROM THE OBJECT'S IDENTITY (S7-17 / S10-1)
     ==================================================================
     `applySandboxActionAfterAuction` and the settle steps allocate before the core runs, so EVERY reducer
     refusal returns a new object and `after === before` is false for refused and applied actions alike. The
     digest of the four fields that hold money and ownership is the question these cases are actually asking,
     and it is the comparison Stage 7's tests use throughout. */
  const moneyDigest = (state: GameStateResponse) => {
    const digests = fieldDigests(state);
    return [
      digests.virtual_bank_vgp,
      digests.player_cash,
      digests.public_companies,
      digests.private_companies,
    ].join("|");
  };

  it("moves the price from the treasury to the selling player", () => {
    const before = board();
    const after = buy(before, "40");
    expect(after.public_companies[0].treasury).toBe("260");
    expect(after.player_cash[1].cash_vgp).toBe("40");
    expect(after.private_companies[0].owner).toBeNull();
    expect(after.private_companies[0].owner_protocol_id).toBe(1);
    expect(moneyConservationBreach(before, after)).toBeNull();
  });

  it("refuses when the private has no owner at all, rather than paying nobody", () => {
    const before = board({
      private_companies: [
        { private_id: SV, name: "Schuylkill Valley", cost: "20", revenue_per_or: "5", owner: null, owner_protocol_id: null },
      ],
    } as unknown as Partial<GameStateResponse>);
    const after = buy(before, "40");
    expect(moneyDigest(after)).toBe(moneyDigest(before));
  });

  it("refuses a corporation-to-corporation transfer, rather than paying into the void", () => {
    /* Rulebook 3.1: "Private companies may be bought by railroad corporations but not sold by them." The old
       arm debited the buyer and credited nobody, because only a PLAYER `owner` was ever paid. */
    const before = board({
      private_companies: [
        { private_id: SV, name: "Schuylkill Valley", cost: "20", revenue_per_or: "5", owner: null, owner_protocol_id: 2 },
      ],
    } as unknown as Partial<GameStateResponse>);
    const after = buy(before, "40");
    expect(moneyDigest(after)).toBe(moneyDigest(before));
    expect(after.public_companies[0].treasury).toBe("300");
    expect(after.private_companies[0].owner_protocol_id).toBe(2);
  });

  it("refuses a negative price rather than running the payment backwards", () => {
    // The probe that found this: `price: "-500"` paid the BUYER $500 and floored the owner to zero.
    const before = board();
    const after = buy(before, "-500");
    expect(moneyDigest(after)).toBe(moneyDigest(before));
    expect(after.public_companies[0].treasury).toBe("300");
    expect(after.player_cash[1].cash_vgp).toBe("0");
  });

  it("refuses a fractional price", () => {
    const before = board();
    const after = buy(before, "40.5");
    expect(moneyDigest(after)).toBe(moneyDigest(before));
  });

  it("refuses when the treasury cannot cover the price, rather than flooring it", () => {
    const before = board({
      public_companies: [
        { company_id: 1, ticker: "PRR", treasury: "0", is_floated: true, president: "p1", owned_trains: [] },
        { company_id: 2, ticker: "NYC", treasury: "300", is_floated: true, president: "p2", owned_trains: ["3"] },
      ],
    } as unknown as Partial<GameStateResponse>);
    const after = buy(before, "40");
    expect(moneyDigest(after)).toBe(moneyDigest(before));
    expect(after.player_cash[1].cash_vgp).toBe("0");
    expect(after.private_companies[0].owner).toBe("p2");
  });

  it("the ledger allows a $0 movement; the corporate purchase's band (7.4) is what refuses it", () => {
    /* Batch 7.1 pinned that a $0 corporate sale moved no money between two real parties. Batch 7.4's authority
       (#1591) now refuses it one layer up -- rulebook 3.1's half-face floor -- so the ledger's $0 allowance is
       exercised by the one transaction that prices at $0, the player <-> player trade (offerAuthority.test.ts),
       and here the band's own floor is the smallest corporate purchase that moves: $10 for a $20 face. */
    const before = board();
    const refused = buy(before, "0");
    expect(moneyDigest(refused)).toBe(moneyDigest(before));
    const after = buy(before, "10");
    expect(after.private_companies[0].owner_protocol_id).toBe(1);
    expect(after.public_companies[0].treasury).toBe("290");
    expect(after.player_cash[1].cash_vgp).toBe("10");
    expect(moneyConservationBreach(before, after)).toBeNull();
  });
});
