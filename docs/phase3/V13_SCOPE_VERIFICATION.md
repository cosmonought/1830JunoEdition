# V13 scope verification: W3-K pre-certification (2026-10-03)

**Branch:** `phase3/v13-scope-verification`. It is docs-only and sits on `phase3/reconciled-execution-plan` @ `6455b6e`.

**Authority:** the rules-v12 source at that head.
- `RULES_ENGINE_VERSION = 12` (`frontend/src/gameEngine/rulesVersion.ts:70`).
- `SUPPORTED_RULES_ENGINE_VERSIONS = [12]` (`:74`).
- `SETTLEMENT_CERTIFIED_RULES_ENGINE_VERSIONS = [10, 11, 12]`.

**Owner rulings in force:**
- **OD-10(a):** one consolidated v13 batch is allowed in Phase 3.
- **OD-2:** the Stock Round Pass Turn rule.
- **OD-4:** automatic bankruptcy.

**Hard stops respected:**
- No rules change, no `RULES_ENGINE_VERSION` bump, no settlement literal touched.
- No AWS or Juno access.
- No full or server suite run.
- Only narrow scratch reproductions were run. Each was run alone, and they total 31 tests, all passing. None is committed under `frontend/src`.
- Their sources are preserved, inert, under [`v13_evidence/`](v13_evidence/README.md).

**Physical rulebook evidence:** `1830 FULL RULES with variants.pdf` at the repository root. It is image-based, so it was rasterised and OCR'd. Pages are cited as printed.

---

## 1. Verdicts

| Candidate | Verdict | Reproduced | v13 (replay) change required? |
|---|---|---|---|
| **A. OD-2 Pass Turn** | **APPROVED DEFECT** | Yes: a turn with no purchase needs two `PassTurn`s | **Yes** |
| **B. OD-4 Automatic bankruptcy** | **APPROVED DEFECT** | Yes: futile sales are forced; a player decision `DeclareBankruptcy` exists; plus three side defects | **Yes**, after six owner sub-rulings (§3.6) |
| **C1. DH-1** | **APPROVED DEFECT** (low: one extra Skip) | Yes, through a `RoomSession` | **No.** A derivation-only fix; stored logs replay identically |
| **C2. GR-1** (= backlog **S10-27**) | **APPROVED DEFECT** (low: a no-op log entry) | Yes, with Gentle Rust alone | **No.** A derivation or append-policy fix; stored logs replay identically |
| **C3. SBS-3** | **APPROVED DEFECT** | Yes | **Yes** |
| **D. SBS-4** | **APPROVED DEFECT** (precisely reproduced; the audit wording was imprecise) | Yes | **Yes** |
| **E1. OD-17 / D-18** (#54→#883 vs #62→#883) | **INVALID** | The behaviour is as described, but it is the printed rule | No |
| **E2. OD-17 / D-22** (#59 → brown OO facings) | **ALREADY CORRECT** (fixed by Stage 9.3, rules v7) | The 256 count reproduces only with rule 5b removed; it is 0 today | No |

## 2. Proposed exact v13 scope

The v13 batch contains these items, and only these:

1. **OD-2.** On a revision-2 board, one `PassTurn` ends the Stock Round turn (§3.1).
2. **SBS-3 and SBS-4.** The Brown Bank Pool continuation is open only while the turn's purchase so far is a Brown-zone Bank Pool purchase with no sale since (§4.3, §5). It is one turn-scoped field and one refusal.
3. **OD-4.** Insolvency is proven automatically; treasury and cash are committed automatically; the intercorporate-trade window has an explicit close; `DeclareBankruptcy` is retired on v13 boards (§3.2–§3.6). **Implementation waits for the owner's answers to O-1 to O-6 (§3.6).** If OD-4 is not ruled before W3-K starts, items 1 and 2 can ship as v13 without it, but OD-4 then needs its own bump (v14) and its own certification. The owner should decide which.

The following are **not** in v13:

- **DH-1 and GR-1 / S10-27.** These are real defects, but they change only what the live room derives, never what a stored entry means (§4.1, §4.2). They may land in the W3-K slice for convenience, or in any server/derivation slice, with no version bump.
- **GR-1b** (new, §4.2) is a shell-only, no-server-path defect. It is routed as a UI fix, not v13.
- **D-18 and D-22.** No change. Documentation and comment cleanup only (§6).
- RR-4, OD-3 and the other W3-K-conditional rows were **not** part of this verification. They stay as the execution plan places them.

### 2.1 Cross-cutting requirements for the v13 batch

- **One bump, one changelog row.**
  - `RULES_ENGINE_VERSION = 13`.
  - `CURRENT_RULES_REVISION = 2` (`gameVariants.ts:530`), for the Stock Round items. This follows #1443's existing mechanism: `variants.rules` is the per-table switch the reducer branches on.
  - The server already stamps it at the deal (`server/src/rooms/roomService.ts:495`).
- **Gating.**
  - The Stock Round items ask `variants.rules >= 2`.
  - OD-4 asks for the pin (#1698's presence rule, as v11 and v12 did).
    - If the owner chooses to carry `[12, 13]` (next bullet), it must instead ask that the pin's **value** is at least 13.
  - The unpinned development corpus (rules revision 1) replays unchanged.
- **Version policy consequence.** `SUPPORTED_RULES_ENGINE_VERSIONS` is `[RULES_ENGINE_VERSION]`. After the bump, a v12-pinned room in flight is refused. The project precedent is to refuse it. **The owner should confirm** before deployment that v12 rooms are drained or abandoned, rather than carried as `[12, 13]`.
- **Settlement is a separate axis.**
  - v13 is **not** settlement-certified when it lands. The literal stays `[10, 11, 12]` until a separate certification pass adds 13 on its own evidence.
  - OD-4 changes terminal boards: the bankrupt player keeps the shares v12 would have forced them to sell, and rivals' prices are not driven down. So **the v13 certification needs bankruptcy settlement vectors**, not just the v12 corpus re-run.
- **The UI must change in lockstep with OD-2.** It cannot follow later. On a revision-2 board:
  - **Buying would become impossible.** The shell greys every Buy in the "sell" stage with "Selling comes first. Press Pass…" (`App.tsx:9574-9576`), and that Pass would now end the turn.
  - **Auto-Buy would end the turn without buying.** It sends a "stage" `PassTurn` before buying (`App.tsx:9916-9924`).
  - **The action bar would mislead.** It still shows stage buttons ("Sell Shares" / "Buy a Share") and the Pass tooltip "Done selling (or nothing to sell) — move on to buying." (`panels/ContextualActionBar.tsx:4160-4207`, fed by the `stockStage` prop at `App.tsx:14041-14045`). On a revision-2 board that tooltip would describe a Pass that now ends the turn.
  - **What `phase3/w1-stock-auction` (W1-A, provisional, `76056b7`) has already done:** it removes both shell stage refusals (its buy check calls `stockPurchaseRefusal`). It still has Auto-Buy's stage Pass (that branch's `App.tsx` around 9928-9935) and the bar's stage copy.
  - **So the deployment that ships revision 2 must include all of:**
    - W1-A;
    - removal of Auto-Buy's stage Pass;
    - W2-B's single "Pass Turn" control, which replaces the bar's stage buttons and copy (the 6.5-A "UI" invariants).
  - On a revision-2 board, the buy-stage Sell refusal (`App.tsx:9605-9611`, if it survives) becomes dead code.
- **Wider pin churn.** `CURRENT_RULES_REVISION = 2` also changes `STANDARD_VARIANTS.rules` (`gameVariants.ts:674`).
  - It is used by the hosted create path (`App.tsx:12729`) and `SandboxWaitingRoom.tsx:197`.
  - About 31 test files reference `STANDARD_VARIANTS` or `CURRENT_RULES_REVISION`, so pins beyond `utils/sellBuySell.test.ts` will move.
  - `compat/sessionContinuation.ts:193` uses the constant to recognise a newer deal. That behaviour is wanted, but it should be checked.

---

## 3. A and B: the approved owner rules

### 3.1 A. OD-2: Pass Turn

**The owner rule.** Sell whenever otherwise legal. At most one Buy action per turn. After a Buy, Buy is disabled and Sell stays legal. One control, "Pass Turn", ends the turn in **one** action.

**v12 behaviour.**
- The rules revision is 1, i.e. Sell-Buy-Sell (#1443).
- `stockTurnStage` (`sandboxSession.ts:344-349`) returns:
  - `"sell_again"` once `bought_this_turn > 0`;
  - otherwise `stock_turn_stage === "buy" ? "buy" : "sell"`.
- The `PassTurn` arm (`sandboxSession.ts:5589-5593`):
  ```ts
  if (sellBuySellInForce(resolveVariants(state.variants))) {
    const stage = stockTurnStage(state);
    if (stage === "sell") return { ...state, stock_turn_stage: "buy" };   // ← the stage move
  }
  return hasActedThisTurn(state) ? advanceSeat(state) : recordPass(state);
  ```
- **Nothing refuses a Buy or a Sell because of the stage.** In the reducer and at ingress the stage is read only here.
  - `turnAuthority.ts`, `stockTransactionAuthority.ts`, `sharePurchase.ts`, `derivedActions.ts`, the narration and `server/src` never read it.
  - The only other non-shell reader is the test-support snapshot `utils/offerMatrix74Support.ts:115`, which refuses nothing.
  - The shell's stage reads are covered in §2.1.

**Reproduced** (`v13_evidence/od2Sbs.test.ts.txt`, "OD-2: v12 Pass semantics"; pinned v12 board, revision 1):

| Turn | v12 log | Seat / streak |
|---|---|---|
| Nothing done | `PassTurn` (stage only) → `PassTurn` | Seat moves on the **2nd**; streak +1 |
| Sold only | `SellStock` → `PassTurn` (stage) → `PassTurn` | Seat moves on the 2nd; streak 0 (acted) |
| Bought first | `BuyStock` → `SellStock` → `PassTurn` | Seat moves on the 1st (`sell_again`); a 2nd Buy is refused |

**The smallest change.**
- Add one predicate in `gameVariants.ts`:
  ```ts
  /** v13 / revision 2 (OD-2): one PassTurn ends the Stock Round turn. */
  export function passEndsStockTurn(v: Pick<GameVariants, "rules">): boolean { return v.rules >= 2; }
  ```
- Change one condition in the `PassTurn` arm:
  `if (sellBuySellInForce(v) && !passEndsStockTurn(v)) { …stage move… }`
- Add one changelog row. Set `CURRENT_RULES_REVISION = 2`.
- That is the whole reducer change.
  - `stock_turn_stage` stays in the type for revision-1 boards; it is simply never written on revision-2 boards.
  - `stockTurnStage` then answers only `"sell"` or `"sell_again"`, which is exactly the owner's "Buy enabled / Buy disabled".
- No new message, no new state field, and no ingress change are needed.

**Each invariant the brief names, checked against a faithful model of the change** ("OD-2 model" in the evidence file: the unchanged reducer handed a board already past the stage branch; 5/5 pass):

| Invariant | Holds? | Why |
|---|---|---|
| All-pass round ending | ✔ | `recordPass` counts the streak (`:563-600`). Four consecutive single passes end the round; the model shows `macro_round_number` advancing. |
| Acted turn vs true pass | ✔ | The arm still ends through `hasActedThisTurn ? advanceSeat : recordPass`. `turn_action_taken` is set by a sale, a purchase (`:5782`) and a private trade (D-27, `:5380`). A sell-only turn ends in one Pass with streak 0. A do-nothing turn counts 1. A purchase mid-streak resets the streak. |
| Sell before buy | ✔ | Already legal in v12. A Buy straight from the opening stage is accepted (the existing `sellBuySell.test.ts` case). |
| Sell after buy | ✔ | `sell_again`: a sale is accepted and a second Buy is refused (rule 4, `sharePurchase.ts:201-207`). |
| Must-sell obligations | ✔ | The hold is stage-independent: `divestmentPassRefusal` at the reducer's core gate (`sandboxSession.ts:4001`) and at ingress (`turnAuthority.ts:434-437`). Today it refuses even the stage Pass (SBS-5). After the change it refuses the one Pass. Purchases stay barred by the debt (`sharePurchase.ts`, rule 0). |
| Priority Deal | ✔ | Only `markTrader` (on Buy, Sell and private trades, `:5383 / :5784 / :5894`) moves `last_trader_index`. A Pass never marks. The model ends the round with `priority_deal_index` = left of the last trader. |

**Also checked, unaffected:**
- The M&H "between turns" boundary (`mohawkExchange.ts:385-400`) is the seat move; it simply arrives one message earlier.
- Auto-Pass sends one `PassTurn` per log index; it works and is simply needed once.
- RR2A-F1's round-transition refusal and the auction's `WaterfallPass` are separate arms.

**Replay:** a revision-2 log has one `PassTurn` where revision 1 had two. So a revision-2 log means something different to a v12 reducer, which is the v13 bump. Revision-1 logs (the unpinned corpus) replay unchanged.

### 3.2 B. OD-4: automatic bankruptcy, v12 behaviour

Investigated in depth. Evidence: `v13_evidence/od4AutomaticBankruptcy.test.ts.txt` (9/9 pass); baseline `utils/emergencyFunding.test.ts` 29/29.

**The predicate** (`emergencyFunding.ts:260-285`):
- `shortfall = max(0, cost − treasury − presidentCash)`.
- `legalSales` is a bundle-by-bundle oracle (`legalForcedSales`, `forcedSaleRefusal`, `:448-530`), with "only enough" at `:487-493`.
- `bankrupt = shortfall > 0 && legalSales = [] && legalPrivateSales = [] && no private offer`.
- The reducer applies it as a settle step after **every** action (`settleBankruptcy`, `sandboxSession.ts:4206-4215`, called at `:4081`). It is derived identically on every client; no entry is logged.
- The source does **not** use a static maxRaisable sum. Confirmed: it asks the oracle on the live board after each sale.

**Where v12 diverges from the owner rule:**

| # | Divergence | Reproduction |
|---|---|---|
| B-1 | **Futile sales are forced.** While any legal sale stands, the president must make it, even when no sequence can reach the price. | R1: $80 shortfall, the only sale PRR 10% @ $50. Bankruptcy follows only after the sale. That sale also drops PRR's price, hurting a third player. R2: two futile sales. |
| B-2 | **A player-facing `DeclareBankruptcy` exists.** It is offered when no share sale is legal but a private could be offered. | `declareBankruptcyRefusal` `:403-416`; gate `sandboxSession.ts:3747`, arm `:6227-6240`; ingress `turnAuthority.ts:226`; button `EmergencyTrainPurchaseModal.tsx:429-440`. V4b: v12 waits on the click even when the private can never cover the shortfall. |
| B-3 | **Treasury and cash are not committed automatically.** The president must send `EmergencyBuyHardware`. Nothing derives it. | V6 (funded board: `nextDerivedAction` returns `null`). |
| B-4 | **The intercorporate opportunity is pre-empted.** `bankrupt` ignores the D-6 trade, so a board that enters Buy Trains with no legal sale ends at once, although `trainSaleRefusal` says a trade is legal. | R3 |
| B-5 | **Liquidation-funded trades are allowed.** `fundedTradeRefusal` (`:422-443`) uses the president's *current* cash, which includes forced-sale proceeds. D-6's own text says "if completing the trade would require any liquidation, that path is refused". | R5 |
| B-6 | **Edge case (LPF / Scenario-D other-20 only):** "only enough" plus the half-sale rule jams. A 20% block that would fund is refused as "more than enough", and a 10% half-sale is refused because no 10% share is in the Pool. The game ends although a sale could fund. | R4 / V7 |

### 3.3 B. How insolvency can be proven

The recommendation is **(b): a monotone upper bound, plus the exact v12 oracle as the base case.** This needs one new replay event, for (c).

**Monotonicity: why a sale can never increase what can still be raised.**
While the obligation stands, every non-resolving message is held (`emergencyFundingBlock`). So:
- **Prices only fall.** A sale moves only its own corporation's token, one row per physical certificate (9.4c).
- **Other players' holdings never change.** Sold shares go to the Pool, so the rescued corporation's successor threshold and the rivals' holdings are fixed.
- **Pool cards only increase.**
- **Phase and treasuries are fixed**, except that a private sale drains its buyer.
- **Corporations are independent**, except through the shared shortfall.
- **Order across corporations is irrelevant.** Within one corporation, *bundling* matters: one bundle is paid at today's price (#713), so splitting earns less (V3). Even then, no certificate fetches more than today's price.

**The bound** (sound under every implemented rule):

```
U_shares = Σ_c certs_c × price_c(now)
  certs_c = floor((held_c − floor_c) / 10), capped by Pool room (5 cards − cards in Pool; other-20 counts as one card)
  floor_c = max(20, highest rival holding)   for the rescued corporation (the presidency may not move)
          = 20                                for another corporation P presides, if no rival holds ≥ 20
          = 0                                 otherwise
  unpriced corporations contribute 0
U_priv   = Σ over offerable privates of min(2 × face, the largest eligible buyer's treasury)
PROVEN INSOLVENT  ⇔  T + C + U_shares + U_priv < cost      (bound)
                 ∨  (legalSales = [] ∧ legalPrivateSales = [])   (v12's exact base case)
```

None of the following can raise anything above the bound, because each only restricts sales or lowers proceeds:
- "only enough";
- the other-20 half-sale and Scenario-D rules (#1624);
- the per-certificate market step;
- presidency exchanges in other corporations.

**Completeness:**
- In Classic (no other-20 certificate) the bound is exact. If `bound ≥ shortfall`, one pass at today's prices funds the train: one bundle per corporation, the smallest legal bundle that covers or else the largest, judged by `forcedSaleRefusal`.
- The only gap is an LPF or Scenario-D other-20. There, v12's exact base case remains. An optional per-corporation search (at most 6 certificates, `projectShareSaleMove` plus `forcedSaleRefusal`) is finite and deterministic if exactness is wanted.

**Determinism.**
- The predicate is a pure function of the committed board.
- It is evaluated in the reducer's existing `settleBankruptcy` step, after every action, the move into Buy Trains included. So every client, every replay and every rebuild reaches the same `GameEnd` at the same entry.
- No `nextDerivedAction` entry is needed for the ending.
- **Cost:** O(corporations) on top of the oracle `emergencyFundingFor` already runs.

**(c) A new explicit replay event is needed, for the intercorporate window only.**
- v12 has no way to know the trade opportunity is over.
- The proposal is a president-only `ForgoTrainTrade` ("Buy from the Bank instead"), which writes a turn-keyed marker. The first forced `SellStock` or private funding offer closes the window implicitly.
- Until the window closes (and while any offer awaits an answer), there is no automatic purchase and no bankruptcy.
- Without this event, an automatic ending could fire while a legal trade stands (B-4), or wait forever.

### 3.4 B. The minimal v13 change, pin-gated

All of the following apply only on a v13-pinned board.

1. **`emergencyFunding.ts`.** `bankrupt = shortfall > 0 ∧ windowClosed ∧ no standing offer ∧ PROVEN INSOLVENT`, where `windowClosed` is either:
   - no other corporation owns a train the D-6 rule would let it sell; or
   - the turn's marker is set.
2. **`fundedTradeRefusal`.** Refuse once the window is closed. The trade budget is the treasury plus cash *before* any sale (fixes B-5; see O-3).
3. **Automatic commit.** When `shortfall = 0`, the window is closed and no offer stands, `nextDerivedAction` emits `EmergencyBuyHardware`, reusing the existing arm and gates. Kind `forced-purchase`, key `emergency:<turnGuardKey>`.
4. **Retire `DeclareBankruptcy`.** It is refused on v13 boards, and the modal loses the button and becomes non-dismissible (W2-G presentation).
5. **(O-4)** "Only enough": refuse a bundle only when a smaller *legal* bundle already covers (fixes B-6).

### 3.5 B. Test vectors

Common setup unless stated:
- A 2-train at $80 from the depot.
- Treasury T = 0, president cash C = 0.
- P1 holds 20% of C&O, the rescued corporation, and P2 also holds 20%, so C&O is unsellable.
- Pools are empty and there are no privates.

| # | Board | Bound | v12 (reproduced) | Expected v13 |
|---|---|---|---|---|
| V1 | P1 holds PRR 10% @ $50 (P3 presides, 40%) | 50 < 80 | Must sell PRR, then `GameEnd` | `GameEnd` at once with no sale; P1 keeps PRR 10% |
| V1b | 3-train $180; NYC 10% @ $100, PRR 10% @ $50 | 150 < 180 | Two sales, then `GameEnd` | `GameEnd` at once |
| V2 | C&O: P1 40% (President's cert + other-20), P2 30%, @ $90 | 90 (inconclusive) | `GameEnd` (no legal sale) | `GameEnd` via the base case |
| V3 | PRR 20% @ $40, P1 not president | 80 = 80 | A 20% bundle funds. A 10% + 10% split leaves P1 short, then one futile sale | A 20% bundle → automatic purchase. After a 10% split, `GameEnd` at once |
| V4a | Phase 3, 3-train $180; P1's private face $160; NYC treasury $500 | 320 | Declare button | No automatic end: private funding stays optional (O-2) |
| V4b | As V4a, face $20 | 40 < 180 | Waits for the Declare click | `GameEnd` at once |
| V5 | T 30, C 30; no legal sale; NYC (P1 presides) owns a 2-train | 0 | `GameEnd` on entering Buy Trains | Window open: no end and no automatic purchase; a trade ≤ $60 and ≤ face is legal; after `ForgoTrainTrade`, `GameEnd` |
| V6 | T 30, C 100; no other corporation owns a train | n/a | Waits for `EmergencyBuyHardware` | Automatic purchase: T 0, C 50 |
| V6b | As V6, but NYC owns a 2-train | n/a | Waits | Waits for a trade or `ForgoTrainTrade`, then automatic purchase |
| V7 | T 30 (shortfall 50); P1 holds NYC's other-20 @ $100; no 10% share in the Pool | 200 | `GameEnd` (jam) | With O-4 as recommended: a 20% sale → automatic purchase |
| V8 | PRR 10% @ $50, B&O 10% @ $20; NYC (P1 presides) owns a 2-train; T + C = 0 | 70 < 80 | Sell PRR, then a $50 trade rescues | `GameEnd` at once (the trade budget is 0 before liquidation) |

**Replay impact:** yes.
- Stored v12 logs contain futile `SellStock`s, explicit `EmergencyBuyHardware` and `DeclareBankruptcy` entries, R3-type immediate endings and R5-type liquidation-funded trades. v13 refuses or pre-empts each of these.
- Terminal boards, and therefore settlement vectors, differ.

### 3.6 B. Owner sub-rulings needed before OD-4 is implemented

- **O-1 · The trade window.** It closes at the first forced sale, at a private funding offer, or at an explicit "Buy from the Bank" (`ForgoTrainTrade`). Its budget is the treasury plus cash before any sale. *Recommended.*
- **O-2 · Optional private funding as the only remaining path (V4a).** The buyer's consent cannot be proven in advance, so some president-only "Forgo private sale" decision is unavoidable. The alternative is an automatic end only when U_priv is also short. Either way it is not a "Declare Bankruptcy" button. Which wording and shape?
- **O-3 · Liquidation-funded intercorporate trades become illegal.** This is D-6's literal reading. Confirm.
- **O-4 · "Only enough" with an indivisible other-20 (V7).** May the smallest *legal* bundle overshoot? *Recommended: yes.*
- **O-5 · Insolvency-creating bad splits (V3).** Should the president remain free to make them, with the game ending immediately after (*recommended*, with a warning), or should such sales be refused while solvency is reachable?
- **O-6 · Scoring.** Confirm that "shares he could not sell" (v3 changelog) includes shares that were legally sellable but never sold because v13 ended the game first.

---

## 4. C. Existing conditional rule findings

### 4.1 DH-1 (AUD-04.04): APPROVED DEFECT, no v13 needed

**Setup.** The evidence file `dh1LaterTurnTokens.test.ts.txt` runs this through a `RoomSession`, by legal play.
1. Corporation OWN owns the D&H (`owner_protocol_id`). Its home is I15, and it holds a 2-train.
2. On OR x.1, OWN sends `LayTile{F16, #57, ability_key:"dh-tile"}`, which sets `dh_station_pending = OWN` and `used_private_abilities = ["dh-tile"]`.
3. OWN declines the free station, skips Tokens manually and passes. The turn change clears `dh_station_pending` (`sandboxSession.ts:4556`). `"dh-token"` is never written, because only a placed station writes it (`:4914`).
4. On OR x.2, OWN skips Track and lands on Tokens. Its network reaches no free slot.

**v12 behaviour.**
- The skip of Track derives nothing, so OWN is **held on Tokens**.
- `dhFreeStationAvailableFor` (`dhPower.ts:418-436`) returns **true**. It never reads `dh_station_pending`.
- The server's default `extraStationAvailable` (`derivedActions.ts:145-157`) therefore says a free station exists. `stationTokens.ts:707` returns before reachability is judged, so no skip is derived.
- The authority refuses that same free placement: `dhStationRefusal`, "only comes with the same turn's lay…" (`dhStationAuthority.ts:149-154`). The room answers it `refused`.
- With the window respected, `nextDerivedAction` derives the skip, key `…:Tokens`.
- "Until the D&H closes": `dhPower.ts:428` checks `closed`. The shell (`App.tsx:11266-11269`) has no `closed` check ("forever"), but on the hosted path the shell never dispatches derived actions.

**The player's experience.** One extra manual Skip on each of the D&H owner's later turns where no ordinary placement exists. No legal action is blocked, no illegal action is allowed, and no state is wrong.

**The intended rule.** v7 9.4b and rulebook p.47 / T-05: the free, unconnected station comes only with the same turn's lay. Afterwards the D&H gives nothing.

**Why no v13 is needed** (the reconciliation's "replay-affecting" note is not borne out):
- `RoomEngine.apply` never derives (#1203). `replayLog` walks stored entries through `apply` only.
- A stored v12 log holds the player's manual Tokens skip, which stays legal, so it replays to the same board.
- A log written after the fix (a derived skip in the same place) also replays under v12.
- No refusal and no state field changes.
- The only observable effect is that a room currently waiting there gets the derived skip at its next submit or restore repair. That is continuation, not reinterpretation. This is unlike DT-1 (v9), whose old logs held entries the new rule forbade.

**The minimal fix** (any slice, no bump):
- Server: derive `extraStationAvailable` from the authority itself, `dhStationRefusal(state, {company_id, …}, grid) === null`, or at least also require `dh_station_pending === companyId`.
- Shell: the same predicate at `App.tsx:11266`.
- **Do not** "fix" this by writing `"dh-token"` at the turn change. That is a state change, and so a replay change.

### 4.2 GR-1 (AUD-08.01): APPROVED DEFECT, no v13 needed. This is the open backlog item S10-27

**Setup.** The evidence file `gr1RefusedDerivedWithhold.test.ts.txt` runs this through a `RoomSession`. It is the board of `gentleRustCertification.test.ts` case B.
1. A Gentle Rust table. NYC buys the first 4, which dooms every 2.
2. C&O's grace turn: its only trains are Final Run 2s; treasury $100.
3. C&O runs I5–I7 for $40.

**v12 behaviour.**
- The run's burst is `["RunMultipleRoutes", "DeclareDividends*"]`.
- The Final Run 2s retire on entering Dividends, so the fleet is `[]` while `last_route_revenue = "40"`.
- `nextDerivedAction` mints a forced $0 withhold from the fleet-based verdict (`derivedActions.ts:284-308`).
- The reducer refuses it (`dividendAmountRefusal`: "$40 ran… $0 does not match").
- The derived loop appends it anyway: `replayLog.ts:641-655` `settleOwed` and `roomSession.ts:946-961`. #1685's refusal handling judges only the player's own entry.
- The entry is a **pure no-op**: same digest, state and grid. It takes a log index, a `logHash` link and the turn's key. There is no loop, because the key is spent first and the loop is capped at 32.
- The president then declares $40 normally.
- A replay with or without the no-op reaches the identical final state.

**Is it genuinely wrong?**
- Yes: a refused entry should not be committed, and the forced withhold should apply only when nothing ran.
- Low severity on the hosted path.
- It is already recorded as **S10-27** (`RULES_HARDENING_BACKLOG.md`, OPEN since UR-3) and pinned on purpose by `utils/unpredictableRevenueCertificationGame.test.ts:456`. The audit's "no Gentle-Rust-specific code" is right: the cause is the general derivation.

**Why no v13 is needed.** The reducer is unchanged. A stored no-op stays a no-op. New logs simply stop recording it (the backlog's own "Replay: none for stored logs").

**The minimal fix:**
1. In `derivedActions.ts:284-294`, force the withhold only when nothing ran (`routes_run_this_turn === 0` and a zero run).
2. Optionally, in `settleOwed`, do not append a derived entry the reducer left unchanged; keep the key spent.
3. Update the pin at `:456`.

**New finding, GR-1b** (shell, no-server path only; not v13). The shell's forced-withhold effect (`App.tsx:11430ff` → `declareDividendsChoice(false, true)`, `:10296-10325`) sends the **run's** $40 as a withhold, and the reducer **accepts** it. So on the no-server path the president of a Final-Run corporation is never offered the pay-out choice. The hosted path never dispatches derived actions (#1213). Route it to a UI slice; it has no stored-replay effect.

### 4.3 SBS-3 (P3-N023): APPROVED DEFECT, v13

**Setup.** `od2Sbs.test.ts.txt`, "SBS-3"; a pinned v12 board, revision 1.
- CPR was started at $76. Its token is now at $30, which is Brown (the Brown prices are 10, 18, 20, 25, 27 and 30).
- CPR has 20% in the IPO and 30% in the Bank Pool.
- p0 holds NYC 10%.

| Sequence (p0's turn) | v12 |
|---|---|
| Pool CPR → Pool CPR (control) | applied, applied: the zone allowance ✔ |
| **Pool CPR → Sell NYC → Pool CPR** | **applied, applied, applied.** `bought_this_turn = 2`; a second Buy action ✘ |
| Pool CPR → Sell CPR → Pool CPR | 3rd refused by the buy-back lockout ("You sold CPR this Stock Round…") ✔ |

**Mechanism.**
- Rule 4 (`sharePurchase.ts:201-207`) asks only `allowsExtraPoolBuys(zone, source)` of the *current* purchase.
- Rule 7 (`stockTransactionAuthority.ts:465-476`) asks only that it is the same corporation.
- Nothing records that a sale intervened.

**The intended rule.** Under the owner's OD-2 rule ("after Buy, Buy is disabled; Sell remains legal") and rulebook p.13 ("This purchase counts as your one certificate purchase for the turn"), the Brown allowance is one Buy action of several certificates. A sale ends it. **Genuinely wrong**, and a v13 change: a stored log may hold such a sequence, which v13 would refuse.

### 4.4 The shared minimal change for SBS-3 and SBS-4

- **One optional, turn-scoped field.** `pool_continuation_open?: boolean`.
  - It is set `true` by a `BuyStock` that is a Brown-zone Bank Pool purchase.
  - It is set `false` by any other purchase and by any `SellStock`.
  - It is cleared wherever `bought_this_turn` is cleared: `advanceSeat` `:351-367`, `recordPass` `:563-578`, the round sites `:1066-1076` and `:3133-3136`.
    - Those are all four sites. Comments at `gameState.ts:700`, `stockTransactionAuthority.ts:469` and `sandboxSession.ts:5777` still say "three".
    - Also add the field to the `Pick<>` of `openingStockRoundReset` (`sandboxSession.ts:1051-1060`), and to `guarded()` in `utils/offerMatrix74Support.ts`.
- **One refusal, on revision 2.** Once `bought_this_turn > 0`, a `BuyStock` is legal only if `pool_continuation_open === true`, it is still Brown and Bank Pool, and it is the same corporation (rule 7).
- **Absent means "not said"** (#232). So revision-1 boards keep v12's behaviour.

---

## 5. D. SBS-4: the "Brown IPO first purchase" claim: APPROVED DEFECT, precisely reproduced

**What the finding actually refers to.** It is **the first purchase of the turn from the IPO of an already-started corporation whose market token is in Brown**, followed by a Bank Pool continuation of the same corporation. It is **not** a corporation's first-ever purchase.

**The owner's observation is correct and confirmed.**
- Every par box ($67, 71, 76, 82, 90, 100) is in the Normal zone (`marketZoneForPrice`). So a President's Certificate purchase can never be a Brown purchase.
- An IPO share of a started corporation is sold at **par** (#1570), while the zone is the **token's** (`chartContextFromState(state).marketZoneFor`, `stockTransactionAuthority.ts:109-126`).
- So a crashed corporation with unsold IPO shares is "Brown" for its IPO too.
- The 6.5-A phrase "a Brown IPO first purchase" was shorthand for this. It is **not** an audit error, but it is imprecise.

**Reproduced** (`od2Sbs.test.ts.txt`, "SBS-4"; same CPR board):

| Sequence | v12 |
|---|---|
| **IPO CPR ($76, par) → Pool CPR ($30)** | **applied, applied.** Cash 2000 → 1924 → 1894 |
| Pool CPR → IPO CPR | 2nd **refused**: "One certificate purchase per turn. Only Brown-zone shares bought from the Bank Pool may be taken several at a time." |

**Mechanism.** The same as SBS-3: rule 4 judges only the *continuation's* source, so an IPO first purchase opens a Pool allowance, while the reverse is refused.

**The intended rule** (rulebook):
- **p.13 (base game):** "you may purchase any number of certificates from the bank pool of one corporation whose share value token is in a brown grid box. *This purchase counts as your one certificate purchase for the turn.*"
- **p.25 (1830 Classic)** points to V-6.3.
- **p.31, V-6.3:**
  - **"Buy From Bank Pool («)"** is the marked default: pool shares only.
  - The optional variant **"Buy All"** allows "any number of bank shares *and* shares from the bank pool of one corporation" in Brown.

**Verdict.** v12 matches **neither** printed alternative. It allows IPO→Pool but refuses Pool→IPO, so it is genuinely wrong.
- Under the default rule, the IPO purchase is the turn's one purchase and opens no allowance. The §4.4 change implements exactly this: `pool_continuation_open` is false after an IPO purchase.
- **Owner confirmation requested (OD-A-4):** the default «Buy From Bank Pool», not "Buy All". If the owner wanted "Buy All", the fix would differ: allow IPO and Pool in either order, still closed by a sale.
- Either way it is a v13 change.

---

## 6. E. OD-17 tile claims

Evidence: `d18d22TileUpgrades.test.ts.txt`, which uses the real authority `filterSandboxPlacements` as the reducer runs it (`boardLayRefused`, `replayProviders.ts:75-98`), plus an independent geometry check written from the catalog's `paths` and `cityGroups`. 3/3 pass; the related `utils/stage93TileAuthority.test.ts` passes 44/44. **The owner's belief holds: the hand-entered manifest and upgrade paths are correct on both claims.**

### 6.1 D-18: New York, #54 → #883 offered while #62 → #883 is not: INVALID

**The authoritative manifest** (`components/hexTileCatalog.ts`):

| Tile | Lines | Colour | Edges | Cities | Revenue |
|---|---|---|---|---|---|
| #54 | `:389-397` | Green | `0b001_111` | `[[0,1],[2,3]]` (two cities) | $60 |
| #62 | `:494-506` | Brown | `0b001_111` | `[[0,1],[2,3]]` | $80 (owner ruling) |
| #883 | `:794-803` | **Brown** | `0b110_011` | no `cityGroups` field; `paths` are fully pairwise over {0,1,4,5}, i.e. one 4-slot city | $90, `plusOnly` |

**The physical manifest** (rulebook p.48, Table T-09, verified visually):
- `ny1 (54)` upgrades to **ny5 (62) and ny6 (883)**.
- `ny5 (62)` has **no upgrade**.
- `ny6 (883)` is "+1" (1830+) with **no upgrade**.
- p.19 ❺: "only gray tiles may upgrade brown tiles".

**What the engine accepts at G19, all three tables:**
- standard: #54@1 → #62@1.
- plus and LPF: #54@1 → #62@1 **and #883@3**.
- #62 (any facing) → #883 (any facing): **all 36 refused**, by rule 4, the colour tier (`components/sandboxTileLegality.ts:786`): brown on brown.

**Geometry of the accepted #54@1 → #883@3:**
- Old: cities {1,2} and {3,4}, segments 1–2 and 3–4.
- New: one city on {1,2,3,4}, all six pairs.
- Every old segment is preserved, and both old stations map into the single city (city map [0,0]). So 6.2.2 ❸ and ❹ are met.
- `RULES_HARDENING_BACKLOG.md:2578` already records this as "the only city merge in the tile set".

**Where the premise came from.** Comments that call #883 "#62's replacement": `utils/tokenMigration.ts:326`, `utils/stationConnectivity.ts:105`, `sandboxSession.ts:5993`, `utils/nyMerge.test.ts:1-25`, `components/tileTransition.test.ts:335-340`. The code they describe serves the legal #54 → #883 lay identically.

**Change:** none. Comment and backlog cleanup only.

### 6.2 D-22: #59 → brown OO facings that break fixed OO: ALREADY CORRECT

**The tile.** #59 is the **green** OO tile (T-09 `oo2`): `cityGroups [[0],[2]]`, two termini, `separateSystems: true` (`hexTileCatalog.ts:399-411`).

**The rule.**
- p.33, "Fixed OO Cities" (the default): the replacement may not connect the two original segments.
- The optional "Variable OO" allows the join for #67, #65 and #64.

**The engine.** Rule 5b, `separationPreserved` (`components/sandboxTileLegality.ts:488-509`, `:806`; Stage 9.3 / S9-19, rules **v7**), refuses any facing that puts #59's two exits into one component.

**The "256", reproduced.** It counts distinct (table, hex, #59 facing → brown tile @ facing) transitions that join both #59 cities. A walk over every hex of the three tables, tier by tier, gives:

| | All transitions | From #59 | **Joining both #59 cities** |
|---|---|---|---|
| Rule 5b removed (emulating pre-9.3, in memory) | 68,141 | 792 | **256** (#35 56, #36 56, #64 48, #65 48, #67 48; std D10/E5/E11 18 each, H18 6; plus/LPF E5/E11 42, H18 14) |
| **Current v12** | 67,861 | 536 | **0** |

- The pre-9.3 breakdown matches D-22's text exactly.
- All 536 surviving transitions preserve every #59 exit and segment, and map each #59 city into its own brown city (#64–#68 at 96 each, #984 at 56).
- The independent geometry check and the engine agree on every row.

Example: #59@0 on E11 (exits 0 and 2). Key: J = joins both cities, s = cities stay separate; + = accepted, − = refused.

```
#64 [[0,2],[3,4]]  0:J-  2:s+  4:s+     #67 [[0,3],[2,4]]  0:s+  2:s+  4:J-
#65 [[0,4],[2,3]]  0:s+  2:J-  4:s+     #36 / #35: every facing J-  (no legal facing from #59 under fixed OO)
```

- The tiles with joinable facings (#64, #65, #67) are exactly the ones p.33's Variable OO names, which corroborates the catalog.
- That #35/#36 have no legal facing from #59 is already recorded (S9-19 / S9-21; `stage93TileAuthority.test.ts:268`).

**Change:** none. Mark D-22 RESOLVED by Stage 9.3 / rules v7 in `VISUAL_FLOURISH_BACKLOG.md`. Update the "currently accepts" wording in D-15, D-21 and D-24 and in `components/tileTransition.ts:695-700, 2082`.

---

## 7. Corrections to the planning record

- **`PHASE3_AUDIT_RECONCILIATION.md`, AUD-04.04 (DH-1).** "A server derivation change is replay-affecting: v13" does not hold. `RoomEngine.apply` never derives, so the change is derivation-only (§4.1).
- **AUD-08.01 (GR-1).** "Changing what the derived loop appends is replay-affecting (v13)" does not hold for stored logs (§4.2). It is S10-27.
- **P3-N024 (SBS-4).** It reads "first purchase of the turn from the IPO of an already-started Brown-zone corporation", not "first-ever purchase" (§5).
- **VF/D-18.** It is the printed rule (§6.1). **VF/D-22** was resolved by Stage 9.3 (§6.2).
- **Execution plan W3-K.**
  - Its scope becomes §2: OD-2, SBS-3, SBS-4 and OD-4, pending O-1 to O-6.
  - DH-1 and GR-1 leave the version bump.
  - D-18 and D-22 leave the batch.
  - The OD-2 slice is coupled to W2-B and W1-A in one deployment (§2.1).
  - Its 8–14 h estimate predates OD-4. With OD-4, roughly 14–22 h is more realistic, including v13 settlement certification with bankruptcy vectors. This is an estimate, not a measurement.

These corrections are recorded here only. The reconciliation matrix and `phase3_accounting.json` are not edited by this docs pass.
