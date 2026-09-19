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

import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { FONT_FAMILY, FONT_FAMILY_MONO, FONT_SIZE, RADIUS, VIEWPORT_RADIUS } from "../styles/typography";
import { PRIVATE_COMPANY_CATALOG, abilitySummary } from "../utils/privateCatalog";
/* Design note #1094: the one small blank hex this app draws wherever a surface has to say "this colour of
   tile" -- the era toast and the Bank Train Depot both use it, and the data strip now does too. A 40-line
   presentational component, not a piece of the Game Ledger. */
import { EraHex } from "./EraHex";
/* The tile schedule is DERIVED, not restated: `tileErasAt` is what the depot table already asks, so the
   Overview cannot come to disagree with it about when green arrives. */
import { tileErasAt, type TrainTier } from "../gameEngine/gamePhase";
/* Design note #1312: WHAT A TIER'S FIRST PURCHASE DOES is already answered, for the depot panel, by
   `firstPurchaseEffects` -- and the Gray tier the 18XX+ tile set adds to the Diesel's is added THERE, in one
   line, rather than written into the printed schedule. This page takes the difference between its two
   answers, so the base row stays the printed game and the variant clause cannot drift from the depot. */
import { firstPurchaseEffects } from "../gameEngine/depotSchedule";
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
  ROUND_ACCENT,
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
  /* #1320/#1415: THE LEVEL PLAYING FIELD ALWAYS BRINGS THE TRAY. `resolveVariants` resolves
     `plusTiles: levelPlayingField || recorded`, so a page deriving its own scope set has to say the same or
     it will deny a Gray tile the board is dealing. Exactly parallel to the `plus` line above it. */
  if (variants.plusTiles || variants.levelPlayingField) active.add("plusTiles");
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

/** ==================================================================
 *   THE STRIP NAMES THE AUCTION AND WHAT IT SELLS
 *  ==================================================================
 *  The page holds the Private Company Auction AND the companies themselves -- their abilities, their closure
 *  rules, the timing table -- and "Auction" named half of it, so a player looking up the DH's placement
 *  exception read the label and went to Tables. THE INTERNAL ID STAYS `auction`: it is a state key, not a
 *  label, and renaming it would churn every open-state key and test anchor in the file for a word nobody
 *  reads. */
/** `short` IS A SPELLING, NOT A SECOND NAME. At phone width the five full labels wrapped the strip into three
 *  rows and pushed the current round below the fold; the strip now scrolls sideways on one row and shows
 *  these instead. The accessible name stays the full label on every tab, at every width. */
const SECTION_ORDER: readonly { id: RulesSection; label: string; short: string }[] = [
  { id: "overview", label: "Overview", short: "Overview" },
  { id: "stock", label: "Stock Round", short: "Stock" },
  { id: "operating", label: "Operating Round", short: "Operating" },
  { id: "auction", label: "Auction & Privates", short: "Privates" },
  { id: "tables", label: "Tables", short: "Tables" },
];

/** The player-visible name of a page. EVERY cross-page link label is generated through this, so a link and
 *  the strip it points at physically cannot come to disagree about what a page is called. */
function sectionLabel(section: RulesSection): string {
  return SECTION_ORDER.find((entry) => entry.id === section)?.label ?? section;
}

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

/** ==================================================================
 *   FIVE ACCENTS, AND NEITHER THE TRACK COLOURS NOR THE LIVE GREEN
 *  ==================================================================
 *  The reference was one undifferentiated grey, so "which part of the game is this" had to be read off a
 *  heading every time. These are the smallest colour vocabulary that answers it: one hue per destination,
 *  spent on labels, hairlines, dots and underlines only -- never a filled card.
 *
 *  TWO COLLISIONS ARE DESIGNED AROUND RATHER THAN HOPED ABOUT.
 *  (1) 1830's TRACK PHASES ARE YELLOW / GREEN / BROWN. A round accent in any of those would read as a tile
 *      generation, on a page that also tabulates tile generations. The three round hues are therefore violet,
 *      blue and magenta, and Game End is a cool slate -- nothing in the warm-to-green band at all.
 *  (2) LIVE IS STILL GREEN, AND LIVE IS NOT A ROUND. `LIVE_INK` marks "this is happening now" everywhere in
 *      this file, and it keeps that job alone: a round accent says WHICH ROUND a thing belongs to, the green
 *      says THIS IS THE CURRENT ACTION, and the two are never the same channel on the same element. The live
 *      treatment additionally carries a word (`Now`, `Current`) and a filled chip, so it survives being read
 *      by someone who cannot use hue at all.
 *
 *  NOTHING HERE IS EVER THE ONLY CARRIER. Every accented label is a word first; every state is a word or a
 *  glyph first. Contrast on `INK_VIEWPORT`: violet 7.5:1, blue 7.3:1, magenta 6.8:1, slate 8.4:1, neutral
 *  5.3:1 -- all past AA for the small-caps text they dress. */
interface Accent {
  /** The hue as TEXT: small-caps labels, terms, links. */
  ink: string;
  /** The hue as a LINE: a 2px rule, an underline, a dot. */
  rule: string;
  /** The hue as a FAINT WASH, for the rare tinted row. Never a card fill. */
  tint: string;
}

/* Design note #1626: THE THREE ROUND HUES MOVED TO `palette.ts` and this table now spends them rather than
   owning them. They were literals here, and `MainTabBar` wanted the same three (#1627) -- at which point a
   colour that answers "which round is this" belongs to the game's token set, not to this file. The
   neutral row stays local because it is built from THIS page's ink and rule scale, which is a fact about the
   reference and not about the game. Nothing about the values changed. */
const ACCENT: Readonly<Record<"auction" | "stock" | "operating" | "end" | "neutral", Accent>> = {
  auction: ROUND_ACCENT.auction,
  stock: ROUND_ACCENT.stock,
  operating: ROUND_ACCENT.operating,
  end: ROUND_ACCENT.end,
  /* Lookup and reference material: no hue at all, which is itself the signal. */
  neutral: { ink: INK_TEXT_FAINT, rule: RULE_STRONG, tint: "rgba(138, 138, 134, 0.08)" },
};

/** The accent a page wears. Overview and Tables are lookup surfaces and wear the neutral. */
function accentForSection(section: RulesSection): Accent {
  if (section === "auction") return ACCENT.auction;
  if (section === "stock") return ACCENT.stock;
  if (section === "operating") return ACCENT.operating;
  return ACCENT.neutral;
}

/** The accent the live round wears. No live round is neutral, not an absence. */
function accentForRound(roundType: RulesRoundType | null | undefined): Accent {
  return roundType ? accentForSection(sectionForRound(roundType)) : ACCENT.neutral;
}

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
  /** Operating-page-only: exactly WHEN this action is available, window and all. `tag` stays the short form
   *  the Overview shows; this is the sentence the side action is entitled to spell out. */
  availability?: string;
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
      /* WAS "Explicit exceptions allow:", which needed the bullets in the infinitive ("...to place a tile
         on..."). The bullets now say what a corporation MAY DO, which is how a player reads a rule, so the
         stem stops governing them. */
      { p: "Explicit exceptions:" },
      {
        ul: [
          /* Rulebook 3.0, the Champlain & St. Lawrence: "A railroad owning the CL may lay a tile on the CL's
             hex (B-20)." / "This hex need not be connected to one of the railroad's stations, and it need not
             be connected to any track at all." / "This tile placement may be performed in addition to the
             railroad's normal tile placement -- on that turn only it may play two tiles."
             THE BULLET USED TO STOP AT THE FIRST CLAUSE, which left the ability reading like the NYC's and
             the Erie's: a waived connection requirement spent on the turn's one tile. It is the only
             exception on this page that buys a SECOND tile, and that is the part worth knowing. */
          "A corporation owning CSL may lay a tile on the CSL hex (B-20). The hex need not connect to one of its stations, or to any track at all, and this placement is in addition to its normal tile placement — so it may lay two tiles that turn.",
          /* Rulebook 3.0, the Delaware & Hudson: "A railroad owning the DH may lay a track tile and a station
             token on the DH's hex (F-16). The mountain costs $120 as usual, but laying the token is free."
             / "This hex need not be connected to one of the railroad's stations, and it need not be connect
             to any track at all." / "The tile laid does count as the owning railroad's one tile placement for
             his turn."
             THREE THINGS THE BULLET USED TO OMIT: the cost, the token, and -- the one that separates it from
             the CSL directly above -- that the tile is the turn's ONE placement, not a second one.
             "A YELLOW TRACK TILE", NOT "#57": 3.0 names a tile number for the NYC ("an (57) yellow tile") and
             for the Erie ("a (59) green tile") and deliberately does not for the DH, where it says only "a
             track tile". F-16 is a plain one-city hex, and 1830 has more than one legal yellow city tile for
             one, so naming 57 here would narrow a rule the rulebook leaves open.
             WHAT THE BULLET DOES NOT CARRY: 3.0 also says "If the DH does not lay a station token on the turn
             it lays the tile on its starting hex, it must follow the normal rules when placing a station."
             That is a STATION rule and it stays in step 2's station text; "on that same turn" is all this
             bullet needs to say for the exception to be bounded. */
          "A corporation owning DH may lay a yellow track tile on the DH hex (F-16) with no connection required, paying the usual $120 mountain cost, and may place a station token there for free on that same turn. The tile counts as its normal one-tile placement for the turn.",
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
    /* THE LEAD IS THE OPTIONAL PLACEMENT, because that is what this step is. "Place up to 1 station token"
       counted the mandatory first-turn home station and the optional additional one as one allowance, which
       is the conflation 6.3.1 and 6.3.2 keep apart and the Operating Round page separated. `ADDITIONAL_STATION_LEAD`
       reads this field, so the two surfaces cannot drift again. */
    lead: "Optional: place one additional station token during the Operating Turn.",
    quick: [
      /* NOT "must be placed on your first Operating Turn" as an item of step 2: the home station is placed
         BEFORE Lay Track, so it cannot be part of the optional step this list belongs to. `HOME_STATION.text`
         reads this bullet, so the Overview preview and the Operating Round page state it in one voice. */
      "At the start of its first operating turn, the corporation places its home-station token for free — before Lay Track.",
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
      /* 6.4.1: "A train may run a shorter route than the maximum allowed to reach the intended revenue or
         when a maximum route does not exist." The old sentence also restated the two-city minimum, which the
         route definition above it and `ROUTE_CITY_RULES` had already made twice. */
      { p: "A train may run a shorter route than its maximum — to reach the intended revenue, or when no maximum-length route exists." },
      { h: "Route restrictions" },
      { p: "A route must be continuous. A route:" },
      {
        ul: [
          "May not reverse at a junction.",
          "May not change track at a crossover.",
          "May not use the same section of track more than once.",
          "May not include the same city more than once.",
          "May enter a city on one track and leave on another.",
          "May use different sections of track on the same tile.",
          "May include different cities located in the same hex.",
        ],
      },
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
    /* Rulebook 3.0 -- "During phases 3 and 4, a railroad may buy a private company at any time during its
       turn in an operating round" -- and 3.2: "All private companies are closed when the first 5-train is
       bought." "Phase 3+" alone reads as "from now on", which is exactly the half of it that is wrong. */
    availability: "Phases 3 and 4 — from the first 3-train until every Private Company closes at the first 5-train.",
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
      /* Rulebook 3.0 and 3.2. The old sentence named only the opening trigger, which is what made "Phase 3+"
         read as "from now on": the window shuts, and it shuts by closing the companies themselves. */
      {
        p: "The window opens with the first 3-train purchase and shuts when the first 5-train is purchased, which closes every Private Company still in play.",
      },
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

/** ==================================================================
 *   THE ROUND IN ONE LINE, AND THE TURN UNDER IT
 *  ==================================================================
 *  Rulebook 6.0: "At the beginning of an operating round, each private company (not yet closed) operates.
 *  This consists of paying its owner the revenue indicated", and the railroads then operate "in order of
 *  share value, highest first". The page's lead used to put an arrow between the two halves, which read as
 *  another stage of the turn drawn directly beneath it. This is one sentence about the ROUND; the five
 *  stages below it are the CORPORATION'S TURN, and the two are not the same sequence. */
const OPERATING_ROUND_CADENCE =
  "Every Private Company that has not closed pays its owner, then each floated corporation operates once, in share-value order — highest first.";

/** ==================================================================
 *   THE HOME STATION IS NOT STEP 2, AND IT IS NOT FLOTATION EITHER
 *  ==================================================================
 *  Rulebook 6.1 -- "At the start of a railroad's first turn of operation, it places one of its tokens in its
 *  starting city to create its home station" -- and 6.3.1, which adds "There is no cost." 5.3, what actually
 *  happens when a corporation floats, hands the president the charter, the tokens and ten times par and says
 *  nothing about placing any of them: the placement belongs to the TURN, not to the float.
 *  AND IT IS NOT THE OPTIONAL STATION. 6.3.2's additional station is a choice, paid for, during the turn;
 *  this one is mandatory, free, and happens before the turn's first numbered step. Two rules, so two pieces
 *  of text -- this one sits beside the flow, and step 2 keeps the other. */
const HOME_STATION: { tag: string; text: string } = {
  tag: "First turn only",
  /* READ FROM THE STEP'S OWN BULLET, not written a second time. The Overview's Station Tokens preview
     renders that bullet directly, so a hand-written copy here is the drift Codex found: this page said the
     token is placed for free before Lay Track while the preview still said it "must be placed on your first
     Operating Turn", filed under the optional additional-station step. */
  text: operatingQuick("station", "At the start of its first operating turn") ?? "",
};

/** ==================================================================
 *   THE TWO HOME HEXES, IN LAY TRACK'S SUBORDINATE DETAIL
 *  ==================================================================
 *  These two exceptions used to sit directly under the home-station note beside Round Flow, where they took
 *  four lines of the opening screen to qualify a rule that applies to two of the eight corporations. They
 *  are TRACK rules -- 6.2.1 lists them among the placements that skip the connection requirement -- so they
 *  belong to Lay Track, behind that section's one disclosure.
 *  CHECKED against the rulebook: "New York Central . . . Albany E-19" and "Erie . . . Buffalo E-11";
 *  "The NYC may place an (57) yellow tile on the hex containing its home station (E-19)"; "The Erie may
 *  place a (59) green tile on the hex containing its home station (assuming green tiles are available)";
 *  "The Erie does not have to place a tile in its starting hex. Similarly, the NYC does not have to place a
 *  tile in its starting hex."; "Constructing track is optional. You are never required to place or upgrade
 *  track."; and "Using the normal rules, any railroad can place a tile on a hex listed as an exception."
 *  WHAT IT MUST NOT SAY, and does not: that either tile has to be laid on a later turn, that laying it is
 *  what establishes the home station, or that the hex is reserved. The one exception that IS an extra tile
 *  lay belongs to the CSL ("on that turn only it may play two tiles"), not to these two. */
const HOME_HEX_EXCEPTIONS: readonly string[] = [
  "Neither corporation must lay a tile on its home hex to place its home-station token.",
  "During a legal track action, NYC may place yellow tile #57 on E-19, and Erie may place green tile #59 on E-11 once green tiles are available, without meeting the normal connection requirement for that placement.",
  "These are placement exceptions, not extra track actions; placing either tile is optional.",
  "Neither hex is reserved: under the normal connection rules any corporation may place a tile there.",
];

/** 6.3.2, as the lead for step 2. The card's own lead covers both placements because the Overview quotes it
 *  in the Tokens state; this section is only the optional one, so it says only the optional one. */
/* Likewise read from the step rather than restated, so the Overview preview's lead and this page's lead are
   the same sentence by construction. */
const ADDITIONAL_STATION_LEAD = operatingStep("station")?.lead ?? "";

/** 3.0, as the lead for the side action. Not "from Phase 3 onward": the window closes. */
const BUY_PRIVATE_LEAD = "Not one of the five steps. A corporation may buy a Private Company at any point during its Operating Turn.";

/** ==================================================================
 *   WHAT "CITY" MEANS, WHERE A ROUTE MAY STOP, AND WHAT IT COUNTS (S6-10)
 *  ==================================================================
 *  The page defined "city" in one sentence inside a closed disclosure, and the only line a player could see
 *  said "A route cannot pass through a fully blocked large city or a red off-board area" -- so the word the
 *  whole section turns on was never defined where anyone would read it, and PASS THROUGH read as NOT ALLOWED
 *  AT ALL. These four are the definitions the rest of Run Routes is written against, so they are the first
 *  thing in the section, in the visible text, and not a warning box at the bottom of it.
 *    6.4 / glossary p.26  "For the purposes of running trains and choosing routes, 'city' refers to a large
 *                          city, a small city, or an off-board red hex."
 *    6.4.2                "A route may begin or end at any city. However, a route may not pass through a red
 *                          off-board area, or a large city if all of its circles contain stations belonging
 *                          to other railroads."
 *    6.4.2                "The number of cities on a route includes all of the cities that the route runs
 *                          through or to. A route may not skip a city that it runs through."
 *    6.4.1 / 6.5          the train's number "represents the maximum number of cities that the train may have
 *                          on its route"; revenue is "the sum of the revenue values of all of the cities (a
 *                          minimum of 2) on its route".
 *  "SMALL CITY", NOT "TOWN": the rulebook's board key and glossary both say small city, and the word town
 *  does not appear in it. */
const ROUTE_CITY_RULES: readonly { label: string; text: string }[] = [
  {
    label: "What counts as a city",
    text: "For routes, a city is a large city, a small city, or a red off-board area. All three count as cities wherever these rules say \u201ccity\u201d.",
  },
  {
    label: "Where a route may begin or end",
    text: "A route may begin or end at any city — including a red off-board area, and including a large city whose station circles are all occupied by other corporations.",
  },
  {
    label: "What a route may not pass through",
    text: "A route may not pass through a red off-board area, or through a large city whose station circles are all occupied by other corporations. Either may still be the route's first or last city.",
  },
  {
    label: "What the train's limit counts",
    text: "Every city the route runs through or to counts toward the train's limit and contributes its revenue value, and a route may not skip a city it runs through.",
  },
];

/** The step with this id. The page reads the content model by name rather than by position, so reordering
 *  `OPERATING_STEPS` cannot silently retitle a section. */
function operatingStep(id: OperatingStep["id"]): OperatingStep | undefined {
  return OPERATING_STEPS.find((step) => step.id === id);
}

/** The nodes before the first heading: a detail document's opening prose. */
function detailIntro(nodes: readonly RuleNode[]): readonly RuleNode[] {
  const end = nodes.findIndex((node) => "h" in node);
  return end === -1 ? nodes : nodes.slice(0, end);
}

/** The nodes under one heading, up to the next one. This is how the page takes a detail document apart into
 *  the treatments each part wants -- columns, a lookup, a marked exception -- without retyping any of it. */
function detailUnder(nodes: readonly RuleNode[], heading: string): readonly RuleNode[] {
  const start = nodes.findIndex((node) => "h" in node && node.h === heading);
  if (start === -1) return [];
  const rest = nodes.slice(start + 1);
  const end = rest.findIndex((node) => "h" in node);
  return end === -1 ? rest : rest.slice(0, end);
}

/** The text of the first callout in a run of nodes whose sentence starts with `prefix`. */
function detailCallout(nodes: readonly RuleNode[], prefix: string): string | null {
  const found = nodes.filter((node) => "callout" in node && node.callout.indexOf(prefix) === 0)[0];
  return found && "callout" in found ? found.callout : null;
}

/** The first bullet list in a run of nodes. */
function detailList(nodes: readonly RuleNode[]): readonly string[] {
  const found = nodes.filter((node) => "ul" in node)[0];
  return found && "ul" in found ? found.ul : [];
}

/** The same nodes with their tables removed, for when the table is being shown as its own lookup. */
function withoutTables(nodes: readonly RuleNode[]): readonly RuleNode[] {
  return nodes.filter((node) => !("table" in node));
}

/** The same nodes with some bullets dropped from their lists, for when those bullets have found a better
 *  home elsewhere on the page. A list left empty is dropped with them. */
function withoutItems(nodes: readonly RuleNode[], startsWith: readonly string[]): readonly RuleNode[] {
  const keep = (item: string) => !startsWith.some((prefix) => item.indexOf(prefix) === 0);
  return nodes
    .map((node) => ("ul" in node ? { ...node, ul: node.ul.filter(keep) } : node))
    .filter((node) => !("ul" in node) || node.ul.length > 0);
}

/** Semicolon-separated list items, run back together as one sentence: the card writes them as clauses under
 *  a stem ("The exchange requires:"), and a catalog row has no stem to put above them. */
function sentenceFrom(items: readonly string[]): string {
  if (items.length === 0) return "";
  const clauses = items.map((item) => item.replace(/[;.]\s*$/, "").trim());
  const joined = clauses.length === 1 ? clauses[0] : `${clauses.slice(0, -1).join("; ")}, and ${clauses[clauses.length - 1]}`;
  return `${capitalised(joined)}.`;
}

/** A list item with its leading stem removed, for when the heading above it already says the stem. */
function withoutStem(item: string, stem: string): string {
  return item.indexOf(stem) === 0 ? item.slice(stem.length) : item;
}

/** The same nodes without one paragraph, for when that paragraph has become the section's lead. */
function withoutProse(nodes: readonly RuleNode[], prefix: string): readonly RuleNode[] {
  return nodes.filter((node) => !("p" in node) || node.p.indexOf(prefix) !== 0);
}

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

/* NEITHER A COUNT NOR A PHASE. It said "There are six private companies", which the Level Playing Field's
   seventh made false, and the page patched it with a string replace at render time; and it said "beginning in
   Phase 3", which reads as "from then on" when the window in fact shuts at the first 5-train (rulebook 3.0 and
   3.2). The catalog below is the count, and the two sections under it are the timing. */
const COMPANIES_INTRO =
  "Every Private Company pays revenue to its owner while it remains open, and most carry a special ability as well. Privates start in players\u2019 hands and may later be bought by corporations. They close under the conditions below.";

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
      /* ==================================================================
          THE INTERRUPT, AS FOUR STEPS RATHER THAN THREE PARAGRAPHS
         ==================================================================
         It was a trigger sentence, then the two bidder cases, then a sentence that restated the trigger and
         the resume condition again -- "the buy-bid-turn sequence" three times in as many lines, for a rule
         whose whole shape is four moves. Every condition and consequence is still here; what has gone is the
         second and third telling of when it starts and when it ends. */
      { h: "The interrupt" },
      {
        ul: [
          "Pause — ordinary buy-bid-turns stop as soon as the lowest unsold Private Company has a bid on it.",
          "Resolve it — one bidder buys it for their bid; several bidders settle it in an auction among themselves.",
          "Check the new lowest unsold company — if that one has bids, resolve them the same way.",
          "Resume — ordinary turns restart with the Priority Deal Card holder once the lowest unsold company has no bids.",
        ],
      },
      { h: "The mini-auction" },
      { p: "When more than one player has bid, only those bidders take part:" },
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
      /* THE REVENUE TABLE IS GONE from here: it listed the printed six by hand, which the Level Playing
         Field's seventh made incomplete, and the catalog on this page already prints every company's
         revenue beside its price from `privateCatalog.ts`. */
      {
        p: "A player-owned private company pays its revenue to the player. A corporation-owned private company pays its revenue to the corporation's treasury and can provide its special ability to that corporation.",
      },
      { h: "Player-to-player sale" },
      { p: "Private companies may be sold between players for any mutually agreed price." },
      { p: "Such sales may occur at any time during the buyer's or seller's turn of a Stock Round other than the first Stock Round." },
      { h: "Corporation purchase" },
      /* Rulebook 3.0 -- "During phases 3 and 4, a railroad may buy a private company at any time during its
         turn in an operating round" -- and 3.2, which closes every private at the first 5-train. "Beginning
         in Phase 3" named only the opening trigger, so it read as "from then on". The separate sentence
         about the first 3-train said the same half again and has gone with it. */
      {
        callout: "During phases 3 and 4 — from the first 3-train until every Private Company closes at the first 5-train — a corporation may buy one at any time during its own Operating Turn.",
        tag: "Any time during the turn",
      },
      { p: "Corporations may buy private companies, but may not sell them." },
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
      "The player must hold under 60% of the NYC, and an NYC share must be free in the IPO or the Bank Pool.",
      "The exchange may happen during the owner's Stock Round turn, or between other players' or corporations' turns in either round.",
      "The exchange closes Mohawk & Hudson immediately.",
    ],
    detail: [
      { p: "A player owning Mohawk & Hudson may exchange it for one 10% share of New York Central." },
      { p: "The exchange requires:" },
      {
        ul: [
          /* Rulebook 3.0 states the eligibility as a THRESHOLD -- "provided he does not already hold 60% of
             the NYC shares" -- where the player-aid summary softens it to "provided he may hold another share
             of the NYC". The threshold is the rule; the summary is a paraphrase of it, and this is a rules
             reference. `privateCatalog.ts`'s long form already said "under 60%", so the two now agree.
             Design note #771: the piles are the IPO and the BANK POOL. 3.0 calls them "the bank or the pool",
             which names the same two -- unsold initial shares, and shares players have sold back. */
          "the player must hold under 60% of the NYC;",
          "an NYC share must be free in the IPO or the Bank Pool.",
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
          "may not be sold to a corporation;",
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

/** The seven phases, rulebook 2.0-2.7.
 *
 *  `phase` is THE NAME THE GAME PRINTS FOR IT, not an index: the rulebook's number for the first six, and
 *  `D` for the Diesel phase. That is what the badge shows -- `gamePhase.ts` builds it as
 *  `presentation.phaseNumber ?? tier` (#612/#1326) and the Diesel tier carries no override, so the badge has
 *  always read `Phase: D (Brown)` while this table read `7`.
 *
 *  `tier` is the train tier `derivePhase` reports while that phase is in force, for the live-row mark
 *  (`null` where the app cannot tell -- phase 1 is the auction, marked from the round type instead).
 *
 *  THE ORDER OF THIS LIST IS THE PROGRESSION, and `phaseIndex` reads it as one. Nothing parses the name:
 *  `Number("D")` is `NaN`, and a comparison against `NaN` is false in both directions -- which is how a
 *  rename alone would have quietly told a Diesel-phase player that their private companies were still open. */
interface PhaseRow {
  phase: string;
  tier: string | null;
  begins: string;
  /* NO `tiles` FIELD. Which colours are legal in a phase is `gamePhase.ts`'s answer -- `tileErasAt(tier,
     plusTiles)`, the same call the Overview's Tile Colors cell makes -- and a second schedule written out
     here is one 18XX+ tile set away from disagreeing with the badge. It also carries the variant for free:
     under `plusTiles` the Diesel phase adds Gray (#1312), which the hand-written column did not. */
  trainLimit: string;
  operatingRounds: string;
  offBoard: string;
  buyPrivates: string;
  also: string;
  /** Cells the delayed auction makes false. Rendered in place of the base cell, tagged, when it is on. */
  delayed?: { begins?: string; also?: string };
}

const PHASE_ROWS: readonly PhaseRow[] = [
  /* Rulebook 2.1: "Phase one starts at the beginning of the game and continues until the purchase of the
     private companies." The delayed auction falsifies both halves -- `gameVariants.ts` #905 opens the game on
     Stock Round 1 with no privates in play -- so those two cells carry a variant reading rather than a base
     claim presented as universal. */
  {
    phase: "1",
    tier: null,
    begins: "Start of the game",
    trainLimit: "—",
    operatingRounds: "—",
    offBoard: "—",
    buyPrivates: "No",
    also: "Ends when all private companies have been purchased",
    delayed: {
      begins: "Not played",
      also: "The Private Company Auction runs later — at the end of the Operating Round set in which the first 3-train is bought",
    },
  },
  {
    phase: "2",
    tier: "2",
    begins: "All private companies purchased",
    trainLimit: "4",
    operatingRounds: "1",
    offBoard: "Lesser",
    buyPrivates: "No",
    also: "",
    delayed: { begins: "Start of the game", also: "The game opens on Stock Round 1 with no Private Companies in play" },
  },
  { phase: "3", tier: "3", begins: "First 3-train", trainLimit: "4", operatingRounds: "2", offBoard: "Lesser", buyPrivates: "Yes", also: "2 ORs begin after the Stock Round that follows the first 3-train" },
  { phase: "4", tier: "4", begins: "First 4-train", trainLimit: "3", operatingRounds: "2", offBoard: "Lesser", buyPrivates: "Yes", also: "2-trains removed from play" },
  { phase: "5", tier: "5", begins: "First 5-train", trainLimit: "2", operatingRounds: "3", offBoard: "Greater", buyPrivates: "—", also: "All private companies close; 3 ORs begin after the Stock Round that follows the first 5-train" },
  { phase: "6", tier: "6", begins: "First 6-train", trainLimit: "2", operatingRounds: "3", offBoard: "Greater", buyPrivates: "—", also: "3-trains removed from play; diesels may be purchased" },
  /* `D`, NOT `7`. Two reasons, and the second is the one that matters at the table: the badge has always
     called this Phase D, and on a Level Playing Field board `7` is the name of a TRAIN that pointedly does
     NOT start a phase -- so `Phase 7 / First diesel` sat one column away from a footnote explaining that the
     7-train leaves Phase 6 in force. Two different things wearing the same digit, in the same table. */
  { phase: "D", tier: "D", begins: "First diesel", trainLimit: "2", operatingRounds: "3", offBoard: "Greater", buyPrivates: "—", also: "4-trains removed from play" },
];

/** Where a phase sits in the progression, or `-1`.
 *
 *  BY POSITION IN THE TABLE, NOT BY PARSING THE NAME. The list above is already in order -- that is what a
 *  player reads down -- so the progression is free, and it keeps working for a phase whose name is a letter.
 *  The `Number(livePhase)` this replaced worked only because every phase name happened to be a digit. */
function phaseIndex(livePhase: string | null): number {
  return livePhase === null ? -1 : PHASE_ROWS.findIndex((row) => row.phase === livePhase);
}

/** Rulebook 3.0 and 3.2, as positions rather than numbers: corporations may buy from phase 3, and every
 *  Private Company closes with the first 5-train. */
const PHASE_PRIVATES_BUYABLE = phaseIndex("3");
const PHASE_PRIVATES_CLOSED = phaseIndex("5");

/** What the expanded tile set adds to `tier`'s first purchase, or `null` when it adds nothing.
 *
 *  ==================================================================
 *   TAKEN AS A DIFFERENCE, SO THE BASE ROW IS THE PRINTED GAME
 *  ==================================================================
 *
 *  `firstPurchaseEffects(tier, false)` is 1830's schedule and `firstPurchaseEffects(tier, true)` is the same
 *  schedule with #1312's one extra Diesel effect on it. Subtracting the first from the second yields exactly
 *  what the variant contributes -- today `Unlocks Gray tiles`, on the Diesel, and nothing anywhere else.
 *
 *  WHY NOT JUST WRITE THE SENTENCE. Because then this page would hold a second opinion about which tier
 *  opens Gray, and the LPF's 7-train is precisely the case where a hand-written one goes wrong: it is a new
 *  train type, it arrives with the Diesels, and it unlocks nothing. Asked as a difference, it answers `null`
 *  without this file knowing why -- `depotSchedule.ts` has no `7` entry and #1312 keys the extra on `D`. */
function expandedTileUnlock(tier: string, plusTiles: boolean): string | null {
  if (!plusTiles) return null;
  const printed = firstPurchaseEffects(tier, false);
  const added = firstPurchaseEffects(tier, true).filter((effect) => printed.indexOf(effect) < 0);
  return added.length > 0 ? added.join("; ") : null;
}

/** Other Reference: small numbers a player forgets mid-turn, grouped. Each row carries its rulebook section. */
interface ReferenceRow extends Scoped {
  label: string;
  value: string;
}
interface ReferenceGroup {
  title: string;
  rows: readonly ReferenceRow[];
  /** EVERY GROUP HAS ONE NOW. They were one grid under a single `Other Reference` heading, so four of the five
   *  could not be linked to and none of them appeared in a directory; each is its own findable section. */
  anchor: string;
  /** The two column headings. `Trigger / Outcome` where the group IS a set of outcomes, which is the pair a
   *  player scans Game End and a forced purchase for. */
  heads: readonly [string, string];
  /** A closing line for the group, where one row was a definition rather than a lookup. */
  note?: string;
}

const OTHER_REFERENCE_GROUPS: readonly ReferenceGroup[] = [
  {
    title: "Terrain & Stations",
    anchor: "rules-reference-terrain",
    heads: ["Placement", "Cost"],
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
    title: "Certificates & Shares",
    anchor: "rules-reference-certificates",
    heads: ["Item", "Value"],
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
    anchor: "rules-reference-trains",
    heads: ["Situation", "Rule"],
    rows: [
      { label: "Train from another corporation", value: "$1 minimum, any agreed price" },
      { label: "Forced purchase with the president's money, train from another corporation", value: "Not above face value" },
      { label: "Diesel trade-in (4-, 5- or 6-train)", value: "$800 instead of $1,100" },
      { label: "Over the train limit", value: "Discard to the Bank Pool, no refund" },
    ],
  },
  {
    title: "Game End",
    /* Overview's compact Game End reference links straight here rather than restating the timing. */
    anchor: "rules-reference-game-end",
    heads: ["Trigger", "Outcome"],
    /* EVERY ROW IS NOW A COMPLETE OUTCOME. The two bank sub-cases stopped at "finish the round", which is the
       procedure and not the outcome a player is scanning this table for. Rulebook 7.1: "If the money runs out
       during an operating round, the current set of operating rounds is completed and then the game ends", and
       "If the money runs out during a stock round, the stock round is completed normally, a set of operating
       rounds is completed normally, and then the game ends." */
    rows: [
      { label: "The Bank runs out of money", value: "The game ends the next time a Stock Round would start" },
      { label: "…during an Operating Round", value: "Finish the current set of Operating Rounds, then the game ends" },
      { label: "…during a Stock Round", value: "Finish the Stock Round and one set of Operating Rounds, then the game ends" },
      { label: "A player goes bankrupt", value: "The game ends immediately" },
    ],
    /* NOT A TRIGGER, so not a row in a trigger/outcome table. Rulebook 7.2: "The winner is the wealthiest
       player at the end of the game... Personal money. The total value of shares. The face value of any owned
       private companies still in existence." */
    note: "The winner is the wealthiest player: personal cash, plus the value of their shares, plus the face value of any private companies they still own.",
  },
  {
    title: "Forced Train Purchase",
    /* The Operating Round's marked exception links straight here rather than repeating the four outcomes. */
    anchor: "rules-reference-forced-purchase",
    heads: ["Situation", "Outcome"],
    rows: [
      { label: "Corporation can afford a train", value: "Must buy the cheapest available" },
      { label: "Corporation + president can afford one", value: "Corporation spends everything; president pays the difference" },
      { label: "Still short", value: "President sells shares or private companies to raise it" },
      { label: "Cannot raise it", value: "President is bankrupt; the game ends" },
    ],
  },
];

/** The buy-bid-turn's three choices, by name. ONE LIST, TWO PAGES: the Overview renders these as chips with
 *  the arrows turned off, and the Auction page gives each of them its sentence -- so the two surfaces cannot
 *  come to call the same choice by different names. */
const AUCTION_FLOW: readonly { label: string; sub: string }[] = [
  { label: "Pass", sub: "may bid later" },
  { label: "Buy lowest", sub: "at its current price" },
  { label: "Bid", sub: "on any other, ≥ $5 over" },
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
  /** One sentence, for a surface that draws the turn's shape directly beneath it. */
  short: string;
  sequence: readonly string[];
  exception: string;
  quick: readonly string[];
} = {
  lead: "Players buy and sell stock in the public railroad corporations. Each turn is Sell → Buy → Sell, and the round continues until every player has passed consecutively.",
  short: "Players buy and sell stock in the public railroad corporations.",
  sequence: ["Sell any number", "Buy 1 certificate", "Sell any number"],
  exception:
    "The buy is normally one certificate. Exception: if a corporation's share-value token is in a brown box, any number of its Bank Pool certificates may be bought as that one purchase.",
  quick: [
    /* ==================================================================
        THE PRIORITY DEAL CARD DOES NOT MOVE DURING THE ROUND
       ==================================================================
       WAS: "After each turn, the Priority Deal passes to the next player in player order." That is two rules
       welded into one and the weld is wrong. Rulebook 5.0: the card's holder takes the first turn, "then
       proceeding clockwise, each player takes a turn or passes" -- the TURN moves, the card does not. The card
       is assigned once, at the END of the round, to the player to the left of the last player who bought or
       sold, and if nobody bought or sold it does not change hands at all. A player reading the old sentence
       would expect priority to have travelled to their neighbour after one purchase. */
    "The holder of the Priority Deal Card takes the first turn; play then proceeds clockwise.",
    "Passing does not end your Stock Round: as long as someone buys or sells after you pass, you may act again on your next turn.",
    /* "to the left of", not "after": rulebook 5.0 assigns the card to "the player to the left of the last
       player that bought or sold a certificate". The previous wording was the same claim without the
       direction, and the Stock Round page's cadence already says it this way. */
    "The round ends when every player has passed consecutively. The player to the left of the last player to buy or sell takes the Priority Deal Card for the next Stock Round; if nobody bought or sold, it stays where it is.",
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
/* Overview's state-aware selections                                   */
/* ------------------------------------------------------------------ */

/** ==================================================================
 *   SELECTED FROM THE VERIFIED CONTENT, NEVER RETYPED BESIDE IT
 *  ==================================================================
 *  Overview shows a short explanation, one small lookup and up to three reminders CHOSEN FOR THE CURRENT
 *  ACTION, and the obvious way to build that is a second hand-written list. That list is exactly how a
 *  reference comes to contradict itself: somebody fixes the wording in `GOTCHAS`, the Overview keeps the old
 *  sentence forever, and nothing fails.
 *  SO EVERY STRING BELOW IS A LOOKUP INTO AN EXISTING CONSTANT -- `GOTCHAS`, a card's `quick` bullets, a
 *  paragraph or list item inside a card's `detail`, `BANKRUPTCY_WARNING`, a table already written inside a
 *  step's `detail`, a row of `OTHER_REFERENCE_GROUPS`. A spec names a PREFIX; the resolver finds the ONE
 *  entry that matches, or nothing. Reword a source and the match stops resolving, the item drops out, and
 *  `rulesOverview.test.tsx` says which spec broke -- which is the failure worth having, because the
 *  alternative is a silent stale copy.
 *
 *  ==================================================================
 *   AND EACH FACT IS RENDERED IN EXACTLY ONE OF THE THREE REGIONS
 *  ==================================================================
 *  REPORTED, off the first screenshots: while running routes, the blocked-city restriction was in the Current
 *  Action bullets AND in Watch For; while buying trains, the train-limit schedule was a prose bullet directly
 *  above the table that lists it, and the forced purchase was on both sides of the page. A player reading two
 *  statements of one rule has to work out whether they are the same rule -- which is worse than reading it
 *  once.
 *  THE DIVISION, and it is a division of JOBS rather than of topics:
 *    CURRENT ACTION  the normal procedure and the baseline legality of the action.
 *    LOOKUP          the exact numbers, as a table.
 *    WATCH FOR       exceptions, traps, timing surprises and consequences NOT already stated on the left.
 *  `cede` is how that is enforced: each cursor names the quick-bullet prefixes the lookup or the reminders
 *  own, and the Current Action drops them before it slices. Adding a reminder without ceding its bullet is
 *  the mistake this list exists to make visible, and `rulesOverview.test.tsx` counts the duplicates. */

/** At most this many reminders, whatever the round. The wall of eleven is what this replaces. A state with
 *  fewer genuine traps than this shows fewer; padding it out is how the wall came back. */
const WATCH_LIMIT = 3;

/** The one entry of `list` that starts with `prefix`, or `null` if that is not exactly one entry. */
function onePrefixed(list: readonly string[], prefix: string): string | null {
  const found = list.filter((entry) => entry.indexOf(prefix) === 0);
  return found.length === 1 ? found[0] : null;
}

function gotchaText(prefix: string): string | null {
  return onePrefixed(GOTCHAS.map((entry) => entry.text), prefix);
}
function operatingQuick(id: OperatingStep["id"], prefix: string): string | null {
  const step = OPERATING_STEPS.find((entry) => entry.id === id);
  return step ? onePrefixed(step.quick, prefix) : null;
}
function companyQuick(id: CompanyCard["id"], prefix: string): string | null {
  const card = COMPANY_CARDS.find((entry) => entry.id === id);
  return card ? onePrefixed(card.quick, prefix) : null;
}
/** A paragraph inside a card's detail -- where the exception is written as prose rather than as a bullet. */
function detailProse(nodes: readonly RuleNode[], prefix: string): string | null {
  const texts: string[] = [];
  nodes.forEach((node) => {
    if ("p" in node) texts.push(node.p);
  });
  return onePrefixed(texts, prefix);
}
/** A list item inside a card's detail. */
function detailItem(nodes: readonly RuleNode[], prefix: string): string | null {
  const texts: string[] = [];
  nodes.forEach((node) => {
    if ("ul" in node) node.ul.forEach((item) => texts.push(item));
  });
  return onePrefixed(texts, prefix);
}
function operatingProse(id: OperatingStep["id"], prefix: string): string | null {
  const step = OPERATING_STEPS.find((entry) => entry.id === id);
  return step ? detailProse(step.detail, prefix) : null;
}
function auctionDetailItem(prefix: string): string | null {
  const card = COMPANY_CARDS.find((entry) => entry.id === "auction");
  return card ? detailItem(card.detail, prefix) : null;
}

/** A Watch For reminder. */
interface WatchItem {
  /** A small category word, so the reminder is placed without reading it. */
  label: string;
  text: string;
  /** Genuinely consequential -- money lost, a game ended. Ordinary reminders do NOT wear the orange mark. */
  warn?: boolean;
}

/** What the page knows about the live position, beyond the cursor itself. */
interface WatchContext {
  /** `true` in Stock Round 1, `false` in a later one, `null` when the round tag cannot be read. */
  firstStockRound: boolean | null;
}

interface WatchSpec {
  label: string;
  warn?: boolean;
  /** Shown only when the live position makes it true. Absent: always, for this cursor. */
  when?: (context: WatchContext) => boolean;
  from: () => string | null;
}

/** What Overview selects against: the live round, and the live sub-step where the app reports one. */
export type RulesWatchKey =
  | "auction"
  | "stock"
  | "or"
  | "or:BuyPrivate"
  | "or:Track"
  | "or:Tokens"
  | "or:Routes"
  | "or:Dividends"
  | "or:Hardware"
  | "none";

interface CursorPlan {
  /** The reminders, in priority order; the first `WATCH_LIMIT` that resolve are shown. */
  watch: readonly WatchSpec[];
  /** Quick-bullet prefixes the lookup or the reminders own in this state. The Current Action drops them. */
  cede: readonly string[];
}

/** DELIBERATELY DISJOINT BY ROUND. The reason the old wall was useless is that an auction reminder sat in
 *  front of a player buying a 6-train in Phase 6; nothing here is reachable from a round it does not apply
 *  to. */
const CURSOR_PLANS: Readonly<Record<RulesWatchKey, CursorPlan>> = {
  auction: {
    watch: [
      { label: "Turn order", from: () => gotchaText("In the auction, when the lowest-priced Private Company") },
      { label: "Bidding", from: () => companyQuick("auction", "Bid money is set aside") },
      /* NOT "Buy — purchase the unsold Private Company ...", which is the Buy chip's own caption said twice.
         The surprise about the Priority Deal Card is that a RESOLVED BID does not move it. */
      { label: "Priority deal", from: () => auctionDetailItem("The Priority Deal Card does not change hands") },
    ],
    cede: [],
  },
  stock: {
    watch: [
      /* Only in the round it is about. Shown in Stock Round 5 it is not a reminder, it is a wrong statement
         about the round the player is in. */
      {
        label: "First round",
        when: (context) => context.firstStockRound === true,
        from: () => gotchaText("No certificates may be sold in the first Stock Round"),
      },
      { label: "Selling", from: () => gotchaText("Sell a corporation's certificates and you may not buy") },
      { label: "Presidency", from: () => gotchaText("The President's Certificate is never sold into the Bank Pool") },
    ],
    cede: [
      "No certificates may be sold in the first",
      "Once you sell a corporation's certificates",
      "The President's Certificate is never sold",
      "You cannot buy a corporation's stock if you sold",
    ],
  },
  "or:Track": {
    watch: [
      { label: "Privates on the map", from: () => gotchaText("A hex holding a Private Company a player still owns") },
      { label: "Labelled hexes", from: () => operatingProse("track", "For labeled yellow-hex locations") },
      { label: "Cities", from: () => operatingProse("track", "The tile and hex must have") },
    ],
    /* The tile/phase table below the explanation says this exactly, with the phases. */
    cede: ["Tile color and phase restrictions apply"],
  },
  "or:Tokens": {
    watch: [
      { label: "Blocking", from: () => operatingQuick("station", "You cannot block an unoperated corporation") },
      { label: "Blocked cities", from: () => operatingProse("station", "However, an outside corporation") },
    ],
    /* The cost table says the first in figures; the blocking rule is the reminder beside it. And the home
       station is now a labelled note BESIDE THE TURN FLOW, exactly as on the Operating Round page -- which is
       what `cede` is for: "a bullet is dropped because something else on the screen says it". Leaving it here
       as well would file a mandatory, free, pre-Lay-Track placement under the optional paid one a second
       time. Step 2's preview is now about additional stations only. */
    cede: ["At the start of its first operating turn", "Home station: free.", "You cannot block an unoperated corporation"],
  },
  "or:Routes": {
    watch: [
      { label: "Blocked cities", from: () => operatingQuick("routes", "A route cannot pass through") },
      { label: "Two trains", from: () => operatingQuick("routes", "Multiple trains may meet or cross at cities") },
      { label: "New trains", from: () => gotchaText("Trains are bought at the end of the turn") },
    ],
    cede: ["A route cannot pass through", "Multiple trains may meet", "A newly purchased train cannot run"],
  },
  "or:Dividends": {
    watch: [
      { label: "Treasury", from: () => gotchaText("Withheld revenue, dividends on Bank Pool shares") },
      { label: "Payout", from: () => operatingQuick("revenue", "Unsold shares receive no dividend") },
      { label: "Withhold", from: () => operatingQuick("revenue", "A corporation with no revenue cannot declare") },
    ],
    cede: [
      "Bank Pool shares receive their dividend",
      "Unsold shares receive no dividend",
      "A corporation with no revenue cannot declare",
    ],
  },
  "or:Hardware": {
    watch: [
      /* THE CONSEQUENCE, NOT THE PREMISE. The gotcha used here first says trains are bought at the end of the
         turn, which is the step's own lead sentence six inches to the left; this bullet says only the part
         the lead does not -- that the train just bought cannot run. */
      { label: "New trains", from: () => operatingQuick("routes", "A newly purchased train cannot run") },
      { label: "Forced purchase", warn: true, from: () => gotchaText("A corporation with a legal route but no train must buy") },
      { label: "Bankruptcy", warn: true, from: () => BANKRUPTCY_WARNING },
    ],
    /* The train-limit schedule is the table directly below; the forced purchase is the reminder beside it. */
    cede: ["Train limit:", "A corporation with a legal route but no train"],
  },
  "or:BuyPrivate": {
    watch: [
      { label: "Price", from: () => operatingQuick("buyPrivate", "Price must be between") },
      { label: "One way", from: () => operatingQuick("buyPrivate", "A corporation may buy Private Companies but may not sell") },
      { label: "Closure", from: () => companyQuick("closure", "All private companies close when the first 5-train") },
    ],
    cede: ["Price must be between", "A corporation may buy Private Companies but may not sell"],
  },
  or: {
    watch: [
      { label: "Side action", from: () => gotchaText("Buy Private Company is not a sixth operating step") },
      { label: "New trains", from: () => gotchaText("Trains are bought at the end of the turn") },
      { label: "Treasury", from: () => gotchaText("Withheld revenue, dividends on Bank Pool shares") },
    ],
    cede: [],
  },
  /* NO LIVE ROUND, NO REMINDERS. Three rules picked out of ten for a player who is not in a round are not
     contextual, they are arbitrary -- and shown under a heading that means "here, now", they read as if they
     were current. The page shows the orientation instead. */
  none: { watch: [], cede: [] },
};

function watchKeyFor(roundType: RulesRoundType | null, subPhase: RulesOperatingSubPhase | null): RulesWatchKey {
  if (roundType === "WaterfallAuction") return "auction";
  if (roundType === "StockRound") return "stock";
  if (roundType === "OperatingRound") return subPhase ? (("or:" + subPhase) as RulesWatchKey) : "or";
  return "none";
}

/** `SR2` -> not the first; `SR1` -> the first; anything this cannot read -> `null`, and the round-one
 *  reminder is omitted rather than guessed at. */
function firstStockRoundFrom(roundType: RulesRoundType | null, roundLabel: string | null): boolean | null {
  if (roundType !== "StockRound") return null;
  const match = roundLabel ? /^SR\s*(\d+)\b/.exec(roundLabel) : null;
  return match ? Number(match[1]) === 1 : null;
}

/** The quick bullets a cursor's Current Action may show: its own, less whatever the lookup or the reminders
 *  are already saying on the same screen. */
function currentActionBullets(key: RulesWatchKey, quick: readonly string[], limit = 4): readonly string[] {
  const ceded = CURSOR_PLANS[key]?.cede ?? [];
  return quick.filter((bullet) => !ceded.some((prefix) => bullet.indexOf(prefix) === 0)).slice(0, limit);
}

/** The reminders for a cursor: at most `WATCH_LIMIT`, only the ones the live position makes true, and only
 *  the ones whose source still resolves. */
export function watchItemsFor(key: RulesWatchKey, context: WatchContext = { firstStockRound: null }): readonly WatchItem[] {
  const specs = CURSOR_PLANS[key]?.watch ?? [];
  const out: WatchItem[] = [];
  specs.forEach((spec) => {
    if (spec.when && !spec.when(context)) return;
    const text = spec.from();
    if (text !== null && out.length < WATCH_LIMIT) out.push({ label: spec.label, text, warn: spec.warn });
  });
  return out;
}

/* ------------------------------------------------------------------ */
/* The one compact lookup                                              */
/* ------------------------------------------------------------------ */

/** ONE small table, chosen for the current action, and never a big one reproduced because it exists. Each is
 *  a table this file already writes somewhere else -- inside a step's `detail`, or a row of
 *  `OTHER_REFERENCE_GROUPS` -- found by its first column or its label rather than copied. */
interface LookupExcerpt {
  title: string;
  table: RuleTable;
  page: RulesSection;
  /** Where that page has an id worth landing on. */
  anchor?: string;
}

function detailTable(nodes: readonly RuleNode[], firstColumn: string): RuleTable | null {
  const found = nodes.find((node) => "table" in node && node.table.columns[0] === firstColumn);
  return found !== undefined && "table" in found ? found.table : null;
}
function stepTable(id: OperatingStep["id"], firstColumn: string): RuleTable | null {
  const step = OPERATING_STEPS.find((entry) => entry.id === id);
  return step ? detailTable(step.detail, firstColumn) : null;
}

/** `"Dividend declared: right one box; ..."` becomes a label and a value, rather than being retyped as two. */
function splitLabelled(text: string): readonly [string, string] {
  const at = text.indexOf(": ");
  return at === -1 ? ["", text] : [text.slice(0, at), text.slice(at + 2)];
}

/** The privates as price and revenue only -- the two numbers a bidder or a buying corporation needs. */
function privatePriceTable(applies: (item: Scoped) => boolean): RuleTable {
  return {
    columns: ["Company", "Price", "Revenue"],
    rows: PRIVATE_CATALOG_ROWS.filter(applies).map((row) => [
      PRIVATE_REFERENCE[row.id]?.abbr ?? row.acronym,
      "$" + row.faceValue,
      "$" + row.revenue,
    ]),
    numeric: [1, 2],
  };
}

export function lookupFor(key: RulesWatchKey, applies: (item: Scoped) => boolean): LookupExcerpt | null {
  const table = (title: string, found: RuleTable | null, page: RulesSection, anchor?: string): LookupExcerpt | null =>
    found ? { title, table: found, page, anchor } : null;
  switch (key) {
    case "auction":
      return { title: "Privates by price", table: privatePriceTable(applies), page: "auction" };
    case "stock": {
      /* FOUND BY ANCHOR, NOT BY TITLE. A title is display copy -- the Tables redesign title-cased it and this
         lookup silently returned null, which on the Overview is a lookup that simply stops appearing. The
         anchor is the group's identity and the thing other pages already link to. */
      const group = OTHER_REFERENCE_GROUPS.find((entry) => entry.anchor === "rules-reference-certificates");
      const wanted = ["Par values", "Individual corporation limit", "Bank Pool limit"];
      const rows = (group?.rows ?? [])
        .filter(applies)
        .filter((row) => wanted.indexOf(row.label) !== -1)
        .map((row) => [row.label, row.value] as readonly string[]);
      return rows.length > 0 ? { title: "Stock limits", table: { columns: ["Limit", "Value"], rows }, page: "tables" } : null;
    }
    case "or:Track":
      return table("Tiles by phase", stepTable("track", "Tile"), "operating", "rules-section-track");
    case "or:Tokens":
      return table("Station costs", stepTable("station", "Station"), "operating", "rules-section-station");
    case "or:Routes":
      return table("Train range", stepTable("routes", "Train"), "operating", "rules-section-routes");
    case "or:Dividends": {
      const movement = STOCK_CARDS.find((entry) => entry.id === "movement");
      const rows = ["Dividend declared", "No dividend"]
        .map((prefix) => (movement ? onePrefixed(movement.quick, prefix) : null))
        .filter((text): text is string => text !== null)
        .map((text) => splitLabelled(text) as readonly string[]);
      return rows.length > 0
        ? { title: "Share value moves", table: { columns: ["Result", "Token"], rows }, page: "stock", anchor: "rules-section-movement" }
        : null;
    }
    case "or:Hardware":
      return table("Train limit", stepTable("buyTrains", "Phase"), "operating", "rules-section-buyTrains");
    case "or:BuyPrivate":
      return { title: "Privates by price", table: privatePriceTable(applies), page: "auction" };
    /* A live Operating Round with no sub-step reported, and a game with no live round, both get nothing:
       there is no ONE table that helps, and a table shown because it exists is the habit being removed. */
    default:
      return null;
  }
}

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
      <div className="rr-context" style={styles.contextStrip}>
        <span style={styles.contextLabelMuted}>Reference</span>
        <span style={styles.contextMuted}>No live round — showing the full reference.</span>
      </div>
    );
  }
  // `SR2` / `OR 2.1` become "Stock Round 2" / "Operating Round 2.1"; the auction has no number.
  const roundNumber = roundLabel && roundType !== "WaterfallAuction" ? roundLabel.replace(/^(SR|OR)\s*/, "") : "";
  const crumbs: string[] = [roundNumber ? `${ROUND_LABEL[roundType]} ${roundNumber}` : ROUND_LABEL[roundType]];
  if (roundType === "OperatingRound") {
    /* NOT `if (activeCorporation)`. A caller holding the object but no ticker yet -- an empty string, or the
       field absent on an older payload -- pushed an empty crumb, and the strip rendered
       `Operating Round 2.1 → → Run Routes`: two separators around nothing. The crumb IS the ticker, so the
       ticker is what decides whether there is a crumb. */
    const ticker = activeCorporation && typeof activeCorporation.ticker === "string" ? activeCorporation.ticker.trim() : "";
    if (ticker) crumbs.push(ticker);
    if (operatingSubPhase) crumbs.push(SUB_PHASE_DISPLAY[operatingSubPhase]);
  }
  const livePage = sectionForRound(roundType);
  /* TWO SIGNALS, TWO MEANINGS. The green pill says THIS IS LIVE; the round's own accent says WHICH ROUND it
     is. They sit side by side and never stand in for one another. */
  const accent = accentForRound(roundType);
  return (
    <div className="rr-context" style={{ ...styles.contextStrip, boxShadow: `inset 3px 0 0 ${accent.rule}` }}>
      <span style={styles.contextLabel}>Current</span>
      <span className="rr-crumbs" style={styles.contextCrumbs}>
        {crumbs.map((crumb, index) => (
          <React.Fragment key={`${crumb}-${index}`}>
            {index > 0 && (
              <span style={styles.contextArrow} aria-hidden="true">
                →
              </span>
            )}
            <span style={index === 0 ? { ...styles.contextCrumb, color: accent.ink, fontWeight: 700 } : index === crumbs.length - 1 ? styles.contextCrumbLast : styles.contextCrumb}>
              {crumb}
            </span>
          </React.Fragment>
        ))}
      </span>
      {section !== livePage && (
        <button type="button" className="rr-link" style={{ ...styles.linkButton, marginLeft: "auto" }} onClick={onGoToCurrent} data-testid="rules-open-current">
          Open current rules →
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

/* ------------------------------------------------------------------ */
/* OVERVIEW                                                            */
/* ------------------------------------------------------------------ */

/** What the Private Companies are doing right now. FOUR DISTINCT STATES, not one axis of availability:
 *  being auctioned, owned by players and not yet buyable by corporations, buyable by corporations, closed.
 *  The first pass collapsed the first two into "Not yet available -- From Phase 3", which is a true sentence
 *  about corporations printed over the top of a live auction in which the players are buying the companies.
 *  `buyable` answers the Operating Round's own question -- may a corporation buy one on this turn -- so the
 *  strip and the round flow cannot disagree about it. */
interface PrivateStatus {
  value: string;
  short: string;
  buyable: boolean;
}

/** Rulebook 3.0 ("during phases 3 and 4"), 6.1 ("once phase 3 starts") and 3.2 (all close with the first
 *  5-train). Under the delayed auction the companies are not in play at all until that auction concludes.
 *  Wording only -- the timing this reports is unchanged. */
function privateCompanyStatus(
  livePhase: string | null,
  delayed: boolean,
  auctionDone: boolean,
  auctionLive: boolean,
): PrivateStatus {
  /* BY POSITION, NOT BY NUMBER -- see `phaseIndex`. `-1` is "we do not know which phase this is", and it
     falls through every comparison below to the same unknowing answer the numeric version gave. */
  const at = phaseIndex(livePhase);
  /* Being sold, right now, by the players -- whichever auction this table plays. */
  if (auctionLive) return { value: "Being auctioned", short: "Players purchase them now", buyable: false };
  if (at >= PHASE_PRIVATES_CLOSED) return { value: "Closed", short: "With the first 5-train", buyable: false };
  if (delayed && !auctionDone) return { value: "Not yet in play", short: "Delayed Auction pending", buyable: false };
  if (at >= PHASE_PRIVATES_BUYABLE) return { value: "Corporations may buy", short: "Until the first 5-train", buyable: true };
  if (at >= 0) return { value: "Player-owned", short: "Corporations may buy from Phase 3", buyable: false };
  return { value: "Phase 3+", short: "First 3-train → first 5-train", buyable: false };
}

/* ==================================================================
    OVERVIEW IS A DASHBOARD, AND THE CARDS WERE THE PROBLEM
   ==================================================================
   IT OPENED ON FOUR EQUALLY WEIGHTED GAME FLOW CARDS, then four At a Glance cards each carrying its own
   navigation stripe, then a two-column Game End essay, then an eleven-row wall of orange exclamation marks.
   Every one of those was a rounded, bordered, thickly padded panel, so nothing on the page was anything in
   particular -- and the one question a player actually has mid-turn, WHAT AM I DOING RIGHT NOW, was not on
   the page at all. It was three clicks away on a detailed page.

   SO THE ORDER IS THE ANSWER TO THAT QUESTION, and the containers are gone:
     GAME FLOW     two hairlined rows, collapsed by default while a round is live. Orientation is a thing you
                   need once -- so with NO live round it opens instead, because orientation is then all there
                   is to give.
     AT A GLANCE   one data strip. Five scan targets, hairline-separated, ONE link to the full tables.
     CURRENT ROUND the page's centre: the round, its whole action sequence, the live action lit, and a short
                   explanation of that action underneath -- with, beside it, at most three reminders that
                   apply to THIS action and one small lookup that helps with it. Each fact in exactly one of
                   the three (see `CURSOR_PLANS`).
     GAME END      three lines, not a section.
   NOTHING HERE IS A CARD. Rounded bordered surfaces are spent on the action chips alone, which are the one
   interactive thing on the page; everything else is type, hairlines, columns and the accents. */

/** A label that shortens rather than wrapping. Both spellings are in the DOM and CSS picks one, so the
 *  control's accessible name comes from an `aria-label` on the control itself -- `display: none` takes the
 *  hidden spelling out of the accessibility tree, and a button whose only visible text is `Privates` must
 *  still be announced as `Auction & Privates`. */
function Responsive({ full, short }: { full: string; short: string }) {
  return (
    <>
      <span className="rr-wide">{full}</span>
      <span className="rr-narrow">{short}</span>
    </>
  );
}

/** One stage in the Game Flow chain. State is a WORD or a GLYPH first and a colour second: `Now` rides the
 *  live chip, a completed stage is ticked AND dimmed, and the accent only says which destination it is. */
function ChainStage({
  accent,
  label,
  short,
  state,
  done,
  live,
  onNavigate,
}: {
  accent: Accent;
  label: string;
  short: string;
  state?: string;
  done?: boolean;
  live?: boolean;
  onNavigate?: () => void;
}) {
  const body = (
    <>
      <span style={{ ...styles.chainName, ...(done ? styles.chainNameDone : { color: accent.ink }) }}>
        <Responsive full={label} short={short} />
      </span>
      {done && (
        <span style={styles.chainTick} role="img" aria-label="completed">
          ✓
        </span>
      )}
      {state && <span style={live ? styles.chainStateLive : styles.chainState}>{state}</span>}
    </>
  );
  if (!onNavigate) return <span style={styles.chainItem}>{body}</span>;
  return (
    <button type="button" className="rr-link" style={styles.chainItem} aria-label={label} onClick={onNavigate}>
      {body}
    </button>
  );
}

/** HOW THE GAME PROGRESSES, as a heading row and a flow row. The `⇄` carries the repetition on its own; the
 *  first pass also spelled it out in words, which made the line long enough to wrap and then floated the word
 *  `REPEAT` between two unrelated wrapped lines at phone width. */
function GameFlowDisclosure({
  roundType,
  auctionDone,
  delayed,
  orPerStockRound,
  open,
  onToggle,
  onNavigate,
}: {
  roundType: RulesRoundType | null;
  auctionDone: boolean;
  delayed: boolean;
  orPerStockRound: string | null;
  open: boolean;
  onToggle: () => void;
  onNavigate: (section: RulesSection) => void;
}) {
  const auctionLive = roundType === "WaterfallAuction";
  const auctionState = auctionLive ? "Now" : auctionDone ? undefined : delayed ? "Delayed" : "First";
  const stages: readonly { section: RulesSection; accent: Accent; label: string; text: string }[] = [
    {
      section: "auction",
      accent: ACCENT.auction,
      label: "Auction",
      text: delayed
        ? "The Private Companies are sold at the end of the Operating Round set with the first 3-train."
        : "The Private Companies are sold before the first Stock Round.",
    },
    { section: "stock", accent: ACCENT.stock, label: "Stock Round", text: "Players buy and sell corporation stock." },
    {
      section: "operating",
      accent: ACCENT.operating,
      label: "Operating Round",
      text: orPerStockRound ? `Corporations operate. ${orPerStockRound} in this phase.` : "Corporations operate. One to three per Stock Round, by phase.",
    },
    { section: "tables", accent: ACCENT.end, label: "Game End", text: "The bank runs out of money, or a player goes bankrupt." },
  ];
  return (
    <section style={styles.flowStrip} aria-label="How the game progresses">
      <div style={styles.flowHeadRow}>
        <span style={styles.stripLabel}>How the game progresses</span>
        <button type="button" className="rr-link" style={styles.stripToggle} aria-expanded={open} onClick={onToggle} data-testid="rules-game-flow-toggle">
          {open ? "Collapse" : "Expand"}{" "}
          <span aria-hidden="true">{open ? "▾" : "▸"}</span>
        </button>
      </div>
      <div className="rr-chain" style={styles.chain} data-testid="rules-game-flow-chain">
        <ChainStage
          accent={ACCENT.auction}
          label="Auction"
          short="Auction"
          state={auctionState}
          done={auctionDone}
          live={auctionLive}
          onNavigate={() => onNavigate("auction")}
        />
        {/* A CONNECTOR NEVER ENDS A LINE. Each joiner is grouped with the stage it leads to, so when the
            chain wraps at phone width it breaks between stages and never leaves a dangling arrow. */}
        <span style={styles.chainGroup}>
          <span style={styles.chainArrow} aria-hidden="true">
            →
          </span>
          <ChainStage
            accent={ACCENT.stock}
            label="Stock Round"
            short="Stock"
            live={roundType === "StockRound"}
            state={roundType === "StockRound" ? "Now" : undefined}
            onNavigate={() => onNavigate("stock")}
          />
        </span>
        <span style={styles.chainGroup}>
          {/* The loop, between the two rounds it joins. */}
          <span style={styles.chainLoop} role="img" aria-label="alternating with">
            ⇄
          </span>
          <ChainStage
            accent={ACCENT.operating}
            label="Operating Rounds"
            short="Operating"
            live={roundType === "OperatingRound"}
            state={roundType === "OperatingRound" ? "Now" : undefined}
            onNavigate={() => onNavigate("operating")}
          />
        </span>
        <span style={styles.chainGroup}>
          <span style={styles.chainArrow} aria-hidden="true">
            →
          </span>
          <ChainStage accent={ACCENT.end} label="Game End" short="End" />
        </span>
      </div>
      {/* Open, indented, hairlined -- not a panel, and nothing panelled inside it. */}
      {open && (
        <div style={styles.flowOpen} data-testid="rules-game-flow-open">
          {stages.map((stage) => (
            <div key={stage.label} style={{ ...styles.flowOpenItem, borderTop: `2px solid ${stage.accent.rule}` }}>
              <span style={{ ...styles.flowOpenName, color: stage.accent.ink }}>{stage.label}</span>
              <span style={styles.flowOpenText}>{stage.text}</span>
              <span style={styles.flowOpenLink}>
                <PageLink section={stage.section} onNavigate={onNavigate}>
                  {sectionLabel(stage.section)}
                </PageLink>
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/** At a Glance: five numbers, one strip, one link. The cells are hairline-separated cells of one grid rather
 *  than five cards -- so the wrap at a narrow width re-flows the grid and never re-forms the cards. The last
 *  cell spans the narrow grid, because a five-cell strip over two columns otherwise ends on a half-row. */
function GlanceStrip({
  cells,
  onNavigate,
}: {
  /* `node` is the one escape from "a label, a strong value and a muted line": the tile key is a row of
     glyphs rather than a number, and it stands in the value's place rather than beside it. */
  cells: readonly {
    label: string;
    value: string;
    note: string;
    accent: Accent;
    /** The label's ink, where the accent's own is the wrong weight for it. Defaults to `accent.ink`. */
    labelInk?: string;
    text?: boolean;
    node?: React.ReactNode;
  }[];
  onNavigate: (section: RulesSection) => void;
}) {
  return (
    <section style={styles.block} aria-label="At a glance">
      <div style={styles.blockHead}>
        <span style={styles.stripLabel}>At a glance</span>
        <span style={styles.blockHeadLink}>
          <PageLink section="tables" onNavigate={onNavigate}>
            All tables
          </PageLink>
        </span>
      </div>
      <div style={styles.glanceGrid} data-testid="rules-glance-strip">
        {cells.map((cell, index) => (
          <div
            key={cell.label}
            className={index === cells.length - 1 ? "rr-glance-last" : undefined}
            style={styles.glanceCell}
            data-testid={index === cells.length - 1 ? "rules-glance-last" : undefined}
          >
            <span style={{ ...styles.glanceLabel, color: cell.labelInk ?? cell.accent.ink }}>{cell.label}</span>
            {cell.node ?? <span style={{ ...styles.glanceValue, ...(cell.text ? styles.glanceValueText : {}) }}>{cell.value}</span>}
            <span style={styles.glanceNote}>{cell.note}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

/** ==================================================================
 *   WHICH TILES CAN BE LAID, AS THE COLOURS THEMSELVES
 *  ==================================================================
 *  REPLACES PRESIDENCY IN THE STRIP, and the reason is what the strip is for: four of its five cells answered
 *  "what is true in this game right now" and the fifth answered "what does the rulebook say about
 *  presidents" -- a static rule, already carried by the Stock Round's reminders, the Change of President
 *  section and Tables. Tile availability is the fact that changes under a player three times a game and is
 *  the one they ask about mid-turn.
 *  THE GLYPHS ARE `EraHex`, the same component the Bank Train Depot draws, at the same small size -- one
 *  answer to "what colour is green" across the app (#1094). NEVER COLOUR ALONE: each hex is named beside it,
 *  and the hexes are `role="presentation"` so the name is the only thing announced.
 *  AND THE SCHEDULE IS `tileErasAt`, not a second table keyed on phase. `rulesOverview.test.tsx` pins what it
 *  returns against this page's own `PHASE_ROWS.tiles` column, so the two cannot drift apart in silence. */
/** Big enough to read as a tile rather than as a bullet, small enough to keep the strip's cell height. The
 *  hex is drawn 18/16 as tall as it is wide, so 25 is a 28px glyph. */
const TILE_KEY_HEX_SIZE = 25;

function TileColourKey({ eras }: { eras: readonly string[] }) {
  return (
    <span style={styles.tileKey} data-testid="rules-tile-colors">
      {eras.map((era) => (
        /* THE NAME MOVES OFF THE SCREEN AND INTO THE ELEMENT. At 25px the hexes are the tile colours
           themselves rather than a legend needing one, and four of them plus four words was a caption the
           cell had no room for. `EraHex` draws `role="presentation"`, so THIS span is the only thing
           announced -- one image per colour, named -- and `title` gives the same words on hover. */
        <span key={era} style={styles.tileKeyItem} role="img" aria-label={`${era} tiles`} title={`${era} tiles`}>
          <EraHex tone={era} size={TILE_KEY_HEX_SIZE} />
        </span>
      ))}
    </span>
  );
}

/** One action in the current round's sequence. A chip is a button because selecting it PREVIEWS its
 *  explanation; the live one is separately and differently marked, and selecting a preview never touches it. */
function ActionChip({
  label,
  sub,
  number,
  live,
  previewed,
  onSelect,
  innerRef,
}: {
  label: string;
  sub?: string;
  number?: number;
  live?: boolean;
  previewed?: boolean;
  onSelect: () => void;
  innerRef?: React.Ref<HTMLButtonElement>;
}) {
  return (
    <button
      ref={innerRef}
      type="button"
      className="rr-chip"
      aria-pressed={previewed === true}
      aria-current={live ? "step" : undefined}
      onClick={onSelect}
      style={{ ...styles.actionChip, ...(previewed ? styles.actionChipPreview : {}), ...(live ? styles.actionChipLive : {}) }}
    >
      <span style={styles.actionChipLabel}>
        {number !== undefined && <span style={styles.actionChipNumber}>{number}</span>}
        {label}
        {live && <span style={styles.actionChipNow}>Current</span>}
      </span>
      {sub && <span style={styles.actionChipSub}>{sub}</span>}
    </button>
  );
}

/** The compact lookup, and the rule that keeps it compact: ONE table, already written elsewhere in this file,
 *  with a quiet link to where the full thing lives. */
function LookupPanel({ excerpt, onNavigateTo }: { excerpt: LookupExcerpt; onNavigateTo: (section: RulesSection, anchor?: string) => void }) {
  const numeric = excerpt.table.numeric ?? [];
  return (
    <div style={styles.lookup} data-testid="rules-lookup-excerpt">
      <span style={styles.stripLabel}>{excerpt.title}</span>
      <table style={styles.lookupTable}>
        <thead>
          <tr>
            {excerpt.table.columns.map((column, index) => (
              <th key={column} style={{ ...styles.lookupTh, ...(numeric.indexOf(index) !== -1 ? styles.lookupNum : {}) }}>
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {excerpt.table.rows.map((row) => (
            <tr key={row.join("|")}>
              {row.map((cell, index) => (
                <td
                  key={`${index}-${cell}`}
                  style={{ ...styles.lookupTd, ...(index === 0 ? styles.lookupTdStrong : {}), ...(numeric.indexOf(index) !== -1 ? styles.lookupNum : {}) }}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <span style={styles.lookupLink}>
        <button type="button" className="rr-link" style={styles.linkButton} onClick={() => onNavigateTo(excerpt.page, excerpt.anchor)}>
          {sectionLabel(excerpt.page)} →
        </button>
      </span>
    </div>
  );
}

/** Watch For: at most three, chosen for the current action, at a readable measure. The orange mark is spent
 *  only on the two or three reminders that can actually cost a game. */
function WatchForPanel({ items, accent }: { items: readonly WatchItem[]; accent: Accent }) {
  if (items.length === 0) return null;
  return (
    <section style={styles.block} aria-label="Watch for">
      <span style={styles.stripLabel}>Watch for</span>
      <ul style={styles.watchList} data-testid="rules-watch-for">
        {items.map((item) => (
          <li key={item.text} style={styles.watchItem}>
            <span style={styles.watchHead}>
              {item.warn && (
                <span style={styles.watchMark} role="img" aria-label="warning">
                  !
                </span>
              )}
              <span style={{ ...styles.watchLabel, color: item.warn ? WARN_INK : accent.ink }}>{item.label}</span>
            </span>
            <span style={styles.watchText}>{item.text}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** How the game ends, as three alternatives. NOT NUMBERED: a bank break and a bankruptcy are two ways in, not
 *  step one and step two, and the old numbered list said otherwise every time it was read. */
function GameEndStrip({ onNavigateTo }: { onNavigateTo: (section: RulesSection, anchor?: string) => void }) {
  const rows: readonly (readonly [string, string])[] = [
    ["Bank break", "The game ends the next time a Stock Round would begin, once the round set in progress has been completed."],
    ["Bankruptcy", "The game ends immediately."],
    ["Winner", "The player with the greatest total wealth."],
  ];
  return (
    <section style={styles.block} aria-label="Game end">
      <div style={styles.blockHead}>
        <span style={{ ...styles.stripLabel, color: ACCENT.end.ink }}>Game end</span>
        <span style={styles.blockHeadLink}>
          <button type="button" className="rr-link" style={styles.linkButton} onClick={() => onNavigateTo("tables", "rules-reference-game-end")}>
            Exact timing and valuation →
          </button>
        </span>
      </div>
      <div style={styles.endStrip} data-testid="rules-game-end">
        {rows.map(([term, text]) => (
          <div key={term} style={styles.endRow}>
            <span style={{ ...styles.endTerm, color: ACCENT.end.ink }}>{term}</span>
            <span style={styles.endText}>{text}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

interface ActionChipSpec {
  key: string;
  label: string;
  sub?: string;
  number?: number;
  live?: boolean;
}

interface ActionExplain {
  title: string;
  lead: string;
  bullets: readonly string[];
  page: RulesSection;
  /** The section on that page this link lands on, where there is one. */
  anchor?: string;
  /** Named for where it actually goes -- `Open full Run Routes rules`, not `Full rules`. */
  linkLabel: string;
}

/** Overview: the state-aware quick reference. Display props only, as ever -- the round, the sub-step, the
 *  round tag, the acting corporation, the phase, the seat count. Nothing here reaches for `gameState`. */
function OverviewPage({
  roundType,
  liveSubPhase,
  stockAction,
  roundLabel,
  activeCorporation,
  livePhase,
  playerCount,
  auctionDone,
  flowOpen,
  onToggleFlow,
  onNavigate,
  onNavigateTo,
}: {
  roundType: RulesRoundType | null;
  liveSubPhase: RulesOperatingSubPhase | null;
  stockAction: StockRoundAction | null;
  roundLabel: string | null;
  activeCorporation: RulesReferenceProps["activeCorporation"];
  livePhase: string | null;
  playerCount: number | null;
  auctionDone: boolean;
  flowOpen: boolean;
  onToggleFlow: () => void;
  onNavigate: (section: RulesSection) => void;
  onNavigateTo: (section: RulesSection, anchor?: string) => void;
}) {
  const applies = useInScope();
  const delayed = applies({ scope: "delayedAuction" });
  /* The Level Playing Field REPLACES the certificate table (seven seats, its own limits) and the Tables page
     already shows the one that applies; the strip reads the same pair of constants so the two agree. */
  const lpf = applies({ scope: "levelPlayingField" });
  const certLimit = playerCount
    ? lpf
      ? LPF_CERT_LIMIT_BY_PLAYER_COUNT[playerCount]
      : CERT_LIMIT_BY_PLAYERS.find((row) => row.players === playerCount)?.limit
    : undefined;
  const phaseRow = livePhase ? PHASE_ROWS.find((row) => row.phase === livePhase) : undefined;
  const auctionLive = roundType === "WaterfallAuction";
  const orCount = phaseRow && phaseRow.operatingRounds !== "—" ? phaseRow.operatingRounds : null;
  const orPerStockRound = orCount ? `${orCount} OR${orCount === "1" ? "" : "s"} per Stock Round` : null;
  const privates = privateCompanyStatus(livePhase, delayed, auctionDone, auctionLive);
  /* WHICH TILE COLOURS MAY BE LAID. Phase 1 is the auction -- no track is laid in it, and the shell forces
     `livePhase` to "1" while that round runs -- so the key is empty there whatever tier the depot reports.
     `plusTiles` is already in scope as a filter; `tileErasAt` reads it for the 18XX+ set's fourth colour. */
  const plusTiles = applies({ scope: "plusTiles" });
  /* The TIER comes off the phase row this page already found, so nothing new is passed in and the Tables
     page's own "live phase" mark and this key are answering from one row. Phase 1 carries no tier. */
  const tileEras: readonly string[] = phaseRow?.tier ? tileErasAt(phaseRow.tier as TrainTier, plusTiles) : [];
  const accent = accentForRound(roundType);
  const watchKey = watchKeyFor(roundType, liveSubPhase);
  const firstStockRound = firstStockRoundFrom(roundType, roundLabel);

  /* The preview is LOCAL and it is not the game. It clears whenever the live action moves, so a stale
     preview can never be mistaken for what is happening now. */
  const [preview, setPreview] = useState<string | null>(null);
  useEffect(() => {
    setPreview(null);
  }, [roundType, liveSubPhase, stockAction]);

  /* ==================================================================
      THE TWO NEUTRAL LABELS WERE WEARING THE DISABLED INK
     ==================================================================
     `ACCENT.neutral.ink` is `INK_TEXT_FAINT`, which the palette documents as "Faint: DISABLED LABELS,
     not-yet-reached steps" -- 5.32:1 on `INK_VIEWPORT`, against the 6.8-7.2:1 the three round hues carry.
     So `CURRENT PHASE` and `TILE COLORS` did not merely read as quieter than their neighbours; they read as
     switched off, and the quietest of the five was the one a player orients by.

     `labelInk` overrides the ink FOR THE LABEL ONLY, per cell. `ACCENT.neutral` is untouched -- it is the
     accent of two whole pages and of every neutral rule and tint in the file, and re-tuning it here to fix
     two labels would have moved all of them.

     THE LADDER, NOT A NEW COLOUR. Both values below are steps the palette already defines and this file
     already uses, so the strip gains no fourth grey and no hue it did not have. */
  const glance: readonly {
    label: string;
    value: string;
    note: string;
    accent: Accent;
    /** The label's ink, where the accent's own is the wrong weight for it. Defaults to `accent.ink`. */
    labelInk?: string;
    text?: boolean;
    node?: React.ReactNode;
  }[] = [
    {
      label: "Current phase",
      value: phaseRow ? `Phase ${phaseRow.phase}` : "—",
      note: phaseRow ? (phaseRow.phase === "1" ? "The Private Company Auction" : phaseRow.begins) : "No live game",
      accent: ACCENT.neutral,
      /* THE PRIMARY ORIENTATION FACT, so its label is the brightest in the strip: `INK_TEXT_DIM` is 10.79:1,
         clear of the three round hues at ~7:1 and of the muted step below. It stays NEUTRAL on purpose --
         a magenta label would claim this cell for the Operating Round, a tile colour would claim it for an
         era, and green is reserved for live state, none of which a phase name is. Subordinate to its own
         value by two measures that do not need a colour: 11px against 19px, and 10.79 against 16.18. */
      labelInk: INK_TEXT_DIM,
    },
    {
      label: "Operating rounds",
      /* Phase 1 has none, and `—` beside "one to three, by phase" reads as missing data rather than as a
         fact about the phase the table is in. */
      value: phaseRow?.phase === "1" ? "None" : (orCount ?? "—"),
      note: phaseRow?.phase === "1" ? "The Auction precedes the first Stock Round" : orCount ? "per Stock Round, this phase" : "one to three, by phase",
      accent: ACCENT.operating,
      text: phaseRow?.phase === "1",
    },
    { label: "Private companies", value: privates.value, note: privates.short, accent: ACCENT.auction, text: true },
    {
      label: "Certificate limit",
      value: certLimit !== undefined ? String(certLimit) : "—",
      note: playerCount ? `${playerCount} players, privates included` : "by player count",
      /* The Stock Round's blue, inherited from the cell this one replaced: a certificate limit is Stock Round
         reference, and it is the only cell in the strip that belongs to a round page rather than to Tables. */
      accent: ACCENT.stock,
    },
    {
      label: "Tile colors",
      /* NOT "Tiles": that reads as the tray, and this says nothing about how many of each are left. */
      value: tileEras.length > 0 ? "" : livePhase === null ? "Set by phase" : "None",
      node: tileEras.length > 0 ? <TileColourKey eras={tileEras} /> : undefined,
      note: tileEras.length > 0 ? "Available this phase" : livePhase === null ? "See Trains & Phases" : "No track-laying phase yet",
      /* The tile colours ARE the accent here; a round hue over the top of them would be a fourth colour
         saying something else. */
      accent: ACCENT.neutral,
      /* STILL NEUTRAL, one step off the floor. `INK_TEXT_MUTED` is the palette's "captions, metadata,
         hints" step at 7.57:1, and it is already this file's ink for a small uppercase heading of exactly
         this shape (`docHeading`, `calloutTag`). It sits with the round hues rather than above them, so the
         hexes keep the cell and `CURRENT PHASE` stays visibly the brighter of the two greys. */
      labelInk: INK_TEXT_MUTED,
      text: true,
    },
  ];

  /* ---- The current round's action sequence, and what to say about the action in it. ---- */
  const auctionCard = COMPANY_CARDS.find((card) => card.id === "auction");
  let chips: readonly ActionChipSpec[] = [];
  let arrows = true;
  let intro: string | null = null;

  if (roundType === "WaterfallAuction") {
    arrows = false;
    intro = "On your turn, choose one.";
    chips = AUCTION_FLOW.map((step) => ({ key: step.label, label: step.label, sub: step.sub }));
  } else if (roundType === "StockRound") {
    chips = [
      { key: "sell-first", label: "Sell", sub: "any number", live: stockAction === "Sell" },
      { key: "buy", label: "Buy 1 certificate", sub: "normally one", live: stockAction === "Buy" },
      { key: "sell-second", label: "Sell", sub: "any number", live: stockAction === "Sell" },
    ];
    /* A turn may sell before buying and after buying. WHERE A SALE IS REPORTED BUT NOT WHICH ONE, both are
       marked -- an honest "one of these" rather than a guess, and said in the player's terms rather than as a
       note about what the interface was handed. */
    intro = stockAction === "Sell" ? "A sale is open — a turn may sell before buying and after buying." : null;
  } else if (roundType === "OperatingRound") {
    chips = SEQUENTIAL_STEPS.map((step) => ({
      key: step.id,
      label: step.short,
      number: step.number ?? undefined,
      live: liveSubPhase === step.subPhase,
    }));
  }

  const liveChip = chips.find((chip) => chip.live);
  const shownKey = preview ?? liveChip?.key ?? null;
  const previewing = preview !== null && preview !== liveChip?.key;

  /* ---- The action flow scrolls sideways at phone width; bring the live chip into that view. It moves the
     ROW's own scroll offset, never the page, and never the game. ---- */
  const flowRowRef = useRef<HTMLDivElement>(null);
  const liveChipRef = useRef<HTMLButtonElement>(null);
  /* BEFORE THE PAINT, not after it: on `useEffect` the first frame showed the row at offset zero and the
     current step off the right-hand edge, which is a flicker on every open and on every sub-phase change.
     The read forces layout, so the measurements are the ones the browser is about to draw. */
  useLayoutEffect(() => {
    const row = flowRowRef.current;
    const chip = liveChipRef.current;
    if (!row || !chip || row.scrollWidth <= row.clientWidth) return;
    row.scrollLeft = Math.max(0, chip.offsetLeft - Math.max(0, (row.clientWidth - chip.offsetWidth) / 2));
  }, [roundType, liveSubPhase, stockAction]);
  /* ==================================================================
      THE ONE SCROLLING ROW ON THIS PAGE THAT DID NOT SAY IT SCROLLED
     ==================================================================
     MEASURED AT 430, NOT ASSUMED: the row is 895px of chips in 384px of space, `overflow-x: auto` with NO
     scrollbar gutter (overlay scrollbars report 0) and no fade. With the live step in the middle of the
     sequence the effect above centres it, which leaves a 36px sliver of the previous chip at the left edge --
     "NS", the tail of STATION TOKENS, reading as a word rather than as a chip continuing off-screen.
     THE CUE IS THE ONE THIS FILE ALREADY HAS. `ScrollingLookup`'s note already argues the case -- "the cue is
     a line of text, not a panel, not a gradient and not a scrollbar that a trackpad hides" -- and this row was
     the only horizontally scrolling region in the reference not using it. So this is a consistency fix, not a
     new idiom: same hook, same style, same voice, one noun changed.
     MEASURED MEANS MOBILE-ONLY FOR FREE: above the narrow breakpoint `.rr-action-row` wraps instead of
     scrolling, so the row never overflows and the cue never renders. No media query says so. */
  const flowScrolls = useScrollsSideways(flowRowRef, `${roundType}:${liveSubPhase}:${stockAction}:${chips.length}`);

  const explainFor = (key: string | null): ActionExplain | null => {
    if (roundType === "OperatingRound") {
      const step = OPERATING_STEPS.find((entry) => entry.id === key);
      if (step) {
        return {
          title: step.title,
          lead: step.lead,
          /* The step's OWN plan, live or previewed: a bullet is dropped because something else on the screen
             says it, and which step is being read decides which something that is. */
          bullets: currentActionBullets(("or:" + step.subPhase) as RulesWatchKey, step.quick),
          page: "operating",
          anchor: `rules-section-${step.id}`,
          linkLabel: `Open full ${step.title} rules`,
        };
      }
      return {
        title: "The corporation's turn",
        lead: OPERATING_ROUND_OVERVIEW.lead,
        bullets: OPERATING_ROUND_OVERVIEW.opening,
        page: "operating",
        linkLabel: "Open Operating Round rules",
      };
    }
    if (roundType === "StockRound") {
      const id = key === "buy" ? "buy" : key === null ? null : "sell";
      const card = id ? STOCK_CARDS.find((entry) => entry.id === id) : undefined;
      if (card) {
        return {
          title: card.title,
          lead: card.lead,
          bullets: currentActionBullets("stock", card.quick),
          page: "stock",
          anchor: `rules-section-${card.id}`,
          linkLabel: `Open full ${card.title} rules`,
        };
      }
      return {
        title: "The Stock Round turn",
        lead: STOCK_ROUND_OVERVIEW.lead,
        bullets: currentActionBullets("stock", STOCK_ROUND_OVERVIEW.quick, 3),
        page: "stock",
        linkLabel: "Open Stock Round rules",
      };
    }
    if (roundType === "WaterfallAuction") {
      /* The chip labels and the auction card's own bullets share a first word -- `Buy lowest` and
         `Buy — purchase the unsold Private Company ...` -- so the bullet is FOUND rather than mapped. */
      const bullet = key ? companyQuick("auction", `${key.split(" ")[0]} — `) : null;
      if (bullet) return { title: key ?? "", lead: bullet, bullets: [], page: "auction", linkLabel: "Open Auction rules" };
      /* THE MINIMUM NEEDED TO EXPLAIN HOW THE AUCTION CONTINUES, and nothing else: the bid-money commitment
         and the resolution interrupt are both reminders on the right, and repeating either here was the
         duplication this pass removes. */
      return { title: "The buy-bid-turn", lead: auctionCard?.lead ?? "", bullets: [], page: "auction", linkLabel: "Open Auction rules" };
    }
    return null;
  };

  const explain = explainFor(shownKey);
  const excerpt = lookupFor(watchKey, applies);
  const watchItems = watchItemsFor(watchKey, { firstStockRound });
  const buyPrivateLive = roundType === "OperatingRound" && liveSubPhase === "BuyPrivate";
  const buyPrivateShown = roundType === "OperatingRound" && (privates.buyable || buyPrivateLive);
  const roundHeading =
    roundType === null
      ? "No live round"
      : roundType === "OperatingRound" && roundLabel
        ? `Operating Round ${roundLabel.replace(/^OR\s*/, "")}`
        : roundType === "StockRound" && roundLabel
          ? `Stock Round ${roundLabel.replace(/^SR\s*/, "")}`
          : ROUND_LABEL[roundType];

  const currentRound = (
    <section style={styles.block} aria-label="Current round" data-testid="rules-current-round">
      <div style={styles.roundHead}>
        <span style={{ ...styles.roundKicker, color: accent.ink }}>{roundType === null ? "Reference" : "Current round"}</span>
        <h3 style={styles.roundName}>{roundHeading}</h3>
        {roundType === "OperatingRound" && activeCorporation && <span style={styles.roundMeta}>{activeCorporation.ticker}</span>}
      </div>
      <div style={{ ...styles.roundRule, backgroundColor: accent.rule }} aria-hidden="true" />

      {roundType === null ? (
        <>
          <p style={styles.explainLead}>
            No round is live. The reference is complete and unfiltered — each round has its own page, and the numbers are on Tables.
          </p>
          <div style={styles.explainFoot}>
            <PageLink section="auction" onNavigate={onNavigate}>
              {sectionLabel("auction")}
            </PageLink>
            <PageLink section="stock" onNavigate={onNavigate}>
              {sectionLabel("stock")}
            </PageLink>
            <PageLink section="operating" onNavigate={onNavigate}>
              {sectionLabel("operating")}
            </PageLink>
            <PageLink section="tables" onNavigate={onNavigate}>
              {sectionLabel("tables")}
            </PageLink>
          </div>
        </>
      ) : (
        <>
          {intro && <p style={styles.roundIntro}>{intro}</p>}
          <div ref={flowRowRef} className="rr-action-row" style={styles.actionRow} data-testid="rules-action-flow">
            {chips.map((chip, index) => (
              <React.Fragment key={chip.key}>
                {arrows && index > 0 && (
                  <span style={styles.actionArrow} aria-hidden="true">
                    →
                  </span>
                )}
                <ActionChip
                  label={chip.label}
                  sub={chip.sub}
                  number={chip.number}
                  live={chip.live}
                  previewed={preview === chip.key}
                  innerRef={chip.key === liveChip?.key ? liveChipRef : undefined}
                  onSelect={() => setPreview(preview === chip.key ? null : chip.key)}
                />
              </React.Fragment>
            ))}
          </div>
          {flowScrolls && (
            <span style={styles.scrollCue} data-testid="rules-flow-scroll-cue">
              Scroll sideways for the other {roundType === "OperatingRound" ? "steps" : "choices"} →
            </span>
          )}
          {/* ==================================================================
               THE HOME STATION IS BESIDE THE FLOW HERE TOO, NOT INSIDE STEP 2
              ==================================================================
              The Operating Round page settled this: 6.1 and 6.3.1 make the home station mandatory, free and
              earlier than step 1, while 6.3.2's additional station is optional, paid for and during the turn.
              Two rules, so two pieces of text. The Overview had the right sentence in the wrong place -- a
              bullet inside the Station Tokens preview -- which read as a condition of the optional step.
              SAME LABEL, SAME SENTENCE, SAME POSITION as the Operating Round page: a `First turn only` pill
              adjacent to the turn sequence and outside it. `styles.opAsideTag` is deliberately reused rather
              than copied, so one note cannot come to wear two labels. */}
          {roundType === "OperatingRound" && (
            <p style={styles.flowNote} data-testid="rules-overview-home-station">
              <span style={styles.opAsideTag}>{HOME_STATION.tag}</span>
              {HOME_STATION.text}
            </p>
          )}
          {/* ==================================================================
               BUY PRIVATE COMPANY IS OUTSIDE THE SCROLLER, NOT THE LAST THING IN IT
              ==================================================================
              It was the sixth item in the row, which made it the sixth item in a SCROLLING SEQUENCE at phone
              width -- it took space from the five numbered steps and arrived at the end of the scroll exactly
              where a step six would be. It is now a sibling annotation beneath the sequence: outside it at
              every width, and one dashed rule rather than a box. `buyPrivateShown` is unchanged -- the same
              legality, so it still does not appear before Phase 3 or after the companies close. */}
          {buyPrivateShown && (
            <p style={{ ...styles.asideAction, ...(buyPrivateLive ? styles.asideActionLive : {}) }} data-testid="rules-buy-private-aside">
              {/* BOUNDED, because the window shuts. "Phase 3+" reads as "from now on", and the Operating
                  Round and Auction pages both give the real window -- 3.0's "during phases 3 and 4" and
                  3.2's closure at the first 5-train. `buyPrivateShown` already stops rendering this line
                  once the companies close; the tag now says so before it happens. */}
              <span style={styles.asideTag}>Also available during the turn · Phases 3 and 4, until the first 5-train</span>
              <span style={styles.asideDash} aria-hidden="true">
                —
              </span>
              <span style={styles.asideTitle}>
                Buy Private Company
                {buyPrivateLive && <span style={styles.actionChipNow}>Current</span>}
              </span>
            </p>
          )}

          {explain && (
            <div style={styles.explain} data-testid="rules-current-action">
              <div style={styles.explainHead}>
                <span style={{ ...styles.explainKicker, color: previewing ? INK_TEXT_FAINT : accent.ink }}>
                  {previewing ? "Preview" : liveChip ? "Current action" : "This round"}
                </span>
                <span style={styles.explainTitle}>{explain.title}</span>
              </div>
              <p style={styles.explainLead}>{explain.lead}</p>
              {explain.bullets.length > 0 && (
                <ul style={styles.explainBullets}>
                  {explain.bullets.map((item) => (
                    <li key={item} style={styles.bullet}>
                      {item}
                    </li>
                  ))}
                </ul>
              )}
              <div style={styles.explainFoot}>
                <button type="button" className="rr-link" style={styles.linkButton} onClick={() => onNavigateTo(explain.page, explain.anchor)}>
                  {explain.linkLabel} →
                </button>
                {previewing && (
                  <button type="button" className="rr-link" style={styles.linkButton} onClick={() => setPreview(null)}>
                    Back to the current action
                  </button>
                )}
              </div>
            </div>
          )}

          {excerpt && <LookupPanel excerpt={excerpt} onNavigateTo={onNavigateTo} />}
        </>
      )}
    </section>
  );

  return (
    <div style={styles.overviewPage}>
      <GameFlowDisclosure
        roundType={roundType}
        auctionDone={auctionDone}
        delayed={delayed}
        orPerStockRound={orPerStockRound}
        open={flowOpen}
        onToggle={onToggleFlow}
        onNavigate={onNavigate}
      />

      <GlanceStrip cells={glance} onNavigate={onNavigate} />

      {/* ---- Two columns on a wide screen because they do different jobs: the left is the procedure, the
          right is the set of traps in it. WITH NO LIVE ROUND there are no traps to list, so there is no
          second column and the summary uses the width. ---- */}
      {roundType === null ? (
        currentRound
      ) : (
        <div className="rr-round-grid">
          {currentRound}
          <WatchForPanel items={watchItems} accent={accent} />
        </div>
      )}

      <GameEndStrip onNavigateTo={onNavigateTo} />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* STOCK ROUND                                                         */
/* ------------------------------------------------------------------ */

/** ==================================================================
 *   SEVEN EQUAL SECTIONS ANSWERED NO QUESTION IN PARTICULAR
 *  ==================================================================
 *  The page was Round Flow followed by Sell · Buy · Float · President · Limits · Market Effects · Movement, each
 *  a heading with a lead and a bullet list, each behind its own `More detail` toggle, under one
 *  `Expand all / Collapse all`. Every topic weighed the same, so finding "can I buy this?" meant reading down
 *  the page, and the same rule was stated in three places -- the Priority Deal in Round Flow AND in the round
 *  bullets, the brown-box purchase in Round Flow's caption AND in Buy AND in Market Effects.
 *
 *  THE PAGE IS NOW SHAPED BY THE FIVE QUESTIONS A PLAYER ACTUALLY ARRIVES WITH:
 *    ROUND FLOW           what happens on my turn -- the Sell → Buy → Sell shape, then who starts, how it
 *                         continues and how it ends, as three aligned columns.
 *    SELL | BUY           the two things you do, side by side, each with its own restrictions beside it.
 *    START & FLOAT        what happens when a corporation starts: one left-to-right progression.
 *    OWNERSHIP & LIMITS   who is president, and the three limits, as parallel columns.
 *    MARKET EFFECTS       two lookup TABLES rather than prose -- zone effects, and share-value movement.
 *
 *  ONE HOME PER RULE. Where a rule belongs to another section, this page points at it rather than restating
 *  it: Sell's presidency line links to Ownership & Limits, Buy's brown-zone line links to Market Effects, and
 *  the limits table links to the player-count table on Tables. `rulesStockRound.test.tsx` counts the
 *  principal sentences and fails if one is rendered twice.
 *
 *  NO ACCORDIONS AND NO BULK TOGGLE. The whole procedural reference is on the page; a player mid-turn should
 *  not have to open seven disclosures to read it. */

/** The page's own sections, in order -- the jump row and the anchors are generated from this one list, so a
 *  link cannot point at a section that is not there. `sell` and `buy` keep the `rules-section-<card id>`
 *  spelling `RuleSection` uses, because Overview's `Open full Buy Stock rules →` lands on them. */
const STOCK_SECTIONS: readonly { id: string; label: string }[] = [
  { id: "rules-section-sell", label: "Sell" },
  { id: "rules-section-buy", label: "Buy" },
  { id: "rules-section-float", label: "Start & Float" },
  { id: "rules-section-ownership", label: "Ownership & Limits" },
  { id: "rules-section-market", label: "Market Effects" },
];

/** The turn's shape. NOT CONTROLS: three labels and two arrows, drawn with the page's accent under them. The
 *  app cannot tell which of the two sells a player is taking, and nothing here implies that it can. */
const STOCK_TURN_STAGES: readonly { label: string; sub: string }[] = [
  { label: "Sell", sub: "any number" },
  { label: "Buy 1 certificate", sub: "normally one" },
  { label: "Sell", sub: "any number" },
];

/** ==================================================================
 *   THE MARKET ZONE SWATCHES, AND WHY THEY ARE COPIED RATHER THAN IMPORTED
 *  ==================================================================
 *  These are `ZONE_TEXT_COLORS` from `StockMarketRenderer.tsx` (design note #196: "what a zone looks like as a
 *  word", lifted for contrast on a dark panel) -- the chart's own answer, so a swatch here and a price cell
 *  there cannot mean two different yellows.
 *  NOT IMPORTED, because that module is the whole stock-market chart: the corporation logos, the market
 *  tokens, the livery table and the UI-scale hook come with it, and a three-string palette is not worth a
 *  one-way dependency from the rules reference onto a rendering component.
 *  SO THE COPY IS PINNED INSTEAD. `rulesStockRound.test.tsx` reads `StockMarketRenderer.tsx` and fails if
 *  these three values and its `ZONE_TEXT_COLORS` stop agreeing -- which is the guarantee the import would
 *  have bought, without the weight. */
const MARKET_ZONE_SWATCH: Readonly<Record<"Yellow" | "Orange" | "Brown", string>> = {
  Yellow: "#e3c951",
  Orange: "#e39a51",
  Brown: "#c08a5e",
};

type StockLiveKey = StockCard["id"] | "roundOverview";

/** Which section is current: the one whose `cursor` matches the live Stock Round action, else -- in a live
 *  Stock Round with no distinguishable action -- the Round Flow itself. Nothing, outside a Stock Round. */
function liveStockKey(live: boolean, action: StockRoundAction | null): StockLiveKey | null {
  if (!live) return null;
  const card = action ? STOCK_CARDS.find((entry) => entry.cursor === action) : undefined;
  return card ? card.id : "roundOverview";
}

function stockCard(id: StockCard["id"]): StockCard | undefined {
  return STOCK_CARDS.find((card) => card.id === id);
}

/** `"... first — see Change of President."` becomes `"... first."`; the pointer becomes a real link instead. */
function withoutPointer(text: string): string {
  const at = text.indexOf(" — see ");
  return at === -1 ? text : `${text.slice(0, at)}.`;
}

/** The one sentence of `text` that starts with `prefix`. ES5-safe: no lookbehind. */
function sentenceStartingWith(text: string, prefix: string): string | null {
  const parts = text.split(". ");
  const sentences = parts.map((part, index) => (index < parts.length - 1 ? `${part}.` : part));
  return sentences.filter((sentence) => sentence.indexOf(prefix) === 0)[0] ?? null;
}

/** `"its certificates do not count ..."` for a table cell. */
function capitalised(text: string): string {
  return text.length === 0 ? text : text.charAt(0).toUpperCase() + text.slice(1);
}

/** A section heading that is also a jump target. `scrollMarginTop` clears the sticky page strip. */
function StockSection({
  id,
  title,
  current,
  anchorRef,
  aside,
  children,
}: {
  id: string;
  title: string;
  current?: boolean;
  anchorRef?: React.Ref<HTMLDivElement>;
  aside?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section ref={anchorRef} id={id} style={styles.stockSection}>
      <div style={styles.sectionHeadingRow}>
        <h3 style={{ ...styles.sectionTitle, color: ACCENT.stock.ink }}>{title}</h3>
        {current && <span style={styles.currentPill}>← Current</span>}
        {aside}
      </div>
      {children}
    </section>
  );
}

/** A column of the Sell | Buy pair, and of Ownership & Limits: a heading, a lead and a list. No card. */
function StockColumn({ title, lead, children }: { title: string; lead?: string; children: React.ReactNode }) {
  return (
    <div style={styles.stockColumn}>
      <h4 style={styles.stockColumnTitle}>{title}</h4>
      {lead && <p style={styles.stockColumnLead}>{lead}</p>}
      {children}
    </div>
  );
}

/** ==================================================================
 *   A TABLE THAT SCROLLS SAYS SO, AND ONLY WHEN IT ACTUALLY DOES
 *  ==================================================================
 *  At phone width the zone table's fourth column (PURCHASE EFFECT) sits entirely past the right edge of its
 *  scroll region, and nothing on screen said there was a fourth column -- the table simply looked like it had
 *  three. The cue is a line of text, not a panel, not a gradient and not a scrollbar that a trackpad hides.
 *  MEASURED, NOT ASSUMED. A media query would be a guess about when the container is narrower than the table
 *  (the threshold moves with the root's own padding, and with any future column), and a cue that says "scroll
 *  sideways" to somebody whose table already fits is worse than none. This reads `scrollWidth` against
 *  `clientWidth` and re-reads it whenever the box resizes. */
/** Whether a box is wider than the space it has. `token` re-measures when the CONTENT changes rather than
 *  the box -- a `ResizeObserver` on a full-width row never fires when the row's own children change. */
function useScrollsSideways(ref: React.RefObject<HTMLElement | null>, token = ""): boolean {
  const [scrolls, setScrolls] = useState(false);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return undefined;
    const measure = () => setScrolls(node.scrollWidth > node.clientWidth + 1);
    measure();
    /* Same shape as `useStickyDockOffset`: observe where we can, fall back to the window where we cannot. */
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref, token]);
  return scrolls;
}

function ScrollingLookup({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const scrolls = useScrollsSideways(ref);
  return (
    <>
      <div ref={ref} style={styles.tableScroll}>
        {children}
      </div>
      {scrolls && (
        <span style={styles.scrollCue} data-testid="rules-scroll-cue">
          Scroll sideways for the rest of the table →
        </span>
      )}
    </>
  );
}

/** A quiet in-page pointer: "the rule lives over there", never the rule again. */
function StockJump({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <button type="button" className="rr-link" style={styles.linkButton} onClick={() => jumpToSection(to)}>
      {children} ↓
    </button>
  );
}

function jumpToSection(id: string) {
  if (typeof document === "undefined") return;
  const node = document.getElementById(id);
  /* jsdom has no `scrollIntoView`; a reference page must not throw because a test rendered it. */
  if (node && typeof node.scrollIntoView === "function") node.scrollIntoView({ block: "start", behavior: "smooth" });
}

function StockRoundPage({
  liveKey,
  firstStockRound,
  currentRef,
  onNavigateTo,
}: {
  liveKey: StockLiveKey | null;
  /** `true` only in Stock Round 1, where the sale ban is worth marking; `null` when the tag cannot be read. */
  firstStockRound: boolean | null;
  currentRef: React.RefObject<HTMLDivElement>;
  onNavigateTo: (section: RulesSection, anchor?: string) => void;
}) {
  const applies = useInScope();
  const flowCurrent = liveKey === "roundOverview";
  const sell = stockCard("sell");
  const buy = stockCard("buy");
  const float = stockCard("float");
  const president = stockCard("president");
  const limits = stockCard("limits");
  const market = stockCard("marketEffects");
  const movement = stockCard("movement");

  /* ---- The cadence: the three round-level facts, one per column, each said once on this page. ---- */
  /* Rulebook 5.0, in three columns. THE CARD IS NOT A BATON: it is held through the whole round and assigned
     once at the end, so `Continues` says how the TURN moves and `Ends` says where the CARD goes. */
  const cadence: readonly { label: string; text: string }[] = [
    { label: "Starts", text: "The holder of the Priority Deal Card." },
    {
      label: "Continues",
      text: "Clockwise, one turn each. Passing does not end your round: if anyone buys or sells after you pass, you may act again on your next turn.",
    },
    {
      label: "Ends",
      text: "When every player passes consecutively. The Priority Deal Card then goes to the player to the left of the last one who bought or sold; if nobody did, it does not change hands.",
    },
  ];

  /* ---- Market zones, as a matrix. Each cell's wording is LIFTED from the card's own sentences rather than
     retyped: the label before the colon becomes the zone, the clause after it becomes the effect. ---- */
  const zoneEffect = (prefix: string): string => {
    const line = market ? onePrefixed(market.quick, prefix) : null;
    return line ? capitalised(splitLabelled(line)[1]) : "—";
  };
  const certificateEffect = zoneEffect("Yellow, orange or brown box");
  const holdingEffect = zoneEffect("Orange or brown box");
  const purchaseEffect = zoneEffect("Brown box");
  const zoneRows: readonly { zone: "Yellow" | "Orange" | "Brown"; cells: readonly string[] }[] = [
    { zone: "Yellow", cells: [certificateEffect, "—", "—"] },
    { zone: "Orange", cells: [certificateEffect, holdingEffect, "—"] },
    { zone: "Brown", cells: [certificateEffect, holdingEffect, purchaseEffect] },
  ];
  const zoneNote = market ? onePrefixed(market.quick, "These follow the token's position") : null;

  /* ---- Share-value movement. `WHEN` is the one authored column, and it classifies rather than states: which
     round the trigger belongs to. Trigger and movement are the card's own halves. ---- */
  const MOVEMENT_WHEN: readonly { prefix: string; when: string }[] = [
    /* NOT "Stock Round". Rulebook 6.6.3 forces a president to sell shares to fund a train purchase, which
       happens in an Operating Round -- and the token moves the same way when it does. The procedure itself
       belongs to the Operating Round page; this cell only stops the table from claiming otherwise. */
    { prefix: "Share sold", when: "Stock Round, or a forced sale in an Operating Round" },
    { prefix: "All shares owned by players", when: "Stock Round" },
    { prefix: "Dividend declared", when: "Operating Round" },
    { prefix: "No dividend", when: "Operating Round" },
  ];
  const movementRows = MOVEMENT_WHEN.map(({ prefix, when }) => {
    const line = movement ? onePrefixed(movement.quick, prefix) : null;
    if (!line) return null;
    const [trigger, moves] = splitLabelled(line);
    return { trigger, moves, when };
  }).filter((row): row is { trigger: string; moves: string; when: string } => row !== null);
  const stackNote = movement ? onePrefixed(movement.quick, "A token arriving in an occupied box") : null;

  const limitRows = (limits?.quick ?? [])
    .slice(0, 3)
    .map((line) => splitLabelled(line))
    .map(([label, value]) => ({ label: capitalised(label), value: withoutPointer(value), tables: value.indexOf(" — see Tables") !== -1 }));
  const sellDownNote = limits ? sentenceStartingWith(limits.quick[3] ?? "", "A player pushed over a limit") : null;

  /* ---- The float progression. Four labels and three connectors; everything else is underneath it. ---- */
  const floatStages: readonly string[] = [
    /* "Obtain", not "Buy": rulebook 3.0 gives the BO private's owner the B&O President's Certificate
       "without further payment", and 5.2 still makes them set the par value. One label covers both routes. */
    "Obtain President's Certificate · set par",
    "60% leaves the Initial Offering",
    "Corporation floats",
    "Operates next Operating Round",
  ];

  const parTable = buy ? detailTable(buy.detail, "Par value") : null;
  const privateCertificates = buy ? buy.detail.filter((node) => "ul" in node)[0] : undefined;

  return (
    <div style={styles.page}>
      {/* ================= 1. ROUND FLOW ================= */}
      <section ref={flowCurrent ? currentRef : undefined} style={styles.block}>
        <div style={styles.sectionHeadingRow}>
          <h3 style={{ ...styles.sectionTitle, color: ACCENT.stock.ink }}>Round Flow</h3>
          {flowCurrent && <span style={styles.currentPill}>← Current</span>}
        </div>
        {/* ONE SENTENCE. The full lead narrates Sell → Buy → Sell and the round-end condition, both of which
            are drawn immediately below it -- on this page it would be the caption of its own diagram. */}
        <p style={styles.lead}>{STOCK_ROUND_OVERVIEW.short}</p>
        {/* A SHAPE, NOT A CONTROL STRIP: the stages are spans under an accent rule. */}
        <div className="rr-stock-turn" style={styles.stockTurn} data-testid="rules-stock-turn">
          {STOCK_TURN_STAGES.map((stage, index) => (
            <React.Fragment key={`${stage.label}-${index}`}>
              {index > 0 && (
                <span style={styles.stockTurnArrow} aria-hidden="true">
                  →
                </span>
              )}
              <span style={styles.stockTurnStage}>
                <span style={styles.stockTurnLabel}>{stage.label}</span>
                <span style={styles.stockTurnSub}>{stage.sub}</span>
              </span>
            </React.Fragment>
          ))}
        </div>
        {/* THE FLOW STAYS GENERAL AND THE QUALIFIER IS A SENTENCE. Both sells belong to the Stock Round's
            shape whatever round this is; in the first one, rulebook 5.1 closes them, and saying so here is a
            line of text rather than a greyed-out stage that would read as a disabled control. */}
        {firstStockRound === true && (
          <p style={styles.stockFirstRound} data-testid="rules-stock-first-round">
            First Stock Round — no certificates may be sold this round.
          </p>
        )}
        <div className="rr-cadence" data-testid="rules-stock-cadence">
          {cadence.map((item) => (
            <div key={item.label}>
              <span style={{ ...styles.cadenceLabel, color: ACCENT.stock.ink }}>{item.label}</span>
              <span style={styles.cadenceText}>{item.text}</span>
            </div>
          ))}
        </div>
      </section>

      {/* ================= 2. JUMP ROW ================= */}
      <nav style={styles.jumpRow} aria-label="Stock Round sections" data-testid="rules-stock-jump">
        {STOCK_SECTIONS.map((entry, index) => (
          <React.Fragment key={entry.id}>
            {index > 0 && (
              <span style={styles.jumpDot} aria-hidden="true">
                ·
              </span>
            )}
            <button type="button" className="rr-link" style={styles.jumpLink} onClick={() => jumpToSection(entry.id)}>
              {entry.label}
            </button>
          </React.Fragment>
        ))}
      </nav>

      {/* ================= 3. SELL | BUY ================= */}
      {/* The hairline the other three sections carry: five sections, one rhythm. The pair itself is a bare
          grid, so the rule belongs to the wrapper rather than to `.rr-stock-pair`, which is reused inside
          Ownership & Limits where a second top rule would be a line across the middle of a section. */}
      <div style={styles.stockPairSection}>
      <div className="rr-stock-pair" data-testid="rules-stock-pair">
        <div ref={liveKey === "sell" ? currentRef : undefined} id="rules-section-sell" style={styles.stockAnchored}>
          <StockColumn title="Sell" lead={sell?.lead}>
            {liveKey === "sell" && <span style={styles.currentPill}>← Current</span>}
            <ul style={styles.bullets}>
              {(sell?.quick ?? []).map((item, index) => {
                const firstRoundBan = index === 0;
                const presidency = item.indexOf("The President's Certificate is never sold") === 0;
                return (
                  <li key={item} style={styles.bullet}>
                    {/* THE BAN IS ALWAYS READABLE HERE; in Stock Round 1 it also carries the mark. */}
                    {firstRoundBan && firstStockRound === true && (
                      <span style={{ ...styles.watchMark, marginRight: "7px" }} role="img" aria-label="warning">
                        !
                      </span>
                    )}
                    {presidency ? withoutPointer(item) : item}
                    {presidency && (
                      <>
                        {" "}
                        <StockJump to="rules-section-ownership">Ownership &amp; Limits</StockJump>
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          </StockColumn>
        </div>

        <div ref={liveKey === "buy" ? currentRef : undefined} id="rules-section-buy" style={styles.stockAnchored}>
          <StockColumn title="Buy" lead={buy?.lead}>
            {liveKey === "buy" && <span style={styles.currentPill}>← Current</span>}
            <ul style={styles.bullets}>
              {(buy?.quick ?? []).slice(0, 3).map((item) => (
                <li key={item} style={styles.bullet}>
                  {item}
                </li>
              ))}
              {/* Rulebook 4.4: "during your turn in a stock round, you may purchase any number of
                  certificates from the bank pool of one corporation whose share value token is in a brown grid
                  box". IT IS STILL ONE PURCHASE -- the old line said the rule was "relaxed", which reads as a
                  second buy. The full sentence and the other two zones are in the table below. */}
              <li style={styles.bullet}>
                Brown box: that one purchase may take any number of that corporation&rsquo;s Bank Pool certificates — it is still a single purchase, not an
                extra one.{" "}
                <StockJump to="rules-section-market">Market Effects</StockJump>
              </li>
            </ul>
          </StockColumn>
        </div>
      </div>
      </div>

      {/* ================= 4. START & FLOAT ================= */}
      <StockSection id="rules-section-float" title={"Start & Float"}>
        <div className="rr-stock-seq" data-testid="rules-stock-float-sequence">
          {floatStages.map((stage, index) => (
            <React.Fragment key={stage}>
              {index > 0 && (
                <span style={styles.seqArrow} aria-hidden="true">
                  →
                </span>
              )}
              <span style={styles.seqStage}>{stage}</span>
            </React.Fragment>
          ))}
        </div>
        <ul style={styles.bullets}>
          {(float?.quick ?? []).map((item) => (
            <li key={item} style={styles.bullet}>
              {item}
            </li>
          ))}
        </ul>
        {parTable && (
          <div style={styles.stockLookup}>
            <span style={styles.stripLabel}>Par values</span>
            <RuleTableView table={parTable} />
          </div>
        )}
        {privateCertificates && "ul" in privateCertificates && (
          <div style={styles.stockLookup}>
            <span style={styles.stripLabel}>Certificates that arrive through Private Companies</span>
            <ul style={styles.bullets}>
              {privateCertificates.ul.map((item) => (
                <li key={item} style={styles.bullet}>
                  {item}
                </li>
              ))}
            </ul>
          </div>
        )}
      </StockSection>

      {/* ================= 5. OWNERSHIP & LIMITS ================= */}
      <StockSection id="rules-section-ownership" title={"Ownership & Limits"}>
        <div className="rr-stock-pair">
          <StockColumn title="Changing president">
            <p style={styles.stockRuleStrong}>{president?.lead}</p>
            <ul style={styles.bullets}>
              {(president?.quick ?? []).map((item) => (
                <li key={item} style={styles.bullet}>
                  {item}
                </li>
              ))}
            </ul>
          </StockColumn>
          <StockColumn title="Certificate limits" lead={limits?.lead}>
            <table style={{ ...styles.table, ...styles.tableFixed, minWidth: 0 }}>
              <colgroup>
                <col style={{ width: "38%" }} />
                <col />
              </colgroup>
              <tbody>
                {limitRows.map((row) => (
                  <tr key={row.label} style={styles.tr}>
                    <td style={{ ...styles.td, ...styles.tdStrong }}>{row.label}</td>
                    <td style={styles.td}>
                      {row.value}
                      {row.tables && (
                        <>
                          {" "}
                          <button
                            type="button"
                            className="rr-link"
                            style={styles.linkButton}
                            onClick={() => onNavigateTo("tables", "rules-reference-player-limits")}
                          >
                            Player limits →
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {sellDownNote && <p style={styles.footnote}>{sellDownNote}</p>}
            {/* Rulebook 4.4, and the two are NOT the same set: yellow, orange and brown exempt the
                certificates from the overall limit; only orange and brown lift the individual corporation
                limit. The old line said all three relaxed both. */}
            <p style={styles.footnote}>
              Yellow, orange and brown boxes exempt that corporation&rsquo;s certificates from your overall limit; orange and brown also allow holding more
              than the individual corporation limit. <StockJump to="rules-section-market">Market Effects</StockJump>
            </p>
          </StockColumn>
        </div>
      </StockSection>

      {/* ================= 6. MARKET EFFECTS ================= */}
      <StockSection id="rules-section-market" title="Market Effects">
        <p style={styles.lead}>{market?.lead}</p>
        <ScrollingLookup>
          <table style={{ ...styles.table, ...styles.tableFixed, minWidth: "620px" }} data-testid="rules-stock-zones">
            <colgroup>
              <col style={{ width: "96px" }} />
              <col />
              <col />
              <col />
            </colgroup>
            <thead>
              <tr>
                <th style={styles.thWrap}>Zone</th>
                <th style={styles.thWrap}>Certificate-limit effect</th>
                <th style={styles.thWrap}>Holding-limit effect</th>
                <th style={styles.thWrap}>Purchase effect</th>
              </tr>
            </thead>
            <tbody>
              {zoneRows.map((row) => (
                <tr key={row.zone} style={styles.tr}>
                  <td style={{ ...styles.td, ...styles.tdStrong }}>
                    <span style={{ ...styles.zoneSwatch, backgroundColor: MARKET_ZONE_SWATCH[row.zone] }} aria-hidden="true" />
                    {row.zone}
                  </td>
                  {row.cells.map((cell, index) => (
                    <td key={index} style={{ ...styles.td, ...(cell === "—" ? styles.tdMuted : {}) }}>
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollingLookup>
        {zoneNote && <p style={styles.footnote}>{zoneNote}</p>}

        <div id="rules-section-movement" style={{ ...styles.stockLookup, scrollMarginTop: "170px" }}>
          <h4 style={styles.stockColumnTitle}>Share value movement</h4>
          <p style={styles.stockColumnLead}>{movement?.lead}</p>
          <ScrollingLookup>
            <table style={{ ...styles.table, ...styles.tableFixed, minWidth: "620px" }} data-testid="rules-stock-movement">
              <colgroup>
                <col style={{ width: "26%" }} />
                <col />
                <col style={{ width: "196px" }} />
              </colgroup>
              <thead>
                <tr>
                  <th style={styles.thWrap}>Trigger</th>
                  <th style={styles.thWrap}>Movement</th>
                  <th style={styles.thWrap}>When</th>
                </tr>
              </thead>
              <tbody>
                {movementRows.map((row) => (
                  <tr key={row.trigger} style={styles.tr}>
                    <td style={{ ...styles.td, ...styles.tdStrong }}>{capitalised(row.trigger)}</td>
                    <td style={styles.td}>{capitalised(row.moves)}</td>
                    <td style={{ ...styles.td, ...styles.tdMuted }}>{row.when}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollingLookup>
          {stackNote && <p style={styles.footnote}>{stackNote}</p>}
          {(movement?.notes ?? []).filter(applies).map((note) => (
            <div key={note.text} style={styles.callout}>
              <VariantTag scope={note.scope} />
              <span style={styles.calloutText}>{note.text}</span>
            </div>
          ))}
        </div>
      </StockSection>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* OPERATING ROUND                                                     */
/* ------------------------------------------------------------------ */

/** ==================================================================
 *   FIVE ACCORDIONS UNDER A FLOW DIAGRAM ANSWERED NOTHING ON SIGHT
 *  ==================================================================
 *  The page was Round Flow, then Lay Track | Station Tokens | Run Routes | Dividends | Buy Trains as five
 *  identically shaped `More detail` sections under one `Expand all`, then Buy Private Company as a sixth
 *  section of the same shape. Everything a player needs mid-turn -- what a city is, what happens when you
 *  cannot afford a train -- was inside a closed disclosure, and the five topics weighed the same whether
 *  they were one sentence or two pages.
 *
 *  THE PAGE IS NOW A SPINE, AND DIFFERENT INFORMATION GETS DIFFERENT TREATMENT:
 *    ROUND FLOW      the round's cadence in one line, then the corporation's ordered turn. The five stages
 *                    ARE the page's section headings, so the flow is the jump row as well -- a second row of
 *                    the same five words directly beneath it would be repetition, not navigation.
 *    1 LAY TRACK     one rule, then place | upgrade as two columns, then the phase table as a lookup.
 *    2 STATION TOKEN the OPTIONAL additional station only. The mandatory first-turn home station is a
 *                    different rule and sits beside the flow, above: 6.3.1 and 6.3.2 are not one rule.
 *    3 RUN ROUTES    the definitions first, because the rest of the section is written against them, then
 *                    the range lookup, then may | may not as two columns.
 *    4 DIVIDENDS     a genuine choice, so a two-column comparison rather than two paragraphs in sequence.
 *    5 BUY TRAINS    normal sources and one-at-a-time first, the phase limit as a lookup, and the forced
 *                    purchase as a marked exceptional procedure at the end.
 *    SIDE ACTION     Buy Private Company, outside the numbered spine, named beside the flow.
 *
 *  NO DISCLOSURES AND NO BULK TOGGLE. Every rule this page carries is on it. `MoreToggle` and `BulkToggle`
 *  still serve the Auction page, which is still an accordion page.
 *
 *  GREEN AND THE WORD "CURRENT" ARE RESERVED. They appear only where `liveSubPhase` is actually known. With
 *  no live state the flow is five magenta-ruled headings and claims nothing about what is happening now. */

/** A section of the spine: a hairline, a number, a heading, and whatever treatment the content wants. */
function OperatingSection({
  id,
  number,
  title,
  current,
  anchorRef,
  tag,
  children,
}: {
  id: string;
  number?: number;
  title: string;
  current?: boolean;
  anchorRef?: React.Ref<HTMLDivElement>;
  tag?: string;
  children: React.ReactNode;
}) {
  return (
    <section ref={anchorRef} id={id} style={styles.opSection}>
      <div style={styles.sectionHeadingRow}>
        {number !== undefined && (
          <span style={{ ...styles.opSectionNumber, ...(current ? styles.opSectionNumberLive : {}) }} aria-hidden="true">
            {number}
          </span>
        )}
        <h3 style={styles.opSectionTitle}>{title}</h3>
        {tag && <span style={styles.calloutTag}>{tag}</span>}
        {current && <span style={styles.currentPill}>← Current</span>}
      </div>
      {children}
    </section>
  );
}

/** A labelled definition row: the term in the page accent, the rule beside it. Used where the content IS a
 *  set of definitions and a bullet list would flatten them back into peers. */
function OpDefinitions({ rows, testId }: { rows: readonly { label: string; text: string; items?: readonly string[] }[]; testId?: string }) {
  return (
    <dl className="rr-op-defs" style={styles.opDefs} data-testid={testId}>
      {rows.map((row) => (
        <React.Fragment key={row.label}>
          <dt style={styles.opDefLabel}>{row.label}</dt>
          <dd style={styles.opDefText}>
            {row.text}
            {/* The row's own qualifications stay INSIDE the row: a list left hanging under the table reads as
                a footnote to all three sources when it belongs to one of them. */}
            {row.items && row.items.length > 0 && (
              <ul style={{ ...styles.bullets, marginTop: "5px" }}>
                {row.items.map((item) => (
                  <li key={item} style={styles.bullet}>
                    {item}
                  </li>
                ))}
              </ul>
            )}
          </dd>
        </React.Fragment>
      ))}
    </dl>
  );
}

/** A lookup: a small-caps label with the table under it. Never a card. */
function OpLookup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={styles.opLookupBlock}>
      <span style={styles.stripLabel}>{label}</span>
      {children}
    </div>
  );
}

/** ==================================================================
 *   ONE COLUMN OF RULE TEXT, AT A MEASURE SOMEBODY CAN READ
 *  ==================================================================
 *  `styles.prose` and `styles.bullets` cap at 76ch and 88ch, which is fine on the pages that put them inside
 *  a column and far too wide here, where most of this page is full-bleed. Rather than retune two shared
 *  styles and move every other page, everything on this page that is not a table, a pair or a lookup goes
 *  through this wrapper. 88ch measured 918px at 1440 -- most of a screen for one line of a bullet. */
function OpProse({ nodes }: { nodes: readonly RuleNode[] }) {
  if (nodes.length === 0) return null;
  return (
    <div style={styles.opMeasure}>
      <RuleDocument nodes={nodes} columns={false} />
    </div>
  );
}

/** A named sub-block inside a section: one line of small caps, then the rules. */
function OpBlock({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ ...styles.opBlock, ...styles.opMeasure }}>
      <h4 style={styles.opSubTitle}>{title}</h4>
      {children}
    </div>
  );
}

function OperatingRoundPage({
  liveSubPhase,
  currentRef,
  onNavigateTo,
}: {
  liveSubPhase: RulesOperatingSubPhase | null;
  currentRef: React.RefObject<HTMLDivElement>;
  onNavigateTo: (section: RulesSection, anchor?: string) => void;
}) {
  const applies = useInScope();
  /* THE PAGE'S ONE DISCLOSURE, and it is not a generic accordion: it belongs to a named exception that
     applies to two of the eight corporations. Everything else on this page is on this page. */
  const [homeHexOpen, setHomeHexOpen] = useState(false);
  const track = operatingStep("track");
  const station = operatingStep("station");
  const routes = operatingStep("routes");
  const revenue = operatingStep("revenue");
  const trains = operatingStep("buyTrains");
  const buyPrivate = operatingStep("buyPrivate");
  const liveStep = liveSubPhase ? OPERATING_STEPS.find((step) => step.subPhase === liveSubPhase) : undefined;
  const isLive = (id: OperatingStep["id"]) => liveStep !== undefined && liveStep.id === id;
  const stepRef = (id: OperatingStep["id"]) => (isLive(id) ? currentRef : undefined);

  const trackDetail = track?.detail ?? [];
  /* "Place one tile on a hex that does not already contain a tile; or" / "Upgrade one tile already on the
     board." -- the list that repeated the lead. Each becomes its own column's opening line. */
  const trackOptions = detailList(detailIntro(track?.detail ?? []))
    .map((item) => capitalised(item.replace(/;?\s*or$/, "").trim()))
    .map((item) => (item.charAt(item.length - 1) === "." ? item : `${item}.`));
  /* The NYC and Erie entries leave this list: the disclosure below states both of them in full, with the
     hexes, the tiles and the three things they are NOT. The CSL and DH entries stay -- they are private
     companies' abilities, and neither is a home hex. */
  const trackExceptions = withoutItems(detailUnder(track?.detail ?? [], "Placing a new tile"), ["The NYC to place", "The Erie to place"]);
  const stationDetail = station?.detail ?? [];
  const routeDetail = routes?.detail ?? [];
  const revenueDetail = revenue?.detail ?? [];
  const trainDetail = trains?.detail ?? [];

  /* ---- Run Routes: the restriction list split into the two columns it was always two lists of. The column
     HEADING carries the stem, so the item drops it -- "A route may not / reverse at a junction", never "A
     route may not / May not reverse at a junction". ---- */
  const routeRules = detailList(detailUnder(routeDetail, "Route restrictions"));
  const routeMay = routeRules.filter((item) => item.indexOf("May not") !== 0).map((item) => withoutStem(item, "May "));
  const routeMayNot = routeRules.filter((item) => item.indexOf("May not") === 0).map((item) => withoutStem(item, "May not "));
  const highestRevenue = detailUnder(routeDetail, "Highest revenue rule");
  const highestRevenueLead = highestRevenue[0];
  const highestRevenueRest = highestRevenue.slice(1);
  const routeRangeTable = detailTable(routeDetail, "Train");
  const stationCostTable = detailTable(stationDetail, "Station");

  /* ---- Buy Trains: the three sources read better as three rows of one list than as three headed blocks
     down the page, and the exceptional procedure is pulled out from under them. ---- */
  const trainSources: readonly { label: string; text: string; items?: readonly string[] }[] = [
    { label: "The Bank", text: detailProse(trainDetail, "Bank trains are bought at face value") ?? "", items: [detailProse(trainDetail, "The exception is Diesels") ?? ""].filter((t) => t !== "") },
    { label: "The Bank Pool", text: detailProse(trainDetail, "Trains in the Bank Pool") ?? "" },
    {
      label: "Another corporation",
      text: detailProse(trainDetail, "A train may be purchased from another corporation") ?? "",
      items: detailList(detailUnder(trainDetail, "Buying from another corporation")),
    },
  ].filter((row) => row.text !== "");
  const trainLimitTable = detailTable(trainDetail, "Phase");
  const dieselTable = detailTable(trainDetail, "Purchase");
  const oneAtATime = operatingQuick("buyTrains", "Buy trains one at a time");
  const boughtAtTheEnd = detailProse(OPERATING_ROUND_OVERVIEW.detail, "A newly purchased train is purchased at the end");

  /* ---- Dividends. The no-revenue rule belongs to neither column -- it is the rule about not making the
     choice at all -- so it sits under both of them. ---- */
  const noRevenueRule = detailProse(revenueDetail, "If a corporation has no revenue");
  const privateRevenue = detailProse(revenueDetail, "Revenue from a Private Company");

  return (
    <div style={styles.page} data-testid="rules-operating-page">
      {/* ================= ROUND FLOW ================= */}
      <section style={styles.block}>
        <div style={styles.sectionHeadingRow}>
          <h3 style={{ ...styles.sectionTitle, color: ACCENT.operating.ink }}>Round Flow</h3>
        </div>
        <p style={styles.opLead} data-testid="rules-operating-cadence">
          {OPERATING_ROUND_CADENCE}
        </p>
        {/* THE TURN. Five headings under the page accent, joined by arrows. The section each one names is
            what it scrolls to, so this row is the diagram and the jump row at once. Nothing here is a
            control over the game: no fill, no border, and the arrows are decorative. */}
        <div className="rr-op-flow" style={styles.opFlow} data-testid="rules-operating-flow">
          {SEQUENTIAL_STEPS.map((step, index) => {
            const current = isLive(step.id);
            return (
              <React.Fragment key={step.id}>
                {index > 0 && (
                  <span style={styles.opFlowArrow} aria-hidden="true">
                    →
                  </span>
                )}
                <button
                  type="button"
                  className="rr-op-stage"
                  style={{ ...styles.opFlowStage, ...(current ? styles.opFlowStageLive : {}) }}
                  aria-label={`Jump to ${step.title}`}
                  onClick={() => jumpToSection(`rules-section-${step.id}`)}
                >
                  <span style={{ ...styles.opFlowNumber, ...(current ? styles.opFlowNumberLive : {}) }} aria-hidden="true">
                    {step.number}
                  </span>
                  <span style={styles.opFlowLabel}>{step.short}</span>
                  {current && <span style={styles.opFlowNow}>Current</span>}
                </button>
              </React.Fragment>
            );
          })}
        </div>
        {/* ADJACENT TO THE FLOW, OUTSIDE IT. Mandatory, free, and before step 1, so it is neither a sixth
            stage nor a line inside step 2. Rulebook 6.1 and 6.3.1. */}
        <p style={styles.opHomeStation} data-testid="rules-operating-home-station">
          <span style={styles.opAsideTag}>{HOME_STATION.tag}</span>
          {HOME_STATION.text}
        </p>
        {/* THE SIDE ACTION, NAMED BESIDE THE FLOW AND EXPLAINED BELOW IT. The availability window is the part
            a player checks in a hurry, so the window is the part that is up here. */}
        {buyPrivate && (
          <p style={styles.opSideLine} data-testid="rules-operating-side-line">
            {/* A LABEL, NOT A DISCLAIMER. `NOT A STEP` was the page arguing with itself; the flow above it is
                numbered 1 to 5 and this line is not in it, which is the whole claim. */}
            <span style={styles.opSideLabel}>Side action · Buy Private Company</span>
            <span style={styles.opSideText}>
              {buyPrivate.availability}{" "}
              <StockJump to={`rules-section-${buyPrivate.id}`}>Read the rules</StockJump>
            </span>
          </p>
        )}
      </section>

      {/* ================= 1. LAY TRACK ================= */}
      <OperatingSection id="rules-section-track" number={1} title="Lay Track" current={isLive("track")} anchorRef={stepRef("track")}>
        <p style={styles.opLead}>{track?.lead}</p>
        {/* THE CHOICE IS STATED ONCE. The lead says one tile OR one upgrade; the two-bullet list under it
            said the same thing again, so each bullet now OPENS the column it describes, where it is the
            definition of that option rather than a second copy of the choice. */}
        <div className="rr-op-pair">
          <StockColumn title="Placing a new tile" lead={trackOptions[0]}>
            <RuleDocument nodes={trackExceptions} columns={false} />
          </StockColumn>
          <StockColumn title="Upgrading a tile" lead={trackOptions[1]}>
            <RuleDocument nodes={detailUnder(trackDetail, "Upgrading a tile")} columns={false} />
          </StockColumn>
        </div>
        <OpBlock title="Tile placement restrictions">
          <RuleDocument nodes={detailUnder(trackDetail, "Tile placement restrictions")} columns={false} />
        </OpBlock>
        {/* THE PAGE'S ONE DISCLOSURE. Named for what is inside it, so nobody has to open it to find out
            whether it concerns them -- and closed by default because it concerns two corporations. */}
        <div style={styles.opMeasure} data-testid="rules-operating-home-hexes">
          <button
            type="button"
            className="rr-link"
            aria-expanded={homeHexOpen}
            style={styles.moreToggle}
            onClick={() => setHomeHexOpen((wasOpen) => !wasOpen)}
          >
            <span style={styles.chevron} aria-hidden="true">
              {homeHexOpen ? "\u25be" : "\u25b8"}
            </span>
            Home hexes — NYC and Erie
          </button>
          {homeHexOpen && (
            <div style={{ ...styles.more, ...styles.opBlock }}>
              {HOME_HEX_EXCEPTIONS.map((item) => (
                <p key={item} style={styles.prose}>
                  {item}
                </p>
              ))}
            </div>
          )}
        </div>
        <OpLookup label="Tile colours, phases and terrain">
          <OpProse nodes={detailUnder(trackDetail, "Tile colors and phases")} />
        </OpLookup>
      </OperatingSection>

      {/* ================= 2. STATION TOKENS ================= */}
      <OperatingSection
        id="rules-section-station"
        number={2}
        title={station?.title ?? "Station Tokens"}
        current={isLive("station")}
        anchorRef={stepRef("station")}
      >
        <p style={styles.opLead}>{ADDITIONAL_STATION_LEAD}</p>
        <OpProse nodes={detailIntro(stationDetail)} />
        <div className="rr-op-pair">
          <StockColumn title="Placing an additional station">
            <RuleDocument
              nodes={withoutProse(withoutTables(detailUnder(stationDetail, "Additional stations")), "During an Operating Turn, a corporation may place one additional")}
              columns={false}
            />
          </StockColumn>
          <StockColumn title="Station blocking">
            <RuleDocument nodes={detailUnder(stationDetail, "Station blocking")} columns={false} />
          </StockColumn>
        </div>
        {stationCostTable && (
          <OpLookup label="Station costs">
            <RuleTableView table={stationCostTable} />
          </OpLookup>
        )}
      </OperatingSection>

      {/* ================= 3. RUN ROUTES ================= */}
      <OperatingSection id="rules-section-routes" number={3} title="Run Routes" current={isLive("routes")} anchorRef={stepRef("routes")}>
        <p style={styles.opLead}>{routes?.lead}</p>
        {/* The lead is "Each train runs once on one legal route"; the detail's opening sentence said the same
            thing in more words. What survives is the DEFINITION of a route, which the lead does not give. */}
        <OpProse nodes={withoutProse(detailIntro(routeDetail), "Each train owned by a corporation may run once")} />
        {/* S6-10: the definitions the rest of the section is written against, in the visible text. */}
        <OpDefinitions rows={ROUTE_CITY_RULES} testId="rules-operating-route-cities" />
        {routeRangeTable && (
          <OpLookup label="Train range">
            <OpProse nodes={withoutTables(detailUnder(routeDetail, "Train range"))} />
            <RuleTableView table={routeRangeTable} />
          </OpLookup>
        )}
        <div className="rr-op-pair" data-testid="rules-operating-route-columns">
          <StockColumn title="A route may">
            <ul style={styles.bullets}>
              {routeMay.map((item) => (
                <li key={item} style={styles.bullet}>
                  {item}
                </li>
              ))}
            </ul>
          </StockColumn>
          <StockColumn title="A route may not">
            <ul style={styles.bullets}>
              {routeMayNot.map((item) => (
                <li key={item} style={styles.bullet}>
                  {item}
                </li>
              ))}
            </ul>
          </StockColumn>
        </div>
        <OpBlock title="Running more than one train">
          <RuleDocument nodes={withoutProse(detailUnder(routeDetail, "Multiple trains"), "When a corporation runs more than one train")} columns={false} />
        </OpBlock>
        {/* PROMINENT, NOT PROCEDURAL. Rulebook 6.4 tells the players which combination to choose; it does not
            add a step to the turn, and nothing here asks the app to arbitrate one. */}
        <div style={styles.opProminent} data-testid="rules-operating-highest-revenue">
          <span style={styles.opProminentText}>
            {highestRevenueLead && "p" in highestRevenueLead ? highestRevenueLead.p : (routes?.quickNote ?? "")}
          </span>
        </div>
        <OpProse nodes={highestRevenueRest} />
      </OperatingSection>

      {/* ================= 4. DIVIDENDS ================= */}
      <OperatingSection id="rules-section-revenue" number={4} title="Dividends" current={isLive("revenue")} anchorRef={stepRef("revenue")}>
        <p style={styles.opLead}>{revenue?.lead}</p>
        <OpProse nodes={detailIntro(revenueDetail)} />
        {/* THE ONE REAL CHOICE ON THE PAGE, drawn as a choice: two columns of the same shape, read across. */}
        <div className="rr-op-pair" data-testid="rules-operating-dividend-choice">
          <StockColumn title="Pay dividends">
            <RuleDocument nodes={detailUnder(revenueDetail, "Dividend")} columns={false} />
          </StockColumn>
          <StockColumn title="Withhold">
            <RuleDocument nodes={withoutProse(detailUnder(revenueDetail, "Withhold"), "If a corporation has no revenue")} columns={false} />
          </StockColumn>
        </div>
        {noRevenueRule && <p style={styles.opFootRule}>{noRevenueRule}</p>}
        <OpBlock title="Off-board revenue">
          <RuleDocument nodes={detailUnder(revenueDetail, "Off-board revenue")} columns={false} />
        </OpBlock>
        {privateRevenue && <p style={styles.prose}>{privateRevenue}</p>}
        {(revenue?.notes ?? []).filter(applies).map((note) => (
          <div key={note.text} style={styles.callout}>
            <VariantTag scope={note.scope} />
            <span style={styles.calloutText}>{note.text}</span>
          </div>
        ))}
      </OperatingSection>

      {/* ================= 5. BUY TRAINS ================= */}
      <OperatingSection id="rules-section-buyTrains" number={5} title="Buy Trains" current={isLive("buyTrains")} anchorRef={stepRef("buyTrains")}>
        <p style={styles.opLead}>{trains?.lead}</p>
        <OpProse nodes={detailIntro(trainDetail)} />
        {oneAtATime && <p style={styles.prose}>{oneAtATime}</p>}
        {boughtAtTheEnd && <p style={styles.prose}>{boughtAtTheEnd}</p>}
        <OpDefinitions rows={trainSources} testId="rules-operating-train-sources" />
        {trainLimitTable && (
          <OpLookup label="Train limit by phase">
            <RuleTableView table={trainLimitTable} />
            <OpProse nodes={withoutTables(detailUnder(trainDetail, "Train limits"))} />
          </OpLookup>
        )}
        {dieselTable && (
          <OpLookup label="Diesels">
            <OpProse nodes={withoutTables(detailUnder(trainDetail, "Diesels"))} />
            <RuleTableView table={dieselTable} />
          </OpLookup>
        )}
        {(trains?.notes ?? []).filter(applies).map((note) => (
          <div key={note.text} style={styles.callout}>
            <VariantTag scope={note.scope} />
            <span style={styles.calloutText}>{note.text}</span>
          </div>
        ))}
        {/* THE EXCEPTION, MARKED AS ONE. A rule that can cost a player the game gets the warning ink and a
            rule down its left edge -- not a panel, and not the same weight as "you may buy a train". */}
        <div style={styles.opWarn} data-testid="rules-operating-forced-purchase">
          <span style={styles.opWarnLabel}>
            <span style={styles.opWarnMark} role="img" aria-label="warning">
              !
            </span>
            Forced train purchase
          </span>
          <OpProse nodes={detailUnder(trainDetail, "Forced train purchase")} />
          <button
            type="button"
            className="rr-link"
            style={styles.linkButton}
            onClick={() => onNavigateTo("tables", "rules-reference-forced-purchase")}
          >
            Forced purchase table →
          </button>
        </div>
      </OperatingSection>

      {/* ================= SIDE ACTION ================= */}
      {buyPrivate && (
        <OperatingSection
          id={`rules-section-${buyPrivate.id}`}
          title="Side action · Buy Private Company"
          tag={buyPrivate.availability}
          current={isLive("buyPrivate")}
          anchorRef={stepRef("buyPrivate")}
        >
          <p style={styles.opLead}>{BUY_PRIVATE_LEAD}</p>
          <OpProse nodes={withoutProse(buyPrivate.detail, "Beginning in Phase 3, a corporation may purchase")} />
        </OperatingSection>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Auction & Privates: the page's own derived data                     */
/* ------------------------------------------------------------------ */

/** Which company card carries the long-form rules for each catalog id. The catalog (`privateCatalog.ts`) is
 *  the app-wide source for names, prices, revenue and powers -- including the variant seventh private, which
 *  has no company card -- so the cards are read only for the EXCEPTIONS the catalog's two bullets cannot
 *  carry. A catalog id with no card simply has no exception note. */
const PRIVATE_CARD_ID: Readonly<Record<number, CompanyCard["id"]>> = {
  1: "sv",
  2: "csl",
  3: "dh",
  4: "mh",
  5: "ca",
  6: "bo",
};

function companyCard(id: CompanyCard["id"]): CompanyCard | undefined {
  return COMPANY_CARDS.find((card) => card.id === id);
}

/** The prose a company card holds that the catalog's bullets do not, chosen for the ones that genuinely
 *  surprise a buyer. FOUND BY PREFIX, never retyped: the card is still the one home for the sentence.
 *  NOT EVERY COMPANY. The SV has nothing to add, the CSL's caveat ("still subject to the tile-placement
 *  restrictions") is the general rule that Operating Round's Lay Track already states, and the JK's two
 *  bullets are self-contained. Four notes on a seven-row catalog is a footnote; seven would be an
 *  accordion with the lids taken off. */
function privateExceptions(id: number): readonly string[] {
  const cardId = PRIVATE_CARD_ID[id];
  const card = cardId ? companyCard(cardId) : undefined;
  if (!card) return [];
  const found: (string | null)[] =
    cardId === "dh"
      ? [
          detailProse(card.detail, "If the corporation does not place the station token"),
          detailProse(card.detail, "If another corporation lays a tile on the DH starting hex"),
        ]
      : cardId === "mh"
        ? [sentenceFrom(detailList(card.detail))]
        : cardId === "ca"
          ? [detailProse(card.detail, "The free share does not establish PRR")]
          : cardId === "bo"
            ? [detailCallout(card.detail, "Owning the Baltimore & Ohio private company")]
            : [];
  return found.filter((text): text is string => text !== null && text !== "");
}

/** When each private closes. The general rule is the first 5-train (rulebook 3.2); only the BO and the MH
 *  have an earlier one, and the catalog row says which so the column answers for every company. */
const PRIVATE_CLOSES_EARLY: Readonly<Record<number, string>> = {
  4: "On its NYC exchange",
  6: "B&O's first train",
};
const PRIVATE_CLOSES_DEFAULT = "First 5-train";

/** One catalog row, ready to render. Name, abbreviation, hex and the power come from the catalog and the
 *  rulebook appendix; membership comes from `applies`, so a variant private appears without this page
 *  knowing it exists. */
interface PrivateRow {
  id: number;
  scope?: RuleScope;
  abbr: string;
  name: string;
  hex: string;
  faceValue: number;
  revenue: number;
  bullets: readonly string[];
  exceptions: readonly string[];
  closes: string;
  early: boolean;
}

function privateRows(applies: (item: Scoped) => boolean): readonly PrivateRow[] {
  return PRIVATE_CATALOG_ROWS.filter(applies).map((row) => {
    const ref = PRIVATE_REFERENCE[row.id];
    const early = PRIVATE_CLOSES_EARLY[row.id];
    return {
      id: row.id,
      scope: row.scope,
      abbr: ref?.abbr ?? row.acronym,
      name: ref?.name ?? row.acronym,
      hex: ref?.hex ?? "—",
      faceValue: row.faceValue,
      revenue: row.revenue,
      bullets: row.bullets,
      exceptions: privateExceptions(row.id),
      closes: early ?? PRIVATE_CLOSES_DEFAULT,
      early: early !== undefined,
    };
  });
}

/* ------------------------------------------------------------------ */
/* AUCTION & PRIVATES                                                  */
/* ------------------------------------------------------------------ */

/** ==================================================================
 *   NINE CARDS OF THE SAME SHAPE, AND THE INTERRUPT WAS ONE OF THEM
 *  ==================================================================
 *  The page was a Round Flow with arrows through Pass → Buy lowest → Bid -- three ALTERNATIVES drawn as a
 *  sequence -- followed by nine identically styled `More detail` sections under one `Expand all`, followed by
 *  a Timing Quick Reference that restated most of them a third time. The thing that makes this auction hard
 *  to learn, that a bid on the cheapest company stops ordinary turns until it is resolved, was a sentence
 *  inside a closed disclosure.
 *
 *  THE PAGE IS NOW FOUR SECTIONS, each shaped like what it holds:
 *    AUCTION FLOW       one turn as a CHOICE of three, no arrows between them, then the interrupt drawn as a
 *                       BRANCH off that choice, then the Priority Deal rule, the all-pass branch, and the end
 *                       of the auction. Variants come after the base procedure, labelled, never inside it.
 *    RESOLVING BIDS     rulebook 1.2.2 in one readable place: placing a bid | the mini-auction, side by side.
 *    PRIVATE COMPANIES  a CATALOG -- aligned rows, one per company, read straight off `privateCatalog.ts`, so
 *                       a variant private is listed because the game has it and not because this file knows
 *                       its name. Exceptions are a muted line in the row that has one, not a disclosure each.
 *    CHANGING HANDS ·   the cross-round rules, which are not auction rules: revenue while open, the two ways
 *    REVENUE · CLOSURE  a private changes hands as a comparison, and closure as a lookup.
 *
 *  THE TIMING QUICK REFERENCE IS GONE. Every row of it restated a rule from the section above it; the timing
 *  now leads those rules instead -- "At the start of every Operating Round...", "On your Stock Round turn...",
 *  "Closes when..." -- so a player can still scan by moment without the page saying everything twice.
 *
 *  NO ACCORDIONS ANYWHERE IN THE REFERENCE NOW. This was the last page with any, which is why `RuleSection`,
 *  `MoreToggle` and `BulkToggle` leave with it. */

/** The three things a buy-bid-turn may be. NOT A SEQUENCE: `AUCTION_FLOW` above gives the labels the Overview
 *  also renders (arrows off); this adds the sentence each one needs on the page that explains them. */
const AUCTION_CHOICES: readonly { label: string; text: string }[] = [
  { label: "Pass", text: "Take no action this turn. You may still buy or bid on a later turn while the auction continues." },
  {
    label: "Buy the lowest unsold",
    text: "Pay the current price of the unsold Private Company with the lowest face value. The Priority Deal Card passes to the player on your left.",
  },
  {
    label: "Bid on another unsold",
    text: "Bid on any unsold Private Company except the lowest-priced one. The money is set aside until that company is resolved.",
  },
];

/** A branch off the ordinary turn: a corner mark, a name, and the lines. Deliberately NOT a panel and not a
 *  warning -- an interruption to a procedure is part of the procedure, drawn one step in from it. */
function AuctionBranch({
  title,
  lines,
  steps,
  testId,
  children,
}: {
  title: string;
  lines?: readonly string[];
  /** `Term — the move` lines, drawn with the term in the page accent so the branch scans as a sequence of
   *  moves rather than a paragraph about one. */
  steps?: readonly string[];
  testId?: string;
  children?: React.ReactNode;
}) {
  return (
    <div style={styles.auBranch} data-testid={testId}>
      <span style={styles.auBranchMark} aria-hidden="true">
        ↳
      </span>
      <div style={styles.auBranchBody}>
        <span style={styles.auBranchTitle}>{title}</span>
        {(steps ?? []).map((step) => {
          const at = step.indexOf(" — ");
          const term = at === -1 ? "" : step.slice(0, at);
          const rest = at === -1 ? step : step.slice(at + 3);
          return (
            <span key={step} style={styles.auBranchText}>
              {term !== "" && <span style={styles.auBranchTerm}>{term}</span>}
              {rest}
            </span>
          );
        })}
        {(lines ?? []).map((line) => (
          <span key={line} style={styles.auBranchText}>
            {line}
          </span>
        ))}
        {children}
      </div>
    </div>
  );
}

/** A section of this page: the same hairline spine the Operating Round page uses, in the auction's violet. */
function AuctionSection({
  id,
  title,
  current,
  anchorRef,
  children,
}: {
  id: string;
  title: string;
  current?: boolean;
  anchorRef?: React.Ref<HTMLDivElement>;
  children: React.ReactNode;
}) {
  return (
    <section ref={anchorRef} id={id} style={styles.opSection}>
      <div style={styles.sectionHeadingRow}>
        <h3 style={styles.opSectionTitle}>{title}</h3>
        {current && <span style={styles.currentPill}>← Current</span>}
      </div>
      {children}
    </section>
  );
}

const AUCTION_SECTIONS: readonly { id: string; label: string }[] = [
  { id: "rules-section-bids", label: "Resolving bids" },
  { id: "rules-section-companies", label: "Private companies" },
  { id: "rules-section-holding", label: "Changing hands · Revenue · Closure" },
];

function AuctionPage({ auctionLive, currentRef }: { auctionLive: boolean; currentRef: React.RefObject<HTMLDivElement> }) {
  const applies = useInScope();
  const auctionCard = companyCard("auction");
  const basics = companyCard("basics");
  const closure = companyCard("closure");
  const auctionDetail = auctionCard?.detail ?? [];
  const basicsDetail = basics?.detail ?? [];
  const rows = privateRows(applies);
  const variantNotes = (auctionCard?.notes ?? []).filter(applies);
  /* ==================================================================
      THE BASE GAME'S TIMING IS A CLAIM, AND THE VARIANT FALSIFIES IT
     ==================================================================
     `auction.lead` opens "Before the first Stock Round..." and the page closed with "The first Stock Round
     follows." Both are true of the printed game and false on a table running the delayed auction, where
     `gameVariants.ts` #905 has the game open on Stock Round 1 with no privates in play and the auction run at
     the end of the Operating Round set in which the first 3-train is bought. The lead keeps the SHAPE of the
     auction and drops the timing, and the closing line drops the claim about what follows: the labelled
     variant block below states the real trigger, and a claim this page cannot verify is better absent than
     wrong. `auction.lead` itself is untouched -- the Overview renders it. */
  const delayed = applies({ scope: "delayedAuction" });
  const auctionLead = delayed
    ? "The Private Companies are sold through a buy-bid-turn sequence that continues until all of them are purchased."
    : (auctionCard?.lead ?? "");
  const auctionEnds = delayed
    ? "The auction ends when every Private Company has been bought."
    : "The auction ends when every Private Company has been bought. The first Stock Round follows.";

  /* ---- The interrupt: four moves, in the card's own words. ---- */
  const interruptSteps = detailList(detailUnder(auctionDetail, "The interrupt"));

  /* ---- All players pass. Rulebook 1.2.3, two conditions and nothing else. ---- */
  const allPassLines = detailList(detailUnder(auctionDetail, "If nobody buys"));

  /* ---- Rulebook 1.2.2, split into the two things it is: what a bid costs you, and how a contested company
     is settled. Both lists are the card's own. ---- */
  const bidRules = detailList(detailUnder(auctionDetail, "Bidding"));
  const miniAuctionRules = detailList(detailUnder(auctionDetail, "The mini-auction"));
  const miniAuctionLead = detailProse(auctionDetail, "When more than one player has bid");

  /* ---- The cross-round rules. The timing leads each of them, which is what the deleted Timing Quick
     Reference was for. ---- */
  const revenueWhen = detailProse(basicsDetail, "At the beginning of each Operating Round");
  const revenueWho = detailProse(basicsDetail, "A player-owned private company pays its revenue");
  const saleWhen = detailProse(basicsDetail, "Such sales may occur at any time");
  const salePrice = detailProse(basicsDetail, "Private companies may be sold between players");
  const corporationWindow = detailCallout(basicsDetail, "During phases 3 and 4");
  const corporationOneWay = detailProse(basicsDetail, "Corporations may buy private companies, but may not sell them");
  const corporationPrice = detailList(detailUnder(basicsDetail, "Corporation purchase"));
  const closureTable = detailTable(closure?.detail ?? [], "Company");
  const closureRules = detailList(closure?.detail ?? []);

  return (
    <div style={styles.page} data-testid="rules-auction-page">
      {/* ================= AUCTION FLOW ================= */}
      <section ref={auctionLive ? currentRef : undefined} style={styles.block}>
        <div style={styles.sectionHeadingRow}>
          <h3 style={{ ...styles.sectionTitle, color: ACCENT.auction.ink }}>Auction Flow</h3>
          {auctionLive && <span style={styles.currentPill}>← Current</span>}
        </div>
        <p style={styles.opLead} data-testid="rules-auction-lead">
          {auctionLead}
        </p>
        {/* FOR THE PLAYER WHO CAME TO LOOK SOMETHING UP. Most openings of this tab mid-game are "what does the
            D&H do again?", not "teach me the auction" -- so the catalog is one line from the top. */}
        <span style={styles.auLookup}>
          <StockJump to="rules-section-companies">Private companies</StockJump>
        </span>

        {/* THREE ALTERNATIVES, NOT THREE STAGES. No arrows, no fills, no borders: a turn is one of these. */}
        <span style={styles.stripLabel}>An ordinary buy-bid-turn — choose one</span>
        <div className="rr-au-choice" data-testid="rules-auction-choices">
          {AUCTION_CHOICES.map((choice) => (
            <div key={choice.label} style={styles.auChoice}>
              <span style={styles.auChoiceTerm}>{choice.label}</span>
              <span style={styles.auChoiceText}>{choice.text}</span>
            </div>
          ))}
        </div>
        <p style={styles.auFlowCaption}>
          Starting with the holder of the Priority Deal Card, turns proceed clockwise until every Private Company has been bought.
        </p>

        {/* THE BRANCH. What makes this auction hard to learn, one step in from the choice it interrupts. */}
        <AuctionBranch title="Interrupt — the lowest unsold company has a bid" steps={interruptSteps} testId="rules-auction-interrupt">
          <span style={styles.auBranchText}>
            <StockJump to="rules-section-bids">The mini-auction, and what a bid costs</StockJump>
          </span>
        </AuctionBranch>

        {/* The one distinction the interrupt makes that a player will otherwise get wrong. */}
        <div className="rr-op-defs" style={styles.opDefs} data-testid="rules-auction-priority">
          <dt style={{ ...styles.opDefLabel, color: ACCENT.auction.ink }}>Priority Deal Card moves</dt>
          <dd style={styles.opDefText}>When a player buys the lowest unsold company on an ordinary turn — it passes to the player on that buyer&rsquo;s left.</dd>
          <dt style={{ ...styles.opDefLabel, color: ACCENT.auction.ink }}>Priority Deal Card stays</dt>
          <dd style={styles.opDefText}>When a bid or a mini-auction is resolved, and when a player passes. Neither moves the card.</dd>
        </div>

        <AuctionBranch title="If every player passes in succession" lines={allPassLines} testId="rules-auction-all-pass" />

        <p style={styles.auEnds} data-testid="rules-auction-ends">
          {auctionEnds}
        </p>

        {/* VARIANTS AFTER THE BASE PROCEDURE, never inside it: what follows is this table's own setting, not
            a rule from the printed game. */}
        {variantNotes.length > 0 && (
          <div style={styles.auVariant} data-testid="rules-auction-variants">
            <span style={{ ...styles.stripLabel, color: ACCENT.auction.ink }}>Variant in play on this table</span>
            {variantNotes.map((note) => (
              <p key={note.text} style={styles.opProse}>
                <VariantTag scope={note.scope} />
                {note.text}
              </p>
            ))}
          </div>
        )}

        <nav style={styles.jumpRow} aria-label="Auction and Privates sections" data-testid="rules-auction-jump">
          {AUCTION_SECTIONS.map((entry, index) => (
            <React.Fragment key={entry.id}>
              {index > 0 && (
                <span style={styles.jumpDot} aria-hidden="true">
                  ·
                </span>
              )}
              <button type="button" className="rr-link" style={styles.jumpLink} onClick={() => jumpToSection(entry.id)}>
                {entry.label}
              </button>
            </React.Fragment>
          ))}
        </nav>
      </section>

      {/* ================= RESOLVING BIDS ================= */}
      <AuctionSection id="rules-section-bids" title="Resolving bids">
        <div className="rr-op-pair">
          <StockColumn title="Placing a bid">
            <ul style={styles.bullets}>
              {bidRules.map((item) => (
                <li key={item} style={styles.bullet}>
                  {item}
                </li>
              ))}
            </ul>
          </StockColumn>
          <StockColumn title="The mini-auction" lead={miniAuctionLead ?? undefined}>
            <ul style={styles.bullets}>
              {miniAuctionRules.map((item) => (
                <li key={item} style={styles.bullet}>
                  {item}
                </li>
              ))}
            </ul>
          </StockColumn>
        </div>
      </AuctionSection>

      {/* ================= PRIVATE COMPANIES ================= */}
      <AuctionSection id="rules-section-companies" title="Private companies">
        <p style={styles.opProse}>{COMPANIES_INTRO}</p>
        <div style={styles.auRows} data-testid="rules-auction-catalog">
          <div className="rr-au-row rr-au-head" style={styles.auHead}>
            <span style={styles.stripLabel}>Company</span>
            <span style={styles.stripLabel}>What it does</span>
            <span style={styles.stripLabel}>Closes</span>
          </div>
          {rows.map((row) => (
            <div key={row.id} className="rr-au-row" style={styles.auRow} data-testid={`rules-private-${row.abbr}`}>
              <div style={styles.auRowName}>
                <span style={styles.auRowAbbr}>{row.abbr}</span>
                <span style={styles.auRowFull}>
                  {row.name}
                  <VariantTag scope={row.scope} />
                </span>
                <span style={styles.auRowMeta}>
                  ${row.faceValue} · ${row.revenue}/OR · {row.hex}
                </span>
              </div>
              <div style={styles.auRowPower}>
                {row.bullets.map((bullet) => (
                  <span key={bullet} style={styles.auRowBullet}>
                    {bullet}
                  </span>
                ))}
                {row.exceptions.map((note) => (
                  <span key={note} style={styles.auRowNote}>
                    {note}
                  </span>
                ))}
              </div>
              <div className="rr-au-close" style={{ ...styles.auRowClose, ...(row.early ? styles.auRowCloseEarly : {}) }}>
                {row.closes}
              </div>
            </div>
          ))}
        </div>
      </AuctionSection>

      {/* ================= CHANGING HANDS · REVENUE · CLOSURE ================= */}
      <AuctionSection id="rules-section-holding" title={"Changing hands · Revenue · Closure"}>
        <div style={styles.opBlock}>
          <h4 style={styles.opSubTitle}>Revenue while open</h4>
          {revenueWhen && <p style={styles.opProse}>{revenueWhen}</p>}
          {revenueWho && <p style={styles.opProse}>{revenueWho}</p>}
        </div>

        {/* TWO WAYS A PRIVATE CHANGES HANDS, and they share almost nothing -- who, when, at what price, and
            whether it can come back. A comparison, therefore, rather than two paragraphs in sequence. */}
        <div className="rr-op-pair" data-testid="rules-auction-changing-hands">
          <StockColumn title="Player to player" lead={saleWhen ?? undefined}>
            <ul style={styles.bullets}>{salePrice && <li style={styles.bullet}>{salePrice}</li>}</ul>
          </StockColumn>
          <StockColumn title="Player to corporation" lead={corporationWindow ?? undefined}>
            <ul style={styles.bullets}>
              {corporationPrice.map((item) => (
                <li key={item} style={styles.bullet}>
                  {capitalised(item.replace(/,? and$/, "."))}
                </li>
              ))}
              <li style={styles.bullet}>The price must be publicly declared.</li>
              {corporationOneWay && <li style={styles.bullet}>{corporationOneWay}</li>}
            </ul>
          </StockColumn>
        </div>

        <div style={styles.opLookupBlock}>
          <h4 style={styles.opSubTitle}>Closure</h4>
          {closureTable && <RuleTableView table={closureTable} />}
          <ul style={styles.bullets}>
            {closureRules.map((item) => (
              <li key={item} style={styles.bullet}>
                {item}
              </li>
            ))}
          </ul>
        </div>
      </AuctionSection>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* TABLES                                                              */
/* ------------------------------------------------------------------ */

/** ==================================================================
 *   A LOOKUP SHEET IS FOUND BY ITS SECTIONS, NOT READ FROM THE TOP
 *  ==================================================================
 *  The page was two tables and then `Other Reference` -- one heading over a two-column grid holding five
 *  unrelated lookups. Four of the five could not be linked to, none of them appeared anywhere as a name, and
 *  a player who came to check the certificate limit had to recognise it by its shape.
 *
 *  NOW: a text-only `Find a table` directory over seven individually anchored sections. The directory is
 *  GENERATED from the sections, so a link cannot point at one that is not there, and every anchor clears the
 *  sticky page strip by the same 170px the rest of the reference uses.
 *
 *  THE TWO REAL TABLES STAY TABLES. Column headings, right-aligned numbers, a hairline per row and the green
 *  live mark do the work; the phase table is not a row of decorative phase cards. What changed is what they
 *  do when the screen is narrower than they are: the phase column PINS, so the row you are reading -- and the
 *  green mark on it -- stays identified while the rest scrolls under it, and the shared `ScrollingLookup` cue
 *  says so, but only when something is genuinely off the edge.
 *
 *  DERIVED, NOT RESTATED. Player limits come from `gameSetup.ts` and the tile colours from `gamePhase.ts`'s
 *  `tileErasAt`, which is the same call the Overview's Tile Colors cell makes -- so the 18XX+ tile set's Gray
 *  Diesel era (#1312) appears here without this page knowing it exists. */

/** The directory, and the page's own order. Generated from the sections below it: the two tables, then every
 *  reference group in turn. */
const TABLE_SECTIONS: readonly { id: string; label: string }[] = [
  /* PHASES FIRST. It is the table a player opens this page for mid-game -- which colour can I lay, how many
     trains may I hold, how many Operating Rounds are left -- and it answers a question that changes during
     play. Player Limits answers one settled at the table and consulted far less often. */
  { id: "rules-reference-phases", label: "Trains & Phases" },
  { id: "rules-reference-player-limits", label: "Player Limits" },
  ...OTHER_REFERENCE_GROUPS.map((group) => ({ id: group.anchor, label: group.title })),
];

/** Values at or under this many characters stay bold. Chosen from the content rather than guessed: it keeps
 *  every price, every limit, the par list and `The game ends immediately`, and it drops the four explanatory
 *  sentences in Game End, Forced Train Purchase and the corporation-limit row. */
const LOOKUP_EMPHASIS_LIMIT = 36;

/** A lookup section: a hairline, a heading, and the two-column table under it. */
function LookupSection({
  id,
  title,
  aside,
  children,
}: {
  id: string;
  title: string;
  aside?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section id={id} style={styles.opSection}>
      <div style={styles.sectionHeadingRow}>
        <h3 style={styles.opSectionTitle}>{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

function TablesPage({ playerCount, livePhase, plusTiles }: { playerCount: number | null; livePhase: string | null; plusTiles: boolean }) {
  const applies = useInScope();
  /* The Level Playing Field REPLACES the player-count table (seven seats, its own limits), so the player sees
     the one that applies to this table, tagged when it is the variant's. */
  const lpf = applies({ scope: "levelPlayingField" });
  const delayed = applies({ scope: "delayedAuction" });
  const limitRows = PLAYER_LIMIT_ROWS.filter((row) => (lpf ? row.lpfLimit !== null : row.limit !== null));
  return (
    <div style={styles.page} data-testid="rules-tables-page">
      {/* ================= FIND A TABLE ================= */}
      <nav style={styles.tblDirectory} aria-label="Find a table" data-testid="rules-tables-directory">
        <span style={styles.stripLabel}>Find a table</span>
        <span style={styles.jumpRow}>
          {TABLE_SECTIONS.map((entry, index) => (
            <React.Fragment key={entry.id}>
              {index > 0 && (
                <span style={styles.jumpDot} aria-hidden="true">
                  ·
                </span>
              )}
              <button type="button" className="rr-link" style={styles.jumpLink} onClick={() => jumpToSection(entry.id)}>
                {entry.label}
              </button>
            </React.Fragment>
          ))}
        </span>
      </nav>

      {/* ================= TRAINS & PHASES ================= */}
      <LookupSection id="rules-reference-phases" title={"Trains & Phases"} aside={delayed ? <VariantTag scope="delayedAuction" /> : undefined}>
        <ScrollingLookup>
          {/* THE LAST COLUMN GETS A WIDTH. With none, `Also` took whatever was left of the 880 -- about 118px
              -- and wrapped to six or seven lines, which sets the height of every row in a table whose other
              cells are one word. Scrolled sideways behind the pinned phase column that read as rows of empty
              space. A wider column is more to scroll and far less to scroll PAST. */}
          <table style={{ ...styles.table, ...styles.tableFixed, minWidth: "904px" }} data-testid="rules-tables-phases">
            <colgroup>
              <col style={{ width: "58px" }} />
              <col style={{ width: "150px" }} />
              <col style={{ width: "140px" }} />
              <col style={{ width: "82px" }} />
              <col style={{ width: "76px" }} />
              <col style={{ width: "78px" }} />
              <col style={{ width: "80px" }} />
              <col style={{ width: "240px" }} />
            </colgroup>
            <thead>
              <tr>
                {/* THE PHASE COLUMN PINS. Eight columns do not fit a phone, and a row scrolled two columns to
                    the right is a row you can no longer name -- least of all the current one. */}
                <th style={{ ...styles.thWrap, ...styles.tblSticky }}>Phase</th>
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
                const override = delayed ? row.delayed : undefined;
                const begins = override?.begins ?? row.begins;
                const also = override?.also ?? row.also;
                /* `gamePhase.ts` decides which colours a phase permits, including the 18XX+ tile set's Gray. */
                const tiles = row.tier ? tileErasAt(row.tier as TrainTier, plusTiles).join(", ") : "—";
                /* The Track tiles cell SHOWS Gray from the moment this phase opens; this SAYS which purchase
                   opened it, which is the question a player asks the turn before. */
                const unlocks = row.tier ? expandedTileUnlock(row.tier, plusTiles) : null;
                return (
                  <tr key={row.phase} style={{ ...styles.tr, ...(live ? styles.trLive : {}) }}>
                    <td style={{ ...styles.td, ...styles.tdStrong, ...styles.tblSticky, ...(live ? styles.tblStickyLive : {}) }}>
                      {row.phase}
                      {live && <span style={styles.liveDot} aria-label="current phase" />}
                    </td>
                    <td style={styles.td}>
                      {begins}
                      {override?.begins && <VariantTag scope="delayedAuction" />}
                    </td>
                    <td style={styles.td}>{tiles}</td>
                    <td style={{ ...styles.td, ...styles.tdNum, ...styles.tdStrong }}>{row.trainLimit}</td>
                    <td style={{ ...styles.td, ...styles.tdNum, ...styles.tdStrong }}>{row.operatingRounds}</td>
                    <td style={{ ...styles.td, paddingLeft: "18px" }}>{row.offBoard}</td>
                    <td style={styles.td}>{row.buyPrivates}</td>
                    <td style={{ ...styles.td, ...styles.tdMuted }}>
                      {also || "—"}
                      {unlocks && (
                        <span style={styles.tblAlsoVariant} data-testid={`rules-tables-unlock-${row.phase}`}>
                          {unlocks}
                          <VariantTag scope="plusTiles" />
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </ScrollingLookup>
        {/* THE QUALIFIER IS IN THE BASE SENTENCE, not only in the note under it. "the first train of the new
            type" is true of the printed roster, where every type starts a phase; this table has a train type
            that does not, and a reader who takes the rule at its word gets a phase that never arrives. */}
        <p style={styles.tblFootnote}>
          A phase begins immediately after the purchase of the first train of a new{lpf ? " phase-triggering" : ""} type, and a new train limit
          applies at once — the buyer may have to discard. Off-board: which of a red off-board area&rsquo;s two revenue values to use. Train costs and
          what is left in the depot live on the Buy Trains panel.
        </p>
        {lpf && (
          /* THE TWO PURCHASES LOOK ALIKE AND DO OPPOSITE THINGS. Both trains reach the depot together, both
             are a type nobody has bought before, and one of them advances the game while the other does not.
             Naming them separately is the whole point of the note. */
          <p style={styles.tblFootnote} data-testid="rules-tables-lpf-trains">
            <VariantTag scope="levelPlayingField" /> This table adds a 7-train between the 6 and the Diesel, and both become available the moment
            the first 6-train is bought — but only one of them is a phase change. Buying the first{" "}
            <strong style={styles.tblFootnoteTerm}>7-train</strong> leaves Phase 6 in force{plusTiles ? " and opens no new tile colour" : ""}.
            Buying the first <strong style={styles.tblFootnoteTerm}>Diesel</strong> starts Phase D
            {plusTiles ? " and brings the Gray tiles with it" : ""}.
          </p>
        )}
      </LookupSection>

      {/* ================= PLAYER LIMITS ================= */}
      <LookupSection id="rules-reference-player-limits" title="Player Limits" aside={lpf ? <VariantTag scope="levelPlayingField" /> : undefined}>
        <ScrollingLookup>
          <table style={{ ...styles.table, ...styles.tableFixed, minWidth: "360px", maxWidth: "560px" }} data-testid="rules-tables-limits">
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
        </ScrollingLookup>
        <p style={styles.tblFootnote}>
          The certificate limit is the overall limit per player, private company certificates included. The individual corporation limit (5
          certificates) and the Bank Pool limit (5 per corporation) are separate — see Certificates &amp; Shares below.
        </p>
      </LookupSection>

      {/* ================= THE LOOKUP SECTIONS ================= */}
      {OTHER_REFERENCE_GROUPS.map((group) => {
        const rows = group.rows.filter(applies);
        if (rows.length === 0) return null;
        return (
          <LookupSection key={group.anchor} id={group.anchor} title={group.title}>
            <div style={styles.tblLookup}>
              <table style={{ ...styles.table, ...styles.tableFixed, minWidth: 0 }}>
                <colgroup>
                  <col style={{ width: "40%" }} />
                  <col />
                </colgroup>
                <thead>
                  <tr>
                    <th style={styles.thWrap}>{group.heads[0]}</th>
                    <th style={styles.thWrap}>{group.heads[1]}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.label} style={styles.tr}>
                      <td style={{ ...styles.td, ...styles.tdMuted }}>
                        {row.label}
                        <VariantTag scope={row.scope} />
                      </td>
                      {/* WEIGHT FOLLOWS LENGTH. Every value was bold, so `$80` and a sentence about which
                          market boxes lift which limit shouted equally and neither carried. A figure or a
                          verdict short enough to take in at a glance keeps the emphasis; anything that has to
                          be READ drops to normal weight in the same ink, so the column still scans as values
                          rather than as a wall. */}
                      <td style={{ ...styles.td, ...(row.value.length <= LOOKUP_EMPHASIS_LIMIT ? styles.tdStrong : styles.tblValueLong) }}>{row.value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {/* A DEFINITION, NOT A LOOKUP. One row of Game End was "how the winner is worked out", which a
                  trigger/outcome table can only pretend to be. */}
              {group.note && <p style={styles.opProse}>{group.note}</p>}
            </div>
          </LookupSection>
        );
      })}
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
     force. The Level Playing Field's 7-train tier has no rulebook phase and marks nothing.
     NOT PHASE 1 WHEN THE AUCTION IS DELAYED. Phase 1 IS the auction in the printed game, so the live round
     names it; `gameVariants.ts` #905 runs the delayed auction at the end of an Operating Round set in phase 3
     or later, where marking phase 1 current would be a wrong answer rather than a missing one. There the
     train tier still knows which phase is in force, so it is read the same way as in any other round. */
  const livePhase: string | null =
    roundType === "WaterfallAuction" && !activeScopes.has("delayedAuction")
      ? "1"
      : phase
        ? (PHASE_ROWS.find((row) => row.tier === phase.tier)?.phase ?? null)
        : null;

  /* ==================================================================
      OVERVIEW IS WHERE IT OPENS, AND A ROUND CHANGE NEVER MOVES THE PAGE
     ==================================================================
     IT USED TO LAND ON THE LIVE ROUND'S PAGE and re-steer on every round transition. Both halves are dropped,
     for the same reason in two tenses. Overview is now the state-aware dashboard -- the current round, its
     action sequence, the live action and a short explanation of it are all ON it -- so landing on the
     detailed page skipped past the answer to get to the appendix.
     AND THE RE-STEER WAS WORSE THAN REDUNDANT: a player reading the Operating Round's route rules during
     somebody else's turn had the page pulled out from under them the moment the round rolled over. The live
     round still ANNOUNCES itself -- the dot in the strip, the accented crumb, `Go to current →` -- and the
     player decides whether to follow it. `RulesReference` is mounted only while its main tab is active
     (`App.tsx`), so a fresh mount IS a fresh open and this initial value is the whole landing rule. */
  const [section, setSection] = useState<RulesSection>("overview");
  /* Game Flow is collapsed on every open while a round is live -- and OPEN when none is, because with no
     current round the architecture is the only thing the page has to say. Same mechanism either way: a fresh
     mount is a fresh open. */
  const [flowOpen, setFlowOpen] = useState(() => roundType === null);

  /* ---- The Operating Round page. NO OPEN-STATE ANY MORE either: its five sections and its side action are
     all on the page, so the only thing the shell still tracks for it is which sub-phase is live -- for the
     CURRENT mark and for `Go to current →`, both of which read `liveSubPhase` directly. ---- */

  /* ---- The Stock Round page. NO OPEN-STATE ANY MORE: it has no accordions and no bulk toggle, so the only
     thing the shell still tracks for it is WHICH SECTION IS LIVE -- for the CURRENT pill and for
     `Open current rules →`. ---- */
  const liveStock = liveStockKey(roundType === "StockRound", roundType === "StockRound" ? (stockRoundActionProp ?? null) : null);

  /* ---- The Auction & Privates page. NO OPEN-STATE either, now that it has no accordions: the whole
     reference is on the page and the only thing the shell tracks for it is whether the auction is live. ---- */
  const auctionLive = roundType === "WaterfallAuction";

  const currentStepRef = useRef<HTMLDivElement>(null);
  const goToCurrent = () => {
    setSection(livePage);
    // After the page switch commits, bring the live step under the pinned strip.
    window.setTimeout(() => currentStepRef.current?.scrollIntoView({ block: "start", behavior: "smooth" }), 0);
  };

  /* A cross-page link that lands on one exact lookup: switch the page, then bring the anchor up once the new
     page has committed. Without an anchor it is plain navigation. */
  const navigateTo = (target: RulesSection, anchor?: string) => {
    setSection(target);
    if (!anchor) return;
    window.setTimeout(() => document.getElementById(anchor)?.scrollIntoView({ block: "start", behavior: "smooth" }), 0);
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
    <div style={styles.root} className={className ? `${className} rr-root` : "rr-root"}>
      <style>{RULES_REFERENCE_CSS}</style>

      <div style={styles.header}>
        <h2 style={styles.pageTitle}>Rules Reference</h2>
        <span style={styles.rulesetPill}>{rulesetLabel ?? "18XX"}</span>
        {/* Design note #640: the build stamp, quiet, for bug reports. */}
        <span style={styles.buildStamp} title="Quote this in a bug report — it says which build of the interface you are running.">
          {UI_BUILD_LABEL}
        </span>
      </div>

      <div className="rr-nav-strip" style={{ ...styles.navStrip, top: dockOffset }} role="tablist" aria-label="Rules reference pages" onKeyDown={onNavKey}>
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
              /* The active tab keeps the strip's white edge -- the app's own convention for "you are here" --
                 and gains a 2px rule in the page's accent beneath it. The colour is the SECOND signal, never
                 the first, and the live dot beside the label is a third, separate one. */
              style={{
                ...styles.navTab,
                ...(active ? styles.navTabActive : {}),
                ...(active ? { boxShadow: `inset 0 -2px 0 ${accentForSection(entry.id).ink}` } : {}),
              }}
              onClick={() => setSection(entry.id)}
              aria-label={entry.label}
              data-testid={`rules-page-${entry.id}`}
            >
              <Responsive full={entry.label} short={entry.short} />
              {live && <span style={styles.navLiveDot} title="The live round is on this page" />}
            </button>
          );
        })}
      </div>

      <ContextStrip roundType={roundType} operatingSubPhase={liveSubPhase} roundLabel={roundLabel ?? null} activeCorporation={activeCorporation} section={section} onGoToCurrent={goToCurrent} />

      {section === "overview" && (
        <OverviewPage
          roundType={roundType}
          liveSubPhase={liveSubPhase}
          stockAction={roundType === "StockRound" ? (stockRoundActionProp ?? null) : null}
          roundLabel={roundLabel ?? null}
          activeCorporation={activeCorporation}
          livePhase={livePhase}
          playerCount={playerCount ?? null}
          auctionDone={auctionDone}
          flowOpen={flowOpen}
          onToggleFlow={() => setFlowOpen((wasOpen) => !wasOpen)}
          onNavigate={setSection}
          onNavigateTo={navigateTo}
        />
      )}
      {section === "stock" && (
        <StockRoundPage
          liveKey={liveStock}
          firstStockRound={firstStockRoundFrom(roundType, roundLabel ?? null)}
          currentRef={currentStepRef}
          onNavigateTo={navigateTo}
        />
      )}
      {section === "operating" && (
        <OperatingRoundPage liveSubPhase={liveSubPhase} currentRef={currentStepRef} onNavigateTo={navigateTo} />
      )}
      {section === "auction" && (
        <AuctionPage auctionLive={auctionLive} currentRef={currentStepRef} />
      )}
      {section === "tables" && <TablesPage playerCount={playerCount ?? null} livePhase={livePhase} plusTiles={activeScopes.has("plusTiles")} />}
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
.rr-nav-tab { padding: 6px 14px; transition: color 120ms ease, border-color 120ms ease, background-color 120ms ease; }
.rr-nav-tab:hover { color: ${INK_TEXT}; background-color: ${INK_RAISED}; border-color: ${RULE_STRONG}; }
.rr-nav-tab:focus-visible { outline: 2px solid ${INK_TEXT_FAINT}; outline-offset: -2px; }
.rr-nav-tab-active:hover { border-color: rgba(242, 240, 235, 0.8); }
.rr-link:hover { color: ${INK_TEXT}; text-decoration: underline; }
.rr-link:focus-visible { outline: 2px solid ${INK_TEXT_FAINT}; outline-offset: 2px; border-radius: ${RADIUS.control}; }
.rr-chip { transition: border-color 120ms ease, color 120ms ease, background-color 120ms ease; }
.rr-chip:hover { border-color: ${RULE_STRONG}; color: ${INK_TEXT}; background-color: ${INK_RAISED}; }
.rr-chip:focus-visible { outline: 2px solid ${INK_TEXT_FAINT}; outline-offset: 2px; }
/* The Overview's current-round column and its Watch For column do different jobs, so on a wide screen they
   stand side by side and asymmetrically rather than stacking into one long scroll. One column below that. */
.rr-round-grid { display: grid; grid-template-columns: minmax(0, 1fr); gap: 20px 40px; align-items: start; }
@media (min-width: 1100px) { .rr-round-grid { grid-template-columns: minmax(0, 2.2fr) minmax(0, 1fr); } }
/* ==================================================================
    THE NARROW RULES, AND WHY THEY ARE CSS RATHER THAN STYLE OBJECTS
   ==================================================================
   REPORTED off the 430px capture: a three-row page strip, a tall context card, a wrapped flow line and a
   three-row data grid spent the whole first screen, and the Current Round began below the fold. Everything
   below buys that space back. It is real CSS because a media query cannot be expressed in an inline
   React.CSSProperties object -- and because an inline value WINS over a class, the properties these override
   (padding, margin, flex-wrap) are declared here rather than in the style objects. Moving one of them back
   into a style object silently disables the narrow rule for it.
   NO BACKTICKS IN THIS BLOCK: it lives inside a template literal, and one would end the string. */
.rr-root { margin: 0 20px 20px; padding: 0 28px 36px; }
.rr-nav-strip { flex-wrap: wrap; }
.rr-nav-tab { font-size: ${FONT_SIZE.control}; }
.rr-context { padding: 8px 14px; margin-bottom: 14px; gap: 10px; min-height: 22px; }
.rr-crumbs { font-size: ${FONT_SIZE.strong}; }
.rr-chain { gap: 8px; }
.rr-action-row { flex-wrap: wrap; }
.rr-narrow { display: none; }
/* ==================================================================
    THE STOCK ROUND PAGE'S COLUMNS
   ==================================================================
   Narrow first: everything stacks, hairlines run across. From 900px the pairs stand side by side with a
   VERTICAL hairline between them and the cadence becomes three aligned columns. Grid rather than flex, so a
   long sentence in one column cannot change the other's width; minmax(0, 1fr) so a wide table inside one
   scrolls itself instead of widening the page. */
.rr-stock-turn { display: flex; align-items: flex-end; gap: 10px; flex-wrap: nowrap; overflow-x: auto; padding-bottom: 4px; }
.rr-stock-pair, .rr-op-pair { display: grid; grid-template-columns: minmax(0, 1fr); gap: 20px; }
.rr-stock-pair > * + *, .rr-op-pair > * + * { border-top: 1px solid #2a2a2a; padding-top: 18px; }
.rr-cadence { display: grid; grid-template-columns: minmax(0, 1fr); }
.rr-cadence > * { display: flex; flex-direction: column; gap: 3px; padding: 9px 0; }
.rr-cadence > * + * { border-top: 1px solid #2a2a2a; }
.rr-stock-seq { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; }
@media (min-width: 900px) {
  .rr-stock-pair, .rr-op-pair { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 0; }
  .rr-stock-pair > *:first-child, .rr-op-pair > *:first-child { padding-right: 32px; }
  .rr-stock-pair > * + *, .rr-op-pair > * + * { border-top: none; padding-top: 0; border-left: 1px solid #2a2a2a; padding-left: 32px; }
  .rr-cadence { grid-template-columns: repeat(3, minmax(0, 1fr)); border-top: 1px solid #2a2a2a; }
  .rr-cadence > * { padding: 10px 22px 0 0; }
  .rr-cadence > * + * { border-top: none; border-left: 1px solid #2a2a2a; padding-left: 22px; }
  .rr-stock-seq { flex-direction: row; align-items: center; flex-wrap: wrap; gap: 6px 10px; }
}
/* ==================================================================
    THE OPERATING ROUND PAGE
   ==================================================================
   THE FLOW WRAPS, IT DOES NOT SCROLL. Five stages at phone width are two or three short rows, and a row that
   wraps hides nothing -- where a row that scrolls hides whatever is past the edge, which on a reference page
   is the half of the turn nobody knows to look for.
   The .rr-op-pair class is the Stock page's column pair under its own name: one grid definition, one
   hairline rule, two pages, so the two never drift into different column behaviour.
   NO BACKTICKS IN THIS BLOCK: it lives inside a template literal, and one would end the string. */
.rr-op-flow { display: flex; flex-wrap: wrap; align-items: baseline; gap: 10px 12px; }
.rr-op-stage { transition: color 120ms ease, border-color 120ms ease; }
.rr-op-stage:hover { color: ${INK_TEXT}; border-bottom-color: ${ACCENT.operating.ink}; }
.rr-op-stage:focus-visible { outline: 2px solid ${INK_TEXT_FAINT}; outline-offset: 3px; }
/* Definitions: stacked with the term above its rule when narrow, two columns when there is room for them. */
.rr-op-defs { display: grid; grid-template-columns: minmax(0, 1fr); }
.rr-op-defs > dt { padding-top: 10px; }
.rr-op-defs > dd { padding-bottom: 10px; border-bottom: 1px solid ${RULE}; }
@media (min-width: 761px) {
  .rr-op-defs { grid-template-columns: 190px minmax(0, 1fr); }
  .rr-op-defs > dt { padding: 10px 18px 10px 0; border-top: 1px solid ${RULE}; }
  .rr-op-defs > dd { padding: 10px 0; border-top: 1px solid ${RULE}; border-bottom: none; }
}
/* ==================================================================
    THE AUCTION AND PRIVATES PAGE
   ==================================================================
   THREE CHOICES, NOT THREE STAGES: a grid of equal columns with hairlines between them at width, stacked
   below. The catalog is the same idea with three unequal columns -- who, what it does, when it closes.
   NO BACKTICKS IN THIS BLOCK: it lives inside a template literal, and one would end the string. */
.rr-au-choice { display: grid; grid-template-columns: minmax(0, 1fr); gap: 14px; }
.rr-au-choice > * + * { border-top: 1px solid ${RULE}; padding-top: 14px; }
.rr-au-row { display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; align-items: start; }
@media (min-width: 761px) {
  .rr-au-choice { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0; }
  .rr-au-choice > * { padding-right: 24px; }
  .rr-au-choice > * + * { border-top: none; padding-top: 0; border-left: 1px solid ${RULE}; padding-left: 24px; }
  .rr-au-row { grid-template-columns: minmax(0, 200px) minmax(0, 76ch) minmax(0, 150px); gap: 0 24px; justify-content: start; }
}
@media (max-width: 760px) {
  /* Stacked, the catalog's column headings become three orphan labels above the first company, so they go --
     and the one cell that is not self-describing without them says what it is instead. */
  .rr-au-head { display: none; }
  .rr-au-close::before { content: "Closes: "; }
  .rr-root { margin: 0 8px 12px; padding: 0 14px 24px; }
  /* ONE ROW THAT SCROLLS, never three that wrap: a wrapped strip pushes the page down by its own height. */
  .rr-nav-strip { flex-wrap: nowrap; overflow-x: auto; overflow-y: hidden; }
  .rr-nav-tab { padding: 5px 9px; font-size: ${FONT_SIZE.small}; }
  .rr-context { padding: 6px 10px; margin-bottom: 10px; gap: 2px 8px; min-height: 0; }
  /* Two compact lines, not one breadcrumb per line. */
  .rr-crumbs { font-size: ${FONT_SIZE.body}; }
  .rr-chain { gap: 5px; }
  /* The five-cell strip over two columns would otherwise end on a half-row. */
  .rr-glance-last { grid-column: 1 / -1; }
  /* The five operating steps stay ONE sequence, scrolled sideways -- stacked, they are a screen of their own
     and the order stops reading as an order. */
  .rr-action-row { flex-wrap: nowrap; overflow-x: auto; padding-bottom: 6px; }
  .rr-wide { display: none; }
  .rr-narrow { display: inline; }
}
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
       where the tab strip attaches, 20px inset standing in for `canvasPane`. THE INSET AND THE PADDING LIVE
       IN `.rr-root`, not here: an inline value cannot be narrowed by a media query, and 96px of horizontal
       chrome on a 430px screen is most of a column. */
    backgroundColor: INK_VIEWPORT,
    border: "1px solid #2a2a2a",
    borderRadius: VIEWPORT_RADIUS,
    display: "flex",
    flexDirection: "column",
    /* No top padding: the sticky strip pins flush to the scroll edge, and the header carries its own. */
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
    /* `flex-wrap` is `.rr-nav-strip`'s, so the narrow rule can turn it into one scrolling row. */
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
    fontWeight: 700,
    letterSpacing: "0.05em",
    textTransform: "uppercase",
    /* `padding` and `font-size` are `.rr-nav-tab`'s, so the narrow rule can tighten them. */
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
    /* `padding`, `margin-bottom`, `gap` and `min-height` are `.rr-context`'s: at phone width this was a
       thickly padded card three lines tall, one breadcrumb per line. */
    backgroundColor: INK,
    border: `1px solid ${RULE_STRONG}`,
    borderRadius: RADIUS.card,
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
  /* `font-size` is `.rr-crumbs`'s: at 15px the breadcrumb pushed the CURRENT pill onto a line of its own. */
  contextCrumbs: { display: "inline-flex", alignItems: "baseline", flexWrap: "wrap", gap: "6px" },
  contextCrumb: { color: INK_TEXT_DIM, fontWeight: 600 },
  contextCrumbLast: { color: INK_TEXT, fontWeight: 700 },
  contextArrow: { color: INK_TEXT_DIMMEST },
  contextMuted: { fontSize: FONT_SIZE.body, fontStyle: "italic", color: INK_TEXT_DIMMEST },

  // ---- Page scaffolding: whitespace and headings, not containers ----
  page: { display: "flex", flexDirection: "column", gap: "34px", minWidth: 0 },
  block: { display: "flex", flexDirection: "column", gap: "12px", minWidth: 0 },
  sectionHeadingRow: { display: "flex", alignItems: "baseline", flexWrap: "wrap", gap: "12px" },
  sectionTitle: { fontSize: FONT_SIZE.small, textTransform: "uppercase", letterSpacing: "0.1em", fontWeight: 700, color: INK_TEXT_FAINT, margin: 0 },
  linkButton: { background: "none", border: "none", padding: 0, fontFamily: "inherit", fontSize: FONT_SIZE.small, fontWeight: 600, color: INK_TEXT_FAINT, cursor: "pointer" },
  footnote: { margin: 0, fontSize: FONT_SIZE.small, color: INK_TEXT_DIMMEST, lineHeight: 1.5 },
  /* Overview is denser than the procedural pages on purpose: everything on it has to be reachable without
     scrolling for what the current round and action are. The other four pages keep `page`. */
  overviewPage: { display: "flex", flexDirection: "column", gap: "22px", minWidth: 0 },
  stripLabel: { fontSize: FONT_SIZE.micro, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase", color: INK_TEXT_FAINT },
  blockHead: { display: "flex", alignItems: "baseline", flexWrap: "wrap", gap: "12px" },
  blockHeadLink: { marginLeft: "auto", whiteSpace: "nowrap" },

  // ---- Text ----
  lead: { margin: 0, fontSize: FONT_SIZE.strong, fontWeight: 600, color: INK_TEXT, lineHeight: 1.45, maxWidth: "88ch" },
  prose: { margin: 0, fontSize: FONT_SIZE.body, color: INK_TEXT_DIM, lineHeight: 1.6, maxWidth: "76ch" },
  bullets: { margin: 0, padding: "0 0 0 18px", display: "flex", flexDirection: "column", gap: "5px", maxWidth: "88ch" },
  bullet: { fontSize: FONT_SIZE.body, color: INK_TEXT_DIM, lineHeight: 1.5 },
  docHeading: { fontSize: FONT_SIZE.small, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: INK_TEXT_MUTED },


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

  // ---- Overview: Game Flow, one hairlined line ----
  /* A DISCLOSURE, NOT A ROW OF CARDS. Two hairlines and eight pixels: the whole element is the height of one
     line of type, which is what "collapsed by default" has to mean if it is to buy back any space. */
  flowStrip: { borderTop: `1px solid ${RULE}`, borderBottom: `1px solid ${RULE}`, padding: "8px 0" },
  flowHeadRow: { display: "flex", alignItems: "baseline", gap: "12px", marginBottom: "5px" },
  /* `gap` is `.rr-chain`'s, so the narrow rule can pull the line back onto one row. */
  chain: { display: "flex", alignItems: "center", flexWrap: "wrap" },
  chainItem: { display: "inline-flex", alignItems: "baseline", gap: "6px", background: "none", border: "none", padding: 0, fontFamily: "inherit", cursor: "pointer" },
  chainGroup: { display: "inline-flex", alignItems: "center", gap: "inherit", flex: "0 0 auto" },
  chainName: { fontSize: FONT_SIZE.control, fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase", whiteSpace: "nowrap" },
  /* Completed: dimmed AND ticked. Two channels, because the tick alone is small and the dim alone is colour. */
  chainNameDone: { color: INK_TEXT_DIMMEST },
  chainTick: { fontSize: FONT_SIZE.small, color: INK_TEXT_DIMMEST },
  chainState: { fontSize: FONT_SIZE.micro, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: INK_TEXT_FAINT, whiteSpace: "nowrap" },
  chainStateLive: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 700,
    letterSpacing: "0.06em",
    textTransform: "uppercase",
    padding: "1px 7px",
    borderRadius: RADIUS.pill,
    backgroundColor: LIVE_FILL,
    color: LIVE_INK,
    border: `1px solid ${LIVE_EDGE}`,
    whiteSpace: "nowrap",
  },
  chainArrow: { fontSize: FONT_SIZE.control, color: INK_TEXT_DIMMEST, lineHeight: 1 },
  /* The glyph carries the repetition alone; the words that used to sit beside it made the line wrap. */
  chainLoop: { fontSize: FONT_SIZE.control, color: INK_TEXT_MUTED, lineHeight: 1, margin: "0 2px" },
  stripToggle: {
    marginLeft: "auto",
    background: "none",
    border: "none",
    padding: 0,
    fontFamily: "inherit",
    fontSize: FONT_SIZE.small,
    fontWeight: 700,
    letterSpacing: "0.06em",
    textTransform: "uppercase",
    color: INK_TEXT_FAINT,
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  /* Open content is INDENTED under a hairline, never boxed -- and nothing inside it is boxed either. */
  flowOpen: {
    marginTop: "12px",
    paddingLeft: "14px",
    borderLeft: `2px solid ${RULE}`,
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))",
    gap: "12px 24px",
  },
  flowOpenItem: { display: "flex", flexDirection: "column", gap: "4px", minWidth: 0, paddingTop: "8px" },
  flowOpenName: { fontSize: FONT_SIZE.small, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase" },
  flowOpenText: { fontSize: FONT_SIZE.small, color: INK_TEXT_MUTED, lineHeight: 1.45 },
  flowOpenLink: { fontSize: FONT_SIZE.small },

  // ---- Overview: At a Glance, one data strip ----
  /* HAIRLINES MADE OF THE GAP, not of five borders. The grid's own background shows through a 1px gap, so
     every separator is exactly one pixel, every wrap keeps the strip a strip, and no cell can acquire a
     corner radius or a fill of its own and quietly become a card again. */
  /* THE HAIRLINES ARE THE CELLS' OWN, not a coloured gap showing through. The gap version was one line
     shorter and drew a grey slab wherever a wrapped row was half full -- five cells over two columns leaves
     one empty, and an empty grid area painted in the separator colour reads as a sixth, broken cell. Each
     cell carries its top and left rule instead, so a short last row simply ends. */
  glanceGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(148px, 1fr))", gap: 0, borderBottom: `1px solid ${RULE}` },
  glanceCell: {
    display: "flex",
    flexDirection: "column",
    gap: "2px",
    padding: "8px 14px 9px",
    borderTop: `1px solid ${RULE}`,
    borderLeft: `1px solid ${RULE}`,
    minWidth: 0,
  },
  glanceLabel: { fontSize: FONT_SIZE.micro, fontWeight: 700, letterSpacing: "0.09em", textTransform: "uppercase" },
  glanceValue: { fontSize: "19px", fontWeight: 700, color: INK_TEXT, lineHeight: 1.15, fontVariantNumeric: "tabular-nums" },
  glanceValueText: { fontSize: FONT_SIZE.heading, lineHeight: 1.3 },
  glanceNote: { fontSize: FONT_SIZE.small, color: INK_TEXT_FAINT, lineHeight: 1.35 },
  /* The tile key stands where a cell's strong value stands, at the same height: glyph, name, glyph, name,
     across the cell -- and across the whole final row at phone width, where `.rr-glance-last` spans. */
  /* The hexes stand where a cell's strong value stands. WRAP, NEVER SHRINK: `flex: 0 0 auto` on each one, so
     a four-colour late game either keeps its row or takes a second one at full size. */
  tileKey: { display: "flex", alignItems: "center", flexWrap: "wrap", gap: "4px 8px", minHeight: "28px" },
  tileKeyItem: { display: "inline-flex", alignItems: "center", flex: "0 0 auto" },

  // ---- Overview: the current round ----
  roundHead: { display: "flex", alignItems: "baseline", flexWrap: "wrap", gap: "10px" },
  roundKicker: { fontSize: FONT_SIZE.micro, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase" },
  roundName: { margin: 0, fontSize: FONT_SIZE.heading, fontWeight: 700, color: INK_TEXT, letterSpacing: "0.01em" },
  roundMeta: { fontFamily: FONT_FAMILY_MONO, fontSize: FONT_SIZE.small, color: INK_TEXT_MUTED },
  /* The round's accent as a 2px rule under its name: page identity, never on its own. */
  roundRule: { height: "2px", margin: "2px 0 4px", maxWidth: "280px" },
  roundIntro: { margin: "0 0 2px", fontSize: FONT_SIZE.body, color: INK_TEXT_MUTED, lineHeight: 1.5 },
  /* `flex-wrap` is `.rr-action-row`'s -- see the narrow rules. */
  actionRow: { display: "flex", alignItems: "stretch", gap: "6px" },
  /* The one rounded bordered surface left on this page, and it is a control. */
  actionChip: {
    display: "inline-flex",
    flexDirection: "column",
    alignItems: "flex-start",
    /* ==================================================================
        NO SHRINKING, AND `minWidth: 0` WAS THE OTHER HALF OF THE BUG
       ==================================================================
       REPRODUCIBLE, not a stale render: at phone width `.rr-action-row` is `flex-wrap: nowrap`, and flex
       items shrink by default. Five chips plus the side action were compressed below their content width
       while their labels kept `white-space: nowrap`, so each label overflowed its own chip and printed on top
       of the next one. `flex: 0 0 auto` is the fix -- the chips keep their width and the ROW scrolls -- and
       the `minWidth: 0` that used to sit here is gone with it, because a floor of zero is exactly the
       permission that made the overlap possible. */
    flex: "0 0 auto",
    gap: "1px",
    padding: "6px 11px",
    borderRadius: RADIUS.control,
    /* LONGHANDS, per design note #840: `actionChipLive` overrides the colour and `actionChipPreview` the
       style, and a `border` shorthand underneath them is a collision React warns about and a browser
       resolves by accident. */
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: RULE,
    backgroundColor: "transparent",
    color: INK_TEXT_DIM,
    fontFamily: "inherit",
    cursor: "pointer",
    textAlign: "left",
  },
  /* LIVE: filled, green-edged, underlined in green, and it says `Current` in words. */
  actionChipLive: { borderColor: LIVE_EDGE, backgroundColor: LIVE_FILL, color: INK_TEXT, boxShadow: `inset 0 -2px 0 ${LIVE_INK}` },
  /* PREVIEW: a dashed edge and nothing else. Deliberately the weaker of the two, and never green. */
  actionChipPreview: { borderStyle: "dashed", borderColor: INK_TEXT_FAINT, color: INK_TEXT },
  actionChipLabel: { display: "inline-flex", alignItems: "baseline", gap: "7px", fontSize: FONT_SIZE.control, fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase", whiteSpace: "nowrap" },
  actionChipNumber: { fontFamily: FONT_FAMILY_MONO, fontSize: FONT_SIZE.small, color: INK_TEXT_FAINT },
  actionChipSub: { fontSize: FONT_SIZE.small, fontWeight: 400, color: INK_TEXT_FAINT, whiteSpace: "nowrap", textTransform: "none", letterSpacing: 0 },
  actionChipNow: { fontSize: FONT_SIZE.micro, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: LIVE_INK },
  actionArrow: { flex: "0 0 auto", alignSelf: "center", fontSize: FONT_SIZE.control, color: INK_TEXT_DIMMEST },
  /* Buy Private Company: ONE DASHED RULE beneath the sequence. A bordered box sitting in the row read as a
     sixth chip; an annotation under a dashed rule reads as what it is. */
  /* The turn flow's own annotation line: the Overview's register (small, dim) rather than the Operating
     Round page's opening-statement weight, because here the live chips above it are the point. The dashed
     rule belongs to the side action below, which is a different KIND of thing -- another action -- so this
     note carries no rule of its own and the one rule on the block still separates the two. */
  flowNote: { margin: "9px 0 0", fontSize: FONT_SIZE.small, color: INK_TEXT_DIM, lineHeight: 1.7, maxWidth: "62ch" },
  asideAction: {
    display: "flex",
    alignItems: "baseline",
    flexWrap: "wrap",
    gap: "4px 8px",
    margin: "9px 0 0",
    paddingTop: "8px",
    borderTop: `1px dashed ${RULE_STRONG}`,
    maxWidth: "62ch",
  },
  // #1449: `borderTop`, the property the base declares -- a bare `borderTopColor` is removable.
  asideActionLive: { borderTop: `1px dashed ${LIVE_EDGE}`, boxShadow: `inset 2px 0 0 ${LIVE_INK}`, paddingLeft: "10px" },
  asideDash: { color: INK_TEXT_DIMMEST, fontSize: FONT_SIZE.small },
  asideTag: { fontSize: FONT_SIZE.micro, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: INK_TEXT_FAINT },
  asideTitle: { display: "inline-flex", alignItems: "baseline", gap: "7px", fontSize: FONT_SIZE.small, fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase", color: INK_TEXT_DIM },

  // ---- Overview: the current action's explanation ----
  explain: { display: "flex", flexDirection: "column", gap: "7px", marginTop: "12px" },
  explainHead: { display: "flex", alignItems: "baseline", flexWrap: "wrap", gap: "9px" },
  explainKicker: { fontSize: FONT_SIZE.micro, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase" },
  explainTitle: { fontSize: FONT_SIZE.strong, fontWeight: 700, color: INK_TEXT },
  explainLead: { margin: 0, fontSize: FONT_SIZE.strong, fontWeight: 600, color: INK_TEXT, lineHeight: 1.45, maxWidth: "62ch" },
  explainBullets: { margin: 0, padding: "0 0 0 18px", display: "flex", flexDirection: "column", gap: "4px", maxWidth: "66ch" },
  explainFoot: { display: "flex", alignItems: "baseline", flexWrap: "wrap", gap: "16px", marginTop: "2px" },

  // ---- Overview: the one compact lookup ----
  lookup: { display: "flex", flexDirection: "column", gap: "5px", marginTop: "16px", maxWidth: "460px" },
  lookupTable: { borderCollapse: "collapse", fontSize: FONT_SIZE.small, width: "100%" },
  lookupTh: { textAlign: "left", padding: "3px 12px 3px 0", color: INK_TEXT_FAINT, fontSize: FONT_SIZE.micro, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", borderBottom: `1px solid ${RULE}`, whiteSpace: "nowrap" },
  lookupTd: { padding: "4px 12px 4px 0", color: INK_TEXT_DIM, borderBottom: `1px solid ${RULE}`, lineHeight: 1.4, verticalAlign: "top" },
  lookupTdStrong: { color: INK_TEXT, fontWeight: 600, whiteSpace: "nowrap" },
  lookupNum: { textAlign: "right", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap", paddingRight: 0 },
  lookupLink: { fontSize: FONT_SIZE.small },

  // ---- Overview: Watch For ----
  /* A MEASURE, NOT A WIDTH. These are sentences a player reads under time pressure; at 62ch they are two or
     three lines, and at the full width of a 1440px viewport they were one very long one. */
  watchList: { listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column" },
  watchItem: { display: "flex", flexDirection: "column", gap: "3px", padding: "9px 0", borderTop: `1px solid ${RULE}`, maxWidth: "62ch" },
  watchHead: { display: "flex", alignItems: "center", gap: "7px" },
  watchLabel: { fontSize: FONT_SIZE.micro, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase" },
  watchText: { fontSize: FONT_SIZE.body, color: INK_TEXT_DIM, lineHeight: 1.5 },
  /* The orange mark is SPENT, not sprinkled: a forced purchase and a bankruptcy, and nothing else. */
  watchMark: {
    flex: "0 0 auto",
    width: "15px",
    height: "15px",
    borderRadius: RADIUS.circle,
    border: `1px solid ${WARN_INK}`,
    color: WARN_INK,
    fontSize: FONT_SIZE.micro,
    fontWeight: 700,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
  },

  // ---- Overview: Game End, three lines ----
  endStrip: { display: "flex", flexDirection: "column" },
  endRow: { display: "flex", flexWrap: "wrap", gap: "2px 14px", padding: "7px 0", borderTop: `1px solid ${RULE}` },
  endTerm: { flex: "0 0 auto", minWidth: "104px", fontSize: FONT_SIZE.small, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase" },
  /* NOT Overview's. `endTitle` dresses the Auction page's interrupt lead and was carried off with the old
     Game End list when that was replaced -- a silent dim on a page this pass is not supposed to touch. */
  endText: { flex: "1 1 340px", fontSize: FONT_SIZE.body, color: INK_TEXT_DIM, lineHeight: 1.5, maxWidth: "76ch" },

  // ---- Stock Round page ----
  /* Sections are separated by space and a hairline, and each is a jump target that has to clear the sticky
     page strip -- the same 170px the Tables anchors use. */
  stockSection: { display: "flex", flexDirection: "column", gap: "12px", minWidth: 0, paddingTop: "22px", borderTop: `1px solid ${RULE}`, scrollMarginTop: "170px" },
  stockAnchored: { minWidth: 0, scrollMarginTop: "170px" },
  stockPairSection: { minWidth: 0, paddingTop: "22px", borderTop: `1px solid ${RULE}` },
  stockColumn: { display: "flex", flexDirection: "column", gap: "8px", minWidth: 0, alignItems: "flex-start" },
  stockColumnTitle: { margin: 0, fontSize: FONT_SIZE.heading, fontWeight: 700, color: INK_TEXT, letterSpacing: "0.01em" },
  stockColumnLead: { margin: 0, fontSize: FONT_SIZE.body, color: INK_TEXT_MUTED, lineHeight: 1.5, maxWidth: "62ch" },
  stockRuleStrong: { margin: 0, fontSize: FONT_SIZE.strong, fontWeight: 600, color: INK_TEXT, lineHeight: 1.45, maxWidth: "58ch" },
  /* THE TURN, AS A SHAPE. An accent rule under each stage, and no border anywhere -- a bordered chip is a
     button, and none of these is one. */
  stockTurn: { minWidth: 0 },
  stockTurnStage: { display: "flex", flexDirection: "column", gap: "2px", flex: "0 0 auto", paddingBottom: "6px", borderBottom: `2px solid ${ACCENT.stock.rule}` },
  stockTurnLabel: { fontSize: FONT_SIZE.control, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: INK_TEXT, whiteSpace: "nowrap" },
  stockTurnSub: { fontSize: FONT_SIZE.small, color: INK_TEXT_FAINT, whiteSpace: "nowrap" },
  stockTurnArrow: { flex: "0 0 auto", alignSelf: "center", fontSize: FONT_SIZE.control, color: INK_TEXT_DIMMEST, paddingBottom: "6px" },
  /* The first-round qualifier: a sentence in the warning ink, no icon and no box -- the Sell section keeps
     the rule itself, and this only says that it is in force right now. */
  stockFirstRound: { margin: "2px 0 0", fontSize: FONT_SIZE.body, fontWeight: 600, color: WARN_INK, lineHeight: 1.5, maxWidth: "62ch" },
  cadenceLabel: { fontSize: FONT_SIZE.micro, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase" },
  cadenceText: { fontSize: FONT_SIZE.body, color: INK_TEXT_DIM, lineHeight: 1.5, maxWidth: "52ch" },
  /* A findability aid, not a tab bar: words, dots, and the page's own link style. */
  jumpRow: { display: "flex", alignItems: "baseline", flexWrap: "wrap", gap: "4px 8px", paddingBottom: "2px" },
  jumpLink: { background: "none", border: "none", padding: 0, fontFamily: "inherit", fontSize: FONT_SIZE.small, fontWeight: 700, letterSpacing: "0.07em", textTransform: "uppercase", color: INK_TEXT_FAINT, cursor: "pointer" },
  jumpDot: { color: INK_TEXT_DIMMEST, fontSize: FONT_SIZE.small },
  seqStage: { fontSize: FONT_SIZE.control, fontWeight: 700, letterSpacing: "0.03em", color: INK_TEXT, paddingBottom: "4px", borderBottom: `2px solid ${ACCENT.stock.rule}` },
  seqArrow: { fontSize: FONT_SIZE.control, color: INK_TEXT_DIMMEST, paddingBottom: "4px" },
  stockLookup: { display: "flex", flexDirection: "column", gap: "6px", minWidth: 0, marginTop: "6px" },
  /* The overflow cue: one muted line under the table it belongs to. The arrow points the way the content
     continues; the words are what carries it for anyone who cannot see the arrow. */
  scrollCue: { fontSize: FONT_SIZE.small, color: INK_TEXT_FAINT, lineHeight: 1.4, paddingTop: "2px" },
  /* The chart's own zone colour, as a small marker beside the zone's name -- never the name's only carrier.
     A DOT, ON THE TOKEN. It was authored as a 9px square with a hand-written 2px radius, which the radius
     scale has no step for and `shapeAndPlacement.test.ts` rightly refuses. `RADIUS.circle` is what every
     other small colour marker in this app already uses -- `EpilogueCharts`'s chart-legend swatch, the
     Lobby's chain dot, the roster dot, and this file's own live dots. */
  zoneSwatch: { display: "inline-block", width: "9px", height: "9px", borderRadius: RADIUS.circle, marginRight: "8px", verticalAlign: "baseline" },

  // ---- Operating Round page ----
  /* THE SPINE. A hairline and space between sections, never a card; each is a jump target that has to clear
     the sticky page strip -- the same 170px the Stock sections and the Tables anchors use. */
  opSection: { display: "flex", flexDirection: "column", gap: "12px", minWidth: 0, paddingTop: "20px", borderTop: `1px solid ${RULE}`, scrollMarginTop: "170px" },
  /* THE MEASURE. Everything on this page that is not a table, a pair or a lookup is one column this wide;
     the shared 76ch/88ch caps were written for pages that put their text inside a column already. */
  opMeasure: { maxWidth: "68ch", minWidth: 0 },
  opLead: { margin: 0, fontSize: FONT_SIZE.strong, fontWeight: 600, color: INK_TEXT, lineHeight: 1.45, maxWidth: "62ch" },
  opSectionNumber: { fontSize: FONT_SIZE.heading, fontWeight: 700, lineHeight: 1, color: ACCENT.operating.ink, fontVariantNumeric: "tabular-nums" },
  opSectionNumberLive: { color: LIVE_INK },
  opSectionTitle: { margin: 0, fontSize: FONT_SIZE.heading, fontWeight: 700, color: INK_TEXT, letterSpacing: "0.01em" },
  /* THE TURN, AS A SHAPE. A word over an accent rule: no fill, no border box, nothing that reads as a move in
     the game. It scrolls to its own section, which is navigation. */
  opFlow: { minWidth: 0 },
  opFlowStage: {
    display: "inline-flex",
    alignItems: "baseline",
    gap: "7px",
    background: "none",
    borderStyle: "none",
    borderWidth: 0,
    borderBottomStyle: "solid",
    borderBottomWidth: "2px",
    borderBottomColor: ACCENT.operating.rule,
    padding: "0 0 5px",
    fontFamily: "inherit",
    color: INK_TEXT,
    cursor: "pointer",
    flex: "0 0 auto",
  },
  opFlowStageLive: { borderBottomColor: LIVE_INK },
  opFlowNumber: { fontSize: FONT_SIZE.small, fontWeight: 700, color: ACCENT.operating.ink, fontVariantNumeric: "tabular-nums" },
  opFlowNumberLive: { color: LIVE_INK },
  opFlowLabel: { fontSize: FONT_SIZE.control, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: "inherit", whiteSpace: "nowrap" },
  opFlowNow: { fontSize: FONT_SIZE.micro, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: LIVE_INK, whiteSpace: "nowrap" },
  opFlowArrow: { flex: "0 0 auto", fontSize: FONT_SIZE.control, color: INK_TEXT_DIMMEST, paddingBottom: "5px" },
  /* The two things beside the flow that are NOT stages: a dashed tag, then the sentence. */
  opAsideTag: {
    display: "inline-block",
    fontSize: FONT_SIZE.micro,
    fontWeight: 700,
    letterSpacing: "0.06em",
    textTransform: "uppercase",
    padding: "1px 7px",
    marginRight: "9px",
    borderRadius: RADIUS.pill,
    border: `1px dashed ${RULE_STRONG}`,
    color: INK_TEXT_MUTED,
    whiteSpace: "nowrap",
  },
  opHomeStation: { margin: "6px 0 0", fontSize: FONT_SIZE.body, fontWeight: 600, color: INK_TEXT, lineHeight: 1.7, maxWidth: "68ch" },
  opSideLine: { margin: "2px 0 0", fontSize: FONT_SIZE.body, color: INK_TEXT_DIM, lineHeight: 1.7, maxWidth: "68ch" },
  /* The side action names itself in the page accent and in the small caps the section labels use -- the same
     register as a heading, which is what it is, rather than the dashed pill a disclaimer wears. */
  opSideLabel: {
    display: "inline-block",
    marginRight: "10px",
    fontSize: FONT_SIZE.small,
    fontWeight: 700,
    letterSpacing: "0.09em",
    textTransform: "uppercase",
    color: ACCENT.operating.ink,
    whiteSpace: "nowrap",
  },
  opSideText: { color: INK_TEXT_DIM },
  /* Definitions: the term in the page accent, the rule beside it, hairlines between. */
  opDefs: { margin: 0, minWidth: 0 },
  opDefLabel: { fontSize: FONT_SIZE.small, fontWeight: 700, letterSpacing: "0.04em", color: ACCENT.operating.ink, lineHeight: 1.5 },
  opDefText: { margin: 0, fontSize: FONT_SIZE.body, color: INK_TEXT_DIM, lineHeight: 1.6, maxWidth: "64ch" },
  opBlock: { display: "flex", flexDirection: "column", gap: "6px", minWidth: 0 },
  opSubTitle: { margin: 0, fontSize: FONT_SIZE.small, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: INK_TEXT_MUTED },
  opLookupBlock: { display: "flex", flexDirection: "column", gap: "6px", minWidth: 0 },
  /* The highest-revenue rule: the one line of Run Routes a player must not miss, so it carries the accent
     down its edge. Still a line of text -- no fill and no box, because it is not a procedure. */
  opProminent: { paddingLeft: "13px", borderLeft: `2px solid ${ACCENT.operating.rule}` },
  opProminentText: { display: "block", fontSize: FONT_SIZE.strong, fontWeight: 600, color: INK_TEXT, lineHeight: 1.5, maxWidth: "62ch" },
  opFootRule: { margin: 0, fontSize: FONT_SIZE.body, color: INK_TEXT_DIM, lineHeight: 1.6, maxWidth: "68ch" },
  /* The exceptional procedure: warning ink and a rule down the left edge. A callout, not a panel -- it has
     no fill, no radius and no padding of its own beyond the 13px that clears its rule. */
  opWarn: { display: "flex", flexDirection: "column", gap: "8px", paddingLeft: "13px", borderLeft: `2px solid ${WARN_INK}`, minWidth: 0, alignItems: "flex-start" },
  opWarnLabel: { display: "inline-flex", alignItems: "center", gap: "8px", fontSize: FONT_SIZE.small, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: WARN_INK },
  opWarnMark: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "15px",
    height: "15px",
    borderRadius: RADIUS.circle,
    border: `1px solid ${WARN_INK}`,
    fontSize: FONT_SIZE.micro,
    fontWeight: 700,
    lineHeight: 1,
  },

  // ---- Auction & Privates page ----
  /* One column of rule text at this reference's measure, for the pages that are not inside a column. */
  opProse: { margin: 0, fontSize: FONT_SIZE.body, color: INK_TEXT_DIM, lineHeight: 1.6, maxWidth: "68ch" },
  /* THE THREE CHOICES. A term in the auction's violet over a sentence, with a hairline between columns and
     nothing around any of them: three alternatives, not three stages and not three buttons. */
  auChoice: { display: "flex", flexDirection: "column", gap: "4px", minWidth: 0 },
  auChoiceTerm: { fontSize: FONT_SIZE.control, fontWeight: 700, letterSpacing: "0.05em", color: ACCENT.auction.ink },
  auChoiceText: { fontSize: FONT_SIZE.body, color: INK_TEXT_DIM, lineHeight: 1.55 },
  auFlowCaption: { margin: 0, fontSize: FONT_SIZE.body, color: INK_TEXT_MUTED, lineHeight: 1.6, maxWidth: "68ch" },
  /* A BRANCH OFF THE CHOICE, one step in: a corner mark and a violet rule. Not a panel, not a warning -- an
     interruption to a procedure is still part of the procedure. */
  auBranch: { display: "flex", alignItems: "flex-start", gap: "9px", paddingLeft: "13px", borderLeft: `2px solid ${ACCENT.auction.rule}`, minWidth: 0 },
  auBranchMark: { fontSize: FONT_SIZE.heading, lineHeight: 1.2, color: ACCENT.auction.ink, flex: "0 0 auto" },
  auBranchBody: { display: "flex", flexDirection: "column", gap: "5px", minWidth: 0 },
  auBranchTitle: { fontSize: FONT_SIZE.small, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: ACCENT.auction.ink },
  auBranchText: { fontSize: FONT_SIZE.body, color: INK_TEXT_DIM, lineHeight: 1.6, maxWidth: "66ch" },
  /* The move's name, so the branch scans down its left edge as pause / resolve / check / resume. */
  auBranchTerm: { fontWeight: 700, color: INK_TEXT, marginRight: "8px" },
  /* A quiet way out of the procedure for somebody who came to look a company up. */
  auLookup: { display: "block", marginTop: "-2px" },
  auEnds: { margin: 0, fontSize: FONT_SIZE.strong, fontWeight: 600, color: INK_TEXT, lineHeight: 1.45, maxWidth: "62ch" },
  /* The variant block: after the base procedure, and visibly not part of it. */
  auVariant: { display: "flex", flexDirection: "column", gap: "6px", paddingTop: "12px", borderTop: `1px solid ${RULE}`, minWidth: 0 },
  /* THE CATALOG. Rows, hairlines, and no card anywhere: a player looking for one company should find it by
     running an eye down the abbreviations. */
  auRows: { display: "flex", flexDirection: "column", minWidth: 0 },
  auHead: { paddingBottom: "6px", borderBottom: `1px solid ${RULE_STRONG}` },
  auRow: { padding: "12px 0", borderBottom: `1px solid ${RULE}`, minWidth: 0 },
  auRowName: { display: "flex", flexDirection: "column", gap: "2px", minWidth: 0 },
  auRowAbbr: { fontFamily: FONT_FAMILY_MONO, fontSize: FONT_SIZE.control, fontWeight: 700, letterSpacing: "0.04em", color: ACCENT.auction.ink },
  auRowFull: { fontSize: FONT_SIZE.body, fontWeight: 600, color: INK_TEXT, lineHeight: 1.4 },
  auRowMeta: { fontFamily: FONT_FAMILY_MONO, fontSize: FONT_SIZE.small, color: INK_TEXT_FAINT, whiteSpace: "nowrap" },
  auRowPower: { display: "flex", flexDirection: "column", gap: "4px", minWidth: 0 },
  auRowBullet: { fontSize: FONT_SIZE.body, color: INK_TEXT_DIM, lineHeight: 1.55 },
  /* The exception a buyer would otherwise be surprised by: present only on the rows that have one. */
  /* CAPPED SHORTER THAN THE POWER BULLETS ABOVE IT: these are the cards' own two-sentence exceptions, and at
     the column's full width they ran as a single long line that read as a paragraph in the middle of a table.
     The cap is on the note only, so the three columns stay aligned. */
  auRowNote: { fontSize: FONT_SIZE.small, color: INK_TEXT_DIMMEST, lineHeight: 1.5, maxWidth: "58ch" },
  auRowClose: { fontSize: FONT_SIZE.small, color: INK_TEXT_FAINT, lineHeight: 1.5 },
  /* An earlier closure than the general first-5-train rule is the one thing in this column worth noticing. */
  auRowCloseEarly: { color: ACCENT.auction.ink, fontWeight: 700 },

  // ---- Tables page ----
  /* The directory: a label and a row of words. No panel, no box -- it is a list of places to go. */
  tblDirectory: { display: "flex", flexDirection: "column", gap: "6px", minWidth: 0 },
  /* THE PINNED PHASE COLUMN. An opaque ground, because the rest of the row scrolls under it. */
  tblSticky: { position: "sticky", left: 0, zIndex: 1, backgroundColor: INK_VIEWPORT },
  /* The row's green mark travels with the pinned cell: the row's own inset shadow is painted under this
     cell's background, so the live cell carries its own copy at the same 3px. */
  tblStickyLive: { boxShadow: `inset 3px 0 0 ${LIVE_INK}` },
  tblLookup: { display: "flex", flexDirection: "column", gap: "8px", minWidth: 0, maxWidth: "760px" },
  /* A footnote under a full-width table runs the width of the table unless it is told not to. The page's own
     measure, the same 68ch the Operating Round page uses for a single column of rule text. */
  tblFootnote: { margin: 0, fontSize: FONT_SIZE.small, color: INK_TEXT_DIMMEST, lineHeight: 1.5, maxWidth: "68ch" },
  /* The two trains the note exists to tell apart. Bold inside a dimmed footnote is the lightest way to make
     a sentence scannable without promoting the whole line. */
  tblFootnoteTerm: { color: INK_TEXT, fontWeight: 600 },
  /* A second clause in the Also cell, on its own line so the printed effect and the variant's are not run
     together into one sentence. One row, one variant -- the cell is unchanged in the base game. */
  tblAlsoVariant: { display: "block", marginTop: "4px" },
  /* The long half of the lookup columns: the reference's own ink, at normal weight. */
  tblValueLong: { color: INK_TEXT },

  // ---- Tables ----
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
