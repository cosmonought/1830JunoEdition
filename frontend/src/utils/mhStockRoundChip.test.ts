/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 871 (harness): THE POWER TRAVELS WITH THE BAR
// ==================================================================
//
// REPORTED: "In the Stock Round, the MH private power is pinned below the Action Bar rather than sticky with
// it, so it is easy to miss for players not scrolling up and down the page. Can we condense and massively
// streamline this private power under the Action Bar? Its whole purpose is to be exchanged for an NYC share,
// and for some reason it has a multi-line/sentence explanation of this rule."
//
// THE PLACEMENT WAS #785's, WORKING AS DESIGNED, which is why this is a scoping question rather than a bug in
// the panel: that pass moved every tall panel out of the sticky element, and a one-button power inherited a
// decision made for depot tables and payout ledgers.

/* #490a: the notes below quote the strings they removed, so code assertions read a comment-stripped copy. */

import { readSource, stripComments } from "./sourceScan";

const APP_RAW = readSource("App.tsx");
const APP = stripComments(APP_RAW);
const BAR = stripComments(readSource("panels/ContextualActionBar.tsx"));
/* Design note #885: `PANEL_RAW` / `PANEL` read `components/PrivatePowerPanel.tsx`, which is deleted. The
   block that used them is rewritten below against the surface that replaced it. */

describe("the offer is built where ownership is known", () => {
  /* ==================================================================
      DESIGN NOTE 887: TWO OF THESE THREE ARE NOW BEHAVIOURAL, ELSEWHERE
     ==================================================================
     "only in a Stock Round" and "gates on the PLAYER holding it, not a corporation" scanned `App.tsx` for
     `gameState?.current_round_type !== "StockRound"` and for `mh.owner !== viewerAddress`. Both rules moved
     into `stockRoundExchangeOffers`, and `activePrivatePower.test.ts` now CALLS it -- with a fixture whose
     `owner` and `owner_protocol_id` name different holders, which is the only shape that can prove which
     field the code consults. A scan could see that the string was present; it could not see that a
     corporation-held M&H offers nobody a chip.
     THE THIRD SURVIVES HERE, because it is about a JOIN between two modules rather than about either one:
     the M&H's list and the hex list are concatenated where the bar takes a generic chip, and the hex list
     alone feeds the board's glow. Neither function can assert that on its own. */
  it("stays out of the hex-offer list", () => {
    /* `privatePowerOffer.ts` says its list "can never hold more than two entries" and feeds
       `privatePowerHexKeys`, which the board's glow reads. A power with no hex in that list would hand the
       map a key it cannot resolve, so the two are joined only where the bar takes a generic chip. */
    expect(APP).toContain("powerOffers={[...privatePowerOfferList, ...stockRoundPowerOffers]}");
    const offers = stripComments(readSource("utils/privatePowerOffer.ts"));
    expect(offers).not.toContain("mh-exchange");
    expect(offers).toContain('export type PowerAbilityKey = "csl-tile" | "dh-tile";');
  });
});

describe("the bar carries it, and dispatches nothing", () => {
  it("renders offers as power chips, in one group for every round", () => {
    /* ==================================================================
        DESIGN NOTE 884: THE CHIPS LEFT `contextualButtons`
       ==================================================================
       THIS ASSERTED `contextualButtons = onUsePowerOffer` -- the Stock Round branch building the M&H chip
       into the CENTRED button group. #884 moved every power chip into its own group in the trailing rail,
       because inside the centre an appearing chip shoved Pass and Lay 1 Track sideways.
       WHAT IT WAS PROTECTING IS UNCHANGED and is what is asserted now: the chip is inside the STICKY element
       (which the panel never was), it is reached through the same `powerOffers`/`onUsePowerOffer` pair the
       Track step uses, and there is ONE mechanism rather than two. The group moved; the mechanism did not. */
    const at = BAR.indexOf("const powerChips: ActionBarButton[] =");
    expect(at).toBeGreaterThan(-1);
    const end = BAR.indexOf("const powerChipNodes", at);
    expect(end).toBeGreaterThan(at);
    const body = BAR.slice(at, end);
    expect(body).not.toBe("");
    expect(body).toContain("onUsePowerOffer(offer.abilityKey)");
    expect(body).toContain("label: offer.chipLabel");
    /* ONE PRODUCER, so the Track step and the Stock Round cannot disagree about what a chip is. A second
       `powerOffers.map` anywhere in this file is the regression. */
    expect((BAR.match(/powerOffers\.map\(/g) ?? []).length).toBe(1);
  });

  it("raises the question rather than performing the exchange", () => {
    /* #263: nothing on this bar dispatches. #846's rule, third power: "One question, asked one way, whichever
       door a player came through." */
    const at = APP.indexOf("const handleChipPowerOffer");
    expect(at).toBeGreaterThan(-1);
    const body = APP.slice(at, at + 700);
    expect(body).toContain('setPrivatePowerRequest("mh-exchange")');
    expect(body).not.toContain("ExchangePrivate");
  });

  it("keeps Buy and Sell out of the bar (design note #29)", () => {
    /* THE RULE THIS CHANGE HAD TO NOT BREAK. Share trading lives in `StockRoundPanel`'s corporation cards and
       a duplicate here would be a second control surface for one move. A private POWER is not that: nothing
       else in this round offers it. */
    expect(BAR).not.toContain("onBuyShare");
    expect(BAR).not.toContain("onSellShares");
  });
});

describe("one dispatch, two doors", () => {
  /* ==================================================================
      DESIGN NOTE 881 (harness): THIS BLOCK WAS ENFORCING THE BUG
     ==================================================================

     THE ASSERTION BELOW USED TO READ, on one line per #814: `expect((APP.match(/runPrivateExchange\(/g) ?? []).length).toBe(2);`
     with the comment "TWO CALL SITES: the panel's button and the modal's Exchange."

     TWO CALL SITES WAS THE DEFECT, WRITTEN DOWN AS THE REQUIREMENT. The panel's call site WAS the direct
     dispatch -- the one the report describes as completing "instantly ... without the modal" -- so a test
     that pinned the count at two would have failed the moment anybody fixed it, which is what it just did.
     The describe block is titled "one dispatch, two doors" and quotes #846's "One question, asked one way,
     whichever door a player came through", while asserting a shape in which one door asked and the other
     acted. The name was right and the number was the bug.

     AND IT WAS A BARE COUNT, which is the other half of why it could be wrong so comfortably: `toBe(2)`
     cannot tell the panel's call site from the modal's, so it would equally have passed for two panel
     buttons, or for the modal calling it twice. Counts survive swaps. The replacement names the ONE caller
     that should remain and asserts that the other reaches the modal instead. */
  it("routes both doors through the modal, and dispatches from one place", () => {
    /* EXTRACTED RATHER THAN COPIED. Two paths to `ExchangePrivate` could come to disagree about the legality
       check, the log line, or the `automatic` flag that lets the M&H fire between turns. */
    expect(APP).toContain("const runPrivateExchange = useCallback(");
    /* THE ONE SURVIVING CALLER IS THE MODAL'S. `handlePowerFlowAct` is the only thing that should ever reach
       the dispatch, because it is the only thing that runs after a player has answered the question. */
    const act = APP.indexOf("const handlePowerFlowAct");
    expect(act).toBeGreaterThan(-1);
    const actBody = APP.slice(act, APP.indexOf("const handlePowerFlowDecline", act));
    /* The slice is bounded by a LATER declaration rather than by a length, so it cannot silently run past
       the handler and pick the assertion up from somewhere else -- and `indexOf` returning -1 here would
       produce a BACKWARDS slice, i.e. `""`, which passes every `not.toContain` beside it. Pinned. */
    expect(actBody).not.toBe("");
    expect(actBody).toContain("runPrivateExchange(MH_PRIVATE_ID,");

    /* AND THERE IS NO SECOND DOOR LEFT TO ASK. #881 routed the panel's button through the modal; #885 then
       deleted the panel and `handleUsePrivateAbility` with it, so the chip is the only entry point and the
       dispatch has exactly one caller. Asserted as an ABSENCE across the whole file rather than inside a
       handler slice, because the handler that used to hold it no longer exists to slice. */
    expect(APP).not.toContain("const handleUsePrivateAbility");
    /* THE DEAD ARM WENT WITH IT TOO. #576 removed the C&A's action, so no click could ever carry this key --
       it had been unreachable for as long as it had been passing. */
    expect(APP).not.toContain("ca-exchange");
    /* ONE CALL SITE. Named rather than counted: a bare count cannot tell the modal's caller from a second
       one, which is what #881 found in this block's previous version. */
    expect((APP.match(/runPrivateExchange\(/g) ?? []).length).toBe(1);

    expect((APP.match(/ExchangePrivate: \{/g) ?? []).length).toBe(1);
  });

  it("keeps the between-turns exemption on the one dispatch", () => {
    /* The M&H's own rule: the trade "can be made on their own stock-round turn, or in the gap between any
       other player's or corporation's turn". `automatic: true` is what stops the turn gate refusing the one
       moment the power is most useful. */
    const at = APP.indexOf("const runPrivateExchange");
    const body = APP.slice(at, at + 1400);
    expect(body).toContain("{ automatic: true }");
  });

  it("declining spends nothing", () => {
    /* THE DIFFERENCE FROM THE D&H, in the shell rather than in the copy. #845: "Two modals, two rules, and
       the difference is whether the question can be asked again." */
    const at = APP.indexOf("const handlePowerFlowDecline");
    expect(at).toBeGreaterThan(-1);
    const body = APP.slice(at, APP.indexOf("setDhStationForfeited", at));
    expect(body).toContain('if (step === "exchange")');
    expect(body).toContain("setPrivatePowerRequest(null)");
    expect(body).not.toContain("usedPrivateAbilities");
  });
});

describe("the rule lives at the decision, not on a standing surface", () => {
  /* ==================================================================
      DESIGN NOTE 885: THIS BLOCK'S SUBJECT WAS DELETED, SO IT CHANGED SUBJECT
     ==================================================================

     IT WAS "the panel row is one line now", and it asserted three things about `PrivatePowerPanel.tsx`: that
     the row said "Trade in for a 10% NYC share. Taking it closes the company.", that it no longer carried
     the two-sentence rule, and that the RAW file still contained that sentence as the record (#490a in
     reverse). The panel is gone (#885), so all three had no subject.

     #871's ARGUMENT SURVIVES THE PANEL AND IS WHAT IS ASSERTED NOW: "a rule a player meets once belongs
     where the decision is, not on a surface read every Stock Round." The decision is the modal, the modal's
     sentence comes from `privatePowerFlow.ts`, and the figure the decision turns on is in it.

     THE RECORD MOVED RATHER THAN DIED. The deleted two-sentence rule was preserved in the panel's own #871
     comment; App.tsx's #885 now carries it, and the assertion below reads it there. A record kept in a file
     that gets deleted is not a record. */
  const FLOW = readSource("utils/privatePowerFlow.ts");

  it("asks the question where the trade is made", () => {
    /* `String.fromCharCode(36)` because a literal dollar-brace in a plain string trips
       `no-template-curly-in-string`. */
    const D = String.fromCharCode(36);
    expect(stripComments(FLOW)).toContain(
      "Exchanging this Private Company for an NYC share forfeits " + D + "{cost}. Are you sure?",
    );
  });

  it("keeps the revenue figure the decision turns on", () => {
    /* #443 put `$20/OR` on the panel row because "a player weighing that needs the figure they are giving
       up". The panel's row is gone; the figure is in the question itself, which is where #871 argued it
       belonged -- "the question IS the trade". */
    const D = String.fromCharCode(36);
    expect(stripComments(FLOW)).toContain("`its " + D + D + "{revenuePerOr}/OR revenue`");
    /* AND THE NO-FIGURE CASE IS STILL HONEST. `undefined` names the loss without a number rather than
       printing a guess -- `|| 0` would tell a player they are giving up nothing. */
    expect(stripComments(FLOW)).toContain('"its Operating Round revenue"');
  });

  it("keeps the deleted two-sentence rule on the record", () => {
    // #490a in reverse: the record is read off the RAW text of the file that now carries it.
    expect(APP_RAW).toContain(
      "the owner may exchange this private for a 10% share of the New York Central",
    );
  });
});
