// frontend/src/utils/stage106LayTileClosure.test.ts
//
// Stage 10.6 -- the last pre-v8 `LayTile` authority: connectivity (S6-5, #1692), the validated private-power claim
// and the C&SL's either-order entitlement (S6-6, #1693 / #1697), the player-owned private's hex with the D&H's F16
// exception (S6-7, #1694 / #1694a / #1695), all on the ONE legacy / pinned seam (#1696); plus the direct proofs for
// S6-8 (gray / red, Stage 9.2's immutable-hex rule) and the S7-17 identity audit.
//
// Every refusal here is asked of all three atoms the way their callers ask -- the verdict (`layTileRefusal` with the
// grid step's context), the grid step (`applySandboxLayTile` on that verdict) and the reducer (`applySandboxAction`
// with `sandboxActionContext`, which hands the pre-lay `layGrid`) -- and the refused lay must leave all of them where
// they stood.

import { RoomSession } from "./roomSession";
import { boardLayRefused, sandboxReplayProviders } from "../gameEngine/replayProviders";
import { STATIC_BOARD_HEXES, terrainBuildFeeAt } from "../components/hexBoardData";
import { filterSandboxPlacements } from "../components/sandboxTileLegality";
import { applySandboxAction, applySandboxLayTile } from "../gameEngine/sandboxSession";
import { layTileLegalityRefusal, layTileRefusal } from "../gameEngine/layTileAuthority";
import { layAuthorityContext, sandboxActionContext } from "../gameEngine/actionContext";
import { layNetworkFor, layReachFor } from "../gameEngine/layConnectivity";
import {
  claimedLayAbilityKey,
  cslBonusEntitlement,
  privateLayClaimRefusal,
} from "../gameEngine/privateLayClaim";
import {
  activeReservations,
  describePrivateHexStatus,
  privateHexFor,
  privateHexMarkers,
  privateHexRefusal,
  privateHexRestrictions,
  privateHexStatuses,
  privateLocationLabels,
} from "../gameEngine/privateReservations";
import { turnRefusal } from "../gameEngine/turnAuthority";
import { stateDigest } from "../gameEngine/stateDigest";
import { sandboxGameState } from "../gameEngine/sandboxState";
import { withLevelPlayingFieldEntities, JK_PRIVATE_ID } from "../gameEngine/levelPlayingField";
import { JK_TILE_ABILITY_KEY } from "../gameEngine/kanawhaLicense";
import { CSL_ABILITY_KEY } from "../gameEngine/bonusLay";
import { CSL_PRIVATE_ID, DH_PRIVATE_ID } from "../gameEngine/dhPower";
import { withRules } from "../gameEngine/boardSelection";
import { resolveVariants } from "../gameEngine/gameVariants";
import { RULES_ENGINE_VERSION, stage106LayAuthorityInForce } from "../gameEngine/rulesVersion";
import { boardHomeHexToAxial } from "../gameEngine/homeStationAuthority";
import { withReservationNote } from "../components/HexGridRenderer";
import type { GameStateResponse } from "../gameEngine/gameState";
import type { GameplayExecuteMsg } from "./sessionKey";
import type { MapGridResponse } from "../components/hexContractTypes";

const PRR = 1;
const NYC = 3;
const P1 = "p-alice";
const P2 = "p-bob";
const LPF = resolveVariants({ levelPlayingField: true });
const STANDARD = resolveVariants({});
const providers = sandboxReplayProviders();
const GRID: MapGridResponse = providers.initialGrid;

function homeOf(companyId: number, rules: typeof LPF): [number, number] {
  const label = sandboxGameState("OperatingRound", 1).public_companies.find((c) => c.company_id === companyId)?.home_hex_label;
  const axial = withRules(rules, () => (label ? boardHomeHexToAxial(label) : null));
  if (!axial) throw new Error(`company ${companyId} has no home hex`);
  return [axial[0], axial[1]];
}

/** A PINNED Operating-Round board, PRR operating at `step`, its home token placed, every private unsold. */
function board(
  opts: { rules?: typeof LPF; step?: string; pinned?: boolean; tokens?: Array<[number, number]> } = {},
): GameStateResponse {
  const rules = opts.rules ?? LPF;
  const raw = { ...sandboxGameState("OperatingRound", 1), variants: rules };
  const base = rules.levelPlayingField ? withLevelPlayingFieldEntities(raw) : raw;
  const tokens = opts.tokens ?? [homeOf(PRR, rules)];
  return {
    ...base,
    rules_engine_version: opts.pinned === false ? undefined : RULES_ENGINE_VERSION,
    current_round_type: "OperatingRound",
    current_global_era: "Yellow",
    player_addresses: [P1, P2],
    active_operating_order: [PRR],
    active_corporation_index: 0,
    macro_round_number: 2,
    sub_round_index: 1,
    operating_sub_phase: opts.step ?? "Track",
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
      station_token_hexes: company.company_id === PRR ? tokens : [],
      station_tokens: company.company_id === PRR ? tokens.map(([q, r]) => [q, r, 0] as [number, number, number]) : [],
      kanawha_licenses: undefined,
    })),
    private_companies: base.private_companies.map((entry) => ({ ...entry, owner: null, owner_protocol_id: null, closed: false })),
    used_private_abilities: [],
    terrain_fees_paid: [],
  } as GameStateResponse;
}

type Owner = { player: string } | { corp: number } | "closed" | "unsold";
function withPrivate(state: GameStateResponse, privateId: number, who: Owner): GameStateResponse {
  return {
    ...state,
    private_companies: state.private_companies.map((entry) => {
      if (entry.private_id !== privateId) return entry;
      if (who === "closed") return { ...entry, owner: P2, owner_protocol_id: null, closed: true };
      if (who === "unsold") return { ...entry, owner: null, owner_protocol_id: null, closed: false };
      if ("player" in who) return { ...entry, owner: who.player, owner_protocol_id: null, closed: false };
      return { ...entry, owner: null, owner_protocol_id: who.corp, closed: false };
    }),
  };
}

const rulesOf = (state: GameStateResponse) => resolveVariants(state.variants);
const hexByLabel = (label: string, rules = LPF) => {
  const hex = withRules(rules, () => STATIC_BOARD_HEXES.find((entry) => entry.label === label));
  if (!hex) throw new Error(`no ${label}`);
  return { q: hex.q, r: hex.r };
};
const lay = (at: { q: number; r: number }, tile: number, orientation: number, extra: Record<string, unknown> = {}, who = PRR) =>
  ({ LayTile: { game_id: 1, protocol_id: who, q: at.q, r: at.r, tile_id: tile, orientation, ...extra } }) as unknown as GameplayExecuteMsg;
const body = (msg: GameplayExecuteMsg) => (msg as { LayTile: Parameters<typeof layTileLegalityRefusal>[1] }).LayTile;

/** Every atom, asked the way its caller asks. */
function atoms(state: GameStateResponse, msg: GameplayExecuteMsg, grid: MapGridResponse = GRID) {
  return withRules(rulesOf(state), () => {
    const verdict = layTileRefusal(state, msg, layAuthorityContext(providers, state, grid));
    const l = body(msg);
    const nextGrid = applySandboxLayTile(grid, l.q, l.r, l.tile_id, l.orientation, () => verdict !== null);
    const after = applySandboxAction(
      state,
      msg,
      sandboxActionContext(providers, { state, msg, actor: P1, grid: nextGrid, gridBefore: grid }),
    );
    return { verdict, after, grid: nextGrid };
  });
}

/** A refused lay leaves every atom where it stood. */
function expectNothingMoved(state: GameStateResponse, result: ReturnType<typeof atoms>, grid: MapGridResponse = GRID) {
  expect(result.verdict).not.toBeNull();
  expect(result.grid).toBe(grid);
  expect(stateDigest(result.after)).toBe(stateDigest(state));
  expect(result.after.operating_sub_phase).toBe(state.operating_sub_phase);
  expect(result.after.terrain_fees_paid).toEqual(state.terrain_fees_paid);
  expect(result.after.used_private_abilities).toEqual(state.used_private_abilities);
  expect(result.after.ordinary_lay_taken).toBe(state.ordinary_lay_taken);
  expect(result.after.private_companies).toEqual(state.private_companies);
  const prr = (s: GameStateResponse) => s.public_companies.find((c) => c.company_id === PRR)!;
  expect(prr(result.after).treasury).toBe(prr(state).treasury);
  expect(prr(result.after).station_token_hexes).toEqual(prr(state).station_token_hexes);
}

const YELLOW = [7, 8, 9, 57, 58, 55, 56, 69, 1, 2, 3, 4];
const privateLabels = new Set(["G15", "B20", "F16", "D18", "H18", "I13", "I15", "K9", "K11"]);
/** A free, non-private, geometry-legal yellow lay on `GRID`, connected (or not) to PRR's network. */
function findLay(state: GameStateResponse, connected: boolean): GameplayExecuteMsg {
  return withRules(rulesOf(state), () => {
    const network = layNetworkFor(state, GRID, PRR);
    if (!network) throw new Error("PRR has no network");
    for (const hex of STATIC_BOARD_HEXES) {
      if (privateLabels.has(hex.label) || terrainBuildFeeAt(hex.q, hex.r) > 0) continue;
      for (const tile of YELLOW) {
        for (let o = 0; o < 6; o += 1) {
          if (boardLayRefused(GRID, hex.q, hex.r, tile, o, "Yellow")) continue;
          const joins = !boardLayRefused(GRID, hex.q, hex.r, tile, o, "Yellow", network);
          if (joins === connected) return lay({ q: hex.q, r: hex.r }, tile, o);
        }
      }
    }
    throw new Error(`no ${connected ? "connected" : "disconnected"} lay found`);
  });
}
/** A geometry-legal yellow tile at `at` (connectivity not asked). */
function geometricTile(state: GameStateResponse, at: { q: number; r: number }): { tile: number; o: number } {
  return withRules(rulesOf(state), () => {
    for (const tile of YELLOW) for (let o = 0; o < 6; o += 1) if (!boardLayRefused(GRID, at.q, at.r, tile, o, "Yellow")) return { tile, o };
    throw new Error("no geometric tile");
  });
}

/* ================================================================== */
describe("#1696 the legacy / pinned seam", () => {
  it("is one predicate: a numeric `rules_engine_version`", () => {
    expect(stage106LayAuthorityInForce({ rules_engine_version: RULES_ENGINE_VERSION })).toBe(true);
    expect(stage106LayAuthorityInForce({ rules_engine_version: undefined })).toBe(false);
    expect(stage106LayAuthorityInForce({ rules_engine_version: null })).toBe(false);
    expect(stage106LayAuthorityInForce(null)).toBe(false);
  });

  it("a LEGACY board keeps the historical reading of all three new rules", () => {
    const legacy = board({ pinned: false });
    // S6-5: a disconnected lay is applied, as the legacy corpus's 14 were.
    const far = findLay(board(), false);
    expect(atoms(legacy, far).verdict).toBeNull();
    // S6-7: a player-owned private's hex is open, and nothing is marked.
    const owned = withPrivate(legacy, 1, { player: P2 });
    expect(withRules(LPF, () => privateHexStatuses(owned))).toEqual([]);
    const g15 = hexByLabel("G15");
    expect(withRules(LPF, () => layTileLegalityRefusal(owned, body(lay(g15, 7, 0)), { mapGrid: GRID }))).toBeNull();
    // S6-6: #776's trusted flag -- the step stays on Track -- exactly as before.
    const flagged = atoms(legacy, lay(far ? body(far) : g15, body(far).tile_id, body(far).orientation, { bonus_lay: true }));
    expect(flagged.verdict).toBeNull();
    expect(flagged.after.operating_sub_phase).toBe("Track");
    expect(flagged.after.ordinary_lay_taken).toBeUndefined();
  });

  it("but every rule that existed before 10.6 is still asked on a legacy board (identity; Stage 9.2's gray hex)", () => {
    const legacy = board({ pinned: false });
    const other = atoms(legacy, lay(body(findLay(board(), true)), 7, 0, {}, 2));
    expect(other.verdict).toMatch(/Only the operating corporation lays track/);
    const gray = withRules(LPF, () => STATIC_BOARD_HEXES.find((h) => h.printedColor === "Gray")!);
    expectNothingMoved(legacy, atoms(legacy, lay(gray, 8, 0)));
  });
});

/* ================================================================== */
describe("S6-5 connectivity (#1692), on a pinned board", () => {
  it("an ordinary connected lay is accepted and lands on both atoms", () => {
    const state = board();
    const result = atoms(state, findLay(state, true));
    expect(result.verdict).toBeNull();
    expect(result.grid).not.toBe(GRID);
    expect(result.after.operating_sub_phase).toBe("Tokens");
  });

  it("a geometrically legal but disconnected lay is refused, and nothing moves", () => {
    const state = board();
    const far = findLay(state, false);
    const result = atoms(state, far);
    expect(result.verdict).toMatch(/does not connect to PRR's network/);
    expectNothingMoved(state, result);
  });

  it("the shell's picker and the authority give the same verdict for every candidate near the network", () => {
    const state = board();
    withRules(LPF, () => {
      // The shell's Lay Track focus calls `layReachFor` and hands its network/ports to `filterSandboxPlacements`.
      const reach = layReachFor(state, GRID, PRR);
      const net = layNetworkFor(state, GRID, PRR)!;
      expect(Array.from(net.hexes).sort()).toEqual(Array.from(reach.network).sort());
      expect(Array.from(net.ports).sort()).toEqual(Array.from(reach.ports).sort());
      let compared = 0;
      for (const hex of STATIC_BOARD_HEXES) {
        if (privateLabels.has(hex.label)) continue;
        for (const tile of YELLOW) {
          for (let o = 0; o < 6; o += 1) {
            const picker =
              filterSandboxPlacements([{ tile_id: tile, orientation: o }], {
                mapGrid: GRID,
                q: hex.q,
                r: hex.r,
                era: "Yellow",
                networkHexes: reach.network,
                networkPorts: reach.ports,
              }).length > 0;
            const authority =
              layTileLegalityRefusal(state, body(lay(hex, tile, o)), layAuthorityContext(providers, state, GRID)) === null;
            if (authority) expect(picker).toBe(true);
            if (picker && terrainBuildFeeAt(hex.q, hex.r) === 0) expect(authority).toBe(true);
            compared += 1;
          }
        }
      }
      expect(compared).toBeGreaterThan(1000);
    });
  });

  it("is not Classic-only or LPF-only: the standard board refuses a disconnected lay too", () => {
    const state = board({ rules: STANDARD });
    const far = findLay(state, false);
    expectNothingMoved(state, atoms(state, far));
  });

  it("ingress answers the same sentence, and `RoomSession.submit` appends nothing", () => {
    const state = board();
    const far = findLay(state, false);
    const sentence = withRules(LPF, () => turnRefusal({ state, waterfall: null, actor: P1, msg: far, mapGrid: GRID,
      layRefused: (q, r, t, o, network) => boardLayRefused(GRID, q, r, t, o, "Yellow", network) }));
    expect(sentence).toMatch(/does not connect to PRR's network/);
    let n = 0;
    const room = new RoomSession({ providers, seed: { state, waterfall: null }, build: "b", mintId: () => `id${(n += 1)}` });
    const digest = stateDigest(room.state);
    const result = room.submit({ actor: P1, build: "b", msg: far, baseIndex: -1, host: null });
    expect(result.kind).toBe("refused");
    expect(room.entries).toHaveLength(0);
    expect(stateDigest(room.state)).toBe(digest);
    const ok = room.submit({ actor: P1, build: "b", msg: findLay(state, true), baseIndex: -1, host: null });
    expect(ok.kind).toBe("applied");
  });

  describe("the two surviving exceptions are the powers, and only while live", () => {
    const b20 = () => hexByLabel("B20");
    const f16 = () => hexByLabel("F16");
    it("the C&SL's bonus lay on B20 needs no connection -- when PRR owns the live C&SL", () => {
      const state = withPrivate(board(), CSL_PRIVATE_ID, { corp: PRR });
      const { tile, o } = geometricTile(state, b20());
      const msg = lay(b20(), tile, o, { bonus_lay: true, ability_key: CSL_ABILITY_KEY });
      withRules(LPF, () => expect(boardLayRefused(GRID, b20().q, b20().r, tile, o, "Yellow", layNetworkFor(state, GRID, PRR)!)).toBe(true));
      const result = atoms(state, msg);
      expect(result.verdict).toBeNull();
      expect(result.after.operating_sub_phase).toBe("Track");
      expect(result.after.used_private_abilities).toContain(CSL_ABILITY_KEY);
    });
    it("...and not once the power is spent, B20 is built, or another corporation owns it", () => {
      const owned = withPrivate(board(), CSL_PRIVATE_ID, { corp: PRR });
      const { tile, o } = geometricTile(owned, b20());
      const msg = lay(b20(), tile, o, { bonus_lay: true, ability_key: CSL_ABILITY_KEY });
      const spent = { ...owned, used_private_abilities: [CSL_ABILITY_KEY] };
      expectNothingMoved(spent, atoms(spent, msg));
      const built: MapGridResponse = { ...GRID, tiles: [...GRID.tiles, { q: b20().q, r: b20().r, tile_id: tile, orientation: o } as never] };
      expect(atoms(owned, msg, built).verdict).not.toBeNull();
      const elsewhere = withPrivate(board(), CSL_PRIVATE_ID, { corp: NYC });
      expectNothingMoved(elsewhere, atoms(elsewhere, msg));
    });
    it("the D&H's lay on F16 needs no connection -- when PRR owns the live D&H -- and consumes the ordinary lay", () => {
      const state = withPrivate(board(), DH_PRIVATE_ID, { corp: PRR });
      const { tile, o } = geometricTile(state, f16());
      const result = atoms(state, lay(f16(), tile, o, { ability_key: "dh-tile" }));
      expect(result.verdict).toBeNull();
      expect(result.after.operating_sub_phase).toBe("Tokens");
      expect(result.after.dh_station_pending).toBe(PRR);
    });
    it("...and not once used or owned by another corporation", () => {
      const owned = withPrivate(board(), DH_PRIVATE_ID, { corp: PRR });
      const { tile, o } = geometricTile(owned, f16());
      const msg = lay(f16(), tile, o, { ability_key: "dh-tile" });
      const used = { ...owned, used_private_abilities: ["dh-tile"] };
      expectNothingMoved(used, atoms(used, msg));
      const theirs = withPrivate(board(), DH_PRIVATE_ID, { corp: NYC });
      expectNothingMoved(theirs, atoms(theirs, msg));
    });
    it("the JK's half-price lay is NOT an exception: it is the ordinary lay, judged for connectivity", () => {
      const state = withPrivate(board(), JK_PRIVATE_ID, { corp: PRR });
      const k9 = hexByLabel("K9");
      withRules(LPF, () => {
        const net = layNetworkFor(state, GRID, PRR)!;
        const { tile, o } = geometricTile(state, k9);
        // K9 is geometrically open and outside PRR's network on this board -- the premise, asserted.
        expect(boardLayRefused(GRID, k9.q, k9.r, tile, o, "Yellow", net)).toBe(true);
        expect(atoms(state, lay(k9, tile, o, { ability_key: JK_TILE_ABILITY_KEY })).verdict).toMatch(/does not connect/);
      });
    });
  });
});

/* ================================================================== */
describe("S6-6 the private-power claim (#1693), on a pinned board", () => {
  const b20 = () => hexByLabel("B20");
  const bonusAt = (state: GameStateResponse, at = b20()) => {
    const { tile, o } = geometricTile(state, at);
    return lay(at, tile, o, { bonus_lay: true, ability_key: CSL_ABILITY_KEY });
  };
  it("a corporation without the C&SL cannot claim its bonus", () => {
    const state = board();
    const result = atoms(state, bonusAt(state));
    expect(result.verdict).toMatch(/does not own the Champlain & St. Lawrence/);
    expectNothingMoved(state, result);
  });
  it("a bonus claimed off B20 is refused", () => {
    const state = withPrivate(board(), CSL_PRIVATE_ID, { corp: PRR });
    const far = body(findLay(state, true));
    const result = atoms(state, lay(far, far.tile_id, far.orientation, { bonus_lay: true, ability_key: CSL_ABILITY_KEY }));
    expect(result.verdict).toMatch(/bonus lay is on B20 only/);
    expectNothingMoved(state, result);
  });
  it("the two representations must agree", () => {
    const state = withPrivate(board(), CSL_PRIVATE_ID, { corp: PRR });
    const l = body(bonusAt(state));
    withRules(LPF, () => {
      expect(privateLayClaimRefusal(state, { ...l, ability_key: "dh-tile" }, GRID)).toMatch(/Only the Champlain/);
      expect(privateLayClaimRefusal(state, { ...l, ability_key: JK_TILE_ABILITY_KEY }, GRID)).toMatch(/Only the Champlain/);
      expect(privateLayClaimRefusal(state, { ...l, bonus_lay: undefined }, GRID)).toMatch(/is sent as one/);
      expect(privateLayClaimRefusal(state, { ...l, ability_key: "dh-token" }, GRID)).toMatch(/not a private power that lays a tile/);
      expect(privateLayClaimRefusal(state, { ...l, ability_key: undefined }, GRID)).toBeNull(); // pre-#1204 shape, still validated
      expect(claimedLayAbilityKey({ ability_key: "" })).toBeNull();
    });
  });
  it("a forged flag cannot preserve the Track step: every repetition is refused by identity of content", () => {
    let state = board();
    const forged = lay(body(findLay(state, true)), body(findLay(state, true)).tile_id, body(findLay(state, true)).orientation, { bonus_lay: true });
    for (let i = 0; i < 3; i += 1) {
      const result = atoms(state, forged);
      expectNothingMoved(state, result);
      state = result.after;
    }
    expect(state.operating_sub_phase).toBe("Track");
  });
  it("the same valid bonus cannot be taken twice", () => {
    const state = withPrivate(board(), CSL_PRIVATE_ID, { corp: PRR });
    const first = atoms(state, bonusAt(state));
    expect(first.verdict).toBeNull();
    const again = atoms(first.after, bonusAt(state), first.grid);
    expect(again.verdict).not.toBeNull();
    expectNothingMoved(first.after, again, first.grid);
  });
  it("a forged D&H claim is refused; a D&H claim off F16 is refused", () => {
    const f16 = hexByLabel("F16");
    const state = board();
    const { tile, o } = geometricTile(state, f16);
    expectNothingMoved(state, atoms(state, lay(f16, tile, o, { ability_key: "dh-tile" })));
    const owned = withPrivate(board(), DH_PRIVATE_ID, { corp: PRR });
    const far = body(findLay(owned, true));
    expect(atoms(owned, lay(far, far.tile_id, far.orientation, { ability_key: "dh-tile" })).verdict).toMatch(/on F16 only/);
  });
  it("ingress answers the forged bonus with the same sentence", () => {
    const state = board();
    const msg = bonusAt(state);
    expect(withRules(LPF, () => turnRefusal({ state, waterfall: null, actor: P1, msg, mapGrid: GRID }))).toMatch(
      /does not own the Champlain & St. Lawrence/,
    );
  });
});

/* ================================================================== */
describe("S6-6 either order (#1697): one ordinary lay and, while eligible, one C&SL bonus", () => {
  const b20 = () => hexByLabel("B20");
  const owned = () => withPrivate(board(), CSL_PRIVATE_ID, { corp: PRR });
  const bonusMsg = (state: GameStateResponse) => {
    const { tile, o } = geometricTile(state, b20());
    return lay(b20(), tile, o, { bonus_lay: true, ability_key: CSL_ABILITY_KEY });
  };
  it("bonus, then ordinary: Track holds after the bonus, ends after the ordinary lay", () => {
    const state = owned();
    const bonus = atoms(state, bonusMsg(state));
    expect(bonus.after.operating_sub_phase).toBe("Track");
    const ordinary = atoms(bonus.after, findLay(state, true), bonus.grid);
    expect(ordinary.verdict).toBeNull();
    expect(ordinary.after.operating_sub_phase).toBe("Tokens");
    expect(ordinary.after.ordinary_lay_taken).toBeUndefined();
  });
  it("ordinary, then bonus: Track holds for the bonus, a second ordinary lay is refused, the bonus ends the step", () => {
    const state = owned();
    const ordinary = atoms(state, findLay(state, true));
    expect(ordinary.verdict).toBeNull();
    expect(ordinary.after.operating_sub_phase).toBe("Track");
    expect(ordinary.after.ordinary_lay_taken).toBe(PRR);
    const second = atoms(ordinary.after, findLay(state, true), ordinary.grid);
    expect(second.verdict).toMatch(/already made its ordinary tile lay this turn/);
    expectNothingMoved(ordinary.after, second, ordinary.grid);
    const bonus = atoms(ordinary.after, bonusMsg(state), ordinary.grid);
    expect(bonus.verdict).toBeNull();
    expect(bonus.after.operating_sub_phase).toBe("Tokens");
  });
  it("no C&SL, or a spent one: the ordinary lay ends the step and writes nothing", () => {
    for (const state of [board(), { ...owned(), used_private_abilities: [CSL_ABILITY_KEY] }]) {
      const result = atoms(state, findLay(state, true));
      expect(result.after.operating_sub_phase).toBe("Tokens");
      expect(result.after.ordinary_lay_taken).toBeUndefined();
    }
  });
  it("skipping Track after the ordinary lay manufactures nothing: the bonus is then mistimed", () => {
    const state = owned();
    const ordinary = atoms(state, findLay(state, true));
    const skipped = withRules(LPF, () =>
      applySandboxAction(ordinary.after, { AdvanceOperatingSubPhase: { game_id: 1, protocol_id: PRR } } as never, { mapGrid: ordinary.grid }),
    );
    expect(skipped.operating_sub_phase).toBe("Tokens");
    const late = atoms(skipped, bonusMsg(state), ordinary.grid);
    expect(late.verdict).toMatch(/Lay Track step/);
  });
  it("the D&H's lay and the JK's lay use the ordinary placement -- so the bonus may still follow them", () => {
    const state = withPrivate(owned(), DH_PRIVATE_ID, { corp: PRR });
    const f16 = hexByLabel("F16");
    const { tile, o } = geometricTile(state, f16);
    const dh = atoms(state, lay(f16, tile, o, { ability_key: "dh-tile" }));
    expect(dh.verdict).toBeNull();
    expect(dh.after.dh_station_pending).toBe(PRR);
    expect(dh.after.operating_sub_phase).toBe("Track");
    expect(atoms(dh.after, findLay(state, true), dh.grid).verdict).toMatch(/already made its ordinary tile lay/);
    expect(atoms(dh.after, bonusMsg(state), dh.grid).after.operating_sub_phase).toBe("Tokens");
  });
  it("the turn change clears the hold (a turn-scoped fact)", () => {
    const state = owned();
    const ordinary = atoms(state, findLay(state, true));
    expect(ordinary.after.ordinary_lay_taken).toBe(PRR);
    const nextTurn = withRules(LPF, () =>
      applySandboxAction({ ...ordinary.after, active_operating_order: [PRR, NYC] }, { PassTurn: { game_id: 1 } } as never, { mapGrid: ordinary.grid }),
    );
    // The premise: the pass really ended PRR's turn.
    expect(nextTurn.active_corporation_index !== 0 || nextTurn.current_round_type !== "OperatingRound").toBe(true);
    expect(nextTurn.ordinary_lay_taken).toBeUndefined();
  });
  it("entitlement is derived, never inferred from B20 alone", () => {
    withRules(LPF, () => {
      expect(cslBonusEntitlement(owned(), PRR, GRID)).toBe(true);
      expect(cslBonusEntitlement(owned(), NYC, GRID)).toBe(false);
      expect(cslBonusEntitlement(board(), PRR, GRID)).toBe(false);
    });
  });
});

/* ================================================================== */
describe("S6-7 player-owned private hexes (#1694), on a pinned board", () => {
  const barred: Array<[string, number, string, typeof LPF]> = [
    ["SV", 1, "G15", STANDARD],
    ["CSL", CSL_PRIVATE_ID, "B20", STANDARD],
    ["MH", 4, "D18", STANDARD],
    ["CA", 5, "H18", STANDARD],
    ["BO", 6, "I13", STANDARD],
    ["BO", 6, "I15", STANDARD],
    ["JK", JK_PRIVATE_ID, "K9", LPF],
    ["JK", JK_PRIVATE_ID, "K11", LPF],
  ];
  it.each(barred)("a player-owned %s (private %s) bars %s", (_name, privateId, label, rules) => {
    const state = withPrivate(board({ rules }), privateId, { player: P2 });
    const at = hexByLabel(label, rules);
    withRules(rules, () => {
      expect(privateHexRefusal(state, at.q, at.r)).toContain(label);
      expect(layTileLegalityRefusal(state, body(lay(at, 7, 0)), { mapGrid: GRID })).toContain("a player owns it");
    });
    expectNothingMoved(state, atoms(state, lay(at, 7, 0)));
  });
  it("the JK's rows exist only under the Level Playing Field", () => {
    expect(privateLocationLabels(JK_PRIVATE_ID, STANDARD)).toEqual([]);
    expect(privateLocationLabels(JK_PRIVATE_ID, LPF)).toEqual(["K9", "K11"]);
    const standard = board({ rules: STANDARD });
    const withJk = {
      ...standard,
      private_companies: [...standard.private_companies, { private_id: JK_PRIVATE_ID, name: "JK", cost: "120", revenue_per_or: "20", owner: P2, owner_protocol_id: null, closed: false }],
    } as GameStateResponse;
    expect(withRules(STANDARD, () => privateHexStatuses(withJk).some((s) => s.privateId === JK_PRIVATE_ID))).toBe(false);
  });
  it.each<[string, Owner]>([
    ["corporation-owned", { corp: NYC }],
    ["closed", "closed"],
    ["unsold", "unsold"],
  ])("a %s private restricts nothing", (_name, who) => {
    for (const [, privateId, label, rules] of barred) {
      const state = withPrivate(board({ rules }), privateId, who);
      const at = hexByLabel(label, rules);
      expect(withRules(rules, () => privateHexRefusal(state, at.q, at.r))).toBeNull();
    }
  });
  it("the JK's location rule is not its Coal River power (K9 is both a location and a Coal River neighbour)", () => {
    const k9 = hexByLabel("K9");
    // Player-owned JK: K9 barred, and the power is not the corporation's to use either.
    const playerJk = withPrivate(board(), JK_PRIVATE_ID, { player: P2 });
    expect(withRules(LPF, () => privateHexRefusal(playerJk, k9.q, k9.r))).not.toBeNull();
    // Corporation-owned JK: K9 released; the half-price lay is judged by `jkTileRefusal` as before (not by location).
    const corpJk = withPrivate(board(), JK_PRIVATE_ID, { corp: PRR });
    expect(withRules(LPF, () => privateHexRefusal(corpJk, k9.q, k9.r))).toBeNull();
    const l6 = hexByLabel("L6"); // a Coal River neighbour that is NOT a JK location
    expect(withRules(LPF, () => privateHexRefusal(playerJk, l6.q, l6.r))).toBeNull();
  });

  describe("#1694a the D&H's specific exception at F16", () => {
    const f16 = () => hexByLabel("F16");
    it("a player-owned D&H does not bar F16: its status says so", () => {
      const state = withPrivate(board(), DH_PRIVATE_ID, { player: P2 });
      withRules(LPF, () => {
        expect(privateHexRefusal(state, f16().q, f16().r)).toBeNull();
        const status = privateHexStatuses(state).find((s) => s.privateId === DH_PRIVATE_ID)!;
        expect(status.effect).toBe("opens-forfeiting-power");
        expect(describePrivateHexStatus(status)).toMatch(/any railroad may still lay here under the ordinary rules/);
        expect(privateHexRestrictions(state).some((s) => s.privateId === DH_PRIVATE_ID)).toBe(false);
      });
    });
    it("an unrelated railroad's ordinary CONNECTED F16 lay is accepted, and forfeits the D&H", () => {
      // PRR has a station on F16 itself, so F16 is in its network: the ordinary rules are met.
      const state = withPrivate(board({ tokens: [homeOf(PRR, LPF), [f16().q, f16().r]] }), DH_PRIVATE_ID, { player: P2 });
      const { tile, o } = geometricTile(state, f16());
      const result = atoms(state, lay(f16(), tile, o));
      expect(result.verdict).toBeNull();
      expect(result.grid).not.toBe(GRID);
      // The D&H's power is gone: F16 built, never by the power (`dhPowerState`'s forfeit) -- so when a
      // corporation later owns the D&H, its claim is refused with the forfeiture sentence.
      expect(result.after.used_private_abilities).not.toContain("dh-tile");
      const later = withPrivate(result.after, DH_PRIVATE_ID, { corp: PRR });
      expect(withRules(LPF, () => privateLayClaimRefusal(later, { protocol_id: PRR, q: f16().q, r: f16().r, ability_key: "dh-tile" }, result.grid))).toMatch(
        /already built on F16, so the D&H's powers are gone/,
      );
    });
    it("an unrelated railroad's DISCONNECTED F16 lay is refused by ordinary connectivity, not by the private", () => {
      const state = withPrivate(board(), DH_PRIVATE_ID, { player: P2 });
      const { tile, o } = geometricTile(state, f16());
      const result = atoms(state, lay(f16(), tile, o));
      expect(result.verdict).toMatch(/does not connect/);
      expectNothingMoved(state, result);
    });
  });

  it("ingress answers the private-hex refusal with the same sentence", () => {
    const state = withPrivate(board(), 5, { player: P2 });
    const h18 = hexByLabel("H18");
    expect(withRules(LPF, () => turnRefusal({ state, waterfall: null, actor: P1, msg: lay(h18, 7, 0), mapGrid: GRID }))).toMatch(
      /Camden & Amboy's hex, and a player owns it/,
    );
  });
});

/* ================================================================== */
describe("#1695 the board's private marks follow the same status", () => {
  const everyOwned = (who: Owner, rules = LPF) =>
    [1, 2, 3, 4, 5, 6, JK_PRIVATE_ID].reduce((s, id) => withPrivate(s, id, who), board({ rules }));
  const labelsOf = (markers: ReturnType<typeof privateHexMarkers>, pick: (m: (typeof markers)[number]) => boolean) =>
    markers.filter(pick).map((m) => m.hexLabel).sort();

  it("frames every barred location -- SV, CSL, MH, CA, BO ×2, JK ×2 -- and never F16", () => {
    const state = everyOwned({ player: P2 });
    const markers = withRules(LPF, () => privateHexMarkers(privateHexStatuses(state), activeReservations(state.private_companies, new Set([2, 3]))));
    expect(labelsOf(markers, (m) => m.restricted)).toEqual(["B20", "D18", "G15", "H18", "I13", "I15", "K11", "K9"]);
    const csl = markers.find((m) => m.hexLabel === "B20")!;
    expect(csl.specialPower).toBe(true); // the star inside the frame
    const dh = markers.find((m) => m.hexLabel === "F16")!;
    expect(dh.restricted).toBe(false);
    expect(dh.specialPower).toBe(true);
    expect(dh.status?.effect).toBe("opens-forfeiting-power");
    for (const m of markers.filter((x) => !["B20", "F16"].includes(x.hexLabel))) expect(m.specialPower).toBe(false);
  });
  it("the JK frames are absent outside the Level Playing Field", () => {
    const state = everyOwned({ player: P2 }, STANDARD);
    const markers = withRules(STANDARD, () => privateHexMarkers(privateHexStatuses(state), []));
    expect(labelsOf(markers, (m) => m.restricted)).toEqual(["B20", "D18", "G15", "H18", "I13", "I15"]);
  });
  it.each<[string, Owner]>([["corporation-owned", { corp: NYC }], ["closed", "closed"], ["unsold", "unsold"]])(
    "a %s private shows no frame",
    (_name, who) => {
      const state = everyOwned(who);
      expect(withRules(LPF, () => privateHexMarkers(privateHexStatuses(state), [])).filter((m) => m.restricted)).toEqual([]);
    },
  );
  it("a corporation-owned C&SL with a live power keeps its star and loses the frame", () => {
    const state = withPrivate(board(), CSL_PRIVATE_ID, { corp: PRR });
    const markers = withRules(LPF, () => privateHexMarkers(privateHexStatuses(state), activeReservations(state.private_companies, new Set([2]))));
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({ hexLabel: "B20", restricted: false, specialPower: true, status: null });
  });
  it("a legacy board shows nothing the replay does not enforce", () => {
    const state = [1, 2, 4, 5, 6, JK_PRIVATE_ID].reduce((s, id) => withPrivate(s, id, { player: P2 }), board({ pinned: false }));
    expect(withRules(LPF, () => privateHexMarkers(privateHexStatuses(state), []))).toEqual([]);
  });
  it("frame ⇔ refusal, hex by hex, for every private state", () => {
    for (const who of [{ player: P2 }, { corp: NYC }, "closed", "unsold"] as Owner[]) {
      const state = everyOwned(who);
      withRules(LPF, () => {
        const framed = new Set(privateHexMarkers(privateHexStatuses(state), []).filter((m) => m.restricted).map((m) => `${m.q},${m.r}`));
        for (const hex of STATIC_BOARD_HEXES) {
          expect(framed.has(`${hex.q},${hex.r}`)).toBe(privateHexRefusal(state, hex.q, hex.r) !== null);
        }
      });
    }
  });
  it("the hover prints the shared status sentence, as its own clause after the power", () => {
    const state = withPrivate(board(), DH_PRIVATE_ID, { player: P2 });
    withRules(LPF, () => {
      const status = privateHexStatuses(state)[0];
      const dh = activeReservations(state.private_companies, new Set([3]))[0];
      const note = withReservationNote("Scranton (F16)", dh, describePrivateHexStatus(status));
      expect(note).toBe(`Scranton (F16) — DH: ${dh.power} · ${describePrivateHexStatus(status)}`);
      expect(note).not.toMatch(/no tile may be laid/);
    });
  });
  it("the board mark and the rules reference name the same JK hexes", () => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const ref = fs.readFileSync(path.join(__dirname, "..", "components", "RulesReference.tsx"), "utf8");
    expect(ref).toContain('abbr: "JK", hex: "K-9/K-11"');
    expect(privateHexFor(CSL_PRIVATE_ID)).not.toBeNull();
  });
});

/* ================================================================== */
describe("S6-8 gray and red hexes -- Stage 9.2's immutable-hex rule, asked directly", () => {
  const find = (pick: (h: (typeof STATIC_BOARD_HEXES)[number]) => boolean) => withRules(LPF, () => STATIC_BOARD_HEXES.find(pick)!);
  it.each([
    ["gray", () => find((h) => h.printedColor === "Gray")],
    ["red / off-board", () => find((h) => h.type === "RedOffboard")],
  ])("a crafted lay on a %s hex is refused for every yellow tile and facing, on pinned and legacy boards", (_kind, at) => {
    const hex = at();
    for (const state of [board(), board({ pinned: false })]) {
      for (const tile of YELLOW) {
        for (let o = 0; o < 6; o += 1) {
          const result = atoms(state, lay(hex, tile, o));
          expectNothingMoved(state, result);
        }
      }
    }
  });
});

/* ================================================================== */
describe("S7-17 no authority decision is taken by object identity", () => {
  /* The audit's evidence, pinned: every production `before`/`after` equality comparison that remains is a VALUE
     comparison (phase tiers, strings) or the one cosmetic identity test (the discard flourish); refusal and
     acceptance are `actionOutcome`'s content comparison (#1685 / #1691). A new identity-based refusal check in an
     authority file breaks this. */
  const fs = require("fs") as typeof import("fs");
  const path = require("path") as typeof import("path");
  const strip = (raw: string) => raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const PATTERN = /\b(before|stateBefore|boardBefore|after|state|next)\s*[!=]==\s*(before|stateBefore|boardBefore|after)\b/g;
  const count = (file: string) => (strip(fs.readFileSync(path.join(__dirname, "..", file), "utf8")).match(PATTERN) ?? []).length;
  it("the authority modules compare no board by identity", () => {
    for (const file of [
      "gameEngine/layTileAuthority.ts",
      "gameEngine/turnAuthority.ts",
      "gameEngine/replayLog.ts",
      "gameEngine/actionOutcome.ts",
      "utils/roomSession.ts",
      "utils/refusedAction.ts",
    ]) {
      expect([file, count(file)]).toEqual([file, 0]);
    }
  });
  it("the remaining comparisons are the classified ones", () => {
    // Two phase-TIER comparisons (`derivePhase(...)?.tier`), not boards.
    expect(count("gameEngine/sandboxSession.ts")).toBe(2);
    // The discard flourish's `before !== after` -- cosmetic, not a refusal decision.
    expect(count("App.tsx")).toBe(1);
  });
});
