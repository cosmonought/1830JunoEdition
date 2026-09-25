# Variant Certification 1B — Unpredictable Revenue: UR-7 certification evidence

**2026-09-25 · UR-7 — the 10-C rounding rule and the certification evidence.** One replay-semantic rule change
(OD-UR-10 = 10-C, UR-F20), one narrow presentation fix (UR-N62, the host's Yellow Sign debug chip), the Rules
Reference's tie sentence, and the constructed certification game with its evidence. `RULES_ENGINE_VERSION` is still
**9**. No stored log, golden, fixture, export or corpus file was touched, rewritten or repinned. Nothing committed or
pushed.

This document is **evidence, not specification**. The specification is
`VARIANT_CERT_UNPREDICTABLE_REVENUE_AUDIT_2026-09-24.md` (the owner rulings; §3 clauses UR-N1 … UR-N62; §5.3
invariants R1 – R13; §13.2 interactions X1 – X15; §14 the game's design). Where the two ever disagree, the audit and
the owner rulings it records win.

**Verdict (UR-7): READY FOR THE OWNER'S GATE.** Every owner decision is implemented and evidenced; UR-F20 is fixed;
the constructed game composes the ruled variant, with Gentle Rust, through the server's own path. **Unpredictable
Revenue is NOT yet closed**: the deliberate 9 → 10 boundary and the closure record are UR-8's (§P), and three rows
remain as recorded in §O.

**UR-8 CLOSURE (2026-09-25) — UNPREDICTABLE REVENUE IS CERTIFIED at `RULES_ENGINE_VERSION` 10** — standalone and with
Gentle Rust (OD-GR-3) — subject to the owner's full-suite gate and commit. UR-7 passed the owner's gate and is committed
and pushed (`ff7a04b`). UR-8 took the one deliberate **9 → 10** boundary for the replay semantics UR-3, UR-4 and UR-7
implemented at 9 (changelog row 10 — exactly eight, the audit's §15 list), re-verified every owner decision, measured the
constructed game and the 18-file corpus across the boundary (identical but for the pin), and disposed of S10-21 as
**CLOSED — SUPERSEDED** by the constructed certification game (§Q.4). No gameplay semantics were added. **What this
certifies:** the Unpredictable Revenue variant — **not** every repository backlog item: S10-11, S10-27, U-41, U-43,
OD-UR-9's seed source and the other nonblocking residuals of §Q.8 remain open where they are routed, and Delayed Auction
is still uncertified. Sections A – P are the UR-7 record and are kept as written; where they say "not yet closed" or
"pinned to 9", §Q supersedes them.

---

## A. Baseline

| item | value |
|---|---|
| branch | `main` |
| local HEAD | `cd889cb6be631e51c2d569891f2919feacfdb746` ("Polish Unpredictable Revenue player-facing rules") — **the owner-gated UR-6 baseline** |
| `origin/main` | `0d8157ecc38edeff4da4729b5c5681b0103b4aaa` (UR-5) — **local `main` ahead by 1 expected commit** (UR-6 committed by the previous session, not pushed; the owner confirmed it as the baseline and asked that the discrepancy be left alone) |
| tracked tree at start | clean (only the untracked `.claude/settings.local.json`); no `.git/index.lock` |
| `RULES_ENGINE_VERSION` | `9` (`frontend/src/gameEngine/rulesVersion.ts`) |

The work was done in a cloud clone of `0d8157e` with UR-6's 26 files laid over it — tree hash
`295f52b537a3b636e811b052013d3f86e209d3a6`, equal to `cd889cb^{tree}` — and the 13 git-ignored corpus files copied
from the owner's checkout (md5 verified). Only the changed files were written back to the owner's checkout (blob hashes
verified). Nothing was reset, pulled, rebased, merged, committed or pushed.

## B. Owner decisions and where each is evidenced

Every Unpredictable Revenue owner decision is DECIDED (audit rev 7); none was re-opened. "CG" is
`utils/unpredictableRevenueCertificationGame.test.ts` (§E).

| decision | ruling (short) | implemented | evidence |
|---|---|---|---|
| OD-UR-1 | the Yellow Sign is an automatic consequence of the run; no client request is authoritative | UR-3 | CG §2 (the Mark and the gift in their runs' own entries; three client requests refused, nothing appended); `yellowSignRunBound`, `yellowSignIngress` |
| OD-GR-3 | the Mark judges the post-settlement fleet; a Final Run train is never a candidate | UR-3 | CG §2 (C&O's 2 on its Final Run is retired, the Mark takes the 4) |
| OD-UR-2 | the gold-trimmed train survives set N+1 and leaves at its END, at the boundary | UR-3 | CG §5 (every board of set 6 holds it; the transition into SR 7 removes it) |
| OD-UR-3 | synthetic gifts never advance the phase | UR-3 | CG §4 (a gift ABOVE the phase: phase 5 stays; the first real 6 turns it) |
| OD-UR-4 | the Mark's award is minted | UR-3 (by rule) | CG (money is $12,000 on every board before the Mark, $12,150 after) |
| OD-UR-5 (a)(b)(c) | cured train ordinary; the buyer pays and moves Left 1 / Down 1, the seller not; the sale names the copy | UR-4 | CG §6 – §7 (tail B) |
| OD-UR-6 | corporation revenue paid; train routes printed; a nullified route earns nothing; a gift is no purchase, the Blood Price is | UR-5 | CG §8 – §9 |
| OD-UR-7 | no gilded Diesel trade-in; an ordinary copy stays tradable | UR-3 | CG (of C&O's two 6s only one is exchangeable, all set 6) |
| OD-UR-8 | the Rules Reference discloses consequences, not the Sign's trigger or odds | UR-6 (+ UR-7's tie sentence) | `unpredictableRevenueRulesReference`; `yellowSignDebugChip` (the chip no longer discloses on supported tables) |
| OD-UR-9 | cryptographic hosted seeds — routed to AWS / live multiplayer | not UR's | the server's seed source stays `randomTurnSeed`; recorded seeds replay (§K) |
| OD-UR-10 | **10-C** — an exact $5 tie rounds toward the printed total | **UR-7** | §D |
| OD-UR-11 | an undo reuses the draw; no restriction | (standing) | CG §1 (undo and re-run: the same seed, drawn once) |
| OD-UR-12 | "Unpredictable Revenue" | UR-6 | `unpredictableRevenueDisclosure` |
| OD-UR-13 | the Mark's train leaves the game; the phase is monotonic | UR-3 | CG §2 (`removed_trains` on every later board; the phase never falls at any entry) |

## C. What UR-7 changed

| file | change |
|---|---|
| `frontend/src/gameEngine/gameVariants.ts` | **the rule**: `roundRevenueTowardPrinted` (new, exported) and `rollTurnRevenue`'s rounding step — an EXACT tie of `printed × percent / 100` goes toward the printed total; every other amount rounds exactly as before |
| `frontend/src/gameEngine/yellowSign.ts` | `forcedSignToolInForce` (new, exported) — presentation predicate for the debug chip |
| `frontend/src/App.tsx` | the chip renders, its cycle writes, and its shortcut is honoured only where `forcedSignToolInForce` answers true (comments + three gated lines) |
| `frontend/src/components/RulesReference.tsx` | the tie sentence; the UR-6 note beside `UNPREDICTABLE_REVENUE_RULES` updated |
| `frontend/src/utils/unpredictableRevenueCertificationGame.ts` | **new** test support: the starting board, the board-driven script, the draw policy, the driver |
| `frontend/src/utils/unpredictableRevenueCertificationGame.test.ts` | **new** — 56 tests (§E – §L) |
| `frontend/src/utils/revenueTieRounding.test.ts` | **new** — 23 tests (§D) |
| `frontend/src/utils/yellowSignDebugChip.test.ts` | **new** — 14 tests (§G) |
| `frontend/src/utils/revenueRounding.test.ts` | one case's oracle updated to the ruled step (UR-7 note) |
| `frontend/src/components/unpredictableRevenueRulesReference.test.tsx` | UR-6's "no tie direction" pin replaced by the tie sentence pinned against the engine's own die; one concept added |
| this document, the audit (rev 11), `RULES_HARDENING_BACKLOG.md` | the record |

**Replay semantics, under v9 — for the owner's attention.** 10-C applies to every table, pinned and unpinned, exactly as
UR-3's and UR-4's rule changes did while the slices stayed on 9 (the Stage 7.5 / 8.5 / 9 / GR-5 precedent: one bump, at
closure). The only boards it can change are ones that met an exact +10% tie (face 5 on a printed total ≡ $50 mod $100).
A pinned v9 log that recorded such a tie would now replay the run at the lower figure and refuse the stored declaration
of the old one. The development corpus has none (§M). **Do not deploy UR-7 to a server that holds live v9 rooms before
UR-8 takes the 9 → 10 boundary.**

## D. OD-UR-10 = 10-C — the rounding (UR-F20)

**Reproduced before fixing.** On the untouched UR-6 tree the die paid half up: printed $50 at +10% put `last_route_revenue
"60"` on the board (`revenueTieRounding` "the run", baseline run), and the same room's $50 declaration was refused.

**The rule, where it lives.** `rollTurnRevenue` is the one implementation every reader calls — the reducer's two run
arms, the Mark's re-roll of what remains (`runWithoutTrain`), the narration and the statistics — always on the committed
draw. Its rounding step now reads:

* the exact modified amount is `printed × percent / 100`; it is a tie when `printed × percent ≡ 500 (mod 1000)`;
* on a tie, `roundRevenueTowardPrinted(modified, printed)` picks the ten nearer the printed total (the one case it
  cannot decide — printed itself on the halfway mark, which no route total can be — keeps half up);
* otherwise `roundToTen(modified)`, unchanged.

Integers only. Judging the tie on the exact product (not on the dollar figure) matters only off the $10 grid, which no
route reaches: $41 at 110% is $45.10, shown as $45, and keeps its old $50 (the independent review's nit, applied).
Consequences on every printed multiple of $10: only faces 2 and 5 can tie, only at printed ≡ $50 (mod $100); the −10%
tie already rounded up to printed; **only the +10% tie pays differently — $10 less than half up** ($55 → $50,
$165 → $160, $275 → $270, … $955 → $950). The six faces' mean is now exactly the printed figure at every printed
multiple of $10 (half up gave printed + $1.67 at $50 mod $100). The Yellow Sign's faces (1 and 6) never tie, so no
trigger, window or probability moved; the +10% tie that now pays printed is an "unchanged" outcome (UR-N14), so its
flavour bucket and turn sentence follow the figure.

**Evidence** (`utils/revenueTieRounding.test.ts`, 23 tests; baseline: 19 fail / 4 pass):

| owner's matrix | pinned |
|---|---|
| canonical | 50/45 → 50 · 50/55 → 50 · 150/135 → 140 · 150/165 → 160 · 250/225 → 230 · 250/275 → 270 |
| A non-tie closer to the lower ten | 44/50 → 40 · 132/150 → 130 · 274/250 → 270 · 64/80 → 60 |
| B non-tie closer to the upper ten | 46/50 → 50 · 56/50 → 60 · 167/150 → 170 · 226/250 → 230 |
| C tie below printed | printed − 5 → printed at 50, 150, 250, 450, 950 (and 85/110 → 90) |
| D tie above printed | printed + 5 → printed (half up would pay printed + 10) |
| E already on a ten | never moved, $0 … $1,000 |
| F low printed | $10 – $40: no face can tie (asserted), nothing positive pays $0 |
| G / H mid, high | $150, $250, $450, $1,050 — all six faces |
| the whole table | `rollTurnRevenue` = an independent exact-rational oracle at every printed $10 … $1,000 × every face; the ONLY differences from half up are face 5 at $50 mod $100 ($10 lower); the six-face mean = printed |
| the whole integer domain | $1 … $1,000 × six faces: exact ties go toward printed, everything else is the old half-up figure |
| authority | the reducer's run puts $50 on the board (printed $50, breakdown printed $50); the Dividends step refuses $60 and accepts $50; a payout moves 60% of $50 to the president and $30 out of the bank; a withhold banks $50; a standard table pays $110 printed where the variant's +20% pays $130 |
| hosted | the server's draw is committed; replay and restart reach the $50 without drawing; undo + re-run reuses the draw and pays $50 again |

**The Rules Reference** (`RulesReference.tsx`, the Dividends block): "…rounded to the nearest $10. If the result lands
exactly halfway between two $10 values, it is rounded toward the printed route total." Pinned in
`unpredictableRevenueRulesReference` against the engine's own die (face 5 / face 2 at $50, $150, $250 → 50/50,
160/140, 270/230), once, with no "half up" language; the page's no-trigger / no-odds scans are unchanged and pass.

## E. The constructed certification game

**Files.** `utils/unpredictableRevenueCertificationGame.ts` (test support; nothing in the app imports it) and
`utils/unpredictableRevenueCertificationGame.test.ts`. A constructed game — **not a historical game, not a golden**:
never exported, never added to the corpus, never blessed.

**Principles (audit §14.1).**

* A starting board plus a fixed script, submitted through `RoomSession.submit` — ingress, the server's own draw, the
  append, the room's derived entries — with the acting president (or the Stock Round seat) as author. No board is
  patched between steps. The script is a list of *events* (corporation, step, condition on the board, messages); the
  driver otherwise advances every turn the ordinary way (leave Lay Track and Place Tokens, run if the corporation has a
  route, declare, end the turn). Because each condition reads only the board, the script is fixed and replayable while
  the operating order — which the share prices decide — is left to the game.
* **The randomness is scripted by replacing the RNG, not the rules.** `mintSeed` answers with the draw the driver armed
  for the run it is about to submit: `drawStage` names the stage the script needs of that turn (the tie, the Mark, the
  Carcosa gift, or quiet), `printedOf` measures the run's printed total (the same message on the same board with the die
  off), and the seed is the first from a start point whose outcome — by the pure selectors the reducer and the shell
  use — is that stage. An unarmed draw throws: the server may draw nowhere the script did not plan (a restore, a replay
  and an undo's re-run draw nothing). Quiet draws start their search at an offset taken from the turn, so the quiet runs
  meet faces 2 – 6. *Deviation from §14.1, recorded:* the audit sketched seed CONSTANTS that fail loudly when the
  flavour payload moves; searching at run time (UR-3's support does the same) keeps the game playing its stages after
  such a change, and the test pins every stage on the board the room produced.
* **Provenance of the starting board.** Constructed, as GR-4's was. Reachable by legal play: phase 3 (all six 2s and
  five 3s owned, pool empty, the depot's head the first 4), the fleets (NYC [2,3], PRR [2,3], CPR [2,3], ERIE [3],
  B&O [2,2,3], C&O [2]), the holdings (all certificates in players' hands), the cursor (OR 3.1 of a two-round set,
  NYC at Lay Track), the privates (all sold; C&O owns the Schuylkill Valley, so its $5 reaches C&O's treasury; the
  B&O private closed). **Set, not earned:** the route network — `yellowSignRunBoundSupport`'s Gulf line (yellow cities
  I5, I7, I9; the curve I3; the Gulf, J2: yellow $30, brown $60) with C&O's station on I5 and B&O's second station on
  I9 (the printed map would need several rounds of tile lays to give anyone an earning route); the treasuries (NYC
  $1,200, PRR $1,500, CPR $1,000, ERIE $1,000, B&O $1,700, C&O $1,300); the share prices on one chart row (112, 100,
  90, 82, 76, 71; pars are printed pars). Money: bank + player cash + treasuries = $12,000. Rules: Unpredictable
  Revenue + Gentle Rust (G1) or Gentle Rust alone (G0), pinned to `RULES_ENGINE_VERSION` (9 at UR-7; **10 since UR-8**,
  §Q.6). Only C&O and B&O have
  routes; the room skips every other corporation's Routes step and forces its $0 withhold.

**The progression** (tail A 322 entries / 188 steps / 20 draws; tail B 330 / 192 / 20; G0 65 / 45):

| OR | what happens | proves |
|---|---|---|
| 3.1 | C&O's shortfall run ($40 where $50 is shown) refused; C&O [2] runs I5-I3-J2, printed $50, **face 5 → $50 (10-C)**; undo; the same run again (the same draw, drawn once); paid out, $5 a share; C&O buys the **first 4** (Gentle Rust self-trigger: every 2 marked, C&O's own too) | UR-F20, R2, R3, OD-UR-11, UR-N7, UR-N10 |
| 3.2 | OR opening: the Schuylkill's $5 to C&O's treasury; PRR and CPR buy 4s; **C&O's grace turn**: [2 (Final Run), 4] run $50 + $60; the settlement retires the 2; **the Mark takes the 4** (never the 2), nullifies its $60 route, re-rolls the kept $50 at face 1 → $40, mints $150; `removed_trains` ["4"]; S10-27's no-op derived withhold appears (not fixed here); three client Sign requests refused; C&O, trainless with a route, may not end its turn — buys the last 4 | OD-UR-1, OD-GR-3, OD-UR-4, OD-UR-13, UR-N12, UR-N31 – N35, X2, X8 |
| 4.1 | NYC buys the **first 5** (brown: the Gulf pays $60); B&O and C&O buy the other 5s; C&O [4] runs $120 | the era; the depot's head becomes the 6 |
| 4.2 | C&O [4, 5] runs $140 on a **Carcosa draw**: the gift is the depot's lowest train — **a 6, above phase 5**; gold-trimmed, synthetic; the phase, the 6 row, the 3-trains' marks are untouched; three trains at limit 2, no discard | OD-UR-3, UR-N38 – N41, X4 |
| 5.1 | ERIE buys the **first real 6** → phase 6, every 3 marked | the real train turns what the gift did not |
| 5.2 | PRR buys the **first real D** → phase D (set N = 5): C&O's deadline is set 6; every 4 marked; C&O's 4 retired on its grace turn; C&O buys the **last real 6** — now [5, 6, 6 gold-trimmed] at limit 2, no discard | UR-N44, UR-N41, OD-UR-7 |
| tail A · set 6 | the gold-trimmed 6 is on every board of OR 6.1, 6.2, 6.3 and a 6 runs each round; the transition into Stock Round 7 removes it — no run, no request — C&O keeps [5, 6] and stays Carcosan | OD-UR-2, UR-N45 – N48 |
| tail B · 5.3 | B&O's offer for "a 6" (unnamed) refused as ambiguous; the offer for the GOLD-TRIMMED 6, accepted: the derived settlement is the Blood Price — B&O pays $300 and moves one cell left and one down (mid-chart), C&O moves not at all and is released; B&O [5, 6] at its limit (a Depot purchase refused) | OD-UR-5 (a)(b)(c), UR-N49 – N54 |
| tail B · 5.3 – 6.1 | B&O runs the cured 6 ($60); trades it in for a Diesel (the pool holds it with its provenance); CPR buys it from the Bank Pool; CPR sells it to ERIE by an ordinary offer (no market move); at the old deadline no train leaves | the cured train's ordinary life |
| G0 · set 3 | the same board and messages, Unpredictable Revenue off | §L |

## F. Evidence by the coverage the owner asked for

All in CG unless named.

1. **The Unpredictable Revenue turn.** Routes run (breakdown printed $50); the committed draw (face 5; the room's entry
   carries it); adjusted ≠ printed on other runs (quiet draws cover faces 2 – 6); the exact $5 tie pays $50; the
   payout moves P1 +$30, P2 +$10, P3 +$10, the bank −$50; the Activity Log sentence "C&O ran for $50." names no bonus.
2. **The Yellow Sign.** Applied inside the run's own entry; three client requests (for C&O, aimed at B&O, forced) refused
   with the authority's sentence, nothing appended; no `YellowSignEvent` anywhere in the log; the taken route earns
   nothing (breakdown and statistics); the train removed for good; $150 = half of $300; the candidate fleet is the
   post-settlement one; the narration helper the shell calls names exactly what the board applied (R8).
3. **Gentle Rust (OD-GR-3).** C&O's 2 is on its Final Run (marked by C&O's own first 4); the settlement retires it
   first; the Mark takes the 4 — on the fleet as it ran the cheapest train was the 2, and it was never a candidate. The
   Final Run 2's completed route still earns and is paid at the turn's face.
4. **The Carcosa gift.** The depot's lowest (`carcosaGiftModel` → 6); no phase advance (phase 5 stays, the 6 row
   unchanged, no 3 marked, no doom clock); not a purchase (Fleet Admiral: C&O bought four trains; the gift paid $0 in
   the ledger); the limit exemption (three trains at limit 2 with no discard, again after the ordinary 6); gilding,
   provenance, Carcosan status and the Sign's flag.
5. **The fog, N+1.** Trigger in set 5 (the first real D); the gold-trimmed 6 on every board of set 6; removed on the
   transition into SR 7; no earlier board lost it.
6. **The Blood Price.** The copy named (the unnamed offer refused while C&O holds both copies); the buyer pays; one cell
   left and one cell down — read as cells (x − 1, y − 1; this chart's y counts up), not through the engine's own
   projection; the seller's marker unmoved; the curse, gilding and deadline cleared at the seller; the train ordinary
   at the buyer, its provenance the +1 (three 6s in play against two printed, the Depot reading sold out).
7. **The cured train's life.** Counts against B&O's limit; runs (B&O's next run is the 6, printed $60, paid at the
   die's figure); a legal Diesel trade-in (the pool holds it as the additional copy); a Bank Pool purchase; an ordinary
   sale; no fog at the old deadline; no phase change from any of it.
8. **Purchase statistics.** The gift in no purchase count; the Blood Price B&O's purchase at $300 (and its trade-in);
   the pool purchase and the later sale ordinary purchases; The Redeemer is B&O's president (tail B), nobody (tail A).
9. **Awards / statistics.** C&O's lifetime revenue = what its turns paid ($1,150 — 50, 40, 110, 170, 130 × 6); the
   Revenue-per-OR chart reads $50 / $40 / $170 (paid); per-train routes printed (C&O's two 4s earned $200: the taken
   4 nothing; the 5 $540 over 7 runs); Master of the Line "$120 on C&O's 4-train (OR 4.1)" (printed; that turn paid
   $110); the Gravedigger (P1, $1,380) and the Rust Belt (P1, $940) are Gentle Rust's destructions, derived train by
   train — the Mark's 4 and the fog's 6 are "taken", never rusted; Carcosan Railways is C&O's president in both tails;
   the Early Adopter is PRR.
10. **Standard / variant intersection.** §L.

## G. UR-N62 — the host's Yellow Sign debug chip

**What it is.** #1128's playtest tool: a "SIGN" chip beside the sandbox badge and Ctrl+Shift+Y, host-only, cycling an
armed stage on the room document; the acting client's narration turns it into `debug_force` on the legacy request.
Intentionally developer / playtest tooling.

**Can it change canonical state on a pinned table? No.** The shell arms the waiver only on a local (unpinned) board
(`signLocal`); on a pinned table hosted ingress drops `debug_force` and refuses the request, the reducer refuses it too,
and the Sign is the run's own consequence. The room-document flag is not game state. (Re-asserted on a hosted pinned
table: `yellowSignDebugChip` — refused at ingress with the authority's sentence, nothing appended, the board unchanged;
the reducer refuses it on the board a run left.)

**Did its wording leak? Yes, on supported tables.** It rendered for any sandbox host — including on a pinned table,
where it was inert — and its tooltips named the Mark's and Carcosa's phase windows and whom Carcosa visits next (the
trigger conditions OD-UR-8 keeps hidden, D-42), and called the fog "the Carcosan corporation's next run" (OD-UR-2
retired that). The host of a hosted game is also a player.

**Disposition — fixed narrowly, no new debug architecture.** `forcedSignToolInForce(state)` (yellowSign.ts) answers
true only for a dealt, unpinned Unpredictable Revenue board — exactly where the authority still runs the legacy request
path (`yellowSignRequestRefusal(state) === null`). The shell renders the chip, lets its cycle write the room document,
and lets Ctrl+Shift+Y be swallowed only there; on a pinned table the chip is gone and the keystroke is left to the
browser. The unpinned Firestore-era path keeps the tool #1128 asked for (S10-11's residual). Evidence:
`yellowSignDebugChip` (14 tests; baseline 10 fail / 4 pass).

**Observation, recorded (not changed):** the game server's room document accepts the `forced-sign` op from any member,
not only the host (`server/src/gameServer.ts`, the `"forced-sign"` case; the `"kick"` case checks the host). The flag is
inert on every pinned table, and only the unpinned path reads it; recorded with S10-11 (backlog).

## H. Clause matrix — UR-N1 … UR-N62, re-asserted

Suites (under `frontend/src/`): **CG** = `utils/unpredictableRevenueCertificationGame.test.ts`, **RTR** =
`utils/revenueTieRounding.test.ts`, **DC** = `utils/yellowSignDebugChip.test.ts`, **RR** `utils/revenueRounding`,
**YSA** `utils/yellowSignAuthority`, **YSI** `utils/yellowSignIngress`, **YRB** `utils/yellowSignRunBound`, **YMR**
`utils/yellowSignMarkRemoval`, **CFB** `utils/carcosaFogBoundary`, **CSP** `utils/carcosaSyntheticPhase`, **CGE**
`utils/carcosaGildedExchange`, **CBP** `utils/carcosaBloodPrice`, **URS** `utils/unpredictableRevenueStats`, **URSC**
`utils/unpredictableRevenueStandardControls`, **GHL** `utils/stage95GhostLimit`, **URD**
`components/unpredictableRevenueDisclosure`, **URRR** `components/unpredictableRevenueRulesReference`, B47 / B48 / B50,
MTR, ARR, FT, MKR, `gameVariants.test`, `variantCopy`. **CERTIFIED** = live-authority evidence at the right level and no
open defect touches it (the variant as a whole is closed only at UR-8).

| id | rule (short) | evidence | status |
|---|---|---|---|
| UR-N1 | flag chosen at the deal; absent = standard | `gameVariants.test`; CG G1 vs G0 (one flag, the only difference) | CERTIFIED |
| UR-N2 | flag fixed for the game | CG (every board of both tails and G0 carries the deal's variants) | CERTIFIED |
| UR-N3 | variant off → no mechanism | CG G0; RTR (standard $110 vs variant $130); URSC | CERTIFIED |
| UR-N4 | one roll per turn on the aggregate | CG (one draw per turn; [2, 4] rolled once on $110); MTR, ARR | CERTIFIED |
| UR-N5 | the face table | RR, `gameVariants.test`, URRR (the engine's table) | CERTIFIED |
| UR-N6 | × %, nearest $10, **ties toward printed** | RTR (whole table, whole integer domain); CG (the tie on the board) | CERTIFIED (UR-F20 fixed) |
| UR-N7 | paid figure is what Pay splits / Withhold banks | CG (payout, withholds); RTR | CERTIFIED |
| UR-N8 | declaration = paid figure | RTR ($60 refused, $50 accepted); CG (every declaration) | CERTIFIED |
| UR-N9 | share price on the paid figure (DSM multiples) | CG (standard chart: payout right, withhold left) | CORRECT BUT NEEDS LIVE TEST (Dynamic Stock Market × the die, X7) |
| UR-N10 | legality / shortfall on printed totals | CG (the $40 shortfall refused on a variant table) | CERTIFIED |
| UR-N11 | previews never roll | [U] (route planner) | CORRECT BUT NEEDS LIVE TEST (UI harness) |
| UR-N12 | only route revenue is modified | CG (the Schuylkill's $5 to the treasury; the run's paid figure the routes' alone) | CERTIFIED |
| UR-N13 | nothing to roll at $0; ≥ $10 never pays $0 | RTR F; RR | CERTIFIED |
| UR-N14 | outcome on figures, not the face | RTR; CG (the +10% tie is "unchanged"); FT | CERTIFIED |
| UR-N15 | a fresh 32-bit draw | B50 (the cryptographic source is OD-UR-9's, outside UR) | CERTIFIED |
| UR-N16 | the server draws; the client's seed replaced | CG (the committed seeds are the server's); RTR (987654321 replaced); YSI | CERTIFIED |
| UR-N17 | replay consumes the stored draw | CG (replay and restart with a throwing `mintSeed`); RTR | CERTIFIED |
| UR-N18 | an undo reuses the draw | CG (drawn once, reused); RTR | CERTIFIED |
| UR-N19 | one draw, three disjoint extractions | B50, B47 | CERTIFIED |
| UR-N20 | legacy seedless replay via the hash | B50; MKR; the corpus (§M) | CERTIFIED (pinned fallback hardening UR-F15, INFO, open) |
| UR-N21 | the draw is turn-scoped board state | CG (every earning turn opens with no recorded draw); YSA 9 | CERTIFIED |
| UR-N22 | the turn sentence | RR, FT, RTR, CG | CERTIFIED |
| UR-N23 | narration = board | CG (`narrateRunYellowSign` on the Mark, the gift, the tie); YRB | CERTIFIED (pinned; the legacy path is S10-11's) |
| UR-N24 | ephemeral cues do not replay | [U] source pins (UR-6) | CORRECT BUT NEEDS LIVE TEST (UI harness) |
| UR-N25 | once-per-game sequence | YSA, B48 (reducer gates); CG (one Mark, one gift, one fog) | CERTIFIED |
| UR-N26 | outcome derived, never chosen | YSA, YSI; CG (requests refused) | CERTIFIED |
| UR-N27 | a stage belongs to its run | CG (in the run's own entry); YRB | CERTIFIED (UR-F1 / UR-F2 fixed, pinned tables) |
| UR-N28 | the playtest force: local, unpinned only | YSI 4a / 4b / 5; DC | CERTIFIED |
| UR-N29 | the Mark's trigger | CG; YRB; B48 | CERTIFIED |
| UR-N30 | no Mark in phase 5+ | B48 | CERTIFIED |
| UR-N31 | the lowest-value train (post-settlement) | CG; YSA | CERTIFIED |
| UR-N32 | only the taken train's route nullified | CG (breakdown, paid $40); YRB | CERTIFIED (UR-F5 / UR-F7 fixed) |
| UR-N33 | ½ face value, minted | CG (+$150; the bank untouched; money $12,150 after) | CERTIFIED |
| UR-N34 | trainless → the ordinary obligation | CG (the turn may not end; C&O buys) | CERTIFIED |
| UR-N35 | the Sign's flag | CG (set by the Mark, passed at the gift) | CERTIFIED |
| UR-N36 | the Mark's two lines | CG (the helper the shell calls); YRB (shell source pins) | CERTIFIED (delivery source-pinned; no App harness) |
| UR-N37 | a Final Run train never the Mark's | CG | CERTIFIED |
| UR-N38 | the Carcosa trigger | CG; YRB | CERTIFIED |
| UR-N39 | the gift: the depot's lowest synthetic train | CG (above the phase); CSP; GHL | CERTIFIED (UR-F4 fixed) |
| UR-N40 | Carcosan status; the flag cleared | CG | CERTIFIED |
| UR-N41 | the limit exemption, whole lifetime | CG (at the gift, after the ordinary 6, all set 6) | CERTIFIED |
| UR-N42 | otherwise ordinary, never a Diesel trade-in | CG; CGE | CERTIFIED (UR-F17 fixed) |
| UR-N43 | a synthetic D is not a real D purchase | GHL; CBP E2 | CERTIFIED |
| UR-N44 | the doom trigger: whichever is later | CG (gift first, the real D later sets it); GHL | CERTIFIED |
| UR-N45 | expiry at the end of set N+1, at the boundary | CG; CFB | CERTIFIED (UR-F18 fixed) |
| UR-N46 | the fog is not a run stage | CG; CFB | CERTIFIED |
| UR-N47 | Carcosan after the fog | CG | CERTIFIED |
| UR-N48 | the fog takes one copy, its gilding and provenance | CG (the ordinary 6 stays) | CERTIFIED |
| UR-N49 | the Blood Price absolves the seller | CG; CBP | CERTIFIED |
| UR-N50 | the buyer receives an ordinary train | CG; CBP | CERTIFIED |
| UR-N51 | the buyer's marker moves, the seller's not | CG (as cells, mid-chart); CBP | CERTIFIED (UR-F22 fixed) |
| UR-N52 | provenance travels with the train | CG (sale, trade-in, pool, sale) | CERTIFIED |
| UR-N53 | the server charges it on a legal transfer | CG (the hosted offer's derived settlement) | CERTIFIED |
| UR-N54 | the sale names the copy | CG; CBP | CERTIFIED (UR-F21 fixed) |
| UR-N55 | Carcosan Railways, The Redeemer | CG (both tails); URS | CERTIFIED (the completed-game fixture, S10-21, is §O — *UR-8: closed as superseded, §Q.4*) |
| UR-N56 | the Sign's takings are not obsolescence | CG (Gravedigger / Rust Belt exact) | CERTIFIED |
| UR-N57 | The Cowboy | URS | CERTIFIED (UR-F9 fixed) |
| UR-N58 | the statistics basis | CG; URS | CERTIFIED (UR-F8 fixed) |
| UR-N59 | Lobby copy | `variantCopy`; URD | CERTIFIED |
| UR-N60 | the Rules Reference, 8-B | URRR (+ the tie sentence) | CERTIFIED |
| UR-N61 | gilded chips' limit text | URD | CERTIFIED |
| UR-N62 | the arming chip only where its force acts | DC | CERTIFIED (UR-7 fix) |

## I. Interactions and invariants

| id | rule | evidence | status |
|---|---|---|---|
| X1 | Gentle Rust × the die | CG (the whole game under Gentle Rust) | CERTIFIED |
| X2 | Gentle Rust × the Mark | CG | CERTIFIED |
| X3 | Gentle Rust × a delayed request | YRB (requests refused on pinned tables) | CERTIFIED |
| X4 | a gift above the phase × phase / rust / era / doom / statistics | CG; CSP | CERTIFIED |
| X5 | LPF shelf gifts (6 / 7 / D) | CSP; CBP E3 | CERTIFIED (by design outside G1, §14.5) |
| X6 | a gilded trade-in | CG; CGE | CERTIFIED |
| X7 | Dynamic Stock Market × the die | [RP] JUNO-3XD (unpinned) | CORRECT BUT NEEDS LIVE TEST |
| X8 | a trainless Mark × the obligation | CG (the obligation; C&O could pay — the president-funded purchase is Batch 5's, variant-agnostic) | CERTIFIED |
| X9 | the server path for the Sign | CG | CERTIFIED |
| X10 | a standard table refuses the Sign | CG G0; URSC | CERTIFIED |
| X11 | statistics under the variant | CG; URS | CERTIFIED |
| X12 | money conservation, the award minted | CG (every board) | CERTIFIED |
| X13 | the unpinned corpus replays unchanged | §M | CERTIFIED (re-measured) |
| X14 | a completed Yellow Sign game (S10-21) | — *(UR-8: CG, both tails, is the stronger evidence — §Q.4)* | ~~DEFERRED (§O)~~ **CLOSED — SUPERSEDED (UR-8, §Q.4)** |
| X15 | the Rules Reference | URRR | CERTIFIED |
| R1 | server seed and key on every accepted run | CG | CERTIFIED |
| R2 | undo reuses the draw, end to end | CG | CERTIFIED |
| R3 | a refused run pins no seed, reveals nothing | CG | CERTIFIED |
| R4 | replay / restore never draw; identical digests | CG (full and part-way restarts; replay) | CERTIFIED |
| R5 | the reducer never draws | B47; CG (draws only through the armed `mintSeed`) | CERTIFIED |
| R6 | a turn's draw only for its own turn | CG; YSA 9 | CERTIFIED |
| R7 | client and server agree | CG (the client's drain and the server share `replayLog`; digests equal) | CERTIFIED |
| R8 | narration = applied outcome | CG | CERTIFIED |
| R9 | variant off: nothing random matters | CG G0; RTR | CERTIFIED |
| R10 | legacy semantics only on unpinned logs | YSA 7; MKR; §M | CERTIFIED |
| R11 | a turn key names one corporation turn | CG (one key per turn) | CERTIFIED |
| R12 | uniform faces, independent extractions | B50 | CORRECT BUT NEEDS LIVE TEST (a distribution test on the seed source; the cryptographic source is OD-UR-9's) |
| R13 | no message field changes a random outcome | CG (client seeds replaced; requests refused); YSA; YSI | CERTIFIED |

## J. Counts (UR-7)

**Clauses (62):** CERTIFIED **59** · CORRECT BUT NEEDS LIVE TEST **3** (UR-N9 DSM, UR-N11 previews, UR-N24 cues) ·
DEFECT **0** · OWNER DECISION **0** · DEFERRED **0**. **Interactions and invariants (28):** CERTIFIED **25** · CORRECT
BUT NEEDS LIVE TEST **2** (X7, R12) · DEFECT **0** · OWNER DECISION **0** · DEFERRED **1** (X14). *(Audit rev 7:
29 / 13 / 20 / 0 / 0 and 6 / 9 / 12 / 0 / 1.)*

*(UR-8: clauses unchanged — **59 / 3 / 0 / 0 / 0**. Interactions and invariants: CERTIFIED **25** · CORRECT BUT NEEDS LIVE
TEST **2** (X7, R12) · DEFECT **0** · OWNER DECISION **0** · DEFERRED **0** · CLOSED — SUPERSEDED **1** (X14, S10-21 —
§Q.4). No row is a certification blocker: the three "needs live test" clauses and X7 / R12 need a harness, not a rule.)*

## K. Replay, restart, undo

Every tail's log replays under `SERVER_REPLAY_POLICY` to the room's final board; a `RoomSession.restore` of the whole log
and of four prefixes (after the tie, after the Mark, after the gift, after the D) reaches the board the room held there,
with a `mintSeed` that throws; the per-entry boards the tests read come from the room's own two paths (the engine's
`apply`, and a rebuild of the effective log at a `RevertTo`). The undo returns the board to before the run; the re-run
commits the same seed and reaches the same board; the server drew once for that turn. The deal is pinned to 9 *(UR-8:
10 — the same game, entry for entry, across the boundary, §Q.6)*.

## L. Standard controls

G0 plays the same starting board and messages through set 3 with Unpredictable Revenue off (Gentle Rust on): the
grace-turn run pays $110 printed where G1's Mark turn pays $40; nothing is taken, nothing is minted (money $12,000 on
every board), `removed_trains` stays empty, no Sign, Carcosan or gilding field appears on any board, and the three client
requests are refused there too. (At an exact tie 10-C pays printed as well, so G0's tie turn cannot tell "no die" from
"a die"; the grace-turn control and RTR's standard $110 / variant $130 are the controls that do.)

## M. Corpus reconciliation (18 files, baseline vs UR-7)

Baseline = the UR-6 tree (`295f52b5…`); UR-7 = this tree; a scratch harness (not added to the repository) replaying each
file under `DEVELOPMENT_CORPUS_POLICY` from the stage-10.4 seed and recording, per engine application, the pre-entry
state digest, grid hash, cursor, derived-action answer and known phase:

| measure | result |
|---|---|
| files | 18 (3 goldens, 8 server logs, 5 exports, the FCJ-96 prefix, the Z6C-494 fixture) — all unpinned |
| stored / applied / dropped | **4,105 / 3,731 / 374** |
| engine applications | **3,763** |
| state / grid / cursor / derived-action / known-phase differences | **0 / 0 / 0 / 0 / 0** |
| final boards equal | **18 / 18** |
| phase decreases (UR-7 tree) | **0** |
| JUNO-Y8V | 668 / 628 / 40, 632 applications, `OperatingRound 13`, **`b4fae877c35604fe`** |
| JUNO-3XD | 322 / 320 / 2, 323 applications, `StockRound 12`, **`74db6e4bad736fec`** |
| Unpredictable Revenue runs in the corpus | 247 |
| exact $5 ties among them | **0** — one run printed a total ≡ $50 (mod $100), a $50 run on face 4 (100%) |
| corpus file bytes | md5 unchanged |

No stored log meets an exact tie, so 10-C changes no corpus board; nothing was repinned.

## N. Validation

* **New suites:** RTR 23, DC 14, CG 56 — **93 tests, all pass**; against the untouched UR-6 tree **33 fail, 60 pass**
  (RTR 19 / 4, DC 10 / 4, CG 4 / 52 — CG's four are the tie turn, its payout, its restart and the lifetime revenue).
  Updated: `revenueRounding` (one oracle), `unpredictableRevenueRulesReference` (the tie pin).
* **Focused Jest (cloud clone, corpus present):** every test file naming the variant, the Sign, Carcosa, the Blood Price,
  seeds, rolls or rounding, Gentle Rust, the version, the corpus suites, or a touched module (`App.tsx`,
  `RulesReference`, `gameVariants`, `yellowSign`) — **290 suites, 5,742 tests, all pass.** Full Jest was not run (the
  owner's gate).
* **The owner's checkout, after the write-back** (`CI=true react-app-rewired test --watchAll=false --maxWorkers=2`, seven
  batches inside the session's 180-second command window): the three new suites, `revenueRounding`, every `yellowSign*`,
  `carcosa*` and `unpredictableRevenue*` suite, the Sign / die / ghost suites (`stage95GhostLimit`, `stage95Rulings`,
  `forcedSignAndRadioBar`, `flavorText`, `multiTrainRun`, `atomicRunRoutes`, `markKeepsRun`, `batch47`, `batch48`,
  `batch50`, `gameVariants`, `variantCopy`), the corpus suites (`stage9Closure`, `stage10Closure`, `gentleRustClosure`,
  `replayJuno3XD`, `replayJunoCV4`, `moneyConservation`, `trainDiscard`, `stage103bChartCoreAtomicity`,
  `stage104HarnessHardening`) and the Rules Reference / shell source pins (the five `rules*` page suites, `rulesScope`,
  `rulesVersion`, `runTrainsRules`, `shellNarration`, `shellMessageArms`, both `gentleRustPresentation`, `batch60` –
  `batch62`, `variantWiring`, `dividendNarration`, `chipRunRevenue`) — **58 suites, 1,260 tests, all pass.**
* **tsc:** frontend `--noEmit` 0; server (`server/tsconfig.json`, TypeScript 4.9.5) 0 — in the cloud clone and on the
  owner's checkout.
* **Build** (`react-app-rewired build`, `GENERATE_SOURCEMAP=false`, cloud clone): exit 0, "Compiled with warnings" —
  **49 ESLint warning lines, identical (modulo line numbers) to the UR-6 baseline built the same way**, plus the
  pre-existing webpack "Critical dependency" notice.
  A build on the owner's checkout was not attempted: it cannot finish inside the 180-second window and would write the
  connected `build/` folder.
* `git diff --check`: clean (cloud clone and the owner's checkout; the untracked new files scanned separately for
  trailing whitespace and tabs). `RULES_ENGINE_VERSION`: 9 (`frontend/src/gameEngine/rulesVersion.ts`).
* **Independent review** (a reviewer agent with no part in the work, read-only): no blocker. Its five should-fix items —
  record the v9 replay note (§C); make the standard controls use a face the die moves; pin the Gravedigger / Rust Belt
  exactly; read the Blood Price move as cells with a buyer off the chart's edge; write this record — and its nits
  (judge the tie on the exact product; honest provenance; varied quiet faces; the draw count in the undo test; Test F's
  assertion; the shortcut not swallowed at pinned tables) were applied.

## O. Known deferred residuals (recorded, not closed here)

*(UR-8: S10-21 / X14 is CLOSED — SUPERSEDED (§Q.4); every other item below stays open and routed as written (§Q.8). In the
first bullet, "a Bagholder detail" is not asserted by the game, and the ten Operating Rounds are not asserted as a count —
§Q.4.)*

* **S10-21 / X14 — the completed Yellow Sign game.** Scheduled "in UR-7" by the backlog; **not built.** The constructed
  game restores much of the displaced evidence (Carcosan Railways and The Redeemer, the Gravedigger and the Rust Belt in
  dollars, a Bagholder detail, a phase-D timeline of ten Operating Rounds) but does not reach the bank's end, and the
  displaced assertions in `accolades.test.ts`, `roundReplay.test.ts` and `gameHistory.test.ts` are not restored. A
  fixture committed now would be pinned at 9 and refused after UR-8's boundary; a generated completed game (this game's
  tail A continued with a short bank) is the natural shape at v10. Routed: UR-8 or a named follow-up — the planner's
  call.
* **S10-27** — the room's forced $0 withhold for a corporation left trainless at Dividends whose run earned: reproduced
  live by the Mark (CG pins it as a no-op; the president's $40 declaration follows). Not fixed.
* **S10-11** — the unpinned (Firestore-era) path keeps the legacy request, the debug chip, and the legacy Mark without a
  removal record; the server's room document takes the `forced-sign` op from any member (§G). Not converted.
* **UR-F15** (INFO) — a pinned run without `revenue_seed` would fall back to the hash; unreachable through the server.
* **OD-UR-9 / UR-F16** — cryptographic hosted seeds: AWS / live multiplayer.
* **Needs a harness, not a rule:** UR-N11 (previews), UR-N24 (ephemeral cues), R12 (a distribution test), X7 (DSM × the
  die).

## P. What remains for UR-8

*(UR-8: done — §Q.)*

The one deliberate **9 → 10** boundary and the closure record: changelog row 10 naming exactly the Unpredictable Revenue
replay semantics — (1) the run-bound Sign and its gate, (2) the Mark on the post-settlement fleet, (3) the fog at the end
of N+1, (4) synthetic trains never the phase, (5) no gilded trade-in, (6) the Blood Price's copy, buyer's move and pool
provenance, (7) **10-C** (this slice), (8) the Mark's train removed from the game; the closure tests (supported `[10]`,
a v9 log refused); the corpus and this game across the boundary; the owner's full-suite gate; S9-7 / Part D / Part E;
and the S10-21 decision above. **Until then Unpredictable Revenue is not closed.**

## Q. UR-8 — the `RULES_ENGINE_VERSION` 9 → 10 boundary and certification closure (2026-09-25)

**Verdict: UNPREDICTABLE REVENUE CERTIFIED at `RULES_ENGINE_VERSION` 10** — standalone and with Gentle Rust (OD-GR-3) —
subject to the owner's full-suite gate and commit. UR-1 … UR-8 are complete (UR-8 awaiting that gate). UR-8 added **no
gameplay semantics**: the version boundary, the closure tests, version-literal narrowing of five suites, and this record.
**Not certified by this closure:** Delayed Auction; and "variant certified" does not mean "every repository backlog item
closed" — §Q.8 lists what stays open, none of it a certification blocker.

### Q.1 Baseline and architecture

| item | value |
|---|---|
| branch | `main` |
| HEAD | `ff7a04b6aaea17597cf9c5ea0bd61bcc8b0632e8` ("Certify Unpredictable Revenue behavior", UR-7) |
| `origin/main` | `ff7a04b6aaea17597cf9c5ea0bd61bcc8b0632e8` — 0 ahead / 0 behind (UR-6 `cd889cb` and UR-7 `ff7a04b` both pushed) |
| tracked tree at start | clean (only the untracked `.claude/`); no `.git/index.lock` |
| `RULES_ENGINE_VERSION` at start | `9` |

The work was done in a cloud clone of `origin/main` (= HEAD) with the 13 git-ignored corpus files copied from the owner's
checkout (md5 verified equal); only the changed files were written back. Nothing was reset, pulled, rebased, merged,
committed or pushed.

The version architecture is #1520's, unchanged since the Stage-10 closure and GR-5 (the precedent followed): a
hand-bumped `RULES_ENGINE_VERSION`; `SUPPORTED_RULES_ENGINE_VERSIONS` derived `[RULES_ENGINE_VERSION]`;
`RULES_ENGINE_CHANGELOG`, one row per version; the server stamps the deal (`stampRulesEngineVersion`, over any client
claim); `replayCompatibility` / `replayRefusal` with `SERVER_REPLAY_POLICY` (refuses unpinned) and
`DEVELOPMENT_CORPUS_POLICY` (admits unpinned only); every other numeric pin is `incompatible` under every policy; no
migration path. UR-8 changed none of this machinery.

### Q.2 The bump

`frontend/src/gameEngine/rulesVersion.ts:65` — `RULES_ENGINE_VERSION = 10`; supported list derived `[10]`; changelog
**row 10** ("Unpredictable Revenue certification closure (UR-8, 2026-09-25)"), which names:

* **REPLAY SEMANTICS, exactly eight** — the audit's §15 "version boundary" list, item for item:
  **(1) UR-3 (OD-UR-1)** — on a pinned Unpredictable Revenue table the Yellow Sign is an automatic consequence of the
  accepted run, resolved and applied in the run's own entry (`settleRunYellowSign`, `last_run_yellow_sign`); on every
  pinned table a client `YellowSignEvent` is refused at ingress and in the reducer.
  **(2) UR-3 (OD-GR-3)** — the Mark judges the post-settlement fleet (a Final Run train retired first, never a
  candidate) and nullifies only the taken train's route; the breakdown is the authority's pairing.
  **(3) UR-3 (OD-UR-2)** — the gold-trimmed train leaves at the END of OR set N+1, at the boundary (`fogAtSetEnd`), never
  on a run.
  **(4) UR-3 (OD-UR-3)** — a synthetic Carcosa train never advances the phase (`derivePhase`); the first real train of
  the tier does.
  **(5) UR-3 (OD-UR-7)** — a gilded train is never a Diesel trade-in ($800; LPF $750); an ordinary copy still trades.
  **(6) UR-4 (OD-UR-5)** — the Blood Price names the copy (optional `gilded`; an unnamed ambiguous sale refused); the
  buyer's marker moves Left 1 / Down 1, never the seller's; the cured train is an ordinary additional train whose
  synthetic origin is supply provenance only, kept through the Bank Pool (`returned_ghost_trains`).
  **(7) UR-7 (OD-UR-10 = 10-C)** — an exact $5 tie rounds toward the printed total (`roundRevenueTowardPrinted`).
  **(8) UR-3 (OD-UR-13)** — the Mark's taken train is permanently removed from the game (`removed_trains`); phase
  progression is monotonic.
  None of the eight asks the pin's value.
* **NOT RULES** (after an explicit marker, so the row is not read as them): the minted award (OD-UR-4, unchanged); UR-5's
  statistics basis (OD-UR-6 — derived history only); UR-6's UI, copy, Rules Reference and naming (OD-UR-8, OD-UR-12);
  UR-7's tie sentence, the debug chip's visibility (UR-N62), the certification tests, documents and constructed game; the
  undo rule (OD-UR-11, unchanged); the seed source (OD-UR-9, deferred). The owner's UR-8 brief listed "statistics
  corrections" among the accumulated changes "as applicable": by the project's version policy (#1520: the number moves
  only when a stored log would replay to a different board; GR-5's U-9 precedent) they are named in the row, behind the
  marker, not counted as a replay semantic.
* The unpinned (Firestore-era) legacy request path is named as S10-11's residual; U-41, U-43, S10-21, S10-27 and Delayed
  Auction are not in the row (pinned by the closure suite).

**Why the bump is taken now.** UR-3, UR-4 and UR-7 each changed what a stored log replays to and each stayed on 9, so the
corpus and the constructed game could be measured slice by slice against one baseline (the 7.5 / 8.5 / Stage 9 / Stage
10 / GR-5 precedent); UR-8 is the closure, so the whole set takes its one bump here. Until this bump a v9 label covered
builds with and without those rules (UR-7's §C warning); from here a room dealt at 10 means exactly them.

### Q.3 Replay / version policy — verified

* **New authoritative games are v10.** The server stamps 10 over any client claim (none, 1, 8, 9, 11, 999), on the log
  and on the board, with and without the variant (closure suite §2.1); a v10 room is `compatible`, restored, rebuilt to
  the live digest, playable, and replays headless under `SERVER_REPLAY_POLICY` (§2.2).
* **Historical v9 material is held, never reinterpreted** — the established policy, unchanged: a v9-pinned room (standard,
  or Unpredictable Revenue with Gentle Rust) is `incompatible` and held **before the reducer sees an entry** (no
  `RoomEngine.apply`, no provider call) under `SERVER_REPLAY_POLICY` **and** `DEVELOPMENT_CORPUS_POLICY`; `replayLog`
  throws `ReplayIncompatibleError` under both; a held room appends nothing (a move, a new deal, a `RevertTo`) and its
  catch-up exposes no history; no path rewrites a stored 9 (§2.3, §2.3b, §2.7 – §2.9). This is what "replay-compatible"
  has meant since #1520: a v9 server that is upgraded holds its v9 rooms; nothing silently replays a v9 log under v10
  rules. **No blocker:** the framework cannot produce a silently incorrect v9 replay, because a v9 log is never replayed
  by this engine at all.
* **Unpinned (legacy) logs** are refused by the server and admitted only by the explicit development-corpus opt-in, and
  never acquire a pin (§2.5, §2.6, §4).
* **No version-value branch exists.** The pinned / unpinned seam UR-3 uses (`automaticYellowSignInForce`,
  `yellowSignRequestRefusal`) asks whether a pin is PRESENT — #1698's rule for the 10.6 lay seam — so it needs no edit at
  the bump; no authority behind (1) – (8) compares or names the version (source scan, §3). Nothing required a
  version-specific guard, a migration, or a fixture repin.

### Q.4 S10-21 — disposition: CLOSED — SUPERSEDED

**The original requirement.** Filed by Batch 7.5 (owner ruling 2026-09-16) when Batch 7's corrections made the
development fixture JUNO-Z6C stop short of a completed game: a completed game with Unpredictable Revenue on, containing a
Mark, rust, a Bagholder and a Little Engine, committed beside the golden logs, so that the assertions **removed** from
`accolades.test.ts` / `roundReplay.test.ts` / `gameHistory.test.ts` (Carcosan Railways and "Marked by an Outer God"; the
Gravedigger and the Rust Belt in dollars; The Cowboy; the Bagholder and Little Engine detail formats; a phase-5+,
more-than-ten-OR timeline) could be restored. Classified **D — test substrate, not a closure blocker; no rule depends on
it** at the Stage-10 closure, routed to Unpredictable Revenue certification as its evidence deliverable, and scheduled in
UR-7 by the audit (§6.4, §14.4) because under the pre-UR-3 code a hosted game could not produce a Mark at all (UR-F1).

**Why UR-7 supersedes it.** S10-21 existed to give the variant's rare events live, completed-game coverage the engine
could no longer produce from Z6C. The UR-7 constructed certification game is stronger evidence for every Unpredictable
Revenue assertion S10-21 carried: it is played through `RoomSession.submit` on the current authority (the server's draw,
ingress, derived entries), pinned and replayed under `SERVER_REPLAY_POLICY`, deterministic (a throwing `mintSeed` on every
restore / replay / undo), with a paired standard control — where S10-21 asked for one recorded game read by
`DEVELOPMENT_CORPUS_POLICY`. It asserts **exactly** what S10-21 asked for only as "non-null" or "> 0": Carcosan Railways
(both tails) and The Redeemer (tail B's buyer; nobody in tail A); the Mark's award, removal and nullified route; the
Gravedigger ($1,380) and the Rust Belt ($940) exactly, with the Sign's takings excluded; per-train and per-corporation
statistics; the Blood Price and cured-train lifecycle; the phase carried to D, monotonic (asserted — the game runs OR
3.1 – 6.3, ten Operating Rounds, which no test counts). "Marked by an Outer
God" is pinned on the pinned path by `yellowSignRunBoundStats`; The Cowboy by `unpredictableRevenueStats` (UR-F9). A committed completed-game capture would add a second, weaker (recorded,
unexercised-authority) form of the same evidence — and, dealt at 9 in UR-7, would have been refused at this boundary.

**What it does not restore, recorded honestly.** The Bagholder and Little Engine detail-format lines in `accolades.test.ts`
remain vacuous on CV4, and the more-than-ten-OR / phase-5+ timeline assertion in `roundReplay.test.ts` /
`gameHistory.test.ts` stays on CV4's shorter timeline. *(Correction to §O above: the constructed game does not assert a
Bagholder detail — neither suite names it.)* Neither is an Unpredictable Revenue rule, a clause of this certification or
an owner-ruled obligation: they are **generic completed-game epilogue formats** (a standard game produces them) and belong
to the standard statistics / epilogue coverage, not to variant certification. No project policy requires a
completed-game capture for certification (GR-5 certified Gentle Rust without one; S10-21 was classified "not a closure
blocker"). They are carried forward as a named, nonblocking test-coverage note on S10-21's closure in the backlog,
cross-referenced from U-43 (the open statistics / residual pass, whose status and routing are unchanged) — no new
fixture, golden or repin.

**Disposition: S10-21 CLOSED — SUPERSEDED by the UR-7 constructed certification game** (audit X14 likewise). No fixture
was built, no historical log touched.

### Q.5 Owner decisions — final evidence (none re-opened)

"CG" = `utils/unpredictableRevenueCertificationGame.test.ts`; "row 10" = the v10 changelog row; "D-nn" = backlog Part D.

| decision | ruling | durable evidence | in row 10 |
|---|---|---|---|
| OD-UR-1 (D-37) | the Yellow Sign is an automatic, derived consequence of the run | CG §2 (the Mark and the gift in their runs' own entries; three client requests refused, nothing appended); `yellowSignRunBound`, `yellowSignIngress`, `yellowSignAuthority` | (1) |
| OD-UR-2 (D-38) | the fog at the END of OR set N+1, at the boundary | CG §5 (every board of set 6 holds it; the transition into SR 7 removes it); `carcosaFogBoundary` | (3) |
| OD-UR-3 (D-39) | synthetic gifts never advance the phase | CG §4 (a 6 gifted in phase 5; the first real 6 turns it); `carcosaSyntheticPhase`, `stage95GhostLimit` | (4) |
| OD-UR-4 (D-40) | the Mark's award is minted (found money) | CG (money $12,000 before the Mark, $12,150 after); `moneyConservation` | NOT RULES (unchanged) |
| OD-UR-5(a) (D-48) | the cure is an ordinary additional train; synthetic origin is supply provenance only | CG tail B (the cured 6 runs, trades in, is bought from the Bank Pool, sold; the Depot reads sold out with three 6s in play); `carcosaBloodPrice` | (6) |
| OD-UR-5(b) (D-50) | the buyer alone moves Left 1 / Down 1 | CG tail B (read as cells; the seller unmoved); `carcosaBloodPrice`, `bloodPriceArrival` | (6) |
| OD-UR-5(c) (D-48) | same-model ordinary and gilded copies are distinguishable; the sale names the copy | CG tail B (the unnamed offer refused; the gilded copy's accepted); `carcosaBloodPrice`, `carcosaBloodPricePanel` | (6) |
| OD-UR-6.1 (D-49, D-51) | corporation / turn statistics on paid revenue; route / train statistics on the printed completed route | CG §9 (C&O's lifetime $1,150 paid; per-train printed; Master of the Line printed); `unpredictableRevenueStats` | NOT RULES (derived history) |
| OD-UR-6.2 (D-49) | a Mark-nullified route contributes nothing | CG §9 (the taken 4 earns nothing); `yellowSignRunBoundStats`, `unpredictableRevenueStats` | NOT RULES |
| OD-UR-6.3 (D-49) | a gift is not a purchase; the Blood Price is | CG §8 (Fleet Admiral, the ledger; B&O's $300); `carcosaBloodPriceStats`, `unpredictableRevenueStats` | NOT RULES |
| OD-UR-7 (D-41) | a gilded train cannot Diesel trade; a cured ordinary train can | CG (of C&O's two 6s only the ordinary one is exchangeable; tail B's cured 6 is traded in); `carcosaGildedExchange` | (5) |
| OD-UR-8 (D-42) | disclose actionable mechanics; hide the Sign's trigger and odds | `unpredictableRevenueRulesReference` (no trigger / no odds scans), `yellowSignDebugChip` | NOT RULES |
| OD-UR-9 (D-43) | cryptographic hosted seeds | **deferred** to AWS / live multiplayer (UR-F16); recorded draws replay identically (CG with a throwing `mintSeed`) | NOT RULES (deferred) |
| OD-UR-10 (D-47) | exact-$5 ties toward printed (10-C) | `revenueTieRounding` (the owner's matrix, the whole table and integer domain); CG §1 | (7) |
| OD-UR-11 (D-44) | undo reuses the recorded die result | CG §1 (the same seed, drawn once); `revenueTieRounding` (hosted) | NOT RULES (unchanged) |
| OD-UR-12 (D-45) | canonical name "Unpredictable Revenue" | `unpredictableRevenueDisclosure`, `variantCopy` | NOT RULES |
| OD-UR-13 (D-46) | the Mark's train is permanently removed from the game | CG §2 (`removed_trains` on every later board; the phase never falls); `yellowSignMarkRemoval` | (8) |
| OD-GR-3 (D-36) | the Mark judges the post-settlement fleet; a Final Run train is never a candidate | CG §2 – §3 (C&O's Final Run 2 retired first; the Mark takes the 4) | (2) |

Every decision has durable evidence; **no gap is an implementation defect** and none needed production code in UR-8.

### Q.6 The constructed certification game across the boundary

G1 tail A, G1 tail B and G0 (the standard control) played through a scratch harness on the v9 tree (`ff7a04b`) and the
UR-8 tree, the same driver and script:

| game | entries (derived) | submissions (refused) | draws | steps and log | final digest v9 → v10 | digest without the pin | replay under `SERVER_REPLAY_POLICY` |
|---|---|---|---|---|---|---|---|
| G1 tail A | 322 (139) | 188 (5) | 20 | identical — every answer, appended entry and per-step board | `2cfdfb8882c77563` → `8c7dab14bdb665b1` | `cb0c2a961d71a467` both | = final, both sides |
| G1 tail B | 330 (145) | 192 (7) | 20 | identical | `5f485c0106445f3e` → `8a049ad519b8bbc0` | `0e7fd01bdc151b92` both | = final, both sides |
| G0 | 65 (24) | 45 (4) | 4 | identical | `26e536b20a064fbf` → `aa1f74eea67c6e5d` | `67cda49c2c184313` both | = final, both sides |

Entry for entry (index, actor, payload, derived) the logs are byte-identical; the pin field is the only difference in any
board. The CG suite's own version case now reads "10 or later" and the deal's pin equals `RULES_ENGINE_VERSION` (§Q.9).

### Q.7 Corpus reconciliation across the boundary (18 files)

Scratch harness (not added to the repository) on the v9 tree and the UR-8 tree: each file replayed under
`DEVELOPMENT_CORPUS_POLICY` from the stage-10.4 seed, recording per engine application the pre-entry state digest, grid
hash, cursor (round, set, OR, active corporation, sub-phase), derived-action answer (`nextDerivedAction`) and known phase.

| measure | result |
|---|---|
| files | **18** — all unpinned (`legacy`); none acquires a pin |
| stored / applied / dropped | **4,105 / 3,731 / 374** |
| engine applications | **3,763** |
| state / grid / cursor / derived-action / known-phase differences (v9 vs v10) | **0 / 0 / 0 / 0 / 0** |
| final boards equal (state, grid, round) | **18 / 18** |
| known-phase decreases | **0** |
| JUNO-Y8V | 668 / 628 / 40, 632 applications, `OperatingRound 13`, **`b4fae877c35604fe`** |
| JUNO-3XD | 322 / 320 / 2, 323 applications, `StockRound 12`, **`74db6e4bad736fec`** |
| exact $5 ties | unchanged from UR-7 (0 among 247 Unpredictable Revenue runs) — UR-8 changed no rounding code |
| corpus file bytes | md5 identical before and after, on the owner's checkout and the clone |

A pure version-boundary change: no gameplay-board difference, nothing repinned.

### Q.8 Deferred items — preserved, nonblocking, routing unchanged

* **S10-11** — the unpinned (Firestore-era) path keeps the legacy Yellow Sign request, the debug chip and the legacy Mark
  without a removal record; the server's room document accepts `forced-sign` from any member. `DEFERRED` → AWS / live
  multiplayer (retire the path). Not a UR blocker: every pinned (server-dealt) table is under the certified authority.
* **S10-27** — the room's derived $0 withhold for a corporation left trainless at Dividends whose run earned (reproduced
  live by CG's Mark; a declined no-op, the board and money correct). `OPEN` → a later derived-action pass. Not a UR
  blocker (reachable with Gentle Rust alone; no board or money wrong).
* **U-41** — post-game statistics do not record a train-limit discard (standard games too). `OPEN` → the dedicated
  statistics / residual pass. Not a UR blocker.
* **U-43** — four pre-existing, non-UR statistics residuals (UR-5). `OPEN` → the same pass.
* **OD-UR-9 / UR-F16** — cryptographic hosted seed source: DECIDED, implementation deferred to AWS / live multiplayer
  (D-43). The server's seed source stays `randomTurnSeed`.
* **UR-F15** (INFO) — a pinned run without `revenue_seed` falls back to the hash; unreachable through the server.
* **Needs a harness, not a rule:** UR-N9 / X7 (Dynamic Stock Market × the die), UR-N11 (previews), UR-N24 (ephemeral
  cues), R12 (a distribution test on the seed source).
* **S10-21's non-UR remainder** (§Q.4) — the Bagholder / Little Engine detail formats and the long timeline on a completed
  game: recorded on S10-21's closure as generic epilogue coverage, cross-referenced from U-43 (the statistics / residual
  pass).
* **Delayed Auction** — still `DEFERRED — PRE-LAUNCH VARIANT CERTIFICATION REQUIRED` (S9-7).

### Q.9 Files changed (UR-8)

| file | change |
|---|---|
| `frontend/src/gameEngine/rulesVersion.ts` | `RULES_ENGINE_VERSION` 9 → **10**; changelog row 10 |
| `frontend/src/utils/unpredictableRevenueClosure.test.ts` | **new** — 19 tests: the bump; row 10's eight semantics and NOT RULES marker; the v10-only matrix with 9 as the prior version (a v9 Unpredictable Revenue + Gentle Rust room held); no version branch behind (1) – (8); the constructed game dealt at 10; the corpus unpinned, totals 4,105 / 3,731 / 374. **Owns the current version literal.** |
| `frontend/src/utils/gentleRustClosure.test.ts` | narrowed, version-literal only (GR-5's precedent for `stage10Closure`): current `>= 9`, a row prefix pin, the matrix reads the current version; row 9 and the v8 cases unchanged |
| `frontend/src/utils/unpredictableRevenueCertificationGame.test.ts` | "still 9" → `>= 10`, the deal's pin = `RULES_ENGINE_VERSION` (version literal only) |
| `frontend/src/utils/carcosaBloodPrice.test.ts` | J1 "still 9 — owed" → `>= 10`, "carried" (version literal only) |
| `frontend/src/utils/revenueTieRounding.test.ts` | "still 9 — owed" → `>= 10`, "carried" (version literal only) |
| `frontend/src/utils/unpredictableRevenueStats.test.ts` | "still 9" → `>= 9`, "UR-5 moved no version" (version literal only) |
| this document; the audit (rev 12); `RULES_HARDENING_BACKLOG.md` | the record |

No stored log, golden, fixture, export or corpus file was edited, migrated, repinned or regenerated. Historical "v9" /
"owed to row 10" wording in the UR-3 … UR-7 suites' comments and titles is left as written (those boards deal at
`RULES_ENGINE_VERSION`, so they now run at 10).

### Q.10 Validation (UR-8; the owner runs the full suite)

* **Focused Jest (cloud clone, corpus present): 151 suites / 3,215 tests, all passing** — every test file naming the
  variant, the Yellow Sign, Carcosa, the Blood Price, seeds / rounding, Gentle Rust, the version, `RoomSession` or
  `replayLog`, plus the closure, corpus, history / accolades and die suites (137 suites / 2,972 tests), and the 14 other
  suites that deal a `SetupGame` (243 tests). Against the v9 constant, the new closure suite and the three `>= 10`
  cases fail and the narrowed ones pass — they measure the boundary.
* **The owner's checkout, after the write-back** (blob hashes verified equal to the clone's; `CI=true react-app-rewired
  test --watchAll=false --maxWorkers=2`, five batches inside the 180-second window): `unpredictableRevenueClosure`,
  `gentleRustClosure`, `rulesVersion`, `unpredictableRevenueCertificationGame`, `carcosaBloodPrice`, `revenueTieRounding`,
  `unpredictableRevenueStats`, `stage10Closure`, `stage9Closure`, every `yellowSign*` Mark / run-bound / ingress /
  authority suite, `carcosaFogBoundary`, `carcosaSyntheticPhase`, `carcosaGildedExchange`, `yellowSignDebugChip`,
  `revenueRounding`, `roomSession`, and the corpus suites `replayJuno3XD`, `replayJunoCV4`, `replayGolden`,
  `moneyConservation`, `stage104HarnessHardening` — **25 suites, 485 tests, all pass**; `tsc` frontend and server 0 there
  too.
* `frontend tsc --noEmit`: exit 0. `server tsc --noEmit` (`server/tsconfig.json`, TypeScript 4.9.5): exit 0.
* Production build (`react-app-rewired build`, `GENERATE_SOURCEMAP=false`, cloud clone): exit 0, "Compiled with
  warnings", **49 ESLint warning lines, identical to the UR-7 tree built the same way**, plus the pre-existing
  "Critical dependency" notice. Not attempted on the owner's checkout (the 180-second window; it would write `build/`).
* Constructed game: §Q.6. 18-file corpus: §Q.7. `git diff --check`: clean.
* **Full Jest NOT run** (the owner's gate). **Nothing committed or pushed.**

### Q.11 Verdict

**READY FOR THE FINAL OWNER GATE.** Unpredictable Revenue — standalone and with Gentle Rust — is certified at
`RULES_ENGINE_VERSION` 10 once the owner's full-suite gate passes and UR-8 is committed. No blocker, no new owner
decision, no re-opened ruling.
