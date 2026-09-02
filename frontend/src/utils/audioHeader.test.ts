/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 1009 (harness): THE HEADER HALF
// ==================================================================
//
// `audio.test.ts` mounts the hooks and proves the sound behaves. This is the other half #1006 taught: a hook
// nobody calls passes every test it has, and neither `App.tsx` nor `TopBar` can be mounted in this repo.
//
// Asserted on text, and only for the things text can settle -- that the shell builds the controls from the
// hooks, that the header renders two INDEPENDENT toggles, and that the whistle reads the same `isMyTurn` the
// other two turn alerts do, which is the report's own wording and the reason all three agree.

export {};

const { readSource, readStripped, sliceBetween } =
  require("./sourceScan") as typeof import("./sourceScan");

const APP = readStripped("App.tsx");
const BAR = readStripped("components/TopBar.tsx");
/* Design note #1102: the audio buttons and their popovers moved out of `TopBar` into `AudioControls`,
   so the waiting room and the bar render the same control rather than two lookalikes. The assertions
   below are unchanged in substance -- they follow their subject to its new file. */
const CONTROLS = readStripped("components/AudioControls.tsx");
const POPOVER = readStripped("components/AudioControlPopover.tsx");
const AUDIO_RAW = readSource("utils/audio.ts");

describe("the shell owns the audio state", () => {
  it("fires the whistle off the same isMyTurn as the tab flash and the glow", () => {
    /* "THE EXACT SAME STATE THAT TRIGGERS THE VISUAL TAB ALERTS", from the report. Three notifications that
       each worked out whose turn it was would be three chances to disagree -- #891's shape, which this
       codebase produces more often than any other. */
    expect(APP).toContain("useDocumentTitleFlash(isMyTurn);");
    expect(APP).toContain("useTurnGlowActive(isMyTurn)");
    /* Design note #1075 ADDED A SECOND CONDITION, not a second source of truth. The whistle is now gated on
       the master switch AND the "Turn notification" category -- so the `enabled` argument grew while
       `isMyTurn` stayed the one answer all three notifications read. THAT is what this case is about, and
       pinning the complete argument list would have broken on a change that left the claim intact.
       The `isMyTurn,` fragment carries it: the whistle asks the same question the flash and the glow ask. */
    expect(APP).toContain("useTurnWhistle(isMyTurn,");
    // And the mute still reaches it, whatever else has been ANDed alongside.
    expect(APP).toContain("sfxEnabled && sfxTurnEnabled");
  });

  it("keeps the two channels on separate state", () => {
    // Two toggles, two pieces of state. A single `audioEnabled` would mute the whistle to stop the music.
    expect(APP).toContain("const [sfxEnabled, setSfxEnabled] = useState(true);");
    expect(APP).toContain("const radio = useRadioStream(RADIO_STREAM_URL);");
  });

  it("hands the controls to the header", () => {
    expect(APP).toContain("audio={audioControls}");
  });
});

describe("the header renders two independent toggles", () => {
  const GROUP = sliceBetween(CONTROLS, "styles.topBarAudioGroup", "</span>");

  it("is aimed at the audio group", () => {
    // The slice's own assumption -- #1008's harness learned this the hard way on a duplicated anchor.
    expect(GROUP).toContain("onToggleMusic");
    expect(GROUP).toContain("onToggleSfx");
  });

  it("gives each its own handler and its own lit state", () => {
    /* THE INDEPENDENCE, asserted as four distinct references rather than as "there are two buttons". A pair
       wired to one handler renders identically and fails only in a player's hands.

       Design note #1075 MOVED THE HANDLERS BEHIND A TERNARY -- the click now opens a panel when one is wired
       and falls back to the toggle when it is not -- so `onClick={audio.onToggleMusic}` is gone as a literal.
       THE CLAIM IS UNCHANGED and is what is asserted here: four distinct references, two per button, so the
       pair cannot be wired to one handler or one flag. The panel each opens is named separately for the same
       reason: `"radio"` and `"sfx"` are what stop the two buttons opening each other's popover. */
    expect(GROUP).toContain("audio.onToggleMusic()");
    expect(GROUP).toContain("audio.onToggleSfx()");
    expect(GROUP).toContain('current === "radio" ? null : "radio"');
    expect(GROUP).toContain('current === "sfx" ? null : "sfx"');
    expect(GROUP).toContain("audio.musicPlaying ? styles.topBarIconButtonOn");
    expect(GROUP).toContain("audio.sfxEnabled ? styles.topBarIconButtonOn");
  });

  it("says which state it is in to something other than the eye", () => {
    /* ==================================================================
        DESIGN NOTE 1078: THIS CASE FOUND A REAL REGRESSION, NOT A STALE ANCHOR
       ==================================================================
       IT READ `aria-pressed={audio.musicPlaying}`, and that WAS the whole disclosure while the buttons were
       toggles. #1075 made them disclosure controls, so `aria-pressed` gave way to `aria-expanded` -- which
       announces whether the PANEL is open, a different fact -- and the on/off state stopped being announced
       at all. #1074 had just finished making the dim legible to eyes; nobody else got it.
       THE ASSERTION IS THEREFORE ABOUT THE FACT, NOT THE ATTRIBUTE, which is what it should always have
       been: whatever a screen reader is handed for these buttons has to distinguish on from off. */
    expect(GROUP).toContain("audio.musicPlaying ? \"Radio settings\" : \"Radio settings");
    /* Design note #1102: this pinned the INDENTATION as well as the claim -- the markup moved out one nesting
       level with the component and the assertion broke on whitespace alone. Matched without the leading
       space now, so the next move does not cost a test edit for no change in meaning. */
    expect(GROUP.replace(/\s+/g, " ")).toContain('audio.sfxEnabled ? "Sound effect settings"');
    // Both states named, so the label is a readout rather than a constant that happens to mention audio.
    expect(GROUP).toContain("radio is off");
    expect(GROUP).toContain("sound effects are off");
    // And the disclosure state is still announced, since the click does open something.
    expect(GROUP).toContain("aria-expanded={audio.onRadioVolume ?");
    expect(GROUP).toContain("aria-expanded={audio.onSfxVolume ?");
  });

  it("keeps a real switch role on the control that is still a toggle", () => {
    /* Design note #1103: the boxed, worded Off row became a switch, and `aria-pressed` went with it --
       `role="switch"` plus `aria-checked` is the correct pairing for this shape, not a stand-in for the old
       attribute. Asserted in the popover rather than in the bar so the two never both claim to be the
       toggle -- #891's shape, which this codebase produces more often than any other. */
    expect(POPOVER).toContain('role="switch"');
    expect(POPOVER).toContain("aria-checked={enabled}");
    /* Design note #1104: the state channel is the GLYPH now, not a fill -- a stop square while playing, a
       play triangle while stopped. `aria-checked` above is unchanged and is what carries the same fact to
       assistive tech, which is the half #1078 cared about. */
    expect(POPOVER).toContain("{enabled ? (");
  });

  it("disappears rather than drawing dead buttons when no audio is wired", () => {
    /* Design note #1102: the guard survived the move to `AudioControls`, the parenthesis did not -- the bar
       now renders one element rather than a block. The CLAIM is unchanged: with no audio wired, nothing is
       drawn. */
    expect(BAR).toContain("{audio && <AudioControls");
  });
});

describe("the sources are the ones that were supplied", () => {
  it("references the whistle by public path", () => {
    /* NOT AN IMPORT. A bundled asset gets a content hash in its name; the file was placed in `public/` and
       named, so the path is the contract. */
    expect(AUDIO_RAW).toContain('export const WHISTLE_SRC = "/audio/whistle.mp3";');
  });

  it("uses the station that was given", () => {
    expect(AUDIO_RAW).toContain(
      'export const RADIO_STREAM_URL = "https://s3.radio.co/s39c195d74/listen";',
    );
  });
});
