// frontend/src/utils/tileUpgrades.ts
//
// Which tile becomes which -- DERIVED, never authored.
//
// Design note #675: THE REFERENCE MUST NOT BE A SECOND OPINION.
//
// REQUESTED: a Tiles tab. 18xx.games has one and it lists the tray and its
// supply; what it does not show is upgrade paths, "especially the strangeness
// of OO tiles and other restrictions".
//
// The obvious implementation is a hand-written table: #57 -> [14, 15], and so
// on down the tray. It is also the wrong one, and the reason is the whole point
// of this module. `sandboxTileLegality.ts` already decides what may replace
// what -- tier step, letter code, centre parity, strict path preservation on
// SEGMENTS rather than edge sets -- and it decides it for the board. A second
// table would answer the same question in a second place, and the first time
// the two disagreed the reference would be teaching players a rule the game
// refuses to enforce. That is worse than having no reference: a player who
// distrusts the board is stuck, but a player who trusts a wrong tab loses a
// turn to it.
//
// SO THIS ASKS THE REAL FILTER. `filterSandboxPlacements` is run against the
// REAL BOARD: lay a tile on every hex that legally accepts it, ask what may
// replace it there, and union the answers. Nothing here restates a rule. If the
// contract's mirror changes, this graph changes with it and no edit is needed.
//
// WHAT THE DERIVATION FOUND, and none of it is in any table anybody would have
// thought to write:
//
//   THE OO CHAIN HAS NO YELLOW TILE. E5, D10, E11 and H18 are PREPRINTED yellow
//   on the board (`hexBoardData` -- two revenue-earning cities with no track
//   joining them). There is no OO tile in the tray to look up, so the chain
//   starts at green #59 -- of which there are TWO, against four OO hexes.
//   `PRINTED_START` is how that appears here rather than as an absence.
//
//   THE SAME IS TRUE OF BOSTON AND NEW YORK, for one hex each.
//
//   AND FIVE YELLOW TILES ARE DEAD ENDS. #1, #2, #55, #56 and #69 are the
//   two-town tiles, and 1830 prints no green tile with two towns -- so laying
//   one fixes that hex at yellow for the rest of the game. Nobody would author
//   that into a table; it falls out of centre parity, which is exactly why the
//   derivation is worth its cost.
//
// COMPUTED ONCE AND CACHED. The sweep is real work -- every board hex, every
// tier -- so it runs on first ask and never again.
//
// See docs/ai_architecture/hex_tile_math.md, tileUpgrades.ts #675.

import {
  TILE_CATALOG_BY_ID,
  type TileColorTier,
} from "../components/hexTileCatalog";
import { STATIC_BOARD_HEXES } from "../components/hexBoardData";
import { filterSandboxPlacements, hexLabelRestriction } from "../components/sandboxTileLegality";
import type { LegalTilePlacement, MapGridResponse, MapTileEntry } from "../components/hexContractTypes";

/** Ascending, and the only place this module states the order -- everything
 *  else asks the filter. */
const TIERS: readonly TileColorTier[] = ["Yellow", "Green", "Brown"];

function nextTier(tier: TileColorTier): TileColorTier | null {
  const at = TIERS.indexOf(tier);
  return at < 0 || at === TIERS.length - 1 ? null : TIERS[at + 1];
}

/** The whole tray at every facing -- the unfiltered input the contract's own
 *  `GetLegalTilePlacements` would hand back before any rule applies. */
const ALL_PLACEMENTS: readonly LegalTilePlacement[] = (() => {
  const out: LegalTilePlacement[] = [];
  TILE_CATALOG_BY_ID.forEach((_entry, tileId) => {
    for (let orientation = 0; orientation < 6; orientation += 1) {
      out.push({ tile_id: tileId, orientation });
    }
  });
  return out;
})();

const BARE: MapGridResponse = { game_id: 0, tiles: [] };

function boardWith(q: number, r: number, tileId: number, orientation: number): MapGridResponse {
  const tile: MapTileEntry = { q, r, tile_id: tileId, orientation, landmark: null };
  return { game_id: 0, tiles: [tile] };
}

/** One legal facing per tile id, here, at this era.
 *
 *  THE FACING IS PART OF THE ANSWER, and laying at orientation 0 regardless was
 *  wrong in a way that only showed up on one hex. `staysOnBoard` (#7) refuses a
 *  facing whose rail would run off the map, so New York's #54 is legal at G19
 *  at some rotations and not at 0 -- and a board with #54 sitting at 0 is a
 *  position that cannot occur. Asked what replaces it, the filter correctly
 *  answered "nothing", and the reference would have reported that New York can
 *  never reach brown. Every successor has to be sought from a board the game
 *  could actually be in. */
function legalHeadingsAt(
  mapGrid: MapGridResponse,
  q: number,
  r: number,
  era: TileColorTier,
): Array<{ tileId: number; orientation: number }> {
  const allowed = filterSandboxPlacements(ALL_PLACEMENTS, { mapGrid, q, r, era });
  const firstFacing = new Map<number, number>();
  for (const placement of allowed) {
    if (!firstFacing.has(placement.tile_id)) firstFacing.set(placement.tile_id, placement.orientation);
  }
  return Array.from(firstFacing, ([tileId, orientation]) => ({ tileId, orientation }));
}

/** The node a chain starts from when the board itself is the first tile --
 *  design note #675's OO/Boston/New York case. Not a tile id, because there is
 *  no tile: modelling it as one would mean inventing a tray entry to explain
 *  why the tray has no entry. */
export const PRINTED_START = "printed" as const;

export interface TileUpgradeGraph {
  /** Successors, keyed by tile id. Present for every catalog tile; empty for a
   *  brown tile and for a yellow dead end, which are different facts the
   *  caller distinguishes by tier. */
  successors: ReadonlyMap<number, readonly number[]>;
  /** What each restricted hex family's PREPRINTED yellow start upgrades into.
   *  Keyed by the letter code the board prints. */
  printedStarts: ReadonlyMap<"OO" | "B" | "NY", readonly number[]>;
  /** Hex labels whose first tile comes off the board rather than the tray,
   *  by family -- so the panel can say which hexes a chain is even about. */
  printedHexes: ReadonlyMap<"OO" | "B" | "NY", readonly string[]>;
}

let cached: TileUpgradeGraph | null = null;

/** The graph. Swept once from the real board and the real filter.
 *
 *  A UNION ACROSS EVERY HEX THAT ACCEPTS THE TILE, not one representative:
 *  `staysOnBoard` (#7) rejects a facing whose rail would run off the map, so a
 *  rim hex can refuse a tile the same tile family accepts three hexes inland.
 *  Sampling one hex would report that geographic accident as a rule about the
 *  tile. */
export function tileUpgradeGraph(): TileUpgradeGraph {
  if (cached) return cached;

  const successors = new Map<number, Set<number>>();
  TILE_CATALOG_BY_ID.forEach((_entry, tileId) => successors.set(tileId, new Set()));
  const printedStarts = new Map<"OO" | "B" | "NY", Set<number>>();
  const printedHexes = new Map<"OO" | "B" | "NY", string[]>();

  /* THE WALK HAS TO BE A WALK, and the first draft was not. Asking the bare
     board what is legal "at the Green era" returns YELLOW tiles: rule 4 wants
     exactly one tier above what is there, and bare ground is rank -1 whatever
     era the room is in. So no green tile was ever laid, no green tile was ever
     asked what replaces it, and every city tile came back a dead end -- a
     confident, uniform, entirely wrong answer.
     A tile's successors are only visible from a board that HAS it. Hence the
     descent: lay, ask, lay what came back, ask again. */
  const walk = (
    q: number,
    r: number,
    tileId: number,
    orientation: number,
    tier: TileColorTier,
  ) => {
    const after = nextTier(tier);
    if (!after) return;
    const bucket = successors.get(tileId);
    const board = boardWith(q, r, tileId, orientation);
    for (const heading of legalHeadingsAt(board, q, r, after)) {
      const entry = TILE_CATALOG_BY_ID.get(heading.tileId);
      if (!entry || entry.color !== after) continue;
      bucket?.add(heading.tileId);
      walk(q, r, heading.tileId, heading.orientation, after);
    }
  };

  for (const hex of STATIC_BOARD_HEXES) {
    const { q, r, label } = hex;

    /* A preprinted hex's own successors, read off the BARE board: the filter
       already counts a printed tier as rank 0 (#3), so asking at Green here
       answers "what does the board's own tile become". */
    const restriction = hexLabelRestriction(BARE, q, r);
    const preprinted = hex.printedColor === "Yellow";

    if (restriction && preprinted) {
      const seenHexes = printedHexes.get(restriction) ?? [];
      if (!seenHexes.includes(label)) seenHexes.push(label);
      printedHexes.set(restriction, seenHexes);
      const starts = printedStarts.get(restriction) ?? new Set<number>();
      for (const heading of legalHeadingsAt(BARE, q, r, "Green")) {
        starts.add(heading.tileId);
        walk(q, r, heading.tileId, heading.orientation, "Green");
      }
      printedStarts.set(restriction, starts);
      continue;
    }

    /* An ordinary hex starts from the tray. Every yellow tile the board would
       accept here is laid in turn and the descent runs from it. */
    for (const heading of legalHeadingsAt(BARE, q, r, "Yellow")) {
      walk(q, r, heading.tileId, heading.orientation, "Yellow");
    }
  }

  cached = {
    successors: new Map(
      Array.from(successors, ([tileId, set]) => [
        tileId,
        Array.from(set).sort((a, b) => a - b),
      ]),
    ),
    printedStarts: new Map(
      Array.from(printedStarts, ([code, set]) => [code, Array.from(set).sort((a, b) => a - b)]),
    ),
    printedHexes: new Map(
      Array.from(printedHexes, ([code, labels]) => [code, [...labels].sort()]),
    ),
  };
  return cached;
}

/** What `tileId` may be upgraded to. Empty for a brown tile, and empty for a
 *  yellow dead end -- the panel tells the two apart by the tile's own tier,
 *  because "nothing follows brown" and "nothing follows this" are different
 *  things to say to a player. */
export function tileUpgradeTargets(tileId: number): readonly number[] {
  return tileUpgradeGraph().successors.get(tileId) ?? [];
}

/** Which tiles could be replaced BY `tileId` -- the graph read backwards, for
 *  a panel row that wants to say where a green tile came from. */
export function tileUpgradeSources(tileId: number): readonly number[] {
  const out: number[] = [];
  tileUpgradeGraph().successors.forEach((targets, from) => {
    if (targets.includes(tileId)) out.push(from);
  });
  return out.sort((a, b) => a - b);
}

/** True when this tile is the end of its line while cheaper tiers remain --
 *  #55 on a double-town hex, which fixes that hex at yellow for the game.
 *  FALSE for brown, which is the top tier and ends every line by design. */
export function isUpgradeDeadEnd(tileId: number): boolean {
  const entry = TILE_CATALOG_BY_ID.get(tileId);
  if (!entry || entry.color === "Brown") return false;
  return tileUpgradeTargets(tileId).length === 0;
}

/** Test seam: drops the cached sweep so a test can rebuild it. Never called by
 *  the app -- the board does not change within a session. */
export function resetTileUpgradeGraph(): void {
  cached = null;
}
