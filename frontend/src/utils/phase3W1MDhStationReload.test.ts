/** @jest-environment node */
//
// ==================================================================
//  PHASE 3 W1-M (AUD-06.05 / A-5): THE D&H'S FREE STATION SURVIVES A RELOAD
// ==================================================================
//
// REPORTED BY THE AUDIT: "A reload between the D&H tile lay and the station makes the free station unreachable."
// `usedPrivateAbilities` is shell `useState`, so a reload empties it; the station's standing obligation read only
// that set, and the board's own turn-scoped record of the window (`dh_station_pending`, #1660) had no UI reader.
//
// THIS SUITE PLAYS IT THROUGH A ROOM, not a hand-patched board: the D&H's own lay is SUBMITTED to a RoomSession
// (the reducer writes `dh_station_pending`), the room is then REBUILT from its stored log (`restore`, which is a
// server restart and what a reloading client's catch-up replays), and the shell's derivation is asked with an
// EMPTY local set -- the exact state of a reloaded tab. The free station is then placed through the reloaded
// room, in the same operating turn.

import type { GameStateResponse } from "../gameEngine/gameState";
import type { MapGridResponse } from "../components/hexContractTypes";
import { sandboxGameState } from "../gameEngine/sandboxState";
import { RULES_ENGINE_VERSION } from "../gameEngine/rulesVersion";
import { boardHomeHexToAxial } from "../gameEngine/homeStationAuthority";
import { sandboxReplayProviders } from "../gameEngine/replayProviders";
import { stateDigest } from "../gameEngine/stateDigest";
import { dhPowerState, DH_PRIVATE_ID, CSL_PRIVATE_ID, DH_TILE_ID } from "../gameEngine/dhPower";
import { MH_PRIVATE_ID } from "../gameEngine/privateExchange";
import { privateHexFor } from "../gameEngine/privateReservations";
import { RoomSession, type ServerLogEntry } from "./roomSession";
import { deriveActivePowerFlow, dhStationOwedByBoard } from "./activePrivatePower";

const P1 = "p-alice"; // PRR's president
const P2 = "p-bob";
const PRR = 1;
const BARE: MapGridResponse = { game_id: 1, tiles: [] };

function prrHome(): [number, number] {
  const label = sandboxGameState("OperatingRound", 1).public_companies.find((c) => c.company_id === PRR)?.home_hex_label;
  const axial = label ? boardHomeHexToAxial(label) : null;
  if (!axial) throw new Error("PRR has no home hex on this board");
  return [axial[0], axial[1]];
}

function dhHex() {
  const hex = privateHexFor(DH_PRIVATE_ID);
  if (!hex) throw new Error("the D&H has no hex");
  return hex;
}

/** A pinned Operating-Round board: PRR operating at Lay Track, its home token down, and the D&H owned by PRR. */
function seedBoard(): GameStateResponse {
  const base = sandboxGameState("OperatingRound", 1);
  return {
    ...base,
    rules_engine_version: RULES_ENGINE_VERSION,
    current_round_type: "OperatingRound",
    current_global_era: "Yellow",
    player_addresses: [P1, P2],
    active_operating_order: [PRR],
    active_corporation_index: 0,
    macro_round_number: 2,
    sub_round_index: 1,
    operating_sub_phase: "Track",
    public_companies: base.public_companies.map((company) => ({
      ...company,
      president: company.company_id === PRR ? P1 : null,
      is_floated: company.company_id === PRR,
      treasury: company.company_id === PRR ? "1000" : "0",
      par_value: company.company_id === PRR ? "100" : null,
      player_holdings: company.company_id === PRR ? [{ player: P1, percentage: 60 }] : [],
      ipo_pool_percentage: company.company_id === PRR ? 40 : 100,
      bank_pool_percentage: 0,
      owned_trains: company.company_id === PRR ? ["2"] : [],
      station_token_hexes: company.company_id === PRR ? [prrHome()] : [],
      station_tokens: company.company_id === PRR ? [[...prrHome(), 0]] : [],
    })),
    private_companies: base.private_companies.map((entry) => ({
      ...entry,
      owner: null,
      owner_protocol_id: entry.private_id === DH_PRIVATE_ID ? PRR : null,
      closed: false,
    })),
    used_private_abilities: [],
    terrain_fees_paid: [],
  } as GameStateResponse;
}

function newRoom(seed: GameStateResponse): RoomSession {
  let minted = 0;
  return new RoomSession({
    providers: { ...sandboxReplayProviders(), initialGrid: BARE },
    seed: { state: seed, waterfall: null },
    build: "b",
    mintId: () => `m${(minted += 1)}`,
    mintSeed: () => 1,
  });
}

const submit = (room: RoomSession, actor: string, msg: unknown) =>
  room.submit({ actor, build: "b", host: P1, msg: msg as never, baseIndex: room.nextIndex - 1 });

/** A reload: a fresh session, the same seed, the stored log replayed (`restore` is the server-restart path). */
function reload(room: RoomSession, seed: GameStateResponse): RoomSession {
  const again = newRoom(seed);
  again.restore(room.entries as ServerLogEntry[]);
  return again;
}

const DH_LAY = () => ({
  LayTile: { game_id: 1, protocol_id: PRR, q: dhHex().q, r: dhHex().r, tile_id: DH_TILE_ID, orientation: 0, ability_key: "dh-tile" },
});
const DH_STATION = () => ({
  PlaceHomeStation: { game_id: 1, company_id: PRR, q: dhHex().q, r: dhHex().r, kind: "dh", city_index: 0, hex_label: dhHex().hexLabel },
});

/** The shell's inputs as a freshly reloaded tab has them: EMPTY local set, no local forfeit, and the lapse
 *  computed from the board exactly as `App.tsx`'s `dhPower` memo computes it (`abilitySpent` reads the board's
 *  `used_private_abilities`; `hexBuilt` reads the grid). */
function reloadedShell(
  state: GameStateResponse,
  viewer: string,
  over: { usedAbilities?: ReadonlySet<string>; dhStationForfeited?: boolean } = {},
) {
  const used = new Set<string>(state.used_private_abilities ?? []);
  over.usedAbilities?.forEach((key) => used.add(key));
  const dhForfeited = dhPowerState({
    hexBuilt: true,
    layUsed: used.has("dh-tile"),
    tokenUsed: used.has("dh-token"),
  }).forfeited;
  const actingProtocolId = state.active_operating_order[state.active_corporation_index] ?? null;
  return deriveActivePowerFlow({
    state,
    request: null,
    usedAbilities: over.usedAbilities ?? new Set<string>(),
    dhStationForfeited: over.dhStationForfeited ?? false,
    dhForfeited,
    actingProtocolId,
    viewerAddress: viewer,
    dhPrivateId: DH_PRIVATE_ID,
    cslPrivateId: CSL_PRIVATE_ID,
    mhPrivateId: MH_PRIVATE_ID,
  });
}

describe("W1-M: the D&H's free station survives a reload (AUD-06.05)", () => {
  const seed = seedBoard();

  /** The room after PRR's D&H lay, and the same room rebuilt from its log. */
  function laidAndReloaded() {
    const room = newRoom(seed);
    const answer = submit(room, P1, DH_LAY()) as { kind?: string; reason?: string };
    expect(answer.kind).not.toBe("refused");
    const reloaded = reload(room, seed);
    return { room, reloaded };
  }

  it("premise: the room records the window, and the reloaded room is the same board", () => {
    const { room, reloaded } = laidAndReloaded();
    expect(room.state.dh_station_pending).toBe(PRR);
    expect(room.state.used_private_abilities).toContain("dh-tile");
    expect(stateDigest(reloaded.state)).toBe(stateDigest(room.state));
  });

  it("after the reload, with an EMPTY local set, the president is offered the free station -- live", () => {
    const { reloaded } = laidAndReloaded();
    expect(dhStationOwedByBoard(reloaded.state, DH_PRIVATE_ID, P1)).toBe(true);
    const flow = reloadedShell(reloaded.state, P1);
    expect(flow).not.toBeNull();
    expect(flow!.abilityKey).toBe("dh-tile");
    const [lay, station] = flow!.steps;
    // The lay is shown as done (the board says it happened), the station is the live step.
    expect(lay.done).toBe(true);
    expect(station.key).toBe("station");
    expect(station.enabled).toBe(true);
    expect(flow!.complete).toBe(false);
    // Nothing committed can be put back: no X once the tile is down (#847).
    expect(flow!.cancellable).toBe(false);
  });

  it("...and it is accepted in the same turn through the reloaded room, after which nothing is owed", () => {
    const { reloaded } = laidAndReloaded();
    const answer = submit(reloaded, P1, DH_STATION()) as { kind?: string; reason?: string };
    expect(answer.kind).not.toBe("refused");
    const after = reloaded.state;
    const prr = after.public_companies.find((c) => c.company_id === PRR)!;
    expect(prr.station_token_hexes).toContainEqual([dhHex().q, dhHex().r]);
    expect(after.dh_station_pending ?? null).toBeNull();
    // The shell records `dh-token` on the click (commitFreeStationPlacement) -- and even a tab that did not
    // (another reload) is owed nothing: the board's window is closed.
    expect(reloadedShell(after, P1, { usedAbilities: new Set(["dh-token"]) })).toBeNull();
    expect(reloadedShell(after, P1)).toBeNull();
  });

  it("a non-president viewer is not offered it", () => {
    const { reloaded } = laidAndReloaded();
    expect(dhStationOwedByBoard(reloaded.state, DH_PRIVATE_ID, P2)).toBe(false);
    expect(reloadedShell(reloaded.state, P2)).toBeNull();
  });

  it("a forfeit made in this tab still holds (dhStationForfeited unchanged)", () => {
    const { reloaded } = laidAndReloaded();
    expect(reloadedShell(reloaded.state, P1, { dhStationForfeited: true })).toBeNull();
  });

  it("KNOWN LIMIT, pinned: a forfeit then a reload in the same turn asks again -- the board still allows it", () => {
    /* The forfeit is local (no message), so the reducer's window stays open. A reloaded tab therefore asks
       again; that is not a resurrection, because the room itself still accepts the free station this turn. */
    const { reloaded } = laidAndReloaded();
    expect(reloaded.state.dh_station_pending).toBe(PRR);
    expect(reloadedShell(reloaded.state, P1, { dhStationForfeited: false })!.abilityKey).toBe("dh-tile");
    const answer = submit(reloaded, P1, DH_STATION()) as { kind?: string };
    expect(answer.kind).not.toBe("refused");
    expect(reloaded.state.public_companies.find((c) => c.company_id === PRR)!.station_token_hexes).toContainEqual([
      dhHex().q,
      dhHex().r,
    ]);
  });

  it("absent `dh_station_pending`: nothing changes -- before the lay, and once the window has closed", () => {
    // Before any lay: no window, nothing owed, nothing requested.
    expect(seed.dh_station_pending ?? null).toBeNull();
    expect(reloadedShell(seed, P1)).toBeNull();
    // The lay happened on an EARLIER turn: `used_private_abilities` still says "dh-tile" ever happened, but the
    // reducer's turn-scoped window is gone, so a reloaded tab must not resurrect the free station.
    const { reloaded } = laidAndReloaded();
    const laterTurn = { ...reloaded.state, dh_station_pending: undefined } as GameStateResponse;
    expect(laterTurn.used_private_abilities).toContain("dh-tile");
    expect(reloadedShell(laterTurn, P1)).toBeNull();
  });

  it("the window must name the corporation that owns the (open) D&H", () => {
    const { reloaded } = laidAndReloaded();
    const s = reloaded.state;
    const otherCorp = { ...s, dh_station_pending: PRR + 1 } as GameStateResponse;
    expect(dhStationOwedByBoard(otherCorp, DH_PRIVATE_ID, P1)).toBe(false);
    const closed = {
      ...s,
      private_companies: s.private_companies.map((p) => (p.private_id === DH_PRIVATE_ID ? { ...p, closed: true } : p)),
    } as GameStateResponse;
    expect(dhStationOwedByBoard(closed, DH_PRIVATE_ID, P1)).toBe(false);
    expect(reloadedShell(closed, P1)).toBeNull();
  });
});
