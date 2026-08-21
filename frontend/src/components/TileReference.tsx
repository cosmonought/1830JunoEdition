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

import React, { useMemo } from "react";

import { TilePreviewThumbnail } from "./HexGridRenderer";
import { TILE_CATALOG_BY_ID, type TileColorTier } from "./hexTileCatalog";
import type { MapGridResponse } from "./hexContractTypes";
import { FONT_SIZE } from "../styles/typography";
import { tileStockTable } from "../utils/tileSupply";
import { isUpgradeDeadEnd, tileUpgradeGraph } from "../utils/tileUpgrades";

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

function TileChip({ tileId }: { tileId: number }) {
  const entry = TILE_CATALOG_BY_ID.get(tileId);
  return (
    <span style={styles.chip}>
      <TilePreviewThumbnail tileId={tileId} orientation={0} size={30} />
      <span style={{ ...styles.chipId, color: entry ? TIER_INK[entry.color] : "#8a90a0" }}>
        #{tileId}
      </span>
    </span>
  );
}

export function TileReference({ mapGrid }: TileReferenceProps) {
  /* The sweep is real work and the board does not change under it, so both
     derivations are memoised on the one input that matters. */
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
      {TIERS.map((tier) => {
        const ids = byTier.get(tier) ?? [];
        const isTopTier = tier === TIERS[TIERS.length - 1];
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

            <div style={styles.trayContents}>
              {ids.map((tileId) => {
                const entry = TILE_CATALOG_BY_ID.get(tileId);
                if (!entry) return null;
                const targets = graph.successors.get(tileId) ?? [];
                const supply = stock.get(tileId);
                const family = FAMILY_FOR_TERRAIN[entry.terrain];
                return (
                  /* Design note #692: no border, no background. A tile is contents, and its own artwork is
                     already a bounded shape -- a box around a hexagon is a box around something that did not
                     need one. */
                  <div key={tileId} style={styles.trayTile}>
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

                    {/* Design note #692: the upgrades as bare numbered chips, with no "Upgrades to" caption.
                        An arrow and a tier-coloured number say it in the space a label was taking, and the
                        caption was repeated 28 times to explain a relationship the arrow states once. */}
                    {targets.length > 0 && (
                      <span style={styles.upgradeRow}>
                        <span style={styles.arrow} aria-hidden="true">→</span>
                        {targets.map((id) => (
                          <TileChip key={id} tileId={id} />
                        ))}
                      </span>
                    )}

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
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}
    </section>
  );
}

export default TileReference;

const styles: Record<string, React.CSSProperties> = {
  root: {
    display: "flex",
    flexDirection: "column",
    gap: "18px",
    padding: "20px 24px 40px",
    color: "#e6e8ef",
    fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif",
  },
  header: { display: "flex", flexDirection: "column", gap: "6px" },
  title: {
    margin: 0,
    fontSize: FONT_SIZE.heading,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.04em",
    color: "#c8cbd6",
  },
  lede: { margin: 0, fontSize: FONT_SIZE.body, lineHeight: 1.5, color: "#9aa0ac", maxWidth: "68ch" },
  printedBlock: {
    display: "flex",
    flexDirection: "column",
    gap: "8px",
    padding: "14px 16px",
    backgroundColor: "#161922",
    border: "1px solid #2a2e3a",
    borderRadius: "10px",
  },
  sectionTitle: {
    margin: 0,
    fontSize: FONT_SIZE.strong,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.04em",
    color: "#c8cbd6",
  },
  sectionNote: { margin: 0, fontSize: FONT_SIZE.small, lineHeight: 1.5, color: "#8a90a0", maxWidth: "68ch" },
  printedRows: { display: "flex", flexDirection: "column", gap: "6px", marginTop: "4px" },
  printedRow: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" },
  printedHexes: {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: FONT_SIZE.small,
    color: "#c8cbd6",
  },
  /* Design note #692: THE TRAY IS THE OBJECT. A tinted panel with the tier's own colour on its edge, holding
     loose tiles -- the inversion the report identified, corrected. The border takes the tier ink at the call
     site so the three trays are one shape in three colours rather than three styles. */
  tray: {
    display: "flex",
    flexDirection: "column",
    gap: "12px",
    padding: "14px 16px 16px",
    backgroundColor: "#12151d",
    border: "1px solid",
    /* Overridden per tier; a neutral here so a missing colour degrades to a
       visible tray rather than an invisible one. */
    borderColor: "#2a2e3a",
    borderRadius: "12px",
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
  trayNote: { fontSize: FONT_SIZE.small, color: "#8a90a0" },
  /* `auto-fill` at a width that fits the 64px artwork plus its figures. The tiles reflow; the tray does not
     scroll, because a tray you have to scroll inside is a list wearing a border. */
  trayContents: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(132px, 1fr))",
    gap: "16px 12px",
  },
  /* Design note #692: contents, not cards. No border, no fill -- the hexagon is already a bounded shape. */
  trayTile: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "3px",
    textAlign: "center",
  },
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
  arrow: { color: "#8a90a0", fontSize: FONT_SIZE.body },
  /* Amber, matching the app's other "a rule constrains you here" marks rather
     than red -- a tile with no upgrade is a trade-off, not an error. */
  /* Design note #692: two words, not a sentence. The sentence ("this fixes the hex at yellow for the rest of
     the game") is the tooltip's job now -- on a tile in a tray, the point is that this one is DIFFERENT from
     its neighbours, and two amber words say that at a glance where a clause has to be read.
     `topTier` is DELETED: it said the same thing on all eighteen brown tiles and now sits on the tray. */
  deadEnd: { fontSize: FONT_SIZE.micro, fontWeight: 700, lineHeight: 1.4, color: "#e0c07a" },
};
