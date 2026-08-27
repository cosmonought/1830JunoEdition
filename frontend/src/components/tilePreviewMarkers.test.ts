// frontend/src/components/tilePreviewMarkers.test.ts
//
// ==================================================================
//  DESIGN NOTES 486 / 488 (harness)
// ==================================================================
//
// Two bugs on the same screen, with opposite shapes.
//
//   #486 IS A DUPLICATE: the tile pipeline and the board's hex pass each
//   drew the "OO" restriction label, so an upgraded OO hex wore two. The
//   assertion is a COUNT, and it has to be a count -- both labels were
//   individually correct, correctly styled and correctly placed, which is
//   why nothing that checked either one in isolation ever caught it.
//
//   #488 IS AN OMISSION: the candidate thumbnails drew no station markers,
//   so an OO upgrade gave no way to see which city node a token lands on.
//   The assertion is an AGREEMENT -- between the marker's destination and
//   the caption's, which come from one `previewTokenMigration` call and must
//   never diverge (TD-1's near-miss duplicate class, in the version a player
//   actually sees: a sentence contradicting the picture beside it).
//
// THE CANVAS IS A RECORDING STUB, not a real one. These are drawing calls,
// and what is under test is WHICH calls happen and how many -- not what the
// pixels look like, which no assertion in this repo could check anyway. A
// Proxy records every method and swallows every property write, so the stub
// cannot drift out of date when the badge renderer starts setting some new
// context property.

import { TILE_CATALOG_BY_ID } from "./hexTileCatalog";
import { drawTileOverlays, restrictionLabelFor } from "./hexCanvasPrimitives";
import { tileCityAnchors, tileCitySlotCounts } from "./TileGraphics";
import { describeTokenMigration, planTokenUpgrade, previewTokenMigration } from "../utils/tokenMigration";
import type { MapGridResponse, StationTokenCompany } from "./hexContractTypes";

/** Every tile that carries a B/NY/OO label -- `restrictionLabelFor`'s own
 *  doc comment enumerates exactly these. Derived from the catalog rather
 *  than retyped, so a new restricted tile joins the test automatically.
 *
 *  The count below found a stale one: that comment said "nine" while listing
 *  ten (#53/#61 B, #54/#62 NY, #59/#64-#68 OO -- 2 + 2 + 6). The list was
 *  right and only the number was wrong. Corrected there; pinned here. */
const RESTRICTED_TILE_IDS: number[] = Array.from(TILE_CATALOG_BY_ID.keys())
  .filter((id) => restrictionLabelFor(TILE_CATALOG_BY_ID.get(id)!.terrain) !== null)
  .sort((a, b) => a - b);

interface Recorded {
  fn: string;
  args: unknown[];
}

function recordingContext(): { ctx: CanvasRenderingContext2D; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const own: Record<string, unknown> = {
    // The one method with a return value the drawing code actually reads.
    measureText: (text: string) => ({ width: String(text).length * 6 }),
    createLinearGradient: () => ({ addColorStop: () => undefined }),
    createRadialGradient: () => ({ addColorStop: () => undefined }),
    font: "10px sans-serif",
  };
  const ctx = new Proxy(own, {
    get(target, prop) {
      const key = String(prop);
      if (key in target) return target[key];
      return (...args: unknown[]) => {
        calls.push({ fn: key, args });
        return undefined;
      };
    },
    set(target, prop, value) {
      target[String(prop)] = value;
      return true;
    },
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

/** Every string this render painted, via `fillText`/`strokeText`. */
function paintedText(calls: Recorded[]): string[] {
  return calls
    .filter((call) => call.fn === "fillText" || call.fn === "strokeText")
    .map((call) => String(call.args[0]));
}

const CENTRE = { x: 50, y: 50 };
const SIZE = 40;

describe("design note 486: one restriction label per tile", () => {
  it("finds the ten restricted tiles", () => {
    // If the catalog filter ever returned nothing, every count below would
    // be vacuously true -- so the set is pinned by identity, not just size.
    expect(RESTRICTED_TILE_IDS).toEqual([53, 54, 59, 61, 62, 64, 65, 66, 67, 68]);
  });

  it("paints the label exactly once when it is enabled", () => {
    for (const tileId of RESTRICTED_TILE_IDS) {
      const entry = TILE_CATALOG_BY_ID.get(tileId)!;
      const label = restrictionLabelFor(entry.terrain)!;
      const { ctx, calls } = recordingContext();
      // `showRevenue` false so the only text this can paint is the label.
      drawTileOverlays(ctx, CENTRE, SIZE, entry, false, undefined, true);
      const painted = paintedText(calls).filter((text) => text === label);
      // ONE. Not "at least one" -- the bug drew two correct labels.
      expect(painted).toHaveLength(1);
    }
  });

  it("paints NO label when the board suppresses it", () => {
    // THE FIX. The board passes `false` because `drawRestrictionBadge`
    // already labels the hex, and on the board a restricted tile can only
    // ever sit on the hex carrying that badge.
    for (const tileId of RESTRICTED_TILE_IDS) {
      const entry = TILE_CATALOG_BY_ID.get(tileId)!;
      const label = restrictionLabelFor(entry.terrain)!;
      const { ctx, calls } = recordingContext();
      drawTileOverlays(ctx, CENTRE, SIZE, entry, false, undefined, false);
      expect(paintedText(calls).filter((text) => text === label)).toHaveLength(0);
    }
  });

  it("suppresses the label without suppressing the revenue badge", () => {
    /* The two gates are independent, and the ghost preview relies on that:
       it needs its value (nothing else draws one for an unlaid tile) and
       must not repeat the hex's letter. A single shared flag would have
       forced it to choose. */
    const entry = TILE_CATALOG_BY_ID.get(59)!; // green OO
    const { ctx, calls } = recordingContext();
    drawTileOverlays(ctx, CENTRE, SIZE, entry, true, 40, false);
    const painted = paintedText(calls);
    expect(painted).toContain("40");
    expect(painted).not.toContain("OO");
  });

  it("still labels an unrestricted tile with nothing at all", () => {
    // The control: #57 is the ordinary yellow city and carries no label,
    // enabled or not -- `restrictionLabelFor`'s own doc comment is explicit
    // that labelling it would tell the player something untrue.
    const entry = TILE_CATALOG_BY_ID.get(57);
    if (!entry) return;
    expect(restrictionLabelFor(entry.terrain)).toBeNull();
    const { ctx, calls } = recordingContext();
    drawTileOverlays(ctx, CENTRE, SIZE, entry, false, undefined, true);
    for (const text of paintedText(calls)) {
      expect(["B", "NY", "OO"]).not.toContain(text);
    }
  });
});

/* The OO upgrade the report is about: a yellow OO hex holding one token,
   being rebuilt as green #59, which carries two cities. */
const OO_HEX = { q: 1, r: 3 };
const GREEN_OO = 59;

/* Spelled out against the real interface with NO cast, deliberately. The
   first draft of this fixture wrote `station_tokens` as objects and reached
   for `as unknown as StationTokenCompany` to make it compile -- which is
   exactly the manoeuvre `trackContinuity.test.ts`' own note warns about
   ("Jest compiles through Babel and would not have noticed it missing"). It
   typechecked, then threw at runtime on the tuple destructure. The cast was
   the bug; the shape is `(q, r, city_index)`. */
const HOLDER: StationTokenCompany = {
  company_id: 1,
  ticker: "PRR",
  is_floated: true,
  station_token_hexes: [[OO_HEX.q, OO_HEX.r]],
  station_tokens: [[OO_HEX.q, OO_HEX.r, 1]],
};

const GRID: MapGridResponse = { game_id: 1, tiles: [] };

describe("design note 488: the marker and the caption are one answer", () => {
  it("puts a green OO tile's two cities where the anchors are", () => {
    // The premise. If #59 stopped reporting two cities the migration below
    // would be describing a tile that no longer splits anything.
    expect(tileCitySlotCounts(GREEN_OO)).toHaveLength(2);
    expect(tileCityAnchors(GREEN_OO, 0, CENTRE, SIZE)).toHaveLength(2);
  });

  it("leaves an unconnected token free, rather than preserving its index", () => {
    /* ==================================================================
        SUPERSEDED BY #878, AND THE FIXTURE WAS ERIE ALL ALONG
       ==================================================================
       THIS TEST READ:
         const preview = previewTokenMigration(GRID, OO_HEX.q, OO_HEX.r, [HOLDER], GREEN_OO);
         expect(preview!.migrations[0].toCityIndex).toBe(1);
       under the note "Design note #1 in `tokenMigration.ts`: a token in city `i` stays in city `i`. Not city
       0, which is what an 'arbitrary placement' bug does."
       IT WAS ASSERTING THE BUG. Reported: "a station on a double city tile is not anchored to a particular
       city, it's anchored to its particular network ... upgrades to OO tiles are not preserving corporation
       station network connectivity." A city index is a bookkeeping artefact; the network is the fact.
       AND THE FIXTURE MAKES THE POINT TWICE OVER. `GRID` is bare, so this token's city touches no live edges
       at all -- which is not the general case the test claimed to cover, it is precisely the ERIE case: "its
       home station can be placed on a city tile before that city has any track connecting it". The right
       answer here is that the president may put it in either city, and the old rule was quietly deciding for
       them. */
    const plan = planTokenUpgrade(GRID, OO_HEX.q, OO_HEX.r, [HOLDER], GREEN_OO, 0);
    expect(plan).not.toBeNull();
    expect(plan!.landings).toHaveLength(1);
    expect(plan!.landings[0].toCityIndex).toBeNull();
    expect(plan!.anyFree).toBe(true);
  });

  it("indexes a real anchor with the destination the caption names", () => {
    /* THE AGREEMENT, and the reason this test exists. The caption says
       "city N of M"; the marker is drawn at `anchors[toCityIndex]`. If the
       two were ever computed separately, one could name a city the other
       does not draw -- and the player would be looking at a sentence and a
       picture that contradict each other. */
    const preview = previewTokenMigration(GRID, OO_HEX.q, OO_HEX.r, [HOLDER], GREEN_OO);
    const caption = describeTokenMigration(preview);
    const migration = preview!.migrations[0];
    const anchors = tileCityAnchors(GREEN_OO, 0, CENTRE, SIZE);

    // The marker has somewhere real to land.
    expect(anchors[migration.toCityIndex]).toBeDefined();
    // And the caption is describing that same city, 1-based.
    expect(caption).toContain(`city ${migration.toCityIndex + 1} of ${anchors.length}`);
  });

  it("keeps the two anchors distinct, so the choice is visible", () => {
    // A preview that drew both cities at one point would satisfy every
    // assertion above and still answer nothing.
    const [a, b] = tileCityAnchors(GREEN_OO, 0, CENTRE, SIZE);
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(SIZE * 0.2);
  });

  it("says nothing at all about a hex with no tokens", () => {
    // The common case -- most lays are on empty cardboard, and a marker
    // pass there would be noise on every ordinary tile.
    expect(previewTokenMigration(GRID, OO_HEX.q, OO_HEX.r, [], GREEN_OO)).toBeNull();
  });
});
