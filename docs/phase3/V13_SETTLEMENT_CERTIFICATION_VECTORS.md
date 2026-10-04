# Rules v13: settlement certification vectors (PENDING)

**Status (2026-10-03, W3-K `phase3/w3-k-rules-v13`): rules engine v13 is LIVE in the engine; it is NOT settlement-certified.**
`SETTLEMENT_CERTIFIED_RULES_ENGINE_VERSIONS` stays `[10, 11, 12]`. A v13 board is refused for money settlement with
`UNSUPPORTED_RULES_ENGINE_VERSION` until a separate certification pass adds 13 on its own evidence, in its own reviewed
change. This file lists what that pass must prove. W3-K does not certify anything.

Gameplay rules and settlement certification are separate version axes. Rule 13 is in force for gameplay because
`RULES_ENGINE_VERSION = 13` and the live list is `[13]`. Settlement accepts only versions it has certified.

## 1. What v13 changes that settlement can see

The appraisal formula (`settlementAppraisal.ts`, §1) is unchanged:
`NW(p) = cash + Σ (pct / 10) · sv + Σ face(open privates)`. For the bankrupt president it is the share term only (cash and
privates count 0, rulebook 6.6.3 note, OD-SET-1 (a)). What v13 changes is **which terminal boards are reachable**:

| Change | Rules revision 2 | Terminal effect |
|---|---|---|
| OD-2: one `PassTurn` ends a Stock Round turn | yes | Path only. Valuation semantics are unchanged. |
| SBS-3 / SBS-4: the Brown Bank Pool continuation | yes | Path only. Fewer multi-purchase turns are legal than under v12. |
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
- **No player-declared bankruptcy.** `DeclareBankruptcy` is refused on revision 2, so a terminal reached by an early
  declaration does not exist on v13.
- **No self-made bankruptcy.** A portfolio that cannot fund the purchase is refused. A terminal reached by a bad split
  (v12's V3) does not exist on v13.
- **No liquidation-funded intercorporate trade.** A train bought from another corporation is paid only from the treasury
  plus the president's cash, while the trade window is open. Terminal boards built on v12's R5 trades do not exist.

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

The vectors that end in bankruptcy (V13-03 to V13-09, and V13-12 where it applies) are required. The v12 corpus re-run
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

Deploying rules v13 also needs the UI coupling: W1-A, the removal of Auto-Buy's stage Pass, W2-B's single "Pass Turn"
control, and W2-G reconciled to the v13 emergency authority. Without it the W3-K branch is **not deployable alone**.
