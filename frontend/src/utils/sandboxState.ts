// frontend/src/utils/sandboxState.ts
//
// Frozen, hand-authored fixtures for the sandbox. NOT a simulation: nothing
// here advances, validates or reacts, and there is not a reducer in the file.
//
// Rosters, ids, face values and revenues mirror the contract's own canonical
// tables rather than being invented -- the point of these screens is to judge
// how REAL data lays out. Privates are in ascending face value, the strict
// waterfall order.
//
// Known divergence: the contract says M&H reserves F16; F16 is Scranton and
// belongs to the D&H. On the auction.rs list -- cosmetic until enforced.
//
// See docs/ai_architecture/sandbox_reducer.md - sandboxState.ts #0, #1

import { STATIC_BOARD_HEXES } from "../components/hexBoardData";
import { STATION_HOME_HEXES } from "../components/hexContractTypes";
import type { TileColorTier } from "../components/hexTileCatalog";
import type {
  GameStateResponse,
  MarketPositionMark,
  PublicCompanyState,
  PrivateCompanyState,
  RoundType,
  WaterfallStateResponse,
} from "./gameState";

/** Design note #607: the board's own preprinted reservation table, by
 *  `company_id`. Throws rather than returning `null` for an unknown id --
 *  every core corporation has a home, so a miss here is a typo in the
 *  fixture and not a state the game can be in. */
function homeHexFor(companyId: number): string {
  const home = STATION_HOME_HEXES.find((entry) => entry.companyId === companyId);
  if (!home) throw new Error(`No preprinted home hex for company_id ${companyId}`);
  return home.label;
}

/** Readable seat names rather than bech32: a column of truncated addresses tells you nothing about whether the layout works.
 *  See docs/ai_architecture/sandbox_reducer.md - sandboxState.ts #0 */
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
/** Design note #843: EXPORTED so `privateOfferRow.test.ts` can pin `privateCatalog.ts`'s face values against
 *  it. Two tables of the same six numbers is the shape this codebase keeps finding wrong; they are not merged
 *  -- one is the sandbox's setup and one is presentation data for a lookup table -- so they are checked
 *  against each other instead, and a divergence is a failing test rather than a table that lies to a player. */
export const SANDBOX_PRIVATES: ReadonlyArray<{
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

/** Holdings chosen to put every rendering branch on screen at once, not to depict a plausible position. #6: home hexes are the real 1830 ones -- the mock had B&M squatting NNH's reserved G19.
 *  See docs/ai_architecture/sandbox_reducer.md - sandboxState.ts #5 */
export const SANDBOX_CORPORATIONS: ReadonlyArray<{
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
  /** Pool splits are EXPLICIT, not derived: the old formula invented a 10% bank pool for every floated company. A formula that fabricates plausible numbers looks systematic, so nobody checks it.
   *  See docs/ai_architecture/sandbox_reducer.md - sandboxState.ts #5 */
  ipo: number;
  bank: number;
  treasury: number;
  /* Home hexes are DERIVED from STATION_HOME_HEXES, the mirror of hexmap::CORPORATION_HOME_HEX. A hand-typed copy had C&O at K15; the other seven matched, which is what made it read as verified.
     See docs/ai_architecture/sandbox_reducer.md - sandboxState.ts #607 */
  homeHex: string | null;
  /** Phase 3 with one 3-train left in the depot -- the one state where the phase badge, the shift warning, the rust tint and the fleet-cap pill are all visible at once.
   *  See docs/ai_architecture/sandbox_reducer.md - sandboxState.ts #5 */
  trains: string[];
}> = [
  {
    id: 1, ticker: "PRR", floated: true, par: 100, market: 112, president: 0,
    holdings: [{ player: 0, percentage: 60 }, { player: 1, percentage: 20 }, { player: 2, percentage: 10 }],
    ipo: 10, bank: 0, treasury: 640, homeHex: homeHexFor(1),
    trains: ["3", "3", "2", "2"],
  },
  {
    id: 2, ticker: "NYC", floated: true, par: 90, market: 82, president: 1,
    holdings: [{ player: 1, percentage: 40 }, { player: 0, percentage: 30 }, { player: 3, percentage: 10 }],
    ipo: 10, bank: 10, treasury: 900, homeHex: homeHexFor(2),
    trains: ["3", "2"],
  },
  {
    id: 3, ticker: "CPR", floated: true, par: 76, market: 76, president: 2,
    holdings: [{ player: 2, percentage: 30 }, { player: 3, percentage: 20 }, { player: 0, percentage: 10 }],
    ipo: 30, bank: 10, treasury: 760, homeHex: homeHexFor(3),
    trains: ["3"],
  },
  {
    id: 4, ticker: "B&O", floated: false, par: 67, market: null, president: 3,
    holdings: [{ player: 3, percentage: 20 }],
    ipo: 80, bank: 0, treasury: 0, homeHex: homeHexFor(4),
    trains: [],
  },
  {
    // ILLEGAL STATE CORRECTED: two holders with president null is unreachable, because the President's Certificate is the first thing sold out of an IPO.
    // See docs/ai_architecture/sandbox_reducer.md - sandboxState.ts #6
    id: 5, ticker: "C&O", floated: false, par: 82, market: null, president: 0,
    holdings: [{ player: 0, percentage: 20 }, { player: 2, percentage: 10 }],
    // 30% sold -> 70% still in the IPO. The pools must always total 100%
    // with the holdings; raising a holding without lowering a pool is how
    // this fixture briefly summed to 110%.
    ipo: 70, bank: 0, treasury: 0, homeHex: homeHexFor(5),
    trains: [],
  },
  {
    // Design note #3: ERIE is FLOATED here specifically so the board has a
    // token on a dual-city (OO) hex to render. C&O above remains the
    // unfloated example -- and, with its par already set, is now also the
    // parred-but-unfloated case the Par/IPO track exists to show.
    id: 6, ticker: "ERIE", floated: true, par: 71, market: 76, president: 2,
    holdings: [{ player: 2, percentage: 30 }, { player: 3, percentage: 30 }],
    ipo: 40, bank: 0, treasury: 710, homeHex: homeHexFor(6),
    trains: ["2", "2"],
  },
  {
    id: 7, ticker: "NNH", floated: true, par: 71, market: 67, president: 0,
    holdings: [{ player: 0, percentage: 30 }, { player: 1, percentage: 30 }, { player: 2, percentage: 20 }],
    ipo: 20, bank: 0, treasury: 710, homeHex: homeHexFor(7),
    trains: ["2"],
  },
  {
    id: 8, ticker: "B&M", floated: true, par: 82, market: 90, president: 1,
    holdings: [
      { player: 1, percentage: 30 }, { player: 0, percentage: 20 },
      { player: 2, percentage: 20 }, { player: 3, percentage: 20 },
    ],
    ipo: 10, bank: 0, treasury: 820, homeHex: homeHexFor(8),
    trains: [],
  },
];

// The B&O private grants a presidency and a par prompt and nothing else -- the corporation still floats at 60% sold. auction.rs setting is_floated outright is a contract bug on the audit list.
// See docs/ai_architecture/sandbox_reducer.md - sandboxState.ts #8

// A floated corporation shows its home token; coordinates looked up from STATIC_BOARD_HEXES so a mock token cannot sit on a hex the board lacks. ERIE's OO home needs a slot index the response shape cannot express.
// See docs/ai_architecture/sandbox_reducer.md - sandboxState.ts #4

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

// ONE PRICE, TWO RENDERERS: the cards and the chart were fed by different tables and disagreed in every way they could. A mock whose halves contradict each other is worse than no mock.
// See docs/ai_architecture/sandbox_reducer.md - sandboxState.ts #2

/** One corporation's token position on the market chart. */
export interface SandboxMarketPosition {
  company_id: number;
  ticker: string;
  x: number;
  y: number;
  price: string;
  /** Design note #1159: the arrival ordinal (#646), carried through so the board can stack in the order the
   *  operating cursor already plays in. `undefined` off a real chain, which has no such field. */
  enteredAt?: number;
}

/** Unfloated corporations are OMITTED, not parked at a default cell -- their card shows a dash, and a token would contradict it in the opposite direction.
 *  See docs/ai_architecture/sandbox_reducer.md - sandboxState.ts #2 */
export function sandboxMarketPositions(marks: SandboxMarketPrices): SandboxMarketPosition[] {
  const positions: SandboxMarketPosition[] = [];
  for (const corp of SANDBOX_CORPORATIONS) {
    const mark = marks[corp.id] ?? null;
    // The MARK is the position; corp.floated read a static fixture, so a corporation parred during play could never gain one. cellForPrice is used once, at seed time.
    // See docs/ai_architecture/sandbox_reducer.md - sandboxState.ts #401
    if (mark === null) continue;
    positions.push({
      company_id: corp.id,
      ticker: corp.ticker,
      x: mark.x,
      y: mark.y,
      price: String(mark.price),
      /* ==================================================================
          DESIGN NOTE 1159: THE ARRIVAL ORDINAL REACHES THE BOARD
         ==================================================================
         REPORTED: "in the physical game, corporation tokens stack when they occupy the same cell, with new
         entrants taking the bottom of the stack -- play then happens top-to-bottom. There is no such stack
         happening on our cells, the corporation markers are simply scattered around it."
         THE ORDER ALREADY EXISTED AND STOPPED HERE. #646 stamps `enteredAt` on every landing and #647 sorts
         the operating order by price, then rightmost column, then arrival ascending -- which is the rule the
         report restates. So the ENGINE has been playing in the physical game's order all along; this function
         was dropping the field on the way to the view, and the chart could only scatter because it had
         nothing to sort by.
         OPTIONAL ON THE WIRE TYPE, NOT REQUIRED. A real chain's `MarketPositionEntry` has no such field, and
         the renderer falls back to a deterministic order rather than throwing -- the same shape
         `station_tokens` uses for a pre-G-12 contract. */
      enteredAt: mark.enteredAt,
    });
  }
  return positions;
}

/* The market is its own atom because the contract keeps it in its own query. Hanging a price off PublicCompanyState would make the sandbox's shape diverge from what a real chain sends.
   See docs/ai_architecture/sandbox_reducer.md - sandboxState.ts #272 */

/** The mark carries the CELL as well as the price: this chart repeats prices across rows, so re-deriving would jump a token sideways. GetMarketGrid returns (x, y) for the same reason.
 *  See docs/ai_architecture/sandbox_reducer.md - sandboxState.ts #272 */
/* Design note #1196: AN ALIAS NOW, not a second declaration. The shape moved to `gameState.ts` when the
   positions became part of the state response, and the edge between the two modules is one-way -- so this
   name survives for its ~40 call sites while there is exactly one definition behind it. Two copies of one
   shape is #1184's failure, and this project has paid for that three times.
   An arrival ORDINAL derived from the marks already on the chart, not a clock -- a replay applies the whole
   log in one burst. Stamped only when the cell actually changes.
   See docs/ai_architecture/sandbox_reducer.md - sandboxState.ts #646 */
export type SandboxMarketMark = MarketPositionMark;

/** The next arrival ordinal for a chart. One past the highest already on it,
 *  so it is monotonic without a counter to keep -- and derived, so a replay
 *  reaches the same numbers rather than continuing from wherever this
 *  browser's session had got to. */
export function nextArrival(prices: SandboxMarketPrices): number {
  let highest = 0;
  for (const mark of Object.values(prices)) {
    if (mark && typeof mark.enteredAt === "number" && mark.enteredAt > highest) {
      highest = mark.enteredAt;
    }
  }
  return highest + 1;
}

/** Records a landing, stamping the arrival only if the cell actually changed.
 *  Every place a marker moves goes through here, so no landing site can
 *  forget -- which is how the tie-break would quietly go back to being
 *  arbitrary for one kind of move. */
export function withArrival(
  prices: SandboxMarketPrices,
  companyId: number,
  landed: { price: number; x: number; y: number },
): SandboxMarketMark {
  const before = prices[companyId] ?? null;
  const sameCell = before !== null && before.x === landed.x && before.y === landed.y;
  return {
    ...landed,
    enteredAt: sameCell ? before.enteredAt : nextArrival(prices),
  };
}

/** Live market position by `company_id`. `null` for a corporation that has
 *  not floated and therefore has no position on the chart at all. */
export type SandboxMarketPrices = Readonly<Record<number, SandboxMarketMark | null>>;

/** The opening chart. cellForPrice is injected (utils/ must not import components/) and used only here; afterwards the cell travels with the mark.
 *  See docs/ai_architecture/sandbox_reducer.md - sandboxState.ts #272 */
export function sandboxInitialMarketPrices(
  cellForPrice: (price: number) => { x: number; y: number } | null,
  /* Both resolvers are supplied and the comparison picks: still at par means the par box, moved means the price grid.
     See docs/ai_architecture/sandbox_reducer.md - sandboxState.ts #415 */
  parCellFor: (parPrice: number) => { x: number; y: number } | null,
  /* A corporation has a market price when it has a PAR. Seeding from the mid-game table with no idea which scenario was loading is how the Zero State showed prices for unparred companies.
     See docs/ai_architecture/sandbox_reducer.md - sandboxState.ts #387 */
  zeroState = false,
): SandboxMarketPrices {
  const marks: Record<number, SandboxMarketMark | null> = {};
  for (const corp of SANDBOX_CORPORATIONS) {
    const parred = !zeroState && corp.par !== null;
    /* Par box first, and only when the two prices agree, so a token that walked to a price equal to some other company's par is not yanked into a box it never stood in.
       See docs/ai_architecture/sandbox_reducer.md - sandboxState.ts #415 */
    const cell =
      !parred || corp.market === null
        ? null
        : (corp.market === corp.par ? parCellFor(corp.market) : null) ??
          cellForPrice(corp.market);
    marks[corp.id] = !parred || corp.market === null || !cell
      ? null
      : { price: corp.market, ...cell };
  }
  return marks;
}

/** parCellFor is StockMarketRenderer.parBoxCellFor, injected. marketCellForPrice returns the FIRST cell with a price and every par also appears in the top row -- renamed, not merely repointed.
 *  See docs/ai_architecture/sandbox_reducer.md - sandboxState.ts #415 */
export function placeParMark(
  prices: SandboxMarketPrices,
  companyId: number,
  parPrice: number,
  parCellFor: (parPrice: number) => { x: number; y: number } | null,
): SandboxMarketPrices {
  if (prices[companyId]) return prices;
  if (!Number.isFinite(parPrice) || parPrice <= 0) return prices;
  const cell = parCellFor(parPrice);
  if (!cell) return prices;
  /* Design note #646: paring IS an arrival -- it is the moment a corporation
     first reaches a cell, and the report's own example ("a first company to
     par at $100 goes first") is exactly this case. */
  return { ...prices, [companyId]: withArrival(prices, companyId, { price: parPrice, ...cell }) };
}

/** Every parred corporation has a mark. An INVARIANT, checked, rather than an edge, detected.
 *
 *  Design note #688: REPORTED -- "B&O, PRR, C&O and NNH are floated ... but only B&O has a Market price ...
 *  those other corporations have their markers on the IPO/Par tray, but they are not on the stock market
 *  matrix."
 *
 *  THE TWO SURFACES HAVE TWO SOURCES, which is the whole bug. The par TRAY is fed `gameState.public_companies`
 *  and reads `par_value` directly, so a company appears there the instant it pars. The MATRIX is fed the
 *  `sandboxMarket` atom, which is NOT part of `GameStateResponse` -- it is shell state, and a mark only arrived
 *  in it when `runGameplayAction` happened to notice a `null -> value` transition on `par_value` go past.
 *
 *  A TRANSITION DETECTOR OVER STATE THAT IS NOT IN THE LOG IS THE #685 BUG AGAIN, one atom over. `rebuildSandbox`
 *  resets the market; the replay then has to re-notice every edge to rebuild it, and anything that misses one --
 *  a batched render, an action applied before the market atom caught up -- loses that corporation's mark
 *  permanently, because nothing ever looks again. B&O survived only because its par arrives by its own
 *  `SetBoPar` branch, which writes the ref synchronously.
 *
 *  SO IT IS NOT AN EDGE. "A corporation with a par has a mark" is true of a state, not of a change between two,
 *  and a fact about a state can be re-established from that state at any time. Run on every action, a rebuild
 *  reconstructs the whole chart with no special case and no memory of how it got there.
 *
 *  IDEMPOTENT BY CONSTRUCTION, AND MOVES SURVIVE: `placeParMark` returns `prices` untouched when the company
 *  already has one, so a token that has walked away from its par box is never yanked back into it. That is what
 *  makes running this unconditionally safe rather than merely cheap.
 *
 *  Returns the SAME OBJECT when nothing changed, so an identity check still means "no re-render". */
export function reconcileParMarks(
  prices: SandboxMarketPrices,
  companies: ReadonlyArray<{ company_id: number; par_value?: string | null }>,
  parCellFor: (parPrice: number) => { x: number; y: number } | null,
): SandboxMarketPrices {
  let next = prices;
  for (const company of companies) {
    const par = Number(company.par_value ?? NaN);
    if (!Number.isFinite(par) || par <= 0) continue;
    next = placeParMark(next, company.company_id, par, parCellFor);
  }
  return next;
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

/** 1830's real per-corporation station allowance, home token included. A literal rather than an import, so the fixture does not depend on a rendering component.
 *  See docs/ai_architecture/sandbox_reducer.md - sandboxState.ts #237 */
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
      /* PRR/NYC/CPR 4, B&O/C&O/ERIE 3, NNH/B&M 2. A flat 4 for all eight cannot exercise the case the token row exists for.
         See docs/ai_architecture/sandbox_reducer.md - sandboxState.ts #237 */
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
    // Nothing is owned during the auction. Schuylkill Valley is already sold so the greyed sold-out card renders beside live ones; afterwards they distribute round-robin.
    // See docs/ai_architecture/sandbox_reducer.md - sandboxState.ts #7
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

/** Five scenarios, ONE fixture plus a declared delta (round type, era, train tier). Five independent fixtures would be five sets of invariants to keep consistent. The tier and the era are set from one declaration.
 *  See docs/ai_architecture/sandbox_reducer.md - sandboxState.ts #176 */
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
  /* A fixture built to show every branch cannot show turn 1, so `start` is a separate scenario rather than a rewrite -- and it is the default.
     See docs/ai_architecture/sandbox_reducer.md - sandboxState.ts #9 */
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

/** 1830's printed depot counts, duplicated as a literal to keep this module free of a dependency on the phase code it feeds.
 *  See docs/ai_architecture/sandbox_reducer.md - sandboxState.ts #10 */
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

/** trainFixture is a SECOND AXIS, not a sixth scenario: which era you are testing and who owns trains are independent questions. "spread" equips the first two floated corporations so the trade panel is reachable.
 *  See docs/ai_architecture/sandbox_reducer.md - sandboxState.ts #246 */
export type SandboxTrainFixture = "default" | "spread";

/** How many corporations `"spread"` equips, and with what. Two is the
 *  minimum that makes a TRADE testable -- one to buy and one to sell -- and
 *  more would start eating the depot the fleet cap exists to protect. */
const SPREAD_FIXTURE_FLEET: readonly string[] = ["2", "3"];
const SPREAD_FIXTURE_COMPANIES = 2;

/* Bank and dealt cash are derived from ONE total, so the sum stays $12,000 by construction. Note: $600 a seat is this build's flat distribution, not canonical 1830's $400 by headcount.
   See docs/ai_architecture/sandbox_reducer.md - sandboxState.ts #10 */
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

  /* The zero state STRIPS the rich fixture rather than authoring a second one: identities are 1830 facts, and what is removed is exactly what a game produces. Player cash is set, not cleared.
     See docs/ai_architecture/sandbox_reducer.md - sandboxState.ts #9 */
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

  /* The fleet cap leaves at least two of the current tier in the depot -- retiering every owned train sold out each scenario's own tier on arrival.
     See docs/ai_architecture/sandbox_reducer.md - sandboxState.ts #246 */
  const depotTotal = DEPOT_TOTAL_FOR_TIER[scenario.trainTier] ?? 4;
  const fleetCap = Math.max(1, depotTotal - 2);
  let handedOut = 0;

  /* Only FLOATED corporations are equipped: an unfloated company cannot operate, so a train in its roster would describe a board 1830 cannot reach.
     See docs/ai_architecture/sandbox_reducer.md - sandboxState.ts #246 */
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

  /* The fixture's trains count against the same budget as the cap loop; two independent allocations stacked and emptied the 3-depot outright.
     See docs/ai_architecture/sandbox_reducer.md - sandboxState.ts #246 */
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
    /* Only floated corporations operate. The queue listed B&O (unfloated, treasury 0), which would eventually hand the turn to a company with no right to it.
       See docs/ai_architecture/sandbox_reducer.md - sandboxState.ts #169 */
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

/** Composed to show the auction's three card states at once: lowest-offered, contested by two bids, and an active mini-auction. null outside the auction.
 *  See docs/ai_architecture/sandbox_reducer.md - sandboxState.ts #0 */
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
