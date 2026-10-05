/** @jest-environment node */
//
// ==================================================================
//  PHASE 3 -- DERIVATION RESIDUES: AUD-04.04 (DH-1) AND AUD-08.01 (GR-1 / S10-27)
// ==================================================================
//
// Two defects in what the GAME derives on a corporation's behalf, both classified DERIVATION-ONLY (no
// `RULES_ENGINE_VERSION` move, no settlement-certification move, stored logs replay unchanged) -- and this suite
// proves that classification as well as the fixes.
//
//   AUD-04.04 (DH-1): `dhFreeStationAvailableFor` ignored the D&H's one-turn window, so the owner's Tokens step was
//   never auto-skipped on any later turn in which the lay had happened and the free station had not been placed.
//
//   AUD-08.01 (GR-1 / S10-27): `RoomEngine.settleOwed` minted, applied and returned a derived action WITHOUT asking
//   whether the authority accepted it, so a refused derived withhold (Gentle Rust's trainless-but-ran corporation)
//   was appended to the room's log as though the game had acted.
//
// PLAYED THROUGH A ROOM wherever a room can show it (`RoomSession`, the server's own seam), on pinned boards.

import type { GameStateResponse } from "../gameEngine/gameState";
import type { MapGridResponse } from "../components/hexContractTypes";
import { sandboxGameState } from "../gameEngine/sandboxState";
import { RULES_ENGINE_VERSION } from "../gameEngine/rulesVersion";
import { boardHomeHexToAxial } from "../gameEngine/homeStationAuthority";
import { sandboxReplayProviders } from "../gameEngine/replayProviders";
import { stateDigest } from "../gameEngine/stateDigest";
import { DH_PRIVATE_ID, DH_TILE_ID, dhFreeStationAvailableFor } from "../gameEngine/dhPower";
import { dhStationRefusal } from "../gameEngine/dhStationAuthority";
import { privateHexFor } from "../gameEngine/privateReservations";
import { nextDerivedAction } from "../gameEngine/derivedActions";
import { RoomEngine, type ReplayEntry } from "../gameEngine/replayLog";
import { turnGuardKey } from "../gameEngine/turnGuardKey";
import { STATIC_BOARD_HEXES } from "../components/hexBoardData";
import { RoomSession, type ServerLogEntry } from "./roomSession";

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

/** W1-M's pinned Operating-Round board: PRR operating at Lay Track, its home token down, the D&H owned by PRR, two
 *  Operating Rounds in the set (so PRR's NEXT operating turn is reachable by playing, not by patching the board). */
function seedBoard(patch: (board: GameStateResponse) => GameStateResponse = (b) => b): GameStateResponse {
  const base = sandboxGameState("OperatingRound", 1);
  return patch({
    ...base,
    rules_engine_version: RULES_ENGINE_VERSION,
    current_round_type: "OperatingRound",
    current_global_era: "Yellow",
    player_addresses: [P1, P2],
    active_operating_order: [PRR],
    active_corporation_index: 0,
    macro_round_number: 2,
    sub_round_index: 1,
    operating_round_sequence_length: 2,
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
      // A turn's opening: nothing run yet (the sandbox scenario carries a stale $90 for PRR).
      ...(company.company_id === PRR ? { routes_run_this_turn: 0, last_route_revenue: "0" } : {}),
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
  } as GameStateResponse);
}

const providersFor = (grid: MapGridResponse, market?: GameStateResponse["market_positions"]) =>
  ({ ...sandboxReplayProviders(), initialGrid: grid, ...(market === undefined ? {} : { initialMarket: market }) }) as ReturnType<
    typeof sandboxReplayProviders
  >;

/** A hand-built seed has no par marks on the chart; the reducer's chart step places them on the FIRST entry it
 *  applies (#1193 -- idempotent thereafter). A real room's chart is placed by the deal. So the seed is charted once,
 *  here, and the room is handed that chart -- otherwise the first entry of every test would "change the board" by
 *  placing par marks, which is not what any of these tests is about. */
function charted(seed: GameStateResponse, grid: MapGridResponse): GameStateResponse["market_positions"] {
  const engine = new RoomEngine(providersFor(grid), { state: seed, waterfall: null });
  engine.apply({
    index: -1,
    id: "chart",
    actor: P1,
    payload: JSON.stringify({ DeclareDividends: { game_id: 1, protocol_id: 99, revenue_amount: "0", distribute: false } }),
  });
  return engine.snapshot.state.market_positions;
}

function newRoom(seed: GameStateResponse, grid: MapGridResponse = BARE): RoomSession {
  let minted = 0;
  return new RoomSession({
    providers: providersFor(grid, charted(seed, grid)),
    seed: { state: seed, waterfall: null },
    build: "b",
    mintId: () => `m${(minted += 1)}`,
    mintSeed: () => 1,
  });
}

type Answer = { kind: string; reason?: string; entries?: ServerLogEntry[]; catchUp?: { entries: ServerLogEntry[] } };
const submit = (room: RoomSession, actor: string, msg: unknown): Answer =>
  room.submit({ actor, build: "b", host: P1, msg: msg as never, baseIndex: room.nextIndex - 1 }) as Answer;

/** The burst's message kinds; a derived entry is starred. */
const kinds = (entries: readonly ServerLogEntry[] | undefined) =>
  (entries ?? []).map((entry) => `${Object.keys(JSON.parse(entry.payload))[0]}${entry.derived ? "*" : ""}`);

function reload(room: RoomSession, seed: GameStateResponse, grid: MapGridResponse = BARE): RoomSession {
  const again = newRoom(seed, grid);
  again.restore(room.entries as ServerLogEntry[]);
  return again;
}

const engineOf = (room: RoomSession): RoomEngine => (room as unknown as { engine: RoomEngine }).engine;
const emittedOf = (room: RoomSession): string[] =>
  Array.from((engineOf(room) as unknown as { emitted: Set<string> }).emitted).sort();

const DH_LAY = () => ({
  LayTile: { game_id: 1, protocol_id: PRR, q: dhHex().q, r: dhHex().r, tile_id: DH_TILE_ID, orientation: 0, ability_key: "dh-tile" },
});
const DH_STATION = () => ({
  PlaceHomeStation: { game_id: 1, company_id: PRR, q: dhHex().q, r: dhHex().r, kind: "dh", city_index: 0, hex_label: dhHex().hexLabel },
});
const ADVANCE = () => ({ AdvanceOperatingSubPhase: { game_id: 1, protocol_id: PRR } });
const PASS = () => ({ PassTurn: { game_id: 1 } });

const prrOf = (state: GameStateResponse) => state.public_companies.find((c) => c.company_id === PRR)!;
const dhGridOf = (room: RoomSession): MapGridResponse => engineOf(room).snapshot.grid;

/* ================================================================== */
/*  AUD-04.04 -- THE D&H'S FREE STATION KEEPS TOKENS OPEN ONLY IN ITS WINDOW                              */
/* ================================================================== */

describe("AUD-04.04: the D&H owner's Tokens step is held only inside the lay's own turn", () => {
  const seed = seedBoard();

  /** PRR lays F16 with the D&H's own power: the step moves to Tokens and the window opens. */
  function laid() {
    const room = newRoom(seed);
    const answer = submit(room, P1, DH_LAY());
    expect(answer.kind).toBe("applied");
    return { room, answer };
  }

  it("SAME TURN, free station legitimately pending: the room holds Tokens and derives nothing", () => {
    const { room, answer } = laid();
    expect(kinds(answer.entries)).toEqual(["LayTile"]); // no derived skip
    expect(room.state.operating_sub_phase).toBe("Tokens");
    expect(room.state.dh_station_pending).toBe(PRR);
    expect(room.state.used_private_abilities).toContain("dh-tile");
    // The premise of the hold: PRR has NO paid placement (its only reachable city is its own home), so the free
    // station is the only thing keeping Tokens open.
    const noWindow = { ...room.state, dh_station_pending: undefined } as GameStateResponse;
    expect(nextDerivedAction({ state: noWindow, mapGrid: dhGridOf(room), emitted: new Set() })?.msg).toHaveProperty(
      "AdvanceOperatingSubPhase",
    );
    expect(nextDerivedAction({ state: room.state, mapGrid: dhGridOf(room), emitted: new Set() })).toBeNull();
    // The authority agrees: the free station is legal right now.
    expect(dhStationRefusal(room.state, { company_id: PRR, q: dhHex().q, r: dhHex().r, city_index: 0 }, dhGridOf(room))).toBeNull();
  });

  it("...the free station is accepted there, and once it is placed the board owes the Tokens skip", () => {
    const { room } = laid();
    const answer = submit(room, P1, DH_STATION());
    expect(answer.kind).toBe("applied");
    expect(prrOf(room.state).station_token_hexes).toContainEqual([dhHex().q, dhHex().r]);
    expect(room.state.dh_station_pending ?? null).toBeNull();
    // The window closed legitimately (the station is spent); with nowhere left to place, Tokens is skipped.
    expect(kinds(answer.entries).slice(0, 2)).toEqual(["PlaceHomeStation", "AdvanceOperatingSubPhase*"]);
    expect(room.state.operating_sub_phase).not.toBe("Tokens");
  });

  it("RELOAD during the same legitimate pending state: the rebuilt room still holds Tokens, owes nothing, and accepts the station", () => {
    const { room } = laid();
    const reloaded = reload(room, seed);
    expect(stateDigest(reloaded.state)).toBe(stateDigest(room.state));
    expect(reloaded.state.dh_station_pending).toBe(PRR);
    expect(reloaded.state.operating_sub_phase).toBe("Tokens");
    // A submit runs the crash-repair settle first. A refused one shows it: nothing was owed, nothing appended.
    const before = reloaded.nextIndex;
    const refused = submit(reloaded, P2, ADVANCE());
    expect(refused.kind).toBe("refused");
    expect(refused.catchUp).toBeUndefined();
    expect(reloaded.nextIndex).toBe(before);
    expect(reloaded.state.operating_sub_phase).toBe("Tokens");
    // And the free station is still reachable through the reloaded room in the same operating turn.
    expect(submit(reloaded, P1, DH_STATION()).kind).toBe("applied");
    expect(prrOf(reloaded.state).station_token_hexes).toContainEqual([dhHex().q, dhHex().r]);
  });

  /** Lay F16, decline to place the free station (the president skips Tokens by hand), finish the turn, and arrive at
   *  PRR's NEXT operating turn (the set's second Operating Round) at Lay Track. Played, not patched. */
  function nextTurn() {
    const { room } = laid();
    expect(kinds(submit(room, P1, ADVANCE()).entries)[0]).toBe("AdvanceOperatingSubPhase"); // Tokens skipped by hand
    while (room.state.operating_sub_phase !== "Hardware") {
      expect(submit(room, P1, ADVANCE()).kind).toBe("applied");
    }
    expect(kinds(submit(room, P1, PASS()).entries)).toEqual(["PassTurn"]);
    expect(room.state.sub_round_index).toBe(2);
    expect(room.state.operating_sub_phase).toBe("Track");
    return room;
  }

  it("LATER TURN, no paid placement made: the window is gone, so the Tokens step is auto-skipped", () => {
    const room = nextTurn();
    // The premise: the D&H still exists, is still PRR's, its lay is recorded and its station was never placed --
    // exactly the facts the old rule read as "still available". Only the window is gone.
    expect(room.state.dh_station_pending ?? null).toBeNull();
    expect(room.state.used_private_abilities).toContain("dh-tile");
    expect(room.state.used_private_abilities ?? []).not.toContain("dh-token");
    expect(prrOf(room.state).station_token_hexes).not.toContainEqual([dhHex().q, dhHex().r]);
    const answer = submit(room, P1, ADVANCE()); // Lay Track skipped by hand: the step is Tokens
    expect(kinds(answer.entries).slice(0, 2)).toEqual(["AdvanceOperatingSubPhase", "AdvanceOperatingSubPhase*"]);
    const tokensSkip = answer.entries![1];
    // The derived skip left TOKENS (it was derived on the Tokens board) and named its reason.
    expect(tokensSkip.derived).toBe(true);
    expect(room.state.operating_sub_phase).not.toBe("Tokens");
  });

  it("LATER TURN: it must not stay open merely because the D&H exists -- the window is the only difference, and the authority refuses the station there", () => {
    const room = nextTurn();
    const atTokens = { ...room.state, operating_sub_phase: "Tokens" } as GameStateResponse;
    const grid = dhGridOf(room);
    // The station authority: the free station is refused on a later turn (unchanged by this pass).
    expect(dhStationRefusal(atTokens, { company_id: PRR, q: dhHex().q, r: dhHex().r, city_index: 0 }, grid)).toMatch(
      /only comes with the same turn's lay/,
    );
    // The derivation agrees with it now.
    const owed = nextDerivedAction({ state: atTokens, mapGrid: grid, emitted: new Set() });
    expect(owed?.kind).toBe("skip");
    expect(owed?.msg).toHaveProperty("AdvanceOperatingSubPhase");
    expect(owed?.key).toBe(turnGuardKey(atTokens, PRR, "Tokens"));
    // THE OLD RULE, reconstructed: the same board with the window standing is held -- the hold was the window's.
    expect(nextDerivedAction({ state: { ...atTokens, dh_station_pending: PRR }, mapGrid: grid, emitted: new Set() })).toBeNull();
    // And the shared rule, asked directly, says the same.
    const input = {
      companyId: PRR,
      privates: atTokens.private_companies,
      usedAbilities: atTokens.used_private_abilities ?? [],
      dhHexBuilt: true,
    };
    expect(dhFreeStationAvailableFor({ ...input, stationPending: atTokens.dh_station_pending })).toBe(false);
    expect(dhFreeStationAvailableFor({ ...input, stationPending: PRR })).toBe(true);
  });

  it("a D&H that was never exercised, or was forfeited, holds nobody's Tokens step on any turn", () => {
    const atTokens = (patch: Partial<GameStateResponse>) =>
      ({ ...seedBoard(), operating_sub_phase: "Tokens", ...patch }) as GameStateResponse;
    // Owned, never laid.
    expect(nextDerivedAction({ state: atTokens({}), mapGrid: BARE, emitted: new Set() })?.kind).toBe("skip");
    // Forfeited: F16 built by somebody else before the D&H's own lay (hex built, lay unused) -- even with a stale
    // window naming PRR, the power itself is gone.
    const builtGrid = { game_id: 1, tiles: [{ q: dhHex().q, r: dhHex().r, tile_id: DH_TILE_ID, orientation: 0 }] } as MapGridResponse;
    expect(nextDerivedAction({ state: atTokens({ dh_station_pending: PRR }), mapGrid: builtGrid, emitted: new Set() })?.kind).toBe("skip");
  });
});

/* ------------------------------------------------------------------ */
/* Normal paid Tokens behaviour -- the synthetic corridor              */
/* ------------------------------------------------------------------ */

describe("AUD-04.04 controls: the ordinary (paid) Tokens step is untouched", () => {
  const CO = 4;
  const BO = 3;
  const hex = (label: string) => STATIC_BOARD_HEXES.find((entry) => entry.label === label)!;
  const H16 = hex("H16");
  const I17 = hex("I17");
  const J14 = hex("J14");
  const K15 = hex("K15");
  const BALTIMORE = hex("I15");
  // `stationLegality.test.ts`'s corridor: H16 (C&O's token) -> I17 -> Baltimore -> J14 (two slots) -> K15 (one slot).
  const CORRIDOR = {
    game_id: 1,
    tiles: [
      { q: H16.q, r: H16.r, tile_id: 57, orientation: 2 },
      { q: I17.q, r: I17.r, tile_id: 7, orientation: 2 },
      { q: J14.q, r: J14.r, tile_id: 14, orientation: 1 },
      { q: K15.q, r: K15.r, tile_id: 57, orientation: 2 },
      // F16 built with the D&H's tile -- the board of a D&H owner whose lay is recorded.
      { q: dhHex().q, r: dhHex().r, tile_id: DH_TILE_ID, orientation: 0 },
    ],
  } as unknown as MapGridResponse;

  function corridorBoard(o: { boInBaltimore: boolean; dh: "none" | "laid-earlier" | "laid-this-turn" }): GameStateResponse {
    const company = (id: number, ticker: string, president: string, tokens: Array<[number, number]>, home: string) => ({
      company_id: id,
      ticker,
      is_floated: true,
      president,
      par_value: "100",
      ipo_pool_percentage: 0,
      bank_pool_percentage: 0,
      treasury: "1000",
      owned_trains: ["3"],
      player_holdings: [{ player: president, percentage: 100 }],
      station_token_hexes: tokens,
      station_token_limit: 3,
      home_hex_label: home,
    });
    return {
      player_addresses: ["p1", "p2"],
      player_cash: [
        { player: "p1", cash_vgp: "500" },
        { player: "p2", cash_vgp: "500" },
      ],
      virtual_bank_vgp: "10000",
      private_companies:
        o.dh === "none" ? [] : [{ private_id: DH_PRIVATE_ID, owner: null, owner_protocol_id: CO, closed: false }],
      used_private_abilities: o.dh === "none" ? [] : ["dh-tile"],
      ...(o.dh === "laid-this-turn" ? { dh_station_pending: CO } : {}),
      current_round_type: "OperatingRound",
      macro_round_number: 3,
      active_player_index: 0,
      active_operating_order: [CO, BO],
      active_corporation_index: 0,
      sub_round_index: 1,
      operating_round_sequence_length: 2,
      consecutive_passes: 0,
      operating_sub_phase: "Tokens",
      public_companies: [
        company(CO, "C&O", "p1", [[H16.q, H16.r]], "F6"),
        company(BO, "B&O", "p2", o.boInBaltimore ? [[BALTIMORE.q, BALTIMORE.r]] : [], "I15"),
      ],
    } as unknown as GameStateResponse;
  }

  const owed = (state: GameStateResponse) => nextDerivedAction({ state, mapGrid: CORRIDOR, emitted: new Set() });

  it("a corporation that can PAY for a reachable station is held at Tokens -- with or without the D&H, on any turn", () => {
    for (const dh of ["none", "laid-earlier", "laid-this-turn"] as const) {
      expect(owed(corridorBoard({ boInBaltimore: false, dh }))).toBeNull();
    }
  });

  it("a corporation with nowhere to pay for is skipped -- unless the D&H's free station is in its window", () => {
    expect(owed(corridorBoard({ boInBaltimore: true, dh: "none" }))?.kind).toBe("skip");
    expect(owed(corridorBoard({ boInBaltimore: true, dh: "laid-earlier" }))?.kind).toBe("skip"); // the fix
    expect(owed(corridorBoard({ boInBaltimore: true, dh: "laid-this-turn" }))).toBeNull(); // the window
  });

  it("the caller's explicit flag still wins (#781), in both directions", () => {
    const walled = corridorBoard({ boInBaltimore: true, dh: "laid-earlier" });
    expect(nextDerivedAction({ state: walled, mapGrid: CORRIDOR, emitted: new Set(), extraStationAvailable: true })).toBeNull();
    const windowed = corridorBoard({ boInBaltimore: true, dh: "laid-this-turn" });
    expect(nextDerivedAction({ state: windowed, mapGrid: CORRIDOR, emitted: new Set(), extraStationAvailable: false })?.kind).toBe("skip");
  });
});

/* ================================================================== */
/*  AUD-08.01 -- A DERIVED ACTION THE AUTHORITY REFUSES IS NOT APPENDED                                    */
/* ================================================================== */

describe("AUD-08.01: a refused derived withhold is not appended (Gentle Rust's trainless-but-ran corporation)", () => {
  /** PRR at Dividends, trainless (Gentle Rust's Final Run retired its only train at Run -> Dividends), with a $40 run
   *  recorded this turn. The derivation reads the fleet and owes a $0 forced withhold; the reducer refuses it ("PRR ran
   *  $40 this turn; a dividend declaration of $0 does not match it", `dividendAmountRefusal`). */
  const grSeed = () =>
    seedBoard((board) => ({
      ...board,
      operating_sub_phase: "Dividends",
      public_companies: board.public_companies.map((c) =>
        c.company_id === PRR ? { ...c, owned_trains: [], routes_run_this_turn: 1, last_route_revenue: "40" } : c,
      ),
    }));
  const DECLARE_40 = () => ({ DeclareDividends: { game_id: 1, protocol_id: PRR, revenue_amount: "40", distribute: false } });
  const WITHHOLD_0 = { DeclareDividends: { game_id: 0, protocol_id: PRR, revenue_amount: "0", distribute: false } };

  it("premise: the board owes a $0 forced withhold, and the authority refuses it (the board does not move)", () => {
    const seed = grSeed();
    const owed = nextDerivedAction({ state: seed, mapGrid: BARE, emitted: new Set() });
    expect(owed?.kind).toBe("forced-withhold");
    expect(owed?.msg).toEqual(WITHHOLD_0);
    const engine = new RoomEngine(providersFor(BARE, charted(seed, BARE)), { state: seed, waterfall: null });
    const before = stateDigest(engine.snapshot.state);
    engine.apply({ index: 0, id: "probe", actor: P1, payload: JSON.stringify(owed!.msg) });
    expect(stateDigest(engine.snapshot.state)).toBe(before);
  });

  it("the refused derived is not appended: no entry, no index, no cursor, no spent key", () => {
    const room = newRoom(grSeed());
    // Any submit runs the crash-repair settle first. P2's is refused at ingress, so the repair is all we see.
    const answer = submit(room, P2, ADVANCE());
    expect(answer.kind).toBe("refused");
    expect(answer.reason).toBe("It is not your turn.");
    expect(answer.catchUp).toBeUndefined(); // before the fix: a catch-up carrying `DeclareDividends*`
    expect(room.nextIndex).toBe(0);
    expect(room.entries).toEqual([]);
    expect(room.state.operating_sub_phase).toBe("Dividends");
    // The turn's Dividends key was NOT spent -- a rebuild of this (empty) log would not have it either.
    expect(emittedOf(room)).not.toContain(turnGuardKey(room.state, PRR, "Dividends"));
    expect(emittedOf(room)).toEqual([]);
  });

  it("the president's own declaration then lands as the only entry, and the turn goes on", () => {
    const room = newRoom(grSeed());
    const treasury = Number(prrOf(room.state).treasury);
    const answer = submit(room, P1, DECLARE_40());
    expect(answer.kind).toBe("applied");
    expect(kinds(answer.entries)).toEqual(["DeclareDividends"]); // before the fix: ["DeclareDividends*", "DeclareDividends"]
    expect(answer.entries!.map((e) => e.index)).toEqual([0]);
    expect(room.state.operating_sub_phase).toBe("Hardware");
    expect(Number(prrOf(room.state).treasury) - treasury).toBe(40);
    // Settled: nothing more is owed on the post-declaration board.
    expect(engineOf(room).settleOwed(() => { throw new Error("nothing is owed"); })).toEqual([]);
  });

  it("a repeated refusal stays a refusal: every later settle re-asks, and nothing is ever appended (no loop, no drift)", () => {
    const room = newRoom(grSeed());
    for (let i = 0; i < 5; i += 1) {
      expect(submit(room, P2, ADVANCE()).kind).toBe("refused");
      expect(engineOf(room).settleOwed((msg, reason) => ({ index: 900 + i, id: `x${i}`, actor: P1, payload: JSON.stringify(msg), derived: true, reason }) as ReplayEntry)).toEqual([]);
    }
    expect(room.nextIndex).toBe(0);
    expect(emittedOf(room)).toEqual([]);
  });

  it("live and rebuilt agree: a restored room has the same board, the same log and the same emitted keys", () => {
    const seed = grSeed();
    const room = newRoom(seed);
    submit(room, P2, ADVANCE());
    submit(room, P1, DECLARE_40());
    const restored = reload(room, seed);
    expect(restored.entries.map((e) => [e.index, e.id, e.payload, e.derived ?? false])).toEqual(
      room.entries.map((e) => [e.index, e.id, e.payload, e.derived ?? false]),
    );
    expect(stateDigest(restored.state)).toBe(stateDigest(room.state));
    expect(emittedOf(restored)).toEqual(emittedOf(room));
  });

  it("a revert onto the refusing board appends only the revert (the RevertTo branch retracts too)", () => {
    const room = newRoom(grSeed());
    expect(submit(room, P1, DECLARE_40()).kind).toBe("applied");
    const answer = submit(room, P1, { RevertTo: { index: 0, player: P1, summary: "undo" } });
    expect(answer.reason).toBeUndefined();
    expect(answer.kind).toBe("applied");
    expect(kinds(answer.entries)).toEqual(["RevertTo"]); // the rewound board's refused withhold is not appended
    expect(room.entries.map((e) => e.index)).toEqual([0, 1]);
    expect(room.state.operating_sub_phase).toBe("Dividends");
  });

  it("REPLAY UNCHANGED: a stored log that already holds a refused derived withhold (written before this fix) replays to the same board", () => {
    /* The shape every pre-fix room wrote: `[DeclareDividends* $0 (refused no-op), DeclareDividends $40]`. Restoring
       it applies every stored entry exactly as before -- the refused one as the no-op it always was, its key
       recorded (#1208) -- and derives nothing new. */
    const seed = grSeed();
    const stored: ServerLogEntry[] = [
      { index: 0, id: "old-1", actor: P1, payload: JSON.stringify(WITHHOLD_0), derived: true },
      { index: 1, id: "old-2", actor: P1, payload: JSON.stringify(DECLARE_40()) },
    ] as ServerLogEntry[];
    const restored = newRoom(seed);
    restored.restore(stored);
    expect(restored.entries).toHaveLength(2);
    // Entry by entry through the bare engine: entry 0 is a no-op, entry 1 is the declaration.
    const engine = new RoomEngine(providersFor(BARE, charted(seed, BARE)), { state: seed, waterfall: null });
    const start = stateDigest(engine.snapshot.state);
    engine.apply(stored[0]);
    expect(stateDigest(engine.snapshot.state)).toBe(start);
    engine.apply(stored[1]);
    expect(stateDigest(restored.state)).toBe(stateDigest(engine.snapshot.state));
    // The stored no-op still spends its key on restore (#1208), exactly as before: the restored room re-owes nothing.
    expect(emittedOf(restored)).toContain(turnGuardKey(seed, PRR, "Dividends"));
    expect(engineOf(restored).settleOwed(() => { throw new Error("nothing is owed"); })).toEqual([]);
    // And the live (fixed) room reaches the same board with one entry fewer.
    const live = newRoom(seed);
    submit(live, P1, DECLARE_40());
    expect(stateDigest(live.state)).toBe(stateDigest(restored.state));
    expect(live.entries).toHaveLength(1);
  });
});

describe("AUD-08.01: accepted derived actions still append exactly once, in order", () => {
  it("the later-turn D&H burst: each owed skip appended once, numbered contiguously, and none re-owed", () => {
    const seed = seedBoard((b) => ({ ...b, used_private_abilities: ["dh-tile"], sub_round_index: 2 }));
    const grid = { game_id: 1, tiles: [{ q: dhHex().q, r: dhHex().r, tile_id: DH_TILE_ID, orientation: 0 }] } as MapGridResponse;
    const room = newRoom(seed, grid);
    const answer = submit(room, P1, ADVANCE());
    expect(answer.kind).toBe("applied");
    // Track (by hand), then Tokens skipped (AUD-04.04), Routes skipped (no route), and the $0 withhold forced (nothing
    // ran) -- every one accepted, so every one appended.
    expect(kinds(answer.entries)).toEqual(["AdvanceOperatingSubPhase", "AdvanceOperatingSubPhase*", "AdvanceOperatingSubPhase*", "DeclareDividends*"]);
    expect(room.state.operating_sub_phase).toBe("Hardware");
    const derived = answer.entries!.filter((e) => e.derived);
    expect(answer.entries!.map((e) => e.index)).toEqual(answer.entries!.map((_, i) => i));
    expect(new Set(derived.map((e) => e.id)).size).toBe(derived.length);
    // Nothing further is owed, and a rebuilt room owes nothing either and holds the same log.
    expect(engineOf(room).settleOwed(() => { throw new Error("nothing is owed"); })).toEqual([]);
    const restored = reload(room, seed, grid);
    expect(stateDigest(restored.state)).toBe(stateDigest(room.state));
    expect(engineOf(restored).settleOwed(() => { throw new Error("nothing is owed"); })).toEqual([]);
    expect(emittedOf(restored)).toEqual(emittedOf(room));
  });
});
