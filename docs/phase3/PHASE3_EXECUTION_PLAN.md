# Phase 3 — player-facing UI / UX: the execution plan

| | |
|---|---|
| **Status** | PLANNING RECORD. **Wave 1 is integrated provisionally on `phase3/wave1-integration` (2026-10-03)** — each slice carries its status line below; the matrix's "Wave-1 integration status" section and `phase3_accounting.json` (`slice_status`, row `status`) are the machine copy. Waves 2 and 3 are not started. |
| **Authoritative inputs** | [`PHASE3_UIUX_AUDIT_2026-10-03.md`](PHASE3_UIUX_AUDIT_2026-10-03.md) (the backlog) → [`PHASE3_AUDIT_RECONCILIATION.md`](PHASE3_AUDIT_RECONCILIATION.md) (one disposition per item) → this plan (how to execute). |
| **Planning snapshot** | `recon/phase1-remainder-hardening` @ `8e897f9c5196f825a69c492dfb7c29088123cf67`. Source facts and line numbers below were read there. **It is not the implementation base.** |
| **Implementation base** | **TBD — the final canonical integrated head after Phase 2 closes.** Pinned by the integrator at kickoff (OD-0, P0). Never `main`, `083d066`, `8e897f9` or a migration branch by default. **Wave 1 was built on `8f33f0fb72d462c381a572015de7860a93fbd198` by the owner's brief;** whether that is the OD-0 pin, or Wave 1 is carried onto the final post-Phase-2 head, is the owner's call, and OD-0's drift check against the final pin is still owed. |
| **Superseded draft** | [`archive/PHASE3_EXECUTION_MAP_DRAFT_2026-10-03.md`](archive/PHASE3_EXECUTION_MAP_DRAFT_2026-10-03.md). Its W-IDs are kept unchanged. Its OD-0 is replaced. |
| **Self-contained** | A future session needs only this directory and the repository. Everything needed to execute is written here (Appendix A carries the reference procedures). Project documents named in the text are provenance only: no step depends on reading them. |

---

## 1. Roadmap boundary (fixed by the owner)

```text
PHASE 1  server / infrastructure migration
PHASE 2  JUNO testnet live proof
PHASE 3  player-facing UI / UX            ← this plan
PHASE 4  human playtesting and stabilization
PHASE 5  major frontend / App.tsx refactor
PHASE 6  final polish / release testing
PHASE 7  mainnet readiness / launch
```

- **The major App.tsx refactor stays in Phase 5**, after Phase 3 and Phase 4 stabilization. This plan does not start it.
- **Allowed in Phase 3:** small, behaviour-preserving seams needed to implement a slice safely. Examples are hoisting an
  inline JSX expression into a plain `const` (P0's S1), or new logic in a pure `utils/*View.ts` helper with one App call site.
- **Not allowed in Phase 3:** extracting App.tsx regions into modules, a new state library, a router, an event bus,
  consolidating the whose-turn derivations, or replacing the shell's OR verdicts with `nextDerivedAction`. Those belong to
  Phase 5 (App decomposition audit §13).
- **Gameplay authority is unchanged.** The TypeScript reducer and the hosted server own all rules. Phase 3 makes the UI
  *read* that authority. A rules change is replay-affecting. It needs a rules-version bump and its own settlement
  certification, and it happens only through W3-K if OD-10(a) allows it.
- **Money is unchanged.** No contract, codec, payload, settlement byte, `FINANCIAL_PROTOCOL_VERSION` or escrow semantics move
  in Phase 3. Money slices (W1-K, W2-K, W2-M) are browser UX only.
- **The roadmap documents still show the old order** (`ROADMAP_3_2_REMAINING_WORK.md`, `PROJECT_CANONICAL_CONTEXT.md` §B,
  backlog Part F place UI/UX after the frontend refactor). P0 updates them (AUD-00.02).

---

## 2. Base pin and kickoff (OD-0 → P0)

**OD-0 — PHASE-3 BASE PIN.** At Phase-3 kickoff, the integrator pins the FINAL canonical integrated post-Phase-2 head and
confirms all of the following. **No implementation starts before this pin.**
1. **No unique local frontend work exists outside it.** In the owner's real checkout, read-only:
   `git status --short`, `git stash list`, and `git log --oneline --branches --not <pin> -- frontend/src`. Every branch with
   frontend commits not in the pin is either already contained in it, or the owner rules it in or out. Unpushed local work is
   asked about explicitly.
2. **The Phase-3 planning facts still apply.** Run
   `python3 docs/phase3/check_phase3_accounting.py --drift <pin>` and `git diff --stat 8e897f9 <pin> -- frontend/src`.
   For each changed file that the matrix cites, re-read the affected rows and update their CURRENT-SOURCE STATUS (and
   disposition if an item turned out resolved) in the matrix and JSON. Re-anchor this plan's App.tsx regions by
   **identifier**, not line number (§5 gives both).
3. **Any drift is reconciled before P0's code step.** The accounting check passes against the pin.

#### P0
**Kickoff: pin, drift reconciliation, the one seam, conventions, roadmap order** · integrator · serial · **2.5–3.5 h**
- **Status (Wave-1 integration, 2026-10-03):** PARTIAL — only the S1 seam landed (L1 `42c67ee`); the OD-0 drift check, the conventions publication and the roadmap-order update (AUD-00.02) were not run.
- **Outcome:** a pinned base, a reconciled matrix, branch `phase3/integration` created from the pin, S1 applied, the lane
  table published, and the roadmap documents in the fixed Phase 1–7 order.
- **Audit items:** implements AUD-00.02
- **Surfaces:**
  - OD-0 steps 1–3 above. Record the pin's full SHA in `docs/phase3/README.md`.
  - **S1 seam.** Hoist the inline `passDisabledReason={…}` expression (`App.tsx` bar mount, `passDisabledReason={` …
    `turnActionTaken=`, about 14001-14036 at the snapshot) into a plain `const passDisabledReason = …` just above the
    component's `return (`. Use a plain `const`, not `useMemo`, so it recomputes every render as today. It stays in `App.tsx`,
    so `readShell().toContain` pins still hold.
  - **Conventions** (no code): S3 — add each new import beside a related import, never at the tail. S4 — insert new bar
    props inside the lane's own prop group, never at the end of the mount. New tests use the `utils/sourceScan.ts` readers
    (`readShell`, `sliceBetween`, `readStripped`), never raw `readFileSync` with `\n` anchors (CRLF on the owner's
    Windows checkout). New suites are named `phase3<Slice><Topic>.test.ts(x)`.
  - **Roadmap order:** update `ROADMAP_3_2_REMAINING_WORK.md`'s phase list and backlog Part F's UI-placement paragraph to
    the Phase 1–7 order in §1. Do not rewrite anything else.
- **Acceptance:** zero behaviour change; the re-anchored `phase65bShellWiring` passes; `tsc --noEmit` clean; the accounting
  check passes against the pin.
- **Focused tests:** `utils/phase65bShellWiring.test.ts`, `utils/sourceScan.test.ts`, `utils/sourceGuards.test.ts`.
- **Pins likely to move:** `phase65bShellWiring` `sliceBetween("passDisabledReason={", "turnActionTaken=")` → re-anchor on
  the const. Its `expectOrder` still holds.
- **Depends on:** Phase 2 closed; OD-0.

---

## 3. What the reconciliation changed

Full matrix: [`PHASE3_AUDIT_RECONCILIATION.md`](PHASE3_AUDIT_RECONCILIATION.md). Summary:

| | Count |
|---|---|
| Substantive audit items accounted | **258** = 167 audit rows + 91 flourish-ledger rows (47 PLAYTEST, 21 recorded decisions, 23 OPEN) |
| Dispositions of audit items | A 61 · B 62 · C 20 · D 69 · E 2 · F 44 · G 0 (at planning: B 59 · C 23; AUD-09.10 moved C → B with OD-7, 2026-10-03; AUD-07.03 and AUD-20.01 C → B at the safe Wave-2 integration) |
| NEW-SOURCE-FINDINGS kept from the draft (`P3-N001`…`P3-N026`) | 26 (A 23 · B 0 · C 0 · D 0 · E 1 · F 2 · G 0) — P3-N024 (SBS-4) moved C → G under OD-2 (needs precise reproduction), then P3-N023 (SBS-3) C → A and P3-N024 G → A in W3-K (rules v13) |
| Orphaned audit items | **none** (machine-checked) |
| Audit items the draft had lost and that are now placed | about 45. They include A-14, A-21, A-13's policy, log export, the auction-owed indicator, I-1/I-2/I-3/R4, A-8, A-5, A-17, U-41/U-43, H-06, U-7/U-8/GR-3, A-20, the intro-overlay and portal decisions, ING-2/I-6, the 23 OPEN flourish items, A-19, Host Game a11y and responsive, A-10/A-11/A-12, JX-3A E-1…B-3, JX-6C/6E, S10-12, K-24, DA6-O2's remaining site, U-32/U-33 copy, DA6-n, the waiting-room line, U-28 and the GitHub-issues gap |
| Audit claims not reproduced in source (now F, re-confirmed at the final head in W3-F) | tile picker Escape; S10-1; DA6-O1; UR-F20 copy; seat PIN dialog; K-24's Close Room tooltip; K-24's on-chain copy |
| Existing W IDs renumbered | **none** |
| New slices | W1-M, W1-N, W1-O, W2-L, W2-M, W3-G, W3-H, W3-I, W3-J, W3-K (conditional); W1-I-b (conditional sub-scope) |

---

## 4. Waves, lanes and dependencies

### 4.1 Lanes: 7 engineering lanes + 1 integrator

The draft proposed 6 lanes, and the 6-lane split still holds for the draft's slices. The reconciled backlog adds a body of
work that is **disjoint by file** from the six: the money UX (`frontend/src/money/`, `components/money/`), Host Game
(`HostSetupCard`, `UiScalePicker`, `utils/uiScale.ts`), the post-game statistics (`utils/gameHistory.ts`) and the game-over
and room-close surfaces (`GameOverModal`, plus three App regions nobody else owns). That becomes **lane 7**. With it, lanes 5
and 6 stay within the critical-path length instead of exceeding it. An eighth lane has nothing disjoint left to own.

| Lane | Owns (files / regions) | Sequence |
|---|---|---|
| **L1 · Stock Round & auction** | `StockRoundPanel.tsx`, `WaterfallAuctionDashboard.tsx`, `PlayerCards.tsx`; App R-SRBLOCK, R-AUTOBUY, R-UNDOLABEL, R-WATERFALL, R-SRPANEL; bar prop group "stage"; CAB stage block; S1 const during wave 1 | W1-B, W1-A → W2-B |
| **L2 · Private powers / M&H / D&H** | `privatePowerFlow.ts`, `activePrivatePower.ts`, `PrivatePowerFlowModal`, `BuyLicenseModal`; App R-PRIVEXCH, R-DHPOWER, R-JK; bar prop group "powers"; CAB power chips + JK chip; `actionLog.ts` until W2-E lands | W1-C → W2-E → W1-M → W2-D → W3-B (→ W3-K if OD-10a) |
| **L3 · Offers, consent & holds** | `PrivateTradePanel.tsx`, `TrainPurchasePanel.tsx`, the prompt components, `PrivateCompaniesSection.tsx` pointer; App R-PRIVPROP, R-TRAINPROP, R-TRADEPANEL, R-CONSENT; bar prop group "holds/purchase"; S1 const from W2-A on; CAB contextualButtons, embedded private purchase | W1-D → W2-A → W2-C → W2-F → W3-I |
| **L4 · Map, tile, token, routes, flourish** | `RadialTileSelector.tsx`, `HexGridRenderer.tsx`, `RoutePlannerPanel.tsx`, flourish modules, `utils/audio.ts`; App R-RECEIPT, R-RUN, R-TOKENCLICK, R-TILELAY (until W1-E lands), R-BOARD, R-HEXIND, R-RING; CAB route tooltip + route chip | W1-E, W1-F, W1-G → W3-H (→ W3-E if OD-11) |
| **L5 · Shell, status, notices, modals** | `ContextualActionBar.tsx` probe/tooltips, `FinancialLedger.tsx` (wave 1), `HomeStationPrompt.tsx`, `AuctionPromptModal.tsx` (until W2-H lands), `TopBar.tsx` (after W1-N's one prop), `EmergencyTrainPurchaseModal.tsx`, `TopBar.tsx`, notice modals, `TutorialModal`, `GameIntroOverlay`, `NativeModal`/`ModalPortal`; App R-TUT, R-DOCKOBS, R-NOTICES, R-HOMEPROMPT (until W2-H lands), R-EMERG, R-TOPBAR (after W1-N), R-ROOMSTRIP, R-DOCK, R-RRMOUNT | W1-I, W1-J → W2-G, W2-H, W2-I (, W1-I-b) → W3-A, W3-D |
| **L6 · Copy, narration, refusals** | `RulesReference.tsx` (except L5's marker and build-id lines), `TileReference.tsx`, `utils/refusedAction.ts`, `utils/actionLog.ts` after W2-E, runbooks, backlog Part C; App banner model only through W3-C | W1-L, W1-H → W2-J → W3-C → W3-G (read-mostly; may start earlier whenever L6 is idle once wave 1 is integrated) |
| **L7 · Money, Host Game, statistics, endgame** | `frontend/src/money/`, `components/money/`, `HostSetupCard.tsx`, `UiScalePicker.tsx`, `utils/uiScale.ts`, `utils/gameHistory.ts`, `GameOverModal.tsx`, `CrashScreen.tsx`, `utils/closeRoomPayout.ts`; App R-ENDTIMER, R-LOGEXPORT, R-GAMEOVER, R-TOPBAR (wave 1 only), R-ROOMHANDLERS (`handleLeaveSandboxRoom`, wave 1); `RulesReference.tsx` breakpoint block (W1-O) | W1-K, W1-N, W1-O → W2-K, W2-L, W2-M |
| **Integrator** | `phase3/integration`; P0; every merge and rebase; the shared multi-region pin suites; W3-F; dispatching W3-J | — |

**Rules.** One writer per lane at a time, in an isolated clone or worktree on its own branch. Never two simultaneous
writers to one App.tsx region (§5). The integrator lands branches one at a time on `phase3/integration` and rebases the next.
Nobody pushes except as the owner authorizes. The real checkout has one writer.

### 4.2 Waves and gates

| Wave | Contents | Ends with |
|---|---|---|
| **0** | P0 (serial) | narrow checks + accounting PASS |
| **1** | W1-A … W1-O, all lanes in parallel. No owner decision needed except where a slice notes one; owner decisions OD-1…OD-18 are taken **during** wave 1 | owner broad gate #1 |
| **2** | W2-A … W2-M, once their dependencies and ODs are in | owner broad gate #2 |
| **3** | W3-A … W3-D, W3-H, W3-I (+ W3-E, W1-I-b, W3-K if ruled in); W3-G runs from the start of wave 2 (read-mostly); W3-J takes W3-G's findings | owner broad gate #3 |
| **Close** | W3-F | final owner broad gate on the integrated Phase-3 head; Phase-4 baseline recorded |

**Broad gates are checkpoints, not barriers.** Each gate runs on the integrated head at the wave milestone while lanes keep
working on slices whose dependencies have landed. A gate failure blocks further landings that touch the failing area until the
owning lane fixes it. If the owner prefers gates as barriers (no wave-N+1 landing before gate N passes), the wall-clock
estimate in §10.2 rises; the barrier figure is given there too.

### 4.3 Dependency edges (beyond lane order)

- **P0 → everything.**
- **W1-B → W2-A.** W1-B's K-15 sentence lands in the S1 const before lane 3 takes the const (so L1 runs W1-B first).
- **W1-I → W2-A.** CAB's Skip tooltip (3501) and the "$0 dividend" tooltip (1988, inside contextualButtons) are edited by
  W1-I before lane 3 takes those regions.
- **W1-E → W2-A.** They share `tileLayDisabledReason`; R-TILELAY passes from lane 4 to lane 3.
- **W1-D → W2-A → W2-C → W2-F.** They share the `trainPurchase` / `privatePurchase` objects, the consent block and the prompts.
- **W2-A → W2-B, W2-D.** The hold arm reaches Pass and the chips first.
- **W1-A → W2-B.** **W1-C → W2-D, W2-E.** **W1-L → W2-E, W2-I** (`RulesReference.tsx`). **W2-E → W2-J** (`actionLog.ts`
  hand-over). **W1-J → W2-H.** **W1-N → W2-I** (`TopBar.tsx` / R-TOPBAR hand-over).
- **Wave-1 `RulesReference.tsx` writers** (W1-L L6, W1-I L5, W1-O L7) edit disjoint line ranges; the integrator lands them in
  the order W1-L → W1-I → W1-O and rebases each.
- **W2-H → W3-I** (`AuctionPromptModal` and R-HOMEPROMPT's prop hand-over from lane 5 to lane 3). **W2-H → W3-D**; W3-D does
  not touch `HomeStationPrompt` / `AuctionPromptModal` (W2-H settles both).
- **W3-H → W3-B** (W3-B's token-confirm and route-edit latches are in L4's R-RING / R-RUN, handed over once W3-H lands).
  **W3-B → W3-E** (if W3-E is built).
- **W1-I → W3-H** (`FinancialLedger.tsx`). **W1-B → W3-H** (`WaterfallAuctionDashboard.tsx` palette).
- **Wave 1 integrated → W3-G starts.** **W3-G → W3-J → W3-F.**
- **ODs:** OD-1 → W2-A, W2-F, W2-H, W2-G (viewer scope). OD-2 → W2-B. OD-3 → W2-E. OD-4 → W2-G. OD-5 → W3-A. OD-6 → W2-I.
  OD-7 / OD-8 / OD-12 → W2-J. OD-9 → W2-K. OD-10 → W3-K and the phone-width scope. OD-11 → W3-E. OD-12 → W3-B, W3-C,
  W3-I, W1-N (call site only), W3-A, W3-H. OD-13 → W2-L. OD-14 → W1-I(-b), W3-H. OD-15 → W3-D. OD-16 → W2-M's Terms page. OD-17 → W3-K. OD-18 → AUD-11.04, AUD-19.04.

---

## 5. Collision map

### 5.1 App.tsx regions (line numbers at the planning snapshot; anchor by identifier after the pin)

| Region | Identifier anchor | Lines @8e897f9 | Owner | Slices, in order |
|---|---|---|---|---|
| R-IMPORTS | the import block | 1–822 | everyone (S3) | — |
| R-TUT | `replayTutorials` effect | 1080–1083 | L5 | W3-A |
| R-DHPOWER | `usedPrivateAbilities`, `dhStationForfeited`, `deriveActivePowerFlow` call | 1090, 3389–3436 | L2 | W1-M |
| R-JK | `jkPowerOffer` | 2123–2135 | L2 | W2-D |
| R-ENDTIMER | `gameEndedAt`, `roomClosed`, close timer | 2142–2171 | L7 | W1-N |
| R-NOTICES | Herald / PhaseThree / PrivateRevenue state | 1453, 2075, 2519, 5541 | L5 | W3-A |
| R-DOCKOBS | status-dock `ResizeObserver` (`useState(96)`) | 3104–3123 | L5 | W1-I |
| R-RECEIPT | "no upgrade" receipt | 3811 | L4 | W1-E |
| R-PRIVEXCH | `runPrivateExchange`, `handlePowerFlowAct` | 5831–5885 | L2 | W1-C |
| **RED R1 — submit half** | `runGameplayAction` (the callback opens at 6108) — submit half | 6227–6468 | none | only via OD-12 (W3-C: 6425–6427; W3-B: the `press:true` latch) |
| **RED R2 — apply half** | `runGameplayAction` apply | 6469–8758 | none | only via OD-12 (W2-J: 7111–7123; W1-N: 7828–7834; W3-H: 7580–7614 if needed) |
| **RED R3 — rebuild** | `rebuildSandbox` | 8877–8965 | none | — |
| R-UNDOLABEL | undo labels map (`WaterfallMiniAuctionPass`) | 8998 | L1 | W1-B |
| R-LOGEXPORT | Ctrl+Shift+L handler, `copySandboxLog` | 9104–9144 | L7 | W1-N |
| R-SRBLOCK | `purchaseBlockFor` / `saleBlockFor` | 9561–9624 | L1 | W1-A |
| R-AUTOBUY | Auto-Buy effect | 9886–9969 | L1 | W1-A |
| R-RUN | `handleRunTrains` pre-dispatch and run marking; route edits | 10003–10283 | L4 → L2 (latch only) | W1-G → W3-B (after W3-H) |
| R-PRIVPROP | `handleProposePrivatePurchase` and the private answer handlers | 10416–10442 (+ answers nearby) | L3 | W1-D |
| R-TOKENCLICK | `handleTokenHexClick` | 10600–10650 | L4 | W1-F |
| R-TRAINPROP | train-proposal and chain-era trade handlers | 10945–11120 | L3 | W1-D |
| **RED R4 — OR verdict / auto-skip** | the OR verdict block (incl. the fleet-loss prune 11295–11405) | 11136–11659 | none | only via OD-12 (W3-A, if the dismissal-store fix is not enough) |
| R-TILELAY | `tileLayDisabledReason` and the lay helpers | 11742–12241 | L4 → L3 | W1-E → W2-A (hold arm only) |
| **RED R5 — link drain** | link callbacks / drain | 12278–12681 | none | only via OD-12 (W3-C: 12567–12640; W3-I if a queue read cannot be done outside it) |
| R-ROOMHANDLERS | room handlers after the drain: banner writers, `handleLeaveSandboxRoom` | 12682–13283 | L7 (wave 1) → L6 (wave 3) | W1-N (`handleLeaveSandboxRoom` 12768–12781) → W3-C (banner writers 12694–12778) |
| R-GATEPAGES | early-return gate screens | 13284–13360 | none | — |
| R-HOMEPROMPT | `HomeStationPrompt` / `AuctionPromptModal` mounts | 13510–13563 | L5 → L3 | W1-J → W2-H → W3-I (`AuctionPromptModal` queued-state props) |
| R-EMERG | emergency modal mount and its state | 1925–1964, 13565–13605 | L5 | W2-G |
| R-GAMEOVER | `GameOverModal` mount, `onLeaveGame`, `onCloseRoom` | 13610–13660 | L7 | W1-N |
| R-TOPBAR | `<TopBar` mount | 13676–13699 | L7 (wave 1) → L5 | W1-N (`onCopyGameLog` prop) → W2-I |
| R-ROOMSTRIP | room strip / room code | 13700–13800 | L5 | W2-I |
| R-DOCK | `actionDock` container | 13829 | L5 | W1-I |
| R-BAR | `<ContextualActionBar` mount | 13882–14310 | per prop group ↓ | — |
| ↳ S1 const | `passDisabledReason` (after P0) | above `return (` | L1 (wave 1) → L3 (W2-A on) | W1-B → W2-A |
| ↳ group "powers" | `powerOffers`, JK props | ~13960, ~14110 | L2 | W2-D |
| ↳ group "stage" | `stockStage` | 14042–14046 | L1 | W2-B |
| ↳ group "holds/purchase" | `trainPurchase`, `privatePurchase`, new `turnHoldReason` | 14188–14192 + new | L3 | W2-A, W2-C |
| R-WATERFALL | `WaterfallAuctionDashboard` mount | 14399–14420 | L1 | W1-B |
| R-TRADEPANEL | chain-era `TrainTradePanel` mount | 14460–14485 | L3 | W1-D (delete) |
| R-SRPANEL | `StockRoundPanel` mount | 14496–14600 | L1 | W1-A, W2-B |
| R-BOARD | `HexGridRenderer` mount (`gameId` / `protocolId` gating) | 14621–14707 | L4 | W1-F |
| R-RRMOUNT | `RulesReference` mount props | 14911–14921 | L5 | W1-I, W2-I |
| R-HEXIND | hex click indicator | 14949–14989 | L4 | W1-F |
| R-CONSENT | consent / offer prompt slot | 15180–15250 | L3 | W1-D → W2-F |
| R-RING | ring mount, `onSelectCandidate`, `canConfirm`; token confirm | 15326–15436 | L4 → L3 (one line) → L2 (latch) | W1-E → W2-A (token `canConfirm` hold arm) → W3-B (after W3-H) |

**No two lanes own one region at the same time.** Every hand-over in the table is ordered by a dependency edge in §4.3.
The RED regions have no owner. A slice edits one only with the owner's explicit OD-12 permission, naming the exact lines,
as one separately reviewed commit.

**OD-12 RULED (2026-10-03):** narrowly controlled RED-region bug fixes are authorized — never an App.tsx refactor. The
Wave-1 integration made exactly one: W1-N's R2 `settleRoomPayout(...)` call site, deleted as its own independently reviewed
commit (`87d63c4`). The remaining candidates below keep the one-commit, one-review rule and this order.

**RED serialization rule.** At most one RED commit is open at a time across all lanes. The integrator grants them in this
order, and each lands and is rebased before the next starts: W2-J (R2 K-18) → W1-N (R2 call site, if permitted) → W3-H (R2,
only if needed) → W3-C (R1 + R5) → W3-B (R1 `press:true`) → W3-I (R5, only if needed) → W3-A (R4, only if needed).

### 5.2 `panels/ContextualActionBar.tsx` (CAB) regions

| Region | Lines @8e897f9 | Owner | Slices |
|---|---|---|---|
| fit probe | 713–806, 1465, 4566–4570 | L5 | W1-I |
| contextualButtons | 1826–2117 | L3 | W2-A |
| "$0 dividend" tooltip | 1988 | L5 | W1-I (wave 1, before W2-A) |
| power chips / M&H chip | 2168–2240 | L2 | W2-D |
| route tooltip (K-26) | 3449 | L4 | W1-G |
| Skip button | 3488–3505 | L5 (tooltip text, wave 1) → L3 (disable, W2-A) | W1-I → W2-A |
| route chip feedback | 3777–3790 | L4 | W1-F |
| stage block + Pass | 4150–4210 | L3 (hold arm, W2-A) → L1 (W2-B) | W2-A → W2-B |
| JK chip render | 4377 | L2 | W2-D |
| embedded private purchase | 4450–4462 | L3 | W2-C |

### 5.3 Other files with more than one slice

| File | Regions / order |
|---|---|
| `components/RulesReference.tsx` | L6 owns copy (W1-L; RR-4 also W1-L since OD-7 — landed at the Wave-1 integration). L5 owns the step marker (84, 972–979, 3386–3390; W1-I), the build-id line (5412–5415; W1-I) and the game-over state (83, 2409–2414, 3310; W2-I). L2 owns the M&H block (1392–1419; W2-E). Disjoint line ranges; land W1-L before W2-E and W2-I |
| `utils/actionLog.ts` | L2 (W2-E: 514–522) → L6 (W2-J) |
| `components/FinancialLedger.tsx` | L5 (W1-I: 161–189) → L4 (W3-H: TrainChips events) |
| `components/WaterfallAuctionDashboard.tsx` | L1 (W1-B) → L4 (W3-H: palette) |
| `components/AuctionPromptModal.tsx` | L5 (W2-H) → L3 (W3-I) |
| `utils/activePrivatePower.ts` | L2 only (W1-M → W2-D) |
| `gameEngine/endgame.ts` | L7 only (W1-N; display placeholder only; ranking untouched) |
| `gameEngine/gameState.ts` | L1 only (W1-B: `PRIORITY_DEAL_TOOLTIP` string) |
| `utils/roomSession.ts` | L6 only (W1-H: pass `marketZoneFor` to the refusal describer; no state change) |
| Multi-region pin suites (`phase65bShellWiring`, `doubleActionWindow`, `batch49`, `batch57`, `actionReceipt`) | Collide in the test files, not in App.tsx. The integrator rebases each landing |

### 5.4 Seams

- **S1** (P0): hoist `passDisabledReason` to a plain const. Recommended and behaviour-neutral; moves one pin.
- **S3 / S4** conventions (P0). Insertions one or more lines apart merge cleanly; appends at the same tail conflict.
- **Pure helpers:** new logic goes into `utils/*View.ts` with one App call site (the 6.5-B pattern).
- **No safe seam (do not try):** the hex chooser (`stationVeil` pins its indentation); the RED regions; moving the consent slot
  into `src/shell/` (that would set a Phase-5 precedent).
- **Characterization:** `AppShell` is not exported, so Phase-3 regressions are component- and helper-level plus source pins.

---

## 6. Slices

Each slice lists: outcome · audit items (from the matrix) · NEW-SOURCE findings · surfaces · App.tsx regions · acceptance ·
focused tests · pins likely to move · dependencies · owner gates · Phase-4 observations · estimate (Claude labor, including
the slice's own tests and narrow runs). **Run only narrow, directly affected tests** (project rule); the owner runs broad
gates.

### Wave 1

#### W1-A
**Stock Round reads one authority** · L1 · **8–10 h**
- **Status (Wave-1 integration, 2026-10-03):** COMPLETE — L1 `82c1de9` (Stock Round reads one authority).
- **Outcome:** every Buy and Sell control is enabled exactly when the server would accept it and is greyed with the server's
  own sentence. Selling and buying are no longer forced through UI stages. Auto-Buy disarms with a reason instead of stalling.
- **Rows:** implements AUD-03.01 (U-23 / K-19), AUD-03.02 (U-25), AUD-03.03 (U-39 / K-07), AUD-03.05 (K-12), AUD-03.06 (SBS-5); is Phase-3 pre-work for the Phase-4 rows AUD-03.12 (S-4), AUD-24.03 (K-12 stall)
- **Surfaces:** `App.tsx` `purchaseBlockFor` / `saleBlockFor` → wrap `stockPurchaseRefusal` (pass `parValue`) and
  `stockSaleRefusal` (`gameEngine/stockTransactionAuthority.ts`); delete the two shell-only stage refusals. Auto-Buy: check
  must-sell (`divestmentDebt`) before the stage Pass; check cash through the new wrapper. `StockRoundPanel.tsx`
  `CompanyActions`: `cannotAfford`, `multiBuyMax` → `maxPurchaseQuantity`; the source toggle → `ordinaryPercentAvailable`;
  `sellOptionState` and `BANK_POOL_CAP_PERCENT` → the sale predicate; `sellingForbidden` → `isFirstStockRound`. The SR1
  tooltip states rulebook §5.1 as the rule, not a "Project 18XX" choice.
- **App.tsx regions:** R-SRBLOCK, R-AUTOBUY, R-SRPANEL.
- **Acceptance:** every Buy/Sell `disabled` equals the predicate's verdict for the viewer; SR1 Sell greyed with the
  authority's sentence; a 0% or reserved-only source never offers Buy; LPF allows the fifth Pool certificate; Auto-Buy with
  too little cash disarms with the reason.
- **Focused tests:** a `CompanyActions` component matrix (SR1, unparred, Brown Pool, LPF 20% card, reserved C&A share,
  insufficient cash); an Auto-Buy decision test.
- **Pins likely to move:** `sellBuySell.test.ts:160-180` (stage sentences); `phase65bShellWiring` `saleBlockFor` order;
  `presidentCertificateSale:347`; `reducerReadsOneChart:76`; `autoBuy.test:125,223`; `blockPropThreading:77-83`.
- **Depends on:** P0. **Gates:** none. **Phase-4:** AUD-03.12 (S-4), AUD-24.03 (K-12 stall).

#### W1-B
**Auction dashboard sync** · L1 · **5–6 h**
- **Status (Wave-1 integration, 2026-10-03):** COMPLETE — L1 `f0a7183` + review fixes `76056b7`.
- **Outcome:** a player can raise their own standing bid; the contest Pass says what it does and how close the contest is to
  ending; the dashboard cannot double-send; a Delayed-Auction solvency refusal shows before the click; the Priority Deal
  tooltip is true mid-round.
- **Rows:** implements AUD-02.01 (K-02 / U-26), AUD-02.02 (K-15), AUD-02.03, AUD-02.04 (H-04), AUD-11.01 (K-16), P3-N005 (draft A1-new)
- **Surfaces:** `WaterfallAuctionDashboard.tsx` reads `waterfallBidRefusal` / `waterfallBuyRefusal` (which include
  `acquisitionSolvencyRefusal`) instead of `repeatBidReason` / `bidRejectionReason`; relabel "Drop out … refunded in full" to
  the rule's meaning ("Pass — your bid stands") and fix the bidder list; render `passes_since_raise`; sibling cards show the
  contest sentence instead of "Not your turn yet". `App.tsx`: the K-15 sentence inside the S1 const; the Undo label "the last
  drop-out"; the dashboard `sessionReady={controlsEnabled && !actionInFlight}`. `PlayerCards.tsx` and
  `gameEngine/gameState.ts` `PRIORITY_DEAL_TOOLTIP`: a sentence that is true during an SR and the auction (it may describe
  the rule rather than name a seat).
- **App.tsx regions:** R-UNDOLABEL, R-WATERFALL, S1 const (one line, wave 1 only).
- **Acceptance:** an own-bid raise is enabled at `minimumBidFor(…, raisingFrom)` and sends the increment; no Bid/Buy the
  authority refuses is ever shown enabled; the dashboard is greyed while a send is in flight; no "refunded" copy remains.
- **Focused tests:** a rendered-dashboard click test (own-bid raise, contest pass label, in-flight disable, DA
  solvency-refused board). `disabledLook` needs ≥4 disableable controls.
- **Pins likely to move:** none known for the copy; check `disabledLook`, `doubleActionWindow`.
- **Depends on:** P0. **Gates:** none.

#### W1-C
**M&H exchange reads the authority; the owner picks the source** · L2 · **4–5 h**
- **Status (Wave-1 integration, 2026-10-03):** COMPLETE — L2 `91b537f`; modal presentation follow-up at the integration (`8dc79e0`).
- **Outcome:** the M&H flow offers exactly the legal exchanges, from the IPO or the Bank Pool as the player chooses (owner
  ruling: the choice is required).
- **Rows:** implements AUD-10.02 (U-35 (i/ii)), AUD-10.04 (K-03)
- **Surfaces:** `App.tsx` `runPrivateExchange` → `mhExchangeRequestRefusal` per source; `handlePowerFlowAct` passes the
  chosen source; `utils/privatePowerFlow.ts` adds a step per legal source; `PrivatePowerFlowModal`. Stop calling
  `resolvePrivateExchange` (App is its only caller). **Keep** `gameEngine/privateExchange.ts`'s other exports: the reducer
  imports them.
- **App.tsx regions:** R-PRIVEXCH.
- **Acceptance:** the Orange/Brown 60% waiver is honoured; the certificate limit is checked; both sources are offered when
  both are legal, only the legal one otherwise; no silent IPO-first.
- **Focused tests:** a flow-model test over the source matrix; a room test that the chosen source is the one sent.
- **Pins likely to move:** `powerRefusalAndChips:43-76`, `mhStockRoundChip`, `privatePowerFlow:216-224`,
  `privateExchange.test.ts`.
- **Depends on:** P0. **Gates:** none.

#### W1-D
**Proposer rescind; retire the chain-era trade controls** · L3 · **5–6 h**
- **Status (Wave-1 integration, 2026-10-03):** COMPLETE — L3 `94e5df1` + review fixes `3dbf02b`; rescind Activity Log lines at the integration (`8dc79e0`).
- **Outcome:** whoever proposes an OR private or train purchase can withdraw it; dead chain-era controls are gone; only the
  authority's answerer can answer; nothing is narrated as complete before it lands; the four prompts are latched.
- **Rows:** implements AUD-09.01 (U-21), AUD-09.04 (K-05), P3-N006 (draft W1-D), P3-N007 (draft W1-D), P3-N008 (K-14 (6.5 register))
- **Surfaces:** new rescind handlers beside the private and train proposal handlers, sending `RescindPrivatePurchase` /
  `RescindTrainPurchase` on turn with **no** `offTurn` (keeps `trainOffer.test`'s count of 7); delete the `RescindTrainOffer`
  handlers and the `TrainTradePanel` mount; the consent block gains `viewerIsProposer` / `onRescind`;
  `TrainPurchasePanel.tsx` and `PrivateTradePanel.tsx` prompts; answerer identity from `currentPrivateOwner` /
  `sellerPresident`; drop the optimistic "completed immediately" lines; pass `actionInFlight` to the four prompts.
- **App.tsx regions:** R-PRIVPROP, R-TRAINPROP, R-TRADEPANEL, R-CONSENT.
- **Acceptance:** Rescind visible to the proposer only and accepted by the server; no chain-era control mounted; the answer
  offered only to the authority's answerer; no completion line before the entry lands.
- **Focused tests:** a `phase65bConsentPrompts`-style render test (proposer, answerer, third seat, watcher); a `RoomSession`
  rescind test for both offer kinds.
- **Pins likely to move:** `trainOffer.test`, `privateOffer.test`, `panels/inactiveTurnBar.test.ts`, `phase65bShellWiring`
  consent slice.
- **Depends on:** P0. **Gates:** none. **Lane 3 owns R-CONSENT and the prompt components to the end of Phase 3.**

#### W1-E
**Tile ring correctness** · L4 · **5–7 h**
- **Status (Wave-1 integration, 2026-10-03):** COMPLETE — L4 `43a641f` + review follow-ups `bee2717`; canonical tile name in the ring refusal at the integration (`8dc79e0`).
- **Outcome:** the ring opens on a legal facing and cannot confirm a lay the server will refuse; errata tiles are named
  canonically on the receipt and in aria labels.
- **Rows:** implements AUD-05.01 (U-38), P3-N010 (draft W1-E), P3-N011 (LOW-4 (R12-2 report)); is Phase-3 pre-work for the Phase-4 rows AUD-05.04
- **Surfaces:** `onSelectCandidate` seeds from `stationLegalFacings`; one memo asks `layTileRefusal` (with the board's rules
  revision, LOW-4) for the previewed lay and feeds `canConfirm` and its tooltip; `tileLayDisabledReason` →
  `layTimingRefusal` / `layTileRefusal`; correct the false comments; latch the ring confirm; U-38 receipt and
  `RadialTileSelector.tsx` aria labels via `canonicalTileName`.
- **App.tsx regions:** R-RECEIPT, R-TILELAY (hands its hold arm to L3 when this lands), R-RING.
- **Acceptance:** on a tokened upgrade the preview opens on a legal facing; Confirm is greyed with the authority's sentence on
  an illegal facing; the receipt names the canonical tile.
- **Focused tests:** a pure test of the facing seed and of the `canConfirm` memo inputs.
- **Pins likely to move:** `utils/stationConnectivity.test.ts` asserts exactly 3 matches of `derivePreviewLandings(`
  followed by a line break (true at the snapshot; a plain-text count finds 4). Do not add a multi-line call. Also
  `previewRotation`, `previewTokenLanding`, `roundTripPaint`.
- **Depends on:** P0. **Gates:** none. **Phase-4:** AUD-05.04 (first facing).

#### W1-F
**Map click precedence, visible station refusals, hex indicator placement** · L4 · **3–4.5 h**
- **Status (Wave-1 integration, 2026-10-03):** COMPLETE — L4 `9baf4da`.
- **Outcome:** a home-station click never also opens the tile ring; a refused station click says why on the map; hex click
  indicators sit under the cursor at every uiScale.
- **Rows:** implements AUD-01.05 (A-21), AUD-05.02 (A-7), P3-N012 (draft NEW-1-map)
- **Surfaces:** withhold `gameId` / `protocolId` from the board while a home-station errand is armed (render-time, no new
  refs); `handleTokenHexClick` writes its reason through `showActionToast` (implementation default) instead of the
  Routes-only `routeFeedback`; correct `hexClickIndicator` positioning for the zoomed root (`styles/appStyles.ts`).
- **App.tsx regions:** R-TOKENCLICK, R-BOARD, R-HEXIND.
- **Acceptance:** with a home errand armed, a click opens only the station ring; a dimmed-city click at Tokens shows the
  evaluator's reason; the indicator is within 2 px of the cursor at 63%, 100% and 150% scale.
- **Focused tests:** a renderer prop-gating test; a feedback-routing test; an indicator-position test.
- **Pins likely to move:** none known (`stationVeil`'s chooser indentation pin is untouched).
- **Depends on:** P0. **Gates:** none.

#### W1-G
**Route preview reads the route authority; Run Trains marks only what it sent** · L4 · **3.5–5 h**
- **Status (Wave-1 integration, 2026-10-03):** COMPLETE — L4 `a8b9f27` + review follow-ups `bee2717`.
- **Outcome:** the Run button prices and counts only routes the server accepts; a weaker-than-maximum set is explained beside
  the routes; when nothing is sent, nothing is marked run.
- **Rows:** implements AUD-04.02 (A-17), AUD-07.01 (K-11), AUD-07.02 (K-26), AUD-07.04 (S6-13), P3-N013 (draft W1-G)
- **Surfaces:** the pre-dispatch check → `routeSetRefusal`; `isRunnableDraft` / `runnableRouteSummary` → `runnableDrafts`;
  feedback when drafts are dropped; the K-26 tooltip (`ContextualActionBar.tsx`:3449); when `turnRoutes` is empty, do not set
  `ran:true` or advance to Dividends, and show why; retire the unmounted `RoutePlannerPanel` component's second refusal order.
- **App.tsx regions:** R-RUN.
- **Acceptance:** projected revenue equals what is sent; no draft disappears silently; an all-dropped run leaves the step at
  Run Routes with a reason.
- **Focused tests:** `runTrainsRules`-style pure tests; an empty-run regression.
- **Pins likely to move:** `atomicRunRoutes:180` (exactly one dispatch between `runnableDrafts(` and `setLiveOrSubPhase(`).
- **Depends on:** P0. **Gates:** none. *(The refused-run rollback is P3-N020 in W3-C.)*

#### W1-H
**Refusals carry their reason** · L6 · **3.5–4.5 h**
- **Status (Wave-1 integration, 2026-10-03):** COMPLETE — L6 `2e0700b` + review fixes `cb0c49c`.
- **Outcome:** the Activity Log never prints REFUSED without a reason; client wording matches the server's.
- **Rows:** implements AUD-14.03 (U-30), AUD-14.04 (U-29), AUD-14.05 (ING-2 / I-6)
- **Surfaces:** `utils/refusedAction.ts`: use `stockPurchaseRefusal` / `stockSaleRefusal`; add arms for `pendingOfferBlock`,
  `homeStationHold`, `Propose*` / `Rescind*` / `*PrivateTrade`, the Pass-with-train-owed case (ING-2); pass `marketZoneFor`
  on the server path (`utils/roomSession.ts`:915) so BuyStock refusals carry the zone reason. Align divergent client
  sentences with the server's (I-6).
- **App.tsx regions:** none.
- **Acceptance:** for every refusal arm the log line equals the authority's sentence.
- **Focused tests:** `refusedAction.test` cases per arm; a room test for a server-path BuyStock refusal.
- **Pins likely to move:** `refusedAction.test`.
- **Depends on:** P0. **Gates:** none.

#### W1-I
**Dock hygiene and status facts** · L5 · **5–6.5 h**
- **Status (Wave-1 integration, 2026-10-03):** PARTIAL — the unconditional portion is complete (L5 `9dcad19`, `b9fd1bf`, `82b93ca`, `beac07a`, `3904533`, `fee2f66`); OD-14(a) remains (the fit-probe removal, AUD-01.01, waits on it, and W1-I-b exists only if it is ruled in).
- **Status (2026-10-04):** COMPLETE on its slice branch `phase3/w1-i-completion` @ `195755a` (from `phase3/wave3-i-w2i-w2j-w3c-w3g-v13cert-integration` @ `d29bb2f`); NOT integrated. OD-14(a) RULED (§7.3): keep the current step-panel placement and remove the probe; W1-I-b not opened. AUD-01.01 IMPLEMENTED (`1b76512` + review fix `195755a`: `useStickyFitProbe`, its readout and style removed; `stickyFitProbe.test.ts` deleted, its three non-probe blocks carried verbatim into `stepPanelCopy.test.ts`; `stickyTrap`, `stepJumpButton`, `stickyBarSplit` re-anchored); AUD-01.02 RULED — resolved by OD-14(a).
- **Outcome:** no developer text or temporary instrument in front of players; the dock's height follows its content; the bank,
  build and current-step facts are true.
- **Rows:** implements AUD-01.01 (U-16), AUD-01.04 (A-14), AUD-01.08, AUD-06.07, AUD-12.01 (K-23 / U-27), P3-N014 (draft NEW-5), P3-N015 (draft W1-I), P3-N016 (draft W1-I (U-34 note)); carries the owner-gated AUD-01.02 (U-16); is Phase-3 pre-work for the Phase-4 rows AUD-11.06 (U-34)
- **Surfaces:** `ContextualActionBar.tsx`: remove `useStickyFitProbe` (after the owner has recorded OD-14(a); the probe's
  readout may be captured for that decision first); rewrite the Skip tooltip and the "$0 dividend" tooltip (the latter is
  pinned by `appNaming`). `App.tsx`: make the status-dock observer attach once its ref exists (A-14); `role` / `aria-label`
  on the dock. `FinancialLedger.tsx`: "Bank broken — owes $N" and percentages clamped to the true paid share.
  `RulesReference.tsx`: `CLIENT_BUILD_ID` instead of `UI_BUILD_NOTE = 640`; a home-station pre-step marker while
  `pendingHomeToken` is owed (App passes it through R-RRMOUNT). `utils/operatingOrderView.ts` note wording.
- **App.tsx regions:** R-DOCKOBS, R-DOCK, R-RRMOUNT.
- **Acceptance:** no `useStickyFitProbe` symbol; the dock's measured height tracks content (expanded ticker/chat never covers
  content); the ledger never shows a negative bank or >100%; the Rules Reference marks the home-station step while owed.
- **Focused tests:** a ledger render test; a dock-observer test; `rulesOverview:743-751`.
- **Pins likely to move:** delete `utils/stickyFitProbe.test.ts` with the probe; adjust `stickyTrap`, `stickyBarSplit`;
  `appNaming` ("$0 dividend" string).
- **Depends on:** P0. **Gates:** OD-14(a) before the removal commit. **Conditional sub-scope W1-I-b** (wave 2, L5, 3–5 h):
  only if OD-14(a) = "move the step panels into the bar".

#### W1-J
**The watcher's home-station form** · L5 · **0.5–1 h**
- **Status (Wave-1 integration, 2026-10-03):** COMPLETE — L5 `5a56987`.
- **Rows:** implements AUD-06.03 (A-2)
- **Change:** `viewerIsPresident` → `!spectator && president === viewerAddress` (no `!viewerAddress` arm), with a regression
  for a seatless watcher.
- **App.tsx regions:** R-HOMEPROMPT (first touch; W2-H follows in the same lane).
- **Focused tests:** `homeStationWait`, a new watcher regression. **Depends on:** P0.

#### W1-K
**Cross-tab Keplr single flight** · L7 · **2.5–3.5 h**
- **Status (Wave-1 integration, 2026-10-03):** NOT STARTED — not one of the seven Wave-1 lane branches.
- **Rows:** implements AUD-19.02 (U-45)
- **Change:** take a cross-tab lock (`navigator.locks` with a storage-lease fallback) **before** Keplr opens, in
  `money/moneyActions.ts` / `money/pendingTx.ts`; the second tab is told another tab is opening the table.
- **Acceptance:** two tabs pressing "Open the table on Juno" before either signs open Keplr once.
- **Focused tests:** a two-tab simulation test. **App-free.** No contract, payload or protocol change.
- **Depends on:** P0.

#### W1-L
**Rules Reference and copy that need no ruling** · L6 · **4–5.5 h**
- **Status (Wave-1 integration, 2026-10-03):** COMPLETE — unconditional portion, L6 `de22084` + review fix `8d6f1e9`; RR-4 copy per OD-7 at the integration (`ca73834`). AUD-18.07 stays owner-gated (OD-14(e)).
- **Rows:** implements AUD-05.01 (U-38), AUD-07.05 (RR-1), AUD-09.11 (RR-7), AUD-18.04 (U-40), AUD-18.06 (DA6-n), AUD-21.02 (DA6-O2), AUD-21.03 (RR-3), AUD-21.04 (RR-5), AUD-21.05 (U-32), AUD-21.06 (U-33); carries the owner-gated AUD-18.07
- **Surfaces:** `RulesReference.tsx` (RR-1, RR-3, RR-5, RR-7; the remaining must-sell site without the curable-only
  qualifier at ~1903; the home-station timing text; the presidency tie text checked against the engine; the U-40 sentence
  establishing the Rules Reference as the final player-facing authority and any remaining player-facing "1830" / "1830+"
  terminology; DA6-n name case); `TileReference.tsx` canonical tile names (U-38); a parity test that
  `SUB_PHASE_DISPLAY` equals `OPERATING_SUB_PHASE_LABELS[*].stepLabel` (S10-14 stays a Phase-5 consolidation); the waiting
  room's description line only if OD-14(e) says change it; refresh `PLAYTEST_TRANSPORT.md` / `PLAYTEST_NGROK.md` wherever
  Phase-3 renames a player-visible surface.
- **App.tsx regions:** none.
- **Focused tests:** `rulesOverview`, `rulesTables`, `stage93TileAuthority`, `phase65bTerrainCopy`, `appNaming`.
- **Depends on:** P0. Land before W2-E and W2-I (shared file, disjoint ranges).

#### W1-M
**D&H free station survives a reload** · L2 · **2–3 h** · *new*
- **Status (Wave-1 integration, 2026-10-03):** COMPLETE — L2 `6f42dca`.
- **Rows:** implements AUD-06.05 (A-5)
- **Change:** in `utils/activePrivatePower.ts` / the App call site, also offer the free station when the board's
  `dh_station_pending` names the D&H company and the viewer is its president, even if the local `usedPrivateAbilities` set
  is empty after a reload. Leave the local set and `dhStationForfeited` otherwise untouched (DH-3 / SI invariant).
- **App.tsx regions:** R-DHPOWER.
- **Acceptance:** lay via the D&H power, reload, then the free station is offered and accepted in the same turn; nothing
  changes when `dh_station_pending` is absent.
- **Focused tests:** an `activePrivatePower` reload test on a board built through a room.
- **Pins likely to move:** `activePrivatePower.test`.
- **Depends on:** P0. **Phase-4:** AUD-06.06 (DH-2).

#### W1-N
**Game over, room close and log export** · L7 · **4–5.5 h** · *new*
- **Status (Wave-1 integration, 2026-10-03):** COMPLETE — L7 `9d9376b` + review fixes `06c3a91`; the OD-12 RED R2 call-site deletion `87d63c4` (+ comment follow-up `819a204`); tie-aware game-over strip at the integration (`8dc79e0`).
- **Rows:** implements AUD-01.09, AUD-12.04 (H-06), AUD-18.01 (A-12), AUD-18.02 (A-10), AUD-18.03 (A-11), AUD-20.09 (K-24)
- **Surfaces:** `GameOverModal.tsx` badges every rank-1 row as WINNER (ranking unchanged); `onLeaveGame` goes to the Lobby;
  the auto-close deadline derives from the board's game-end moment, not a tab-local `Date.now()` (if the board carries no
  end timestamp, use the server's close deadline; do not add state); `onCloseRoom` reads `roomClosed` from the live board,
  never the scrubbed snapshot; a visible "Copy game log" button in `TopBar.tsx` (a new `onCopyGameLog` prop, passed
  at R-TOPBAR) and on `CrashScreen.tsx` (same `copySandboxLog`); K-24: remove the floating-point placeholder payout from `gameEngine/endgame.ts`'s display output and make
  `utils/closeRoomPayout.ts` a no-op without arithmetic (deleting the App call site in RED R2 needs OD-12).
- **App.tsx regions:** R-ENDTIMER, R-LOGEXPORT, R-GAMEOVER, R-TOPBAR (one prop; hands over to L5), R-ROOMHANDLERS (`handleLeaveSandboxRoom`).
- **Acceptance:** a tie shows every tied WINNER; Leave lands on the Lobby; a refresh after game end keeps the same deadline;
  Close Room never reappears while scrubbing; the log can be copied from the shell and the crash screen; no floating-point
  payout is computed.
- **Focused tests:** GameOver render (tie); a scrubbed-snapshot `roomClosed` test; a crash-screen export test; an
  `endgame` placeholder test. **Pins likely to move:** any `endgame` / `rankPlayers` display pin (no settlement vector moves).
- **Depends on:** P0. **Gates:** OD-12 only for the App call-site deletion.

#### W1-O
**Host Game accessibility, responsive, zoom-aware breakpoints** · L7 · **3.5–5 h** · *new*
- **Status (Wave-1 integration, 2026-10-03):** COMPLETE — L7 `2c3134f` + review fix `b19dff5`; the RulesReference breakpoint hunk at the integration (`8dc79e0`).
- **Rows:** implements AUD-16.02, AUD-16.03, AUD-16.04, AUD-16.05, AUD-17.01, AUD-17.02, AUD-17.03
- **Surfaces:** `HostSetupCard.tsx` (`aria-describedby` to each option's description; Home/End in the radio group; a
  focus style that keeps the accent visible; footer reachable at 360 px — sticky or reordered); `UiScalePicker.tsx`
  (label the value "chosen" or "automatic"); `utils/uiScale.ts` (when storage throws, say the choice will not be
  remembered in this window); the existing viewport `@media` rules (e.g. `RulesReference.tsx` 5508–5587) become
  zoom-aware (container queries or a uiScale-aware width) so a layout switches at the same effective width at every
  scale. A phone-width game-shell layout is not this slice (OD-10(b)).
- **Acceptance:** keyboard-only Host Game works with Home/End; the footer's primary button is visible without scrolling at
  360×640; the readout states the provenance.
- **Focused tests:** HostSetupCard keyboard/ARIA tests; a uiScale storage-failure test; a breakpoint test at two scales.
  **App-free.**
- **Depends on:** P0; its `RulesReference.tsx` hunk lands after W1-L and W1-I.

### Wave 2

#### W2-A
**Holds visible everywhere** · L3 · **8–10 h**
- **OD-1 RULED (2026-10-03, §7.3):** ordinary non-active-player behaviour stays; **non-active players keep seeing the active corporation's route/train information and dividend choices/consequences during Run Routes and Dividends**; an offer's hold gives every player a clear "Waiting on X / what is being decided" status, the legitimate answerer keeps Accept/Reject, the proposer keeps Rescind where legal, and unrelated controls do not pretend play can continue. Status: COMPLETE — ACCEPTED and INTEGRATED into `phase3/wave2a-integration` (slice `phase3/w2-a-authoritative-holds` @ `2d0fd0a`, carried linearly onto `bfb7635`). W2-C, W2-D and W2-F are unlocked by it; W2-B was blocked on W3-K's v13 semantics until the v13 integration (`phase3/wave2a-v13-integration`, 2026-10-04), and is now UNLOCKED (see W2-B).
- **Outcome:** while any authoritative hold stands (discard, funding, offer, home token), no seat sees a live control the
  server would refuse, and every seat reads the same sentence.
- **Rows:** implements AUD-04.01 (K-13 / U-22), AUD-06.02 (K-21), P3-N001 (draft §0.4 "dead arms"), P3-N002 (draft NEW-2 (OR bar)), P3-N009 (draft NEW-1 (blockedReason))
- **Surfaces:** one new bar prop `turnHoldReason`, computed by a new pure helper `utils/dockHoldView.ts` (both new) from
  `authoritativeHoldRefusal` with one call site; consumers in `ContextualActionBar` (contextualButtons, Skip, Pass);
  `App.tsx`: the hold arm in `tileLayDisabledReason`, the token `canConfirm`, `trainPurchase.blockedReason` (replace the dead
  chain `trainOffers` read), `privatePurchase`; the S1 const loses its dead arms.
- **App.tsx regions:** S1 const, group "holds/purchase", R-TILELAY (hold arm), R-RING token confirm (one line, with L4's
  agreement after W1-E landed).
- **Acceptance:** for each hold × {answerer, proposer, president, other seat, watcher}, Skip / End Turn / Lay / Buy are greyed
  with the hold's sentence exactly when the server would refuse them.
- **Focused tests:** a pure `dockHoldView` matrix; a rendered-bar test.
- **Pins likely to move:** `phase65bShellWiring`, `utils/homeTokenGate.test.ts`, `homeStationWait`, `blockPropThreading`.
- **Depends on:** W1-D, W1-E, W1-B landed. **Gates:** OD-1. **Must land before:** W2-B, W2-C, W2-D.

#### W2-B
**Stock Round turn presentation** · L1 · **3–4 h**
- **OD-2 RULED (2026-10-03, §7.3):** Sell whenever legal; at most one Buy; after buying, Buy is unavailable but Sell remains; the button is **"Pass Turn"** and ends the turn in ONE click; the Sell → Buy → Sell stage walk is superseded. Changing `PassTurn`'s replay semantics is a rules change, so the rule lands in the dedicated **v13 rules slice** (W3-K's vehicle) with its settlement certification; this slice presents it. Wave-1's `sellBuySell` pins are interim (v12) until then. The rule landed in W3-K (rules v13, revision 2); **this slice is required before v13 deploys** (with W1-A and the removal of Auto-Buy's stage Pass). Status: COMPLETE on its slice branch `phase3/w2-b-stock-round-v13-ui` (code `90d5588`, review fix `ca68b43`, #1274 fix `794e03c` / `699160c`; from `868bd83`); NOT integrated.
- **Rows:** implements AUD-03.04 (SBS-1 / SBS-2), AUD-03.07
- **Surfaces:** the bar stage block; `stockStage`; a must-sell banner in `StockRoundPanel` from `divestmentDebt`. Implements
  the audit's target: **one Pass / End Turn control** that ends the turn in one press, without a forced sell → Pass → buy
  walk. How that control is realised under v12 rules (it sends the two `PassTurn`s itself) is fixed by OD-2. **A rules
  change (Pass always ends the turn) is not this slice**; it is v13 and W3-K.
- **App.tsx regions:** group "stage", R-SRPANEL. **Focused tests:** `sellBuySell`, `sellIsNotAPass`; a banner render test.
- **Depends on:** W1-A, W2-A. **Gates:** OD-2.
- **Status (2026-10-04): COMPLETE on its slice branch** `phase3/w2-b-stock-round-v13-ui` (code `90d5588`, review fix `ca68b43`, #1274 fix `794e03c` / `699160c`; from `868bd83`), **ACCEPTED and INTEGRATED on `phase3/wave2-bcg-v13cert-integration` (merge `181e51e` of `3fc3d0e`, 2026-10-04)**: one "Pass Turn" control (one `PassTurn`, in every state), the stage block / `stockStage` and the revision-1 copy removed, Auto-Buy's stage Pass removed and no Pass after its purchase (`autoBuyTurnStep`; #1274), the must-sell banner from `divestmentDebt`; no reducer change. Focused tests: `phase3W2BStockRoundPassTurn`, `sellBuySell`, `sellIsNotAPass`.

#### W2-C
**Offer panels read their authority** · L3 · **3–4 h**
- **Status:** COMPLETE on its slice branch `phase3/w2-c-offer-authority` @ `0975c04` (code `e629687` + review fixes `0975c04`, from `96ccb22`); **ACCEPTED and INTEGRATED on `phase3/wave2-bcg-v13cert-integration` (merge `904598a` of `c3db730`, 2026-10-04)**, reconciled onto v13 with no code change: on revision 2 the train roster's `proposeTrainPurchaseRefusal` reaches `fundedTradeRefusal`, so Propose dies once the emergency trade window closes (Wave-2A v13 residue R1 CLOSED; `phase3W2CGTrainWindow.test.tsx`).
- **Rows:** implements AUD-09.02 (U-21), AUD-09.03 (U-20)
- **Surfaces:** `PrivateTradePanel.tsx` → `proposePrivatePurchaseRefusal`; `TrainPurchasePanel.tsx` →
  `proposeTrainPurchaseRefusal` / `trainSaleRefusal`; latch the embedded `ProposePrivatePurchase`; a regression that
  corporation-owned privates are not offered.
- **App.tsx regions:** group "holds/purchase"; CAB embedded private purchase.
- **Focused tests:** a panel matrix at the ½× / 2× band edges, the treasury, a corporation-owned seller, the same-president
  shortcut. **Depends on:** W1-D, W2-A.

#### W2-D
**M&H request off-turn and in the OR; the JK chip** · L2 · **3.5–4.5 h**
- **Status:** COMPLETE on its slice branch `phase3/w2-d-mh-offturn-jk` @ `f0abdd7` (code `db50c38` + review fixes `a7488ff` + tracking `f0abdd7`, from `phase3/wave2-bcg-v13cert-integration` @ `9b19d9d`); **ACCEPTED and INTEGRATED on `phase3/wave2-bcgd-v13cert-integration` (merge `4072fd0` of `f0abdd7`, 2026-10-04)**: the M&H request offered in the Stock and Operating Rounds as an `offTurn` chip readied on `offTurnPowerReady`, its hold `dockHold.exchangePrivate`; the JK chip only in OR Track, its arm keyed on `jkArmScope`.
- **Rows:** implements AUD-04.03 (A-8), AUD-10.05 (K-04), P3-N003 (draft M1)
- **Surfaces:** `utils/activePrivatePower.ts` (offer the M&H request in the OR; JK only in the OR, disarmed at OR end); exempt
  the M&H chip from `sessionReady`'s turn component; the chip's blocked reason adds `authoritativeHoldRefusal`.
- **App.tsx regions:** R-JK, group "powers". **Pins likely to move:** invert `activePrivatePower.test:122`;
  `mhStockRoundChip`.
- **Depends on:** W1-C, W2-A.

#### W2-E
**M&H queued-request visibility** · L2 · **4–5 h**
- **Rows:** implements AUD-10.03 (K-17), AUD-10.06 (U-35 (iv)), AUD-10.07 (U-35 (v) / RR-6)
- **Surfaces:** `utils/actionLog.ts` branches on `afterState.pending_mh_exchange` ("requested" vs "exchanged"); a
  table-visible marker from `pending_mh_exchange`; a requester acknowledgement; the cancellation line per OD-3; RR-6 / U-35(v)
  copy in `RulesReference.tsx` 1392–1419. If OD-3 asks for the cancellation reason from the engine, that is v13 → W3-K.
- **App.tsx regions:** group "powers" only. The table-visible marker is the M&H power chip's own state ("Exchange
  requested — runs at …", CAB power-chip region, L2) plus the log lines. `actionLog.ts` is owned by this slice until it lands;
  W2-J follows.
- **Depends on:** W1-C, W1-L. **Gates:** OD-3.
- **Safe Wave-2 integration (2026-10-03):** COMPLETE — `4f998b8` + RR-6 `91037ce`, integrated (`09fcb25`). W1-C's explicit IPO / Bank Pool choice is unchanged (no substitution); the marker, log and RR-6 copy read `pending_mh_exchange`.

#### W2-F
**One "waiting on X" surface** · L3 · **4.5–6.5 h**
- **OD-1 RULED (2026-10-03, §7.3):** ordinary non-active-player behaviour stays; **non-active players keep seeing the active corporation's route/train information and dividend choices/consequences during Run Routes and Dividends**; an offer's hold gives every player a clear "Waiting on X / what is being decided" status, the legitimate answerer keeps Accept/Reject, the proposer keeps Rescind where legal, and unrelated controls do not pretend play can continue. Status: **COMPLETE on its slice branch** `phase3/w2-f-waiting-surface` @ `8d4e9f5` (code `5a0bf37` + review fixes `8d4e9f5`, from `phase3/wave2-bcgd-v13cert-integration` @ `7d8f73e`); **ACCEPTED and INTEGRATED on `phase3/wave2-bcgdf-v13cert-integration` (merge `dfe6d13` of `f19a22b`, 2026-10-04)**; the owner accepted the I-3 stand-aside; the scroll-to-card LOW stays deferred. One waiting line in the five consent / discard prompts from the one hold answer (`dockHold.standingOffer` / `.turnHoldReason`); the player-trade pointer stands aside on the Stocks tab; the Stock Round share controls read `dockHold.buyStock` / `.sellStock` / `.shareControls`.
- **Rows:** implements AUD-03.10 (I-3), AUD-09.08 (U-5), AUD-09.09 (U-6)
- **Surfaces:** the consent slot and the four prompt components read one sentence from `describeStandingOffer`; the discard
  prompt (U-5) joins it; the 400 px pointer is repositioned so it never covers the Private Companies card.
- **App.tsx regions:** R-CONSENT. **Depends on:** W1-D, W2-A. **Gates:** OD-1.

#### W2-G
**Emergency funding modal** · L5 · **4–5.5 h**
- **OD-1 RULED (2026-10-03, §7.3):** the obligated president gets the interactive emergency controls; everyone else gets a simplified status/notification that the named player / corporation is resolving an emergency train purchase. **OD-4 RULED (2026-10-03, §7.3) and implemented in W3-K (rules v13):** before this slice starts it must be reconciled to the v13 authority — no player "Declare bankruptcy" (refused on revision 2), one `EmergencySellPortfolio` instead of single forced sales, `ForgoTrainTrade` / `ForgoPrivateFunding`, an automatic purchase and an automatic bankruptcy (`emergencyFundingFor(...).automatic`). Status: **COMPLETE (2026-10-04) — ACCEPTED and INTEGRATED on `phase3/wave2-bcg-v13cert-integration` (merge `b84247f` of `17ab21f`).** `phase3/w2-g-v13-emergency-ui` (from `868bd83`; code `112fa71`, review fixes `02d73b8`) reconciles the accepted UI (`695afe9`) to the v13 authority above: `ForgoTrainTrade`, ONE `EmergencySellPortfolio`, private funding only while exactly relevant with `ForgoPrivateFunding`, the automatic purchase as a status and the automatic bankruptcy, no `DeclareBankruptcy`. Until it is integrated, no shipped UI sends the three v13 emergency messages.
- **Rows:** implements AUD-09.05 (K-25), AUD-09.06 (A-9), AUD-09.07 (U-4), P3-N017 (draft OD-4), P3-N018 (draft W2-G)
- **Surfaces:** `EmergencyTrainPurchaseModal.tsx` (whole file this phase): close/back per OD-4; "Bank Pool" vs "Bank Depot"
  from the train's actual source; funding-offer legality → `fundingPrivateOfferRefusal`; "Declare bankruptcy" only for the
  president; latch; the minimal-UI polish of U-4. `App.tsx` mount and state.
- **App.tsx regions:** R-EMERG. **Pins likely to move:** `walletDialogDismissal:357-362` (asserts no `onClose`);
  `moneyVocabulary:96-108`; `emergencyTrainFlow`.
- **Depends on:** P0. **Gates:** OD-4, OD-1 (viewer scope).

#### W2-H
**Waiting-player prompts** · L5 · **3–4 h**
- **OD-1 RULED (2026-10-03, §7.3)** — the viewer scope above. Status: **COMPLETE** — `phase3/w2-waiting-prompts` @ `461d4f0`, integrated at the safe Wave-2 integration (`66977d5`).
- **Rows:** implements AUD-02.07 (H5 (auction)), AUD-06.01 (K-21 / U-32), AUD-06.04 (H5 (home station))
- **Surfaces:** `HomeStationPrompt.tsx` and `AuctionPromptModal.tsx` per OD-1 (banner or read-only card for non-actors, with
  a focus target); "has floated" → timing-true copy. Migrating either to `NativeModal` edits
  `nativeModalBoundary.test.tsx`'s exclusion list.
- **App.tsx regions:** R-HOMEPROMPT. **Pins likely to move:** `homeStationWait:88`, `nativeModalBoundary`.
- **Depends on:** W1-J. **Gates:** OD-1. **Hands `AuctionPromptModal` to L3 for W3-I when it lands.**

#### W2-I
**Status visibility** · L5 · **2.5–3.5 h**
- **Rows:** implements AUD-02.08, AUD-11.03; carries the owner-gated AUD-01.07
- **Surfaces:** a standing "auction owed" / "auction cancelled by the first 5-train" indicator (not gated); the Rules
  Reference's game-over state; per OD-6, the game id, build id and rules version in `TopBar.tsx` / the room strip.
- **App.tsx regions:** R-ROOMSTRIP, R-RRMOUNT. **Depends on:** W1-L. **Gates:** OD-6 (game id / version placement only).
- **OD-6 RULED (2026-10-04, §7.3) — Option A:** game_id remains undisplayed; the Rules Reference diagnostic line shows Build ID + authoritative rules version. Status: COMPLETE on its slice branch `phase3/w2-i-status-visibility` @ `a18bac4` (code `c17e844` + review fix `a18bac4`, from `phase3/wave3-i-v13cert-integration` @ `7a9b16b`); NOT integrated. AUD-01.07 (C → B, DECIDED), AUD-02.08 (the room strip's delayed-auction owed / cancelled chip), AUD-11.03 (the Rules Reference's game-over state) IMPLEMENTED. **ACCEPTED and INTEGRATED on `phase3/wave3-i-w2i-v13cert-integration` (merge `78f9164` of `60146da`, 2026-10-04).**

#### W2-J
**Narration corrections** · L6 · **4–6 h**
- **Wave-1 integration (2026-10-03):** RR-4's copy is **done** (OD-7 ruled: copy only, `ca73834`) and leaves this slice. **OD-12 ruled:** K-18's RED R2 edit may land as its own separately reviewed commit (§5.1 order). **OD-8 RULED (2026-10-04, §7.3) — Option A.** Status: **COMPLETE on its slice branch** `phase3/w2-j-narration` @ `99b5651` (from `phase3/wave3-i-w2i-v13cert-integration` @ `c774530`; K-18 RED R2 commit `b328e53`, K-20 `464dfbe` + review fix `5f5ddd2`, K-22 `8a448d2` + review fixes `99b5651`); **ACCEPTED and INTEGRATED on `phase3/wave3-i-w2i-w2j-v13cert-integration` (merge `32ead52` of `0b33f69`, 2026-10-04).** AUD-03.08, AUD-10.01 and AUD-03.09 IMPLEMENTED.
- **Rows:** implements AUD-03.08 (K-18 / U-36), AUD-03.09 (K-22 / U-37), AUD-10.01 (K-20 / U-33). *(It carried the owner-gated AUD-09.10 (RR-4) until OD-7 was ruled copy-only; that copy landed in W1-L at the Wave-1 integration.)*
- **Surfaces:** K-18 — pass the before-board's market positions to `soldOutRises` (RED R2 7111–7123: OD-12); K-20 — a
  presidency-change sentence with the tie-break reason; K-22 — the float line per OD-8. (RR-4's copy, once listed here "if OD-7
  rules 'any legal purchase'", is done: OD-7 ruled it and it landed in W1-L.)
- **App.tsx regions:** RED R2 only under OD-12. **Pins likely to move:** `shellNarration`, `parMarkArrival`.
- **Depends on:** W2-E. **Gates:** OD-7, OD-8, OD-12.

#### W2-K
**Money copy conventions** · L7 · **2–3 h**
- **Rows:** carries the owner-gated AUD-18.05 (U-15), AUD-20.01 (U-44)
- **Surfaces:** one time helper replaces the three `hhmm` copies (U-44 per OD-9(a)); the server copy in
  `server/src/escrow/moneyTables.ts` changes only if OD-9(a) picks local-with-zone; the Keplr logo (U-15) per OD-9(b).
- **Pins likely to move:** `moneyVocabulary`, money panel tests. **Gates:** OD-9.
- **Safe Wave-2 integration (2026-10-03):** OD-9(a) RULED (§7.3). PARTIAL — `e223f64` (exact SHA verified), integrated (`fb4eee5`): one local-with-zone formatter, relative server refusal copy, machine evidence UTC, the OD-14(i) panel pass. AUD-20.01 C → B. **The official Keplr logo is ASSET PENDING** (AUD-18.05; an empty slot, nothing fabricated).

#### W2-L
**Post-game statistics residuals** · L7 · **4–6 h** · *new*
- **Rows:** implements AUD-12.02 (U-41), AUD-12.03 (U-43); carries the owner-gated AUD-12.07 (GR-3 label)
- **Surfaces:** `utils/gameHistory.ts` (and `accolades.ts` where needed): U-41 — book a train-limit discard as fate
  `discarded`, Rust Belt / Gravedigger per the ruling; U-43 (1)–(4) per the ruling. Derived statistics only: no reducer,
  replay, golden or settlement change. Keep the Map key order that the accolades' tie order depends on.
- **Focused tests:** `gameHistory`, `accolades`, `roundReplay` cases per sub-item. **Gates:** OD-13.
- **Safe Wave-2 integration (2026-10-03):** COMPLETE — `e16aa5a`, integrated (`615e183`). Derived history only; AUD-12.07 keeps "traded" (owner-gated, OD-14(d)).

#### W2-M
**Wallet and dispute UX** · L7 · **5–7 h** · *new*
- **Rows:** implements AUD-20.02 (JX-3A E-1), AUD-20.03 (JX-3A E-2), AUD-20.04 (JX-3A E-3), AUD-20.05 (JX-3A B-3), AUD-20.06 (JX-6C), AUD-20.07 (JX-6E); carries the owner-gated AUD-20.08 (S10-12)
- **Surfaces:** `money/moneyFlow.ts`, `money/moneyActions.ts`, `money/useMoneyTable.ts`, `money/keplrWallet.ts`,
  `components/money/*`: a stale proof shows "re-prove" instead of "Wallet linked" (E-1); replacing a wallet uses one Keplr
  prompt where the server allows it (E-2); specific expiry messages (E-3); a Keplr rejection is classified as rejected (B-3);
  re-read the chain through the pinned endpoint before building a Challenge (JX-6C); the dispute confirm shows the deadline
  time, and the band shows the dispute record (JX-6E); host the owner-authored Terms page and link it before the first
  deposit control (content per OD-16).
- **Constraints:** browser UX only. No contract, payload, codec, settlement, `FINANCIAL_PROTOCOL_VERSION` or server
  money-route change. If E-2 needs a server change, stop and record it for the owner.
- **Focused tests:** `src/money/`, `src/components/money/` suites touched. **Gates:** OD-16 (Terms content).
- **Status (2026-10-04):** PARTIAL — NOT INTEGRATED. `phase3/w2-m-wallet-dispute-ux` from `c0a44d7`: implementation
  `90a3608`, review fixes `8d34474` + `5c7334b`. AUD-20.02–20.07 IMPLEMENTED (browser only; no server, contract, payload,
  codec, settlement, protocol, rules or App.tsx change). AUD-20.08 stays OWNER-GATED on OD-16 (nothing hosted). Server
  follow-ups for the owner: project the wallet proof's `verified_at` (exact E-1 freshness after a reload); a
  `replace-required` answer spends the link challenge (the server-asked replacement costs a second signature).
- **Follow-ups (owner-approved 2026-10-04; the browser-only boundary relaxed for exactly these):** AUD-20.13
  IMPLEMENTED (the room view's `you.link.proofVerifiedAt`, the stored proof time) and AUD-20.14 IMPLEMENTED
  (`wallet-challenge` names the wallet a link would replace before Keplr signs; single use and replay unchanged), in
  `a97b1d1` + `9637ca7`. The roster's "Wallet linked" is accepted temporarily (linkage, not proof freshness).
- **Design direction (owner, 2026-10-04):** the Profile + Keplr flow is PROVISIONAL and expected to be substantially
  redesigned/rebuilt later. Until then: do not deepen coupling to it, add abstractions to preserve today's UX, make the
  roster tag a wallet/proof authority, or spread the linkage/proof distinction to more surfaces unless correctness needs
  it; prefer minimal, easily removed compatibility changes. A constraint on later work, not a claim that today's flow
  is the desired final design.
- **OD-16 RULED (transcribed 2026-10-04, §7.3):** W2-M builds the Terms route / page shell and the Terms / deposit link infrastructure; the substantive copy is owner-authored and never invented, and the final Terms are a Phase-7 / mainnet gate.

### Wave 3

#### W3-A
**Notices, focus target, stacking, tutorials** · L5 · **5.5–7 h**
- **Rows:** implements AUD-01.03 (Batch 4B), AUD-01.06 (A-13), AUD-11.02, AUD-13.02 (Batch 4B), AUD-13.07 (A-20), P3-N019 (draft NEW-1 (fleet loss))
- **Surfaces:** a game-screen heading as the focus target for forced notices; one notice/modal policy (which notice yields,
  chaining, restore target) applied to PrivateRevenue / FleetLoss / PhaseThree / Herald; one-shot notices persisted or
  derived per OD-5; FleetLoss over-fire fixed in the dismissal store (per-game, not per-tab); a guard so two native modals
  never stack; tutorials re-arm only per OD-5's policy.
- **App.tsx regions:** R-TUT, R-NOTICES (RED R4's prune only under OD-12). **Pins likely to move:** the Batch 4A/4B modal
  suites, `nativeModalBoundary`.
- **Depends on:** W2-G, W2-H. **Gates:** OD-5 (+ OD-12 if needed). **Phase-4:** AUD-13.08.
- **OD-5 (2026-10-04):** only the tutorial ORDERING is ruled — tutorial work (AUD-01.06's re-arm effect) waits for the final tutorial/UI pass, after the shell/UI has stabilized. The notice-persistence, focus / yield-order and re-arm POLICY questions are still OPEN; nothing in W3-A is built from them until the owner approves them.
- **Status:** OD-5 RULED (2026-10-04, §7.3). COMPLETE on its slice branch `phase3/w3-a` (from `d29bb2f`: OD-5 transcription `9962745`, implementation `b70f087`, RED R4 `e8b9504`, review fixes `ac78dc9` + `ce705b2` + `ce6afe8`); **NOT INTEGRATED.** OD-12 followed: the one RED R4 edit (`e8b9504`) is its own independently audited commit. AUD-01.03, AUD-01.06, AUD-11.02, AUD-13.02, AUD-13.07, P3-N019 IMPLEMENTED.

#### W3-B
**Latch residue** · L2 · **3–4.5 h**
- **Rows:** implements AUD-14.06, P3-N021 (draft §9 press latch)
- **Surfaces:** `BuyLicenseModal`, `PrivatePowerFlowModal`, the token confirm, route edits, and any dispatch site no earlier
  slice latched; the `press:true` latch for automatic presses only under OD-12. A coverage test enumerates every
  `runGameplayAction` call site and asserts each is latched or listed as exempt with a reason.
- **App.tsx regions:** R-RING token confirm and R-RUN route edits (latch props only; handed over from L4 after W3-H),
  R-PRIVEXCH (`PrivatePowerFlowModal`), group "powers"; RED R1 only under OD-12 and the RED serialization rule.
  **Pins likely to move:** `doubleActionWindow` (pins submit-half text). **Depends on:** W2-A, W2-D, W3-H. **Gates:** OD-12
  for P3-N021.
- **Status (2026-10-04):** PARTIAL — INTEGRATED THROUGH AUD-25.01. AUD-25.01 (U-46, MEDIUM, from the W3-G audit) IMPLEMENTED on the slice branch `phase3/w3-b-action-latch-linkqueue` (`26f5982` + review fix `5fd3a7b` + tracking `7efda71`, from `d29bb2f`) and **INTEGRATED on `phase3/wave3-i-w2i-w2j-w3c-w3g-w3b-v13cert-integration`** (merge `00b2b3c`, parents `d29bb2f` / `7efda71`; the current provisional baseline). No RED region edited (OD-12 not used). Accepted LOW residue (RED R5): a held press can briefly re-arm once its own move lands if another seat's move landed meanwhile. OPEN: AUD-14.06 and P3-N021 NOT STARTED (W3-H; OD-12).

#### W3-C
**Refusal display model** · L6 · **3.5–5.5 h**
- **Rows:** implements AUD-14.01, P3-N004 (draft NEW-2 (sticky)), P3-N020 (draft §9 rollbacks)
- **Surfaces:** separate connection and refusal slots in the room strip (no exact-text clears); clear a server refusal once
  a later submission lands; roll back an ability/JK spend and the run marking when the server refuses (needs the refusal
  signal from the link callbacks). Touches RED R1 (6425–6427) and RED R5 (12567–12640).
- **Gates:** **OD-12 required.** If refused, the RED parts become owner-placed later (E) and are recorded so at W3-F.
- **Depends on:** W2-J; W1-H.
- **Status:** COMPLETE on its slice branch `phase3/w3-c-refusal-display` @ `6c28662` (from `phase3/wave3-i-w2i-w2j-v13cert-integration` @ `18d4762`; support `3c75394` + `bfec83c`, RED R1 `08d857b`, RED R5 `21d6b15`, implementation `6cb86e4`, review fix `6c28662`); **ACCEPTED and INTEGRATED on `phase3/wave3-i-w2i-w2j-w3c-v13cert-integration` (merge `b32ef6e` of `3454daa`, 2026-10-04).** OD-12 followed: the R1 and R5 edits are each their own independently reviewed commit, audited again at integration. AUD-14.01, P3-N004, P3-N020 IMPLEMENTED.

#### W3-D
**Accessibility minimum and modal infrastructure** · L5 · **2–4 h**
- **Rows:** implements AUD-13.04; carries the owner-gated AUD-13.05, AUD-13.06
- **Surfaces:** tutorials as native dialogs; the intro overlay's scale contract (OD-15(a)); the portal/inert layer
  (OD-15(b)); replace the remaining `aria-modal` divs (except `HomeStationPrompt` / `AuctionPromptModal`, which W2-H
  settles); keyboard reach for the dock controls.
- **Depends on:** W2-H, W3-A. **Gates:** OD-15.
- **OD-15 RULED (transcribed 2026-10-04, §7.3):** the intro and end-game videos are full-viewport cinematic takeovers (not NativeModal / `<dialog>`, not modal-looking), sized by true viewport geometry with the counter-scale removed (`GameIntroOverlay.tsx`, AUD-13.05; `GameOutroOverlay.tsx` likewise); genuine modals stay on the native dialog / top layer, with no second manual modal / inert architecture (AUD-13.06). AUD-13.04 (tutorials as native dialogs) is tutorial work: OD-5's ruled ordering sequences it to the final tutorial/UI pass.

#### W3-E
**City bypass control (conditional)** · L4 · **5–8 h, only if OD-11 = build**
- **Rows:** carries the owner-gated AUD-07.03 (U-17 / K-06)
- **Surfaces:** a voluntary bypass gesture on eligible city waypoints, sending the existing `bypass: true`; its interaction
  with the shortfall refusal per OD-11. **Gates:** OD-11. If OD-11 = defer, AUD-07.03 becomes owner-placed later (E).
- **Safe Wave-2 integration (2026-10-03):** OD-11 RULED (build, §7.3). COMPLETE — `07454d0` + `6d7cfa1`, integrated (`a860178`). AUD-07.03 C → B.

#### W3-F
**Phase-3 closure bookkeeping** · integrator · **2.5–3.5 h**
- **Surfaces:** backlog Part C — every audit-referenced U-item closed, verified obsolete, or annotated with the owner's
  ruling; `VISUAL_FLOURISH_BACKLOG.md` statuses updated (its standing rule); owner rulings OD-1…OD-18 recorded in Part D;
  **every F row re-confirmed at the final integrated head** (a focused test or a source citation); the Phase-4 playtest
  checklist written to **`docs/phase3/PHASE4_PLAYTEST_CHECKLIST.md`** (one procedure per D row from §8 and Appendix A,
  including the 6.5 functional-playtest rows the draft named: A-3, A-5, S-3, S-4, S-11, O-1, O-8, O-9, O-12, re-expressed
  from this plan); the matrix and JSON updated to final status; the Phase-4 baseline head recorded;
  `PROJECT_CANONICAL_CONTEXT.md` updated; a closure report.
- **Depends on:** every other slice, W3-G and W3-J. **Ends with:** the final owner broad gate.

#### W3-G
**U-28 retrospective UI-parity audit — the Phase-3 closure gate** · L6 · **5–8 h** · *new*
- **Rows:** implements AUD-00.01, AUD-22.01 (U-28)
- **Scope:** read the completed batch reports in `archive/claude-history/` (`BATCH1_…`, `BATCH3_…`, `BATCH4_…`,
  `BATCH4.5_…`, `BATCH4.6_…`, `BATCH5_…`, `BATCH6_…`; Batch 2 is Part A "Stage 2", `dca00bb`) and the current frontend.
  Classify every authoritative rule they introduced or changed under the UI-parity standing rule, including the
  private-company hex blocking (S6-7), the Batch-3 station gate, the Batch-4/4.6 train limit and discard flows, the Batch-5
  emergency surfaces (U-4) and the Batch-6 route refusals (S6-13). Triage open GitHub issues for player-facing defects
  (AUD-00.01). (The F rows are re-confirmed later, at the final head, in W3-F.)
- **Output:** each finding becomes a new matrix row (`AUD-25.nn`) and a Part C item (U-46+), with a proposed disposition.
  A finding is fixed (W3-J), proven obsolete, or ruled by the owner. **Deferral to "polish" is not a disposition** (Part F).
- **Starts:** in L6 after W3-C, or earlier whenever L6 is idle once wave 1 is integrated (read-mostly; its only writes are
  docs). **Gates:** owner review of the findings.
- **Status (2026-10-04):** COMPLETE — OWNER REVIEW ACCEPTED (an accepted audit gate, not a product slice). Audit branch `phase3/w3-g-ui-parity-audit` (docs only, from `c0a44d7`; audit `e86a933` + owner-review tracking). AUD-00.01 and AUD-22.01 done; findings AUD-25.01 … AUD-25.15 (Part C U-46 … U-55) accepted and preserved. Owner rulings: AUD-25.11 CLOSED — OBSOLETE / UNREACHABLE ARCHITECTURE (GR-1b; rooms require the game server; no remediation slice); AUD-25.13 ruled item by item (FIX IN W3-J / RECORDED RESIDUAL / OBSOLETE; no "polish later"); AUD-25.15 resolved (OD-3, OD-13, OD-14(d), OD-14(i) transcribed in §7.3). **INTEGRATED on `phase3/wave3-i-w2i-w2j-w3c-w3g-v13cert-integration`** (merge `72ccd00` of `967e4e7`, parents `c0a44d7` / `967e4e7`; the current provisional baseline). OPEN obligations: W3-B AUD-25.01 (MEDIUM; since IMPLEMENTED and INTEGRATED, merge `00b2b3c`); W3-J AUD-25.02 (MEDIUM), 25.03–25.10, 25.12 and AUD-25.13's FIX items; W3-F AUD-25.14. W3-J is unblocked. Reports: `claude/PHASE3_W3G_UI_PARITY_AUDIT_*`, `claude/PHASE3_W3G_OWNER_REVIEW_*`.

#### W3-H
**Flourish OPEN residuals and audio** · L4 · **5–8 h** · *new*
- **Rows:** implements AUD-15.01 (A-19), VF/C-7, VF/C-10, VF/D-12, VF/D-13, VF/D-16, VF/D-17, VF/D-21, VF/D-30, VF/D-35, VF/E-5, VF/E-6, VF/F-5, VF/H-6, VF/I-8, VF/J-5, VF/K-4, VF/K-6; carries the owner-gated AUD-12.05 (U-7), AUD-12.06 (U-8), VF/G-1, VF/G-7, VF/I-10, VF/J-6
- **Surfaces:** off-screen / inactive gating for VF-1/VF-3/VF-2 timers (C-7, E-6, F-5); the tile-flourish items (D-12,
  D-13, D-16, D-21, D-30, D-35); a throttled-CPU trace for D-17; real-browser evidence (Playwright trace / screenshot) for
  C-10 and E-5; `WaterfallAuctionDashboard` palette from `PRIVATE_POWER_GLOW_STOPS` (H-6); the Ledger tables receive the
  rust and discard events (I-8, J-5); the fallback capacity glyph rendered (K-4); a badge-size guard test (K-6); A-19 fixed
  in `utils/audio.ts` (a new duck supersedes the previous release); plus any OD-14 items ruled in (G-1 cue, I-10 / J-6
  badge icons, U-7 wash, U-8 palette).
- **Constraint:** the ledger's standing rule — update `VISUAL_FLOURISH_BACKLOG.md` before each commit.
- **Depends on:** W1-I, W1-B (shared files). **Gates:** OD-14 for ruled-in items; OD-12 only if A-19 needs RED R2.
- **OD-14 (2026-10-04, §7.3):** ruled IN — U-7 cash / payout wash (AUD-12.05), U-8 seventh colour (AUD-12.06), the static rust / discard icons (VF/I-10, VF/J-6). Ruled OUT of W3-H's work — the G-1 phase-change sound (none in this phase) and the G-7 stale replay (declined).

#### W3-I
**Queued-submission visibility and form retention** · L3 · **3–5 h** · *new*
- **Rows:** implements AUD-02.05 (I-1), AUD-02.06 (I-2), AUD-03.11 (R4), AUD-19.01 (I-1 / R4)
- **Surfaces:** a read-only queued-state accessor on `utils/serverLink.ts` and a small hook, outside the drain; the B&O par
  modal and the offer forms show "queued — will send on reconnect" and do not accept a second press; the typed offer form is
  kept until the proposal lands or is refused; the "not reached the table yet" note fires only after the landing signal.
- **App.tsx regions:** R-CONSENT; R-HOMEPROMPT's `AuctionPromptModal` props (after W2-H hands over); RED R5 only under OD-12.
- **Depends on:** W2-F, W2-H. **Gates:** OD-12 only if the drain must change.
- **Status:** COMPLETE on its slice branch `phase3/w3-i-offers` @ `d663b1c` (code `5c6d7f8` + review fixes `d663b1c`, from `phase3/wave2-bcgdf-v13cert-integration` @ `c3f43b7`); **ACCEPTED and INTEGRATED on `phase3/wave3-i-v13cert-integration` (merge `5a22e38` of `92cdb5d`, 2026-10-04)**; the owner accepted the R4 reading (a refused proposal may leave the form open with its typed values). The drain did not have to change (no OD-12 edit): a read-only queue accessor on the link and `utils/useLinkQueue.ts` feed the par prompt and the three offer forms.

#### W3-J
**U-28 findings remediation** · distributed to the owning lane · **4–10 h reserve**
- Each W3-G finding with a Phase-3 implementation disposition is assigned to the lane that owns its region and lands
  through the integrator like any slice.

#### W3-K
**v13 rules batch** · L2 (or L6) · **8–14 h planned; ~14–22 h with OD-4 and its certification (an estimate)**
- **Owner rulings (2026-10-03, §7.3):** OD-10(a) RULED — one consolidated v13 batch inside Phase 3: OD-2 (SBS-2), SBS-3, SBS-4 (precisely reproduced, V13_SCOPE_VERIFICATION §5) and OD-4 (automatic emergency funding). OD-17: D-18 and D-22 need no change. RR-4 is not a v13 item (OD-7: copy). Status: **accepted as COMPLETE (2026-10-04) and INTEGRATED on `phase3/wave2a-v13-integration` (merge `ed5e69a` of `be1fd10` onto `96ccb22`; not merged to main); settlement certification for 13 PASS / CERTIFIED and INTEGRATED on `phase3/wave2-bcg-v13cert-integration` (merge `69c7496` of `7916763`): settlement-certified `[10, 11, 12, 13]`. The ledger kept W3-K PARTIAL only because AUD-03.04 closes with W2-B's control; with W2-B integrated (`181e51e`) the ledger reads W3-K COMPLETE (no W3-K work changed).**
- **Rows:** implements P3-N023 (SBS-3), P3-N024 (SBS-4) and the rule half of AUD-03.04 (SBS-2). AUD-04.04 (DH-1) and AUD-08.01 (GR-1 / S10-27) left the batch: derivation-only, no version bump, placement open. VF/D-18 and VF/D-22: no change (OD-17).
- **Scope (as built):** rules revision 2 (`CURRENT_RULES_REVISION = 2`) switches every correction; one `RULES_ENGINE_VERSION` bump 12 → 13 with one changelog row; live list `[13]` (no dual v12 support); three new room messages (`EmergencySellPortfolio`, `ForgoTrainTrade`, `ForgoPrivateFunding`) with codec, ingress, reducer, replay, rebuild, RevertTo, log wording and idempotence; `DeclareBankruptcy` refused on revision 2; V-6.3 "Buy All" not implemented.
- **Procedure:** settlement certification for v13 through ESCROW-3A's procedure (goldens beside the old ones, then the literal in its own reviewed change), with bankruptcy vectors: `V13_SETTLEMENT_CERTIFICATION_VECTORS.md`. **Gameplay and settlement versions are separate axes:** v13 is not settlement-certified until that change lands.
- **Not deployable alone:** the deployment that ships revision 2 needs the removal of Auto-Buy's stage Pass and W2-B's single "Pass Turn" control, W2-G reconciled to the v13 emergency authority, the dedicated v13 settlement certification, drained pinned v12 rooms and the final integrated owner gate. (W1-A, W2-A and the Wave-2A reconciliation are done on `phase3/wave2a-v13-integration`; W2-B, the v13 W2-G and the v13 settlement certification are integrated on `phase3/wave2-bcg-v13cert-integration`; drained v12 rooms and the final owner gate remain.)

---

## 7. Owner decisions

Types: **PRODUCT** · **RULES** · **PRESENTATION** · **PLAYTEST-INFORMED** (can be re-tuned after Phase 4). None is
answered here. Where a draft question was already decided, it is removed (§7.2).

**Owner-decision rule (2026-10-04).** Owner decisions require explicit owner approval. Assistant / Cowork recommendations,
planning defaults, inferred choices and implementation decisions are NOT owner rulings. A ruling is recorded only from the
owner's own words (a brief, a decision, or an explicit approval); a ruling the owner gives in conversation is transcribed
into `owner_rulings`, this table and §7.3 in the same pass, so a later lane never has to re-ask it. The genuinely open
list is kept current in `docs/phase3/README.md` ("Still open").

| ID | Type | The decision | What exists now | Gates | Needs Phase 4 first? |
|---|---|---|---|---|---|
| **OD-0** | PRODUCT (base) | **PHASE-3 BASE PIN.** At kickoff the integrator pins the FINAL canonical integrated post-Phase-2 head and confirms: no unique local frontend work exists outside it; the Phase-3 planning facts still apply; any drift is reconciled before P0. **No implementation starts before this pin.** | Planning snapshot only (`8e897f9`) | everything | No |
| **OD-1** | PRODUCT · PLAYTEST-INFORMED | **RULED 2026-10-03 — see §7.3.** **The waiting model.** While a hold stands or another seat must act: (a) every control greyed with the hold's sentence, board and tabs usable; or (b) the bar replaced by one "Waiting on X" strip. For the home-station and auction prompts, non-actors get a banner or a read-only card (with a focus target). Also: which seats see the emergency modal | Full-screen scrims for everyone; the OR bar ignores holds; four prompts print their own waiting sentence | W2-A, W2-F, W2-H, W2-G | No (re-tunable after Phase 4) |
| **OD-2** | RULES confirmation (+ PRESENTATION detail) | **RULED 2026-10-03 — see §7.3.** The audit fixes the target: one Pass / End Turn control. Open: **restate the recorded OD-A-2 and OD-A-4 rulings.** The 6.5-B report says they were "recorded, not implemented", but their text is in neither the repository nor the Project docs. OD-A-2: should a Stock Round Pass always end the turn (a v13 rules change, W3-K), or does the one control send the two `PassTurn`s under v12? OD-A-4: may a Brown IPO first purchase open the Pool continuation (SBS-4)? | Two Passes end a no-buy turn; stage buttons only switch tabs | W2-B; W3-K items SBS-2/SBS-4 | No |
| **OD-3** | PRESENTATION (+ engine scope) | **RULED 2026-10-04 (transcribed at the W3-G owner review: generic expiry; no forensic engine reason) — see §7.3.** M&H queued request: toast + a persistent table marker + "requested" / "executed" lines; on cancellation, a generic "expired", or authorize engine work (v13, W3-K) to carry the reason | Narrated as executed; no reader of `pending_mh_exchange` | W2-E | No |
| **OD-4** | PRODUCT | **RULED 2026-10-03 — see §7.3.** Emergency modal: Back/close while a decision remains? Non-presidents see a read-only liquidation, or nothing? | Cannot close; every seat sees "Declare bankruptcy" | W2-G | No |
| **OD-5** | PRESENTATION · PLAYTEST-INFORMED | **RULED 2026-10-04 (acknowledgement per user / per game, no late-join backlog; a stable game-screen heading as the post-notice focus target; Emergency > Fleet Loss > Private Revenue > Phase Three > Herald > Tutorial, one at a time, no native stacking; tutorials arm once per profile) — see §7.3.** Notices: persist one-shot notices per game, or derive them from state for late joiners; the focus target and chaining order for forced notices; the tutorial re-arm policy (once per profile? per new game?) | PhaseThree / PrivateRevenue / Herald lost on reload; FleetLoss replays history in a fresh tab; tutorials re-arm on every zero-state mount | W3-A | No; Phase 4 may re-tune |
| **OD-6** | PRODUCT | **RULED 2026-10-04 (Option A: game_id stays undisplayed; build id + rules version on the Rules Reference build line) — see §7.3.** Show the game id (LIVE-2 §7.2 says never)? Where do the build id and rules version appear? | Room code only on hosted tables; stale build note; version only in error text | W2-I (that part) | No |
| **OD-7** | RULES (confirmation) | **RULED 2026-10-03 — see §7.3.** RR-4: when the treasury can pay a forced purchase, must it be the cheapest train? "Yes" is a rules defect (v13, W3-K); "No" is a copy fix (W2-J). **The 6.5-B report says an RR-4 ruling was recorded; restate it for Part D** | Engine allows any legal purchase; the Reference said "cheapest" at 4 sites (corrected, `ca73834`) | W2-J / W3-K — ruled: W1-L copy, done | No |
| **OD-8** | PRESENTATION | **RULED 2026-10-04 (Option A: the float and its capital at the purchase, the home line at the placement) — see §7.3.** U-37 float narration: (a) "floated" at the float plus "placed its home" later, or (b) one line at placement | One line at placement | W2-J | No |
| **OD-9** | PRESENTATION / PRODUCT | **(a) RULED 2026-10-03 — see §7.3; (b) policy RULED (transcribed 2026-10-04: the official Keplr asset only, never fabricated) — ASSET PENDING, not a decision awaiting the owner.** (a) U-44 time convention: local with zone (needs a server copy edit) or UTC everywhere. (b) U-15 Keplr logo asset and brand approval | Local "HH:MM" unlabelled vs the server's "UTC"; no logo asset | W2-K | No |
| **OD-10** | RULES / PRODUCT | **(a) RULED 2026-10-03 — see §7.3; (b) OPEN (not equivalent to the historical OD-10 approval; checked 2026-10-04).** (a) Is a v13 rules batch allowed inside Phase 3 (W3-K), or are all rules items owner-placed after Phase 4? (b) Are phone-width game layout, zoom-aware breakpoints and keyboard map access Phase-3 targets, Phase-4 observations only, or Phase-5 work? | v12; no game-shell breakpoints; the map is mouse-only | W3-K; AUD-16.05, AUD-16.09 | (a) No. (b) Partly |
| **OD-11** | PRODUCT · PLAYTEST-INFORMED | **RULED 2026-10-03 (build: manual route only) — see §7.3.** K-06 city bypass: build in Phase 3 (which hexes, which gesture, how it meets the shortfall refusal) or place it later | No voluntary control; bypass is sent automatically where forced | W3-E | Partly |
| **OD-12** | PRODUCT (engineering scope) | **RULED 2026-10-03 — see §7.3.** **RED-region permission.** May named Phase-3 fixes edit the RED regions (submit half, apply half, OR verdict, link drain), each as one separately reviewed commit naming its exact lines? Candidates: K-18 (R2), the banner/refusal model and refusal rollbacks (R1, R5), the `press:true` latch (R1), K-24's call site (R2), A-19 if the audio-side fix is not enough (R2), the FleetLoss prune if the store fix is not enough (R4), the queued-state read if it cannot be done outside the drain (R5). A refusal places each named item later (E) — it does not silently drop it | The draft deferred all of these to Phase 4 without a ruling | W2-J, W3-B, W3-C, W3-I, W1-N, W3-A, W3-H | No |
| **OD-13** | PRESENTATION (derived statistics) | **RULED 2026-10-04 (transcribed at the W3-G owner review: W2-L's corrections approved as implemented) — see §7.3.** Ratify or amend the candidate resolutions for U-41 and U-43 (1)–(4). Each changes standard-game post-game statistics | Recorded in Part C as candidates "NOT ratified" | W2-L | No |
| **OD-14** | PRESENTATION | **(a)–(i) RULED — see §7.3.** (d) and (i) transcribed 2026-10-04 at the W3-G owner review; (a) re-approved by the owner 2026-10-04 (keep the panels outside the bar; remove the probe); (b), (c), (e)–(h) transcribed 2026-10-04 from the owner's reconciliation brief (wash: yes; seventh colour: yes; keep the persistence line; no phase-change sound; no stale replay; static rust / discard icons). Owner calls the audit names: (a) U-16 — move the step panels back into the bar, or keep; (b) U-7 — extend the card wash to the cash slide-out and payout modal; (c) U-8 — seven-seat palette; (d) GR-3 — keep "traded" for a first-Diesel trade-in or restore "rusted"; (e) the waiting room's extra description line; (f) VF G-1 — a phase-flip cue (which asset); (g) VF G-7 — close as designed or replay; (h) VF I-10 / J-6 — build the static badge icons now; (i) the money panel's styling (a Part C U-44 note, beyond the audit) | Each recorded as open or "owner to say" | W1-I(-b), W3-H, W1-L, W2-K, W2-L | (a)(f) partly |
| **OD-15** | PRESENTATION (modal infrastructure) | **RULED (transcribed 2026-10-04; the owner's later cinematic-video clarification supersedes the older modal reading) — see §7.3.** (a) The intro overlay's scale contract; (b) is the portal / inert layer still needed (and if so, inert behind every modal)? | `zoom: 1 / uiScale` on an `aria-modal` div; `ModalPortal` disowns inert | W3-D | No |
| **OD-16** | PRODUCT (owner-authored) | **RULED (transcribed 2026-10-04: Phase 3 builds the Terms route/page shell and the Terms/deposit link infrastructure; the substantive copy is owner-authored, never invented, and a Phase-7/mainnet gate) — see §7.3.** The Terms page content (S10-12), required before the first real deposit | None | W2-M (hosting) | No |
| **OD-17** | RULES | **RULED 2026-10-03 — see §7.3.** Tile-upgrade legality cross-references: VF D-18 (New York #54→#883 offered, #62→#883 not) and VF D-22 (#59 → brown OO facings that break fixed OO; 256 accepted transitions) | The placement filter accepts them | W3-K | No |
| **OD-18** | PRODUCT | **RULED (transcribed 2026-10-04: no move clock, automatic forfeit, automatic trade decline or host succession at this stage; reconsider after Phase-4 human playtesting; U-10's "pause cap" not named) — see §7.3.** Confirm or reject the later placement of U-10 (clock / live-vs-async UX: the offer answerer on the clock, auto-decline, pause cap) and of the recorded limits (no host succession, no clock or forfeit for an absent seat). Confirmed → E with the ruling cited; rejected → scoped as Phase-3 slices | U-10 `DEFERRED` in Part C; the limits recorded in the 6.5 preflight | AUD-11.04, AUD-19.04 | No |

### 7.1 Not owner decisions (implementation defaults; the owner may object at a gate)

- Station refusals are shown through the existing `showActionToast` (W1-F).
- The K-16 tooltip may state the rule rather than name a seat (W1-B).
- The Rules Reference's game-over copy (W2-I) and the U-40 authority sentence (W1-L) are drafted by the slice and reviewed at the gate.
- U-16's probe is removed in any case (Part C: "remove it either way"); only the panel placement is OD-14(a). (OD-14(a) RULED 2026-10-04: keep; the probe is removed by W1-I `1b76512`.)

### 7.2 Draft decisions eliminated or corrected

| Draft | Now | Why |
|---|---|---|
| OD-0 "083d066 or main" | Replaced by OD-0 base pin | Owner instruction: the base is the final post-Phase-2 head, not a choice |
| OD-6 "Rules Reference copy at GameEnd" | Implementation (W2-I) | Copy, not a product choice |
| OD-8 "U-40: the Rules Reference authority sentence" | Implementation (W1-L) | The owner's S9-4 project-authority ruling already sets the policy |
| OD-A-3 (D10/E5) in the draft's v13 list | Resolved (P3-N026) | Owner ruled D10 and E5 follow G19 (6.5-B); the engine already charges |
| ING-1 in the draft's v13 list | Resolved (P3-N025) | v12 refuses creating such a state |
| Default "U-8 closed" | OD-14(c) | An open owner call may not be defaulted |
| Default "K-24 placeholder left to Phase 5" | W1-N | No owner placement exists; it is a known defect |
| "First to cut: W3-A, W3-C, W3-E" | Overturned | Nothing is cut without an owner ruling; W3-E is already conditional (OD-11) |
| OD-2 as "stage Pass vs one End Turn" | Reframed | The audit already sets the target (one control); only OD-A-2 / OD-A-4 remain |
| OD-2 / OD-7 as fresh questions | Confirmations of recorded rulings | 6.5-B says RR-4, OD-A-2 and OD-A-4 were recorded; their text must be restated into Part D |

### 7.3 Owner rulings recorded (2026-10-03, during wave 1)

Recorded from the owner's Wave-1 integration brief, in its words; only instructions addressed to that integration were turned into statements. `owner_rulings` in `phase3_accounting.json` carries the same text.

**OD-1 — AUTHORITATIVE HOLD PRESENTATION.**
- Ordinary non-active-player behavior remains as it already was.
- Important deliberate exception: during Run Routes and Dividends, non-active players continue to see the active corporation's route/train information and dividend choices/consequences.
- When an initiated trade/offer creates an authoritative hold: every player gets a clear Waiting on X / what is being decided status; the legitimate answerer retains Accept/Reject controls; the proposer retains Rescind where legal; unrelated controls do not pretend play can continue.
- Emergency train purchase: the obligated president gets the interactive emergency controls; everyone else gets a simplified status/notification that the named player / corporation is resolving an emergency train purchase.
- Do not accidentally remove the Routes/Dividends informational visibility.
- *Effect on this plan:* Recorded only. Not implemented in the Wave-1 integration: W2-A and W2-F implement it (W2-G and W2-H take its viewer scope). The Routes/Dividends spectator visibility is unchanged by Wave 1.

**OD-2 — STOCK ROUND PASS.**
- RESOLVED. The intended Stock Round model is: Sell whenever legal; take at most one Buy action; after buying, Buy is unavailable but Sell remains available; the player-facing button is named "Pass Turn"; Pass Turn ends the player's turn in ONE click.
- The old Sell → Buy → Sell stage-walking model is superseded.
- Because changing PassTurn replay semantics is a rules-engine change, the actual implementation is scheduled for the dedicated v13 rules slice and its settlement certification.
- Wave-1's sellBuySell pins/comments are not the final desired behavior; they are preserved only until the v13 slice replaces them.
- The separate SBS-4 / "Brown IPO first purchase opens Pool continuation" item is NOT resolved. Owner's observation: a corporation's first-ever IPO purchase starts it at a PAR space, not a Brown zone, so the audit wording is internally suspect. SBS-4: NEEDS PRECISE REPRODUCTION / CLARIFICATION. Do not implement a rule from the current wording.
- *Effect on this plan:* Recorded as RESOLVED; NOT implemented in the Wave-1 integration (no rules or version change). SBS-2 goes to the v13 rules slice (W3-K is its vehicle) with its own settlement certification; W2-B presents the one-click "Pass Turn". P3-N024 (SBS-4) becomes G: needs precise reproduction / clarification. The rules version stays v12.

**OD-7 — FORCED TRAIN PURCHASE.**
- If the corporation can fund a normal legal train purchase from its own treasury, ordinary train-purchase choice applies.
- The "must buy the cheapest train" restriction belongs to the emergency purchase/funding situation, where the corporation cannot afford a train from its own treasury and president/emergency funding becomes necessary.
- Apply to player-facing Rules Reference copy only. Do NOT change engine behavior. Do NOT create v13 for OD-7.
- After the correction, the Rules Reference may continue to state that it is the final player-facing authority.
- *Effect on this plan:* Implemented as copy at the Wave-1 integration (`ca73834`): every RR-4 site in `components/RulesReference.tsx` corrected; the engine (which already allowed any legal treasury-funded purchase) is unchanged. AUD-09.10 C → B, IMPLEMENTED. W2-J and W3-K no longer carry RR-4.

**OD-12 — RED REGIONS.**
- Owner authorized narrowly controlled RED-region bug fixes.
- This does NOT authorize an App.tsx refactor.
- For the Wave-1 integration exactly ONE RED edit: W1-N — delete the obsolete `settleRoomPayout(...)` call site in RED R2, now that settleRoomPayout is intentionally a no-op and the placeholder payout has been removed. Its own commit; no neighboring cleanup; no structural refactor; focused regression; independent review of that commit before continuing.
- The other OD-12-gated W3 defects are not implemented in that task.
- *Effect on this plan:* W1-N's R2 call site deleted as its own commit (`87d63c4`, independently reviewed: APPROVE WITH NITS, comment nits fixed outside RED in `819a204`). The remaining OD-12 candidates (W2-J K-18; W3-C, W3-B, W3-I, W3-A, W3-H) each still land as one separately reviewed RED commit under §5.1's serialization rule.

**Recorded at the safe Wave-2 integration (2026-10-03)**, from the owner's brief, in its words:

**OD-9 — MONEY TIME / COPY CONVENTIONS (W2-K).**
- APPROVED convention: persistent player UI: local absolute time + explicit time zone;
- server refusal copy: relative duration is acceptable because the server has no player time zone;
- machine evidence remains UTC.
- Official Keplr logo remains ASSET PENDING; do not fabricate one.
- (b) Use the official Keplr branding/logo asset. Do not fabricate/redraw/fake the Keplr logo. *(Transcribed 2026-10-04 from the owner's owner-decision reconciliation brief: supplied in a prior owner conversation, never transcribed.)*
- *Effect on this plan:* OD-9(a) implemented by W2-K (`fb4eee5`); AUD-20.01 C → B, IMPLEMENTED. OD-9(b): the policy is ruled (the official asset only); AUD-18.05 stays OPEN as ASSET PENDING until the official file is supplied. It is not an owner-policy decision awaiting the owner.

**OD-11 — CITY BYPASS (W3-E).**
- W3-E: manual route only.
- Preserve automatic route optimality unchanged.
- Stop/Bypass is offered only when the exact crossing supports both arms.
- Forced bypass remains forced.
- Whole-set `routeSetRefusal` remains authoritative.
- *Effect on this plan:* the brief integrates W3-E, so OD-11 = build. W3-E landed (`a860178`); AUD-07.03 C → B, IMPLEMENTED.

**OD-8 — FLOAT NARRATION (W2-J).** (Ruled 2026-10-04, from the owner's W2-J decision.)
- OPTION A. The narration must follow the actual event timing.
- At the share purchase that causes the corporation to float, log: "<CORP> has floated. It received $<AMOUNT>."
- At the corporation's later first operating turn, when its home station is actually placed, log: "<CORP> placed its home station on <HEX>."
- Do NOT keep the current combined delayed line.
- Reason: the float and capitalization occur at the purchase, while home-station placement now occurs later; narration should report each event when it actually happens.
- *Effect on this plan:* OD-8: RULED — split float/capitalisation narration from later home-station placement. Implemented by W2-J (`8a448d2`, review fixes `99b5651`); AUD-03.09 IMPLEMENTED. Integrated on `phase3/wave3-i-w2i-w2j-v13cert-integration` (merge `32ead52`).

**OD-6 — GAME ID / BUILD ID / RULES VERSION PLACEMENT (W2-I).** (Ruled 2026-10-04, from the owner's W2-I decision.)
- OPTION A. Keep `game_id` OFF SCREEN. The LIVE-2 identity rule remains authoritative: `game_id` is the server key, not the player's game name, and the interface must not display it.
- The human-visible table identity remains: the room code where visible; "Private game" where the room code is intentionally hidden; the existing on-chain game number only on the old on-chain path.
- For W2-I diagnostics: keep the existing build ID in the Rules Reference header and add the authoritative rules version on that same line ("Build <id> · Rules v13"); the rules version from the board's authoritative `rules_engine_version`, the build ID from the existing build-ID source; do not duplicate either value in the top bar; no new persistent gameplay chrome.
- AUD-01.07 closes as an explicit product decision: DECIDED / IMPLEMENTED — opaque game_id intentionally not displayed.
- *Effect on this plan:* OD-6: RESOLVED — game_id remains undisplayed; Rules Reference diagnostic line shows Build ID + authoritative rules version. Implemented by W2-I (`c17e844`); AUD-01.07 C → B, IMPLEMENTED. Integrated on `phase3/wave3-i-w2i-v13cert-integration` (merge `78f9164`).

**OD-5 — NOTICES: PERSISTENCE, FOCUS TARGET, PRIORITY / CHAINING, TUTORIAL RE-ARM (W3-A).** (Ruled 2026-10-04, from the owner's OD-5 decision.)
- (a) One-shot notice persistence: persistent acknowledgement PER USER / PER GAME. A one-shot notice the user has acknowledged remains acknowledged across reload, reconnect, new tab and browser remount.
- (a) Old one-shot notices are not derived merely from current game state in a way that replays historical events to someone who did not experience them. Late joiners do NOT receive a backlog of historical one-shot notices.
- (a) The notice system represents "this player has already been shown / acknowledged this event for this game", not "this browser tab happened to dismiss it". `sessionStorage` is not the durable authority for these acknowledgements; the smallest existing durable / profile / game-scoped mechanism suitable to the architecture is used.
- (b) Focus target: a stable GAME-SCREEN HEADING is the post-notice focus target -- NOT the action bar's round label (the heading is stable across round / step transitions and gives the correct page-level context after a forced modal / notice closes). It is a real accessible heading, programmatically focusable when required; ordinary focus behaviour causes no visible layout jump or unwanted scrolling; after the forced-notice chain completes, focus lands there; focus is not repeatedly stolen during ordinary gameplay.
- (c) Notice priority / chaining, deterministic, when several forced notices are due: 1. Emergency 2. Fleet Loss 3. Private Revenue 4. Phase Three 5. Herald 6. Tutorial. Only one forced notice is presented at a time. After acknowledgement / dismissal the next due notice presents; when the chain is exhausted, focus moves to the game-screen heading. A lower-priority notice never stacks natively underneath a higher-priority one; two native dialogs / modal notices never appear simultaneously.
- (d) Tutorial re-arm: tutorials automatically arm ONCE PER PROFILE. Once the player has completed / dismissed the tutorial sequence, ordinary game mounts and zero-state remounts do not re-arm it -- not on reload, reconnect, new game or zero-state remount. A future explicit "show tutorial again" control may re-open it if one exists or belongs to another tracked slice; W3-A does not invent broader tutorial-settings UX.
- If RED R4 must change, OD-12 authorizes only the bounded W3-A change actually required, as its own independently audited commit, with no refactor of neighbouring App.tsx code.
- The README's omission of OD-5 from its stale "Still open" prose remains AUD-25.14 / W3-F bookkeeping.
- *Effect on this plan:* OD-5: RULED. Gates W3-A's six rows (AUD-01.03, AUD-01.06, AUD-11.02, AUD-13.02, AUD-13.07, P3-N019); W3-A unblocked.

**OD-3 — M&H QUEUED REQUEST CANCELLATION (W2-E).** (Transcribed 2026-10-04 at the W3-G owner review, AUD-25.15; applied by W2-E.)
- Generic expiry is sufficient for the M&H queued request.
- No forensic engine reason is required.
- *Effect on this plan:* OD-3: RULED — W2-E's generic "expired" line (`4f998b8`) stands; no engine work. AUD-10.03 and AUD-10.06 stay IMPLEMENTED.

**OD-13 — DERIVED POST-GAME STATISTICS (W2-L).** (Transcribed 2026-10-04 at the W3-G owner review, AUD-25.15; applied by W2-L.)
- Derived-statistics corrections are approved as implemented by W2-L: train discard; Salvager; refused runs; RunManualRoute; Cowboy fixes.
- *Effect on this plan:* OD-13: RULED — U-41 and U-43 (1)–(4) ratified as implemented (`e16aa5a`). AUD-12.02 and AUD-12.03 stay IMPLEMENTED.

**OD-14 — PRESENTATION CALLS, (a) THROUGH (i).** ((d) and (i) transcribed 2026-10-04 at the W3-G owner review, AUD-25.15; (d) applied by W2-L, (i) by W2-K. (a) explicitly re-approved by the owner on 2026-10-04. (b), (c), (e)–(h) transcribed 2026-10-04 from the owner's owner-decision reconciliation brief: supplied in a prior owner conversation, never transcribed; original date not recorded.)
- (a) Keep the step panels OUTSIDE the action bar.
- (a) Remove the temporary sticky-fit probe.
- (b) Use the cash/payout player-color wash.
- (c) Give the seventh LPF/player a distinct color.
- (d) For the first-Diesel trade-in presentation, keep the label: "traded". Earlier 4-trains rusted by the phase event remain rusted.
- (e) Keep/tighten the established waiting-room persistence presentation rather than replacing the model.
- (f) No phase-change sound effect in this phase.
- (g) Do not replay stale flourish/celebration effects.
- (h) Use static rust/discard icon treatment.
- (i) Phase 3 gets a bounded money-panel consistency pass. The goal is to make the money panel visually belong to the rest of the game and stop there.
- (i) W2-K / W2-M may extend the established styling while touching money UI, but this is NOT permission for a money-panel redesign or broader frontend refactor.
- *Effect on this plan:* OD-14 (a)–(i): RULED.
  - (a): AUD-01.02 RULED (the panels are not moved into the bar; the conditional W1-I-b sub-scope has no work). The probe removal (AUD-01.01) is implemented on the unintegrated W1-I slice branch `phase3/w1-i-completion` (`1b76512`; its tracking `63fccca` records (a) in its own words, with a transcription note on where the panel wrapper renders); AUD-01.01 stays OPEN on this line until W1-I is integrated.
  - (b): AUD-12.05 (U-7) ruled in — W3-H. (c): AUD-12.06 (U-8) ruled in — W3-H.
  - (d): AUD-12.07 RULED ("traded" kept; no change).
  - (e): AUD-18.07 RULED. The audit's cited line (`components/SandboxWaitingRoom.tsx`:590 at `7b1a956`) is the seat-persistence sentence ("Your seat is kept for your profile …"), so the question and the ruling name the same presentation: it stays (a tightening is allowed); no replacement model.
  - (f): VF/G-1 RULED — no phase-change sound in Phase 3. (g): VF/G-7 RULED — the replay option is declined.
  - (h): VF/I-10 and VF/J-6 ruled in — W3-H builds the static rust / discard icons.
  - (i): bounds W2-K's panel pass and any W2-M money-UI styling.

*Also from that brief (constraints on integrated slices, not new rulings):* W2-H keeps the Routes/Dividends informational
visibility for non-active players (home/auction actors get controls, others a status) — this is OD-1's viewer scope for those two
prompts, now implemented (`66977d5`). W2-E preserves W1-C's explicit IPO-vs-Bank-Pool choice with no substitution, and its marker / log /
RR-6 read `pending_mh_exchange`. W2-L is derived history only (no reducer / replay / settlement / rules-version change). OD-3 (W2-E),
OD-13 and OD-14(d) (W2-L) and OD-14(i) (W2-K's panel pass) were applied by those slices as the owner gave them; their text was not in that brief. It is
transcribed above, from the W3-G owner-review brief (2026-10-04; AUD-25.15). W2-G is implemented but held for the OD-4 v13 work. The tutorial architecture remains later spotlight / whitebox work.

*OD-4, OD-10 and OD-17 below are restated from the owner's W3-K rules-v13 brief (2026-10-03).*

**OD-4 — EMERGENCY FUNDING (AUTOMATIC BANKRUPTCY).**
- Emergency funding becomes automatic in the v13 rules batch (owner sub-rulings O-1 to O-6 of V13_SCOPE_VERIFICATION §3.6).
- O-1: the intercorporate trade window is budgeted at the treasury plus the president's cash before any liquidation; a ForgoTrainTrade message closes it; it never reopens.
- O-3: a liquidation-funded intercorporate trade is illegal.
- The treasury-plus-cash commitment and the purchase are automatic, through the derived-action machinery with durable keys.
- Share raising is one atomic EmergencySellPortfolio: the submitted order is preserved; the whole portfolio is validated, simulated and proven legal; any failure returns the original board; ordinary sale law is reused.
- O-4: "only enough" applies to the whole portfolio, and the smallest legal overshoot is allowed.
- O-5: no self-created bankruptcy: an insufficient portfolio is refused. The insolvency oracle must be exact.
- O-2: private funding stays optional; fundingPrivateOfferRefusal is preserved and ForgoPrivateFunding is added.
- Bankruptcy is automatic, with no player Declare: liquidate as far as legally possible, apply the cash to the obligated corporation, then GameEnd with bankrupt_president. DeclareBankruptcy is refused on v13.
- O-6: shares that could not be sold are scored as the bankrupt's shares.
- Expose the authority W2-G needs. Not in this batch: DH-1, GR-1 / S10-27, GR-1b, D-18, D-22, RR-4, V-6.3.
- Owner ruling 1 (2026-10-04): KEEP the portfolio rule. "Only enough" means no redundant leg and no unnecessarily large percentage within a leg when a smaller LEGAL bundle of that same holding would still fund; the smallest legal indivisible bundle may overshoot. It does NOT mean the globally smallest dollar overshoot: with $50 short, { B 10% } raising $100 and { C 10% } raising $60 are both legal and the player chooses.
- Owner ruling 4 (2026-10-04): KEEP the refusal. EmergencySellPortfolio may contain each corporation at most once; 20% of PRR is one 20% leg, never two 10% legs.
- Owner ruling 5 (2026-10-04): private-funding relevance is EXACT. The question is whether at least one legally valid private-funding path (one sale or a legal sequence, assuming buyer consent, under the existing #1541 authority) could contribute to a complete rescue. An upper bound may be used only to prune; if exact authority proves no legal private path can rescue, bankruptcy does not wait.
- Review findings fixed (2026-10-04): the automatic bankruptcy is narrated as an outcome; the no-server shell forwards the keyed automatic emergency purchase through #1247's derived-action path; the Rules Reference trade-window and bankruptcy-warning copy; the v13 changelog wording.
- *Effect on this plan:* Implemented in W3-K on `phase3/w3-k-rules-v13` (rules v13, gated on rules revision 2). W2-G (AUD-09.05/06/07, P3-N017/018) must be reconciled to the v13 authority before it starts. Settlement certification for 13 is pending (bankruptcy vectors required). The 2026-10-04 rulings 1, 4 and 5 and the four review findings are implemented on the same branch. *(Since 2026-10-04: W2-G reconciled to the v13 authority and the v13 settlement certification (bankruptcy vectors included) are both PASS and integrated on `phase3/wave2-bcg-v13cert-integration`.)*

**OD-10 — V13 RULES BATCH IN PHASE 3.**
- (a) One consolidated v13 rules batch is allowed inside Phase 3 (W3-K): OD-2, SBS-3, SBS-4 and OD-4, with the official/default Brown rule. V-6.3 "Buy All" is not implemented.
- One RULES_ENGINE_VERSION bump (12 → 13), one changelog entry, no speculative rules. The live list is [13] only; no dual v12 support (pinned v12 rooms are drained or abandoned before deployment).
- The settlement-certified literal stays [10, 11, 12]; 13 is added only by its own certification pass. The future v13 certification vectors, including bankruptcy terminal states, are documented.
- DH-1 and GR-1 / S10-27 (derivation-only), GR-1b (UI only), D-18 and D-22 are not in the batch.
- (b) is not addressed by this ruling.
- Owner ruling 2 (2026-10-04): the Brown Bank Pool continuation is one contiguous multi-certificate purchase by the ACTIVE Stock Round player. Any accepted state-changing turn action by that player which is not another qualifying Brown Bank Pool purchase closes it (a sale, an accepted private trade, an M&H exchange, Pass Turn, any other stock-turn action). Another player's off-turn consent or answer, and derived / system bookkeeping, do not. A private-trade proposal, or its withdrawal, does not close it either: a proposal transacts nothing. It is the accepted trade that closes the continuation -- the counterparty's acceptance completes the active player's own trade, so it counts as that player's turn action, not as an off-turn answer (clarification 2026-10-04, matching the reviewed W3-K implementation, `rulesV13StockRound.test.ts`). Decided from actor / turn semantics, not log adjacency; a refused or no-op message closes nothing.
- Owner ruling 3 (2026-10-04): KEEP the existing Stock Round semantics for the M&H exchange: it is not a stock purchase or sale for turn_action_taken, the true-pass / all-pass streak, or Priority Deal / last-trader purposes. It can close an already-open Brown purchase (ruling 2) without becoming stock trading.
- *Effect on this plan:* W3-K implemented on `phase3/w3-k-rules-v13`; integrated on `phase3/wave2a-v13-integration` (merge `ed5e69a`). AUD-04.04 and AUD-08.01 leave W3-K (owner placement open; no version bump needed). P3-N023 and P3-N024 C/G → A, IMPLEMENTED. OD-10(b) stays open. The 2026-10-04 rulings 2 and 3 are implemented on the same branch. *Reconciliation (2026-10-04):* the owner's historical approval ("one consolidated v13 rules batch is allowed") is (a), recorded above; that proposal had no (b), and the current (b) asks a layout / input-scope question, not a rules-version one, so no equivalence is shown and OD-10(b) stays OPEN. **v13 settlement certification: PASS / CERTIFIED** by its own pass on `phase3/v13-settlement-certification` (2026-10-04; evidence `e36f3a1`, admission in its own commit; integrated on `phase3/wave2-bcg-v13cert-integration`, merge `69c7496`): rules engine 13, supported live gameplay [13], settlement-certified [10, 11, 12, 13] — gameplay-engine support and settlement certification stay separate axes.

**OD-17 — TILE-UPGRADE CROSS-REFERENCES.**
- D-18 and D-22 are excluded from the v13 batch: V13_SCOPE_VERIFICATION found D-18 INVALID (the printed rule) and D-22 ALREADY CORRECT (Stage 9.3 rule 5b, rules v7).
- No engine change.
- *Effect on this plan:* VF/D-18 and VF/D-22 stay C (the ledger still lists them OPEN) with status RULED — no change; the ledger and comment cleanup is a docs task (closure contract item 12).

*OD-5, OD-15, OD-16 and OD-18 below (and OD-9(b)'s asset policy and OD-14(b), (c), (e)–(h) above) are transcribed 2026-10-04 from the owner's owner-decision reconciliation brief, in its words. Each was supplied by the owner in a prior conversation and never transcribed: the 2026-10-04 read-only history pass found none of them in any branch, reflog, tracking commit or Project report. Original ruling dates were not recorded.*

**OD-5 — NOTICES AND TUTORIALS: TUTORIAL ORDERING ONLY.**
- Tutorial work is deferred until the FINAL tutorial/UI pass, after the shell/UI has stabilized.
- *Effect on this plan:* only the ordering is ruled. The tutorial rows (AUD-01.06, the re-arm effect; AUD-13.04, tutorials as native dialogs) are sequenced to the final tutorial/UI pass. **OD-5's three policy questions stay OPEN** — persist one-shot notices per game or derive them from state; the focus target and chaining / yield order for forced notices; the tutorial re-arm policy — and this ruling is not read as answering any of them. AUD-01.03, AUD-11.02, AUD-13.02, AUD-13.07, P3-N019 and the policy half of AUD-01.06 stay gated on OD-5.

**OD-15 — MODAL INFRASTRUCTURE AND THE CINEMATIC VIDEOS.** (The owner's historical approval covered the modal / accessibility direction; the owner's LATER explicit clarification supersedes any interpretation that would turn the cinematic videos into modals.)
- Intro video = full-viewport cinematic takeover.
- End-game video = full-viewport cinematic takeover.
- Neither is NativeModal / `<dialog>`.
- Neither should look like a modal.
- Both fill the viewport independently of gameplay UI scale.
- Remove inverse/counter-scale hacks in favor of true viewport geometry.
- For genuine modal UI: continue using the established native dialog/top-layer approach rather than inventing a second manual modal/inert architecture.
- *Effect on this plan:* (a) AUD-13.05 RULED — `components/GameIntroOverlay.tsx` becomes true viewport geometry (its `zoom: 1 / uiScale` goes), not a NativeModal; the end-game video (`components/GameOutroOverlay.tsx`, the same counter-zoom; no row of its own) likewise. W3-D's "replace the remaining `aria-modal` divs" does not convert either video. (b) AUD-13.06 RULED — genuine modals stay on the native dialog / top layer; no inert registry or second manual modal architecture. Whether `ModalPortal` is retired is not stated by the ruling and is not inferred.

**OD-16 — TERMS PAGE (S10-12).**
- Phase 3 builds the Terms route/page shell.
- Phase 3 builds the relevant Terms/deposit link infrastructure.
- Substantive Terms copy is OWNER-AUTHORED and must not be invented.
- Final substantive Terms remain a Phase-7/mainnet gate.
- *Effect on this plan:* AUD-20.08 RULED — W2-M builds the shell and the link infrastructure with no invented copy. The unintegrated W2-M branch (`phase3/w2-m-wallet-dispute-ux` @ `19c021c`) predates this transcription and records AUD-20.08 as owner-gated with nothing hosted.

**OD-18 — LIVE / ASYNC LIMITS (U-10) AND RECORDED LIMITS.**
- Do NOT add at this stage: move clock; automatic forfeit; automatic trade decline; host succession.
- Reconsider these only after Phase-4 human playtesting.
- *Effect on this plan:* AUD-11.04 (U-10) and AUD-19.04 RULED — placed after Phase-4 human playtesting, not Phase-3 work. U-10 as worded here also names a "pause cap"; the ruling does not name it and it is not inferred; the owner may confirm whether it falls under this later placement (README, "Still open"). The C → E disposition move is left to W3-F's closure reconciliation.

Still open: see `docs/phase3/README.md` ("Still open"), the single maintained list. Part D of `RULES_HARDENING_BACKLOG.md` should record OD-2 and OD-7 when the backlog is next updated (closure contract item 3).

---

## 8. Phase-4 deferrals

Only items the audit explicitly labels for playtest discovery (its `[PT]` items and its "Leave for Phase 4" list) are here.
No known Phase-3 defect is moved to Phase 4. Every row needs a reproducible observation procedure in W3-F's checklist.

| ITEM | WHY PHASE 4 | WHAT PHASE 3 MUST DO FIRST | WHAT EVIDENCE PHASE 4 SHOULD COLLECT |
|---|---|---|---|
| 47 flourish PLAYTEST entries (`VF/*`, D) | Audit: implemented but never watched; the judgement is visual | W3-H's real-browser evidence for C-10 / E-5; ledger statuses current (W3-F) | Per entry: watch the named variables on the baseline at 100% and 63% scale; pass or a re-tune note |
| AUD-04.05 U-2 / A-3 bar stuck on a previous step | Audit retest; unreproduced | W2-A holds; AUD-01.09 visible log export | Reload during each hold; screenshot the bar vs the server's `operating_sub_phase`; export the log |
| AUD-04.06 U-12 purchase tagged with the wrong step | Audit retest | AUD-01.09 | Log export after every train purchase; check the step tag |
| AUD-04.07 U-13 laid tile appears, then vanishes | Audit retest | W1-E | Screen recording on two seats; the log index of any vanish |
| AUD-08.02 U-14 wrong dividend after undo | Audit retest; waiting on a log | AUD-01.09 | Undo from Buy Trains after a dividend; log export; the figure shown |
| AUD-08.03 dividend animation timing | Audit [PT] | — | Three payouts at two scales; timing notes |
| AUD-24.01 U-1 retest #1237 / #1238 | Audit Phase-4 list | — | Fresh server; live-vs-history frame; the purchase toast |
| AUD-24.02 U-9 mirror instrumentation | Audit Phase-4 list | — | Two tabs per seat for one SR; any `[mirror]` console line |
| AUD-11.05 H-05 DA arming line on every seat | Audit [PT] | — | Screenshot every seat at the arming moment |
| AUD-11.06 U-34 dynamic operating order | Audit [PT] | W1-I note wording | Displayed vs played order across two ORs with price changes |
| AUD-06.06 DH-2 D&H re-offer | Audit [PT] | W1-M | Any later-turn re-offer with its log index |
| AUD-03.12 S-4 UI stricter than the engine | Audit [PT] | W1-A, W2-B | Sell / buy / sell within a turn; every greyed control the server would accept |
| AUD-05.04 tile ring first facing | Audit [PT] | W1-E (legal seed, guarded Confirm) | Upgrade E11 / New York, confirm without rotating; facing and any refusal |
| AUD-24.03 K-12 stall | Audit Phase-4 list | W1-A (cash check) | Auto-Buy armed for an unaffordable share disarms with a reason |
| AUD-19.03 recovery R1–R12 | Audit [PT] | W3-C, W3-I, W1-N | Each scenario: banner text, recovery path, log export |
| AUD-24.04 Rules Reference checkpoints (12 moments) | Audit Phase-4 list | W1-L, W1-I, W2-I | "Go to current →" at each moment: page, step, rule match, usefulness |
| AUD-24.05 DA 5-train cancellation reachability | Audit Phase-4 list | W2-I indicator | A constructed legal line toward a first 5-train before the auction |
| AUD-13.08 Firefox / Safari dialogs | Audit [PT] | W3-A, W3-D | Every NativeModal: Escape, trap, restore, on both browsers |
| AUD-16.06 real devices (iOS, Android, Firefox) | Audit [PT] | W1-O | One SR + one OR per device; screenshots |
| AUD-16.07 44 px touch targets at reduced scale | Audit [PT] | — | Hit areas at 63% / 80% on a phone |
| AUD-16.08 Ctrl+wheel zoom | Audit [PT] | — | 50–200% sweep; overflow or misplaced overlays |
| AUD-16.09 SR / OR at phone width | Audit [PT] | OD-10(b) scope | 360 / 390 / 430 px: every unreachable control |
| AUD-17.04 screen readers | Audit [PT] | W1-O, W3-A heading, W3-D | NVDA and VoiceOver walk-through; every unlabelled control |
| Observation columns on non-D rows (VF/D-17 low-end devices; P3-N022 shell-local OR facts) | Need a real device / real play | W3-H trace; — | Frame rate during a lay; bar step vs server step on every derived skip |

*Tooling option, not a defect:* the 6.5 preflight's instrumentation findings (its own IDs "I-1…I-7", unrelated to the 6.5-B
review items) are built in Phase 4 only if a Phase-4 observation needs them.

---

## 9. Systems that must stabilize before the App.tsx refactor

Status vocabulary: **NOT STARTED** · **PHASE-3 SLICE** (implemented in a slice) · **PHASE-4 VALIDATION** (implemented,
awaiting playtest evidence) · **READY FOR REFACTOR** (validated in Phase 4; its component boundary may be frozen). A system is
never marked READY because code was written.

| System (App audit module) | Status now | Phase-3 slices | Phase-4 validation needed | READY when |
|---|---|---|---|---|
| Action-dock model (M16) | NOT STARTED | W1-I, W2-A, W2-B (+ W1-I-b) | Yes: holds, Pass/End Turn, the dock height | W2-A/W2-B landed and the S-4 / U-2 rows pass |
| Pass / End Turn presentation (OD-2) | PHASE-3 SLICE (W2-B `90d5588` + `ca68b43` + #1274 `794e03c` / `699160c`; integrated on `phase3/wave2-bcg-v13cert-integration`, `181e51e`) | W2-B | Yes: S-4 | OD-2 applied and S-4 observed clean |
| Notice / modal policy (M7) | NOT STARTED | W3-A, W3-D | Yes: Firefox/Safari, chaining | Policy applied and AUD-13.08 clean |
| Game-screen heading / focus target | NOT STARTED | W3-A | Yes: screen reader | AUD-17.04 clean |
| Map interaction controller (M11) | NOT STARTED | W1-E, W1-F, W1-M (+ W3-E) | Yes: first facing, DH-2 | AUD-05.04 / AUD-06.06 clean |
| Watcher / home-station behaviour (H5) | NOT STARTED | W1-J, W2-H | Yes: every seat type | OD-1 applied; watcher walk-through clean |
| Pending-offer / hold model (M15) | NOT STARTED | W1-D, W2-A, W2-C, W2-F | Yes: R-scenarios with offers | All holds × seats observed |
| Unified refusal / error model | NOT STARTED | W1-H, W3-C | Yes: R1–R12 | OD-12 ruled; R1–R12 clean |
| In-flight latch scope | NOT STARTED | W1-B, W1-D, W1-E, W2-C, W2-G, W3-B, W3-I | Yes: double-click and reconnect probes | Coverage test green; no double-send observed |
| Status dock / header (M9 / M17) | NOT STARTED | W1-I, W2-I | Yes | OD-6 applied; no overlap at phone width (per OD-10(b)) |
| Room gate / waiting room / money panel (M5) | NOT STARTED | W1-O, W2-K, W2-M, W1-K | Yes: a JUNOX deposit flow on the baseline | Wallet flows observed clean |
| Endgame / settlement band (M10) | NOT STARTED | W1-N, W2-M, W2-L | Yes: a full game to settlement | Ties, Leave, close, dispute observed |

---

## 10. Estimates

Recalculated from the reconciled slices. Hours are Claude engineering labor (implementation, the slice's own tests,
narrow runs, review fixes). Where one change resolves several audit items, it is counted once.

### 10.1 Aggregate Claude engineering labor

| Block | Hours |
|---|---|
| Wave 0 (P0) | 2.5–3.5 |
| Wave 1 (15 slices: W1-A … W1-O) | 58.5–78 |
| Wave 2 (13 slices: W2-A … W2-M) | 50.5–69 |
| Wave 3 (W3-A, B, C, D, F, G, H, I; excluding the conditionals) | 29.5–45.5 |
| W3-J U-28 remediation reserve | 4–10 |
| Integration, rebases and shared-pin repair (~42 landings) | 10–16 |
| Diagnosing owner-gate failures (4 gates) | 5–9 |
| **Total (unconditional)** | **≈ 160–231 h** |
| Conditional, only if the owner rules them in | W3-E 5–8 (OD-11) · W1-I-b 3–5 (OD-14a; not opened — OD-14(a) RULED keep, 2026-10-04) · W3-K 8–14 (OD-10a) |

*Comparison:* the audit's 70–115 h was a backlog sum without parallel-integration overhead. The draft's 115–150 h covered
fewer items (it lost about 45). Neither is inherited.

### 10.2 Expected wall-clock engineering time (safe maximum parallelism)

Computed by scheduling every slice on its lane in the §4.1 order and starting it only when its §4.3 dependencies have
landed (P0 first; times after P0, low–high):

| Lane | Finishes at |
|---|---|
| L3: W1-D → [waits for W1-B, W1-E, W1-I] → W2-A → W2-C → W2-F → [waits for W2-H] → W3-I | 24–33.5 h |
| L6: W1-L → W1-H → [waits for W2-E] → W2-J → W3-C → W3-G, then W3-J's tail across free lanes | 22.5–35 h (W3-J tail included) |
| L5: W1-I → W1-J → W2-G → W2-H → W2-I → W3-A → W3-D | 22.5–31.5 h |
| L2: W1-C → W2-E → W1-M → [waits for W2-A] → W2-D → [waits for W3-H] → W3-B | 20–29 h |
| L7: W1-K → W1-N → W1-O → W2-K → W2-L → W2-M | 21–30 h |
| L4: W1-E → W1-F → W1-G → W3-H | 16.5–24.5 h |
| L1: W1-B → W1-A → [waits for W2-A] → W2-B | 16.5–22 h |

- **Critical path:** two near-equal chains, both ending in W3-F:
  - (a) **P0 → W1-D ∥ W1-E ∥ W1-B ∥ W1-I → W2-A → W2-C → W2-F → W3-I** (OD-1 decided during wave 1);
  - (b) **P0 → W1-C ∥ W1-L → W2-E → W2-J → W3-C → W3-G → W3-J → W3-F.**
- **Expected wall-clock engineering time: ≈ 34–52 h** = P0 2.5–3.5 + the longer chain 24–35 + integration hand-offs on
  the path 2–4 + gate-fix work on the path 3–6 + W3-F 2.5–3.5.
- **If the owner wants broad gates as barriers** (§4.2), waves serialize. Wave 1 ends at the longest wave-1 lane (13–16.5 h)
  and wave 2 at 28.5–37 h. The total becomes **≈ 49–73 h**.
- This excludes the owner's elapsed time for decisions and broad gates (below), which adds calendar time but not
  engineering hours.

### 10.3 Owner time

| | Hours |
|---|---|
| Decisions OD-0 … OD-18 (OD-1 is the largest) | 3.5–6.5 |
| Broad gates (after waves 1, 2 and 3, and the final gate) | 6–10 |
| Reviewing U-28 findings and the closure report | 1–2 |
| **Total** | **≈ 10.5–18.5** (Terms-page authoring for OD-16 is the owner's own content and is not estimated) |

### 10.4 Maximum useful concurrent lanes

**7 + integrator.** The seventh lane exists because the reconciled backlog adds disjoint money / Host Game / statistics /
endgame work. An eighth lane would have to split lanes 3, 4 or 5, which would put two writers on the bar's prop groups, the
consent block, the ring or the notice regions. Above seven, the single integrator's serial rebases and the owner's gates bind.

---

## 11. Phase-3 closure contract

Phase 3 is **not** complete merely because every W branch merged. All of these are required:

1. Every authoritative audit item has a final disposition in the matrix (`check_phase3_accounting.py` PASS at the
   integrated head; no row C or G remains unruled).
2. Every PHASE-3 IMPLEMENTATION row (A, B) is fixed and has a focused test (or a source pin where `AppShell` cannot render).
3. Every owner decision Phase 3 needs (OD-0 … OD-18) is answered and recorded in backlog Part D; every "restate" item
   (OD-2, OD-7) has its text.
4. **U-28's retrospective UI-parity audit (W3-G) is COMPLETE.**
5. Every U-28 finding is fixed, proven obsolete or resolved, or explicitly owner-ruled. None is deferred to "polish".
6. No known player-facing defect was moved to Phase 4. The only D rows are the audit's own playtest items. **Every E row
   cites an owner ruling**: the fixed roadmap in §1 for refactor work (AUD-21.08, AUD-23.01, P3-N022), or an OD answer
   (OD-10, OD-11, OD-12, OD-18) for anything else placed later.
7. Every Phase-4 row (§8 and every D row) has a reproducible observation procedure in the Phase-4 checklist.
8. The owner's broad gate PASSes on the integrated Phase-3 head.
9. The Phase-4 playtest baseline head (full SHA) is recorded in `PROJECT_CANONICAL_CONTEXT.md` and `docs/phase3/README.md`.
10. The major App.tsx refactor has NOT begun: no region extracted into modules, no `src/shell/` decomposition, and no
    whose-turn consolidation.
11. Gameplay and settlement versions are as the owner ruled. Without W3-K they are unchanged. With W3-K, settlement accepts
    the new rules version only after its own certification.
12. Backlog Part C, `VISUAL_FLOURISH_BACKLOG.md` and the matrix agree on every item's status.

---

## 12. The audit's highest-risk systems → where they are handled

| Audit system | Slices |
|---|---|
| 1. Pending offers and holds (U-6, U-20, U-21, U-22, K-05, K-13) | W1-D, W2-A, W2-C, W2-F |
| 2. The action dock and turn gate (nine whose-turn derivations, U-2, U-16, A-14, A-17) | W1-I, W2-A, W2-B, W1-G; consolidation is Phase 5 (AUD-23.01) |
| 3. The map interaction controller (A-7, H5, U-17) | W1-E, W1-F, W2-H, W3-E |
| 4. The Stock Round panel's local rules copies (U-23, U-25, U-39, SBS) | W1-A, W2-B |
| 5. The auction dashboard (K-02, K-15, the contest, double-send) | W1-B |
| 6. The M&H exchange flow (U-35's five parts) | W1-C (i, ii), W2-D (iii: off-turn / OR), W2-E (iv, v) |
| 7. The notice and modal layer | W3-A, W3-D |
| 8. The error and refusal model | W1-H, W3-C, W3-B |

---

## 13. Working rules for every Phase-3 session

- Read `PROJECT_CANONICAL_CONTEXT.md`, then this directory. Do not bulk-read `archive/` or historical Project reports. The
  exception is W3-G, which reads the named batch reports.
- **Narrow tests only** for the slice's directly affected suites. No full Jest suite, full server suite or broad build unless
  the owner asks; the owner runs the broad gates.
- **Integer arithmetic** for anything financial; no floating point (K-24's placeholder is removed, not rewritten).
- No push unless the owner authorizes it. One writer in the real checkout. Respect the slice's hard-stops.
- Every slice updates its matrix rows (status and evidence) in the same branch, and the accounting check stays PASS.

---

## Appendix A — reference procedures and facts (inlined so the plan is self-contained)

### A.1 Recovery scenarios R1–R12 (AUD-19.03; from the 6.5 functional-playtest preflight §8, adapted)

Adapt the server-restart and build-guard mechanics to the hosting in use at the Phase-4 baseline.

| ID | Test | Checkpoints | How | Pass condition |
|---|---|---|---|---|
| R1 | Refresh the acting seat | (a) tile picker open; (b) between Run and Dividends; (c) mid-contest; (d) B&O winner before par; (e) emergency modal open; (f) discard prompt open | F5 | Same seat; same board (the log hash before = after, from the log export); the required control is visible with no extra steps |
| R2 | Refresh a non-acting seat | while another seat acts | F5 | Catches up with no toasts; controls correctly disabled |
| R3 | Close and reopen | mid-SR; mid-OR | close the tab → lobby → Your tables → the table | Back in the same seat |
| R4 | Network loss | the acting seat mid-turn | offline for 10–30 s; click during the gap | Banner "Connection to the room was lost — reconnecting…"; the queued move lands if nobody else moved, otherwise "The room had moved on — this tab has caught up. Try that again."; never a false "Could not reach the room" once reconnected |
| R5 | Reconnect after others moved | one seat offline across 3+ moves by others | as R4 | Only the missed entries are applied; the controls are right |
| R6 | Server restart | (a) after an SR's last pass; (b) mid-OR between corporations; (c) Delayed Auction with the par owed; (d) at GameEnd | restart the game server on the same build | Restored with the same log hash; clients reconnect by themselves; the par is still owed only by the winner |
| R7 | Stale modal | the host undoes the acting player's last action while that player has the picker, a route draft, the emergency modal or an armed home placement open; an offer answered while the other seat's prompt is open | host Undo | Every open surface closes or re-derives; no stale control dispatches |
| R8 | Two tabs, same profile | mid-OR | act in tab 1 while tab 2 shows the same panel; click both near-simultaneously | Tab 2 updates; one click lands, the other gets the moved-on answer; no divergence banner |
| R9 | Second device | any | Profile → Link another device (single-use code, 10 minutes) | The device holds every seat and can move |
| R10 | Undo semantics | own last action; host undoing another's; a deep jump (refused); after GameEnd (refused); across a phase change; across the B&O par | Undo | One step each; the exact prior board; refusal sentences right |
| R11 | Build guard (optional) | between rounds | restart on a different build, then the right one | Refused with "…dealt on build X…", then resumes |
| R12 | Divergence banner | throughout | — | "This tab has drifted from the room…" never appears; any appearance is P0 evidence (keep the export and console) |

### A.2 Rules Reference checkpoints (AUD-24.04)

At each moment the tester opens the Rules Reference, presses **"Go to current →"**, and records: (1) the right page and step?
(2) does the displayed rule match what the game just did? (3) was it useful? A mismatch in substance is misleading copy and
counts toward the gate (after the owner confirms the intended rule); wording that is merely not ideal does not.

| # | Moment | Check |
|---|---|---|
| 1 | Opening auction; the Delayed Auction | Auction page; the Delayed Auction notes; SV-only markdown; re-entry; escrow |
| 2 | SR1 | The first-Stock-Round reminder; the sale ban stated as the rule |
| 3 | Must-sell / certificate limit | "Only what a legal sale can fix" at every site |
| 4 | First OR turn, home token owed | The home-station step is marked current (after W1-I) |
| 5 | Each OR step | CURRENT follows `operating_sub_phase`; Buy Private is never marked current (by design) |
| 6 | A route below the maximum refused | RR-1 wording (after W1-L) |
| 7 | G19 first green upgrade | The terrain exception (G19, D10, E5 pay their printed terrain cost once) |
| 8 | A forced purchase, treasury only; with the president's contribution | RR-4 (per OD-7); RR-7 |
| 9 | M&H exchange (own turn, queued) | RR-6 / the U-35 gotcha (after W2-E) |
| 10 | Phase changes | The Tables page's live phase row; the Phase 5 private closure; the Delayed Auction phase cells |
| 11 | Bank broken | Bank-break timing text |
| 12 | GameEnd | A game-over state (after W2-I), not "No live round" |

### A.3 Facts the slices rely on

- **H5 (modal audit, 2026-09-18).** Two `aria-modal` surfaces render with zero tabbable controls, no Escape, no close control
  and no backdrop dismissal: `HomeStationPrompt` for a non-president ("Waiting for the … home station token") and
  `AuctionPromptModal` during the auction handoff ("The Waterfall Auction is complete"). Focus stays outside the dialog and
  Tab walks the page behind a full-screen scrim. They are legitimate waiting states, so the fix is a product decision (OD-1).
- **I-1 / I-2 (6.5-B review).** I-1: after the B&O par modal's 4 s hard release, a par send that a reconnecting link had
  queued can be followed by a second press, possibly at a different rung; on reconnect the first lands and the second is
  refused ("B&O already has a President…") with a room error banner. A real fix needs the link's queued-submission state in
  the modal (W3-I). I-2: the "not reached the table yet" note can flash after a send that did land, if the drain is slower
  than the 1.5 s grace.
- **I-3, R4 (6.5-B review).** I-3: the fixed 400 px pointer can overlap the right-hand Private Companies card. R4: a proposal
  dropped in the browser (link reconnecting, or catch-up) loses the typed form.
- **LOW-4 (R12-2 report).** The lay preview's `layTileRefusal` call uses `withRules` without the board's rules revision;
  harmless today because the revision changes no tile-lay rule.
- **Game id (LIVE-2 §7.2).** The hosted table shows its room code, never its game id. Showing it was OD-6 — RULED 2026-10-04 (Option A): it stays undisplayed.
- **OD-A-2 / OD-A-4 / RR-4 (6.5-B header).** "RR-4, OD-A-2 and OD-A-4/SBS-4 recorded, not implemented; OD-A-3 (D10 and E5
  follow G19) reflected in the copy only." Only OD-A-3's content is on record, so OD-2 and OD-7 ask for the others' text.
- **App decomposition module names** used in §9: M5 room gate / waiting room / money panel; M7 notice and modal layer;
  M9 / M17 status dock and header; M10 endgame and settlement band; M11 map interaction controller; M15 pending-offer / hold
  surface; M16 action dock.
- **Batch reports for U-28 (W3-G):** `archive/claude-history/BATCH1_ENGINE_RELOCATION_2026-09-14.md`,
  `BATCH3_OPERATING_AUTHORITY_2026-09-14.md`, `BATCH4_TRAIN_LIFECYCLE_2026-09-14.md`, `BATCH4.5_RULES_VERSION_2026-09-14.md`,
  `BATCH4.6_TRAIN_DISCARD_2026-09-14.md`, `BATCH5_EMERGENCY_FUNDING_2026-09-14.md`,
  `BATCH6_ROUTE_AUTHORITY_2026-09-15.md`. Batch 2 has no report; use backlog Part A "Stage 2" (`dca00bb`).
