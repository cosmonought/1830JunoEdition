/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTES 970-976 (harness): THREE REPORTS, AND ONE OF THEM WAS ALREADY FIXED
// ==================================================================
//
// BATCH 23 IS THREE UI ADJUSTMENTS, and they need three different kinds of case.
//
//   #971 (the arrows that stopped appearing) IS THE ONLY REAL BUG IN THE BATCH, and it is a CSS-animation
//   lifecycle fault: `animation-fill-mode: forwards` on a node that is never unmounted. jsdom runs no
//   animations at all, so no render test in this project could observe it -- what CAN be checked is the two
//   mechanisms that make a replay possible, and both are structural.
//
//   #974 and #975/#976 are markup and style literals: which ink a name takes, which element is gone, where a
//   size comes from. Source scans, for the reason `polishWave6` gives.
//
//   #970a IS NOT A FIX AT ALL and this file says so rather than quietly asserting the portal for a second
//   time. The reported occlusion could not be reproduced from the source; what is asserted is the search, so
//   nobody repeats it.
//
// AND ONE CASE HERE IS ABOUT A RULE THAT NEVER WORKED (#970b). `polishWave6` asks whether the reduced-motion
// rule EXISTS. It does, and it has been losing to an inline style since #953 -- which is a cascade question
// a source scan cannot ask, so the case below asks the one thing it can: whether the rule is marked to win.

import { readStripped, sliceBetween } from "./sourceScan";

const FLASH = readStripped("components/RevenueModifierFlash.tsx");
const ANIM = readStripped("styles/animations.ts");
const BAR = readStripped("panels/ContextualActionBar.tsx");
const STYLES = readStripped("styles/appStyles.ts");
const APP = readStripped("App.tsx");

describe("the flash replays on every trigger (design note #971)", () => {
  it("remounts the overlay on the token", () => {
    /* ==================================================================
        THE REPORTED FAULT, AND WHY A KEY IS THE FIX RATHER THAN A PREFERENCE
       ==================================================================
       REPORTED: the arrows "fail to appear at all after the first time the notification fires."
       THE CAUSE IS `animation-fill-mode: forwards` ON A NODE THAT NEVER LEFT. The arrows' keyframes end at
       `opacity: 0`, and a CSS animation does not restart because a parent re-rendered -- so the second flash
       reused six DOM nodes already parked on their final frame. The numeral kept appearing because ITS
       keyframe ends at `opacity: 1`, which is exactly why the report describes arrows and not the figure.
       A CHANGED KEY DESTROYS AND REBUILDS THE SUBTREE, and a freshly inserted element runs its animations
       from 0%. #597 settled the same question the same way for the turn-handoff band. */
    expect(FLASH).toContain("key={shown.token}");
  });

  it("keys on the trigger, not on the value it carries", () => {
    /* #940's WHOLE REASON FOR HAVING A TOKEN: two trains in one turn can roll the same delta, so a key on
       `shown.delta` would collapse two events into one and replay nothing -- the reported symptom back,
       arriving by a different route and looking identical. */
    expect(FLASH).not.toContain("key={shown.delta}");
    expect(FLASH).toContain("token: number;");
  });

  it("unmounts once the fade has finished", () => {
    /* THE OTHER HALF, and the one that makes a replay possible even without the key. The overlay used to
       stay mounted for the rest of the session at `opacity: 0` -- a full-viewport node at z-index 9000 over
       the whole app between runs, and the state that made the stale animation possible in the first place.
       AFTER THE FADE, NOT AT THE WINDOW. Clearing at `REVENUE_FLASH_MS` would cut the opacity transition off
       mid-way and the overlay would blink out instead of fading, which is the one visible way this could go
       wrong -- so the sum is asserted rather than the constant. */
    expect(FLASH).toContain("REVENUE_FLASH_MS + REVENUE_FLASH_FADE_MS,");
    expect(FLASH).toContain("() => setShown(null),");
  });

  it("clears both timers when a new turn interrupts the old one", () => {
    /* TWO TIMERS, ONE CLEANUP. A second flash arriving inside the first one's window would otherwise be
       switched off by the PREVIOUS turn's `setShown(null)` -- the new overlay vanishing partway through, on
       a schedule belonging to the run before it. The failure is intermittent by construction, which is
       exactly the kind this project cannot playtest its way to. */
    const cleanup = sliceBetween(FLASH, "return () => {", "};");
    expect(cleanup).toContain("window.clearTimeout(timer);");
    expect(cleanup).toContain("window.clearTimeout(clear);");
  });
});

describe("one duration, for every surface (design note #970)", () => {
  it("is 900, as ruled", () => {
    expect(FLASH).toContain("export const REVENUE_FLASH_MS = 900;");
  });

  it("leaves the arrows and the edge no duration of their own", () => {
    /* ==================================================================
        THE ACTUAL SOURCE OF "INCONSISTENT", AND IT WAS NEVER THE CONSTANT
       ==================================================================
       REPORTED: "The animation speed feels inconsistent when re-running a route via Undo. Hardcode the
       display duration to exactly 850ms so it is uniform in all contexts."
       THERE WERE THREE DURATIONS. This constant at 700, `.app-revenue-arrow`'s own `animation-duration:
       700ms`, and the glow's `700ms` inside an `animation` SHORTHAND. Three literals that agreed, which is a
       coincidence and not an invariant -- and "hardcode it to 850" performed on the constant alone would
       have produced a text that lasts 850ms over motion that lasts 700, which is a more inconsistent overlay
       than the one being reported about.
       SO THE STYLESHEET NAMES NO DURATION FOR THESE ELEMENTS AT ALL. Asserted as an absence on the two
       blocks, because a positive check on the inline styles would pass while a stale CSS value sat under
       them doing nothing and reading as the truth. */
    const arrow = sliceBetween(ANIM, ".app-revenue-arrow {", ".app-revenue-figure");
    expect(arrow).not.toContain("animation-duration:");
    const edge = sliceBetween(ANIM, ".app-revenue-edge {", "}");
    expect(edge).not.toContain("animation-duration:");
  });

  it("supplies it inline to both animated elements", () => {
    /* THE OTHER SIDE OF THAT ABSENCE. Removing the CSS duration without adding the inline one leaves both
       animations at the CSS initial value of `0s` -- they would not play at all, and the absence case above
       would be perfectly happy. TWO occurrences: the arrows and the edge. */
    expect(FLASH.match(/animationDuration: `\$\{REVENUE_FLASH_MS\}ms`/g)?.length ?? 0).toBe(2);
  });

  it("leaves the figure's entrance out of it, deliberately", () => {
    /* AN ENTRANCE IS A GESTURE, NOT A WINDOW. Tying the 260ms settle to `REVENUE_FLASH_MS` would make the
       numeral swell slowly over most of a longer window rather than arrive -- so this one is NOT a missed
       consumer of the constant, and the note beside it says so. */
    expect(ANIM).toContain("animation: app-revenue-figure-in 260ms ease-out 1;");
  });
});

describe("the glow moved to the screen's rim (design note #973)", () => {
  it("renders the edge element and tints it to the outcome", () => {
    /* RULED: "Remove the text glow and replace it with a brief screen-border glow/flash (green for bonus,
       red for malus)." The hue is decided beside `BONUS_COLOR`/`MALUS_COLOR` and handed to the stylesheet as
       `color`, so this feature has one place that knows what green means. */
    expect(FLASH).toContain('className="app-revenue-edge"');
    // Design note #1065: the rim gained a neutral arm; the green/red pair this case names is unchanged.
    expect(FLASH).toContain("BONUS_EDGE : MALUS_EDGE,");
    expect(FLASH).toContain("const BONUS_EDGE");
    expect(FLASH).toContain("const MALUS_EDGE");
  });

  it("draws it as an inset shadow on a fixed full-viewport box", () => {
    /* THREE PROPERTIES, EACH OF WHICH BREAKS IT ALONE. Without `inset` the halo is drawn OUTSIDE a
       viewport-sized box, where nothing can see it. Without `position: fixed` the element is laid out as a
       flex item beside the numeral -- the overlay is a centring flex container -- and the "screen border"
       becomes a small box next to the figure. Without `pointer-events: none` it covers the board. */
    const edge = sliceBetween(ANIM, ".app-revenue-edge {", "}");
    expect(edge).toContain("box-shadow: inset");
    expect(edge).toContain("position: fixed");
    expect(edge).toContain("inset: 0");
    expect(edge).toContain("pointer-events: none");
    expect(edge).toContain("currentColor");
  });

  it("keeps the rim flash and the backdrop as two different jobs (design note #986)", () => {
    /* ==================================================================
        HALF OF #973 IS REVERSED, AND THE HALF THAT SURVIVES IS THE ARGUMENT
       ==================================================================
       THIS ASSERTED `not.toContain("radial-gradient")` -- #973 had moved the glow to the screen's rim and
       argued the rim was the better home "from a place the board never occupies".
       REPORTED SINCE: "The number is getting lost against the map and the Action Bar ... render a
       white/cream radial gradient glow strictly behind the number and arrows."
       AND #973 WAS TREATING ONE ELEMENT AS DOING ONE JOB when it was doing two. #960's glow carried the
       outcome's hue (a direction cue) AND sat behind the glyphs (legibility). Moving it to the rim kept the
       first and silently dropped the second, which is the report.
       SO BOTH EXIST NOW, and the COLOUR is what stops them being the duplication #973 objected to: the rim is
       tinted green or red and says which way the money went; the backdrop is neutral cream and says nothing.
       Two elements, two channels, no overlap -- asserted as the pair rather than as either alone, because
       either one arriving without the other is a state this batch can half-reach. */
    const ANIM = readStripped("styles/animations.ts");
    expect(FLASH).toContain('className="app-revenue-edge"');
    expect(FLASH).toContain('className="app-revenue-backdrop"');
    expect(FLASH).toContain("radial-gradient(ellipse closest-side");
    /* THE BACKDROP SAYS NOTHING ABOUT DIRECTION. A `bonus ?` ternary anywhere near its colour would put the
       outcome's hue behind the figure again, which is exactly what #973 removed. */
    const backdrop = sliceBetween(FLASH, 'className="app-revenue-backdrop"', "/>");
    expect(backdrop).not.toContain("bonus ?");
    expect(ANIM).not.toContain("app-revenue-glow");
  });

  it("fades the backdrop to nothing at its edge, at the ruled opacity", () => {
    /* RULED: "70% opacity at its center and fade out completely to 0% at its edges."
       BOTH STOPS ASSERTED, and as the SAME ink at two alphas. Fading to the `transparent` keyword instead is
       the classic gradient bug -- several engines interpolate it through transparent BLACK, which lays a grey
       halo across the middle of a gradient whose whole job is to brighten. */
    expect(FLASH).toContain('const BACKDROP_INK = "rgba(255, 250, 240, 0.7)"');
    expect(FLASH).toContain('const BACKDROP_FADE = "rgba(255, 250, 240, 0)"');
    expect(FLASH).not.toContain("transparent)");
  });

  it("puts the backdrop strictly behind the number and the arrows", () => {
    /* "STRICTLY BEHIND" IS `z-index: -1` INSIDE THE FIGURE'S WRAPPER: the numeral and all six arrows are
       siblings in that one stacking context, so a single negative index puts the backdrop under every one of
       them. Without it the cream washes over the glyphs it exists to lift -- the exact opposite of the job,
       and the failure #960 named for its own glow. */
    const ANIM = readStripped("styles/animations.ts");
    const backdrop = sliceBetween(ANIM, ".app-revenue-backdrop {", "}");
    expect(backdrop).toContain("z-index: -1");
    expect(backdrop).toContain("pointer-events: none");
    expect(backdrop).toContain("position: absolute");
  });

  it("sizes the backdrop from the wrapper, so it covers the arrow spread", () => {
    /* #960's GLOW WAS `2.6em` SQUARE -- a multiple of the FONT SIZE, which is right for a numeral alone and
       far too small for a numeral ringed by six arrows reaching from -32% to 124%. Percentages resolve
       against the same box those offsets are percentages of, so the backdrop grows with the spread instead
       of needing a re-tune every time an offset moves.
       CHECKED AGAINST THE ARROWS' OWN REACH rather than against a remembered number, so widening the spread
       without widening the backdrop fails here. */
    const ANIM = readStripped("styles/animations.ts");
    const backdrop = sliceBetween(ANIM, ".app-revenue-backdrop {", "}");
    const width = Number(backdrop.match(/width: (\d+)%/)?.[1]);
    const lefts = (FLASH.match(/left: "(-?[\d.]+)%"/g) ?? []).map((entry) =>
      Number(entry.replace(/[^-\d.]/g, "")),
    );
    expect(lefts.length).toBe(6);
    expect(width).toBeGreaterThan(Math.max(...lefts) - Math.min(...lefts));
  });

  it("keeps the black halo on the text", () => {
    /* "REMOVE THE TEXT GLOW" IS ABOUT #960's COLOURED FIELD, not about the shadow that makes the numeral
       readable at all. #364 puts the same halo on the hex badge, and this overlay sits over a board that is
       yellow, green, grey and red by turns -- deleting it would be a legibility regression dressed as
       compliance with the ruling. */
    expect(FLASH).toContain("textShadow:");
  });
});

describe("the arrows are legible against the numeral (design note #972)", () => {
  it("sizes both tiers to the ruled share of the number", () => {
    /* ==================================================================
        #972 MEASURED THE WRONG THING, AND THAT IS WHY THEY STILL LOOKED SMALL
       ==================================================================
       IT ASSERTED THE TWO BASES HAD GROWN past #957's figures, which they had. REPORTED ANYWAY: "The
       animation arrows are still drastically too small ... The large/critical arrows must be 60-80% of the
       size of the number text, and the small/minor arrows must be 30-50%."
       THE INSTRUCTION AND #972 ARE TALKING ABOUT DIFFERENT QUANTITIES. #972 set a FONT SIZE and compared it
       to the numeral's font size; the ruling is about DRAWN heights. U+25B2 inks roughly seven tenths of its
       em while the numeral is read by its cap height -- so a "0.55em" arrow drew at about 53% of the numeral,
       and the smallest of the six landed near 37%. Every percentage in #972's note was about a box nobody can
       see.
       SO THE ASSERTION IS ON THE BAND, in the ruling's own units, and the conversion is asserted separately
       in `polishWave7`. "At least 10x" is not implementable alongside these percentages -- ten times #972's
       sizing puts one arrow at five and a half times the numeral's height -- and #985 records that the band
       is the half that was followed. */
    expect(FLASH).toContain("critical: { low: 0.6, high: 0.8 }");
    expect(FLASH).toContain("minor: { low: 0.3, high: 0.5 }");
    expect(FLASH).toContain("CAP_HEIGHT_RATIO");
    expect(FLASH).toContain("ARROW_GLYPH_RATIO");
  });

  it("keeps #957's skew while doing it", () => {
    /* THE HALF THAT MUST SURVIVE A RESCALING. Size is the channel a familiar player reads before the numeral
       resolves, and it only says anything if the two tiers stay apart -- so the bands must not overlap at
       all, which is stronger than comparing their centres. */
    const criticalLow = Number(FLASH.match(/critical: \{ low: ([\d.]+)/)?.[1]);
    const minorHigh = Number(FLASH.match(/minor: \{ low: [\d.]+, high: ([\d.]+)/)?.[1]);
    expect(criticalLow).toBeGreaterThan(minorHigh);
  });

  it("pushes the offsets out with them", () => {
    /* THE FAILURE A RESCALING INTRODUCES AND NOTHING ELSE WOULD CATCH. These offsets are percentages of the
       figure's own box, so they are POSITIONS -- enlarging the glyphs without moving them walks the inner
       arrows over the numeral. Checked as a horizontal SPAN rather than per-arrow, because which arrow sits
       where is #953's business and the spread is what has to grow. */
    const lefts = (FLASH.match(/left: "(-?[\d.]+)%"/g) ?? []).map((entry) =>
      Number(entry.replace(/[^-\d.]/g, "")),
    );
    expect(lefts.length).toBe(6);
    expect(Math.max(...lefts) - Math.min(...lefts)).toBeGreaterThan(122);
  });

  it("still starts every arrow inside the window", () => {
    /* #953's RULE, RE-ASKED because this batch touched both the delays' neighbours and the window they must
       fit inside. An arrow whose delay outlives the overlay is paid for and never seen, and nothing on
       screen would say so -- it simply renders five arrows instead of six. */
    const window = Number(FLASH.match(/REVENUE_FLASH_MS = (\d+)/)?.[1]);
    const delays = (FLASH.match(/delay: \d+/g) ?? []).map((entry) => Number(entry.replace(/\D/g, "")));
    expect(delays.length).toBe(6);
    for (const delay of delays) expect(delay).toBeLessThan(window);
  });
});

describe("reduced motion is marked to win (design note #970b)", () => {
  it("marks the overlay's three animation rules important", () => {
    /* ==================================================================
        A RULE THAT HAS EXISTED AND NEVER APPLIED
       ==================================================================
       The arrows set `animationName` and `animationDelay` as INLINE styles, and an inline declaration beats
       a stylesheet rule at any specificity unless the rule is `!important`. So `animation: none` reset the
       shorthand's other longhands and lost on the only one that matters: a player with reduced motion has
       been watching six arrows fly since #953.
       `polishWave6` ASKS WHETHER THE RULE EXISTS and it does -- whether a rule WINS is a cascade question,
       and a source scan cannot ask it. What it can ask is whether the rule is marked to win, which is the
       one difference between the broken form and the working one.
       THE FILE ALREADY KNEW: `.app-train-rust-critical` carries `animation: none !important` five blocks up,
       for this exact reason. Nothing compared them. */
    for (const rule of [".app-revenue-arrow", ".app-revenue-figure", ".app-revenue-edge"]) {
      const reduced = sliceBetween(ANIM, `${rule} { animation: none`, "}");
      expect([rule, reduced.includes("!important")]).toEqual([rule, true]);
    }
  });

  it("holds the arrows and the edge visible rather than deleting them", () => {
    /* THE ACCOMMODATION IS ABOUT MOTION, NOT ABOUT INFORMATION. The edge carries the bonus/malus DIRECTION
       as a colour and the arrows carry it as a shape; removing them would give these users a different
       message, not a calmer one. An opacity floor is what keeps "stop moving" from meaning "stop saying". */
    expect(ANIM).toContain(".app-revenue-arrow { animation: none !important; opacity: 0.5; }");
    expect(ANIM).toContain(".app-revenue-edge { animation: none !important; opacity: 0.55; }");
  });
});

describe("the president reads as a person (design note #974)", () => {
  it("paints the name in the seat colour, falling back to the bar's ink", () => {
    /* REPORTED: "it is hard to tell at a glance who owns the active corporation ... render the player's name
       in their specific player color."
       THE FALLBACK IS #779's RULE and is asserted with the colour rather than separately: an address off the
       roster gets NO colour, because "on a table where colour identifies a person, a wrong colour is worse
       than none" -- and what it falls back to must be an ink that is legible on a livery-painted bar, which
       is what `corporationBarInk.inkMuted` is for. */
    expect(BAR).toContain("color: activeCorporation.presidentColor ?? corporationBarInk.inkMuted,");
  });

  it("resolves the colour in the shell, where the roster is", () => {
    /* `seatColor` WANTS THE ROSTER INDEX AND THE BAR HAS A NAME. Three other panels resolve this the same
       way for the same reason (#779), and a second answer invented in the bar would be a second opinion
       about whose colour is whose. Asserted as the `-1` guard, which is the part that carries the rule. */
    expect(APP).toContain("presidentColor:");
    const resolve = sliceBetween(APP, "presidentColor: (() => {", "})(),");
    expect(resolve).toContain("gameState.player_addresses.indexOf(company.president)");
    expect(resolve).toContain("seat === -1 ? null : seatColor(company.president, seat)");
  });

  it("gives the badge a neutral plate", () => {
    /* ==================================================================
        THE PLATE IS WHAT MAKES THE COLOUR POSSIBLE
       ==================================================================
       RULED: "use a neutral background badge". #236 paints this whole bar in the ACTING CORPORATION's
       livery, so a seat colour laid straight onto it is eight hues over eight liveries -- sixty-four
       contrast pairs, several of them a seat colour on very nearly itself, and the failure is silent: the
       name does not vanish, it stops being legible on two boards out of eight.
       TRANSLUCENT BLACK RATHER THAN A SOLID, because it has to darken eight liveries by the same amount and
       remain the same badge on all of them -- a fixed hex would be right on the dark corporations and a grey
       patch on the pale ones. */
    /* ==================================================================
        SUPERSEDED BY #989: THE TRANSLUCENT PLATE WAS THE THING THAT LOOKED MESSY
       ==================================================================
       THIS ASSERTED `rgba(0, 0, 0, ...)`, and #974's reason was that one translucent rule could darken eight
       liveries by the same amount.
       REPORTED SINCE: "a dark, semi-opaque background that looks messy against the app's blue theme."
       AND THE REPORT IS RIGHT ABOUT THE MECHANISM. A translucent plate does not produce ONE ground, it
       produces eight muddied ones -- each corporation's own hue seen through smoke -- so the badge changed
       colour as the turn passed round the table, which is the opposite of what #974 claimed for it.
       THE PROPERTY THE CASE IS FOR IS UNCHANGED: the badge has a ground of its own, so a seat colour is read
       against one known surface rather than against a livery. Solid white is that, and better at it. */
    const style = sliceBetween(STYLES, "orContextPresident: {", "},");
    expect(style).toContain('backgroundColor: "#ffffff"');
    expect(style).not.toContain("rgba(0, 0, 0,");
    expect(style).toContain("borderRadius:");
    expect(style).toContain("padding:");
  });

  it("keeps the second row on the full name's line", () => {
    /* #805's ALIGNMENT INVARIANT, which a badge is exactly the thing that breaks. The president sits in a
       two-row column under the treasury, and the rows line up because the first is floored at the herald's
       height -- padding tall enough to grow the second row would push it off the full name's line and undo
       the placement three notes have argued about. Asserted as a CEILING on the vertical padding, since
       "small" is the property and any particular value is not. */
    const style = sliceBetween(STYLES, "orContextPresident: {", "},");
    const padding = style.match(/padding: "([^"]+)"/)?.[1] ?? "";
    const vertical = Number(padding.split(" ")[0].replace(/\D/g, ""));
    expect(padding).not.toBe("");
    expect(vertical).toBeLessThanOrEqual(2);
  });

  it("puts the crown in the shared gold, not the bar's ink", () => {
    /* A CORRECTION, NOT A DECORATION. The crown took `currentColor` here, so it rendered in the
       corporation's muted ink -- a different colour than the same drawing has on `ContextualSubPanel`, where
       #552's crown is gold. One mark, two colours, decided by which panel you were looking at.
       AND NOW THE NAME IS THE VARIABLE while the crown is the constant, which is what lets a player read
       "crown = president, colour = who" instead of decoding both together. */
    expect(BAR).toContain("color: PRESIDENT_CROWN_GOLD");
  });

  it("has one declaration of that gold and three consumers", () => {
    /* THE HEX WAS TYPED IN TWO PANELS ALREADY and this batch would have made it three.
       `PRIVATE_POWER_STAR_FILL` exists one component over for exactly this reason: "Exported so the button
       cannot drift to a near-miss." Asserted as an absence of the literal at the call sites, because a
       surviving copy still renders the right colour today and is wrong the moment either moves. */
    const crown = readStripped("components/PresidentCrown.tsx");
    expect(crown).toContain('export const PRESIDENT_CROWN_GOLD = "#c9a94c";');
    for (const file of ["components/ContextualSubPanel.tsx", "components/PlayerCards.tsx"]) {
      const source = readStripped(file);
      expect([file, source.includes("PRESIDENT_CROWN_GOLD")]).toEqual([file, true]);
      expect([file, source.includes('"#c9a94c"')]).toEqual([file, false]);
    }
  });

  it("leaves the crown's default alone", () => {
    /* THE DEFAULT IS STILL `currentColor` AND THAT IS STILL RIGHT. #552's whole argument for shipping a
       drawing is that it takes the row's ink; three surfaces override it and the rest should not. Exporting
       the gold must not turn into applying it everywhere. */
    const crown = readStripped("components/PresidentCrown.tsx");
    expect(crown).toContain('fill="currentColor"');
    expect(crown).not.toContain("fill={PRESIDENT_CROWN_GOLD}");
  });
});

describe("the power chip carries one mark (design notes #975/#976)", () => {
  it("has taken the rainbow strip off the chip", () => {
    /* ==================================================================
        AND #884's NOTE WAS WRONG ABOUT WHAT THE STRIP SAID
       ==================================================================
       RULED: "Remove the vertical rainbow gradient strip from the 'Use [Private Company] Power' button."
       #943 SAID "The gradient says WHICH company; the star says what kind of thing this is." That is
       checkable and false: `PRIVATE_POWER_GLOW_STOPS` is ONE array, the same eight-stop hue circle on every
       chip. The acronym in the label identifies the company; the strip was a second, weaker copy of what the
       star already says.
       ASSERTED IN BOTH FILES, on comment-stripped copies (#490a): the element's removal and the style's, so
       an orphaned key cannot sit in the sheet waiting to be spread back in. */
    expect(BAR).not.toContain("styles.actionBarPowerChipMark");
    expect(STYLES).not.toContain("actionBarPowerChipMark:");
    expect(STYLES).not.toContain("PRIVATE_POWER_GLOW_STOPS");
  });

  it("leaves the palette itself and its other renderers alone", () => {
    /* WHAT MUST NOT GO WITH IT. #727's association is card -> hex -> chip, and only the chip's copy was
       ruled off. Deleting the list, or the hex halo that draws it, would take the association with it and
       nothing in this batch asked for that. */
    expect(readStripped("utils/privatePowerGlow.ts")).toContain("PRIVATE_POWER_GLOW_STOPS");
    expect(readStripped("components/HexGridRenderer.tsx")).toContain("PRIVATE_POWER_GLOW_STOPS");
  });

  it("still renders the star, once, with the label as its name", () => {
    /* THE MARK THAT REMAINS. With the strip gone this is the chip's only pictogram, so losing it in the same
       edit would leave a plain button -- and the star is the stronger link to the hex anyway, being drawn ON
       the hex (#714) where the halo is drawn around it. */
    expect(BAR.match(/<PrivatePowerStar/g)?.length ?? 0).toBe(1);
    expect(BAR).toContain("label: offer.chipLabel,");
  });

  it("derives the star's height from the chip's own type", () => {
    /* ==================================================================
        THE DEFECT WAS THAT 11 CAME FROM NOWHERE
       ==================================================================
       REPORTED: "The star icon on the Action Bar button is currently larger than the star on the board
       hexes. Scale down the Action Bar button's star so it matches the size of the board hex star
       perfectly."
       THE HEX DERIVES ITS STAR FROM A MEASURED CAP-HEIGHT (#937) AND THIS ONE WAS TYPED. That the two were
       ever close was luck, and it would have come apart silently the next time `FONT_SIZE.strong` moved.
       X-HEIGHT HERE, CAP-HEIGHT THERE, and `privatePowerStar` #975 carries the argument: the hex's neighbour
       is `DH` -- all capitals, so cap-height is the word's whole mass -- while this chip's is
       `Use DH Power`, mostly lowercase, where a cap-height star towers over the word. Same rule, different
       string, and applying it correctly is what shrinks this one. */
    expect(BAR).toContain("parseFloat(FONT_SIZE.strong) * X_HEIGHT_RATIO");
    expect(BAR).toContain("height={POWER_CHIP_STAR_PX}");
    expect(BAR).not.toContain("height={11}");
  });

  it("shrinks it, which is what the report asked for", () => {
    /* THE DERIVATION AND THE DIRECTION ARE SEPARATE CLAIMS. A rule that computed 13 would satisfy every
       assertion above and be a worse answer to the report than the literal it replaced. Computed from the
       two constants rather than asserted as a number, so a change to either is checked against the ruling
       rather than against my arithmetic on the day. */
    const type = readStripped("styles/typography.ts");
    const ratio = Number(type.match(/X_HEIGHT_RATIO = ([\d.]+)/)?.[1]);
    const strong = Number(sliceBetween(type, "strong:", ",").replace(/\D/g, ""));
    expect(ratio).toBeGreaterThan(0);
    expect(strong).toBeGreaterThan(0);
    expect(strong * ratio).toBeLessThan(11);
  });

  it("has one declaration of the cap-height ratio, not three", () => {
    /* ==================================================================
        FOUND BY THIS FILE, WHICH IS THE REASON IT IS HERE
       ==================================================================
       My first version of the case above asserted `not.toContain("fontPx * 0.72")` on the canvas and FAILED
       -- because there was a second copy I had not been looking for, in `tokenTextChordWidth` (#564), sizing
       the chord a station token's letters must fit inside. Same number, same meaning, same comment saying
       "cap height, near enough", written independently.
       SO THE RATIOS MOVED TO `typography.ts`. They are facts about letters rather than about a star or a
       token, and this batch was about to write a fourth copy on the action bar.
       ASSERTED AS AN ABSENCE OF THE LITERAL across both files that had one, because a surviving copy renders
       correctly today and is wrong the moment the shared figure is corrected -- which is precisely the state
       this was in before the batch. */
    const canvas = readStripped("components/hexCanvasPrimitives.ts");
    expect(canvas).toContain("fontPx * CAP_HEIGHT_RATIO");
    expect(canvas).toContain("fontPx * CAP_HEIGHT_RATIO * 0.5");
    /* ANCHORED ON THE MULTIPLICATION, not on the digits. A bare `0.72` also matches
       `rgba(255, 255, 255, 0.72)` -- a label plate's alpha, forty lines away and nothing to do with type --
       so the broad form failed against correct code. Recorded because "assert the absence of the number"
       reads as obviously right and catches the wrong thing here. */
    expect(canvas).not.toContain("* 0.72");
    expect(readStripped("panels/ContextualActionBar.tsx")).not.toContain("* 0.52");
    /* AND MEASURING IS STILL PREFERRED WHERE IT IS POSSIBLE. #937's point is that a ratio is the FALLBACK;
       naming it must not turn into using it. */
    expect(canvas).toContain("actualBoundingBoxAscent");
  });
});

describe("the portal was already there (design note #970a)", () => {
  /* ==================================================================
      A REPORT WITH NO CHANGE ATTACHED, RECORDED AS SUCH
     ==================================================================
     REPORTED: "The notification is being hidden/overlapped by the sticky Action Bar. Break the overlay out
     using an absolute top-level `z-index` (or a React portal)."
     BOTH OF THOSE ARE WHAT #956 DID. These cases do not fix anything -- they pin the search, so the next
     person reading this report does not spend the batch re-deriving that there is nothing to find. The
     likely explanation is #971: from the second flash onward the overlay arrived as a bare numeral with no
     motion and nothing around it, which is a reasonable thing to describe as hidden. */

  it("still portals out of the app subtree", () => {
    expect(FLASH).toContain("createPortal(overlay, document.body)");
  });

  it("sits above every z-index in the app, not just in the sheet", () => {
    /* #956's OWN CASE READS `appStyles.ts` ALONE, and this app has `zIndex` literals in components too --
       up to 4000. Widened to the whole of `src` so a new modal in a panel cannot get above the overlay
       without failing here. */
    const declared = Number(FLASH.match(/REVENUE_FLASH_Z_INDEX = (\d+)/)?.[1]);
    const files = [
      "styles/appStyles.ts",
      "App.tsx",
      "panels/ContextualActionBar.tsx",
      "components/StockRoundPanel.tsx",
    ];
    let seen = 0;
    for (const file of files) {
      for (const entry of readStripped(file).match(/zIndex: \d+/g) ?? []) {
        seen += 1;
        expect([file, entry, declared > Number(entry.replace(/\D/g, ""))]).toEqual([
          file,
          entry,
          true,
        ]);
      }
    }
    expect(seen).toBeGreaterThan(4);
  });

  it("has no containing block on the portal's target", () => {
    /* THE ONE MECHANISM THAT WOULD ACTUALLY EXPLAIN THE REPORT. An ancestor with `transform`, `filter`,
       `perspective`, `contain` or `will-change` makes `position: fixed` resolve against THAT element rather
       than the viewport -- and for a body portal the only ancestors are `html` and `body`. If `body` had one
       the overlay would centre in the whole scrollable document instead of the screen, which is exactly the
       symptom.
       IT DOES NOT. `index.html` styles `body` with `margin`, `font-size` and `line-height`, and nothing in
       `src` writes to `document.body.style`. Asserted so a future edit that adds one fails here with this
       note attached, rather than being diagnosed from scratch a fourth time. */
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const html = fs.readFileSync(
      path.join(__dirname, "..", "..", "public", "index.html"),
      "utf8",
    );
    const bodyRule = sliceBetween(html, "body {", "}");
    for (const property of ["transform", "filter", "perspective", "contain", "will-change"]) {
      expect([property, bodyRule.includes(property)]).toEqual([property, false]);
    }
    expect(APP).not.toContain("document.body.style");
  });
});
