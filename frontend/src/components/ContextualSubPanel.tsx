// frontend/src/components/ContextualSubPanel.tsx
//
// The automated contextual block underneath the board canvas: a Player Index during a Stock Round, a
// Corporation panel during an Operating Round, a short pointer during the auction.
//
// Design note #1: driven entirely by `current_round_type` and nothing else. The branch covers all three real
// variants explicitly, rather than letting the Waterfall Auction genesis phase fall through into the Operating
// Round branch by accident.
// Design note #3: "Routes and train sheets" are NOT fabricated. `state.rs` genuinely models hardware ownership
// and `pathfinding.rs` genuinely traces routes, but no `QueryMsg` exposes either (`gameState.ts #2`), so this
// panel says so directly rather than inventing plausible-looking numbers.
// Design note #4: before a real query resolves, one honest placeholder row -- not an empty or broken-looking
// table.
//
// Design notes #10/#11/#170/#405/#449/#572/#645: see `docs/ai_architecture/ui_shell_layout.md`.

import PresidentCrown, { PRESIDENT_CROWN_GOLD } from "./PresidentCrown";
import React from "react";

import type {
  GameStateResponse,
  QueryCapableClient,
} from "../utils/gameState";
import { corporationPrivateCompanies } from "../utils/gameState";
// Design note #753: the round's frozen queue decides the display order, not a live re-sort.
import { operatingOrderRanks, sortForOperatingOrder } from "../utils/operatingOrderView";
// Design note #572: `usePlayerNetWorths` and the Ledger's `PlayerAssetsSection`
// went with the footer table they fed. The Ledger still owns both.
import { PrivateCompanyPills } from "./PrivateCompanyPills";
import { corporationFullName } from "../utils/corporationNames";
import { derivePhase, rustOutlook } from "../utils/gamePhase";
import { CapacityPill, LastRoutePayout, TrainChips } from "./TrainBadges";
import { stationTickerColor } from "./hexContractTypes";
import type { MarketGridResponse } from "./StockMarketRenderer";
import { FONT_SIZE } from "../styles/typography";
// Design note #559: the ROOM-AWARE resolver. Importing it from
// `sandboxState` got the fixture's Alice/Bob table, which returns null
// for a real room id -- so presidents rendered as raw `p-` ids here
// while every other surface showed names.
import { sandboxPlayerLabel } from "../utils/playerLabels";
import { CHIP_INERT_BG, CHIP_INERT_BORDER, CHIP_INERT_INK } from "../styles/palette";

/* Design note #170: SHOW THE PERSON, NOT THE HASH. The President column rendered a raw bech32 address clipped
   to something like `juno1san...0000`, and in the sandbox every seat shares a prefix and a run of zeroes -- so
   all four players truncated to a near-identical string and the column became four rows of indistinguishable
   noise. A player could not tell which corporation was theirs from the one panel whose job is to say so.
   The label resolver returns `null` for anything it does not recognise, which is exactly the right shape here:
   a live room's real wallet falls through to truncation unchanged, so this improves the sandbox without
   inventing a name for a stranger. */
function playerLabel(address: string): string {
  return sandboxPlayerLabel(address) ?? truncate(address);
}

export interface ContextualSubPanelProps {
  gameState: GameStateResponse | null;
  loading: boolean;
  error: string | null;
  className?: string;
  /** Live market prices, from `QueryMsg::GetMarketGrid`. Optional: without
   *  it the Market Value column reads "--" rather than the panel refusing
   *  to render. Market price is NOT on `GameStateResponse` -- see design
   *  note #10 -- so it has to arrive separately or not at all. */
  marketGrid?: MarketGridResponse | null;
  /* Design note #405: what the Stock Round footer's Player Assets table needs -- the QUERY INPUTS rather than
     its resolved output, because the net-worth query is a shared hook and handing the footer a pre-resolved copy
     would mean App had to run it too. Optional throughout: omitted, the table renders its own "not connected"
     placeholders, which is the honest offline state. */
  queryClient?: QueryCapableClient;
  contractAddress?: string;
  gameId?: number;
  playerLabel?: (address: string) => string | null;
}

export function ContextualSubPanel({
  gameState,
  loading,
  error,
  className,
  marketGrid,
  // Design note #405: the footer's Player Assets table needs these to
  // resolve names and money. All optional -- omitted, the table renders its
  // own "not connected" placeholders, which is the honest state offline.
  queryClient,
  contractAddress,
  gameId,
  playerLabel,
}: ContextualSubPanelProps) {
  if (!gameState) {
    return (
      <div style={styles.root} className={className}>
        <div style={styles.header}>
          <span style={styles.headerTitle}>Round Detail</span>
        </div>
        <p style={styles.placeholderText}>
          {loading
            ? "Loading live game state..."
            : error
              ? `No live game state available (${error}).`
              : "No live game state available yet."}
        </p>
      </div>
    );
  }

  return (
    <div style={styles.root} className={className}>
      {gameState.current_round_type === "WaterfallAuction" ? (
        <WaterfallAuctionNotice />
      ) : gameState.current_round_type === "StockRound" ? (
        /* Design note #572: NOTHING. The player cards on this same tab now answer what the footer's table was here to
           answer, and two tables of one dataset make the reader prove they agree. Deleted rather than left returning
           `null` -- a component that renders nothing is an invitation to find a use for it. */
        null
      ) : (
        <OperatingRoundCorporationPanel gameState={gameState} marketGrid={marketGrid} />
      )}
      {error && <p style={styles.staleNote}>Showing last known state — latest refresh failed: {error}</p>}
    </div>
  );
}

export default ContextualSubPanel;

/* ------------------------------------------------------------------ */
/* Pre-Game Waterfall Auction: deferred to the dedicated dashboard     */
/* ------------------------------------------------------------------ */

/** The auction pane deliberately does NOT duplicate the six-private bid/buy UI -- that lives in
 *  `WaterfallAuctionDashboard.tsx`, rendered in place of the board canvas for this phase. This is a short
 *  pointer, so the pane is not blank or, worse, silently misrendered as an Operating Round panel the way it
 *  would have been before `RoundType` gained this variant. */
function WaterfallAuctionNotice() {
  return (
    <>
      <div style={styles.header}>
        <span style={styles.headerTitle}>Pre-Game Waterfall Auction</span>
      </div>
      <p style={styles.placeholderText}>
        Allocating the six private companies before Stock Round 1 opens — see the Waterfall Auction
        panel above for live bidding.
      </p>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Stock Round: Player Index -- see design note #2                    */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* Operating Round: Corporation panel -- see design note #3           */
/* ------------------------------------------------------------------ */

/* Design note #10: WHAT THIS TABLE CAN AND CANNOT SOURCE. Five of seven columns are straight fields; the other
   two behave differently:
     MARKET VALUE is not on `GameStateResponse` at all -- it lives in `GetMarketGrid`, which is why it arrives as
     a separate prop. Without it the column reads "--" rather than substituting par value, which is a different
     number and would be silently wrong for every floated company.
     THE PRICE-CHANGE ARROW is observed, not reported. Nothing says "a dividend just resolved", so this compares
     against the last price seen -- sound inside an Operating Round, where the dividend decision is the only
     thing that moves a price. Share sales move prices too, but those happen in Stock Rounds, so the ref is
     cleared whenever the round changes and an arrow never carries over.
     ROUTES / LAST RUN CANNOT BE SOURCED AT ALL. The pathfinder really does compute revenue during an Operating
     Round, but no query returns it. The column renders "--" with a plain-language tooltip -- included rather
     than omitted because a visibly empty column is a more honest placeholder than a quietly missing one, and
     the dash means "not reported", not "did not run". */
function OperatingRoundCorporationPanel({
  gameState,
  marketGrid,
}: {
  gameState: GameStateResponse;
  marketGrid?: MarketGridResponse | null;
}) {
  const activeCompanyId = gameState.active_operating_order[gameState.active_corporation_index];
  // Design note #9: the train LIMIT is a property of the phase, not of the
  // corporation -- 4 through Phases 2-3, 3 in Phase 4, 2 from Phase 5 on --
  // so it is derived once for the table rather than per row.
  const phase = derivePhase(gameState);
  // Design note #4 in `TrainBadges.tsx`: lets every chip count, not just
  // the tier currently in the danger window.
  const outlook = rustOutlook(gameState);

  const priceByCompany = React.useMemo(() => {
    const map = new Map<number, number>();
    for (const entry of marketGrid?.positions ?? []) {
      const value = Number(entry.price);
      if (Number.isFinite(value)) map.set(entry.company_id, value);
    }
    return map;
  }, [marketGrid]);

  // Design note #10: the observed-price ref behind the change arrows.
  // Keyed by round so a Stock Round's sales cannot leave an arrow showing
  // in the Operating Round that follows.
  const roundKey = `${gameState.current_round_type}:${gameState.macro_round_number}.${gameState.sub_round_index}`;
  const previousRef = React.useRef<{ key: string; prices: Map<number, number> }>({
    key: roundKey,
    prices: new Map(),
  });
  const deltas = React.useMemo(() => {
    const previous = previousRef.current;
    const result = new Map<number, number>();
    if (previous.key === roundKey) {
      priceByCompany.forEach((price, id) => {
        const before = previous.prices.get(id);
        if (before !== undefined && before !== price) result.set(id, price - before);
      });
      // Merge rather than replace: a company whose price did not change this
      // poll must keep its ORIGINAL baseline, or a two-step move would show
      // only the second step.
      priceByCompany.forEach((price, id) => {
        if (!previous.prices.has(id)) previous.prices.set(id, price);
      });
    } else {
      previousRef.current = { key: roundKey, prices: new Map(priceByCompany) };
    }
    return result;
  }, [priceByCompany, roundKey]);

  return (
    <>
      <div style={styles.header}>
        <span style={styles.headerTitle}>Operating Round — Corporations</span>
        {/* Design note #645: BOTH SIDES OF "OF" ARE ROUND NUMBERS. The old string put two different numbering systems
           either side of one word: `1.1` is a round NAME -- cycle and index, the notation the bar, the log and every
           1830 discussion use -- and the bare `1` after "of" was a COUNT of rounds in the cycle. Both are correct and
           the sentence is not: "1.1 of 1" reads as a position outside its own range.
           NAMING THE LAST ROUND FIXES IT. The reader compares two labels of the same kind rather than translating
           between them, and the phase rule -- one Operating Round in Phase 2, two in Green, three in Brown -- becomes
           legible from the number rather than needing to be known.
           THE SPACE AFTER "OR" IS THE SAME CORRECTION one level down: the bar writes "Operating Round 3.2" and
           `roundLabelFor` writes "OR 3.2", and this alone wrote "OR3.2".
           NO GUARD ON THE LENGTH: it is stamped when the cycle opens (#511) and floored at 1, and if there were such a
           state the honest thing is to show it rather than hide it behind a fallback. */}
        <span style={styles.headerHint}>
          OR {gameState.macro_round_number}.{gameState.sub_round_index} of{" "}
          {gameState.macro_round_number}.{gameState.operating_round_sequence_length}
        </span>
      </div>
      <div style={styles.tableScroll}>
      <table style={styles.table}>
        <thead>
          <tr>
            {/* Design note #11: Corporation leads. The previous order put President first, on the reasoning that an
               Operating Round is about whose turn it is -- but the row IS a corporation, and a table whose first column is
               not its subject reads as sorted by the wrong thing. The active row is marked directly, which answers "whose
               turn" without spending the lead column on it. */}
            <th style={styles.thB}>Corporation</th>
            <th style={styles.thB}>President</th>
            <th style={styles.thNumB}>Market Value</th>
            <th style={styles.thNumB}>Treasury</th>
            <th style={styles.thNumB}>Last Route Payout</th>
            {/* Design note #449: what each corporation's TREASURY owns. The privates a company holds pay it every Operating
               Round and carry the powers it may exercise on its turn, so this table -- the one a player reads while
               deciding what to do on that turn -- was the place they were missing from. */}
            <th style={styles.thB}>Privates</th>
            <th style={styles.thCenterB}>Trains</th>
            <th style={styles.thCenter}>Train Limit</th>
          </tr>
        </thead>
        <tbody>
          {gameState.public_companies.length === 0 && (
            <tr>
              <td style={styles.td} colSpan={8}>
                No companies registered yet.
              </td>
            </tr>
          )}
          {/* Design note #449: OPERATING ORDER, AND UNFLOATED DIMMED. The table rendered in `company_id` order -- the
             contract's table order -- while the round it describes runs in a completely different one, so a player
             reading down this list to work out who acts next was reading the wrong sequence.
             THE SAME RULE `buildOperatingOrder` USES: market price descending, then par, then id. Reproduced rather than
             imported because that function returns only the FLOATED queue and this table shows every corporation -- so
             the two answer different questions over the same comparison. The comparison is the part that must not drift,
             and it is three lines.
             UNFLOATED SORT LAST AND DIM. A corporation with no price is not somewhere in the middle of the operating
             order, it is absent from it, so it belongs after the queue rather than interleaved by whatever par it
             carries. Dimming is the second half of the same statement: the row is context, not a participant. The
             UNFLOATED badge stays -- the dimming says "not in this round", the badge says which rule. */}
          {/* Design note #753: THE ROUND'S OWN QUEUE, not a re-derivation of it.
             REPORTED: "it appears the Operating Round--Corporations panel re-orders itself after every
             corporation acts ... you can end up with a corporation appearing to take its turn after another
             corporation has acted."
             #449's comparison was correct and its inputs were live. Prices move on every dividend, so the
             table re-sorted mid-round while the actual turn order -- frozen in `active_operating_order` when
             the round opened -- did not budge. `sortForOperatingOrder` reads the queue and keeps the old
             comparison only for corporations the queue does not contain, which cannot misrepresent a turn
             order because they are not taking one. */}
          {sortForOperatingOrder(gameState.public_companies, {
            ranks: operatingOrderRanks(gameState),
            priceFor: (companyId) => priceByCompany.get(companyId),
          })
            .map((company) => {
            const isActive = company.company_id === activeCompanyId;
            const price = priceByCompany.get(company.company_id);
            const delta = deltas.get(company.company_id);
            const trains = company.owned_trains;
            const privates = corporationPrivateCompanies(company.company_id, gameState);
            return (
              <tr
                key={company.company_id}
                style={{
                  ...(isActive ? styles.trActive : {}),
                  ...(company.is_floated ? {} : styles.trUnfloated),
                }}
              >
                {/* ---- Corporation: token dot, ticker, full name ---- */}
                <td style={styles.tdB}>
                  <span style={styles.corpCell}>
                    <span
                      style={{
                        ...styles.tokenDot,
                        backgroundColor: stationTickerColor(company.company_id),
                      }}
                      aria-hidden="true"
                    />
                    <span style={styles.corpTicker}>{company.ticker}</span>
                    {corporationFullName(company.ticker) && (
                      <span style={styles.corpFullName}>
                        {corporationFullName(company.ticker)}
                      </span>
                    )}
                    {isActive && <span style={styles.activeBadge}>ACTIVE</span>}
                    {/* Design note #8: a badge only on the EXCEPTION. A
                        Floated Yes/No column spent a whole column restating
                        "operational" seven times to flag the one company
                        that is not. */}
                    {!company.is_floated && <span style={styles.unfloatedBadge}>UNFLOATED</span>}
                  </span>
                </td>

                {/* ---- President ---- */}
                <td style={styles.tdB}>
                  {company.president ? (
                    <span style={styles.presidentCell}>
                      {/* Design note #552. Decorative here: the name sits
                          right beside it and the column header already says
                          President, so an accessible name would make a
                          screen reader announce the word twice per row. */}
                      {/* Design note #974: the hex is `PRESIDENT_CROWN_GOLD` now, not a literal -- three
                          panels were typing the same string and a near-miss in one of them would be
                          invisible. */}
                      <PresidentCrown
                        label={null}
                        scale={1.05}
                        style={{ color: PRESIDENT_CROWN_GOLD }}
                      />
                      <span>{playerLabel(company.president)}</span>
                    </span>
                  ) : (
                    <span style={styles.emptyCell}>--</span>
                  )}
                </td>

                {/* ---- Market Value, with an observed change arrow ---- */}
                <td style={styles.tdNumB}>
                  {price === undefined ? (
                    <span style={styles.emptyCell}>--</span>
                  ) : delta === undefined ? (
                    `$${price}`
                  ) : (
                    <span
                      style={delta > 0 ? styles.priceUp : styles.priceDown}
                      title={
                        delta > 0
                          ? `Paid dividends — price rose from $${price - delta}.`
                          : `Withheld revenue — price fell from $${price - delta}.`
                      }
                    >
                      {delta > 0 ? "\u2191" : "\u2193"} ${price}
                    </span>
                  )}
                </td>

                {/* ---- Treasury ---- */}
                <td style={styles.tdNumB}>${company.treasury}</td>

                {/* ---- Last route payout -- design note #10 ---- */}
                <td style={styles.tdNumB}>
                  <LastRoutePayout surface="dark" revenue={company.last_route_revenue} />
                </td>

                {/* Privates this corporation's treasury owns -- design note #449. `PrivateCompanyPills` is the same component
                   the auction table and the Ledger render, so a private looks the same wherever it is listed and its rules text
                   is one click away here too. */}
                <td style={styles.tdB}>
                  <PrivateCompanyPills privates={privates} surface="table" emptyLabel="--" />
                </td>

                {/* ---- Trains, as chips ---- */}
                <td style={styles.tdCenterB}>
                  <TrainChips trains={trains} phase={phase} surface="dark" outlook={outlook} />
                </td>

                {/* ---- Capacity pill ---- */}
                <td style={styles.tdCenter}>
                  <CapacityPill trains={trains} phase={phase} surface="dark" />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      </div>
    </>
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
/* Inline styles                                                      */
/* ------------------------------------------------------------------ */

// Design note #5 (final visual theme pass): this is the structural footer pane underneath the board -- text
// scale boosted throughout so the active phase status is clear at a glance rather than reading as fine print.
const styles: Record<string, React.CSSProperties> = {
  root: {
    display: "flex",
    flexDirection: "column",
    gap: "10px",
    padding: "18px 20px",
    backgroundColor: "#161922",
    border: "1px solid #2a2e3a",
    borderRadius: "10px",
    color: "#e6e8ef",
    fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif",
  },
  header: {
    display: "flex",
    alignItems: "baseline",
    gap: "12px",
  },
  headerTitle: {
    fontSize: FONT_SIZE.heading,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.04em",
    color: "#c8cbd6",
  },
  headerHint: {
    fontSize: FONT_SIZE.strong,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    color: "#8a90a0",
  },
  placeholderText: {
    fontSize: FONT_SIZE.strong,
    color: "#6f7480",
    margin: 0,
  },
  staleNote: {
    fontSize: FONT_SIZE.body,
    color: "#8a6d1f",
    margin: 0,
  },
  table: {
    width: "100%",
    borderCollapse: "collapse",
    fontSize: FONT_SIZE.strong,
  },
  tableScroll: { overflowX: "auto", width: "100%" },
  /* Design note #11: one header treatment for every column. Previously `th` was 600 and mixed-case while the
     numeric variants only overrode alignment, so a seven-column row had headers of two different weights
     depending on which cell you looked at. All four variants now differ ONLY in alignment and the divider, which
     is the whole point of having variants. */
  th: {
    textAlign: "left",
    padding: "8px 12px",
    color: "#8a90a0",
    borderBottom: "1px solid #2a2e3a",
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.06em",
    fontSize: FONT_SIZE.micro,
    whiteSpace: "nowrap",
  },
  td: {
    padding: "9px 12px",
    borderBottom: "1px solid #1e2129",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  },
  /* Design note #449: a corporation that cannot operate is context, not a
     participant. Dimmed rather than hidden -- a player still wants to see
     which companies exist and how close they are to floating. */
  trUnfloated: { opacity: 0.5 },
  trActive: {
    backgroundColor: "#1f2a1f",
  },
  /** Design note #8: right-aligned numeric cells and headers. ALIGNMENT-ONLY OVERRIDES -- they carry no padding,
   *  border or font, so they must be spread OVER `th`/`td` rather than used in place of them. Used bare, a cell
   *  silently loses its box and the row's borders break where that column sits. The `*B` variants are complete
   *  styles precisely because that trap kept catching this table. */
  thNum: { textAlign: "right" },
  tdNum: { textAlign: "right", fontVariantNumeric: "tabular-nums" },

  /* Design note #11: vertical dividers on `borderRight` rather than `borderLeft`, so the LAST column can use the
     undivided variant and not draw an edge against the panel wall. Seven columns is past the point where a row
     can be tracked by alignment alone. */
  thB: {
    textAlign: "left",
    padding: "8px 12px",
    color: "#8a90a0",
    borderBottom: "1px solid #2a2e3a",
    borderRight: "1px solid #262b36",
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.06em",
    fontSize: FONT_SIZE.micro,
    whiteSpace: "nowrap",
  },
  thNumB: {
    textAlign: "right",
    padding: "8px 12px",
    color: "#8a90a0",
    borderBottom: "1px solid #2a2e3a",
    borderRight: "1px solid #262b36",
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.06em",
    fontSize: FONT_SIZE.micro,
    whiteSpace: "nowrap",
  },
  thCenter: {
    textAlign: "center",
    padding: "8px 12px",
    color: "#8a90a0",
    borderBottom: "1px solid #2a2e3a",
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.06em",
    fontSize: FONT_SIZE.micro,
    whiteSpace: "nowrap",
  },
  thCenterB: {
    textAlign: "center",
    padding: "8px 12px",
    color: "#8a90a0",
    borderBottom: "1px solid #2a2e3a",
    borderRight: "1px solid #262b36",
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.06em",
    fontSize: FONT_SIZE.micro,
    whiteSpace: "nowrap",
  },
  tdB: {
    padding: "9px 12px",
    borderBottom: "1px solid #1e2129",
    borderRight: "1px solid #1e2129",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  },
  tdNumB: {
    padding: "9px 12px",
    borderBottom: "1px solid #1e2129",
    borderRight: "1px solid #1e2129",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    textAlign: "right",
    fontVariantNumeric: "tabular-nums",
    whiteSpace: "nowrap",
  },
  tdCenter: {
    padding: "9px 12px",
    borderBottom: "1px solid #1e2129",
    textAlign: "center",
  },
  tdCenterB: {
    padding: "9px 12px",
    borderBottom: "1px solid #1e2129",
    borderRight: "1px solid #1e2129",
    textAlign: "center",
  },

  /* ---- Cell contents ---- */
  corpCell: { display: "inline-flex", alignItems: "center", gap: "6px", flexWrap: "wrap" },
  // The map token, shrunk to a dot. Same colour table the canvas draws with
  // (`stationTickerColor`), so a corporation reads the same here as on the
  // board rather than being a second, unrelated colour scheme.
  tokenDot: {
    width: "10px",
    height: "10px",
    borderRadius: "50%",
    flexShrink: 0,
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "rgba(255,255,255,0.35)",
  },
  // Design note #552: `color` on the row would tint the NAME too, so the
  // crown's gold is set on the crown and the name keeps the cell's ink.
  presidentCell: {
    display: "inline-flex",
    alignItems: "center",
    gap: "6px",
    color: "inherit",
  },
  emptyCell: { color: "#5a5f6b" },
  priceUp: { color: "#5fd38f", fontWeight: 700 },
  priceDown: { color: "#e08585", fontWeight: 700 },

  /* ---- Train chips ---- */
  // One train left in the depot of the current tier: the rust is two
  // purchases away.
  // Depot empty: the very next purchase rusts these.

  /* ---- Capacity pill ---- */
  // A corporation at its limit cannot buy another train this phase -- worth
  // marking, because the Buy Train button will simply refuse otherwise.
  corpTicker: { fontWeight: 700 },
  corpFullName: {
    marginLeft: "7px",
    fontSize: FONT_SIZE.micro,
    color: "#8a90a0",
    whiteSpace: "nowrap",
  },
  /** The inline Priority Deal marker -- bare text, no container. It sits in the same cell as the boxed ACTIVE
   *  badge, and that adjacency is exactly why it must NOT be boxed: two pills side by side read as a pair of equal
   *  states, when one is "acting now" and the other is "acts first next round".
   *  Kept byte-identical to `FinancialLedger`'s own marker so the same indicator looks the same in both places. */
  priorityDealMark: {
    marginLeft: "6px",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontWeight: 700,
    fontSize: FONT_SIZE.small,
    letterSpacing: "-0.025em",
    color: "#38bdf8",
    cursor: "help",
  },
  activeBadge: {
    marginLeft: "10px",
    fontSize: FONT_SIZE.small,
    fontWeight: 700,
    fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif",
    padding: "2px 9px",
    borderRadius: "999px",
    backgroundColor: "#1f7a3f",
    color: "#eafff0",
  },
  // This key was REFERENCED at the UNFLOATED call site above and never DEFINED, so it evaluated to `undefined`
  // and the badge rendered as unstyled body text -- indistinguishable from the corporation's name beside it.
  // Nothing caught it because `styles` is typed `Record<string, React.CSSProperties>`, an index signature that
  // accepts any key and so cannot tell a real style from a typo. `FinancialLedger.tsx` has the same exposure.
  // Colours come from `palette.ts` rather than being restated here, which is the point of that module: the
  // Ledger's copy of this badge and this one physically cannot drift apart again.
  unfloatedBadge: {
    marginLeft: "10px",
    fontSize: FONT_SIZE.micro,
    fontWeight: 500,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    letterSpacing: "0.4px",
    padding: "2px 8px",
    borderRadius: "4px",
    backgroundColor: CHIP_INERT_BG,
    border: `1px solid ${CHIP_INERT_BORDER}`,
    color: CHIP_INERT_INK,
    whiteSpace: "nowrap",
  },
  footnote: {
    fontSize: FONT_SIZE.body,
    color: "#6f7480",
    margin: 0,
    lineHeight: 1.4,
  },
};
