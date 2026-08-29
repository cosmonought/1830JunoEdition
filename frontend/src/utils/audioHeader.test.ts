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
const AUDIO_RAW = readSource("utils/audio.ts");

describe("the shell owns the audio state", () => {
  it("fires the whistle off the same isMyTurn as the tab flash and the glow", () => {
    /* "THE EXACT SAME STATE THAT TRIGGERS THE VISUAL TAB ALERTS", from the report. Three notifications that
       each worked out whose turn it was would be three chances to disagree -- #891's shape, which this
       codebase produces more often than any other. */
    expect(APP).toContain("useDocumentTitleFlash(isMyTurn);");
    expect(APP).toContain("useTurnGlowActive(isMyTurn)");
    expect(APP).toContain("useTurnWhistle(isMyTurn, sfxEnabled);");
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
  const GROUP = sliceBetween(BAR, "styles.topBarAudioGroup", "</span>");

  it("is aimed at the audio group", () => {
    // The slice's own assumption -- #1008's harness learned this the hard way on a duplicated anchor.
    expect(GROUP).toContain("onToggleMusic");
    expect(GROUP).toContain("onToggleSfx");
  });

  it("gives each its own handler and its own lit state", () => {
    /* THE INDEPENDENCE, asserted as four distinct references rather than as "there are two buttons". A pair
       wired to one handler renders identically and fails only in a player's hands. */
    expect(GROUP).toContain("onClick={audio.onToggleMusic}");
    expect(GROUP).toContain("onClick={audio.onToggleSfx}");
    expect(GROUP).toContain("audio.musicPlaying ? styles.topBarIconButtonOn");
    expect(GROUP).toContain("audio.sfxEnabled ? styles.topBarIconButtonOn");
  });

  it("says which state it is in to something other than the eye", () => {
    // The lit treatment is a colour; `aria-pressed` is the same fact for anybody not reading it.
    expect(GROUP).toContain("aria-pressed={audio.musicPlaying}");
    expect(GROUP).toContain("aria-pressed={audio.sfxEnabled}");
  });

  it("disappears rather than drawing dead buttons when no audio is wired", () => {
    expect(BAR).toContain("{audio && (");
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
