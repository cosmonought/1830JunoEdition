// frontend/src/components/hexContractTypes.ts
//
// PHASE 3a of the `HexGridRenderer.tsx` monolith extraction -- a prerequisite
// for Phase 3 proper.
//
// WHAT THIS IS. The frontend's mirrors of the contract's own query response
// shapes (`msg.rs`), the small pure helpers that read them, and the
// click-query state machine the renderer reports through.
//
// WHY THIS HAD TO COME FIRST. Phase 3 extracts the hex geometry and slot
// engine. Much of that engine is not pure coordinate math -- `archetypeForHex`,
// `liveEdgesForHex`, `hexBlockedSlots`, `claimHexSlot*`, `hexRouteValue` and
// `describeHexWithValue` all take a `MapGridResponse` or a
// `StationTokenCompany[]`. Those types lived in `HexGridRenderer.tsx`, so
// moving the geometry without them would have made the new module import from
// the file that imports it: a cycle.
//
// Leaving those functions behind instead was the alternative, and it was
// worse -- it would have split the slot engine down the middle, with half its
// call graph in each file.
//
// So the types move first, as their own leaf. They depend on nothing but
// `hexTileCatalog` (already extracted in Phase 1), which keeps the strict
// leaf-first ordering intact.
//
// IMPORT DIRECTION IS ONE-WAY: never import from `HexGridRenderer.tsx`.

import { corporationLiveryColor } from "../styles/corporationLivery";

/** Mirrors `msg.rs`'s `MapTileEntry` exactly -- one laid hex tile. */
export interface MapTileEntry {
  q: number;
  r: number;
  tile_id: number;
  orientation: number;
  /** This tile's DISCRETE track segments as BASE (pre-rotation) edge pairs
   *  -- `msg::MapTileEntry::paths`, resolved contract-side through
   *  `hexmap::effective_base_tile_paths` (design note #119).
   *
   *  Each `[a, b]` is one continuous run of track between edges `a` and
   *  `b`; `a === b` is a terminal spur that enters at `a` and dead-ends.
   *  Apply `orientation` yourself, the same as for a catalog entry's
   *  `connections` -- `rotatePaths` below does it.
   *
   *  OPTIONAL on purpose, and the optionality is not decorative: this
   *  component renders against whatever a deployed contract actually
   *  returns, and a contract built before this field existed simply omits
   *  the key. `pathsForTile` treats `undefined` and `[]` identically and
   *  falls back to the local `TILE_CATALOG` mirror, so an older chain
   *  renders exactly as it did before rather than throwing. */
  paths?: ReadonlyArray<readonly [number, number]> | null;
  /** Design note #132: THIS TILE'S PRINTED REVENUE, straight off the chain
   *  -- `msg::MapTileEntry::revenue` (`hexmap::tile_base_value`, Audit
   *  G-11). The single authority for what a stop on this hex pays.
   *
   *  Typed `string | number` because the backend field is `Uint128`, and
   *  cosmwasm-std serialises `Uint128` as a JSON **string** (`"90"`), not a
   *  number -- it has to, since a `u128` overflows an IEEE-754 double past
   *  2^53. Reading this as `entry.revenue` and expecting arithmetic to work
   *  is the trap; `chainTileRevenue` below parses it in exactly one place.
   *  `number` is accepted too so a hand-built fixture or a future
   *  narrower-typed field needs no change here.
   *
   *  OPTIONAL for the same backwards-compatibility reason as `paths` above:
   *  a contract built before Audit G-11 simply omits the key, and
   *  `chainTileRevenue` returns `undefined` so the caller falls back to the
   *  old terrain bucket rather than printing `NaN` or `$0`.
   *
   *  NOT to be re-derived from `terrain`. That is what this replaces, and
   *  it was wrong for most city tiles: `terrainBaseValue` is a flat
   *  per-bucket lookup, but real 1830 prints revenue on the TILE. #62 and
   *  #64 are both two-city brown artwork and print different figures; the
   *  whole Green/Brown city ladder (#14/#15 at $30, #63 at $40) collapsed
   *  to one bucket value under the old model. */
  revenue?: string | number | null;
  landmark: string | null;
}

/** Design note #132: parses `MapTileEntry.revenue` -- the chain's own
 *  `Uint128`, which arrives as a JSON string -- into a number, or
 *  `undefined` if this contract predates the field.
 *
 *  `undefined` and `0` are DIFFERENT answers and callers must not conflate
 *  them: `0` is a real figure (plain connector track earns nothing, and the
 *  badge should be suppressed), `undefined` means "this chain never told
 *  us" (fall back to the terrain bucket). */
export function chainTileRevenue(tile: MapTileEntry): number | undefined {
  const raw = tile.revenue;
  if (raw === undefined || raw === null || raw === "") return undefined;
  const value = typeof raw === "number" ? raw : Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : undefined;
}

/** Mirrors `msg.rs`'s `MapGridResponse` exactly -- `QueryMsg::GetMapGrid`'s
 *  response shape. */
export interface MapGridResponse {
  game_id: number;
  tiles: MapTileEntry[];
}

/** Structural shape this component needs from a chain query client --
 *  matches both `CosmWasmClient` and `SigningCosmWasmClient` from
 *  `@cosmjs/cosmwasm-stargate` without importing that package into this
 *  otherwise wallet-agnostic file (see design note #7). Any object with a
 *  compatible `queryContractSmart` (App.tsx's already-connected
 *  `SigningCosmWasmClient` included) satisfies this. */
export interface QueryCapableClient {
  queryContractSmart(contractAddress: string, queryMsg: Record<string, unknown>): Promise<unknown>;
}

/** Station Tokens (design note #36): a hand-kept SUBSET mirror of
 *  `utils/gameState.ts`'s `PublicCompanyState` -- only the fields this
 *  component's Station Token rendering pass actually needs, re-declared
 *  locally rather than imported (see design note #36 for why). Every
 *  field here is a direct, same-name, same-shape copy of its
 *  `PublicCompanyState`/`msg.rs::PublicCompanyState` counterpart. */
export interface StationTokenCompany {
  company_id: number;
  ticker: string;
  is_floated: boolean;
  /** `(q, r)` pairs, home hex first (if granted) -- mirrors
   *  `PublicCompanyState.station_token_hexes` exactly. */
  station_token_hexes: Array<[number, number]>;
  /** Design note #134: the SAME tokens as `station_token_hexes`, but as
   *  `(q, r, city_index)` -- mirrors `PublicCompanyState.station_tokens`
   *  (backend Audit G-12).
   *
   *  A hex is not a city. New York (#54/#62) and every OO tile
   *  (#59/#64-#68) carry two separate cities on one hex, and `(q, r)` alone
   *  cannot say which one holds this company's token -- which is why
   *  `stationMarkerPoint` used to guess from the hex label and drop tokens
   *  on the wrong half of a two-city tile.
   *
   *  OPTIONAL: a contract predating G-12 omits it, and `tokenCityIndex`
   *  below falls back to the old heuristic rather than throwing. An empty
   *  array alongside a non-empty `station_token_hexes` means "this chain
   *  doesn't know", never "no tokens". */
  station_tokens?: Array<[number, number, number]> | null;
}

/** Which city on `(q, r)` holds `company`'s token -- design note #134.
 *
 *  Prefers the chain's own answer. Returns `undefined` when the chain has
 *  not told us, which is a DIFFERENT answer from `0` and must stay
 *  distinguishable: the caller falls back to `stationMarkerPoint`'s legacy
 *  per-hex heuristic rather than asserting city 0 and confidently drawing a
 *  token in the wrong station. */
export function tokenCityIndex(
  company: StationTokenCompany,
  q: number,
  r: number,
): number | undefined {
  const entry = company.station_tokens?.find(([tq, tr]) => tq === q && tr === r);
  return entry ? entry[2] : undefined;
}

/** Station Tokens (design note #36; REASSIGNED by design note #44's house
 *  rule): a local mirror of `hexmap::CORPORATION_HOME_HEX` -- all eight core
 *  corporations' preprinted home hex, sourced from this same file's own
 *  `LANDMARK_HEXES`/`GRAY_HEXES`/`YELLOW_OO_HEXES` entries above exactly the
 *  way the backend constant's own doc comment describes deriving it. As of
 *  design note #44 (mirroring `hexmap.rs` module doc comment #25's backend
 *  house rule), NYC (company_id 2) is reassigned to Albany (E19) and NNH
 *  (company_id 7, "NYNH") -- previously omitted for having no assigned home
 *  -- takes over the New York (G19) hex NYC vacated. This is a deliberate
 *  departure from real 1830 (where NYC's home is G19), requested three
 *  times, explicitly, by the same requester who owns this custom board. */
export const STATION_HOME_HEXES: ReadonlyArray<{
  companyId: number;
  q: number;
  r: number;
  label: string;
}> = [
  { companyId: 1, q: 2, r: 7, label: "H12" }, // PRR -> Altoona
  { companyId: 2, q: 7, r: 4, label: "E19" }, // NYC -> Albany (house rule, design note #44)
  { companyId: 3, q: 9, r: 0, label: "A19" }, // CPR -> Montreal
  { companyId: 4, q: 3, r: 8, label: "I15" }, // B&O -> Baltimore
  { companyId: 5, q: 0, r: 5, label: "F6" }, // C&O -> Cleveland
  { companyId: 6, q: 3, r: 4, label: "E11" }, // ERIE -> Dunkirk & Buffalo (shared OO hex)
  { companyId: 7, q: 6, r: 6, label: "G19" }, // NNH ("NYNH") -> New York (house rule, design note #44)
  { companyId: 8, q: 9, r: 4, label: "E23" }, // B&M -> Boston
];

/* ==================================================================
 *  DESIGN NOTE 428: RE-EXPORTED, NOT DEFINED
 * ==================================================================
 *
 * The table itself now lives in `styles/corporationLivery.ts` -- see that
 * module for the palette, design note #408's audit, and why three copies
 * became one.
 *
 * THESE NAMES SURVIVE AS ALIASES, deliberately. `STATION_TICKER_COLORS`,
 * `STATION_FALLBACK_TICKER_COLOR` and `stationTickerColor` have eight-plus
 * call sites across `App.tsx`, `HexGridRenderer`, `hexCanvasPrimitives`,
 * `ContextualSubPanel`, `FinancialLedger`, `TrainPurchasePanel`,
 * `StationTokenRow` and `ContextualActionBar`, plus a design-notes markdown
 * that references them by name. Renaming all of that in the same pass that
 * moves the data would make one behavioural change indistinguishable from
 * forty mechanical ones in review.
 *
 * So the move is invisible to every existing consumer, and new code can
 * import `corporationLiveryColor` from the styles module directly. The
 * aliases are not deprecated-and-abandoned: they are this file's station
 * token vocabulary, and a hex-map module asking for "the station ticker
 * colour" reads better here than the generic name would. */
export {
  CORPORATION_LIVERY_COLORS as STATION_TICKER_COLORS,
  CORPORATION_LIVERY_FALLBACK as STATION_FALLBACK_TICKER_COLOR,
  relativeLuminance,
  bestContrastTextColor,
} from "../styles/corporationLivery";

/* ==================================================================
 *  DESIGN NOTE 234: A NEAR-WHITE RING AROUND WHITE LETTERING
 * ==================================================================
 *
 * REPORTED BUG: PRR and CPR tokens are very hard to read.
 *
 * A placed token is a small disc of the corporation's brand colour with its
 * acronym on top, and it was ringed in `#f4ecd8` -- the board's cream -- at
 * `max(2, size * 0.05)`. Two things go wrong at once, and they compound:
 *
 *   THE RING DOES NOT SEPARATE. A token sits inside a WHITE city circle, so
 *   a cream ring is near-white on near-white. The one job of an outline is
 *   to say where the token ends, and it could not.
 *
 *   THE RING CROWDS THE GLYPHS. The disc is small (`radius = size * 0.22`)
 *   and a size-scaled stroke centred on that radius eats inward. On the
 *   dark-filled corporations -- PRR's red, CPR's purple -- the acronym is
 *   WHITE, so the lettering ran into a near-white band with only a sliver of
 *   fill between them. Three-letter tickers on the smallest discs in the
 *   game, with the contrast removed exactly where it was needed.
 *
 * Charcoal fixes both without touching the brand palette: it separates
 * hard from the white circle beneath, and it cannot be confused with white
 * lettering because it is the opposite end of the scale. It is applied to
 * every floated token rather than only the white-lettered ones -- the
 * light-filled corporations (C&O's orange, with black text) had the same
 * separation problem against the white circle, and one ring colour is one
 * fewer thing to keep in step with `bestContrastTextColor`.
 *
 * The UNFLOATED reservation marker keeps its brand-coloured ring: that ring
 * is an affordance rather than an outline -- design note #48's "which colour
 * it'll turn once floated" -- and at 45% alpha it is not competing with
 * anything.
 *
 * B&M IS A DELIBERATE EDGE CASE, recorded because it looks like an oversight
 * and is not. Its brand colour is `#34495e`, a dark slate barely a shade off
 * this charcoal, so its ring effectively merges into its own fill and the
 * token reads as one solid dark disc with white lettering. That is the
 * SECOND outcome this fix was allowed to reach -- "remove the border
 * entirely so the corporate background colour fills the whole token" -- and
 * it is reached without a special case, because the property that actually
 * matters survives either way: the ring's job is to separate the token from
 * the WHITE CITY CIRCLE underneath it, and charcoal-on-white does that at
 * roughly 10:1 whether or not it also happens to contrast with the fill
 * inside it.
 *
 * Tinting B&M's ring lighter to make it visible would put a pale band back
 * around white lettering -- the exact bug being fixed -- so the merge is the
 * better of the two outcomes rather than a compromise.
 */
export const STATION_TOKEN_RING = "#334155";

/* ==================================================================
 *  DESIGN NOTE 487: THE RING IS A FRACTION OF THE TOKEN, NOT OF THE HEX
 * ==================================================================
 *
 * REPORTED: subsequent station tokens render with a strange ring border
 * that makes them look non-uniform next to home station tokens.
 *
 * They do, and the two tokens are drawn by the SAME function with the same
 * colours -- which is why this took finding. The difference is the radius,
 * and the ring did not follow it.
 *
 *   `drawStationTokenMarker` stroked at `Math.max(2, size * 0.05)`, where
 *   `size` is the HEX size. Constant for every token on the board.
 *
 *   The RADIUS is not constant. A token docked into a laid tile's city slot
 *   takes `tileCityTokenRadius` -- `markerSize * 0.22 * 0.86 * 0.84`, and
 *   `markerSize` itself shrinks another 15% on a multi-city tile. A home
 *   token on an untiled preprinted city keeps the legacy `size * 0.22`.
 *
 * So a docked token is roughly two thirds the radius of a preprinted one
 * and wears exactly the same absolute ring: proportionally half again as
 * heavy. That reads as a different piece -- a small disc with a fat collar
 * beside a large disc with a thin one -- which is precisely the report.
 *
 * The ratio below is the CURRENT appearance of the legacy path, preserved
 * exactly: `0.05 / 0.22`. Tokens at the old radius are pixel-identical;
 * every smaller token now wears a ring in proportion to itself, so all of
 * them look like the same wooden piece at different distances.
 */
export const STATION_TOKEN_RING_WIDTH_RATIO = 0.05 / 0.22;

/* ==================================================================
 *  DESIGN NOTE 253: A BRAND COLOUR THAT CAN ACT AS LIGHT
 * ==================================================================
 *
 * The board veil, the legal-placement glow and the manual route line are all
 * drawn in the acting corporation's colour, so one hue says whose turn it is
 * everywhere at once. Two of those three are LIGHT effects over a darkened
 * board, and light needs luminance: B&M's `#34495e` slate and PRR's deep red
 * are perfectly good fills and make almost no glow at all against a veiled
 * map.
 *
 * So a colour used as light is measured first, and a too-dark one is
 * BRIGHTENED toward white rather than replaced by it. Replacing would throw
 * the identity away exactly when the board is trying to communicate it;
 * lifting keeps the hue recognisably PRR-red or B&M-navy while giving it
 * enough luminance to read as emitted light.
 *
 * The threshold is relative luminance, the same quantity
 * `bestContrastTextColor` uses, so this file has one idea of "dark".
 */
export function glowColorFor(color: string, minimumLuminance = 0.32): string {
  const parse = (index: number) => parseInt(color.slice(index, index + 2), 16) / 255;
  const channels = [1, 3, 5].map(parse);
  if (channels.some((value) => Number.isNaN(value))) return "#FFFFFF";
  const linear = channels.map((c) =>
    c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4,
  );
  const luminance = 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
  if (luminance >= minimumLuminance) return color;

  // Mix toward white by however much is missing. A colour at half the
  // threshold lifts halfway; one at nearly the threshold barely moves.
  const mix = Math.min(0.75, 1 - luminance / minimumLuminance);
  const lifted = channels.map((c) => Math.round((c + (1 - c) * mix) * 255));
  return `#${lifted.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

/* ==================================================================
 *  DESIGN NOTE 403 (SUPERSEDED BY #408): NNH IS NO LONGER PRR'S RED
 * ==================================================================
 *
 * REPORTED: adjust PRR or NNH so the two are easily distinguishable.
 *
 * They were `#c0392b` and `#b03a2e` -- CIELAB dE 8.4 apart. Below about 15
 * two colours read as the same colour under normal viewing, so on the map,
 * the chart and eight stock cards the New Haven and the Pennsylvania were
 * effectively one livery.
 *
 * That measurement stands and the fix was real. The specific colour it
 * chose -- `#00838f`, dark cyan -- does not survive design note #408, which
 * replaces the whole palette with the physical game's. The note is kept
 * because the METHOD is what carried forward: measure the separation, do
 * not judge it. #408 applies the same measurement to eight colours instead
 * of two.
 *
 * ==================================================================
 *  DESIGN NOTE 408: THE COLOURS THE BOARD ACTUALLY USES
 * ==================================================================
 *
 * REPORTED: the corporate colours do not match the physical board game,
 * which is jarring for experienced players.
 *
 * This palette was never canonical -- it was eight plausible, well-spaced
 * hues, and every previous pass tuned it for legibility and separation
 * without asking what colour the pieces actually are. For a player who
 * knows 1830, that is worse than an arbitrary palette: the Erie is yellow
 * on the board and reaching for the yellow token to find it is the B&O
 * costs more than having no expectation at all.
 *
 * So the hues are now the specified ones, and the two properties earlier
 * passes cared about were re-checked rather than assumed against them:
 *
 *   CONTRAST. Every entry clears 4.5:1 against whichever of black or white
 *   `bestContrastTextColor` returns -- the WCAG threshold for normal text,
 *   which is the right bar because the stripe's ticker is 16px bold and
 *   16px bold is NOT "large text" by WCAG (that starts at 18.66px bold).
 *   The lowest is B&M green at 5.35:1; the shade of each hue was chosen to
 *   clear the bar rather than the bar being lowered to fit a shade.
 *
 *   SEPARATION. Minimum pairwise dE across all 28 combinations is 44.4
 *   (ERIE yellow against NNH orange), against the 8.4 that started design
 *   note #403. Canonical and distinguishable turned out not to be in
 *   tension -- the physical game already had to solve this problem with
 *   ink on cardboard.
 *
 *   THE CONTRAST INK FLIPS WHERE IT SHOULD. C&O's cyan, ERIE's yellow and
 *   NNH's orange are light enough to take BLACK text; the other five take
 *   white. That is the helper doing its job on new inputs, and it is
 *   asserted per colour rather than trusted.
 *
 * NYC IS `#1a1a1a`, NOT `#000000`. The requirement allows "a very dark
 * gray to ensure UI legibility" and this takes it: pure black would be
 * indistinguishable from the card borders and the chart's own gridlines,
 * and a corporation whose livery is the same colour as the furniture reads
 * as a rendering failure rather than as the New York Central.
 *
 * ALL THREE MIRRORS ARE UPDATED TOGETHER. This palette is hand-copied into
 * `hexContractTypes.ts`, `StockMarketRenderer.tsx` and `StockRoundPanel.tsx`
 * (each says so in its own header), so changing one would give the map and
 * the cards different opinions about who a corporation is. */

export function stationTickerColor(companyId: number): string {
  // Design note #428: delegates rather than re-implementing the `?? fallback`.
  return corporationLiveryColor(companyId);
}

/** Corporate Acronym Overlay guarantee (design note #45): a small,
 *  deliberately DUPLICATED copy of `public_company.rs`'s own
 *  `CORE_PUBLIC_COMPANIES` real on-chain tickers (same values, same
 *  `company_id` keys, same "copy, don't import" reasoning as
 *  `STATION_TICKER_COLORS` above). Exists so a RESERVED/unfloated home
 *  station badge can always draw its acronym even before `publicCompanies`
 *  has loaded (or ever loads) real data for that company -- see the muted
 *  drawing pass below, which now prefers a live `company.ticker` when
 *  present but falls back to this static table instead of an empty string.
 *  Company 7's real ticker is `NNH`, not `NYNH` -- `public_company.rs`'s
 *  `CORE_PUBLIC_COMPANIES` (`(7, "NNH")`) is the single source of truth;
 *  "NYNH" is this project's own established colloquial name for the real
 *  New York, New Haven & Hartford railroad the request refers to (see
 *  design note #36's own note on this), not a second, different on-chain
 *  ticker -- using "NNH" here keeps this placeholder text identical to
 *  what `company.ticker` will actually show once the corporation floats,
 *  so the badge's acronym never visibly changes/flickers at that moment. */
export const STATION_TICKER_LABELS: Readonly<Record<number, string>> = {
  1: "PRR",
  2: "NYC",
  3: "CPR",
  4: "B&O",
  5: "C&O",
  6: "ERIE",
  7: "NNH",
  8: "B&M",
};

export function stationTickerLabel(companyId: number): string {
  return STATION_TICKER_LABELS[companyId] ?? "";
}

/* Design note #428: `relativeLuminance` and `bestContrastTextColor` were
   DEFINED here and are now re-exported from `styles/corporationLivery.ts`
   at the top of this file. They are generic colour maths that lived here
   only because the map's station tokens were the first surface needing to
   put an acronym on an arbitrary corporate fill; four other surfaces call
   them now, and all four are about that palette. */

/** Mirrors `msg.rs`'s `LegalTilePlacement` exactly. */
export interface LegalTilePlacement {
  tile_id: number;
  orientation: number;
}

/** Mirrors `msg.rs`'s `LegalTilePlacementsResponse` exactly --
 *  `QueryMsg::GetLegalTilePlacements`'s response shape. */
export interface LegalTilePlacementsResponse {
  game_id: number;
  protocol_id: number;
  q: number;
  r: number;
  hex_label: string;
  placements: LegalTilePlacement[];
}

/** Discriminated union describing the click interceptor's in-flight/settled
 *  query state (see design note #7) -- reported to the host app via
 *  `onHexClickQuery` so `App.tsx` can decide when/where to render
 *  `<TileSelectionPopup />`. */
/** Why a hex refused a tile-laying click -- design note #141.
 *
 *  Defined HERE rather than beside `evaluateHexForTileLaying` in
 *  `hexGeometry.ts`, which is where the logic lives, purely to respect the
 *  one-way import rule: `hexGeometry` imports from this module, so this
 *  module cannot import back without creating the cycle that file's own
 *  header warns about. The type is data, the function is behaviour, and the
 *  data has to sit at the bottom.
 *
 *    "not-a-hex"       the coordinate is not one of the 93 real board hexes
 *    "offboard"        a red off-board revenue terminal
 *    "gray-immutable"  a preprinted gray hex -- permanently fixed
 *    "max-tier"        the tile there is already the top colour tier
 *
 * `"out-of-reach"` is GONE -- design note #257. It was the one reason that
 * depended on whose turn it was rather than on the board, and it existed to
 * explain a refusal the Lay Track veil now makes visually. A click on a
 * dimmed hex is ignored outright, so there is no status left to carry.
 */
export type HexClickRejection = "not-a-hex" | "offboard" | "gray-immutable" | "max-tier";

export type HexClickQueryState =
  /** Design note #172: the click landed on NO HEX AT ALL -- open water, the
   *  margin beyond the board, or one of the real gaps inside its non-convex
   *  outline (row A has no A13/A15).
   *
   *  Distinct from `"blocked"`, which means "a real hex, but you may not lay
   *  here". This one carries no rejection reason and no message, because
   *  there is nothing to explain: the player clicked nothing.
   *
   *  It exists so an ALREADY-OPEN in-situ UI can close. Returning silently
   *  -- the previous behaviour -- left a radial menu anchored to an earlier
   *  hex sitting there while the player clicked empty sea to dismiss it. */
  | {
      status: "not-a-hex";
      q: number;
      r: number;
      hexLabel: string;
      clientX: number;
      clientY: number;
      /** Design note #171: the hex's centre in canvas-CSS pixels, through
       *  the live pan/zoom transform. In-situ UI anchors to this; the
       *  `clientX`/`clientY` above remain the raw cursor, which is still
       *  the right anchor for a cursor-following tooltip. */
      centroidX: number;
      centroidY: number;
    }
  /** Design note #141: the hex failed one of the four static board gates
   *  (`evaluateHexForTileLaying`), so `GetLegalTilePlacements` was never
   *  called and no picker may open.
   *
   *  A distinct variant rather than simply reporting nothing, for the same
   *  reason `"offline"` is a variant rather than a flag: the consumer has
   *  to make a decision, and the exhaustiveness checker should be the thing
   *  that reminds it. Reporting nothing was the ORIGINAL behaviour for
   *  off-board and gray clicks in an earlier draft of this gate, and it is
   *  indistinguishable from the click handler being broken -- which is
   *  exactly the failure mode this codebase has already hit twice (see
   *  design notes #120 and #139, both of which were silent-click bugs).
   *
   *  Consumers MUST NOT open the tile picker on this status. They SHOULD
   *  show `message` briefly when it is non-null. */
  | {
      status: "blocked";
      q: number;
      r: number;
      hexLabel: string;
      clientX: number;
      clientY: number;
      /** Design note #171: the hex's centre in canvas-CSS pixels, through
       *  the live pan/zoom transform. In-situ UI anchors to this; the
       *  `clientX`/`clientY` above remain the raw cursor, which is still
       *  the right anchor for a cursor-following tooltip. */
      centroidX: number;
      centroidY: number;
      reason: HexClickRejection;
      /** `null` for a click on empty space beyond the board, which is not
       *  worth telling anyone about -- see `evaluateHexForTileLaying`. */
      message: string | null;
    }
  | {
      status: "loading";
      q: number;
      r: number;
      hexLabel: string;
      clientX: number;
      clientY: number;
      /** Design note #171: the hex's centre in canvas-CSS pixels, through
       *  the live pan/zoom transform. In-situ UI anchors to this; the
       *  `clientX`/`clientY` above remain the raw cursor, which is still
       *  the right anchor for a cursor-following tooltip. */
      centroidX: number;
      centroidY: number;
    }
  | {
      status: "success";
      q: number;
      r: number;
      hexLabel: string;
      clientX: number;
      clientY: number;
      /** Design note #171: the hex's centre in canvas-CSS pixels, through
       *  the live pan/zoom transform. In-situ UI anchors to this; the
       *  `clientX`/`clientY` above remain the raw cursor, which is still
       *  the right anchor for a cursor-following tooltip. */
      centroidX: number;
      centroidY: number;
      response: LegalTilePlacementsResponse;
    }
  | {
      status: "error";
      q: number;
      r: number;
      hexLabel: string;
      clientX: number;
      clientY: number;
      /** Design note #171: the hex's centre in canvas-CSS pixels, through
       *  the live pan/zoom transform. In-situ UI anchors to this; the
       *  `clientX`/`clientY` above remain the raw cursor, which is still
       *  the right anchor for a cursor-following tooltip. */
      centroidX: number;
      centroidY: number;
      message: string;
    }
  /** Design note #120: no chain client is wired up, so
   *  `GetLegalTilePlacements` was never called and `placements` below came
   *  from the LOCAL `TILE_CATALOG` mirror, not from the contract.
   *
   *  A separate status rather than a flag on `"success"` on purpose. These
   *  placements are NOT contract-validated: they are era-gated and nothing
   *  more -- no connectivity check, no terrain reservation, no tile-tray
   *  depletion, no upgrade-color step. Folding them into `"success"` would
   *  let any existing or future consumer treat unvalidated data as
   *  authoritative simply by not knowing to check a flag, whereas a distinct
   *  variant makes the exhaustiveness checker point at every site that has
   *  to decide. Consumers MUST surface this to the player as provisional and
   *  MUST NOT dispatch a `LayTile` from it. */
  | {
      status: "offline";
      q: number;
      r: number;
      hexLabel: string;
      clientX: number;
      clientY: number;
      /** Design note #171: the hex's centre in canvas-CSS pixels, through
       *  the live pan/zoom transform. In-situ UI anchors to this; the
       *  `clientX`/`clientY` above remain the raw cursor, which is still
       *  the right anchor for a cursor-following tooltip. */
      centroidX: number;
      centroidY: number;
      placements: LegalTilePlacement[];
    };
