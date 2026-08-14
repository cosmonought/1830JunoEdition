// frontend/src/utils/sandboxState.ts
//
// Mock game state for the Offline Sandbox (App.tsx design note #24), so the
// Auction and Stock Round UIs can be inspected and polished without a chain,
// a wallet, or a populated Firestore.
//
// ===================================================================
//  DESIGN NOTE 0: WHY THIS EXISTS, AND WHAT IT IS NOT
// ===================================================================
//
// The sandbox deliberately passes `queryClient: undefined`, which makes
// every poll on the dashboard report "no chain" and return `null`. That is
// correct for the rail map -- `HexGridRenderer` has its own local tile
// catalog to fall back on -- but it left the phase-scoped panels with
// literally nothing to render. `WaterfallAuctionDashboard` and
// `StockRoundPanel` are both fully built and prop-driven, and both were
// simply unreachable: the auction only mounts when
// `current_round_type === "WaterfallAuction"`, and with `gameState === null`
// that comparison is never true. There was no way to look at either screen.
//
// So this module fabricates exactly the shapes those panels consume.
//
// THIS IS NOT A SIMULATION. Nothing here advances, validates, or reacts.
// Buying a private does not remove it; the president never changes; passing
// does nothing. It is a set of frozen, hand-authored snapshots chosen to
// exercise the interesting rendering branches -- a president who is not the
// viewer, a company that has floated and one that has not, a private with
// competing bids, a mini-auction in progress. Treating any of it as game
// logic would be a category error, which is why every value is a literal
// and there is not a single reducer in this file.
//
// ===================================================================
//  DESIGN NOTE 1: THE ROSTERS ARE MIRRORED, NOT INVENTED
// ===================================================================
//
// The six privates and eight corporations below are taken from the
// contract's own canonical tables -- `auction.rs::CORE_PRIVATE_COMPANIES`
// and `public_company.rs::CORE_PUBLIC_COMPANIES` -- including their ids,
// names, face values and revenues. Inventing a plausible-looking roster
// would have been quicker and would have made the sandbox actively
// misleading: the whole point of looking at these screens is to judge how
// REAL data lays out, and a mock with the wrong ticker set or the wrong
// number of privates answers a question nobody asked.
//
// Two naming notes, both cases where the contract differs from the way the
// pieces are usually written, and where the contract wins because it is
// what the UI will actually receive:
//
//   - The New York, New Haven & Hartford is `NNH` on chain, not `NYNH`.
//   - Mohawk & Hudson's reserved hex is F16, which this frontend has
//     labelled "Scranton" since an earlier pass.
//
// The privates are listed in ascending face value -- 20, 40, 70, 110, 160,
// 220 -- which is both the physical game's order and the strict waterfall
// order the auction requires. `WaterfallStateResponse.privates` is
// documented as already arriving sorted that way, so the auction dashboard
// renders them in order without sorting; this mock preserves that
// guarantee rather than relying on it accidentally.

import { STATIC_BOARD_HEXES } from "../components/hexBoardData";
import type {
  GameStateResponse,
  PublicCompanyState,
  PrivateCompanyState,
  RoundType,
  WaterfallStateResponse,
} from "./gameState";

/** The sandbox's four seats. Deliberately readable names rather than
 *  `juno1...` addresses: these appear in every roster, holdings table and
 *  seating rail on screen, and a column of truncated bech32 tells you
 *  nothing about whether the layout works. They are still shaped as
 *  addresses so nothing downstream has to special-case them. */
export const SANDBOX_PLAYERS = [
  "juno1sandboxalice000000000000000000000000",
  "juno1sandboxbob00000000000000000000000000",
  "juno1sandboxcarol000000000000000000000000",
  "juno1sandboxdave00000000000000000000000000",
] as const;

/** Short label for a sandbox address, so the mock reads as "Alice" rather
 *  than "juno1san...0000" everywhere it appears. Returns `null` for any
 *  address that is not one of the four, so real addresses fall through to
 *  the normal truncation path untouched. */
export function sandboxPlayerLabel(address: string): string | null {
  const index = SANDBOX_PLAYERS.indexOf(address as (typeof SANDBOX_PLAYERS)[number]);
  return index === -1 ? null : ["Alice", "Bob", "Carol", "Dave"][index];
}

/* ------------------------------------------------------------------ */
/* Private companies -- auction.rs::CORE_PRIVATE_COMPANIES             */
/* ------------------------------------------------------------------ */

/** `(private_id, name, face value, revenue per OR)`, ascending by face
 *  value = waterfall order. Mirrors the contract table exactly. */
const SANDBOX_PRIVATES: ReadonlyArray<{
  id: number;
  name: string;
  cost: number;
  revenue: number;
}> = [
  { id: 1, name: "Schuylkill Valley", cost: 20, revenue: 5 },
  { id: 2, name: "Champlain & St. Lawrence", cost: 40, revenue: 10 },
  { id: 3, name: "Delaware & Hudson", cost: 70, revenue: 15 },
  { id: 4, name: "Mohawk & Hudson", cost: 110, revenue: 20 },
  { id: 5, name: "Camden & Amboy", cost: 160, revenue: 25 },
  { id: 6, name: "Baltimore & Ohio", cost: 220, revenue: 30 },
];

/* ------------------------------------------------------------------ */
/* Public companies -- public_company.rs::CORE_PUBLIC_COMPANIES        */
/* ------------------------------------------------------------------ */

/** Hand-authored holdings per corporation, chosen to put every rendering
 *  branch on screen at once rather than to depict a plausible mid-game
 *  position:
 *
 *    PRR   floated, Alice president on 60% -- a clear controlling stake
 *    NYC   floated, Bob president on 40% with Alice close behind on 30%
 *    CPR   floated the ORDINARY way, at exactly the 60% threshold
 *    B&O   PARRED, PRESIDENT SET, NOT FLOATED. Dave won the B&O private,
 *          which grants him the 20% President's Certificate and prompts him
 *          to set the par price -- it does NOT float the corporation. B&O
 *          floats like everyone else, at 60% sold. See design note #8
 *    C&O   PARRED BUT UNFLOATED -- no president yet. Two branches at once:
 *          an empty-ish roster, and the case the Par/IPO track exists for
 *          (par is set at presidency purchase, not at float)
 *    ERIE  floated on an OO dual-city home -- see design note #4
 *    NNH   floated, president tie broken by first-to-30% (Alice). Home G19
 *          (New York) -- see design note #6
 *    B&M   floated, four-way split with a bare-majority president. Home
 *          E23 (Boston) -- see design note #6
 *
 * DESIGN NOTE #6: HOME HEXES ARE THE REAL ONES.
 * B&M was mocked onto G19 and NNH given no home at all. G19 is New York,
 * which is NYNH's home and reserved for it -- so the mock had one company
 * squatting another's reserved hex while the rightful owner had nowhere to
 * put a token. Corrected to NNH=G19 (New York) and B&M=E23 (Boston), the
 * real 1830 assignments. Both labels are verified present in
 * `STATIC_BOARD_HEXES`; `axialForLabel` would return `null` and silently
 * drop the token otherwise, which is how the original error stayed
 * invisible.
 */
const SANDBOX_CORPORATIONS: ReadonlyArray<{
  id: number;
  ticker: string;
  floated: boolean;
  par: number | null;
  /** Current stock-market price. `null` before a company floats -- an
   *  unfloated corporation has no market position, and showing "0" would
   *  read as a crashed share price rather than an absent one. */
  market: number | null;
  president: number | null;
  holdings: ReadonlyArray<{ player: number; percentage: number }>;
  /** Design note #5: EXPLICIT, not derived. These used to be computed as
   *  `ipo = 100 - sold - (floated ? 10 : 0)` with `bank = floated ? 10 : 0`,
   *  which invented a 10% Bank Pool for every floated company whether or
   *  not anyone had ever sold into it -- and produced B&O's nonsensical
   *  "IPO 70 / player 20 / bank 10" when the B&O auto-float rule says the
   *  unsold 80% goes to the IPO pool and the bank starts empty.
   *
   *  A formula that fabricates plausible-looking numbers is worse than
   *  hand-authored ones here: it looks systematic, so nobody checks it. */
  ipo: number;
  bank: number;
  treasury: number;
  homeHex: string | null;
  /** Design note #5: mock `owned_trains`, so the derived phase badge and the
   *  Operating Round train chips have something real to read in the sandbox.
   *
   *  The set below puts the room in PHASE 3 WITH ONE 3-TRAIN LEFT IN THE
   *  DEPOT, chosen specifically because that is the state in which every
   *  branch of the UI is visible at once:
   *
   *    - highest tier owned is a 3        -> "Phase: Green (3-Train)"
   *    - four of the printed five 3-trains are held -> depot 1, so the
   *      "Phase Shift Imminent" tag renders with its Phase 4 tooltip
   *    - Phase 4's arrival rusts 2-TRAINS, and several are still owned ->
   *      those chips render amber with the "rust after 2 more purchases"
   *      tooltip
   *    - PRR holds four trains against a Phase 3 limit of four -> its
   *      capacity pill shows the MAX state
   *
   *  It was briefly Phase 4. That looked reasonable and silently hid the
   *  chip colouring entirely: Phase 5's arrival closes private companies
   *  but rusts nothing, so `rustingTier` is correctly `null` there and no
   *  chip could ever tint. Worth stating because the mock looked fine. */
  trains: string[];
}> = [
  {
    id: 1, ticker: "PRR", floated: true, par: 100, market: 112, president: 0,
    holdings: [{ player: 0, percentage: 60 }, { player: 1, percentage: 20 }, { player: 2, percentage: 10 }],
    ipo: 10, bank: 0, treasury: 640, homeHex: "H12",
    trains: ["3", "3", "2", "2"],
  },
  {
    id: 2, ticker: "NYC", floated: true, par: 90, market: 82, president: 1,
    holdings: [{ player: 1, percentage: 40 }, { player: 0, percentage: 30 }, { player: 3, percentage: 10 }],
    ipo: 10, bank: 10, treasury: 900, homeHex: "E19",
    trains: ["3", "2"],
  },
  {
    id: 3, ticker: "CPR", floated: true, par: 76, market: 76, president: 2,
    holdings: [{ player: 2, percentage: 30 }, { player: 3, percentage: 20 }, { player: 0, percentage: 10 }],
    ipo: 30, bank: 10, treasury: 760, homeHex: "A19",
    trains: ["3"],
  },
  {
    id: 4, ticker: "B&O", floated: false, par: 67, market: null, president: 3,
    holdings: [{ player: 3, percentage: 20 }],
    ipo: 80, bank: 0, treasury: 0, homeHex: "I15",
    trains: [],
  },
  {
    // Design note #6: ILLEGAL STATE CORRECTED. This fixture had two players
    // holding 10% each with `president: null` -- a position 1830 cannot
    // reach. The President's Certificate is the FIRST thing sold out of a
    // corporation's IPO; ordinary 10% shares only become buyable after it
    // is gone. So "shares held, no president" is not a rare edge case, it
    // is unreachable, and the card correctly offered a President's Share
    // that two people had already bought around.
    //
    // Player 0 now holds the 20% certificate and is president; player 2
    // keeps a 10% share. C&O stays the PARRED-BUT-UNFLOATED example (par
    // set, 30% sold against a 60% float threshold), which is what this
    // fixture exists to exercise.
    id: 5, ticker: "C&O", floated: false, par: 82, market: null, president: 0,
    holdings: [{ player: 0, percentage: 20 }, { player: 2, percentage: 10 }],
    // 30% sold -> 70% still in the IPO. The pools must always total 100%
    // with the holdings; raising a holding without lowering a pool is how
    // this fixture briefly summed to 110%.
    ipo: 70, bank: 0, treasury: 0, homeHex: "K15",
    trains: [],
  },
  {
    // Design note #3: ERIE is FLOATED here specifically so the board has a
    // token on a dual-city (OO) hex to render. C&O above remains the
    // unfloated example -- and, with its par already set, is now also the
    // parred-but-unfloated case the Par/IPO track exists to show.
    id: 6, ticker: "ERIE", floated: true, par: 71, market: 76, president: 2,
    holdings: [{ player: 2, percentage: 30 }, { player: 3, percentage: 30 }],
    ipo: 40, bank: 0, treasury: 710, homeHex: "E11",
    trains: ["2", "2"],
  },
  {
    id: 7, ticker: "NNH", floated: true, par: 71, market: 67, president: 0,
    holdings: [{ player: 0, percentage: 30 }, { player: 1, percentage: 30 }, { player: 2, percentage: 20 }],
    ipo: 20, bank: 0, treasury: 710, homeHex: "G19",
    trains: ["2"],
  },
  {
    id: 8, ticker: "B&M", floated: true, par: 82, market: 90, president: 1,
    holdings: [
      { player: 1, percentage: 30 }, { player: 0, percentage: 20 },
      { player: 2, percentage: 20 }, { player: 3, percentage: 20 },
    ],
    ipo: 10, bank: 0, treasury: 820, homeHex: "E23",
    trains: [],
  },
];

/* ------------------------------------------------------------------ */
/* DESIGN NOTE #8: THE B&O PRIVATE DOES NOT AUTO-FLOAT THE B&O          */
/* ------------------------------------------------------------------ */
//
// Winning the B&O private grants its owner the B&O's 20% President's
// Certificate and prompts them to choose a par price. That is ALL it does.
// The corporation then floats on the ordinary 60%-sold condition like every
// other company.
//
// This mock previously showed B&O as floated on 20% sold, and the UI grew
// an "auto-floated by the B&O private" note to explain it. Both were built
// on `auction.rs` setting `company.is_floated = true` outright when the
// private is won (line ~502) -- which is a CONTRACT BUG, now on the audit
// list, not a rule. The frontend models the correct rule; the contract will
// be brought into line separately.
//
// So B&O is the sandbox's "parred, president assigned, awaiting float"
// case: par 67 set, Dave holding the president's certificate, 20% sold,
// `floated: false`, and no market position (an unfloated company has no
// token on the chart -- see `sandboxMarketPositions`).

/* ------------------------------------------------------------------ */
/* Design note #4: STATION TOKENS FOR FLOATED COMPANIES                */
/* ------------------------------------------------------------------ */
//
// A corporation places its home station token when it floats, so the rail
// map should show one per floated company. The sandbox previously sent
// `station_token_hexes: []` for everybody, which produced the reported
// symptom exactly: the preprinted reservation markers correctly disappeared
// (the renderer hides those once a company exists) and nothing replaced
// them, so home cities rendered bare.
//
// Coordinates are looked up from `hexBoardData`'s own `STATIC_BOARD_HEXES`
// rather than typed in, so a mock token can never sit on a coordinate the
// board does not have.
//
// ⚠ ERIE AND THE DUAL-CITY CHOICE. Erie's home is an OO hex -- two separate
// city circles on one tile (`YELLOW_OO_HEXES`) -- so floating Erie really
// requires the president to choose WHICH of the two slots the token goes
// in. Nothing in this UI offers that choice yet, and
// `station_token_hexes` is a list of `(q, r)` pairs with no slot index, so
// the shape cannot express the answer even if the UI asked. The mock
// therefore places Erie's token on the hex and lets the renderer's own slot
// allocator pick a circle. Implementing the real choice needs both a UI
// affordance and a slot index in the contract's response -- an audit item,
// not something to fake here.
//
// NOTE ON THE HEX LABEL: this board puts Erie's home at E11 (Dunkirk &
// Buffalo), not E20 -- there is no E20 in `STATIC_BOARD_HEXES` at all.
// E11 is the OO hex meant.

/** Home-hex label -> axial coordinate, resolved from the real board. */
function axialForLabel(label: string): [number, number] | null {
  const hex = STATIC_BOARD_HEXES.find((entry) => entry.label === label);
  return hex ? [hex.q, hex.r] : null;
}

/** Market price by `company_id`, for the Stock Round roster. Separate from
 *  `GameStateResponse` because on a real chain it comes from a different
 *  query (`GetMarketGrid`) -- keeping the split here means the panel's props
 *  match what it will really be handed. */
export const SANDBOX_MARKET_PRICES: Readonly<Record<number, number | null>> =
  Object.fromEntries(SANDBOX_CORPORATIONS.map((c) => [c.id, c.market]));

/* ------------------------------------------------------------------ */
/* Design note #2: ONE PRICE, TWO RENDERERS                            */
/* ------------------------------------------------------------------ */
//
// The corporation cards and the 2D stock-market chart are different
// components fed by different props, and in the sandbox they were fed by
// different TABLES: the cards read `SANDBOX_MARKET_PRICES` (above), while
// the chart read a hand-written `MOCK_MARKET_GRID` literal in `App.tsx`
// that predated this file. They disagreed immediately and in every way
// they could -- PRR read 112 on its card and sat on the chart's 100 cell,
// NYC read 82 and sat on 100, ERIE had no market price at all on its card
// (correctly, being unfloated) while a token sat on the chart for it, and
// four of the eight corporations were simply absent from the chart.
//
// A mock whose two halves contradict each other is worse than no mock: the
// screen it produces is one nobody can learn anything from, and the first
// instinct on spotting it is to go hunting for a rendering bug that does
// not exist.
//
// `sandboxMarketPositions` below derives the chart from the SAME
// `SANDBOX_CORPORATIONS` table the cards read, so the two cannot drift
// again. `App.tsx` supplies the price->cell lookup (see
// `StockMarketRenderer.marketCellForPrice`) rather than this module
// importing it, because `utils/` must not depend on `components/` -- the
// one-way rule `utils/feed.ts`'s own header records.

/** One corporation's token position on the market chart. */
export interface SandboxMarketPosition {
  company_id: number;
  ticker: string;
  x: number;
  y: number;
  price: string;
}

/**
 * Builds the chart positions from the same corporations table the cards
 * use.
 *
 * @param cellForPrice `StockMarketRenderer.marketCellForPrice`, injected to
 *                     keep this module free of component imports.
 *
 * UNFLOATED CORPORATIONS ARE OMITTED, not placed at a default cell. A
 * company that has not floated has no market position at all -- its card
 * shows a dash for exactly that reason -- so putting a token on the chart
 * for it would contradict the card a second time, in the opposite
 * direction. Same for a price the chart has no cell for: skipped rather
 * than parked at the origin.
 */
export function sandboxMarketPositions(
  cellForPrice: (price: number) => { x: number; y: number } | null,
): SandboxMarketPosition[] {
  const positions: SandboxMarketPosition[] = [];
  for (const corp of SANDBOX_CORPORATIONS) {
    if (!corp.floated || corp.market === null) continue;
    const cell = cellForPrice(corp.market);
    if (!cell) continue;
    positions.push({
      company_id: corp.id,
      ticker: corp.ticker,
      x: cell.x,
      y: cell.y,
      price: String(corp.market),
    });
  }
  return positions;
}

function buildPublicCompanies(): PublicCompanyState[] {
  return SANDBOX_CORPORATIONS.map((corp) => {
    const soldToPlayers = corp.holdings.reduce((sum, h) => sum + h.percentage, 0);
    return {
      company_id: corp.id,
      ticker: corp.ticker,
      is_floated: corp.floated,
      treasury: String(corp.treasury),
      // One certificate is 10%, per rules.md's SR transaction rule.
      total_shares_issued: soldToPlayers / 10,
      par_value: corp.par === null ? null : String(corp.par),
      owned_trains: corp.trains,
      president: corp.president === null ? null : SANDBOX_PLAYERS[corp.president],
      // Whatever players do not hold is split between the IPO and the bank
      // pool. Kept internally consistent (the three always sum to 100) so
      // any panel that totals them does not display an impossible board.
      ipo_pool_percentage: corp.ipo,
      bank_pool_percentage: corp.bank,
      player_holdings: corp.holdings.map((h) => ({
        player: SANDBOX_PLAYERS[h.player],
        percentage: h.percentage,
      })),
      home_hex_label: corp.homeHex,
      // Design note #4: a floated company holds its home token; an
      // unfloated one holds none, which is what the renderer needs in order
      // to keep showing the preprinted reservation marker instead.
      station_token_hexes:
        corp.floated && corp.homeHex
          ? ([axialForLabel(corp.homeHex)].filter(Boolean) as Array<[number, number]>)
          : [],
      station_token_limit: 4,
    } satisfies PublicCompanyState;
  });
}

function buildPrivateCompanies(phase: RoundType): PrivateCompanyState[] {
  return SANDBOX_PRIVATES.map((priv) => ({
    private_id: priv.id,
    name: priv.name,
    cost: String(priv.cost),
    revenue_per_or: String(priv.revenue),
    // During the auction NOTHING is owned yet -- that is what the auction is
    // for, and an auction screen showing pre-owned privates would be
    // nonsense. Afterwards they are distributed round-robin so the Financial
    // Ledger and the private-purchase tray have something to show.
    // Design note #7: during the auction, Schuylkill Valley is already SOLD
    // and the rest are still open -- so the grid shows the greyed sold-out
    // card (design note #28 in the dashboard) alongside live ones, which is
    // the only way to see that state before the round ends. Afterwards they
    // are distributed round-robin.
    owner:
      phase === "WaterfallAuction"
        ? priv.id === 1
          ? SANDBOX_PLAYERS[1]
          : null
        : SANDBOX_PLAYERS[(priv.id - 1) % SANDBOX_PLAYERS.length],
    owner_protocol_id: null,
    closed: false,
  }));
}

/* ------------------------------------------------------------------ */
/* The generators                                                      */
/* ------------------------------------------------------------------ */

/**
 * A complete `GameStateResponse` for the given phase.
 *
 * The viewer is seated as Alice (`active_player_index: 0`) in every phase,
 * so `isMyTurn` resolves true whenever the sandbox wallet is one of the
 * four -- otherwise the turn-gated controls would all render disabled and
 * there would be nothing to polish.
 */
export function sandboxGameState(phase: RoundType, gameId: number): GameStateResponse {
  return {
    game_id: gameId,
    creator: SANDBOX_PLAYERS[0],
    is_active: true,
    total_juno_pool: "4000000",
    virtual_bank_vgp: "8420",
    virtual_bank_start: "12000",
    max_players: SANDBOX_PLAYERS.length,
    player_addresses: [...SANDBOX_PLAYERS],
    active_player_index: 0,
    priority_deal_index: 0,
    consecutive_passes: 0,
    // Green mid-game: late enough that Green tiles and the second-tier
    // off-board values are live, early enough that Brown is not, so the
    // era-dependent branches are visibly doing something.
    current_global_era: "Green",
    active_operating_order: [1, 2, 8, 7, 3, 4],
    active_corporation_index: 0,
    current_round_type: phase,
    macro_round_number: phase === "WaterfallAuction" ? 1 : 3,
    sub_round_index: phase === "OperatingRound" ? 1 : 0,
    operating_round_sequence_length: 2,
    player_cash: [
      { player: SANDBOX_PLAYERS[0], cash_vgp: "412" },
      { player: SANDBOX_PLAYERS[1], cash_vgp: "268" },
      { player: SANDBOX_PLAYERS[2], cash_vgp: "515" },
      { player: SANDBOX_PLAYERS[3], cash_vgp: "97" },
    ],
    public_companies: buildPublicCompanies(),
    private_companies: buildPrivateCompanies(phase),
  };
}

/**
 * A `WaterfallStateResponse` mid-auction.
 *
 * Composed to show the auction's three distinct card states simultaneously,
 * because each renders differently and all three need looking at:
 *
 *   - Schuylkill Valley is `is_lowest_offered` -- the only one buyable at
 *     face value, and the only one that can never be bid on.
 *   - Delaware & Hudson carries two competing bids.
 *   - Mohawk & Hudson is in an active MINI-AUCTION, which replaces the
 *     normal action rail entirely.
 *
 * Returns `null` for any phase other than the auction, mirroring the real
 * `useWaterfallStatePolling`, which only enables itself during it.
 */
export function sandboxWaterfallState(
  phase: RoundType,
  gameId: number,
): WaterfallStateResponse | null {
  if (phase !== "WaterfallAuction") return null;

  return {
    game_id: gameId,
    waterfall_auction_active: true,
    // Design note #7: mirrors `query_waterfall_state`'s own scope -- only
    // STILL-UNOWNED privates appear here. Schuylkill Valley is sold, so it
    // is absent, and Champlain & St. Lawrence becomes the lowest offered.
    privates: SANDBOX_PRIVATES.filter((priv) => priv.id !== 1).map((priv) => ({
      private_id: priv.id,
      name: priv.name,
      face_value: String(priv.cost),
      is_lowest_offered: priv.id === 2,
      bids:
        priv.id === 3
          ? [
              { bidder: SANDBOX_PLAYERS[1], bid_amount: "80" },
              { bidder: SANDBOX_PLAYERS[2], bid_amount: "95" },
            ]
          : priv.id === 4
            ? // Strictly increasing, not equal: a waterfall bid must beat the
              // standing one by at least `auction::MIN_BID_INCREMENT` ($5),
              // so two players can never hold the same amount. This mock
              // previously had both at 120, which depicted a state the rules
              // make unreachable -- exactly the kind of thing a sandbox is
              // supposed to help catch rather than enshrine.
              [
                { bidder: SANDBOX_PLAYERS[0], bid_amount: "120" },
                { bidder: SANDBOX_PLAYERS[3], bid_amount: "125" },
              ]
            : [],
    })),
    current_turn: SANDBOX_PLAYERS[0],
    mini_auction: {
      private_id: 4,
      bidders: [SANDBOX_PLAYERS[0], SANDBOX_PLAYERS[3]],
      current_turn: SANDBOX_PLAYERS[0],
      // Matches the highest entry in `privates[3].bids` above -- the two
      // are the same fact reported twice by the contract, and a mock where
      // they disagree would send someone hunting a bug that is not there.
      high_bid: "125",
      high_bidder: SANDBOX_PLAYERS[3],
    },
    consecutive_waterfall_passes: 1,
  };
}
