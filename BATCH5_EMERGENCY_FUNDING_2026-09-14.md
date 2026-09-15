# Batch 5 — Emergency funding, forced share sales, bankruptcy and immediate game end

Date: 2026-09-14. Design note **#1540**. Baseline (post-Batch-4.6, user-validated, `6d55b84`): 353 suites / 5466 tests.
Not committed: awaiting the full-suite result.

> **`RULES_ENGINE_VERSION` 2 → 3.** Version 3 makes the forced train purchase an interactive, derived obligation:
> authoritative president contribution, forced `SellStock` under §6.6.3, the emergency private sale as a
> seller-initiated directed offer (`OfferPrivateForFunding` / `AnswerFundingPrivateOffer` /
> `RescindFundingPrivateOffer`), bankruptcy derived when nothing can be sold or declared (`DeclareBankruptcy`) when
> only an optional private sale remains, the game ended at once, the bankrupt player scored by §6.6.3 and ranked
> with everybody, an owner-defined simplification of the intercorporate trade under the obligation, and a hold on
> ordinary play while the obligation stands and after the end. A version-2 log is refused before replay.
>
> **Owner-defined digital simplification (deviation from the 2018 rulebook):** §6.6.3's nested case — a train
> bought from another railroad that the president must then fund by selling shares, with the seller-presidency
> change/veto/unwind — is deliberately not implemented. While a forced purchase is owed, an intercorporate train
> purchase by the rescued corporation is permitted only when its treasury plus its president's currently available
> cash covers the agreed price (treasury first, the president the rest; §6.6.2's face-value cap applies whenever the
> president contributes). If completing it would need any share or private sale, that path is refused and the
> obligation is resolved through the Bank / Bank Pool.

## 1. The rulebook sequence implemented (1830-RE 2018, Lookout; verified before coding)

Quoted from `en_1830re.html_Rules_1830-RE_EN.pdf` (Lookout's copy — identical filename to yours):

1. **When it begins** — §6.6.2: *"If a railroad with a legal train route has no train at the end of its operating
   turn, it must immediately purchase a train."* Implemented as: Buy Trains step, operating corporation trainless
   with a legal route (`trainObligationFor`, Batch 4), a train for sale, and a treasury below its price.
2. **Which train** — §6.6.2: *"the railroad must purchase the cheapest train available"* (railroad alone, or railroad
   + president). The required train is Batch 4's `cheapestPurchasableTrain` (depot or Bank Pool, pool wins a tie);
   a train from another railroad is the voluntary first sentence (*"may purchase … from another railroad using the
   normal rules"*), never the mandatory source.
3. **The corporation's money** — §6.6.2: *"All of the railroad's money must be spent."*
4. **The president's money** — §6.6.2: *"the president must then make up the difference using his own money."*
   §6.6.3: *"both the railroad and its president put aside all of their money"* before any sale. So the president
   contributes `cost − treasury`, capped by cash; the shortfall is `cost − treasury − cash`.
5. **When shares are sold** — §6.6.3: *"Then the president must sell his shares and/or private companies until he
   raises enough additional money"*; §6.7 the same. Only while the shortfall is positive.
6. **Private companies** — §6.6.3: *"The president may sell private companies he owns (if he can find a buyer), but
   he is not required to do so."* Ordinary rules: §3.0 *"During phases 3 and 4, a railroad may buy a private company
   at any time during its turn in an operating round"*; §3.1 *"The price paid may not be less than half or more than
   twice the face value of the company and must be publicly declared"*; *"Private companies may be bought by railroad
   corporations but not sold by them."* See §6 below for what §6.6.3 does and does not override.
7. **Restrictions on the sales** — §6.6.3: *"The president may only sell enough shares to be able to make the forced
   purchase"*; ordinary §5.1 rules otherwise (pool cap, president's certificate, one row per share sold).
8. **The rescued corporation** — §6.6.3: *"The share sales may not cause a change in the presidency of the railroad
   that is without a train."*
9. **Other corporations** — §6.6.3: *"Any changes of president caused by share sales take place immediately."*
10. **When selling stops** — when treasury + cash ≥ price (*"until he raises enough"*); the last certificate may
    overshoot and nothing is truncated (indivisible certificates; the rulebook never says otherwise).
11. **Bankruptcy** — §6.7: *"If there is not enough money after the president sells all of his shares that he is
    allowed to, he goes bankrupt and the game ends."*
12. **Immediately upon bankruptcy** — the game ends (§6.7); no next Stock Round, no rest of the OR.
13. **Final value** — §6.6.3: *"The bankrupt president's final score (i.e., wealth) is the value of all of the shares
    that he could not sell. It is possible, but unlikely, that a bankrupt player can win."*

**Audit assumptions checked:** all nine hold against the rulebook (president chooses what/order; sales move prices
and change later legality; other presidencies change immediately; rescued presidency protected; only enough;
indivisible last certificate may overshoot; proceeds not truncated; immediate end; bankrupt may win). No conflict.

## 2. Reconstruction of the pre-batch architecture

- **Client** (`App.tsx` `emergencyPurchasePlan` → `buildEmergencyPurchasePlan` → `resolveEmergencyFunding` +
  `sellableHoldings`, `endgame.ts`): a static cascade summing cash plus a ceiling of sellable proceeds, with
  `bankrupt = maxRaisable < cost` decided once from that snapshot, the rescued corporation's shares excluded
  wholesale, prices from the client's chart. `noDecisionRemains` forced the modal open; the Game Over modal's
  "bankruptcy" reason and `bankruptAddress` came from that client plan. The reducer never recorded an ending.
- **Reducer** (`EmergencyBuyHardware` arm): required train `cheapestPurchasableTrain`; treasury pays all; the
  president pays `cost − treasury` through the treasury; refused by identity when cash was short (Batch 4). The core
  gate only asked `trainPurchaseRefusal(requireFunds:false)` — step, operating corporation, limit — **not whether a
  forced purchase was owed**, so a president could fund a voluntary purchase with personal cash.
- **Money path**: `adjustCash(president, −shortfall)` → `adjustTreasury(+shortfall)` → `buyDepotTrain`:
  `adjustTreasury(−cost)`, `adjustBank(+cost)`. Conserved; the zero floor was never reached because of the refusal.
- **Client-trusted fields**: none — the message carries only `protocol_id`; the train and price are the authority's.
- **Ordinary sale**: `SellStock {protocol_id, percentage}` → `shareSaleBlock` (holding, double certificate, pool
  50%, president's block needs a ≥20% successor) → proceeds = price × certificates at the pre-drop price → cash/bank
  move, shares to the pool, `settlePresidencies` (strictly more; ties keep the incumbent), token drops one row per
  certificate (`projectSale`), `sold_this_round` lock. **Reusable as-is** for forced sales.

## 3. State-machine design (exact)

`gameEngine/emergencyFunding.ts`, all derived, nothing persisted while the obligation stands:

```
emergencyFundingFor(state, grid) → null | {
  companyId, ticker, president,            // the operating corporation and its president
  train: cheapestPurchasableTrain(state),  // the ONE required train (#1512)
  treasury, presidentCash,
  shortfall = max(0, cost − treasury − presidentCash),
  canPurchase = shortfall === 0,
  legalSales: legalForcedSales(...),       // every legal bundle, corporation by corporation, judged on the current board
  bankrupt = shortfall > 0 && legalSales.length === 0
}
```
Conditions: OperatingRound, Buy Trains step, `trainObligationFor(...).owed === true` (needs the grid; without one no
opinion, #757), a train for sale, treasury < price. Recomputed after every real action, so a sale that moved a
price or a presidency changes the next answer by itself. "Resume" needs nothing: the cursor never moved.

**Bankruptcy** is derived (no `DeclareBankruptcy` message): `settleBankruptcy` runs at the end of the settle chain
and, when `bankrupt` holds, writes `current_round_type: "GameEnd"`, `bankrupt_president`, clears the sub-phase.
Reached in the same transition as the action that made it unavoidable (entering Buy Trains with nothing to sell;
the last legal sale). Undone by `RevertTo` past that action, because it is a function of the board.

## 4. President cash

Authoritative in the reducer: the corporation spends all its money, the president pays `cost − treasury`, only when
`canPurchase` (treasury + cash ≥ price) and only when a forced purchase is owed (`emergencyPurchaseRefusal`: owed;
right corporation; the president as the entry's actor; funded). A client cannot under-contribute (the amount is
computed, not sent) or manufacture money (refused by identity; conservation tests 1, 2, 3, 4, 6, 17 assert the sum
of bank + every cash + every treasury before and after).

## 5. Forced-sale mechanics

The ordinary `SellStock` message in an **emergency mode derived from state** (never a client flag). While the
obligation stands the reducer asks `forcedSaleRefusal` in three places — the core (identity refusal), the market step
(`saleRefused`, so no token moves for a refused sale), and the ingress — with these rules on top of `shareSaleBlock`:
(a) only the rescued corporation's president; (b) no sale once `shortfall === 0`; (c) a sale of the rescued
corporation's shares is refused if `presidentFor` (the same rule every change uses, #596) would name a different
president — otherwise its shares may be sold (the old plan forbade them outright); (d) only enough: a bundle is
refused when one certificate fewer already covers the shortfall, so the last certificate may overshoot and its full
proceeds are kept. Price movement, the pool ceiling, the double certificate and presidency changes in other
corporations are the ordinary arm's, unchanged. Why reuse: the message and the arm are the same physical act; the
mode is a fact about the board, so ordinary Stock Round semantics cannot become ambiguous (no obligation → no mode).

## 6. Private companies — the emergency sale (owner decision, design note #1541)

**What the rulebook says and does not say.** §6.6.3 permits the sale "if he can find a buyer" and makes it optional;
it does not state which of §3.0/§3.1's restrictions are relaxed. Read literally, the only railroad "in its turn" is
the one without money, which has "put aside all of [its] money" — so a buyer could never be found. **Owner
decision, recorded as such:** the buyer's own-turn timing is relaxed (any eligible corporation may buy, its
president answering off-turn); every other ordinary restriction stands because §6.6.3 gives no reason to drop it:
phases 3 and 4 only (`privatePurchasePhaseOpen`); half to twice face value (`privatePriceBounds`, now in
`gameEngine/privatePriceBand.ts`, re-exported by the trade panel so the two cannot disagree); the buyer pays from
its treasury and must hold the price; the B&O private is never sold to a corporation; a corporation never resells;
the rescued corporation itself is not a buyer (its money is put aside). **Ambiguity reported, not resolved by
guess:** whether §6.6.3 meant to open the sale outside phases 3–4 or outside the price band is not written; both
are kept as printed.

**Shape.** `OfferPrivateForFunding {private_id, buyer_protocol_id, price}` by the obligated president →
`AnswerFundingPrivateOffer {private_id, accept}` by the *buying* corporation's president (off-turn, consent-answer
family) → on accept, `transferPrivateToCorporation` (the one transfer the ordinary `BuyPrivateCompany` uses):
treasury to player, private to the corporation for good, and the shortfall is re-read. `RescindFundingPrivateOffer`
by the seller withdraws. The offer is the ordinary `private_purchase_offer` marked `funding: true`, so the ordinary
`AnswerPrivatePurchase` cannot settle it (reducer and authority both refuse). While an offer is outstanding
*everything* else is held — sales, the purchase, the turn, a second offer, the declaration — so the answer is
given on the board the offer was made on.

**Settlement-time revalidation (the proposal is not a reservation).** `AnswerFundingPrivateOffer {accept: true}`
does not trust anything that was true when the offer was made. `fundingPrivateAnswerRefusal` re-derives the
obligation on the current board (it needs the map grid and fails closed without one — no grid, no acceptance) and
runs the same `fundingPrivateSaleRefusal` the offer itself passed: the obligation still stands with a shortfall;
the private still belongs to the obligated president, is still open and is still transferable (the B&O private
never is); the buyer is still a floated, presided corporation that is not the rescued one; the phase is still 3 or
4; the price is still within half–twice face; the buyer's treasury still covers the whole price; and the answer
comes from the buyer's *current* president. `transferPrivateToCorporation` itself checks only the B&O ban and
owner idempotency (and `adjustTreasury` floors at zero), so the revalidation in front of it is what guarantees
legality at settlement — a refused acceptance returns the state by identity and moves no money. The freeze makes a
changed board unreachable in play; the authority does not rely on that, and the test mutates the board under an
outstanding offer eleven ways to prove each check bites.

**Optional, never forced.** No private is ever liquidated for the president and none is a precondition of
bankruptcy. Because a buyer may exist and only the president can ask, bankruptcy is *derived* only when no legal
share sale remains **and** no eligible buyer exists (`legalPrivateSales` empty); when a private could still be
offered the president may `DeclareBankruptcy` instead — refused, always, while any legal share sale stands, while
the purchase is already funded, or while an offer is outstanding, and only by the obligated president.

## 7. The hold (Part 7)

`emergencyFundingBlock`: while the obligation stands, every message except `SellStock`, `EmergencyBuyHardware`, the
trade family (`BuyTrainFromCorporation`, `ProposeTrainPurchase`, `AnswerTrainPurchase`, `RescindTrainOffer` — under
the owner rule below), the funding private offer / answer / withdrawal, `DeclareBankruptcy`, `DiscardTrain`,
`CloseRoom` and `RevertTo` is refused; while a funding offer is outstanding only its answer, its withdrawal,
`CloseRoom` and `RevertTo` pass. The hold is refused — in the core (before any arm, after the discard gate) and at `turnRefusal` (with the reason, nothing
appended). After `GameEnd`, everything but `CloseRoom`/`RevertTo` is refused. `nextDerivedAction` owes nothing at
Buy Trains for a trainless corporation (existing).

## 8. Presidency protection and edge cases (Part 10)

Test 9: a two-certificate forced sale of NYC (P1 30% → 10%, P2 20%) moves NYC's presidency to P2 at once. Test 10: a
sale of the rescued corporation that would move its crown is refused with the reason; a 10% sale leaving the
president at 20% = the rival's 20% is allowed (strictly-more rule, no change), and so is any sale that keeps the
president ahead. Ties among challengers use the existing `presidentFor` (first in seating order) — untouched; it
did not block Batch 5, and remains the Stage-8 item.

## 9. Scoring (Part 9)

`rankPlayers`: the bankrupt player's net worth is the market value of the shares he still holds (cash and privates
not counted — "put aside" for the purchase; §6.6.3 names shares only); he is sorted with everybody and **the
wealthiest player wins, bankrupt or not** (#5's "the title passes to the highest non-bankrupt" is superseded). Test
19 proves a bankrupt player with the largest paper wins, and with less paper ranks below without being zeroed.

## 10. Schema, authorization, actor binding (Part 12)

Four new message types, each through the Batch-2 machinery: `OfferPrivateForFunding {game_id?, private_id int,
buyer_protocol_id int, price int}`, `AnswerFundingPrivateOffer {private_id int, accept bool}`,
`RescindFundingPrivateOffer {private_id int}`, `DeclareBankruptcy {}` — schema'd, in `GAMEPLAY_MESSAGE_KEYS` and
the type union (`GAMEPLAY_MESSAGE_KINDS` 40 → 44), classified in `turnRefusal` (offer/withdraw/declare: the
obligated president or the seller, by name, each answered with its standing; the answer: the buying corporation's
president, via the consent-answer exemption, off-turn), actor-bound by the server, and re-validated in the reducer's
core against the entry's actor. `EmergencyBuyHardware` keeps its schema (`protocol_id` only; a crafted `model_type`
is ignored — test 14). `SellStock`/`EmergencyBuyHardware` while the obligation stands are the rescued corporation's
president's only, by name; the emergency purchase's standing (owed, right corporation, funded) is answered at the
ingress with its reason.
`TurnAuthorityInput.mapGrid` is new (optional); `RoomSession.submit` passes the engine's grid. The reducer re-checks
the entry's actor (#549). The seat cursor is not widened.

## 11. Minimal UI (Part 13)

`buildEmergencyPurchasePlan` now shapes the reducer's obligation for the existing `EmergencyTrainPurchaseModal`:
corporation, required train and price, treasury/cash/shortfall, the legal certificate sales per corporation with
the reducer's own restriction sentence (e.g. "would hand its presidency…", "Only enough…"), remaining shortfall
after each real sale, and the purchase button once funded; a "Private companies … may offer" section (buyer, price within the band,
Offer), the outstanding offer with Withdraw, and a "Declare bankruptcy" button only when the engine says
`canDeclareBankruptcy`. The buying president gets `FundingPrivateOfferPrompt` (Accept/Reject, off-turn); everybody
else sees who the table is waiting on. `App.tsx` derives the plan from `emergencyFundingFor` and the ending from the
state (`GameEnd` + `bankrupt_president`) — the client no longer decides bankruptcy.

## 12. Replay / corpus effects (Part 15)

- `DEVELOPMENT_CORPUS_POLICY` and production policy unchanged; no legacy log carries the new messages.
- New deals stamp 3; a version-2 room is `incompatible {2, supported [3]}` before replay (`RoomEngine.apply` spied,
  never entered — test 22). Same-version logs with forced sales and emergency purchases rebuild identically through
  `replayLog` and `RoomSession`; `RevertTo` across a forced sale restores the exact obligation, and past the sale
  that made bankruptcy unavoidable un-ends the game (tests 20, 21).
- **Corpus sweep** (17 logs, all legacy/undealt, server policy refuses all 16 legacy): under the corpus policy
  **16/17 replay to the same digest as version 2 (`6d55b84`)**. The historical `EmergencyBuyHardware` entries
  (JUNO-FCJ ×3, JUNO-Z6C ×3, JUNO-Y8V — whose effective log is empty) replay identically: each was owed and funded,
  so no historical choice was omitted and no adapter was needed. **One differs: `server/data/JUNO-Z6C` from index
  614** — the bank had broken and the round was `GameEnd` at 613; the old engine still applied a `PassTurn` on the
  ended board, version 3 holds an ended board. Not an emergency state; no test replays Z6C; no golden expectation
  changed. `DEVELOPMENT_CORPUS_POLICY` is unchanged (still `legacyExcessTrains: "engine-chose-cheapest"` for
  Batch 4.6's discards, best-effort, development-only); production policy untouched.

## 13. Files

New: `gameEngine/emergencyFunding.ts` (#1540/#1541), `gameEngine/privatePriceBand.ts`, `utils/emergencyFunding.test.ts`
(28 tests), this file.
Modified: `sandboxSession.ts` (core hold + forced-sale and emergency-purchase gates; market-step refusal;
`settleBankruptcy` in the settle chain), `turnAuthority.ts` (second hold, owner rule, `mapGrid`),
`utils/roomSession.ts` (passes the grid), `gameState.ts` (`bankrupt_president`), `endgame.ts` (`rankPlayers`
scoring/winner), `rulesVersion.ts` (version 3 + changelog), `gameEngine/index.ts` (exports),
`components/EmergencyTrainPurchaseModal.tsx` (plan from the obligation; private-sale section; declare button),
`components/TrainPurchasePanel.tsx` (`FundingPrivateOfferPrompt`), `components/PrivateTradePanel.tsx` (re-exports the
band), `App.tsx` (plan, ending and prompts from state), `utils/sessionKey.ts`, `gameEngine/messageSchema.ts`,
`utils/actionLog.ts`, `utils/refusedAction.ts`, `utils/trainDiscard.test.ts` (version pins made symbolic),
`utils/messageSchema.test.ts` (44 kinds), `utils/trainOffer.test.ts` (6 off-turn dispatch sites). Untouched: `audio.ts`, `RulesReference.tsx`,
`rulesOverview.test.tsx` (yours).

## 14. Focused results

- `emergencyFunding.test.ts` 29/29: the brief's 1–22 (16 and 17/18 share cases; 6/6b split the overshoot and the
  "only enough" rule), the emergency private sale (eligibility and band; offer/freeze/answer-by-buyer/accept
  transfer and conservation; reject and withdraw; refusals — band, rescued buyer, unaffordable buyer, non-owner,
  no shortfall, never resold; settlement-time revalidation of an acceptance across eleven mutated boards plus the
  fail-closed no-grid case; bankruptcy derived vs declared, never prematurely), and the owner-defined trade rule
  (permitted with treasury + cash, refused when liquidation would be needed with the accepted offer retired,
  face-value cap when the president contributes), with negative controls (unowed emergency purchase refused; ordinary Stock Round sale untouched;
  poorer bankrupt not the winner; resolving family passes the hold; no grid → no opinion).
- Green: `trainDiscard` 21, `rulesVersion`, `trainLifecycle`, `trainPurchaseGate`, `emergencyTrainFlow`,
  `forcedDivestment`, `closeRoomPayout`, `messageSchema`, `turnAuthority`, `roomSession`, `presidencyTransfer`,
  `shareSale`, `sellBuySell`, `playerLiquidity`, `presidentCertificateSale`, `presidentPlacement`,
  `presidentPurchase`, `sellIsNotAPass`, `sellThenBuyLock`, `mhStockRoundChip`, `GameOverModal`,
  `EmergencyTrainPurchaseModal`, `accolades`, `bankBreakEnding`, `shellMessageArms`, `moneyVocabulary`,
  `shapeAndPlacement`, `actionReceipt`, `batch51/52`, `buyTrainsPanel`, `dieselExchange`, `roundReplay`,
  `gameHistory`, `hostJoinFlow`, `divergenceWatch`, `actionLog`, `refusedAction`, `operatingOrderTieBreak`,
  `replayGolden`, `replayJunoCV4`, `replayJuno3XD`.
- Both typechecks clean.

## Ledger

`RULES_HARDENING_BACKLOG.md` (repo root; project copy `claude/rules-hardening-backlog.md`) is the living ledger of
deferred findings, confirmed bugs and owner decisions, seeded 2026-09-15 from the audit and Batches 1–5. This
batch's entries: owner decisions D-5 (emergency private sale) and D-6 (intercorporate trade simplification), D-7,
D-8; deferred S8-2 (presidency tie, Stage 8), S7-6 (ordinary private purchase still ungated, Stage 7), S7-1
(`adjustTreasury` floor, Stage 7), the JUNO-Z6C row in the version table. **Every later batch updates the ledger before it
is committed.**

## Expected totals and command

354 suites / 5495 tests (baseline 353 / 5466 + `emergencyFunding.test.ts` 29; every other suite keeps its count).

    cd frontend && npm test -- --watchAll=false
    cd frontend && npm run typecheck
    cd server && npm run build
