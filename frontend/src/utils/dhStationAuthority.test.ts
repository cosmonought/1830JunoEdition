/** @jest-environment node */
//
// ==================================================================
//  STAGE 9, SLICE 9.4b (S9-12): THE D&H'S FREE STATION, JUDGED BY ITS OWN RULES AT BOTH LOCKS
// ==================================================================
//
// `dhStationAuthority.ts` (design note #1660) is the one predicate `placeDhFreeStationToken` (the reducer's
// arm) and `turnRefusal` (ingress) both ask for a `PlaceHomeStation{kind: "dh"}`. This is its own focused
// matrix: every branch of that predicate, LEGAL and REFUSE, each refusal proved by its sentence AND by
// `same()` (S10-1's board-digest equality, since a refused board can come back as a fresh object with nothing
// moved), and a handful of controls proving the D&H's one printed exemption (connectivity) has not leaked
// into ordinary paid placements or into the home-station slot.
//
// `homeStationAuthority.test.ts`'s own D&H describe block (#1615/#1660) already covers: the token landing
// beside the home rather than replacing it, and the arm's pre-#1660 answer surviving when no grid is
// supplied (#757). This file does not repeat those; it is the D&H's OWN legality, exhaustively.

import type { GameStateResponse } from "../gameEngine/gameState";
import type { MapGridResponse } from "../components/hexContractTypes";
import { STATIC_BOARD_HEXES, activateBoard, STANDARD_BOARD } from "../components/hexBoardData";
import { dhStationRefusal } from "../gameEngine/dhStationAuthority";
import { applySandboxLayTile, placeDhFreeStationToken } from "../gameEngine/sandboxSession";
import { evaluateStationPlacement } from "../gameEngine/stationTokens";
import { board, P1, P2, DH } from "./offerFixtures74";
import { applyAsRoom, apply, corp, ingress, same, withCorp, withPriv, withState, treasury } from "./offerMatrix74Support";

afterAll(() => activateBoard(STANDARD_BOARD));

function hexAt(label: string) {
  const hex = STATIC_BOARD_HEXES.find((entry) => entry.label === label);
  if (!hex) throw new Error(`no ${label} on the board in effect`);
  return hex;
}
const at = (label: string): [number, number] => [hexAt(label).q, hexAt(label).r];
const key = (label: string) => `${hexAt(label).q},${hexAt(label).r}`;

/** The two corporations this matrix needs: OWNER holds the D&H and is operating; RIVAL holds nothing special
 *  and is not. Ids chosen clear of every constant `offerFixtures74`/`offerMatrix74Support` export. */
const OWNER = 31;
const RIVAL = 32;

const GRID = { game_id: 1, tiles: [] } as unknown as MapGridResponse;
/** F16 with tile #57 down -- the D&H's own lay, the one city it creates, and the destination every
 *  board-dependent branch below needs to see for a token to have anywhere to go. */
const dhGrid = (): MapGridResponse => applySandboxLayTile(GRID, ...at("F16"), 57, 0, () => false);

/** The base board: OWNER floated, operating, at Tokens, home already placed at I15 (so the home-station hold
 *  does not itself block every other message here -- that hold is `homeStationAuthority.test.ts`'s subject,
 *  not this one's); the D&H owned by OWNER's corporation, its own lay just taken, this turn's window open. */
function baseBoard(): GameStateResponse {
  const state = board({
    round: "OperatingRound",
    corps: [
      { id: OWNER, ticker: "OWN", president: P1, trains: ["2"], treasury: "500" },
      { id: RIVAL, ticker: "RIV", president: P2, trains: ["2"], treasury: "500" },
    ],
    privates: [{ id: DH, owner: null, ownerCorp: OWNER, cost: "70" }],
    operating: OWNER,
    step: "Tokens",
  });
  let out = withCorp(state, OWNER, { home_hex_label: "I15", station_token_hexes: [at("I15")], station_tokens: [] });
  out = withCorp(out, RIVAL, { home_hex_label: "H12", station_token_hexes: [at("H12")], station_tokens: [] });
  out = withState(out, { used_private_abilities: ["dh-tile"], dh_station_pending: OWNER });
  return out;
}

/** A `PlaceHomeStation{kind: "dh"}` message. `label` defaults to F16, the only hex the power can ever name. */
const dh = (companyId: number, label = "F16", cityIndex: number | null = 0) => ({
  PlaceHomeStation: { game_id: 1, company_id: companyId, q: hexAt(label).q, r: hexAt(label).r, kind: "dh" as const, city_index: cityIndex, hex_label: label },
});

/** Both locks at once: the reducer (as a room's engine calls it) and ingress, on the same board and message.
 *  Returns the reducer's result and ingress's sentence, so a test can assert both together. */
function atBothLocks(state: GameStateResponse, msg: ReturnType<typeof dh>, actor: string, mapGrid: MapGridResponse) {
  return {
    after: applyAsRoom(state, msg, actor, mapGrid),
    ingressRefusal: ingress(state, actor, msg, mapGrid),
  };
}

describe("the D&H's free station is judged by its own rules at both locks (S9-12, #1660)", () => {
  it("LEGAL: the owning, operating corporation places it on F16 for $0, within the same turn's window", () => {
    const state = baseBoard();
    const grid = dhGrid();
    const msg = dh(OWNER);

    expect(dhStationRefusal(state, msg.PlaceHomeStation, grid)).toBeNull();
    expect(ingress(state, P1, msg, grid)).toBeNull();

    const after = applyAsRoom(state, msg, P1, grid);
    expect(corp(after, OWNER).station_token_hexes.map(([q, r]) => `${q},${r}`)).toEqual([key("I15"), key("F16")]);
    expect(corp(after, OWNER).station_tokens).toContainEqual([hexAt("F16").q, hexAt("F16").r, 0]);
    // $0 cost -- the tile's $120 mountain fee is the LayTile arm's own charge, never this one's.
    expect(treasury(after, OWNER)).toBe(treasury(state, OWNER));
    // The turn's window closes on success rather than waiting for the next turn boundary.
    expect(after.dh_station_pending).toBeUndefined();
    // Nothing else on the board moved.
    expect(corp(after, RIVAL)).toEqual(corp(state, RIVAL));
  });

  it("LEGAL: the free station may be postponed to any later point in the SAME operating turn -- the window is the turn, not the instant of the lay (S9.4b timing audit, #1660)", () => {
    // Driven through the REAL reducer end-to-end -- the live `LayTile{ability_key:"dh-tile"}` itself opens
    // `dh_station_pending`, rather than this test hand-setting it -- so this proves the window as the
    // reducer actually opens and holds it, not merely as this predicate reads a fixture.
    //
    // Design note #818 (`dhPower.ts`): "the token is the second half of the lay ... and both halves are one
    // turn. A power that could be taken three turns later would be a different power." The rule's boundary
    // is the TURN, not the instant of the lay -- so a corporation that lays, then does something else first,
    // and only THEN places the free station, is still inside the power exactly as printed.
    const track = withState(baseBoard(), {
      used_private_abilities: [],
      dh_station_pending: undefined,
      operating_sub_phase: "Track",
    });
    const grid = dhGrid();
    const lay = {
      LayTile: { game_id: 1, protocol_id: OWNER, q: hexAt("F16").q, r: hexAt("F16").r, tile_id: 57, orientation: 0, ability_key: "dh-tile" as const },
    };
    const afterLay = apply(track, lay, P1, GRID);
    expect(afterLay.dh_station_pending).toBe(OWNER);
    expect(afterLay.operating_sub_phase).toBe("Tokens");

    // The first normal action that moves past the free-station opportunity: skip Tokens without using it.
    const afterAdvance = apply(afterLay, { AdvanceOperatingSubPhase: { game_id: 1, protocol_id: OWNER } }, P1, grid);
    expect(afterAdvance.operating_sub_phase).toBe("Routes");
    // The window survives the sub-phase move -- it is turn-scoped, not lay-instant-scoped.
    expect(afterAdvance.dh_station_pending).toBe(OWNER);

    const msg = dh(OWNER);
    expect(dhStationRefusal(afterAdvance, msg.PlaceHomeStation, grid)).toBeNull();
    expect(ingress(afterAdvance, P1, msg, grid)).toBeNull();

    const placed = applyAsRoom(afterAdvance, msg, P1, grid);
    expect(corp(placed, OWNER).station_token_hexes.map(([q, r]) => `${q},${r}`)).toEqual([key("I15"), key("F16")]);
    expect(treasury(placed, OWNER)).toBe(treasury(afterAdvance, OWNER));
    expect(placed.dh_station_pending).toBeUndefined();
  });

  it("REFUSE: the wrong hex -- only F16, ever", () => {
    const state = baseBoard();
    const grid = dhGrid();
    const msg = dh(OWNER, "G19", null);
    const reason = dhStationRefusal(state, msg.PlaceHomeStation, grid);
    expect(reason).toBe("The Delaware & Hudson's free station goes on F16, not there.");
    const { after, ingressRefusal } = atBothLocks(state, msg, P1, grid);
    expect(ingressRefusal).toBe(reason);
    expect(same(after, state)).toBe(true);
  });

  it("REFUSE: the D&H is not in play", () => {
    const state = withPriv(baseBoard(), DH, { closed: true });
    const grid = dhGrid();
    const msg = dh(OWNER);
    const reason = dhStationRefusal(state, msg.PlaceHomeStation, grid);
    expect(reason).toBe("The Delaware & Hudson is not in play.");
    const { after, ingressRefusal } = atBothLocks(state, msg, P1, grid);
    expect(ingressRefusal).toBe(reason);
    expect(same(after, state)).toBe(true);
  });

  it("REFUSE: a non-owning corporation -- the D&H's power belongs to the corporation that owns it, not to whoever asks", () => {
    const state = baseBoard();
    const grid = dhGrid();
    const msg = dh(RIVAL);
    const reason = dhStationRefusal(state, msg.PlaceHomeStation, grid);
    expect(reason).toBe("Only the corporation that owns the Delaware & Hudson may use its free station, and RIV does not.");
    const { after, ingressRefusal } = atBothLocks(state, msg, P2, grid);
    expect(ingressRefusal).toBe(reason);
    expect(same(after, state)).toBe(true);
  });

  it("REFUSE: a player-owned D&H -- 'owner' and 'owner_protocol_id' are mutually exclusive (#379), and the power is only the owning CORPORATION's", () => {
    const state = withPriv(baseBoard(), DH, { owner: P2, owner_protocol_id: null });
    const grid = dhGrid();
    const msg = dh(OWNER);
    const reason = dhStationRefusal(state, msg.PlaceHomeStation, grid);
    expect(reason).toBe("Only the corporation that owns the Delaware & Hudson may use its free station, and OWN does not.");
    const { after, ingressRefusal } = atBothLocks(state, msg, P1, grid);
    expect(ingressRefusal).toBe(reason);
    expect(same(after, state)).toBe(true);
  });

  it("REFUSE: not floated", () => {
    const state = withCorp(baseBoard(), OWNER, { is_floated: false });
    const grid = dhGrid();
    const msg = dh(OWNER);
    const reason = dhStationRefusal(state, msg.PlaceHomeStation, grid);
    expect(reason).toBe("OWN has not floated, so it cannot use the Delaware & Hudson's free station.");
    const { after, ingressRefusal } = atBothLocks(state, msg, P1, grid);
    expect(ingressRefusal).toBe(reason);
    expect(same(after, state)).toBe(true);
  });

  it("REFUSE: not this corporation's operating turn", () => {
    const base = baseBoard();
    const state = withState(base, { active_corporation_index: base.active_operating_order.indexOf(RIVAL) });
    const grid = dhGrid();
    const msg = dh(OWNER);
    const reason = dhStationRefusal(state, msg.PlaceHomeStation, grid);
    expect(reason).toBe("OWN places the Delaware & Hudson's free station on its own operating turn, and it is not operating now.");
    const { after, ingressRefusal } = atBothLocks(state, msg, P1, grid);
    expect(ingressRefusal).toBe(reason);
    expect(same(after, state)).toBe(true);
  });

  it("REFUSE: repeat use -- OWNER already has a station token on F16", () => {
    const state = withCorp(baseBoard(), OWNER, { station_token_hexes: [at("I15"), at("F16")] });
    const grid = dhGrid();
    const msg = dh(OWNER);
    const reason = dhStationRefusal(state, msg.PlaceHomeStation, grid);
    expect(reason).toBe("OWN already has a station token on F16.");
    const { after, ingressRefusal } = atBothLocks(state, msg, P1, grid);
    expect(ingressRefusal).toBe(reason);
    expect(same(after, state)).toBe(true);
    // The arm's own pre-arm bookkeeping (#1204) marks "dh-token" spent before this predicate's OWN caller
    // runs it -- the self-referential bug this slice fixed. Proving repeat use is still caught, without that
    // signal, is the regression test for it.
    expect((state.used_private_abilities ?? []).includes("dh-token")).toBe(false);
  });

  it("REFUSE: forfeited -- F16 was built on before the D&H's own lay took it", () => {
    // hexBuilt (the grid shows F16 tiled) && !layUsed (used_private_abilities has no "dh-tile") is the whole
    // of the forfeit test (dhPower.ts #725) -- it cannot and does not care who built it.
    const state = withState(baseBoard(), { used_private_abilities: [] });
    const grid = dhGrid();
    const msg = dh(OWNER);
    const reason = dhStationRefusal(state, msg.PlaceHomeStation, grid);
    expect(reason).toBe("Another corporation has already built on F16, so the D&H's powers are gone for the rest of the game.");
    const { after, ingressRefusal } = atBothLocks(state, msg, P1, grid);
    expect(ingressRefusal).toBe(reason);
    expect(same(after, state)).toBe(true);
  });

  it("REFUSE: the D&H's own lay has not happened yet -- the station comes WITH the lay, not on its own", () => {
    const state = withState(baseBoard(), { used_private_abilities: [], dh_station_pending: undefined });
    const msg = dh(OWNER);
    // No tile on the board at all -- unbuilt, not forfeited, simply not laid yet.
    const reason = dhStationRefusal(state, msg.PlaceHomeStation, GRID);
    expect(reason).toBe("F16's tile has not been laid by the Delaware & Hudson's own power yet -- the free station comes with that lay, not on its own.");
    const { after, ingressRefusal } = atBothLocks(state, msg, P1, GRID);
    expect(ingressRefusal).toBe(reason);
    expect(same(after, state)).toBe(true);
  });

  it("REFUSE: timing -- the lay was taken, but not this turn", () => {
    const state = withState(baseBoard(), { dh_station_pending: undefined });
    const grid = dhGrid();
    const msg = dh(OWNER);
    const reason = dhStationRefusal(state, msg.PlaceHomeStation, grid);
    expect(reason).toBe(
      "The Delaware & Hudson's free station only comes with the same turn's lay. That turn has ended, so OWN would need an ordinary, connected station on F16 instead.",
    );
    const { after, ingressRefusal } = atBothLocks(state, msg, P1, grid);
    expect(ingressRefusal).toBe(reason);
    expect(same(after, state)).toBe(true);
  });

  it("FINDING: cityCountAt's archetype fallback already treats F16 as a city before any tile is laid -- the 'no city' branch is reachable in code but not on F16, and that is not this predicate's gap to close", () => {
    // Tried first as a REFUSE case, on the assumption `cityCountAt` would read 0 cities on an untiled F16 --
    // it does not: `cityCountAt` falls back to `archetypeForHex` when no tile is laid and F16's archetype is
    // already "SingleCity" (`stationTokens.ts` #574-583), a fact of the SHARED station authority this slice
    // did not touch and would not be right to special-case here. So `used_private_abilities` claiming the
    // lay happened while the grid shows no tile is, contrary to the comment this test used to carry, NOT
    // refused by city-existence -- it is legal by every check this predicate asks.
    //
    // THAT IS SAFE ANYWAY, for a reason outside this predicate: `used_private_abilities` is never client
    // input. It is written ONLY by the reducer's own pre-arm bookkeeping (#1204, `abilitySpentBy`) when a
    // `LayTile{ability_key: "dh-tile"}` message is actually processed -- and processing that message is what
    // ALSO puts tile #57 on the grid the room hands every subsequent call. A hand-crafted client cannot set
    // `used_private_abilities` directly; it can only submit messages, and the one message that sets "dh-tile"
    // is the one that lays the tile. So the desync this test constructs (bookkeeping says laid, grid says
    // not) is not a shape a crafted `PlaceHomeStation{kind:"dh"}` can produce on its own -- it would need a
    // SEPARATE bug that recorded the ability without applying the lay, which is outside this predicate's
    // remit and unobserved. Recorded here as a verified, not merely assumed, fact for the S9-12 report.
    const state = baseBoard();
    const msg = dh(OWNER);
    expect(dhStationRefusal(state, msg.PlaceHomeStation, GRID)).toBeNull();
  });

  it("REFUSE: a malformed city index on a one-city hex", () => {
    const state = baseBoard();
    const grid = dhGrid();
    const msg = dh(OWNER, "F16", 1);
    const reason = dhStationRefusal(state, msg.PlaceHomeStation, grid);
    expect(reason).toBe("F16 has one city; there is no city 2 there.");
    const { after, ingressRefusal } = atBothLocks(state, msg, P1, grid);
    expect(ingressRefusal).toBe(reason);
    expect(same(after, state)).toBe(true);
  });

  it("REFUSE: no city capacity -- F16's one slot is already taken", () => {
    const state = withCorp(baseBoard(), RIVAL, { station_token_hexes: [at("H12"), at("F16")], station_tokens: [[hexAt("F16").q, hexAt("F16").r, 0]] });
    const grid = dhGrid();
    const msg = dh(OWNER);
    const reason = dhStationRefusal(state, msg.PlaceHomeStation, grid);
    expect(reason).toBe("This city's only station slot is taken.");
    const { after, ingressRefusal } = atBothLocks(state, msg, P1, grid);
    expect(ingressRefusal).toBe(reason);
    expect(same(after, state)).toBe(true);
  });

  it("REFUSE: no token available -- OWNER's own allowance is already on the board", () => {
    const state = withCorp(baseBoard(), OWNER, {
      station_token_hexes: [at("I15"), at("H12"), at("G19")],
      station_token_limit: 3,
    });
    const grid = dhGrid();
    const msg = dh(OWNER);
    const reason = dhStationRefusal(state, msg.PlaceHomeStation, grid);
    expect(reason).toBe("Every one of this corporation's 3 station tokens is already on the board.");
    const { after, ingressRefusal } = atBothLocks(state, msg, P1, grid);
    expect(ingressRefusal).toBe(reason);
    expect(same(after, state)).toBe(true);
  });

  it("REFUSE: a hand-crafted message naming a corporation that is not in this game -- direct ingress, no UI in the way", () => {
    const state = baseBoard();
    const grid = dhGrid();
    const msg = dh(999);
    const reason = dhStationRefusal(state, msg.PlaceHomeStation, grid);
    expect(reason).toBe("That corporation is not in this game.");
    expect(ingress(state, P1, msg, grid)).toBe(reason);
    // Even applied directly through the bare reducer (no room providers at all), a crafted message meets the
    // same law -- there is no path into this arm that skips it.
    const direct = apply(state, msg, P1, grid);
    expect(same(direct, state)).toBe(true);
  });

  describe("controls: the one printed exemption stays where the printed rule put it", () => {
    it("the LEGAL placement above has no track connecting F16 at all -- proving the exemption actually fired", () => {
      const state = baseBoard();
      const grid = dhGrid();
      const input = {
        mapGrid: grid,
        q: hexAt("F16").q,
        r: hexAt("F16").r,
        company: corp(state, OWNER),
        allCompanies: state.public_companies,
        cityIndex: 0,
      };
      // Without the exemption, the same city is refused for the same reason an ordinary paid placement
      // would be -- OWNER's only token is at I15, nowhere near F16, and nothing has laid track between them.
      expect(evaluateStationPlacement(input).allowed).toBe(false);
      // With it -- exactly the input `dhStationAuthority.ts` passes -- the same city is allowed.
      expect(evaluateStationPlacement({ ...input, skipConnectivity: true }).allowed).toBe(true);
    });

    it("an ordinary station placement for the SAME corporation on the SAME unconnected hex is still refused -- the exemption does not leak to PlaceStationToken", () => {
      const state = baseBoard();
      const grid = dhGrid();
      const refusal = evaluateStationPlacement({
        mapGrid: grid,
        q: hexAt("F16").q,
        r: hexAt("F16").r,
        company: corp(state, OWNER),
        allCompanies: state.public_companies,
        cityIndex: 0,
        // skipConnectivity intentionally absent -- every caller but dhStationAuthority.ts's own.
      });
      expect(refusal.allowed).toBe(false);
      expect(refusal.reason).toMatch(/does not reach this city/);
    });

    it("direct arm call, no grid at all: the pre-9.4b answer (floated, not already on the hex) still stands -- #757", () => {
      const state = baseBoard();
      const direct = placeDhFreeStationToken(state, OWNER, hexAt("F16").q, hexAt("F16").r, 0);
      expect(corp(direct, OWNER).station_token_hexes.map(([q, r]) => `${q},${r}`)).toEqual([key("I15"), key("F16")]);
    });
  });
});
