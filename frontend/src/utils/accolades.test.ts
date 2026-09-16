/** @jest-environment node */
// frontend/src/utils/accolades.test.ts -- design note #1416.
import {
  ACCOLADE_SPECS,
  ACCOLADE_SPEC_BY_KEY,
  DEFAULT_CEREMONY_LIMITS,
  accoladeEligible,
  accoladeMargin,
  selectCeremony,
  unearned,
  type Accolade,
  type AccoladeKey,
} from "./accolades";
import { gameHistoryFrom } from "./gameHistory";
import { activateBoard, STANDARD_BOARD } from "../components/hexBoardData";
import { readStripped } from "./sourceScan";
import { readFileSync } from "fs";
import { join } from "path";

/* Batch 7.5: the played game these tallies are read off is the frozen golden copy of JUNO-CV4. They were
   written on JUNO-Z6C's log, which no longer reaches a completed game under rules engine version 5 (it freezes
   at index 33 behind the home-token hold -- an expected historical-log incompatibility, characterized in
   `gameHistory.test.ts`). Only the cases CV4 genuinely exercises moved; the Z6C-only ones (the Yellow Sign's
   Carcosan / Redeemer, the Gravedigger and Rust Belt, the Farmhand, and the Bagholder / Little Engine formats CV4
   never awards) are listed in the ledger as S10-21 and wait for a completed version-5 Yellow Sign game. No award
   is re-pinned to "nobody". */
const LOG = readFileSync(join(__dirname, "__fixtures__", "replayGolden", "logs", "JUNO-CV4.log.jsonl"), "utf8")
  .split("\n")
  .filter((line) => line.trim().length > 0)
  .map((line) => JSON.parse(line)) as ReadonlyArray<{ index: number; id: string; actor: string; payload: string; at: number }>;

const won = (key: AccoladeKey, holder: string, value: number, runnerUp: number | null = null, extra: Partial<Accolade> = {}): Accolade => ({
  ...unearned(key),
  holder,
  value,
  runnerUp,
  tied: runnerUp === value,
  detail: `${value}`,
  ...extra,
});

describe("the catalogue (design note #1416)", () => {
  it("has exactly five core accolades, one of them corporate, and the rest situational", () => {
    const core = ACCOLADE_SPECS.filter((s) => s.core).map((s) => s.key).sort();
    expect(core).toEqual(["market-manipulator", "master-of-the-line", "robber-baron", "track-boss", "workhorse"]);
    expect(ACCOLADE_SPECS.filter((s) => s.core && s.scope === "corporation").map((s) => s.key)).toEqual(["workhorse"]);
    expect(ACCOLADE_SPECS.length).toBe(41); // #1421 +2, #1422 +1, #1429 +13 -1 (Efficiency Expert retired), #1438 +4
  });

  it("keeps Phase Rusher, Early Adopter and Gravedigger as three awards", () => {
    // RULED: "not the same, even if they all read the same source data".
    expect(ACCOLADE_SPEC_BY_KEY.get("phase-rusher")?.scope).toBe("player");
    expect(ACCOLADE_SPEC_BY_KEY.get("early-adopter")?.scope).toBe("corporation");
    expect(ACCOLADE_SPEC_BY_KEY.get("gravedigger")?.scope).toBe("player");
  });

  it("names every accolade with a title and a one-sentence blurb", () => {
    for (const spec of ACCOLADE_SPECS) {
      expect(spec.title.length).toBeGreaterThan(0);
      expect(spec.blurb.endsWith(".")).toBe(true);
      expect(spec.blurb.split(". ").length).toBe(1);
    }
  });
});

describe("eligibility and margin", () => {
  it("a core accolade only needs a holder; a situational one needs to be alone and above its floor", () => {
    expect(accoladeEligible(won("robber-baron", "a", 1, 1))).toBe(true); // tied core still shows
    expect(accoladeEligible(unearned("robber-baron"))).toBe(false);
    expect(accoladeEligible(won("fundraiser", "a", 120))).toBe(true);
    expect(accoladeEligible(won("fundraiser", "a", 120, 120))).toBe(false); // tied
    expect(accoladeEligible(won("phase-rusher", "a", 1))).toBe(false); // floor 2
    expect(accoladeEligible(won("phase-rusher", "a", 2))).toBe(true);
    expect(accoladeEligible(won("scrooge", "a", 50))).toBe(false); // floor 51% (#1438: "more than half")
    expect(accoladeEligible(won("paper-millionaire", "a", 90))).toBe(true);
  });

  it("a 'lowest' accolade needs a field to be lowest in", () => {
    expect(accoladeEligible(won("shell-corporation", "a", 30))).toBe(false);
    expect(accoladeEligible(won("shell-corporation", "a", 30, 67))).toBe(true);
  });

  it("the margin is the gap as a share of the larger figure, 1 when unopposed", () => {
    expect(accoladeMargin({ value: 100, runnerUp: null })).toBe(1);
    expect(accoladeMargin({ value: 100, runnerUp: 50 })).toBe(0.5);
    expect(accoladeMargin({ value: 100, runnerUp: 100 })).toBe(0);
    expect(accoladeMargin({ value: 30, runnerUp: 60 })).toBe(0.5); // the Shell's direction
  });
});

describe("the selection (design note #1416)", () => {
  const players = ["a", "b", "c"];

  it("shows every core accolade, then the situational ones by margin, capped per scope", () => {
    const all: Accolade[] = [
      won("robber-baron", "a", 900, 600),
      won("master-of-the-line", "a", 400, 300),
      won("track-boss", "b", 20, 19),
      won("market-manipulator", "a", 30, 10),
      won("workhorse", "a", 3000, 2000, { companyId: 1, ticker: "PRR" }),
      won("fundraiser", "b", 300, 100), // margin .67
      won("corporate-raider", "c", 2, 1), // margin .5
      won("the-wall", "a", 3, 2), // margin .33
      won("mountain-mover", "a", 200, 40), // margin .8
      won("mr-monopoly", "a", 3, 2), // margin .33
      won("last-call", "a", 4, 2), // margin .5
      won("early-adopter", "a", 1, null, { companyId: 2, ticker: "NYC" }),
      won("fleet-admiral", "b", 5, 4, { companyId: 3, ticker: "B&O" }),
      won("scrooge-company", "a", 3, 3, { companyId: 1, ticker: "PRR" }), // tied: out
      won("shell-corporation", "c", 40, 70, { companyId: 4, ticker: "C&O" }),
      won("salvager", "a", 2, 1, { companyId: 2, ticker: "NYC" }),
    ];
    const ceremony = selectCeremony(all, players);
    const keys = ceremony.map((a) => a.key);
    // Every core one is in, and the Robber Baron is last.
    for (const key of ["robber-baron", "master-of-the-line", "track-boss", "market-manipulator", "workhorse"]) expect(keys).toContain(key);
    expect(keys[keys.length - 1]).toBe("robber-baron");
    // Corporate first, then player.
    const scopes = ceremony.map((a) => a.scope);
    expect(scopes.lastIndexOf("corporation")).toBeLessThan(scopes.indexOf("player"));
    // Three situational corporate at most, four situational player at most; the tie is out.
    expect(ceremony.filter((a) => !a.core && a.scope === "corporation").length).toBeLessThanOrEqual(DEFAULT_CEREMONY_LIMITS.corporation);
    expect(ceremony.filter((a) => !a.core && a.scope === "player").length).toBeLessThanOrEqual(DEFAULT_CEREMONY_LIMITS.player);
    expect(keys).not.toContain("scrooge-company");
    // The best scores made it (#1424: margin plus rarity).
    expect(keys).toContain("fundraiser");
    expect(keys).toContain("corporate-raider");
  });

  it("spreads the awards: a player with nothing yet gets a nudge past a comfortable first", () => {
    const all: Accolade[] = [
      won("robber-baron", "a", 900, 600),
      won("track-boss", "a", 20, 10),
      won("market-manipulator", "a", 30, 10),
      won("master-of-the-line", "a", 400, 300),
      // Player pool: four for "a", one for "c". Scores are margin + rarity (#1424) + the nudge.
      won("fundraiser", "a", 300, 100), // .67 + .7 = 1.37
      won("mountain-mover", "a", 200, 40), // .8 + .1 = .9
      won("last-call", "a", 4, 2), // .5 + .1 = .6
      won("the-wall", "a", 3, 2), // .33 + .7 = 1.03
      won("corporate-raider", "c", 2, 1), // .5 + .7 + .25 nudge = 1.45
    ];
    const ceremony = selectCeremony(all, players, { corporation: 3, player: 3 });
    const situational = ceremony.filter((a) => !a.core).map((a) => a.key);
    expect(situational[0]).toBe("corporate-raider");
    expect(situational.length).toBe(3);
    expect(situational).toContain("fundraiser");
    expect(situational).toContain("the-wall");
    expect(situational).not.toContain("last-call");
    expect(situational).not.toContain("mountain-mover");
  });

  it("gives every player at least one award, past the cap if it must (#1426)", () => {
    const all: Accolade[] = [
      won("robber-baron", "a", 900, 600),
      won("master-of-the-line", "a", 400, 300),
      won("track-boss", "a", 20, 19),
      won("market-manipulator", "a", 30, 10),
      won("workhorse", "a", 3000, 2000, { companyId: 1, ticker: "PRR" }),
      // Four situational player awards for "b", then "c" holds only a tied Mr. Monopoly (ineligible).
      won("fundraiser", "b", 300, 100),
      won("mountain-mover", "b", 200, 40),
      won("last-call", "b", 4, 2),
      won("the-wall", "b", 3, 2),
      won("corporate-raider", "b", 2, 1),
      won("mr-monopoly", "c", 2, 2),
    ];
    const ceremony = selectCeremony(all, ["a", "b", "c"]);
    const holders = new Set(ceremony.map((x) => x.holder));
    expect(holders.has("c")).toBe(true);
    expect(ceremony.find((x) => x.key === "mr-monopoly")?.holder).toBe("c");
    // Still corporate then player, Robber Baron last.
    expect(ceremony[ceremony.length - 1].key).toBe("robber-baron");
    // A player who holds nothing at all gets nothing -- there is nothing honest to give.
    expect(new Set(selectCeremony(all, ["a", "b", "c", "d"]).map((x) => x.holder)).has("d")).toBe(false);
  });

  it("an empty catalogue yields an empty ceremony", () => {
    expect(selectCeremony(ACCOLADE_SPECS.map((s) => unearned(s.key)), players)).toEqual([]);
  });
});

describe("the tallies on a played game (design note #1416)", () => {
  afterAll(() => activateBoard(STANDARD_BOARD));
  const history = gameHistoryFrom(LOG as never);
  const by = Object.fromEntries(history.accolades.map((a) => [a.key, a])) as Record<AccoladeKey, Accolade>;

  it("computes all thirty-seven, each with a holder from the roster or none", () => {
    expect(history.accolades.length).toBe(41);
    for (const a of history.accolades) {
      if (a.holder !== null) {
        expect(history.players).toContain(a.holder);
        expect(a.detail.length).toBeGreaterThan(0);
      } else {
        expect(a.detail).toBe("");
        expect(a.value).toBe(0);
      }
      if (a.scope === "corporation" && a.holder !== null) {
        expect(a.ticker).not.toBeNull();
        expect(history.corporations.map((c) => c.companyId)).toContain(a.companyId);
      }
    }
  });

  it("the Workhorse is the autopsy's top lifetime revenue", () => {
    const top = [...history.autopsy].sort((x, y) => y.lifetimeRevenue - x.lifetimeRevenue)[0];
    expect(by.workhorse.companyId).toBe(top.companyId);
    expect(by.workhorse.value).toBe(top.lifetimeRevenue);
    expect(by.workhorse.holder).toBe(top.finalPresident);
  });

  it("the Shell Corporation is the lowest-priced floated corporation at the end", () => {
    const final = history.rounds[history.rounds.length - 1];
    const priced = final.corporations.filter((c) => c.floated && c.price !== null).sort((x, y) => (x.price ?? 0) - (y.price ?? 0));
    expect(by["shell-corporation"].companyId).toBe(priced[0].companyId);
    expect(by["shell-corporation"].value).toBe(priced[0].price);
  });

  it("Mr. Monopoly counts the presidencies on the final board", () => {
    const final = history.rounds[history.rounds.length - 1];
    const count = new Map<string, number>();
    for (const c of final.corporations) if (c.floated && c.president) count.set(c.president, (count.get(c.president) ?? 0) + 1);
    const top = Array.from(count.entries()).sort((x, y) => y[1] - x[1])[0];
    expect(by["mr-monopoly"].value).toBe(top[1]);
  });

  it("Scrooge and the Paper Millionaire are percentages of the final net worth", () => {
    for (const key of ["scrooge", "paper-millionaire"] as const) {
      if (by[key].holder === null) continue;
      expect(by[key].value).toBeGreaterThanOrEqual(0);
      expect(by[key].value).toBeLessThanOrEqual(100);
    }
  });

  it("the Early Adopter, if any, is a corporation that ends the game with a Diesel or traded one", () => {
    if (by["early-adopter"].holder === null) return;
    expect(by["early-adopter"].detail).toMatch(/bought the first Diesel \((OR|SR) /);
  });

  /* Batch 7.5 -- DISPLACED, NOT RE-PINNED (S10-21). Two cases lived here that only JUNO-Z6C's completed game could
     exercise, and CV4 cannot: "Z6C's C&O president is a Carcosan -- the Mark, never redeemed (#1421)" (Carcosan
     Railways "Marked by an Outer God", no Redeemer) and "obsolescence is two awards in dollars: the Gravedigger
     sent, the Rust Belt lost (#1422)" (both detail formats, both values > 0 -- CV4 ends in phase 3 and rusts
     nothing). They return when a completed version-5 Yellow Sign game is captured as a fixture. */

  it("the Mark's train is the sign's, not the Rust Belt's (#1422)", () => {
    // C&O lost its 3-train to the Mark at OR 6.1 ($180 at the time); a loser tally that counted it would put
    // C&O's president $180 higher than one that does not. Checked by re-deriving from the fleet-loss diff
    // the accolade uses, which excludes the taken train by construction (`describeFleetLosses` #1264).
    const source = readStripped("utils/gameHistory.ts");
    expect(source).toContain('if (kind !== "YellowSignEvent") {');
    expect(source).toContain("describeFleetLosses(before, after, msg ?? undefined)");
  });

  it("the anti-awards and the corporate five come off the same replay (#1429)", () => {
    expect(ACCOLADE_SPEC_BY_KEY.has("efficiency-expert" as AccoladeKey)).toBe(false);
    // #1438: the Hobo (key `passenger`) is real money; the Bagholder is a number or nobody.
    expect(by.passenger.holder).not.toBeNull();
    if (by.bagholder.holder !== null) expect(by.bagholder.detail).toMatch(/^Finished holding stocks that lost \$[\d,]+ in value over the last two rounds\.$/);
    expect(by.passenger.value).toBeLessThan(by["robber-baron"].value + 1);
    // The Juggernaut is the biggest single run, which is at least the Master of the Line's train.
    expect(by.juggernaut.value).toBeGreaterThanOrEqual(by["master-of-the-line"].value);
    // #1438: the Golden Goose counts payouts; the Dividend Machine is the shareholders' total, never above the autopsy's gross.
    expect(by["golden-goose"].detail).toMatch(/paid out (once|\d+ times)$/);
    expect(by["dividend-machine"].value).toBeLessThanOrEqual(Math.max(...history.autopsy.map((c) => c.dividendsPaid)));
    // The Capitalist Pig: somebody made money on prices.
    expect(by["capitalist-pig"].scope).toBe("player");
    expect(by["capitalist-pig"].holder).not.toBeNull();
    // The Railroad Baron ran at least as many corporations as Mr. Monopoly holds at the end.
    expect(by["railroad-baron"].value).toBeGreaterThanOrEqual(by["mr-monopoly"].value);
    // The daddies never share a holder.
    if (by["salt-daddy"].holder !== null) expect(by["salt-daddy"].holder).not.toBe(by["sugar-daddy"].holder);
    // The White Elephant is the worst per-round return on the fleet; the Little Engine earned its float back.
    if (by["white-elephant"].holder !== null) expect(by["white-elephant"].detail).toMatch(/fell \$[\d,]+ short of paying for its trains$/);
    if (by["little-engine"].holder !== null) expect(by["little-engine"].detail).toMatch(/floated at \$\d+ and earned it back$/);
    /* Batch 7.5: "Z6C played Unpredictable Revenue, so the wildlife was out" -- the Farmhand assertion is displaced
       to S10-21 with the cases above (CV4 did not play Unpredictable Revenue). So are the two conditional formats
       above that only Z6C exercised: CV4 awards neither a Bagholder nor a Little Engine, so those lines hold
       vacuously here and their coverage is listed in the ledger, not claimed. */
  });

  it("the ceremony is a subset of the accolades, in show order, ending on the Robber Baron", () => {
    const keys = history.ceremony.map((a) => a.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const a of history.ceremony) expect(history.accolades).toContain(a);
    expect(keys[keys.length - 1]).toBe("robber-baron");
    const scopes = history.ceremony.map((a) => a.scope);
    if (scopes.includes("corporation")) expect(scopes.lastIndexOf("corporation")).toBeLessThan(scopes.indexOf("player"));
  });
});

describe("the modal opens on the ceremony (design notes #1416/#1417)", () => {
  it("opens on the ceremony stage (#1433), full screen, and the ceremony reads the selection", () => {
    const modal = readStripped("components/GameOverModal.tsx");
    expect(modal).toContain("const inCeremony = hasCeremony && stage === \"ceremony\";");
    expect(modal).toContain("{inCeremony && history && (");
    expect(modal).toContain('width: "100%"');
    expect(modal).toContain('height: "100%"');
    const ceremony = readStripped("components/AccoladesCeremony.tsx");
    expect(ceremony).toContain("const ceremony = history.ceremony;");
    expect(ceremony).toContain("linear-gradient(90deg, ${livery} 0%, ${livery} 12%, transparent 28%)");
  });
});

describe("the ceremony's script (design note #1417)", () => {
  it("presents and lands every corporate accolade, sweeps the players in, then the player accolades", () => {
    const { ceremonyScript } = require("../components/AccoladesCeremony") as typeof import("../components/AccoladesCeremony");
    const list: Accolade[] = [
      won("workhorse", "a", 3000, 2000, { companyId: 1, ticker: "PRR" }),
      won("early-adopter", "b", 1, null, { companyId: 2, ticker: "NYC" }),
      won("track-boss", "b", 20, 19),
      won("robber-baron", "a", 900, 600),
    ];
    const kinds = ceremonyScript(list).map((s) => (s.kind === "present" || s.kind === "land" ? `${s.kind}:${s.key}` : s.kind));
    expect(kinds).toEqual([
      "title",
      "present:workhorse", "land:workhorse",
      "present:early-adopter", "land:early-adopter",
      "sweep",
      "present:track-boss", "land:track-boss",
      "present:robber-baron", "land:robber-baron",
      "done",
    ]);
  });
});

describe("rarity in the ranking (design note #1424)", () => {
  const { accoladeScore, eligibilityRates } = require("./accolades") as typeof import("./accolades");

  it("a rare award with a modest margin outranks an every-game award with a comfortable one", () => {
    const rare = won("train-robber", "a", 1, null); // expected .1, margin 1
    const routine = won("mountain-mover", "b", 200, 40); // expected .9, margin .8
    expect(accoladeScore(rare, false)).toBeGreaterThan(accoladeScore(routine, false));
    // But a rare award won by a hair does not: fundraiser at .17 margin + .7 rarity = .87 < .8 + .1 = .9.
    const rareClose = won("fundraiser", "a", 120, 100);
    expect(accoladeScore(rareClose, false)).toBeLessThan(accoladeScore(routine, false));
  });

  it("every spec carries an expected rate in (0, 1], core at 1", () => {
    for (const spec of ACCOLADE_SPECS) {
      expect(spec.expected).toBeGreaterThan(0);
      expect(spec.expected).toBeLessThanOrEqual(1);
      if (spec.core) expect(spec.expected).toBe(1);
    }
  });

  it("measures the real rate off histories, for replacing the priors later", () => {
    const rates = eligibilityRates([{ accolades: [won("fundraiser", "a", 1), unearned("scrooge")] }, { accolades: [unearned("fundraiser"), unearned("scrooge")] }]);
    expect(rates.get("fundraiser")).toBe(0.5);
    expect(rates.get("scrooge")).toBe(0);
    expect(eligibilityRates([]).get("fundraiser")).toBe(0);
  });
});
