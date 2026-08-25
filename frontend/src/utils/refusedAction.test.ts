/** @jest-environment node */
//
// The Activity Log distinguishes an action taken from an action declined. No React.
//
// ==================================================================
//  DESIGN NOTE 778 (harness): THE LOG WAS THE UNRELIABLE WITNESS
// ==================================================================
//
// REPORTED: "player was at 60% corporation limit. The activity log printed the purchase went through but it
// didn't."
//
// THE MOST USEFUL BUG OF THE SESSION, because it is the reason several others were hard. Since #712 the
// reducer refuses an illegal message by returning the state unchanged -- deliberately, so a replay does not
// halt on an entry the log already contains -- and #748, #757, #763 and #774 all followed that pattern. Every
// one of those gates is silent, and the drain wrote `status: "success"` for all of them.
//
// SO THE LOG HAS BEEN AN AUTHORITATIVE-LOOKING ACCOUNT THAT DISAGREED WITH THE BOARD, and I read three of
// today's reports as arithmetic bugs partly because of it. A log that cannot say "declined" is worse than no
// log at all.
//
// THE TEST THAT MATTERS IS THE REAL GATE, not a hand-made pair of objects. Each case below drives an actual
// refusal through `applySandboxAction` and asserts the identity holds -- because the whole mechanism rests on
// gates returning the SAME OBJECT, and a gate that started returning a fresh copy would break this silently.

import { applySandboxAction } from "./sandboxSession";
import {
  actionWasRefused,
  mayLegitimatelyDoNothing,
  refusedActionLine,
  refusedActionLineWithReason,
  refusalReasonFor,
  NO_OP_MESSAGE_KEYS,
} from "./refusedAction";
import type { GameStateResponse } from "./gameState";

const CO = 3;

function board(over: Partial<GameStateResponse> = {}): GameStateResponse {
  return {
    player_addresses: ["p1", "p2"],
    player_cash: [
      { player: "p1", cash_vgp: "900" },
      { player: "p2", cash_vgp: "900" },
    ],
    virtual_bank_vgp: "12000",
    private_companies: [],
    current_round_type: "OperatingRound",
    operating_sub_phase: "Dividends",
    macro_round_number: 2,
    sub_round_index: 0,
    active_player_index: 0,
    active_operating_order: [CO],
    active_corporation_index: 0,
    consecutive_passes: 0,
    public_companies: [
      {
        company_id: CO,
        ticker: "C&O",
        is_floated: true,
        president: "p1",
        par_value: "82",
        home_hex_label: "F16",
        ipo_pool_percentage: 20,
        bank_pool_percentage: 0,
        treasury: "300",
        last_route_revenue: "0",
        player_holdings: [{ player: "p1", percentage: 60 }],
        station_token_hexes: [[0, 0]],
        owned_trains: ["2"],
      },
    ],
    ...over,
  } as unknown as GameStateResponse;
}

describe("a real refusal is recognised", () => {
  it("catches #774's dividend gate", () => {
    /* A live gate, driven through the real reducer: a second declaration once the cursor has left Dividends.
       Before #778 this wrote a success entry saying the corporation had paid out. */
    const settled = board({ operating_sub_phase: "Hardware" });
    const msg = {
      DeclareDividends: { game_id: 1, protocol_id: CO, revenue_amount: "100", distribute: true },
    } as never;
    const after = applySandboxAction(settled, msg);
    expect(after).toBe(settled);
    expect(actionWasRefused(settled, after, msg)).toBe(true);
  });

  it("leaves a real action alone", () => {
    /* THE CONTROL. A gate that also flagged legitimate actions would fill the log with false refusals, which
       is the same disease pointing the other way. */
    const before = board();
    const msg = {
      DeclareDividends: { game_id: 1, protocol_id: CO, revenue_amount: "100", distribute: true },
    } as never;
    const after = applySandboxAction(before, msg);
    expect(after).not.toBe(before);
    expect(actionWasRefused(before, after, msg)).toBe(false);
  });

  it("rests on identity, so a gate returning a copy would show up here", () => {
    /* STATED AS ITS OWN CASE because it is the assumption the whole mechanism depends on. Every gate refuses
       with `return state`. If one is ever rewritten to spread a fresh object, this fails rather than the log
       quietly going back to lying. */
    const settled = board({ operating_sub_phase: "Track" });
    const msg = {
      DeclareDividends: { game_id: 1, protocol_id: CO, revenue_amount: "50", distribute: false },
    } as never;
    expect(applySandboxAction(settled, msg)).toBe(settled);
  });
});

describe("some messages may do nothing", () => {
  it.each(NO_OP_MESSAGE_KEYS)("exempts %s", (key) => {
    const msg = { [key]: {} };
    expect(mayLegitimatelyDoNothing(msg)).toBe(true);
    expect(actionWasRefused(board(), board(), msg)).toBe(false);
  });

  it("does not exempt an ordinary move", () => {
    /* THE POINT OF AN ALLOWLIST. A message added later that silently does nothing has to be named here
       deliberately rather than inherit an exemption -- the mistake #757's note describes in a different
       context, where a denylist left a gap for every case nobody had thought of. */
    for (const msg of [{ BuyStock: {} }, { LayTile: {} }, { SellStock: {} }, { PlaceStationToken: {} }]) {
      expect(mayLegitimatelyDoNothing(msg)).toBe(false);
    }
  });

  it("treats a missing before-state as not a refusal", () => {
    // Nothing to compare against is not evidence of anything.
    expect(actionWasRefused(null, null, { BuyStock: {} })).toBe(false);
    expect(actionWasRefused(undefined, board(), { BuyStock: {} })).toBe(false);
  });
});

describe("the line says what happened without inventing a reason", () => {
  it("names the action and the unchanged board", () => {
    const line = refusedActionLine("P1 bought a 10% share of C&O from the IPO for $82.");
    expect(line).toContain("REFUSED");
    expect(line).toContain("bought a 10% share of C&O");
    expect(line).toContain("The board did not change");
  });

  it("does not guess which rule declined it", () => {
    /* DELIBERATE. The gates return state, not reasons, so any rule named here would be a guess -- and a
       plausible wrong reason in an authoritative-looking log is exactly what cost this session three
       investigations. The panel's tooltip carries the actual rule. */
    const line = refusedActionLine("P1 bought a share.");
    expect(line).not.toMatch(/60%|certificate limit|turn/i);
  });
});

describe("the drain is wired to it", () => {
  const APP = (() => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const raw = fs.readFileSync(path.join(__dirname, "..", "App.tsx"), "utf8");
    // #490a: the note quotes the old unconditional `status: "success"` while explaining it.
    return raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  })();

  it("makes the sandbox entry's status conditional", () => {
    /* Design note #784 hoisted the answer into `refusalWasRefused` so the three fields that read it call the
       gates once rather than three times. This assertion follows the code rather than pinning the old
       inline call -- the PROPERTY being guarded is that the status is conditional at all. */
    expect(APP).toContain("status: refusalWasRefused ?");
    expect(APP).toContain("const refusalWasRefused = actionWasRefused(before, after, msg)");
  });

  it("leaves the CHAIN entry's success alone", () => {
    /* SCOPED, and the first draft of this test was not: it asserted no literal `status: "success"` survived
       anywhere, which failed on the chain path -- correctly. That entry is written after
       `session.execGameplay` RESOLVES, so a transaction hash is proof the action happened. #778's problem is
       the sandbox reducer's silent refusals; a settled transaction is not one, and asserting otherwise would
       have made the test the thing that was wrong. */
    expect(APP).toContain('status: "success",');
    expect(APP).toContain("execGameplay(chainMsg)");
  });

  it("compares the two states rather than trusting the message", () => {
    expect(APP).toContain("actionWasRefused(before, after, msg)");
  });

  it("changes the label as well as the status", () => {
    /* A status a player cannot see is not a report. The Activity Log's line is what they read, so the
       refusal has to be in the sentence and not only in a colour. #784 made that sentence carry the rule
       when one owns up, so the label now goes through the two-argument form. */
    expect(APP).toContain("refusedActionLineWithReason(label, refusalReason)");
  });
});

describe("the refusal names its rule (design note #784)", () => {
  const CAPPED = board({
    current_round_type: "StockRound",
    operating_sub_phase: undefined,
  } as never);

  const zoneFor = () => "Normal" as const;

  it("gives the 60% cap's own sentence for a buy at the cap", () => {
    /* THE REPORT'S OTHER HALF: "There was no notification that the player was at certificate limit." p1 holds
       60% of C&O here, so this is the exact board that was refused in the playtest -- and the string is
       `sharePurchaseBlock`'s, not a paraphrase of it. */
    const reason = refusalReasonFor(
      CAPPED,
      { BuyStock: { protocol_id: CO, source: "Ipo", par_value: null } } as never,
      { actor: "p1", marketZoneFor: zoneFor, marketPricesByCompany: { [CO]: 82 }, zoneForPrice: zoneFor },
    );
    expect(reason).toMatch(/60%/);
  });

  it("says nothing about a purchase that is legal", () => {
    /* THE CONTROL. A "reason" produced for a legal action would put a refusal sentence on a completed move --
       the #778 bug pointing the other way. */
    const reason = refusalReasonFor(
      CAPPED,
      { BuyStock: { protocol_id: CO, source: "Ipo", par_value: null } } as never,
      { actor: "p2", marketZoneFor: zoneFor, marketPricesByCompany: { [CO]: 82 }, zoneForPrice: zoneFor },
    );
    expect(reason).toBeNull();
  });

  it("gives #774's sentence for a second dividend declaration", () => {
    const settled = board({ operating_sub_phase: "Hardware" });
    const reason = refusalReasonFor(
      settled,
      { DeclareDividends: { protocol_id: CO, revenue_amount: "100", distribute: true } } as never,
    );
    expect(reason).toMatch(/already settled its dividends/);
  });

  it("declines to attribute what it cannot", () => {
    /* #778's rule kept: a refusal with no owning gate stays unattributed. A plausible wrong reason in an
       authoritative-looking log is what cost this session three investigations. */
    expect(refusalReasonFor(board(), { LayTile: {} } as never)).toBeNull();
    expect(refusalReasonFor(null, { BuyStock: {} } as never)).toBeNull();
  });

  it("appends the rule to the line, or says the plain thing", () => {
    expect(refusedActionLineWithReason("P1 bought a share.", "No player may hold more than 60%.")).toBe(
      "REFUSED — P1 bought a share. No player may hold more than 60%.",
    );
    expect(refusedActionLineWithReason("P1 bought a share.", null)).toBe(
      refusedActionLine("P1 bought a share."),
    );
  });
});

describe("the player is told, not just the log", () => {
  const APP = (() => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const raw = fs.readFileSync(path.join(__dirname, "..", "App.tsx"), "utf8");
    return raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  })();

  it("raises a toast on a refusal it can explain", () => {
    expect(APP).toContain("showActionToast(refusalReason)");
  });

  it("does not toast a replayed refusal", () => {
    /* Every client replays every action. Without this the whole table would be told, four times, about one
       player's blocked purchase -- #718's "toast notifications for literally every action" in a new hat. */
    expect(APP).toContain("options?.isRemoteReplay !== true) {");
  });

  it("computes the answer once", () => {
    // The gates are real work; three calls for one answer is three times the cost of the same sentence.
    expect(APP.match(/refusalReasonFor\(/g)?.length).toBe(1);
  });
});
