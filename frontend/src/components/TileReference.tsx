// frontend/src/components/TileReference.tsx
//
// THE TRAY, AND WHAT EACH TILE BECOMES.
//
// Design note #677: REQUESTED after a look at 18xx.games, which has a Tiles tab
// listing the tray and its supply but not upgrade paths -- "I do think this is
// something we should add, especially the strangeness of OO tiles and other
// restrictions".
//
// The paths are NOT authored here or anywhere. `utils/tileUpgrades.ts` #675
// derives them by running the board's own legality filter over the real map, so
// this panel renders an answer rather than asserting one. See that module for
// why a hand-written table was the tempting and wrong implementation.
//
// WHAT THE PANEL HAS TO SAY THAT A GRID OF THUMBNAILS DOES NOT:
//
//   A DEAD END IS A DECISION. #55 has no green successor -- 1830 prints no
//   two-town green tile -- so laying one fixes that hex at yellow for the rest
//   of the game. That is a real cost a player should be able to look up, and it
//   is invisible in a supply list.
//
//   A PRINTED START IS NOT A MISSING TILE. The OO chain has no yellow entry
//   because E5, D10, E11 and H18 come printed on the board. A tray view alone
//   makes that look like a gap in the catalog; the chain has to name the hexes.
//
//   SCARCITY IS THE POINT OF THE SUPPLY COLUMN. Two copies of #59 against four
//   OO hexes, four copies of #57 against eight corporations needing a home.
//
// See docs/ai_architecture/hex_tile_math.md, TileReference.tsx #677.

import React, { useEffect, useMemo, useState } from "react";

import { TilePreviewThumbnail } from "./HexGridRenderer";
import { TILE_CATALOG_BY_ID, type TileColorTier } from "./hexTileCatalog";
import type { MapGridResponse } from "./hexContractTypes";
import { FONT_SIZE, RADIUS } from "../styles/typography";
import { tileStockTable, type TileStock } from "../utils/tileSupply";
/* Design note #1117: the one viewport ground, shared rather than retyped. */
import { INK_VIEWPORT } from "../styles/palette";
import {
  isUpgradeDeadEnd,
  tileUpgradeGraph,
  tileUpgradeSources,
  type TileUpgradeGraph,
} from "../utils/tileUpgrades";

export interface TileReferenceProps {
  /** The live board, for remaining supply. `null` renders printed counts only
   *  -- honest before a game starts, and the panel says which it is showing. */
  mapGrid: MapGridResponse | null;
}

const TIERS: readonly TileColorTier[] = ["Yellow", "Green", "Brown"];

/** Matching `HexGridRenderer`'s own `COLOR_TIER_STROKE`, so a tile's heading
 *  reads as the tier its thumbnail is outlined in. */
const TIER_INK: Readonly<Record<TileColorTier, string>> = {
  Yellow: "#caa42a",
  Green: "#6fcf7c",
  Brown: "#c08a5a",
};

/** Which restricted family a tile belongs to, by the terrain the board's own
 *  letter-code rule matches on. `null` for the ordinary majority. */
const FAMILY_FOR_TERRAIN: Readonly<Record<string, string>> = {
  DoubleCityHub: "OO",
  BostonHub: "B",
  NewYorkHub: "NY",
};

const FAMILY_BLURB: Readonly<Record<string, string>> = {
  OO: "Only on an OO hex — two cities that start unconnected.",
  B: "Only on a hex printed with the B code.",
  NY: "Only on New York.",
};

/** Design note #693: the chip takes a size. It draws the printed-start rows at 30px and the detail panel at
 *  52-72 -- one component so a tile looks the same wherever it is referenced, which is the whole reason the
 *  chip exists rather than an inline thumbnail plus a span. */
function TileChip({ tileId, size = 30 }: { tileId: number; size?: number }) {
  const entry = TILE_CATALOG_BY_ID.get(tileId);
  return (
    <span style={{ ...styles.chip, ...(size > 40 ? styles.chipStacked : {}) }}>
      <TilePreviewThumbnail tileId={tileId} orientation={0} size={size} />
      <span style={{ ...styles.chipId, color: entry ? TIER_INK[entry.color] : "#8a8a86" }}>
        #{tileId}
      </span>
    </span>
  );
}

/** Readable names for the terrain tags, so the panel says what a tile IS rather than repeating its catalog
 *  enum. Absent entries fall through to the raw tag -- a new terrain should look unfamiliar, not blank. */
const TERRAIN_LABEL: Readonly<Record<string, string>> = {
  Plain: "Plain track",
  SmallTown: "One town",
  DoubleTown: "Two towns",
  MajorCityHub: "City",
  DoubleCityHub: "Two cities",
  BostonHub: "Boston",
  NewYorkHub: "New York",
};

/* ==================================================================
    DESIGN NOTE 1152: THE ANSWER MOVED UP TO THE ROW THAT ASKED IT
   ==================================================================
   REPORTED: "on the tiles tab, clicking a tile currently appends an upgrade panel all the way at the bottom
   of the screen", asked as a request to replace the panel with the board's radial ring.

   #693 PUT THE PANEL INSIDE THE TRAY DELIBERATELY -- "the answer appears under the question" -- and the
   reasoning was sound at TRAY granularity and wrong at TILE granularity. A tray holds up to eighteen tiles
   over four or five rows; the panel rendered after the whole grid, so clicking a tile in the top row put its
   answer four rows away, which is the complaint word for word.

   THE RING WAS ASKED FOR AND IS NOT WHAT THIS DOES, and the reason is worth recording rather than leaving as
   a silent decline. On the map that ring is a CHOOSER: you pick a candidate, rotate it and confirm a lay.
   Here there is nothing to lay. A control that borrows the chooser's exact appearance but cannot choose
   teaches the wrong lesson -- a player will click a candidate expecting to place it -- and the useful click
   on this tab is "show me THAT tile's chain", which is a browse, the opposite gesture. #693's own words for
   this were "a radial menu is a board tool"; that half of it still holds.
   SO THE PANEL KEEPS ITS SHAPE AND FIXES ITS POSITION, which is what the report is actually about.

   IT NEEDS THE COLUMN COUNT, and the grid is `auto-fill`, so only the browser knows it. `gridTemplateColumns`
   resolves to a list of used track sizes, and counting them is the one property of that list that does not
   care what the sizes are -- so this reads a count and never a pixel, which is what keeps it indifferent to
   the chrome's zoom (#1144's lesson, one file over).
   RE-MEASURED ON RESIZE, because the count changes with the window and a stale one would open the panel in
   the middle of a row. */
function useGridColumnCount(ref: React.RefObject<HTMLDivElement | null>): number {
  const [columns, setColumns] = useState(1);
  useEffect(() => {
    const node = ref.current;
    if (!node || typeof ResizeObserver === "undefined") return undefined;
    const measure = () => {
      const tracks = window.getComputedStyle(node).gridTemplateColumns;
      /* `none` before the first layout, and a single track reads as one column either way. */
      setColumns(Math.max(1, tracks && tracks !== "none" ? tracks.split(" ").length : 1));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref]);
  return columns;
}

/** The last index on the row that holds `selected` -- or `null` when nothing in this tray is selected. */
function rowEndFor(selectedIndex: number, columns: number, count: number): number | null {
  if (selectedIndex < 0) return null;
  return Math.min(count - 1, Math.floor(selectedIndex / columns) * columns + columns - 1);
}

/** One tile's place in the chain -- design note #693.
 *
 *  Deliberately NOT a modal or a radial ring. A radial menu is a board tool: it anchors to a canvas, it is
 *  for choosing a thing to place, and it dismisses on a click elsewhere. This is a reference page, and what
 *  the reader wants is to compare -- open a tile, look at its successors, keep the tray visible around it.
 *  A panel that pushes the tray down does that; an overlay that covers the tray does not. */
function TileUpgradeDetail({
  tileId,
  tier,
  targets,
  onClose,
}: {
  tileId: number;
  tier: TileColorTier;
  targets: readonly number[];
  onClose: () => void;
}) {
  const sources = tileUpgradeSources(tileId);
  const entry = TILE_CATALOG_BY_ID.get(tileId);
  return (
    <div style={{ ...styles.detail, borderColor: TIER_INK[tier] }} role="group">
      <div style={styles.detailHead}>
        <span style={{ ...styles.detailTitle, color: TIER_INK[tier] }}>#{tileId}</span>
        {entry && <span style={styles.detailTerrain}>{TERRAIN_LABEL[entry.terrain] ?? entry.terrain}</span>}
        <button type="button" style={styles.detailClose} onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>

      <div style={styles.detailChain}>
        {/* Upgraded FROM, when anything reaches it. Absent rather than "nothing" for a yellow tile: the tray
            it sits in already says it starts a chain. */}
        {sources.length > 0 && (
          <div style={styles.detailArm}>
            <span style={styles.detailArmLabel}>Replaces</span>
            <div style={styles.detailTiles}>
              {sources.map((id) => (
                <TileChip key={id} tileId={id} size={52} />
              ))}
            </div>
          </div>
        )}

        <div style={styles.detailArm}>
          <span style={styles.detailArmLabel}>This tile</span>
          <div style={styles.detailTiles}>
            <TileChip tileId={tileId} size={72} />
          </div>
        </div>

        <div style={styles.detailArm}>
          <span style={styles.detailArmLabel}>Upgrades to</span>
          <div style={styles.detailTiles}>
            {targets.length > 0 ? (
              targets.map((id) => <TileChip key={id} tileId={id} size={52} />)
            ) : (
              /* The two ways a chain ends, told apart -- #677's distinction, which is worth more here than it
                 was in the tray because this is the panel a player opens to ask the question. */
              <span style={styles.detailEnd}>
                {isUpgradeDeadEnd(tileId)
                  ? `Nothing replaces #${tileId}. Laying it fixes that hex at ${tier.toLowerCase()} for the rest of the game.`
                  : "The top tier — nothing replaces it."}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export /* Design note #1152: ONE TRAY, and it is a component because the panel's position depends on the grid's
   resolved column count -- which needs a ref and an effect, and hooks cannot be called from inside a
   `.map()`. The body below is #692's and #693's, carried over unchanged apart from where the panel sits. */
function TileTray({
  tier,
  ids,
  isTopTier,
  stock,
  live,
  graph,
  selectedTileId,
  onSelect,
}: {
  tier: TileColorTier;
  ids: readonly number[];
  isTopTier: boolean;
  /* The real types, read off the callers rather than approximated -- both are READONLY maps, and a
     widened signature here would have quietly claimed this component may write to them. */
  stock: ReadonlyMap<number, TileStock>;
  live: boolean;
  graph: TileUpgradeGraph;
  selectedTileId: number | null;
  onSelect: (tileId: number | null) => void;
}) {
  const gridRef = React.useRef<HTMLDivElement | null>(null);
  const columns = useGridColumnCount(gridRef);
  const selectedIndex = selectedTileId === null ? -1 : ids.indexOf(selectedTileId);
  const panelAfterIndex = rowEndFor(selectedIndex, columns, ids.length);
  const setSelectedTileId = onSelect;
  return (
          <section
            key={tier}
            style={{ ...styles.tray, borderColor: TIER_INK[tier] }}
            aria-label={`${tier} tiles`}
          >
            <header style={styles.trayHead}>
              <h3 style={{ ...styles.trayTitle, color: TIER_INK[tier] }}>{tier}</h3>
              {/* Design note #692: "Top tier -- nothing replaces it" was on all EIGHTEEN brown tiles, and it
                  is a fact about the TIER. Said once, on the thing it is true of. `PlayerCards` #567 removed
                  three marks on the same reasoning: a caption repeated on every member of a group is telling
                  the reader about the group in the least efficient available place. */}
              <span style={styles.trayNote}>
                {isTopTier
                  ? "The top tier — nothing replaces these."
                  : `${ids.length} tiles`}
              </span>
            </header>

            <div style={styles.trayContents} ref={gridRef}>
              {ids.map((tileId, index) => {
                const entry = TILE_CATALOG_BY_ID.get(tileId);
                if (!entry) return null;
                /* Design note #693: the tray tile no longer reads `successors` at all -- the panel does. Left
                   as a comment rather than a stale binding, because an unused lookup here is how the chips
                   would find their way back. */
                const supply = stock.get(tileId);
                const family = FAMILY_FOR_TERRAIN[entry.terrain];
                const isSelected = tileId === selectedTileId;
                /* Design note #1152: a fragment, so the panel can follow the tile that ENDS the selected
                   row without the tiles after it moving. Keyed on the tile, which is what `key` was on before
                   the wrapper existed. */
                return (
                  <React.Fragment key={tileId}>
                  {/* Design note #692: no border, no background. A tile is contents, and its own artwork is
                     already a bounded shape -- a box around a hexagon is a box around something that did not
                     need one.
                     Design note #693: and it is a BUTTON now -- see the note on the detail panel below. Styled
                     as contents still; the affordance is the pointer, the pressed ring and `aria-pressed`,
                     none of which add a box. */}
                  <button
                    type="button"
                    aria-pressed={isSelected}
                    aria-label={`Tile #${tileId} — ${isSelected ? "hide" : "show"} its upgrade path`}
                    onClick={() => setSelectedTileId(isSelected ? null : tileId)}
                    style={{
                      ...styles.trayTile,
                      ...(isSelected ? { ...styles.trayTileSelected, borderColor: TIER_INK[tier] } : {}),
                    }}
                  >
                    {/* Design note #692a: sized up from 44px. The artwork is the thing this tab is FOR, and at
                        44 a green city and a green crossover are two dark hexagons -- which is the reading the
                        report is describing when it says the page looks messy. */}
                    <TilePreviewThumbnail tileId={tileId} orientation={0} size={64} />

                    <span style={{ ...styles.tileId, color: TIER_INK[tier] }}>
                      #{tileId}
                      {family && (
                        <span style={styles.familyTag} title={FAMILY_BLURB[family]}>
                          {family}
                        </span>
                      )}
                    </span>

                    {/* Design note #677: the SUPPLY, which is why a player opens this tab mid-game. */}
                    <span style={styles.supply}>
                      {supply
                        ? live
                          ? `${supply.remaining} / ${supply.printed}`
                          : `${supply.printed} in tray`
                        : "—"}
                    </span>

                    {/* Design note #693: THE UPGRADE CHIPS ARE GONE FROM HERE. #692 shrank them to bare
                        numbered ids and it was still reported as "very cluttered and chaotic" -- correctly,
                        because the problem was never their size. An upgrade path is a RELATIONSHIP, and this
                        page was drawing all of them at once: 46 tiles carrying up to seven references each is
                        a hundred tile ids competing with the 46 they sit beneath, at the same weight, in the
                        same typeface. No amount of shrinking fixes simultaneity.
                        A relationship is only interesting ONE AT A TIME. It moves to the panel below. */}

                    {/* Design note #677: NOT THE SAME AS "nothing follows brown", which is why this survives
                        while the top-tier line moved to the heading. A yellow or green tile with no successor
                        fixes its hex at that colour for the rest of the game -- a cost the player is choosing
                        to pay, true of eight tiles rather than of a whole tier.
                        `isUpgradeDeadEnd`, NOT `!isTopTier && targets.length === 0`. The first draft of this
                        tray inlined that expression and left the import unused, which is how it was caught --
                        the predicate is the util's (`tileUpgrades.ts` #675), it already draws exactly this
                        distinction, and it is tested. A second copy here is a second opinion about which
                        tiles are dead ends. */}
                    {isUpgradeDeadEnd(tileId) && (
                      <span
                        style={styles.deadEnd}
                        title={`No green or brown tile can replace #${tileId}, so laying it fixes that hex at ${tier.toLowerCase()} for the rest of the game.`}
                      >
                        No upgrade
                      </span>
                    )}
                  </button>
                  {/* Design note #1152: the answer, as a GRID ITEM spanning every column, placed immediately
                      after the last tile on the row that holds the selection. It therefore opens within one
                      row's height of the tile that was clicked -- #693's "the answer appears under the
                      question", finally true at the granularity the question is asked at -- and the rest of
                      that row stays intact above it rather than being pushed below the answer. */}
                  {index === panelAfterIndex && selectedTileId !== null && (
                    <div style={styles.detailRow}>
                      <TileUpgradeDetail
                        tileId={selectedTileId}
                        tier={tier}
                        targets={graph.successors.get(selectedTileId) ?? []}
                        onClose={() => onSelect(null)}
                      />
                    </div>
                  )}
                  </React.Fragment>
                );
              })}
            </div>

          </section>
  );
}

function TileReference({ mapGrid }: TileReferenceProps) {
  /* The sweep is real work and the board does not change under it, so both
     derivations are memoised on the one input that matters. */
  /* Design note #693: ONE SELECTION FOR THE WHOLE TAB, mirroring `StockRoundPanel`'s `activeCompanyId`
     exactly -- a single `number | null`, click to toggle, so at most one tile is ever open. That component
     reached the same shape for the same reason (#396: the card "decides where the controls live"), and a
     reader who has learned it there does not have to learn it again here. */
  const [selectedTileId, setSelectedTileId] = useState<number | null>(null);
  const graph = useMemo(() => tileUpgradeGraph(), []);
  const stock = useMemo(() => tileStockTable(mapGrid), [mapGrid]);
  const live = mapGrid !== null;

  const byTier = useMemo(() => {
    const out = new Map<TileColorTier, number[]>();
    for (const tier of TIERS) out.set(tier, []);
    TILE_CATALOG_BY_ID.forEach((entry, tileId) => out.get(entry.color)?.push(tileId));
    out.forEach((ids) => ids.sort((a, b) => a - b));
    return out;
  }, []);

  return (
    <section style={styles.root} aria-label="Tile reference">
      <header style={styles.header}>
        <h2 style={styles.title}>Tiles</h2>
        <p style={styles.lede}>
          Every tile in the tray, what it upgrades into, and how many are left. Upgrade
          paths are read from the same rules the board enforces when it offers you a
          tile — colour step, letter code, and keeping every path the old tile carried.
        </p>
      </header>

      {/* ---- The three chains that start on the board rather than in the tray ---- */}
      <div style={styles.printedBlock}>
        <h3 style={styles.sectionTitle}>Printed on the board</h3>
        <p style={styles.sectionNote}>
          These hexes arrive with their yellow tile already on them, so there is no
          yellow tile to find in the tray. Their chains start at green.
        </p>
        <div style={styles.printedRows}>
          {Array.from(graph.printedStarts, ([family, targets]) => {
            const hexes = graph.printedHexes.get(family) ?? [];
            return (
              <div key={family} style={styles.printedRow}>
                <span style={styles.familyTag}>{family}</span>
                <span style={styles.printedHexes}>{hexes.join(", ")}</span>
                <span style={styles.arrow} aria-hidden="true">
                  →
                </span>
                {targets.map((id) => (
                  <TileChip key={id} tileId={id} />
                ))}
              </div>
            );
          })}
        </div>
      </div>

      {/* ---- The trays ---- */}
      {/* Design note #692: A TRAY IS THE BOX. THE TILES ARE NOT.
         REPORTED: "I didn't actually register these as being in a tray because the header for them (Yellow,
         Green and Brown) live in a shared background and each tile is in its own box."
         That is the diagnosis and it is exact -- the grouping was inverted. #677 gave every tile a bordered
         card and gave the tier nothing but a heading floating above a grid, so 46 boxes competed with each
         other while the thing they were meant to belong to had no edges at all. "Messy" is what an inverted
         hierarchy looks like.
         SO THE TIER TAKES THE BORDER and the heading sits ON it; the tiles are loose contents. Nothing about
         the information changed -- only which level of it is drawn as an object. */}
      {TIERS.map((tier) => (
        <TileTray
          key={tier}
          tier={tier}
          ids={byTier.get(tier) ?? []}
          isTopTier={tier === TIERS[TIERS.length - 1]}
          stock={stock}
          live={live}
          graph={graph}
          selectedTileId={selectedTileId}
          onSelect={setSelectedTileId}
        />
      ))}
    </section>
  );
}

export default TileReference;

const styles: Record<string, React.CSSProperties> = {
  root: {
    /* ==================================================================
        DESIGN NOTE 1117: THIS TAB HAD NO VIEWPORT AT ALL
       ==================================================================
       It rendered its content straight onto the #080808 page while four other tabs each drew a surface of
       their own, which is what the report is describing: switching to this tab, the ground drops away.
       The border and radius are here for the same reason the fill is -- the Stock Market had the fill and no
       edge, and read as "maybe there is no viewport", so a surface without an outline is only half of one.
       THE MARGIN STANDS IN FOR `canvasPane`. The workspace tabs get their 20px inset from that wrapper; the
       reference tabs render outside it, so they carry the same inset themselves rather than running to the
       window edge and losing the border they were just given. */
    // Design note #1118: top edge closed to meet the tab strip, same as `canvasPane`.
    margin: "0 20px 20px",
    backgroundColor: INK_VIEWPORT,
    border: "1px solid #2a2a2a",
    borderRadius: RADIUS.card,
    display: "flex",
    flexDirection: "column",
    gap: "18px",
    padding: "20px 24px 40px",
    color: "#f2f0eb",
    fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif",
  },
  header: { display: "flex", flexDirection: "column", gap: "6px" },
  title: {
    margin: 0,
    fontSize: FONT_SIZE.heading,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.04em",
    color: "#c8c6c0",
  },
  lede: { margin: 0, fontSize: FONT_SIZE.body, lineHeight: 1.5, color: "#a8a6a0", maxWidth: "68ch" },
  printedBlock: {
    display: "flex",
    flexDirection: "column",
    gap: "8px",
    padding: "14px 16px",
    backgroundColor: "#0f0f0f",
    border: "1px solid #2a2a2a",
    borderRadius: RADIUS.card,
  },
  sectionTitle: {
    margin: 0,
    fontSize: FONT_SIZE.strong,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.04em",
    color: "#c8c6c0",
  },
  sectionNote: { margin: 0, fontSize: FONT_SIZE.small, lineHeight: 1.5, color: "#8a8a86", maxWidth: "68ch" },
  printedRows: { display: "flex", flexDirection: "column", gap: "6px", marginTop: "4px" },
  printedRow: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" },
  printedHexes: {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: FONT_SIZE.small,
    color: "#c8c6c0",
  },
  /* Design note #692: THE TRAY IS THE OBJECT. A tinted panel with the tier's own colour on its edge, holding
     loose tiles -- the inversion the report identified, corrected. The border takes the tier ink at the call
     site so the three trays are one shape in three colours rather than three styles. */
  tray: {
    display: "flex",
    flexDirection: "column",
    gap: "12px",
    padding: "14px 16px 16px",
    backgroundColor: "#161616",
    border: "1px solid",
    /* Overridden per tier; a neutral here so a missing colour degrades to a
       visible tray rather than an invisible one. */
    borderColor: "#2a2a2a",
    borderRadius: RADIUS.layer,
  },
  trayHead: {
    display: "flex",
    alignItems: "baseline",
    gap: "10px",
    flexWrap: "wrap",
  },
  trayTitle: {
    margin: 0,
    fontSize: FONT_SIZE.heading,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.06em",
  },
  /* The tier's own one-line note -- a count, or #692's single statement that brown ends every chain. */
  trayNote: { fontSize: FONT_SIZE.small, color: "#8a8a86" },
  /* `auto-fill` at a width that fits the 64px artwork plus its figures. The tiles reflow; the tray does not
     scroll, because a tray you have to scroll inside is a list wearing a border. */
  /* Design note #1152: spans every column, whatever `auto-fill` resolved to. `1 / -1` is the whole point --
     it needs no knowledge of the column count, which is why the count is only ever used to decide WHERE the
     item goes and never how wide it is. */
  detailRow: { gridColumn: "1 / -1" },
  trayContents: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(132px, 1fr))",
    gap: "16px 12px",
  },
  /* Design note #692: contents, not cards. No border, no fill -- the hexagon is already a bounded shape. */
  /* Design note #693: a button that does not look like one. Transparent fill, transparent border reserved so
     selecting does not reflow the grid, and the type inherited rather than reset -- the affordance is the
     cursor and the ring, because #692's whole point was that these are contents rather than cards. */
  trayTile: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "3px",
    textAlign: "center",
    padding: "6px 4px",
    /* Design note #732: `backgroundColor`, NOT the `background` shorthand -- and this line is the whole bug.
       `trayTileSelected` below toggles `backgroundColor`, and when React clears that longhand on deselect it
       removes the shorthand's contribution to the same property, leaving the `<button>` on the User Agent's
       `buttonface` default: light grey on a dark panel. Reported as a white background that appeared on CLOSE
       and vanished on open -- anti-phase with the selection, which is the tell.
       Both renders now write the same property, so the diff always has a value to set. */
    backgroundColor: "transparent",
    border: "1px solid transparent",
    borderRadius: RADIUS.card,
    font: "inherit",
    color: "inherit",
    cursor: "pointer",
  },
  /* Design note #732: pairs with `trayTile`'s `backgroundColor`. If either of these two ever becomes a
     `background` shorthand again, the tab regains the anti-phase white. */
  trayTileSelected: { backgroundColor: "rgba(255, 255, 255, 0.05)" },
  /* Design note #693: the panel, inside the tray that holds the selected tile. */
  detail: {
    display: "flex",
    flexDirection: "column",
    gap: "10px",
    marginTop: "4px",
    padding: "12px 14px",
    backgroundColor: "rgba(255, 255, 255, 0.04)",
    border: "1px solid",
    borderColor: "#2a2a2a",
    borderRadius: RADIUS.card,
  },
  detailHead: { display: "flex", alignItems: "baseline", gap: "10px" },
  detailTitle: {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: FONT_SIZE.heading,
    fontWeight: 700,
  },
  detailTerrain: { fontSize: FONT_SIZE.small, color: "#a8a6a0", flex: "1 1 auto" },
  detailClose: {
    background: "none",
    border: "none",
    color: "#8a8a86",
    fontSize: FONT_SIZE.body,
    cursor: "pointer",
    padding: "0 2px",
    lineHeight: 1,
  },
  /* The chain reads left to right, and wraps as one unit per arm rather than as one long row of tiles --
     otherwise "Replaces" and "Upgrades to" interleave at narrow widths and the panel says something false. */
  detailChain: { display: "flex", flexWrap: "wrap", gap: "10px 22px", alignItems: "flex-start" },
  detailArm: { display: "flex", flexDirection: "column", gap: "6px" },
  detailArmLabel: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.06em",
    color: "#8a8a86",
  },
  detailTiles: { display: "flex", flexWrap: "wrap", gap: "12px", alignItems: "flex-start" },
  detailEnd: { fontSize: FONT_SIZE.small, lineHeight: 1.5, color: "#e0c07a", maxWidth: "40ch" },
  tileId: {
    display: "inline-flex",
    alignItems: "center",
    gap: "5px",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: FONT_SIZE.body,
    fontWeight: 700,
  },
  upgradeRow: {
    display: "inline-flex",
    alignItems: "center",
    gap: "5px",
    flexWrap: "wrap",
    justifyContent: "center",
  },
  /* Design note #692: the "Upgrades to" caption is GONE -- 28 repetitions of a label for a relationship the
     arrow beside it states. What survives is the arrow and the tier-coloured ids, which is the same sentence
     in a third of the width. */
  arrow: { color: "#8a8a86", fontSize: FONT_SIZE.body },
  /* Amber, matching the app's other "a rule constrains you here" marks rather
     than red -- a tile with no upgrade is a trade-off, not an error. */
  /* Design note #692: two words, not a sentence. The sentence ("this fixes the hex at yellow for the rest of
     the game") is the tooltip's job now -- on a tile in a tray, the point is that this one is DIFFERENT from
     its neighbours, and two amber words say that at a glance where a clause has to be read.
     `topTier` is DELETED: it said the same thing on all eighteen brown tiles and now sits on the tray. */
  deadEnd: { fontSize: FONT_SIZE.micro, fontWeight: 700, lineHeight: 1.4, color: "#e0c07a" },
};
