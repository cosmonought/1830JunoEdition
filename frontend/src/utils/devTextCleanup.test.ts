/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTES 1119-1120 (harness): TEXT WRITTEN FOR WHOEVER RUNS THE BUILD
// ==================================================================
//
// ASKED FOR AS A TIDY-UP -- "remove residual developer text" -- and two of the four items turned out to be
// wrong rather than merely scruffy:
//
//   #1119a  "Mock state -- hotseat controls above" pointed at controls #578 had moved, and named a mode
//           ("hotseat") that #578 also removed. A label outliving BOTH things it referred to.
//   #1119b  "Offline -- REACT_APP_CONTRACT_ADDRESS" put a build variable in warning yellow, permanently, in
//           front of players who cannot act on it.
//   #1119c  "Initialize the session key above to enable these actions" named the ONE cause that cannot be
//           true in the sandbox, because `sessionReady` there is really `isMyTurn`.
//   #1120   The station picker had no readout, so the only way to see the current station was to open the
//           control that changes it.
//
// THE ASSERTIONS ARE ABOUT WHAT IS SAID, NOT ABOUT WHERE. A string test that pins a line number or a
// surrounding element breaks on the next layout change and proves nothing about the words -- so each case
// names the phrase that must be gone and, where something replaced it, the claim the replacement makes.

export {};

const { readStripped } = require("./sourceScan") as typeof import("./sourceScan");

const APP = readStripped("App.tsx");
const TOPBAR = readStripped("components/TopBar.tsx");
const BAR = readStripped("panels/ContextualActionBar.tsx");
const CONTROLS = readStripped("components/AudioControls.tsx");
const APP_STYLES = readStripped("styles/appStyles.ts");

describe("the shell stops narrating its own scaffolding", () => {
  it("drops the label that outlived the controls it pointed at", () => {
    /* BOTH HALVES ARE ASSERTED because both were stale independently: the sentence pointed "above" at a
       switcher that had moved into the sandbox toolbar, and "hotseat" named a mode #578 replaced with one
       browser per seat. Either alone would have made the line wrong. */
    expect(APP).not.toContain("Mock state");
    expect(APP).not.toContain("hotseat controls above");
    // The badge beside it stays -- it says the same fact and says it correctly.
    expect(APP).toContain("OFFLINE SANDBOX");
  });

  it("stops putting a build variable in front of a player", () => {
    /* THE VARIABLE NAME IS THE PART THAT HAD TO GO, not the offline state. `firstMissingEnvVar` still exists
       and still runs -- it feeds the label and the tooltip, where the person who can act on it will look. */
    expect(TOPBAR).not.toContain("styles.offlineBadge");
    expect(TOPBAR).toContain("styles.topBarDotOffline");
    // Still diagnosable: the whole message, including the variable, one hover away.
    expect(TOPBAR).toContain("title={`Offline — ${configError}`}");
  });

  it("keeps the offline state announced rather than only coloured", () => {
    /* #1078's LESSON, APPLIED BEFORE IT COULD BE RELEARNED: the badge carried its state as text and the dot
       carries it as a colour, which is nothing at all to a screen reader. The `aria-label` is what stops this
       being an accessibility regression dressed as a visual cleanup. */
    expect(TOPBAR).toContain("aria-label={`Offline —");
  });
});

describe("the action bar reports the reason that is actually stopping the click", () => {
  it("no longer tells a sandbox player to initialise a key that does not exist", () => {
    expect(BAR).not.toContain("Initialize the session key above to enable these actions.");
  });

  it("branches on the two causes that `sessionReady` had merged", () => {
    /* ==================================================================
        DESIGN NOTE 1119: THE BUG WAS THE CONFLATION, NOT THE WORDING
       ==================================================================
       `sessionReady` reaching this bar is `controlsEnabled && isMyTurn` -- design note #592d writes that down
       one screen away, and this hint was reading it as though it meant only the first half. In the offline
       sandbox `controlsEnabled` is permanently true, so the half it named was the half that could never fire.
       ASSERTED AS THE BRANCH rather than as either string, because a single message is the failure however
       well it is worded: whichever one you pick is wrong half the time. */
    expect(BAR).toContain("{isMyTurn");
    expect(BAR).toContain("Set up your session key to take actions.");
    expect(BAR).toContain("Waiting for ${activePlayerName");
  });

  it("names whoever the header names", () => {
    /* #891's SHAPE IS THE ONE THIS CODEBASE PRODUCES MOST -- two places working out the same fact and
       disagreeing. The hint reads the same `activePlayerName` the seat heading renders, so it cannot. */
    expect(BAR).toContain("activePlayerName ?? \"the other players\"");
  });
});

describe("the radio says which station it is playing", () => {
  it("resolves the name from the list rather than storing a second copy", () => {
    expect(CONTROLS).toContain("audio.stations?.find((station) => station.id === audio.stationId)?.name");
  });

  it("shows the station whether or not something is playing", () => {
    /* ==================================================================
        DESIGN NOTE 1127 SUPERSEDES #1120 ON VISIBILITY
       ==================================================================
       THIS CASE ASSERTED THE OPPOSITE ONE BATCH AGO, on the reasoning that "a name beside a dimmed button
       would be naming something silent". True, and the wrong trade: ruled here as "it should remain
       permanently visible, even when playback is stopped, to serve as an ambient feature flag". A radio
       nobody can see is a radio nobody turns on, and existing is the first job a control has.
       THE STATE DID NOT GO ANYWHERE. It moved from presence to tone -- `topBarStationNameOff` dims a stopped
       station to the same ink the disabled controls use -- and the button's own #1078 label still carries it
       to anything that is not an eye. Two facts, two elements: the name says WHICH, the button says WHETHER. */
    expect(CONTROLS).toContain("{currentStationName && (");
    expect(CONTROLS).not.toContain("{audio.musicPlaying && currentStationName && (");
    expect(CONTROLS).toContain("styles.topBarStationName");
    // Design note #1134: the state tone moved from the leaf to the drawer -- see the case below.
    expect(CONTROLS).toContain("styles.stationDrawer");
  });

  it("leaves the single-stream shell looking exactly as it did", () => {
    // `?? null` is what makes the label absent rather than empty when no stations are wired.
    expect(CONTROLS).toContain("?.name ?? null;");
  });
});

describe("the wake-on-press the notes described actually happens", () => {
  it("spends the constant that proved it was missing", () => {
    /* ==================================================================
        DESIGN NOTE 1106: A DECLARED CONSTANT NOBODY READ
       ==================================================================
       `WAKE_VOLUME` was defined, documented at length, and never referenced -- so the behaviour a playtest
       asked for ("the first press should turn it on AND open the slider") was recorded as done and was not
       done. `tsc` does not object to an unused module-level `const`, and no test asked.
       THIS IS THAT TEST. It is deliberately the crudest possible assertion -- the constant is READ somewhere
       -- because that is the exact thing that was false. */
    expect(CONTROLS.split("WAKE_VOLUME").length - 1).toBeGreaterThanOrEqual(3);
  });

  it("starts a stopped channel on the press that opens its panel", () => {
    expect(CONTROLS).toContain("if (!audio.musicPlaying) {");
    expect(CONTROLS).toContain("if (!audio.sfxEnabled) {");
  });

  it("treats the wake as a floor, so a chosen level survives", () => {
    /* ONLY ZERO IS OVERRIDDEN. A player who deliberately set the radio quiet and turned it off would
       otherwise have their choice discarded by the act of turning it back on. */
    expect(CONTROLS).toContain("if ((audio.radioVolume ?? 0) <= 0)");
    expect(CONTROLS).toContain("if ((audio.sfxVolume ?? 0) <= 0)");
  });

  it("leaves turning OFF to the popover's transport", () => {
    /* #1075's WHOLE ARGUMENT: the button opens, the transport stops. An asymmetric press that also toggled
       off would put two meanings back on one control and make the dim ambiguous again. */
    expect(CONTROLS).not.toContain("audio.musicPlaying ? audio.onToggleMusic()");
  });
});
