// frontend/src/components/phase3W3JCopy.test.ts
//
// ==================================================================
//  PHASE 3 W3-J: PLAYER-FACING COPY THAT HAD FALLEN BEHIND THE AUTHORITY
// ==================================================================
//
// AUD-25.13 (W2-B out-of-scope note, FIX IN W3-J): the Stock Round tutorial's "Selling shares" page opened "Instead of
// buying shares, players can Sell" -- the pre-v13 turn. Rules v13's turn is Sell -> Buy -> Sell.
// AUD-25.12 (W2-E residue): `privateCatalog.ts`'s M&H text said the exchange happens "between turns" and that taking
// it closes the company; the authority (`mohawkExchange.ts`) executes it at once only on the owner's own Stock Round
// turn and otherwise queues it to the next turn boundary, re-checked there.
// Both now quote the Rules Reference's own sentences verbatim, and the sentences' claims are asked of the engine.

import { readFileSync } from "fs";
import { readShell, readShellRaw, sliceBetween } from "../utils/sourceScan"; // AUD-25.10 (g)
import { join } from "path";

import { STOCK_ROUND_TUTORIAL } from "./TutorialModal";
import { PRIVATE_COMPANY_CATALOG, abilitySummary } from "../utils/privateCatalog";
import { mhExchangeDisposition } from "../gameEngine/mohawkExchange";
import type { GameStateResponse } from "../gameEngine/gameState";

const RULES_REFERENCE = readFileSync(join(__dirname, "RulesReference.tsx"), "utf8");
/** The Rules Reference M&H card's source (`id: "mh"` up to the next card). */
const MH_CARD = (() => {
  const start = RULES_REFERENCE.indexOf('id: "mh"');
  const end = RULES_REFERENCE.indexOf('id: "ca"', start);
  if (start < 0 || end < 0) throw new Error("the Rules Reference M&H card was not found");
  return RULES_REFERENCE.slice(start, end);
})();
/** The sentences of a paragraph, split at ". " (none of these sentences has an abbreviation with a full stop). */
const sentences = (text: string) =>
  text
    .split(/(?<=\.)\s+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

describe("W3-J AUD-25.13 (tutorial): the Selling shares page describes the v13 turn", () => {
  const page = STOCK_ROUND_TUTORIAL.find((entry) => entry.title === "Selling shares");

  it("no longer says a sale is an alternative to buying", () => {
    expect(page).toBeDefined();
    expect(page!.body).not.toMatch(/Instead of buying/i);
  });

  it("quotes the Rules Reference's Sell -> Buy -> Sell gotcha verbatim", () => {
    const gotcha = "The turn is Sell → Buy 1 certificate → Sell. You may sell after buying.";
    expect(RULES_REFERENCE).toContain(`{ text: "${gotcha}", page: "stock" }`);
    expect(page!.body.split("\n")[0]).toContain(gotcha);
  });

  it("no other Stock Round tutorial page offers selling as an alternative to buying", () => {
    for (const entry of STOCK_ROUND_TUTORIAL) expect([entry.title, /instead of buying/i.test(entry.body)]).toEqual([entry.title, false]);
  });
});

describe("W3-J AUD-25.12: the M&H catalog entry is the Rules Reference card's text", () => {
  const mh = PRIVATE_COMPANY_CATALOG[4];

  it("drops the stale claims: 'between turns' and 'taking it closes the company'", () => {
    const all = `${mh.ability} ${abilitySummary(mh)}`;
    expect(all).not.toMatch(/between turns/i);
    expect(all).not.toMatch(/Taking it closes/i);
  });

  it("every sentence of the long form is a sentence of the card", () => {
    for (const sentence of sentences(mh.ability)) expect([sentence, MH_CARD.includes(sentence)]).toEqual([sentence, true]);
  });

  it("the short bullets say the card's queued timing and closure (two bullets, each one line)", () => {
    // `privateCardCopy.test.ts` holds every private to two bullets of <= 100 characters, so the timing bullet is the
    // card's two sentences said short; the long form above is the card's, verbatim.
    expect(mh.abilityBullets).toHaveLength(2);
    expect(mh.abilityBullets[1]).toMatch(/Queued unless it is the owner's own Stock Round turn/);
    expect(mh.abilityBullets[1]).toMatch(/closes the M&H when it executes/);
    expect(MH_CARD).toContain("Requested at any other time, it is queued");
    expect(MH_CARD).toContain("The exchange closes Mohawk & Hudson when it executes.");
  });

  it("names the owner's choice of pile, the Orange/Brown waiver, the certificate limit and the queued timing", () => {
    expect(mh.ability).toMatch(/the other pile is never substituted/);
    expect(mh.ability).toMatch(/Orange or Brown zone/);
    expect(mh.ability).toMatch(/certificate limit/);
    expect(mh.ability).toMatch(/queued and executes at the next turn boundary only if it is still legal then/);
  });

  it("what the text says about timing is what the authority does", () => {
    const board = (round: "StockRound" | "OperatingRound", seated: number) =>
      ({ current_round_type: round, player_addresses: ["p-owner", "p-other"], active_player_index: seated }) as unknown as GameStateResponse;
    const request = { player: "p-owner", private_id: 4, company_id: 3, source: "Ipo" } as never;
    // "On the owner's own Stock Round turn it executes at once."
    expect(mhExchangeDisposition(board("StockRound", 0), request)).toBe("execute");
    // "Requested at any other time, it is queued ..."
    expect(mhExchangeDisposition(board("StockRound", 1), request)).toBe("queue");
    expect(mhExchangeDisposition(board("OperatingRound", 0), request)).toBe("queue");
  });
});

describe("AUD-25.10 (g): the route comments describe the run the shell sends (one RunMultipleRoutes, #968)", () => {
  const raw = readShellRaw();

  it("Auto Route's and Run Routes' notes no longer say a run is a RunManualRoute per train", () => {
    expect(raw).not.toContain("dispatched through the same RunManualRoute");
    expect(raw).not.toContain("/* One RunManualRoute per train, awaited in sequence.");
    expect(raw).toContain("run by the same Run Routes press (one\n     `RunMultipleRoutes`, #968)");
    expect(raw).toContain("/* Every runnable draft goes in ONE `RunMultipleRoutes` (#968, below).");
  });

  it("the run handler does send one RunMultipleRoutes, and no RunManualRoute", () => {
    const run = sliceBetween(readShell(), "const handleRunTrains = useCallback(", "const handlePayDividends = useCallback(");
    expect(run).toContain("RunMultipleRoutes: {");
    expect(run).not.toContain("RunManualRoute: {");
  });
});
