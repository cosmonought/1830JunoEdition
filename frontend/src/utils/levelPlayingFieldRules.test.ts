// Design notes #1323-#1326: the Level Playing Field's rules -- licences, the 20% certificate, C&O's two homes,
// and the 7-train shelf.
//
// EVERY CASE RUNS THROUGH THE REDUCER where the rule lives in an arm, and asks the same gate function the panel
// asks where the rule lives in a gate -- so what is asserted is the authority, not a copy of it.

import { STANDARD_BOARD, activateBoard } from "../components/hexBoardData";
import { STANDARD_TRAY, activateTray } from "../components/tileTray";
import { CO_COMPANY_ID, COAL_RIVER_LABEL, NW_COMPANY_ID } from "../components/hexBoardDataLpf";
import { homeHexesFor, homeReservationStands, stationHomeHexes } from "../components/hexContractTypes";
import type { MapGridResponse } from "../components/hexContractTypes";
import type { GameStateResponse } from "./gameState";
import { certificateCount } from "./gameState";
import { resolveVariants } from "./gameVariants";
import { withRules } from "./boardSelection";
import { applySandboxAction, pendingHomeTokens, placeHomeStationToken } from "./sandboxSession";
import { sandboxGameState } from "./sandboxState";
import { withLevelPlayingFieldEntities, ERIE_COMPANY_ID, JK_PRIVATE_ID } from "./levelPlayingField";
import {
  JK_TILE_ABILITY_KEY,
  KANAWHA_LICENSE_COST,
  KANAWHA_LICENSES_FOR_SALE,
  barredHexesFor,
  coalRiverAt,
  isCoalRiverNeighbour,
  jkHalfFee,
  jkTileRefusal,
  kanawhaLicenseRefusal,
  licensesHeldBy,
  licensesRemainingForSale,
  mayCrossCoalRiver,
} from "./kanawhaLicense";
import {
  certificateCardsHeld,
  certificateCardsInPool,
  doubleCertificateAt,
  doublePurchaseRefusal,
  doubleSaleEffect,
  ordinaryPurchaseRefusal,
} from "./doubleCertificate";
import { sharePurchaseBlock } from "./sharePurchase";
import { readStripped } from "./sourceScan";
import { shareSaleBlock } from "./shareSale";
import { evaluateStationPlacement } from "./stationTokens";
import {
  DEPOT_COST,
  LPF_DIESEL_COST,
  TIER_ORDER,
  LPF_TIER_ORDER,
  depotInventory,
  derivePhase,
  openDepotTiers,
  tierOrderFor,
  trainTier,
} from "./gamePhase";
import { dieselExchangeCostFor, dieselExchangeRefusal } from "./dieselExchange";
import { cityBlockerFor } from "./cityBlocking";

const LPF = resolveVariants({ levelPlayingField: true });
const BARE: MapGridResponse = { game_id: 1, tiles: [] };
const P1 = "juno1sandboxalice000000000000000000000000";
const P2 = "juno1sandboxbob00000000000000000000000000";
const PRR = 1;

afterEach(() => {
  activateBoard(STANDARD_BOARD);
  activateTray(STANDARD_TRAY);
});

/** A Level Playing Field game in an Operating Round, PRR operating at the Lay Track step, every corporation
 *  unstarted except PRR (floated, $1,000, home token on H12's herald). */
function lpfOperating(overrides: Partial<GameStateResponse> = {}): GameStateResponse {
  const base = withLevelPlayingFieldEntities({
    ...sandboxGameState("OperatingRound", 1),
    variants: LPF,
  });
  return {
    ...base,
    current_round_type: "OperatingRound",
    // Yellow, so the reducer's era settlement has nothing to change and a refusal returns the SAME object.
    current_global_era: "Yellow",
    active_operating_order: [PRR],
    active_corporation_index: 0,
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
      owned_trains: [],
      station_token_hexes: [],
      station_tokens: [],
      kanawha_licenses: undefined,
    })),
    private_companies: base.private_companies.map((entry) => ({
      ...entry,
      owner: null,
      owner_protocol_id: null,
      closed: false,
    })),
    kanawha_licenses_sold: undefined,
    jk_license_granted: undefined,
    used_private_abilities: [],
    terrain_fees_paid: [],
    ...overrides,
  };
}

const corp = (state: GameStateResponse, id: number) =>
  state.public_companies.find((entry) => entry.company_id === id)!;
const buyLicense = (state: GameStateResponse, id = PRR) =>
  applySandboxAction(state, { BuyKanawhaLicense: { protocol_id: id } } as never);

/* ------------------------------------------------------------------ */
/* 1. Kanawha licences                                                 */
/* ------------------------------------------------------------------ */

describe("Kanawha licences (design note #1323)", () => {
  it("exist only in the variant, and the gate says so", () => {
    const standard = { ...sandboxGameState("OperatingRound", 1), variants: resolveVariants({}) };
    expect(kanawhaLicenseRefusal(standard, PRR)).toContain("Level Playing Field");
    expect(mayCrossCoalRiver(standard, PRR)).toBe(true); // no rule, no bar
    expect(barredHexesFor(standard, PRR).size).toBe(0);
  });

  it("are bought at the Lay Track step for $120, once per corporation, four in all", () => {
    let state = lpfOperating();
    expect(kanawhaLicenseRefusal(state, PRR)).toBeNull();
    expect(licensesRemainingForSale(state)).toBe(KANAWHA_LICENSES_FOR_SALE);

    const bankBefore = Number(state.virtual_bank_vgp);
    state = buyLicense(state);
    expect(licensesHeldBy(corp(state, PRR))).toBe(1);
    expect(Number(corp(state, PRR).treasury)).toBe(1000 - KANAWHA_LICENSE_COST);
    expect(Number(state.virtual_bank_vgp)).toBe(bankBefore + KANAWHA_LICENSE_COST);
    expect(state.kanawha_licenses_sold).toBe(1);
    expect(licensesRemainingForSale(state)).toBe(3);
    // The lay is untouched -- the step is still Track and nothing was spent from the lay.
    expect(state.operating_sub_phase).toBe("Track");

    // A second for the same corporation is refused and changes nothing.
    expect(kanawhaLicenseRefusal(state, PRR)).toContain("already holds");
    expect(buyLicense(state)).toBe(state);

    // Wrong step, wrong corporation, and no money are all refused.
    expect(kanawhaLicenseRefusal({ ...lpfOperating(), operating_sub_phase: "Tokens" }, PRR)).toContain("Lay Track");
    expect(kanawhaLicenseRefusal(lpfOperating(), NW_COMPANY_ID)).toContain("own Operating Round turn");
    const broke = lpfOperating();
    broke.public_companies = broke.public_companies.map((c) => (c.company_id === PRR ? { ...c, treasury: "100" } : c));
    expect(kanawhaLicenseRefusal(broke, PRR)).toContain("$120");

    // The supply: four sold means the fifth corporation is refused.
    const soldOut = lpfOperating({ kanawha_licenses_sold: 4 });
    expect(kanawhaLicenseRefusal(soldOut, PRR)).toContain("all four");
    expect(buyLicense(soldOut)).toBe(soldOut);
  });

  it("is granted free, once, to the first corporation that buys the JK from a player", () => {
    const owned = lpfOperating({ operating_sub_phase: "BuyPrivate" });
    owned.private_companies = owned.private_companies.map((entry) =>
      entry.private_id === JK_PRIVATE_ID ? { ...entry, owner: P2 } : entry,
    );
    const bought = applySandboxAction(owned, {
      BuyPrivateCompany: { game_id: 1, protocol_id: PRR, private_id: JK_PRIVATE_ID, price: "120" },
    } as never);
    expect(bought.private_companies.find((e) => e.private_id === JK_PRIVATE_ID)?.owner_protocol_id).toBe(PRR);
    expect(licensesHeldBy(corp(bought, PRR))).toBe(1);
    expect(bought.jk_license_granted).toBe(true);
    // Outside the four the Bank sells.
    expect(bought.kanawha_licenses_sold ?? 0).toBe(0);
    expect(licensesRemainingForSale(bought)).toBe(4);
    // And the Bank still sells this corporation nothing more -- it already holds one.
    expect(kanawhaLicenseRefusal({ ...bought, operating_sub_phase: "Track" }, PRR)).toContain("already holds");

    // A second grant never happens: the flag stands even after the JK changes hands again.
    const again = applySandboxAction(
      { ...bought, private_companies: bought.private_companies.map((e) => (e.private_id === JK_PRIVATE_ID ? { ...e, owner: P2, owner_protocol_id: null } : e)) },
      { BuyPrivateCompany: { game_id: 1, protocol_id: NW_COMPANY_ID, private_id: JK_PRIVATE_ID, price: "120" } } as never,
    );
    expect(licensesHeldBy(corp(again, NW_COMPANY_ID))).toBe(0);
  });

  it("bar Coal River to an unlicensed corporation, in the walks and in the run", () => {
    const state = lpfOperating();
    withRules(LPF, () => {
      const at = coalRiverAt();
      expect(at).not.toBeNull();
      const barred = barredHexesFor(state, PRR);
      expect(barred.has(`${at!.q},${at!.r}`)).toBe(true);
      // The composed predicate shuts the hex for every city index, town included.
      const blocks = cityBlockerFor({
        actingCompanyId: PRR,
        companies: state.public_companies,
        slotsAt: () => 0,
        cityOf: () => undefined,
        barredHexes: barred,
      });
      expect(blocks(at!.q, at!.r, 0)).toBe(true);
      expect(blocks(at!.q + 1, at!.r, 0)).toBe(false);
      // Licensed: nothing barred.
      expect(barredHexesFor(buyLicense(state), PRR).size).toBe(0);
    });

    // The reducer refuses a run whose path names L8 for an unlicensed corporation, and accepts it licensed.
    const running = { ...state, operating_sub_phase: "Routes" as const };
    const route = {
      RunMultipleRoutes: {
        game_id: 1,
        protocol_id: PRR,
        routes: [[{ hex: "K7" }, { hex: COAL_RIVER_LABEL }, { hex: "K9" }]],
        trains: ["2"],
        revenue_turn: "t1",
      },
    } as never;
    expect(applySandboxAction(running, route)).toBe(running);
    const licensed = { ...buyLicense(state), operating_sub_phase: "Routes" as const };
    expect(applySandboxAction(licensed, route)).not.toBe(licensed);
    // A route that never touches L8 was never gated.
    const elsewhere = {
      RunMultipleRoutes: {
        ...(route as { RunMultipleRoutes: Record<string, unknown> }).RunMultipleRoutes,
        routes: [[{ hex: "K7" }, { hex: "K9" }]],
      },
    } as never;
    expect(applySandboxAction(running, elsewhere)).not.toBe(running);
  });

  it("the JK's power lays beside Coal River at half the fee and closes the JK", () => {
    withRules(LPF, () => {
      const at = coalRiverAt()!;
      // K9 is (-1, 10): Coal River's NE neighbour, a $120 mountain.
      expect(isCoalRiverNeighbour(-1, 10)).toBe(true);
      expect(isCoalRiverNeighbour(at.q, at.r)).toBe(false);
      expect(isCoalRiverNeighbour(0, 0)).toBe(false);
    });
    expect(jkHalfFee(120)).toBe(60);
    expect(jkHalfFee(80)).toBe(40);

    const state = lpfOperating();
    const owner = {
      ...state,
      private_companies: state.private_companies.map((e) =>
        e.private_id === JK_PRIVATE_ID ? { ...e, owner_protocol_id: PRR } : e,
      ),
    };
    // The refusal reads the board in effect, as the shell's does after `activateRules`.
    withRules(LPF, () => {
      // Without the JK the power is refused, and a keyed lay lays nothing.
      expect(jkTileRefusal(state, PRR, -1, 10)).toContain("owns the JK");
      expect(jkTileRefusal(owner, PRR, -1, 10)).toBeNull();
      expect(jkTileRefusal(owner, PRR, 0, 0)).toContain("beside Coal River");
    });

    const lay = (s: GameStateResponse, key?: string) =>
      applySandboxAction(s, {
        LayTile: { game_id: 1, protocol_id: PRR, q: -1, r: 10, tile_id: 8, orientation: 0, ...(key ? { ability_key: key } : {}) },
      } as never);
    // The keyed lay charges half and closes the JK; an ordinary lay on the same hex charges the full mountain.
    const powered = lay(owner, JK_TILE_ABILITY_KEY);
    expect(Number(corp(powered, PRR).treasury)).toBe(1000 - 60);
    expect(powered.private_companies.find((e) => e.private_id === JK_PRIVATE_ID)?.closed).toBe(true);
    expect(powered.used_private_abilities).toContain(JK_TILE_ABILITY_KEY);
    const plain = lay(owner);
    expect(Number(corp(plain, PRR).treasury)).toBe(1000 - 120);
    expect(plain.private_companies.find((e) => e.private_id === JK_PRIVATE_ID)?.closed).toBe(false);
    // A keyed lay the power does not cover is refused outright rather than laid at full price.
    expect(lay(state, JK_TILE_ABILITY_KEY)).toBe(state);
  });
});

/* ------------------------------------------------------------------ */
/* 2. The 20% standard certificate                                     */
/* ------------------------------------------------------------------ */

describe("the 20% standard certificate (design note #1324)", () => {
  const stock = (): GameStateResponse => ({
    ...lpfOperating(),
    current_round_type: "StockRound",
    active_player_index: 0,
    player_addresses: [P1, P2],
    player_cash: [
      { player: P1, cash_vgp: "2000" },
      { player: P2, cash_vgp: "2000" },
    ],
  });

  it("the ownership table counts eight pieces of card for a full N&W IPO, not nine (design note #1374)", () => {
    /* The rule counted the double once from #1324; the Stock Round panel's own `percentage / 10` did not,
       so a full IPO read "9 (100%)" and a double-holder "2 (20%)". The panel counts through these now. */
    const state = stock();
    const nw = corp(state, NW_COMPANY_ID);
    expect(nw.ipo_pool_percentage).toBe(100);
    expect(certificateCardsInPool(nw, "Ipo")).toBe(8); // president 20 + double 20 + six tens
    const fullPrr = { ...corp(state, PRR), ipo_pool_percentage: 100, president: null, player_holdings: [] };
    expect(certificateCardsInPool(fullPrr as never, "Ipo")).toBe(9); // the printed game's nine
    // The double in a player's hands is one card there and gone from the pool's count.
    const held = { ...nw, ipo_pool_percentage: 60, president: P1, player_holdings: [{ player: P1, percentage: 40 }], double_certificate: { at: P1 } };
    expect(certificateCardsHeld(held as never, P1)).toBe(2); // president + double
    expect(certificateCardsInPool(held as never, "Ipo")).toBe(6);
    // Sold into the Bank Pool as a block, it is one card there too.
    const pooled = { ...held, bank_pool_percentage: 20, player_holdings: [{ player: P1, percentage: 20 }], double_certificate: { at: "Bank" } };
    expect(certificateCardsInPool(pooled as never, "Bank")).toBe(1);
    const PANEL = readStripped("components/StockRoundPanel.tsx");
    expect(PANEL).toContain('{certificateCardsInPool(company, "Ipo")} ({company.ipo_pool_percentage}%)');
    expect(PANEL).toContain('{certificateCardsInPool(company, "Bank")} ({company.bank_pool_percentage}%)');
    expect(PANEL).toContain("{certificateCardsHeld(company, holding.address)} (");
  });

  it("is seeded in ERIE's and N&W's IPO and nowhere else", () => {
    const state = stock();
    expect(doubleCertificateAt(corp(state, ERIE_COMPANY_ID))).toBe("Ipo");
    expect(doubleCertificateAt(corp(state, NW_COMPANY_ID))).toBe("Ipo");
    expect(doubleCertificateAt(corp(state, PRR))).toBeNull();
    // The standard deal seeds none.
    expect(doubleCertificateAt(corp(sandboxGameState("StockRound", 1), ERIE_COMPANY_ID))).toBeNull();
  });

  it("is bought whole at twice the price and counts as one certificate", () => {
    let state = stock();
    // Par ERIE at $67 through the president's buy, then buy the double.
    state = applySandboxAction(
      state,
      { BuyStock: { game_id: 1, protocol_id: ERIE_COMPANY_ID, source: "Ipo", par_value: "67" } } as never,
      { actor: P1, sharePrice: 67 } as never,
    );
    const erie = corp(state, ERIE_COMPANY_ID);
    expect(erie.president).toBe(P1);
    expect(erie.ipo_pool_percentage).toBe(80);
    const cashAfterPresidency = Number(state.player_cash.find((row) => row.player === P1)?.cash_vgp);

    const bought = applySandboxAction(
      state,
      { BuyStock: { game_id: 1, protocol_id: ERIE_COMPANY_ID, source: "Ipo", par_value: null, certificate: "double" } } as never,
      { actor: P1, sharePrice: 67 } as never,
    );
    const after = corp(bought, ERIE_COMPANY_ID);
    expect(after.ipo_pool_percentage).toBe(60);
    expect(after.player_holdings.find((h) => h.player === P1)?.percentage).toBe(40);
    expect(doubleCertificateAt(after)).toBe(P1);
    expect(Number(bought.player_cash.find((row) => row.player === P1)?.cash_vgp)).toBe(cashAfterPresidency - 134);
    // 40% in two cards: the president's and the double -- so the double added ONE to the player's count.
    expect(certificateCardsHeld(after, P1)).toBe(2);
    expect(certificateCount(P1, bought) - certificateCount(P1, state)).toBe(1);

    // Asked from the wrong pool, the double is refused, and a bare harness still refuses it in the arm.
    expect(doublePurchaseRefusal(after, "Bank")).toContain("not in the Bank Pool");
    const again = applySandboxAction(
      bought,
      { BuyStock: { game_id: 1, protocol_id: ERIE_COMPANY_ID, source: "Bank", par_value: null, certificate: "double" } } as never,
      { actor: P2, sharePrice: 67 } as never,
    );
    expect(again).toBe(bought);
  });

  it("leaves a pool holding only the double with nothing ordinary to sell", () => {
    const state = stock();
    const erie = { ...corp(state, ERIE_COMPANY_ID), ipo_pool_percentage: 20 };
    expect(ordinaryPurchaseRefusal(erie, "Ipo", 1)).toContain("only the 20% certificate");
    expect(ordinaryPurchaseRefusal({ ...erie, ipo_pool_percentage: 30 }, "Ipo", 1)).toBeNull();
    expect(ordinaryPurchaseRefusal({ ...erie, ipo_pool_percentage: 30 }, "Ipo", 2)).toContain("only the 20% certificate");
    // Through the gate the panel and the arm both ask.
    const gated = {
      ...state,
      public_companies: state.public_companies.map((c) =>
        c.company_id === ERIE_COMPANY_ID ? { ...c, ipo_pool_percentage: 20, president: P2, par_value: "67", player_holdings: [{ player: P2, percentage: 80 }] } : c,
      ),
    };
    expect(sharePurchaseBlock({ state: gated, buyer: P1, companyId: ERIE_COMPANY_ID, source: "Ipo", quantity: 1, zone: "White" as never })).toContain("only the 20% certificate");
    expect(sharePurchaseBlock({ state: gated, buyer: P1, companyId: ERIE_COMPANY_ID, source: "Ipo", quantity: 1, zone: "White" as never, certificate: "double" })).toBeNull();
  });

  it("sells as a block, or by the half-sale only when the pool can hand a 10% card back", () => {
    const holder = {
      ...corp(stock(), ERIE_COMPANY_ID),
      president: P2,
      par_value: "67",
      // P1 holds the double and one ordinary card; the pool is empty.
      player_holdings: [
        { player: P2, percentage: 20 },
        { player: P1, percentage: 30 },
      ],
      ipo_pool_percentage: 50,
      bank_pool_percentage: 0,
      double_certificate: { at: P1 },
    };
    // The ordinary card goes first.
    expect(doubleSaleEffect(holder, P1, 10)).toEqual({ kind: "none" });
    // Thirty percent is the ordinary card and the whole double.
    expect(doubleSaleEffect(holder, P1, 30)).toEqual({ kind: "block" });
    // Twenty is the ordinary card plus half the double -- with an empty pool, refused.
    expect(doubleSaleEffect(holder, P1, 20).kind).toBe("refused");
    expect(shareSaleBlock({ state: { ...stock(), public_companies: [holder] }, seller: P1, companyId: ERIE_COMPANY_ID, percentage: 20 })).toContain("sold as a whole");
    // With a 10% card in the pool the half-sale goes through.
    const poolHasOne = { ...holder, ipo_pool_percentage: 40, bank_pool_percentage: 10 };
    expect(doubleSaleEffect(poolHasOne, P1, 20)).toEqual({ kind: "half" });

    // Through the arm: the block sale moves the card to the Bank Pool.
    const base = { ...stock(), macro_round_number: 2, public_companies: [holder] };
    const sold = applySandboxAction(
      base,
      { SellStock: { game_id: 1, protocol_id: ERIE_COMPANY_ID, percentage: 30 } } as never,
      { actor: P1, sharePrice: 67 } as never,
    );
    const afterBlock = corp(sold, ERIE_COMPANY_ID);
    expect(afterBlock.bank_pool_percentage).toBe(30);
    expect(doubleCertificateAt(afterBlock)).toBe("Bank");
    // And the half-sale nets the pool ten while the card still changes hands.
    const half = applySandboxAction(
      { ...base, public_companies: [poolHasOne] },
      { SellStock: { game_id: 1, protocol_id: ERIE_COMPANY_ID, percentage: 20 } } as never,
      { actor: P1, sharePrice: 67 } as never,
    );
    const afterHalf = corp(half, ERIE_COMPANY_ID);
    expect(afterHalf.bank_pool_percentage).toBe(30);
    expect(afterHalf.player_holdings.find((h) => h.player === P1)?.percentage).toBe(10);
    expect(doubleCertificateAt(afterHalf)).toBe("Bank");
    // The refused half-sale changes nothing.
    expect(applySandboxAction(base, { SellStock: { game_id: 1, protocol_id: ERIE_COMPANY_ID, percentage: 20 } } as never, { actor: P1, sharePrice: 67 } as never)).toBe(base);
  });
});

/* ------------------------------------------------------------------ */
/* 3. C&O's two homes                                                  */
/* ------------------------------------------------------------------ */

describe("C&O's two homes (design note #1325)", () => {
  it("reserves Cleveland and Richmond on this board, Cleveland alone elsewhere", () => {
    withRules(LPF, () => {
      const homes = homeHexesFor(CO_COMPANY_ID);
      expect(homes.map((h) => h.label).sort()).toEqual(["F6", "K13"]);
      expect(homes.find((h) => h.label === "F6")?.enforced).toBe(false);
      expect(homes.find((h) => h.label === "K13")?.enforced).toBeUndefined();
      expect(stationHomeHexes().filter((h) => h.companyId === CO_COMPANY_ID)).toHaveLength(2);
    });
    expect(homeHexesFor(CO_COMPANY_ID).map((h) => h.label)).toEqual(["F6"]);
  });

  it("prompts for either, accepts either, and forfeits the other once one is taken", () => {
    const state = lpfOperating();
    const floatedCo = {
      ...state,
      public_companies: state.public_companies.map((c) =>
        c.company_id === CO_COMPANY_ID ? { ...c, is_floated: true, president: P2 } : c,
      ),
    };
    const toAxial = (label: string): readonly [number, number] | null => {
      const home = homeHexesFor(CO_COMPANY_ID).find((h) => h.label === label);
      return home ? [home.q, home.r] : null;
    };
    withRules(LPF, () => {
      const pending = pendingHomeTokens(floatedCo, toAxial).find((p) => p.companyId === CO_COMPANY_ID);
      expect(pending?.options.map((o) => o.hexLabel)).toEqual(["F6", "K13"]);

      const k13 = homeHexesFor(CO_COMPANY_ID).find((h) => h.label === "K13")!;
      const f6 = homeHexesFor(CO_COMPANY_ID).find((h) => h.label === "F6")!;
      const placed = placeHomeStationToken(floatedCo, CO_COMPANY_ID, k13.q, k13.r, null, toAxial);
      const co = corp(placed, CO_COMPANY_ID);
      expect(co.station_token_hexes).toEqual([[k13.q, k13.r]]);
      // The home is no longer owed, and Cleveland's marker is forfeited.
      expect(pendingHomeTokens(placed, toAxial).some((p) => p.companyId === CO_COMPANY_ID)).toBe(false);
      expect(homeReservationStands(co, f6)).toBe(false);
      expect(homeReservationStands(co, k13)).toBe(false);
      // Before placing, both stand.
      expect(homeReservationStands(corp(floatedCo, CO_COMPANY_ID), f6)).toBe(true);
      expect(homeReservationStands(corp(floatedCo, CO_COMPANY_ID), k13)).toBe(true);
      // A token on a hex that is neither home is refused for a two-home corporation.
      expect(placeHomeStationToken(floatedCo, CO_COMPANY_ID, 0, 0, null, toAxial)).toBe(floatedCo);
    });
  });

  it("holds Richmond against others and lets Cleveland be taken", () => {
    const state = lpfOperating();
    withRules(LPF, () => {
      const k13 = homeHexesFor(CO_COMPANY_ID).find((h) => h.label === "K13")!;
      const f6 = homeHexesFor(CO_COMPANY_ID).find((h) => h.label === "F6")!;
      const prr = { ...corp(state, PRR), station_token_hexes: [] as Array<[number, number]> };
      // Richmond is a blank city: give it a yellow city tile so it has a slot at all.
      const grid: MapGridResponse = { game_id: 1, tiles: [{ q: k13.q, r: k13.r, tile_id: 57, orientation: 0, landmark: null }] };
      const richmond = evaluateStationPlacement({ mapGrid: grid, q: k13.q, r: k13.r, company: prr, allCompanies: state.public_companies });
      expect(richmond.allowed).toBe(false);
      expect(richmond.reason).toContain("reserved as a home station");
      const cleveland = evaluateStationPlacement({ mapGrid: BARE, q: f6.q, r: f6.r, company: prr, allCompanies: state.public_companies });
      // Not the reservation -- whatever else refuses it (PRR's network does not reach F6), it is not C&O's marker.
      expect(cleveland.reason ?? "").not.toContain("reserved as a home station");
    });
  });
});

/* ------------------------------------------------------------------ */
/* 4. The 7-train and the open shelf                                   */
/* ------------------------------------------------------------------ */

describe("the 7-train and the open shelf (design note #1326)", () => {
  const withTrains = (state: GameStateResponse, trains: string[]): GameStateResponse => ({
    ...state,
    public_companies: state.public_companies.map((c) => (c.company_id === PRR ? { ...c, owned_trains: trains } : c)),
  });

  it("is in the variant's roster only, at $710 with two in the depot", () => {
    expect(TIER_ORDER).toEqual(["2", "3", "4", "5", "6", "D"]);
    expect(LPF_TIER_ORDER).toEqual(["2", "3", "4", "5", "6", "7", "D"]);
    expect(trainTier("7")).toBe("7");
    expect(DEPOT_COST["7"]).toBe(710);
    expect(LPF_DIESEL_COST).toBe(900);
    const standard = { ...sandboxGameState("OperatingRound", 1), variants: resolveVariants({}) };
    expect(tierOrderFor(standard)).toBe(TIER_ORDER);
    expect(depotInventory(standard).some((row) => row.tier === "7")).toBe(false);
    expect(depotInventory(standard).find((row) => row.tier === "D")?.cost).toBe(1100);
    const lpf = lpfOperating();
    expect(tierOrderFor(lpf)).toBe(LPF_TIER_ORDER);
    const seven = depotInventory(lpf).find((row) => row.tier === "7");
    expect(seven).toMatchObject({ cost: 710, total: 2 });
    expect(depotInventory(lpf).find((row) => row.tier === "D")?.cost).toBe(900);
  });

  it("opens 6s, 7s and Diesels together the moment the first 6 is owned", () => {
    // Before any 6 is owned the depot is the printed queue: its head (here the 5s, two of which remain).
    const beforeSix = withTrains(lpfOperating(), ["5"]);
    expect(openDepotTiers(beforeSix).map((row) => row.tier)).toEqual(["5"]);
    expect(dieselExchangeRefusal(beforeSix, PRR)).toContain("not for sale yet");
    const fivesGone = withTrains(lpfOperating(), ["5", "5", "5"]);
    expect(openDepotTiers(fivesGone).map((row) => row.tier)).toEqual(["6"]);

    const afterSix = withTrains(lpfOperating(), ["6"]);
    expect(openDepotTiers(afterSix).map((row) => row.tier)).toEqual(["6", "7", "D"]);
    expect(depotInventory(afterSix).find((row) => row.tier === "6")?.remaining).toBe(1);
    expect(depotInventory(afterSix).find((row) => row.tier === "7")?.remaining).toBe(2);
    expect(derivePhase(afterSix)?.purchasesUntilPhaseChange).toBeNull();

    // A Diesel bought off the shelf leaves the 6 and the 7 for sale, and keeps rusting the 4s -- here N&W's.
    const shelfOpen = withTrains(lpfOperating(), ["6"]);
    const hardware: GameStateResponse = {
      ...shelfOpen,
      operating_sub_phase: "Hardware",
      public_companies: shelfOpen.public_companies.map((c) => (c.company_id === NW_COMPANY_ID ? { ...c, owned_trains: ["4"] } : c)),
    };
    const boughtD = applySandboxAction(hardware, { BuyHardwareFromPool: { game_id: 1, protocol_id: PRR, model_type: "D" } } as never);
    expect(corp(boughtD, PRR).owned_trains).toEqual(["6", "D"]);
    expect(corp(boughtD, NW_COMPANY_ID).owned_trains).toEqual([]);
    expect(Number(corp(boughtD, PRR).treasury)).toBe(1000 - 900);
    expect(openDepotTiers(boughtD).map((row) => row.tier)).toEqual(["6", "7", "D"]);
    // The 7 has no phase of its own: the badge still says 6, and N&W's 4 survives.
    const boughtSeven = applySandboxAction(hardware, { BuyHardwareFromPool: { game_id: 1, protocol_id: PRR, model_type: "7" } } as never);
    expect(corp(boughtSeven, PRR).owned_trains).toEqual(["6", "7"]);
    expect(corp(boughtSeven, NW_COMPANY_ID).owned_trains).toEqual(["4"]);
    expect(Number(corp(boughtSeven, PRR).treasury)).toBe(1000 - 710);
    expect(derivePhase(boughtSeven)?.label).toBe("Phase: 6 (Brown)");
    expect(derivePhase(boughtSeven)?.trainLimit).toBe(2);
    // An unnamed purchase still takes the cheapest, as every old log expects.
    const unnamed = applySandboxAction(hardware, { BuyHardwareFromPool: { game_id: 1, protocol_id: PRR } } as never);
    expect(corp(unnamed, PRR).owned_trains).toEqual(["6", "6"]);
    // A tier that is not on the shelf buys nothing.
    const early = { ...withTrains(lpfOperating(), ["5"]), operating_sub_phase: "Hardware" as const };
    expect(applySandboxAction(early, { BuyHardwareFromPool: { game_id: 1, protocol_id: PRR, model_type: "D" } } as never)).toBe(early);
  });

  it("trades a 4-, 5- or 6-train in for a Diesel at $750", () => {
    expect(dieselExchangeCostFor(lpfOperating())).toBe(750);
    expect(dieselExchangeCostFor({ variants: resolveVariants({ expandedMap: true }) })).toBe(800);
    const state = { ...withTrains(lpfOperating(), ["6", "4"]), operating_sub_phase: "Hardware" as const };
    expect(dieselExchangeRefusal(state, PRR, "4")).toBeNull();
    const traded = applySandboxAction(state, { ExchangeTrainForDiesel: { game_id: 1, protocol_id: PRR, model_type: "4" } } as never);
    expect(corp(traded, PRR).owned_trains).toEqual(["6", "D"]);
    expect(Number(corp(traded, PRR).treasury)).toBe(1000 - 750);
  });
});

describe("the chart draws the two added corporations (design note #1381)", () => {
  it("emits a position for every id that holds a mark, not only the printed eight", () => {
    const { sandboxMarketPositions } = require("./sandboxState") as typeof import("./sandboxState");
    const { NW_COMPANY_ID: NW, PMQ_COMPANY_ID: PMQ } = require("../components/hexBoardDataLpf") as typeof import("../components/hexBoardDataLpf");
    const marks = {
      1: { price: 100, x: 3, y: 2, enteredAt: 1 },
      [PMQ]: { price: 90, x: 2, y: 3, enteredAt: 2 },
      [NW]: { price: 100, x: 3, y: 2, enteredAt: 3 },
    };
    const positions = sandboxMarketPositions(marks as never);
    expect(positions.map((entry) => [entry.company_id, entry.ticker])).toEqual([
      [1, "PRR"],
      [PMQ, "PMQ"],
      [NW, "N&W"],
    ]);
    expect(positions.find((entry) => entry.company_id === NW)?.enteredAt).toBe(3);
  });
});
