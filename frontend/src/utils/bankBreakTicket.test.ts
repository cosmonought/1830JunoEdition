/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE (VF-6 harness): THE LATCH DECIDES, AND THE CALENDAR COUNTS
// ==================================================================
//
// The Bank ticket can be wrong in exactly four ways, and every case below is one of them:
//
//   1. IT SHOWS DOLLARS WHEN IT SHOULD SHOW ROUNDS. The owner's own regression -- a Bank that breaks and
//      is then paid into -- is the headline case, run through the REDUCER rather than by setting
//      `bank_broken` by hand, so what is pinned is the mechanism and not the field.
//   2. IT COUNTS THE WRONG NUMBER OF ROUNDS. Case A (break during an OR set) and Case B (break during a
//      Stock Round) take their length from two DIFFERENT authorities, and confusing them is the one
//      arithmetic mistake available here.
//   3. IT PRINTS A ZERO. The reducer produces GameEnd at that boundary (#898) and the outro owns the
//      screen; a countdown that outlives what it was counting is worse than no countdown.
//   4. IT LOSES THE EXISTING THRESHOLDS. #1410's arithmetic is untouched by this batch and is asserted
//      here as well as in its own suite, because it is now reached through a second function.

import { bankBreakWarning, bankTicketReading, BANK_BREAK_CRITICAL_AT, BANK_BREAK_WARN_AT } from "./bankBreak";
import { bankBrokenStatus } from "./bankBreakEndgame";
import { buildBankBreakSequence } from "../components/bankBreakFlourish";
import { bankIsBroken } from "../gameEngine/endgame";
import { applySandboxAction, operatingRoundSequenceLength } from "../gameEngine/sandboxSession";
import type { GameStateResponse } from "../gameEngine/gameState";

const { readStripped, sliceBetween } = require("./sourceScan") as typeof import("./sourceScan");

/** A board in an Operating Round, with whatever fleet and calendar a case needs. Only the fields the
 *  round machine and the latch actually read; a fuller fixture would say no more. */
const board = (over: Partial<GameStateResponse> = {}): GameStateResponse =>
  ({
    current_round_type: "OperatingRound",
    macro_round_number: 3,
    sub_round_index: 1,
    virtual_bank_vgp: "5000",
    bank_broken: undefined,
    returned_trains: [],
    player_addresses: ["p1"],
    player_cash: [{ player: "p1", cash_vgp: "100" }],
    private_companies: [],
    public_companies: [{ company_id: 1, owned_trains: [] }],
    ...over,
  }) as unknown as GameStateResponse;

/** A fleet whose highest train puts the table in the era whose OR set has `n` rounds. Derived from the
 *  reducer's own function rather than typed in, so a change to 1830's OR counts fails here loudly. */
const YELLOW = ["2"]; // 1 OR per set
const GREEN = ["3"]; // 2
const BROWN = ["5"]; // 3
const setLengthFor = (trains: readonly string[]) =>
  operatingRoundSequenceLength(board({ public_companies: [{ company_id: 1, owned_trains: [...trains] }] } as never));

describe("the set lengths this suite reasons about are the reducer's own", () => {
  it("is 1 in Yellow, 2 in Green and 3 in Brown", () => {
    expect([setLengthFor(YELLOW), setLengthFor(GREEN), setLengthFor(BROWN)]).toEqual([1, 2, 3]);
  });
});

describe("before the break: #1410's thresholds, reached through the ticket", () => {
  it("shows nothing while the Bank is comfortable", () => {
    expect(bankTicketReading(null, 2001)).toBeNull();
    expect(bankTicketReading(null, 50_000)).toBeNull();
    expect(bankTicketReading(null, null)).toBeNull();
  });

  it("is an amber ticket at the warning line, and does not pulse", () => {
    const reading = bankTicketReading(null, BANK_BREAK_WARN_AT);
    expect(reading).toEqual(
      expect.objectContaining({ tone: "warn", label: "Bank Break: $2000 remaining", pulses: false, orsRemaining: null }),
    );
  });

  it("is a red, pulsing ticket at the critical line", () => {
    const reading = bankTicketReading(null, BANK_BREAK_CRITICAL_AT);
    expect(reading).toEqual(
      expect.objectContaining({ tone: "critical", label: "Bank Break: $1000 remaining", pulses: true }),
    );
    expect(bankTicketReading(null, 1)?.tone).toBe("critical");
  });

  it("takes its arithmetic from `bankBreakWarning`, unchanged", () => {
    /* The thresholds are NOT restated here: every pre-break reading is the existing function's answer,
       re-toned. A second copy of 2000/1000 in this file is how the two would come to disagree. */
    for (const balance of [2500, 2000, 1999, 1001, 1000, 0, -40]) {
      const warning = bankBreakWarning(balance);
      const ticket = bankTicketReading(null, balance);
      expect(ticket?.label ?? null).toBe(warning?.label ?? null);
      expect(ticket?.pulses ?? false).toBe(warning?.critical ?? false);
    }
  });
});

describe("after the break: rounds, never dollars", () => {
  it("names the count and says BANK BROKEN out loud", () => {
    /* ACCESSIBILITY, AS A UNIT TEST. The post-break tone is a rainbow, and a colour cannot be the only
       indication of a state -- so the words are part of the label rather than a tooltip or an icon. */
    expect(bankTicketReading({ orsRemaining: 2 }, null)).toEqual(
      expect.objectContaining({ tone: "broken", label: "BANK BROKEN · 2 ORs remaining", pulses: false }),
    );
  });

  it("is singular at one round and plural above it", () => {
    expect(bankTicketReading({ orsRemaining: 1 }, null)?.label).toBe("BANK BROKEN · 1 OR remaining");
    expect(bankTicketReading({ orsRemaining: 3 }, null)?.label).toBe("BANK BROKEN · 3 ORs remaining");
  });

  it("never prints a zero, or a negative", () => {
    expect(bankTicketReading({ orsRemaining: 0 }, null)).toBeNull();
    expect(bankTicketReading({ orsRemaining: -1 }, 900)).toBeNull();
  });

  it("stops the pulse -- the event has happened", () => {
    // Pre-break at the same balance this DOES pulse; the broken arm never does.
    expect(bankTicketReading(null, 40)?.pulses).toBe(true);
    expect(bankTicketReading({ orsRemaining: 2 }, 40)?.pulses).toBe(false);
  });

  it("IGNORES a positive balance once the latch is set -- the owner's own regression", () => {
    /* "$10 -> pays $30 -> receives $100 -> $80" (#1561). The dollar countdown must not come back, and
       the ordering inside `bankTicketReading` is what guarantees it: the broken arm is taken before
       `remaining` is read at all. A balance of $80 would otherwise be a screaming red countdown. */
    const reading = bankTicketReading({ orsRemaining: 2 }, 80);
    expect(reading?.tone).toBe("broken");
    expect(reading?.label).toBe("BANK BROKEN · 2 ORs remaining");
    expect(reading?.label).not.toContain("$");
    // And at a balance that is comfortably solvent, where the pre-break ticket would show nothing at all.
    expect(bankTicketReading({ orsRemaining: 1 }, 9999)?.tone).toBe("broken");
  });
});

describe("the ORs-remaining count is read off the calendar", () => {
  const broken = { bank_broken: true, virtual_bank_vgp: "0" };

  it("CASE A: the round in progress plus the rest of its locked set", () => {
    const green = { company_id: 1, owned_trains: ["3"] };
    const set = board({ ...broken, public_companies: [green], operating_round_sequence_length: 2 } as never);
    expect(bankBrokenStatus({ ...set, sub_round_index: 1 })).toEqual({ orsRemaining: 2 });
    expect(bankBrokenStatus({ ...set, sub_round_index: 2 })).toEqual({ orsRemaining: 1 });
    // Brown: three rounds in a set, decrementing naturally as the set is played.
    const brown = board({
      ...broken,
      public_companies: [{ company_id: 1, owned_trains: ["5"] }],
      operating_round_sequence_length: 3,
    } as never);
    expect([1, 2, 3].map((i) => bankBrokenStatus({ ...brown, sub_round_index: i })?.orsRemaining)).toEqual([3, 2, 1]);
  });

  it("CASE A reads the LOCKED length, not the live phase", () => {
    /* #511: the length is stamped once when a set opens, "so a 3-train bought mid-cycle must not turn a
       one-round Yellow cycle into a two-round Green one". A badge re-deriving from the live phase would
       announce that phantom extra round -- here, a Green fleet inside a set that opened in Yellow. */
    const midCycleUpgrade = board({
      ...broken,
      public_companies: [{ company_id: 1, owned_trains: ["3"] }],
      operating_round_sequence_length: 1,
      sub_round_index: 1,
    } as never);
    expect(bankBrokenStatus(midCycleUpgrade)).toEqual({ orsRemaining: 1 });
  });

  it("CASE B: a break in a Stock Round counts the whole UPCOMING set", () => {
    /* And it must NOT read the locked value, which belongs to the set that has already finished: this
       board carries `operating_round_sequence_length: 1` from a Yellow set and a Brown fleet, so the
       coming set is three rounds. `beginOperatingRound` will stamp exactly that. */
    const stock = board({
      ...broken,
      current_round_type: "StockRound",
      sub_round_index: 0,
      operating_round_sequence_length: 1,
      public_companies: [{ company_id: 1, owned_trains: ["5"] }],
    } as never);
    expect(bankBrokenStatus(stock)).toEqual({ orsRemaining: 3 });
    const green = board({
      ...broken,
      current_round_type: "StockRound",
      sub_round_index: 0,
      public_companies: [{ company_id: 1, owned_trains: ["3"] }],
    } as never);
    expect(bankBrokenStatus(green)).toEqual({ orsRemaining: 2 });
  });

  it("CASE B covers the delayed auction, which occupies a Stock Round's slot", () => {
    // #905 inserts `WaterfallAuction` where a Stock Round would have opened; an OR set still follows it.
    const auction = board({
      ...broken,
      current_round_type: "WaterfallAuction",
      sub_round_index: 0,
      public_companies: [{ company_id: 1, owned_trains: ["3"] }],
    } as never);
    expect(bankBrokenStatus(auction)).toEqual({ orsRemaining: 2 });
  });

  it("says nothing at all while the Bank is solvent, or once the game has ended", () => {
    expect(bankBrokenStatus(board())).toBeNull();
    expect(bankBrokenStatus(null)).toBeNull();
    expect(bankBrokenStatus(undefined)).toBeNull();
    /* THE HANDOFF TO THE OUTRO, as an absence. #898 turns the round type to `GameEnd` at the set
       boundary, and from that instant the ticket is silent rather than reading "0 ORs remaining". */
    expect(bankBrokenStatus(board({ ...broken, current_round_type: "GameEnd" } as never))).toBeNull();
  });

  it("asks the latch rather than the balance", () => {
    // A positive balance with the latch set is broken (#1561); the count is still the calendar's.
    const refilled = board({ bank_broken: true, virtual_bank_vgp: "80", sub_round_index: 1 } as never);
    expect(bankIsBroken(refilled)).toBe(true);
    expect(bankBrokenStatus(refilled)).toEqual({ orsRemaining: 1 });
    // And a legacy board with no latch field still breaks on a non-positive balance, as #1561's fallback says.
    const legacy = board({ virtual_bank_vgp: "0", sub_round_index: 1 } as never);
    expect(bankIsBroken(legacy)).toBe(true);
    expect(bankBrokenStatus(legacy)).toEqual({ orsRemaining: 1 });
  });
});

describe("the latch, through the reducer", () => {
  /** One corporation, wholly owned, with a filed run big enough to empty a nearly-empty Bank. The same
   *  shape `bankBreakLatch.test.ts` uses, and for its stated reason: a test that wrote `bank_broken` by
   *  hand would pin the field rather than the mechanism. */
  const payingOut = (): GameStateResponse =>
    ({
      current_round_type: "OperatingRound",
      active_operating_order: [1],
      active_corporation_index: 0,
      sub_round_index: 1,
      operating_round_sequence_length: 2,
      macro_round_number: 3,
      virtual_bank_vgp: "10",
      player_addresses: ["p1", "p2"],
      player_cash: [
        { player: "p1", cash_vgp: "0" },
        { player: "p2", cash_vgp: "100" },
      ],
      priority_deal_index: 0,
      active_player_index: 0,
      consecutive_passes: 0,
      private_companies: [],
      returned_trains: [],
      public_companies: [
        {
          company_id: 1,
          ticker: "PRR",
          president: "p1",
          is_floated: true,
          treasury: "0",
          par_value: "100",
          player_holdings: [{ player: "p1", percentage: 100 }],
          ipo_pool_percentage: 0,
          bank_pool_percentage: 0,
          owned_trains: ["4"],
          station_token_hexes: [],
          station_tokens: [],
          last_route_revenue: "30",
        },
      ],
    }) as unknown as GameStateResponse;

  /** The $30 payout, through the arm that funds it from the Bank -- `bankBreakLatch.test.ts`'s own helper,
   *  spelled the same way so the two suites cannot drift about what breaks a Bank. */
  const payDividend = (state: GameStateResponse) =>
    applySandboxAction(state, {
      DeclareDividends: { game_id: 0, protocol_id: 1, distribute: true, revenue_amount: "30" },
    } as never);

  it("a payout that empties the Bank latches it, and the ticket turns over", () => {
    const before = payingOut();
    expect(bankIsBroken(before)).toBe(false);
    expect(bankTicketReading(bankBrokenStatus(before), Number(before.virtual_bank_vgp))?.tone).toBe("critical");

    const after = payDividend(before);
    expect(after.virtual_bank_vgp).toBe("-20");
    expect(bankIsBroken(after)).toBe(true);

    /* THE EDGE THE SHELL WATCHES, spelled out: false on `before`, true on `after`, from two settled
       states with nothing stored between them. */
    expect([bankIsBroken(before), bankIsBroken(after)]).toEqual([false, true]);

    const reading = bankTicketReading(bankBrokenStatus(after), Number(after.virtual_bank_vgp));
    expect(reading?.tone).toBe("broken");
    expect(reading?.label).toMatch(/^BANK BROKEN · \d+ ORs? remaining$/);
    expect(reading?.pulses).toBe(false);
  });

  it("and a later receipt does not give the dollars back", () => {
    const broke = payDividend(payingOut());
    // However the balance got there, the latch outranks it -- this is the shape of #1561's own example.
    const refilled = { ...broke, virtual_bank_vgp: "800" } as GameStateResponse;
    expect(bankIsBroken(refilled)).toBe(true);
    const reading = bankTicketReading(bankBrokenStatus(refilled), 800);
    expect(reading?.tone).toBe("broken");
    expect(reading?.label).not.toContain("$");
  });
});

describe("the DIRECT crossing: comfortably solvent, then broken in one action", () => {
  /* ==================================================================
      THE CASE THE ARGUMENT LOOKS LIKE IT BREAKS, AND DOES NOT
     ==================================================================
     The shell stages the ticket's previous text with
     `bankBreakWarning(Number(before.virtual_bank_vgp))?.label ?? null`, and `bankBreakWarning` returns
     `null` above the $2000 warning line BY DESIGN. So a Bank at $2400 that is emptied by one payout hands
     the raiser a `null` -- and the question worth asking out loud is whether the EVENT therefore fails to
     exist, or renders an empty ticket.
     IT DOES NOT, BECAUSE THE TWO ARE DIFFERENT QUESTIONS AND THE CODE ASKS THEM SEPARATELY. The trigger is
     `!bankIsBroken(before) && bankIsBroken(after)` and nothing else; the staged label is an ARGUMENT to a
     raiser that has already been called, not a condition on calling it. `null` there means "there was no
     earlier text to stage", which is a true statement about a direct crossing rather than an absence of an
     event -- and `BankTicket` answers it by staging the TONE and falling through to the authoritative
     sentence for the words.
     ASSERTED AT ALL THREE LEVELS, because the coupling this guards against could be reintroduced at any of
     them: the predicate, the staged value, and the rendered ticket (the last in
     `components/bankTicketFlourish.test.tsx`). */

  /** $2400 in the Bank -- above the warning line, so nothing is on screen -- and a $2500 run filed. */
  const solventThenEmptied = (): GameStateResponse =>
    ({
      current_round_type: "OperatingRound",
      active_operating_order: [1],
      active_corporation_index: 0,
      sub_round_index: 1,
      operating_round_sequence_length: 2,
      macro_round_number: 3,
      virtual_bank_vgp: "2400",
      player_addresses: ["p1", "p2"],
      player_cash: [
        { player: "p1", cash_vgp: "0" },
        { player: "p2", cash_vgp: "100" },
      ],
      priority_deal_index: 0,
      active_player_index: 0,
      consecutive_passes: 0,
      private_companies: [],
      returned_trains: [],
      public_companies: [
        {
          company_id: 1,
          ticker: "PRR",
          president: "p1",
          is_floated: true,
          treasury: "0",
          par_value: "100",
          player_holdings: [{ player: "p1", percentage: 100 }],
          ipo_pool_percentage: 0,
          bank_pool_percentage: 0,
          owned_trains: ["4"],
          station_token_hexes: [],
          station_tokens: [],
          last_route_revenue: "2500",
        },
      ],
    }) as unknown as GameStateResponse;

  const payBigDividend = (state: GameStateResponse) =>
    applySandboxAction(state, {
      DeclareDividends: { game_id: 0, protocol_id: 1, distribute: true, revenue_amount: "2500" },
    } as never);

  it("has no warning badge to stage, and the trigger fires anyway", () => {
    const before = solventThenEmptied();
    // THE PRECONDITION THIS CASE IS ABOUT: nothing on screen before the payout.
    expect(Number(before.virtual_bank_vgp)).toBeGreaterThan(BANK_BREAK_WARN_AT);
    expect(bankBreakWarning(Number(before.virtual_bank_vgp))).toBeNull();
    expect(bankTicketReading(bankBrokenStatus(before), Number(before.virtual_bank_vgp))).toBeNull();

    const after = payBigDividend(before);
    expect(Number(after.virtual_bank_vgp)).toBeLessThanOrEqual(0);

    /* THE EDGE IS UNAFFECTED BY THE ABSENT BADGE: it is a function of the latch on two settled states, and
       the latch knows nothing about the $2000 line. */
    expect([bankIsBroken(before), bankIsBroken(after)]).toEqual([false, true]);
  });

  it("stages a null label, which is a fact rather than a missing event", () => {
    const before = solventThenEmptied();
    // Exactly the expression the shell passes to `showBankBreakStamp`.
    const staged = bankBreakWarning(Number(before.virtual_bank_vgp))?.label ?? null;
    expect(staged).toBeNull();
    // And the raiser's own argument type accepts it -- `null` is a value here, never a skip.
    expect(buildBankBreakSequence({ fromLabel: staged }, false)).not.toBeNull();
    expect(buildBankBreakSequence({ fromLabel: staged }, false)?.fromLabel).toBeNull();
    // The one thing that DOES produce no sequence is no event at all.
    expect(buildBankBreakSequence(null, false)).toBeNull();
  });

  it("lands on the rainbow sentence, with a real round count", () => {
    const after = payBigDividend(solventThenEmptied());
    const reading = bankTicketReading(bankBrokenStatus(after), Number(after.virtual_bank_vgp));
    expect(reading?.tone).toBe("broken");
    expect(reading?.label).toBe("BANK BROKEN \u00b7 2 ORs remaining");
    expect(reading?.pulses).toBe(false);
  });

  it("fires once, and a later action on the same broken Bank does not fire again", () => {
    const before = solventThenEmptied();
    const broke = payBigDividend(before);
    /* The edge is false -> true exactly once. Every subsequent dispatch, whatever it does to the balance,
       is true -> true: the second half of "exactly one flourish". */
    expect(!bankIsBroken(before) && bankIsBroken(broke)).toBe(true);
    const later = { ...broke, virtual_bank_vgp: "900" } as GameStateResponse;
    expect(!bankIsBroken(broke) && bankIsBroken(later)).toBe(false);
  });

  it("does not couple the trigger to whether a warning was visible", () => {
    /* ==================================================================
        THE ABSENCE THAT MATTERS
       ==================================================================
       The smallest way to break this case would be to guard the raise on the staged label -- an
       `if (stagedLabel)` or a `bankBreakWarning(before) &&` folded into the condition. Both would read as
       tidy and would silently drop the flourish for every direct crossing, which is the single most
       dramatic way an 1830 bank breaks: one large dividend. So the condition is asserted whole. */
    const CODE = readStripped("App.tsx");
    const condition = "if (!replayingHistory && before !== null && !bankIsBroken(before) && bankIsBroken(after)) {";
    expect(CODE).toContain(condition);
    /* THE BODY, NOT THE BLOCK. `sliceBetween` includes its start anchor, and the condition itself is full
       of the `if (` and `&&` these negatives are looking for -- so the anchor is sliced off before they
       are asserted. Caught by running it: the first draft failed on its own start anchor, which is the
       vacuity in reverse and worth recording rather than quietly fixing. */
    const raise = sliceBetween(CODE, condition, "}").slice(condition.length);
    /* ONE UNCONDITIONAL STATEMENT. `?.`/`??` inside the ARGUMENT are the staged label being optional,
       which is the whole point of this case -- so the claim is that the body is a single call with no
       guard around it, not that it contains no question marks. (My first draft asserted the latter and
       failed on the expression it exists to defend.) */
    expect(raise.trim().startsWith("showBankBreakStamp(")).toBe(true);
    expect(raise.trim().endsWith(");")).toBe(true);
    expect(raise).not.toContain("if (");
    expect(raise).not.toContain("&&");
    expect(raise.match(/showBankBreakStamp\(/g)).toHaveLength(1);
    // And the raiser itself takes a nullable label rather than refusing one.
    expect(CODE).toContain("const showBankBreakStamp = useCallback((fromLabel: string | null) => {");
  });
});

describe("the shell stamps the break on a live edge only", () => {
  const CODE = readStripped("App.tsx");

  it("compares two settled states rather than watching a render", () => {
    expect(CODE).toContain(
      "if (!replayingHistory && before !== null && !bankIsBroken(before) && bankIsBroken(after)) {",
    );
    /* NO STORED PREVIOUS. #1094's lesson, inherited: a ref holding the last value is re-stamped by every
       intermediate commit of a rebuild, which is exactly how the era toast came to announce an hour-old
       history on every refresh. */
    expect(CODE).not.toContain("previousBankBrokenRef");
    expect(CODE).not.toContain("lastBankBrokenRef");
  });

  it("is guarded on `replayingHistory` at the dispatch and inside the raiser", () => {
    const raiserBody = sliceBetween(CODE, "const showBankBreakStamp = useCallback", "bankBreakStampTokenRef.current += 1;");
    expect(raiserBody).toContain("if (replayingHistory) return;");
  });

  it("lets a live remote break stamp, which `isRemoteReplay` could not", () => {
    /* ANCHORED ON CODE AT BOTH ENDS. `readStripped` removes comments, so a design-note anchor resolves to
       nothing -- the mistake #886 exists to make loud, and this file made it once. The drain's spectator
       branch is the next real statement after the narration region. */
    const edge = sliceBetween(CODE, "if (!replayingHistory && before !== null && !bankIsBroken(before) && bankIsBroken(after)) {", "if (spectator) {");
    expect(edge).toContain("showBankBreakStamp(");
    expect(edge).not.toContain("isRemoteReplay");
    expect(edge).not.toContain("spectator");
  });

  it("stages the ticket's own previous text, and clears on its own token", () => {
    expect(CODE).toContain("showBankBreakStamp(bankBreakWarning(Number(before.virtual_bank_vgp))?.label ?? null);");
    const clearBody = sliceBetween(CODE, "const showBankBreakStamp = useCallback", "}, BANK_BREAK_TOTAL_MS);");
    expect(clearBody).toContain("setBankBreakStamp((live) => (live !== null && live.token === token ? null : live));");
  });

  it("derives the count once, from the authority, and hands it down", () => {
    expect(CODE).toContain("const bankBroken = useMemo(() => bankBrokenStatus(gameState), [gameState]);");
    expect(CODE).toContain("bankBroken={bankBroken}");
    expect(CODE).toContain("bankBreakStamp={bankBreakStamp}");
    /* AND NOTHING COUNTS ROUNDS IN THE SHELL. The three shapes a local endgame clock would take, as
       absences -- a stored count, a decrement, and a second notion of how long a set is. */
    expect(CODE).not.toContain("orsRemaining -");
    expect(CODE).not.toContain("setOrsRemaining");
    expect(CODE).not.toContain("operatingRoundsForPhase(");
  });
});

describe("one persistent Bank authority, not two", () => {
  const CODE = readStripped("App.tsx");
  const BAR = readStripped("panels/ContextualActionBar.tsx");

  it("the Top Bar's #901 badge is gone", () => {
    expect(CODE).not.toContain("styles.bankBrokenBadge");
    expect(CODE).not.toContain("final OR set");
    expect(CODE).not.toContain("one final OR set to play");
    // And its style with it -- a style with no reader is how the second badge comes back.
    expect(readStripped("styles/appStyles.ts")).not.toContain("bankBrokenBadge:");
  });

  it("the ticket covers both action-bar rails and the spectator dock", () => {
    expect((BAR.match(/<BankTicket reading=\{bankBreak\} stamp=\{bankBreakStamp \?\? null\} \/>/g) ?? []).length).toBe(2);
    /* THE COVERAGE HOLE THE AUDIT FOUND. The action bar renders on every tab (#1084) but NOT for a
       spectator -- that branch replaces it with a read-only notice -- so the same component is rendered
       there. Same component and same derivation, which is what "one authority" has to mean. */
    expect(CODE).toContain("<BankTicket reading={bankTicketReading(bankBroken, null)} />");
    const dock = sliceBetween(CODE, "Join a room from the lobby to play.", "</div>");
    expect(dock).toContain("<BankTicket");
  });

  it("hands `GameEnd` to the existing outro rather than counting to zero", () => {
    /* #1442 replaces the whole action bar with the game-over strip once an ending stands, so the ticket
       is not rendered there at all -- and `bankBrokenStatus` answers `null` for that state anyway, which
       is the same decision taken twice on purpose. */
    expect(CODE).toContain('data-testid="game-over-strip"');
    expect(bankBrokenStatus(board({ bank_broken: true, current_round_type: "GameEnd" } as never))).toBeNull();
  });
});
