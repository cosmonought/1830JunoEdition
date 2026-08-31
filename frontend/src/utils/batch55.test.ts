/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 1079 (harness): THE MATH IS UPRIGHT AND THE JOKE IS IN ITALIC
// ==================================================================
//
// RULED, for the Unpredictable Revenue lines in the Activity Log:
//   - the `[time]` and `[round]` tags are not altered or colourised;
//   - a bonus gets a soft green background and a malus a soft red one, both at the alpha the amber used;
//   - an unchanged roll gets no background at all;
//   - nothing is bolded and the core font colour does not change;
//   - italics apply STRICTLY to the flavour string at the end, leaving the revenue math in the standard font.
//
// THE LAST RULE IS THE ONE WITH STRUCTURE BEHIND IT. The renderer held one string and had no idea which half
// was mechanics, so the split had to come from the composer that built the sentence. Most of this file is
// about that seam: that it lands exactly on the clause, for every shape the sentence takes.
//
// AND THE SEAM IS TESTED AGAINST THE REAL SENTENCE BUILDER, not against a fixture that looks like one. A
// hand-written "B&O ran for $210. ..." would agree with an arithmetic that had drifted from `turnRevenueSentence`,
// which is exactly how a proxy stops standing for its subject.

export {};

const { feedItemParts, feedItemText } =
  require("../components/TopTicker") as typeof import("../components/TopTicker");
const {
  revenueFlavourClause,
  revenueDieFace,
  revenueOutcome,
  rollTurnRevenue,
  turnRevenueSentence,
} = require("./gameVariants") as typeof import("./gameVariants");
const { readStripped, sliceBetween } = require("./sourceScan") as typeof import("./sourceScan");
import type { FeedItem } from "./feed";

const APP = readStripped("App.tsx");
const TICKER = readStripped("components/TopTicker.tsx");
const FEED = readStripped("utils/feed.ts");

const HEAD = "B&O ran for $210. It enjoyed a 20% bonus. ";
const TAIL = "The mail arrived on time.";

const item = (over: Partial<FeedItem> = {}): FeedItem => ({
  id: "1",
  kind: "log",
  seq: 1,
  timestampMs: 1,
  timestampLabel: "14:32:07",
  logLabel: `${HEAD}${TAIL}`,
  logDetail: "",
  logStatus: "success",
  logRound: "OR 1.1",
  ...over,
});

/* ------------------------------------------------------------------ */
/* The seam                                                           */
/* ------------------------------------------------------------------ */

describe("the flavour is a part of its own", () => {
  it("splits the line at the stamped index", () => {
    const parts = feedItemParts(item({ logFlavourFrom: HEAD.length }));
    expect(parts.body).toBe(HEAD);
    expect(parts.flavour).toBe(TAIL);
  });

  it("loses nothing in the split", () => {
    /* THE PROPERTY THAT MATTERS MOST and the one a wrong index breaks silently: the two parts put back
       together are the line the composer wrote. A split that dropped or duplicated a character would still
       satisfy every "contains" assertion beside it. */
    const entry = item({ logFlavourFrom: HEAD.length });
    const parts = feedItemParts(entry);
    expect(parts.body + parts.flavour).toBe(entry.logLabel);
  });

  it("treats a line with no index as all mechanics", () => {
    // Every ordinary action line. `""` rather than `undefined` so the renderers need no branch.
    expect(feedItemParts(item()).flavour).toBe("");
    expect(feedItemParts(item()).body).toBe(item().logLabel);
  });

  it("refuses an index of zero", () => {
    /* A LINE THAT IS ALL FLAVOUR is not a thing any composer produces, and honouring it would italicise the
       corporation's own name. Refused at both ends -- here and where `logInfo` stamps it. */
    expect(feedItemParts(item({ logFlavourFrom: 0 })).flavour).toBe("");
  });

  it("refuses an index at or past the end", () => {
    /* AN EMPTY TAIL IS AN INVISIBLE SPLIT that still costs a span. Refusing it keeps "there is a flavour
       part" and "the flavour part has text in it" the same statement. */
    expect(feedItemParts(item({ logFlavourFrom: `${HEAD}${TAIL}`.length })).flavour).toBe("");
    expect(feedItemParts(item({ logFlavourFrom: 9999 })).flavour).toBe("");
  });

  it("refuses to split a line that also carries a detail", () => {
    /* THE ORDERING TRAP. The detail is appended AFTER the label, so a split here would drop the em-dash
       detail between the mechanics and the flavour. Nothing produces both today; this is what makes that
       stay true rather than a comment hoping so. */
    const parts = feedItemParts(item({ logFlavourFrom: HEAD.length, logDetail: "why" }));
    expect(parts.flavour).toBe("");
    expect(parts.body).toContain("— why");
  });

  it("never treats a player's own words as flavour", () => {
    const chat = item({ kind: "chat", chatAuthor: "P1", chatText: "hi", logFlavourFrom: 3 });
    expect(feedItemParts(chat).flavour).toBe("");
    expect(feedItemParts(chat).body).toBe("P1: hi");
  });

  it("leaves the gutter and the one-string form alone", () => {
    /* #1076's TWO FIELDS ARE UNTOUCHED by this change, which is the check that a new part did not quietly
       redefine the old ones -- and `feedItemText` is still what a dozen suites assert against. */
    const entry = item({ logFlavourFrom: HEAD.length });
    expect(feedItemParts(entry).gutter).toBe("[OR 1.1]");
    expect(feedItemParts(entry, true).gutter).toBe("[14:32]");
    expect(feedItemText(entry)).toContain("[OR 1.1]");
    expect(feedItemText(entry)).toContain(TAIL);
  });

  it("keeps the failure marker with the mechanics", () => {
    // "Failed: " is a fact about the action, not atmosphere.
    const parts = feedItemParts(item({ logFlavourFrom: HEAD.length, logStatus: "error" }));
    expect(parts.body.startsWith("Failed: ")).toBe(true);
    expect(parts.flavour).toBe(TAIL);
  });
});

/* ------------------------------------------------------------------ */
/* The seam lands on the clause, for every shape                      */
/* ------------------------------------------------------------------ */

describe("the index the composer stamps is the start of the clause", () => {
  const seedFor = (turnSeed: number) => ({
    macroRound: 1,
    subRound: 1,
    companyId: 3,
    turnSeed,
  });

  it("lands exactly on the clause for all six faces", () => {
    /* ==================================================================
        DESIGN NOTE 1079: EVERY SHAPE THE SENTENCE TAKES, NOT ONE EXAMPLE
       ==================================================================
       `turnRevenueSentence` HAS THREE FORMS (#944/#949): "ran for $X. {clause}" on an unchanged roll, and
       "ran for $X. It {verb} a N% {noun}. {clause}" on the other two. The arithmetic is a subtraction of
       lengths, so it is right for all three or wrong for all three -- but that is the claim, and asserting
       it on one bonus roll would leave the other two shapes untested against the day a form changes.
       ALL SIX FACES, which is every form plus every bucket, and each one re-derives the clause from the same
       roll the sentence was built from rather than from a fixture that could agree with a stale sentence. */
    const faces = new Set<number>();
    for (let face = 1; face <= 6; face += 1) {
      const parts = seedFor(face - 1 + 6 * 7);
      faces.add(revenueDieFace(parts));
      const roll = rollTurnRevenue(300, parts);
      const sentence = turnRevenueSentence("B&O", roll, parts);
      const clause = revenueFlavourClause(roll, parts);
      const from = sentence.length - clause.length;

      expect(from).toBeGreaterThan(0);
      expect(sentence.slice(from)).toBe(clause);

      const split = feedItemParts(item({ logLabel: sentence, logFlavourFrom: from }));
      expect(split.flavour).toBe(clause);
      expect(split.body + split.flavour).toBe(sentence);
      // The mechanical half keeps the money and gives up the joke.
      expect(split.body).toContain("ran for $");
      expect(split.flavour).not.toContain("ran for $");
    }
    // The loop is only worth what it covered: six distinct faces, not one face six times.
    expect(faces.size).toBe(6);
  });

  it("keeps the swing sentence out of the italic on a bonus and a malus", () => {
    /* THE HALF THE REPORT NAMED: "leaving the mechanical revenue math in the standard font." #949 made
       "It suffered a 10% malus." its own sentence precisely because it is the fact a player reconciles
       against their chips, so it is the half that must not be styled as colour. */
    let checked = 0;
    for (let face = 1; face <= 6; face += 1) {
      const parts = seedFor(face - 1 + 6 * 7);
      const roll = rollTurnRevenue(300, parts);
      if (revenueOutcome(roll) === "normal") continue;
      const sentence = turnRevenueSentence("B&O", roll, parts);
      const from = sentence.length - revenueFlavourClause(roll, parts).length;
      const split = feedItemParts(item({ logLabel: sentence, logFlavourFrom: from }));
      expect(split.body).toMatch(/It (enjoyed|suffered) a \d+% (bonus|malus)\./);
      expect(split.flavour).not.toMatch(/% (bonus|malus)/);
      checked += 1;
    }
    // Vacuity guard: a loop that skipped every face would pass every assertion inside it.
    expect(checked).toBeGreaterThanOrEqual(4);
  });

  it("carries the Yellow Sign appendix with the flavour, not with the math", () => {
    /* #1046 APPENDS THE APPENDIX TO THE CLAUSE -- "One train mysteriously disappeared..." reads as the
       second half of the flavour -- so the tail the composer subtracts has to include it. Getting this
       wrong would leave the appendix upright in the middle of an italic sentence. */
    const parts = seedFor(5);
    const roll = rollTurnRevenue(300, parts);
    const appendix = "One train mysteriously disappeared...";
    const sentence = `${turnRevenueSentence("B&O", roll, parts)} ${appendix}`;
    const tail = `${revenueFlavourClause(roll, parts)} ${appendix}`;
    const from = sentence.length - tail.length;
    const split = feedItemParts(item({ logLabel: sentence, logFlavourFrom: from }));
    expect(split.flavour).toBe(tail);
    expect(split.body).not.toContain(appendix);
  });

  it("subtracts lengths rather than searching for the clause", () => {
    /* `indexOf` WOULD MATCH THE WRONG OCCURRENCE if a clause ever repeated a phrase from the mechanical
       half, and returns -1 on a miss -- the exact vacuity `sourceScan.ts` #886 was written against, here
       producing an index of -1 that silently italicises nothing. Lengths cannot miss. */
    const composer = sliceBetween(APP, "const flavourTail =", "const cue = variantCueFor(");
    expect(composer).toContain("flavourWithAppendix.length - flavourTail.length");
    expect(composer).not.toContain("indexOf");
    expect(composer.length).toBeLessThan(700);
  });

  it("stamps it on unchanged rolls too, unlike the tint", () => {
    /* ==================================================================
        DESIGN NOTE 1079: THE ONE PLACE THIS PARTS COMPANY WITH `tone`
       ==================================================================
       `tone` ANSWERS "WHICH WAY DID THE DIE GO", and #1042 deliberately gives `unchanged` no answer -- a
       highlight there would be the log emphasising the absence of news. This answers "which part of the line
       is atmosphere", and on an unchanged roll that is the same question with the same answer.
       ASSERTED AS AN ORDER, not as two separate greps: the tint is passed conditionally and the index is
       passed after it, unconditionally. Two facts, two arguments. */
    const call = sliceBetween(APP, "logInfo(\n                flavourWithAppendix,", ");");
    expect(call).toContain('bucket === "unchanged" ? undefined');
    expect(call).toContain("flavourFrom,");
    expect(call.indexOf('bucket === "unchanged"')).toBeLessThan(call.indexOf("flavourFrom,"));
    expect(call.length).toBeLessThan(1200);
  });

  it("refuses a zero index at the stamp as well as at the render", () => {
    // Both ends, because either one alone leaves the other free to change.
    expect(APP).toContain("flavourFrom !== undefined && flavourFrom > 0");
  });

  it("carries the field through the merge", () => {
    /* THE STEP THAT IS EASY TO FORGET and impossible to see: a field on `ActionLogEntry` that the merge does
       not copy arrives at the renderer as `undefined`, and the line renders correctly-but-unstyled. */
    expect(FEED).toContain("logFlavourFrom: entry.flavourFrom,");
    expect(FEED).toContain("flavourFrom?: number;");
    expect(FEED).toContain("logFlavourFrom?: number;");
  });
});

/* ------------------------------------------------------------------ */
/* The tint                                                           */
/* ------------------------------------------------------------------ */

describe("green, red, and one alpha between them", () => {
  it("uses this app's own green and red", () => {
    /* NOT A FRESH PAIR. `#4ade80` is already the positive green at sixteen call sites and `#f43f5e` the red;
       a seventeenth green would say what the sixteenth says. */
    /* Design note #1095: THE HUES ARE NAMED CONSTANTS NOW rather than written into two template literals.
       The two feed surfaces need the same tint rendered two ways -- a flattened solid where the row paints its
       own ground, a wash where the wrapper does not -- and deriving both from one pair is what keeps that from
       becoming two answers to one question. THE PAIR ITSELF IS UNCHANGED, which is what this case is about. */
    expect(TICKER).toContain("[74, 222, 128] as const");
    expect(TICKER).toContain("[244, 63, 94] as const");
  });

  it("changes the hue and nothing else about the fill", () => {
    /* ==================================================================
        DESIGN NOTE 1080, WITHDRAWN: THE BACKGROUND DID NOT NEED TOUCHING
       ==================================================================
       REPORTED: "The way that the amber background filled the line on the Activity Log before we made any
       of these changes was fine: the changes we made should have only changed the color of the background,
       nothing else about the background needed to change."
       AND IT WAS RIGHT. #1080 had moved the fill onto the row `div`, converted it to a `backgroundImage`
       gradient so it would layer over the row's own `#141c2c`, and dropped the padding and radius that then
       had nothing to sit on -- three edits, each a consequence of the first, and the first came from #1079
       describing the fill as sitting "on the sentence, not the whole row". `logLabelFull` is `flex: 1`: it
       has filled the line to the right edge since #1042.
       ==================================================================
        DESIGN NOTE 1095: THE FILL MOVED AFTER ALL, AND THIS CASE SAID IT MUST NOT
       ==================================================================
       IT READ "this case pins the shape, which is the one thing about these styles that must NOT move
       again", and that was overconfident about the wrong thing. RULED SINCE, explicitly: "apply the tints to
       the full parent row container, not just the text elements ... a solid, uniform block of color spanning
       the entire width of the line."
       WHICH IS WHERE #1080 WAS TRYING TO GO. Its destination was right; what got it withdrawn was arriving
       there with three other edits in hand -- a gradient, and the padding and radius dropped. So the durable
       lesson is not "the fill never moves", it is "the fill is the only thing that moves", and that is what
       this case pins now.
       THE GRADIENT PROHIBITION IS THE PART THAT SURVIVES INTACT, and it is now ruled twice: once by the
       withdrawal and once by "do not use gradients or fades". */
    // The row's fill: exactly one property, so nothing rides along with it this time.
    for (const style of [
      sliceBetween(TICKER, "logRowToneBonus: {", "}"),
      sliceBetween(TICKER, "logRowToneMalus: {", "}"),
    ]) {
      expect(style).toContain("backgroundColor");
      expect(style).not.toContain("padding");
      expect(style).not.toContain("borderRadius");
      expect(style).not.toContain("backgroundImage");
      expect(style).not.toContain("linear-gradient");
    }
    // The collapsed ticker's wash keeps #1042's shape, because its surface never had the problem.
    for (const style of [
      sliceBetween(TICKER, "logToneBonus: {", "},"),
      sliceBetween(TICKER, "logToneMalus: {", "},"),
    ]) {
      expect(style).toContain("backgroundColor");
      expect(style).toContain('padding: "1px 6px"');
      expect(style).toContain('borderRadius: "4px"');
      expect(style).not.toContain("linear-gradient");
    }
    // And what makes it a full-width fill rather than a pill around the words.
    expect(sliceBetween(TICKER, "logLabelFull: {", "},")).toContain("flex: 1");
  });

  it("shares the amber's alpha rather than restating it", () => {
    /* RULED as "the exact same opacity/transparency value" for both. #1042 wrote 0.12 and 0.11 by eye --
       invisible on screen, and exactly the near-agreement that reads as intent to the next reader. One
       constant is what makes "the same" checkable instead of a coincidence to be maintained. */
    /* Design note #1095: 0.12 -> 0.32, ruled -- "increase the opacity and saturation ... they need to stand
       out clearly and pop". WHAT THIS CASE IS ABOUT IS THE SHARING, not the figure: one constant is what
       makes "the exact same opacity value for both" checkable rather than a coincidence to maintain.
       ASSERTED AS THE CONSTANT'S EXISTENCE AND ITS SINGLE USE-SITE PAIR rather than its value, which
       `batch62` owns and checks against the contrast floor. */
    expect(TICKER).toContain("const TONE_TINT_ALPHA = ");
    expect(TICKER.split("TONE_TINT_ALPHA =").length - 1).toBe(1);
    expect(TICKER).not.toContain("0.11");
    expect(TICKER).not.toContain("rgba(201, 169, 76");
  });

  it("says nothing about the font", () => {
    /* THE SUBSTANCE OF THE CHANGE, not the hues. Both styles carried a `color` that overrode
       `logLabelFull`, so the variant's lines read in different ink from the log around them -- two signals
       for one fact. Ruled out explicitly: "do not bold the event text or change the core font colour." */
    const bonus = sliceBetween(TICKER, "logToneBonus: {", "},");
    const malus = sliceBetween(TICKER, "logToneMalus: {", "},");
    for (const style of [bonus, malus]) {
      /* `color:` WOULD MATCH `backgroundColor:` TOO if the colon were dropped, so the colon is load-bearing
         and the fill is asserted separately in the case above. */
      expect(style).not.toContain(" color:");
      expect(style).not.toContain("fontStyle");
      expect(style).not.toContain("fontWeight");
      expect(style.length).toBeLessThan(300);
    }
  });

  it("gives an unchanged roll no rule at all", () => {
    /* "A NEUTRAL, TRANSPARENT STATE" IS THE ABSENCE OF A RULE, not a third one. An `unchanged` roll passes
       no tone, matches neither branch, and falls through to `{}`. */
    expect(TICKER).not.toContain("logToneUnchanged");
    expect(APP).toContain('bucket === "unchanged" ? undefined : isBonusBucket(bucket) ? "bonus" : "malus"');
  });
});

/* ------------------------------------------------------------------ */
/* The italic, and where it is not                                    */
/* ------------------------------------------------------------------ */

describe("the italic reaches the flavour and nothing else", () => {
  it("exists once, on a style of its own", () => {
    /* Design note #1095: BOLD JOINED THE ITALIC -- ruled, "from standard italics to bold-italics to improve
       legibility on small screens", because a slant is the first thing a small rasteriser loses. WHAT THIS
       CASE IS ABOUT IS UNCHANGED: the emphasis exists ONCE, on a style of its own, applied to the flavour
       clause and to nothing else. The cases below still hold the "and where it is not" half. */
    expect(TICKER).toContain('logFlavourText: { fontStyle: "italic", fontWeight: 700 }');
    expect(TICKER.split('fontStyle: "italic"').length - 1).toBe(1);
  });

  it("is applied to the flavour part in both renderers", () => {
    /* #694's RULE, which this dock has now broken three times: "the same feed saying two different things
       about the same message depending on whether it happened to be open." Counted rather than pinned to a
       surrounding expression -- one application per surface. */
    expect(TICKER.split("styles.logFlavourText").length - 1).toBe(2);
    expect(TICKER).toContain("{parts.flavour}");
    expect(TICKER).toContain("feedItemParts(latestItem).flavour");
  });

  it("nests the italic inside the tint rather than beside it", () => {
    /* TWO SIBLING SPANS WOULD BREAK THE FILL into two pills with a seam down the middle of one sentence.
       The tint is a property of the line; the italic is a property of one part of it. */
    const row = sliceBetween(TICKER, "{parts.body}", "</span>");
    expect(row).toContain("styles.logFlavourText");
    expect(row.length).toBeLessThan(500);
  });
});

describe("the wash covers the whole entry, and the tags keep their own ink", () => {
  /* ==================================================================
      DESIGN NOTE 1080: THIS BLOCK ASSERTED THE OPPOSITE ONE REVISION AGO
     ==================================================================
     #1079 READ "do not alter or colorize the [time] or the [round] tags" as "keep the fill off the gutter"
     and pinned that. RULED since: "please tint the entire activity log entry for the Revenue Event."
     THE TWO RULES WERE NEVER IN CONFLICT, which is the part worth writing down rather than just re-pinning.
     The first is about the TAGS' OWN INK -- their colour and weight -- and a wash behind them changes
     neither. So this block now asserts both halves: the fill reaches the whole entry, AND the gutter's own
     colour and weight are untouched. Asserting only the first would let a later edit recolour the tag and
     still pass. */

  it("fills the whole row now, gutter included", () => {
    /* ==================================================================
        DESIGN NOTE 1095: THE FILL MOVED, AND THIS CASE MOVES WITH IT
       ==================================================================
       IT ASSERTED THE FILL WAS ON `logLabelFull`, the `flex: 1` span -- which reached the right edge but
       started AFTER the gutter, the gap and the row's left padding. RULED SINCE: "apply the tints to the full
       parent row container, not just the text elements ... spanning the entire width of the line."
       THE CLAIM THIS CASE MAKES IS THE SAME ONE, moved to the element that now carries it: the fill reaches
       the whole entry. The gutter-ink half below is untouched and is what stops a later edit recolouring the
       tag and still passing. */
    const label = sliceBetween(TICKER, "...styles.logEntry,", 'role="button"');
    expect(label).toContain("styles.logRowToneBonus");
    expect(label).toContain("styles.logRowToneMalus");
    expect(sliceBetween(TICKER, "logLabelFull: {", "},")).toContain("flex: 1");
  });

  it("does the same on the collapsed preview", () => {
    /* #694's RULE: the dock a player watches and the panel they open must not say two different things about
       one message. `previewText` is also `flex: 1`, and the tone rides it. */
    const wrapper = sliceBetween(TICKER, "...styles.previewText,", "}}");
    expect(wrapper).toContain("logTone");
    expect(sliceBetween(TICKER, "previewText: {", "},")).toContain("flex: 1");
    expect(wrapper.length).toBeLessThan(700);
  });

  it("leaves the gutter's own colour and weight alone", () => {
    /* THE FIRST BULLET: "do not alter or colorize the [time] or the newly bolded [round] tags." The tag is
       `#c8cdd8` at weight 800 on every line, tinted or not, and neither tone style may reach it. */
    const gutter = sliceBetween(TICKER, "logGutter: {", "},");
    expect(gutter).toContain("fontWeight: 800");
    expect(gutter).toContain('color: "#c8cdd8"');
    expect(gutter).not.toContain("logTone");
    expect(gutter).not.toContain("backgroundColor");
    expect(gutter.length).toBeLessThan(400);
  });
});
