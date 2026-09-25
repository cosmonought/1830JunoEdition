# Variant Certification 1B — Unpredictable Revenue (UR-1): specification / authority / randomness / coverage audit

**2026-09-24 · AUDIT + DESIGN ONLY.** No production code, test, golden, fixture, log or export was changed.
`RULES_ENGINE_VERSION` is untouched (**9**). Nothing committed or pushed. **Unpredictable Revenue is NOT certified by this
document, and neither is the Gentle Rust + Unpredictable Revenue combination.**

**Rev 2 (2026-09-24, documentation only) — owner rulings recorded (UR-2, part 1).** Ten of the thirteen owner decisions
are DECIDED — OD-UR-1, OD-GR-3, OD-UR-2, OD-UR-3, OD-UR-4, OD-UR-7, OD-UR-8, OD-UR-9, OD-UR-11, OD-UR-12 — and three
remain **OPEN**: OD-UR-5, OD-UR-6, OD-UR-10. The rulings, verbatim in substance, are in **"Owner rulings (rev 2)"** below;
§1.2, §2, §3, §7.3, §12, §13, §14 and §15 are updated to them. Nothing is implemented; `RULES_ENGINE_VERSION` is still
**9**. **UR-3 is unblocked** (§15). The verdict stays **C** — the specification is still incomplete in the three open
decisions, and every implementation defect below is still present.

**Rev 3 (2026-09-24) — UR-3 implemented** *(rev 5: **COMPLETE — owner-gated (the owner's full repository Jest gate passed), committed and pushed as `9d0cf3a`**; at rev 3 it was
uncommitted, awaiting that gate)*. The Yellow Sign is now
an automatic consequence of the authoritative run on pinned tables (OD-UR-1), resolved on the post-settlement fleet
(OD-GR-3), with the client-sent `YellowSignEvent` refused there at ingress and in the reducer; the fog is an
OR-set-boundary transition at the end of set N+1 (OD-UR-2); and, by the owner's UR-3 brief, the two UR-4 defects it makes
reachable are fixed with it — synthetic trains never advance the phase (OD-UR-3, UR-F4) and a gilded train is never a
Diesel trade-in (OD-UR-7, UR-F17). **Fixed: UR-F1, UR-F2, UR-F3, UR-F4, UR-F5, UR-F6, UR-F7 (pinned path), UR-F17,
UR-F18 — and UR-F19**, found in this pass (the Mark's taken train returned to the derived depot and could regress the
phase — pre-existing, newly reachable), fixed under **OD-UR-13, DECIDED by the owner during UR-3 (2026-09-24)**: the train
is **permanently removed from the game** (recorded on the board as `removed_trains`, never the Bank Pool) and **phase
progression is monotonic**. `RULES_ENGINE_VERSION` is still **9** (the 9 → 10 boundary is UR-8's); the 18-file corpus
replays unchanged (see "UR-3 implementation (rev 3)"). **The verdict stays C and Unpredictable Revenue is NOT
certified**: OD-UR-5 (the Blood Price), OD-UR-6 (statistics) and OD-UR-10 (rounding ties) are open; UR-F8, UR-F9, UR-F11
(Blood Price half), UR-F12, UR-F13, UR-F14, UR-F15 and UR-F16 remain, as do the unpinned (Firestore) residuals; and the
later UI / copy / Rules Reference work (UR-6), the constructed certification game (UR-7) and the v9 → v10 closure (UR-8)
are still owed.

**Rev 4 (2026-09-24, documentation only) — OD-UR-10 DECIDED: 10-C, an exact tie rounds toward printed.** The owner has
ruled the last open confirmation (§12.3): when the modified Unpredictable Revenue amount lands exactly halfway between two
$10 increments, it rounds toward the corporation's original printed revenue; any other amount still rounds to the
nearest $10. Printed $50: $45 → $50, $55 → $50; printed $150: $135 → $140, $165 → $160; printed $250: $225 → $230,
$275 → $270. The owner's rationale: damp the die's volatility at low revenue values, stabilize the effect at higher
values, preserve symmetry around the printed revenue, and eliminate the current half-up upward bias. It replaces the
implementation's ordinary half-up rounding of exact ties, so today's behaviour becomes a defect with a decided target —
**UR-F20** (new) — and UR-N6 moves from CERTIFIED NOW to DEFECT (matrix counts, rev 4: clauses **29 / 12 / 17 / 4 / 0**;
interactions and invariants unchanged, **6 / 9 / 11 / 1 / 1**). **Not implemented:** routed to UR-7 (the rounding table
and the tie rule) and owed to the deliberate 9 → 10 replay-semantic boundary (UR-8, item (7)). No production code, test,
log, fixture, golden, export or corpus file changed; `RULES_ENGINE_VERSION` is still **9**. Owner decisions: **12 of 14
DECIDED** (rev 1's thirteen plus OD-UR-13); **OPEN: OD-UR-5 (the Blood Price) and OD-UR-6 (statistics)**. The verdict
stays **C**; Unpredictable Revenue is NOT certified.

**Rev 5 (2026-09-24, documentation only) — UR-3's status corrected; OD-UR-5 (a) and (c) and OD-UR-6 decided.** **UR-3 is
COMPLETE**: it passed the owner's full repository Jest gate and is committed and pushed as `9d0cf3a` (no certification
claim changes). New owner rulings: **OD-UR-5(a) = 5a-1** — a train acquired through the Blood Price becomes an ORDINARY
train for the buyer — an additional ordinary train, +1 in circulation relative to the printed depot supply, never a
special class of train; **OD-UR-5(c) = 5c-2** — a sale must name the copy, and only the gilded copy's sale is the Blood Price;
**OD-UR-5(b)** — whose stock marker takes the Left 1 / Down 1 — stays **OPEN**. **OD-UR-6:** 6.1 revenue statistics use
the revenue actually paid (decided in principle; the per-train allocation a per-train statistic would need is isolated as
an open sub-question, not answered); 6.2 a Mark-nullified route is not earned; 6.3 a synthetic gift is not a purchase,
and a later Blood Price acquisition is one. None is implemented: (a) is already today's behaviour; (c) is a new defect,
**UR-F21** (UR-4); 6.1 – 6.3 give UR-F8 its targets (UR-5). OD-UR-10 stays DECIDED (10-C) and UR-F20 stays open. Owner
decisions: **13 of 14 DECIDED** (OD-UR-6 with 6.1 in principle); **OD-UR-5 partly — (a) and (c) DECIDED, (b) OPEN**.
Matrix counts (rev 5): clauses **29 / 13 / 19 / 1 / 0**; interactions and invariants **6 / 9 / 12 / 0 / 1**. No
production code, test, log, fixture, golden, export or corpus file changed; `RULES_ENGINE_VERSION` is still **9**. The
verdict stays **C** (OD-UR-5(b) is open); Unpredictable Revenue is NOT certified.

**Rev 6 (2026-09-24, documentation only) — the Blood Price's cured train: the owner's clarification.** Rev 5's question
for UR-4 — whether a train cured by the Blood Price should count toward the phase at the buyer — is **CLOSED**; no owner
decision remains on it, and no new gameplay exception is required. The buyer receives an **additional ordinary train**,
never a special class of train: it keeps only the synthetic-origin provenance that the +1 supply accounting needs (it
did not consume a printed Depot copy), and **supply provenance may persist ≠ supernatural rules status persists** — that
status ends at the Blood Price. The Blood Price changes no phase, rust, Gentle Rust mark, Depot tier, 18XX+ era or
real-D doom trigger for the base game's reason — it is an **intercorporate purchase, not a Bank / Depot purchase** — and
not because the cured train stays supernatural. For UR-4 (§12.2): today one marker (`ghost_trains`) carries both the
supply accounting and the phase / real-D exclusion; UR-4 keeps the accounting and makes sure the cured train is
otherwise ordinary, and the representation is not prescribed. OD-UR-5(b) stays **OPEN** (the owner's lean is still
context only); OD-UR-6.1's per-train sub-question, OD-UR-10 (10-C) and UR-F20 are unchanged; the counts are unchanged.
No production code, test, log, fixture, golden, export or corpus file changed; `RULES_ENGINE_VERSION` is still **9**.
The verdict stays **C**; Unpredictable Revenue is NOT certified.

**Rev 7 (2026-09-24, documentation only) — owner policy closed: OD-UR-5(b) and OD-UR-6.1's per-train question decided.**
**OD-UR-5(b) — the BUYER only:** when a corporation buys the gilded train through the Blood Price, the buyer pays the
cash price and **the buyer's stock marker moves Left 1 / Down 1**; the seller gets no separate stock-price movement —
its benefit is release from the Carcosan curse — and the penalty is never applied to both. This supersedes #1090's
seller move, which the implementation carries today: new finding **UR-F22** (UR-4; do not restore the seller move).
**OD-UR-6.1, per train:** individual train / route statistics use the **printed value of the train's successfully
completed route** — not an allocation of the paid total — while corporation / turn-level statistics use the **actual
paid revenue**, and a Mark-nullified route contributes nothing (6.2). **OD-UR-5 and OD-UR-6 are fully DECIDED, and every
owner decision in this audit is DECIDED (14 of 14)** (backlog D-50, D-51); OD-UR-10 stays 10-C and UR-F20 stays open.
UR-F11 is closed (every contradiction it named is ruled). Matrix counts (rev 7): clauses **29 / 13 / 20 / 0 / 0**;
interactions and invariants **6 / 9 / 12 / 0 / 1** — **no OWNER DECISION row remains**. UR-4, UR-5, UR-6, UR-7 and the
constructed game G1 have no owner-decision blocker; what remains is implementation and certification evidence. **The
verdict moves from C to B — specification complete, implementation defects found**; Unpredictable Revenue is NOT
certified. No production code, test, log, fixture, golden, export or corpus file changed; `RULES_ENGINE_VERSION` is
still **9**.

**Rev 8 (2026-09-25) — UR-4 implemented: the Blood Price, copy by copy, paid by the buyer** *(uncommitted, awaiting the
owner's full repository Jest gate)*. OD-UR-5 is implemented and pinned live, on every table (pinned and unpinned — the
corpus holds no gilded train, no provenance marker and no Carcosan transfer, measured). **(c) — UR-F21 FIXED:** the sale
names the copy — one optional boolean, `gilded`, on `BuyTrainFromCorporation` and `ProposeTrainPurchase` (so on the offer
and its derived settlement); multiset copy selection, no persistent train identity; an unnamed sale of a model the seller
holds both gold-trimmed and ordinary is refused atomically at the proposal, the answer, the settlement, the chart step and
hosted ingress; the ordinary copy's sale leaves the gilding, the curse, the deadline and the gilded copy's provenance where
they were; The Redeemer reads the gilding the sale burned (the one narrow statistics coupling). **(b) — UR-F22 FIXED:**
the Blood Price moves the BUYER's marker Left 1 / Down 1 and never the seller's; the Train Purchase warning, the consent
prompt, the market arm's and the narration's design notes, and the suites that pinned the seller move (`BPA`, `S103`,
`S103b`, GR-2's S8 control; `B60`'s source pins) are updated — no seller-move language remains in the Blood Price path.
**(a) — pinned live:** the cured train is ordinary (limit, running, rust, sale, trade-in, fog, curse, clock) and keeps only
its synthetic-origin provenance, the +1; the Blood Price turns no phase, rust, Gentle Rust mark, shelf, era or real-D
trigger (a 6, a D, an LPF 7; Gentle Rust; 18XX+ tiles), and the first REAL train of the tier still does all of it.
**Provenance lifecycle:** one concrete defect found and fixed narrowly — a cured copy traded in for a Diesel (or, on a
constructed board, discarded) went to the Bank Pool as a PRINTED train (the Depot lost a printed copy it never sold) and
left its marker behind to swallow the corporation's next copy of the model (#1675's hazard, reachable once 5a-1 made the
cured train tradable); the pool now carries the additional copy's provenance (`returned_ghost_trains`, absent on every
board without one) and a pool purchase hands it to the buyer. `RULES_ENGINE_VERSION` stays **9** (UR-F21 / UR-F22 are owed
to the 9 → 10 boundary, UR-8 — §15 item (6)); the 18-file corpus is unchanged (0 differences in 3,763 engine applications;
Y8V `b4fae877c35604fe`, 3XD `74db6e4bad736fec`). No owner decision is new or re-opened. The verdict stays **B**;
Unpredictable Revenue is NOT certified. See "UR-4 implementation (rev 8)".

**Verdict: B — SPECIFICATION COMPLETE (every owner decision made, rev 7) / IMPLEMENTATION DEFECTS FOUND.** *(Rev 1 – rev 6:
C — specification incomplete, owner decisions required.)*
The revenue die itself — one server-drawn 32-bit number per corporation turn, committed in the log, consumed by
replay, never re-rolled by an undo, applied once to the turn's printed total and rounded to $10 — is sound and
already server-authoritative at hosted ingress. The Yellow Sign that rides on it is not. Four findings are HIGH:

| id | finding (short) | evidence |
|---|---|---|
| **UR-F1** | In every room (hosted server and Firestore) the Yellow Sign **never reaches the board**: the shell narrates it inside the log drain and dispatches its request from there, and #1407's catch-up guard refuses every dispatch made while the drain runs. The Activity Log reports a Mark, a gift or a fog; the board never changes. | static trace, high confidence (§6.2) — not executable without an `App.tsx` harness |
| **UR-F2** | The sign's request is **not bound to its run**: the game never derives it, ingress checks only the seat, and the reducer judges the stage window at *application* time. A client can omit it (keep the train / escape the fog), delay it past a phase change (dodge a Mark, harvest a Carcosa its run's phase forbade), delay it past a self-triggered rust (take a Final Run train), or aim it at another corporation (collect someone else's fog before their run). | probes P-D, P-G1′, P-G2′, P-H |
| **UR-F3** | **No variant gate**: on a table without Unpredictable Revenue a `YellowSignEvent` still derives and applies the Mark (train taken, $ minted, remainder re-rolled with the UR die), through hosted ingress. | probe P-A |
| **UR-F4** | A **Carcosa gift above the current phase** (the depot-lowest tier while the phase's own tier is sold out) turns the derived phase without a phase change; the later first REAL train of that tier then rusts nothing — 3-trains (gift 6) or 4-trains (gift D) survive the game, and a gilded ghost D never gets a doom clock. | probes P-B, P-F |

*(Rev 3: all four are **FIXED by UR-3** — UR-F1 / UR-F2 / UR-F3 on pinned tables by the run-bound Sign, UR-F4 on every
table by `derivePhase` — with durable reducer and hosted-room tests; the unpinned (Firestore) residual is recorded in
"UR-3 implementation (rev 3)".)*

OD-GR-3 is answered by a decision tree (§7), not by this audit. Eight blocking owner decisions (OD-UR-1 … OD-UR-8) and
four confirmations (OD-UR-9 … OD-UR-12) are listed in §12. The remaining findings (UR-F5 … UR-F17) are in §12.1.
*(Rev 2: the owner has since chosen within that tree — §7.3 — and decided ten of the thirteen; rev 2 also adds UR-F18,
the fog's run-triggered collection, which OD-UR-2 makes a defect.)*

**Revision history.**

| rev | date | change |
|---|---|---|
| 1 | 2026-09-24 | initial audit (UR-1) — verdict C; 62 normative clauses; 17 findings; OD-UR-1 … OD-UR-12 and the OD-GR-3 decision tree; certification matrix; constructed-game design; slice roadmap UR-2 … UR-8 |
| 2 | 2026-09-24 | **owner rulings recorded (UR-2, part 1) — documentation only.** DECIDED: OD-UR-1 (1-A automatic), OD-GR-3 (3a = A2, "never"; 3b / 3c moot), OD-UR-2 (N+1 + boundary), OD-UR-3 (3-A), OD-UR-4 (4-A minted), OD-UR-7 (7-A refused), OD-UR-8 (8-B), OD-UR-9 (9-B, implementation routed to AWS / live multiplayer), OD-UR-11 (11-A), OD-UR-12 (12-A). OPEN: OD-UR-5, OD-UR-6, OD-UR-10. New finding UR-F18; UR-F10 closed as intended; ledger, matrix (counts 30 / 12 / 16 / 4 / 0 and 6 / 9 / 11 / 1 / 1), constructed-game design and roadmap updated; UR-3 unblocked. Verdict stays C. |
| 3 | 2026-09-24 | **UR-3 implemented** *(then uncommitted; rev 5: complete — owner-gated, committed and pushed as `9d0cf3a`)*. Run-bound Yellow Sign on pinned tables (`settleRunYellowSign`, record `last_run_yellow_sign`); client request refused on pinned tables (ingress, reducer gate, arm, shell refusal line); fog at the end of set N+1 (`fogAtSetEnd`); synthetic trains never the phase (`derivePhase`); no gilded Diesel trade-in (`exchangeableTrains`); the Mark's breakdown from the authority's pairing (pinned UR tables); narration, fleet-loss notices and statistics read the record. Fixed UR-F1 … UR-F7, UR-F17, UR-F18; UR-F19 found, **OD-UR-13 decided by the owner during the slice** (the Mark's train removed from the game — `removed_trains`; phase progression monotonic) and fixed; the other train-removal paths checked for a phase regression (none found); Firestore residual recorded; 18-file corpus unchanged (0 differences in 3,763 engine applications; 0 phase decreases). Verdict stays C; NOT certified. |
| 4 | 2026-09-24 | **OD-UR-10 decided — 10-C (documentation only).** An exact $5 tie of the modified revenue rounds toward the corporation's printed revenue ($50: 45 → 50, 55 → 50; $150: 135 → 140, 165 → 160; $250: 225 → 230, 275 → 270); the owner's rationale recorded. New finding UR-F20 (today's half-up tie); UR-N6 CERTIFIED NOW → DEFECT; clause counts 29 / 12 / 17 / 4 / 0 (interactions and invariants unchanged); owner decisions 12 of 14 DECIDED, OD-UR-5 and OD-UR-6 OPEN; implementation routed to UR-7 and owed to the v10 boundary. Nothing implemented; `RULES_ENGINE_VERSION` 9. Verdict stays C; NOT certified. |
| 5 | 2026-09-24 | **UR-3 status corrected; OD-UR-5 (a), (c) and OD-UR-6 decided (documentation only).** UR-3 recorded COMPLETE — owner-gated (full repository Jest), committed and pushed as `9d0cf3a`; no certification claim changed. OD-UR-5(a) = 5a-1 (the Blood Price buyer's train is ordinary — an additional ordinary train, only +1 in circulation, never a special class of train); OD-UR-5(c) = 5c-2 (the sale names the copy; only the gilded copy's sale is the Blood Price) — new finding UR-F21; OD-UR-5(b) OPEN. OD-UR-6: 6.1 paid revenue (in principle; the per-train allocation isolated), 6.2 a Mark-nullified route not earned, 6.3 a synthetic gift not a purchase and a Blood Price acquisition a purchase — UR-F8's targets. Counts 29 / 13 / 19 / 1 / 0 and 6 / 9 / 12 / 0 / 1; decisions 13 of 14 DECIDED, OD-UR-5(b) OPEN. Nothing implemented; `RULES_ENGINE_VERSION` 9. Verdict stays C; NOT certified. |
| 6 | 2026-09-24 | **The Blood Price's cured train — the owner's clarification (documentation only).** Rev 5's question for UR-4 (does a cured train count toward the phase at the buyer?) is CLOSED — no owner decision remains and no new gameplay exception is required: the Blood Price is an intercorporate purchase, not a Bank / Depot purchase, so it changes no phase, rust, Gentle Rust mark, Depot tier, 18XX+ era or real-D doom trigger; the cured train is an additional ordinary train whose synthetic-origin provenance survives only for the +1 supply accounting (supply provenance ≠ supernatural status). UR-4 implementation note — one marker (`ghost_trains`), two concepts today; the representation not prescribed. "Bonus train" restated as "additional ordinary train". OD-UR-5(b) OPEN; OD-UR-6.1's per-train sub-question unchanged; counts unchanged. Nothing implemented; `RULES_ENGINE_VERSION` 9. Verdict stays C; NOT certified. |
| 7 | 2026-09-24 | **Owner policy closed — OD-UR-5(b) and OD-UR-6.1's per-train question decided (documentation only).** OD-UR-5(b): the buyer only — the buyer pays the cash price and its marker moves Left 1 / Down 1; the seller gets no separate movement (its benefit is release from the curse); never both; #1090's seller move superseded — new finding UR-F22 (UR-4). OD-UR-6.1 per train: the printed value of the train's successfully completed route — not an allocation of the paid total; turn / corporation statistics use the paid revenue; a Mark-nullified route contributes nothing. OD-UR-5 and OD-UR-6 fully DECIDED (backlog D-50, D-51); decisions 14 of 14; UR-F11 closed; UR-N51 OWNER DECISION → DEFECT UR-F22; counts 29 / 13 / 20 / 0 / 0 and 6 / 9 / 12 / 0 / 1 — no OWNER DECISION row. UR-4, UR-5, UR-6, UR-7 and G1 without an owner-decision blocker. Verdict C → **B** (specification complete, implementation defects found). Nothing implemented; `RULES_ENGINE_VERSION` 9. NOT certified. |
| 8 | 2026-09-25 | **UR-4 implemented (uncommitted, awaiting the owner's gate).** OD-UR-5 on every table: (c) the sale names the copy — optional `gilded` on `BuyTrainFromCorporation` / `ProposeTrainPurchase` / the offer / its derived settlement; an unnamed sale of a model held both gilded and ordinary refused atomically at every moment; provenance leaves with the copy that has it; The Redeemer reads the gilding the sale burned — **UR-F21 FIXED**; (b) the buyer's marker moves Left 1 / Down 1, never the seller's; warning, prompt and design notes updated; `BPA`, `S103`, `S103b`, GR-2 S8 and `B60` pins updated — **UR-F22 FIXED**; (a) the cured train pinned ordinary, and the Blood Price pinned to turn no phase / rust / mark / shelf / era / real-D trigger. Found and fixed narrowly: a cured copy traded in (or, constructed, discarded) became a printed pool train and left a stale marker — the pool's provenance `returned_ghost_trains`, read by the Depot tally, the phase and the real-D check; a pool purchase hands it on. Three new suites (50 tests; 30 fail / 20 pass on the baseline); focused Jest 263 suites / 5,228 tests green; tsc (frontend, server) 0; build: 49 warnings, identical to the baseline; 18-file corpus 0 differences. `RULES_ENGINE_VERSION` 9. Verdict stays B; NOT certified. |

## Owner rulings (rev 2)

Recorded from the owner's rulings on the decision packet built on §7 and §12 (2026-09-24). **Documentation only:**
nothing below is implemented, and `RULES_ENGINE_VERSION` stays **9**. Where a ruling changes a clause, §3 and §13 say
so and name the finding that now carries the gap. The options each ruling chose between are kept in §7.2 and §12.2 as
history. *(Rev 3: one ruling added — **OD-UR-13**, decided by the owner during UR-3 and implemented there; everything else
in this section is as recorded in rev 2.)* *(Rev 4: **OD-UR-10** moved from OPEN to DECIDED — documentation only; its
implementation is pending, UR-F20.)* *(Rev 5: **OD-UR-5 (a) and (c)** and **OD-UR-6** moved to DECIDED — documentation
only; **OD-UR-5(b) stays OPEN**.)* *(Rev 6: the owner clarified OD-UR-5(a) — the cured train's provenance, and why the
Blood Price changes no phase; see its row. No ruling moved.)* *(Rev 7: **OD-UR-5(b)** and OD-UR-6.1's per-train question
moved to DECIDED — documentation only; **nothing remains OPEN**.)* *(Rev 8: **OD-UR-5 implemented** — UR-4; no ruling
moved, and none was re-opened.)*

### DECIDED

| OD | ruling | settles | implementation |
|---|---|---|---|
| **OD-UR-1** | **1-A — automatic.** A Yellow Sign stage is an automatic, derived consequence of the authoritative run, **not** a discretionary second player action. A player or client may not omit it, delay it, redirect it to another corporation or manufacture it. On pinned (authoritative) tables the game authority resolves the stage from the run and its committed seed and result. The client-sent request is **removed as a source of authority** — it is not merely repaired — which closes the architectural cause of UR-F1 and UR-F2. | UR-N27, X9, R6, R8, R13; UR-F1, UR-F2 (and UR-F6's mechanism) | UR-3 |
| **OD-GR-3** | **3a = A2 — final result "never".** The Mark judges the corporation's fleet **after** the Run → Dividends settlement; Gentle Rust's Final Run destruction happens at that settlement, before the Mark chooses a train. A reprieved / Final Run train is **never** eligible for the Mark. **OD-GR-3b and OD-GR-3c are moot, not deferred.** No exception lets the Mark take, monetize or replace a Gentle Rust destruction. Reducer authority, route attribution and narration must all follow the post-settlement fleet: **UR-F5 and UR-F6 are bugs against this rule, not evidence for changing Gentle Rust semantics.** D-36 / GR-S26 are closed as an owner-decided interaction (§7.3). | UR-N31, UR-N37, X2; UR-F5, UR-F6; P-H's path | UR-3 |
| **OD-UR-2** | **N+1 + boundary.** 2.1 deadline **N+1**: a doom trigger in Operating-Round set N lets the gilded train survive through the whole next set, N+1. 2.2 removal **at the boundary**: the train disappears automatically at the **end** of set N+1 — an authoritative OR-set-boundary transition, **not** a run stage and **not** a Yellow Sign client request. So: no extra post-deadline run; no indefinite survival because the corporation never operates again; no post-deadline window to sell it before a run. It combines #1089's "next full set" lifespan with S9-3's removal at a set boundary; **#1092's run-triggered collection is superseded. Do not restore the current `N+1 + on-run` behaviour.** Narration / UI may need its own boundary notice later. | UR-N45, UR-N46, §1.2 item 1, UR-F11 (expiry half); new **UR-F18** | UR-3 (fog authority and removal location); the notice in UR-6 |
| **OD-UR-3** | **3-A.** Synthetic (gifted) Carcosa trains **do not advance the game phase**; the phase follows REAL trains. A gift above the current phase may exist and operate early, but by itself it does not change the phase, rust trains, mark trains for Gentle Rust, open the next depot shelf, advance the 18XX+ era, receive Phase Rusher treatment or trigger any ordinary phase-change consequence. When the first REAL train of that tier is bought, the normal phase change happens then. This keeps #1672's gift rule and #1046's expectation that the gift changes nothing beyond the recipient's own fleet. A synthetic D is still not a real D purchase. | UR-N39, UR-N44, X4, X5; UR-F4 | UR-4 |
| **OD-UR-4** | **4-A — minted.** The Mark's half-face-value treasury award is found money, created outside the Bank; it is not paid by the Bank. The money-conservation exemption (`MINTS_BY_DESIGN`) is **intended variant law, not an unresolved defect**. This also governs the award's source for any future rule that reuses the Mark's award. | UR-N33, X12; UR-F10 closed as intended | no gameplay change; the exemption's stale comment (Appendix B item 11) is corrected in a later slice |
| **OD-UR-5 (a), (b), (c)** *(rev 5 — (a), (c) ruled 2026-09-24; (a) clarified rev 6; **(b) ruled rev 7 — OD-UR-5 fully DECIDED**)* | **(a) 5a-1 — the Blood Price buyer's train is ORDINARY.** A train acquired through the Blood Price becomes an ordinary train for the buyer: the supernatural / gilded / Carcosan status is cured by the Blood Price. It is an **additional ordinary train**: the synthetic Carcosa gift becomes one more ordinary train in circulation — effectively **+1 relative to the printed depot supply** — and **not** a special class of train, nor one that keeps any special exemption (the owner's informal "bonus train" means only this). After the acquisition it is ordinary: it counts against the buyer's train limit; runs normally; rusts normally; can later be sold normally; can be a Diesel trade-in if otherwise eligible; and has no fog deadline, no gilding, no Carcosan train-limit exemption and no other supernatural status. *(Rev 6 — the owner's clarification, which closes rev 5's phase question for UR-4; no owner decision remains on it:)* the train keeps only the provenance / accounting marker needed to remember that it originated synthetically rather than consuming one of the printed Depot copies, and that provenance means only the +1 — **synthetic origin / supply provenance may persist; supernatural rules status does not** (it ends at the Blood Price). The Blood Price changes no phase for the base game's reason: it is an **intercorporate train purchase, not a purchase from the Bank / Depot**, and the phase change, rust and the other first-train consequences are triggered by the qualifying Depot purchase — so it advances no phase, triggers no rust, creates no Gentle Rust marks, opens no new Depot tier, advances no 18XX+ era and does not start the real-D doom trigger merely because the train is a D. That is **not** because the cured train stays supernatural; no new gameplay exception is required (§12.2). **(c) 5c-2 — the sale names the copy.** If the selling corporation owns a gilded copy and an ordinary copy of model X, the sale must distinguish which copy is sold: selling the ordinary copy does **not** trigger the Blood Price and does not purify or remove the gilded copy; selling the gilded copy **does** trigger the Blood Price. **(b) — the BUYER only** *(rev 7)*. When a corporation buys the gilded train through the Blood Price, the buyer pays the cash price and **the buyer's stock marker moves Left 1 / Down 1**; the seller gets **no** separate stock-price movement — the seller's benefit is its release from the Carcosan curse / supernatural burden. The market penalty is **never** applied to both corporations. This follows S9-3's "The purchasing corporation pays the required Blood Price consequences" and **supersedes #1090's "Left 1, Down 1 market movement for the selling corporation" — today's implementation; do not restore the seller move** (UR-F22). | UR-N50, UR-N51 (rev 7), UR-N52 (rev 6), UR-N54; §1.2 items 2 and 3; UR-F11 (closed rev 7); UR-F21; UR-F22 (rev 7) | (a) is today's behaviour (#1090; GHL E) — UR-4 pins it live, keeping the +1 supply accounting while the cured train is otherwise ordinary (rev 6 — §12.2); (c) not implemented — UR-4 (UR-F21); (b) not implemented — UR-4 (UR-F22; the copy in UR-6) *(rev 8: **implemented — UR-4**: (a) pinned live, with the +1 carried through the Bank Pool; (c) UR-F21 fixed; (b) UR-F22 fixed, the directly affected Blood Price copy with it — "UR-4 implementation (rev 8)")* |
| **OD-UR-6** *(rev 5 — ruled 2026-09-24; 6.1's per-train question ruled rev 7 — OD-UR-6 fully DECIDED)* | **6.1 — actual paid revenue (DECIDED IN PRINCIPLE; completed rev 7).** Revenue statistics reflect the revenue actually paid after the Unpredictable Revenue die adjustment, not merely the printed pre-die total; corporation / turn-level revenue statistics use the paid figure. The die modifies the corporation's whole turn total, so a statistic that needs a per-train adjusted value has no canonical allocation: ~~that allocation is an **isolated, still-open sub-question of 6.1** — neither the printed figure nor a proportional split is adopted by default~~. *(Rev 7 — the per-train question DECIDED:)* **individual train / route statistics use the PRINTED value of that train's successfully completed route**: the die modifies the corporation's whole turn total, no canonical adjusted dollar amount belongs to an individual train, and the printed route value is the actual route-specific quantity. It is **not an allocation of the paid total** — no proportional, equal or die-adjusted per-train value is invented. So corporation / turn-level revenue statistics use the paid revenue, and train / route statistics use the printed completed route. **6.2 — a Mark-nullified route does not count as earned.** A train whose route the Mark nullified did not earn that revenue (the owner: "the train disappeared instead of completing the run; it never made it to the station"). *(Rev 7, with 6.1's per-train rule: a completed route contributes its printed value to the per-train statistics; a Mark-nullified route contributes nothing.)* **6.3 — a synthetic Carcosa gift is NOT a purchase.** The gift counts for no purchase-count statistic, no "bought a Diesel" statistic, and no purchase-based accolade (The Early Adopter and analogous purchase-derived awards). A later acquisition of the formerly gilded train by another corporation through the Blood Price **IS** a genuine train purchase by the buyer and receives ordinary purchase-based statistical / accolade treatment — Diesel-purchase treatment included, when the train is a Diesel and the award otherwise qualifies (it follows 5a-1). Derived history only — no version effect. | UR-N58, X11; UR-F8; §10 | UR-5 (not implemented) |
| **OD-UR-7** | **7-A — refused.** A gilded / Carcosan train may **not** be a Diesel trade-in. Buying a Diesel normally stays legal; trading in an ordinary, non-gilded eligible train stays legal (the analogue of Gentle Rust's D-35). If the corporation also owns an ordinary copy of the gilded train's model, the implementation must keep that copy tradable rather than forbid every copy of the model. **Copy-selection architecture is not designed here.** | UR-N42, X6; UR-F17 | UR-4 |
| **OD-UR-8** | **8-B — the Easter egg stays.** The Rules Reference discloses what a player needs for informed decisions — the Unpredictable Revenue die and rounding already meant to be known, a gilded train's train-limit treatment, its eventual disappearance, and the Blood Price's consequences once OD-UR-5 is decided *(rev 7: it is — the OD-UR-5 row)* — but **not** the Yellow Sign's hidden trigger conditions or odds merely for completeness. | UR-N60, X15; UR-F13 | UR-6, after OD-UR-5 *(rev 7: decided)* |
| **OD-UR-9** | **9-B — implementation deferred and routed.** Hosted authoritative revenue seeds should ultimately come from a **cryptographic** random source rather than `Math.random`. Recorded seeds already make replay deterministic; this is ingress / security, **not** a replay-semantic gameplay change. Implementation belongs to the later **AWS / live multiplayer / security** work — backlog: the Stage-10 forward roadmap, item 4, the destination the routing map also uses for "pre-deposit security readiness"; no narrower security slice exists — and it is **not** done during UR gameplay certification. The separate seat-token `Math.random` issue (Appendix C) stays recorded beside it. | UR-N15, R12; UR-F16 | AWS / live multiplayer (outside UR) |
| **OD-UR-10** *(rev 4 — ruled 2026-09-24)* | **10-C — round ties toward printed.** "When the modified Unpredictable Revenue amount lands exactly halfway between two $10 increments, round toward the corporation's original printed revenue." If the exact modified amount is not a $5 tie, it rounds normally to the nearest $10; if it IS an exact $5 tie, the adjacent $10 value closer to the original printed revenue is chosen. Printed $50: −10% = $45 → $50, +10% = $55 → $50. Printed $150: −10% = $135 → $140, +10% = $165 → $160. Printed $250: −10% = $225 → $230, +10% = $275 → $270. The owner's rationale: damp the die's volatility at low revenue values; stabilize the effect at higher values; preserve symmetry around the printed revenue; eliminate the current half-up upward bias. **Replaces** the implementation's ordinary half-up rounding of exact ties. A gameplay / replay-semantic change for the deliberate 9 → 10 boundary. **Not implemented** (UR-F20). | UR-N6; §8.2; UR-F20 (new) | UR-7 (the rounding table and the tie rule); the v10 boundary at UR-8 |
| **OD-UR-11** | **11-A — accepted.** An undo of a committed run reveals the reused die result before the re-run; that is accepted. The rule that an undo reuses the same draw remains authoritative. **No Unpredictable Revenue undo restriction** is added; the ordinary route-authority constraints (S6-3's demonstrated-shortfall rule) keep preventing opportunistic weaker re-runs where they already apply. | UR-N18, R2; §5.4 | none |
| **OD-UR-12** | **12-A.** The canonical player-facing name is **Unpredictable Revenue**; later "Unpredictable Routes" copy is normalized to it. Copy only. | UR-N59; UR-F14 | UR-6 |
| **OD-UR-13** *(rev 3 — ruled during UR-3, 2026-09-24)* | **Removed from the game; the phase is monotonic.** "A train taken by the Yellow Sign Mark is PERMANENTLY REMOVED FROM THE GAME. It does NOT: return to the depot; enter the Bank Pool; become purchasable again; increase available depot stock." The corporation still receives the Mark award already decided under OD-UR-4. **Invariant:** "PHASE PROGRESSION IS MONOTONIC. Once a phase has been reached by the qualifying REAL train purchase, later removal of trains cannot lower the phase, reopen an earlier train tier, undo rust, undo Gentle Rust effects, close a depot shelf, or reverse an 18XX+ era transition" — regardless of the removal mechanism (the Mark, ordinary rust, Gentle Rust destruction, fog, discard, any other). For UR-3: fix the Mark narrowly — a durable, authoritative removed-from-game representation sufficient for replay and depot accounting; no silent reappearance as depot stock; the phase stays; replay reproduces the removal; statistics keep classifying the train `taken`; **no Bank Pool destination is invented**; a broader phase-regression defect outside the Mark path is reported, not fixed in UR-3. | UR-N31, UR-N33; UR-F19 | UR-3 (done — "UR-3 implementation (rev 3)") |

### OPEN (later owner review — nothing here decides them)

* ~~**OD-UR-5 — the Blood Price:** (a) whether the buyer receives an ordinary or a still-gilded train; (b) whose share
  price moves; (c) identical-model copy handling. §1.2 items 2 and 3 stay unresolved.~~ **DECIDED (rev 7)** — (a) 5a-1,
  (b) the buyer only, (c) 5c-2 (the DECIDED table above). *(Rev 5: (a) and (c) are DECIDED —
  the DECIDED table above — and §1.2 item 2 with them. **(b) stays OPEN** (§1.2 item 3). As context only, not a ruling:
  the owner currently leans toward the buyer taking the stock-price hit, because "the buyer pays the Blood Price" reads
  more cleanly, and still goes back and forth between buyer and seller.)* *(Rev 6: the owner clarified (a) — the cured
  train's provenance and the phase; no owner question remains there. (b) is unaffected and stays OPEN.)*
* ~~**OD-UR-6 — statistics / accolades:** printed or paid revenue; whether a Mark-nullified run counts; gifts versus real
  purchases.~~ **DECIDED (rev 5)** — 6.1 paid revenue (in principle; the per-train allocation is an isolated open
  sub-question), 6.2 and 6.3 (the DECIDED table above).
* ~~**OD-UR-10 — rounding ties:** half up (current) or an unbiased tie rule.~~ **DECIDED (rev 4): 10-C** — an exact tie
  rounds toward the printed revenue (the DECIDED table above).

*(Rev 7: **nothing remains OPEN** — every owner decision in this audit is DECIDED.)*

### What the rulings unblock

**UR-3 is unblocked.** It now has every owner ruling it needs for UR-F1, UR-F2 and UR-F3, for the Mark × Gentle Rust
timing (OD-GR-3) and for the fog's authority and removal location (OD-UR-2). None of the three open decisions touches
UR-3. UR-4 has OD-UR-3 and OD-UR-7 but still needs OD-UR-5 for its Blood Price part; UR-5's statistics need OD-UR-6; UR-6's
Blood Price copy needs OD-UR-5; UR-7's rounding evidence needs OD-UR-10 (§15). *(Rev 4: OD-UR-10 is decided — 10-C;
UR-7 now implements and evidences the tie rule, UR-F20.)* *(Rev 5: OD-UR-5 (a) and (c) and OD-UR-6 are decided — UR-4's
Blood Price part waits only on (b); UR-5's statistics have their basis, with 6.1's per-train allocation isolated; UR-6's
Blood Price copy waits on (b).)* *(Rev 7: **every owner decision is made** — UR-4 (the Blood Price: UR-F21, UR-F22), UR-5
(the statistics: UR-F8), UR-6 (the Blood Price copy) and UR-7 (the constructed game G1, the tie rule) have **no
owner-decision blocker**; what remains is implementation and certification evidence.)*

Two planning notes for UR-3 — **scope and sequencing, not missing rulings**:

* The rulings govern pinned (authoritative) play. Unpinned Firestore / local rooms are non-authoritative by design and
  slated for retirement (S10-11); UR-3's plan should say whether they keep the legacy request path (still affected by
  UR-F1) or have their client dispatch repaired. The development corpus is unpinned and must keep replaying as stored.
* Today no stage reaches a hosted board (UR-F1). Once UR-3 lands, the Mark and Carcosa will, so UR-F4 (a gift above the
  phase) and UR-F17 (a gilded trade-in) become reachable in live hosted play until UR-4 lands. Both are decided
  (OD-UR-3, OD-UR-7), so UR-4 can follow directly; whether the two land together is the owner's sequencing choice.

## UR-3 implementation (rev 3, 2026-09-24 — COMPLETE: owner-gated, committed and pushed as `9d0cf3a`)

**Scope, as the owner's UR-3 brief set it:** the authoritative run-bound Yellow Sign (OD-UR-1), the Mark after the
settlement (OD-GR-3), the fog at the end of N+1 (OD-UR-2), the variant gate, the breakdown from the authority's pairing,
and — because UR-3 makes them reachable on hosted boards — UR-4's UR-F4 (OD-UR-3) and UR-F17 (OD-UR-7); and, by the
owner's ruling during the slice, the Mark's taken train (OD-UR-13, UR-F19). **Not in scope and not touched:** the Blood Price (OD-UR-5), the statistics' basis (OD-UR-6), rounding ties (OD-UR-10), OD-UR-8 / -9 / -12,
the constructed certification game, the version bump. `RULES_ENGINE_VERSION` stays **9**.

### The design chosen — §12.2's option (a), atomic with the run

* **`settleRunYellowSign` (`sandboxSession.ts`)** is the last step of an ACCEPTED `RunMultipleRoutes` entry: after
  `settleOperatingCursor` (the Run → Dividends settlement, where a Gentle Rust Final Run train is destroyed) and before
  `settleBankruptcy`. It runs only on a **pinned table playing Unpredictable Revenue** (`automaticYellowSignInForce`), and
  only when the run arm raised `routes_run_this_turn` (a value test, never object identity — S7-17). It reads the run's
  committed `revenue_seed` (#1051, server-minted at ingress, #1662) off the board and **never draws**; a replay reaches the
  same stage from the same committed run. There is no new message, no new draw and no schema change.
* **`resolveYellowSign(.., { run: true })`** is the resolution the run owes: no fog stage (OD-UR-2), no waiver, and the
  Mark's candidates are the settled fleet's unreprieved copies (OD-GR-3 — a Final Run train is never a candidate; if the
  settlement left nothing, no Mark fires and its line stays in the pool, #1046).
* **`applyYellowSignOutcome(.., { fleetAsRun })`** applies it with the existing arms; `runWithoutTrain(.., fleetAsRun)`
  aligns the settled fleet back onto the fleet as it ran, so the Mark nullifies the taken train's own route (UR-F5). It
  writes **`last_run_yellow_sign`** on the corporation — `{ stage, model, award, nullified }` — which the narration
  (`narrateRunYellowSign`, UR-F6), the fleet-loss diff (`describeFleetLosses`) and the statistics (`gameHistory.ts`) read
  instead of re-deriving. Turn-scoped (#777's clear); absent on every unpinned board and every table without the variant.
* **The client request is retired on pinned tables.** `yellowSignRequestRefusal` is asked at ingress (`turnRefusal`, after
  the four holds, so a held board answers with its hold's sentence), by the reducer's gate (by identity, before any arm or
  settle stage), as the `YellowSignEvent` arm's second lock, and by the shell's refusal line (`refusalReasonFor`). On a
  pinned table **without** the variant the sentence says so (UR-F3). The shell dispatches no request on a pinned board
  (its three legacy dispatches are behind `!signPinned`), so nothing is sent from the drain (UR-F1).
* **The breakdown from the authority's pairing (UR-F7)** — on pinned Unpredictable Revenue tables the run's breakdown is
  `evaluateRouteSet`'s own runs (slot, model, figure), with or without `train_indices`; identical to #1031's whenever the
  message names the slots (the normal client always does). Every other table keeps #1031's rule.
* **The fog (OD-UR-2, UR-F18):** `fogAtSetEnd` / `fogDueAtSetEnd` (`yellowSign.ts`), called first in
  `settleRoundTransitions`' end-of-set branch — before all three exits (the Stock Round, the delayed auction, the
  bank-broken `GameEnd`) — with `macro_round_number` still naming the set that ended: a gilded copy whose deadline is
  `<=` that set leaves (multiset: one train, its gilding and its provenance per gilding), the clock clears, the curse stays.
  Gated on the variant, on pinned **and** unpinned tables (the corpus has no gilded train — measured). Never a run stage.
  The Activity Log gets a minimal line (`describeFogAtSetEnd`: *"The gold-trimmed train disappeared back into the fog.
  C&O lost its gold-trimmed D-train."*); the fleet-loss diff leaves it out of rust / discard (`fogCollected`); the
  statistics book it as `taken` and as a stage on its bearer. The fog's formal notice (modal / sound / film) is UR-6's.
* **UR-F4 (OD-UR-3):** `derivePhase` skips ghost-accounted copies (multiset, the depot tally's own walk) before the phase
  is read, on every table: a gift above the phase no longer turns the phase, the era, the shelf, rust or Gentle Rust
  marks; the first REAL train of the tier does; a gifted D no longer masks the first real D's doom trigger; Phase Rusher
  is not credited. Consequence stated, not decided: a synthetic train carries its provenance through a Blood Price
  (#1673), so it does not advance the phase at the buyer either — what OD-UR-5 rules about the buyer's train is open.
  *(Rev 5: OD-UR-5(a) rules the buyer's train ordinary — 5a-1 — and names its "+1 relative to the printed depot supply",
  which is this provenance's depot effect.)* *(Rev 6: the phase question rev 5 left here for UR-4 is **closed** by the
  owner — no owner decision remains. The Blood Price changes no phase because it is an intercorporate purchase, not a
  Bank / Depot purchase — the base game's reason — and not because of the provenance or a supernatural status; the
  provenance is only the +1 supply accounting — §12.2, OD-UR-5.)*
* **UR-F17 (OD-UR-7):** `exchangeableTrains` subtracts the gilding multiset beside the Gentle Rust marks; the refusal
  names it (*"C&O's 6-train is gold-trimmed by Carcosa — a gilded train cannot be traded in for a Diesel."*); an ordinary
  copy of the same model stays tradable; buying a Diesel outright stays legal. Atomic: the reducer's gate returns the board
  by identity, a hosted room answers `refused` with that sentence and appends nothing (#1685), no Bank Pool or narration
  or statistics effect. The panel offers no gilded copy and shows the sentence when none is left (a greyed gilded chip in
  GR-3's U-11 manner is not built — UR-6).

### Finding status (rev 3)

| id | status | evidence (durable, `frontend/src/utils/`) |
|---|---|---|
| UR-F1 | **FIXED** on pinned tables — the stage is part of the run's entry; nothing is dispatched from the drain | `yellowSignRunBound` (reducer + `RoomSession.submit`, restore, replay, undo); source pin on the three `!signPinned` dispatches |
| UR-F2 | **FIXED** on pinned tables — omission, delay (P-G1′), wrong target (P-D), post-self-trigger (P-H), duplicate, off-step and Stock Round requests all refused, hosted and in the reducer | `yellowSignRunBound`, `yellowSignAuthority` (rewritten: no request moves a pinned board) |
| UR-F3 | **FIXED** on pinned tables (ingress + reducer; the run draws nothing) | `yellowSignRunBound` P-A, `unpredictableRevenueStandardControls` |
| UR-F4 | **FIXED** (every table) | `carcosaSyntheticPhase` (standard, Gentle Rust, LPF 6/7/D, 18XX+ era, run-delivered gift), `stage95GhostLimit` / `batch48` (contract updated) |
| UR-F5 | **FIXED** on the run path | `yellowSignRunBound` (P-C: the 3's route nullified, not the retired 2's) |
| UR-F6 | **FIXED** on the run path — narration, fleet-loss notices and statistics read the record | `yellowSignRunBound`, `yellowSignRunBoundStats` |
| UR-F7 | **FIXED** on pinned Unpredictable Revenue tables | `yellowSignRunBound` (P-J) |
| UR-F15 | **OPEN** (INFO, optional) — a pinned seedless run still falls back to `legacyTurnSeed`; unreachable through the server, which always mints; not taken (it would change the reducer contract fixtures rely on for no reachable gain) | — |
| UR-F17 | **FIXED** (every table; only an Unpredictable Revenue table can hold a gilding) | `carcosaGildedExchange` ($800 and LPF $750, hosted, multiset, Gentle Rust + gilding) |
| UR-F18 | **FIXED** (Unpredictable Revenue tables, pinned and unpinned) | `carcosaFogBoundary` (a hosted timeline through set N, the Stock Round and every entry of N+1; the boundary exactly; multiset; a corporation that never operates; bank-broken `GameEnd`; after a Blood Price; no run or request collects it), `stage95GhostLimit` (the removal asked of both paths) |
| **UR-F19** | **FIXED** under **OD-UR-13 (DECIDED)** on pinned Unpredictable Revenue tables — the run-bound Mark writes `removed_trains`; `derivePhase` / `depotInventory` read it (below); unpinned residual recorded | `yellowSignMarkRemoval` (19: the only 3 in play taken; phase 3 and phase 4 monotonic — label, era, limit, rust; no earlier tier reopens; never purchasable — a Bank Pool purchase refused in the reducer and at hosted ingress; depot stock unchanged; hosted replay, restore and undo; Gentle Rust; variant-off and unpinned controls), `yellowSignRunBoundStats` (+2: still `taken`; no Phase Rusher / rust-cause credit) |

**Reproduced before fixing.** The seven new suites (six for UR-3's first cut, one for OD-UR-13) were run against the
untouched baseline (`661bf34`): **67 of their 92 tests fail there and 25 pass** — the 25 are the negative controls and the
unchanged properties (a quiet draw, the standard game, timing before the deadline, the statistics' unchanged basis,
determinism, a refused Bank Pool purchase), plus two depot readings the baseline meets only because its Mark never lands
(UR-F1). The 21 OD-UR-13 tests (19 in `yellowSignMarkRemoval`, 2 in
`yellowSignRunBoundStats`) were also run against the UR-3 tree **without** the removal record: **17 fail and 4 pass** (the
two variant-off controls, the refused Bank Pool purchase and the unpinned legacy branch). All 92 pass on the tree.

**UR-F19 (MEDIUM — rules state; pre-existing since #1046, newly reachable) — FIXED under OD-UR-13.** As found: the Mark
removed the taken train from `owned_trains` and put it nowhere. The depot is derived (TOTAL − owned − pooled for the
current tier) and the phase is the highest tier owned or pooled, so when the taken train was of the phase's own tier it
returned to the derived supply as phantom stock, and when it was the only train of that tier in play **the phase fell
back a tier**. Probe (UR-3 tree before the fix, phase 3, C&O holding the only 3, a Mark draw on its $70 run): phase 3 →
**2**, the 3-row `remaining` 4 → **5**, the open depot tier `3` → **`2`** (the depot offered 2-trains again, and from
the next entry the era read Yellow again); the statistics then credited the run's actor with a "phase move". The same
happened on the legacy request path, which never landed in a room (UR-F1); UR-3 made the Mark land on hosted boards, so
it became reachable (rare: once per game, phases 2–4, only when the cheapest train is of the phase's tier — typically
the only train of that tier in play). It was first recorded as needing a ruling (OD-UR-13, options below); the owner
ruled during the slice.

* **OD-UR-13 — DECIDED 2026-09-24** (the ruling is in the DECIDED table above). The options it chose between, kept as the
  record: (a) removed from the game but still "bought" — counts toward the phase and off the depot, as a pooled train does
  (#1530: "a train in the Bank Pool was bought, so the phase it began has begun"), the phase never regresses; (b) returned
  to the depot as stock (the derived effect, including the regression); (c) other. **Chosen: (a), without a Bank Pool
  destination, plus the monotonic-phase invariant for every removal path.**

**The fix (narrow, the Mark only).**

* **The representation — `removed_trains`** (`GameStateResponse`, optional and additive, one entry per taken copy by
  model, in the order taken). Written by the **run-bound Mark** (`applyYellowSignOutcome` on the run path — pinned
  Unpredictable Revenue tables), in the run's own entry beside the Mark's other effects. It is **not** the Bank Pool:
  `returned_trains` is untouched, and no seller reads the new list — `openDepotTiers`, `purchasableTrains`,
  `bankPoolTrains` and the pool purchase (`buyReturnedTrain`) read only the depot and the pool, so the taken copy is never
  on sale (a `BuyHardwareFromPool { returned_model_type }` for it is refused by the reducer and, as an atoms-unchanged
  answer, at hosted ingress).
* **The depot and the phase (`gamePhase.ts`).** `removedTrainsByTier` mirrors `pooledTrainsByTier`. `derivePhase` counts a
  removed train toward `highest` exactly as it counts a pooled one (#1530's argument: it was bought, so the phase it began
  has begun) — so the phase, and with it the era (`settleEra`), the train limit, the rust flags, the shelf and the next
  purchase's "phase change" test, cannot fall back because of the Mark; `depotRemaining` and `depotInventory` (queue and
  open-shelf branches) subtract it beside the pool (#1512) — so the depot never takes it back. The Carcosa gift reads the
  same depot (`openDepotTiers`), so a later gift is the monotonic depot's lowest tier.
* **Replay, restore, undo.** The Mark is re-derived from the run's committed seed on every replay, so the record is
  re-written identically; an undo past the run removes it with the rest of the entry's effects. No new message, no
  migration, no new draw; a board without such a Mark carries no field at all (#232), so every existing board and log
  reads exactly as before.
* **Statistics.** Unchanged classification — the taken train is `taken` (#1431), read from `last_run_yellow_sign`; with the
  phase monotonic the Mark's entry is no longer read as a phase move (Phase Rusher, `rustCauseByTier`).
* **Not written by the legacy branch.** An unpinned board's stored Mark (the corpus's JUNO-Z6C 203) and a live unpinned
  request keep #1661's behaviour byte for byte — see the residual below.

**The monotonic invariant — the other removal paths, checked (no broader defect found).** OD-UR-13's invariant covers
every removal mechanism; the ruling asks for a broader pre-existing regression to be reported, not fixed here. None was
found:

* **Ordinary rust** (`applyPhaseChange`) removes only the tiers the arriving tier rusts — strictly below it — in the same
  entry that delivers the arriving train, so the phase rises.
* **Gentle Rust destruction** (the Final Run at Run → Dividends, the grace turn, the pool scrap) removes only marked copies
  of tiers already rusted — below the phase.
* **The president's discard** (#1530) and **the Diesel trade-in** (#1303) put the train in the Bank Pool, which
  `derivePhase` counts; the trade-in also delivers a D (pinned since #1530: `trainDiscard` case 12, "a discarded
  phase-changer keeps the phase").
* **A corporation-to-corporation sale / the Blood Price** moves the train between fleets (a synthetic copy's provenance
  travels with it, #1673) — conserved.
* **The fog / doom removal** (the OD-UR-2 boundary and the legacy arm) removes a gilded copy, which on the current reducer
  is always ghost-accounted (the gift writes both lists; #1672 no longer expires the marker) — and OD-UR-3 already keeps
  ghosts out of the phase (`carcosaSyntheticPhase`).
* **Bankruptcy** (6.7) ends the game and removes nothing.
* **Measured:** the 18-file corpus's known phase at every engine application, on both trees — **0 decreases** in 3,763
  applications (§16, rev 3).

**The unpinned residual (recorded, not fixed — S10-11).** Unpinned boards keep the legacy request path byte for byte,
because the development corpus's stored `YellowSignEvent` entries (JUNO-Z6C 203 and 567) must replay to the boards they
were played on. A **Firestore room deals unpinned**, so on a live Firestore room: the shell still narrates the Sign from
the drain and dispatches the request (UR-F1: refused there by #1407's catch-up guard, as before), a crafted client could
still send, delay, aim or omit one (UR-F2), a standard-table request is not refused by a variant gate (UR-F3), and the
legacy request's Mark still judges the pre-settlement fleet in the narration (UR-F5 / UR-F6); and **the legacy Mark
writes no removal record (OD-UR-13)**: it takes the train as it always did, so UR-F19's phase regression and phantom
stock remain possible on an unpinned board — reachable there only through a crafted request or a stored legacy Mark,
since the normal client's request is still refused by the drain's catch-up guard (measured: no corpus file shows one — 0
phase decreases in 18 files). Writing the record there would change what a stored unpinned Mark replays to. The fog
(OD-UR-2), the phase (OD-UR-3) and the trade-in (OD-UR-7) fixes apply there too. Firestore rooms are non-authoritative
by design and slated for retirement (S10-11, routed to the AWS / live multiplayer transition); no shared automatic
resolution was built for them, because it would need a discriminator the stored corpus does not carry, i.e. a
reinterpretation of unpinned logs.

**Corpus (18 files, measured old vs new).** Scratch builds of the baseline and of the tree, each compiled with
`server/tsconfig.json` and a scratch reconciliation script; every file replayed under `DEVELOPMENT_CORPUS_POLICY`,
recording per engine application the pre-entry state digest, grid hash, cursor and derived-action answer, then the finals.
See §16 (rev 3) for the figures.

---

## UR-4 implementation (rev 8, 2026-09-25 — uncommitted, awaiting the owner's full repository Jest gate)

**Scope, as the owner's UR-4 brief set it:** OD-UR-5 — (c) the copy-specific sale (UR-F21), (b) the buyer-only market
movement (UR-F22), (a) the cured train's ordinary treatment pinned live — and the +1 supply provenance through the cured
train's whole lifecycle; The Redeemer's narrow coupling to the same model-level predicate. **Not in scope and not
touched:** UR-5's statistics (UR-F8, UR-F9 — OD-UR-6), UR-6's copy / UI / Rules Reference work beyond the Blood Price
surfaces this slice changes (UR-F12, UR-F13, UR-F14, Appendix B), OD-UR-10's tie rule (UR-F20), the constructed
certification game (UR-7), the version bump (UR-8). `RULES_ENGINE_VERSION` stays **9**. Starting point: local `main` =
`4b937a45ee8402723e4d5be12649dae3c199c748` ("Finalize Unpredictable Revenue rulings"), one commit ahead of `origin/main`
(`9d0cf3a`), the tracked tree clean (only the pre-existing untracked `.claude/`); nothing committed or pushed.

### The design

* **Copy selection — one optional boolean, multiset semantics, no train identity.** `BuyTrainFromCorporation` and
  `ProposeTrainPurchase` gain `gilded?: boolean` (schema `"bool?"`, shape-checked at hosted ingress); the offer
  (`train_purchase_offer.gilded`) carries it and the derived settlement copies it — only when present, so an offer that
  names no copy derives the settlement every offer derived before, key for key (#232). Copies of one model differ only by
  two multiset marks the seller already carries: the gilding (`carcosan_trains`) and a Gentle Rust reprieve (already off
  the market, GR-2). So the one question a sale can leave open is "the gilded copy or an ordinary one".
  `trainSaleAuthority.ts` (`saleCopies`, `resolveSaleCopy`, `saleCopyRefusal`): `gilded: true` needs a gilded copy,
  `gilded: false` an ordinary (ungilded, unreprieved) one; **absent** is legal only where it cannot be ambiguous (only
  gilded copies of the model → the Blood Price, as it always was; no gilded copy → the ordinary sale); absent while both
  kinds are held is **refused** — *"B&O holds both a gold-trimmed and an ordinary 6-train; the sale must name which copy
  is sold (selling the gold-trimmed one is the Blood Price)."* It is asked inside `trainSaleRefusal`, beside "owns the
  train", so the proposal, the answer, the settlement (the reducer's core gate and hosted ingress, `turnRefusal`) and the
  chart step's `isCarcosanSale` refuse it together and nothing moves. Consent (`trainSettlementMatches`) includes the
  copy: a settlement naming the other copy than the accepted offer is not consented (refused; the offer stands).
* **The Blood Price is the GILDED copy's sale.** `isCarcosanTransfer(state, seller, model, gilded?)` answers
  `resolveSaleCopy(..) === "gilded"`; `settleTrainSale(.., gilded?)` burns the gilding, clears the curse and the doom
  clock, and lets the chart move, only then. An ordinary copy sold beside a gilded one moves the train and the money and
  nothing else.
* **Provenance leaves with the copy that has it** (`departingCopyCarriesProvenance`): the gilded copy always takes a
  marker; an ordinary copy takes one only when the fleet holds more markers of the model than gilded copies (a copy an
  earlier Blood Price cured). Before UR-4 the sale moved a marker unconditionally, so an ordinary sale beside a gilded copy
  carried the GILDED copy's provenance away with it (part of UR-F21).
* **The buyer's marker moves (UR-F22).** `applySandboxMarketAction`'s `BuyTrainFromCorporation` arm moves
  `buyer_protocol_id` Left 1 / Down 1 (`projectBloodPriceMove`, stamped by `withArrival`, S9-11) and neither reads nor
  writes the seller's token — one mover, never both. The chart step's report names the buyer, so the Activity Log's
  "*A Blood Price was paid: [Buying Corp]'s stock dropped from $X to $Y*" follows without a shell change.
* **The Bank Pool's provenance (`returned_ghost_trains`).** A new optional state field, a sub-multiset of
  `returned_trains`. The Diesel trade-in and the president's discard move a departing copy's marker, when it has one, into
  it; `buyReturnedTrain` hands one to the buyer when the pool holds a copy of that model (the additional copy goes first —
  the convention the sale and the trade-in follow); the pool's rust filters it with its train (never reached in play). In
  `gamePhase.ts`, `printedPooledTrainsByTier` — the pool minus its provenance — is what the Depot tally subtracts and what
  the phase counts (#1512, #1530), and `realDieselPurchased` ignores a pooled synthetic D; `bankPoolTrains` still sells the
  whole pool (the cured copy is an ordinary train). Absent on every board without an additional copy — the standard game
  and every corpus log — which therefore read byte for byte as before.
* **"One marker, two concepts" — resolved without a split (§12.2, rev 6).** `ghost_trains` has meant only synthetic
  provenance since #1672; the supernatural status is `carcosan_trains` + `is_carcosan` + the doom clock, and the Blood
  Price clears exactly that. The marker's three reads are all supply facts — the Depot tally (the +1), and the phase and
  the real-D check, which ask which printed trains the Depot has sold. The phase reading is the owner's reason made
  derivable (a phase is begun by the qualifying Depot purchase; the Blood Price is an intercorporate purchase of a copy
  the Depot never sold), not a status: the cured train is ordinary for the limit, running, rust, sale, trade-in, fog,
  curse and clock. No field was split and nothing reads the marker as a supernatural status.
* **Every table, pinned and unpinned — no legacy branch.** UR-3's precedent for rules the corpus never exercises (the fog,
  the phase, the trade-in): measured, no corpus file holds a gilded train, a provenance marker or a Carcosan transfer
  (11 stored `BuyTrainFromCorporation`, 0 Carcosan), so no stored entry is reinterpreted — and an unpinned client (a
  Firestore room) cannot reach #1090's model-level sale or seller move either.
* **The Redeemer — the one narrow statistics coupling.** `gameHistory.ts` read "the seller's gilding names the model and
  a copy moved"; it reads the entry's own effect now — the seller's gilding of that model burned by the sale — which is
  the Blood Price and nothing else. The credit stays on the buying president, who pays (OD-UR-5(b)). The Blood Price
  acquisition stays an intercorporate purchase in the history (train spend; the seller's `sold` fate) — OD-UR-6.3's
  "genuine purchase", for UR-5 to build on. Nothing else in the statistics moved.
* **The normal UI names the copy** (the Playtest Readiness gate: a legal action must not need a crafted message). The Buy
  Trains roster marks the gold-trimmed badge (`gildedSalePositions` — the chips' multiset order; a gold border,
  `data-gilded`) and each badge sends its own copy — `gilded: true` / `false` — only when the seller holds a gilded copy
  of that model (otherwise the unnamed sale, byte for byte). The warning reads "*⚠ WARNING: Buying the gold-trimmed
  Carcosa Train incurs a Blood Price. The buying corporation's share price will immediately drop (1 cell Left, 1 cell
  Down).*" and shows only for the gilded copy; the consent prompt tells the seller which copy it is answering for and, for
  the gilded copy, that the buyer's price drops and the seller is released from the curse. The online (contract) path
  never names a copy (the contract has no Carcosa). UI-parity classification: UR-F21 → LEGALITY SYNC / NEW ACTION (the
  copy choice), UR-F22 → STATE VISIBILITY (the warning and the prompt) — both resolved here (backlog Part C, U-42).

### Finding status (rev 8)

| id | status | evidence (durable, `frontend/src/`) |
|---|---|---|
| UR-F21 | **FIXED** (every table) | `utils/carcosaBloodPrice.test.ts` A1–A8, F2, I1, I3, I5, J2; `utils/carcosaBloodPriceStats.test.ts` (The Redeemer); `components/carcosaBloodPricePanel.test.tsx`; `GHL` E (the two-copy case now names the copy), GR-2 S8 (its control names the gilded copy) |
| UR-F22 | **FIXED** (every table) | `utils/carcosaBloodPrice.test.ts` B1–B4, I2, I4, J2; `BPA`, `S103` "the Blood Price (#1090)", `S103b` C, GR-2 S8 control — each now pins the BUYER's move; `B60` pins the warning's buyer wording; `components/carcosaBloodPricePanel.test.tsx` |
| *(new, found and fixed in UR-4)* stale provenance through the Bank Pool | **FIXED** (every table) | `utils/carcosaBloodPrice.test.ts` D2–D6, I6; the standard-game control H4 |

**Reproduced before fixing.** The three new suites (50 tests) were run against the untouched baseline (a scratch mirror of
`4b937a45` whose tree hash, `05f74c68…`, equals the owner's checkout): **30 fail, 20 pass**. The 20 are the baseline
evidence and the controls: 5a's ordinary train (no gilding, curse, deadline or exemption; the limit; running; the second
sale; the trade-in's legality; the +1 across the sale), the phase / real-D negative controls, the fog after the gilded
sale, the standard-game controls, the unnamed offer's derived settlement, the roster without gilding, and The Redeemer on
a gilded sale. All 50 pass on the tree.

### The provenance lifecycle, path by path

| path | before UR-4 | UR-4 |
|---|---|---|
| the Blood Price (the gilded copy) | the marker moves to the buyer (#1673) | unchanged (A3, D1) |
| an ordinary sale beside a gilded copy | the GILDED copy's marker left with the ordinary copy (UR-F21) | stays with the gilded copy (A1, A7) |
| a later sale of the cured copy (the second hop) | the marker follows (#1673) | unchanged (C4) |
| Diesel trade-in of the cured copy (legal: it is ordinary, OD-UR-7 refuses only the gilded copy) | **defect** — the pooled copy counted as a PRINTED train (standard phase 6: the Depot's last printed 6 vanished from sale) and the marker stayed at the corporation, stale, ready to swallow its next copy of the model | the marker moves into the pool with the copy; the printed Depot is untouched (D2, I6) |
| a Bank Pool purchase of that copy | a physical copy, no provenance | the marker moves to the buyer; the printed tally unchanged, including a buy-back by the trader (D3, D4) |
| the president's discard of the cured copy | the same defect as the trade-in — **constructed only**: a cured copy exists only from phase 5, and every limit from phase 5 on is 2 and never falls, so no discard can fall due while one is held | the marker moves into the pool (D5); the pooled synthetic copy is never the phase, a pooled synthetic D never a real D (D6) |
| ordinary rust | never meets a synthetic copy: the gift is the Depot's lowest tier in phases 5 – D, always a 5, 6, 7 or D, none of which rusts (D7) | a real D's arrival rusts the 4s and leaves a cured 6 exactly as an ordinary 6 (D7); the pool's rust filters the pool's provenance with its train (invariant only) |
| the fog | takes only gilded copies, one marker each (#1675, OD-UR-2) | unchanged — the cured copy is never taken (C3, F1) |
| the Mark | phases 2 – 4 only; no synthetic copy exists there | unchanged |
| replay / restore / undo | — | the markers are board state written by the entries: replay and restore reach the same digest; an undo takes them back (I1, I2, I4, I6) |

The stale marker is a concrete defect only through the Bank Pool, and it is intrinsic to UR-4: it became reachable when
5a-1 made the cured train ordinary and so tradable. It is fixed narrowly, by the pool's own multiset; no broader
train-supply architecture problem was found.

### Phase / real-D, fog, standard controls — pinned

* **The Blood Price turns nothing** (E1–E3). A cured 6 above phase 5: no phase 6, no rust of the 3s, no Gentle Rust mark,
  the D shelf closed, the era and the Depot unchanged — until the first REAL 6 from the Depot does all of it. A cured D at
  phase 6: no phase D, no rust (or mark) of the 4s, `realDieselPurchased` false, no doom clock for another gilded
  corporation, no Gray era under the 18XX+ tiles — on the standard, Gentle Rust, 18XX+ and Level Playing Field tables
  alike — until a REAL Diesel (a trade-in) does. An LPF cured 7 is not the phase either.
* **Fog / curse** (F1, F2, C3). The gilded copy's sale absolves the seller (curse, gilding, clock) and no fog is ever
  due; the buyer's cured train survives the seller's old deadline and every later boundary; the seller's REAL same-model
  copy is never taken. The ordinary copy's sale leaves the curse, the gilded copy and the deadline, and the boundary fog
  then takes that copy only.
* **Standard mode** (H1–H4, J3). Variant off, an unnamed sale settles exactly as before — no Blood Price, no market move,
  no marker written; `gilded: true` is refused (there is no gilded copy) and `gilded: false` is the ordinary sale;
  same-model ordinary sales under the variant equal the standard game's; the trade-in, the discard and the pool purchase
  write no provenance field.

### Deferred and recorded (not implemented here)

* **UR-5 — Carcosan Railways under OD-UR-5(b).** Its blurb ("Saw the Yellow Sign and never paid the Blood Price to be rid
  of it") predates the buyer-pays ruling: a seller released by a buyer's Blood Price never pays it. Whether its president
  keeps the accolade is a statistics question for UR-5 (OD-UR-6's pass); the history still excludes only the paying
  (buying) president, exactly as before UR-4 (backlog S9-7, UR-4 block).
* **UR-6 — copy.** The Activity Log's offer and trade lines name the model, not the copy (the panel and the consent
  prompt do); the Rules Reference's Blood Price text (UR-F13: an additional ordinary train, the buyer's marker, the copy
  named).

---

## 0. Baseline

| item | value |
|---|---|
| branch | `main` |
| HEAD | `3f862c4e24a57eb541fb27cc3ffd05402a24a994` ("v9 Gentle Rust closure") |
| `origin/main` | `3f862c4e24a57eb541fb27cc3ffd05402a24a994` — `git fetch` confirms `main -> origin/main` up to date |
| tracked tree | clean; only the pre-existing untracked `.claude/` (a local settings file dated 2026-09-01) |
| `RULES_ENGINE_VERSION` | **9** (`frontend/src/gameEngine/rulesVersion.ts:65`); `SUPPORTED_RULES_ENGINE_VERSIONS` derived `[9]` |
| corpus | all Unpredictable-Revenue logs are **unpinned** development corpus (§5.5) |

Host notes. (1) The audit's first read-only `git status` left a zero-byte `.git/index.lock` (the desktop mount refuses
`unlink` — S10-16's known hazard). With a deletion grant, that exact zero-byte lock was deleted, and every later git
call ran with `GIT_OPTIONAL_LOCKS=0`. (2) To execute the probes of Appendix A against the live reducer and the real
`RoomSession`, five temporary test files (`frontend/src/utils/zzUrAuditProbe*.test.ts`) were created, run and deleted in
this session; they were never staged. At the end `git status --porcelain` shows only `?? .claude/`. No other file was
created or deleted outside the two documents this pass writes.

---

## 1. Authority and sources

### 1.1 The hierarchy, applied to this variant

| level | what it decides for Unpredictable Revenue |
|---|---|
| **A** 2018 revised Lookout rulebook | **Nothing about the variant itself.** It remains the authority for every base mechanic the variant modifies or touches: running and the highest-revenue rule (§6.4), dividends — pay or withhold and the share-price step (§6.5), trains, train limits, excess discards and forced purchase (§6.6 / 6.6.1 / 6.6.2), phases and rust (§2.0 / T-07). |
| **B** full 48-page Lookout/Mayfair rulebook (`1830 FULL RULES with variants.pdf`) | **No counterpart.** Checked for this audit (OCR of pp. 28–33 and 40): the printed variants are Delayed Obsolescence, Delayed Private Company Sales, Permanent 4-Trains, Split Revenues (V-7.1) and others; Scenario **S-5.0 "Uncertain Times"** (p. 40) uses *Economic Uncertainty tokens* flipped on 5-train purchases ("no change", "short runs", "retain revenue") — a different random mechanism, not implemented, and **not** an authority for this variant. Scenario D (S-1.0, "A Level Playing Field") is the authority for the LPF board, trains and prices the variant runs on. |
| **C** Mayfair/Lookout clarifications & errata | Nothing on this variant. |
| **D** explicit owner rulings | **The whole of the variant.** The backlog states it (`RULES_HARDENING_BACKLOG.md:47–48`): "Owner-defined variants (… Unpredictable Revenue / Yellow Sign) have no rulebook counterpart and are judged against the owner's spec." The spec is (i) the rulings quoted in the design notes (§2), (ii) the Stage-9 records S9-1, S9-2, S9-3 (2026-09-19) including S9-3's **"FULL OWNER YELLOW SIGN RULE, recorded verbatim"** (`RULES_HARDENING_BACKLOG.md:1641–1664`), (iii) S9-4 (the Rules Reference is the sole player-facing authority) and (iv) D-36 (OD-GR-3 routed here). |

Rules applied throughout, as in the Gentle Rust audit: later owner rulings supersede earlier ones; code, tests and
player-facing copy are evidence, never authority; a passing test can pin wrong behaviour.

### 1.2 What "the rule" is made of — and where the owner material disagrees with itself

The variant was specified incrementally (#903 → #1672, 2026-08 → 2026-09-19). Most later notes explicitly supersede
earlier ones and the chain is consistent. **Three points are not**, and none of them can be settled by the audit:

1. **The gilded train's expiry.** S9-3's verbatim rule (2026-09-19): "The gilded ghost train disappears at the end of
   the FIRST set of Operating Rounds in which a D train is purchased." The implementation keeps #1089's earlier ruling
   ("will survive until the exact conclusion of the next full set of Operating Rounds after its rust condition is
   triggered") plus #1092's removal on the corporation's first *run* after that set; S9-2 (same day) calls this
   "preserved (#1089 / #1092)". → **OD-UR-2**.
2. **The Blood Price's effect on the train.** S9-3 verbatim: "Its scheduled disappearance remains attached to the ghost
   train even if ownership changes" and "The transferred gilded train remains a ghost train and STILL disappears on
   the same D-triggered schedule." The implementation keeps #1090 ("The train immediately loses its Carcosa/Yellow
   Sign flag and becomes a standard train for the buying corporation") — the buyer's train is ordinary and never
   fogged. → **OD-UR-5(a)**.
3. **Who bears the Blood Price's market consequence.** S9-3 verbatim: "The purchasing corporation pays the required
   Blood Price consequences (cash and corporate stock-price consequence under the existing Project 18XX rule)."
   #1090 (the "existing rule"): "execute the Left 1, Down 1 market movement for the **selling** corporation" — which
   is what is implemented. Ambiguous rather than contradictory. → **OD-UR-5(b)**.

S9-3 itself lists three contradictions "ALL THREE now closed by Stage 9.5's lifecycle pass (#1672)" (the exemption
lifetime, the gift's tier, the doom trigger); the three above were not among them.

*(Rev 2.)* Point 1 is **resolved by OD-UR-2**, and by neither text verbatim: the train keeps #1089's lifespan (through
set N+1) and disappears at a set boundary as S9-3 says — at the end of N+1. #1092's collection on a run is superseded.
Points 2 and 3 remain **OPEN** under OD-UR-5.

*(Rev 5.)* Point 2 is **resolved by OD-UR-5(a) = 5a-1**, for #1090: the buyer's train is ordinary — the implementation —
and S9-3's "remains a ghost train and STILL disappears on the same D-triggered schedule" is superseded. Point 3 stays
**OPEN** (OD-UR-5(b)). *(Rev 6: the "ghost" superseded there is the supernatural status, which ends at the Blood Price;
the synthetic-origin provenance the buyer's train keeps is supply accounting only — the +1 — per the owner's
clarification of OD-UR-5(a).)*

*(Rev 7.)* Point 3 is **resolved by OD-UR-5(b) — the buyer only** — for S9-3's wording ("The purchasing corporation
pays the required Blood Price consequences (cash and corporate stock-price consequence …)"): the buyer's marker moves
Left 1 / Down 1 and the seller's does not. #1090's seller move — the implementation — is superseded (UR-F22). All three
points are resolved.

---

## 2. Decision chronology

Design-note numbers are the project's chronology (`<file> #N`); git history is batch-grained. "In force" means the
current code implements it and no later ruling supersedes it.

| # | kind | substance | status today |
|---|---|---|---|
| #902 | schema ruling | `unpredictableRevenue` is a real `GameVariants` field; absent = standard game; `resolveVariants` is the one decider | in force |
| #903 | REQUESTED | d6 per running train: 1 → 80%, 2 → 90%, 3–4 → 100%, 5 → 110%, 6 → 120%; deterministic so replay agrees; "the seed is the turn, not the action" (undo must not re-roll) | face table **in force**; per-train roll **superseded by #941**; hash seed **superseded by #1051** |
| #907 | impl. | flavour lines, picked deterministically | superseded by #944 / #969 |
| #917 | REPORTED → fix | "the dividend pays what was banked" — the modified figure, not the printed one | in force |
| #922 | REPORTED → fix | per-holder dividend arithmetic for non-multiple-of-10 revenue | moot since #938 (always a multiple of 10) |
| #938 | RULED | "round the total modified route revenue to the nearest $10 before any dividend math or log output"; "completely ignoring the die if the rounding swallowed the modifier" | rounding **in force**; its "per run, not per turn" paragraph superseded by #941 |
| #941 | RULED | "exactly ONCE per corporation's operating turn, applied to the total aggregated printed revenue of all trains combined … scope the RNG seed to the turn identity" | in force |
| #944 / #949 / #969 | SUPPLIED / RULED | 5 outcome buckets (critical/minor malus, unchanged, minor/critical bonus) keyed on the *outcome*, not the face; one consolidated turn sentence; line index `floor(seed/6) % length` | in force |
| #961 (+ its rounding-clause correction) | RULED (copy) | Lobby blurb "Running railways is risky… up to ±20% … rounded to the nearest $10" — the rounding clause kept because "$80 with a 20% malus ends up only paying out $60" | in force |
| #968 | REPORTED → impl. | one `RunMultipleRoutes` per turn (replaces per-route messages) | in force (`RunManualRoute` legacy-replay only, refused on pinned boards #1551) |
| #1044 | SPECIFIED | the Yellow Sign Easter egg (Stage 1 Mark, Stage 2 escalation) — seeded, derived from the log, never `Math.random` | mechanism superseded by #1046 / #1661; rules in force |
| #1046 | RULED | Mark: phases 2–4 only; "loses its lowest value train … award … 0.5x the deleted train's depot value" (corrected from 1.5x); the event fires "even down to zero trains"; escalation: phases 5–D, gift "matching the current phase's tier", "does not deplete the bank's supply", limit-exempt "until the end of the Operating Round" | windows, lowest-value, 0.5x **in force**; zeroing of the other trains **superseded by #1375 / S9-3**; gift tier **superseded by #1672**; OR-long exemption **superseded by #1672** |
| #1051 | REPORTED → RULED | "Unpredictable" must not be predictable: a real 32-bit draw at dispatch, recorded in the log, reused after an undo ("undoing it should not change their roll, otherwise players would just slot machine their way to +20%"); Carcosa 20% as an integer comparison | draw/commit/undo **in force**; client draw **superseded by #1662 (server draws)**; 20% superseded by #1421; *(rev 2)* the face an undo reveals is accepted (OD-UR-11); a cryptographic source is ruled but routed out of UR (OD-UR-9) |
| #1056 | REPORTED → fix | the die is narrated on the run, not a step later | in force |
| #1089 | RULED | Carcosan status on the corporation, cleared only by a transfer; "If the Carcosa train rusts while owned, the corporation remains permanently cursed"; doom clock starts at the first D; the train "will survive until the exact conclusion of the next full set of Operating Rounds after its rust condition is triggered" | curse **in force**; trigger refined by #1672; **timing contested by S9-3 (OD-UR-2)** — *(rev 2)* the "next full set" lifespan is **kept** by OD-UR-2 |
| #1090 | RULED | Blood Price: "Left 1, Down 1 market movement for the selling corporation"; the train "becomes a standard train for the buying corporation" | **in force; contested by S9-3 (OD-UR-5 — still OPEN at rev 2)**; *(rev 5)* the buyer's "standard train" confirmed by OD-UR-5(a); whose price moves still OPEN (OD-UR-5(b)); *(rev 7)* its seller market move **superseded by OD-UR-5(b)** — the buyer's marker moves, the seller's does not (UR-F22) |
| #1092 | RULED | the fog is the third stage, narrated on a run; "give them whatever bonus/malus they roll"; deadline test `macroRound > doom` | in force in the code; *(rev 2)* the run-triggered collection is **superseded by OD-UR-2** (automatic removal at the end of set N+1, at the boundary — UR-F18); the N+1 deadline stays |
| #1128 / #1404 | ASKED / REPORTED | playtest force of the "next legal step in the sequence" | in force, local unpinned rooms only (#1662) |
| #1183 | REPORTED → fix | a duplicate run under one turn key is refused | in force (with `routeSetRefusal`, #1550) |
| #1264 | REPORTED → fix | a train the sign took is not narrated as a limit discard | in force |
| #1375 | REPORTED → impl. | the Mark's two lines; the taken train's route leaves, the rest is re-rolled under the turn's seed | in force (ratified by S9-3) |
| **#1407** | REPORTED → fix (not UR) | a dispatch made while the drain is replaying is refused with "Catching up with the room" | **in force — and the cause of UR-F1** (landed `c90d5b1`, 2026-09-11) |
| #1421 | RULED | Carcosa chance 60% ("needs to be bumped to 50-70%"); the reducer is the last gate on a Mark (a sign already out, or outside 2–4, is a no-op) | in force |
| #1422 / #1429 / #1431 / #1438 | RULED (statistics) | the sign's takings are not obsolescence; Carcosan Railways, The Redeemer, The Cowboy (animal lines) | in force (§10) |
| **S9-1** (#1661 / #1662) | owner-ruled defect fix, 2026-09-19 | outcome derived by the reducer from the committed board; the turn's draw and key minted by the server at ingress; `debug_force` dropped at ingress and refused on pinned boards | **in force** — covers the outcome and the input; **does not cover whether, when, or for whom the request is sent (UR-F2)**; *(rev 2)* OD-UR-1 answers that: no request — the stage is an automatic consequence of the run |
| **S9-2** (#1672–#1676) | owner ruling 2026-09-19 | exemption lasts the whole Carcosa lifetime; doom trigger = "whichever happens later" of the gilded ghost and the first REAL D; gift = "the LOWEST-VALUE TRAIN CURRENTLY REPRESENTED BY THE AUTHORITATIVE BANK DEPOT RULE"; synthetic D is not a real D purchase; provenance travels with a Blood Price | in force — **the depot-lowest gift is the root of UR-F4**; *(rev 2)* OD-UR-3 keeps the gift rule and rules that synthetic trains never advance the phase |
| **S9-3** | owner ruling 2026-09-19 | "ONLY THAT TRAIN'S RUN is nullified"; half face value "deposited directly into the corporation treasury"; the verbatim full rule | in force for the Mark; **contradicts the implementation on expiry and Blood Price (§1.2)**; *(rev 2)* expiry resolved by OD-UR-2 (N+1 + boundary); Blood Price still OPEN (OD-UR-5); *(rev 5)* its Blood Price train sentence superseded by OD-UR-5(a); the market consequence still OPEN (OD-UR-5(b)); *(rev 7)* its "purchasing corporation pays" confirmed by OD-UR-5(b) — the buyer only |
| #1690 (S10-4) | Stage 10.3 | the SERVER charges the Blood Price on a legal Carcosan transfer; no client charges it for a refused one | in force |
| D-36 | owner routing 2026-09-23 | OD-GR-3 deferred to this certification | ~~open (§7)~~ **DECIDED rev 2: "never"** (§7.3) |
| **UR-2, part 1** (rev 2) | owner rulings 2026-09-24 | OD-UR-1 1-A (automatic); OD-GR-3 3a = A2 ("never"; 3b / 3c moot); OD-UR-2 N+1 + boundary; OD-UR-3 3-A; OD-UR-4 4-A (minted); OD-UR-7 7-A (no gilded trade-in); OD-UR-8 8-B; OD-UR-9 9-B (implementation routed to AWS / live multiplayer); OD-UR-11 11-A; OD-UR-12 12-A | **recorded, not implemented**; OD-UR-5, OD-UR-6, OD-UR-10 OPEN |
| **OD-UR-10** (rev 4) | owner ruling 2026-09-24 | 10-C: an exact $5 tie rounds toward the printed revenue; any other amount to the nearest $10 — to damp the die at low values, stabilize it at higher values, keep it symmetric around printed and remove the half-up bias | **recorded, not implemented** (UR-F20 → UR-7; v10 boundary); OD-UR-5, OD-UR-6 OPEN |
| **OD-UR-5 (a), (c); OD-UR-6** (rev 5) | owner rulings 2026-09-24 | 5a-1: the Blood Price buyer's train is ordinary (an additional ordinary train — +1 in circulation only, never a special class); 5c-2: the sale names the copy, only the gilded copy's sale is the Blood Price; 6.1 paid revenue (in principle — the per-train allocation isolated); 6.2 a Mark-nullified route is not earned; 6.3 a synthetic gift is not a purchase, a Blood Price acquisition is | **recorded, not implemented** (UR-F21 → UR-4; UR-F8 → UR-5); OD-UR-5(b) OPEN |
| **OD-UR-5(a) clarified** (rev 6) | owner clarification 2026-09-24 | the cured train keeps only the synthetic-origin provenance the +1 supply accounting needs — supply provenance may persist, supernatural status does not (it ends at the Blood Price); the Blood Price is an intercorporate purchase, not a Bank / Depot purchase, so it changes no phase, rust, Gentle Rust mark, Depot tier, 18XX+ era or real-D doom trigger | **recorded** — rev 5's UR-4 phase question closed; no new gameplay exception; UR-4 keeps the accounting (§12.2); OD-UR-5(b) OPEN |
| **OD-UR-5(b); OD-UR-6.1 per train** (rev 7) | owner rulings 2026-09-24 | (b) the buyer only — the buyer pays the cash price and its marker moves Left 1 / Down 1; the seller gets no separate movement (its benefit is release from the curse); never both — #1090's seller move superseded; 6.1 per train: the printed value of the train's successfully completed route, not an allocation of the paid total (turn / corporation statistics: the paid revenue; a Mark-nullified route contributes nothing) | **recorded, not implemented** (UR-F22 → UR-4; UR-F8 → UR-5); **every owner decision DECIDED** |

---

## 3. Normative clause ledger (UR-N1 … UR-N62)

Status vocabulary: **CONFIRMED** owner ruling in force · **INHERITED** standard rule the variant does not modify ·
**DERIVED** consequence of confirmed rules · **PROJECT** implementation choice with no ruling (needs ratification, or
is harmless) · **CONTESTED** owner material disagrees with itself (→ OD) · **OPEN** no rule exists (→ OD) ·
**DEFERRED** OD-GR-3. The last column is the current code's conformance; "(P-x)" cites a probe of Appendix A.
*(Rev 2: rows settled by an owner ruling are marked "rev 2" and now read **CONFIRMED** with the ruling named; no row is
DEFERRED any more. Conformance still describes the code at `3f862c4`.)*

### A. Scope

| id | clause | authority | status | conformance |
|---|---|---|---|---|
| UR-N1 | Unpredictable Revenue is an optional owner-defined variant chosen at the deal (`SetupGame.variants.unpredictableRevenue`); absent means `false` means standard 1830. | #902; `gameVariants.ts:499`, `:662`, `:709–710` | CONFIRMED | conforms |
| UR-N2 | The choice is fixed for the game: recorded in the deal, resolved by `resolveVariants`; no later message changes it. | #902, #1256 ("the terms this table agreed") | DERIVED | conforms |
| UR-N3 | With the variant off, no UR mechanism — the die, flavour, any Yellow Sign stage, Carcosa, the fog, the Blood Price's market move — can change the game. | #902 ("DEFAULTS ARE THE STANDARD GAME, ALWAYS"); the project rule that a client may not reach a result the UI would never generate | DERIVED | **DEFECT UR-F3** (P-A) |

### B. The die and revenue

| id | clause | authority | status | conformance |
|---|---|---|---|---|
| UR-N4 | Exactly one roll per corporation per Operating turn, applied to the aggregated PRINTED revenue of all its routes that turn. | #941 RULED | CONFIRMED | conforms |
| UR-N5 | Face → percentage: 1 → 80, 2 → 90, 3 → 100, 4 → 100, 5 → 110, 6 → 120 (the table is mean-preserving). | #903 | CONFIRMED | conforms (`REVENUE_MODIFIER_BY_FACE`, `gameVariants.ts:826`) |
| UR-N6 | Paid revenue = printed × percentage, rounded to the nearest $10, integers only: `roundToTen(trunc((P·pct + 50)/100))`; ~~ties round up~~ *(rev 4)* an exact $5 tie rounds toward the printed revenue (printed $50: $45 → $50 and $55 → $50). | #938 RULED; project rule (no floats); **OD-UR-10 = 10-C (rev 4)** | CONFIRMED *(rev 4: the tie direction, PROJECT until now, is decided — 10-C)* | conforms except at an exact tie, which `roundToTen` (`gameVariants.ts:998`, `:1117`, `:1225`) rounds up — **DEFECT UR-F20** *(rev 4; implementation pending — UR-7)* |
| UR-N7 | The paid figure is the corporation's revenue for the turn: Pay splits it, Withhold banks it; a 10% certificate receives exactly a tenth. | #917, #938; rulebook §6.5 | CONFIRMED + INHERITED | conforms |
| UR-N8 | A dividend declaration must equal the paid figure (`last_route_revenue`) to the dollar. | S6-2 / audit C1 (`dividendAmountRefusal`) | INHERITED (authority rule) | conforms |
| UR-N9 | Share-price movement is the standard step on the paid figure; under Dynamic Stock Market its multiples judge the paid payout. | rulebook §6.5; #908 / #988 / #994 / #995 | DERIVED | conforms by construction; no live UR + DSM test |
| UR-N10 | Route legality, the highest-revenue rule and the demonstrated-shortfall bound compare PRINTED totals; the die applies after. | rulebook §6.4; #1556 ("printed figures on both sides (the Unpredictable Revenue die applies after)") | INHERITED + CONFIRMED | conforms |
| UR-N11 | Previews (route planner, auto-tracer, projections before the run) show printed figures and never roll; only the committed run applies the die. | #903 ("ONE SEAM") | CONFIRMED | conforms (UI) |
| UR-N12 | Only corporate route revenue is modified; private income, auction, terrain, train and token prices are untouched. | none modifies them | DERIVED | conforms (`applyPrivateRevenue` reads `revenue_per_or` only) |
| UR-N13 | A turn with no printed revenue has nothing to roll; a positive printed total never pays $0 (minimum $10). | arithmetic of N5–N6 | DERIVED | conforms |
| UR-N14 | "Bonus", "malus" and "normal" are judged on figures (paid vs printed), never on the face; a swallowed modifier is normal and draws from the "unchanged" bucket. | #938, #944 | CONFIRMED | conforms (`revenueOutcome`, `flavorBucketFor`) |

### C. Randomness, replay, undo

| id | clause | authority | status | conformance |
|---|---|---|---|---|
| UR-N15 | The turn's draw is a fresh uniform 32-bit number nobody can compute before the run is committed. | #1051 ("an 'Unpredictable' variant that actually is predictable") | CONFIRMED | conforms on hosted tables; Firestore rooms draw on the acting client (non-authoritative by design); *(rev 2)* OD-UR-9: the hosted source should become cryptographic — routed to AWS / live multiplayer, not a UR gameplay change |
| UR-N16 | On hosted (pinned) tables the SERVER draws at ingress and rebuilds the turn key from its own board; a client's seed or key never survives. | S9-1 / #1662 | CONFIRMED | conforms (`serverIngress.ts:84–93`, `roomSession.ts:483`) |
| UR-N17 | The draw is committed in the log; replay, restore and rebuild consume it and never draw; the reducer never draws. | #1051, #1662 | CONFIRMED | conforms |
| UR-N18 | An undo does not re-roll: a re-run of the same corporation turn reuses the most recent draw for that turn in the RAW log (entries a revert struck out included). | #1051 REQUESTED ("undoing it should not change their roll"); *(rev 2)* OD-UR-11: the face an undo reveals is accepted — no extra undo restriction | CONFIRMED | conforms (`turnSeed.ts:65`) |
| UR-N19 | One draw, three extractions: face = seed mod 6 + 1; flavour index = ⌊seed/6⌋ mod bucket length; Carcosa = ⌊seed / (6 × widest bucket)⌋ mod 100 < 60. | #969, #1051, #1421 | CONFIRMED (project) | conforms |
| UR-N20 | A logged run with no stored draw replays with the pre-#1051 hash (`legacyTurnSeed`) — development-corpus compatibility, never a live fallback. | #1051 | CONFIRMED (project) | conforms; the pinned-board fallback is reachable only off the server (UR-F15) |
| UR-N21 | The turn's draw is board state only for its own turn (`last_run_revenue_seed`, cleared at the turn change). | #1661 | CONFIRMED | conforms (`sandboxSession.ts:4108–4167`) |

### D. Narration

| id | clause | authority | status | conformance |
|---|---|---|---|---|
| UR-N22 | Each run under the variant narrates one turn sentence: "<TICKER> ran for $X." + the swing sentence (the die's nominal %) + a flavour line from the outcome bucket. | #941, #944, #949 | CONFIRMED (narration) | conforms |
| UR-N23 | The narration reads the committed draw and agrees with the board. | #1056; #1375 ("the sentence and the board cannot disagree") | CONFIRMED | **DEFECT UR-F1, UR-F6** |
| UR-N24 | Sounds, videos and flashes are ephemeral and never replay on refresh or undo. | #1094 | CONFIRMED | conforms (UI) |

### E. The Yellow Sign — general

| id | clause | authority | status | conformance |
|---|---|---|---|---|
| UR-N25 | A once-per-game sequence inside the variant: at most one Marked corporation; Carcosa at most once, for it; the fog collects each gilded train once. | #1044, #1046, #1092; S9-3 | CONFIRMED | conforms (reducer gates `sandboxSession.ts:6548–6550`, fog `markedAt` guard) |
| UR-N26 | Every stage's outcome — which stage, which train, the award, the gift — is derived by the authority from the committed board and the run's committed draw; no client field chooses it. | S9-1 / #1661 | CONFIRMED | conforms for the OUTCOME (`yellowSign.ts:695`; a forged stage, model, cash or seed is inert — `yellowSignAuthority` 2–5) |
| UR-N27 | A stage belongs to the run that produced it: the Mark and Carcosa are judged on THAT run's draw, bucket, fleet and phase ("the phase BEFORE this dispatch settled, which is the phase the turn was played in", #1046); the fog is collected on the Carcosan corporation's own run (#1092). *(Rev 2: a stage is an automatic, derived consequence of the authoritative run — the authority resolves it from the run and its committed seed; no player or client may omit, delay, redirect or manufacture it (OD-UR-1); the Mark reads the fleet after the Run → Dividends settlement (OD-GR-3); the fog is no longer a run stage (OD-UR-2).)* | #1046, #1092; **OD-UR-1, OD-GR-3, OD-UR-2 (rev 2)** | CONFIRMED (rev 2) | **DEFECT UR-F1, UR-F2** |
| UR-N28 | The playtest force exists only in local unpinned sandbox rooms: it waives chance and window, never state; dropped at hosted ingress and refused on pinned boards. | #1128, #1404, #1662 | CONFIRMED | conforms |

### F. The Mark

| id | clause | authority | status | conformance |
|---|---|---|---|---|
| UR-N29 | Trigger: Phases 2–4; outcome critical malus (face 1 with a real reduction); the natural flavour draw is the Yellow Sign line; nobody yet Marked; the corporation holds a train *(rev 2: after the Run → Dividends settlement — OD-GR-3)*. | #1044, #1046; S9-3 | CONFIRMED | conforms in the reducer; **window judged at application (UR-F2, P-G1′)** |
| UR-N30 | No Mark in Phase 5 or later; the line is skipped from then on. | #1046; S9-3 | CONFIRMED | conforms |
| UR-N31 | The Mark takes the corporation's lowest-value train by depot price; identical models are interchangeable (first held). | #1046 RULED ("loses its lowest value train"); tie rule PROJECT | CONFIRMED / PROJECT | conforms (`lowestValueTrain`, `yellowSign.ts:151`); Final Run trains → OD-GR-3 *(rev 2: never candidates — UR-N37)*; *(rev 3: where the taken train goes — OD-UR-13 DECIDED: removed from the game, `removed_trains`, phase monotonic; UR-F19 fixed)* |
| UR-N32 | Only the taken train's run is nullified; the rest of the turn's printed revenue stands and is paid under the same face. | S9-3 RULED; #1375 | CONFIRMED | conforms when the run names its trains; **DEFECT UR-F7** (P-J) and **UR-F5** (P-C) |
| UR-N33 | The corporation receives ⌊½ × the taken train's face value⌋ into its treasury. | #1046 (0.5x), S9-3; **OD-UR-4 (rev 2): minted — found money, not paid by the Bank** | CONFIRMED (amount; source rev 2) | conforms — the award is minted today (P-E), which is now the rule |
| UR-N34 | The Mark may leave the corporation with no train; the ordinary obligation to own a train then applies in that turn's Buy Trains. | #1046 ("even down to zero trains"); rulebook §6.6.2 | DERIVED | conforms by construction (`trainObligationFor` reads `owned_trains`); not live-tested |
| UR-N35 | The Marked corporation bears the sign (`has_yellow_sign`) until its Carcosa. | #1046, #1404 | CONFIRMED | conforms |
| UR-N36 | The Mark is narrated as two lines: the run without the vanished train, then the sign's line with the appendix and the gold. | #1375 | CONFIRMED (narration) | text conforms; never reaches the board in a room (UR-F1) |
| UR-N37 | What the Mark does to a Gentle Rust reprieved / Final Run train. *(Rev 2: nothing — the Mark judges the fleet after the Run → Dividends settlement, where a Final Run train is already destroyed, so a reprieved / Final Run train is never a candidate; no exception lets the Mark take, monetize or replace a Gentle Rust destruction.)* | D-36; **OD-GR-3 = A2 "never" (rev 2)** | CONFIRMED (rev 2) — ~~DEFERRED — OD-GR-3~~ | reducer conforms in the intended flow (P-C); **DEFECT UR-F5** (attribution) and **UR-F6** (narration); a delayed request can take a reprieved train (P-H — UR-F2) — §7.3 |

### G. Carcosa Awaits

| id | clause | authority | status | conformance |
|---|---|---|---|---|
| UR-N38 | Trigger: the Marked corporation only; Phases 5–D; outcome critical bonus (face 6 with a real increase); a 60% chance. | #1046, #1051, #1421; S9-3 ("an improved probability") | CONFIRMED | conforms in the reducer; **window judged at application (UR-F2, P-G2′)** |
| UR-N39 | The gift is a synthetic ("ghost") train of the lowest-value tier currently represented by the bank-depot rule; it takes nothing off the depot. | S9-2 / #1672 owner ruling; S9-3; **OD-UR-3 (rev 2): a synthetic train never advances the phase** | CONFIRMED | conforms as to the gift; **the phase effect is DEFECT UR-F4** (P-B, P-F) against OD-UR-3 |
| UR-N40 | The corporation becomes Carcosan (`is_carcosan`) and loses the sign flag; only a Blood Price clears Carcosan status. | #1089, #1090 | CONFIRMED | conforms |
| UR-N41 | The gilded train is individually exempt from its owner's train limit for its whole Carcosa lifetime (until the fog or a Blood Price). | S9-2 / #1672 owner ruling; S9-3 | CONFIRMED | conforms (`countableTrainCount`, `trainLimit.ts:132`) |
| UR-N42 | Otherwise the gilded train is an ordinary owned train: it runs, it makes its corporation not trainless, it may be sold. *(Rev 2: except that it may not be a Diesel trade-in; an ordinary copy of the same model stays tradable.)* | no ruling modifies the rest; **OD-UR-7 = 7-A (rev 2)** | DERIVED + CONFIRMED (rev 2) | conforms otherwise; **as a Diesel trade-in: DEFECT UR-F17** (accepted today, P-I) |
| UR-N43 | A synthetic D is not a real D purchase and does not satisfy the doom trigger. | S9-2 / #1672 owner ruling | CONFIRMED | conforms (`realDieselPurchased`, `gamePhase.ts:601`) |

### H. Doom and fog

| id | clause | authority | status | conformance |
|---|---|---|---|---|
| UR-N44 | The doom trigger is whichever happens later of (the gilded ghost exists) and (the first REAL D is bought through depot machinery; a pooled D counts). | S9-2 / #1672 owner ruling | CONFIRMED | conforms — **except when UR-F4 swallows the first D's phase change (P-F)**; *(rev 2)* under OD-UR-3 the first REAL D always changes the phase, so fixing UR-F4 restores the trigger |
| UR-N45 | When the gilded train disappears. *(Rev 2: a doom trigger in OR set N → the train survives through all of set N + 1 and disappears automatically at the END of set N + 1, as an authoritative OR-set-boundary transition — "N+1 + boundary". Not on a run, not by a client request; the current `N+1 + on-run` form must not be restored.)* | S9-3 verbatim vs #1089 / #1092; **OD-UR-2 (rev 2)** | CONFIRMED (rev 2) — ~~CONTESTED → OD-UR-2~~ | **DEFECT UR-F18** — implemented: trigger set N; survives all of N + 1; taken on the corporation's first run after N + 1 (`fogIsDue`, `yellowSign.ts:380`) through the sign request |
| UR-N46 | The fog outranks any other stage on its run and replaces only the flavour clause; the roll and the payout are untouched. *(Rev 2: superseded — the fog is not a run stage (OD-UR-2); no run's roll, payout or flavour line is affected by it.)* | #1092 RULED; **run placement superseded by OD-UR-2 (rev 2)** | CONFIRMED (rev 2) | **DEFECT UR-F18** — today the fog is still a run stage (it leaves the roll alone, as #1092 said) |
| UR-N47 | After the fog the corporation stays Carcosan. | #1089 RULED | CONFIRMED | conforms |
| UR-N48 | The fog removes exactly one gilded copy together with its gilding and its synthetic provenance. *(Rev 2: at the boundary transition of OD-UR-2; the removal's content is unchanged.)* | #1675 | CONFIRMED (project) | conforms (as a run stage today — re-asserted at the boundary when UR-F18 is fixed) |

### I. The Blood Price

| id | clause | authority | status | conformance |
|---|---|---|---|---|
| UR-N49 | Selling a gilded train to another corporation (ordinary inter-corporation sale rules) absolves the seller: `is_carcosan` cleared, the gilding burned, the doom clock cleared. | #1090 RULED | CONFIRMED | conforms (`sandboxSession.ts:1993–2018`) *(rev 8: re-asserted live for the gilded COPY's sale — seller absolved, gilding burned, clock cleared, never fogged afterwards; an ordinary copy's sale absolves nothing — UR-4, `carcosaBloodPrice` A3, F1, F2)* |
| UR-N50 | What the buyer receives. *(Rev 5, OD-UR-5(a) = 5a-1: an ORDINARY train — it counts against the buyer's train limit, runs normally, rusts normally, can be sold again normally and can be a Diesel trade-in if otherwise eligible; it has no fog deadline, no gilding, no Carcosan train-limit exemption and no other supernatural status. It is an additional ordinary train — +1 in circulation relative to the printed depot supply — never a special class of train (the owner's "bonus train" means only this).)* *(Rev 6, the owner's clarification: it keeps only its synthetic-origin provenance, for that +1 supply accounting (UR-N52); the Blood Price, an intercorporate purchase and not a Bank / Depot purchase, changes no phase, rust, Gentle Rust mark, Depot tier, 18XX+ era or real-D doom trigger.)* | #1090 ("a standard train") vs S9-3 ("remains a ghost train and STILL disappears on the same D-triggered schedule"); **OD-UR-5(a) = 5a-1 (rev 5; clarified rev 6)** | ~~**CONTESTED → OD-UR-5(a)**~~ CONFIRMED *(rev 5)* | implemented: an ordinary train — conforms (GHL E); its synthetic provenance travels (#1673) — the "+1" — see §12.2 (OD-UR-5) on the phase; *(rev 6)* the sale buys nothing from the Depot, so the phase, the shelf and the real-D check do not move — conforms by reading; UR-4 pins it live *(rev 8: **pinned live — UR-4**: an ordinary train at the buyer — limit, running, second sale, trade-in, fog, curse, clock (`carcosaBloodPrice` C1–C5, F1); the +1 through the Depot and the Bank Pool (D1–D6); no phase / rust / mark / shelf / era / real-D consequence of the sale itself (E1–E3))* |
| UR-N51 | Whose share price moves. *(Rev 7, OD-UR-5(b): the BUYER's — the buyer pays the cash price and its marker moves Left 1 / Down 1; the seller gets no separate stock-price movement (its benefit is release from the Carcosan curse); the penalty is never applied to both.)* | #1090 ("for the selling corporation") vs S9-3 wording ("The purchasing corporation pays the required Blood Price consequences"); **OD-UR-5(b) (rev 7)** | ~~**AMBIGUOUS → OD-UR-5(b)**~~ CONFIRMED *(rev 7)* | implemented: the seller, Left 1 / Down 1 — **DEFECT UR-F22** (#1090's move, superseded) *(rev 8: **conforms — UR-F22 FIXED (UR-4)**: the buyer's marker moves Left 1 / Down 1, the seller's never — `carcosaBloodPrice` B1–B4, I2, I4; `BPA`, `S103`, `S103b` updated)* |
| UR-N52 | Synthetic provenance (`ghost_trains`) travels with the train — one occurrence, unconditionally. *(Rev 6, the owner's clarification of OD-UR-5(a): after a Blood Price this provenance is supply accounting only — the train originated synthetically rather than consuming a printed Depot copy, the +1 — and never a supernatural status, which ends at the Blood Price.)* | #1673; OD-UR-5(a) (rev 6) | CONFIRMED (project, from "synthetic") | conforms *(rev 8: and through the Bank Pool — `returned_ghost_trains`; the marker leaves with the copy that has it, never the gilded copy's with an ordinary copy — UR-4, `carcosaBloodPrice` A7, D2–D6)* |
| UR-N53 | The authority (server included) charges the Blood Price exactly on a legal Carcosan transfer. | #1690 | CONFIRMED | conforms *(rev 7: whose marker the charge moves is UR-N51 — UR-F22)* *(rev 8: re-asserted — the server charges it on the gilded copy's legal sale, to the BUYER; `S103` and `carcosaBloodPrice` I2 / I4)* |
| UR-N54 | ~~A sale of a model the seller holds as both a gilded and an ordinary copy is the Carcosan transfer.~~ *(Rev 5, OD-UR-5(c) = 5c-2:)* when the seller holds a gilded and an ordinary copy of one model, the sale names the copy — selling the ordinary copy is an ordinary sale (no Blood Price; the gilded copy stays gilded), selling the gilded copy is the Blood Price. | `isCarcosanTransfer` (model-level); **OD-UR-5(c) = 5c-2 (rev 5)** | ~~**PROJECT → OD-UR-5(c)**~~ CONFIRMED *(rev 5)* | **DEFECT UR-F21** — model-level today: any sale of that model is the Carcosan transfer *(rev 8: **conforms — UR-F21 FIXED (UR-4)**: `gilded` names the copy; an unnamed sale of a model held both ways is refused — `carcosaBloodPrice` A1–A8, I1, I3, I5)* |

### J. Statistics and awards

| id | clause | authority | status | conformance |
|---|---|---|---|---|
| UR-N55 | Carcosan Railways (lived through any stage, never redeemed) and The Redeemer (paid the Blood Price). | #1421 | CONFIRMED | conforms by reading; **no live coverage (S10-21)**; *(rev 5: The Redeemer reads the model — under 5c-2 it must read the copy sold, UR-F21)*; *(rev 7: under OD-UR-5(b) the buyer pays the Blood Price, and The Redeemer already credits the buyer's president — no change)* *(rev 8: The Redeemer reads the gilding the sale burned — the copy, not the model; UR-4, `carcosaBloodPriceStats`; Carcosan Railways under the buyer-pays rule → UR-5)* |
| UR-N56 | The sign's takings (Mark, fog) are not obsolescence: fate "taken"; excluded from Gravedigger and The Rust Belt. | #1422, #1431 | CONFIRMED | conforms (`gameHistory.ts:562`, `:723–735`) |
| UR-N57 | The Cowboy counts the runs whose flavour line was an animal line. | #1429, #1438 | CONFIRMED (catalogue) | **DEFECT UR-F9** (reads the natural line, not the printed one) |
| UR-N58 | Which figure revenue statistics use under the variant (printed or paid), whether a Mark-nullified run counts as earned, and whether a synthetic gift counts as a purchase. *(Rev 5, OD-UR-6: the revenue actually paid — 6.1, in principle; corporation / turn level; a per-train figure's allocation is an isolated open sub-question — a Mark-nullified route is not earned (6.2); a synthetic gift is not a purchase, a later Blood Price acquisition is (6.3).)* *(Rev 7: the per-train question DECIDED — a per-train statistic uses the printed value of the train's successfully completed route, not an allocation of the paid total; a Mark-nullified route contributes nothing.)* | none; **OD-UR-6 (rev 5)** | ~~**OPEN → OD-UR-6**~~ CONFIRMED *(rev 5; the per-train question decided rev 7 — OD-UR-6 fully decided)* | today: printed; nullified runs counted; gifts counted as bought — **DEFECT UR-F8** (UR-5); *(rev 7)* per train, today's printed basis conforms for completed routes — only the nullified route's inclusion does not |

### K. Presentation

| id | clause | authority | status | conformance |
|---|---|---|---|---|
| UR-N59 | Lobby / waiting-room copy: "Running railways is risky. In this variant, runs can produce up to ±20% their standard revenue, rounded to the nearest $10." | #961 and its rounding-clause correction | CONFIRMED (copy) | conforms; the variant's TITLE differs by screen (UR-F14 → OD-UR-12; *rev 2:* the name is **Unpredictable Revenue**) |
| UR-N60 | The Rules Reference is the sole player-facing authority. *(Rev 2, OD-UR-8 = 8-B: it discloses what a player needs to act — the die and rounding, a gilded train's train-limit treatment and eventual disappearance, the Blood Price's consequences once OD-UR-5 is decided *(rev 7: it is)* — and keeps the Yellow Sign's trigger conditions and odds hidden.)* | S9-4; **OD-UR-8 (rev 2)** | CONFIRMED | UR has one sentence (`RulesReference.tsx:613–614`) — **DEFECT UR-F13** against 8-B |
| UR-N61 | Train chips mark gilded trains and state their limit status truthfully. | #1088, #1089, #1672 | CONFIRMED | **DEFECT UR-F12** (stale tooltip) |
| UR-N62 | The debug arming chip is offered only in local unpinned rooms. | #1662 | CONFIRMED | conforms |

---

## 4. Implementation authority map

`sS` = `frontend/src/gameEngine/sandboxSession.ts`; `YS` = `gameEngine/yellowSign.ts`; `GV` = `gameEngine/gameVariants.ts`;
`GP` = `gameEngine/gamePhase.ts`; paths under `frontend/src/` unless stated. Line numbers at `3f862c4`.

| concern | where | classification |
|---|---|---|
| the flag and its resolution | `GV:499` (field), `:662` (default), `:690–722` (`resolveVariants`) | shared helper (reducer, server, UI) |
| the hosted draw and turn key | `utils/serverIngress.ts:84–93` (`normalizeForCommit`), called once at `utils/roomSession.ts:483` between the authority gate and the append | **server validation + random-event generation** |
| the Firestore-room draw | `App.tsx:10020–10033` (`seedAlreadyRolled(...) ?? randomTurnSeed()`) | random-event generation on the acting client (non-authoritative rooms only) |
| the RNG | `GV:929` `randomTurnSeed` = `Math.floor(Math.random() * 2^32)`; the server passes no `mintSeed` (`server/src/gameServer.ts`), so this is the hosted source | random-event generation |
| undo reuse | `utils/turnSeed.ts:52` (`turnSeedKey` = `macro.sub.company`), `:65` (`seedAlreadyRolled`, raw log, newest first) | deterministic seed handling (server and client) |
| legacy seed | `GV:939` `legacyTurnSeed` → FNV-1a `revenueSeedHash` | deterministic seed handling — legacy replay only |
| **applying the die** | `sS:6186–6340` `RunMultipleRoutes` arm: prices with the authority's own evaluation (`evaluateRouteSet`), sums printed, `rollTurnRevenue(printedTotal, {…, turnSeed: msg.revenue_seed ?? legacyTurnSeed(…)})` (`:6282–6293`), writes `last_route_revenue` (paid), `printed_route_revenue`, `last_run_breakdown` (only when `train_indices` is sent), `routes_run_this_turn`, `last_run_revenue_seed` (`:6326–6328`), `last_run_turn_key` | **canonical reducer authority** |
| the die's arithmetic | `GV:989` face, `:998` percent, `:1117` `roundToTen`, `:1139` outcome, `:1041` bucket, `:1080` flavour, `:1225` `rollTurnRevenue` | shared helper (reducer, narration, statistics) |
| legacy per-route run | `sS:5986–6085` `RunManualRoute` (always `legacyTurnSeed`); refused on pinned boards (`sS:3748`) | reducer — legacy replay only |
| route legality / shortfall | `gameEngine/routeAuthority.ts:482–512` (`routeSetRefusal`: one run per turn, Run Trains step, the route walk), `:530` (`demonstratedShortfall`, printed) | reducer + server validation |
| cursor after the run | `sS:4283–4285` (`RunMultipleRoutes` → Dividends) and `sS:4244–4247` (entering Dividends expires Gentle Rust grace-turn trains) | reducer |
| the turn-scoped clear | `sS:4108–4170` (`last_route_revenue`, `printed_route_revenue`, breakdown, routes, `last_run_revenue_seed`) | reducer |
| dividends | `routeAuthority.ts` `dividendAmountRefusal` (declared = `last_route_revenue`), `gameEngine/dividendSplit.ts`, `sS` `DeclareDividends` arm | reducer |
| share-price step | `GV` `dividendStepsFor` (Dynamic Stock Market) + the market atom | reducer (chart step) |
| **the sign's narration and its request** | `App.tsx:7141–7520` inside `runGameplayAction`, reached from the log drain; requests dispatched at `App.tsx:7400` (Mark), `:7426` (fog), `:7445` (Carcosa) | **UI narration — and the ONLY producer of `YellowSignEvent`** |
| the catch-up guard | `App.tsx:6235–6242` (#1407); drain flag `App.tsx:12143` (set) / `:12364` (cleared); drain dispatch `:12251–12252` | UI gating — **cause of UR-F1** |
| ingress authority for the request | `gameEngine/turnAuthority.ts:349` (seat only); no `YellowSignEvent` arm in `operatingLegalityRefusal` (`:458`) | server validation (**seat only — UR-F2**) |
| ingress normalization of the request | `serverIngress.ts:96–103` (drops `debug_force`) | server validation |
| shape | `gameEngine/messageSchema.ts:224–233` (`RunMultipleRoutes`: `revenue_seed`, `revenue_turn` optional), `:285–308` (`YellowSignEvent`: legacy outcome fields optional) | server validation (shape only) |
| **the sign's authority** | `sS:6114–6184` `YellowSignEvent` arm: pinned board or a bare request → `resolveYellowSign(state, …, derivePhase(state))` (`:6158–6166`); a stored outcome on an unpinned board → applied as recorded | **canonical reducer authority** |
| the sign's derivation | `YS:695` `resolveYellowSign`, `:490` `resolveFlavourLine`, `:151` `lowestValueTrain`, `:175` `markPayout`, `:189` `runWithoutTrain`, `:253` `carcosaGiftModel`, `:347` `carcosaRollHits`, `:380` `fogIsDue`, `:314` state from flags | shared helper (reducer and narration) |
| the sign's mutations | `sS:6472–6655` `applyYellowSignOutcome` (fog `:6490–6530`; Mark gate `:6548–6550`, removal `:6559`, kept run `:6572`, award `:6581` with **no bank debit**; gift `:6594–6650`) | **canonical reducer authority** |
| a no-op request | `roomSession.ts` #1685 pop (`:554`), `gameEngine/actionOutcome.ts:102` | server transport (refused, not appended) |
| doom clock | `sS:1064–1074` `startCarcosanDoomClock`, called only from `applyPhaseChange` for an arriving D (`sS:1117`); gift-time clock `sS:6645` | reducer |
| limit exemption | `gameEngine/trainLimit.ts:132` `countableTrainCount` (subtracts `carcosan_trains`) and every caller | reducer + shared |
| ghosts in the depot and the phase | `GP:601` `realDieselPurchased` (subtracts ghosts), `GP:619–667` `derivePhase` (**counts a ghost toward the phase**, `:656–660`), `GP:422–505` `depotInventory` / `openDepotTiers` | shared helper (reducer + UI) |
| phase-change trigger | `sS:1834–1840` (`buyDepotTrain`: `applyPhaseChange` only when `derivePhase` changes), `sS:5748–5764` (Diesel exchange, same test) | reducer — **root of UR-F4 with `GP:656–660`** |
| the Blood Price | `sS:1949–2018` `settleTrainSale` (provenance moves; gilding burned; seller absolved), `sS:2026` `isCarcosanTransfer`, market move `sS:2644–2680`, server context `sS:2986–2995` | reducer (+ chart step) |
| Diesel exchange | `gameEngine/dieselExchange.ts:46–120`, arm `sS:5740–5765` | reducer — **no Carcosan handling (OD-UR-7)** |
| fleet-loss narration | `sS` `describeFleetLosses` (≈`:1575–1700`; #1264 takes the sign's train out) | UI narration (shared helper) |
| sign state for narration | `YS:326` `yellowSignStateOf` (flags first, then the log-sentence parse `YS:288`, which cannot parse #1375's second line) | UI narration — the fallback is ineffective since #1375 |
| playtest force | `YS:470–488`; `App.tsx` sign-arming block (≈`:7236–7245`) | UI (local rooms) + reducer honours it only unpinned |
| statistics | `utils/gameHistory.ts:431–476` (revenue), `:451–457` (The Cowboy), `:556–612` (losses), `:640–670` (Phase Rusher, purchases, Early Adopter), `:721–750` (sign stages, Blood Price) | post-game statistics |
| awards | `utils/accolades.ts:100–200` | awards / accolades |
| the mint exemption | `utils/moneyConservation.test.ts:138` (`MINTS_BY_DESIGN = {SetupGame, YellowSignEvent}`) | test only |
| copy | `GV:192–196` (`VARIANT_COPY`), `components/RulesReference.tsx:613–614`, `components/HostSetupCard.tsx:75`, `components/LobbyRoomList.tsx:51`, `components/TrainBadges.tsx:632`, `constants/flavorText.ts:51` (buckets: criticalMalus 115 lines incl. the Mark line at `:113`; criticalBonus 120 incl. the Carcosa line at `:609`) | Rules Reference / help copy / UI |
| cues | `utils/variantSfx.ts`, `components/YellowSignOverlay.tsx`, `components/CarcosaMark.tsx`, `utils/carcosaCurse.ts` | UI presentation only |
| a constructed UR game | none exists (`utils/gentleRustCertificationGame.ts` is Gentle Rust's) | — |
| fallbacks kept on purpose | `YS:231` `escalationTier` (the gift's fallback when no depot is readable); `legacyTurnSeed`; `RunManualRoute`; the stored-outcome sign branch | non-production (legacy / defensive) paths |

**UI prevents it, the authority accepts it** (the brief's special attention):

| what the normal client never sends | what the authority does with it | finding |
|---|---|---|
| a `YellowSignEvent` on a table without the variant | applies the stage (P-A) | UR-F3 |
| a `YellowSignEvent` for a corporation other than the one that just ran, at any step, in any round | applies the derived stage — a due fog is collected before its owner runs (P-D) | UR-F2 |
| a `YellowSignEvent` delayed past a phase change or a Buy Trains step | judged at the later phase / on the later fleet (P-G1′, P-G2′, P-H) | UR-F2 |
| no `YellowSignEvent` at all after a run that drew a stage | nothing happens; nothing is owed | UR-F2 (and, in practice, UR-F1) |
| a `RunMultipleRoutes` without `train_indices` | legal (the authority pairs the trains itself) but no breakdown is written, so a Mark later cannot nullify the taken train's route (P-J) | UR-F7 |
| a gilded (Carcosan) train offered as a Diesel trade-in | the panel offers it and the arm accepts it; no ruling covers it (P-I) | OD-UR-7 |

---

## 5. Deterministic randomness and replay

### 5.1 How an outcome is generated

1. The operating president sends `RunMultipleRoutes`. On a **hosted** table, ingress first applies the authority gate
   (`turnRefusal` → `routeSetRefusal`), then `normalizeForCommit` REPLACES `revenue_turn` with the server board's
   `macro.sub.company` and `revenue_seed` with `seedAlreadyRolled(rawLog, key) ?? randomTurnSeed()`, before the append
   (`roomSession.ts:483`). On a **Firestore** room the acting client draws the same way against its own raw log.
2. The reducer arm reads the committed seed and applies `rollTurnRevenue` once to the turn's printed total. The face,
   the flavour line and the Carcosa roll are three extractions of that one number (UR-N19).
3. The same number is copied onto the board (`last_run_revenue_seed`) so the sign's derivation can reach it, and is
   cleared at the turn change.
4. The narration (every client, in the drain) re-derives the same roll from the committed message — the same function
   on the same inputs — and composes the sentence.

**Generation happens at the authority on hosted tables** (server ingress), and **application happens in the canonical
reducer**. The random result is logged as the seed, not as the outcome; every outcome is recomputed from it (the pure
functions of §4), which is safe because nothing but the seed is random.

### 5.2 The brief's questions, answered

| question | answer | evidence |
|---|---|---|
| is generation in canonical authority? | Hosted: yes — server ingress, before the append. Firestore rooms: the acting client (those rooms are non-authoritative by design, S9-1). | `serverIngress.ts:84–93`; `yellowSignIngress` 1–2 |
| is the random result logged? | The **seed** is logged in the committed `RunMultipleRoutes` payload; outcomes are recomputed from it. | `sS:6282–6293` |
| does replay recompute or consume? | Consumes the stored seed; recomputes the deterministic outcome. Replay never reaches the normalizer. | `yellowSignIngress` 3; `RoomSession.restore` replays committed payloads |
| how is the seed established? | `Math.random()` × 2^32 on the server (`randomTurnSeed`), unless the raw log already holds a draw for the same turn key. | `GV:929`; `turnSeed.ts:65` |
| identical action streams → identical results? | Yes: the committed payloads carry the seeds; the reducer is pure; digests agree at settle points (#1223). | `batch50`, `yellowSignAuthority` 1, `multiTrainRun` "is stable when replayed" |
| can client data influence or spoof the outcome? | **The draw: no** on hosted tables (seed and key replaced). **The sign: yes, by omission, timing and target (UR-F2), and on tables without the variant (UR-F3); the Mark's nullification by omitting `train_indices` (UR-F7).** | P-A, P-D, P-G1′, P-G2′, P-H, P-J |
| do server and local reducer agree? | Yes for every committed entry (one reducer, one context builder since #1690). The **narration** does not always agree with either (UR-F1, UR-F6). | #1223 divergence check; P-C |
| is replay from stored logs deterministic? | Yes. Unpinned logs take the legacy branches (stored seed, else `legacyTurnSeed`; stored sign outcome); pinned logs always carry a server seed. | `yellowSignAuthority` 7; corpus sweeps |
| can speculative UI invent an outcome? | **Board state: no** — a room click appends and returns; the board is only what the drain applies. **The Activity Log: yes** — the sign is narrated from a shell-side resolution that is never applied (UR-F1), and judged on the pre-run fleet (UR-F6). Before the run, previews show printed figures and never roll (UR-N11). | `App.tsx:6203`, `:7141–7520` |
| duplicated / skipped / out-of-order draws after refusal or rollback? | **Refusal:** an ingress refusal happens before the draw; a reducer no-op is popped from the log with its seed (#1685), so a refused run pins nothing and reveals nothing. **Rollback:** a `RevertTo` leaves the run in the raw log, so the re-run reuses its seed (newest first). **Order:** seeds are keyed by turn, not by sequence, so there is no ordering dependency to disturb. | `roomSession.ts:541–563`; `turnSeed.ts:65–76`; `batch50` 154–187 |
| undo / reconnect / restore? | Undo: reuse (above). Reconnect: catch-up frames carry committed entries. Restore: replays committed entries, never re-normalizes. Crash mid-burst: `settleOwed` re-derives only derived actions, which never draw. | `roomSession.ts` header; `yellowSignIngress` 3 |
| do digests include the random state? | Yes: `last_run_revenue_seed` is a board field for the duration of the turn, and the seed is in the log itself. | `stateDigest` over the board |
| does any fixture/corpus log depend on old semantics? | Yes, by design — every UR log in the corpus is unpinned (§5.5) and replays through the legacy branches. | §5.5 |

### 5.3 Invariants the certification must pin (R1 – R13)

| id | invariant | pinned today? |
|---|---|---|
| R1 | Every accepted `RunMultipleRoutes` on a pinned table carries a server-minted `revenue_seed` and the server's `revenue_turn`; no client value survives. | yes — `yellowSignIngress` 1–2 (normalizer + source pin) |
| R2 | After a `RevertTo` past a run, the next run for the same turn key reuses the raw log's draw; after several undos, the newest. | yes — helper (`batch50` 154–187) and normalizer (`yellowSignIngress` 3); **no end-to-end `RoomSession` undo test** |
| R3 | A refused run appends nothing and pins no seed; nothing about the refused draw is observable. | by reading (`roomSession.ts:541–563`); **not tested for a run** |
| R4 | Replay / restore / rebuild never draw and never re-normalize; the same log gives the same board and digest, sign outcomes included. | partly (`yellowSignIngress` 3; corpus replays); **no pinned-table UR restore test** |
| R5 | The reducer never calls `Math.random`; face, line and Carcosa are pure functions of (seed, printed, board). | by reading; `batch47` 304 ("rolls the tenth from the turn, not from Math.random") |
| R6 | A turn's seed exists on the board only between its run and the turn change; nothing may use another turn's draw. | yes — `yellowSignAuthority` 9 (source pin); **but a request after the turn change still derives a fog (UR-F2)** |
| R7 | Client and server agree after every settle point for UR runs and sign outcomes. | the divergence check exists (#1223); no UR-specific test |
| R8 | The narration equals the applied outcome: every narrated stage, train and figure is on the board. | **violated (UR-F1, UR-F6)** |
| R9 | With the variant off, no seed changes anything and no sign request is accepted. | **violated (UR-F3)** — revenue side holds (P-A: paid = printed) |
| R10 | Unpinned logs keep their legacy semantics; pinned boards never take a legacy branch. | legacy branches pinned (`yellowSignAuthority` 7, `markKeepsRun` 69); the pinned seedless fallback is unreachable through the server but not refused (UR-F15) |
| R11 | A turn key names exactly one corporation turn; the same turn after a deep revert reuses its draw by design. | by construction (`turnSeedKey`) |
| R12 | Face ≈ uniform over 1–6 (2^32 mod 6 = 4 gives faces 1–4 one extra value in 2^32 — negligible); line index and Carcosa roll ≈ independent of the face. | `batch50` "reaches every face", "strides past the die and the widest bucket"; no distribution test on the server's draw |
| R13 | No message field (seed, key, stage, model, cash, force, train naming) can change a random outcome on a pinned table. | seed/key/stage/model/cash/force: yes (`yellowSignAuthority` 2–5, 8; `yellowSignIngress`); **train naming: no (UR-F7)**; **timing / target / omission: no (UR-F2)** |

### 5.4 Residual randomness observations (not defects)

* **The server's RNG is `Math.random`** (V8's xorshift128+). It is not a cryptographic generator and its state is, in
  principle, recoverable from enough outputs; the seeds are published in the log. For a game that settles real JUNO
  this is a hardening question, not a defect today (a player cannot choose the draw; prediction would at most tell them
  a face before their run, and the server draw is interleaved with every other room's draws). → **OD-UR-9**.
  Not redesigned here.
* **An undo reveals the face before the re-run.** The seed is in the committed entry, so a president who runs, undoes
  and re-runs knows the multiplier and the natural flavour line in advance. The route choice cannot move the multiplier,
  and S6-3's demonstrated-shortfall rule refuses a re-run worth less than the authority's own best-found set; the only
  residual lever is the outcome bucket at small totals (≤ $20 swallows faces 1, 2, 5, 6), which could dodge a Mark only
  by giving up revenue the shortfall rule usually forbids. → **OD-UR-11** (accept or restrict).
* **Firestore rooms** draw on the acting client and accept its seed; they are unpinned and non-authoritative by design
  (S9-1), keep the playtest force, and are outside hosted certification.

### 5.5 Corpus characterization (read-only)

The 18-file set (`moneyConservation`'s enumeration): three frozen golden logs, the server store (`server/data/`,
**git-ignored** — present on the owner's machine), five client exports, FCJ's 96-entry prefix and Z6C through 494.
Unpredictable Revenue is ON in: `server/JUNO-8E8`, `server/JUNO-CW7`, `server/JUNO-FCJ` (97 runs), `server/JUNO-Z6C`
(73 runs), `export/JUNO-3XD` (with Gentle Rust and Dynamic Stock Market), the FCJ prefix and the Z6C fixture. **All are
unpinned.** Every `YellowSignEvent` in the corpus is JUNO-Z6C's: index 203 (C&O's Mark, 2026-09-10 21:29, stored
outcome, no seed — replays through the legacy branch and is the one minting entry `moneyConservation` names), 567 (a
stale-build second Mark, 2026-09-11 02:14) and 569 (its revert). **No corpus file contains a Carcosa gift, a fog, a
Blood Price or a ghost train** (S9-2's sweep). The UR-off frozen golden `JUNO-CV4` nevertheless carries `revenue_seed`
on its runs (11 occurrences) — the client and the server draw on every table (§11).

---

## 6. The Yellow Sign

### 6.1 The sequence, as implemented

```
run (committed draw)                 request (separate message)            board
─────────────────────                ──────────────────────────            ─────
face 1, real malus, Mark line,  ──►  YellowSignEvent{protocol_id}  ──►  MARK: lowest-value train leaves; its route is
phases 2–4, nobody marked,                                              nullified, the rest re-rolled under the same
a train held                                                            face; +⌊½ face value⌋ (minted); has_yellow_sign
face 6, real bonus, Marked corp,──►  YellowSignEvent{protocol_id}  ──►  CARCOSA: ghost train of the depot's lowest tier
phases 5–D, Carcosa roll < 60                                           (owned + ghost_trains + carcosan_trains);
                                                                        is_carcosan; doom set now if a real D exists
Carcosan corp runs after its    ──►  YellowSignEvent{protocol_id}  ──►  FOG: one gilded copy (+ its gilding and
deadline set has ended                                                  provenance) leaves; the roll is untouched
gilded train sold to another    ──►  BuyTrainFromCorporation        ──►  BLOOD PRICE: seller Left 1 / Down 1; seller
corporation                                                             absolved; buyer's train ordinary (+provenance)
```

On a pinned board the request carries no outcome; the arm (`sS:6114–6184`) derives it with `resolveYellowSign` from the
board AFTER the run's own settlement, using `derivePhase(state)` at the moment the request is applied.

**The sequence as ruled (rev 2 — not implemented; §6.1–§6.4 describe the code at `3f862c4`).**

* **Mark and Carcosa** are automatic consequences of the run (OD-UR-1): the authority resolves them from that run's
  committed seed, printed total and phase. No client message sends, withholds, delays, redirects or manufactures them;
  on a pinned table a client `YellowSignEvent` is not a source of authority. The narration reads what the board applied.
* **The Mark** chooses from the fleet after the Run → Dividends settlement (OD-GR-3), so a Gentle Rust Final Run train is
  never a candidate; the award is minted (OD-UR-4).
* **Carcosa's gift** never advances the phase (OD-UR-3); the first REAL train of its tier does, normally.
* **The fog** is not a run stage: an authoritative transition at the **end of OR set N+1** removes the gilded train
  (OD-UR-2 — "N+1 + boundary").
* **The Blood Price** stays a sale; its consequences for the buyer's train and the share price wait for OD-UR-5 (OPEN).
  *(Rev 5: the buyer's train is ORDINARY — OD-UR-5(a); the sale names the copy and only the gilded copy's sale is the
  Blood Price — OD-UR-5(c); whose share price moves still waits for OD-UR-5(b), OPEN.)* *(Rev 7: the buyer's marker
  moves Left 1 / Down 1 and the seller's does not — OD-UR-5(b); UR-F22.)*
* A gilded train cannot be a Diesel trade-in (OD-UR-7).

### 6.2 UR-F1 — why the sign never reaches the board in a room

1. In a room a click on Run Routes **appends and returns** (`App.tsx:6203`, the append block ends with `return`); the
   board changes only when the log drain applies the committed entry.
2. The drain sets `replayingRef.current = true` for its whole duration (`App.tsx:12143`, cleared in `finally` at
   `:12364`) and applies each entry through `runGameplayActionRef.current(…, { isRemoteReplay: true, automatic: true })`
   (`:12251–12252`). This is the path for a player's OWN live action too — on both transports (the server link feeds the
   same `drain`, `:12413`; Firestore snapshots `:12465`).
3. Inside that call, the Unpredictable Revenue block (`App.tsx:7141–7145`) composes the sentence and, when a stage
   resolves, calls `void runGameplayAction("YellowSignEvent", …, { silentInLog: true })` (`:7400`, `:7426`, `:7445`) —
   **without** `isRemoteReplay` or `automatic`.
4. The first statement of the room branch of `runGameplayAction` is #1407's guard (`App.tsx:6235–6242`):
   `if (options?.isRemoteReplay !== true && options?.automatic !== true && replayingRef.current) { setSandboxRoomError(CATCHING_UP_BANNER); return; }`
   — evaluated synchronously, before any `await`, while the drain's flag is still `true`. The request is refused
   locally and never sent; the "Catching up" banner the refusal sets is cleared when the drain finishes (`:12366`).
5. No other code produces a `YellowSignEvent` (the engine's derived kinds are `skip | end-turn | forced-withhold |
   accepted-offer`, `gameEngine/derivedActions.ts:97`).

**Consequences in any room game with the variant on.** The Activity Log prints the Mark (the reduced run line, the
sign's line, "President X added $N to the company's treasury. Treasury $A → $B."), plays the sign's video and sound —
and the board keeps the train, the money and the revenue. `has_yellow_sign` never lands, and the narration's
log-sentence fallback cannot parse #1375's second line (`YS:288` needs "<TICKER> ran for $"), so every client keeps
reading the game as unmarked: **a later natural Mark line can be narrated again, and Carcosa and the fog can never
occur.** The dividend panel reads the board, so it contradicts the narrated run line.

**Chronology.** The request has been dispatched from inside the narration since round 31/33 (2026-08-30/31) and was
rewritten to a bare request by Stage 9.4d (`69f4275`, 2026-09-19). #1407's guard landed in `c90d5b1` ("round 40",
2026-09-11). The only `YellowSignEvent` entries in the corpus (JUNO-Z6C 203 at 2026-09-10 21:29 and 567 at 2026-09-11
02:14 from a stale tab) predate it. This is consistent with UR-F1 but does not prove it — a Mark is rare (≈ 1 in 690
qualifying runs) and FCJ's 97 runs (2026-09-14) need not have drawn one.

**Confidence.** High, by static trace: the guard's condition, the options passed and the drain flag are all literal.
It was **not executed** — no harness mounts `App.tsx`, and building one is implementation work. **UR-3 must reproduce it
first** (a harness around the drain, or a live hosted game with a forced seed via an injected `mintSeed`).

### 6.3 The brief's questions

| question | answer (current code) |
|---|---|
| triggering condition | Mark: UR-N29. Carcosa: UR-N38. Fog: `fogIsDue` (holds a gilded train and `macro_round_number > carcosan_doom_after_macro_round`). All three are evaluated on the run's committed draw (`last_run_revenue_seed`) and printed total. |
| exact timing | **Intended:** in the drain of the run, before the president declares dividends. **Actual:** never, in a room (UR-F1). **Reducer:** whenever a request arrives — any step, any round, any later phase, while the run's draw is still on the board (the whole rest of that turn) — and for the fog, any time at all (UR-F2). |
| what "cheapest train" means | The lowest printed depot price (`DEPOT_COST`: 2 = $80, 3 = $180, 4 = $300) over `owned_trains` (`YS:151`). In phases 2–4 only 2-, 3- and 4-trains exist, so `DEPOT_COST` and the LPF-aware `depotCostFor` cannot disagree. |
| ties | Only identical models can tie (every tier has a distinct price); the first held is taken, and the removal splices the first occurrence of that model (`sS:6559`). Model-level; no train identity. |
| source | The Marked corporation's own fleet (`owned_trains`) — never the depot or the Bank Pool. The gift's source is the depot RULE (`openDepotTiers`) without taking stock. |
| obsolete / special trains | A Gentle Rust Final Run train is in `owned_trains` and is, in principle, eligible (owned-fleet semantics) — see §7. A gilded train cannot coexist with a possible Mark (the Mark needs nobody marked or Carcosan). |
| identical models | Treated as interchangeable. Ordinary + reprieved copies of one model cannot coexist by legal play (§7.1), so this is safe today. |
| atomicity | Each stage's mutation is atomic inside its arm. **The sign is not atomic with its run** — it is a second message (UR-F2). |
| trainless? | Yes — "even down to zero trains" (#1046); P-G1′ shows B&O left with `[]`. |
| forced purchase | Not at the Mark: the ordinary obligation applies in that turn's Buy Trains (`trainObligationFor` reads `owned_trains`). In the intended flow the award lands first, so it helps fund the purchase. Not live-tested. |
| train limits | The Mark only removes. The gift is limit-exempt for its lifetime (`countableTrainCount`). The fog removes an exempt train, so it creates no over-limit state. A gilded train is never an excess-discard candidate (countable trains only). |
| Diesel exchange | No interaction for the Mark (phases 2–4; no Diesel yet). A **gilded** 5 or 6 may be traded in today — unruled, with broken consequences (P-I) → OD-UR-7. |
| LPF | The only live Mark (JUNO-Z6C 203) was on an LPF board. Under LPF the gift reads the 6 / 7 / D shelf (`openDepotTiers`); by reading, a gifted 7 in phase 6 turns the derived phase to "7" (presented as 6, "no effect") and a gifted D is UR-F4 (not probed under LPF). No other LPF-specific branch. |
| logging | The narration writes the lines; the request is dispatched `silentInLog`; the board change is visible through the diff (`describeFleetLosses` skips the sign's train, #1264). |
| statistics | Stage lived through → Carcosan Railways; Blood Price → The Redeemer; the Mark's and the fog's trains get fate "taken", never rust (UR-N55–N56). |
| replay | A pinned request replays through the same derivation; an unpinned stored outcome replays as stored (JUNO-Z6C 203, #1046's zeroing). |

### 6.4 The Stage-10 S10-21 "Yellow Sign fixture"

**S10-21 is not a fixture that exists — it is an OPEN request for one** (`RULES_HARDENING_BACKLOG.md` S10-21 — lines
3305–3347 at the baseline, before this pass appended its UR-1 note; routed to this certification as a category-D,
test-substrate deliverable). It asks for **a completed game with Unpredictable Revenue (Yellow Sign) on, containing a
Mark, rust, a Bagholder and a Little Engine**, committed beside the golden logs, so that the assertions displaced from
JUNO-Z6C by Batch 7.5 can be restored. It must come from legal play under the current engine or from a deliberately
constructed legal game with stated provenance — never from hand-editing an old log.

What pins nearby behaviour today (nothing here is repinned or rewritten):

| artifact | what it pins | notes |
|---|---|---|
| `utils/__fixtures__z6cLog.json` (JUNO-Z6C through 494) | the development-corpus replay of the historical game | unpinned; `gameHistory.test.ts` "JUNO-Z6C under rules engine version 5" characterizes its timeline (to OR 10.1 under `DEVELOPMENT_CORPUS_POLICY`; `[SR 1, OR 1.1, Final]` without the adapter) |
| `moneyConservation.test.ts` | that the corpus's only non-deal mint is `"203 YellowSignEvent +90"` (C&O's Mark, stored outcome) and that a synthetic unpinned board still mints the award | the `MINTS_BY_DESIGN` exemption; its own comment expected S9-1 to close it — it did not (OD-UR-4) |
| `yellowSignAuthority.test.ts` case 7 | the unpinned stored-outcome branch in Z6C 203's shape (#1046 zeroing kept) | legacy replay |
| displaced assertions (no live coverage) | Carcosan Railways / "Marked by an Outer God"; Gravedigger and Rust Belt in dollars; The Cowboy; the Bagholder and Little Engine detail formats (now vacuous on CV4); the > 10-OR, phase-5 timeline | listed in S10-21 |

**Finding.** Under the current code a hosted game **cannot produce** the Mark S10-21 asks for (UR-F1), and any fixture
built today would pin the request-based authority UR-3 is expected to change *(rev 2: the authority OD-UR-1 retires)*
and would be dealt at version 9. S10-21 should therefore be produced **after** UR-3 / UR-4, as part of the
certification-evidence slice UR-7 (§15) — either a live hosted game with an injected `mintSeed` or a constructed legal
game run to the bank's end (§14.4) — and re-verified across the closure boundary in UR-8.

---

## 7. OD-GR-3 — decision brief (rev 2: DECIDED — §7.3)

**The question (D-36).** What happens when the Yellow Sign's cheapest-train removal meets a Gentle Rust reprieved /
Final Run train? *(Rev 2: the owner chose A2 — "never". §7.1 and §7.2 are kept as the record of the choice.)*

### 7.1 Facts established by this audit

| fact | evidence |
|---|---|
| The Mark selects over `owned_trains` — owned-fleet semantics, reprieved copies included. It never consults `pending_rust_trains`, the train-limit count or the transaction candidates. | `YS:151`, `sS:6559` |
| The Mark's removal splices one copy from `owned_trains` and **never touches `pending_rust_trains`**. A reprieved copy taken this way leaves an **orphan mark** (breaking GR's `doomed-this-turn ⊆ marks ⊆ owned` invariant) and pays half its face value. | P-H: owned `["2","3","4"]`, marks `["2"]` → owned `["3","4"]`, marks `["2"]`, treasury +$40 |
| A Final Run train that has just run is **destroyed by the run itself**: `RunMultipleRoutes` moves the cursor to Dividends and entering Dividends expires the grace-turn marks — before any sign request can be applied. So in the intended flow the reducer's Mark can never take it. | `sS:4283–4285`, `:4244–4247`; P-C: after the run, owned `["3"]`, marks `[]` |
| The narration judges the Mark on the fleet **as it ran** (the board before the run), so it names the Final Run train while the reducer — if the request were delivered — takes the next cheapest; if no other train remains, the narration marks and the reducer does nothing. | `App.tsx:7147`, `:7262`, `:7339`; P-C: narration "2" / $40, reducer "3" / $90 |
| After that destruction the run's breakdown still indexes the pre-destruction fleet, so the Mark nullifies the **destroyed train's** route and keeps the taken train's. | P-C: breakdown left `[{train_index: 1, model: "3"}]`, printed 90 — UR-F5 |
| A reprieved train can reach the Mark today only through a **delayed request** after a self-triggered rust (the corporation runs, buys the phase-changing train, then asks). | P-H — UR-F2 |
| Identical ordinary + reprieved copies of one model **cannot coexist by legal play**: a rust marks every copy in play in one sweep (#1032); the depot is sold out of that tier; pool copies are scrapped with no reprieve (`sS:1346–1352`); reprieved copies cannot be sold (D-34) or traded in (D-35). Model-level selection is therefore sufficient — provided a taken reprieved copy takes its mark with it. | code reading |
| The statistics already class a sign's taking as "taken", never rust; a later expiry of an orphan mark books nothing (it intersects actual losses). | `gameHistory.ts:562`, `:723–735`; `sS:1482–1530` |
| If the Mark leaves the corporation trainless, the ordinary obligation applies in that turn's Buy Trains. | `trainObligationFor` |

### 7.2 The owner's choices (the smallest set)

*(Rev 2: decided — A2; see §7.3. The options below are history.)*

**OD-GR-3a — Which fleet does the Mark judge?**

* **A1 — the fleet as it ran**: the trains that produced this run, including a Final Run train on its grace turn.
* **A2 — the fleet after the run's own settlement**: a Final Run train destroyed at the end of Run Routes is gone before
  the Mark and can never be selected. *(The current reducer's basis.)*

Whichever is chosen, the narration must use the same basis (UR-F6), and OD-UR-1 must place the sign's resolution on the
correct side of the Run → Dividends boundary.

**OD-GR-3b — only if A1 is chosen (or if any path can still reach a reprieved train): is a reprieved train eligible?**

* **B1 — eligible like any owned train** (SR-1: a reprieved train "remains owned … remains usable").
* **B2 — not eligible**: the Mark chooses among non-reprieved trains only — the same set the transaction locks and the
  train-limit count already use. If only reprieved trains are held, the Mark cannot fire and its line stays in the pool
  (#1046: "a stage with no train does not fire").

*(Under A2 with the sign bound to its run, no reprieved train can be present at the Mark — the only reprieved trains
created after a run are created in that turn's later Buy Trains step — so OD-GR-3b and OD-GR-3c become unreachable and
need no answer.)*

**OD-GR-3c — only if B1: what the taking means.** Two existing rulings point different ways and the owner must say
which governs:

| dimension | reading from S9-3 (the Mark) | reading from SR-7(c) (Gentle Rust: a reprieved train "may not escape or monetize that destruction") |
|---|---|---|
| award | ½ face value into the treasury | no award |
| the train's final run revenue | nullified (the taken train's run) | — (a choice for the owner) |
| classification (statistics, narration, Gravedigger credit to the purchaser who triggered the rust) | a Yellow Sign taking ("taken"; no rust credit) | the rust's destruction (rust fate; Gravedigger / Rust Belt) |

Not a choice, but a consequence either way: a reprieved copy that leaves by the Mark must take one mark with it (no
orphan), and a corporation left trainless meets the ordinary obligation in that turn's Buy Trains.

### 7.3 Decision (rev 2, 2026-09-24) — OD-GR-3 = A2: "never"

**The owner chose 3a = A2.** The Mark judges the corporation's fleet **after** the Run → Dividends settlement. Gentle
Rust's Final Run destruction happens at that settlement, before the Mark chooses a train. Therefore:

* a Gentle Rust reprieved / Final Run train is **never** eligible for the Mark;
* **OD-GR-3b and OD-GR-3c are moot** — not deferred: under A2 no reprieved train can be present when the Mark chooses,
  so there is nothing left to decide;
* **no special exception** lets the Mark monetize, take or replace a Gentle Rust destruction (SR-7(c) is untouched);
* the Mark takes the cheapest train that survives the settlement; if none survives it does not fire and its line stays
  in the pool (#1046, "a stage with no train does not fire"); a corporation it leaves trainless meets the ordinary
  obligation in that turn's Buy Trains. The "no orphan mark" consequence above can no longer arise.

**What the implementation must align (UR-3 — not done here).** Reducer authority, route attribution and narration all
use the post-settlement fleet. **UR-F5** (the breakdown still indexing the destroyed train, so the wrong route is
nullified) and **UR-F6** (the narration judging the fleet as it ran) are **bugs against this rule, not evidence for
changing Gentle Rust semantics.** P-H's path — a request delayed past a self-triggered rust, taking a doomed train and
leaving an orphan mark — disappears with OD-UR-1's automatic resolution; UR-3's tests pin that no reprieved copy is ever
a Mark candidate.

**Closure.** D-36 (backlog Part D) and the Gentle Rust audit's GR-S26 are closed as an **owner-decided interaction**.
Gentle Rust's own semantics do not change. Combined Gentle Rust + Unpredictable Revenue is still **NOT certified**: its
evidence belongs to UR-3 (the fixes) and UR-7 (G1's milestone M3).

---

## 8. Revenue and rounding

### 8.1 What is modified, when, and in what order

* **What.** The corporation's route revenue for its Operating turn — the sum of the printed values of every route its
  trains ran (UR-N4). Nothing else: private income, auction proceeds, terrain fees, train and token prices are
  untouched (UR-N12).
* **When.** Once, at the committed `RunMultipleRoutes` (the draw is the server's, §5.1). A Mark later re-applies the
  same face to what remains after the taken train's route (UR-N32).
* **Order.** (1) The authority prices each route (`evaluateRouteSet`: board topology, era, LPF licence / Coal River,
  phase-dependent off-board values) → (2) sum → (3) × face percentage, integer half-up to the dollar → (4) half-up to the
  nearest $10 → (5) that figure is `last_route_revenue`, the only figure Dividends may declare (UR-N8) → (6) Pay splits
  it / Withhold banks it; the share price steps on it (Dynamic Stock Market multiples judge it). No other revenue
  modifier exists in the game.
* **Highest-revenue rule.** Judged on printed totals before the die (UR-N10). Because the face applies to the total and
  rounding is monotone, the best printed set is also the best paid set.

### 8.2 The rounding, exactly

`paid = roundToTen(trunc((printed × pct + 50) / 100))`, `roundToTen(v) = ⌊(v + 5) / 10⌋ × 10`. Every printed route
value on the three boards is a multiple of $10 (the only non-multiples in the data are private-company incomes, which
the die never touches), so step (3) is exact and only the $10 rounding matters. Paid figures by face:

| printed | face 1 (80%) | face 2 (90%) | faces 3–4 | face 5 (110%) | face 6 (120%) | mean of the six |
|---|---|---|---|---|---|---|
| $10 | 10 | 10 | 10 | 10 | 10 | 10 |
| $20 | 20 | 20 | 20 | 20 | 20 | 20 |
| $30 | **20** | 30 | 30 | 30 | **40** | 30 |
| $40 | 30 | 40 | 40 | 40 | 50 | 40 |
| $50 | 40 | **50** (45 → 50) | 50 | **60** (55 → 60) | 60 | **51.67** |
| $70 | 60 | 60 | 70 | 80 | 80 | 70 |
| $80 | **60** (−25%) | 70 | 80 | 90 | 100 | 80 |
| $100 | 80 | 90 | 100 | 110 | 120 | 100 |
| $150 | 120 | 140 | 150 | 170 | 180 | **151.67** |

Characterization, all consistent with #938 and #961: (a) at ≤ $20 every face is swallowed — no bonus, no malus, the
"unchanged" bucket, and therefore **no Mark and no Carcosa**; (b) faces 2 and 5 are swallowed up to $40; (c) the effective
swing can exceed the nominal one ($80 at face 1 pays $60) — the Lobby's rounding clause exists for this; (d) **ties round
up, so whenever printed ≡ $50 (mod $100) the expected payout is printed + $1.67** — the table is mean-preserving, the
rounded payout is not quite (→ OD-UR-10, confirmation only). Bounds: `roundToTen(0.8 P) ≤ paid ≤ roundToTen(1.2 P)`;
printed ≥ $10 never pays $0; nothing is negative (printed is clamped at 0). A forced $0 withhold has nothing to roll.

*(Rev 4 — OD-UR-10 DECIDED, 10-C; not implemented.)* An exact $5 tie rounds **toward the printed revenue**; every other
amount still rounds to the nearest $10. Every printed value is a multiple of $10, so only faces 2 and 5 (±10%) can tie,
and only when printed ≡ $50 (mod $100). The −10% tie already rounds up to printed today ($45 → $50, $135 → $140,
$225 → $230) and does not change; the +10% tie is the one that moves — $55 → **$50**, $165 → **$160**, $275 → **$270**
(half up gives $60, $170, $280). The $50 row above becomes 40 / 50 / 50 / 50 / 50 / 60 (mean **50.00**) and the $150 row
120 / 140 / 150 / 150 / 160 / 180 (mean **150.00**): under 10-C the six-face mean equals the printed figure at every
printed multiple of $10, which removes item (d)'s +$1.67. A +10% tie that rounds back to printed is an "unchanged"
outcome (UR-N14: the outcome is judged on the figures), so its flavour bucket and its turn sentence change with it; the
Mark (face 1) and Carcosa (face 6) never meet a tie. **UR-F20** carries the implementation, in UR-7: the die's rounding
step (`rollTurnRevenue`, `roundToTen(applyRevenuePercent(…))`, `gameVariants.ts:1232`) needs the printed figure
(`roundToTen` is a generic helper whose half-up case RR pins), and the change has to leave the unpinned corpus's
Unpredictable Revenue logs replaying as they were played (X13 / D-9), as UR-3's rules did — measured in that slice.

### 8.3 Projected versus applied

| surface | figure | agrees with the authority? |
|---|---|---|
| route planner, auto-tracer, pre-run projections | printed | yes — by design (#903), they never roll |
| the turn sentence ("ran for $X", swing %) | paid, from the committed seed | yes |
| the Dividends panel / the declaration | the board's `last_route_revenue` | yes |
| the Mark's run line ("ran N routes for $Y") | the narration's own `runWithoutTrain` on the post-run board, with the pre-run fleet's cheapest train | **no** — in a room the Mark never lands (UR-F1), so the panel shows the full figure beside a reduced log line; and under Gentle Rust the narration picks a different train (UR-F6) |
| revenue statistics | printed | **differs from the money** under the variant (UR-F8, OD-UR-6) — *rev 5: OD-UR-6.1 rules the paid figure (UR-5)*; *rev 7: per train, the printed value of the completed route — not an allocation of the paid total* |

**Duplicated calculations.** None: `rollTurnRevenue` is the one implementation and is called by the reducer's two run
arms, `resolveYellowSign`, `runWithoutTrain`, the narration and the statistics' Cowboy classification, always on the
committed seed. What differs between readers is the INPUT (which fleet, which board), not the arithmetic — which is
exactly where UR-F5 and UR-F6 live.

---

## 9. Interactions with other variants and the expanded boards

| interaction | classification | notes |
|---|---|---|
| Gentle Rust × the die (a Final Run train's run is priced and rolled like any train) | **correct and tested** | GR-S14, certified in GR-4 (GR-1 route test) |
| Gentle Rust × the Mark | ~~ambiguous → OD-GR-3~~ *(rev 2)* **decided: never** — a Final Run train is never a Mark candidate; **incorrect** today in UR-F5 (route attribution) and UR-F6 (narration basis) | §7.3 |
| Gentle Rust × a delayed sign request after a self-trigger | **incorrect** (orphan mark, a monetized doomed train — P-H) | closes with UR-F2 |
| Gentle Rust × a Carcosa gift above the phase | **incorrect** — the swallowed phase change also skips Gentle Rust's marking of the 3s / 4s; *(rev 2)* under OD-UR-3 the gift marks nothing and the first REAL train of the tier marks normally | UR-F4 |
| Gentle Rust × the fog | not applicable (the fog is not rust; gilded trains are 5 / 6 / D / 7) | — |
| Level Playing Field × the gift | **correct but under-tested** for 6 / 7 on the LPF shelf; **incorrect** for a gifted D above the phase; *(rev 2)* OD-UR-3 applies to every LPF window | UR-F4 |
| Level Playing Field × the Mark's award ($900 D, $750 exchange) | not applicable (the Mark is phases 2–4) | `markPayout` uses printed 2 / 3 / 4 prices |
| Level Playing Field × route authority (Coal River licence, warehouse towns) × the die | **correct but under-tested** with the variant on | the die applies after authority pricing |
| 18XX+ tile set × a gifted D above the phase | **incorrect (by reading)** — `settleEra` reads the derived phase, so a ghost D opens the Gray era early; *(rev 2)* under OD-UR-3 the era advances only with REAL trains | part of UR-F4; not probed |
| Diesel exchange (every table since #1439) × a gilded 5 / 6 | ~~ambiguous → OD-UR-7~~ *(rev 2)* **decided: refused (OD-UR-7)** — the current acceptance is UR-F17, and it was **incorrect** whichever way it was ruled: orphan gilding and provenance, the curse kept, the fog escaped without the Blood Price, and the synthetic train materialized in the Bank Pool displacing a printed one (P-I) | — |
| Dynamic Stock Market × the die | **correct but under-tested** (JUNO-3XD plays both, unpinned) | multiples judge the paid figure |
| Delayed Auction × the variant | not applicable | independent |
| Game length (bank size) × the Mark's award | ~~ambiguous → OD-UR-4~~ *(rev 2)* **decided: minted** — the award never shortens the bank's clock, by rule | P-E |
| Emergency funding × a Mark that leaves a corporation trainless | **correct but under-tested** | UR-N34 |
| the train limit × the gift | **correct and tested** | `stage95GhostLimit` A |
| the Blood Price × the server | **correct and tested** | #1690, `bloodPriceArrival`, `stage103CompositionCoupling` |
| private companies × the variant | not applicable | untouched |

---

## 10. Awards, statistics and history

**Source.** Everything in `utils/gameHistory.ts` is derived by replaying the log and diffing the board before and after
each authoritative entry — never from narration. The accolade catalogue (`utils/accolades.ts`) reads those tallies.

| statistic / award | what it reads | under the variant |
|---|---|---|
| The Workhorse ("highest lifetime revenue"), lifetime revenue | `printed_route_revenue` at each `RunMultipleRoutes` (`:436–437`) | **printed, not paid**; a Mark-nullified run still counts |
| The Juggernaut ("single biggest Operating Round") | the same printed figure (`:442–445`) | printed |
| Master of the Line ("single most valuable train run") and the per-train ledger's "earned" | `last_run_breakdown[].printed_revenue` (`:446–449`, `:471–476`) | printed; the nullified taken train's run still counts |
| the Revenue-per-OR chart | the printed figure (`:470`) | printed |
| Robber Baron, The Dividend Machine, dividends paid, withheld, The Hobo | the money that moved on `DeclareDividends` (`:405–427`) | **paid** — so under the variant "revenue" and "dividends + withheld" disagree by the die |
| The Cowboy (animal lines) | the NATURAL flavour line re-derived from the seed (`:451–457`) | **ignores** the sign's replacement and the skip — UR-F9 |
| Carcosan Railways, "Marked by an Outer God" | the stage the board actually applied (`yellowSignStageApplied`, `:721–742`) | correct by reading; **no live coverage** (S10-21); never fires in rooms today (UR-F1) |
| The Redeemer | a sale of a model the seller's `carcosan_trains` names (`:743–748`) | model-level, like the reducer (OD-UR-5(c)) |
| Gravedigger, The Rust Belt, the fleet ledger's fates | fleet-loss diffs; the sign's takings get fate "taken" and are excluded (`:556–612`) | correct; a ghost-driven phase jump records the request's actor as the "cause" of that tier (`rustCauseByTier`, `:557–561`) — UR-F4 *(rev 2: under OD-UR-3 a gift never causes a phase jump, so the cause is the real purchaser once UR-F4 is fixed)* |
| Phase Rusher ("only a train purchase can" move the phase, `:640–649`) | any entry under which `derivePhase` changed | **a Carcosa gift above the phase credits the request's sender** — UR-F4 *(rev 2: OD-UR-3 — a gift receives no Phase Rusher treatment)* |
| Fleet Admiral, the per-train ledger's count/paid, The Early Adopter ("first corporation to buy a Diesel") | any train that joined a roster (`:651–670`) | **a synthetic gift counts as a purchase, and a gifted D can be "the first Diesel bought"** — UR-F8 |
| White Elephant, Little Engine | lifetime (printed) revenue vs train spend | printed basis (OD-UR-6) |

**U-9-class discrepancies** (a statistic booked at a different event, or on a different figure, than the authority's):
the Mark-nullified run booked as earned at the run; synthetic gifts booked as purchases; the Cowboy's natural-line
reading; printed-versus-paid revenue. All are UR-specific and are routed to UR-5; OD-UR-6 decides the intended basis
*(still OPEN at rev 2)*.

*(Rev 5 — OD-UR-6 DECIDED; not implemented: UR-5, UR-F8.)* **Corporation / turn level → the revenue actually paid
(6.1):** The Workhorse and lifetime revenue, The Juggernaut, the Revenue-per-OR chart, White Elephant and Little Engine
read the paid figure the run leaves for the Dividends step (`last_route_revenue`), not `printed_route_revenue`; the
dividend family already reads paid money. **A Mark-nullified route is not earned (6.2):** at the corporation level the
paid figure already leaves it out (the Mark's kept runs are what the die rolled); per train, the taken train is credited
nothing for the route the Mark nullified. **Per train (Master of the Line, the fleet ledger's "earned"):** the die
adjusts the turn total and no canonical per-train allocation exists — ~~the **isolated open sub-question of 6.1**; UR-5
adopts neither the printed figure nor a proportional split by default~~ *(rev 7: ruled — the printed value of the
completed route, below)*. **Purchases (6.3):** the Carcosa gift joins no
purchase statistic — Fleet Admiral, the fleet ledger's count and paid, "bought a Diesel", The Early Adopter and
analogous purchase-derived awards skip it, so a gifted D is never "the first Diesel bought"; a Blood Price acquisition
by another corporation is a purchase by the buyer and counts as one, a Diesel included (it already joins the buyer's
roster as a purchase today). The Redeemer follows OD-UR-5(c): the ordinary copy's sale redeems nothing (UR-F21). UR-3's
`yellowSignRunBoundStats` pins today's basis ("the run's figures keep their basis" — printed, the nullified route
included); UR-5 changes those pins with the rule.

*(Rev 7 — the per-train question DECIDED; not implemented: UR-5, UR-F8.)* **Train / route level → the printed value of
the train's successfully completed route:** Master of the Line and the fleet ledger's "earned" read each completed
route's printed figure — the route's own figure, never a share of the paid total (no proportional, equal or die-adjusted
per-train value is invented) — and a route the Mark nullified contributes nothing (6.2). Today's per-train basis is
already the printed route (`last_run_breakdown[].printed_revenue`), so the only per-train change is the nullified route,
which `runBeforeSign` puts back today. **Corporation / turn level** stays the paid figure (rev 5 above). The two levels
are separate rules: the per-train figures are not expected to add up to the paid turn total.
**No unrelated pre-existing statistics issue was found** beyond U-41, which is untouched here.

---

## 11. Standard-mode (variant-off) controls

| control | today | evidence |
|---|---|---|
| a run pays its printed total (no roll) | **holds** | P-A (`last_route_revenue` = `printed_route_revenue` = 180); `rollTurnRevenue` gated at `sS:6282` |
| the seed is still drawn and stored | the client and the server draw for every run on every table (`App.tsx:10020–10033`, `serverIngress.ts:84–93`) and the arm writes `last_run_revenue_seed` on every table; inert for revenue | harmless, but it is the input UR-F3 uses; optional hardening: mint only when the variant is on |
| a `YellowSignEvent` is refused | **FAILS — UR-F3** (applied through hosted ingress: the 3-train taken, +$90 minted, the kept remainder re-rolled 90 → 70) | P-A |
| no flavour, sound or sign narration | holds (`App.tsx:7144` gates on the variant) | reading |
| phase, rust and the depot are untouched | holds — no ghost can exist unless a sign lands (so UR-F3 is also the only route to UR-F4 on a standard table) | reading |
| replay of standard logs | holds — the UR-off goldens (CV4 / 7NZ / G6J) replay unchanged; CV4 carries seeds that change nothing | golden suites (owner's full run) |
| standard statistics | hold (no seed read without the variant; the Cowboy is gated) | `gameHistory.ts:452` |
| schema | `YellowSignEvent` is admitted by shape on every table (`messageSchema.ts:300`); the refusal belongs to authority | reading |

**Accidental unconditional branches found:** (1) the `YellowSignEvent` arm and its ingress path have no variant check
(UR-F3); (2) `runWithoutTrain` applies the UR die to the kept remainder whatever the table (reachable only through (1));
(3) seeds are minted and stored on every table (inert). No other UR code path runs without the flag.

---

## 12. Findings and decisions

### 12.1 Findings (UR-F1 … UR-F22)

*(Rev 2: the "needs" column names the ruling that now settles each finding, and the slice that owns the fix. UR-F18 is
new; UR-F10 is closed as intended.)* *(Rev 3: UR-3 fixed UR-F1, UR-F2, UR-F3, UR-F4, UR-F5, UR-F6, UR-F7, UR-F17 and
UR-F18 — marked in the "needs" column; UR-F19 is new, and was fixed in the same slice once the owner decided OD-UR-13.
Status and evidence: "UR-3 implementation (rev 3)".)* *(Rev 4: UR-F20 is new — OD-UR-10's decided tie rule makes today's
half-up tie a defect; not implemented, UR-7.)* *(Rev 5: UR-F21 is new — OD-UR-5(c)'s copy distinction makes the
model-level Carcosan transfer a defect (UR-4); UR-F8 gets its targets from OD-UR-6; UR-F11's Blood Price half narrows to
OD-UR-5(b).)* *(Rev 7: UR-F22 is new — OD-UR-5(b)'s buyer-only move makes #1090's seller move a defect (UR-4); UR-F8's
per-train target is decided; UR-F11 is closed — every contradiction it named is ruled.)* *(Rev 8: UR-4 fixed UR-F21 and
UR-F22, and — found in the slice, intrinsic to 5a-1 — the cured copy's stale provenance through the Bank Pool, not given a
UR-F number because it is fixed in the slice that exposed it ("UR-4 implementation (rev 8)").)*

| id | severity | class | finding | evidence | needs |
|---|---|---|---|---|---|
| **UR-F1** | HIGH | wiring / narration ≠ authority | The Yellow Sign never reaches the board in a room: its request is dispatched from inside the drain and refused by #1407's catch-up guard; the narration reports stages that never happen, may repeat the Mark, and never reaches Carcosa or the fog. | §6.2 (static) | OD-UR-1 **decided** (1-A); reproduce first — UR-3 · **FIXED rev 3 (pinned tables; unpinned residual)** |
| **UR-F2** | HIGH | authority | The sign's request is not bound to its run: omission, delay past a phase change or a Buy Trains step, any corporation as the target, any step or round; the reducer judges the window at application time; a race with `DeclareDividends` is possible. #1451 had recorded "who may send it is `turnAuthority`'s and is recorded as deferred" — never carried into the backlog; S9-1 closed the outcome and the input only. | P-D, P-G1′, P-G2′, P-H | OD-UR-1 **decided** (1-A) — UR-3 · **FIXED rev 3 (pinned tables; unpinned residual)** |
| **UR-F3** | HIGH | variant-off control | No variant gate on the request (ingress or reducer): a standard table applies the Mark, mints the award and re-rolls the kept remainder with the die. | P-A | none — a defect under #902 — UR-3 · **FIXED rev 3 (pinned tables)** |
| **UR-F4** | HIGH | rules corruption | A gift above the phase moves `derivePhase` (ghosts count, `GP:656–660`) without `applyPhaseChange`; the next real train of that tier is then no phase change (`sS:1834–1840`): no rust of 3s (gift 6) or 4s (gift D), no Gentle Rust marking, the D shelf opens early, the doom clock never starts for a ghost D (a permanent gilded train), the Gray era opens early under the 18XX+ tiles (by reading), and Phase Rusher / `rustCauseByTier` credit the request's sender. | P-B, P-F | OD-UR-3 **decided** (3-A: synthetic trains never advance the phase) — UR-4 · **FIXED rev 3 in UR-3 (owner's brief)** |
| **UR-F5** | MEDIUM | Gentle Rust × UR | After a Final Run destruction at the Run → Dividends boundary, `last_run_breakdown` still indexes the pre-destruction fleet; the Mark (`runWithoutTrain`, slot first) nullifies the destroyed train's route and keeps the taken train's. | P-C | OD-GR-3 **decided** (A2): attribute routes on the post-settlement fleet — UR-3 · **FIXED rev 3 (run path)** |
| **UR-F6** | MEDIUM | narration ≠ authority | The narration judges the Mark on the fleet as it ran; the reducer on the board after the run's settlement — different train and award, or a narrated Mark the reducer does not apply. | P-C; `App.tsx:7147`, `:7262`, `:7339` | OD-UR-1 + OD-GR-3 **decided** — UR-3 · **FIXED rev 3 (run path)** |
| **UR-F7** | MEDIUM | authority | A run without `train_indices` is legal (the authority pairs the trains itself) but writes no breakdown, so a Mark cannot nullify the taken train's route — the corporation keeps that revenue. | P-J | none — write the breakdown from the authority's pairing (or require the field on pinned tables) — UR-3 · **FIXED rev 3 (pinned Unpredictable Revenue tables: the authority's pairing)** |
| **UR-F8** | MEDIUM | statistics | Revenue statistics use printed figures; a Mark-nullified run is booked as earned; a synthetic gift counts as a purchase (Fleet Admiral, ledger) and a gifted D can be "the first Diesel" (Early Adopter). | §10 (static) | ~~OD-UR-6 — **OPEN**~~ OD-UR-6 **decided** (rev 5: 6.1 paid, in principle; 6.2; 6.3) — UR-5 · **OPEN — not implemented**; ~~the per-train allocation is 6.1's isolated sub-question~~ *(rev 7: decided — per train, the printed value of the completed route; OD-UR-6 fully decided)* |
| **UR-F9** | LOW | statistics | The Cowboy classifies the natural flavour line, not the printed one (a sign replacement or a skip changes the line). | `gameHistory.ts:451–457` | none — UR-5 |
| **UR-F10** | — (**closed rev 2: intended**) | money | The Mark's award is minted — no payer, no bank debit — on pinned tables too. Documented as `MINTS_BY_DESIGN`; the exemption's own comment expected S9-1 to close it; S9-1 did not. | P-E; `moneyConservation.test.ts:138`, `:186–254` | OD-UR-4 **decided** (4-A): the mint is intended variant law, not a defect; only the exemption's stale comment remains (Appendix B item 11) |
| **UR-F11** | — (**closed rev 7: every contradiction ruled**) | specification | S9-3's verbatim rule contradicts the implementation on the gilded train's expiry and on the Blood Price's effect on the train; S9-3's list of "contradictions … ALL THREE now closed" did not include them. | §1.2 | expiry: OD-UR-2 **decided** (→ UR-F18, fixed rev 3); Blood Price: OD-UR-5 **OPEN** — *rev 5:* the train, OD-UR-5(a), **decided** (the implementation conforms); the market consequence, OD-UR-5(b), still **OPEN** — *rev 7:* **decided** — the buyer only (→ **UR-F22**). Every contradiction it named is ruled; what remains is UR-F18 (fixed rev 3) and UR-F22 |
| **UR-F12** | LOW | player-facing copy | The gilded chip's tooltip says "Occupies no train-limit slot until this Operating Round ends" — superseded by #1672 (the whole Carcosa lifetime). | `components/TrainBadges.tsx:632` | none — UR-6 (the text follows OD-UR-2's lifetime) |
| **UR-F13** | LOW | Rules Reference | One sentence on the variant (the ±20% / $10 note); the die table, the per-turn aggregate, the Yellow Sign, Carcosa, the fog, the Blood Price and the limit exemption are absent, although S9-3 recorded its rule "for the later Rules Reference pass" and S9-4 makes the Rules Reference the sole player-facing authority. | `RulesReference.tsx:613–614` | OD-UR-8 **decided** (8-B) — UR-6; the Blood Price text waits for OD-UR-5 — *rev 7: OD-UR-5 fully decided; the text can say it (an additional ordinary train; the buyer's marker moves Left 1 / Down 1; the sale names the copy)* |
| **UR-F14** | LOW | copy | The variant is "Unpredictable revenue" (`VARIANT_COPY`, Rules Reference, Lobby) and "Unpredictable Routes" (host setup `HostSetupCard.tsx:75`, room list `LobbyRoomList.tsx:51`). | reading | OD-UR-12 **decided** ("Unpredictable Revenue") — UR-6 |
| **UR-F15** | INFO | hardening | A pinned-table run without `revenue_seed` would fall back to the predictable `legacyTurnSeed`; unreachable through the server (ingress always mints) but not refused by the reducer. | `sS:6288–6293` | none (optional) — UR-3 · *rev 3: not taken — still OPEN (INFO)* |
| **UR-F16** | INFO | hardening | The hosted seed source is `Math.random`. | `GV:929`; no `mintSeed` in `server/src/gameServer.ts` | OD-UR-9 **decided** (9-B: cryptographic) — implementation routed to AWS / live multiplayer, outside UR |
| **UR-F17** | MEDIUM | rules gap + state | A gilded (Carcosan) 5 / 6 can be traded in for a Diesel; the arm moves the train to the Bank Pool as ordinary stock and leaves the gilding, the provenance marker, the curse and the doom clock at the seller — the fog is escaped without a Blood Price and a synthetic train becomes physical stock. | P-I | OD-UR-7 **decided** (7-A: refused; an ordinary copy of the model stays tradable) — UR-4 · **FIXED rev 3 in UR-3 (owner's brief)** |
| **UR-F18** *(rev 2)* | MEDIUM | rules (ruled timing) | The fog is collected as a **run stage** — on the Carcosan corporation's first run after set N+1, through the sign request (`fogIsDue`, `YS:380`; the `stage === "fog"` arm) — where OD-UR-2 rules an **automatic removal at the end of set N+1**, at the OR-set boundary. Today's form gives the train one more run, keeps it alive indefinitely if its corporation stops running, leaves a post-deadline window to sell it, and (unbound) lets another seat collect it (UR-F2, P-D). **Do not restore `N+1 + on-run`.** | §6.1; UR-N45, UR-N46 | none — OD-UR-2 **decided** — UR-3 (fog authority and removal location) · **FIXED rev 3** |
| **UR-F19** *(rev 3)* | MEDIUM | rules state (pre-existing since #1046; reachable once UR-F1 is fixed) | The Mark removes the taken train from `owned_trains` and puts it nowhere; the derived depot (TOTAL − owned − pooled) takes it back as phantom stock when it is of the phase's own tier, and when it was the only train of that tier in play the phase falls back a tier (probe: phase 3 → 2, the depot offers 2-trains again; statistics credit a "phase move"). | probe (rev 3) | **OD-UR-13 — DECIDED** (rev 3, 2026-09-24): removed from the game, never the Bank Pool; phase progression monotonic — UR-3 · **FIXED rev 3 (pinned Unpredictable Revenue tables — `removed_trains`; unpinned residual)** |
| **UR-F20** *(rev 4)* | MEDIUM | rules (ruled tie direction) | An exact $5 tie of the modified revenue rounds half up (`roundToTen`), where OD-UR-10 = 10-C rules it toward the printed revenue. Only the +10% face can differ: printed $50 pays $60 where the rule gives $50 ($150: $170 vs $160; $250: $280 vs $270) — the +$1.67 expected bias at printed ≡ $50 (mod $100) (§8.2). | §8.2; `GV:1117`, `:1232` | OD-UR-10 **decided** (10-C, rev 4) — UR-7 (the rounding table and the tie rule); replay-semantic, owed to the v10 boundary · **OPEN — not implemented** |
| **UR-F21** *(rev 5)* | MEDIUM | rules (ruled copy distinction) | A seller holding a gilded and an ordinary copy of one model cannot sell the ordinary copy as an ordinary sale: the Carcosan transfer is model-level (`isCarcosanTransfer`: the seller's `carcosan_trains` names the model), so any sale of that model charges the Blood Price, absolves the seller and burns the gilding — where OD-UR-5(c) = 5c-2 rules that the sale names the copy and only the gilded copy's sale is the Blood Price. The sale message names a model (`BuyTrainFromCorporation.model_type`), and The Redeemer reads the same model-level predicate. | `sS:2053`; UR-N54, UR-N55 | OD-UR-5(c) **decided** (5c-2, rev 5) — UR-4 (how a sale names the copy; replay-semantic, owed to the v10 boundary) · ~~OPEN — not implemented~~ **FIXED rev 8 (UR-4)** — the optional `gilded` on the sale / proposal / offer / derived settlement; an unnamed ambiguous sale refused; provenance with the copy; The Redeemer reads the copy (every table) |
| **UR-F22** *(rev 7)* | MEDIUM | rules (ruled market consequence) | The Blood Price moves the **seller's** stock marker Left 1 / Down 1 — #1090's market arm, whose design note reads *"THE SELLER MOVES, NOT THE BUYER. The toll is for letting the thing go."* — where OD-UR-5(b) rules that the **buyer's** marker moves and the seller gets no separate stock-price movement (never both). Two player-facing surfaces repeat the superseded rule — the Train Purchase panel's warning (*"The selling corporation's share price will immediately drop (1 cell Left, 1 cell Down)"*) and the narration's design note (*"[Selling Corp]'s stock dropped"*) — and two suites pin it (`BPA`, `S103`: the seller's token). **Do not restore the seller move** from #1090, from that code, that copy or those tests. | `sS:2674`, `:2679`, `:2695` (at `9d0cf3a`); `TrainPurchasePanel.tsx:1388–1389`; `App.tsx:6904`; UR-N51 | OD-UR-5(b) **decided** (the buyer only, rev 7) — UR-4 (the move and its tests; replay-semantic, owed to the v10 boundary) and UR-6 (the copy) · ~~OPEN — not implemented~~ **FIXED rev 8 (UR-4)** — the buyer's marker moves, never the seller's; the warning, the prompt, the design notes and `BPA` / `S103` / `S103b` / GR-2 S8 / `B60` updated (every table) |

Stale comments and documentation are listed in Appendix B (not numbered findings).

### 12.2 Blocking owner decisions (needed before UR-3 / UR-4 / UR-5)

Options are listed without a recommendation; the facts after each are the consequences the audit can state.
*(Rev 2: each entry now opens with its status. The options are kept as the record of what was decided between; the
rulings in full are in "Owner rulings (rev 2)".)*

**OD-GR-3 — the Mark and a Gentle Rust Final Run train.** §7.2 (OD-GR-3a basis; OD-GR-3b eligibility, only if A1;
OD-GR-3c meaning, only if B1). **DECIDED (rev 2): 3a = A2 — "never"; 3b and 3c moot (§7.3).**

**OD-UR-1 — how the Yellow Sign is bound to its run** (UR-F1, UR-F2, UR-F6). **DECIDED (rev 2): automatic** — the stage
is a derived consequence of the authoritative run; no client may omit, delay, redirect or manufacture it; the
client-sent request is removed as a source of authority. Of the options below this is (a) or (b) — the same game; the
recording form is UR-3's engineering choice, and either form must resolve the Mark after the settlement (OD-GR-3 = A2).
(c) is not chosen: a client request is no longer a source of authority.

* (a) **Atomic with the run**: the run arm resolves and applies the stage in the same transition as the roll (before or
  after the Run → Dividends settlement, per OD-GR-3a); a pinned table accepts no separate request; the narration reads
  the applied result.
* (b) **Engine-derived follow-up**: the game appends the sign's entry immediately after the run, before any player
  action (a derived action, like the forced withhold); client requests are refused on pinned tables.
* (c) **A bound client request**: accepted only from the operating president, for the operating corporation, at
  Dividends immediately after its run, once — which still needs (b) as the fallback when it is not sent, or omission
  remains possible.
* Facts: all three change what a pinned `YellowSignEvent` means (replay-semantic → version 10); unpinned logs keep the
  stored-outcome branch; (a) and (b) close omission, delay and wrong-target by construction; with (b) the derived entry
  is reverted together with its run by an undo; the fog must be attached to the Carcosan corporation's run by the same
  mechanism; Firestore rooms (unpinned) can keep the local playtest force either way.

**OD-UR-2 — when the gilded train disappears** (UR-N45, UR-F11). **DECIDED (rev 2): "N+1 + boundary"** — the deadline
of (b) (#1089: the train survives all of set N+1) with the removal at the boundary (the sub-question's first answer,
S9-3's form): it disappears automatically at the **end** of set N+1, as an authoritative OR-set-boundary transition, not
on a run and not by a request. The current `N+1 + on-run` is **not** the rule (UR-F18).

* (a) S9-3 verbatim: at the end of the first set of Operating Rounds in which a D train is purchased (with S9-2's
  trigger, the end of the trigger set).
* (b) As implemented (#1089 / #1092): the train survives the rest of the trigger set and all of the next set, and is
  taken on the corporation's first run after that.
* Sub-question: at a round boundary, or narrated on a run (#1092 moved it onto a run so it can be narrated and heard).

**OD-UR-3 — a gift whose tier is above the current phase** (UR-F4). **DECIDED (rev 2): (a)** — synthetic trains never
advance the phase; the first REAL train of the tier does, normally.

* (a) The phase ignores synthetic trains (the phase is the highest REAL train owned or pooled — the rule
  `realDieselPurchased` already applies to the doom trigger).
* (b) The gift is capped at the current phase's tier.
* (c) A gift above the phase IS that phase change (rust, limits, era) — while still "not a real D purchase" for the
  doom trigger.
* (d) Other.
* Facts: #1046 assumed the gift is the phase's own tier ("a phase-6 gift in a phase-6 game changes nothing"); #1672 made
  it the depot's lowest without revisiting that; the reachable windows are "5s sold out" (gift 6) and "6s sold out"
  (gift D; under LPF also 7). Option (b) contradicts #1672's wording exactly in those windows.

**OD-UR-4 — where the Mark's award comes from** (UR-N33, UR-F10). **DECIDED (rev 2): (a)** — minted, found money; the
money-conservation exemption is intended variant law.

* (a) Found money, minted outside the Bank (current; "a bag of strangely marked gold was found in some abandoned
  luggage").
* (b) Paid by the Bank through the ledger, like every other payment (it can then latch `bank_broken`).

**OD-UR-5 — the Blood Price** (UR-N50, UR-N51, UR-N54, UR-F11). **OPEN (rev 2)** — all three parts. **Rev 5: (a) DECIDED
— 5a-1; (b) OPEN; (c) DECIDED — 5c-2** (the rulings in the DECIDED table). **Rev 7: (b) DECIDED — the buyer only;
OD-UR-5 is fully DECIDED.** *(With OD-UR-2
decided, a still-gilded buyer's train under (a) would leave at the same set boundary wherever it is; no run binding
would be needed.)* *Rev 6: (a) clarified by the owner — the cured train's provenance, and why the Blood Price changes no
phase (below).*

* (a) The buyer's train: ordinary (#1090, implemented) or still a ghost on the same D schedule (S9-3) — and if the
  latter, whether it stays limit-exempt at the buyer, whether the fog takes it from the buyer, and whether the buyer
  becomes Carcosan.
* (b) Whose share price moves: the seller Left 1 / Down 1 (#1090, implemented) or the purchaser (S9-3's wording).
* (c) A seller holding a gilded and an ordinary copy of one model: may it sell the ordinary copy without the Blood
  Price (the message would have to name the copy), or is any sale of that model the Carcosan transfer (current)?
* *(Rev 5)* **(a) = 5a-1, ordinary** — #1090's behaviour, which the implementation already has: GHL E pins no curse, no
  gilding, no exemption, no deadline, the buyer's train limit, no fog and the unchanged depot tally; UR-4 pins the rest
  live (it runs and rusts normally, sells again normally, is a Diesel trade-in when eligible). *(Rev 5 also left UR-4
  a question here — whether a cured train should count toward the phase at the buyer. **Rev 6: CLOSED by the owner's
  clarification below; no owner decision remains on it.**)*
* *(Rev 6)* **The owner's clarification of (a) — synthetic origin is not supernatural status.** The gift is the
  lowest-value train the authoritative Depot rule supplies (S9-2). The Blood Price cures its supernatural status, and
  the buyer receives an ORDINARY train that keeps only whatever provenance / accounting marker is needed to remember
  that it originated synthetically rather than consuming one of the printed Depot copies. That provenance means only
  that the train is an **additional ordinary copy in circulation**, +1 relative to the printed Depot supply; it carries
  no special gameplay treatment. **Synthetic origin / supply provenance may persist ≠ supernatural rules status
  persists**: the supernatural status — the gilding, the Carcosan train-limit exemption, the fog deadline — ends at the
  Blood Price.
* *(Rev 6)* **Why the Blood Price changes no phase.** Not because the cured train stays supernatural — it does not — and
  not by a special rule that ignores it for its provenance, but for the base game's reason: the Blood Price is an
  **intercorporate train purchase, not a purchase from the Bank / Depot**, and the phase change, rust and analogous
  first-train consequences are triggered by the qualifying Depot purchase. So the Blood Price advances no phase,
  triggers no rust, creates no Gentle Rust marks, opens no new Depot tier, advances no 18XX+ era and does not start the
  real-D doom trigger merely because the transferred train is a D. No new gameplay exception is required, and today's
  engine gives this outcome: the sale moves the train and its provenance between fleets and buys nothing from the Depot.
* *(Rev 6)* **For UR-4 — one marker, two concepts (an implementation note; nothing is designed or built here).** Today
  one marker, `ghost_trains` — defined at #1673 as synthetic provenance, "this train never came off the depot shelf", a
  fact about the train that travels with it — is read three ways: by the depot tally (`depotInventory`: the +1), by the
  phase (`derivePhase`, since UR-3 — OD-UR-3) and by the real-D check (`realDieselPurchased`). The supernatural status
  is kept apart — the gilding and the limit exemption in `carcosan_trains`, the seller's curse and doom clock — and the
  Blood Price clears it (UR-N49). UR-4 preserves the required accounting while making sure the cured train is otherwise
  treated as ordinary, and nothing may read the marker as a supernatural status. One marker may stay if its semantics
  already represent this correctly, or the concepts may be separated; the representation is UR-4's choice and is not
  prescribed here. To check in UR-4: the marker is written by the gift, carried by a sale (#1673) and cleared by the fog
  (#1675); rust, the president's discard and the Diesel trade-in to the Bank Pool — all open to the cured train as an
  ordinary train — do not touch it today (#1675 records what a stale marker does to the depot tally and the real-D
  check).
* *(Rev 5)* **(b) OPEN.** Context only, not a ruling: the owner currently leans toward the buyer taking the stock-price
  hit ("the buyer pays the Blood Price" reads more cleanly) and still goes back and forth between buyer and seller. The
  implementation stays #1090's (the seller, Left 1 / Down 1) until the owner rules. *(Rev 7: decided — below.)*
* *(Rev 7)* **(b) = the BUYER only — DECIDED.** When a corporation buys the gilded train through the Blood Price, the
  buyer pays the cash price and **the buyer's stock marker moves Left 1 / Down 1**; the seller gets **no** separate
  stock-price movement — its benefit is its release from the Carcosan curse / supernatural burden (it is absolved,
  UR-N49). The market penalty is **never** applied to both corporations. It follows S9-3's "The purchasing corporation
  pays the required Blood Price consequences (cash and corporate stock-price consequence …)" and **supersedes #1090's
  "Left 1, Down 1 market movement for the selling corporation"**, which the implementation carries today (the market
  arm's "THE SELLER MOVES, NOT THE BUYER"). **Do not restore the seller move** — from #1090, from that code, from the
  copy that repeats it or from the tests that pin it (UR-F22 names them). Not implemented — **UR-F22** (UR-4; the copy
  in UR-6).
* *(Rev 5)* **(c) = 5c-2** — the sale names the copy: **UR-F21** (UR-4).
* *(Rev 8)* **Implemented — UR-4.** (a) pinned live, the +1 carried through the Bank Pool (`returned_ghost_trains`); (b)
  UR-F22 fixed; (c) UR-F21 fixed — one optional `gilded` boolean, multiset copy selection, no train identity. The "one
  marker, two concepts" note above is resolved without a split: `ghost_trains` is supply provenance only, and its phase /
  real-D reads are the Depot-purchase reason, not a status ("UR-4 implementation (rev 8)").

**OD-UR-6 — the statistics' basis under the variant** (UR-N58, UR-F8). Printed or paid for The Workhorse, The
Juggernaut, Master of the Line, the per-train ledger, the revenue chart, White Elephant and Little Engine; whether a
Mark-nullified run counts as earned; whether a synthetic gift counts as a purchase and as "buying a Diesel". Derived
history only — no version effect. **OPEN (rev 2).** **DECIDED (rev 5):** 6.1 — the revenue actually paid, decided in
principle (corporation / turn level; the per-train allocation is an isolated open sub-question); 6.2 — a Mark-nullified
route is not earned; 6.3 — a synthetic gift is not a purchase, and a later Blood Price acquisition is one, Diesel
included. §10 (rev 5) maps each statistic; UR-5 implements it (UR-F8). **Rev 7: the per-train question DECIDED —
OD-UR-6 is fully DECIDED.** Corporation / turn-level revenue statistics use the ACTUAL PAID revenue; individual train /
route statistics use the PRINTED value of that train's successfully completed route — the die modifies the whole turn
total, no canonical adjusted amount belongs to an individual train, and the printed route value is the route-specific
quantity. The per-train figure is **not an allocation of the paid total** (no proportional, equal or die-adjusted
per-train value). A completed route contributes its printed value; a Mark-nullified route contributes nothing (6.2);
6.3 is unchanged. §10 (rev 7) maps it.

**OD-UR-7 — a gilded train as a Diesel trade-in** (UR-N42, UR-F17). **DECIDED (rev 2): (a)** — refused; buying a
Diesel normally and trading in an ordinary eligible train stay legal, and an ordinary copy of the gilded model stays
tradable (copy selection is UR-4's design).

* (a) Refused (the analogue of OD-GR-2 for Gentle Rust).
* (b) Allowed — and then: does the curse stay; does the fog still come; is the Blood Price owed; does the synthetic
  train enter the Bank Pool as physical stock or vanish?

**OD-UR-8 — the Rules Reference and the Easter egg** (UR-N60, UR-F13). **DECIDED (rev 2): (b)** — disclose what a
player needs to act (the die and rounding, a gilded train's limit treatment and disappearance, the Blood Price's
consequences once OD-UR-5 is decided — *rev 7: it is*); keep the trigger conditions and odds hidden.

* (a) Document the whole sequence (S9-3's verbatim rule was recorded "for the later Rules Reference pass").
* (b) Keep the Yellow Sign undisclosed and document the die, the rounding and whatever a player must know to act (for
  example that selling a gilded train costs the Blood Price).
* (c) Other.

**OD-UR-13 — the Mark's taken train** (UR-N31, UR-N33, UR-F19). **DECIDED (rev 3, 2026-09-24): removed from the game — not
the depot, not the Bank Pool, never purchasable, no depot stock gained; the award stands (OD-UR-4); PHASE PROGRESSION IS
MONOTONIC for every removal path** (the ruling verbatim is in the DECIDED table; the implementation in "UR-3
implementation (rev 3)"). *As first recorded (rev 3, before the ruling):* the rulings say the train is "deleted" and pays
half its "depot value"; they do not say whether it leaves the game as a train that WAS bought.

* (a) Removed from the game but still bought: it counts toward the phase and is not depot stock (the Bank Pool's
  treatment under #1530) — the phase never regresses and the depot never regains it.
* (b) Returned to the depot: the derived supply takes it back and the phase may regress (today's derived effect).
* (c) Other.
* Facts: pre-existing since #1046 on the request path, which never landed in a room (UR-F1); UR-3 makes the Mark land on
  hosted boards, so the effect is now reachable (once per game, phases 2–4, only when the cheapest train is of the phase's
  own tier). Either answer is a replay-semantic rule for UR-8's row 10; (a) needs the board to remember the train (a
  field), (b) needs nothing but accepts the regression.

### 12.3 Confirmations (not blocking)

| id | question | current behaviour | effect of a change | status (rev 2) |
|---|---|---|---|---|
| OD-UR-9 | the server's randomness source | `Math.random` | ingress-only; recorded seeds replay identically; no version effect | **DECIDED — 9-B: cryptographic**; implementation routed to AWS / live multiplayer (with the seat-token item, Appendix C), not UR |
| OD-UR-10 | rounding ties | up ($45 → $50, $55 → $60): +$1.67 expected at printed ≡ $50 (mod $100) | replay-semantic if changed | **DECIDED (rev 4) — 10-C: an exact tie rounds toward the printed revenue** ($55 → $50, $165 → $160, $275 → $270; the −10% ties are unchanged); not implemented — UR-F20 → UR-7; v10 boundary |
| OD-UR-11 | an undo reveals the face before a re-run | accepted (bounded by S6-3's shortfall rule) | restricting undo is a shell/ingress change | **DECIDED — 11-A: accepted**; no Unpredictable Revenue undo restriction |
| OD-UR-12 | one name for the variant | "Unpredictable revenue" / "Unpredictable Routes" | copy only | **DECIDED — 12-A: "Unpredictable Revenue"** (UR-6) |

### 12.4 Defects that need no decision

UR-F3 (variant gate), UR-F7 (breakdown from the authority's pairing), UR-F9 (the Cowboy reads the printed line),
UR-F12 (tooltip), UR-F15 (optional hardening), and Appendix B's stale comments. UR-F5 is mechanical once OD-GR-3a is
known.

*(Rev 2.)* With the rulings, **every finding except UR-F8 now has its decision**: UR-F1, UR-F2, UR-F3, UR-F5, UR-F6,
UR-F7, UR-F15 and UR-F18 are UR-3's; UR-F4 and UR-F17 are UR-4's; UR-F9 is UR-5's; UR-F12, UR-F13 and UR-F14 are
UR-6's (UR-F13's Blood Price text waits for OD-UR-5). Still waiting on an OPEN decision: **UR-F8** (OD-UR-6), the Blood
Price half of **UR-F11** (OD-UR-5) and the tie direction (OD-UR-10, a confirmation with no finding). **UR-F10** is
closed as intended (OD-UR-4); **UR-F16** leaves UR for AWS / live multiplayer (OD-UR-9).

*(Rev 3.)* UR-3 fixed UR-F1, UR-F2, UR-F3, UR-F5, UR-F6, UR-F7 and UR-F18 and, by the owner's brief, UR-F4 and UR-F17;
it found UR-F19 and, once the owner decided OD-UR-13 during the slice, fixed it too. UR-F15 was not taken (optional).
Still open: UR-F8 (OD-UR-6), UR-F9 (UR-5), UR-F11's Blood Price half (OD-UR-5), UR-F12 / UR-F13 / UR-F14 (UR-6), UR-F15
(INFO), UR-F16 (routed), and the unpinned residuals ("UR-3 implementation (rev 3)").

*(Rev 4.)* OD-UR-10 is decided (10-C), so the tie direction is no longer a decision: it is a defect with a decided target,
**UR-F20**, owned by UR-7. Still waiting on an OPEN decision: UR-F8 (OD-UR-6) and UR-F11's Blood Price half (OD-UR-5).

*(Rev 5.)* OD-UR-5 (a) and (c) and OD-UR-6 are decided: UR-F8 has decided targets (UR-5; 6.1's per-train allocation is an
isolated sub-question), UR-F11's Blood Price half narrows to the market consequence, and (c) makes a new defect,
**UR-F21** (UR-4). Still waiting on an OPEN decision: only UR-N51 and UR-F11's market half (OD-UR-5(b)).

*(Rev 7.)* OD-UR-5(b) and OD-UR-6.1's per-train question are decided: UR-N51 becomes a defect with a decided target,
**UR-F22** (UR-4); UR-F8 has every target (UR-5); UR-F11 is closed. **No finding waits on an owner decision.**

*(Rev 8.)* **UR-4 fixed UR-F21 and UR-F22** (and the Bank Pool provenance leg it found). Still open: UR-F8, UR-F9 (UR-5);
UR-F12, UR-F13, UR-F14 (UR-6); UR-F15 (INFO); UR-F16 (routed to AWS / live multiplayer); UR-F20 (UR-7); and the unpinned
(Firestore) residuals of UR-3 (S10-11). No finding waits on an owner decision.

---

## 13. Certification matrix

**Evidence tags.** **[R]** live reducer test on a constructed board · **[S]** the server path (`RoomSession.submit`,
ingress) · **[RP]** replay of stored logs / the corpus · **[C]** a constructed legal game (none exists yet for this
variant) · **[H]** unit test of a production helper the reducer calls · **[U]** UI, render or source scan only ·
**[P]** this audit's temporary probe (Appendix A — not durable, not counted as certification) · dead helpers: none are
counted. Suites (all under `frontend/src/`): `YSA` = `utils/yellowSignAuthority.test.ts`, `YSI` =
`utils/yellowSignIngress.test.ts`, `GHL` = `utils/stage95GhostLimit.test.ts`, `RR` = `utils/revenueRounding.test.ts`,
`MTR` = `utils/multiTrainRun.test.ts`, `ARR` = `utils/atomicRunRoutes.test.ts`, `B47/B48/B50/B60` =
`utils/batch4x.test.ts`, `MKR` = `utils/markKeepsRun.test.ts`, `S95R` = `utils/stage95Rulings.test.ts`, `FSR` =
`utils/forcedSignAndRadioBar.test.ts`, `FT` = `utils/flavorText.test.ts`, `MC` = `utils/moneyConservation.test.ts`,
`BPA` = `utils/bloodPriceArrival.test.ts`, `S103` = `utils/stage103CompositionCoupling.test.ts`.

**Status.** CERTIFIED NOW = the clause's current evidence is live-authority evidence at the right level and no open
defect or decision touches it (**the variant as a whole is still NOT certified**, and a row a later slice touches is
re-asserted there) · CORRECT BUT NEEDS LIVE TEST · DEFECT · OWNER DECISION · DEFERRED / OUT OF SCOPE. Future test
kinds: **R** reducer, **S** `RoomSession`, **G** the constructed game (§14), **RP** replay / restore, **U** UI.

*(Rev 3: the matrix below is rev 2's and is NOT recomputed here. UR-3 moves the rows it touches — UR-N27, UR-N29,
UR-N31, UR-N32, UR-N37, UR-N39, UR-N42, UR-N44, UR-N45, UR-N46 and the X / R rows on binding, the gate, the fog and the phase —
from DEFECT to "fixed with durable R / S evidence" (see "UR-3 implementation (rev 3)"); their certification status is
re-asserted in UR-7, against the constructed game.)* *(Rev 4: one row moved — UR-N6, CERTIFIED NOW → DEFECT UR-F20, by
OD-UR-10; "Counts (rev 4)" below.)* *(Rev 5: UR-N50 → CORRECT BUT NEEDS LIVE TEST, UR-N54 → DEFECT UR-F21, UR-N58 →
DEFECT UR-F8 and X11 → DEFECT, by OD-UR-5 and OD-UR-6; "Counts (rev 5)" below.)* *(Rev 7: UR-N51, OWNER DECISION →
DEFECT UR-F22, by OD-UR-5(b); no OWNER DECISION row remains; "Counts (rev 7)" below.)* *(Rev 8: as UR-3 did, UR-4 does
NOT recompute the matrix. It moves the rows it touches — UR-N50 (pinned live), UR-N51 (UR-F22), UR-N54 (UR-F21), with
UR-N49, N52, N53 and N55 re-asserted — to "fixed / pinned with durable R / S evidence" ("UR-4 implementation (rev 8)");
their certification status is re-asserted in UR-7, against the constructed game. The counts below stay rev 7's.)*

### 13.1 Clauses

| id | rule (short) | source | production path | current evidence | status | future test |
|---|---|---|---|---|---|---|
| UR-N1 | flag chosen at the deal; absent = standard | #902 | `GV:690–722` | [H] `gameVariants.test` | CERTIFIED NOW | — |
| UR-N2 | flag fixed for the game | #902, #1256 | `SetupGame` only writes it | none | CORRECT BUT NEEDS LIVE TEST | R |
| UR-N3 | variant off → no UR mechanism | #902 | `sS:6114` (no gate) | [P] P-A | **DEFECT UR-F3** | R + S + G (paired control) |
| UR-N4 | one roll per turn on the aggregate | #941 | `sS:6282–6293` | [R] MTR "applies one roll to the aggregated printed total"; ARR "rolls the die once, on the sum" | CERTIFIED NOW | G |
| UR-N5 | the face table | #903 | `GV:826`, `:989` | [H] RR, `gameVariants.test`; B50 "reaches every face" | CERTIFIED NOW | — |
| UR-N6 | × %, nearest $10; *(rev 4)* ties toward printed | #938; OD-UR-10 = 10-C (rev 4) | `GV:998`, `:1117`, `:1225` | [H] RR (ruled examples, half up, multiples of ten, percentage then rounding) — pins today's half-up tie | **DEFECT UR-F20** *(rev 4: was CERTIFIED NOW with the tie direction pending OD-UR-10 — decided 10-C; today's half-up tie does not conform; implementation pending)* | R (exhaustive table, ties toward printed) |
| UR-N7 | paid figure is what Pay splits / Withhold banks | #917, #938; §6.5 | `DeclareDividends` arm, `dividendSplit.ts` | [H] RR "pays out exactly what was earned"; [R] ARR "pays out the aggregate" | CORRECT BUT NEEDS LIVE TEST (server path, both choices) | S, G |
| UR-N8 | declaration = paid figure | S6-2 | `dividendAmountRefusal` | [R][S] Batch-6 route-authority suites (variant-agnostic) | CERTIFIED NOW | G |
| UR-N9 | share price on the paid figure (DSM multiples) | §6.5; #908 ff. | `dividendStepsFor` | none with the variant on | CORRECT BUT NEEDS LIVE TEST | R |
| UR-N10 | legality / shortfall on printed totals | §6.4; #1556 | `routeAuthority.ts:482–540` | [R] route-authority suites (variant off) | CORRECT BUT NEEDS LIVE TEST (variant on) | R |
| UR-N11 | previews never roll | #903 | route planner, auto-tracer | [U] | CORRECT BUT NEEDS LIVE TEST | U |
| UR-N12 | only route revenue is modified | derived | — | reading | CORRECT BUT NEEDS LIVE TEST | R |
| UR-N13 | nothing to roll at $0; ≥ $10 never pays $0 | derived | `GV:1225` | [H] RR "keeps zero at zero" | CERTIFIED NOW | R |
| UR-N14 | outcome on figures, not the face | #938, #944 | `GV:1041`, `:1139` | [H] RR "calls a swallowed modifier normal"; FT | CERTIFIED NOW | — |
| UR-N15 | a fresh unpredictable 32-bit draw | #1051 | `GV:929` | [H] B50 "returns an unsigned 32-bit integer", "can draw the Yellow Sign" | CERTIFIED NOW *(rev 2: the cryptographic source, OD-UR-9, is routed to AWS / live multiplayer — outside UR certification)* | — |
| UR-N16 | the server draws; client seed/key replaced | #1662 | `serverIngress.ts:84–93` | [S] YSI 1, 2 | CERTIFIED NOW | G |
| UR-N17 | replay consumes the stored draw | #1051, #1662 | reducer; `RoomSession.restore` | [S] YSI 3 | CERTIFIED NOW | RP (pinned restore) |
| UR-N18 | an undo reuses the draw | #1051 | `turnSeed.ts:65` | [H] B50 154–187; [S] YSI 3 (normalizer) | CERTIFIED NOW (end-to-end: R2; the revealed face accepted — OD-UR-11) | S, G |
| UR-N19 | one draw, three disjoint extractions | #969, #1051, #1421 | `GV:989`, `:1080`; `YS:347` | [H] B50 "strides past the die and the widest bucket"; B47 "decorrelates" | CERTIFIED NOW | — |
| UR-N20 | legacy seedless replay via the hash | #1051 | `GV:939` | [H] B50 "keeps the old die only as a fallback"; [R] MKR 69 | CERTIFIED NOW (pinned fallback: UR-F15) | R |
| UR-N21 | the draw is turn-scoped board state | #1661 | `sS:6326–6328`, `:4167` | [R] YSA 9 (recorded); [U] source pin for the clear | CORRECT BUT NEEDS LIVE TEST (the clear) | R |
| UR-N22 | the turn sentence | #941, #944, #949 | `GV` `turnRevenueSentence` | [H] RR sentence cases; FT | CERTIFIED NOW | — |
| UR-N23 | narration = board | #1056, #1375 | `App.tsx:7141–7520` | [P] P-C | **DEFECT UR-F1, UR-F6** | U + S (after OD-UR-1) |
| UR-N24 | ephemeral cues do not replay | #1094 | `App.tsx:7485+` | [U] | CORRECT BUT NEEDS LIVE TEST | U |
| UR-N25 | once-per-game sequence | #1044, #1046, #1092 | `sS:6548–6550`; fog guard | [R] YSA; B48; FSR | CERTIFIED NOW (reducer gates) | G |
| UR-N26 | outcome derived, never chosen | S9-1 | `YS:695`; `sS:6158–6166` | [R] YSA 1–5; [S] YSI 2 | CERTIFIED NOW (outcome) | S |
| UR-N27 | a stage belongs to its run | #1046, #1092 | none enforces it | [P] P-D, P-G1′, P-G2′, P-H | **DEFECT UR-F1, UR-F2** (OD-UR-1 decided: automatic) | R + S + G |
| UR-N28 | the playtest force: local, unpinned only | #1128, #1662 | `serverIngress.ts:96–103`; `sS:6158–6166` | [R] YSA 8; [S] YSI 4a, 4b, 5 | CERTIFIED NOW | — |
| UR-N29 | Mark trigger | #1044, #1046; S9-3 | `YS:490`; `sS:6548–6550` | [R] YSA 6; B48 "opens the mark in 2, 3 and 4 only"; B47 | **DEFECT (window at application — UR-F2)**; trigger logic evidenced | R + G |
| UR-N30 | no Mark in Phase 5+ | #1046 | `YS` `markWindowOpen` | [R] B48 "expires the mark when Phase 5 arrives" | CERTIFIED NOW | G |
| UR-N31 | lowest-value train, first of identical | #1046 | `YS:151`, `sS:6559` | [R] YSA 3, 6 | CERTIFIED NOW (ordinary trains; Final Run trains: UR-N37) | R |
| UR-N32 | only the taken train's run is nullified | S9-3, #1375 | `YS:189`, `sS:6572` | [R] MKR, S95R, YSA 6; [P] P-C, P-J | **DEFECT UR-F5, UR-F7** | R + G |
| UR-N33 | ½ face value to the treasury, minted | #1046, S9-3; OD-UR-4 (rev 2) | `sS:6581` | [R] YSA 4, 6; [RP] MC; [P] P-E | CORRECT BUT NEEDS LIVE TEST *(rev 2: was OWNER DECISION OD-UR-4 — now decided "minted"; the amount is evidenced, the mint on a pinned board only by the probe)* | R + G |
| UR-N34 | may leave the corporation trainless → ordinary obligation | #1046; §6.6.2 | `trainObligationFor` | [P] P-G1′ (trainless) | CORRECT BUT NEEDS LIVE TEST (the forced purchase) | G |
| UR-N35 | the sign flag | #1046, #1404 | `sS:6580` | [R] YSA 1, 6 | CERTIFIED NOW | — |
| UR-N36 | the Mark's two lines | #1375 | `App.tsx:7330–7420` | [U] | **DEFECT (delivery, UR-F1)** | U + S |
| UR-N37 | Mark × Final Run train: never a candidate | D-36; OD-GR-3 (rev 2) | `sS:4244–4247`, `:4283–4285` (the settlement first) | [P] P-C, P-H | **DEFECT UR-F5, UR-F6; UR-F2 (P-H)** *(rev 2: was OWNER DECISION OD-GR-3 — decided "never")* | R + G |
| UR-N38 | Carcosa trigger | #1046, #1421; S9-3 | `YS:490`, `:347` | [R] YSA 6b; B47 "draws for the marked corporation on a critical bonus" | **DEFECT (window at application — UR-F2)**; trigger logic evidenced | R + G |
| UR-N39 | the gift: depot-lowest synthetic train | #1672 | `YS:253`; `sS:6594–6650` | [R] GHL F; YSA 6b | **DEFECT UR-F4** *(rev 2: was OWNER DECISION OD-UR-3 / DEFECT UR-F4 — decided 3-A)* | R (every window) |
| UR-N40 | Carcosan status; sign flag cleared | #1089, #1090 | `sS:6624–6648` | [R] YSA 6b; GHL E | CERTIFIED NOW | G |
| UR-N41 | limit exemption for the whole lifetime | #1672 | `trainLimit.ts:132` | [R] GHL A, G | CERTIFIED NOW | G |
| UR-N42 | otherwise an ordinary owned train, but never a Diesel trade-in | derived; OD-UR-7 (rev 2) | `dieselExchange.ts`, `sS:5740–5765` | [P] P-I | **DEFECT UR-F17** (the trade-in); the rest correct but needs a live test *(rev 2: was CORRECT BUT NEEDS LIVE TEST, trade-in → OD-UR-7)* | R |
| UR-N43 | a synthetic D is not a real D purchase | #1672 | `GP:601` | [R] GHL "a synthetic Diesel is not a real Diesel purchase" | CERTIFIED NOW | — |
| UR-N44 | doom trigger: whichever is later | #1672 | `sS:1064–1074`, `:1117`, `:6645` | [R] GHL B, C; B60 | **DEFECT (swallowed by UR-F4, P-F)** | R + G |
| UR-N45 | expiry: end of set N+1, at the boundary | OD-UR-2 (rev 2) | `YS:380` (today: on a run) | [R] GHL D; B60 (the deadline arithmetic) | **DEFECT UR-F18** *(rev 2: was OWNER DECISION OD-UR-2 — decided "N+1 + boundary")* | R + G |
| UR-N46 | the fog is not a run stage | #1092, superseded in placement by OD-UR-2 (rev 2) | `YS:490` (fog first) | [R] B60 "leaves the roll entirely alone" (the run-stage form) | **DEFECT UR-F18** *(rev 2: was CERTIFIED NOW for the run-stage fog)* | R + G |
| UR-N47 | Carcosan after the fog | #1089 | `sS:6490–6530` | [R] YSA 6b | CERTIFIED NOW | G |
| UR-N48 | the fog removes one copy + gilding + provenance | #1675 | `sS:6490–6530` | [R] GHL G | CERTIFIED NOW | — |
| UR-N49 | the Blood Price absolves the seller | #1090 | `sS:1993–2018` | [R] GHL E | CERTIFIED NOW (re-assert after OD-UR-5 — *rev 5: after (b) and UR-F21's copy-level sale*; *rev 7: (b) decided — after UR-F21 and UR-F22*) | G *(rev 8: re-asserted by UR-4 — [R][S] `carcosaBloodPrice` A3, F1, I2)* |
| UR-N50 | what the buyer receives — *(rev 5)* an ordinary train (5a-1) | #1090 vs S9-3; OD-UR-5(a) = 5a-1 (rev 5) | `sS:1949–2018` | [R] GHL E (no curse, gilding, exemption or deadline; the buyer's limit; never fogged; the depot tally unchanged — the "+1") | CORRECT BUT NEEDS LIVE TEST *(rev 5: was OWNER DECISION OD-UR-5(a) — decided 5a-1; the implementation already conforms; still to pin live: rusts normally, sells again normally, a Diesel trade-in when eligible)* | R + G *(rev 8: pinned with durable [R][S] evidence by UR-4 — `carcosaBloodPrice` C, D, E, F, I; re-asserted in UR-7)* |
| UR-N51 | whose share price moves — *(rev 7)* the buyer's only (OD-UR-5(b)) | #1090 vs S9-3; OD-UR-5(b) (rev 7) | `sS:2644–2680` *(at `9d0cf3a`: `:2674–2695`)* | [R] BPA; [S] S103 — both pin the seller's move, the superseded rule | **DEFECT UR-F22** *(rev 7: was OWNER DECISION OD-UR-5(b) — decided: the buyer only; the seller moves today)* | R + S *(rev 8: UR-F22 fixed with durable [R][S][U] evidence by UR-4 — `carcosaBloodPrice` B, I2, I4; `BPA`, `S103`, `S103b`; the panel; re-asserted in UR-7)* |
| UR-N52 | provenance travels with the train | #1673 | `sS:1949–1962` | [R] GHL E | CERTIFIED NOW | — *(rev 8: and the Bank Pool leg, UR-4 — `carcosaBloodPrice` D2–D6, I6)* |
| UR-N53 | the server charges the Blood Price on a legal transfer | #1690 | `sS:2986–2995` | [S] S103 "the Blood Price (#1090)"; [R] BPA | CERTIFIED NOW *(rev 7: re-assert after UR-F22 — the charge's target moves to the buyer)* | S *(rev 8: re-asserted — the charge's target is the buyer, UR-4)* |
| UR-N54 | identical gilded + ordinary copies — *(rev 5)* the sale names the copy (5c-2) | project; OD-UR-5(c) = 5c-2 (rev 5) | `sS:2026`, `:2053` | none | **DEFECT UR-F21** *(rev 5: was OWNER DECISION OD-UR-5(c) — decided 5c-2; model-level today)* | R *(rev 8: UR-F21 fixed with durable [R][S][U] evidence by UR-4 — `carcosaBloodPrice` A, I1, I3, I5; the panel; re-asserted in UR-7)* |
| UR-N55 | Carcosan Railways, The Redeemer | #1421 | `gameHistory.ts:721–750` | none live (displaced, S10-21) | CORRECT BUT NEEDS LIVE TEST *(rev 5: The Redeemer reads the model — under 5c-2 it reads the copy sold, UR-F21; rev 7: it already credits the buyer, who pays under OD-UR-5(b))* | G (S10-21) *(rev 8: The Redeemer's copy reading fixed with [R] evidence — `carcosaBloodPriceStats`; the rest stays G, S10-21)* |
| UR-N56 | the sign's takings are not obsolescence | #1422, #1431 | `gameHistory.ts:562`, `:723–735` | [RP] CV4-based history suites (no UR case) | CORRECT BUT NEEDS LIVE TEST | G |
| UR-N57 | The Cowboy | #1429 | `gameHistory.ts:451–457` | none live | **DEFECT UR-F9** | R |
| UR-N58 | statistics basis — *(rev 5)* paid (6.1, in principle), a nullified route not earned (6.2), a gift not a purchase and a Blood Price acquisition a purchase (6.3); *(rev 7)* per train, the printed completed route | OD-UR-6 (rev 5) | `gameHistory.ts:431–476`, `:651–670` | — | **DEFECT UR-F8** *(rev 5: was OWNER DECISION OD-UR-6 — decided; the per-train allocation was 6.1's isolated open sub-question — rev 7: decided, the printed completed route)* | G |
| UR-N59 | Lobby copy | #961 | `GV:192–196` | [U] `variantCopy.test` | CERTIFIED NOW (title: UR-F14 — OD-UR-12 decided "Unpredictable Revenue") | U |
| UR-N60 | the Rules Reference, disclosure 8-B | S9-4; OD-UR-8 (rev 2) | `RulesReference.tsx:613–614` | [U] | **DEFECT UR-F13** *(rev 2: was OWNER DECISION OD-UR-8 — decided 8-B; the Blood Price text waits for OD-UR-5 — rev 7: decided)* | U |
| UR-N61 | gilded chips' limit text | #1672 | `TrainBadges.tsx:632` | [U] | **DEFECT UR-F12** | U |
| UR-N62 | the arming chip only in local rooms | #1662 | `App.tsx` sign-arming block | [U] FSR | CERTIFIED NOW | — |

### 13.2 Interactions and invariants

| id | rule / invariant | source | current evidence | status | future test |
|---|---|---|---|---|---|
| X1 | Gentle Rust × the die | GR-S14 | GR-4 evidence (GR-1 route test) | CERTIFIED NOW | G |
| X2 | Gentle Rust × the Mark | D-36; OD-GR-3 (rev 2) | [P] P-C | **DEFECT UR-F5, UR-F6** *(rev 2: was OWNER DECISION OD-GR-3 + DEFECT — decided "never")* | R + G |
| X3 | Gentle Rust × a delayed request | derived | [P] P-H | **DEFECT UR-F2** | R + S |
| X4 | a gift above the phase × phase / rust / era / doom / statistics | #1046, #1672 | [P] P-B, P-F | **DEFECT UR-F4** (OD-UR-3 decided: 3-A) | R (standard and LPF windows) |
| X5 | LPF shelf gifts (6 / 7 / D) | #1326, #1672 | none | CORRECT BUT NEEDS LIVE TEST (D: UR-F4) | R |
| X6 | a gilded train as a Diesel trade-in | OD-UR-7 (rev 2) | [P] P-I | **DEFECT UR-F17** *(rev 2: was OWNER DECISION OD-UR-7 / DEFECT — decided: refused)* | R |
| X7 | Dynamic Stock Market × the die | derived | [RP] JUNO-3XD (unpinned) | CORRECT BUT NEEDS LIVE TEST | R |
| X8 | a trainless Mark × emergency funding | derived | [P] P-G1′ (trainless only) | CORRECT BUT NEEDS LIVE TEST | G |
| X9 | the server path for the sign (binding, target, timing) | S9-1 + UR-N27 | [P] P-D | **DEFECT UR-F1, UR-F2** | S + G |
| X10 | a standard table refuses the sign | #902 | [P] P-A | **DEFECT UR-F3** | S + G0 |
| X11 | statistics under the variant | #1421 ff.; OD-UR-6 (rev 5) | none live | **DEFECT UR-F8, UR-F9** *(rev 5: was OWNER DECISION OD-UR-6 / DEFECT — OD-UR-6 decided: 6.1 in principle, 6.2, 6.3; the per-train allocation isolated; rev 7: decided — OD-UR-6 fully decided)* | G |
| X12 | money conservation, the Mark's award minted by rule | Batch 7.1; OD-UR-4 (rev 2) | [RP] MC; [P] P-E | CORRECT BUT NEEDS LIVE TEST *(rev 2: was OWNER DECISION OD-UR-4 — decided "minted"; pin the mint on a pinned board)* | RP + R |
| X13 | the unpinned corpus replays unchanged | D-9 policy | [RP] MC 18-file sweep, `replayJuno3XD`, `stage10Closure` — green this pass | CERTIFIED NOW (re-measure every slice) | RP |
| X14 | a completed Yellow Sign game (S10-21) | S10-21 | none | DEFERRED → UR-7 | G |
| X15 | the Rules Reference | S9-4; OD-UR-8 (rev 2) | [U] | **DEFECT UR-F13** *(rev 2: was OWNER DECISION OD-UR-8 — decided 8-B)* | U |
| R1 | server seed and key on every accepted run | #1662 | [S] YSI 1, 2 | CERTIFIED NOW | G |
| R2 | undo reuses the draw, end to end | #1051 | [H] B50; [S] YSI 3 (normalizer only) | CORRECT BUT NEEDS LIVE TEST | S + G |
| R3 | a refused run pins no seed and reveals nothing | #1685 | reading | CORRECT BUT NEEDS LIVE TEST | S |
| R4 | replay / restore never draw; identical digests | #1051, #1662 | [S] YSI 3; [RP] corpus | CORRECT BUT NEEDS LIVE TEST (pinned UR restore) | RP + G |
| R5 | the reducer never draws | #1051 | [H] B47 304 | CERTIFIED NOW (add a source pin) | U |
| R6 | a turn's draw is used only by its own turn | #1661 | [R] YSA 9 | **DEFECT (a late request still derives a fog — UR-F2)** | R |
| R7 | client and server agree for UR runs and stages | #1223 | the divergence check exists | CORRECT BUT NEEDS LIVE TEST | G |
| R8 | narration = applied outcome | #1375 | [P] P-C | **DEFECT UR-F1, UR-F6** | U + S |
| R9 | the variant off: nothing random matters | #902 | [P] P-A | **DEFECT UR-F3** | S + G0 |
| R10 | legacy semantics only on unpinned logs | #1551, #1661 | [R] YSA 7; MKR 69 | CERTIFIED NOW (UR-F15 hardening optional) | R |
| R11 | a turn key names one corporation turn | #1051 | by construction | CERTIFIED NOW | — |
| R12 | the face is uniform; the extractions independent | #1051, #969 | [H] B50 | CORRECT BUT NEEDS LIVE TEST (a distribution test on `randomTurnSeed`; the cryptographic source itself is OD-UR-9's, outside UR) | H |
| R13 | no message field changes a random outcome | S9-1 | [R] YSA 2–5, 8; [S] YSI | **DEFECT (train naming UR-F7; timing / target / omission UR-F2)** | R + S |

**Counts (rev 2).** Clauses (62): CERTIFIED NOW **30** · CORRECT BUT NEEDS LIVE TEST **12** · DEFECT **16** · OWNER
DECISION **4** (UR-N50, N51, N54 — OD-UR-5; UR-N58 — OD-UR-6) · DEFERRED 0. Interactions and invariants (28): CERTIFIED
NOW **6** · CORRECT BUT NEEDS LIVE TEST **9** · DEFECT **11** · OWNER DECISION **1** (X11 — OD-UR-6) · DEFERRED **1**
(X14 → UR-7). *(Rev 1: 31 / 12 / 10 / 9 / 0 and 6 / 8 / 8 / 5 / 1. The rulings turned open decisions into defects with
a decided target — UR-N37, N39, N45, N60, X2, X6, X15 — or into rows that only need a live test — UR-N33, X12; UR-N42
became a defect (UR-F17) and UR-N46 moved from CERTIFIED NOW to DEFECT (UR-F18), because OD-UR-7 and OD-UR-2 made
today's behaviour non-conforming.)* (A row carrying both a defect and a decision is counted once, under the status
written first in its row.) "CERTIFIED NOW" rows are evidence that already meets the bar; none of them makes the
variant certified.

**Counts (rev 4).** Clauses (62): CERTIFIED NOW **29** · CORRECT BUT NEEDS LIVE TEST **12** · DEFECT **17** · OWNER
DECISION **4** (UR-N50, N51, N54 — OD-UR-5; UR-N58 — OD-UR-6) · DEFERRED 0. Interactions and invariants (28): unchanged —
**6 / 9 / 11 / 1 / 1** (no row carries the tie rule). The only move is UR-N6, CERTIFIED NOW → DEFECT UR-F20: OD-UR-10
was never an OWNER DECISION row — the tie direction was a caveat on a CERTIFIED NOW row — and deciding it made today's
behaviour non-conforming, as OD-UR-2 did to UR-N46 in rev 2. The basis is still rev 2's: UR-3's fixed rows are
re-asserted in UR-7, not recomputed here (the rev 3 note above).

**Counts (rev 5).** Clauses (62): CERTIFIED NOW **29** · CORRECT BUT NEEDS LIVE TEST **13** · DEFECT **19** · OWNER
DECISION **1** (UR-N51 — OD-UR-5(b)) · DEFERRED 0. Interactions and invariants (28): CERTIFIED NOW **6** · CORRECT BUT
NEEDS LIVE TEST **9** · DEFECT **12** · OWNER DECISION **0** · DEFERRED **1** (X14 → UR-7). The moves: UR-N50, OWNER
DECISION → CORRECT BUT NEEDS LIVE TEST (5a-1 is today's behaviour); UR-N54, OWNER DECISION → DEFECT UR-F21 (5c-2 makes
the model-level transfer non-conforming); UR-N58 and X11, OWNER DECISION → DEFECT UR-F8 (OD-UR-6 gives the statistics
their targets). One open sub-question sits inside a DEFECT row and is not counted on its own: OD-UR-6.1's per-train
allocation (UR-N58). The basis is still rev 2's, as in rev 4. *(Rev 6: unchanged — the owner's clarification of OD-UR-5(a)
closes a UR-4 question that was never a matrix row, and no status moves.)*

**Counts (rev 7).** Clauses (62): CERTIFIED NOW **29** · CORRECT BUT NEEDS LIVE TEST **13** · DEFECT **20** · OWNER
DECISION **0** · DEFERRED 0. Interactions and invariants (28): unchanged — **6 / 9 / 12 / 0 / 1**. The one move: UR-N51,
OWNER DECISION → DEFECT UR-F22 (OD-UR-5(b) makes #1090's seller move non-conforming). OD-UR-6.1's per-train question was
never counted on its own — it sat inside the DEFECT row UR-N58 — so its decision moves nothing. **No OWNER DECISION row
remains**, among the clauses or the interactions. The basis is still rev 2's, as in rev 4.

---

## 14. Constructed certification game — design (not built)

### 14.1 Principles (Gentle Rust's GR-4 method, extended for randomness)

* A **starting board plus a fixed list of messages**, submitted through `RoomSession.submit` — the path a server runs —
  with the acting president (or Stock Round seat) as author; the room appends its own derived entries; no board is
  patched between steps; every nontrivial fact of the starting board is given a legal-play provenance.
* **The randomness is scripted by replacing the RNG, not the rules**: `RoomSession`'s `mintSeed` option (already used
  by `YSI` and by GR-4's harness with a constant) returns a recorded sequence of seeds. Each seed is found once by a
  deterministic search against the real selectors (as `YSA`'s `seedForStage` does) and stored as a constant beside the
  stage it must reach; the test re-derives the stage from the constant, so a change to the flavour payload or the
  extraction fails loudly instead of silently shifting the game.
* Built **after** OD-UR-1 … OD-UR-7 and UR-3 / UR-4, at the engine's pin, so it certifies the rules as decided — not
  the request-based sign of today. *(Rev 2: of the rulings G1 exercises, OD-UR-1, OD-GR-3, OD-UR-2, OD-UR-4 and
  OD-UR-11 are decided; it still waits for OD-UR-5 (a) and (b) — tail B — and OD-UR-6 — M7's credits and the
  statistics assertions.)* *(Rev 5: OD-UR-5(a) and OD-UR-6 are decided; G1 still waits for OD-UR-5(b) — tail B's
  share-price assertion — and for 6.1's per-train allocation in its per-train statistics assertions.)* *(Rev 7: both
  are decided — **G1 has no owner-decision blocker**: tail B asserts that the buyer's marker moves Left 1 / Down 1 and the
  seller's does not; the per-train statistics assertions credit each completed route its printed figure and a nullified
  route nothing.)*
* It needs **earning routes** (≥ $30 printed for a Mark or a Carcosa), unlike GR-4's routeless game: its first messages
  are legal `LayTile` / `PlaceStationToken` actions that give three corporations short paying routes on the printed map.

### 14.2 Game G1 — the Yellow Sign game (Unpredictable Revenue + Gentle Rust, printed board, three players)

| milestone | what happens | proves |
|---|---|---|
| M1 | ordinary runs whose scripted faces cover 1 – 6, including a swallowed ±10% (printed ≤ $40) and a face-1 malus whose flavour line is not the sign's | UR-N4 – N7, N13 – N14, N22, R1 |
| M2 | a run, a `RevertTo`, the same run again; a second revert and a different route set; a refused run (illegal route) | R2, R3, UR-N18 |
| M3 | corporation X buys the first 4 (a self-trigger); corporation Y — holding a 2 on its grace turn — runs with a scripted Mark seed | OD-GR-3 as decided *(rev 2: "never" — Y's Final Run 2 is destroyed at the settlement and the Mark takes Y's cheapest surviving train, or does not fire if none survives)*; UR-N37, X2, UR-F5 / UR-F6 closed |
| M4 | a Mark on corporation Z in phase 3 or 4 that takes its last train: the route nullified, the award paid (per OD-UR-4 — *rev 2: minted, the bank unchanged*), and Z's Buy Trains owing a train (emergency funding) | UR-N29 – N35, X8, X12 |
| M5 | the first 5; a later draw of the Mark line is skipped | UR-N30 |
| M6 | Carcosa for the Marked corporation in phase 5 while a 5 is still on the shelf (a gift within the phase) | UR-N38 – N41, UR-N43 |
| M7 | the first real 6 and the first real D: the doom clock, the rust, the Phase Rusher and Early Adopter credits going to real purchasers only | UR-N44, UR-F8 |
| M8 — tail A | the fog on the Carcosan corporation's run at the time OD-UR-2 decides *(rev 2: at the end of OR set N+1, at the boundary — the corporation need not run; assert no removal anywhere in N+1 and removal at its end)* | UR-N45 – N48, UR-F18 closed |
| M8′ — tail B | branching from the same prefix: a Blood Price sale of the gilded train | UR-N49 – N54 (as decided — *OD-UR-5 still OPEN at rev 2*; *rev 5: (a) and (c) decided — tail B also sells an ordinary copy beside a gilded one (5c-2); (b) OPEN*; *rev 7: (b) decided — tail B asserts the buyer's move and no seller move*) |
| M9 | mid-game `RoomSession.restore` from the log; the client drain's digest compared with the server's at settle points | R4, R7 |
| M10 | the narration helper (after OD-UR-1) asked for every stage entry — its sentence names exactly what the board applied | R8, UR-N23 |

### 14.3 Game G0 — the paired standard control

The same starting board and messages with the variant off: every run pays its printed total; every sign entry the
script sends is refused and not appended; no ghost, no Carcosan field ever appears; statistics equal the printed =
paid figures; the digest differs from G1 only where the die and the sign act.

### 14.4 S10-21 — the completed game

Tail A of G1 continued to the bank's end with the short bank (`GameLength` "short", $4,500) so the game completes,
or a live hosted game with an injected `mintSeed`. Either way it must contain a Mark, rust, a Bagholder and a Little
Engine, be committed beside the golden logs with its provenance stated, and restore the assertions S10-21 lists
(Carcosan Railways / "Marked by an Outer God", Gravedigger and Rust Belt in dollars, The Cowboy, the Bagholder and Little
Engine detail formats, a phase-5+ timeline of more than ten Operating Rounds).

### 14.5 Focused constructed states (not reasonable inside one legal game)

* Every gift-above-phase window: standard 6 (5s sold out), standard D (6s sold out), LPF 7 and D (P-B, P-F).
  *(Rev 2, OD-UR-3: the phase, shelf, rust, Gentle Rust marks, era and Phase Rusher stay put until the first REAL train
  of the tier, which then changes the phase normally and starts a gifted D's doom clock.)*
* A gilded 5 / 6 as a Diesel trade-in (P-I), at $800 and LPF's $750. *(Rev 2, OD-UR-7: refused; an ordinary copy of the
  same model beside it still trades.)*
* Crafted requests: on a standard table (P-A); for another corporation (P-D); after a phase change (P-G1′, P-G2′); after
  a self-trigger (P-H); duplicated; at another step; in a Stock Round — each refused or bound as OD-UR-1 decides.
  *(Rev 2, OD-UR-1: on a pinned table a client `YellowSignEvent` is never a source of authority — every one of these is
  refused, and the stage the run owed was already applied by the authority.)*
* *(Rev 2, OD-UR-2.)* A gilded train at the end of set N+1 is removed even if its corporation did not run in N+1, and
  never survives into N+2.
* A run without `train_indices` followed by a Mark (P-J).
* The rounding table exhaustively (printed $10 … $1,000 × six faces) and the tie direction (OD-UR-10 — *OPEN at rev 2*;
  *rev 4: decided 10-C — the table asserts ties toward printed, UR-F20*).
* The Mark on each tier (2 / 3 / 4 → $40 / $90 / $150) and on identical models; the Blood Price with a gilded and an
  ordinary copy of one model (OD-UR-5(c) — *OPEN at rev 2*; *rev 5: decided 5c-2 — UR-F21*).
* The statistics basis cases of OD-UR-6 (*OPEN at rev 2*; *rev 5: decided — 6.1 in principle, 6.2, 6.3; the per-train
  allocation isolated*; *rev 7: per train, the printed completed route*), including a nullified run, a gifted D and a
  Blood Price acquisition.
* LPF route authority (Coal River licence, warehouse towns) with the die on.

Why these stay outside G1: the gift windows need the depot to sell out at the exact moment of a 60% draw on a critical
bonus (reachable, but brittle to script and slow); the fog and the Blood Price are mutually exclusive for one gilded
train (hence two tails); the standard control and the LPF shelf need different deals.

---

## 15. Roadmap — the slices after this audit

| slice | semantic goal | expected files / surfaces | tests | owner decision first? | version during the slice | contributes to the next bump? | risk |
|---|---|---|---|---|---|---|---|
| **UR-1** (this) | audit / design | two documents | focused suites + probes (deleted) | — | 9 | — | — |
| **UR-2** | owner spec review. **Part 1 DONE (rev 2, 2026-09-24):** OD-UR-1, OD-GR-3, OD-UR-2, OD-UR-3, OD-UR-4, OD-UR-7, OD-UR-8, OD-UR-9, OD-UR-11, OD-UR-12 recorded here and in the backlog (D-36 closed; D-37 … D-45). **Part 2 pending:** OD-UR-5, OD-UR-6, OD-UR-10 — needed before UR-4's Blood Price part, UR-5's statistics and UR-7's rounding evidence respectively; **none of them is needed for UR-3** *(rev 4: OD-UR-10 DECIDED — 10-C; still pending: OD-UR-5, OD-UR-6)* *(rev 5: OD-UR-5 (a), (c) and OD-UR-6 DECIDED; still pending: OD-UR-5(b))* *(rev 7: OD-UR-5(b) and OD-UR-6.1's per-train question DECIDED — **UR-2 complete: every owner decision made**)* | documents only | — | **is** the decision step | 9 | — | low |
| **UR-3** | the Yellow Sign's authority, **as ruled**: (0) reproduce UR-F1; make every run stage an **automatic consequence of the authoritative run** and remove the client-sent `YellowSignEvent` as a source of authority on pinned tables — nothing dispatched from the drain, nothing a client can omit, delay, redirect or manufacture (OD-UR-1: UR-F1, UR-F2); the variant gate (UR-F3); the Mark on the **post-settlement fleet** — a Final Run train never a candidate — with route attribution (UR-F5) and narration (UR-F6) on the same basis (OD-GR-3); the breakdown from the authority's pairing (UR-F7); **the fog out of the run stages** and into an authoritative **OR-set-boundary transition at the end of set N+1** (OD-UR-2: UR-F18); optionally refuse a seedless pinned run (UR-F15) | `sS` (run arm, `YellowSignEvent` arm, `applyYellowSignOutcome`, the OR-set boundary), `YS` (`resolveYellowSign`, `runWithoutTrain`, `fogIsDue`), `gameEngine/derivedActions.ts` / the room engine (if the stage is recorded as a derived entry), `turnAuthority.ts`, `serverIngress.ts`, `messageSchema.ts`, `App.tsx` (narration, a boundary notice), `utils/gameHistory.ts` (stage readers), `utils/sessionKey.ts` | P-A, P-C, P-D, P-G1′, P-G2′, P-H, P-J as durable R / S tests (every crafted request refused; the owed stage applied by the authority); no reprieved copy ever a Mark candidate; the fog removed at the end of N+1 and never on a run; a drain-level harness or source pins for the shell; `YSA` / `YSI` / `B48` / `B60` / `FSR` inverted where their contract changes; legacy branches unchanged; 18-file sweep | **none outstanding** — OD-UR-1, OD-GR-3, OD-UR-2 decided (rev 2) | 9 | **yes** | **high** |
| **UR-4** | **(rev 8: IMPLEMENTED — uncommitted, awaiting the owner's gate: UR-F21 and UR-F22 fixed, OD-UR-5(a) pinned live, the Bank Pool provenance leg fixed — "UR-4 implementation (rev 8)")** the Carcosa lifecycle: synthetic trains never advance the phase (OD-UR-3: UR-F4 — including a gifted D's doom clock and the Phase Rusher / rust-cause credit); a gilded train refused as a Diesel trade-in while an ordinary copy of its model stays tradable (OD-UR-7: UR-F17); the Blood Price's consequences (OD-UR-5 — **OPEN**; can be split off if the rest lands first) *(rev 5: (a) decided — pin today's ordinary train live ~~and confirm the cured train's phase treatment with the owner~~; (c) decided — the copy-level sale, UR-F21; (b) OPEN)* *(rev 6: (a)'s phase question is closed by the owner — the Blood Price is an intercorporate purchase and changes no phase; UR-4 keeps the +1 supply accounting and makes sure the cured train is otherwise ordinary, §12.2; no owner blocker remains for (a))* *(rev 7: (b) decided — the buyer's marker moves, not the seller's, UR-F22; **UR-4 has no owner-decision blocker**)* | `GP` (`derivePhase` / depot), `sS` (`buyDepotTrain`, exchange arm, `settleTrainSale`, `startCarcosanDoomClock`, gift), `YS` (`carcosaGiftModel`), `gameEngine/dieselExchange.ts`, `trainLimit.ts` callers | P-B, P-F, P-I durable; `GHL` extended (LPF windows); 18-file sweep (no corpus ghost exists) | OD-UR-3, OD-UR-7 decided; **OD-UR-5 OPEN** *(rev 5: OD-UR-5(a) and (c) decided; **(b) OPEN**)* *(rev 7: OD-UR-5 fully decided — **none outstanding**)* | 9 | **yes** | **high** (phase machinery) |
| **UR-5** | money and statistics: the award stays **minted** (OD-UR-4 decided — no gameplay change; correct `MINTS_BY_DESIGN`'s stale comment, Appendix B item 11); the statistics' basis (OD-UR-6 — **OPEN**; UR-F8) *(rev 5: decided — 6.1 paid, in principle; 6.2; 6.3)* *(rev 7: per train, the printed completed route — OD-UR-6 fully decided)*; The Cowboy (UR-F9) | `MC` (comment), `utils/gameHistory.ts`, `utils/accolades.ts` | history cases; the constructed game's statistics | **OD-UR-6 OPEN** *(rev 5: decided; 6.1's per-train allocation to be answered before the per-train statistics)* *(rev 7: answered — **none outstanding**)* | 9 | **no** — the award's source does not change; statistics are derived history (as U-9) | medium |
| **UR-6** | UI / copy / Rules Reference: disclosure per 8-B (UR-F13; the Blood Price text once OD-UR-5 is decided); **"Unpredictable Revenue"** everywhere (UR-F14); the chip tooltip on OD-UR-2's lifetime (UR-F12); the fog's boundary notice (OD-UR-2); Appendix B's stale comments | `components/RulesReference.tsx`, `components/TrainBadges.tsx`, `components/HostSetupCard.tsx`, `components/LobbyRoomList.tsx`, `GV` copy and field docs, comments in `sS` / `YS` / `gameState.ts` / `trainDiscard.ts` / `trainLimit.ts` / `App.tsx` | copy / render tests | OD-UR-8, OD-UR-12 decided; OD-UR-5 for the Blood Price text *(rev 5: (a) and (c) decided; (b) pending)* *(rev 7: OD-UR-5 fully decided — none outstanding; the Blood Price copy names the buyer's move, UR-F22)* | 9 | no (replay-neutral) | low |
| **UR-7** | certification evidence: the matrix as durable tests (every clause, R1 – R13), G1 (two tails) + G0, S10-21's completed game, the 18-file corpus reconciliation; OD-UR-11 needs no change (accepted); OD-UR-10's tie rule applied or confirmed *(rev 4: applied — 10-C, ties toward printed, UR-F20; the die's rounding step and the rounding table)*; OD-UR-9 is not UR's (routed to AWS / live multiplayer) | a UR certification document; `utils/unpredictableRevenueCertification*.test.ts`; a constructed-game helper (test support only); the S10-21 fixture; *(rev 4)* `GV` (the die's rounding step) | as named | ~~**OD-UR-10 OPEN**~~ *(rev 4: OD-UR-10 decided — 10-C)*; G1 also needs OD-UR-5 (a)(b) and OD-UR-6 *(rev 5: only OD-UR-5(b), and 6.1's per-train allocation for the per-train statistics)* *(rev 7: none — OD-UR-5 and OD-UR-6 fully decided; OD-UR-10 decided since rev 4)* | 9 | no (evidence) *(rev 4: **yes** for the tie rule, UR-F20 — replay-semantic; the rest is evidence)* | medium |
| **UR-8** | closure: the one deliberate **9 → 10** boundary; changelog row 10 naming exactly the UR replay semantics; closure tests (supported `[10]`, a v9 log refused); backlog S9-7 / Part D / Part E; the owner's full-suite gate | `rulesVersion.ts`, closure test, documents | closure suite; corpus across the boundary; G1 / G0 across the boundary | every OPEN decision settled by then *(rev 7: all settled)* | **9 → 10** | is the bump | medium |

*(Rev 3: **UR-3 is implemented** (rev 5: **complete — owner-gated, committed and pushed as `9d0cf3a`**), and by the owner's brief it also carried UR-4's
UR-F4 and UR-F17 and — OD-UR-13 decided during the slice — the Mark's taken train (UR-F19). **UR-4 now holds** only the
Blood Price's consequences (OD-UR-5 — OPEN). The version boundary's items (1) – (5) and (8) below are implemented at v9
and owed to row 10.)* *(Rev 4: item (7) is decided — 10-C — and routed to UR-7, UR-F20; not implemented.)* *(Rev 5: UR-4's
Blood Price part is (a) today's behaviour, (c) UR-F21 and (b) OPEN; item (6) below says which of them changes replay.)*
*(Rev 7: (b) is decided — UR-F22 — so UR-4's Blood Price part has no owner blocker.)* *(Rev 8: **UR-4 is implemented**
(uncommitted, awaiting the owner's full repository Jest gate) — item (6) below is implemented at v9 and owed to row 10.
Next: UR-5, UR-6, UR-7, UR-8, in the owner's order.)*

*(Rev 2: the table reflects the rulings. The only change of ownership is the fog: its authority and removal location
move from UR-4 into UR-3, so UR-3 never builds a run-bound fog that OD-UR-2 has ruled out. The doom-clock arithmetic
itself — deadline N+1 — is unchanged; UR-4 keeps the trigger fix for a gifted D (UR-F4).)*

**The version boundary (rev 2).** Row 10 should name only replay semantics: (1) a Yellow Sign stage as an automatic
consequence of the run, with its variant gate — no client request is authoritative (UR-3; OD-UR-1); (2) the Mark on
the post-settlement fleet, never a Final Run train, with its route attribution (UR-3; OD-GR-3); (3) the fog as an
OR-set-boundary removal at the end of set N+1 (UR-3; OD-UR-2); (4) synthetic trains never advance the phase (UR-4;
OD-UR-3); (5) no gilded Diesel trade-in (UR-4; OD-UR-7); (6) the Blood Price's consequences, if OD-UR-5 changes them
(UR-4) — *(rev 5: (a) does not, it is today's behaviour; (c) does — the copy-level sale, UR-F21; (b) OPEN)* *(rev 7: (b)
does — the buyer's marker moves instead of the seller's, UR-F22)* *(rev 8: implemented at v9 in UR-4 — the copy-level
sale, an unnamed ambiguous sale refused (UR-F21), the buyer's move (UR-F22), and the Bank Pool's provenance of an
additional copy (`returned_ghost_trains`) so a cured train traded in stays additional; every table, the corpus unchanged)*; (7) the tie rule, if OD-UR-10 changes it — *(rev 4: it does — 10-C, an exact tie rounds toward printed; UR-7,
UR-F20; not implemented)*; *(rev 3)* (8) the Mark's taken train removed from the game —
`removed_trains`, counted toward the phase and off the depot, never purchasable — so the phase never falls back across it
(UR-3; OD-UR-13). Named as NOT rules: the award's source (OD-UR-4 keeps the mint — no
change), the statistics basis (OD-UR-6), the UI / copy / Rules Reference work (OD-UR-8, OD-UR-12), the undo rule
(OD-UR-11 — unchanged), the certification evidence, and the RNG source (OD-UR-9 — ingress only, routed to AWS / live
multiplayer; recorded seeds replay identically). *(Rev 1's list, kept for the record: the sign's binding and gate; the
Mark's fleet basis, Final Run rule and attribution; the gift / phase rule; the expiry timing if changed; the Blood
Price if changed; the gilded trade-in rule; the award's source if changed.)* The Stage 7.5 / 8.5 / 9 / GR-5 precedent
applies: the slices stay on 9 so the corpus is measured slice by slice against one baseline, and the bump is taken
once, at closure. Every
Unpredictable Revenue log in the corpus is unpinned, so changes gated on the pin — or reachable only through ghosts,
of which the corpus has none — are expected to leave the 18 files unchanged; each slice measures it.

---

## 16. Validation (this pass)

**Focused existing suites, run on the owner's checkout** (every test file that mentions an Unpredictable-Revenue term:
the variant, the Yellow Sign, Carcosa, seeds, rolls, rounding, ghosts, the Blood Price — 63 of the repository's 463
test files; `CI=true react-app-rewired test --watchAll=false --maxWorkers=2 --testPathPattern …`, six batches):

| batch | suites | tests | result |
|---|---|---|---|
| 1 | 10 (accolades … batch50) | 264 | pass |
| 2 | 12 (batch51 … ceremonySounds) | 278 | pass |
| 3 | 12 (chipRunRevenue … gentleRustGraceTurn) | 245 | pass |
| 4 | 12 (gentleRustTransactionLocks … revenueRounding) | 200 | pass |
| 5 | 10 (routeAuthority … stage9Closure) | 253 | pass |
| 6 | 7 (stateDigest … yellowSignIngress) | 138 | pass |
| **total** | **63** | **1,378** | **all pass** |

The full repository suite was **not** run (the owner's gate). **Probes:** eleven reported (P-A … P-J; a first
G1 / G2 pair was confounded by an over-limit discard hold and re-run as P-G1′ / P-G2′), in five temporary files, all
run and all deleted (Appendix A). **No production TypeScript was touched**, so no typecheck was needed.
`git diff --check` is clean for the backlog edit; this (untracked) document was checked separately (no trailing
whitespace, no tab, one final newline).
Nothing was committed or pushed.

**Rev 2 (documentation only).** No test was run and none was needed: no production code, test, fixture, log, golden or
export was touched, and `RULES_ENGINE_VERSION` is still 9. The matrix counts were recomputed from the §13 tables by a
script; `git diff --check` is clean for the tracked documents changed alongside (the backlog, the two Gentle Rust
documents), and this document was re-checked for whitespace. Nothing was committed or pushed.

**Rev 3 (UR-3 implementation, 2026-09-24).** Starting point: `main` = `origin/main` = `661bf34`, clean (only the
pre-existing untracked `.claude/`; the five corpus exports are git-ignored by `frontend/.gitignore`). The work was done in
a scratch copy and written back to the owner's checkout; **nothing committed or pushed**; the full Jest suite was **not**
run (the owner's gate). *(Rev 5: the owner then ran the full repository Jest gate, which passed, and committed and pushed
UR-3 as `9d0cf3a`.)*

* **New suites (all under `frontend/src/utils/`):** `yellowSignRunBound` 21, `yellowSignRunBoundStats` 12,
  `carcosaFogBoundary` 15, `carcosaSyntheticPhase` 11, `carcosaGildedExchange` 8, `unpredictableRevenueStandardControls` 6,
  `yellowSignMarkRemoval` 19 (OD-UR-13) — **92 tests, all passing**; against the untouched baseline **67 fail and 25
  pass**; the 21 OD-UR-13 tests against the UR-3 tree as it stood before the ruling: **17 fail, 4 pass** ("Reproduced
  before fixing", above). Test support: `yellowSignRunBoundSupport.ts` (constructed boards on a real route network; seeds
  found against the pure selectors, never asserted).
* **Updated where their contract changed (each with a UR-3 note):** `yellowSignAuthority` (no request moves a pinned
  board; the stage is the run's), `yellowSignIngress` case 2 (the normalizer proven on a run; Appendix C's evidence note
  resolved), `stage95Rulings` S9-3 (the Mark from the run), `stage95GhostLimit` (the phase ignores a synthetic D; the fog's
  removal asked of the boundary and of the legacy arm; #1092's run pin replaced by OD-UR-2's), `batch48` (the arm's pinned
  branch; the ghost no longer the phase), `batch60` (the fog's one line is now the boundary's), `batch61` (the narration
  block's anchor).
* **Focused Jest (243 suites, 4,567 tests — all pass):** every suite that mentions the variant, the Sign, Carcosa, ghosts,
  the Diesel exchange, the phase or the depot, the fleet-loss diff, statistics, `turnRefusal` or `refusalReasonFor` (112
  suites, 2,433 tests); every other suite that source-pins a changed file (130 suites, 2,115 tests); and the OD-UR-13 suite
  (19). The corpus-dependent suites ran with the five export logs in place (`moneyConservation` 33, `replayJuno3XD` 5,
  `replayJunoCV4` 5 — all pass).
* **`frontend tsc --noEmit`: exit 0. `server tsc --noEmit` (`server/tsconfig.json`, the repository's TypeScript 4.9.5 as
  `npm run build` invokes it): exit 0.**
* **Production build:** exit 0, "Compiled with warnings" — **49 ESLint warning lines** plus webpack's pre-existing
  "Critical dependency" notice, **the same set as the baseline build** compared modulo line numbers: none new, and the
  pre-existing ones in two files UR-3 touches (`App.tsx` 17, `sandboxSession.ts` 10) are unchanged. Built with the
  repository's `config-overrides.js` in a scratch copy outside the repository, `GENERATE_SOURCEMAP=false`.
* **Corpus reconciliation (18 files, baseline vs tree, `DEVELOPMENT_CORPUS_POLICY`):** 3 goldens, 8 server logs, the 5
  exports (3XD, CV4, JJD, QVC, Y8V), the FCJ-96 prefix and the Z6C-494 fixture. Stored / applied / dropped **4,105 / 3,731 /
  374**; **3,763** engine applications; state / grid / cursor / derived-action / known-phase differences **0 / 0 / 0 / 0 /
  0**; final boards equal **18 / 18**; **JUNO-Y8V** 668 / 628 / 40, 632 applications, `OperatingRound 13`,
  **`b4fae877c35604fe`**; **JUNO-3XD** 322 / 320 / 2, 323 applications, `StockRound 12`, **`74db6e4bad736fec`** — every
  per-file figure and final digest equal to the GR-5 certification's table. 0 legacy discards; 32 legacy home placements
  (both trees); no corpus file is pinned, so `removed_trains` and `last_run_yellow_sign` are written on no corpus board; the
  corpus's three stored `YellowSignEvent` entries (server Z6C 203 and 567, fixture Z6C-494 203) replay unchanged; the known
  phase **never decreases** at any engine application of any file, on either tree (OD-UR-13's invariant, measured).
* `git diff --check`: clean. `RULES_ENGINE_VERSION` still **9**. No stored log, golden, fixture, export or corpus file
  edited, migrated, repinned or regenerated (md5 of all 18 identical before and after, and identical to the owner's
  checkout).

**Rev 4 (OD-UR-10, 2026-09-24 — documentation only).** Starting point: `main` = `origin/main` = `9d0cf3a` ("Make Yellow
Sign authoritative" — UR-3); the tracked tree clean, only the pre-existing untracked `.claude/`. Only this document and
the backlog changed. No production code, test, log, fixture, golden, export or corpus file was touched; no test,
typecheck or build was run (none was needed); `RULES_ENGINE_VERSION` is still **9**; `git diff --check` is clean.
Nothing was committed or pushed.

**Rev 5 (UR-3 status; OD-UR-5, OD-UR-6 — 2026-09-24, documentation only).** Same starting point (`9d0cf3a`, with rev 4's
uncommitted edits to this document and the backlog). Only this document and the backlog changed. No production code,
test, log, fixture, golden, export or corpus file was touched; no test, typecheck or build was run; `RULES_ENGINE_VERSION`
is still **9**; `git diff --check` is clean. Nothing was committed or pushed.

**Rev 6 (the Blood Price's cured train — the owner's clarification, 2026-09-24, documentation only).** Same starting
point (`9d0cf3a`, with rev 4's and rev 5's uncommitted edits to this document and the backlog). Only this document and
the backlog changed. No production code, test, log, fixture, golden, export or corpus file was touched; no test,
typecheck or build was run; `RULES_ENGINE_VERSION` is still **9**; `git diff --check` is clean. Nothing was committed or
pushed.

**Rev 7 (owner policy closed — OD-UR-5(b), OD-UR-6.1 per train — 2026-09-24, documentation only).** Same starting point
(`9d0cf3a`, with rev 4's, rev 5's and rev 6's uncommitted edits to this document and the backlog). Only this document
and the backlog changed. No production code, test, log, fixture, golden, export or corpus file was touched; no test,
typecheck or build was run; `RULES_ENGINE_VERSION` is still **9**; `git diff --check` is clean. Nothing was committed or
pushed.

**Rev 8 (UR-4 implementation, 2026-09-25).** Starting point, verified before any work: local `main` =
`4b937a45ee8402723e4d5be12649dae3c199c748` ("Finalize Unpredictable Revenue rulings"), **1 ahead / 0 behind**
`origin/main` (`9d0cf3a`) — as expected, the documentation checkpoint not yet pushed; the tracked tree clean, only the
pre-existing untracked `.claude/`; no `.git/index.lock`. Nothing was reset, pulled, rebased, merged or checked out. The work
was done in a scratch copy — `origin/main` (`9d0cf3a`) plus the two checkpoint documents copied from the owner's checkout,
whose tree hash (`05f74c6893ebb11f464b1274184f948802136878`) equals the checkout's `4b937a45^{tree}` — and only the changed
files were written back to the owner's checkout. **Nothing committed or pushed**; the local documentation commit is
untouched. The full Jest suite was **not** run (the owner's gate).

* **New suites:** `utils/carcosaBloodPrice.test.ts` 42, `utils/carcosaBloodPriceStats.test.ts` 2,
  `components/carcosaBloodPricePanel.test.tsx` 6 — **50 tests, all passing**; against the untouched baseline **30 fail
  and 20 pass** ("UR-4 implementation (rev 8)").
* **Updated where their contract changed** (each with a UR-4 note; the seller-move pins inverted to the buyer, never
  deleted): `utils/bloodPriceArrival.test.ts` (the mover is the buyer), `utils/stage103CompositionCoupling.test.ts` ("the
  BUYER's token moves"), `utils/stage103bChartCoreAtomicity.test.ts` C, `utils/gentleRustTransactionLocks.test.ts` S8 (its
  Blood Price control names the gilded copy and pins the buyer), `utils/stage95GhostLimit.test.ts` E (the two-copy case
  names the copy, the ordinary copy's sale added; its OD-UR-5 speculation closed), `utils/batch60.test.ts` (the Blood Price
  block's title, the panel's warning pins).
* **Focused Jest: 263 suites, 5,228 tests — all pass** — every suite that mentions the variant, the Sign, Carcosa,
  provenance, the Blood Price, the Diesel exchange, the Depot / phase / pool, the intercorporate sale and its offer,
  derived actions, the fleet-loss diff, statistics / accolades, `turnRefusal` / ingress / the schema, `RoomSession` /
  replay / digests or Gentle Rust, and every suite that source-pins a changed file (`CI=true react-app-rewired test
  --watchAll=false --maxWorkers=2`, six batches). The corpus-dependent suites ran with the five export logs and the eight
  server logs in place.
* **`frontend tsc --noEmit`: exit 0. `server tsc` (`server/tsconfig.json`, the repository's TypeScript 4.9.5): exit 0.**
* **Production build:** exit 0, "Compiled with warnings" — **49 ESLint warning lines** plus webpack's pre-existing
  "Critical dependency" notice, **the same set as the baseline build** compared modulo line numbers: none new (the files
  UR-4 touches carry exactly their baseline warnings — `App.tsx` 17, `sandboxSession.ts` 10, `TrainPurchasePanel.tsx` 2,
  `derivedActions.ts` 1). `GENERATE_SOURCEMAP=false`, in the scratch copy.
* **Corpus reconciliation (18 files, baseline vs tree, `DEVELOPMENT_CORPUS_POLICY`)** — scratch builds of each compiled
  with `server/tsconfig.json`, and a scratch script (not added to the repository) recording per engine application the
  pre-entry state digest, grid hash, cursor, derived-action answer and known phase, then the finals: stored / applied /
  dropped **4,105 / 3,731 / 374**; **3,763** engine applications; state / grid / cursor / derived-action / known-phase
  differences **0 / 0 / 0 / 0 / 0**; final boards equal **18 / 18**; the known phase never decreases (0 in 3,763);
  **JUNO-Y8V** 668 / 628 / 40, 632 applications, `OperatingRound 13`, **`b4fae877c35604fe`**; **JUNO-3XD** 322 / 320 / 2,
  323 applications, `StockRound 12`, **`74db6e4bad736fec`**; 0 legacy discards; all 18 unpinned. Presence: no corpus
  board carries a gilding, a provenance marker or a pool provenance entry; 11 stored `BuyTrainFromCorporation`, **0**
  Carcosan transfers — so UR-4 reinterprets no stored entry. Corpus file bytes (md5) identical to the owner's checkout.
* `git diff --check`: clean. `RULES_ENGINE_VERSION` still **9**. No stored log, golden, fixture, export or corpus file
  edited, migrated, repinned or regenerated. Two throwaway probe tests ran in the scratch copy only and were deleted;
  nothing temporary was created in the owner's checkout.

---

## Appendix A — probes (temporary tests; created, run and deleted in this pass)

Each probe applied real messages to the real reducer (`applySandboxAction`) — and, where marked, through
`RoomSession.submit` with `sandboxReplayProviders()` — on constructed pinned boards (`rules_engine_version` = 9). Seeds
were found by searching against the real `resolveYellowSign`. Without a map grid the run arm prices every route at the
nominal $90. The outputs are quoted verbatim.

| probe | setup | observed |
|---|---|---|
| **P-A** | STANDARD table (`unpredictableRevenue: false`); B&O `["3","4"]` runs two routes with a seed whose derivation is a Mark; then `YellowSignEvent{B&O}` via the reducer and via `RoomSession.submit` by B&O's president | run: `last 180 = printed 180` (no roll); after the request: owned `["4"]`, treasury 340 → 430, `has_yellow_sign: true`, last 70 / printed 90 (the kept route re-rolled 90 → 70), money total +90; room: `applied`, same board — **UR-F3** |
| **P-B** | phase 5, all three 5s owned (the depot's head is 6); B&O Marked `["5"]`; C&O `["3"]` | Carcosa gifts a ghost 6: owned `["5","6"]`; derived phase 5 → **6**; shelf `["6"]` → `["6","D"]`; C&O then buys the first REAL 6: C&O `["3","6"]` — **the 3 does not rust**; control without the gift: C&O `["6"]` — **UR-F4** |
| **P-C** | Gentle Rust + UR, phase 4; B&O `["2","3"]` with the 2 reprieved (its grace turn); runs both with a Mark seed | after the run: owned `["3"]`, marks `[]`, step Dividends, breakdown `[{0,"2",90},{1,"3",90}]`; the narration would name the 2 / $40, the reducer derives the 3 / $90; after the request: owned `[]`, treasury 430, breakdown `[{1,"3",90}]`, printed 90, last 70 — **the destroyed 2's route was nullified and the taken 3's kept (UR-F5); narration ≠ board (UR-F6)** |
| **P-D** | C&O Carcosan with a gilded D due (macro 5 > doom 4); B&O operating at Track; B&O's president submits `YellowSignEvent{C&O}` through `RoomSession.submit` | `applied`; C&O `["4","D"]` → `["4"]`, gilding `[]`, cursor still B&O at Track — **another player collected C&O's fog before C&O ran (UR-F2)** |
| **P-E** | UR table; B&O Marked by a legitimate request | bank 5000 → 5000, treasury +90, money total +90 — **the award is minted (UR-F10, OD-UR-4)** |
| **P-F** | phase 6 with both 6s owned (the shelf holds only D); B&O Marked `["6"]`; C&O `["4"]` | Carcosa gifts a ghost **D**: owned `["6","D"]`, doom not set; derived phase → **D**; C&O buys the first REAL D: C&O `["4","D"]` — **the 4 does not rust, and B&O's doom clock never starts (UR-F4)** |
| **P-G1′** | phase 4 (4s sold out); B&O `["4"]` runs with a Mark seed | on-time request: owned `[]`, sign true; the same request after Withhold and buying the first 5 (phase 5, the seed still on the board): owned `["4","5"]`, no sign — **the Mark dodged by delay (UR-F2)** |
| **P-G2′** | as P-G1′, B&O already Marked; a seed whose derivation is nothing in phase 4 and Carcosa in phase 5 | on-time: no Carcosa; after buying the first 5: `["4","5","5"]`, Carcosan, gilded `["5"]` — **a Carcosa harvested outside its run's phase (UR-F2)** |
| **P-H** | Gentle Rust + UR, phase 3 (3s sold out); B&O `["2","3"]` runs with a Mark seed, Withholds, buys the first 4 (its 2 reprieved and doomed this turn), then requests | after the buy: `["2","3","4"]`, marks `["2"]`, doomed-this-turn `["2"]`; after the request: `["3","4"]`, **marks still `["2"]` (orphan)**, treasury +40 — **a doomed train monetized, the Gentle Rust invariant broken (UR-F2, OD-GR-3)** |
| **P-I** | phase D (NYC owns a real D); B&O holds a gilded ghost 6 (doom 7), in Buy Trains; exchanges the 6 for a D | owned `["D"]`; gilding `["6"]`, ghost `["6"]`, Carcosan, doom 7 all kept; Bank Pool `["6"]`; the depot's 6s remaining 1 → 0; treasury −800 — **UR-F17 / OD-UR-7** |
| **P-J** | UR table; B&O `["3","4"]` runs two routes with and without `trains` / `train_indices`, same Mark seed | named: owned `["4"]`, printed 90, last 70; unnamed: owned `["4"]`, **printed 180, last 140** — the taken train's run is not nullified (**UR-F7**) |

---

## Appendix B — stale comments and documentation (to correct in UR-6; none edited here)

1. `gameEngine/gameVariants.ts:499` — the flag's own doc: "Every running train rolls a d6 against its printed revenue"
   (#903's per-train roll; #941 made it one roll per turn on the aggregate).
2. `gameEngine/gameVariants.ts` #938 note — "ROUNDED PER RUN, NOT PER TURN" (superseded by #941's per-turn roll).
3. `gameEngine/gameState.ts:250–265` — `ghost_trains`: "bypasses train limit checks until the end of the Operating
   Round … EMPTIED AT THE OPERATING ROUND BOUNDARY" (superseded by #1672 — `ghost_trains` is provenance only).
4. `gameEngine/sandboxSession.ts:3999–4012` — DN 1046 "THE GHOST STOPS BEING ONE WHEN THE ROUND ENDS … THE TRIM RUNS
   IMMEDIATELY AFTER" (the #1672 note below it says so; the block itself is not marked superseded).
5. `gameEngine/sandboxSession.ts:6587–6593` — "a train matching the current phase's tier … bypasses train limit checks
   until the end of the Operating Round" (superseded by #1672 on both counts).
6. `gameEngine/sandboxSession.ts:6100–6112` — DN 1046 "THE ACTING CLIENT DECIDED AND THIS APPLIES. `model` and `cash` are
   carried on the message" (superseded by #1661 on pinned boards).
7. `gameEngine/trainDiscard.ts:44–46` — "the ghost's own expiry (`expireGhostTrains`, #1046, at the round boundary) is
   unchanged" (the function is deleted, #1672) — also Gentle Rust Appendix B item 15.
8. `gameEngine/yellowSign.ts` #1128 comment in `resolveFlavourLine` — "a 1-in-5" and #1044's "the seeded tenth" (the
   chance is 60%, #1421).
9. `App.tsx` fog dispatch (≈`:7417–7421`) — "THE MODEL IS NAMED ON THE MESSAGE, like the Mark's is (#902)" (the request
   names no model since #1661).
10. `App.tsx:7482–7484` — #1094 "WHAT IS DELIBERATELY NOT GUARDED is the `YellowSignEvent` dispatch above" (the
    dispatch is in fact refused in every drain since #1407 — UR-F1).
11. `utils/moneyConservation.test.ts:186–203` — "If S9-1 is ever closed the second half fails and the exemption … comes
    out with it" (S9-1 closed; the exemption stayed — OD-UR-4). *(Rev 2: OD-UR-4 keeps the mint as variant law, so the
    comment is wrong, not the exemption; correct it in UR-5.)*
12. Player-facing: `components/TrainBadges.tsx:632` (UR-F12).

## Appendix C — observations outside Unpredictable Revenue (recorded, not investigated)

* `server/src/gameServer.ts:268` mints seat tokens with `Date.now()` and `Math.random()`; seat tokens are credentials.
  Routed to the AWS / live multiplayer phase (backlog: the Stage-10 "Forward roadmap after Stage 10", item 4, and
  the S9-7 UR-1 block); not part of this certification. *(Rev 2: OD-UR-9's ruling — hosted revenue seeds from a
  cryptographic source — is routed to the same place and kept beside this item; neither is implemented in UR.)*
* Evidence quality: `yellowSignIngress.test.ts` case 2 expects a bare `YellowSignEvent` on an un-run board to be
  `applied`; it is applied only because the constructed board is unsettled (the settle functions normalise it), not
  because the request did anything — a settled board would refuse it (#1685). It remains valid evidence for the
  normalizer's placement, not for the sign.
