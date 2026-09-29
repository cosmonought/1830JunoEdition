// frontend/src/routeOracle/harness/corpus.ts
//
// ==================================================================
//  ROUTE v12 R12-1: THE REAL-BOARD CORPUS, CAPTURED FIXTURE-STYLE
// ==================================================================
//
// TEST-ONLY. Boards are rebuilt from the recorded logs' own messages -- the effective `LayTile`s (last lay on a
// hex wins), the home and paid station placements, every `LayTile.token_cities` remap, and the Kanawha
// licences the log actually granted -- with plain data transformations, never by replaying the reducer (the
// preflight found full replays diverge from the historical boards, section 6.9). The same board is handed to
// the oracle and to production, so neither can see a board the other does not.
//
// IMPROVED EXTRACTION (versus the preflight's probe 4b): the licences are read from the Z6C log itself
// (`__fixtures__z6cLog.json`, committed): B&O's comes from buying the JK private (index 136, design note #1323)
// and N&W BOUGHT one at index 393. The preflight assumed "B&O 1, everyone else 0", so its N&W rows on the Z6C
// boards judged Coal River against the wrong licence holder. No licence changes hands between 494 and 608 (the
// owner-local server log, read in the R12-1 pass; the corpus test re-checks it whenever that file is present).

import type { BoardDefinition } from "../../components/hexBoardData";
import { STANDARD_BOARD } from "../../components/hexBoardData";
import { EXPANDED_BOARD } from "../../components/hexBoardDataPlus";
import { LPF_BOARD } from "../../components/hexBoardDataLpf";
import type { TileColorTier } from "../../components/hexTileCatalog";
import { effectiveActions } from "../../gameEngine/logRevert";
import type { ProbeCompany } from "./productionProbe";

import ERIE_BOARD from "../../utils/__fixtures__erieBoard.json";
import Z6C_BOARD from "../../utils/__fixtures__z6cBoard.json";
import Z6C_ERIE from "../../utils/__fixtures__z6cErie.json";
import Z6C_LOG from "../../utils/__fixtures__z6cLog.json";

export const JK_PRIVATE = 7;

export interface CorpusBoard {
  id: string;
  source: string;
  board: BoardDefinition;
  variants: Record<string, unknown>;
  era: TileColorTier;
  lays: Array<{ q: number; r: number; tile_id: number; orientation: number; printed?: boolean }>;
  companies: Array<Omit<ProbeCompany, "trains">>;
  licenceNote: string;
  /** Extraction observations (duplicates ignored, inferences made). */
  notes?: string[];
  /** A hand-made board that knowingly lays tiles of the wrong class for their hexes (city tiles on plain
   *  hexes, as production's own `routeAuthority.test.ts` boards do): V10 is waived for it, nothing else. */
  synthetic?: true;
}

type RawAction = { index: number; msg: Record<string, unknown> };

/** Effective lays and stations, from messages. */
export function boardFromActions(
  actions: readonly RawAction[],
  board: BoardDefinition,
  licences: Readonly<Record<number, number>>,
): { lays: CorpusBoard["lays"]; companies: CorpusBoard["companies"]; notes: string[] } {
  const tiles = new Map<string, CorpusBoard["lays"][number]>();
  for (const hex of board.hexes) {
    if (hex.printedTile) {
      tiles.set(`${hex.q},${hex.r}`, { q: hex.q, r: hex.r, tile_id: hex.printedTile.tileId, orientation: hex.printedTile.orientation, printed: true });
    }
  }
  const tokens = new Map<number, Map<string, { q: number; r: number; city: number | null }>>();
  const notes: string[] = [];
  // THE FIRST PLACEMENT ON A HEX STANDS (the reducer keeps it; a second one for the same company and hex is a
  // message the reducer ignores). A duplicate is reported, never silently applied (the R12-1 review, M5).
  const put = (companyId: number, q: number, r: number, city: number | null, index: number) => {
    const held = tokens.get(companyId) ?? new Map();
    if (held.has(`${q},${r}`)) {
      notes.push(`duplicate station for company ${companyId} at ${q},${r} (index ${index}) ignored`);
      return;
    }
    held.set(`${q},${r}`, { q, r, city });
    tokens.set(companyId, held);
  };
  for (const action of actions) {
    const msg = action.msg;
    if (msg.LayTile) {
      const lay = msg.LayTile as { q: number; r: number; tile_id: number; orientation: number; token_cities?: Array<[number, number]> };
      tiles.set(`${lay.q},${lay.r}`, { q: lay.q, r: lay.r, tile_id: lay.tile_id, orientation: lay.orientation });
      for (const [companyId, city] of lay.token_cities ?? []) {
        const held = tokens.get(companyId)?.get(`${lay.q},${lay.r}`);
        if (held) held.city = city;
      }
    } else if (msg.PlaceHomeStation) {
      const home = msg.PlaceHomeStation as { company_id: number; q: number; r: number; city_index?: number | null };
      put(home.company_id, home.q, home.r, home.city_index ?? null, action.index);
    } else if (msg.PlaceStationToken) {
      const paid = msg.PlaceStationToken as { protocol_id: number; q: number; r: number; city_index?: number | null };
      put(paid.protocol_id, paid.q, paid.r, paid.city_index ?? null, action.index);
    }
  }
  const ids = new Set<number>([...Array.from(tokens.keys()), ...Object.keys(licences).map(Number)]);
  // The herald's owner runs from its herald even with no token (1830+ / LPF).
  board.hexes.forEach((hex) => {
    if (hex.herald) ids.add(hex.herald.companyId);
  });
  const companies = Array.from(ids)
    .sort((a, b) => a - b)
    .map((companyId) => ({
      companyId,
      tokens: Array.from(tokens.get(companyId)?.values() ?? []).map((token) =>
        token.city === null ? ([token.q, token.r] as const) : ([token.q, token.r, token.city] as const),
      ),
      licences: licences[companyId] ?? 0,
    }));
  return { lays: Array.from(tiles.values()), companies, notes };
}

/** Licences the log granted up to and including `through` (effective actions only). */
export function licencesFromLog(entries: ReadonlyArray<{ index: number; msg: Record<string, unknown> }>, through: number): Record<number, number> {
  const held: Record<number, number> = {};
  let jkGranted = false;
  for (const entry of entries) {
    if (entry.index > through) break;
    const msg = entry.msg;
    if (msg.BuyKanawhaLicense) {
      const id = (msg.BuyKanawhaLicense as { protocol_id: number }).protocol_id;
      held[id] = (held[id] ?? 0) + 1;
    }
    if (msg.BuyPrivateCompany) {
      const buy = msg.BuyPrivateCompany as { private_id: number; protocol_id: number };
      // #1323: the first corporation to buy the JK FROM A PLAYER receives one licence, once per game. The message
      // does not name the seller; a corporation can only buy a private from a player or another corporation, and
      // the JK starts with a player, so the FIRST corporate purchase is taken to be from a player. (Verified for
      // Z6C: the preflight's replay granted B&O its licence at 136 too.)
      if (buy.private_id === JK_PRIVATE && !jkGranted) {
        jkGranted = true;
        held[buy.protocol_id] = (held[buy.protocol_id] ?? 0) + 1;
      }
    }
  }
  return held;
}

function effective(actions: ReadonlyArray<{ index: number; actor?: string | null; msg: Record<string, unknown> }>): RawAction[] {
  return effectiveActions(
    actions.map((a) => ({ index: a.index, id: `dump-${a.index}`, actor: a.actor ?? "", payload: JSON.stringify(a.msg), msg: a.msg })),
  ).map((a) => ({ index: a.index, msg: a.msg }));
}

export function z6cLogEntries(): Array<{ index: number; msg: Record<string, unknown> }> {
  const entries = (Z6C_LOG as { entries: Array<{ index: number; id: string; actor: string | null; payload: string }> }).entries;
  return effectiveActions(entries.map((e) => ({ ...e, actor: e.actor ?? "" }))).map((e) => ({ index: e.index, msg: JSON.parse(e.payload) as Record<string, unknown> }));
}

export function boardForVariants(variants: Record<string, unknown>): BoardDefinition {
  if (variants.levelPlayingField === true) return LPF_BOARD;
  if (variants.expandedMap === true) return EXPANDED_BOARD;
  return STANDARD_BOARD;
}

/** The three dense late-game boards of the preflight (B-2): Y8V@651 (standard, Brown), Z6C@494 and Z6C@608
 *  (Level Playing Field, Gray). */
export function denseBoards(): CorpusBoard[] {
  const out: CorpusBoard[] = [];
  {
    const actions = effective((ERIE_BOARD as { actions: RawAction[] }).actions);
    const built = boardFromActions(actions, STANDARD_BOARD, {});
    out.push({
      id: "Y8V@651",
      source: "utils/__fixtures__erieBoard.json (JUNO-Y8V, effective actions through 651)",
      board: STANDARD_BOARD,
      variants: {},
      era: "Brown",
      ...built,
      licenceNote: "standard board: no licences",
    });
  }
  const z6cLicences = licencesFromLog(z6cLogEntries(), 494);
  for (const [id, fixture, source] of [
    ["Z6C@494", Z6C_BOARD, "utils/__fixtures__z6cBoard.json (JUNO-Z6C through 494)"],
    ["Z6C@608", Z6C_ERIE, "utils/__fixtures__z6cErie.json (JUNO-Z6C through 608)"],
  ] as const) {
    const actions = (fixture as { actions: RawAction[] }).actions;
    const setup = actions.find((a) => a.msg.SetupGame)?.msg.SetupGame as { variants: Record<string, unknown> };
    const board = boardForVariants(setup.variants);
    const built = boardFromActions(actions, board, z6cLicences);
    out.push({
      id,
      source,
      board,
      variants: setup.variants,
      era: "Gray",
      ...built,
      licenceNote:
        "licences from the Z6C log: B&O via the JK private (136), N&W bought (393)" +
        (id === "Z6C@608" ? "; none granted 495-608 (owner-local server log, R12-1)" : ""),
    });
  }
  return out;
}

/** The preflight's twelve stress fleets, plus whether each is a fleet the era could actually field (rusted
 *  models and the train limit). Stress fleets exercise the geometry; they are reported separately. */
export const STRESS_FLEETS: ReadonlyArray<readonly string[]> = [
  ["2"], ["3"], ["4"], ["5"], ["6"], ["D"], ["3", "4"], ["4", "6"], ["5", "6"], ["6", "D"], ["3", "4", "4"], ["2", "2", "2", "2"],
];

export function phaseConsistent(fleet: readonly string[], era: TileColorTier): boolean {
  const alive: Record<string, readonly string[]> = {
    Yellow: ["2", "3"],
    Green: ["2", "3", "4"],
    Brown: ["4", "5", "6", "D"],
    Gray: ["5", "6", "7", "D"],
  };
  const limit: Record<string, number> = { Yellow: 4, Green: 4, Brown: 2, Gray: 2 };
  return fleet.every((model) => alive[era].includes(model)) && fleet.length <= limit[era];
}
