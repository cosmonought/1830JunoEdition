# Rules, Sourcing, and the Corrections They Forced

Where this project's 1830 numbers come from, how they were checked, and the rule corrections that
checking produced. Primarily `components/RulesReference.tsx`. Anchors are `<source file> #<N>`.

> **Standing sourcing discipline.** Every figure in the Rules Reference tab was fetched from the
> open-source `tobymao/18xx` engine's real 1830 config — `lib/engine/game/g_1830/game.rb`,
> `lib/engine/game/g_1830/entities.rb`, and the engine-wide defaults in `lib/engine/game/base.rb` /
> `lib/engine/corporation.rb` that 1830 inherits from. **The same repository this project already used
> to source the board layout (`HexGridRenderer.tsx #6`/`#10`/`#12`) and the stock market grid
> (`StockMarketRenderer.tsx #1`/`#3`).** Where this contract has an opinion, the figure is checked
> against the contract too, not only against the reference engine.

---

# `components/RulesReference.tsx`

### RulesReference.tsx #1 — Sourced, not remembered — but presented clean, not annotated
An earlier pass surfaced a per-row **confidence badge** (verbatim / engine default / not
verbatim-confirmed) directly in the player-facing UI. **Useful for this project's own development
process, and exactly the kind of developer bookkeeping a player checking a rule mid-game does not want to
see.** The badge UI is gone; **the sourcing discipline itself is unchanged — it just no longer surfaces
as an on-screen tag.**

### RulesReference.tsx #2 — Reference-only content: this tab reads no live game state
Unlike every other panel added in the same pass, this tab has **no `gameState` prop at all**: it is the
same static rules regardless of which room or round is active, **matching how a real rulebook insert
would work.** (`#7` later added two *optional display* props and nothing more — see below.)

### RulesReference.tsx #3 — Two rules confirmed against this contract, not just the source engine
- **Capitalization**: `trading.rs`'s `FLOAT_CAPITALIZATION_MULTIPLIER = 10`, applied the instant
  `FLOAT_THRESHOLD_PERCENTAGE = 60` is crossed.
- **The president's certificate**: `STANDARD_SHARE_COUNT = 10` ten-percent units, **sold as 9 physical
  certificates — one 20% president's certificate plus eight 10% certificates.**

Both are real constants in `src/trading.rs`, **re-checked directly against that file rather than only
against the reference engine.**

### RulesReference.tsx #4 — The president's certificate counts as exactly 1
An earlier pass of this row stated the president's 20% certificate counts as **2** certificates against
the limit — **a common misconception, and wrong.** Re-verified against three independent sources,
described rather than quoted (`#548`):

1. **The published rulebook's own certificate-limit section**, which states that the president's holding
   is two *shares* but one *certificate*.
2. **The long-standing 18xx.net rules summary**, which makes the same distinction between certificates
   and the percentage each represents.
3. **The `tobymao/18xx` engine's `num_certs` implementation** (`lib/engine/game/base.rb`), which sums each
   share's `cert_size` — **a field that defaults to `1` and is never overridden to `2` for a president's
   `Share` object** (`lib/engine/share.rb`, `lib/engine/corporation.rb`).

**All three agree without exception.** A follow-up pass tightened the row to the single sentence the rule
actually is and **removed the earlier "physical card"/"hand slot" framing entirely** — that framing was
not wrong, **but it invited a reader to think of "hand slot count" and "certificate count" as two separate
numbers that just happen to agree, when they are the same count by definition.**
*(Implemented in `utils_layer.md`, `gameState.ts #3`.)*

### RulesReference.tsx #5 — Game Flow summaries, and two honesty notes
The Stock Round and Operating Round sections describe **what `contract.rs`/`trading.rs`/`operations.rs`/
`hardware.rs` actually enforce, re-read directly rather than assumed from familiarity with physical
1830.** Two divergences are surfaced rather than glossed:

- **The Operating Round's actions are NOT sequence-enforced by this contract.** A president may call Lay
  Track / Buy Equipment / Declare Dividends in any order, or skip any of them, before ending the turn —
  `operations.rs` module doc #10 explicitly notes `EndOperatingRoundTurn` requires no prior action.
- **Route revenue is computed by `ExecuteOperatingRound`**, a separate batched, creator/validator-only
  transaction that runs every listed company's pathfinding pass **in one shot** (`operations.rs` module
  doc #1) — **it is not yet wired into each corporation's individual turn** the way the other three are.

**The summary presents the classic conceptual sequence for player-facing clarity while these two notes
keep the sourcing discipline intact.**

### RulesReference.tsx #29 — Buy Private Company is FIRST, not last
This is the chronological order a corporation's turn actually runs in: **a private is bought before track
is laid, because the private's own special power — a free tile lay, a reserved hex — can change what track
lay is legal in the very same turn.** Listing it sixth described a sequence the game does not follow, **in
both the quick sidebar and the detailed panel, since both render from this one array.**
**The Phase 3 caveat leads the text rather than trailing it:** a step that is invisible for the first
third of the game needs to say so before it says anything else, **or a Phase 1 player spends their turn
looking for a control that is not there.**

### RulesReference.tsx #8 — The step that was missing entirely
`OPERATING_ROUND_FLOW` was missing a real, already-implemented action: **a corporation's President may buy
a still-owned private company directly from the player holding it, using the corporation's treasury.**
Sourced from this contract's own implementation rather than re-derived: available from **Phase 3**
(mirroring `trading::execute_buy_private_company`'s `PrivatePurchaseLockedBeforePhase3` gate), dispatched
during the corporation's own turn, **at a price bounded on-chain to 50%–200% of face value** — re-enforced
server-side regardless of what the client submits.

### RulesReference.tsx #141 — Station tokens: the reference denied a control that exists
This step was **missing from the flow entirely, and the "Lay Track" text actively denied it existed** —
claiming the first tile lay "doubles as placing its home Station token — there is no separate
token-placement action". **Both halves were wrong:**

- **The HOME token is granted automatically at FLOAT**, by `hexmap::grant_home_station_token` (called from
  `auction.rs` the moment a corporation crosses 60%), **not by laying a tile.**
- **There IS a separate action**: `ExecuteMsg::PlaceStationToken` → `hexmap::execute_place_station_token`,
  with its own cost ladder, token limit, reachability check and one-per-sub-round rule.

**So a player reading this reference was told not to look for a control the Operating Round bar has had
all along, in its own sub-phase.**

### RulesReference.tsx (train roster, G-15) — What kills a train, written down
Mirrors `hardware::TRAIN_CATALOG` / `RUST_TRIGGERS` / `TRAIN_LIMIT_BY_PHASE`. **Documented here because
every one of these numbers was previously discoverable only by reading Rust:** cost, how many exist, what
each can reach, and — **most consequential of all — what kills it. A player deciding whether to buy the
first 4-train is deciding whether to erase every 2-train on the board, including their own, and nothing in
the app said so.**

### RulesReference.tsx #9(3) — The narrative section, and the two end-condition audits
**Direct feedback:** "the rules reference needs a more prosaic/narrative explanation of the game, your
purpose as a player, and the win conditions." Prose paragraphs, no bullet lists, per the request's own
wording. **Sourced from this contract's real logic, not generic 1830 knowledge:** personal net worth is
`contract::calculate_player_net_worth` (cash plus live share value, **a company's own treasury explicitly
excluded** — see that function's doc comment); the real-JUNO ante pool is redistributed proportionally to
final net worth by `contract::finalize_and_distribute_payouts`.

**⚠ THE $350 TRIGGER IS NO LONGER DOCUMENTED AS AN END CONDITION.** It was never canonical 1830 —
`market.rs`'s own module doc already conceded it is "this project's own explicit, user-requested house
rule, not a transcription of the reference engine's behavior" — and it is removed from the rules text and
from the market grid (`StockMarketRenderer.tsx #27`/`#652`). The three **real** end paths are enumerated
instead: the **Bank running dry** (`GameSession::bank_is_broken`, the rulebook's primary end condition),
**presidential bankruptcy** on a mandatory train purchase, and the **room creator ending the game
manually**.
**Backend audit item: the contract still fires the $350 trigger.** The frontend no longer advertises it,
**which closes the player-facing half of the discrepancy and not the contract half.**

**⚠ SECOND, LARGER AUDIT ITEM — ANNULMENT.** The section documents **two CLASSES of ending, not three paths
to one ending:**

| | |
|---|---|
| **Natural end** (bank breaks, or presidential bankruptcy) | the ante pool is distributed by final net worth |
| **Annulment** (host ends the match, or a 48-hour inactivity timeout) | **no winner, no net-worth payout, every player refunded their own ante less gas and development fees** |

**The anti-exploit reason is the whole point: while every ending paid out by net worth, a host who was
ahead could simply end the match and bank the lead. Refund-on-annul removes the incentive entirely.**
**THE CONTRACT DOES NOT DO THIS YET, and this is the sharper end of the discrepancy.**
`EndGameAndDistribute` runs the SAME `finalize_and_distribute_payouts` a natural end runs, **so today a
manual end still pays out by net worth. There is also no 48-hour timeout in the contract at all — no
stored last-action timestamp, no permissionless expiry entry point.**
Implementing annulment needs **a refund path distinct from the payout path, plus timeout state.** Until it
lands, **THIS TEXT DESCRIBES INTENDED RULES, NOT SHIPPED BEHAVIOUR — flagged deliberately rather than
quietly written as though it were already true.**

## Layout history of the tab

### RulesReference.tsx #6 / #9(1) — Two legibility passes
`#6` scaled every text style up roughly 25–40% (page title 20 → 26px, body 12 → 16px, section titles
14 → 18px, table text 13 → 16px, row notes 11 → 14px) with paddings and line-heights nudged alongside.
`#9(1)` pushed further after the text was still reported too small: body 15 → 18px, table cells 16 → 18px,
row notes 13 → 16px, line-heights 1.5–1.6 → 1.6–1.7.
**#6(2) is a verified-clean audit, not a cleanup with a visible before/after:** a full re-read of every
JSX-rendered string turned up zero TODO/FIXME/placeholder/debug text, and the confidence-badge UI `#1`
describes removing **was already gone before that pass.** Recorded rather than silently skipped, **so a
future reader knows the check was actually done.**

### RulesReference.tsx #7 → #10 → #140 → #17 — Where the current-round panel lives
- **#7** added a sticky **Quick Reference** section rendering the active round's one-line checklist, from
  a new `quick` field on each flow step. Two optional props (`roundType`, `operatingSubPhase`) were added
  as **locally-typed unions, not imports — the same "no `gameState` coupling" discipline as `#2`, extended
  minimally.** Disconnected, it outlined all three rounds side by side, **so the section is always useful,
  connected or not.** `AUCTION_FLOW` was added here: **this tab previously had no auction content at all.**
- **#10** replaced it with `CurrentRoundReferenceSection` — **not sticky, and always rendering every
  round's FULL `detail` prose**, because the same restructure **removed the three standalone Game Flow
  sections that used to carry that content.** Folding them into one column **loses no information only
  because it now always shows full detail for every round.** The page became two stacked rows: narrative
  left / current round right on top, **and the two lookup tables side by side at the bottom** — with
  "Certificate Limit by Player Count" and "Starting Cash by Player Count" merged into one three-column
  table, **zipped by matching `players` rather than assumed-parallel indexing, so it stays correct even if
  either array's row order changes independently.** Styles left over from the deleted view were **deleted
  rather than left dead in the file.**
- **#140 — regression fix.** The panel was back at the TOP, full width. **Nothing deleted it; that is why
  it was hard to spot.** `#10` moved it into a `flex: 1 1 480px` column sharing a **wrapping** row with five
  paragraphs of narrative. **Above ~1000px the two sit side by side and it is visible. Below that the row
  wraps, the narrative renders first, and the round panel lands underneath a full screen of prose —
  present in the DOM, absent from view, and reported as "vanished".**
  It leads the page again **because of what it IS: the only part of this screen that changes with the
  room's live state, and the part a player consults mid-turn. Static reference tables can be scrolled to;
  the answer to "whose turn is it and what comes next" cannot.**
- **#17 — the compact checklist is restored, alongside the full one.** `#10(2)` deleting it **lost
  something real: the full version is a document you read, and what a player wants mid-turn is a list they
  can glance at.** Both now exist as **deliberately different tools rather than two sizes of the same one**
  — one line per step at the top ("what am I doing, and what comes next"), full prose below ("what exactly
  does that step mean"). It reads the **same `quick` one-liners** the flow arrays already carry — the field
  `#7` added for precisely this and which had been unused since `#10(2)` removed its only consumer — **so a
  step added to a flow array appears in both places automatically and the two cannot drift.**
  **Disconnected it lists all three rounds rather than hiding: in offline sandbox mode there is no live
  round, and a panel that renders nothing is indistinguishable from a panel that is broken — which is
  exactly how its absence was reported.**

### RulesReference.tsx #143 — Which rounds are expanded: state plus an effect, not a derived value
Two requirements pull against each other, **which is why this is state plus an effect:**

- **the ACTIVE round opens automatically whenever the round CHANGES**, so a player moving from a Stock
  Round to an Operating Round finds the relevant rules in front of them; and
- **a manual open or close STICKS**, so someone who deliberately opened another round is not fighting a
  panel that keeps re-collapsing under them.

**Deriving "open = isActive" would make manual expansion impossible; pure state would never react to the
round changing.** The effect fires **only on a genuine round transition, tracked against a ref** — not on
every render, and **not on the poll-interval re-render that reports the same round again, which would
silently reopen a section the player had just closed.**
Opening is **deliberately additive** — anything opened by hand stays open. (`forEach` into a fresh Set,
not a spread: **tsconfig targets ES5 without `downlevelIteration`, so spreading a Set is a compile error
here.**)

### RulesReference.tsx #30 / #37 — Signals, and where a note belongs
**#30 — the ACTIVE badge is gone.** The active round is already reordered to the front, auto-opened and
given a highlighted header — **the badge was a fourth signal for a fact three other things were already
saying.** The sub-phase detail it carried moves inside the panel, **next to the steps it describes.**
**#37 — plain text, no hover state at all.** Label left, value right, nothing hidden. **This went through
three rounds — prose in the cell, then a tooltip with a marker glyph, then a tooltip with no marker — and
the last was the worst of the three: information that exists but is undiscoverable is not a feature, it is
a trap for whoever maintains this next.** If a note matters enough to keep, it belongs in the narrative
section as visible prose; if it does not, it should be deleted. **Either way it does not belong in a
`title` on a lookup table.**

### RulesReference.tsx #7 (sub-phase labels) — A hand-kept duplicate, on purpose
The Operating Round sub-phase label table mirrors `App.tsx`'s own exactly (name + 1-based index) and is
**not imported**, per `#7`'s "no `gameState`/`App.tsx` coupling beyond two optional display props"
discipline. **Used only for the small supplementary UI-step badge; the numbered checklist itself always
comes from the flow array.**
The Stock Round loop **repeats player-by-player until the room's creator explicitly begins the next
Operating Round** — **this contract has no automatic pass-streak transition
(`GameSession::consecutive_passes` is tracked but not yet consumed).**
The Waterfall Auction section documents the five real `ExecuteMsg` actions `waterfall.rs` implements,
sourced from `WaterfallAuctionDashboard.tsx`'s own notes. **It runs once, before Stock Round 1 ever
opens.**

### RulesReference.tsx #640 — Which build the browser is actually running
`UI_BUILD_LABEL` is surfaced on this tab as **the one place to look when a reported bug cannot be
reproduced.** A bug report against an unknown build is a bug report against every build.
