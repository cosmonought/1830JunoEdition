# Batch 7.4 — pending offers, consent and authoritative settlement

Date: 2026-09-15. Baseline: Batch 7.3 committed (`d0a079247e6e206cd904bb7f1a30c3f47bdd9876`).
`RULES_ENGINE_VERSION` **4 — deliberately not bumped** (the 4 → 5 bump belongs to Batch 7.5).
Design: `BATCH7_TRANSACTION_AUTHORITY_DESIGN_2026-09-15.md` §7.4, §7.5, §7.6, §7.6a (frozen); owner rulings D-18
(Q5), D-19 (Q6), D-20 (Q7), D-23 (Q10/Q11), D-24 (Q12), D-26 (N1), D-27 (N2); Batch 5's D-5 / D-6 preserved; ledger
items S7-5, S7-6, S7-7, S7-8, S7-9, S7-11, S7-12, S7-14, S7-19.

**This is the core / state-machine / wiring pass. Not committed. The full Jest suite was not run. No golden, replay
or corpus expectation was re-baselined. No frontend component was touched. Stage 8 untouched. Every unrelated owner
working-tree change is untouched (the batch was built in a clean checkout of `d0a0792` and only this batch's files
are written back). The exhaustive ±one-fact test matrix is the follow-on Opus batch's.**

> **Bottom line.** Every ordinary bilateral transaction now has one authority asked at three moments on the board of
> that moment: `privatePurchaseRefusal` (a corporation buying a player's private), `trainSaleRefusal` (a corporation
> buying another's train) and `privateTradeRefusal` (a player buying another player's private — the third offer kind,
> implemented). The counterparty who may answer is re-derived from the board every time; the payload's `owner` /
> `seller_president` are narration. One ordinary offer stands at a time and `pendingOfferBlock` freezes everything
> but its answer, its rescission, its settlement, `RevertTo` and `CloseRoom`. An accepted offer's derived settlement
> runs the full predicate and, if it fails, retires the offer and moves nothing — the one deliberate mutation of a
> refusal, and the reason `settleOwed` cannot spin. Two ordinary rescissions and the trade's three messages join the
> schema (44 → 49); the chain-era `AcceptTrainOffer` family is refused on pinned boards. D-5 and D-6 keep their
> money semantics and gain only the consent and timing every voluntary sale has. **One new suite of 28 cases; 59
> focused suites, 1,130 tests, all passing; typecheck clean; lint identical to the baseline.** Against `d0a0792`
> sixteen of seventeen corpus files are digest-identical at every entry; the one that differs is JUNO-FCJ, whose
> first gameplay difference is **idx 309**, a direct `BuyPrivateCompany` sent during a Stock Round.
>
> **Follow-up after the Opus adversarial matrix (§20, same day).** The matrix's 325 cases found one core blocker,
> R74-B — the derived train-settlement key was a tuple of board facts that legal play can bring back, so a later
> distinct offer between the same parties was never settled and the hold froze the table — and its companion O1.
> Both are repaired here (#1597 offer instance identity, #1598 derived-entry keys); everything else in the core
> passed. The Opus files are kept and their R74-B / O1 characterizations flipped to the repaired behaviour. Still
> not committed; version still 4; nothing re-pinned.
>
> **Final Opus verification and commit (§21, 2026-09-16).** Approved by the owner. No engine correction was needed
> after the repair; the one fix was shell / rebuild dedupe lifecycle correctness on the no-server (Firestore) undo
> path — `acceptedOfferSentRef` reset in `App.tsx`'s `rebuildSandbox`. S9-10's wording corrected for the full
> expanded / LPF rules. Committed as Batch 7.4; version still 4; corpus / golden expectations still deliberately
> stale and un-repinned.

---

## 1. Files changed

| File | What |
|---|---|
| **`frontend/src/gameEngine/pendingOfferHold.ts`** (new, 187 lines) | The one-offer representation (`standingOrdinaryOffer`, `anyOfferStands`), the global hold (`pendingOfferBlock`, #1590), the settlement matchers, and Q11's `legacyOfferMessageRefusal`. |
| **`frontend/src/gameEngine/privatePurchaseAuthority.ts`** (new, 227) | `privatePurchaseRefusal` (#1591) and the offer's three consent predicates (`proposePrivatePurchaseRefusal`, `answerPrivatePurchaseRefusal`, `rescindPrivatePurchaseRefusal`); `currentPrivateOwner`, `buyerPresident`. |
| **`frontend/src/gameEngine/trainSaleAuthority.ts`** (new, 226) | `trainSaleRefusal` (#1592) and its three consent predicates; `sellerPresident`. D-6's `fundedTradeRefusal` is asked first, inside. |
| **`frontend/src/gameEngine/privateTradeAuthority.ts`** (new, 175) | `privateTradeRefusal` (#1593) and its three consent predicates; `stockRoundSeat`, `tradeCounterparty`. |
| `frontend/src/gameEngine/sandboxSession.ts` | The core: Q11 refusal, the hold, the nine offer-message gates (#1595), `trainSaleRefusal` replacing the two #1513/#1541 train gates, `privatePurchaseRefusal` for `BuyPrivateCompany`; the `applySandboxActionCore` wrapper that retires a refused accepted settlement (#1596); the arms: proposals record the board's counterparty, two rescission arms, the trade's three arms with D-26/D-27 (#1593 arms). |
| `frontend/src/gameEngine/turnAuthority.ts` | Ingress: Q11 + the hold after the discard and funding holds; every proposal / answer / rescission answered by the same predicates; the two direct settlements answered in `operatingLegalityRefusal` (now takes the actor). |
| `frontend/src/gameEngine/gameState.ts` | `PrivateTradeOffer`, `private_trade_offer?`. |
| `frontend/src/gameEngine/gameSetup.ts` | The five message interfaces and guards (#1594); `SandboxLogMsg` and `isSandboxOnlyMsg` grown. |
| `frontend/src/gameEngine/messageSchema.ts` | The five schema rows (44 → 49). |
| `frontend/src/gameEngine/derivedActions.ts` | The private offer's derived key names the whole transaction; a funding offer is never derived; note on why retirement makes the loop finite. |
| `frontend/src/gameEngine/emergencyFunding.ts` | `RescindTrainPurchase` joins `resolvesEmergencyFunding` (the D-6 proposer can withdraw under the obligation). |
| `frontend/src/gameEngine/index.ts` | The four modules on the engine's surface. |
| **`frontend/src/utils/offerAuthority.test.ts`** (new, 28 tests) + **`offerFixtures74.ts`** (new, test support) | §16. |
| `frontend/src/utils/emergencyFunding.test.ts`, `shellMessageArms.test.ts`, `turnAuthority.test.ts`, `messageSchema.test.ts`, `refusalAtomicity.test.ts`, `trainLifecycle.test.ts`, `levelPlayingFieldRules.test.ts`, `baltimorePrivate.test.ts`, `moneyConservation.test.ts` | Focused behavioural expectations updated to the newly authoritative rules, each with its reason in place (§16b). **Not re-pins**: none reads a stored log, a golden fixture or a corpus board. |
| `RULES_HARDENING_BACKLOG.md` | S7-5/6/7/8/9/11/12/14/19 → `RESOLVED`; U-19 … U-22 annotated with the 7.4 outcome (no duplicates); a Part E row. |
| **`BATCH7.4_PENDING_OFFERS_2026-09-15.md`** (new) | This report. |

Not touched by this pass: `App.tsx` (its one Batch-7.4 line is the §21b shell rebuild fix), every `components/` file, the owner's in-flight `StockRoundPanel` / `stockTransferFocus` /
`stockCardFocus` / `stockTransaction*` / `rules*.test.tsx` / `audio.ts` / `privateCatalog.ts` / `privateCardText` /
`privateOfferRow` / `powerRefusalAndChips` work.

---

## 2. The ordinary-offer state representation

Three fields, at most one of them non-null at a time (and never one of them beside a funding offer):

```ts
private_purchase_offer?: { private_id, private_name, owner, buyer_protocol_id, buyer_ticker, price, accepted?: true, funding?: true } | null
train_purchase_offer?:   { seller_protocol_id, seller_ticker, seller_president, buyer_protocol_id, buyer_ticker, model_type, price: string, accepted?: true } | null
private_trade_offer?:    { private_id, private_name, seller, buyer, price, proposer } | null     // NEW (#1593)
```

- The two corporation-buyer shapes are **unchanged**; what changed is what is written into `owner` and
  `seller_president`: the board's current owner / president at proposal (the payload's values are not written), and
  neither is consulted for authority afterwards.
- `private_trade_offer` is a **third field**, not a discriminator on the corporation shape (design §7.6a). It has no
  `accepted` flag: an accepted trade is a settled one (the answer arm settles it, the D-5 shape).
- The funding offer (`funding: true`, #1541) is **not** an ordinary offer: `standingOrdinaryOffer` never reports it,
  `nextDerivedAction` never derives it, and it keeps its own freeze, answerer and settlement arm.

---

## 3. Message / schema additions

`RescindPrivatePurchase { game_id?, private_id }` · `RescindTrainPurchase { game_id?, seller_protocol_id }` ·
`ProposePrivateTrade { game_id?, private_id, seller, buyer, price: int }` · `AnswerPrivateTrade { game_id?, private_id,
accept }` · `RescindPrivateTrade { game_id?, private_id }`.

`GAMEPLAY_MESSAGE_KINDS` **44 → 49**, verified against the committed baseline (the design predicted 44 → 49 and
nothing in 7.1–7.3 had changed the count). All five are in `isSandboxOnlyMsg` (seat-exempt, each with its own owner
at ingress). No legacy type deleted; `AcceptTrainOffer` / `RejectTrainOffer` / `RescindTrainOffer` remain in the
schema and the union (S10-8) and are **refused on a pinned board** with a sentence naming the sandbox message that
replaces each; a legacy board keeps the no-op arm (D-9). No stored log contains any of the new messages, so no
adapter.

---

## 4. `pendingOfferBlock`: ordering and exemptions

Asked in `applySandboxActionCoreJudged` **after** the discard hold (#1530), the funding hold and its arms (#1540/#1541)
and **before** every ordinary gate; at ingress after the same two holds and before the consent exemption. So a board
under a discard or a funding obligation reports THAT reason; a board under an ordinary offer reports the offer.

While an ordinary offer stands (awaiting its answer, or accepted and awaiting its derived settlement), the pass list
is closed:

| Standing offer | Passes |
|---|---|
| any | `RevertTo`, `CloseRoom` |
| private purchase, unanswered | `AnswerPrivatePurchase` (same private), `RescindPrivatePurchase` (same private) |
| private purchase, accepted | `BuyPrivateCompany` matching private / buyer / price (the derived settlement), `RescindPrivatePurchase` |
| train purchase, unanswered | `AnswerTrainPurchase` (same seller), `RescindTrainPurchase` (same seller) |
| train purchase, accepted | `BuyTrainFromCorporation` matching seller / buyer / model / price, `RescindTrainPurchase` |
| private trade | `AnswerPrivateTrade`, `RescindPrivateTrade` (same private) |

Everything else — `PassTurn`, `AdvanceOperatingSubPhase`, every purchase and sale, another offer of any kind,
`OfferPrivateForFunding`, `EmergencyBuyHardware`, the forced `SellStock`, `DeclareBankruptcy`, `DiscardTrain`,
`PlaceHomeStation` — is refused (identity in the core; the sentence at ingress). Who may send the passing messages
is the consent predicates' question, asked next.

**Reconciliation with the other holds.** The discard hold and the home-token hold cannot coexist with an ordinary
offer in play: each refuses a proposal while it stands, and neither can arise while the offer stands (no train or
share purchase can happen under the hold, and an intercorporate sale changes no phase). The funding hold CAN
coexist, by design: the D-6 path is an ordinary train offer proposed while the obligation stands, and while it
stands the forced sale, the emergency purchase, the funding private offer and the declaration are frozen until the
seller answers or the president withdraws — the intersection of the two pass lists is exactly {answer, rescission,
settlement, `RevertTo`, `CloseRoom`}. The funding offer and the ordinary offers are mutually exclusive by the
proposal predicates (`anyOfferStands` counts all four fields). A fixture can still build a discard-plus-offer board;
there the two holds refuse each other's exits and `RevertTo` is the way out — noted in §19 rather than papered over
with an exemption the design does not list.

The derived settlement is never made impossible: it is in the pass list, `nextDerivedAction` derives it whatever
else the board is doing (before the OR checks, unchanged), and a refusal retires the offer (§12).

---

## 5. The ordinary private purchase — predicate and consent flow

`privatePurchaseRefusal(state, { buyerId, privateId, price }, actor, moment)` in `privatePurchaseAuthority.ts`, in
this order: an Operating Round; the buyer is `operatingCorporationId` (any step of its turn, D-18); phase 3 or 4
(`privatePurchasePhaseOpen`); the private exists, is open, `isSellableToCorporation` (the B&O ban), and is a
**player's** (`owner_protocol_id` null — a corporation-owned private is "not sold by them"); a whole price inside
`privatePriceBounds(face)`; the buyer floated with a president; `treasuryOf(buyer) ≥ price`; consent.

Consent (`moment === "settlement"` only): legal when the board carries an ordinary `private_purchase_offer` with
`accepted: true` matching private / buyer / price **whose `owner` is still the private's current owner**; otherwise
only when `actor === owner && actor === buyer.president` (one principal, the shell's existing same-president
dispatch, #701). A `null` actor skips the consent rule as the stock predicates skip the rules that are about a
player (#549b) — every server and replay entry carries its author.

Flow: `ProposePrivatePurchase` → `proposePrivatePurchaseRefusal` (one offer at a time; proposer = buyer's current
president; the predicate at `"proposal"`) → the arm writes the offer with the **board's** owner. `AnswerPrivatePurchase`
→ `answerPrivatePurchaseRefusal` (answerer = `currentPrivateOwner` re-derived; on `accept: true` the predicate at
`"answer"` — a stale board refuses the answer by identity and leaves the offer standing) → the arm records
`accepted: true` (a no clears it). `nextDerivedAction` owes `BuyPrivateCompany` → the core asks the predicate at
`"settlement"` → the arm pays `treasury → owner` once through the ledger and rewrites ownership; the arm clears the
offer it settles. Payment exactly once; no money created or destroyed (`moneyConservationBreach` null in every case).

---

## 6. The voluntary train sale — predicate and consent flow

`trainSaleRefusal(state, { buyerId, sellerId, model, price }, actor, mapGrid, moment)` in `trainSaleAuthority.ts`:
**D-6 first** (`emergencyFundingFor` + `fundedTradeRefusal`, exactly where the core asked it since #1541); an
Operating Round; the buyer operating; `operating_sub_phase === "Hardware"` — **for the proposal too** (D-18/Q5: the
settlement is derived the instant the seller accepts, and a train may not run on the turn it is bought); buyer ≠
seller; the seller floated and owning the model; a whole price ≥ $1; **the treasury alone** (D-20/Q7) unless D-6 names
this buyer, in which case D-6's own funding rule has already answered; the limit in force (the Stage-4 gate,
unchanged, last train allowed); consent at settlement: a matching accepted offer (seller, buyer, model **and** price)
or the actor presiding over both corporations.

Flow: `ProposeTrainPurchase` (proposer = buyer's current president; the seller must have a president; the predicate at
`"proposal"`) → the arm writes the offer with the **board's** seller president. `AnswerTrainPurchase` (answerer =
`sellerPresident` re-derived; a yes re-runs the predicate). Derived `BuyTrainFromCorporation` → predicate at
`"settlement"` → `settleTrainSale` (treasury → treasury once; the D-6 contribution passes through the treasury only
when `emergencyFundingFor` names the buyer, as before). The ordinary path never touches the president's cash
(pinned: P1's $300 unchanged through a $150 sale).

---

## 7. The player ↔ player trade — predicate and settlement

`privateTradeRefusal(state, { privateId, seller, buyer, price })` in `privateTradeAuthority.ts`: a Stock Round;
`!isFirstStockRound(state)` (7.2's predicate — the Delayed-Auction SR1 counts as the first); the seat
(`player_addresses[active_player_index]`) is the buyer or the seller; buyer ≠ seller, both seated; the private
exists, is open, `owner === seller` and not a corporation's; a whole price **≥ $0** (a gift is legal); no ½–2×
band; `playerCashOf(buyer) ≥ price`; `certificateBreakdown(buyer, state, chart).counted + 1 > limit → refuse` (a
`null` limit refuses nothing). Re-derived at proposal, at answer and at settlement (which is the answer arm).

Consent: `proposePrivateTradeRefusal` — one offer at a time; the actor must be the buyer or the seller AND the seat
holder; `answerPrivateTradeRefusal` — only `tradeCounterparty(offer)` (whichever party did not propose), and a yes
re-runs the predicate; `rescindPrivateTradeRefusal` — only `offer.proposer`.

Settlement, in the `AnswerPrivateTrade` arm on `accept: true`: `transfer(buyer → seller, price)` through the 7.1
ledger (conserved; $0 is a transfer of nothing), `owner` rewritten (`owner_protocol_id` null), the offer cleared,
then the N2 writes (§9). A refusal, a rejection or a rescind writes none of them.

---

## 8. D-26 / N1 — what travels with the card

The arm rewrites `owner` and **nothing else**, which is the whole of N1: every still-unexercised ownership-dependent
power follows the card because every one of them reads `owner` at the moment it is used — the M&H exchange
(`ExchangePrivate` is the owner's, `roomMessageRefusal`), the D&H / C&SL / JK lays and the D&H station.
`used_private_abilities` is per private and is not rewritten, so a used ability stays used. The C&A's PRR share was
granted at the auction and lives in `player_holdings`; the arm touches no corporation, so a later sale of the C&A
issues nothing. The B&O's certificate and par were established by `SetBoPar` on the corporation; nothing re-owes
them (`boPresidencyRefusal` is unchanged before and after the trade). The BO private **is** saleable player → player
(`isSellableToCorporation` is not consulted here) and still not to a corporation. Pinned: the M&H's new owner can
exchange it and the old one cannot; `used_private_abilities: ["dh-token"]` survives a D&H sale; the C&A sale leaves
`player_holdings` and `ipo_pool_percentage` identical; the BO trade leaves `public_companies` deep-equal.

---

## 9. D-27 / N2 — Stock Round bookkeeping

On a settled trade, all written by the answer arm: `turn_action_taken: true` (so the End Turn that follows is
`advanceSeat`, never `recordPass` — #745), `consecutive_passes: 0`, `last_trader_index` = the **seat** through
`markTrader(state, seat)` (never the answerer as such). Untouched: `bought_this_turn`, `bought_this_turn_company`,
`active_player_index`, `stock_turn_stage`. Pinned on a board with `consecutive_passes: 2, last_trader_index: 2`:
after the trade they are 0 and 0 (P1's seat), the seat is still 0, `PassTurn` then advances to seat 1 with the
streak 0 and no round end; on the seller-turn shape `last_trader_index` is the seller's seat 1; a rejected offer
leaves all three markers as they were; and P1 may still make the turn's stock purchase after the trade (the hold is
released, `bought_this_turn` is 0).

---

## 10. Answerer / proposer re-derivation

| Message | Who, re-derived from the board at that moment |
|---|---|
| `ProposePrivatePurchase` / `ProposeTrainPurchase` | `buyer.president` (#1450, unchanged) |
| `AnswerPrivatePurchase` | `currentPrivateOwner(private_id)` (falls back to the recorded owner only so a dead offer can be REJECTED; an acceptance then fails the predicate) |
| `AnswerTrainPurchase` | `sellerPresident(seller_protocol_id)` |
| `RescindPrivatePurchase` / `RescindTrainPurchase` | the buyer's **current** president (a presidency that moved under the offer moves the right to withdraw with it — pinned) |
| `ProposePrivateTrade` | the seat holder, who must be the buyer or the seller; recorded as `proposer` |
| `AnswerPrivateTrade` | `tradeCounterparty(offer)` |
| `RescindPrivateTrade` | `offer.proposer` |

The forged case is closed both ways: a proposer who names himself as `owner` / `seller_president` finds the board's
name in the offer and cannot answer (pinned at both locks); a card that changed hands under the offer is answered
by its new owner and not by the recorded one, and that acceptance is then refused at settlement because the
offer's recorded owner is no longer the current owner (§12).

---

## 11. Rescission and rejection

Both clear the one offer field and nothing else: pinned by `differing(before, after)` being exactly the offer field
(carried as `null` after a clearing where the pre-offer board did not carry it), with no money, ownership, train,
treasury, cash, seat, step, round or Stock Round marker moved, and the hold released (`pendingOfferBlock` null,
`PassTurn` legal at ingress). Rescission is the proposer's alone (buyer's current president; the trade's proposer);
rejection the counterparty's. Rescission is also allowed while an offer is accepted-but-unsettled (the design's hold
lists it as passing in both states); in play the settlement lands in the same burst as the acceptance, so that case
is reachable only if a settlement was never derived (§19).

---

## 12. Accepted-offer derived settlement and stale retirement (#1596)

`applySandboxActionCore` is now a two-line wrapper: run the judged core; if it handed back the state it was given
(a refusal) **and** the message is the settlement of the standing accepted ordinary offer (same private / buyer /
price, or same seller / buyer / model / price), return `{ ...state, <offer>: null }`; otherwise return the refusal
untouched. Every gate in the core — the holds, the identity gate, the obligation gate, the new predicates — is
covered by one rule, which is the only way "cannot become permanently re-owed" stays true of gates added later.
Pinned across seven stale boards for the private (card moved / corporation-owned / closed; treasury drained; turn,
round and phase moved on) and one for the train (train gone), each: `differing === ["<offer field>"]`, offer null,
ownership and money unchanged, `nextDerivedAction` null afterwards.

**The refusal-atomicity exception, stated precisely (§L).** A refused proposal, answer, rescission or direct
settlement is a true no-op (identity; `differing === []` where the board already carries the settle-chain's derived
fields). The one exception is a refused settlement that matches the standing accepted ordinary offer, which mutates
exactly the offer field to `null`. The funding offer is excluded: its refusal leaves it standing for a rescind, by
Batch 5's design.

---

## 13. `settleOwed` cannot spin or double-settle

Three locks, each pinned:

1. **The board never presents the same accepted offer twice.** The settlement arm clears the offer on success; the
   wrapper clears it on refusal. `RoomEngine.settleOwed` on an accepted-but-stale board mints exactly one derived
   entry, the offer is null afterwards, and a second `settleOwed` mints nothing.
2. **Through a room**: proposal → hold refuses `PassTurn` at ingress → acceptance returns entries `[answer, derived
   BuyPrivateCompany]` and nothing else; the room's log holds one `BuyPrivateCompany`; a `restore` replays to the same
   digest. A room seeded with a stale accepted offer repairs it on the first submit (one derived entry, refused and
   retired, money and ownership unchanged), derives nothing on the second submit, and a rebuild from its log agrees.
3. **The `emitted` key** is kept as the existing architecture's in-process guard and — since the §20 follow-up —
   names the OFFER INSTANCE (`offer:private:<instance>` / `offer:train:<instance>`, #1597), never a tuple of
   board facts, so a different later offer for the same asset between the same parties at the same price is a
   different key; `settleOwed`'s 32-iteration cap is the last line, unchanged. *(As first written this key named
   the transaction — the private's id / owner / buyer / price, the train's seller / model / buyer / fleet size —
   and Opus proved the train tuple recurs in legal play: R74-B, §20.)*

Double payment and double transfer are excluded by construction — the ledger moves the price once inside the arm
that also clears the offer, and a straggler's second copy of the settlement finds no offer and no consent (pinned:
applying the derived purchase twice returns the settled board by identity).

---

## 14. `RevertTo`

Log-level, unchanged, no undo code added. Pinned through `replayLog`: `[propose, revert(0)]` → no offer, no hold;
`[propose, accept, derived settlement, revert(1)]` → the pending unanswered offer restored with the board's owner,
the card still the player's, the treasury untouched, the hold in force; `[propose, accept, derived settlement]` →
`applied 3`, one settlement, conserved. For the trade: `[propose, accept]` settles; `[propose, accept, revert(1)]`
restores the seller's card and cash and the pending offer with `turn_action_taken` false.

---

## 15. Batch-5 D-5 / D-6 intact

- The whole `emergencyFunding.test.ts` suite passes (29), including the funding offer's freeze ("nothing else can
  happen until its president answers or the seller withdraws"), its answerer (the buying president), its
  revalidation-at-settlement matrix and its retirement rules — `pendingOfferBlock` never reads a funding offer and
  `emergencyFundingBlock` is asked first.
- D-6 keeps its money: the funded trade (treasury first, the president the rest, the face cap when he contributes)
  now arrives through the ordinary offer — C&O's president proposes at Hardware under the obligation
  (`resolvesEmergencyFunding` admits the proposal, the answer and the new `RescindTrainPurchase`), PRR's president
  accepts, the derived settlement pays $30 from the treasury and $120 from the president, and the obligation is
  gone; the unconsented direct trade is refused; the face cap now refuses the **offer** at both locks
  (`trainSaleRefusal` asks `fundedTradeRefusal` first); "is refused when completing it would need a share sale, and
  the accepted offer is retired" passes unchanged through the new wrapper.
- The two families are exclusive: a funding offer on the board refuses an ordinary private or train proposal
  ("already standing"); an ordinary offer refuses `OfferPrivateForFunding` through the hold; the ordinary answer arm
  does not settle a funding offer; `nextDerivedAction` never derives one.
- The rescued corporation still cannot buy a private (`ProposePrivatePurchase` is not in `resolvesEmergencyFunding`),
  and presidential cash still enters only through D-6 (the voluntary path pins P1's cash unchanged).

---

## 16. Validation

**Only focused suites were run. The full Jest suite was not run.**

### 16a. New suite — `utils/offerAuthority.test.ts`, 28 tests

B (4): the legal private purchase end to end; the predicate's rules one fact at a time; direct settlement without
consent refuses / same-principal works; the answerer is the current owner. C (3): the legal train sale end to end;
the rules one fact at a time incl. Hardware-only proposal and the limit; direct settlement refuses (and never for
$0) / same-president works. E/F (5): the private hold across seven held messages at both locks, the accepted state
held, a trade proposal refused beside it; a train offer blocks a private offer and a trade offer blocks a stock
purchase and `PassTurn`; rescission (owner, atomicity, stale presidency, the chain-era rescission refused);
rejection; Q11 on pinned and legacy boards. G (5): seven stale private boards and one stale train board retire
without moving anything; a stale acceptance is refused at the answer and the offer stands; `settleOwed` through a
room (once, restore, stale repair, no re-owe); the engine's own loop. RevertTo (2). H/I/J (7): buyer-turn and
seller-turn trades; the predicate's rules incl. SR1, seat, parties, card, $0 / negative / fractional price, cash,
no band; $0 trade, non-turn initiator, third-party answer, proposer-only rescind, rejection atomicity; the
certificate limit at 19 / 20 / 21 at proposal, answer and settlement, and the seller's count; N1; N2. A (1): the
funding offer and the ordinary offers are exclusive. M (1): schema 49, the five shapes validate, malformed refuse.

### 16b. Focused behavioural expectations updated — with reasons in place; **not re-pins**

| Suite | What changed, and why |
|---|---|
| `emergencyFunding.test.ts` (D-6 block) | the direct unconsented trade is now refused; the D-6 purchase arrives through the offer (propose / accept / derived) with identical money assertions; the face cap refuses the offer at both locks |
| `shellMessageArms.test.ts` | the arms are exercised on a legal Operating board (`offerFixtures74`) instead of the auction-round opening scenario; the recorded counterparties are the board's; the "train gone" retirement is made stale by hand |
| `turnAuthority.test.ts` | the answerer is the board's current owner / president — the fixtures put the D&H in BOB's hands and CAROL over the B&O; a rejection proves the exemption, an acceptance is judged as a purchase; the sandbox-only family classification lists the five new members |
| `messageSchema.test.ts` | 44 → 49; the president's proposal is refused for the transaction, not for who he is; the train answer's owner is the board's president |
| `refusalAtomicity.test.ts` | the corporate-purchase board is legal (queue, phase 3, a $60 face); the retirement case now goes through #1596's wrapper |
| `trainLifecycle.test.ts` | (8) and the FCJ 413/468 reconstruction settle through an accepted offer; the limit refuses the proposal too |
| `levelPlayingFieldRules.test.ts` | the JK purchase board is phase 3 with the buyer operating; the "second grant never happens" case makes N&W operating and floated so the purchase is real |
| `baltimorePrivate.test.ts` | the ordinary-sale control uses a legal board; the ban's own boards are untouched |
| `moneyConservation.test.ts` (S7-12 block) | the board is legal (queue, phase 3, `cost` not `face_value`); the $0 corporate sale is now the band's refusal, and the ledger's $0 allowance is shown by the trade suite |

### 16c. Focused sweep — 59 suites, 1,130 tests, all passing

`offerAuthority`, `auctionAuthority`, `miniAuctionTurn`, `auctionSeating`, `auctionCashMovement`, `atomicReducer`,
`autoPass`, `gameSetup`, `levelPlayingField`, `levelPlayingFieldRules`, `replayJunoCV4`, `roomSession`,
`bidSectionLabel`, `divergenceWatch`, `shellNarration`, `turnAuthority`, `messageSchema`, `privateOrdinal`,
`boFloatRule`, `privateRevenue`, `privateExchange`, `baltimorePrivate`, `privateClosure`, `cashLedger`,
`stockTransactionAuthority`, `stockRefusalAtomicity`, `refusalAtomicity`, `bankBreakLatch`, `emergencyFunding`,
`emergencyTrainFlow`, `logRevert`, `logExport`, `derivedActions`, `serverProtocol`, `replayEquivalence`,
`replayAttribution`, `operatingCursorReplay`, `stateDigest`, `trainDiscard`, `trainLifecycle`, `batch36`,
`forcedDivestment`, `variantRules`, `rulesVersion`, `roundLabel`, `joinFlash`, `polishWave7`, `turnGateSource`,
`shellMessageArms`, `privateOffer`, `privateOfferRow`, `privatePowerOffer`, `trainOffer`, `actionReceipt`, `batch60`,
`logCondense`, `stepJumpButton`, `stickyBarSplit`, `dhPower`, `kanawha`.

### 16d. Stale expectations left for Batch 7.5 — unchanged in number

The five suites / ten cases stale since 7.1–7.3 (`replayGolden` CV4 + G6J, `replayJuno3XD` ×2, `gameHistory` ×4,
`roundReplay` ×1, `moneyConservation`'s corpus case ×1) fail exactly as Batch 7.3 left them. **Batch 7.4 adds no
stale corpus-facing case**: its one corpus divergence is JUNO-FCJ, which no test replays past 96.

### 16e. Typecheck, build, lint, static searches

| Check | Result |
|---|---|
| `tsc --noEmit -p frontend/tsconfig.json` | **clean** (on the clean `d0a0792` checkout; the owner's in-flight files are not in it) |
| `tsc --noEmit -p server/tsconfig.json` (the whole engine as the server compiles it) | **clean** |
| `tsc -p server/tsconfig.json` (build, to a directory outside the repository, for the sweep) | **succeeds** |
| `eslint` on every file this batch touched | **identical to the baseline**: `sandboxSession.ts` 1 error + 3 warnings, all pre-existing (`import/first` at the re-export, `TileColor`, `STATIC_BOARD_HEXES`, `limit`); `derivedActions.ts`'s pre-existing `derivePhase` warning; the four new modules and the new test files are clean (two now-unused imports the batch itself made redundant in `sandboxSession.ts` — `fundedTradeRefusal`, `countableTrainCount`, `isTrainLocked`, `depotCostFor`, `TrainTier` — were removed rather than left as warnings) |
| static: does `turnAuthority` restate an offer rule? | **no** — every proposal / answer / rescission / direct settlement is one call into the three authority modules; the only offer fields it reads are to decide which predicate to call |
| static: readers of `offer.owner` / `offer.seller_president` for authority | **none** — `currentPrivateOwner` / `sellerPresident` everywhere; the recorded owner is read only as the fallback answerer for REJECTING a dead private offer (§10) and by the shell's narration |
| static: writers of the three offer fields | the nine arms in `applyOneAction`, `transferPrivateToCorporation`'s callers (clear on settlement), the #1596 wrapper — and nothing else |

---

## 17. Corpus divergence — 7.4 only, measured against `d0a0792`

**Method.** The committed 7.3 tree (a `git worktree` at `d0a0792`) and this tree were each compiled with
`server/tsconfig.json`; every corpus file (five exports, eight server logs, three goldens, the FCJ prefix fixture —
seventeen) was replayed through both under `DEVELOPMENT_CORPUS_POLICY`, capturing `stateDigest`, `fieldDigests`,
`moneyTotal` and the bank before every applied entry and at the end. Throw-away probes outside the repository.

### 17a. Identical at every entry and at the end — 16 of 17

`export/JUNO-3XD` (320), `export/JUNO-CV4` (120), `export/JUNO-JJD`, `export/JUNO-QVC` (70), `export/JUNO-Y8V`,
`fixture/JUNO-FCJ-prefix96` (92), `golden/JUNO-7NZ`, `golden/JUNO-CV4` (141), `golden/JUNO-G6J`, `server/JUNO-7NZ`,
`server/JUNO-8E8`, `server/JUNO-CV4` (141), `server/JUNO-CW7` (118), `server/JUNO-G6J`, `server/JUNO-TQQ`,
`server/JUNO-Z6C` (604). The stored proposals at Hardware (CW7 121, QVC 59) and every stored answer and derived
settlement in these rooms satisfy the new predicates on their log-derived boards.

### 17b. `server/JUNO-FCJ` — the one room that differs

| Entry | Action | 7.3 | 7.4 | Why |
|---|---|---|---|---|
| **145** | `ProposeTrainPurchase` B&M ← B&O's 2-train, $80, by p-9692z98k at Hardware | applied (offer recorded) | **refused** | the B&O owns no 2-train on the log-derived board — an inherited 7.1 consequence (its purchase was refused for want of money upstream) — so `trainSaleRefusal` refuses the offer; 146 (`AnswerTrainPurchase`) and 147 (the derived settlement) then find nothing to answer or settle (7.3 applied 147 as an offer-clearing on a sale it also refused) |
| 205, 273 | `ProposePrivatePurchase` by B&O / B&M at another corporation's Tokens step | applied | **refused** | the buyer is not the operating corporation (S7-7); 209 / 274, their declines, find nothing |
| 232 | `ProposeTrainPurchase` in a Stock Round | applied | **refused** | not an Operating Round; 234's decline finds nothing |
| 146–308 | — | — | — | **no gameplay difference**: the only differing fields are `train_purchase_offer` / `private_purchase_offer`, carried as `null` by 7.3 after its clearings and absent under 7.4, which never wrote them |
| **309** | **`BuyPrivateCompany`** — B&O buys private 7 (the JK, LPF) for $60 from its own president, sent during a Stock Round | **applied** | **refused** | **the first gameplay difference**: rule 1 of `privatePurchaseRefusal` (an Operating Round); the design's probe row "BuyPrivateCompany during the Stock Round" |
| 310 → end | cascade | | | from 310 `player_cash`, `public_companies`, `private_companies` and `jk_license_granted` differ, the JK's licence grant never happens, and every later step differs (Stock Round seats and OR steps land on different boards). Final: 8 differing fields; `moneyTotal` identical (20,000) and the bank identical (15,896) at the end |
| 163, 177, 279, 314, 468, 614, 768, 784, 975 | direct `BuyTrainFromCorporation` | no-op | no-op | already refused under 7.1's ledger / limit on the log-derived board; 7.4 refuses them for consent and timing too — no new difference |

**Inherited versus new.** 7.1/7.2/7.3 diverge FCJ from 74 / 83 / 106 (Part E); the 7.3 tree is the baseline here,
so every difference above is 7.4-only by construction. The design's §9 prediction for FCJ ("205/232/273 proposals
refused (all were declined, so the post-answer board is unchanged)") holds; 309 is the direct-settlement class the
design's probe (§6 "BuyPrivateCompany during the Stock Round") predicted, on a different index. The other sixteen
files match the design's "no gameplay change" prediction.

**No golden, replay or corpus expectation was re-baselined.** `RULES_ENGINE_VERSION` is still 4;
`SUPPORTED_RULES_ENGINE_VERSIONS` untouched.

---

## 18. UI parity — Part C, tracking only

No frontend component was changed. The four existing items are annotated (not duplicated):

| Item | Batch 7.4 outcome | Classification (unchanged) |
|---|---|---|
| U-19 player ↔ player private sale | the engine half exists (three messages, `private_trade_offer`, `privateTradeRefusal` at both locks); no initiation, prompt, price entry, answer, rescind or pending line in the frontend; the prompt must go to `tradeCounterparty(offer)`; Rules Reference needs §3.1's sentence and D-26/D-27 | NEW ACTION + STATE VISIBILITY + RULES REFERENCE |
| U-20 ordinary corporation private purchase | `privatePurchaseRefusal` exists and is answered at ingress; the panel still computes availability locally; `RescindPrivatePurchase` has no control; the answer control must be shown to `currentPrivateOwner` | LEGALITY SYNC + NEW ACTION + STATE VISIBILITY |
| U-21 voluntary train sale / rescission | `trainSaleRefusal` exists; `RescindTrainPurchase` must be what the withdraw dispatches; the chain-era `TrainTradePanel` controls are now refused on pinned boards and must be retired from room play; the prompt must go to `sellerPresident` | LEGALITY SYNC + NEW ACTION + STATE VISIBILITY |
| U-22 pending-offer hold / state visibility | `pendingOfferBlock`, `standingOrdinaryOffer`, `describeStandingOffer` exist; held controls are refused at ingress with the sentence rather than disabled; the accepted-awaiting-settlement state is momentary on the server path | STATE VISIBILITY |

Every new ingress refusal this batch adds is answered with a sentence (S10-1), which is what makes each of these
STATE VISIBILITY rather than a silent no-op; nothing here is NONE. The narration layer (`actionLog.ts`) has no
sentence for the five new messages yet and falls through to `null` (no throw) — folded into U-19 / U-21 rather than
filed as a new item, because the sentences belong with the controls.

---

## 19. Ambiguities, interactions and judgement calls

**(a) Rescinding an accepted-but-unsettled offer — allowed, on the design's wording.** §7.6's hold says the
rescission passes "while an ordinary offer stands — whether awaiting an answer or `accepted` and awaiting its
derived settlement". I read that as the proposer being able to withdraw in both states and implemented it so. In
play it is unreachable on the server path (the settlement is derived in the same burst as the acceptance) and a
race on the Firestore path is harmless (a rescind that lands first leaves the derived settlement with no offer and
no consent, so it refuses by identity and retires nothing). It is also the one exit short of `RevertTo` from the
residual in (b). If the owner prefers "an accepted offer is a contract", it is a two-line change in
`passesOfferHold` and the two rescission predicates.

**(b) A residual in the `emitted` key, kept rather than redesigned — SUPERSEDED by §20.** *(The residual described
below was not a residual: Opus reached it through legal play (R74-B) and it is repaired by the offer instance
identity. Kept as written for the record.)* `nextDerivedAction`'s `emitted` guard is
consulted for the accepted-offer keys as it always was (the shell's Firestore-path effect depends on it, and
`App.tsx` is not this batch's to touch). Because every settlement outcome now retires the offer, the guard is
redundant on the server path — except in one sequence: a settlement refused and retired (unreachable in play under
the hold, since proposal, answer and settlement all judge the same board), followed by an IDENTICAL re-proposal of
the same private / owner / buyer / price in the same server lifetime, which would be accepted and then not derived
until a restart or a `RevertTo` — or, now, a rescind (a). The train key has the same residual (it counts the buyer's
fleet, which a refused settlement does not change). The clean fix is a log-derived nonce on the offer or dropping the
`emitted` consultation for offer keys on the server path; both touch the shell's contract, so they are flagged rather
than made.

**(c) Two holds a fixture can make deadlock each other, deliberately not exempted.** A board carrying an ordinary
offer AND an owed discard (or an owed home token) refuses the discard through the offer hold and the answer through
the discard hold; only `RevertTo` passes both. No legal message sequence reaches such a board (each hold refuses the
other's cause from arising), so no exemption was added to the design's closed list; the alternative — letting
`DiscardTrain` / `PlaceHomeStation` through the offer hold — is a one-line change if the owner wants belt and braces.

**(d) While a D-6 train offer stands, the emergency exits are frozen.** The forced `SellStock`,
`EmergencyBuyHardware`, `OfferPrivateForFunding` and `DeclareBankruptcy` are refused until the seller answers or the
president withdraws. This is D-19/Q6 applied to the one place the two holds overlap; the president always has the
rescission, so nothing is stuck. Stated so it is not mistaken for a regression of D-5/D-6.

**(e) A duplicate answer to an ACCEPTED offer is now refused at ingress with the hold's sentence** rather than
answered `null` as #662's "harmless duplicate". The reducer still treats it as nothing to do (identity). On the server
path the accepted state lasts one burst, so a client can only meet it by racing; the sentence ("accepted and
awaiting settlement; nothing else can happen until it settles") is accurate when it does.

**(f) `null` actor skips consent (#549b).** A `BuyPrivateCompany` / `BuyTrainFromCorporation` applied with no actor
(a fixture, solo play) is judged on every rule but consent, exactly as 7.2's stock predicates skip the rules that are
about a player. Every server entry and every replay entry carries its author, so the reducer's consent rule is live
wherever a hostile client can reach it.

**(g) The offer field as `null` versus absent** is the only trace 7.4 leaves on FCJ 146–308: the old engine wrote
`train_purchase_offer: null` when it cleared an offer; a refused proposal never writes the field. `stateDigest`
distinguishes the two, so the sweep reports them; nothing gameplay-visible differs and no golden is affected.

**(h) Not done, by instruction.** Batch 7.5 (the version bump, the corpus sweep as a ledger row, the re-pins); the
exhaustive ±one-fact matrix (Opus); every Part C UI item; Stage 8; any change to `App.tsx` or `components/`.

---

## 20. Follow-up — the Opus matrix's R74-B core blocker and O1, repaired (2026-09-15)

Input: `claude/batch7.4-opus-matrix-review-2026-09-15.md` (325 cases in six `offerMatrix74*` suites plus the
support harness; all seven files kept, none discarded). Owner rulings: fix R74-B robustly; fix O1 in the same
derived-action / de-duplication follow-up; O2 / O4 / O6 not widened into; the Stage-9 preprinted-track item
recorded and not implemented. Still uncommitted; `RULES_ENGINE_VERSION` still 4; nothing re-pinned; the full Jest
suite not run; no owner UI / audio / visual-flourish file touched.

### 20a. R74-B — root cause and the fix (#1597)

**Root cause.** `nextDerivedAction` de-duplicated the derived train settlement by
`offer:train:<seller>:<model>:<buyer>:<buyer's owned_trains.length>`, on the reasoning that a fleet grows by one
per trade. It does not: rust (the buyer's own depot purchase, or another corporation's), an intercorporate sale, a
discard as one step of a chain, and rust followed by a purchase all bring the count back to a value already
settled. A later, distinct, legal offer between the same seller and buyer for the same model then derived a key the
room's in-memory `emitted` set already held, `settleOwed` derived nothing, and the accepted offer stood under the
§4 hold with no legal exit (B.1–B.4, B.5b; B.2 at an identical price, so a price-widened key was never a fix).

**The identity is the offer's lifecycle, not its transaction.** Three writes, one reader:

| Where | What |
|---|---|
| `GameStateResponse.offer_serial?: number` | the instance id of the most recent ordinary offer this board has carried; absent = none yet (#232). Written by the three proposal arms and nothing else; never decremented, never cleared by an answer, a rescission, a settlement, a turn end or a round end |
| `PrivatePurchaseOffer.instance` / `TrainPurchaseOffer.instance` / `PrivateTradeOffer.instance` | the offer's own number, `offer_serial`'s value at the moment the arm wrote it |
| `pendingOfferHold.allocateOfferInstance(state)` | `{ instance: (offer_serial ?? 0) + 1, offer_serial: instance }`, spread by `ProposePrivatePurchase`, `ProposeTrainPurchase` and `ProposePrivateTrade` after the core has judged the proposal (a refused proposal writes nothing, so a refusal spends no number) |
| `derivedActions.privateOfferKey` / `trainOfferKey` | `offer:private:<instance>` / `offer:train:<instance>` — the derived settlement's key and nothing else. An offer with no number (only a fixture writes one by hand) keys on its transaction, so such a board still settles once per engine lifetime |

One shared counter for all three ordinary kinds (the trade is numbered too, although it is never derived), because
"which offer is this" is one question however the offer is shaped. The Batch-5 funding offer is not an ordinary
offer, is never derived, and takes no number — D-5 / D-6 semantics untouched (the whole `emergencyFunding` suite
passes unchanged, and §15 pins that a funding offer leaves `offer_serial` absent).

**Determinism.** The number is a function of the log like every other field: a replay assigns the same numbers in
the same order; `RevertTo` rebuilds without the reverted offers and their numbers (no undo code exists or was
added); a restart recomputes the guard from the surviving log (#1208, through `derivedEntryKey` below). No UUID, no
clock, no server-side sequence, no hidden state, no property that can cycle back. Two later offers identical in
every game property are two instances; the same offer re-derived after a `RevertTo` past its settlement is the
same instance on a rebuilt engine whose set is fresh (#1233) — which is exactly the exactly-once property.

**Exactly-once, re-proved on the new key.** One acceptance → one derived settlement (§12 room / replay / rebuild /
duplicated entry, unchanged and passing); repeated `settleOwed` pays nothing twice; a refused stale settlement
retires the offer and is not re-derived (§11, all 22 rows); a later offer is a later instance and is never
suppressed by a completed one (§14 B.1–B.8, §15). The shell's Firestore-path guard (`acceptedOfferSentRef` in
`App.tsx`) consumes the key opaquely and needed no change.

### 20b. B.1–B.4, B.5b after the repair; B.8 the strongest minimal regression

Every case keeps Opus's exact legal room sequence and now asserts, through `expectSettledOnce`: the acceptance's
burst begins `[AnswerTrainPurchase, BuyTrainFromCorporation*]` and carries exactly one settlement; the offer is
retired; the room's guard holds the offer's own instance key; the log holds the expected number of settlements; the
hold is released (`pendingOfferBlock` null); and a fresh loop and the room's loop owe no settlement. Each case also
computes the PRE-repair tuple beside the real key to show the collision that used to happen:

| Case | Instances (first → second) | Old tuple | Money / fleet after |
|---|---|---|---|
| B.1 same turn, rust by own depot purchase | 1 → 2 | `offer:train:2:3:1:2` both times | PRR [3, 4, 3], $430; NYC [], $670; conserved |
| B.2 identical $150, buyer's own sale between | 1 → 3 (C&O's offer is 2) | identical, same price | PRR [3, 3]; `offer_serial` 3 |
| B.3 rust by another corporation's first 4 | 1 → 2 | identical | PRR [3, 3] |
| B.4 rust, then a depot purchase restores the count | 1 → 2 | identical | PRR [3, 4, 3] |
| B.5b a discard in the chain, then a sale | 1 → 3 (C&O's is 2) | identical, same price | PRR three trains |
| **B.8 (new)** same seller, model, buyer, fleet size AND price, same turn | 1 → 2 | `(NYC, 3, PRR, fleet 2, $150)` recurs exactly | paid once (PRR −150, NYC +150), two settlement entries, guard `[offer:train:1, offer:train:2]` |

B.5 (a discard alone cannot restore a buyable tuple) and B.6 / B.7 (settlements always land on the acceptance's
board) keep passing; B.6 additionally pins `offer:private:1`, that the old transaction key is gone from the guard,
and that a `RevertTo` past the settlement restores instance 1 and settles it again on the fresh set.

### 20c. §15 — replay, `RevertTo` and rebuild reproduce the identity

`replayLog` of `[propose, accept, settle*]` twice: identical digests, `offer_serial` 1, offer null, card the
corporation's; the proposal alone: instance 1 pending, key `offer:private:1`. `[…, RevertTo 0]`: no offer, no
`offer_serial` field, digest-equal to the empty log. `[…, RevertTo 1]`: the pending offer with instance 1,
digest-equal to a proposal-only replay. Through a room, `RevertTo 2` (keep the acceptance, drop the settlement)
re-derives the settlement under `offer:private:1`, once — two settlement entries in the raw log, one in effect,
one payment. A rejected offer (1), a rescinded one (2), a settled train offer (3) and a settled private offer (4)
in one room: `offer_serial` 4, the guard holding exactly `offer:private:4` and `offer:train:3`; two restores and a
twin room fed the same non-derived entries reproduce the digest and the numbers.

### 20d. O1 — root cause and the fix (#1598)

**Root cause.** `RoomEngine.apply` recorded `turnGuardKey(board, operating, step)` for every `derived` entry — the
right key for a skip, an end-turn and a forced withhold, and the wrong one for an accepted-offer settlement, whose
own key is the offer's and which is not a turn-progression action. A derived train settlement that filled the buyer
to its limit at Hardware therefore consumed the key the step's own `PassTurn` would use; the loop derived nothing;
the turn stayed open until the president ended it by hand — where the same fleet bought from the depot ended the
turn at once. Pre-existing (#1208 × #1247), surfaced by the matrix.

**Fix.** One function, `derivedActions.derivedEntryKey(state, msg)`, is the one answer to "what key does this
derived entry consume", used by `apply` (the replay / restore path) and matching what `settleOwed` records on the
live path: the offer's instance key for the settlement of the standing accepted offer; the turn key for any other
derived entry; nothing for a settlement that matches no standing offer (a stored proposal a later engine refused —
FCJ 147 — was never a turn's action, and recording a turn key for it would suppress a skip the rebuilt board still
owes). Computed before the arm runs, on the board `nextDerivedAction` looked at, as before. After a settlement the
loop re-asks the post-settlement board and derives whatever a depot purchase would — no "offer ⇒ End Turn" special
case anywhere.

**Convergence, pinned (§14 companion, three tests).** Offer path: `[AnswerTrainPurchase, BuyTrainFromCorporation*,
PassTurn*]`, PRR [2, 2, 2, 3], cursor `[1, "Track"]`, guard holding `offer:train:1` and `3.1.0:1:Hardware`, one
`PassTurn` in the log. Depot path: `[BuyHardwareFromPool, PassTurn*]`, the same fleet, the same cursor, the same
turn key; the two derived `PassTurn` payloads are equal and every guarded field but the money and NYC's fleet is
equal. A restore of the offer path's log records the same keys and owes nothing; a restore cut between the
settlement and the End Turn shows the settlement did NOT spend the turn key and the repair loop derives the End
Turn once. A private purchase at Hardware records `offer:private:1`, leaves the turn key alone, and the president
ends the turn by hand as before. Consequences elsewhere: R74-B.5's and B.7's limit-filling acceptances now end the
turn automatically (both re-pinned with the reason); `emergencyFunding`'s D-6 room cases pass unchanged.

### 20e. Corpus — this repair only, measured against the pre-repair 7.4 tree

Both trees compiled with `server/tsconfig.json` to directories outside the repository (the pre-repair tree is a
copy with exactly this follow-up's edits reversed); every corpus file replayed through both under
`DEVELOPMENT_CORPUS_POLICY`, `stateDigest` + `fieldDigests` + `moneyTotal` + the bank captured before every applied
entry and at the end. Throw-away probes outside the repository.

| File | Result |
|---|---|
| fifteen of seventeen — `golden/7NZ`, `golden/CV4`, `golden/G6J`, `server/7NZ`, `server/8E8`, `server/CV4`, `server/FCJ`, `server/G6J`, `server/TQQ`, `server/Z6C`, `export/3XD`, `export/CV4`, `export/JJD`, `export/Y8V`, `prefix/FCJ-96` | digest-identical at every entry and at the end |
| **`server/JUNO-CW7`** | first difference **idx 122** (`AnswerTrainPurchase`; the board after the stored `ProposeTrainPurchase` at 121): fields `offer_serial` (absent → 1) and `train_purchase_offer` (`instance: 1` added to B&M ← B&O's 2-train at $10); at 123 (`PassTurn`) and the final board only `offer_serial` differs (the offer is null on both sides). Nothing else: applied 118 / 118, dropped 6 / 6, money 20,000 / 20,000, bank identical |
| **`export/JUNO-QVC`** | first difference **idx 60** (`AnswerTrainPurchase`; the proposal at 59): the same two fields (PRR ← B&O's 2-train at $80, `instance: 1`); 82 (the derived `BuyTrainFromCorporation`) the same two; 83–92 and the final board `offer_serial` only. Applied 70 / 70, dropped 23 / 23, money 12,000 / 12,000, bank identical |
| `server/JUNO-FCJ` | **no difference** — its four stored proposals (145, 205, 232, 273) are refused by 7.4, so no number is ever assigned |

So the only trace this repair leaves on the corpus is the deterministic offer-instance field on the two rooms whose
stored proposals 7.4 still applies — the case the owner asked to be reported precisely. No gameplay, count, money
or bank difference anywhere. O1 leaves no corpus trace (replay applies; only `settleOwed` after a restore changes,
and no stored log ends between a limit-filling settlement and its End Turn). **Nothing re-pinned; version still
4;** the field joins the digest under the already-owed Batch-7 version 4 → 5 bump (7.5). Part E's 7.4 row carries
this as a follow-up note.

### 20f. O2 / O4 / O6 dispositions (owner rulings, recorded in the ledger)

- **O2** (unattributed duplicate train settlement takes a second train): NOT eliminated by the instance identity —
  it is an arm-level consent gap for a `null` actor (#549b), not a derived-key one — and not fixed here.
  Filed as **S10-20** for derived / ingress hardening; Opus's "residual #549b" test keeps pinning it as a decision.
- **O4** (a private's owner changing before the answer): unreachable in play under the hold; characterization only,
  recorded under S7-21; no fix.
- **O6** (ingress does not mirror the home-token hold; a held proposal is logged and no-op'd): not fixed in 7.4;
  filed as **S8-12** and cross-referenced to S8-5 / S8-6 so ingress and reducer are repaired together in Stage 8.

### 20g. Stage-9 backlog addition — S9-10 (not implemented; wording corrected in §21d)

**S9-10** was first filed from the visual-flourish VF-5 work as "preprinted-track preservation": today's placement
preservation protects track from an already-laid tile, so expanded / LPF Baltimore can be offered #53 / #592 facings
that cut track printed on the underlying board hex. The generalised invariant first written here ("every mandatory
board-printed connection must be preserved, as on a replaced laid tile") was too broad for the full expanded / LPF
tile rules and is **superseded** by the owner-ruled wording recorded in §21d and in the backlog entry itself
(authoritative tile-upgrade topology preservation). No VF-5 or visual-flourish code touched.

### 20h. Files changed by the follow-up

| File | What |
|---|---|
| `gameEngine/gameState.ts` | `offer_serial?` on the board (#1597 note); `instance?` on the three ordinary offer shapes |
| `gameEngine/pendingOfferHold.ts` | `allocateOfferInstance` |
| `gameEngine/sandboxSession.ts` | the three proposal arms spread `{ offer_serial, <offer>.instance }`; import |
| `gameEngine/derivedActions.ts` | `privateOfferKey`, `trainOfferKey` (instance keys, unnumbered fallback), `derivedEntryKey` (#1598); the #1247 / #1596 notes rewritten around #1597 |
| `gameEngine/replayLog.ts` | `apply` records `derivedEntryKey` for a derived entry (two now-unused imports removed) |
| `utils/offerMatrix74Settlement.test.ts` (Opus, kept) | header rewritten as "repaired"; §13 one assertion; §14 B.1–B.7 flipped to settle-once with the old tuple computed beside the instance key; **B.8** added; **§15** added (5); the §14 companion rewritten as O1 convergence (3) — 39 → 47 cases |
| `utils/offerMatrix74{Hold,PrivatePurchase,PrivateTrade,ReplaySchema,TrainSale}.test.ts` (Opus, kept) | 21 assertions adjusted with `// #1597`: recorded offers carry `instance: 1`; `differing(<pre-offer board>, …)` lists include `offer_serial`; each release / settlement row additionally pins `differing(<offered>, …)` is the offer field alone |
| `utils/offerAuthority.test.ts`, `utils/shellMessageArms.test.ts` | `backToBefore` tolerates and pins `offer_serial`; recorded offers carry `instance: 1` |
| `RULES_HARDENING_BACKLOG.md` | S7-21, S7-22 (`RESOLVED`); S8-12, S9-10, S10-20 (`OPEN`); Part E 7.4 row follow-up note |
| this report | §20; §13 lock 3 and §19(b) annotated |

### 20i. Validation (focused only; the full Jest suite was NOT run)

| Check | Result |
|---|---|
| Opus `offerMatrix74*` (6 suites) | **333 / 333** (325 + 8: B.8, §15 ×5, the companion's 1 → 3) |
| `offerAuthority`, `emergencyFunding`, `shellMessageArms`, `turnAuthority`, `messageSchema`, `refusalAtomicity` | 138 / 138 |
| `derivedActions`, `roomSession`, `logRevert`, `replayEquivalence`, `replayAttribution`, `operatingCursorReplay`, `stateDigest`, `serverProtocol` | 114 / 114 |
| `trainLifecycle`, `trainDiscard`, `emergencyTrainFlow`, `levelPlayingFieldRules`, `baltimorePrivate`, `turnGateSource`, `divergenceWatch` | 113 / 113 |
| `replayJunoCV4`, `privateOffer`, `trainOffer`, `privateOfferRow`, `privatePowerOffer`, `rulesVersion`, `atomicReducer`, `gameSetup`, `moneyConservation` | 142 / 143 — the one failure is the corpus case stale since 7.3 (Z6C 203 `YellowSignEvent`) |
| `replayGolden`, `replayJuno3XD`, `gameHistory`, `roundReplay`, `logExport`, `bankBreakLatch` | 48 / 57 — the nine failures are exactly §16d's stale cases |
| auction / stock / private / shell suites of §16c (28 suites) | 626 / 626 |
| **Total** | **70 suites, 1,524 tests, 1,514 passing; the 10 failures are §16d's stale set, unchanged in number** |
| `tsc --noEmit -p frontend/tsconfig.json` (includes every test) | clean |
| `tsc --noEmit -p server/tsconfig.json` | clean |
| `eslint` on every file touched | identical to the baseline (`sandboxSession.ts` 1 pre-existing error + 3 warnings; `derivedActions.ts` / `replayLog.ts` pre-existing unused-import warnings; `shellMessageArms.test.ts` pre-existing `import/first`); the two imports this follow-up made redundant in `replayLog.ts` were removed |
| static: writers of `offer_serial` | the three proposal arms only |
| static: readers of `instance` for authority | none — only the two key builders read it; no predicate, hold or arm consults it |
| static: the old tuple key shape | gone from non-test code; computed in tests only as the collision witness |
| static: `emitted.add` sites | `apply` (via `derivedEntryKey`) and `settleOwed` (`next.key`) — the same string for the same entry |

### 20j. Ambiguities and judgement calls

**(a) `differing(<pre-offer board>, <released board>)` now lists `offer_serial`.** Eight Opus assertions and
`offerAuthority`'s `backToBefore` said a rescission or rejection leaves "the board before the offer" differing by
the offer field alone. A lifecycle identity is exactly a record that the offer happened, so those assertions were
adjusted (each with the reason in place) and each now ALSO pins that the release differs from the offered board by
the offer field alone — the mutation claim they were making. Not re-pins: none reads a stored log.

**(b) The unnumbered fallback.** An accepted offer with no `instance` (only a hand-written fixture can produce one;
`refusalAtomicity` and `emergencyFunding` have two) keys on its transaction, so such a board settles once per engine
lifetime as it always did. No arm-written board reaches it; noted so it is not mistaken for a second identity scheme.

**(c) A derived settlement that matches no standing offer records no key.** Under the old rule it consumed the
turn key; under #1598 it consumes nothing. Reachable only from stored logs whose proposal a later engine refuses
(FCJ 147). Replay is unaffected (apply never consults the guard); a restore of such a log then owes whatever the
rebuilt board owes, which is the point of #1208. No corpus test restores FCJ past 96.

**(d) The trade is numbered although it is never derived.** One counter for all three kinds was preferred to two
schemes; the number is inert for the trade today and is what a future derived trade settlement would key on.

**(e) O2 was not eliminated as a side effect** (20f) and is deliberately not fixed here.

**(f) The design's "same-price collision" ruling** made B.2 / B.5b / B.8 the load-bearing proofs: each computes the
old tuple beside the instance key and shows the tuple identical and the keys distinct.

---

## 21. Final Opus verification, owner rulings and commit (2026-09-16)

Input: `claude/batch7.4-opus-final-verification-2026-09-16.md`. A short verification pass over the §20 repair — no
redesign, no 7.5 work, no version bump, no re-pin, full Jest not run.

### 21a. Result

| Item | Result |
|---|---|
| R74-B | **Repaired** — deterministic, replayable offer-instance identity (`offer_serial` on the board, `instance` on each ordinary offer, key `offer:<kind>:<instance>`). Every live proposal path (private purchase, train purchase, player trade) assigns an instance; nothing else writes `offer_serial`; funding offers take none; legacy fallback keys always carry `unnumbered:` and never collide with or suppress a numbered key |
| O1 | **Repaired** — `derivedEntryKey` records the offer key for a settlement and the turn key otherwise; limit-filling settlements end the turn exactly once, non-filling ones force nothing; restore before / after End Turn derives it once / never |
| Opus matrix (`offerMatrix74*`, 6 suites + support) | **333 / 333** |
| Final verification suite `utils/offerVerify74Final.test.ts` (new, test-only) | **12 / 12** — RevertTo alternate history (train different / identical, private), serial lifecycle across refusal / rejection / rescission / settlement / turn / round / trade-in-answer, payload cannot choose the number, legacy fallback containment, O1 controls, live key == replay key, unmatched settlement records nothing, and a source pin of the shell reset below |
| Server `RevertTo` alternate history | **Clean** — `RoomSession.rebuild()` constructs a fresh `RoomEngine`; no discarded-future `offer:<kind>:N` survives; the divergent offer that reuses N settles once; two restores agree |
| Unmatched settlement / O2 | Every server-derived settlement matches its standing offer; O2 remains unreachable (server entries always carry an actor) and stays filed as S10-20 |
| Engine corrections after the §20 repair | **None** |

### 21b. The one fix — shell / rebuild dedupe lifecycle (not a rules change)

`acceptedOfferSentRef` in `App.tsx` is the no-server (Firestore) path's client-side dedupe cache for the accepted-offer
settlement it dispatches; it is not rules authority. `rebuildSandbox` — the undo / rewind rebuild — already reset the
auto-skip and forced-withhold caches (#887) but not this one. Because offer instances are log-derived, a history that
diverges after an undo reuses an instance number that browser had already sent, and the stale cache entry would have
suppressed the new accepted offer's settlement under the pending-offer hold until a reload. Fix (owner-accepted): one
line, `acceptedOfferSentRef.current = new Set();`, beside the other two resets, with its comment — the client twin of
the server's fresh-engine rebuild (#1233). Only that hunk of `App.tsx` is in the Batch 7.4 commit; the file's other
working-tree changes are unrelated owner work and remain uncommitted.

### 21c. Discipline

`RULES_ENGINE_VERSION` remains **4** pending Batch 7.5. Corpus / golden expectations remain deliberately stale and
un-repinned (the ten §16d cases, unchanged in number). The fix touches no engine file, so the §20e corpus report
stands without a new sweep.

### 21d. S9-10 wording corrected (documentation only)

The full 48-page 1830 rulebook with the expanded / LPF tile sets showed the first S9-10 wording was too broad. The
backlog entry is now *authoritative tile-upgrade topology preservation*: universal preservation of required
pre-existing track, of track printed on the board hex, of station / token connectivity, and membership of a
rules-legal upgrade transition; topology-changing rules are per upgrade family (fixed OO #59 keeps its two systems
unconnected; Variable OO Cities not enabled; explicitly legal expanded / LPF changes such as two small cities → one
remain legal; no blanket "never merge"; no legality from geometry or the current filter). Old 18xx tile numbers in
project-facing text. Stage 9 begins with a manifest / catalog audit before touching `preservesRouting`. The audit row
"Upgrade preserves all segments and stations" (`AUDIT_RULES_TO_MACHINE_2026-09-13.md` §F) is re-annotated from PASS
to PARTIAL with a pointer to S9-10. Nothing implemented; no tile tests.
