/** @jest-environment node */
//
// ==================================================================
//  PHASE 3 AUD-08.01: THE GENERIC SEAM -- `RoomEngine.settleOwed` APPENDS ONLY WHAT LANDED
// ==================================================================
//
// `phase3DerivationResidues.test.ts` proves the fix on the board that exposed it (Gentle Rust's refused $0 withhold).
// This suite proves it is the GENERIC seam, not a special case: `nextDerivedAction` is wrapped so a test can put a
// refused derived action anywhere in a burst -- before valid derivations, after them, or forever -- and the real
// derivation answers everything else. Every message is judged by the real reducer; nothing about the refusal is faked
// except WHEN the game asks for it.

import type { GameStateResponse } from "../gameEngine/gameState";
import type { MapGridResponse } from "../components/hexContractTypes";
import type { DerivedAction, DerivedActionInput } from "../gameEngine/derivedActions";
import { sandboxGameState } from "../gameEngine/sandboxState";
import { RULES_ENGINE_VERSION } from "../gameEngine/rulesVersion";
import { boardHomeHexToAxial } from "../gameEngine/homeStationAuthority";
import { sandboxReplayProviders } from "../gameEngine/replayProviders";
import { stateDigest } from "../gameEngine/stateDigest";
import { RoomEngine, type ReplayEntry } from "../gameEngine/replayLog";
import { RoomSession, type ServerLogEntry } from "./roomSession";

jest.mock("../gameEngine/derivedActions", () => {
  const actual = jest.requireActual("../gameEngine/derivedActions");
  return { ...actual, nextDerivedAction: jest.fn(actual.nextDerivedAction) };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const derivedModule = require("../gameEngine/derivedActions") as typeof import("../gameEngine/derivedActions");
const actualNext = (jest.requireActual("../gameEngine/derivedActions") as typeof import("../gameEngine/derivedActions"))
  .nextDerivedAction;
const nextMock = derivedModule.nextDerivedAction as jest.MockedFunction<typeof actualNext>;

const P1 = "p-alice";
const P2 = "p-bob";
const PRR = 1;
const BARE: MapGridResponse = { game_id: 1, tiles: [] };

function prrHome(): [number, number] {
  const label = sandboxGameState("OperatingRound", 1).public_companies.find((c) => c.company_id === PRR)?.home_hex_label;
  const axial = label ? boardHomeHexToAxial(label) : null;
  if (!axial) throw new Error("PRR has no home hex on this board");
  return [axial[0], axial[1]];
}

/** PRR at Lay Track with a 2-train: skipping Track by hand, the real derivation then owes the Tokens skip (nowhere to
 *  place) and holds Routes for the president. */
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
      ...(company.company_id === PRR ? { routes_run_this_turn: 0, last_route_revenue: "0" } : {}),
      station_token_hexes: company.company_id === PRR ? [prrHome()] : [],
      station_tokens: company.company_id === PRR ? [[...prrHome(), 0]] : [],
    })),
    private_companies: base.private_companies.map((entry) => ({ ...entry, owner: null, owner_protocol_id: null, closed: false })),
    used_private_abilities: [],
    terrain_fees_paid: [],
  } as GameStateResponse;
}

const providersFor = (market?: GameStateResponse["market_positions"]) =>
  ({ ...sandboxReplayProviders(), initialGrid: BARE, ...(market === undefined ? {} : { initialMarket: market }) }) as ReturnType<
    typeof sandboxReplayProviders
  >;

/** The seed's par marks, placed once (see `phase3DerivationResidues.test.ts`'s `charted`). */
function charted(seed: GameStateResponse): GameStateResponse["market_positions"] {
  const engine = new RoomEngine(providersFor(), { state: seed, waterfall: null });
  engine.apply({
    index: -1,
    id: "chart",
    actor: P1,
    payload: JSON.stringify({ DeclareDividends: { game_id: 1, protocol_id: 99, revenue_amount: "0", distribute: false } }),
  });
  return engine.snapshot.state.market_positions;
}

function newRoom(seed: GameStateResponse): RoomSession {
  let minted = 0;
  return new RoomSession({
    providers: providersFor(charted(seed)),
    seed: { state: seed, waterfall: null },
    build: "b",
    mintId: () => `m${(minted += 1)}`,
    mintSeed: () => 1,
  });
}

type Answer = { kind: string; reason?: string; entries?: ServerLogEntry[]; catchUp?: { entries: ServerLogEntry[] } };
const submit = (room: RoomSession, actor: string, msg: unknown): Answer =>
  room.submit({ actor, build: "b", host: P1, msg: msg as never, baseIndex: room.nextIndex - 1 }) as Answer;
const kinds = (entries: readonly ServerLogEntry[] | undefined) =>
  (entries ?? []).map((entry) => `${Object.keys(JSON.parse(entry.payload))[0]}${entry.derived ? "*" : ""}`);
const engineOf = (room: RoomSession): RoomEngine => (room as unknown as { engine: RoomEngine }).engine;
const emittedOf = (room: RoomSession): string[] =>
  Array.from((engineOf(room) as unknown as { emitted: Set<string> }).emitted).sort();

const ADVANCE = { AdvanceOperatingSubPhase: { game_id: 1, protocol_id: PRR } };

/** A derived action the reducer refuses on every board here: a dividend declaration for a corporation that is not
 *  operating (B&O, id 3) -- the operating-identity gate declines it and the board does not move. */
const REFUSED = (key: string): DerivedAction => ({
  msg: { DeclareDividends: { game_id: 0, protocol_id: 3, revenue_amount: "0", distribute: false } },
  key,
  reason: "test: a derived action the authority refuses",
  kind: "forced-withhold",
});

/** The real answer, except that `key` is owed (refused) first -- or, with `after`, only once the real derivation has
 *  nothing more to say. Like the real function, it owes nothing for a key already emitted. */
function scripted(key: string, where: "before" | "after") {
  return (input: DerivedActionInput): DerivedAction | null => {
    if (where === "before" && !input.emitted.has(key)) return REFUSED(key);
    const real = actualNext(input);
    if (real !== null) return real;
    return where === "after" && !input.emitted.has(key) ? REFUSED(key) : null;
  };
}

/* CRA's Jest config resets mock implementations before every test (`resetMocks`), so the real derivation is
   re-installed before each one; a test that scripts a refusal replaces it for itself. */
beforeEach(() => {
  nextMock.mockImplementation(actualNext);
});

describe("AUD-08.01: the derived-action seam appends only what the authority accepted", () => {
  it("control (unmocked): the burst the real derivation owes, appended once each", () => {
    const room = newRoom(seedBoard());
    const answer = submit(room, P1, ADVANCE);
    // Track skipped by hand; Tokens skipped by the game (nowhere to place); Routes held for the president.
    expect(kinds(answer.entries)).toEqual(["AdvanceOperatingSubPhase", "AdvanceOperatingSubPhase*"]);
    expect(answer.entries!.map((e) => e.index)).toEqual([0, 1]);
    expect(room.state.operating_sub_phase).toBe("Routes");
  });

  it("a refused derivation FIRST: not appended, and the valid derivations FOLLOWING it still execute, in order", () => {
    const control = newRoom(seedBoard());
    const expected = submit(control, P1, ADVANCE);
    nextMock.mockImplementation(scripted("refused:first", "before"));
    const room = newRoom(seedBoard());
    const answer = submit(room, P1, ADVANCE);
    expect(answer.kind).toBe("applied");
    expect(kinds(answer.entries)).toEqual(kinds(expected.entries));
    // Same indices and payloads: no gap, no cursor advance for the refused one.
    expect(answer.entries!.map((e) => [e.index, e.payload])).toEqual(expected.entries!.map((e) => [e.index, e.payload]));
    expect(stateDigest(room.state)).toBe(stateDigest(control.state));
    expect(room.entries.some((e) => e.payload.includes('"protocol_id":3'))).toBe(false);
    // The refused key is not remembered: a rebuild of this log could not know it, so the live engine must not either.
    expect(emittedOf(room)).not.toContain("refused:first");
    expect(emittedOf(room)).toEqual(emittedOf(control));
  });

  it("a refused derivation LAST: every valid one before it appended once, the refused one not", () => {
    const control = newRoom(seedBoard());
    const expected = submit(control, P1, ADVANCE);
    nextMock.mockImplementation(scripted("refused:last", "after"));
    const room = newRoom(seedBoard());
    const answer = submit(room, P1, ADVANCE);
    expect(kinds(answer.entries)).toEqual(kinds(expected.entries));
    expect(room.nextIndex).toBe(control.nextIndex);
    expect(stateDigest(room.state)).toBe(stateDigest(control.state));
  });

  it("the engine is put back EXACTLY: state, grid, emitted keys and the caller's store", () => {
    nextMock.mockImplementation(scripted("refused:only", "before"));
    const seed = seedBoard();
    const engine = new RoomEngine(providersFor(charted(seed)), { state: seed, waterfall: null });
    const stateBefore = engine.snapshot.state;
    const gridBefore = engine.snapshot.grid;
    const store: ReplayEntry[] = [];
    const retracted: ReplayEntry[] = [];
    let n = 0;
    const derived = engine.settleOwed(
      (msg, reason) => {
        const entry = { index: n, id: `d${(n += 1)}`, actor: P1, payload: JSON.stringify(msg), derived: true, reason } as ReplayEntry;
        store.push(entry);
        return entry;
      },
      {
        retract: (entry) => {
          retracted.push(entry);
          expect(store[store.length - 1]).toBe(entry);
          store.pop();
        },
      },
    );
    // Track is never auto-skipped, so after the refusal the real derivation owes nothing on this board.
    expect(derived).toEqual([]);
    expect(store).toEqual([]);
    expect(retracted.map((e) => JSON.parse(e.payload))).toEqual([REFUSED("refused:only").msg]);
    expect(engine.snapshot.state).toBe(stateBefore); // the very object: nothing was swapped in
    expect(engine.snapshot.grid).toBe(gridBefore);
    expect(Array.from((engine as unknown as { emitted: Set<string> }).emitted)).toEqual([]);
    expect(engine.snapshot.unparseable).toEqual([]);
  });

  it("NO INFINITE LOOP: a board that always 'owes' a refused action terminates within the cap, appending nothing", () => {
    let fresh = 0;
    nextMock.mockImplementation(() => REFUSED(`refused:fresh:${(fresh += 1)}`));
    const room = newRoom(seedBoard());
    const answer = submit(room, P1, ADVANCE);
    expect(answer.kind).toBe("applied");
    expect(kinds(answer.entries)).toEqual(["AdvanceOperatingSubPhase"]);
    expect(room.nextIndex).toBe(1);
    // Two settles in one submit (the crash repair, then the burst), each capped at 32 attempts.
    expect(fresh).toBeLessThanOrEqual(64);
    // And a derivation that ignores its own key cannot spin either: the same cap.
    nextMock.mockImplementation(() => REFUSED("refused:same"));
    expect(engineOf(room).settleOwed((msg) => ({ index: 99, id: "x", actor: P1, payload: JSON.stringify(msg), derived: true }))).toEqual([]);
    expect(nextMock.mock.calls.length).toBeGreaterThan(0);
  });

  it("DETERMINISTIC: two rooms, and a room rebuilt from the log, reach the same entries, board and keys", () => {
    nextMock.mockImplementation(scripted("refused:det", "before"));
    const a = newRoom(seedBoard());
    const b = newRoom(seedBoard());
    submit(a, P1, ADVANCE);
    submit(b, P1, ADVANCE);
    const shape = (room: RoomSession) => room.entries.map((e) => [e.index, e.id, e.payload, e.derived ?? false]);
    expect(shape(a)).toEqual(shape(b));
    expect(stateDigest(a.state)).toBe(stateDigest(b.state));
    const restored = newRoom(seedBoard());
    restored.restore(a.entries as ServerLogEntry[]);
    expect(shape(restored)).toEqual(shape(a));
    expect(stateDigest(restored.state)).toBe(stateDigest(a.state));
    expect(emittedOf(restored)).toEqual(emittedOf(a));
  });

  it("a board-MOVING derived action is never treated as refused (the accepted path is untouched)", () => {
    // The control burst's every derived entry changed the board; the seam appended each, and the shell's own
    // definition (`authorityDeclined`) agrees entry by entry.
    const { authorityDeclined } = jest.requireActual("../gameEngine/actionOutcome") as typeof import("../gameEngine/actionOutcome");
    const room = newRoom(seedBoard());
    const answer = submit(room, P1, ADVANCE);
    const seed = seedBoard();
    const engine = new RoomEngine(providersFor(charted(seed)), { state: seed, waterfall: null });
    for (const entry of answer.entries!) {
      const before = { state: engine.snapshot.state, grid: engine.snapshot.grid };
      engine.apply(entry);
      const after = { state: engine.snapshot.state, grid: engine.snapshot.grid };
      expect(authorityDeclined(JSON.parse(entry.payload), before, after)).toBe(false);
    }
  });
});
