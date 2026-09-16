# Stage 8 — Operating order, presidency, home stations, M&H exchange: authority design (design pass, no implementation)

**Date** 2026-09-16. **Baseline** `7c5f29cba26b280ee22cfdcca1a215c3d0176671` (`RULES_ENGINE_VERSION = 5`, Batch 7 closed:
384/384 suites, 6528/6528 tests, typecheck and server build clean). **Nothing in this pass changes gameplay code, the
version pin, a golden, a fixture or a stored log.** The only repository writes are this document, the targeted
`RULES_HARDENING_BACKLOG.md` edits listed in §16, and the diagnostic sweep parked under `_to_delete/`
(`__stage8_sweep.test.ts`, `stage8_sweep.json`) for the owner to remove.

**Rulebook authority.** Lookout Spiele 1830-RE (2018), `en_1830re.html_Rules_1830-RE_EN.pdf`. Quotations below are
verbatim from that file (fetched from `lookout-spiele.de` for this pass; the owner's local copy is the same file).
Owner-defined variants (Level Playing Field, Project 18XX+, Delayed Auction) are judged against the owner's spec and
the notes cited.

**Method.** Read the ledger (`RULES_HARDENING_BACKLOG.md` Part B Stage 8, Part C, Part D, Part E), the audit
(`AUDIT_RULES_TO_MACHINE_2026-09-13.md` M10 / M15 / m2 / m3 / m6), the Batch 7 design and the 7.5 closure, then traced
the source named in §2–§7 and swept the whole development corpus (18 files / 12 rooms) with a temporary read-only
observer test (`_to_delete/__stage8_sweep.test.ts`; its output `_to_delete/stage8_sweep.json`). The sweep is the
evidence for every "corpus" sentence below. The full Jest suite was **not** run.

---

## 0. Owner rulings from the Stage-8 review (2026-09-16) — the durable record

The owner reviewed this design on 2026-09-16 and ruled the four questions of §14. The rulings below **supersede** any
conflicting wording further down; each superseded passage is marked in place and kept for the reasoning trail. R1–R3
govern later slices and are **not** implemented by Slice 8.1; R4 is Slice 8.1's representation.

**R1 — the M&H exchange is a free interjection, with a queued off-turn timing model (Slice 8.4).**
The exchange does **not** consume the player's one Stock Round certificate purchase; does **not** set or consume
`bought_this_turn` (nor `bought_this_turn_company`); does **not** change the Sell → Buy → Sell structure
(`stock_turn_stage`); does **not** reset or otherwise alter the consecutive-pass streak; does **not** move Priority Deal;
does **not** move the seat; and does **not** count as the player's normal Stock Round action (`turn_action_taken`).

*Why a timing model is needed at all.* The rulebook (p. 27) lets the owner exchange "during the player's turn of a stock
round or between the turns of other players or railroads in either stock or operating rounds". At a physical table the
players themselves supply the "between turns" moment. **The server has no persistent "between turns" state**: it
advances from one turn to the next immediately, so there is no pause in which an off-turn request could simply be
applied. The approved digital model is therefore:

- **Immediate execution.** A request made during the owner's own Stock Round turn, or at a genuine server-visible turn
  boundary, executes at once if otherwise legal.
- **Queued off-turn execution.** A request made while another player's or corporation's turn is already underway is
  recorded as a **pending M&H exchange request**. It is not executed in the middle of that active turn, does not
  interrupt the current actor, and raises no modal prompt at any turn transition. It executes automatically at the
  **next legal "between turns" boundary**, and the **entire exchange is revalidated against authoritative state at that
  boundary** before it settles; if it is no longer legal, the queued request is retired / refused cleanly rather than
  forced through.
- **Player-initiated only.** The request is the owner's. The game must never pause a transition to ask the M&H owner
  whether he wants to exchange — no transition-time M&H prompt, ever.
- **Holds take precedence.** Mandatory holds and atomic resolution come first: the excess-train discard, emergency
  funding, a pending bilateral offer, the home-station obligation (Slice 8.2) and any other authoritative hold. A queued
  exchange settles only after the blocking obligation is resolved, and at the next valid turn boundary.
- **Queuing vests nothing (owner, 2026-09-16 — RULES REFERENCE / GOTCHA, U-35).** A queued exchange is only a request to
  exercise the power at the next legal between-turns opening. Queuing does **not** vest, reserve or lock in the exchange:
  at settlement the entire exchange is revalidated against the then-current authoritative state, and a request that is
  no longer legal expires without effect. The edge case the future Rules Reference "Gotchas" must call out explicitly:
  a player queues the M&H exchange during another corporation's Operating Round turn; before that corporation's turn
  ends it purchases the first 5-train; Phase 5 begins immediately and all private companies, the M&H included, close
  immediately; at the next between-turns boundary the queued request is no longer legal and expires without effect —
  the player does **not** receive the NYC share merely because the request was submitted before the 5-train purchase.
  The same general rule applies if the requested NYC share, or another legality condition, ceases to be available
  before settlement. Suggested player-facing wording: "Gotcha — Queuing M&H doesn't reserve the exchange. If you request
  the M&H power during another turn, it waits for the next legal between-turn opening and is checked again then. If the
  first 5-train is bought before that opening, M&H closes and the exchange is lost."
  Classified under U-35 as RULES REFERENCE / GOTCHA and STATE VISIBILITY for the queued → executed / canceled status;
  the visual presentation is not designed yet.
- **Not relaxed.** This is not "execute literally any time in the middle of another corporation's turn".
- **State.** If the existing turn-state architecture cannot identify the correct boundary without a small explicit
  field, Slice 8.4 (Opus) proposes the smallest deterministic state addition then.
- **STATE VISIBILITY.** A queued exchange needs an immediate requester-facing acknowledgment and a table-visible pending
  indication that persists until execution or cancellation. Exact presentation is TBD in the UI backlog (U-35); the
  Activity Log alone is not sufficient.

**R2 — share source choice (Slice 8.4 / U-35).** If both the NYC IPO (Bank) and the Bank Pool contain a legal 10 % NYC
share, the M&H owner chooses which source supplies the exchanged share. If only one source is legal / available, only
that source needs to be offered. No silent IPO-first rule. This is a UI source choice (NEW ACTION) in the later
UI-parity work.

**R3 — development-corpus home-token adapter (Slice 8.2).** The recommended deferral adapter of §9 is approved, in its
**"last recorded historical choice on a legal home hex"** form. The remembered choice is **data only**: when the
synthetic first-turn placement is attempted it must pass the **current** authoritative home-placement predicate against
the then-current board. The adapter never forces an obsolete / now-illegal placement through; if the remembered choice
is no longer legal, no placement is synthesized and the normal authoritative home hold stays in force. The adapter is
development-corpus-only and must never become production compatibility behaviour. The expected CV4 field-only
re-baseline and the eventual Z6C / 3XD replay corrections produced by the Stage-8 home rule are accepted.

**R4 — operating-order representation (Slice 8.1).** Approved: **frozen round membership + frozen operated / current
prefix + dynamically sorted not-yet-operated tail** (model (a) of §2.4). `active_operating_order` and
`active_corporation_index` are kept; no operated-set architecture.

**Model policy (owner, 2026-09-16).** Opus is the default model for **every** Stage-8 implementation slice. Escalation to
Fable is appropriate only when, after tracing the real implementation, a specific unresolved architectural ambiguity
with materially different valid solutions remains — never merely because a state machine is complicated. §11 and §12
are updated to match.

---

## 1. Inventory of every Stage-8 item in the ledger

| Item | Ledger status today | Finding of this pass | Disposition in Stage 8 |
|---|---|---|---|
| **S8-1** OR order snapshotted before the sold-out rise | OPEN (confirmed bug) | Confirmed by code (§2). The three corpus indices the ledger cites (3XD 303, FCJ 699, FCJ 398) **no longer exist on the version-5 corpus** — 3XD is refused from 140 / frozen from 290 and FCJ diverges from 83; the one surviving rise at an OR opening (FCJ 885, PRR 90 → 100) leaves the queue unchanged because PRR already led. The mechanism is proved on every OR-bearing board by the resolver-overlay probe (§2.3). | **Slice 8.1** (with S8-3, S8-4) — **IMPLEMENTED 2026-09-16 (Opus, uncommitted; §2.8)** |
| **S8-2** presidency tie by `player_holdings` order | OPEN | Confirmed by code (§4). No stored log contains a tie between two challengers (every presidency change in the corpus has exactly one challenger). Additional gap found: the `ExchangePrivate` arm never calls `settlePresidencies` (§6). | **Slice 8.3** (Opus, after the helper is frozen here) |
| **S8-3** order fixed at OR open; §6.1 note not applied | DEFERRED | Confirmed by code; no mid-OR price movement of a not-yet-operated corporation occurs anywhere in the corpus (the only engine path that can produce one is Stage 5's forced sale of another corporation's shares during an OR). Design in §2. | **Slice 8.1** — **IMPLEMENTED 2026-09-16 (§2.8)** |
| **S8-4** sold-out rise iterates in company order | OPEN (test gap) | Confirmed by code (`roundEndSoldOutRises` walks `public_companies`; `withArrival` stamps arrival in walk order, so two risers landing in one cell stack in company order, not §4.5's). No two risers share a cell anywhere in the corpus (one rise at an opening in 18 files). | **Slice 8.1** — **IMPLEMENTED 2026-09-16 (§2.8)** |
| **S8-5** home token placed at float, not at the first operating turn | DEFERRED (owner ruling owed) | **Owner ruling received in the Stage-8 brief (2026-09-16): move it.** Full lifecycle audit in §5; corpus consequences in §8. | **Slice 8.2** (Fable High) |
| **S8-6** `PlaceHomeStation` hex/circle unvalidated in the reducer | OPEN | Confirmed by code; the corpus sweep finds **no stored placement off its home hex** (every applied placement matches `homeHexesFor`), so validation refuses nothing historical. The D&H free station (`kind: "dh"`) goes through the same arm and must be exempted from the home check (§5.6). | **Slice 8.2** |
| **S8-7** first-SR sale ban | RESOLVED (7.2) | Nothing residual in the reducer. | absorbed — do not touch |
| **S8-8** unparred share sale | RESOLVED sale half (7.2); `priceOf` / `sharePriceFor` `?? 67` fallback still standing | The fallback is unreachable for a sale on a pinned board (7.2 rule 5) and for a forced sale of an unparred share (rule 4). It is dead-code hygiene, not a gameplay defect. | **Slice 8.5 cleanup** (Opus, mechanical) — or leave; no rule depends on it |
| **S8-9** par ladder / silent president conversion | RESOLVED (7.2) | Nothing residual. | absorbed — do not touch |
| **S8-10** M&H exchange takes IPO before pool | OPEN | The ledger's sentence understates it. The `ExchangePrivate` arm applies whatever the message says and re-derives nothing (§6): source, corporation, `keep_open`, ownership, the 60 % cap, the certificate limit, share availability, timing, the float threshold and the presidency are all unjudged in the reducer; ingress asks only "is the M&H yours". Corpus: 3XD 288 takes NYC's IPO from 50 % to 40 % (60 % out) **without floating it**; it floats one entry later on a purchase. | **Slice 8.4** (Opus after §6 is frozen; one Fable question in §6.7) |
| **S8-11** timing notes (m4 / m5 / m11) | OWNER DECISION pending only if rulebook-literal timing is wanted | Not defects. No change proposed; m4 (float capitalisation on the crossing purchase) is untouched by the home move because the treasury is still unspendable before the OR. | leave |
| **S8-12** ingress does not mirror the home-token hold | OPEN | Confirmed by code (`turnRefusal` has three holds, no home hold). **Absorbed into Slice 8.2** — the hold's sentence, pass list and ordering are one rule at both locks (§5.7). | **Slice 8.2** |
| **S8-13 (new, proven)** the chart step runs before the holds | — | Newly proven on the corpus: **FCJ 904 / 911 / 918 / 932** are `SellStock` entries sent while N&W (floated at 902) owed its home token; the core refuses each sale, but `applySandboxMarketAction` had already walked the seller's token down, so `market_positions` moves for a sale that never happened (§5.8). The same shape is latent for the discard and offer holds. Filed as S8-13. | **Slice 8.2** (the hold moves in front of the chart step) |

Absorbed and not to be re-implemented: S8-7, S8-8 (sale half), S8-9. Residual wording only: S8-8's `?? 67` fallback in
`priceOf` / `sharePriceFor` (helper hygiene, no gameplay path reaches it on a pinned board).

Also in the ledger's Stage-10 cross-references and unchanged by this pass: S10-17 (`PlaceHomeStation` hex is a
message-carried fact — closed by S8-6), S10-18 (test gaps for S8-2 / S8-4), S10-21 (the Z6C epilogue fixture — its
characterization moves again under Slice 8.2, see §8).

---

## 2. S8-1 / S8-3 / S8-4 — the operating order

### 2.1 Rule

§6.0: "The railroad with the highest share value takes the first turn and then the next highest valued railroad takes
its turn, and so on until each floated railroad has had a turn. Sometimes the share value tokens of 2 or more floated
railroads are in the same grid block of the stock market. In this case, the railroad whose token is on top takes a
turn first, then the railroad with the next token down, and so on. If 2 or more floated railroads have the same share
value but their share value tokens are in different columns, the railroad whose token is furthest to the right takes a
turn first. If 2 or more floated railroads have the same share value and their share value tokens are in the same
column, the railroad whose token is furthest up takes a turn first."

§6.1 note: "For the purposes of turn order, if a railroad's share value changes for a railroad that has not yet
operated, the new share value is used."

§4.5: "A corporation's share value token moves up 1 grid box if all of its shares are owned by players the end of a
stock round. If it is already at the top of a column, the token does not move. Tokens are moved in share value order,
with the highest priced corporation's token being moved first."

§5.3: "Once 60% of the shares in a corporation have been bought from the initial offering, the corporation is
'floated.' It begins operating in the next operating round." — this is the answer to "corporations that newly float
during an OR": a float between turns (only the M&H exchange can do it, §6) joins the **next** Operating Round, never
the one in progress.

### 2.2 Current machine (traced)

- `operatingOrder.ts` `buildOperatingOrder(state, priceFor?, markFor?)`: comparator is correct (price desc → column
  desc → row desc → arrival asc → id). It reads `state.market_positions` **first** and consults the injected resolvers
  only when positions are absent (#1196).
- `sandboxSession.ts` `settleRoundTransitions` (`stock_round_just_ended` branch, ~3715): computes the rises with
  `roundEndSoldOutRises(state, ctx.marketMarkFor, ctx.projectRise)` and hands them to `openOperatingRound` as
  overlays (#746a). Because every server/replay board carries positions, the overlays are ignored and the queue locks
  on pre-rise positions.
- `applySandboxActionInner` (~2766): **after** the core has opened the round, commits the rises to
  `market_positions` (`withArrival`, arrival stamped in walk order) and runs `reconcileParMarks`.
- `beginOperatingRound` (366) writes `active_operating_order` and `active_corporation_index: 0` and syncs the seat;
  `advanceCorporation` (~402) moves `index + 1`; nothing ever reorders the queue after the opening.
- `settleOperatingCursor` (3371) reads only the index (turn-change detection, reprieve expiry, sub-phase).
- Readers of the queue outside the reducer: `operatingCorporationId` (identity gate, dividend gate, offers, train
  sale), `turnGuardKey` (macro.sub.**index**:protocol:step — the derived-action idempotency key), `pendingHomeTokens`
  (ordering only), `App.tsx` (1271 "operated" set = `slice(0, index)`, 1300 "queued", 12925 `done: index < cursor`,
  #1296 market-token operated stack), `ContextualSubPanel`, `actionLog`.

### 2.3 Proof

Corpus (v5 tree): the only OR opening on which a sold-out rise fires is **server/JUNO-FCJ 885** (PRR 90 → 100); the
locked queue `[PRR, B&O, B&M]` equals the queue rebuilt on the risen positions because PRR already led. The ledger's
three indices are gone from the v5 replays (3XD refused from 140 and frozen from 290, FCJ diverged from 83). The
mechanism itself is demonstrated on every OR-bearing final board by handing `buildOperatingOrder` an overlay that
prices the leading corporation at $1: the overlay is ignored on CV4 ×3, CW7, 3XD and QVC (`overlayIgnoredProof` in
the sweep output). So S8-1 is a code-level defect whose repair changes nothing in the present corpus.

S8-3: the sweep finds **no** entry anywhere in the corpus on which a not-yet-operated corporation's price changes
during an OR. The only engine path that can produce one is Stage 5's forced `SellStock` of another corporation's
shares (a president's emergency sale drops the sold corporation's token). Dividends move only the operating
corporation; the sold-out rise is SR-end only; purchases never move a token.

S8-4: `withArrival` gives the first-processed riser the earlier `enteredAt`, i.e. the top of the stack; the walk is
`public_companies` order. Correct only by coincidence when the lower-id corporation is also the higher-priced one.

### 2.4 Authoritative state model — recommended: **frozen membership, dynamic tail, one settle point**

> **Owner ruling R4 (2026-09-16): approved** — frozen round membership + frozen operated / current prefix + dynamically
> sorted not-yet-operated tail; `active_operating_order` / `active_corporation_index` kept (§0).

Not "sort the whole queue after every action". The three representations considered:

| Model | Shape | Verdict |
|---|---|---|
| (a) Persistent queue re-sorted from current positions — **frozen prefix, dynamic tail** | keep `active_operating_order` / `active_corporation_index`; the round's **membership** is fixed at open; after every settle, entries at positions `> index` are re-sorted by the §6.0 comparator on current `market_positions`; positions `≤ index` never move | **Recommended.** Every reader, the turn-guard key, the UI's "operated = prefix" derivation and the digest keep their meaning; the invariants below are structural |
| (b) Operated-set + argmax | replace queue/index with `operated: number[]`, `operating: number | null`, `round_members: number[]`; next = argmax of the remainder | Rulebook-literal but touches ~20 readers, `turnGuardKey`, the goldens' field shape and the UI; membership still has to be stored. No gain over (a) |
| (c) Re-derive on read (no stored queue) | compute order from positions whenever asked | Loses "an operating corporation is not displaced mid-turn" (its own dividend moves its price) unless the operating id is stored anyway — which is (b) |

One function, `settleOperatingQueue(state)` (new, in `operatingOrder.ts`): if `current_round_type === "OperatingRound"`
and the queue is non-empty, let `head = active_operating_order.slice(0, active_corporation_index + 1)` and
`tail = slice(index + 1)`; return the state with `active_operating_order = [...head, ...tail sorted by the §6.0 key
on state.market_positions]`, then `syncSeatToActingCorporation`. Identity when nothing moves.

**Where it runs — exactly one place:** at the end of `applySandboxActionInner`, **after** the sold-out rises are
committed to `market_positions` and after `reconcileParMarks`, and (because the chart step of a sale runs before the
core, #1197) after both. That single call fixes S8-1 and S8-3 together:

- at the opening (`index = 0`, head is one corporation — but on the opening entry nobody has acted, so the head is
  re-sorted too: special-case `operating_round_opened_this_entry` by comparing `before.current_round_type !==
  "OperatingRound"`, in which case the whole queue is the tail); the #746a overlays become dead and are removed;
- mid-round, after a forced sale or any future price mover, the not-yet-operated tail reorders.

The special case is what makes S8-1 fall out of S8-3: on the opening entry the operating corporation has done nothing
yet, so it may still be displaced; from the next entry on it may not.

### 2.5 Invariants (to pin in `operatingOrder.test.ts` / a new `operatingQueueSettle.test.ts`)

1. **Membership frozen at open**: the set of corporations in `active_operating_order` after the opening entry equals
   `buildOperatingOrder(afterOpening)` and never gains or loses a member during the round (a float between turns via
   the M&H exchange is not inserted — §5.3 "begins operating in the next operating round").
2. **Prefix immutable**: for every entry after the opening, `after.order.slice(0, after.index + 1) ===
   before.order.slice(0, before.index + 1)` when `index` did not advance, and `before.order.slice(0, before.index + 1)`
   is a prefix of `after.order` when it did. An already-operated corporation therefore never operates twice, and the
   operating corporation is never displaced mid-turn even when its own dividend moves its token.
3. **Tail sorted**: `after.order.slice(index + 1)` is sorted by the §6.0 key on `after.market_positions` — same cell:
   stack order (arrival asc); same price different column: rightmost; same price same column: uppermost.
4. **Opening on risen positions**: the queue after the SR-closing entry equals the §6.0 sort of the *committed*
   post-rise positions (S8-1); two risers landing in one cell are stacked highest-priced-first-moved (S8-4).
5. **Determinism**: replaying the log reproduces `operatingCorporationId` after every entry (`stateDigest` covers
   `active_operating_order`).
6. **Derived keys stable**: `turnGuardKey` for the operating corporation cannot change during its turn (its index is
   in the prefix). Note for the implementer: a corporation whose tail position changed has emitted no key yet, so the
   `emitted` set is unaffected; a restore recomputes the same keys because the re-sort is log-derived.

### 2.6 Interactions

- **Discard queue (#1530)** asks `buildOperatingOrder` of the state as it stands — unchanged and still correct (the
  discard order is §6.6.1's, judged when the obligation arises).
- **#1296 operated stack / App.tsx 1271 / 12925**: "operated = positions before the cursor" stays true under (a).
- **`syncSeatToActingCorporation`** must run after the settle (the corporation at `index` may have changed at the
  opening).
- **S8-2**: none (presidency moves do not move prices).
- **Home slice (S8-5)**: none in state; the home hold is keyed on `operatingCorporationId`, which the settle may
  change only on the opening entry, before any turn action.
- **S8-10**: an M&H exchange between turns that crosses 60 % floats NYC mid-OR; invariant 1 keeps it out of the
  current queue.
- **Replay**: replay-semantic (the digest field `active_operating_order` can differ) — part of the Stage-8 bump; on
  the present corpus no digest changes (§2.3).

### 2.7 S8-4 repair

Sort the risers before committing: price desc, then the §6.0 key (column, row, arrival) — reuse the comparator by
exporting it from `operatingOrder.ts` — and commit in that order so `withArrival` stacks the highest-priced first
(on top). Pin with a two-riser-one-cell case in `soldOutRise.test.ts`.

### 2.8 Implementation record — Slice 8.1 (Opus, 2026-09-16; uncommitted, awaiting owner review)

S8-1, S8-3 and S8-4 are implemented to R4's representation, with the refinements listed below. Design notes **#1600**
(the queue settle) and **#1601** (riser order) carry the reasoning in source.

**Files.** `frontend/src/gameEngine/operatingOrder.ts` — the §6.0 key and comparator exported (`operatingOrderKey`,
`compareOperatingOrder`) and reused by `buildOperatingOrder`; `syncSeatToActingCorporation` moved here unchanged; new
`operatingRoundOpenedBetween` and `settleOperatingQueue`. `frontend/src/gameEngine/sandboxSession.ts` — the settle point;
the #746a overlay removed from `settleRoundTransitions` (note marked superseded, kept); the local
`syncSeatToActingCorporation` and the `roundEndSoldOutRises` import removed. `frontend/src/gameEngine/soldOutRise.ts` —
riser order. Tests: `frontend/src/utils/operatingQueueSettle.test.ts` (new, 17 cases) and
`frontend/src/utils/soldOutRise.test.ts` (5 riser-order cases added; the three #746a harness cases moved from a
positionless board with resolvers to a charted board whose rise is committed, and the compass source scan now looks for
the reducer's one rise call, `soldOutRises(` — every expectation the same in substance).

**The algorithm — `settleOperatingQueue(before, after)`.** `before` is the board the entry was applied to (before its
chart step); `after` is the board it produced.
1. `after` not an Operating Round, no `market_positions`, or a malformed cursor → return `after`.
2. `opened = operatingRoundOpenedBetween(before, after)`.
3. `!opened` and `after.market_positions === before.market_positions` (no token moved this entry) → return `after`.
4. `frozen = opened && index === 0 ? 0 : min(order.length, index + 1)`; `waiting = order.slice(frozen)`.
5. Sort `waiting` by `compareOperatingOrder` on `after`'s chart (price desc → column desc → row desc → arrival asc →
   company id). Unchanged → return `after` itself. Otherwise write `[...order.slice(0, frozen), ...sorted]`.
6. If that put a different corporation under the cursor (only possible when `frozen = 0`) →
   `syncSeatToActingCorporation`.

**The single settle point.** `applySandboxActionAfterAuction`, charted branch, immediately after
`applySandboxActionInner` returns — after the chart step, the core (arm, `settleRoundTransitions`, era, B&O private,
cursor, bankruptcy), the committed sold-out rise and `reconcileParMarks`. §2.4 named "the end of
`applySandboxActionInner`"; the call sits one line above it so that `before` is the pre-chart board and a move made by
the chart step itself (a dividend, a forced sale, a Blood Price) counts as a token moving. Only `settleAuctionLifecycle`
(the auction atom) runs after it. Nothing else writes `active_operating_order` once a queue is built.

**"Opened this entry" (`operatingRoundOpenedBetween`).** `after` is an OR and `before` is not; or
`macro_round_number` / `sub_round_index` differ (the next OR of a set, opened by `advanceCorporation`); or, within the same
round number, the queue was rebuilt — the cursor walked back, the operated / current prefix changed, or an empty queue
was repaired (#411, `BeginOperatingRound`). Broader than §2.4's `before.current_round_type !== "OperatingRound"`, which
would miss the second and third ORs of a set (harmless today, because that queue is built on a final chart, but the
rule should not depend on it).

**Frozen membership.** The settle only permutes `order.slice(frozen)`; it never reads `is_floated` and never inserts or
removes. A corporation floated between turns is absent until the next opening builds a new queue (§5.3).

**Why "a token moved" is the complete trigger.** On a charted board the comparator reads only `market_positions` for a
floated corporation. Between openings the waiting tail changes only by losing its head to `advanceCorporation` — a
sorted tail stays sorted — or by a token moving, which re-sorts. So after every entry of a log-derived round the
waiting tail is in §6.0 order (proved on the corpus below). And an entry that moves no token and opens no round — which
is every refusal except S8-13's latent chart-before-hold shape, removed by Slice 8.2 — never rewrites the queue, even on a
hand-built fixture whose tail is out of order.

**Refinements to the §2.4 text (all inside R4).**
- The trigger above, where §2.4 said "after every entry" — observationally identical on every log-derived board.
- Positionless boards (unit fixtures only; every room, replay and the shell carry the chart) are not settled: their
  queue is #1196's resolver-built opening queue as before, and they no longer get the #746a overlay.
- The whole-queue opening re-sort requires the cursor at 0 (a "rebuild" that left the cursor elsewhere keeps the prefix
  rule rather than risk moving a corporation that has operated).
- `syncSeatToActingCorporation` runs only when the cursor's corporation changed, so a tail re-sort never touches the
  seat.

**S8-4.** `roundEndSoldOutRises` collects each riser with its pre-rise mark and sorts by `compareOperatingOrder` on that
mark before returning; `applySandboxActionInner` commits in that order, so `withArrival` stamps the highest-priced
riser first and two risers from one cell keep their stack order. `RiseCell` gained the optional `enteredAt` the marks
already carry. The shell's Activity Log call lists rises in the same order (no `App.tsx` edit).

**Cursor, seat, key and replay safety** (`operatingQueueSettle.test.ts`). A tail re-sort leaves the operating
corporation's identity, index, seat and `turnGuardKey` unchanged (case 13); its own payout or withhold never displaces it,
though a whole-queue re-sort would have (case 8); an operated corporation's price fall leaves the prefix byte-identical
(case 9); a round walked to its end operates each member once, the re-sorted head next (case 10); a corporation floated
after the opening is not inserted and joins the next round (case 11); a no-change settle is an identity and a refused or
non-moving entry never touches the queue (case 12); the opening re-sort re-seats the table and the derived key names the
new head (cases 1, 14b); two `RoomEngine` replays and the live reducer agree on queue, cursor, operating corporation,
seat, turn key and derived key after every entry (case 14). A derived key is only ever computed for the corporation under
the cursor, from the settled board, so no emitted key can name a corporation the settle later moves.

**Mutation check** (on a scratch copy outside the repository). Settle disabled → 14 cases fail; whole-queue re-sort (no
frozen prefix) → cases 8 (both) and 9; catalog-order risers → the three order-sensitive riser cases; no seat sync →
cases 1, 3, 14b; no opening special case → cases 1–4, 14b and two rise-harness cases; the "token moved" trigger removed →
case 12b; membership re-derived (newly floated corporations inserted) → case 11.

**Corpus** (read-only; 18 files / 3,103 replayed entries; `DEVELOPMENT_CORPUS_POLICY`). The working tree immediately
before Slice 8.1 against the tree after it: **digest-identical at every entry and at the end in all 18 files**, with
identical `active_operating_order`, `active_corporation_index`, operating corporation, seat and turn key after every
entry; deterministic in-process and across processes; corpus files byte-unchanged (sha256). 779 Operating Round boards:
every waiting tail already in §6.0 order; 60 openings: every queue equals the §6.0 sort of its committed chart. FCJ 885
(the one opening rise) settles to PRR, B&O, B&M, as stored. `export/JUNO-Y8V` contributes **zero** replayed entries (668
raw rows; its export carries no entry identity, so `effectiveActions` drops every row once a `RevertTo` exists) and is
not replay evidence for anything. No corpus log has a mid-round move of a waiting corporation or two risers in one cell,
so the corpus shows non-regression only; the rules are proved by the hand-built cases.

**Found, not fixed (filed in the ledger).** U-36 — the shell's sold-out-rise Activity Log line is built from the chart
mirror after the reducer's committed result has been copied into it, so it narrates a further rise one row higher
(pre-existing since #1211; `App.tsx` is owner-modified). S9-11 — the Blood Price landing is written without
`withArrival`, so the moved token carries no arrival ordinal (Yellow Sign only). Pre-existing lint: `sandboxSession.ts`'s
mid-file `import` from `./operatingOrder` (#1530) trips `import/first` exactly as it did before 8.1.

---

## 3. Interaction map among the Stage-8 items

| | S8-1/3/4 order | S8-2 presidency | S8-5/6/12/13 home | S8-10 M&H |
|---|---|---|---|---|
| **S8-1/3/4** | — | none | the home hold reads `operatingCorporationId`; the opening re-sort runs before any turn action, so the hold sees the settled corporation | a between-turns exchange that floats NYC is excluded from the current round by frozen membership |
| **S8-2** | none | — | none (the home is owed by the corporation, whoever presides; a presidency change mid-hold moves the seat via `syncSeatToActingCorporation`) | the exchange must call the canonical presidency helper (today it calls nothing) |
| **S8-5/6/12/13** | the settle point is shared code (`applySandboxActionInner`); the hold moves in front of the chart step, the queue settle stays behind it | none | — | the exchange no longer interacts with a seat hold at all (there is no SR-time home hold left), which removes the only cross-item hazard the old model had |
| **S8-10** | frozen membership | canonical helper | no SR-time hold to collide with | — |

The only true coupling is S8-10 → S8-2 (helper) and S8-10 → S8-1 (membership invariant); both are satisfied by
implementing the order and presidency slices first.

---

## 4. S8-2 — presidency transfer

### 4.1 Rule

§5.4: "As a corporation's president, you only remain president as long as your share total in that corporation is not
exceeded by another player. When a player exceeds your share total in a corporation in which you are the president,
take these steps immediately: You give him the corporation's president's certificate, charter, trains, tokens, and
money. He gives you two of his certificates for that corporation. … If multiple players exceed your share total, and
they each have the same number of shares, the new president is the player closest to you going in a clockwise
direction. A president's certificate can never end up in the bank pool."

Preserved rule (Batch 5 / #596b): a challenger must **exceed** the incumbent; a tie with the incumbent keeps the
incumbent. The clockwise tie-break applies only among challengers who all exceed the incumbent and tie with each
other at the top.

### 4.2 Current machine (traced)

`presidencyTransfer.ts` `presidentFor(company)`: eligible = holdings ≥ 20 %; challengers = eligible with strictly more
than the incumbent; top = max; **tie → `challengers.find(pct === top)` = first in `player_holdings` order**, which is
first-purchase order, not seat order and not clockwise-from-incumbent. `presidentFor` takes only the company, so it
cannot see the seating (`player_addresses`). Its own comment cites a non-existent rule ("the one who most recently
reached that level").

Callers: `settlePresidencies` (BuyStock 4750, SellStock 4864 — including Stage 5's forced sale), Stage 5's
`presidentAfterSale` projection (`emergencyFunding.ts` 441 — inherits any fix), `forcedSaleRefusal` case (c),
`shareSaleBlock`'s successor existence check (`shareSale.ts` — existence only, no ordering). **Not** called by the
`ExchangePrivate` arm (§6) nor by the C&A grant in `applyAuctionStep` (harmless there: PRR is unparred and
`settlePresidencies` skips unparred corporations).

No LPF double-certificate special case is needed: the helper works in percentages and `certificateCount` derives the
card counts from `president`; a 20 % double is 20 % of holdings and qualifies exactly as two 10 %s would. Opus should
add one LPF case to prove the swap leaves `certificateCount` consistent.

### 4.3 Canonical helper (frozen design)

```ts
// presidencyTransfer.ts
export function presidentFor(
  company: PublicCompanyState,
  seating: readonly string[],           // state.player_addresses — clockwise order
): string | null
```
Selection: (1) holdings > 0; (2) eligible = ≥ 20 %; (3) if `company.president` holds ≥ 20 %, challengers = eligible
with `percentage > incumbentPct`; none → incumbent; (4) top = max challenger percentage; ties broken by clockwise
seat distance from the incumbent: `d(p) = (seating.indexOf(p) − seating.indexOf(incumbent) + n) mod n`, smallest `d`
wins; (5) no incumbent (unreachable for a parred corporation, kept for fixtures): highest percentage, ties by seat
order from seat 0. `settlePresidencies(state)` passes `state.player_addresses`; `presidentAfterSale` gains the seating
parameter; every existing test passes the roster explicitly. One helper, three askers, no second copy.

Corpus: no tie exists in any stored log (every change has one challenger), so the repair moves nothing historical;
replay-semantic only when a tie occurs — part of the Stage-8 bump.

Test (Opus): three holders 20/20/20 after the president's sale from 30 to 10 — the clockwise-next seat takes it; the
incumbent at seat 2 with challengers at seats 0 and 1 → seat 0 (wraps); tie with the incumbent keeps the incumbent;
forced-sale projection agrees with the settlement.

UI parity: **STATE VISIBILITY** — the presidency-change narration already names the successor; the reason ("clockwise
from the former president") belongs in the Activity Log line (U-30's WHY family) and in the Rules Reference §5.4
paragraph. Filed as U-33 (§13).

---

## 5. S8-5 / S8-6 / S8-12 / S8-13 — home station timing, legality and the hold

### 5.1 Rule

§6.1 Special: "At the start of a railroad's first turn of operation, it places one of its tokens in its starting city
to create its home station (see 6.3.1)". §6.3.1: "At the beginning of a railroad's first turn of operation, it must
place a token in its starting city circle to create its home station. There is no cost to perform this action. …
The Erie home station may be placed on either city in the yellow hex marked with the Erie logo." Note: "The Erie does
not have to place a tile in its starting hex. Similarly, the NYC does not have to place a tile in its starting hex."
§6.3.2: "A railroad may not place a token in a city if it would block the creation of the home station of a railroad
that has not yet operated." §5.3: a floated corporation "begins operating in the next operating round".

### 5.2 Current machine (traced) — the lifecycle as it stands

| Moment | Code | Behaviour |
|---|---|---|
| Float | `applyFloatThreshold` (5895) from the `BuyStock` arm only | sets `is_floated`, capitalises; the token is "prompted, not placed" (#416) |
| Obligation | `pendingHomeTokens(state, homeHexToAxial)` (5953) | every floated, non-herald corporation with a resolvable `home_hex_label` and **no token at all** owes one — in any round |
| Hold | `homeTokenBlock` (`homeTokenGate.ts`) asked in `applySandboxActionCoreJudged` at 3183, **after** the discard / funding / offer holds and after the identity, obligation, station and dividend gates | refuses every message but `PlaceHomeStation` and `UndoLastAction` by identity, in any round — a global freeze from the float onward |
| Seat | `BuyStock` arm 4773 (#769): if the purchase leaves a home owed the seat is **not** advanced; `placeHomeStationToken` (#769a) advances it after the placement in a Stock Round (not under Sell-Buy-Sell) | the SR-time placement completes the buyer's turn |
| Placement | `PlaceHomeStation` arm 4465 → `placeHomeStationToken` (5999) | requires `is_floated`; idempotent on the hex; **validates the hex only for a two-home corporation** ("a log written for a single-home corporation keeps replaying to wherever it recorded"); never checks the circle; prepends the token as `station_token_hexes[0]` and `station_tokens[0]`; shared with the D&H free station (`kind: "dh"`) |
| Ingress | `turnAuthority.turnRefusal` | three holds (discard 141, funding 153, offer 193); **no home hold** (S8-12); `PlaceHomeStation` is a sandbox-only message owned by the corporation's president (`roomMessageRefusal` 452) |
| Derived loop | `nextDerivedAction` | returns `null` under the discard hold only; nothing about the home |
| Reservation | `homeReservationStands` (`hexContractTypes.ts` 219), `evaluateStationPlacement` (`stationTokens.ts` ~300/~390), `homeReservedCityIndex` (524) | "every corporation's home city holds a slot for it from the start of the game, floated or not; released by USE"; a two-home corporation releases both by sitting on either (#1325); unenforced entries (`enforced: false`) draw and hold nothing |
| Herald home | `heraldHexFor` (#1302) | PRR on Project 18XX+ owes no token; its network exists before any token |
| Replay | `RoomEngine.apply` | a refused entry is an identity no-op; nothing derives a placement |

### 5.3 What the corpus says

Every applied home placement in the corpus (CV4 ×3 files, CW7, FCJ + prefix, G6J, 3XD, QVC — 19 applied entries) is a
Stock Round entry **immediately after the float** (`floatAt = index − 1`), on the corporation's own home hex
(`hexMatchesHome: true` for all 44 stored `kind: "home"` entries — 19 applied, 25 not). Between each applied placement and
that corporation's first OR turn, **no entry lays a tile on, places a token on, or runs a route through the home hex**
(`touchesHomeBeforeFirstTurn: []` everywhere; OR entries in between: CW7 B&M 7, FCJ B&M 6, FCJ B&O 35, 3XD PRR 7, QVC
PRR 7, QVC C&O 13, otherwise 0). The 25 unapplied `kind: "home"` entries were sent for corporations that were not
floated on the *version-5* board at the time (most were floated on the board the original engine wrote them against —
Z6C 32, 3XD 213, FCJ 689 are the cases 7.1–7.3's cascades un-floated; the rest are second copies of the same rooms). One `kind: "dh"` placement exists (3XD 115, refused by identity
on the v5 board).

Floats without a placement in the log: CV4 PRR (herald — owes none; operated at 43), FCJ PRR (herald), **FCJ N&W
(902 — frozen from 933, but see S8-13)**, **Z6C B&O (33 — the 7.5 freeze)**, **3XD NYC (289 — frozen from 290; not
previously called out in the 7.5 tables, which stop at 140)**, server/G6J PRR (29, last entry).

### 5.4 Authoritative state model — recommended

**Obligation (derived, never stored):** a corporation *owes its home station* iff
`current_round_type === "OperatingRound"` ∧ `operatingCorporationId(state) === company_id` ∧ `is_floated` ∧
`home_hex_label` resolves ∧ `heraldHexFor(company_id) === null` ∧ `station_token_hexes.length === 0`.

That is `pendingHomeTokens` narrowed to the cursor. Nothing else needs to be stored: "first turn of operation" is
exactly "operating corporation with no token", because the hold below guarantees no turn action can precede the
placement, and a corporation never loses its home token.

- Floating in a Stock Round requires nothing and holds nothing: the `BuyStock` arm advances the seat as for any other
  purchase (#769 and #769a are retired); the SR proceeds; the corporation waits for its first turn.
- A corporation that floats but never reaches its first turn (game end, bankruptcy) has never touched the map.
- A corporation that floats *during* an OR (M&H exchange between turns) is not in the round's membership (§2.5 inv. 1)
  and owes nothing until its first turn in the next OR.
- Once placed the obligation cannot recur (the token is never removed).

**Hold (turn-local):** while the operating corporation owes its home, the reducer refuses by identity every message
except `PlaceHomeStation{kind: "home"}` for that corporation, `RevertTo` (never reaches the reducer, #1026) and
`CloseRoom`; `nextDerivedAction` returns `null` (the loop must not walk the turn — today Track is never auto-skipped
but Tokens, Routes, Dividends and Hardware are, and a tokenless corporation would be skipped straight through); ingress
(`turnRefusal`) carries the same sentence as its **fourth hold**, after the offer hold and before the sandbox-only
exemption, with the same pass list (S8-12 absorbed). Because the obligation is defined on the cursor, the hold can
only ever engage at the start of that corporation's own first turn — it never freezes a Stock Round, never freezes
another corporation's turn, and never fires on a historical board where the obligation is not due. That is the answer
to "what should actually be held": the table *is* waiting on exactly that president at exactly that moment.

**Position of the hold — in front of the chart step (S8-13).** All four holds move from `applySandboxActionCoreJudged`
to `applySandboxActionAfterAuction`, ahead of `applySandboxMarketAction`, in their existing order (discard → funding →
offer → home). A held message must return the board by identity *before* the chart moves. The queue settle of §2.4
stays behind the chart step. (Today the discard and offer holds are protected only by coincidence: a sale under them
is refused by `stockSaleRefusal`'s round rule — except a player↔player trade offer standing in a Stock Round, D-24,
which is the latent case.)

**Placement legality (S8-6), one predicate `homePlacementRefusal(state, msg, mapGrid)` asked by the reducer and by
ingress:**
1. `kind === "home"`: the corporation owes its home (definition above) — which also refuses a Stock Round placement,
   a placement by a corporation that is not operating, a second placement, and a herald home;
2. `(q, r) ∈ homeHexesFor(company_id)` — the printed home; both hexes for the LPF C&O (#1325); no "wherever it
   recorded" for single-home corporations;
3. `city_index`: when the hex has one city, `null` or `0`; when it has more than one (Erie E11), any circle of the
   hex that is not occupied by another corporation's token — **either city**, not only the badge-nearest circle
   (`homeReservedCityIndex` is what is held against *others*; the owner may still take the other circle if it is
   free). Occupancy asks the same per-circle reader `evaluateStationPlacement` uses; the reservation guarantees at
   least one free circle for a single-home corporation, so a "no free circle" refusal is unreachable there and is
   pinned only as a fixture case;
4. no tile is required on the hex (§6.3.1 note): E11 and E19 are printed city hexes; the reader must return the
   printed circles of an untiled hex (test to pin);
5. `kind === "dh"`: unchanged rules (`dhPower.ts`; the D&H's hex F16, the owning corporation, once) — **exempt from
   1–4**. The arm should stop prepending a D&H token at `[0]` ("home first" is the invariant several readers rely on);
   keep `[0]` for `kind: "home"` and append for `kind: "dh"`. Opus to grep the `[0]` readers before changing.

**Reservation (§6.3.2)** needs no change: `homeReservationStands` already models "not yet operated" as "no token of
its own", from the start of the game, and releases by use. Under the new timing the reservation simply persists
through the Stock Round after the float until the first turn — which is the rulebook's own window. The token is never
made physically present early to model it.

**Seat / turn mechanics:** with the SR-time hold gone, `PlaceHomeStation` touches no seat, no pass streak and no
`turn_action_taken`; `settleOperatingCursor` sees no turn change (same index) and leaves the sub-phase on the opening
step; the president then acts normally.

**Erie / NYC:** the city choice becomes an OR-time choice (the prompt moves with the obligation); no tile lay is
required or implied. The disconnected-#57 (NYC) and #59 (Erie) special lays stay their own rules and are not touched.

**RevertTo:** resolved on the log; a rebuild that lands before the placement re-derives the obligation from the board
and the hold re-engages; a rebuild that lands after it owes nothing. No stored field to reconcile.

**Firestore / no-server shell:** `App.tsx` already asks `homeTokenBlock` before dispatch (13005) and raises
`HomeStationPrompt` from `pendingHomeTokens` (8241); both follow the narrowed derivation without a second rule. The
prompt therefore appears at the start of the corporation's first OR turn (U-32, §13).

### 5.5 Interactions with the other holds and obligations

| Interaction | Result under the new model |
|---|---|
| Pending ordinary offer (#1590) | cannot stand at a turn opening (offers are proposed during a turn and block `PassTurn` until settled or rescinded); a player↔player trade proposed in a Stock Round is settled or rescinded before the OR opens because it holds the SR too. Order of holds unchanged (offer before home) so a board under one reports that reason |
| Emergency funding (#1540) | owed at Hardware, never at a turn opening; a tokenless corporation with a legal-route question never arises because the home is down before Routes |
| Excess-train discard (#1530) | owed the moment a phase-changing train is bought (Hardware) and blocks `PassTurn`; resolved before the cursor moves — never coincides with a turn opening |
| Derived actions | `nextDerivedAction` returns `null` while the home is owed (same shape as the discard line) |
| OR cursor | `settleOperatingCursor` unchanged; the placement is not a step |
| `turnGuardKey` | the placement emits no key |
| `CloseRoom` | passes, as under every hold |
| Ingress | fourth hold + `homePlacementRefusal` for the message itself (LEGALITY SYNC at the lock, S10-1's shape) |
| Delayed Auction (#905) | no effect: B&O's par/presidency grant does not float it |
| Herald home (#1302) | owes nothing; PRR on 18XX+ still operates from H12 without a token |
| LPF C&O two homes (#1325) | the choice is made at the first turn; either hex; reservation on both released by the placement |
| D&H free station | exempt from the home predicate; timing unchanged (the corporation's own Track step) |

### 5.6 Hex-validation note for S8-6

The sweep proves the corpus contains no off-home placement, so refusing one costs nothing historically. The
`kind: "dh"` placement shares the arm; the validation branches on `kind`. `city_index` legality reuses the per-circle
occupancy reader rather than `homeReservedCityIndex` alone (Erie may take either free circle).

### 5.7 S8-12 disposition

**Absorbed into Slice 8.2.** The ingress hold cannot be written before the hold's new definition exists, and the two
must share one predicate (`homeStationHold(state, msg)` in a new `homeStationAuthority.ts`, consumed by the reducer,
`turnRefusal` and `nextDerivedAction`). The R74-C "dead entry" symptom disappears with it. Replay: refusal-added at
ingress only.

### 5.8 S8-13 — newly proven defect

`applySandboxActionAfterAuction` runs the chart step before the core. `stockSaleRefusal` (the chart's `saleRefused`)
does not include any hold, so a `SellStock` under the home hold moves `market_positions` while the core refuses the
sale: **server/JUNO-FCJ 904, 911, 918, 932** (N&W floated at 902; each entry changes `market_positions` and nothing
else). Under the current model this is reachable in live play (a sale sent while another corporation's float is being
witnessed). Under the new model the SR-time hold no longer exists, and the four holds move in front of the chart step
so the shape cannot recur for any hold. Replay-semantic for FCJ (the four price moves disappear) — part of the bump.

---

## 6. S8-10 — Mohawk & Hudson exchange

### 6.1 Rule

p. 27: "A player owning the MH may exchange it for a 10% share of the NYC from the bank or the bank pool, provided he
may hold another share of the NYC and there is a NYC share available in the bank or the pool. The exchange may be made
during the player's turn of a stock round or between the turns of other players or railroads in either stock or
operating rounds. This action closes the MH." §5.1 note: the NYC share so obtained "cannot be sold until the
president's certificate has been purchased" (already enforced by 7.2's unparred-sale rule; not duplicated).
"Provided he may hold another share" is §4.3 in full: the 60 % per-corporation cap **and** the overall certificate
limit (with its zone exemption).

### 6.2 What the ledger says vs what is wrong today

Ledger S8-10: "always takes the IPO share before the pool … add `source`". The message **already carries `source`**
(`messageSchema.ts` `ExchangePrivate.source: "enum:Ipo|Bank"`), chosen by the client's `resolvePrivateExchange`
(IPO first, then pool). The real defects are in the arm (`sandboxSession.ts` ~4428) and at ingress:

| Question | Today | Rule |
|---|---|---|
| Who may initiate | ingress: the private's owner named in the message (`roomMessageRefusal` 464); reducer: nobody checks | owner only ✓ (ingress) — reducer must also ask |
| Timing window | none anywhere (the message is sandbox-only, seat-exempt) | own SR turn, or between turns in SR/OR; **not** during another player's SR turn in progress (that is not "between turns"), not while a hold stands, not during the auction, not after GameEnd. **R1 (§0): the server has no persistent between-turns state — an off-turn request made while a turn is underway is QUEUED and executes at the next legal boundary after revalidation; holds first; no transition-time prompt** |
| Source priority / choice | client picks IPO first; reducer applies the message's `source` and clamps with `Math.max(0, …)` — **an empty pile mints a share** | the owner chooses bank (IPO) or pool; either must physically hold a 10 % certificate. **R2 (§0): ruled — owner's choice when both are legal; only the legal source offered otherwise; no silent IPO-first** |
| Ownership limits | client checks 60 % only; reducer checks nothing | 60 % cap and the certificate limit (zone-exempt), via `sharePurchaseBlock`'s existing rules |
| Corporation | message-carried `company_id`; reducer trusts it | always NYC (`PRIVATE_EXCHANGES[4]`) |
| `keep_open` | on the wire; a client could keep the M&H open | the exchange closes the M&H; `keep_open` is the C&A grant's flag and must be refused on an M&H exchange |
| Float threshold | not applied (`applyFloatThreshold` runs only in the `BuyStock` arm) | a share leaving the IPO counts toward 60 % (§5.3); **corpus: 3XD 288 takes NYC's IPO 50 → 40 without floating it** — floats one entry later on 289's purchase |
| Presidency | `settlePresidencies` not called | §5.4 "immediately": an exchange that lifts the holder above the president transfers the presidency (helper of §4.3) |
| SR activity markers | none touched (no `markTrader`, no `turn_action_taken`, no seat change) | **R1 (§0): ruled — a free interjection:** no purchase consumed, no `bought_this_turn`, no Sell-Buy-Sell stage change, no pass-streak change, no Priority Deal move, no seat move, not the turn's action |
| Replay | the arm is deterministic given the message | fine once legality is re-derived from the board |
| Server authorization vs reducer legality | ingress owner check only; no `exchangeRefusal` | ingress must ask the same predicate the reducer asks (LEGALITY SYNC) |

### 6.3 Frozen design

`privateExchange.ts` gains `privateExchangeRefusal(state, msg, actor): string | null`, asked by the reducer (identity
refusal, ahead of the arm) and by `turnRefusal` in the sandbox-only branch (as `SetBoPar` is):
1. private 4, open, owned by `msg.player`, and `actor === msg.player` when an actor is known;
2. `company_id` is NYC's; `keep_open` absent or `false`;
3. window: `current_round_type ∈ {StockRound, OperatingRound}`; no hold standing (discard / funding / offer / home);
   in a Stock Round, the actor is the seated player **or** no player's turn is in progress (`turn_action_taken ===
   false` and `stock_turn_stage` unset for the seated player) — "between turns"; in an Operating Round, any time
   (between corporation actions is the rulebook's grain; a finer "not mid-step" rule is not derivable from the log
   and is not proposed);
   > **Superseded by owner ruling R1 (§0), 2026-09-16.** The "in an Operating Round, any time" reading above is withdrawn.
   > The approved model: immediate execution on the owner's own Stock Round turn or at a genuine server-visible turn
   > boundary; otherwise a **pending M&H exchange request** is recorded (never executed mid-turn, never interrupting the
   > actor, never prompting at a transition), executed automatically at the next legal between-turns boundary after the
   > whole exchange is revalidated against the authoritative board, and retired cleanly if no longer legal. Mandatory
   > holds and atomic resolution (discard, funding, pending bilateral offer, home obligation, any other hold) settle
   > first. Slice 8.4 proposes the smallest deterministic state addition if the boundary cannot be identified without
   > one.
4. `source` names a pile holding ≥ 10 %; the holder's NYC after the exchange ≤ 60 % and within the certificate limit
   (`sharePurchaseBlock` rules 1–2 reused with the exchange treated as a 10 % arrival from `source`).

The arm then: `applyPrivateExchange` (existing), then `applyFloatThreshold` (moved out of the `BuyStock` arm into a
shared `settleFloat` used by both), then `settlePresidencies` with the seating. No seat change, no pass-streak change
(R1: none of `bought_this_turn`, `stock_turn_stage`, `turn_action_taken`, Priority Deal, the seat or the streak moves).

### 6.4 State-machine simplicity

Straightforward once §5 has removed the SR-time home hold (the only thing an off-turn exchange could collide with)
and §4 has frozen the helper. **Opus-safe** — with one exception in §6.7. *(R1 ruled the default — an interjection —
so the exception does not arise; the queued off-turn request of §0 R1 adds a pending-request lifecycle, still Opus
under the owner's model policy.)*

### 6.5 Replay

`source` is already on every stored entry (3XD 288 `Ipo`), so no default is needed. Refusal-added for hand-built
entries; replay-semantic on 3XD 288 only (NYC floats at 288 instead of 289 — transient, identical from 289). Part of
the bump.

### 6.6 UI parity

**LEGALITY SYNC** (the panel already asks `resolvePrivateExchange`; it must ask the new predicate so a refused
exchange is never presented as live) + **NEW ACTION** only if the owner rules the pool choice must be offered (the
panel currently picks IPO first silently — the rulebook lets the owner choose) + **RULES REFERENCE** (timing window).
Filed as U-35 (§13). **After R1 / R2 (§0):** NEW ACTION is required (source choice when both piles hold a legal
share); **STATE VISIBILITY** — a queued exchange needs an immediate requester-facing acknowledgment and a table-visible
pending indication that persists until execution or cancellation (exact presentation TBD; not the Activity Log alone).
**RULES REFERENCE / GOTCHA** (owner, 2026-09-16) — queuing vests nothing: the queued request is revalidated in full at
settlement, so e.g. a first 5-train bought before the next between-turns opening closes the M&H and the request expires
with no NYC share (§0 R1); **STATE VISIBILITY** for the queued → executed / canceled status.

### 6.7 Owner rulings required

> **Both ruled 2026-09-16 (§0).** R1: the interjection default, plus the queued off-turn timing model. R2: yes — the
> owner chooses the source when both piles hold a legal share.

- **R1.** Does an exchange made *during the owner's own Stock Round turn* consume that turn's purchase (§5.2's one
  certificate), and does it count as an action for the pass streak / Priority Deal? The rulebook is silent. Proposed
  default: **it is an interjection** — it never consumes the purchase, never touches the pass streak or the seat, and
  is therefore identical whether taken on-turn or between turns (the simplest deterministic rule, and the one 18xx
  implementations generally use). If the owner prefers "counts as the turn's buy", the arm must set
  `turn_action_taken` / `bought_this_turn` and the Sell-Buy-Sell stage, and that is a Fable question because it
  touches the seat machine.
- **R2.** Must the client offer the pool when both piles hold a share (rulebook: "from the bank or the bank pool" —
  the owner's choice)? Proposed: yes, one extra option in the flow modal (NEW ACTION, cheap).

---

## 7. Remaining Stage-8 items

- **S8-8 residual** (`priceOf` `?? 67`, `sharePriceFor`): rule — an unparred share has no price; machine — the
  fallback exists but no sale path reaches it on a pinned board (7.2 rules 4–5); authority §5.1 p. 15; not
  reproducible as a defect; no interaction; **complexity trivial** (delete the fallback and let the emergency
  projection skip unparred corporations explicitly). Opus, Slice 8.5.
- **S8-11**: not defects; no action.
- **S10-17 / S10-18 / S10-21** cross-references: closed or moved by the slices above (S10-21's Z6C characterization
  changes again — §8).

No other open S8 item exists in the ledger.

---

## 8. Prospective corpus / replay divergence table (home timing, with and without the adapter)

Definitions: *field-first* = first entry whose board differs in any field; *gameplay-first* = first entry whose
acceptance or effect differs. "Adapter" = the legacy deferral of §9.

| File | Applied SR placements | field-first | gameplay-first **with** adapter | gameplay-first **without** adapter (freeze at the first turn) | Notes |
|---|---|---|---|---|---|
| golden/server/export **JUNO-CV4** | 20 B&O (I15), 59 C&O (F6) | **20** (`station_token_hexes`, `station_tokens` absent until 27 / 72) | **none** — B&O's token is supplied after 26 (the SR-closing pass) and before 27 (`LayTile` by B&O); C&O's after 71 and before 72; no entry in between touches I15 / F6; PRR is a herald home | **27** — every remaining entry a no-op; the golden, `replayJunoCV4`, `gameHistory`, `roundReplay`, `accolades`, `gameOutro` all lose their completed game | the goldens' per-entry digests change at 20–26 and 59–71 → **re-baseline with reason** |
| **server/JUNO-CW7** | 27 B&O, 50 B&M | 27 | none (first turns 58 / 65; 7 OR entries between B&M's placement and its turn, none touching E23) | 58 | `batch75Closure` pins CW7's `offer_serial` only |
| **server/JUNO-FCJ** | 49 B&M, 53 B&O | 49 | **903** — N&W floated at 902 no longer freezes the SR; 903 → 1105 apply on the log-derived board; the four S8-13 chart moves (904 / 911 / 918 / 932) become real sales; N&W's recorded choice (689, L16) is supplied at its first turn; 83 (7.2) still precedes everything | 70 (B&M) | no test replays FCJ past 96 |
| **prefix/JUNO-FCJ-96** | 49 B&M, 53 B&O | 49 | none through 95 (B&M's turn at 70 is supplied; B&O's first turn is beyond the prefix, so the **final board lacks B&O's I15 token**) | 70 | `stationLegality.test.ts` reads the prefix — check whether it pins B&O's token |
| **server/JUNO-G6J** (28 entries, no OR) | 23 C&O, 25 B&O | 23 | none within the log; final board lacks both tokens | n/a | golden G6J is 10 entries (auction) — unaffected |
| **export/JUNO-3XD** | 25 PRR (H12), 27 B&O | 25 | **288** (S8-10: NYC floats on the exchange; transient) then **290** — NYC floated at 289 no longer freezes SR 11; 290 → 321 apply; NYC's recorded choice (213, E19 circle 0) would be supplied at its first turn, which the log does not reach | 36 (B&O) | `replayJuno3XD` re-pins likely (its cursor/filed tables run to the end) |
| **export/JUNO-QVC** | 16 B&O, 18 PRR, 24 C&O | 16 | none (first turns 28 / 37 / 43; no home-hex touch in between) | 28 | pinned by `batch75Closure` (`offer_serial` only) |
| **server/JUNO-Z6C**, **fixture Z6C-494** | none applied on the v5 board (32 was sent with B&O un-floated by the 7.3 cascade) | **34** | **34** — the 7.5 freeze lifts: B&O floated at 33 owes nothing in SR 1, so 34 onward apply; at B&O's first OR turn the recorded choice (32, I15) is supplied and the game continues on the 7.1/7.3-cascaded board. How far it gets (whether the Yellow Sign at 203 is reached) is measurable only at implementation | same (freeze at B&O's first turn) | `gameHistory` "JUNO-Z6C under version 5" characterization **must be re-pinned**; S10-21's note updates; `moneyConservation`'s Yellow Sign corpus list may repopulate |
| 7NZ ×2, TQQ, JJD, 8E8, golden G6J | no float | identical | identical | identical | — |
| export/JUNO-Y8V | — | — | — | — | replays to **zero entries** under the corpus loader (its export carries no `id`, so `effectiveActions` kills every row once a `RevertTo` exists). Contributes no evidence; unchanged by anything |

Route / station legality: unchanged everywhere — no entry runs through, tiles, or tokens a home hex between a float and
the first turn. OR order: unchanged everywhere (queue membership and prices are the same at every opening).

**Reading of the table.** With the adapter, the whole corpus is gameplay-identical except where the *old* hold was
freezing a log that the rulebook says should continue (FCJ 903, 3XD 290, Z6C 34) — those are corrections, not costs.
Without the adapter every completed-game fixture dies at the first OR turn of the first floated corporation, which
would remove the only completed game the suite has (CV4, re-homed there by 7.5).

---

## 9. Replay strategy for the home transition — recommendation

Options considered: (i) engine-version bump alone; (ii) legacy replay adapter; (iii) deliberate historical
incompatibility; (iv) rewriting stored logs (forbidden by policy and not considered).

**Facts that decide it.** Every one of the 18 corpus files is **unpinned** (no `rules_engine_version` in any
`SetupGame`); they are admitted only under `DEVELOPMENT_CORPUS_POLICY` and are refused by the server today already.
There is **no pinned version-5 production log** anywhere in the repository. So a bump makes *no* difference to how the
corpus is treated, and "deliberate incompatibility" for pinned v5 logs happens automatically with any bump
(`SUPPORTED_RULES_ENGINE_VERSIONS = [RULES_ENGINE_VERSION]`, D-9) — there is nothing to decide there.

**Recommendation: (ii) + (i) — a development-corpus-only deferral adapter, under the Stage-8 bump.**

> **Owner ruling R3 (2026-09-16): approved** in the "last recorded choice on a legal home hex" form, with one binding
> constraint — the remembered choice is data only, and the synthetic first-turn placement must pass the **current**
> authoritative home-placement predicate on the then-current board; an obsolete / now-illegal choice is never forced
> through (no placement is synthesized and the normal home hold stays in force). Development-corpus-only; never
> production compatibility. The CV4 field-only re-baseline and the Z6C / 3XD corrections are accepted (§0).
`ReplayPolicy.legacyHomeTokens?: "refuse" | "defer-to-first-turn"` (development corpus: `"defer-to-first-turn"`;
server: `"refuse"`), implemented in `replayLog`'s loop beside `legacyExcessTrains`:

- when a legacy entry `PlaceHomeStation{kind: "home"}` is refused by the version-6 reducer as untimely and its hex is
  on the corporation's home (`homeHexesFor`), the loop **remembers** `{company_id, q, r, city_index}` as the
  president's recorded choice — it appends nothing; a later stored entry for the same corporation replaces the
  memory (the last recorded choice wins);
- after every apply (stored or synthetic), if the operating corporation owes its home and a choice is remembered for
  it, the loop applies one synthetic `PlaceHomeStation` through the same arm, authored by the president, exactly as
  the synthetic `DiscardTrain` is applied; `RoomEngine` never sees it as a log entry;
- the memory is **data the players wrote**, not a reinterpretation: the hex is forced for every single-home
  corporation and only the circle (Erie) or the hex (LPF C&O) is a choice, and the corpus records that choice at
  every float — including the three the version-5 cascades un-floated (Z6C 32, 3XD 213, FCJ 689), which is what lets
  those logs continue past their first OR turn instead of freezing there. A placement stored off the home hex (none
  exist) is not remembered; a corporation with no recorded choice (only a herald home or a log that ends at the
  float, server/G6J 29) is held exactly as a live room would be. Stricter alternative for the owner: remember only
  entries the version-6 board shows as floated at the time — that keeps Z6C / 3XD / FCJ frozen at their first OR
  turn and buys nothing the corpus needs.

This is the 4.6 precedent in shape and in policy (D-9: best-effort, development-only, never production). It is not
"compatibility to keep old logs green": the version-6 reducer refuses an SR-time placement outright, the corpus is
replayed under the correct rule, and the historically chosen hex / city (Erie's slot, C&O's LPF hex) is carried as
*data* rather than invented. The alternative would cost the suite its only completed game.

**Version strategy (question 10): A — one bump, 5 → 6, at Stage-8 closure (a Batch 8.5 in 7.5's shape).** Every
Stage-8 slice is replay-semantic, the corpus shows the slices do not interact in stored play (order and presidency
repairs move nothing; the home move changes fields at 8 indices and gameplay only where the old hold froze a log; the
exchange moves 3XD 288 transiently), and there is no pinned log at any intermediate level for a separate bump to
protect. A separate bump for the home transition (B) would create a version 6 that no stored log carries and a
version 7 that refuses it — two refusals of nothing. B would be right only if a pinned production log existed
between the slices; none does and none should be dealt on a partially-hardened Stage-8 tree. `RULES_ENGINE_VERSION`
is **not** changed in this pass.

---

## 10. UI parity classification (Batch-7 vocabulary) — recorded in Part C as U-32 … U-36

| Change | Classification | Part C |
|---|---|---|
| Home-token prompt moves from the Stock Round to the start of the corporation's first OR turn; the SR no longer waits; the Activity Log says whose home is owed and why the turn cannot proceed | STATE VISIBILITY + LEGALITY SYNC (every control of the operating president disabled by the hold; other seats unaffected) + RULES REFERENCE (§6.3.1 wording; "placed when the corporation floats" removed) | **U-32** |
| Erie either-city choice (and LPF C&O either-hex) at the first turn; NYC / Erie need no tile | STATE VISIBILITY (the prompt offers the free circles) + LEGALITY SYNC (`homePlacementRefusal` drives the lit circles) | U-32 |
| OR order display changes dynamically for not-yet-operated corporations; the "operated" stack stays the prefix | STATE VISIBILITY (turn-order strip and market-token stacks re-render from the settled queue; no new control) | **U-34** |
| Presidency transfer: clockwise tie-break | STATE VISIBILITY (log line names the rule) + RULES REFERENCE (§5.4) | **U-33** |
| M&H exchange: timing window, pool choice, refusal reasons | LEGALITY SYNC (+ NEW ACTION if R2 = yes) + RULES REFERENCE | **U-35** |
| Ingress home hold / exchange legality at the lock | NONE for the shell (S10-1's refusal transport already carries the sentence) | — |
| Sold-out rise order, chart-before-hold (S8-4 / S8-13) | NONE | — |
| `priceOf` fallback removal (S8-8 residual) | NONE | — |

No competing UI document is created; Part C is the one list.

---

## 11. Implementation slices (in order)

### Slice 8.1 — Operating queue authority (S8-1, S8-3, S8-4) — **Opus** (owner model policy, §0; was "Fable High") — **IMPLEMENTED 2026-09-16, uncommitted (§2.8)**
- Ledger: S8-1 → RESOLVED, S8-3 → RESOLVED, S8-4 → RESOLVED; S10-18's rise-order gap closed.
- Invariant: §2.5 (1)–(6). One settle point, frozen prefix, dynamic tail, membership fixed at open.
- Files: `operatingOrder.ts` (export the comparator; `settleOperatingQueue`), `sandboxSession.ts`
  (`applySandboxActionInner` — settle after rises and par reconcile; `settleRoundTransitions` — remove the #746a
  overlays; `beginOperatingRound` unchanged), `soldOutRise.ts` (riser order), `stateDigest.ts` (no field change).
- Replay: replay-semantic (queue field); corpus digest-identical (§2.3) — no re-pin expected; bump owed at 8.5.
- Tests: `operatingQueueSettle.test.ts` (hand-built boards: rise reorders two corporations at the opening; column-tie
  decided on the risen cell; forced sale during an OR moves a queued corporation ahead/behind; operating corporation's
  own dividend never displaces it; operated prefix immutable; float-between-turns not inserted; derived key stable);
  `soldOutRise.test.ts` two risers one cell; corpus sweep asserting digest identity to the 7.5 baseline.

### Slice 8.2 — Home station authority (S8-5, S8-6, S8-12, S8-13) — **Opus** (owner model policy, §0; was "Fable High"; R3 ruled)
- Ledger: S8-5 → RESOLVED, S8-6 → RESOLVED, S8-12 → RESOLVED, S8-13 → RESOLVED; S10-17's `PlaceHomeStation` row
  closed; S10-21 updated (Z6C characterization re-pinned).
- Invariant: §5.4 obligation-on-cursor; hold turn-local and in front of the chart step; placement legality 1–5;
  reservation unchanged; seat untouched by the placement; derived loop silent under the hold; ingress mirrors the hold
  and the placement predicate.
- Files: new `homeStationAuthority.ts` (`homeStationOwed`, `homeStationHold`, `homePlacementRefusal`);
  `homeTokenGate.ts` (retired or delegating); `sandboxSession.ts` (`pendingHomeTokens` narrowed; `BuyStock` arm #769
  removed; `placeHomeStationToken` #769a removed, `kind` branch, no seat advance; holds moved to
  `applySandboxActionAfterAuction`); `turnAuthority.ts` (fourth hold; placement legality in the sandbox-only branch);
  `derivedActions.ts` (null under the hold); `replayLog.ts` + `rulesVersion.ts` (`legacyHomeTokens` adapter,
  `DEVELOPMENT_CORPUS_POLICY`); `stationTokens.ts` (circle reader for untiled printed cities if missing);
  `HomeStationPrompt.tsx` / `App.tsx` only insofar as they read `pendingHomeTokens` (no UI work in the slice beyond
  compiling).
- Replay: replay-semantic; corpus per §8 — CV4 goldens re-baselined (field-only, with reason), Z6C characterization
  re-pinned, `replayJuno3XD` tail re-pinned, FCJ prefix checked; bump owed at 8.5.
- Tests: `homeStationAuthority.test.ts` (SR float owes nothing and advances the seat; first turn owes; hold refuses
  every message and derives nothing; placement on the wrong hex / occupied circle / second placement / herald / not
  operating refused; Erie either free circle; untiled E11/E19 accepted; D&H kind exempt; hold before the chart step —
  a held `SellStock` moves no token; RevertTo before/after; ingress sentence equals reducer sentence); adapter test
  (a legacy log with an SR placement replays to a board whose first-turn token equals the stored choice; an
  unfloated-at-the-time placement is not remembered); corpus sweep asserting the §8 table.

### Slice 8.3 — Presidency tie-break (S8-2) — **Opus** (design frozen in §4.3)
- Ledger: S8-2 → RESOLVED; S10-18's tie gap closed.
- Invariant: strictly-more to challenge; among tied top challengers, closest clockwise from the incumbent; forced-sale
  projection agrees with settlement.
- Files: `presidencyTransfer.ts`, `emergencyFunding.ts` (441), callers' signatures, tests.
- Replay: replay-semantic only on a tie; corpus identical.
- Tests: §4.3 cases + one LPF double-certificate case.

### Slice 8.4 — M&H exchange authority (S8-10) — **Opus** (R1 / R2 ruled, §0: interjection + queued off-turn request, owner's source choice)
- Ledger: S8-10 → RESOLVED (rewritten finding).
- Invariant: §6.3 predicate at both locks; float settles; presidency settles; no seat/streak change (under the R1
  default); `keep_open` refused; empty pile refused (no mint).
- Files: `privateExchange.ts`, `sandboxSession.ts` (arm + shared `settleFloat`), `turnAuthority.ts`, `App.tsx`
  dispatch (predicate only), tests.
- Replay: 3XD 288 transient (float one entry earlier); bump owed at 8.5.
- Tests: window cases (own SR turn, between SR turns, mid-OR between actions, during a hold → refused, during the
  auction → refused), both piles, empty piles, 60 % cap, certificate limit with zone exemption, float on exchange,
  presidency on exchange, `keep_open` refused, ingress parity.

### Slice 8.5 — Stage-8 closure — **Opus**
- Ledger: Part E row 6; S8-8 residual fallback removed; Part C U-32 … U-35 statuses confirmed as filed.
- `RULES_ENGINE_VERSION` 5 → 6, `RULES_ENGINE_CHANGELOG` row, `SUPPORTED_RULES_ENGINE_VERSIONS` follows;
  corpus reconciliation in 7.5's format (every re-pin with index and reason); the matrix / static audits (exhaustive
  hold × message × round matrix for the four holds; placement legality matrix; exchange window matrix).

Order rationale: 8.1 first because it is corpus-neutral and de-risks the cursor; 8.2 second because it owns the only
adapter and the only re-pins; 8.3 and 8.4 are mechanical once 8.2 has removed the SR-time hold; 8.5 bumps once.
This is Part F's existing order (S8-1 → S8-4 before S8-5 … S8-10).

---

## 12. Model assignment summary

> **Owner model policy (2026-09-16, §0): Opus is the default for every Stage-8 implementation slice.** Escalate to Fable
> only for a specific, traced architectural ambiguity with materially different valid solutions. The design pass's
> original assignments are kept in the last column for the record.

| Slice | Model | Why | Design pass's original proposal |
|---|---|---|---|
| 8.1 queue authority | Opus | frozen representation (R4); one settle point | Fable High |
| 8.2 home authority | Opus | model frozen in §5; adapter ruled (R3) | Fable High |
| 8.3 presidency | Opus | selection rule frozen (§4.3); mechanical | Opus |
| 8.4 M&H exchange | Opus | predicate frozen (§6.3); R1 / R2 ruled, queued request per §0 | Opus (Fable only if R1 ≠ default) |
| 8.5 closure + matrices | Opus | mechanical bump, sweeps, matrices | Opus |

---

## 13. Part C entries filed by this pass (verbatim as added to the ledger)

- **U-32** (S8-5 / S8-6 / S8-12 / S8-13) Home station at the first OR turn — STATE VISIBILITY + LEGALITY SYNC +
  RULES REFERENCE.
- **U-33** (S8-2) Presidency clockwise tie-break — STATE VISIBILITY + RULES REFERENCE.
- **U-34** (S8-1 / S8-3 / S8-4) Dynamic operating order — STATE VISIBILITY.
- **U-36** (S8-4 / #1211; filed by Slice 8.1) The sold-out-rise Activity Log line narrates from the post-commit chart —
  STATE VISIBILITY.
- **U-35** (S8-10) M&H exchange window and source — LEGALITY SYNC + RULES REFERENCE (+ NEW ACTION under R2); after the
  owner's R1 / R2 review: NEW ACTION (source choice), RULES REFERENCE / GOTCHA (a queued exchange vests nothing — a first
  5-train bought before it settles closes the M&H and the request expires) and STATE VISIBILITY (queued → executed /
  canceled).

---

## 14. Owner rulings genuinely required before implementation

> **All four ruled by the owner on 2026-09-16 — see §0 for the binding text.** R1: interjection + queued off-turn
> timing model; R2: owner's source choice; R3: the adapter, last recorded legal home choice, data only, current
> predicate; R4: frozen membership + frozen prefix + dynamic tail.

1. **R1 (Slice 8.4)** — whether an M&H exchange taken during the owner's own Stock Round turn consumes the turn's
   purchase / counts for the pass streak. Proposed default: an interjection that consumes nothing (§6.7).
2. **R2 (Slice 8.4)** — whether the client must offer the Bank Pool as an alternative source when both piles hold a
   share. Proposed: yes.
3. **R3 (Slice 8.2)** — the home move itself is ruled by the Stage-8 brief; confirm the development-corpus deferral
   adapter (§9) is acceptable under D-9, choose between "last recorded choice on the home hex" (recommended) and the
   stricter "only placements floated on the version-6 board", and accept the CV4 golden re-baseline (field-only,
   tokens absent between float and first turn) and the Z6C / 3XD re-pins as expected consequences.
4. **R4 (Slice 8.1, confirmation only)** — confirm model (a) (frozen prefix, dynamic tail) over the operated-set
   representation; no rulebook question is open.

Nothing else in Stage 8 needs a ruling: S8-2's rule is printed; S8-6's is printed; S8-12/13 are engineering.

---

## 15. Things this pass did not do

No gameplay code, no version change, no re-pin, no golden touched, no full suite. The owner's unrelated UI/audio work
in the working tree was not inspected beyond `App.tsx`'s home-prompt and exchange dispatch sites named above.
`_to_delete/__stage8_sweep.test.ts` and `_to_delete/stage8_sweep.json` are the pass's only artefacts besides the two
documents.

## 16. Ledger edits made by this pass (`RULES_HARDENING_BACKLOG.md`)

S8-1 (corpus status under v5 + overlay proof), S8-2 (exchange-arm gap cross-reference), S8-3 (cross-reference),
S8-5 (owner ruling recorded; status DEFERRED → OPEN; corpus facts), S8-6 (corpus: no off-home placement; D&H shares
the arm), S8-10 (finding rewritten to the actual defect; 3XD 288), S8-12 (absorbed into the home slice), **S8-13 new**,
S10-21 cross-reference, Part C U-32 … U-35. No item marked RESOLVED.
