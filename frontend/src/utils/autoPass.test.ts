/** @jest-environment node */
//
// Pure decision logic over board snapshots; no React, no DOM.
//
// ==================================================================
//  DESIGN NOTE 717 (harness): WHEN NOT TO PASS
// ==================================================================
//
// REQUESTED, from 18xx.games: "Auto Actions attempt to operate in a fail-safe mode, deactivating if other
// players take actions that would affect you."
//
// THE INTERESTING ASSERTIONS ARE THE WAKES, NOT THE PASSES. A feature whose default is "do nothing" is easy to
// get accidentally right -- it passes because nothing matched, and it would pass just as happily because the
// comparison was broken. So nearly every case below sets up a specific change and insists the instruction
// STOPS, with the pass cases kept as controls: the same board with the toggle off, or with the change made
// somewhere the player has no stake.
//
// AND THE SNAPSHOT IS THE MECHANISM. "Would affect you" is a claim about CHANGE, not about the current board:
// a corporation already 50% pooled when the instruction was given is not news. Every test therefore arms
// against one board and decides against another, which is the shape the real thing runs in.

import {
  armAutoPass,
  autoPassAlreadyActed,
  autoPassDecision,
  exposedPresidencies,
  isInsecurePresidency,
  type AutoPassConditions,
} from "./autoPass";
import type { GameStateResponse } from "./gameState";

const ME = "me";
const RIVAL = "rival";

type Co = {
  id?: number;
  ticker?: string;
  president?: string | null;
  pool?: number;
  ipo?: number;
  holdings?: { player: string; percentage: number }[];
};

function board(companies: Co[], round = 3): GameStateResponse {
  return {
    macro_round_number: round,
    public_companies: companies.map((entry, at) => ({
      company_id: entry.id ?? at + 1,
      ticker: entry.ticker ?? `C${entry.id ?? at + 1}`,
      president: entry.president ?? null,
      bank_pool_percentage: entry.pool ?? 0,
      ipo_pool_percentage: entry.ipo ?? 0,
      player_holdings: entry.holdings ?? [],
    })),
  } as unknown as GameStateResponse;
}

const ALL: AutoPassConditions = {
  saleInHeld: true,
  saleInPresided: true,
};

/** Both toggles off -- the weakest instruction a player can arm, and the one the guarantee is tested against. */
const NONE: AutoPassConditions = { saleInHeld: false, saleInPresided: false };

function decide(before: GameStateResponse, after: GameStateResponse, conditions = ALL) {
  return autoPassDecision(after, armAutoPass(before, ME, conditions));
}

describe("an untouched board passes", () => {
  it("passes when nothing has moved", () => {
    const b = board([{ ticker: "B&O", holdings: [{ player: ME, percentage: 20 }] }]);
    expect(decide(b, b).pass).toBe(true);
  });

  it("passes when the change is somewhere the player has no stake", () => {
    /* THE CONTROL FOR EVERY WAKE BELOW. A rival dumping a corporation this player has never touched is exactly
       what Auto-Pass exists to sit through. */
    const before = board([{ ticker: "ERIE", holdings: [{ player: RIVAL, percentage: 30 }] }]);
    const after = board([
      { ticker: "ERIE", pool: 20, holdings: [{ player: RIVAL, percentage: 10 }] },
    ]);
    expect(decide(before, after).pass).toBe(true);
  });

  it("is not woken by a pool that was already full when armed", () => {
    /* THE SNAPSHOT, AS A PROPERTY. A board condition that predates the instruction is not news -- a player who
       armed Auto-Pass looking at a 50% pool was not asking to be woken by it. */
    const b = board([{ ticker: "B&O", pool: 50, holdings: [{ player: ME, percentage: 20 }] }]);
    expect(decide(b, b).pass).toBe(true);
  });
});

describe("(i) a sale wakes the holder", () => {
  const before = board([{ ticker: "B&O", holdings: [{ player: ME, percentage: 20 }] }]);
  const after = board([
    { ticker: "B&O", pool: 20, holdings: [{ player: ME, percentage: 20 }, { player: RIVAL, percentage: 0 }] },
  ]);

  it("wakes on a sale into a corporation the player holds", () => {
    const decision = decide(before, after);
    expect(decision.pass).toBe(false);
    expect(decision.wakeReason).toContain("sold into the B&O pool");
  });

  it("names the player's own stake, so the reason is actionable", () => {
    // #619's rule applied to a notification: say what it is about you, not just that something happened.
    expect(decide(before, after).wakeReason).toContain("you hold 20%");
  });

  it("stays asleep with that toggle off", () => {
    /* THE TOGGLE, TESTED AS A TOGGLE. Reported: "if we are giving people toggles, then 1 and 2 would both be
       useful" -- so each has to be independently switchable, and this is the half that proves it. */
    expect(decide(before, after, { ...ALL, saleInHeld: false }).pass).toBe(true);
  });
});

describe("(i again) the narrower sale toggle covers presidencies only", () => {
  const before = board([
    { ticker: "PRR", president: ME, holdings: [{ player: ME, percentage: 40 }] },
    { ticker: "NYC", holdings: [{ player: ME, percentage: 10 }] },
  ]);

  it("wakes on a sale into a presided corporation with the wide toggle off", () => {
    const after = board([
      { ticker: "PRR", president: ME, pool: 10, holdings: [{ player: ME, percentage: 40 }] },
      { ticker: "NYC", holdings: [{ player: ME, percentage: 10 }] },
    ]);
    const decision = decide(before, after, { ...ALL, saleInHeld: false });
    expect(decision.pass).toBe(false);
    expect(decision.wakeReason).toContain("you are its President");
  });

  it("ignores a sale in a merely-held corporation when only the narrow toggle is on", () => {
    /* THE DISTINCTION THE TWO TOGGLES EXIST FOR: the wide one protects a share price, the narrow one defends a
       company. A player who wants the second without the noise of the first gets exactly that. */
    const after = board([
      { ticker: "PRR", president: ME, holdings: [{ player: ME, percentage: 40 }] },
      { ticker: "NYC", pool: 20, holdings: [{ player: ME, percentage: 10 }] },
    ]);
    expect(decide(before, after, { ...ALL, saleInHeld: false }).pass).toBe(true);
  });
});

describe("a presidency is never lost to Auto-Pass", () => {
  /* REPORTED: "Auto-Pass should never allow a player to lose the presidency of a corporation -- that should be
     something they manually choose to do -- so I think cutting it on a tie is a good choice."
     AN OUTCOME, NOT A PREFERENCE, which is what makes this a different KIND of test from the two above. Those
     ask whether a toggle was honoured; these ask whether a thing can happen, and so every one of them arms with
     both toggles OFF. A guarantee that only holds on the default settings is not a guarantee. */

  const tied = (over: { ipo?: number; pool?: number } = {}) =>
    board([
      {
        ticker: "PRR",
        president: ME,
        ipo: over.ipo ?? 20,
        pool: over.pool ?? 0,
        holdings: [
          { player: ME, percentage: 40 },
          { player: RIVAL, percentage: 40 },
        ],
      },
    ]);

  it("refuses to pass while a rival is level, with every toggle off", () => {
    const decision = decide(tied(), tied(), NONE);
    expect(decision.pass).toBe(false);
    expect(decision.wakeReason).toContain("could be taken on the next purchase");
  });

  it("refuses even when the threat predates the instruction", () => {
    /* THE ONE PLACE THE SNAPSHOT RULE IS DELIBERATELY BROKEN, and the reason is worth keeping. Everywhere else
       "was already true when you armed" means "not news, keep passing". Here it would mean handing over a
       company the player had merely failed to notice was in danger. `decide` arms and decides on the SAME
       board, so nothing whatever has changed, and it still stops. */
    expect(decide(tied(), tied()).pass).toBe(false);
  });

  it("stops BEFORE the presidency moves, not after", () => {
    /* THE WHOLE ARGUMENT FOR READING THE CURRENT BOARD instead of the diff, as a sequence. A diff-based check
       would have passed this turn -- nothing had changed yet -- and woken the player on the next one, after the
       rival's purchase, with the company already gone. Turn order is why the guarantee cannot be a comparison:
       the danger is visible one turn before the loss, and only for that one turn. */
    const before = tied();
    const lost = board([
      {
        ticker: "PRR",
        president: RIVAL,
        ipo: 10,
        holdings: [
          { player: ME, percentage: 40 },
          { player: RIVAL, percentage: 50 },
        ],
      },
    ]);
    expect(autoPassDecision(before, armAutoPass(before, ME, NONE)).pass).toBe(false);
    expect(decide(before, lost, NONE).wakeReason).toContain("no longer President");
  });

  it("passes a comfortable presidency, so the guard is not just 'never pass'", () => {
    /* THE CONTROL. A guarantee implemented as an unconditional refusal would satisfy every test above and make
       the feature useless, so one case has to come out the other way. */
    const safe = board([
      {
        ticker: "PRR",
        president: ME,
        ipo: 30,
        holdings: [
          { player: ME, percentage: 60 },
          { player: RIVAL, percentage: 20 },
        ],
      },
    ]);
    expect(decide(safe, safe, NONE).pass).toBe(true);
  });

  it("passes a tie nobody can act on", () => {
    /* Level holdings with the IPO and pool both empty: there is no certificate to buy, so the presidency cannot
       move and there is nothing for the player to do about it. Waking them here would be the noise the feature
       exists to remove, dressed up as safety. */
    expect(decide(tied({ ipo: 0, pool: 0 }), tied({ ipo: 0, pool: 0 })).pass).toBe(true);
  });

  it("re-arms the threat when a sale refills the pool", () => {
    /* The same tie, made live again by shares arriving in the pool -- which is exactly why the guard reads
       availability at decision time rather than recording it once at arm time. */
    expect(decide(tied({ ipo: 0, pool: 0 }), tied({ ipo: 0, pool: 10 }), NONE).pass).toBe(false);
  });

  it("names every exposed corporation, not just the first", () => {
    const two = board([
      {
        ticker: "PRR",
        president: ME,
        ipo: 20,
        holdings: [{ player: ME, percentage: 40 }, { player: RIVAL, percentage: 40 }],
      },
      {
        ticker: "B&O",
        president: ME,
        ipo: 20,
        holdings: [{ player: ME, percentage: 30 }, { player: RIVAL, percentage: 30 }],
      },
    ]);
    expect(exposedPresidencies(two, ME)).toEqual(["PRR", "B&O"]);
    expect(decide(two, two, NONE).wakeReason).toContain("PRR, B&O");
  });

  it("says nothing about corporations the player does not preside over", () => {
    const theirs = board([
      {
        ticker: "NYC",
        president: RIVAL,
        ipo: 20,
        holdings: [{ player: RIVAL, percentage: 40 }, { player: ME, percentage: 40 }],
      },
    ]);
    expect(exposedPresidencies(theirs, ME)).toEqual([]);
  });
});

describe("insecurity is one purchase away, and needs a share to buy", () => {
  it("is not yet threatened by a rival who could only TIE", () => {
    /* THE BOUNDARY, and the first draft of this test had it wrong. A presidency passes to somebody holding
       MORE than the president, so a rival at 30% against 40% buys one share and reaches 40% -- a tie, which
       takes nothing. `rival + SHARE > mine` is that distinction, and it reads as one purchase too slow until
       you follow it one purchase further: the tie itself is an exposed presidency, so the president is stopped
       AT the tie, holding the company, with the turn in their hands.
       CONFIRMED IN REVIEW: "cutting it on a tie is a good choice." */
    expect(
      isInsecurePresidency(
        {
          president: ME,
          ipo_pool_percentage: 10,
          bank_pool_percentage: 0,
          player_holdings: [
            { player: ME, percentage: 40 },
            { player: RIVAL, percentage: 30 },
          ],
        },
        ME,
      ),
    ).toBe(false);
  });

  it("is threatened once a rival draws level", () => {
    // The other side of the same boundary: at 40 vs 40, one purchase takes the company.
    expect(
      isInsecurePresidency(
        {
          president: ME,
          ipo_pool_percentage: 10,
          bank_pool_percentage: 0,
          player_holdings: [
            { player: ME, percentage: 40 },
            { player: RIVAL, percentage: 40 },
          ],
        },
        ME,
      ),
    ).toBe(true);
  });

  it("wakes the president on the purchase that creates the tie", () => {
    /* THE CASE THAT MAKES THE BOUNDARY SAFE, asserted end to end rather than left as an argument in a comment.
       A rival going 30% -> 40% against a 40% president has not taken the company, and it IS the moment they
       need to hear about it -- one purchase before it could go. */
    const before = board([
      { ticker: "PRR", president: ME, ipo: 20, holdings: [{ player: ME, percentage: 40 }, { player: RIVAL, percentage: 30 }] },
    ]);
    const after = board([
      { ticker: "PRR", president: ME, ipo: 10, holdings: [{ player: ME, percentage: 40 }, { player: RIVAL, percentage: 40 }] },
    ]);
    expect(decide(before, after).pass).toBe(false);
  });

  it("is secure when no rival is within one purchase", () => {
    expect(
      isInsecurePresidency(
        {
          president: ME,
          ipo_pool_percentage: 30,
          bank_pool_percentage: 0,
          player_holdings: [
            { player: ME, percentage: 60 },
            { player: RIVAL, percentage: 20 },
          ],
        },
        ME,
      ),
    ).toBe(false);
  });

  it("is secure when there is nothing left to buy", () => {
    /* A THREAT THAT CANNOT BE EXECUTED IS NOT A THREAT. With the IPO and the pool both empty, the closest
       rival cannot move, however close they are. */
    expect(
      isInsecurePresidency(
        {
          president: ME,
          ipo_pool_percentage: 0,
          bank_pool_percentage: 0,
          player_holdings: [
            { player: ME, percentage: 40 },
            { player: RIVAL, percentage: 30 },
          ],
        },
        ME,
      ),
    ).toBe(false);
  });

  it("says nothing about a corporation somebody else presides over", () => {
    expect(
      isInsecurePresidency(
        {
          president: RIVAL,
          ipo_pool_percentage: 50,
          bank_pool_percentage: 0,
          player_holdings: [{ player: ME, percentage: 10 }],
        },
        ME,
      ),
    ).toBe(false);
  });
});

describe("the fail-safes that are not toggles", () => {
  it("wakes when the Stock Round has moved on", () => {
    /* REPORTED: "it should only run until the end of a Stock Round: players should have to set it every Stock
       Round." A standing instruction into a round whose board the player has never seen is the thing they
       would forget was on. */
    const before = board([{ ticker: "B&O", holdings: [{ player: ME, percentage: 20 }] }], 3);
    const after = board([{ ticker: "B&O", holdings: [{ player: ME, percentage: 20 }] }], 4);
    const decision = decide(before, after);
    expect(decision.pass).toBe(false);
    expect(decision.wakeReason).toContain("expired with the Stock Round");
  });

  it("wakes when the player loses a presidency, whatever the toggles say", () => {
    /* NOT SWITCHABLE, deliberately. A player who lost a company while away is looking at a different game from
       the one they armed this in. */
    const before = board([
      { ticker: "PRR", president: ME, holdings: [{ player: ME, percentage: 30 }] },
    ]);
    const after = board([
      { ticker: "PRR", president: RIVAL, holdings: [{ player: ME, percentage: 30 }] },
    ]);
    const decision = decide(before, after, NONE);
    expect(decision.pass).toBe(false);
    expect(decision.wakeReason).toContain("no longer President");
  });

  it("always gives a reason when it declines to pass", () => {
    /* Every refusal is shown to the player, so a silent `false` would be a turn that simply did not happen
       with no explanation on screen. */
    const before = board([{ ticker: "B&O", holdings: [{ player: ME, percentage: 20 }] }], 3);
    const after = board([{ ticker: "B&O", pool: 10, holdings: [{ player: ME, percentage: 20 }] }], 4);
    const decision = decide(before, after);
    expect(decision.pass).toBe(false);
    expect(decision.wakeReason).toBeTruthy();
  });
});


describe("the off switch is always reachable", () => {
  /* ==================================================================
   *  DESIGN NOTE 728 (harness): TURNING IT OFF IS NOT A STOCK ROUND ACTION
   * ==================================================================
   *
   * REPORTED: "Players need a way to disable Auto-Pass once it is on. The Auto-Pass button should be clickable
   * at any time for them to turn it off."
   *
   * THREE SEPARATE WAYS THE CONTROL BECAME UNREACHABLE, all from the same mistake -- treating "disarm" as a
   * variant of "arm" and gating it on the same conditions. Arming needs a Stock Round and a live session,
   * because it schedules a dispatch. Disarming clears one local value and needs neither.
   *
   * ASSERTED AS SOURCE because all three are render conditions on a component with no rules module to test:
   * what is wrong is WHEN the button exists and WHEN it is enabled, and both live in JSX. This is the weak
   * instrument, used because it is the only one that can see the defect. */

  const read = (rel: string) => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    return fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
  };
  const bar = read("panels/ContextualActionBar.tsx");
  const app = read("App.tsx");

  it("renders the control whenever an instruction is standing", () => {
    /* (1) THE ROUND GATE. `roundType === "StockRound"` is right for offering and wrong for withdrawing: the
       moment the round turned, the button vanished with the arm still set, so the only way out was to wait for
       a Stock Round -- which would then be passed for you. */
    expect(bar).toContain('autoPass && (autoPass.armed || roundType === "StockRound")');
  });

  it("never disables it while armed", () => {
    /* (2) THE SESSION GATE. A dropped connection must not trap a player inside a setting that keeps taking
       their turns. Arming still needs a session; clearing does not.
       ==================================================================
        DESIGN NOTE 1036: THE GATE IS THE CONNECTION, AND IT USED TO BE THE TURN AS WELL
       ==================================================================
       THIS ASSERTED `!sessionReady`, and the shell hands that prop `controlsEnabled && isMyTurn`. The
       reasoning above is entirely about the SESSION -- and the flag it reached for carried a second fact, so
       arming was dead for the whole round except on the player's own turn. Reported as: "the ability to
       enable Auto-Pass during a Stock Round even when it is not currently their turn".
       WHAT THE CASE IS FOR IS UNCHANGED: armed, the button is never disabled, whatever the connection says. */
    expect(bar).toContain("disabled={!autoPass.armed && !autoPass.canArm}");
  });

  it("does not gate arming on whose turn it is", () => {
    /* THE FEATURE, AND THE HALF A `canArm` RENAME COULD STILL GET WRONG. The prop exists so the two questions
       can be answered separately; handing it `controlsEnabled && isMyTurn` at the call site would satisfy the
       case above and change nothing a player can see. */
    expect(app).toContain("canArm: controlsEnabled,");
    expect(app).not.toContain("canArm: controlsEnabled && isMyTurn");
  });

  it("still gates Pass itself on the turn", () => {
    /* THE CONTROL ON THE SPLIT. `sessionReady` was not weakened -- it was left alone and a second predicate
       carved out beside it, so the button that ENDS a turn still needs one. */
    expect(app).toContain("sessionReady={controlsEnabled && isMyTurn}");
  });

  it("keeps offering it through the auction while armed", () => {
    /* (3) THE WATERFALL GATE, which handed the bar `null` and deleted the control outright -- so the one place
       a player could not reach the off switch was a phase an arm can survive into. */
    expect(app).toContain("isWaterfallPhase && autoPassArm === null");
  });
});

describe("one standing instruction passes a turn once", () => {
  /* ==================================================================
      DESIGN NOTE 816 (harness): THIS BLOCK ASSERTED THE BUG IN #728's OWN WORDS
     ==================================================================

     REPORTED: "when an opposing player triggers the Auto-Pass conditions in a Stock Round, the Auto-Passed
     player still gets their turn, but the Auto-Pass button reads 'Auto-Pass: On' even though it has been and
     is supposed to be disabled."

     WHAT STOOD HERE, verbatim: "The key is round AND seat, so a later turn in the same round passes again as
     it should." It does not. A later turn in the same round has the same SEAT INDEX -- that is what a seat
     index is -- so `${round}:${seat}` is one key for every turn a player takes in a Stock Round. Auto-Pass
     fired once per player per round and was guarded off silently for the rest of it: the guard returns before
     the decision is evaluated, so nothing disarmed the arm and nothing was logged.

     THE HARNESS COPIED THE CLAIM OUT OF THE NOTE AND ASSERTED THE CODE THAT IMPLEMENTED IT, which is the most
     expensive way for a test to be green. Both sentences were written in the same pass by somebody who had
     not asked what a seat index does across a round -- and a source scan cannot ask.

     AND THE REPORT'S TRIGGER IS EXACTLY RIGHT: your seat only comes round a second time if somebody else
     bought or sold, because that is what resets the consecutive-pass count and keeps the round alive. "An
     opposing player triggers it" is the precise condition, arrived at from the symptom.

     SO THE ASSERTIONS BELOW ARE ABOUT THE PREDICATE, not about the wiring. `autoPassAlreadyActed` is three
     lines and can be asked the question the note got wrong. */

  it("has not acted before it acts", () => {
    expect(autoPassAlreadyActed(null, 41)).toBe(false);
  });

  it("refuses a second dispatch while the log has not moved", () => {
    /* THE CASE #728 EXISTS FOR, and it still holds. Between dispatching a pass and the log carrying it, the
       effect can re-run with `isMyTurn` still true -- and a second pass spends a turn the player never had. */
    expect(autoPassAlreadyActed(41, 41)).toBe(true);
  });

  it("acts again once anything at all has happened", () => {
    /* THE CASE #728 GOT WRONG. Any entry in the log means this is a different turn: the player's own pass,
       an opponent's purchase, a corporation floating. The log is monotonic, so this cannot collide the way a
       seat index does. */
    expect(autoPassAlreadyActed(41, 42)).toBe(false);
    expect(autoPassAlreadyActed(41, 97)).toBe(false);
  });

  it("acts on an empty log", () => {
    // `-1` is the app's "nothing has happened yet", and it must not read as "already acted".
    expect(autoPassAlreadyActed(null, -1)).toBe(false);
  });

  it("would have been fooled by a seat index and is not fooled by a log index", () => {
    /* THE OLD KEY AND THE NEW ONE, side by side over one Stock Round: P1 passes, P2 buys, P3 passes, P1's
       seat comes round again. The seat key repeats and the log index does not -- which is the whole bug in
       four rows. Written as a table rather than by importing the removed code, and labelled as an
       illustration of the premise rather than a test of anything shipped. */
    const turns = [
      { seatKey: "3:0", logIndex: 40 },
      { seatKey: "3:1", logIndex: 41 },
      { seatKey: "3:2", logIndex: 42 },
      { seatKey: "3:0", logIndex: 43 },
    ];
    const p1 = turns.filter((turn) => turn.seatKey === "3:0");
    expect(p1).toHaveLength(2);
    expect(p1[0].seatKey).toBe(p1[1].seatKey);
    expect(autoPassAlreadyActed(p1[0].logIndex, p1[1].logIndex)).toBe(false);
  });

  it("is wired to the append-only log rather than to the seat", () => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const app = fs.readFileSync(path.join(__dirname, "..", "App.tsx"), "utf8");
    expect(app).toContain(
      "if (autoPassAlreadyActed(autoPassedAtLogIndexRef.current, lastLogIndex)) return;",
    );
    expect(app).toContain("autoPassedAtLogIndexRef.current = lastLogIndex;");
    expect(app).not.toContain("active_player_index}`;");
    /* Cleared on arm and on disarm, so re-arming can act on the very turn it was set in -- and, since
       #1036, on the round change that clears a spent arm. THREE, not two: the count is asserted rather than
       the presence because a clear that went missing would leave a fresh arm silently guarded off for one
       turn, which is exactly the bug #816 was reported for. */
    expect(app.match(/autoPassedAtLogIndexRef\.current = null;/g) ?? []).toHaveLength(3);
  });

  it("leaves the wake path able to say so out loud", () => {
    /* #717's rule, and the thing the old guard was jumping in front of: a turn that silently did not happen
       is this feature's worst failure, and the reported symptom was precisely a turn with no explanation
       attached to it. The guard now returns only when nothing has happened, so a real turn always reaches the
       decision -- which either passes or disarms and logs. */
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const app = fs.readFileSync(path.join(__dirname, "..", "App.tsx"), "utf8");
    expect(app).toContain("setAutoPassArm(null);");
    /* `${...}` in a plain string trips `no-template-curly-in-string`, and the rule is right to fire -- this
       is the fourth time this pass that source text being SEARCHED for has needed assembling rather than
       quoting. See #779's harness for the standing reason. */
    const dollar = String.fromCharCode(36);
    expect(app).toContain(
      'logInfo("Auto-Pass", `' + dollar + "{decision.wakeReason} Auto-Pass is off.`);",
    );
  });
});
