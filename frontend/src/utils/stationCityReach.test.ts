/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 893 (harness): A TOKEN IS PLACED IN A CIRCLE
// ==================================================================
//
// REPORTED: "on OO tiles, corporations are allowed to place stations on cities they don't actually have
// connectivity to (e.g., D10/E11). The issue is worse on subsequent turns: NYC has connectivity to exactly
// three hexes (E19, E21, and E23 where it is tokened out by B&M), but the Station Marker subphase allows it
// to place a station in almost any city on the board, including the discontinuous jump from E11 to D10."
//
// THE CAUSE WAS NOT WHAT THE REPORT GUESSED, and the difference matters. `evaluateStationPlacement` was not
// "reading connectivity through raw hex adjacency" -- it called `reachableNetwork`, which is a strict
// edge-joined walk using `traversalsFrom` and a two-sided `neighbourAcross`. What it read was that walk's
// HEX-level answer, and a hex enters that set when the network reaches EITHER of its circles.
//
// SO THE GRANULARITY WAS THE BUG. #852 found the same thing in the route search ("`[q, r]` IS NOT ENOUGH,
// AND NEW YORK PROVES IT") and #686 found it in this walk's own start. The token gate is the third caller
// and nobody had told it.
//
// ------------------------------------------------------------------
//  FINDING A BOARD THAT ACTUALLY REPRODUCES IT TOOK THREE TRIES
// ------------------------------------------------------------------
//
// The bug needs a board state satisfying FOUR conditions at once, and each failed attempt missed a different
// one. The hex must be reachable; one of its circles must NOT be; the hex must have two REAL circles; and the
// acting corporation must not already hold a token on it -- because "one token per corporation per city" is
// itself asked at hex level and refuses first, masking the arm under test.
//
// FIRST, THE FINAL BOARD AND THE REPORT'S OWN HEXES. By the end of this game D10 is genuinely reachable by
// NYC, so three assertions failed for the right reason. A fixture at the wrong MOMENT does not test a weaker
// version of the rule; it tests a different board.
//
// SECOND, TRUNCATED TO NYC'S FIRST LAY. There NYC reaches only E19 -- so the OLD hex-level check would have
// refused D10 too, and a test that both versions of the code pass measures nothing. The same trap as #892's
// first draft, one file later.
//
// THIRD, A SWEEP. Rather than guess again, every prefix of the log was replayed and every corporation asked
// for a hex in `reachableNetwork` with a circle missing from `reachableCities`. Two false leads came out of
// it and both are recorded here because they look like the bug and are not: single-city hexes, where "city 1"
// is absent because it does not exist, and ERIE on its own home E11, where the token it already holds refuses
// the placement two arms earlier. Filtering those left H18 at index 120-126 -- and the state below.
//
// THE BOARD IS THE REPORTED GAME. Room JUNO-Y8V's message log, replayed through `applySandboxLayTile` with
// its reverts honoured -- see `dieselRouteCap.test.ts` for why the message log rather than the text one.

import { applySandboxLayTile } from "./sandboxSession";
import { effectiveActions } from "./logRevert";
import { evaluateStationPlacement, stationSlotCount } from "./stationTokens";
import { reachableCities, reachableNetwork } from "./trackReach";
import { STATIC_BOARD_HEXES } from "../components/hexBoardData";
import type { MapGridResponse } from "../components/hexContractTypes";
import type { StationToken } from "./trackReach";

import FIXTURE from "./__fixtures__ooToken.json";

/** The hex the sweep found: two circles, the network in one of them and not the other. */
const OO_LABEL = "H18";

/** PRR, resolved by its HOME rather than by a guessed id -- the first draft of this file named company 8 for
 *  NYC and that is B&M, whose home is one action away. A number typed from memory cannot be checked; a home
 *  label can. */
const HOME_OF_ACTOR = "H12";

const HEX = (label: string) => {
  const hex = STATIC_BOARD_HEXES.find((entry) => entry.label === label);
  if (!hex) throw new Error(`no such board hex: ${label}`);
  return hex;
};

/** Design note #1026: `id` joins the shape because `effectiveActions` keys its dead-set on identity now. A
 *  dump has one entry per index, so minting it from the index preserves this fixture's behaviour exactly. */
type LoggedAction = {
  index: number;
  id: string;
  actor: string;
  payload: string;
  msg: Record<string, unknown>;
};

/** The live log: every action the reverts did not kill, in index order. */
const LIVE: LoggedAction[] = effectiveActions(
  (FIXTURE.actions as ReadonlyArray<{ index: number; actor: string | null; msg: Record<string, unknown> }>).map(
    (a) => ({ index: a.index, id: `dump-${a.index}`, actor: a.actor ?? "", payload: "", msg: a.msg }),
  ),
);

const BOARD: MapGridResponse = (() => {
  let grid: MapGridResponse = { game_id: 0, tiles: [] } as unknown as MapGridResponse;
  for (const action of LIVE) {
    const lay = action.msg.LayTile as
      | { q: number; r: number; tile_id: number; orientation: number }
      | undefined;
    /* `applySandboxLayTile` IS THE AUTHORITY, not a hand-rolled tile writer -- it is what the shell calls, so
       upgrades replace their predecessors here exactly as they did in the game. */
    if (lay) grid = applySandboxLayTile(grid, lay.q, lay.r, lay.tile_id, lay.orientation, () => false);
  }
  return grid;
})();

/** One corporation's tokens, read from the log's own placements rather than typed in. */
const tokensOf = (companyId: number): StationToken[] => {
  const out: StationToken[] = [];
  for (const action of LIVE) {
    const home = action.msg.PlaceHomeStation as
      | { company_id: number; q: number; r: number; city_index?: number | null }
      | undefined;
    const paid = action.msg.PlaceStationToken as
      | { protocol_id: number; q: number; r: number; city_index?: number | null }
      | undefined;
    if (home && home.company_id === companyId) {
      out.push(home.city_index == null ? [home.q, home.r] : [home.q, home.r, home.city_index]);
    }
    if (paid && paid.protocol_id === companyId) {
      out.push(paid.city_index == null ? [paid.q, paid.r] : [paid.q, paid.r, paid.city_index]);
    }
  }
  return out;
};

const ACTOR = (() => {
  for (const action of LIVE) {
    const home = action.msg.PlaceHomeStation as { company_id: number; hex_label?: string } | undefined;
    if (home?.hex_label === HOME_OF_ACTOR) return home.company_id;
  }
  throw new Error(`no corporation homed on ${HOME_OF_ACTOR} in this log`);
})();

const ACTOR_TOKENS = tokensOf(ACTOR);

const company = (id: number, tokens: StationToken[]) =>
  ({
    company_id: id,
    is_floated: true,
    station_token_hexes: tokens.map(([q, r]) => [q, r] as const),
    station_token_limit: 4,
  }) as never;

const ACTING = company(ACTOR, ACTOR_TOKENS);
/** Only the acting corporation, so nobody else's token can occupy a slot and refuse before connectivity. */
const ALL = [ACTING];

const OO = HEX(OO_LABEL);
const HEXES = reachableNetwork(BOARD, ACTOR_TOKENS);
const CITIES = reachableCities(BOARD, ACTOR_TOKENS);

/** Which of H18's circles the network enters, and which it does not -- derived from the walk rather than
 *  hard-coded, so a fixture edit that flips them cannot silently invert the whole file. */
const REACHED_CIRCLE = [0, 1].find((index) => CITIES.has(`${OO.q},${OO.r}:${index}`));
const UNREACHED_CIRCLE = [0, 1].find((index) => !CITIES.has(`${OO.q},${OO.r}:${index}`));

describe("the fixture is a board where the bug can exist at all", () => {
  it("has real track on it", () => {
    /* A fixture that built an empty grid would make every assertion below vacuous -- which is how two earlier
       fixtures in this session and both of #892's failed. */
    expect(BOARD.tiles.length).toBeGreaterThan(5);
    expect(ACTOR_TOKENS.length).toBeGreaterThan(0);
  });

  it(`gives ${OO_LABEL} two real circles`, () => {
    /* THE FIRST FALSE LEAD, PINNED SO IT CANNOT COME BACK. The sweep's initial results were single-city hexes
       where "city 1" was missing from the reachable set because there IS no city 1 -- an absence that looks
       identical to an unreachable circle and means nothing. On a one-circle hex the hex question and the city
       question are the same question and #893 changes nothing. */
    expect(stationSlotCount(BOARD, OO.q, OO.r)).toBe(2);
  });

  it("puts the hex in reach and one of its circles out of reach", () => {
    /* THE PREMISE OF THE WHOLE FILE, and the exact shape the bug needs: the HEX-level walk says yes, the
       CITY-level walk says yes to one circle and no to the other. If these ever agreed the bug could not
       exist and every refusal below would be passing for the wrong reason. */
    expect(HEXES.has(`${OO.q},${OO.r}`)).toBe(true);
    expect(REACHED_CIRCLE).toBeDefined();
    expect(UNREACHED_CIRCLE).toBeDefined();
  });

  it("does not already hold a token there", () => {
    /* THE SECOND FALSE LEAD. "One token per corporation per city" is itself asked at HEX level and sits two
       arms ABOVE connectivity, so on a hex the corporation already occupies it refuses first and the arm under
       test is never reached -- a masked assertion, which this project's vacuity list names outright. */
    expect(ACTOR_TOKENS.some(([q, r]) => q === OO.q && r === OO.r)).toBe(false);
  });
});

describe("the token gate refuses a circle the network never enters (design note #893)", () => {
  const evaluate = (cityIndex: number | null) =>
    evaluateStationPlacement({
      mapGrid: BOARD,
      q: OO.q,
      r: OO.r,
      company: ACTING,
      allCompanies: ALL,
      cityIndex,
    });

  it("refuses the circle the track does not reach", () => {
    const verdict = evaluate(UNREACHED_CIRCLE!);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toMatch(/track does not reach/i);
  });

  it("says so in words rather than merely refusing", () => {
    // #438's rule: the refusal names which of the conditions stopped them.
    expect(evaluate(UNREACHED_CIRCLE!).reason).toContain("network it already runs");
  });

  it("still allows the circle on the SAME hex that the network does enter", () => {
    /* THE CONTROL THAT MATTERS MOST, and it is on the same hex, the same corporation and the same board as the
       refusal above -- so the only difference between the two calls is the circle named. A gate that refused
       everything, or one that refused by hex, would satisfy the two assertions above and break the step. */
    expect(evaluate(REACHED_CIRCLE!).allowed).toBe(true);
  });

  it("is a genuine change: the pre-#893 question answers YES here", () => {
    /* ==================================================================
        THE NEGATIVE CONTROL, WRITTEN INTO THE FILE
       ==================================================================
       This is the assertion that separates the fixed code from the broken code, and it is stated as the OLD
       code's own expression: `network.has(hexKey(q, r))`. It is TRUE at this hex -- which is precisely why the
       old gate permitted a token in a circle with no track to it.
       Asserted here rather than trusted, because both earlier attempts at this fixture produced boards where
       the old expression was ALSO false, and a test that both versions of the code pass proves nothing about
       either. Reverting the city arm to the hex arm now fails the refusal above; before this line, it did not. */
    expect(HEXES.has(`${OO.q},${OO.r}`)).toBe(true);
  });

  it("keeps the hex-level answer for a caller that cannot name a circle", () => {
    /* THE VEIL'S POSITION. `placeableStationHexes` lights HEXES and has no circle to name; passing `null` must
       reproduce the pre-#893 behaviour exactly, or the Tokens step's highlight changes meaning as a side
       effect of a fix aimed at the click. A hex with one reachable circle is still a hex worth lighting. */
    expect(evaluate(null).allowed).toBe(true);
  });
});

describe("the walk's two granularities stay consistent", () => {
  it("never claims a city on a hex it did not reach", () => {
    /* The city set is a REFINEMENT of the hex set, not an independent answer. If it could name a city on an
       unreached hex the two walks would have diverged and the hex-level callers would be reading a different
       board from the click. */
    expect(CITIES.size).toBeGreaterThan(0);
    CITIES.forEach((key) => expect(HEXES.has(key.split(":")[0])).toBe(true));
  });
});
