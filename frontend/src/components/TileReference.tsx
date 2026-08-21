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

      {/* ---- The tray, by tier ---- */}
      {TIERS.map((tier) => (
        <div key={tier} style={styles.tierBlock}>
          <h3 style={{ ...styles.sectionTitle, color: TIER_INK[tier] }}>{tier}</h3>
          <div style={styles.grid}>
            {(byTier.get(tier) ?? []).map((tileId) => {
              const entry = TILE_CATALOG_BY_ID.get(tileId);
              if (!entry) return null;
              const targets = graph.successors.get(tileId) ?? [];
              const supply = stock.get(tileId);
              const family = FAMILY_FOR_TERRAIN[entry.terrain];
              const deadEnd = isUpgradeDeadEnd(tileId);
              return (
                <article key={tileId} style={styles.card}>
                  <div style={styles.cardHead}>
                    <TilePreviewThumbnail tileId={tileId} orientation={0} size={44} />
                    <div style={styles.cardHeadText}>
                      <span style={{ ...styles.cardId, color: TIER_INK[tier] }}>#{tileId}</span>
                      {/* Design note #677: the SUPPLY, which is why a player opens this
                          tab mid-game. Remaining leads and printed is the context for it;
                          before a game there is no remaining and the panel says so rather
                          than showing a full tray as though it were live. */}
                      <span style={styles.supply}>
                        {supply
                          ? live
                            ? `${supply.remaining} of ${supply.printed} left`
                            : `${supply.printed} in the tray`
                          : "—"}
                      </span>
                    </div>
                  </div>

                  {family && (
                    <p style={styles.restriction} title={FAMILY_BLURB[family]}>
                      <span style={styles.familyTag}>{family}</span> {FAMILY_BLURB[family]}
                    </p>
                  )}

                  <div style={styles.upgradeRow}>
                    {targets.length > 0 ? (
                      <>
                        <span style={styles.upgradeLabel}>Upgrades to</span>
                        {targets.map((id) => (
                          <TileChip key={id} tileId={id} />
                        ))}
                      </>
                    ) : deadEnd ? (
                      /* Design note #677: NOT THE SAME AS "nothing follows brown". A yellow
                         or green tile with no successor fixes its hex at that colour for the
                         rest of the game, which is a cost the player is choosing to pay when
                         they lay it -- and the reason to say it in words rather than leaving
                         an empty row the reader has to interpret. */
                      <span style={styles.deadEnd}>
                        No upgrade — this fixes the hex at {tier.toLowerCase()} for the rest of
                        the game.
                      </span>
                    ) : (
                      <span style={styles.topTier}>Top tier — nothing replaces it.</span>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        </div>
      ))}
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
  tierBlock: { display: "flex", flexDirection: "column", gap: "10px" },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
    gap: "10px",
  },
  card: {
    display: "flex",
    flexDirection: "column",
    gap: "8px",
    padding: "10px 12px",
    backgroundColor: "#161922",
    border: "1px solid #2a2e3a",
    borderRadius: "10px",
  },
  cardHead: { display: "flex", alignItems: "center", gap: "10px" },
  cardHeadText: { display: "flex", flexDirection: "column", gap: "1px" },
  cardId: {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: FONT_SIZE.strong,
    fontWeight: 700,
  },
  supply: {
    fontSize: FONT_SIZE.small,
    fontVariantNumeric: "tabular-nums",
    color: "#9aa0ac",
  },
  restriction: { margin: 0, fontSize: FONT_SIZE.micro, lineHeight: 1.4, color: "#e0b062" },
  familyTag: {
    display: "inline-block",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: FONT_SIZE.micro,
    fontWeight: 700,
    padding: "1px 5px",
    borderRadius: "4px",
    border: "1px solid #6b5a2a",
    backgroundColor: "#241f12",
    color: "#e0c07a",
  },
  upgradeRow: { display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" },
  upgradeLabel: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.06em",
    color: "#8a90a0",
  },
  chip: { display: "inline-flex", alignItems: "center", gap: "4px" },
  chipId: {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: FONT_SIZE.micro,
    fontWeight: 700,
  },
  arrow: { color: "#8a90a0", fontSize: FONT_SIZE.body },
  /* Amber, matching the app's other "a rule constrains you here" marks rather
     than red -- a tile with no upgrade is a trade-off, not an error. */
  deadEnd: { fontSize: FONT_SIZE.micro, lineHeight: 1.4, color: "#e0c07a" },
  topTier: { fontSize: FONT_SIZE.micro, lineHeight: 1.4, color: "#6f7480" },
};
