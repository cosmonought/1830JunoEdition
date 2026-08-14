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
// existing layout -- laid out for a high-density widescreen display: a
// six-wide row of private-company cards (bid trackers included) on the left,
// a fixed-width action rail (face-value buy button, bid input, pass button,
// and -- when one is running -- the mini-auction sub-panel) on the right.
//
// Design notes:
// 1. **Driven entirely by `QueryMsg::GetWaterfallState`.** `waterfallState`
//    is `utils/gameState.ts`'s `useWaterfallStatePolling` result, already
//    gated by `App.tsx` to only actually poll while this phase is current
//    (see that hook's own doc comment, design note #7 in `gameState.ts`).
//    This component itself does no gating of its own beyond a loading/error
//    placeholder -- it trusts the caller only renders it during the
//    Waterfall Auction.
// 2. **Six-wide private company row, always all six, in the order the query
//    already returns them (ascending face value).** Each card shows its own
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
//    itself whenever no private anywhere has a standing bid, mirroring
//    `waterfall.rs`'s own `PassNotAllowed` legality rule (module doc
//    comment #1) client-side, exactly like `ContextualActionBar`'s Buy
//    Private Company tray already mirrors `execute_buy_private_company`'s
//    50%-200% price bound.
// 4. **Bid amount defaults, doesn't lock.** The bid input (main tray and
//    mini-auction alike) auto-fills to the live legal minimum (face value,
//    or standing high bid + the $5 `auction::MIN_BID_INCREMENT`) every time
//    the selected private or its standing bid changes, so a player never
//    has to hand-compute the floor -- but stays a normal editable number
//    input, since bidding above the minimum is always legal too.
// 5. **Mini-auction sub-panel replaces the main action tray while one is
//    running**, not a modal -- `waterfall.rs`'s own design (module doc
//    comment #3): a mini-auction pauses the WHOLE waterfall for every
//    player, not just its own tied bidders, so there's nothing else this
//    rail could usefully show underneath it. Shows every tied bidder in
//    seating order, the current high bidder/bid, and Raise/Pass buttons
//    gated by `mini_auction.current_turn` exactly like design note #3
//    describes -- the leader's own turn is never offered here because the
//    backend (`waterfall::skip_leader_turns`) never points `current_turn` at
//    them in the first place, so no extra client-side "you're the leader"
//    guard is needed.

import React, { useEffect, useMemo, useState } from "react";
import { FONT_SIZE } from "../styles/typography";

import type {
  GameStateResponse,
  WaterfallMiniAuctionStatus,
  WaterfallPrivateStatus,
  WaterfallStateResponse,
} from "../utils/gameState";

/** Hand-kept mirror of `auction.rs::CORE_PRIVATE_COMPANIES`'s revenue yield
 *  and this custom ruleset's two implemented special abilities (D&H/M&H hex
 *  reservation -- `hexmap.rs` module doc comment #24 -- and B&O's auto-float
 *  -- `auction.rs` module doc comment #4). Schuylkill Valley, Champlain &
 *  St. Lawrence, and Camden & Amboy have no backend-enforced special power
 *  in this custom ruleset, so `ability` is deliberately omitted for those
 *  three rather than fabricating generic real-1830 lore this backend
 *  doesn't implement. Same "DISPLAY source only, not a schema-derived type"
 *  convention as this file's own `TRAIN_CATALOG`-style siblings elsewhere
 *  in this codebase (e.g. `HexGridRenderer.tsx`'s `TILE_CATALOG`). */
const PRIVATE_COMPANY_CATALOG: Readonly<Record<number, { revenue: number; ability?: string }>> = {
  1: { revenue: 5 }, // Schuylkill Valley
  2: { revenue: 10 }, // Champlain & St. Lawrence
  3: {
    revenue: 15,
    ability: "Reserves hex B20 (Burlington) from track-laying by other public companies until corporate-owned (house rule)",
  }, // Delaware & Hudson
  4: {
    revenue: 20,
    ability: "Reserves hex F16 (Scranton) from track-laying by other public companies until corporate-owned (house rule)",
  }, // Mohawk & Hudson
  5: { revenue: 25 }, // Camden & Amboy
  6: {
    revenue: 30,
    ability: "Auto-floats the public B&O -- winner receives its 20% President's Certificate for free, remaining 80% opens in B&O's IPO pool",
  }, // Baltimore & Ohio
};

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
  /** Dispatches `ExecuteMsg::WaterfallBuyLowest`. */
  onBuyLowest: () => void;
  /** Dispatches `ExecuteMsg::WaterfallBidHigher`. */
  onBidHigher: (privateId: number, bidAmountVgp: number) => void;
  /** Dispatches `ExecuteMsg::WaterfallPass`. */
  onPass: () => void;
  /** Dispatches `ExecuteMsg::WaterfallMiniAuctionRaise`. */
  onMiniAuctionRaise: (bidAmountVgp: number) => void;
  /** Dispatches `ExecuteMsg::WaterfallMiniAuctionPass`. */
  onMiniAuctionPass: () => void;
}

export function WaterfallAuctionDashboard({
  waterfallState,
  loading,
  error,
  gameState,
  connectedWalletAddress,
  sessionReady,
  onBuyLowest,
  onBidHigher,
  onPass,
  onMiniAuctionRaise,
  onMiniAuctionPass,
}: WaterfallAuctionDashboardProps) {
  const privates = waterfallState?.privates ?? [];
  const lowest = privates.find((p) => p.is_lowest_offered) ?? null;
  const biddable = privates.filter((p) => !p.is_lowest_offered);
  const miniAuction = waterfallState?.mini_auction ?? null;

  const [selectedPrivateId, setSelectedPrivateId] = useState<number | null>(null);
  const [bidAmount, setBidAmount] = useState<number>(0);
  const [miniRaiseAmount, setMiniRaiseAmount] = useState<number>(0);

  // Keeps the bid-target selector valid as the live private list changes
  // (e.g. the previously-selected private just got auto-resolved by the
  // Waterfall Cascade, or a mini-auction just opened on it) -- same
  // re-sync-on-list-change pattern App.tsx's own Buy Private Company tray
  // already uses for `sellablePrivates`.
  useEffect(() => {
    if (selectedPrivateId !== null && biddable.some((p) => p.private_id === selectedPrivateId)) {
      return;
    }
    setSelectedPrivateId(biddable.length > 0 ? biddable[0].private_id : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [biddable.map((p) => p.private_id).join(",")]);

  const selectedPrivate = biddable.find((p) => p.private_id === selectedPrivateId) ?? null;

  const selectedMinimumBid = useMemo(() => {
    if (!selectedPrivate) return 0;
    const highBid = selectedPrivate.bids.reduce((max, b) => Math.max(max, Number(b.bid_amount)), 0);
    return highBid > 0 ? highBid + 5 : Number(selectedPrivate.face_value);
  }, [selectedPrivate]);

  useEffect(() => {
    setBidAmount(selectedMinimumBid);
  }, [selectedMinimumBid]);

  const miniMinimumRaise = miniAuction ? Number(miniAuction.high_bid) + 5 : 0;
  useEffect(() => {
    setMiniRaiseAmount(miniMinimumRaise);
  }, [miniMinimumRaise]);

  const isMyMainTurn =
    !!connectedWalletAddress &&
    !!waterfallState &&
    !miniAuction &&
    waterfallState.current_turn === connectedWalletAddress;
  const isMyMiniTurn =
    !!connectedWalletAddress && !!miniAuction && miniAuction.current_turn === connectedWalletAddress;

  const anyBidExists = privates.some((p) => p.bids.length > 0);

  if (!waterfallState) {
    return (
      <div style={styles.root}>
        <div style={styles.header}>
          <span style={styles.headerTitle}>Pre-Game Waterfall Auction</span>
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
      <div style={styles.header}>
        <span style={styles.headerTitle}>Pre-Game Waterfall Auction</span>
        <span style={styles.headerHint}>
          Allocating six private companies before Stock Round 1 --{" "}
          {waterfallState.consecutive_waterfall_passes > 0
            ? `${waterfallState.consecutive_waterfall_passes} consecutive pass(es) so far`
            : "no passes yet"}
        </span>
        {error && (
          <span style={styles.staleNote}>Showing last known state -- latest refresh failed: {error}</span>
        )}
      </div>

      <div style={styles.body}>
        <div style={styles.privateGrid}>
          {privates.map((priv) => (
            <PrivateCard
              key={priv.private_id}
              priv={priv}
              connectedWalletAddress={connectedWalletAddress}
              miniAuction={miniAuction}
            />
          ))}
          {privates.length === 0 && (
            <p style={styles.placeholderText}>
              All six private companies have been allocated -- the Waterfall Auction is concluding.
            </p>
          )}
        </div>

        <div style={styles.actionRail}>
          <div style={styles.turnBanner}>
            <span style={styles.turnBannerLabel}>{miniAuction ? "Mini-Auction Turn" : "Waterfall Turn"}</span>
            <span style={styles.turnBannerAddress}>
              {truncate(miniAuction ? miniAuction.current_turn : waterfallState.current_turn)}
            </span>
          </div>

          {miniAuction ? (
            <MiniAuctionPanel
              miniAuction={miniAuction}
              privateName={
                privates.find((p) => p.private_id === miniAuction.private_id)?.name ??
                `Private #${miniAuction.private_id}`
              }
              raiseAmount={miniRaiseAmount}
              onRaiseAmountChange={setMiniRaiseAmount}
              minimumRaise={miniMinimumRaise}
              isMyTurn={isMyMiniTurn}
              sessionReady={sessionReady}
              onRaise={() => onMiniAuctionRaise(miniRaiseAmount)}
              onPass={onMiniAuctionPass}
            />
          ) : (
            <div style={styles.actionCard}>
              <span style={styles.actionCardTitle}>Your Turn Actions</span>

              <button
                type="button"
                style={styles.primaryButton}
                onClick={onBuyLowest}
                disabled={!sessionReady || !isMyMainTurn || !lowest}
                title="Dispatches ExecuteMsg::WaterfallBuyLowest -- buys the current lowest-offered private at face value."
              >
                {lowest ? `Buy Lowest: ${lowest.name} (${lowest.face_value} VGP)` : "No private currently offered"}
              </button>

              <div style={styles.bidRow}>
                <select
                  style={styles.select}
                  value={selectedPrivateId ?? ""}
                  onChange={(e) => setSelectedPrivateId(Number(e.target.value))}
                  disabled={!sessionReady || !isMyMainTurn || biddable.length === 0}
                >
                  {biddable.map((p) => (
                    <option key={p.private_id} value={p.private_id}>
                      {p.name} ({p.face_value} VGP)
                    </option>
                  ))}
                </select>
                <input
                  type="number"
                  style={styles.numberInput}
                  min={selectedMinimumBid}
                  step={5}
                  value={bidAmount}
                  onChange={(e) => setBidAmount(Number(e.target.value))}
                  disabled={!sessionReady || !isMyMainTurn || !selectedPrivate}
                />
                <button
                  type="button"
                  style={styles.secondaryButton}
                  onClick={() => selectedPrivate && onBidHigher(selectedPrivate.private_id, bidAmount)}
                  disabled={!sessionReady || !isMyMainTurn || !selectedPrivate || bidAmount < selectedMinimumBid}
                  title="Dispatches ExecuteMsg::WaterfallBidHigher -- see waterfall.rs module doc comment #1/#2."
                >
                  Bid
                </button>
              </div>
              {selectedPrivate && <span style={styles.hintText}>Minimum bid: {selectedMinimumBid} VGP</span>}

              <button
                type="button"
                style={styles.passButton}
                onClick={onPass}
                disabled={!sessionReady || !isMyMainTurn || !anyBidExists}
                title={
                  anyBidExists
                    ? "Dispatches ExecuteMsg::WaterfallPass."
                    : "Illegal while no private company anywhere has an active bid -- see waterfall.rs module doc comment #1."
                }
              >
                Pass
              </button>
            </div>
          )}

          {gameState && gameState.player_addresses.length > 0 && (
            <div style={styles.seatingCard}>
              <span style={styles.actionCardTitle}>Seating Order</span>
              {gameState.player_addresses.map((player, index) => {
                const isTurnHolder =
                  player === (miniAuction ? miniAuction.current_turn : waterfallState.current_turn);
                return (
                  <div key={player} style={isTurnHolder ? styles.seatingRowActive : styles.seatingRow}>
                    <span style={styles.seatingIndex}>{index + 1}.</span>
                    <span style={styles.seatingAddress}>{truncate(player)}</span>
                    {player === connectedWalletAddress && <span style={styles.youBadge}>YOU</span>}
                  </div>
                );
              })}
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
  priv,
  connectedWalletAddress,
  miniAuction,
}: {
  priv: WaterfallPrivateStatus;
  connectedWalletAddress: string | null | undefined;
  miniAuction: WaterfallMiniAuctionStatus | null;
}) {
  const catalogEntry = PRIVATE_COMPANY_CATALOG[priv.private_id];
  const sortedBids = priv.bids.slice().sort((a, b) => Number(b.bid_amount) - Number(a.bid_amount));
  const highestBid = sortedBids[0] ?? null;

  // Status indicators -- grounded directly in `waterfall.rs`'s own real
  // cascade semantics (module doc comment #3), not fabricated logic: 0 bids
  // leaves a private simply open, exactly 1 bid is what the next cascade
  // run auto-resolves to that sole bidder ("auto-award"), 2+ bids is what
  // starts (or, if already running, IS) a mini-auction.
  const isTiedInMiniAuction = miniAuction?.private_id === priv.private_id;
  const isAutoAwardPending = !priv.is_lowest_offered && priv.bids.length === 1;
  const isTiedBid = !priv.is_lowest_offered && (priv.bids.length >= 2 || isTiedInMiniAuction);
  const hasEscrowedCash = priv.bids.length > 0;

  return (
    <div style={priv.is_lowest_offered ? styles.privateCardLowest : styles.privateCard}>
      <div style={styles.privateCardHeader}>
        <span style={styles.privateCardName}>{priv.name}</span>
        {priv.is_lowest_offered && <span style={styles.lowestBadge}>LOWEST OFFER</span>}
      </div>
      <span style={styles.privateCardFaceValue}>{priv.face_value} VGP face value</span>
      {catalogEntry && <span style={styles.privateCardRevenue}>{catalogEntry.revenue} VGP revenue / OR</span>}
      {catalogEntry?.ability && <span style={styles.privateCardAbility}>{catalogEntry.ability}</span>}

      {/* Dynamic status indicators -- requirement 2's "locked cash",
          "auto-awarded single-bidder", and "tied-bid mini-auction"
          badges. */}
      <div style={styles.statusBadgeRow}>
        {hasEscrowedCash && (
          <span style={styles.statusBadgeEscrow} title="Bid amounts are held in escrow until the private resolves.">
            🔒 {highestBid?.bid_amount} VGP escrowed
          </span>
        )}
        {isAutoAwardPending && (
          <span
            style={styles.statusBadgeAutoAward}
            title="Exactly one bidder -- the next cascade run auto-awards this private to them (waterfall.rs module doc comment #3)."
          >
            AUTO-AWARD PENDING
          </span>
        )}
        {isTiedBid && (
          <span
            style={styles.statusBadgeTied}
            title="Two or more tied bidders -- resolves via mini-auction (waterfall.rs module doc comment #3)."
          >
            {isTiedInMiniAuction ? "MINI-AUCTION LIVE" : "TIED BID"}
          </span>
        )}
      </div>

      {highestBid && (
        <span style={styles.highestBidderLine}>
          Highest bidder: {truncate(highestBid.bidder, 6, 4)} -- {highestBid.bid_amount} VGP
        </span>
      )}

      <div style={styles.privateCardBids}>
        {priv.bids.length === 0 ? (
          <span style={styles.noBidsText}>
            {priv.is_lowest_offered ? "Buy outright at face value" : "No standing bids"}
          </span>
        ) : (
          sortedBids.map((bid) => (
            <div
              key={bid.bidder}
              style={
                bid.bidder === connectedWalletAddress ? styles.bidRowEntryOwn : styles.bidRowEntry
              }
            >
              <span>{truncate(bid.bidder, 6, 4)}</span>
              <span style={styles.bidAmount}>{bid.bid_amount} VGP</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Mini-auction sub-panel -- see design note #5                       */
/* ------------------------------------------------------------------ */

function MiniAuctionPanel({
  miniAuction,
  privateName,
  raiseAmount,
  onRaiseAmountChange,
  minimumRaise,
  isMyTurn,
  sessionReady,
  onRaise,
  onPass,
}: {
  miniAuction: WaterfallMiniAuctionStatus;
  privateName: string;
  raiseAmount: number;
  onRaiseAmountChange: (value: number) => void;
  minimumRaise: number;
  isMyTurn: boolean;
  sessionReady: boolean;
  onRaise: () => void;
  onPass: () => void;
}) {
  return (
    <div style={styles.miniAuctionCard}>
      <span style={styles.actionCardTitle}>Mini-Auction: {privateName}</span>
      <span style={styles.hintText}>
        High bid {miniAuction.high_bid} VGP by {truncate(miniAuction.high_bidder, 6, 4)}
      </span>

      <div style={styles.miniAuctionBidders}>
        {miniAuction.bidders.map((bidder) => (
          <div
            key={bidder}
            style={bidder === miniAuction.high_bidder ? styles.bidRowEntryOwn : styles.bidRowEntry}
          >
            <span>{truncate(bidder, 6, 4)}</span>
            {bidder === miniAuction.current_turn && <span style={styles.youBadge}>TURN</span>}
            {bidder === miniAuction.high_bidder && <span style={styles.leaderBadge}>LEADER</span>}
          </div>
        ))}
      </div>

      <div style={styles.bidRow}>
        <input
          type="number"
          style={styles.numberInput}
          min={minimumRaise}
          step={5}
          value={raiseAmount}
          onChange={(e) => onRaiseAmountChange(Number(e.target.value))}
          disabled={!sessionReady || !isMyTurn}
        />
        <button
          type="button"
          style={styles.secondaryButton}
          onClick={onRaise}
          disabled={!sessionReady || !isMyTurn || raiseAmount < minimumRaise}
          title="Dispatches ExecuteMsg::WaterfallMiniAuctionRaise."
        >
          Raise
        </button>
      </div>
      <span style={styles.hintText}>Minimum raise: {minimumRaise} VGP</span>

      <button
        type="button"
        style={styles.passButton}
        onClick={onPass}
        disabled={!sessionReady || !isMyTurn}
        title="Dispatches ExecuteMsg::WaterfallMiniAuctionPass -- your escrowed bid is fully refunded."
      >
        Pass
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                      */
/* ------------------------------------------------------------------ */

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
  headerTitle: {
    fontSize: FONT_SIZE.heading,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.04em",
    color: "#c8cbd6",
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
  body: {
    display: "flex",
    flexDirection: "row",
    gap: "16px",
    alignItems: "flex-start",
  },
  privateGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(6, minmax(0, 1fr))",
    gap: "10px",
    flex: "1 1 auto",
    minWidth: 0,
  },
  privateCard: {
    display: "flex",
    flexDirection: "column",
    gap: "8px",
    padding: "12px",
    backgroundColor: "#1b1f29",
    border: "1px solid #2a2e3a",
    borderRadius: "8px",
    minHeight: "140px",
  },
  privateCardLowest: {
    display: "flex",
    flexDirection: "column",
    gap: "8px",
    padding: "12px",
    backgroundColor: "#211c0f",
    border: "1px solid #6b5a1f",
    borderRadius: "8px",
    minHeight: "140px",
    boxShadow: "0 0 0 1px rgba(212, 169, 76, 0.25) inset",
  },
  privateCardHeader: {
    display: "flex",
    flexDirection: "column",
    gap: "4px",
  },
  privateCardName: {
    fontSize: FONT_SIZE.control,
    fontWeight: 700,
    color: "#e6e8ef",
  },
  lowestBadge: {
    alignSelf: "flex-start",
    fontSize: FONT_SIZE.micro,
    fontWeight: 700,
    letterSpacing: "0.05em",
    color: "#d4a94c",
    backgroundColor: "#3a2f14",
    border: "1px solid #6b5a1f",
    borderRadius: "4px",
    padding: "2px 6px",
  },
  privateCardFaceValue: {
    fontSize: FONT_SIZE.small,
    color: "#8a90a0",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  },
  privateCardBids: {
    display: "flex",
    flexDirection: "column",
    gap: "4px",
    marginTop: "4px",
  },
  noBidsText: {
    fontSize: FONT_SIZE.small,
    color: "#6f7480",
    fontStyle: "italic",
  },
  bidRowEntry: {
    display: "flex",
    justifyContent: "space-between",
    fontSize: FONT_SIZE.small,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    color: "#c8cbd6",
    padding: "2px 6px",
    borderRadius: "4px",
  },
  bidRowEntryOwn: {
    display: "flex",
    justifyContent: "space-between",
    fontSize: FONT_SIZE.small,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    color: "#eafff0",
    backgroundColor: "#1f2a1f",
    padding: "2px 6px",
    borderRadius: "4px",
  },
  bidAmount: {
    fontWeight: 700,
  },
  privateCardRevenue: {
    fontSize: FONT_SIZE.small,
    color: "#8a90a0",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  },
  privateCardAbility: {
    fontSize: FONT_SIZE.micro,
    color: "#8fa0b8",
    lineHeight: 1.4,
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
    color: "#8fc7e8",
    backgroundColor: "#122a38",
    border: "1px solid #2f5a72",
    borderRadius: "4px",
    padding: "2px 6px",
    whiteSpace: "nowrap",
  },
  statusBadgeAutoAward: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 700,
    color: "#8fe8a8",
    backgroundColor: "#123822",
    border: "1px solid #2f7247",
    borderRadius: "4px",
    padding: "2px 6px",
    whiteSpace: "nowrap",
  },
  statusBadgeTied: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 700,
    color: "#e88f8f",
    backgroundColor: "#381212",
    border: "1px solid #723030",
    borderRadius: "4px",
    padding: "2px 6px",
    whiteSpace: "nowrap",
  },
  highestBidderLine: {
    fontSize: FONT_SIZE.micro,
    color: "#c7cbd4",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  },
  actionRail: {
    display: "flex",
    flexDirection: "column",
    gap: "10px",
    flex: "0 0 300px",
    width: "300px",
  },
  turnBanner: {
    display: "flex",
    flexDirection: "column",
    gap: "2px",
    padding: "10px 12px",
    backgroundColor: "#1b1f29",
    border: "1px solid #2a2e3a",
    borderRadius: "8px",
  },
  turnBannerLabel: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 700,
    letterSpacing: "0.05em",
    textTransform: "uppercase",
    color: "#8a90a0",
  },
  turnBannerAddress: {
    fontSize: FONT_SIZE.control,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    color: "#e6e8ef",
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
  primaryButton: {
    padding: "10px 12px",
    fontSize: FONT_SIZE.body,
    fontWeight: 700,
    color: "#0f1115",
    backgroundColor: "#d4a94c",
    border: "none",
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
  miniAuctionBidders: {
    display: "flex",
    flexDirection: "column",
    gap: "4px",
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
  youBadge: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 700,
    color: "#8ee08a",
    border: "1px solid #2f5a2f",
    borderRadius: "4px",
    padding: "1px 5px",
  },
  leaderBadge: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 700,
    color: "#d4a94c",
    border: "1px solid #6b5a1f",
    borderRadius: "4px",
    padding: "1px 5px",
  },
};
