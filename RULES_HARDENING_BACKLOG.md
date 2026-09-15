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
| 7 | Transaction + cash authority / auction | Part B |
| 8 | Stock / OR edge cases + timing | Part B |
| 9 | Variants + map data + variant authority | Part B |
| 10 | Replay / settlement / release hardening | Part B |

UI/polish-only items are **not** forced into a numbered stage; they live in Part C (the UX backlog).

**Rulebook authority.** `en_1830re.html_Rules_1830-RE_EN.pdf` (Lookout Spiele, 2018 — the owner's local copy;
identical file at `lookout-spiele.de/upload/en_1830re.html_Rules_1830-RE_EN.pdf`). Section numbers are the
rulebook's. Owner-defined variants (Level Playing Field, Project 18XX+, Delayed Auction, Gentle Rust,
Unpredictable Revenue / Yellow Sign) have no rulebook counterpart and are judged against the owner's spec.

**Replay / version boundary.** `RULES_ENGINE_VERSION` (`frontend/src/gameEngine/rulesVersion.ts`, #1520) is
**4** in the Batch 6 working tree (1 = post-Batch-4 semantics, 2 = Batch 4.6, 3 = Batch 5, 4 = Batch 6). Since
Batch 6 the pin is also copied onto the state (`rules_engine_version`, #1551) so the reducer can tell a pinned
board from a legacy one. Any item below that
changes what a stored gameplay log *replays to* must bump it and add a `RULES_ENGINE_CHANGELOG` line; UI,
protocol-shape and narration changes do not. `DEVELOPMENT_CORPUS_POLICY` (`legacyLogs: "development-corpus"`,
`legacyExcessTrains: "engine-chose-cheapest"`) is a best-effort development-corpus mechanism only and is never a
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

**S7-1. Zero floors act as implicit refusals: `adjustCash`, `adjustBank`, `adjustTreasury` clamp at 0.**
Status `OPEN` — audit **C3** (architectural risk 3). Rulebook: cash required for every purchase (§5.2 implicit,
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
Status `OPEN` — audit **C5**. Rulebook §1.2.3: only the **SV** is marked down, only while unsold; revenue is paid
only once the SV has sold, with no markdown. Notes: `applySandboxWaterfallAction` `WaterfallPass` branch
(`is_lowest_offered`, `WATERFALL_PASS_MARKDOWN`), #271, #337, #1281 (`RoomEngine` pays the all-pass income),
#1340 (auction atom in the reducer). Replay: **replay-semantic** (prices and cash differ in any log with a
post-SV all-pass) — bump; sweep and report. Detail: mark down only when the lowest offered is the SV (or the
lowest printed face of the roster in effect — LPF has a different roster); pay revenue only when the SV has an
owner; m12 (revenue on an all-pass with SV unsold) disappears with it. Delayed Auction (owner variant, #905)
must be re-checked: its auction runs after the OR set of the first 3-train.

**S7-3. Mini-auction pass removes the bidder permanently.**
Status `OPEN` — audit **M1**. Rulebook §1.2.2 ("may pass and still bid later"). Notes: `WaterfallMiniAuctionPass`;
`miniAuctionTurn.test.ts` pins the current behaviour. Replay: replay-semantic — bump. Detail: passes do not
remove bidders; track consecutive passes since the last raise; the auction ends when they reach
`bidders.length − 1`. Tests: A raise, B pass, C raise, B raise accepted; A raise, B pass, C pass → A wins.

**S7-4. Bidding gaps: a bid on the lowest-offered private is accepted; bids are not escrow-aware; the mini-auction raise has no $5 minimum.**
Status `OPEN` — audit **M2** + matrix rows. Rulebook §1.2 (3), §1.2.1, §1.2.2. Notes: `WaterfallBidHigher`,
`WaterfallMiniAuctionRaise`, `auctionEscrow.ts` (`minimumBidFor` — reducer-enforced since #1184;
`availableCash` — UI arithmetic today). Replay: refusal-added — bump after a sweep. Detail: refuse a bid on
`is_lowest_offered`; refuse when `amount − ownStandingBid > availableCash`; refuse a raise below high bid + $5;
whole dollars (schema already requires integers).

**S7-5. Inter-corporate train sale: buyer must be operating at Buy Trains; price ≥ $1; treasury covers the price.**
Status `OPEN` — audit **M14** (buyer limit closed by Stage 4). Rulebook §6.6. Notes: `settleTrainSale`,
`BuyTrainFromCorporation` (derived after `AnswerTrainPurchase`), #1450, Batch 4 §2, Stage 5's
`fundedTradeRefusal` (owner rule D-6) covers only the obligation case. Replay: refusal-added — bump after a
sweep (JUNO-FCJ idx 468/768/784 are $1–$10 trades; confirm they pass). Detail: refuse unless
`buyer === operatingCorporationId(state)` at Hardware, `price ≥ 1`, treasury ≥ price; then the offer/answer
authority (S7-8).

**S7-6. Ordinary `BuyPrivateCompany` checks only "not the B&O" and "not already this corporation's".**
Status `OPEN` — audit **M13**; Stage 5 built the pieces (`privatePriceBand.ts`: `privatePriceBounds`,
`privatePurchasePhaseOpen`) and applied them to the *emergency* sale only. Rulebook §3.0 (phases 3–4, during the
corporation's turn), §3.1 (½–2× face, declared price), "bought by railroads but not sold by them". Notes:
`BuyPrivateCompany` arm (~4745), `transferPrivateToCorporation` (#1541), `ProposePrivatePurchase` /
`AnswerPrivatePurchase`, S7-7. Replay: refusal-added — sweep; bump. Detail: refuse unless phase ∈ {3, 4}, price
within the band, buyer is the operating corporation (S7-7), seller is a **player** (the arm accepts
`owner_protocol_id` of another corporation), treasury ≥ price; reuse `fundingPrivateSaleRefusal`'s shape.

**S7-7. `BuyPrivateCompany.protocol_id` has no operating-corporation check.**
Status `OPEN`. Rulebook §3.0 ("during its turn in an operating round"). Notes: Batch 3 §3 reported-not-fixed;
`operatingIdentity.ts` is the family to extend. Replay: refusal-added; bump after a sweep.

**S7-8. Pending-offer authority: `ProposePrivatePurchase` / `ProposeTrainPurchase.buyer_protocol_id` — the socket checks the buyer's president (#1450), nothing checks the buyer is the operating corporation; an ordinary offer is not revalidated at acceptance and may outlive the turn.**
Status `OPEN`. Rulebook §6.6 (during the buyer's turn), §3.0. Notes: Batch 3 §3; `turnAuthority.ts`
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
Status `OPEN` (UNCLEAR). Rulebook §3.1. Detail: confirm whether the product intends player↔player private trades;
if yes, a new message pair through the Stage-2 machinery with its own owner rule; if no, record in Part D.

### Stage 8 — Stock / OR edge cases + timing

**S8-1. The operating order is snapshotted before the end-of-Stock-Round sold-out rise.**
Status `OPEN` (confirmed bug). Rulebook §6.0 (order by share value at the start of the OR), §4.5 (sold-out rise
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

**S8-2. Presidency tie among equal challengers is decided by `player_holdings` order, not clockwise from the incumbent.**
Status `OPEN`. Rulebook §5.4. Notes: audit M10; `gameEngine/presidencyTransfer.ts` (`presidentFor`,
strictly-more rule, `find` in seating order); `settlePresidencies` in `sandboxSession.ts`. Replay:
replay-semantic only when two challengers tie above the incumbent — bump. Detail: order challengers by seat
distance clockwise from `company.president` (the deal's roster order), pick the first with strictly more than
the incumbent; ties *with* the incumbent keep the incumbent (unchanged). Stage 5's forced-sale protection
(`forcedSaleRefusal` case c) projects `presidentFor` and inherits the fix automatically. Test: three holders at
20/20/20 after a president's sale with the incumbent at 10 — the clockwise-next seat takes it. Audit test gap:
`presidencyTransfer.test.ts` has no tie-order case.

**S8-3. Operating order is fixed at OR open; §6.1's note (a not-yet-operated railroad whose share value changes uses the new value) is not applied mid-round.**
Status `DEFERRED`. Rulebook §6.1 note. Notes: audit m2; `active_operating_order` /
`active_corporation_index`. Replay: replay-semantic — bump. Detail: decide whether the queue is re-derived for
the not-yet-operated tail after each price movement (dividend step, forced sale during an OR). Interacts with
S8-1 (same code), with the discard queue (#1530, which relies on no price moving while pending — still true),
and with the market-token "operated stack" drawing (#1296), which derives "operated" from the index.

**S8-4. Sold-out rise iterates `public_companies` in company order; §4.5 says highest-priced token first.**
Status `OPEN` (test gap; outcome differs only when two risers meet in one cell). Rulebook §4.5. Notes: audit m3;
`soldOutRise.ts` (`roundEndSoldOutRises`). Replay: replay-semantic only when two risers land in one cell — bump.
Detail: sort risers by current price desc (then §6.0 tie-break) before moving; pin with a two-riser test
(`soldOutRise.test.ts` covers one riser only).

**S8-5. Home token is placed at float during the Stock Round, not at the start of the corporation's first operating turn.**
Status `DEFERRED` — needs an owner ruling (keep as a documented house rule, or move). Rulebook §6.3.1;
§6.3.2 ("may not block the home station of a railroad that has not yet operated"). Notes: audit M15; #769
`pendingHomeTokens`, `homeTokenBlock`, `homeReservationStands` (UI side), `placeHomeStationToken`. Batch 3 §2
proved the FCJ idx-95 fix does not depend on timing. Replay: moving the obligation is replay-semantic (every
stored log carries `PlaceHomeStation` during the SR) — bump; keeping it is a documentation change.
Detail if moved: the obligation becomes "first message of the corporation's first OR turn" (`openingSubPhase`
gate), Erie's slot choice moves with it, and blocking through the home city can no longer happen one OR-turn
early. Delayed-Auction and herald-home (#1302) paths must be re-checked with whichever choice is made.

**S8-6. `PlaceHomeStation` hex and circle are not validated in the reducer.**
Status `OPEN` (independent of S8-5; can be done first). Rulebook §6.3.1. Notes: Batch 3 §3; `sandboxSession.ts`
`placeHomeStationToken` accepts any hex for a single-home corporation ("keeps replaying to wherever it
recorded") and does not check the circle against occupancy / #858's lock; `homeReservedCityIndex` (#1511) is the
reader to reuse; validate against `home_hex_label`. Replay: refusal-only on hand-crafted messages; sweep before
claiming the corpus contains no wrong-hex placement — bump anyway if any stored entry would now be refused.

**S8-7. No "no sales in the first Stock Round" rule in the reducer.**
Status `OPEN` — audit **M7**. Rulebook §5.1. Notes: `shareSaleBlock` (`shareSale.ts`), `SellStock` arm; the
Rules Reference already shows the ban only when `roundLabel` parses as SR1. Replay: refusal-added; bump.
Detail: refuse when `macro_round_number === 1 && current_round_type === "StockRound"`; Delayed-Auction tables:
refuse only the first SR, not the SR after the auction. Stage 5's forced sale cannot occur in SR1 (no OR yet).

**S8-8. Shares of an unparred corporation (C&A's PRR 10%, M&H's NYC 10% before a president) can be sold, priced at the $67 nominal fallback.**
Status `OPEN` — audit **M8**. Rulebook p.15 (cannot be sold until the president's certificate is bought).
Notes: `applySandboxMarketAction` `priceOf` fallback (`SANDBOX_NOMINAL_SHARE_PRICE`), `shareSaleBlock`. Stage 5's
`sharePriceFor` uses the same `?? 67` fallback for legal-sale projection — a forced sale of an unparred share is
therefore projectable today (refused only once this lands; note it in the emergency tests). Replay:
refusal-added; bump. Detail: refuse a sale when `par_value` is null; `priceOf` must not fall back on a sale.

**S8-9. Par value from the message is not validated against the ladder; an IPO buy on an unparred corporation is silently converted to the president's purchase.**
Status `OPEN` — audit m8. Rulebook §4.2 / §5.2 (67/71/76/82/90/100). Notes: `BuyStock.par_value`,
`ctx.parValue ?? 67`, `PAR_VALUE_LADDER` (`marketGeometry.ts`). Replay: refusal-added; bump. Detail: refuse
`par_value ∉ PAR_VALUE_LADDER`; require it on a president's purchase.

**S8-10. M&H exchange always takes the IPO share before the pool.**
Status `OPEN` — audit m6. Rulebook p.11 ("from the bank or the pool"). Notes: `resolvePrivateExchange`,
`ExchangePrivate` arm. Replay: replay-semantic if a `source` is added (default must reproduce today's choice) —
bump. Detail: add `source: "ipo" | "pool"` to `ExchangePrivate`; default IPO for legacy entries.

**S8-11. Timing notes, not defects (recorded so they are not re-audited):** m4 float capitalisation is paid on the
purchase that crosses 60 % rather than at the end of the SR (harmless — treasury unspendable before the OR);
m5 divestment debt blocks buying and passing until sold down (stricter than §4.3's "during your next turn" but
not incorrect); m11 bank floor after the break. Status `OWNER DECISION` pending only if the owner wants
rulebook-literal timing; otherwise leave.

### Stage 9 — Variants + map data + variant authority

**S9-1. `YellowSignEvent` is client-authoritative.**
Status `OPEN` — **HIGH PRIORITY** (Stage 2 commit message; `messageSchema.ts` #1451 records it as deferred).
Notes: #1046, `App.tsx` computes the outcome and submits it; `gameEngine/yellowSign.ts` (`fogIsDue`), the
`YellowSignEvent` arm (~4928), stage "fog" removes a train, applies the Mark, arms Carcosa and the blood price.
Replay: making the server derive it is a redesign of the Unpredictable Revenue pipeline — replay-semantic for
Yellow-Sign rooms only; bump. Detail: any player, on their turn, can hand-submit an event naming any corporation;
it is schema-validated and nothing more. The server must derive the event from the log (seeded randomness or a
committed roll) and refuse a client-supplied one, or the variant must be excluded from authoritative rooms.

**S9-2. The Yellow-Sign ghost-train expiry keeps its own automatic round-boundary trim.**
Status `DEFERRED` (variant ruling). Notes: Batch 4.6 §2 ("out of scope, Part 7"); `expireGhostTrains` (#1046)
in `sandboxSession.ts` (~954, ~3095). Detail: decide whether a ghost expiry that leaves a corporation over the
limit should become a `DiscardTrain` obligation (#1530) like every other discard; replay-semantic for
Yellow-Sign rooms — bump.

**S9-3. Yellow Sign "Mark" ruling — the corporation's other trains' legal runs are zeroed (migrated from TRIAGE_2026-09-05 item 22b).**
Status `OWNER DECISION` owed (spec question, not a bug). Notes: `sandboxSession.ts` `stage === "mark"` (~4974)
carries the ruling verbatim: the corporation "loses its lowest value train. It receives no standard route revenue
for this submission. Instead, award the corporation cash equal to 0.5× the deleted train's depot value" — it
zeroes `last_route_revenue` *and* `printed_route_revenue` (deliberately, #934/#941 double-payment guard). The
playtest feedback wanted the *other* train's legal run still to pay, with the 0.5× covering only the taken train.
Both are coherent; they are different rules. Replay: changing it is replay-semantic for Yellow-Sign rooms —
bump. Detail: owner rules which; if changed, the arm keeps the other routes' revenue and the guard against
paying the same routes twice must be re-derived per train, not per turn.

**S9-4. The "1830+" board implemented is the owner's Project 18XX+ spec, not the rulebook's 1830+ (p.25).**
Status `OWNER DECISION` needed (audit M16). Notes: #1300 / #1301 (`hexBoardDataPlus.ts`, "REQUESTED, verbatim"),
`tileTrayPlus.ts`. Differences: H12 printed green #24 (rulebook: green 23, PRR home anywhere on the hex);
Montréal one station (rulebook: double circle); no D24 preprinted 29; no E5 Detroit exit; B20 double town ✓.
Detail: either label the board "Project 18XX+" everywhere (Game Type drop-down #1271 already says 18XX+) and
record it here as the intended authority, or implement the p.25 board as a separate variant. No replay effect
from the labelling choice.

**S9-5. Level Playing Field is owner-defined (7 seats, N&W / PMQ, JK + Coalfields licence, 20 % double certificate, 7-trains, $750 Diesel exchange, herald home).**
Status `OWNER DECISION` (recorded; audit N "PASS vs owner spec"). Notes: `gameVariants.ts`,
`levelPlayingField.ts`, `doubleCertificate.ts`, `kanawhaLicense.ts`, `hexBoardDataLpf.ts` (`COAL_RIVER_EDGES`),
#1323 Coal River bar, #1276 / #1298 / #1299 licence, #1286 warehouses. Open sub-items: S9-8 (pool cap in
certificates); the seventh seat colour (#1344 done; `seatColor.test.ts` contrast/livery question flagged, U-8);
S6-4; LPF-specific route rules (warehouses as termini, `routeConnection` / `assignRouteSet`, decision 21a of
2026-09-08) to be carried into S6-1.

**S9-6. CS power treated as forfeited when another corporation tiles B20; the rulebook states that lapse for the DH only.**
Status `OPEN` (UNCLEAR). Rulebook p.11. Notes: audit m10; `cslPowerState`, `bonusLay.ts`. Detail: rulebook does
not say whether the CS exception survives as an upgrade right; owner ruling, then record in Part D.

**S9-7. Gentle Rust / Unpredictable Revenue / Delayed Auction — owner-defined, gated on their flags, not audited for correctness.**
Status `DEFERRED` (audit "UNCLEAR"). Notes: `gentleRust*`, `variantRules.test.ts`, #905 (delayed auction,
`boIsLocked`), #1034 (reprieved trains exempt from limits — respected by #1530). Detail: audit each against its
own spec once the standard game is closed; S7-2 and S8-7 both name Delayed-Auction cases.

**S9-8. Bank Pool cap is 50 % rather than "5 certificates" — differs only under LPF's 20 % double certificate.**
Status `OPEN` (LPF-only). Rulebook §5.1 / §4.3. Notes: audit m7; `BANK_POOL_CAP_PERCENT`; `doubleCertificate.ts`.
Detail: count certificates, not percent, when the variant carries a double certificate. Replay: LPF logs only —
bump.

**S9-9. The board / tile / chart cluster (14 modules, ~7,100 lines) lives in `components/` and the engine imports it upward; four `SandboxActionContext` injections are now unjustified.**
Status `DEFERRED` (map-data architecture; do with the legality batch, S6-5…S6-8). Notes: Batch 1 §6a; #273
(`utils/` may not import `components/`); #1501 retired the justification for `projectRise`, `marketZoneFor`,
`zoneForPrice`, `parCellFor` (and `homeHexToAxial` was already redundant; `marketGeometry.ts` #26 says so);
`layRefused` stays justified until `sandboxTileLegality.ts` moves; `evaluateStationPlacement` already imports
`homeSlotIndex` / `stationMarkerPoint` from `components/hexCanvasPrimitives.ts` (Batch 3 §7). Replay: none if
the move is pure; **collapsing an injection changes what happens when a caller omits it** (a missing injection
today means *no rule*), so do it with tests that assert the reducer answers the rule with no context at all.
Destination `frontend/src/gameEngine/board/`.

### Stage 10 — Replay / settlement / release hardening

**S10-1. Refusal transport.** A reducer refusal is an identity no-op that `RoomSession.submit` still answers
`applied` and appends (replays as a no-op); the ingress holds (#1530 / #1540) and, since Batch 6, the route,
dividend-amount and Run-Trains-skip refusals (#1550) answer `refused` with a reason (the shell shows it in the
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
through `replayLog`, assert the bank paid) is still owed. `OPEN`.

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
(S8-9), `PlaceHomeStation` hex (S8-6), `RunMultipleRoutes` paths (S6-1 — judged since Batch 6; `trains` is
checked against the fleet slot, `revenue_seed` / `revenue_turn` remain message-carried by design, #1051 /
#1183). Cross-reference only.

**S10-18. Test gaps from the audit still without a machine-level test:** sold-out rise order (S8-4), first-SR sale
refusal (S8-7), presidency tie (S8-2), auction escrow at the reducer (S7-4), terrain-fee-once for the
upgrade-of-preprinted case, all-pass private income through `replayLog` (S10-4). Cross-reference.

**S10-19. August 2026 audits (`AUDIT_PART1_BACKEND.md`, `AUDIT_PART2_FRONTEND.md`).** Their actionable items
were either fixed then (code cites "Audit G-5/G-9/G-11/G-12/G-15", "F-3", `config.ts` env for F-4,
`SELL_PERCENTAGE_OPTIONS` to 50 % for F-6) or belong to the Rust crate that Phase 4 retires (G-1/G-2/G-3
valuation moves to the server's appraisal; G-5 on-chain tile inventory is moot). Before Phase 4, confirm which
Part-1 items concern `escrow.rs` / `contract.rs` (which stay on chain) and carry them into the 3a contract
revision. `DEFERRED` (Phase 4 pre-check).

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

---

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

**D-10. Owner-defined variants have no rulebook counterpart and are judged against their own specs:** Level Playing Field (S9-5), Project 18XX+ (S9-4 — decision still owed on labelling vs the p.25 board), Delayed Auction (#905), Gentle Rust (#1034), Unpredictable Revenue / Yellow Sign (#1046), short/long banks, 7-player LPF. `OWNER DECISION` (standing).

**D-11. Auto-Pass presidency guard is a toggle, on by default; off, a tied presidency rides.** #1335 (T05 20 ruling). `OWNER DECISION` (UX rule).

**D-12. Settlement / money decisions (DECISIONS_2026-09-06, resolved same day):** operator-trusted settlement; session keys sign every move; no unilateral exit after the deal, 14-day liveness; consent fast path; bonded challenge; every game has an on-chain ante (no free-game path); forfeit pays zero. Outside rules hardening; listed so D-1 has its source and so nobody re-opens A7. Specified in `MIGRATION_PLAN.md` #1254.

**D-13. Auto-skip granularity: the log stays granular (one derived entry per skipped sub-phase) and the transport emits at settle points; the client suppresses intermediate frames.** Decided 7 September (UI_ACTION_PLAN "Not in this plan": "granular log, settle-point emission… re-observe, do not patch"; TRIAGE_2026-09-05 item 6; PLAYTEST_TRANSPORT check 1). The wire format is therefore frozen on per-step derived entries. `OWNER DECISION` (log format). If flicker is re-observed it is a shell frame-suppression bug, not a log change.

**D-14. Under Unpredictable Revenue, "Last Run" reports the variant-adjusted figure, not the printed route value** (#903; `printed_route_revenue` accumulates within a turn, #968). TRIAGE_2026-09-05 item 24 — answered by the headless replay (MIGRATION_PLAN "Item 24 — answered", #1195): not corruption; three correct behaviours compounding. `RESOLVED`; recorded so the card's figure is not reported as a desync again.

---

## Part E — Replay / version ledger (what a rebuilt room can differ by)

| Version | Stage | What changed in replay meaning | Known corpus consequences |
|---|---|---|---|
| (pre-pin, "legacy") | ≤ 4 | Stage 3 identity gate; Stage 4 pool destination; #1183/#1184 (one run per turn, bid minimum) | JUNO-3XD idx 224 refused (PRR run 210 → 170, re-pinned with reason); JUNO-3XD idx 255 `returned_trains` `["3"]`; JUNO-FCJ diverges from idx 95 (illegal token refused) — prefix-96 frozen as a fixture |
| 1 | 4.5 | pin only; semantics = post-Stage-4 | all 16 legacy logs refused by default; identical under the corpus policy |
| 2 | 4.6 | president's `DiscardTrain` replaces the automatic trim; limit-in-force at depot gates; §6.0 row key | JUNO-FCJ idx 474 (C&O's first 5 now allowed, then a discard); 3XD idx 255 supplied by the adapter; row key changes nothing observed |
| 3 | 5 (`78f8358`) | derived forced-purchase obligation, forced sales, funding offers, bankruptcy → `GameEnd`, holds, D-5 / D-6 | JUNO-Z6C from idx 614 (`PassTurn` on an ended board now held); historical `EmergencyBuyHardware` entries (FCJ ×3, Z6C ×3) identical |
| 4 | 6 (uncommitted) | route legality and revenue judged by `routeAuthority.ts`; a town is a terminus (S6-10 ruling, #1555); a run short of the search's demonstrated combination is refused (S6-3 ruling, #1556); one run per turn; dividend amount must equal the run (C1); Run Trains not skippable past a paying route (pinned boards); `RunManualRoute` refused on pinned boards; pin copied onto the state; #1183 key relocated to the state | 14 / 17 logs gameplay-identical to version 3 (every digest changes where a run occurred: the #1183 key moved from the corporation to the state — CV4 golden re-baselined for that alone). **JUNO-CV4 from 98** (S6-3: B&O with three 2-trains ran two of them, $90; the search demonstrates $130 — I15–J14 $50, I15–I17–I19 $40, J14–K13 $40 — so the run is refused, 99's $90 declaration mismatches, and the CV4 golden fixture is re-baselined for it; `replayJunoCV4.test.ts` unaffected). **JUNO-Z6C from 140** (S6-3: B&O ran three of four trains, $160 vs $220; also 172 C&O $70 vs $80 — the search adds the Akron & Canton town terminus G7–F6–G5–G3–F2, an S6-10 consequence; 396 N&W $340 vs $350 on the already-diverged board). **JUNO-3XD from 175** (S6-3: NNH ran $240 with [2, 2, 3]; the search demonstrates $270 — the 3-train could reach Baltimore, F16–G15–H16–I17–I15 $110; the operating order of every later round then differs; `replayJuno3XD`'s filed table re-pinned PRR 260, NYC none, B&O 350, C&O 220, NNH 90 with the reason; the idx-255 discard the Batch-4.6 adapter used to supply no longer falls due in the log-derived game, `trainDiscard.test.ts` re-pinned with the reason). **JUNO-FCJ from 74** (S6-10: B&M, trainless, passed at Buy Trains with a town-ended route E23–F24 that is now a legal route, so the Batch-4 forced purchase is owed and the pass is refused; before the ruling the first difference was **230**: B&M's second route touches no B&M station on the log-derived board — the idx-95 token Batch 3 refused; every later B&M dividend then mismatches; cascade). **JUNO-Z6C from 418** (NYC declared $180 on a $190 run; 428 PMQ $290 / $300; 433 NNH $250 / $270 — refused as C1 mismatches; treasuries differ, the bank no longer breaks at 613; `gameHistory.test.ts` relaxed from "reaches OR 9.1"). **JUNO-3XD from 260** (PRR's run names a 4-train in slot 1 that the log-derived fleet [3, 3] does not hold — a Stage-3 queue divergence now refused rather than priced; 307 the same; the OR-7 order then swaps and B&O's 313 is identity-refused; 319 NNH's duplicate run is refused by the one-run rule and 320's $540 by C1 — `replayJuno3XD` re-pinned PRR 170 → 260, B&O 240 → 270, NNH 540 → 340 with reasons) |

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
