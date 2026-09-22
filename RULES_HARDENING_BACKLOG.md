# Rules-hardening backlog — the living ledger

**Purpose.** The single durable source of truth for everything the rules-hardening sequence found and did not
finish: deferred findings, confirmed bugs, deliberate rule deviations and owner decisions, and later-stage work.
It replaces re-reading the batch write-ups and the retired triage documents. Opened 2026-09-15, seeded from
`AUDIT_RULES_TO_MACHINE_2026-09-13.md`, the Batch 1 / 1.1 / 2 / 3 / 4 / 4.5 / 4.6 / 5 write-ups and commit
messages, and the triage / UI / tech-debt / handoff documents of 2026-09-05 → 09-08 (reconciled and, where
proposed for deletion, migrated here in full — Stage 5.5).

**Standing rule (owner, 2026-09-15): every batch updates this ledger before it is committed.** Add newly
discovered deferred work; mark completed items `RESOLVED` (with the batch and design note that closed them —
never delete them); record every deliberate rules deviation or owner decision under Part D; never drop an item
merely because its batch ended. The batch write-up may summarise; this file is the record.

**Standing rule (owner, 2026-09-15, UI parity): every engine-hardening item, when resolved (Stage 7 onward, Stages
8–10 included), is classified by its frontend consequence — `NONE` / `LEGALITY SYNC` / `NEW ACTION` /
`STATE VISIBILITY` / `RULES REFERENCE` — in its batch write-up, and every non-`NONE` result becomes a Part C entry
linked to its S-item. See Part F's Playtest Readiness gate.**

**Status vocabulary.** `OPEN` — a confirmed defect or rule gap, not yet scheduled beyond its stage. `DEFERRED` —
known, scheduled for a named stage, or blocked on a decision. `OWNER DECISION` — a deliberate deviation from, or
interpretation of, the 2018 rulebook (or a product ruling), recorded so it is never mistaken for a bug.
`RESOLVED` — closed; the entry says by what.

**The roadmap (canonical numbering, owner 2026-09-15).** Items below are filed by the stage that owns them.

| Stage | Name | Status |
|---|---|---|
| 1 | Engine boundary + baseline | done (`6e600f7`, `2556102`) |
| 2 | Socket schema + authorization | done (`dca00bb`) |
| 3 | Operating authority + station legality | done (`c9d5974`) |
| 4 | Train lifecycle / forced purchase | done (`53222c7`) |
| 4.5 | Replay / rules-version pinning | done (`2aefe13`) |
| 4.6 | Interactive excess-train discard | done (`6d55b84`) |
| 5 | Emergency funding + bankruptcy | done (`78f8358`) |
| 5.5 | Repository hygiene / backlog reconciliation | done (`b4f6d38`; this ledger) |
| 6 | Route authority + revenue | implemented (Batch 6, #1550–#1554), awaiting full-suite validation and commit |
| 7 | Transaction + cash authority / auction | done in five slices — 7.1 `08a59ec` (money ledger), 7.2 `a927e5f` (stock / par), 7.3 `d0a0792` (auction), 7.4 `6ecdfb1` (offers, consent, replay-safe settlement identity); **7.5** (`RULES_ENGINE_VERSION` 4 → 5, replay / golden / corpus reconciliation — `BATCH7.5_REPLAY_VERSION_CLOSURE_2026-09-16.md`, uncommitted, awaiting the owner's full-suite gate) |
| 8 | Stock / OR edge cases + timing | Part B — design pass done 2026-09-16 (`STAGE8_AUTHORITY_DESIGN_2026-09-16.md`: five slices 8.1 → 8.5, one 5 → 6 bump at closure); **owner rulings R1–R4 recorded 2026-09-16** (design §0, D-29 … D-32), **S8-14 ruled 2026-09-17** (design §0, D-33); Opus is the default model for every Stage-8 slice; **Slice 8.1 implemented 2026-09-16 — S8-1 / S8-3 / S8-4 `RESOLVED` (**committed `05b5dfc`**; design §2.8)**; **Slice 8.2 implemented 2026-09-16 — S8-5 / S8-6 / S8-12 / S8-13 `RESOLVED`; S8-14 `RESOLVED` 2026-09-17 by the owner's ruling (the tiled OO home hex, #1617) (**committed `efe4098`**; design §5.9)**; **Slice 8.3 implemented 2026-09-17 — S8-2 `RESOLVED` (#1620, design §4.4): `presidentFor(company, seating)` with §5.4's clockwise tie-break from the former president's seat, one ordering rule for settlement and forced-sale projection alike, corpus-neutral (18 logs / 3,131 entries / 7 presidency changes / 0 ties / 0 disagreements); S10-18's presidency-tie gap closed; **S8-15 `RESOLVED` 2026-09-17 by the owner's ruling** (the Scenario-D presidency exchange, #1622: two ordinary 10 %s where the successor has them, otherwise the other-20 card one-for-one for the President's Certificate, percentages unmoved either way); **S9-14 `RESOLVED` 2026-09-17 — absorbed into 8.3 by owner ruling** (#1624: V-7.2's 10 % exchange certificate must already be in the Bank Pool before a half-sale of the other-20, and a president who must first receive that card during a presidency transfer is subject to the same requirement — a sale cannot supply its own prerequisite); **S9-13 filed and left OPEN by the same ruling** (the chart walks one row per 10 %, not per certificate — Stage 9) (**committed `02a9838`**); **Slice 8.4 implemented 2026-09-17 — S8-10 `RESOLVED`** (#1630–#1634, design §6.8): the M&H exchange is an authority of its own (`mohawkExchange.ts`), a free player-initiated interjection that consumes no Stock Round purchase, seat, pass streak or Priority Deal, queued as `pending_mh_exchange` when the request arrives off-turn and settled — fully revalidated — at the next legal between-turn boundary, ahead of every `buildOperatingOrder` so an SR→OR float is never locked out of the round it just qualified for; the owner's source choice is never switched for them (**committed `fc5a575`**); **Slice 8.5 implemented 2026-09-17 — the closure pass (UNCOMMITTED, awaiting the owner's review and full-suite gate; design §17)**: `RULES_ENGINE_VERSION` **5 → 6** with changelog row 6 and the derived supported list, **S8-8 `RESOLVED`** (#1640, the last share-price nominal out of the 6.6.3 projection), the corpus reconciliation measured from HEAD under v6 (18 files / 4,105 stored / 3,103 applied / 1,131 reducer no-ops / deterministic 18 of 18 / 0 boards ending with a queued M&H request), the five closure matrices and eight static source audits (`stage85Matrices.test.ts`), and **S10-23 / S10-24 filed** by that auditing |
| 9 | Variants + map data + variant authority | Part B |
| 10 | Replay / settlement / release hardening | Part B |

UI/polish-only items are **not** forced into a numbered stage; they live in Part C (the UX backlog).

**Rulebook authority.** `en_1830re.html_Rules_1830-RE_EN.pdf` (Lookout Spiele, 2018 — the owner's local copy;
identical file at `lookout-spiele.de/upload/en_1830re.html_Rules_1830-RE_EN.pdf`). Section numbers are the
rulebook's. Owner-defined variants (~~Level Playing Field,~~ Project 18XX+, Delayed Auction, Gentle Rust,
Unpredictable Revenue / Yellow Sign) have no rulebook counterpart and are judged against the owner's spec.
**Corrected by Slice 8.2 (2026-09-16): the Level Playing Field is printed.** The full 48-page Lookout/Mayfair rulebook
(`1830 FULL RULES with variants.pdf`, repository root) contains it as Scenario D, S-1.0 "A Level Playing Field" (pp.
34–36; Table T-08, p. 47). **Source split:** the revised 2018 28-page rulebook is the Classic / base-game authority
wherever it covers the subject; the full 48-page rulebook is the printed authority for 1830+ / Scenario-D material the
revised book does not contain. An owner variation from printed Scenario D is recorded as its own item (S9-5 lists them),
never by labelling the whole scenario owner-defined. Scenario-D facts: `STAGE8_AUTHORITY_DESIGN_2026-09-16.md` §5.1a.

**Replay / version boundary.** `RULES_ENGINE_VERSION` (`frontend/src/gameEngine/rulesVersion.ts`, #1520) is
**7** after the Stage-9 closure pass (2026-09-19, #1680; 6 was Stage 8.5's). *(Historical note, kept as written:
it was)* **5** after Batch 7.5 (1 = post-Batch-4 semantics, 2 = Batch 4.6, 3 = Batch 5, 4 = Batch 6, 5 = Batch 7 — the one
bump deferred across 7.1–7.4 and landed in 7.5). Since
Batch 6 the pin is also copied onto the state (`rules_engine_version`, #1551) so the reducer can tell a pinned
board from a legacy one. Any item below that
changes what a stored gameplay log *replays to* must bump it and add a `RULES_ENGINE_CHANGELOG` line; UI,
protocol-shape and narration changes do not. `DEVELOPMENT_CORPUS_POLICY` (`legacyLogs: "development-corpus"`,
`legacyExcessTrains: "engine-chose-cheapest"`, and since Slice 8.2 `legacyHomeTokens: "defer-to-first-turn"`, D-31) is a
best-effort development-corpus mechanism only and is never a
production restore policy. Every item carries its own replay note.

**Where the other long-lived documents fit.** `AUDIT_RULES_TO_MACHINE_2026-09-13.md` is the rules audit this
sequence executes (its finding ids C1…m12 are cited below). `MIGRATION_PLAN.md` is the canonical record of the
client-replay → Node-authority → Juno-escrow migration and of the settlement track (Phases 2.5 / 3a / 3b / 3c /
4, order #1254); Stage 10 below indexes that work but does not restate its design. `docs/ai_architecture/` is
the design-note archive (`<file> #N`). `TECH_DEBT.md` is the cosmetic/colour register, cited from source.

---

## Part A — Completed stages (what each closed, and what it left behind)

### Stage 1 — engine relocation (`6e600f7`), Batch 1.1 (`2556102`)
`frontend/src/utils/` → `frontend/src/gameEngine/` (57 files, `git mv`), no rule change, `gameEngine/index.ts`
is the server's surface; #1500/#1501/#1502 closed the three React paths. Batch 1.1: #1447 the Sell-Buy-Sell
purchase counts as the turn's action; #1448 an OR nobody can operate does not open.
Left behind → S10-7 (engine tests in `utils/`, `shared/` package), S9-9 (board cluster), S6-1 (route
validators), S9-9's injection note.

### Stage 2 — runtime schema validation and the authorization boundary (`dca00bb`)
#1449 `gameEngine/messageSchema.ts` (shape only, never legality); #1450 the proposer of a private/train offer is
the *buyer's* president. Deferred by its own commit message → S9-1 (YellowSignEvent client-authoritative, HIGH),
the operating-identity gates (audit M3/M6 — closed by Stage 3), S10-8 (`UndoLastAction` vestigial).

### Stage 3 — operating-corporation identity + station legality (`c9d5974`)
#1510 `operatingIdentity.ts` (LayTile / PlaceStationToken / RunMultipleRoutes / RunManualRoute must name the
operating corporation; fails closed on an unresolvable cursor); #1511 `stationPlacementGate.ts` + per-circle
`evaluateStationPlacement`; JUNO-FCJ idx 95 root-caused (one illegal placement). Audit M6 closed; M3's identity
half closed. Reported, not fixed → S7-7 (`BuyPrivateCompany.protocol_id`), S7-8 (offers by a non-operating
corporation), S8-5/S8-6 (home-token timing and validation, M15), S9-1, S10-1 (refusal transport,
`actionWasRefused` vs the chart step). Replay: `replayJuno3XD` re-pinned 210 → 170 (idx 224 refused for
identity); FCJ diverges from 95 by construction.

### Stage 4 — train lifecycle (`53222c7`)
#1512 `trainAvailability.ts` (`purchasableTrains`, `cheapestPurchasableTrain` — depot ∪ Bank Pool, pool wins a
same-model tie); #1513 `trainObligationFor` / `trainObligationRefusal` (audit C4a); the emergency purchase
refuses when the president is short (C4c); trade buyer-limit gate; discards go to `returned_trains`; depot
remainders subtract the pool (phantom-stock fix). Audit M9 closed. Left behind → the president's discard choice
(closed by Stage 4.6), M14's remaining halves (S7-5), the Yellow-Sign ghost-expiry trim (S9-2). Replay:
JUNO-3XD idx 255 `returned_trains: undefined → ["3"]` (nothing pins it).

### Stage 4.5 — rules-engine version pin (`2aefe13`, #1520)
`rules_engine_version` stamped by the server into `SetupGame`; refused before replay when unsupported; legacy
(unpinned) logs refused by default, admitted only under `--legacy-logs development-corpus`. Flagged consequence:
the 8 rooms in `server/data/` are all legacy and are held by a default server. Left behind → S10-2 (`BUILD_ID`
nominal), S10-3 (no historical reducer bundle — by design).

### Stage 4.6 — interactive excess-train discard (`6d55b84`, #1530 / #1531), version 1 → 2
`DiscardTrain` by the president, §6.6.1 order via `buildOperatingOrder`, derived `pendingTrainDiscards`, the
hold, Bank-Pool integration; the depot gates now judge the limit *in force* (§2.0). #1531 added the missing
§6.0 "furthest up" key to `operatingOrder.ts`. Audit C6 and m1 closed. Recorded for later → **S8-1 (the
pre-sold-out-rise snapshot)**. Replay: JUNO-FCJ diverges at idx 474 (rule fix, C&O's first 5 now allowed);
`legacyExcessTrains` adapter supplies cheapest-first discards for legacy fixtures (3XD idx 255).

### Stage 5 — emergency funding, forced sales, bankruptcy, immediate game end (uncommitted, #1540 / #1541), version 2 → 3
Derived obligation `emergencyFundingFor`, authoritative president contribution, forced `SellStock` under
`forcedSaleRefusal` (§6.6.3), the emergency private sale as a directed offer, derived / declared bankruptcy →
`GameEnd` + `bankrupt_president`, bankrupt scoring (may win), the hold, the owner-defined trade simplification,
settlement-time revalidation of `AnswerFundingPrivateOffer(accept)`. Audit C4, M11, M12 closed; M13's phase
and band now exist as `privatePriceBand.ts` but are applied only to the *emergency* sale (see S7-6).
Recorded for later → **S8-2 (presidency tie)**, S7-6, S7-1 (`adjustTreasury` floor), D-5 / D-6 (the two owner
decisions). Replay: JUNO-Z6C differs from idx 614 (old engine applied a `PassTurn` on a `GameEnd` board; v3
holds it).

### Stage 6 — route authority + revenue (uncommitted, #1550–#1554), version 3 → 4
`gameEngine/routeAuthority.ts`: one evaluator (`evaluateRouteSet`) re-walks every submitted route on the board's
rail model (`trackSegments` / `trackReach` / `cityBlocking` / `sandboxRouteBreakdown`) and answers a legal run set
with authoritative per-train revenues or one refusal; `routeSetRefusal` is asked in `applySandboxActionCore` and
at ingress (`turnAuthority.operatingLegalityRefusal`), the arm prices from the evaluator's answer. Rules enforced:
train identity (owned, once, ≤ trains, model from the slot), continuity, no reversal / crossover change, no track
reused within or across the corporation's routes (cities and separate tracks of one hex may be shared), full cities
not run through, red areas terminal only, a station of the corporation on the route (by circle), no city twice
(the other city of a hex is allowed), ≥ 2 cities, ≤ the train's number (Diesel unlimited), one run per turn, at
the Run Trains step. `DeclareDividends.revenue_amount` must equal `last_route_revenue` (audit C1). A skip / end
of turn at Run Trains is refused while a paying route exists (pinned boards). `RunManualRoute` is refused on a
pinned board. Ingress schema checks the shape of `routes` / `trains` / `train_indices` (#1553). The LPF PRR
$60 → $30 defect was a shell filter (`endsOffTerminus` asked `isRouteTerminusHex` without the corporation, so
the route ending on the herald was dropped before dispatch, #1554). Found and fixed: the #1183 one-run key was
written on the corporation and read off the state — it never fired (S6-11). Audit C1, C2 closed.
S6-10 (towns are termini, per the rulebook — ruled 2026-09-15, #1555) and S6-3 (the highest-revenue
combination as a demonstrated lower bound — ruled 2026-09-15, #1556) closed in the same batch. Left behind → S6-13 (UI validators that
duplicate the authority), S6-4 (herald "must" clause), S6-3 (optimum), U-17 (bypass control). Replay:
JUNO-FCJ from 230, JUNO-Z6C from 418, JUNO-3XD from 260 (Part E); the CV4 golden fixture re-baselined for the
#1183 key's relocation only.

### Stage 5.5 — repository hygiene / backlog reconciliation (2026-09-15, this pass)
Inventory of every tracked planning/triage document, reconciliation of their unresolved items against code,
tests, the audit and the write-ups (migrated below as S6-1's route-drafting debts, S9-3, S10-9, S10-10,
S10-11, S10-12, S10-13, U-12 … U-18, D-13, D-14), a sweep of explicit code markers, and a cleanup proposal
(deletions only after owner approval). No gameplay change; `RULES_ENGINE_VERSION` untouched.
**Owner-approved outcome (2026-09-15):** `git rm` of `TRIAGE_2026-09-05.md`, `TRIAGE_2026-09-06.md`,
`TRIAGE_2026-09-08.md`, `TRIAGE_2026-09-08_JUNO-G6J.md`, `UI_ACTION_PLAN_2026-09-07.md`, `HANDOFF_2026-09-05.md`
(every unresolved item migrated to the ids above; git history keeps the text) and `frontend/testrun.txt` (stale
capture); `PLAYTEST_TRANSPORT.md`'s "not built yet" paragraph refreshed to the verified state (#1250 durable
log, #1253 reconnection, #1334 every-seat export). Kept: `frontend_blueprint.md` until S10-8,
`AUDIT_PART1/2` until S10-19. Committed separately from Batch 5 as the Batch 5.5 hygiene commit, after the
owner's full-suite result.

---

## Part B — Future stages: rules and authority work

Each entry: **Issue** · **Status** · **Stage** · **Rulebook** · **Notes / files** · **Replay** · **Detail for
implementation**.

### Stage 6 — Route authority + revenue

**S6-1. Routes are priced but never validated by the reducer.**
Status `RESOLVED` — Batch 6 (#1550, `gameEngine/routeAuthority.ts`; `routeAuthority.test.ts` 38 cases). Every
rule in the Detail below is enforced by `evaluateRouteSet` / `routeSetRefusal` in the reducer core and at
ingress, and revenue is the evaluator's. Drafting debt (a): the authority judges blocked cities by arrival edge
(`cityForArrival` / `stopEnteredFrom`); the shell's `routeBlockedCityReason` has judged by edge since #1022
wherever `App.tsx` injects the resolver (it does), so the "recorded as known debt" sentence in #730a is stale
prose, not a live gap. Debt (b): the reducer accepts either reading of a hex with a bow (`bypass: true` is
honoured wherever the rails offer one, whether or not the city is shut); the waypoint control is U-17. NOT done:
the UI validators were not moved to `gameEngine/routes/` — the authority reuses the rail primitives directly and
the shell keeps its click-by-click validators for drafting feedback; retiring the duplicated halves is S6-13.
Historical: audit **C2**, the largest remaining job. Rulebook §6.4, §6.4.1, §6.4.2. Notes: `RunMultipleRoutes`
arm (`sandboxSession.ts`; refuses only a Coal River crossing and a duplicate `revenue_turn`); validators exist in
the UI — `utils/runTrainsRules.ts`, `routeConnection.ts`, `routeWaypoints.ts`, `routeStep.ts`,
`routeTruncate.ts`, `routeDraftEdit.ts`, `stationConnectivity.ts` (Batch 1 §6b lists them, ~1,400 lines) and
`gameEngine/trackSegments.ts`, `cityBlocking.ts`, `cityBypass.ts`, `trackReach.ts`. Replay: refusal-added; the
corpus almost certainly contains routes the client validated — sweep and report every refused run; **bump**.
Detail: one `routeRefusal(state, grid, companyId, routes, trains)` in the engine, called in
`applySandboxActionCore` before the arm, refusing by identity. Rules to cover: a station of the corporation on
the route; ≥2 stops; capacity per named train (Diesel unlimited); no more runs than trains owned and each train
once (no double-heading); continuity; no reversal at a junction; no crossover change; no track reuse within or
across the corporation's routes (trains may meet at cities); red areas terminal only; full cities block
pass-through but not start/end (§6.3.3); a city entered and left on different track; different cities of one
hex count separately (pricing half already in the reducer, `cityVisitedAt`). Move the validators to
`gameEngine/routes/` in the same batch (doing the move alone leaves dead code). Tests: one refusal per rule on
the rulebook's p.22 example board (FE / FCBE / FIJ legal; FCG, FCBAD, DE, FEBCF, EFE, FED+FEH illegal).
**Two recorded drafting debts fold in here** (from the code-marker sweep, Stage 5.5): (a)
`utils/routeWaypoints.ts` `routeBlockedCityReason` judges interior blocked cities *by position*, not by arrival
edge, so on a two-city hex it refuses a legal route through the unblocked half ("recorded as known debt") — the
authoritative check must be edge-based (`cityForArrival`); (b) `gameEngine/cityBypass.ts` #808: a corporation
that *could* enter a city cannot choose the bypass by hand (the PRR skipping its own home to save a stop) —
needs a waypoint control; the reducer must accept either legal reading once it validates routes.

**S6-2. The dividend amount is trusted from the message.**
Status `RESOLVED` — Batch 6 (#1552, `dividendAmountRefusal`): the declared amount must equal
`last_route_revenue` to the dollar (absent amount = pre-#752 log, judged by the same field; the derived $0
withhold agrees by construction); refused by identity in the core and with its reason at ingress. Corpus
evidence found by the Batch-6 sweep: JUNO-Z6C 418 / 428 / 433 declared $180 / $290 / $250 on runs the reducer
had priced at $190 / $300 / $270 (LPF + Unpredictable Revenue; the client's figure, $10–$20 short each time) —
the message paid, the authority did not. Historical: audit **C1**. Rulebook §6.5. Notes: `DeclareDividends.revenue_amount` → `dividendSplit.ts`
(`dividendRevenue`); `last_route_revenue` written by `RunMultipleRoutes`; #752 chose the message so the toast and
the reducer share one figure. Replay: refusal-added; bump. Detail: refuse in `applySandboxActionCore` when
`Number(revenue_amount) !== Number(company.last_route_revenue)` (allow `"0"` when `routes_run_this_turn === 0`;
the forced $0 withhold #1275 is derived). Keep the field for narration. Tests: matching accepted; mismatched
refused; positive amount after no run refused. Historical instance (HANDOFF_2026-09-05 §6, migrated): JUNO-3XD
idx 318/319 ran the same routes twice (`printed_route_revenue` 270 → 540) and idx 320 declared $540; #1183 now
refuses the duplicate run but the declaration still pays the message's figure. That log is legacy (held by a
default server; dev-corpus only), so no `RevertTo` is owed — the fixture simply documents why C1 matters.

**S6-3. "Highest-revenue combination if demonstrated" is neither chosen nor checked.**
Status `RESOLVED` — **owner ruling 2026-09-15, #1556** (`routeAuthority.demonstratedShortfall`, inside
`routeSetRefusal`): the machine plays the demonstrating opponent. After a submitted set is judged legal and
priced, `maxRouteRevenueFor` (the deterministic `assignRouteSet` search, same fleet, same blocking / licence /
herald rules, same era) demonstrates a concrete legal combination; a set worth less is refused — "Route set
earns $40; a legal combination worth $60 is available." — in the core by identity and at ingress with the
sentence. A set worth as much or more is accepted, however the bounded search missed it (the search is a
lower bound, never a ceiling — `routeAutoTrace.ts` #892 / #8 document it losing to greedy). Compared on the
corporation's total (the rulebook's "combination"), printed figures both sides. The auto-tracer offers the same
set, so a normal client never meets the refusal; `routeSkipRefusal` (a paying route may not be skipped) was the
first half. Tests: `routeAuthority.test.ts` "the highest-revenue combination is a demonstrated lower bound"
(suboptimal refused with the figure; equal accepted; a legal hand-drawn route the tracer cannot find — a
crossover crossed twice — accepted above a $0 search; total not per-train; fleet and blocking honoured; replay /
`RevertTo` / room restore deterministic). Corpus: four legacy logs held runs short of the demonstration — see
Part E (JUNO-CV4 98, JUNO-Z6C 140 / 172, JUNO-3XD 175). Performance: S6-14. Detail: owner ruling
whether the machine enforces the optimum; if not, record as an owner decision in Part D.

**S6-4. LPF / 18XX+ PRR herald-home (Altoona, H12, $10) revenue and reach — verify the authority with S6-1.**
Status `DEFERRED` (variant). Batch 6 preserved the herald's existing rules in the authority without auditing
them: it is a station root, a revenue centre and a terminus for its owner only, and its owner may cross it
uncounted (`bypass: true`); nobody else counts it, ends on it or bypasses it (`routeAuthority.test.ts`, the #1554
block, on both the 18XX+ and LPF boards). Not enforced: the "must count it in its first turns" clause; whether a
bypassed herald still satisfies the station requirement (today it does, as before). JUNO-CV4 145 (two 2-trains,
H16–H18 and H16–H14–H12*–H10) is judged legal by the authority. Notes: #1302 (`heraldValueFor` prices the herald in the reducer only
for the running corporation — safe since Stage 3's identity gate), #1277 (herald counts as a network root in
`trackReach.ts`), #1280 (herald persists through upgrades), #1332 (float modal), triage 2026-09-08 items 12/23
(item 23 ruled "not a bug": the tracer bypassed Altoona correctly with two 2-trains), `hexBoardData.ts` Altoona
bypass. Detail: the owner's spec says PRR "alone can (and must in its first turns) count" the herald; nothing
authoritative checks that a filed route actually reaches H12 through PRR's network, that no other corporation
counts it, or the "must" clause. Fold into S6-1's refusal (herald is a stop only for `forCompanyId === PRR`);
add a `JUNO-CV4` replay case pricing the idx-145 route with H12 counted per the triage note; state the "must"
clause as an owner decision or drop it.

**S6-5. Server-side tile legality omits connectivity (`networkHexes` / `networkPorts` not supplied to `layRefused`).**
Status `OPEN`. Rulebook §6.2.1 (1) / §6.2.2 (1), and the four exceptions (CS B20, DH 57 on F16, NYC 57 on E19,
Erie 59 on E11). Notes: audit M4; `gameEngine/replayProviders.ts` (`layRefused` → `filterSandboxPlacements`
in `components/sandboxTileLegality.ts`, `orientationJoinsNetwork`), `trackReach.ts`. Replay: refusal-added —
sweep the corpus; any historical disconnected lay would become a divergence — bump.
Detail: pass the network from `trackReach` into the server's `layRefused` exactly as `App.tsx` does; honour the
four printed exceptions (vacuously honoured today because nothing checks connectivity); the DH lapse
(`dhPowerState.forfeited`) and CS power (`cslPowerState`) are the existing readers. (Track legality is filed
under Stage 6 because it shares `trackReach`; move if the owner prefers.)

**S6-6. One lay / one upgrade per turn and `bonus_lay` are cursor-only; the flag is trusted.**
Status `OPEN`. Rulebook §6.2 (one lay), CS power (p.11). Notes: audit M3 (second half); `bonusLay.ts`,
`stepAfterMessage`, `LayTile.bonus_lay`. Replay: refusal-added — bump after a sweep. Detail: in
`applySandboxActionCore` refuse a second `LayTile` in one turn unless the corporation owns the CS, the hex is
B20, and the CS power has not lapsed — derive it, never trust the flag; keep the flag for narration.

**S6-7. No tile may be laid on a hex holding a player-owned private (SV G15, CS B20, DH F16, MH D18, CA H18, BO I13/I15).**
Status `OPEN` (missing everywhere; `privateReservations.ts` is a badge). Rulebook §6.2.1 (4). Notes: audit M5.
Replay: refusal-added — sweep; bump. Detail: add to `filterSandboxPlacements` (and therefore to both atoms):
refuse when the hex is a private's hex and that private has a player `owner` (closed or corporation-owned
privates release it). LPF/18XX+ hex sets differ (JK / Coalfields) — read the private catalog in effect.

**S6-8. A bare `LayTile` on a gray or red hex — no explicit refusal was confirmed.**
Status `OPEN` (UNCLEAR in the audit). Rulebook §6.2. Notes: `grayRedTrack.test.ts` covers track *drawing*;
`filterSandboxPlacements` may refuse through the missing `archetype` path. Detail: write the direct test; add the
explicit refusal if it is absent.

**S6-9. Off-board lesser/greater values switch at the first 5-train (Brown era).**
Status `RESOLVED` (audit PASS; `offboardValueForEra`) — listed so the era switch is not re-audited. Rulebook §2.5 / §6.5.

**S6-10. A route may begin or end at a small city (town) under the rulebook; the game has never allowed a town terminus.**
Status `RESOLVED` — **owner ruling 2026-09-15: follow the rulebook** (#1555). `isRouteTerminusHex` now answers
every revenue centre (large city, small city / town, double town, red area, the owner's herald), and since the
tracer, `hasLegalRouteFor` (the Batch-4/5 forced-purchase gate), `maxRouteRevenueFor` (auto-skip and the Run
Trains skip refusal), the draft editor, the shell's `endsOffTerminus` and the route authority all read that one
predicate, preview, search and authority agree. #1286's "unlike small towns" clause is withdrawn in the code
comments (`sandboxSession.ts`, `hexBoardDataLpf.ts`, `levelPlayingField.test.ts`); its warehouse half stands.
Coal River (a town on the LPF board) is therefore a terminus for a licence holder. Tests:
`routeAuthority.test.ts` "a town is a terminus" (town→city accepted and priced; town-city-town on a 3-train;
tracer drafts a town-ended route; draft editor's first click; **a town terminus as the only legal route makes the
forced purchase owed**, with the bare-board negative control). Corpus: **JUNO-FCJ 74** — B&M, trainless in its
first Operating Round, passed at Buy Trains; its only route (E23–F24, $40) ends on a town, so under the ruling the
Batch-4 obligation gate refuses the pass and the legacy log diverges from there. `stationLegality.test.ts`'s
prefix-96 harness supplies the purchase the old engine never demanded (a documented fixture repair inside the
test, nothing on disk). No other log changes. Found by Batch 6's rulebook verification. Rulebook §6.4.1: "for the purposes of
running trains and choosing routes, 'city' refers to a large city, a small city, or an off-board red hex", a
route "may begin or end at any city", and the train's number counts every city including small cities. The
code has excluded towns from termini since the tracer's design note #3 (`isRouteTerminusHex`; `routeDraftEdit`
rule 1 "towns are not termini (#264)"), and the owner's LPF ruling #1286 says "unlike small towns the
warehouses are also valid termini" — a stated position. Batch 6 kept the ruling in the authority (one predicate,
`isRouteTerminusHex`, shared by the tracer, the obligation gate `hasLegalRouteFor` and the evaluator) and
flagged it rather than switching, because a town-terminus authority with a town-blind tracer would accept runs
the auto-skip and the Batch-4 forced-purchase gate cannot see. Detail if the rulebook is adopted: widen
`isRouteTerminusHex` to `SingleTown` / `DoubleTown` (towns still count against the number, still cannot be
tokened or blocked), re-run the corpus (every "no legal route" auto-skip and forced purchase can change — replay-
semantic, bump), and re-examine `routeRunObligation` / `runnableDrafts`' `value > 0` rule. If the ruling stands,
record it in Part D.

**S6-11. The #1183 one-run-per-turn key never fired.**
Status `RESOLVED` — Batch 6 (#1550, corrected note in the arm). `last_run_turn_key` was declared on
`GameStateResponse` and read as `state.last_run_turn_key`, but the arm wrote it inside `public_companies.map`,
on the corporation; the state's field stayed `undefined` and the refusal was unreachable. `oneRunPerTurn.test.ts`
asserted both strings and could not see they named different objects (#490a in a new shape). Evidence: JUNO-3XD
319 — the very duplicate the note was written for — was applied in every replay since (NNH 680 printed / 540
adjusted). The write now lands on the state; the authoritative rule is `routes_run_this_turn > 0` regardless of
key. Consequence: every replayed log's digest changes where a run occurred (the key moved objects); the CV4
golden fixture was re-baselined for exactly that and nothing else.

**S6-12. `RunManualRoute` is retired from live play.**
Status `RESOLVED` (recorded) — Batch 6 (#1551). Nothing has dispatched it since #968; its arm added to
`printed_route_revenue` once per message with no per-turn bound and now no route judgement, so a hand-built copy
was an unbounded revenue faucet. A pinned board (`state.rules_engine_version` is a number) refuses it in the
core and at ingress; unpinned (legacy) logs keep the arm they were played on. The schema keeps the message so a
legacy entry still parses.

**S6-14. Route-search cost on submission.**
Status `DEFERRED` (optimisation, not a rule). #1556 runs `maxRouteRevenueFor` once per submitted run (the
auto-skip already runs it once per turn); on the corpus the whole 17-log sweep, searches included, takes ~1.7 s,
and #892 measured ~250 ms for a Diesel on a dense Phase-D board. If a board ever makes the ingress + core pair
of searches a functional timeout, memoise the search per (state digest, corporation) or pass the ingress verdict
into the reducer context; until then no change. Replay: none.

**S6-13. The shell's route validators duplicate the authority.**
Status `DEFERRED` (cleanup, no rule change). `utils/runTrainsRules.ts`, `routeWaypoints.ts`
(`routeTokenBlockReason`, `routeBlockedCityReason`), `routeConnection.ts`, `routeDraftEdit.ts`,
`routeTruncate.ts` still judge drafts for click-by-click feedback; `handleRunTrains` now also asks
`evaluateRouteSet` before dispatch (#1554) and the reducer judges again. Three answers to one question is
#1184's shape. Detail: make the draft-time checks read the evaluator's refusal (a per-draft
`evaluateRouteSet` on the single route) and delete the halves it makes redundant; keep only what a
half-drawn route needs (rule 2–6 of `editRouteDraft`). Replay: none.

### Stage 7 — Transaction + cash authority / auction

**Closure (Batch 7.5, 2026-09-16).** Every Stage-7 transaction-authority item below is `RESOLVED` except **S7-17**
(refusal-by-identity on pinned boards — a design pass carried with S10-1, not a transaction rule). The single
replay-semantic bump the five slices owed has landed: `RULES_ENGINE_VERSION` 4 → 5, `SUPPORTED = [5]`, changelog row 5.
Every stale replay / golden / corpus expectation was traced to a named Batch-7 rule before it was re-pinned; the ledger
of divergences is `BATCH7.5_REPLAY_VERSION_CLOSURE_2026-09-16.md` §3 and Part E's version-5 row. A static check
confirmed that every Stage-7 predicate the reducer core asks is also asked at ingress (design §12b); the one core-only
refusal is the ledger boundary itself, by design (U-29). Carried forward, not implemented: S8-5 / S8-6 / S8-12 (home
token timing and hold parity), S9-1 (Yellow Sign authority), S9-10 (tile-upgrade topology), S10-20 (O2), **S10-21**
(new: a completed version-5 Yellow Sign fixture), and Part C U-19 … U-31 with U-28's retrospective audit.

**S7-1. Zero floors act as implicit refusals: `adjustCash`, `adjustBank`, `adjustTreasury` clamp at 0.**
Status **`RESOLVED`** — the floors by Batch 7.1; the rules in front of them by 7.2 (`stockPurchaseRefusal`), 7.3
(escrow-aware auction refusals) and 7.4 (`privatePurchaseRefusal` / `trainSaleRefusal` / `privateTradeRefusal`); the
corpus consequence re-pinned with its reasons in Batch 7.5 (version 5). *(Batch 7.1 status: `RESOLVED` (the floors) /
`OPEN` (the rules in front of them).)* Batch 7.1 (#1560,
`gameEngine/cashLedger.ts`). All three adjusters are deleted. Every debit and credit in the engine now goes
through one ledger: whole non-negative amounts, one debit matched by one credit, a player/treasury debit the
balance cannot cover REFUSES (identity, never a throw — the server appends before it applies), a negative or
fractional amount refuses rather than reversing the movement, and an unknown payee refuses rather than
absorbing the money. The bank is signed (D-15/Q1b) and latches (S7-20). The corpus now conserves money after
every replayed entry in all thirteen logs, with the two by-design exceptions only (`SetupGame`,
`YellowSignEvent` — S9-1); `moneyConservation.test.ts` is the sweep, `cashLedger.test.ts` the unit suite.
m9's "charged for nothing" is NOT closed here: the ledger stops the mint, but refusing an undeliverable
purchase outright is D-25 and belongs to Batch 7.2. **What remains open is the RULE half**: affordability
must be an explicit predicate in front of the transaction (`stockPurchaseRefusal` 7.2, `privatePurchaseRefusal`
/ `trainSaleRefusal` 7.4, escrow-aware auction refusals 7.3). The ledger is the boundary those predicates are
checked against, not a substitute for them. Corpus consequence (reported, NOT re-pinned — Batch 7.5's sweep):
twenty-five unaffordable `BuyStock` entries and one unaffordable `BuyPrivateCompany` are now refused —
JUNO-3XD 28, 31, 204, 205, 208, 209, 211, 212, 216, 285, 289–295, 297, 299, 300 and 112
(`BuyPrivateCompany`, NNH's treasury $0 against $70); JUNO-FCJ 106, 109, 181; JUNO-Z6C 193, 264 — each with
the cascade that follows it.
Historical: audit **C3** (architectural risk 3). Rulebook: cash required for every purchase (§5.2 implicit,
§1.2.1, §6.3.2, §3.1, §6.6). Notes: `sandboxSession.ts` adjusters (~line 204/213/229); only `LayTile` (#891),
depot / pool / emergency train purchases (#1513), the station gate (#1511) and the Stage 5 emergency paths check
funds; `transferPrivateToCorporation` relies on the gate in front of it (Batch 5 §6). Replay: refusal-added;
sweep — any historical overspend becomes a divergence — bump. Detail: `sharePurchaseBlock` gets `charged` vs
`cash_vgp` (BuyStock — an unaffordable purchase mints money today); `applyAuctionStep` refuses a buy / win whose
charge exceeds `availableCash` (escrow-aware); ordinary `BuyPrivateCompany` and `settleTrainSale` refuse when the
treasury is short; then replace `Math.max(0, …)` with an invariant that throws in tests. Also m9: a pool draw is
charged before the clamp — a buy from an empty pool charges for a share it does not deliver. Also m11 (note
only): `adjustBank` floors after the break — acceptable "paper tracking"; `bankIsBroken` still fires.

**S7-2. Auction all-pass marks down whichever private is lowest-offered and pays private revenue on every all-pass.**
Status `RESOLVED` — Batch 7.3 (#1580). §1.2.3's two rules are separated and both named: the markdown fires only
when the private on offer IS the Schuylkill Valley (`SV_PRIVATE_ID`, `gameConstants.ts`), and private income is
paid only when the SV is no longer in the auction at all. The $0 branch is a purchase, not a payout — the SV is
still unsold at the moment the table passed — so it pays nobody either. m12 disappears with it, and the LPF case
needs no variant branch: the James River & Kanawha is never the SV, so it is never marked down (ruling D-21/Q8).
`auctionTransition.ts` reads the payout off the BANK rather than assuming it from the all-pass, so the shell
cannot narrate income the reducer did not pay. **Corpus: this is the batch's only end-state divergence** —
JUNO-Z6C from idx 9 (the B&O no longer 220 → 215; the whole game then differs) and JUNO-G6J from idx 7 (the JK
no longer 120 → 115; $5 of player cash and the bank). Delayed Auction re-checked: its auction is a later round
with the same atom and the same rule, and nothing in either branch reads the calendar.
*(Original finding: audit **C5**.)* Rulebook §1.2.3: only the **SV** is marked down, only while unsold; revenue is paid
only once the SV has sold, with no markdown. Notes: `applySandboxWaterfallAction` `WaterfallPass` branch
(`is_lowest_offered`, `WATERFALL_PASS_MARKDOWN`), #271, #337, #1281 (`RoomEngine` pays the all-pass income),
#1340 (auction atom in the reducer). Replay: **replay-semantic** (prices and cash differ in any log with a
post-SV all-pass) — bump; sweep and report. Detail: mark down only when the lowest offered is the SV (or the
lowest printed face of the roster in effect — LPF has a different roster); pay revenue only when the SV has an
owner; m12 (revenue on an all-pass with SV unsold) disappears with it. Delayed Auction (owner variant, #905)
must be re-checked: its auction runs after the OR set of the first 3-train.

**S7-3. Mini-auction pass removes the bidder permanently.**
Status `RESOLVED` — Batch 7.3 (#1581). A pass now increments `mini_auction.passes_since_raise` (new optional
field; absent = 0, which is what keeps every stored log replaying) and keeps both the bidder and his bid; any
legal raise resets it to 0; the contest resolves when it reaches `bidders.length - 1` — every bidder but the
high bidder, who is never asked (`nextMiniTurn`, #544). The winner is the high bidder at his own high bid,
stated rather than arrived at by elimination. Both frozen sequences are pinned in
`auctionAuthority.test.ts`: A raises / B passes / C raises / A passes / **B raises** (legal — B's pass did not
remove him), and A raises / B passes / C passes / **A wins**. Deliberately tested with THREE bidders: every
contest in the corpus is a two-bidder one, where `bidders.length - 1` is 1 and one pass resolves it under both
the old rule and the new, which is why the corpus outcomes do not move. `miniAuctionTurn.test.ts`'s
drop-out case is re-pinned with the reason.
*(Original finding: audit **M1**.)* Rulebook §1.2.2 ("may pass and still bid later"). Notes: `WaterfallMiniAuctionPass`;
`miniAuctionTurn.test.ts` pins the current behaviour. Replay: replay-semantic — bump. Detail: passes do not
remove bidders; track consecutive passes since the last raise; the auction ends when they reach
`bidders.length − 1`. Tests: A raise, B pass, C raise, B raise accepted; A raise, B pass, C pass → A wins.

**S7-4. Bidding gaps: a bid on the lowest-offered private is accepted; bids are not escrow-aware; the mini-auction raise has no $5 minimum.**
Status `RESOLVED` — Batch 7.3 (#1580), in `gameEngine/auctionAuthority.ts`. A bid on `is_lowest_offered` is
refused (the cheapest card is a BUY decision, §1.2); every bid, raise and face-value purchase is escrow-aware
through `auctionEscrow.ts`'s **existing** `auctionFunds` / `bidRejectionReason` / `minimumBidFor` — the same
functions the dashboard has always called, so the button and the board cannot disagree; a raise must beat the
high bid by $5; amounts must be whole dollars. Raising one's OWN standing bid stays legal (D-16/Q3) and is
charged only the increment (`amount − ownStandingBid ≤ availableCash`), so a leader can defend his own bid.
The probe's two findings are closed by test: $9,999 bid on $1,160 of cash, and the same dollar standing on two
private companies. Corpus: no stored bid is affected, and the one stored sub-minimum re-bid (JUNO-3XD 6) was
already refused by #1184 — 7.3 stops the SEAT advancing for it as well (see Part E).
*(Original finding: audit **M2** + matrix rows.)* Rulebook §1.2 (3), §1.2.1, §1.2.2. Notes: `WaterfallBidHigher`,
`WaterfallMiniAuctionRaise`, `auctionEscrow.ts` (`minimumBidFor` — reducer-enforced since #1184;
`availableCash` — UI arithmetic today). Replay: refusal-added — bump after a sweep. Detail: refuse a bid on
`is_lowest_offered`; refuse when `amount − ownStandingBid > availableCash`; refuse a raise below high bid + $5;
whole dollars (schema already requires integers).

**S7-5. Inter-corporate train sale: buyer must be operating at Buy Trains; price ≥ $1; treasury covers the price.**
Status `RESOLVED` — Batch 7.4 (#1592, `gameEngine/trainSaleAuthority.ts`). One predicate, `trainSaleRefusal`, asked
at proposal (Hardware-only, D-18/Q5), at answer and at settlement, in the core (identity) and at ingress (sentence):
D-6's `fundedTradeRefusal` first (unchanged), then the buyer's Operating turn at the Purchase Trains step, two
distinct corporations, the seller owning the train, a whole price ≥ $1, the buyer's treasury alone (D-20/Q7 — the
president's money only through D-6), the limit in force, and consent (a matching accepted offer, or one president
over both). JUNO-FCJ 468/768/784/975 are direct $1–$10 trades whose actor presides over one side only on the
log-derived board: refused (they were already no-ops there under 7.1's ledger). *(Original finding: audit **M14**
(buyer limit closed by Stage 4).)* Rulebook §6.6. Notes: `settleTrainSale`,
`BuyTrainFromCorporation` (derived after `AnswerTrainPurchase`), #1450, Batch 4 §2, Stage 5's
`fundedTradeRefusal` (owner rule D-6) covers only the obligation case. Replay: refusal-added — bump after a
sweep (JUNO-FCJ idx 468/768/784 are $1–$10 trades; confirm they pass). Detail: refuse unless
`buyer === operatingCorporationId(state)` at Hardware, `price ≥ 1`, treasury ≥ price; then the offer/answer
authority (S7-8).

**S7-6. Ordinary `BuyPrivateCompany` checks only "not the B&O" and "not already this corporation's".**
Status `RESOLVED` — Batch 7.4 (#1591, `gameEngine/privatePurchaseAuthority.ts`). `privatePurchaseRefusal` at
proposal, answer and settlement, both locks: an Operating Round, the operating corporation at any step of its turn
(D-18), phase 3 or 4, an open player-owned private the B&O ban allows, a whole price inside the printed ½–2× band,
a floated presided buyer whose treasury holds the price, and consent (a matching accepted ordinary offer whose
owner is still the private's CURRENT owner, or one principal on both sides). The corpus keeps every historical
purchase that was legal; JUNO-FCJ 309 (a direct purchase in a Stock Round) is the first refused. *(Original
finding: audit **M13**; Stage 5 built the pieces (`privatePriceBand.ts`: `privatePriceBounds`,
`privatePurchasePhaseOpen`) and applied them to the *emergency* sale only. Rulebook §3.0 (phases 3–4, during the
corporation's turn), §3.1 (½–2× face, declared price), "bought by railroads but not sold by them". Notes:
`BuyPrivateCompany` arm (~4745), `transferPrivateToCorporation` (#1541), `ProposePrivatePurchase` /
`AnswerPrivatePurchase`, S7-7. Replay: refusal-added — sweep; bump. Detail: refuse unless phase ∈ {3, 4}, price
within the band, buyer is the operating corporation (S7-7), seller is a **player** (the arm accepts
`owner_protocol_id` of another corporation), treasury ≥ price; reuse `fundingPrivateSaleRefusal`'s shape.

**S7-7. `BuyPrivateCompany.protocol_id` has no operating-corporation check.**
Status `RESOLVED` — Batch 7.4 (#1591): rule 2 of `privatePurchaseRefusal` (the buyer is `operatingCorporationId`),
asked of the direct message, the proposal and the derived settlement alike. *(Original status `OPEN`.)* Rulebook §3.0 ("during its turn in an operating round"). Notes: Batch 3 §3 reported-not-fixed;
`operatingIdentity.ts` is the family to extend. Replay: refusal-added; bump after a sweep.

**S7-8. Pending-offer authority: `ProposePrivatePurchase` / `ProposeTrainPurchase.buyer_protocol_id` — the socket checks the buyer's president (#1450), nothing checks the buyer is the operating corporation; an ordinary offer is not revalidated at acceptance and may outlive the turn.**
Status `RESOLVED` — Batch 7.4 (#1590 `pendingOfferHold.ts`, #1595). A proposal runs the transaction's own predicate
on the current board; an acceptance re-runs it (a stale board refuses the answer by identity and leaves the offer
standing for a rescind); the derived settlement runs it once more and a failure RETIRES the offer without moving
anything (#1596 — the one deliberate mutation of a refusal). An offer cannot outlive the turn because the turn cannot
end while it stands (`pendingOfferBlock`, D-19/Q6); no turn-end clearing code was added because it would be dead.
`RevertTo` rebuilds every offer state from the log (tests: before the proposal → none; between proposal and answer →
pending and held; through acceptance → exactly one settlement). *(Original status `OPEN`.)* Rulebook §6.6 (during the buyer's turn), §3.0. Notes: Batch 3 §3; `turnAuthority.ts`
(`roomMessageRefusal`, `consentAnswerRefusal`), `derivedActions.ts` (`BuyTrainFromCorporation` /
`BuyPrivateCompany` after an accepted answer), `private_purchase_offer` / `train_purchase_offer` on the state,
Stage 5's funding offers (which *do* freeze the board and revalidate at settlement — the shape to copy).
Replay: refusal-added; bump after a sweep. Detail: a president of two corporations can offer on behalf of the
idle one and the derived settlement binds to that offer — refuse an offer whose buyer is not the operating
corporation at the right step; decide what happens to an outstanding ordinary offer when the turn ends (confirm
from `settleOperatingCursor` whether it survives); revalidate legality at acceptance (price, treasury, limit,
phase) exactly as `fundingPrivateAnswerRefusal` does, rather than at proposal. The verification checklist in
S10-10 (negotiation flows on the server path) is the acceptance test.

**S7-9. Player-to-player private sales (§3.1, not in the first SR) — no message located.**
Status `RESOLVED` — Batch 7.4 (#1593, `gameEngine/privateTradeAuthority.ts`; #1594 `ProposePrivateTrade` /
`AnswerPrivateTrade` / `RescindPrivateTrade`, `private_trade_offer`). Implemented exactly as ruled: a Stock Round other
than the first, on the buyer's or the seller's turn, the seat holder proposes and must be a party, only the other party
answers, only the proposer withdraws; distinct seated players, an open private the seller owns, a whole price ≥ $0 (no
band), the buyer's cash, and the overall certificate limit (`certificateBreakdown(...).counted + 1 > limit` refuses) —
re-derived at proposal, answer and settlement; the acceptance settles in its arm (buyer → seller through the ledger,
`owner` rewritten). N1 (D-26): the card and every unexercised power travel because every power reads `owner` at use;
`used_private_abilities` is not rewritten; the C&A's share and the B&O's par are not retriggered; the BO private is
saleable player → player. N2 (D-27): `turn_action_taken: true`, `consecutive_passes: 0`, `last_trader_index` = the seat
via `markTrader`; `bought_this_turn` / `bought_this_turn_company` / the seat / `stock_turn_stage` untouched. Focused
tests in `offerAuthority.test.ts`; the exhaustive ±one-fact matrix is the follow-on Opus batch's. *(Original status
`DEFERRED` → owned by **Batch 7.4** (owner ruling Q12, 2026-09-15, D-24).)* Rulebook §3.1: "Private companies may
be sold between players for any mutually agreed price at any time during the buyer's or the seller's turn of a stock
round (other than the first)" — a private-company rule, not a certificate rule; the ½–2× band of the corporation
sentence does not apply. Detail: the third bilateral offer kind on the Stage-7 pending-offer machinery
(`ProposePrivateTrade` / `AnswerPrivateTrade` / `RescindPrivateTrade`, `private_trade_offer`): Stock Round, not the
first, the seat is the buyer or the seller, seller owns the open private, distinct players, integer price ≥ 0,
buyer cash ≥ price, other party consents, payment player → player, legality re-derived at proposal / answer /
settlement, the one-offer hold, proposer may rescind, `RevertTo` rebuilds it; **and the buyer must remain within
the overall certificate limit after the acquisition** (rulebook §4.3 counts a private as one certificate;
`certificateBreakdown` already counts open privates as counted certificates) — checked at proposal, answer and
settlement, a stale board refusing/retiring without moving money or ownership (owner, 2026-09-15). What travels
with the card is D-26; the Stock Round bookkeeping is D-27. Design
`BATCH7_TRANSACTION_AUTHORITY_DESIGN_2026-09-15.md` §7.6a, with the required 7.4 tests (limit ± 1, stale-limit
retirement, seller's count, the N1 and N2 matrices). Replay: new messages and field — bump (version 5).

**S7-10. Auction proceeds and terrain fees are never credited to the bank.**
Status `RESOLVED` — Batch 7.1 (#1560). `applyAuctionStep`'s inline `Math.max(0, cash - amount)` is a
`transfer(player -> BANK)` (a $0 Schuylkill Valley acquisition still moves $0), and the `LayTile` terrain fee
is a `transfer(treasury -> BANK)` behind #891's unchanged affordability gate. Proved on the frozen JUNO-CV4
log: the seven auction charges credit the bank $755 in total (idx 1 +$20 … idx 10 +$220, the mini-auction win
at idx 8 +$135 included) and the three terrain lays at idx 27 / 78 / 163 each move $80 from the treasury to
the bank. Corpus consequence (reported, not re-pinned): the bank figure differs in every log that holds an
auction or a terrain lay, from the first auction purchase onward — see the Batch 7.1 report's
first-difference table. Historical: found by the Batch 7 design pass (2026-09-15, `BATCH7_TRANSACTION_AUTHORITY_DESIGN_2026-09-15.md` §4).
`applyAuctionStep` debits the buyer/winner with an inline `Math.max(0, cash − amount)` and credits nobody; the
`LayTile` terrain fee is `adjustTreasury(−fee)` alone. A conservation probe (bank + every cash + every treasury after
every replayed entry) shows the bank constant through every private purchase in each of the six server logs that hold an auction, so the bank
is short by the whole auction and breaks early in every game. Rulebook: every purchase is paid to the bank. Replay:
replay-semantic for the bank field of every log — bump. Owner ruling owed (design §11 Q1a/Q1b: credit the bank;
allow a signed bank after the break in place of the m11 floor).

**S7-11. Offer counterparties are trusted from the payload.**
Status `RESOLVED` — Batch 7.4 (#1595). The proposal arm records the private's current owner / the seller's current
president as the BOARD has them (the payload's `owner` / `seller_president` are narration and are not written); the
answerer is re-derived from the board again at answer time (`answerPrivatePurchaseRefusal`, `answerTrainPurchaseRefusal`)
and the settlement predicate requires the accepted offer's owner to still be the private's owner. A proposer can no
longer answer his own offer unless he is genuinely the counterparty, in which case the direct same-principal
transaction is independently legal. *(Original finding: design pass, probe-proved. `ProposePrivatePurchase.owner` and `ProposeTrainPurchase.seller_president`
are copied into the offer and `consentAnswerRefusal` checks the actor against them, so the proposer can name himself,
answer his own offer, and the derived `BuyPrivateCompany` / `BuyTrainFromCorporation` settles (another player's
private taken for $1). Detail: the answerer is the private's *current* owner / the seller's *current* president,
re-derived from the state; the payload names become narration. Design §7.6. Replay: refusal-added; bump.

**S7-12. Direct settlements need no consent, no funds and no sane price.**
Status `RESOLVED` — Batch 7.4 closed the remaining half (#1591/#1592): a direct `BuyPrivateCompany` /
`BuyTrainFromCorporation` is legal only with a matching accepted offer on the board or one principal on both sides,
and only when the whole transaction predicate holds (phase or step, band or $1 floor, operating corporation,
treasury). Batch 7.1's money half stands unchanged. *(Batch 7.1 status: partially `RESOLVED` (the money) / `OPEN`
(consent, phase, step, band, operating corporation) —
Batch 7.1 (#1563) closed the half that destroys or invents money: `transferPrivateToCorporation` now requires
a PLAYER seller (a corporation-owned or unowned private refuses instead of debiting the buyer and paying
nobody — rulebook 3.1's "bought by railroad corporations but not sold by them"), pays that player through the
ledger, and refuses a negative or fractional price instead of running the payment backwards; `settleTrainSale`
moves the money first, so a price the buyer's treasury cannot cover refuses the whole sale rather than
delivering the train and flooring the payment. The $1 minimum, the band, the phase, the step, the operating
check and consent are rules and stay with Batch 7.4. Batch-5's D-5 emergency sale is unaffected: it is a
player -> corporation directed offer and its gates already stood in front of the same transfer.
Historical: design pass, probe-proved. A client-sent `BuyTrainFromCorporation` with no offer takes any
corporation's train for $0 (a negative price is discarded); a client-sent `BuyPrivateCompany` takes any player's
private at any price (a negative price pays the treasury and zeroes the owner), in any phase, at any step, from a
buyer that is not operating; a corporation-owned or unowned private transfers with the price paid to nobody
(`transferPrivateToCorporation` credits only a player `owner`). Detail: one predicate per transaction reused at
proposal, answer and settlement; a direct message is legal only when the actor is both principals (the shell's
same-president dispatch). Design §7.4 / §7.5. Replay: refusal-added; bump (FCJ's direct trades on the log-derived
board are affected — reported in §9 of the design).

**S7-13. `BuyStock` / `SellStock` have no round gate, and the IPO price comes off the message.**
Status `RESOLVED` — Batch 7.2 (#1570). `gameEngine/stockTransactionAuthority.ts`: `stockPurchaseRefusal` gates
`BuyStock` on `current_round_type === "StockRound"` and `stockSaleRefusal` gates `SellStock` on the same, with
the §6.6.3 forced sale as its one exception (Batch 5's `emergencyFundingFor` / `forcedSaleRefusal`, unchanged).
`priceStockPurchase` prices an IPO share from the corporation's **stored** par, a pool share from
`market_positions`, and the President's Certificate from a message par validated against the chart's own par
boxes; a message `par_value` is narration everywhere else (D-17 / Q4). Asked in `applySandboxActionCore` (by
identity, ahead of every stage — #1019), at ingress with its sentence (`turnAuthority`), and — for the sale —
inside the market step's `saleRefused` closure so a refused sale moves no token (#748a). Corpus: the round gate
is the ONLY 7.2 gameplay divergence — `server/JUNO-FCJ` 83 and `export/JUNO-3XD` 140, both `BuyStock` in an
Operating Round (BATCH7.2 §12). Version bump stays Batch 7.5.
*(Original finding, kept: design pass, probe-proved.)* Both arms apply during an Operating Round (operating president) and
during the auction (the contest's current player); `BuyStock` prices an IPO share from `msg.par_value` (a $1 share
on a parred corporation) and a president's purchase accepts any positive par (absorbs S8-9's par half, which the
Stage-7 brief §5 owns). Design §7.2 / §7.3. Replay: refusal-added; corpus: no forged par anywhere, JUNO-Z6C 388 is a
Stock Round sale inside an OR, JUNO-FCJ 83/150/153/282/285/366/369 are OR-time buys (already-diverged board) — bump.

**S7-14. No ordinary-offer rescission; offers outlive the turn and the round; a proposal overwrites a standing offer; nothing blocks progression while one waits.**
Status `RESOLVED` — Batch 7.4 (#1590, #1594). `RescindPrivatePurchase { private_id }` and `RescindTrainPurchase
{ seller_protocol_id }` (the buyer's CURRENT president; clears the offer, moves nothing, ends no turn) and
`RescindPrivateTrade { private_id }` (the proposer); one ordinary offer of any of the three kinds at a time, never
beside a funding offer (a second proposal is refused, never overwrites); `pendingOfferBlock` freezes everything but the
answer, the rescission, the derived settlement, `RevertTo` and `CloseRoom` while an offer stands, awaiting its
answer or accepted and awaiting settlement. Schema 44 → 49. *(Original finding: design pass. `RescindTrainOffer` / `AcceptTrainOffer` / `RejectTrainOffer` are chain-era no-ops
(`offer_id`); nothing clears `private_purchase_offer` / `train_purchase_offer` at turn or round end (JUNO-FCJ 232
was proposed at Tokens and declined at 234 in the following Stock Round; 273/274 both in a Stock Round). Detail:
design §7.6 — one offer at a time, the hold, two new rescission messages, settlement-time revalidation. Replay:
refusal-added; bump.

**S7-15. Main-rotation auction messages are applied during a live mini-auction.**
Status `RESOLVED` — Batch 7.3 (#1580). `contestBlock` refuses `WaterfallBuyLowest`, `WaterfallBidHigher` and
`WaterfallPass` while `mini_auction` is live, at both locks, with the sentence naming the contested private.
The seat rule could never have caught this and the entry says why: during a contest `actingAddress` names the
CONTEST's current player (#1232), so the one player who can move the main rotation mid-contest is exactly the
one the seat check waves through. No corpus entry is affected.
*(Original finding: design pass. `WaterfallPass` / `WaterfallBuyLowest` / `WaterfallBidHigher` did not check
`mini_auction`.)*

**S7-16. `SellStock` accepts a percentage that is not a multiple of 10.**
Status `RESOLVED` — Batch 7.2 (#1570). `stockSaleRefusal` rule 2: the percentage must be a positive whole
multiple of 10 (15, 5, 0, −10 and 12.5 all refuse); the schema keeps `finite` and the double's 20 semantics are
untouched. No corpus entry is affected. Replay: refusal-added; bump stays 7.5.
*(Original finding, kept: probe-proved — `percentage: 15` left a 5 % holding.)*

**S7-17. Refusal-by-identity is dead on every board that carries `market_positions`.**
Status `OPEN` (cross-reference S10-1) — design pass. `applySandboxActionAfterAuction` allocates `settled` before the
core runs, so every reducer refusal on a pinned board returns a new object and `actionWasRefused` / `after !== before`
cannot see it. Stage-7 tests assert refusals by `stateDigest` equality, never by identity. No gameplay change.
**Batch 7.2 note:** its two new suites do exactly that (`stockTransactionAuthority.test.ts`,
`stockRefusalAtomicity.test.ts`), and one thing is now stronger than the entry describes — because 7.2 asks its
predicates in `applySandboxActionCore` AHEAD of every stage (#1019), a refused stock transaction is returned by
identity after all, even on a stale board that the settle chain would otherwise normalise. `refusalAtomicity.test.ts`
(7.1) is updated to assert that. The entry stays `OPEN`: the general property is still false for arms that refuse
inside themselves.

**S7-18. A Brown-zone second pool message need not name the corporation of the first.**
Status `RESOLVED` — Batch 7.2 (#1570), owner ruling Q9 / D-22. New optional state `bought_this_turn_company`
(`gameState.ts`), written by the first purchase of the turn and cleared by all three sites that clear
`bought_this_turn` (`advanceSeat`, `recordPass`, `openingStockRoundReset`); `stockPurchaseRefusal` rule 7 refuses
a continuation that names a different corporation. The multi-message representation is preserved for replay, and
**absent is "not said"** (#232) — a board rebuilt mid-turn from a log written before the field existed carries no
continuation rule, so no legacy replay is refused by it. The Brown exception is not extended to Orange
(`allowsExtraPoolBuys` unchanged). Replay: refusal-added; no corpus entry is affected; bump stays 7.5.

**S7-19. `BidOnPrivate` advances the seat without the auction atom; the `AcceptTrainOffer` family is reachable on a pinned board.**
Status `RESOLVED` — the `AcceptTrainOffer` / `RejectTrainOffer` / `RescindTrainOffer` half by Batch 7.4 (#1590,
`legacyOfferMessageRefusal`): refused on a board carrying a `rules_engine_version`, at both locks, with a sentence
naming the sandbox message that replaces each; a legacy board keeps the no-op arm (D-9). Types and schema stay until
S10-8. *(Batch 7.3 status: `PARTIAL` — **the `BidOnPrivate` half is RESOLVED by Batch 7.3** (#1580): `legacyBidRefusal` refuses it on
a board carrying a `rules_engine_version`, at both locks, so it can no longer desynchronise the seat from
`waterfall.current_turn`; a legacy board keeps the arm it was played on (D-9), exactly as `RunManualRoute` does,
and the schema and the type stay until S10-8. The `AcceptTrainOffer` / `RejectTrainOffer` / `RescindTrainOffer`
family is offer machinery and stays **Batch 7.4's** (ruling D-23 covers all four; 7.3 deliberately did not
broaden into offers). `OPEN` for that half.
*(Original finding: design pass.)* `BidOnPrivate` is undispatched and absent from the corpus but its arm is
`advanceSeat` while `applySandboxWaterfallAction` ignores it, desynchronising the seat from `waterfall.current_turn`.
Detail: refuse all four on pinned boards (design §11 Q11 — ruled YES, D-23); the type/schema retirement stays S10-8.

**S7-20. The bank break is not latched.**
Status `RESOLVED` — Batch 7.1 (#1561). `bank_broken?: true` is written by `cashLedger.debitBank` the first
time a payout leaves the balance at or below zero (a zero debit never latches: the bank is exhausted by a
payout, not by a message that pays nobody), and is cleared by nothing — no credit, no arm, no settlement.
`bankIsBroken` is now `state.bank_broken === true || Number(virtual_bank_vgp) <= 0`, the second half kept for
fixtures and legacy boards that carry no field (#232). **Review addendum (2026-09-15):** both writes of the
balance go through one `withBankBalance`, which also MATERIALISES the field on any write to a board
`bankIsBroken` already answered `true` for. Without it the invariant held only for boards dealt after 7.1: on a
legacy board the sole record of the break is the balance, so a receipt lifting −$20 to $80 erased it and
`bankIsBroken` went true → false across a credit. Not a reinterpretation (the predicate's answer is unchanged
before and after; only its durability changes) and not a corpus change (no stored bank reaches zero — the
re-run sweep is step-for-step identical). A solvent legacy board and an unreadable balance still acquire
nothing. `settleRoundTransitions`' single ask and #898's timing
are unchanged in shape, and the `App.tsx` badge is correct with no UI change because it reads the same
function (U-27, now pinned by test). `RevertTo` past the breaking payout rebuilds a board without the field
by construction — no revert-specific code exists. Regression: `bankBreakLatch.test.ts` (fourteen cases,
including the owner's `$10 -> pays $30 -> -$20 latched -> receives $100 -> $80 still latched -> GameEnd`, the
exact-zero latch, the deeper payout, the recovering receipt, the legacy board with no field, the `RevertTo`
rebuild through `replayLog`, conservation across the whole sequence, and the badge/reducer shared predicate).
Corpus: **no log latches** — the bank's lowest point across all thirteen is $8,050 under the old engine and
$8,800 under 7.1 (the auction and terrain money it never used to receive), so no stored game's ending moves.
Historical: found by the Batch 7 design pass, revision 2 (owner's Q1b check). `endgame.bankIsBroken` is
`Number(virtual_bank_vgp) <= 0`, asked once, in `settleRoundTransitions`' `operating_round_just_ended` branch (#898):
the ending is re-derived from the balance at the set boundary. Nothing records that the bank ran out, so a bank that
a payout empties and the same set's train / token / share purchases refill has, at the boundary, a positive balance
and the game plays on — under today's floor and under signed accounting alike. `App.tsx` 12548 draws the badge from
the same live predicate. Detail (Batch 7.1, design §7.1a): `bank_broken?: true` written by the ledger's bank debit the
first time the balance leaves `≤ 0`, never cleared by a mutation (only a `RevertTo` past the payout rebuilds without
it); `bankIsBroken` = latch, else the legacy balance test; the single ask in `settleRoundTransitions` and the badge
unchanged in shape. Regression: bank crosses zero → later receives enough to be positive → the end condition remains
triggered at the set boundary. Replay: replay-semantic (a recovered bank now ends the game; the field joins the
digest) — bump; the 7.5 sweep reports the first-latch index per log. **Batch 7.5 sweep (version 5):** no log in the
eighteen-file corpus writes `bank_broken` under any Batch-7 engine (7.1 → 7.4 and the version-5 tree); the lowest
post-deal bank balance under version 5 is $8,720 (`export/JUNO-QVC`), so no stored game's ending moves for the latch.

**S7-21. R74-B — the derived train-settlement key named a tuple of board facts that legal play can bring back, so a later distinct offer between the same parties was never settled and the pending-offer hold froze the table.**
Status `RESOLVED` — Batch 7.4 follow-up (#1597, `gameEngine/pendingOfferHold.ts` `allocateOfferInstance`,
`gameEngine/derivedActions.ts` `privateOfferKey` / `trainOfferKey`, the three proposal arms in `sandboxSession.ts`,
`GameStateResponse.offer_serial`). Found by the Opus exhaustive matrix (`offerMatrix74Settlement.test.ts` §14, five
legal `RoomSession` reproductions R74-B.1–B.4 and B.5b: same-turn rust after a depot purchase, rust caused by
another corporation, an intercorporate sale, rust then a purchase, a discard as one step of a chain — and B.2 at
an IDENTICAL price, which is why adding the price to the key was ruled out). The old key
`offer:train:<seller>:<model>:<buyer>:<fleet size>` was consumed once per server lifetime; the second offer derived
the same key, `settleOwed` derived nothing, and the accepted offer stood under #1590's hold with no legal exit.
Repair: **every ordinary offer is numbered when it is proposed** — one strictly monotonic counter `offer_serial` on
the board (absent = none yet, #232), written only by the three proposal arms (`(offer_serial ?? 0) + 1`), never
decremented or cleared by an answer, a rescission, a settlement, a turn end or a round end; the number travels on
the offer as `instance`; the derived settlement key is `offer:private:<instance>` / `offer:train:<instance>` and
nothing else. Deterministic and log-derived like every other field: a replay assigns the same numbers in the same
order, `RevertTo` rebuilds without the reverted offers and their numbers (no undo code), a restart recomputes the
guard from the surviving log (#1208). No UUID, no clock, no server-side sequence, no property that can cycle. The
Batch-5 funding offer is not an ordinary offer and takes no number (D-5 / D-6 untouched). The private key was
proved safe under the current lifecycle (R74-B.6) and moved to the instance anyway so both families share one
identity. Exactly-once preserved: one acceptance → one derived settlement; repeated `settleOwed` pays nothing
twice; restore / replay / a duplicated entry land once; a refused stale settlement retires the offer and is not
re-derived; a later offer is a new instance and is never suppressed by a completed one (§12, §14, §15 of the
Settlement matrix; `offerAuthority.test.ts` G). **O4 (characterization only, no fix):** if a private's owner could
change between proposal and answer, the new owner's acceptance is recorded and the settlement retires paying
nothing (design §7.4 rule 7 literally; trains differ by §7.5 rule 6) — unreachable in play because the hold
freezes every ownership change; pinned in the stale-at-answer rows and left as the documented asymmetry.
Corpus: the field appears wherever a stored ordinary proposal is applied — **`server/JUNO-CW7` from idx 122**
(the proposal at 121 numbers itself: `offer_serial: 1`, `train_purchase_offer.instance: 1`) and **`export/JUNO-QVC`
from idx 60** (the proposal at 59); no other field, no applied/dropped count, no money total and no bank balance
differs in any of the seventeen files; FCJ is untouched because 7.4 refuses all four of its stored proposals.
Replay: replay-semantic (a new digest field) — folded into the already-owed Batch-7 version 4 → 5 bump (7.5); nothing
re-pinned here.

**S7-22. O1 — a derived accepted-offer settlement was recorded under the step's turn-guard key, so the automatic End Turn a filled fleet owes was derived from the depot path and not from the offer path.**
Status `RESOLVED` — Batch 7.4 follow-up (#1598, `derivedActions.derivedEntryKey`, `RoomEngine.apply`). Pre-existing
(#1208 × #1247): `apply` recorded `turnGuardKey(board, operating, step)` for EVERY `derived` entry; a train
settlement that filled the buyer to its limit at Hardware therefore spent the key the step's own `PassTurn` would
use, the loop derived nothing, and the turn stayed open until the president ended it by hand — where the same fleet
bought from the depot ended the turn at once. Repair: one function, `derivedEntryKey(state, msg)`, answers "what key
does this derived entry consume" for the replay and the live loop alike — the offer's instance key for the
settlement of the standing accepted offer, the turn key for every other derived entry, nothing for a settlement
that matches no standing offer (a stored proposal a later engine refused, FCJ 147). The post-settlement board is
then re-asked and derives whatever a depot purchase would: equivalent boards, equivalent progression, no "offer ⇒
End Turn" special case. Pinned both ways (`offerMatrix74Settlement.test.ts` §14 companion): the offer path's burst
is `[AnswerTrainPurchase, BuyTrainFromCorporation*, PassTurn*]` and lands on the same cursor as the depot path's
`[BuyHardwareFromPool, PassTurn*]`; a restore records the same keys and owes nothing; a restore cut between the
settlement and the End Turn derives the End Turn once; R74-B.5 and B.7's limit-filling boards end the turn.
Corpus: none (replay applies; only `settleOwed` after a restore changes, and no stored log ends between such a
settlement and its End Turn).

### Stage 8 — Stock / OR edge cases + timing

**S8-1. The operating order is snapshotted before the end-of-Stock-Round sold-out rise.**
Status `RESOLVED` — **Stage 8 Slice 8.1** (2026-09-16, Opus, design note #1600; committed `05b5dfc`).
*(Was `OPEN` (confirmed bug).)* Rulebook §6.0 (order by share value at the start of the OR), §4.5 (sold-out rise
at the end of the SR). Notes: #746a, #1196, Batch 4.6 §2b; `gameEngine/operatingOrder.ts`
(`buildOperatingOrder`), `sandboxSession.ts` (`beginOperatingRound`, `roundEndSoldOutRises`,
`applySandboxActionInner`). Replay: **replay-semantic — bump the version.**
Detail: #746a overlays the sold-out rises through the `priceFor` / `markFor` resolvers so the queue is built on
post-rise prices, but #1196 made `buildOperatingOrder` read `state.market_positions` first and consult the
resolvers only when positions are absent. On every server board positions are present, so the overlay is
ignored, `active_operating_order` locks on pre-rise positions, and the rise is committed to `market_positions`
afterwards (`applySandboxActionInner`, after the core settles). Confirmed on the corpus by comparing each locked
queue with `buildOperatingOrder` asked one settle later: JUNO-3XD idx 303 locks B&M@90 ahead of NYC@100;
JUNO-FCJ idx 699 locks NYC@112 behind ERIE/CPR@100; JUNO-FCJ idx 398 locks B&M@90 ahead of NYC@90 (a column
tie decided on the pre-rise cell). No other opening in the 17 logs disagrees. Repair: commit the rise to
`market_positions` before the round opens, or build the queue on the risen positions. The discard queue
(#1530) is unaffected — it asks mid-OR with positions already risen. Test: a charted board where a sold-out
rise reorders two corporations; assert the OR queue and the digest; sweep the corpus and report the three
indices above as the expected divergences.
**Stage-8 design pass (2026-09-16, `STAGE8_AUTHORITY_DESIGN_2026-09-16.md` §2).** Confirmed by code; on the version-5 corpus the three
indices above **no longer exist** (3XD is refused from 140 and frozen from 290; FCJ diverges from 83) and the one
surviving sold-out rise at an OR opening — server/JUNO-FCJ 885, PRR 90 → 100 — leaves the queue unchanged because PRR
already led, so the repair moves nothing in the present corpus. The mechanism is proved on every OR-bearing final
board by handing `buildOperatingOrder` an overlay pricing the leader at $1: positions win, the overlay is ignored.
Repair frozen as **Slice 8.1** with S8-3 / S8-4: one `settleOperatingQueue` at the end of `applySandboxActionInner`,
after the rise is committed to `market_positions` — frozen operated prefix, not-yet-operated tail re-sorted on current
positions, membership fixed at the opening; the #746a overlays retire. ~~Fable High (cursor semantics)~~ **Opus** (owner
model policy, 2026-09-16: Opus is the default for every Stage-8 slice).
**RESOLVED by Slice 8.1 (2026-09-16, #1600; `STAGE8_AUTHORITY_DESIGN_2026-09-16.md` §2.8).** One settle point —
`applySandboxActionAfterAuction`, immediately after the chart step, the core (arm, round transition, cursor), the
committed sold-out rise and the par reconcile — calls `settleOperatingQueue(before, after)` (`operatingOrder.ts`). On the
entry that opens a round (a non-OR round closing into one, the next OR of a set, or a queue rebuilt in place —
`operatingRoundOpenedBetween`) the whole new queue is re-sorted by the exported §6.0 comparator on the COMMITTED chart
and the table is re-seated at the new head (`syncSeatToActingCorporation`, moved into `operatingOrder.ts` unchanged). The
#746a overlay is removed rather than preferred, so there is one source for the order. Proved by
`operatingQueueSettle.test.ts` cases 1–5 and 14b (overtake by a rise; queue = §6.0 sort of the committed positions;
rightmost; uppermost; one-cell stack; replay and seat). Corpus: digest-identical at every entry of all 18 files; FCJ 885
settles to PRR, B&O, B&M as stored. Replay-semantic in principle — the 5 → 6 bump stays owed at Slice 8.5. UI: U-34.

**S8-2. Presidency tie among equal challengers is decided by `player_holdings` order, not clockwise from the incumbent.**
Status `RESOLVED` — **Slice 8.3** (2026-09-17, #1620; committed `02a9838`). *(Was `OPEN`.)*
Rulebook §5.4. Notes: audit M10; `gameEngine/presidencyTransfer.ts` (`presidentFor`,
strictly-more rule, `find` in seating order); `settlePresidencies` in `sandboxSession.ts`. Replay:
replay-semantic only when two challengers tie above the incumbent — bump. Detail: order challengers by seat
distance clockwise from `company.president` (the deal's roster order), pick the first with strictly more than
the incumbent; ties *with* the incumbent keep the incumbent (unchanged). Stage 5's forced-sale protection
(`forcedSaleRefusal` case c) projects `presidentFor` and inherits the fix automatically. Test: three holders at
20/20/20 after a president's sale with the incumbent at 10 — the clockwise-next seat takes it. Audit test gap:
`presidencyTransfer.test.ts` has no tie-order case.
**Stage-8 design pass (`STAGE8_AUTHORITY_DESIGN_2026-09-16.md` §4).** Helper frozen: `presidentFor(company, seating)` with
`seating = state.player_addresses`; challengers strictly above the incumbent; among tied top challengers the smallest
clockwise seat distance from the incumbent; `settlePresidencies` and Stage 5's `presidentAfterSale` both pass the
roster. No stored log contains a two-challenger tie (every presidency change in the corpus has one challenger), so
the repair is replay-semantic only on a tie. Also found: the `ExchangePrivate` arm never calls `settlePresidencies`
(recorded under S8-10). **Slice 8.3, Opus.**
**Implemented — Slice 8.3 (2026-09-17, #1620; design §4.4).** `presidentFor(company, seating)`; new module-private
`closestClockwise(candidates, seating, incumbent)` is the ONE ordering rule in the file — both holdings-order rules
that stood there are gone, the `eligible.reduce(...)` fallback having been unreachable as well (proof in §4.4).
`d(p) = (seat(p) − seat(incumbent) + n) mod n`, smallest wins; the incumbent's SEAT outlives their percentage, so a
president sold below 20 % is still the origin; seat 0 is the origin only where there is no incumbent. `emergencyFunding.ts`
`presidentAfterSale` gains the roster and is exported, so the forced-sale prediction is asserted EQUAL to what
`settlePresidencies` settles rather than inferred from a refusal string; `forcedSaleRefusal` supplies it.
**Every asker re-traced at `efe4098`:** `settlePresidencies` has exactly two call sites (`sandboxSession.ts` BuyStock
4832, SellStock 4948 — Stage 5's forced sale is that same arm); `presidentAfterSale` is the only projection and already
called `presidentFor`, so there never was a second clockwise implementation to retire; `shareSaleBlock`'s successor
check is an existence test with no ordering and is unchanged; `ExchangePrivate` still does not settle — **left for
Slice 8.4**, which now calls this helper instead of duplicating it; the C&A / PRR grant needs nothing (PRR unparred).
**Seating invariant proven from source, not assumed:** every holder `player_holdings` can name is seated (the reducer's
actor passes `player_addresses.includes`, #549; the M&H grant's holder is the private's owner; the B&O grant's is a
bidder), so the malformed arms exist only so a hand-built fixture cannot make a replay diverge — unseated challenger
sorts last, unseated incumbent counts from seat 0, an unseated table answers by address, never by holdings order.
**Scenario D verified (printed, full rulebook 5.0 p. 34):** president 20 + other 20 + six 10s for the Erie AND the N&W;
the other 20 is a 20 % HOLDING and no presidency, `presidentFor` reads no `double_certificate`, and certificate shape
cannot bias a tie (same board, two rosters, two winners). **Certificate-count audit: correct, left alone, pinned** —
`certificateCardsHeld` counts the other 20 % as ONE card from the card representation, never inferred from the
percentage. **No certificate mechanics modified** (`doubleCertificate.ts`, `shareSale.ts`, `gameState.ts`,
`sandboxSession.ts` byte-identical to `efe4098`). New defect found and FILED, not fixed: **S8-15**.
**Corpus, read-only, nothing repinned:** `presidencyCorpus.test.ts` asks the pre-8.3 selector (copied verbatim) and the
repaired one about the same board at every entry of every log — 18 logs / 3,131 applied entries / 15,054 parred
company-boards; **7 presidency changes** (FCJ 46 / 183 / 388, 3XD 25 / 213 / 290, FCJ-96 46); **0 tied-challenger
boards**; **0 Scenario-D corporations among the changes**; **0 disagreements** → **ZERO replay differences**, every
digest and golden unchanged. Tests: `presidencyAuthority.test.ts` (24), `presidencyLpf.test.ts` (10),
`presidencyCorpus.test.ts` (4), plus two call-site updates and one corrected rationale in the two existing suites.
Mutations M1–M4 (insertion-order tie / seat 0 / incumbent tie transfers / other-20 as two 10s) killed 13 / 3 / 8 / 6;
all restored byte-for-byte. `RULES_ENGINE_VERSION` stays **5** — replay-semantic in principle, corpus-neutral in fact,
and the one Stage-8 bump remains owed at **Slice 8.5**. UI: **U-33** unchanged and still owed.

**S8-3. Operating order is fixed at OR open; §6.1's note (a not-yet-operated railroad whose share value changes uses the new value) is not applied mid-round.**
Status `RESOLVED` — **Slice 8.1** (2026-09-16, #1600; committed `05b5dfc`). *(Was `DEFERRED`.)*
Rulebook §6.1 note. Notes: audit m2; `active_operating_order` /
`active_corporation_index`. Replay: replay-semantic — bump. Detail: decide whether the queue is re-derived for
the not-yet-operated tail after each price movement (dividend step, forced sale during an OR). Interacts with
S8-1 (same code), with the discard queue (#1530, which relies on no price moving while pending — still true),
and with the market-token "operated stack" drawing (#1296), which derives "operated" from the index.
**Stage-8 design pass (`STAGE8_AUTHORITY_DESIGN_2026-09-16.md` §2.4–2.6).** Decided — **owner ruling R4 (2026-09-16) confirms the representation** (frozen round membership + frozen operated / current prefix + dynamically sorted not-yet-operated tail; `active_operating_order` / `active_corporation_index` kept; D-32): the not-yet-operated tail
is re-sorted from `market_positions` at one settle point after every entry; the operated prefix and the operating
corporation are never displaced; the round's membership is frozen at the opening (a corporation that floats between
turns via the M&H exchange joins the next OR, §5.3). #1296's "operated = prefix" stays true. The corpus contains no
mid-OR price movement of a not-yet-operated corporation (the only engine path is Stage 5's forced sale of another
corporation's shares). **Slice 8.1.**
**RESOLVED by Slice 8.1 (#1600).** During a round the prefix `order[0 .. index]` (every corporation that has operated,
plus the one operating) is immutable and only the not-yet-operated tail is re-sorted on the current chart — on every
entry in which a token moved (the forced sale today, a Blood Price under Yellow Sign, any future mover), and never on an
entry that moved no token and opened no round (so a refusal stays a no-op, S8-13's latent chart-step shape excepted until
Slice 8.2). Membership is fixed when the queue is built:
the settle only permutes, so a corporation floated between turns joins the next round (§5.3). Proved by
`operatingQueueSettle.test.ts` cases 6–13 and 14a: a forced sale moves a waiting corporation ahead of / behind another;
the operating corporation's own payout or withhold never displaces it; an operated corporation's price fall leaves the
prefix byte-identical; a walked round operates each member once, the re-sorted head next; a mid-round float is not
inserted; a no-change settle is an identity; the cursor, seat and `turnGuardKey` are stable; two `RoomEngine` replays and
the live reducer agree on queue, cursor, seat, turn key and derived key after every entry. Corpus: 779 Operating Round
boards, every waiting tail already in §6.0 order — no gameplay or digest change.

**S8-4. Sold-out rise iterates `public_companies` in company order; §4.5 says highest-priced token first.**
Status `RESOLVED` — **Slice 8.1** (2026-09-16, #1601; committed `05b5dfc`). *(Was `OPEN` (test gap;
outcome differs only when two risers meet in one cell).)* Rulebook §4.5. Notes: audit m3;
`soldOutRise.ts` (`roundEndSoldOutRises`). Replay: replay-semantic only when two risers land in one cell — bump.
Detail: sort risers by current price desc (then §6.0 tie-break) before moving; pin with a two-riser test
(`soldOutRise.test.ts` covers one riser only). **Stage-8 design pass:** confirmed — `withArrival` stamps the arrival
in walk order, so two risers into one cell stack in `public_companies` order; no two risers share a cell anywhere in
the corpus. **Slice 8.1** (mechanical; Opus-safe on its own).
**RESOLVED by Slice 8.1 (#1601).** `roundEndSoldOutRises` sorts the risers by the §6.0 comparator on their PRE-rise marks
(share value desc, then rightmost column, uppermost row, earliest arrival, company id) and the reducer commits them in
that order, so the highest-priced token moves first and two risers from one cell keep their stack order whatever
`public_companies` says. Pinned in `soldOutRise.test.ts` "the risers move in share-value order, not catalog order (#1601,
S8-4)": two risers in one close; higher price first (and rightmost first on a tie); identical chart, rise list and queue
with the catalog order reversed; two risers from one cell land in one cell; the top token stays on top in both catalog
orders. Closes S10-18's rise-order gap. No corpus log has two risers in one cell.

**S8-5. Home token is placed at float during the Stock Round, not at the start of the corporation's first operating turn.**
Status `RESOLVED` — **Stage 8 Slice 8.2** (2026-09-16, Opus, design notes #1610 / #1612 / #1614 / #1616; committed `efe4098`). *(Was `OPEN` — owner ruling 2026-09-16 (Stage-8 brief): move the obligation to the start of the

corporation's first operating turn (was `DEFERRED` pending that ruling).)* Design: `STAGE8_AUTHORITY_DESIGN_2026-09-16.md` §5 (state model), §8 (corpus
divergence table), §9 (replay strategy) — **Slice 8.2, Opus** (owner model policy, 2026-09-16; was Fable High), absorbing S8-6, S8-12 and S8-13. Rulebook §6.3.1;
§6.3.2 ("may not block the home station of a railroad that has not yet operated"). Notes: audit M15; #769
`pendingHomeTokens`, `homeTokenBlock`, `homeReservationStands` (UI side), `placeHomeStationToken`. Batch 3 §2
proved the FCJ idx-95 fix does not depend on timing. Replay: moving the obligation is replay-semantic (every
stored log carries `PlaceHomeStation` during the SR) — bump; keeping it is a documentation change.
Detail if moved: the obligation becomes "first message of the corporation's first OR turn" (`openingSubPhase`
gate), Erie's slot choice moves with it, and blocking through the home city can no longer happen one OR-turn
early. Delayed-Auction and herald-home (#1302) paths must be re-checked with whichever choice is made.
**Stage-8 design pass — corpus facts (sweep `_to_delete/stage8_sweep.json`).** All 44 stored `kind: "home"`
entries are Stock Round entries on the corporation's own home hex; the 19 applied ones sit immediately after the
float; between each applied placement and that corporation's first OR turn **no entry lays, tokens or runs through
the home hex**, so re-timing the token changes no route or station legality and no OR order anywhere in the corpus.
Frozen model: the obligation is derived on the cursor (OR ∧ operating corporation ∧ floated ∧ non-herald ∧ no token);
the hold is turn-local (only that president's controls; nothing in a Stock Round; `nextDerivedAction` silent);
#769 / #769a seat mechanics retire; the four holds move in front of the chart step (S8-13); reservation code
(`homeReservationStands`) is already rulebook-correct and unchanged. Replay: version-6 reducer refuses an SR-time
placement outright; the development corpus replays through a `legacyHomeTokens: "defer-to-first-turn"` adapter
(4.6's `legacyExcessTrains` shape, D-9) that supplies the players' recorded hex / circle at the first turn — CV4
goldens re-baseline field-only (tokens absent between float and first turn), Z6C's 7.5 freeze lifts at 34 and 3XD's
at 290 (re-pins with reasons at Slice 8.2). Without the adapter every completed-game fixture would freeze at its
first OR turn (CV4 at 27). **Owner ruling R3 (2026-09-16, D-31):** the adapter is approved in its "last recorded
historical choice on a legal home hex" form; the remembered choice is DATA only — the synthetic first-turn placement
must pass the CURRENT authoritative home-placement predicate on the then-current board, an obsolete / now-illegal
choice is never forced through (no placement is synthesized; the normal home hold stays in force); development-corpus
only, never production compatibility; the CV4 field-only re-baseline and the Z6C / 3XD corrections are accepted.
**RESOLVED by Slice 8.2 (2026-09-16; `STAGE8_AUTHORITY_DESIGN_2026-09-16.md` §5.9 / §5.10 / §8.1).** The obligation is
derived on the cursor (`homeStationAuthority.ts` `owedHomeStation`: OR ∧ operating corporation ∧ floated ∧ not a herald ∧
no station token ∧ a candidate home on this board) — no stored flag. Floating in a Stock Round owes nothing, holds
nothing and places nothing; #769 / #769a retired (the float purchase advances the seat; the placement moves no seat, pass
streak or `turn_action_taken`); a corporation floated mid-OR owes nothing until its first turn in a later round; a
corporation that never reaches a turn never touches the map. The hold is turn-local (S8-12 below), `nextDerivedAction`
derives nothing while a home is owed, and the prompt (`pendingHomeTokens(state, table, mapGrid)`, #1616) appears at the
first turn with only the legal choices (U-32). The development corpus's R3 adapter (#1614 / #1614a, D-31) supplies every
recorded choice at its corporation's first turn — all 28 supplied homes in the 18 corpus files land; CV4's goldens are
unchanged; the Z6C (34), 3XD (290) and FCJ (903) float-time freezes lift. Measured: at every one of the 3,103 stored
entries the replay equals the pre-8.2 engine with each home placed at its float from the same recorded choice, station
tokens aside. Tests: `homeStationAuthority.test.ts`, `legacyHomeAdapter.test.ts`; re-pins with reasons in design §5.10.

**S8-6. `PlaceHomeStation` hex and circle are not validated in the reducer.**
Status `RESOLVED` — **Stage 8 Slice 8.2** (2026-09-16, Opus, design notes #1611 / #1615; committed `efe4098`). *(Was `OPEN` (independent of S8-5; can be done first).)* Rulebook §6.3.1. Notes: Batch 3 §3; `sandboxSession.ts`

`placeHomeStationToken` accepts any hex for a single-home corporation ("keeps replaying to wherever it
recorded") and does not check the circle against occupancy / #858's lock; `homeReservedCityIndex` (#1511) is the
reader to reuse; validate against `home_hex_label`. Replay: refusal-only on hand-crafted messages; sweep before
claiming the corpus contains no wrong-hex placement — bump anyway if any stored entry would now be refused.
**Stage-8 design pass:** swept — **no stored placement is off its home hex** (44 / 44 on `homeHexesFor`), so the
validation refuses nothing historical. Predicate frozen (`STAGE8_AUTHORITY_DESIGN_2026-09-16.md` §5.4): hex ∈ `homeHexesFor`; circle = the
hex's one city, or for Erie **either** free circle (not only the badge-nearest one `homeReservedCityIndex` holds
against others); no tile required on E11 / E19 (§6.3.1 note); the D&H free station (`kind: "dh"`, 3XD 115) shares the
arm and is exempt from the home rules (and should stop being prepended at `station_token_hexes[0]`). **Slice 8.2.**
**RESOLVED by Slice 8.2 (2026-09-16; design §5.9).** One predicate, `homePlacementRefusal(state, placement, mapGrid,
table)`, asked by the reducer's `PlaceHomeStation` arm and by ingress: the corporation exists, is not a herald, has no
home yet, has a home on this board, is floated and is operating now; the hex is a candidate (the printed home; Erie's and
PMQ's one OO hex; C&O's Cleveland F6 or Richmond K13 under the Level Playing Field); on a grid the circle is named where
the hex has several, #858's locked circle holds for a fixed home on a two-city hex (NNH), and the circle must be free by
`evaluateStationPlacement` (occupancy, allowance, other corporations' reservations). No tile is required (NYC E19, Erie
E11, PMQ E5); connectivity is not asked; the message's coordinates are judged, never trusted. Printed Scenario D rechecked
(design §5.1a): **Richmond reserved, Cleveland blockable** was already encoded by #1325 (`enforced: false` on F6) and is now
pinned as authority (`homeStationLpf.test.ts`, the brief's 16 C&O points); N&W is a fixed home at Norfolk L16; LPF prices
the home $0 and every later ordinary station $100, Classic unchanged. The D&H's `kind: "dh"` station is judged by neither
this predicate nor the home slot (#1615: appended, free) — which incidentally lets the LPF C&O use the D&H power #1325's
two-home check used to refuse. The D&H's own rules are not re-judged at either lock (S9-12; **RESOLVED** by Slice 9.4b, 2026-09-19).

**S8-7. No "no sales in the first Stock Round" rule in the reducer.**
Status `RESOLVED` — Batch 7.2 (#1570): `stockSaleRefusal` rule 3, `isFirstStockRound(state)` =
`current_round_type === "StockRound" && macro_round_number === 1`, which is the first Stock Round on BOTH boards
(standard: the auction is macro round 1 and `OpenStockRound` leaves the number where it is; delayed: the deal
opens on SR1 with the same number and the inserted auction takes the next one, so the SR after it is macro round
3 and sales are allowed). Tested both ways. No corpus entry is affected.
*(Original finding: **absorbed by Stage 7, Batch 7.2**)* (owner ruling Q2, 2026-09-15; design §7.2 `stockSaleRefusal` rule 3;
the Delayed-Auction SR1 counts as the first Stock Round). Audit **M7**. Rulebook §5.1. Notes: `shareSaleBlock` (`shareSale.ts`), `SellStock` arm; the
Rules Reference already shows the ban only when `roundLabel` parses as SR1. Replay: refusal-added; bump.
Detail: refuse when `macro_round_number === 1 && current_round_type === "StockRound"`; Delayed-Auction tables:
refuse only the first SR, not the SR after the auction. Stage 5's forced sale cannot occur in SR1 (no OR yet).

**S8-8. Shares of an unparred corporation (C&A's PRR 10%, M&H's NYC 10% before a president) can be sold, priced at the $67 nominal fallback.**
Status `RESOLVED` — **the sale half by Batch 7.2** (#1570) **and the projection half by Slice 8.5** (2026-09-17, Opus,
design note #1640; committed `0b23b1e`). *(Was `OPEN`.)* **What 8.5 closed:** `sharePriceFor` no longer falls back to the $67
nominal. An **unparred** corporation now has no price on EVERY board — pinned or legacy — because "unstarted, so
unpriced" is a fact about the corporation and not about which engine dealt the board; a **parred** corporation with no
chart mark keeps Batch 7.2's §7.2-rule-5 split (`null` on a pinned board, the legacy nominal otherwise, so a
pre-versioning log replays exactly as it always did). `forcedSaleRefusal` gained a price-null refusal ahead of the
"only enough" arithmetic — rule 4's sentence for an unparred corporation, rule 5's otherwise — and `legalForcedSales`
SKIPS a corporation it cannot price rather than offering the president a sale at a figure nobody chose.
**Corpus-neutral, measured**: no board in the development corpus carries a standing emergency-funding obligation, so
the 6.6.3 projection is never reached on it; `emergencyFunding` / `shareSale` / `stockTransactionAuthority` /
`batch51` / `batch52` / `emergencyTrainFlow` / `forcedDivestment` / `presidentCertificateSale` all green (209 cases).
The reducer's own `SANDBOX_NOMINAL_SHARE_PRICE` remains as the other atom's legacy/chartless last resort, named and
documented; `stage85Matrices.test.ts` audit **A6** pins that no `?? 67` survives anywhere in the engine.
*(Original status, kept for the record: the sale half is closed by `stockSaleRefusal` rule 4, which refuses any sale
of a corporation whose `par_value` is null — the C&A/M&H case without a variant-specific duplicate rule, since an
unparred corporation has no price for a sale to be settled at and that is true of every share of it however it was
come by. Rule 5 additionally refuses a sale on a **pinned** board when the corporation has no `market_positions`
entry, so the `priceOf` nominal was already unreachable there; the `priceOf` fallback ITSELF, and the `sharePriceFor`
projection that shared it, were what stayed Stage 8's.)*
*(Original finding: the sale half absorbed by Stage 7, Batch 7.2)* (owner ruling Q2: a C&A/M&H-granted share cannot be
sold before the corporation is parred — design §7.2 `stockSaleRefusal` rule 4); the `priceOf` fallback prose stays
here for Stage 8. Audit **M8**. Rulebook p.15 (cannot be sold until the president's certificate is bought).
Notes: `applySandboxMarketAction` `priceOf` fallback (`SANDBOX_NOMINAL_SHARE_PRICE`), `shareSaleBlock`. Stage 5's
`sharePriceFor` uses the same `?? 67` fallback for legal-sale projection — a forced sale of an unparred share is
therefore projectable today (refused only once this lands; note it in the emergency tests). Replay:
refusal-added; bump. Detail: refuse a sale when `par_value` is null; `priceOf` must not fall back on a sale.

**S8-9. Par value from the message is not validated against the ladder; an IPO buy on an unparred corporation is silently converted to the president's purchase.**
Status `RESOLVED` — Batch 7.2 (#1570). `isPresidentPurchase` reads the CORPORATION (`source === "Ipo"`, no
president, no established par) — never the message — and for that purchase `priceStockPurchase` requires a par
that is present, whole, and a par cell of the chart in effect (`parLadderRefusal` / `parBoxCellFor`, one source
for the ladder, the mark and the price), requires the 20 % card to be in the IPO, requires `quantity === 1` and
refuses the LPF double, and charges exactly 2 × par against a cash check. **There is no $67 fallback**: an IPO
purchase of an unparred corporation without a valid par is refused, never converted. `SetBoPar` is hardened with
the same `parLadderRefusal` (rulebook p.27: the certificate is free, the par is still a par box) while keeping
`boPresidencyRefusal`'s ownership and presidency preconditions and charging nobody. No corpus entry carries a
forged or off-ladder par, so this costs nothing historically.
*(Original finding: absorbed by Stage 7, Batch 7.2)* (owner ruling Q2/Q4, 2026-09-15; design §7.2 rules 3–4: the
president's purchase requires an integer par on a legal par cell of the chart in use, the certificate in the IPO and
exactly 2×par in cash; an ordinary IPO purchase prices from the stored par and ignores the payload; no $67
fallback). Audit m8. Rulebook §4.2 / §5.2 (67/71/76/82/90/100). Notes: `BuyStock.par_value`,
`ctx.parValue ?? 67`, `PAR_VALUE_LADDER` (`marketGeometry.ts`). Replay: refusal-added; bump. Detail: refuse
`par_value ∉ PAR_VALUE_LADDER`; require it on a president's purchase.

**S8-10. M&H exchange always takes the IPO share before the pool.** *(The heading is the original finding's;
the defect is far wider — see the Stage-8 design note below.)*
Status `RESOLVED` — **Slice 8.4** (2026-09-17, #1630/#1631/#1632/#1633; committed `fc5a575`). Was
`OPEN` — audit m6. Rulebook p.11 ("from the bank or the pool"). Notes: `resolvePrivateExchange`,
`ExchangePrivate` arm. Replay: replay-semantic if a `source` is added (default must reproduce today's choice) —
bump. Detail: add `source: "ipo" | "pool"` to `ExchangePrivate`; default IPO for legacy entries.
**Stage-8 design pass (2026-09-16, `STAGE8_AUTHORITY_DESIGN_2026-09-16.md` §6) — the finding is wider than the source.** The message
**already carries `source: "Ipo" | "Bank"`** (`messageSchema.ts`; 3XD 288 records `Ipo`), so no default is needed.
What is wrong is that the reducer's arm (`sandboxSession.ts` `isExchangePrivateMsg`) applies the message and
re-derives nothing: ownership, the 60 % cap, the certificate limit, share availability (`applyPrivateExchange` clamps
with `Math.max(0, …)`, so an empty pile **mints** a share), the corporation (`company_id` is message-carried),
`keep_open` (on the wire — a client could keep the M&H open), the timing window (rulebook p.27: the owner's own SR
turn or between turns in either round), the float threshold (`applyFloatThreshold` runs only in the `BuyStock` arm —
**corpus: 3XD 288 takes NYC's IPO 50 → 40 %, 60 % out, and NYC does not float until 289's purchase**) and the
presidency (`settlePresidencies` not called; §5.4 "immediately"). Ingress asks only "is the M&H yours"
(`roomMessageRefusal`). Frozen design: `privateExchangeRefusal` asked by the reducer and by `turnRefusal`; the arm
then exchanges, settles the float through a shared `settleFloat`, and settles the presidency with the S8-2 helper;
no seat, pass-streak or purchase change (owner ruling R1 — ~~proposed default~~ **ruled 2026-09-16**: an interjection); pool offered as a
choice (owner ruling R2). Replay: 3XD 288 transient only (NYC floats one entry earlier). **Slice 8.4, Opus** once
R1 / R2 are ruled ~~(Fable if R1 ≠ default)~~ — **both ruled 2026-09-16** (design §0; D-29 / D-30).
**Owner rulings R1 / R2 (2026-09-16).** *R1:* the exchange is a free interjection — it does not consume the Stock Round
certificate purchase, does not set or consume `bought_this_turn`, does not change the Sell → Buy → Sell structure, does
not reset or alter the consecutive-pass streak, does not move Priority Deal or the seat, and is not the player's
normal Stock Round action. *Timing:* the rulebook's "between turns" is supplied by the players at a table, but **the
server has no persistent between-turns state** (it advances from one turn to the next at once), so: a request made on
the owner's own Stock Round turn or at a genuine server-visible turn boundary executes immediately if legal; a request
made while another player's or corporation's turn is already underway is **queued** as a pending M&H exchange request —
never executed mid-turn, never interrupting the actor — and executes automatically at the **next legal between-turns
boundary**, where the whole exchange is **revalidated** against the authoritative board and retired / refused cleanly if
no longer legal. **No transition-time M&H prompt** is wanted: the request is player-initiated and the game never pauses
a transition to ask. Mandatory holds and atomic resolution (discard, funding, pending bilateral offer, home obligation,
any other hold) take precedence; a queued exchange settles after the blocking obligation resolves, at the next valid
boundary. This supersedes the design pass's earlier "in an Operating Round, any time" wording. If the turn state cannot
identify the boundary without a small explicit field, Slice 8.4 proposes the smallest deterministic addition. *R2:*
when both the IPO and the Bank Pool hold a legal 10 % NYC share the owner chooses the source; if only one is legal, only
that one is offered; no silent IPO-first. STATE VISIBILITY and the source choice are U-35's. *Queuing vests nothing
(owner, 2026-09-16; D-29, U-35's gotcha):* Slice 8.4 must pin that a request queued during another corporation's turn
expires without effect when that turn's first 5-train purchase closes the M&H before the next boundary — no NYC share
is delivered — and likewise when the NYC share or another legality condition is gone by settlement.
**Implementation (Slice 8.4, 2026-09-17, #1630; design §6.8).** A new `gameEngine/mohawkExchange.ts` holds the whole
authority and the reducer states no M&H rule of its own: `mhExchangeRefusal` (the private is the M&H, open,
PLAYER-owned, the message's `player` is that owner and the ingress actor is that player; the target is NYC;
`keep_open` absent or false; the source is a valid enum whose pile physically holds an ordinary 10 %; the resulting
NYC holding is inside the 60 % cap with its Orange/Brown waiver; the resulting certificate position is inside the
limit; the round is a Stock or Operating Round), `mhExchangeRequestRefusal` (that, plus "one pending request at a
time" — a second request is refused rather than silently overwriting the first's chosen source),
`mhExchangeDisposition` (own Stock Round turn → execute; anything else → queue), `applyMhExchange` (share from the
NAMED pile, M&H closed, float settled, presidency settled — one write, no partial state) and `settleMhExchange`
(revalidate with the same predicate; execute or retire; clear). **Ingress and the reducer's arm ask the same
predicate** (`turnRefusal`'s sandbox-only branch, beside `SetBoPar` and `PlaceHomeStation`), so a forged or replayed
message cannot mint. **The state is one optional field**, `pending_mh_exchange: { player, private_id, company_id,
source } | null` — intent only: no timestamp, no reserved certificate, no cached legality. **Settlement runs at two
boundaries**: the first line of `advanceCorporation` (#1632 — the only place a corporation's turn ends, and ahead of
every operating-order build inside it) and `seatBoundaryExchange` wrapped around `applyOneAction` inside
`settleRoundTransitions`'s argument (#1633 — so a float settled at the end of a Stock Round is in the Operating Round
that opens). **The float helper moved** from the `BuyStock` arm to `floatThreshold.ts` and is re-exported
(#1631); ordinary `BuyStock` behaviour is unchanged by construction. **The holds keep their authority unchanged**:
`ExchangePrivate` is on no hold's pass list, so a request under a hold is refused by the hold and records nothing,
and a queued request cannot settle under one because the `PassTurn` that would cross the boundary is itself refused.
**Corpus (read-only, 18 logs / 4,105 entries):** two stored `ExchangePrivate` rows, both M&H → NYC from the IPO;
`export/JUNO-Y8V` @10 is removed by a `RevertTo` and never replays; `export/JUNO-3XD` @288 is ACCEPTED and executes
immediately (its owner's own Stock Round turn), NYC floats there instead of at 289 (treasury 0 → 900, bank
10085 → 9185), and a fork replayed through the remaining 34 entries **converges at 289 with identical final boards**.
`RULES_ENGINE_VERSION` remains 5; the Stage-8 bump is Slice 8.5's.
**Follow-up at owner review (2026-09-17, #1634): the pre-presidency exchange.** p. 15 / p. 27 allow the exchange
before NYC's President's Certificate has been bought; audited and pinned (authority suite §13, 7 cases). It was
**already legal and already correct** — the exchange leaves NYC unstarted (no par invented, no presidency crowned,
the President's Certificate still in the IPO, no cash moved, no Stock Round marker touched), and the delivered 10%
is unsellable until NYC is started by the EXISTING 7.2 authority (`stockSaleRefusal` rule 4, written as the board
fact under S8-8), which permits the same sale once NYC is parred. **No M&H-specific sale rule exists or was added.**
`ordinaryPurchaseRefusal` was traced and carries none of the ordinary-purchase restrictions (no
President's-Certificate-first, no par, no affordability, no per-turn count, no sold-this-round). The one narrowing
the audit surfaced: `mhSourceRefusal` asked `ordinaryPercentIn`, which subtracts only the LPF 20% card, so a
hand-built board whose NYC IPO held just the President's 20% would have been handed a 10%. It now asks
`ordinaryPercentAvailable` (`stockTransactionAuthority.ts`) — the same physical-availability reading
`stockPurchaseRefusal` asks — and imports no purchase-side helper. Unreachable in ordinary play; the corpus sweep is
unchanged. **Bank Pool before par is unreachable** (every route into the pool is a sale and rule 4 refuses every sale
of an unparred corporation), so no special pre-par Pool rule is needed and none was invented.

**S8-15. The presidency exchange cannot represent a Scenario-D successor who holds the other 20 %.**
Status `RESOLVED` — **Slice 8.3** (2026-09-17, #1622; committed `02a9838`). *(Was `FILED` for a later
slice; **owner ruling 2026-09-17 moved it into Slice 8.3** and required it before the 8.3 commit.)* Rulebook §5.4
("He gives you two of his certificates for that corporation"); full rulebook 5.0 p. 34 for the certificate mix.
Notes: `presidencyTransfer.ts` `settlePresidencies`, `doubleCertificate.ts`
`withPresidencyCertificateExchange` / `needsDoubleForPresidencyExchange` (#1622), `ordinaryPercentHeld` (#1324),
`certificateCardsHeld` (#1374).
**The defect.** `settlePresidencies` wrote ONE field (#596a) and let `certificateCount` derive the cards — exact in the
printed game, where the successor always has two 10 % cards to hand over. Under Scenario D a successor can hold the
printed other-20 **and less than 20 % besides**, and then §5.4's swap is the other-20 card FOR the President's card,
which moves `double_certificate`. Nothing did, so an Erie successor on 30 % (other-20 + one 10 %) was credited with two
20 % cards and the corporation's eight pieces of card read as nine. WHO presided was already correct (S8-2).
**THE DURABLE RULE (owner ruling 2026-09-17).** *Scenario-D Erie / N&W presidency transfer:* use two ordinary 10 %s for
the normal exchange when the successor has them; if the successor instead needs the physical other-20 certificate to
provide the required 20 % back to the former president, transfer that certificate **one-for-one** for the President's
Certificate; **percentages do not change because of the presidency exchange itself.** The other 20 % is a real one-card
20 % certificate and is never two imaginary 10 %s.
**Implementation.** Selection and settlement stay separate: `presidentFor` remains the canonical WHO selector and
performs no certificate mutation; the card half is `withPresidencyCertificateExchange(company, successor)` in
`doubleCertificate.ts` — the module whose own rule is that it is the only reader/writer of `double_certificate` — asked
by `settlePresidencies` **before** the crown moves (that is what names the recipient, and what tells
`ordinaryPercentHeld` the successor does not hold the President's Certificate yet), with both halves returned in one
object. **Criterion, from the card representation and never inferred from a percentage:** successor does not hold the
other-20 → normal; `ordinaryPercentHeld(successor) >= 20` → normal, the card stays; `< 20` → the other-20 is the 20 %
handed back, to the former president when they hold ≥ 20 %. No per-certificate inventory was added.
**One shape the ruling's example does not cover, confirmed reachable from source.** `settlePresidencies` runs after the
holdings move, so on a `SellStock` the former president can already be under 20 % (`shareSaleBlock` permits selling
under the block when somebody can take the crown) and cannot hold a 20 % card. The printed sequence there is
exchange-then-sell — they took the other-20 and sold it — so the card goes to the **Bank Pool**, with the percentage
they sold, guarded by the pool holding ≥ 20. Where neither can hold it the card does not move: that board is one the
printed rules refuse before it exists (**S9-14**), and giving the card an impossible home would be #748b's
accommodation rather than a repair.
**Results.** Erie, outgoing on the President's 20 % alone / successor on other-20 + one 10 %: successor presides, the
other-20 becomes the former president's, percentages stay 20 / 30, cards 1 / 2, inventory eight, no phantom ninth.
Erie, outgoing 30 % / successor other-20 + two 10 %s (40 %): successor presides and RETAINS the other-20, outgoing ends
on three ordinary 10 %s, cards 3 / 2. N&W identical on the same code path with its own standing regression. Successor
without the other-20, and the 20 v 20 tie: unchanged. Reducer paths: one `BuyStock` (the other-20 holder buys a 10 %,
reaches 30 %, takes the crown and hands the card back in that dispatch — the only percentage that moves is the bought
10 %) and one naturally legal `SellStock` (the incumbent sells two 10 %s down to the block and receives the card).
**Forced-sale / emergency audit: no change, and why.** No forced-sale legality reads the post-transfer decomposition —
the shortfall is treasury + cash against the train price, `shareSaleBlock` asks `doubleSaleRefusal` of the seller's own
PRE-sale cards, "only enough" is price × `certificatesIn(percentage)` (bundle arithmetic, no card identity), and
6.6.3's guard is `presidentAfterSale`, which is selection only. `emergencyFunding.ts` got nothing beyond S8-2's roster
parameter, exactly as its #1540 note already said ("the double certificate ... happens exactly as in a Stock Round,
because it is the same arm"). Pinned rather than argued.
**Invariants pinned after every exchange:** percentages identical across the exchange itself; exactly one President's
Certificate, always a player and never a pool; exactly one other-20 per Erie / N&W, moved and never created; no holder
credited with more certificate percentage than their `player_holdings`; inventory stays eight cards.
**Corpus (re-run, read-only, nothing repinned).** 18 logs / 3,131 applied entries / 15,054 parred company-boards;
7 presidency changes; 0 tied-challenger boards; 0 Scenario-D corporations among the changes; **0 boards where the
special exchange fires**; 0 legacy-vs-repaired disagreements → **ZERO corpus state/digest changes**.
Tests: `presidencyLpf.test.ts` (21, §4 the exchange / §5 the reducer paths / §5a the projection audit),
`presidencyCorpus.test.ts` (5). Mutations M5 (move the card on every change) and M6 (criterion read off the total
percentage) killed 4 / 5, both restored byte-for-byte. `RULES_ENGINE_VERSION` stays **5**; the one Stage-8 bump remains
owed at **Slice 8.5**. Filed alongside, not fixed: **S9-13**, **S9-14**.

**S8-11. Timing notes, not defects (recorded so they are not re-audited):** m4 float capitalisation is paid on the
purchase that crosses 60 % rather than at the end of the SR (harmless — treasury unspendable before the OR);
m5 divestment debt blocks buying and passing until sold down (stricter than §4.3's "during your next turn" but
not incorrect); m11 bank floor after the break. Status `OWNER DECISION` pending only if the owner wants
rulebook-literal timing; otherwise leave.

**S8-12. O6 — ingress does not mirror the home-token hold, so a held ordinary proposal is appended to the log and then no-op'd by the core.**
Status `RESOLVED` — **Stage 8 Slice 8.2** (2026-09-16, Opus, design note #1612; committed `efe4098`).
*(Was `OPEN`.)* Recorded by the Opus 7.4 matrix (R74-C item (A): "the home-token hold (as a room engine runs it)"
refuses a proposal in the reducer, but `turnRefusal` has no equivalent sentence, so the entry lands in the log as
an identity no-op rather than being `refused` at ingress — S10-1's shape). Not fixed in 7.4 by owner ruling: the
core makes the proposal inert, so no board is wrong; the log carries a dead entry. **Cross-reference S8-5 / S8-6:**
the home-token obligation's timing and validation are this stage's, and ingress and reducer must be repaired
together so the hold's sentence, its pass list and its ordering against the discard, funding and offer holds
(#1530 / #1540 / #1590) are one rule at both locks. Replay: refusal-added at ingress only (the reducer already
refuses) — no board changes; sweep anyway before claiming no stored proposal sits under a home-token hold.
**Stage-8 design pass: absorbed into Slice 8.2** (`STAGE8_AUTHORITY_DESIGN_2026-09-16.md` §5.7) — the hold's new definition (turn-local, on
the cursor) and its ingress sentence are one predicate (`homeStationHold`) consumed by the reducer, `turnRefusal`
(fourth hold, after the offer hold) and `nextDerivedAction`. Swept: no stored proposal sits under a home-token hold;
the entries that DO sit under one are S8-13's sales.
**RESOLVED by Slice 8.2 (2026-09-16).** `turnRefusal` asks `homeStationHold` as its fourth hold (after discard, funding
and offer; before the consent exemption) with the reducer's own sentence and pass list, and judges a home placement with
`homePlacementRefusal` in the sandbox-only branch; a held ordinary message is refused at ingress and never reaches the log.
Reducer / ingress parity is pinned for fixed homes, Erie, PMQ and the C&O's dynamic set (`homeStationAuthority.test.ts`,
`homeStationLpf.test.ts`, `offerMatrix74Hold.test.ts`).

**S8-13. The chart step runs before the holds, so a held `SellStock` moves `market_positions` for a sale the core refuses.**
Status `RESOLVED` — **Stage 8 Slice 8.2** (2026-09-16, Opus, design note #1613; committed `efe4098`).
*(Was `OPEN` — newly proven by the Stage-8 design pass (2026-09-16).)* Notes: `applySandboxActionAfterAuction`
runs `applySandboxMarketAction` before `applySandboxActionCore` (#1197); the chart's `saleRefused` asks
`stockSaleRefusal`, which contains no hold; the discard (#1530), funding (#1540), offer (#1590) and home (#763) holds
are asked only in the core. Corpus: **server/JUNO-FCJ 904, 911, 918, 932** — `SellStock` entries sent after N&W
floated at 902 with its home owed; each changes `market_positions` and nothing else (the core refused the sale). The
same shape is latent for a player ↔ player trade offer standing in a Stock Round (D-24) and for a discard owed. Rule:
a refused message moves nothing (#748a / #1019). Repair (Slice 8.2): the four holds move in front of the chart step,
in their existing order, and return the board by identity before the chart is asked. Replay: replay-semantic on FCJ
(the four moves disappear) — part of the Stage-8 bump. Test: a held `SellStock` leaves `market_positions` identical.
**Slice 8.1 interaction (2026-09-16).** The 8.1 queue settle follows the chart, so until this repair lands the latent
Operating Round form of the defect (a forced sale sent under a hold its predicate does not ask, e.g. an ordinary offer
standing at Hardware) would also re-sort the waiting tail on the refused entry. Not reached by the corpus — FCJ 904 /
911 / 918 / 932 are Stock Round entries, where the queue is not settled — and removed with this repair.
**RESOLVED by Slice 8.2 (2026-09-16; design §5.9).** `authoritativeHoldRefusal` (discard → funding / finished game →
offer → home) runs at the top of `applySandboxActionOnBoard`, before the auction atom, the chart step, the core and the
8.1 queue settle; a held message returns the board by identity (#1596's retirement of a refused accepted settlement is
kept). Pinned: a held sale or withhold under the home, offer and discard holds moves no chart token and no other field; a
legal sale still moves the chart; the priority chain (`holdBeforeChart.test.ts`). **The same shape on a third atom, found
by this slice's own check:** the lay's GRID step (`RoomEngine.applyOnBoard`, `App.tsx`'s dispatch) laid a held
`LayTile`'s tile before the reducer refused the lay; both now ask the same predicate (pinned on JUNO-CV4 27 walked
without the adapter). Corpus: FCJ 904 / 911 / 918 become real sales once N&W's float no longer holds the round, and 932 is
refused by the President's Certificate rule with no chart move; no corpus grid changes.

**S8-14. The full rulebook closes the Erie's home hex once tiled; the implementation held one circle, tiled or not.**
Status `RESOLVED` — **Stage 8 Slice 8.2** (2026-09-17, Opus, design note #1617; owner ruling D-33; committed `efe4098`). *(Was `OPEN` — owner ruling; found by Slice 8.2, 2026-09-16, while checking the brief against the attached

48-page rulebook.)* Notes: the full book's base game 7.3.2 (p. 20) lets the Erie start in either city of its yellow hex
and, once a tile has been placed there, lets no other railroad place a station on the hex until the Erie has placed its
home; its variant V-7.3 (p. 32) states the prohibition without the tile condition and applies the Erie's OO rules to the
Pere Marquette on E-5. The implementation held one slot of the OO hex for its owner whether or not the hex was tiled
(`evaluateStationPlacement`'s hex-level reservation arm, "reserving both would over-block it", #1283), so a first foreign
station was legal on a tiled, unhomed OO hex and only the second was refused.
**Owner ruling (2026-09-17, made against the updated revised rulebook and the full 48-page rulebook) — a conditional rule,
for the Erie on E-11 and, under the Level Playing Field, the PMQ on E-5:**
- *Before a tile is placed or upgraded on the OO home hex:* no whole-hex reservation. Ordinary future-home protection
  applies: another corporation may occupy one of the two home cities if otherwise legal, but may not take the last legal
  home city.
- *Once a tile has been placed or upgraded there, until the home is established:* no other corporation may place any
  additional station anywhere on the hex — a whole-hex prohibition, not a one-circle reservation. A foreign station
  legally placed before the tile remains; no further foreign station is added until the home corporation places its home.
- *After the home is established:* the special prohibition ends and ordinary rules govern.
- The Erie / PMQ still chooses either legal city for its free home; no tile is required before the home.
**RESOLVED by Slice 8.2 (2026-09-17; design §5.9).** `closedOoHomeAt(mapGrid, q, r, company, allCompanies)`
(`stationTokens.ts`, #1617) names the home entry that closes a hex to a corporation: another corporation's enforced home
entry on that hex, on a hex where the president picks the circle (`homeSlotsAreOpen` — E11, and E5 under the Level
Playing Field), whose reservation still stands (`homeReservationStands`: no home token yet), with a tile on the grid
there that the board did not print (`printed !== true`, #1301). `evaluateStationPlacement` asks it after the allowance,
city, one-station-per-hex and hex-full checks and before the hex-level reservation arithmetic, which is unchanged and
still gives the before-tile last-city protection. Every reader of that predicate follows: the reducer's gate
(`stationPlacementRefusal`), the veil (`placeableStationHexes`) and the click reason. The home placement is unchanged
(the owner is never refused by its own entry). **Ingress parity:** `turnRefusal` now asks a `PlaceStationToken` the
reducer's two questions in the reducer's order — `operatingIdentityRefusal`, then `stationPlacementRefusal` under the
table's rules — so an illegal paid placement, this one included, is refused with the authority's sentence and never
reaches the log (before this, ingress judged a paid placement only by its seat and the holds). Sentence: "<ticker> has
not placed its home station on <hex> yet and a tile has been laid there, so no other corporation may place a station on
<hex> until it does." Pinned: `homeStationAuthority.test.ts` §29 (Erie, 7 cases) and `homeStationLpf.test.ts` §29 (PMQ,
6), every refusal at both locks; `legacyHomeAdapter.test.ts` (3 S8-14 cases: a remembered circle is still judged by the
current authority on the tiled board). Corpus: no file ever has a non-printed tile on E11 or E5, so the closed window
never opens; no foreign placement targets either hex; for all 32 `PlaceStationToken` entries the new ingress branch's
verdict matches the reducer's outcome (all legal, all placed); every observed board, grid and end state is identical to
the 8.2 tree before this follow-up (18 files; 3,131 observed messages = 3,103 stored entries + the adapter's 28 home
placements). Replay: replay-semantic in principle (a foreign station into a tiled, unhomed OO home hex is now refused)
with no corpus effect; part of the Stage-8 bump at 8.5 — `RULES_ENGINE_VERSION` unchanged.

### Stage 9 — Variants + map data + variant authority

> ## ✅ STAGE 9 IS CLOSED — 2026-09-19, `RULES_ENGINE_VERSION` **7**
>
> **ZERO remaining Stage-9 rules-authority blockers.** Every item below is `RESOLVED`, `RECORDED`, `NOT A
> DEFECT`, a recorded `OWNER DECISION`, or explicitly deferred out of closure scope with that deferral stated.
> The closure pass re-read the ledger to confirm it and did **not** re-audit the code.
>
> | disposition | items |
> |---|---|
> | `RESOLVED` | S9-1, S9-2, S9-3, S9-4, S9-6, S9-8, S9-10, S9-11, S9-12, S9-13, S9-14, S9-15, S9-17, S9-18, S9-19, S9-21 |
> | `RECORDED` — official-material contradiction, not an engine defect | S9-16 |
> | `NOT A DEFECT` — withdrawn | S9-20 |
> | `OWNER DECISION`, recorded and implemented | S9-5 |
> | `DEFERRED` out of Stage-9 certification scope — **pre-launch variant certification still owed** | S9-7 |
> | `DEFERRED` — architecture / Part-C follow-up, never a rules-authority blocker | S9-9 |
>
> **S9-7 IS NOT AUDITED AND MUST NOT BE READ AS SUCH.** Gentle Rust, Unpredictable Revenue and Delayed
> Auction have had no independent variant-spec certification. That certification is outside Stage-9 closure
> and **remains required before any of them is represented as fully-authoritative supported rules.** The
> Yellow Sign rulings recorded at S9-3 are authoritative for the mechanics already implemented; they are not
> a variant audit.
>
> ### The bump, 6 → 7 (#1680)
>
> One deliberate bump for the stage, Stage 7.5's and 8.5's precedent: implementation slices stay on the pin so
> the corpus can be measured slice by slice against one baseline, and the stage takes a single bump at closure
> where the whole set of changes is named in one changelog row. `RULES_ENGINE_VERSION = 7`,
> `SUPPORTED_RULES_ENGINE_VERSIONS` derived `[7]`, `RULES_ENGINE_CHANGELOG` row 7 naming every semantic half:
> immutable/printed topology authority, station anchoring, the LPF M-11 printed straight, #59
> `separateSystems`, the #63 supply and canonical tile identity, Blood Price arrival stamping, D&H
> free-station authority, physical-certificate market movement, authoritative Yellow Sign resolution with
> server-owned committed randomness, the physical-certificate Bank Pool cap, and the corrected Carcosa ghost
> lifecycle.
>
> **The bump is owed even where no corpus file exercises a changed rule.** A version pin states what a log
> MEANS, not how many logs happen to notice. A version-6 log carries tile lays judged without the board's
> printed topology, station placements judged only in the shell, Yellow Sign outcomes chosen by a client and
> market steps walked per ten percent: it is refused, never reinterpreted.
>
> ### The 18/18 reconciliation — MEASURED AT `dea5489`, NOT AT THE TIP
>
> The full canonical 18-file reconciliation was measured at **`dea5489`** (the Stage-9.4d tree plus the
> PrivateTradePanel import fix) against the Stage-9.1 pre-semantic baseline `d837419`, using the existing
> closure harness. **Stage 9.5 landed afterwards and contained replay-semantic production changes**, so the
> table is not a measurement of the tip and must not be presented as one. What makes it still applicable is
> the targeted-presence addendum below, not an assumption.
>
> Totals at `dea5489`: **4,105 stored · 3,103 applied · 1,002 dropped · 0 unparseable · 334 `LayTile`** —
> identical on both sides, and matching Stage 8.5's recorded figures. Every divergence is attributable:
>
> | family | files | cause | effect |
> |---|---|---|---|
> | **A** | 11 LPF logs | **S9-18** — the printed M-11 straight is in the INITIAL grid | the board differs from index 0; **zero** gameplay-state divergence |
> | **B** | 7 files | **S9-1** — `last_run_revenue_seed` recorded by the run arm | transient; self-clears at #777's turn change; no value changes |
> | **C** | `export/JUNO-3XD` only | **S9-12** — entry 115, `PlaceHomeStation{kind:"dh"}` on an unfloated NNH | **permanent, intended** — see below |
> | **D** | 10 files | **S9-12** — `dh_station_pending` written as `undefined` | field-digest shape only; `stateDigest` agrees everywhere |
>
> **Family C is the one real permanent gameplay divergence and is recorded as such, not as neutrality.** The
> entry is refused on BOTH sides for the same pre-existing reason (NNH is unfloated; no token is placed either
> way, and the corporation is byte-identical). But the **baseline still consumed the D&H's power while
> refusing the action** — `used_private_abilities` became `["dh-token"]` — and Stage 9 refuses the message in
> `dhStationAuthority` ahead of every mutation, so it stays `null`. Baseline final `["dh-token"]`, Stage-9
> final `null`; the divergence begins at chain position 116 and never reconverges. That a refusal spent the
> private's one free station is precisely the defect S9-12 fixed.
>
> **The four special reconciliation items, discharged.**
> **S9-13** — the owed canonical 18/18: exactly one `SellStock` against a Scenario-D company in the whole
> corpus, `server/JUNO-FCJ` index 851 (ERIE, 30 %), with ERIE unfloated so the sale is refused upstream;
> `server/JUNO-FCJ` has **zero** state divergence at any entry. No stored replay changed.
> **S9-1 / JUNO-Z6C** — the two stored `YellowSignEvent` entries (both index 203, `server/JUNO-Z6C` and
> `fixture/JUNO-Z6C-494`) sit on unpinned boards, carry `stage`/`model`/`cash` and no `revenue_seed`, and take
> the legacy stored-outcome branch keeping #1046's zeroing. Server seed normalization is **live-ingress only**
> (`RoomSession.submit`, before the append) and is never re-run during replay.
> **S9-11** — no `BuyTrainFromCorporation` anywhere in the 18 sells a train the seller's `carcosan_trains`
> names, so the Blood Price landing is never exercised; arrival stamping is corpus-neutral.
> **S9-12 / JUNO-3XD** — family C above; refused for the flotation reason on both sides, but **not** a full
> no-op.
>
> ### Stage-9.5 targeted-presence addendum — why the reconciliation remains applicable
>
> Stage 9.5 (`67a3123`) made two replay-semantic production changes after the table was measured. Neither was
> assumed neutral; both were measured by targeted presence checks across all 18 canonical files.
>
> **S9-8, the physical-certificate Bank Pool cap.** 15 `SellStock` entries across the corpus; **zero divergent
> sites**. The non-president 20 % certificate never reaches a Bank Pool in any applied stored sale — it is
> bought out of the IPO in `server/JUNO-FCJ` from index 674 and stays with the player — so at every one of the
> 15 sales the certificate count equals `bank_pool_percentage / 10` and no seller holds the double. The only
> Scenario-D sale is FCJ 851, refused upstream.
>
> **S9-2, the Carcosa ghost lifecycle.** **0 Carcosa gifts, 0 fog events, 0 Blood Price Carcosa transfers, 0
> observations of `ghost_trains` or `carcosan_trains`, and no real Diesel purchased in any file.** No stored
> history reaches the changed lifecycle at all.
>
> **Therefore Stage 9.5 is corpus-neutral for the canonical set, and the `dea5489` reconciliation remains
> applicable at the tip.** The full 18/18 was deliberately NOT re-run at closure.
>
> ### Replay goldens
>
> `replayGolden`, `replayJunoCV4` and `replayJuno3XD` were green before Stage 9.5, green inside its implicated
> matrix, and green again after the 6 → 7 bump. **Nothing was repinned at closure.** The only two goldens
> re-pinned anywhere in Stage 9 are Slice 9.2's `JUNO-CV4.json` and `JUNO-G6J.json` (+1 grid entry each, the
> printed M-11 tile, pure insertion, reason recorded in the 9.2 row).
>
> ### What closure does NOT cover
>
> Part-C / readiness items derived from Stage 9 remain open and separate, and are **not** marked complete:
> **U-38** (canonical tile numbers on three player-visible surfaces), **U-39** (two percentage-based Bank Pool
> room readers, both conservative), **U-40** (Project 18XX / Project 18XX+ naming, player-facing "1830"
> cleanup, the Rules Reference's standing as final authority, provenance/credits carve-out), **U-8** (the
> seventh seat colour), the **U-19 … U-31** block, and **S9-9** (the engine's upward import of `components/`,
> architecture). None of them blocks rules closure. Stage-10 items **S10-1 … S10-25** are untouched and remain
> Stage 10.


**S9-1. ~~`YellowSignEvent` is client-authoritative.~~ The Yellow Sign outcome AND its input are authoritative.**
Status **`RESOLVED`** — Slice 9.4d, 2026-09-19 (#1661 the outcome, #1662 the input). *(Was `OPEN` / **HIGH
PRIORITY**: Stage 2 commit message; `messageSchema.ts` #1451 recorded it as deferred.)* **Direct client outcome
selection is removed, the turn's draw is the server's at hosted ingress and committed for replay, and `debug_force`
cannot be used by an ordinary hosted client.**

**Confirmed root cause.** `YellowSignEvent` carried the OUTCOME of a random event: `stage`, `model`, `cash` and
`revenue_seed`. The live path — normal `App.tsx` → the Yellow Sign block in the `RunMultipleRoutes` narration →
`messageSchema` shape validation → `RoomSession.submit` → `applySandboxAction` → the same reducer the server runs —
shape-checked those four fields and applied them. So an ordinary hosted client chose which stage fired, which
corporation's train left, how much the treasury gained, whether a corporation became Carcosan, which trains were
exempt from the limit, and when the doom clock started. The defect was not that the figures were implausible; it was
that a client got to choose among the plausible ones, and the variant's whole premise is that exactly one of them is
the right one. Classification **A — real game-rule authority defect, HIGH.**

**Final authoritative design (#1661, `yellowSign.ts` / `sandboxSession.ts`).** `resolveYellowSign(board, protocolId,
phaseTier, {force})` derives the whole outcome from the committed board, and the message becomes a REQUEST
(`{game_id, protocol_id, debug_force?}`). No new randomness primitive: the turn's draw is already #1051's committed
roll — drawn once in the shell, written into `RunMultipleRoutes.revenue_seed`, replayed rather than re-rolled — and
the only new state is `last_run_revenue_seed`, that same number copied onto the corporation by the run arm so the
reducer can reach it at the `YellowSignEvent` that follows. It is the fifth turn-scoped figure and is cleared by
#777's turn-change rule beside `last_route_revenue`, because a seed outliving its turn would price the next turn's
sign against the last turn's roll — the one staleness that changes *which stage* fires. Every other input
(`printed_route_revenue`, the fleet, `has_yellow_sign` / `is_carcosan` / `carcosan_trains`, the doom clock,
`derivePhase`) is reducer-written board state. The three mutations are unchanged and now live in one shared
`applyYellowSignOutcome`, so the authority split cannot become two sets of Yellow Sign rules; #1421's Mark gate
(a sign already out, or outside phases 2–4) is still the reducer's last word and is asked of both paths.
**The debug force survives and stops being a choice.** #1128's flag named its stage; #1404 already derived the
sequence from the board with `forcedSignStagesAvailable`, and at most one stage is ever available (the three
predicates are mutually exclusive). So the wire carries a BOOLEAN: it waives the chance and the window, and the
board says which stage the waiver lands on. A stale arm now resolves to nothing by construction rather than by the
cycle happening to be right.

**Replay compatibility — treatment A, no log rewritten, no ABI migration.** The split is #1551's, already the house
pattern two hundred lines up (a pinned board refuses `RunManualRoute`; an unpinned one still applies it): a board
carrying `rules_engine_version` is authoritative and derives, ignoring the four outcome fields; an unpinned board
applies the outcome it stored, byte for byte. The four fields stay in `messageSchema` and on the `sessionKey` wire
type, optional — dropping them would turn every historical entry into a rejected one. **No stored log replays to a
different board**, so this slice is not replay-semantic and requires no bump: every log in the corpus is unpinned.
That is not a formality — JUNO-Z6C index 203 carries *no* `revenue_seed` and was played under #1046's zeroing, which
a derivation would silently replace with #1375's kept run. An unpinned board cannot be continued in production at all
(`SERVER_REPLAY_POLICY.legacyLogs: "refuse"`), so the legacy branch grants no live client any authority it did not
already have as a fixture.

**Security property.** Forged `stage`, forged corporation, forged `model`, forged `cash` and a forged gift/Carcosa
payload are all inert on a pinned board — pinned by cases 2–5 below, each sending the same request against the same
board and varying only the client's claim.

**Files (both revisions).** Production: `gameEngine/yellowSign.ts`, `gameEngine/sandboxSession.ts`,
`gameEngine/gameState.ts`, `gameEngine/messageSchema.ts`, `App.tsx`, `utils/sessionKey.ts`, `utils/gameHistory.ts`,
and for #1662 the new `utils/serverIngress.ts` plus `utils/roomSession.ts`.

**Focused tests.** New `utils/yellowSignAuthority.test.ts` (10 cases): determinism from one pre-state; forged stage;
forged corporation/train; forged cash; forged gift/fog; the legitimate Mark's full mutation; the derived escalation
and fog on the boards that permit them; the unpinned board replaying its stored outcome; the debug force as a waiver;
and the seed's recording and turn-scoped clear. Three existing suites had their source-scan pins inverted to the new
contract rather than duplicated: `batch48` (the reducer derives on a pinned board, replays on an unpinned one),
`batch60` (the gift branch's new home; the fog dispatch no longer names its stage) and `forcedSignAndRadioBar`
(`debug_force` is a boolean behind the same `sandbox` gate). `gameHistory`'s Carcosan-Railways accolade (#1421) now
reads the stage off the diff (`yellowSignStageApplied`) with the stored fields as the fallback, and #1264's
train-limit suppression treats a `YellowSignEvent` loss as the sign's when the message names no model.
New `utils/yellowSignIngress.test.ts` (6 cases) for #1662: a client-supplied `revenue_seed` (and a client-supplied
turn key) cannot select the committed seed; the normalizer is the commit point and the committed payload is what it
returned; replay consumes the stored seed and an undo does not re-roll it; hosted ingress drops `debug_force`; the
reducer refuses it on a pinned board even if one reached it; and the local sandbox affordance still works on the
unpinned board it was asked for.

**Implicated log.** JUNO-Z6C: two stored entries, one effective. Index 203 (C&O, Mark) replays on an unpinned board
through the legacy branch, unchanged; index 567 (the stale-client second Mark) is reverted at 569 and was already a
no-op under #1421. The 18-file corpus sweep (`moneyConservation`) and `replayJuno3XD` are green.

**Version consequence.** `RULES_ENGINE_VERSION` stays **6** in this slice, and that is a statement about this slice
only. No stored log replays to a different board here, because every log carrying a `YellowSignEvent` is unpinned and
takes the branch it always took — but **absence of corpus divergence is not the closure argument**. The deliberate
**6 → 7 bump remains owed at Stage-9 closure**, where it is taken for the stage as a whole; nothing here discharges
it, and this entry must not be read as evidence that it is unnecessary.

**Both authority holes the first pass left are closed (#1662, second revision of the slice).** They were blockers,
not follow-ups, and neither is deferred.

*(a) The turn's draw is the server's.* #1051 made the die a COMMITTED draw — rolled once, written into the log,
replayed rather than re-rolled — which is a statement about reproducibility and says nothing about authority.
Committing a chosen number does not make it a draw: a crafted client could roll locally until the seed produced the
stage it wanted, submit that one, and every derivation downstream would faithfully reproduce the outcome the player
had picked. The fix reuses #1520's existing server-ingress seam and nothing else — the one line in
`RoomSession.submit` that already replaced the client's `SetupGame` version pin. `normalizeForCommit`
(`utils/serverIngress.ts`) now owns three things there, between the authority gate and the append: the version pin
(#1520, moved inside, unchanged); `RunMultipleRoutes`'s `revenue_turn` and `revenue_seed`; and `YellowSignEvent`'s
`debug_force`. The **turn key is rebuilt from the server's board**, never read off the message, because the key is
what the earlier-draw lookup searches on — a client that could name it could point the search at a turn whose roll
it liked, which is the same defect one field over. The **seed** is then #1051's own rule asked of the server's RAW
log: `seedAlreadyRolled(this.log, key) ?? mintSeed()`, so the undo rule the feature was specified with ("undoing it
should not change their roll, otherwise players would just slot machine their way to +20 %") holds, and holds
better than on the client, whose copy of a room's log can be behind. `mintSeed` is injected like `mintId`,
defaulting to `randomTurnSeed`. **No new RNG architecture** and no derivation of randomness from another
client-selectable field. **Replay never reaches the normalizer**: it runs once, before the append, and a rebuild
reads the committed payload — `RoomSession.restore` replays entries that were normalized when they were first
accepted.

*(b) `debug_force` is gated twice.* Hosted ingress **drops** the field, so it never becomes part of the accepted
entry (dropped rather than refused: the event itself is legitimate and the shell has already narrated it — refusing
would leave a log line with no mechanics). Independently, the reducer honours the waiver **only on an unpinned
board** (`force: !pinned && debug_force === true`), because an ingress filter is a claim about a transport and the
rule has to hold on every client that replays the entry. The split is the same one the outcome already used and it
is exact: a hosted room deals through `link.submit` and the server stamps `rules_engine_version`, so it is pinned;
a Firestore sandbox room deals through `appendSandboxAction` with no server, so it is not. #1128's playtest tool
therefore keeps working in the local sandbox — where it was asked for and the only place it was meant to work — and
is inert in an authoritative room. `App.tsx` arms the chip only on an unpinned board, so the narration cannot print
a forced stage the board will refuse (#1375's narration/board invariant).

*Correction to #1661's branch key, found by closing (b).* Splitting on the pin alone was half an answer: it is right
about the corpus and wrong about a LIVE unpinned board, since a Firestore sandbox room sends the same request shape
as everyone else and those requests would have been read as stored outcomes that are not there. The key is now two
questions — the MESSAGE says which kind of entry it is (a stored outcome NAMES a stage; a request does not) and the
BOARD says whether a client may be believed. Only a stored outcome on an unpinned board is applied as written: the
development corpus, and nothing else. **The legacy replay treatment is unchanged by this** — JUNO-Z6C 203 still
takes the branch it always took.

*Superseded record (for the history):* «#1046, `App.tsx` computes the outcome and submits it; `gameEngine/yellowSign.ts`
(`fogIsDue`), the `YellowSignEvent` arm (~4928), stage "fog" removes a train, applies the Mark, arms Carcosa and the
blood price. Replay: making the server derive it is a redesign of the Unpredictable Revenue pipeline — replay-semantic
for Yellow-Sign rooms only; bump.» The bump the old note predicted did not fall due, because the derivation is gated
on the pin rather than applied to every board.

**S9-2. ~~The Yellow-Sign ghost-train expiry keeps its own automatic round-boundary trim.~~ The Carcosa limit exemption is coextensive with the gilding.**
Status **`RESOLVED`** (Stage 9.5, 2026-09-19, #1672, on the owner's lifecycle ruling). *(Was `DEFERRED`
(variant ruling); Batch 4.6 §2 "out of scope, Part 7".)*

**The original S9-2 theory was WRONG.** It asked whether a ghost expiry that leaves a corporation over the
limit should become a `DiscardTrain` obligation (#1530) like every other discard. No such obligation should
exist: under the owner's rule the expiry of a ghost creates no over-limit condition at all, because the ghost
was never occupying a slot and its removal frees nothing that was in use.

**The real defect, found by measuring the four properties the owner asked about.** Two held — the exemption is
PER TRAIN (`countableTrainCount` is a multiset subtraction) and ordinary trains stayed limit-bound. Two did
not. `ghost_trains` was the exemption and was emptied by `expireGhostTrains` at the **end of the Operating
Round** (#1046's "bypasses train limit checks until the end of the Operating Round"), while
`carcosan_trains` — the gilding itself — outlived it by a full OR set. At that boundary the function cleared
the exemption and called `trimToTrainLimit`, which sorts **cost ascending**: the gilded train is the newest
and dearest, so it survived and **one of the corporation's ORDINARY trains was confiscated for it**. Measured:
`owned ["2","3","4","D"]`, limit 3 → discarded `["2"]`.

**Owner ruling (2026-09-19) and the fix.** "WHILE THE TRAIN REMAINS GILDED/CARCOSAN it is individually exempt
from the owning corporation's train limit; the exemption lasts for its entire Carcosa lifetime; ending an OR
does not make the ghost ordinary; ending an OR set does not make the ghost ordinary; no ordinary train may be
trimmed merely because the old short-lived ghost exemption expired." The exemption ends when either the fog
removes the train or the Blood Price burns the gilding off.

So the exemption is read from **`carcosan_trains`** — which *is* that lifetime, spliced by the fog and cleared
at the seller by the Blood Price — and is coextensive **by construction** rather than by a second clock that
had to be kept in step. `expireGhostTrains` is **deleted** (#1092's rule: a reducer helper that trims a fleet
with no caller is a second way to take a train, waiting to be found), and nothing trims at that transition any
more. Every counting surface was repointed together (#1006's shape — a limit that disagrees with itself):
`trainLimit` callers in `trainDiscard`, `trainPurchaseGate`, `trainSaleAuthority`, `derivedActions`, plus
`App.tsx`'s two sites, `TrainPurchasePanel` and the `ContextualActionBar` view model.

**The two lists keep their names because they now answer two questions that genuinely differ.**
`ghost_trains` = SYNTHETIC, "this train never came off the depot shelf" — read by `depotInventory` so the gift
does not deplete supply, and by `realDieselPurchased` so a gifted Diesel is not mistaken for a bought one.
`carcosan_trains` = the gilding, the fog's target, and now the limit exemption.

**The effective doom trigger, corrected (#1672).** Two conditions — (A) the gilded ghost exists, (B) a **real**
D has been purchased through normal depot machinery — and the trigger is **whichever lands second**. #1046
keyed the clock on the GIFT'S OWN TIER, which is two errors: a 5 or 6 gifted after the Diesels were already
running waited for a first D that had long since come and never got a deadline at all; and a synthetic D would
have started the clock by arriving, which the ruling forbids explicitly. The phase cannot answer (B) — it
counts the ghost toward `highest` by design — so `realDieselPurchased` (`gamePhase.ts` #1672) subtracts
`ghost_trains` before looking, and also counts a Diesel in the Bank Pool (#1530: a pooled train was bought).
`startCarcosanDoomClock` is unchanged and still idempotent, so a second Diesel cannot push the fog back.

**The grace and the fog, preserved (#1089 / #1092).** Trigger during set N → the train survives the remainder
of N and **ALL** of N + 1; the deadline is N + 1; the fog becomes due only once N + 1 is complete
(`macroRound > doom`, `>` not `>=`, because `macro_round_number` increments as the Stock Round opens); and the
train is then removed on a **narrated run** by the `stage === "fog"` arm, never by a silent boundary deletion.
A corporation receiving Carcosa on the last operating turn of set N therefore gets the whole of N + 1 to
operate the gift — and, with the exemption now lasting the whole lifetime, cannot lose an ordinary train in
the meantime.

**The gift's model (#1672).** "The LOWEST-VALUE TRAIN CURRENTLY REPRESENTED BY THE AUTHORITATIVE BANK DEPOT
RULE when the gift occurs", not the phase's tier. `carcosaGiftModel` returns `openDepotTiers(state)[0].tier` —
reusing the depot authority rather than restating it — with the old phase reading (`escalationTier`) kept as
the fallback for a board that cannot say what is on the shelf. The gift stays synthetic: `depotInventory`
subtracts `ghost_trains`, so the shelf reads the same before and after. The shell narrates from the same
function, so the Activity Log cannot name a tier the board did not hand over.

**Blood Price — #1090 PRESERVED AND AUTHORITATIVE.** A successful sale is the escape from the Carcosa
lifecycle: the seller is absolved (`is_carcosan` cleared, `carcosan_trains` loses the model, the deadline
cleared), the gilding is **burned off**, and the buyer receives an **ORDINARY** train — not cursed, not
gilded, no exemption, no deadline, never taken by the fog, and fully subject to the buyer's ordinary train
limit. Cash and share-price consequences unchanged.

**Completing the split — three propagation sites, found in three passes (#1673 / #1674 / #1675).** Splitting
one field into two meanings is a change every reader has to be walked through, and this one was not caught in a
single sweep. Recorded together so the shape is visible:
**#1673, the Blood Price buyer** — provenance must travel with the train (below).
**#1674, the two capacity pills** — `ContextualSubPanel` and `FinancialLedger` passed `ghost_trains` into
`CapacityPill`, which counts limit slots. Correct while the two lists had the same members, and wrong after a
Blood Price: the buyer keeps the marker and gains no gilding, so the pill exempted an ordinary train the gate
counts and would have read one under the Buy button. Both now take `carcosan_trains`, which is what every
authoritative limit reader takes.
**#1675, the fog's own removal** — the `stage === "fog"` arm removed one occurrence from `owned_trains` and
`carcosan_trains` and left the matching `ghost_trains` entry behind. Harmless while `expireGhostTrains` emptied
the list every Operating Round; permanent once #1672 deleted that function. A marker for a train that no longer
exists lies to both provenance readers — `depotInventory` would keep one printed train off the bank's shelf for
the rest of the game, and `realDieselPurchased` would keep masking a real Diesel with a destroyed synthetic one.
The fog now removes exactly one occurrence from all three multisets.
A bounded reference audit of the two fields followed (#1676): every production reader and writer of
`ghost_trains` is provenance or a provenance mutation, every reader of `carcosan_trains` is identity, exemption,
fog target, display or a Carcosa mutation, and three stale comments asserting the superseded OR-long rule were
retired. **The one naming hazard left standing is reported, not changed:** `App.tsx`'s view-model field is still
called `ghostTrains` and is fed `carcosan_trains`, read by `ContextualActionBar`'s count. The value is right and
the name is #1046's; renaming it would touch two owner-heavy files for a word.

**The consistency change the split required — corrected at the representation check, #1673.** Once the two
markers mean different things, the Blood Price has to SPLIT them rather than clear both. `carcosan_trains` is
the gilding and is burned off, so it does not reach the buyer. `ghost_trains` is SYNTHETIC PROVENANCE — "this
train never came off the depot shelf" — which is a fact about the TRAIN, not about who owns it, so it
**travels with the train to the buyer**. #1672's first pass deleted the seller's marker without giving it to
the buyer, which is the same error as leaving it behind, in the other direction: it would have conjured a
physical train out of a gift. Both readers would have been wrong — `depotInventory` would have started
counting the transferred gift against the bank's shelf, and `realDieselPurchased` would have read a
transferred synthetic Diesel as retroactive evidence that a real one was bought, starting the doom clock for
every other gilded train in play. The move is **exactly one occurrence** (the project's multiset convention)
and **unconditional**, outside the carcosan gate, so a train on its second Blood Price — synthetic but no
longer gilded — still carries its provenance. The marker on the buyer grants **no** train-limit exemption:
that is read from `carcosan_trains` alone.

**Tests.** `utils/stage95GhostLimit.test.ts` rewritten as the lifecycle suite, **35 cases** (group G is the field-split guard added at the owner's gate: the fog clearing all three multisets, the same-model multiset case, `depotInventory` and `realDieselPurchased` undistorted after a fog, the Blood-Price buyer counted alike by display and gate, and a role-split source pin over every limit reader, capacity call site and provenance reader) in the owner's six
lettered groups: A the exemption (per train, surviving OR and OR-set boundaries, ordinary trains still bound,
the trim gone and every surface repointed); B the pre-D gift (no deadline, no fog, the later real D starts the
clock, idempotent); C the post-D gift (receipt is the trigger, whatever tier); D the grace and the fog (not due
in N, not due anywhere in N + 1 including its last turn, due only after, still limit-exempt throughout, still
narrated); E the Blood Price (seller absolved, buyer ordinary and limit-bound, train never disappears; and #1673's
representation invariant — the synthetic marker moves seller → buyer, `depotInventory` is unchanged by the
transfer, a transferred synthetic D is still not a real Diesel purchase, exactly one marker moves when two
trains share a model, provenance survives a second hop, and an ordinary sale moves nothing);
F the depot model (agrees with the phase while the tier is stocked, differs once it sells out, falls back
safely, consumes no inventory, and a synthetic D is not a real D). `batch48`'s two ghost pins and `batch60`'s
two clock pins inverted to the new contract with the superseded reading recorded.

**Corpus — targeted presence check against the established 18-file set.** Replayed all 18 looking for the five
lifecycle events: **0 Carcosa gifts, 0 fogs, 0 Blood Price transfers, 0 observations of any `ghost_trains` or
`carcosan_trains`, and no real Diesel purchased in any file.** The Yellow Sign never reaches its second stage
anywhere in the corpus, so there is no implicated file to replay. **Absent: this fix changes no stored
replay.** Raw logs untouched, no golden touched.

**Replay / version.** Replay-semantic in principle (Yellow-Sign rooms), corpus-neutral in fact; part of the
Stage-9 6 → 7 bump, not a bump of its own. `RULES_ENGINE_VERSION` unchanged at 6 by this slice.

**S9-3. ~~Yellow Sign "Mark" ruling — the corporation's other trains' legal runs are zeroed~~ Only the vanished train's run is nullified.**
Status **`RESOLVED`** (Stage 9.5, 2026-09-19, by owner ruling; the implementation already complied — #1375).
*(Was `OWNER DECISION` owed, migrated from TRIAGE_2026-09-05 item 22b.)*

**Owner ruling (2026-09-19).** "ONLY THAT TRAIN'S RUN is nullified; revenue legally earned by the corporation's
OTHER trains remains valid and pays normally." The playtest feedback was right and #1046's original zeroing was
not. The half-value payout is unchanged: one-half of the disappeared train's face value is deposited directly
into the corporation treasury.

**The code already does this, and has since #1375.** `runWithoutTrain` (`yellowSign.ts`) takes the vanished
train's printed route out of the run — identified by fleet slot first, then by model — and re-rolls the remainder
under the turn's own committed seed; the Mark arm applies it and the shell narrates from the same function, so
the sentence and the treasury cannot disagree. The zeroing survives on exactly one path and correctly: a stored
entry on an unpinned board that carries no `revenue_seed` was played under #1046's rule and keeps it, so no
historical log replays to a different board (#1661's legacy branch). **No correction was required.**

**Tests.** `utils/stage95Rulings.test.ts`, two cases, so this entry rests on its own proof rather than on
`markKeepsRun.test.ts` next door: the two-train case (only the taken train's printed route leaves,
`routes_run_this_turn` falls to 1, the remainder is re-rolled and still pays, the treasury gains exactly
`markPayout`, and the shell's reader agrees with the board); and the single-train boundary (nothing else to
preserve, the gold still arrives). No corpus effect. `RULES_ENGINE_VERSION` unchanged.

**THE FULL OWNER YELLOW SIGN RULE, recorded verbatim for the later Rules Reference pass** (2026-09-19). This is
the authoritative Project 18XX statement of the sequence. It is recorded here as the single source; **this slice
implements only the S9-3 clause above** and makes no other change to Yellow Sign mechanics.

> **MARK.** During Phases 2–4: the player rolls a critical malus (1) under Unpredictable Revenue; the
> flavour/event roll hits the Yellow Sign; one of that corporation's trains "disappears"; ONLY THAT TRAIN'S RUN
> is nullified; revenue legally earned by the corporation's OTHER trains remains valid and pays normally; the
> president finds the strange bag of gold; mechanically, one-half of the disappeared train's face value is
> deposited directly into the corporation treasury. If the corporation has not received the Mark by the end of
> Phase 4, the Mark does not newly trigger in Phase 5 or later.
>
> **CARCOSA AWAITS.** For a corporation that has already been Marked, during Phases 5–D: a critical bonus roll
> has an improved probability of triggering the Carcosa Awaits second step; a gilded/ornately decorated train
> joins the fleet; its train type/value corresponds to the lowest-value train currently represented by the bank
> depot rule; it is a GHOST train; it is synthetic — it does not remove a physical train from the depot; and it
> does NOT count toward that corporation's train limit.
>
> **GHOST EXPIRY.** The gilded ghost train disappears at the end of the FIRST set of Operating Rounds in which a
> D train is purchased. Its scheduled disappearance remains attached to the ghost train even if ownership
> changes.
>
> **BLOOD PRICE.** The gilded train may be purchased by another corporation under the Blood Price rule. The
> purchasing corporation pays the required Blood Price consequences (cash and corporate stock-price consequence
> under the existing Project 18XX rule). That transfer absolves the originally Marked/cursed corporation. The
> transferred gilded train remains a ghost train and STILL disappears on the same D-triggered schedule.

**Contradictions between that rule and the implementation, found while recording it — ALL THREE now closed by
Stage 9.5's lifecycle pass (#1672), see S9-2:** the exemption's lifetime and the cheapest-first trim; the gift's
tier (`escalationTier` read the phase, and `carcosaGiftModel` now reads the depot's lowest-value train); and the
doom trigger (which keyed on the gifted train's own tier, and is now "whichever of the gilded ghost and the
first REAL Diesel purchase lands second"). None of them was touched by S9-3 itself, which changed no code.

**S9-4. ~~The "1830+" board implemented is the owner's Project 18XX+ spec, not the rulebook's 1830+ (p.25).~~ The game is Project 18XX; the expanded board is Project 18XX+.**
Status **`RESOLVED` — owner/project-authority decision** (2026-09-19). *(Was `OWNER DECISION` needed, audit M16.)*

**Owner ruling (2026-09-19).** The game is **Project 18XX**. Almost no player-facing gameplay/rules surface
should present the project as "1830" or make the 1830 rulebook appear to be the final player authority. The 1830
rulebooks are **development source material**: they are used to build the game and to resolve source-rule
discrepancies. The in-game **Rules Reference is intended to be the sole and final player-facing authority for
Project 18XX rules.** The currently implemented expanded board/variant is **Project 18XX+**. No separate
published-"1830+" implementation is to be created during Stage 9.

**Disposition.** The board this entry describes is correct as Project 18XX+ and needs no change; the p.25
rulebook board is not a target. The differences the entry lists (H12 printed green #24; Montréal one station; no
D24 preprinted 29; no E5 Detroit exit; B20 double town) are recorded as **Project 18XX+ design**, not as
divergences to reconcile. This entry's rules-authority question is closed; what remains is naming, and naming is
a readiness pass, not a rules one. No replay effect.

**Part C (filed, not implemented here — no broad UI rename now).** The readiness pass must check:
player-facing "1830" terminology; "1830+" terminology that should instead identify **Project 18XX+**; Rules
Reference wording needed to establish it as the final Project 18XX rules authority; and that
source/provenance/credits may still identify the historical rulebooks where appropriate, but are not presented
to players as the gameplay authority. Filed as **U-40**.

*(Original finding, kept.)* Audit M16. Notes: #1300 / #1301 (`hexBoardDataPlus.ts`, "REQUESTED, verbatim"),
`tileTrayPlus.ts`. Differences: H12 printed green #24 (rulebook: green 23, PRR home anywhere on the hex);
Montréal one station (rulebook: double circle); no D24 preprinted 29; no E5 Detroit exit; B20 double town ✓.
Detail: either label the board "Project 18XX+" everywhere (Game Type drop-down #1271 already says 18XX+) and
record it here as the intended authority, or implement the p.25 board as a separate variant. No replay effect
from the labelling choice.

**S9-5. ~~Level Playing Field is owner-defined~~ The Level Playing Field is printed Scenario D (S-1.0), with owner variations recorded separately (the free home under the flat $100 station price, the herald-home representation of the PRR's starting-hex token, the Erie / PMQ OO home hex reading, **and the retention of the TO tiles that printed Scenario D removes**).** *(Narrow correction, Slice 8.3, 2026-09-17: the title used to list "7 seats, N&W / PMQ, JK + Coalfields licence, 20 % double certificate, 7-trains, $750 Diesel exchange, herald home" as owner variations. All but the herald home are **printed** Scenario D, as this entry's own "Printed there" list already said — the Erie's and the N&W's second 20 % certificate among them (full rulebook 5.0, p. 34: president's 20 % + other 20 % + six 10 %s, and the other 20 % is not a President's Certificate). Only genuine owner readings are listed in the title now.)*
**Corrected by Slice 8.2 (2026-09-16).** The title's "owner-defined" was wrong: the full 48-page rulebook prints the
scenario (S-1.0 "A Level Playing Field", pp. 34–36; Table T-08, p. 47). Printed there: N&W (base Norfolk L-16) and PMQ
(Detroit/Windsor E-5, either city, the Erie's track rules) added; up to 7 players (certificate limits and starting money
for 2–7); the Erie's and the N&W's second 20 % certificate; the JK private and the Kanawha licences; the scenario's train counts, 7-trains and the diesel's $900 / $750 price; the C&O's
Cleveland-or-Richmond start (Richmond reserved, Cleveland blockable); a flat $100 station price; the PRR's special
starting-hex token; the warehouses and the Coal River hex. **Owner variations and readings (to confirm item by item,
not a fresh audit):** the free home under the flat $100 price (owner clarification, Slice 8.2 — implemented); the PRR's
special token modelled as the herald home (#1302 / #1332 — same effect, representation difference, design §5.1a); the
Erie / PMQ OO home hex (S8-14 — ruled 2026-09-17, D-33: the base game's conditional form, applied to the PMQ on E-5 as to
the Erie, where V-7.3's wording omits the tile condition; implemented, #1617); anything else found
later is listed here rather than labelling the scenario owner-defined. Status `OWNER DECISION` (recorded; audit N "PASS vs owner spec" — now to be read
as "PASS vs the printed scenario and the owner's recorded readings"). Notes: `gameVariants.ts`,
`levelPlayingField.ts`, `doubleCertificate.ts`, `kanawhaLicense.ts`, `hexBoardDataLpf.ts` (`COAL_RIVER_EDGES`),
#1323 Coal River bar, #1276 / #1298 / #1299 licence, #1286 warehouses.
**FROZEN OWNER OVERRIDE, added at revision 9.1b (2026-09-18) — the TO tiles.** Printed Scenario D removes
`to1 (810) x1` and `to5 (882) x1` (T-01 S-1.0; S-1.1 clause 6) while leaving the TO hex **D10** on the board.
**Project 18XX LPF retains both, one each**, because D10 is printed `TO` and accepts only the `TorontoHub` family —
so without them the labelled hex has no upgrade path and can never be built through, which playtesters reasonably
did not expect. Recorded at `tileTrayLpf.ts` design note **#1395** (from the report "When clicking the preprinted
Toronto (TO) hex, the tileselector does not pop up at all... Let's restore the TO tiles for our LPF variant's tile
set"), after #1385's list had removed them. **Implemented and test-pinned**: `LPF_TRAY_REMOVALS` omits both, and
`utils/levelPlayingField.test.ts:170-171` asserts `LPF_TRAY.counts.get(810) === 1` and `...get(882) === 1` by name.
Classification: **INTENTIONAL PROJECT DEVIATION — PASS.** Not a catalog defect, not variant leakage, not a
reconciliation error, not an ambiguity. **A future "rulebook reconciliation" pass must not revert it**, and that
test is what stops one. Chain: printed `TO` hex -> #810 (green, slots [1,2], $50) -> #882 (brown, slots [2,2], $70),
terminal at brown; exercised in the corpus on both LPF logs (JUNO-FCJ 660->700, JUNO-Z6C 549->564). Full record:
`STAGE9_TILE_TOPOLOGY_AUDIT_2026-09-18.md` section 10c. Open sub-items: S9-8 (pool cap in
certificates); the seventh seat colour (#1344 done; `seatColor.test.ts` contrast/livery question flagged, U-8);
S6-4; LPF-specific route rules (warehouses as termini, `routeConnection` / `assignRouteSet`, decision 21a of
2026-09-08) to be carried into S6-1.

**S9-6. ~~CS power treated as forfeited when another corporation tiles B20~~ The C&SL grants a bonus LAY, not an upgrade right.**
Status **`RESOLVED`** (Stage 9.5, 2026-09-19, #1671 — wording and rule statement; no behaviour change).
*(Was `OPEN` (UNCLEAR). Rulebook p.11; audit m10.)*

**Owner ruling (2026-09-19), correcting the reading this entry was filed under.** The C&SL special grants a bonus
TILE LAY on B20. It does **not** grant a general track action, and it does **not** grant an upgrade right merely
because an ordinary corporation track action may normally be used to lay OR upgrade. While B20 is available the
owning corporation uses the special under its existing connectivity exemption; once another corporation has
tiled B20 the unused power does **not** permit an upgrade of that tile. **Do not invent a D&H-style explicit
"lapse on another corporation's lay" rule for the C&SL** — semantically the unused power simply has no legal
bonus-lay target once B20 is tiled. The distinction: the D&H has an explicit lapse; the C&SL has a bonus lay
whose opportunity can cease to exist.

**Did the code treat the bonus lay as an upgrade? No — and it gave the wrong reason for not doing so.**
`cslPowerState` (`dhPower.ts`) offered the power only while B20 was bare (`forfeited = hexBuilt && !layUsed`),
and a tile onto an empty hex is a lay by definition, so no path reached an upgrade. But it said so by asserting
the D&H's forfeiture — the blocked reason read "Another corporation has already built on B20, so the C&SL's
power is gone for the rest of the game", and `CSL_POWER_DESCRIPTION` ended "the power is forfeited". Both state a
rule the C&SL does not have, and the first is also factually wrong when the OWNING corporation tiled B20 with its
ordinary lay. Tiles are never removed in this game, so "no legal target" and "never again" describe the same
future — which is exactly why the wrong reason survived unnoticed.

**Fix (smallest).** The outcome and the function's shape are unchanged; the two player-facing sentences now state
the real reason ("B20 already carries a tile, so the C&SL's bonus lay has no legal target — the power lays track,
it does not upgrade"), and #1671 records the ruling and the D&H contrast beside them. `forfeited` keeps its field
name: every caller reads it as "this power can no longer be used", and renaming it would be a refactor for a word.
The general track action is untouched.

**And the tile's own legality was never this function's.** `filterSandboxPlacements` — the one predicate the Node
server and every replay judge a `LayTile` with — takes `{ mapGrid, q, r, era }` and never sees the private at all.
The power waives connectivity and the track step's cost, never the colour tier or the topology, so there is no
path on which the C&SL makes an otherwise illegal tile legal.

**Tests.** `utils/stage95Rulings.test.ts`, four cases: offered only on a bare B20; no legal target once tiled,
with the invented lapse wording asserted absent from both the state and the description; spent once used,
whoever laid; and the authoritative predicate refusing a second yellow on a yellow B20 identically with or
without the power. No corpus effect (wording only). `RULES_ENGINE_VERSION` unchanged.

**S9-7. Gentle Rust / Unpredictable Revenue / Delayed Auction — optional variants, full certification deferred.**
Status **`DEFERRED — PRE-LAUNCH VARIANT CERTIFICATION REQUIRED`**, explicitly OUT of Stage-9 closure scope
(owner ruling, 2026-09-19). *(Was `DEFERRED` (audit "UNCLEAR").)* Notes: `gentleRust*`, `variantRules.test.ts`,
#905 (delayed auction, `boIsLocked`), #1034 (reprieved trains exempt from limits — respected by #1530).

**Owner ruling, recorded verbatim in substance.** Gentle Rust, Unpredictable Revenue and Delayed Auction have
**not** received complete specification audits as independent optional variants. They must **not** be labelled
audited or resolved. These are optional variants; full independent variant-spec certification is **deferred**;
that certification is **outside this Stage-9 closure scope**; and **PRE-LAUNCH VARIANT CERTIFICATION remains
required** before any of them is represented as fully-authoritative supported rules.

**What this deferral does not weaken.** The Yellow Sign rulings recorded at S9-3 are authoritative Project rules
for the mechanics already implemented, and the Stage-9 authority work on those mechanics (S9-1, S9-3, S9-11) is
closed on its own terms. The deferral means only that no claim is made of a complete end-to-end audit of every
optional variant. S7-2 and S8-7 both name Delayed-Auction cases that belong to that certification.

**S9-8. ~~Bank Pool cap is 50 % rather than "5 certificates"~~ The Bank Pool caps at five physical certificates.**
Status **`RESOLVED`** (Stage 9.5, 2026-09-19, #1670). *(Was `OPEN` (LPF-only). Rulebook §5.1 / §4.3; audit m7.)*

**Owner ruling (2026-09-19).** "The Bank Pool limit is FIVE PHYSICAL CERTIFICATES of one corporation, not 50
percentage points. A non-president 20 % certificate is ONE physical certificate." Ownership percentage and cash
proceeds stay percentage-based; presidency rules are unchanged; ordinary Classic behaviour is unchanged.

**Root cause.** `shareSaleBlock` (`gameEngine/shareSale.ts`) — the authority the reducer's `SellStock` arm
(`sandboxSession.ts`), `stockTransactionAuthority` and the emergency-funding projection all ask — tested
`percentage > 50 - bank_pool_percentage`. Right about the printed game, where five 10 % cards and 50 % are the
same sentence, and wrong the moment a card carries two shares. Under Scenario D the ERIE and the N&W print an
"other" 20 % certificate: a pool holding it and three 10 %s is 50 % and only **four** cards, so the percentage
test refused a legal fifth; and a pool that had taken that card in as 20 % could reach **six** cards behind it.

**Fix (smallest, no second model).** `BANK_POOL_CAP_CERTIFICATES = 5` beside `BANK_POOL_CAP_PERCENT` in
`endgame.ts` (the percentage stays: it is still what every sentence quotes, and in Classic it is still true).
`doubleCertificate.ts` gains `certificateCardsEnteringPool(company, seller, percentage)` and
`bankPoolCertificateRoom(company)` — the same Stage-8.3 representation S9-13 reused (#1324 / #1650), a third
named question over one model rather than a second model. `shareSaleBlock` now refuses when
`certificateCardsInPool(company, "Bank") + certificateCardsEnteringPool(...) > 5`. **The residue rule is the one
subtlety:** `ordinaryPercentHeld` subtracts both the president's 20 % and the double's 20 %, so "percentage
beyond the ordinary" is the double for a holder who has one and the PRESIDENT'S BLOCK for one who does not. The
chart's `certificatesSoldInMarketMove` reads any residue as the double, which is right for the chart and would
under-count a president's sale by a card here — and a cap that under-counts is a cap that admits a sixth
certificate. So the double is claimed only when the seller holds it and the rest is counted in tens, which is
what §5.4's exchange hands the pool. Presidency arithmetic is untouched.

**Tests.** New `utils/bankPoolCertificateCap.test.ts` (7 cases) — the owner's five required behaviours verbatim,
plus the presidency control (a president's 30 % is three certificates and the successor rule still speaks) and a
Classic sweep proving the certificate ceiling and the old percentage ceiling refuse *exactly* the same sales at
every pool level. `utils/shareSale.test.ts`'s three pool cases re-worded into the new unit (same claims).

**Corpus — targeted presence check against the established 18-file set, per the closure protocol.** All 18
replayed; **15 `SellStock` entries in the whole corpus; zero divergent sites.** The double never reaches the Bank
Pool in any stored log (it is bought out of the IPO in `server/JUNO-FCJ` from index 674 and stays with the
player), so at every one of the 15 sales `certificateCardsInPool` equals `bank_pool_percentage / 10` and no
seller holds the double. **The only Scenario-D sale in the corpus is `server/JUNO-FCJ` index 851** (ERIE, 30 %),
refused upstream because ERIE is unfloated — unchanged. **Absent: this fix changes no stored replay.** Raw logs
untouched, no golden touched.

**Replay / version.** Replay-semantic in principle (LPF rooms), corpus-neutral in fact; part of the Stage-9
6 → 7 bump, not a bump of its own. `RULES_ENGINE_VERSION` unchanged at 6 by this slice.

**Part C (filed, not implemented here).** Two derived readers still express pool room in percent and now
under-report it when the double sits in the pool: `endgame.sellableHoldings` (the §6.6.3 liquidity/forced-sale
projection) and `components/StockRoundPanel.tsx`'s own `BANK_POOL_CAP_PERCENT` copy. Both are **conservative** —
they can only offer less than the authority allows, never more, so neither can admit an illegal sale — but under
LPF a legal fifth certificate would be unreachable from the panel. Filed as a **LEGALITY SYNC** readiness item
(U-39). Deliberately not fixed here: `sellableHoldings` bounds the President's Certificate by percentage and the
owner's ruling says presidency rules remain unchanged.

**S9-13. ~~The market walks one row per 10 %, not one per certificate~~ The chart steps once per physical certificate.**
Status **`RESOLVED`** (Stage 9.4c, `53f34b0`, #1650; header corrected at Stage 9.5 — the resolution is appended
at the end of this entry, and the owed canonical 18/18 reconciliation was completed at Stage-9 closure: 15
`SellStock` entries across the 18 files, the only Scenario-D sale `server/JUNO-FCJ` 851 refused upstream, **no
stored replay changed**). *(Was `FILED` (LPF-only) — found by Slice 8.3 while auditing the certificate representation for S8-15; **not** fixed
there (outside the owner's S8-15 scope). Rulebook §5.1 / V-7.2; full rulebook 5.0 p. 34. Notes:
`sandboxSession.ts` `applySandboxMarketAction` (`blocks = Math.max(1, Math.round(percentage / 10))`),
`shareSale.ts` `certificatesIn`, `doubleCertificate.ts` `doubleSaleEffect` (#1324). Detail: the token falls one row per
CERTIFICATE sold, and the other-20 is one certificate; the engine derives the row count from the percentage, so a 20 %
block sale of that one card walks two rows instead of one. The PROCEEDS are already right (twice the share price), so
this is the chart step alone. Same family as S9-8 (count certificates, not percent). Replay: LPF logs only — bump. No
stored log contains an LPF sale of the other-20 (Slice 8.3's sweep: 15 stored sales re-judged, no Scenario-D
presidency change at all). **STAYS OPEN:** the owner's 2026-09-17 ruling absorbed S9-14 into Slice 8.3 and left
this one explicitly out — "Do NOT touch S9-13. The chart-movement treatment of a sold other-20 remains Stage 9."
**Later LPF / double-certificate slice.**
**RESOLVED — Stage 9.4c.** **Root cause:** `applySandboxMarketAction`'s `SellStock` arm derived a single
`blocks` figure from `percentage / 10` and used it for BOTH the chart step (`ctx.projectSale(mark, blocks)`)
and the proceeds (`priceOf(protocol_id) * blocks`) — correct for proceeds (a 20 % block is worth twice a 10 %
one whichever card carries it), wrong for the chart, which is per physical CERTIFICATE, not per tenth of a
percent. **Fix, reusing the Stage 8.3 physical-certificate model (no second representation added):**
`doubleCertificate.ts` gains `certificatesSoldInMarketMove(company, holder, percentage)` — the same
`ordinaryPercentHeld` / `doubleSaleEffect` split #1324 already reads, answering "how many physical cards does
this sale move": the ordinary portion is still one card per ten percent, and the double — touched at all,
block or half — is exactly one more card, never two. `sandboxSession.ts` splits the old single `blocks` into
`shareUnits` (unchanged, feeds `proceeds` only) and `certificateSteps` (feeds `ctx.projectSale` only), wired
through a new optional `SandboxMarketContext.certificatesSold` callback the reducer supplies from real state
(`applySandboxActionAfterAuction`); callers that don't supply it (chartless fixtures, existing direct
`applySandboxMarketAction` tests) fall back to the old percentage/10 count unchanged. **Files changed:**
`frontend/src/gameEngine/doubleCertificate.ts` (new export), `frontend/src/gameEngine/sandboxSession.ts`
(import, `SandboxMarketContext.certificatesSold`, the `SellStock` arm's `shareUnits`/`certificateSteps` split,
the call site wiring), `frontend/src/utils/soldOutRise.test.ts` (one literal-source assertion updated for the
`blocks` → `certificateSteps` rename it was pinning). **Focused tests, new:**
`frontend/src/utils/marketStepCertificates.test.ts`, 4/4 passing — one ordinary 10 % certificate (one market
step), one non-president 20 % certificate sold as a whole block (one market step, not two), two separate
ordinary 10 % certificates (two market steps), and proceeds staying percentage-correct (the 20 % block pays
exactly twice the 10 % sale) with the Bank Pool's physical-certificate count (`certificateCardsInPool`)
asserted on each. **Directly implicated existing suites, re-run, 215/215 passing (incl. the 4 new above):**
`presidencyLpf.test.ts`, `presidentCertificateSale.test.ts`, `doubleWithhold.test.ts`, `shareSale.test.ts`,
`soldOutRise.test.ts`, `stockTransactionAuthority.test.ts`, `stockRefusalAtomicity.test.ts`,
`presidencyAuthority.test.ts`, `bloodPriceArrival.test.ts` — the S8-15/S9-14 presidency exchange (which this
fix does not touch: `presidentAfterSale` / `needsDoubleForPresidencyExchange` are untouched) settles exactly as
before. **Corpus — targeted scan only, NOT an 18/18 canonical-corpus reconciliation:** this slice located 8
`server/data/*.log.jsonl` logs in the working tree (six under the LPF variant: 8E8, CV4, CW7, FCJ, G6J, Z6C)
and scanned those 8 — not the established Stage-9 canonical 18-file corpus, which this slice did not assemble
or search. A text scan of the six LPF logs for a `SellStock` against either Scenario-D company (ERIE id 6,
N&W id 10) found two hits, both in `JUNO-FCJ` (indices 849 and 851, `protocol_id: 6`, `percentage: 30`);
replaying the prefix up to each shows ERIE still unfloated at that point (`is_floated: false`,
`player_holdings: []`) and the state, market position and actor's cash byte-identical before and after both
entries — both refused, not applied sales. No other located log references either company in a `SellStock`.
**So: no applied sale of the non-president 20% certificate was found in the 8 logs this slice located** —
consistent with, but not a repeat or extension of, Slice 8.3's own earlier sweep ("no stored log contains an
LPF sale of the other-20"). **Complete canonical 18-file reconciliation remains owed and is explicitly
deferred to Stage-9 closure** — this entry's corpus note is not that reconciliation and must not be read as
one. **Typecheck:** `tsc --noEmit` clean. **Part-C/UI consequence:** none
— the fix is inside the chart-step atom only; no panel, log line or Rules Reference text names a certificate
count. `RULES_ENGINE_VERSION` unchanged at 6.

**S9-14. `shareSaleBlock` judged the half-sale on the seller's current cards, so it did not see the exchange the sale itself forces.**
Status `RESOLVED` — **ABSORBED INTO Slice 8.3** by owner ruling 2026-09-17 and fixed there (#1624; committed `02a9838`). *(Was `FILED` for a later Stage-9 slice, filed by Slice 8.3 the same day.)* Rulebook §5.4 +

V-7.2. Notes: `shareSale.ts` `shareSaleBlock` (#1624), `doubleCertificate.ts` `doubleSaleRefusal` /
`needsDoubleForPresidencyExchange` (#1324 / #1622), `presidencyTransfer.ts` `presidentAfterSale`.
**THE RULED REASON, recorded verbatim.** *V-7.2 requires the 10 % exchange certificate to have been in the Bank Pool
before a half-sale of the other-20. A president who must first receive that other-20 during a presidency transfer is
subject to the same requirement. The current sale cannot supply its own prerequisite.*
**The defect.** §5.4 settles the presidency the moment the announced sale would cause it, so a president whose sale
hands the crown to a holder of the other-20 who has no two ordinary 10 %s (#1622) receives that card **before** the
sale completes, and then sells out of it. Selling 10 % of a 20 % card is V-7.2's half-sale. `doubleSaleRefusal` judges
the seller's CURRENT cards (#1324), and at that moment the card is still the successor's — so the gate found nothing,
the arm moved the percentages, and the 10 % the sale itself put in the pool looked like the prerequisite.
**The repair.** The same authority is asked of the board the mandatory exchange will leave — the seller holding the
other-20 and no longer president — on the **PRE-SALE** pools: `{ ...company, president: successor,
double_certificate: { at: seller } }`, then `doubleSaleRefusal(returned, seller, percentage)`. No arithmetic is
restated: #1324 answers all three shapes (the sale that never reaches the card, the block sale of the whole card, the
half-sale that needs the pool's 10 %) and #1622's predicate supplies the "successor needs the card" condition. One
implementation, inside `shareSaleBlock`, which the reducer's `SellStock` arm, the ingress (`stockSaleRefusal`), the
chart step's `saleRefused` and the panel all already ask — so ingress/reducer parity and S8-13's
refuse-before-the-chart-moves both come for free, asserted rather than assumed.
**Not on the buy side:** a challenger who BUYS to exceed the president performs no sale and no half-sale; the S8-15
`BuyStock` result is re-pinned with the pool explicitly empty. **Not over-broad:** the whole-20 sale needs no
prerequisite; a sale that does not reach the card is untouched and the former president then keeps the card; a
corporation printing no other-20 never reaches the condition.
**Consequence for S8-15's settlement.** With S9-14 authoritative, every accepted action has a determinate destination
for the other-20 — successor retains it, former president receives it, or the Bank Pool does — so #1622's "move
nothing" arm is unreachable through reducer authority and exists for a hand-built board. Enumerated and pinned
(`presidencyLpf.test.ts` §7).
**Corpus, read-only.** Every stored `SellStock` put back through the canonical gate on the board it was sent against:
**15 sales re-judged, 0 newly refused** — and 1,096 stored company-boards carry a Scenario-D other-20, so the zero is
measured on LPF boards rather than on their absence. **ZERO replay differences.**
Tests: `presidencyLpf.test.ts` §6 cases A–H (empty-pool refusal with no mutation and no chart movement; the
pre-existing-pool-10 acceptance and its printed result; the whole-20 sale; the sale that does not reach the card; the
buy path; a corporation with no other-20; the N&W; ingress parity) and §7 (exhaustiveness). Mutations: M7 read the
POST-sale pool (the sale supplying its own prerequisite) → 3 failures; M8 drop the "successor needs the card" guard →
9 failures across three suites; both restored byte-for-byte. `RULES_ENGINE_VERSION` stays **5**.

**S9-9. The board / tile / chart cluster (14 modules, ~7,100 lines) lives in `components/` and the engine imports it upward; four `SandboxActionContext` injections are now unjustified.**
Status `DEFERRED` (map-data architecture; do with the legality batch, S6-5…S6-8). Notes: Batch 1 §6a; #273
(`utils/` may not import `components/`); #1501 retired the justification for `projectRise`, `marketZoneFor`,
`zoneForPrice`, `parCellFor` (and `homeHexToAxial` was already redundant; `marketGeometry.ts` #26 says so);
`layRefused` stays justified until `sandboxTileLegality.ts` moves; `evaluateStationPlacement` already imports
`homeSlotIndex` / `stationMarkerPoint` from `components/hexCanvasPrimitives.ts` (Batch 3 §7). Replay: none if
the move is pure; **collapsing an injection changes what happens when a caller omits it** (a missing injection
today means *no rule*), so do it with tests that assert the reducer answers the rule with no context at all.
Destination `frontend/src/gameEngine/board/`.

**S9-10. Authoritative tile-upgrade topology preservation.**
Status **`RESOLVED`** (header corrected at Stage 9.5, 2026-09-19, from this entry's own body — no new finding). The
two board/printed-topology halves (F-1 the immutable hex, F-2 printed board topology) were **RESOLVED BY SLICE
9.2** (`17616c8`, #1620 / #1621); the catalog and #59 halves are discharged by **S9-15**, **S9-19** and **S9-21**
(all `RESOLVED`, Slice 9.3, `df63500`) and **S9-16** (`RECORDED`, not an engine defect). The four-item exception
manifest below is closed and the order-of-work checklist's step 4 was executed by Slices 9.2 and 9.3 together —
a richer generic preservation predicate plus the manifest, exactly as the audit's design answer specified.
*(Was `OPEN` — NOT implemented in Batch 7.4, NOT implemented by Stage 9.1.)* First recorded 2026-09-15 from the
visual-flourish VF-5 work as "preprinted-track preservation"; **wording corrected 2026-09-16 (Batch 7.4 final
review, owner ruling)** after the full 48-page 1830 rulebook with the expanded / LPF tile sets showed the first
generalisation was too broad; **manifest audit completed and this entry re-stated 2026-09-18
(`STAGE9_TILE_TOPOLOGY_AUDIT_2026-09-18.md`, Stage 9.1)**. This entry must NOT be read as "every old city needs a
one-to-one successor" or "any change in city topology is illegal".

*Rule authority, established 2026-09-18.* §7.2.2 of the 48-page book, p. 19: ❸ "All track segments on the replaced
tile must be maintained in the same orientations on the new tile"; ❹ "all stations on the replaced tile must be
placed on the new tile with the same connections as before". **Printed board hexes ARE the replaced tile** — p. 19's
own tables are keyed "Tan Hex → Yellow Tile #s" and "**Yellow Hex** → Green Tile #s", with Baltimore, Boston, New
York and the 2-small-city OO hex listed as yellow hexes — so printed track counts as pre-existing track with no
special case needed. §7.2.1 ❺'s "same number and size of cities" is town-vs-city, **not** slot parity (p. 19's hex
table is keyed "0 cities / 1 small city / 2 small cities / 1 large city"); a Stage-9 fix must not tighten rule 2
into slot parity, or 1830+'s #592 becomes unplayable everywhere. The **28-page revised rulebook is absent from the
repo** — every Classic-side quotation above is from the 48-page book's own Base Game section, and adding
`en_1830re.html_Rules_1830-RE_EN.pdf` is owed before Slice 9.2.

*FOUND CASE WITHDRAWN.* The recorded case — "expanded / LPF Baltimore — a #53 / #592 facing that cuts printed track
is offered and accepted" — is **NOT reproducible on any of the three boards**, and its tile pairing was a
misreading. Measured over all six facings at each printed landmark hex: at **I15** (printed 1 city, exits {0,4}) and
**E23** (printed 1 city, exits {1,5}) the engine offers exactly the rules-legal facings ({0,2,4} and {1,3,5}
respectively) and nothing else; at **G19** (two spurs, {1} and {4}) it offers facing 1 alone and *wrongly refuses*
the also-legal facing 4. The right answer arrives from `staysOnBoard` (design note #7) — a rule about the map's rim
— rather than from preservation, so the protection is **incidental and fragile**: it breaks on any board edit that
gives those hexes a neighbour they lack, on any new B/NY tile with a different edge set, and on any printed-track
hex that is not on the rim.

*#53 and #592 are SIBLINGS, not a chain.* T-09 (p. 48): `bb1` = old **#53**, green B, **1 slot**, 2 in Classic,
2 in 1830+ → `bb5/bb6/bb7`; `bb2` = old **#592**, green B, **2 slots**, 0 in Classic, **2 in 1830+** →
the same `bb5/bb6/bb7` = old **#61** (1 slot), **#884** (3 slots), **#997** (2 slots). There is no `#53 → #592`
edge in any ruleset; the two tiles have identical exits ({0,2,4}) and identical successors and differ **only** in
station-slot count, which the engine models correctly (`TILE_GRAPHICS_CATALOG` markers, read by
`tileCitySlotCounts`). Also established: label **"B" serves Baltimore AND Boston** (p. 19: "Baltimore … bb1 ·
Boston … bb1"), so the `BostonHub` terrain tag is a poor name for a correct model, and `hexLabelRestriction`
derives the family structurally rather than by coordinate list. LPF removes **#592 ×2 and #61 ×2**, so the LPF B
chain is #53 (1 slot) → #884 (3) / #997 (2), with no capacity shrink available — which is almost certainly why
printed Scenario D removes that exact pair.

*CONFIRMED INSTANCES OF THE SAME MECHANISM, and they are worse.* `preservesRouting` is gated on
`existing = TILE_CATALOG_BY_ID.get(laid.tile_id)`, so rule 5 is **skipped entirely** on any first lay over a printed
hex; and `sandboxTileLegality.ts` imports from `hexBoardData` only `IMPASSABLE_BORDER_EDGES, LANDMARK_HEXES,
STATIC_BOARD_HEXES, TO_HEXES, YELLOW_OO_HEXES, boardMemo`, mentioning `printedColor` on two lines inside
`preprintedTierByLabel`'s `"Yellow"` filter and **never** reading `GRAY_HEXES`, `RedOffboard`, `"Coal"`,
`LANDMARK_TRACKS` or station `slots`. The victims are the hexes 1830 forbids outright: on the standard board the
authoritative `layRefused` accepts **79 distinct (hex, tile, facing) lays on hexes that can never be built on**,
**54 of which delete printed track** — E9 18/17, C15 18/17, F6 6/6, D14 6/6, H12 6/4, A17 3/2, D24 3/2, I19 1/0,
F24 1/0, plus **17 lays on the seven red off-board areas**. Under LPF the same gap reaches the **Coalfields hex
(L8)** and the five **warehouses**. `evaluateHexForTileLaying` refuses all of them correctly — and is **UI-only**
(`HexGridRenderer` clicks, the glow, `layableHexes`); it is not in `layRefused`, so a replay cannot enforce it.
**AND THIS ONE IS A MIGRATION REGRESSION, NOT AN OMISSION, WHICH MEANS THE FIX HAS A REFERENCE IMPLEMENTATION.**
The CosmWasm contract refuses both cases by name, ahead of every geometric rule, with a Rust test behind them:
`src/hexmap.rs:2317` `OffboardHexNotBuildable` ("Off-Board Reservation", module doc #14) and `:2331`
`GrayHexNotUpgradeable` ("Gray Hex Immutability … a preprinted GRAY hex's real starting track is permanent --
nothing may ever be laid here", module doc #19); variants at `:1405` / `:1354`, mirrored in the legal-placement
query at `:1976` / `:1985`, asserted at `src/tests.rs:5205`. The rule was enforced while the contract had the
last word and did not survive the move to the Node authority — `server/src/gameServer.ts:356` and
`server/src/replayCli.ts:101` both build sessions with `sandboxReplayProviders()`, whose `layRefused` is
`filterSandboxPlacements` alone. `sandboxTileLegality.ts`'s design note #0 is candid about the original scope
("a filter that exists only where no authority is reachable cannot drift from an authority"); that premise
expired when the Node server became the authority. **Slice 9.2 should port `hexmap.rs`'s two checks in their Rust
order**, which is also the order `evaluateHexForTileLaying` already uses, and port the Rust assertion with them.
*One related gate is inert for the same reason and is deliberately NOT filed here:* the authoritative call site
passes only `{ mapGrid, q, r, era }`, no `networkHexes`/`networkPorts`, so rule 6 (`orientationJoinsNetwork`)
never runs authoritatively either — which that function's own doc states on purpose ("What this deliberately does
NOT check … network connectivity, city reservation for unfloated home hexes, and tray depletion"). That is a
route/connectivity concern, not a topology one; it belongs in **S10** beside S10-1, and Slice 9.2 must not
silently change it while passing the merged topology in.
*(This resolves `AUDIT_RULES_TO_MACHINE_2026-09-13.md` §F's `UNCLEAR` row "No tiles on gray/red" to MISSING.)*

**Requirement.** Stage 9 audits tile-upgrade legality against the ACTIVE RULESET's explicit upgrade families and
topology rules.

*Universal:*
- pre-existing track required by the source position is preserved as the rules require;
- track printed on the underlying board hex does not disappear merely because preservation looks only at a laid
  tile — the fix is to give rule 5 a merged `priorTopologyAt(mapGrid, q, r)` resolving laid tile ▸ printed tile ▸
  `LANDMARK_TRACKS` ▸ `GRAY_HEXES` ▸ `OFFBOARD_TRACKS` ▸ nothing, mirroring `liveEdgesForHex`'s and
  `archetypeForHex`'s existing fallback order so no third classifier is born;
- a hex the board forbids outright refuses every tile **in the authoritative predicate**, not only in the UI;
- existing station / token connectivity remains valid through the upgrade — and is judged authoritatively;
- the destination tile and facing belong to a rules-legal upgrade transition.

*Not universal — topology-changing rules belong to specific upgrade families; apply the constraint the active
ruleset actually defines. THE MANIFEST OF EXCEPTIONS IS NOW CLOSED, and it is four items long:*
- **`#54 → #883` is the ONLY city merge in the entire tile set** (2 cities × 1 slot → 1 city × 4 slots; 1830+ only).
  Already modelled — #1315's `clampCity`, `planTokenUpgrade`'s single-city fit, `nyMerge.test.ts`;
- **`#592 → #61` is the ONLY capacity-shrinking upgrade** (2 slots → 1; 1830+ only, absent from Classic and LPF).
  Refused correctly by `fitStationsToUpgrade`, **not** refused authoritatively;
- **eight double-town → single-town greens** (#1/#55→#88, #2/#56/#632→#87, #69/#630/#631→#204; 1830+ only) —
  already modelled by `mergesTowns` (#1403);
- **NO city anywhere in the tile set ever splits**, so class C needs no machinery at all;
- Variable OO Cities is **not present in the repo at all** — no flag, no code, no string — and cannot be used to
  legalise #59 mergers;
- do not infer a blanket "cities may never merge" rule;
- do not infer legality merely from geometric compatibility, or from the current placement filter accepting a
  facing.

*#59 — RESOLVED BY PRINTED RULE, not by an owner decision (revision 9.1b, 2026-09-18).* The 2018 revised rulebook
was located this pass and **§6.2.2 ❹ carries the clause verbatim**: "When a tile is replaced, all stations on the
replaced tile must be placed on the new tile with the same connections as before. **This also means that the
pre-printed exits on a (59) tile can never be connected in the tile upgrade.**" The first pass filed this as an
ambiguity needing an owner ruling only because it had no copy of the revised book. **There is no owner decision
here.** The ruling is frozen as printed rule and refiled as its own defect, **S9-19**: old #59 carries two distinct
city / track systems, an upgrade facing may not connect them, each system's station must land on a city carrying the
same connections, a merging orientation is illegal, and Variable OO stays OFF (a sweep for `variableoo` /
`variable oo` / `variable-oo` across `frontend/src` returns zero matches and `GameVariants` has no such flag, so
nothing can be invoked to legalise a merge). The **complete successor set is five tiles** — revised p. 19:
`59 (2) → 64, 65, 66, 67, 68` — and the first pass's abbreviated "#64, #65, #67" is corrected; #66 and #68 were
always in it. **The rule costs Classic nothing**: all five keep at least two legal facings, so it is a pure
over-acceptance defect with no reachability cost. **Seven (tile, facing) pairs accepted today are illegal** —
#67@4, #65@2, #64@0, oo13@1, oo13@4, oo14@1, oo14@2 — and oo13/oo14 are reachable from #59 *only* through illegal
facings, i.e. not at all, which is consistent with the errata voiding both tiles' identities and means T-09's
`oo2 → oo10-oo17` range over-reaches by exactly those two.

*Tile numbers.* Project-facing code comments, tests and reports use the old / original 18xx numbers. The fuller
Lookout rulebook's new numbers may appear only as a cross-reference; where both are shown, the implementation uses
the old number. **Verified 2026-09-18: zero modern identifiers in code, and they must stay out** — `A1`, `A9`,
`A11`, `A17`, `A19`, `B10`, `B12`, `B16`, `B20`, `B24`, `C15`, `C21`, `C23`, `D2`, `D10`, `D14`, `D24` are all real
hex labels in `hexBoardData`, and `C15` is simultaneously the Lookout name of tile **#63** and the board label of
**Kingston**. The old-number convention is the only collision-free choice here, not merely a preference. Full
crosswalk: audit §3. **CORRECTED CONVENTION (revision 9.1b): do not canonize an old number the official Mayfair
errata voids.** *"1830 Clarifications & Errata (01/03/12)"* (© Mayfair Games 20120106) records that **oo1 (626)
should be oo1 (8861)**, and that **oo13's printed 36** and **oo14's printed 35** are both wrong with **no valid
replacement**. So: where a corrected old number exists it is canonical and the printed one is a deprecated alias
(**oo1 = #8861**, alias ~~#626~~); where the errata voids the number and supplies none, the **Lookout ID** is
canonical (**oo13**, alias ~~#36~~; **oo14**, alias ~~#35~~). The engine keys all three on the deprecated aliases —
behaviourally inert, filed as **S9-21**. One inconsequential rulebook conflict: T-09 prints A8 = #6 / A9 = #5 while T-01 and S-1.1 ❻
print A8 (5) / A9 (6); identical colour, terrain, slots, quantities and successors, and LPF removes 2 of each, so no
engine behaviour can depend on it.

*Order of work (manifest audit BEFORE any change to `preservesRouting`) — ALL FOUR STEPS DONE 2026-09-18:*
1. ✔ the implementation's Classic / 1830+ / LPF tile catalog is cross-checked against T-09 (p. 48): **76 types, an
   exact two-way match; Classic reconciles tile-for-tile, 46 types / 85 copies**; the only quantity defect is
   **#63** (see S9-15);
2. ✔ cities, station slots, track, edge connections and permitted upgrade families verified per tile (audit §4);
3. ✔ the old / new mapping verified (audit §3);
4. ☐ **only now** tighten orientation / topology preservation — Slice 9.2, after the F-8 / F-9 rulings.

*What the audit measured about the generic filter, and it changes the design answer.* Over all 76 types × 6 × 6
facings, the engine's generic predicate reproduces **the rulebook's entire 127-edge upgrade graph** — no
rulebook-legal edge fails its tier / centre / terrain rules, and the only two edges it accepts that T-09 omits are
`#28 → #43` and `#29 → #43`, **which p. 19 explicitly lists** (`B13 … C4, C8, C9, C10` / `B14 … C4, C7, C9, C10`)
and whose geometry is sound. **T-09 has an erratum there; the engine is right and no change is owed.** So the
correct Stage-9 design is **a richer GENERIC preservation predicate plus the four-item exception manifest above** —
not a catalog-declared adjacency table (which would restate a graph the filter already computes, and would have
*hidden* S9-16 rather than exposed it) and not a `if (source === 59)` special case.

*Planned tests must distinguish:* (a) printed-track loss at every printed hex on every board — landmark, gray, Coal
and red-off-board — every legal and illegal facing, at both locks, refusals digest-equal, **and asserting the
refusal comes from preservation rather than from `staysOnBoard`** (G19's facing 4 is the canary: it is rules-legal
and refused today); (b) the #59 facings, once F-9 is ruled; (c) ordinary multi-city preservation; (d) the four
explicitly legal topology-changing upgrades (accepted); (e) **a standing catalog invariant — every rulebook-legal
upgrade has at least one legal facing** (this is what would have caught S9-16 the day #626 was added).

*Supersedes a prior PASS.* `AUDIT_RULES_TO_MACHINE_2026-09-13.md` §F "Upgrade preserves all segments and stations"
was marked PASS; that audit proved only part of the invariant (laid-tile segment superset and token migration) and
is re-annotated `PARTIAL — see S9-10`. Stage 9 re-audits every topology-sensitive upgrade. The same audit's
"No tiles on gray/red" row is updated `UNCLEAR → MISSING` by this pass.

Replay: **refusal-added, and measured corpus-neutral.** 12 logs / 198 effective lays / **73 effective upgrade
transitions** (`RevertTo { index }` is exclusive — "everything from `index` onward did not happen"; getting that off
by one inflates the count to 101 and manufactures 21 phantom same-tier "upgrades"). All 73 pass the v6 predicate,
and **zero stored lays land on a hex immutable on that log's own board**, so closing the printed-track and
immutable-hex halves re-pins nothing. The only corpus exposure is F-9's: **JUNO-FCJ 640 (E11, #59@5 → #35@0),
JUNO-FCJ 1047 (E5, #59@4 → #65@0), JUNO-Z6C 399 (E5, #59@4 → #36@2)** — each with exactly **one** token on the hex,
so ❹ was satisfiable and none is provably illegal. If F-9 is ruled "distinct", those three become refusal-added and
**two of them have no legal facing at all** until S9-16 is fixed, so F-8/F-9 and S9-16 must land in one slice. Bump
expected at the end of Slice 9.2. No visual-flourish code is touched by the eventual fix; VF-5 only surfaced it.

*RESOLVED IN PART BY SLICE 9.2 (2026-09-18, uncommitted).* The two **board/printed-topology** halves of this entry
are implemented and pinned; the catalog and #59 halves are untouched and stay `OPEN` under S9-19 / S9-15 / S9-21 /
S9-16.

- **F-1, the immutable hex — RESOLVED.** `evaluateHexForTileLaying`'s Gates 1 / 2a / 2b are extracted into one pure
  predicate, `hexGeometry.immutableHexRefusal(q, r)` (design note **#1620**), which the click gate and
  `filterSandboxPlacements` now BOTH ask — not a copy, so the message a player is shown and the refusal a replay
  applies cannot drift. It is rule **0** of the filter, hoisted out of the per-placement loop, in `hexmap.rs`'s own
  order: off-board (`:2317`) first, then gray/Coal (`:2331`), both ahead of every geometric rule.
  `src/tests.rs:5205`'s assertion (`#57 @0` at Cleveland F6 refused; the legal-placement query empty) is ported.
  Measured before → after, over every hex of all three boards at all four eras: **standard 79 → 0, 1830+ 106 → 0,
  LPF 87 → 0 (272 → 0)**. The standard-board 79 reproduces Stage 9.1's figure exactly, hex for hex and facing for
  facing; the other two boards were never enumerated before and are reported here for the first time.
- **F-2, printed board topology — RESOLVED.** New `sandboxTileLegality.priorTopologyAt(mapGrid, q, r)` (design note
  **#1621**) answers "what track stands on this hex right now" in `liveEdgesForHex`'s own fallback order — laid tile
  (a `printedTile` IS a laid tile, #1301) ▸ gray ▸ off-board ▸ landmark ▸ nothing — and rule 5 is fed from it
  instead of from a `TileCatalogEntry`. **Replacement, not union**: this board's semantics are that a laid tile IS
  the hex's topology, and a test pins `priorTopologyAt(...).mask` equal to `liveEdgesForHex`'s answer on **every hex
  of every board**, so the route graph and the lay predicate cannot disagree about what exists.
- **THE "FOUND CASE WITHDRAWN" PARAGRAPH ABOVE IS ITSELF CORRECTED.** Stage 9.1 measured the three landmark hexes on
  the **standard** board only and warned the `staysOnBoard` masking "breaks if any board edit gives I15, E23 or G19 a
  neighbour it currently lacks". **The edit had already happened.** On the expansion Baltimore I15 has all six
  neighbours, and the wrong-parity facings survive the rim test: **six** track-deleting lays were accepted there
  (`53@1 53@3 53@5 592@1 592@3 592@5`), and **three** on the Level Playing Field (`53@1 53@3 53@5`, #592 being out of
  that tray). So S9-10's original recorded case — "an expanded/LPF Baltimore facing that cuts printed track is
  offered and accepted" — was **right about the hex and the boards** and wrong only about the tile pairing. Slice 9.2
  refuses all nine, for preservation rather than for the rim. Boston and New York are unchanged on every board.
- **G19's facing 4 is still refused**, by `staysOnBoard`, and deliberately: revised 6.2.1 ❷'s edge-termination rule
  is a separate rule from immutability and is **not** in this slice's scope. Recorded so it is not read as fixed.
- **Corpus: neutral for F-1 and F-2, as predicted.** Baseline `d837419` → Slice 9.2 across 11 log files (8 distinct):
  identical stored / applied / dropped / unparseable counts, identical final game state, and no acceptance change
  attributable to either finding.
- Whole-board before → after sweep, all three boards × all four eras × all 76 types × 6 facings:
  **0 placements newly accepted** outside M-11 (S9-18), and every newly refused placement is on an immutable hex or
  is a Baltimore facing that cuts printed track.

*POST-COMMIT VERIFICATION (2026-09-18, after `17616c8`).* A VF-5 animation fixture failed once F-2 landed, and the
audit **confirmed the refusal**. The fixture picked a Plus-board Baltimore (I15) → #53 facing by
`describeTransition(...).removed > 0`, and the only such facings were the ones that severed Baltimore's printed
`(0,4)` rail; `VISUAL_FLOURISH_BACKLOG.md`'s **D-19** had already recorded the cause in F-2's own terms ("its
path-preservation rule runs only over a laid tile") and deferred it here. **D-19 is now RESOLVED by Stage 9.2.**
Legal I15 → #53 facings are **0/2/4** (1/3/5 refused, each losing both printed exits and the whole `(0,4)`
segment); #592 shows the same parity; **E23 → #53 is 1/3/5 and unchanged**, the control showing #53 is not globally
over-restricted. The hex stays upgradeable. An exhaustive sweep found **28,438 legal transitions across the three
boards (standard 6,859 · plus 11,313 · LPF 10,266), 1,405 with `reconfigured > 0` and ZERO with `removed > 0`** —
so `removed > 0` is not reachable from a legal transition, and the stale fixture must NOT be repaired by hunting
for one. **No production legality change was required, no VF-5 code or test was touched, no gameplay defect is
filed, and the corpus/golden conclusions above are unchanged.** Detail: `STAGE9_TILE_TOPOLOGY_AUDIT_2026-09-18.md`
§20k.

**S9-15. ~~The 1830+ tray under-supplies #63 by three, and a test pins the wrong figure.~~ RESOLVED.**
Status **`RESOLVED`** (Slice 9.3, 2026-09-18, uncommitted — resolution appended at the end of this entry). Was `OPEN` (found by Stage 9.1, 2026-09-18; `STAGE9_TILE_TOPOLOGY_AUDIT_2026-09-18.md` §4 / §10, finding F-4).
T-09 gives `C15` = old **#63** a Classic count of **3** and an 1830+ delta of **+1**, i.e. **4** copies under the
expansion — and the brown column's own footer total (+11) only reconciles with that +1. `tileTrayPlus.RECOUNTED`
sets `[63, 1]`, so `PLUS_TRAY` and `LPF_TRAY` hold **one** #63 where the rulebook has four, and `PLUS_TRAY` totals
**135** copies against the rulebook's **138**. Every other one of the 76 types matches exactly in all three trays,
and Classic reconciles tile-for-tile. The wrong figure is *pinned*: `plusTiles.test.ts:72` asserts `[63, 1]` against
"the request", not against T-09 — which is why this survived. Fix is one number plus re-pointing that assertion at
the rulebook. Replay: **acceptance-widening** (a fourth #63 becomes layable), corpus-neutral — the corpus never
exhausts the tray. **Revision 9.1b:** the inventory is **replacement, not additive** — `PLUS_TRAY` copies `STANDARD_TRAY.counts` and
then `counts.set(63, 1)`, and #63 is not `plusOnly`, so the later "add each plusOnly entry" loop does not restore
it; the effective 1830+ supply really is **1** against T-09's **4**. No scenario removes a #63, so LPF inherits the
same shortfall. **The official Mayfair errata does NOT alter the count** — its #63 item is about the *value*
("The C15 (63) tiles have the wrong value. The value should be 40, instead of 50"), and the engine already carries
`revenue: 40`, so that half is a **PASS**. Since the other seven recounts match T-09's totals exactly, a
transcription of "+1" as "1" in the owner spec is the likely story. **Revision 9.1c — CONFIRMED BY COMPONENT
EVIDENCE, no owner confirmation needed:** the errata's own correction tile sheet (pages 2-3 of the errata PDF,
headed "1830 - Errata Sheet MFG1830-88") instructs **"40 value added to 1830+ side of all four C15 tiles"** —
four physical #63 tiles on the 1830+ side, exactly T-09's `3 +1`. The earlier suggestion to seek owner
confirmation is withdrawn. Corpus-neutral: 4 lays of #63 across the corpus, peak 2 simultaneously on a board.
Related doc drift: `tileSupply.test.ts:38`'s comment says "the 28 of the tile set" where it
asserts 30.

> **RESOLVED — Slice 9.3, 2026-09-18 (uncommitted).** `tileTrayPlus.RECOUNTED` now reads `[63, 4]`, with design
> note **#1629** on the list stating what every row of it means: these are **TOTALS**, because the map below is
> `counts.set` (replacement), and #63's row carried T-09's "+1" column into a slot that means the whole supply —
> which under replacement semantics DELETED the three Classic copies instead of adding a fourth. Every other row
> already read as a total (#59 `2 +1` → 3, #14 `2 +2` → 4, #9 `7 +5` → 12), which is why only this one was wrong.
>
> **Fixed in the PHYSICAL SUPPLY, ahead of every scenario removal**, so both derived trays inherit it untouched:
> Classic **3** (unchanged) · full 1830+ **4** · published Scenario D **4** · Project 18XX LPF **4**. #63 is on no
> removal list — not T-01's S-1.0 Ⓓ list, not S-1.1 ❻, not `LPF_TRAY_REMOVALS` — and the errata correction sheet
> prints Ⓑ Ⓓ Ⓖ Ⓡ on C15, so Scenario D is a scenario that KEEPS it. The TO override (#1395, §10c) is untouched and
> does not extend here.
>
> **Measured tray delta against Stage 9.2, complete rather than sampled:** `PLUS_TRAY` **76 types / 135 → 138
> copies**, `LPF_TRAY` **72 types / 127 → 130 copies**, `STANDARD_TRAY` **46 / 85 unchanged**, and the only
> per-tile difference in the whole inventory is `#63: 1 → 4`. Pinned by an explicit whole-inventory literal in
> `stage93TileAuthority.test.ts` ("NO OTHER TILE QUANTITY MOVED"), so a future count that drifts for any reason
> fails with the tile named. `plusTiles.test.ts` now asserts `[63, 4]` **against T-09 and the errata sheet**, with
> the reasoning in the test rather than "the request"; `tileSupply.test.ts`'s "28 of the tile set" comment drift
> (F-7) is corrected to 30.
>
> **Corpus: neutral, as predicted** — 18/18 files byte-identical in state, per-entry `map_grid`, every lay verdict
> and final board. The tray is never exhausted in any log.
>
> **One arithmetic correction to this audit's own §10, recorded and not a code defect:** the audit states the
> engine's LPF tray holds **74** distinct types. Measured, it holds **72**. `LPF_TRAY_REMOVALS` takes 2 each of
> #5 and #6, and the 1830+ tray holds exactly 2 of each, so those two types reach zero and leave the tray for the
> same documented reason #592 and #61 do. Four types drop out, not two. Copy counts are unaffected and were
> always right.

**S9-16. `oo13 -> oo20` has no legal facing — a contradiction in official material, NOT an engine defect.**
Status **`RECORDED`** (informational — NOT an engine defect; reclassified at revision 9.1c and the header
corrected at Stage 9.5, from this entry's own body). *(Was `OPEN — BLOCKED`, found by Stage 9.1, 2026-09-18; **split and narrowed at revision 9.1b the same day**;
`STAGE9_TILE_TOPOLOGY_AUDIT_2026-09-18.md` §8c). This entry used to cover two dead ends. **The oo1 half is
WITHDRAWN**: the official Mayfair errata states plainly under *Rules* — "**Tile oo1 (8861) is not upgradable**" —
and the repo already carried the owner's own playtest ruling to the same effect (`App.tsx:3331`, from the LPF report
"the green OO tiles when clicked do not have any tileselector popups to upgrade them", RULED: "there's no upgrade
for 626, it stops at Green", with design note #1390 giving the player an explicit "no upgrade in this game" receipt
pinned by `actionReceipt.test.ts:218`). So T-09's `oo1 → oo10-oo17` row is erroneous material, the engine's zero
facings are **correct**, and no stale metadata exists anywhere in the repo — the only artefact that ever claimed oo1
successors was the first pass of the Stage-9.1 audit, which its own revision withdraws.

**What remains is oo13.** The errata voids oo13's printed old number (**"should have a number that is NOT 36 —
neither support site has a number for this tile"**) and supplies no replacement, but it does **not** retract
`oo13 → oo20`, so that edge stands. The engine offers **zero of 36 facings**, and the cause is now isolated exactly.

*The engine's oo13 geometry is independently authored, not contaminated by historical tile #36.*
`plusTiles.test.ts:133-137` pins every expanded two-city tile against the owner spec's own edge numbers (0 NE,
clockwise, via `edge()`), and those assertions **are** the spec: oo13 = cities `{0,2}`/`{3,5}`, oo14 =
`{0,2}`/`{1,3}`, oo1 = `{0,1}`/`{3,4}`, oo17 = `{0,1}`/`{2,3}`, oo20 = `{0,1,3}`/`{2,4,5}`. So the engine neither
aliases oo13 to tile #36 nor copies #36's geometry — it defines its own and merely *labels* it with the voided
number (S9-21).

*Why every facing fails.* Both of oo13's cities are gap-2 pairs (two exits with one edge between). Reduce such a
tile to one rotation- and reflection-invariant number — the separation between its two cities' gap-centres. oo13's
is **3 (opposite)**; oo14's is **1 (adjacent)**. Sweeping every synthetic gap-2 two-city source against the engine's
`#167`: separation **1 → 6 legal facings**, separation **3 → 0**, and `#167` admits separation 1 only. The failure
is therefore neither a predicate defect nor a facing defect but a **shape disagreement between the oo13 record and
the oo20 record**, and it is total.

*And it cannot be repaired through `#167`.* Enumerating every two-city partition of a six-exit gray OO and asking
how many of T-09's eight `ooNN → oo20` edges each can host with the cities kept distinct: **the maximum is 7 of 8,
six different partitions achieve it, every one of them omits exactly oo13, and the engine's `[[0,1,4],[2,3,5]]` is
one of the six.** The only partitions that admit oo13 lose between two and five other T-09 edges. **So `#167` must
NOT be changed** — it already maximises conformance.

*Two mutually exclusive hypotheses remain, and one artefact decides.* **H1:** oo13's shape is wrong in the engine —
if its true cities are separation-1, the edge gains 6 facings, T-09 reaches 8/8, `#167` stays as it is, and the fix
is one `cityGroups`/`paths` correction. (T-09's thumbnail weakly favours H1: oo13's circles read as clustered on one
side of a through-rail while oo14's are separated across a diagonal, and "clustered" is what separation 1 looks
like — but at ≈70 × 80 px native that is an impression, not evidence.) **H2:** oo13's shape is right and T-09's
`oo13 → oo20` is further erroneous material like its oo1 row, in which case the engine is already correct and
nothing is owed.

**REVISION 9.1c — RECLASSIFIED: NOT AN ENGINE DEFECT. Status `RECORDED` (informational), not `OPEN`.**
Two authorities arrived. (1) The replacement tile sheet is **pages 2-3 of the official errata PDF itself** (headed
"1830 - Errata Sheet MFG1830-88"), and **oo13's legend prints `oo13 -> oo20`** with roundels **B D G R**; oo14's
prints `oo14 -> oo20`. (2) The **owner supplied the authoritative physical-tile transcription**: oo13 and oo14 are
**BROWN** OO tiles, each with **two separate large cities whose systems are not connected**, **oo13 joining edges
{0,2} and {3,5}**, **oo14 joining {0,2} and {1,3}**, **$50 revenue each**. **The engine matches that transcription
on every field** — colour Brown, two `DoubleCityHub` cities at one slot each, those exact city groups (in both edge
conventions), revenue 50. So neither 9.1b hypothesis survives: the edge is official (H2 dead) **and** the engine's
oo13 geometry is correct (H1 dead).

**The residue is a contradiction between official sources.** oo13's two cities are gap-2 pairs whose gap-centres sit
**3 apart**; `oo20`/#167's two 3-edge cities offer exactly one gap-2 pair each, at gap-centres **1 apart**; a
rotation moves both centres together and can never turn 3 into 1. And it cannot be repaired by re-splitting `oo20`:
enumerating **every** candidate gray-OO geometry — all live-edge sets of size 4-6 crossed with all 2- and 3-city
partitions, **556 candidates** — **none** hosts all eight of T-09's `ooNN -> oo20` rows with the source cities kept
distinct. The maximum is **7/8**, every 7/8 candidate omits oo13, and **the engine's current #167 is one of them**.
The best candidate that does host oo13 reaches only 5/8, losing oo10 (#68), oo12 (#66) and oo17 (#984). The
degenerate 8/8 escape (a one-edge city plus a five-edge city, i.e. a single effective city) is closed by T-09's own
`oo20` art, which shows two separate circles.

**Therefore: nothing to implement. Do NOT touch `#167` and do NOT touch oo13.** The engine already implements the
maximum-conformance reading and preserves every Classic OO upgrade. Recorded for the publisher. If the owner ever
prefers to honour the correction sheet over T-09's oo10/oo12/oo17 rows, the alternative is costed: re-split `oo20`
to `{0,2}/{1,3,4,5}` (or an equivalent), gaining `oo13 -> oo20` and losing those three. That is a preference between
conflicting official rows, not a defect.

*Measured with the confirmed geometry:* **oo14 -> oo20 is legal at 6 of 36 facing pairs** (oo14@0 -> oo20@1, @1->@2,
@2->@3, @3->@4, @4->@5, @5->@0), all keeping the two cities distinct; **oo13 -> oo20 is legal at 0 of 36**. Across
the whole reconciled graph — T-09 plus the revised Classic tables plus the correction sheet, minus the errata-voided
oo1 row — **119 publisher-valid edges, exactly one with no legal facing: `oo13 -> oo20`.**

~~**REVISION 9.1c — THE ART WAS FOUND, AND IT KILLS H2.**~~ The replacement tile sheet is **pages 2 and 3 of the
official errata PDF itself**, headed "1830 - Errata Sheet MFG1830-88"; 9.1b searched for it as a separate artefact
and never opened the PDF's own image content. Rendered and read this pass, each corrected tile carries a legend hex
with its identifier, old number, scenario roundels, upgrade line and set. **oo13's legend prints `oo13 -> oo20`**
(and oo14's prints `oo14 -> oo20`), with roundels **B D G R** on both. So the upgrade is **affirmed by the
publisher**, not merely un-retracted: **H2 is dead**, and the remaining explanation for the engine's zero facings is
that **oo13's `cityGroups`/`paths` do not match the corrected tile (H1)** — an engine catalog defect.

**What is still unread:** the tile's **rails** — which of the six edges runs into which city. The browser pane used
for the visual pass entered a stuck CSS-scaled zoom state partway through (screenshot timeouts, clicks refused as
"frame owner is CSS-transformed", scroll acting as zoom), so colour, label, city count and every legend hex were
read but the track geometry was not. **This is now a rendering-resolution gap, not a source-retrieval gap, and it
must NOT be converted into an owner ruling.** It closes in one step: save the errata PDF into a connected folder and
render pages 2-3 with `pdftoppm` at 300-600 dpi, as the 48-page rulebook was rendered in the first pass. The sheets
are vector art with a real text layer, so the rails will resolve cleanly. It blocks one item inside Slice 9.3 and nothing else; Slice 9.2 is unaffected. The deciding test, once the
page is rendered: read oo13's two cities' exits off the tile and compute the separation between their gap-centres —
**1 means the expected H1 fix** (correct `cityGroups`/`paths`, expect 6 legal facings, leave `#167` alone);
**3 would mean official material contradicts itself**, since the same sheet prints the upgrade, and that is then a
genuine STOP rather than a catalog edit.

Replay: **corpus-neutral either way.** JUNO-Z6C 399 lays oo13 on E5 and never upgrades it, but that lay is already
illegal for the #59 reason (S9-19), so S9-16's outcome does not change that log's fate. Related durable fix, owed in
the same slice: a standing catalog invariant test — *every upgrade edge that survives reconciliation has at least
one legal facing* — which would have caught this the day the tile was added.

**S9-17. ~~Rule 7.2.2 ❹ — station anchoring and slot capacity — is enforced only in the shell.~~ RESOLVED.**
Status **`RESOLVED`** (Slice 9.2, `17616c8`, #1623 — `gameEngine/stationAnchorAuthority.ts` puts revised 6.2.2 ❹
in the reducer, ahead of every mutation; resolution appended at the end of this entry; header corrected at Stage
9.5). *(Was `OPEN`, found by Stage 9.1, 2026-09-18; audit §12 / §13, finding F-5.)* `utils/stationConnectivity.ts`
(design note #878) implements the rule correctly and in the rulebook's own terms — a token is anchored to its **edge
set**, not its city index, and `fitStationsToUpgrade(anchors, candidateCities, slots)` returns `null` for a facing
that strands any token **or overfills any city** (#1315). ERIE falls out of it rather than being special-cased: a
tokenless token has no edges, so ❹ is vacuous and every facing stays legal, and by the brown upgrade it is
constrained like everyone else. But `planTokenUpgrade` gates **`legalRotations`, a `useMemo` in `App.tsx:10797`** —
whose own design note #879 says in so many words *"SO THE FILTER IS PART OF LEGALITY, not a courtesy"* — and it is
**not** in `layRefused` (`operatingIdentityRefusal ‖ authoritativeHoldRefusal ‖ filterSandboxPlacements`), nor in
`replayProviders.layRefused`, which is `filterSandboxPlacements` alone. So the reducer accepts whatever
`token_cities` a message carries, clamps out-of-range indices (#1315) and never checks that a token's new city
carries its old connections or has room; a replay re-validates the tile and the facing but not the token landing.
The only shipped edge where capacity can shrink is `#592 → #61` (S9-10's exception manifest), so the live exposure
is narrow — but this is **the same pattern as S9-1** (`YellowSignEvent` client-authoritative), and the two want the
same discipline. Fix: call the existing pure function from the authority; the shell keeps calling it for the rotate
gesture. Replay: **refusal-added, corpus-neutral** (§14: every stored token landing is edge-consistent and
single-token).

*RESOLVED BY SLICE 9.2 (2026-09-18, uncommitted).* `gameEngine/stationAnchorAuthority.ts` (design note **#1623**)
calls the **existing** `planTokenUpgrade` — re-sited, not rewritten, because a second implementation of ❹ is the
divergence class `replayProviders.ts` #1199 lists three prior payments for — and `applySandboxActionCore` asks it
for every `LayTile`, beside the `layRefused` gate and ahead of every mutation the arm performs. It is not in
`filterSandboxPlacements`: that predicate's whole input is `{ mapGrid, q, r, era }` and a token is state, so
widening it would put state into the one pure board-geometry module in the codebase. Two refusals, and they are
different questions: **(1)** no legal landing exists (`planTokenUpgrade` returns `null` — a token is stranded, or
the landings do not fit the slots); **(2)** the message asks for a landing the board does not allow — the case a
crafted or replayed `token_cities` builds and the shell could never produce. The old single-index `token_city`
spelling (#824) is judged by the same rule. A token the message does not name is left to #1315's `clampCity`, so an
older log carrying no `token_cities` is not re-adjudicated. **Replay: refusal-added, measured corpus-neutral** — no
stored entry's acceptance changes and no final state moves.

*[REVIEW FOLLOW-UP, same slice] One real hole found and closed; the other four omission cases were already safe.*
All three placement arms accept `city_index === null` and write `station_token_hexes` **without** a
`station_tokens` entry (design note #560's third state), so "a station whose city nobody recorded" is reachable by
a direct client. Measured case by case: omitting `token_cities`/`token_city` for a station **with** a stored index
was already refused when the stored index is not the anchor (`effectiveLandingCity` mirrors the arm's own
named ▸ stored ▸ `clampCity` resolution); omitting one company from a non-empty map was already refused; and an
unindexed station whose plan anchor exists was already over-constrained by `cityExitEdges(…, null)`. **The hole was
capacity for a `free` unindexed station**: `fitStationsToUpgrade` counts a free token against no city on a
multi-city candidate (#1315), and the authority skipped it too — so three stations could be seated on #59's two
slots by a message that said nothing. Closed by design note **#1625**: every station is projected
(named ▸ `token_city` ▸ stored-and-clamped ▸ `planTokenUpgrade`'s own derived anchor), all projections count
per city, and a **total-slot floor** (`stations on the hex ≤ Σ slots`) covers the case where no destination is
decidable. No second remapping algorithm; the mirror is pinned against what the `LayTile` arm writes.
**Legacy replay preserved, measured:** across all 18 corpus files there are 30 lays onto a tokened hex, **every one
carrying exactly ONE station**, so the floor cannot fire; the 2 that name no mapping (`export/JUNO-3XD` 121 and
316) were already refused at baseline for unrelated reasons and remain refused. No adapter was invented. `App.tsx` was **not touched**: `legalRotations` keeps
its own call, and collapsing the two call sites into the shared helper is recorded as a narrow UI/legal-sync cleanup
(see S10 below), not done here, because owner modal/UI work is live in that file.

**S9-18. ~~Level Playing Field is missing T-02's printed straight track at M-11.~~ RESOLVED.**
Status **`RESOLVED`** (Slice 9.2, `17616c8`, #1622 — `hexBoardDataLpf.ts` gains the printed straight `#9@0` at
M-11; resolution appended at the end of this entry; header corrected at Stage 9.5). The Stage-9 closure
reconciliation measured its consequence: the tile is in the INITIAL grid, so the board differs from index 0 on
all **11** Level Playing Field logs and on none of the others — a static/setup difference with **zero** gameplay
state divergence. *(Was `OPEN`, found by Stage 9.1, 2026-09-18; audit §5 / §10, finding F-6.)* Printed Scenario D places seven board
tiles (T-02, p. 45; S-1.1 ❷, p. 34): Coal River L-8, the five warehouses M-13 / L-2 / F-2 / A-11 / B-24, and
**"Straight Track (30g) … use an A-1 tile" at M-11** — A-1 being old **#9**. The engine models the first six
(`COAL_RIVER_*`, `LPF_WAREHOUSES`) and **not the seventh**: `LPF_BOARD` carries no `printedTile` on any hex, and
M11 is the expansion's bare `hex("M11", { type: "Plain" })`. The tile would join **M9 ↔ M13** (M11 is (-1,12); M13's
printed W stub faces M11's E edge, and M11's W edge faces M9), i.e. a printed rail into the Deep South that the
variant assumes. The mechanism already exists — design note #1301's `printedTile`, realised by `initialGridFor` as a
`MapTileEntry` flagged `printed`, which every reader including rule 5 and `tileSupply` handles correctly (the
expansion's green #24 at H12 is the precedent). Verify the facing against the rendered board before committing.
Replay: **acceptance-changing for LPF** (a rail exists that did not), so this is the change in Slice 9.2 that forces
the version bump. Note also that the rulebook cites "Table T-01 on p. 44" for board tiles when they are in T-02 on
p. 45 — a rulebook typo, recorded so it is not chased.

*RESOLVED BY SLICE 9.2 (2026-09-18, uncommitted).* `hexBoardDataLpf.ts` gains
`hex("M11", { type: "Plain", printedTile: { tileId: 9, orientation: 0 } })` (design note **#1622**), a delta on the
EXPANSION's M-11, so the standard and 1830+ boards keep their blank hex. The orientation is derived from the
neighbour arithmetic rather than from the coordinate's name: M-11 is (-1, 12), #9's `connections: 0b001_001` are
edges 0 and 3, edge 0 is (0, 12) = **M-13** and edge 3 is (-2, 12) = **M-9** — the straight T-02 prints, and the
rail M-13's own printed W stub (#1313) has been pointing at. Verified by test: the route graph traverses 0↔3 and
refuses 0↔1; the tray is untouched (`tileStock(9).placed === 0`, because `initialGridFor` flags it `printed`);
M-11 now offers only the five green tiles that keep the straight (`18@0 23@3 24@0 26@3 27@0`) and no yellow tile at
all; the other two boards still show a bare hex that takes `9@0`.

*REPLAY: ACCEPTANCE-CHANGING, AND — CONTRARY TO STAGE 9.1's §14c — NOT CORPUS-NEUTRAL.* The audit reported "no lay
on M11 in any log". **Two logs lay there**, and the baseline → 9.2 comparison resolves them exactly:

| Log | Entry | Lay | Baseline | Slice 9.2 | Cause |
|---|---|---|---|---|---|
| **JUNO-FCJ** | **159** | `#9@0` at M-11 by corp 4 | **refused** — `operatingIdentityRefusal`: *"Only the operating corporation lays track — B&M is operating, not B&O."* | **refused** (identity first; now tile-illegal too) | **no change** |
| **JUNO-Z6C** | **227** | `#8@0` at M-11 by corp 4 | **accepted** (bare hex, legal yellow lay) | **REFUSED** — the hex already holds printed yellow track, so the lay fails both the colour step and preservation | **S9-18** |

So **exactly one stored action changes acceptance in the whole corpus**, it is the one S9-18 predicts, and refusing
it is the correct rules outcome: under T-02 that hex was never blank, and #8 both repeats the colour tier and cuts
the printed straight. Consequences, measured: **the final game state of every log is byte-identical** (M-11 is Plain,
so `withTerrainPaid` records nothing for a $0 hex and the refusal leaves no trace in state), and no recorded route
ran through M-11. The only board difference in the whole corpus is at (-1, 12): every LPF log gains the printed
`#9@0`, and JUNO-Z6C loses the `#8@0` it should never have had.

*GOLDENS RE-PINNED IN THIS SLICE [review follow-up].* `replayGolden.test.ts` failed on **JUNO-CV4** and
**JUNO-G6J** for this and only this reason. On review both fixtures are re-pinned now, with the reason
**"S9-18 — restore printed LPF M-11 straight from T-02"**: each gains the single grid entry
`{"q":-1,"r":12,"tile_id":9,"orientation":0,"paths":[[0,3]],"landmark":null,"printed":true}` and nothing else —
`applied` 141/10 unchanged, `dropped` 36/0 unchanged, `unparseable` unchanged, every other grid entry and the whole
state byte-identical, verified by a harness before the write and visible as a **pure insertion of 14 lines with zero
deletions** in `git diff`. `JUNO-7NZ.json` is untouched (not an LPF game). **The re-pin does not need an
intermediate version bump** — it records the expected behaviour of the uncommitted Stage-9 implementation. The
Stage-9 `RULES_ENGINE_VERSION` bump remains owed at closure, and S9-19's future re-pins stay separate and will be
justified on their own. Raw logs byte-unchanged.

**S9-19. ~~#59's two pre-printed exits may never be connected by an upgrade, and seven accepted facings break that.~~ RESOLVED.**
Status **`RESOLVED`** (Slice 9.3, 2026-09-18, uncommitted — resolution appended at the end of this entry). Was `OPEN` (filed at Stage 9.1 revision 9.1b, 2026-09-18; `STAGE9_TILE_TOPOLOGY_AUDIT_2026-09-18.md` §8a/§8b).
**PRINTED RULE, not an owner decision.** 2018 revised rulebook §6.2.2 ❹, verbatim: "When a tile is replaced, all
stations on the replaced tile must be placed on the new tile with the same connections as before. **This also means
that the pre-printed exits on a (59) tile can never be connected in the tile upgrade.**" The first pass filed this
as S9-10's open ambiguity purely because it had no copy of the revised book; the clause names #59 explicitly.

*What is wrong today.* `preservesRouting` has no notion of which city an exit lands in — by design, since a hub is
mirrored as its full pairwise expansion — and #59's two exits are encoded as self-loops (`paths: [[0,0],[2,2]]`)
whose terminus relaxation (design note #676, correct and load-bearing) is satisfied by the edge merely surviving.
So a facing that puts both exits in ONE city of the brown tile reads as an *addition* and passes. Measured from
`#59 @0` over all six facings of each successor, the illegal-but-accepted pairs are **#67@4, #65@2, #64@0,
oo13@1, oo13@4, oo14@1, oo14@2** — seven in all.

*What it does not cost.* All five of the revised book's successors (`59 (2) → 64, 65, 66, 67, 68`) keep **at least
two legal facings** each: #68 @{2,5}, #67 @{0,2}, #66 @{0,5}, #65 @{0,4}, #64 @{2,4}, and #984 @{1,2} on the
expanded side. Nothing becomes unreachable, so this is a pure over-acceptance defect. oo13 and oo14 are reachable
from #59 *only* through illegal facings — i.e. not at all — which is exactly consistent with the errata voiding both
of those tiles' identities, and means T-09's `oo2 → oo10-oo17` range over-reaches by precisely those two.

*Implementation note.* This wants the general form, not a `if (source === 59)` branch: the predicate needs to know,
for each pre-existing city, which candidate city carries its exits — which is the same question
`stationConnectivity.fitStationsToUpgrade` already answers for tokens (design note #878's edge-set anchor). Land it
with S9-17 so one mechanism serves both halves of ❹, the track half and the station half.

Replay: **refusal-added, and NOT corpus-neutral** — three stored transitions become illegal, all with exactly one
token on the hex (so the *station* half of ❹ was satisfied every time; the violation is the track half):
**JUNO-FCJ 640** (E11, `#59@5 → oo14@0` — no legal facing of oo14 exists), **JUNO-FCJ 1047** (E5,
`#59@4 → #65@0` — a bad facing; `#65 @2` and `@4` were both legal), **JUNO-Z6C 399** (E5, `#59@4 → oo13@2` — no
legal facing of oo13 exists). Two logs to re-pin and a version bump owed with Slice 9.2/9.3.

> **RESOLVED — Slice 9.3, 2026-09-18 (uncommitted).**
>
> **Architecture: tile metadata consumed by generic machinery, not a tile-id branch.** `TileCatalogEntry` gains
> `separateSystems?: true` (design note **#1628**), carried by exactly one entry — old **#59** — and meaning *"this
> tile's `cityGroups` are SYSTEMS, and an upgrade may not put two of them in one connected component of the new
> tile."* A tile-specific fact is the honest shape here because **the printed rule is itself tile-specific**: ❹
> names "(59)". `priorTopologyAt` reads the flag off the LAID tile and rotates the groups to board edges, so
> `HexTopology` now carries `separateSystems`; `separationPreserved` is rule **5b** of `filterSandboxPlacements`,
> beside rule 5 rather than inside it, because the two ask different questions — rule 5 asks whether the track
> that is here SURVIVES, 5b asks whether two systems that were apart are still apart. **No tile id appears in the
> predicate** (`sandboxTileLegality` design note #1 forbids it), and it is semantic metadata rather than a
> coordinate/facing blacklist.
>
> **Systems are defined topologically, never from renderer strokes.** The source systems are #59's own
> `cityGroups`, rotated; the destination's connectivity is the union-find closure of `tileSegments`' rotated
> `paths` — the mirrored backend routing `pathfinding.rs` itself walks, present on all 76 entries, in which a hub
> is its full pairwise expansion, so a one-city hub answers "connected" without being special-cased. A `[e, e]`
> terminus unions with nothing (#676's reading) and the artwork's `CITY_ENDPOINT` sentinel is dropped rather than
> unioned through, because the artwork collapses every centre of a multi-city tile onto one symbol. No destination
> `city_index` is required and no SVG is read.
>
> **Deviation from this entry's own implementation note, deliberately.** The note proposed landing it with S9-17's
> `fitStationsToUpgrade` edge-set anchor. That mechanism runs **per token, in the reducer**: a hex carrying no
> token has nothing for it to anchor, and #59's separation clause binds whether or not a station is present. The
> same *question shape* is used — which destination component carries this source edge set — asked in the
> placement predicate so it holds for every lay. The station half of ❹ stays exactly where Slice 9.2 put it.
>
> **Measured, complete matrix** — 8 successors × 6 destination facings × 6 source facings = **288 candidates**;
> **114 offered before → 72 after**; **42 refused**, which is §8b's seven pairs reproduced at all six source
> rotations (source-rotation invariance is itself pinned). §8b's table reproduces exactly at source `#59@0`:
> #68 {2,5} · #67 {0,2} · #66 {0,5} · #65 {0,4} · #64 {2,4} · #984 {1,2} · oo13 {} · oo14 {}. **All five Classic
> successors keep exactly two legal facings from every source facing**, so nothing became unreachable.
>
> **It did NOT generalize, and that is pinned by a control.** New York's two severed printed cities still become
> one connected green #54, the town-merge family (#1403) is untouched, Baltimore's chain is untouched, and a sweep
> over 60 hexes × the whole tray measures **> 500 legal component-merging upgrades still accepted**. A mutation
> that applies the rule globally takes that count to zero and fails the control.
>
> **Corpus: no divergence, and the cause is proven rather than assumed.** All 18 files are byte-identical in
> state, per-entry `map_grid`, every lay verdict and final board. The three stored transitions §14b adjudicates are
> refused at the 9.3 predicate — pinned directly, by reconstructing each source configuration — but in LIVE replay
> they never reach it: `operatingIdentityRefusal` already refuses each one **upstream and identically at baseline**
> (JUNO-FCJ 555/640/988/1047 — "A corporation only acts during an Operating Round", the replay being in a
> StockRound at those indices; JUNO-Z6C 378/399 — "Only the operating corporation lays track"). The #59 therefore
> never lands on E5 or E11 in replay, the destination hexes are bare, and the upgrade's precondition is absent.
> **§14b's adjudication is a read of the STORED ACTIONS against the rule and remains correct as such; the replay
> consequence it predicted does not materialise.** So: **no log re-pinned, no golden re-pinned, `replayGolden`
> green, and no version bump is forced by S9-19.**
>
> **NO CORRECTIVE AUTO-ROTATION.** JUNO-FCJ 1047 names `#65@0`; `#65@2` and `#65@4` are legal from that source and
> the engine refuses the action anyway. Pinned as its own assertion so the alternatives are on the record and
> visibly not taken.
>
> **Upgrade-graph consequence — and the three layers must be kept apart (design note #1632).** "The upgrade
> graph" names three different objects: **(A) declared relationships** (T-09 ∪ the revised Classic tables ∪ the
> correction sheet — *no such table exists in this repo, deliberately*, `tileUpgrades.ts` #675; it lives in the
> audit, which also RECONCILES it per §6b); **(B) legal relationships** — does any (source facing, destination
> facing) pass the real authority; **(C) the reachability closure** — `tileUpgradeGraph()`, a walk that lays a
> tile the board accepts and asks what replaces it, per (board, tray).
>
> **The 62 / 120 / 110 → 62 / 117 / 107 counts are LAYER C: reachable edges.** Standard **62 → 62**
> (oo13/oo14 are `plusOnly`), 1830+ **120 → 117**, LPF **110 → 107**. Three edges leave the closure and only
> two of them stopped being legal:
>
> | Relationship | Layer B (legal?) | Layer C (reachable?) | Why |
> |---|---|---|---|
> | `#59 → oo13 (36)` | **refused** — 0 facings at any combination | gone | S9-19: every facing connects #59's two pre-printed exits |
> | `#59 → oo14 (35)` | **refused** — 0 facings | gone | same |
> | `oo14 → oo20 (167)` | **STILL LEGAL — six facings**, the identity offset +1, exactly §8c-i | gone | oo14's only source was #59, so no reachable board holds an oo14 to ask from |
>
> **Nothing in this record may be read as "Slice 9.3 made `oo14 → oo20` illegal". It did not**, and a dedicated
> assertion measures its six facings so the claim cannot drift. **oo13 and oo14 are now unreachable from any
> board position in the expanded game** — the corrected-authority answer — while remaining in the tray, because
> they are physical components and inventory is not a legality question.
>
> **S9-16's "sole zero-facing edge" claim, made precise.** After 9.3 the raw, unreconciled T-09 range has
> **eleven** zero-facing OO rows: `oo1 → oo10-oo17` (eight, retracted by the errata's *"The oo1 (8861) tile is
> not upgradable"*, §6b class C, and already zero before 9.3), `#59 → oo13` and `#59 → oo14` (§6b class C,
> *"T-09 range over-reach on precisely the two tiles the errata voids"*, now also refused by the printed clause),
> and `oo13 → oo20` (§6b class F/C, **unresolved**). **So S9-16 is sole only of the RECONCILED set** — the one
> §8c's "119 publisher-valid edges · exactly 1 with no legal facing" counts, after the class-C rows a higher
> authority corrects out are removed. The difference is not arithmetic: every other zero-facing row has a
> **named higher authority that removes it**, and `oo13 → oo20` has none. That is what "a contradiction in
> official material" means, and why it alone is a residue. The unqualified sentence *"S9-16 is the only
> publisher-valid zero-facing edge"* is **no longer true after 9.3** and must carry the qualifier; the 9.3 suite
> asserts the qualified form and enumerates all eleven corrected-out rows by class.

**S9-20. ~~oo13 and oo14 carry revenue 50; the official errata records 40 for each.~~ WITHDRAWN — NOT A DEFECT.**
Status **`NOT A DEFECT` — WITHDRAWN** (revision 9.1c; header corrected at Stage 9.5, from this entry's own body).
*(Was `OPEN`, filed at revision 9.1b, 2026-09-18; audit §5b.)* The errata's *Tile Numbering — Older* section, in the
same breath as voiding each tile's old number, adds "**(it has a vaue of 40 rather than 50)**" for oo13 and
"**(it has a value of 40 rather than 50)**" for oo14. The engine has `revenue: 50` for both, pinned at
`plusTiles.test.ts:160`. This is the same 50 → 40 family as the errata's C15 (#63) item — "The C15 (63) tiles have
the wrong value. The value should be 40, instead of 50" — which the engine **already** honours with `revenue: 40`,
so the pattern is established and two of three are wrong. The errata does **not** name oo17 (#984), whose 50 stands.

*Honest caveat on the grammar.* The oo13/oo14 notes are phrased as observations rather than the imperative the C15
entry uses. Two readings: (i) value errata in the C15 family — the reading recommended here, three tiles in one
document about one tile sheet and one wrong number; or (ii) *distinguishing remarks* identifying which physical tile
is meant, given that no old number does. **Both readings put the printed value at 40**; they differ only in
certainty. One line of owner confirmation would close it, and the same replacement tile sheet S9-16 needs would
settle it outright.

**REVISION 9.1c — WITHDRAWN. Status `NOT A DEFECT`.** The owner's authoritative physical-tile transcription gives
**$50 revenue for both oo13 and oo14**; the errata's corrected tile art shows 50; the engine has `revenue: 50` for
both, pinned at `plusTiles.test.ts:160`. **The engine is correct and nothing is owed** — no value change, no test
move, no log re-pinned. The errata's parenthetical "(it has a value of 40 rather than 50)" is a *distinguishing
remark* attached to a tile that has no old number, and it is inaccurate; it is **not** a value correction in the
sense the C15 (63) entry is ("The value should be 40, instead of 50", an instruction the engine already honours).
The original reasoning is retained below only to show how the earlier reading arose.

~~**REVISION 9.1c — CONTESTED, DO NOT ACT.**~~ The errata's correction tile sheet was rendered this pass and the
corrected **oo13** and **oo14** faces each show a **"50"** value roundel in frame, while the corrected **oo11 (67)**
and **oo16 (64)** beside them each show **two** roundels, one per city, both 50 — which is how an OO tile is badged.
So either the errata's parenthetical is a *distinguishing remark* rather than a correction, or the roundel seen was
the second city's. The sheet's only explicit value instruction names a different tile ("40 value added to 1830+ side
of all four C15 tiles") and is phrased as an instruction, which the oo13/oo14 parentheticals are not. **Resolve by
reading both roundels on both tiles from the same render S9-16 needs, before changing any number.**

Replay, if it does become 50 → 40: **arithmetic, not legality** — both tiles sit on boards that ran to the end
(oo14 on JUNO-FCJ E11, oo13 on JUNO-Z6C E5), so the change would alter recorded route revenue there; land it with
S9-19, which re-pins the same two logs.

**S9-21. ~~Three tiles are keyed on printed old numbers the official errata voids.~~ RESOLVED (rules authority); display remainder → U-38.**
Status **`RESOLVED — rules/catalog authority`** (Slice 9.3, 2026-09-18, uncommitted — resolution appended at the end of this entry; three player-visible display sites remain, filed as **U-38**). Was `OPEN` (filed at revision 9.1b, 2026-09-18; audit §2b). Corrected project convention: **do not canonize an
old number the errata voids.** Where a corrected old number exists it becomes canonical and the printed one a
deprecated alias; where the errata voids the number and offers no replacement, the **Lookout ID** is canonical.

| Lookout ID | Canonical | Deprecated alias | Errata basis |
|---|---|---|---|
| oo1 | **#8861** | ~~#626~~ | "oo1 (626) should be oo1 (8861) according to one website supporting the older numbering system" |
| oo13 | **oo13** | ~~#36~~ | "should have a number that is NOT 36 — neither support site has a number for this tile" |
| oo14 | **oo14** | ~~#35~~ | "should have a number that is NOT 35 — neither support site has a number for this tile" |

The engine keys all three on the deprecated aliases — `TILE_CATALOG` `tileId: 626 / 36 / 35`, and every tray, test,
artwork and marker table off those. **Behaviourally inert today**: the ids are opaque unique handles and no rule
reads them as old 18xx numbers. It is a naming-authority debt, and the cheap fix is a canonical record plus
**input aliases** (`"626"` resolving to the oo1/#8861 record), not a rename of a dozen tables. Audit §2b classifies
every one of the repo's 34 `626` occurrences (topology source · display · test · unrelated colour string
`#262626` · unrelated design-note number). Replay: none. **Do not implement before Slice 9.3.**

> **RESOLVED for rules/catalog authority — Slice 9.3, 2026-09-18 (uncommitted). Rewritten twice: once for
> terminology at the closure pass, once at the production-use check, which found the first implementation was
> dormant.**
>
> **TERMINOLOGY FIRST, because this finding's own title was loose. THE ERRATA VOIDS NUMBERS, NOT TILES.** oo1,
> oo13 and oo14 are valid, correct, playable tiles with owner-confirmed geometry and revenue. What is void is
> **#626** (corrected to **#8861**) and **#36 / #35** (withdrawn with no replacement, so the Lookout identifier
> is the only valid name those two have). Nothing here reopens their geometry or their upgrade analysis.
>
> **THE INVARIANT:** *an errata-invalid old NUMBER may remain a stable MACHINE KEY for compatibility, and is no
> longer treated as a canonical RULES IDENTITY.* Two jobs, separated.
>
> | | stable storage / ABI key | serialized `tile_id` | canonical rules identity | canonical display LABEL (where the shared helper is consumed) | deprecated identifier | valid old number? |
> |---|---|---|---|---|---|---|
> | **oo1** | `626` | **`626`** | **#8861** | `#8861` | ~~#626~~ | yes — 8861 |
> | **oo13** | `36` | **`36`** | **oo13** | `oo13` | ~~#36~~ | **none exists** |
> | **oo14** | `35` | **`35`** | **oo14** | `oo14` | ~~#35~~ | **none exists** |
>
> **The display column is the label `canonicalTileName` yields, at the three surfaces that consume it — NOT a
> claim that every player-visible surface has been converted.** Three have not; they are listed under REMAINDER
> below and tracked as **U-38**.
>
> **WHERE THE AUTHORITY LIVES: on the live catalog, not beside it.** `TileCatalogEntry.canonicalId` (design note
> **#1630**), present on exactly three of the 76 entries, read through `canonicalTileName(tileId)` exported from
> `hexTileCatalog.ts`. Every production path already resolves a serialized `tile_id` through
> `TILE_CATALOG_BY_ID`, so the canonical identity is in hand wherever the tile is, with no second table to drift
> from. For the other 73 tiles the helper returns exactly the `` `#${tileId}` `` string every call site built by
> hand, which is asserted — a fix for three must not quietly relabel seventy.
>
> **THREE REAL PRODUCTION CONSUMERS**, all in files carrying no owner hunk:
>
> | Consumer | File | Was | Is |
> |---|---|---|---|
> | Activity Log sentence, every tile lay | `utils/actionLog.ts` `describeGameplayAction` | `laid Tile #626 on H18` | `laid Tile #8861 on H18` |
> | "this hex is finished" click/glow message | `components/hexGeometry.ts` `evaluateHexForTileLaying` | `already holds tile #36` | `already holds tile oo13` |
> | tile-picker tooltip | `components/TileSelectionPopup.tsx` | `Tile #35 — …` | `Tile oo14 — …` |
>
> **WITHDRAWN AT THE PRODUCTION-USE CHECK: the separate `components/tileIdentity.ts` module, with
> `resolveTileKey` and `acceptedTileSpellings`.** The first implementation described that module as the semantic
> layer while it had **no production consumer at all** — only the Stage-9.3 test imported it. A second dormant
> identity table beside the live catalog is duplicate authority, exactly the hazard audit §2's "three tables
> describe one tile" note names, so it is removed rather than committed. Its string parser went with it: a sweep
> finds **no textual tile-id input boundary in production** (`messageSchema` types `tile_id` as `"int"`; the only
> near-miss, `utils/gameHistory.ts:639` `Number(body.tile_id)`, is JSON-number coercion). Historical replay
> compatibility concerns the numeric `tile_id`, which never moved.
>
> **"Input-only alias" was wrong and is withdrawn.** `applySandboxLayTile` writes `tile_id: tileId` straight into
> the grid, so a #626 laid *today* still serializes as **626**. The integer is the **stable historical storage /
> ABI key**, written by new authoritative state as well as read from old; what is deprecated is the number **as a
> rules identifier**, and what normalizes is interpretation and display. Pinned by an assertion that lays a #626
> through the reducer and reads `"tile_id":626` back out.
>
> **Corpus: 18/18 identical to baseline `fdc4b9a`** after the wiring — per-entry state, per-entry `map_grid`,
> every lay verdict, final state, every final field, final board. The rendered sentence is UI state
> (`describeGameplayAction` feeds `App.tsx`'s label and toast); no stored log carries it.
>
> **REMAINDER → U-38.** Three player-visible surfaces still print the raw integer and were deliberately NOT
> touched, because each sits in an owner-dirty file: `App.tsx:3340` (the #1390 "no upgrade in this game"
> receipt — which is about #626 itself), `components/hexCanvasPrimitives.ts:1063` (the number drawn on the hex
> face) and `components/TileReference.tsx` (the Tiles tab). Display-only, no replay effect.
>
> **Read against the original finding** — a *naming-authority* debt whose own prescription was explicitly "not a
> rename of every reference" — this is **RESOLVED**. Read as "no player sees the voided number anywhere", it is
> **PARTIAL by exactly the three call sites above**. Both readings are stated so the owner can pick without
> re-deriving the scope.

**S9-11. ~~The Blood Price landing is not stamped as an arrival.~~ RESOLVED.**
Status **`RESOLVED`** (Stage 9.4a, 2026-09-19, uncommitted). Was `OPEN` (found by Slice 8.1, 2026-09-16; Yellow
Sign / Unpredictable Revenue only).

*Root cause, confirmed by trace.* `applySandboxMarketAction`'s `BuyTrainFromCorporation` arm (`sandboxSession.ts`
~2508) wrote `ctx.projectBloodPrice`'s returned cell straight into `market_positions`, the one call in that
function that bypassed `withArrival` (#646) — `SellStock` and `DeclareDividends` beside it both already route
through it. The landed mark therefore carried `enteredAt: undefined`. `operatingOrderKey` (`operatingOrder.ts`)
reads a missing `enteredAt` as `Infinity` — "unrecorded, sorts after every recorded one" — so the Blood Price
token sorted last in its cell regardless of when it actually arrived, and #647's ascending comparator then reads
ANY later, finite, stamped arrival into that same cell as having gotten there first (`finite < Infinity`),
inverting rule 4.5's stack.

*Repair.* One call site: `prices: { ...prices, [seller_protocol_id]: withArrival(prices, seller_protocol_id,
landed) }`, the same call the sale and dividend arms already make. No new state and no second history
mechanism — `nextArrival` already derives the ordinal from the marks on the chart rather than a clock, so the
fix is replay-safe by construction and needed no replay-ABI change.

*Tests.* `frontend/src/utils/bloodPriceArrival.test.ts` (new, 11 cases): a fresh landing is stamped; the exact
same-cell regression above (a Blood Price that arrives first still outranks a later stamped arrival into its
cell); event A-then-B and B-then-A ordering; the "lands where it started" no-op guard is undisturbed; replay
reproduces the same stamps in one burst; undo/revert leaves no stale counter (the ordinal re-derives from the
reverted chart rather than continuing); a crafted `BuyTrainFromCorporation` carrying forged `enteredAt`/`arrival`
fields is ignored (the message schema has no such field and the arm never reads one); trade price, move reason
and every other corporation's mark are untouched; the non-Carcosan refusal path is unaffected. All 11 fail
against the pre-fix code (checked by reverting the one-line change and re-running) and pass with it. Directly
implicated suites re-run clean: `batch60.test.ts`, `doubleWithhold.test.ts`, `holdBeforeChart.test.ts`,
`presidentCertificateSale.test.ts`, `soldOutRise.test.ts`, `operatingOrderFloatGate.test.ts`,
`operatingOrderTieBreak.test.ts`, `operatingOrderView.test.ts` (120 combined).

*Corpus.* Checked against the SAME 18-file canonical assembly Stage 8 / 9.2 / 9.3 measure against (the
`corpus()` builder shared by `moneyConservation.test.ts` / `stage85Closure.test.ts` / `presidencyCorpus.test.ts` /
`mohawkExchangeCorpus.test.ts`: `replayGolden/logs` (3) + `server/data/*.log.jsonl` (8) +
`frontend/sandbox-log-JUNO-{3XD,CV4,JJD,QVC,Y8V}.json` (5) + `JUNO-FCJ-prefix96.log.jsonl` (1) + the Z6C
494-entry fixture (1) — 18/18, not the 13-file partial sweep an earlier pass of this entry reported. Parsed each
entry's actual message (`payload` JSON-string or `msg`, per `entriesFromExport`) rather than raw-text grep, since
a raw substring match had first under- and over-counted here. Only `server/JUNO-FCJ` and `export/JUNO-QVC`
contain any `BuyTrainFromCorporation` (11 each), and neither ever fires a single `YellowSignEvent`. Only
`server/JUNO-Z6C` (615 rows) and the Z6C fixture fire `YellowSignEvent` — at 203 in both, and a second time at
567 in the full server log — and neither log contains a single `BuyTrainFromCorporation` anywhere; the 567 mark
is in any case immediately undone by a `RevertTo` at 569 (`"summary":"YellowSignEvent"`), so it never even
reaches the state the rest of that log replays from. No file both marks a Carcosan train AND sells one, so
18/18 are negative and the corpus conclusion stands: no canonical corpus game exercises the Blood Price landing,
therefore S9-11 causes no corpus/replay delta. `replayGolden.test.ts`, `moneyConservation.test.ts`,
`replayJuno3XD.test.ts`, `replayJunoCV4.test.ts` and `roundReplay.test.ts` all pass unchanged (54 combined) —
nothing to re-pin.

*Bump.* Replay-semantic in principle (a Yellow-Sign room with a Blood Price into an occupied cell would differ
between the two engine versions) but the corpus never reaches that condition. `RULES_ENGINE_VERSION` stays 6,
to bump collectively with the rest of Stage 9's closure as already planned.

*UI/readiness.* None owed — the chart already reads `enteredAt` off `market_positions` for every other mover;
nothing downstream needed changing.

**S9-12. The D&H's free station is not judged by the D&H's rules at either lock.** `RESOLVED` (Stage 9, Slice
9.4b, 2026-09-19). Was `OPEN` (found by Slice 8.2, 2026-09-16, by reading the code; pre-existing). `PlaceHomeStation{kind:
"dh"}` was refused at ingress only for the wrong actor and by the reducer's arm (`placeDhFreeStationToken`, #1615) only
for an unfloated corporation or a repeat placement on the hex; the D&H's own conditions -- its hex (F16), the owning
corporation, once, and the base game's rule that a station not placed on the turn the D&H tile is laid needs an
ordinary legal route (Table T-05 / the D&H description, p. 47) -- lived in `dhPower.ts` for the prompt only and were
asked at neither lock.

*Correction to the original finding.* The ingress owner check this entry described ("refused... for the wrong actor...
and the D&H's owner") was not merely incomplete, as filed -- it was structurally unable to pass. It compared the acting
PLAYER against `private_companies[DH].owner`, the private's player-owner field; `owner` and `owner_protocol_id` are
mutually exclusive (`gameState.ts` #379), and the D&H's power belongs to "the owning CORPORATION" (`dhPower.ts`'s own
description), which is only a real state once `owner_protocol_id` is set and `owner` is `null`. So the one check
ingress asked could never pass for the only board the power is meant to work on -- a legitimately corporation-owned
D&H reads `owner: null`, and `null !== actor` refused every actor there was. This is confirmed, not merely inferred:
the corpus's one `kind: "dh"` entry (3XD 115) already replayed as refused under the pre-9.4b code, and it was refused
by this broken check rather than because the free station was actually illegal there.

*Repair.* One predicate, `dhStationRefusal` (`gameEngine/dhStationAuthority.ts`, design note #1660), asked identically
by the reducer's arm and by ingress (`turnAuthority.ts`'s `turnRefusal` room-message branch), covering: the target hex
(F16 only); the D&H in play; ownership (the owning CORPORATION via `owner_protocol_id`, never the retired
player-`owner` check); floated; the acting corporation's own operating turn (`operatingCorporationId`); not already on
the hex (an idempotent signal, kept ahead of the lay/lapse check below for the reason noted next); the lay taken and
not lapsed (`dhPower.ts`'s own `dhPowerState`, asked for `forfeited` and the lay only -- deliberately never for
`tokenAvailable`, whose `used_private_abilities` "dh-token" input is marked by the reducer's own pre-arm bookkeeping
(#1204) before this predicate's own caller runs, which would otherwise make a first, legal call see its own
in-progress placement as an illegal repeat; `station_token_hexes` is the non-self-referential substitute); the same
operating turn as the lay, via a new turn-scoped state field, `dh_station_pending` (`gameState.ts` #1660, written by
the `LayTile` arm the instant the D&H's own lay succeeds and cleared everywhere `operating_sub_phase` itself is, for
the same reason #1183's `last_run_turn_key` and #1204's `used_private_abilities` needed to travel in state rather
than client memory); and, once a grid is available, the city's allowance, existence, occupancy and every reservation
via Stage 9.2's own `evaluateStationPlacement`, with connectivity the one printed exemption -- a caller's opt-in
(`skipConnectivity`, `stationTokens.ts` #1660) rather than a duplicate city-remapping algorithm, asked last and only
after every other question above already holds, so the exemption cannot travel anywhere the printed rule did not put
it. `$0` station cost is untouched by the terrain lay's own `$120` mountain fee, which `LayTile`'s arm still charges
exactly as before; the two were already separate and stay separate.

*Tests.* `frontend/src/utils/dhStationAuthority.test.ts` (new; 19 tests): the full LEGAL/REFUSE matrix -- wrong hex, D&H
not in play, non-owning corporation, player-owned D&H, not floated, not the operating turn, repeat use, forfeited,
lay not yet taken, timing (lay taken, not this turn), a malformed city index, no city capacity, no token available
(allowance exhausted), and a hand-crafted unknown-corporation message -- every refusal asserted by its sentence AND by
`stateDigest` equality (no mutation on refusal) at BOTH locks, plus controls proving the connectivity exemption fires
for the D&H and does not leak into an ordinary `PlaceStationToken` on the same hex, and that the pre-9.4b no-grid
answer still stands (#757). `homeStationAuthority.test.ts`'s existing #1615 describe block updated for the new
predicate (added a tile-57 F16 grid, `used_private_abilities`/`dh_station_pending` fixtures) plus a second test for
the no-grid caller; `turnAuthority.test.ts`'s D&H case rewritten to pin its assertion through the real
`dhStationRefusal` predicate rather than the retired `withOwner`-based check. All three suites pass (79 combined).
Mutation-tested: each of the hex, ownership, forfeit/lapse, repeat-use, timing and capacity/allowance checks was
disabled one at a time in `dhStationAuthority.ts` and the matching test(s) failed as expected, then the file was
restored byte-for-byte (`md5sum` verified) before continuing.

*Regression.* Directly implicated suites re-run clean, unrelated to the four owner-excluded test files: `dhPower.test.ts`,
`dhStationPrompt.test.ts`, `dhTokenStep.test.ts`, `freeStationAutoStage.test.ts`, `stationLegality.test.ts`,
`stationConnectivity.test.ts`, `stationCityReach.test.ts`, `stationTokenWall.test.ts`, `stationVeil.test.ts`,
`stationSlotPreview.test.ts`, `homeStationLpf.test.ts`, `homeStationWait.test.ts`, `operatingIdentity.test.ts`,
`operatingCursorReplay.test.ts`, `terrainFeeOnce.test.ts`, `terrainAffordability.test.ts`, `privateErrand.test.ts`,
`privatePowerFlow.test.ts` (294 combined) plus `replayGolden.test.ts` and `replayJuno3XD.test.ts` (9 combined) -- 382
tests total across the touched/implicated suites, all green. `npx tsc --noEmit` clean throughout.

*Corpus.* The same 18-file canonical assembly S9-11 measures against (`golden/*` (3) + `server/data/*.log.jsonl` (8) +
`frontend/sandbox-log-JUNO-*.json` (5) + `JUNO-FCJ-prefix96.log.jsonl` (1) + the Z6C 494-entry fixture (1), 4,105
entries). Exactly one `kind: "dh"` entry in the whole corpus: `export/JUNO-3XD` idx 115. That entry's preceding
`LayTile` (idx 114, `protocol_id: 7`, tile #57 on F16) predates the `ability_key` instrumentation (#1204/#1237)
entirely and carries no such field, so replaying it under the current reducer never marks `used_private_abilities`
with `"dh-tile"` -- but this is not itself the reason idx 115 no-ops under the new predicate: replayed forward, corp 7
(NNH) is `is_floated: false` and outside `active_operating_order` at that point in this log (a pre-existing,
already-diverged replay under earlier stages' stock/float authority -- NNH never floats anywhere in this replay, confirmed
by `replayJuno3XD.test.ts`'s own printed cursor), so the PRE-9.4b arm's own `is_floated` check already refused this
exact placement for an unrelated reason, before Slice 9.4b existed. S9-12 adds no new refusal here: idx 115 was
already a no-op, and remains one. `replayGolden.test.ts` (none of its 3 golden logs contain a `kind: "dh"` entry) and
`replayJuno3XD.test.ts` both pass unchanged.

*Bump.* Replay-semantic in principle (a corpus game that legally exercised the D&H's free station under the old,
under-checked locks could in principle replay differently) but the corpus contains no such game -- the one `kind: "dh"`
entry was already a no-op before this slice, for reasons this slice did not touch. `RULES_ENGINE_VERSION` stays 6, to
bump collectively with the rest of Stage 9's closure as already planned.

*UI/readiness.* `LEGALITY SYNC`. The shell's own D&H prompt (`dhStationPrompt.ts` / `dhFreeStationAvailableFor`,
#1237) already derives its "is the free station available" answer from the same `dhPowerState` machine this predicate
reads, and already only ever offers the placement on F16, on the owning corporation's own turn, right after its own
lay -- so ordinary play was never able to reach any of the newly-enforced refusals in the first place, and nothing in
the derived-action loop or the prompt's own copy needs to change. Filed here rather than skipped only because a
LEGALITY SYNC entry is owed whenever a lock gains a check that was not there before, per the Part C standing rule --
there is no follow-up task attached.
### Stage 10 — Replay / settlement / release hardening

**S10-1. Refusal transport.** A reducer refusal is an identity no-op that `RoomSession.submit` still answers
`applied` and appends (replays as a no-op); the ingress holds (#1530 / #1540) and, since Batch 6, the route,
dividend-amount and Run-Trains-skip refusals (#1550) — and, since Slice 8.2's S8-14 follow-up, a paid station placement's
identity and legality refusals (#1617) — answer `refused` with a reason (the shell shows it in the
room banner; `handleRunTrains` previews the evaluator's sentence in the route panel, #1554), every other reducer
refusal is still appended. And `actionWasRefused` (#778) compares by identity while the chart
step (#1197) returns a new object for every charted state, so the shell's REFUSED receipt cannot fire in room
play (Batch 3 §7). `OPEN`. Detail: answer `refused` keyed on `stateDigest(before) === stateDigest(after)` and
make the shell's receipt use the same comparison. Replay: appended no-ops are harmless; removing them changes
nothing stored.

**S10-2. `BUILD_ID` / `SetupGame.build` (#1252) is `"dev"` everywhere,** so the deal-build pin is nominal; the
rules-engine version (#1520) carries the replay boundary, but a per-deploy `BUILD_ID` would make the build pin
real (Batch 3 §6, Batch 4.5 §1). `DEFERRED` (deployment).

**S10-3. No historical reducer bundle exists by design:** a room pinned to an old version is held, never
reinterpreted (#1520). `OWNER DECISION` — recorded (also D-9).

**S10-4. Two composition layers.** `App.tsx` and `RoomEngine` compose the reducer's reports by hand (`App.tsx`
calls `applySandboxAction` / `applySandboxWaterfallAction` itself); #1281 was the second drift (all-pass private
income paid on the client only — TRIAGE_2026-09-08_JUNO-G6J, migrated). Class stays open until the live client
goes through `RoomEngine` or a compile-time coupling exists; a regression test at the engine (replay an all-pass
through `replayLog`, assert the bank paid) is still owed. `OPEN`. **Slice 10.1 (2026-09-22): the LayTile / grid-predicate
half is closed** — both grid steps ask `layTileRefusal` and hand it `boardLayRefused`, the one geometry the engine's
providers use (`replayProviders.ts`), so there is no hand-built predicate list left to drift. The reducer-context mirror
(`marketContext`, `chartInjections`, `parCellFor` built inline in `App.tsx`) and the all-pass test remain (Slice 10.3).

**S10-5. Server smoke test:** 5 pre-existing lobby/chat roster failures (`{kind:'chat', room:'LOBBY'}`),
reproduce on `53222c7` and earlier; transport, not rules (Batch 1 §2, Batch 4.5 §9). `OPEN`.

**S10-6. `src/tests.rs` (17.5k lines) should be mined for auction-interrupt and forced-purchase cases** before the
Rust crate is retired (audit "Test gaps"; `MIGRATION_PLAN.md` §4 / Phase 4; AUDIT_SETTLEMENT §8 gives the module
triage). `DEFERRED`.

**S10-7. Engine tests and packaging.** 304 engine-adjacent suites still live in `frontend/src/utils/` (Jest
`roots` + per-suite classification, Batch 1 §6d); a repo-root `shared/` package needs CRA's `ModuleScopePlugin`,
babel `include`, `tsconfig` `include` and the `sourceScan.ts` reader (137 tests) patched (Batch 1 §3).
`DEFERRED`.

**S10-8. The on-chain gameplay path is vestigial and should be retired together:** `UndoLastAction` (`return
state`, non-sandbox path only; kept in the schema so validation does not reject a dead message — Stage 2);
`EmergencyTrainPurchaseModal`'s non-sandbox string "Emergency purchases are not yet wired to the contract";
`frontend_blueprint.md`'s session-key gameplay design (superseded: session keys now sign log entries, not
contract messages). `DEFERRED` — with Phase 4.

**S10-9. Type debt the audits named and nothing closed (verified 2026-09-15):** the `LoggedMsg` union (#530 —
`App.tsx` still says "the honest fix is the `LoggedMsg` union" at three cast sites), and
`private_purchase_offer.price: number` vs `train_purchase_offer.price: string` (`gameState.ts` ~307 / ~333; the
train offer matches the contract's `Uint128` string convention, the private offer does not). `OPEN`
(AUDIT_SETTLEMENT §7, TRIAGE_2026-09-06 §3.3 — migrated). Replay: a type change alone is not replay-semantic;
changing the wire shape of `price` is a schema change (#1449) and must accept both spellings for stored logs.

**S10-10. The settlement / money-readiness track — indexed here, specified in `MIGRATION_PLAN.md` (#1254 order, AUDIT_SETTLEMENT §9).**
Status `DEFERRED` (blocks the first real deposit; not rules work). Done: 2.5a durable log (#1250), 2.5c
reconnection (#1253), 2.5e build pin (#1252), 2.5f full-field log hash (#1251), B3 selector deleted (#1255),
B2 Live/Async (#1256), C1 every-seat log export (#1334). **Open:** 2.5b session keys sign hello and every entry,
server verifies, signature stored on the entry, `trustClaimedIdentity` (#1210) retired; 2.5d roster from chain
(`SetupGame` seats `GameSession.player_addresses`, refuses a disagreeing room — no free-game path, DECISIONS
A6/B1) and the consent-gated `RevertTo` (author-only when nothing by another player follows; unanimous consent
deeper — #1220's gap); 2.5g clocks (measuring clock in every game; time-triggered `Forfeit` derived entry with a
scheduler re-armed from the log; on-clock player from `turnAuthority` including the answerer of a pending
offer; offer deadlines with auto-decline; `ClockSuspended` on restart; pause cap); 3a contract lifecycle
(Lobby → Started → Settling → Settled; Start, Checkpoint, Settle, AnnulByConsent, bonded Challenge, liveness
settle-from-checkpoint; retire creator-annul-after-start and the 48 h valve) on testnet; 3b server checkpoints
and settlement, client auto-sign / challenge UI; 3c forfeit + clemency with AUDIT_SETTLEMENT §4's arithmetic;
Phase 4 retire `src/` after real games settle. **Verification still owed on the server path** (migrated from
TRIAGE_2026-09-06 §1/§3): restart-restore in a browser (deal, kill, restart, reload both clients); reconnection
banner and a move clicked during an outage; both negotiation flows in both directions plus a reload of either
client mid-negotiation (the derived purchase arrives in the same applied frame as the answer, once); one "The
room is closed." line plus the payout line on every client, none for the closes that lost the race, no second
payout stub after reloading a closed room; a non-host `RevertTo` past somebody else's move refused with the
button's sentence while the host's deeper undo lands; and the Batch-0 retest of #1237 / #1238 (U-1).

**S10-11. Retire the Firestore room path and its dead weight** (DECISIONS B4, TRIAGE_2026-09-06 §3.4 — migrated):
`sandboxRoom.ts` index allocation, the Firestore append / subscribe / room-doc code and Firestore-only effects
in `App.tsx`; chat stays on Firestore (#644) for now but must not be a money game's dispute evidence. Also
retire `frontend/sandbox-log-*.json` / `dump-sandbox-log.mjs` if the CLI export (#1334) has replaced them.
`DEFERRED` (after the next playtest confirms the server path).

**S10-12. Owner-authored release items** (DECISIONS C2–C4, AUDIT_SETTLEMENT §10): a Terms page (bonded challenge,
forfeit, operator-resolved dispute) readable in the lobby before the deposit; a rules line on one person in two
seats; the 2-player vote edge cases stated; who pays gas for what and the feegrant sizing re-derived (~5 player
txs per game, not 400). `DEFERRED` (owner).

**S10-13. Stale design comments found by the Stage 5.5 marker sweep — resolved in code, not yet in prose** (fix
in a comment-only commit; no behaviour): `gameEngine/replayLog.ts` header says "six `isSandboxOnlyMsg` messages
are still shell-owned (#1189)" — all ten came off the shell (#1230–#1248); `RoomEngine`'s class note says the
settle-point logic (`autoSkipReason`, the forced withhold) "is still in the shell" — it lives in
`gameEngine/derivedActions.ts` and `RoomSession.settleOwed` runs it (#1202/#1203/#1275). `OPEN` (docs).

**S10-14. Duplicated constants / logic to consolidate, flagged not refactored** (audit risk 5): share percentages
(`sandboxSession` / `endgame` / `sharePurchase` / `doubleCertificate`), `isExemptZone` vs
`isCertificateExemptZone`, `capWaived` vs `exceeds60Allowed`, `PLAYER_HOLDING_CAP_PERCENT` in
`privateExchange.ts`, train limits (`TIER_PRESENTATION` vs `limitForTier`), token costs, private face values
(catalog vs fixture vs `waterfall.privates.face_value` — the auction marks down the fixture copy), the OR
sub-phase label table hand-copied in `RulesReference.tsx`, and the "reservation" misnomer across seven exported
symbols (`privateReservations.ts`, recorded as known debt). `DEFERRED`.

**S10-15. Brittle string-pinning tests** (`variantCopy`, `privateCardText`, `dividendNarration`, the `batchNN`
family) will not catch a rule regression whose text is unchanged. `DEFERRED` — note, no action.

**S10-16. Host housekeeping the VM cannot do:** `_to_delete/` holds scratch probes and stale `index.lock`
files; `.git/worktrees/prefix` is a stale scratch worktree (`git worktree prune` on the host);
`frontend/testrun.txt` is a stale UTF-16 test-run capture (253 / 4030) proposed for deletion. `OPEN` (owner).

**S10-17. Message-carried facts the reducer could derive** (audit risk 4): `DeclareDividends.revenue_amount`
(S6-2 — validated against the authority since Batch 6), `LayTile.bonus_lay` (S6-6), `BuyStock.par_value`
(S8-9), ~~`PlaceHomeStation` hex (S8-6)~~ *(closed by Slice 8.2: hex and circle judged by `homePlacementRefusal`)*, `RunMultipleRoutes` paths (S6-1 — judged since Batch 6; `trains` is
checked against the fleet slot, `revenue_seed` / `revenue_turn` remain message-carried by design, #1051 /
#1183). Cross-reference only.

**S10-18. Test gaps from the audit still without a machine-level test:** ~~sold-out rise order (S8-4)~~ *(closed by
Slice 8.1, `soldOutRise.test.ts`, 2026-09-16)*, first-SR sale
refusal (S8-7), ~~presidency tie (S8-2)~~ *(closed by Slice 8.3, `presidencyAuthority.test.ts` clockwise-tie matrix
plus `presidencyCorpus.test.ts`, 2026-09-17)*, auction escrow at the reducer (S7-4), terrain-fee-once for the
upgrade-of-preprinted case, all-pass private income through `replayLog` (S10-4). Cross-reference.

**S10-19. August 2026 audits (`AUDIT_PART1_BACKEND.md`, `AUDIT_PART2_FRONTEND.md`).** Their actionable items
were either fixed then (code cites "Audit G-5/G-9/G-11/G-12/G-15", "F-3", `config.ts` env for F-4,
`SELL_PERCENTAGE_OPTIONS` to 50 % for F-6) or belong to the Rust crate that Phase 4 retires (G-1/G-2/G-3
valuation moves to the server's appraisal; G-5 on-chain tile inventory is moot). Before Phase 4, confirm which
Part-1 items concern `escrow.rs` / `contract.rs` (which stay on chain) and carry them into the 3a contract
revision. `DEFERRED` (Phase 4 pre-check).

**S10-20. O2 — an UNATTRIBUTED duplicate `BuyTrainFromCorporation` skips the consent rule and takes the seller's second train; the private purchase is idempotent, the train sale is not.**
Status `OPEN` (derived-action / ingress hardening). Found by the Opus 7.4 matrix (`offerMatrix74Settlement.test.ts`
§12 "residual #549b", pinned as a decision). The settlement predicate skips consent for a `null` actor (#549b, the
7.2 shape: rules about a player are not asked of nobody), so a second, author-less copy of a settlement applied
after the first finds no offer, skips consent, and — because the seller still owns a train of that model — sells
another one. Unreachable through the server path (every server and replay entry carries its author; a straggler
with an author is refused by consent) and through the shell; reachable only by a fixture or solo play. The R74-B
instance identity (S7-21) does not eliminate it (it is an arm-level consent gap, not a derived-key one), so it is
retained here rather than widened into 7.4. Candidate fix for this stage: refuse a `null`-actor settlement that
matches no standing accepted offer, or require an author at ingress for every settlement message (S10-1's
transport). Replay: refusal-added on hand-crafted entries only; no stored entry lacks an author.

**S10-21. A completed engine-version-5 Yellow Sign game as a committed fixture — the epilogue coverage JUNO-Z6C used to supply.**
Status `OPEN` (test substrate; filed by Batch 7.5, owner ruling 2026-09-16). `__fixtures__z6cLog.json` (JUNO-Z6C
through 494) no longer reaches a completed game under version 5: 7.3's C5 correction leaves the B&O at $220 (idx 9/12),
p-lzjh2r6u pays $10 more at 14, cannot afford his B&O share at 31 ($95 / $100), B&O floats at 33 after the stored home
placement at 32, and from 34 the authoritative home-token hold blocks every remaining entry — timeline `[SR 1, Final]`.
That is an expected historical-log incompatibility, not a bug; it is pinned in `gameHistory.test.ts` ("JUNO-Z6C under
rules engine version 5") and the stored log is not rewritten. The generic completed-game cases moved to the frozen
JUNO-CV4 golden log; the cases below could not move, because CV4 (phase 3, no Unpredictable Revenue, no rust) never
produces the event, and they were **removed rather than re-pinned to "nobody"**:
- `accolades.test.ts` "Z6C's C&O president is a Carcosan -- the Mark, never redeemed (#1421)" — Carcosan Railways
  holder and "Marked by an Outer God"; Redeemer `null`.
- `accolades.test.ts` "obsolescence is two awards in dollars: the Gravedigger sent, the Rust Belt lost (#1422)" — both
  detail formats and both values `> 0`.
- `accolades.test.ts` "the anti-awards and the corporate five come off the same replay (#1429)" — the Farmhand line
  (`by.farmhand.holder` not `null`, Unpredictable Revenue's wildlife) removed; the conditional Bagholder detail format
  and Little Engine detail format lines kept but now vacuous (CV4 awards neither; Z6C awarded both).
- `roundReplay.test.ts` / `gameHistory.test.ts` — the phase-5, multi-OR-set and more-than-ten-OR timeline (Z6C's
  OR 7.2 snapshot, `> 10` ORs) is now exercised on CV4's shorter phase-3 timeline (OR 4.1, seven ORs) only.
Detail: capture — or construct through legal play on a version-5 engine — a fully completed game with Yellow Sign
(Unpredictable Revenue) enabled that includes a Mark, rust, a Bagholder and a Little Engine, commit it beside the
golden logs, and restore the displaced assertions against it. Not captured in 7.5. Cross-reference S9-1 (the Mark's
award still mints; `moneyConservation.test.ts` now pins that on a hand-built board) and S8-5 (moving the home token
to the first OR turn would change Z6C's replay again — the characterization will announce it). **Stage-8 design pass
(`STAGE8_AUTHORITY_DESIGN_2026-09-16.md` §8):** under Slice 8.2 with the deferral adapter, the freeze lifts at 34 (B&O floated at 33 owes
nothing in a Stock Round) and the recorded 32 choice is supplied at B&O's first OR turn; how far Z6C then replays is
measured at implementation and the characterization is re-pinned there.
**Slice 8.2 (2026-09-16):** measured and re-pinned. Under the development corpus's policy Z6C no longer freezes: B&O's
choice (32, I15) lands after 40, NNH's (37), C&O's (56), NYC's (256) and PMQ's (343, circle 1) at their first turns, and
the 494 fixture replays to OR 10.1 (26 samples; the store to OR 11.2) on the Batch-7-corrected board — still not the
table's game (31 stays refused; many later entries are refused on the corrected board), so the item stands. The Yellow
Sign at 203 is reached again (C&O's Mark, +$90 — `moneyConservation`'s corpus list re-pinned to that entry, S9-1). The
epilogue's default path (no adapter) stops at B&O's first OR turn (`[SR 1, OR 1.1, Final]`), pinned beside it. A
completed Yellow Sign game is still owed.

**S10-25. `legalRotations` and the authority now ask the station rule separately, and should ask it once.**
Status `OPEN` (opened by Slice 9.2, 2026-09-18). S9-17 put revised 6.2.2 ❹ in the reducer
(`gameEngine/stationAnchorAuthority.ts`, #1623) by calling the same pure `planTokenUpgrade` the shell's
`legalRotations` memo calls (`App.tsx:10797`, design note #879) — one implementation, two call sites, which is
correct and is not a duplication of the RULE. What is owed is the small cleanup: the shell should ask the
authority's helper rather than assembling the anchors itself, so the rotation list a president is offered and the
refusal a replay applies are computed by one function end to end. **Deliberately not done in Slice 9.2**: `App.tsx`
was carrying live owner modal / UI / wallet work throughout the slice, and editing it to deduplicate a memo would
have collided with that for no rules gain. No behaviour depends on this; it is a seam, not a defect.
**Slice 10.1 (2026-09-22): `RESOLVED`** (#1682). The seam had an authority half the audit missed: the memo asked raw
`planTokenUpgrade` and the reducer also asks the per-city occupancy and #1625's total-slot floor, so a facing the ring
offered could be refused on capacity. `stationAnchorAuthority.stationAnchorPlan(state, grid, lay, actingCompanyId,
chosenCity)` returns the plan, the `token_cities` the lay would write (`tokenLandingsFor`, exactly as the dispatch
builds them) and `stationAnchorRefusal` of those landings; `stationLegalFacings` is the rotation list. `App.tsx`'s
`legalRotations`, the ring thumbnails and `derivePreviewLandings` consume those two and call `planTokenUpgrade`
nowhere (pinned by `previewTokenLanding.test.ts`). The ring is asked without a free-token choice (station grounds
only); the preview and the confirmation carry the choice. Behaviour-neutral for every legal lay; the one visible
change is that a facing the authority would refuse on the floor is no longer offered.

**S10-22. The Batch-4.6 discard adapter's "do not spin" guard cannot see a refusal on a charted board.**
Status `OPEN` (development-corpus only; found by Slice 8.2, 2026-09-16). `LegacyLogAdapters.apply` (formerly `replayLog`'s
loop, #1530) stops supplying `DiscardTrain` entries when `engine.snapshot.state === before` — but a refusal judged in the
core comes back as a fresh object on any board carrying `market_positions` (the chart step copies the state before the
core refuses), so a refused synthetic discard would not be recognised and the loop would retry while the obligation
stands. Unreached: no corpus file owes a legacy discard under version 5 (`legacyDiscards` is empty everywhere). The home
adapter reads its outcome off the corporation for exactly this reason (#1614). Repair: compare `stateDigest` or re-ask
`pendingTrainDiscards` for a change. Replay: none (development tooling).

**S10-23. A hand-exported log whose rows carry no `id` replays to its seed: every entry dies on the first `RevertTo`.**
Status `OPEN` (development corpus / export tooling only; found by Slice 8.5's corpus reconciliation, 2026-09-17;
observed but not diagnosed by Slice 8.1, whose record says only "`JUNO-Y8V` replays zero entries"). `export/JUNO-Y8V`
stores **668 rows and applies 0**. The rows carry no `id` field; `entriesFromExport` passes `id: entry.id` straight
through, so a missing id stays missing and all 668 share the identity `undefined`. `effectiveActions` resolves a
`RevertTo` **by identity** — design note #1026, which is deliberate and correct: killing by identity rather than by
position is what stops an entry being destroyed merely for sharing a number with a reverted one — so the first of the
file's **17** reverts adds `undefined` to the kill list and the closing filter drops the whole log.
**Not a Stage-8 regression**: `git log 7c5f29c..HEAD -- frontend/src/gameEngine/logRevert.ts` is empty, and the only
Stage-8 change to `replayLog.ts` is 8.2's legacy home adapter, which does not touch id plumbing. Every corpus log whose
rows ARE distinctly identified applies entries normally, which `stage85Closure.test.ts` asserts as the converse.
Repair (whoever owns the export): stamp an id at export time, or fall back to the entry index as the identity when a
log carries none. Replay: none for any log with ids; a repair would make this one file replay for the first time, so it
belongs with a bump, not between them.

**S10-26. A `LayTile` the reducer refused still landed on the tile grid — and, for the terrain fee, still spent the power and stepped the cursor.**
Status **`RESOLVED`** (Slice 10.1, 2026-09-22, uncommitted; design notes **#1681–#1683**). *(Found by the Stage-10
orientation audit, 2026-09-22, and proved on the frozen JUNO-CV4 golden: B&O's $80 river lay at index 27, replayed with
the treasury zeroed, left the treasury at $0, LANDED THE TILE ON THE GRID and moved `operating_sub_phase` Track → Tokens.)*
The two grid-step predicates (`RoomEngine.applyOnBoard`, `App.tsx`'s grid step) mirrored the four holds (#1613), the
operating identity (#1510) and the tile geometry (#757) and nothing else, while the reducer also refused on station
anchoring (#1623, in the core gate block), the JK's eligibility (#1323, a later gate) and the terrain fee (#891 —
INSIDE the arm, after `abilitySpentBy` had recorded the power and, for a JK lay, after the JK had been closed, and
before `settleOperatingCursor` stepped the turn regardless). Ingress had no `LayTile` arm at all, so a crafted lay
through the live server produced a free terrain tile visible to the route authority — a materially different legal
result. **Fix:** `gameEngine/layTileAuthority.ts` — `layTileLegalityRefusal` (identity ▸ geometry ▸ anchoring ▸ JK ▸
terrain, in the reducer's own order, every predicate the one that already judged the lay) and `layTileRefusal`
(the four holds, then that); the hold composition moved to `authoritativeHolds.ts` (#1681, re-exported from
`sandboxSession.ts`). The core asks `layTileLegalityRefusal` in its gate block ahead of the arm and the cursor; both
grids ask `layTileRefusal` on the lay's snapshot; `turnRefusal` asks `layTileLegalityRefusal` after its holds
(`RoomSession.submit` hands it the providers' geometry); the arm charges `layTerrainFee`, the gate's own figure, and
refuses nothing itself. The shell's geometry is `boardLayRefused` (exported from `replayProviders.ts`), the same
function the engine's providers hand the engine (the LayTile half of S10-4). **Replay: refusal-added, measured
corpus-neutral** — 18/18 canonical files, 334 stored `LayTile` entries, 134 applied and 200 refused on both the
baseline and this slice, zero old-vs-new decision differences, every final state digest, grid and cursor identical.
**Not this slice's:** connectivity is still not judged by the authority (S6-5) and `bonus_lay` / `csl-tile` / `dh-tile`
claims are still message-carried (S6-6 / S10-17). **Provisional Stage-10 closure bump 7 → 8 owed** (owner ruling
2026-09-22): a live-reachable change to supported authority, even though the corpus is neutral.
**10.1b (same day, #1684) — the Lay Track step.** 10.1's measurement found that `LayTile` had NO timing question: every
other operating action is asked its step, and a lay was accepted at Tokens, Routes, Dividends or Hardware whenever the
named corporation was operating, the geometry fit and the fee was affordable — the shell never offers one, so only a
crafted message met it. Inventory (all timings pinned by `stage101bLayTileTiming.test.ts`): the ordinary lay, the
C&SL's `bonus_lay` (does not consume; Track stays), the D&H's `dh-tile` (consumes) and the JK's `jk-tile` (consumes)
are ALL made at Lay Track; a power key says which lay, never when; no other message or variant emits `LayTile`.
`layTimingRefusal` is the composition's second question (after identity) and refuses a lay off `Track` (`BuyPrivate`,
the pre-#1440 cursor, is accepted as Track) — **on a pinned board only.** Why: 68 stored lays across the canonical
corpus (JUNO-CV4 ×3 copies: 106, 113, 125, 131, 137, 151, 163, 169; JUNO-Z6C ×2: 109 … 287, 22 each; JUNO-FCJ / its
prefix: 94, 172) were APPLIED while the replayed cursor read Tokens (FCJ: Hardware). CV4 106 is the shape of all of
them: the turn's first press is a manual `AdvanceOperatingSubPhase` and the lay follows — a legal lay made when a
Phase-3 turn opened on `BuyPrivate`, which #1440 (2026-09-14) now replays as Track → Tokens. A representation the
current engine puts on a legal history, not an illegality in it; an unconditional gate would change what six
canonical files replay to (measured: final state, grid and cursor all differ). So, as #1551 does for `RunManualRoute`
and `routeSkipRefusal` for the skip, a legacy board keeps the arm it was played on and every pinned board — every room
dealt since #1520 — is judged. **Corpus-neutral by construction and re-measured: 18/18, 334 lays, 134 applied / 200
refused on both sides, 0 decision differences, every final digest, grid and cursor identical.** Live-ingress and
`RoomSession.submit` cases pinned. The observation above is resolved.

**S10-24. The excess-train discard hold is the only one of the four that does not admit `RevertTo`.**
Status `OPEN` (unreachable today; found by Slice 8.5's §12 hold matrix, 2026-09-17). Three of the four authoritative
holds let an undo through — the funding hold via `resolvesEmergencyFunding`, the offer hold via `ALWAYS_PASSES`, the
home hold via `passesHomeStationHold` — and `pendingDiscardBlock` (#1530, which predates the other three) admits only
`DiscardTrain` and `CloseRoom`. Read literally that says a board carrying an excess train cannot be undone out of.
**Unreachable on the replay path**: `effectiveActions` removes every `RevertTo` from the log before any entry is
applied (`replayLog.ts`, `const live = effectiveActions(ordered)`), so the reducer is never asked to judge one and the
cell decides nothing. Filed because the asymmetry is real in the source and a future caller that asked the hold about a
`RevertTo` directly would get the odd answer. Repair: add `RevertTo` to #1530's escape list. Replay: none (the message
never reaches the predicate).

---

## Part C — Accumulated playtest UX backlog (shell only; no reducer change; no replay effect; not a numbered stage)

Sources: `UI_ACTION_PLAN_2026-09-07.md`, `TRIAGE_2026-09-05/06/08.md`, `TRIAGE_2026-09-08_JUNO-G6J.md`,
`HANDOFF_2026-09-05.md`, `TECH_DEBT.md`, the "minimal UI" clauses of Batches 4.6 and 5, and the Stage 5.5
code-marker sweep. Everything on the 7–8 September lists that is not below was done (design notes #1257–#1273,
#1274–#1299, #1331–#1347).

**U-1.** Batch 0 retest of #1237 / #1238 on a freshly rebuilt server (live-vs-history frame read; the
train-purchase toast) — owed by the owner since 7 September. `OPEN`.
**U-2.** Item 18 (2026-09-08) turn-gate observation: C&O's bar stayed on Lay Track after a derived advance
(130–132 in JUNO-CV4); reproduce with the console on `turn-gate` and the frame kind logged. `OPEN`.
**U-3.** Stock Round UX (named in Batch 4.6's scope notes as deferred): the Sell-Buy-Sell turn's controls
(#1443 / #1447), Auto-Pass / Auto-Buy graduation (#1333 / #1335 done; source, cap and presidency guard exist —
verify against the forced-sale hold), the first-SR ban surfaced only in the Rules Reference. `DEFERRED`.
**U-4.** Emergency-funding UI (Batch 5 §11 shipped minimal): the modal lists legal bundles with the reducer's
restriction sentences, a private-offer section and the Declare button; no styling / animation; the money
machines do not narrate a forced sale or the president's contribution as such; the Game Over modal reads
`bankrupt_president` from state. Polish pass owed. `DEFERRED`.
**U-5.** Discard UI (Batch 4.6 §6 shipped minimal): `TrainDiscardPrompt` in the trade-prompt slot; no modal;
the deferred "train limit" notice (#896) no longer fires for discards (the president's own action is narrated);
rust notices unchanged. `DEFERRED` — fold into U-6.
**U-6.** Pending-offer UX: one consistent "the table is waiting on X" surface for trade offers, funding offers,
discards and consent answers (`TrainPurchasePanel.tsx` prompt slot, `PrivateTradePanel.tsx`); the off-turn
dispatch rule (#701) for every answer; a visible withdrawal for every proposer; refusal reasons from
`refusedAction.ts` surfaced in place (the shell's REFUSED receipt is dead in room play — S10-1). `DEFERRED`.
**U-7.** `TECH_DEBT.md` residue: TD-8 disabled family at 3.25:1 (deliberate); turn-order neutral ink 2.58:1
(deliberate, #1092); Brick seat colour 12.9 dE from CPR (exempted by name in `seatColor.test.ts`); the
player-card wash (#1347) not yet reaching the cash slide-out and the payout modal — owner to say. `DEFERRED`.
**U-8.** Seven-seat LPF wraps the six-colour palette (#1344 added Raspberry; contrast/livery separation of a
widened palette is a `seatColor.test.ts` question). `DEFERRED`.
**U-9.** #1292 mirror instrumentation: item 25 (two tabs, different subpanel prices) not reproduced; a console
`[mirror]` line names any corporation whose subpanel price disagrees with state — send it with the next report.
`OPEN` (awaiting a report).
**U-10.** Clock / Live-vs-Async UX (DECISIONS B1/B2): the offer answerer on the clock, auto-decline, pause cap —
the UI half of S10-10's 2.5g. `DEFERRED`.
**U-11.** Rules Reference (`RulesReference.tsx`, `rulesOverview.test.tsx`) is the owner's own in-progress work;
the sub-phase label table there is hand-copied (S10-14). Not a Claude batch item; listed for the copy.
**U-12.** (migrated, TRIAGE_2026-09-06 §2.1) A purchase made at Buy Trains was once stamped `[OR 1.1—Lay Track]`
in the Activity Log; #1178 made the round stamp read the synchronous ref, but the observation post-dates it.
Watch for a wrong step in a single purchase's round tag in the next playtest (`orSubPhase`, #958). `OPEN`
(unverified).
**U-13.** (migrated, TRIAGE_2026-09-06 §2.2) "A laid tile appears, then vanishes; the action bar stays on Lay
Track" — plausibly the unseated-auction divergence (#1227) or the render-free-rebuild legality read (#1279),
both since fixed; never re-tested on the corrected server. Re-test; if it recurs the alarm names the field and
the server window names the refusal. `OPEN` (retest).
**U-14.** (migrated, HANDOFF_2026-09-05 §5c, `logExport.ts` #1160) Unreproduced report: "PRR ran for $30
($3/share); Undo from Buy Trains returned to Dividends showing 'Pay Dividends ($1/share)'." Five mechanisms ruled
out by running the reducer; the log exporter was built for it and has never been pointed at a failing room.
`OPEN` (awaiting a log).
**U-15.** (migrated, HANDOFF §5c) Owner-deferred cosmetics: a Keplr logo SVG in the wallet connect surface (no
asset in the tree as of 2026-09-15). The "Join Game modal listing active games" half is done (`JoinGameCard.tsx`).
`DEFERRED` (owner).
**U-16.** (sweep) `panels/ContextualActionBar.tsx` `useStickyFitProbe` (#813) is a self-described *temporary
instrument* — a fit readout rendered outside the action bar to decide whether the step panels can move back
into it. Decide, then remove it either way. `OPEN`.
**U-17.** (sweep) `gameEngine/cityBypass.ts` #808 known debt: no control lets a corporation that *could* enter a
one-slot city choose to bypass it (the PRR skipping its own home to save a stop) — new UI on one waypoint. The
reducer half is done (Batch 6: a `bypass: true` waypoint is honoured wherever the rails offer a bow, shut city or
not); only the control is missing. `DEFERRED`.
**U-18.** (sweep) The "reservation" vocabulary (`privateReservations.ts`, seven exported symbols across four
files) is a recorded misnomer; rename mechanically when nothing else is in flight. `DEFERRED` (naming only).

**UI-parity entries from the Batch 7 design pass (2026-09-15; design §12b; owner's standing requirement).** Each is
`OPEN` until fixed, verified obsolete or adjudicated — the Playtest Readiness gate (Part F) holds them.

**U-19.** (S7-9 / D-24) **Player ↔ player private-company sale — NEW ACTION + STATE VISIBILITY + RULES REFERENCE.**
No UI exists: initiation by either party on an eligible Stock Round turn (not SR1), counterparty and price entry,
the counterparty's accept/reject prompt (off-turn, the `FundingPrivateOfferPrompt` shape), the proposer's rescind,
the pending-offer line and hold on every seat, and a Rules Reference sentence for §3.1's player-to-player rule.
**Batch 7.4 outcome (classification unchanged: NEW ACTION + STATE VISIBILITY + RULES REFERENCE):** the engine half
exists — `ProposePrivateTrade` / `AnswerPrivateTrade` / `RescindPrivateTrade`, `private_trade_offer`,
`privateTradeRefusal` (SR ≠ 1, the seat is a party, distinct seated players, the seller's open private, integer price
≥ $0, buyer cash, the certificate limit) answered at ingress with its sentence and by identity in the core. The
frontend has no initiation, prompt, price entry, answer, rescind or pending line for it; the panel that is built must
read `privateTradeRefusal` and the `standingOrdinaryOffer` hold, and the counterparty's prompt must go to
`tradeCounterparty(offer)` (the party who did not propose). Rules Reference: §3.1's sentence and D-26/D-27 (what
travels with the card; the trade counts as the seat's Stock Round activity without consuming the stock purchase).
`OPEN` (UI only).

**U-20.** (S7-6 / S7-7 / S7-12 / D-18) **Ordinary player → corporation private purchase — LEGALITY SYNC + NEW ACTION +
STATE VISIBILITY.** Verified: the `ProposePrivatePurchase` panel opens for the acting president in phases 3–4 at any
Operating step (not step-gated — correct under D-18), with a typed price inside the ½–2× band and the owner's
accept/reject prompt; the same-president case settles at once. Not read from the authority: treasury ≥ price,
`closed`, player-owned seller (a corporation-owned private is offered today), buyer = operating corporation — the
panel must read `privatePurchaseRefusal`. No withdraw control for the proposer (`RescindPrivatePurchase`, Batch
7.4's new message; U-6 already asks for a visible withdrawal); the proposer's "awaiting" line and the hold need a
surface. **Batch 7.1 outcome (LEGALITY SYNC, unchanged in scope):** the reducer now REFUSES a purchase whose
treasury cannot cover the price, whose private has no player seller (corporation-owned or unowned), or whose
price is negative or fractional — silently, by identity (S10-1), so the panel still offers all four. The
predicate the panel must read is still Batch 7.4's `privatePurchaseRefusal`; 7.1 only means the illegal
version now does nothing instead of moving money. **Batch 7.4 outcome (LEGALITY SYNC + NEW ACTION + STATE
VISIBILITY, unchanged in scope):** `privatePurchaseRefusal` (#1591) now exists and is answered at ingress, so every
purchase the panel offers that the authority refuses (treasury, `closed`, a corporation-owned seller, a buyer that is
not operating, phase, band, consent) is refused with a sentence rather than silently; the panel still computes its
own availability. `RescindPrivatePurchase` exists with no control (NEW ACTION). The offer now records the board's
owner, so the prompt can keep reading `private_purchase_offer.owner` — but the answer control should be shown to the
private's CURRENT owner (`currentPrivateOwner`), because that is who the engine lets answer. The hold (U-22) applies.
`OPEN` (UI only).

**U-21.** (S7-5 / S7-8 / S7-12 / D-18 / D-20 / D-23) **Intercorporate train sale — LEGALITY SYNC + NEW ACTION +
STATE VISIBILITY.** Verified: the proposal panel renders at `Hardware` only (timing already right); price ≥ $1,
treasury and the same-president shortcut are not read from `trainSaleRefusal`; the answer prompt exists. The
on-chain `TrainTradePanel`'s "Rescind" dispatches `RescindTrainOffer { offer_id }` — a sandbox no-op that D-23 now
refuses on pinned boards — so the sandbox needs its withdraw wired to `RescindTrainPurchase` and the chain-era
Accept/Reject/Rescind controls retired from room play (S10-8 keeps the types). **Batch 7.1 outcome (LEGALITY
SYNC, unchanged in scope):** `settleTrainSale` moves the money before the train, so a purchase the buyer's
treasury cannot cover is now refused outright rather than delivered with a floored payment; the panel still
offers it, because the price and treasury predicate is 7.4's. **Batch 7.4 outcome (LEGALITY SYNC + NEW ACTION +
STATE VISIBILITY, unchanged in scope):** `trainSaleRefusal` (#1592) exists and is answered at ingress; the panel
should read it for price (≥ $1), treasury-only affordability (D-20), the seller's fleet, the limit and the same-president
shortcut. `RescindTrainPurchase { seller_protocol_id }` exists (#1594) and the sandbox's withdraw must dispatch it;
`RescindTrainOffer` / `AcceptTrainOffer` / `RejectTrainOffer` are now REFUSED on pinned boards (D-23), so the
`TrainTradePanel` chain-era controls must be retired from room play. The answer prompt must go to the seller's
CURRENT president (`sellerPresident`), not `train_purchase_offer.seller_president` (narration). `OPEN` (UI only).

**U-22.** (S7-8 / S7-14 / D-19) **Pending-offer global hold — STATE VISIBILITY.** While an ordinary offer of any
kind waits, End Turn / Pass / Skip / every purchase control must be disabled on every seat with the hold's sentence
("X is on offer to Y; nothing else can happen until …"), the way the Batch-5 funding freeze is surfaced; the
ingress `refused` sentence must reach the banner for every Stage-7 refusal (S10-1). Folds U-6's "the table is
waiting on X" surface. **Batch 7.4 outcome (STATE VISIBILITY, unchanged in scope):** the hold exists —
`pendingOfferBlock(state, msg)` (#1590) refuses everything but the answer, the rescission, the derived settlement,
`RevertTo` and `CloseRoom` while an ordinary offer of any of the three kinds stands (unanswered, or accepted and
awaiting settlement), and `standingOrdinaryOffer(state)` / `describeStandingOffer` give the surface its one sentence.
Today every held control is refused at ingress with that sentence rather than disabled; the shell must disable
progression controls on every seat from `standingOrdinaryOffer` and render the proposer's "awaiting" line, the
accepted-awaiting-settlement state (momentary on the server path) and the rescind control. `OPEN` (UI only).

**U-23.** (S8-7) **First-Stock-Round sale ban — LEGALITY SYNC + RULES REFERENCE.** Sell is disabled in SR1 by the
panel's own `macroRoundNumber === 1` (#356) — a local restatement that must become a read of `stockSaleRefusal`
(one predicate for the SR1, unparred and bundle rules) — and the tooltip reads "No selling in the first Stock Round
— Project 18XX opens the market to sales from SR2 onward", presenting rulebook §5.1 as a house variant; correct
the copy and the Rules Reference's Stock Round text; verify the Delayed-Auction SR1 shows the same.
**Batch 7.2 outcome (LEGALITY SYNC, narrowed):** the authority now exists and is answered at ingress —
`stockSaleRefusal` refuses an SR1 sale with "Certificates may not be sold in the first Stock Round." and
`isFirstStockRound` is verified to read the Delayed-Auction SR1 as the first Stock Round and its post-auction SR3
as an ordinary one (`stockTransactionAuthority.test.ts`). The ENGINE half of this item is closed and a crafted or
racing client is refused with a sentence; what remains is the panel's own `macroRoundNumber === 1` restatement
becoming a read of `stockSaleRefusal`, and the tooltip/Rules Reference copy correction (§5.1 is a rulebook rule,
not a Project 18XX house variant). `OPEN` (UI only).

**U-24.** (S8-8) **Unparred-share sale ban — LEGALITY SYNC.** The Sell control is live for the holder of a C&A/M&H
granted share before the corporation is parred (no price to quote, the button still dispatches); it must read
`stockSaleRefusal` and disable with the reason.
**Batch 7.2 outcome (LEGALITY SYNC, narrowed):** the predicate exists and refuses — at the reducer by identity and
at ingress with "NYC has not been started yet — a share of it cannot be sold until its President's Certificate has
been bought and its par set." A player who presses the live control now meets a refusal sentence in the room
banner instead of a silent no-op, so the failure mode is legible; the control is still offered, which is the
remaining work. `OPEN` (UI only).

**U-25.** (S8-9 / S7-1 / S7-13 / S7-16 / S7-18 / D-17 / D-22 / D-25) **Par ladder, president's cost, affordability,
empty source, Brown-zone same-corporation continuation, bundle sizes — LEGALITY SYNC.** `PAR_BOX_PRICES`, the
panel's own `cannotAfford` (#357), the source toggle and `multiBuyMax` (computed from the panel's own reading of the
pool percentages — whether a 0 % source still offers Buy is decided locally) and `SELL_PERCENTAGE_OPTIONS` are local
restatements of rules the reducer now owns; the quantity/continuation control knows nothing of
`bought_this_turn_company` (today no continuation message is dispatched under Sell-Buy-Sell, but any future
continuation control or a legacy-revision game would offer the wrong corporation). `purchaseBlockFor` /
`saleBlockFor` become thin wrappers over `stockPurchaseRefusal` / `stockSaleRefusal`; the ladder control reads
`parCellFor` (verify the dynamic-market par row); an undeliverable purchase is never offered.
**Batch 7.1 outcome (LEGALITY SYNC, unchanged in scope):** an unaffordable `BuyStock` is now refused by the
ledger boundary instead of minting the difference (26 corpus entries, S7-1). The panel's own `cannotAfford`
(#357) already stops the ordinary player from reaching it, so no control changes today; what is left is the
sync — `purchaseBlockFor` reading `stockPurchaseRefusal` — and it stays 7.2's.
**Batch 7.2 outcome (LEGALITY SYNC; the predicates now exist, the panel work is still open):**
`stockPurchaseRefusal` / `stockSaleRefusal` / `parLadderRefusal` are exported from
`gameEngine/stockTransactionAuthority.ts` and answered at ingress, so every item on this list now HAS one
authority to read: the par ladder (`parLadderRefusal` → `parBoxCellFor`, the same table `PAR_BOX_PRICES` is
derived from — which answers the dynamic-market question by construction: the Dynamic Market adds a price ROW and
no par boxes), affordability (`cash >= charged`, at the exact charge), source availability
(`ordinaryPercentAvailable`, which refuses an undeliverable purchase OUTRIGHT rather than capping it — and which
reserves the President's 20 % card in an unparred IPO), the Brown continuation (`bought_this_turn_company`, named
in the refusal) and the bundle sizes (`percentage % 10`). **No frontend file was changed by Batch 7.2.** The
concrete substitutions that remain: `App.purchaseBlockFor` (8577) and `App.saleBlockFor` (8612) become thin
wrappers over the two predicates; `StockRoundPanel`'s `PAR_VALUE_LADDER` / `cannotAfford` (#357) / `multiBuyMax` /
source toggle stop computing what the reducer now owns; and a 0 % source must stop offering Buy. `OPEN` (UI only).

**U-26.** (S7-2 / S7-3 / S7-4 / S7-15 / D-16 / D-21) **Auction — LEGALITY SYNC + STATE VISIBILITY + RULES
REFERENCE.** Verified NONE: escrow-aware affordability and minimum raise (`auctionFunds` / `bidRejectionReason` /
`minimumBidFor` — the helpers the reducer will share) and Buy-only on the lowest card. To sync: the mini-auction
button is "Drop-out" and the passer vanishes from the contest — under S7-3 the passer stays, is re-prompted on his
turn, and the passes-since-raise count decides the end; "One bid per private company" refuses the own-bid raise the
owner ruled legal (D-16). To show: the all-pass narration marks down only the SV and pays revenue only when the SV
is sold (D-21). Rules Reference auction text (owner's WIP, U-11): SV-only markdown, re-entry, escrow, no bid on the
lowest.
**Batch 7.3 outcome (LEGALITY SYNC + STATE VISIBILITY; the predicates now exist, the dashboard work is open).**
Every rule on this list is an authority now — `gameEngine/auctionAuthority.ts` — answered at ingress with its
sentence, and the items below are what the dashboard still states for itself:
  * **NONE, confirmed and now genuinely shared.** Escrow-aware affordability and the minimum bid are the SAME
    functions the dashboard calls (`auctionFunds` / `bidRejectionReason` / `minimumBidFor`, `auctionEscrow.ts`),
    so the button's arithmetic and the board's are one implementation rather than two — #1184's shape, closed by
    construction rather than by care.
  * **LEGALITY SYNC — the own-standing-bid raise, on the MAIN bid control.** `WaterfallAuctionDashboard` 480
    calls `bidRejectionReason(funds, bidAmount, minimumBid)` with **no `raisingFrom`**, and a `repeatBidReason`
    ("One bid per private company") refuses the own-bid raise outright — while the contest's raise control at
    481 does pass `ownRaiseEscrow`. The engine allows the own-bid raise everywhere (D-16/Q3) and charges only
    the increment, so the main control is stricter than the rule in two separate ways.
  * **LEGALITY SYNC — the mini-auction pass.** The button is "Drop-out" and the passer vanishes from the contest
    card; under the repaired rule he stays, keeps his bid, is re-prompted on his next turn, and the contest ends
    on `passes_since_raise`. The label, the semantics and the card's bidder list all follow.
  * **STATE VISIBILITY — `passes_since_raise`.** Nothing renders how close a contest is to resolving.
  * **STATE VISIBILITY — the contest freeze.** Buy / Bid / Pass must be disabled on every seat while a contest
    is live, with the hold's sentence; the engine refuses them now, so today the failure mode is a control that
    answers with a refusal rather than one that is greyed.
  * **NONE for the lowest card** (it offers Buy only — verified) and **RULES REFERENCE** for the auction text:
    SV-only markdown, income only once the SV has sold, re-entry after a pass, escrow, no bid on the cheapest.
  * **NONE — the all-pass narration, corrected in 7.3 rather than deferred.** `utils/auctionTransition.ts`
    derives the shell's auction sentences from the two boards (#1340a) and was computing
    `applyPrivateRevenue(after)` on every all-pass — a faithful reading only while the reducer paid on every
    all-pass. It now reads whether a payout OCCURRED from the before/after bank, so a markdown-only all-pass
    no longer narrates a payout that never happened. **It decides nothing:** §1.2.3's condition stays the
    reducer's, and this module is presentation synchronised with the authoritative board. No UI work remains
    and no separate Part C item is owed for it.
`OPEN` (UI only).

**U-27.** (S7-10 / S7-20 / D-15) **Bank crediting, signed bank, bank-break latch — badge NONE (confirmed); narrow
STATE VISIBILITY + RULES REFERENCE.** Verified: `App.tsx` 12548 renders the "bank broken" badge from the shared
`bankIsBroken(gameState)` imported from `gameEngine/endgame` — the same function `settleRoundTransitions` asks —
so once that function reads the latch the badge is correct with no UI change and no duplicate logic (7.1's
regression (d) pins the shared call). **Batch 7.1 outcome: the badge is confirmed NONE and needs no
implementation** — `bankBreakLatch.test.ts` "the badge and the ending read the same predicate (U-27)" asserts
both halves (the source reads `bankIsBroken(gameState)` from `gameEngine/endgame` and names no second notion of
"broken"; and the one board where a duplicate rule would disagree — a latched bank with a solvent balance —
answers the badge and the reducer identically). Remaining, narrow, and now with the exact call sites verified
against the signed bank: `utils/bankBreak.ts` `bankBreakWarning` clamps with `Math.max(0, ...)`, so a bank at
-$20 renders "Bank Break: $0 remaining" and keeps the countdown's amber/crimson wording rather than saying the
bank has broken; `components/FinancialLedger.tsx` 184 prints `$-20` and its "Paid Out So Far" percentage (160)
exceeds 100%. Render "Bank broken — owes $N" in both, and check the Rules Reference's bank-break timing text.
`OPEN` (narrow).

**U-28.** (Playtest Readiness task; owner, 2026-09-15) **Retrospective Batch 1–6 UI-parity audit.** Not performed in
the Batch 7 design session. Inspect the completed Batch 1 … 6 reports (`BATCH1_…` through `BATCH6_…`) and the
current frontend, classify every authoritative rule they introduced or changed under the UI-parity standing rule,
and add every missed Part C item — including board legality such as the private-company hex blocking (S6-7), the
Batch-3 station gate, the Batch-4/4.6 train-limit and discard flows, the Batch-5 emergency surfaces (U-4) and the
Batch-6 route refusals (S6-13's duplicated validators). `OPEN` (gate item).

**U-29.** (S7-1 / S7-10 / S7-12 / D-15; filed by Batch 7.1) **A ledger refusal is invisible — STATE
VISIBILITY.** Batch 7.1 turned four silent money faults into silent refusals: an unaffordable stock purchase,
an unaffordable corporate private purchase or intercorporate train purchase, a private with no player seller,
and a malformed (negative or fractional) price now leave the board untouched instead of minting or destroying
money. All four refuse INSIDE the reducer, by identity, with no ingress counterpart — 7.1 adds no rule
predicate, so there is no sentence for the room banner to show (S10-1), and the reducer's no-op is
indistinguishable on screen from a dropped message. The ordinary player rarely meets one (the Stock Round
panel's own `cannotAfford` (#357) and the private trade panel's band already stop the common cases before
dispatch), but a racing or reloading client can, and the failure mode is a control that appears to do nothing.
Closed for ordinary play when Batch 7.2's `stockPurchaseRefusal` and Batch 7.4's `privatePurchaseRefusal` /
`trainSaleRefusal` answer at ingress with their sentences (U-20, U-21, U-22, U-25); until then the gap is
recorded here rather than left to be rediscovered as "the Buy button did nothing".
**Batch 7.2 outcome: the STOCK half is closed for live play.** `turnRefusal` now answers `BuyStock`, `SellStock`
and `SetBoPar` with the same predicates the reducer refuses by, inside a `withRules` scope so the two locks read
one chart, so every stock refusal a live client can provoke reaches the room banner with a sentence. What the
ingress layer still cannot reach is a refusal met during REPLAY of a stored entry — that is U-30. The private
and train halves stay 7.4's. `OPEN` (narrowed to 7.4 + U-30).

**U-30.** (S7-13 / S7-16 / S7-18 / S8-7 / S8-8 / S8-9; filed by Batch 7.2) **The Activity Log cannot say WHY a
stock transaction was refused — LEGALITY SYNC.** `utils/refusedAction.ts` (#778) is the one place that turns "the
reducer returned the board unchanged" into a sentence for the log, and for stock it asks `sharePurchaseBlock`
(209) and `shareSaleBlock` (223) — the two predicates Batch 7.2 now COMPOSES, rather than the composing ones. So a
purchase refused for the round, the par ladder, the price, the source, affordability or the Brown continuation,
and a sale refused for the round, SR1, an unparred corporation or a fractional bundle, is still correctly reported
as refused (the identity test is unchanged) but with **no reason** — the specific failure #778 exists to prevent.
The fix is two substitutions —
`stockPurchaseRefusal({ state: before, buy: purchaseIntentOf(msg.BuyStock), actor, ctx: chartContextFromState(before) })`
and the sale's equivalent — deliberately not made in Batch 7.2, whose brief excludes frontend work. Scope note:
this is about REPLAYED entries and legacy logs; a live refusal reaches the room banner from ingress, which 7.2
does supply. `OPEN`.

**U-31.** (S7-13 / D-17; filed by Batch 7.2) **`SandboxActionContext.parValue` is inert and still supplied — NONE
(tech debt, recorded so it is not mistaken for a rule).** Batch 7.2 removed the last reader of `ctx.parValue`
(#351/#579): the founding purchase is priced from the message's own validated par. Three callers still fill the
field — `App.tsx` 6357 and 8839, `replayLog` 447 — and #777's warning applies to it in full: "an option the
authority can never receive is worse than no option: it reads at the call site as a rule that is being enforced."
The field is annotated in place rather than removed, because deleting it is a signature change across three
callers for no rules reason. Retire it with S10-8's type cleanup. `OPEN` (no user-visible effect).

**U-32.** (S8-5 / S8-6 / S8-12 / S8-13; filed by the Stage-8 design pass, 2026-09-16 — engine side landed in Slice 8.2,
2026-09-16) **Home station at the start of the corporation's first OR turn — STATE VISIBILITY + LEGALITY SYNC + RULES
REFERENCE.** **At float, remove the current Place Home Station modal from that timing. The Corporation Floated visual
flourish owns the float presentation. The home-station interaction/modal occurs instead at the start of that
corporation's first Operating Round turn, before normal corporation actions. Visual redesign remains deferred to the UI
backlog.** *(Owner wording, Slice 8.2. Engine side done: `pendingHomeTokens(state, table, mapGrid)` now lists only the
operating corporation's owed home with its legal choices, and `App.tsx`'s memo passes the grid, so the existing modal
already stops appearing at the float and appears at the first turn — closed-out Cleveland is not offered, N&W offers
Norfolk only. What remains below is the UI pass.)* ~~The home-station prompt (`HomeStationPrompt`, raised from
`pendingHomeTokens` in `App.tsx`) moves from the Stock Round purchase that floated the corporation to the opening of that
corporation's first Operating turn; the Stock Round no longer waits on it and no other seat is held.~~ While the operating president owes the token, every control
of that seat except the placement is disabled with the hold's sentence (the same surface as the discard / funding /
offer holds, U-5 / U-4 / U-22) and the Activity Log names whose home is owed; the lit hexes / circles come from
`homePlacementRefusal` (Erie: either free circle of E11; PMQ: either free circle of E5; LPF C&O: ~~either home hex~~
Cleveland and / or Richmond as each is currently legal — Richmond reserved, Cleveland blockable; no tile needed on E11 /
E19 / E5). The Rules Reference's home-station paragraph must say "at the start of its first operating turn" and drop
any "when it floats" wording. See U-37 for the float's Activity Log line. `OPEN` (UI verification and polish; engine side
done in Slice 8.2).

**U-33.** (S8-2; filed by the Stage-8 design pass — **engine side landed in Slice 8.3, 2026-09-17; the UI half is
unbuilt and unchanged by it**) **Presidency clockwise tie-break — STATE
VISIBILITY + RULES REFERENCE.** When two or more challengers tie above the outgoing president, the presidency-change
line says who took it and why ("closest clockwise from the former president", U-30's WHY family); the Rules
Reference §5.4 paragraph states the tie rule. The printed reason to state is "closest clockwise from the FORMER
president" — the displaced incumbent's seat is the origin even once their percentage has fallen below 20 % (#1620).
`OPEN` (UI; Slice 8.3 built none of it, by its brief's §15).

**U-34.** (S8-1 / S8-3 / S8-4; filed by the Stage-8 design pass — engine side landed in Slice 8.1, 2026-09-16) **Dynamic operating order —
STATE VISIBILITY.** The turn-order strip, the "next corporation" read (`App.tsx` 1300) and the market-token operated
/ active stacks (#1296) re-render from the settled queue after every action: the operated prefix never moves, the
not-yet-operated tail may. No new control; verify no shell code caches the opening order (the re-entrancy key
`utils/turnGuard` reads the state's index and is unaffected). **Slice 8.1 check (engine side):** the Operating Round
Corporations table (`utils/operatingOrderView.ts` `operatingOrderRanks`, `ContextualSubPanel`) and the other readers take
the order from `active_operating_order`, so they follow the settle with no second rule; #753's note there ("that queue
is frozen for the whole round") is now true of the operated / operating prefix only and wants its wording refreshed with
the UI pass. See also U-36 (the rise's Activity Log line). `OPEN` (UI verification).

**U-35.** (S8-10; filed by the Stage-8 design pass — pending Slice 8.4) **M&H exchange window and source — LEGALITY
SYNC + RULES REFERENCE / GOTCHA + STATE VISIBILITY (+ NEW ACTION under ruling R2).** The powers panel / flow modal must ask the reducer's
`privateExchangeRefusal` (not the client-side `resolvePrivateExchange` alone) so an exchange refused at the lock —
outside the window, under a hold, over the certificate limit, no share in the named pile — is never presented as
live; under R2 the modal offers Bank Pool as an alternative source when both piles hold a share; the Rules
Reference's M&H card states the window ("your own Stock Round turn, or between turns in either round") and the
no-sale-before-par rule already enforced by U-24. **Owner rulings R1 / R2 (2026-09-16):** the NEW ACTION is required —
the owner picks the source when both the IPO and the Bank Pool hold a legal share (only the legal source is offered
otherwise; no silent IPO-first); and **STATE VISIBILITY for a queued exchange** — a request made while another turn is
underway queues until the next legal boundary, so it needs an immediate requester-facing acknowledgment and a
table-visible pending indication that persists until execution or cancellation (exact presentation TBD here; the
Activity Log alone is not sufficient). No transition-time prompt is ever raised. **RULES REFERENCE — GOTCHA (owner,
2026-09-16; documentation only, not implemented).** A queued M&H exchange is only a request to exercise the power at
the next legal between-turn opening. Queuing it does NOT vest, reserve, or lock in the exchange: at settlement the
entire exchange is revalidated against the then-current authoritative state. The future Rules Reference "Gotchas" must
call out this edge case explicitly: the player queues M&H during another corporation's Operating Round; before that
corporation's turn ends, it purchases the first 5-train; Phase 5 begins immediately and all private companies,
including M&H, close immediately; at the next between-turn boundary the queued M&H request is no longer legal and
expires without effect; the player does NOT receive the NYC share merely because the request was submitted before the
5-train purchase. The same general rule applies if the requested NYC share or another legality condition ceases to be
available before settlement. Suggested player-facing wording: "Gotcha — Queuing M&H doesn't reserve the exchange. If you
request the M&H power during another turn, it waits for the next legal between-turn opening and is checked again then.
If the first 5-train is bought before that opening, M&H closes and the exchange is lost." Classified here as
**RULES REFERENCE / GOTCHA** and **STATE VISIBILITY** for the queued → executed / canceled status. The visual
presentation is not designed yet. `OPEN` (UI, after Slice 8.4).
**After Slice 8.4 (2026-09-17, #1630) — what the authority has done and what U-35 still owes.** *Done, at the socket
and in the reducer:* the exchange's legality is now answered by one predicate at both locks, so a refused exchange is
refused wherever it is sent; a queued request is authoritative state a client can read (`pending_mh_exchange`); the
exchange never switches source and never reserves anything. *Still OPEN, all of it presentation:*
(i) **LEGALITY SYNC in the panel** — `resolvePrivateExchange` is untouched and still answers with its own client-side
rule, so the powers panel / flow modal can present as live an exchange the lock will refuse (over the certificate
limit, under a hold, outside the window, with the named pile empty). It must ask `mhExchangeRequestRefusal` instead.
(ii) **NEW ACTION — the source choice (R2).** `resolvePrivateExchange` still picks the IPO first and silently; the
authority accepts whichever source arrives and substitutes nothing, so the choice exists in the rules and not yet on
the screen. Until the modal offers it, a legal Bank Pool exchange is unreachable while the IPO holds a share.
(iii) **NEW ACTION — requesting off-turn.** The authority queues a request from any Stock or Operating Round moment;
the current control is reachable only where the panel draws it.
(iv) **STATE VISIBILITY** — the queued acknowledgment ("M&H exchange queued for the next legal opening."), the
confirmation when it executes, and the cancellation notice (including the first-5 closure: "M&H exchange canceled —
the first 5-train closed the private before the next legal opening.") plus a shared, persistent table indication of a
standing request. **A limitation to record rather than fix here:** an EXECUTED settlement is inferable from the state
transition (the private closes, the share arrives, `pending_mh_exchange` clears), but a CANCELLED one is not — the
request clears and nothing else moves, so the REASON cannot be represented without new event/notification machinery.
The authority is deterministic and the pending state clears correctly either way; representing the reason is U-35's,
and 8.4 deliberately did not build it. (v) the Rules Reference gotcha card above.

**U-36.** (S8-4 / #1211; found by Slice 8.1, 2026-09-16, by reading the code — not reproduced in a browser) **The
sold-out-rise Activity Log line is built from the chart AFTER the rise was committed — STATE VISIBILITY.** In
`App.tsx`'s dispatch the reducer's `after.market_positions` is first copied into `sandboxMarketRef` (#1211, "the mirror,
written from the board"), and only afterwards is the "Market Move" line built with `soldOutRises({ before, after,
markFor: marketMarkForCompany, projectRise })` -- whose `markFor` reads that ref. Each riser's mark is therefore already
its RISEN cell, so the sentence describes a further, hypothetical rise one row higher (and a riser that reached the top
of its column is not narrated at all). The board is right; the sentence is not. Shell fix: narrate from
`before.market_positions`, or from the before / after position diff, not from the live mirror. Slice 8.1 changed only the
ORDER of that list (highest-priced first). `OPEN` (UI; `App.tsx` is owner-modified and was not touched by 8.1).

**U-37.** (S8-5 / #1343; found by Slice 8.2, 2026-09-16, by reading the code — not reproduced in a browser) **A Stock
Round float is narrated only at the corporation's first Operating turn — STATE VISIBILITY.** #1343 writes one Activity Log
line per float: a corporation that owes a home token gets its line at the placement (`actionLog.ts`), and `describeFloat`
says nothing for it at the float. With the placement moved to the first turn (S8-5), a non-herald corporation's float in a
Stock Round now leaves no Activity Log line until its home goes down an Operating Round later. The board is right; the
narration moved with the placement. The Corporation Floated visual flourish owns the float presentation (U-32); decide
whether the Activity Log should also say "floated" at the float and "placed its home" at the first turn. `OPEN` (UI;
`actionLog.ts` / `describeFloat` untouched by 8.2).

---

**U-38.** (S9-21; filed by Slice 9.3's production-use check, 2026-09-18) **Three player-visible surfaces still
print an errata-voided tile NUMBER — DISPLAY ONLY, no replay effect.** Slice 9.3 put the canonical rules/display
identity on the live catalog (`TileCatalogEntry.canonicalId`, design note #1630) and wired three production
consumers to `canonicalTileName`: the Activity Log sentence (`utils/actionLog.ts`), the "this hex is finished"
click/glow message (`components/hexGeometry.ts`) and the tile-picker tooltip
(`components/TileSelectionPopup.tsx`). **Three surfaces were deliberately left alone because each sits in an
owner-dirty file and Slice 9.3's brief forbids touching them:**

| Site | What a player sees | Should be |
|---|---|---|
| `App.tsx:3340` — the #1390 receipt, *"Tile #N has no upgrade in this game"* | `Tile #626` | `Tile #8861` |
| `components/hexCanvasPrimitives.ts:1063` — the number drawn on the hex face | `#626` · `#36` · `#35` | `#8861` · `oo13` · `oo14` |
| `components/TileReference.tsx:221/306/364` — the Tiles reference tab | `#626` · `#36` · `#35` | canonical |

**The fix is one import and a call per site** — `canonicalTileName(tileId)` from `hexTileCatalog.ts`, which
returns the identical `` `#${tileId}` `` string for the other 73 tiles, so no other label moves. The `App.tsx`
receipt is the sharpest case: it exists *because of* #626 and currently names it by the number the errata voids.
**No reducer change, no replay effect, no golden.** Blocked only on the owner's files being free; the engine and
catalog half is done and test-pinned (`utils/stage93TileAuthority.test.ts`).

**U-39.** (S9-8; filed by Stage 9.5, 2026-09-19) **Two derived readers still express Bank Pool room in percent —
LEGALITY SYNC, conservative, LPF only.** The authority counts five physical certificates (#1670,
`shareSaleBlock`). Two readers downstream of it still compute `50 - bank_pool_percentage`:

| Site | Consequence when the 20 % card is in the pool |
|---|---|
| `gameEngine/endgame.ts` `sellableHoldings` — the §6.6.3 liquidity / forced-sale projection | under-reports the room by one certificate |
| `components/StockRoundPanel.tsx:2520` — its own `BANK_POOL_CAP_PERCENT` copy | a legal fifth certificate is unreachable from the panel |

**Both are conservative**: they can only offer *less* than the authority allows, never more, so neither can admit
an illegal sale and there is no authority hole. Not fixed at Stage 9.5 on purpose — `sellableHoldings` bounds the
President's Certificate by percentage and the owner's S9-8 ruling says presidency rules remain unchanged, so the
projection wants its own small decision rather than a mechanical substitution. **No reducer change, no replay
effect, no golden.**

**U-40.** (S9-4; filed by Stage 9.5, 2026-09-19, on the owner's project-authority ruling) **Player-facing naming
and the Rules Reference's standing — READINESS, no broad rename now.** The game is **Project 18XX**; the expanded
board is **Project 18XX+**; the 1830 rulebooks are development source material, not the player-facing authority.
The readiness pass checks:

- player-facing "1830" terminology on gameplay/rules surfaces;
- "1830+" terminology that should instead identify **Project 18XX+** (the Game Type drop-down #1271 already says
  18XX+; the board data, tray and variant strings are the rest);
- **Rules Reference wording needed to establish it as the sole and final player-facing authority** for Project
  18XX rules;
- source/provenance/credits may still identify the historical rulebooks where appropriate — they are simply not
  the gameplay authority presented to players.

Deliberately NOT a Stage-9 rules item: S9-4's rules-authority question is closed (the implemented board is
correct as Project 18XX+). **No reducer change, no replay effect, no golden.**

## Part D — Deliberate rules deviations and owner decisions (never to be "fixed" as bugs)

**D-1. Bankruptcy ends the game immediately, as the conclusion of the bankrupt president's turn; total-table bankruptcy is impossible.** Owner, 2026-09-06 (DECISIONS A7), rulebook §6.7 / §7.1 — implemented by Stage 5 (`settleBankruptcy`, `DeclareBankruptcy`). `OWNER DECISION` — consistent with the rulebook; recorded because an earlier design had an all-bankrupt fallback, now withdrawn. (The settlement snapshot is taken *after* that turn concludes — MIGRATION_PLAN #1254.)

**D-2. Excess-train discard order at equal share value uses §6.0's operating-order tie-break (top token; rightmost column; furthest up), and nothing else.** Stage 4.6 (#1530 / #1531); §6.6.1 gives no tie-break. A two-over corporation keeps the obligation until at the limit (unreachable through the printed schedule; handled anyway). `OWNER DECISION` (interpretation).

**D-3. Same-model tie between a Bank-Pool train and printed depot stock goes to the pool copy.** Stage 4 (#1512). The rulebook does not distinguish the two; keeps the depot countdown honest. `OWNER DECISION` (tie-break, not a rule).

**D-4. An unresolvable operating cursor inside an OR fails closed for the four identity-gated messages; the dividend / train / licence gates keep their fail-open position.** Stage 3 (#1510). `OWNER DECISION` (engineering).

**D-5. Emergency private-company sale = a seller-initiated player → corporation directed offer; emergency funding relaxes the buyer's own-turn timing ONLY.** Stage 5, design note #1541. Rulebook §6.6.3 permits the sale "if he can find a buyer" and makes it optional, but does not say which of §3.0 / §3.1's ordinary restrictions it overrides; read literally the only railroad "in its turn" has put aside all its money, so no buyer could ever exist. **Interpretation chosen:** any eligible corporation may buy, its president answering off-turn (`OfferPrivateForFunding` → `AnswerFundingPrivateOffer` → `RescindFundingPrivateOffer`); everything else stands as printed — phases 3 and 4 only, price within ½–2× face and publicly declared, the buyer pays from its treasury and must hold the price, the B&O private is never sold to a corporation, a corporation never resells, the rescued corporation is not a buyer. The sale is optional, never auto-liquidated and never a precondition of bankruptcy (derived bankruptcy requires no eligible buyer; `DeclareBankruptcy` when only an optional sale remains). Acceptance is revalidated in full at settlement (`fundingPrivateSaleRefusal`; fail-closed without a grid). **Ambiguity reported, not resolved by guess:** whether §6.6.3 meant to open the sale outside phases 3–4 or outside the price band. Files: `gameEngine/emergencyFunding.ts`, `privatePriceBand.ts`, `emergencyFunding.test.ts`. Replay: part of version 3. `OWNER DECISION`.

**D-6. Emergency intercorporate train-sale simplification (owner-defined digital rules deviation).** Stage 5, #1541. Rulebook §6.6.2 / §6.6.3 print a nested case: a train bought from another railroad that the president must then fund by selling shares, with the seller-presidency change / veto / unwind. **Deliberately not implemented.** While a forced purchase is owed, an intercorporate purchase by the rescued corporation is permitted only when its treasury plus its president's *currently available* cash covers the agreed price (treasury first, the president the rest; §6.6.2's face-value cap applies whenever the president contributes). If completing it would need any share or private sale, that transaction path is refused (`fundedTradeRefusal`; a matching accepted offer is retired) and the obligation resolves through the Bank / Bank Pool forced-purchase path. Must remain documented as a deviation; tested (`emergencyFunding.test.ts`, owner-rule block). Replay: part of version 3. `OWNER DECISION`.

**D-7. Bankrupt scoring: net worth = market value of the shares he could not sell (no cash, no privates), ranked with everybody; the wealthiest wins, bankrupt or not.** Stage 5 (`rankPlayers`), rulebook §6.6.3 note — supersedes `endgame.ts` #5's "title passes to the highest non-bankrupt". `RESOLVED` per rulebook; recorded because the old rule was deliberate.

**D-8. The last forced-sale certificate may overshoot the shortfall and its full proceeds are kept; a bundle is refused only when one certificate fewer already covers it.** Stage 5 (#1540). Rulebook §6.6.3 "only enough" with indivisible certificates. `OWNER DECISION` (interpretation).

**D-9. Legacy-log policy: unpinned logs are refused by default; `--legacy-logs development-corpus` and `legacyExcessTrains: "engine-chose-cheapest"` are development-only, best-effort, never production; no historical reducer bundle.** Stages 4.5 / 4.6 (#1520). `OWNER DECISION`.

**D-10. Owner-defined variants have no rulebook counterpart and are judged against their own specs:** ~~Level Playing Field (S9-5),~~ *(corrected by Slice 8.2: the Level Playing Field is printed Scenario D, S-1.0 of the full 48-page rulebook — judged against the print, with the owner's readings and variations listed in S9-5; the revised 2018 book stays the Classic authority)* Project 18XX+ (S9-4 — decision still owed on labelling vs the p.25 board), Delayed Auction (#905), Gentle Rust (#1034), Unpredictable Revenue / Yellow Sign (#1046), short/long banks, 7-player LPF. `OWNER DECISION` (standing).

**D-11. Auto-Pass presidency guard is a toggle, on by default; off, a tied presidency rides.** #1335 (T05 20 ruling). `OWNER DECISION` (UX rule).

**D-12. Settlement / money decisions (DECISIONS_2026-09-06, resolved same day):** operator-trusted settlement; session keys sign every move; no unilateral exit after the deal, 14-day liveness; consent fast path; bonded challenge; every game has an on-chain ante (no free-game path); forfeit pays zero. Outside rules hardening; listed so D-1 has its source and so nobody re-opens A7. Specified in `MIGRATION_PLAN.md` #1254.

**D-13. Auto-skip granularity: the log stays granular (one derived entry per skipped sub-phase) and the transport emits at settle points; the client suppresses intermediate frames.** Decided 7 September (UI_ACTION_PLAN "Not in this plan": "granular log, settle-point emission… re-observe, do not patch"; TRIAGE_2026-09-05 item 6; PLAYTEST_TRANSPORT check 1). The wire format is therefore frozen on per-step derived entries. `OWNER DECISION` (log format). If flicker is re-observed it is a shell frame-suppression bug, not a log change.

**D-14. Under Unpredictable Revenue, "Last Run" reports the variant-adjusted figure, not the printed route value** (#903; `printed_route_revenue` accumulates within a turn, #968). TRIAGE_2026-09-05 item 24 — answered by the headless replay (MIGRATION_PLAN "Item 24 — answered", #1195): not corruption; three correct behaviours compounding. `RESOLVED`; recorded so the card's figure is not reported as a desync again.

**D-15. Money paid to the bank increases the bank; the bank is signed after it breaks; the break is latched.** Owner,
2026-09-15 (Batch 7 design Q1a/Q1b). Auction proceeds and terrain fees credit the bank (they never did — S7-10);
after the bank runs out its balance goes negative rather than flooring (m11 withdrawn as "paper tracking"); a
`bank_broken` latch written at the first non-positive balance is never un-set by a receipt (S7-20). `OWNER DECISION`.

**D-16. A player may raise his own standing bid during the initial buy/bid sequence.** Owner, 2026-09-15 (Q3): the
§1.2.3 note that a player gains little benefit from bidding twice on the same company supports repeated bids on one
company. `OWNER DECISION` (rulebook reading).

**D-17. Ordinary IPO purchases are priced from the corporation's stored par; a message-carried `par_value` is narration.
The president's purchase requires the par on the message and validates it against the legal par cells of the chart in
use; there is no fallback par.** Owner, 2026-09-15 (Q4). `OWNER DECISION` (authority placement).

**D-18. Offer timing: a corporation's private-company proposal may be made at any step of its Operating Turn (§3.0
"at any time"); an intercorporate train-sale proposal only at Buy Trains, so an acceptance can never deliver a train
before Run Trains.** Owner, 2026-09-15 (Q5). `OWNER DECISION` (interpretation of §6.6 / §6.4 note).

**D-19. A pending ordinary transaction offer freezes progression until it is answered, rescinded or settled; `RevertTo`
and `CloseRoom` still pass.** Owner, 2026-09-15 (Q6). One offer at a time, of any kind, never beside a funding offer.
`OWNER DECISION` (digital rule; the physical game answers at the table).

**D-20. A voluntary intercorporate train purchase is paid entirely from the buying corporation's treasury; presidential
cash enters only through the forced-purchase rules (D-6).** Owner, 2026-09-15 (Q7). `OWNER DECISION` (§6.1 note +
§6.6.2 reading).

**D-21. The all-pass markdown applies only to the Schuylkill Valley, under every roster; under LPF the JK or any other
lowest unsold private does not inherit it.** Owner, 2026-09-15 (Q8). `OWNER DECISION` (rulebook-literal §1.2.3).

**D-22. A Brown-zone Bank Pool purchase may still be expressed as several `BuyStock` messages in one turn; every
continuation must name the corporation recorded in `bought_this_turn_company`; it is one purchase for turn purposes.**
Owner, 2026-09-15 (Q9). `OWNER DECISION` (representation).

**D-23. Seat/turn authority stays at the ingress only; reducer transaction rules add round/action legality and never
duplicate historical seat authority (JUNO-3XD's SR1 is seated by the pre-#1235 constant). `BidOnPrivate`,
`AcceptTrainOffer`, `RejectTrainOffer`, `RescindTrainOffer` are refused on pinned boards from Stage 7; their
type/schema retirement stays S10-8.** Owner, 2026-09-15 (Q10/Q11). `OWNER DECISION` (engineering).

**D-24. Player ↔ player private-company sales are implemented (§3.1) as the third bilateral offer kind, without the
½–2× band.** Owner, 2026-09-15 (Q12) — see S7-9 for the semantics. `OWNER DECISION` (product; rulebook-consistent).

**D-25. A stock purchase from a source that cannot deliver every certificate asked is refused outright — never capped,
never charged less, never charged for nothing.** Owner, 2026-09-15 (Q13; audit m9). `OWNER DECISION`.

**D-26. What travels with a private company sold player → player (Batch 7 N1, accepted).** Ownership of the private
transfers with every still-unexercised ownership-dependent power: the M&H's exchange ability follows the M&H (it
belongs to the current owner until exercised); CS / D&H / JK and comparable still-live abilities follow the private
(a used ability stays used — `used_private_abilities` is per private). Already-vested one-time benefits neither
transfer nor trigger again: the C&A's already-issued PRR share stays with whoever holds that share and a later sale
of the C&A issues nothing; the B&O's already-issued president's certificate / par stay with the auction winner and
a later sale of the BO private retriggers nothing. The BO private itself **may** be sold player → player — the
printed prohibition (§3.1) is against selling it to a corporation. Owner, 2026-09-15. `OWNER DECISION`
(authoritative Batch-7 ruling).

**D-27. A player ↔ player private-company transaction counts as Stock Round transaction activity by the
current-turn player (Batch 7 N2, overridden).** It does not consume the one corporation-stock purchase. Exact
bookkeeping on settlement (inside the answer arm, on `accept: true`, nothing on a refusal/rejection/rescind):
`turn_action_taken: true` for the current-turn player (End Turn is then `advanceSeat`, never `recordPass`);
`consecutive_passes: 0`; `last_trader_index` = the current-turn player (`markTrader` — the priority deal treats
that player as the latest trader under the digital reading of §5.0); `bought_this_turn` and
`bought_this_turn_company` untouched; the seat cursor untouched (the counterparty's acceptance is an off-turn
consent answer, not a Stock Round turn); `stock_turn_stage` untouched. Owner, 2026-09-15. `OWNER DECISION`
(recorded so no later code infers it from §5's certificate terminology).

**D-28. The forced (§6.6.3 emergency) stock sale's refusal is VISIBLE at ingress, with the authority's own
sentence (Batch 7.2 §14d, owner 2026-09-15).** An illegal emergency/forced `SellStock` returns the
authoritative refusal reason to the acting president rather than a silent reducer no-op. This **does not move
authority**: the reducer/core remains canonical; ingress surfaces the same rule RESULT and must never
implement a competing rule; legal Batch-5 emergency sales remain legal and are answered `null` at both locks;
only illegal attempts gain an explanatory response. Mechanically, `turnRefusal` makes exactly one call for a
sale — to `stockSaleRefusal`, which asks `forcedSaleRefusal` last and unchanged — so the sentence a president
hears is character-for-character the one the reducer refuses by, pinned by
`stockTransactionAuthority.test.ts` "answers an ILLEGAL forced sale with the forced-sale predicate's own
sentence, at both locks (D-28)". **Supersedes the previous expectation in `emergencyFunding.test.ts` case 7**
("the owner may send it; the reducer refuses it"), which the owner has ruled was never a rule requirement.
`OWNER DECISION`.

**D-29. The M&H exchange is a free interjection, and an off-turn request is queued to the next legal between-turns
boundary (Stage-8 review R1, owner 2026-09-16).** The exchange consumes nothing of the Stock Round turn: not the one
certificate purchase, not `bought_this_turn` / `bought_this_turn_company`, not the Sell → Buy → Sell stage, not the
consecutive-pass streak, not Priority Deal, not the seat, not `turn_action_taken`. Timing: immediate when requested on
the owner's own Stock Round turn or at a genuine server-visible turn boundary; otherwise recorded as a pending request
(never executed mid-turn, never interrupting the actor, never a transition-time prompt), executed automatically at the
next legal between-turns boundary after revalidating the whole exchange against the authoritative board, and retired
cleanly if no longer legal. Mandatory holds and atomic resolution take precedence. The server has no persistent
physical-game "between turns" pause, which is why the queue exists. Not "any time in the middle of another
corporation's turn". Queuing vests nothing (owner, 2026-09-16): the request is revalidated in full at settlement and
expires without effect if it is no longer legal — a first 5-train bought before the boundary closes the M&H (Phase 5),
so no NYC share is received; likewise if the NYC share or another legality condition is no longer available (Rules
Reference gotcha, U-35). STATE VISIBILITY per U-35. Implementation: Slice 8.4. `OWNER DECISION` (digital timing of a
rulebook permission).

**D-30. The M&H owner chooses the exchanged share's source (Stage-8 review R2, owner 2026-09-16).** When both the NYC
IPO (Bank) and the Bank Pool hold a legal 10 % share, the owner chooses; when only one is legal / available, only that
one is offered. No silent IPO-first rule. Implementation: Slice 8.4 + U-35 (NEW ACTION). `OWNER DECISION`
(rulebook-literal p. 27 "from the bank or the bank pool").

**D-31. The development corpus's home-token adapter replays the last recorded legal home choice as DATA, through the
current predicate (Stage-8 review R3, owner 2026-09-16).** For Slice 8.2 the development-corpus-only deferral adapter
remembers the last recorded historical home choice on a legal home hex and applies it at the corporation's first OR
turn — but the synthetic placement must pass the current authoritative home-placement predicate on the then-current
board; an obsolete / now-illegal choice is never forced through (no placement is synthesized and the normal home hold
stays in force). Development-corpus-only (D-9's shape), never production compatibility. The CV4 field-only
re-baseline and the Z6C / 3XD replay corrections are accepted consequences. `OWNER DECISION` (replay policy).
**Implemented by Slice 8.2 (2026-09-16, #1614 / #1614a):** `legacyHomeTokens: "defer-to-first-turn"` in
`DEVELOPMENT_CORPUS_POLICY` only (`"refuse"` for the server); `LegacyHomeChoices` remembers a refused, untimely placement on
a candidate home (last wins) and tries it once, by the president, through the reducer at that corporation's first turn;
never substituted; `LegacyLogAdapters.apply` is the one step `replayLog` and the corpus harnesses share. All 28 supplied
homes in the corpus land; the CV4 goldens needed no re-baseline after all (their final boards are identical).

**D-32. The operating order is frozen round membership + a frozen operated / current prefix + a dynamically sorted
not-yet-operated tail (Stage-8 review R4, owner 2026-09-16).** `active_operating_order` and `active_corporation_index`
are kept; no operated-set representation. Implementation: Slice 8.1 (S8-1 / S8-3 / S8-4). `OWNER DECISION`
(representation).

**D-33. The Erie's and the PMQ's OO home hex closes to other corporations only once a tile is on it, and only until the
home is placed (S8-14, owner ruling 2026-09-17).** Before a tile is placed or upgraded on the OO home hex (the Erie's
E-11; under the Level Playing Field the PMQ's E-5) there is no whole-hex reservation: ordinary future-home protection
applies — another corporation may occupy one of the two cities if otherwise legal, never the last legal home city. Once a
tile has been placed or upgraded there, and until the home corporation places its home, no other corporation may place
any additional station anywhere on the hex; a foreign station legally placed before the tile remains. Once the home is
placed the special prohibition ends and ordinary rules govern. The home corporation still chooses either legal city for
its free home, and no tile is required first. Source: the full 48-page rulebook's base game 7.3.2 (p. 20) states this
conditional form for the Erie; its variant V-7.3 (p. 32) omits the tile condition and applies the Erie's rules to the
PMQ — the ruling applies the conditional form to both. Implementation: Slice 8.2, #1617 (`closedOoHomeAt`), S8-14.
`OWNER DECISION` (rules reading).

---

## Part E — Replay / version ledger (what a rebuilt room can differ by)

| Version | Stage | What changed in replay meaning | Known corpus consequences |
|---|---|---|---|
| (pre-pin, "legacy") | ≤ 4 | Stage 3 identity gate; Stage 4 pool destination; #1183/#1184 (one run per turn, bid minimum) | JUNO-3XD idx 224 refused (PRR run 210 → 170, re-pinned with reason); JUNO-3XD idx 255 `returned_trains` `["3"]`; JUNO-FCJ diverges from idx 95 (illegal token refused) — prefix-96 frozen as a fixture |
| 1 | 4.5 | pin only; semantics = post-Stage-4 | all 16 legacy logs refused by default; identical under the corpus policy |
| 2 | 4.6 | president's `DiscardTrain` replaces the automatic trim; limit-in-force at depot gates; §6.0 row key | JUNO-FCJ idx 474 (C&O's first 5 now allowed, then a discard); 3XD idx 255 supplied by the adapter; row key changes nothing observed |
| 3 | 5 (`78f8358`) | derived forced-purchase obligation, forced sales, funding offers, bankruptcy → `GameEnd`, holds, D-5 / D-6 | JUNO-Z6C from idx 614 (`PassTurn` on an ended board now held); historical `EmergencyBuyHardware` entries (FCJ ×3, Z6C ×3) identical |
| 4 | 6 (uncommitted) | route legality and revenue judged by `routeAuthority.ts`; a town is a terminus (S6-10 ruling, #1555); a run short of the search's demonstrated combination is refused (S6-3 ruling, #1556); one run per turn; dividend amount must equal the run (C1); Run Trains not skippable past a paying route (pinned boards); `RunManualRoute` refused on pinned boards; pin copied onto the state; #1183 key relocated to the state | 14 / 17 logs gameplay-identical to version 3 (every digest changes where a run occurred: the #1183 key moved from the corporation to the state — CV4 golden re-baselined for that alone). **JUNO-CV4 from 98** (S6-3: B&O with three 2-trains ran two of them, $90; the search demonstrates $130 — I15–J14 $50, I15–I17–I19 $40, J14–K13 $40 — so the run is refused, 99's $90 declaration mismatches, and the CV4 golden fixture is re-baselined for it; `replayJunoCV4.test.ts` unaffected). **JUNO-Z6C from 140** (S6-3: B&O ran three of four trains, $160 vs $220; also 172 C&O $70 vs $80 — the search adds the Akron & Canton town terminus G7–F6–G5–G3–F2, an S6-10 consequence; 396 N&W $340 vs $350 on the already-diverged board). **JUNO-3XD from 175** (S6-3: NNH ran $240 with [2, 2, 3]; the search demonstrates $270 — the 3-train could reach Baltimore, F16–G15–H16–I17–I15 $110; the operating order of every later round then differs; `replayJuno3XD`'s filed table re-pinned PRR 260, NYC none, B&O 350, C&O 220, NNH 90 with the reason; the idx-255 discard the Batch-4.6 adapter used to supply no longer falls due in the log-derived game, `trainDiscard.test.ts` re-pinned with the reason). **JUNO-FCJ from 74** (S6-10: B&M, trainless, passed at Buy Trains with a town-ended route E23–F24 that is now a legal route, so the Batch-4 forced purchase is owed and the pass is refused; before the ruling the first difference was **230**: B&M's second route touches no B&M station on the log-derived board — the idx-95 token Batch 3 refused; every later B&M dividend then mismatches; cascade). **JUNO-Z6C from 418** (NYC declared $180 on a $190 run; 428 PMQ $290 / $300; 433 NNH $250 / $270 — refused as C1 mismatches; treasuries differ, the bank no longer breaks at 613; `gameHistory.test.ts` relaxed from "reaches OR 9.1"). **JUNO-3XD from 260** (PRR's run names a 4-train in slot 1 that the log-derived fleet [3, 3] does not hold — a Stage-3 queue divergence now refused rather than priced; 307 the same; the OR-7 order then swaps and B&O's 313 is identity-refused; 319 NNH's duplicate run is refused by the one-run rule and 320's $540 by C1 — `replayJuno3XD` re-pinned PRR 170 → 260, B&O 240 → 270, NNH 540 → 340 with reasons) |

| 5 (owed until 7.5) | 7.1 (`08a59ec`) | one money ledger; the three floored adjusters retired; auction proceeds and terrain fees credited to the Bank (D-15/Q1a); the Bank signed (Q1b); `bank_broken` latched by the debit that empties it (S7-20) | nine of twelve rooms differ in `virtual_bank_vgp` and nothing else; **JUNO-FCJ from 106**, **JUNO-Z6C from 193**, **JUNO-3XD from 28** (26 unaffordable purchases refused instead of minting). `RULES_ENGINE_VERSION` deliberately NOT bumped — the 4 → 5 bump is Batch 7.5's. Stale by design: `replayGolden` (CV4, G6J — bank only), `replayJuno3XD` ×2, `gameHistory`, `roundReplay` |
| 5 (owed until 7.5) | 7.2 (`a927e5f`) | `stockTransactionAuthority.ts`: `BuyStock` / `SellStock` are Stock Round actions (the §6.6.3 forced sale excepted); the IPO price is the corporation's stored par and the pool price is `market_positions` (a message `par_value` is narration — D-17/Q4); the President's Certificate needs a ladder par, the 20 % card in the IPO, `quantity === 1`, not the double, and exactly 2 × par in cash — **no $67 fallback**; a purchase from a source that cannot deliver is refused outright (Q13/D-25); every purchase proves `cash >= charged`; sales must be whole 10 % bundles, are refused in the first Stock Round and on an unparred corporation, and take their price from the chart on a pinned board; the Brown Bank-Pool continuation must name `bought_this_turn_company` (new state field, Q9/D-22); `SetBoPar` validates the par ladder without charging | **Only three corpus files diverge from the 7.1 baseline, and all three for the same rule.** **JUNO-FCJ from 83** (`BuyStock` in an Operating Round; 21 entries newly refused, 246 newly applied on the cascaded board). **JUNO-3XD from 140** (same rule; 26 newly refused, 9 newly applied). **`JUNO-FCJ-prefix96` at 83** (the same entry; the prefix ends before any cascade, so exactly one entry differs). Every other room — 8E8, CV4 ×3, CW7, G6J ×2, JJD, QVC, 7NZ ×2, TQQ, Y8V, Z6C — is **gameplay-identical**, including all three goldens. Field-level comparisons additionally show the new `bought_this_turn_company` key on every log that has a Stock Round; `stateDigest` and the golden fixtures do not, because the key is written with the value `undefined` exactly as `stock_turn_stage` is (#1443). Nothing re-pinned; `RULES_ENGINE_VERSION` still 4 |

| 5 (owed until 7.5) | 7.3 (`d0a0792`) | `auctionAuthority.ts`: no bid on the lowest-offered private; escrow-aware bids, raises and face-value purchases; the $5 minimum raise; main-rotation actions refused while a contest is live; `BidOnPrivate` refused on pinned boards. `passes_since_raise` on `mini_auction` (absent = 0): a contest pass keeps the bidder and his bid and is counted, a raise resets it, and the contest ends at `bidders.length - 1`. §1.2.3 split in two: the markdown is the SV's while it is unsold; private income is paid only once the SV has sold | **Measured against the committed 7.2 baseline `a927e5f`, not against 7.1 or Batch 6.** Two rooms change their END state, both C5: **JUNO-Z6C from idx 9** (`WaterfallPass`; the B&O was marked 220 → 215 with the SV already sold — it stays 220, and the whole game then differs) and **JUNO-G6J from idx 7** (`WaterfallPass`; the LPF's James River & Kanawha was marked 120 → 115 — it stays 120, so its buyer pays $5 more: `player_cash` 985 → 980 and the bank 9550 → 10305 on the golden). Three rooms differ TRANSIENTLY and end identically: `server/JUNO-8E8` 8, `server/JUNO-CV4` 7 and `export`/`golden`/`JUNO-CV4` 7 carry `passes_since_raise: 0` on a live `mini_auction` that then resolves to `null`; and **`export/JUNO-3XD` 6** (`WaterfallBidHigher` at $165 against that player's own $165 standing bid — already refused by #1184's minimum, but 7.2 still ran `advanceSeat` for it, so 7.3's whole-message refusal leaves `active_player_index` behind until the rotation re-converges). Untouched: 7NZ ×2, CW7, FCJ, TQQ, JJD, QVC, Y8V, the FCJ prefix fixture. Nothing re-pinned; `RULES_ENGINE_VERSION` still 4 |

| 5 (owed until 7.5) | 7.4 (`6ecdfb1`) | `pendingOfferHold.ts`, `privatePurchaseAuthority.ts`, `trainSaleAuthority.ts`, `privateTradeAuthority.ts`: one ordinary offer at a time and a global hold while it stands (D-19/Q6); the corporate private purchase judged at proposal, answer and settlement (OR, operating buyer, phases 3–4, open player-owned non-B&O private, band, treasury, consent); the intercorporate sale likewise (Hardware-only proposal D-18/Q5, ≥ $1, treasury-only D-20/Q7, limit, consent; D-6 unchanged and asked first); counterparties re-derived from the board (S7-11); a refused accepted settlement retires its offer (#1596); `RescindPrivatePurchase` / `RescindTrainPurchase`; the player ↔ player trade (`ProposePrivateTrade` / `AnswerPrivateTrade` / `RescindPrivateTrade`, `private_trade_offer`, D-24/D-26/D-27); `AcceptTrainOffer` / `RejectTrainOffer` / `RescindTrainOffer` refused on pinned boards (D-23). Schema 44 → 49 | **Measured against the committed 7.3 baseline `d0a0792`.** Sixteen of seventeen files are digest-identical at every entry and at the end (3XD, CV4 ×3, JJD, QVC, Y8V, 7NZ ×2, 8E8, CW7, G6J ×2, TQQ, Z6C, the FCJ prefix). **`server/JUNO-FCJ`** is the one room that differs: entries **145** (`ProposeTrainPurchase` — the B&O owns no 2-train on the log-derived board, an inherited 7.1 consequence, so the 7.4 predicate refuses the offer; 146/147 then find nothing), **205**, **273** (`ProposePrivatePurchase` by a corporation that is not operating), **232** (a proposal in a Stock Round) and their answers **209 / 234 / 274** are refused; through **308** the only field difference is the offer fields carried as `null` by the old engine versus absent under 7.4 — no gameplay difference. The first GAMEPLAY difference is **idx 309**: a direct `BuyPrivateCompany` (B&O buys private 7 for $60) sent during a Stock Round, applied by the old engine and refused by 7.4's round rule; from 310 the cash, treasuries, `private_companies` and `jk_license_granted` differ and every later step cascades (the room ends with 8 differing fields; money total identical, 20000). Direct trades 163/177/279/314/468/614/768/784/975 were already no-ops under 7.1 and remain so. Nothing re-pinned; `RULES_ENGINE_VERSION` still 4; the five suites stale since 7.1–7.3 (`replayGolden` ×2, `replayJuno3XD` ×2, `gameHistory` ×4, `roundReplay` ×1, `moneyConservation` ×1) are unchanged in number. **Follow-up (R74-B / O1 repair, #1597 / #1598, uncommitted):** `offer_serial` on the board and `instance` on every ordinary offer, the derived settlement key `offer:<kind>:<instance>`, and `derivedEntryKey` for the replay's guard record. Measured against the pre-repair 7.4 tree: fifteen of seventeen files are digest-identical at every entry and at the end; **`server/JUNO-CW7` from idx 122** and **`export/JUNO-QVC` from idx 60** differ ONLY in `offer_serial` (1) and `train_purchase_offer.instance` (1), written by the stored proposals at 121 / 59; applied / dropped counts, money totals and bank balances identical everywhere; FCJ unchanged (its four stored proposals are refused by 7.4). The ten stale cases are unchanged in number |

| **5** | **7.5** (uncommitted) | **The bump.** `RULES_ENGINE_VERSION` 4 → 5, `SUPPORTED_RULES_ENGINE_VERSIONS` [5], changelog row 5 (Batch 7). No engine semantics changed in 7.5; a version-4 room is refused before replay under every policy; unpinned logs keep the #1520 boundary (server refuses, development corpus admits). | **Cumulative Batch-6 (`215eb29`) → version 5, 18 files / 12 rooms / 3,103 replayed entries, each slice measured against the committed tree before it.** Bank-only (7.1 auction / terrain credit, no gameplay change): `golden`+`server`+`export` JUNO-CV4, `golden`+`server` JUNO-G6J (plus 7.3), JUNO-8E8, JUNO-CW7, JUNO-JJD, JUNO-QVC, the FCJ prefix; identical: JUNO-7NZ ×2, JUNO-TQQ, JUNO-Y8V. **JUNO-G6J** final: bank +$755 (7.1 $750, 7.3 $5), `player_cash` 985 → 980 (7.3 C5, idx 7). **JUNO-CV4** final: bank 8516 → 9511 (7.1). Transient only (end identical): 7.3's `passes_since_raise` on CV4 ×3 idx 7 / 8E8 idx 8, 3XD idx 6's refused sub-minimum bid; 7.2's `bought_this_turn_company` written during a purchase turn (every Stock Round). **JUNO-3XD** from 28 (7.1 unaffordable NNH buys; NNH never floats in SR 1) and 140 (7.2 OR `BuyStock`); only B&O's run at 61 is ever accepted; filed table PRR —, NYC —, B&O 50, C&O —, NNH —. **JUNO-Z6C** (store and 494 fixture) from 193 (7.1) then, under 7.3, from **9** (C5): B&O stays $220, 31 unaffordable, B&O floats at 33 after its stored home placement, and the home-token hold freezes the log from **34** — timeline `[SR 1, Final]`; the Yellow Sign at 203 is never reached. **JUNO-FCJ** from 106 (7.1), 83 (7.2 OR `BuyStock`), 145 / 205 / 232 / 273 (7.4 proposals) and 309 (7.4 direct Stock-Round private purchase). **JUNO-CW7** 121 / **JUNO-QVC** 59: `offer_serial` 1 / `instance` 1 only (7.4 #1597). Money conservation: zero non-`SetupGame` breaches in all 3,103 entries (Batch 6: 163 across the 18 files); no log writes `bank_broken`. Version-5 tree vs committed 7.4: digest-identical at every entry of every file, and deterministic across repeated replays. **Re-pinned with reasons:** golden `JUNO-CV4.json` (bank), `JUNO-G6J.json` (bank, cash); `replayJuno3XD` cursor table and filed table; `moneyConservation` Yellow Sign case (corpus list empty for the Z6C freeze, the mint pinned on a hand-built board); `routeAuthority` 23 (version-only). **Re-homed (owner ruling):** the completed-game cases of `gameHistory` / `roundReplay` / `accolades` / `gameOutro` to the JUNO-CV4 golden log, one Z6C characterization added, Z6C-only accolade coverage deferred to S10-21. `accolades` ×5 and `gameOutro` ×1 had been stale since 7.3 without being listed in the 7.3 / 7.4 stale sets. |
| 5 (owed until 8.5) | 8.1 (`05b5dfc`) | `settleOperatingQueue` (#1600): the queue that opens an Operating Round is the §6.0 order of the COMMITTED post-rise chart and the table is seated at its head (S8-1); during a round the not-yet-operated tail is re-sorted whenever a token moves, the operated / operating prefix never moves, membership is fixed when the queue is built (S8-3); sold-out risers committed highest-priced first, keeping stack order (S8-4, #1601); the #746a resolver overlay removed | **Measured against the working tree immediately before Slice 8.1** (committed `7c5f29c` plus the owner's uncommitted non-8.1 edits, so the comparison isolates 8.1), 18 files / 3,103 replayed entries under `DEVELOPMENT_CORPUS_POLICY`: **digest-identical at every entry and at the end in every file**, with identical `active_operating_order`, `active_corporation_index`, operating corporation, seat and turn key after every entry; deterministic in-process and across processes. 779 Operating Round boards all carry a §6.0-ordered waiting tail; all 60 openings equal the sort of their committed chart; FCJ 885 (the only opening rise) settles to PRR, B&O, B&M as stored. No corpus log has a mid-round move of a waiting corporation or two risers in one cell (non-regression evidence only). `JUNO-Y8V` replays **zero** entries (668 raw rows; no entry identity survives `effectiveActions`). Corpus files byte-unchanged (sha256). Nothing re-pinned; `RULES_ENGINE_VERSION` still 5 |
| 5 (owed until 8.5) | 8.2 (`efe4098`) | home station owed at the start of the corporation's first operating turn, derived on the cursor (S8-5, #1610); one placement predicate at both locks (S8-6, #1611); the turn-local home hold at both locks and in the derived loop (S8-12, #1612); the four holds asked before the auction, chart, core and queue settle, and by the lay's grid step (S8-13, #1613); #769 / #769a retired; D&H station appended and outside the home rules (#1615); development corpus's `legacyHomeTokens` adapter (#1614, D-31); a tiled OO home hex (the Erie's E11, the PMQ's E5) closed to every other corporation's station until its home is placed, and a paid placement judged at ingress by the reducer's identity and legality predicates (S8-14, #1617, D-33) | **Measured against the working tree immediately before Slice 8.2** (committed `05b5dfc` plus the owner's non-8.2 edits), 18 files / 3,103 stored entries under `DEVELOPMENT_CORPUS_POLICY`. First differences: **CV4 ×3** board before 20 (seat after the float at 19), placement 20 refused and B&O I15 supplied after 26, C&O F6 after 62 — final boards identical, goldens unchanged; **CW7** 27 / 28 (B&O after 57, B&M after 64), final identical; **QVC** 16 (B&O after 27, PRR after 36, C&O after 42), final identical; **G6J (server)** 23 — no OR in the log, final lacks both tokens; **FCJ-96 prefix** 49 / 50 (B&M after 69), final lacks B&O's token; **FCJ** 49 / 50, then N&W's float at 902 no longer freezes the round: 904 / 911 / 918 become real sales, 932 is refused by the President's Certificate rule, N&W L16 lands after 936, final OR 29.1 (was frozen SR 25); **3XD** 25, then NYC's float at 289 no longer freezes SR 11 (296 first newly applied; NYC E19 circle 0 after 302), final SR 12; **Z6C** (store and 494 fixture) board after 33 (seat), 34 applied, B&O after 40, NNH after 47, C&O after 59, NYC after 285, PMQ E5 circle 1 after 362; the Yellow Sign at 203 is reached again; finals OR 11.2 / OR 10.1. Unchanged: 7NZ ×2, TQQ, JJD, 8E8, golden G6J; Y8V replays zero entries. **Against the pre-8.2 engine with each home placed at its float from the same recorded choice:** identical board (station tokens aside), acceptance and grid at every stored entry of every file. Every observed grid identical with and without the grid-step hold check. Re-pinned with reasons (design §5.10): `replayJuno3XD` turn keys 307 / 313 / 318 / 319; `gameHistory`'s Z6C characterization; `moneyConservation`'s Yellow Sign list (Z6C 203 +$90). Corpus files byte-unchanged. **S8-14 follow-up (2026-09-17), measured against the 8.2 tree immediately before it:** no corpus file lays a tile on E11 or E5, so the closed window never opens; no foreign placement targets either hex; for all 32 `PlaceStationToken` entries the new ingress branch's verdict matches the reducer's outcome; every observed board, grid and end state identical (18 files; 3,131 observed messages = 3,103 stored entries + the adapter's 28 home placements). `RULES_ENGINE_VERSION` still 5 |
| 5 (owed until 8.5) | 8.3 (`02a9838`) | one presidency selector, `presidentFor(company, seating)`: §5.4's clockwise tie-break measured from the FORMER president's seat, strictly-more to take the crown, the 20 % floor as a percentage (so the LPF non-president 20 % qualifies exactly as two 10 %s do), and the forced-sale projection asked of that same function so an answer cannot drift from its settlement (S8-2, #1620); the Scenario-D presidency exchange — two ordinary 10 %s where the successor has them, otherwise the other-20 card one-for-one, percentages unmoved either way (S8-15, #1622); and V-7.2's prerequisite, that a sale cannot supply its own exchange certificate (S9-14, #1624) | **Measured against the committed 8.2 tree `efe4098`**, 18 logs / 3,131 observed messages: **7 presidency changes, 0 ties, 0 disagreements between the old selector and the new one** — corpus-neutral, every board and every final digest identical. `presidencyCorpus.test.ts` forks the pre-slice rule and replays both to convergence. Nothing re-pinned; `RULES_ENGINE_VERSION` still 5 |
| 5 (owed until 8.5) | 8.4 (`fc5a575`) | the M&H exchange becomes an authority of its own (`mohawkExchange.ts`, S8-10, #1630–#1634): a FREE player-initiated interjection that consumes no Stock Round purchase, no `bought_this_turn`, no Sell→Buy→Sell stage, no `turn_action_taken`, no pass streak, no Priority Deal and not the seat (R1); a request made while another player's or corporation's turn is underway is QUEUED as `pending_mh_exchange` and settled, FULLY REVALIDATED, at the next legal between-turn boundary (queuing vests nothing, and the first 5-train can still close the M&H and destroy the opportunity); settlement runs inside `settleRoundTransitions` and as `advanceCorporation`'s first line, both ahead of every `buildOperatingOrder`, so an SR→OR float is never locked out of the round it has just qualified for; the source is the owner's choice and is never switched for them (R2) | **Measured against the committed 8.3 tree `02a9838`**, forked engine vs HEAD (`mohawkExchangeCorpus.test.ts`): no corpus log contains an `ExchangePrivate` entry, so the arm is corpus-neutral by construction; every board and final digest identical. `pending_mh_exchange` is covered by the digest automatically (`stateDigest` canonicalises the WHOLE state, #232) — absent, `null` and standing are three distinct digests, pinned in `stage85Closure.test.ts`. Nothing re-pinned; `RULES_ENGINE_VERSION` still 5 |
| **6** | **8.5** (`0b23b1e`) | **The bump.** `RULES_ENGINE_VERSION` 5 → 6, `SUPPORTED_RULES_ENGINE_VERSIONS` derived `[6]`, changelog row 6 naming every Stage-8 semantic change: operating order settled on the committed post-rise chart, sold-out rise order, the home station owed at the FIRST OPERATING TURN, the Erie / PMQ whole-hex protection, C&O Cleveland-or-Richmond, the CLOCKWISE presidency tie-break, the Scenario-D certificate-safe exchange, the M&H authority with `pending_mh_exchange` and its boundary settlement, and 8.5's own removal of the unparred share price (S8-8, #1640). A version-5 room is refused before replay **under every policy**; unpinned logs keep the #1520 boundary (server refuses, development corpus admits). | **Measured from HEAD under v6**, 18 files / **4,105 stored entries / 3,103 applied / 1,002 dropped by `RevertTo` / 1,131 reducer no-ops / deterministic 18 of 18 / 0 boards ending with a queued M&H request**. The three frozen goldens (last written at `47d1b7a`, Batch 7.5) replay byte for byte — the one TRUE before/after comparison, and **Stage 8 costs them nothing**. The S8-8 change is corpus-neutral: **zero** boards carry a standing emergency-funding obligation. **Filed, not fixed:** S10-23 (`export/JUNO-Y8V` applies 0 of 668 rows — no entry ids, and `effectiveActions` kills by identity, #1026; pre-existing, `logRevert.ts` untouched by Stage 8) and S10-24 (the discard hold omits `RevertTo`; unreachable, reverts never reach the reducer). **Re-pinned:** `batch75Closure`'s four version assertions to the relative form Batch 4.6 / 5 / 6 already use. Nothing else re-pinned; no expected output re-derived from the new engine |

| 6 (owed until Stage-9 closure) | **9.2** (uncommitted) | **Board / printed-topology authority.** `immutableHexRefusal` (#1620) is rule 0 of `filterSandboxPlacements`, ported from `hexmap.rs:2317` / `:2331` in their order and shared with `evaluateHexForTileLaying` (S9-10 / F-1); `priorTopologyAt` (#1621) feeds rule 5 the hex's LIVE topology in `liveEdgesForHex`'s fallback order, so board-printed track is preserved on a first lay (S9-10 / F-2); `stationAnchorAuthority.stationAnchorRefusal` (#1623) puts revised 6.2.2 ❹ in the reducer, ahead of every mutation (S9-17); and the Level Playing Field gains T-02's seventh board tile, the printed straight `#9@0` at **M-11** (#1622, S9-18). `RULES_ENGINE_VERSION` deliberately NOT bumped — Stage 8's precedent: implementation slices stay on the pin and Stage 9 takes ONE deliberate bump at closure, once S9-19's re-pins are known and can be reconciled with these. **Stage-9 bump is now OWED.** | **Measured against the baseline audit commit `d837419` across ALL 18 current corpus files — 18/18** (3 goldens + 8 `server/data` + 5 `sandbox-log-*` exports + the FCJ-96 prefix + the Z6C-494 fixture; the same set Stage 8.5 used) under `DEVELOPMENT_CORPUS_POLICY`. **Identical stored / applied / dropped / unparseable counts in all 18, and EVERY DYNAMIC STATE FIELD IDENTICAL at every entry and at the end — zero state divergences observed anywhere.** `map_grid` is a separate object and is **never byte-identical on a Level Playing Field log**: the printed M-11 straight is in the INITIAL grid, so the board differs from index 0 — a static/setup difference, not a gameplay one. **Exactly one stored action changes acceptance in the whole corpus**, in one room appearing in two files: **JUNO-Z6C idx 227** (`#8@0` at M-11, no `token_cities`) — ACCEPTED at baseline, **REFUSED** under 9.2, because T-02 prints yellow track on that hex so the lay repeats the colour tier and drops printed edge 3. Its state before and after is identical on both sides (M-11 is Plain, so a $0 refusal leaves no trace); the boards never converge. `server/JUNO-FCJ` idx 159 (`#9@0` at M-11) was already refused by `operatingIdentityRefusal` and still is — **no change**. F-1, F-2 and S9-17 are **measured corpus-neutral**. **RE-PINNED (2, both explained):** `replayGolden` fixtures `JUNO-CV4.json` and `JUNO-G6J.json`, each +1 grid entry (the printed M-11 tile) and nothing else — pure insertion, 14 lines, zero deletions — reason *"S9-18 — restore printed LPF M-11 straight from T-02"*. `JUNO-7NZ.json` untouched. **All raw logs byte-unchanged.** The focused Stage-9.2 gate is green |
| 6 (owed until Stage-9 closure) | **9.3** (uncommitted) | **Tile separation, physical supply and canonical identity.** `TileCatalogEntry.separateSystems` (#1628) carries revised 6.2.2 ❹'s separation clause as **tile metadata**, on old **#59** alone; `priorTopologyAt` rotates its `cityGroups` onto `HexTopology.separateSystems`, and `separationPreserved` is **rule 5b** of `filterSandboxPlacements` — the first rule in that file to compare CONNECTIVITY (union-find over the destination's rotated `paths`) rather than segments, and a no-op for every prior that names no systems (S9-19). `tileTrayPlus.RECOUNTED` corrects #63's PHYSICAL supply `1 → 4` ahead of every scenario removal (#1629, S9-15). `TileCatalogEntry.canonicalId` on the live catalog (#1630) gives the three tiles whose printed old NUMBERS the errata voids their canonical rules/display identity — `#8861` / `oo13` / `oo14` — read through `canonicalTileName` by three real production consumers (the Activity Log sentence `actionLog.describeGameplayAction`, the hex-finished message `hexGeometry.evaluateHexForTileLaying`, and the tile-picker tooltip), while the integers stay the **stable storage / ABI key** and are deprecated only as **rules identifiers** (S9-21). **Newly written state still serializes `tile_id: 626 / 36 / 35`** — that is the compatibility, not a leak. Display remainder in three owner-dirty files filed as **U-38**. `RULES_ENGINE_VERSION` deliberately NOT bumped, and **this slice does not force one** — see the corpus column. **Stage-9 bump remains OWED at Stage-9 closure.** | **Measured against `fdc4b9a` (HEAD) across ALL 18 corpus files — 18/18**, same assembly as 9.2, under `DEVELOPMENT_CORPUS_POLICY`. **Identical applied / dropped / unparseable counts, identical state digest at EVERY entry, identical `map_grid` at every entry, identical verdict on every one of the 334 replayed `LayTile` actions (3,131 observed entries in all), identical final state, identical final state field digests, identical final board — in all 18 files. ZERO divergence of any kind.** The three transitions S9-19 was predicted to make refusal-added (**JUNO-FCJ 640**, **JUNO-FCJ 1047**, **JUNO-Z6C 399**) are refused by the 9.3 predicate — pinned directly by reconstructing each source configuration — but in live replay they never reach it: `operatingIdentityRefusal` refuses each **upstream and identically at baseline** (FCJ 555/640/988/1047, wrong round; Z6C 378/399, wrong corporation), so the #59 never lands on E5 or E11 and the destination hexes are bare. §14b's adjudication of the STORED ACTIONS stands; its predicted replay consequence does not materialise. **NO log re-pinned, NO golden re-pinned, `replayGolden` green, no version bump forced.** S9-15 is corpus-neutral as predicted (tray never exhausted); S9-21 changes no persisted representation at all — the storage keys are untouched and new state serializes them exactly as before. **All raw logs byte-unchanged.** |

| **7** | **9.4a–9.5 + closure** (`4704f6e`, `677ed0e`, `53f34b0`, `69f4275`, `67a3123`, + this pass) | **The bump, and the rules that earned it.** 9.4a Blood Price arrival stamping (S9-11); 9.4b the D&H free station judged by the D&H's own conditions at both locks, a refusal no longer consuming the power (S9-12); 9.4c the chart stepping once per PHYSICAL CERTIFICATE (S9-13); 9.4d the Yellow Sign's outcome DERIVED by the authoritative reducer and the turn's draw and turn key supplied by the SERVER at ingress, with the playtest waiver dropped there and refused by the reducer on any pinned board (S9-1); 9.5 the five-physical-certificate Bank Pool cap (S9-8), the C&SL as a bonus lay with no upgrade right (S9-6), the Mark nullifying only the vanished train's run (S9-3), and the corrected Carcosa lifecycle — exemption coextensive with the gilding, doom trigger on whichever of the gift and the first REAL Diesel lands second, gift model from the depot, synthetic provenance following a Blood Price while the gilding burns off (S9-2). **Closure:** `RULES_ENGINE_VERSION` **6 → 7**, `SUPPORTED_RULES_ENGINE_VERSIONS` derived `[7]`, changelog row 7, `stage9Closure.test.ts` (8 cases), and `stage85Closure`'s three literal-6 pins narrowed to prefix/derived pins so a Stage-8 case no longer owns the current version. | **The canonical 18/18 was measured at `dea5489`, NOT at the tip** — see the closure banner in the Stage 9 section for the table, the four divergence families and the four special items. **Stage 9.5 followed and was measured separately by targeted presence checks across all 18: S9-8 15 `SellStock` entries / zero divergent sites / the double never in a pool; S9-2 zero gifts, fogs, Blood Price transfers, ghost or carcosan observations, and no real Diesel anywhere.** Both absent, so 9.5 is corpus-neutral and the earlier reconciliation still applies. The one permanent gameplay divergence in the whole stage is **`export/JUNO-3XD` entry 115** (S9-12): refused on both sides because NNH is unfloated, but the baseline consumed `used_private_abilities: ["dh-token"]` while refusing and Stage 9 does not. **No golden repinned at closure**; `replayGolden` / `replayJunoCV4` / `replayJuno3XD` green. **All raw logs byte-unchanged.** |
| 7 (owed: **8** at Stage-10 closure) | **10.1** (uncommitted, 2026-09-22) | **`LayTile` authority unification (S10-26, S10-25, LayTile half of S10-4; #1681–#1683).** One `LayTile` composition — the four holds, then identity ▸ geometry ▸ station anchoring ▸ JK ▸ terrain — asked by the reducer's gate block ahead of the arm and the cursor, by both tile grids on the lay's snapshot, and by the live ingress (`turnRefusal`, with the providers' geometry). An unaffordable or ineligible lay now returns the board by identity with the cursor, the power and the JK where they stood, and lands on no grid. No rule moved; where each is asked did. `RULES_ENGINE_VERSION` stays **7**; the owner's ruling records a **provisional closure bump 7 → 8** for Stage 10 because supported live authority changed. | **Canonical 18/18 measured, old (`server/dist` built from HEAD) vs new (a scratch build): 334 stored `LayTile` entries, 134 applied / 200 refused on BOTH sides, 0 decision differences, every final state digest, grid and cursor identical.** No golden, fixture or log touched. **10.1b (#1684):** `layTimingRefusal` — a `LayTile` off the Lay Track step is refused on a PINNED board; the 68 off-step lays the legacy corpus carries (CV4 106 …, Z6C 109 …, FCJ 94/172 — legal lays from the pre-#1440 `BuyPrivate`-opening turn) keep the arm they were played on, so the measurement stands unchanged: 334 / 134 / 200 / 0 on both sides. |

Items above that carry "bump" must add a row here when they land. No golden or replay expectation is ever
re-pinned silently: the re-pin, its index and its reason go in the batch write-up and in this table.

---

## Part F — Order of work

Stages run in the canonical order: **6 → 7 → 8 → 9 → 10**, with Stage 5.5's cleanup landing first. Within a
stage, the audit's own priority holds: the one-line refusals with outsized integrity value first (S7-1, S6-2),
then the identity/legality gates (S6-5…S6-8, S7-7, S7-8), then the large validator move (S6-1 with S6-4), the
auction rewrite as one function (S7-2…S7-4), the Stage-8 ordering repairs (S8-1 → S8-4) before the timing rulings
(S8-5 … S8-10), and the variant rulings (S9-3, S9-4, S9-6) before variant authority (S9-1, S9-2). Stage 10's
settlement items follow `MIGRATION_PLAN.md` #1254 (2.5b → 2.5d → 2.5g → 3a → 3b → 3c → 4). UI/polish items in
Part C run in parallel and never gate a stage. The owner's roadmap governs; this paragraph is a recommendation
inside it.

**Playtest Readiness gate (owner, 2026-09-15).** Before substantive playtesting resumes, every authoritative rule
introduced or changed during Batches 1–10 must either have a correct normal UI path/representation or a resolved
Part C item. A legal ordinary action must not require crafted messages, and common illegal actions should not be
presented as apparently legal where the client can determine legality. Every Part C UI-parity item (U-19 … U-28
and every successor filed under the UI-parity standing rule, U-28's retrospective audit included) must be
**fixed, verified obsolete, or explicitly adjudicated by the owner** — never merely deferred to a final polish pass.
Part C is the one UI backlog: no batch report substitutes for it and no second competing list is kept. A batch
that resolves an engine item without filing its UI-parity classification has not finished.
