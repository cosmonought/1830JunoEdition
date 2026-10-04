# Rules v13: settlement certification vectors (PASS / CERTIFIED)

**Current status (2026-10-04, `phase3/v13-settlement-certification`): v13 settlement certification PASS / CERTIFIED** on
this slice branch; since 2026-10-04 INTEGRATED into the Phase-3 provisional baseline `phase3/wave2-bcg-v13cert-integration` (merge `69c7496`;
evidence, fixtures and keys unchanged), not merged to `main`. Rules engine `13`; supported live
gameplay `[13]`; settlement-certified `SETTLEMENT_CERTIFIED_RULES_ENGINE_VERSIONS = [10, 11, 12, 13]`. Gameplay-engine
support and settlement certification remain separate axes. The record is §6.

**Status at W3-K (2026-10-04, W3-K `phase3/w3-k-rules-v13`, with the owner's rulings of 2026-10-04), kept as written: rules
engine v13 is LIVE in the engine; it is NOT settlement-certified — v13 settlement certification is PENDING A DEDICATED PASS.**
`SETTLEMENT_CERTIFIED_RULES_ENGINE_VERSIONS` stays `[10, 11, 12]`. A v13 board is refused for money settlement with
`UNSUPPORTED_RULES_ENGINE_VERSION` until a separate certification pass adds 13 on its own evidence, in its own reviewed
change. This file lists what that pass must prove. W3-K does not certify anything.

Gameplay rules and settlement certification are separate version axes. Rule 13 is in force for gameplay because
`RULES_ENGINE_VERSION = 13` and the live list is `[13]`. Settlement accepts only versions it has certified.

> **Dedicated pass (2026-10-04, `phase3/v13-settlement-certification`, from `be1fd10`): THE EVIDENCE IS BUILT.**
> Every vector below is a terminal board reached by play through a server `RoomSession` and pinned beside the v10 / v11
> / v12 evidence: `frontend/src/utils/settlementV13Certification.test.ts` (the test, sections A-H),
> `frontend/src/utils/settlementV13Vectors.ts` (the vector games), `frontend/src/utils/__fixtures__/settlement/`
> `settlementV13CertificationVectors.json` and `settlementV13TerminalBoards.json` (generated, pinned), and
> `verify_v13_settlement_vectors.py` (an independent Python appraisal and the escrow crate's encoder, run by hand).
> The evidence is green with the literal at `[10, 11, 12]` (it is built from the certified primitives; every production
> path must refuse a v13 board until the literal admits 13). The literal is changed only in its own commit after the
> evidence is independently reviewed; see §5. **Done:** the evidence (`e36f3a1`) was owner-accepted and the literal
> admitted 13 in its own commit; see §6.

## 1. What v13 changes that settlement can see

The appraisal formula (`settlementAppraisal.ts`, §1) is unchanged:
`NW(p) = cash + Σ (pct / 10) · sv + Σ face(open privates)`. For the bankrupt president it is the share term only (cash and
privates count 0, rulebook 6.6.3 note, OD-SET-1 (a)). What v13 changes is **which terminal boards are reachable**:

| Change | Rules revision 2 | Terminal effect |
|---|---|---|
| OD-2: one `PassTurn` ends a Stock Round turn | yes | Path only. Valuation semantics are unchanged. |
| SBS-3 / SBS-4: the Brown Bank Pool continuation | yes | Path only. Fewer multi-purchase turns are legal than under v12. Owner ruling 2: any other accepted turn action of the active player (a sale, an accepted private trade, an M&H exchange, Pass Turn) closes it; another player's off-turn answer does not. |
| OD-4: automatic emergency funding and automatic bankruptcy | yes | **Terminal boards differ.** See below. |

OD-4's terminal differences from v12:

- **No futile sales.** v12 forced the president to sell share by share even when no sale could fund the train. v13 proves
  insolvency first (the exact factorized oracle in `emergencyFunding.ts` `rescueAnalysis`). It then ends the game with
  `bankrupt_president` set.
- **Liquidation at bankruptcy.** Everything the president can legally sell is sold first. Each corporation is one leg, at
  that corporation's maximum legal bundle, in `public_companies` order. Each leg is an ordinary sale: the 50% Bank Pool
  cap, the presidency rule and the price drops all apply; "only enough" does not. The president's whole cash then goes to
  the obligated corporation's treasury. So rival share prices, Bank Pool percentages and one corporation's treasury differ
  from v12's terminal boards.
- **Shares that could not be sold stay with the bankrupt.** For example, a presidency that cannot be passed on. They are
  valued in the share term (owner sub-ruling O-6: "shares he could not sell").
- **A bankruptcy record on the terminal board.** An automatic bankruptcy writes `bankruptcy_record` (the bankrupt, the
  obligated corporation, the liquidation legs, what they raised, the money handed over) for the Activity Log. No rule and
  no appraisal term reads it, but it is part of the terminal board's bytes, so the v13 goldens' `appraisal_state_hash`
  covers it.
- **No player-declared bankruptcy.** `DeclareBankruptcy` is refused on revision 2, so a terminal reached by an early
  declaration does not exist on v13.
- **No self-made bankruptcy.** A portfolio that cannot fund the purchase is refused. A terminal reached by a bad split
  (v12's V3) does not exist on v13.
- **No liquidation-funded intercorporate trade.** A train bought from another corporation is paid only from the treasury
  plus the president's cash, while the trade window is open. Terminal boards built on v12's R5 trades do not exist.
- **"Only enough" is the president's choice among legal portfolios (owner ruling 1).** No redundant leg and no leg larger
  than a smaller legal bundle of the same holding that would still fund; the smallest legal indivisible bundle may
  overshoot. The engine does NOT require the globally smallest dollar overshoot, so two different rescue portfolios of one
  obligation are both legal and lead to different terminal boards (different prices fall, different cash is left).
- **Each corporation appears once in a portfolio (owner ruling 4).** A duplicate leg is refused.
- **Private funding holds the game only while a LEGAL path exists (owner ruling 5).** Bankruptcy waits for an offer or
  `ForgoPrivateFunding` only while a legally valid private sale, or a sequence of them, could complete a rescue with the
  most a legal share portfolio adds (judged exactly by `maximumPrivateFunding`; buyer consent is assumed, never treated as
  a refusal). A loose upper bound never holds the game, so a terminal that v13's first draft would have held open for a
  `ForgoPrivateFunding` ends at once instead.

## 2. Vectors the certification pass must add

Each vector should be a v13-pinned board (`rules_engine_version: 13`, `variants.rules: 2`) reached by replaying a log
through `RoomEngine`, never hand-built. Its appraisal golden should sit beside the v12 goldens. For each one the pass
checks three things:

- the appraisal is byte-identical across rebuild, `RevertTo` and a cold restore;
- the integer shares sum exactly to the escrowed pool (no floating point anywhere);
- the payout identity of `settlementV12Certification` holds.

| # | Vector | What it pins |
|---|---|---|
| V13-01 | Ordinary bank break on a v13 board, with no emergency | The v12 formula carries over unchanged. |
| V13-02 | Bank break after a Stock Round that used one-click `PassTurn` turns, Brown continuations and all-pass endings | Path-only changes leave valuation alone. |
| V13-03 | Automatic bankruptcy with full liquidation: every leg is legal and the total is still short | Cash 0 and privates 0 for the bankrupt; the obligated treasury is credited; rival prices after the drops. |
| V13-04 | Automatic bankruptcy where the presidency rule keeps shares unsold | The kept shares count in the share term (O-6). |
| V13-05 | Automatic bankruptcy where the 50% Bank Pool cap limits a leg | The cap is respected in liquidation; the remainder is kept and valued. |
| V13-06 | Automatic bankruptcy where the president has no saleable shares at all | The terminal portfolio is untouched; only the cash moves. |
| V13-07 | Bankruptcy after `ForgoTrainTrade` closed the window | The window decision is replayed exactly; no trade-funded terminal. |
| V13-08 | Bankruptcy after `ForgoPrivateFunding` | The bankrupt's privates count 0. |
| V13-09 | Bankruptcy with the bankrupt's privates still open (private funding was irrelevant) | Face value excluded for the bankrupt only; other players' privates counted. |
| V13-10 | A rescue by `EmergencySellPortfolio` (smallest legal overshoot), then play continues to a bank break | The rescue terminal is an ordinary terminal; the overshoot cash is counted. |
| V13-11 | A rescue followed by the automatic `EmergencyBuyHardware` (derived, keyed) | Derived entries replay identically; no duplicate purchase. |
| V13-12 | Ties at the top, including a tie involving the bankrupt | The tie rule is unchanged under bankruptcy. |
| V13-13 | The same log replayed by `RoomEngine.apply` and rebuilt from a snapshot | The terminal digests match. |
| V13-14 | A v12-pinned log offered to a v13 engine | Refused before the first apply (never reinterpreted); there is no settlement path. |

| V13-15 | Bankruptcy after the maximal legal liquidation, mixing a Pool-capped leg, a presidency-locked holding and a fully sold one | The exact `maximumLiquidation`, in `public_companies` order; every dollar to the obligated treasury; the residue valued. |
| V13-16 | A legal private-funding path versus an upper-bound-only path: (a) one buyer whose treasury cannot pay for two privates the bound counts twice, so the game ends at once; (b) one private the buyer can pay for, so the game waits and then rescues | Only exact legal possibility holds the game; the two terminal boards differ exactly there. |
| V13-17 | A private sale followed by a share portfolio, and two private sales to two buyers, each completing a rescue | The sequence replays identically; the buyer treasuries and the private owners on the terminal board. |
| V13-18 | A Brown Bank Pool continuation interrupted by the active player's accepted private trade or M&H exchange, then play to a bank break | The second Pool purchase is refused at the interruption; an off-turn rejection in between does not interrupt it. |
| V13-19 | An atomic rescue portfolio of several corporations, in the submitted order, with a presidency change inside it | One entry, today's prices per leg, the presidency where the ordinary sale puts it. |
| V13-20 | The smallest legal overshoot, both ways: one obligation rescued by the $100 card in one log and by the $60 card in another | Both legal (owner ruling 1); two certified terminal boards from one starting board. |
| V13-21 | An intercorporate train trade inside the window, and the same obligation after the window closed | The window-funded trade terminal; no liquidation-funded trade terminal exists. |

The vectors that end in bankruptcy (V13-03 to V13-09, V13-15, V13-16 (a), and V13-12 where it applies) are required. The v12 corpus re-run
alone does not certify v13, because no v12 terminal board can show the automatic-bankruptcy shapes.

## 3. Tests that are red by design until certification

W3-K leaves these money-path tests red because they appraise a freshly dealt board, now stamped 13. This follows the
R12-2 precedent. Each one was confirmed during W3-K to pass with 13 temporarily added to the certified literal. The patch
was reverted, and `git diff` shows `settlementAppraisal.ts` unchanged. The certification pass flips them by adding 13 to
the literal in its own reviewed change, after the vectors above exist.

- Frontend: `money/walletChecks.test.ts`, `money/moneyActions.test.ts` (the money subtests that appraise a fresh deal).
- Server:
  - `escrow/escrow4Money.test.ts`;
  - `escrow/live4MoneyContinuation.test.ts` (money subtests);
  - `escrow/settlementLifecycle.test.ts`;
  - `tools/escrow3aOperator.test.ts`, `escrow/escrow3bAdversarial.test.ts`, `escrow/escrow3bBackend.test.ts`;
  - `rooms/live4Certification.test.ts` (§2 money / contradiction subtests);
  - `rooms/live4Integration.test.ts` (money subtests);
  - `tools/l4_6Tooling.test.ts` (7b);
  - `rooms/live4NoMoneyContinuation.test.ts` (T-5, money end to end).

The settlement-only pins that are **green** on W3-K and must stay green:

- `settlementV12Certification`: boards pinned at 12 are still certified.
- `da7DelayedAuctionCertification` DA-T11: a v13 board throws `UNSUPPORTED`; 12, 11 and 10 appraise.
- `rulesV13Version`: the literal is exactly `[10, 11, 12]`.

## 4. Procedure

ESCROW-3A's procedure, as in R12-3:

1. Build the vectors as replayed logs and add their goldens beside the existing ones.
2. Run the independent oracle over each terminal board.
3. In a separate, reviewed commit, change only `SETTLEMENT_CERTIFIED_RULES_ENGINE_VERSIONS` to `[10, 11, 12, 13]`, and
   flip the designed-red tests above.
4. Owner certification gate.

Deploying rules v13 also needs: W2-A, W2-B's single "Pass Turn" control with the Auto-Buy correction (W1-A's stage
refusals removed, Auto-Buy's stage Pass removed), W2-G reconciled to the v13 emergency authority, the safe integration
reconciliation, this dedicated settlement certification, pinned v12 rooms drained, and the final integrated owner gate.
Without them the W3-K branch is **not deployable alone**.

## 5. The evidence, vector by vector (the dedicated pass)

All terminals are rules-revision-2 boards pinned 13, each the room's board after the last entry of a fixed script on a
constructed, named starting board (provenance in `settlementV13Vectors.ts`). For every one: the certified appraiser (read
pin-independently: its pin gate is the only reader of the pin, and the canonical texts at 13 and 12 differ in that one
token), an independent oracle written in the test and the independent Python oracle, and `rankPlayers` agree seat by
seat; Σ payouts + dust = pool with 0 <= dust < n on three pools (n × the SET-0A ante, a prime, 2^64 + 13); the terminal
hash is identical live, after a cold restore, after `replayLog`, after a snapshot rebuild and after a LIVE RevertTo (a
room undoes the vector's last scripted non-terminal action -- on every rescue the emergency decision itself with the
game's derived purchase; ahead of an immediate bankruptcy the previous corporation's end of turn, since a room refuses a
revert once the board is at GameEnd -- makes it again and plays on; a cold restore of that log agrees); the
payload equals its v12 twin's (the same board at pin 12, built by the certified builder) outside `[1,33)` (`domain`) and
`[91,123)` (`appraisal_state_hash`); VGP is conserved from seed to terminal.

| # | Terminal(s) | Ends by | What the evidence shows |
|---|---|---|---|
| V13-01 | 1 | bank | SYN-01's GR-4 room at revision 2 is SYN-01's certified board but for `variants.rules`; SET-0A's vector and payouts. |
| V13-02 | 1 | bank | Acted turns end in one `PassTurn` without counting; a true pass counts; Pool C&O → Pool C&O continues, Pool B&O (also Brown) refused by the one-corporation rule; an all-pass ending. |
| V13-03 | 1 | bankruptcy | Every legal leg (PRR, NYC, C&O 10% each) liquidated and still short; the residue is C&O's crown; the record equals the engine's `maximumLiquidation`; the bankrupt's open Schuylkill Valley (no buyer can pay $10) counts 0. |
| V13-04 | 1 | bankruptcy | PRR's President's Certificate stays unsold (options [10, 20]); kept shares valued at the fallen prices. |
| V13-05 | 1 | bankruptcy | NYC's pool at 40%: one card sold, the pool ends at 50%, 20% kept and valued. |
| V13-06 | 1 | bankruptcy | No legal bundle: the portfolio is untouched; $40 cash to the C&O treasury. |
| V13-07 | 1 | bankruptcy | The window held the game; a $61 trade refused (needs liquidation); `ForgoTrainTrade` ends it; NYC keeps its 2. |
| V13-08 | 1 | bankruptcy | Private funding relevant until `ForgoPrivateFunding`; the bankrupt's open C&A counts 0, others' privates counted. |
| V13-09 | 1 | bankruptcy | Private funding irrelevant (bound < shortfall): immediate; the bankrupt's SV and C&StL open, counted 0. |
| V13-10 | 1 | bank | `{NYC 10, PRR 10}` = $90 for $80 (neither alone funds); the derived purchase; $10 overshoot counted; play continues. |
| V13-11 | 1 | bank | The derived, keyed `EmergencyBuyHardware` appears once; a crash before or after it -- and, on the portfolio rescues V13-10, 17a, 19 and 21b, before the portfolio, between it and the purchase, or after both -- reproduces the same log and board. |
| V13-12 | 2 | bankruptcy / bank | (a) the bankrupt ties p2 at the top; (b) two seats tie in a four-seat bank break: equal weights and payouts, rank 1 shared. |
| V13-13 | all | — | The five readers of one log (live, restore, replay, snapshot, RevertTo) reach one digest on every vector. |
| V13-14 | — | — | A v12-pinned (revision 1) deal is held before any `RoomEngine.apply`; the settlement replay has no board; the browser check is `unavailable`. |
| V13-15 | 1 | bankruptcy | NYC 20% (pool-capped) and CPR 20% (fully sold) in `public_companies` order; PRR's crown locked; $140 to the C&O. |
| V13-16 | 2 | bankruptcy / bank | (a) bound $290 ≥ $180 but the exact maximum is $150: ends at once; (b) one legal C&A sale: waits, then rescues; the seeds differ only in privates and NYC's treasury. |
| V13-17 | 2 | bank | (a) D&H to NYC then PRR 10%; (b) M&H to NYC, D&H to PRR: corporate owners and buyer treasuries on the terminal. |
| V13-18 | 2 | bank | The third / second Pool C&O refused after p1's accepted trade (a) or M&H exchange (b); p2's off-turn rejection did not interrupt (a). |
| V13-19 | 1 | bank | One entry `[PRR 10, NYC 20, CPR 10]` at today's prices ($195); NYC's presidency passes to p2; arrivals in the submitted order. |
| V13-20 | 2 | bank | One seed, two logs: the $100 card and the $60 card both legal, both together refused; two terminals. |
| V13-21 | 2 | bank | (a) p1 offers $60 for NYC's 2 inside the window and NYC's president p2 accepts (the room's derived settlement); (b) after the PRR sale the window is closed and the trade refused; the Bank's train bought. |

**Limits of the device, stated.** Every vector starts from a constructed board, not a `SetupGame` deal, so the
production replays that begin at the default seed are exercised over these logs through the same `RoomSession` restore
with the vector's own seed (V13-14 replays a real v13 deal). The bank-break seeds are latched at $0 (SYN-01's device),
so their money does not add up to $12,000; the appraisal reads no bank or treasury, and each vector conserves VGP from
seed to terminal. `ForgoTrainTrade` and `ForgoPrivateFunding` are the president's declared choices (owner rulings OD-4:
the trade and private funding are optional, rulebook 6.6.2 / 6.6.3), so V13-07 and V13-08 end in bankruptcy although a
trade or a private sale could have rescued; no bankruptcy is ever declared by `DeclareBankruptcy` (refused on
revision 2). V13-18 (a) follows owner ruling 2 as W3-K implemented and reviewed it: a proposal and another player's
off-turn rejection do not close the continuation; the accepted trade does.

## 6. Certification admission and validation record (2026-10-04)

**v13 settlement certification: PASS / CERTIFIED** on `phase3/v13-settlement-certification` (base `be1fd10`; evidence
`e36f3a1`, owner-accepted after two independent reviews; admission in its own commit after it). Not yet integrated into the
Phase-3 provisional baseline or `main`.

- **Authoritative state on this branch:** rules engine `13`; supported live gameplay `[13]`; settlement-certified
  `[10, 11, 12, 13]`, still an explicit frozen literal in `settlementAppraisal.ts` that never reads the gameplay version.
  The two axes stay separate.
- **Admission commit:** the literal, its provenance paragraph, `EXPECTED_SETTLEMENT_LITERAL`, the tests whose only stale
  assumption was "settlement ends at 12" / "13 is the newer, unsupported pin" (each refusal moved to 14 /
  `RULES_ENGINE_VERSION + 1`, none deleted), and the compatibility keys derived from the literal: no escrow
  `dc1-e8d0b4792a7ba07e67199ad2`, fixture pin `dc1-32fcc4967978e78f10874490` (W3-K's `dc1-390107d5…` / `dc1-d01c50c4…`
  reproduce with certified `[10, 11, 12]` and stay pinned as history).
- **Nothing pinned moved:** the v13 fixtures were not regenerated; the five frozen v10 files and the v11 / v12 evidence
  files are byte-identical (SHA-256 guards green); the production paths reproduce the pre-admission v13 bytes exactly. No
  appraisal arithmetic, codec, payload layout, contract or gameplay rule changed.
- **Validation:** `settlementV13Certification` 265 pass / 1 skip (the skip needs owner-local server data). 26 focused
  frontend suites (settlement v11 / v12 / v13, payload goldens / conformance / mutation, adversarial, the Juno oracle, DA-7,
  DA-8, the three rules-v13 suites, corpus parity, digest, preview policy, variants, live-4 model / compatibility /
  certification, shell wiring, and the three money suites) 1415 pass / 4 skip. The formerly designed-red suites are green
  with no change to their money behaviour: frontend `walletChecks`, `moneyActions` and `settlementCheck` (unchanged
  files; `settlementCheck` was missing from §3's list but was red for the same reason); server `escrow4Money` 30/30,
  `live4MoneyContinuation` 35/35, `settlementLifecycle` 22/22, `escrow3aOperator` 8/8, `escrow3bAdversarial` 41/41,
  `escrow3bBackend` 1/1, `rooms/live4Certification` 63/63, `rooms/live4Integration` 35/35, `tools/l4_6Tooling` 13/13,
  `rooms/live4NoMoneyContinuation` 9/9. `verify_v13_settlement_vectors.py` and `verify_set0c_payload_vectors.py` OK;
  frontend `tsc --noEmit` clean; server build clean; accounting PASS; `git diff --check` clean. Broad owner gate not run.
- **Independent review of the admission: PASS** (no MEDIUM or higher). Mutations it ran: a literal of
  `[10, 11, 12, 13, 14]` fails 20 frontend and 10 server tests; reverting the literal while keeping the edited tests
  restores the pre-admission failure counts; a pin-13-only appraisal skew fails 141 v13 tests.
- **Follow-ups (not blockers):** (1) `automaticBankruptcy` → `executeEmergencyLegs` skips a liquidation leg the sale law
  refuses instead of failing loudly; the evidence guards the current behaviour on every bankruptcy vector
  (`bankruptcy_record.sold == maximumLiquidation`); hardening it is a separate task. (2) The "uncertified board never
  builds" check in `escrow3bAdversarial` uses hand-built evidence whose zero hashes hold it as `evidence-mismatch` for any
  pin; the real refusal is covered by `settlementLifecycle`. It predates this pass and could assert `rules-not-certified`.
