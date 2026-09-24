# Variant Certification 1A — Gentle Rust: specification / authority / coverage audit

**2026-09-23 · AUDIT + DESIGN ONLY.** No production code, test, golden, fixture, log or export was changed.
`RULES_ENGINE_VERSION` is untouched (8). Nothing committed or pushed. Gentle Rust is **not** certified by this
document.

**Verdict: B — SPEC COMPLETE / IMPLEMENTATION GAPS FOUND.** The owner's spec review (below) decided OD-GR-1 and
OD-GR-2, accepted the grace-turn reconstruction and separated train-limit capacity from train ownership. OD-GR-3 is a
cross-variant question deliberately routed to Unpredictable Revenue certification; it does not leave the standalone
Gentle Rust specification incomplete. Certification still requires the semantic implementation, behavioural tests,
UI/copy reconciliation, corpus characterization, the replay/version decision and the final gate (§11).

*(rev 4, 2026-09-24)* GR-1, GR-2, DT-1 and GR-3 are owner-gated and committed (GR-3 = `4f4844a`). **GR-4 is complete
pending the owner gate**; its evidence is `VARIANT_CERT_GENTLE_RUST_CERTIFICATION_2026-09-24.md` (29 clauses CERTIFIED,
GR-S26 DEFERRED BY SPEC). GR-5 is pending. The implementation gaps below are historical findings, each now marked
RESOLVED. **Gentle Rust is still NOT certified.**
*(rev 5)* U-9 is **owner-ruled: destruction-time accounting** for the obsolescence statistics (GR-4's earlier "B" withdrawn);
implemented in derived history only (`gameHistory.ts`, #1704) — no gameplay or version change.
*(rev 6, GR-5)* **STANDALONE GENTLE RUST IS CERTIFIED at `RULES_ENGINE_VERSION` 9.** GR-4 passed the owner gate and is
committed (`c202621`); GR-5 (#1705) took the one deliberate 8 → 9 boundary for GR-1, GR-2 and DT-1's replay semantics and
closed the certification (evidence: certification doc §P). OD-GR-1 and OD-GR-2 are DECIDED and recorded in the backlog's
Part D (D-34, D-35); OD-GR-3 is DEFERRED to Unpredictable Revenue certification (D-36), so **combined Gentle Rust +
Unpredictable Revenue is NOT certified.** Backlog Part C U-41 (a standard-game statistics gap) remains open and outside
this certification. The status lines of rev 3–5 below are kept as written.

**Revision history.**

| rev | date | change |
|---|---|---|
| 1 | 2026-09-23 | initial audit — verdict C (three owner decisions) |
| 2 | 2026-09-23 | **owner spec review recorded** (§4): reprieved-train definition, capacity ≠ ownership, forced-purchase sequence, grace-turn timing accepted, OD-GR-1 and OD-GR-2 ruled, OD-GR-3 routed to UR. §3 restructured into GR-S1…GR-S30; forced-purchase predicates audited (§5); implementation gaps consolidated (§3.4); slices, test invariants and criteria updated. Four line references corrected (`gameVariants.ts:690`, `purchaseWarnings.ts:339`, `sS:1668–1670`/`:1673`, test fixture notes) |
| 3 | 2026-09-24 | **slice status only** (§7, §9, §10, Appendix B): GR-1, GR-2 and DT-1 complete, owner-gated, committed; GR-3 (UI / Rules Reference / narration, #1702) complete pending owner gate; GR-4 and GR-5 pending. U-6 completed in GR-3; U-9 routed to GR-4 / final certification. No specification clause changed. **Gentle Rust is still NOT certified.** |
| 4 | 2026-09-24 | **status only (GR-4).** GR-3 owner gate passed, committed `4f4844ad87e3586367f114edbfe4978deb6c181e`. GR-4 (certification matrix, invariants A–H, P1–P9 as durable tests, constructed legal game through the first 4 / 6 / D, corpus reconciliation, U-9 disposition — #1703) complete pending owner gate; evidence moved to `VARIANT_CERT_GENTLE_RUST_CERTIFICATION_2026-09-24.md`. IG-A…IG-F marked RESOLVED / CERTIFIED EVIDENCE (history preserved). GR-5 pending. No specification clause changed. **Gentle Rust is still NOT certified (GR-5 owns the 8 → 9 boundary and closure).** |
| 5 | 2026-09-24 | **owner ruling U-9 (statistics only).** GR-4's first classification of U-9 as B (mark-time counting, documented) is **withdrawn**: it was not supported by the statistics authority (`gameHistory.ts` #1414, #1422). **Owner ruled destruction-time accounting** — a Gentle Rust train counts as rusted / lost (fleet ledger, Rust Belt, Gravedigger) only when its Final Run actually removes it; a train still owned at game end is kept. Implemented in derived history only (#1704; certification doc §L, r2). No gameplay clause changed; no version change. GR-4 again ready for the owner gate after the correction. |
| 6 | 2026-09-24 | **GR-5 — certification closure.** GR-4 owner-gated and committed (`c202621`). `RULES_ENGINE_VERSION` **8 → 9** (#1705), changelog row 9 naming exactly the four replay semantics of §9 (GR-1 self-trigger grace turn; GR-2 sale refusal; GR-2 Diesel trade-in refusal; DT-1 auto-skip) with GR-3, GR-4 and the U-9 statistics correction kept outside the rules semantics; OD-GR-1 / OD-GR-2 recorded as backlog Part D decisions D-34 / D-35 and OD-GR-3 as D-36 (deferred to UR) — §11 gate item 1; §11 gate items 1–7 met, item 8 (full Jest at the certification commit) is the owner's gate. No specification clause changed. **Standalone Gentle Rust CERTIFIED at v9; Gentle Rust + Unpredictable Revenue NOT certified (OD-GR-3).** |

---

## 0. Baseline

| item | value |
|---|---|
| branch | `main` |
| HEAD | `c4d3b5da077a6386ca79106f7e3056e97aa6dc43` ("Route deferred Stage 10 work") |
| `origin/main` | `c4d3b5da077a6386ca79106f7e3056e97aa6dc43` — HEAD == origin/main |
| tracked tree | clean at audit start (only untracked `.claude/`) |
| `RULES_ENGINE_VERSION` | `8` (`frontend/src/gameEngine/rulesVersion.ts:65`) |

Host note: the audit's first read-only `git status` left an empty `.git/index.lock` because the desktop mount
refuses `unlink`; with the owner's approval that one zero-byte lock file was deleted and every later git call ran
with `GIT_OPTIONAL_LOCKS=0`. No other file was deleted. (This is S10-16's known host hazard.)

---

## 1. Authority hierarchy used

1. **Explicit owner rulings / corrections** — quoted in design notes as `RULED` / `CORRECTED` / owner-supplied
   `REPORTED` text, in `RULES_HARDENING_BACKLOG.md` owner-ruling entries, and (rev 2) the owner's spec review of this
   audit, recorded in §4.
2. **Later owner rulings supersede earlier ones.**
3. **2018 revised Lookout 1830 rules** (`en_1830re…pdf`, the backlog's stated authority) for everything Gentle Rust
   modifies or touches: rust schedule, phase change on purchase (§2.0), train limits, purchases and intercorporate
   sales (§6.6), excess discards (§6.6.1), forced purchase (§6.6.2), running (§6.4).
4. **Code and tests are evidence, not authority.** Several passing tests below pin behaviour this audit classifies
   as wrong.
5. **Player-facing copy is evidence, not authority.**

### The original brief's premise needed one correction

The brief expected **#979** ("gently rusted trains DO count toward the limit") to be the final train-limit rule. **A
later owner ruling exists: #1034 reverses #979.** Quoted in `trainLimit.ts:103–106` and `batch37.test.ts:60–61`:

> RULED, with the precedent: "1846 officially implements the 'delayed obsolescence' rule, and in that version when
> trains gently rust, they stop counting to the train limit and players turn the train cards sideways to indicate
> they have one run left." … "I am inclined to implement the 1846 rule." … "you need to make sure the train chips
> for the gently rusting trains continue displaying on their final run."

#1034 is implemented everywhere a limit is counted, was respected by Batch 4.6 (#1530), is cited as standing by the
owner's S9-7 entry (`RULES_HARDENING_BACKLOG.md:1775`), and was **confirmed by the owner's spec review** — with the
clarification that the exemption is about limit **capacity only** (§3.1). Stale text is therefore the #979 wording
("reprieved trains count") and the #906 *mechanism* wording ("the train leaves `owned_trains`"). Appendix B lists
every such site.

---

## 2. Decision chronology

Design-note numbers are the project's chronology; git history is batch-grained and adds nothing finer.

| # | kind | substance | status today |
|---|---|---|---|
| #902 | schema ruling | `gentleRust` declared as a real field with a real default before it had a reader; absent = standard game; `resolveVariants` is the one decider | **in force** |
| #906 | REQUESTED + RULED | Requested: "trains that would normally rust instead enter a 'pending rust' state, granting them exactly one final Operating Round run before obsolescence." Ruled: the pending train "dies at the exact end of that specific corporation's next Operating Round turn (immediately after it generates its final revenue)", and does NOT occupy a train-limit slot. Mechanism: move the train out of `owned_trains` | timing words **in force**; limit clause **superseded by #979, restored by #1034**; mechanism **superseded by #979** |
| #906a | implementation fix | reprieve clear lifted above the non-OR early return so the last corporation of a set cannot keep a mark into the next set | **in force** as the turn-end *fallback* — but must be limited to the qualifying grace turn (GR-S19) |
| #979 | CORRECTED (owner) | "Gently rusted trains do count toward the limit until they are permanently retired at the end of their grace run"; mechanism changed to a *mark* over `owned_trains` so the train can reach the route planner | limit clause **superseded by #1034**; mark mechanism **in force** |
| #980 | copy | modal's "no longer counts against the train limit" clause removed | superseded again by #1003 |
| #982 | RULED (owner) | lobby blurb: "A rusting train gets one last Operating Round turn before it goes." | **in force** |
| #1001 | REPORTED → impl. | Buy-Trains auto-skip at the limit (a #979 artefact); death moved from turn end to entering Buy Trains | superseded by #1102 (step) and moot under #1034 (reason) |
| #1002 | RULED (owner) | Rust modal must fire "at the moment the gently rusted trains are permanently destroyed" | **in force** |
| #1003 | RULED (owner) | remove the special "Gentle rust: …" modal line | **in force** |
| #1004 | RULED (owner) | persistent warning badge until destroyed; chips keep their warning and pulse | label superseded by #1033; rest **in force** |
| #1032 | REPORTED (playthrough) | a marked train re-marked by a repeated phase application — fixed at the write (sub-multiset invariant). Player reaffirmed #979 | invariant fix **in force**; limit reaffirmation **superseded by #1034** |
| #1033 | RULED (owner) | "Rusts Soon" / "Rust Imminent"; post-purchase badge "Final Run: [type]-trains"; countdown pulse removed | **in force** |
| #1034 | RULED (owner) | 1846 delayed obsolescence: reprieved trains **stop counting** to the limit; chips keep displaying; "(Gently Rusting: 3-trains)" | **in force — limit capacity rule** |
| #1099 | REPORTED → impl. | an expiry was narrated as a limit discard; one shared `expiredReprieves` answer | **in force** |
| #1102 | REPORTED (owner) | "really it should happen at the beginning of the Dividends subphase / end of Run Routes" → destruction on the cursor *entering Dividends* | **in force — normal destruction point** |
| #1303 / #1314 / #1439 | RULED (owner) | Diesel exchange (4/5/6 → D at $800; LPF $750) on every table; a traded-in train returns to the Bank Pool "provided it hasn't rusted" | **in force** for non-reprieved trains; reprieved trains excluded by OD-GR-2 |
| #1530 | Batch 4.6 (rulebook 6.6.1) | automatic trim replaced by the president's `DiscardTrain`; obligation counted on countable (non-reprieved) trains | **in force** |
| S9-7 | owner ruling 2026-09-19 | Gentle Rust not audited; pre-launch variant certification required | this document |
| **SR-1…SR-9** | **owner spec review, 2026-09-23** | reprieved-train definition; capacity ≠ ownership; bankruptcy-buffer purpose; forced-purchase sequence; turn-not-run accepted; grace-turn timing incl. self-trigger accepted; destruction point + fallback requirement; **OD-GR-1: no sale/transfer**; **OD-GR-2: no Diesel trade-in**; OD-GR-3 routed to UR | **in force** (§4) |

---

## 3. Normative specification (rev 2)

Status vocabulary: **CONFIRMED** owner ruling · **INHERITED** standard rule · **DERIVED** consequence of confirmed
rules · **DEFERRED** routed elsewhere. The right-hand column is the current code's conformance, proved by the probes in
Appendix A where marked (P#), or by the predicate audit in §5.

### 3.1 What a reprieved train is — the core rule (SR-1, SR-2)

A train that has entered Gentle Rust's pending-rust / reprieved state:

* **does** remain owned by its corporation;
* **does** remain in the corporation's usable train fleet;
* **does** remain operable during its grace period;
* **does** answer "yes" to *"does this corporation currently own a train?"*;
* **does** prevent the corporation from being treated as trainless merely because all its trains are reprieved;
* **does not** count against the corporation's **maximum train limit**;
* **is** scheduled for mandatory destruction after its one qualifying grace Operating Turn;
* **may not** be sold / transferred to another corporation, nor used as a Diesel trade-in (the only two transaction
  prohibitions — OD-GR-1, OD-GR-2).

Gentle Rust changes exactly **two general properties** during reprieve: (1) the train is exempt from the maximum
train-limit count; (2) the train is doomed to mandatory removal after its qualifying grace Operating Turn. In every
other ordinary ownership and operation respect it remains a train, **except** the two specifically ruled transaction
prohibitions.

These are separate predicates, and this document never says a reprieved train "doesn't count" without naming what:

| predicate | reprieved train |
|---|---|
| **train-limit capacity** (purchase gates, Buy-Trains auto-skip at the limit, capacity displays, excess-discard obligation) | **does not count** |
| **corporation owns a train** | **yes** |
| **trainless / forced-purchase test** (§6.6.2, emergency funding, End-Turn gate) | **yes — the corporation still has a train** |
| **route / operation** | **yes**, during its grace period |
| **excess-discard candidate** | **no** (it occupies no slot) |
| **intercorporate sale / transfer** | **no** (OD-GR-1) |
| **Diesel trade-in** | **no** (OD-GR-2) |
| **permanent availability** | **no** — doomed, removed at expiry |

> **INVARIANT: EXEMPT FROM THE TRAIN LIMIT ≠ ABSENT FROM THE FLEET.** A helper that answers train-limit capacity
> must never be reused as the definition of "owns a train" (SR-2; test invariant E, §11).

### 3.2 Clause table

| clause | rule | status | current code |
|---|---|---|---|
| **A. Scope and trigger** | | | |
| **GR-S1 Flag** | `variants.gentleRust: boolean`, carried on `SetupGame`, resolved field-by-field; absent → `false`. | CONFIRMED (#902) | CORRECT |
| **GR-S2 Which models are doomed** | The ordinary rust triggers decide: 2s at the first 4, 3s at the first 6, 4s at the first D (all tables, incl. LPF / 18XX+). | INHERITED (phase table) | CORRECT (`RUSTED_BY` / `RUSTS_ON`) |
| **GR-S3 Delay, not exemption** | Gentle Rust delays destruction; it never changes which models rust, and a doomed train must never become permanent. | CONFIRMED (#906 "trains that would normally rust") + DERIVED | **WRONG** via the sale and trade-in holes (GR-S12, GR-S13; P6, P9) *(rev 4: RESOLVED — GR-2; CERTIFIED EVIDENCE → certification doc §C)* |
| **GR-S4 Trigger moment** | The purchase that brings the first train of the triggering tier into play (depot, emergency, or Diesel exchange) changes the phase the moment it resolves (§2.0). In a first-D exchange the traded-in (non-reprieved) train leaves before the phase turns and is exchanged, not rusted. | INHERITED; exchange detail CONFIRMED (#1303/#1314) | CORRECT (P1, P9; `dieselExchange.test.ts:119`) |
| **GR-S5 Who is doomed** | Every copy of the doomed model held by **every** corporation at that moment is marked — including the purchaser's own. | DERIVED (#906 + standard "all") | CORRECT (P1) |
| **GR-S6 Bank Pool / depot** | Doomed-model trains in the Bank Pool are destroyed at the phase change, no reprieve. Unsold depot stock of a doomed tier cannot exist (queue rule). | DERIVED (#1314 + #906) / INHERITED | CORRECT at the phase change (P5, P9) |
| **B. Status during reprieve** | | | |
| **GR-S7 Remains owned** | The train stays in `owned_trains`, visible on every train surface. | CONFIRMED (#979 mechanism, #1034 chips, SR-1) | CORRECT |
| **GR-S8 Remains operable** | The train may be assigned a route and run during its grace period under its ordinary capacity and rules. | CONFIRMED (#906 request, SR-1) | CORRECT by construction (roster and route authority read `owned_trains`); **UNTESTED behaviourally** *(rev 4: CERTIFIED EVIDENCE → GR-1 route test; certification doc §C)* |
| **GR-S9 Prevents trainlessness** | A corporation whose only trains are reprieved **owns trains**: it is not trainless, owes no §6.6.2 purchase and is not put into emergency funding because of the reprieve. This is part of the variant's purpose — delayed obsolescence buffers a corporation from being forced straight into an emergency purchase when its trains rust. | CONFIRMED (SR-1, SR-3) | CORRECT BUT UNDERTESTED / MUST PIN (§5 predicate audit: every trainlessness reader uses raw `owned_trains`) *(rev 4: CERTIFIED EVIDENCE, mutation-verified → certification doc §C, §E)* |
| **GR-S10 Limit capacity** | The train does **not** count against the phase's **maximum train limit** — purchase gates, the Buy-Trains auto-skip at the limit, capacity displays, the excess obligation. | CONFIRMED (#1034, SR-1) | CORRECT (`countableTrainCount`, used only for capacity) |
| **GR-S11 Not an excess-discard candidate** | The §6.6.1 obligation is `countable − limit`, and the president chooses among countable trains only. A reprieved train is not a candidate because it occupies no slot — **not** because it is unowned. A discard never changes marks. | DERIVED (#1034 + §6.6.1), confirmed as conforming (SR-8) | CORRECT (P7: not offered; direct `DiscardTrain` refused) |
| **GR-S12 No sale / transfer** | A reprieved train **may not be sold or otherwise transferred** to another corporation — refused at proposal, answer and settlement. Its reprieve belongs to the corporation that owned it at the rust event; it stays there through its grace turn and is then removed. It may not escape rust by changing ownership. The mark does **not** follow a train anywhere. | **CONFIRMED (OD-GR-1)** | **WRONG** — sale accepted; buyer gets an unmarked, permanent train; seller keeps an orphan mark (P6) *(rev 4: RESOLVED — GR-2 `b755a7b`; CERTIFIED EVIDENCE → certification doc §C)* |
| **GR-S13 No Diesel trade-in** | A reprieved train **may not be used as a Diesel trade-in** (today: a reprieved 4 toward the $800 / LPF $750 Diesel). It gives no credit, never enters the Bank Pool through an exchange, never becomes purchasable after its tier is obsolete. Non-reprieved 4-, 5- and 6-trains keep their ordinary trade-in rights. | **CONFIRMED (OD-GR-2)** | **WRONG** — exchange accepted; mark orphaned; obsolete 4 enters the pool and was bought in phase D (P9) *(rev 4: RESOLVED — GR-2 `b755a7b`; CERTIFIED EVIDENCE → certification doc §C)* |
| **GR-S14 Route / revenue** | A reprieved train is priced, contributes to pay/withhold and (under Unpredictable Revenue) rolls its die exactly like any train, unless a separately certified variant says otherwise. Its destruction on entering Dividends cannot change the payout (`DeclareDividends` prices from the run, #752/#1102). | DERIVED (no rule modifies it) | CORRECT by construction; **UNTESTED behaviourally** *(rev 4: CERTIFIED EVIDENCE → GR-1 route test; certification doc §C)* |
| **C. Timing** | | | |
| **GR-S15 The qualifying grace turn** | The grace entitlement is **one Operating Turn that BEGINS AFTER the train became doomed**. (A) another corporation triggers before the affected corporation has operated in this OR → its later turn in the **same** OR; (B) triggered after it already operated → its next turn in a **later** OR (across a Stock Round if the set ends); (D) last corporation of a set / end-of-set trigger → every doomed train survives the Stock Round to its corporation's next actual turn; (E) one-corporation OR → same rules. | **CONFIRMED** (#906 + #1102; accepted SR-5) | (A) CORRECT (P1/NYC); (B) CORRECT (P3); (D) CORRECT for other corporations (P4); (E) CORRECT for pre-existing marks (P5b) |
| **GR-S16 Self-trigger** | (C) A corporation that dooms its own trains in its own Buy Trains step cannot use the current turn — it began before the doom event. Its old trains survive the turn end (and a Stock Round, if the set ends) into its **next future Operating Turn**, remaining owned, non-counting for the limit, and sufficient to prevent trainlessness until actually destroyed. | **CONFIRMED** (SR-5: "a confirmed implementation defect, not an unresolved owner question") | **WRONG** — destroyed at the end of the current turn (P1, P1b, P4-self, P5) *(rev 4: RESOLVED — GR-1 `0ca01be`; CERTIFIED EVIDENCE → certification doc §C, §E H)* |
| **GR-S17 Turn, not run** | The entitlement is the qualifying turn, not a successful run. No legal route, no route assigned, or no revenue earned — the train still expires at that turn's expiry point. It is never "kept until it completes a route". Whether a president may decline to run is ordinary route authority (pinned boards: a skip at Run Trains is refused while a paying route exists, #1550). | **CONFIRMED** (#906, #982; accepted SR-4) + INHERITED (§6.4) | CORRECT (P3, P5b) |
| **GR-S18 Normal destruction point** | The end of **Run Routes** in the qualifying grace turn (the cursor entering Dividends). | CONFIRMED (#1102; accepted SR-6) | CORRECT (`sS:4127–4130`) |
| **GR-S19 Fallback cleanup** | If the qualifying turn ends without reaching the normal destruction point, end-of-turn cleanup destroys the train. The fallback applies **only to a train whose qualifying grace turn this is**; it must never destroy a train newly doomed later in that same turn (a Buy Trains self-trigger, GR-S16). **Implementation requirement:** the engine must know whether the current turn is the train's qualifying grace turn (state or derivation — not designed here). | CONFIRMED (SR-6) | **WRONG** — the fallbacks (`sS:3893`, `sS:3985`) expire every mark of the outgoing corporation, including marks created in that turn *(rev 4: RESOLVED — GR-1 `0ca01be`; CERTIFIED EVIDENCE → certification doc §C)* |
| **D. Destruction and aftermath** | | | |
| **GR-S20 Destruction** | Removes the train from `owned_trains` and its pending-rust mark, one mark per train. | DERIVED (#1032 "permanently and completely removed") | CORRECT (`expireReprieveFor`) |
| **GR-S21 Not pooled / not revived** | A destroyed reprieved train does not enter the Bank Pool, cannot be bought again, cannot be re-marked, and is recorded as exactly one loss. | DERIVED | CORRECT for expiry; the pool is reachable only through the trade-in hole (GR-S13). Statistics record the loss at marking (U-9) *(rev 5: owner ruling U-9 — statistics now book the loss at the destruction, once; certification doc §L)* |
| **GR-S22 Trainless only after destruction** | Only when its reprieved trains are actually destroyed can a corporation become trainless because of them. If it still owns any non-reprieved train, expiry does not make it trainless and no forced purchase arises from the expiry. | CONFIRMED (SR-3) | CORRECT BUT UNDERTESTED / MUST PIN *(rev 4: CERTIFIED EVIDENCE → certification doc §C)* |
| **GR-S23 Ordinary forced purchase afterwards** | After destruction, the ordinary no-train / forced-purchase authority applies normally at that turn's Buy Trains step; if its prerequisites hold (§6.6.2: no train, a legal route, a train for sale), the normal emergency-purchase path may engage. Sequence in §3.3. | CONFIRMED (SR-3) + INHERITED | CORRECT BUT UNDERTESTED / MUST PIN (`trainObligationFor` reads `owned_trains`; expiry precedes Hardware) *(rev 4: CERTIFIED EVIDENCE → certification doc §C, §E B)* |
| **E. Multiplicity** | | | |
| **GR-S24 Multiset** | n copies of a doomed model → n marks; a repeated application of the same tier never re-marks a marked copy; expiry removes exactly one train per mark; an unmarked same-model train is never removed. Invariant: `pending_rust_trains` ⊆ `owned_trains` (multiset), after every train-moving arm. | CONFIRMED (#1032) + DERIVED | CORRECT for marking/expiry (P8); invariant broken today only by the sale and trade-in holes *(rev 4: RESOLVED — GR-2; invariant CERTIFIED on every board → certification doc §H)* |
| **GR-S25 Coexisting trigger groups** | Several rust-trigger groups (e.g. 2s by a 4, then 3s by a 6) coexist until the corporation's qualifying grace turn and are destroyed together at its destruction point. | DERIVED | CORRECT (P8) |
| **F. Cross-variant, narration, presentation, determinism** | | | |
| **GR-S26 Yellow Sign** | What happens when the Yellow Sign's cheapest-train removal selects a reprieved train. Standalone Gentle Rust does not need the answer; **combined Gentle Rust + Unpredictable Revenue is not fully certified until it is settled.** | **DEFERRED — OD-GR-3 → UR certification** | not probed |
| **GR-S27 Narration** | Rust modal / flourish at destruction, not marking; Activity Log records the marking; no special Gentle Rust modal line; an expiry is never narrated as a limit discard. | CONFIRMED (#1002, #1003, #896, #1099) | CORRECT for purchases and expiry; **WRONG** for a Diesel trade-in under Gentle Rust (narrated "discarded to meet the new limit", limit notice — P9n) *(rev 4: RESOLVED — GR-3 U-6; CERTIFIED EVIDENCE → certification doc §C)* |
| **GR-S28 Presentation** | "Final Run: [type]-trains" badge; chip keeps warning and final-run animation; "(Gently Rusting: N-trains)" beside the limit; countdown labels without pulse; copy distinguishes limit exemption from ownership. | CONFIRMED (#1004, #1033, #1034, animations ruling, SR-1) | labels CORRECT; timing detail/tooltip copy WRONG (U-1…U-3) *(rev 4: RESOLVED — GR-3; certification doc §K)* |
| **GR-S29 Determinism** | Reprieve timing is a function of logged messages and the reducer cursor; no randomness, no client state. | CONFIRMED (#902) / DERIVED | CORRECT |
| **GR-S30 Standard control** | With the flag off, rust destroys at the phase change and nothing is marked. | INHERITED | CORRECT (P1c) |

**Mapping of the owner review's 21 required items:** 1→S2 · 2→S3 · 3→S7 · 4→S8 · 5→S9 · 6→S10 · 7→S11 · 8→S12 ·
9→S13 · 10→S15 · 11→S16 · 12→S18 · 13→S19 · 14→S20 · 15→S21 · 16→S22 · 17→S23 · 18→S24 · 19→S25 · 20→S14 · 21→S26.

**Rev 1 → rev 2 numbering:** S1→S1 · S2→S2/S3 · S3→S4 · S4→S5 · S5→S6 · S6→S7/S8 · S7→S10 · S8→S11 ·
S9→S15/S16/S18/S19 · S10→S17 · S11→S14 · S12→S24 · S13→S25 · S14→S20/S21 · S15→S9/S22/S23 · S16→S27 · S17→S28 ·
S18→S12/S13/S26 · S19→S29.

### 3.3 The forced-purchase / grace-turn sequence (SR-3)

For a corporation whose **only** trains are reprieved:

1. **Start of its qualifying grace turn** — it owns trains; it is not trainless; no emergency-train obligation exists
   merely because the trains are reprieved; they remain usable.
2. **Run Routes** — the reprieved trains may be assigned and run normally and earn ordinary revenue, subject to any
   other variant in force.
3. **Expiry** — at the end of Run Routes (cursor entering Dividends) the reprieved trains are permanently removed
   (fallback: at turn end if Run Routes is never reached, GR-S19).
4. **After removal** — only now does it cease to own them. If it owns no other train, the ordinary no-train /
   forced-purchase authority is evaluated normally at the Buy Trains step; if the §6.6.2 prerequisites hold, the
   normal emergency-purchase path may engage.

If the corporation still owns any **non-reprieved** train, step 4 does not make it trainless and no forced purchase
arises from the expiry.

A self-triggering corporation (GR-S16) necessarily holds the train it just bought, so its own doom event never leaves
it trainless; its old trains follow steps 1–4 in its **next** turn.

*Inherited edge, not Gentle-specific (OBS-1, §7):* without a grid the reducer accepts `PassTurn` at `Track`, which ends
a turn before Run Routes and before any Buy Trains check. If a room also accepts it, a corporation holding only
reprieved trains would lose them to the fallback **after** the turn's last Buy Trains opportunity and meet §6.6.2 at its
next turn — the same exposure a standard-rules trainless corporation has today. It belongs to route / forced-purchase
authority, not to this variant.

### 3.4 Confirmed implementation gaps (need no further ruling)

| id | gap | clause | evidence | class |
|---|---|---|---|---|
| **IG-A** | **Self-trigger timing.** A corporation that dooms its own trains in its Buy Trains step loses them at the end of that same turn (mid-OR, end of set, one-corporation OR). | GR-S16, GR-S19 | P1, P1b, P4-self, P5 | **DEFECT** → *(rev 4)* **RESOLVED** (GR-1 `0ca01be`) / CERTIFIED EVIDENCE → certification doc §C GR-S16/S19, §E H |
| **IG-B** | **Sale / transfer hole.** A reprieved train can be sold; it becomes an ordinary permanent train at the buyer; the seller's mark is orphaned. | GR-S12, GR-S3, GR-S24 | P6 | **DEFECT** (OD-GR-1) → *(rev 4)* **RESOLVED** (GR-2 `b755a7b`) / CERTIFIED EVIDENCE → certification doc §C GR-S12, §E F |
| **IG-C** | **Diesel trade-in hole.** A reprieved 4 can be exchanged; the mark is orphaned; the 4 enters the Bank Pool and is buyable in phase D. | GR-S13, GR-S3, GR-S6, GR-S24 | P9 | **DEFECT** (OD-GR-2) → *(rev 4)* **RESOLVED** (GR-2 `b755a7b`) / CERTIFIED EVIDENCE → certification doc §C GR-S13, §E G, §G |
| **IG-D** | **Ownership vs capacity invariant.** No path conflates them today: every trainlessness reader uses raw `owned_trains`, and `countableTrainCount` appears only in capacity contexts (§5). Nothing pins that separation. | GR-S9, GR-S22, GR-S23 | §5 predicate audit; `trainLifecycle.test.ts:192–197` (one unit case) | **CORRECT BUT UNDERTESTED / MUST PIN** → *(rev 4)* **PINNED** / CERTIFIED EVIDENCE (mutation-verified) → certification doc §E A/B/E |
| **IG-E** | **Route behaviour.** Correct by construction; no behavioural test uses an actually reprieved train (`routeAuthority.test.ts:314` is titled for one but has none). | GR-S8, GR-S14 | §6 | **CORRECT BUT UNDERTESTED** → *(rev 4)* CERTIFIED EVIDENCE (GR-1 real reprieved route) → certification doc §C |
| **IG-F** | **Player-facing copy / UI.** Chip tooltip "Rusts on NEXT depot purchase!" after rust; Final Run / countdown timing wrong for self-trigger; Diesel trade-in narrated as a limit discard; Rules Reference one sentence; discard UI silent on the reprieved exclusion; nothing says a reprieved train keeps the corporation from being trainless. | GR-S27, GR-S28 | U-1…U-7, U-10 (§7) | **DEFECT (copy/UI)** → *(rev 4)* **RESOLVED** (GR-3 `4f4844a`) / certification doc §K |

---

## 4. Owner rulings — spec review of 2026-09-23

Recorded in substance from the owner's review of rev 1. These are authority level 1 and supersede anything earlier.

**SR-1 — What a reprieved train is.** It remains owned, in the usable fleet, operable during its grace period, answers
"yes" to "does this corporation own a train", prevents trainlessness, does **not** count against the **maximum train
limit**, and is scheduled for mandatory destruction after its one qualifying grace Operating Turn. §3.1 is the
canonical statement; "doesn't count" is never used without naming the train limit.

**SR-2 — Exempt ≠ absent.** Train-limit exemption does not make the train absent, non-owned, or trainless-making for
forced-purchase purposes. The forced-purchase machinery must not reuse the train-limit count as the definition of
owning a train. Load-bearing.

**SR-3 — Purpose and forced-purchase sequence.** One purpose of delayed obsolescence is to buffer a corporation from an
immediate emergency train purchase when its trains rust. A corporation whose only trains are reprieved is not
trainless, is not forced into emergency funding by the exemption, keeps and may operate those trains on its qualifying
grace turn, and becomes potentially trainless only after they are actually destroyed (§3.3).

**SR-4 — One final turn, not one actual run** — accepted as reconstructed (GR-S17).

**SR-5 — Grace-turn timing** — accepted: the grace turn must begin after the doom event; cases A–E as in GR-S15/GR-S16.
The current immediate self-trigger expiry is a **confirmed implementation defect**, not an owner question.

**SR-6 — Destruction point** — end of Run Routes in the qualifying grace turn; end-of-turn cleanup is the fallback and
must not destroy a train newly doomed in that same turn's Buy Trains step. The engine must know whether the current
turn is the train's qualifying grace turn (implementation requirement; not solved here).

### SR-7 (a) · OD-GR-1 — DECIDED: no sale or transfer

> A pending-rust / reprieved train **may not be sold or otherwise transferred to another corporation.** Its Gentle Rust
> reprieve belongs to the corporation that owned the train when the rust event occurred. The train remains with that
> corporation through its qualifying grace Operating Turn and is then permanently removed. It may not escape rust by
> changing corporate ownership. The intended implementation is **not** to make a rust marker follow the train to
> another corporation.

Rationale recorded: pending rust is represented on the corporation and by train model, not by globally unique train
identity; allowing sale while dropping the mark is an obvious rust-evasion loophole (P6 demonstrates it); transferring
the doom state would add identity/ownership complexity for no gain; the variant grants the current corporation a
temporary grace period, not renewed train life through a transaction. **The prohibition is specific** — the train is
not "inactive" or "not a real train"; it remains owned and operable and simply cannot be transferred.

*Rev-1 evidence retained (P6):* PRR buys the first 4 in phase 3; NYC (same president) holds marked 2s; PRR buys a
marked 2 for $1. `trainSaleRefusal` answers `null`, `settleTrainSale` moves the model and leaves the mark with the
seller; the bought 2 survives phases 5, 6 and D.

### SR-7 (b) · OD-GR-2 — DECIDED: no Diesel trade-in

> A pending-rust / reprieved train **may not be used as a Diesel trade-in.** In the currently relevant case a
> doomed/reprieved 4-train cannot be exchanged toward the $800 Diesel purchase. Ordinary **non-reprieved** eligible 4-,
> 5- and 6-trains keep their normal trade-in behaviour. A reprieved train therefore provides no trade-in credit, does
> not enter the Bank Pool through a Diesel trade-in, and does not become purchasable again after its rust tier is
> obsolete. It remains with its corporation until Gentle Rust expiry removes it.

Again a **specific** transaction prohibition — not a claim that the train is no longer owned or usable. (The LPF
trade-in price, $750, is the same exchange and is covered by the same prohibition.)

*Rev-1 evidence retained (P9):* after the first D, a marked 4 was accepted by `exchangeableTrains` /
`dieselExchangeRefusal`, returned to the Bank Pool with its mark orphaned, and bought by NYC in phase D. The window is
the self-triggering corporation's own Buy Trains step (a marked 4 of any other corporation dies before that
corporation's next Buy Trains); after GR-1 it is still only that step.

### SR-7 (c) · Common principle for OD-GR-1 / OD-GR-2

Once a train enters Gentle Rust reprieve it **remains an owned, operable train**; it is **exempt from the maximum
train-limit count**; it is **scheduled for mandatory destruction** after its grace turn; and it **may not escape or
monetize that destruction** by being transferred to another corporation or exchanged as a Diesel trade-in.

### SR-8 · Excess-train discard — preserved, no ruling needed

A reprieved train is not an excess-discard candidate because it does not count against the maximum train limit; the
obligation is computed on countable trains only. The corporation owns the train — it simply does not consume a slot.
Current authority refuses a `DiscardTrain` of a reprieved train (P7) — **conforming**.

### SR-9 · OD-GR-3 — DEFERRED to Unpredictable Revenue certification

**Question.** What happens when the Yellow Sign's cheapest-train removal (`yellowSign.ts:141`, "the cheapest the
corporation holds, by depot price", with a `markPayout`) selects a train already under Gentle Rust reprieve?

**Not prejudged.** This is a cross-variant interaction. The standalone Gentle Rust core does not require the answer;
**combined Gentle Rust + Unpredictable Revenue behaviour is not fully certified until OD-GR-3 is settled**, and UR
certification must close it explicitly. Rev-1 notes (by reading, not probed): the Mark would remove the model and pay,
leaving the mark orphaned until the Dividends-entry expiry. The GR-S24 invariant and OD-GR-1's "no escape from rust"
principle are inputs to that decision, not answers to it.

---

## 5. Implementation map

`sS` = `frontend/src/gameEngine/sandboxSession.ts`. Line numbers at `c4d3b5d`.

*(rev 4: this map is the audit-time snapshot. Its WRONG marks were resolved by GR-1 / GR-2 / GR-3; the current train-moving-arm inventory, with line numbers at `4f4844a`, is certification doc §H.)*

| concern | owner (file:line) | mark |
|---|---|---|
| variant resolution | `gameVariants.ts:690–722` `resolveVariants`; `:658` default; `:672` badge | CORRECT BY SPEC |
| variant field doc | `gameVariants.ts:490–494` | STALE COMMENT (#906 mechanism + turn-end timing) |
| rust trigger | `sS:1107` `applyPhaseChange`, called from `buyDepotTrain` `sS:1776`, the emergency path, `ExchangeTrainForDiesel` `sS:5620–5645` | CORRECT BY SPEC |
| mark creation / no re-mark | `sS:1186–1241` (#1032 multiset walk, #979 mark, append) | CORRECT BY SPEC |
| mark field write / #232 absent-vs-empty | `sS:1257–1289` | CORRECT; comment `sS:1264–1267` STALE |
| Bank Pool rust | `sS:1323–1330` | CORRECT BY SPEC |
| state field | `gameState.ts:211–218` `pending_rust_trains?: readonly string[]` (per corporation, by model) | PARTIAL — no provenance, so the fallback cannot tell a mark owed this turn from one created this turn (GR-S19); doc STALE |
| **train-limit capacity** | `trainLimit.ts:132` `countableTrainCount`; callers `trainPurchaseGate.ts:132`, `trainSaleAuthority.ts:133` (buyer's limit), `derivedActions.ts:429` and `App.tsx:10941` (Buy-Trains auto-skip at the limit), `trainDiscard.ts:91/106` (excess), `TrainPurchasePanel.tsx:376`, `TrainBadges.tsx:956`, `ContextualActionBar.tsx:2303` (displays) | CORRECT BY SPEC — **every use is a capacity question** |
| **owns-a-train / trainlessness** | reducer: `trainAvailability.ts:118–127` `trainObligationFor` (`owned_trains.length > 0` → no obligation); `emergencyFunding.ts:255` (asks `trainObligationFor`); `routeAuthority.ts:582` (`owned_trains.length`); `dividendSplit.ts:80` (`ownsTrain` = raw length); `earnableRevenue.ts:64–67` (raw `ownedTrains`). Shell: `App.tsx:1515` `ownsAnyTrain`, `:1520` `trainlessAndReported` → `:1900` `mustBuyTrain` / `utils/trainObligation.ts:43` / End-Turn gate `ContextualActionBar.tsx:1985` (#293); `App.tsx:4455` route draft guard | **CORRECT BUT UNDERTESTED / MUST PIN** — no reader uses the capacity count; only `trainLifecycle.test.ts:192–197` pins one of them |
| `trimToTrainLimit` | `trainLimit.ts:275` — **no production caller since #1530** (tests only) | dead helper; its tests do not guard the live rule |
| discard obligation / choices | `trainDiscard.ts:91` `countableTrainsOf`, `:106` `excessTrainCount`, `:114` `pendingTrainDiscards`, `:156` `discardTrainRefusal`; gate `sS:3290` | CORRECT BY SPEC |
| roster / route planner | `App.tsx:1552` `ownedTrainRoster` (reads `owned_trains`); `routeAuthority.ts` `evaluateRouteSet` (trains checked against `owned_trains`) | CORRECT; UNTESTED behaviourally (IG-E) |
| run obligation / skip | `routeAuthority.ts:571` `routeSkipRefusal` (Routes step only) | INHERITED; OBS-1 |
| purchase from depot / pool | `sS:1725` `buyDepotTrain`, `sS:1807` `buyReturnedTrain`, `sS:1787` `returnedTrainRefusal` | CORRECT; pool polluted only via IG-C |
| **intercorporate sale** | `trainSaleAuthority.ts:76` `trainSaleRefusal` (proposal / answer / settlement); `sS:1829` `settleTrainSale` | **WRONG under OD-GR-1** (IG-B) — must refuse a reprieved copy at all three moments (multiset-aware: a live copy of the same model stays saleable) |
| **Diesel trade-in** | `dieselExchange.ts:56` `exchangeableTrains`, `dieselExchangeRefusal`; arm `sS:5620–5645` | **WRONG under OD-GR-2** (IG-C) — must exclude reprieved copies (multiset-aware); doc `:54–55` STALE |
| expiry — Dividends entry | `sS:4127–4130` (`enteringDividends`, acting corporation) | CORRECT BY SPEC |
| expiry — turn change (fallback) | `sS:3985` (`turnChanged`, outgoing corporation) | **WRONG for self-trigger** (IG-A); CORRECT for marks whose grace turn it is |
| expiry — leaving the OR (set end) | `sS:3893` (outgoing corporation) | **WRONG for self-trigger** (IG-A); CORRECT otherwise |
| expiry helper | `sS:3832–3888` `expireReprieveFor` (multiset removal, marks → `[]`) | CORRECT BY SPEC for a corporation whose grace turn it is |
| narration: marking | `sS:1624–1678` gentle branch of `describeFleetLosses` | CORRECT for purchases; **WRONG** for Diesel trade-in (`sS:1668–1670`) |
| narration: expiry | `sS:1460` `expiredReprieves`, `sS:1495` `describeReprieveExpiries` | CORRECT BY SPEC |
| modal / flourish | `App.tsx:7770–7960` (`:7843` rust notice deferred under Gentle Rust; expiry block `:7898`) | CORRECT; comments `:2401–2402`, `:7836–7838`, `:7889` STALE |
| awards / statistics | `gameHistory.ts:511–545` | CORRECT (one loss per train, recorded at marking) — U-9 *(rev 5: superseded by the owner's U-9 ruling — destruction-time accounting, #1704)* |
| Rules Reference | `RulesReference.tsx:663` | PARTIAL (one sentence) — U-4 |
| Lobby / Waiting Room / host card | `gameVariants.ts:260–263`; `Lobby.tsx:1410–1417`; `SandboxWaitingRoom.tsx:84–88`; `HostSetupCard.tsx:72, 486`; `LobbyRoomList.tsx:48` | CORRECT BY SPEC (#982) |
| final-run badge / limit line | `ContextualActionBar.tsx:2303–2330`, `:3090–3130`, `:3262–3295` | labels CORRECT; detail text WRONG after a self-trigger (U-2) |
| chips / capacity pill | `TrainBadges.tsx:490–510`, `:586–588`, `:214–224` `rustTooltip`, `:928–980` | chip tooltip WRONG (U-1); pill CORRECT |
| countdown warnings | `purchaseWarnings.ts:216–345` | labels CORRECT; detail WRONG for the buyer's own trains (U-3); `:339` limit detail (U-7); comment `:341–345` STALE |

---

## 6. Test-coverage matrix

*(rev 4: every gap in this matrix is closed by behavioural evidence — certification doc §C; the dead-helper trim rows are relabelled and retargeted, §N.)*

Focused suites run read-only at `c4d3b5d` in rev 1: 23 suites / 530 tests, all green. Green includes the tests that pin
the self-trigger behaviour. Kind: **B** behavioural through the reducer · **U** unit on a helper · **S** source scan.

| clause | covered by | kind | fails on regression? | gap |
|---|---|---|---|---|
| S1 flag | `gameVariants.test.ts:75–95`, `variantWiring.test.ts:229–246` | U | yes | — |
| S2/S5 marking, S30 control | `variantRules.test.ts:322–378`, `gentleRustLimit.test.ts:147–183`, `trainRustFlourish.test.ts:214+` | U (`applyPhaseChange` direct) | yes | no test drives a real purchase that marks |
| S6 pool rust | `dieselExchange.test.ts:183–191`, `rustCashNeutrality.test.ts` | B | yes | — |
| S7/S8 owned & operable | `gentleRustLimit.test.ts:235–250` (S: roster reads `owned_trains`) | S | only against the roster string | **IG-E** — no run with a reprieved train |
| **S9 prevents trainlessness** | `trainLifecycle.test.ts:192–197` (`trainObligationFor` with `[2]{2}` → not owed) | U | yes for that helper | **IG-D** — emergency funding, End-Turn gate, dividend/earnable readers unpinned; no helper-conflation guard |
| S10 limit capacity | `gentleRustExemption.test.ts`, `batch37.test.ts:52+`, `batch59` (S) | U + S | yes for the helper | purchase gate / auto-skip exemption not driven through a message |
| S11 discard | `variantRules.test.ts:394–470` (`pendingTrainDiscards`, e.g. `:443`) | U | yes | no `DiscardTrain` of a reprieved model (P7 is the first) |
| trim helper | `gentleRustLimit.test.ts:40–145`, `gentleRustExemption.test.ts:85–136` | U | only for a **dead** helper | retire / retarget |
| **S12 no sale** | none | — | — | **gap** (IG-B) |
| **S13 no trade-in** | `dieselExchange.test.ts:119–126` covers only the first-D exchange of a *non-reprieved* 4 | B | — | **gap** (IG-C) |
| S14 revenue | `routeAuthority.test.ts:314` is titled "ghost and reprieved trains …" but has **no reprieved train** | — | no | **gap** (route + revenue + UR + DSM) |
| S15 (A) same-OR | `batch28.test.ts:95–172` (pre-set marks, cursor `Routes`) | B | yes | not from a real trigger |
| S15 (B) next-OR | none | — | — | **gap** (P3 is the first) |
| **S16 self-trigger** | none assert survival; `variantRules.test.ts:517–533` (no sub-phase) and `rustCashNeutrality.test.ts:194–212` (at `Hardware`) pin the fallback removal of the outgoing corporation's marks without saying where the marks came from | B | may fail on a correct fix unless their fixtures are re-read (a mark whose grace turn it is should keep today's answer) | **gap + pins the defect's shape** |
| S15 (D) end-of-set | `variantRules.test.ts:476–515` (`endOfSet`, pre-set marks) | B | yes | no Stock Round survival from a real trigger |
| S15 (E) single corp | same (#906a) | B | yes | self-trigger variant missing |
| S17 turn not run | `batch28.test.ts` (Advance into Dividends, revenue 0) | B | partly | no "no legal route" / "turn ended early" case |
| S18 destruction point | `batch28.test.ts:95–200` | B | yes | — |
| S19 fallback scope | `batch28.test.ts:175–183` (S: both call sites exist) | S | no | **gap** — no case distinguishing a qualifying-turn mark from a same-turn mark |
| S20/S21 destruction | `variantRules`, `batch28`, `rustCashNeutrality` case 5 | B | yes | no "not pooled / not buyable" assertion |
| S22/S23 trainless after | none end-to-end | — | — | **gap** (IG-D) |
| S24 multiset | `variantRules.test.ts:495–516`, `batch37.test.ts:105–130`, `trainRustFlourish.test.ts:245–285` | B/U | yes | invariant not asserted after sale / exchange |
| S25 coexisting groups | none | — | — | **gap** (P8 is the first) |
| S27 narration | `batch64`, `batch28.test.ts:200–315`, `fleetLossNotice.test.ts:170–186`, `trainRustFlourish` | U + S | yes | trade-in narration untested (and wrong) |
| S28 presentation | `batch35`, `batch28.test.ts:318–430`, `gentleRustExemption.test.ts:220–290`, `warningMarks.test.tsx:293–331` | S | only against string edits | detail/tooltip content untested |
| S29 replay | `variantWiring`, generic replay suites | U | yes | no Gentle Rust replay case (§8) |

---

## 7. UI / player-visibility map

| question | answer today |
|---|---|
| Which train is reprieved? | **Yes** — every `TrainChips` surface fades/pulses the marked copy (multiset-correct); "Final Run: 2-trains" badge for the operating corporation; "(Gently Rusting: 2-trains)" on its limit line. |
| When will it disappear? | **Partly and partly wrongly** — U-1/U-2/U-3. Non-operating corporations show only the chip, whose tooltip is wrong. |
| Does it count against the limit? | Correctly **no** (#1034): limit-line tooltip, parenthetical, capacity pill "N on a final run under Gentle Rust and not counted". |
| Is the corporation still "with trains"? | Behaviour is right (End Turn is not blocked, no "must buy a train" prompt while reprieved trains exist), but **nothing says so** (U-10). |
| Over-limit vs scheduled-to-rust distinguished? | Discard prompt offers only countable trains (right) but does not explain the exclusion (U-5). |
| Modal at destruction? | **Yes** (#1002), tutorial-gated (VF-7); wrong *limit* notice after a Diesel trade-in (U-6). |
| Rules Reference complete? | **No** — one sentence (U-4). |

Required polish / fixes (not designed here):

* **U-1** `TrainBadges.tsx:224` — a reprieved chip's tooltip is "CRITICAL: Rusts on NEXT depot purchase!"; it has already
  rusted and dies at its corporation's qualifying grace turn's Run Routes.
* **U-2** `ContextualActionBar.tsx:2326–2327` — "destroyed at the end of this turn's Run Routes step" is false for the
  phase-changing corporation's own trains in the rest of that Buy Trains step (after GR-1: its next turn's Run Routes).
* **U-3** `purchaseWarnings.ts:293–294` — "destroyed at the end of their corporation's next Run Routes step" is false today
  for the purchaser's own trains; true after GR-1.
* **U-4** `RulesReference.tsx:663` — the complete rule in player language: trigger and which trains; the grace turn (all
  cases incl. self-trigger); turn-not-run; limit exemption **and** that reprieved trains still count as the
  corporation's trains (no forced purchase until they are gone); discard exclusion; no sale; no Diesel trade-in; pool
  rust.
* **U-5** discard prompt — Final Run trains occupy no slot and are not choices.
* **U-6** Diesel trade-in under Gentle Rust narrated "discarded to meet the new limit" + limit notice (`sS:1668–1670`;
  standard tables mislabel the same event "rusted", `sS:1673` — out of Gentle Rust scope, same root). *(rev 3: routed
  out of GR-2 and **completed in GR-3** — the narrator splices the traded model out of the diff; both halves fixed.)*
* **U-7** `purchaseWarnings.ts:339` — "Anything held above N is discarded" → add "(Final Run trains excepted)".
* **U-8** VISUAL_FLOURISH K-1 (final-run badge takes the rust mark) — existing owner item; unchanged. *(rev 3: still
  that item; not handled in GR-3.)*
* **U-9** statistics record the loss at marking; a game ending before an expiry counts a loss never suffered.
  Cosmetic; state it or accept. *(rev 3: unchanged by GR-3; carried to GR-4 / final certification for explicit
  disposition.)* *(rev 4: GR-4 classified **B — cosmetically imprecise but acceptable, with a documented definition**:
  counted once, at the rust event; certification doc §L.)* *(rev 5: that classification is **withdrawn** — #1414 / #1422
  define a lost train as one that actually left the roster. **OWNER RULING: destruction-time accounting**; implemented in
  `gameHistory.ts` (#1704): loss at the destruction, charged to the president then, credited to the purchaser who brought in
  the rusting tier; a Final Run train still owned at game end is kept. **RESOLVED.**)*
* **U-10** *(rev 2)* say where a player looks for it that Final Run trains keep the corporation from being trainless
  (limit tooltip / Rules Reference), so "exempt" is never read as "gone".
* **U-11** *(rev 2)* sale and Diesel-exchange surfaces must grey reprieved copies with the reason once GR-2 refuses them
  (the train-offer UI and the exchange panel ask the same authorities).

*(rev 3)* **U-1 … U-5, U-7, U-10, U-11 completed in GR-3** (#1702), together with the two DT-1 UI follow-ups (the
"Pay $X and End Turn" promise withheld where a legal trade-in may follow; the Diesel exchange row priced from
`dieselExchangeCostFor`, so $750 under the Level Playing Field). U-3's "next Run Routes" wording was re-audited against
real purchases and **kept** (true after GR-1); only its subject was narrowed ("a corporation owns", Bank Pool named).

**OBS-1 (out of scope — route / forced-purchase authority):** without a grid, `PassTurn` at `Track` ends the turn (P5b);
`routeSkipRefusal` guards the Routes step only and `trainObligationRefusal` the Hardware step only. Whether a room
accepts ending a turn before Run Routes — for any corporation, trainless or not — should be confirmed by the owner of
that authority. Gentle Rust only inherits it through the fallback (§3.3).

---

## 8. Corpus characterization (read-only)

18 files / 12 rooms (Batch 7.5 enumeration). `gentleRust`: **true in 1 file** — `frontend/sandbox-log-JUNO-3XD.json`
(with `unpredictableRevenue` + `dynamicStockMarket`; captured 2026-09-05, legacy/unpinned). `false` in 16; absent in
`sandbox-log-JUNO-Y8V.json` (→ false). No file stores `pending_rust_trains`.

**Under today's engine** (`DEVELOPMENT_CORPUS_POLICY`) JUNO-3XD parts from its played game early (only 5 of 29 runs
reproduce their `revenue_turn`) and **never leaves phase 2** — no phase change, mark or expiry. The corpus exercises
**none** of the Gentle Rust paths under the current reducer.

**The live game, read from its recorded messages** (inference; played on the pre-#1034/#1102 build):

| scenario | seen live? | evidence |
|---|---|---|
| first 4 bought by a corporation holding no 2s | yes | C&O (5) bought two 4s at 169/170 in OR 5.1; ran `[4,4]` at 195 |
| not yet operated (A) | yes | NNH (7) ran `[2,2,3]` at 175, same OR; `[3,4]` next OR |
| already operated (B) | yes | B&O (4) ran `[2,3,3]` at 182 (OR 5.2); PRR (1) ran `[2,2,3,3]` at 189 |
| a reprieve lasting more than one turn | yes — a live-engine defect | PRR still ran `[2,2,3]` at 246 (OR 6.1.1) |
| self-trigger / end-of-set / single-corp | no | — |
| multiple marked trains | yes | PRR, NNH two 2s each |
| multiple phase changes before a next turn | no rusting pair | — |
| excess discard with reprieves | not determinable | — |
| sale / trade-in of a reprieved train | no | — |
| only-reprieved-trains corporation / forced purchase after expiry | not determinable from messages | — |
| reprieve expiry | yes | 2s vanish from later runs |

Characterization only; the live game is not evidence that current behaviour is right.

---

## 9. Replay / version impact

* Travel: host choice → `SetupGame.variants` (whole object, `gameServer.ts:460/521/737`) → `resolveVariants` (absent =
  false) → every dispatch runs under `withRules(resolveVariants(state.variants))` → replay reads the same deal.
  `RoomSession.submit` stamps `rules_engine_version`. No client state, no randomness (GR-S29); `false` reproduces
  standard rust (GR-S30).
* **`RULES_ENGINE_VERSION` stays 8** in this pass. *(rev 4: GR-4 confirms the 8 → 9 set exactly — GR-1 timing, GR-2 sale refusal, GR-2 trade-in refusal, DT-1 auto-skip; GR-3 and GR-4 replay-neutral; certification doc §N.)* *(rev 6: **bumped 8 → 9 by GR-5**, #1705 — changelog row 9 carries exactly those four, with GR-3, GR-4 and the U-9 statistics correction named after a NOT RULES marker; a v8-pinned room is held `incompatible`, never migrated; the unpinned corpus replays unchanged, 18/18 — certification doc §P.)*
* **Likely replay-semantic changes requiring a later deliberate 8 → 9 closure boundary:** self-trigger grace timing
  (IG-A); reprieved-train sale refusal (IG-B); reprieved-train Diesel trade-in refusal (IG-C); a forced-purchase fix
  **only if** the implementation audit finds the current engine actually wrong (today: no conflation found, IG-D).
  **Plus one adjacent base-game correction for the same boundary (DT-1, #1701, not Gentle Rust):** Hardware auto-skip
  no longer ends a corporation's turn at the train limit while a legal one-for-one Diesel exchange remains available
  (corpus-neutral: no stored board reaches it).
* **Replay-neutral:** UI / copy / narration (IG-F), stale comments (Appendix B), new tests and the constructed fixture.
  *(rev 3: GR-3 — the UI / copy / narration slice — is **not** part of the semantic 8 → 9 list; its 18-file corpus
  check is state / grid / cursor-identical. The v9 candidates remain GR-1's timing, GR-2's sale and trade-in
  restrictions, and DT-1's auto-skip correction.)*
* **Not prejudged:** corpus divergence is measured during implementation / certification (the one Gentle Rust log
  never reaches phase 4 under today's engine, so a digest move is not expected — but it is measured, not assumed).
  Pinned v8 Gentle Rust games outside the repository: unknown.

---

## 10. Implementation slices (rev 2; status at rev 3)

**Status (rev 6, 2026-09-24):** **GR-1, GR-2, DT-1, GR-3 and GR-4 COMPLETE** — owner-gated and committed (`0ca01be`, `b755a7b`, `936bacc`, `4f4844a`, `c202621`). **GR-5 COMPLETE** (the 8 → 9 boundary and closure, #1705; awaiting the owner's full-suite gate and commit). **Standalone Gentle Rust is CERTIFIED at `RULES_ENGINE_VERSION` 9.** OD-GR-3 → Unpredictable Revenue certification; Gentle Rust + Unpredictable Revenue is not certified.

**Status (rev 5, 2026-09-24):** GR-3 owner-gated and committed (`4f4844a`). **GR-4 COMPLETE pending owner gate** — tests and documents (#1703) plus the owner-ruled U-9 statistics correction in derived history (#1704); evidence → `VARIANT_CERT_GENTLE_RUST_CERTIFICATION_2026-09-24.md` (r2). **GR-5 pending.** Gentle Rust is NOT certified.

**Status (rev 4, 2026-09-24):** GR-3 owner-gated and committed (`4f4844a`). **GR-4 COMPLETE pending owner gate** (tests and documents only, #1703; evidence → `VARIANT_CERT_GENTLE_RUST_CERTIFICATION_2026-09-24.md`). **GR-5 pending.** Gentle Rust is NOT certified.

**Status (rev 3, 2026-09-24):** **GR-1 COMPLETE** — owner-gated, committed (`0ca01be`). **GR-2 COMPLETE** — owner-gated,
committed (`b755a7b`). **DT-1** (adjacent base-game auto-skip fix, #1701) **COMPLETE** — owner-gated, committed
(`936bacc`). **GR-3 COMPLETE pending owner gate** (#1702, uncommitted at this revision). **GR-4 pending. GR-5 pending.**
OD-GR-3 still routed to Unpredictable Revenue. Routing changes: U-6 moved from GR-2 to GR-3 and is done there; U-9 goes
to GR-4 / final certification; U-8 stays VISUAL_FLOURISH K-1. **Gentle Rust is NOT certified.**

| slice | scope | model | time | replay risk |
|---|---|---|---|---|
| **GR-1 — grace timing + ownership / trainlessness authority** | fix self-trigger timing (IG-A); represent or derive whether a reprieve's qualifying grace turn has begun, so the Dividends-entry expiry and both fallbacks act only in that turn; keep reprieved trains owned and operable; keep the capacity exemption; protect forced-purchase / trainlessness semantics explicitly (IG-D: one named ownership predicate, never the capacity count); atomic expiry; correct the #906/#906a/#1001 comments and `gameState` doc | Opus 5.5 Extra preferred | ~2–3 h | **HIGH — replay-semantic** |
| **GR-2 — transaction locks** | refuse sale / transfer of reprieved trains at proposal, answer and settlement (IG-B); refuse Diesel trade-in of reprieved trains (IG-C), multiset-aware so live copies stay tradeable; prove no transaction clears, moves, duplicates or launders a mark (sub-multiset invariant after every train-moving arm); prove excess-discard behaviour unchanged; U-6 narration splice for `ExchangeTrainForDiesel` *(rev 3: moved to GR-3)* | Opus 5.5 High or Extra | ~1.5–2.5 h | **HIGH — replay-semantic** |
| **GR-3 — UI / Rules Reference / narration** | Final Run / tooltip timing (U-1…U-3); train-limit explanation (U-7); forced-purchase distinction (U-10); complete Rules Reference (U-4); discard exclusion (U-5); sale / exchange greying (U-11); rust modal / badge parity; stale comments and copy (Appendix B) | Opus 5.5 High | ~1–2 h | none expected |
| **GR-4 — certification test matrix + constructed legal game** | every §3 clause behaviourally; cases A–E and self-trigger; only-reprieved forced-purchase protection; ordinary + reprieved negative control; multiset; coexisting groups; sale refusal; trade-in refusal; excess discard; route / revenue with actual reprieved trains; LPF / 18XX+ where relevant; retire or retarget the dead-helper trim tests; corpus reconciliation; a constructed legal progression reaching rust triggers in phases 4, 6 and D with stated provenance | Opus 5.5 Extra preferred | ~2–3 h | measurement / certification |
| **GR-5 — deliberate rules-engine version bump** | only after GR-1…GR-4 prove the final semantics and corpus reconciliation confirms the exact boundary; expected `RULES_ENGINE_VERSION` 8 → 9 (self-trigger timing, sale rule, trade-in rule) | Opus 5.5 High | ~30–60 min | the bump itself |

OD-GR-3 is carried into Unpredictable Revenue certification, not these slices.

---

## 11. Certification criteria and required test invariants

### Required test invariants (to be written in GR-4; driven through real messages on pinned boards)

*(rev 4: written and green — certification doc §E.)*

* **A — Only reprieved trains.** Corporation owns only reprieved trains → "has a train" is true; the train-limit count
  excludes them; no forced / emergency purchase merely because all trains are reprieved; the trains are routeable
  during the grace turn.
* **B — Expiry of the last reprieved train.** Same corporation, after its grace turn's Run Routes → trains and marks
  removed; the corporation is now genuinely trainless; at Buy Trains the ordinary forced-purchase authority is
  evaluated; if its prerequisites hold, the normal emergency path may engage.
* **C — Ordinary + reprieved.** After the reprieved train expires the ordinary train remains; the corporation is not
  trainless; no forced purchase arises from the expiry.
* **D — Limit capacity.** A reprieved train occupies no train-limit slot and cannot create an excess-discard obligation
  merely by existing.
* **E — No helper conflation.** Pin that any helper used for maximum train-limit capacity is **not** reused as the
  definition of "corporation currently owns a train" for trainlessness / forced-purchase authority (all readers in §5's
  ownership row).
* **F — Sale.** Attempting to sell a reprieved train is **refused atomically** (no money, train or mark moves), at
  proposal, answer and settlement; a live copy of the same model remains saleable.
* **G — Diesel trade-in.** Attempting to trade a reprieved 4 for a Diesel is **refused atomically**; a live 4/5/6 still
  trades normally.
* **H — Self-trigger.** A corporation buys the phase-changing train in its own Buy Trains step → the newly doomed old
  train survives turn end (and the Stock Round if the set ends), survives into its next future Operating Turn, remains
  owned, remains non-counting for the limit, remains enough to prevent trainlessness before its actual expiry, and is
  destroyed at that turn's end of Run Routes.

Plus the clause coverage of §6 (every gap closed), with a standard-mode negative control for each semantic case.

### Certification gate

*(rev 6, GR-5 — status per item; lettered sections are the certification doc's: 1 MET (backlog Part D D-34, D-35, D-36); 2 MET (29 clauses CERTIFIED behaviourally,
GR-S26 DEFERRED BY SPEC — certification doc §C); 3 MET (§E, §F); 4 MET (§H); 5 MET (§G, game G5); 6 MET (§K; Appendix B
corrected or kept as history per its rev-3 status, item 15 routed to UR with OD-GR-3); 7 MET (18-file sweep 0 differences at v8 and again across the 8 → 9 boundary; the constructed game replays
deterministically; `RULES_ENGINE_VERSION` bumped exactly once, 8 → 9, #1705 — certification doc §G.4, §M, §P); 8 — the
owner's full Jest run and build at the certification commit (GR-5 ran the focused set, both typechecks and the production
build, §P).)*

1. OD-GR-1 and OD-GR-2 recorded as rulings in the backlog's Part D; OD-GR-3 recorded as deferred to UR.
2. Every §3 clause (except GR-S26) CORRECT BY SPEC, each proved by a behavioural test; source scans only as secondary
   guards.
3. Invariants A–H green; probes P1–P9 reproduced as tests with the spec's outcomes.
4. `pending_rust_trains` ⊆ `owned_trains` (multiset) after every train-moving arm.
5. No doomed-model train can exist after its grace turn (no permanent 2/3/4; none in the Bank Pool after its phase).
6. U-1 … U-11 resolved; the Rules Reference states the complete rule; Appendix B cleared or marked historical.
7. Replay: 18-file corpus digest sweep run and every difference explained; the constructed Gentle Rust game replays
   deterministically twice; `RULES_ENGINE_VERSION` bumped exactly once for the semantic slices.
8. Full Jest and build green at the certification commit.

---

## Appendix A — probe evidence (rev 1, unchanged)

*(rev 4: every probe below is reproduced by a durable repository test with the specification's current outcome — certification doc §F. The scratch harness is no longer the evidence for any clause.)*

Scratch harness outside the repository (`$HOME/grscratch`): the engine compiled with `server/tsconfig.json` to a scratch
`outDir`, boards built as in `rustCashNeutrality.test.ts` plus `rules_engine_version: 8` (pinned), messages dispatched
through `applySandboxAction` with the president as actor. Notation `CORP:[fleet]{marks}`.

**P1 — self-trigger (mid-OR, pinned v8).**
```
start  PRR@Hardware  PRR:[2,2,3]{}  NYC:[2,2,3,3]{}  B&O:[2,2,3,3]{}
PRR BuyHardwareFromPool      -> phase 4 limit 3 | PRR:[2,2,3,4]{2,2}  NYC:[2,2,3,3]{2,2}  B&O:[2,2,3,3]{2,2}
PRR PassTurn                 -> NYC@Track       | PRR:[3,4]{}        NYC:[2,2,3,3]{2,2}  ...
NYC Advance x3 (to Dividends)-> NYC:[3,3]{}
```
PRR's 2s die at the end of the turn in which they were marked, with no post-rust turn. Same on an unpinned board (P1b).
Standard control (P1c): all 2s destroyed at the purchase.

**P3 — already operated.** Order PRR, NYC, B&O, C&O; NYC (index 1) buys the first 4. PRR keeps `{2,2}` through NYC's,
B&O's and C&O's turns and the OR1→OR2 transition, and loses them on entering Dividends in OR2. CORRECT.

**P4 — end-of-set.** C&O (last, last OR) buys the first 4: PRR/NYC/B&O marks survive into the Stock Round and each
expires at its own Dividends entry in the next set. CORRECT. **P4-self:** C&O holding `[2,3,3]` → `C&O:[3,3,4]{}` in
the Stock Round — its own 2 died at set end. WRONG.

**P5 — single-corporation OR.** PRR alone buys the first 4 (pool 2s scrapped at once): PRR's 2s die at the OR1→OR2
transition. WRONG (self-trigger). **P5b:** pre-existing mark, turn ended at `Track` on the last OR → removed on the way
into the Stock Round (fallback). CORRECT.

**P6 — sale of a marked train.**
```
PRR buys first 4            -> PRR:[2,2,3,4]{2,2}  NYC:[2,2,3]{2,2}
trainSaleRefusal(PRR<-NYC "2", $1) = null
BuyTrainFromCorporation     -> PRR:[2,2,3,4,2]{2,2}  NYC:[2,3]{2,2}
PRR PassTurn                -> PRR:[3,4,2]{}
NYC to Dividends            -> NYC:[3]{}
applyPhaseChange "5", "6"   -> PRR:[3,4,2]{3}   (the 2 is never doomed again)
```

**P7 — excess discard with a mark.** Phase 4, `PRR:[2,3,4,4]{2}` (countable 3), NYC buys the first 5 (limit 2): owed
`PRR x1 choices[3,4,4]`; `DiscardTrain` of the marked 2 refused by identity; discarding a 3 → pool `[3]`, mark intact.
CORRECT.

**P8 — two phase changes before the next turn.** `PRR:[2,3,5]{2}` in phase 5; NYC buys the first 6 → `{2,3}`;
re-applying 6 or 4 adds nothing (#1032); PRR's Dividends entry → `PRR:[5]{}`. CORRECT.

**P9 — Diesel trade-in of a marked 4.**
```
PRR buys first D            -> phase D limit 2 | PRR:[4,D]{4}  NYC:[4,6]{4} | pool [5,5,5] (pool 4s scrapped)
exchangeableTrains(PRR) = ['4'], dieselExchangeRefusal = null
ExchangeTrainForDiesel "4"  -> PRR:[D,D]{4} | pool [5,5,5,4]
PRR PassTurn                -> PRR:[D,D]{}
NYC to Dividends, Declare   -> NYC:[6]{}
NYC buys returned 4         -> NYC:[6,4]{} in phase D
```
**P9n — narration.** Under Gentle Rust any Diesel trade-in (reprieved or not) is described as
"PRR: its 4-train was discarded to meet the new limit of 2." (a `limit` notice); under standard rules the same event
reads "rusted".

**Corpus probe.** JUNO-3XD replayed under `DEVELOPMENT_CORPUS_POLICY`: 320 applied / 2 dropped, final `StockRound`,
phase 2, `B&O:[2,2]` only — no phase change or mark at any index.

**Rev-2 predicate audit (read-only, no probe).** Every consumer of `countableTrainCount` / `countableTrainsOf` /
`excessTrainCount` was listed (§5 capacity row) and each is a capacity question. Every trainlessness / owns-a-train
reader found (§5 ownership row) reads raw `owned_trains`. No conflation exists at `c4d3b5d`.

---

## Appendix B — stale comments / copy (to fix in GR-1 / GR-3; none edited here)

*(rev 3 status — GR-1 / GR-2 / GR-3 disposition.)* Corrected or supplemented with a superseding note: 1 (GR-3,
rewritten field doc), 2 (GR-1), 3 (GR-2), 4 (GR-1 marker), 5 (GR-1 marker), 6 (GR-3), 8 (GR-3 supplement), 9 (GR-3
supplement), 10 (GR-3 supplement), 11 (GR-3 supplement), 12 (GR-3), and the three player-facing U-1 / U-2 / U-3 strings
(GR-3). Left as history, deliberately: 13 and 14 (test-file comments recording what #979 once said), and 7 (a project
doc outside the repository). 15 is Yellow Sign (#1672) and goes with Unpredictable Revenue certification.

Superseded **#906 mechanism** ("leaves `owned_trains`") or **turn-end timing** stated as current:

1. `gameVariants.ts:490–494` — field doc: moved to `pending_rust_trains`, "leaves `owned_trains`", "scrapped at the end
   of that corporation's turn".
2. `gameState.ts:211–217` — field doc: "NOT IN `owned_trains` … the whole mechanism"; clears "at the end of that
   corporation's next Operating Round turn"; names `settleRoundTransitions` (it is `settleOperatingCursor`).
3. `dieselExchange.ts:54–55` — "A train on its Gentle Rust final run is in `pending_rust_trains`, not `owned_trains`"
   (false, and the premise of IG-C).
4. `sandboxSession.ts:1155–1176` — DN 906 block (mechanism; death "at the end of that corporation's turn") with no
   superseded marker.
5. `sandboxSession.ts:3971–3981` — DN 906a "AND THE REPRIEVE ENDS HERE, WITH THE TURN" (now the fallback, #1102).
6. `App.tsx:2401–2402`, `App.tsx:7889` — expiry "as its cursor enters Buy Trains" (#1001; now Dividends, #1102).
7. Project doc `claude/batch7.4-opus-matrix-review-2026-09-15.md` — "doomed trains leave `owned_trains` at the phase
   change" (outside the repo).

Superseded **#979 limit rule** stated as current:

8. `sandboxSession.ts:4083–4090` — DN 1001 "#979 made a reprieved train count against the limit — correctly".
9. `sandboxSession.ts:1264–1267` — "reprieved trains were all taken by the trim in this very call".
10. `sandboxSession.ts:1646–1653` (and `:1631–1635`) — "under this variant every departure is the limit's … because the
    trim took it" (the trim is gone since #1530; the rule still drives U-6).
11. `App.tsx:7836–7838` — "A train the LIMIT took is gone right now — the trim is not postponed".
12. `purchaseWarnings.ts:341–345` — "a gently-rusted train is the first thing it takes (#979)".
13. `batch35.test.ts:132–135` — same sentence in a test comment.
14. `batch28.test.ts:99–101` — "#979 made a reprieved train count against the limit — correctly".
15. `trainDiscard.ts:44–46` — refers to `expireGhostTrains` at the round boundary (deleted by #1672; Yellow Sign side).

Wrong **timing/detail copy** shown to players: U-1 (`TrainBadges.tsx:224`), U-2 (`ContextualActionBar.tsx:2326–2327`),
U-3 (`purchaseWarnings.ts:293–294`).

Wording to watch in GR-3 (rev 2): any new copy saying a Final Run train "doesn't count" must say "toward the train
limit" (SR-1), so it is never read as "the corporation has no train".

Historical notes that describe the past accurately (e.g. `fleetLossNotice.ts:118–124`, `gentleRustLimit.test.ts:7–26`,
`variantRules.test.ts:355–405`) are **not** stale. Adjacent, not Gentle Rust: `TrainBadges.tsx:601` ("Occupies no
train-limit slot until this Operating Round ends" — superseded by #1672 for Yellow Sign ghosts) → UR certification.
