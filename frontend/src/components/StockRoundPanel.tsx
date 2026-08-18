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

import PresidentCrown from "./PresidentCrown";
import React, { useEffect, useRef, useState } from "react";
import type {
  PrivateCompanyState,
  PublicCompanyState,
  RoundType,
} from "../utils/gameState";
import type { GamePhase, TierRustOutlook, TrainTier } from "../utils/gamePhase";
// Design note #409: `TrainChips` is back -- inline in the asset row, not in
// the stacked cell design note #393 removed. `CapacityPill` and
// `LastRoutePayout` stay out: the train LIMIT is about the next purchase (an
// Operating Round question) and the payout now rides in the livery stripe
// (design note #392).
import { TrainChips } from "./TrainBadges";
// Design note #410: the corporate herald, shared with the action panel.
import { CorporateLogo } from "./CorporateLogo";
import {
  allowsMultipleBankPoolBuys,
  marketZoneForPrice,
  PAR_BOX_PRICES,
} from "./StockMarketRenderer";
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
  /** Design note #464: the round, so the card order is recomputed at the
   *  Operating Round boundary and held through the Stock Round. */
  roundType: RoundType | null;
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
// is marked two ways at once, deliberately redundantly: a bold gold row and
// the word "President" spelled out. Colour alone would fail a colourblind
// player; the word alone is easy to skim past in a dense table, which is why
// it is set as a tag rather than as running text.
//
// A CROWN GLYPH WAS THE THIRD CHANNEL and design note #490 removed it with
// the rest of the card's emoji. It was the weakest of the three: an emoji
// renders in the platform's own colour font at its own weight, ignoring
// `color` and `fontWeight`, so it could not be tuned to sit with the
// typography around it -- and a channel that cannot be styled to match the
// table it is in is decoration wearing an accessibility argument.
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
  onSellShares,
  controlsDisabled,
  tradingOpen,
}: {
  publicCompanies: readonly PublicCompanyState[];
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
  /** Design note #417: `false` outside a Stock Round -- each card then
   *  renders no trading controls at all. */
  tradingOpen: boolean;
}) {
  /* ==================================================================
   *  DESIGN NOTE 464: RECOMPUTED AT THE OPERATING ROUND BOUNDARY
   * ==================================================================
   *
   * `null` until the first Operating Round establishes an order, which
   * leaves the roster in the contract's own table order -- a neutral
   * starting arrangement rather than one that reshuffles as the opening
   * Stock Round's first companies float.
   *
   * The effect fires on the TRANSITION into an Operating Round, not while
   * one is in progress: `prevRoundRef` is what makes it an edge rather than
   * a level, so a poll landing mid-round cannot re-sort the cards under a
   * player who is reading them.
   */
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
        {/* ==================================================
             DESIGN NOTE 464 (supersedes #446): THE ORDER IS HELD
            ==================================================

             Design note #446 sorted floated companies to the front on every
             render. Right about the order, wrong about the moment: a Stock
             Round is where a player USES these cards, and buying is what
             causes floats -- so the act of using the screen rearranged it
             under them.

             `cardOrder` is recomputed only when an Operating Round begins
             (see `utils/corporationCardOrder.ts`), and held until the next
             one. `applyCardOrder` just files the live roster into it. */}
        {applyCardOrder(publicCompanies, cardOrder).map((company) => {
          const color = tickerColor(company.company_id);
          /* Design note #447: `last_route_revenue` is OPTIONAL on the
             contract response, and `gameState.ts` is explicit that
             `undefined` means "this build cannot tell you" while "0" means
             "it earned nothing". A company that has never operated reports
             "0" too, so the honest test for "is there a run to report" is
             a positive figure -- anything else shows a dash rather than
             asserting a $0 payout that may never have happened. */
          const hasRunRoutes = (Number(company.last_route_revenue ?? 0) || 0) > 0;
          // Design note #389: derived from the fill, so every corporation's
          // stripe is legible without a per-company decision.
          const liveryInk = bestContrastTextColor(color);
          /* Design note #393: `owned_trains` is nullable on the wire and the
             badges this row replaced absorbed that internally. Normalised
             once here rather than guarded at each of the three reads. */
          const trains = company.owned_trains ?? [];
          /* Design note #490: `tokensPlaced` is gone. It existed only to
             fill the tooltip the icons needed ("Station tokens: 2 of 4
             placed on the map"), and `StationTokenRow` has always drawn
             that same fact as circles -- so the count was a second, worse
             rendering of the row sitting beside it, kept alive by the
             caption mechanism this pass removes. */
          /* Design note #395: the same predicate `corporationPrivateCompanies`
             applies -- open, and held by THIS corporation. Filtered here
             rather than imported because that helper takes a whole
             `GameStateResponse` and this panel is given only the roster. */
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
                {/* Design note #16/#26: the ENTIRE surface is the toggle --
                    ticker, prices, holdings, pools, all of it. A caret is a
                    ~20px target on a ~300px card that is itself the thing
                    being chosen; making the card the target removes the
                    question of where to click. Design note #396: what the
                    click now does is make this card ACTIVE -- clicking the
                    active card again deactivates it, so there is always a
                    way back to a board with no controls on it at all. */}
                <button
                  type="button"
                  onClick={() => onActivateCompany(isActive ? null : company.company_id)}
                  aria-expanded={isActive}
                  aria-label={`${company.ticker} — ${isActive ? "hide" : "show"} share actions`}
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
                    says "exactly match", and design note #428 is finally the
                    mechanism for it: ONE table in
                    `styles/corporationLivery.ts` that this file, the market
                    chart and the map all import. This sentence used to
                    describe an intention -- there were three hand-kept
                    copies at the time it was written.

                    THE INK IS COMPUTED, NOT CHOSEN. `bestContrastTextColor`
                    is the same helper the map's station tokens use to put an
                    acronym on an arbitrary corporate fill.

                    TD-3: THE EXAMPLES WERE STALE, and stale in the worst
                    way -- they argued the opposite of the live palette. This
                    read "hard-coding white would fail on C&O's amber
                    (#d68910); hard-coding black would fail on CPR's purple".
                    Design note #408 replaced the whole palette with the
                    physical board's: C&O is now `#5bc8e8` CYAN, which is
                    light and therefore takes BLACK ink -- so the old
                    sentence cited it as a case against the very choice it
                    now needs. CPR is `#7b4a22` brown, not purple.

                    The live cases, checked against the table rather than
                    remembered: hard-coding white fails on ERIE's yellow
                    (`#f5cd3a`), which needs black; hard-coding black fails
                    on B&O's dark blue (`#12408f`), which needs white. Three
                    of the eight take black and five take white, so any fixed
                    choice is wrong for at least three corporations.

                    Deriving it per colour means a corporation added later is
                    legible by construction rather than by someone
                    remembering to check -- and, as this correction shows, by
                    someone remembering to re-check the COMMENT when the
                    palette moves under it. */}
                <div style={{ ...styles.rosterLivery, backgroundColor: color, color: liveryInk }}>
                  {/* ==================================================
                       DESIGN NOTE 501: THE MARK AND THE HANDLE, ONE LINE
                      ==================================================

                       REPORTED: put the herald and the acronym on the same
                       line horizontally instead of stacking them.

                       `rosterNameStack` is a COLUMN, and design note #465
                       added the acronym as its second child -- so "beside
                       the logo", which is what that note asked for and what
                       its own text says ("the acronym rides next to it"),
                       came out underneath it. The note and the layout have
                       disagreed since the day it shipped.

                       The stack keeps its column for the FULL NAME, which
                       genuinely belongs on its own line: it is the thing you
                       read second, it is long enough to need the card's
                       whole width, and it already ellipsises. What changes
                       is that the two SHORT identifiers -- the mark and the
                       handle for the same company -- now share the line they
                       were always described as sharing. */}
                  <span style={styles.rosterNameStack}>
                    <span style={styles.rosterIdentityRow}>
                    {/* Design note #410: the historical herald replaces the
                        acronym. 26px against a stripe whose text content is
                        ~33px tall, so it sits INSIDE the existing height
                        rather than setting a new one -- the row does not
                        grow. The fallback keeps the old typography exactly,
                        so a missing file is indistinguishable from the
                        previous design rather than being a visible hole. */}
                    <CorporateLogo
                      ticker={company.ticker}
                      size={26}
                      color={liveryInk}
                      title={corporationTitle(company.ticker)}
                      fallbackStyle={styles.rosterLiveryTicker}
                    />
                    {/* ==================================================
                         DESIGN NOTE 465: THE ACRONYM COMES BACK
                        ==================================================

                         REPORTED: put the corporation's acronym immediately
                         to the right of its logo for quick readability.

                         Design note #410 replaced the acronym WITH the
                         herald, and the trade was not even: a herald is
                         unmistakable once you know it and unreadable until
                         you do. Eight historical marks a new player has
                         never seen are eight things to learn before the
                         roster can be scanned, and the full name beside
                         them is too long to serve as the quick label -- it
                         is what you read second.
                         "PRR" is what a player says out loud and what every
                         other surface in this app calls the company.

                         BESIDE, NOT INSTEAD. The herald keeps its place and
                         its recognisability; the acronym rides next to it
                         as the readable handle. `CorporateLogo`'s text
                         fallback still renders the ticker when a file is
                         missing, which would double it -- but only in the
                         failure case, and a doubled ticker is a better
                         failure than a nameless card. */}
                      <span style={styles.rosterLiveryAcronym}>{company.ticker}</span>
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
                  {/* ==================================================
                       DESIGN NOTE 392: THE PAYOUT RIDES IN THE STRIPE
                      ==================================================

                      REPORTED: move the Last Payout value into the top
                      coloured header, opposite the abbreviation.

                      It was one of four stacked label/value cells below,
                      each spending a caption line on a single figure. Last
                      payout is the one of the four a share buyer weighs
                      most directly -- it is what the corporation last
                      handed its shareholders -- and the stripe had unused
                      width on the right.

                      NOT the same thing as the float badge beside it: the
                      badge says whether the company is trading at all, the
                      payout says what it paid when it did. Both are
                      one-glance facts about whether the share is worth
                      buying, which is why they share the row a player
                      reads first. */}
                  {/* ==================================================
                       DESIGN NOTE 447: THE PAYOUT LEAVES THE STRIPE
                      ==================================================

                       REPORTED: the "$0" floats awkwardly beside the logo.

                       Design note #392 put it here on the reasoning that
                       "the stripe had unused width on the right" and that
                       last payout is a one-glance fact about whether the
                       share is worth buying. The second half is true; the
                       first was a layout observation that stopped holding
                       the moment the herald replaced the acronym (design
                       note #410). A bare figure now sits next to a logo,
                       aligned to nothing, with no caption -- so it reads as
                       part of the corporation's identity rather than as a
                       number, and "$0" beside a herald looks like an error.

                       It moves to the value row below, where it lines up
                       with Market and Par under a caption. Three labelled
                       figures in a row is a table; one unlabelled figure
                       floating beside a logo is a smudge. */}
                  {/* ==================================================
                       DESIGN NOTE 488: THE STRIPE CARRIES ONE FACT NOW
                      ==================================================

                       Design note #465 put Last Run in this slot, on the
                       reasoning that the "Floated" badge it replaced was
                       restating a permanent fact and the slot was already
                       captioned by position. The first half still holds.
                       The second does not: "captioned by position" means
                       captioned by nothing, and a figure beside a herald
                       reads as part of the corporation's identity -- which
                       is the objection #465 inherited from #447 and only
                       half solved.

                       Last Run moves down to the stat row, where Market and
                       IPO/Par already sit under real captions. Four
                       captioned figures in one line is a table; three in a
                       table plus one in the letterhead is not.

                       WHAT STAYS HERE is float PROGRESS -- "40% / 60%" --
                       which is the one fact about this corporation that is
                       neither a price nor permanent, and which disappears
                       the moment it is answered. An unfloated corporation
                       has no market price, no last run and no treasury
                       worth reading, so the stripe is where the only live
                       number it has belongs. A floated one leaves the slot
                       empty, and an empty slot is not a badge -- which was
                       #465's actual objection. */}
                  {/* ==================================================
                       DESIGN NOTE 503: ONE SLOT, TWO LIVES
                      ==================================================

                       REPORTED: Last Run must completely REPLACE the float
                       badge on the livery stripe once a corporation floats,
                       rather than sitting as its own column in the stats row.

                       This reverses design note #488, which moved Last Run
                       down to the stats row, and #488's objection deserves an
                       answer rather than a silent revert. It said: a bare
                       figure beside a herald is "captioned by position", and
                       captioned by position means captioned by nothing.

                       That was true of the version it was describing -- a
                       naked "$180" floating next to the logo, which is also
                       what design note #447 objected to before it. It is not
                       true of this one. The figure goes in the BADGE, with
                       the badge's border and an explicit "LAST RUN" caption
                       inside it, so it reads as a labelled statistic in a
                       slot rather than as part of the corporation's name.

                       WHY THE SLOT IS THE RIGHT HOME. The two facts are
                       mutually exclusive in time and identical in role: an
                       unfloated corporation's one live number is how close it
                       is to floating; a floated one's is what it last earned.
                       Neither exists while the other does. A slot that holds
                       exactly one of them is the shape of the data -- which
                       is also why #488's "empty slot" complaint disappears:
                       the slot is never empty now.

                       "--" NOT "$0" for a corporation that has never run.
                       Design note #465's distinction, kept verbatim through
                       three passes because it keeps being right: `"0"` is
                       reported both by a corporation that earned nothing and
                       by one that has never turned a wheel, and a dash is the
                       only honest way to say the second. */}
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
                  {/* Design note #502: the `$`. Treasury has carried one
                      since it joined this row (design note #489) and these
                      two did not, so one line held three figures in dollars
                      of which only the rightmost said so. The dash keeps its
                      bare form deliberately -- "$--" would put a currency on
                      an absent value. */}
                  <div style={styles.rosterPrice}>
                    <span style={styles.rosterPriceValue}>
                      {company.par_value === null || market === null ? "--" : `$${market}`}
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
                  {/* ==================================================
                       DESIGN NOTE 489: TREASURY BELONGS WITH THE MONEY
                      ==================================================

                       REPORTED: move Treasury up onto the row with Market,
                       IPO/Par and Last Run, flush right.

                       It was on the asset row below, between a coin emoji
                       and a row of train chips -- filed with what the
                       corporation OWNS. That is a defensible taxonomy and
                       the wrong one for a share buyer: treasury is a
                       FIGURE IN DOLLARS, and the three figures in dollars
                       it should be compared against were on the line above
                       it. A player judging whether a corporation can afford
                       a train was reading its cash in a different row, a
                       different type size and a different alignment from
                       every other number on the card.

                       FLUSH RIGHT, not fourth in the line, and the
                       distinction matters. Market, IPO/Par and Last Run are
                       PER-SHARE facts that read left to right as a
                       sequence; treasury is the corporation's own money and
                       belongs to a different question. `marginLeft: auto`
                       pushes it to the far edge so the row reads as three
                       related figures and one balance, which is what it is.

                       It also keeps the row honest at every card width: the
                       auto margin absorbs the slack rather than letting
                       four evenly-spaced columns drift apart on a wide
                       card. */}
                  <div style={{ ...styles.rosterPrice, ...styles.rosterTreasury }}>
                    <span style={styles.rosterPriceValue}>${company.treasury}</span>
                    <span style={styles.rosterPriceLabel}>treasury</span>
                  </div>
                </div>

                {/* ==================================================
                     DESIGN NOTE 393: ONE LINE OF ASSETS
                    ==================================================

                    REPORTED: condense Treasury, Trains and Station Tokens
                    into a single tightly packed inline row with minimal
                    icons, and strip out the bulky badges and stacked
                    labels.

                    Design note #31 put this data on the front for a reason
                    that still holds -- whether a corporation is one
                    purchase from losing its trains changes what a share is
                    worth before you look at the price. What it got wrong
                    was the FORMAT: four cells, each with a caption line
                    above a value, plus `TrainChips` and `CapacityPill`
                    rendering pill-shaped badges with their own padding and
                    borders. Four captions and two badge sets, times eight
                    cards, to say three numbers.

                    THE ICONS ARE THE CAPTIONS. A coin, a locomotive and a
                    marker are unambiguous in context and cost no line of
                    their own, so the row is one line instead of five. Each
                    carries a `title` with the words spelled out, because an
                    icon that is obvious to a returning player is not
                    obvious to a new one and a tooltip is free.

                    WHAT WAS LOST, AND WHY IT CAME BACK (design note #409):
                    this note argued that `TrainChips`' per-train rust
                    colouring could go, because "on a Stock Round card the
                    question is what does it own". That was wrong, and the
                    error is visible in this same note's own second
                    paragraph, which had already said the opposite: whether
                    a corporation is one purchase from losing its trains
                    changes what a share is worth BEFORE you look at the
                    price. Rust is not an Operating Round detail a share
                    buyer can look up later -- it is the difference between
                    a fleet and a pile of scrap, and the Stock Round is
                    exactly when it is being priced.

                    So the chips are back, INLINE. What #393 was actually
                    right about was the LAYOUT -- four stacked caption/value
                    cells -- and none of that returns. `TrainChips` renders
                    as an inline-flex row of pills (`chipRow`), so it drops
                    into this line beside the coin and the token count
                    without adding a row of its own.

                    `CapacityPill` stays gone. The train LIMIT is a rule
                    about what the corporation may buy NEXT, which is an
                    Operating Round decision; the rust colouring is about
                    what it owns NOW, which is the share price. Restoring
                    the one that was wrongly dropped is not a reason to
                    restore the other.

                    STATION TOKENS as placed-over-limit, which neither of
                    the old cells showed at all -- `CapacityPill` was about
                    TRAINS. A corporation with 2 of 3 tokens down has one
                    more city it can claim, and that is a real input to a
                    share decision that the old row simply omitted. */}
                {/* ==================================================
                     DESIGN NOTE 490: THE WORDS, NOT THE PICTOGRAMS
                    ==================================================

                     REPORTED: the cards lean on emojis and tooltips and are
                     hard to read. Write "Trains" and "Stations" out beside
                     their values.

                     Design note #393 put a coin, a locomotive and a marker
                     here and argued "THE ICONS ARE THE CAPTIONS... they
                     cost no line of their own", with a `title` on each
                     spelling out the words. Both halves were wrong in the
                     same way, and the second is the worse one.

                       AN EMOJI IS NOT TYPOGRAPHY. It renders in whatever
                       colour font the platform ships, at whatever weight,
                       ignoring `color`, `fontWeight` and the type scale
                       entirely -- so the one element in the row that was
                       supposed to be a caption is the only one that cannot
                       be styled to look like one. Three saturated
                       pictograms on a card whose whole palette is ink on
                       cream also out-shout the numbers they label.

                       A TOOLTIP IS NOT A LABEL. It requires a pointer, a
                       hover and a wait, and it is unreachable on touch. The
                       words were "free" only in the sense that they cost
                       nothing to a reader who never sees them.

                     `TrainChips` and `StationTokenRow` are still the values
                     -- both carry information a count cannot (rust
                     proximity, which token costs what) and neither is
                     replaced. Only the captions change, from pictogram to
                     word.

                     TREASURY IS GONE FROM THIS ROW ENTIRELY -- design note
                     #489 moved it up with the other dollar figures, which
                     is also what made room for two spelled-out labels
                     without the line wrapping. */}
                {/* ==================================================
                     DESIGN NOTE 504: CAPTION UNDER VALUE, BOTH ROWS
                    ==================================================

                     REPORTED: put the "Trains" and "Stations" labels
                     underneath their chips, mirroring how Market, IPO/Par
                     and Treasury sit under their values.

                     Design note #490 replaced the pictograms with words,
                     correctly, and put them BESIDE the values because the
                     row it inherited was a single inline line. So the card
                     ended up captioning its two rows two different ways:
                     value-over-label on the price row, label-then-value on
                     the asset row. A reader scanning down the card met the
                     same relationship expressed twice in opposite orders.

                     `assetItem` becomes a column and the label moves after
                     the value, which is `rosterPrice`'s exact shape -- the
                     two rows now share one grammar rather than resembling
                     each other.

                     THE LABEL STAYS `assetLabel`, not `rosterPriceLabel`.
                     Design note #490 already tuned it to match that caption
                     treatment (uppercase, faint, tracked); what was wrong
                     was its POSITION, and swapping the style as well would
                     change the type scale of a caption sitting under a chip
                     row rather than under a number. */}
                <div style={styles.assetRow}>
                  <span style={styles.assetItem}>
                    {/* Design note #409: the real chips, with the rust
                        colouring a share buyer is pricing. `compact` and the
                        light surface, matching the Operating Round's own
                        rendering so the two screens cannot disagree about
                        which tier is about to rust.

                        Design note #490: the empty case gets WORDS too. An
                        absent chip row beside the label "Trains" says
                        nothing; "none" says the corporation owns none, which
                        is the fact that decides whether it is about to be
                        forced into an emergency purchase. */}
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
                  {/* ==================================================
                       DESIGN NOTE 424: THE CAPACITY, DRAWN
                      ==================================================

                      REPORTED: replace the plain "n of 4 stations placed"
                      text on the stock cards with the visual token row the
                      Action Panel already uses -- the Home, $40 and $100
                      circles.

                      `2/4` is a count, and a count is the least of what a
                      player wants here. The row it replaces is the same
                      component the Operating Round strip renders
                      (`StationTokenRow`, design note #362), and it answers
                      three questions the fraction cannot: which tokens are
                      spent, where the home one sits, and -- the one that
                      decides a purchase -- what the NEXT one costs. A
                      corporation with two placed is looking at $100 for its
                      third, and `2/4` does not say so.

                      THE SAME COMPONENT, NOT A SECOND ONE THAT LOOKS LIKE
                      IT. Both surfaces describe one corporation's
                      allowance, and this file has been bitten before by two
                      renderers of one fact drifting apart (design note #423,
                      one screen over). `stationTokenSlots` is the same
                      derivation the action bar feeds it.

                      THE INKS ARE THE CARD'S, NOT THE BAR'S. `StationTokenRow`
                      takes its ring and caption colours as props precisely
                      because it sits on two different surfaces: the action
                      bar's corporate livery, and this card's light paper.
                      Passing the card palette's own inks is what keeps the
                      circles legible here -- the bar's near-white ink would
                      vanish on `CARD_SURFACE`. */}
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
                    player asks of a corporation -- "where are the nine
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
                  {/* ==================================================
                       DESIGN NOTE 394: ENTITY / SHARES / PRICE
                      ==================================================

                      REPORTED: standardise three columns; give the IPO and
                      Bank Pool rows both a share count and a percentage
                      plus their current price, and leave the player rows'
                      price blank.

                      The old third column was `%`, which meant the header
                      described the banks and the players identically while
                      the two rows answered different questions. A player's
                      percentage is their STAKE; the IPO's percentage is
                      INVENTORY, and what a buyer wants next to inventory is
                      what it costs.

                      SO THE PERCENTAGE MOVES IN BESIDE THE COUNT -- `7
                      (70%)` -- and the freed column carries price. Both
                      figures survive; they are just no longer pretending to
                      be the same kind of fact as each other.

                      THE TWO PRICES ARE DIFFERENT, and that is 1830, not a
                      display choice: an IPO share is bought at the PAR
                      price the president set, a Bank Pool share at the
                      CURRENT MARKET price. Printing one price for both
                      rows would be wrong in the common case where a
                      corporation has risen or fallen since it floated --
                      which is most of the game.

                      A PLAYER ROW'S PRICE IS BLANK, deliberately, and not
                      a dash. There is no price at which a player's shares
                      are for sale: they are not a pool you can buy from,
                      and printing the market figure there would read as an
                      offer. Blank says "this column does not apply to this
                      row", which is the truth. */}
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
                    {/* ==================================================
                         DESIGN NOTE 448: NINE CERTIFICATES, NOT TEN
                        ==================================================

                         REPORTED: the maximum share count for the IPO and
                         player tables should be 9, not 10 -- there are
                         physically nine certificates.

                         And there are: one 20% President's Certificate plus
                         eight 10% shares. `percentage / 10` counts PERCENT
                         BLOCKS, which is ten of them, so a full IPO read
                         "10" for a stack of nine pieces of card -- and the
                         extra digit is what clipped the column.

                         `certificateCount` already knew this: its own note
                         explains that a president on 60% holds five
                         certificates, not six, and that the certificate
                         LIMIT is per certificate rather than per percent.
                         The player rows have used it all along; the two
                         bank rows were doing raw division beside them, so
                         one table was counting in two different units.

                         WHILE THE PRESIDENCY IS UNSOLD the 20% certificate
                         is still sitting in the IPO, so the IPO counts as
                         holding it -- `president === null` is exactly that
                         test, and it is why this cannot be a constant 9. */}
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
                    {/* Design note #448: the same unit as every other row.
                        A President's Certificate cannot reach the Bank Pool
                        -- a president must dump the presidency before
                        selling out -- so this is never a double
                        certificate and `false` is not a simplification. */}
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
                    /* ==================================================
                         DESIGN NOTE 421: THE HIGHLIGHT FOLLOWS THE READER
                        ==================================================

                        REPORTED: highlight the viewer's own row instead of
                        the president's. Keep the crown on the president but
                        drop their highlight, and remove the "you" tag.

                        THE ROW HIGHLIGHT AND THE CROWN WERE SAYING THE SAME
                        THING TWICE, which is what made the amber wrong
                        rather than merely misplaced. A crown is already an
                        unmistakable, permanent mark of the presidency, and
                        a filled amber row behind it added emphasis to a
                        fact that needed none. Meanwhile the one row a
                        reader actually scans for -- their own -- was
                        marked by a small pale "you" pill at the end of a
                        name, which is the weakest position in the row and
                        the last thing the eye reaches.

                        So the two swap weights. The crown carries the
                        presidency alone, on a plain row; the fill carries
                        "this one is yours", which is the question a player
                        asks every time this table is on screen and the
                        only one whose answer differs per reader.

                        THE TAG IS DELETED, NOT MOVED. With the row itself
                        highlighted, a pill spelling out the same thing is
                        the duplication this note just removed from the
                        president -- reintroduced one column to the left.
                        `isSelf` survives as the flag that drives the fill.

                        NOTHING IS LOST FOR A HOTSEAT PLAYER. `isSelf`
                        needs a `connectedAddress`, which a shared keyboard
                        does not have, so no row highlights there -- the
                        same behaviour the "you" tag had, since it was
                        gated on exactly the same value. */
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
                          {/* Design note #552: the WORD is gone and the crown
                              is back, as our own drawing. Design note #490
                              removed the emoji because a platform pictogram
                              in a platform colour font could not be relied
                              on to mean anything, and put the word in its
                              place; the word is nine characters wide in a
                              column that has to fit a name beside it, which
                              is the collision reported here. An inline SVG
                              is the same shape everywhere, takes the row's
                              own ink, and announces "President" to a screen
                              reader -- so the redundancy #490 was defending
                              survives intact. */}
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

                  {/* ==================================================
                       DESIGN NOTE 395: THE PRIVATES THIS COMPANY OWNS
                      ==================================================

                      REPORTED: list corporate-owned privates at the bottom
                      of the table -- name left with an ellipsis, revenue
                      right -- and make each row expand to its full name and
                      rules text.

                      They belong in the ownership table rather than beside
                      it because they ARE holdings: a private inside a
                      corporation is an asset the shareholders own a piece
                      of, and it pays into the treasury every Operating
                      Round. A buyer weighing PRR against B&O wants the
                      "+$30/OR of privates" in the same block as the share
                      counts, not in a separate panel.

                      THE ELLIPSIS IS LOAD-BEARING. "Champlain & St.
                      Lawrence" is 24 characters and the card is fixed-width
                      by design note #22; without `textOverflow` it wraps
                      and every card carrying that private grows a line.
                      Clipping it is only acceptable BECAUSE the row expands
                      -- the full name is one click away, which is the trade
                      the requirement asks for.

                      EXPANSION IS PER PRIVATE AND INDEPENDENT of which card
                      is active. Reading what the D&H does is a reference
                      lookup, not an action, so it must not compete with the
                      active-card selection that governs Buy and Sell
                      (design note #396). A player can read a private on one
                      card while a different card holds the action bar. */}
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

                {/* ==================================================
                     DESIGN NOTE 445: THE RULE THIS NAMED DOES NOT EXIST
                    ==================================================

                     REPORTED (critical): the codebase assumes a corporation
                     can float during the Auction Round, and winning the B&O
                     private auto-floats the B&O.

                     THE REDUCER WAS ALREADY RIGHT. `grantBOPresidency` moves
                     20% and the presidency and sets par, and its own note
                     spells out that `is_floated` STAYS PUT. The sandbox
                     fixture ships B&O as `floated: false`. Nothing in this
                     frontend floats a company outside the 60% threshold.

                     WHAT WAS WRONG WAS THIS LABEL, and it was wrong in the
                     way that matters most: it TAUGHT the rule. A badge
                     reading "Auto-floated by the B&O private" tells every
                     player that such a route exists, and design note #24
                     below went further and described the state as one the
                     panel was "ready for". A UI that explains a
                     non-existent rule is how the rule gets believed --
                     including by whoever reads this code next and
                     implements it.

                     So no cause is named. If `is_floated` is true below
                     60%, the flag and the arithmetic disagree, and that is
                     a data fault to surface rather than a rule to
                     rationalise. On a correct contract the branch never
                     renders at all. */}
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
              connectedAddress={connectedAddress}
              macroRoundNumber={macroRoundNumber}
              playerCash={playerCash}
              parValue={parValueFor(company.company_id)}
              onSelectParValue={onSelectParValue}
              onBuyShare={onBuyShare}
              onSellShares={onSellShares}
              controlsDisabled={controlsDisabled}
              // Design note #417: no Stock Round, no controls at all.
              tradingOpen={tradingOpen}
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
                ...(isActive ? styles.rosterCardActive : {}),
                borderColor: isActive ? CARD_BORDER_ACTIVE : CARD_BORDER,
              }}
            >
              {cardFace}
              {/* ==================================================
                   DESIGN NOTE 396: ONE CARD HOLDS THE CONTROLS
                  ==================================================

                  REPORTED: showing Buy, Sell and Par on all eight cards is
                  massive clutter; a card must be clicked to become active,
                  and only the active card renders an action bar.

                  THIS REVERSES DESIGN NOTE #388, which is left standing
                  above rather than edited away. That note argued a control
                  requiring a click to reveal is one the player has to
                  remember is there -- and taken alone the argument is
                  sound. What it did not weigh is the MULTIPLIER: eight
                  corporations, each with a source switch, a buy button, a
                  par ladder and a five-way sell selector, is roughly 160
                  controls on one screen. At that density the problem is no
                  longer whether an individual control is discoverable, it
                  is that none of them are, because the eye has nowhere to
                  land.

                  The reversal is narrow and #388's real point survives:
                  the actions still render on the FRONT of the card, in
                  place, under the numbers they act on. Nothing was moved
                  to a back face or a modal. The only change is that eight
                  copies became one.

                  WHY CLICKING AGAIN CLEARS IT: a player who has finished
                  with a card needs a way back to the dense read-only grid,
                  and making the same target toggle is one fewer control
                  than a close button. */}
              {isActive && cardActions}
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
  onSellShares: (protocolId: number, percentage: number) => void;
  controlsDisabled: boolean;
  /** Design note #417: whether shares can be traded AT ALL right now, i.e.
   *  whether this is a Stock Round. `false` renders no controls -- not
   *  disabled ones. */
  tradingOpen: boolean;
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

  /* ==================================================================
   *  DESIGN NOTE 417: OUTSIDE A STOCK ROUND THERE ARE NO CONTROLS
   * ==================================================================
   *
   * REPORTED: remove the Buy/Sell buttons from the corporation cards when
   * the game is not in a Stock Round. Do not just warn -- hide them.
   *
   * Design note #32 made these controls DISABLED outside a Stock Round and
   * argued the case: "a rejected transaction is a worse explanation than a
   * disabled button". True, and it answered the wrong question. The choice
   * is not between a disabled button and a rejected transaction; it is
   * between a disabled button and NO BUTTON, and a disabled control claims
   * something a hidden one does not -- that this is an action available
   * here, blocked for a reason the player might fix.
   *
   * Nothing about an Operating Round is fixable by waiting on this card.
   * The roster is a REFERENCE surface for most of the game (design note
   * #41 made it a persistent tab), and a reference surface carrying eight
   * cards' worth of greyed Buy, Sell, source-switch and par controls is a
   * screen mostly made of things that do not work.
   *
   * The panel still states why, once, at the top -- `actionsLockedReason`
   * is unchanged and still renders. One sentence for the whole roster
   * rather than forty dead controls saying it individually.
   *
   * GUARDED HERE, NOT AT THE CALL SITE, and the placement is load-bearing:
   * this component holds `useState`/`useEffect`, so an early return above
   * them would change the hook order between rounds and crash the card.
   * Every hook has run by this line; only the render is skipped. */
  if (!tradingOpen) return null;

  return (
    <div style={styles.cardActions}>
      {/* ==================================================================
           DESIGN NOTE 397: PAR COMES BEFORE THE PRESIDENT'S SHARE
          ==================================================================

          REPORTED: the Par button flow is chronologically backward -- the
          par selector must render ABOVE "Buy President's Share".

          It sat below, sharing a row with the Sell selector, because both
          are the same KIND of control -- a strip of numeric options with
          exactly one chosen -- and design note #22 paired them on that
          basis. Pairing by control TYPE is what put them out of order.

          The rulebook order is the order the player acts in: you set a par
          price and THEN buy the president's certificate at it, in one
          motion. Rendering the price second asked the player to press Buy,
          notice it used a number chosen somewhere below, and scroll back --
          the number the button spends is now above the button that spends
          it.

          THE SELL BLOCK STAYS PUT, and loses nothing by it: par is only
          offered while `par_value === null`, and a corporation nobody has
          parred has no shares for anyone to sell. The two controls were
          never on screen together. */}

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
              onClick={() =>
                onBuyShare(company.company_id, source, multiBuyMax > 1 ? effectiveQuantity : 1)
              }
              /* Design note #466: greyed as well as disabled. `disabled`
                 alone leaves a button at full contrast that silently
                 refuses the click -- `actionButtonDisabled` is the same
                 treatment every other refused control in this file wears
                 (inline styles cannot express `:disabled`, per Lobby's own
                 design note #3). */
              style={{
                ...styles.actionButton,
                ...(controlsDisabled || cannotAfford ? styles.actionButtonDisabled : {}),
              }}
              disabled={controlsDisabled || cannotAfford}
              title={
                cannotAfford
                  ? `Insufficient funds — costs $${totalCost}, you hold $${playerCash}.`
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

      {/* ==================================================
           DESIGN NOTE 466: THE REASON MOVES ONTO THE CONTROL
          ==================================================

           REPORTED: grey the Buy button out and say "Insufficient funds" in
           its tooltip, rather than leaving it clickable with a red warning
           appended below.

           The button was ALREADY disabled -- what it lacked was the greyed
           LOOK, so it read as live and refused silently. Design note #357
           answered that with a red line underneath, on the reasoning that
           "a disabled button with only a tooltip is a button that looks
           broken to anyone who does not hover it". Sound, and it treated
           the symptom: the button still looked enabled, so a second element
           was added to explain why it was not.

           Greying it removes the premise. A visibly disabled control does
           not look broken, it looks unavailable -- and the red line was
           costing a row on every card whose owner happened to be short of
           cash, which during a Stock Round is most of them most of the
           time. The figures it carried survive in the tooltip, which now
           leads with the phrase the requirement asks for. */}

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

      {/* ==================================================================
           DESIGN NOTE 418: THE SR1 BAN REACHED THE SELECTOR, NOT THE BUTTON
          ==================================================================

          REPORTED: explicitly disable Sell during the first Stock Round.
          1830 forbids selling in SR1.

          Design note #356 established `sellingForbidden` and applied it to
          the SIZE SELECTOR a few lines above -- `playerHoldingPercent > 0 &&
          !sellingForbidden` -- and stopped there. This button kept only the
          holdings test, so in SR1 the strip of 10/20/30/40/50 options
          vanished and a live "Sell 10% Bundle" button remained underneath
          it, wired straight to `onSellShares`. The ban was visible and not
          enforced, which is the worst of both: the UI looked like it knew
          the rule while the click still went through.

          DISABLED, NOT HIDDEN, and deliberately the opposite of design note
          #417's treatment one screen over. The distinction is whether the
          player can ever act here. Outside a Stock Round the answer is no
          and the controls go; in SR1 selling is a real action of this very
          panel that is barred for one round and legal in every round after,
          so a disabled button carrying the reason teaches a rule the player
          will need next round. That is the same argument
          `SELL_PERCENTAGE_OPTIONS` already makes for rendering illegal bundle
          sizes greyed with an explanation rather than omitting them.

          THE REASON IS ON THE BUTTON, not only in a tooltip: `title` is the
          established pattern here for a disabled control, and the label
          itself changes so the ban is legible without hovering. */}
      {playerHoldingPercent > 0 && (
      <button
        type="button"
        style={styles.actionButton}
        onClick={() => onSellShares(company.company_id, sellPercentage)}
        disabled={controlsDisabled || sellingForbidden || !selectedSellState.enabled}
        title={
          sellingForbidden
            ? "No selling in the first Stock Round — 1830 opens the market to sales from SR2 onward."
            : undefined
        }
      >
        {sellingForbidden ? "Selling Opens in SR2" : `Sell ${sellPercentage}% Bundle`}
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
/*  DESIGN NOTE 24 / 445: FLOAT IS THE 60% RULE, WITH NO EXCEPTIONS     */
/* ==================================================================== */
//
// A company floats when 60% of its shares are in player hands. There is no
// auto-float route, and no corporation floats during the Auction Round --
// the auction sells PRIVATES, and no share changes hands in it.
//
// Winning the B&O private grants the President's Certificate and prompts a
// par choice. That is all it does. The B&O then floats on the ordinary
// 60%-sold condition in a subsequent Stock Round, like every other company.
//
// DESIGN NOTE 445: this note previously said the badge above was "ready
// for" the auto-floated state, and the badge itself named the rule. Both
// have been removed. The distinction that matters: `auction.rs` setting
// `is_floated` is a CONTRACT BUG on the audit list, and a frontend that
// explains a bug in the language of a rule is how the bug becomes the rule.
//
// `is_floated` is still what the BADGE reads, because it is contract state
// and the frontend does not get to overrule it. But when it disagrees with
// the 60% math the card reports the DISAGREEMENT and names no cause. On a
// corrected contract that branch never fires.

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

/* Design note #428: the module-local `TICKER_COLORS` is GONE. It was a
   hand-kept copy of the same eight colours `hexContractTypes.ts` and
   `StockMarketRenderer.tsx` also held -- three mirrors that design note
   #408 could only keep in step by instructing future readers to update all
   of them together. The table now lives in `styles/corporationLivery.ts`
   and `tickerColor` is its reader, so a recolour physically cannot reach
   one surface and miss another. */
const tickerColor = corporationLiveryColor;

/* Design note #389 said "one table, not a second palette that looks close",
   and this file was the second palette. It is now literally true. */

/** Standard 1830 par ladder, per this pass's own requirement.
 *  Exported since design note #399: the B&O prompt offers the same six
 *  rungs, and two copies of a price ladder is two ladders that can differ.
 *
 *  ==================================================================
 *   DESIGN NOTE 415: DERIVED FROM THE BOARD'S OWN PAR BOXES
 *  ==================================================================
 *
 *  This was a hand-written `["67", "71", ...]`. It agreed with the chart,
 *  and design note #399 had already made the argument for why a second copy
 *  of a price ladder is a liability -- it just drew the boundary one file
 *  too early. There were still two ladders: this list of prices a player may
 *  CHOOSE, and `StockMarketRenderer.PAR_VALUE_LADDER`'s list of prices the
 *  board has BOXES for.
 *
 *  Those must be the same set, and the failure when they are not is now
 *  silent rather than loud. `placeParMark` resolves a par through
 *  `parBoxCellFor`, which returns `null` for any price not in the ladder --
 *  correctly, since a price with no box is not a par. So a seventh rung
 *  added here and not there would let a player par a corporation at a price
 *  that puts no token on the chart at all, and the company would read
 *  "not on the market chart" forever with nothing to explain why.
 *
 *  Deriving means the two cannot disagree. `String` because this list feeds
 *  a radio group whose values are strings, while the coordinates table is
 *  numeric -- the conversion is the only thing this file adds. */
export const PAR_VALUE_LADDER: readonly string[] = PAR_BOX_PRICES.map(String);

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
  privateCompanies,
  parValueFor,
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
  roundType,
}: StockRoundPanelProps) {
  // Design note #32: out of phase counts as "controls disabled" exactly the
  // same way an unready session does -- one flag, so no control can be
  // wired to one condition and miss the other.
  const controlsDisabled = !sessionReady || actionsLockedReason != null;
  /* Design note #396: the ACTIVE card -- the one whose action bar renders.
     Renamed from `expandedCompanyId`: it no longer expands anything, it
     decides where the controls live. */
  const [activeCompanyId, setActiveCompanyId] = useState<number | null>(null);
  /* Design note #395: a separate cursor for the private rules text, so
     reading what the D&H does never moves the action bar off the card the
     player was working on. */
  const [expandedPrivateId, setExpandedPrivateId] = useState<number | null>(null);

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
    setActiveCompanyId(null);
    // Design note #395: the private text closes with the turn too. It is
    // reference material for the player who opened it, not a view the next
    // seat inherits.
    setExpandedPrivateId(null);
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
        /* Design note #417: shares trade in a Stock Round and nowhere else.
           `actionsLockedReason` already carries that fact -- it is the
           sentence rendered directly above -- so deriving from it keeps the
           notice and the controls answering to one condition rather than
           two that can disagree. */
        tradingOpen={actionsLockedReason == null}
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

/* ==================================================================
 *  DESIGN NOTE 507: ONE WIDTH, WRITTEN TWICE, UPDATED ONCE
 * ==================================================================
 *
 * REPORTED: on the Stocks tab a recent widening of the Shares column pushed
 * the Price column right, clipping it at the edge of the card.
 *
 * The ownership table encoded its numeric column width in TWO places:
 *
 *   `ownershipRow` / `ownershipHeadRow`  grid tracks, `... 46px 46px`
 *   `ownershipNum`                       the cell, `minWidth: 68px`
 *
 * Design note #466 widened the second -- correctly, because "9 (100%)" is a
 * real value and it was wrapping -- and left the first at 46px. A grid item
 * cannot shrink below its own `min-width`, and a grid track does not clip
 * what overflows it, so each numeric cell spilled 22px past its track. Two
 * of them, and the Price column ends up 44px beyond where the grid put it:
 * off the right edge of a fixed-width card.
 *
 * Nothing looked wrong at either site. 46px is a reasonable track and 68px
 * is a correct minimum; they are only wrong TOGETHER, which is why the
 * widening pass had no reason to notice.
 *
 * SO THERE IS ONE NUMBER NOW. The track and the minimum read the same
 * constant, which makes the relationship "the track is at least as wide as
 * its content requires" true by construction rather than by two edits
 * staying in step. This is the same fix TD-1 applied to the corporation
 * palette and design note #499 to the route table's headers.
 *
 * THE SPACE COMES FROM THE ENTITY COLUMN, which is what the report asks for
 * and is also where it should come from: `minmax(0, 1fr)` is the only track
 * that can give, it holds a name that already ellipsises, and on every row
 * but the longest it has slack to spare. */
const OWNERSHIP_NUM_WIDTH = "68px";
const OWNERSHIP_GRID = `minmax(0, 1fr) ${OWNERSHIP_NUM_WIDTH} ${OWNERSHIP_NUM_WIDTH}`;

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
  /* Design note #504: a COLUMN, value over caption -- `rosterPrice`'s exact
     shape, so both rows of the card caption their values the same way round.
     It was an inline row with the label first, which made the asset row read
     in the opposite order to the price row directly above it.

     `alignItems: flex-start` rather than `center`: the chips are wider than
     their captions, and centring would float each word under the middle of
     its chip row instead of aligning it with the row's left edge, which is
     where the eye returns after reading across. */
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
  /* Design note #503: the caption inside the badge, which is what answers
     #488's "captioned by position means captioned by nothing". Lighter and
     un-tracked against the figure's 800 weight, so the pill reads as
     label-then-value rather than as two competing pieces of text.

     `color: "inherit"` with alpha rather than a fixed grey: this badge sits
     on eight different corporate fills and takes `liveryInk` from the
     stripe, so a fixed caption colour would be unreadable on some of them --
     the same argument design note #236 makes for the action bar's secondary
     text. */
  rosterLiveryBadgeCaption: {
    fontWeight: 600,
    letterSpacing: "0.02em",
    textTransform: "uppercase",
    color: "inherit",
    opacity: 0.75,
  },
  /* Design note #490: the crown's replacement. A tag rather than running
     text, so it is skimmable in a dense table -- which is the job the glyph
     was doing and the only part of it worth keeping. */
  /* Design note #552: this styled a WORD and now sizes a drawing, so the
     type properties went with the text -- `textTransform` and
     `letterSpacing` have nothing to act on inside an `<svg>`, and leaving
     them would read as though the crown were still a glyph in a font.
     `color` stays and is now load-bearing: the crown fills with
     `currentColor`. */
  presidentTag: {
    color: CARD_HIGHLIGHT_BORDER,
    marginRight: "5px",
    flexShrink: 0,
  },
  rosterTicker: { fontSize: FONT_SIZE.heading, fontWeight: 800, letterSpacing: "0.5px" },
  rosterNameStack: { display: "flex", flexDirection: "column", gap: "1px", minWidth: 0 },
  /* Design note #501: the herald and the acronym, side by side. A ROW inside
     the column stack, so the full name below keeps its own line.

     `minWidth: 0` for the same reason design note #499 needed it one file
     over: without it a flex item refuses to shrink below its content, and a
     long acronym would push the name's ellipsis out of the card instead of
     being contained by it. */
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
  /* ---- Design note #31: the front-face operating snapshot. A bordered
     strip rather than three loose pairs, so it reads as one block of
     "how it operates" distinct from the prices above and the holdings
     below. `flexWrap` because a corporation at its Phase 2 limit can hold
     four chips, which will not sit beside two more cells on a narrow
     card. ---- */
  rosterPrice: { display: "flex", flexDirection: "column", gap: "1px" },
  /* Design note #489: flush right. `marginLeft: auto` rather than
     `justify-content: space-between` on the row, because the row's other
     three cells must stay grouped at the left as a sequence -- spacing them
     apart would make treasury look like the fourth in a series instead of
     the balance it is. `alignItems: flex-end` right-aligns the value over
     its caption, so the dollar figure ends flush with the card edge. */
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
  /* Design note #466: wide enough for the longest value it can hold.
     "9 (100%)" is that value -- a full IPO -- and it wrapped, because the
     column was sized by content and this is the one row where the content
     is at its widest. `whiteSpace: nowrap` alone would have overflowed
     instead of wrapping; the basis is what actually makes room. */
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
  // Design note #8: gold + bold, the second of the president's three
  // independent markers.
  /* Design note #421: the amber row is the VIEWER's, not the president's.
     Renamed rather than repointed -- `rosterHoldingRowPresident` described
     the thing it was wrong about, and a later reader handed a style with
     that name would reasonably put it back on the crown. Same three
     tokens, so the fill is still the one highlight treatment the card set
     shares (`palette.ts`). */
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
  /* Design note #466: the greyed-out treatment for a refused Buy. Inline
     styles cannot express `:disabled` (Lobby.tsx design note #3), so every
     disabled control in this codebase computes its own look. */
  actionButtonDisabled: {
    opacity: 0.45,
    cursor: "not-allowed",
  },
  /* `cannotAffordNote` DELETED by design note #466. It was the red line
     under a Buy button that looked enabled; the button is greyed now, so
     the line has nothing left to explain. Deleted rather than left unused
     -- an orphaned "here is why this is refused" style is an invitation to
     render a second refusal message beside the first. */
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
