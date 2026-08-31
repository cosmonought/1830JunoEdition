/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTES 1053-1059 (harness): ONE EVENT, ONE LINE
// ==================================================================
//
// NINE ITEMS FROM ONE OPERATING ROUND'S LOG, and they are mostly one complaint: an event was being reported
// two or three times, by surfaces that each had a good reason to speak and no way to know the others had.
// A station placement got its sentence and then #750's treasury diff; a $0 dividend got an Auto-Withhold
// notice, a declaration in the reducer's vocabulary and a Market Move; six private payments got a category
// prefix and the wrong step's stamp.
//
// TWO OF THE NINE ARE REAL BUGS RATHER THAN COPY, and they are the ones with cases that would have caught
// them. The variant's flavour line was raised on `DeclareDividends`, a sub-phase after the die it describes,
// so a player chose pay-or-withhold before being told what they had earned. And the tint on those lines
// existed only in the expanded log, four lines below a note (#694) arguing that exact rule must reach the
// collapsed one too.
//
// THE ONE PRINCIPLE BEHIND THE CONDENSING, ruled when the question was put: print when something CHANGED. Not
// automatic-versus-manual, which was the split offered -- an auto-skipped Run Routes changes nothing and an
// auto-withheld dividend moves the share price, so the consequence is the discriminator and the button is not.

export {};

const { describeGameplayAction, sentenceStatesTreasury } =
  require("./actionLog") as typeof import("./actionLog");
const { describePrivateClosures, describePrivatePayout } =
  require("./sandboxSession") as typeof import("./sandboxSession");
const { readStripped, readSource, sliceBetween } =
  require("./sourceScan") as typeof import("./sourceScan");
import type { GameStateResponse } from "./gameState";
import type { MapGridResponse } from "../components/hexContractTypes";

const APP = readStripped("App.tsx");
const LOG = readStripped("utils/actionLog.ts");
const TICKER = readStripped("components/TopTicker.tsx");

const CO = 3;
const board = (treasury: string, over: Partial<GameStateResponse> = {}): GameStateResponse =>
  ({
    player_addresses: ["p1", "p2"],
    player_cash: [
      { player: "p1", cash_vgp: "500" },
      { player: "p2", cash_vgp: "500" },
    ],
    virtual_bank_vgp: "12000",
    private_companies: [],
    current_round_type: "OperatingRound",
    operating_sub_phase: "Dividends",
    macro_round_number: 2,
    sub_round_index: 1,
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
        treasury,
        last_route_revenue: "0",
        player_holdings: [
          { player: "p1", percentage: 60 },
          { player: "p2", percentage: 10 },
        ],
        station_token_hexes: [[0, 0]],
        owned_trains: ["2"],
      },
    ],
    ...over,
  }) as unknown as GameStateResponse;

const context = (before: GameStateResponse, after?: GameStateResponse) => ({
  gameState: before,
  afterState: after,
  mapGrid: { game_id: 1, tiles: [] } as unknown as MapGridResponse,
  era: "Yellow" as const,
  labelForAddress: (address: string) => address,
});

/* ------------------------------------------------------------------ */
/* The treasury says where it went, once                               */
/* ------------------------------------------------------------------ */

describe("an action states its own treasury movement", () => {
  it("prints the transition, not the destination", () => {
    /* REPORTED, of two lines where one would do: "'B&O placed a station on J14 for $40. Treasury now $880.'
       'Treasury — B&O spent $40 — treasury $920 → $880.' ... can be condensed."
       THE SUFFIX WAS CARRYING HALF THE FACT. `Treasury now $880` is the destination; the diff line had the
       origin. With both here the second line has nothing left to add -- which is what makes suppressing it a
       de-duplication rather than a loss. */
    const line = describeGameplayAction(
      { LayTile: { protocol_id: CO, tile_id: 57, q: 0, r: 0 } } as never,
      context(board("920"), board("880")) as never,
    );
    expect(line).toContain("Treasury $920 → $880.");
    expect(line).not.toContain("Treasury now");
  });

  it("falls back to the destination when there is no origin to name", () => {
    /* A LIVE CHAIN REPORTS NO `afterState` (#2) and a corporation absent from the before-state has no MOVE --
       its opening balance is not a change, which is the distinction `treasuryProvenance` draws too. Half a
       transition is worse than a plain figure, so the plain figure is what it prints. */
    const line = describeGameplayAction(
      { LayTile: { protocol_id: CO, tile_id: 57, q: 0, r: 0 } } as never,
      context(board("880"), board("880")) as never,
    );
    expect(line).toContain("Treasury now $880.");
  });

  it("says nothing at all when the resolved state is missing", () => {
    const line = describeGameplayAction(
      { LayTile: { protocol_id: CO, tile_id: 57, q: 0, r: 0 } } as never,
      context(board("880")) as never,
    );
    expect(line).not.toContain("Treasury");
  });

  it("suppresses the duplicate line and keeps the unexplained one", () => {
    /* #750's DIAGNOSTIC IS NOT A DUPLICATE BY ACCIDENT. It reads the DIFF rather than trusting any arm,
       "because an arm that reports its own arithmetic will happily report a bug" -- so the suppression is
       scoped to movements a sentence has already stated, and the UNEXPLAINED variant, which is the line the
       whole block exists for, is never suppressed. */
    expect(APP).toContain("if (!move.unexplained && statedInLine) continue;");
    expect(APP).toContain('move.unexplained ? "Treasury (unexplained)" : "Treasury"');
  });

  it("keeps the predicate and the suffix in step", () => {
    /* ==================================================================
        TWO PLACES DECIDING ONE THING, ASSERTED RATHER THAN REMEMBERED
       ==================================================================
       `sentenceStatesTreasury` must name exactly the messages whose branches call `treasurySuffix`. Adding a
       suffix without adding an arm would leave the sentence saying the figures and the diagnostic saying them
       again; adding an arm without a suffix would delete the only record of a movement. Neither would fail
       anything, which is #891's shape -- so the two are counted against each other. */
    /* COUNTED FIRST, AND THE COUNT WAS WRONG. The first draft compared the predicate's arms against this
       file's `treasurySuffix(context,` call sites and expected them equal. They cannot be: one branch serves
       BOTH `BuyHardwareFromPool` and `EmergencyBuyHardware` with a single call, so four arms are three sites
       by construction. Pinning that as 4-and-3 would be a magic pair that breaks the next time two messages
       share a branch -- the same brittleness this case exists to remove, one level up.
       IT DID EARN ITS KEEP BEFORE BEING REWRITTEN: run once, it found that the train-purchase branch had its
       own inline copy of the suffix and had silently kept printing `Treasury now $X` after every other branch
       moved to the transition. So the relationship is worth asserting -- just not by counting.
       EVERY ARM MUST NAME A REAL BRANCH, and the predicate must answer for each. A key with no branch is a
       message whose diagnostic line was suppressed with nothing to replace it, which is the only way this
       change could LOSE a treasury record. */
    const arms = sliceBetween(LOG, "export function sentenceStatesTreasury", "}");
    const keys = (arms.match(/"([A-Za-z]+)" in msg/g) ?? []).map((hit) => hit.split('"')[1]);
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(sentenceStatesTreasury({ [key]: {} } as never)).toBe(true);
      // The branch that will carry the figures for it.
      expect(LOG).toContain(`"${key}" in msg`);
    }
    expect(LOG.split("treasurySuffix(context,").length - 1).toBeGreaterThan(0);
    // And it answers FALSE for treasury movers whose sentence says nothing about a balance (#750 keeps those).
    expect(sentenceStatesTreasury({ DeclareDividends: {} } as never)).toBe(false);
    expect(sentenceStatesTreasury({ BuyStock: {} } as never)).toBe(false);
    expect(sentenceStatesTreasury({ PassTurn: {} } as never)).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* One line per dividend                                               */
/* ------------------------------------------------------------------ */

describe("the dividend says what happened and what it cost", () => {
  const declare = (revenue: string, distribute: boolean) =>
    ({ DeclareDividends: { game_id: 1, protocol_id: CO, revenue_amount: revenue, distribute } }) as never;
  const withMove = (reason: "payout" | "withhold", from: number, to: number) =>
    ({
      ...(context(board("300")) as unknown as Record<string, unknown>),
      marketMove: { from, to, reason },
    }) as never;

  it("does not tell a player they chose to withhold nothing", () => {
    /* REPORTED: "players do not select 'Withhold $0,' so saying that their corporation did is potentially
       confusing, even if that's how the reducer and backend will need to process it."
       AND THE MESSAGE IS UNCHANGED. #292's rule -- "a trainless corporation DECLARES $0 withheld rather than
       skipping; 1830 has no third option" -- is about what gets dispatched, and the declaration is still what
       steps the marker left. Only the sentence a player reads has stopped borrowing the reducer's word. */
    expect(describeGameplayAction(declare("0", false), withMove("withhold", 100, 90))).toBe(
      "C&O did not run any routes. Its share price fell from $100 to $90.",
    );
  });

  it("still names a real withholding as a withholding", () => {
    /* The discriminator is ZERO, exactly: a corporation that ran anything withheld a real figure.
       ASSERTED AS TWO `toContain`s RATHER THAN ONE `toBe`. The exact figure comes from `dividendSplit`, which
       is a different module's arithmetic and not what this case is about -- pinning the whole sentence would
       make this fail for that module's reasons, which is the mistake I keep making with complete-expression
       assertions. The $0 case above is pinned whole because the phrasing IS the subject there. */
    const line = describeGameplayAction(declare("90", false), withMove("withhold", 100, 90));
    expect(line).toContain("withheld $");
    expect(line).toContain("into its treasury.");
    expect(line).toContain("Its share price fell from $100 to $90.");
    expect(line).not.toContain("did not run any routes");
  });

  it("carries the rise on a payout", () => {
    const line = describeGameplayAction(declare("100", true), withMove("payout", 90, 100));
    expect(line).toContain("Its share price rose from $90 to $100.");
  });

  it("says nothing about a price the atom did not move", () => {
    /* #775's ACCEPTED COST, unchanged: a token clamped at the edge of the chart moves nothing and gets no
       clause. The alternative was the projection that note deleted. */
    expect(describeGameplayAction(declare("0", false), context(board("300")) as never)).toBe(
      "C&O did not run any routes.",
    );
  });

  it("leaves a share sale its own line", () => {
    /* THE SUPPRESSION IS SCOPED TO THE TWO DIVIDEND CAUSES. A sale is a different action with a sentence of
       its own, and nobody asked for those to merge -- so `Market Move` still prints for it, which is also
       what keeps #435's line alive. */
    expect(APP).toContain('if (reason === "payout" || reason === "withhold")');
    expect(APP).toContain('logInfo("Market Move"');
  });

  it("hands the sentence the atom's figures rather than a second opinion", () => {
    // #775 in one assertion: the clause is fed, never computed.
    expect(APP).toContain("marketMove: dividendMarketMove");
    expect(LOG).toContain("context.marketMove");
  });
});

/* ------------------------------------------------------------------ */
/* Nothing happened, so nothing is said                                */
/* ------------------------------------------------------------------ */

describe("a step with no consequence earns no line", () => {
  it("has no Auto-Skip narration left", () => {
    /* RULED: print when something CHANGED. An auto-skipped Run Routes changes nothing, and "so they know
       their button press worked" is #718's toast's job -- raised on the clicker's own screen, where the
       question is asked. */
    expect(APP).not.toContain('"Auto-Skip"');
  });

  it("has no Auto-Withhold narration left either", () => {
    /* THE EVENT STILL PRINTS -- the price moved, which is what earns it a line -- but the declaration's own
       sentence says all of it now (#1054). Three lines about one event was the complaint. */
    expect(APP).not.toContain('"Auto-Withhold"');
  });

  it("still performs both automatic actions", () => {
    /* THE CONTROL, AND IT IS THE ONE THAT MATTERS. Deleting a log line must not delete the DISPATCH: a
       corporation that stopped auto-withholding would stall the Operating Round, and the failure would look
       like a UI bug rather than a missing message. */
    expect(APP).toContain("withholdRevenueAutomatically();");
    expect(APP).toContain("endTurnAutomatically();");
    /* Design note #1070: THE CALL TAKES AN ARGUMENT NOW -- the shell's own reason for skipping, so the one
       remaining line can say why rather than just that. What this case guards is unchanged and is the half
       that matters: deleting a log line must not delete the DISPATCH, or a corporation stalls the round and
       it looks like a UI bug. */
    expect(APP).toContain("skipSubPhaseAutomatically(autoSkipReason);");
  });
});

/* ------------------------------------------------------------------ */
/* Two kinds of closure                                                */
/* ------------------------------------------------------------------ */

describe("a private closing is not always a phase change", () => {
  const withPrivates = (closed: boolean[]) =>
    ({
      ...board("300"),
      private_companies: [
        { private_id: 1, name: "Schuylkill Valley", closed: closed[0] },
        { private_id: 6, name: "Baltimore & Ohio", closed: closed[1] },
      ],
    }) as unknown as GameStateResponse;

  it("reports the number alongside the name", () => {
    /* #1052's FORM, reached here for the same reason: five surfaces already print `${private_id}. ${name}`,
       and a sixth that numbered differently would be two answers to one question. */
    expect(describePrivateClosures(withPrivates([false, false]), withPrivates([false, true]))).toEqual([
      { privateId: 6, name: "Baltimore & Ohio" },
    ]);
  });

  it("says nothing when nothing closed", () => {
    expect(describePrivateClosures(withPrivates([true, true]), withPrivates([true, true]))).toEqual([]);
  });

  it("keeps the phase sentence for the phase event and drops it for the other", () => {
    /* REPORTED: "it is true BO closes as soon as B&O buys a train, but this is not a phase change and private
       companies DO continue paying out revenue."
       BOTH SENTENCES EXIST NOW, and the phase is what chooses between them -- asked of the two states rather
       than inferred from how many closed, because a Phase 5 arrival with five already-closed privates closes
       exactly one and counting would call that a solo closure. */
    /* Design note #1068: THE BRANCH IS TWO `logInfo` CALLS NOW, NOT ONE WITH TERNARIES. This pinned
       `phaseTurned ? "Phase Change" : "Private Companies"` -- a label ternary -- and the solo closure needed
       its own STAMP rather than a category, which a single call could not give it. What this case is for is
       unchanged: the phase decides which of two sentences is printed. */
    expect(APP).toContain("derivePhase(before)?.tier !== derivePhase(after)?.tier");
    expect(APP).toContain("if (phaseTurned) {");
    expect(APP).toContain("pay no further revenue and no longer count toward the certificate limit");
    // Design note #1068: the solo closure takes the Private Companies stamp, like the payout lines (#1059).
    expect(APP).toContain("--Private Companies");
    expect(APP).toContain("closureStamp");
  });
});

/* ------------------------------------------------------------------ */
/* The payout phase names itself                                       */
/* ------------------------------------------------------------------ */

describe("the private payments are stamped as the phase they are", () => {
  it("numbers the private in the sentence", () => {
    expect(
      describePrivatePayout(
        { privateId: 1, privateName: "Schuylkill Valley", amount: 5, toPlayer: "p1", toCompanyId: null },
        () => "Player",
        () => "C&O",
      ),
    ).toBe("1. Schuylkill Valley pays $5 to Player.");
  });

  it("files them under their own phase rather than the cursor's step", () => {
    /* THE OLD STAMP WAS ACTIVELY WRONG, not merely verbose: six payments made before any corporation acted
       were filed under `Buy Trains`, the step that happened to be current. The payout is a phase (#1049). */
    expect(APP).toContain("--Private Companies");
    expect(APP).not.toContain('logInfo("Private Revenue"');
  });

  it("stamps both payout sites the same way", () => {
    // Two call sites printing one kind of event two ways is #891's shape; the auction's all-passed payout
    // pays the same privates as the Operating Round's opening.
    /* ==================================================================
        DESIGN NOTE 1068: A THIRD SITE, AND THE COUNT WAS THE WRONG INSTRUMENT
       ==================================================================
       THIS COUNTED THE STAMP AT TWO, which was right when only the two payout sites used it. #1068 gave the
       solo private closure the same stamp -- correctly, since "anything involving private companies needs to
       be tagged [OR X.Y--Private Companies]" -- and a hardcoded 2 made a correct change fail.
       NAMED RATHER THAN COUNTED. The property is that every private-company event carries the stamp, not that
       there are exactly N of them; a fourth such event would want one too, and should not have to edit a
       harness to get it. */
    expect(APP).toContain("const payoutStamp =");
    expect(APP).toContain("const auctionPayoutStamp =");
    expect(APP).toContain("const closureStamp =");
  });
});

/* ------------------------------------------------------------------ */
/* The two bugs                                                        */
/* ------------------------------------------------------------------ */

describe("the die is described where it was rolled", () => {
  it("narrates on the run, not on the dividend", () => {
    /* REPORTED: "B&O ran but the log did not print the variant/flavor text and did not trigger any sound.
       This instead occurred a subphase later when clicking the 'Pay Dividends' button, which is too late for
       a player to make an informed decision."
       A DECISION-QUALITY BUG. Pay-or-withhold is made against a figure the modifier changes, and the player
       was choosing blind and then being told. #963 put the block on `DeclareDividends` because the turn's
       total accumulated across one message per train; #968 made the turn one message and the premise went. */
    const block = sliceBetween(APP, '"RunMultipleRoutes" in msg &&', "const roll = rollTurnRevenue");
    expect(block).toContain("msg.RunMultipleRoutes.protocol_id");
    expect(block).toContain("printed_route_revenue");
    expect(APP).not.toContain('if (before && "DeclareDividends" in msg && resolveVariants');
  });

  it("reads the banked total and the fleet that ran", () => {
    /* TWO STATES, ON PURPOSE. The run has just banked the revenue, so the figure is on `after`; the Yellow
       Sign takes a train, so the mark must judge the fleet as it RAN, which is `before`. */
    const block = sliceBetween(APP, '"RunMultipleRoutes" in msg &&', "const roll = rollTurnRevenue");
    expect(block).toContain("banked?.printed_route_revenue");
    expect(block).toContain("before.public_companies.find");
  });
});

describe("the flavour tint reaches the line players actually watch", () => {
  it("styles the collapsed preview as well as the expanded row", () => {
    /* REPORTED: "when the activity log is expanded, the flavor text lines carry some formatting. However,
       they do not carry any formatting when the log is collapsed, which is how most players see it."
       #694 IS FOUR LINES ABOVE THE PREVIEW ARGUING THIS EXACT RULE about a different property: "applying it
       there alone would leave the same feed saying two different things about the same message depending on
       whether it happened to be open." #1042 added the tone and did not follow it. */
    /* THE OPTIONAL CHAIN CAME AND WENT AND CAME BACK, which is worth recording because the churn is mine:
       #1079 moved the preview's tone inside the `latestItem ? ... : ...` guard (no chain needed), and #1080
       moved it back out to the wrapper, which renders whether or not there is an item. The CLAIM never
       moved -- both renderers read the same field to reach the same decision -- so the fragment stops before
       the accessor rather than pinning which one is in use today. */
    expect(TICKER).toContain("logTone === \"bonus\"");
    expect(TICKER.split('logTone === "bonus"').length - 1).toBe(2);
  });

  it("keeps the tone and the chat style from ever composing", () => {
    /* ==================================================================
        DESIGN NOTE 1079: A SEPARATION REPLACED THE ORDERING
       ==================================================================
       IT ASSERTED THAT `logTone` CAME BEFORE `previewTextChat` in the preview's spread -- the right guard
       while both rode one span, because a flavour line could otherwise borrow the chat colour in one surface
       and not the other.
       THEY ARE ON DIFFERENT ELEMENTS NOW. #1079 moved the tone off the wrapper because the wrapper contains
       the gutter, and the ruling was "do not alter or colorize the [time] or the [round] tags" -- so the
       tint sits on an inner span around the sentence while the chat style stays on the wrapper that clips
       the line. Two styles that cannot reach the same element cannot need an order.
       WHICH MAKES THIS A STRONGER ASSERTION, not a weaker one: an ordering can be got wrong by a later edit
       and a separation cannot, so the case now pins the separation. */
    /* THE HALF THAT WOULD DRIFT. Chat colour must come after the tone in the preview, and the tone after the
       error colour in the row, or a flavour line is styled differently in the surface a player watches from
       the one they open -- the same "two things about one message" this case exists to prevent.
       #1080 briefly moved the row's tone onto the `div` and was WITHDRAWN: `logLabelFull` is `flex: 1`, so
       the fill already reached the right edge and the move was correcting something that was not wrong.
       Both orders are therefore live again, and both are asserted. */
    const wrapper = sliceBetween(TICKER, "...styles.previewText,", "}}");
    expect(wrapper.indexOf("logTone")).toBeLessThan(wrapper.indexOf("previewTextChat"));
    expect(wrapper.length).toBeLessThan(700);
    const label = sliceBetween(TICKER, "...styles.logLabelFull,", "}}");
    expect(label.indexOf("logLabelError")).toBeLessThan(label.indexOf("logTone"));
    expect(label.length).toBeLessThan(900);
  });

  it("has a tone style to apply", () => {
    // The vacuity guard: both branches above are satisfied by styles that do not exist.
    expect(readSource("components/TopTicker.tsx")).toContain("logToneBonus:");
    expect(readSource("components/TopTicker.tsx")).toContain("logToneMalus:");
  });
});
