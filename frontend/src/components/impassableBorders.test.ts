/** @jest-environment node */
//
// The four impassable borders, as a placement rule. No React, no canvas.
//
// ==================================================================
//  DESIGN NOTE 756 (harness): A TABLE THAT DOCUMENTED ITS OWN GAP
// ==================================================================
//
// REPORTED: "On the Lay Track action, there are four impassable barriers on the map: it should not be legal
// to rotate a tile so that its tracks run into these barriers, in the same way they cannot run off the
// board."
//
// THE COMPARISON IS EXACT. #7 is the off-board rule -- "Nothing in this filter had any notion of where the
// board ENDS" -- and this is the same absence one step in from the rim.
//
// AND THE DATA WAS ALREADY PRESENT, LABELLED AS DECORATION. `IMPASSABLE_BORDER_EDGES` opens "a drawing-only
// mirror of the backend's enforcement table", which was true: `hexmap.rs` refuses these lays and the sandbox
// drew a line across the hex and allowed them. Six words into the table's own doc comment.
//
// THE MIRROR IS DERIVED AND THIS FILE IS WHY THAT IS SAFE. Refusing a lay needs BOTH sides of a barrier,
// because the tile being rotated may sit on either. The drawing table lists each once. Rather than hand-copy
// the contract's eight entries -- four chances to invert an edge index -- the second side is computed, and
// the first test below checks the computation against the contract's list verbatim. A derivation with a
// proof beats a transcription with a hope.

import { filterSandboxPlacements, isImpassableEdge } from "./sandboxTileLegality";
import { IMPASSABLE_BORDER_EDGES } from "./hexBoardData";
import { TILE_CATALOG_BY_ID } from "./hexTileCatalog";
import { liveEdges, rotateConnections } from "./hexGeometry";
import type { LegalTilePlacement, MapGridResponse } from "./hexContractTypes";

/** `hexmap.rs`'s `IMPASSABLE_HEX_EDGES`, copied here as the thing to be checked AGAINST -- the one place a
 *  transcription is appropriate, because nothing is derived from it. */
const CONTRACT_EDGES: ReadonlyArray<readonly [number, number, number]> = [
  [1, 4, 5], // E7, edge 5 (toward F8)
  [1, 5, 2], // F8, edge 2 (toward E7)
  [4, 3, 2], // D12, edge 2 (toward C11)
  [4, 2, 5], // C11, edge 5 (toward D12)
  [4, 3, 1], // D12, edge 1 (toward C13)
  [5, 2, 4], // C13, edge 4 (toward D12)
  [7, 2, 2], // C17, edge 2 (toward B16)
  [7, 1, 5], // B16, edge 5 (toward C17)
];

describe("the derived mirror matches the contract", () => {
  it("blocks every edge hexmap.rs blocks", () => {
    /* THE PROOF THE DERIVATION NEEDED. `(edge + 3) % 6` is the arithmetic; these eight pairs are the answer
       it has to reach. If the hex neighbour offsets or the edge numbering ever drift, this fails here rather
       than as a tile that can be rotated into Lake Ontario. */
    for (const [q, r, edge] of CONTRACT_EDGES) {
      expect(isImpassableEdge(q, r, edge)).toBe(true);
    }
  });

  it("blocks nothing else", () => {
    /* THE OTHER HALF, and the one that matters more: an over-derived set would quietly forbid legal track
       across the whole board. Swept over every edge of every hex the barriers touch. */
    const contract = new Set(CONTRACT_EDGES.map(([q, r, edge]) => `${q},${r},${edge}`));
    for (const border of IMPASSABLE_BORDER_EDGES) {
      for (const [dq, dr] of [
        [0, 0],
        [1, 0],
        [1, -1],
        [0, -1],
        [-1, 0],
        [-1, 1],
        [0, 1],
      ]) {
        for (let edge = 0; edge < 6; edge += 1) {
          const q = border.q + dq;
          const r = border.r + dr;
          const key = `${q},${r},${edge}`;
          expect(isImpassableEdge(q, r, edge)).toBe(contract.has(key));
        }
      }
    }
  });

  it("covers four borders, which is what the report says there are", () => {
    // A truncated table would pass every test above and enforce nothing.
    expect(IMPASSABLE_BORDER_EDGES).toHaveLength(4);
    expect(CONTRACT_EDGES).toHaveLength(8);
  });

  it("says nothing about an ordinary hex", () => {
    expect(isImpassableEdge(0, 0, 0)).toBe(false);
    expect(isImpassableEdge(4, 3, 0)).toBe(false);
  });
});

describe("the filter refuses a rotation that crosses one", () => {
  /** D12 -- a hex with TWO barriers, on edges 1 and 2. The strongest fixture on the board. */
  const D12 = { q: 4, r: 3 };
  const bare = { tiles: [] } as unknown as MapGridResponse;

  /** Every yellow orientation the catalog offers, before this filter sees it. */
  function candidates(): LegalTilePlacement[] {
    const out: LegalTilePlacement[] = [];
    for (const tileId of [7, 8, 9]) {
      for (let orientation = 0; orientation < 6; orientation += 1) {
        out.push({ tile_id: tileId, orientation } as LegalTilePlacement);
      }
    }
    return out;
  }

  const surviving = () =>
    filterSandboxPlacements(candidates(), {
      mapGrid: bare,
      q: D12.q,
      r: D12.r,
      era: "Yellow",
    } as never);

  it("offers no orientation with rail on a barrier edge", () => {
    /* THE REPORT. Every placement that survives the filter is checked directly against the rule, so this
       cannot pass by the filter happening to reject those tiles for some other reason. */
    for (const placement of surviving()) {
      const entry = TILE_CATALOG_BY_ID.get(placement.tile_id);
      expect(entry).toBeDefined();
      const edges = liveEdges(rotateConnections(entry!.connections, placement.orientation));
      for (const edge of edges) {
        expect(isImpassableEdge(D12.q, D12.r, edge)).toBe(false);
      }
    }
  });

  it("still offers something, so the rule has not emptied the hex", () => {
    /* D12 has four passable edges, which is plenty for a yellow tile. A filter that returned nothing would
       satisfy the test above and make the hex unbuildable -- the failure mode worth guarding against, since
       an over-eager barrier rule looks exactly like a correct one until somebody tries to build. */
    expect(surviving().length).toBeGreaterThan(0);
  });

  it("rejected some of what it was offered, so the fixture reaches the rule", () => {
    // Without this, a catalog that happened to offer only legal rotations would prove nothing.
    expect(surviving().length).toBeLessThan(candidates().length);
  });
});

describe("the far side of a barrier is a real hex", () => {
  it("is refused from both directions", () => {
    /* THE REASON THE MIRROR EXISTS. C11 sits across the D12 barrier and is an ordinary buildable hex; what
       it may not do is run rail back toward D12. A one-sided table would refuse the lay from D12 and permit
       the identical connection laid from C11. */
    expect(isImpassableEdge(4, 3, 2)).toBe(true); // D12 toward C11
    expect(isImpassableEdge(4, 2, 5)).toBe(true); // C11 toward D12
  });

  it("does not make the neighbour unbuildable", () => {
    /* #7's note makes the same distinction for the rim: "THE RED OFF-BOARD HEXES ARE ON THE BOARD". A barrier
       blocks one EDGE, not a hex -- getting that wrong would delete C11, F8, C13 and B16 from the map. */
    const survivors = filterSandboxPlacements(
      [7, 8, 9].flatMap((tile_id) =>
        [0, 1, 2, 3, 4, 5].map((orientation) => ({ tile_id, orientation }) as LegalTilePlacement),
      ),
      { mapGrid: { tiles: [] } as unknown as MapGridResponse, q: 4, r: 2, era: "Yellow" } as never,
    );
    expect(survivors.length).toBeGreaterThan(0);
  });
});

describe("the rule sits beside the off-board rule, not inside it", () => {
  const read = () => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const raw = fs.readFileSync(path.join(__dirname, "sandboxTileLegality.ts"), "utf8");
    // #490a: the note quotes the drawing table's own wording and must keep doing so.
    return raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  };

  it("is a separate step in the filter", () => {
    /* Two rules, two questions: "is there a hex there" and "may track cross into it". Folding them together
       would make a barrier look like the edge of the world, which is wrong about the map and wrong about
       what a player is being told. */
    const code = read();
    expect(code).toContain("if (!staysOnBoard(q, r, entry, orientation)) return false;");
    expect(code).toContain("if (crossesImpassableBorder(q, r, entry, orientation)) return false;");
  });
});
