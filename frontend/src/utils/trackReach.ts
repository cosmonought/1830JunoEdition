// frontend/src/utils/trackReach.ts
//
// Which hexes a corporation may lay track on -- the board-dimming set.
//
// ===================================================================
//  DESIGN NOTE 0: A HINT ABOUT REACH, NOT A RULING ABOUT LEGALITY
// ===================================================================
//
// 18xx.games dims the board during a tile lay and lights only the hexes you
// may build on. That is a genuine usability feature rather than decoration:
// 1830's board is 100-odd hexes and a corporation can usually build on three
// or four of them, so without it the player's first move is to work out
// where their own network ends -- every turn, by eye.
//
// WHAT THIS ANSWERS. "Does this corporation's track reach this hex?" That is
// a connectivity question over data already on the client: the corporation's
// station tokens, and which edges of each hex carry rails.
//
// WHAT THIS DOES NOT ANSWER, and must never grow to:
//
//   - WHETHER A GIVEN TILE FITS. Upgrade topology, colour tier, path
//     preservation and the restricted "B"/"NY"/"OO" set are
//     `hexmap::execute_lay_tile`'s, mirrored client-side for the picker by
//     `sandboxTileLegality`. This says which HEXES to offer, not which tiles.
//   - THE ONE-TILE-PER-TURN RULE, or the extra lay a private company grants.
//   - TOKEN BLOCKING. A city whose slots are full stops a ROUTE, not a lay.
//   - WHETHER IT IS THIS CORPORATION'S TURN.
//
// So the contract still rejects anything illegal that slips through, and the
// UI still shows the reason. The consequence of this file being wrong is a
// hex that is dimmed when it should not be -- an inconvenience -- rather
// than an illegal action being accepted. That asymmetry is why the fallback
// below opens the board up rather than closing it down.
//
// ===================================================================
//  DESIGN NOTE 1: CONNECTIVITY IS CHECKED FROM BOTH SIDES
// ===================================================================
//
// Two hexes are joined when A carries a live edge pointing at B AND B
// carries the matching edge pointing back -- the same rule
// `routeAutoTrace.ts` uses, and for the same reason: a dead-end stub
// (Richmond's single edge, New York's two disconnected spurs) otherwise
// reads as connected to whatever sits beyond it.
//
// `liveEdgesForHex` resolves the four sources of track -- a laid tile's
// rotated mask, a preprinted gray hex, an off-board stub, a landmark's
// segments -- so this file asks it rather than knowing about any of them.

import {
  HEX_NEIGHBOR_OFFSETS,
  evaluateHexForTileLaying,
  liveEdgesForHex,
} from "../components/hexGeometry";
import type { MapGridResponse } from "../components/hexContractTypes";
import { neighbourAcross, traversalsFrom } from "./trackSegments";
import { STATIC_BOARD_HEXES } from "../components/hexBoardData";

/** `"q,r"` -- the key every consumer of this module indexes by. */
export function hexKey(q: number, r: number): string {
  return `${q},${r}`;
}

/* ==================================================================
 *  DESIGN NOTE 483: A NETWORK ENDS AT PORTS, NOT AT HEXES
 * ==================================================================
 *
 * REPORTED: the network calculator traces connectivity through
 * discontinuous track on a hex, so two separate curves on one tile are
 * treated as joined and illegal placements are offered.
 *
 * Design note #4 below fixed HALF of this. The BFS was made to walk
 * `(hex, arrivalEdge)` states through `traversalsFrom`, so the walk itself
 * is strict: a crossover entered on one straight no longer licenses the
 * other. What it produced was still a set of HEX keys -- and everything
 * downstream then asked that set the hex-as-a-node question all over again:
 *
 *   `extensionNeighbours` took a network hex and offered a build across
 *   EVERY live edge of it, read straight off `liveEdgesForHex`. So a
 *   corporation whose rail reaches edge 0 of a #20 crossover was offered
 *   tile lays beyond edges 1 and 4 -- exactly the reported bug, one layer
 *   below where the fix was applied.
 *
 *   `sandboxTileLegality.orientationJoinsNetwork` did the same for
 *   ROTATIONS: it asked whether a neighbouring hex was in the network and
 *   whether that neighbour carried rail to the shared edge, which is true
 *   of the far arm of a crossover the corporation cannot reach.
 *
 * The strictness was being computed and then thrown away. A hex key cannot
 * express "reached, but only on this rail", so any consumer holding one has
 * to re-derive the missing half, and both of them re-derived it wrongly.
 *
 * A PORT IS THE MISSING VALUE: `"q,r:edge"`, meaning the corporation's own
 * track reaches the inside of this hex AT this edge. It is produced by the
 * same walk that produces the hex set, so the two cannot disagree, and it
 * is what both consumers above actually needed.
 */
export function portKey(q: number, r: number, edge: number): string {
  return `${q},${r}:${edge}`;
}

const BOARD_KEYS: ReadonlySet<string> = new Set(
  STATIC_BOARD_HEXES.map((hex) => hexKey(hex.q, hex.r)),
);

/* `connectedNeighbours` is GONE with design note #4. It answered "which
   hexes does this one carry rail toward", which is the hex-as-a-node model
   that let a network bleed across a crossover's two separate straights.
   `trackSegments.neighbourAcross` replaces it and keeps the both-sides
   rule; the missing half -- WHICH rail -- comes from `traversalsFrom`.

   Deleted rather than left unused so nothing can quietly start calling the
   old model again. `extensionNeighbours` below is a different question and
   stays. */

/* ==================================================================
 *  DESIGN NOTE 3: A TILE LAY EXTENDS A ROUTE; IT DOES NOT TOUCH A HEX
 * ==================================================================
 *
 * REPORTED BUG: the veil lights every hex surrounding the corporation's
 * station.
 *
 * It did, because this used to be `boardNeighbours` -- all six neighbours of
 * every network hex, on the reasoning that "a tile lay EXTENDS a network, so
 * the hex being built on is by definition one the existing track does not
 * reach yet; adjacency is the test, not connectivity."
 *
 * The first half of that is right and the conclusion does not follow. The
 * NEW hex has no track, true -- but the lay still has to join the network,
 * and a network only offers a join where its own track ENDS AT AN EDGE. PRR
 * sitting on H12 (Altoona, printed track on edges 0 and 3) can extend west
 * to H10 and east to H14 and nowhere else: the other four sides of that hex
 * are blank cardboard with no rail reaching them, so a tile laid there would
 * touch Altoona without connecting to it.
 *
 * Six lit hexes where two are legal is not a small over-count. It is the
 * feature inverted -- the player is told to consider four placements the
 * contract will reject, on the one screen whose whole job is to say which
 * placements are worth considering.
 *
 * THE TEST IS ONE-SIDED, and that is the difference from
 * `connectedNeighbours` above. Joining an EXISTING network needs both hexes
 * to carry matching rail; extending it needs only the network side to offer
 * an edge, because the tile about to be laid is what will supply the other
 * half. Using the two-sided test here would light nothing at all on a fresh
 * board, since no unbuilt neighbour has track yet.
 */
/* Design note #483: takes a PORT, not a hex. The old signature was
   `(mapGrid, q, r)` and it read `liveEdgesForHex` itself -- which is the
   line that offered builds across a crossover's far arm, because every live
   edge of a reached hex looked like an edge the corporation had reached.
   The edge is now supplied by the walk that proved it reachable. */
function extensionAcross(
  q: number,
  r: number,
  edge: number,
): { q: number; r: number } | null {
  const offset = HEX_NEIGHBOR_OFFSETS[edge];
  if (!offset) return null;
  const nq = q + offset[0];
  const nr = r + offset[1];
  if (!BOARD_KEYS.has(hexKey(nq, nr))) return null;
  return { q: nq, r: nr };
}

export interface LayableHexInput {
  mapGrid: MapGridResponse;
  /** The acting corporation's station tokens, as `(q, r)` pairs. */
  stationHexes: ReadonlyArray<readonly [number, number]>;
}

export interface LayableHexResult {
  /** `hexKey` of every hex this corporation may build on -- the glow set. */
  hexes: ReadonlySet<string>;
  /* ==================================================================
   *  DESIGN NOTE 4: THE NETWORK IS SHOWN, NOT HIDDEN
   * ==================================================================
   *
   * REPORTED BUG: the board dims aggressively and hides the corporation's
   * own network during a tile lay.
   *
   * The first cut veiled everything except the legal targets, which is the
   * obvious reading of "dim what you cannot act on" and the wrong one. A
   * player choosing WHERE to extend is reasoning about the route the
   * extension would join -- where their track already runs, which cities it
   * already reaches, how far it is from somebody else's. Dimming exactly
   * that leaves the legal hexes lit and the reason for choosing between them
   * in the dark.
   *
   * So the veil now has three tiers rather than two: the corporation's own
   * NETWORK stays at full brightness, the legal EXTENSIONS are lit and
   * glowed, and everything else recedes. This field is the first of those,
   * returned alongside the glow set rather than derived by the caller --
   * they must be the same walk, or the two halves of one picture would
   * disagree about where the network ends.
   */
  network: ReadonlySet<string>;
  /** Design note #483: the reachable edges of that network, `"q,r:edge"`.
   *  Carried out to the rotation filter, which needs to know WHICH edge of a
   *  network hex the corporation can join -- a question the hex set cannot
   *  answer and which every consumer that tried to re-derive it got wrong. */
  ports: ReadonlySet<string>;
  /** The connected network the set was grown from, for the caller's own
   *  messaging ("your network reaches N hexes"). */
  networkSize: number;
  /** True when the answer is "everything the board allows" rather than a
   *  real reach computation -- see `layableHexes`' fallback. A caller should
   *  NOT dim the board in that case: dimming nothing is honest, dimming
   *  everything-but-a-guess is not. */
  unconstrained: boolean;
}

/* ==================================================================
 *  DESIGN NOTE 2: WHY A CORPORATION WITH NO TOKEN IS UNCONSTRAINED
 * ==================================================================
 *
 * A corporation that has floated but not yet placed its home token has no
 * network, so a strict reading of this file would return the empty set and
 * the UI would dim the ENTIRE board with nothing lit. The player would be
 * told, wordlessly, that they may not build anywhere -- which is both wrong
 * (their first lay is the home hex) and indistinguishable from a broken
 * feature.
 *
 * The same applies before the first `GetGameState` resolves, and in any
 * build whose chain does not report `station_token_hexes` at all.
 *
 * So "I do not know where this corporation's network is" returns
 * `unconstrained`, and the caller leaves the board undimmed and every legal
 * hex clickable. The contract remains the authority either way; the only
 * thing lost is the hint. Erring the other way would take the board away
 * from the player over missing data.
 */
/** Every hex the corporation's track physically reaches from its tokens --
 *  the connected component, before any question of what may be BUILT there.
 *
 *  Exported because two features need the same walk and must not disagree
 *  about it: the tile-lay veil below grows this set by one hex, and station
 *  placement (`utils/stationTokens.ts`) tests membership directly. A second
 *  BFS with its own subtly different adjacency rule is exactly how "the
 *  board says I can build here but the token button says I cannot" happens.
 *
 *  Empty when the corporation has no token on a real board hex. */
/* ==================================================================
 *  DESIGN NOTE 4: A NETWORK FOLLOWS RAILS, NOT HEX ADJACENCY
 * ==================================================================
 *
 * REPORTED: legal network expansion bleeds across the disconnected tracks
 * on tiles that carry more than one.
 *
 * It did, and the cause is one line further down than it looks. The walk
 * below was hex-to-hex: reach a hex, then reach every hex it carries rail
 * toward. That treats a hex as a NODE where everything meets, which is true
 * of most tiles and false of exactly the ones this matters on -- #20 is two
 * separate straights, the OO tiles are two separate stations, New York is
 * two spurs that never touch. Reaching such a hex on one rail was taken as
 * reaching everything beyond ALL of its rails.
 *
 * Measured on the real board before the fix: a three-hex patch with #20 in
 * the middle reported the far hex as networked, across two rails with no
 * connection between them. A corporation was being offered tile lays it
 * could not legally make, on the one screen whose whole job is to say which
 * lays are worth considering.
 *
 * THE WALK IS OVER (HEX, ARRIVAL EDGE) STATES NOW. Arriving at a hex by one
 * edge only licenses the exits that edge actually joins --
 * `traversalsFrom`, which resolves the authored rails rather than the edge
 * mask. A crossover is entered twice, once per straight, and each visit
 * carries only its own onward reach.
 *
 * THE STATION HEXES THEMSELVES ARE UNRESTRICTED, and that is not a
 * shortcut: a route starts AT a token, inside the city, so every rail
 * leaving that city is available to it. There is no arrival edge to
 * constrain a start.
 */
export interface ReachableTrack {
  /** Every hex the corporation's rails physically reach. */
  hexes: Set<string>;
  /* ==================================================================
   *  DESIGN NOTE 483 (cont.): WHAT THE PORT SET IS FOR
   * ==================================================================
   *
   * `portKey(q, r, edge)` for every edge the walk PROVED reachable -- an
   * edge the corporation's own continuous track arrives at from inside the
   * hex. Two consumers need it and neither can derive it from `hexes`:
   *
   *   THE TILE-LAY EXTENSION. A build joins the network only across an edge
   *   the network actually reaches, so the candidate hexes are the
   *   neighbours across these ports and nothing else.
   *
   *   THE ROTATION FILTER (`sandboxTileLegality`). An orientation survives
   *   only if one of its live edges faces a port, rather than merely facing
   *   a hex that happens to be in the network.
   *
   * INCLUDES EDGES WITH NOTHING BEYOND THEM, deliberately. `hexes` only
   * grows across a two-sided join (design note #1), because a network
   * cannot flow into bare cardboard -- but bare cardboard is exactly where
   * a tile gets laid, so the port survives where the hex does not.
   */
  ports: Set<string>;
}

/** The walk, with both of its results. `reachableNetwork` below is this
 *  function's `hexes` and exists because most callers want only that. */
export function reachableTrack(
  mapGrid: MapGridResponse,
  stationHexes: ReadonlyArray<readonly [number, number]>,
): ReachableTrack {
  const hexes = new Set<string>();
  const ports = new Set<string>();
  /** `q,r:arrivalEdge` -- one hex may legitimately be entered several ways. */
  const visited = new Set<string>();
  const queue: Array<{ q: number; r: number; arrivalEdge: number | null }> = [];

  for (const [q, r] of stationHexes) {
    if (!BOARD_KEYS.has(hexKey(q, r))) continue;
    hexes.add(hexKey(q, r));
    // `null` arrival: a station is entered from inside, so every rail on it
    // is available.
    queue.push({ q, r, arrivalEdge: null });
  }

  while (queue.length > 0) {
    const at = queue.shift()!;
    const stateKey = `${hexKey(at.q, at.r)}:${at.arrivalEdge ?? "start"}`;
    if (visited.has(stateKey)) continue;
    visited.add(stateKey);

    /* Which edges may this visit leave by? From a station, all of them.
       Having arrived on a rail, only the edges that rail reaches.

       `traversalsFrom` is the strict half: it asks `traversalSegments` for
       the authored rail joining the two edges and drops the pair when there
       is none. That is what makes two curves on one tile two curves rather
       than a junction. */
    const exits =
      at.arrivalEdge === null
        ? liveEdgesForHex(mapGrid, at.q, at.r)
        : traversalsFrom(mapGrid, at.q, at.r, at.arrivalEdge).map((t) => t.exitEdge);

    for (const edge of exits) {
      /* Design note #483: recorded BEFORE the two-sided join is tested. An
         edge the corporation's track runs to is reached whether or not
         anything sits beyond it -- and the case where nothing does is the
         one a tile lay is for. */
      ports.add(portKey(at.q, at.r, edge));

      const next = neighbourAcross(mapGrid, at.q, at.r, edge);
      if (!next) continue;
      hexes.add(hexKey(next.q, next.r));
      queue.push({ q: next.q, r: next.r, arrivalEdge: next.arrivalEdge });
    }
  }
  return { hexes, ports };
}

export function reachableNetwork(
  mapGrid: MapGridResponse,
  stationHexes: ReadonlyArray<readonly [number, number]>,
): Set<string> {
  return reachableTrack(mapGrid, stationHexes).hexes;
}

export function layableHexes(input: LayableHexInput): LayableHexResult {
  const { mapGrid, stationHexes } = input;

  const roots = stationHexes.filter(([q, r]) => BOARD_KEYS.has(hexKey(q, r)));
  if (roots.length === 0) {
    return {
      hexes: new Set(),
      network: new Set(),
      ports: new Set(),
      networkSize: 0,
      unconstrained: true,
    };
  }

  const { hexes: network, ports } = reachableTrack(mapGrid, roots);

  // ---- Grow it along its own rails, then keep only what can take a tile.
  //
  // A lay is legal on a hex the network REACHES: either one already in the
  // network (an upgrade of track the corporation runs on) or one its track
  // actually exits toward (an extension -- design note #3, which is where
  // the "every surrounding hex" bug lived). `evaluateHexForTileLaying` then
  // removes what the static board forbids anywhere: open water, off-board
  // terminals, the preprinted gray hexes that are already their final tile.
  //
  /* Design note #483: the extension candidates come from PORTS. This used to
     iterate the network's hexes and read every live edge off each one, which
     re-introduced the hex-as-a-node model the walk had just finished
     rejecting -- a crossover reached on one straight offered builds beyond
     the other. Iterating ports instead means an extension is offered across
     exactly the edges the corporation's own continuous track arrives at. */
  const candidates = new Set<string>(network);
  ports.forEach((port) => {
    const [coords, edgeText] = port.split(":");
    const [q, r] = coords.split(",").map(Number);
    const next = extensionAcross(q, r, Number(edgeText));
    if (next) candidates.add(hexKey(next.q, next.r));
  });

  const hexes = new Set<string>();
  candidates.forEach((key) => {
    const [q, r] = key.split(",").map(Number);
    if (evaluateHexForTileLaying(q, r, mapGrid).eligible) hexes.add(key);
  });

  return { hexes, network, ports, networkSize: network.size, unconstrained: false };
}
