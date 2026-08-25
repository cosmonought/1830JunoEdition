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
import { printedArtworkEdgePairs, tileCitySlotCounts } from "../components/TileGraphics";
import { STATIC_BOARD_HEXES } from "../components/hexBoardData";
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

/* ==================================================================
 *  DESIGN NOTE 824: THE INDEX WAS OURS, NOT THE BOARD'S
 * ==================================================================
 *
 * REPORTED: "when players place a station on the preprinted yellow ERIE hex, they have no idea what the
 * upgrade tile looks like or where their station will end up. When the tile finally gets upgraded to green,
 * they may discover that they want an orientation that forces a city into the gray E9 hex, which was unlikely
 * to have been their intention."
 *
 * AND THEN THE ARGUMENT THAT SETTLES IT: "in an actual physical game, when a player upgrades ERIE's home hex,
 * the station is removed from the board to place the new tile, then the player sets their token where they
 * want it. Because there is no marking for 'City 1' vs 'City 2' on the preprinted yellow hex, there is no way
 * to debate whether one city or the other is the correct one for the station marker when the Green tile is
 * laid."
 *
 * THAT IS NOT A HOUSE RULE, IT IS THE ABSENCE OF ONE. Design note #1 above declared "a token in city `i`
 * stays in city `i`, which is the ordinary 18xx upgrade rule" -- and it is, wherever `i` names something. On
 * a LAID tile it does: the two circles are drawn in different places and a marker sits visibly in one of
 * them. On the PREPRINTED yellow OO hex nothing distinguishes them. `tokenCityIndex` returns a number there
 * because our data model has to store the token somewhere, and #1 then enforced that bookkeeping artefact as
 * though the cardboard had said it.
 *
 * SO THIS IS THE SAME FAILURE AS EVERY OTHER ONE THIS WEEK, in its purest form yet: a surface asserting
 * something the board never said. The difference is that here the assertion was in a rule module and had a
 * design note defending it.
 *
 * WHAT IT COST, in the report's own words: "ERIE's president may lock themselves out of an orientation they
 * want and either have to accept suboptimal placement or force the game to undo back into a previous
 * Operating Round."
 *
 * THE REMEDY IS THE ONE THE REPORT ASKED FOR: "let players click through every possible Green tile upgrade
 * with the station marker on one city, then do it again on the other city." One extra dimension on the
 * rotation cycle, and no new control to learn.
 *
 * DESIGN NOTE #1'S OTHER HALF IS STILL TRUE AND IS THE REAL WORK: "`LayTile` carries a tile and an
 * orientation and nothing else, so a UI letting the president pick would collect an answer it cannot send."
 * That is why this was deferred rather than overlooked. It is fixed by carrying the answer -- `token_city` on
 * the message, flagged as a contract gap exactly like #808's `bypass`, and applied by the sandbox reducer
 * that is the authority today.
 */

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

/** The city indices a president may choose between when `tileId` is laid on `(q, r)`.
 *
 *  Design note #824. One entry is not a choice -- it is the preserved index, and every ordinary upgrade in
 *  the game returns exactly that. Two entries mean the board has never distinguished the token's city, so the
 *  president picks now, which is what the physical game does by lifting the marker off before laying.
 *
 *  EMPTY when nothing is standing here: no token, no question.
 *
 *  ==================================================================
 *   DESIGN NOTE 824a: I GENERALISED FROM THE SHAPE, NOT THE REASON
 *  ==================================================================
 *
 *  The first version tested "is there a laid tile" and said so proudly: "a preprinted double-city hex with no
 *  tile on it has two indistinguishable cities whoever owns the token -- which covers New York as well as
 *  Dunkirk & Buffalo." That is false, and it was corrected on report: "NY should not get the same treatment
 *  because the NNH home station is on a city with a route to it, and the connectivity of that station must be
 *  preserved. It would make no sense for NNH's station to be able to 'jump' to the disconnected city."
 *
 *  THE BOARD SAYS IT PLAINLY AND I COULD HAVE ASKED BEFORE GENERALISING. `printedArtworkEdgePairs` returns
 *  `[[1, null], [4, null]]` for G19 -- two cities, each with its OWN edge stub -- and `[]` for E11, which
 *  prints no track at all. New York's cities are told apart by what they connect to. Dunkirk & Buffalo's are
 *  two bare circles with nothing to tell apart.
 *
 *  SO THE TEST IS CONNECTIVITY, which is the real 1830 rule and was in the report all along: "a station can
 *  only be placed where there is route connectivity, and that connectivity must be preserved with every
 *  upgrade." A city with a connection keeps its token. A hex that prints nothing has no connection to
 *  preserve, which is why the physical game simply lifts the marker off.
 *
 *  IT SELECTS EXACTLY ONE HEX ON THIS BOARD, and the report said that too: "this situation in 1830 can only
 *  ever arise when the ERIE home station is placed before its hex has been upgraded from yellow to green."
 *  Still stated as a property rather than a name -- but no longer claiming more hexes qualify than do.
 *
 *  THE LESSON, and it is the second correction in two passes: I generalised from the SHAPE I had noticed (a
 *  preprinted double city) instead of from the REASON (nothing to preserve), and the shape caught a hex where
 *  the reason does not hold. A generalisation is only safe when what is general is the rule. */
export function tokenDestinationChoices(
  mapGrid: MapGridResponse,
  q: number,
  r: number,
  companies: readonly StationTokenCompany[],
  tileId: number,
): number[] {
  const preview = previewTokenMigration(mapGrid, q, r, companies, tileId);
  if (!preview || preview.migrations.length === 0) return [];

  const preserved = [preview.migrations[0].toCityIndex];

  /* A laid tile's circles are drawn in different places and the marker is visibly in one of them, so #1's
     preserve-the-index rule is a statement about the board rather than about our storage. */
  if (mapGrid.tiles.some((tile) => tile.q === q && tile.r === r)) return preserved;
  if (currentCityCount(mapGrid, q, r) < 2) return preserved;

  /* Design note #824a: AND THE CONNECTIVITY TEST, which is the one that matters. Any printed track on the hex
     means at least one city is reached by something, and a token in a connected city may not leave it. New
     York prints one stub per city; ERIE's home prints none. */
  const label = STATIC_BOARD_HEXES.find((hex) => hex.q === q && hex.r === r)?.label;
  if (label === undefined) return preserved;
  if (printedArtworkEdgePairs(label).length > 0) return preserved;

  /* Every city the NEW tile carries. A green OO upgrade has two; if a future tile had three this needs no
     edit, which is the point of counting rather than assuming. */
  return Array.from({ length: preview.toCityCount }, (_, index) => index);
}

/** One line for the radial confirm ring, or `null` when there is nothing worth
 *  saying. Phrased as a statement of where the piece goes, because that is the
 *  question a president has when they see their own token on the hex they are
 *  about to rebuild.
 *
 *  ==================================================================
 *   DESIGN NOTE 823: NOTHING CALLS THIS, AND THAT IS THE POINT
 *  ==================================================================
 *
 *  REQUESTED: "there is a tooltip that says 'Station marker on city 1 of 2' but nobody playing the game knows
 *  what that means. We can remove that string and have the preview render the station marker."
 *
 *  IT WAS ALWAYS STANDING IN FOR A PICTURE. "City 1 of 2" is an INDEX, and the two cities on an OO tile are
 *  told apart by where they sit rather than by an order anybody can see. The sentence existed because the
 *  preview could not show the answer; #822 made it able to, so the drawing replaces the coordinate.
 *
 *  KEPT RATHER THAN DELETED, which is the opposite of what #660a usually argues, and deliberately: the
 *  MIGRATION ARITHMETIC above it is live -- every radial thumbnail asks it where a token lands -- and this is
 *  the one place that arithmetic is stated in words. `tokenMigration.test.ts` reads it, which is a real
 *  reader even if no player is. If a future surface needs to SAY where a token goes rather than draw it, this
 *  is the wording, already argued over.
 *  The line it printed, for the record: "This tile splits the hex into 2 cities. ERIE to city 1 of 2 — the
 *  tile lay cannot choose a different one." */
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
