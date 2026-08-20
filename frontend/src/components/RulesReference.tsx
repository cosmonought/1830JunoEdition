// frontend/src/components/RulesReference.tsx
//
// The Rules Reference tab -- a player-facing summary of real 1830 limits and caps, checkable mid-game.
//
// Design note #1: SOURCED, NOT REMEMBERED. Every figure was fetched from the open-source `tobymao/18xx`
// engine's real 1830 config -- the same repository this project used for the board layout and the stock
// market grid -- and independently checked against this contract wherever the contract has an opinion.
// The per-row confidence badge an earlier pass surfaced is gone: that is developer bookkeeping, not
// something a player checking a rule wants to see. The discipline is unchanged; it just no longer renders.
//
// Design note #2: reference-only. This tab has no `gameState` prop -- the same static rules regardless of
// room or round, matching how a rulebook insert works. (#7 later added two optional DISPLAY props only.)
//
// Design note #3: capitalization and the president's certificate are re-checked against `trading.rs`
// itself, not only against the reference engine.
// Design note #4: the president's 20% certificate counts as EXACTLY 1 against the limit -- verified
// against three independent sources, which agree without exception.
// Design note #5: the Game Flow summaries describe what this contract enforces, with two honesty notes --
// the OR's actions are not sequence-enforced, and route revenue runs as a separate batched transaction.
//
// Full sourcing history, the $350 removal and the annulment gap: `docs/ai_architecture/rules_and_sourcing.md`.

// Design note #9: LEGIBILITY AND LAYOUT FOLLOW-UP. Body/table/caption text pushed up again after #6's pass
// was still reported too small, with line-heights nudged alongside so the larger text is not cramped.
// The two Caps and Limits tables were brought together per direct feedback, and a narrative `AboutSection`
// added -- prose paragraphs, no bullet lists, per the request's own "prosaic/narrative" wording -- sourced
// from this contract's real logic: net worth is `contract::calculate_player_net_worth` (cash plus live
// share value, a company's treasury explicitly EXCLUDED) and the ante pool is redistributed by
// `contract::finalize_and_distribute_payouts`.
// THE $350 TRIGGER IS NO LONGER DOCUMENTED AS AN END CONDITION -- it was never canonical 1830, and the
// three real end paths are enumerated instead. AUDIT: the contract still fires it.
// SECOND AUDIT ITEM -- ANNULMENT. Two CLASSES of ending are documented: a natural end pays out by net
// worth, an annulment (host ends the match, or a 48-hour timeout) refunds every ante less fees. The
// anti-exploit reason is the point: while every ending paid by net worth, a host who was ahead could end
// the match and bank the lead. THE CONTRACT DOES NOT DO THIS YET -- `EndGameAndDistribute` runs the same
// payout path and there is no timeout state at all -- so this text describes INTENDED RULES, NOT SHIPPED
// BEHAVIOUR, flagged deliberately.

// Design note #10: PAGE RESTRUCTURE. Top row is narrative left / current round right; the bottom row holds
// the two lookup tables side by side, with certificate limit and starting cash merged into one three-column
// table -- zipped by matching `players` rather than assumed-parallel indexing, so it stays correct even if
// either array's row order changes independently.
// The old sticky quick-reference section is replaced by a non-sticky panel that always renders EVERY
// round's FULL step detail, which is what makes folding away the three standalone Game Flow sections lose
// no content. Styles left over from the deleted view are deleted rather than left dead in the file.

import React, { useEffect, useRef, useState } from "react";
import { FONT_SIZE } from "../styles/typography";
// Design note #640: which build the browser is actually running.
import { UI_BUILD_LABEL } from "../utils/buildStamp";

interface RuleRow {
  label: string;
  value: string;
  note?: string;
}

/** The printed 1830 train roster -- Audit G-15. Mirrors `hardware::TRAIN_CATALOG` / `RUST_TRIGGERS` /
 *  `TRAIN_LIMIT_BY_PHASE`. Documented here because every one of these numbers was previously discoverable
 *  only by reading Rust: cost, how many exist, what each can reach, and -- most consequential -- what kills
 *  it. A player deciding whether to buy the first 4-train is deciding whether to erase every 2-train on the
 *  board, including their own, and nothing in the app said so. */
interface TrainRow {
  model: string;
  quantity: string;
  cost: string;
  rusts: string;
  reach: string;
}

const TRAIN_ROSTER: TrainRow[] = [
  { model: "2", quantity: "6", cost: "$80", rusts: "When the first 4-train is bought", reach: "2 revenue centres" },
  { model: "3", quantity: "5", cost: "$180", rusts: "When the first 6-train is bought", reach: "3 revenue centres" },
  { model: "4", quantity: "4", cost: "$300", rusts: "When the first D-train is bought", reach: "4 revenue centres" },
  { model: "5", quantity: "3", cost: "$450", rusts: "Never — permanent", reach: "5 revenue centres" },
  { model: "6", quantity: "2", cost: "$630", rusts: "Never — permanent", reach: "6 revenue centres" },
  { model: "D", quantity: "Unlimited", cost: "$1,100", rusts: "Never — permanent", reach: "Any number of revenue centres" },
];

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
    label: "Buying a train from another corporation",
    value: "Any price at or above $1, by mutual agreement",
    note:
      "During its Buy Trains step a corporation may buy a train from another corporation instead of, or as well as, from the Bank. Any price of $1 or more is legal and there is no ceiling — moving a train for $1 to strand a rival, or for a company's entire treasury to shift money between two corporations the same player controls, are both ordinary plays here. If one player is president of both corporations the sale completes immediately. If the corporations have different presidents, the buyer makes an offer that the seller's president may accept or reject, and the buyer may rescind it at any time before it is answered. A train bought this way does NOT count as a new train entering play: it never advances the phase and never triggers a rusting sweep.",
  },
  {
    label: "Stock Round 1",
    value: "Selling is prohibited for the whole of SR1",
    note:
      "In the first Stock Round of the game nobody may sell any certificate, of any corporation, for any reason. The round is buy-or-pass only. This exists so the opening share auction cannot be immediately unwound: without it, a player could buy a presidency, bank the price movement and dump it in the same round, which is not a strategy this ruleset intends to offer. The restriction lifts completely at SR2 and never returns.",
  },
  {
    label: "Bank Pool cap (per corporation)",
    value: "50% — shares may not be sold into a pool already at 50%",
    note:
      "The Bank Pool holds shares players have sold back. It caps at 50% of any one corporation's shares, and the cap is checked against the pool's CURRENT level, not against the size of your sale — so the room for a sale is 50% minus whatever is already in the pool, and it grows again as other players buy out of it. A 40% bundle into a pool already holding 20% is rejected; the same bundle is legal once the pool drops to 10%. This is why a sell size can be greyed out one turn and available the next.",
  },
  {
    label: "Capitalization mode — Full Capitalization",
    value: "10x Par credited to treasury immediately upon floating at 60%",
    note: "The moment a corporation crosses the 60% float threshold, its treasury is credited its full par price x 10 shares in one lump sum — not gradually, and not scaled down to however many shares had actually sold at that moment. This is confirmed directly against this contract's own `trading.rs` (`FLOAT_CAPITALIZATION_MULTIPLIER = 10`, applied as soon as `FLOAT_THRESHOLD_PERCENTAGE = 60` is crossed), not just the reference ruleset.",
  },
  {
    label: "Corporation float threshold",
    value: "60% of shares sold",
  },
  {
    label: "Per-player ownership cap (per corporation)",
    value: "60%",
    note: "Waived for a share sitting in the Orange or Brown stock-market zones — see the Stock Market tab's own zone legend.",
  },
  {
    label: "Shares per public company",
    value: "9 physical certificates (100% total)",
    note: "One 20% president's certificate plus eight 10% certificates — ten 10%-units of ownership in total, held as nine physical cards.",
  },
  {
    label: "President's certificate",
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

/** Stock Round loop -- design note #5. Repeats player-by-player until the room's creator explicitly begins
 *  the next Operating Round; this contract has no automatic pass-streak transition
 *  (`GameSession::consecutive_passes` is tracked but not yet consumed). */
const STOCK_ROUND_FLOW: FlowStep[] = [
  {
    step: "Buy 1 share",
    detail:
      "The active player may buy exactly one 10% certificate this turn, from either a company's IPO pool (paying its par price — or setting that par price, on the company's very first-ever IPO sale) or the open Bank pool (paying its live market price). Crossing 60% player-owned floats the company and credits its treasury 10x par immediately.",
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
    // Design note #29: FIRST, not last. This is the chronological order a corporation's turn actually runs in
    // -- a private is bought before track is laid, because the private's own power (a free tile lay, a reserved
    // hex) can change what track lay is legal in the very same turn. Listing it sixth described a sequence the
    // game does not follow, in both the sidebar and the detail panel, since both render from this one array.
    // The Phase 3 caveat LEADS the text: a step invisible for the first third of the game needs to say so
    // before it says anything else, or a Phase 1 player spends their turn looking for a control that is not
    // there.
    step: "Buy Private Company",
    detail:
      "Unlocks in Phase 3. The President may spend the CORPORATION'S TREASURY — never personal cash — to buy a still-owned private company directly from the player holding it, at a price the two negotiate but bounded to 50%-200% of that private's face value. The private's revenue then flows to the corporation instead of the player.",
    quick: "Phase 3+ only: buy a private from a player, 50%-200% of face value, from Treasury.",
  },
  {
    step: "Lay Track",
    detail:
      "The active corporation's President may lay or upgrade one tile on the map, extending its rail network. Three rules bind every lay. COLOUR PROGRESSION: upgrades go Yellow -> Green -> Brown in strict order, with no skipping, and the higher colours only become available as the game phase advances. CONNECTIVITY: the hex must be reachable by track traced back to one of this corporation's own station tokens — you cannot lay in unconnected territory. TRACK PRESERVATION: an upgrade must keep every path the old tile already carried, so a lay can never sever an existing route, including a rival's. Terrain is charged on top of the tile and comes out of the CORPORATION'S TREASURY, not personal cash: $80 across a river hex, $120 across a mountain hex, nothing on clear ground.",
    quick: "Lay or upgrade one connected tile, preserving existing track. Terrain fees from Treasury.",
  },
  {
    // CORRECTION (design note #141): this step was MISSING from the list entirely, and the "Lay Track" text
    // actively denied it existed -- claiming the first tile lay doubles as placing the home token. Both halves
    // were wrong: the HOME token is granted automatically at FLOAT by `hexmap::grant_home_station_token`, and
    // there IS a separate `ExecuteMsg::PlaceStationToken` with its own cost ladder, token limit, reachability
    // check and one-per-sub-round rule.
    // So a player reading this reference was told not to look for a control the Operating Round bar has had all
    // along, in its own sub-phase.
    step: "Place a Station",
    detail:
      "After laying track, the President may place one additional Station token in a city its network already reaches. The city must have a free slot — a city whose every slot is taken by other corporations is closed to you, and also blocks your trains from running THROUGH it (they may still stop there). Token allowance, home token included: PRR, NYC and CPR get 4; B&O, C&O and ERIE get 3; NNH and B&M get 2. The first is the free home token granted automatically at float. The next one placed costs $40 from the company treasury, and every one after that costs $100. At most one station placement per corporation per Operating Round turn (e.g., one in OR 2.1, and another in OR 2.2).",
    quick: "Optionally place one Station token in a reachable city with a free slot ($40, then $100).",
  },
  {
    step: "Routes",
    detail:
      "Each train runs a route and earns the revenue of the centres it visits, up to its own capacity — a 2-train reaches 2 revenue centres, a 6-train reaches 6, a Diesel is unlimited. Large cities and small towns both count as one centre each against that capacity. Two rules bind a run: a train may not re-enter the same hex twice on a single route, and if the corporation owns several trains their routes must be COMPLETELY DISTINCT. No two trains owned by the same corporation may share a track segment, though multiple trains may visit or terminate in the same city if they use separate tracks to enter and leave. Autopath computes the highest legal total for you.",
    quick: "Each train runs up to its capacity; multiple trains cannot share track. Autopath available.",
  },
  {
    step: "Dividends",
    detail:
      "The President chooses one of two, and the choice moves the share price. PAY OUT: the revenue is split evenly across all ten 10% share units and paid to whoever holds them (the Bank Pool's own share is credited to the bank), and the corporation's market price advances ONE CELL RIGHT. WITHHOLD: the corporation keeps 100% of the revenue in its treasury and the market price drops ONE CELL LEFT. Withholding builds the capital a corporation needs for trains; paying out is what raises the shareholders' net worth, which is how the game is won.",
    quick: "Pay out (price moves right) or withhold into Treasury (price moves left).",
  },
  {
    step: "Buy Trains",
    detail:
      "The President may buy the next train at the front of the Bank Depot at its face value, or a train from another corporation at any negotiated price of $1 or more. BOTH ARE PAID FROM THE CORPORATION'S TREASURY. The purchase is subject to the current Train Limit (see Limits, Caps, and Special Rules) and triggers a Rusting sweep if it is the room's first unit of a new tier. EMERGENCY TRAIN PURCHASE: a corporation that owns NO train must buy one, and if its treasury cannot cover the cheapest available train the President becomes personally liable — they must contribute their own cash and, if that is still not enough, sell their own shares to raise the difference. Watch the rusting schedule and keep a viable fleet; this is the rule that ends games badly.",
    quick: "Buy from the Depot at face value or a rival for $1+, from Treasury. Trainless = emergency.",
  },
];

/** Pre-Game Waterfall Auction -- design note #7. The five real `ExecuteMsg` actions `waterfall.rs`
 *  implements, sourced from `WaterfallAuctionDashboard.tsx`'s own notes. Runs once, before Stock Round 1
 *  ever opens. */
const AUCTION_FLOW: FlowStep[] = [
  {
    step: "Buy Lowest",
    detail:
      "Any player, on their turn in the auction's seating rotation, may buy the current lowest-priced still-unowned private company outright at its face value — the only private WaterfallBuyLowest can target, and the only one that can never be bid on instead.",
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
      "A player may always decline to buy or bid this turn, including on the very first turn of the auction. If every player passes in succession, the lowest-offered private is marked down by $5; a private marked all the way to $0 is taken for free by the next player to act.",
    quick: "Decline — always legal. A full round of passes cuts $5 off the cheapest private.",
  },
  {
    step: "Mini-Auction Raise",
    detail:
      "Once every other player has passed on the lowest-offered private while at least one bid stands elsewhere, a mini-auction runs among that private's competing bidders: on their turn, a competing bidder may raise their bid.",
    quick: "Competing bidder: raise your bid.",
  },
  {
    step: "Mini-Auction Pass",
    detail:
      "A competing bidder may instead drop out of the mini-auction — their escrowed bid is fully refunded, and the auction continues among the remaining bidder(s).",
    quick: "Competing bidder: drop out (bid fully refunded).",
  },
];

/* ------------------------------------------------------------------ */
/* Current Round Quick Reference -- see design note #7                */
/* ------------------------------------------------------------------ */

type RulesRoundType = "WaterfallAuction" | "StockRound" | "OperatingRound";
type RulesOperatingSubPhase =
  | "BuyPrivate"
  | "Track"
  | "Tokens"
  | "Routes"
  | "Dividends"
  | "Hardware";

const ROUND_ORDER: RulesRoundType[] = ["WaterfallAuction", "StockRound", "OperatingRound"];

const ROUND_META: Readonly<Record<RulesRoundType, { label: string; flow: FlowStep[] }>> = {
  WaterfallAuction: { label: "Auction (Pre-Game)", flow: AUCTION_FLOW },
  StockRound: { label: "Stock Round", flow: STOCK_ROUND_FLOW },
  OperatingRound: { label: "Operating Round", flow: OPERATING_ROUND_FLOW },
};

/** Mirrors `App.tsx`'s `OPERATING_SUB_PHASE_LABELS` exactly (name + 1-based index) -- a hand-kept duplicate
 *  rather than an import, per design note #7's "no gameState/App.tsx coupling beyond two optional display
 *  props" discipline. Used only for the supplementary UI-step badge; the checklist comes from the flow array. */
const OPERATING_SUB_PHASE_QUICK_LABELS: Readonly<Record<RulesOperatingSubPhase, { index: number; name: string }>> = {
  // Design note #144: mirrors `or_phase::OR_PHASE_ORDER`, which the contract
  // now ENFORCES rather than merely describes.
  BuyPrivate: { index: 1, name: "Buy Private" },
  Track: { index: 2, name: "Track" },
  Tokens: { index: 3, name: "Tokens" },
  Routes: { index: 4, name: "Routes" },
  Dividends: { index: 5, name: "Dividends" },
  Hardware: { index: 6, name: "Hardware" },
};

/** Kept in step with `App.tsx`'s `OPERATING_SUB_PHASE_TOTAL`. */
const OPERATING_SUB_PHASE_TOTAL = Object.keys(OPERATING_SUB_PHASE_QUICK_LABELS).length;

/* ------------------------------------------------------------------ */
/* Quick Reference strip -- RESTORED, design note #141                  */
/* ------------------------------------------------------------------ */

/** Design note #17: the compact round checklist that leads this page. RESTORED, not newly invented -- #7
 *  built it, #10(2) deleted it in favour of the full-detail panel, and that trade lost something real: the
 *  full version is a document you read, and what a player wants mid-turn is a list they can glance at.
 *  Both exist now as deliberately different tools: this answers "what am I doing, and what comes next"; the
 *  panel below answers "what exactly does that step mean".
 *  It reads the SAME `FlowStep.quick` one-liners the flow arrays already carry -- the field #7 added for
 *  precisely this, unused since #10(2) removed its only consumer -- so a step added to a flow array appears
 *  in both places automatically and the two cannot drift.
 *  DISCONNECTED it lists all three rounds rather than hiding: in offline sandbox mode there is no live round,
 *  and a panel that renders nothing is indistinguishable from a panel that is broken. */
function QuickReferenceStrip({
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
  const shown = connected ? [roundType as RulesRoundType] : ROUND_ORDER;

  return (
    <section style={styles.quickStrip}>
      <div style={styles.quickRefHeader}>
        <h3 style={styles.quickStripTitle}>
          Quick Reference{connected ? ` — ${ROUND_META[roundType as RulesRoundType].label}` : ""}
        </h3>
        {connected && subPhaseMeta ? (
          <span style={styles.quickRefBadge}>
            UI step {subPhaseMeta.index} of {OPERATING_SUB_PHASE_TOTAL}: {subPhaseMeta.name}
          </span>
        ) : (
          !connected && (
            <span style={styles.quickRefBadgeMuted}>
              Not connected — all three rounds shown
            </span>
          )
        )}
      </div>

      <div style={styles.quickStripColumns}>
        {shown.map((rt) => (
          <div key={rt} style={styles.quickStripColumn}>
            {!connected && <h4 style={styles.quickStripColumnTitle}>{ROUND_META[rt].label}</h4>}
            <ol style={styles.quickStripList}>
              {ROUND_META[rt].flow.map((step, index) => (
                <li key={step.step} style={styles.quickStripItem}>
                  <span style={styles.quickStripNum}>{index + 1}</span>
                  <span style={styles.quickStripStep}>{step.step}</span>
                  <span style={styles.quickStripQuick}>{step.quick}</span>
                </li>
              ))}
            </ol>
          </div>
        ))}
      </div>
    </section>
  );
}

/** Right-column card -- design note #10. Unlike the superseded quick-reference section this replaces, it
 *  always renders EVERY round's FULL step detail -- the same prose the deleted standalone Game Flow sections
 *  carried -- so consolidating them into this column loses no content. When connected, the live round is
 *  reordered to the front; each step leads with its `quick` one-liner above the full paragraph, so the list
 *  stays scannable while still offering the complete explanation. */
function CurrentRoundReferenceSection({
  roundType,
  operatingSubPhase,
}: {
  roundType?: RulesRoundType | null;
  operatingSubPhase?: RulesOperatingSubPhase | null;
}) {
  const connected = roundType !== undefined && roundType !== null;

  // `operatingSubPhase` is deliberately NOT read here any more. It drove the ACTIVE badge, which was removed
  // because the sidebar already marks the live round and the detail panel repeating it was noise. The prop
  // stays on the signature because the sidebar half of this component still needs it.
  void operatingSubPhase;

  // Active round first, then the rest in their usual order -- never drops a
  // round, just reprioritises reading order.
  const orderedRounds = connected
    ? [roundType as RulesRoundType, ...ROUND_ORDER.filter((rt) => rt !== roundType)]
    : ROUND_ORDER;

  // Design note #143: which rounds are expanded. Two requirements pull against each other -- the ACTIVE round
  // opens automatically whenever the round CHANGES, and a manual open/close STICKS -- which is why this is
  // state plus an effect rather than a derived value: deriving "open = isActive" would make manual expansion
  // impossible, and pure state would never react to the round changing.
  // The effect fires ONLY on a genuine round transition, tracked against a ref -- not on every render, and not
  // on the poll-interval re-render that reports the same round again, which would silently reopen a section
  // the player had just closed.
  const [openRounds, setOpenRounds] = useState<ReadonlySet<RulesRoundType>>(() =>
    connected ? new Set([roundType as RulesRoundType]) : new Set(ROUND_ORDER),
  );
  const previousRoundRef = useRef<RulesRoundType | null | undefined>(roundType);

  useEffect(() => {
    if (roundType === previousRoundRef.current) return;
    previousRoundRef.current = roundType;
    if (roundType === undefined || roundType === null) {
      // Disconnected: no round is "current", so opening all three is the only
      // honest default -- a fully collapsed panel offline is indistinguishable
      // from a broken one.
      setOpenRounds(new Set(ROUND_ORDER));
      return;
    }
    // Open the new active round, deliberately ADDITIVE -- anything opened by hand stays open.
    // `forEach` into a fresh Set, not a spread: tsconfig targets ES5 without `downlevelIteration`, so spreading
    // a Set is a compile error here.
    setOpenRounds((prev) => {
      const next = new Set<RulesRoundType>();
      prev.forEach((rt) => next.add(rt));
      next.add(roundType);
      return next;
    });
  }, [roundType]);

  const toggleRound = (rt: RulesRoundType) => {
    setOpenRounds((prev) => {
      const next = new Set(prev);
      if (next.has(rt)) next.delete(rt);
      else next.add(rt);
      return next;
    });
  };

  return (
    <section style={styles.currentRoundSection}>
      <div style={styles.quickRefHeader}>
        <h3 style={styles.sectionTitle}>Current Round&apos;s Rules Reference</h3>
        {!connected && (
          <span style={styles.quickRefBadgeMuted}>Not connected — showing all three round types</span>
        )}
      </div>

      {orderedRounds.map((rt) => {
        const isActive = connected && rt === roundType;
        const isOpen = openRounds.has(rt);
        return (
          <div key={rt} style={styles.currentRoundBlock}>
            <button
              type="button"
              onClick={() => toggleRound(rt)}
              aria-expanded={isOpen}
              style={{
                ...styles.roundAccordionHeader,
                ...(isActive ? styles.roundAccordionHeaderActive : {}),
              }}
            >
              <span style={styles.roundAccordionChevron}>{isOpen ? "\u25be" : "\u25b8"}</span>
              <h4 style={styles.quickRefCardTitle}>{ROUND_META[rt].label}</h4>
              {/* Design note #30: the ACTIVE badge is gone. The active round is already reordered to the front AND
                 auto-opened AND given a highlighted header -- the badge was a fourth signal for a fact three other things
                 were saying. Its sub-phase detail moves inside the panel, next to the steps it describes. */}
              {!isOpen && (
                <span style={styles.roundAccordionHint}>{ROUND_META[rt].flow.length} steps</span>
              )}
            </button>

            {isOpen && (
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
            )}
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
      {/* Design note #640: the one place to look when a reported bug cannot be
          reproduced. Quiet, because it is for the rare conversation rather
          than for play -- but findable without asking anyone. */}
      <p style={styles.buildStamp} title="Quote this in a bug report — it says which build of the interface you are running.">
        {UI_BUILD_LABEL}
      </p>
      <div style={styles.aboutProse}>
        <p style={styles.aboutParagraph}>
          Project 18XX puts you in the seat of a 19th-century financier, competing to build and
          profit from a rail network across the northeastern United States and Canada. You play two roles at once: a private investor buying and selling stock in
          public railroad corporations, and — whenever you hold a corporation's President's
          certificate — that corporation's own operating officer, deciding where it lays track,
          which trains it buys, and whether it pays out or reinvests what it earns.
        </p>
        <p style={styles.aboutParagraph}>
          Play alternates between Stock Rounds, where players trade certificates and set
          corporations' starting share prices, and Operating Rounds, where each floated corporation
          (60% or more of its stock sold) runs its trains over its own track to earn revenue, then
          either distributes that revenue to its shareholders as a dividend or keeps it in its own
          treasury to reinvest. A corporation's money and a player's personal money are always kept
          strictly separate — laying track or buying a train spends the company's own treasury, not
          your personal wallet.
        </p>
        <p style={styles.aboutParagraph}>
          Every player who joins this room antes real JUNO into a shared pool. When a game reaches a
          natural end, that pool is redistributed proportionally to each player's final net worth --
          your own cash on hand, plus the live market value of every share you personally hold. A
          corporation's own treasury cash never counts toward any individual player's net worth,
          even for its President. There's no separate victory-points track: whoever has the highest
          net worth at the finish simply walks away with the largest slice of the real pool.
        </p>
        <p style={styles.aboutParagraph}>
          A game reaches a natural end one of two ways: the Bank runs dry of cash — the classic
          genre's own primary end condition (see Bank Treasury on the Game Ledger tab) — or
          a corporation's President cannot cover a mandatory train purchase even after emptying both
          the company's treasury and their own personal cash, which bankrupts them and halts the
          game on the spot. In either case the final net-worth calculation above decides the payout,
          and the pool is distributed.
        </p>
        <p style={styles.aboutParagraph}>
          A game can also be cut short: the host may end the match, or the room may hit its
          48-hour inactivity timeout. Neither is a result. In both cases the game is{" "}
          <strong style={styles.aboutEmphasis}>annulled</strong> -- no winner is declared, no
          net-worth payout is calculated, and every player is refunded their own initial ante, less
          standard gas and development fees. Ending a match early is a way to close an abandoned
          room, not a way to bank a lead.
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

// Certificate limit + starting cash, merged for the bottom row -- design note #10(2). Zipped by matching
// `players` rather than assumed-parallel indexing, so this stays correct even if either array's own row
// order or contents ever changes independently.
const CERT_AND_CASH_BY_PLAYERS: Array<{ players: number; limit: number; cash: number }> =
  CERT_LIMIT_BY_PLAYERS.map((certRow) => {
    const cashRow = STARTING_CASH_BY_PLAYERS.find((row) => row.players === certRow.players);
    return { players: certRow.players, limit: certRow.limit, cash: cashRow ? cashRow.cash : 0 };
  });

export function RulesReference({ className, roundType, operatingSubPhase }: RulesReferenceProps) {
  return (
    <div style={styles.root} className={className}>
      <h2 style={styles.pageTitle}>Rules Reference</h2>
      {/* REGRESSION FIX (design note #140): the current-round panel is back at the TOP, full width, above the
         narrative. Nothing deleted it, which is why it was hard to spot: #10(2) moved it into a `flex: 1 1 480px`
         column sharing a WRAPPING row with five paragraphs of prose. Above ~1000px the two sit side by side;
         below that the row wraps, the narrative renders first, and the panel lands underneath a full screen of
         text -- present in the DOM, absent from view, and reported as "vanished".
         It leads the page again because of what it IS: the only part of this screen that changes with the room's
         live state. Static tables can be scrolled to; "whose turn is it and what comes next" cannot. */}
      {/* Design note #141/#143: the compact strip leads full width -- it is
          the one thing read mid-turn. Below it, narrative on the left and the
          collapsible full round reference on the right, as before. */}
      <QuickReferenceStrip roundType={roundType} operatingSubPhase={operatingSubPhase} />

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
            <h3 style={styles.sectionTitle}>Limits, Caps, and Special Rules</h3>
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
                      {/* Design note #37: PLAIN TEXT, NO HOVER STATE AT ALL. Label left, value right, nothing hidden. This went
                         through three rounds -- prose in the cell, a tooltip with a marker glyph, a tooltip with no marker -- and
                         the last was the worst: information that exists but is undiscoverable is not a feature, it is a trap for
                         whoever maintains this next. If a note matters enough to keep it belongs in the narrative section as
                         visible prose; if it does not, it should be deleted. */}
                      <td style={styles.td}>{row.label}</td>
                      <td style={styles.tdNum}>{row.value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>

        <div style={styles.bottomRowColumn}>
          {/* Audit G-15: the train roster. Placed beside the other lookup
              tables because that is what it is -- the numbers a player checks
              mid-decision, especially the rust column. */}
          <section style={styles.section}>
            <h3 style={styles.sectionTitle}>Trains</h3>
            <div style={styles.tableScroll}>
              <table style={styles.table}>
                <thead>
                  <tr>
                    <th style={styles.th}>Train</th>
                    <th style={styles.th}>Qty</th>
                    <th style={styles.th}>Cost</th>
                    <th style={styles.th}>Reaches</th>
                    <th style={styles.th}>Rusts</th>
                  </tr>
                </thead>
                <tbody>
                  {TRAIN_ROSTER.map((row) => (
                    <tr key={row.model}>
                      <td style={styles.td}>{row.model}</td>
                      <td style={styles.td}>{row.quantity}</td>
                      <td style={styles.td}>{row.cost}</td>
                      <td style={styles.td}>{row.reach}</td>
                      <td style={styles.td}>{row.rusts}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section style={{ ...styles.section, ...styles.sectionSpaced }}>
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
    fontSize: FONT_SIZE.display,
    margin: 0,
  },
  sourceNote: {
    fontSize: FONT_SIZE.heading,
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
  /** Design note #31: the two lookup tables at the bottom ran together --
   *  the Trains rows and the Certificate Limit rows read as one continuous
   *  table with a stray heading in the middle. A generous gap is the whole
   *  fix; they are separate references consulted for different reasons. */
  sectionSpaced: { marginTop: "34px" },
  section: {
    display: "flex",
    flexDirection: "column",
    gap: "10px",
  },
  sectionTitle: {
    fontSize: FONT_SIZE.heading,
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
    fontSize: FONT_SIZE.heading,
    color: "#c7cbd4",
    margin: 0,
    lineHeight: 1.75,
  },
  aboutEmphasis: { color: "#e0b64a", fontWeight: 700 },
  /* Design note #640: deliberately the quietest text on the page. It is
     diagnostic metadata, not something a player reads while learning the
     game. */
  buildStamp: {
    margin: "0 0 10px",
    fontSize: FONT_SIZE.micro,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    color: "#6f7480",
    cursor: "help",
  },
  tableScroll: {
    overflowX: "auto",
    width: "100%",
  },
  table: {
    borderCollapse: "collapse",
    fontSize: FONT_SIZE.heading,
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
  /** Design note #31: marks a row whose `title` carries more detail. */
  /** Design note #31: numbers right-aligned. */
  tdNum: { textAlign: "right", fontVariantNumeric: "tabular-nums" },
  rowNote: {
    fontSize: FONT_SIZE.strong,
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
    fontSize: FONT_SIZE.strong,
    fontWeight: 600,
    color: "#c9cedb",
    flexShrink: 0,
  },
  flowQuick: {
    fontSize: FONT_SIZE.strong,
    fontWeight: 700,
    color: "#8fe0a0",
  },
  flowDetail: {
    fontSize: FONT_SIZE.heading,
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
  // Design note #141: the compact strip. Denser than everything else on the
  // page on purpose -- it is scanned, not read.
  quickStrip: {
    display: "flex",
    flexDirection: "column",
    gap: "10px",
    padding: "14px 18px",
    backgroundColor: "#12141b",
    border: "1px solid #3a3f4b",
    borderRadius: "10px",
  },
  quickStripTitle: {
    margin: 0,
    fontSize: FONT_SIZE.heading,
    fontWeight: 700,
    color: "#e6e8ef",
  },
  quickStripColumns: {
    display: "flex",
    flexWrap: "wrap",
    gap: "18px",
  },
  quickStripColumn: {
    flex: "1 1 300px",
    minWidth: 0,
  },
  quickStripColumnTitle: {
    margin: "0 0 6px 0",
    fontSize: FONT_SIZE.body,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.05em",
    color: "#9aa0ac",
  },
  quickStripList: {
    listStyle: "none",
    margin: 0,
    padding: 0,
    display: "flex",
    flexDirection: "column",
    gap: "5px",
  },
  quickStripItem: {
    display: "flex",
    alignItems: "baseline",
    gap: "8px",
    fontSize: FONT_SIZE.strong,
    lineHeight: 1.45,
  },
  quickStripNum: {
    flex: "0 0 auto",
    minWidth: "18px",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: FONT_SIZE.body,
    color: "#6f7684",
  },
  quickStripStep: {
    flex: "0 0 auto",
    fontWeight: 700,
    color: "#e6e8ef",
  },
  quickStripQuick: {
    color: "#b8bdc8",
  },
  // Design note #143: accordion header. A real <button> so it is keyboard
  // reachable and announces its expanded state; styled flat so it reads as a
  // section heading rather than an action.
  roundAccordionHeader: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    width: "100%",
    padding: "6px 0",
    background: "none",
    border: "none",
    borderBottom: "1px solid #2b2f3a",
    cursor: "pointer",
    textAlign: "left",
  },
  roundAccordionHeaderActive: {
    borderBottomColor: "#4a6f92",
  },
  roundAccordionChevron: {
    flex: "0 0 auto",
    fontSize: FONT_SIZE.small,
    color: "#8a919e",
  },
  roundAccordionHint: {
    marginLeft: "auto",
    fontSize: FONT_SIZE.small,
    color: "#6f7684",
  },
  quickRefHeader: {
    display: "flex",
    alignItems: "center",
    flexWrap: "wrap",
    gap: "12px",
  },
  quickRefBadge: {
    fontSize: FONT_SIZE.control,
    fontWeight: 700,
    padding: "4px 12px",
    borderRadius: "999px",
    backgroundColor: "#2a3a2a",
    color: "#8fe0a0",
    border: "1px solid #3f5f42",
  },
  quickRefBadgeMuted: {
    fontSize: FONT_SIZE.body,
    fontStyle: "italic",
    color: "#6f7480",
  },
  quickRefCardTitle: {
    fontSize: FONT_SIZE.strong,
    margin: 0,
    color: "#c9cedb",
  },
};
