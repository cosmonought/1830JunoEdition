/** @jest-environment jsdom */
//
// ==================================================================
//  PHASE 3 WAVE-1 INTEGRATION: THE CROSS-LANE LOOSE ENDS
// ==================================================================
//
// 1. Activity Log: the proposer's `RescindPrivatePurchase` / `RescindTrainPurchase` (W1-D) narrate a sentence of their
//    own instead of falling through to the drain's fallback label ("Sandbox room").
// 2. Tile refusal copy: the ring's authority refusal (W1-E) names the previewed tile canonically (`#626` -> `#8861`);
//    the verdict and the rest of the sentence stay the authority's.
// 3. Game-over strip: tie-aware like W1-N's GameOverModal -- every rank-1 player, never `sorted[0]` alone. Ranking
//    is unchanged.
// (4. the Rules Reference zoom hunk is pinned and rendered in `hostGameW1O.test.tsx`; 5. the M&H modal's presentation
//  in `phase3W1CMhModalPresentation.test.tsx`.)

import { describeGameplayAction, type ActionLogContext } from "../utils/actionLog";
import { ringLayPreviewRefusal, withCanonicalTileName, type RingLayPreview } from "../utils/tileRingView";
import { gameOverStripResult } from "../utils/gameOverStripView";
import { rankPlayers, type PlayerStanding } from "../gameEngine/endgame";
import { tileEraFor } from "../gameEngine/gameConstants";
import type { GameStateResponse } from "../gameEngine/gameState";
import type { MapGridResponse } from "./hexContractTypes";
import { canonicalTileName } from "./hexTileCatalog";
import { readShell, sliceBetween } from "../utils/sourceScan";
import * as F from "../utils/offerFixtures74";
import * as S from "../utils/offerMatrix74Support";

const { P1, P2, PRR, NYC, CA } = F;
const LABELS: Record<string, string> = { [P1]: "Alice", [P2]: "Bob", [F.P3]: "Carol" };

const context = (before: GameStateResponse, after: GameStateResponse | null = null): ActionLogContext => ({
  gameState: before,
  afterState: after,
  mapGrid: S.GRID,
  era: tileEraFor(before),
  labelForAddress: (address) => LABELS[address] ?? address,
});

/* ================================================================== */
/* 1. The rescinds narrate                                              */
/* ================================================================== */

describe("1. the proposer's withdrawals have Activity Log sentences of their own", () => {
  it("RescindPrivatePurchase: the buying corporation withdrew its offer, named from the board that held it", () => {
    const t = S.roomFor(F.operatingBoard());
    expect(t.submit(P1, S.M.proposePrivate(CA, PRR, 160)).kind).toBe("applied");
    const before = t.room.state;
    const offer = before.private_purchase_offer!;
    expect(t.submit(P1, S.M.rescindPrivate(CA)).kind).toBe("applied");
    const line = describeGameplayAction(S.M.rescindPrivate(CA) as never, context(before, t.room.state));
    expect(line).toBe(`PRR withdrew its offer of $${offer.price} for ${offer.private_name}.`);
  });

  it("RescindTrainPurchase: the buying corporation withdrew its offer for the seller's train", () => {
    const t = S.roomFor(S.withCorp(F.operatingBoard(), NYC, { owned_trains: ["3", "3", "2"] }));
    expect(t.submit(P1, S.M.proposeTrain(NYC, PRR, "3", "150")).kind).toBe("applied");
    const before = t.room.state;
    expect(t.submit(P1, S.M.rescindTrain(NYC)).kind).toBe("applied");
    const line = describeGameplayAction(S.M.rescindTrain(NYC) as never, context(before, t.room.state));
    expect(line).toBe("PRR withdrew its offer of $150 for NYC's 3-train.");
  });

  it("never null -- so never the drain's fallback -- even on a board that no longer holds the offer", () => {
    const board = F.operatingBoard();
    const privateLine = describeGameplayAction(S.M.rescindPrivate(CA) as never, context(board));
    const trainLine = describeGameplayAction(S.M.rescindTrain(NYC) as never, context(board));
    expect(privateLine).not.toBeNull();
    expect(trainLine).not.toBeNull();
    expect(privateLine).toMatch(/withdrew its offer for /);
    expect(trainLine).toBe("PRR withdrew its offer for a train from NYC.");
    for (const line of [privateLine, trainLine]) expect(line).not.toContain("Sandbox room");
  });

  it("the drain's fallback is still only a fallback: the describer is asked first", () => {
    // The general path labels an entry `describeGameplayAction(...) ?? fallbackLabel`; a sentence wins.
    expect(readShell()).toContain("describeGameplayAction(chainMsg, describeContext) : null) ?? fallbackLabel");
  });
});

/* ================================================================== */
/* 2. The ring's refusal names the tile canonically                     */
/* ================================================================== */

describe("2. the tile ring's authority refusal uses the canonical tile name", () => {
  it("renames only the previewed tile's own id token", () => {
    expect(canonicalTileName(626)).toBe("#8861");
    expect(withCanonicalTileName("Tile #626 cannot be laid at E11 at that rotation.", 626)).toBe(
      "Tile #8861 cannot be laid at E11 at that rotation.",
    );
    expect(withCanonicalTileName("City 1 of tile #626 has 1 station slot and this lay would seat 2.", 626)).toBe(
      "City 1 of tile #8861 has 1 station slot and this lay would seat 2.",
    );
    // A longer id that merely starts with the digits is not this tile; an ordinary tile is untouched.
    expect(withCanonicalTileName("Tile #6260 is not this one.", 626)).toBe("Tile #6260 is not this one.");
    expect(withCanonicalTileName("Tile #57 cannot be laid at E11 at that rotation.", 57)).toBe(
      "Tile #57 cannot be laid at E11 at that rotation.",
    );
    expect(withCanonicalTileName("Tile #36 cannot be laid here.", 36)).toBe("Tile oo13 cannot be laid here.");
  });

  it("the ring's preview refusal on a real board: the authority's sentence, with #8861 instead of #626", () => {
    const state = {
      player_addresses: ["p1"],
      player_cash: [{ player: "p1", cash_vgp: "500" }],
      virtual_bank_vgp: "10000",
      private_companies: [],
      current_round_type: "OperatingRound",
      macro_round_number: 3,
      active_player_index: 0,
      active_operating_order: [2],
      active_corporation_index: 0,
      sub_round_index: 1,
      operating_round_sequence_length: 2,
      consecutive_passes: 0,
      operating_sub_phase: "Track",
      terrain_fees_paid: [],
      variants: { expandedMap: true, plusTiles: true },
      public_companies: [
        {
          company_id: 2,
          ticker: "NYC",
          is_floated: true,
          station_token_hexes: [],
          station_tokens: [],
          president: "p1",
          par_value: "100",
          ipo_pool_percentage: 0,
          bank_pool_percentage: 0,
          treasury: "1000",
          owned_trains: ["4"],
          player_holdings: [{ player: "p1", percentage: 100 }],
        },
      ],
    } as unknown as GameStateResponse;
    const grid = { game_id: 1, tiles: [] } as unknown as MapGridResponse;
    const lay: RingLayPreview = {
      gameId: 1,
      protocolId: 2,
      q: 6,
      r: 6,
      tileId: 626,
      orientation: 0,
      bonusLay: false,
      abilityKey: undefined,
      tokenCity: undefined,
      tokenCities: [],
    };
    // The geometry refuses this lay, so the lay authority answers with its tile sentence.
    const refusal = ringLayPreviewRefusal({ layRefused: () => true, chartInjections: () => ({}) }, state, grid, lay);
    expect(refusal).toMatch(/^Tile #8861 cannot be laid at .+ at that rotation\.$/);
    expect(refusal).not.toContain("#626");
    // And a lay the authority accepts is still `null` -- legality is untouched.
    expect(ringLayPreviewRefusal({ layRefused: () => false, chartInjections: () => ({}) }, state, grid, lay)).toBeNull();
  });
});

/* ================================================================== */
/* 3. The game-over strip is tie-aware                                  */
/* ================================================================== */

const row = (over: Partial<PlayerStanding>): PlayerStanding => ({
  address: "0xa",
  label: "Ann",
  cash: 100,
  stockValue: 400,
  privateValue: 0,
  netWorth: 500,
  rank: 1,
  isWinner: false,
  isBankrupt: false,
  ...over,
});

describe("3. the game-over strip names every player ranked first, like the Game Over modal", () => {
  it("a sole winner reads as before", () => {
    expect(gameOverStripResult([row({ isWinner: true }), row({ address: "0xb", label: "Bo", rank: 2, netWorth: 300 })])).toBe(
      " — Ann wins with $500.",
    );
  });

  it("a shared first place never names one winner", () => {
    const tied = [
      row({ address: "0xa", label: "Ann", isWinner: true }),
      row({ address: "0xb", label: "Bo", isWinner: false }),
      row({ address: "0xc", label: "Cy", rank: 3, netWorth: 200 }),
    ];
    const text = gameOverStripResult(tied);
    expect(text).toBe(" — Ann and Bo tie for first with $500 each.");
    expect(text).not.toContain("wins");
    expect(gameOverStripResult([...tied.slice(0, 2), row({ address: "0xd", label: "Di" })])).toBe(
      " — Ann, Bo and Di tie for first with $500 each.",
    );
  });

  it("reads rankPlayers' ranks unchanged: a real tie on a real board", () => {
    const board = F.operatingBoard({ privates: [] });
    const standings = rankPlayers({
      state: board,
      priceForCompany: () => null,
      labelForAddress: (address) => LABELS[address] ?? address,
    });
    // The fixture's three players hold $300 each, no private and nothing priced: a three-way tie, one champion.
    expect(standings.filter((entry) => entry.rank === 1).length).toBeGreaterThan(1);
    expect(standings.filter((entry) => entry.isWinner)).toHaveLength(1);
    expect(gameOverStripResult(standings)).toContain("tie for first");
  });

  it("no standings: just the full stop", () => {
    expect(gameOverStripResult([])).toBe(".");
  });

  it("the strip in the shell reads the helper, and no longer the single champion", () => {
    const strip = sliceBetween(readShell(), 'data-testid="game-over-strip"', "</span>");
    expect(strip).toContain("{gameOverStripResult(finalStandings)}");
    expect(strip).not.toContain("isWinner");
  });
});
