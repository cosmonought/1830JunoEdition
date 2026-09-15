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
// depot value" with no payer) -- which is Stage 9's S9-1 and is deliberately NOT fixed here. Anything else
// that moves the total is a defect, and this sweep is how it gets found instead of being discovered as a bank
// that broke four Operating Rounds early.
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
    /* Recorded as a POSITIVE assertion rather than as a silent exemption: JUNO-Z6C 203 awards the C&O half
       the taken train's depot value with no payer, and Batch 7.1 deliberately does not fix it. If S9-1 is
       ever closed, this case fails and the exemption above comes out with it. */
    const z6c = logs.find((entry) => entry.name === "server/JUNO-Z6C");
    if (!z6c) return; // the log is a development fixture, not a requirement of the suite
    const steps = walk(z6c.entries);
    const minted = steps
      .map((step, i) => ({ step, next: steps[i + 1] }))
      .filter(({ step, next }) => next && next.money !== step.money && step.kind !== "SetupGame");
    expect(minted.map(({ step, next }) => `${step.index} ${step.kind} +${next.money - step.money}`)).toEqual([
      "203 YellowSignEvent +90",
    ]);
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
  const board = (over: Partial<GameStateResponse> = {}): GameStateResponse =>
    ({
      current_round_type: "OperatingRound",
      virtual_bank_vgp: "5000",
      player_addresses: ["p1", "p2"],
      player_cash: [
        { player: "p1", cash_vgp: "100" },
        { player: "p2", cash_vgp: "0" },
      ],
      public_companies: [
        { company_id: 1, ticker: "PRR", treasury: "300", is_floated: true, president: "p1", owned_trains: [] },
        { company_id: 2, ticker: "NYC", treasury: "300", is_floated: true, president: "p2", owned_trains: [] },
      ],
      private_companies: [
        { private_id: SV, name: "Schuylkill Valley", face_value: "20", revenue_per_or: "5", owner: "p2", owner_protocol_id: null },
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
        { private_id: SV, name: "Schuylkill Valley", face_value: "20", revenue_per_or: "5", owner: null, owner_protocol_id: null },
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
        { private_id: SV, name: "Schuylkill Valley", face_value: "20", revenue_per_or: "5", owner: null, owner_protocol_id: 2 },
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
        { company_id: 2, ticker: "NYC", treasury: "300", is_floated: true, president: "p2", owned_trains: [] },
      ],
    } as unknown as Partial<GameStateResponse>);
    const after = buy(before, "70");
    expect(moneyDigest(after)).toBe(moneyDigest(before));
    expect(after.player_cash[1].cash_vgp).toBe("0");
    expect(after.private_companies[0].owner).toBe("p2");
  });

  it("still allows a $0 sale, which is a movement of no money between two real parties", () => {
    const before = board();
    const after = buy(before, "0");
    expect(after.private_companies[0].owner_protocol_id).toBe(1);
    expect(moneyConservationBreach(before, after)).toBeNull();
  });
});
