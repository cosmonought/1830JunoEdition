// frontend/src/components/StockRoundPanel.tsx
//
// Stock Round action control panel -- a card per corporation carrying its prices, ownership table,
// operating snapshot and its own Buy/Sell/par controls. Renders above the Stock Market Matrix
// whenever a Stock Round is live. Buy/Sell ownership lives here entirely; `ContextualActionBar`'s
// Stock-Round button branch is empty so there are never two competing control surfaces.
//
// Presentational only -- `App.tsx` owns state and threads it down (design note #1) -- and adds no
// backend surface: `BuyStock`/`SellStock` already accept every parameter these controls produce.
//
// Design notes: see `docs/ai_architecture/stock_market.md`.

import PresidentCrown from "./PresidentCrown";
import React, { useEffect, useRef, useState } from "react";
import type {
  PrivateCompanyState,
  PublicCompanyState,
  RoundType,
} from "../utils/gameState";
import type { GamePhase, TierRustOutlook, TrainTier } from "../utils/gamePhase";
// Design note #409: `TrainChips` is back, inline in the asset row. `CapacityPill` and
// `LastRoutePayout` stay out -- the train LIMIT is an Operating Round question, and the payout rides
// in the livery stripe (design note #392).
import { TrainChips } from "./TrainBadges";
// Design note #410: the corporate herald, shared with the action panel.
import { CorporateLogo } from "./CorporateLogo";
// Design note #682: what a buy or a sale leaves the player holding, and which
// way it moves. The colour rule lives there because it is a claim about meaning.
import {
  describeTreasuryProjection,
  projectTreasury,
  type TreasuryProjection,
} from "../utils/treasuryProjection";
import {
  allowsMultipleBankPoolBuys,
  marketZoneForPrice,
  // Design note #712: the zone-tinted figure, shared with the dividend move line.
  ZonedPrice,
  PAR_BOX_PRICES,
} from "./StockMarketRenderer";
// Design note #713: the sale's arithmetic and its two guards.
import { certificatesIn, saleProceeds } from "../utils/shareSale";
import { corporationFullName, corporationTitle } from "../utils/corporationNames";
// Design note #391/#395: the canonical rules text a private row expands to.
import { PRIVATE_COMPANY_CATALOG } from "../utils/privateCatalog";
import {
  applyCardOrder,
  operatingRoundCardOrder,
} from "../utils/corporationCardOrder";
import { StationTokenRow } from "./StationTokenRow";
import { stationTokenSlots } from "../utils/stationTokens";
import { FONT_SIZE } from "../styles/typography";
// Design note #389: the same ink-on-fill helper the map's station
// tokens use, so a corporate colour is legible on the card for the
// same reason it is legible on the board.
import { bestContrastTextColor } from "./hexContractTypes";
import { corporationLiveryColor } from "../styles/corporationLivery";
import {
  CARD_BORDER,
  CARD_BORDER_ACTIVE,
  CARD_DIVIDER,
  CARD_HIGHLIGHT_BG,
  CARD_HIGHLIGHT_BORDER,
  CARD_HIGHLIGHT_INK,
  CARD_INK,
  CARD_INK_FAINT,
  CARD_INK_MUTED,
  CARD_SURFACE,
  CARD_SURFACE_MUTED,
} from "../styles/palette";

export interface StockRoundPanelProps {
  publicCompanies: readonly PublicCompanyState[];
  /** Design note #712: why this purchase is illegal, or `null` if it is allowed. Resolved by `App`, which
   *  holds the whole board -- the certificate limit needs the private companies and the room's size, neither
   *  of which this panel is given. A FUNCTION rather than a precomputed string per card, because the answer
   *  depends on the source and quantity the player has selected HERE. */
  /** Design note #713: why this SALE is illegal, or `null`. Resolved by `App` for the same reason
   *  `purchaseBlockFor` is -- the successor rule reads every player's holdings. */
  saleBlockFor?: (companyId: number, percentage: number) => string | null;
  /** Design note #713: where the token lands after selling this many certificates, or `null` when the
   *  chart cannot say. The WALK lives in `projectShareSaleMove`, which owns the direction. */
  salePriceAfter?: (companyId: number, certificates: number) => number | null;
  purchaseBlockFor?: (
    companyId: number,
    source: "Ipo" | "Bank",
    quantity: number,
  ) => string | null;
  /** Design note #395: the room's private companies, so each card can list
   *  the ones its corporation owns. Optional -- a caller without game state
   *  simply renders no private rows. */
  privateCompanies?: readonly PrivateCompanyState[];
  /** Design note #398: the par selection for ONE corporation. A lookup
   *  rather than a value -- a single shared string made every card's ladder
   *  a view of the same selection, so pressing $90 on the PRR moved the
   *  B&O's ladder with it. */
  parValueFor: (companyId: number) => string;
  onSelectParValue: (companyId: number, value: string) => void;
  /** `App.tsx` design note #29: the target company travels with the click. Every card renders its own
   *  Buy/Sell, so there is no shared selection for these to read. */
  onBuyShare: (protocolId: number, source: "Ipo" | "Bank", quantity: number) => void;
  onSellShares: (protocolId: number, percentage: number) => void;
  sessionReady: boolean;
  isMyTurn: boolean;
  /* Design note #34: hotseat, and who is up. "Waiting for your turn..." named nobody, so on a shared
     keyboard it was a prompt to wait for yourself -- and every seat truncated to the same address
     (auction dashboard #31). `hotseat` shows the seat's NAME and drops the waiting framing entirely. */
  hotseat?: boolean;
  /** Whose turn it is, already resolved to a name. */
  activePlayerLabel?: string | null;
  /** Design note #682: the acting seat's own colour, for the treasury block.
   *  `null` when it is not known -- the block then falls back to the card's ink
   *  rather than inventing a seat, which is the same rule `playerLabel` follows
   *  for a name it cannot resolve. */
  actingSeatColor?: string | null;
  /** F-6: the connected wallet, needed to find THIS player's own stake in
   *  `player_holdings` and so bound the sell sizes to what they can actually
   *  cover. `null` when disconnected, which zeroes every option -- correct,
   *  since a disconnected viewer holds nothing to sell. */
  connectedAddress: string | null;
  /** Design note #356: the Stock Round's number. `1` bans selling. */
  macroRoundNumber?: number;
  /** Design note #357: what this player can actually spend. `null` when the
   *  room does not report it, which leaves the gate off. */
  playerCash?: number | null;
  /** Design note #8: live market price per `company_id`. A SEPARATE prop because on a real chain it is
   *  separate data -- `GetGameState` carries par and ownership, `GetMarketGrid` the live position.
   *  Missing/`null` means "no market position" and renders as a dash, never `0`. */
  marketPrices?: Readonly<Record<number, number | null>>;
  /** Optional address -> display name, so a roster can read "Alice" instead
   *  of `juno1abc...wxyz`. Returns `null` to fall back to truncation. Used
   *  by the sandbox; on a real chain there are no names to resolve yet. */
  playerLabel?: (address: string) => string | null;
  /** The room's derived phase (`utils/gamePhase.ts`) for the operating snapshot -- train limit and which
   *  tier is about to rust. Optional: without it the capacity pill reads "n / ?", which is honest. */
  phase?: GamePhase | null;
  /** Per-tier rust countdown, so the card-front chips can say how far off a
   *  rust is -- see `TrainBadges.tsx` design note #4. */
  outlook?: Readonly<Record<TrainTier, TierRustOutlook>> | null;
  /** Why buying and selling are unavailable, or `null` when they are legal. Design note #32: the roster
   *  became a persistent tab (`App.tsx #41`), so it is reachable outside a Stock Round. */
  actionsLockedReason?: string | null;
  /** Design note #464: the round, so the card order is recomputed at the
   *  Operating Round boundary and held through the Stock Round. */
  roundType: RoundType | null;
}

// Design note #8: the corporation roster -- a card each, so "who controls what, and what would it
// cost me" can be answered without clicking through all eight.
// THE PRESIDENT IS THE POINT: presidency is the only thing conferring control, it changes hands
// silently, and it is marked twice over (gold row + the spelled-out word) because colour alone fails a
// colourblind player and a word alone is skimmed past. The crown glyph was the third channel and
// design note #490 removed it -- an emoji ignores `color`/`fontWeight` and cannot be styled to match.
// NEVER DERIVED: `president` is a contract field. 1830 presidency transfers only when someone strictly
// exceeds the incumbent, so the largest holder is not reliably the president.

/** One row of the per-company holdings table. */
interface RosterHolding {
  address: string;
  percentage: number;
  isPresident: boolean;
  isSelf: boolean;
}

function CorporationRoster({
  publicCompanies,
  phase,
  outlook,
  marketPrices,
  roundType,
  connectedAddress,
  macroRoundNumber,
  playerCash,
  playerLabel,
  privateCompanies,
  activeCompanyId,
  onActivateCompany,
  expandedPrivateId,
  setExpandedPrivateId,
  parValueFor,
  onSelectParValue,
  onBuyShare,
  purchaseBlockFor,
  saleBlockFor,
  salePriceAfter,
  onSellShares,
  controlsDisabled,
  controlsBlockedReason,
  actingSeatColor,
  tradingOpen,
}: {
  publicCompanies: readonly PublicCompanyState[];
  /** Design note #713: why this SALE is illegal, or `null`. Resolved by `App` for the same reason
   *  `purchaseBlockFor` is -- the successor rule reads every player's holdings. */
  saleBlockFor?: (companyId: number, percentage: number) => string | null;
  /** Design note #713: where the token lands after selling this many certificates, or `null` when the
   *  chart cannot say. The WALK lives in `projectShareSaleMove`, which owns the direction. */
  salePriceAfter?: (companyId: number, certificates: number) => number | null;
  /** Design note #712: the zone rules, resolved by `App` against the whole board. */
  purchaseBlockFor?: (
    companyId: number,
    source: "Ipo" | "Bank",
    quantity: number,
  ) => string | null;
  phase?: GamePhase | null;
  outlook?: Readonly<Record<TrainTier, TierRustOutlook>> | null;
  marketPrices?: Readonly<Record<number, number | null>>;
  /** Design note #464: the round, so the card order can be recomputed at
   *  the Operating Round boundary and held everywhere else. */
  roundType: RoundType | null;
  connectedAddress: string | null;
  /** Design note #356: the Stock Round's number; `1` bans selling. */
  macroRoundNumber?: number;
  /** Design note #357: the acting player's spendable cash, for the buy gate. */
  playerCash?: number | null;
  playerLabel?: (address: string) => string | null;
  /** Design note #395: the whole private roster; each card filters out its
   *  own. Optional so a caller without game state renders no private rows
   *  rather than needing a stub. */
  privateCompanies?: readonly PrivateCompanyState[];
  /** Design note #396: the card whose action bar is rendered. `null` means
   *  no card is active and no card shows Buy/Sell/Par. */
  activeCompanyId: number | null;
  onActivateCompany: (companyId: number | null) => void;
  /** Design note #395: which private's rules text is open, across all
   *  cards -- one at a time, like the active card but a separate cursor. */
  expandedPrivateId: number | null;
  setExpandedPrivateId: (privateId: number | null) => void;
  parValueFor: (companyId: number) => string;
  onSelectParValue: (companyId: number, value: string) => void;
  onBuyShare: (protocolId: number, source: "Ipo" | "Bank", quantity: number) => void;
  onSellShares: (protocolId: number, percentage: number) => void;
  controlsDisabled: boolean;
  /** Design note #681: why, when `controlsDisabled` is true. Threaded to the
   *  cards so a greyed control can answer for itself -- a button that cannot
   *  say why it is out reads as broken rather than as barred. */
  controlsBlockedReason: string | null;
  /** Design note #682: the acting seat's colour, for the treasury block. */
  actingSeatColor: string | null;
  /** Design note #417: `false` outside a Stock Round -- each card then
   *  renders no trading controls at all. */
  tradingOpen: boolean;
}) {
  /* Design note #464: recomputed at the Operating Round BOUNDARY. `null` until the first one
     establishes an order, leaving the contract's own table order as a neutral start. `prevRoundRef`
     makes it an edge, not a level, so a mid-round poll cannot re-sort cards under a reader. */
  const [cardOrder, setCardOrder] = useState<number[] | null>(null);
  const prevRoundRef = useRef<RoundType | null>(null);
  useEffect(() => {
    const entering = roundType === "OperatingRound" && prevRoundRef.current !== "OperatingRound";
    prevRoundRef.current = roundType;
    if (!entering) return;
    setCardOrder(operatingRoundCardOrder(publicCompanies, marketPrices));
    // `publicCompanies`/`marketPrices` are read at the transition and
    // deliberately NOT dependencies -- including them would re-run this
    // every poll, which is the continuous re-sorting being removed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roundType]);

  if (publicCompanies.length === 0) {
    return (
      <div style={styles.section}>
        <span style={styles.sectionLabel}>Corporations</span>
        <span style={styles.rosterEmpty}>
          No corporation data yet — waiting on the first GetGameState response.
        </span>
      </div>
    );
  }

  return (
    <div style={styles.section}>
      <span style={styles.sectionLabel}>Corporations</span>
      <div style={styles.rosterGrid}>
        {/* Design note #464 (supersedes #446): the order is HELD. #446 sorted floated companies to the front
           on every render -- right about the order, wrong about the moment, since buying is what causes floats
           and the act of using the screen rearranged it. `cardOrder` is recomputed only when an Operating Round
           begins (`utils/corporationCardOrder.ts`) and held until the next one. */}
        {applyCardOrder(publicCompanies, cardOrder).map((company) => {
          const color = tickerColor(company.company_id);
          /* Design note #447: `last_route_revenue` is optional and `gameState.ts` is explicit that `undefined`
             means "this build cannot tell you" while "0" means "it earned nothing" -- and a company that never
             operated reports "0" too. The honest test is a positive figure; anything else is a dash. */
          const hasRunRoutes = (Number(company.last_route_revenue ?? 0) || 0) > 0;
          // Design note #389: derived from the fill, so every corporation's
          // stripe is legible without a per-company decision.
          const liveryInk = bestContrastTextColor(color);
          /* Design note #393: `owned_trains` is nullable on the wire and the
             badges this row replaced absorbed that internally. Normalised
             once here rather than guarded at each of the three reads. */
          const trains = company.owned_trains ?? [];
          /* Design note #490: `tokensPlaced` is gone -- `StationTokenRow` has always drawn the same fact as
             circles, so the count was a second, worse rendering of the row beside it.
             Design note #395: the same `corporationPrivateCompanies` predicate, filtered here rather than
             imported because that helper takes a whole `GameStateResponse` and this panel gets only the roster. */
          const ownedPrivates = (privateCompanies ?? []).filter(
            (priv) => !priv.closed && priv.owner_protocol_id === company.company_id,
          );
          const isActive = company.company_id === activeCompanyId;
          const market = marketPrices?.[company.company_id] ?? null;

          // Sorted by stake, largest first. The president is NOT forced to
          // the top: seeing them sitting second on an equal stake is
          // precisely the situation a player needs to notice, and hoisting
          // them would hide it.
          const holdings: RosterHolding[] = company.player_holdings
            .slice()
            .sort((a, b) => b.percentage - a.percentage)
            .map((h) => ({
              address: h.player,
              percentage: h.percentage,
              isPresident: company.president === h.player,
              isSelf: connectedAddress !== null && h.player === connectedAddress,
            }));

          const cardFace = (
            <>
                {/* Design notes #16/#26: the ENTIRE surface is the toggle. A caret is a ~20px target on a ~300px card
                   that is itself the thing being chosen. Design note #396: the click makes this card ACTIVE, and
                   clicking it again deactivates -- so there is always a way back to a board with no controls on it. */}
                <button
                  type="button"
                  onClick={() => onActivateCompany(isActive ? null : company.company_id)}
                  aria-expanded={isActive}
                  aria-label={`${company.ticker} — ${isActive ? "hide" : "show"} share actions`}
                  style={styles.rosterCardToggle}
                >
                {/* Design note #389: THE HEADER IS THE LIVERY. A corporation's colour was a 16px tint on the ticker
                   glyphs, while the same colour is a FIELD on the map token, the route ribbon and the chart token --
                   so eight cards distinguished by four coloured letters made the player read to identify a card.
                   `tickerColor` is the same lookup those surfaces use (design note #428 finally made that ONE table in
                   `styles/corporationLivery.ts`; there were three hand-kept copies when this was written).
                   THE INK IS COMPUTED, NOT CHOSEN -- `bestContrastTextColor`, the same helper the map's tokens use.
                   TD-3, checked against the live palette rather than remembered: three of the eight take black and five
                   take white, so any fixed choice is wrong for at least three corporations. White fails on ERIE's yellow
                   `#f5cd3a`; black fails on B&O's dark blue `#12408f`. (An earlier version of this note cited C&O's
                   amber and CPR's purple -- both stale since design note #408 replaced the palette with the board's.) */}
                <div style={{ ...styles.rosterLivery, backgroundColor: color, color: liveryInk }}>
                  {/* Design note #501: the mark and the handle, ONE line. `rosterNameStack` is a column and #465 added the
                     acronym as its second child -- so "beside the logo", which is what that note asked for and what its own
                     text says, came out underneath it. The stack keeps its column for the FULL NAME, which is read second,
                     needs the card's width and already ellipsises. */}
                  <span style={styles.rosterNameStack}>
                    <span style={styles.rosterIdentityRow}>
                    {/* Design note #410: the historical herald replaces the acronym. 26px against ~33px of text content, so
                       it sits INSIDE the existing height rather than setting a new one. The fallback keeps the old typography
                       exactly, so a missing file is indistinguishable from the previous design rather than a visible hole. */}
                    <CorporateLogo
                      ticker={company.ticker}
                      size={26}
                      color={liveryInk}
                      title={corporationTitle(company.ticker)}
                      fallbackStyle={styles.rosterLiveryTicker}
                    />
                    {/* Design note #465: THE ACRONYM COMES BACK, beside the herald rather than instead of it. #410 traded
                       one for the other and the trade was not even -- a herald is unmistakable once you know it and
                       unreadable until you do, and the full name is too long to serve as the quick label. "PRR" is what a
                       player says out loud and what every other surface calls the company.
                       `CorporateLogo`'s text fallback would double the ticker when a file is missing -- only in the failure
                       case, and a doubled ticker is a better failure than a nameless card. */}
                      <span style={styles.rosterLiveryAcronym}>{company.ticker}</span>
                    </span>
                    {corporationFullName(company.ticker) && (
                      <span style={styles.rosterLiveryName}>
                        {corporationFullName(company.ticker)}
                      </span>
                    )}
                  </span>
                  {/* Float status rides in the stripe too. Both badges take their ink FROM the stripe rather than carrying
                     their own, so neither can become unreadable on a corporation whose colour they were not designed
                     against. */}
                  {/* Design note #392: THE PAYOUT RIDES IN THE STRIPE. It was one of four stacked label/value cells, each
                     spending a caption line on a single figure; last payout is the one a share buyer weighs most directly.
                     Not the same thing as the float badge beside it -- the badge says whether the company is trading at
                     all, the payout says what it paid when it did. */}
                  {/* Design note #447: THE PAYOUT LEAVES THE STRIPE. #392's "the stripe had unused width" stopped holding
                     the moment the herald replaced the acronym (#410): a bare figure beside a logo, aligned to nothing and
                     uncaptioned, reads as part of the corporation's identity, and "$0" beside a herald looks like an error.
                     It moves to the value row, where three labelled figures make a table. */}
                  {/* Design note #488: THE STRIPE CARRIES ONE FACT NOW. #465's "captioned by position" means captioned by
                     nothing. Last Run moves down beside Market and IPO/Par, which sit under real captions.
                     WHAT STAYS is float PROGRESS -- the one fact about a corporation that is neither a price nor permanent,
                     and which disappears the moment it is answered. An unfloated company has no market price, no last run
                     and no treasury worth reading, so the stripe is where its only live number belongs. */}
                  {/* Design note #503: ONE SLOT, TWO LIVES. This reverses #488, and #488's objection deserves an answer:
                     a naked figure beside a herald is captioned by nothing. True of that version, not of this one -- the
                     figure goes IN the badge, with its border and an explicit caption inside it.
                     The two facts are mutually exclusive in time and identical in role: an unfloated corporation's one live
                     number is how close it is to floating, a floated one's is what it last earned. A slot holding exactly
                     one of them is the shape of the data, which is also why #488's "empty slot" complaint disappears.
                     "--" NOT "$0" for a corporation that has never run (design note #465): "0" is reported both by a
                     company that earned nothing and by one that has never turned a wheel. */}
                  <span style={styles.rosterLiveryRight}>
                    <span
                      style={{ ...styles.rosterLiveryBadge, color: liveryInk, borderColor: liveryInk }}
                      title={
                        company.is_floated
                          ? hasRunRoutes
                            ? `${company.ticker} last ran its trains for $${company.last_route_revenue}.`
                            : `${company.ticker} has floated but has not yet run its trains.`
                          : `${soldToPlayersPercent(company)}% sold to players; ${FLOAT_THRESHOLD_PERCENT}% floats this corporation.`
                      }
                    >
                      {company.is_floated ? (
                        <>
                          <span style={styles.rosterLiveryBadgeCaption}>Last run</span>
                          {hasRunRoutes ? `$${company.last_route_revenue}` : "--"}
                        </>
                      ) : (
                        `${soldToPlayersPercent(company)}% / ${FLOAT_THRESHOLD_PERCENT}%`
                      )}
                    </span>
                  </span>
                </div>

                {/* The two prices, side by side and labelled. Market is the
                    live figure and gets the emphasis; par is what it floated
                    at and is the reference point for judging it. */}
                <div style={styles.rosterPriceRow}>
                  {/* Design note #387: NO PAR, NO MARKET FIGURE. The price table had been seeded from a mid-game fixture
                     regardless of scenario, so a Zero State corporation showed a price for a share nobody can own at a
                     valuation nothing set. The market price is DEFINED as where the token stands, and a company with no
                     par has no token -- asserted here as well as in the seed and the chart's filter. */}
                  {/* Design note #502: the `$`. Treasury has carried one since #489 and these two did not, so one line
                     held three dollar figures of which only the rightmost said so. The dash stays bare -- "$--" would put
                     a currency on an absent value. */}
                  <div style={styles.rosterPrice}>
                    {/* Design note #712: THE ZONE, ON THE FIGURE. Reported: "when a corporation is in
                        yellow/orange/brown zones, its Market Price on the corp cards reflects that."
                        It did not, and the omission was the same shape as the rules bug beside it -- the
                        chart knew, and the card a player actually reads did not. `ZonedPrice` has tinted the
                        dividend line since #197 for precisely this reason ("a player reading this panel is
                        looking at a NUMBER, not the chart"), so this is that component reaching the surface
                        it was always describing.
                        THE INK, NOT A BOX: the report offered either, and a filled swatch here would compete
                        with the eight corporation liveries this roster already carries (#13's argument for
                        colouring the ticker's ink rather than its cell). */}
                    <span style={styles.rosterPriceValue}>
                      {company.par_value === null || market === null ? (
                        "--"
                      ) : (
                        <ZonedPrice price={market} />
                      )}
                    </span>
                    <span style={styles.rosterPriceLabel}>market</span>
                  </div>
                  <div style={styles.rosterPrice}>
                    <span style={styles.rosterPriceValueMuted}>
                      {company.par_value === null ? "--" : `$${company.par_value}`}
                    </span>
                    <span style={styles.rosterPriceLabel}>IPO / par</span>
                  </div>
                  {/* Design note #503: Last Run is GONE from this row -- it
                      is in the livery stripe, in the slot the float badge
                      vacates. See that slot for the reasoning. */}
                  {/* Design note #489: TREASURY BELONGS WITH THE MONEY. It sat on the asset row, filed with what the
                     corporation OWNS -- a defensible taxonomy and the wrong one for a share buyer, who was reading cash in
                     a different row, type size and alignment from every other number on the card.
                     FLUSH RIGHT, not fourth in the line: Market, IPO/Par and Last Run are PER-SHARE facts that read as a
                     sequence, while treasury is the corporation's own money. `marginLeft: auto` also absorbs the slack so
                     four evenly-spaced columns cannot drift apart on a wide card. */}
                  <div style={{ ...styles.rosterPrice, ...styles.rosterTreasury }}>
                    <span style={styles.rosterPriceValue}>${company.treasury}</span>
                    <span style={styles.rosterPriceLabel}>treasury</span>
                  </div>
                </div>

                {/* Design note #393: ONE LINE OF ASSETS. #31 put this data on the front for a reason that still holds --
                   whether a corporation is one purchase from losing its trains changes what a share is worth before you
                   look at the price. What it got wrong was the FORMAT: four caption/value cells plus two badge sets,
                   times eight cards, to say three numbers.
                   Design note #409: `TrainChips` came BACK, inline. #393 argued the rust colouring could go because "on a
                   Stock Round card the question is what does it own" -- contradicted by its own second paragraph. Rust is
                   the difference between a fleet and a pile of scrap, and the Stock Round is when it is being priced.
                   `CapacityPill` stays gone: the train LIMIT is about what may be bought NEXT, an Operating Round
                   decision. Station tokens are shown as placed-over-limit, which neither old cell showed at all. */}
                {/* Design note #490: THE WORDS, NOT THE PICTOGRAMS. #393's "the icons are the captions" was wrong twice.
                   AN EMOJI IS NOT TYPOGRAPHY -- it renders in the platform's colour font at its own weight, ignoring
                   `color`, `fontWeight` and the type scale, so the one element meant to be a caption is the only one that
                   cannot be styled as one, and three saturated pictograms out-shout the numbers they label.
                   A TOOLTIP IS NOT A LABEL -- it needs a pointer, a hover and a wait, and is unreachable on touch.
                   `TrainChips` and `StationTokenRow` remain the values; only the captions change. Treasury left this row
                   entirely (#489), which is what made room for two spelled-out labels without wrapping. */}
                {/* Design note #504: CAPTION UNDER VALUE, BOTH ROWS. #490 put the words beside the values because it
                   inherited an inline row, so the card captioned its two rows in opposite orders. `assetItem` becomes a
                   column matching `rosterPrice`'s shape.
                   The label keeps `assetLabel`, not `rosterPriceLabel`: #490 already tuned it to that caption treatment,
                   and swapping the style would change the type scale of a caption sitting under a chip row. */}
                <div style={styles.assetRow}>
                  <span style={styles.assetItem}>
                    {/* Design note #409: the real chips, with the rust colouring a share buyer is pricing -- `compact` and
                       the light surface, matching the Operating Round's own rendering so the two screens cannot disagree.
                       Design note #490: the empty case gets WORDS too. "none" says the corporation owns none, which is the
                       fact that decides whether it is about to be forced into an emergency purchase. */}
                    {trains.length > 0 ? (
                      <TrainChips
                        trains={trains}
                        phase={phase ?? null}
                        surface="light"
                        compact
                        outlook={outlook}
                      />
                    ) : (
                      <span style={styles.assetEmpty}>none</span>
                    )}
                    <span style={styles.assetLabel}>Trains</span>
                  </span>
                  <span style={styles.assetDivider} aria-hidden="true">|</span>
                  {/* Design note #424: THE CAPACITY, DRAWN. `2/4` is a count, and the row that replaces it answers three
                     questions the fraction cannot: which tokens are spent, where the home one sits, and -- the one that
                     decides a purchase -- what the NEXT one costs.
                     THE SAME COMPONENT, not a second one that looks like it: both surfaces describe one corporation's
                     allowance, and this file has been bitten by two renderers of one fact drifting apart (#423).
                     THE INKS ARE THE CARD'S. `StationTokenRow` takes its colours as props precisely because it sits on the
                     bar's livery and on this card's light paper; the bar's near-white ink would vanish here. */}
                  <span style={styles.assetItem}>
                    <StationTokenRow
                      slots={stationTokenSlots(company)}
                      color={tickerColor(company.company_id)}
                      ink={CARD_INK}
                      inkMuted={CARD_INK_MUTED}
                      homeHexLabel={company.home_hex_label}
                      emptyLabel="none"
                    />
                    {/* Design note #504: under the value, like every other
                        caption on this card. */}
                    <span style={styles.assetLabel}>Stations</span>
                  </span>
                </div>

                {/* Design note #378: ONE OWNERSHIP TABLE, IN 18xx ORDER. It was two readouts describing one thing -- a
                   player list here and the IPO/Bank Pool counts underneath in a different format with no shared columns
                   -- so "where are the nine certificates" had its answer split across two shapes that did not line up.
                   One table, in the order the physical game keeps its certificates: the two BANKS first, a rule, then the
                   PLAYERS. The rule is the line between shares nobody owns and shares somebody does.
                   THREE COLUMNS: shareholder, certificates, percentage. Certificates first because that is the physical
                   unit a player moves, and because the president's 20% being ONE certificate is what a percentage hides.
                   SORTED DESCENDING, and the president is NOT hoisted -- seeing them second on an equal stake is exactly
                   what a player needs to notice. */}
                <div style={styles.ownershipTable} role="table" aria-label={`${company.ticker} ownership`}>
                  {/* Design note #394: ENTITY / SHARES / PRICE. The old third column was `%`, so the header described the
                     banks and the players identically while the two rows answered different questions: a player's
                     percentage is their STAKE, the IPO's is INVENTORY, and what a buyer wants beside inventory is cost.
                     So the percentage moves in beside the count -- `7 (70%)` -- and the freed column carries price.
                     THE TWO PRICES ARE DIFFERENT, and that is 1830: an IPO share costs the PAR price the president set, a
                     Bank Pool share the CURRENT MARKET price. One price for both rows would be wrong for most of the game.
                     A PLAYER ROW'S PRICE IS BLANK, deliberately, not a dash -- there is no price at which a player's shares
                     are for sale, and printing the market figure there would read as an offer. */}
                  <div style={styles.ownershipHeadRow} role="row">
                    <span style={styles.ownershipName} role="columnheader">Entity</span>
                    <span style={styles.ownershipNum} role="columnheader">Shares</span>
                    <span style={styles.ownershipNum} role="columnheader">Price</span>
                  </div>

                  {/* The two banks, always shown -- an IPO at 0% means the
                      company is fully distributed, which is worth as much
                      as any other figure here. */}
                  <div style={styles.ownershipRow} role="row">
                    <span style={styles.ownershipName} role="cell">IPO</span>
                    {/* Design note #448: NINE CERTIFICATES, NOT TEN -- one 20% President's Certificate plus eight 10% shares.
                       `percentage / 10` counts PERCENT BLOCKS, so a full IPO read "10" for a stack of nine pieces of card,
                       and the extra digit is what clipped the column. `certificateCount` already knew this and the player
                       rows already used it; the two bank rows were doing raw division beside them, so one table counted in
                       two units. WHILE THE PRESIDENCY IS UNSOLD the 20% certificate sits in the IPO, which is why this cannot
                       be a constant 9. */}
                    <span style={styles.ownershipNum} role="cell">
                      {certificateCount(company.ipo_pool_percentage, company.president === null)} (
                      {company.ipo_pool_percentage}%)
                    </span>
                    <span
                      style={styles.ownershipNum}
                      role="cell"
                      title="IPO shares are bought at the par price set when this corporation was floated."
                    >
                      {company.par_value === null ? "--" : `$${company.par_value}`}
                    </span>
                  </div>
                  <div style={styles.ownershipRow} role="row">
                    <span style={styles.ownershipName} role="cell">Bank Pool</span>
                    {/* Design note #448: the same unit as every other row. A President's Certificate cannot reach the Bank
                       Pool -- a president must dump the presidency before selling out -- so `false` is not a simplification. */}
                    <span style={styles.ownershipNum} role="cell">
                      {certificateCount(company.bank_pool_percentage, false)} (
                      {company.bank_pool_percentage}%)
                    </span>
                    <span
                      style={styles.ownershipNum}
                      role="cell"
                      title="Bank Pool shares are bought at the current market price."
                    >
                      {/* Design note #387: no par, no market figure. */}
                      {company.par_value === null || market === null ? "--" : `$${market}`}
                    </span>
                  </div>

                  {/* Design note #378: the line between unowned and owned. */}
                  <hr style={styles.ownershipRule} />

                  {holdings.length === 0 ? (
                    <span style={styles.rosterNoHoldings}>No shares held by players</span>
                  ) : (
                    /* Design note #421: the highlight follows the READER, not the president. The crown already marks the
                       presidency unmistakably, so an amber row behind it emphasised a fact needing none -- while the one
                       row a reader scans for was marked by a pale pill in the weakest position. The two swap weights and
                       the "you" tag is deleted rather than moved. `isSelf` needs an address, so hotseat highlights none. */
                    holdings.map((holding) => (
                      <div
                        key={holding.address}
                        role="row"
                        style={{
                          ...styles.ownershipRow,
                          ...(holding.isSelf ? styles.rosterHoldingRowSelf : {}),
                        }}
                      >
                        <span style={styles.ownershipName} role="cell">
                          {/* Design note #552: the WORD is gone and the crown is back, as our own drawing. #490 removed the emoji
                             because a platform pictogram in a platform colour font could not be relied on to mean anything, and the
                             word that replaced it is nine characters wide in a column that must also fit a name. An inline SVG is
                             the same shape everywhere, takes the row's ink, and announces "President" to a screen reader. */}
                          {holding.isPresident && (
                            <PresidentCrown style={styles.presidentTag} scale={0.95} />
                          )}
                          {playerLabel?.(holding.address) ?? truncateHolder(holding.address)}
                        </span>
                        <span style={styles.ownershipNum} role="cell">
                          {certificateCount(holding.percentage, holding.isPresident)} ({holding.percentage}%)
                        </span>
                        {/* Design note #394: blank, not a dash. */}
                        <span style={styles.ownershipNum} role="cell" />
                      </div>
                    ))
                  )}

                  {/* Design note #395: THE PRIVATES THIS COMPANY OWNS. They belong in the ownership table because they ARE
                     holdings -- a private inside a corporation is an asset the shareholders own a piece of, and it pays into
                     the treasury every Operating Round.
                     THE ELLIPSIS IS LOAD-BEARING: "Champlain & St. Lawrence" is 24 characters and the card is fixed-width
                     (#22), so without `textOverflow` every card carrying it grows a line. Clipping is acceptable only
                     BECAUSE the row expands.
                     EXPANSION IS PER PRIVATE and independent of which card is active: reading what the D&H does is a
                     reference lookup, not an action, so it must not compete with the selection that governs Buy and Sell. */}
                  {ownedPrivates.length > 0 && (
                    <>
                      <hr style={styles.ownershipRule} />
                      {ownedPrivates.map((priv) => {
                        const open = expandedPrivateId === priv.private_id;
                        const entry = PRIVATE_COMPANY_CATALOG[priv.private_id];
                        return (
                          <div key={priv.private_id} style={styles.privateRowGroup}>
                            <button
                              type="button"
                              style={styles.privateRow}
                              aria-expanded={open}
                              onClick={(event) => {
                                // The card behind this is itself a click
                                // target (design note #396); reading a
                                // private must not also activate the card.
                                event.stopPropagation();
                                setExpandedPrivateId(open ? null : priv.private_id);
                              }}
                              title={open ? priv.name : `${priv.name} — click for its rules text.`}
                            >
                              <span style={open ? styles.privateNameOpen : styles.privateName}>
                                {priv.name}
                              </span>
                              <span style={styles.privateRevenue}>
                                +${priv.revenue_per_or}
                              </span>
                            </button>
                            {open && (
                              <p style={styles.privateRules}>
                                {entry?.ability ?? "No recorded special power."}
                              </p>
                            )}
                          </div>
                        );
                      })}
                    </>
                  )}

                </div>

                {/* Design note #345: ONE FLOAT READOUT, NOT TWO. #17 put a progress bar in the collapsed body for a good
                   reason, and then the pill badge arrived above it answering the same question in one line -- eight cards
                   each spending a track, a fill, a threshold tick and a caption on a figure printed six pixels higher.
                   The pill wins because it is already IN the header row a player reads first. */}

                {/* Design note #445: THE RULE THIS NAMED DOES NOT EXIST. Reported as critical: the codebase assumes a
                   corporation can float during the Auction Round.
                   THE REDUCER WAS ALREADY RIGHT -- `grantBOPresidency` moves 20%, the presidency and par, and leaves
                   `is_floated` alone; the fixture ships B&O unfloated. WHAT WAS WRONG WAS THIS LABEL, and it TAUGHT the
                   rule: a badge reading "Auto-floated by the B&O private" tells every player such a route exists.
                   So no cause is named. If `is_floated` is true below 60% the flag and the arithmetic disagree, and that
                   is a data fault to surface rather than a rule to rationalise. */}
                {company.is_floated && !metFloatThreshold(company) && (
                  <span style={styles.floatMismatchNote}>
                    Floated flag set at {soldToPlayersPercent(company)}% sold &middot; expected{" "}
                    {FLOAT_THRESHOLD_PERCENT}%
                  </span>
                )}

              </button>
            </>
          );

          const cardActions = (
            <CompanyActions
              company={company}
              // Design note #387: an unparred company has no market price,
              // so the controls that branch on one (the Brown-zone
              // multi-buy) see the same `null` the card displays.
              marketPrice={company.par_value === null ? null : market}
              purchaseBlockFor={purchaseBlockFor}
              saleBlockFor={saleBlockFor}
              salePriceAfter={salePriceAfter}
              connectedAddress={connectedAddress}
              macroRoundNumber={macroRoundNumber}
              playerCash={playerCash}
              parValue={parValueFor(company.company_id)}
              onSelectParValue={onSelectParValue}
              onBuyShare={onBuyShare}
              onSellShares={onSellShares}
              controlsDisabled={controlsDisabled}
              controlsBlockedReason={controlsBlockedReason}
              actingSeatColor={actingSeatColor}
              // Design note #417: no Stock Round, no controls at all.
              tradingOpen={tradingOpen}
            />
          );

          /* Design note #388: the flip is gone; every action renders on the card front.
             #26 chose it because an expanding card reflowed the grid, and a rotated card does not -- but hiding
             the numbers behind the decision meant a parallel render of the same corporation that had to be kept
             in agreement (#355), plus a `stopPropagation` guard that then swallowed clicks on padding.
             The front deletes the parallel render, the guard and the fixed 460px frame; the reflow is handled by
             cards keeping their own height, with actions rendering for the EXPANDED card only. */

          return (
            <div
              key={company.company_id}
              style={{
                ...styles.rosterCard,
                ...(company.is_floated ? {} : styles.rosterCardUnfloated),
                ...(isActive ? styles.rosterCardActive : {}),
                borderColor: isActive ? CARD_BORDER_ACTIVE : CARD_BORDER,
              }}
            >
              {cardFace}
              {/* Design note #396: ONE CARD HOLDS THE CONTROLS. This reverses #388, left standing above rather than
                 edited away. That note argued a control needing a click to reveal is one the player must remember is
                 there -- sound, and it did not weigh the MULTIPLIER: eight corporations x ~twenty controls is roughly
                 160 controls on one screen, at which density nothing is discoverable because the eye has nowhere to land.
                 The reversal is narrow and #388's real point survives: the actions still render on the FRONT, in place,
                 under the numbers they act on. Only eight copies became one. Clicking again clears it, which is one
                 fewer control than a close button. */}
              {isActive && cardActions}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** The buy/sell controls for ONE corporation -- design note #10. Scoping them to a card means each
 *  control is unambiguously about the company whose numbers are directly above it, and the float bar,
 *  par ladder and sell bounds are all computed from THAT company. */
function CompanyActions({
  company,
  marketPrice,
  connectedAddress,
  macroRoundNumber,
  playerCash,
  parValue,
  onSelectParValue,
  onBuyShare,
  purchaseBlockFor,
  saleBlockFor,
  salePriceAfter,
  onSellShares,
  controlsDisabled,
  controlsBlockedReason,
  actingSeatColor,
  tradingOpen,
}: {
  company: PublicCompanyState;
  /** This company's live market price, or `null` when it has no position.
   *  Design note #33: decides whether the Brown-zone quantity selector
   *  appears at all. */
  marketPrice: number | null;
  connectedAddress: string | null;
  macroRoundNumber?: number;
  playerCash?: number | null;
  /** This company's own par selection -- design note #398. */
  parValue: string;
  onSelectParValue: (companyId: number, value: string) => void;
  onBuyShare: (protocolId: number, source: "Ipo" | "Bank", quantity: number) => void;
  /** Design note #713: why this SALE is illegal, or `null`. Resolved by `App` for the same reason
   *  `purchaseBlockFor` is -- the successor rule reads every player's holdings. */
  saleBlockFor?: (companyId: number, percentage: number) => string | null;
  /** Design note #713: where the token lands after selling this many certificates, or `null` when the
   *  chart cannot say. The WALK lives in `projectShareSaleMove`, which owns the direction. */
  salePriceAfter?: (companyId: number, certificates: number) => number | null;
  /** Design note #712: why this purchase is illegal, or `null`. Resolved by `App` against the whole board. */
  purchaseBlockFor?: (
    companyId: number,
    source: "Ipo" | "Bank",
    quantity: number,
  ) => string | null;
  onSellShares: (protocolId: number, percentage: number) => void;
  controlsDisabled: boolean;
  /** Design note #681: why, when `controlsDisabled` is true. */
  controlsBlockedReason: string | null;
  /** Design note #682: the acting seat's colour, for the treasury block. */
  actingSeatColor: string | null;
  /** Design note #417: whether shares can be traded AT ALL right now, i.e.
   *  whether this is a Stock Round. `false` renders no controls -- not
   *  disabled ones. */
  tradingOpen: boolean;
}) {
  /* Design note #18: BUY SOURCE IS LOCAL. A single `App.tsx`-owned `source` flipped IPO/Bank on all
     eight cards at once, so the toggle a player set on PRR governed the purchase they made from B&M.
     The previous pass removed the shared COMPANY selection for this exact bug and left the toggle --
     "which company" and "which source" are the same kind of per-card decision. */
  const [source, setSource] = useState<"Ipo" | "Bank">("Ipo");
  const [buyQuantity, setBuyQuantity] = useState(1);

  // Design note #33: Brown is the only zone that permits several bank-pool
  // shares in one turn, and the pool itself is the ceiling. `marketPrice`
  // is `null` for an unfloated company, which `marketZoneForPrice` reports
  // as no zone -- so an unfloated card can never show the selector.
  const zone = marketZoneForPrice(marketPrice);
  const multiBuyMax =
    allowsMultipleBankPoolBuys(zone) && source === "Bank"
      ? Math.max(1, Math.floor(company.bank_pool_percentage / 10))
      : 1;
  const effectiveQuantity = Math.min(Math.max(1, buyQuantity), multiBuyMax);

  /* Design note #712: THE RULES THE CHART ALREADY DESCRIBED. The chart's own tooltips have told players for a
     long time that the Orange zone lifts the 60% cap and that Yellow-and-up certificates are exempt from the
     limit -- which implies both rules exist everywhere else, and neither was ever checked. The Buy button's
     conditions were "is it your turn" and "can you afford it".
     RESOLVED BY `App`, because the certificate limit needs the private roster and the room's size and this
     panel is given neither. Asked with the source and quantity SELECTED HERE, since the answer depends on
     both. */
  const purchaseBlock =
    purchaseBlockFor?.(company.company_id, source, multiBuyMax > 1 ? effectiveQuantity : 1) ?? null;

  /* Design note #35: the buy button always prices itself. The label only showed a price while unfloated,
     so the suffix vanished exactly when two sources appeared and a price mattered most.
     IPO costs the corporation's PAR price; the Bank Pool costs the current MARKET price.
     Par comes from `company.par_value` once set -- `parValue` is the ladder SELECTION, a control rather
     than a fact, and only what the first buyer pays. */
  const parPrice = company.par_value != null ? Number(company.par_value) : Number(parValue);
  const unitPrice = source === "Bank" ? marketPrice : parPrice;
  const priceKnown = unitPrice != null && Number.isFinite(unitPrice);

  /* The first purchase is NOT a 10% share: whoever buys into a corporation with no president takes the
     President's Certificate -- 20% at DOUBLE par -- so quoting "@ $67" for a $134 transaction is a wrong
     number discovered after signing. Keyed on `president === null`, a contract field, not on arithmetic.
     Design note #36: the gate is BOTH conditions. Holders-with-no-president cannot occur in a legal
     position, but `sandboxState.ts #6` proved how easily an illegal one slips in, so a malformed state
     degrades to the conservative answer rather than advertising a certificate that cannot exist.
     Design note #587: the real test is "has this been STARTED" -- the Camden & Amboy hands out a
     certificate before anyone founds the company, and `par_value` is the field that says so. */
  const isPresidentPurchase = company.president === null && company.par_value === null;
  const buyLabel = (() => {
    if (!priceKnown) {
      // No market position and no par yet -- nothing honest to quote.
      return isPresidentPurchase ? "Buy President's Certificate (20%)" : "Buy 1 share";
    }
    const price = unitPrice as number;
    if (isPresidentPurchase) {
      return `Buy President's Certificate (20%) @ $${price * 2}`;
    }
    const quantity = multiBuyMax > 1 ? effectiveQuantity : 1;
    if (quantity === 1) return `Buy 1 share @ $${price}`;
    return `Buy ${quantity} shares @ $${price} ($${price * quantity})`;
  })();

  /* Design note #20: SELL SIZE IS LOCAL TOO, and this is what fixes the highlight sticking on 10%.
     A shared `sellPercentage` changed the size on all eight cards -- and on a card where the viewer holds
     nothing every size is disabled, so the click never fires and the highlight never moves, which looks
     like a broken toggle rather than "you have no shares here". */
  const [sellPercentage, setSellPercentage] = useState<number>(SELL_PERCENTAGE_OPTIONS[0]);

  /** Design note #21: only sources that actually hold certificates. */
  const availableSources = ([] as Array<"Ipo" | "Bank">).concat(
    company.ipo_pool_percentage > 0 ? ["Ipo"] : [],
    company.bank_pool_percentage > 0 ? ["Bank"] : [],
  );

  // Keeps the local choice legal as pools drain under it -- otherwise a card
  // left on "Bank" after the pool empties would dispatch against a source
  // that no longer has anything to sell.
  useEffect(() => {
    if (availableSources.length > 0 && !availableSources.includes(source)) {
      setSource(availableSources[0]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [availableSources.join(","), source]);

  // F-6: this player's own stake, which bounds the sell sizes.
  // `player_holdings` OMITS anyone holding exactly 0% (see `gameState.ts`),
  // so an absent entry means zero, not missing data.
  const playerHoldingPercent =
    company.player_holdings.find((holding) => holding.player === connectedAddress)?.percentage ?? 0;
  /* Design note #356: `macroRoundNumber` is 1 for the first Stock Round.
     `undefined` -- a room that does not report it -- permits the sale
     rather than blocking it: the contract refuses an illegal one, and a
     UI that hid Sell on missing data would hide it for the whole game. */
  const sellingForbidden = macroRoundNumber === 1;

  /* Design note #357: a player cannot spend what they do not have. The button gated on turn and session
     readiness, never on price; the sandbox reducer's `adjustCash` floors at zero rather than refusing, so
     a $74 player bought an $82 share and read $0 instead of -$8.
     Gates the TOTAL cost, not the unit price -- a presidency is double par and a Brown multibuy is n
     times the price. `null` cash leaves the gate OFF: a room that does not report a balance is not a room
     where the player is broke. */
  const totalCost = (() => {
    if (!priceKnown) return null;
    const price = unitPrice as number;
    if (isPresidentPurchase) return price * 2;
    return price * (multiBuyMax > 1 ? effectiveQuantity : 1);
  })();
  const cannotAfford =
    playerCash != null && totalCost != null && totalCost > playerCash;
  const bankPoolPercent = company.bank_pool_percentage;
  /* Design note #713: THE SUCCESSOR RULE, WHICH THIS CONTROL NEVER ASKED ABOUT. `sellOptionState` checked
     that the player held enough and that the pool had room, and would sell a presidency into nobody's hands.
     `sellableHoldings` has computed the rule since #6 -- "some OTHER single player already holds enough to
     take the certificate" -- and no sell control consulted it.
     RESOLVED BY `App`, because the rule reads EVERY player's holdings and this card is handed only its own
     company. The local `sellOptionState` still answers first: its two messages are about the bundle the
     player just picked, and they are the ones a player hits most. */
  const localSellState = sellOptionState(sellPercentage, playerHoldingPercent, bankPoolPercent);
  const saleBlock = saleBlockFor?.(company.company_id, sellPercentage) ?? null;
  const selectedSellState: { enabled: boolean; reason?: string } = localSellState.enabled
    ? saleBlock
      ? { enabled: false, reason: saleBlock }
      : localSellState
    : localSellState;

  /* Design note #683: whether a treasury projection is attached beneath each action, hoisted because THREE
     things read it -- the block itself, and the two controls above it that square their bottom corners to meet
     it. Written three times these drift, and the visible failure is a button squared off above nothing, which
     reads as a clipping bug rather than as a missing figure.
     BOTH ARE SILENT WITHOUT A PRICE OR A BALANCE: there is no subtraction to show, and inventing "$0 left" is
     the failure this codebase keeps removing. The sell side is silent in SR1 too -- quoting proceeds beside a
     button banned for the round would price an action nobody can take (#577). */
  const showBuyProjection =
    priceKnown && typeof playerCash === "number" && totalCost !== null;
  const showSellProjection =
    !sellingForbidden &&
    selectedSellState.enabled &&
    typeof playerCash === "number" &&
    // Design note #713: the SALE's price, which is the market's and not the buy toggle's.
    typeof marketPrice === "number";

  /* Design note #417: outside a Stock Round there are no controls -- hidden, not disabled.
     #32 argued a disabled button beats a rejected transaction; the real choice is between a disabled
     button and NO button, and a disabled control claims the action is available here and fixable. The
     roster is a REFERENCE surface for most of the game. `actionsLockedReason` states why once, at the top.
     GUARDED HERE, NOT AT THE CALL SITE: this component holds hooks, so an early return above them would
     change hook order between rounds. Every hook has run by this line; only the render is skipped. */
  if (!tradingOpen) return null;

  return (
    <div style={styles.cardActions}>
      {/* Design note #397: PAR COMES BEFORE THE PRESIDENT'S SHARE. It sat below, sharing a row with the Sell
         selector, because both are the same KIND of control (#22) -- and pairing by control TYPE is what put
         them out of rulebook order. You set a par price and THEN buy the certificate at it, in one motion.
         The sell block loses nothing: par is only offered while `par_value === null`, and a corporation nobody
         has parred has no shares to sell. The two were never on screen together. */}

        {company.par_value === null && (
          <div style={styles.numericRowBlock}>
            <span style={styles.cardActionsLabel}>Par</span>
            <div style={styles.sellSlashRow} role="group" aria-label="Par value">
              {PAR_VALUE_LADDER.map((value, index) => (
                <React.Fragment key={value}>
                  {index > 0 && (
                    <span style={styles.sellSlash} aria-hidden="true">
                      /
                    </span>
                  )}
                  <button
                    type="button"
                    aria-pressed={parValue === value}
                    style={{
                      ...styles.sellSlashOption,
                      ...(parValue === value ? styles.sellSlashOptionActive : {}),
                    }}
                    // Design note #398: says WHICH company's ladder moved.
                    onClick={() => onSelectParValue(company.company_id, value)}
                  >
                    {value}
                  </button>
                </React.Fragment>
              ))}
            </div>
          </div>
        )}

      {/* Buy */}
      <div style={styles.cardActionsBlock}>
        <span style={styles.cardActionsLabel}>Buy share</span>
        {/* Design note #36: BOTH SOURCES, ALWAYS -- disabled, not absent. Three branches (two buttons, or one of
           two plain-text hints) meant a card changed SHAPE as pools drained, which on a grid of eight reads as
           flicker. #21 removed the empty source to avoid a rejected transaction: right about the CLICK, wrong
           about the CONTROL, since a disabled button refuses just as firmly while still saying the pool exists
           and is empty. It also keeps both buttons in place, so the Buy button underneath never moves. */}
        {/* Design note #346: THE SOURCE IS A SWITCH, NOT TWO BUTTONS. #36's argument for keeping an empty source
           visible still holds; what it got wrong was the WEIGHT -- two full-width padded buttons above Buy made
           choosing a source look like three primary actions rather than one action with a setting.
           A segmented switch says the same thing in one row at a third of the height, with the empty option struck
           through and its reason on hover, sitting ON the Buy row so it reads as one sentence.
           THE DEFAULT is handled by the effect below, which re-points `source` at the first stocked pool and runs
           on mount, covering the "one is empty" case at first render. */}
        {/* Design note #683: computed once, because THREE things depend on it -- whether the block renders,
           whether the button squares its bottom corners, and whether the source toggle does. Written three
           times, they drift, and the failure is a button squared off above nothing. */}
        {/* Design note #683: the row and its projection share an edge, so they need a container that does NOT
           space them -- `cardActionsBlock`'s 6px gap is right between the label and the controls and wrong
           between a control and the base attached to it. */}
        <div style={styles.attachedGroup}>
        <div style={styles.buyRow}>
          <div
            style={{
              ...styles.sourceSwitch,
              ...(showBuyProjection ? styles.attachedAbove : {}),
            }}
            role="group"
            aria-label="Share source"
          >
            {(["Ipo", "Bank"] as const).map((option) => {
              const available = option === "Ipo"
                ? company.ipo_pool_percentage > 0
                : company.bank_pool_percentage > 0;
              return (
                <button
                  key={option}
                  type="button"
                  aria-pressed={source === option}
                  /* Design note #681 (sweep): it computed a look for an EMPTY source and none for a
                     disabled one, so off-turn -- or before the session key was ready -- the toggle stayed
                     fully lit while refusing every click. Both reasons grey it now, and `controlsBlockedReason`
                     answers when the source itself is fine and the moment is not. */
                  style={{
                    ...styles.sourceSwitchOption,
                    ...(source === option && available ? styles.sourceSwitchOptionActive : {}),
                    // Inline styles cannot express `:disabled` (Lobby.tsx
                    // design note #3), so the disabled look is computed.
                    ...(available ? {} : styles.sourceSwitchOptionEmpty),
                    ...(controlsDisabled ? styles.actionButtonDisabled : {}),
                  }}
                  disabled={controlsDisabled || !available}
                  title={
                    !available
                      ? option === "Ipo"
                        ? "The IPO Warehouse is empty."
                        : "The Bank Pool is empty."
                      : (controlsBlockedReason ??
                        (option === "Ipo"
                          ? `Buy from the IPO at par. ${company.ipo_pool_percentage}% left.`
                          : `Buy from the Bank Pool at market price. ${company.bank_pool_percentage}% left.`))
                  }
                  onClick={() => setSource(option)}
                >
                  {option === "Ipo" ? "IPO" : "Pool"}
                </button>
              );
            })}
          </div>

          {/* Design note #347: SOLD OUT IS A STATE, NOT A DISABLED BUY. The button was already disabled but still
             read "Buy 1 share @ $67" -- a control describing an action that cannot happen, which a player reads as
             "I cannot afford it" or "it is not my turn".
             Both pools empty means every certificate is in players' hands: a permanent fact about the company for
             the rest of the round, not a temporary block, so it gets its own label and its own neutral grey. */}
          {availableSources.length === 0 ? (
            <button
              type="button"
              style={{
                ...styles.actionButton,
                ...styles.buyButtonFill,
                ...(showBuyProjection ? styles.attachedAbove : {}),
                ...styles.soldOutButton,
              }}
              disabled
              title={`Every ${company.ticker} certificate is held by players — the IPO and the Bank Pool are both empty.`}
            >
              Sold Out
            </button>
          ) : (
            <button
              type="button"
              onClick={() =>
                onBuyShare(company.company_id, source, multiBuyMax > 1 ? effectiveQuantity : 1)
              }
              /* Design note #466: greyed as well as disabled -- `disabled` alone leaves a button at full contrast
                 that silently refuses the click. Inline styles cannot express `:disabled` (`Lobby.tsx #3`). */
              style={{
                ...styles.actionButton,
                ...styles.buyButtonFill,
                ...(showBuyProjection ? styles.attachedAbove : {}),
                ...(controlsDisabled || cannotAfford || purchaseBlock
                  ? styles.actionButtonDisabled
                  : {}),
              }}
              disabled={controlsDisabled || cannotAfford || purchaseBlock !== null}
              /* Design note #681: #466 got the LOOK right here and left the tooltip saying nothing
                 for every reason but affordability. Cost leads because it is the specific one; the
                 shared reason answers the rest.
                 Design note #712: a RULE beats a price. "You cannot afford it" is advice to come back with
                 more cash; "no player may hold more than 60%" is advice to do something else entirely, and a
                 player told only the first would keep saving toward a purchase the rules forbid. */
              title={
                purchaseBlock
                  ? purchaseBlock
                  : cannotAfford
                    ? `Insufficient funds — costs $${totalCost}, you hold $${playerCash}.`
                    : (controlsBlockedReason ?? undefined)
              }
            >
              {/* Design note #35: one computed label, so the price cannot
                  disappear depending on which branch built the string. */}
              {buyLabel}
            </button>
          )}
        </div>

        {/* Design note #682: #577's figure, moved out of the button row and given a shape. Its own reasoning is
           unchanged and still right -- the price is on the button, and this is the thing the button cannot say.
           Silent without a price or a balance: there is no subtraction to show, and inventing "$0 left" is the
           failure this codebase keeps removing. */}
        {showBuyProjection && (
          <TreasuryProjectionBlock
            projection={projectTreasury(playerCash as number, -(totalCost as number))}
            seatColor={actingSeatColor}
            action="purchase"
          />
        )}
        </div>

        {/* Design note #33: the Brown zone's multi-buy. Brown is the only zone where a player may take several
           bank-pool shares in one turn, so the quantity selector appears there and nowhere else. The ceiling is
           the pool itself, and it applies only to the Bank source -- the IPO is not what the Brown rule relaxes.
           HONEST LIMITATION, and it is a contract one: `BuyStock` has no quantity parameter, so buying three
           shares is three transactions fired in sequence, stopping at the first failure. Three log entries is
           accurate -- it really is three purchases. Batching would be a contract change. */}
        {multiBuyMax > 1 && (
          <div style={styles.multiBuyRow}>
            <span style={styles.cardActionsLabel}>Quantity</span>
            {/* Design note #681 (sweep): a `<select>` needs this as much as a button does. A form control
                with an authored background does not take the browser's own disabled rendering, so this was
                the third control in the file passing `disabled` and looking available. */}
            <select
              style={{
                ...styles.multiBuySelect,
                ...(controlsDisabled ? styles.actionButtonDisabled : {}),
              }}
              value={Math.min(buyQuantity, multiBuyMax)}
              onChange={(event) => setBuyQuantity(Number(event.target.value))}
              disabled={controlsDisabled}
              title={controlsBlockedReason ?? undefined}
              aria-label="Number of bank pool shares to buy"
            >
              {Array.from({ length: multiBuyMax }, (_, index) => index + 1).map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            <span style={styles.multiBuyHint}>
              Brown zone — up to {multiBuyMax} from the Bank Pool
            </span>
          </div>
        )}

      </div>

      {/* Design note #466: THE REASON MOVES ONTO THE CONTROL. The button was already disabled; what it lacked
         was the greyed LOOK, so it read as live and refused silently. #357 answered that with a red line
         underneath -- sound, and it treated the symptom by adding a second element to explain the first.
         Greying it removes the premise: a visibly disabled control looks unavailable rather than broken, and the
         red line was costing a row on every card whose owner was short of cash, which is most of them. */}

      {/* Design note #22: par and sell share a line where the card is wide enough -- both are the same KIND of
         control, and `flexWrap` stacks them on a narrow card.
         Design note #29: the par row is gated on `par_value === null`, not `!isFloated`, which was too loose.
         Par is chosen once, by whoever buys the President's share, and from that moment the company HAS a price
         -- so a parred-but-unfloated company (the sandbox B&O) was showing a live ladder for a settled decision. */}
      <div style={styles.numericRowPair}>
        {/* Design note #25: no holding, no Sell -- a control for shares you do not own is an action that cannot
           succeed, and on eight cards where a player typically holds three that is five cards of dead controls.
           Design note #356: NOBODY SELLS IN STOCK ROUND 1. 1830 forbids it -- allowing it would let a player park
           cash in a company and withdraw it before anyone could react.
           HIDDEN, not disabled, and deliberately the opposite call from #36's source buttons: an empty Bank Pool
           is a fact about the BOARD that a buyer wants, while the SR1 ban is a fact about the RULES that cannot
           change this round. A permanently disabled control teaches the player to ignore that region of the card. */}
        {playerHoldingPercent > 0 && !sellingForbidden && (
        <div style={styles.numericRowBlock}>
          <span style={styles.cardActionsLabel}>Sell</span>
        {/* Design note #19: ONE control block, not five buttons. Five bordered chips read as five separate
           decisions and cost a row of vertical space on a card that has to fit eight to a screen. The separators
           are `aria-hidden`, so a screen reader hears five options rather than "10 percent slash 20 percent". */}
        <div style={styles.sellSlashRow} role="group" aria-label="Sell size">
          {SELL_PERCENTAGE_OPTIONS.map((pct, index) => {
            const state = sellOptionState(pct, playerHoldingPercent, bankPoolPercent);
            const active = sellPercentage === pct;
            return (
              <React.Fragment key={pct}>
                {index > 0 && (
                  <span style={styles.sellSlash} aria-hidden="true">
                    /
                  </span>
                )}
                <button
                  type="button"
                  // `title` carries the reason on hover. Native tooltip
                  // rather than a custom one: a disabled button does not
                  // fire pointer events in every browser, so a JS-driven
                  // tooltip is unreliable in exactly the state it is needed.
                  title={state.reason ?? controlsBlockedReason ?? undefined}
                  aria-pressed={active}
                  style={{
                    ...styles.sellSlashOption,
                    ...(active ? styles.sellSlashOptionActive : {}),
                    ...(state.enabled ? {} : styles.sellSlashOptionDisabled),
                    // Design note #681 (sweep): the size buttons had a look for
                    // an illegal SIZE and none for a blocked moment.
                    ...(controlsDisabled ? styles.actionButtonDisabled : {}),
                  }}
                  disabled={controlsDisabled || !state.enabled}
                  onClick={() => setSellPercentage(pct)}
                >
                  {pct}%
                </button>
              </React.Fragment>
            );
          })}
        </div>
        {/* The reason the CURRENT selection cannot be sold, stated inline.
            The per-button tooltip only appears on hover, which a player who
            has already committed to a size will not think to do. */}
        {!selectedSellState.enabled && (
          <span style={styles.sellHint}>{selectedSellState.reason}</span>
        )}
        </div>
        )}
      </div>

      {/* Design note #418: THE SR1 BAN REACHED THE SELECTOR, NOT THE BUTTON. #356 applied `sellingForbidden` to
         the size selector and stopped there, so in SR1 the sizes vanished and a live "Sell 10% Bundle" button
         remained, wired straight to `onSellShares`. The ban was visible and not enforced.
         DISABLED, NOT HIDDEN, and deliberately the opposite of #417 one screen over: the discriminator is
         whether the player can ever act here. Outside a Stock Round the answer is no; in SR1 selling is a real
         action of this panel, barred for one round and legal in every round after, so a disabled button carrying
         the reason teaches a rule the player will need next round.
         THE REASON IS ON THE BUTTON, not only in a tooltip -- the label itself changes. */}
      {/* Design note #679: AND IT HAS TO LOOK BARRED. Reported: "Selling Opens in SR2" is the same colour as the
         Buy buttons beside it, so a rule the panel is trying to teach reads as a control the player simply has
         not pressed yet.
         #418 above got the ENFORCEMENT right and stopped one line short of the appearance -- the button passes
         `disabled` and spread no disabled style, which is the exact failure #466 names two hundred lines down
         ("inline styles cannot express `:disabled`, so every disabled control here computes its own look") and
         #619 found three of in the action bar. The style already existed; the Buy button beside it already used
         it.
         ONE EXPRESSION, TWO USES. The condition is hoisted rather than written twice, because the two copies
         drifting apart -- a button greyed but live, or live but grey -- is a worse bug than either state and is
         how this one arrived. */}
      {/* Design note #683: the sell button's own zero-gap group, same reasoning as the buy row above. */}
      <div style={styles.attachedGroup}>
      {playerHoldingPercent > 0 && (() => {
        const sellDisabled =
          controlsDisabled || sellingForbidden || !selectedSellState.enabled;
        return (
          <button
            type="button"
            style={{
              ...styles.actionButton,
              // Design note #682: the same fill as Buy, so the two sides of the
              // card present one shape.
              ...styles.buyButtonFill,
              ...(showSellProjection ? styles.attachedAbove : {}),
              ...(sellDisabled ? styles.actionButtonDisabled : {}),
            }}
            onClick={() => onSellShares(company.company_id, sellPercentage)}
            disabled={sellDisabled}
            title={
              sellingForbidden
                ? "No selling in the first Stock Round — Project 18XX opens the market to sales from SR2 onward."
                : (controlsBlockedReason ?? undefined)
            }
          >
            {sellingForbidden ? "Selling Opens in SR2" : `Sell ${sellPercentage}% Bundle`}
          </button>
        );
      })()}

      {/* Design note #577, the other direction: a sale RAISES cash, answering the same question. Shown only when
         the sale is genuinely available -- quoting proceeds beside a button banned in SR1 would price an action
         nobody can take.
         Design note #682: the same block as the buy side, so a player reads one shape for both directions and
         the only difference on screen is which way the arrow's colour goes. */}
      {showSellProjection && (
          <TreasuryProjectionBlock
            /* Design note #713: AT THE MARKET PRICE, not `unitPrice`. `unitPrice` follows the IPO/Bank toggle
               above -- a BUY control -- so with the toggle on its default "Ipo" a sale was quoted at the
               corporation's PAR. Par is what the IPO charges; a sale always settles against the chart.
               `saleProceeds` also states rule (i): every certificate in the bundle fetches today's price,
               because the sale settles before the token moves. */
            projection={projectTreasury(
              playerCash as number,
              saleProceeds(marketPrice as number, sellPercentage),
            )}
            seatColor={actingSeatColor}
            action="sale"
          />
      )}

      {/* Design note #713: THE OTHER CONSEQUENCE. Reported: "we have the effect on the player's treasury
          listed, but we don't list the effect on the stock price."
          It is the more interesting of the two. Cash is a figure a player can add up in their head; where
          the token lands is the reason they might not sell at all -- a drop through a zone boundary changes
          what everyone at the table may buy (#712), and a drop off the bottom of a column is how a
          corporation dies.
          THE SAME GRAMMAR AS THE DIVIDEND MOVE LINE (#197): two zone-tinted prices and one arrow. A player
          should read "what this does to the price" as one shape wherever they meet it, and the tint carries
          the zone rule as a tooltip on both ends -- so a sale that drops a corporation INTO the Yellow zone
          says so.
          ONE ROW PER CERTIFICATE, walked by `projectShareSaleMove` through `salePriceAfter`. */}
      {showSellProjection && salePriceAfter && (() => {
        const after = salePriceAfter(company.company_id, certificatesIn(sellPercentage));
        if (after === null || after === marketPrice) return null;
        return (
          <div style={styles.saleMarketMove}>
            <span style={styles.saleMarketLabel}>Share price</span>
            <ZonedPrice price={marketPrice} />
            {/* Design note #713: DOWN, not right. The dividend line's arrow is horizontal because a
                declaration moves the token one column left or right; a sale moves it one row DOWN per
                certificate. Using the same glyph for both would flatten the one difference between them
                that a player has to know. */}
            <span
              style={styles.saleMarketArrow}
              role="img"
              aria-label={`falls to $${after}`}
            >
              &#8595;
            </span>
            <ZonedPrice price={after} />
          </div>
        );
      })()}
      </div>

    </div>
  );
}

// Design note #26 (superseded by #388): this file carried a comparison of two card paradigms behind a
// `USE_FLIP_UI` flag. It was settled -- the flag is deleted rather than left switchable, because a flag
// nobody will flip back is just a second code path to keep working.
// Design note #24/#445: FLOAT IS THE 60% RULE, WITH NO EXCEPTIONS. No auto-float route exists and no
// corporation floats during the Auction Round -- the auction sells PRIVATES. Winning the B&O private
// grants the presidency and prompts a par choice; the B&O then floats on the ordinary 60% condition.
// `auction.rs` setting `is_floated` is a CONTRACT BUG on the audit list, and a frontend that explains a
// bug in the language of a rule is how the bug becomes the rule. The badge still reads `is_floated`, but
// when it disagrees with the 60% math the card reports the DISAGREEMENT and names no cause.

/** Percent of a company's shares actually in player hands. */
function soldToPlayersPercent(company: PublicCompanyState): number {
  return Math.max(0, 100 - company.ipo_pool_percentage - company.bank_pool_percentage);
}

/** Whether this company floated the ORDINARY way -- by reaching the 60%
 *  threshold. `false` plus `is_floated === true` is a CONTRADICTION, not a
 *  second way of floating -- see design note #445. The card reports it as
 *  one rather than attributing it to a rule. */
function metFloatThreshold(company: PublicCompanyState): boolean {
  return soldToPlayersPercent(company) >= FLOAT_THRESHOLD_PERCENT;
}

/** How many PHYSICAL certificates a holding represents -- NOT `percentage / 10`. A President's Share is
 *  a 20% double certificate, so a president on 60% holds five, not six. The certificate LIMIT is per
 *  certificate, so counting six overstates their position by one per presidency.
 *  `isPresident` comes from the contract, never from who holds the most (design note #8). */
export function certificateCount(percentage: number, isPresident: boolean): number {
  return Math.max(0, percentage / 10 - (isPresident ? 1 : 0));
}

/** 8/4 truncation, matching `utils/lobby.ts`'s `truncateAddress` so one
 *  player reads as the same string here as in the lobby seat list. */
function truncateHolder(address: string): string {
  return address.length <= 14 ? address : `${address.slice(0, 8)}...${address.slice(-4)}`;
}

/* Design note #428: the local `TICKER_COLORS` is gone. The table lives in
   `styles/corporationLivery.ts`, so a recolour cannot reach one surface and miss another. */
const tickerColor = corporationLiveryColor;

/* Design note #389 said "one table, not a second palette that looks close",
   and this file was the second palette. It is now literally true. */

/** Standard 1830 par ladder. Exported since design note #399: the B&O prompt offers the same six rungs.
 *  Design note #415: DERIVED from `StockMarketRenderer.PAR_VALUE_LADDER`. A hand-written list left two
 *  ladders -- prices a player may CHOOSE and prices the board has BOXES for -- and the failure when they
 *  differ is silent: `parBoxCellFor` returns `null`, so a seventh rung here would par a company onto no
 *  cell at all. `String` because this feeds a radio group; the coordinates table is numeric. */
export const PAR_VALUE_LADDER: readonly string[] = PAR_BOX_PRICES.map(String);

/** Every sell-bundle size 1830 can express: 10% blocks up to the 50% Bank Pool cap (F-6). It was
 *  `[10, 20, 30, 40]`, which made a legal move unreachable -- a 60% holder could not dump 50%, and a
 *  president executing a legal dump-and-transfer had no control at all.
 *  Illegal entries render greyed WITH a reason: an absent control teaches nothing, a disabled one that
 *  says "would exceed the 50% Bank Pool cap" teaches the rule when it applies. */
const SELL_PERCENTAGE_OPTIONS: readonly number[] = [10, 20, 30, 40, 50];

/** The 1830 Bank Pool cap: no company may have more than 50% of its shares
 *  sitting in the pool at once. Mirrors the backend's own bound. */
const BANK_POOL_CAP_PERCENT = 50;

/** Whether one sell size is legal, and if not, why. TWO independent limits, reported separately because
 *  they call for different actions: HOLDINGS cannot change this turn, while the POOL CAP moves as other
 *  players buy out of the pool -- so a player who knows the reason knows to wait.
 *  Holdings is checked first: a pool-cap message about shares you never had is less useful. */
function sellOptionState(
  percentage: number,
  playerHoldingPercent: number,
  bankPoolPercent: number,
): { enabled: boolean; reason?: string } {
  if (percentage > playerHoldingPercent) {
    return {
      enabled: false,
      reason: `You hold ${playerHoldingPercent}% — not enough for a ${percentage}% bundle`,
    };
  }
  const poolRoom = Math.max(0, BANK_POOL_CAP_PERCENT - bankPoolPercent);
  if (percentage > poolRoom) {
    return {
      enabled: false,
      reason:
        `Bank Pool is at ${bankPoolPercent}% and caps at ${BANK_POOL_CAP_PERCENT}% — ` +
        `only ${poolRoom}% more can be sold into it`,
    };
  }
  return { enabled: true };
}

/* Design note #682: THE CONSEQUENCE, UNDER THE BUTTON THAT CAUSES IT.

   #577 put this figure beside the Buy button as running micro text, and it was
   reported as unclear -- "a plain-looking text string ... having no styling", so
   a reader who did not already know why it was there could not tell what it was
   claiming. The information was right and the rendering said "aside".

   THREE THINGS CHANGED, and each answers a different half of that:
     BELOW, NOT BESIDE. Under the button it reads as the result of pressing it.
     Beside a button that already carries a price, it read as more label.
     THE SEAT'S OWN COLOUR says whose money this is without a caption -- the one
     question a bare pair of figures could not answer, and the reason the report
     asked for it.
     A DIRECTION, in green or amber. Money moving is the point, and an arrow
     alone is a glyph the reader has to interpret.

   IT IS NOT A SECOND PRICE. The button says what the action costs; this says
   what the player is left with. Two figures that look alike would be worse than
   one, which is why the label leads with `Treasury` and the price never appears
   here. */
function TreasuryProjectionBlock({
  projection,
  seatColor,
  action,
}: {
  projection: TreasuryProjection;
  /** The acting seat's colour, or `null` when it is not known -- the block then
   *  falls back to the card's own ink rather than inventing a seat. */
  seatColor: string | null;
  /** "purchase" or "sale", for the sentence a tooltip and a screen reader get. */
  action: string;
}) {
  const tint =
    projection.direction === "short"
      ? styles.projectionShort
      : projection.direction === "up"
        ? styles.projectionUp
        : styles.projectionDown;
  return (
    <div
      style={{
        ...styles.projectionBlock,
        ...(seatColor ? { borderTopColor: seatColor } : {}),
      }}
      title={describeTreasuryProjection(projection, action)}
    >
      <span
        style={{
          ...styles.projectionLabel,
          ...(seatColor ? { color: seatColor } : {}),
        }}
      >
        Treasury
      </span>
      <span style={styles.projectionFigures}>
        <span style={styles.projectionBefore}>${projection.before}</span>
        {/* The arrow takes the direction's colour with the figure it points at,
            so the pair reads as one movement rather than as a symbol and a
            number that happen to be adjacent. */}
        <span style={{ ...styles.projectionArrow, ...tint }} aria-hidden="true">
          →
        </span>
        <span style={{ ...styles.projectionAfter, ...tint }}>${projection.after}</span>
      </span>
      {projection.short !== null && (
        <span style={styles.projectionShortNote}>${projection.short} short</span>
      )}
    </div>
  );
}

const FLOAT_THRESHOLD_PERCENT = 60;

export function StockRoundPanel({
  publicCompanies,
  privateCompanies,
  parValueFor,
  onSelectParValue,
  onBuyShare,
  onSellShares,
  sessionReady,
  isMyTurn,
  hotseat = false,
  activePlayerLabel = null,
  actingSeatColor = null,
  connectedAddress,
  macroRoundNumber,
  playerCash,
  marketPrices,
  playerLabel,
  phase,
  outlook,
  actionsLockedReason,
  roundType,
}: StockRoundPanelProps) {
  /* Design note #32: out of phase counts as "controls disabled" exactly the
     same way an unready session does -- one flag, so no control can be
     wired to one condition and miss the other.

     Design note #681: AND SO DOES SOMEBODY ELSE'S TURN.

     REPORTED, after the SR1 sell button: "let's grey out the buttons when it
     isn't a player's turn so that there is no confusion about what they can be
     doing." The panel already RECEIVED `isMyTurn` -- it had since #34 -- and
     spent it on one header hint. Nothing else read it, so on another seat's turn
     every Buy and Sell button looked and felt completely live, and the refusal
     arrived from `App`'s dispatcher after the click as "It is not your turn."
     The turn gate was real and enforced and entirely invisible until you hit it.
     THE FLAG IS WHY THIS IS ONE LINE. #32's whole argument is that a second
     condition wired control-by-control will miss one; adding the third to the
     flag reaches all five at once and cannot miss.
     THE CARDS ARE NOT GATED, deliberately. `controlsDisabled` feeds action
     controls only -- the roster stays fully readable, and expanding a card to
     study a rival's holdings on their turn is exactly when a player has time to
     do it. Browsing is not acting. */
  const controlsDisabled = !sessionReady || actionsLockedReason != null || !isMyTurn;

  /* Design note #681: WHY, in one sentence, for whichever control is asked.
     A greyed button that cannot say why is the failure #619 describes from the
     other side -- it looks broken rather than barred. Ordered by precedence, so
     the answer is the first thing that would stop the click rather than the
     last one checked. */
  const controlsBlockedReason: string | null = !sessionReady
    ? "Initialize the session key to act."
    : (actionsLockedReason ??
      (!isMyTurn
        ? `It is ${activePlayerLabel ?? "another player"}'s turn.`
        : null));
  /* Design note #396: the ACTIVE card -- the one whose action bar renders.
     Renamed from `expandedCompanyId`: it no longer expands anything, it
     decides where the controls live. */
  const [activeCompanyId, setActiveCompanyId] = useState<number | null>(null);
  /* Design note #395: a separate cursor for the private rules text, so
     reading what the D&H does never moves the action bar off the card the
     player was working on. */
  const [expandedPrivateId, setExpandedPrivateId] = useState<number | null>(null);

  /* Design note #348: a flipped card belongs to whoever flipped it. `expandedCompanyId` survived the
     re-render where the turn moved, so in hotseat Bob found Alice's card open on her holdings.
     Keyed on the TURN, not on a purchase -- a player can flip, read and pass without buying, and the turn
     moving is the moment the surface stops belonging to one person. Keyed on the label, which is what
     this component is given and is already resolved per seat. */
  useEffect(() => {
    setActiveCompanyId(null);
    // Design note #395: the private text closes with the turn too. It is
    // reference material for the player who opened it, not a view the next
    // seat inherits.
    setExpandedPrivateId(null);
  }, [activePlayerLabel]);

  /* Design note #10: ACTIONS LIVE IN THE CARD. The global panel was five sections keyed to a pill
     selector, so eight cards showed the position while a separate stack acted on one of them. Expansion
     is now the selection and the pill row is gone.
     ACCORDION HERE, FLAT IN THE AUCTION, deliberately: an auction card has one legal action and six cards
     to compare (dashboard #17), a corporation card has ~twenty controls and there are eight of them.
     The rule is about content volume, not house style. */
  return (
    <div style={styles.root}>
      <div style={styles.headerRow}>
        <span style={styles.headerTitle}>Stock Round</span>
        {/* Design note #34: name the seat rather than address an absent
            "you". Online the wallet check still decides; in hotseat the
            question is only ever which seat is up. */}
        {hotseat
          ? activePlayerLabel !== null && (
              <span style={styles.headerActive}>
                <span style={styles.headerActiveLabel}>Now acting</span>
                <span style={styles.headerActiveName}>{activePlayerLabel}</span>
              </span>
            )
          : !isMyTurn && <span style={styles.headerHint}>Waiting for your turn...</span>}
      </div>

      {/* ---- Corporation roster + per-card actions (design notes #8/#10) */}
      {actionsLockedReason && (
        <span style={styles.readOnlyNotice}>{actionsLockedReason}</span>
      )}

      <CorporationRoster
        publicCompanies={publicCompanies}
        phase={phase}
        outlook={outlook}
        marketPrices={marketPrices}
        // Design note #464: the round drives the card-order boundary.
        roundType={roundType}
        connectedAddress={connectedAddress}
        macroRoundNumber={macroRoundNumber}
        playerCash={playerCash}
        playerLabel={playerLabel}
        privateCompanies={privateCompanies}
        activeCompanyId={activeCompanyId}
        onActivateCompany={setActiveCompanyId}
        expandedPrivateId={expandedPrivateId}
        setExpandedPrivateId={setExpandedPrivateId}
        parValueFor={parValueFor}
        onSelectParValue={onSelectParValue}
        onBuyShare={onBuyShare}
        onSellShares={onSellShares}
        controlsDisabled={controlsDisabled}
        controlsBlockedReason={controlsBlockedReason}
        actingSeatColor={actingSeatColor}
        /* Design note #417: shares trade in a Stock Round and nowhere else. Derived from
           `actionsLockedReason` -- the sentence rendered directly above -- so the notice and the controls answer
           to one condition rather than two that can disagree. */
        tradingOpen={actionsLockedReason == null}
      />

      {/* Design note #13: the Pass button lives in the global action bar (`App.tsx #30`). Pass and Undo are
         turn-level actions available in every phase, and a second copy here would put two Pass buttons on
         screen -- one of which a player would learn to ignore. */}
    </div>
  );
}

export default StockRoundPanel;

/* Design note #507: ONE WIDTH, WRITTEN TWICE, UPDATED ONCE. The numeric column was encoded in the grid
   tracks (46px) and in the cell's `minWidth` (68px). #466 widened the second -- correctly, "9 (100%)"
   was wrapping -- and a grid item cannot shrink below its `min-width` while a track does not clip, so
   each cell spilled 22px and the Price column ended up 44px off the card.
   Neither site looked wrong alone; they were only wrong together. Both now read one constant, so "the
   track is at least as wide as its content" is true by construction. The space comes from the entity
   column, the only track that can give and one that already ellipsises. */
const OWNERSHIP_NUM_WIDTH = "68px";
const OWNERSHIP_GRID = `minmax(0, 1fr) ${OWNERSHIP_NUM_WIDTH} ${OWNERSHIP_NUM_WIDTH}`;

const styles: Record<string, React.CSSProperties> = {
  /* Design note #8: the corporation roster.
     Design note #11: responsive without a media query -- `auto-fit` plus a 300px floor gives the same
     ladder a `grid-cols-1 md:grid-cols-2 xl:grid-cols-4` chain expresses, but driven by the space
     actually available. These cards sit inside a padded pane, so a viewport breakpoint would switch a
     column too early. (Inline styles cannot host `@media` at all -- `Lobby.tsx #3`.) */
  rosterGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))",
    gap: "12px",
    // Design note #23: `start`, NOT `stretch`. With the accordion back, one open card stretched all seven
    // collapsed ones to its height, leaving dead space INSIDE each card that looked clickable-but-dead.
    // Cards now hug their content.
    alignItems: "start",
  },
  rosterEmpty: { fontSize: FONT_SIZE.small, color: "#6f7480" },
  /** An unfloated corporation: nothing to trade yet, so dimmer paper. */
  rosterCardUnfloated: { backgroundColor: CARD_SURFACE_MUTED },
  /** The header block, which is the accordion toggle -- design note #23: `width: 100%` plus the card's own
   *  padding puts every pixel of the collapsed body inside the button. */
  rosterCardToggle: {
    display: "flex",
    flexDirection: "column",
    gap: "8px",
    padding: 0,
    margin: 0,
    border: "none",
    background: "transparent",
    font: "inherit",
    color: "inherit",
    textAlign: "left",
    cursor: "pointer",
    width: "100%",
    // Fills whatever height the card has, so there is never a dead strip
    // below the content inside a collapsed card.
    flex: "1 1 auto",
  },
  /* ---- Per-company action drawer (design note #10) ---- */
  cardActions: {
    display: "flex",
    flexDirection: "column",
    gap: "14px",
    // Design note #15: pushes the whole action block to the bottom of the
    // card, so the Buy and Sell controls land on the same line across every
    // card regardless of how many shareholders sit above them.
    marginTop: "auto",
    paddingBottom: "2px",
    paddingTop: "12px",
    borderTopWidth: "1px",
    borderTopStyle: "solid",
    borderTopColor: CARD_DIVIDER,
  },
  cardActionsBlock: { display: "flex", flexDirection: "column", gap: "6px" },
  /* Design note #683: a control and the projection attached beneath it. Zero gap is the whole job -- the
     seat-coloured seam only reads as one object if there is no paper showing between the two. */
  attachedGroup: { display: "flex", flexDirection: "column", gap: 0 },
  cardActionsLabel: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    fontSize: FONT_SIZE.micro,
    fontWeight: 800,
    letterSpacing: "0.5px",
    textTransform: "uppercase",
    color: CARD_INK_FAINT,
  },
  /* ---- Pass row (design note #10: the one global action) ---- */
  passRow: {
    display: "flex",
    alignItems: "center",
    gap: "14px",
    flexWrap: "wrap",
  },
  passHint: { fontSize: FONT_SIZE.small, color: "#6f7480" },
  /* Design note #9: paper cards, matching the auction's private-company treatment (dashboard #15). A dark
     card on a dark panel is a rectangle you have to hunt for, and these eight are what the round is about.
     Every child colour is re-derived for dark-on-light; the president row needed a real rework. */
  rosterCard: {
    display: "flex",
    flexDirection: "column",
    gap: "8px",
    padding: "12px 14px",
    // Design note #23: no forced height. Content decides.
    boxSizing: "border-box",
    backgroundColor: CARD_SURFACE,
    borderWidth: "2px",
    borderStyle: "solid",
    borderRadius: "10px",
    // Design note #389: the livery stripe bleeds to the card's edges, so
    // the card clips it back inside the corner radius.
    overflow: "hidden",
    cursor: "pointer",
    textAlign: "left",
    font: "inherit",
    color: CARD_INK,
    boxShadow: "0 3px 12px rgba(0,0,0,0.4)",
  },
  rosterCardHeader: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" },
  /* Design note #389: the corporate livery stripe. Negative margins cancel the card's padding exactly so
     it reads as a painted band rather than a coloured box inside one; `overflow: hidden` on the card keeps
     the square stripe corners inside the radius. */
  rosterLivery: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "8px",
    margin: "-12px -14px 0",
    padding: "9px 14px",
    minWidth: 0,
  },
  rosterLiveryTicker: {
    fontSize: FONT_SIZE.heading,
    fontWeight: 800,
    letterSpacing: "0.5px",
    // Inherits the computed ink; stated so nothing downstream re-tints it.
    color: "inherit",
  },
  /* Design note #465: the readable handle, beside the herald. Monospace
     and tracked out so it reads as a TICKER rather than as the first word
     of the full name that follows it. */
  rosterLiveryAcronym: {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: FONT_SIZE.strong,
    fontWeight: 800,
    letterSpacing: "0.04em",
    whiteSpace: "nowrap",
    flexShrink: 0,
  },
  rosterLiveryName: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 600,
    letterSpacing: "0.01em",
    color: "inherit",
    // Design note #22's uniform card width still governs: a long name
    // ellipsises rather than widening the card.
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    opacity: 0.85,
  },
  /** Design note #392: the right-hand cluster in the stripe -- payout then
   *  float status. Grouped so the pair stays together when a long
   *  corporate name pushes on them. */
  rosterLiveryRight: {
    display: "flex",
    alignItems: "center",
    gap: "7px",
    flexShrink: 0,
  },
  rosterLiveryPayout: {
    fontSize: FONT_SIZE.strong,
    fontWeight: 800,
    fontVariantNumeric: "tabular-nums",
    letterSpacing: "0.01em",
  },
  /* ---- Design note #393: the one-line asset row ----
     A single flex line directly under the stripe. `tabular-nums` on the
     values so the figures line up down a column of eight cards, which is
     most of what makes a dense grid scannable. */
  assetRow: {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    flexWrap: "wrap",
    fontSize: FONT_SIZE.micro,
    color: CARD_INK,
    lineHeight: 1.35,
  },
  /* Design note #504: a COLUMN, value over caption -- `rosterPrice`'s exact shape, so both rows of the
     card caption their values the same way round. `alignItems: flex-start` because the chips are wider
     than their captions and centring would float each word under the middle of its chip row. */
  assetItem: {
    display: "inline-flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: "3px",
    /* Design note #490: `cursor: "help"` is gone. It advertised a tooltip
       that carried the caption, and the caption is now on the card. A help
       cursor over content that explains itself is a promise of more. */
  },
  /* Design note #490: the word that replaced the pictogram. Set to match
     `rosterPriceLabel` -- uppercase, faint, letter-spaced -- so the two
     rows of the card caption their values the same way instead of one using
     typography and the other using pictures. */
  assetLabel: {
    fontSize: FONT_SIZE.micro,
    color: CARD_INK_FAINT,
    textTransform: "uppercase",
    letterSpacing: "0.4px",
    fontWeight: 700,
  },
  /* "none", where a value would be. Italic and muted so an empty holding
     reads as an answer rather than as a component that failed to render. */
  assetEmpty: {
    fontSize: FONT_SIZE.micro,
    color: CARD_INK_MUTED,
    fontStyle: "italic",
  },
  assetValue: {
    fontWeight: 700,
    fontVariantNumeric: "tabular-nums",
  },
  assetDivider: {
    color: CARD_DIVIDER,
    fontWeight: 400,
  },
  /* ---- Design note #395: corporate-owned private rows ---- */
  privateRowGroup: {
    display: "flex",
    flexDirection: "column",
  },
  privateRow: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: "8px",
    width: "100%",
    padding: "2px 4px",
    margin: 0,
    border: "none",
    borderRadius: "4px",
    background: "transparent",
    font: "inherit",
    fontSize: FONT_SIZE.micro,
    color: CARD_INK,
    textAlign: "left",
    cursor: "pointer",
  },
  /** Collapsed: one line, clipped. The card is a fixed width (design note
   *  #22) and "Champlain & St. Lawrence" is longer than it. */
  privateName: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    minWidth: 0,
  },
  /** Expanded: the same text, allowed to wrap to its full length. */
  privateNameOpen: {
    whiteSpace: "normal",
    fontWeight: 700,
    minWidth: 0,
  },
  privateRevenue: {
    flexShrink: 0,
    fontWeight: 700,
    color: "#1d7a45",
    fontVariantNumeric: "tabular-nums",
  },
  privateRules: {
    margin: "1px 4px 5px",
    fontSize: FONT_SIZE.micro,
    lineHeight: 1.45,
    color: CARD_INK_MUTED,
  },
  /** Design note #396: the active card carries the controls, so it is
   *  lifted off the grid rather than merely outlined. */
  rosterCardActive: {
    boxShadow: "0 0 0 1px rgba(77,142,224,0.35), 0 6px 18px rgba(0,0,0,0.28)",
  },
  /** Float status inside the stripe. Outlined in the stripe's own ink
   *  rather than filled, so it reads as a badge without introducing a
   *  third colour onto a band that is already carrying two. */
  rosterLiveryBadge: {
    flexShrink: 0,
    display: "inline-flex",
    alignItems: "baseline",
    gap: "5px",
    fontSize: FONT_SIZE.micro,
    fontWeight: 800,
    letterSpacing: "0.04em",
    padding: "2px 7px",
    borderRadius: "999px",
    borderWidth: "1px",
    borderStyle: "solid",
    fontVariantNumeric: "tabular-nums",
  },
  /* Design note #503: the caption inside the badge, answering #488's "captioned by position means
     captioned by nothing". `color: "inherit"` with alpha rather than a fixed grey -- this badge sits on
     eight different corporate fills and takes its ink from the stripe (see `ContextualActionBar #236`). */
  rosterLiveryBadgeCaption: {
    fontWeight: 600,
    letterSpacing: "0.02em",
    textTransform: "uppercase",
    color: "inherit",
    opacity: 0.75,
  },
  /* Design note #490: the crown's replacement -- a tag rather than running text, so it is skimmable.
     Design note #552: this now sizes a drawing, so the type properties went with the text; `color` stays
     and is load-bearing, since the crown fills with `currentColor`.
     Design note #577: the balance after the purchase, in tabular figures so the two numbers line up either
     side of the arrow rather than jittering as the quantity selector moves.
     Design note #682: `cashAfter`/`cashAfterShort` are GONE with the inline string they drew. An orphaned style
     for a rendering somebody has just asked us to stop using is how it comes back -- the rule `palette.ts`
     records for its deleted colour token, and this file's own #466 for `cannotAffordNote`. */
  /* Design note #682: the projection block. A BORDER carries the seat colour rather than a fill: these cards
     are warm near-white paper (`palette.ts`), and a saturated seat colour behind text would need its own
     contrast rule across eight hues -- which is what `bestContrastTextColor` exists for, and is far more
     machinery than a two-figure row deserves. A 3px edge is legible at every hue against paper and needs none.

     Design note #683: ATTACHED, NOT ADJACENT. #682 rendered this as its own box with a 6px gap above it, and
     it was reported as still not reading like part of the button that causes it -- "I thought the button itself
     could be vertically expanded to have a player color segment".
     THE SEAT COLOUR MOVED TO THE TOP EDGE, which is the whole trick: flush against the control above, a 3px
     seat-coloured bar reads as the SEAM of one taller object rather than as the frame of a second one. The
     bottom corners are rounded and the top ones square, so the block finishes the shape the button started.

     WHY NOT INSIDE THE BUTTON, which is what was actually asked for: a disabled control must grey out (#681,
     and #619 before it), and greying this would dim a figure that is still true -- including in the
     insufficient-funds case, where it is the figure EXPLAINING the refusal. A readout inside a control also
     makes part of a click target inert. Attached gets the single-object reading; separate keeps the number
     legible when the button is not. */
  projectionBlock: {
    display: "flex",
    alignItems: "baseline",
    flexWrap: "wrap",
    gap: "8px",
    padding: "6px 10px",
    backgroundColor: "rgba(0, 0, 0, 0.05)",
    borderTop: "3px solid",
    borderTopColor: CARD_INK_MUTED,
    borderRadius: "0 0 8px 8px",
  },
  projectionLabel: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.06em",
    color: CARD_INK_MUTED,
  },
  /* Tabular figures so the pair does not jitter as the quantity selector moves
     -- #577's own observation, and the part of it that needed no change. */
  projectionFigures: {
    display: "inline-flex",
    alignItems: "baseline",
    gap: "5px",
    fontVariantNumeric: "tabular-nums",
    whiteSpace: "nowrap",
  },
  projectionBefore: { fontSize: FONT_SIZE.small, fontWeight: 700, color: CARD_INK_MUTED },
  projectionArrow: { fontSize: FONT_SIZE.small, fontWeight: 700 },
  projectionAfter: { fontSize: FONT_SIZE.body, fontWeight: 800 },
  /* Design note #682: green up, amber down, red only for a genuine block. `cashDelta.ts` #670 settled the
     amber -- red in this app marks a contested auction and an error toast, and money leaving a player's hand
     to buy a share is neither. Spending is ordinary and reads as ordinary, which also keeps red meaning "you
     cannot do this", as it already did on this card. */
  projectionUp: { color: "#2f7d52" },
  projectionDown: { color: "#8a6a1f" },
  projectionShort: { color: "#a4442f" },
  projectionShortNote: { fontSize: FONT_SIZE.micro, fontWeight: 700, color: "#a4442f" },
  presidentTag: {
    color: CARD_HIGHLIGHT_BORDER,
    marginRight: "5px",
    flexShrink: 0,
  },
  rosterTicker: { fontSize: FONT_SIZE.heading, fontWeight: 800, letterSpacing: "0.5px" },
  rosterNameStack: { display: "flex", flexDirection: "column", gap: "1px", minWidth: 0 },
  /* Design note #501: the herald and the acronym, side by side -- a ROW inside the column stack so the
     full name keeps its own line. `minWidth: 0` because a flex item otherwise refuses to shrink below its
     content and a long acronym would push the name's ellipsis out of the card. */
  rosterIdentityRow: {
    display: "flex",
    flexDirection: "row",
    alignItems: "center",
    gap: "7px",
    minWidth: 0,
  },
  rosterFullName: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 600,
    color: CARD_INK_MUTED,
    letterSpacing: "0.01em",
    // Long names (New York, New Haven & Hartford) must not widen the card
    // -- every roster card is one uniform size by design note #22.
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  rosterFloatedBadge: {
    fontSize: FONT_SIZE.micro, fontWeight: 700, padding: "2px 8px", borderRadius: "999px",
    backgroundColor: "#d9f0e1", color: "#14522f",
  },
  rosterUnfloatedBadge: {
    fontSize: FONT_SIZE.micro, fontWeight: 700, padding: "2px 8px", borderRadius: "999px",
    backgroundColor: CARD_HIGHLIGHT_BG, color: "#6b4e05",
  },
  // Design note #32: says WHY the controls are dead. A grid of greyed-out
  // buttons with no explanation reads as a broken panel.
  // Design note #36: an empty pool's button stays put and stops responding.
  multiBuyRow: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" },
  multiBuySelect: {
    fontSize: FONT_SIZE.small,
    fontWeight: 700,
    padding: "3px 8px",
    borderRadius: "6px",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: CARD_DIVIDER,
    backgroundColor: CARD_SURFACE_MUTED,
    color: CARD_INK,
  },
  multiBuyHint: { fontSize: FONT_SIZE.micro, color: CARD_INK_FAINT },
  readOnlyNotice: {
    fontSize: FONT_SIZE.small,
    color: "#c9a94c",
    fontWeight: 600,
  },
  rosterPriceRow: { display: "flex", gap: "18px", alignItems: "flex-end" },
  /* Design note #31: the front-face operating snapshot. A bordered strip rather than three loose pairs, so
     it reads as one block distinct from the prices above and the holdings below. `flexWrap` because a
     corporation at its Phase 2 limit can hold four chips. */
  rosterPrice: { display: "flex", flexDirection: "column", gap: "1px" },
  /* Design note #489: flush right via `marginLeft: auto`, not `space-between` -- the row's other three
     cells must stay grouped as a sequence, or treasury looks like the fourth in a series instead of the
     balance it is. `alignItems: flex-end` ends the figure flush with the card edge. */
  rosterTreasury: { marginLeft: "auto", alignItems: "flex-end", textAlign: "right" },
  rosterPriceValue: {
    fontSize: FONT_SIZE.heading, fontWeight: 800, color: CARD_INK,
    fontVariantNumeric: "tabular-nums", lineHeight: 1.1,
  },
  rosterPriceValueMuted: {
    fontSize: FONT_SIZE.strong, fontWeight: 700, color: CARD_INK_MUTED,
    fontVariantNumeric: "tabular-nums", lineHeight: 1.1,
  },
  rosterPriceLabel: {
    fontSize: FONT_SIZE.micro, color: CARD_INK_FAINT,
    textTransform: "uppercase", letterSpacing: "0.4px",
  },
  /* Design note #378: the ownership table is a GRID, not a flex row per line. `space-between` let the gap
     vary with the name's length, so a column of percentages did not line up -- the one thing a table of
     numbers exists to do. `rosterHoldings` went with the list it styled. */
  ownershipTable: {
    display: "flex", flexDirection: "column", gap: "1px",
    borderTopWidth: "1px", borderTopStyle: "solid", borderTopColor: CARD_DIVIDER,
    paddingTop: "7px",
  },
  ownershipRow: {
    display: "grid",
    gridTemplateColumns: OWNERSHIP_GRID,
    alignItems: "baseline",
    gap: "6px",
    fontSize: FONT_SIZE.small,
    color: CARD_INK,
    padding: "2px 4px",
    borderRadius: "4px",
  },
  ownershipHeadRow: {
    display: "grid",
    gridTemplateColumns: OWNERSHIP_GRID,
    alignItems: "baseline",
    gap: "6px",
    padding: "0 4px 2px",
    fontSize: FONT_SIZE.micro,
    fontWeight: 700,
    letterSpacing: "0.05em",
    textTransform: "uppercase",
    color: CARD_INK_FAINT,
  },
  ownershipName: {
    display: "inline-flex", alignItems: "center", gap: "5px",
    minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
  },
  /* Design note #466: wide enough for the longest value it can hold -- "9 (100%)", a full IPO, which
     wrapped because the column was sized by content. `whiteSpace: nowrap` alone would have overflowed. */
  ownershipNum: {
    textAlign: "right",
    fontVariantNumeric: "tabular-nums",
    flex: "0 0 auto",
    minWidth: OWNERSHIP_NUM_WIDTH,
    whiteSpace: "nowrap",
  },
  /* Design note #378: the line between shares nobody owns and shares
     somebody does. Reset from the browser default, which is an inset 3D
     bevel that reads as a separator between SECTIONS rather than as a rule
     inside a table. */
  ownershipRule: {
    height: 0,
    margin: "3px 0",
    border: "none",
    borderTop: `1px solid ${CARD_DIVIDER}`,
  },
  rosterNoHoldings: { fontSize: FONT_SIZE.small, color: CARD_INK_FAINT, fontStyle: "italic" },
  // Design note #8: gold + bold, the second of the president's markers.
  // Design note #421: the amber row is the VIEWER's. Renamed rather than repointed -- the old name
  // described the thing it was wrong about, and a later reader would put it back on the crown.
  rosterHoldingRowSelf: {
    backgroundColor: CARD_HIGHLIGHT_BG,
    color: CARD_HIGHLIGHT_INK,
    fontWeight: 800,
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: CARD_HIGHLIGHT_BORDER,
  },
  rosterHoldingName: {
    display: "inline-flex", alignItems: "center", gap: "5px",
    minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
  },
  /* `rosterYouTag` DELETED by design note #421. The row fill says "yours"
     now; a pill saying it again beside the name is the duplication that
     note removed from the president. Deleted rather than left unused --
     an orphaned style is an invitation to render it again. */
  rosterHoldingPercent: { flexShrink: 0, fontVariantNumeric: "tabular-nums" },
  /** Design note #28: the call to action on an unparred company. */
  setParPrompt: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 700,
    color: CARD_HIGHLIGHT_INK,
    backgroundColor: CARD_HIGHLIGHT_BG,
    borderRadius: "4px",
    padding: "3px 7px",
    alignSelf: "flex-start",
  },
  /** Design note #24: the contract-state-vs-math disagreement note. */
  /* Design note #445: renamed from `autoFloatNote`. It no longer marks a
     float route; it marks a flag that disagrees with the share counts. */
  floatMismatchNote: {
    fontSize: FONT_SIZE.micro,
    fontStyle: "italic",
    color: CARD_INK_FAINT,
  },
  rosterPoolRow: {
    display: "flex", justifyContent: "space-between",
    fontSize: FONT_SIZE.micro, color: CARD_INK_FAINT,
  },

  root: {
    display: "flex",
    flexDirection: "column",
    gap: "12px",
    width: "100%",
    padding: "14px 20px",
    backgroundColor: "#171b26",
    border: "1px solid #2a2e3a",
    borderRadius: "10px",
    boxSizing: "border-box",
  },
  headerRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
  },
  headerTitle: {
    fontSize: FONT_SIZE.strong,
    fontWeight: 700,
    color: "#e6e8ef",
  },
  /* Design note #34: the active seat, stated positively. Green because it
     is an invitation to act, not a warning -- `headerHint` below is the
     grey "wait" treatment it replaces in hotseat. */
  headerActive: { display: "inline-flex", alignItems: "center", gap: "6px" },
  headerActiveLabel: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.06em",
    color: "#8a919e",
  },
  headerActiveName: {
    fontSize: FONT_SIZE.strong,
    fontWeight: 800,
    color: "#7ee0a1",
  },
  headerHint: {
    fontSize: FONT_SIZE.small,
    color: "#9aa0ac",
  },
  section: {
    display: "flex",
    flexDirection: "column",
    gap: "6px",
    flex: 1,
  },
  sectionInactive: {
    opacity: 0.55,
  },
  sectionLabel: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    fontSize: FONT_SIZE.small,
    fontWeight: 700,
    color: "#9aa0ac",
    textTransform: "uppercase",
    letterSpacing: "0.03em",
  },
  companyPillRow: {
    display: "flex",
    flexWrap: "wrap",
    gap: "6px",
  },
  companyPill: {
    display: "inline-flex",
    alignItems: "center",
    gap: "4px",
    fontSize: FONT_SIZE.body,
    fontWeight: 700,
    padding: "6px 12px",
    borderRadius: "999px",
    border: "1.5px solid",
    backgroundColor: "transparent",
    cursor: "pointer",
  },
  floatedDot: {
    display: "inline-block",
    width: "6px",
    height: "6px",
    borderRadius: "50%",
    backgroundColor: "currentColor",
  },
  emptyHint: {
    fontSize: FONT_SIZE.body,
    color: "#6f7480",
  },
  floatBadge: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 700,
    padding: "2px 8px",
    borderRadius: "999px",
    backgroundColor: "#2a2e3a",
    color: "#9aa0ac",
  },
  floatBadgeActive: {
    backgroundColor: "#1d4a34",
    color: "#6fdc9b",
  },
  /** Wrapper for the collapsed-body float bar -- design note #17. */
  controlsRow: {
    display: "flex",
    gap: "18px",
    flexWrap: "wrap",
  },
  parGrid: {
    display: "flex",
    flexWrap: "wrap",
    gap: "6px",
  },
  parCell: {
    fontSize: FONT_SIZE.body,
    fontWeight: 600,
    padding: "6px 10px",
    borderRadius: "6px",
    border: "1px solid #3a3f4b",
    backgroundColor: "#1e2129",
    color: "#c7cbd4",
    cursor: "pointer",
  },
  parCellActive: {
    backgroundColor: "#2a3a52",
    borderColor: "#4a6a92",
    color: "#e6e8ef",
  },
  /* Design note #346: Buy and its source on one row. The switch does not
     grow; the Buy button takes the rest, so the price stays readable at
     every card width. */
  buyRow: { display: "flex", alignItems: "stretch", gap: "8px" },
  /* Design note #682: the Buy button takes the width the figure beside it used to occupy. With the projection
     moved below, the row holds a source toggle and a button -- and a button stopping short of the card edge
     leaves a ragged gap exactly where a number used to be, which reads as something failing to render. */
  buyButtonFill: { flex: "1 1 auto", textAlign: "center" },
  /* Design note #683: squares the bottom corners of a control that has the projection block attached beneath
     it, so the two share an edge instead of leaving paper visible in the corner notches. Applied only when a
     projection is actually rendering -- a squared-off button with nothing under it looks like a clipping bug. */
  attachedAbove: { borderBottomLeftRadius: 0, borderBottomRightRadius: 0 },
  sourceSwitch: {
    display: "flex",
    flexShrink: 0,
    borderRadius: "7px",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "#3a3f4b",
    overflow: "hidden",
  },
  sourceSwitchOption: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 700,
    padding: "0 9px",
    border: "none",
    backgroundColor: "#1e2129",
    color: "#8a919e",
    fontFamily: "inherit",
    cursor: "pointer",
  },
  sourceSwitchOptionActive: {
    backgroundColor: "#2a3a52",
    color: "#e6e8ef",
  },
  /* Struck through rather than merely faded: an empty pool is not "not
     chosen", it is "nothing here to buy", and the two look identical at
     40% opacity. */
  sourceSwitchOptionEmpty: {
    opacity: 0.45,
    cursor: "not-allowed",
    textDecoration: "line-through",
  },
  /* Design note #347: neutral grey, deliberately NOT the primary button desaturated -- this is a state of
     the company, not a control waiting to become available.
     Design note #466: the greyed treatment for a refused Buy. Inline styles cannot express `:disabled`
     (`Lobby.tsx #3`), so every disabled control here computes its own look. */
  actionButtonDisabled: {
    opacity: 0.45,
    cursor: "not-allowed",
  },
  /* `cannotAffordNote` deleted by design note #466 -- it explained a Buy button that looked enabled, and
     the button is greyed now. An orphaned refusal style is an invitation to render a second one. */
  soldOutButton: {
    backgroundColor: "#20242e",
    borderColor: "#343b48",
    color: "#7f8798",
    cursor: "not-allowed",
  },
  /* Design note #19: the slashed sell row, superseding the five-chip stepper -- as a non-wrapping flex row
     the 50% chip rendered outside the card border entirely, since flex does not shrink past content and
     nothing clipped it. A row of text-weight options wraps as text instead.
     Design note #22: paired numeric rows. */
  numericRowPair: { display: "flex", flexWrap: "wrap", gap: "10px", alignItems: "flex-start" },
  numericRowBlock: { display: "flex", flexDirection: "column", gap: "4px", flex: "1 1 auto", minWidth: 0 },
  sellSlashRow: {
    display: "flex",
    // Design note #30: NO WRAP. Five options plus four separators is a fixed width with nothing to reflow,
    // and wrapping only ever dropped "50%" onto its own line, reading as a sixth control. Padding and gap
    // are tightened to buy the width back.
    flexWrap: "nowrap",
    alignItems: "center",
    gap: "1px",
    padding: "5px 6px",
    borderRadius: "8px",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: CARD_DIVIDER,
    backgroundColor: "rgba(0,0,0,0.03)",
  },
  sellSlash: { color: CARD_INK_FAINT, fontSize: FONT_SIZE.small, opacity: 0.5 },
  sellSlashOption: {
    background: "transparent",
    border: "none",
    // Design note #30: 6px -> 3px horizontal. Across five options and four
    // separators that is 30px reclaimed, which is what makes one line fit.
    padding: "2px 3px",
    whiteSpace: "nowrap",
    borderRadius: "5px",
    fontSize: FONT_SIZE.small,
    fontWeight: 700,
    fontVariantNumeric: "tabular-nums",
    color: CARD_INK_MUTED,
    cursor: "pointer",
  },
  sellSlashOptionActive: { backgroundColor: CARD_HIGHLIGHT_BG, color: CARD_HIGHLIGHT_INK },
  // Inline styles cannot express `:disabled` (Lobby.tsx design note #3), so
  // the disabled look is computed.
  sellSlashOptionDisabled: { opacity: 0.35, cursor: "not-allowed", textDecoration: "line-through" },
  sellHint: {
    fontSize: FONT_SIZE.micro,
    lineHeight: 1.4,
    color: "#c8a24a",
  },
  actionButton: {
    fontSize: FONT_SIZE.body,
    fontWeight: 700,
    padding: "9px 14px",
    borderRadius: "8px",
    border: "1px solid #3a3f4b",
    backgroundColor: "#242833",
    color: "#e6e8ef",
    cursor: "pointer",
  },
  passButton: {
    fontSize: FONT_SIZE.body,
    fontWeight: 700,
    padding: "9px 18px",
    borderRadius: "8px",
    border: "1px solid #4a3f3f",
    backgroundColor: "#2c2020",
    color: "#e8c7c7",
    cursor: "pointer",
  },
};
