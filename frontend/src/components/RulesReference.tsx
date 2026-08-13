// frontend/src/components/RulesReference.tsx
//
// The "Rules Reference" top-level tab (see App.tsx's restructure, item 6 of
// this pass): a clean, player-facing summary of real 1830 limits and caps,
// for players to check mid-game.
//
// Design notes:
// 1. **Sourced, not remembered -- but presented clean, not annotated.**
//    Every figure below was fetched from the open-source `tobymao/18xx`
//    engine's real 1830 config (`lib/engine/game/g_1830/game.rb`,
//    `lib/engine/game/g_1830/entities.rb`, plus the engine-wide defaults in
//    `lib/engine/game/base.rb`/`lib/engine/corporation.rb` that 1830
//    inherits from), the SAME repository this project has already used to
//    source the board layout (`HexGridRenderer.tsx` design notes #6/#10/
//    #12) and stock market grid (`StockMarketRenderer.tsx` design note #3).
//    An earlier pass of this tab surfaced a per-row "confidence" badge
//    (verbatim / engine default / not verbatim-confirmed) directly in the
//    player-facing UI -- useful for this project's own development process,
//    but exactly the kind of developer bookkeeping a player checking a rule
//    mid-game doesn't want to see. This pass removes that UI entirely; the
//    sourcing discipline itself hasn't changed (every figure below is still
//    independently checked against this project's own already-implemented
//    contract logic where the contract has an opinion -- see the two
//    explicit confirmations below -- and against the sourced engine data
//    otherwise), it just no longer surfaces as an on-screen tag.
// 2. **This is reference-only content -- nothing here reads live game
//    state.** Unlike every other new panel in this pass
//    (`ContextualSubPanel.tsx`, `FinancialLedger.tsx`), this tab has no
//    `gameState` prop at all: it's the same static rules regardless of
//    which room/round is active, matching how a real rulebook insert would
//    work.
// 3. **Two rules explicitly confirmed against this contract's own
//    implementation, not just the source engine.** Capitalization
//    (`trading.rs`'s `FLOAT_CAPITALIZATION_MULTIPLIER = 10` applied the
//    instant `FLOAT_THRESHOLD_PERCENTAGE = 60` is crossed) and the
//    president's certificate (`STANDARD_SHARE_COUNT = 10` ten-percent
//    units, sold as 9 physical certificates: one 20% president's
//    certificate plus eight 10% certificates) are both real constants in
//    `src/trading.rs`, re-checked directly against that file for this pass
//    rather than only against the reference engine -- see the two rows
//    below, each written out in full rather than left as a compressed
//    label + badge.
// 4. **President's certificate limit correction.** An earlier pass of this
//    row stated the president's 20% certificate counts as 2 certificates
//    against the certificate limit -- a common misconception, but wrong.
//    Re-verified against three independent sources: the official Lookout
//    Games "1830: Railways & Robber Barons" rulebook (Section 4.3/5.3, "the
//    president's certificate ... is two shares (20%), but counts as a
//    single certificate"), the classic 18xx.net rules text ("The limit is
//    on certificates, some of which may be worth 20% of the stock"), and
//    the open-source `tobymao/18xx` engine's own `num_certs`
//    implementation (`lib/engine/game/base.rb`), which sums each share's
//    `cert_size` -- a field that defaults to `1` and is never overridden to
//    `2` for a president's `Share` object (`lib/engine/share.rb`/
//    `lib/engine/corporation.rb`). All three agree without exception: it
//    counts as exactly 1. A follow-up pass tightened this row's wording
//    down to the single sentence the rule actually is ("Counts as exactly
//    1 certificate.") and removed the earlier "physical card"/"hand slot"
//    framing entirely -- that framing wasn't wrong, but it invited a reader
//    to think of "hand slot count" and "certificate count" as two separate
//    numbers that just happen to agree, when they're actually the same
//    count by definition; stating the rule directly avoids that confusion.
// 5. **Game Flow summaries, verified against this contract's own
//    implementation, not just generic 1830 knowledge.** The Stock Round and
//    Operating Round sections below describe what `contract.rs`/
//    `trading.rs`/`operations.rs`/`hardware.rs` actually enforce, re-read
//    directly for this pass rather than assumed from familiarity with
//    physical 1830. Two honesty notes worth surfacing here rather than
//    glossing over in the player-facing copy: (a) a corporation's Lay
//    Track / Buy Equipment / Declare Dividends actions within its own
//    Operating Round turn are NOT sequence-enforced by this contract -- a
//    President may call them in any order, or skip any of them, before
//    ending the turn (`operations.rs` module doc comment #10 explicitly
//    notes `EndOperatingRoundTurn` does not require any prior action to
//    have been taken); (b) route revenue itself is computed by
//    `ExecuteOperatingRound`, a separate batched, creator/Validator-only
//    transaction that runs every listed company's Pathfinding Revenue
//    Engine pass in one shot (`operations.rs` module doc comment #1) --
//    it is not yet wired into each corporation's individual turn the way
//    Lay Track / Buy Equipment / Declare Dividends are. The summary below
//    presents the classic conceptual sequence for player-facing clarity
//    while these two notes keep this file's sourcing discipline intact.
// 6. **Font-Size & Cleanliness Pass.** Two items:
//    (1) Every text style in this file's `styles` object is scaled up --
//    roughly the same 25-40% ratio `App.tsx`/`Chatbox.tsx`'s own prior
//    "final visual theme" upscaling passes used (e.g. `App.tsx` design note
//    #12) -- for significantly better legibility on this tab specifically:
//    `pageTitle` 20px -> 26px, `sourceNote`/`flowIntro`/`flowStep`/
//    `flowDetail` 12px -> 16px, `sectionTitle` 14px -> 18px, table text
//    13px -> 16px, `rowNote` 11px -> 14px. Paddings/line-heights nudged up
//    alongside the text so denser elements (table cells, flow-step cards)
//    don't feel cramped at the new, larger point sizes.
//    (2) Developer-comment/placeholder/TODO audit of the RENDERED output:
//    this file's design notes above (like every other component in this
//    codebase) live in a top-of-file JS comment block, which React never
//    renders -- they were never player-visible to begin with. A full
//    re-read of every JSX-rendered string in the component below (table
//    cells, flow-step text, section titles, the source note) turned up
//    zero "TODO"/"FIXME"/placeholder/debug strings; the confidence-badge
//    UI design note #1 describes removing (verbatim/engine-default tags)
//    was already gone before this pass, per that note's own account. This
//    item is therefore a verified-clean audit, not a cleanup with visible
//    before/after -- recorded here rather than silently skipped, so a
//    future reader knows the check was actually done.
// 7. **"Current Round Quick Reference" Section.** A new, prominent
//    `position: sticky` section (`QuickReferenceSection`) now renders FIRST
//    on this tab, stuck to the top of the page's own scroll container
//    (`styles.root`'s `overflowY: "auto"`) as the player scrolls down
//    through the longer reference tables below it. Two optional new props,
//    `roundType`/`operatingSubPhase` (locally-typed unions structurally
//    identical to `GameStateResponse['current_round_type']`/`App.tsx`'s own
//    `OperatingSubPhase`, not imported -- same "no gameState coupling"
//    discipline as design note #2, extended minimally): when `App.tsx`
//    supplies them (see that file's own design note #17), this section
//    DYNAMICALLY shows only the currently-active round's own numbered
//    checklist, pulled from this file's own `STOCK_ROUND_FLOW`/
//    `OPERATING_ROUND_FLOW`/new `AUCTION_FLOW` arrays (each gained a new
//    `quick` field -- a compact one-line version of the existing `detail`
//    prose, used here; the full `detail` text still drives the unchanged
//    Game Flow sections further down the page) -- e.g. "Operating Round --
//    Step 3 of 5: Dividends." When `roundType` is omitted (this tab used
//    standalone, e.g. outside a live room), it instead CLEARLY OUTLINES all
//    three round types side by side as compact cards, so the section is
//    always useful, connected or not. `AUCTION_FLOW` documents the five
//    real Waterfall Auction actions (`WaterfallBuyLowest`/`WaterfallBidHigher`/
//    `WaterfallPass`/`WaterfallMiniAuctionRaise`/`WaterfallMiniAuctionPass`),
//    sourced from `WaterfallAuctionDashboard.tsx`'s own design notes --
//    this tab previously had no auction-round content at all.
// 8. **Operating Round Flow Correction: "Buy Private Company" (Phase 3+).**
//    `OPERATING_ROUND_FLOW` was missing a real, already-implemented action:
//    a corporation's President may buy a still-owned private company
//    directly from the player holding it, using the corporation's
//    treasury. Sourced directly from this same contract's own
//    `ContextualActionBar` implementation in `App.tsx` (design note #14
//    there) rather than re-derived from scratch: available starting in
//    Phase 3 (`current_global_era !== "Yellow"`, mirroring
//    `trading::execute_buy_private_company`'s own
//    `PrivatePurchaseLockedBeforePhase3` gate), dispatched during a
//    corporation's own Operating Round turn, at a price bounded on-chain to
//    50%-200% of the private's face value (`App.tsx`'s own floor
//    `Math.ceil(cost / 2)` / ceiling `cost * 2`, re-enforced server-side by
//    `trading.rs` regardless of what the client submits). Added as this
//    section's fifth step; `flowIntro`'s "four actions" wording updated to
//    "five actions" to match.

// 9. **Legibility/Layout Follow-Up (direct feedback on design notes #6/#7).**
//    Three fixes, all styling/structure -- no rule content changed except
//    the new narrative section in item (3):
//    (1) Content/description text was still reported too small even after
//    design note #6's pass. Pushed further: `flowDetail`/`quickListDetail`
//    15px -> 18px, `rowNote` 13px -> 16px, table `td`/`th` 16px -> 18px,
//    `sourceNote`/`flowIntro` 15px -> 17px, `quickListItemCompact` (the
//    disconnected fallback's compact cards) 13px -> 15px. Line-heights
//    nudged up alongside (1.5-1.6 -> 1.6-1.7) so the larger text doesn't
//    feel cramped.
//    (2) Direct feedback: "Certificate Limits and Caps" and "Core Limits
//    and Caps" "seem like they belong together rather than at the top and
//    bottom." Restructured into a two-column layout
//    (`styles.mainColumns`/`mainColumn`/`sideColumn`) below the page
//    title/source note: a right-hand `<aside>` now stacks all three
//    quick-lookup reference tables together in reading order -- Core
//    Limits & Caps, Certificate Limit by Player Count, Starting Cash by
//    Player Count -- while the left column carries the new narrative
//    section (item 3) and the three Game Flow sections. `flexWrap: "wrap"`
//    on `mainColumns` lets the side column drop below the main column on a
//    narrow viewport rather than squeezing both into unreadable slivers.
//    (3) Direct feedback: "the rules reference needs a more
//    prosaic/narrative explanation of the game, your purpose as a player,
//    and the win conditions." New `AboutSection` (prose paragraphs, no
//    bullet lists, per the request's own "prosaic/narrative" wording) added
//    at the top of the left column, right after the page title. Sourced
//    directly from this contract's own real logic, not generic 1830
//    knowledge -- re-read for this pass: personal net worth is
//    `contract::calculate_player_net_worth` (cash plus live share value,
//    a company's own treasury explicitly excluded -- see that function's
//    own doc comment); the real-JUNO ante pool is redistributed
//    proportionally to final net worth by
//    `contract::finalize_and_distribute_payouts`, the shared core behind
//    both `EndGameAndDistribute` (room creator, any time) and the
//    automatic $350 Game-End Trigger; and the game's four real end paths
//    are enumerated precisely -- including calling out, same as
//    `market.rs`'s own module doc comment does, that the $350 trigger is
//    "this project's own explicit, user-requested house rule, not a
//    transcription of the [reference] engine's behavior," while the Bank
//    running dry (`GameSession::bank_is_broken`, `trading.rs`) is "the real
//    rulebook's primary end condition" -- so a player reading this section
//    gets the same honest real-vs-house-rule distinction this codebase's
//    other design notes already insist on, not a flattened "it just ends
//    at $350" oversimplification.

// 10. **Page Restructure -- Top Row (Narrative | Current Round) / Bottom Row
//    (side-by-side lookup tables).** Direct feedback on design note #9's
//    layout: "Put the two Caps and Limits tables side-by-side at the bottom
//    of the page. Above them, on the left let's have the narrative rules
//    explanation, and on the right let's display the current round's rules
//    reference." Three changes, no rule content changed:
//    (1) The old sticky `QuickReferenceSection` (design note #7) -- which,
//    when disconnected from a live room, only showed a one-line-per-step
//    quick summary for all three rounds, and, when connected, showed a
//    one-line checklist for the active round only -- is replaced by
//    `CurrentRoundReferenceSection`. It is no longer sticky (it now lives in
//    a normal top-row column, not pinned above the whole page), and it
//    always renders all three rounds' FULL step-by-step `detail` prose (not
//    just the `quick` one-liners), each step leading with its `quick`
//    one-liner as a bold headline directly above the full `detail`
//    paragraph. This was necessary because this restructure also REMOVES the
//    three standalone "Game Flow -- Auction/Stock Round/Operating Round"
//    sections that used to carry that same full-detail content further down
//    the page -- folding them into this one column loses no information
//    only because it now always shows full detail for every round, not just
//    the active one. When connected via the `roundType`/`operatingSubPhase`
//    props, the active round is reordered to the front and gets an "ACTIVE"
//    badge (plus the existing UI-sub-phase badge for Operating Rounds); when
//    disconnected, all three render in their normal order with no badge.
//    (2) Page structure is now two stacked rows instead of the prior
//    single two-column layout. `styles.topRow`: `AboutSection` (the
//    narrative added in note #9(3)) on the left in `topRowLeft`,
//    `CurrentRoundReferenceSection` on the right in `topRowRight` -- this is
//    the literal "left = narrative, right = current round's rules
//    reference" the feedback asked for. `styles.bottomRow`, below it, holds
//    exactly the two lookup tables side by side: "Core Limits & Caps"
//    (unchanged) and a new merged "Certificate Limit & Starting Cash by
//    Player Count" table -- the two previously-separate "Certificate Limit
//    by Player Count" / "Starting Cash by Player Count" tables are combined
//    into one three-column table (Players | Certificate Limit | Starting
//    Cash), zipped by matching `players` from the existing
//    `CERT_LIMIT_BY_PLAYERS`/`STARTING_CASH_BY_PLAYERS` arrays (neither
//    array's own data changed) -- read together as "the two Caps and Limits
//    tables" the feedback named.
//    (3) Styles: `mainColumns`/`mainColumn`/`sideColumn` (the prior
//    left-column/right-sidebar layout) are removed and replaced by
//    `topRow`/`topRowLeft`/`topRowRight`/`bottomRow`/`bottomRowColumn`.
//    `quickRefSection`'s sticky positioning is dropped in favor of the new
//    non-sticky `currentRoundSection`; `currentRoundBlock`/`flowItemHead`/
//    `flowQuick`/`currentRoundDivider` are added for the new component;
//    `flowItem` changes from a row layout (step name + detail inline) to a
//    column layout, since it now stacks `flowItemHead` (step name + quick
//    summary) above the full `flowDetail` paragraph rather than laying two
//    inline siblings side by side. Styles left over from the old
//    disconnected-fallback compact-card view that nothing renders with
//    anymore (`quickRefTitle`, `quickList`, `quickListItem`,
//    `quickListItemCompact`, `quickListIndex`, `quickListStep`,
//    `quickListDetail`, `quickRefGrid`, `quickRefCard`) and the now-unused
//    `flowIntro` (only used by the removed standalone Game Flow sections)
//    are deleted rather than left dead in the file.

import React from "react";

interface RuleRow {
  label: string;
  value: string;
  note?: string;
}

const CORE_LIMITS: RuleRow[] = [
  {
    label: "Bank cash (total pool)",
    value: "$12,000",
  },
  // F-7: the two stock-round restrictions this table never documented.
  // Both were invisible at every layer -- not in the rules panel, and not
  // surfaced by the Stock Round controls -- so a player could only discover
  // them by having a transaction rejected.
  {
    label: "Stock Round 1 -- no sales",
    value: "Selling is prohibited for the whole of SR1",
    note:
      "In the first Stock Round of the game nobody may sell any certificate, of any corporation, for any reason. The round is buy-or-pass only. This exists so the opening share auction cannot be immediately unwound: without it, a player could buy a presidency, bank the price movement and dump it in the same round, which is not a strategy 1830 intends to offer. The restriction lifts completely at SR2 and never returns.",
  },
  {
    label: "Bank Pool cap (per corporation)",
    value: "50% -- shares may not be sold into a pool already at 50%",
    note:
      "The Bank Pool holds shares players have sold back. It caps at 50% of any one corporation's shares, and the cap is checked against the pool's CURRENT level, not against the size of your sale -- so the room for a sale is 50% minus whatever is already in the pool, and it grows again as other players buy out of it. A 40% bundle into a pool already holding 20% is rejected; the same bundle is legal once the pool drops to 10%. This is why a sell size can be greyed out one turn and available the next.",
  },
  {
    label: "Capitalization mode -- Full Capitalization",
    value: "10x Par credited to treasury immediately upon floating at 60%",
    note: "The moment a corporation crosses the 60% float threshold, its treasury is credited its full par price x 10 shares in one lump sum -- not gradually, and not scaled down to however many shares had actually sold at that moment. This is confirmed directly against this contract's own `trading.rs` (`FLOAT_CAPITALIZATION_MULTIPLIER = 10`, applied as soon as `FLOAT_THRESHOLD_PERCENTAGE = 60` is crossed), not just the reference rulebook.",
  },
  {
    label: "Corporation float threshold",
    value: "60% of shares sold",
  },
  {
    label: "Per-player ownership cap (per corporation)",
    value: "60%",
    note: "Waived for a share sitting in the Orange or Brown stock-market zones -- see the Stock Market tab's own zone legend.",
  },
  {
    label: "Shares per public company",
    value: "9 physical certificates (100% total)",
    note: "One 20% president's certificate plus eight 10% certificates -- ten 10%-units of ownership in total, held as nine physical cards.",
  },
  {
    label: "President's certificate -- certificate limit",
    value: "Counts as exactly 1 certificate.",
    note: "The president's 20% certificate counts the same as any ordinary 10% certificate against a player's certificate limit, despite representing double the ownership.",
  },
  {
    label: "Private company minimum bid increment",
    value: "$5",
  },
];

const CERT_LIMIT_BY_PLAYERS: Array<{ players: number; limit: number }> = [
  { players: 2, limit: 28 },
  { players: 3, limit: 20 },
  { players: 4, limit: 16 },
  { players: 5, limit: 13 },
  { players: 6, limit: 11 },
];

const STARTING_CASH_BY_PLAYERS: Array<{ players: number; cash: number }> = [
  { players: 2, cash: 1200 },
  { players: 3, cash: 800 },
  { players: 4, cash: 600 },
  { players: 5, cash: 480 },
  { players: 6, cash: 400 },
];

interface FlowStep {
  step: string;
  detail: string;
  /** Compact, one-line version of `detail` -- see design note #7. Powers
   *  the new "Current Round Quick Reference" section's scannable checklist;
   *  `detail` (unchanged) still drives the full Game Flow sections below. */
  quick: string;
}

/** Stock Round loop -- see design note #5. Repeats player-by-player until
 *  the room's creator explicitly begins the next Operating Round
 *  (`BeginOperatingRound`); this contract has no automatic pass-streak
 *  transition (`GameSession::consecutive_passes` is tracked but not yet
 *  consumed). */
const STOCK_ROUND_FLOW: FlowStep[] = [
  {
    step: "Buy 1 share",
    detail:
      "The active player may buy exactly one 10% certificate this turn, from either a company's IPO pool (paying its par price -- or setting that par price, on the company's very first-ever IPO sale) or the open Bank pool (paying its live market price). Crossing 60% player-owned floats the company and credits its treasury 10x par immediately.",
    quick: "Buy exactly one 10% certificate (IPO pool or Bank pool).",
  },
  {
    step: "Sell any",
    detail:
      "The active player may instead sell any number of certificates they hold back to the Bank pool, each moving that company's market price down one step and paying the seller its price at the moment of sale.",
    quick: "Sell any number of held certificates back to the Bank pool.",
  },
  {
    step: "Pass",
    detail: "The active player may decline to buy or sell this turn.",
    quick: "Decline to act this turn.",
  },
];

/** Operating Round per-corporation turn -- see design note #5 for the two
 *  honesty notes this summary is paired with (no in-turn sequence
 *  enforcement; route revenue is a separate batched transaction), and
 *  design note #8 for the "Buy Private Company" step added by this pass. */
const OPERATING_ROUND_FLOW: FlowStep[] = [
  {
    step: "Lay Track",
    detail:
      "The active corporation's President may lay or upgrade tiles on the map, extending its rail network. A company's very first tile lay (at its home hex) doubles as placing its home Station token -- there is no separate token-placement action.",
    quick: "Lay or upgrade one tile; first lay also places the home Station.",
  },
  {
    step: "Routes",
    detail:
      "Revenue is computed automatically by the Pathfinding Revenue Engine, bounded by the company's best-owned train's max route distance -- see design note #5(b) for exactly when this runs relative to a single corporation's turn.",
    quick: "Revenue auto-computed by the Pathfinding Revenue Engine.",
  },
  {
    step: "Dividends",
    detail:
      "The President may declare dividends on whatever revenue the company earned: distribute it across every shareholder (including the Bank pool's own share, credited to the bank), or retain it into the company's treasury.",
    quick: "Pay out this turn's revenue to shareholders, or withhold it.",
  },
  {
    step: "Buy Equipment",
    detail:
      "The President may buy the next train at the front of the shared Hardware pool, paid from the company's treasury -- subject to the corporation's current Train Limit (see Core Limits & Caps) and triggering a Rusting sweep if it's the room's first-ever unit of a new tier.",
    quick: "Buy the next train from the shared Hardware pool.",
  },
  {
    step: "Buy Private Company",
    detail:
      "Starting in Phase 3, the President may spend the corporation's treasury to buy a still-owned private company directly from the player holding it, at a price the two negotiate but bounded on-chain to 50%-200% of that private's face value -- see design note #8 for the exact contract mechanics this mirrors (`trading::execute_buy_private_company`'s `PrivatePurchaseLockedBeforePhase3` gate and price bound).",
    quick: "Phase 3+: buy a private from a player, 50%-200% of face value.",
  },
];

/** Pre-Game Waterfall Auction -- see design note #7. The five real
 *  `ExecuteMsg` actions `waterfall.rs` implements, sourced from
 *  `WaterfallAuctionDashboard.tsx`'s own design notes (that component's
 *  interactive dashboard for this same round). Runs once, before Stock
 *  Round 1 ever opens -- allocates 1830's six private companies. */
const AUCTION_FLOW: FlowStep[] = [
  {
    step: "Buy Lowest",
    detail:
      "Any player, on their turn in the auction's seating rotation, may buy the current lowest-priced still-unowned private company outright at its face value -- the only private WaterfallBuyLowest can target, and the only one that can never be bid on instead.",
    quick: "Buy the current lowest-offered private at face value.",
  },
  {
    step: "Bid Higher",
    detail:
      "A player may instead place a competing bid on any OTHER still-unowned private (not the lowest-offered one), at or above its face value plus the $5 minimum bid increment over any standing high bid.",
    quick: "Bid on any other still-unowned private.",
  },
  {
    step: "Pass",
    detail:
      "A player may decline to buy or bid this turn -- only a legal move once at least one private has a standing bid outstanding somewhere in the auction.",
    quick: "Decline -- only legal while a bid stands somewhere.",
  },
  {
    step: "Mini-Auction Raise",
    detail:
      "Once every other player has passed on the lowest-offered private while at least one bid stands elsewhere, a mini-auction runs among that private's tied bidders: on their turn, a tied bidder may raise their bid.",
    quick: "Tied bidder: raise your bid.",
  },
  {
    step: "Mini-Auction Pass",
    detail:
      "A tied bidder may instead drop out of the mini-auction -- their escrowed bid is fully refunded, and the auction continues among the remaining bidder(s).",
    quick: "Tied bidder: drop out (bid fully refunded).",
  },
];

/* ------------------------------------------------------------------ */
/* Current Round Quick Reference -- see design note #7                */
/* ------------------------------------------------------------------ */

type RulesRoundType = "WaterfallAuction" | "StockRound" | "OperatingRound";
type RulesOperatingSubPhase = "Track" | "Tokens" | "Dividends" | "Hardware";

const ROUND_ORDER: RulesRoundType[] = ["WaterfallAuction", "StockRound", "OperatingRound"];

const ROUND_META: Readonly<Record<RulesRoundType, { label: string; flow: FlowStep[] }>> = {
  WaterfallAuction: { label: "Auction (Pre-Game)", flow: AUCTION_FLOW },
  StockRound: { label: "Stock Round", flow: STOCK_ROUND_FLOW },
  OperatingRound: { label: "Operating Round", flow: OPERATING_ROUND_FLOW },
};

/** Mirrors `App.tsx`'s own `OPERATING_SUB_PHASE_LABELS` exactly (name +
 *  1-based index) -- hand-kept duplicate, not imported, per design note #7's
 *  "no gameState/App.tsx coupling beyond two optional display props"
 *  discipline. Only used for the small supplementary UI-step badge; the
 *  numbered checklist itself always comes from `OPERATING_ROUND_FLOW`. */
const OPERATING_SUB_PHASE_QUICK_LABELS: Readonly<Record<RulesOperatingSubPhase, { index: number; name: string }>> = {
  Track: { index: 1, name: "Track" },
  Tokens: { index: 2, name: "Tokens" },
  Dividends: { index: 3, name: "Dividends" },
  Hardware: { index: 4, name: "Hardware" },
};

/** Right-column card -- see design note #10. Unlike the superseded
 *  `QuickReferenceSection` this replaces (one-line-per-step "quick"
 *  summaries only), this always renders EVERY round's FULL step-by-step
 *  detail -- the same `detail` prose the old standalone "Game Flow --
 *  Auction/Stock Round/Operating Round" sections used to carry -- so
 *  consolidating those three sections into this one column loses no
 *  content. When connected, the live round is reordered to the front and
 *  gets an "ACTIVE" badge; each step also leads with its own `quick`
 *  one-liner (bold) directly above the full `detail` paragraph, so the
 *  list stays scannable at a glance while still offering the complete
 *  explanation underneath -- both `FlowStep` fields now do real work
 *  everywhere this type is rendered. */
function CurrentRoundReferenceSection({
  roundType,
  operatingSubPhase,
}: {
  roundType?: RulesRoundType | null;
  operatingSubPhase?: RulesOperatingSubPhase | null;
}) {
  const connected = roundType !== undefined && roundType !== null;
  const subPhaseMeta =
    connected && roundType === "OperatingRound" && operatingSubPhase
      ? OPERATING_SUB_PHASE_QUICK_LABELS[operatingSubPhase]
      : null;

  // Active round first (if connected), then the remaining two in their
  // usual order -- never drops a round, just reprioritizes reading order.
  const orderedRounds = connected
    ? [roundType as RulesRoundType, ...ROUND_ORDER.filter((rt) => rt !== roundType)]
    : ROUND_ORDER;

  return (
    <section style={styles.currentRoundSection}>
      <div style={styles.quickRefHeader}>
        <h3 style={styles.sectionTitle}>Current Round&apos;s Rules Reference</h3>
        {!connected && (
          <span style={styles.quickRefBadgeMuted}>Not connected -- showing all three round types</span>
        )}
      </div>

      {orderedRounds.map((rt, roundIndex) => {
        const isActive = connected && rt === roundType;
        return (
          <div key={rt} style={styles.currentRoundBlock}>
            <div style={styles.quickRefHeader}>
              <h4 style={styles.quickRefCardTitle}>{ROUND_META[rt].label}</h4>
              {isActive && (
                <span style={styles.quickRefBadge}>
                  ACTIVE
                  {subPhaseMeta && ` -- UI step: ${subPhaseMeta.name} (${subPhaseMeta.index} of 4)`}
                </span>
              )}
            </div>
            <ol style={styles.flowList}>
              {ROUND_META[rt].flow.map((step) => (
                <li key={step.step} style={styles.flowItem}>
                  <div style={styles.flowItemHead}>
                    <span style={styles.flowStep}>{step.step}</span>
                    <span style={styles.flowQuick}>{step.quick}</span>
                  </div>
                  <span style={styles.flowDetail}>{step.detail}</span>
                </li>
              ))}
            </ol>
            {roundIndex < orderedRounds.length - 1 && <div style={styles.currentRoundDivider} />}
          </div>
        );
      })}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* About This Game -- see design note #9(3)                           */
/* ------------------------------------------------------------------ */

/** Prose paragraphs, sourced directly from this contract's own real
 *  end-game/net-worth logic -- see design note #9(3) for exactly which
 *  functions each sentence below is drawn from. */
function AboutSection() {
  return (
    <section style={styles.section}>
      <h3 style={styles.sectionTitle}>About This Game &amp; Your Goal</h3>
      <div style={styles.aboutProse}>
        <p style={styles.aboutParagraph}>
          1830: Railways &amp; Robber Barons puts you in the seat of a 19th-century financier,
          competing to build and profit from a rail network across the northeastern United States
          and Canada. You play two roles at once: a private investor buying and selling stock in
          public railroad corporations, and -- whenever you hold a corporation's President's
          certificate -- that corporation's own operating officer, deciding where it lays track,
          which trains it buys, and whether it pays out or reinvests what it earns.
        </p>
        <p style={styles.aboutParagraph}>
          Play alternates between Stock Rounds, where players trade certificates and set
          corporations' starting share prices, and Operating Rounds, where each floated corporation
          (60% or more of its stock sold) runs its trains over its own track to earn revenue, then
          either distributes that revenue to its shareholders as a dividend or keeps it in its own
          treasury to reinvest. A corporation's money and a player's personal money are always kept
          strictly separate -- laying track or buying a train spends the company's own treasury, not
          your personal wallet.
        </p>
        <p style={styles.aboutParagraph}>
          Every player who joins this room antes real JUNO into a shared pool. When the game ends,
          that pool is redistributed proportionally to each player's final net worth -- your own
          cash on hand, plus the live market value of every share you personally hold. A
          corporation's own treasury cash never counts toward any individual player's net worth,
          even for its President. There's no separate victory-points track: whoever has the highest
          net worth when the game ends simply walks away with the largest slice of the real pool.
        </p>
        <p style={styles.aboutParagraph}>
          The game can end four ways: the room's creator can end it manually at any time; the Bank
          can run dry of cash -- the classic 1830 rulebook's own primary end condition (see Bank
          Treasury on the Game Ledger tab); a share price can reach the top of the chart, $350 --
          this app's own added house rule, not part of the original rulebook's end conditions; or,
          rarely, a corporation's President can be unable to cover a mandatory train purchase even
          after emptying both the company's treasury and their own personal cash, which halts the
          game on the spot. However it ends, the same final net-worth calculation decides the
          payout.
        </p>
      </div>
    </section>
  );
}

export interface RulesReferenceProps {
  className?: string;
  /** Optional live round type from `GameStateResponse.current_round_type` --
   *  see design note #7. Omit to render the static "all three rounds"
   *  fallback in the new Current Round Quick Reference section. */
  roundType?: RulesRoundType | null;
  /** Optional live Operating Round UI sub-phase from `App.tsx`'s own
   *  `orSubPhase` state -- see design note #7. Only used (as a small
   *  supplementary badge) while `roundType === "OperatingRound"`. */
  operatingSubPhase?: RulesOperatingSubPhase | null;
}

// Certificate Limit + Starting Cash, merged into one table for the bottom
// row -- see design note #10(2). Both source arrays share the same set of
// `players` values in the same order; zipped by matching `players` rather
// than assumed-parallel indexing, so this stays correct even if either
// array's own row order or contents ever changes independently.
const CERT_AND_CASH_BY_PLAYERS: Array<{ players: number; limit: number; cash: number }> =
  CERT_LIMIT_BY_PLAYERS.map((certRow) => {
    const cashRow = STARTING_CASH_BY_PLAYERS.find((row) => row.players === certRow.players);
    return { players: certRow.players, limit: certRow.limit, cash: cashRow ? cashRow.cash : 0 };
  });

export function RulesReference({ className, roundType, operatingSubPhase }: RulesReferenceProps) {
  return (
    <div style={styles.root} className={className}>
      <h2 style={styles.pageTitle}>Rules Reference -- 1830 Limits &amp; Caps</h2>
      <p style={styles.sourceNote}>
        Sourced from the open-source tobymao/18xx engine's real 1830 config, cross-checked against
        this contract's own implementation where it applies -- see design note #1/#3 in this file.
      </p>

      {/* Design note #10(2): top row -- narrative on the left, current
          round's rules reference on the right. */}
      <div style={styles.topRow}>
        <div style={styles.topRowLeft}>
          <AboutSection />
        </div>
        <div style={styles.topRowRight}>
          <CurrentRoundReferenceSection roundType={roundType} operatingSubPhase={operatingSubPhase} />
        </div>
      </div>

      {/* Design note #10(2): bottom row -- the two Caps and Limits tables,
          side by side. */}
      <div style={styles.bottomRow}>
        <div style={styles.bottomRowColumn}>
          <section style={styles.section}>
            <h3 style={styles.sectionTitle}>Core Limits &amp; Caps</h3>
            <div style={styles.tableScroll}>
              <table style={styles.table}>
                <thead>
                  <tr>
                    <th style={styles.th}>Rule</th>
                    <th style={styles.th}>Value</th>
                  </tr>
                </thead>
                <tbody>
                  {CORE_LIMITS.map((row) => (
                    <tr key={row.label}>
                      <td style={styles.td}>
                        {row.label}
                        {row.note && <div style={styles.rowNote}>{row.note}</div>}
                      </td>
                      <td style={styles.td}>{row.value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>

        <div style={styles.bottomRowColumn}>
          <section style={styles.section}>
            <h3 style={styles.sectionTitle}>Certificate Limit &amp; Starting Cash by Player Count</h3>
            <div style={styles.tableScroll}>
              <table style={styles.table}>
                <thead>
                  <tr>
                    <th style={styles.th}>Players</th>
                    <th style={styles.th}>Certificate Limit</th>
                    <th style={styles.th}>Starting Cash</th>
                  </tr>
                </thead>
                <tbody>
                  {CERT_AND_CASH_BY_PLAYERS.map((row) => (
                    <tr key={row.players}>
                      <td style={styles.td}>{row.players}</td>
                      <td style={styles.td}>{row.limit}</td>
                      <td style={styles.td}>${row.cash}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

export default RulesReference;

/* ------------------------------------------------------------------ */
/* Inline styles                                                      */
/* ------------------------------------------------------------------ */

// Design note #6/item 1: every text style below is scaled up roughly 25-40%
// past its prior value for significantly better legibility, matching the
// ratio `App.tsx`/`Chatbox.tsx`'s own prior visual-theme upscaling passes
// used elsewhere in this dashboard.
const styles: Record<string, React.CSSProperties> = {
  root: {
    display: "flex",
    flexDirection: "column",
    gap: "20px",
    padding: "24px",
    color: "#e6e8ef",
    fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif",
    overflowY: "auto",
    flex: 1,
  },
  pageTitle: {
    fontSize: "26px",
    margin: 0,
  },
  sourceNote: {
    fontSize: "17px",
    color: "#8a90a0",
    margin: 0,
    maxWidth: "820px",
    lineHeight: 1.6,
  },
  // ---- Top row (narrative | current round) and bottom row (the two Caps
  // and Limits tables) -- design note #10(2). `flexWrap: "wrap"` on both
  // rows lets columns drop to stacked on a narrow viewport instead of
  // squeezing into unreadable slivers. ----
  topRow: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "flex-start",
    gap: "24px",
  },
  topRowLeft: {
    flex: "1 1 480px",
    display: "flex",
    flexDirection: "column",
    gap: "20px",
    minWidth: 0,
  },
  topRowRight: {
    flex: "1 1 480px",
    minWidth: 0,
  },
  bottomRow: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "flex-start",
    gap: "24px",
  },
  bottomRowColumn: {
    flex: "1 1 380px",
    minWidth: 0,
  },
  section: {
    display: "flex",
    flexDirection: "column",
    gap: "10px",
  },
  sectionTitle: {
    fontSize: "18px",
    textTransform: "uppercase",
    letterSpacing: "0.04em",
    color: "#9aa0ac",
    margin: 0,
  },
  // ---- About This Game -- design note #9(3). Prose paragraphs, no lists. ----
  aboutProse: {
    display: "flex",
    flexDirection: "column",
    gap: "14px",
    maxWidth: "800px",
  },
  aboutParagraph: {
    fontSize: "18px",
    color: "#c7cbd4",
    margin: 0,
    lineHeight: 1.75,
  },
  tableScroll: {
    overflowX: "auto",
    width: "100%",
  },
  table: {
    borderCollapse: "collapse",
    fontSize: "18px",
    width: "100%",
  },
  th: {
    textAlign: "left",
    padding: "9px 14px",
    color: "#8a90a0",
    borderBottom: "1px solid #2a2e3a",
    fontWeight: 600,
    whiteSpace: "nowrap",
  },
  td: {
    padding: "9px 14px",
    borderBottom: "1px solid #1e2129",
  },
  rowNote: {
    fontSize: "16px",
    color: "#8a90a0",
    marginTop: "4px",
    maxWidth: "540px",
    lineHeight: 1.6,
  },
  flowList: {
    display: "flex",
    flexDirection: "column",
    gap: "10px",
    margin: 0,
    padding: 0,
    listStyle: "none",
    counterReset: "flow-step",
  },
  // Column layout (not row) -- design note #10(3): each item now stacks
  // `flowItemHead` (step name + quick summary) above the full `flowDetail`
  // paragraph, rather than laying two inline siblings side by side.
  flowItem: {
    display: "flex",
    flexDirection: "column",
    gap: "6px",
    padding: "10px 14px",
    background: "#181b22",
    border: "1px solid #262a34",
    borderRadius: "6px",
  },
  flowItemHead: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "baseline",
    gap: "10px",
  },
  flowStep: {
    fontSize: "16px",
    fontWeight: 600,
    color: "#c9cedb",
    flexShrink: 0,
  },
  flowQuick: {
    fontSize: "16px",
    fontWeight: 700,
    color: "#8fe0a0",
  },
  flowDetail: {
    fontSize: "18px",
    color: "#a5abb8",
    lineHeight: 1.7,
  },
  // ---- Current Round's Rules Reference -- design note #10(1). No longer
  // `position: sticky` (it now lives in the top row's right column, not
  // pinned above the whole page). ----
  currentRoundSection: {
    display: "flex",
    flexDirection: "column",
    gap: "16px",
    padding: "16px 20px",
    backgroundColor: "#12141b",
    border: "1px solid #3a3f4b",
    borderRadius: "10px",
  },
  currentRoundBlock: {
    display: "flex",
    flexDirection: "column",
    gap: "10px",
  },
  currentRoundDivider: {
    height: "1px",
    background: "#262a34",
    margin: "4px 0 0",
  },
  quickRefHeader: {
    display: "flex",
    alignItems: "center",
    flexWrap: "wrap",
    gap: "12px",
  },
  quickRefBadge: {
    fontSize: "14px",
    fontWeight: 700,
    padding: "4px 12px",
    borderRadius: "999px",
    backgroundColor: "#2a3a2a",
    color: "#8fe0a0",
    border: "1px solid #3f5f42",
  },
  quickRefBadgeMuted: {
    fontSize: "13px",
    fontStyle: "italic",
    color: "#6f7480",
  },
  quickRefCardTitle: {
    fontSize: "15px",
    margin: 0,
    color: "#c9cedb",
  },
};
