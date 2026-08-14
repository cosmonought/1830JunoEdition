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
  /** F-6: the connected wallet, needed to find THIS player's own stake in
   *  `player_holdings` and so bound the sell sizes to what they can actually
   *  cover. `null` when disconnected, which zeroes every option -- correct,
   *  since a disconnected viewer holds nothing to sell. */
  connectedAddress: string | null;
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
          No corporation data yet -- waiting on the first GetGameState response.
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
                    question of where to click. Shared by both paradigms:
                    in A it expands, in C it flips. */}
                <button
                  type="button"
                  onClick={() => onToggleCompany(company.company_id)}
                  aria-expanded={isExpanded}
                  style={styles.rosterCardToggle}
                >
                <div style={styles.rosterCardHeader}>
                  {/* Ticker stays the headline -- it is what the market
                      grid, the ledger and the map token all key off. The
                      canonical name sits underneath at micro size so the
                      card teaches it without competing with it. Stacked in
                      a column because `rosterCardHeader` is a
                      space-between row: adding the name as a sibling would
                      have pushed the float badge off the right edge. */}
                  <span style={styles.rosterNameStack}>
                    <span
                      style={{ ...styles.rosterTicker, color }}
                      title={corporationTitle(company.ticker)}
                    >
                      {company.ticker}
                    </span>
                    {corporationFullName(company.ticker) && (
                      <span style={styles.rosterFullName}>
                        {corporationFullName(company.ticker)}
                      </span>
                    )}
                  </span>
                  {company.is_floated ? (
                    <span
                      style={styles.rosterFloatedBadge}
                      title={
                        metFloatThreshold(company)
                          ? `Floated -- ${soldToPlayersPercent(company)}% sold to players.`
                          : `Auto-floated by the B&O private company, not by reaching ${FLOAT_THRESHOLD_PERCENT}% sold.`
                      }
                    >
                      FLOATED
                    </span>
                  ) : (
                    <span style={styles.rosterUnfloatedBadge}>
                      {soldToPlayersPercent(company)}% / {FLOAT_THRESHOLD_PERCENT}%
                    </span>
                  )}
                </div>

                {/* The two prices, side by side and labelled. Market is the
                    live figure and gets the emphasis; par is what it floated
                    at and is the reference point for judging it. */}
                <div style={styles.rosterPriceRow}>
                  <div style={styles.rosterPrice}>
                    <span style={styles.rosterPriceValue}>{market === null ? "--" : market}</span>
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
                    flipping the card -- which is exactly the moment a
                    player is choosing between eight of them and least
                    wants to flip each one. Whether a company is one
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
                    <LastRoutePayout surface="light" compact />
                  </div>
                </div>

                {/* Holdings table. */}
                <div style={styles.rosterHoldings}>
                  {holdings.length === 0 ? (
                    <span style={styles.rosterNoHoldings}>No shares held by players</span>
                  ) : (
                    holdings.map((holding) => (
                      <div
                        key={holding.address}
                        style={{
                          ...styles.rosterHoldingRow,
                          ...(holding.isPresident ? styles.rosterHoldingRowPresident : {}),
                        }}
                      >
                        <span style={styles.rosterHoldingName}>
                          {holding.isPresident && (
                            <span title="President -- controls this corporation" aria-label="President">
                              👑
                            </span>
                          )}
                          {playerLabel?.(holding.address) ?? truncateHolder(holding.address)}
                          {holding.isSelf && <span style={styles.rosterYouTag}>you</span>}
                        </span>
                        <span style={styles.rosterHoldingPercent}>
                          {holding.percentage}%
                          <span style={styles.rosterCertCount}>
                            {" "}
                            ({certificateCount(holding.percentage, holding.isPresident)} cert
                            {certificateCount(holding.percentage, holding.isPresident) === 1 ? "" : "s"})
                          </span>
                        </span>
                      </div>
                    ))
                  )}
                </div>

                <div style={styles.rosterPoolRow}>
                  <span>IPO {company.ipo_pool_percentage}%</span>
                  <span>Bank Pool {company.bank_pool_percentage}%</span>
                </div>

                {/* Float bar, in the COLLAPSED body and only while unfloated
                    -- design note #17. It answers "is this close to
                    floating?", which is a question you ask while scanning
                    cards, so burying it behind an expand was wrong. And once
                    a company HAS floated the bar is a permanent 100% that
                    says nothing the FLOATED badge above has not already said,
                    so it is removed entirely rather than pinned full. */}
                {!company.is_floated && (
                  <div style={styles.floatBlock}>
                    <div style={styles.floatBarTrack}>
                      <div
                        style={{
                          ...styles.floatBarFill,
                          width: `${Math.min(100, soldToPlayersPercent(company))}%`,
                        }}
                      />
                      <div
                        style={{ ...styles.floatBarThreshold, left: `${FLOAT_THRESHOLD_PERCENT}%` }}
                        title="60% float threshold"
                      />
                    </div>
                    <span style={styles.floatBarCaption}>
                      {soldToPlayersPercent(company)}% sold &middot; {FLOAT_THRESHOLD_PERCENT}% to float
                    </span>
                  </div>
                )}

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
              marketPrice={market}
              connectedAddress={connectedAddress}
              parValue={parValue}
              onSelectParValue={onSelectParValue}
              onBuyShare={onBuyShare}
              onSellShares={onSellShares}
              controlsDisabled={controlsDisabled}
            />
          );

          /* ---- Option C: 3D flip -- design note #26 -------------------
             The outer element owns `perspective` (a child cannot give
             itself one) and a FIXED height, because both faces are
             absolutely positioned and so contribute nothing to layout.
             `backfaceVisibility: hidden` on each face is what stops the
             mirrored reverse showing through mid-rotation. */
          if (USE_FLIP_UI) {
            return (
              <div key={company.company_id} style={styles.flipViewport}>
                <div
                  style={{
                    ...styles.flipInner,
                    transform: isExpanded ? "rotateY(180deg)" : "rotateY(0deg)",
                  }}
                >
                  <div
                    style={{
                      ...styles.flipFace,
                      ...styles.rosterCard,
                      ...(company.is_floated ? {} : styles.rosterCardUnfloated),
                      borderColor: CARD_BORDER,
                    }}
                  >
                    {cardFace}
                  </div>
                  {/* Design note #27: the WHOLE back flips too, and there is
                      no "back to data" arrow. The card is the control; a
                      dedicated return button is a second, smaller target for
                      something the entire surface already does.

                      The catch this creates, and how it is handled: a click
                      anywhere would also flip while the player is operating
                      the buy/sell controls INSIDE the back. So the actions
                      are wrapped in a `stopPropagation` guard -- clicks on
                      real controls act and stay put; clicks on the back's
                      dead space flip home. Without that guard, picking a
                      sell size would spin the card away mid-decision. */}
                  <div
                    onClick={(event) => {
                      // Design note #27: a click that landed on an actual
                      // control is that control's; anything else flips.
                      if ((event.target as HTMLElement).closest("button, input, select, label")) {
                        return;
                      }
                      onToggleCompany(company.company_id);
                    }}
                    role="button"
                    tabIndex={-1}
                    style={{
                      ...styles.flipFace,
                      ...styles.flipFaceBack,
                      ...styles.rosterCard,
                      borderColor: CARD_BORDER_ACTIVE,
                      cursor: "pointer",
                    }}
                  >
                    <div style={styles.flipBackHeader}>
                      <span
                        style={{ ...styles.rosterTicker, color }}
                        title={corporationTitle(company.ticker)}
                      >
                        {company.ticker}
                      </span>
                      <span style={styles.flipBackPrices}>
                        ${market === null ? "--" : market} mkt &middot; ${company.par_value ?? "--"} par
                      </span>
                    </div>

                    {/* Design note #27: INFORMATION CONTINUITY. A condensed
                        holdings list and the pool counts, so the numbers a
                        buy/sell decision depends on are still on screen
                        while the decision is being made. */}
                    <div style={styles.flipBackHoldings}>
                      {holdings.length === 0 ? (
                        <span style={styles.rosterNoHoldings}>No shares held by players</span>
                      ) : (
                        holdings.map((holding) => (
                          <div
                            key={holding.address}
                            style={{
                              ...styles.flipBackHoldingRow,
                              ...(holding.isPresident ? styles.rosterHoldingRowPresident : {}),
                            }}
                          >
                            <span style={styles.rosterHoldingName}>
                              {holding.isPresident && <span aria-label="President">&#128081;</span>}
                              {playerLabel?.(holding.address) ?? truncateHolder(holding.address)}
                              {holding.isSelf && <span style={styles.rosterYouTag}>you</span>}
                            </span>
                            <span style={styles.rosterHoldingPercent}>{holding.percentage}%</span>
                          </div>
                        ))
                      )}
                      <div style={styles.rosterPoolRow}>
                        <span>IPO {company.ipo_pool_percentage}%</span>
                        <span>Bank Pool {company.bank_pool_percentage}%</span>
                      </div>
                    </div>

                    {/* Design note #27 (revised): the guard sits on the
                        CONTROLS, not on the whole actions container.
                        Wrapping the container meant its padding, its
                        section labels and every gap between rows swallowed
                        the click too -- so in practice only the thin header
                        strip at the very top of the card flipped it back,
                        which is the reported bug.

                        `closest("button, input, select, label")` lets a
                        click on a real control act and stay put, while a
                        click on any dead space -- inside the actions block
                        or anywhere else on the back -- flips home. */}
                    <div style={styles.flipBackScroll}>{cardActions}</div>
                  </div>
                </div>
              </div>
            );
          }

          /* ---- Option A: accordion (default) ---- */
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
              {isExpanded && cardActions}
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
        <div style={styles.sourceToggleRow}>
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
                  ...styles.sourceToggle,
                  ...(source === option && available ? styles.sourceToggleActive : {}),
                  // Inline styles cannot express `:disabled` (Lobby.tsx
                  // design note #3), so the disabled look is computed.
                  ...(available ? {} : styles.sourceToggleEmpty),
                }}
                disabled={controlsDisabled || !available}
                title={
                  available
                    ? undefined
                    : option === "Ipo"
                      ? "The IPO Warehouse is empty."
                      : "The Bank Pool is empty."
                }
                onClick={() => setSource(option)}
              >
                {option === "Ipo" ? "From IPO" : "From Bank Pool"}
              </button>
            );
          })}
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
              Brown zone -- up to {multiBuyMax} from the Bank Pool
            </span>
          </div>
        )}

        <button
          type="button"
          style={styles.actionButton}
          onClick={() =>
            onBuyShare(company.company_id, source, multiBuyMax > 1 ? effectiveQuantity : 1)
          }
          disabled={controlsDisabled || availableSources.length === 0}
        >
          {/* Design note #35: one computed label, so the price cannot
              disappear depending on which branch built the string. */}
          {buyLabel}
        </button>
      </div>

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
            controls. Hidden outright instead. */}
        {playerHoldingPercent > 0 && (
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

/* ==================================================================== */
/*  DESIGN NOTE 26: OPTION A vs OPTION C -- THE CARD PARADIGM TEST      */
/* ==================================================================== */
//
// Two ways of fitting ~20 controls per corporation onto a screen holding
// eight of them, built side by side so they can be compared on the real
// thing rather than argued about.
//
//   A (false)           ACCORDION. Cards hug their content; the whole
//                       collapsed surface toggles open. Cheap to scan --
//                       every card's data is visible at once -- and one
//                       click to act. Cost: the open card pushes its row
//                       taller, so the grid reflows as you work.
//   C (true, DEFAULT)   3D FLIP. Front is data, back is actions, joined by
//                       a `rotateY` on a shared fixed-size frame. The grid
//                       NEVER reflows, because a flipped card occupies
//                       exactly the space it did before. Cost: front and
//                       back can never be seen together, so you cannot
//                       check a holding while choosing a sell size -- and
//                       a fixed frame means the tallest card's height is
//                       imposed on all eight.
//
// UPDATE: C is now the default, and its one real cost -- losing sight of the
// data while acting -- is addressed rather than accepted: the BACK carries a
// condensed copy of the holdings and the IPO/Bank counts, so a player
// choosing a sell size can still see what they hold. That is the whole
// reason the back is worth building; a flip that hides the numbers you are
// deciding with is a worse accordion.
//
// The honest summary is that A optimises for comparison and C optimises for
// layout stability, and which matters more is a judgement about how the
// screen is actually used -- which is why this is a flag rather than a
// decision made in the abstract.
//
// IMPLEMENTATION NOTE: both share ONE `CompanyActions` and one card-face
// renderer. The flag chooses the WRAPPER only. Building two independent
// card components would have doubled every future fix and let the two
// paradigms drift apart, which would make the comparison meaningless.

/** Flip the paradigm. `false` = Option A (accordion), `true` = Option C. */
const USE_FLIP_UI = true;

/** Option C only: the fixed frame height both faces share. A flip card
 *  cannot size to content -- the two faces are absolutely positioned on top
 *  of each other, so the frame needs a height before either is measured. */
const FLIP_CARD_HEIGHT_PX = 460;

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
      reason: `You hold ${playerHoldingPercent}% -- not enough for a ${percentage}% bundle`,
    };
  }
  const poolRoom = Math.max(0, BANK_POOL_CAP_PERCENT - bankPoolPercent);
  if (percentage > poolRoom) {
    return {
      enabled: false,
      reason:
        `Bank Pool is at ${bankPoolPercent}% and caps at ${BANK_POOL_CAP_PERCENT}% -- ` +
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
  connectedAddress,
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
        {!isMyTurn && <span style={styles.headerHint}>Waiting for your turn...</span>}
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
    cursor: "pointer",
    textAlign: "left",
    font: "inherit",
    color: CARD_INK,
    boxShadow: "0 3px 12px rgba(0,0,0,0.4)",
  },
  rosterCardHeader: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" },
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
  sourceToggleEmpty: { opacity: 0.4, cursor: "not-allowed" },
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
  rosterHoldings: {
    display: "flex", flexDirection: "column", gap: "2px",
    borderTopWidth: "1px", borderTopStyle: "solid", borderTopColor: CARD_DIVIDER,
    paddingTop: "7px",
  },
  rosterNoHoldings: { fontSize: FONT_SIZE.small, color: CARD_INK_FAINT, fontStyle: "italic" },
  rosterHoldingRow: {
    display: "flex", alignItems: "baseline", justifyContent: "space-between",
    gap: "8px", fontSize: FONT_SIZE.small, color: CARD_INK,
    padding: "2px 4px", borderRadius: "4px",
  },
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
  rosterCertCount: { color: CARD_INK_FAINT, fontWeight: 400 },
  rosterPresidentLine: { fontSize: FONT_SIZE.micro, fontWeight: 700, color: "#7a5c08" },
  /* ---- Option C: 3D flip (design note #26) ----
   * `perspective` lives on the VIEWPORT, not the rotating element: a
   * transformed element cannot supply its own perspective, and without one
   * `rotateY` degenerates into a flat horizontal squash with no depth.
   * The fixed height is unavoidable -- both faces are `position: absolute`
   * and contribute nothing to layout, so the frame has to be told a size. */
  flipViewport: {
    perspective: "1400px",
    height: `${FLIP_CARD_HEIGHT_PX}px`,
  },
  flipInner: {
    position: "relative",
    width: "100%",
    height: "100%",
    transformStyle: "preserve-3d",
    transition: "transform 0.5s cubic-bezier(0.2, 0.7, 0.2, 1)",
  },
  flipFace: {
    position: "absolute",
    inset: 0,
    display: "flex",
    flexDirection: "column",
    // Without this the mirrored reverse of the other face shows through
    // during the middle of the rotation.
    backfaceVisibility: "hidden",
    WebkitBackfaceVisibility: "hidden",
    overflow: "hidden",
    boxSizing: "border-box",
  },
  /** Pre-rotated so it faces outward once the frame turns 180deg. */
  flipFaceBack: { transform: "rotateY(180deg)" },
  flipBackHeader: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: "8px",
    width: "100%",
  },
  flipBackPrices: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 700,
    color: CARD_INK_MUTED,
    fontVariantNumeric: "tabular-nums",
  },
  /** Design note #27: condensed holdings on the back. Capped and scrolling
   *  so a six-holder company cannot push the actions off a fixed frame. */
  flipBackHoldings: {
    display: "flex",
    flexDirection: "column",
    gap: "2px",
    maxHeight: "132px",
    overflowY: "auto",
    paddingTop: "6px",
    marginTop: "6px",
    borderTopWidth: "1px",
    borderTopStyle: "solid",
    borderTopColor: CARD_DIVIDER,
  },
  flipBackHoldingRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "8px",
    fontSize: FONT_SIZE.micro,
    color: CARD_INK,
    padding: "1px 4px",
    borderRadius: "4px",
  },
  /** The back can overflow its fixed frame on a company with many controls,
   *  so it scrolls rather than clipping them away. */
  flipBackScroll: { flex: "1 1 auto", overflowY: "auto", minHeight: 0, marginTop: "8px" },

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
  floatBlock: { display: "flex", flexDirection: "column", gap: "3px", marginTop: "2px" },
  floatBarTrack: {
    position: "relative",
    width: "100%",
    height: "10px",
    borderRadius: "999px",
    backgroundColor: "#0a0e17",
    border: "1px solid #2a2e3a",
    overflow: "hidden",
  },
  floatBarFill: {
    height: "100%",
    backgroundColor: "#3a7bd5",
  },
  floatBarThreshold: {
    position: "absolute",
    top: 0,
    bottom: 0,
    width: "2px",
    backgroundColor: "#e0c341",
  },
  floatBarCaption: {
    fontSize: FONT_SIZE.small,
    color: "#9aa0ac",
  },
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
  sourceToggleRow: {
    display: "flex",
    gap: "6px",
  },
  sourceToggle: {
    fontSize: FONT_SIZE.small,
    fontWeight: 600,
    padding: "6px 10px",
    borderRadius: "6px",
    border: "1px solid #3a3f4b",
    backgroundColor: "#1e2129",
    color: "#c7cbd4",
    cursor: "pointer",
  },
  sourceToggleActive: {
    backgroundColor: "#2a3a52",
    borderColor: "#4a6a92",
    color: "#e6e8ef",
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
