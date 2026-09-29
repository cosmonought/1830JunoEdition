/** @jest-environment node */
//
// ==================================================================
//  ROUTE v12 R12-1: EVERY MESSAGE A CLIENT COULD SEND, JUDGED BY BOTH (MESSAGE-SPACE BRUTE FORCE)
// ==================================================================
//
// The preflight's section 7.8 item 3 (and the R12-1 review, M7). The other suites ask the authority about the
// search's own set, the oracle's witness, and hand-picked routes; the authority's own defects (a red area
// counted twice, a bare token at a bypassed city) only show up where somebody thought to look. Here, on every
// small VALID fixture board, EVERY waypoint list a client could send -- every walk along the track of up to six
// hexes, every bypass / city_node flag combination where one could matter -- is judged by the oracle
// (`judgeWaypoints`) and by the authority (`evaluateRouteSet` on a Diesel, plus the reducer's Coal River gate).
//
// Every disagreement must be a KNOWN authority defect (pinned below, KNOWN-RED for R12-2): anything else fails
// the suite with the offending message. The Diesel keeps the train's capacity out of the question.

import { TILE_CATALOG_BY_ID } from "../components/hexTileCatalog";
import { KNOWN_DEFECT_FIXTURES } from "./harness/knownDefects";
import { productionAuthority, probeState } from "./harness/productionProbe";
import { dataPremium, premiumTable, probeCaseFor, type PremiumTable } from "./harness/compare";
import { denseBoards } from "./harness/corpus";
import type { CorpusBoard } from "./harness/corpus";
import { buildOracleGraph, judgeWaypoints, neighbourLabel, type OracleGraph, type OracleWaypoint } from ".";

const MAX_HEXES = 6;

/** Every walk of 2..MAX_HEXES hexes along boundaries both sides carry track to, with every flag reading. */
function messageSpace(graph: OracleGraph, maxHexes = MAX_HEXES): OracleWaypoint[][] {
  const hasTrack = (label: string, edge: number) => {
    const hex = graph.hexes.get(label)!;
    return hex.paths.some((path) => path.a === edge || path.b === edge) || hex.nodes.some((node) => node.spokes.includes(edge));
  };
  const labels = Array.from(graph.hexes.values()).filter((hex) => hex.paths.length > 0 || hex.nodes.some((node) => node.spokes.length > 0)).map((hex) => hex.label);
  const walks: string[][] = [];
  const grow = (walk: string[]) => {
    if (walk.length >= 2) walks.push([...walk]);
    if (walk.length >= maxHexes) return;
    const last = walk[walk.length - 1];
    for (let edge = 0; edge < 6; edge += 1) {
      const next = neighbourLabel(graph, last, edge);
      if (next === null || !hasTrack(last, edge) || !hasTrack(next, (edge + 3) % 6)) continue;
      if (walk.length >= 2 && next === walk[walk.length - 2]) continue; // an immediate U-turn is never a route
      walk.push(next);
      grow(walk);
      walk.pop();
    }
  };
  labels.forEach((label) => grow([label]));
  // Flags: a bypass where a hex has both a centre and plain track; a city_node on a multi-city end.
  const out: OracleWaypoint[][] = [];
  for (const walk of walks) {
    let readings: OracleWaypoint[][] = [[]];
    walk.forEach((label, i) => {
      const hex = graph.hexes.get(label)!;
      const end = i === 0 || i === walk.length - 1;
      const options: OracleWaypoint[] = [{ hex: label }];
      if (!end && hex.nodes.length > 0 && hex.paths.length > 0) options.push({ hex: label, bypass: true });
      const cities = hex.nodes.filter((node) => node.kind === "city");
      if (cities.length > 1) cities.forEach((city) => options.push({ hex: label, city_node: city.cityIndex! }));
      readings = readings.flatMap((prefix) => options.map((option) => [...prefix, option]));
    });
    out.push(...readings);
  }
  return out;
}

/** The known authority defects a disagreement may be explained by (KNOWN-RED, R12-2). */
function knownDefect(graph: OracleGraph, route: readonly OracleWaypoint[], oracleReason: string): string | null {
  if (/The route includes area:/.test(oracleReason)) return "IL-5: the authority keys red areas by hex, so a two-hex area counts twice";
  if (
    /must include a city holding one of the railroad's stations/.test(oracleReason) &&
    graph.heraldHex !== null &&
    route.some((wp) => wp.bypass === true && wp.hex === graph.heraldHex)
  ) {
    return "IL-3: the authority treats an uncounted pass of PRR's herald as a station (ruled NO)";
  }
  if (/must include a city holding one of the railroad's stations/.test(oracleReason) && route.some((wp) => wp.bypass === true)) {
    return "IL-7: the authority counts a bare token for its hex even when the route bypasses the city";
  }
  void graph;
  return null;
}

/** A message LEGAL to both but priced differently is explained only by a recorded production DATA defect (never
 *  by a law defect), and only when the difference is EXACTLY that data's premium (the R12-1 repair review, M4):
 *  #62's catalog $90 against the owner-ruled $80, and the 1830+ map's Montreal / Norfolk, which production prices
 *  flat ($40, $20) against their owner-confirmed pairs ($40 / $60, $30 / $50). All R12-2. */
const DATA_PRINTED = "DATA: production prices Montreal / Norfolk flat (owner-confirmed $40/$60, $30/$50; R12-2)";
const DATA_62 = "DATA: production's catalog prices #62 at $90 per city (owner-ruled $80; R12-2)";
/** The other Montreal / Norfolk data defect: production gives each ONE station circle (the superseded #1401 ruling;
 *  the owner's correction is two), so one foreign token shuts the city to through-running that the law allows. */
const DATA_CIRCLES = "DATA: production gives Montreal / Norfolk one station circle (owner: two; R12-2), so one token blocks it";

function knownPriceDifference(graph: OracleGraph, table: PremiumTable, route: readonly OracleWaypoint[], oracleValue: number, authorityTotal: number): string[] {
  const premium = dataPremium(graph, table, [route]);
  if (premium.total === 0 || oracleValue + premium.total !== authorityTotal) return [];
  return [...(premium.printed !== 0 ? [DATA_PRINTED] : []), ...(premium.tile !== 0 ? [DATA_62] : [])];
}

/** The law allows a run THROUGH Montreal / Norfolk that the authority refuses, and that city holds exactly one
 *  token (not the runner's): that is the one-circle data defect, nothing else. */
function knownCircleBlock(graph: OracleGraph, route: readonly OracleWaypoint[], authorityReason: string): string | null {
  const blocked = ["A19", "L16"].filter((label) => {
    const interior = route.slice(1, -1).some((wp) => wp.hex === label && wp.bypass !== true);
    const holders = graph.stations.get(`${label}/city0`) ?? [];
    return interior && holders.length === 1 && !holders.includes(graph.companyId) && authorityReason.includes(`${label} is tokened out`);
  });
  return blocked.length > 0 ? DATA_CIRCLES : null;
}

const fixtures = KNOWN_DEFECT_FIXTURES.filter((fixture) => !fixture.law.malformed && !fixture.board.synthetic);

describe("the message space of every valid fixture board: the oracle and the authority agree, but for known authority defects", () => {
  it.each(fixtures.map((fixture) => [fixture.id, fixture] as const))("%s", (_id, fixture) => {
    const graph = buildOracleGraph({
      board: fixture.board.board,
      grid: fixture.board.lays,
      catalog: TILE_CATALOG_BY_ID,
      companies: fixture.board.companies.map((company) => ({
        companyId: company.companyId,
        tokens: company.tokens.map((token) => ({ q: token[0], r: token[1], city: token.length === 3 ? token[2] : null })),
        licences: company.licences,
      })),
      companyId: fixture.companyId,
      highTier: false,
      licenceRule: fixture.board.variants.levelPlayingField === true,
    });
    const probe = probeCaseFor(fixture.board, fixture.companyId, ["D"]);
    const state = probeState(probe);
    const table = premiumTable(fixture.board, graph);
    const unexplained: string[] = [];
    const known = new Map<string, number>();
    let legalBoth = 0;
    const space = messageSpace(graph);
    for (const route of space) {
      const oracle = judgeWaypoints(graph, route);
      const authority = productionAuthority(probe, { routes: [route.map((wp) => ({ ...wp }))], trainIndices: [0] }, state);
      const text = route.map((wp) => `${wp.hex}${wp.bypass ? "*" : ""}${wp.city_node !== undefined ? `:${wp.city_node}` : ""}`).join(">");
      if (oracle.kind === "ambiguous") {
        unexplained.push(`${text}: the oracle finds the message ambiguous (${oracle.reasons.join(" | ")})`);
        continue;
      }
      const oracleLegal = oracle.kind === "legal";
      const authorityLegal = authority.kind === "legal";
      if (oracleLegal && authorityLegal) {
        legalBoth += 1;
        if (oracle.value !== authority.total) {
          const data = knownPriceDifference(graph, table, route, oracle.value, authority.total);
          data.forEach((label) => known.set(label, (known.get(label) ?? 0) + 1));
          if (data.length === 0) unexplained.push(`${text}: priced $${oracle.value} by the oracle, $${authority.total} by the authority`);
        }
        continue;
      }
      if (oracleLegal === authorityLegal) continue;
      const reason = oracle.kind === "illegal" ? oracle.reason : "";
      const explained =
        !oracleLegal && authorityLegal
          ? knownDefect(graph, route, reason)
          : oracleLegal && !authorityLegal
            ? knownCircleBlock(graph, route, (authority as { reason: string }).reason)
            : null;
      if (explained) known.set(explained, (known.get(explained) ?? 0) + 1);
      else unexplained.push(`${text}: oracle ${oracleLegal ? "legal" : `refuses (${reason})`}; authority ${authorityLegal ? "accepts" : `refuses (${(authority as { reason: string }).reason})`}`);
    }
    // Not vacuous: the space holds legal routes both sides accept.
    expect(space.length).toBeGreaterThan(10);
    if (fixture.law.optimum > 0) expect(legalBoth).toBeGreaterThan(0);
    expect(unexplained.slice(0, 20)).toEqual([]);
    // The known defects that DO appear on this board are pinned, so their repair is visible.
    const expected: Record<string, string[]> = {
      "RED-CANADIAN-WEST": ["IL-5: the authority keys red areas by hex, so a two-hex area counts twice"],
      "RED-GULF": ["IL-5: the authority keys red areas by hex, so a two-hex area counts twice"],
      "RED-GULF-TWO-TRAINS": ["IL-5: the authority keys red areas by hex, so a two-hex area counts twice"],
      "RED-CHATTANOOGA": ["IL-5: the authority keys red areas by hex, so a two-hex area counts twice"],
      "ALTOONA-BOW": ["IL-7: the authority counts a bare token for its hex even when the route bypasses the city"],
      "CANADIAN-WEST-STANDARD": ["IL-5: the authority keys red areas by hex, so a two-hex area counts twice"],
    };
    expect(Array.from(known.keys()).sort()).toEqual(expected[fixture.id] ?? []);
  }, 120_000);
});

/** The same comparison on the dense late-game boards, walks of up to five hexes (a bounded window of their
 *  message space): here the known defects appear in real positions rather than on hand-made boards. */
describe("the message space of the dense boards (walks of up to five hexes)", () => {
  const boards = new Map(denseBoards().map((board) => [board.id, board]));
  const judgeAll = (board: CorpusBoard, companyId: number) => {
    const graph = buildOracleGraph({
      board: board.board,
      grid: board.lays,
      catalog: TILE_CATALOG_BY_ID,
      companies: board.companies.map((company) => ({
        companyId: company.companyId,
        tokens: company.tokens.map((token) => ({ q: token[0], r: token[1], city: token.length === 3 ? token[2] : null })),
        licences: company.licences,
      })),
      companyId,
      highTier: board.era === "Brown" || board.era === "Gray",
      licenceRule: board.variants.levelPlayingField === true,
    });
    const probe = probeCaseFor(board, companyId, ["D"]);
    const state = probeState(probe);
    const table = premiumTable(board, graph);
    const known = new Map<string, number>();
    const unexplained: string[] = [];
    let legalBoth = 0;
    const space = messageSpace(graph, 5);
    for (const route of space) {
      const oracle = judgeWaypoints(graph, route);
      const authority = productionAuthority(probe, { routes: [route.map((wp) => ({ ...wp }))], trainIndices: [0] }, state);
      const text = route.map((wp) => `${wp.hex}${wp.bypass ? "*" : ""}${wp.city_node !== undefined ? `:${wp.city_node}` : ""}`).join(">");
      if (oracle.kind === "ambiguous") {
        unexplained.push(`${text}: ambiguous`);
        continue;
      }
      const oracleLegal = oracle.kind === "legal";
      const authorityLegal = authority.kind === "legal";
      if (oracleLegal && authorityLegal) {
        legalBoth += 1;
        if (oracle.value !== authority.total) {
          const data = knownPriceDifference(graph, table, route, oracle.value, authority.total);
          data.forEach((label) => known.set(label, (known.get(label) ?? 0) + 1));
          if (data.length === 0) unexplained.push(`${text}: $${oracle.value} vs $${authority.total}`);
        }
        continue;
      }
      if (oracleLegal === authorityLegal) continue;
      const reason = oracle.kind === "illegal" ? oracle.reason : "";
      const explained =
        !oracleLegal && authorityLegal
          ? knownDefect(graph, route, reason)
          : oracleLegal && !authorityLegal
            ? knownCircleBlock(graph, route, (authority as { reason: string }).reason)
            : null;
      if (explained) known.set(explained, (known.get(explained) ?? 0) + 1);
      else unexplained.push(`${text}: oracle ${oracleLegal ? "legal" : `refuses (${reason})`}; authority ${authorityLegal ? "accepts" : `refuses (${(authority as { reason: string }).reason})`}`);
    }
    return { space: space.length, legalBoth, known: Object.fromEntries(known), unexplained };
  };

  it.each([
    // PRR's bare Altoona home on the standard board: the IL-7 defect shows up in a real position. Both late
    // boards have a brown #62 on New York, so its $90 (owner-ruled $80) shows up as a known DATA difference; on
    // the Level Playing Field boards so does production's flat Norfolk ($20 against $30 / $50). (The one-circle
    // defect at Montreal / Norfolk needs a run THROUGH the city between two ends within five hexes; none of these
    // walks has one.)
    ["Y8V@651", 1, [DATA_62, "IL-7: the authority counts a bare token for its hex even when the route bypasses the city"]],
    ["Y8V@651", 5, [DATA_62]],
    ["Z6C@494", 1, [DATA_PRINTED]],
    ["Z6C@494", 4, [DATA_PRINTED, DATA_62]],
    ["Z6C@608", 10, [DATA_PRINTED, DATA_62]],
  ] as const)("%s company %s", (boardId, companyId, expectedKnown) => {
    const result = judgeAll(boards.get(boardId)!, companyId);
    expect(Object.keys(result.known).sort()).toEqual([...expectedKnown]);
    // eslint-disable-next-line no-console
    console.log(`message space ${boardId} company ${companyId}: ${result.space} messages, ${result.legalBoth} legal to both, known defects ${JSON.stringify(result.known)}`);
    expect(result.legalBoth).toBeGreaterThan(0);
    expect(result.unexplained.slice(0, 20)).toEqual([]);
  }, 300_000);
});
