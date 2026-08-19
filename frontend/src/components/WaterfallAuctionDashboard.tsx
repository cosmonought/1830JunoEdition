// frontend/src/components/WaterfallAuctionDashboard.tsx
//
// Pre-Game Waterfall Auction Engine (`waterfall.rs`) -- the interactive
// dashboard for allocating 1830's six private companies before Stock Round 1
// opens. `App.tsx` renders this in place of the normal contextual action bar
// + board canvas + contextual sub-panel for the ENTIRE duration of
// `GameStateResponse.current_round_type === "WaterfallAuction"` (see that
// file's own wiring, and `ContextualSubPanel.tsx`'s `WaterfallAuctionNotice`
// for the short pointer it shows instead of duplicating this UI). There is
// no board or stock market to look at yet during this phase, so this
// component is the room's entire canvas, not a small tray bolted onto the
// existing layout.
//
// LAYOUT (design notes #11/#17/#20). The six private-company cards own the
// full width at the top and ARE the interface: each carries its own action
// on its face -- Buy for the lowest-offered private, Place Bid for the
// rest, Raise/Drop-out for one under a live mini-auction -- with the
// buttons bottom-anchored so they align across all six. Underneath sits a
// slim strip showing whose turn it is and the seating order.
//
// Three earlier layouts are superseded. A right-hand action rail beside the
// cards squeezed six columns into the leftover width and made shared
// controls read as belonging to whichever card they were level with. A
// full-width tray below them fixed that ambiguity but left the cards
// read-only, so choosing a company and acting on it happened in two places
// connected only by a dropdown. Then an accordion per card, which put a
// click in front of every single-button action.
//
// Pass and Undo are NOT here at all -- they are turn-level actions and live
// in the single app-wide action bar `App.tsx` renders above every active tab
// (`ContextualActionBar`, design note #31 there).
//
// Design notes:
// 1. **Driven entirely by `QueryMsg::GetWaterfallState`.** `waterfallState`
//    is `utils/gameState.ts`'s `useWaterfallStatePolling` result, already
//    gated by `App.tsx` to only actually poll while this phase is current
//    (see that hook's own doc comment, design note #7 in `gameState.ts`).
//    This component itself does no gating of its own beyond a loading/error
//    placeholder -- it trusts the caller only renders it during the
//    Waterfall Auction.
// 2. **Private company grid, always all six, in the order the query
//    already returns them (ascending face value).** Reflows from six across
//    down to three or two as the window narrows (design note #11 -- a hard
//    six-column grid was unreadable below about 1500px). Each card shows its own
//    live bid list (`WaterfallBidEntry[]`), highlighting the connected
//    wallet's own standing bid if it has one, and a gold "LOWEST OFFER"
//    badge on whichever one `is_lowest_offered` marks -- the only one
//    `WaterfallBuyLowest` can currently target, and the only one that can
//    never be bid on (mirrors `waterfall.rs`'s own `CannotBidOnLowest`
//    rejection). A private disappears from this row entirely once owned
//    (mirrors `query::query_waterfall_state`'s own "still-unowned only"
//    scope) -- there's no owned-private card state to render.
// 3. **Turn gating mirrors `ContextualActionBar`'s own `sessionReady`
//    convention exactly**, plus a second, Waterfall-specific gate: every
//    action button is ALSO disabled unless it's actually the connected
//    wallet's turn (`waterfallState.current_turn` for the three main turn
//    actions, `mini_auction.current_turn` for the two mini-auction actions)
//    -- both because the contract itself will reject an out-of-turn call
//    (`NotYourTurn`/`NotYourMiniAuctionTurn`), and so the room's other
//    players get a clear, honest "not your turn yet" instead of a
//    guaranteed-failing button. The Pass button additionally disables
//    `waterfall.rs`'s `PassNotAllowed` legality rule (module doc comment
//    #1) is still mirrored client-side, but now by the global action bar
//    that owns the Pass button -- `App.tsx` computes it from
//    `waterfallState` and hands this component nothing to do with passing.
// 4. **Bid amount defaults, doesn't lock.** Every bid/raise input auto-fills
//    to the live legal minimum (face value, or standing high bid + the $5
//    `auction::MIN_BID_INCREMENT`) and re-floors itself whenever a rival bid
//    moves that minimum underneath it -- so a player never hand-computes the
//    floor -- but stays a normal editable number input, since bidding above
//    the minimum is always legal too.
// 5. **Mini-auction controls live in the contested card**, not in a
//    separate panel. A mini-auction pauses the WHOLE waterfall for every
//    player (`waterfall.rs` module doc comment #3). Raise/Drop-out are
//    gated by `mini_auction.current_turn` -- the leader's own turn is never
//    offered because the backend (`waterfall::skip_leader_turns`) never
//    points `current_turn` at them, so no client-side "you're the leader"
//    guard is needed.
// 6. **ONE standings table per card** (design note #19). The card's bid
//    list is the only table; during a mini-auction it gains TURN and LEADER
//    tags rather than being shadowed by a second list of the same people.

import React, { useEffect, useRef, useState } from "react";
import { FONT_SIZE } from "../styles/typography";
import { PRIVATE_COMPANY_CATALOG } from "../utils/privateCatalog";
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


/* ==================================================================
 *  DESIGN NOTE 314: WHOSE MONEY THE CONTROLS ARE ABOUT TO SPEND
 * ==================================================================
 *
 * The Available Cash figure and the bid gates have to agree on one seat,
 * and which seat that is differs by mode.
 *
 * ONLINE the answer is the connected wallet, always -- a player watching
 * somebody else's turn still wants to see what THEY can afford, and the
 * controls are disabled anyway.
 *
 * HOTSEAT has no wallet, so the only seat the controls could be acting for
 * is the one on turn, and during a mini-auction that is the mini-auction's
 * cursor rather than the main one. Getting this wrong is not cosmetic: it
 * would gate Alice's raise against Bob's balance.
 */
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
  /* ==================================================================
   *  DESIGN NOTE 30: HOTSEAT HAS NO WALLET TO COMPARE AGAINST
   * ==================================================================
   *
   * REPORTED: the Auction round is completely non-interactive in Sandbox.
   *
   * Every control here is gated on `current_turn === connectedWalletAddress`
   * -- correct online, where the question "is this my turn" means "is the
   * seat on turn the one I signed in as". The sandbox has no wallet, so
   * `connectedWalletAddress` is empty, the comparison is false for every
   * seat, and the whole screen renders as somebody else's turn forever.
   *
   * Pass-and-play asks a different question: not "is this seat mine" but
   * "is anyone at this keyboard allowed to act for the seat on turn". In
   * hotseat the answer is always yes -- that is what pass-and-play IS.
   *
   * A SEPARATE FLAG RATHER THAN A FAKE ADDRESS. The tempting shortcut is to
   * hand the sandbox `connectedWalletAddress = current_turn` and let the
   * existing comparison pass. That would also make every "YOU" badge and
   * own-bid highlight follow the turn around the table, which is exactly
   * the confusion requirement 1 is about -- the seats would stop being
   * distinguishable again. `hotseat` unlocks the CONTROLS and leaves the
   * identity comparisons alone. */
  hotseat?: boolean;
  /** Design note #303 (`App.tsx`): what each private actually SOLD for, by
   *  id. A mini-auction settles above face value, and the sold card used to
   *  quote the face value with a tooltip apologising for it. Empty on a
   *  live chain, where the card falls back to face value as before. */
  settledPrices?: Readonly<Record<number, number>>;
  /* ==================================================================
   *  DESIGN NOTE 306: "IS CONCLUDING" IS NOT A STATE A PLAYER CAN LEAVE
   * ==================================================================
   *
   * With every private allocated the grid said "the Waterfall Auction is
   * concluding" and offered nothing. That is a progress message for a
   * process the player is waiting on -- but nothing was in progress: the
   * auction was over and the round needed advancing, which is an action
   * somebody has to take.
   *
   * So the message states what happens next and the button does it.
   * Omitted (`undefined`) leaves the message without a control, which is
   * the right shape on a live chain where the contract advances the round
   * on its own and a client-side button would be a lie. */
  onProceedToStockRound?: () => void;
  /** Dispatches `ExecuteMsg::WaterfallBuyLowest`. */
  onBuyLowest: () => void;
  /** Dispatches `ExecuteMsg::WaterfallBidHigher`. */
  onBidHigher: (privateId: number, bidAmountVgp: number) => void;
  /** Dispatches `ExecuteMsg::WaterfallMiniAuctionRaise`. */
  onMiniAuctionRaise: (bidAmountVgp: number) => void;
  /** Dispatches `ExecuteMsg::WaterfallMiniAuctionPass`. */
  onMiniAuctionPass: () => void;
}

/** Design note #32: injected keyframes. Inline `React.CSSProperties` cannot
 *  express `@keyframes`, so this follows the same `<style>`-tag convention
 *  `App.tsx` already uses for its turn-pulse animation. */
/* ==================================================================
 *  DESIGN NOTE 320: AN EVENT, NOT AN EMERGENCY
 * ==================================================================
 *
 * REPORTED: the mini-auction card's border glow should be an animated
 * multicolour chaser rather than a warning hue.
 *
 * The old ring pulsed red, and red on this screen already means something
 * else. `phaseShiftBadgeCritical`, the rust chips and every disabled-reason
 * tooltip use the warning palette for things that are going WRONG or are
 * about to; a mini-auction is the most interesting thing that can happen in
 * the auction and nothing is wrong at all. A player who has learned that
 * red means trouble reads the liveliest card on the board as an alert.
 *
 * HOW IT IS BUILT. Two background layers on one element: an opaque fill
 * clipped to the PADDING box, and the gradient clipped to the BORDER box.
 * The fill covers the middle, so the only gradient left visible is the
 * 3px ring -- a real animated border with no pseudo-element and no
 * stacking-context tricks.
 *
 * WHY NOT A ROTATING `conic-gradient` ON A `::before`, which is the usual
 * recipe: a rotating rectangle does not cover its own bounding box at the
 * corners, so the ring tears diagonally four times per turn unless the
 * layer is oversized into a square and re-centred. `background-position` on
 * a repeating linear gradient has no such geometry, animates a property
 * every engine interpolates, and needs no `@property` registration.
 *
 * THE PALETTE deliberately runs the full hue circle rather than a two- or
 * three-stop blend: the point is that it is unmistakably not any of the
 * status colours this UI already assigns meaning to.
 *
 * REDUCED MOTION keeps design note #26's bargain -- the ring stays, in a
 * static multicolour, so the card is still identifiable without the spin.
 * A cue that cannot be switched off is an accessibility problem; a cue
 * that DISAPPEARS when motion is reduced is an information problem, and
 * turning the animation off must not cost the player the answer to "which
 * card is live". */
/* ==================================================================
 *  DESIGN NOTE 344: THE CHASER HAD A DARK GAP EVERY CYCLE
 * ==================================================================
 *
 * REPORTED: the chaser pulses briefly, goes dark and restarts instead of
 * flowing continuously.
 *
 * The animation was right; the TILING was not. The gradient layer carried
 * `background-repeat: no-repeat`, so as the keyframes translated it the
 * single painted tile slid off the border and left bare transparent border
 * behind it. The ring lit up, drained to dark as the tile departed, then
 * snapped back when the iteration restarted -- exactly "pulses, goes dark,
 * restarts", and it was one word away from correct the whole time.
 *
 * TWO CONDITIONS MAKE IT SEAMLESS, and both have to hold:
 *
 *   1. THE TILE REPEATS. `background-repeat: no-repeat, repeat` -- the
 *      opaque fill must NOT repeat (it is sized to the box), the gradient
 *      must, so there is always another copy arriving behind the one
 *      leaving.
 *
 *   2. ONE CYCLE MOVES EXACTLY ONE TILE. A percentage in
 *      `background-position` is a fraction of (positioning area - image
 *      width), NOT of the area -- so with `background-size: 200%` the
 *      image is 2W wide, the base is (W - 2W) = -W, and `200%` resolves to
 *      -2W. The tile is 2W. One tile exactly, and the W cancels, so it
 *      holds at every card width. Change the 200% in `background-size`
 *      without changing the 200% in the keyframe and the loop visibly
 *      stutters once per cycle.
 *
 * The palette's first and last stops are the SAME colour for the same
 * reason: the tile has to butt against its own copy without a seam.
 */
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
}: WaterfallAuctionDashboardProps) {
  const privates = waterfallState?.privates ?? [];
  /* Design note #314: the seat whose money the controls spend. In hotseat
     that is whoever is on turn (there is no wallet to compare against);
     online it is the connected player, whose funds stay on screen even
     while somebody else acts. */
  /* Design note #593: `ownedPrivatesFor` went with the seating table it fed.
   The player cards list a seat's privates from `playerFinances`, which reads
   the same state -- and is now the only place computing it. */

  const fundsSeat =
    (miniAuctionSeat(waterfallState, hotseat) ?? connectedWalletAddress) ?? null;
  const viewerFunds = fundsSeat ? auctionFunds(gameState, waterfallState, fundsSeat) : null;
  /* ---- Design note #30: ONE ORDERED GRID, sold cards in place --------
   *
   * Sold privates were appended AFTER the live ones, which pushed them to
   * the end of the grid -- so winning the cheapest private visually moved
   * it to the far right, past companies worth ten times as much. The
   * waterfall's whole structure is its ascending face-value order; a card
   * that jumps position on being sold destroys the one thing the layout is
   * communicating.
   *
   * Live and sold are now merged and sorted by face value, so every card
   * holds its waterfall slot for the entire auction and simply greys out
   * when it is won. */
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

  /* ---- Design note #17: FLAT ACTIONS, NO ACCORDION -------------------
   *
   * Two shapes were tried before this one and both were wrong in opposite
   * directions.
   *
   * A shared bid tray at the bottom (design note #11) made the six cards a
   * read-only display: you picked a company by name in a dropdown, then
   * typed a number somewhere else, with nothing connecting the two but your
   * own attention.
   *
   * Making each card an accordion (design note #14) fixed that ambiguity
   * and introduced a worse one -- a click to open before any action, on a
   * screen where there are only six cards and every one of them has exactly
   * ONE legal action. An accordion earns its keep when the hidden content
   * is large or rarely wanted. Here it hid a single button behind a click,
   * six times over, on the screen a player uses most rapidly.
   *
   * So the action lives on the card face. Every card shows either Buy (the
   * lowest-offered private, bought outright) or Place Bid with its input,
   * and a card under a live mini-auction shows Raise and Drop-out in the
   * same place. Nothing is hidden and nothing needs opening. */
  /* Design note #30: in hotseat the seat on turn is always actionable; the
     wallet comparison only decides it when there IS a wallet. */
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
      {/* ==================================================================
           DESIGN NOTE 305: ONE LINE, NOT THREE SAYING THE SAME THING
          ==================================================================

          The header was a title ("Auction"), a subtitle ("Pre-game private
          company waterfall") and a hint ("Allocating six private companies
          before Stock Round 1") -- three restatements of the same fact
          stacked vertically, followed by the one piece of live information
          in the row.

          A player reads a header once. Everything above the pass count was
          telling them where they already knew they were, and it cost three
          lines at the top of the screen the map is trying to use. */}
      <div style={styles.header}>
        <span style={styles.headerTitle}>Private Company Waterfall Auction</span>
        <span style={styles.headerHint}>
          {"\u2014 "}
          {waterfallState.consecutive_waterfall_passes > 0
            ? `${waterfallState.consecutive_waterfall_passes} consecutive pass(es) so far`
            : "no passes yet"}
        </span>
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

        {/* Design note #547: the BUTTON moved to `AuctionPromptModal`. It sat
            at the foot of a scrolling six-card grid -- the last place a
            player who has finished reading is still looking -- which is the
            visible form of the problem design note #306 named: the round was
            waiting on an action nobody could see they had to take. The
            banner stays, because the grid still needs to say why it is
            empty. */}
        {privates.length === 0 && (
          <div style={styles.auctionOverBanner}>
            <span style={styles.auctionOverText}>
              The Waterfall Auction is complete. Up next is the Stock Round.
            </span>
          </div>
        )}

        {/* ---- Seating + hint -- design notes #11/#14 -----------------
            All the BUY/BID/PASS controls moved into the cards above. What
            remains here is the one thing that is genuinely global rather
            than per-company: the seating order, and who in it is up.

            ==================================================================
             DESIGN NOTE 322: ONE ANSWER TO "WHOSE TURN IS IT"
            ==================================================================

            REPORTED: the standalone Turn panel in the auction footer is
            redundant.

            It was, and it had become so by accretion rather than by
            design. The panel was built when the footer was the only place
            the turn appeared -- then design note #32 added `ON TURN` to
            the seating rows, and design note #308 put the acting player's
            name and cash on the action bar at the top of the screen. Three
            surfaces, one fact, and the panel was the weakest of the three:
            it named the seat without saying where that seat sat in the
            order, which is the question a player in an auction actually
            has.

            The seating table answers both at once, so the banner goes and
            the table stays. What does NOT go is the hint line -- it says
            where the controls are, which nothing else on this screen
            does, and it was merely housed in the same panel. */}
        {/* ==================================================================
             DESIGN NOTE 341: THE TABLE IS THE PANEL
            ==================================================================

            REPORTED: remove the large text-explanation panel at the bottom
            of the Auction tab; expand the Seating Order to the full width
            and add a column for the privates each player owns.

            The hint block was the last survivor of the old footer (design
            note #322 removed the Turn banner beside it), and it had the
            same weakness: it was prose about where the controls are, on a
            screen where the controls are on the cards a few inches above
            and labelled. It cost half the footer's width to say something
            a player learns once.

            What replaces it is not empty space. The seating table takes the
            whole width and spends it on the column the auction was missing:
            WHO OWNS WHAT. Cash says what a player can still bid; the
            privates say what they have already committed to and what income
            they are drawing -- and until now the only way to see another
            player's holdings was to read the sold cards and remember four
            names. */}
        <div style={styles.actionRail}>
          {gameState && gameState.player_addresses.length > 0 && (
            <div style={styles.actionRailFull}>
              <div style={styles.seatingCard}>
                {/* ==================================================
                     DESIGN NOTE 422: THREE COLUMNS, THREE HEADINGS
                    ==================================================

                    REPORTED: head these columns "Player Information",
                    "Cash" and "Privates".

                    They had one heading between them -- a right-aligned
                    hint reading "Available / held · Privates owned", which
                    described two of the three columns in a single string
                    parked over neither of them. A reader had to map a
                    slash-separated phrase onto a flex row by position.

                    The labels now sit ON their columns, using the same
                    basis values the rows do (`0 0 128px` for privates, the
                    cash cell's `marginLeft: auto`), so heading and data
                    line up at every window width rather than approximately.

                    "Available / held" is not lost -- it was the more
                    precise of the two phrases, and it survives where it
                    belongs: in each cash cell's own tooltip, which already
                    spelled out the total, the escrow and the available
                    figure separately. */}
                {/* ==================================================
                     DESIGN NOTE 593: THE SEATING TABLE IS GONE
                    ==================================================

                     INSTRUCTED: "the Player cards that we've created for the
                     Stock Round should replace the Seating Order panel during
                     the Auction round -- the Player cards are receiving
                     positive feedback compared to the table for quick
                     reference by testers."

                     THE CARDS CARRY MORE, not less: the same cash and escrow,
                     plus each seat's certificate count, liquidity and
                     private companies with their rules text -- and they are
                     the same object a player has already learned to read in
                     the Stock Round, rather than a second layout for the same
                     eight facts.

                     WHAT THE TABLE DID BETTER was turn order, which a column
                     of rows states by construction. That is now written into
                     each card's stripe as an ordinal (design note #593 in
                     `PlayerCards.tsx`) rather than left to the grid's layout,
                     which reflows and therefore cannot be trusted to mean
                     anything at a given width.

                     REMOVED RATHER THAN HIDDEN. Two views of one roster on
                     one screen is the duplication design note #572 has
                     already deleted once this month. */}

              </div>
            </div>
          )}
        </div>
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
  const sortedBids = priv.bids.slice().sort((a, b) => Number(b.bid_amount) - Number(a.bid_amount));

  // Status indicators -- grounded directly in `waterfall.rs`'s own real
  // cascade semantics (module doc comment #3), not fabricated logic: 0 bids
  // leaves a private simply open, exactly 1 bid is what the next cascade
  // run auto-resolves to that sole bidder ("auto-award"), 2+ bids is what
  // starts (or, if already running, IS) a mini-auction.
  const isCompetingInMiniAuction = miniAuction?.private_id === priv.private_id;
  const isAutoAwardPending = !priv.is_lowest_offered && priv.bids.length === 1;
  const isCompetingBid = !priv.is_lowest_offered && (priv.bids.length >= 2 || isCompetingInMiniAuction);

  /* ---- Which action this card offers -- design note #14 --------------
   *
   * Mirrors `waterfall.rs`'s own legality rules rather than inventing a
   * scheme: the lowest-offered private is the ONLY one `WaterfallBuyLowest`
   * can target and the only one that can never be bid on
   * (`CannotBidOnLowest`); every other still-unowned private takes bids at
   * face value or +$5 over the standing high. So each card offers exactly
   * one of three things, and never a choice between them. */
  /* Design note #22: the OPENING bid is face value PLUS the increment, not
   * face value itself.
   *
   * A bid at face value would be worth exactly what the lowest-offered
   * private can be bought outright for, so it offers the seller nothing and
   * the bidder no advantage -- bidding starts one increment above. Every
   * subsequent bid then adds another increment over the standing high,
   * which is the same rule applied twice rather than two rules. */
  const standingHigh = priv.bids.reduce((max, b) => Math.max(max, Number(b.bid_amount)), 0);
  const minimumBid =
    (standingHigh > 0 ? standingHigh : Number(priv.face_value)) + MIN_BID_INCREMENT;
  const minimumRaise = miniAuction ? Number(miniAuction.high_bid) + MIN_BID_INCREMENT : 0;

  /* ---- Design note #23: AUTO-SCROLL TO THE TURN PLAYER ----------------
   *
   * The bid table caps at ~3.5 rows and scrolls (design note #21), which
   * bounded the card but created a new way to miss the thing that matters:
   * with six bidders, whoever is on turn is as likely as not below the fold
   * -- and during a mini-auction that row is the only one anyone is waiting
   * on.
   *
   * `scrollTop` is set directly rather than `scrollIntoView()`. The latter
   * scrolls every scrollable ANCESTOR, so a row near the bottom of a card
   * would also jog the whole page -- which on a six-card grid means the
   * board jumps whenever the turn passes. Setting `scrollTop` on the
   * container itself moves exactly one scroller and nothing else.
   *
   * `offsetTop` is measured relative to the scroll container because the
   * container is the row's `offsetParent` (it is `position: relative`), so
   * the subtraction is what pins the row to the TOP of the window rather
   * than merely somewhere inside it. */
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

  /* ---- Design note #315: THE AFFORDABILITY GATE ----------------------
   *
   * Both money gates, computed here so the button's `disabled` and its
   * tooltip are driven by one expression -- a control that is off for a
   * reason it does not state is the shape this codebase has removed
   * repeatedly.
   *
   * The RAISE case subtracts the bid this player already has standing in
   * this contest. That money is escrowed against this very private, so a
   * raise only has to fund the increment; charging the full new figure
   * against available cash would stop a player from defending a bid they
   * have already paid for, which gets the position exactly backwards.
   *
   * BUYING OUTRIGHT is gated on available cash too, not on the total. A
   * player's escrow elsewhere is refundable in principle, but it is not
   * refunded YET -- the note is under another certificate and cannot also
   * be handed over for this one. `WaterfallBuyLowest` settles immediately,
   * so available is the only figure that can honestly fund it. */
  const ownRaiseEscrow = fundsSeat
    ? priv.bids
        .filter((bid) => bid.bidder === fundsSeat)
        .reduce((sum, bid) => sum + (Number(bid.bid_amount) || 0), 0)
    : 0;
  /* ==================================================================
   *  DESIGN NOTE 384: ONE BID PER PRIVATE, IN THE WATERFALL PROPER
   * ==================================================================
   *
   * REPORTED: players can spam bids on the same private before a
   * mini-auction.
   *
   * They could, and each one escrowed more of their cash against the same
   * certificate. `ownRaiseEscrow` just above is the evidence: it sums a
   * seat's bids on one private, and it only needs to SUM because a seat
   * could have several. A second bid on a private you are already the
   * standing bidder on is a player bidding against themselves; a second bid
   * behind someone else's is the move that should be a raise, and raising
   * is what the mini-auction exists for.
   *
   * SO THE GATE IS "HAVE I BID HERE", not "am I winning here". Both cases
   * are the same mistake and both are refused with the same sentence.
   *
   * THE MINI-AUCTION LIFTS IT, which is the whole point of the exception.
   * Once a contest is triggered on this private the control below is no
   * longer Place Bid but Raise, and raising repeatedly is how the contest
   * is fought -- `ownRaiseEscrow` then does its real job of charging only
   * the increment. Gating that would make a triggered auction unwinnable by
   * anyone who opened it.
   *
   * `ownRaiseEscrow > 0` is the test rather than a separate scan of
   * `priv.bids`, because it is already exactly "this seat's money standing
   * on this private" -- deriving the same fact twice is how the two answers
   * start to disagree. */
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
        {/* Design note #31: ONE badge slot, directly under the name.
            LOWEST OFFER already sat here; COMPETING BIDS and MINI-AUCTION
            LIVE were further down beside the bid list, so the same class of
            information appeared at two different heights depending on which
            state a card was in -- and the eye had to search each card
            separately. All three now occupy the same row.

            They are mutually exclusive in practice: the lowest-offered
            private can never be bid on (`CannotBidOnLowest`), so a card is
            at most one of these. */}
        <div style={styles.privateCardHeader}>
          {/* Design note #304: the printed number. 1830's privates are
              known by order as much as by name -- "the 3" is how players
              refer to the Delaware & Hudson -- and the waterfall IS that
              order, so the grid was showing a sequence with its index
              filed off. */}
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
      </div>

      {/* Special power. Design note #13: no enforcement badge -- all six
          privates are standard parts of this ruleset, and the card
          describes the piece rather than annotating backend coverage. */}
      {catalogEntry && (
        <div style={styles.privateCardAbilityBlock}>
          <span style={styles.privateCardAbilityLabel}>Special power</span>
          <span style={styles.privateCardAbility}>{catalogEntry.ability}</span>
        </div>
      )}

      {/* ---- ONE standings table -- design note #19 --------------------
          This card used to render two: a "standing bids" list here, and a
          second "mini-auction bidders" list inside the action area, listing
          the SAME people during a mini-auction with different columns. Two
          tables of the same fact, a few pixels apart, is a reader's problem
          -- the obvious question is which one is current, and there was no
          answer because both were.

          There is now one table. During a mini-auction it gains the TURN and
          LEADER tags rather than being duplicated by a table that has them. */}
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
                  {/* ==================================================
                       DESIGN NOTE 321: A STAR, NOT A WORD
                      ==================================================

                      Design note #302 put "LEADING" here and was right
                      about WHO it belongs on -- `high_bidder` is and always
                      was the real leader. What is wrong is the shape.

                      The bid row is a name, a badge and a figure inside a
                      card that has to fit six across, and "LEADING" is
                      seven characters of chrome saying what the largest
                      number in the column already says. Worse, it sat next
                      to "TURN" in the same slot, so the busiest row on the
                      screen carried two shouted words competing for the
                      same glance.

                      A gold star is the universal "this one is winning"
                      mark, it costs one character, and it needs no
                      translation. The word survives as the `title`, so the
                      meaning is still one hover away and screen readers get
                      a sentence rather than a glyph -- which is why the
                      `aria-label` is the sentence and the star itself is
                      `aria-hidden`. */}
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

              {/* Design note #27: input, Raise and Drop Out on ONE line.
                  They were three stacked blocks with a hint between them,
                  which read as three unrelated decisions and cost four rows
                  in a card that has to fit six across. They are one
                  decision -- how much, or not at all -- so they sit on one
                  row, with the minimum folded into the line above. */}
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
                  // Design note #384: the FIELD goes too, not just the
                  // button. A live input above a dead button invites the
                  // player to type a figure and then discover it cannot be
                  // sent, which is a worse refusal than one that never
                  // took the keystrokes.
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
              {/* Design note #22: the backend explanation moved OFF the card
                  and onto the button's tooltip. It was three lines of
                  `waterfall.rs` reference sitting permanently at the bottom
                  of every card -- read once, then pure noise occupying the
                  space six cards needed. The number a player actually needs
                  stays visible; the reasoning is one hover away. */}
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

/**
 * A private that has been won -- design notes #28/#30.
 *
 * Holds its waterfall slot and greys out rather than being removed or
 * moved. `GetWaterfallState.privates` only reports STILL-UNOWNED companies,
 * so this is fed from `GameStateResponse.private_companies` instead.
 *
 * ⚠ THE PRICE IS FACE VALUE, not the winning bid. `PrivateCompanyState`
 * exposes `cost` and `owner` and nothing else -- the settled price is not
 * in any query response, so a private won in a mini-auction shows less than
 * was actually paid. Exposing it is a backend change; the tooltip says so.
 */
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
  /* ==================================================================
   *  DESIGN NOTE 340: WINNING A COMPANY SHOULD NOT ERASE IT
   * ==================================================================
   *
   * REPORTED: sold private companies lose all their information -- powers,
   * text -- keeping only the name and face value.
   *
   * They did. This card rendered a header, one figure and the sold badge,
   * while the live card beside it rendered the same header, TWO figures
   * (face value and revenue per OR) and the special-power block. So the
   * moment a player won a company, the description of what they had just
   * bought disappeared.
   *
   * That is exactly backwards. Before the sale the ability text is
   * shopping information; after it, it is the owner's REFERENCE -- the
   * thing they consult when deciding whether they can lay a free tile this
   * turn, or what their income is. The auction grid stays on screen for the
   * whole auction and the sold cards hold their slots (design note #30), so
   * this was six cards progressively turning into blanks.
   *
   * The catalog lookup is by `private_id`, the same key the live card uses,
   * so there is one source for the text and no chance of the two cards
   * describing the same company differently. */
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
        <div style={styles.privateCardAbilityBlock}>
          <span style={styles.privateCardAbilityLabel}>Special power</span>
          <span style={styles.privateCardAbility}>{catalogEntry.ability}</span>
        </div>
      )}
      <div style={styles.soldBadgeWrap}>
        {/* Design note #30: the badge WRAPS. It was a single nowrap line, so
            a long name plus a price overflowed the card and sat on the page
            behind it. Two stacked lines with `overflowWrap` keep even the
            longest name ("Champlain & St. Lawrence") inside the border at
            the narrowest grid column. */}
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

/* ==================================================================
 *  DESIGN NOTE 31: THE SANDBOX SEATS WERE DISTINCT AND LOOKED IDENTICAL
 * ==================================================================
 *
 * REPORTED: players and turn order all display as a generic `juno...00`
 * address instead of Alice, Bob, Carol.
 *
 * The addresses were never the problem -- `SANDBOX_PLAYERS` holds four
 * genuinely different strings and `sandboxPlayerLabel` maps them to names.
 * What collapsed them was TRUNCATION. All four are the same literal prefix
 * padded to the same length with zeros, so `truncate` takes `juno1san` from
 * the front and `0000` from the back of every one and returns the identical
 * string four times.
 *
 * `playerLabel` was already threaded into this component -- and used in
 * exactly one place, the sold-private owner. The turn banner, the seating
 * list, the bid rows and the mini-auction lines all called `truncate`
 * directly, which is why the screen the player actually reads was the one
 * showing four identical addresses.
 *
 * `nameFor` is now the only way an address reaches the DOM here. It falls
 * through to truncation for a real wallet, which is the right answer there
 * -- a live game has no name table and 8/5 of a real address IS
 * distinguishing. */
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
  // ---- Design note #11: STACKED, not side by side. ----
  //
  // `body` used to be `flexDirection: "row"` with the six private cards
  // squeezed into whatever width a fixed 300px action rail left over. Two
  // problems, and the second is the one that mattered: at six columns the
  // cards were far too narrow to read, and -- worse -- the rail sat
  // immediately beside them, so "Your Turn Actions" and "Seating Order"
  // read as if they belonged to whichever card they happened to be level
  // with. The auction has one shared action rail for all six privates, and
  // the layout was implying six.
  //
  // Now: the privates own the full width at the top, and every interactive
  // surface lives in one clearly separated band underneath.
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
  /* ---- Design note #12: the cards have to look like certificates ----
   *
   * The old `#1b1f29` on the panel's own `#161922` was a four-point
   * lightness difference -- effectively invisible, so the six privates read
   * as one undifferentiated block of text rather than as six things you
   * choose between. These are the objects being auctioned and they should
   * look like objects.
   *
   * The treatment is a warm parchment-toned slate with a gold left edge --
   * a stock-certificate cue, and deliberately the only warm surface on an
   * otherwise cold blue-grey screen, so the auction reads as its own kind
   * of thing. The lowest-offered card then goes brighter gold still, which
   * keeps the one genuinely special card distinguishable from the other
   * five now that all six are raised. */
  /* ---- Design note #18: ONE FILL, STATE AT THE EDGES -----------------
   *
   * All three variants now share `CARD_SURFACE`. They previously had three
   * different near-whites -- plain, a warmer lowest-offer, a pink
   * mini-auction -- which together with the Stock Round's two more made
   * five almost-but-not-quite-matching paper tones across two screens. The
   * effect was not "colour-coded", it was "inconsistently grubby".
   *
   * State is now carried entirely by the border, the left accent stripe and
   * the badges, which is enough signal precisely because the fill is
   * constant: a gold edge reads as gold against identical paper, where
   * before it competed with a gold-tinted fill. See `styles/palette.ts` for
   * why the shared value lives there rather than being typed twice. */
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
  /* Design note #38: the lowest-offered card's border is NEUTRAL.
     It briefly wore the gold active border and a matching glow, and adding
     a green Buy button and green badge on top of that made one card carry
     three competing emphases at once -- the tile shouted before the player
     had read what it was.
     The green is now doing the whole job, confined to the two elements a
     player actually acts on: the LOWEST OFFER badge says which card, the
     Buy button says what you can do. The card underneath them is plain,
     which is what lets them read. */
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
  /** Wrapper for the header + figures block. A plain div since design note
   *  #17 removed the accordion; kept as its own element so the card's
   *  internal spacing did not have to change with it.
   *
   *  Design note #319: `cursor: pointer` came off with the accordion, five
   *  notes late. It was the last trace of a control that no longer exists:
   *  the block is a `<div>` with no `onClick`, so the hand cursor was
   *  promising a click that does nothing -- and on a screen of six cards
   *  where the real actions are buttons an inch below, a player who tries
   *  it learns to distrust the cursor everywhere else. */
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
  /* ---- Design note #21: THE BID TABLE MUST NOT GROW THE CARD ---------
   *
   * Up to six players can bid on one private, and the table sits between
   * fixed content above (name, figures, special power) and the
   * bottom-anchored action block below. Left unbounded, a six-bidder table
   * pushes the card past its siblings' height -- and because the grid rows
   * stretch, ONE contested company would inflate every card in its row,
   * with the action buttons dragged down out of alignment.
   *
   * Capped and scrolled instead. ~3.5 rows visible, which is enough to see
   * the leader plus the chase and enough of a cut-off edge to show there is
   * more. `flexShrink: 0` on the action block below keeps the buttons
   * anchored rather than being compressed by a full table. */
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
  privateCardAbility: {
    fontSize: FONT_SIZE.micro,
    color: CARD_INK_MUTED,
    lineHeight: 1.45,
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
  // ---- Special power, with its enforcement badge. ----
  privateCardAbilityBlock: { display: "flex", flexDirection: "column", gap: "5px" },
  privateCardAbilityLabel: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 800,
    letterSpacing: "0.5px",
    textTransform: "uppercase",
    color: "#8a7332",
  },
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
  /** Design note #29: ORANGE. Competing bids and a live mini-auction are
   *  different states -- one is "this will need resolving", the other is
   *  "this is being resolved right now, and the whole waterfall is paused
   *  on it". Both were red, which flattened that distinction; red is now
   *  reserved for the live one. */
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
  // Design note #11: the interaction band, now a horizontal row BELOW the
  // privates rather than a column beside them. The heavy top border and
  // recessed background are doing real work -- they are the visual
  // statement that this is a separate area serving all six cards above,
  // which is exactly the confusion the old side-by-side layout caused.
  /* ---- Expanded action drawer inside a card (design note #14) ----
   * A recessed warm-grey well, separated by a rule, so the controls read as
   * a distinct region of the card rather than more card content. */
  cardActions: {
    display: "flex",
    flexDirection: "column",
    gap: "8px",
    // Design note #20: THE BUTTONS FORM A LINE. `marginTop: auto` in a
    // full-height flex column pushes this block to the card's bottom edge,
    // so the six action buttons align horizontally instead of floating at
    // whatever height each private's special-power text happens to end at
    // -- descriptions run from one line to three, which previously put the
    // buttons at six different heights.
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
  actionRail: {
    display: "flex",
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "stretch",
    gap: "12px",
    padding: "16px",
    backgroundColor: "#12151c",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "#2a2e3a",
    borderTopWidth: "3px",
    borderTopColor: "#3a4055",
    borderRadius: "10px",
  },
  /** Section caption for the interaction band. */
  /* Design note #341: the seating table is the whole footer now, so it
     takes the whole width. The two styles it replaces -- a 280px side
     column and a 420px main column -- were both sized to share the band
     with the hint block, and are deleted rather than left unused: a style
     nothing renders is an invitation to put something back beside the
     table and undo the widening. */
  actionRailFull: {
    display: "flex",
    flexDirection: "column",
    gap: "10px",
    flex: "1 1 100%",
    minWidth: 0,
  },
  actionCard: {
    display: "flex",
    flexDirection: "column",
    gap: "8px",
    padding: "12px",
    backgroundColor: "#1b1f29",
    border: "1px solid #2a2e3a",
    borderRadius: "8px",
  },
  miniAuctionCard: {
    display: "flex",
    flexDirection: "column",
    gap: "8px",
    padding: "12px",
    backgroundColor: "#211c0f",
    border: "1px solid #6b5a1f",
    borderRadius: "8px",
  },
  actionCardTitle: {
    fontSize: FONT_SIZE.body,
    fontWeight: 700,
    letterSpacing: "0.03em",
    color: "#c8cbd6",
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
  seatingCard: {
    display: "flex",
    flexDirection: "column",
    gap: "6px",
    padding: "12px",
    backgroundColor: "#1b1f29",
    border: "1px solid #2a2e3a",
    borderRadius: "8px",
  },
  seatingRow: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    fontSize: FONT_SIZE.small,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    color: "#c8cbd6",
    padding: "3px 6px",
    borderRadius: "4px",
  },
  seatingRowActive: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    fontSize: FONT_SIZE.small,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    color: "#eafff0",
    backgroundColor: "#1f2a1f",
    padding: "3px 6px",
    borderRadius: "4px",
  },
  seatingIndex: {
    color: "#6f7480",
  },
  seatingAddress: {
    flex: "1 1 auto",
  },
  /* Design note #32: the seat that must act now. Reads as a state rather
     than an identity, which is what distinguishes it from `youBadge`. */
  /* Design note #33: the figure every bid is measured against. Tabular
     numerals so a column of them is comparable at a glance, which is the
     only reason to show four of them at once. */
  seatingHeaderRow: {
    display: "flex",
    alignItems: "baseline",
    gap: "10px",
    marginBottom: "2px",
  },
  /* `seatingColumnHint` DELETED by design note #422 -- one right-aligned
     string describing two columns it sat over neither of. Replaced by the
     three real headings below, each on its own column. */
  /* Design note #422: mirrors `seatingRow`'s flex geometry exactly -- same
     gap, same padding, same basis values -- so a heading sits over its
     column at every width instead of near it. `alignItems: baseline`
     rather than `center` because these are words above words. */
  seatingColumnHeader: {
    display: "flex",
    alignItems: "baseline",
    gap: "8px",
    padding: "0 6px 3px",
    fontSize: FONT_SIZE.micro,
    fontWeight: 700,
    letterSpacing: "0.06em",
    textTransform: "uppercase",
    color: "#6f7480",
    borderBottom: "1px solid #2a3142",
    marginBottom: "3px",
  },
  /* Spans the index, the name and the turn slot -- everything the heading
     "Player Information" actually covers. */
  seatingColumnHeadPlayer: { flex: "1 1 auto" },
  seatingColumnHeadCash: { marginLeft: "auto" },
  seatingColumnHeadPrivates: { flex: "0 0 128px" },
  /* `seatingPrivateChip` and `seatingPrivatesEmpty` DELETED by design note
     #423 -- the numbered chip and its "none" label both moved into
     `PrivateCompanyPills`, which the Ledger renders too. Deleted rather
     than left behind: a chip style sitting in the file that used to draw
     numbered chips is how the numbers come back. */
  /* Design note #341: fixed basis for the same reason the turn slot has one
     (design note #323) -- a player winning their first private must not
     shove every other column sideways. */
  seatingPrivates: {
    flex: "0 0 128px",
    display: "flex",
    flexDirection: "row",
    gap: "3px",
    justifyContent: "flex-end",
    alignItems: "center",
    flexWrap: "wrap",
  },
  seatingCash: {
    fontSize: FONT_SIZE.small,
    fontWeight: 700,
    color: "#7ee0a1",
    fontVariantNumeric: "tabular-nums",
    marginLeft: "auto",
    display: "inline-flex",
    alignItems: "baseline",
    gap: "5px",
  },
  /* Design note #316: escrow is context for the number beside it, so it is
     muted and smaller rather than a second figure of equal weight. */
  seatingEscrow: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 600,
    color: "#8a919e",
  },
  /* Design note #323, still: fixed basis, never grows or shrinks, rendered
     on every row so the columns cannot jitter as the turn passes.
     Design note #422 moved it beside the name and widened it -- "Your turn"
     is four characters longer than "ON TURN" -- and flipped the alignment
     to `flex-start`, because it now trails a name rather than closing a
     row. */
  seatingTurnSlot: {
    flex: "0 0 76px",
    display: "flex",
    justifyContent: "flex-start",
    alignItems: "center",
  },
  /* Design note #422: prominent, and no longer shouting. `ON TURN` was
     tracked-out uppercase because it was a status tag at the end of a row;
     "Your turn" is a sentence fragment addressed to the reader, so it
     drops the letter-spacing and keeps the high-contrast green fill that
     made it findable. */
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
  /* Design note #302: red, per the brief. It marks the player everyone
     else must outbid -- an alarm for the other bidders rather than a
     decoration for the leader. */
  /* Design note #306: the end-of-auction step. Full width and green -- it
     is the only thing to do on this screen once the grid is empty, and a
     quiet control in that position reads as decoration. */
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
  /* Design note #321: standalone glyph, no plate. A pill around a single
     character reads as a badge that has lost its label; the star carries
     itself. Sized a step above the body text so it is findable at a glance
     down a column, and given a soft gold shadow so it holds up against the
     card's own surface without a background. */
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
