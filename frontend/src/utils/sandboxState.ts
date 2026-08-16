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
//   - Mohawk & Hudson's reserved hex is F16 on chain.
//
// ⚠ THAT SECOND ONE IS NOW A KNOWN DIVERGENCE, not a naming note. F16 is
// Scranton on this board and Scranton is DELAWARE & HUDSON's reserved hex;
// M&H has no hex reservation in 1830 at all, only the NYC share exchange.
// The frontend's display catalog was corrected in
// `WaterfallAuctionDashboard.tsx` design note #312 -- see it for the full
// reasoning. The contract still says F16 belongs to M&H, so this belongs on
// the `auction.rs` audit list; nothing in the frontend reads the reserved
// hex to make a decision, so the divergence is cosmetic until the contract
// starts enforcing it.
//
// The privates are listed in ascending face value -- 20, 40, 70, 110, 160,
// 220 -- which is both the physical game's order and the strict waterfall
// order the auction requires. `WaterfallStateResponse.privates` is
// documented as already arriving sorted that way, so the auction dashboard
// renders them in order without sorting; this mock preserves that
// guarantee rather than relying on it accidentally.

import { STATIC_BOARD_HEXES } from "../components/hexBoardData";
import type { TileColorTier } from "../components/hexTileCatalog";
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
export function sandboxMarketPositions(marks: SandboxMarketPrices): SandboxMarketPosition[] {
  const positions: SandboxMarketPosition[] = [];
  for (const corp of SANDBOX_CORPORATIONS) {
    const mark = marks[corp.id] ?? null;
    // Design note #272: the cell comes off the mark. `cellForPrice` used to
    // be taken as a parameter and called here on every render; it is now
    // used once, at seed time, so a walked token stays where it walked.
    if (!corp.floated || mark === null) continue;
    positions.push({
      company_id: corp.id,
      ticker: corp.ticker,
      x: mark.x,
      y: mark.y,
      price: String(mark.price),
    });
  }
  return positions;
}

/* ==================================================================
 *  DESIGN NOTE 272: THE MARKET IS ITS OWN ATOM, BECAUSE IT IS ON CHAIN
 * ==================================================================
 *
 * REPORTED: no action can be performed in the Stock Phase in the sandbox.
 *
 * Buying and selling did work -- cash moved, shares moved. What did not
 * move was the STOCK MARKET, and on the screen that is mostly stock market
 * that reads as nothing happening at all. `App.tsx` built its
 * `MarketGridResponse` from a `useMemo` over the static
 * `SANDBOX_CORPORATIONS` table with `[sandbox, gameId]` dependencies, so
 * the chart was frozen from first render by construction. Every token sat
 * where the fixture put it for the life of the session.
 *
 * WHY A SEPARATE ATOM RATHER THAN A FIELD ON `GameStateResponse`. The
 * obvious fix is to hang a price off `PublicCompanyState` and let the one
 * reducer move it. That type is a MIRROR of `msg.rs`, and the contract
 * deliberately keeps the market in a different query (`GetMarketGrid`) --
 * so adding the field would make the sandbox's state shape diverge from
 * the one the live path receives, and every component reading it would be
 * reading something a real chain never sends. The split is inconvenient
 * here for exactly the reason it is correct there.
 *
 * So the market gets the same treatment `sandboxWaterfall` already has: its
 * own atom, its own reducer, advanced alongside the game state by the same
 * dispatch. Three mocks, three shapes, matching the three queries.
 */

/** Where one corporation's marker stands: the price AND the cell.
 *
 *  THE CELL IS CARRIED, NOT RE-DERIVED, and that is the whole reason this
 *  is a record rather than a bare number. `marketCellForPrice` returns the
 *  FIRST cell with a given price, and this chart repeats prices across
 *  rows -- so a token walked from $112 at (7,10) down to $90 at (7,8) would
 *  be re-rendered at (5,10), the first $90 on the board. The price would be
 *  right and the marker would have jumped two columns sideways, which reads
 *  as a rendering bug and is the kind of thing that gets reported as one.
 *
 *  The contract has the same property and solves it the same way:
 *  `GetMarketGrid` returns `(x, y)` because it tracks the cell a marker has
 *  actually walked to, rather than re-deriving a position from a price. */
export interface SandboxMarketMark {
  price: number;
  x: number;
  y: number;
}

/** Live market position by `company_id`. `null` for a corporation that has
 *  not floated and therefore has no position on the chart at all. */
export type SandboxMarketPrices = Readonly<Record<number, SandboxMarketMark | null>>;

/** The opening chart, as a mutable starting point.
 *
 *  `cellForPrice` is injected for the usual reason -- `utils/` must not
 *  import `components/`. It is used HERE, at seed time, and never again:
 *  after this the cell travels with the mark. */
export function sandboxInitialMarketPrices(
  cellForPrice: (price: number) => { x: number; y: number } | null,
  /* Design note #387: the Zero State has no market at all.

     REPORTED: unparred corporations show market values and render tokens in
     the Zero State.

     This function seeded from `SANDBOX_CORPORATIONS`, the mid-game fixture,
     with no idea which scenario was being loaded -- so "Game Start (zero
     state)" reset the companies (`par_value: null`, unfloated, empty
     treasuries) and then handed the chart a full set of mid-game prices
     anyway. The two halves of one scenario disagreed because only one of
     them was told which scenario it was.

     A corporation has a market price when it has a PAR, because parring is
     what puts the token on the board. Passing the flag rather than reading
     a module-level scenario keeps this a pure function of its arguments,
     which is what the harness needs to test both branches. */
  zeroState = false,
): SandboxMarketPrices {
  const marks: Record<number, SandboxMarketMark | null> = {};
  for (const corp of SANDBOX_CORPORATIONS) {
    const parred = !zeroState && corp.par !== null;
    const cell = !parred || corp.market === null ? null : cellForPrice(corp.market);
    marks[corp.id] = !parred || corp.market === null || !cell
      ? null
      : { price: corp.market, ...cell };
  }
  return marks;
}

/** Just the prices, for the corporation cards -- design note #2's "one
 *  price, two renderers", now with the chart and the cards reading one
 *  object rather than two tables. */
export function sandboxMarketPriceTable(
  marks: SandboxMarketPrices,
): Readonly<Record<number, number | null>> {
  return Object.fromEntries(
    Object.entries(marks).map(([id, mark]) => [Number(id), mark?.price ?? null]),
  );
}

/** 1830's real per-corporation station allowance, home token included --
 *  keyed by `public_company::CORE_PUBLIC_COMPANIES`' own `company_id`.
 *
 *  Mirrors the table `RulesReference.tsx` states in prose. A small literal
 *  here rather than an import from that file for the same reason every other
 *  figure in this fixture is a literal: the mock must not depend on a
 *  rendering component, and the harness asserts the resulting rows are
 *  internally consistent. */
const STATION_TOKEN_ALLOWANCE: Readonly<Record<number, number>> = {
  1: 4, // PRR
  2: 4, // NYC
  3: 4, // CPR
  4: 3, // B&O
  5: 3, // C&O
  6: 3, // ERIE
  7: 2, // NNH
  8: 2, // B&M
};

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
      // A floated company has operated and so has a figure to show; an
      // unfloated one has never run, which is a real `"0"` rather than the
      // `undefined` that means "this build cannot tell you".
      last_route_revenue: corp.floated ? "90" : "0",
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
      /* Design note #237: THE ALLOWANCE IS PER CORPORATION.
         This was a flat `4` for all eight, which made the new token row
         draw the same four circles for everybody -- including B&M and NNH,
         which get two. A fixture that hands every company the largest
         allowance in the game cannot exercise the case the row exists for
         (a corporation running out), and it contradicts
         `RulesReference.tsx`, which has carried the real table all along:
         PRR/NYC/CPR 4, B&O/C&O/ERIE 3, NNH/B&M 2 -- home token included. */
      station_token_limit: STATION_TOKEN_ALLOWANCE[corp.id] ?? 3,
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
/* ===================================================================
 *  DESIGN NOTE 176: FIVE SCENARIOS, ONE FIXTURE
 * ===================================================================
 *
 * The sandbox was one board: a Phase 3, Green-era Operating Round. That is
 * a reasonable default and a poor testbed, because most of what there is to
 * test is not reachable from it. The yellow tile catalog, the brown
 * catalog, a Stock Round's buy/sell controls and the auction's whole
 * dashboard were each one hardcoded constant away and none of them could be
 * opened.
 *
 * A scenario is deliberately NOT a separate hand-written board. It is the
 * one fixture plus a small, declared delta -- which round type, which era,
 * and which train tier the corporations own. Writing five independent
 * fixtures would mean five sets of presidencies, holdings and treasuries to
 * keep internally consistent, and the sandbox has already been bitten twice
 * by a fixture describing a board 1830 cannot reach (an unfloated company
 * in the operating queue; two players holding shares with no president).
 * One fixture, five deltas, one place for those invariants to live.
 *
 * THE TRAIN TIER IS THE ERA'S REAL DRIVER, and this is the part worth not
 * getting wrong. `derivePhase` reads the highest tier any corporation OWNS
 * -- `current_global_era` is a separate field the contract also tracks, and
 * the two must agree or the phase badge and the tile filter will disagree
 * about which era it is. Each scenario therefore sets BOTH, from one
 * declaration, rather than letting a caller set one and forget the other.
 */
export type SandboxScenarioId =
  | "start"
  | "auction"
  | "stock"
  | "or-yellow"
  | "or-green"
  | "or-brown";

export interface SandboxScenario {
  id: SandboxScenarioId;
  label: string;
  /** One line in the dropdown, so a tester picks by what it exercises
   *  rather than by guessing what the name implies. */
  blurb: string;
  phase: RoundType;
  era: TileColorTier;
  /** The highest train tier in play. Drives `derivePhase`, and is kept in
   *  step with `era` by construction -- see design note #176. */
  trainTier: string;
  /** Design note #9: strip the fixture back to turn 1 -- nothing sold,
   *  nothing floated, no trains, empty treasuries. */
  zeroState?: boolean;
}

export const SANDBOX_SCENARIOS: readonly SandboxScenario[] = [
  /* ==================================================================
   *  DESIGN NOTE 9: A FIXTURE THAT SHOWS EVERY BRANCH CANNOT SHOW TURN 1
   * ==================================================================
   *
   * REPORTED: the sandbox opens mid-game -- Bob already owns a private,
   * corporations are floated, trains are owned -- so the rules that only
   * apply at the START of a game cannot be tested at all.
   *
   * That is a fair description of a deliberate choice, and the choice was
   * right for what it was for. Design note #5 says so in as many words:
   * the holdings were "chosen to put every rendering branch on screen at
   * once rather than to depict a plausible mid-game position". A fixture
   * built to make every UI state visible is necessarily a fixture in which
   * nothing is still at zero.
   *
   * The two purposes are genuinely incompatible, so this is a SEPARATE
   * scenario rather than a rewrite of the others: `start` is the empty
   * board a tester needs for float rules, auction opening bids and first
   * tile lays, and the mid-game fixtures stay exactly as they are for
   * everything they were built to exercise.
   *
   * IT IS THE DEFAULT, because opening on turn 1 is what a player expects
   * from "sandbox" and the mid-game boards are the special case. */
  {
    id: "start",
    label: "Game Start (zero state)",
    blurb: "Turn 1 - nothing sold, nothing floated, empty treasuries",
    phase: "WaterfallAuction",
    era: "Yellow",
    trainTier: "2",
    zeroState: true,
  },
  {
    id: "auction",
    label: "Private Auction",
    blurb: "Phase 1 - bidding and passing on the six privates",
    phase: "WaterfallAuction",
    era: "Yellow",
    trainTier: "2",
  },
  {
    id: "stock",
    label: "Stock Round",
    blurb: "Phase 2 - buying and selling shares, floating corporations",
    phase: "StockRound",
    era: "Yellow",
    trainTier: "2",
  },
  {
    id: "or-yellow",
    label: "Operating Round - Yellow",
    blurb: "Phase 2 - yellow tile catalog, 2-trains",
    phase: "OperatingRound",
    era: "Yellow",
    trainTier: "2",
  },
  {
    id: "or-green",
    label: "Operating Round - Green",
    blurb: "Phase 3 - green upgrades unlocked, 3-trains",
    phase: "OperatingRound",
    era: "Green",
    trainTier: "3",
  },
  {
    id: "or-brown",
    label: "Operating Round - Brown",
    blurb: "Phase 5 - brown upgrades unlocked, 5-trains, privates closed",
    phase: "OperatingRound",
    era: "Brown",
    trainTier: "5",
  },
];

/** 1830's printed depot counts, mirroring `gamePhase.ts`'s `DEPOT_TOTALS`.
 *  Duplicated as a small literal rather than imported to keep this fixture
 *  module free of a dependency on the phase-derivation code it feeds --
 *  and the harness asserts the resulting scenarios leave real stock, which
 *  is the property that actually matters. */
const DEPOT_TOTAL_FOR_TIER: Readonly<Record<string, number>> = {
  "2": 6,
  "3": 5,
  "4": 4,
  "5": 3,
  "6": 2,
};

export const DEFAULT_SANDBOX_SCENARIO: SandboxScenarioId = "start";

export function sandboxScenario(id: SandboxScenarioId): SandboxScenario {
  return SANDBOX_SCENARIOS.find((s) => s.id === id) ?? SANDBOX_SCENARIOS[3];
}

/** The fixture for a scenario -- design note #176. */
/* ==================================================================
 *  DESIGN NOTE 246: A FIXTURE FOR THE TRADE SCREEN
 * ==================================================================
 *
 * REPORTED: the "Buy from Corporation" UI cannot be tested, because the
 * sandbox starts with no corporation owning a train.
 *
 * True, and it is the FLEET CAP below doing it. That cap hands trains out
 * in queue order until the depot would be emptied, which for a Green
 * scenario is three trains -- and the fixture's first corporation alone
 * wants four, so PRR takes all three and every other company opens with
 * none. `TrainPurchasePanel`'s roster then correctly lists nobody (design
 * note #232 filters to corporations that actually own trains), so the
 * accordion is empty and the whole trade flow is unreachable.
 *
 * The cap is right and should stay: its own note records the bug it fixed,
 * a testbed whose first purchase immediately triggers the next phase. What
 * was missing is a way to ask for a DIFFERENT distribution.
 *
 * `trainFixture` is that. `"spread"` gives the first two floated
 * corporations a 2-train and a 3-train each -- a mixed fleet, so the trade
 * panel's badges have more than one model to show and the "one train at a
 * time" limit is exercisable -- while leaving everyone else and the depot
 * alone. It is deliberately a SEPARATE axis from the scenario rather than a
 * sixth scenario: which era you are in and who owns trains are independent
 * questions, and folding them together would mean five more dropdown
 * entries to express one boolean.
 */
export type SandboxTrainFixture = "default" | "spread";

/** How many corporations `"spread"` equips, and with what. Two is the
 *  minimum that makes a TRADE testable -- one to buy and one to sell -- and
 *  more would start eating the depot the fleet cap exists to protect. */
const SPREAD_FIXTURE_FLEET: readonly string[] = ["2", "3"];
const SPREAD_FIXTURE_COMPANIES = 2;

/* ==================================================================
 *  DESIGN NOTE 10: THE BANK IS WHAT IT STARTED WITH, MINUS WHAT IT DEALT
 * ==================================================================
 *
 * REPORTED: the zero state opens with the bank holding $8,460 when it
 * should hold $9,600.
 *
 * `sandboxGameState` sets `virtual_bank_vgp: "8420"` -- a MID-GAME figure,
 * hand-authored to balance against the rich fixture's player cash and
 * corporate treasuries. Design note #9's zero state reset the players and
 * the treasuries and left the bank alone, so the one number that is a
 * FUNCTION of the other two kept its old value. The result was a table
 * where the money did not add up: $12,000 of bank start against $8,420 +
 * $1,600 + $0 = $10,020 on the board.
 *
 * So the two figures are derived from one total here rather than typed
 * separately. Cash dealt is `TOTAL_DISTRIBUTED` split evenly across the
 * seats; the bank keeps the rest. Change the seat count and both move
 * together, and the sum stays $12,000 by construction rather than by
 * somebody re-checking the arithmetic.
 *
 * NOTE ON THE FIGURE: $2,400 split four ways is $600 each. Canonical 1830
 * deals by headcount -- $400 each at four players, for $1,600 total -- so
 * this is the Juno Edition's own flat distribution rather than the printed
 * rule. Recorded because the previous pass used the canonical $400 and a
 * future reader comparing against a rulebook will otherwise think this is
 * a bug. */
const ZERO_STATE_TOTAL_DISTRIBUTED = 2400;
const ZERO_STATE_BANK_START = 12000;
const ZERO_STATE_PLAYER_CASH = Math.floor(
  ZERO_STATE_TOTAL_DISTRIBUTED / SANDBOX_PLAYERS.length,
);
const ZERO_STATE_BANK_CASH = ZERO_STATE_BANK_START - ZERO_STATE_TOTAL_DISTRIBUTED;

export function sandboxScenarioState(
  id: SandboxScenarioId,
  gameId: number,
  /** Design note #246. Defaults to the historic distribution, so every
   *  existing caller and every existing screenshot is unchanged. */
  trainFixture: SandboxTrainFixture = "default",
): GameStateResponse {
  const scenario = sandboxScenario(id);
  const base = sandboxGameState(scenario.phase, gameId);

  /* ==================================================================
   *  DESIGN NOTE 9: THE ZERO STATE
   * ==================================================================
   *
   * Applied by stripping the rich fixture rather than by authoring a
   * second one. Two reasons, and the second is the one that matters:
   *
   *   The IDENTITIES stay right -- tickers, home hexes, par ladder, the
   *   private list, the seating order. Those are 1830 facts, not fixture
   *   choices, and a hand-written second copy would be a second place for
   *   them to drift from the contract.
   *
   *   What is stripped is exactly what a GAME produces: ownership, float,
   *   cash, trains, tokens. Turn 1 is defined by the absence of those, so
   *   removing them IS the zero state rather than an approximation of it.
   *
   * PLAYER CASH IS THE ONE THING SET RATHER THAN CLEARED. 1830 deals each
   * player a starting bank by headcount, and $0 would not be turn 1 -- it
   * would be a table that cannot bid. Four seats is $400 each. */
  if (scenario.zeroState) {
    return {
      ...base,
      active_player_index: 0,
      consecutive_passes: 0,
      private_companies: base.private_companies.map((entry) => ({
        ...entry,
        owner: null,
        owner_protocol_id: null,
        closed: false,
      })),
      public_companies: base.public_companies.map((company) => ({
        ...company,
        is_floated: false,
        president: null,
        par_value: null,
        treasury: "0",
        total_shares_issued: 0,
        // Every certificate starts in the IPO. Nothing has been bought, so
        // nothing is in a player's hands and nothing has been sold into the
        // bank pool -- design note #5's warning about a formula inventing a
        // 10% pool applies here too, so both are stated rather than derived.
        ipo_pool_percentage: 100,
        bank_pool_percentage: 0,
        player_holdings: [],
        owned_trains: [],
        // No corporation has floated, so none has been granted its home
        // token. `station_token_limit` is a printed property of the company
        // and stays.
        station_token_hexes: [],
        station_tokens: [],
        last_route_revenue: "0",
      })),
      player_cash: base.player_cash.map((entry) => ({
        ...entry,
        cash_vgp: String(ZERO_STATE_PLAYER_CASH),
      })),
      // Design note #10: the bank holds what it has not dealt out.
      virtual_bank_vgp: String(ZERO_STATE_BANK_CASH),
      virtual_bank_start: String(ZERO_STATE_BANK_START),
      // Nothing has floated, so there is no operating queue yet.
      active_operating_order: [],
      active_corporation_index: 0,
    };
  }

  /* THE FLEET IS CAPPED, and the reason is a bug this fixture had.
   *
   * The first cut retiered every owned train to the scenario's tier,
   * preserving the count. The fixture's corporations own ten trains between
   * them, and 1830's depot holds only six 2-trains, five 3s and three 5s --
   * so every scenario opened with its OWN tier already sold out, and
   * `depotInventory` correctly reported the next tier up as the only thing
   * buyable. A "Phase 3" testbed whose first purchase immediately triggers
   * Phase 4 is not testing Phase 3.
   *
   * The cap leaves at least two in the depot, so the depot panel has a real
   * current-tier train to sell and the phase-shift warning is not already
   * firing on arrival. Corporations past the cap simply own fewer trains,
   * which costs a testbed nothing. */
  const depotTotal = DEPOT_TOTAL_FOR_TIER[scenario.trainTier] ?? 4;
  const fleetCap = Math.max(1, depotTotal - 2);
  let handedOut = 0;

  /* Design note #246: the trade fixture equips the first two FLOATED
     corporations, in operating order, so the two it picks are the two a
     tester is most likely to be acting as. Unfloated companies are skipped
     -- one cannot operate, so a train in its roster would describe a board
     1830 cannot reach, which is the failure this fixture module has been
     bitten by twice (`sandboxState` design notes #6 and #169). */
  const spreadTargets = new Set<number>(
    trainFixture === "spread"
      ? base.active_operating_order
          .filter((companyId) =>
            base.public_companies.some(
              (company) => company.company_id === companyId && company.is_floated,
            ),
          )
          .slice(0, SPREAD_FIXTURE_COMPANIES)
      : [],
  );

  /* THE FIXTURE'S TRAINS COUNT AGAINST THE CAP, and this is the correction
   * that makes the whole thing safe.
   *
   * A first cut handed the spread fleets out and then ran the ordinary cap
   * loop from zero for everybody else. `depotInventory` derives remaining
   * stock from what corporations OWN, so the two allocations stacked: the
   * spread issued two 3-trains, the loop issued its full three more, and the
   * five-train 3-depot came out at ZERO. That is precisely the state the cap
   * above exists to prevent -- a Green testbed whose Buy-from-Bank panel has
   * nothing at the current tier to sell and whose first purchase would jump
   * the phase. Fixing one panel by breaking the one beside it.
   *
   * Seeding `handedOut` with the current-tier trains the fixture already
   * issued keeps ONE budget across both allocations, so the depot ends up
   * with the same headroom either way. */
  handedOut = spreadTargets.size * SPREAD_FIXTURE_FLEET.filter((tier) => tier === scenario.trainTier).length;

  return {
    ...base,
    current_global_era: scenario.era,
    public_companies: base.public_companies.map((company) => {
      if (spreadTargets.has(company.company_id)) {
        return { ...company, owned_trains: [...SPREAD_FIXTURE_FLEET] };
      }
      const wanted = (company.owned_trains ?? []).length;
      const granted = Math.max(0, Math.min(wanted, fleetCap - handedOut));
      handedOut += granted;
      return {
        ...company,
        owned_trains: Array.from({ length: granted }, () => scenario.trainTier),
      };
    }),
    // Phase 5 closes every private company (`hardware.rs` module doc
    // comment #12). Modelled, because the Buy Private sheet reads `closed`
    // and a Brown scenario that still offered privates for sale would be
    // testing a state the rules forbid.
    private_companies: base.private_companies.map((entry) =>
      scenario.era === "Brown" ? { ...entry, closed: true } : entry,
    ),
  };
}

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
    /* Design note #169 (App.tsx): ONLY FLOATED CORPORATIONS OPERATE.
       This read `[1, 2, 8, 7, 3, 4]`, and 4 is B&O -- `floated: false`,
       treasury `0`, still awaiting its 60%. An unfloated company cannot
       take an Operating Round turn, so its presence here described a board
       1830 cannot reach, and any consumer walking the queue to its end
       would eventually hand the turn to a company with no money and no
       right to it.

       The remaining six are exactly the `floated: true` entries, in the
       operating order the sandbox intends (highest market price first:
       PRR 112, B&M 90, NYC 82, CPR 76, ERIE 76, NNH 67 -- with ERIE and
       NNH placed by the fixture's own choice rather than derived, since
       `calculate_operating_order`'s tie-break is the contract's). */
    active_operating_order: [1, 8, 2, 3, 6, 7],
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
  /** Design note #9: the turn-1 auction -- every private still on offer,
   *  no standing bids, no mini-auction in progress. */
  zeroState = false,
): WaterfallStateResponse | null {
  if (phase !== "WaterfallAuction") return null;

  if (zeroState) {
    return {
      game_id: gameId,
      waterfall_auction_active: true,
      // All six, cheapest first, and the cheapest is the only one buyable
      // outright -- which is exactly what the rules say on turn 1.
      privates: SANDBOX_PRIVATES.map((priv, index) => ({
        private_id: priv.id,
        name: priv.name,
        face_value: String(priv.cost),
        is_lowest_offered: index === 0,
        bids: [],
      })),
      current_turn: SANDBOX_PLAYERS[0],
      mini_auction: null,
      consecutive_waterfall_passes: 0,
    };
  }

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
