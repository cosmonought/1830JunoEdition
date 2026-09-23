// frontend/src/utils/stage101bLayTileTiming.test.ts
//
// Stage 10.1b: a `LayTile` is accepted only at a rules-authorized tile-lay timing (design note #1684).
//
// A PINNED board is the subject throughout -- every room a server has dealt since #1520 -- because the timing
// question is asked of pinned boards only; the last block pins the legacy-board exemption and says why.

import { RoomSession } from "./roomSession";
import { boardLayRefused, sandboxReplayProviders } from "../gameEngine/replayProviders";
import { STATIC_BOARD_HEXES, terrainBuildFeeAt } from "../components/hexBoardData";
import { applySandboxAction, applySandboxLayTile } from "../gameEngine/sandboxSession";
import { layTileLegalityRefusal, layTileRefusal, layTimingRefusal } from "../gameEngine/layTileAuthority";
import { turnRefusal } from "../gameEngine/turnAuthority";
import { stateDigest } from "../gameEngine/stateDigest";
import { sandboxGameState } from "../gameEngine/sandboxState";
import { withLevelPlayingFieldEntities, JK_PRIVATE_ID } from "../gameEngine/levelPlayingField";
import { JK_TILE_ABILITY_KEY } from "../gameEngine/kanawhaLicense";
import { CSL_ABILITY_KEY } from "../gameEngine/bonusLay";
import { withRules } from "../gameEngine/boardSelection";
import { resolveVariants } from "../gameEngine/gameVariants";
import { OPERATING_SUB_PHASE_ORDER, type OperatingSubPhase } from "../gameEngine/operatingSubPhase";
import { RULES_ENGINE_VERSION } from "../gameEngine/rulesVersion";
import { boardHomeHexToAxial } from "../gameEngine/homeStationAuthority";
import type { GameStateResponse } from "../gameEngine/gameState";
import type { GameplayExecuteMsg } from "./sessionKey";
import type { MapGridResponse } from "../components/hexContractTypes";
import { privateHexFor } from "../gameEngine/privateReservations";
import { layNetworkFor } from "../gameEngine/layConnectivity";
import { CSL_PRIVATE_ID, DH_PRIVATE_ID } from "../gameEngine/dhPower";

const PRR = 1;
const P1 = "p-alice";
const P2 = "p-bob";
const BARE: MapGridResponse = { game_id: 1, tiles: [] };
// K9 is (-1, 10): Coal River's NE neighbour, a $120 mountain; the JK's power lays there at $60.
const K9 = { q: -1, r: 10 };
// F6 (1, 2) on the standard board: an ordinary clear hex a tile #8 fits at facing 0 by geometry alone.
const F6 = { q: 1, r: 2 };

/** A pinned Operating-Round board with PRR operating, at `step`, on the Level Playing Field so the JK exists. */
function pinnedOperating(step: OperatingSubPhase | undefined, over: Partial<GameStateResponse> = {}): GameStateResponse {
  const base = withLevelPlayingFieldEntities({ ...sandboxGameState("OperatingRound", 1), variants: resolveVariants({ levelPlayingField: true }) });
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
    ...(step === undefined ? {} : { operating_sub_phase: step }),
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
      /* PRR's home token is placed, so the home-station hold (#1612) is not what a live room refuses on; the
         only question left for these boards is the one this file is about. */
      station_token_hexes: company.company_id === PRR ? [prrHome()] : [],
      station_tokens: company.company_id === PRR ? [[...prrHome(), 0]] : [],
      kanawha_licenses: undefined,
    })),
    private_companies: base.private_companies.map((entry) => ({
      ...entry,
      owner: null,
      owner_protocol_id: entry.private_id === JK_PRIVATE_ID ? PRR : null,
      closed: false,
    })),
    used_private_abilities: [],
    terrain_fees_paid: [],
    ...over,
  } as GameStateResponse;
}

const LPF = resolveVariants({ levelPlayingField: true });
function prrHome(): [number, number] {
  const label = sandboxGameState("OperatingRound", 1).public_companies.find((c) => c.company_id === PRR)?.home_hex_label;
  const axial = withRules(LPF, () => (label ? boardHomeHexToAxial(label) : null));
  if (!axial) throw new Error("PRR has no home hex on this board");
  return [axial[0], axial[1]];
}
const lay = (extra: Record<string, unknown> = {}, at = F6) =>
  ({ LayTile: { game_id: 1, protocol_id: PRR, q: at.q, r: at.r, tile_id: 8, orientation: 0, ...extra } }) as unknown as GameplayExecuteMsg;
/* Stage 10.6 (#1693): a power claim is validated against the board, so a special lay's timing is tested on a board
   where PRR really OWNS the private and lays on its hex -- never on a forged claim. */
function owning(state: GameStateResponse, privateId: number): GameStateResponse {
  return {
    ...state,
    private_companies: state.private_companies.map((entry) =>
      entry.private_id === privateId ? { ...entry, owner: null, owner_protocol_id: PRR, closed: false } : entry,
    ),
  };
}
const hexOf = (privateId: number) => {
  const hex = withRules(LPF, () => privateHexFor(privateId));
  if (!hex) throw new Error(`private ${privateId} has no hex`);
  return { q: hex.q, r: hex.r };
};
const body = (msg: GameplayExecuteMsg) => (msg as { LayTile: Parameters<typeof layTileLegalityRefusal>[1] }).LayTile;

/** Every atom, asked the way its caller asks: the verdict, the reducer, the grid. */
function everyAtom(state: GameStateResponse, msg: GameplayExecuteMsg) {
  return withRules(LPF, () => {
    const ctx = { mapGrid: BARE };
    const verdict = layTileRefusal(state, msg, ctx);
    const after = applySandboxAction(state, msg, ctx);
    const l = body(msg);
    const grid = applySandboxLayTile(BARE, l.q, l.r, l.tile_id, l.orientation, () => layTileRefusal(state, msg, ctx) !== null);
    return { verdict, after, grid };
  });
}

describe("1. the ordinary lay is accepted at Lay Track", () => {
  it("lands on both atoms and ends the step", () => {
    const state = pinnedOperating("Track");
    const { verdict, after, grid } = everyAtom(state, lay());
    expect(verdict).toBeNull();
    expect(after).not.toBe(state);
    expect(after.operating_sub_phase).toBe("Tokens");
    expect(grid).not.toBe(BARE);
  });

  it("a pre-#1440 `BuyPrivate` cursor is a turn that has not reached its lay, and is accepted like Track", () => {
    const state = pinnedOperating("BuyPrivate");
    expect(withRules(LPF, () => layTimingRefusal(state, { protocol_id: PRR }))).toBeNull();
    const { verdict, after } = everyAtom(state, lay());
    expect(verdict).toBeNull();
    expect(after).not.toBe(state);
  });
});

describe("2/3. an ordinary lay off the Lay Track step changes nothing, on every atom", () => {
  const offSteps: OperatingSubPhase[] = OPERATING_SUB_PHASE_ORDER.filter((step) => step !== "Track");
  it.each(offSteps)("at %s: verdict names the step; state by identity; grid by identity; cursor unmoved", (step) => {
    const state = pinnedOperating(step);
    const digest = stateDigest(state);
    const { verdict, after, grid } = everyAtom(state, lay());
    expect(verdict).toMatch(/lays track only at its Lay Track step/);
    expect(verdict).toContain("PRR");
    expect(after).toBe(state);
    expect(stateDigest(after)).toBe(digest);
    expect(after.operating_sub_phase).toBe(step);
    expect(grid).toBe(BARE);
  });

  it("the timing question comes right after the identity question, before geometry, anchoring, the JK and the fee", () => {
    // A lay that would ALSO fail geometry (the stub refuses everything) is answered with the timing sentence.
    const state = pinnedOperating("Routes");
    expect(withRules(LPF, () => layTileLegalityRefusal(state, body(lay()), { mapGrid: BARE, layRefused: () => true }))).toMatch(
      /Lay Track step/,
    );
    // And a corporation that is not operating hears the identity sentence first, whatever the step.
    const other = { ...body(lay()), protocol_id: 2 };
    expect(withRules(LPF, () => layTileLegalityRefusal(state, other, { mapGrid: BARE }))).toMatch(/Only the operating corporation lays track/);
  });
});

describe("4. every special lay is accepted at its legal timing -- which is Lay Track for all of them", () => {
  it("the JK's half-price lay at Track: half the mountain, JK closed, power spent, step ended", () => {
    const state = pinnedOperating("Track");
    const msg = lay({ ability_key: JK_TILE_ABILITY_KEY }, K9);
    const { verdict, after } = everyAtom(state, msg);
    expect(verdict).toBeNull();
    expect(Number(after.public_companies.find((c) => c.company_id === PRR)?.treasury)).toBe(1000 - 60);
    expect(after.private_companies.find((e) => e.private_id === JK_PRIVATE_ID)?.closed).toBe(true);
    expect(after.used_private_abilities).toContain(JK_TILE_ABILITY_KEY);
    expect(after.operating_sub_phase).toBe("Tokens");
  });

  it("the C&SL's bonus lay at Track keeps the step on Track, and the ordinary lay may follow", () => {
    // PRR owns the C&SL and lays its bonus on B20 -- a real entitlement (#1693), not a flag.
    const state = owning(pinnedOperating("Track"), CSL_PRIVATE_ID);
    const bonus = lay({ bonus_lay: true, ability_key: CSL_ABILITY_KEY }, hexOf(CSL_PRIVATE_ID));
    const first = everyAtom(state, bonus);
    expect(first.verdict).toBeNull();
    expect(first.after).not.toBe(state);
    expect(first.after.operating_sub_phase).toBe("Track");
    const second = everyAtom(first.after, lay({}, { q: 2, r: 2 }));
    expect(second.verdict).toBeNull();
    expect(second.after.operating_sub_phase).toBe("Tokens");
  });

  it("the D&H's keyed lay at Track consumes the ordinary placement and opens the free-station window", () => {
    // PRR owns the D&H and lays on F16 (#1693).
    const state = owning(pinnedOperating("Track"), DH_PRIVATE_ID);
    const { verdict, after } = everyAtom(state, lay({ ability_key: "dh-tile" }, hexOf(DH_PRIVATE_ID)));
    expect(verdict).toBeNull();
    expect(after.operating_sub_phase).toBe("Tokens");
    expect(after.dh_station_pending).toBe(PRR);
    expect(after.used_private_abilities).toContain("dh-tile");
  });
});

describe("5. a power key is a claim about WHICH lay, never about WHEN", () => {
  it.each([
    ["the JK key", { ability_key: JK_TILE_ABILITY_KEY }, K9],
    ["the C&SL bonus flag", { bonus_lay: true, ability_key: CSL_ABILITY_KEY }, F6],
    ["the D&H key", { ability_key: "dh-tile" }, F6],
  ])("%s at Tokens is refused on timing, with nothing spent and nothing laid", (_name, extra, at) => {
    const state = pinnedOperating("Tokens");
    const { verdict, after, grid } = everyAtom(state, lay(extra as Record<string, unknown>, at));
    expect(verdict).toMatch(/Lay Track step/);
    expect(after).toBe(state);
    expect(after.used_private_abilities).toEqual([]);
    expect(after.private_companies.find((e) => e.private_id === JK_PRIVATE_ID)?.closed).toBe(false);
    expect(grid).toBe(BARE);
  });

  it("after the ordinary lay has ended the step, the bonus flag does not buy a second Track step (bonusLayStep's third lay)", () => {
    const state = pinnedOperating("Track");
    const once = everyAtom(state, lay()).after;
    expect(once.operating_sub_phase).toBe("Tokens");
    const again = everyAtom(once, lay({ bonus_lay: true, ability_key: CSL_ABILITY_KEY }, { q: 2, r: 2 }));
    expect(again.verdict).toMatch(/Lay Track step/);
    expect(again.after).toBe(once);
  });
});

describe("live ingress: the same sentence, before the log grows", () => {
  const providers = sandboxReplayProviders();
  /* A lay the board's own geometry accepts on the engine's opening grid, found rather than typed: a clear hex
     and a yellow tile `boardLayRefused` admits. The room seeds the engine with `providers.initialGrid`.
     Stage 10.6 (#1692): and one that JOINS PRR's network -- connectivity is judged at ingress now, so the control
     must be a lay a president could actually make; the network is the authority's own (`layNetworkFor`). */
  function legalLay(): GameplayExecuteMsg {
    return withRules(LPF, () => {
      const network = layNetworkFor(pinnedOperating("Track"), providers.initialGrid, PRR) ?? undefined;
      for (const hex of STATIC_BOARD_HEXES) {
        if (terrainBuildFeeAt(hex.q, hex.r) > 0) continue;
        for (const tile of [7, 8, 9, 57, 58, 55, 56, 69]) {
          for (let orientation = 0; orientation < 6; orientation += 1) {
            if (!boardLayRefused(providers.initialGrid, hex.q, hex.r, tile, orientation, "Yellow", network)) {
              return lay({ tile_id: tile, orientation }, { q: hex.q, r: hex.r });
            }
          }
        }
      }
      throw new Error("no geometrically legal yellow lay on the opening grid");
    });
  }

  it("`turnRefusal` answers the mistimed lay with the timing sentence and the timely one with null", () => {
    const mistimed = pinnedOperating("Tokens");
    expect(
      withRules(LPF, () => turnRefusal({ state: mistimed, waterfall: null, actor: P1, msg: lay(), mapGrid: BARE })),
    ).toMatch(/Lay Track step/);
    const timely = pinnedOperating("Track");
    expect(withRules(LPF, () => turnRefusal({ state: timely, waterfall: null, actor: P1, msg: lay(), mapGrid: BARE }))).toBeNull();
  });

  it("`RoomSession.submit` refuses it, appends nothing, and leaves the board where it was", () => {
    /* AT RUN ROUTES, not Tokens: this fixture's PRR owes an auto-skip at Tokens (its network reaches no free
       slot), and `submit` finishes that burst BEFORE the gate (#1209 step 4) and then answers a refusal as a
       catch-up (step 5) -- correct, and a different property. At Routes with a train the board owes nothing
       derived, so the answer is the refusal itself. */
    let n = 0;
    const room = new RoomSession({
      providers,
      seed: { state: pinnedOperating("Routes"), waterfall: null },
      build: "build-under-test",
      mintId: () => `id${(n += 1)}`,
    });
    const digest = stateDigest(room.state);
    const result = room.submit({ actor: P1, build: "build-under-test", msg: legalLay(), baseIndex: -1, host: null });
    expect(result.kind).toBe("refused");
    if (result.kind === "refused") expect(result.reason).toMatch(/PRR lays track only at its Lay Track step — its turn is at Run Routes/);
    expect(room.entries).toHaveLength(0);
    expect(stateDigest(room.state)).toBe(digest);
    expect(room.state.operating_sub_phase).toBe("Routes");
  });

  it("...and applies the same lay at Track (the control)", () => {
    let n = 0;
    const room = new RoomSession({
      providers,
      seed: { state: pinnedOperating("Track"), waterfall: null },
      build: "build-under-test",
      mintId: () => `id${(n += 1)}`,
    });
    const result = room.submit({ actor: P1, build: "build-under-test", msg: legalLay(), baseIndex: -1, host: null });
    expect(result.kind).toBe("applied");
    expect(room.entries.length).toBeGreaterThanOrEqual(1);
    expect(JSON.parse(room.entries[0].payload)).toHaveProperty("LayTile");
    expect(room.state.operating_sub_phase).not.toBe("Track");
  });
});

describe("the legacy exemption, stated so nobody removes it by accident", () => {
  it("an UNPINNED board keeps the arm it was played on: a lay at Tokens is not asked the timing question (#1551's rule)", () => {
    /* The development corpus's sixty-eight off-step lays (JUNO-CV4 106, JUNO-Z6C 109 …) are legal lays made
       when a Phase-3 turn opened on `BuyPrivate`; under #1440 the same stored press reads Track -> Tokens.
       Refusing them would change what six canonical files replay to, which is a version boundary, not a
       gate. A pinned board -- every room dealt since #1520 -- never carries that history. */
    const legacy = { ...pinnedOperating("Tokens"), rules_engine_version: undefined } as GameStateResponse;
    expect(withRules(LPF, () => layTimingRefusal(legacy, { protocol_id: PRR }))).toBeNull();
    const { verdict, after } = everyAtom(legacy, lay());
    expect(verdict).toBeNull();
    expect(after).not.toBe(legacy);
  });

  it("a board with no cursor to read is not refused on timing (a fixture; the reducer settles one)", () => {
    const state = pinnedOperating(undefined);
    expect(withRules(LPF, () => layTimingRefusal(state, { protocol_id: PRR }))).toBeNull();
  });
});
