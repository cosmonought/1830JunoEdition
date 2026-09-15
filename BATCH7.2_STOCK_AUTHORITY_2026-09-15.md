# Batch 7.2 — authoritative Stock Round buy/sell/par legality

Date: 2026-09-15. Baseline: Batch 7.1 committed (`08a59ec73980e3fec6f84f0ce1ac29f2cf4d3359`) plus the docs-only
commit `50c735c` that added `BATCH7_TRANSACTION_AUTHORITY_DESIGN_2026-09-15.md`. `RULES_ENGINE_VERSION` **4 —
deliberately not bumped** (the 4 → 5 bump belongs to Batch 7.5 after all Stage-7 semantics land).
Design: `BATCH7_TRANSACTION_AUTHORITY_DESIGN_2026-09-15.md` §7.2 / §7.3, owner rulings D-9/Q10, D-17/Q4,
D-22/Q9, D-25/Q13, and Q2 (S8-7 / S8-8's sale half / S8-9 absorbed here).

**Reviewed and approved by the owner, 2026-09-15**, with one ruling — **D-28**, §14(a) below: the forced
(§6.6.3) sale's refusal stays visible at ingress. Three narrow consistency checks were run against that ruling
and are recorded in §14(a); no architecture and no broad tests were added.
**The full Jest suite was not run. No golden, replay or pinned expectation was re-pinned.
`RULES_ENGINE_VERSION` is still 4. No frontend file was changed. Every unrelated owner working-tree change is
untouched.**

> **Bottom line.** Stock legality is one module now: `gameEngine/stockTransactionAuthority.ts`, asked by the
> reducer's core (by identity, ahead of every stage), at ingress (with the sentence), and — for the sale —
> inside the market step's `saleRefused` closure, so a refused sale moves no market token. The price of a
> share is a fact about the board: the corporation's stored par for an IPO share, `market_positions` for a
> pool share, and a ladder-validated message par for the one purchase that sets a par. A forged `par_value`
> cannot change what a buyer pays; an unparred corporation is never silently parred at $67; an empty source
> is refused outright instead of charged for nothing; and nothing is bought or sold outside a Stock Round
> except the §6.6.3 forced sale. **Two new suites, 57 tests, all passing; 50 focused suites, 884 tests, all
> passing.** The corpus cost is remarkably small: **only three files diverge from the 7.1 baseline, all for
> the one rule** — a `BuyStock` sent during an Operating Round (JUNO-FCJ 83, JUNO-3XD 140, and the FCJ
> prefix-96 fixture at 83). Every other room, including all three goldens, is gameplay-identical.

---

## 1. Files changed

| File | What |
|---|---|
| **`frontend/src/gameEngine/stockTransactionAuthority.ts`** (new, 570 lines) | The authority: `stockPurchaseRefusal`, `stockSaleRefusal`, `priceStockPurchase`, `parLadderRefusal`, `isPresidentPurchase`, `isFirstStockRound`, `ordinaryPercentAvailable`, `chartContextFromState`. Design note #1570. |
| `frontend/src/gameEngine/sandboxSession.ts` | Core gates for `BuyStock` / `SellStock` / `SetBoPar` (identity, after the holds); the `BuyStock` arm re-priced from `priceStockPurchase` and writing `bought_this_turn_company`; the market step's `saleRefused` closure switched to `stockSaleRefusal`; `stockChartContext` bridge; the three seat sites clear the new field; `SandboxActionContext.parValue` annotated inert. |
| `frontend/src/gameEngine/turnAuthority.ts` | Ingress reasons for `BuyStock` / `SellStock` (after the seat rule) and `SetBoPar` (after the owner rule), each inside a `withRules` scope. |
| `frontend/src/gameEngine/gameState.ts` | `bought_this_turn_company?: number`, with its note. |
| `frontend/src/gameEngine/index.ts` | The authority exported on the engine's surface, as the ledger is. |
| **`frontend/src/utils/stockTransactionAuthority.test.ts`** (new) | **35 tests** — every rule at its boundary, the required hostile-client matrix, an acceptance control beside each refusal, and the D-28 consistency case (§14a). |
| **`frontend/src/utils/stockRefusalAtomicity.test.ts`** (new) | **22 tests** — whole-state field digests on 16 refusals, and the market token pinned on every refused sale. |
| `frontend/src/utils/refusalAtomicity.test.ts` (7.1's) | Two expectations updated for deliberate 7.2 effects — §10(a). |
| `frontend/src/utils/bankBreakLatch.test.ts` (7.1's) | Its "$100 receipt" helper buys its share where a share may be bought — §10(b). |
| `frontend/src/utils/messageSchema.test.ts`, `frontend/src/utils/emergencyFunding.test.ts` | One expectation each, both deliberate — §10(c), §10(d). |
| `RULES_HARDENING_BACKLOG.md` | S7-13 / S7-16 / S7-18 / S8-7 / S8-9 → `RESOLVED`; S8-8's sale half resolved; S7-17 annotated; U-23 / U-24 / U-25 / U-29 given their Batch 7.2 outcome; **U-30 and U-31 filed**; **D-28 filed** (the owner's forced-sale visibility ruling); two Part E rows added (7.1's and 7.2's). |
| **`BATCH7.2_STOCK_AUTHORITY_2026-09-15.md`** (new) | This report. |

**Untouched, and not read:** `frontend/src/App.tsx`, `components/StockRoundPanel.tsx`,
`components/RulesReference.tsx`, `utils/audio.ts`, `utils/privateCatalog.ts`, and the owner's in-flight
`privateOfferRow` / `privateCardText` / `powerRefusalAndChips` / `rules*.test.tsx` / `stockTransferFocus` /
`stockCardFocus` / `utils/stockTransaction*` files. The working tree grew further owner work *during* this
batch; none of it was read or modified, and the focused validation in §11 ran against the tree as it stood.

---

## 2. The authoritative predicates introduced

`frontend/src/gameEngine/stockTransactionAuthority.ts`. Every function is pure and returns a value; nothing
throws. The reducer remains canonical law — ingress answers with a reason and owns no rule.

```ts
// The chart facts a stock rule needs. EVERY FIELD OPTIONAL; absent means "no opinion" (#757/#232).
interface StockChartContext {
  marketZoneFor?:        (companyId: number) => PriceZone;   // absent => the zone rules are NOT asked (#712)
  marketPricesByCompany?: Record<number, number | null> | null;
  zoneForPrice?:         (price: number | null | undefined) => string | null;
  parCellFor?:           (parPrice: number) => { x: number; y: number } | null;  // default: parBoxCellFor
  priceFor?:             (companyId: number) => number | null;   // read off market_positions (#1196)
  pinnedBoard?:          boolean;   // #1520's pin: what a MISSING market position means
  nominalPrice?:         number;    // the legacy board's last resort only
}
chartContextFromState(state): StockChartContext

// Which purchase this is -- decided by the CORPORATION, never by the message.
isPresidentPurchase(company, source): boolean        // Ipo && president === null && par_value == null
ordinaryPercentAvailable(company, source): number    // less the reserved President's 20% and the LPF double
isLegalPar(par, ctx): boolean
messagePar(parValue): number | null                  // "", null, undefined are the same absence
parLadderRefusal(parValue, ctx?, what?): string | null

// What it costs. One function, asked by the predicate AND by the arm, so they cannot be handed two figures.
priceStockPurchase(state, buy, ctx?):
  | { ok: true;  plan: { kind: "president" | "double" | "ordinary";
                         certificates; percentage; price; charged; par } }
  | { ok: false; reason: string }

// Whether it may happen.
stockPurchaseRefusal({ state, buy, actor, ctx }): string | null
stockSaleRefusal({ state, sell, actor, mapGrid, ctx }): string | null
isFirstStockRound(state): boolean
purchaseIntentOf(msg.BuyStock): StockPurchaseIntent
```

### 2a. `stockPurchaseRefusal`, in order (design §7.2)

1. **Round.** `current_round_type === "StockRound"`, with a distinct sentence for the auction.
2. **The corporation**, and the LPF double's placement (`doublePurchaseRefusal`, unchanged).
3. **The President's Certificate** — when and only when the *corporation* has no president and no par and the
   source is the IPO: the message must carry a par; it must be whole; it must be a par cell of the chart in
   effect; the 20 % card must be in the IPO; `quantity === 1`; not the double.
4. **The price.** Ordinary IPO = the corporation's stored `par_value`; pool = `market_positions[id].price`;
   president = 2 × the validated par. A message `par_value` is ignored everywhere but (3).
5. **Availability.** `ordinaryPercentAvailable(company, source) >= percentage` — refused outright, never
   capped, never charged less, never charged for nothing.
6. **`sharePurchaseBlock`**, composed and *not* forked: the 60 % cap and its Orange/Brown waivers, the
   certificate limit and its zone exemptions, the divestment debt, the sold-this-round lockout, one purchase
   per turn and its Brown allowance, the double's placement.
7. **The Brown continuation** names `bought_this_turn_company`.
8. **Affordability.** `playerCashOf(actor) >= plan.charged`.

### 2b. `stockSaleRefusal`, in order

1. **Round.** `StockRound`, **or** an Operating Round in which `emergencyFundingFor(state, mapGrid)` names
   this actor as the obligated president (Batch 5's §6.6.3 path, preserved exactly).
2. **The bundle** is a positive whole multiple of 10.
3. **Not the first Stock Round** (`isFirstStockRound`), unless forced.
4. **The corporation has a par** (S8-8 / S11, p.15).
5. **The price is on the chart** — on a *pinned* board a corporation with no `market_positions` entry cannot
   be sold; a legacy board keeps the nominal it was played on (D-9).
6. **`shareSaleBlock`** + `doubleSaleEffect` + (when forced) `forcedSaleRefusal` — all composed, none forked.

**Seat authority is not here**, deliberately (ruling Q10 / D-9): the reducer adds round and action legality,
never historical seat authority. JUNO-3XD's SR1 was seated under the pre-#1235 constant, so a reducer seat
check would refuse a whole round of a development-corpus log for no rules reason.

---

## 3. Ingress / core / market-step wiring

| Layer | Where | What it does | Why there |
|---|---|---|---|
| **Market step** | `applySandboxActionAfterAuction`'s `saleRefused` closure (`sandboxSession.ts`) | `stockSaleRefusal(...) !== null` ⇒ the chart atom returns `unchanged` | #748a: the chart advances BEFORE the board, so a sale the core will decline must be declined by the SAME predicate here or the token drops for a sale that never happened. It was `shareSaleBlock` + the Batch-5 forced rules; it is now the predicate that CONTAINS both and adds the round gate, SR1, the unparred corporation and the bundle shape. |
| **Core (canonical law)** | `applySandboxActionCore`, immediately after the home-token hold | `BuyStock` / `SellStock` / `SetBoPar` refused **by identity** | #1019: a refusal inside the arm still lets `settleRoundTransitions` / `settleEra` / `settleOperatingCursor` run, so the board comes back a new object. Placed AFTER the discard, funding and home-token holds so the reason a player is told is the one that explains why nothing works. |
| **Arm** | the `BuyStock` arm | re-asks `priceStockPurchase` for the plan it charges and moves | #273: the wallet and the chart must never be handed two different figures. The gate has already refused everything, so the arm's `if (!pricing.ok) return state` is unreachable in the pipeline and load-bearing for any other caller. |
| **Ingress (reason)** | `turnRefusal`, after the seat rule for `BuyStock`/`SellStock`, after `roomMessageRefusal` for `SetBoPar` | the same predicates, wrapped in `withRules(resolveVariants(state.variants), …)` | S10-1 / U-29: a reducer no-op is indistinguishable on screen from a dropped message. The `withRules` scope is not decoration — `RoomSession.submit` calls `turnRefusal` outside any scope, so a par ladder or price zone read there would otherwise be read off whichever table was last activated. |

**This market-step/core interaction is the one part of 7.2 that needed care, and it is pinned rather than
argued:** `stockRefusalAtomicity.test.ts` asserts, for six different refused sales, that
`state.market_positions[PRR]` is `toEqual`-identical to where it began — cell, price and arrival ordinal —
with a control in which a legal sale of two certificates does move the token two rows down.

---

## 4. President / par behaviour

| Fact | Before | After |
|---|---|---|
| Which purchase is the president's | `source !== "Bank" && president === null && par_value == null` — and then the par came off the message unvalidated | the same three facts, read from the **corporation**, in `isPresidentPurchase`; the message supplies only the par |
| Missing `par_value` on an unparred IPO buy | silently became the president's purchase at **$67** (m8) | **refused** — "NYC cannot be started without a par value — choose one of $67, $71, $76, $82, $90, $100." |
| Off-ladder par (`85`, `999`, `1`, `0`, `-67`, `90.5`, `"abc"`) | accepted; the corporation was parred there and capitalised 10 × it | **refused** by `parLadderRefusal`, which reads `parBoxCellFor` — the same table the renderer frames the ladder from, so the frame, the mark and the price cannot disagree |
| The 20 % card | not checked | `ipo_pool_percentage >= 20`, or refused |
| `quantity` / `certificate` | ignored | must be 1, and never the LPF double |
| Cash | not checked | `cash >= 2 × par`, exactly; $199 against a $100 par is refused |
| The charge | 2 × the **message's** par | 2 × the **validated** par, through the 7.1 ledger |
| What settlement records | `par_value ?? String(parFromMessage ?? ctx.parValue ?? price)` | `String(par)` — the validated figure, written with the presidency as before (#399) |

`$67` no longer appears as a fallback anywhere on this path. `SANDBOX_NOMINAL_SHARE_PRICE` survives only as
the legacy board's pool price (§5) and in the market atom's own `priceOf`, which a pinned board can no longer
reach for a stock trade.

---

## 5. Ordinary IPO and Bank Pool pricing

- **IPO, after par:** `Number(corporation.par_value)`. A payload saying `par_value: "1"`, `"999"`, or nothing
  at all buys the same share for the same money — pinned three ways in one test.
- **Bank Pool:** `market_positions[companyId].price`. A Brown-zone $30 share costs $30 even when the payload
  names another corporation's par.
- **A corporation with a president and no par** cannot price an IPO purchase at all and is refused, rather
  than being converted into a presidency grab.
- **No nominal fallback on a pinned board.** A pool trade of a corporation with no market position is refused
  on a board carrying `rules_engine_version`; on a legacy board the reducer's nominal stands (D-9), because
  the development corpus and the hand-built fixtures predate the invariant that every parred corporation has a
  mark (#688). Both sides are tested. In ordinary play the case is unreachable — an unparred corporation is
  refused one rule earlier, and a parred one always has a mark.

---

## 6. Source availability and affordability

**Availability (m9, ruled Q13 / D-25).** `ordinaryPercentAvailable` subtracts the two cards that are not
ordinary stock: the 20 % President's Certificate while it sits unsold in the IPO (#448), and the LPF double
where it is (#1324) — the same two subtractions `certificateCardsInPool` makes for the display, in the unit
the purchase is expressed in. A request the source cannot fill is **refused**, not capped:

| Case | Result |
|---|---|
| IPO at 0 % | refused; cash unchanged, no certificate delivered — the exact shape of m9 |
| Bank Pool at 0 % | refused |
| `quantity: 5` against a 40 % pool | refused ("The Bank Pool holds 40 % of NYNH — not the 50 % asked for") |
| `quantity: 4` against a 40 % pool | **allowed**, charged 4 × $30 = $120, pool → 0 % (the control) |

**Affordability (audit C3), at the dollar:**

| Boundary | Legal | Refused |
|---|---|---|
| ordinary share, $100 | cash $100 → cash $0 | cash $99 |
| President's Certificate, par $100 | cash $200 → cash $0, IPO 100 → 80 % | cash $199 |
| Brown multi-certificate, 4 × $30 | cash $120 → cash $0 | cash $119 |

7.1's ledger is still the last line underneath all of this; 7.2 puts the rule, and its ingress sentence, in
front of it. A later batch that adds a predicate must not remove the boundary.

---

## 7. The Brown continuation

New optional state `bought_this_turn_company?: number` (`gameState.ts`):

- written by the **first** purchase of the turn (`state.bought_this_turn_company ?? protocol_id`, so a
  continuation does not rewrite it);
- cleared by all three sites that clear `bought_this_turn` — `advanceSeat`, `recordPass`,
  `openingStockRoundReset` — and named in the latter's `Pick<>` return type so a fourth site cannot forget it;
- read by `stockPurchaseRefusal` rule 7: a second purchase in one turn must name that corporation.

The multi-message representation is preserved unchanged for replay (ruling Q9 / D-22): `sharePurchaseBlock`
still waives one-purchase-per-turn for Brown Bank-Pool shares, and the continuation still counts as the same
purchase for turn purposes. **Orange gets nothing:** `allowsExtraPoolBuys` is untouched, so a second Orange
purchase meets "One certificate purchase per turn" exactly as before — tested, including the quantity form.

**Absent is "not said" (#232).** A board rebuilt mid-turn from a log written before the field existed carries
no continuation rule, so no legacy replay is refused by it — tested.

---

## 8. Sale behaviour: round, SR1, unparred, forced

| Rule | Refusal | Control |
|---|---|---|
| Sales are Stock Round actions | an ordinary `SellStock` in an OR is refused at both locks | — |
| The §6.6.3 forced sale | — | on a Batch-5 board (C&O trainless at Buy Trains, a legal corridor route, $30 treasury, a $20 president) `emergencyFundingFor` names P1, `stockSaleRefusal` returns `null`, and the sale pays him $100. A different player's sale on the SAME board is refused — the exception is the obligation's, not the round's |
| No sales in the first Stock Round (§5.1) | `macro_round_number === 1` in a Stock Round | SR2 sells |
| …and the Delayed Auction | its SR1 is the first Stock Round and refuses | its post-auction **SR3** is macro round 3 and sells. One reading, both boards — the frozen design's, not a new interpretation |
| Whole bundles only | 15 %, 5 %, 0 %, −10 %, 12.5 % all refuse | 10 % and 20 % sell |
| Unparred corporation (S8-8 / C&A / M&H) | a granted share of an unparred corporation refuses — one rule, no variant-specific duplicate | the same share sells once the corporation is parred |
| Existing machinery | `shareSaleBlock` (holding, pool cap, presidency successor), `doubleSaleEffect`, `forcedSaleRefusal` | composed, not forked — each still refuses, and each refused sale moves no token |

M&H **exchange** mechanics are untouched and remain Stage 8's (S8-10).

---

## 9. `SetBoPar`

`parLadderRefusal` is asked in `applySandboxActionCore` (identity) and at ingress after `roomMessageRefusal`'s
owner check. `boPresidencyRefusal`'s preconditions — the corporation exists, has no president, and holds the
20 % in its IPO — are unchanged and still asked by the arm. **No money moves**: the B&O private grants the
certificate free (rulebook p.27), and the test asserts both the player's cash and the bank are byte-identical
across a successful grant, with money conservation checked. Off-ladder and malformed pars (`85`, `1`, `999`,
`0`, `""`, `"abc"`, `90.5`) refuse with no presidency and no par written.

---

## 10. Refusal atomicity — the evidence

`utils/stockRefusalAtomicity.test.ts` (22 tests) compares **`fieldDigests` across the whole state** and
asserts the exact list of top-level fields that differ, so an arm that later writes something new before its
gate fails this file rather than passing it. Ten refused purchases and six refused sales each assert
**`[]` — literal whole-state equality** (`expect(after).toEqual(before)`), plus a hand-read list of the
transaction facts (cash, bank, `bank_broken`, both corporations, `bought_this_turn`,
`bought_this_turn_company`, `turn_action_taken`, `stock_turn_stage`, `last_trader_index`,
`active_player_index`, `priority_deal_index`, `consecutive_passes`, `sold_this_round`, `market_positions`) and
`moneyConservationBreach === null`.

Covered refusals: OR purchase, auction purchase, unaffordable ordinary, unaffordable president, off-ladder
par, omitted par, empty IPO, empty Bank Pool, unfillable multi-certificate request, wrong-corporation Brown
continuation; OR sale, SR1 sale, fractional bundle, over-holding bundle, full Bank Pool, unsuccedable
presidency; and `SetBoPar` off the ladder.

**The president's certificate is checked field by field as well**: on refusal `president` is still `null`,
`par_value` still `null`, `is_floated` still `false`, `treasury` still `"0"` (**no 10 × par capitalisation**)
and the IPO still 100 %.

**The market token, specifically.** Every refused sale asserts `state.market_positions[PRR]` `toEqual` its
starting mark — and the suite injects the **real** `projectShareSaleMove`, not a stub, with a control in
which a legal 20 % sale pays $200 at the pre-drop price and drops the token two rows. Without the real
projection the refusals would prove nothing. A **seventh** refused sale is pinned the same way in
`stockTransactionAuthority.test.ts` — the illegal §6.6.3 forced sale of §14(a), which is the one refusal that
happens in an Operating Round and therefore exercises the closure on the other side of the round gate.

### Normalisation accounted for explicitly

- **`settleEra` / `settleOperatingCursor` (#1303 / #656).** The primary boards carry `current_global_era` up
  front, so the assertions are `[]` rather than a named field. 7.1 §9a already proved these are the
  pipeline's and not the transaction's; this batch does not re-prove it.
- **`reconcileParMarks` (#688).** Two cases would otherwise trip over it and both are handled rather than
  ignored: the no-market-position case uses an **unparred** corporation, for which nothing is placed; and the
  successful `SetBoPar` control expects `["market_positions", "public_companies"]` and says why — a token is
  placed in the new par box, which is the settle chain's invariant and not a charge.
- **Stronger than 7.1.** Because 7.2 asks its predicates ahead of every stage, a refused purchase no longer
  reaches the settle chain at all: the stale-board case in `refusalAtomicity.test.ts` now asserts
  `after === before` by identity where 7.1 could only name the one normalised field. That is the change
  described in §12(a) below, and it is a strengthening, not a re-pin.

---

## 11. Validation

**Only focused suites were run. The full Jest suite was not run.**

### 11a. New suites — 57 tests, 57 passed

| Suite | Tests |
|---|---|
| `utils/stockTransactionAuthority.test.ts` | **35** passed (34 + the D-28 consistency case) |
| `utils/stockRefusalAtomicity.test.ts` | **22** passed |

### 11b. Existing suites — 50 suites, 883 tests, all passing

`stockTransactionAuthority`, `stockRefusalAtomicity`, `refusalAtomicity`, `bankBreakLatch`, `cashLedger`,
`moneyConservation`, `messageSchema`, `turnAuthority`, `emergencyFunding`, `emergencyTrainFlow` (10 suites,
261 tests) — plus `sellBuySell`, `sellIsNotAPass`, `sellThenBuyLock`, `presidentPurchase`,
`presidentCertificateSale`, `parFromMessage`, `parMarkArrival`, `parMarkReconcile`, `parPrice`,
`sharePurchase`, `shareSale`, `floatHoldsSeat`, `floatThreshold`, `soldOutRise`, `auctionSeating`,
`auctionCashMovement`, `levelPlayingFieldRules`, `trainDiscard`, `batch60`, `batch45`, `logRevert`,
`logExport`, `replayAttribution`, `replayEquivalence`, `operatingCursorReplay`, `replayJunoCV4`,
`serverProtocol`, `derivedActions`, `refusedAction`, `actionReceipt`, `shellNarration`, `doubleActionWindow`,
`homeTokenGate`, `operatingIdentity`, `forcedDivestment`, `certLimitAgreement`, `atomicReducer`,
`closeRoomPayout`, `stockTransaction` (40 suites, 622 tests). Also run and passing earlier in the batch:
`batch51`, `bonusLayStep`, `gridProvenance`, `roomSession`, `stateDigest`, `divergenceWatch`, `oneSandbox`,
`logHash`, `logCondense`, `miniAuctionTurn`, `privateExchange`, `autoBuy`, `autoPass`, `boFloatRule`,
`holdingCapBadge`.

### 11c. Failing — all six pre-existing, all Batch 7.1's, and **verified** so

The same four suites / six cases 7.1 §8b reported, left stale for Batch 7.5 as instructed. **Verified rather
than assumed**: the Batch-7.1 baseline tree (`git archive 50c735c`, the corpus files copied in) was run
through the same suites and fails identically.

| Suite | Case | Cause (7.1's, not 7.2's) |
|---|---|---|
| `utils/replayGolden.test.ts` | `JUNO-CV4.log.jsonl` | `virtual_bank_vgp` `8516 → 9511` — 7.1's auction + terrain credit |
| `utils/replayGolden.test.ts` | `JUNO-G6J.log.jsonl` | `virtual_bank_vgp` `9550 → 10300` — same |
| `utils/replayJuno3XD.test.ts` | "agrees … which turn each run belonged to" | 3XD diverges from idx 28 under 7.1 |
| `utils/replayJuno3XD.test.ts` | "prints filed run against declared amount" | same divergence |
| `utils/gameHistory.test.ts` | "samples once per round boundary…" | Z6C diverges from idx 193 under 7.1 |
| `utils/roundReplay.test.ts` | "replays to a board still labelled with that round…" | same Z6C divergence |

### 11d. Typecheck, build, lint, static searches

| Check | Result |
|---|---|
| `npx tsc --noEmit -p frontend/tsconfig.json` | **clean for this batch's files.** It was clean outright for most of the batch; at commit time it reports four errors, **all of them in the owner's in-flight work that appeared during this session** — `components/StockRoundPanel.tsx` 908 (`presidentDuringStage` not yet exported), `components/stockTransferFocus.test.ts` and `components/stockCardFocus.test.tsx` (a `StockTransaction` type mid-widening). None of the four is in a file this batch touched, and none is in the commit |
| `node …/tsc -p server/tsconfig.json --noEmit` (the whole engine, and no `components/` test files) | **clean** — the check that isolates this batch's surface from the owner's in-flight shell work |
| `node …/tsc -p server/tsconfig.json --outDir …` (emits the whole engine + server to CommonJS) | **clean** — this is the build the corpus sweep in §12 ran on |
| `react-app-rewired build` (production webpack, `GENERATE_SOURCEMAP=false`, ESLint plugin off) | **succeeds** — 1.12 MB gzipped `main.*.js` (7.1 measured 1.11 MB). Built with `BUILD_PATH` outside the repository because this session's filesystem bridge cannot unlink, and CRA empties its output directory first; **`frontend/build/` is therefore untouched by this batch** and still holds whatever 7.1's interrupted build left there (gitignored; `npm run build` restores it) |
| `npx eslint` on every file this batch touched | **identical to the baseline**: 1 error + 3 warnings, all in `sandboxSession.ts`, all pre-existing (`import/first` at the #1530 mid-file re-export, and three unused-symbol warnings). The same command on the 7.1 baseline tree prints the same four. A fourth warning appeared mid-batch (`DOUBLE_CERTIFICATE_PERCENT`, whose last reader the re-priced arm removed) and was cleared by narrowing the import. **The three new files are clean** |
| static search: `parFromMessage` | **gone** from the engine |
| static search: `ctx?.parValue` readers | **none** — annotated inert, filed as U-31 |
| static search: `sharePurchaseBlock(` / `shareSaleBlock(` call sites | 6 and 7; the authority **composes** both, and no second implementation was added. Two of them (`utils/refusedAction.ts` 209 / 223) are now stale and are filed as **U-30** |
| static search: `bought_this_turn` clear sites vs `bought_this_turn_company` | all three sites clear both |

---

## 12. Corpus divergence — 7.2 only, measured against the 7.1 baseline

**Method.** The Batch-7.1 tree (`50c735c`) and this tree were each compiled with `server/tsconfig.json` and
every corpus file replayed through both, capturing `stateDigest`, `fieldDigests`, `moneyTotal` and the bank
before every applied entry (the observer runs after the grid and chart move and before the arm — #1191) and
at the end. Eighteen files: eight `server/data` logs, five `frontend/sandbox-log-*` exports, three golden
copies and the FCJ prefix-96 fixture. Two throw-away probe scripts were used and live outside the repository
(`_to_delete/batch72scratch/` holds the one stub that reached the tree, because this session's bridge cannot
delete).

### 12a. The result

| Log | First **7.2** gameplay difference | Entry | Newly refused | Newly applied (cascade) |
|---|---|---|---|---|
| **`server/JUNO-FCJ`** | **idx 83** | `BuyStock {protocol_id: 4, par_value: "90", quantity: 1, source: "Ipo"}` by `p-9692z98k`, in an **Operating Round** | 21 | 246 |
| **`export/JUNO-3XD`** | **idx 140** | `BuyStock {protocol_id: 5, par_value: "100", quantity: 1, source: "Ipo"}` by `p-h96t6pld`, in an **Operating Round** | 26 | 9 |
| **`fixture/JUNO-FCJ-prefix96`** | **idx 83** | the same entry as FCJ's; the prefix ends at 96, so exactly one entry differs and there is no cascade | 1 | 0 |
| `server/JUNO-7NZ`, `8E8`, `CV4`, `CW7`, `G6J`, `TQQ`, `Z6C`; `export/CV4`, `JJD`, `QVC`, `Y8V`; `golden/7NZ`, `CV4`, `G6J` | **none — gameplay-identical to the 7.1 baseline at every step** | — | 0 | 0 |

**One rule causes all three.** Every first difference is `BuyStock` during an Operating Round (S7-13's round
gate). Nothing else in Batch 7.2 moved a single corpus entry: not the par ladder (no log carries a forged or
off-ladder par), not the pricing (every stored IPO buy's payload par equals its corporation's par), not
availability, not affordability (7.1's ledger already refused those 26), not the Brown continuation, not the
sale rules, not `SetBoPar`.

**The 21 / 26 "newly refused" counts include the cascade.** Only **6** of FCJ's 21 (indices 83, 150, 153, 185,
282, 285) and **4** of 3XD's 26 (140, 141, 219, 284) are stock messages the new rules refuse directly; the rest
are `PassTurn` / `AdvanceOperatingSubPhase` / `LayTile` / `PlaceHomeStation` entries that a *different*, older
rule declines on the board the first refusal produced. Of those ten, seven are the round gate and three are
affordability on an already-diverged board (a president's certificate the buyer can no longer pay for because
an earlier purchase did not happen).
Likewise the 246 / 9 "newly applied" are entries the 7.1 tree refused and the diverged board now admits —
mostly purchases the buyer can now afford because an earlier purchase did not happen. These are consequences,
not findings, and Batch 7.5 will re-pin them together.

### 12b. Distinguishing 7.1's divergence from 7.2's

| Category | Owner | Logs |
|---|---|---|
| Auction proceeds and terrain fees credited to the Bank | **7.1** | every log with an auction purchase (bank field only in nine of twelve rooms) |
| 26 unaffordable purchases refused instead of minting | **7.1** | FCJ from 106, Z6C from 193, 3XD from 28 |
| Signed bank / `bank_broken` first latched | **7.1** | never — no corpus bank goes below zero |
| **`BuyStock` in an Operating Round refused** | **7.2** | **FCJ 83, 3XD 140, FCJ-prefix96 83 — and nothing else** |

### 12c. One field-level artefact, named so 7.5's sweep is not surprised

Field-level comparison (`fieldDigests`) reports `bought_this_turn_company` as differing on every log that
contains a Stock Round, including logs whose gameplay is identical. That is the new key being *written with
the value `undefined`* by the three seat sites — exactly as `stock_turn_stage` has been since #1443.
`stateDigest`, `JSON.stringify` and therefore every golden fixture do **not** see it: the two golden failures
in §11c differ in `virtual_bank_vgp` and nothing else.

**Nothing was re-pinned.** `RULES_ENGINE_VERSION` is still 4; `SUPPORTED_RULES_ENGINE_VERSIONS` is untouched;
the §11c expectations stay stale for Batch 7.5.

---

## 13. UI-parity classification (the standing rule) — tracking only, nothing implemented

Every 7.2 change classified `NONE / LEGALITY SYNC / NEW ACTION / STATE VISIBILITY / RULES REFERENCE`. Every
non-`NONE` result is written into **Part C of `RULES_HARDENING_BACKLOG.md`**. **No frontend file was changed.**

| 7.2 change | S-item | Classification | Part C |
|---|---|---|---|
| First-Stock-Round sale ban, now an authority with an ingress sentence, and the Delayed-Auction reading verified | S8-7 | **LEGALITY SYNC** (narrowed: the engine half is closed) + **RULES REFERENCE** (the tooltip presents §5.1 as a house variant) | U-23 (annotated) |
| Unparred-share sale ban | S8-8 | **LEGALITY SYNC** (narrowed: the control is still offered, but a press now produces a sentence rather than silence) | U-24 (annotated) |
| Par ladder, president's 2 × par, affordability, source availability, Brown continuation, bundle sizes | S8-9 / S7-1 / S7-13 / S7-16 / S7-18 | **LEGALITY SYNC** — the predicates now exist and are exported; `App.purchaseBlockFor` (8577) / `App.saleBlockFor` (8612) and `StockRoundPanel`'s `PAR_VALUE_LADDER` / `cannotAfford` / `multiBuyMax` / source toggle remain local restatements. The dynamic-market par question is answered by construction: the Dynamic Market adds a price ROW and no par boxes, and `parLadderRefusal` reads `parBoxCellFor` | U-25 (annotated) |
| Every new ingress refusal reaching the room banner | S7-1 / S7-13 | **STATE VISIBILITY — closed for the stock half.** `turnRefusal` answers `BuyStock`, `SellStock` and `SetBoPar` with the same predicates the reducer refuses by | U-29 (narrowed to 7.4 + U-30) |
| **New:** the Activity Log cannot say WHY a stock transaction was refused — `refusedAction.ts` asks the two predicates 7.2 now composes, so a replayed refusal gets no reason | S7-13 / S7-16 / S7-18 / S8-7 / S8-8 / S8-9 | **LEGALITY SYNC** | **U-30 (new)** |
| **New:** `SandboxActionContext.parValue` has no reader left and is still supplied by three callers | S7-13 / D-17 | **NONE** (tech debt, recorded so it is not mistaken for a rule — #777) | **U-31 (new)** |
| `bought_this_turn_company` as state | S7-18 | **NONE** — nothing renders it today; the continuation control that would need it does not exist (folded into U-25) | — |
| Stock actions refused outside the Stock Round; forged payloads | S7-13 | **NONE** — the controls are hidden outside their round (#417) and forged payloads are not reachable from the shell | — |
| `SetBoPar` par ladder | S8-9 | **NONE** — the B&O par prompt already offers `PAR_VALUE_LADDER` only (folded into U-25's ladder read) | — |

---

## 14. Ambiguities, interactions and judgement calls

**(a) RULED — the forced (§6.6.3) sale's refusal is visible at ingress (owner, 2026-09-15; backlog D-28).**
The question raised at review was that `emergencyFunding.test.ts` case 7 asserted `turnRefusal(...) === null`
for an illegal forced sale, with the comment "the owner may send it; the reducer refuses it", and that Batch
7.2 makes ingress reply with the rule's sentence instead. **The owner's ruling: keep it visible.** "An
illegal emergency/forced stock sale should return the authoritative refusal reason to the acting president
rather than remain silent. The old silence expectation is not a rule requirement." Authority is unchanged —
the reducer/core remains canonical, ingress surfaces the same rule *result* and never a competing rule, legal
Batch-5 emergency sales remain legal, and only illegal attempts gain an explanatory response.

The ruling asked for three narrow consistency checks before committing. All three are now pinned by
`stockTransactionAuthority.test.ts` rather than asserted in prose:

| # | Check | Evidence |
|---|---|---|
| 1 | the ingress reason is **produced from** `stockSaleRefusal` / `forcedSaleRefusal`, not separately reconstructed | "answers an ILLEGAL forced sale with the forced-sale predicate's own sentence, at both locks (D-28)": on one board it takes `forcedSaleRefusal(...)`, `stockSaleRefusal(...)` and `turnRefusal(...)` and asserts all three are **`toBe`-equal** — the same string, character for character. `turnRefusal` makes exactly ONE call for a `SellStock`, and the only other sentence on that path is the pre-existing *owner* check ("Only C&O's president can resolve its train purchase"), which answers "is this yours to send", not "is this legal" |
| 2 | a **legal** emergency sale still passes ingress **and** the reducer and executes normally | "keeps the forced sale legal when the §6.6.3 obligation names that president": `stockSaleRefusal(...) === null`, `turnRefusal(...) === null`, and the applied sale moves the certificate (30 % → 20 %), the pool (20 % → 30 %), the cash ($20 → $120) and the market token |
| 3 | an **illegal** emergency sale refuses **before** market movement and money/share mutation | the same D-28 test: `stateDigest` identity, `market_positions[PRR]` `toEqual`-identical (cell, price and arrival), cash, holdings, pool and bank all unchanged, and the standing obligation's `shortfall` untouched so the president can still make the legal sale instead |

The illegal case is chosen so that only a *forced* rule speaks: 20 % of PRR is two certificates at $100
against a $30 shortfall, which §6.6.3's "only enough" refuses while an ordinary Stock Round sale of the same
bundle would be legal. The suite's sale projection was switched from a stub to the real
`projectShareSaleMove` at the same time, so "the token did not move" is evidence rather than a property of
the harness — the legal control asserts it *does* move.

**(b) A refused stock transaction is now atomic one layer earlier than 7.1 described, and two of 7.1's own
expectations record that.** 7.1's `refusalAtomicity.test.ts` proved that a refused purchase on a *stale*
board differed in `current_global_era`, and proved (with two controls) that the difference was the settle
chain's and not the transaction's. Under 7.2 the rule is asked in `applySandboxActionCore` ahead of every
stage, so the board comes back **by identity** and the stale case now asserts `after === before`. The two
controls — a neutral `UndoLastAction`, and an affordable purchase — are unchanged and still normalise, so
7.1's finding stands; what changed is that the refusal no longer reaches the chain. The affordable-purchase
control additionally gained `bought_this_turn_company` to its field list. **These are deliberate effects
recorded, not expectations relaxed.**

**(c) `bankBreakLatch.test.ts` used a share purchase as an in-Operating-Round bank receipt.** Its `$100
receipt` helper bought an IPO share while `current_round_type` was `"OperatingRound"` — which is precisely
what 7.2 refuses. The design's own regression (a) (§7.1a) spells that receipt as "a $100 train purchase",
which would need a depot, a tier, a limit and a step to be true of the fixture; the helper now applies the
same purchase with the round set to the one it belongs in and restores the calendar, keeping the arithmetic
and **all eighteen assertions** identical. Worth flagging to the owner as the shape of thing 7.3/7.4 will
also meet: fixtures that used an off-round stock message as a convenient money mover.

**(d) `messageSchema.test.ts` used `BuyStock` as its example of "an ordinary acting-player action"** on an
Operating-Round board, and asserted the acting seat gets `null`. The seat rule is what that case is about, so
it now pins the seat rule on a Stock Round board (where the purchase is legal) and additionally records that
the acting seat meets the ROUND rule on the original board.

**(e) The pinned-board scoping of "no nominal fallback" is a judgement call, and it is D-9's.** The design
says "no nominal fallback on a pinned board"; I read that literally and scoped the missing-market-position
refusal to `typeof state.rules_engine_version === "number"`. The alternative — refusing on any board that
carries `market_positions` — refuses the whole Batch-5 `emergencyFunding` replay corpus, whose fixtures pass
prices through `par_value` figures (`50`, `90`) that are not par boxes, so `reconcileParMarks` places no mark
for them. Both readings are defensible; I took the one that does not strand a development-corpus replay on a
rule its game never had, and tested both sides.

**(f) A corporation with a president and no par is refused rather than priced.** The design's rule 4 covers
"the corporation's stored state has a president and a par"; it does not name the case with a president and no
par, which no legal sequence produces (`grantBOPresidency` and the founding purchase both write the pair
together — #399). I refuse it rather than inventing a price. Recorded in case the owner wants it treated some
other way.

**(g) The LPF double and the President's Certificate.** An IPO purchase naming `certificate: "double"` on an
*unparred* corporation is refused: the purchase that starts a corporation is the President's 20 %, never the
standard 20 % card. Two corpus entries hit this (`JUNO-FCJ` 489, `JUNO-Z6C` 476) and **neither is a new
divergence** — the 7.1 tree already refused both, for affordability, on the same board.

**(h) Not done, by instruction.** 7.3's auction repair, 7.4's offers and consent, Stage 8's presidency /
home / OR-order work, the `RULES_ENGINE_VERSION` bump, the golden and replay re-pins, and every Part C UI
item — including the two this batch filed.

---

## 15. Review outcome

**Approved by the owner on 2026-09-15**, with ruling **D-28** (§14a) — the forced-sale refusal stays visible at
ingress — and its three consistency checks pinned as tests rather than asserted in prose. Committed on that
approval.

What a later reader should check first, if this batch is ever revisited:

1. **The market-step / core order for `SellStock`** (§3) — the one interaction the design flagged. The closure
   and the core call the same function; seven refused sales assert the token did not move, with a real
   projection and a moving control.
2. **§14(a)** — the D-28 ruling and the three-way string identity that keeps ingress from ever growing a
   competing rule.
3. **§12** — that the only corpus divergence is the round gate, and that FCJ 83 / 3XD 140 are genuinely
   `BuyStock` messages sent during an Operating Round.
4. **§11c** — that the six stale cases are 7.1's, verified against the baseline tree rather than assumed.
