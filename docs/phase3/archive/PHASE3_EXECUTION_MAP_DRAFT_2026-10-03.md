<!--
PROVENANCE (header added by the Phase-3 reconciliation pass, 2026-10-03; not part of the draft):
- Source: the parallel execution-map DRAFT, delivered as chat text on 2026-10-03 (attachment
  "Pasted text(20261003-185757).txt"), SHA-256 23aa874af808167e1cecb19f6a29ae90b0e70df97e1490c0343c9093e1979839. Preserved byte-for-byte below for provenance only.
- STATUS: SUPERSEDED by docs/phase3/PHASE3_EXECUTION_PLAN.md and PHASE3_AUDIT_RECONCILIATION.md.
  The draft was written WITHOUT access to the authoritative audit; it lost audit items, and its OD-0
  (choose 083d066 or main) is replaced. Do not execute from this file. Its W-slice IDs are kept stable
  in the plan.
-->

# PHASE 3 EXECUTION MAP — parallelization plan (read-only) — 2026-10-03

| | |
|---|---|
| **Pass** | Read-only planning. No source change, no commit, no push, no AWS, no test runs. |
| **Tree read** | `083d066` (`recon/gs-host-multiline-stderr`; its `frontend/src` is byte-identical to `5b4756d` and `9e45ded`). Rules v12. `App.tsx` 15,558 lines. Every `file:line` below is at `083d066`. |
| **Input gap** | The completed Phase 3 UI/UX audit was **not reachable**: it is not in the Project docs or on any pushed branch, and the bridge to the local checkout failed (filesystem tools errored; no folder connected). The backlog was rebuilt from `RULES_HARDENING_BACKLOG.md` Part C, the Phase 6.5 register (preflight §4, 6.5-A §6, 6.5-B), the APP-TSX audit, and six fresh read-only source audits of `083d066`. **Reconcile item IDs against the Phase 3 audit before wave 1 starts.** |
| **Roadmap** | Phase 3 = fix what players see and use · Phase 4 = human playtest and stabilization · Phase 5 = the App.tsx refactor. Nothing here moves the refactor earlier. |

## 0. The findings that shape the plan

1. **Do not run "rules-authority cleanup" as its own lane.** Every shell restatement lives inside the surface of the system it belongs to (Stock Round panel, auction dashboard, M&H flow, offer panels, tile ring, route preview). A standalone authority lane would collide with every other lane. Each system slice owns its own restatements. The one exception is `utils/refusedAction.ts` (U-29/U-30), which is standalone.
2. **The action dock is the hottest shared surface.** `<ContextualActionBar>` takes 77 props in one 428-line JSX block (`App.tsx:13882-14311`), pinned by 32 source-scan suites. Every hold item converges on one nested `passDisabledReason` chain (`:14001-14036`).
3. **Holds, the waiting-player modals (H5) and the "waiting on X" surface are one product decision**, not three. Until it is made, the holds slice, the unified-waiting slice and the modal slice cannot start.
4. **Several restatements are invisible bugs today**, not only duplication:
   - `passDisabledReason`'s home-hold and train-obligation arms are dead: the Pass button renders only outside the OR.
   - The OR bar knows no hold at all.
   - The M&H chip is greyed off-turn even in the Stock Round (`ContextualActionBar.tsx:2236-2239` ANDs in `sessionReady`, which includes `isMyTurn`).
   - A watcher sees a live **Place Home Station** button (`App.tsx:13549-13553`, `!viewerAddress` while a watcher's address is `""`).
   - Tutorials re-arm on every table mount (`App.tsx:1081-1084`).
   - A non-turn server refusal is sticky in the room strip (only `TURN_REFUSAL` is cleared, `:6425-6427`).
5. **RED regions stay untouched in Phase 3:** the submit and apply halves of `runGameplayAction` (`6227-6468`, `6469-8758`), the link drain (`12278-12681`), `rebuildSandbox` (`8877-8965`) and the OR verdict / auto-skip block (`11136-11659`). Every slice below avoids them except where flagged.

---

## 1. Wave 0 — preparation (serial, one writer, ~1.5–2 h)

**P0 — Base, seams and ownership.**
- **Owner pins the Phase 3 base SHA (OD-0).** `083d066` differs from `main` (`e1f1280`) in 69 `frontend/src` files.
- **S1, the one recommended code seam.** Hoist the `passDisabledReason` expression out of the bar JSX into a plain `const passDisabledReason = …` just above `return (` (`:13417`). Pass `passDisabledReason={passDisabledReason}`.
  - Keep it a plain `const`, not `useMemo`, so it recomputes every render exactly as today.
  - It stays in `App.tsx`, so the `readShell().toContain` pins still hold (`homeTokenGate`, `forcedDivestment`, `emergencyTrainFlow`, `homeStationWait`).
  - One pin moves: `phase65bShellWiring.test.ts` `sliceBetween("passDisabledReason={", "turnActionTaken=")`. Re-anchor it on the const. Its `expectOrder` still holds.
- **Conventions (no code):**
  - **S3:** never append imports at the tail (`:822`); add each new import beside a related import.
  - **S4:** never append props at the end of the bar mount; insert new props inside the lane's own prop group.
  - **Regions:** record the lane → App.tsx region ownership table (§7).
  - **Tests:** new tests use `sourceScan` readers (`readShell`, `sliceBetween`, `readStripped`), never raw `readFileSync` with `\n` anchors (CRLF).
- **Acceptance:** zero behaviour change; the re-anchored `phase65bShellWiring` passes; `tsc` clean.

---

## 2. FIRST WAVE — parallel, no owner decision needed

Each slice: outcome · surfaces · acceptance · focused tests · dependencies · effort.

### W1-A — Stock Round reads one authority (U-25, U-23 logic, U-39/K-07, K-12, SBS-1, SBS-5) · 8–10 h
- **Outcome:** every Buy and Sell control is enabled exactly when the server would accept it, and greyed with the server's own sentence. Selling and buying are no longer forced through UI stages.
- **Surfaces:**
  - `App.tsx` `purchaseBlockFor` / `saleBlockFor` `9561-9624` → wrap `stockPurchaseRefusal` (pass `parValue`) and `stockSaleRefusal`. Delete the two shell-only stage refusals (`9570-9577`, `9605-9612`); the owner's Stock Round ruling already makes them wrong.
  - Auto-Buy `9886-9944`: check must-sell before the stage Pass (SBS-5). Cash is checked through the new wrapper (K-12).
  - `StockRoundPanel.tsx` `CompanyActions` `2262-3007`:
    - `cannotAfford`, `multiBuyMax` → `maxPurchaseQuantity`;
    - the source toggle → `ordinaryPercentAvailable`;
    - `sellOptionState` and `BANK_POOL_CAP_PERCENT` → the sale predicate;
    - `sellingForbidden` → `isFirstStockRound`.
  - **K-19 copy:** the SR1 tooltip states rulebook §5.1 instead of calling it a house rule.
- **Acceptance:**
  - every Buy and Sell `disabled` state equals the predicate's verdict for the viewer;
  - SR1 Sell is greyed with the authority's sentence;
  - a 0% or reserved-only source never offers Buy;
  - LPF allows the fifth pool certificate;
  - Auto-Buy with too little cash disarms with the reason instead of stalling.
- **Tests:**
  - a component test of `CompanyActions` over a matrix of boards (SR1, unparred, Brown pool, LPF 20% card, reserved C&A share, insufficient cash);
  - an `autoBuy` decision test.
  - **Pins to rewrite:** `sellBuySell.test.ts:160-180` (stage sentences), `phase65bShellWiring` `saleBlockFor` order, `presidentCertificateSale:347`, `reducerReadsOneChart:76`, `autoBuy.test:125,223`, `blockPropThreading:77-83`.
- **Dependencies:** P0. Owns `9561-9944` and the `StockRoundPanel` mount `14496-14600`.
- **Not in this slice:** the Pass / End Turn presentation (W2-B, after OD-2).

### W1-B — Auction dashboard sync (K-02, K-15, K-16, H-04 auction, A1-new, A2-new) · 5–6 h
- **Outcome:** a player can raise their own standing bid. The contest Pass says what it does. The dashboard cannot double-send. Delayed Auction solvency refusals show before the click.
- **Surfaces:**
  - `WaterfallAuctionDashboard.tsx`: read `waterfallBidRefusal` / `waterfallBuyRefusal` instead of `repeatBidReason` and a bare `bidRejectionReason` (`:493-497`, `:858-866`).
  - Relabel "Drop out … refunded in full" (`:811-813`) to the S7-3 meaning ("Pass — your bid stands").
  - Render `passes_since_raise` (`:762-766`).
  - Sibling cards show the contest sentence instead of "Not your turn" (`:844`, `:892`).
  - `App.tsx`: the K-15 sentence inside the S1 const; the Undo label "the last drop-out" (`:8998`); the dashboard `sessionReady={controlsEnabled && !actionInFlight}` (`:14416`).
  - `PlayerCards.tsx:207` → `PRIORITY_DEAL_TOOLTIP` with corrected wording.
- **Acceptance:**
  - an own-bid raise is enabled at `minimumBidFor(…, raisingFrom)` and sends the increment;
  - a Buy/Bid the authority refuses is never shown enabled;
  - the dashboard is greyed while a send is in flight;
  - no "refunded" copy remains.
- **Tests:** a rendered-dashboard click test for the own-bid raise, the contest pass label, the in-flight disable and a DA solvency-refused board. Nothing pins the old copy. `disabledLook` needs ≥4 disableable controls.
- **Dependencies:** P0 (the S1 const line). Effort is mostly component-only.

### W1-C — M&H exchange reads the authority, and the owner picks the source (U-35 i/ii, K-03, M2-new) · 4–4.5 h
- **Outcome:** the M&H flow offers exactly the legal exchanges, from the IPO or the Bank Pool as the owner chooses (ruling R2).
- **Surfaces:**
  - `App.tsx` `runPrivateExchange` `5831-5856` → `mhExchangeRequestRefusal` per source;
  - `handlePowerFlowAct` `5863-5885` passes the chosen source;
  - `privatePowerFlow.ts:213-255` adds a step per legal source;
  - `PrivatePowerFlowModal`;
  - retire the local rule in `privateExchange.ts`'s `resolvePrivateExchange`.
- **Acceptance:**
  - the Orange/Brown 60% waiver is honoured;
  - the certificate limit is checked;
  - both sources are offered when both are legal, only the legal one otherwise;
  - no silent IPO-first.
- **Tests:** a flow-model test over the source matrix; a room test that the chosen source is the one sent. **Pins:** `powerRefusalAndChips:43-76`, `mhStockRoundChip`, `privatePowerFlow:216-224`.
- **Dependencies:** none. **Not in this slice:** the off-turn chip (W2-D) and queued visibility (W2-E).

### W1-D — Proposer rescind; retire the chain-era trade controls (K-05, U-20/U-21 rescind, K-14, NEW-3) · 5–6 h
- **Outcome:** whoever proposes an OR private or train purchase can withdraw it. Dead chain-era controls are gone.
- **Surfaces:**
  - new rescind handlers beside `10471-10490` and `11031-11090`. They send `RescindPrivatePurchase` / `RescindTrainPurchase`, on turn, with **no** `offTurn` (keeps `trainOffer.test`'s count of 7);
  - delete the `RescindTrainOffer` handlers `11060-11120` and the `TrainTradePanel` mount `14460-14485`;
  - the consent block `15185-15234` gains `viewerIsProposer` / `onRescind`;
  - `TrainPurchasePanel.tsx:1550-1780`, `PrivateTradePanel.tsx:583-700`;
  - answerer identity: `currentPrivateOwner` / `sellerPresident` instead of the narration fields;
  - drop the optimistic "completed immediately" lines for same-president trades (`10437-10441`, `10945-10953`);
  - latch the four prompts (pass `actionInFlight`).
- **Acceptance:** Rescind is visible to the proposer only and accepted by the server; no chain-era control remains mounted; the answer is offered only to the authority's answerer.
- **Tests:** a `phase65bConsentPrompts`-style render test for proposer, answerer, third seat and watcher; a `RoomSession` rescind test for both offer kinds. **Pins:** `trainOffer.test`, `privateOffer.test`, `inactiveTurnBar`, `phase65bShellWiring` consent slice.
- **Dependencies:** none. **Lane 3 owns the consent block and both prompt components from here to the end of Phase 3.**

### W1-E — Tile ring correctness (first facing, `canConfirm`, local lay restatement, U-38 receipt) · 5–7 h
- **Outcome:** the ring opens on a legal facing and cannot confirm a lay the server will refuse. Errata tiles are named canonically.
- **Surfaces:**
  - `onSelectCandidate` `15358-15408` seeds from `stationLegalFacings`;
  - one memo asks `layTileRefusal` for the previewed lay and feeds `canConfirm` (`15347-15353`) and its tooltip;
  - `tileLayDisabledReason` `11742-11773` → `layTimingRefusal` / `layTileRefusal`;
  - fix the false comments (`12157-12162`, `15355-15357`);
  - latch the ring confirm;
  - U-38: `App.tsx:3811` receipt and the `RadialTileSelector.tsx:653,685` aria labels via `canonicalTileName`.
- **Acceptance:** on a tokened upgrade the preview opens on a legal facing; Confirm is greyed with the authority's sentence on an illegal facing; the receipt reads `#8861`.
- **Tests:** a pure test of the facing seed and the `canConfirm` memo inputs. **Pins:** `stationConnectivity:221` requires exactly 3 `derivePreviewLandings(` calls, so do not add a call; also `previewRotation`, `previewTokenLanding`, `roundTripPaint`.
- **Dependencies:** none. Owns `11742-12241` and `15326-15436`.

### W1-F — Map click precedence and visible station refusals (map-precedence, NEW-1-map) · 2–3 h
- **Outcome:** a home-station click never also opens the tile ring, and a refused station click says why.
- **Surfaces:**
  - withhold `gameId` / `protocolId` from the board while a home-station errand is armed (`14665-14680`). This is render-time, with no new refs;
  - `handleTokenHexClick` `10644` writes its reason to a visible surface instead of the Routes-only `routeFeedback` slot.
- **Acceptance:** with a home errand armed, a click opens only the station ring; a click on a dimmed city at Tokens shows the evaluator's reason.
- **Tests:** a renderer prop-gating test; a feedback-routing test. `stationVeil`'s chooser indentation pin is untouched.
- **Default to confirm:** the refusal goes to the existing `showActionToast`.

### W1-G — Route preview reads the route authority (K-11, NEW-2-routes, K-26) · 3–4 h
- **Outcome:** the Run button prices and counts only routes the server will accept, and a weaker-than-maximum set is explained beside the routes.
- **Surfaces:**
  - the pre-dispatch check `10101-10116` → `routeSetRefusal`;
  - `RoutePlannerPanel.tsx:166-173` `isRunnableDraft` / `runnableRouteSummary` → `runnableDrafts`;
  - feedback when drafts are dropped;
  - the K-26 tooltip;
  - retire the dead `RoutePlannerPanel` component's second refusal order.
- **Acceptance:** the projected revenue equals what is sent; no draft disappears silently.
- **Tests:** `runTrainsRules`-style pure tests. **Pins:** `atomicRunRoutes:180` (exactly one dispatch between `runnableDrafts(` and `setLiveOrSubPhase(`).
- **Not in this slice:** the `ran:true` correction, which is RED (Phase 4 deferral).

### W1-H — Replayed refusals carry their reason (U-29, U-30) · ~3 h
- **Outcome:** the Activity Log never prints REFUSED without a reason.
- **Surface:** `utils/refusedAction.ts` only. Use `stockPurchaseRefusal` / `stockSaleRefusal`, and add arms for `pendingOfferBlock`, `homeStationHold`, `Propose*` / `Rescind*` / `*PrivateTrade`.
- **Tests:** `refusedAction.test` cases per arm. **App-free.**

### W1-I — Dock hygiene and status facts (U-16, NEW-5 copy, K-23 ledger, build id, U-34, home-token step marker, dock landmark) · 4–5 h
- **Outcome:** no developer text or temporary instrument in front of players; the bank and build facts are true.
- **Surfaces:**
  - `ContextualActionBar.tsx`: remove `useStickyFitProbe` (`715-806`, `1465`, `4566-4570`; the backlog says remove it either way); rewrite the Skip tooltip (`3501`) and the "$0 dividend" tooltip (`1988`; `appNaming` pins this string);
  - `FinancialLedger.tsx:163-188` "Bank broken — owes $N";
  - Rules Reference header: `CLIENT_BUILD_ID` instead of `UI_BUILD_NOTE = 640`;
  - the `operatingOrderView.ts` note wording;
  - a home-station pre-step marker in `RulesReference`;
  - `role` / `aria-label` on the dock (`App.tsx:13829`).
- **Tests:** delete `stickyFitProbe.test.ts` with the probe and adjust `stickyTrap`/`stickyBarSplit`; a ledger render test; `rulesOverview:743-751`.

### W1-J — Quick correctness: the watcher's home-station form · 0.5 h
- **Change:** `App.tsx:13549-13553` → `!spectator && president === viewerAddress`, with a regression. Lane 5 builds on this later in W2-H.

### W1-K — Money: cross-tab Keplr single flight (U-45) · ~3 h
- **Change:** a lock (`navigator.locks` or a storage lease) taken before Keplr opens, in `moneyActions.ts` / `pendingTx.ts`.
- **Tests:** a two-tab simulation test. **App-free.**

### W1-L — Rules Reference and runbook copy, no rulings needed (RR-1, RR-3, RR-5, RR-7, U-38 TileReference, runbooks, U-8 closure) · 3–4 h
- **Surfaces:** `RulesReference.tsx`, `TileReference.tsx`, `PLAYTEST_TRANSPORT.md`, `PLAYTEST_NGROK.md`, backlog Part C.
- **Tests:** `rulesOverview`, `rulesTables`, `stage93TileAuthority`. **App-free.**

---

## 3. SECOND WAVE — after owner decisions or first-wave results

### W2-A — Holds visible everywhere (K-13, U-22, K-21 Skip, NEW-1 dead arms, NEW-2 OR bar, NEW-1 `trainPurchase.blockedReason`) · 8–10 h
- **Gate:** OD-1 (the waiting model), and W1-E landed (it shares `tileLayDisabledReason`).
- **Outcome:** while any authoritative hold stands (discard, funding, offer, home token), no seat sees a live control the server would refuse, and everyone reads the same sentence.
- **Surfaces:**
  - one new bar prop `turnHoldReason`, computed from `authoritativeHoldRefusal`. Implement it as a pure helper (`utils/dockHoldView.ts`) with one call site;
  - consumers in `ContextualActionBar`: `contextualButtons` `1830-2117`, Skip `3488-3505`, Pass `4184-4195`;
  - in `App.tsx`: the hold arm in `tileLayDisabledReason`, the token `canConfirm` (`15319`), `trainPurchase.blockedReason` (`14188-14192`, which reads the dead chain `trainOffers`), `privatePurchase`;
  - the S1 const loses its dead arms.
- **Tests:** a pure `dockHoldView` matrix (four holds × answerer / proposer / president / other seat / watcher); a rendered-bar test that Skip, End Turn and Lay are greyed with the sentence. **Pins:** `phase65bShellWiring`, `homeTokenGate`, `homeStationWait`.
- **Must land before:** W2-B, W2-D.

### W2-B — Stock Round turn presentation (SBS stage UI, must-sell banner) · 3–4 h
- **Gate:** OD-2, and W1-A + W2-A landed.
- **Surfaces:** the bar stage block (`ContextualActionBar.tsx:4150-4210`), `stockStage` (`App.tsx:14042-14046`), a must-sell banner in `StockRoundPanel` from `divestmentDebt`.
- **Tests:** `sellBuySell`, `sellIsNotAPass` updates; a banner render test.

### W2-C — Offer panels read their authority (U-20, U-21 legality) · 3–4 h
- **Gate:** W1-D and W2-A landed (same `trainPurchase` and `privatePurchase` objects).
- **Surfaces:** `PrivateTradePanel.tsx:85-110` → `proposePrivatePurchaseRefusal`; `TrainPurchasePanel.tsx:573-611` → `proposeTrainPurchaseRefusal`; latch the embedded `ProposePrivatePurchase` (NEW-4).
- **Tests:** a panel matrix at the ½×/2× band edges, the treasury, a corporation-owned seller and the same-president shortcut.

### W2-D — M&H request off-turn and in the OR (K-04, M1) · ~3 h
- **Gate:** W1-C and W2-A landed (chip gating, hold arms).
- **Surfaces:** `activePrivatePower.ts:131`; exempt the chip from `sessionReady`'s turn component (`ContextualActionBar.tsx:2168-2240`); the chip's blocked reason adds `authoritativeHoldRefusal`. **Pin:** invert `activePrivatePower.test:122`.

### W2-E — M&H queued-request visibility (U-35 iv, K-17, RR-6) · ~4 h
- **Gate:** OD-3, and W1-C landed.
- **Surfaces:** `actionLog.ts:514-522` branches on `afterState.pending_mh_exchange`; a table-visible marker from `pending_mh_exchange`; a requester acknowledgement; RR-6 copy (`RulesReference.tsx:1394-1419`).
- **`actionLog.ts`:** owned by this slice until it lands; W2-J follows it.

### W2-F — Unified "waiting on X" surface (U-6) · 4–6 h
- **Gate:** OD-1, and W1-D landed. Lane 3, same files as W1-D.
- **Surfaces:** the consent slot `15180-15250` and the four prompt components; one sentence from `describeStandingOffer`.

### W2-G — Emergency funding modal (close / back, viewer scope, K-25, funding-offer legality, latch) · 4–5 h
- **Gate:** OD-4.
- **Surfaces:**
  - `App.tsx` `1952-1964`, `13565-13605`;
  - `EmergencyTrainPurchaseModal.tsx`: the whole file, including `:368-375` → `fundingPrivateOfferRefusal`, and `:183` for K-25.
- **Pins:** `walletDialogDismissal:357-362` asserts no `onClose`; `moneyVocabulary:96-108`; `emergencyTrainFlow`.
- **This slice owns this file for Phase 3.**

### W2-H — Waiting-player prompts (H5: HomeStationPrompt, AuctionPromptModal; K-21 copy) · 3–4 h
- **Gate:** OD-1, and W1-J landed.
- **Surfaces:** both components; App mounts `13510-13563`. Migrating either to `NativeModal` edits the `nativeModalBoundary:639` exclusion list. K-21's "has floated" copy is pinned at `homeStationWait:88`.

### W2-I — Status visibility (game id, rules version, GameEnd Rules Reference copy) · 1–1.5 h
- **Gate:** OD-6. **Surfaces:** `TopBar.tsx`, `RulesReference.tsx:2413,3312`, App `14916-14921`.

### W2-J — Narration corrections (K-18, K-20, K-22, U-40, RR-4 copy) · 4–6 h
- **Gate:** OD-7, OD-8, and W2-E landed (`actionLog.ts`).
- **K-18:** pass `before.market_positions` to `soldOutRises` at `App.tsx:7112-7117`. This line sits inside the apply half; it is narration-only, but flag it for the owner.
- **K-20:** a presidency-change sentence.
- **K-22:** the float line, per OD-8.
- **RR-4:** copy only if the ruling is "any legal purchase".

### W2-K — Money copy conventions (U-44, U-15) · 2–3 h
- **Gate:** OD-9.
- **U-44:** one time helper replaces the three `hhmm` copies; the server copy needs editing if the owner picks local time with a zone.
- **U-15:** the logo asset.

---

## 4. THIRD WAVE — remaining Phase 3 stabilization

- **W3-A — Notices and focus (one-shot persistence, NEW-1 fleet-loss over-fire, forced-notice focus target, tutorial auto-reset) · 4–5 h**
  - Gate: OD-5.
  - Fix the fleet-loss over-fire on the **prune** side (`11295-11405`), not the enqueue loops, which are in the apply half.
  - Remove the auto-reset at `1079-1084`.
- **W3-B — Latch residue · 3–4 h.** Covers whatever no earlier slice latched: `BuyLicenseModal`, `HomeStationPrompt` if W2-H left it, `PrivatePowerFlowModal`. Call sites and props only; no change to the submit half.
- **W3-C — Refusal display model · 3–5 h.**
  - Separate connection and refusal slots in the strip (NEW-4 overwrite).
  - Clear any server refusal once a later submission lands (NEW-2 sticky).
  - This touches 2–3 lines of the submit half (`6425-6427`) and the link callbacks (`12567-12640`), which are R1/R3. **Needs the owner's explicit permission, or it moves to Phase 4.**
- **W3-D — Accessibility minimum · 1–2 h.** Replace the remaining `aria-modal` divs with `inert` / `NativeModal` after W2-H; keyboard reach for the dock controls.
- **W3-E — Optional: city bypass control (K-06/U-17) · 5–8 h.** Only if OD-11 says build.
- **W3-F — Phase 3 closure · 3–4 h.** Reconcile against the Phase 3 audit's IDs; update backlog Part C; refresh the Phase 4 playtest checklist rows that changed (A-3, A-5, S-3, S-4, S-11, O-1, O-8, O-9, O-12); tag the playtest baseline.

---

## 5. OWNER DECISIONS REQUIRED BEFORE IMPLEMENTATION

| ID | The concrete choice | What exists now | What depends on it | Needs playtest first? |
|---|---|---|---|---|
| **OD-0** | The Phase 3 base SHA: the `recon`/`cost` line (`083d066`, v12) or `main` (`e1f1280`). Is there unpushed frontend work in the real checkout? | `main` is 69 frontend files behind | Every slice | No |
| **OD-1** | **The waiting model.** While a hold stands or another seat must act: (a) every control greyed with the hold's sentence, board and tabs usable; or (b) the bar replaced by one "Waiting on X" strip. For HomeStation/Auction prompts, non-actors get a banner or a read-only modal card. | Full-screen scrims for everyone; the OR bar ignores holds; four prompts each print their own waiting sentence | W2-A, W2-F, W2-H, W2-D, W3-B | No (it can be re-tuned after Phase 4) |
| **OD-2** | Stock Round turn controls: keep a labelled stage Pass ("Done selling") or one End Turn that sends two `PassTurn`s. Making Pass always end the turn would be a rules change (v13). | Two Passes to end a no-buy turn; stage buttons only switch tabs | W2-B; any v13 batch | UI choice: no. Rules representation: can wait |
| **OD-3** | M&H queued request: toast plus a persistent table marker plus "requested" / "executed" log lines; on cancellation, a generic "expired", or authorize engine work to carry the reason | Narrated as executed; no reader of `pending_mh_exchange` | W2-E, RR-6 | No |
| **OD-4** | Emergency modal: Back/close while a decision remains? Non-presidents see a read-only liquidation, or nothing? | Cannot close once opened; every seat sees "Declare bankruptcy" | W2-G | No |
| **OD-5** | Notices: persist one-shot notices per tab, or derive them from state for late joiners; the focus target for forced notices; remove the tutorial auto-reset | PhaseThree / PrivateRevenue / Herald lost on reload; FleetLoss replays history in a fresh tab; tutorials re-arm on every mount | W3-A | No; could be informed by Phase 4 |
| **OD-6** | Show the game id (against LIVE-2 §7.2's "never displayed")? Where do the build id and rules version appear? Rules Reference copy at GameEnd? | Game id hidden; build note stale; version shown only in error text | W2-I | No |
| **OD-7** | RR-4: when the treasury can pay a forced purchase, must it be the cheapest train? "Yes" is a rules defect (v13); "No" is a copy fix | Engine allows any legal purchase; Reference says "cheapest" (4 sites) | W2-J; the rules batch | No (a rulebook reading) |
| **OD-8** | U-37 float narration: (a) "floated" at the float plus "placed its home" later, or (b) one line at placement. U-40: the Rules Reference authority sentence | One line at placement | W2-J | No |
| **OD-9** | U-44 time convention (local with zone, which needs a server copy edit, or UTC); U-15 Keplr logo asset and brand approval | Local "HH:MM" unlabelled vs the server's "UTC" | W2-K | No |
| **OD-10** | Scope: (a) is any rules-version bump (v13) allowed in Phase 3, or are all rule items deferred to one post-Phase-4 batch? (b) Are phone-width layout and keyboard map access Phase 3/4 targets? | v12 on this tree; no breakpoints in the game shell; the map is mouse-only | The rules batch; W3-D | (a) No. (b) No |
| **OD-11** | K-06 city bypass: build in Phase 3, or defer? If built: which hexes, which gesture, and how does it interact with the shortfall refusal? | No control; the authority accepts `bypass:true` | W3-E | Partly (how often it matters) |

**Defaults the slices assume unless the owner objects:**
- the K-16 tooltip wording;
- station refusals shown via `showActionToast`;
- U-16 probe removed;
- the K-24 float-placeholder residue left to Phase 5;
- U-8 closed.

---

## 6. SERIAL BOTTLENECKS

1. **The bar mount and `passDisabledReason`.** P0's hoist goes first. Then W2-A, the only slice that crosses every prop group, lands alone before W2-B and W2-D.
2. **OD-1** gates four slices: W2-A, W2-F, W2-H and W2-D.
3. **The consent block and the two prompt components** belong to lane 3 alone: W1-D → W2-F, with W2-C after W2-A.
4. **Single-owner files:** `EmergencyTrainPurchaseModal.tsx` (W2-G), `HomeStationPrompt.tsx` (W1-J → W2-H), `actionLog.ts` (W2-E → W2-J), and the `tileLayDisabledReason` lines (W1-E → W2-A).
5. **Multi-region test suites collide in the test files**, not in App.tsx: `phase65bShellWiring` (10 regions), `doubleActionWindow`, `batch49`, `batch57`, `actionReceipt`. One integrator lands branches in sequence and rebases each.
6. **The owner's broad gate**, once per wave.
7. **One writer in the real checkout.** Branches live in isolated clones.

## 7. SAFE PARALLEL LANES

| Lane | Sequence | Shares with |
|---|---|---|
| **1 · Stock Round & auction** | W1-A ∥ W1-B → W2-B | The S1 const (one line each) |
| **2 · Private powers / M&H** | W1-C → W2-D → W2-E | `actionLog.ts` (hands over to lane 6) |
| **3 · Offers, consent & holds** | W1-D → W2-A → W2-C → W2-F | Bar props (owner of the hold group) |
| **4 · Map, tile, token, routes** | W1-E ∥ W1-F ∥ W1-G → (W3-E) | `tileLayDisabledReason` (hands over to lane 3) |
| **5 · Shell, status, notices, modals** | W1-I, W1-J → W2-G, W2-H, W2-I → W3-A, W3-D | `HomeStationPrompt` |
| **6 · App-free** | W1-H, W1-K, W1-L → W2-K, W2-J → W3-C | `actionLog.ts` (after lane 2) |

## 8. APP.TSX COLLISION RISKS

- **Inevitably touch App.tsx:** W1-A, W1-B (3 lines), W1-C, W1-D, W1-E, W1-F, W1-G, W1-J, W2-A, W2-B, W2-C, W2-D, W2-F, W2-G, W2-H, W2-I, W2-J (K-18 is in the apply half), W3-A, W3-B, W3-C (submit half / drain: RED).
- **App-free:** W1-H, W1-K, W1-L, W2-K; most of W1-I and W2-E.
- **Seams:**
  - **S1** (hoist `passDisabledReason` to a plain const): recommended, behaviour-neutral, moves one pin.
  - **S3 / S4** conventions: imports beside related imports; props inside their own group (tested: appends at the same tail conflict; insertions one or more lines apart merge cleanly).
  - New logic goes into pure `utils/*View.ts` helpers with one App call site (the established 6.5-B pattern).
- **No safe seam:**
  - the hex chooser (`stationVeil` pins its exact indentation);
  - `purchaseBlockFor` / `saleBlockFor` (W1-A rewrites them anyway);
  - the rings;
  - the RED regions.
  - An optional S2 (consent slot into `src/shell/`) is **not recommended**: it only relocates the collision and sets a Phase 5 precedent.
- **Characterization harness:** `AppShell` is not exported, so Phase 3 regressions are component- and helper-level plus source pins.

## 9. PHASE-4 DEFERRALS

- **Shell-local OR facts** (SI-ledger invariants, RED R5): `routesRunThisTurn`, `mustBuyTrain`, the D&H optimistic ability set and `dhStationForfeited` (DH-1, DH-3), the client auto-skip verdicts vs `nextDerivedAction`. Observe them in playtest; change them in Phase 5.
- **Refused-action rollbacks:** the ability/JK spend on a refused lay; `ran:true` and `setLiveOrSubPhase` after a refused run. Both need a per-action refusal signal.
- **The `press:true` latch** for the `automatic` presses (OpenStockRound, M&H exchange, Undo, PlaceHomeStation, SetBoPar) and **I-1**'s queued-submission state. These edit the submit half, and `doubleActionWindow` pins its exact text.
- **LOW-4** (the rules revision in the lay preview).
- **One v13 rules batch, if OD-10(a) allows it:** SBS-2, SBS-3, SBS-4 (OD-A-4), DH-1 authority, GR-1, ING-1, RR-4 if ruled a defect, OD-A-3 (D10/E5).
- **Later phases:**
  - phone-width layout and keyboard map access → Phase 5;
  - the K-24 float placeholder → Phase 5;
  - statistics U-41 / U-43 → their own pass;
  - U-7 card wash, money-panel styling, U-4 polish, the flourish backlog;
  - R4 (a dropped form), I-2 / I-3 cosmetics;
  - instrumentation I-1…I-7, only if Phase 4 asks for them.
- **First to cut if Phase 3 runs long:** W3-A (persistence), W3-C, W3-E.

## 10. REVISED PHASE-3 ACTIVE-WORK ESTIMATE

| Block | Claude hours |
|---|---|
| Wave 0 | 1.5–2 |
| Wave 1 (12 slices) | 46–56 |
| Wave 2 (11 slices) | 39–51 |
| Wave 3 (excluding the optional W3-E) | 14–20 |
| Integration, rebases, pin repair (~30 merges) | 10–15 |
| Diagnosing owner-gate failures | 4–8 |
| **Total** | **≈115–150 h** (+5–8 h if W3-E is built) |

- **Owner:** ≈2–3 h of decisions plus ≈6–9 h of broad gates and review.
- **Elapsed:** with 6 lanes, about 30–40 h of engineering time, bounded by the integrator and three owner gates rather than by the lanes.

## 11. MAXIMUM USEFUL CONCURRENT ENGINEERING LANES

**6, plus one integrator.**
- The six lanes in §7 are disjoint by file or region once P0 lands.
- A seventh lane has nothing disjoint left to own. Splitting lanes 3 or 4 would put two writers on the bar's prop groups, the consent block or the ring region.
- Above six, the binding constraints are the single integrator's serial rebases across the shared pin suites, and the owner's broad gate. Extra lanes add rebase churn without shortening the critical path: P0 → W1-D → W2-A → W2-C → W2-F, about 25–30 h.

*Source changes: NONE.*