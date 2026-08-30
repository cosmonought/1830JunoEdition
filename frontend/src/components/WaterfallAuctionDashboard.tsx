// frontend/src/components/WaterfallAuctionDashboard.tsx
//
// Pre-game Waterfall Auction engine (`waterfall.rs`) -- the dashboard for allocating 1830's six
// private companies before Stock Round 1. `App.tsx` renders this in place of the action bar, board
// canvas and sub-panel for the whole of `current_round_type === "WaterfallAuction"`, so this
// component is the room's entire canvas rather than a tray bolted onto the layout.
//
// Six private-company cards own the full width and ARE the interface -- each carries its own action
// (Buy for the lowest offer, Place Bid otherwise, Raise/Drop-out under a live mini-auction), buttons
// bottom-anchored so they align. Pass and Undo are turn-level and live in the single app-wide
// `ContextualActionBar` (design note #31 there).
//
// Design notes: see `docs/ai_architecture/contract_economy.md`.

import React, { useEffect, useRef, useState } from "react";
import { FONT_SIZE } from "../styles/typography";
import { privateClosureTier } from "../utils/purchaseWarnings";
import { PRIVATE_COMPANY_CATALOG } from "../utils/privateCatalog";
import { SpecialPowerBlock } from "./SpecialPowerBlock";
import { auctionFunds, bidRejectionReason, type PlayerAuctionFunds } from "../utils/auctionEscrow";
import {
  CARD_ACCENT,
  CARD_BORDER,
  CARD_BORDER_CONTESTED,
  CARD_BUY_GREEN,
  CARD_BUY_GREEN_DARK,
  CARD_BUY_GREEN_INK,
  CARD_BUY_GREEN_TINT,
  CARD_DIVIDER,
  CARD_INK,
  CARD_INK_FAINT,
  CARD_INK_MUTED,
  CARD_INK_POSITIVE,
  CARD_SURFACE,
} from "../styles/palette";

import type {
  GameStateResponse,
  WaterfallMiniAuctionStatus,
  WaterfallPrivateStatus,
  WaterfallStateResponse,
} from "../utils/gameState";

/** Hand-kept mirror of `auction::MIN_BID_INCREMENT`. Every bid must beat
 *  the standing one by at least this much, which is also why two players
 *  can never hold an equal bid -- see the "competing", never "tied",
 *  terminology throughout this file. */
const MIN_BID_INCREMENT = 5;

/* Design note #391: the catalog moved to `utils/privateCatalog.ts` so
   the stock card can quote the same text. Same table, same values --
   only its address changed. */


/* Design note #314: whose money the controls are about to spend. Online it is always the connected
   wallet; hotseat has none, so it is the seat on turn -- and during a mini-auction that is the
   mini-auction's cursor, not the main one. Getting this wrong gates Alice's raise against Bob's balance. */
function miniAuctionSeat(
  waterfall: WaterfallStateResponse | null,
  hotseat: boolean,
): string | null {
  if (!hotseat || !waterfall) return null;
  return waterfall.mini_auction?.current_turn ?? waterfall.current_turn ?? null;
}

export interface WaterfallAuctionDashboardProps {
  waterfallState: WaterfallStateResponse | null;
  loading: boolean;
  error: string | null;
  /** Used only for the Seating Order rail -- `player_addresses` in turn
   *  order. Every other field this component needs comes from
   *  `waterfallState` itself. */
  gameState: GameStateResponse | null;
  connectedWalletAddress: string | null | undefined;
  sessionReady: boolean;
  /** Optional address -> display name, matching `StockRoundPanel`'s prop of
   *  the same name. Used only by the sold badge. */
  playerLabel?: (address: string) => string | null;
  /* Design note #30: hotseat has no wallet to compare against. Every control gated on
     `current_turn === connectedWalletAddress` renders as somebody else's turn forever in the sandbox.
     Pass-and-play asks a different question: not "is this seat mine" but "is anyone at this keyboard
     allowed to act for the seat on turn".
     A SEPARATE FLAG RATHER THAN A FAKE ADDRESS -- handing the sandbox `connectedWalletAddress =
     current_turn` would make every "YOU" badge follow the turn around the table. `hotseat` unlocks the
     CONTROLS and leaves the identity comparisons alone. */
  hotseat?: boolean;
  /** Design note #303 (`App.tsx`): what each private actually SOLD for, by
   *  id. A mini-auction settles above face value, and the sold card used to
   *  quote the face value with a tooltip apologising for it. Empty on a
   *  live chain, where the card falls back to face value as before. */
  settledPrices?: Readonly<Record<number, number>>;
  /* Design note #306: "is concluding" is not a state a player can leave. With every private allocated the
     grid offered nothing while nothing was in progress -- the round needed advancing, which is an action.
     `undefined` leaves the message without a control, the right shape on a live chain where the contract
     advances the round itself and a client-side button would be a lie. */
  onProceedToStockRound?: () => void;
  /** Dispatches `ExecuteMsg::WaterfallBuyLowest`. */
  onBuyLowest: () => void;
  /** Dispatches `ExecuteMsg::WaterfallBidHigher`. */
  onBidHigher: (privateId: number, bidAmountVgp: number) => void;
  /** Dispatches `ExecuteMsg::WaterfallMiniAuctionRaise`. */
  onMiniAuctionRaise: (bidAmountVgp: number) => void;
  /** Dispatches `ExecuteMsg::WaterfallMiniAuctionPass`. */
  onMiniAuctionPass: () => void;
  /* Design note #604: the player cards arrive as a NODE -- the same conduit `ContextualActionBar` uses for
     `seatOrderTrail`. This dashboard knows only WHERE on the screen the players go, which is the one fact
     `App.tsx` cannot state from outside. Passing the built element also keeps the Stock Round and the
     auction rendering one component instance shape (#602). `undefined` renders nothing. */
  playersPanel?: React.ReactNode;
}

/** Design note #32: injected keyframes -- inline `React.CSSProperties` cannot express `@keyframes`, so
 *  this follows `App.tsx`'s existing `<style>`-tag convention.
 *  Design note #320: AN EVENT, NOT AN EMERGENCY. The ring pulsed red, and red already means something
 *  going wrong on this screen; a mini-auction is the most interesting thing that can happen and nothing
 *  is wrong. Built as two background layers on one element -- an opaque fill clipped to the PADDING box,
 *  the gradient clipped to the BORDER box -- so the only gradient visible is the ring: a real animated
 *  border with no pseudo-element. A rotating `conic-gradient` on a `::before` tears at the corners four
 *  times per turn unless oversized and re-centred; `background-position` on a repeating linear gradient
 *  has no such geometry and needs no `@property`. The palette runs the full hue circle so it is
 *  unmistakably not any status colour. Reduced motion keeps the ring, static -- a cue that DISAPPEARS
 *  when motion is reduced is an information problem (design note #26).
 *  Design note #344: THE CHASER HAD A DARK GAP -- the animation was right, the TILING was not. Two
 *  conditions, both required: (1) `background-repeat: no-repeat, repeat` -- the fill must not repeat, the
 *  gradient must; (2) one cycle moves exactly one tile. A percentage in `background-position` is a
 *  fraction of (positioning area - image width), so at `background-size: 200%` the base is -W and `200%`
 *  resolves to -2W = one tile, with W cancelling at every card width. Change one 200% without the other
 *  and the loop stutters once per cycle. The palette's first and last stops match for the same reason. */
const MINI_AUCTION_GLOW_KEYFRAMES = `
@keyframes waterfall-miniauction-chase {
  from { background-position: 0 0, 0 0; }
  to   { background-position: 0 0, 200% 0; }
}
/* The whole border, and the card's fill, live HERE rather than in the
   inline style object -- inline styles beat a stylesheet, so a
   \`backgroundColor\` or \`borderColor\` left inline would silently win over
   the gradient and the chaser would never appear. \`privateCardMiniAuction\`
   below keeps only layout. */
.waterfall-miniauction-card {
  border: 3px solid transparent;
  border-left-width: 6px;
  border-radius: 8px;
  background:
    linear-gradient(${CARD_SURFACE}, ${CARD_SURFACE}) padding-box,
    linear-gradient(
      90deg,
      #ff4d4d, #ff9f1c, #ffd400, #4ade80, #22d3ee,
      #4f7cff, #a855f7, #ff4dc4, #ff4d4d
    ) border-box;
  /* Design note #344: the 200% here and the 200% in the keyframe are ONE
     number -- one cycle must translate exactly one tile. */
  background-size: 100% 100%, 200% 100%;
  background-position: 0 0, 0 0;
  background-repeat: no-repeat, repeat;
  animation: waterfall-miniauction-chase 3.2s linear infinite;
  box-shadow: 0 0 18px rgba(120, 160, 255, 0.22), 0 3px 16px rgba(0, 0, 0, 0.45);
}
/* Design note #26's bargain, kept: a cue that cannot be switched off is an
   accessibility problem, but a cue that DISAPPEARS under reduced motion is
   an information problem -- turning the spin off must not cost the player
   the answer to "which card is live". The multicolour ring stays, static. */
@media (prefers-reduced-motion: reduce) {
  .waterfall-miniauction-card { animation: none; }
}
`;

export function WaterfallAuctionDashboard({
  waterfallState,
  loading,
  error,
  gameState,
  connectedWalletAddress,
  sessionReady,
  playerLabel,
  hotseat = false,
  settledPrices,
  onProceedToStockRound,
  onBuyLowest,
  onBidHigher,
  onMiniAuctionRaise,
  onMiniAuctionPass,
  playersPanel = null,
}: WaterfallAuctionDashboardProps) {
  const privates = waterfallState?.privates ?? [];
  /* Design note #314: the seat whose money the controls spend -- in hotseat whoever is on turn, online the
     connected player, whose funds stay on screen while somebody else acts.
     Design note #593: `ownedPrivatesFor` went with the seating table it fed; the player cards list a seat's
     privates from `playerFinances`, which reads the same state and is now the only place computing it. */

  const fundsSeat =
    (miniAuctionSeat(waterfallState, hotseat) ?? connectedWalletAddress) ?? null;
  const viewerFunds = fundsSeat ? auctionFunds(gameState, waterfallState, fundsSeat) : null;
  /* Design note #30: ONE ORDERED GRID, sold cards in place. Sold privates were appended AFTER the live
     ones, so winning the cheapest visually moved it past companies worth ten times as much -- and the
     waterfall's whole structure is its ascending face-value order. Merged and sorted by face value, so
     every card holds its slot and simply greys out when won. */
  const soldPrivates = (gameState?.private_companies ?? []).filter((priv) => priv.owner !== null);

  type GridEntry =
    | { kind: "live"; faceValue: number; priv: WaterfallPrivateStatus }
    | { kind: "sold"; faceValue: number; sold: (typeof soldPrivates)[number] };

  const gridEntries: GridEntry[] = [
    ...privates.map((priv) => ({
      kind: "live" as const,
      faceValue: Number(priv.face_value),
      priv,
    })),
    ...soldPrivates.map((sold) => ({
      kind: "sold" as const,
      faceValue: Number(sold.cost),
      sold,
    })),
  ].sort((a, b) => a.faceValue - b.faceValue);
  const miniAuction = waterfallState?.mini_auction ?? null;
  // `lowest`/`biddable` are gone with the shared tray (design note #14).
  // Each card now decides for itself which action it offers, from its own
  // `is_lowest_offered` flag -- so the parent no longer needs to partition
  // the list to feed a dropdown that no longer exists.

  /* Design note #17: FLAT ACTIONS, NO ACCORDION. Two shapes were tried and both were wrong in opposite
     directions -- a shared bid tray (#11) made the cards read-only, with a dropdown and an input connected
     only by the player's attention; an accordion per card (#14) fixed that and put a click in front of a
     single button, six times over, on a screen where every card has exactly ONE legal action.
     So the action lives on the card face. Nothing is hidden and nothing needs opening.
     Design note #30: in hotseat the seat on turn is always actionable; the wallet comparison only decides
     it when there IS a wallet. */
  const isMyMainTurn =
    !!waterfallState &&
    !miniAuction &&
    (hotseat || (!!connectedWalletAddress && waterfallState.current_turn === connectedWalletAddress));
  const isMyMiniTurn =
    !!miniAuction &&
    (hotseat || (!!connectedWalletAddress && miniAuction.current_turn === connectedWalletAddress));

  if (!waterfallState) {
    return (
      <div style={styles.root}>
        <div style={styles.header}>
          <span style={styles.headerTitle}>Auction</span>
        <span style={styles.headerSubtitle}>Pre-game private company waterfall</span>
        </div>
        <p style={styles.placeholderText}>
          {loading
            ? "Loading live Waterfall Auction state..."
            : error
              ? `No live Waterfall Auction state available (${error}).`
              : "No live Waterfall Auction state available yet."}
        </p>
      </div>
    );
  }

  return (
    <div style={styles.root}>
      <style>{MINI_AUCTION_GLOW_KEYFRAMES}</style>
      {/* Design note #305: ONE LINE, NOT THREE SAYING THE SAME THING. A title, a subtitle and a hint were
         three restatements of the same fact stacked above the one piece of live information in the row.
         A player reads a header once, and this cost three lines at the top of the screen. */}
      {/* Design note #610: the pass counter moved to the seats it counted. "3 consecutive pass(es) so far" was
         a number describing a roster elsewhere on the screen, so reading it meant counting backwards round the
         table to work out whether it had reached you -- and "no passes yet" was a clause spent saying nothing
         had happened. The PASSED stamps ARE that count, drawn on the seats.
         `consecutive_waterfall_passes` is still read by `App.tsx`'s `passedSeats`; it stopped being prose. */}
      <div style={styles.header}>
        <span style={styles.headerTitle}>Private Company Waterfall Auction</span>
        {error && (
          <span style={styles.staleNote}>Showing last known state — latest refresh failed: {error}</span>
        )}
      </div>

      <div style={styles.body}>
        <div style={styles.privateGrid}>
          {gridEntries.map((entry) =>
            entry.kind === "live" ? (
              <PrivateCard
                key={entry.priv.private_id}
                priv={entry.priv}
                playerLabel={playerLabel}
                connectedWalletAddress={connectedWalletAddress}
                miniAuction={miniAuction}
                sessionReady={sessionReady}
                isMyMainTurn={isMyMainTurn}
                isMyMiniTurn={isMyMiniTurn}
                funds={viewerFunds}
                fundsSeat={fundsSeat}
                onBuyLowest={onBuyLowest}
                onBidHigher={onBidHigher}
                onMiniAuctionRaise={onMiniAuctionRaise}
                onMiniAuctionPass={onMiniAuctionPass}
              />
            ) : (
              <SoldPrivateCard
                key={`sold-${entry.sold.private_id}`}
                sold={entry.sold}
                playerLabel={playerLabel}
                settledPrice={settledPrices?.[entry.sold.private_id]}
              />
            ),
          )}
          {privates.length === 0 && soldPrivates.length === 0 && (
            <p style={styles.placeholderText}>
              All six private companies have been allocated.
            </p>
          )}
        </div>

        {/* Design note #547: the BUTTON moved to `AuctionPromptModal`. It sat at the foot of a scrolling six-card
           grid, which is the visible form of the problem #306 named -- the round was waiting on an action nobody
           could see they had to take. The banner stays, because the grid still needs to say why it is empty. */}
        {privates.length === 0 && (
          <div style={styles.auctionOverBanner}>
            <span style={styles.auctionOverText}>
              The Waterfall Auction is complete. Up next is the Stock Round.
            </span>
          </div>
        )}

        {/* Design notes #11/#14: all BUY/BID/PASS controls moved into the cards; what remains here is the one
           genuinely global thing -- the seating order and who in it is up.
           Design note #322: ONE ANSWER TO "WHOSE TURN IS IT". The standalone Turn panel had become redundant by
           accretion -- #32 added `ON TURN` to the seating rows and #308 put the acting player on the action bar,
           leaving three surfaces for one fact with the panel the weakest: it named the seat without saying where
           that seat sat in the order. The hint line is NOT redundant -- it says where the controls are. */}
        {/* Design note #341: THE TABLE IS THE PANEL. The hint block was prose about where the controls are, on a
           screen where they are on the cards a few inches above and labelled -- half the footer's width to say
           something a player learns once.
           The seating table takes the whole width and spends it on the column the auction was missing: WHO OWNS
           WHAT. Cash says what a player can still bid; the privates say what they have already committed to. */}
        {/* Design note #604: the panel the seating table left behind. #593 deleted the seating TABLE and left its
           container standing -- three nested bordered divs rendering a padded void on every auction screen. It
           claimed "removed rather than hidden"; it removed the rows and hid nothing, and a bordered empty box is
           not less confusing than a table.
           The cards go where the table was, which is what #593 intended -- but NOT inside the old card chrome,
           since the player cards bring their own borders and nesting would double-frame every one. */}
        {playersPanel}
      </div>
    </div>
  );
}

export default WaterfallAuctionDashboard;

/* ------------------------------------------------------------------ */
/* Private company card -- see design note #2                         */
/* ------------------------------------------------------------------ */

function PrivateCard({
  playerLabel,
  priv,
  connectedWalletAddress,
  miniAuction,
  sessionReady,
  isMyMainTurn,
  isMyMiniTurn,
  funds,
  fundsSeat,
  onBuyLowest,
  onBidHigher,
  onMiniAuctionRaise,
  onMiniAuctionPass,
}: {
  priv: WaterfallPrivateStatus;
  connectedWalletAddress: string | null | undefined;
  /** Design note #31: the card renders bidder names, so it needs the same
   *  resolver the dashboard around it uses. */
  playerLabel?: (address: string) => string | null;
  miniAuction: WaterfallMiniAuctionStatus | null;
  sessionReady: boolean;
  isMyMainTurn: boolean;
  isMyMiniTurn: boolean;
  /** Design note #314: the acting seat's total/escrowed/available split.
   *  `null` when the room does not report their cash, which disables the
   *  affordability gate rather than guessing at $0. */
  funds: PlayerAuctionFunds | null;
  /** Which address `funds` describes, so the card can find that player's own
   *  escrow on THIS private -- see design note #315's raise case. */
  fundsSeat: string | null;
  onBuyLowest: () => void;
  onBidHigher: (privateId: number, bidAmountVgp: number) => void;
  onMiniAuctionRaise: (bidAmountVgp: number) => void;
  onMiniAuctionPass: () => void;
}) {
  const catalogEntry = PRIVATE_COMPANY_CATALOG[priv.private_id];
  // Design note #1035: the tier that ends every private's income, from the schedule the reducer reads.
  const closingTier = privateClosureTier();
  const sortedBids = priv.bids.slice().sort((a, b) => Number(b.bid_amount) - Number(a.bid_amount));

  // Status indicators, grounded in `waterfall.rs`'s cascade semantics (module doc #3): 0 bids leaves a
  // private open, exactly 1 is what the next cascade auto-awards, 2+ starts (or IS) a mini-auction.
  const isCompetingInMiniAuction = miniAuction?.private_id === priv.private_id;
  const isAutoAwardPending = !priv.is_lowest_offered && priv.bids.length === 1;
  const isCompetingBid = !priv.is_lowest_offered && (priv.bids.length >= 2 || isCompetingInMiniAuction);

  /* Design note #14: which action this card offers -- mirrors `waterfall.rs`'s own legality rules. The
     lowest-offered private is the only `WaterfallBuyLowest` target and the only one that can never be bid
     on (`CannotBidOnLowest`); every other takes bids. Each card offers exactly one of three things.
     Design note #22: the OPENING bid is face value PLUS the increment. A bid at face value is worth what
     the lowest offer can be bought outright for, so it offers the seller nothing and the bidder no
     advantage -- the same rule applied twice rather than two rules. */
  const standingHigh = priv.bids.reduce((max, b) => Math.max(max, Number(b.bid_amount)), 0);
  const minimumBid =
    (standingHigh > 0 ? standingHigh : Number(priv.face_value)) + MIN_BID_INCREMENT;
  const minimumRaise = miniAuction ? Number(miniAuction.high_bid) + MIN_BID_INCREMENT : 0;

  /* Design note #23: auto-scroll to the turn player. The bid table caps at ~3.5 rows (#21), so with six
     bidders whoever is on turn is as likely as not below the fold.
     `scrollTop` is set directly rather than `scrollIntoView()`, which scrolls every scrollable ANCESTOR --
     on a six-card grid that jogs the whole page whenever the turn passes. `offsetTop` is relative to the
     container because the container is the row's `offsetParent`, so the subtraction pins the row to the TOP. */
  const bidListRef = useRef<HTMLDivElement>(null);
  const turnRowRef = useRef<HTMLDivElement>(null);
  const turnBidder = isCompetingInMiniAuction ? miniAuction?.current_turn ?? null : null;

  useEffect(() => {
    const list = bidListRef.current;
    const row = turnRowRef.current;
    if (!list || !row) return;
    list.scrollTop = Math.max(0, row.offsetTop - list.offsetTop);
  }, [turnBidder, priv.bids.length]);

  const [bidAmount, setBidAmount] = useState<number>(minimumBid);
  const [raiseAmount, setRaiseAmount] = useState<number>(minimumRaise);

  // Re-floor the inputs whenever the legal minimum moves under them (a
  // rival bid landed while this card was open). Defaults, never locks --
  // bidding above the minimum is always legal, so these stay editable.
  useEffect(() => setBidAmount(minimumBid), [minimumBid]);
  useEffect(() => setRaiseAmount(minimumRaise), [minimumRaise]);

  const canBuyOutright = priv.is_lowest_offered;

  /* Design note #315: THE AFFORDABILITY GATE. Both money gates in one expression, so `disabled` and the
     tooltip are driven by one thing.
     RAISE subtracts this seat's standing bid -- that money is already escrowed against this private, so a
     raise funds only the increment; charging the full figure would stop a player defending a bid they have
     already paid for. BUYING OUTRIGHT is gated on AVAILABLE cash: escrow elsewhere is refundable in
     principle but is not refunded YET, and `WaterfallBuyLowest` settles immediately. */
  const ownRaiseEscrow = fundsSeat
    ? priv.bids
        .filter((bid) => bid.bidder === fundsSeat)
        .reduce((sum, bid) => sum + (Number(bid.bid_amount) || 0), 0)
    : 0;
  /* Design note #384: ONE BID PER PRIVATE, in the waterfall proper. Players could spam bids, each
     escrowing more cash against the same certificate -- `ownRaiseEscrow` only needs to SUM because a seat
     could have several. A second bid where you already lead is bidding against yourself; a second bid
     behind someone else is the move that should be a raise.
     SO THE GATE IS "HAVE I BID HERE", not "am I winning here" -- same mistake, same refusal.
     THE MINI-AUCTION LIFTS IT, which is the point of the exception: raising repeatedly is how a contest is
     fought, and gating that would make a triggered auction unwinnable by whoever opened it.
     `ownRaiseEscrow > 0` rather than a second scan of `priv.bids` -- deriving the same fact twice is how
     two answers start to disagree. */
  const alreadyBidHere = !isCompetingInMiniAuction && ownRaiseEscrow > 0;
  const repeatBidReason = alreadyBidHere
    ? `You already have a $${ownRaiseEscrow} bid on ${priv.name}. One bid per private company — if someone outbids you, a mini-auction opens and you can raise there.`
    : null;

  const bidReason = repeatBidReason ?? bidRejectionReason(funds, bidAmount, minimumBid);
  const raiseReason = bidRejectionReason(funds, raiseAmount, minimumRaise, ownRaiseEscrow);
  const buyPrice = Number(priv.face_value) || 0;
  const buyReason =
    funds && buyPrice > funds.available
      ? funds.escrowed > 0
        ? `Only $${funds.available} available — $${funds.escrowed} of your $${funds.total} is escrowed in standing bids.`
        : `Only $${funds.available} available.`
      : null;

  return (
    <div
      // The class exists ONLY so the reduced-motion media query above has
      // something to select -- all real styling stays inline, per this
      // file's convention.
      className={isCompetingInMiniAuction ? "waterfall-miniauction-card" : undefined}
      style={
        isCompetingInMiniAuction
          ? styles.privateCardMiniAuction
          : priv.is_lowest_offered
            ? styles.privateCardLowest
            : styles.privateCard
      }
    >
      {/* The whole header is the accordion toggle. */}
      <div style={styles.privateCardToggle}>
        {/* Design note #31: ONE badge slot, directly under the name. LOWEST OFFER sat here while COMPETING BIDS
           and MINI-AUCTION LIVE sat further down, so the same class of information appeared at two heights
           depending on the card's state. They are mutually exclusive in practice -- the lowest-offered private can
           never be bid on. */}
        <div style={styles.privateCardHeader}>
          {/* Design note #304: the printed number. 1830's privates are known by order as much as by name -- "the 3"
             is how players refer to the Delaware & Hudson -- and the waterfall IS that order, so the grid was
             showing a sequence with its index filed off. */}
          <span style={styles.privateCardName}>
            <span style={styles.privateCardNumber}>{priv.private_id}.</span> {priv.name}
          </span>
          <div style={styles.badgeSlot}>
            {priv.is_lowest_offered && <span style={styles.lowestBadge}>LOWEST OFFER</span>}
            {isCompetingBid && (
              <span
                style={
                  isCompetingInMiniAuction
                    ? styles.statusBadgeMiniAuction
                    : styles.statusBadgeCompeting
                }
                title={
                  isCompetingInMiniAuction
                    ? "A mini-auction is resolving this private right now — the whole waterfall is paused on it."
                    : "Two or more competing bidders — resolves via mini-auction (waterfall.rs module doc comment #3)."
                }
              >
                {isCompetingInMiniAuction ? "MINI-AUCTION LIVE" : "COMPETING BIDS"}
              </span>
            )}
            {isAutoAwardPending && (
              <span
                style={styles.statusBadgeAutoAward}
                title="Exactly one bidder — this private is awarded to them automatically on the next cascade."
              >
                AUTO-AWARD PENDING
              </span>
            )}
          </div>
        </div>

        {/* Face value and revenue as a paired figure row -- the two numbers
            a player compares across cards, so they sit together and large
            rather than as two lines of prose. */}
        <div style={styles.privateCardFigures}>
          <div style={styles.privateCardFigure}>
            <span style={styles.privateCardFigureValue}>{priv.face_value}</span>
            <span style={styles.privateCardFigureLabel}>face value</span>
          </div>
          {catalogEntry && (
            <div style={styles.privateCardFigure}>
              <span style={styles.privateCardFigureValueRevenue}>+{catalogEntry.revenue}</span>
              <span style={styles.privateCardFigureLabel}>revenue / OR</span>
            </div>
          )}
        </div>

        {/* ==================================================================
             DESIGN NOTE 1035: THE END DATE, WHERE THE PRICE IS
            ==================================================================
            REPORTED: "I don't think we have added the 'Automatically closes on Phase 5' or 'Closes on
            purchase of first 5-train' on the Auction Round PC cards to flag this to players at the start."
            AND IT IS THE ONE FIGURE THIS CARD WAS MISSING. The card already pairs face value with revenue per
            OR because those are "the two numbers a player compares across cards" -- but revenue per OR is
            only half a valuation without knowing how many ORs there are. A player bidding $200 on a private
            paying $25 is doing arithmetic whose answer depends entirely on this sentence, and nothing on
            screen said it.
            STATIC TEXT, NOT THE COUNTDOWN. The alert levels the pills carry are for mid-game, when the
            closure is two purchases off; here the game has not started and there is nothing to count. What a
            bidder needs is the RULE.
            THE TIER IS LOOKED UP, NOT TYPED, for #736's reason: this rule once lived in a caption while the
            code did something else, and a hard-coded "5" here would be a third statement of it. */}
        {closingTier !== null && (
          <div style={styles.privateCardClosure}>
            Closes when the first {closingTier}-train is bought
          </div>
        )}
      </div>

      {/* Special power. Design note #13: no enforcement badge -- all six
          privates are standard parts of this ruleset, and the card
          describes the piece rather than annotating backend coverage.
          Design note #772: BULLETS HERE, PARAGRAPH ON REQUEST. Six of these
          cards are on screen at once during the waterfall, which is the
          moment a player compares privates rather than studies one. */}
      {catalogEntry && (
        <SpecialPowerBlock
          entry={catalogEntry}
          ink={CARD_INK_MUTED}
          captionInk="#8a7332"
          detailBackground="rgba(138, 115, 50, 0.09)"
        />
      )}

      {/* Design note #19: ONE standings table. This card rendered two -- a standing-bids list and a
         mini-auction bidders list a few pixels apart, showing the SAME people with different columns. The
         obvious question is which one is current, and there was no answer because both were.
         During a mini-auction the one table gains TURN and LEADER tags rather than being duplicated. */}
      <div style={styles.privateCardBids} ref={bidListRef}>
        {priv.bids.length === 0 ? (
          <span style={styles.noBidsText}>
            {priv.is_lowest_offered ? "Buy outright at face value" : "No standing bids"}
          </span>
        ) : (
          sortedBids.map((bid) => {
            const isLeader = isCompetingInMiniAuction && miniAuction?.high_bidder === bid.bidder;
            const isTurn = isCompetingInMiniAuction && miniAuction?.current_turn === bid.bidder;
            return (
              <div
                key={bid.bidder}
                ref={isTurn ? turnRowRef : undefined}
                style={
                  bid.bidder === connectedWalletAddress ? styles.bidRowEntryOwn : styles.bidRowEntry
                }
              >
                <span style={styles.bidRowName}>
                  {nameFor(bid.bidder, playerLabel, 6, 4)}
                  {isTurn && <span style={styles.youBadge}>TURN</span>}
                  {/* Design note #321: A STAR, NOT A WORD. #302 was right about WHO it belongs on and wrong about the
                     shape: "LEADING" is seven characters saying what the largest number in the column already says, and it
                     sat next to "TURN", so the busiest row carried two shouted words competing for one glance.
                     The word survives as the `title`, and the `aria-label` is the sentence while the star is `aria-hidden`. */}
                  {isLeader && (
                    <span
                      style={styles.leadingStar}
                      title={`${nameFor(bid.bidder, playerLabel)} holds the high bid in this mini-auction.`}
                      aria-label="Leading bidder"
                      role="img"
                    >
                      {"\u2605"}
                    </span>
                  )}
                </span>
                <span style={styles.bidAmount}>${bid.bid_amount}</span>
              </div>
            );
          })
        )}
      </div>

      {/* ---- Actions, on the card face -- design note #17 ------------- */}
      <div style={styles.cardActions}>
          {isCompetingInMiniAuction && miniAuction ? (
            /* A mini-auction on THIS private. Its Raise and Pass live here,
               in the card the auction is about, rather than in a separate
               panel -- the contest belongs to one company and the controls
               should say so. */
            <>
              {/* Design note #26: no "Mini-auction" title here. The card
                  already carries a red MINI-AUCTION LIVE badge and a red
                  border; a third announcement of the same fact, directly
                  under the bidder list, was pure repetition. */}
              <span style={styles.cardActionsHint}>
                High bid ${miniAuction.high_bid} by {nameFor(miniAuction.high_bidder, playerLabel, 6, 4)}
                {" \u00b7 min raise "}
                ${minimumRaise}
              </span>

              {/* Design note #27: input, Raise and Drop Out on ONE line. Three stacked blocks with a hint between them
                 read as three unrelated decisions and cost four rows in a card that has to fit six across. They are one
                 decision -- how much, or not at all. */}
              <div style={styles.inlineActionRow}>
                <input
                  type="number"
                  style={styles.inlineNumberInput}
                  min={minimumRaise}
                  step={MIN_BID_INCREMENT}
                  value={raiseAmount}
                  onChange={(e) => setRaiseAmount(Number(e.target.value))}
                  disabled={!sessionReady || !isMyMiniTurn}
                  aria-label={`Raise amount for ${priv.name}`}
                />
                <button
                  type="button"
                  style={styles.inlineRaiseButton}
                  onClick={() => onMiniAuctionRaise(raiseAmount)}
                  disabled={!sessionReady || !isMyMiniTurn || raiseReason !== null}
                  title={
                    raiseReason ??
                    (ownRaiseEscrow > 0
                      ? `Raise your bid in this mini-auction. $${ownRaiseEscrow} of this is already escrowed, so only the increase is charged against your available cash.`
                      : "Raise your bid in this mini-auction.")
                  }
                >
                  Raise
                </button>
                <button
                  type="button"
                  style={styles.inlineDropButton}
                  onClick={onMiniAuctionPass}
                  disabled={!sessionReady || !isMyMiniTurn}
                  title="Drop out of this mini-auction. Your escrowed bid is refunded in full."
                >
                  Drop out
                </button>
              </div>
              {!isMyMiniTurn && (
                <span style={styles.cardActionsHint}>
                  Waiting for {nameFor(miniAuction.current_turn, playerLabel, 6, 4)}.
                </span>
              )}
            </>
          ) : canBuyOutright ? (
            /* The lowest-offered private: buyable at face value, never
               biddable (`waterfall.rs`'s `CannotBidOnLowest`). */
            <>
              <span style={styles.cardActionsTitle}>Buy at face value</span>
              <button
                type="button"
                style={styles.primaryButton}
                onClick={onBuyLowest}
                disabled={!sessionReady || !isMyMainTurn || buyReason !== null}
                title={buyReason ?? "Buys this company for face value."}
              >
                Buy {priv.name} &mdash; ${priv.face_value}
              </button>
              <span style={styles.cardActionsHint}>
                {buyReason && isMyMainTurn
                  ? buyReason
                  : isMyMainTurn
                    ? "This is the lowest-offered private, so it is bought outright rather than bid on."
                    : "Not your turn yet."}
              </span>
            </>
          ) : (
            /* Every other still-unowned private takes bids. */
            <>
              <span style={styles.cardActionsTitle}>
                {alreadyBidHere ? "Your bid stands" : "Place a bid"}
              </span>
              <div style={styles.bidRow}>
                <input
                  type="number"
                  style={styles.numberInput}
                  min={minimumBid}
                  step={MIN_BID_INCREMENT}
                  value={bidAmount}
                  onChange={(e) => setBidAmount(Number(e.target.value))}
                  // Design note #384: the FIELD goes too, not just the button. A live input above a dead button invites the
                  // player to type a figure and then discover it cannot be sent.
                  disabled={!sessionReady || !isMyMainTurn || alreadyBidHere}
                  aria-label={`Bid amount for ${priv.name}`}
                />
                <button
                  type="button"
                  style={styles.secondaryButton}
                  onClick={() => onBidHigher(priv.private_id, bidAmount)}
                  disabled={!sessionReady || !isMyMainTurn || bidReason !== null}
                  title={
                    bidReason ??
                    "Minimum bid = current high bid + $5. Funds are escrowed until this private is sold or auctioned."
                  }
                >
                  Place Bid
                </button>
              </div>
              {/* Design note #22: the backend explanation moved onto the button's tooltip. Three lines of `waterfall.rs`
                 reference sat permanently at the bottom of every card -- read once, then pure noise occupying space six
                 cards needed. The number stays visible; the reasoning is one hover away. */}
              <span style={styles.cardActionsHint}>
                {/* Design note #384: when the bid is refused for being a
                    repeat, the hint says so instead of reciting a minimum
                    the player is not allowed to meet. */}
                {alreadyBidHere ? (
                  `Bid $${ownRaiseEscrow}, escrowed until this private is sold or auctioned`
                ) : (
                  <>
                    Min ${minimumBid}
                    {funds && ` \u00b7 $${funds.available} available`}
                    {!isMyMainTurn && " \u00b7 not your turn"}
                  </>
                )}
              </span>
            </>
          )}
      </div>
    </div>
  );
}

/** A private that has been won -- design notes #28/#30. Holds its waterfall slot and greys out.
 *  `GetWaterfallState.privates` reports only STILL-UNOWNED companies, so this is fed from
 *  `GameStateResponse.private_companies`.
 *  THE PRICE IS FACE VALUE, not the winning bid: `PrivateCompanyState` exposes `cost` and `owner` and
 *  nothing else, so a private won in a mini-auction shows less than was paid. Exposing the settled price
 *  is a backend change; the tooltip says so. */
function SoldPrivateCard({
  sold,
  playerLabel,
  settledPrice,
}: {
  sold: { private_id: number; name: string; cost: string; owner: string | null };
  playerLabel?: (address: string) => string | null;
  /** Design note #303: what it actually went for, when that is known. */
  settledPrice?: number;
}) {
  const ownerLabel = nameFor(sold.owner ?? "", playerLabel, 6, 4);
  const paid = settledPrice ?? Number(sold.cost);
  /* Design note #340: winning a company should not erase it. The sold card rendered a header, one figure
     and a badge while the live card beside it rendered two figures and the special-power block -- so
     winning a company deleted the description of what had just been bought.
     That is backwards: before the sale the ability text is shopping information, after it it is the owner's
     REFERENCE. The catalog lookup is by `private_id`, the same key the live card uses. */
  const catalogEntry = PRIVATE_COMPANY_CATALOG[sold.private_id];
  return (
    <div style={styles.privateCardSold}>
      <div style={styles.privateCardHeader}>
        <span style={styles.privateCardName}>
          <span style={styles.privateCardNumber}>{sold.private_id}.</span> {sold.name}
        </span>
      </div>
      <div style={styles.privateCardFigures}>
        <div style={styles.privateCardFigure}>
          <span style={styles.privateCardFigureValue}>${sold.cost}</span>
          <span style={styles.privateCardFigureLabel}>face value</span>
        </div>
        {catalogEntry && (
          <div style={styles.privateCardFigure}>
            <span style={styles.privateCardFigureValueRevenue}>+{catalogEntry.revenue}</span>
            <span style={styles.privateCardFigureLabel}>revenue / OR</span>
          </div>
        )}
      </div>
      {catalogEntry && (
        /* The sold card keeps the caption: it is the same card in a later
           state, and dropping the label there would make the two read as
           different components rather than one before and after. */
        <SpecialPowerBlock
          entry={catalogEntry}
          ink={CARD_INK_MUTED}
          captionInk="#8a7332"
          detailBackground="rgba(138, 115, 50, 0.09)"
        />
      )}
      <div style={styles.soldBadgeWrap}>
        {/* Design note #30: the badge WRAPS. As a single nowrap line a long name plus a price overflowed the card
           and sat on the page behind it. Two stacked lines with `overflowWrap` keep "Champlain & St. Lawrence"
           inside the border at the narrowest grid column. */}
        <span
          style={styles.soldBadge}
          title={
            settledPrice === undefined
              ? "Face value \u2014 the settled price is not exposed by any query, and a private won in a mini-auction may have gone for more."
              : `${ownerLabel} won this for $${paid}. Face value $${sold.cost}.`
          }
        >
          <span style={styles.soldBadgeLine}>Sold to {ownerLabel}</span>
          <span style={styles.soldBadgePrice}>for ${paid}</span>
        </span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                      */
/* ------------------------------------------------------------------ */

/* Design note #31: the sandbox seats were distinct and looked identical. The addresses were never the
   problem -- TRUNCATION was: all four share a literal prefix padded with zeros, so `truncate` returned
   the same string four times. `playerLabel` existed and was used in exactly one place, while the turn
   banner, seating list, bid rows and mini-auction lines all called `truncate` directly.
   `nameFor` is now the only way an address reaches the DOM here, falling through to truncation for a real
   wallet -- a live game has no name table and 8/5 of a real address IS distinguishing. */
function nameFor(
  address: string,
  playerLabel: ((address: string) => string | null) | undefined,
  lead = 8,
  trail = 5,
): string {
  return playerLabel?.(address) ?? truncate(address, lead, trail);
}

function truncate(address: string, lead = 8, trail = 5): string {
  if (address.length <= lead + trail + 3) return address;
  return `${address.slice(0, lead)}...${address.slice(-trail)}`;
}

/* ------------------------------------------------------------------ */
/* Inline styles -- dense, widescreen-oriented layout (see header)    */
/* ------------------------------------------------------------------ */

const styles: Record<string, React.CSSProperties> = {
  root: {
    display: "flex",
    flexDirection: "column",
    gap: "14px",
    padding: "18px 20px",
    backgroundColor: "#161922",
    border: "1px solid #2a2e3a",
    borderRadius: "10px",
    color: "#e6e8ef",
    fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif",
    width: "100%",
    boxSizing: "border-box",
  },
  header: {
    display: "flex",
    alignItems: "baseline",
    gap: "14px",
    flexWrap: "wrap",
  },
  // Design note #26: leads with the same word as the tab ("Auction"), so
  // the tab and the panel it opens agree. The descriptive half moves to the
  // subtitle below rather than being dropped -- "Pre-Game Waterfall
  // Auction" says what this is, it just made a poor headline.
  headerTitle: {
    fontSize: FONT_SIZE.display,
    fontWeight: 800,
    textTransform: "uppercase",
    letterSpacing: "0.04em",
    color: "#e8dcc0",
  },
  headerSubtitle: {
    fontSize: FONT_SIZE.small,
    color: "#8a90a0",
  },
  headerHint: {
    fontSize: FONT_SIZE.control,
    color: "#8a90a0",
  },
  staleNote: {
    fontSize: FONT_SIZE.body,
    color: "#8a6d1f",
  },
  placeholderText: {
    fontSize: FONT_SIZE.strong,
    color: "#6f7480",
    margin: 0,
  },
  // Design note #11: STACKED, not side by side. Six cards squeezed beside a fixed 300px rail were too
  // narrow to read, and -- worse -- the rail sat immediately beside them, so shared controls read as
  // belonging to whichever card they were level with. The auction has one rail for all six privates and the
  // layout was implying six. The privates now own the full width and every interactive surface lives in one
  // separated band underneath.
  body: {
    display: "flex",
    flexDirection: "column",
    gap: "18px",
  },
  privateGrid: {
    display: "grid",
    // `auto-fit` rather than a hard `repeat(6, ...)`: six cards across is
    // unreadable below about 1500px, and this reflows to 3x2 or 2x3 on a
    // narrower window instead of crushing them.
    gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
    gap: "12px",
    minWidth: 0,
    // Design note #20: stretch so every card in a row is the height of the
    // tallest, which -- with `height: 100%` on the card and `marginTop:
    // auto` on its action block -- is what puts the Buy/Bid buttons on one
    // horizontal line across all six.
    alignItems: "stretch",
  },
  /* Design note #12: the cards have to look like certificates. Four points of lightness on the panel made
     six privates read as one block of text rather than six things you choose between.
     Design note #18: ONE FILL, STATE AT THE EDGES. Three near-whites here plus the Stock Round's two made
     five almost-matching paper tones -- not "colour-coded" but "inconsistently grubby". State is carried by
     the border, the accent stripe and the badges, which is enough signal precisely BECAUSE the fill is
     constant. Shared value in `styles/palette.ts` rather than typed twice. */
  privateCard: {
    display: "flex",
    flexDirection: "column",
    gap: "9px",
    padding: "14px 16px",
    backgroundColor: CARD_SURFACE,
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: CARD_BORDER,
    borderLeftWidth: "5px",
    borderLeftColor: CARD_ACCENT,
    borderRadius: "8px",
    height: "100%",
    minHeight: "260px",
    boxSizing: "border-box",
    boxShadow: "0 3px 14px rgba(0,0,0,0.45)",
  },
  /* Design note #38: the lowest-offered card's border is NEUTRAL. With a gold border, a gold glow, a green
     badge and a green button it carried three competing emphases and shouted before the player had read
     what it was. The green does the whole job, confined to the two elements a player acts on. */
  privateCardLowest: {
    display: "flex",
    flexDirection: "column",
    gap: "9px",
    padding: "14px 16px",
    backgroundColor: CARD_SURFACE,
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: CARD_BORDER,
    borderRadius: "8px",
    height: "100%",
    minHeight: "260px",
    boxSizing: "border-box",
    boxShadow: "0 2px 10px rgba(0, 0, 0, 0.28)",
  },
  /** A live mini-auction on this private -- the whole waterfall is paused
   *  on it, so it gets the strongest edge treatment of the three. */
  /** Design note #28: a won private -- present but inert. */
  privateCardSold: {
    display: "flex",
    flexDirection: "column",
    gap: "9px",
    padding: "14px 16px",
    backgroundColor: CARD_SURFACE,
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: CARD_BORDER,
    borderLeftWidth: "5px",
    borderLeftColor: "#8f8f8f",
    borderRadius: "8px",
    minHeight: "260px",
    boxSizing: "border-box",
    // Greyed rather than hidden: the board should still show all six.
    opacity: 0.55,
    filter: "grayscale(0.75)",
  },
  soldBadgeWrap: { marginTop: "auto", paddingTop: "12px" },
  soldBadge: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "1px",
    width: "100%",
    textAlign: "center",
    padding: "9px 10px",
    borderRadius: "8px",
    backgroundColor: "#e4e1d8",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: CARD_BORDER,
    color: CARD_INK_MUTED,
    boxSizing: "border-box",
  },
  /** Design note #30: wraps rather than overflowing. `anywhere` because a
   *  private's name can be one long unbroken token at a narrow width. */
  soldBadgeLine: {
    fontSize: FONT_SIZE.small,
    fontWeight: 800,
    overflowWrap: "anywhere",
    lineHeight: 1.25,
  },
  soldBadgePrice: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 700,
    fontVariantNumeric: "tabular-nums",
  },
  /* Design note #320: LAYOUT ONLY. Every paint property -- border, fill,
     shadow, animation -- is in the `.waterfall-miniauction-card` rule,
     because an inline style would override the stylesheet and kill the
     gradient. Anything added here that paints will break the chaser. */
  privateCardMiniAuction: {
    display: "flex",
    flexDirection: "column",
    gap: "9px",
    padding: "14px 16px",
    height: "100%",
    minHeight: "260px",
    boxSizing: "border-box",
  },
  /** Wrapper for the header + figures block -- a plain div since design note #17 removed the accordion.
   *  Design note #319: `cursor: pointer` came off with it, five notes late. The block has no `onClick`, so
   *  the hand cursor promised a click that does nothing -- and a player who tries it learns to distrust the
   *  cursor everywhere else. */
  privateCardToggle: {
    display: "flex",
    flexDirection: "column",
    gap: "9px",
    padding: 0,
    margin: 0,
    border: "none",
    background: "transparent",
    font: "inherit",
    color: "inherit",
    textAlign: "left",
    cursor: "default",
    width: "100%",
  },
  expandChevron: {
    marginLeft: "auto",
    alignSelf: "center",
    fontSize: FONT_SIZE.small,
    color: CARD_INK_FAINT,
  },
  /** Design note #31: the shared badge row. Wraps rather than overflowing
   *  if a card ever carries two at once. */
  badgeSlot: { display: "flex", flexWrap: "wrap", gap: "4px" },
  privateCardHeader: {
    display: "flex",
    flexDirection: "column",
    gap: "4px",
  },
  privateCardName: {
    fontSize: FONT_SIZE.strong,
    fontWeight: 800,
    color: CARD_INK,
  },
  lowestBadge: {
    alignSelf: "flex-start",
    fontSize: FONT_SIZE.micro,
    fontWeight: 700,
    letterSpacing: "0.05em",
    color: CARD_BUY_GREEN_INK,
    backgroundColor: CARD_BUY_GREEN_TINT,
    border: `1px solid ${CARD_BUY_GREEN}`,
    borderRadius: "4px",
    padding: "2px 6px",
  },
  privateCardFaceValue: {
    fontSize: FONT_SIZE.small,
    color: "#8a90a0",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  },
  /* Design note #21: THE BID TABLE MUST NOT GROW THE CARD. Six bidders push the card past its siblings'
     height, and because grid rows stretch, ONE contested company inflates every card in its row and drags
     the buttons out of alignment. Capped at ~3.5 rows -- the leader plus the chase, with a cut-off edge to
     show there is more. `flexShrink: 0` on the action block keeps the buttons anchored. */
  privateCardBids: {
    maxHeight: "104px",
    overflowY: "auto",
    // Design note #23: makes this the rows' `offsetParent`, so the
    // auto-scroll measurement is relative to the scroller and not to some
    // ancestor further up the tree.
    position: "relative",
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
    gap: "4px",
    marginTop: "4px",
  },
  noBidsText: {
    fontSize: FONT_SIZE.small,
    color: CARD_INK_FAINT,
    fontStyle: "italic",
  },
  /** Name + tags on the left, amount on the right -- design note #19's
   *  single standings table. */
  bidRowName: {
    display: "inline-flex",
    alignItems: "center",
    gap: "6px",
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  bidRowEntry: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    justifyContent: "space-between",
    fontSize: FONT_SIZE.small,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    color: CARD_INK,
    padding: "2px 6px",
    borderRadius: "4px",
  },
  bidRowEntryOwn: {
    display: "flex",
    justifyContent: "space-between",
    fontSize: FONT_SIZE.small,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    color: "#14522f",
    backgroundColor: "#dcf0e2",
    padding: "2px 6px",
    borderRadius: "4px",
  },
  bidAmount: {
    fontWeight: 700,
  },
  privateCardRevenue: {
    fontSize: FONT_SIZE.small,
    color: CARD_INK_MUTED,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  },
  // ---- Paired figure row: the two numbers that decide which private a
  // player wants, sized to be comparable across cards at a glance. ----
  privateCardFigures: { display: "flex", gap: "18px", alignItems: "flex-end" },
  privateCardFigure: { display: "flex", flexDirection: "column", gap: "1px" },
  privateCardFigureValue: {
    fontSize: FONT_SIZE.heading,
    fontWeight: 800,
    color: CARD_INK,
    fontVariantNumeric: "tabular-nums",
    lineHeight: 1.1,
  },
  privateCardFigureValueRevenue: {
    fontSize: FONT_SIZE.heading,
    fontWeight: 800,
    color: CARD_INK_POSITIVE,
    fontVariantNumeric: "tabular-nums",
    lineHeight: 1.1,
  },
  privateCardFigureLabel: {
    fontSize: FONT_SIZE.micro,
    color: CARD_INK_FAINT,
    textTransform: "uppercase",
    letterSpacing: "0.4px",
  },
  /* Design note #1035: QUIET, AND NOT A WARNING. Six of these are on screen at once and nothing is imminent
     -- the game has not started. This is the card's small print, sitting under the figures it qualifies, in
     the same faint ink as their labels rather than in the amber the mid-game pills use. */
  privateCardClosure: {
    marginTop: "6px",
    fontSize: FONT_SIZE.micro,
    color: CARD_INK_FAINT,
    fontStyle: "italic",
  },
  /* ---- Special power ---- The three keys that lived here (`privateCardAbility`, `...Block`, `...Label`)
     moved into `SpecialPowerBlock` with #772's markup. Deleted rather than left: `styles` is typed
     `Record<string, CSSProperties>`, so an unreferenced key is invisible to both `tsc` and ESLint and would
     sit here indefinitely as a plausible-looking thing to reach for. The block's inks are passed as props
     from the card -- see the note in that file on why the palette is not a global. */
  statusBadgeRow: {
    display: "flex",
    flexWrap: "wrap",
    gap: "4px",
    marginTop: "2px",
  },
  statusBadgeEscrow: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 700,
    color: "#1c4a63",
    backgroundColor: "#dcecf5",
    border: "1px solid #7fb2cc",
    borderRadius: "4px",
    padding: "2px 6px",
    whiteSpace: "nowrap",
  },
  /** Design note #29: RED, reserved for the live mini-auction. */
  statusBadgeMiniAuction: {
    alignSelf: "flex-start",
    fontSize: FONT_SIZE.micro,
    fontWeight: 800,
    letterSpacing: "0.4px",
    padding: "2px 9px",
    borderRadius: "999px",
    color: "#7a2020",
    backgroundColor: "#f8dcd6",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: CARD_BORDER_CONTESTED,
  },
  statusBadgeAutoAward: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 700,
    color: "#14522f",
    backgroundColor: "#d9f0e1",
    border: "1px solid #6cb98b",
    borderRadius: "4px",
    padding: "2px 6px",
    whiteSpace: "nowrap",
  },
  /** Design note #29: ORANGE. Competing bids and a live mini-auction are different states -- "this will
   *  need resolving" versus "this is being resolved now, and the whole waterfall is paused on it". Both were
   *  red, which flattened the distinction; red is reserved for the live one. */
  statusBadgeCompeting: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 700,
    color: "#8a4a10",
    backgroundColor: "#fbe6cd",
    border: "1px solid #d09040",
    borderRadius: "4px",
    padding: "2px 6px",
    whiteSpace: "nowrap",
  },
  highestBidderLine: {
    fontSize: FONT_SIZE.micro,
    color: CARD_INK_MUTED,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  },
  // Design note #11: the interaction band, a horizontal row BELOW the privates. The heavy top border and
  // recessed background state that this area serves all six cards above, which is exactly the confusion the
  // old side-by-side layout caused.
  // Design note #14: the expanded action drawer inside a card -- a recessed well, separated by a rule.
  cardActions: {
    display: "flex",
    flexDirection: "column",
    gap: "8px",
    // Design note #20: THE BUTTONS FORM A LINE. `marginTop: auto` in a full-height flex column pushes this
    // to the card's bottom edge, so six buttons align instead of following each private's special-power text,
    // which runs from one line to three.
    marginTop: "auto",
    // Design note #21: never compressed by a long bid table above it.
    flexShrink: 0,
    paddingTop: "12px",
    borderTopWidth: "1px",
    borderTopStyle: "solid",
    borderTopColor: CARD_DIVIDER,
  },
  /* ---- Design note #27: single-line action row ---- */
  inlineActionRow: { display: "flex", alignItems: "center", gap: "6px", flexWrap: "nowrap" },
  inlineNumberInput: {
    flex: "1 1 60px",
    minWidth: 0,
    width: "100%",
    fontSize: FONT_SIZE.small,
    fontWeight: 700,
    padding: "7px 8px",
    borderRadius: "6px",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: CARD_DIVIDER,
    backgroundColor: "#ffffff",
    color: CARD_INK,
    fontVariantNumeric: "tabular-nums",
    boxSizing: "border-box",
  },
  inlineRaiseButton: {
    flex: "0 0 auto",
    fontSize: FONT_SIZE.small,
    fontWeight: 800,
    padding: "7px 12px",
    borderRadius: "6px",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "#2c6e4a",
    backgroundColor: "#1a4530",
    color: "#a8f0c8",
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  inlineDropButton: {
    flex: "0 0 auto",
    fontSize: FONT_SIZE.small,
    fontWeight: 700,
    padding: "7px 12px",
    borderRadius: "6px",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "#a06a5a",
    backgroundColor: "transparent",
    color: "#8a4a38",
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  cardActionsTitle: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 800,
    letterSpacing: "0.5px",
    textTransform: "uppercase",
    color: CARD_INK_FAINT,
  },
  cardActionsHint: {
    fontSize: FONT_SIZE.micro,
    color: CARD_INK_FAINT,
    lineHeight: 1.4,
  },
  /* Design note #604: eighteen `actionRail*` / `actionCard*` / `seating*`
     styles deleted here, with the seating table (design note #593) and the
     empty rail left standing after it. `playersPanel` brings its own card
     chrome, so nothing in this file dresses a player row any more. */
  miniAuctionCard: {
    display: "flex",
    flexDirection: "column",
    gap: "8px",
    padding: "12px",
    backgroundColor: "#211c0f",
    border: "1px solid #6b5a1f",
    borderRadius: "8px",
  },
  // The Buy button on the lowest-offered private -- the panel's only
  // outright purchase, and its only green control. See `CARD_BUY_GREEN`.
  primaryButton: {
    padding: "10px 12px",
    fontSize: FONT_SIZE.body,
    fontWeight: 700,
    color: "#ffffff",
    backgroundColor: CARD_BUY_GREEN,
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: CARD_BUY_GREEN_DARK,
    borderRadius: "6px",
    cursor: "pointer",
  },
  secondaryButton: {
    padding: "9px 14px",
    fontSize: FONT_SIZE.body,
    fontWeight: 600,
    color: "#e6e8ef",
    backgroundColor: "#2a2e3a",
    border: "1px solid #3a3f4d",
    borderRadius: "6px",
    cursor: "pointer",
  },
  passButton: {
    padding: "9px 12px",
    fontSize: FONT_SIZE.body,
    fontWeight: 600,
    color: "#c8cbd6",
    backgroundColor: "transparent",
    border: "1px solid #3a3f4d",
    borderRadius: "6px",
    cursor: "pointer",
  },
  bidRow: {
    display: "flex",
    gap: "6px",
  },
  select: {
    flex: "1 1 auto",
    minWidth: 0,
    padding: "8px",
    fontSize: FONT_SIZE.small,
    backgroundColor: "#0f1115",
    color: "#e6e8ef",
    border: "1px solid #3a3f4d",
    borderRadius: "6px",
  },
  numberInput: {
    width: "90px",
    padding: "8px",
    fontSize: FONT_SIZE.small,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    backgroundColor: "#0f1115",
    color: "#e6e8ef",
    border: "1px solid #3a3f4d",
    borderRadius: "6px",
  },
  hintText: {
    fontSize: FONT_SIZE.micro,
    color: "#8a90a0",
  },
  /* Design note #422: prominent, and no longer shouting. `ON TURN` was tracked-out uppercase because it
     was a status tag at the end of a row; "Your turn" is a sentence fragment addressed to the reader. */
  turnBadge: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 800,
    color: "#0d1117",
    backgroundColor: "#7ee0a1",
    borderRadius: "4px",
    padding: "2px 7px",
    whiteSpace: "nowrap",
  },
  youBadge: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 700,
    color: "#8ee08a",
    border: "1px solid #2f5a2f",
    borderRadius: "4px",
    padding: "1px 5px",
  },
  /* Design note #302: red. It marks the player everyone else must outbid -- an alarm for the other bidders
     rather than a decoration for the leader.
     Design note #306: the end-of-auction step. Full width and green -- it is the only thing to do on this
     screen once the grid is empty, and a quiet control in that position reads as decoration. */
  auctionOverBanner: {
    display: "flex",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: "10px",
    padding: "10px 12px",
    borderRadius: "8px",
    border: "1px solid #2f7d55",
    backgroundColor: "#16241d",
  },
  auctionOverText: { fontSize: FONT_SIZE.strong, fontWeight: 700, color: "#cfe9d9" },
  proceedButton: {
    padding: "7px 16px",
    borderRadius: "8px",
    border: "1px solid #2f7d55",
    backgroundColor: "#1d5c40",
    color: "#eafff2",
    fontSize: FONT_SIZE.control,
    fontFamily: "inherit",
    fontWeight: 700,
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  /* Design note #321: standalone glyph, no plate. A pill around a single character reads as a badge that
     has lost its label. Sized a step above body text so it is findable down a column, with a soft gold
     shadow so it holds against the card without a background. */
  leadingStar: {
    fontSize: FONT_SIZE.control,
    lineHeight: 1,
    color: "#f2c14e",
    marginLeft: "5px",
    textShadow: "0 0 6px rgba(242, 193, 78, 0.55)",
    cursor: "help",
  },
  privateCardNumber: { color: "#8a919e", fontWeight: 800 },
  leaderBadge: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 700,
    color: "#d4a94c",
    border: "1px solid #6b5a1f",
    borderRadius: "4px",
    padding: "1px 5px",
  },
};
