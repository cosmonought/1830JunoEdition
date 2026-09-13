/** @jest-environment node */
// frontend/src/utils/gameOutro.test.ts -- design notes #1417/#1418.
import { readStripped, sliceBetween } from "./sourceScan";

describe("the outro plays on the ending's edge and hands off to the modal (design note #1418)", () => {
  const app = readStripped("App.tsx");
  const outro = readStripped("components/GameOutroOverlay.tsx");
  const modal = readStripped("components/GameOverModal.tsx");

  it("is raised by null -> reason, seeded from the first observation, and never on a load", () => {
    const edge = sliceBetween(app, "const previousEndReason = useRef", "}, [gameEndReason]);");
    expect(edge).toContain("if (previous === undefined) return;");
    expect(edge).toContain('if (previous === null && gameEndReason) setOutro("playing");');
  });

  it("holds the modal back until the cue, then keeps the frame until the board is asked for", () => {
    expect(app).toContain('reason={gameOverDismissed || outro === "playing" ? null : gameEndReason}');
    expect(app).toContain('<GameOutroOverlay onCue={() => setOutro("cued")} cued={outro === "cued"} sfxEnabled={sfxEnabled} />');
    const dismiss = sliceBetween(app, "onDismiss={() => {", "}}");
    expect(dismiss).toContain("setOutro(null);");
  });

  it("cues on the picture's clock at the settled title, sits under the modal, and ducks the radio", () => {
    expect(outro).toContain("export const OUTRO_CUE_SECONDS = 8.0;"); // #1445 // #1437: after the first fireworks
    expect(outro).toContain("if (event.currentTarget.currentTime >= OUTRO_CUE_SECONDS) cue();");
    expect(outro).toContain("zIndex: 1500");
    expect(modal).toContain("zIndex: 1600");
    expect(outro).toContain("duckRadio(DUCK_FOR_VIDEO)");
    expect(outro).toContain("muted={!sfxEnabled || cued}");
    expect(outro).toContain('src={GAME_OUTRO_SRC}');
  });

  it("the modal fades up rather than cutting, and the ceremony's bursts get the applause", () => {
    expect(modal).toContain("@keyframes game-over-in");
    expect(app).toContain("const file = ceremonySoundFor(cue);");
    expect(app).toContain("if (file) playVariantCue(file, sfxEnabledRef.current, { uncapped: true });");
  });

  it("the ceremony has no click-to-advance -- Skip and Replay only", () => {
    const ceremony = readStripped("components/AccoladesCeremony.tsx");
    expect(ceremony).not.toContain("onClick={done ? undefined : advance}");
    expect(ceremony).toContain('data-testid="ceremony-skip"');
    expect(ceremony).toContain('data-testid="ceremony-replay"');
  });
});

describe("the second pass (design note #1420)", () => {
  it("the OR's runs land on the OR's own sample, so the revenue chart has figures", () => {
    const { gameHistoryFrom } = require("./gameHistory") as typeof import("./gameHistory");
    const FIXTURE = require("./__fixtures__z6cLog.json") as { entries: unknown[] };
    const history = gameHistoryFrom(FIXTURE.entries as never);
    const ors = history.rounds.filter((r) => r.label.startsWith("OR "));
    expect(ors.length).toBeGreaterThan(3);
    const withRevenue = ors.filter((r) => r.corporations.some((c) => c.revenue > 0));
    expect(withRevenue.length).toBeGreaterThan(ors.length / 2);
  });

  it("cards hold longer, the clips are warmed under the outro, and the ceremony's cues are uncapped", () => {
    const ceremony = readStripped("components/AccoladesCeremony.tsx");
    expect(ceremony).toContain("present: 2600");
    const app = readStripped("App.tsx");
    expect(app).toContain("void preloadCues(Object.values(CEREMONY_SOUNDS)).then(() => {");
    expect(app).toContain("ceremonySoundsReady={ceremonySoundsReady}");
    expect(app).toContain("playVariantCue(file, sfxEnabledRef.current, { uncapped: true })");
    const audio = readStripped("utils/audio.ts");
    expect(audio).toContain("if (!options.uncapped && liveSfx >= MAX_CONCURRENT_SFX) return;");
  });

  it("the modal offers Leave game beside View final board", () => {
    const modal = readStripped("components/GameOverModal.tsx");
    expect(modal).toContain('data-testid="game-over-leave"');
    const app = readStripped("App.tsx");
    expect(app).toContain("onLeaveGame={handleLeaveSandboxRoom}");
  });
});

describe("the ceremony runs once, the charts draw on first sight, the dots are tabs (design note #1432)", () => {
  const modal = readStripped("components/GameOverModal.tsx");
  const charts = readStripped("components/EpilogueCharts.tsx");

  it("the modal remembers what has been seen and animates only the first sight", () => {
    expect(modal).toContain("const firstSight = !seen.has(seenKey);");
    expect(modal).toContain("animate={firstSight}"); // the ceremony
    expect(charts).toContain("const firstSight = !seen.has(key);"); // each chart, by its own key
    // The memory clears with the history (a new game), not with a minimise.
    expect(modal).toContain("setSeen(new Set());\n    setPage(0);\n    setStage(\"ceremony\");\n  }, [history]);");
  });

  it("the pager is the dots, clickable, apart from the actions; the Accolades button is gone (#1436)", () => {
    expect(modal).toContain('role="tablist"');
    expect(modal).toContain("data-testid={`game-over-tab-${name}`}");
    expect(modal).toContain("style={{ ...styles.pageDot, ...(i === current ? styles.pageDotOn : {}) }}");
    expect(modal).toContain('aria-label="Previous page"');
    expect(modal).not.toContain('data-testid="game-over-accolades"');
    expect(modal).toContain("↩ Leave game");
  });

  it("the charts fill a measured box and NYC is white ink (#1436)", () => {
    expect(charts).toContain("function useChartBox()");
    expect(charts).toContain("new ResizeObserver(read)");
    expect(charts).toContain("viewBox={`0 0 ${box.width} ${box.height}`}");
    expect(charts).not.toContain("maxHeight: \"46vh\"");
    expect(charts).toContain('if (relativeLuminance(color) < 0.02) return "#ececec";');
    expect(charts).toContain("Final fleet");
    expect(charts).not.toContain(">Payback<");
  });

  /* #1433: the ceremony is its own stage; the badges ride the table rows; three pages, the charts toggled. */
  it("the ceremony is a stage before the pages, and comes back settled from the footer", () => {
    expect(modal).toContain('const [stage, setStage] = useState<"ceremony" | "pages">("ceremony");');
    expect(modal).toContain('data-testid="ceremony-continue"');
    expect(modal).toContain('? ["standings", "autopsy", "charts"] : ["standings"]');
    expect(modal).toContain('autopsy: "Corporations"');
  });

  it("every player's and corporation's awards ride their row", () => {
    expect(modal).toContain('history.ceremony.filter((a) => a.scope === "player" && a.holder === row.address)');
    expect(charts).toContain('history.ceremony.filter((a) => a.scope === "corporation" && a.companyId === corp.companyId)');
    const glyphs = readStripped("components/accoladeGlyphs.tsx");
    expect(glyphs).toContain("export function AccoladeBadges(");
  });

  it("the Charts page toggles the three and carries the chosen corporation between Revenue and Prices", () => {
    expect(charts).toContain('const [kind, setKind] = useState<ChartKind>("revenue");');
    expect(charts).toContain('export type ChartKind = "revenue" | "dividends" | "prices" | "networth";'); // #1434, #1436
    expect(charts).toContain("data-testid={`chart-tab-${c.kind}`}");
    expect(charts.match(/selected=\{corporation\} onSelect=\{setCorporation\}/g)?.length).toBe(1); // revenue, one line
    expect(charts).toContain("selected={corporation}\n          onSelect={setCorporation}"); // prices, wrapped
  });

  it("lines draw themselves on, bars grow, and a clicked series redraws alone", () => {
    expect(charts).toContain("pathLength={1}");
    expect(charts).toContain('className={draw ? "epilogue-draw" : undefined}');
    expect(charts).toContain("const draw = drawAll || wide;");
    expect(charts).toContain('key={`${s.key}:${wide ? "chosen" : ""}`}');
    expect(charts).toContain('className={grow ? "epilogue-bar" : undefined}');
    expect(charts).toContain("@media (prefers-reduced-motion: reduce)");
  });
});

describe("the Game Over strip replaces the action bar (design note #1442)", () => {
  const app = readStripped("App.tsx");
  it("renders the strip in the bar's slot once an ending stands, and the bar not at all", () => {
    const dock = app.slice(app.indexOf('data-sticky-dock="true"'), app.indexOf("<MainTabBar"));
    expect(dock).toContain(") : gameEndReason ? (");
    expect(dock.indexOf(") : gameEndReason ? (")).toBeLessThan(dock.indexOf("<ContextualActionBar"));
    expect(dock).toContain('data-testid="game-over-strip"');
    expect(dock).toContain("...styles.gameOverStripAsBar");
    // The old strip under the bar is gone.
    expect(app).not.toContain("{gameEndReason && gameOverDismissed && (\n        <div style={styles.gameOverStrip}");
  });
});
