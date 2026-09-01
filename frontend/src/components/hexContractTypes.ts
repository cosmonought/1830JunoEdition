// frontend/src/components/hexContractTypes.ts
//
// PHASE 3a of the `HexGridRenderer.tsx` monolith extraction: the frontend's mirrors of the contract's
// query response shapes (`msg.rs`), the pure helpers that read them, and the click-query state machine
// the renderer reports through.
//
// WHY THIS HAD TO COME FIRST. Phase 3 extracts the hex geometry and slot engine, and much of that engine
// is not pure coordinate math -- several of its functions take a `MapGridResponse` or a
// `StationTokenCompany[]`. Those types lived in `HexGridRenderer.tsx`, so moving the geometry without them
// would have made the new module import from the file that imports it: a cycle. Leaving the functions
// behind was the alternative and it was worse -- it would have split the slot engine down the middle.
//
// IMPORT DIRECTION IS ONE-WAY: never import from `HexGridRenderer.tsx`.
//
// Shares the rail-map `#N` namespace -- see `docs/ai_architecture/hex_tile_math.md`.

import { corporationLiveryColor } from "../styles/corporationLivery";

/** Mirrors `msg.rs`'s `MapTileEntry` exactly -- one laid hex tile. */
export interface MapTileEntry {
  q: number;
  r: number;
  tile_id: number;
  orientation: number;
  /** Design note #119: this tile's DISCRETE track segments as BASE (pre-rotation) edge pairs, resolved
   *  contract-side through `hexmap::effective_base_tile_paths`. Each `[a, b]` is one continuous run between
   *  edges `a` and `b`; `a === b` is a terminal spur that enters at `a` and dead-ends. Apply `orientation`
   *  yourself.
   *  OPTIONAL on purpose, and not decoratively: a contract built before this field existed omits the key, and
   *  the reader treats `undefined` and `[]` identically and falls back to the local catalog mirror -- so an
   *  older chain renders exactly as it did before rather than throwing. */
  paths?: ReadonlyArray<readonly [number, number]> | null;
  /** Design note #132: THIS TILE'S PRINTED REVENUE, straight off the chain (`hexmap::tile_base_value`, Audit
   *  G-11) -- the single authority for what a stop on this hex pays.
   *  Typed `string | number` because the backend field is `Uint128` and cosmwasm-std serialises it as a JSON
   *  STRING -- it has to, since a `u128` overflows an IEEE-754 double past 2^53. Expecting arithmetic to work
   *  on it is the trap; `chainTileRevenue` parses it in exactly one place.
   *  OPTIONAL for the same backwards-compatibility reason as `paths`: a pre-G-11 contract omits the key and
   *  the caller falls back to the terrain bucket rather than printing `NaN` or `$0`.
   *  NOT to be re-derived from `terrain` -- that is what this replaces, and it was wrong for most city tiles:
   *  real 1830 prints revenue on the TILE, and the whole Green/Brown city ladder collapsed to one bucket value
   *  under the old flat-lookup model. */
  revenue?: string | number | null;
  landmark: string | null;
}

/** Design note #132: parses `MapTileEntry.revenue` -- the chain's own `Uint128`, arriving as a JSON string
 *  -- into a number, or `undefined` if this contract predates the field.
 *  `undefined` and `0` are DIFFERENT answers and callers must not conflate them: `0` is a real figure (plain
 *  connector track earns nothing, so the badge should be suppressed), `undefined` means "this chain never
 *  told us" and the caller falls back to the terrain bucket. */
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

/** Structural shape this component needs from a chain query client -- matches both `CosmWasmClient` and
 *  `SigningCosmWasmClient` without importing that package into this otherwise wallet-agnostic file (design
 *  note #7). Any object with a compatible `queryContractSmart` satisfies it. */
export interface QueryCapableClient {
  queryContractSmart(contractAddress: string, queryMsg: Record<string, unknown>): Promise<unknown>;
}

/** Station tokens (design note #36): a hand-kept SUBSET mirror of `gameState.ts`'s `PublicCompanyState` --
 *  only the fields this component's station-token pass needs, re-declared locally rather than imported.
 *  Every field is a direct, same-name, same-shape copy of its `msg.rs` counterpart. */
export interface StationTokenCompany {
  company_id: number;
  ticker: string;
  is_floated: boolean;
  /** `(q, r)` pairs, home hex first (if granted) -- mirrors
   *  `PublicCompanyState.station_token_hexes` exactly. */
  station_token_hexes: Array<[number, number]>;
  /** Design note #134: the SAME tokens as `station_token_hexes`, but as `(q, r, city_index)` -- mirrors
   *  `PublicCompanyState.station_tokens` (Audit G-12).
   *  A hex is not a city: New York and every OO tile carry two separate cities on one hex, and `(q, r)` alone
   *  cannot say which one holds this company's token -- which is why the marker used to guess from the hex
   *  label and drop tokens on the wrong half of a two-city tile.
   *  OPTIONAL: a pre-G-12 contract omits it and the reader falls back to the heuristic rather than throwing.
   *  An empty array alongside a non-empty `station_token_hexes` means "this chain doesn't know", never "no
   *  tokens". */
  station_tokens?: Array<[number, number, number]> | null;
}

/** Whether `company` has a station token standing on `(q, r)`.
 *
 *  ==================================================================
 *   DESIGN NOTE 724: THE PRESENCE QUESTION AND THE WHICH-CITY QUESTION
 *  ==================================================================
 *
 *  REPORTED: "when I upgraded Baltimore (B&O's home station hex), the green tile has a 'ghost' B&O marker on
 *  it -- I am guessing that is the home station reservation marker ... The home station reservation markers
 *  need to be hidden after the home station is placed."
 *
 *  Correct, and it was hidden by a test on the WRONG FIELD. The renderer asked `station_tokens?.some(...)`,
 *  which is the `(q, r, city_index)` list -- and the note directly above says what an empty one means: "this
 *  chain doesn't know", never "no tokens". So on any chain that does not report city indices, `homePlaced`
 *  was false forever and the reservation badge outlived the token it was reserving for.
 *
 *  WHY IT ONLY SHOWED ON THE UPGRADE -- and this paragraph is a CORRECTION, because the first version of it
 *  asserted that I15's green tile adds a second station slot. It does not. Reported: "I15's green tile does
 *  NOT give it a second station slot. It simply moves the city/station from its off-center position on the
 *  preprinted yellow tile to a centered position." The right diagnosis is better than the one I invented and
 *  points at a second defect, so it is worth stating exactly.
 *
 *  THE BADGE IS COMPUTED WITHOUT THE LAID TILE. It called `stationMarkerPoint(q, r, size)` with no
 *  `laidTile`, which takes the tile-less fallback -- a fixed anchor derived from the hex. Preprinted track is
 *  not a `tiles` entry, so on yellow I15 the REAL token pass had no tile either: both took the same fallback
 *  and painted on top of each other. One marker, correct-looking, for the whole early game.
 *
 *  Laying green puts a real entry in `tiles`. The token follows the tile's own city anchor -- which is
 *  exactly the recentring the report describes -- while the badge stays on the fallback it never stopped
 *  using, and the duplicate that had been there since the placement separates. So the visible symptom is two
 *  bugs stacked: the badge should not have been drawn at all (this note), and where it IS drawn it should
 *  follow the tile (fixed alongside). A rendering fault can hide for an entire phase because two things were
 *  wrong in the same direction.
 *
 *  SO THE TWO QUESTIONS GET TWO FUNCTIONS. "Is there a token here" is answered by `station_token_hexes`,
 *  which is REQUIRED and always populated; "which city is it in" is answered by `station_tokens`, which is
 *  optional and may legitimately be silent. They were one field apart in the source and are one word apart in
 *  English, which is exactly why this needs a name rather than an inline `.some()`.
 *  `tokenCityIndex` below keeps reading the optional field, because unknown really is its answer. */
export function hasStationTokenAt(
  company: Pick<StationTokenCompany, "station_token_hexes">,
  q: number,
  r: number,
): boolean {
  return company.station_token_hexes.some(([tq, tr]) => tq === q && tr === r);
}

/** Which city on `(q, r)` holds `company`'s token -- design note #134. Prefers the chain's own answer.
 *  Returns `undefined` when the chain has not told us, which is a DIFFERENT answer from `0` and must stay
 *  distinguishable: the caller falls back to the legacy per-hex heuristic rather than asserting city 0 and
 *  confidently drawing a token in the wrong station. */
export function tokenCityIndex(
  company: StationTokenCompany,
  q: number,
  r: number,
): number | undefined {
  const entry = company.station_tokens?.find(([tq, tr]) => tq === q && tr === r);
  return entry ? entry[2] : undefined;
}

/** Station tokens (design note #36), REASSIGNED by design note #44's house rule: a local mirror of
 *  `hexmap::CORPORATION_HOME_HEX`, derived from this file's own landmark/gray/OO hex entries exactly the way
 *  the backend constant's doc comment describes.
 *  As of #44 (mirroring `hexmap.rs` module doc #25), NYC is reassigned to Albany (E19) and NNH -- previously
 *  omitted for having no assigned home -- takes over the New York (G19) hex NYC vacated. A deliberate
 *  departure from real 1830, requested three times explicitly by the owner of this custom board. */
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

/* Design note #428: RE-EXPORTED, NOT DEFINED. The table lives in `styles/corporationLivery.ts` -- see that
   module for the palette and #408's audit.
   THESE NAMES SURVIVE AS ALIASES, deliberately: they have eight-plus call sites across the app plus notes
   that reference them by name, and renaming all of that in the same pass that moves the data would make one
   behavioural change indistinguishable from forty mechanical ones in review. They are not
   deprecated-and-abandoned -- they are this file's station-token vocabulary, and a hex-map module asking for
   "the station ticker colour" reads better here than the generic name would. */
export {
  CORPORATION_LIVERY_COLORS as STATION_TICKER_COLORS,
  CORPORATION_LIVERY_FALLBACK as STATION_FALLBACK_TICKER_COLOR,
  relativeLuminance,
  bestContrastTextColor,
} from "../styles/corporationLivery";

/* Design note #234: A NEAR-WHITE RING AROUND WHITE LETTERING. A placed token is a small disc of brand
   colour with its acronym on top, and a cream ring against a WHITE city circle fails twice over: it does
   not SEPARATE (near-white on near-white, and the one job of an outline is to say where the token ends),
   and it CROWDS THE GLYPHS (a size-scaled stroke on a small radius eats inward, and on the dark-filled
   corporations the acronym is white, so the lettering ran into a near-white band).
   Charcoal fixes both without touching the brand palette, and is applied to EVERY floated token rather than
   only the white-lettered ones -- the light-filled corporations had the same separation problem, and one
   ring colour is one fewer thing to keep in step with `bestContrastTextColor`.
   The UNFLOATED reservation marker keeps its brand ring: that is an affordance (#48's "which colour it'll
   turn once floated") rather than an outline, and at 45% alpha it competes with nothing.
   B&M IS A DELIBERATE EDGE CASE, recorded because it looks like an oversight. Its slate is barely a shade
   off this charcoal, so its ring merges into its own fill -- which is the SECOND outcome this fix was
   allowed to reach, and is reached without a special case: charcoal-on-white separates at roughly 10:1
   whether or not it also contrasts with the fill inside it. Tinting it lighter would put a pale band back
   around white lettering, which is the exact bug being fixed. */
/* Design note #1092 swept this to `#2a2a2a` and it is REVERTED, on scope rather than on taste. This is
   BOARD ART -- `hexCanvasPrimitives` strokes it around every floated station token -- and the canvas is
   deliberately outside the re-theme (TECH_DEBT TD-7). The note above also cites a measured figure that the
   sweep would have falsified: "charcoal-on-white separates at roughly 10:1" is 10.35:1 at `#334155` and
   14.35:1 at `#2a2a2a`, and the B&M edge case it records -- a ring that merges into its own fill, 1.94:1 --
   becomes 2.68:1 and stops merging. When the canvas is retoned, this value moves WITH those two figures
   re-measured and this paragraph rewritten, not ahead of them. */
export const STATION_TOKEN_RING = "#334155";

/* Design note #487: THE RING IS A FRACTION OF THE TOKEN, NOT OF THE HEX. The two tokens are drawn by the
   SAME function with the same colours -- which is why this took finding. The stroke was `max(2, size *
   0.05)` where `size` is the HEX size, constant for every token; the RADIUS is not constant, since a token
   docked into a laid tile's city slot shrinks by a chain of factors and again on a multi-city tile.
   So a docked token is roughly two thirds the radius of a preprinted one and wore exactly the same absolute
   ring: proportionally half again as heavy -- a small disc with a fat collar beside a large disc with a
   thin one, which is precisely the report.
   The ratio is the CURRENT appearance of the legacy path preserved exactly (`0.05 / 0.22`), so tokens at the
   old radius are pixel-identical and every smaller one wears a ring in proportion to itself. */
export const STATION_TOKEN_RING_WIDTH_RATIO = 0.05 / 0.22;

/* Design note #253: A BRAND COLOUR THAT CAN ACT AS LIGHT. The board veil, the legal-placement glow and the
   manual route line are all drawn in the acting corporation's colour, so one hue says whose turn it is
   everywhere at once -- and two of the three are LIGHT effects over a darkened board, where B&M's slate and
   PRR's deep red make almost no glow at all.
   So a colour used as light is measured first and a too-dark one is BRIGHTENED toward white rather than
   replaced by it: replacing would throw the identity away exactly when the board is trying to communicate
   it. The threshold is relative luminance, the same quantity `bestContrastTextColor` uses, so this file has
   one idea of "dark". */
export function glowColorFor(color: string, minimumLuminance = 0.32): string {
  const parse = (index: number) => parseInt(color.slice(index, index + 2), 16) / 255;
  const channels = [1, 3, 5].map(parse);
  /* Design note #1092 swept this to `#f2f0eb` and it is REVERTED. This is not a theme value: it is the
     fallback of a function whose whole job is to return a maximum-contrast glow for an unparseable livery,
     and the sibling `bestContrastTextColor` returns literal `#FFFFFF`/`#000000` for the same reason. Paper
     is 16.8:1 where white is 21:1, and a re-theme does not get to shave the safety margin off the branch
     that runs when the input was already wrong. */
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

/* Design note #403 (SUPERSEDED BY #408): PRR and NNH were `#c0392b` and `#b03a2e` -- CIELAB dE 8.4 apart,
   and below about 15 two colours read as the same colour, so the New Haven and the Pennsylvania were
   effectively one livery. The colour it chose does not survive #408; the note is kept because the METHOD --
   measure the separation, do not judge it -- is what carried forward.
   Design note #408: THE COLOURS THE BOARD ACTUALLY USES. This palette was never canonical, and for a player
   who knows 1830 that is worse than an arbitrary one: the Erie is yellow on the board, and reaching for the
   yellow token to find it is the B&O costs more than having no expectation at all.
   Two properties were re-checked rather than assumed. CONTRAST: every entry clears 4.5:1 against whichever
   of black or white the helper returns -- the WCAG bar for NORMAL text, which is the right one because 16px
   bold is not "large text" (that starts at 18.66px bold); the lowest is B&M green at 5.35:1, and each shade
   was chosen to clear the bar rather than the bar lowered to fit. SEPARATION: minimum pairwise dE across
   all 28 combinations is 44.4, against the 8.4 that started #403 -- canonical and distinguishable turned
   out not to be in tension, since the physical game already solved this with ink on cardboard.
   NYC IS `#1a1a1a`, NOT `#000000`: pure black would be indistinguishable from the card borders and the
   chart's gridlines, and a corporation whose livery is the colour of the furniture reads as a rendering
   failure rather than as the New York Central. */

export function stationTickerColor(companyId: number): string {
  // Design note #428: delegates rather than re-implementing the `?? fallback`.
  return corporationLiveryColor(companyId);
}

/** Corporate acronym overlay guarantee (design note #45): a deliberately DUPLICATED copy of
 *  `public_company.rs`'s real on-chain tickers, so a RESERVED/unfloated home-station badge can draw its
 *  acronym before `publicCompanies` has loaded -- or ever loads. The drawing pass prefers a live
 *  `company.ticker` and falls back to this rather than an empty string.
 *  Company 7's real ticker is `NNH`, not `NYNH`: the contract constant is the single source of truth, and
 *  "NYNH" is this project's colloquial name for the railroad. Using `NNH` keeps the placeholder identical to
 *  what will show once the corporation floats, so the badge never visibly flickers at that moment. */
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

/* Design note #428: `relativeLuminance` and `bestContrastTextColor` were DEFINED here and are now
   re-exported from `styles/corporationLivery.ts`. They are generic colour maths that lived here only
   because the map's station tokens were the first surface needing to put an acronym on an arbitrary
   corporate fill; four other surfaces call them now, and all four are about that palette. */

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

/** Discriminated union describing the click interceptor's in-flight/settled query state (design note #7),
 *  reported through `onHexClickQuery` so `App.tsx` can decide when and where to render the picker.
 *  Why a hex refused a tile-laying click -- design note #141. Defined HERE rather than beside
 *  `evaluateHexForTileLaying` in `hexGeometry.ts` purely to respect the one-way import rule: that module
 *  imports from this one, so it cannot import back. The type is data, the function is behaviour, and the
 *  data has to sit at the bottom.
 *    "not-a-hex"       the coordinate is not one of the 93 real board hexes
 *    "offboard"        a red off-board revenue terminal
 *    "gray-immutable"  a preprinted gray hex -- permanently fixed
 *    "max-tier"        the tile there is already the top colour tier
 *  `"out-of-reach"` is GONE (design note #257): it was the one reason that depended on whose turn it was
 *  rather than on the board, and it explained a refusal the Lay Track veil now makes visually -- a click on a
 *  dimmed hex is ignored outright, so there is no status left to carry. */
export type HexClickRejection = "not-a-hex" | "offboard" | "gray-immutable" | "max-tier";

export type HexClickQueryState =
  /** Design note #172: the click landed on NO HEX AT ALL -- open water, the margin, or one of the real gaps
   *  inside the board's non-convex outline. Distinct from `"blocked"` (a real hex you may not lay on): this
   *  carries no reason and no message, because there is nothing to explain -- the player clicked nothing.
   *  It exists so an ALREADY-OPEN in-situ UI can close. Returning silently left a radial menu anchored to an
   *  earlier hex sitting there while the player clicked empty sea to dismiss it. */
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
      /** Design note #506: the hex's centre-to-corner radius AS DRAWN,
       *  in canvas-CSS pixels -- `hexSize` through the live zoom. In-situ
       *  UI that must CLEAR the hex needs its on-screen size, and the
       *  centroid alone cannot supply it. */
      hexRadiusPx: number;
    }
  /** Design note #141: the hex failed one of the four static board gates, so `GetLegalTilePlacements` was
   *  never called and no picker may open.
   *  A distinct variant rather than reporting nothing, for the same reason `"offline"` is one: the consumer has
   *  to make a decision, and the exhaustiveness checker should be the thing that reminds it. Reporting nothing
   *  was the original behaviour and is indistinguishable from the click handler being broken -- the failure
   *  mode this codebase has already hit twice (#120 and #139, both silent-click bugs).
   *  Consumers MUST NOT open the tile picker on this status. */
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
      /** Design note #506: the hex's centre-to-corner radius AS DRAWN,
       *  in canvas-CSS pixels -- `hexSize` through the live zoom. In-situ
       *  UI that must CLEAR the hex needs its on-screen size, and the
       *  centroid alone cannot supply it. */
      hexRadiusPx: number;
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
      /** Design note #506: the hex's centre-to-corner radius AS DRAWN,
       *  in canvas-CSS pixels -- `hexSize` through the live zoom. In-situ
       *  UI that must CLEAR the hex needs its on-screen size, and the
       *  centroid alone cannot supply it. */
      hexRadiusPx: number;
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
      /** Design note #506: the hex's centre-to-corner radius AS DRAWN,
       *  in canvas-CSS pixels -- `hexSize` through the live zoom. In-situ
       *  UI that must CLEAR the hex needs its on-screen size, and the
       *  centroid alone cannot supply it. */
      hexRadiusPx: number;
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
      /** Design note #506: the hex's centre-to-corner radius AS DRAWN,
       *  in canvas-CSS pixels -- `hexSize` through the live zoom. In-situ
       *  UI that must CLEAR the hex needs its on-screen size, and the
       *  centroid alone cannot supply it. */
      hexRadiusPx: number;
      message: string;
    }
  /** Design note #120: no chain client is wired up, so `GetLegalTilePlacements` was never called and the
   *  placements came from the LOCAL catalog mirror.
   *  A separate status rather than a flag on `"success"` on purpose: these placements are era-gated and nothing
   *  more -- no connectivity check, no terrain reservation, no tray depletion, no upgrade-colour step. Folding
   *  them into `"success"` would let any consumer treat unvalidated data as authoritative simply by not knowing
   *  to check a flag, whereas a distinct variant makes the exhaustiveness checker point at every site that has
   *  to decide. Consumers MUST surface this as provisional and MUST NOT dispatch a `LayTile` from it. */
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
      /** Design note #506: the hex's centre-to-corner radius AS DRAWN,
       *  in canvas-CSS pixels -- `hexSize` through the live zoom. In-situ
       *  UI that must CLEAR the hex needs its on-screen size, and the
       *  centroid alone cannot supply it. */
      hexRadiusPx: number;
      placements: LegalTilePlacement[];
    };
