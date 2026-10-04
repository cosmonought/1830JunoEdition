/** @jest-environment jsdom */
//
// ==================================================================
//  PHASE 3 W1-L -- THE RULES REFERENCE SAYS WHAT THE GAME DOES (the copy that needs no ruling)
// ==================================================================
//
// RR-1 (the route search), RR-3 (capitalisation at the float), RR-5 (the Level Playing Field's station and Diesel
// prices), RR-7 (the emergency private sale's limits), U-32 (the home station is the first Operating Round turn's),
// the remaining must-sell qualifier, U-40 (the page's standing) and U-38 (the Tiles tab's canonical names). Each
// sentence is checked against the engine figure it states, read from the engine's own constant where one exists.
// The waiting room's description line (OD-14(e)) is owner-gated and deliberately untouched here. RR-4 was gated on
// OD-7 and is now ruled (2026-10-03): the cheapest-train restriction is the emergency purchase's only -- its cases
// are at the end of this file (Phase 3 Wave-1 integration).

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import RulesReference, { RULES_AUTHORITY_SENTENCE, type RulesReferenceProps } from "./RulesReference";
import { LPF_STATION_TOKEN_SCHEDULE } from "./hexBoardDataLpf";
import { STANDARD_STATION_TOKEN_SCHEDULE } from "../gameEngine/stationTokens";
import { DEPOT_COST, LPF_DIESEL_COST } from "../gameEngine/gamePhase";
import { DIESEL_EXCHANGE_COST, LPF_DIESEL_EXCHANGE_COST } from "../gameEngine/dieselExchange";
import { FULL_CAPITALISATION_MULTIPLE } from "../gameEngine/floatThreshold";
import { canonicalTileName } from "./hexTileCatalog";
import { readStripped } from "../utils/sourceScan";
import { cheapestPurchasableTrain } from "../gameEngine/trainAvailability";
import * as F from "../utils/offerFixtures74";
import * as S from "../utils/offerMatrix74Support";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
global.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const PHASE_3: RulesReferenceProps["phase"] = { label: "Phase 3", tier: "3", trainLimit: 4 };
const BASE: RulesReferenceProps = { roundType: "OperatingRound", roundLabel: "OR 2.1", operatingSubPhase: "Track", playerCount: 4, phase: PHASE_3 };
const LPF: RulesReferenceProps = {
  ...BASE,
  variants: {
    expandedMap: true,
    levelPlayingField: true,
    delayedAuction: false,
    gentleRust: false,
    unpredictableRevenue: false,
    dynamicStockMarket: false,
    plusTiles: true,
  },
};

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function page(id: "overview" | "stock" | "operating" | "auction" | "tables", props: RulesReferenceProps = BASE): string {
  act(() => {
    root.render(<RulesReference {...props} />);
  });
  const tab = container.querySelector(`[data-testid="rules-page-${id}"]`);
  if (!tab) throw new Error(`no tab: ${id}`);
  act(() => {
    tab.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  return container.textContent ?? "";
}

function section(id: string): string {
  const found = container.querySelector<HTMLElement>(`#${id}`);
  if (!found) throw new Error(`no section: ${id}`);
  return found.textContent ?? "";
}

const money = (n: number) => `$${n.toLocaleString("en-US")}`;

describe("U-40 · the Rules Reference states its standing on every page", () => {
  it.each(["overview", "stock", "operating", "auction", "tables"] as const)("%s", (id) => {
    page(id);
    const line = container.querySelector('[data-testid="rules-authority"]');
    expect(line?.textContent).toBe(RULES_AUTHORITY_SENTENCE);
    expect(RULES_AUTHORITY_SENTENCE).toMatch(/final word on Project 18XX's rules/);
    expect(RULES_AUTHORITY_SENTENCE).not.toMatch(/1830/);
  });
});

describe("RR-1 · the highest-revenue rule says the game checks it", () => {
  it("no longer waits for another player to demonstrate a better route", () => {
    const text = page("operating");
    expect(text).not.toContain("If another player demonstrates");
    expect(text).toContain("searches the corporation's own trains for the best legal combination it can find");
    expect(text).toContain("any legal combination that earns at least as much as the one it found is accepted");
  });
});

describe("RR-3 / U-32 · floating capitalises at once and places nothing", () => {
  it("the float card", () => {
    const text = page("stock");
    expect(text).not.toContain("At the end of the Stock Round in which it floats");
    expect(text).toContain("The moment it floats");
    expect(text).toContain(`${FULL_CAPITALISATION_MULTIPLE} × par value, into its treasury`);
    expect(text).toContain("Floating places no token: the home station goes down at the start of the corporation's first Operating Round turn");
  });

  it("the home station's timing names the Operating Round turn, not the float", () => {
    const text = page("operating");
    expect(text).toContain("its first turn in an Operating Round, not when it floats");
  });
});

describe("RR-5 · the Level Playing Field's station and Diesel prices are the engine's", () => {
  it("the Tables page: a standard table keeps the printed schedule", () => {
    page("tables");
    const stations = section("rules-reference-terrain");
    expect(stations).toContain(`First additional station${money(STANDARD_STATION_TOKEN_SCHEDULE.second)}`);
    expect(stations).toContain(`Each later station${money(STANDARD_STATION_TOKEN_SCHEDULE.later)}`);
    expect(stations).not.toContain("Each additional station");
    expect(section("rules-reference-trains")).toContain(`${money(DIESEL_EXCHANGE_COST)} instead of ${money(DEPOT_COST.D)}`);
  });

  it("the Tables page: a Level Playing Field table shows its own", () => {
    page("tables", LPF);
    const stations = section("rules-reference-terrain");
    expect(LPF_STATION_TOKEN_SCHEDULE.second).toBe(LPF_STATION_TOKEN_SCHEDULE.later);
    // The row wears the variant's tag between its label and its value.
    expect(stations).toContain(`Each additional stationLPF${money(LPF_STATION_TOKEN_SCHEDULE.later)}`);
    expect(stations).not.toContain("First additional station");
    expect(stations).not.toContain("Each later station");
    const trains = section("rules-reference-trains");
    expect(trains).toContain(`LPF${money(LPF_DIESEL_EXCHANGE_COST)} instead of ${money(LPF_DIESEL_COST)}`);
    expect(trains).not.toContain(money(DEPOT_COST.D));
  });

  it("the Operating Round page: the Diesel and station-cost lookups follow the table", () => {
    const lpf = page("operating", LPF);
    expect(lpf).toContain(`Diesel${money(LPF_DIESEL_COST)}`);
    expect(lpf).toContain(`trade-in${money(LPF_DIESEL_EXCHANGE_COST)}`);
    expect(lpf).not.toContain(money(DEPOT_COST.D));
    const lpfStations = section("rules-section-station");
    expect(lpfStations).toContain(`Each additional station${money(LPF_STATION_TOKEN_SCHEDULE.later)}`);
    expect(lpfStations).not.toContain("First additional station");
    const standard = page("operating");
    expect(standard).toContain(`Diesel${money(DEPOT_COST.D)}`);
    expect(standard).toContain(`trade-in${money(DIESEL_EXCHANGE_COST)}`);
    expect(section("rules-section-station")).toContain(`First additional station${money(STANDARD_STATION_TOKEN_SCHEDULE.second)}`);
  });
});

describe("RR-5 · the Overview's Tokens lookup is the table's schedule", () => {
  it("a Level Playing Field table at the Tokens step sees $100 stations, a standard one the printed $40", () => {
    page("overview", { ...LPF, operatingSubPhase: "Tokens" });
    const lpf = container.querySelector('[data-testid="rules-lookup-excerpt"]')?.textContent ?? "";
    expect(lpf).toContain(`Each additional station${money(LPF_STATION_TOKEN_SCHEDULE.later)}`);
    expect(lpf).not.toContain("$40");
    page("overview", { ...BASE, operatingSubPhase: "Tokens" });
    const standard = container.querySelector('[data-testid="rules-lookup-excerpt"]')?.textContent ?? "";
    expect(standard).toContain(`First additional station${money(STANDARD_STATION_TOKEN_SCHEDULE.second)}`);
  });
});

describe("RR-7 · the emergency private sale carries its limits", () => {
  it("the Forced Train Purchase table", () => {
    page("tables");
    const forced = section("rules-reference-forced-purchase");
    expect(forced).toContain("President sells shares to raise it");
    expect(forced).toContain("Phases 3–4");
    expect(forced).toContain("½–2× face value");
    expect(forced).toContain("never the B&O");
    // RR-4 (OD-7, ruled): "cheapest" now sits on the emergency row only -- see the OD-7 cases below.
    expect(forced).toContain("Must buy the cheapest available");
  });
});

describe("must-sell · the presidency exchange carries the curable-only qualifier", () => {
  it("both must-sell sentences on the Stock Round page say 'as far as a legal sale can fix it'", () => {
    const text = page("stock");
    expect(text).toContain("by the exchange must sell down — now if it is their turn, otherwise on their next Stock Round turn — as far as a legal sale can fix it.");
    expect(text).toContain("before buying or passing — as far as a legal sale can fix it");
  });

  it("the presidency tie reads as the engine settles it: strictly more, then nearest clockwise", () => {
    const text = page("stock");
    expect(text).toContain("a tie changes nothing");
    expect(text).toContain("the one seated nearest after the former president, going clockwise in player order");
  });
});

describe("U-38 · the Tiles tab names every tile canonically", () => {
  it("prints no hand-built `#id` label", () => {
    const source = readStripped("components/TileReference.tsx");
    expect(source).not.toMatch(/#\{tileId\}|#\$\{tileId\}/);
    expect(source.match(/canonicalTileName\(tileId\)/g)?.length).toBe(6);
  });

  it("the three errata identities are what that function returns", () => {
    expect([canonicalTileName(626), canonicalTileName(36), canonicalTileName(35)]).toEqual(["#8861", "oo13", "oo14"]);
  });
});

/* ==================================================================
    RR-4 · OD-7 (owner ruling, 2026-10-03): "CHEAPEST" IS THE EMERGENCY PURCHASE'S RESTRICTION ONLY
   ==================================================================
   A corporation whose treasury can fund a legal train purchase buys under the ordinary rules; the "must buy the
   cheapest train" restriction belongs to the emergency purchase, where the treasury cannot cover a train and the
   president's money becomes necessary. Copy only: the engine already allowed any legal treasury-funded purchase,
   and the last case proves it on a real room rather than asserting it. */
describe("RR-4 · OD-7 · a treasury-funded forced purchase is an ordinary purchase", () => {
  const TREASURY_CHEAPEST = /enough money to buy a train itself, it must purchase the cheapest/;

  it("the Operating Round's Buy Trains page: ordinary rules when the treasury can pay, cheapest only in the emergency", () => {
    const text = page("operating", { ...BASE, operatingSubPhase: "Hardware" });
    expect(text).not.toMatch(TREASURY_CHEAPEST);
    expect(text).toContain(
      "If the corporation can pay for a train from its own treasury, the ordinary purchase rules apply: it may buy any train it could legally buy, not only the cheapest.",
    );
    expect(text).toContain(
      "If the corporation's treasury cannot cover the cheapest available train, this is an emergency purchase: it must buy the cheapest available train",
    );
  });

  it("the Tables page's Forced Train Purchase rows put 'cheapest' on the emergency row, not the treasury row", () => {
    page("tables");
    const rows = Array.from(container.querySelectorAll<HTMLElement>("#rules-reference-forced-purchase tr")).map(
      (row) => row.textContent ?? "",
    );
    const treasuryRow = rows.find((row) => row.startsWith("Corporation can afford a train")) ?? "";
    const emergencyRow = rows.find((row) => row.startsWith("Corporation + president can afford one")) ?? "";
    expect(treasuryRow).toContain("Ordinary purchase rules: any train it may legally buy");
    expect(treasuryRow).not.toContain("cheapest");
    expect(emergencyRow).toContain("Must buy the cheapest available");
  });

  it("no page says a corporation that can pay from its treasury must buy the cheapest train", () => {
    for (const id of ["overview", "stock", "operating", "auction", "tables"] as const) {
      const text = page(id, { ...BASE, operatingSubPhase: "Hardware" });
      expect([id, TREASURY_CHEAPEST.test(text)]).toEqual([id, false]);
      expect([id, text.includes("must buy the cheapest available train — from its own treasury first")]).toEqual([id, false]);
      expect([id, text.includes("must buy the cheapest train available: its treasury first")]).toEqual([id, false]);
    }
    // The Watch For reminder and the gotcha it reads say "cheapest" only for the treasury that cannot cover it.
    const overview = page("overview", { ...BASE, operatingSubPhase: "Hardware" });
    expect(overview).toContain("Only when its treasury cannot cover the cheapest train available must it buy that train");
  });

  it("the page still states its standing (U-40) now that RR-4 agrees with the engine", () => {
    for (const id of ["operating", "tables"] as const) {
      page(id);
      expect(container.querySelector('[data-testid="rules-authority"]')?.textContent).toBe(RULES_AUTHORITY_SENTENCE);
    }
  });

  it("the engine agrees: a trainless corporation with treasury to spare may buy a train dearer than the cheapest", () => {
    // PRR (Alice) owns no train and holds $500, enough for the cheapest train for sale. PRR offers $70 MORE than
    // that cheapest train for one of NYC's 3-trains, and the room accepts the offer and settles it.
    const board = S.withCorp(F.operatingBoard(), F.PRR, { owned_trains: [] });
    const cheapest = cheapestPurchasableTrain(board)!;
    const price = cheapest.cost + 70;
    expect(price).toBeLessThanOrEqual(F.treasury(board, F.PRR));
    const room = S.roomFor(board);
    expect(room.submit(F.P1, S.M.proposeTrain(F.NYC, F.PRR, "3", String(price))).kind).toBe("applied");
    expect(room.submit(F.P2, S.M.answerTrain(F.NYC, true)).kind).toBe("applied");
    const prr = room.room.state.public_companies.find((entry) => entry.company_id === F.PRR)!;
    expect(prr.owned_trains).toEqual(["3"]);
    expect(Number(prr.treasury)).toBe(F.treasury(board, F.PRR) - price);
  });
});

