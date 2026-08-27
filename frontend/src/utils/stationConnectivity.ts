// frontend/src/utils/stationConnectivity.ts
//
// A station token is anchored to its NETWORK, not to a city index.
//
// ==================================================================
//  DESIGN NOTE 878: THE INDEX WAS A BOOKKEEPING ARTEFACT, ENFORCED AS A RULE
// ==================================================================
//
// REPORTED: "a station on a double city tile is not anchored to a particular city, it's anchored to its
// particular network ... if a Green OO has a station marker with connectivity to a specific hex, the only
// legal upgrades are those that preserve the station marker with that connectivity to that specific hex. In
// my current playthrough, upgrades to OO tiles are not preserving corporation station network connectivity."
//
// AND THE OLD RULE SAID SO IN SO MANY WORDS. `previewTokenMigration`'s design note #1: "the index is
// PRESERVED", implemented as `to = clamp(from)`. City 0 in, city 0 out -- on a tile the player is free to
// rotate, so "city 0" names a different corner of the board at each of six orientations. A token whose track
// ran east could come back facing west and still be called city 0.
//
// THE FUNCTION COULD NOT HAVE BEEN RIGHT, WHICH IS THE CLEAREST TELL: it took a `tileId` and no ORIENTATION.
// Connectivity is a property of the tile AS LAID, so a signature with no rotation in it cannot express the
// question, let alone answer it. The bug was visible in the parameter list before it was visible on a board.
//
// SO THE ANCHOR IS THE EDGE SET. A token's city touches some set of board edges today; after the upgrade it
// belongs in whichever city of the new tile still touches them. 1830's own upgrade rule guarantees such a
// city usually exists -- an upgrade must preserve all existing track -- so this is not inventing a
// constraint, it is READING one that the tile catalogue already encodes and the old code ignored.
//
// ==================================================================
//  ERIE IS THE EXCEPTION, AND IT IS AN EXCEPTION ABOUT CONNECTIVITY
// ==================================================================
//
// "ERIE is unusual because its home station can be placed on a city tile before that city has any track
// connecting it, and that is why upgrading the OO tile when ERIE's home station has already been laid
// requires allowing a player to rotate through all permutations. For every other OO tile, and for the Brown
// OO upgrade to ERIE's home station hex, the stations have a preexisting network connectivity that MUST be
// preserved."
//
// WHICH IS ONE RULE, NOT TWO. A token with no live edges has no network to preserve, so every city satisfies
// it vacuously and every orientation is legal -- that is ERIE at its first upgrade, falling out of the
// general rule rather than being special-cased by name. By the brown upgrade the same token has track, the
// edge set is non-empty, and it is constrained like everybody else. Nothing here mentions ERIE.
//
// #824 REACHED FOR THIS AND GRABBED THE WRONG QUANTITY. It made the choice available when the tile GAINED a
// city -- "Only a GAIN in city nodes creates a choice" -- which is a fact about the tile rather than about
// the token. The right question was never how many cities there are; it is whether this token has anything
// to lose.

/** What an upgrade does to one token, at one candidate orientation. */
export type StationFit =
  /** Exactly one city preserves this token's network; it goes there. */
  | { kind: "anchored"; cityIndex: number }
  /** The token has no network to preserve, so the president may put it in any city (ERIE's first upgrade). */
  | { kind: "free" }
  /** No city preserves it. This orientation is not a legal upgrade while that token stands here. */
  | { kind: "illegal" };

/** Where a token whose city currently touches `anchorEdges` lands on a candidate tile.
 *
 *  `candidateCityEdges` is one rotated edge list per city of the candidate, in city order -- exactly what
 *  `tileCityEdges` returns for each index (#877), so the rotation is applied once, in one place.
 *
 *  SUPERSET, NOT EQUALITY. An upgrade normally ADDS track: a green OO's city may gain a third exit in brown,
 *  and that is the point of upgrading. What may not happen is a city LOSING one of the token's existing
 *  connections, which is what the containment test refuses. */
export function fitStationToUpgrade(
  anchorEdges: readonly number[],
  candidateCityEdges: readonly (readonly number[])[],
): StationFit {
  /* NOTHING TO PRESERVE. Not "city 0 by default" -- the caller must be able to tell this apart, because it is
     the case where the president gets to choose and every orientation stays on the table. */
  if (anchorEdges.length === 0) return { kind: "free" };
  if (candidateCityEdges.length === 0) return { kind: "illegal" };

  const index = candidateCityEdges.findIndex((edges) =>
    anchorEdges.every((edge) => edges.includes(edge)),
  );
  return index === -1 ? { kind: "illegal" } : { kind: "anchored", cityIndex: index };
}

/** One token's current network, as the caller already knows it. */
export interface StationAnchor {
  companyId: number;
  /** Live, rotated board edges the token's city touches TODAY. Empty means nothing to preserve. */
  edges: readonly number[];
}

/** Every token's landing city on a candidate, or `null` if the candidate strands one of them.
 *
 *  `null` IS THE LEGALITY ANSWER and is why this returns a whole map rather than being called per token: an
 *  orientation is legal only if EVERY token on the hex survives it, so the caller filtering rotations needs
 *  one verdict rather than a list to reduce.
 *
 *  A `free` token maps to `null` inside the record rather than to a number: it survives, and it has no
 *  derived destination, and those are different facts from "it goes to city 0". */
export function fitStationsToUpgrade(
  anchors: readonly StationAnchor[],
  candidateCityEdges: readonly (readonly number[])[],
): Map<number, number | null> | null {
  const landing = new Map<number, number | null>();
  for (const anchor of anchors) {
    const fit = fitStationToUpgrade(anchor.edges, candidateCityEdges);
    if (fit.kind === "illegal") return null;
    landing.set(anchor.companyId, fit.kind === "anchored" ? fit.cityIndex : null);
  }
  return landing;
}
