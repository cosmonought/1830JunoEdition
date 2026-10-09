// LUDUM v1 -- player history (Lane C): every escrow money route, read back as one seat's ledger, against the offline
// chain (`escrow/juno/fakeJunoChain.ts`). The expected figures are the contract's own arithmetic (`payout.rs`,
// `execute/*.rs`), written out as literals so a change in either side shows here.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import type { GameDetail, Provenance } from "../contract";
import { game } from "./index";
import { ANTE_GROSS, ANTE_NET, BOND, PEOPLE, RESOLVER, evidenceOf, financialOf, moneyTable, recordOf, settleOn, startOn, worldOf, type World } from "./historyTestSupport";

const [ALICE, BOB, CAROL] = PEOPLE;
type Person = (typeof PEOPLE)[number];

async function detail(world: World, gameId: string, who: Person): Promise<GameDetail> {
  const answer = await game({ gameId }, { principalId: who.principal }, world.ports);
  assert.equal(answer.status, 200, JSON.stringify(answer.json));
  return answer.json as GameDetail;
}

/** The ledger as `kind:amount@provenance` lines, and the net. */
function lines(d: GameDetail): string[] {
  return d.ledger!.entries.map((e) => `${e.kind}:${e.amount.amount}@${e.fact.provenance}`);
}
const net = (d: GameDetail) => d.ledger!.net;

const C = "chain-confirmed";

describe("ledger: settled routes (pay_out by the stored weights)", () => {
  test("finalized: payout = floor(pool * w / Σw), dust to the treasury; net is exact", async () => {
    const world = worldOf();
    const { gameId, chainGameId } = moneyTable(world);
    settleOn(world.chain, chainGameId, ["1301", "977", "3"]);
    /* payout.rs simple_split_and_dust: pool 5_850_000 by [1301, 977, 3] -> 3_336_628, 2_505_677, 7_693, dust 2. */
    world.chain.forceState(chainGameId, { state: "settled", outcome: { route: "finalized", at: world.chain.time, amounts: ["3336628", "2505677", "7693"], dust: "2" } });
    const a = await detail(world, gameId, ALICE);
    assert.deepEqual(lines(a), [`ante_gross:${ANTE_GROSS}@${C}`, `subsidy:50000@${C}`, `payout:3336628@${C}`]);
    assert.deepEqual(net(a).value, { amount: "1336628", denom: "ujunox" });
    assert.equal(net(a).provenance, C);
    assert.equal(net(a).height, String(world.chain.height));
    assert.equal(a.money?.escrow.value, "settled");
    assert.equal(a.ledger?.networkFeesIncluded, false);
    const c = await detail(world, gameId, CAROL);
    assert.deepEqual(net(c).value, { amount: "-1992307", denom: "ujunox" });
    assert.equal(c.seat.chainSeatIndex, 2);
  });

  test("consent_completed and all_consents_at_settle are payouts too", async () => {
    for (const route of ["consent_completed", "all_consents_at_settle"]) {
      const world = worldOf();
      const { gameId, chainGameId } = moneyTable(world);
      settleOn(world.chain, chainGameId, ["1", "1", "1"]);
      world.chain.forceState(chainGameId, { state: "settled", outcome: { route, at: world.chain.time, amounts: ["1950000", "1950000", "1950000"], dust: "0" } });
      const b = await detail(world, gameId, BOB);
      assert.deepEqual(lines(b).at(-1), `payout:1950000@${C}`, route);
      assert.equal(net(b).value?.amount, "-50000", route);
    }
  });
});

describe("ledger: disputes (execute/dispute.rs)", () => {
  test("uphold: the bond joins the pool (bond_forfeited), the challenger's share of it is in its payout", async () => {
    const world = worldOf();
    const { gameId, chainGameId } = moneyTable(world, "disputed");
    settleOn(world.chain, chainGameId, ["1301", "977", "3"]);
    assert.deepEqual(world.chain.challenge(chainGameId, BOB.wallet), { ok: true });
    assert.deepEqual(world.chain.resolve(chainGameId, RESOLVER, { uphold: {} }), { ok: true });
    /* pool 5_850_000 + bond 1_000_000 = 6_850_000 by [1301, 977, 3] (Σ 2281): 3_906_992 / 2_933_998 / 9_009, dust 1. */
    const b = await detail(world, gameId, BOB);
    assert.deepEqual(lines(b), [`ante_gross:${ANTE_GROSS}@${C}`, `subsidy:50000@${C}`, `bond_posted:${BOND}@${C}`, `bond_forfeited:${BOND}@${C}`, `payout:2933998@${C}`]);
    assert.equal(net(b).value?.amount, "-66002"); // -2_000_000 - 1_000_000 + 2_933_998
    assert.equal(b.dispute?.value?.challengerIsYou, true);
    assert.equal(b.dispute?.value?.resolution, "uphold");
    assert.equal(b.disputed.value, true);
    assert.equal(b.caseUrl, `https://ludum.netadao.org/disputes/case/?id=${chainGameId}`);
    const a = await detail(world, gameId, ALICE);
    assert.deepEqual(lines(a), [`ante_gross:${ANTE_GROSS}@${C}`, `subsidy:50000@${C}`, `payout:3906992@${C}`], "no bond entry for a non-challenger");
    assert.equal(net(a).value?.amount, "1906992");
    assert.equal(a.dispute?.value?.challengerIsYou, false);
  });

  test("annul: every net deposit refunded, the bond returned", async () => {
    const world = worldOf();
    const { gameId, chainGameId } = moneyTable(world, "disputed");
    settleOn(world.chain, chainGameId, ["1", "0", "0"]);
    assert.deepEqual(world.chain.challenge(chainGameId, BOB.wallet), { ok: true });
    assert.deepEqual(world.chain.resolve(chainGameId, RESOLVER, { annul: {} }), { ok: true });
    const b = await detail(world, gameId, BOB);
    assert.deepEqual(lines(b), [`ante_gross:${ANTE_GROSS}@${C}`, `subsidy:50000@${C}`, `bond_posted:${BOND}@${C}`, `bond_returned:${BOND}@${C}`, `refund:${ANTE_NET}@${C}`]);
    assert.equal(net(b).value?.amount, "-50000");
    assert.equal(b.money?.escrow.value, "annulled");
    assert.equal(b.dispute?.value?.resolution, "annul");
  });

  test("replace: the resolver's weights pay out, the bond is returned", async () => {
    const world = worldOf();
    const { gameId, chainGameId } = moneyTable(world, "disputed");
    settleOn(world.chain, chainGameId, ["1", "0", "0"]);
    assert.deepEqual(world.chain.challenge(chainGameId, BOB.wallet), { ok: true });
    assert.deepEqual(world.chain.resolve(chainGameId, RESOLVER, { replace: { settlement_weights: ["1", "1", "0"] } }), { ok: true });
    const b = await detail(world, gameId, BOB);
    assert.deepEqual(lines(b), [`ante_gross:${ANTE_GROSS}@${C}`, `subsidy:50000@${C}`, `bond_posted:${BOND}@${C}`, `bond_returned:${BOND}@${C}`, `payout:2925000@${C}`]);
    assert.equal(net(b).value?.amount, "925000");
    assert.equal(b.dispute?.value?.resolution, "replace");
    const c = await detail(world, gameId, CAROL);
    assert.equal(net(c).value?.amount, "-2000000");
  });

  test("still disputed: the bond is posted, nothing has come back; net is pending", async () => {
    const world = worldOf();
    const { gameId, chainGameId } = moneyTable(world, "disputed");
    settleOn(world.chain, chainGameId, ["1", "1", "1"]);
    assert.deepEqual(world.chain.challenge(chainGameId, BOB.wallet), { ok: true });
    const b = await detail(world, gameId, BOB);
    assert.deepEqual(lines(b), [`ante_gross:${ANTE_GROSS}@${C}`, `subsidy:50000@${C}`, `bond_posted:${BOND}@${C}`]);
    assert.equal(net(b).provenance, "pending");
    assert.equal(net(b).value?.amount, "-3000000");
    const d = b.dispute!.value!;
    assert.equal(d.resolution, null);
    assert.equal(d.resolvedAt, null);
    assert.equal(Date.parse(d.resolverTimeoutAt) - Date.parse(d.disputedAt), 2_592_000_000, "disputed_at + resolver_timeout_secs (query.rs)");
  });

  test("liveness_settle after the resolver timeout: the stored settlement is paid and the bond returned", async () => {
    const world = worldOf();
    const { gameId, chainGameId } = moneyTable(world, "disputed");
    settleOn(world.chain, chainGameId, ["1", "1", "1"]);
    assert.deepEqual(world.chain.challenge(chainGameId, BOB.wallet), { ok: true });
    world.chain.time += 2_592_000;
    assert.deepEqual(world.chain.resolverTimeoutExit(chainGameId, ALICE.wallet), { ok: true });
    const b = await detail(world, gameId, BOB);
    assert.deepEqual(lines(b).slice(2), [`bond_posted:${BOND}@${C}`, `bond_returned:${BOND}@${C}`, `payout:1950000@${C}`]);
    assert.equal(net(b).value?.amount, "-50000");
    assert.equal(b.dispute?.value?.resolution, null, "a timeout is not a resolver decision");
  });
});

describe("ledger: liveness, remedy, cancel and withdraw", () => {
  test("liveness_settle from SETTLEABLE (settleable_timeout_payout) pays the stored settlement", async () => {
    const world = worldOf();
    const { gameId, chainGameId } = moneyTable(world);
    settleOn(world.chain, chainGameId, ["2", "1", "0"]);
    world.chain.forceState(chainGameId, { state: "settled", outcome: { route: "settleable_timeout_payout", at: world.chain.time, amounts: ["3900000", "1950000", "0"], dust: "0" } });
    assert.equal(net(await detail(world, gameId, ALICE)).value?.amount, "1900000");
  });

  test("liveness refund routes return the net deposit", async () => {
    for (const route of ["liveness_refund", "settleable_timeout_refund", "resolver_timeout_refund", "review_annul", "remedy_timeout_annul", "remedy_annul", "annul_by_consent"]) {
      const world = worldOf();
      const { gameId, chainGameId } = moneyTable(world);
      startOn(world.chain, chainGameId);
      world.chain.forceState(chainGameId, { state: route === "annul_by_consent" || route.endsWith("annul") ? "annulled" : "cancelled", outcome: { route, at: world.chain.time, amounts: [ANTE_NET, ANTE_NET, ANTE_NET], dust: "0" } });
      const a = await detail(world, gameId, ALICE);
      assert.equal(lines(a).at(-1), `refund:${ANTE_NET}@${C}`, route);
      assert.equal(net(a).value?.amount, "-50000", route);
    }
  });

  test("remedy foreclosure: the defaulting seat gets 0, the others net + floor(net_D / (N-1))", async () => {
    const world = worldOf();
    const { gameId, chainGameId } = moneyTable(world);
    startOn(world.chain, chainGameId);
    /* payout.rs foreclosure_split: 3 seats of 1_950_000, seat 2 defaults -> 975_000 each to the others, no dust. */
    world.chain.forceState(chainGameId, { state: "settled", outcome: { route: "remedy_foreclosure", at: world.chain.time, amounts: ["2925000", "2925000", "0"], dust: "0" } });
    assert.equal(net(await detail(world, gameId, ALICE)).value?.amount, "925000");
    const c = await detail(world, gameId, CAROL);
    assert.deepEqual(lines(c).at(-1), `payout:0@${C}`);
    assert.equal(net(c).value?.amount, "-2000000");
  });

  test("cancelled before Start: every net deposit refunded (the subsidy is not)", async () => {
    const world = worldOf();
    const { gameId, chainGameId } = moneyTable(world, "cancelled", { started: false });
    assert.deepEqual(world.chain.cancel(chainGameId, ALICE.wallet), { ok: true });
    const b = await detail(world, gameId, BOB);
    assert.deepEqual(lines(b), [`ante_gross:${ANTE_GROSS}@${C}`, `subsidy:50000@${C}`, `refund:${ANTE_NET}@${C}`]);
    assert.equal(net(b).value?.amount, "-50000");
    assert.equal(b.money?.escrow.value, "cancelled");
  });

  test("withdrawn during funding: the seat vanished from Game.seats, so its amounts are unavailable, never guessed", async () => {
    const world = worldOf();
    const { gameId, chainGameId } = moneyTable(world, "funding", { started: false });
    assert.deepEqual(world.chain.withdraw(chainGameId, BOB.wallet), { ok: true });
    const b = await detail(world, gameId, BOB);
    assert.deepEqual(b.ledger!.entries.map((e) => [e.kind, e.fact.provenance]), [["ante_gross", "unavailable"], ["refund", "unavailable"]]);
    assert.match(b.ledger!.entries[0].fact.reason ?? "", /withdrew before Start/);
    assert.equal(net(b).value, null);
    assert.equal(net(b).provenance, "unavailable");
    assert.equal(b.seat.chainSeatIndex, null);
    /* Carol moved up to index 1 (later seats move up before Start); her deposit is still on chain, nothing settled. */
    const c = await detail(world, gameId, CAROL);
    assert.equal(c.seat.chainSeatIndex, 1);
    assert.deepEqual(lines(c), [`ante_gross:${ANTE_GROSS}@${C}`, `subsidy:50000@${C}`]);
    assert.equal(net(c).provenance, "pending");
    assert.equal(net(c).value?.amount, "-2000000");
  });
});

describe("ledger: provenance is downgraded whenever an input is not a chain fact", () => {
  test("a single-endpoint read is chain-observed, never chain-confirmed", async () => {
    const world = worldOf();
    world.mode = "observed";
    const { gameId, chainGameId } = moneyTable(world);
    settleOn(world.chain, chainGameId, ["1", "1", "1"]);
    world.chain.forceState(chainGameId, { state: "settled", outcome: { route: "finalized", at: world.chain.time, amounts: ["1950000", "1950000", "1950000"], dust: "0" } });
    const a = await detail(world, gameId, ALICE);
    for (const e of a.ledger!.entries) assert.equal(e.fact.provenance, "chain-observed");
    assert.equal(net(a).provenance, "chain-observed");
    assert.equal(net(a).height, undefined);
    assert.equal(a.money?.escrow.provenance, "chain-observed");
  });

  test("the production parser's form gives the same figures (subsidy = gross - net)", async () => {
    const world = worldOf();
    world.mode = "parsed-quorum";
    const { gameId, chainGameId } = moneyTable(world, "disputed");
    settleOn(world.chain, chainGameId, ["1301", "977", "3"]);
    assert.deepEqual(world.chain.challenge(chainGameId, BOB.wallet), { ok: true });
    assert.deepEqual(world.chain.resolve(chainGameId, RESOLVER, { uphold: {} }), { ok: true });
    const b = await detail(world, gameId, BOB);
    assert.deepEqual(lines(b), [`ante_gross:${ANTE_GROSS}@${C}`, `subsidy:50000@${C}`, `bond_posted:${BOND}@${C}`, `bond_forfeited:${BOND}@${C}`, `payout:2933998@${C}`]);
    assert.equal(net(b).value?.amount, "-66002");
    /* disputed_at is not in the parsed form once the dispute has ended: the dispute fact says so instead of guessing. */
    assert.equal(b.dispute?.provenance, "unavailable");
  });

  test("chain unreadable, dealt game: the deposit is server-recorded terms, the payout pending", async () => {
    const world = worldOf();
    world.mode = "throws";
    const { gameId } = moneyTable(world, "in-progress");
    const a = await detail(world, gameId, ALICE);
    assert.deepEqual(lines(a), [`ante_gross:${ANTE_GROSS}@server-recorded`]);
    assert.equal(net(a).provenance, "pending");
    assert.equal(net(a).value?.amount, "-2000000");
    assert.equal(a.money?.escrow.provenance, "server-recorded");
    assert.equal(a.money?.escrow.value, "in_progress");
  });

  test("chain unreadable, funding: the deposit itself is only pending", async () => {
    const world = worldOf();
    world.mode = "throws";
    const { gameId } = moneyTable(world, "funding", { started: false });
    const a = await detail(world, gameId, ALICE);
    assert.deepEqual(lines(a), [`ante_gross:${ANTE_GROSS}@pending`]);
    assert.equal(net(a).provenance, "pending");
  });

  test("chain unreadable after the close: the outcome is unavailable, so is net", async () => {
    const world = worldOf();
    world.mode = "throws";
    const { gameId } = moneyTable(world, "closed");
    const a = await detail(world, gameId, ALICE);
    assert.equal(net(a).value, null);
    assert.equal(net(a).provenance, "unavailable");
    assert.ok((net(a).reason ?? "").length > 0);
    assert.equal(a.money?.escrow.provenance, "server-recorded");
    assert.equal(a.disputed.provenance, "unavailable");
  });

  test("no chain game bound yet (funding): pending; no financial record: unavailable", async () => {
    const world = worldOf();
    const record = recordOf();
    world.records.push(record);
    world.financial.set(record.game_id, financialOf(record.game_id, null, "funding", { started: false }));
    const a = await detail(world, record.game_id, ALICE);
    assert.equal(a.money?.chainGameId, null);
    assert.equal(net(a).provenance, "pending");
    assert.equal(a.money?.escrow.provenance, "unavailable");
    world.financial.delete(record.game_id);
    const again = await detail(world, record.game_id, ALICE);
    assert.equal(net(again).provenance, "unavailable");
  });

  test("a roster that does not map the seat: unavailable, not a guess", async () => {
    const world = worldOf();
    const { gameId, chainGameId } = moneyTable(world, "closed", { roster: false });
    settleOn(world.chain, chainGameId, ["1", "1", "1"]);
    world.chain.forceState(chainGameId, { state: "settled", outcome: { route: "finalized", at: world.chain.time, amounts: ["1950000", "1950000", "1950000"], dust: "0" } });
    const a = await detail(world, gameId, ALICE);
    assert.equal(net(a).provenance, "unavailable");
    assert.equal(a.seat.chainSeatIndex, null);
  });

  test("every provenance in a ledger is one of the five, and value is null iff unavailable", async () => {
    const world = worldOf();
    const { gameId, chainGameId } = moneyTable(world);
    settleOn(world.chain, chainGameId, ["1", "1", "1"]);
    const facts: Array<{ value: unknown; provenance: Provenance; reason?: string }> = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) node.forEach(walk);
      else if (node !== null && typeof node === "object") {
        const o = node as Record<string, unknown>;
        if ("provenance" in o && "value" in o) facts.push(o as never);
        Object.values(o).forEach(walk);
      }
    };
    walk(await detail(world, gameId, ALICE));
    assert.ok(facts.length > 5);
    for (const f of facts) {
      assert.ok(["chain-confirmed", "chain-observed", "server-recorded", "pending", "unavailable"].includes(f.provenance));
      assert.equal(f.value === null, f.provenance === "unavailable");
      if (f.provenance === "unavailable") assert.ok((f.reason ?? "").length > 0);
    }
  });
});

describe("in-game results (server-recorded, in-game dollars)", () => {
  test("money games: rank and final net worth from the terminal evidence; dollars never in a Junox", async () => {
    const world = worldOf();
    const { gameId, chainGameId } = moneyTable(world);
    settleOn(world.chain, chainGameId, ["6100", "7400", "7400"]);
    world.chain.forceState(chainGameId, { state: "settled", outcome: { route: "finalized", at: world.chain.time, amounts: ["1585000", "2132500", "2132500"], dust: "0" } });
    world.evidence.set(gameId, evidenceOf(gameId, { "p-alice": "6100", "p-bob": "7400", "p-carol": "7400" }));
    const a = await detail(world, gameId, ALICE);
    assert.deepEqual(a.inGame, { rank: { value: 3, provenance: "server-recorded" }, finalNetWorth: { value: { dollars: 6100 }, provenance: "server-recorded" } });
    assert.deepEqual(a.seats.map((s) => [s.displayName, s.rank.value, s.finalNetWorth.value?.dollars, s.you]), [["Alice", 3, 6100, true], ["Bob", 1, 7400, false], ["Carol", 1, 7400, false]]);
    assert.deepEqual(a.terminal, { value: { reason: "BankBroken", logLen: 40, logHash: "1".repeat(64) }, provenance: "server-recorded" });
    /* Separate types: every Junox is exactly {amount, denom}; every InGameMoney exactly {dollars}; no figure in both. */
    const dollars = new Set(["6100", "7400"]);
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) node.forEach(walk);
      else if (node !== null && typeof node === "object") {
        const o = node as Record<string, unknown>;
        if ("denom" in o) {
          assert.deepEqual(Object.keys(o).sort(), ["amount", "denom"]);
          assert.ok(!dollars.has(String(o.amount).replace("-", "")), `a dollar figure leaked into a Junox: ${String(o.amount)}`);
        }
        if ("dollars" in o) assert.deepEqual(Object.keys(o), ["dollars"]);
        Object.values(o).forEach(walk);
      }
    };
    walk(a);
  });

  test("no-money games: no money block, results unavailable ('not recorded; replay required')", async () => {
    const world = worldOf();
    const record = recordOf({ money: false });
    world.records.push(record);
    const a = await detail(world, record.game_id, ALICE);
    assert.equal(a.money, null);
    assert.equal(a.ledger, null);
    assert.equal(a.dispute, null);
    assert.equal(a.caseUrl, null);
    assert.deepEqual(a.inGame.rank, { value: null, provenance: "unavailable", reason: "not recorded; replay required" });
    assert.deepEqual(a.inGame.finalNetWorth, { value: null, provenance: "unavailable", reason: "not recorded; replay required" });
    assert.equal(a.terminal.provenance, "unavailable");
    assert.deepEqual(a.seats.map((s) => s.chainSeatIndex), [null, null, null]);
  });
});
