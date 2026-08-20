// Where a station token ends up when the tile under it changes.
//
// Design note #0: the report has two halves with different causes. THE
// VISIBILITY HALF is an omission -- the radial confirm ring ghosts the tile and
// says nothing about the pieces already standing on the hex. THE CONTROL HALF
// was blocked by a shape that no longer exists: `sandboxState.ts` noted that
// `station_token_hexes` had no slot index, and Audit G-12 added `station_tokens`
// as `(q, r, city_index)`. The destination IS expressible now.
//
// Design note #1: PRESERVE THE INDEX, AND SAY SO. `LayTile` carries a tile and
// an orientation and nothing else, so a UI letting the president pick would
// collect an answer it cannot send and the contract would apply its own rule
// regardless -- the worst of the three outcomes, because the player would have
// been asked. So the mapping is DECLARED: a token in city `i` stays in city `i`,
// which is the ordinary 18xx upgrade rule and what `tileCityAnchors` already
// draws against.
//
// WHERE THE MAPPING IS GENUINELY AMBIGUOUS -- a one-city hex becoming a two-city
// tile -- this reports it as ambiguous rather than pretending index 0 was
// chosen. Closing that needs `LayTile` to accept a token destination, which is a
// contract change.
//
// See docs/ai_architecture/hex_tile_math.md, tokenMigration.ts #0 / #1.

import { archetypeForHex } from "../components/hexGeometry";
import { tileCitySlotCounts } from "../components/TileGraphics";
import { tokenCityIndex, type StationTokenCompany } from "../components/hexContractTypes";
import type { MapGridResponse } from "../components/hexContractTypes";

/** One corporation's token on the hex being upgraded. */
export interface TokenMigration {
  companyId: number;
  ticker: string;
  /** The city it occupies now. `null` when the chain has not said -- an
   *  older contract without `station_tokens`, which must not be reported as
   *  city 0. */
  fromCityIndex: number | null;
  /** The city it will occupy after the lay. */
  toCityIndex: number;
  /** How many cities the new tile carries, for "city 1 of 2". */
  toCityCount: number;
}

export interface TokenMigrationPreview {
  migrations: TokenMigration[];
  /** The hex gains city nodes, so the destination is one of several and the
   *  president would have a real choice if the message could carry it --
   *  design note #1. */
  ambiguous: boolean;
  /** Cities before and after, for the caption. */
  fromCityCount: number;
  toCityCount: number;
}

/** How many distinct city nodes the hex carries right now. */
function currentCityCount(mapGrid: MapGridResponse, q: number, r: number): number {
  switch (archetypeForHex(mapGrid, q, r)) {
    case "SingleCity":
      return 1;
    case "DoubleCity":
      return 2;
    default:
      return 0;
  }
}

/** Where every token on `(q, r)` lands if `tileId` is laid there.
 *
 *  `null` when nothing is standing on the hex, which is the common case and the
 *  one where the ring should say nothing at all -- a caption about token
 *  migration on an empty hex is noise on every ordinary tile lay. */
export function previewTokenMigration(
  mapGrid: MapGridResponse,
  q: number,
  r: number,
  companies: readonly StationTokenCompany[],
  tileId: number,
): TokenMigrationPreview | null {
  const here = companies.filter((company) =>
    company.station_token_hexes.some(([tq, tr]) => tq === q && tr === r),
  );
  if (here.length === 0) return null;

  const slots = tileCitySlotCounts(tileId);
  const toCityCount = slots.length;
  // A tile this build cannot describe: say nothing rather than guess a
  // destination. The ghost preview is already drawn from the same catalog,
  // so a gap here means the player is not seeing the tile either.
  if (toCityCount === 0) return null;

  const fromCityCount = currentCityCount(mapGrid, q, r);

  const migrations = here.map((company) => {
    const from = tokenCityIndex(company, q, r) ?? null;
    /* Design note #1: the index is PRESERVED. Clamped rather than allowed
       to overflow -- a two-city hex downgrading to one city is not a legal
       1830 lay, but a clamp costs nothing and a token drawn at city 1 of a
       one-city tile would be drawn nowhere. */
    const to = Math.min(Math.max(from ?? 0, 0), toCityCount - 1);
    return {
      companyId: company.company_id,
      ticker: company.ticker,
      fromCityIndex: from,
      toCityIndex: to,
      toCityCount,
    };
  });

  return {
    migrations,
    // Only a GAIN in city nodes creates a choice. A one-to-one upgrade puts
    // the token where the only city is, which is not a decision.
    ambiguous: toCityCount > Math.max(1, fromCityCount),
    fromCityCount,
    toCityCount,
  };
}

/** One line for the radial confirm ring, or `null` when there is nothing worth
 *  saying. Phrased as a statement of where the piece goes, because that is the
 *  question a president has when they see their own token on the hex they are
 *  about to rebuild. */
export function describeTokenMigration(preview: TokenMigrationPreview | null): string | null {
  if (!preview) return null;
  const { migrations, ambiguous, toCityCount } = preview;
  const named = migrations
    .map((entry) => `${entry.ticker} to city ${entry.toCityIndex + 1} of ${toCityCount}`)
    .join(", ");
  if (!ambiguous) {
    // One city on the far side: worth confirming the token survives, not
    // worth explaining a choice that does not exist.
    return toCityCount === 1 ? `Station token stays put (${named}).` : `Station token: ${named}.`;
  }
  return `This tile splits the hex into ${toCityCount} cities. ${named} — the tile lay cannot choose a different one.`;
}
