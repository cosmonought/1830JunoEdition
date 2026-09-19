/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 1447 (harness): THREE EDITIONS OF ONE GAME
// ==================================================================
//
// THE STEP IS A GALLERY NOW. The host's first screen offered three text boxes; it offers three cards carrying
// the title artwork, because "which game" is a choice between editions and the editions look different.
//
// WHAT THIS FILE DEFENDS, in order of how quietly each would break:
//
//   1. THE NORMALISATION LIVES IN THE FILES. The three derivatives share one canvas and were built with the
//      `8` of 18XX measured to one height, so `contain` in an identical well is the whole presentation rule.
//      A per-logo `scale()` or `translateY()` in the stylesheet would work today and drift the first time the
//      artwork is redrawn, so the absence of one is asserted.
//   2. THE ARTWORK IS NOT THE TITLE. Each card states its game in text; the images are `alt=""`. Naming the
//      game in `alt` as well would make a screen reader say it twice, which is the usual way this is got wrong.
//   3. THE CHOICE IS STILL ONE CHOICE. `role="radiogroup"` -> `role="radio"` + `aria-checked`, one handler,
//      one `GAME_TYPE_ORDER`. The values behind the three cards are the ones that were there before.
//   4. THE WHOLE CARD IS THE CONTROL, and it takes a visible ring when a keyboard reaches it -- which the
//      text boxes did NOT: the step shipped with no focus style at all until this pass.

export {};

const fs = require("fs") as typeof import("fs");
const path = require("path") as typeof import("path");
const { readStripped, readSource, sliceBetween } = require("./sourceScan") as typeof import("./sourceScan");

const HOST = readStripped("components/HostSetupCard.tsx");
const HOST_RAW = readSource("components/HostSetupCard.tsx");
const PUBLIC_DIR = path.join(__dirname, "..", "..", "public");
const SOURCE_ART_DIR = path.join(__dirname, "..", "..", "..", "docs", "ai_architecture", "source_assets", "title_art");

const { GAME_TYPE_ART, HOST_TYPE_BLURB } =
  require("../components/HostSetupCard") as typeof import("../components/HostSetupCard");
const { GAME_TYPE_COPY, GAME_TYPE_ORDER } =
  require("../gameEngine/gameVariants") as typeof import("../gameEngine/gameVariants");

/** The width and height a JPEG declares in its first SOF marker. Twenty lines beats a dependency, and the
 *  claim -- "one canvas, three files" -- is only worth making against the bytes that ship. */
function jpegSize(file: string): { width: number; height: number } {
  const b = fs.readFileSync(file);
  let i = 2; // skip SOI
  while (i < b.length) {
    if (b[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = b[i + 1];
    const len = b.readUInt16BE(i + 2);
    // SOF0..SOF15, excluding the four that are not frame headers
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  throw new Error(`no SOF marker in ${file}`);
}

describe("the game-selection step ships one canvas for three logos (design note #1447)", () => {
  it("names artwork for every game the order offers, and no two the same", () => {
    expect(GAME_TYPE_ORDER.length).toBeGreaterThan(0);
    for (const type of GAME_TYPE_ORDER) {
      expect([type, typeof GAME_TYPE_ART[type]]).toEqual([type, "string"]);
      expect([type, GAME_TYPE_ART[type].endsWith(".jpg")]).toEqual([type, true]);
    }
    const files = GAME_TYPE_ORDER.map((t) => GAME_TYPE_ART[t]);
    expect(new Set(files).size).toBe(files.length);
  });

  it("ships all three, on ONE canvas, small enough to sit in a dialog", () => {
    /* THE SHARED CANVAS IS THE NORMALISATION. Three files of the same pixel size, drawn into one well with
       `contain`, render at one scale by arithmetic -- there is nothing left for a stylesheet to correct. If a
       replacement logo arrives at a different size this case fails, which is the moment to re-run the
       normalisation rather than to nudge a transform. */
    const sizes = GAME_TYPE_ORDER.map((t) => {
      const p = path.join(PUBLIC_DIR, "images", GAME_TYPE_ART[t]);
      expect([GAME_TYPE_ART[t], fs.existsSync(p)]).toEqual([GAME_TYPE_ART[t], true]);
      expect(fs.statSync(p).size).toBeLessThan(320 * 1024);
      return jpegSize(p);
    });
    for (const size of sizes) expect(size).toEqual(sizes[0]);
    // 4:3, which is the well's aspect: the art fills the well edge to edge at desktop widths.
    expect(sizes[0].width * 3).toBe(sizes[0].height * 4);
  });

  it("keeps the originals, and keeps the two that are only sources OUT of the deploy", () => {
    /* ==================================================================
        DESIGN NOTE 1447a: `public/` IS THE DEPLOY, NOT A CUPBOARD
       ==================================================================
       Create React App copies `frontend/public` verbatim into the build, so a file there ships whether or not
       anything references it. `18xxPlus.png` and `18xx_LPF.png` were 1,410,835 and 1,463,459 bytes referenced
       by nothing at runtime -- 2,874,294 bytes of deploy the browser never asked for. They are build inputs
       and now live with the note that explains how to use them.
       ASSERTED IN BOTH DIRECTIONS, because only one of them catches the regression that matters: a source
       original dropped back into `public/images` fails here rather than quietly adding a megabyte.
       `title-project18xx.jpg` STAYS, and not for symmetry: `Lobby.tsx` fetches it. It is a source for
       `game-18xx.jpg` AND a runtime asset, which is why the generator reads that one from `public/`. */
    for (const source of ["18xxPlus.png", "18xx_LPF.png"]) {
      expect([source, fs.existsSync(path.join(SOURCE_ART_DIR, source))]).toEqual([source, true]);
      expect([source, fs.existsSync(path.join(PUBLIC_DIR, "images", source))]).toEqual([source, false]);
    }
    const lobby = readStripped("components/Lobby.tsx");
    expect(lobby).toContain("/images/title-project18xx.jpg");
    expect(fs.existsSync(path.join(PUBLIC_DIR, "images", "title-project18xx.jpg"))).toBe(true);
    expect(Object.values(GAME_TYPE_ART)).not.toContain("title-project18xx.jpg");
  });

  it("ships no raster source in the image folder at all", () => {
    /* The general form of the case above: the deployed image folder holds runtime assets, and a runtime image
       for this UI does not need a megabyte. The two that were there were 4.6x the largest thing left. */
    const dir = path.join(PUBLIC_DIR, "images");
    for (const name of fs.readdirSync(dir)) {
      const bytes = fs.statSync(path.join(dir, name)).size;
      expect([name, bytes < 400 * 1024]).toEqual([name, true]);
    }
  });
});

describe("the presentation is a well and a fit, not a table of nudges (design note #1447)", () => {
  const gallery = sliceBetween(HOST, '<Section title="Game">', "</Section>");

  it("gives every card the same well and fits the art inside it", () => {
    expect(HOST).toContain('aspectRatio: "4 / 3"');
    expect(HOST).toContain('objectFit: "contain"');
    expect(HOST).toContain('backgroundColor: "#000000"');
    // One style object for all three images -- there is no per-logo branch to fall out of step.
    expect(gallery).toContain("...styles.typeArt");
    expect((gallery.match(/styles\.typeWell/g) ?? []).length).toBe(1);
    expect((gallery.match(/styles\.typeArt(?![A-Za-z])/g) ?? []).length).toBe(1);
  });

  it("carries no per-logo scale or offset", () => {
    /* The claim of #1447: the three logos were normalised in the FILES. Any of these appearing here would
       mean that stopped being true and nobody noticed. */
    const styles = sliceBetween(HOST, "const styles: Record<string, React.CSSProperties> = {", "\n};");
    for (const smell of ["transform:", "translateY", "scale(", "objectPosition", "marginTop: \"-"]) {
      expect([smell, styles.includes(smell)]).toEqual([smell, false]);
    }
  });

  it("chooses nothing by measuring the page", () => {
    for (const api of ["getBoundingClientRect", "matchMedia", "ResizeObserver", "window.innerWidth"]) {
      expect([api, HOST.includes(api)]).toEqual([api, false]);
    }
  });

  it("keeps the stylesheet closeable", () => {
    /* Four builds have been lost to a backtick inside a CSS template literal. The literal ends at the first
       one, and the error lands on a line that looks fine. */
    const OPEN = "const HOST_SETUP_CSS = " + String.fromCharCode(96);
    const body = sliceBetween(HOST_RAW, OPEN, String.fromCharCode(96) + ";").slice(OPEN.length);
    expect(body.length).toBeGreaterThan(20);
    expect(body).not.toContain(String.fromCharCode(96));
  });
});

describe("the artwork does not become the title (design note #1447)", () => {
  it("states every game in text, and leaves the images decorative", () => {
    for (const type of GAME_TYPE_ORDER) {
      expect([type, typeof GAME_TYPE_COPY[type].label]).toEqual([type, "string"]);
      expect([type, GAME_TYPE_COPY[type].label.length]).not.toEqual([type, 0]);
    }
    expect(HOST).toContain("{GAME_TYPE_COPY[candidate].label}");
    expect(HOST).toContain('alt=""');
    // An `alt` that named the game would be read out beside the label, which is the name twice.
    expect(HOST).not.toContain("alt={");
  });

  it("uses the player-facing Level Playing Field title and leaves the internals alone", () => {
    expect(GAME_TYPE_COPY.levelPlayingField.label).toBe("18XX+: A Level Playing Field");
    expect(GAME_TYPE_ORDER).toContain("levelPlayingField");
    expect(GAME_TYPE_ART.levelPlayingField).toContain("lpf");
  });

  it("falls back to the text box this step used before, rather than an empty black rectangle", () => {
    expect(HOST).toContain("artFailed[candidate] !== true");
    expect(HOST).toContain("onError={() =>");
  });
});

describe("the choice is still one choice (design note #1447)", () => {
  const gallery = sliceBetween(HOST, '<Section title="Game">', "</Section>");

  it("groups the radios it always should have", () => {
    /* NOT A REDESIGN OF THE SEMANTICS -- a repair. The three boxes carried `role="radio"` with no
       `role="radiogroup"` around them, so assistive technology was told each was a radio and never told what
       set it belonged to or how many there were.
       Design note #1448: `role`, `aria-checked`, `tabIndex` and the click handler now arrive together from
       `useRadioGroup`, the one definition all three groups share -- so this case no longer looks for the
       four attributes spelled out here, which would be the old bug in a new form (three hand-written copies
       that can disagree). It asserts the group's own markup and that the options come from the hook;
       `hostRadioGroups.test.tsx` renders the result and checks what the attributes actually ARE. */
    expect(gallery).toContain('role="radiogroup"');
    expect(gallery).toContain('aria-label="Game"');
    expect(gallery).toContain("ref={gameRadio.ref}");
    expect(gallery).toContain("onKeyDown={gameRadio.onKeyDown}");
    expect(gallery).toContain("{...gameRadio.optionProps(candidate)}");
    expect(gallery).toContain("const selected = candidate === type;");
    const hook = sliceBetween(HOST, "function useRadioGroup<T extends string>", "\n}\n");
    expect(hook).toContain('role: "radio" as const');
    expect(hook).toContain('"aria-checked": key === value');
    expect(hook).toContain("tabIndex: key === value ? 0 : -1");
  });

  it("selects the same values it selected before", () => {
    /* The card changed; what pressing it means did not. One handler, the same ordered table, and the same
       hand-off to the house-rules step. */
    /* #1448: the handler moved into the hook, so the claim moves with it -- ONE place that sets the type,
       reading the same ordered table. */
    expect(HOST).toContain("useRadioGroup(GAME_TYPE_ORDER, type, setType)");
    expect((HOST.match(/setType/g) ?? []).length).toBe(2); // the state hook, and the one handed to the group
    expect(gallery).toContain("GAME_TYPE_ORDER.map((candidate)");
    expect(HOST).toContain("recommendedVariantsFor(type, mode)");
    expect(HOST).toContain('data-testid={`host-type-${candidate}`}');
    expect(HOST).toContain('data-testid="host-continue"');
    for (const type of GAME_TYPE_ORDER) {
      expect([type, typeof HOST_TYPE_BLURB[type]]).toEqual([type, "string"]);
    }
    expect(HOST_TYPE_BLURB.standard).toBe("The classic game.");
  });

  it("says Game, not Game type", () => {
    /* Display language only -- `GameType`, `GAME_TYPE_ORDER`, `GAME_TYPE_COPY`, `GAME_TYPE_ART` and the
       `host-type-*` test ids are untouched, and the three choices are the same three. */
    expect(HOST).toContain('<Section title="Game">');
    expect(HOST).not.toContain("Game type");
    expect(GAME_TYPE_ORDER.map((t) => GAME_TYPE_COPY[t].label))
      .toEqual(["18XX", "18XX+", "18XX+: A Level Playing Field"]);
    expect(HOST).toContain('data-testid={`host-type-${candidate}`}');
  });

  it("gives Pace and Visibility the ring the cards get", () => {
    /* #1447a: the step shipped with no focus style on ANY of its three groups. The cards got one; a keyboard
       user reaching Pace still had nothing to see. One rule, three groups -- so the next control added here
       is a class away from being reachable rather than a second copy of the declaration. */
    expect(HOST_RAW).toContain(".host-segment:focus-visible");
    const rule = sliceBetween(HOST_RAW, ".host-type-card:focus-visible", "}");
    expect(rule).toContain(".host-segment:focus-visible");
    expect(rule).toContain("outline: 2px solid #8a8a86");
    expect(rule).toContain("outline-offset: 2px");
    // :focus-visible, not :focus -- a pointer click must not leave a ring behind.
    expect(HOST_RAW).not.toContain(".host-segment:focus {");
    expect(HOST_RAW).not.toContain(".host-type-card:focus {");
    const seg = sliceBetween(HOST, "function Segmented<T extends string>", "const TAG_TEXT");
    expect(seg).toContain('className="host-segment"');
    expect(seg).toContain('role="radiogroup"');
    expect(seg).toContain("styles.segmentSelected");
    /* #1448: the radio attributes come from the shared hook here too -- one definition, two consumers. */
    expect(seg).toContain("useRadioGroup(options.map((option) => option.key), value, onChange)");
    expect(seg).toContain("{...radio.optionProps(option.key)}");
    expect(seg).toContain("onKeyDown={radio.onKeyDown}");
  });

  it("makes the whole card the target, and shows a keyboard where it is", () => {
    /* The well and the text are both inside the button, so there is no dead strip; and the ring is the app's
       own -- 2px #8a8a86 at 2px offset, as the Lobby's rows and the waiting room's controls use. */
    expect(gallery).toContain("<button");
    expect(gallery.indexOf("styles.typeWell")).toBeGreaterThan(gallery.indexOf("<button"));
    expect(gallery.indexOf("styles.typeText")).toBeLessThan(gallery.indexOf("</button>"));
    expect(HOST_RAW).toContain(".host-type-card:focus-visible");
    expect(HOST_RAW).toContain("outline: 2px solid #8a8a86");
    expect(HOST_RAW).toContain("outline-offset: 2px");
    expect(gallery).toContain('className="host-type-card"');
  });

  it("says which one is chosen three ways, and never dims the others out", () => {
    /* #1448a: the SHORTHAND, not the `borderColor` longhand -- see `hostRadioGroups.test.tsx` for why the
       longhand left a black edge on every card that had ever been selected. */
    expect(HOST).toContain('typeBoxSelected: { border: "1px solid #6fae86"');
    expect(HOST).toContain("styles.typeMarkOn");
    // #1447: readable, not hidden. A logo at a third of its brightness is not a choice, it is a disabled one.
    const idle = sliceBetween(HOST, "typeArtIdle: {", "}");
    const opacity = Number((idle.match(/opacity: ([\d.]+)/) ?? [])[1]);
    expect(opacity).toBeGreaterThanOrEqual(0.8);
    expect(opacity).toBeLessThan(1);
  });

  it("widens the gallery step only", () => {
    /* The house-rules step is a form and keeps its 600px measure; three logo wells need the room. The switch
       is the step, so neither can quietly take the other's width. */
    expect(HOST).toContain('cardGallery: { width: "min(820px, 100%)" }');
    expect(HOST).toContain('...(step === "type" ? styles.cardGallery : null)');
    expect(HOST).toContain('card: {\n    width: "min(600px, 100%)"');
  });
});
