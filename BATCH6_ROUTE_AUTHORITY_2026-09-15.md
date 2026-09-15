# Batch 6 — Authoritative routes and revenue

Date: 2026-09-15. Design notes **#1550** (route authority), **#1551** (the pin on the state; `RunManualRoute`
retired), **#1552** (dividend amount), **#1553** (route shape at the door), **#1554** (the PRR $60 → $30 defect), **#1555** (towns are termini — S6-10 ruling), **#1556** (the highest-revenue combination as a demonstrated
lower bound — S6-3 ruling).
Baseline (post-Batch-5.5, owner-validated, `b4f6d38`): 354 suites / 5495 tests. Not committed: awaiting the
full-suite result.

> **`RULES_ENGINE_VERSION` 3 → 4.** Version 4 makes `RunMultipleRoutes` a judged action: the engine's route
> evaluator (`gameEngine/routeAuthority.ts`) re-walks every submitted route on the board's own rail model and
> refuses anything rulebook §6.4 / §6.4.1 / §6.4.2 / §6.3.3 forbid; revenue is the evaluator's figure, never the
> message's; one run per turn; `DeclareDividends.revenue_amount` must equal what the trains ran (audit C1); at Run
> Trains a skip or end of turn is refused while a paying route exists; `RunManualRoute` is refused on a pinned
> board. A version-3 log is refused before replay.
>
> **S6-10, ruled (owner, 2026-09-15): follow the rulebook — towns are termini (#1555).** §6.4: "'city' refers to a
> large city, a small city, or an off-board red hex"; §6.4.2: a route "may begin or end at any city". The game's
> older `SingleCity || DoubleCity` reading (tracer note #3, `routeDraftEdit` #264, #1286's "unlike small towns")
> is withdrawn. The correction is one predicate, `isRouteTerminusHex` (now: any revenue centre), read by the
> route authority, the auto-tracer, `hasLegalRouteFor` (Batch-4/5 forced purchase), `maxRouteRevenueFor`
> (auto-skip, skip refusal), the draft editor and the shell's `endsOffTerminus` — so preview, search and authority
> agree by construction. Warehouses remain termini under the LPF rule (the #1286 half that stands).
>
> **S6-3, ruled (owner, 2026-09-15): the highest-revenue combination is enforced as a demonstrated lower bound
> (#1556).** After a submitted set is judged legal and priced, the deterministic route search
> (`maxRouteRevenueFor` → `assignRouteSet`, same fleet, same blocking / licence / herald, same era) demonstrates a
> concrete legal combination; a set worth less is refused — "Route set earns $40; a legal combination worth $60 is
> available." — and a set worth as much or more is accepted however the bounded search missed it. The machine
> plays the rulebook's demonstrating opponent; the heuristic is never a ceiling. The auto-tracer offers that same
> set, so a normal client never meets the refusal.

## 1. Rulebook requirements matrix (1830-RE 2018, Lookout; verified before coding)

Read from Lookout's own copy of `en_1830re.html_Rules_1830-RE_EN.pdf` (§6.3.3, §6.4, §6.4.1, §6.4.2, §6.5). Each row
names the rule, the section, what the authority enforces, and where.

| # | Rule (rulebook wording, paraphrased where quoted text is long) | § | Enforced by |
|---|---|---|---|
| R1 | "Each train owned by a railroad may run once during its operating turn"; "trains may not be combined or double headed" | 6.4 / 6.4.2 | `evaluateRouteSet`: each named slot once; routes ≤ trains; one `RunMultipleRoutes` per turn (`routes_run_this_turn`) |
| R2 | The train's number "represents the maximum number of cities that the train may have on its route"; a Diesel "has no limit" | 6.4.1 | `centres ≤ trainCapacityFor(slot model)`; `isUnlimitedReach` for D |
| R3 | "'city' refers to a large city, a small city, or an off-board red hex" — towns count against the number | 6.4.1 | `sandboxRouteBreakdown.centres` counts every non-bypassed revenue centre, towns included (test 9; the "town run through is a counted city" block: city→town→city is 3 cities for capacity, $50 for revenue, and the tracer's leash reads the same count) |
| R4 | "The number of cities on a route includes all of the cities that the route runs through or to. A route may not skip a city that it runs through." | 6.4.1 | a waypoint is counted unless its rails miss the centre (`bypass` only where `traversalsFrom` offers a bow, or the owner's herald #1302) |
| R5 | "A train may run a shorter route than the maximum … must have at least two cities" | 6.4.1 | `centres ≥ 2` |
| R6 | "A route … is a continuous segment of track that includes at least one city containing one of the railroad's stations" | 6.4.2 | adjacency + `neighbourAcross` (both sides carry rail) + `traversalsFrom` inside every interior hex; station by circle (`stationTokensOf`, `stopEnteredFrom`) |
| R7 | "A route may not reverse at a junction"; "may not change track at a crossover" | 6.4.2 | no authored rail joins entry to exit → refused (`traversalsFrom` is port-to-port; #0/#20/#24 cases tested) |
| R8 | "may not use the same section of track more than once" | 6.4.2 | segment keys (#669/#731) claimed once per route |
| R9 | "may not include the same city more than once, but it may include different cities in the same hex" | 6.4.2 | visit key `hex:stop` from `stopEnteredFrom` (#1318/#1319); other city / other town of one hex allowed (tests 12, double-town) |
| R10 | "may not pass through a red off-board area" — start / end only | 6.4.2 | `isOffboardTerminal` on an interior waypoint → refused; LPF warehouses are not terminals (#1320) |
| R11 | "may not pass through … a large city if all of its circles contain stations belonging to other railroads"; an empty circle or one's own station lets any train through; start/end there is fine | 6.3.3 / 6.4.2 | `cityBlockerFor` (#729 rules 1–3) on the circle the arrival rail enters (`cityForArrival`), interior waypoints only, non-bypass transits only |
| R12 | "none of those routes may use the same track … may meet or cross at cities, and/or use two separate tracks in the same hex" | 6.4.2 | union of segment sets across runs; cities and separate tracks of one hex share nothing in the segment model (tests 13/14) |
| R13 | Revenue "equal to the sum of the revenue values of all of the cities … on its route"; the railroad's revenue is the sum of its runs; off-board lesser/greater value by the first 5-train | 6.5 / 2.5 | `sandboxRouteBreakdown` per run, summed; `offboardValueForEra` (unchanged, S6-9) |
| R14 | Dividends pay the revenue the trains ran; "cannot claim to … pay out dividends of $0" with no revenue | 6.5 | `dividendAmountRefusal`: declared = `last_route_revenue` to the dollar; the derived $0 withhold (#1275) agrees by construction |
| R15 | "the combination of routes with the highest revenue should be chosen … if another player can demonstrate another route that earns a higher revenue, the highest revenue route must be taken" | 6.4 | `routeSkipRefusal` (a paying route may not be skipped) and `demonstratedShortfall` (#1556): a submitted set worth less than the search's concrete combination is refused with the figure; equal or better is accepted (**S6-3, ruled**) |
| R16 | A train bought this turn does not run | 6.4 note | step order (Run before Buy), unchanged |
| R17 | A route begins and ends at a city — large, small (a town) or a red area; plain track cannot be an end | 6.4 / 6.4.2 | `isRouteTerminusHex(grid, hex, company)` = any revenue centre, on both endpoints (**S6-10, ruled**; #1555) |
| R18 | Junction / crossover / "section of track" are not defined by the rulebook | — | taken as the rail model already in `trackSegments.ts`: a section is a rail end or a hex edge; a junction is where authored rails meet |

Audit wording vs rulebook: the audit's C2 summary and S6-1's Detail match the rulebook on every row above. The
one discrepancy found was R17 (towns as termini), between the rulebook and the code / #1286 — flagged, ruled,
and corrected in this batch (S6-10).

## 2. Architecture before

`RunMultipleRoutes` (`sessionKey.ts`: `routes: RouteWaypointDto[][]` — `{hex, city_node?, bypass?}` per stop;
parallel `trains[]`, `train_indices[]`; `revenue_seed`, `revenue_turn`) → `applySandboxActionCore` refused only a
Coal River crossing → the arm priced each path with `sandboxRouteBreakdown(mapGrid, path, era, protocol_id)`,
summed, applied the Unpredictable Revenue die, wrote `last_route_revenue` / `printed_route_revenue` /
`last_run_breakdown` / `routes_run_this_turn`, and `settleOperatingCursor` moved the step to Dividends. Nothing
checked that the corporation owned the trains named, that a train ran once, that the paths were connected, that a
station was on them, that a full city was not run through, or that the message's `bypass` flags described the
rails. `DeclareDividends` paid `msg.revenue_amount` (`dividendSplit.dividendRevenue`), falling back to
`last_route_revenue` only when the message carried none. The legacy `RunManualRoute` arm (one message per train,
#968 replaced it) added to `printed_route_revenue` per message with no bound and stayed reachable through the
schema and `operatingIdentity`. The #1183 one-run key was written on the corporation and read off the state — dead
(S6-11). Every legality rule lived in the shell: `runTrainsRules.ts` (`runnableDrafts` / `runTrainsRefusal`),
`routeWaypoints.ts` (token, blocked city), `routeConnection.ts`, `routeDraftEdit.ts`, `routeTruncate.ts`, the
auto-tracer (`routeAutoTrace.ts`, whose search is legal by construction). Facts from the client: the route
geometry (legitimately), the models (`trains`, trusted for the breakdown), and the dividend amount.

Representations: there was never a competing server model — the engine already owned the rail-level graph
(`trackSegments.ts`: `traversalsFrom`, `neighbourAcross`, `segmentsTouchingEdge`; `trackReach.ts`: `cityForArrival`,
`stopEnteredFrom`, `stationTokensOf`; `cityBlocking.ts`; `stationTokens.citySlotCount`; `hexContractTypes.tokenCityIndex`)
and the tracer, the network walk and the pricing all asked it. What was missing was a reader of a *submitted* path.

## 3. Architecture after

`gameEngine/routeAuthority.ts` (pure; imports only engine modules and the `components/` data tables the engine
already imports; no React, no DOM):

- `evaluateRouteSet({ state, mapGrid, era?, companyId, routes, trainIndices?, trains? })` →
  `{ kind: "legal", runs: [{ trainIndex, model, path (bypass-normalised), revenue, centres, segments }], total }`
  or `{ kind: "refused", reason, route? }`. Identity first (fleet from `owned_trains`, indices in range and
  distinct, `trains[i]` must equal the slot's model), then each route walked (`walkRoute`: hex exists → adjacency
  and two-sided rail → interior transit exists (bypass chosen/normalised) → blocked circle → segments claimed →
  endpoints are termini → `city_node` agrees with the rail → no city twice → a station on the route → priced by
  `sandboxRouteBreakdown`, ≥ 2 centres), then capacity per slot, then the set (no shared segment). Logs without
  `train_indices` (pre-#1031) are paired largest-route-to-largest-train.
- `routeSetRefusal(state, msg, mapGrid, era)` — one run per turn, at the Run Trains step, then the evaluator;
  without a grid no opinion (#757). Asked in `applySandboxActionCore` (identity no-op) and at ingress
  (`turnAuthority.operatingLegalityRefusal`, `refused` with the sentence).
- `dividendAmountRefusal(state, msg)` — C1. `routeSkipRefusal(state, msg, mapGrid)` — Run Trains not skippable
  past a paying route (pinned boards in the core; every board at ingress; derived entries exempt as before).
- The arm prices from `evaluateRouteSet`'s runs (`priced = runs.map(r => r.revenue)`); the breakdown's model is
  the slot's. `last_run_turn_key` now lands on the state (#1183 corrected).
- `SetupGame` copies `rules_engine_version` onto the state (#1551); `RunManualRoute` refused when it is a number.
- `messageSchema.ts` (#1553): `routes` is `routes` (array of waypoint arrays of `{hex: string, city_node?: int,
  bypass?: bool}`; ≤ 64 routes, ≤ 512 waypoints — transport sanity bounds, not rules), `trains: strings?`,
  `train_indices: ints?`, `RunManualRoute.path: waypoints`. Existence, connectivity and legality stay the reducer's.
- UI (#1554, minimal): `App.tsx` `trainDrafts.endsOffTerminus` asks `isRouteTerminusHex` for the acting
  corporation; `handleRunTrains` previews `evaluateRouteSet` and shows its sentence in the route panel instead of
  dispatching; `routeDraftEdit` takes `forCompanyId` so a route may start on the owner's herald. Route drawing is
  otherwise untouched. A server refusal still lands in the room banner (S10-1).
- `gameEngine/index.ts` exports the evaluator family; `ReplayObserver` gains `grid` (additive).

## 4. Corporation / train identity (Part 5)

Preserved: `operatingIdentityRefusal` binds the message to the operating corporation. Added: every
`train_indices[i]` is an integer in `[0, owned_trains.length)`, none twice; `routes.length ≤ owned_trains.length`;
`trains[i]` (when present) must equal `owned_trains[train_indices[i]]` — "slot 1 holds a 3-train, not the 4 the run
claims"; capacity from the slot's model via `MOCK_TRAIN_CATALOG`; an unknown model refuses. A trainless corporation
cannot run at all (0 trains, ≥ 1 route). Ghost trains are in `owned_trains` and run like any other (#1046 rule
kept); reprieved trains likewise; no Stage-9 dependency was created (the Yellow Sign event itself is untouched).

## 5–7. Per-route and cross-route legality

Section 1's matrix, rows R2–R12, each with a positive and a negative control in `routeAuthority.test.ts` on real
tile geometry (a Gulf–city line, a #20 crossover, a #24 fork, a #63 hub with a loop, a #1 double town crossed
twice, a #59 two-city tile, and the 18XX+ / LPF boards for the herald). Negative controls where two routes are
individually legal but illegal together: I5–I7 + I5–I7 (same straight), the fork's two prongs sharing its one stub
(#731's edge key), and I5–I7–I9 + J2–I3–I5–I7 (one shared section among many). Legal sharing kept legal: meeting at
a city by different stubs, the two straights of a crossover, an off-board destination by different edges.

## 8–9. Revenue and dividend authority

`last_route_revenue` is the evaluator's total (die applied as before); `printed_route_revenue` likewise;
`last_run_breakdown` carries the slot's model and the evaluator's per-route figure. A crafted `revenue` /
`printed_revenue` / `last_route_revenue` field on the message changes nothing (test 17). `DeclareDividends`:
`revenue_amount` stays on the wire for narration and for replay of logs written since #752; it must now equal
`last_route_revenue` exactly (a mismatched declaration is an identity no-op in the core and a `refused` frame at
ingress); an absent amount (pre-#752 entries) is judged by `dividendRevenue`'s existing fallback, which reads the
same field. Payout / withhold / share-price mechanics untouched. Migration: the live shell already declares from
`last_route_revenue` (#934), so nothing changes for a correct client; a client that computed its own figure (JUNO-Z6C
418 / 428 / 433 — $10–$20 short of the reducer's on three consecutive LPF + Unpredictable Revenue turns) is refused
with the authoritative figure in the sentence.

## 10. No-route / zero-revenue / skipping

- Trains, no legal route: `maxRouteRevenueFor` finds nothing → the auto-skip / forced $0 withhold stand; a run is
  refused for its geometry; a manual skip is allowed.
- Trains and a paying route: `AdvanceOperatingSubPhase` / `PassTurn` at Run Trains refused ("has a route it can run
  (worth up to $N), so it must run before its turn moves on") — the shell's #414 obligation, now the authority's.
  On pinned boards in the core; legacy logs keep their recorded skips (JUNO-CV4 88 / 3XD 226 were the old engine's
  own verdicts on a corporation it miscounted — refusing them would strand that corporation for the rest of the
  replay; D-9).
- Trainless: the Batch-4/5 obligation is untouched (`trainObligationRefusal`, `emergencyFundingFor`); a run from a
  trainless corporation is refused as "owns 0 trains".
- A legal $0 route (two blank cities) remains skippable: `maxRouteRevenueFor` = 0 and the shell's `value > 0`
  filter agree, as before (`runTrainsRules` #883).
- **Town termini (S6-10, #1555):** a corporation whose only route ends on a town now has a legal route — it may not
  skip Run Trains, and if trainless it owes the forced purchase (`routeAuthority.test.ts`, "a town terminus is the
  only legal route"). The same fixture with the town tiles removed owes nothing (negative control).
- **The highest-revenue combination (S6-3, #1556):** `routeSetRefusal` = legality → pricing → `demonstratedShortfall`.
  Refused: a 3-train's I5–I7 ($40) when I5–I7–I9 ($60) exists; two 2-trains' best single route run alone ($50 vs
  $90 — the comparison is the corporation's total). Accepted: the set equal to the search; a hand-drawn route the
  tracer cannot produce (a crossover crossed on both straights, $40 against a $0 search); the same $50 route for
  a 2-train that is short for a 3-train (fleet); I5–I7 into a tokened-out I7 (blocking makes it the best). Replay,
  `RevertTo` and room restore rebuild identically. Cost: one search per submitted run at ingress and one in the
  core; the 17-log sweep with every search takes ~1.7 s; recorded as S6-14, not a rule change.

## 11. The LPF PRR $60 → $30 defect — root cause (#1554)

Investigated, not assumed. Neither corpus log holds the reported turn (JUNO-CV4 145 is the *bypass* case the
triage note ruled correct), so the topology was rebuilt on both boards that print the herald: H10 (#57) — H12
(herald, printed #24) — H14 (#57), PRR with two 2-trains and no token. The authority prices `[H10, H12]` = $30 and
`[H12, H14]` = $30, total $60 (test block 20, both boards). The reducer was never the fault: it paid what it was
sent. **The route ending on the herald was never sent.** `App.tsx`'s draft memo computed
`endsOffTerminus: !isRouteTerminusHex(mapGrid, last.hexLabel)` — without the corporation — and `isRouteTerminusHex`
answers the herald hex as a terminus only for its owner (#1302). So the draft ending at H12 was marked as ending off a
terminus, `runnableDrafts` silently skipped it ("invalid drafts are skipped, not refused", #275), and
`handleRunTrains` dispatched the other route alone: $30, with both chips still drawn. The route *starting* at H12
survived because the tracer judges its start with the corporation. Category: client-side filtering (route
serialization), not deduplication, train identity, station handling, city identity, or the authoritative total.
Repair: the predicate is asked for the acting corporation (`actingProtocolId`), `editRouteDraft` accepts a start on
the owner's herald, and `handleRunTrains` previews the authority so a dropped route can no longer be silent. Not
special-cased to PRR: the fix is the missing argument. Regression: `routeAuthority.test.ts` block 20 (evaluator total
$60 on both boards; the corporation-blind predicate false and the corporation-aware one true on the same hex; a
source assertion that the shell passes the corporation; `editRouteDraft` start rule with and without it). Broader
herald authority (the "must count in first turns" clause) stays S6-4 / Stage 9.

## 12. Runtime schema / hostile client (Part 12)

Refused at ingress (`validateGameplayMessage`, shape): non-array routes, non-object waypoints, `hex` not a string,
`city_node` not an integer, `bypass` not a boolean, `trains` not strings, `train_indices` not integers, more than
64 routes or 512 waypoints, `RunManualRoute.path` malformed. Refused by the authority (law, at ingress with a reason
and in the core by identity): nonexistent / another corporation's / duplicate train, off-board hex, non-adjacent or
rail-less step, over-capacity, blocked pass-through, same-train or cross-train track reuse, fabricated `bypass` or
`city_node`, fabricated revenue (ignored), a repeated run (any key), a run at the wrong step, a `RunManualRoute` on
a pinned board. `messageSchema.test.ts` and `serverProtocol.test.ts` unchanged and green.

## 13. Replay / versioning (Part 13)

- `RULES_ENGINE_VERSION` 3 → 4 with the changelog row; `SUPPORTED = [4]`; a version-3 room is `incompatible`
  before `RoomEngine.apply` (test 23, spied). Same-version logs rebuild identically through `replayLog` and
  `RoomSession` and `RevertTo` restores the pre-run board and accepts the honest re-dispatch (tests 21, 22).
- **Corpus sweep** (17 logs: `server/data` ×8, golden ×3, the FCJ prefix-96 fixture, `frontend/sandbox-log-*` ×5;
  all legacy / undealt; the server policy refuses all 16 legacy logs; sweep under `DEVELOPMENT_CORPUS_POLICY` against
  the Batch-5 engine, per-index): **14 of 17 gameplay-identical**. Every digest changes where a run occurred because
  the #1183 key moved from the corporation entry to the state root (S6-11) — representation only; the CV4 golden
  fixture was re-baselined for exactly that (diff: three `last_run_turn_key` lines leave three companies, one appears
  on the state). The three that diverge in gameplay:
  - `server/data/JUNO-FCJ.log.jsonl` **idx 230** (B&M, two 2-trains and a 3): route 2 (G19–F20–F22) touches no B&M
    station on the log-derived board — B&M's idx-95 token was refused by Batch 3, so the board has been diverging
    "by construction" since 95; version 3 priced the run anyway, version 4 refuses it ("must pass through a city this
    corporation has a station token in"), 231's $160 declaration then mismatches, and every later B&M run/dividend
    cascades. No test replays FCJ past 96; reported, not absorbed.
  - `server/data/JUNO-Z6C.log.jsonl` **idx 418** (NYC declared $180 on a $190 run; 428 PMQ $290 / $300; 433 NNH
    $250 / $270): version 3 paid the message, version 4 refuses the mismatch (C1). Treasuries differ from there and
    the bank no longer breaks at 613. `gameHistory.test.ts` (a UI timeline test on the Z6C fixture) asserted the
    replay reaches "OR 9.1"; it now asserts the timeline's shape, with the reason in the test.
  - **Added by the S6-3 ruling (#1556)** — four logs held runs short of the combination the search demonstrates:
    - `server/data/JUNO-CV4.log.jsonl` **idx 98** (and the golden copy): B&O, three 2-trains, ran two routes for $90;
      the search demonstrates $130 (I15–J14 $50, I15–I17–I19 $40, J14–K13 $40 — a third train left idle). Refused;
      99's $90 declaration is a C1 mismatch; cascade. **The CV4 golden fixture is re-baselined for this** (a
      deliberate rules change, per the test's own header); `replayJunoCV4.test.ts` is unaffected.
    - `server/data/JUNO-Z6C.log.jsonl` **idx 140**: B&O ran three of its four trains, $160 vs $220 demonstrated;
      **172**: C&O's 3-train ran $70 vs $80 — the search adds the Akron & Canton town as a terminus (G7–F6–G5–G3–F2),
      an S6-10 consequence; 396 (N&W $340 vs $350) is on the already-diverged board.
    - `frontend/sandbox-log-JUNO-3XD.json` **idx 175**: NNH ran $240 with [2, 2, 3]; the search demonstrates $270
      (the 3-train could reach Baltimore, F16–G15–H16–I17–I15 $110). Refused; the operating order of every later
      round then differs, so `replayJuno3XD.test.ts`'s filed table is re-pinned again — PRR 260, NYC none, B&O 350,
      C&O 220, NNH 90 — with the reason in the test, and the idx-255 discard the Batch-4.6 adapter used to supply
      no longer falls due in the log-derived game (`trainDiscard.test.ts` re-pinned with the reason; the adapter
      is still proven by its synthetic case).
    - Every other log is identical to the S6-10 engine (13 / 17).
  - `server/data/JUNO-FCJ.log.jsonl` **idx 74** (added by the S6-10 ruling; it now precedes the 230 divergence):
    B&M, trainless in its first Operating Round, passed at Buy Trains. The old engine saw no legal route for it —
    its only route, E23–F24 ($40), ends on a town. Under the ruling that route is legal, the Batch-4 obligation
    gate refuses the pass ("owns no train and has a route to run, so it must acquire one"), and the legacy log
    diverges from 74. The FCJ prefix-96 fixture (`stationLegality.test.ts`, Batch 3's idx-76 / idx-95 cases) would
    stall there, so its harness supplies the purchase the old engine never demanded — a documented fixture repair
    inside the test, nothing on disk — and the 76 / 95 assertions stand. **No other log changes under the ruling**
    (16 / 17 identical to the pre-ruling Batch-6 engine).
  - `frontend/sandbox-log-JUNO-3XD.json` **idx 260** (PRR): the run names a 4-train in slot 1 that the log-derived
    fleet `[3, 3]` does not hold (the 4 was bought on the queue the #1196 divergence swapped — this log has diverged
    since 224); version 3 priced it, version 4 refuses it ("slot 1 holds a 3-train, not the 4"), 261's $230 and
    307/308 the same; PRR's OR-7 price then does not rise, B&O operates first in OR 7.1, and B&O's 313 is
    identity-refused; **319** (the #1183 duplicate) is refused by the one-run rule and 320's $540 by C1.
    `replayJuno3XD.test.ts`'s filed-vs-declared table — the line its own note says is where such changes announce
    themselves — re-pinned with reasons: PRR 170 → 260, B&O 240 → 270, NNH 540 → 340; NYC, C&O unchanged.
- Payload sufficiency: every stored `RunMultipleRoutes` since #1031 carries `train_indices`; entries without them
  (none in the corpus) are paired by the evaluator, so no adapter was needed. No legacy entry needed a new field.

## 14. Ledger

`RULES_HARDENING_BACKLOG.md` updated before commit: S6-1, S6-2 `RESOLVED`; S6-3, S6-4 annotated; **new** S6-10
(town termini — owner decision owed), S6-11 (#1183 dead key — resolved), S6-12 (`RunManualRoute` retired on pinned
boards), S6-13 (shell validators duplicating the authority — deferred cleanup); S10-1, S10-17, U-17 annotated; Part A
Stage 6 entry; Part E version-4 row with the three divergences above.

## 15. Files

New: `frontend/src/gameEngine/routeAuthority.ts` (#1550), `frontend/src/utils/routeAuthority.test.ts` (50 cases),
this file. Modified: `sandboxSession.ts` (core gates; the arm prices from the evaluator; #1183 key relocation;
`SetupGame` pin; `isRouteTerminusHex` = any revenue centre, #1555), `routeAutoTrace.ts`, `runTrainsRules.ts`,
`RoutePlannerPanel.tsx`, `RouteChipDetail.tsx`, `hexBoardDataLpf.ts` (terminus wording, #1555), `turnAuthority.ts` (`operatingLegalityRefusal`), `messageSchema.ts` (#1553), `rulesVersion.ts`
(4 + changelog), `gameState.ts` (`rules_engine_version`), `replayLog.ts` (observer `grid`), `gameEngine/index.ts`
(exports), `App.tsx` (#1554: terminus with the corporation; evaluator preview before dispatch; draft editor's
corporation), `utils/routeDraftEdit.ts` (`forCompanyId`), tests: `atomicRunRoutes` (the "adds to a total already
standing" case now pins one run per turn), `visitOnce` (fixture on real track), `refusedAction` and `dividendNarration` (control
boards carry the run they declare), `stationLegality` (the S6-10 fixture repair at FCJ 74), `levelPlayingField`
(Coal River is a terminus for a licence holder), `routeDraftEdit.test` (comment), `trainDiscard` (3XD no longer
exercises the legacy-discard adapter), `derivedActions.ts` (`maxRouteRevenueFor` / `routeSearchFor` take an
optional era so the demonstration is priced at the era the submission was), `gameHistory` (Z6C shape), `replayJuno3XD` (re-pin with reasons),
`emergencyFunding` (version assertions relative to the current pin), `__fixtures__/replayGolden/JUNO-CV4.json`
(re-baselined for the key relocation).

## 16. Focused results

- `routeAuthority.test.ts` 50/50: the brief's 1–23, the "town run through is a counted city" block (capacity,
  revenue and tracer on large city → town → large city), the S6-3 block (suboptimal refused with the figure;
  equal accepted; hand-drawn above the heuristic accepted; total not per-train; fleet and blocking; replay /
  `RevertTo` / restore deterministic),, the S6-10 block (town→city accepted and priced; tracer,
  draft editor and shell agree; a town terminus as the only legal route makes the forced purchase owed), (15/16 in 2; the PRR block on both boards; 21–23 through
  `replayLog` and `RoomSession`), plus the topology cases (double town twice, two-city tile by circle, named-city
  and fabricated-bypass refusals, ghost train, legacy pairing, no-grid neutrality, schema shapes).
- Green (ran here): `visitOnce`, `atomicRunRoutes`, `batch40/50/51/60`, `levelPlayingFieldRules`, `markKeepsRun`,
  `multiTrainRun`, `revenueRounding`, `multiTrainDividend`, `dividendStep`, `oneRunPerTurn`, `turnAuthority`,
  `operatingIdentity`, `emergencyTrainFlow`, `emergencyFunding`, `trainDiscard`, `rulesVersion`, `replayGolden`,
  `replayJunoCV4`, `replayJuno3XD`, `gameVariants`, `serverProtocol`, `sandboxRoom`, `roomSession`, `actionReceipt`,
  `refusedAction`, `revenueFlashWiring`, `messageSchema`, `phantomDividend`, `dividendPools`, `doubleWithhold`,
  `derivedActions`, `heraldHome`, `altoonaBypass`, `altoonaWall`, `routeDraftEdit`, `routeStep`, `runTrainsRules`,
  `trackContinuity`, `forkedTrackReuse`, `multiTrainRouting`, `perCityRevenue`, `sharedCityRouting`,
  `reenterOtherCity`, `cityBlocking`, `routeCityBlocking`, `routeTokenRule`, `dieselRouteCap`, `trainReach`,
  `stationConnectivity`, `stationLegality`, `offboardTerminality`, `chipRunRevenue`, `hexValueAgreement`,
  `routeRevenueReset`, `logRevert`, `stateDigest`, `logHash`, `gameSetup`, `boardInEffect`, `kanawha*`,
  `watcherRouteChips`, `routeChip*`, `RoutePlanner*`, `gameHistory`, `turnClock`, `accolades`, `roundReplay`,
  `stationCityReach`, `gameOutro`, the `batchNN` source-scan family, `sourceScan`, `designNote*`, `actionLog`,
  `turnSeed`, `sessionKey`, `routeWaypoints`, `cityBypass`, `trackReach`, `trackSegments`, `cityTopology`,
  `hexBoard*`, `tileLegality`, `layable*`, `homeToken*`, `stationToken*`, `operatingCursor`, `subPhase*`,
  `operatingRound*`, `autoSkip*`, `settle*`, `divergence*`, every suite that names `DeclareDividends`,
  `RunMultipleRoutes`, `RunManualRoute`, `AdvanceOperatingSubPhase` or `PassTurn` (70 suites / 1,182 tests), all
  of `src/components/` (32 suites / 377) and `src/utils/[a-m]*` (158 suites / 2,689) — green here. The complete
  suite was not run here (the owner's run is the validation).
- `frontend` typecheck clean; `server` build clean (the server imports `routeAuthority` through `gameEngine/index`).
- ESLint on the new and changed engine files: clean (the repo's pre-existing lint findings in `sandboxSession.ts`
  and a few older tests are untouched).

## Expected totals and commands

355 suites / 5545 tests (baseline 354 / 5495 + `routeAuthority.test.ts` 50; every other suite keeps its count —
`atomicRunRoutes` renames one case, none are added or removed elsewhere).

    cd frontend && npm test -- --watchAll=false
    cd frontend && npm run typecheck
    cd server && npm run build
