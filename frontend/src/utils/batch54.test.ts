/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTES 1074-1077 (harness): THE MIX IS THE PLAYER'S, AND ONE PRESS IS ONE LINE
// ==================================================================
//
// FOUR CHANGES FROM ONE PLAYTEST READ, and three of them turn out to be the same shape: a control or a line
// that answered a question the player had not asked, in a way they could not adjust.
//
//  #1074  The SFX button would not dim, because its glyph was an emoji and an emoji ignores `color`.
//         The mix's two constants became DEFAULTS, and the duck depths became FRACTIONS of the live level.
//  #1075  The buttons stopped being toggles and became doors: a slider, an Off switch, and -- for the
//         effects -- which categories count as an effect.
//  #1076  The feed's three fields stopped reading as one string: a bold gutter, and the timestamp on request.
//  #1077  One button press writes one Activity Log line, even when it is two messages.
//
// THE ANCHOR RULE THIS FILE FOLLOWS: assert the rule, not the expression. My own recurring failure is pinning
// a complete argument list or a total count, which breaks the moment anything is added -- so counts here are
// DERIVED from the source and the string assertions are the smallest fragment that carries the claim.

export {};

const {
  DUCK_FOR_CUE,
  DUCK_FOR_VIDEO,
  RADIO_VOLUME,
  SFX_VOLUME,
  currentSfxVolume,
  currentRadioVolume,
  setSfxVolume,
  setRadioVolume,
} = require("./audio") as typeof import("./audio");
const { feedItemParts, feedItemText } =
  require("../components/TopTicker") as typeof import("../components/TopTicker");
const { readStripped, sliceBetween } = require("./sourceScan") as typeof import("./sourceScan");
import type { FeedItem } from "./feed";

const APP = readStripped("App.tsx");
const AUDIO = readStripped("utils/audio.ts");
const TOPBAR = readStripped("components/TopBar.tsx");
/* Design note #1102: the audio buttons and their popovers moved out of `TopBar` into `AudioControls`,
   so the waiting room and the bar render the same control rather than two lookalikes. The assertions
   below are unchanged in substance -- they follow their subject to its new file. */
const CONTROLS = readStripped("components/AudioControls.tsx");
const POPOVER = readStripped("components/AudioControlPopover.tsx");
const TICKER = readStripped("components/TopTicker.tsx");

/* ------------------------------------------------------------------ */
/* #1074 -- an emoji cannot be dimmed                                 */
/* ------------------------------------------------------------------ */

describe("both audio buttons dim the same way", () => {
  it("draws the speaker instead of typing it", () => {
    /* ==================================================================
        DESIGN NOTE 1074: THE CAUSE WAS THE GLYPH, NOT THE STYLE
       ==================================================================
       REPORTED: "when Radio is muted the button dims/grays out, when SFX is muted a barely perceptible slash
       mark goes through the icon. The dimming behavior is preferable."
       AND THE TWO BUTTONS ALREADY SHARED THEIR STYLES, which is what makes the assertion here about the SVG
       and not about a colour: `&#128266;` is an emoji, painted by the emoji font in its own colours, and CSS
       `color` does nothing to it. `&#9835;` is a text character and greys with the button.
       SO THE CLAIM IS "the speaker takes the button's colour", and `fill="currentColor"` is that claim. */
    expect(CONTROLS).toContain('fill="currentColor"');
    // The emoji that could not be dimmed is gone. Named as the numeric entity, which is how it was written.
    expect(TOPBAR).not.toContain("&#128266;");
    /* ==================================================================
        DESIGN NOTE 1134: THE NOTE IS DRAWN TOO NOW
       ==================================================================
       THIS CASE USED TO ASSERT `&#9835;` SURVIVED, "because it was never the problem, and it is the reference
       the speaker now matches." True of #1074's problem, which was an EMOJI ignoring `color` outright.
       IT WAS THE PROBLEM FOR A DIFFERENT ONE. A hairline character at 12px is thinned by antialiasing, so at
       the identical `#f2f0eb` it covers fewer pixels than a filled path and reads dimmer -- reported later as
       the two lit buttons not matching. The reference runs the other way now: both are drawn.
       THE CLAIM THIS CASE MAKES IS UNCHANGED -- whatever is inside these buttons has to take the button's
       colour -- so it is asserted as that, on both of them, rather than on either glyph. */
    expect(CONTROLS).not.toContain("&#9835;");
    expect(CONTROLS.split('fill="currentColor"').length - 1).toBeGreaterThanOrEqual(4);
  });

  it("keeps the lit style shared, so neither button can drift from the other", () => {
    /* THE ASYMMETRY WAS NEVER IN THE STYLES and this is what stops the next change putting it there: both
       buttons spread the SAME `topBarIconButtonOn` over the SAME base. Counted rather than pinned to a
       surrounding expression -- the count is derived from the source, not written down here. */
    // Design note #1102: both buttons moved to `AudioControls`; the count is the same claim in its new file.
    expect(CONTROLS.split("styles.topBarIconButtonOn").length - 1).toBeGreaterThanOrEqual(2);
  });
});

describe("the duck is a proportion, not a level", () => {
  it("multiplies the live radio level by the depth", () => {
    /* ==================================================================
        DESIGN NOTE 1074: THE BUG A SLIDER WOULD HAVE INTRODUCED
       ==================================================================
       The depths were `RADIO_VOLUME * 0.8` and `* 0.2`, computed once at module load. That was correct while
       the bed had one fixed level and silently wrong the moment a slider could move it: a player who turned
       the radio down to 0.1 would have had it DUCKED UP to 0.36 -- the ducking making the music LOUDER, on
       the settings of the very player who had asked for it quieter.
       THIS IS THE ASSERTION THAT WOULD HAVE CAUGHT IT: duck a bed set below the deep depth and require the
       result to be quieter than where it started. It does not mention `RADIO_VOLUME` at all, which is the
       point -- the old form passes every assertion that names only the constants. */
    setRadioVolume(0.1);
    const seen: number[] = [];
    const { registerDuckTarget, duckRadio } = require("./audio") as typeof import("./audio");
    registerDuckTarget({ setVolume: (value: number) => seen.push(value) });
    const release = duckRadio(DUCK_FOR_VIDEO);
    expect(seen[seen.length - 1]).toBeCloseTo(0.1 * DUCK_FOR_VIDEO);
    expect(seen[seen.length - 1]).toBeLessThan(0.1);
    release();
    registerDuckTarget(null);
    setRadioVolume(RADIO_VOLUME);
  });

  it("states the depths as bare fractions", () => {
    // Both under 1, or a "duck" would be a boost. The 80/20 split the report asked for is unchanged.
    expect(DUCK_FOR_CUE).toBeCloseTo(0.8);
    expect(DUCK_FOR_VIDEO).toBeCloseTo(0.2);
    expect(DUCK_FOR_CUE).toBeLessThan(1);
    expect(AUDIO).toContain("duckTarget?.setVolume(radioVolume * activeDuck);");
  });

  it("rests the multiplier at 1 rather than at the bed's level", () => {
    /* `activeDuck` IS A MULTIPLIER NOW, and a multiplier at rest is 1. Leaving it at `RADIO_VOLUME` would
       have made the first clip after a release duck to 0.45 * 0.45 -- a second duck nobody asked for. */
    expect(AUDIO).toContain("let activeDuck = 1;");
    expect(AUDIO).toContain("activeDuck = 1;");
  });
});

/* ------------------------------------------------------------------ */
/* #1074 -- the constants become defaults                             */
/* ------------------------------------------------------------------ */

describe("the mix is a starting point the player can leave", () => {
  it("seeds the mutable level from the balanced constant", () => {
    /* #1013's BALANCE SURVIVES AS THE DEFAULT. Renaming the constants to `DEFAULT_*` was the tempting edit
       and would have broken every suite that reads the mix for no gain -- so the claim is that the live
       values START where the balance put them. */
    setSfxVolume(SFX_VOLUME);
    setRadioVolume(RADIO_VOLUME);
    expect(currentSfxVolume()).toBe(SFX_VOLUME);
    expect(currentRadioVolume()).toBe(RADIO_VOLUME);
  });

  it("clamps whatever the slider sends", () => {
    /* THE SLIDER IS NOT THE ONLY CALLER -- a restored setting or a future keyboard shortcut could send
       anything, and `HTMLMediaElement.volume` THROWS on a value outside 0..1 rather than clamping. */
    setSfxVolume(4);
    expect(currentSfxVolume()).toBe(1);
    setSfxVolume(-2);
    expect(currentSfxVolume()).toBe(0);
    setSfxVolume(Number.NaN);
    expect(currentSfxVolume()).toBe(0);
    setSfxVolume(SFX_VOLUME);
  });

  it("reaches the live stream, not just the next one", () => {
    /* THE STREAM IS ALREADY PLAYING when the slider moves. Setting a variable alone would leave the player
       dragging a control that does nothing until they stop and restart the radio. */
    const { registerDuckTarget } = require("./audio") as typeof import("./audio");
    const seen: number[] = [];
    registerDuckTarget({ setVolume: (value: number) => seen.push(value) });
    setRadioVolume(0.33);
    expect(seen[seen.length - 1]).toBeCloseTo(0.33);
    registerDuckTarget(null);
    setRadioVolume(RADIO_VOLUME);
  });

  it("does not fight the ducking for the element", () => {
    /* THE ONE ORDERING BUG IN THIS PAIR. A slider moved DURING a cue must not undo the duck -- the write
       through to the element is gated on nothing being ducked, and the stored level is what the fade
       returns to. */
    const guard = sliceBetween(AUDIO, "export function setRadioVolume(", "}\n");
    expect(guard).toContain("if (duckDepth === 0)");
    expect(guard.length).toBeLessThan(600);
  });

  it("plays the elements at the live level rather than the constant", () => {
    // Reading the constants on the elements would pin them to the defaults forever -- the slider's own bug.
    expect(AUDIO).toContain("element.volume = sfxVolume;");
    expect(AUDIO).toContain("element.volume = radioVolume;");
  });
});

/* ------------------------------------------------------------------ */
/* #1075 -- the button becomes a door                                 */
/* ------------------------------------------------------------------ */

describe("the audio button opens a panel instead of toggling", () => {
  it("holds one open panel, named rather than paired booleans", () => {
    /* TWO FLAGS CAN BOTH BE TRUE and would render two popovers from the same corner of the bar. */
    expect(CONTROLS).toContain('React.useState<"radio" | "sfx" | null>(null)');
  });

  it("keeps the dim as a state readout and the click as an action", () => {
    /* THE CONFLICT THE REPORT SPOTTED IN ITS OWN ASKING: a control cannot both toggle and disclose. Off
       moved inside the panel, which leaves the button with one job and the dim with one meaning. */
    expect(CONTROLS).toContain('setOpenPanel((current) => (current === "radio" ? null : "radio"))');
    expect(CONTROLS).toContain('setOpenPanel((current) => (current === "sfx" ? null : "sfx"))');
  });

  it("falls back to a plain toggle when no volume is wired", () => {
    /* OPTIONAL PROPS, so a shell that wires only the two flags still renders working buttons rather than
       doors onto an empty room. */
    expect(CONTROLS).toContain("audio.onToggleMusic()");
    expect(CONTROLS).toContain("audio.onToggleSfx()");
  });

  it("gives the effects panel its categories and the radio panel none", () => {
    /* THE ASYMMETRY IS THE FEATURE. "Which effects play" is a question only the effects channel has. */
    const sfxPanel = sliceBetween(CONTROLS, 'title="Sound effects"', "/>");
    expect(sfxPanel).toContain("categories={audio.sfxCategories}");
    const radioPanel = sliceBetween(CONTROLS, 'title="Radio"', "/>");
    expect(radioPanel).not.toContain("categories=");
    expect(radioPanel.length).toBeLessThan(600);
  });
});

describe("the popover closes easily, unlike the modals", () => {
  it("takes Escape and a click outside", () => {
    /* #1052 REMOVED BOTH FROM THE PAYOUT MODAL and the reasoning does not transfer: there an accidental
       dismissal cost the player the whole event. Here every setting applies the instant it changes, so
       there is nothing to lose by closing. */
    expect(POPOVER).toContain('if (event.key === "Escape") onClose();');
    expect(POPOVER).toContain('window.addEventListener("mousedown", onDown);');
  });

  it("listens on mousedown rather than click", () => {
    /* A DRAG THAT STARTS ON THE SLIDER AND ENDS OUTSIDE IT is exactly how a volume slider gets used, and
       on `click` that gesture would close the panel mid-drag. */
    expect(POPOVER).not.toContain('window.addEventListener("click", onDown);');
  });

  it("removes both listeners on unmount", () => {
    // A panel that closes leaves nothing behind: a stale `onClose` firing on a later click is a ghost.
    expect(POPOVER).toContain('window.removeEventListener("keydown", onKey);');
    expect(POPOVER).toContain('window.removeEventListener("mousedown", onDown);');
  });

  it("disables the slider when the channel is off rather than hiding it", () => {
    /* A SLIDER THAT VANISHES changes the panel's height under the cursor, and the level a player set is
       worth showing them even while the channel is silent -- turning it back on returns to where they left
       it rather than to a default. */
    expect(POPOVER).toContain("disabled={!enabled}");
    expect(POPOVER).not.toContain("{enabled && (");
  });

  it("greys the categories with the channel above them", () => {
    // They are a subdivision of the master, so offering choices that cannot take effect would be a lie.
    expect(POPOVER).toContain("styles.categoryRowMuted");
    expect(POPOVER).toContain("disabled={!enabled}");
  });

  it("says on and off with a shape rather than a colour", () => {
    /* ==================================================================
        DESIGN NOTE 1104 REPLACES THIS CASE, WHICH PINNED THE THING THAT WAS WRONG
       ==================================================================
       IT ASSERTED green-for-on and red-for-off. REPORTED since: "I find the green/red toggle unintuitive
       for the On/Off audio" -- and the complaint is sound, because that pair has to be LEARNED. Nothing
       about red says "press me to start", and #1103's defence of it (position is a second signal) barely
       holds on a 34px track whose thumb moves a few pixels.
       SO THE ASSERTION IS NOW ABOUT THE SHAPE. Play and stop are the transport glyphs every media player
       has taught, and they say what the CLICK DOES rather than what the state is.
       DRAWN, NOT TYPED, for #1074's reason -- the entity forms render as emoji on several platforms and
       ignore `color`, which is the exact defect that note fixed on the speaker.
       THE SEMANTICS DID NOT MOVE: `role="switch"` and `aria-checked` stay, because for assistive tech this
       is still a two-state control and #1078's rule is that state must reach it. Only the visible channel
       changed, which is what the report was about. */
    expect(POPOVER).toContain('<rect x="2" y="2" width="8" height="8" rx="1" fill="currentColor" />');
    expect(POPOVER).toContain('<path d="M3.5 2.2 10 6 3.5 9.8 Z" fill="currentColor" />');
    expect(POPOVER).toContain('role="switch"');
    /* The colour pair is GONE rather than merely unused -- a semantic fill left behind on a control that no
       longer signals with colour is the next person's confusion. */
    expect(POPOVER).not.toContain("ACTION_GREEN");
    expect(POPOVER).not.toContain("ALERT_CRITICAL_INK");
  });
});

describe("the three effect categories gate their own cues", () => {
  it("ANDs each category with the master rather than replacing it", () => {
    /* THE MASTER STILL WINS. `playVariantCue` takes one boolean, so every call site passes its own category
       ANDed with the master switch -- turning all effects off must not be overridden by a category left on. */
    expect(APP).toContain("sfxEnabledRef.current && sfxRevenueRef.current");
    expect(APP).toContain("sfxEnabledRef.current && sfxPayoutRef.current");
        /* Design note #1116 ADDED A THIRD CONDITION, not a third source of truth: the whistle is now also
       gated on the opening titles not running, so the "your turn" cue does not fire over the cinematic that
       the very same event starts. The CLAIM this case makes is the AND -- the master switch and the
       category both still reach the whistle -- so it is asserted as the fragment they share rather than as
       the complete expression, which is the anchor rule this file's own header states. */
    /* ==================================================================
        DESIGN NOTE 1143: WHITESPACE AGAIN, AND THE CLAIM IS STILL THE `AND`
       ==================================================================
       #1116 ADDED `!introPlaying` AND THIS CASE WIDENED TO A FRAGMENT to accommodate it. #1143 added a THIRD
       argument -- a suppressor evaluated when the edge fires, because the boolean above is one render late --
       and the call went multi-line, so a fragment spanning the argument list broke on formatting.
       MATCHED ON THE WHITESPACE-COLLAPSED FORM. The claim has never changed: the master switch and the
       category BOTH reach the whistle, ANDed rather than one replacing the other. Collapsing runs of space
       is what lets that be asserted without also asserting how prettier chose to wrap the call. */
    const flat = APP.replace(/\s+/g, " ");
    expect(flat).toContain("useTurnWhistle( isMyTurn, sfxEnabled && sfxTurnEnabled && !introPlaying,");
  });

  it("reads the categories through refs at the cue sites", () => {
    /* #967a's REASON, again. The cue sites live inside `runGameplayAction`, a long-lived `useCallback`: a
       closure read there answers with whatever the settings were when the callback was built. */
    expect(APP).toContain("sfxRevenueRef.current = sfxRevenueEnabled;");
    expect(APP).toContain("sfxPayoutRef.current = sfxPayoutEnabled;");
  });

  it("gives every category a hint, because the names are ours", () => {
    /* "Revenue events" IS OUR VOCABULARY. A player who has not read the variant's rules cannot tell what it
       covers, so each toggle carries a sentence naming the sound it silences. Derived rather than counted:
       every `key:` in the category list must be accompanied by a `hint:`. */
    const list = sliceBetween(APP, "sfxCategories: [", "],");
    const keys = list.split("key:").length - 1;
    const hints = list.split("hint:").length - 1;
    const labels = list.split("label:").length - 1;
    expect(keys).toBeGreaterThanOrEqual(3);
    expect(hints).toBe(keys);
    expect(labels).toBe(keys);
  });

  it("writes the slider through to the engine as well as into React state", () => {
    /* TWO HOLDERS, ONE VALUE, and the reason is that neither can serve both: the engine holds what the
       elements play at and is reached from three non-components; React holds what the slider draws. */
    const sfx = sliceBetween(APP, "const handleSfxVolume = useCallback(", "}, []);");
    expect(sfx).toContain("setSfxVolumeState(value)");
    expect(sfx).toContain("setSfxVolume(value)");
    expect(sfx.length).toBeLessThan(400);
  });
});

/* ------------------------------------------------------------------ */
/* #1076 -- the feed's three fields stop reading as one string        */
/* ------------------------------------------------------------------ */

const logItem = (over: Partial<FeedItem> = {}): FeedItem => ({
  id: "1",
  kind: "log",
  seq: 1,
  timestampMs: 1,
  timestampLabel: "14:32:07",
  logLabel: "B&O bought a 3-train",
  logDetail: "",
  logStatus: "success",
  logRound: "OR 1.1",
  ...over,
});

describe("the gutter carries the round and gives its place to the time", () => {
  it("bolds the round tag by default", () => {
    /* REPORTED: "[time] [round] [information] all read as one long string ... bold the [round] information."
       THE GUTTER IS THE COLUMN A READER SCANS, so the useful field takes it. */
    expect(feedItemParts(logItem()).gutter).toBe("[OR 1.1]");
    expect(feedItemParts(logItem()).body).toContain("B&O bought a 3-train");
  });

  it("swaps the tag for the time when the reader asks", () => {
    /* REPORTED: "I click the log event and the timestamp appears where it currently is at the left."
       REPLACES rather than joins -- the time goes where the tag is, which is the column being asked for. */
    expect(feedItemParts(logItem(), true).gutter).toBe("[14:32]");
  });

  it("falls back to the time when an entry has no round", () => {
    // A round-less entry with an empty gutter would break #477's column, which is the format's whole point.
    expect(feedItemParts(logItem({ logRound: undefined }), false).gutter).toBe("[14:32]");
  });

  it("gives a chat line its clock, always", () => {
    // Chat has no round tag, and the two kinds interleave in one feed.
    const chat = logItem({ kind: "chat", chatAuthor: "P1", chatText: "hello" });
    expect(feedItemParts(chat).gutter).toBe("[14:32]");
    expect(feedItemParts(chat).body).toBe("P1: hello");
  });

  it("keeps the one-string form rather than replacing it", () => {
    /* `feedItemText` IS STILL THE TICKER'S CLIPPED PREVIEW and what a dozen suites assert against, so the
       parts are an ADDITION. Both are derived from the same fields, which is what stops the two surfaces
       describing one entry differently -- #694's rule, and the bug #1055 fixed. */
    expect(typeof feedItemText(logItem())).toBe("string");
    expect(feedItemText(logItem())).toContain("[OR 1.1]");
  });

  it("carries the failure marker in the body, not the gutter", () => {
    // The gutter is a fixed-width column. A variable-length "Failed: " in it would destroy the alignment.
    expect(feedItemParts(logItem({ logStatus: "error" })).body).toContain("Failed: ");
    expect(feedItemParts(logItem({ logStatus: "error" })).gutter).toBe("[OR 1.1]");
  });

  it("makes the row reachable from the keyboard, since a click now does something", () => {
    /* A DIV THAT RESPONDS TO A CLICK AND NOTHING ELSE is unreachable for anyone not using a mouse. */
    expect(TICKER).toContain('role="button"');
    expect(TICKER).toContain('event.key === "Enter"');
    expect(TICKER).toContain('event.key === " "');
  });

  it("draws the gutter heavier than the sentence", () => {
    // The bold IS the request. Both surfaces, because #694's rule is that they compose from one answer.
    expect(TICKER).toContain("fontWeight: 800");
    expect(TICKER.split("fontWeight: 800").length - 1).toBeGreaterThanOrEqual(2);
  });
});

/* ------------------------------------------------------------------ */
/* #1077 -- one button press, one line                                */
/* ------------------------------------------------------------------ */

describe("a multi-train buy writes one line", () => {
  it("silences the per-message entries only when a summary is coming", () => {
    /* REPORTED: "B&O used the selector to buy two trains at once. The Activity Log printed this one at a
       time ... if a player buys three trains one at a time, there should be three prints, but if they buy
       three trains at once, one print."
       THE MESSAGES STAY TWO. `BuyHardwareFromPool` carries no quantity, so buying two genuinely IS two
       dispatches; collapsing them would be a contract change for a display problem. The flag is conditional
       on `times > 1` because a single purchase has no summary to be covered by. */
    const loop = sliceBetween(APP, "for (let i = 0; i < times; i += 1) {", "}\n");
    expect(loop).toContain("times > 1 ? { silentInLog: true } : undefined");
    expect(loop.length).toBeLessThan(900);
  });

  it("still speaks when a dispatch was refused", () => {
    /* THE ONE CASE THE SUMMARY CANNOT COVER. It quotes a price, a treasury transition and a depot count,
       and every one of those assumes the purchase landed -- so a refusal has to keep its own line or #778's
       whole point ("the log says whether it happened") goes back to the bug it was written against. */
    expect(APP).toContain("if (!options?.silentInLog || refusalWasRefused) {");
  });

  it("does not borrow the derived flag to do it", () => {
    /* `derived` MEANS "the game dispatched this, not the player" (#668) and it GOVERNS UNDO'S REACH.
       Reusing it to quieten a line would make Undo step past a real purchase -- which is why this is a
       separate flag rather than the one that was already there. */
    const loop = sliceBetween(APP, "for (let i = 0; i < times; i += 1) {", "}\n");
    expect(loop).not.toContain("derived: true");
  });

  it("leaves the toast alone", () => {
    /* THE DEPOT COUNT IS A GLANCE AT A NUMBER GOING DOWN and a batch of two should still produce it. The
       suppression is scoped to the log append, so the toast path is untouched. */
    const gate = sliceBetween(APP, "if (!options?.silentInLog || refusalWasRefused) {", "...log,");
    expect(gate).not.toContain("showActionToast");
    expect(gate).toContain("setActionLog((log) => [");
  });

  it("says the price and the treasury transition the report asked for", () => {
    /* THE SUMMARY IS THE LINE NOW, so it has to carry what the suppressed ones did: "for $80 each", and the
       treasury movement every other action line has carried since #1053. */
    const summary = sliceBetween(APP, "if (times > 1 && before) {", "logInfo(");
    expect(summary).toContain("beforeTreasury");
    expect(APP).toContain("bought ${countPhrase(times, `${tier}-train`)} for $${before.cost} each.");
    expect(APP).toContain("Remaining depot supply: ${remaining}.");
  });

  it("reads the treasury before the loop, not after it", () => {
    /* THE ORDERING BUG THIS AVOIDS: by the time the summary runs the state has already moved, so a "before"
       read there would report the purchase's own result as its starting point and the transition would be
       `$720 → $720`. */
    const handler = sliceBetween(APP, "const handleBuyTrainsFromBank = useCallback(", "for (let i = 0");
    expect(handler).toContain("const beforeTreasury = gameState?.public_companies.find(");
    expect(handler.length).toBeLessThan(2500);
  });

  it("drops the aggregate's category, since there is nothing left to distinguish it from", () => {
    /* #262's "Trains Bought" PREFIX existed to separate the summary from the per-message lines under it.
       With one line the category is a label on a set of one, and the round stamp already files it. */
    const summary = sliceBetween(APP, "if (times > 1 && before) {", "logInfo(");
    expect(summary).not.toContain('"Trains Bought"');
    expect(APP).not.toContain('logInfo("Trains Bought"');
  });
});
