// frontend/src/components/StockRoundPanel.tsx
//
// Stock Round (SR) Action Control Panel -- Waterfall/Stock Auction pass.
// Renders directly above the Stock Market Matrix (see App.tsx's render
// block, between `ContextualActionBar` and `styles.boardPane`) whenever a
// Stock Round is live, giving the active player genuine UI-driven controls
// for the three real `GameplayExecuteMsg` variants `ContextualActionBar`'s
// old "Buy Share (mock)" / "Sell Shares (mock)" buttons used to dispatch
// with hardcoded parameters (see App.tsx design note #4's mock-action
// placeholder convention). Buy/Sell/Pass ownership moves here entirely --
// `ContextualActionBar`'s Stock-Round button branch is emptied out in the
// same pass so there are never two competing sets of controls on screen.
//
// Design notes:
// 1. **Presentational only.** Same "App.tsx owns state, child components
//    render it" split this codebase uses everywhere (TopTicker.tsx design
//    note #1, InlineQuickChat.tsx design note #2, and now this file) --
//    every piece of selection state (`selectedProtocolId`, `parValue`,
//    `source`, `sellPercentage`) is owned by App.tsx and threaded down as
//    props, with plain callback props for every mutation.
// 2. **No new backend surface.** `BuyStock`/`SellStock` already accept
//    every parameter this panel's controls produce (`source: "Ipo" |
//    "Bank"`, `par_value: string | null`, `percentage: number`) -- this is
//    a pure frontend selection layer feeding App.tsx's existing
//    `handleBuyShare`/`handleSellShares`/`runGameplayAction` dispatch
//    plumbing untouched.
// 3. **Par Value Grid only matters pre-float.** Once the selected company's
//    `is_floated` is true, App.tsx passes `par_value: null` regardless of
//    grid selection (a floated company's share price comes from the Stock
//    Market Matrix, not a fresh par choice) -- the grid stays visible for
//    context but is visually marked inactive so it never reads as "still
//    doing something."
// 4. **Float Indicator** mirrors `public_company.rs`'s real float
//    condition: shares actually reaching player hands is
//    `100 - ipo_pool_percentage - bank_pool_percentage`; the 60% threshold
//    marker is drawn on the same bar, and the `is_floated` badge is the
//    ground truth (the bar can visually read past 60% before the backend
//    has actually processed the float on a given poll tick).
// 5. **Company selector palette** intentionally mirrors
//    `StockMarketRenderer.tsx`'s own module-local `TICKER_COLORS` (that
//    map isn't exported, so this is a hand-kept duplicate of the same
//    eight colors -- same "hand-kept mirror" convention as
//    `MOCK_TRAIN_CATALOG`/`TERRAIN_BUILD_COST_LABEL` elsewhere in this
//    codebase) so a given company reads as the same color everywhere.

import React, { useEffect, useState } from "react";
import type { PublicCompanyState } from "../utils/gameState";
import type { GamePhase, TierRustOutlook, TrainTier } from "../utils/gamePhase";
import { CapacityPill, LastRoutePayout, TrainChips } from "./TrainBadges";
import { allowsMultipleBankPoolBuys, marketZoneForPrice } from "./StockMarketRenderer";
import { corporationFullName, corporationTitle } from "../utils/corporationNames";
import { FONT_SIZE } from "../styles/typography";
// Design note #389: the same ink-on-fill helper the map's station
// tokens use, so a corporate colour is legible on the card for the
// same reason it is legible on the board.
import { bestContrastTextColor } from "./hexContractTypes";
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
  parValue: string;
  onSelectParValue: (value: string) => void;
  /** Design note #29 in `App.tsx`: the target company travels with the
   *  click. Every card renders its own Buy/Sell, so there is no shared
   *  selection for these to read -- and `selectedProtocolId` /
   *  `onSelectProtocolId` are gone from this interface for the same
   *  reason. */
  onBuyShare: (protocolId: number, source: "Ipo" | "Bank", quantity: number) => void;
  onSellShares: (protocolId: number, percentage: number) => void;
  sessionReady: boolean;
  isMyTurn: boolean;
  /* ==================================================================
   *  DESIGN NOTE 34: HOTSEAT, AND WHO IS UP
   * ==================================================================
   *
   * REPORTED: the Stock round is non-interactive in Sandbox, and it is
   * unclear whose turn it is.
   *
   * The second half is the one this panel actually had: the header said
   * "Waiting for your turn..." whenever `isMyTurn` was false and named
   * nobody, so on a shared keyboard it was a prompt to wait for yourself.
   * With every seat truncating to the same address (design note #31 in the
   * auction dashboard) there was no way to tell who it was waiting FOR.
   *
   * `hotseat` swaps that message for the seat's NAME, and suppresses the
   * "waiting" framing entirely -- at a shared keyboard nobody is waiting,
   * somebody just needs to pick up the mouse. */
  hotseat?: boolean;
  /** Whose turn it is, already resolved to a name. */
  activePlayerLabel?: string | null;
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
  /** Design note #8: live stock-market price per `company_id`.
   *
   *  A SEPARATE prop rather than a field on `PublicCompanyState`, because on
   *  a real chain it genuinely is separate data: `GetGameState` carries the
   *  par value and the ownership registry, while the live market position
   *  comes from `GetMarketGrid`. Folding one into the other here would
   *  invent a shape the contract never returns.
   *
   *  A missing or `null` entry means "no market position", which is the
   *  correct state for an unfloated corporation -- rendered as a dash, never
   *  as `0`, since a zero share price means something very different from
   *  not having one. */
  marketPrices?: Readonly<Record<number, number | null>>;
  /** Optional address -> display name, so a roster can read "Alice" instead
   *  of `juno1abc...wxyz`. Returns `null` to fall back to truncation. Used
   *  by the sandbox; on a real chain there are no names to resolve yet. */
  playerLabel?: (address: string) => string | null;
  /** The room's derived phase (`utils/gamePhase.ts`), for the operating
   *  snapshot on the card front -- specifically the train limit and which
   *  tier is about to rust. Optional: without it the chips render plainly
   *  and the capacity pill reads "n / ?", which is honest rather than
   *  guessing a limit. */
  phase?: GamePhase | null;
  /** Per-tier rust countdown, so the card-front chips can say how far off a
   *  rust is -- see `TrainBadges.tsx` design note #4. */
  outlook?: Readonly<Record<TrainTier, TierRustOutlook>> | null;
  /** Why buying and selling are unavailable right now, or `null` when they
   *  are legal.
   *
   *  Design note #32: this exists because the roster became a PERSISTENT
   *  tab (`App.tsx` design note #41) and is now reachable during the
   *  Operating Round and the auction. Share trading is a Stock Round
   *  action; leaving the Buy/Sell controls live outside one would let a
   *  player fire a `BuyStock` the contract is certain to reject, and a
   *  rejected transaction is a worse explanation than a disabled button. */
  actionsLockedReason?: string | null;
}

/* ==================================================================== */
/*  DESIGN NOTE 8: THE CORPORATION ROSTER                               */
/* ==================================================================== */
//
// A card per corporation, above the action controls: market price, IPO/par
// price, and who owns what. This panel previously showed only the SELECTED
// company's numbers, which meant the one question a Stock Round is actually
// about -- who controls what, and what would it cost me to take it -- could
// not be answered without clicking through all eight companies and holding
// the results in your head.
//
// THE PRESIDENT IS THE POINT. Presidency is the only thing in 1830 that
// confers control, it changes hands silently the moment someone outbuys the
// incumbent, and missing that it has moved is how players lose games. So it
// is marked three ways at once, deliberately redundantly: a 👑 glyph, a
// bold gold row, and the word "president" spelled out. Colour alone would
// fail a colourblind player; a glyph alone is easy to skim past; the word
// alone is invisible in a dense table. All three together are hard to miss
// and survive any one channel being unavailable.
//
// WHAT THIS DOES NOT DO: it never derives the president. `president` is a
// field on `PublicCompanyState`, set by the contract, and the largest
// holder is NOT reliably the president (1830 presidency only transfers when
// someone strictly exceeds the incumbent, so a tie leaves it where it was).
// Computing it here from `player_holdings` would look right almost always
// and be wrong at exactly the moments that matter.

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
  connectedAddress,
  macroRoundNumber,
  playerCash,
  playerLabel,
  expandedCompanyId,
  onToggleCompany,
  parValue,
  onSelectParValue,
  onBuyShare,
  onSellShares,
  controlsDisabled,
}: {
  publicCompanies: readonly PublicCompanyState[];
  phase?: GamePhase | null;
  outlook?: Readonly<Record<TrainTier, TierRustOutlook>> | null;
  marketPrices?: Readonly<Record<number, number | null>>;
  connectedAddress: string | null;
  /** Design note #356: the Stock Round's number; `1` bans selling. */
  macroRoundNumber?: number;
  /** Design note #357: the acting player's spendable cash, for the buy gate. */
  playerCash?: number | null;
  playerLabel?: (address: string) => string | null;
  expandedCompanyId: number | null;
  onToggleCompany: (companyId: number) => void;
  parValue: string;
  onSelectParValue: (value: string) => void;
  onBuyShare: (protocolId: number, source: "Ipo" | "Bank", quantity: number) => void;
  onSellShares: (protocolId: number, percentage: number) => void;
  controlsDisabled: boolean;
}) {
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
        {publicCompanies.map((company) => {
          const color = tickerColor(company.company_id);
          // Design note #389: derived from the fill, so every corporation's
          // stripe is legible without a per-company decision.
          const liveryInk = bestContrastTextColor(color);
          const isExpanded = company.company_id === expandedCompanyId;
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
                {/* Design note #16/#26: the ENTIRE surface is the toggle --
                    ticker, prices, holdings, pools, all of it. A caret is a
                    ~20px target on a ~300px card that is itself the thing
                    being chosen; making the card the target removes the
                    question of where to click. Design note #388: it
                    expands -- there is no longer a second paradigm for it
                    to mean something else in. */}
                <button
                  type="button"
                  onClick={() => onToggleCompany(company.company_id)}
                  aria-expanded={isExpanded}
                  style={styles.rosterCardToggle}
                >
                {/* ==================================================
                     DESIGN NOTE 389: THE HEADER IS THE LIVERY
                    ==================================================

                    REPORTED: replace the top text area -- abbreviation,
                    full name and float progress -- with a solid stripe
                    whose background is exactly the corporation's theme
                    colour, with the text legible inside it.

                    The three facts were already here; what they lacked was
                    IDENTITY. A corporation's colour was a 16px tint on the
                    ticker glyphs alone, which is the least of it: the same
                    colour is the map token, the route ribbon and the market
                    chart token, and on all three it is a FIELD of colour.
                    Eight cards distinguished only by four coloured letters
                    made the player read to identify a card they could have
                    recognised.

                    `tickerColor` is the same lookup those surfaces use, so
                    the stripe cannot drift from the token. The requirement
                    says "exactly match", and this is the mechanism for
                    that: one table, not a second palette that looks close.

                    THE INK IS COMPUTED, NOT CHOSEN. `bestContrastTextColor`
                    is the same helper the map's station tokens use to put
                    an acronym on an arbitrary corporate fill. Hard-coding
                    white would fail on C&O's amber (#d68910); hard-coding
                    black would fail on CPR's purple. Deriving it per colour
                    means a corporation added later is legible by
                    construction rather than by someone remembering to
                    check. */}
                <div style={{ ...styles.rosterLivery, backgroundColor: color, color: liveryInk }}>
                  <span style={styles.rosterNameStack}>
                    <span
                      style={styles.rosterLiveryTicker}
                      title={corporationTitle(company.ticker)}
                    >
                      {company.ticker}
                    </span>
                    {corporationFullName(company.ticker) && (
                      <span style={styles.rosterLiveryName}>
                        {corporationFullName(company.ticker)}
                      </span>
                    )}
                  </span>
                  {/* Float status rides in the stripe too -- it was the
                      third thing in the text area being replaced. Both
                      badges take their ink from the stripe rather than
                      carrying their own, so neither can become unreadable
                      on a corporation whose colour they were not designed
                      against. */}
                  {company.is_floated ? (
                    <span
                      style={{ ...styles.rosterLiveryBadge, color: liveryInk, borderColor: liveryInk }}
                      title={
                        metFloatThreshold(company)
                          ? `Floated — ${soldToPlayersPercent(company)}% sold to players.`
                          : `Auto-floated by the B&O private company, not by reaching ${FLOAT_THRESHOLD_PERCENT}% sold.`
                      }
                    >
                      FLOATED
                    </span>
                  ) : (
                    <span
                      style={{ ...styles.rosterLiveryBadge, color: liveryInk, borderColor: liveryInk }}
                      title={`${soldToPlayersPercent(company)}% sold to players; ${FLOAT_THRESHOLD_PERCENT}% floats this corporation.`}
                    >
                      {soldToPlayersPercent(company)}% / {FLOAT_THRESHOLD_PERCENT}%
                    </span>
                  )}
                </div>

                {/* The two prices, side by side and labelled. Market is the
                    live figure and gets the emphasis; par is what it floated
                    at and is the reference point for judging it. */}
                <div style={styles.rosterPriceRow}>
                  {/* ==================================================
                       DESIGN NOTE 387: NO PAR, NO MARKET FIGURE
                      ==================================================

                      REPORTED: unparred corporations display market values.

                      `market` comes from the price table, which had been
                      seeded from a mid-game fixture regardless of scenario
                      -- so a Zero State corporation with `par_value: null`
                      showed a price for a share nobody can own at a
                      valuation nothing set. The seed is fixed, and so is
                      the chart's token filter, but the card asserts it too:
                      the market price is DEFINED as where the token stands,
                      and a company with no par has no token. Reading
                      `market` without checking par would let any future
                      producer put the figure back. */}
                  <div style={styles.rosterPrice}>
                    <span style={styles.rosterPriceValue}>
                      {company.par_value === null || market === null ? "--" : market}
                    </span>
                    <span style={styles.rosterPriceLabel}>market</span>
                  </div>
                  <div style={styles.rosterPrice}>
                    <span style={styles.rosterPriceValueMuted}>{company.par_value ?? "--"}</span>
                    <span style={styles.rosterPriceLabel}>IPO / par</span>
                  </div>
                  <span style={styles.rosterChevron} aria-hidden="true">
                    {isExpanded ? "\u25B2" : "\u25BC"}
                  </span>
                </div>

                {/* ---- Design note #31: the operating snapshot ----------
                    Trains, capacity and last payout, on the FRONT face.
                    A Stock Round decision is a bet on how a corporation
                    will operate, and none of that was visible without
                    expanding the card -- which is exactly the moment a
                    player is choosing between eight of them and least
                    wants to open each one. Whether a company is one
                    purchase from losing its trains, or already at its
                    limit and unable to buy, changes what a share is worth
                    before you look at the price.

                    Rendered with the SAME components the Operating Round
                    table uses (`TrainBadges.tsx`), on the light surface --
                    so the rust colouring cannot disagree between the two
                    screens. */}
                <div style={styles.rosterOpsRow}>
                  <div style={styles.rosterOpsCell}>
                    <span style={styles.rosterOpsLabel}>Treasury</span>
                    <span style={styles.rosterOpsTreasury}>${company.treasury}</span>
                  </div>
                  <div style={styles.rosterOpsCell}>
                    <span style={styles.rosterOpsLabel}>Trains</span>
                    <TrainChips
                      trains={company.owned_trains}
                      phase={phase ?? null}
                      surface="light"
                      compact
                      outlook={outlook}
                    />
                  </div>
                  <div style={styles.rosterOpsCell}>
                    <span style={styles.rosterOpsLabel}>Limit</span>
                    <CapacityPill
                      trains={company.owned_trains}
                      phase={phase ?? null}
                      surface="light"
                      compact
                    />
                  </div>
                  <div style={styles.rosterOpsCell}>
                    <span style={styles.rosterOpsLabel}>Last payout</span>
                    <LastRoutePayout
                      surface="light"
                      compact
                      revenue={company.last_route_revenue}
                    />
                  </div>
                </div>

                {/* ==================================================
                     DESIGN NOTE 378: ONE OWNERSHIP TABLE, IN 18xx ORDER
                    ==================================================

                    REPORTED: the ownership list is unstructured and should
                    match standard 18xx tabular layouts.

                    It was two separate readouts describing one thing. A
                    list of players sat here with their percentages, and the
                    IPO and Bank Pool counts sat in their own row underneath
                    (design note #355), in a different format, with no
                    columns shared between them. So the question every 18xx
                    player asks of a corporation -- "where are the ten
                    certificates" -- had its answer split across two shapes
                    that did not line up, and the two halves could not be
                    read as a total.

                    ONE TABLE, in the order the physical game keeps its
                    certificates: the two BANKS first (unsold in the IPO,
                    returned to the Pool), a rule, then the PLAYERS who hold
                    the rest. The rule is not decoration -- it is the line
                    between shares nobody owns and shares somebody does,
                    which is the distinction the whole layout exists to
                    make.

                    THREE COLUMNS. Shareholder, then certificates, then
                    percentage. Certificates before percentage because a
                    certificate is the physical unit a player moves, and
                    because the president's 20% being ONE certificate is
                    exactly the fact a bare percentage hides.

                    SORTED DESCENDING, and the president is NOT hoisted --
                    that was already true of the old list and the reasoning
                    holds: seeing them sitting second on an equal stake is
                    precisely what a player needs to notice. */}
                <div style={styles.ownershipTable} role="table" aria-label={`${company.ticker} ownership`}>
                  <div style={styles.ownershipHeadRow} role="row">
                    <span style={styles.ownershipName} role="columnheader">Shareholder</span>
                    <span style={styles.ownershipNum} role="columnheader">Shares</span>
                    <span style={styles.ownershipNum} role="columnheader">%</span>
                  </div>

                  {/* The two banks, always shown -- an IPO at 0% means the
                      company is fully distributed, which is worth as much
                      as any other figure here. */}
                  <div style={styles.ownershipRow} role="row">
                    <span style={styles.ownershipName} role="cell">IPO</span>
                    <span style={styles.ownershipNum} role="cell">
                      {company.ipo_pool_percentage / 10}
                    </span>
                    <span style={styles.ownershipNum} role="cell">{company.ipo_pool_percentage}%</span>
                  </div>
                  <div style={styles.ownershipRow} role="row">
                    <span style={styles.ownershipName} role="cell">Bank Pool</span>
                    <span style={styles.ownershipNum} role="cell">
                      {company.bank_pool_percentage / 10}
                    </span>
                    <span style={styles.ownershipNum} role="cell">{company.bank_pool_percentage}%</span>
                  </div>

                  {/* Design note #378: the line between unowned and owned. */}
                  <hr style={styles.ownershipRule} />

                  {holdings.length === 0 ? (
                    <span style={styles.rosterNoHoldings}>No shares held by players</span>
                  ) : (
                    holdings.map((holding) => (
                      <div
                        key={holding.address}
                        role="row"
                        style={{
                          ...styles.ownershipRow,
                          ...(holding.isPresident ? styles.rosterHoldingRowPresident : {}),
                        }}
                      >
                        <span style={styles.ownershipName} role="cell">
                          {holding.isPresident && (
                            <span title="President — controls this corporation" aria-label="President">
                              👑
                            </span>
                          )}
                          {playerLabel?.(holding.address) ?? truncateHolder(holding.address)}
                          {holding.isSelf && <span style={styles.rosterYouTag}>you</span>}
                        </span>
                        <span style={styles.ownershipNum} role="cell">
                          {certificateCount(holding.percentage, holding.isPresident)}
                        </span>
                        <span style={styles.ownershipNum} role="cell">{holding.percentage}%</span>
                      </div>
                    ))
                  )}
                </div>

                {/* ==================================================
                     DESIGN NOTE 345: ONE FLOAT READOUT, NOT TWO
                    ==================================================

                    REPORTED: remove the full-row 0/60% progress bar to save
                    space; keep the small 0/60% pill at the top right.

                    Design note #17 put the bar in the collapsed body for a
                    good reason -- "is this close to floating?" is a
                    question you ask while scanning -- and then the pill
                    badge arrived above it answering the same question in
                    one line. Eight cards were each spending a track, a
                    fill, a threshold tick and a caption on a figure printed
                    six pixels higher.

                    The pill wins because it is already IN the header row a
                    player reads first, and because the bar's one advantage
                    -- showing distance to the threshold graphically -- is
                    worth less than the vertical space it costs across eight
                    cards on a screen that also has to hold the market
                    chart. */}

                {/* Design note #24: floated WITHOUT reaching the threshold.
                    Says which rule did it, so the badge never looks like it
                    is contradicting the percentages beside it. */}
                {company.is_floated && !metFloatThreshold(company) && (
                  <span style={styles.autoFloatNote}>
                    Auto-floated by the B&amp;O private &middot; {soldToPlayersPercent(company)}% sold
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
              connectedAddress={connectedAddress}
              macroRoundNumber={macroRoundNumber}
              playerCash={playerCash}
              parValue={parValue}
              onSelectParValue={onSelectParValue}
              onBuyShare={onBuyShare}
              onSellShares={onSellShares}
              controlsDisabled={controlsDisabled}
            />
          );

          /* ==================================================
               DESIGN NOTE 388: THE FLIP IS GONE
              ==================================================

             REPORTED: remove the 3D card flip entirely and render every
             action on the front of the card.

             Design note #26 chose the flip to solve a real problem -- the
             grid reflowed when a card expanded, so choosing between eight
             corporations meant the other seven jumped around underneath the
             pointer. The flip fixed that by construction: a rotated card
             occupies exactly the space it did before.

             It cost more than it saved, and design note #27's history is
             the evidence. Hiding the numbers behind the decision meant
             re-deriving a condensed holdings list, a second price readout
             and a second pool row for the back face -- a whole parallel
             rendering of the same corporation, which then had to be kept in
             agreement with the front (see #355's "same suppression on the
             card back, so the two faces agree"). Then the flip needed a
             `stopPropagation` guard so operating a control did not spin the
             card away mid-decision, and that guard needed revising when it
             turned out to swallow clicks on padding.

             Every one of those is a cost of the numbers being on the other
             side of a rotation. Putting the actions on the FRONT deletes
             the parallel render, the guard and the fixed 460px frame that
             imposed the tallest card's height on all eight -- and the buy
             and sell controls now sit directly beneath the ownership table
             they are a decision about, which is where a player looking at
             both wanted them.

             The reflow #26 worried about is handled by the card keeping its
             own height: actions render for the EXPANDED card only, exactly
             as the accordion always did. */

          return (
            <div
              key={company.company_id}
              style={{
                ...styles.rosterCard,
                ...(company.is_floated ? {} : styles.rosterCardUnfloated),
                borderColor: isExpanded ? CARD_BORDER_ACTIVE : CARD_BORDER,
              }}
            >
              {cardFace}
              {/* Design note #388: ON THE FRONT, unconditionally. The
                  actions were gated on `isExpanded` because the flip and
                  the accordion both treated them as the hidden half of the
                  card. There is no hidden half now, and a Par/Buy/Sell
                  control that requires a click to reveal is a control the
                  player has to remember is there. */}
              {cardActions}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * The buy/sell controls for ONE corporation -- design note #10.
 *
 * Everything here was previously a global section keyed to a separate pill
 * selector. Scoping it to a card means each control is unambiguously about
 * the company whose numbers are directly above it, and the float bar / par
 * ladder / sell bounds are all computed from THAT company rather than from
 * a selection held elsewhere.
 */
function CompanyActions({
  company,
  marketPrice,
  connectedAddress,
  macroRoundNumber,
  playerCash,
  parValue,
  onSelectParValue,
  onBuyShare,
  onSellShares,
  controlsDisabled,
}: {
  company: PublicCompanyState;
  /** This company's live market price, or `null` when it has no position.
   *  Design note #33: decides whether the Brown-zone quantity selector
   *  appears at all. */
  marketPrice: number | null;
  connectedAddress: string | null;
  macroRoundNumber?: number;
  playerCash?: number | null;
  parValue: string;
  onSelectParValue: (value: string) => void;
  onBuyShare: (protocolId: number, source: "Ipo" | "Bank", quantity: number) => void;
  onSellShares: (protocolId: number, percentage: number) => void;
  controlsDisabled: boolean;
}) {
  /* Design note #18: BUY SOURCE IS LOCAL.
   *
   * `source` was a single value owned by `App.tsx` and threaded into every
   * card, so flipping IPO/Bank on one card flipped it on all eight. That
   * was invisible while only one card was expanded at a time and became
   * obvious the moment they all were -- and it is a real hazard either way,
   * because the toggle a player set on PRR silently governed the purchase
   * they then made from B&M.
   *
   * The previous pass removed the shared COMPANY selection for exactly this
   * class of bug and left the shared toggle behind, which is the more
   * interesting mistake: "which company" and "which source" are the same
   * kind of per-card decision, and fixing one without the other left half
   * a bug in place. Both now live with the card that shows them. */
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

  /* ==================================================================
   *  DESIGN NOTE 35: THE BUY BUTTON ALWAYS PRICES ITSELF
   * ==================================================================
   *
   * The label only showed a price while the company was UNFLOATED, so the
   * moment a second source appeared the suffix vanished and the button
   * read a bare "Buy 1 share" -- exactly when a price mattered most,
   * because the player now had two of them to choose between.
   *
   * The two sources genuinely cost different amounts, which is the whole
   * reason the toggle exists:
   *
   *   IPO        -> the corporation's PAR price
   *   Bank Pool  -> the current MARKET price
   *
   * PAR COMES FROM THE COMPANY ONCE IT IS SET. `parValue` is the ladder
   * SELECTION -- a control, not a fact -- and is only what the buyer pays
   * on the very first purchase, the one that sets par. After that
   * `company.par_value` is the price, and reading the ladder would quote
   * whatever the player last clicked rather than what the share costs.
   */
  const parPrice = company.par_value != null ? Number(company.par_value) : Number(parValue);
  const unitPrice = source === "Bank" ? marketPrice : parPrice;
  const priceKnown = unitPrice != null && Number.isFinite(unitPrice);

  /* THE FIRST PURCHASE IS NOT A 10% SHARE, and pricing it as one would
   * understate the cost by half. Whoever buys into a corporation with no
   * president takes the President's Certificate: 20% of the company, at
   * DOUBLE par. Quoting "@ $67" for a $134 transaction is the kind of
   * wrong number a player only discovers after signing, so the button says
   * what it actually is. Keyed on `president === null` rather than on a
   * percentage, because presidency is a contract field and the shares-sold
   * arithmetic is a derivation. */
  /* Design note #36: the gate is BOTH conditions, not either.
   *
   * The President's Certificate is the first thing sold out of an IPO, so
   * "somebody holds shares" and "there is no president" cannot both be
   * true in a legal 1830 position -- and the sandbox's C&O fixture proved
   * how easily an illegal one slips in (see `sandboxState.ts` design note
   * #6: two players at 10% with no president). Reading `president === null`
   * alone made the card offer a President's Share that two people had
   * already bought around.
   *
   * Requiring BOTH means a malformed state degrades to the conservative
   * answer -- an ordinary 10% share -- instead of advertising a
   * certificate that cannot exist. */
  const anySharesHeld = company.player_holdings.some((holding) => holding.percentage > 0);
  const isPresidentPurchase = company.president === null && !anySharesHeld;
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

  /* Design note #20: SELL SIZE IS LOCAL TOO, and this is what fixes the
   * highlight sticking on 10%.
   *
   * `sellPercentage` was still a single value owned by `App.tsx` -- the last
   * survivor of the shared-selection model that `source` and the company id
   * already escaped. Two consequences, and the second is the reported bug:
   *
   *   - picking 30% on PRR silently changed the size on all eight cards; and
   *   - on any card where the viewer holds nothing, EVERY size is disabled,
   *     so the click never fires and the highlight never leaves its initial
   *     10% -- which looks like a broken toggle rather than "you have no
   *     shares here".
   *
   * Local state fixes the first outright. The second is now honest instead:
   * the row still disables sizes you cannot cover, but the card you CAN sell
   * from tracks your click independently of every other card. */
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

  /* ==================================================================
   *  DESIGN NOTE 357: A PLAYER CANNOT SPEND WHAT THEY DO NOT HAVE
   * ==================================================================
   *
   * REPORTED: players can spend into negative cash -- $74 buying an $82
   * share.
   *
   * The button gated on turn and session readiness and never on price. The
   * sandbox reducer's `adjustCash` floors at zero rather than refusing, so
   * the purchase completed, the share arrived, and the buyer's balance read
   * $0 instead of -$8. Quiet, and the kind of wrong that only shows up when
   * somebody reconciles the bank.
   *
   * THE TOTAL COST, not the unit price -- the two differ in both directions
   * that matter here. A President's Certificate is DOUBLE par (design note
   * #35 already prices it that way on the label), and a Brown-zone multibuy
   * is `n` times the price. Gating on the unit would let a player buy a
   * $134 presidency with $70.
   *
   * `null` cash leaves the gate OFF. A room that does not report a balance
   * is not a room where the player is broke, and blocking every purchase on
   * missing data would be worse than the bug. */
  const totalCost = (() => {
    if (!priceKnown) return null;
    const price = unitPrice as number;
    if (isPresidentPurchase) return price * 2;
    return price * (multiBuyMax > 1 ? effectiveQuantity : 1);
  })();
  const cannotAfford =
    playerCash != null && totalCost != null && totalCost > playerCash;
  const bankPoolPercent = company.bank_pool_percentage;
  const selectedSellState = sellOptionState(sellPercentage, playerHoldingPercent, bankPoolPercent);

  return (
    <div style={styles.cardActions}>
      {/* Buy */}
      <div style={styles.cardActionsBlock}>
        <span style={styles.cardActionsLabel}>Buy share</span>
        {/* ==============================================================
            DESIGN NOTE 36: BOTH SOURCES, ALWAYS -- DISABLED, NOT ABSENT
            ==============================================================

            This had three branches: two buttons, a plain-text hint, or a
            different plain-text hint. So a card changed SHAPE as pools
            drained -- buttons became a sentence, and the whole block below
            jumped. On a grid of eight cards that reads as flicker rather
            than as information.

            Design note #21 removed the empty source on the reasoning that
            offering it invites a rejected transaction. That reasoning was
            right about the CLICK and wrong about the CONTROL: a disabled
            button refuses the click just as firmly, and unlike a vanished
            one it still says the pool exists and is empty -- which is the
            actual state, and something a player buying into a corporation
            wants to know.

            `disabled` also keeps the two buttons in the same place from
            first render to last, so the Buy button underneath never
            moves. */}
        {/* ==================================================================
             DESIGN NOTE 346: THE SOURCE IS A SWITCH, NOT TWO BUTTONS
            ==================================================================

            REPORTED: the front of the stock cards is too cluttered; replace
            the large Bank/IPO buttons with a compact toggle beside Buy, and
            default to the only available option when one pool is empty.

            Design note #36 argued for keeping both sources visible and
            DISABLED rather than hiding an empty one, and that argument
            still holds -- "the Bank Pool is empty" is a fact a buyer wants.
            What it got wrong was the WEIGHT: two full-width padded buttons
            stacked above the Buy button, so choosing a source looked like
            three primary actions rather than one action with a setting.

            A segmented switch says the same thing in one row: the two
            options are visibly alternatives rather than separate commands,
            the empty one is struck through and unclickable with its reason
            on hover, and the whole control is a third of the height. It
            sits ON the Buy row, so "buy one share, from here" reads as a
            single sentence.

            THE DEFAULT is handled by the effect below, which already
            re-points `source` at the first stocked pool whenever the
            current one drains. That covers the "one is empty" case at
            first render as well, because it runs on mount. */}
        <div style={styles.buyRow}>
          <div style={styles.sourceSwitch} role="group" aria-label="Share source">
            {(["Ipo", "Bank"] as const).map((option) => {
              const available = option === "Ipo"
                ? company.ipo_pool_percentage > 0
                : company.bank_pool_percentage > 0;
              return (
                <button
                  key={option}
                  type="button"
                  aria-pressed={source === option}
                  style={{
                    ...styles.sourceSwitchOption,
                    ...(source === option && available ? styles.sourceSwitchOptionActive : {}),
                    // Inline styles cannot express `:disabled` (Lobby.tsx
                    // design note #3), so the disabled look is computed.
                    ...(available ? {} : styles.sourceSwitchOptionEmpty),
                  }}
                  disabled={controlsDisabled || !available}
                  title={
                    available
                      ? option === "Ipo"
                        ? `Buy from the IPO at par. ${company.ipo_pool_percentage}% left.`
                        : `Buy from the Bank Pool at market price. ${company.bank_pool_percentage}% left.`
                      : option === "Ipo"
                        ? "The IPO Warehouse is empty."
                        : "The Bank Pool is empty."
                  }
                  onClick={() => setSource(option)}
                >
                  {option === "Ipo" ? "IPO" : "Pool"}
                </button>
              );
            })}
          </div>

          {/* ==================================================================
               DESIGN NOTE 347: SOLD OUT IS A STATE, NOT A DISABLED BUY
              ==================================================================

              REPORTED: when a corporation is fully sold out, disable the buy
              inputs and show a grey "Sold Out" button.

              The button was already disabled in this state -- `disabled={...
              || availableSources.length === 0}` -- but it still READ "Buy 1
              share @ $67", which is the failure mode this codebase keeps
              removing: a control describing an action that cannot happen.
              A player seeing a price and a greyed button assumes they
              cannot afford it, or that it is not their turn.

              Both pools empty means every certificate is in players' hands.
              That is a permanent fact about the company for the rest of the
              round, not a temporary block, so it gets its own label and its
              own neutral grey rather than the primary button's colour
              drained. */}
          {availableSources.length === 0 ? (
            <button
              type="button"
              style={{ ...styles.actionButton, ...styles.soldOutButton }}
              disabled
              title={`Every ${company.ticker} certificate is held by players — the IPO and the Bank Pool are both empty.`}
            >
              Sold Out
            </button>
          ) : (
            <button
              type="button"
              style={styles.actionButton}
              onClick={() =>
                onBuyShare(company.company_id, source, multiBuyMax > 1 ? effectiveQuantity : 1)
              }
              disabled={controlsDisabled || cannotAfford}
              title={
                cannotAfford
                  ? `Costs $${totalCost} — you hold $${playerCash}.`
                  : undefined
              }
            >
              {/* Design note #35: one computed label, so the price cannot
                  disappear depending on which branch built the string. */}
              {buyLabel}
            </button>
          )}
        </div>

        {/* ---- Design note #33: the Brown zone's multi-buy ---------------
            Brown is the only zone where a player may take SEVERAL bank-pool
            shares in one turn, so the quantity selector appears there and
            nowhere else -- offering "buy 3" in a Normal zone would be
            offering an action the contract rejects.

            The ceiling is the bank pool itself: `bank_pool_percentage / 10`
            certificates, and never more. It applies only to the Bank source
            -- the IPO is not what the Brown rule relaxes, so switching the
            source back to IPO drops the selector.

            HONEST LIMITATION, and it is a contract one: `BuyStock` has no
            quantity parameter. Buying three shares is three transactions,
            fired in sequence and stopping at the first failure. That is
            visible to the player as three log entries rather than one,
            which is accurate -- it really is three purchases. A single
            batched message would be a contract change. */}
        {multiBuyMax > 1 && (
          <div style={styles.multiBuyRow}>
            <span style={styles.cardActionsLabel}>Quantity</span>
            <select
              style={styles.multiBuySelect}
              value={Math.min(buyQuantity, multiBuyMax)}
              onChange={(event) => setBuyQuantity(Number(event.target.value))}
              disabled={controlsDisabled}
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

      {/* Design note #357: the reason, where the player is looking. A
          disabled button with only a tooltip is a button that looks broken
          to anyone who does not hover it. */}
      {cannotAfford && (
        <span style={styles.cannotAffordNote}>
          ${totalCost} needed &middot; you hold ${playerCash}
        </span>
      )}

      {/* ---- Par + Sell, one line where the card is wide enough ----------
          Design note #22. Both are the same KIND of control -- a row of
          numeric options where exactly one is chosen -- so they are styled
          identically and share a line. `flexWrap` means they stack on a
          narrow card rather than being crushed; nothing here depends on
          them being side by side.

          The par row only appears while the par price is still UNSET.
          Design note #29: the gate used to be `!isFloated`, which was too
          loose. Par is chosen once, by whoever buys the President's share,
          and from that moment the company HAS a price -- floated or not. A
          parred-but-unfloated company (B&O in the sandbox is exactly this)
          was therefore still showing a live par ladder for a decision that
          had already been made, inviting a click that could only be
          rejected. `par_value === null` is the real question: has anyone
          set this yet? Floating is a later, separate event. */}
      <div style={styles.numericRowPair}>
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
                    onClick={() => onSelectParValue(value)}
                  >
                    {value}
                  </button>
                </React.Fragment>
              ))}
            </div>
          </div>
        )}

        {/* Design note #25: no holding, no Sell. Rendering a sell
            control for shares you do not own is offering an action that
            cannot succeed -- every size disabled, a line-through on all
            five, and a button that never enables. On eight cards where a
            player typically holds three, that is five cards of dead
            controls. Hidden outright instead.

            ==================================================
             DESIGN NOTE 356: NOBODY SELLS IN STOCK ROUND 1
            ==================================================

            1830 forbids any sale during the first Stock Round -- there is
            nothing to sell that was not bought minutes ago, and allowing it
            would let a player park cash in a company and withdraw it before
            anyone could react.

            HIDDEN, not disabled, and this is the opposite call from design
            note #36's source buttons a few lines up. That distinction is
            deliberate: an empty Bank Pool is a fact about the BOARD that a
            buyer wants ("it exists and is empty"), whereas the SR1 sell ban
            is a fact about the RULES that will never change while this
            round lasts. A permanently disabled control teaches the player
            to ignore that region of the card, and by SR2 -- when Sell
            becomes real -- they have stopped looking. */}
        {playerHoldingPercent > 0 && !sellingForbidden && (
        <div style={styles.numericRowBlock}>
          <span style={styles.cardActionsLabel}>Sell</span>
        {/* Design note #19: ONE control block, not five buttons.
            Five bordered chips read as five separate decisions and cost a
            whole row of vertical space in a card that has to fit eight to a
            screen. Slash-separated links read as what this actually is --
            a single "how much?" control with five settings -- and collapse
            to one line. The separators are `aria-hidden` so a screen reader
            hears five options, not "10 percent slash 20 percent". */}
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
                  title={state.reason}
                  aria-pressed={active}
                  style={{
                    ...styles.sellSlashOption,
                    ...(active ? styles.sellSlashOptionActive : {}),
                    ...(state.enabled ? {} : styles.sellSlashOptionDisabled),
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

      {playerHoldingPercent > 0 && (
      <button
        type="button"
        style={styles.actionButton}
        onClick={() => onSellShares(company.company_id, sellPercentage)}
        disabled={controlsDisabled || !selectedSellState.enabled}
      >
        Sell {sellPercentage}% Bundle
      </button>
      )}

    </div>
  );
}

/* ===================================================================
/*  DESIGN NOTE 26 (SUPERSEDED BY #388): THE CARD PARADIGM TEST
/* ===================================================================
//
// This file used to carry a long comparison of two card paradigms --
// Option A, an accordion that reflows the grid, and Option C, a 3D flip
// with a fixed 460px frame -- behind a `USE_FLIP_UI` flag, on the
// reasoning that which one is better is a judgement about how the screen
// is actually used and should be settled by trying both.
//
// It was settled. Design note #388 records the outcome and the reasons;
// the flip, the flag and the fixed frame height are all deleted rather
// than left switchable, because a flag nobody will flip back is just a
// second code path to keep working. The accordion is the card.

/* ==================================================================== */
/*  DESIGN NOTE 24: FLOAT IS THE 60% RULE, WITH NO EXCEPTIONS           */
/* ==================================================================== */
//
// A company floats when 60% of its shares are in player hands. There is no
// auto-float route.
//
// An earlier pass here carried an "auto-floated by the B&O private" note,
// because `auction.rs` sets `company.is_floated = true` the moment that
// private is won. That is a contract bug rather than a rule -- winning the
// B&O private grants the President's Certificate and prompts a par choice,
// nothing more -- and it is on the audit list. The note is gone; this UI
// states the real rule.
//
// `is_floated` is still what the BADGE reads, because it is contract state
// and the frontend does not get to overrule it. But when it disagrees with
// the 60% math the card now says the two disagree, rather than inventing a
// rule to reconcile them. On a corrected contract that branch never fires.

/** Percent of a company's shares actually in player hands. */
function soldToPlayersPercent(company: PublicCompanyState): number {
  return Math.max(0, 100 - company.ipo_pool_percentage - company.bank_pool_percentage);
}

/** Whether this company floated the ORDINARY way -- by reaching the 60%
 *  threshold. `false` plus `is_floated === true` means it was auto-floated,
 *  which today means the B&O private. */
function metFloatThreshold(company: PublicCompanyState): boolean {
  return soldToPlayersPercent(company) >= FLOAT_THRESHOLD_PERCENT;
}

/**
 * How many PHYSICAL certificates a holding represents.
 *
 * Not `percentage / 10`. A President's Share is a 20% double certificate --
 * one piece of card, worth two ordinary shares -- so a president on 60%
 * holds five certificates (one 20% president's + four 10%), not six.
 *
 * This matters beyond pedantry: the certificate LIMIT is per certificate,
 * not per percent, so a UI that counts a president's holding as six is
 * overstating their position against the limit by exactly one for every
 * presidency they hold.
 *
 * `isPresident` comes from `PublicCompanyState.president`, set by the
 * contract -- never derived from who holds the most (see design note #8).
 */
export function certificateCount(percentage: number, isPresident: boolean): number {
  return Math.max(0, percentage / 10 - (isPresident ? 1 : 0));
}

/** 8/4 truncation, matching `utils/lobby.ts`'s `truncateAddress` so one
 *  player reads as the same string here as in the lobby seat list. */
function truncateHolder(address: string): string {
  return address.length <= 14 ? address : `${address.slice(0, 8)}...${address.slice(-4)}`;
}

/** Design note #5: hand-kept duplicate of StockMarketRenderer.tsx's
 *  module-local (unexported) `TICKER_COLORS`. */
const TICKER_COLORS: Readonly<Record<number, string>> = {
  1: "#c0392b", // PRR
  2: "#2980b9", // NYC
  3: "#8e44ad", // CPR
  4: "#27ae60", // B&O
  5: "#d68910", // C&O
  6: "#16a085", // ERIE
  7: "#b03a2e", // NNH
  8: "#34495e", // B&M
};
const FALLBACK_TICKER_COLOR = "#5a6270";
function tickerColor(companyId: number): string {
  return TICKER_COLORS[companyId] ?? FALLBACK_TICKER_COLOR;
}

/** Standard 1830 par ladder, per this pass's own requirement. */
const PAR_VALUE_LADDER: readonly string[] = ["67", "71", "76", "82", "90", "100"];

/** Every sell-bundle size 1830 can express: 10% certificate blocks up to the
 *  50% Bank Pool cap. F-6.
 *
 *  Was `[10, 20, 30, 40]`, which silently made a legal move unreachable: a
 *  player holding 60% could not dump 50% in one action, and a president
 *  executing a legal dump-and-transfer had no control for it at all. The
 *  backend accepts any multiple of 10 up to holdings, bounded by the pool
 *  cap; the UI simply did not offer the top step.
 *
 *  The list is now the full domain, and `sellOptionState` below decides which
 *  entries are legal RIGHT NOW. Rendering the illegal ones greyed with a
 *  reason is deliberate: an absent control teaches a player nothing, while a
 *  disabled one that says "would exceed the 50% Bank Pool cap" teaches them
 *  the rule at the moment it applies to them. */
const SELL_PERCENTAGE_OPTIONS: readonly number[] = [10, 20, 30, 40, 50];

/** The 1830 Bank Pool cap: no company may have more than 50% of its shares
 *  sitting in the pool at once. Mirrors the backend's own bound. */
const BANK_POOL_CAP_PERCENT = 50;

/** Whether one sell size is currently legal, and if not, why.
 *
 *  TWO independent limits, reported separately because they call for
 *  different actions from the player:
 *    - HOLDINGS. You cannot sell shares you do not have. Nothing to be done
 *      about it this turn.
 *    - POOL CAP. The pool has room for `50 - bank_pool_percentage` more.
 *      This one moves as other players buy out of the pool, so a player who
 *      knows the reason knows to wait rather than assuming the UI is broken.
 *
 *  Holdings is checked first: if you cannot cover the bundle at all, saying
 *  so is more useful than a pool-cap message about shares you never had. */
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

const FLOAT_THRESHOLD_PERCENT = 60;

export function StockRoundPanel({
  publicCompanies,
  parValue,
  onSelectParValue,
  onBuyShare,
  onSellShares,
  sessionReady,
  isMyTurn,
  hotseat = false,
  activePlayerLabel = null,
  connectedAddress,
  macroRoundNumber,
  playerCash,
  marketPrices,
  playerLabel,
  phase,
  outlook,
  actionsLockedReason,
}: StockRoundPanelProps) {
  // Design note #32: out of phase counts as "controls disabled" exactly the
  // same way an unready session does -- one flag, so no control can be
  // wired to one condition and miss the other.
  const controlsDisabled = !sessionReady || actionsLockedReason != null;
  const [expandedCompanyId, setExpandedCompanyId] = useState<number | null>(null);

  /* ==================================================================
   *  DESIGN NOTE 348: A FLIPPED CARD BELONGS TO WHOEVER FLIPPED IT
   * ==================================================================
   *
   * REPORTED: after a player buys a share and the turn passes, the previous
   * player's flipped stock tile is still flipped over for the next player.
   *
   * `expandedCompanyId` is session state -- it survives every re-render,
   * including the one where the turn moves -- and nothing ever cleared it.
   * In hotseat that is the whole bug: Bob picks up the mouse and finds
   * Alice's PRR card open on its back, showing HER holdings and HER
   * controls, so his first click is on a card he did not choose to look at.
   *
   * WHY A TURN CHANGE AND NOT A PURCHASE. The tempting hook is
   * `onBuyShare`, but a player can flip a card, read it, and pass without
   * buying anything -- and the card would still be open for the next
   * player. The turn moving is the actual boundary: it is the moment the
   * surface stops belonging to one person and starts belonging to another,
   * whatever they did or did not do with it.
   *
   * KEYED ON THE LABEL rather than on an address because that is what this
   * component is given, and it is already resolved per seat. Passing to a
   * seat with the same name would not re-fire -- which cannot happen, since
   * the label is derived from the seat and the seats are distinct. */
  useEffect(() => {
    setExpandedCompanyId(null);
  }, [activePlayerLabel]);

  /* ---- Design note #10: ACTIONS LIVE IN THE CARD ---------------------
   *
   * The global action panel is gone. It was a company pill-selector, a
   * float bar, a par grid, a buy control and a sell control -- five
   * sections, all silently keyed to whichever company the pill row had
   * selected. So the eight cards showed you the position, and a separate
   * stack of controls below acted on one of them, with only a highlighted
   * pill connecting the two. Reading "PRR: Alice 60%" and then operating a
   * Buy button eight inches away that may or may not have been pointed at
   * PRR is exactly the ambiguity the auction had, in a screen with twice
   * as many companies.
   *
   * Now the card IS the control surface: expanding one selects it and
   * reveals its own float bar, par ladder, buy and sell controls. The pill
   * row is redundant and removed -- expansion is the selection.
   *
   * ACCORDION HERE, FLAT IN THE AUCTION, and the asymmetry is deliberate
   * rather than an inconsistency. An auction card has ONE legal action and
   * six cards to compare, so hiding a single button behind a click is pure
   * cost (design note #17 there). A corporation card has a par ladder, a
   * source toggle, five sell sizes and two buttons -- roughly twenty
   * controls -- and there are eight of them. Rendering all eight expanded
   * is several screens of controls for a turn in which the player will act
   * on exactly one company. The rule is about content volume, not house
   * style. */
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
        connectedAddress={connectedAddress}
        macroRoundNumber={macroRoundNumber}
        playerCash={playerCash}
        playerLabel={playerLabel}
        expandedCompanyId={expandedCompanyId}
        onToggleCompany={(id) =>
          setExpandedCompanyId((current) => (current === id ? null : id))
        }
        parValue={parValue}
        onSelectParValue={onSelectParValue}
        onBuyShare={onBuyShare}
        onSellShares={onSellShares}
        controlsDisabled={controlsDisabled}
      />

      {/* Design note #13: the Pass button MOVED OUT of this panel to the
          global action bar at the top of the phase tab (`App.tsx` design
          note #30). Pass and Undo are turn-level actions available in every
          phase, and a second copy here would put two Pass buttons on screen
          -- one of which a player would inevitably learn to ignore. */}
    </div>
  );
}

export default StockRoundPanel;

const styles: Record<string, React.CSSProperties> = {
  /* ---- Corporation roster -- design note #8 ---- */
  /* Design note #11: responsive grid, breakpoint-equivalent without a
   * media query. `auto-fit` + a 300px floor gives 1 column on a narrow
   * window, 2 around tablet width, 3-4 on a desktop and 4 at the 1440px
   * cap -- the same ladder a `grid-cols-1 md:grid-cols-2 xl:grid-cols-4`
   * utility chain expresses, but driven by the space actually available
   * rather than by viewport width. That distinction matters here because
   * these cards sit inside a padded pane, not against the viewport edge,
   * so a viewport-keyed breakpoint would switch a column too early.
   *
   * (Inline styles cannot host `@media` at all -- see `Lobby.tsx` design
   * note #3 on the same limitation for `:disabled` -- so a container-driven
   * `auto-fit` is both the available option and the better one.) */
  rosterGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))",
    gap: "12px",
    // Design note #23: `start`, NOT `stretch`. Stretching was right while
    // every card was permanently expanded and roughly the same height. With
    // the accordion back, one open card stretched all seven collapsed ones
    // to its full height, leaving each of them a small block of content
    // floating in a large empty rectangle -- and worse, that empty space
    // was inside the card, so it LOOKED clickable-but-dead even though the
    // whole card is in fact the hit target.
    //
    // Cards now hug their content. A row of collapsed cards is short and
    // even; the one expanded card is simply taller than its neighbours,
    // which is what an accordion should look like.
    alignItems: "start",
  },
  rosterEmpty: { fontSize: FONT_SIZE.small, color: "#6f7480" },
  /** An unfloated corporation: nothing to trade yet, so dimmer paper. */
  rosterCardUnfloated: { backgroundColor: CARD_SURFACE_MUTED },
  /** The header block, which is the accordion toggle. */
  /* Design note #23: the toggle button IS the collapsed card's whole
   * surface -- `width: 100%` plus the card's own padding means every pixel
   * of the collapsed body, including the gaps between rows, is inside the
   * button and carries its pointer cursor. */
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
  rosterChevron: {
    marginLeft: "auto",
    alignSelf: "center",
    fontSize: FONT_SIZE.small,
    color: CARD_INK_FAINT,
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
  /* Design note #9: paper cards, matching the auction's private-company
   * treatment (`WaterfallAuctionDashboard` design note #15). Same reasoning
   * -- a dark card on a dark panel is a rectangle you have to hunt for, and
   * these eight are the objects the Stock Round is about. Every child
   * colour below is re-derived for dark-on-light; the president row in
   * particular needed a real rework, since its gold-on-near-black was
   * illegible the moment the card went white. */
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
  /* ---- Design note #389: the corporate livery stripe ----
     Negative margins pull it out to the card's own edges and back up under
     the border radius, so it reads as a painted band on the card rather
     than a coloured box sitting inside one -- the card's `padding: 12px
     14px` is cancelled exactly. `overflow: hidden` on the card itself is
     what keeps the square stripe corners inside the 10px radius. */
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
  /** Float status inside the stripe. Outlined in the stripe's own ink
   *  rather than filled, so it reads as a badge without introducing a
   *  third colour onto a band that is already carrying two. */
  rosterLiveryBadge: {
    flexShrink: 0,
    fontSize: FONT_SIZE.micro,
    fontWeight: 800,
    letterSpacing: "0.04em",
    padding: "2px 7px",
    borderRadius: "999px",
    borderWidth: "1px",
    borderStyle: "solid",
    fontVariantNumeric: "tabular-nums",
  },
  rosterTicker: { fontSize: FONT_SIZE.heading, fontWeight: 800, letterSpacing: "0.5px" },
  rosterNameStack: { display: "flex", flexDirection: "column", gap: "1px", minWidth: 0 },
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
  /* ---- Design note #31: the front-face operating snapshot. A bordered
     strip rather than three loose pairs, so it reads as one block of
     "how it operates" distinct from the prices above and the holdings
     below. `flexWrap` because a corporation at its Phase 2 limit can hold
     four chips, which will not sit beside two more cells on a narrow
     card. ---- */
  rosterOpsRow: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "14px",
    paddingTop: "8px",
    marginTop: "2px",
    borderTopWidth: "1px",
    borderTopStyle: "solid",
    borderTopColor: CARD_DIVIDER,
  },
  rosterOpsCell: { display: "flex", flexDirection: "column", gap: "3px", minWidth: 0 },
  rosterOpsTreasury: {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: FONT_SIZE.small,
    fontWeight: 700,
    fontVariantNumeric: "tabular-nums",
    color: CARD_INK,
  },
  rosterOpsLabel: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.05em",
    color: CARD_INK_FAINT,
  },
  rosterPrice: { display: "flex", flexDirection: "column", gap: "1px" },
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
  /* ==================================================================
   *  DESIGN NOTE 378: THE OWNERSHIP TABLE
   * ==================================================================
   *
   * A GRID, not a flex row per line. The old list used
   * `justify-content: space-between`, which pins the name left and the
   * figure right and lets the gap between them vary with the name's
   * length -- so a column of percentages did not line up, which is the one
   * thing a table of numbers exists to do. Fixed tracks put every figure
   * on the same axis whatever the shareholder is called.
   *
   * `rosterHoldings` is GONE with the list it styled. The card back keeps
   * its own condensed layout (design note #27) and its own styles. */
  ownershipTable: {
    display: "flex", flexDirection: "column", gap: "1px",
    borderTopWidth: "1px", borderTopStyle: "solid", borderTopColor: CARD_DIVIDER,
    paddingTop: "7px",
  },
  ownershipRow: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) 46px 46px",
    alignItems: "baseline",
    gap: "6px",
    fontSize: FONT_SIZE.small,
    color: CARD_INK,
    padding: "2px 4px",
    borderRadius: "4px",
  },
  ownershipHeadRow: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) 46px 46px",
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
  ownershipNum: { textAlign: "right", fontVariantNumeric: "tabular-nums" },
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
  // Design note #8: gold + bold, the second of the president's three
  // independent markers.
  rosterHoldingRowPresident: {
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
  rosterYouTag: {
    fontSize: FONT_SIZE.micro, fontWeight: 700, padding: "0 6px",
    borderRadius: "999px", backgroundColor: "#dcecf5", color: "#1c4a63",
  },
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
  autoFloatNote: {
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
  /* Design note #347: neutral grey, deliberately NOT the primary button's
     colour desaturated -- this is a state of the company, not a control
     waiting to become available. */
  cannotAffordNote: {
    fontSize: FONT_SIZE.micro,
    color: "#e8a0a0",
    fontVariantNumeric: "tabular-nums",
  },
  soldOutButton: {
    backgroundColor: "#20242e",
    borderColor: "#343b48",
    color: "#7f8798",
    cursor: "not-allowed",
  },
  /* ---- Slashed sell row (design note #19). Supersedes the five-chip
   * stepper, which had its own bug worth recording: as a non-wrapping flex
   * row the 50% chip overflowed the card border entirely at four columns
   * (flex does not shrink past content, so nothing clipped it -- it just
   * rendered outside). A single inline row of text-weight options cannot
   * overflow the same way because it wraps as text. ---- */
  /* ---- Design note #22: paired numeric rows ---- */
  numericRowPair: { display: "flex", flexWrap: "wrap", gap: "10px", alignItems: "flex-start" },
  numericRowBlock: { display: "flex", flexDirection: "column", gap: "4px", flex: "1 1 auto", minWidth: 0 },
  sellSlashRow: {
    display: "flex",
    // Design note #30: NO WRAP. Five options plus four separators is a
    // fixed, known width -- there is nothing to reflow, and wrapping only
    // ever dropped the trailing "50%" onto a line of its own, which read as
    // a sixth control rather than the fifth. Padding and gap are tightened
    // to buy the width back rather than letting the row break.
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
