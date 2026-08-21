// frontend/src/utils/trackReach.ts
//
// Which hexes a corporation may lay track on -- the board-dimming set.
//
// Design note #0: A HINT ABOUT REACH, NOT A RULING ABOUT LEGALITY. 18xx.games dims the board during a tile lay
// and lights only the buildable hexes, which is a genuine usability feature: 1830's board is 100-odd hexes and
// a corporation can usually build on three or four, so without it the player's first move is to work out where
// their own network ends -- every turn, by eye.
// WHAT THIS DOES NOT ANSWER, and must never grow to: whether a given TILE fits (that is
// `hexmap::execute_lay_tile`'s, mirrored for the picker by `sandboxTileLegality`); the one-tile-per-turn rule;
// token blocking (a full city stops a ROUTE, not a lay); or whether it is this corporation's turn.
// The consequence of this file being wrong is a hex dimmed when it should not be -- an inconvenience -- rather
// than an illegal action being accepted, which is why the fallback opens the board up rather than closing it.
//
// Design note #1: connectivity is checked from BOTH SIDES -- a dead-end stub otherwise reads as connected to
// whatever sits beyond it. `liveEdgesForHex` resolves the four sources of track, so this file asks it rather
// than knowing about any of them.
//
// Design notes #2/#3/#4/#483: see `docs/ai_architecture/routing_pathfinding.md`.

/* Design note #686: `liveEdgesForHex` is no longer imported here. The one line that called it -- the start of
   the walk, taking every rail on a station's hex -- now asks `cityExitEdges`, which answers the same question
   for a hex with one city and a narrower one for a hex with two.
   Dropped rather than left imported: this file's whole history is the hex-as-a-node model being removed one
   caller at a time (#4, #483, and now this), and an unused import of the function that embodies it is an
   invitation to reach for it again. */
import {
  HEX_NEIGHBOR_OFFSETS,
  cityExitEdges,
  evaluateHexForTileLaying,
} from "../components/hexGeometry";
import type { MapGridResponse } from "../components/hexContractTypes";
import { neighbourAcross, traversalsFrom } from "./trackSegments";
import { STATIC_BOARD_HEXES } from "../components/hexBoardData";

/** `"q,r"` -- the key every consumer of this module indexes by. */
export function hexKey(q: number, r: number): string {
  return `${q},${r}`;
}

/* Design note #483: A NETWORK ENDS AT PORTS, NOT AT HEXES. #4 fixed HALF of this -- the BFS was made to walk
   `(hex, arrivalEdge)` states, so the walk itself is strict. What it produced was still a set of HEX keys, and
   everything downstream then asked that set the hex-as-a-node question all over again:
     `extensionNeighbours` offered a build across EVERY live edge of a network hex, so a corporation reaching
     edge 0 of a #20 crossover was offered lays beyond edges 1 and 4 -- the reported bug, one layer below the fix.
     `sandboxTileLegality`'s rotation filter did the same, asking whether a neighbour was in the network and
     carried rail to the shared edge -- true of the far arm of a crossover the corporation cannot reach.
   The strictness was being computed and then thrown away. A hex key cannot express "reached, but only on this
   rail", so any consumer holding one has to re-derive the missing half, and both of them re-derived it wrongly.
   A PORT IS THE MISSING VALUE: `"q,r:edge"`, produced by the same walk that produces the hex set, so the two
   cannot disagree. */
export function portKey(q: number, r: number, edge: number): string {
  return `${q},${r}:${edge}`;
}

const BOARD_KEYS: ReadonlySet<string> = new Set(
  STATIC_BOARD_HEXES.map((hex) => hexKey(hex.q, hex.r)),
);

/* `connectedNeighbours` is GONE with design note #4. It answered "which hexes does this one carry rail toward",
   which is the hex-as-a-node model that let a network bleed across a crossover's two separate straights.
   `trackSegments.neighbourAcross` keeps the both-sides rule; the missing half -- WHICH rail -- comes from
   `traversalsFrom`. Deleted rather than left unused so nothing can quietly start calling the old model again. */

/* Design note #3: A TILE LAY EXTENDS A ROUTE; IT DOES NOT TOUCH A HEX. This used to be all six neighbours of
   every network hex, on the reasoning that a lay extends a network so adjacency is the test. The first half of
   that is right and the conclusion does not follow: the lay still has to JOIN the network, and a network only
   offers a join where its own track ENDS AT AN EDGE. PRR on Altoona (printed track on edges 0 and 3) can extend
   west and east and nowhere else -- the other four sides are blank cardboard with no rail reaching them.
   Six lit hexes where two are legal is not a small over-count; it is the feature inverted.
   THE TEST IS ONE-SIDED, and that is the difference from the network walk: joining an EXISTING network needs
   both hexes to carry matching rail, while extending it needs only the network side to offer an edge, because
   the tile about to be laid supplies the other half. The two-sided test would light nothing on a fresh board.
   Design note #483: takes a PORT, not a hex. The old signature read `liveEdgesForHex` itself -- the line that
   offered builds across a crossover's far arm. The edge is now supplied by the walk that proved it reachable. */
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

/** A token, as `(q, r)` or -- when the chain recorded which slot it sits in
 *  (`gameState.ts` #560) -- as `(q, r, cityIndex)`.
 *
 *  Design note #686: THE THIRD ELEMENT IS THE FIX. `station_token_hexes` cannot
 *  say which of a two-city hex holds a token, so a walk starting from one had to
 *  assume both -- and on New York and every OO tile the two cities do not
 *  connect. `station_tokens` has carried the answer since #560; this is the
 *  first caller to ask for it.
 *  OPTIONAL, because a chain predating that field is a real state and the
 *  fallback is exactly the old behaviour. */
export type StationToken = readonly [number, number] | readonly [number, number, number];

export interface LayableHexInput {
  mapGrid: MapGridResponse;
  /** The acting corporation's station tokens. */
  stationHexes: ReadonlyArray<StationToken>;
}

export interface LayableHexResult {
  /** `hexKey` of every hex this corporation may build on -- the glow set. */
  hexes: ReadonlySet<string>;
  /* Design note #4: THE NETWORK IS SHOWN, NOT HIDDEN. The first cut veiled everything except the legal targets,
     which is the obvious reading of "dim what you cannot act on" and the wrong one: a player choosing WHERE to
     extend is reasoning about the route the extension would join, so dimming exactly that leaves the legal hexes
     lit and the reason for choosing between them in the dark.
     Three tiers rather than two -- the network at full brightness, the extensions lit and glowed, everything else
     receding -- returned from one walk, or the two halves of one picture would disagree about where it ends. */
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

/* Design note #2: WHY A CORPORATION WITH NO TOKEN IS UNCONSTRAINED. A floated corporation that has not placed
   its home token has no network, so a strict reading would return the empty set and dim the ENTIRE board with
   nothing lit -- telling the player, wordlessly, that they may not build anywhere. That is both wrong (their
   first lay is the home hex) and indistinguishable from a broken feature. The same applies before the first
   `GetGameState` resolves.
   So "I do not know where this network is" returns `unconstrained` and the caller leaves the board undimmed.
   The contract remains the authority either way; the only thing lost is the hint.
   `reachableNetwork` is exported because two features need the same walk and must not disagree about it -- the
   veil grows this set by one hex, and station placement tests membership directly. A second BFS with its own
   subtly different adjacency rule is exactly how "the board says I can build here but the token button says I
   cannot" happens.
   Design note #4: A NETWORK FOLLOWS RAILS, NOT HEX ADJACENCY. The walk was hex-to-hex, which treats a hex as a
   NODE where everything meets -- true of most tiles and false of exactly the ones this matters on. Measured on
   the real board before the fix: a three-hex patch with #20 in the middle reported the far hex as networked,
   across two rails with no connection between them.
   THE WALK IS OVER (HEX, ARRIVAL EDGE) STATES NOW, so a crossover is entered twice, once per straight, and each
   visit carries only its own onward reach.
   THE STATION HEXES THEMSELVES ARE UNRESTRICTED, and that is not a shortcut: a route starts AT a token, inside
   the city, so every rail leaving that city is available to it. There is no arrival edge to constrain a start. */
export interface ReachableTrack {
  /** Every hex the corporation's rails physically reach. */
  hexes: Set<string>;
  /* Design note #483: WHAT THE PORT SET IS FOR -- every edge the walk PROVED reachable. Two consumers need it and
     neither can derive it from `hexes`: the tile-lay extension (a build joins only across an edge the network
     actually reaches) and the rotation filter (an orientation survives only if a live edge faces a port, rather
     than merely facing a hex that happens to be in the network).
     INCLUDES EDGES WITH NOTHING BEYOND THEM, deliberately. `hexes` only grows across a two-sided join, because a
     network cannot flow into bare cardboard -- but bare cardboard is exactly where a tile gets laid, so the port
     survives where the hex does not. */
  ports: Set<string>;
}

/** The walk, with both of its results. `reachableNetwork` below is this
 *  function's `hexes` and exists because most callers want only that. */
export function reachableTrack(
  mapGrid: MapGridResponse,
  stationHexes: ReadonlyArray<StationToken>,
): ReachableTrack {
  const hexes = new Set<string>();
  const ports = new Set<string>();
  /** `q,r:arrivalEdge` -- one hex may legitimately be entered several ways. */
  const visited = new Set<string>();
  const queue: Array<{
    q: number;
    r: number;
    arrivalEdge: number | null;
    /** Design note #686: which city this visit started in, for a start only.
     *  `null` once the walk is on rails -- an arrival edge is a stricter
     *  answer than a city index and supersedes it. */
    cityIndex: number | null;
  }> = [];

  for (const token of stationHexes) {
    const [q, r] = token;
    if (!BOARD_KEYS.has(hexKey(q, r))) continue;
    hexes.add(hexKey(q, r));
    /* `null` arrival: a station is entered from inside. Design note #686: from
       inside ONE CITY, though -- which is the part "every rail on it" got
       wrong on the hexes that carry two. */
    queue.push({ q, r, arrivalEdge: null, cityIndex: token.length > 2 ? (token[2] ?? null) : null });
  }

  while (queue.length > 0) {
    const at = queue.shift()!;
    /* Design note #686: a start is keyed by its CITY, so two tokens in the two
       cities of one hex are two distinct visits rather than one that dedupes
       the second away. */
    const stateKey = `${hexKey(at.q, at.r)}:${at.arrivalEdge ?? `start${at.cityIndex ?? ""}`}`;
    if (visited.has(stateKey)) continue;
    visited.add(stateKey);

    /* Which edges may this visit leave by? From a station, all of them; having arrived on a rail, only the edges
       that rail reaches. `traversalsFrom` is the strict half -- it drops the pair when there is no authored rail
       joining the two edges, which is what makes two curves on one tile two curves rather than a junction. */
    const exits =
      at.arrivalEdge === null
        ? cityExitEdges(mapGrid, at.q, at.r, at.cityIndex)
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
      queue.push({ q: next.q, r: next.r, arrivalEdge: next.arrivalEdge, cityIndex: null });
    }
  }
  return { hexes, ports };
}

export function reachableNetwork(
  mapGrid: MapGridResponse,
  stationHexes: ReadonlyArray<StationToken>,
): Set<string> {
  return reachableTrack(mapGrid, stationHexes).hexes;
}

/** A corporation's tokens as the walk wants them: the recorded `(q, r, city)`
 *  triples when the chain has them, the bare `(q, r)` pairs otherwise.
 *
 *  Design note #686: ONE RESOLVER, THREE CALLERS. The tile-lay veil, the token
 *  placement highlight and `stationTokens`' connectivity refusal all ask this
 *  walk the same question, and all three read `station_token_hexes` today. Three
 *  copies of "prefer `station_tokens` when it is there" is three chances to keep
 *  the old field -- and a board where the veil knows about cities and the token
 *  gate does not is worse than one where neither does, because the two disagree
 *  in front of the player.
 *  `gameState.ts` #560's three states, honoured: absent means "use the
 *  heuristic", a shorter list means the same for the tokens it does not cover. */
export function stationTokensOf(company: {
  station_token_hexes: ReadonlyArray<readonly [number, number]>;
  station_tokens?: ReadonlyArray<readonly [number, number, number]> | null;
}): StationToken[] {
  const recorded = company.station_tokens ?? [];
  return company.station_token_hexes.map((hex) => {
    const match = recorded.find(([q, r]) => q === hex[0] && r === hex[1]);
    return match ?? hex;
  });
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

  // A lay is legal on a hex the network REACHES: one already in the network (an upgrade of track the corporation
  // runs on) or one its track actually exits toward (an extension -- design note #3, where the "every surrounding
  // hex" bug lived). `evaluateHexForTileLaying` then removes what the static board forbids anywhere.
  // Design note #483: the extension candidates come from PORTS. This used to iterate the network's hexes and read
  // every live edge off each one, which re-introduced the hex-as-a-node model the walk had just finished
  // rejecting -- a crossover reached on one straight offered builds beyond the other.
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
