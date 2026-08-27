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

/* No runtime imports here -- every assertion is a source scan -- so an explicit `export {}` is what makes
   this a module under `--isolatedModules`. */
export {};

const read = (rel: string) => {
  const fs = require("fs") as typeof import("fs");
  const path = require("path") as typeof import("path");
  return fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
};
/* #490a: the notes below quote the strings they removed, so code assertions read a comment-stripped copy. */
const strip = (source: string) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const APP = strip(read("App.tsx"));
const BAR = strip(read("panels/ContextualActionBar.tsx"));
const PANEL_RAW = read("components/PrivatePowerPanel.tsx");
const PANEL = strip(PANEL_RAW);

describe("the offer is built where ownership is known", () => {
  it("only in a Stock Round", () => {
    /* The D&H and C&SL chips are Operating Round powers; these two lists are disjoint by round, which is what
       makes concatenating them safe. */
    const at = APP.indexOf("const stockRoundPowerOffers");
    expect(at).toBeGreaterThan(-1);
    const body = APP.slice(at, at + 900);
    expect(body).toContain('gameState?.current_round_type !== "StockRound"');
  });

  it("gates on the PLAYER holding it, not a corporation", () => {
    /* #441 is the rule: "A player owning the MH may exchange it". `owner` is the player field and
       `owner_protocol_id` is the corporate one -- a corporation holding the M&H offers nobody a chip, because
       a corporation cannot take this exchange. */
    const at = APP.indexOf("const stockRoundPowerOffers");
    const body = APP.slice(at, at + 900);
    expect(body).toContain("mh.owner !== viewerAddress");
    expect(body).toContain("mh.closed");
    expect(body).not.toContain("owner_protocol_id");
  });

  it("stays out of the hex-offer list", () => {
    /* `privatePowerOffer.ts` says its list "can never hold more than two entries" and feeds
       `privatePowerHexKeys`, which the board's glow reads. A power with no hex in that list would hand the
       map a key it cannot resolve, so the two are joined only where the bar takes a generic chip. */
    expect(APP).toContain("powerOffers={[...privatePowerOfferList, ...stockRoundPowerOffers]}");
    const offers = strip(read("utils/privatePowerOffer.ts"));
    expect(offers).not.toContain("mh-exchange");
    expect(offers).toContain('export type PowerAbilityKey = "csl-tile" | "dh-tile";');
  });
});

describe("the bar carries it, and dispatches nothing", () => {
  it("renders Stock Round offers as contextual buttons", () => {
    /* CONTEXTUAL BUTTONS ARE INSIDE THE STICKY ELEMENT, which is the whole point: they travel with the bar
       where the panel does not. Reached through the same `powerOffers`/`onUsePowerOffer` pair the Track step
       uses, so there is one chip mechanism rather than two. */
    const at = BAR.indexOf("contextualButtons = onUsePowerOffer");
    expect(at).toBeGreaterThan(-1);
    const body = BAR.slice(at, at + 500);
    expect(body).toContain("onUsePowerOffer(offer.abilityKey)");
    expect(body).toContain("label: offer.chipLabel");
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
  it("shares the exchange between the panel button and the modal", () => {
    /* EXTRACTED RATHER THAN COPIED. Two paths to `ExchangePrivate` could come to disagree about the legality
       check, the log line, or the `automatic` flag that lets the M&H fire between turns. */
    expect(APP).toContain("const runPrivateExchange = useCallback(");
    /* TWO CALL SITES: the panel's button and the modal's Exchange. The first draft asserted three, counting
       the declaration -- which `const runPrivateExchange = useCallback(` does not match. */
    expect((APP.match(/runPrivateExchange\(/g) ?? []).length).toBe(2);
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

describe("the panel row is one line now", () => {
  it("drops the two-sentence rule", () => {
    expect(PANEL).toContain("Trade in for a 10% NYC share. Taking it closes the company.");
    expect(PANEL).not.toContain(
      "the owner may exchange this private for a 10% share of the New York Central",
    );
  });

  it("keeps the removed sentence on the record", () => {
    // #490a in reverse: the absence is read off the stripped copy, the record off the raw file.
    expect(PANEL_RAW).toContain(
      "the owner may exchange this private for a 10% share of the New York Central",
    );
  });

  it("keeps the revenue figure the decision turns on", () => {
    /* #443 put `$20/OR` on the name because "a player weighing that needs the figure they are giving up".
       Streamlining the prose must not take the number with it -- the modal quotes the same figure. */
    /* `String.fromCharCode(36)` because a literal `${` in a plain string trips `no-template-curly-in-string`.
       Fifth time this session. */
    expect(PANEL).toContain(String.fromCharCode(36) + "{priv.revenue_per_or}/OR");
  });
});
