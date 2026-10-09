// server/src/ludum/integration.test.ts
//
// LUDUM v1 (coordinator integration): the seams no single lane owned. The REAL `LudumPorts` (`wiring.ts`, Lane A) over a
// real money world (`moneyServer`, `fakeJunoChain`) feeding the REAL handlers -- `games` / `game` (Lane C) and `case`
// (Lane B2) -- plus the route table's access rules once the step-0 stubs were replaced.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { hostCreates, linkWallet, moneyServer, openMoneyTable, player, testConsentKey, testWallet } from "../escrow/escrow4Support";
import { quietConsole } from "../rooms/testSupport";
import type { CaseRecord, GameDetail, GamesResponse } from "./contract";
import type { LudumPorts } from "./ports";
import { LUDUM_ROUTES } from "./registry";
import { createLudumPorts } from "./wiring";
import { readChainGame } from "./history/chainView";
import { chainFact } from "./history/facts";
import { netOf, type LedgerEntry } from "./history/ledger";

quietConsole();

describe("LUDUM integration: real ports into the real handlers", () => {
  test("the chain port hands the handlers the raw contract answer: history and case both read it", async () => {
    const world = await moneyServer();
    try {
      const host = await player(world, "Hana");
      const table = await openMoneyTable(host);
      const wallet = testWallet("host");
      const key = testConsentKey("host");
      const linked = await linkWallet(host, table.gameId, wallet, key);
      assert.equal(linked.status, 200, linked.text);
      const chainGameId = await hostCreates(world, host, table.gameId, wallet, key, linked.body?.ticket as string);
      await world.observe();

      const ports = createLudumPorts({ records: () => world.server.rooms.records(), money: () => world.money, now: () => world.clock.now });
      const cookie = host.browser.cookie;
      const principalId = world.identity.securityContextOf({ kind: "session", sessionId: cookie.split("=")[1].split(".")[1], secret: cookie.split(".")[2] }, world.clock.now)?.principalId;
      assert.ok(principalId);

      /* Lane C over Lane A: the account's list and the game's detail, with a chain-read escrow state. */
      const list = await LUDUM_ROUTES.games.handler!({}, { principalId }, ports);
      assert.equal(list.status, 200, JSON.stringify(list.json));
      const summary = (list.json as GamesResponse).games.find((g) => g.gameId === table.gameId);
      assert.ok(summary, "the account's money table is listed");
      assert.equal(summary.money?.chainGameId, chainGameId);
      assert.ok(summary.money?.escrow.provenance.startsWith("chain-"), `escrow state is a chain fact: ${JSON.stringify(summary.money?.escrow)}`);
      assert.equal(summary.money?.escrow.value, "funding");

      const detail = await LUDUM_ROUTES.game.handler!({ gameId: table.gameId }, { principalId }, ports);
      assert.equal(detail.status, 200, JSON.stringify(detail.json));
      const ledger = (detail.json as GameDetail).ledger;
      assert.ok(ledger, "a money game has a ledger");
      /* Before Start no roster is frozen, so no entry may claim a chain amount for this seat: it says why instead. */
      const ante = ledger.entries.find((e) => e.kind === "ante_gross");
      assert.ok(ante, "the deposit is a ledger entry");
      assert.equal(ante.fact.provenance, "unavailable");
      assert.match(String(ante.fact.reason), /roster/);
      assert.equal(ledger.net.provenance, "unavailable", "net takes its weakest input");

      /* The port's answer is the RAW contract form, so Lane C reads the fields the parser drops from the chain itself. */
      const read = await ports.chainGame(chainGameId);
      assert.ok(read);
      const view = readChainGame(read.game);
      assert.ok(view.ok, view.ok ? "" : view.reason);
      const rawSeat = (read.game as { game: { seats: Array<{ subsidy_paid: string }> } }).game.seats[0];
      assert.equal(view.view.seats[0].subsidyPaid, BigInt(rawSeat.subsidy_paid), "subsidy_paid comes from the chain, not re-derived");

      /* Lane B2 over Lane A: the public case record parses the same raw answer (it threw on the parser's output). */
      const record = await LUDUM_ROUTES.case.handler!({ chainGameId }, { principalId: null }, ports);
      assert.equal(record.status, 200, JSON.stringify(record.json));
      const c = record.json as CaseRecord;
      assert.equal(c.chainGameId, chainGameId);
      assert.equal(c.escrow.value, "funding");
      assert.ok(c.escrow.provenance.startsWith("chain-"));
      assert.equal(c.dispute.provenance, "unavailable", "no dispute on a funding game");
      assert.ok(!JSON.stringify(c).includes("Hana"), "the public case record carries no display name");

      /* Another account sees nothing of this game. */
      const stranger = await LUDUM_ROUTES.game.handler!({ gameId: table.gameId }, { principalId: "pr_00000000000000000000000000" }, ports);
      assert.equal(stranger.status, 404);
    } finally {
      await world.close();
    }
  });
});

/* §4 ledger convention (coordinator, codified at integration): every entry `amount` is a NON-NEGATIVE magnitude; the entry
   KIND alone gives the direction (ante_gross, bond_posted: out; bond_returned, payout, refund: in; subsidy, bond_forfeited:
   informational, never added again); only `net` may be negative. */
describe("LUDUM integration: the ledger sign convention", () => {
  const source = { provenance: "chain-confirmed" as const, height: "100", observedAt: "2026-10-09T00:00:00.000Z" };
  const entry = (kind: LedgerEntry["kind"], amount: string): LedgerEntry => ({ kind, amount: { amount, denom: "ujunox" }, fact: chainFact(true as const, source) });

  test("magnitudes in, kind-directed sum out; informational kinds are not counted; net may be negative", () => {
    const entries = [entry("ante_gross", "5000000"), entry("subsidy", "125000"), entry("bond_posted", "2437500"), entry("bond_forfeited", "2437500"), entry("payout", "2000000")];
    for (const e of entries) assert.match(e.amount.amount, /^\d+$/, `${e.kind} is a magnitude`);
    const net = netOf(entries);
    assert.equal(net.provenance, "chain-confirmed");
    assert.equal(net.value?.amount, "-5437500", "2000000 - 5000000 - 2437500; subsidy and bond_forfeited already inside");
  });

  test("a refund of the whole net deposit after the subsidy nets to minus the subsidy", () => {
    const net = netOf([entry("ante_gross", "5000000"), entry("subsidy", "125000"), entry("refund", "4875000")]);
    assert.equal(net.value?.amount, "-125000");
  });
});

/* Conduct / moderation boundary (behavioural constraint, reviewed at integration): nothing under server/src/ludum reads the
   conduct store, its review routes or the trust facts -- so no Ludum answer can carry a conduct case, its count, its
   outcome or a sanction. (The handlers' own tests pin their exact output keys.) */
describe("LUDUM integration: no conduct data reaches a Ludum answer", () => {
  test("no Ludum module imports conduct, trust facts or reviewer configuration", () => {
    const root = path.join(__dirname);
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".js") && !entry.name.endsWith(".test.js")) files.push(full);
      }
    };
    walk(root);
    assert.ok(files.length >= 8, `found the compiled ludum modules (${files.length})`);
    for (const file of files) {
      const text = fs.readFileSync(file, "utf8");
      assert.doesNotMatch(text, /require\("[^"]*conduct[^"]*"\)|require\("[^"]*trustFacts[^"]*"\)|GS_CONDUCT_REVIEWERS/, path.relative(root, file));
    }
  });
});
