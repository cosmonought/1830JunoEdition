// frontend/src/components/RulesReference.tsx
//
// The Rules Reference tab -- a player-facing 1830 reference, checkable mid-game.
//
// ==================================================================
//  DESIGN NOTE: FIVE PAGES INSIDE ONE TAB, NOT ONE LONG SCROLL
// ==================================================================
// RULED: the reference is split into five internal pages -- OVERVIEW | STOCK ROUND | OPERATING ROUND |
// AUCTION | TABLES -- selected by a strip of tabs INSIDE this surface. It remains a single game-room tab;
// the inner strip is not a second `MainTabBar`, it is closer to the chart tabs on the epilogue page. The
// strip is `position: sticky` so switching pages never requires scrolling back to the top, and it pins BELOW
// the action dock (`data-sticky-dock`, App.tsx) rather than sliding under it.
//
// TWO LEVELS OF INFORMATION, deliberately unequal. Level 1 is what a player reads without opening anything:
// numbers, limits, sequences, the one-line summary in every accordion header, the tables. Level 2 is the body
// of an accordion -- the fuller explanation, closed by default so the page can be scanned.
//
// THE LIVE ROUND STEERS, IT DOES NOT CAGE. On mount and on a ROUND CHANGE the page for the live round is
// selected and (in an Operating Round) the live step is expanded and marked CURRENT; a sub-phase change
// expands the new step additively. Manual navigation always sticks -- the effects fire on genuine transitions
// only, tracked against refs, never on the poll-interval re-render that reports the same round again. Nothing
// is hidden for being irrelevant to the current action.
//
// PLACEHOLDER CONTENT. This pass is layout only. Every rules body below is a placeholder or the previous
// pass's text standing in for the eventual wording; nothing here has been re-verified. The data constants
// that other tests pin (`PRIVATE_CATALOG_ROWS`, the certificate/cash tables) are kept as they were.
//
// VARIANTS. 1830 is the focus of this pass, but 1830+, Level Playing Field and the option flags will each add
// or modify rules (privates, corporations, the Kanawha licence, market, revenue, rusting, seats, bank). The
// content model carries an optional `scope` (`RuleScope`) on every block and a `VariantTag` renders it, so a
// variant-only block can be tagged rather than forked into a second page. The ruleset label in the header is
// a display prop, read from `GAME_TYPE_COPY` by the caller.
//
// SOURCED, NOT REMEMBERED -- unchanged discipline from the first pass; see
// `docs/ai_architecture/rules_and_sourcing.md`. Design note #2's "reference-only" stance also stands: this
// component takes DISPLAY props only, never `gameState`.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { FONT_FAMILY, FONT_FAMILY_MONO, FONT_SIZE, RADIUS, VIEWPORT_RADIUS } from "../styles/typography";
import { PRIVATE_COMPANY_CATALOG, abilitySummary } from "../utils/privateCatalog";
// Design note #640: which build the browser is actually running.
import { UI_BUILD_LABEL } from "../utils/buildStamp";
import type { GameVariants } from "../gameEngine/gameVariants";
/* The player-count limits the lobby deals from -- read, not retyped, so this page and the Stocks tab agree. */
import {
  CERT_LIMIT_BY_PLAYER_COUNT,
  LPF_CERT_LIMIT_BY_PLAYER_COUNT,
  LPF_STARTING_CASH_BY_PLAYER_COUNT,
  STARTING_CASH_BY_PLAYER_COUNT,
} from "../gameEngine/gameSetup";
/* Design note #1117: the one viewport ground, shared rather than retyped. */
import {
  INK,
  INK_PANEL,
  INK_RAISED,
  INK_TEXT,
  INK_TEXT_DIM,
  INK_TEXT_DIMMEST,
  INK_TEXT_FAINT,
  INK_TEXT_MUTED,
  INK_VIEWPORT,
  RULE,
  RULE_STRONG,
} from "../styles/palette";

/* ------------------------------------------------------------------ */
/* Types shared with the caller                                        */
/* ------------------------------------------------------------------ */

type RulesRoundType = "WaterfallAuction" | "StockRound" | "OperatingRound";
type RulesOperatingSubPhase = "BuyPrivate" | "Track" | "Tokens" | "Routes" | "Dividends" | "Hardware";

/** ==================================================================
 *   THE REFERENCE SHOWS THE RULES OF THIS GAME, NOT OF EVERY GAME
 *  ==================================================================
 *  RULED: an in-game reference, not an encyclopedia. Every block can carry a `scope` (shown only when that
 *  variant is on) and/or an `unless` (hidden when it is), and the page tree is rendered inside a
 *  `ScopeContext` holding the set of scopes the current table has switched on. A block with neither applies
 *  to every game and is never filtered -- so nothing common can be hidden by accident. Where a variant
 *  REPLACES a rule, the printed row carries `unless` and the variant row carries `scope`, and the player sees
 *  one applicable rule, tagged. The full ruleset stays in the data; only the rendering is filtered.
 *  THE SCOPES ARE THE APP'S OWN VARIANT FLAGS (`GameVariants` in `gameVariants.ts`): the three game types
 *  (`standard` is always active; `plus` is the 18XX+ map, which the Level Playing Field forces on) and the
 *  option toggles. No parallel variant system -- `activeScopesFor` reads the resolved `GameVariants`. */
export type RuleScope =
  | "standard"
  | "plus"
  | "levelPlayingField"
  | "delayedAuction"
  | "gentleRust"
  | "unpredictableRevenue"
  | "dynamicStockMarket"
  | "plusTiles";

/** The tag a scoped block wears, so a player can see which switch put it there. */
const SCOPE_LABEL: Readonly<Record<RuleScope, string | null>> = {
  standard: null,
  plus: "18XX+",
  levelPlayingField: "LPF",
  delayedAuction: "Delayed auction",
  gentleRust: "Gentle rust",
  unpredictableRevenue: "Unpredictable revenue",
  dynamicStockMarket: "Dynamic market",
  plusTiles: "18XX+ tiles",
};

/** Anything the renderer may filter. */
interface Scoped {
  /** Shown only while this variant is on. */
  scope?: RuleScope;
  /** Hidden while this variant is on -- the printed rule a variant replaces. */
  unless?: RuleScope;
}

/** The scopes a table has switched on. `standard` is always in; the Level Playing Field implies the 18XX+
 *  map (`gameTypeOf` ranks it that way, and the field forces the map on). */
function activeScopesFor(variants: RulesReferenceProps["variants"]): ReadonlySet<RuleScope> {
  const active = new Set<RuleScope>();
  active.add("standard");
  if (!variants) return active;
  if (variants.expandedMap || variants.levelPlayingField) active.add("plus");
  if (variants.levelPlayingField) active.add("levelPlayingField");
  if (variants.delayedAuction) active.add("delayedAuction");
  if (variants.gentleRust) active.add("gentleRust");
  if (variants.unpredictableRevenue) active.add("unpredictableRevenue");
  if (variants.dynamicStockMarket) active.add("dynamicStockMarket");
  if (variants.plusTiles) active.add("plusTiles");
  return active;
}

const ScopeContext = React.createContext<ReadonlySet<RuleScope>>(new Set<RuleScope>(["standard"]));

/** Whether a block applies to the current game. */
function inScope(active: ReadonlySet<RuleScope>, item: Scoped): boolean {
  if (item.scope && !active.has(item.scope)) return false;
  if (item.unless && active.has(item.unless)) return false;
  return true;
}

/** The current game's filter, as a predicate. */
function useInScope(): (item: Scoped) => boolean {
  const active = React.useContext(ScopeContext);
  return (item) => inScope(active, item);
}

export type RulesSection = "overview" | "stock" | "operating" | "auction" | "tables";

const SECTION_ORDER: readonly { id: RulesSection; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "stock", label: "Stock Round" },
  { id: "operating", label: "Operating Round" },
  { id: "auction", label: "Auction" },
  { id: "tables", label: "Tables" },
];

/** The page the live round belongs on. The auction lives with the privates it sells. */
function sectionForRound(roundType: RulesRoundType | null | undefined): RulesSection {
  switch (roundType) {
    case "StockRound":
      return "stock";
    case "OperatingRound":
      return "operating";
    case "WaterfallAuction":
      return "auction";
    default:
      return "overview";
  }
}

const ROUND_LABEL: Readonly<Record<RulesRoundType, string>> = {
  WaterfallAuction: "Private Auction",
  StockRound: "Stock Round",
  OperatingRound: "Operating Round",
};

/* ------------------------------------------------------------------ */
/* Operating Round content model                                       */
/* ------------------------------------------------------------------ */

/** A small document grammar for rule bodies. Flat, so the eventual Stock Round and Companies content can use
 *  the same renderer: `h` opens a sub-block, `p` is a paragraph, `ul` a compact list, `table` a lookup table. */
type RuleTable = {
  columns: readonly string[];
  rows: readonly (readonly string[])[];
  /** Zero-based columns to right-align (numbers). */
  numeric?: readonly number[];
};
type RuleNode = Scoped &
  (
    | { h: string }
    | { p: string }
    | { ul: readonly string[] }
    | { table: RuleTable }
    /** A boxed sentence that must not be skimmed past, with an optional tag naming why. */
    | { callout: string; tag?: string }
  );

/** A rule card: the unit both the Operating Round and the Stock Round pages are built from. */
interface RuleCard {
  id: string;
  /** The badge number, or `null` for a card that stands outside the numbered run. */
  number: number | null;
  title: string;
  /** A small tag beside the title -- "Any time · Phase 3+". */
  tag?: string;
  /** A figures line under the title -- "$20 / $5 · G-15". */
  meta?: string;
  /** Level 1: the bold lead line. */
  lead: string;
  /** Level 1: the quick-reference bullets, always visible. */
  quick: readonly string[];
  /** Level 1: an emphasised closing line, when the step has one. */
  quickNote?: string;
  /** Level 1: boxed variant notes, shown only for the game they apply to. */
  notes?: readonly (Scoped & { text: string })[];
  /** Level 2: the detailed rules, behind the Details toggle. */
  detail: readonly RuleNode[];
  scope?: RuleScope;
  unless?: RuleScope;
}

/** One of the five sequential actions, or the separate Buy Private Company action. `subPhase` is the app's
 *  own cursor value that lands here -- a hand-held mirror of `OperatingSubPhaseStepper.tsx`, per the
 *  no-coupling rule. */
interface OperatingStep extends RuleCard {
  id: "buyPrivate" | "track" | "station" | "routes" | "revenue" | "buyTrains";
  /** `null` for Buy Private Company, which is NOT a sixth step. */
  number: number | null;
  /** Short form for chips and the CURRENT breadcrumb. */
  short: string;
  subPhase: RulesOperatingSubPhase;
}

/** The round itself, above the five steps. */
const OPERATING_ROUND_OVERVIEW: {
  lead: string;
  opening: readonly string[];
  phaseNote: string;
  detail: readonly RuleNode[];
} = {
  lead: "Private Companies pay first → Corporations operate in share-value order",
  opening: [
    "Each Private Company that has not closed pays its owner its stated revenue.",
    "Each floated corporation then operates, from highest share value to lowest.",
  ],
  phaseNote: "Beginning in Phase 3, a corporation may also buy a Private Company at any time during its Operating Turn.",
  detail: [
    { p: "The corporation's president controls its Operating Turn." },
    {
      p: "Corporations operate in descending share-value order. When corporations share a value: tokens stacked in the same grid box operate top-down; tokens in different columns, the one furthest right first; tokens in the same column, the one furthest up first.",
    },
    {
      p: "The only mandatory operating actions are to run the corporation's trains on available legal routes and collect the resulting revenue — and, at the start of its first turn, to place its home station. Track construction, additional stations, and train purchases are optional unless another rule forces an action, such as a forced train purchase.",
    },
    {
      p: "A newly purchased train is purchased at the end of the Operating Turn and therefore cannot run during that same turn. Consequently, a corporation cannot run a train on its first Operating Turn.",
    },
    { h: "Order of play" },
    {
      ul: [
        "At the beginning of an Operating Round, each Private Company that has not closed pays its owner its stated revenue.",
        "Then each floated corporation operates once, in descending share-value order. Ties: same grid box, top token first; different columns, furthest right first; same column, furthest up first.",
        "During its Operating Turn the corporation proceeds through the five operating actions in order: Lay Track, Station Tokens, Run Routes, Dividends, Buy Trains.",
        "From Phase 3 the corporation may also purchase a Private Company during the turn. This is an additional action, not a sixth numbered step.",
        "Train purchases occur at the end of the turn, so a train purchased during that turn cannot run until a later Operating Turn.",
      ],
    },
  ],
};

const OPERATING_STEPS: readonly OperatingStep[] = [
  {
    id: "track",
    number: 1,
    title: "Lay Track",
    short: "Lay Track",
    subPhase: "Track",
    lead: "Place 1 new tile OR upgrade 1 existing tile.",
    quick: [
      "You may do one track action per Operating Turn.",
      "A new tile must normally connect to an existing station by an unblocked route.",
      "Terrain may add a cost.",
      "Tile upgrades are free.",
      "Tile color and phase restrictions apply.",
    ],
    detail: [
      { p: "When operating, a corporation may do one and only one of the following:" },
      { ul: ["Place one tile on a hex that does not already contain a tile; or", "Upgrade one tile already on the board."] },
      { h: "Placing a new tile" },
      {
        p: "Normally, the corporation must be able to trace an unblocked train route of any length from one of its stations to one of the track segments on the tile being placed.",
      },
      { p: "If the new tile contains two separate track segments, only one of those segments needs to be connected to the corporation's railroad." },
      { p: "The corporation does not have to use the newly placed track when it later operates." },
      { p: "Explicit exceptions allow:" },
      {
        ul: [
          "A corporation owning the CSL to place a tile on the CSL hex.",
          "A corporation owning the DH to place a yellow 57 tile on the DH hex.",
          "The NYC to place a yellow 57 tile on its home-station hex.",
          "The Erie to place a green 59 tile on its home-station hex, if green tiles are available.",
        ],
      },
      { p: "Any corporation may place a tile on one of these hexes using the normal connection rules." },
      { h: "Tile placement restrictions" },
      { p: "A tile may not:" },
      {
        ul: [
          "Run track off the edge of the hex grid.",
          "Terminate against the blank side of a gray hex.",
          "Terminate against a solid red hex side representing a lake, inlet, or river.",
        ],
      },
      {
        p: "A corporation may not place a tile on a hex containing a Private Company owned by a player. A hex containing a closed Private Company or a Private Company owned by a corporation may be tiled.",
      },
      { p: "The tile and hex must have the same number and size of cities." },
      { h: "Tile colors and phases" },
      {
        table: {
          columns: ["Tile", "Available", "Placement"],
          rows: [
            ["Yellow", "Phase 2+", "Tan hexes"],
            ["Green", "Phase 3+", "Yellow hexes; may upgrade yellow"],
            ["Brown", "Phase 5+", "May upgrade green"],
          ],
        },
      },
      { p: "For labeled yellow-hex locations (OO, B, NY), the green tile must have the matching label." },
      { p: "Terrain costs shown on the board must be paid when placing a new tile:" },
      { ul: ["Water: $80", "Mountains: $120"] },
      { h: "Upgrading a tile" },
      {
        p: "Normally, the corporation must be able to trace an unblocked train route of any length from one of its stations to at least one track segment on the new tile.",
      },
      { p: "When upgrading:" },
      {
        ul: [
          "Existing track connections must be maintained in the same orientations.",
          "Existing stations must be transferred to the replacement tile with the same connections.",
          "The new tile must be a legal upgrade for the old tile.",
          "Green tiles upgrade yellow tiles; brown tiles upgrade green tiles.",
          "Matching location labels are required where applicable.",
          "No terrain cost is paid for an upgrade.",
        ],
      },
    ],
  },
  {
    id: "station",
    number: 2,
    title: "Station Tokens",
    short: "Station Tokens",
    subPhase: "Tokens",
    lead: "Place up to 1 station token during your Operating Turn.",
    quick: [
      "Your home station must be placed on your first Operating Turn.",
      "Home station: free. First additional station: $40. Later additional stations: $100 each.",
      "The destination city must have an empty station circle.",
      "You cannot have two stations on the same hex.",
      "Normal station placement requires an unblocked route from an existing station.",
      "You cannot block an unoperated corporation's home-station placement.",
    ],
    detail: [
      { p: "A station is created when a corporation places one of its tokens on a large-city station circle." },
      { p: "Stations:" },
      {
        ul: [
          "Allow that city to serve as a base for the corporation's routes.",
          "Can block other corporations' routes when all city circles are occupied.",
        ],
      },
      { h: "Home station" },
      { p: "At the beginning of its first Operating Turn, a corporation must place a token in its starting-city circle. There is no cost." },
      { p: "The Erie may place its home station in either city in the yellow hex marked with the Erie logo." },
      { p: "The Erie does not have to place a tile in its starting hex. The NYC likewise does not have to place a tile in its starting hex." },
      { h: "Additional stations" },
      { p: "During an Operating Turn, a corporation may place one additional station token." },
      {
        p: "Normally, the corporation must be able to trace an unblocked train route of any length from one of its other stations to the destination city. The DH Private Company provides an exception to this connection requirement.",
      },
      {
        table: {
          columns: ["Station", "Cost"],
          rows: [
            ["Home station", "Free"],
            ["First additional station", "$40"],
            ["Each later additional station", "$100"],
          ],
          numeric: [1],
        },
      },
      { p: "Other restrictions:" },
      {
        ul: [
          "The destination city must have an empty station circle.",
          "A corporation may not have more than one station on the same hex.",
          "Station placement is limited by the corporation's available tokens.",
          "A corporation may not place a station that would block the creation of the home station of a corporation that has not yet operated.",
        ],
      },
      { h: "Station blocking" },
      { p: "As long as a city has at least one empty station circle, any corporation may run a route through that city." },
      { p: "Once every circle in a city contains a station belonging to another corporation, an outside corporation may not run a route through that city." },
      {
        p: "However, an outside corporation may still use the fully occupied city as the starting or ending city of a route, provided all other route requirements are satisfied.",
      },
    ],
  },
  {
    id: "routes",
    number: 3,
    title: "Run Routes",
    short: "Run Routes",
    subPhase: "Routes",
    lead: "Each train runs once on one legal route.",
    quick: [
      "A route contains at least 2 cities and includes at least one of the corporation's stations.",
      "A route cannot exceed the train's city limit.",
      "A route must be continuous and cannot reuse track.",
      "A route cannot pass through a fully blocked large city or a red off-board area.",
      "Multiple trains may meet or cross at cities, but their routes may not use the same track.",
      "A newly purchased train cannot run until the next Operating Turn.",
    ],
    quickNote: "Choose the combination of routes with the highest revenue.",
    detail: [
      { p: "Each train owned by a corporation may run once during its Operating Turn." },
      {
        p: "A route consists of a continuous segment of track connecting at least two cities and including at least one city containing one of the corporation's stations.",
      },
      { p: "For route purposes, a “city” includes large cities, small cities, and red off-board areas." },
      { h: "Train range" },
      { p: "The number on a train indicates the maximum number of cities on its route." },
      {
        table: {
          columns: ["Train", "Maximum cities"],
          rows: [
            ["2-train", "2"],
            ["3-train", "3"],
            ["4-train", "4"],
            ["5-train", "5"],
            ["6-train", "6"],
            ["Diesel", "Unlimited"],
          ],
          numeric: [1],
        },
      },
      { p: "A train may run a shorter route, but every route must contain at least 2 cities." },
      { h: "Route restrictions" },
      { p: "A route must be continuous. A route:" },
      {
        ul: [
          "May not reverse at a junction.",
          "May not change track at a crossover.",
          "May not use the same section of track more than once.",
          "May not include the same city more than once.",
          "May not skip a city that it runs through.",
          "May begin or end at any city.",
          "May enter a city on one track and leave on another.",
          "May use different sections of track on the same tile.",
          "May include different cities located in the same hex.",
        ],
      },
      { p: "A route may not pass through:" },
      {
        ul: [
          "A red off-board area.",
          "A large city whose station circles are all occupied by other corporations.",
        ],
      },
      { p: "Red off-board areas may therefore be the starting or ending city, but never the middle of a route." },
      { h: "Multiple trains" },
      { p: "When a corporation runs more than one train:" },
      {
        ul: [
          "No two routes may use the same section of track.",
          "Routes may meet or cross at cities.",
          "Routes may use separate track sections on the same tile.",
        ],
      },
      { p: "Trains may not be combined or “double headed” to create a longer route." },
      { h: "Highest revenue rule" },
      { p: "When declaring routes, the corporation should choose the combination producing the highest possible revenue." },
      { p: "If another player demonstrates a route combination producing higher revenue, the higher-revenue combination must be used." },
      { p: "Players are not required to point out every higher-revenue possibility." },
    ],
  },
  {
    id: "revenue",
    number: 4,
    title: "Dividends",
    short: "Dividends",
    subPhase: "Dividends",
    lead: "Add train revenue, then choose Dividend or Withhold.",
    notes: [
      {
        scope: "unpredictableRevenue",
        text: "This table plays unpredictable revenue: runs can produce up to ±20% of their standard revenue, rounded to the nearest $10.",
      },
    ],
    quick: [
      "Train revenue = total value of the cities on the trains' routes.",
      "Dividend: pays shareholders and increases share value.",
      "Withhold: puts all revenue in the treasury and decreases share value.",
      "Bank Pool shares receive their dividend into the corporation treasury.",
      "Unsold shares receive no dividend.",
      "A corporation with no revenue cannot declare a $0 dividend just to raise its share value.",
    ],
    detail: [
      { p: "Each train generates revenue equal to the sum of the revenue values of all cities on its route." },
      { p: "Add the revenue from all trains to determine the corporation's total revenue for the Operating Turn." },
      { h: "Off-board revenue" },
      { p: "Red off-board areas have two revenue values." },
      {
        ul: [
          "Before the first 5-train is purchased: use the lesser value.",
          "After the first 5-train is purchased: use the greater value.",
        ],
      },
      { h: "Dividend" },
      { p: "If the corporation pays dividends, its total train revenue is paid to shareholders at 10% of the revenue for each 10% share held." },
      {
        ul: [
          "Shares in the Bank Pool receive their dividends, but that money goes into the corporation's treasury.",
          "Unsold initial-offering shares receive no payment.",
        ],
      },
      { p: "A dividend causes the corporation's share value to increase according to the stock-market rules." },
      { h: "Withhold" },
      { p: "If the corporation does not pay a dividend, its total train revenue is added to its corporate treasury." },
      { p: "The corporation's share value decreases according to the stock-market rules." },
      {
        p: "If a corporation has no revenue because it has no train, no legal route, or both, it cannot declare a $0 dividend simply to increase its share value.",
      },
      { h: "Private Company revenue" },
      { p: "Revenue from a Private Company owned by a corporation is not available for dividends. It is paid directly into that corporation's treasury." },
    ],
  },
  {
    id: "buyTrains",
    number: 5,
    title: "Buy Trains",
    short: "Buy Trains",
    subPhase: "Hardware",
    lead: "At the end of the Operating Turn, buy trains if desired — or when forced.",
    notes: [
      { scope: "gentleRust", text: "This table plays gentle rust: a rusting train gets one last Operating Round turn before it goes." },
    ],
    quick: [
      "Trains may be purchased from the Bank, the Bank Pool, or another corporation.",
      "Buy trains one at a time, because a purchase can immediately trigger a phase change.",
      "Train limit: 4 in Phases 2–3, 3 in Phase 4, 2 from Phase 5.",
      "A corporation with a legal route but no train must buy the cheapest available train — from its own treasury first, then the president's cash.",
    ],
    detail: [
      { p: "A corporation may purchase trains at the end of its Operating Turn." },
      {
        p: "If it already owns the maximum number of trains allowed in the current phase, it cannot purchase another train unless a legal trade-in applies.",
      },
      { h: "Buying from the Bank" },
      { p: "Bank trains are bought at face value and become available in increasing order: 2-trains → 3-trains → 4-trains → 5-trains → 6-trains." },
      { p: "The exception is Diesels, which become available after the first 6-train is purchased." },
      { h: "Buying from the Bank Pool" },
      { p: "Trains in the Bank Pool may be purchased for their face value. Payment goes to the Bank." },
      { h: "Buying from another corporation" },
      { p: "A train may be purchased from another corporation for any mutually agreed price." },
      {
        ul: [
          "Minimum price: $1.",
          "The transaction must be completed during the purchasing corporation's turn.",
          "The seller may sell its last train.",
          "A corporation is never required to buy from another corporation merely because a train is available there.",
        ],
      },
      { h: "Train limits" },
      {
        table: {
          columns: ["Phase", "Trigger", "Maximum trains"],
          rows: [
            ["Phase 2", "First 2-train", "4"],
            ["Phase 3", "First 3-train", "4"],
            ["Phase 4", "First 4-train", "3"],
            ["Phase 5+", "First 5-train", "2"],
          ],
          numeric: [2],
        },
      },
      { p: "The limit changes immediately after the purchase that begins the new phase." },
      {
        p: "If that purchase leaves a corporation with too many trains, the president chooses a train to discard. The discarded train goes to the Bank Pool and the corporation receives no payment.",
      },
      { p: "A corporation may not discard or scrap a train merely to make room for another train." },
      { h: "Diesels" },
      { p: "After the first 6-train is purchased, Diesels become available." },
      {
        table: {
          columns: ["Purchase", "Price"],
          rows: [
            ["Diesel", "$1,100"],
            ["Diesel with a 4-, 5-, or 6-train trade-in", "$800"],
          ],
          numeric: [1],
        },
      },
      { p: "The traded-in train goes to the Bank Pool unless it is made obsolete by the exchange." },
      { p: "The first Diesel purchase removes the remaining 4-trains from play." },
      { h: "Forced train purchase" },
      { p: "If a corporation has a legal train route but has no train at the end of its Operating Turn, it must immediately purchase a train." },
      { p: "The corporation may use the normal purchase rules to buy from the Bank, the Bank Pool, or another corporation." },
      {
        ul: [
          "If the corporation has enough money to buy a train itself, it must purchase the cheapest available train — if 5-trains, 6-trains and diesels are all on offer, that is a 5-train.",
          "If the corporation does not have enough money but the corporation and its president together have enough, the corporation must spend all of its money and the president pays the difference.",
          "When the president's personal money is being used for this forced purchase, a train bought from another corporation may not cost more than its face value.",
          "A cash-strapped corporation is not required to buy another corporation's train merely because it is cheaper than a train in the Bank or Bank Pool.",
        ],
      },
      { p: "If the corporation has no legal train route, it does not have to own or purchase a train." },
    ],
  },
  {
    id: "buyPrivate",
    number: null,
    title: "Buy Private Company",
    tag: "Any time · Phase 3+",
    short: "Buy Private",
    subPhase: "BuyPrivate",
    lead: "Available from Phase 3 onward. Not a sequential operating step.",
    quick: [
      "A corporation may buy a Private Company at any time during its Operating Turn.",
      "Cannot happen before the first 3-train is purchased.",
      "Price must be between ½ and 2× face value, and must be publicly declared.",
      "A corporation may buy Private Companies but may not sell them.",
    ],
    detail: [
      { p: "Beginning in Phase 3, a corporation may purchase a Private Company at any time during its Operating Turn." },
      { p: "The purchase price:" },
      {
        ul: [
          "Cannot be less than half the Private Company's face value.",
          "Cannot exceed twice its face value.",
          "Must be publicly declared.",
        ],
      },
      { p: "The first 3-train purchase is the trigger that permits corporation purchases of Private Companies." },
      { p: "Private Companies owned by corporations cannot subsequently be sold by those corporations." },
      {
        p: "Ownership of certain Private Companies can permit special activities otherwise unavailable to the corporation; those specific abilities are listed on the Auction page.",
      },
    ],
  },
];

/** The five numbered steps, in order, without the separate Buy Private action. */
const SEQUENTIAL_STEPS: readonly OperatingStep[] = OPERATING_STEPS.filter((step) => step.number !== null);
const STEP_CHAIN: readonly string[] = SEQUENTIAL_STEPS.map((step) => step.short);

/** The wording the CURRENT breadcrumb and the game-flow chips use for each cursor value -- the same `stepLabel`
 *  strings `OperatingSubPhaseStepper.tsx` shows in the action bar, so a step is called one thing everywhere. */
const SUB_PHASE_DISPLAY: Readonly<Record<RulesOperatingSubPhase, string>> = {
  BuyPrivate: "Buy Private",
  Track: "Lay Track",
  Tokens: "Station Tokens",
  Routes: "Run Routes",
  Dividends: "Dividends",
  Hardware: "Buy Trains",
};

/* ------------------------------------------------------------------ */
/* Reference data (kept from the previous pass, as placeholder)        */
/* ------------------------------------------------------------------ */


/** Design note #843: the six privates as a lookup row each, derived from `PRIVATE_COMPANY_CATALOG` rather
 *  than typed out here. A second hand-written list of the same six numbers is how the table and the cards
 *  would come to disagree. `Object.entries` keys are strings, so the id is parsed back rather than re-declared. */
/** Which catalog entries belong to a variant rather than the printed six. The JK (id 7) is the Level Playing
 *  Field's seventh private (`privateCatalog.ts` #1320); untagged ids are printed 1830. */
const PRIVATE_SCOPE: Readonly<Record<number, RuleScope>> = { 7: "levelPlayingField" };

const PRIVATE_CATALOG_ROWS = Object.entries(PRIVATE_COMPANY_CATALOG)
  .map(([id, entry]) => ({
    id: Number(id),
    scope: PRIVATE_SCOPE[Number(id)],
    acronym: entry.acronym,
    faceValue: entry.faceValue,
    revenue: entry.revenue,
    power: abilitySummary(entry),
    detail: entry.ability,
    bullets: entry.abilityBullets,
  }))
  .sort((a, b) => a.id - b.id);

/** Rulebook reference data per private, keyed by catalog id. Name, abbreviation, hex and the one-phrase
 *  "special" column are the rulebook's appendix; face value and revenue come from the catalog so the table
 *  and the cards cannot disagree. The rulebook abbreviates Champlain & St. Lawrence as CS in
 *  places; the application says CSL on every other surface, and RULED: consistency with the app wins. */
const PRIVATE_REFERENCE: Readonly<Record<number, { name: string; abbr: string; hex: string; special: string }>> = {
  1: { name: "Schuylkill Valley", abbr: "SV", hex: "G-15", special: "None" },
  2: { name: "Champlain & St. Lawrence", abbr: "CSL", hex: "B-20", special: "Extra track lay" },
  3: { name: "Delaware & Hudson", abbr: "DH", hex: "F-16", special: "Track + free station" },
  4: { name: "Mohawk & Hudson", abbr: "MH", hex: "D-18", special: "Free 10% NYC share" },
  5: { name: "Camden & Amboy", abbr: "CA", hex: "H-18", special: "Free 10% PRR share" },
  6: { name: "Baltimore & Ohio", abbr: "BO", hex: "I-13/I-15", special: "Free B&O President's Certificate" },
  7: { name: "James River & Kanawha", abbr: "JK", hex: "—", special: "Half-cost lay by Coal River; free Kanawha Licence" },
};

/* ------------------------------------------------------------------ */
/* Companies content                                                   */
/* ------------------------------------------------------------------ */

interface CompanyCard extends RuleCard {
  id: "auction" | "basics" | "sv" | "csl" | "dh" | "mh" | "ca" | "bo" | "closure";
  number: number;
}

const COMPANIES_INTRO =
  "There are six private companies. Each generates revenue for its owner while it remains open, and some provide a special ability. Private companies may be owned by players and, beginning in Phase 3, may be purchased by public railroad corporations. They close under the conditions listed below.";

/** "$20 / $5 · G-15" for a company card's meta line, from the catalog and the reference table. */
function companyMeta(id: number): string {
  const row = PRIVATE_CATALOG_ROWS.find((entry) => entry.id === id);
  const ref = PRIVATE_REFERENCE[id];
  if (!row || !ref) return "";
  return `$${row.faceValue} / $${row.revenue} · ${ref.hex}`;
}

const COMPANY_CARDS: readonly CompanyCard[] = [
  {
    id: "auction",
    number: 1,
    title: "Private Company Auction",
    tag: "Pre-game",
    lead: "Before the first Stock Round, the Private Companies are sold through a buy-bid-turn sequence that continues until all of them are purchased.",
    notes: [
      {
        scope: "delayedAuction",
        text: "This table plays the delayed auction: the game opens on Stock Round 1 with no Private Companies in play, and this auction runs at the end of the Operating Round set in which the first 3-train is bought. Until it concludes the B&O cannot be parred, bought or sold.",
      },
    ],
    quick: [
      "Pass — take no action; you may still bid later if the auction continues.",
      "Buy — purchase the unsold Private Company with the lowest face value at its current price; the player to your left receives the Priority Deal Card.",
      "Bid — bid on an unsold Private Company other than the one with the lowest face value: at least $5 over its face value or the highest existing bid, in $1 increments above that.",
      "Bid money is set aside until the bid is resolved. One bidder buys at their bid; several bidders settle it in an auction among themselves.",
    ],
    detail: [
      { h: "Buy-bid-turn sequence" },
      { p: "On a player's turn, they may:" },
      {
        ul: [
          "Pass — take no action; they may still bid later if the auction continues.",
          "Buy — purchase the unsold Private Company with the lowest face value at its current price. The player to their left receives the Priority Deal Card.",
          "Bid — bid on an unsold Private Company other than the one with the lowest face value.",
        ],
      },
      { p: "The sequence continues until all Private Companies are purchased." },
      { h: "Bidding" },
      {
        ul: [
          "A bid must exceed the company's face value, or the highest existing bid, by at least $5.",
          "Bids may be made in $1 increments above that minimum.",
          "The money represented by a bid is set aside and unavailable for other purposes until the bid is resolved.",
          "Multiple players may bid on the same Private Company.",
          "Players may have bids on multiple Private Companies.",
        ],
      },
      { h: "Resolving a bid" },
      { p: "When the unsold Private Company with the lowest face value has at least one bid on it, the buy-bid-turn sequence pauses and that company is resolved." },
      { p: "If only one player has bid on it, that player buys it for their bid." },
      { p: "If multiple players have bid, conduct an auction among only those bidders:" },
      {
        ul: [
          "The starting price is the highest bid already made.",
          "Minimum raise is $5.",
          "The player with the lowest bid starts; play proceeds clockwise.",
          "Players may pass and re-enter while the auction continues.",
          "When all bidders pass consecutively, the highest bidder wins and pays the final winning amount.",
          "The Priority Deal Card does not change hands because of this auction.",
          "Unsuccessful bidders recover their committed bid money.",
        ],
      },
      {
        p: "As soon as one company is resolved, check the next one — now the lowest unsold. If it has bids too, resolve it the same way. Only when the next company has no bids does the buy-bid-turn sequence resume with the Priority Deal Card holder.",
      },
      { h: "If nobody buys" },
      {
        ul: [
          "If all players pass consecutively while Schuylkill Valley (SV) is still unsold, reduce SV's purchase price by $5, then resume the buy-bid-turn sequence.",
          "If SV reaches $0, the next player who takes a buy-bid-turn must buy SV for $0; this counts as a purchase.",
          "If SV has already been purchased, each owned Private Company pays its normal revenue, then the buy-bid-turn sequence resumes with the Priority Deal Card holder.",
        ],
      },
    ],
  },
  {
    id: "basics",
    number: 2,
    title: "Private Company Basics",
    lead: "Private companies pay their owner while open, change hands under specific rules, and cease to exist once closed.",
    quick: [
      "Pay their printed revenue to their owner when they operate.",
      "May be transferred between players under the private-company sale rules.",
      "May eventually be purchased by public railroad corporations, subject to the phase and price restrictions.",
      "Cannot be voluntarily closed, and cannot be sold into the Bank Pool.",
      "Cease to exist once closed.",
    ],
    detail: [
      { h: "Private-company revenue" },
      { p: "At the beginning of each Operating Round, each private company that has not closed pays its owner the revenue printed for that company." },
      {
        table: {
          columns: ["Company", "Revenue"],
          rows: [
            ["Schuylkill Valley (SV)", "$5"],
            ["Champlain & St. Lawrence (CSL)", "$10"],
            ["Delaware & Hudson (DH)", "$15"],
            ["Mohawk & Hudson (MH)", "$20"],
            ["Camden & Amboy (CA)", "$25"],
            ["Baltimore & Ohio (BO)", "$30"],
          ],
          numeric: [1],
        },
      },
      {
        p: "A player-owned private company pays its revenue to the player. A corporation-owned private company pays its revenue to the corporation's treasury and can provide its special ability to that corporation.",
      },
      { h: "Player-to-player sale" },
      { p: "Private companies may be sold between players for any mutually agreed price." },
      { p: "Such sales may occur at any time during the buyer's or seller's turn of a Stock Round other than the first Stock Round." },
      { h: "Corporation purchase" },
      {
        callout: "Beginning in Phase 3, a corporation may buy a private company at any time during its own Operating Turn. This is not one of the five numbered operating steps.",
        tag: "Any time during the turn",
      },
      { p: "Corporations may buy private companies, but may not sell them." },
      { p: "The purchase cannot occur until the first 3-train has been bought." },
      { p: "The price must be:" },
      { ul: ["no less than half the company's face value, and", "no more than twice its face value."] },
      { p: "The price must be publicly declared." },
    ],
  },
  {
    id: "sv",
    number: 3,
    title: "Schuylkill Valley (SV)",
    meta: companyMeta(1),
    lead: "No special effect.",
    quick: ["Pays $5 to its owner while it remains open."],
    detail: [{ p: "Schuylkill Valley has no special ability beyond its $5 revenue while it remains open." }],
  },
  {
    id: "csl",
    number: 4,
    title: "Champlain & St. Lawrence (CSL)",
    meta: companyMeta(2),
    lead: "Its owning corporation may place a tile on the CSL hex in addition to its normal tile placement.",
    quick: [
      "The CSL placement need not connect to the corporation's stations or to any existing track.",
      "It is in addition to the corporation's normal tile placement, so the corporation may place two tiles that turn.",
    ],
    detail: [
      { p: "A corporation owning Champlain & St. Lawrence may lay a track tile on the CSL hex (B-20)." },
      { p: "This placement:" },
      {
        ul: [
          "does not need to connect to one of the corporation's stations;",
          "does not need to connect to any existing track;",
          "is performed in addition to the corporation's normal tile placement;",
          "therefore allows that corporation to place two tiles during that Operating Turn.",
        ],
      },
      { p: "The CSL special tile placement is still subject to the tile-placement restrictions that apply to the hex and tile themselves." },
    ],
  },
  {
    id: "dh",
    number: 5,
    title: "Delaware & Hudson (DH)",
    meta: companyMeta(3),
    lead: "Its owning corporation may lay a tile on the DH hex and place a station there for free.",
    quick: [
      "The placement need not connect to the corporation's stations or to existing track.",
      "The mountain terrain still costs $120, and the placement counts as the corporation's normal tile placement for the turn.",
      "The ability lapses if another corporation tiles the DH hex first.",
    ],
    detail: [
      { p: "A corporation owning Delaware & Hudson may:" },
      { ul: ["lay a track tile on the DH starting hex (F-16); and", "place one of its station tokens on that hex at no cost."] },
      { p: "The mountain terrain still costs $120." },
      { p: "The special DH placement:" },
      {
        ul: [
          "does not need to connect to one of the corporation's stations;",
          "does not need to connect to existing track;",
          "counts as the corporation's normal one tile placement for the turn.",
        ],
      },
      {
        p: "If the corporation does not place the station token on the DH hex on the same turn it lays the tile there, any later station placement must follow the normal station-placement rules.",
      },
      { p: "If another corporation lays a tile on the DH starting hex under the ordinary rules, the DH special ability is no longer available." },
    ],
  },
  {
    id: "mh",
    number: 6,
    title: "Mohawk & Hudson (MH)",
    meta: companyMeta(4),
    lead: "Its owner may exchange it for a 10% NYC share when the required conditions are met.",
    quick: [
      "The player must be able to hold another NYC share within the ownership limit, and a share must be available in the Bank or Bank Pool.",
      "The exchange may happen during the owner's Stock Round turn, or between other players' or corporations' turns in either round.",
      "The exchange closes Mohawk & Hudson immediately.",
    ],
    detail: [
      { p: "A player owning Mohawk & Hudson may exchange it for one 10% share of New York Central." },
      { p: "The exchange requires:" },
      {
        ul: [
          "the player must be able to hold another NYC share without exceeding the applicable ownership limit;",
          "an NYC share must be available in the Bank or Bank Pool.",
        ],
      },
      { callout: "The exchange may occur during the player's Stock Round turn, or between the turns of other players or corporations in either a Stock Round or an Operating Round.", tag: "Own timing window" },
      { p: "The exchange closes Mohawk & Hudson immediately." },
    ],
  },
  {
    id: "ca",
    number: 7,
    title: "Camden & Amboy (CA)",
    meta: companyMeta(5),
    lead: "The initial purchaser immediately receives a free 10% PRR share.",
    quick: [
      "The share is granted without further payment and does not close Camden & Amboy.",
      "PRR is not yet running; the share may be retained or sold subject to the ordinary stock rules.",
    ],
    detail: [
      { p: "The initial purchaser of Camden & Amboy immediately receives one 10% share of Pennsylvania (PRR) without further payment." },
      { p: "This does not close Camden & Amboy." },
      { p: "PRR is not yet running at this point. The share may be retained or sold subject to the ordinary stock rules." },
      {
        p: "The free share does not establish PRR's par value: PRR's President's Certificate must still be purchased and a par value set before ordinary PRR stock transactions can proceed.",
      },
    ],
  },
  {
    id: "bo",
    number: 8,
    title: "Baltimore & Ohio (BO)",
    meta: companyMeta(6),
    lead: "The owner immediately receives the B&O President's Certificate and sets B&O's par value.",
    quick: [
      "Baltimore & Ohio cannot be sold to a corporation.",
      "It remains with its owner if the B&O presidency changes hands.",
      "It closes when the B&O purchases its first train.",
    ],
    detail: [
      { p: "The owner of Baltimore & Ohio immediately receives:" },
      { ul: ["the B&O President's Certificate, without further payment; and", "the opportunity to immediately set B&O's par share value."] },
      { p: "The Baltimore & Ohio private company:" },
      {
        ul: [
          "may not be sold to a corporation corporation;",
          "does not change hands if its owner loses the B&O presidency;",
          "closes when the B&O purchases its first train.",
        ],
      },
      {
        callout: "Owning the Baltimore & Ohio private company and controlling the B&O are not the same thing. The private company stays with its owner even if that player loses the B&O presidency.",
        tag: "Ownership vs. presidency",
      },
    ],
  },
  {
    id: "closure",
    number: 9,
    title: "Closure",
    lead: "Private companies close when their closure conditions occur. Once closed, they cease to exist.",
    quick: [
      "All private companies close when the first 5-train is purchased.",
      "Baltimore & Ohio and Mohawk & Hudson can close earlier under their own rules.",
      "A closed private company no longer pays revenue and has no further effect.",
    ],
    detail: [
      {
        table: {
          columns: ["Company", "Closes when"],
          rows: [
            ["Baltimore & Ohio (BO)", "The B&O purchases its first train"],
            ["Mohawk & Hudson (MH)", "Exchanged for its 10% NYC share"],
            ["All private companies", "The first 5-train is purchased"],
          ],
        },
      },
      { p: "The first 5-train closure is the general closure point; the Baltimore & Ohio and Mohawk & Hudson rules can close those companies earlier." },
      { ul: ["A private company cannot be closed voluntarily.", "A private company cannot be sold into the Bank Pool.", "Once closed, it no longer pays revenue and has no further effect."] },
    ],
  },
];

/** The compact timing table at the foot of the page. */
const COMPANY_TIMING: readonly (readonly [string, string])[] = [
  ["Private companies pay revenue", "Beginning of each Operating Round while open"],
  ["Player sells private company to another player", "During buyer's or seller's Stock Round turn, except the first Stock Round"],
  ["Corporation buys private company", "Phase 3+, at any time during that corporation's Operating Turn"],
  ["Corporation private-company purchase price", "½× to 2× face value, publicly declared"],
  ["MH → NYC share exchange", "Owner's Stock Round turn, or between other players' or corporations' turns in either round"],
  ["BO closes", "When the B&O buys its first train"],
  ["MH closes", "When exchanged for its NYC share"],
  ["All remaining private companies close", "When the first 5-train is bought"],
];

/* ------------------------------------------------------------------ */
/* Tables content -- verified against the updated rulebook (1830-RE)   */
/* ------------------------------------------------------------------ */

/** Player-count limits, read from the app's one source of truth (`gameSetup.ts`) rather than retyped here --
 *  the Stock Round page's certificate table reads the same rows. Printed values (1.0 Starting Money; 4.3
 *  Share and Certificate Limits): $1200/$800/$600/$480/$400 and 28/20/16/13/11 for 2-6 players. The Level
 *  Playing Field's own table (7 seats, higher limits) is the app's variant, not the rulebook's, and is
 *  tagged as such where it is shown. */
const CERT_LIMIT_BY_PLAYERS: ReadonlyArray<{ players: number; limit: number }> = Object.keys(CERT_LIMIT_BY_PLAYER_COUNT)
  .map((key) => Number(key))
  .sort((a, b) => a - b)
  .map((players) => ({ players, limit: CERT_LIMIT_BY_PLAYER_COUNT[players] }));

interface PlayerLimitRow {
  players: number;
  cash: number | null;
  limit: number | null;
  lpfCash: number | null;
  lpfLimit: number | null;
  /** True for a seat count only the Level Playing Field allows. */
  lpfOnly: boolean;
}

const PLAYER_LIMIT_ROWS: readonly PlayerLimitRow[] = Object.keys({ ...CERT_LIMIT_BY_PLAYER_COUNT, ...LPF_CERT_LIMIT_BY_PLAYER_COUNT })
  .map((key) => Number(key))
  .sort((a, b) => a - b)
  .map((players) => ({
    players,
    cash: STARTING_CASH_BY_PLAYER_COUNT[players] ?? null,
    limit: CERT_LIMIT_BY_PLAYER_COUNT[players] ?? null,
    lpfCash: LPF_STARTING_CASH_BY_PLAYER_COUNT[players] ?? null,
    lpfLimit: LPF_CERT_LIMIT_BY_PLAYER_COUNT[players] ?? null,
    lpfOnly: CERT_LIMIT_BY_PLAYER_COUNT[players] === undefined,
  }));

/** The seven phases, rulebook 2.0-2.7. `phase` is the rulebook's number; `tier` is the train tier the app's
 *  `derivePhase` reports while that phase is in force, for the live-row mark (`null` where the app cannot
 *  tell -- phase 1 is the auction, marked from the round type instead). */
interface PhaseRow {
  phase: string;
  tier: string | null;
  begins: string;
  tiles: string;
  trainLimit: string;
  operatingRounds: string;
  offBoard: string;
  buyPrivates: string;
  also: string;
}

const PHASE_ROWS: readonly PhaseRow[] = [
  { phase: "1", tier: null, begins: "Start of the game", tiles: "—", trainLimit: "—", operatingRounds: "—", offBoard: "—", buyPrivates: "No", also: "Ends when all private companies have been purchased" },
  { phase: "2", tier: "2", begins: "All private companies purchased", tiles: "Yellow", trainLimit: "4", operatingRounds: "1", offBoard: "Lesser", buyPrivates: "No", also: "" },
  { phase: "3", tier: "3", begins: "First 3-train", tiles: "Yellow, green", trainLimit: "4", operatingRounds: "2", offBoard: "Lesser", buyPrivates: "Yes", also: "2 ORs begin after the Stock Round that follows the first 3-train" },
  { phase: "4", tier: "4", begins: "First 4-train", tiles: "Yellow, green", trainLimit: "3", operatingRounds: "2", offBoard: "Lesser", buyPrivates: "Yes", also: "2-trains removed from play" },
  { phase: "5", tier: "5", begins: "First 5-train", tiles: "Yellow, green, brown", trainLimit: "2", operatingRounds: "3", offBoard: "Greater", buyPrivates: "—", also: "All private companies close; 3 ORs begin after the Stock Round that follows the first 5-train" },
  { phase: "6", tier: "6", begins: "First 6-train", tiles: "Yellow, green, brown", trainLimit: "2", operatingRounds: "3", offBoard: "Greater", buyPrivates: "—", also: "3-trains removed from play; diesels may be purchased" },
  { phase: "7", tier: "D", begins: "First diesel", tiles: "Yellow, green, brown", trainLimit: "2", operatingRounds: "3", offBoard: "Greater", buyPrivates: "—", also: "4-trains removed from play" },
];

/** Other Reference: small numbers a player forgets mid-turn, grouped. Each row carries its rulebook section. */
interface ReferenceRow extends Scoped {
  label: string;
  value: string;
}
interface ReferenceGroup {
  title: string;
  rows: readonly ReferenceRow[];
}

const OTHER_REFERENCE_GROUPS: readonly ReferenceGroup[] = [
  {
    title: "Terrain & stations",
    rows: [
      { label: "Water hex, new tile", value: "$80" },
      { label: "Mountain hex, new tile", value: "$120" },
      { label: "Extra terrain tier", value: "$40", scope: "plus" },
      { label: "Upgrading a tile", value: "Free, regardless of terrain" },
      { label: "Home station", value: "Free" },
      { label: "First additional station", value: "$40" },
      { label: "Each later station", value: "$100" },
    ],
  },
  {
    title: "Certificates & shares",
    rows: [
      { label: "President's Certificate", value: "20%, counts as 1 certificate" },
      { label: "Individual corporation limit", value: "Normally 5 certificates (50–60%); lifted while the token is in an orange or brown box" },
      { label: "Bank Pool limit", value: "5 certificates per corporation" },
      { label: "Par values", value: "$67 · $71 · $76 · $82 · $90 · $100" },
      { label: "Corporation floats", value: "60% bought from the Initial Offering" },
      { label: "Starting capital", value: "10 × par value" },
      { label: "Stock Market ceiling", value: "$350", unless: "dynamicStockMarket" },
      { label: "Stock Market ceiling", value: "$450 — the chart gains a row above the top", scope: "dynamicStockMarket" },
    ],
  },
  {
    title: "Trains",
    rows: [
      { label: "Train from another corporation", value: "$1 minimum, any agreed price" },
      { label: "Forced purchase with the president's money, train from another corporation", value: "Not above face value" },
      { label: "Diesel trade-in (4-, 5- or 6-train)", value: "$800 instead of $1,100" },
      { label: "Over the train limit", value: "Discard to the Bank Pool, no refund" },
    ],
  },
  {
    title: "Game end",
    rows: [
      { label: "Bank runs out of money", value: "Game ends the next time a Stock Round would start" },
      { label: "Runs out during an Operating Round", value: "Finish the current set of Operating Rounds" },
      { label: "Runs out during a Stock Round", value: "Finish the Stock Round and one set of Operating Rounds" },
      { label: "A player goes bankrupt", value: "Game ends immediately" },
      { label: "Winner", value: "Cash + shares at share value + face value of owned open private companies" },
    ],
  },
  {
    title: "Forced train purchase",
    rows: [
      { label: "Corporation can afford a train", value: "Must buy the cheapest available" },
      { label: "Corporation + president can afford one", value: "Corporation spends everything; president pays the difference" },
      { label: "Still short", value: "President sells shares or private companies to raise it" },
      { label: "Cannot raise it", value: "President is bankrupt; the game ends" },
    ],
  },
];

/** Gotchas: the rules players most often miss, each verified against the updated rulebook (section noted). */
/** Ordered by where they arise in the game -- auction, then Stock Round, then the Operating Turn in its own
 *  sequence -- so the list follows the same mental model as the Game Flow above it. Each links to the page
 *  where that rule is actually explained. */
const GOTCHAS: readonly { text: string; page: RulesSection }[] = [
  { text: "In the auction, when the lowest-priced Private Company already has bids, those bids are resolved before normal buy-bid-turns resume.", page: "auction" },
  { text: "No certificates may be sold in the first Stock Round.", page: "stock" },
  { text: "The turn is Sell → Buy 1 certificate → Sell. You may sell after buying.", page: "stock" },
  { text: "Sell a corporation's certificates and you may not buy that corporation again in the same Stock Round.", page: "stock" },
  { text: "The President's Certificate is never sold into the Bank Pool — the presidency transfers first, and only if another player holds at least 20%.", page: "stock" },
  { text: "Buy Private Company is not a sixth operating step. From Phase 3 a corporation may buy one at any time during its Operating Turn.", page: "operating" },
  {
    /* Track-laying, so it belongs on Operating Round -- it linked to Auction before, which is where the
       privates are listed but not where this rule lives. */
    text: "A hex holding a Private Company a player still owns cannot be tiled. The CSL and DH exception hexes are not reserved: any corporation may tile them under the normal connection rules, and once another corporation tiles the DH hex the DH's special placement is gone.",
    page: "operating",
  },
  { text: "Withheld revenue, dividends on Bank Pool shares, and a corporation-owned Private Company's revenue all go to the corporation's treasury — the last is never paid out as dividends.", page: "operating" },
  { text: "Trains are bought at the end of the turn, so a train bought this turn cannot run — a corporation never runs a train on its first Operating Turn.", page: "operating" },
  { text: "A corporation with a legal route but no train must buy the cheapest train available: its treasury first, then the president's own money, then forced share sales.", page: "operating" },
];

/** NOT a missed-rule gotcha but a consequence, so it is marked differently. Verified against the rulebook:
 *  a president short of the money for a forced purchase must sell their own shares to raise it (6.6.3), those
 *  are ordinary sales, so each share sold drops that corporation's token one box (4.5) -- and if they still
 *  cannot pay, the game ends immediately (6.7 / 7.1), freezing every holding where it stands. */
const BANKRUPTCY_WARNING =
  "A president forced to buy a train must sell their own shares to raise the money, and every share sold drops that corporation's share value one box. Someone else's emergency can therefore cut the value of corporations you hold too — and if they still cannot pay, the game ends immediately, at whatever those prices have become.";



/* ------------------------------------------------------------------ */
/* Stock Round content                                                 */
/* ------------------------------------------------------------------ */

/** The Stock Round's cards. NUMBERED FOR REFERENCE, NOT FOR SEQUENCE: a Stock Round turn is Sell → Buy →
 *  Sell, and these seven are the topics a player looks up, in the order they tend to come up. They carry no
 *  connecting thread for that reason. `cursor` is the app's Stock Round action that makes a card current,
 *  where the app can tell one; there is no sub-phase cursor in a Stock Round the way there is in an
 *  Operating Round, so this is an optional display prop rather than a mirror of anything. */
type StockRoundAction = "Sell" | "Buy";

interface StockCard extends RuleCard {
  id: "sell" | "buy" | "float" | "president" | "limits" | "marketEffects" | "movement";
  number: number;
  cursor?: StockRoundAction;
}

const STOCK_ROUND_OVERVIEW: {
  lead: string;
  sequence: readonly string[];
  exception: string;
  quick: readonly string[];
} = {
  lead: "Players buy and sell stock in the public railroad corporations. Each turn is Sell → Buy → Sell, and the round continues until every player has passed consecutively.",
  sequence: ["Sell any number", "Buy 1 certificate", "Sell any number"],
  exception:
    "The buy is normally one certificate. Exception: if a corporation's share-value token is in a brown box, any number of its Bank Pool certificates may be bought as that one purchase.",
  quick: [
    "The active player is the holder of the Priority Deal Card. After each turn, the Priority Deal passes to the next player in player order.",
    "Passing does not end your Stock Round: as long as someone buys or sells after you pass, you may act again on your next turn.",
    "The round ends when every player has passed consecutively. The player after the last one to buy or sell takes the Priority Deal Card for the next Stock Round; if nobody bought or sold, it stays where it is.",
  ],
};

const STOCK_CARDS: readonly StockCard[] = [
  {
    id: "sell",
    number: 1,
    title: "Sell Stock",
    cursor: "Sell",
    lead: "Sell any number of certificates to the Bank Pool. Each share sold moves that corporation's share-value token down one box.",
    quick: [
      "No certificates may be sold in the first Stock Round.",
      "Once you sell a corporation's certificates, you may not buy that corporation again in the same Stock Round.",
      "You may not sell if the certificates sold plus those already in that corporation's Bank Pool would exceed 5.",
      "Several certificates of one corporation sold in the same turn all fetch the same price — the token moves after the last one. Selling more than one corporation, you choose the order.",
      "The President's Certificate is never sold. Selling down until another player's holding exceeds yours transfers the presidency first — see Change of President.",
    ],
    detail: [],
  },
  {
    id: "buy",
    number: 2,
    title: "Buy Stock",
    cursor: "Buy",
    lead: "Buy 1 certificate from the corporation's Initial Offering or its Bank Pool.",
    quick: [
      "Initial Offering certificates cost the corporation's par value; Bank Pool certificates cost its current share value.",
      "The first certificate bought in a corporation must be its President's Certificate — the buyer sets the par value and pays twice it.",
      "You cannot buy a corporation's stock if you sold its stock earlier in the same Stock Round.",
      "Brown box: any number of one corporation's Bank Pool certificates may be bought as your one purchase — see Special Stock Market Effects.",
    ],
    detail: [
      { h: "Buying a President's Certificate" },
      { p: "Choose the corporation's par value, then pay twice it for the 20% President's Certificate. The par value also places the share-value token on the Stock Market." },
      {
        table: {
          columns: ["Par value", "President's Certificate (20%)"],
          rows: [
            ["$67", "$134"],
            ["$71", "$142"],
            ["$76", "$152"],
            ["$82", "$164"],
            ["$90", "$180"],
            ["$100", "$200"],
          ],
          numeric: [1],
        },
      },
      { p: "Par value never changes afterwards, however the token moves: Initial Offering shares always cost par; Bank Pool shares cost the current share value." },
      { h: "Certificates that arrive through Private Companies" },
      {
        ul: [
          "Baltimore & Ohio (BO): its owner receives the B&O President's Certificate free and sets B&O's par value the same way.",
          "Camden & Amboy (CA): its buyer receives a free 10% PRR share. It cannot be sold until the PRR President's Certificate has been bought and PRR's par value set.",
          "Mohawk & Hudson (MH): may be exchanged for a 10% NYC share. That share likewise cannot be sold before NYC's par value is set.",
        ],
      },
    ],
  },
  {
    id: "float",
    number: 3,
    title: "Floating a Corporation",
    lead: "A corporation floats when 60% of its shares have been bought from the Initial Offering. It begins operating in the next Operating Round.",
    quick: [
      "Shares in the Bank Pool, and shares gained through the BO, CA and MH Private Companies, count toward the 60% — what matters is that they left the Initial Offering.",
      "At the end of the Stock Round in which it floats, the president receives the corporation's charter, its station tokens and its starting money: 10 × par value.",
      "A corporation's money is kept strictly separate from its president's own cash.",
    ],
    detail: [],
  },
  {
    id: "president",
    number: 4,
    title: "Change of President",
    lead: "The player with the most shares is president. Another player takes over only by exceeding the president's share total — a tie changes nothing.",
    quick: [
      "The change is immediate: the new president receives the President's Certificate and hands over two single certificates of that corporation in exchange.",
      "The charter, trains, station tokens and treasury pass to the new president.",
      "If several players exceed the president with the same total, the new president is the next of them in player order after the former president.",
      "The President's Certificate never enters the Bank Pool. A president selling down past another holder transfers the presidency first; only then do the ordinary certificates go to the pool. There must be another holder with at least 20%.",
      "A former president left over a certificate limit by the exchange must sell down — now if it is their turn, otherwise on their next Stock Round turn.",
    ],
    detail: [],
  },
  {
    id: "limits",
    number: 5,
    title: "Certificate Limits",
    lead: "Three separate limits apply.",
    quick: [
      "Overall limit: a total number of certificates per player, Private Company certificates included, set by the player count — see Tables.",
      "Individual corporation limit: normally 5 certificates in one corporation (50–60%, since the President's Certificate is 20% but counts as one).",
      "Bank Pool limit: never more than 5 certificates of one corporation in the Bank Pool, which is what caps a sale.",
      "A token in a yellow, orange or brown box relaxes the first two — see Special Stock Market Effects. A player pushed over a limit must sell down on their next Stock Round turn.",
    ],
    detail: [],
  },
  {
    id: "marketEffects",
    number: 6,
    title: "Special Stock Market Effects",
    tag: "Standing exceptions",
    lead: "Where a corporation's share-value token sits changes the limits and the buying rules for that corporation.",
    quick: [
      "Yellow, orange or brown box: its certificates do not count toward your overall certificate limit.",
      "Orange or brown box: you may hold more than the normal individual corporation limit of 5 certificates / 60%.",
      "Brown box: on your Stock Round turn you may buy any number of its Bank Pool certificates at once — this still counts as your one purchase for the turn.",
      "These follow the token's position, not anything a player does in the round.",
    ],
    detail: [],
  },
  {
    id: "movement",
    number: 7,
    title: "Share Value Movement",
    lead: "The share-value token moves for four reasons.",
    quick: [
      "Share sold: down one box per share, moved after the whole sale. At the bottom of its column it stays put.",
      "All shares owned by players at the end of a Stock Round: up one box, highest-priced corporation first. At the top of its column it stays put.",
      "Dividend declared: right one box; at the right end of a row, up one box if possible — never above $350.",
      "No dividend: left one box; at the left end of a row, down one box if possible.",
      "A token arriving in an occupied box goes to the bottom of the stack; tokens moving together keep their order.",
    ],
    notes: [
      {
        scope: "dynamicStockMarket",
        text: "This table plays the dynamic stock market: paying out 3× the share price moves the token two boxes right; withholding 2× the share price moves it two boxes left. The chart runs to $450.",
      },
    ],
    detail: [],
  },
];


/* ------------------------------------------------------------------ */
/* Props                                                               */
/* ------------------------------------------------------------------ */

export interface RulesReferenceProps {
  className?: string;
  /** Live round type from `GameStateResponse.current_round_type`; `null`/omitted renders the static
   *  reference with no CURRENT context. */
  roundType?: RulesRoundType | null;
  /** Live Operating Round cursor from `App.tsx`'s own `orSubPhase`; read only while
   *  `roundType === "OperatingRound"`. */
  operatingSubPhase?: RulesOperatingSubPhase | null;
  /** The live Stock Round action, where the caller can tell one -- `Sell` or `Buy` marks that card current.
   *  A Stock Round turn has no sub-phase cursor, so this is optional and `null` marks the round card instead. */
  stockRoundAction?: StockRoundAction | null;
  /** The round tag the ledger stamps -- `SR2`, `OR 3.1`. Display only. */
  roundLabel?: string | null;
  /** The railroad whose turn it is, for the CURRENT breadcrumb. */
  activeCorporation?: { ticker: string; fullName?: string | null } | null;
  /** The live phase, for the Overview's key-reference cards. */
  phase?: { label: string; tier: string; trainLimit: number } | null;
  /** Seats at the table, to highlight the matching Player Limits row. */
  playerCount?: number | null;
  /** The ruleset's display name, e.g. `GAME_TYPE_COPY[type].label`. Defaults to the printed game. */
  rulesetLabel?: string | null;
  /** The table's resolved variant flags (`resolveVariants(gameState.variants)`), the one source the lobby
   *  and the reducer read. Decides which scoped blocks render. Omitted: the printed game. */
  variants?: Pick<
    GameVariants,
    "expandedMap" | "levelPlayingField" | "delayedAuction" | "gentleRust" | "unpredictableRevenue" | "dynamicStockMarket" | "plusTiles"
  > | null;
  /** `GameStateResponse.private_auction_complete` -- whether the Private Company Auction has concluded.
   *  Absent on older logs and in standard games, where the auction is the opening round. */
  auctionComplete?: boolean | null;
}

/* ------------------------------------------------------------------ */
/* Sticky offset: pin the inner nav under the action dock              */
/* ------------------------------------------------------------------ */

/** The action dock (`App.tsx`, `data-sticky-dock`) is itself sticky at the top of the page and its height
 *  varies with what it holds, so the inner strip measures it rather than assuming. Zero when absent. */
function useStickyDockOffset(): number {
  const [offset, setOffset] = useState(0);
  useEffect(() => {
    const dock = document.querySelector<HTMLElement>("[data-sticky-dock]");
    if (!dock) return undefined;
    const measure = () => setOffset(dock.offsetHeight);
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(dock);
    return () => observer.disconnect();
  }, []);
  return offset;
}

/* ------------------------------------------------------------------ */
/* Small shared pieces                                                 */
/* ------------------------------------------------------------------ */

function VariantTag({ scope }: { scope?: RuleScope }) {
  const label = scope ? SCOPE_LABEL[scope] : null;
  if (!label) return null;
  return <span style={styles.variantTag}>{label}</span>;
}

function SectionHeading({ children, aside }: { children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <div style={styles.sectionHeadingRow}>
      <h3 style={styles.sectionTitle}>{children}</h3>
      {aside}
    </div>
  );
}

/** Expand all / collapse all, for the accordion pages. */
function BulkToggle({ onExpand, onCollapse }: { onExpand: () => void; onCollapse: () => void }) {
  return (
    <span style={styles.bulkToggle}>
      <button type="button" className="rr-link" style={styles.linkButton} onClick={onExpand}>
        Expand all
      </button>
      <span style={styles.bulkDivider}>·</span>
      <button type="button" className="rr-link" style={styles.linkButton} onClick={onCollapse}>
        Collapse all
      </button>
    </span>
  );
}

/** Set helpers. `forEach` into a fresh Set rather than a spread: the tsconfig targets ES5 without
 *  `downlevelIteration`, so spreading a Set is a compile error here. */
function setWith<T>(prev: ReadonlySet<T>, value: T, present: boolean): Set<T> {
  const next = new Set<T>();
  prev.forEach((entry) => next.add(entry));
  if (present) next.add(value);
  else next.delete(value);
  return next;
}
function setToggle<T>(prev: ReadonlySet<T>, value: T): Set<T> {
  return setWith(prev, value, !prev.has(value));
}
function setOf<T>(values: readonly T[]): Set<T> {
  const next = new Set<T>();
  values.forEach((value) => next.add(value));
  return next;
}

/* ------------------------------------------------------------------ */
/* CURRENT context strip                                               */
/* ------------------------------------------------------------------ */

function ContextStrip({
  roundType,
  operatingSubPhase,
  roundLabel,
  activeCorporation,
  section,
  onGoToCurrent,
}: {
  roundType: RulesRoundType | null;
  operatingSubPhase: RulesOperatingSubPhase | null;
  roundLabel: string | null;
  activeCorporation: RulesReferenceProps["activeCorporation"];
  section: RulesSection;
  onGoToCurrent: () => void;
}) {
  if (!roundType) {
    return (
      <div style={styles.contextStrip}>
        <span style={styles.contextLabelMuted}>Reference</span>
        <span style={styles.contextMuted}>No live round — showing the full reference.</span>
      </div>
    );
  }
  // `SR2` / `OR 2.1` become "Stock Round 2" / "Operating Round 2.1"; the auction has no number.
  const roundNumber = roundLabel && roundType !== "WaterfallAuction" ? roundLabel.replace(/^(SR|OR)\s*/, "") : "";
  const crumbs: string[] = [roundNumber ? `${ROUND_LABEL[roundType]} ${roundNumber}` : ROUND_LABEL[roundType]];
  if (roundType === "OperatingRound") {
    if (activeCorporation) crumbs.push(activeCorporation.ticker);
    if (operatingSubPhase) crumbs.push(SUB_PHASE_DISPLAY[operatingSubPhase]);
  }
  const livePage = sectionForRound(roundType);
  return (
    <div style={styles.contextStrip}>
      <span style={styles.contextLabel}>Current</span>
      <span style={styles.contextCrumbs}>
        {crumbs.map((crumb, index) => (
          <React.Fragment key={`${crumb}-${index}`}>
            {index > 0 && (
              <span style={styles.contextArrow} aria-hidden="true">
                →
              </span>
            )}
            <span style={index === crumbs.length - 1 ? styles.contextCrumbLast : styles.contextCrumb}>{crumb}</span>
          </React.Fragment>
        ))}
      </span>
      {section !== livePage && (
        <button type="button" className="rr-link" style={{ ...styles.linkButton, marginLeft: "auto" }} onClick={onGoToCurrent}>
          Go to current →
        </button>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* The visual system                                                   */
/* ------------------------------------------------------------------ */
/*  ==================================================================
     ONE LEVEL OF CONTAINMENT, AND THE ROUND FLOW IS THE ANCHOR
    ==================================================================
    RULED: the reference had become panels inside panels -- a card holding a card holding an accordion holding
    a panel -- and everything read at the same weight. The redesign gives each kind of information its own
    treatment and lets whitespace and type carry the hierarchy:
      ROUND FLOW      the one prominent element on a procedural page: large step chips joined by arrows, the
                      live step lit. It is the spine; everything below explains it.
      RULE SECTION    a heading, a bold lead, bullets. No border. Sections are separated by space and a
                      hairline. The live section gets a green rule down its left edge and a CURRENT pill.
      MORE            extra detail, when a section has any, behind a plain text disclosure -- indented, not
                      boxed. This is the only thing on a page that opens and closes.
      CALLOUT         a small dashed box for an exception or a variant note -- the one bordered element inside
                      a section, used sparingly so it still means something.
      LOOKUP          tables and tiles, as before.
    Nothing here changes the rule model: the same cards, nodes, scopes and open-state keys drive it. */

/** A pointer to a detailed page, rendered as the strip's own link style. */
function PageLink({ section, onNavigate, children }: { section: RulesSection; onNavigate: (section: RulesSection) => void; children: React.ReactNode }) {
  return (
    <button type="button" className="rr-link" style={styles.linkButton} onClick={() => onNavigate(section)}>
      {children} →
    </button>
  );
}

/** One step of a Round Flow. */
interface FlowStep {
  label: string;
  /** A qualifier under the label -- "any number", "normally one". */
  sub?: string;
  number?: number;
}

/** The procedural spine of a page: big chips joined by arrows, the live one lit. `aside` is the side action
 *  that is NOT a step (Buy Private Company); `branch` is an interruption drawn beneath the row (the
 *  auction's bid resolution). */
function RoundFlow({ steps, liveIndex, aside, branch, caption }: { steps: readonly FlowStep[]; liveIndex?: number; aside?: React.ReactNode; branch?: React.ReactNode; caption?: string }) {
  return (
    <div style={styles.flow}>
      <div style={styles.flowRow}>
        <div style={styles.flowSteps}>
          {steps.map((step, index) => (
            <React.Fragment key={step.label}>
              {index > 0 && (
                <span style={styles.flowArrow} aria-hidden="true">
                  →
                </span>
              )}
              <div style={{ ...styles.flowStep, ...(liveIndex === index ? styles.flowStepLive : {}) }}>
                <span style={styles.flowStepLabel}>
                  {step.number !== undefined && <span style={{ ...styles.flowStepNumber, ...(liveIndex === index ? { color: LIVE_INK } : {}) }}>{step.number}</span>}
                  {step.label}
                </span>
                {step.sub && <span style={styles.flowStepSub}>{step.sub}</span>}
              </div>
            </React.Fragment>
          ))}
        </div>
        {aside}
      </div>
      {branch}
      {caption && <p style={styles.flowCaption}>{caption}</p>}
    </div>
  );
}

/** Renders a rule body. `h` opens a new sub-block; the blocks flow into columns so a long body uses the
 *  width of a wide viewport instead of running down one narrow column. */
function RuleDocument({ nodes, columns = true }: { nodes: readonly RuleNode[]; columns?: boolean }) {
  type BodyNode = Exclude<RuleNode, { h: string }>;
  const applies = useInScope();
  const blocks: { heading: string | null; nodes: BodyNode[] }[] = [];
  nodes.filter(applies).forEach((node) => {
    if ("h" in node) {
      blocks.push({ heading: node.h, nodes: [] });
      return;
    }
    if (blocks.length === 0) blocks.push({ heading: null, nodes: [] });
    blocks[blocks.length - 1].nodes.push(node);
  });
  return (
    <div style={columns ? styles.docColumns : styles.docStack}>
      {blocks.map((block, blockIndex) => (
        <div key={`${block.heading ?? "intro"}-${blockIndex}`} style={{ ...styles.docBlock, ...(block.heading === null && columns ? styles.docBlockIntro : {}) }}>
          {block.heading !== null && <span style={styles.docHeading}>{block.heading}</span>}
          {block.nodes.map((node, index) => {
            if ("p" in node) {
              return (
                <p key={index} style={styles.prose}>
                  {node.p}
                </p>
              );
            }
            if ("ul" in node) {
              return (
                <ul key={index} style={styles.bullets}>
                  {node.ul.map((item) => (
                    <li key={item} style={styles.bullet}>
                      {item}
                    </li>
                  ))}
                </ul>
              );
            }
            if ("callout" in node) {
              return (
                <div key={index} style={styles.callout}>
                  {node.tag ? <span style={styles.calloutTag}>{node.tag}</span> : <VariantTag scope={node.scope} />}
                  <span style={styles.calloutText}>{node.callout}</span>
                </div>
              );
            }
            return <RuleTableView key={index} table={node.table} />;
          })}
        </div>
      ))}
    </div>
  );
}

function RuleTableView({ table }: { table: RuleTable }) {
  const numeric = table.numeric ?? [];
  const isNumeric = (column: number) => numeric.indexOf(column) !== -1;
  return (
    <div style={styles.tableScroll}>
      <table style={{ ...styles.table, ...styles.docTable }}>
        <thead>
          <tr>
            {table.columns.map((column, index) => (
              <th key={column} style={{ ...styles.th, ...(isNumeric(index) ? styles.thNum : {}) }}>
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row) => (
            <tr key={row.join("|")} style={styles.tr}>
              {row.map((cell, index) => (
                <td key={`${index}-${cell}`} style={{ ...styles.td, ...(index === 0 ? styles.tdStrong : {}), ...(isNumeric(index) ? styles.tdNum : {}) }}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The disclosure for a section's extra detail: a text link, not a bar. */
function MoreToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <button type="button" className="rr-link" aria-expanded={open} onClick={onToggle} style={styles.moreToggle}>
      <span style={styles.chevron} aria-hidden="true">
        {open ? "▾" : "▸"}
      </span>
      {open ? "Less" : "More detail"}
    </button>
  );
}

/** A rule section: heading, lead, bullets, notes, optional detail. No border of its own -- the live one
 *  carries a rule down its left edge. `side` marks the Buy Private Company action, which is not a step. */
function RuleSection({
  card,
  current,
  open,
  onToggle,
  anchorRef,
  side,
}: {
  card: RuleCard;
  current: boolean;
  open: boolean;
  onToggle: () => void;
  anchorRef?: React.Ref<HTMLDivElement>;
  side?: boolean;
}) {
  const applies = useInScope();
  return (
    <div ref={anchorRef} style={{ ...styles.section, ...(current ? styles.sectionCurrent : {}), ...(side ? styles.sectionSide : {}) }}>
      <div style={styles.sectionHead}>
        {card.number !== null && (
          <span style={{ ...styles.sectionNumber, ...(current ? styles.sectionNumberLive : {}) }} aria-hidden="true">
            {card.number}
          </span>
        )}
        <h4 style={styles.ruleTitle}>{card.title}</h4>
        {card.tag && <span style={styles.calloutTag}>{card.tag}</span>}
        <VariantTag scope={card.scope} />
        {card.meta && <span style={styles.sectionMeta}>{card.meta}</span>}
        {current && <span style={styles.currentPill}>← Current</span>}
      </div>
      <p style={styles.lead}>{card.lead}</p>
      <ul style={styles.bullets}>
        {card.quick.map((item) => (
          <li key={item} style={styles.bullet}>
            {item}
          </li>
        ))}
      </ul>
      {card.quickNote && <p style={styles.leadNote}>{card.quickNote}</p>}
      {(card.notes ?? []).filter(applies).map((note) => (
        <div key={note.text} style={styles.callout}>
          <VariantTag scope={note.scope} />
          <span style={styles.calloutText}>{note.text}</span>
        </div>
      ))}
      {card.detail.length > 0 && (
        <>
          <MoreToggle open={open} onToggle={onToggle} />
          {open && (
            <div style={styles.more}>
              <RuleDocument nodes={card.detail} />
            </div>
          )}
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* OVERVIEW                                                            */
/* ------------------------------------------------------------------ */

/** The Private Companies at-a-glance state: can corporations buy one now, and if not, when? Rulebook 3.0
 *  ("during phases 3 and 4"), 6.1 ("once phase 3 starts") and 3.2 (all close with the first 5-train). Under
 *  the delayed auction the privates are not in play at all until that auction concludes. */
function privateCompanyStatus(
  livePhase: string | null,
  delayed: boolean,
  auctionDone: boolean,
): { value: string; note: string; page: RulesSection } {
  const phase = livePhase ? Number(livePhase) : null;
  if (phase !== null && phase >= 5) {
    return { value: "Closed", note: "All closed when the first 5-train was bought", page: "auction" };
  }
  if (phase === 3 || phase === 4) {
    if (delayed && !auctionDone) {
      return { value: "Not yet in play", note: "The auction runs at the end of this Operating Round set", page: "auction" };
    }
    return { value: "Available now", note: "Corporations may buy in their turn · close with the first 5-train", page: "operating" };
  }
  if (phase === 1 || phase === 2) {
    return { value: "Not yet available", note: "Corporations may buy from Phase 3, the first 3-train", page: "operating" };
  }
  return { value: "Phase 3+", note: "Corporations may buy from the first 3-train until the first 5-train", page: "operating" };
}

/** A Game Flow stage. The navigation stripe is the full width of the card's foot, in the same place on every
 *  card, so the eye never hunts for the link. */
function GameStage({
  title,
  text,
  status,
  live,
  done,
  action,
  onAction,
}: {
  title: string;
  text: string;
  status?: string;
  live?: boolean;
  done?: boolean;
  action: string;
  onAction: () => void;
}) {
  return (
    <div style={{ ...styles.gameStage, ...(live ? styles.gameStageLive : {}), ...(done ? styles.gameStageDone : {}) }}>
      <div style={styles.gameStageBody}>
        <span style={styles.gameStageTitleRow}>
          <span style={styles.gameStageTitle}>{title}</span>
          {status && <span style={{ ...styles.status, ...(live ? styles.statusLive : {}) }}>{status}</span>}
        </span>
        <span style={styles.gameStageText}>{text}</span>
      </div>
      <button type="button" className="rr-stripe" style={styles.stripe} onClick={onAction}>
        {action}
      </button>
    </div>
  );
}

/** Orientation only: the game's structure at the highest level, where this game is in it, the numbers a
 *  player keeps asking for, how it ends, and the mistakes everyone makes once. The procedural detail lives on
 *  the procedural pages; this page points at them. */
function OverviewPage({
  roundType,
  phase,
  livePhase,
  playerCount,
  auctionDone,
  onNavigate,
}: {
  roundType: RulesRoundType | null;
  phase: RulesReferenceProps["phase"];
  livePhase: string | null;
  playerCount: number | null;
  auctionDone: boolean;
  onNavigate: (section: RulesSection) => void;
}) {
  const applies = useInScope();
  const delayed = applies({ scope: "delayedAuction" });
  const certLimit = playerCount ? CERT_LIMIT_BY_PLAYERS.find((row) => row.players === playerCount)?.limit : undefined;
  const phaseRow = livePhase ? PHASE_ROWS.find((row) => row.phase === livePhase) : undefined;
  const auctionLive = roundType === "WaterfallAuction";
  const orCount = phaseRow && phaseRow.operatingRounds !== "—" ? `${phaseRow.operatingRounds} OR${phaseRow.operatingRounds === "1" ? "" : "s"} this Stock Round` : null;
  const privates = privateCompanyStatus(livePhase, delayed, auctionDone);
  /* The Game End stripe jumps down this page rather than leaving it. */
  const gameEndRef = useRef<HTMLDivElement>(null);

  const glance: { label: string; value: string; note: string; page: RulesSection; text?: boolean }[] = [
    {
      label: "Current phase",
      value: phaseRow ? `Phase ${phaseRow.phase}` : "—",
      note: phaseRow
        ? phaseRow.phase === "1"
          ? "Private Company Auction"
          : `${phaseRow.begins} · ${phaseRow.operatingRounds} OR${phaseRow.operatingRounds === "1" ? "" : "s"} · ${phaseRow.trainLimit}-train limit`
        : "No live game",
      page: "tables",
    },
    { text: true, label: "Private Companies", value: privates.value, note: privates.note, page: privates.page },
    { label: "Certificate limit", value: certLimit !== undefined ? String(certLimit) : "—", note: playerCount ? `${playerCount} players, privates included` : "by player count", page: "tables" },
    { text: true, label: "Presidency", value: "Most shares", note: "must exceed; a tie changes nothing", page: "stock" },
  ];

  return (
    <div style={styles.page}>
      <div style={styles.block}>
        <SectionHeading>Game Flow</SectionHeading>
        {/* ---- Auction → [ Stock Round ⇄ Operating Round ] → Game End. The middle pair is the repeating
            loop, drawn as a track that leaves the Operating Round, runs under both cards and turns back up
            into the Stock Round. It is absolutely positioned so it costs the cards no height and every
            navigation stripe stays on the same line. ---- */}
        <div style={styles.gameFlow}>
          <GameStage
            title="Private Company Auction"
            text={delayed ? "Once, at the end of the Operating Round set in which the first 3-train is bought." : "Once, before the first Stock Round."}
            status={auctionLive ? "Now" : auctionDone ? "Done" : delayed ? "Delayed" : "First"}
            live={auctionLive}
            done={auctionDone}
            action="View Auction →"
            onAction={() => onNavigate("auction")}
          />
          <span style={styles.gameFlowArrow} aria-hidden="true">
            →
          </span>
          <div style={styles.loopGroup}>
            <div style={styles.loopRow}>
              <GameStage
                title="Stock Round"
                text="Players buy and sell corporation stock."
                live={roundType === "StockRound"}
                action="View Stock Round →"
                onAction={() => onNavigate("stock")}
              />
              <span style={styles.gameFlowArrow} aria-hidden="true">
                →
              </span>
              <GameStage
                title="Operating Round"
                text="Corporations operate."
                status={orCount ?? undefined}
                live={roundType === "OperatingRound"}
                action="View Operating Round →"
                onAction={() => onNavigate("operating")}
              />
            </div>
            <span style={styles.loopTrack} aria-hidden="true" />
            <span style={styles.loopArrow} aria-hidden="true">
              ▲
            </span>
            <span style={styles.loopLabel}>Repeat until game end</span>
          </div>
          <span style={styles.gameFlowArrow} aria-hidden="true">
            →
          </span>
          <GameStage
            title="Game End"
            text="The bank runs out of money, or a player goes bankrupt."
            action="See Game End ↓"
            onAction={() => gameEndRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })}
          />
        </div>
      </div>

      <div style={styles.block}>
        <SectionHeading>At a Glance</SectionHeading>
        <div style={styles.keyStrip}>
          {glance.map((card) => (
            <div key={card.label} style={styles.keyCard}>
              <span style={styles.keyLabel}>{card.label}</span>
              <span style={{ ...styles.keyValue, ...(card.text ? styles.keyValueText : {}) }}>{card.value}</span>
              <span style={styles.keyNote}>{card.note}</span>
              <span style={styles.keyLink}>
                <PageLink section={card.page} onNavigate={onNavigate}>{SECTION_ORDER.find((entry) => entry.id === card.page)?.label ?? card.page}</PageLink>
              </span>
            </div>
          ))}
        </div>
      </div>

      <div ref={gameEndRef} style={{ ...styles.block, scrollMarginTop: "150px" }}>
        <SectionHeading>Game End</SectionHeading>
        <div style={styles.twoUp}>
          <div style={styles.twoUpColumn}>
            <span style={styles.docHeading}>Winning</span>
            <p style={styles.prose}>
              The winner is the wealthiest player when the game ends: personal money, plus the value of every share held (shares × share value for each
              corporation), plus the face value of any Private Company still owned and still open.
            </p>
          </div>
          <div style={styles.twoUpColumn}>
            <span style={styles.docHeading}>How the game ends</span>
            <ol style={styles.endList}>
              <li style={styles.endItem}>
                <span style={styles.sectionNumber}>1</span>
                <span>
                  <strong style={styles.endTitle}>Bank break.</strong> When the bank runs out of money, the game ends the next time a Stock Round would
                  begin — so the round set in progress is played out first.
                </span>
              </li>
              <li style={styles.endItem}>
                <span style={styles.sectionNumber}>2</span>
                <span>
                  <strong style={styles.endTitle}>Player bankruptcy.</strong> If a president cannot raise enough money for a required train purchase after
                  taking every action the rules permit, that player is bankrupt and the game ends immediately.
                </span>
              </li>
            </ol>
          </div>
        </div>
      </div>

      <div style={styles.block}>
        <SectionHeading>Common Gotchas</SectionHeading>
        <ul style={styles.gotchaList}>
          {GOTCHAS.map((item) => (
            <li key={item.text} style={styles.gotchaItem}>
              <span style={styles.gotchaMark} aria-hidden="true">
                !
              </span>
              <span style={{ flex: "1 1 auto" }}>{item.text}</span>
              <span style={styles.gotchaLink}>
                <PageLink section={item.page} onNavigate={onNavigate}>{SECTION_ORDER.find((entry) => entry.id === item.page)?.label ?? item.page}</PageLink>
              </span>
            </li>
          ))}
          {/* Not a missed rule -- a consequence. Same row, different mark. */}
          <li style={styles.gotchaItem}>
            <span style={styles.awareTag}>Be aware</span>
            <span style={{ flex: "1 1 auto" }}>{BANKRUPTCY_WARNING}</span>
            <span style={styles.gotchaLink}>
              <PageLink section="operating" onNavigate={onNavigate}>Operating Round</PageLink>
            </span>
          </li>
        </ul>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* STOCK ROUND                                                         */
/* ------------------------------------------------------------------ */

type StockOpenKey = StockCard["id"] | "roundOverview";
const STOCK_OPEN_KEYS: readonly StockOpenKey[] = STOCK_CARDS.map((card) => card.id);

/** Which section is current: the one whose `cursor` matches the live Stock Round action, else -- in a live
 *  Stock Round with no distinguishable action -- the Round Flow itself. Nothing, outside a Stock Round. */
function liveStockKey(live: boolean, action: StockRoundAction | null): StockOpenKey | null {
  if (!live) return null;
  const card = action ? STOCK_CARDS.find((entry) => entry.cursor === action) : undefined;
  return card ? card.id : "roundOverview";
}

const STOCK_FLOW: readonly FlowStep[] = [
  { label: "Sell", sub: "any number" },
  { label: "Buy 1 certificate", sub: "normally one" },
  { label: "Sell", sub: "any number" },
];

function StockRoundPage({
  liveKey,
  openKeys,
  onToggle,
  onExpandAll,
  onCollapseAll,
  currentRef,
}: {
  liveKey: StockOpenKey | null;
  openKeys: ReadonlySet<StockOpenKey>;
  onToggle: (id: StockOpenKey) => void;
  onExpandAll: () => void;
  onCollapseAll: () => void;
  currentRef: React.RefObject<HTMLDivElement>;
}) {
  const flowCurrent = liveKey === "roundOverview";
  const liveIndex = liveKey === "sell" ? 0 : liveKey === "buy" ? 1 : undefined;
  return (
    <div style={styles.page}>
      <div ref={flowCurrent ? currentRef : undefined} style={styles.block}>
        <SectionHeading aside={flowCurrent ? <span style={styles.currentPill}>← Current</span> : undefined}>Round Flow</SectionHeading>
        <p style={styles.lead}>{STOCK_ROUND_OVERVIEW.lead}</p>
        <RoundFlow steps={STOCK_FLOW} liveIndex={liveIndex} caption={STOCK_ROUND_OVERVIEW.exception} />
        <ul style={styles.bullets}>
          {STOCK_ROUND_OVERVIEW.quick.map((item) => (
            <li key={item} style={styles.bullet}>
              {item}
            </li>
          ))}
        </ul>
      </div>

      <div style={styles.block}>
        <SectionHeading aside={<BulkToggle onExpand={onExpandAll} onCollapse={onCollapseAll} />}>Rules</SectionHeading>
        <div style={styles.sections}>
          {STOCK_CARDS.map((card) => {
            const current = liveKey === card.id;
            return <RuleSection key={card.id} card={{ ...card, number: null }} current={current} open={openKeys.has(card.id)} onToggle={() => onToggle(card.id)} anchorRef={current ? currentRef : undefined} />;
          })}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* OPERATING ROUND                                                     */
/* ------------------------------------------------------------------ */

type OperatingOpenKey = OperatingStep["id"] | "roundOverview";
const OPERATING_OPEN_KEYS: readonly OperatingOpenKey[] = ["roundOverview", ...OPERATING_STEPS.map((step) => step.id)];

function OperatingRoundPage({
  liveSubPhase,
  openKeys,
  onToggle,
  onExpandAll,
  onCollapseAll,
  currentRef,
}: {
  liveSubPhase: RulesOperatingSubPhase | null;
  openKeys: ReadonlySet<OperatingOpenKey>;
  onToggle: (id: OperatingOpenKey) => void;
  onExpandAll: () => void;
  onCollapseAll: () => void;
  currentRef: React.RefObject<HTMLDivElement>;
}) {
  const liveIndex = liveSubPhase ? SEQUENTIAL_STEPS.findIndex((step) => step.subPhase === liveSubPhase) : -1;
  const buyPrivate = OPERATING_STEPS.find((step) => step.number === null);
  const buyPrivateLive = buyPrivate !== undefined && liveSubPhase === buyPrivate.subPhase;
  const steps: FlowStep[] = SEQUENTIAL_STEPS.map((step) => ({ label: step.short, number: step.number ?? undefined }));
  return (
    <div style={styles.page}>
      <div style={styles.block}>
        <SectionHeading>Round Flow</SectionHeading>
        <p style={styles.lead}>{OPERATING_ROUND_OVERVIEW.lead}</p>
        <RoundFlow
          steps={steps}
          liveIndex={liveIndex >= 0 ? liveIndex : undefined}
          aside={
            <div style={{ ...styles.sideAction, ...(buyPrivateLive ? styles.sideActionLive : {}) }}>
              <span style={styles.calloutTag}>Not a step · Phase 3+</span>
              <span style={styles.sideActionTitle}>Buy Private Company</span>
              <span style={styles.sideActionText}>Any time during the corporation's turn.</span>
            </div>
          }
          caption="Each corporation's turn, in this order. Private Companies pay their owners first, then the corporations operate from highest share value to lowest."
        />
        <ul style={styles.bullets}>
          {OPERATING_ROUND_OVERVIEW.opening.map((item) => (
            <li key={item} style={styles.bullet}>
              {item}
            </li>
          ))}
        </ul>
        <MoreToggle open={openKeys.has("roundOverview")} onToggle={() => onToggle("roundOverview")} />
        {openKeys.has("roundOverview") && (
          <div style={styles.more}>
            <RuleDocument nodes={OPERATING_ROUND_OVERVIEW.detail} />
          </div>
        )}
      </div>

      <div style={styles.block}>
        <SectionHeading aside={<BulkToggle onExpand={onExpandAll} onCollapse={onCollapseAll} />}>The Corporation's Turn</SectionHeading>
        <div style={styles.sections}>
          {SEQUENTIAL_STEPS.map((step) => {
            const current = liveSubPhase === step.subPhase;
            return <RuleSection key={step.id} card={step} current={current} open={openKeys.has(step.id)} onToggle={() => onToggle(step.id)} anchorRef={current ? currentRef : undefined} />;
          })}
        </div>
      </div>

      {buyPrivate && (
        <div style={styles.block}>
          <SectionHeading>Side Action</SectionHeading>
          <div style={styles.sections}>
            <RuleSection card={buyPrivate} current={buyPrivateLive} open={openKeys.has(buyPrivate.id)} onToggle={() => onToggle(buyPrivate.id)} anchorRef={buyPrivateLive ? currentRef : undefined} side />
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* AUCTION (the Private Company Auction, and the Private Companies)    */
/* ------------------------------------------------------------------ */

type CompanyOpenKey = CompanyCard["id"];
const COMPANY_OPEN_KEYS: readonly CompanyOpenKey[] = COMPANY_CARDS.map((card) => card.id);

/** The buy-bid-turn's three choices, as the auction's Round Flow. The interruption -- bids on the lowest
 *  company being resolved before the next turn -- is drawn as a branch beneath, because it is what makes
 *  this auction different from a straight line (rulebook 1.2.2). */
const AUCTION_FLOW: readonly FlowStep[] = [
  { label: "Pass", sub: "may bid later" },
  { label: "Buy lowest", sub: "at its current price" },
  { label: "Bid", sub: "on any other, ≥ $5 over" },
];

function AuctionPage({
  auctionLive,
  openKeys,
  onToggle,
  onExpandAll,
  onCollapseAll,
  currentRef,
}: {
  auctionLive: boolean;
  openKeys: ReadonlySet<CompanyOpenKey>;
  onToggle: (id: CompanyOpenKey) => void;
  onExpandAll: () => void;
  onCollapseAll: () => void;
  currentRef: React.RefObject<HTMLDivElement>;
}) {
  const applies = useInScope();
  const auctionCard = COMPANY_CARDS.find((card) => card.id === "auction");
  const companyCards = COMPANY_CARDS.filter((card) => card.id !== "auction");
  return (
    <div style={styles.page}>
      {auctionCard && (
        <div ref={auctionLive ? currentRef : undefined} style={{ ...styles.block, ...(auctionLive ? styles.blockCurrent : {}) }}>
          <SectionHeading aside={auctionLive ? <span style={styles.currentPill}>← Current</span> : undefined}>Round Flow</SectionHeading>
          <p style={styles.lead}>{auctionCard.lead}</p>
          <RoundFlow
            steps={AUCTION_FLOW}
            caption="Each player in turn takes one buy-bid-turn, starting with the Priority Deal Card holder, until every Private Company is sold. Buying passes the Priority Deal Card to the next player."
            branch={
              <div style={styles.flowBranch}>
                <span style={styles.flowBranchMark} aria-hidden="true">
                  ↳
                </span>
                <span style={styles.flowBranchText}>
                  <strong style={styles.endTitle}>Interrupt — bids on the lowest company.</strong> When the lowest-priced unsold company has bids, the turn
                  sequence pauses: one bidder buys it at their bid; several bidders settle it among themselves. Then check the next company; only when it has no
                  bids does the sequence resume with the Priority Deal Card holder.
                </span>
              </div>
            }
          />
          {(auctionCard.notes ?? []).filter(applies).map((note) => (
            <div key={note.text} style={styles.callout}>
              <VariantTag scope={note.scope} />
              <span style={styles.calloutText}>{note.text}</span>
            </div>
          ))}
          <RuleDocument nodes={auctionCard.detail} />
        </div>
      )}

      <div style={styles.block}>
        <div style={styles.sectionHeadingRow}>
          <h3 style={styles.sectionTitle}>Private Companies</h3>
          <BulkToggle onExpand={onExpandAll} onCollapse={onCollapseAll} />
        </div>
        <p style={styles.prose}>{applies({ scope: "levelPlayingField" }) ? COMPANIES_INTRO.replace("There are six private companies.", "There are seven private companies in the Level Playing Field: the printed six and the James River & Kanawha.") : COMPANIES_INTRO}</p>
        {/* ---- At a glance. Face value and revenue come off the catalog (`PRIVATE_CATALOG_ROWS`), the rest off
            the rulebook's appendix (`PRIVATE_REFERENCE`). ---- */}
        <div style={styles.tableScroll}>
          <table style={{ ...styles.table, ...styles.tableFixed, minWidth: "640px" }}>
            <colgroup>
              <col style={{ width: "30%" }} />
              <col style={{ width: "64px" }} />
              <col style={{ width: "72px" }} />
              <col style={{ width: "84px" }} />
              <col style={{ width: "92px" }} />
              <col />
            </colgroup>
            <thead>
              <tr>
                <th style={styles.th}>Company</th>
                <th style={styles.th}>Abbr.</th>
                <th style={{ ...styles.th, ...styles.thNum }}>Price</th>
                <th style={{ ...styles.th, ...styles.thNum }}>Revenue</th>
                <th style={styles.th}>Hex</th>
                <th style={styles.th}>Special</th>
              </tr>
            </thead>
            <tbody>
              {PRIVATE_CATALOG_ROWS.map((row) => {
                if (!applies(row)) return null;
                const ref = PRIVATE_REFERENCE[row.id];
                return (
                  <tr key={row.id} style={styles.tr}>
                    <td style={{ ...styles.td, ...styles.tdStrong }}>
                      {ref?.name ?? row.acronym}
                      <VariantTag scope={row.scope} />
                    </td>
                    <td style={{ ...styles.td, ...styles.tdMono }}>{ref?.abbr ?? row.acronym}</td>
                    <td style={{ ...styles.td, ...styles.tdNum }}>${row.faceValue}</td>
                    <td style={{ ...styles.td, ...styles.tdNum }}>${row.revenue}</td>
                    <td style={{ ...styles.td, ...styles.tdMono }}>{ref?.hex ?? "—"}</td>
                    <td style={{ ...styles.td, ...styles.tdMuted }}>{ref?.special ?? row.power}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div style={styles.sections}>
          {companyCards.map((card) => (
            <RuleSection key={card.id} card={{ ...card, number: null }} current={false} open={openKeys.has(card.id)} onToggle={() => onToggle(card.id)} />
          ))}
        </div>
      </div>

      <div style={styles.block}>
        <SectionHeading>Timing Quick Reference</SectionHeading>
        <div style={styles.tableScroll}>
          <table style={{ ...styles.table, ...styles.tableFixed, minWidth: "480px" }}>
            <colgroup>
              <col style={{ width: "40%" }} />
              <col />
            </colgroup>
            <thead>
              <tr>
                <th style={styles.th}>Action / effect</th>
                <th style={styles.th}>When</th>
              </tr>
            </thead>
            <tbody>
              {COMPANY_TIMING.map(([action, when]) => (
                <tr key={action} style={styles.tr}>
                  <td style={{ ...styles.td, ...styles.tdMuted }}>{action}</td>
                  <td style={{ ...styles.td, ...styles.tdStrong }}>{when}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* TABLES                                                              */
/* ------------------------------------------------------------------ */

/** A lookup sheet: every table is open, nothing to expand. The live rows -- this table's seat count, the
 *  phase in force -- get the same green mark the live cards use, and nothing else moves. Deliberately absent:
 *  the train depot (the Buy Trains panel owns it) and the corporations (the Stocks tab owns them). */
function TablesPage({ playerCount, livePhase }: { playerCount: number | null; livePhase: string | null }) {
  const applies = useInScope();
  /* The Level Playing Field REPLACES the player-count table (seven seats, its own limits), so the player sees
     the one that applies to this table, tagged when it is the variant's. */
  const lpf = applies({ scope: "levelPlayingField" });
  const limitRows = PLAYER_LIMIT_ROWS.filter((row) => (lpf ? row.lpfLimit !== null : row.limit !== null));
  return (
    <div style={styles.page}>
      <section style={styles.block}>
        <SectionHeading aside={lpf ? <VariantTag scope="levelPlayingField" /> : undefined}>Player Limits</SectionHeading>
        <div style={styles.tableScroll}>
          <table style={{ ...styles.table, ...styles.tableFixed, minWidth: "360px", maxWidth: "560px" }}>
            <colgroup>
              <col style={{ width: "88px" }} />
              <col />
              <col />
            </colgroup>
            <thead>
              <tr>
                <th style={styles.th}>Players</th>
                <th style={{ ...styles.th, ...styles.thNum }}>Starting money</th>
                <th style={{ ...styles.th, ...styles.thNum }}>Certificate limit</th>
              </tr>
            </thead>
            <tbody>
              {limitRows.map((row) => {
                const live = row.players === playerCount;
                const cash = lpf ? row.lpfCash : row.cash;
                const limit = lpf ? row.lpfLimit : row.limit;
                return (
                  <tr key={row.players} style={{ ...styles.tr, ...(live ? styles.trLive : {}) }}>
                    <td style={{ ...styles.td, ...styles.tdStrong }}>
                      {row.players}
                      {live && <span style={styles.liveDot} aria-label="this game" />}
                    </td>
                    <td style={{ ...styles.td, ...styles.tdNum }}>{cash !== null ? `$${cash}` : "—"}</td>
                    <td style={{ ...styles.td, ...styles.tdNum, ...styles.tdStrong }}>{limit !== null ? limit : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p style={styles.footnote}>
          The certificate limit is the overall limit per player, private company certificates included. The individual corporation limit (5
          certificates) and the Bank Pool limit (5 per corporation) are separate — see Certificates &amp; shares below.
        </p>
      </section>

      <section style={styles.block}>
        <SectionHeading>Trains &amp; Phases</SectionHeading>
        <div style={styles.tableScroll}>
          <table style={{ ...styles.table, ...styles.tableFixed, minWidth: "880px" }}>
            <colgroup>
              <col style={{ width: "58px" }} />
              <col style={{ width: "170px" }} />
              <col style={{ width: "150px" }} />
              <col style={{ width: "92px" }} />
              <col style={{ width: "86px" }} />
              <col style={{ width: "88px" }} />
              <col style={{ width: "104px" }} />
              <col />
            </colgroup>
            <thead>
              <tr>
                <th style={styles.thWrap}>Phase</th>
                <th style={styles.thWrap}>Begins with</th>
                <th style={styles.thWrap}>Track tiles</th>
                <th style={{ ...styles.thWrap, ...styles.thNum }}>Train limit</th>
                <th style={{ ...styles.thWrap, ...styles.thNum }}>ORs per SR</th>
                <th style={{ ...styles.thWrap, paddingLeft: "18px" }}>Off-board</th>
                <th style={styles.thWrap}>Buy privates</th>
                <th style={styles.thWrap}>Also</th>
              </tr>
            </thead>
            <tbody>
              {PHASE_ROWS.map((row) => {
                const live = livePhase !== null && row.phase === livePhase;
                return (
                  <tr key={row.phase} style={{ ...styles.tr, ...(live ? styles.trLive : {}) }}>
                    <td style={{ ...styles.td, ...styles.tdStrong }}>
                      {row.phase}
                      {live && <span style={styles.liveDot} aria-label="current phase" />}
                    </td>
                    <td style={styles.td}>{row.begins}</td>
                    <td style={styles.td}>{row.tiles}</td>
                    <td style={{ ...styles.td, ...styles.tdNum, ...styles.tdStrong }}>{row.trainLimit}</td>
                    <td style={{ ...styles.td, ...styles.tdNum, ...styles.tdStrong }}>{row.operatingRounds}</td>
                    <td style={{ ...styles.td, paddingLeft: "18px" }}>{row.offBoard}</td>
                    <td style={styles.td}>{row.buyPrivates}</td>
                    <td style={{ ...styles.td, ...styles.tdMuted }}>{row.also || "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p style={styles.footnote}>
          A phase begins immediately after the purchase of the first train of the new type, and a new train limit applies at once — the buyer may
          have to discard. Off-board: which of a red off-board area's two revenue values to use. Train costs and what is left in the depot live on
          the Buy Trains panel.
        </p>
      </section>

      <section style={styles.block}>
        <SectionHeading>Other Reference</SectionHeading>
        <div style={styles.referenceGrid}>
          {OTHER_REFERENCE_GROUPS.map((group) => (
            <div key={group.title} style={styles.referenceGroup}>
              <span style={styles.docHeading}>{group.title}</span>
              <table style={{ ...styles.table, ...styles.tableFixed, minWidth: 0 }}>
                <colgroup>
                  <col style={{ width: "46%" }} />
                  <col />
                </colgroup>
                <tbody>
                  {group.rows.filter(applies).map((row) => (
                    <tr key={row.label} style={styles.tr}>
                      <td style={{ ...styles.td, ...styles.tdMuted }}>
                        {row.label}
                        <VariantTag scope={row.scope} />
                      </td>
                      <td style={{ ...styles.td, ...styles.tdStrong }}>{row.value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* The component                                                       */
/* ------------------------------------------------------------------ */

export function RulesReference({
  className,
  roundType: roundTypeProp,
  operatingSubPhase: operatingSubPhaseProp,
  stockRoundAction: stockRoundActionProp,
  roundLabel,
  activeCorporation,
  phase,
  playerCount,
  rulesetLabel,
  variants,
  auctionComplete,
}: RulesReferenceProps) {
  const roundType: RulesRoundType | null = roundTypeProp ?? null;
  const activeScopes = useMemo(() => activeScopesFor(variants), [variants]);
  /* Has the Private Company Auction happened? A standard game opens with it, so once any other round is live
     it is done; a delayed auction is done only when the state says so. */
  const auctionDone: boolean =
    roundType !== null && roundType !== "WaterfallAuction" && (activeScopes.has("delayedAuction") ? auctionComplete === true : true);
  const liveSubPhase: RulesOperatingSubPhase | null = roundType === "OperatingRound" ? (operatingSubPhaseProp ?? null) : null;
  const livePage = sectionForRound(roundType);
  const dockOffset = useStickyDockOffset();
  /* The rulebook's phase number for the Tables page: 1 while the auction runs, else from the train tier in
     force. The Level Playing Field's 7-train tier has no rulebook phase and marks nothing. */
  const livePhase: string | null =
    roundType === "WaterfallAuction" ? "1" : phase ? (PHASE_ROWS.find((row) => row.tier === phase.tier)?.phase ?? null) : null;

  // ---- Page selection. Lands on the live round's page, follows ROUND changes only. ----
  const [section, setSection] = useState<RulesSection>(livePage);
  const previousRoundRef = useRef<RulesRoundType | null>(roundType);
  useEffect(() => {
    if (roundType === previousRoundRef.current) return;
    previousRoundRef.current = roundType;
    if (roundType !== null) setSection(sectionForRound(roundType));
  }, [roundType]);

  // ---- Operating steps. The live step opens on mount and on every sub-phase change, additively. ----
  const liveStepId = useMemo(() => OPERATING_STEPS.find((step) => step.subPhase === liveSubPhase)?.id ?? null, [liveSubPhase]);
  const [openSteps, setOpenSteps] = useState<ReadonlySet<OperatingOpenKey>>(() =>
    liveStepId ? new Set<OperatingOpenKey>([liveStepId]) : new Set<OperatingOpenKey>(),
  );
  const previousStepRef = useRef(liveStepId);
  useEffect(() => {
    if (liveStepId === previousStepRef.current) return;
    previousStepRef.current = liveStepId;
    if (liveStepId) setOpenSteps((prev) => setWith(prev, liveStepId, true));
  }, [liveStepId]);

  // ---- Stock Round cards. The live card (or the round card) opens on mount and on every change, additively. ----
  const liveStock = liveStockKey(roundType === "StockRound", roundType === "StockRound" ? (stockRoundActionProp ?? null) : null);
  const [openStock, setOpenStock] = useState<ReadonlySet<StockOpenKey>>(() =>
    liveStock ? new Set<StockOpenKey>([liveStock]) : new Set<StockOpenKey>(),
  );
  const previousStockRef = useRef(liveStock);
  useEffect(() => {
    if (liveStock === previousStockRef.current) return;
    previousStockRef.current = liveStock;
    if (liveStock) setOpenStock((prev) => setWith(prev, liveStock, true));
  }, [liveStock]);

  // ---- Auction page cards. The auction card opens itself while the auction is live, additively, like the
  //      live step and the live Stock Round card; everything else on that page is manual. ----
  const auctionLive = roundType === "WaterfallAuction";
  const [openCompanies, setOpenCompanies] = useState<ReadonlySet<CompanyOpenKey>>(() =>
    auctionLive ? new Set<CompanyOpenKey>(["auction"]) : new Set<CompanyOpenKey>(),
  );
  const previousAuctionRef = useRef(auctionLive);
  useEffect(() => {
    if (auctionLive === previousAuctionRef.current) return;
    previousAuctionRef.current = auctionLive;
    if (auctionLive) setOpenCompanies((prev) => setWith(prev, "auction" as CompanyOpenKey, true));
  }, [auctionLive]);

  const currentStepRef = useRef<HTMLDivElement>(null);
  const goToCurrent = () => {
    setSection(livePage);
    if (liveStepId) setOpenSteps((prev) => setWith(prev, liveStepId, true));
    if (liveStock) setOpenStock((prev) => setWith(prev, liveStock, true));
    if (auctionLive) setOpenCompanies((prev) => setWith(prev, "auction" as CompanyOpenKey, true));
    // After the page switch commits, bring the live step under the pinned strip.
    window.setTimeout(() => currentStepRef.current?.scrollIntoView({ block: "start", behavior: "smooth" }), 0);
  };

  const onNavKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const index = SECTION_ORDER.findIndex((entry) => entry.id === section);
    if (event.key === "ArrowRight") setSection(SECTION_ORDER[(index + 1) % SECTION_ORDER.length].id);
    else if (event.key === "ArrowLeft") setSection(SECTION_ORDER[(index - 1 + SECTION_ORDER.length) % SECTION_ORDER.length].id);
    else return;
    event.preventDefault();
  };

  return (
    <ScopeContext.Provider value={activeScopes}>
    <div style={styles.root} className={className}>
      <style>{RULES_REFERENCE_CSS}</style>

      <div style={styles.header}>
        <h2 style={styles.pageTitle}>Rules Reference</h2>
        <span style={styles.rulesetPill}>{rulesetLabel ?? "18XX"}</span>
        {/* Design note #640: the build stamp, quiet, for bug reports. */}
        <span style={styles.buildStamp} title="Quote this in a bug report — it says which build of the interface you are running.">
          {UI_BUILD_LABEL}
        </span>
      </div>

      <div style={{ ...styles.navStrip, top: dockOffset }} role="tablist" aria-label="Rules reference pages" onKeyDown={onNavKey}>
        {SECTION_ORDER.map((entry) => {
          const active = entry.id === section;
          const live = roundType !== null && entry.id === livePage;
          return (
            <button
              key={entry.id}
              type="button"
              role="tab"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              className={active ? "rr-nav-tab rr-nav-tab-active" : "rr-nav-tab"}
              style={{ ...styles.navTab, ...(active ? styles.navTabActive : {}) }}
              onClick={() => setSection(entry.id)}
              data-testid={`rules-page-${entry.id}`}
            >
              {entry.label}
              {live && <span style={styles.navLiveDot} title="The live round is on this page" />}
            </button>
          );
        })}
      </div>

      <ContextStrip roundType={roundType} operatingSubPhase={liveSubPhase} roundLabel={roundLabel ?? null} activeCorporation={activeCorporation} section={section} onGoToCurrent={goToCurrent} />

      {section === "overview" && (
        <OverviewPage
          roundType={roundType}
          phase={phase}
          livePhase={livePhase}
          playerCount={playerCount ?? null}
          auctionDone={auctionDone}
          onNavigate={setSection}
        />
      )}
      {section === "stock" && (
        <StockRoundPage
          liveKey={liveStock}
          openKeys={openStock}
          onToggle={(id) => setOpenStock((prev) => setToggle(prev, id))}
          onExpandAll={() => setOpenStock(setOf(STOCK_OPEN_KEYS))}
          onCollapseAll={() => setOpenStock(new Set<StockOpenKey>())}
          currentRef={currentStepRef}
        />
      )}
      {section === "operating" && (
        <OperatingRoundPage
          liveSubPhase={liveSubPhase}
          openKeys={openSteps}
          onToggle={(id) => setOpenSteps((prev) => setToggle(prev, id))}
          onExpandAll={() => setOpenSteps(setOf(OPERATING_OPEN_KEYS))}
          onCollapseAll={() => setOpenSteps(new Set<OperatingOpenKey>())}
          currentRef={currentStepRef}
        />
      )}
      {section === "auction" && (
        <AuctionPage
          auctionLive={auctionLive}
          currentRef={currentStepRef}
          openKeys={openCompanies}
          onToggle={(id) => setOpenCompanies((prev) => setToggle(prev, id))}
          onExpandAll={() => setOpenCompanies(setOf(COMPANY_OPEN_KEYS))}
          onCollapseAll={() => setOpenCompanies(new Set<CompanyOpenKey>())}
        />
      )}
      {section === "tables" && <TablesPage playerCount={playerCount ?? null} livePhase={livePhase} />}
    </div>
    </ScopeContext.Provider>
  );
}

export default RulesReference;

/* ------------------------------------------------------------------ */
/* Hover / focus states -- real CSS, scoped by class                   */
/* ------------------------------------------------------------------ */

/** Inline `React.CSSProperties` cannot express `:hover` (MainTabBar.tsx #46); these are the only states that
 *  live here. Resting and active stay in `styles`. */
const RULES_REFERENCE_CSS = `
.rr-nav-tab { transition: color 120ms ease, border-color 120ms ease, background-color 120ms ease; }
.rr-nav-tab:hover { color: ${INK_TEXT}; background-color: ${INK_RAISED}; border-color: ${RULE_STRONG}; }
.rr-nav-tab:focus-visible { outline: 2px solid ${INK_TEXT_FAINT}; outline-offset: -2px; }
.rr-nav-tab-active:hover { border-color: rgba(242, 240, 235, 0.8); }
.rr-stripe { transition: background-color 120ms ease, color 120ms ease, border-color 120ms ease; }
.rr-stripe:hover { background-color: ${INK_RAISED}; color: ${INK_TEXT}; border-top-color: ${RULE_STRONG}; }
.rr-stripe:focus-visible { outline: 2px solid ${INK_TEXT_FAINT}; outline-offset: -2px; color: ${INK_TEXT}; }
.rr-link:hover { color: ${INK_TEXT}; text-decoration: underline; }
.rr-link:focus-visible { outline: 2px solid ${INK_TEXT_FAINT}; outline-offset: 2px; border-radius: ${RADIUS.control}; }
`;

/* ------------------------------------------------------------------ */
/* Inline styles                                                       */
/* ------------------------------------------------------------------ */

const LIVE_INK = "#8fe0a0";
const LIVE_FILL = "#2a3a2a";
const LIVE_EDGE = "#3f5f42";
const WARN_INK = "#fb923c";

const styles: Record<string, React.CSSProperties> = {
  root: {
    /* Design note #1117/#1118/#1257: the reference tabs paint their own viewport -- ground, edge, square top
       where the tab strip attaches, 20px inset standing in for `canvasPane`. */
    margin: "0 20px 20px",
    backgroundColor: INK_VIEWPORT,
    border: "1px solid #2a2a2a",
    borderRadius: VIEWPORT_RADIUS,
    display: "flex",
    flexDirection: "column",
    /* No top padding: the sticky strip pins flush to the scroll edge, and the header carries its own. */
    padding: "0 28px 36px",
    color: INK_TEXT,
    fontFamily: FONT_FAMILY,
    flex: 1,
    minWidth: 0,
  },

  // ---- Header ----
  header: { display: "flex", alignItems: "baseline", flexWrap: "wrap", gap: "12px", padding: "18px 0 10px" },
  pageTitle: { margin: 0, fontSize: FONT_SIZE.heading, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: INK_TEXT_DIM },
  rulesetPill: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 700,
    letterSpacing: "0.06em",
    padding: "2px 8px",
    borderRadius: RADIUS.pill,
    border: `1px solid ${RULE_STRONG}`,
    color: INK_TEXT_MUTED,
    backgroundColor: INK_PANEL,
  },
  variantTag: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 700,
    letterSpacing: "0.06em",
    padding: "1px 6px",
    marginLeft: "6px",
    borderRadius: RADIUS.pill,
    border: `1px solid ${RULE_STRONG}`,
    color: INK_TEXT_MUTED,
    backgroundColor: INK_PANEL,
    flexShrink: 0,
    verticalAlign: "middle",
  },
  buildStamp: { marginLeft: "auto", fontSize: FONT_SIZE.micro, fontFamily: FONT_FAMILY_MONO, color: INK_TEXT_DIMMEST, cursor: "help" },

  // ---- Inner nav strip, sticky ----
  navStrip: {
    position: "sticky",
    zIndex: 5,
    display: "flex",
    flexWrap: "wrap",
    gap: "4px",
    padding: "8px 0",
    margin: "0 0 12px",
    backgroundColor: INK_VIEWPORT,
    borderBottom: `1px solid ${RULE}`,
  },
  navTab: {
    display: "inline-flex",
    alignItems: "center",
    gap: "8px",
    fontSize: FONT_SIZE.control,
    fontWeight: 700,
    letterSpacing: "0.05em",
    textTransform: "uppercase",
    padding: "6px 14px",
    borderRadius: RADIUS.control,
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "transparent",
    backgroundColor: "transparent",
    color: INK_TEXT_FAINT,
    fontFamily: "inherit",
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  /* The active page is the only white-edged item in the strip -- the main tab bar's own convention. */
  navTabActive: { color: INK_TEXT, backgroundColor: INK_RAISED, borderColor: "rgba(242, 240, 235, 0.8)" },
  navLiveDot: { width: "6px", height: "6px", borderRadius: RADIUS.circle, backgroundColor: LIVE_INK, boxShadow: `0 0 0 2px ${LIVE_FILL}`, flexShrink: 0 },

  // ---- CURRENT strip ----
  contextStrip: {
    display: "flex",
    alignItems: "center",
    flexWrap: "wrap",
    gap: "10px",
    padding: "8px 14px",
    marginBottom: "22px",
    backgroundColor: INK,
    border: `1px solid ${RULE_STRONG}`,
    borderRadius: RADIUS.card,
    minHeight: "22px",
  },
  contextLabel: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 700,
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    padding: "2px 8px",
    borderRadius: RADIUS.pill,
    backgroundColor: LIVE_FILL,
    color: LIVE_INK,
    border: `1px solid ${LIVE_EDGE}`,
  },
  contextLabelMuted: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 700,
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    padding: "2px 8px",
    borderRadius: RADIUS.pill,
    backgroundColor: INK_PANEL,
    color: INK_TEXT_FAINT,
    border: `1px solid ${RULE_STRONG}`,
  },
  contextCrumbs: { display: "inline-flex", alignItems: "baseline", flexWrap: "wrap", gap: "6px", fontSize: FONT_SIZE.strong },
  contextCrumb: { color: INK_TEXT_DIM, fontWeight: 600 },
  contextCrumbLast: { color: INK_TEXT, fontWeight: 700 },
  contextArrow: { color: INK_TEXT_DIMMEST },
  contextMuted: { fontSize: FONT_SIZE.body, fontStyle: "italic", color: INK_TEXT_DIMMEST },

  // ---- Page scaffolding: whitespace and headings, not containers ----
  page: { display: "flex", flexDirection: "column", gap: "34px", minWidth: 0 },
  block: { display: "flex", flexDirection: "column", gap: "12px", minWidth: 0 },
  /* The one exception: the live auction's block gets the green rule, since its flow IS the current thing. */
  blockCurrent: { boxShadow: `inset 3px 0 0 ${LIVE_INK}`, paddingLeft: "14px", marginLeft: "-17px" },
  sectionHeadingRow: { display: "flex", alignItems: "baseline", flexWrap: "wrap", gap: "12px" },
  sectionTitle: { fontSize: FONT_SIZE.small, textTransform: "uppercase", letterSpacing: "0.1em", fontWeight: 700, color: INK_TEXT_FAINT, margin: 0 },
  bulkToggle: { marginLeft: "auto", display: "inline-flex", alignItems: "baseline", gap: "6px" },
  bulkDivider: { color: INK_TEXT_DIMMEST, fontSize: FONT_SIZE.small },
  linkButton: { background: "none", border: "none", padding: 0, fontFamily: "inherit", fontSize: FONT_SIZE.small, fontWeight: 600, color: INK_TEXT_FAINT, cursor: "pointer" },
  footnote: { margin: 0, fontSize: FONT_SIZE.small, color: INK_TEXT_DIMMEST, lineHeight: 1.5 },
  twoUp: { display: "flex", flexWrap: "wrap", gap: "28px", alignItems: "flex-start" },
  twoUpColumn: { flex: "1 1 360px", display: "flex", flexDirection: "column", gap: "8px", minWidth: 0 },

  // ---- Text ----
  lead: { margin: 0, fontSize: FONT_SIZE.strong, fontWeight: 600, color: INK_TEXT, lineHeight: 1.45, maxWidth: "88ch" },
  leadNote: { margin: 0, fontSize: FONT_SIZE.body, fontWeight: 700, color: INK_TEXT, lineHeight: 1.45 },
  prose: { margin: 0, fontSize: FONT_SIZE.body, color: INK_TEXT_DIM, lineHeight: 1.6, maxWidth: "76ch" },
  bullets: { margin: 0, padding: "0 0 0 18px", display: "flex", flexDirection: "column", gap: "5px", maxWidth: "88ch" },
  bullet: { fontSize: FONT_SIZE.body, color: INK_TEXT_DIM, lineHeight: 1.5 },
  docHeading: { fontSize: FONT_SIZE.small, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: INK_TEXT_MUTED },

  // ---- Round Flow: the spine ----
  flow: { display: "flex", flexDirection: "column", gap: "12px" },
  flowRow: { display: "flex", flexWrap: "wrap", alignItems: "stretch", gap: "14px 24px" },
  flowSteps: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: "8px", flex: "0 1 auto" },
  flowStep: {
    display: "flex",
    flexDirection: "column",
    gap: "2px",
    padding: "10px 16px",
    borderRadius: RADIUS.control,
    border: `1px solid ${RULE_STRONG}`,
    backgroundColor: INK_RAISED,
    minWidth: 0,
  },
  flowStepLive: { borderColor: LIVE_EDGE, backgroundColor: LIVE_FILL, boxShadow: `0 0 0 1px ${LIVE_EDGE}` },
  flowStepLabel: { display: "inline-flex", alignItems: "baseline", gap: "8px", fontSize: FONT_SIZE.control, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: INK_TEXT, whiteSpace: "nowrap" },
  flowStepNumber: { fontFamily: FONT_FAMILY_MONO, fontSize: FONT_SIZE.small, color: INK_TEXT_FAINT },
  flowStepSub: { fontSize: FONT_SIZE.small, color: INK_TEXT_FAINT, whiteSpace: "nowrap" },
  flowArrow: { fontSize: "22px", color: INK_TEXT_FAINT, lineHeight: 1 },
  flowCaption: { margin: 0, fontSize: FONT_SIZE.body, color: INK_TEXT_MUTED, lineHeight: 1.5, maxWidth: "88ch" },
  /* The auction's interruption, drawn beneath the row. */
  flowBranch: { display: "flex", alignItems: "flex-start", gap: "10px", padding: "0 0 0 8px" },
  flowBranchMark: { fontSize: "20px", lineHeight: 1, color: INK_TEXT_FAINT, marginTop: "-2px" },
  flowBranchText: { fontSize: FONT_SIZE.body, color: INK_TEXT_DIM, lineHeight: 1.5, maxWidth: "88ch" },
  /* Buy Private Company beside the Operating Round flow: plainly not a step. */
  sideAction: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: "3px",
    padding: "8px 14px",
    borderRadius: RADIUS.control,
    border: `1px dashed ${RULE_STRONG}`,
    alignSelf: "center",
    flex: "0 0 auto",
  },
  sideActionLive: { borderColor: LIVE_EDGE, boxShadow: `inset 3px 0 0 ${LIVE_INK}` },
  sideActionTitle: { fontSize: FONT_SIZE.control, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: INK_TEXT },
  sideActionText: { fontSize: FONT_SIZE.small, color: INK_TEXT_FAINT },

  // ---- Rule sections: hairlines and space ----
  sections: { display: "flex", flexDirection: "column" },
  section: { display: "flex", flexDirection: "column", gap: "8px", padding: "18px 0 20px", borderTop: `1px solid ${RULE}`, scrollMarginTop: "160px" },
  sectionCurrent: { boxShadow: `inset 3px 0 0 ${LIVE_INK}`, paddingLeft: "14px", marginLeft: "-17px" },
  sectionSide: { borderTop: `1px dashed ${RULE_STRONG}` },
  sectionHead: { display: "flex", alignItems: "center", flexWrap: "wrap", gap: "10px" },
  sectionNumber: {
    flex: "0 0 auto",
    width: "22px",
    height: "22px",
    borderRadius: RADIUS.circle,
    border: `1px solid ${RULE_STRONG}`,
    backgroundColor: INK_RAISED,
    color: INK_TEXT_DIM,
    fontFamily: FONT_FAMILY_MONO,
    fontSize: FONT_SIZE.small,
    fontWeight: 700,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
  },
  sectionNumberLive: { borderColor: LIVE_EDGE, backgroundColor: LIVE_FILL, color: LIVE_INK },
  ruleTitle: { margin: 0, fontSize: FONT_SIZE.heading, fontWeight: 700, color: INK_TEXT, letterSpacing: "0.01em" },
  sectionMeta: { fontFamily: FONT_FAMILY_MONO, fontSize: FONT_SIZE.small, color: INK_TEXT_FAINT },
  currentPill: {
    flexShrink: 0,
    fontSize: FONT_SIZE.micro,
    fontWeight: 700,
    letterSpacing: "0.06em",
    textTransform: "uppercase",
    padding: "2px 8px",
    borderRadius: RADIUS.pill,
    backgroundColor: LIVE_FILL,
    color: LIVE_INK,
    border: `1px solid ${LIVE_EDGE}`,
  },
  /* "More detail": a text control, and the detail it opens is indented under a hairline, not boxed. */
  moreToggle: { alignSelf: "flex-start", display: "inline-flex", alignItems: "center", gap: "6px", background: "none", border: "none", padding: "2px 0", fontFamily: "inherit", fontSize: FONT_SIZE.small, fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase", color: INK_TEXT_FAINT, cursor: "pointer" },
  chevron: { fontSize: FONT_SIZE.small, width: "10px", textAlign: "center" },
  more: { marginTop: "4px", paddingLeft: "14px", borderLeft: `2px solid ${RULE}` },
  docColumns: { columnWidth: "300px", columnGap: "28px" },
  docStack: { display: "flex", flexDirection: "column", gap: "10px" },
  docBlock: { display: "flex", flexDirection: "column", gap: "6px", minWidth: 0, breakInside: "avoid", marginBottom: "14px" },
  docBlockIntro: { columnSpan: "all" },
  docTable: { maxWidth: "520px", margin: "2px 0 4px" },

  // ---- Callouts: the one bordered thing inside a section ----
  callout: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: "6px",
    padding: "8px 12px",
    margin: "2px 0",
    borderRadius: RADIUS.control,
    border: `1px dashed ${RULE_STRONG}`,
    maxWidth: "76ch",
  },
  calloutTag: { fontSize: FONT_SIZE.micro, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", padding: "1px 7px", borderRadius: RADIUS.pill, border: `1px dashed ${RULE_STRONG}`, color: INK_TEXT_MUTED },
  calloutText: { fontSize: FONT_SIZE.body, fontWeight: 600, color: INK_TEXT, lineHeight: 1.5 },

  // ---- Overview: game flow, one row ----
  /* The bottom padding is the loop's room: the track hangs below the cards, absolutely positioned, so it
     adds no height to the row and every card stays the same height as every other. */
  gameFlow: { display: "flex", flexWrap: "nowrap", alignItems: "stretch", gap: "10px", overflowX: "auto", padding: "0 0 48px" },
  gameFlowArrow: { alignSelf: "center", flex: "0 0 auto", fontSize: "22px", color: INK_TEXT_FAINT, padding: "0 2px" },
  gameStage: {
    flex: "1 1 0",
    minWidth: "236px",
    display: "flex",
    flexDirection: "column",
    borderRadius: RADIUS.card,
    border: `1px solid ${RULE}`,
    backgroundColor: INK_PANEL,
    overflow: "hidden",
  },
  /* Grows so the stripe below it sits on the card's floor, level across all four cards. */
  gameStageBody: { flex: "1 1 auto", display: "flex", flexDirection: "column", gap: "6px", padding: "12px 14px 14px" },
  gameStageLive: { borderColor: LIVE_EDGE, boxShadow: `inset 3px 0 0 ${LIVE_INK}` },
  gameStageDone: { opacity: 0.55 },
  gameStageTitleRow: { display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: "8px", flexWrap: "wrap" },
  gameStageTitle: { fontSize: FONT_SIZE.small, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: INK_TEXT_DIM },
  gameStageText: { fontSize: FONT_SIZE.body, color: INK_TEXT_MUTED, lineHeight: 1.45 },
  /* The navigation stripe: the whole foot of the card is the target, in the same place on every card. */
  stripe: {
    display: "block",
    /* `marginTop: auto` rather than relying on the body to grow: it pins the stripe to the card's floor
       whatever the body does, so all four stripes land on one line at every width. */
    marginTop: "auto",
    width: "100%",
    padding: "8px 14px",
    background: "none",
    border: "none",
    borderTop: `1px solid ${RULE}`,
    backgroundColor: INK,
    color: "#9ec5ff",
    fontFamily: "inherit",
    fontSize: FONT_SIZE.small,
    fontWeight: 700,
    letterSpacing: "0.06em",
    textTransform: "uppercase",
    textAlign: "left",
    cursor: "pointer",
    /* One line, always: a wrapped label would push its own stripe off the line the other three share. */
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  status: { fontSize: FONT_SIZE.micro, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", padding: "1px 7px", borderRadius: RADIUS.pill, border: `1px solid ${RULE_STRONG}`, color: INK_TEXT_MUTED, whiteSpace: "nowrap" },
  statusLive: { borderColor: LIVE_EDGE, backgroundColor: LIVE_FILL, color: LIVE_INK },
  // ---- Overview: the Stock Round / Operating Round loop ----
  loopGroup: { position: "relative", flex: "2 1 0", display: "flex", minWidth: "504px" },
  loopRow: { display: "flex", flexWrap: "nowrap", alignItems: "stretch", gap: "10px", width: "100%" },
  /* A "U" leaving the Operating Round, running beneath both cards and turning back up into the Stock Round. */
  loopTrack: {
    position: "absolute",
    top: "100%",
    left: "24%",
    right: "24%",
    height: "26px",
    borderLeft: `2px solid ${RULE_STRONG}`,
    borderRight: `2px solid ${RULE_STRONG}`,
    borderBottom: `2px solid ${RULE_STRONG}`,
    borderRadius: `0 0 ${RADIUS.card} ${RADIUS.card}`,
    pointerEvents: "none",
  },
  loopArrow: { position: "absolute", top: "100%", left: "24%", transform: "translate(-50%, -70%)", fontSize: "12px", lineHeight: 1, color: INK_TEXT_MUTED, pointerEvents: "none" },
  loopLabel: {
    position: "absolute",
    top: "100%",
    left: "50%",
    transform: "translate(-50%, 18px)",
    padding: "0 10px",
    backgroundColor: INK_VIEWPORT,
    fontSize: FONT_SIZE.micro,
    fontWeight: 700,
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    color: INK_TEXT_FAINT,
    whiteSpace: "nowrap",
  },

  // ---- Overview: key reference tiles, one row ----
  keyStrip: { display: "flex", flexWrap: "nowrap", gap: "10px", overflowX: "auto", paddingBottom: "6px" },
  keyCard: { flex: "1 1 0", minWidth: "150px", display: "flex", flexDirection: "column", gap: "2px", padding: "10px 12px", borderRadius: RADIUS.card, border: `1px solid ${RULE}`, backgroundColor: INK_PANEL },
  keyLabel: { fontSize: FONT_SIZE.micro, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: INK_TEXT_FAINT },
  keyValue: { fontSize: "20px", fontWeight: 700, color: INK_TEXT, fontVariantNumeric: "tabular-nums", lineHeight: 1.2 },
  keyValueText: { fontSize: FONT_SIZE.heading },
  keyNote: { fontSize: FONT_SIZE.small, color: INK_TEXT_FAINT },
  keyLink: { marginTop: "4px", fontSize: FONT_SIZE.small },

  // ---- Overview: game end, gotchas ----
  endList: { listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: "10px" },
  endItem: { display: "flex", alignItems: "flex-start", gap: "10px", fontSize: FONT_SIZE.body, color: INK_TEXT_DIM, lineHeight: 1.55 },
  endTitle: { color: INK_TEXT, fontWeight: 700 },
  gotchaList: { listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column" },
  gotchaItem: { display: "flex", alignItems: "flex-start", gap: "10px", padding: "8px 0", borderTop: `1px solid ${RULE}`, fontSize: FONT_SIZE.body, color: INK_TEXT_DIM, lineHeight: 1.45 },
  awareTag: {
    flex: "0 0 auto",
    fontSize: FONT_SIZE.micro,
    fontWeight: 700,
    letterSpacing: "0.06em",
    textTransform: "uppercase",
    padding: "1px 7px",
    borderRadius: RADIUS.pill,
    border: `1px dashed ${INK_TEXT_FAINT}`,
    color: INK_TEXT_MUTED,
    marginTop: "1px",
  },
  gotchaLink: { flex: "0 0 auto", fontSize: FONT_SIZE.small, marginLeft: "auto", whiteSpace: "nowrap" },
  gotchaMark: {
    flex: "0 0 auto",
    width: "16px",
    height: "16px",
    borderRadius: RADIUS.circle,
    border: `1px solid ${WARN_INK}`,
    color: WARN_INK,
    fontSize: FONT_SIZE.micro,
    fontWeight: 700,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    marginTop: "1px",
  },

  // ---- Tables ----
  tdMono: { fontFamily: FONT_FAMILY_MONO, fontSize: FONT_SIZE.small, color: INK_TEXT_DIM, whiteSpace: "nowrap" },
  referenceGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: "14px 22px", alignItems: "start" },
  referenceGroup: { display: "flex", flexDirection: "column", gap: "4px", minWidth: 0 },
  tableScroll: { overflowX: "auto", width: "100%" },
  table: { borderCollapse: "collapse", fontSize: FONT_SIZE.body, width: "100%" },
  tableFixed: { tableLayout: "fixed", minWidth: "520px" },
  th: {
    textAlign: "left",
    padding: "7px 10px",
    color: INK_TEXT_FAINT,
    borderBottom: `1px solid ${RULE_STRONG}`,
    fontSize: FONT_SIZE.small,
    fontWeight: 700,
    letterSpacing: "0.04em",
    textTransform: "uppercase",
    whiteSpace: "nowrap",
  },
  thNum: { textAlign: "right" },
  tr: { borderBottom: `1px solid ${RULE}` },
  trLive: { boxShadow: `inset 3px 0 0 ${LIVE_INK}` },
  td: { padding: "8px 10px", color: INK_TEXT_DIM, verticalAlign: "top", lineHeight: 1.4 },
  tdNum: { textAlign: "right", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" },
  tdStrong: { color: INK_TEXT, fontWeight: 700 },
  tdMuted: { color: INK_TEXT_MUTED },
  liveDot: { display: "inline-block", width: "6px", height: "6px", marginLeft: "8px", verticalAlign: "middle", borderRadius: RADIUS.circle, backgroundColor: LIVE_INK },
};

/* Built from `th` after the object exists: a header allowed to wrap, aligned to the row's baseline. */
styles.thWrap = { ...styles.th, whiteSpace: "normal", verticalAlign: "bottom", lineHeight: 1.25 };
