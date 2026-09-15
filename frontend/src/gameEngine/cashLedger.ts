// frontend/src/gameEngine/cashLedger.ts
//
// ==================================================================
//  DESIGN NOTE 1560: THE LEDGER IS THE LAST LINE, NOT THE RULE
// ==================================================================
//
// Every dollar in this game lived behind one of three helpers in `sandboxSession.ts`, and all three ended
// `Math.max(0, current + delta)`. That clamp is the single most expensive line in the reducer, because it
// turns three different failures into the same silent success:
//
//   an unaffordable purchase      MINTS money -- the buyer pays what he has, the bank is credited the full
//                                 price, and the difference is created out of nothing (audit C3; the probe
//                                 found it on JUNO-3XD 28/31/211, JUNO-Z6C 193/261/264, JUNO-FCJ 106/109 and
//                                 twenty more).
//   a debit with no recipient     DESTROYS money -- the auction charged every private and credited nobody,
//                                 and the terrain fee left the treasury for nowhere (S7-10).
//   a payout from an empty bank   LIES about the bank -- the balance floors at 0, so the shortfall is simply
//                                 forgotten and the total on the table changes (m11).
//
// SO THE REPLACEMENT IS NOT A BETTER CLAMP. It is a ledger: every movement is a debit matched by a credit,
// amounts are non-negative whole VGP, and a debit the account cannot cover REFUSES. `Uint128` on the contract
// side is unsigned and whole; this is the same arithmetic, kept honest on the server so the two never disagree.
//
// WHAT REFUSES, AND WHAT DOES NOT:
//   player and corporation debits refuse when the balance cannot cover the amount. There is no overdraft in
//     1830: "Purchases must be made with available money. Credit is not allowed" (6.1 note).
//   THE BANK IS SIGNED (owner ruling D-15 / Q1b). The bank is not a player; when it runs out it keeps paying
//     and its accounting balance goes negative, which is the only representation in which the total on the
//     table is conserved and therefore testable. `Math.max(0, ...)` there was "paper tracking" and is gone.
//   a malformed amount -- not finite, not whole, or negative -- refuses everywhere. A negative "debit" is a
//     credit wearing a disguise, and that is exactly how `BuyPrivateCompany` with `price: "-500"` paid the
//     buyer's treasury $500 out of the seller's pocket (S7-12).
//
// REFUSAL IS A VALUE, NEVER A THROW. `RoomSession.submit` appends before it applies (#1250), so a throw from
// inside an arm leaves an entry in the durable log that crashes every rebuild from here to the end of the
// game. A refusing arm returns the state it was handed -- the same identity refusal every other gate in this
// reducer uses (#778) -- and the entry replays as the no-op it was.
//
// AND THE LEDGER IS NOT THE RULE. Affordability is a rule, asked by a predicate in front of the transaction
// (`trainPurchaseRefusal`, `stationPlacementGate`, `kanawhaLicenseRefusal`, the Batch-5 emergency gates, and
// the Batch-7.2/7.4 transaction predicates that follow this batch). The ledger is the boundary those
// predicates are checked against: where a gate exists, the ledger's refusal is unreachable and nothing about
// the game changes; where one does not exist yet, the ledger refuses instead of inventing money. A future
// batch that adds a predicate must not remove the boundary.
//
// See `RULES_HARDENING_BACKLOG.md` S7-1, S7-10, S7-12, S7-20 and
// `BATCH7_TRANSACTION_AUTHORITY_DESIGN_2026-09-15.md` 7.1 / 7.1a.

import type { GameStateResponse } from "./gameState";
/* ONE DEFINITION OF "BROKEN", and this is the import that keeps it that way. `endgame.ts` imports nothing
   but the state type, so there is no cycle; and the alternative -- a second non-positive test spelled out
   here -- is exactly the divergence the badge test (U-27) exists to prevent. */
import { bankIsBroken } from "./endgame";

/** One side of a money movement. Spelled as the design spells it: `{ player }`, `{ corporation }`, `"bank"`. */
export type MoneyAccount =
  | { readonly player: string }
  | { readonly corporation: number }
  | "bank";

/** The bank, as a transfer endpoint. */
export const BANK = "bank" as const;

/** A movement that happened (`state` is the board after it) or one that was refused (`reason` says why).
 *
 *  `reason` is a whole sentence because it is the sentence an ingress refusal shows the player (#784's rule:
 *  one refusal, every surface). A reducer arm that cannot use it returns the state it was handed instead. */
export type LedgerResult =
  | { readonly ok: true; readonly state: GameStateResponse }
  | { readonly ok: false; readonly reason: string };

export function isPlayerAccount(account: MoneyAccount): account is { player: string } {
  return account !== BANK && "player" in account;
}

export function isCorporationAccount(account: MoneyAccount): account is { corporation: number } {
  return account !== BANK && "corporation" in account;
}

function sameAccount(a: MoneyAccount, b: MoneyAccount): boolean {
  if (a === BANK || b === BANK) return a === b;
  if (isPlayerAccount(a)) return isPlayerAccount(b) && a.player === b.player;
  return isCorporationAccount(b) && (a as { corporation: number }).corporation === b.corporation;
}

function describe(account: MoneyAccount): string {
  if (account === BANK) return "the Bank";
  if (isPlayerAccount(account)) return account.player;
  return `corporation ${account.corporation}`;
}

/** Whole, finite, non-negative VGP, or the sentence saying why not.
 *
 *  Whole because the contract's `Uint128` is whole and because a fractional dollar is not a thing this game
 *  has; non-negative because direction is carried by which function is called, never by the sign of the
 *  amount -- a signed amount is how a "debit" silently became a credit. */
function amountRefusal(amount: number): string | null {
  if (typeof amount !== "number" || !Number.isFinite(amount)) {
    return `A money amount must be a finite number; received ${String(amount)}.`;
  }
  if (!Number.isInteger(amount)) {
    return `A money amount must be a whole number of VGP; received ${amount}.`;
  }
  if (amount < 0) {
    return `A money amount may not be negative; received ${amount}. Direction is the transfer's, not the amount's.`;
  }
  return null;
}

/** A player's cash, or `null` when this board has no record of that player.
 *
 *  `null` is NOT zero -- `gameState.ts` 943 takes the same line. A player the state has never heard of is a
 *  player the ledger must not pay and must not bill. */
export function playerCashOf(state: GameStateResponse, player: string): number | null {
  const entry = state.player_cash.find((row) => row.player === player);
  if (!entry) return null;
  const cash = Number(entry.cash_vgp);
  return Number.isFinite(cash) ? cash : null;
}

/** A corporation's treasury, or `null` when there is no such corporation or its treasury is unreadable. */
export function treasuryOf(state: GameStateResponse, companyId: number): number | null {
  const company = state.public_companies.find((row) => row.company_id === companyId);
  if (!company) return null;
  const treasury = Number(company.treasury);
  return Number.isFinite(treasury) ? treasury : null;
}

/** The bank's authoritative balance. May be negative once the bank has broken (D-15). */
export function bankFundsOf(state: GameStateResponse): number | null {
  const bank = Number(state.virtual_bank_vgp);
  return Number.isFinite(bank) ? bank : null;
}

function withPlayerCash(state: GameStateResponse, player: string, next: number): GameStateResponse {
  return {
    ...state,
    player_cash: state.player_cash.map((entry) =>
      entry.player === player ? { ...entry, cash_vgp: String(next) } : entry,
    ),
  };
}

function withTreasury(state: GameStateResponse, companyId: number, next: number): GameStateResponse {
  return {
    ...state,
    public_companies: state.public_companies.map((company) =>
      company.company_id === companyId ? { ...company, treasury: String(next) } : company,
    ),
  };
}

export function debitPlayer(state: GameStateResponse, player: string, amount: number): LedgerResult {
  const malformed = amountRefusal(amount);
  if (malformed !== null) return { ok: false, reason: malformed };
  const cash = playerCashOf(state, player);
  if (cash === null) {
    return { ok: false, reason: `${player} has no cash on this board, so nothing can be paid from it.` };
  }
  if (cash < amount) {
    return { ok: false, reason: `${player} holds $${cash} and cannot pay $${amount}.` };
  }
  return { ok: true, state: withPlayerCash(state, player, cash - amount) };
}

export function creditPlayer(state: GameStateResponse, player: string, amount: number): LedgerResult {
  const malformed = amountRefusal(amount);
  if (malformed !== null) return { ok: false, reason: malformed };
  const cash = playerCashOf(state, player);
  if (cash === null) {
    /* A credit to nobody is how money leaves the game. `transferPrivateToCorporation` paid a corporation
       seller into the void exactly here (S7-12), so an unknown payee refuses rather than absorbing. */
    return { ok: false, reason: `${player} has no cash on this board, so $${amount} cannot be paid there.` };
  }
  return { ok: true, state: withPlayerCash(state, player, cash + amount) };
}

export function debitTreasury(state: GameStateResponse, companyId: number, amount: number): LedgerResult {
  const malformed = amountRefusal(amount);
  if (malformed !== null) return { ok: false, reason: malformed };
  const treasury = treasuryOf(state, companyId);
  if (treasury === null) {
    return { ok: false, reason: `Corporation ${companyId} has no treasury on this board, so nothing can be paid from it.` };
  }
  if (treasury < amount) {
    const company = state.public_companies.find((row) => row.company_id === companyId);
    const who = company?.ticker ?? `corporation ${companyId}`;
    return { ok: false, reason: `${who}'s treasury holds $${treasury} and cannot pay $${amount}.` };
  }
  return { ok: true, state: withTreasury(state, companyId, treasury - amount) };
}

export function creditTreasury(state: GameStateResponse, companyId: number, amount: number): LedgerResult {
  const malformed = amountRefusal(amount);
  if (malformed !== null) return { ok: false, reason: malformed };
  const treasury = treasuryOf(state, companyId);
  if (treasury === null) {
    return { ok: false, reason: `Corporation ${companyId} has no treasury on this board, so $${amount} cannot be paid there.` };
  }
  return { ok: true, state: withTreasury(state, companyId, treasury + amount) };
}

/* ==================================================================
    DESIGN NOTE 1561: THE BANK BREAKS ONCE AND STAYS BROKEN (S7-20)
   ==================================================================
   `bankIsBroken` has always been `virtual_bank_vgp <= 0`, asked in one place -- `settleRoundTransitions`, in
   the `operating_round_just_ended` branch (#898). So the ending was RE-DERIVED from the balance at the set
   boundary, and a bank that a payout emptied mid-set and the same set's train, token and share purchases
   refilled was, at the boundary, solvent. The game played on. Under flooring and under signed accounting
   alike; the owner's own example is `$10 -> pays $30 -> receives $100 -> $80`, and the $30 payout is the
   moment the bank ran out whatever the balance says twenty minutes later.

   SO THE FACT IS RECORDED WHERE IT HAPPENS, in the debit, rather than inferred later from a number that has
   moved on. `bank_broken?: true` is written the first time a bank DEBIT leaves the balance at or below zero,
   and nothing in the game ever clears it: no credit, no arm, no settlement. Only `RevertTo` removes it, and
   it does so for free and for the right reason -- state is a function of the log, and a log that stops before
   the breaking payout rebuilds a board that never reached it (#1026). No special-casing anywhere.

   "LEAVES <= 0" IS ABOUT THE DEBIT'S RESULT, not about crossing zero in either direction. A credit never
   BREAKS the bank. A debit from -$20 to -$50 "leaves <= 0" and would latch, which costs nothing because the
   latch is already set. A ZERO debit against a SOLVENT bank latches nothing: the bank is exhausted by a
   payout, not by a message that pays nobody.
   A CREDIT DOES, HOWEVER, CARRY AN EXISTING BREAK FORWARD -- see `withBankBalance`. On a legacy board the
   only record of a break is the balance itself, so a receipt that lifts the bank back above zero would erase
   the fact along with the number. Carrying it forward is not a new break; it is the same answer
   `bankIsBroken` already gave, made durable.

   #232's rule holds for the field: ABSENT MEANS "THE LOG DOES NOT SAY", which is why `bankIsBroken` keeps
   the balance test as its second half -- a fixture or a legacy board that carries no field is still judged
   the way it always was. */
/* ==================================================================
    AN UNREADABLE BANK BALANCE IS THE ONE LENIENT CASE, AND IT IS DELIBERATE
   ==================================================================
   A player or a corporation with no readable balance REFUSES, because "can this account cover the amount"
   is a question about that account and an unreadable one cannot answer yes. The bank is not asked that
   question at all -- it has no affordability rule, it pays past zero (D-15/Q1b) -- so an unreadable balance
   has nothing to refuse. It is read as $0, exactly as the retired `adjustBank` read it, which keeps every
   hand-built fixture that omits the field behaving as it did and keeps the arithmetic CONSERVING: `moneyTotal`
   skips a non-finite bank, so "skipped" and "zero" are the same number on both sides of the movement.
   THE LATCH IS NOT WRITTEN IN THAT CASE. #232's rule: a board that never said what the bank held cannot be
   said to have run out of it. `bankIsBroken`'s balance fallback still answers such a board the way it always
   did, so nothing about it changes. */
/** THE ONE PLACE THE BANK'S BALANCE IS WRITTEN, so the latch cannot be forgotten by one of the two callers.
 *
 *  The field is materialised on either of two conditions, and the second is the one a first draft misses:
 *    (i)  `brokenByThisWrite` -- the debit that exhausts the bank (the event the latch records); or
 *    (ii) THE BOARD WAS ALREADY BROKEN BEFORE THIS WRITE. On a version-5 board that means the latch is
 *         already set and is simply carried through. On a LEGACY board it means the balance test said so and
 *         the field was never materialised -- and that is the case that matters: a legacy board at -$20 or
 *         $0 is broken, and a credit that lifts it to $80 would otherwise have UN-BROKEN it, because the
 *         only record of the break was the balance the credit just overwrote. D-15 says bank credits never
 *         un-latch a break; without this clause that promise held only for boards dealt after Batch 7.1.
 *  Materialising is not a reinterpretation of the board: `bankIsBroken` already answered `true` for it, and
 *  it answers `true` afterwards. What changes is that the answer survives the next receipt.
 *  An UNREADABLE balance is not broken (`bankIsBroken`'s test requires a finite number), so the lenient case
 *  above still writes no field -- a board that never said what the bank held has not been seen to run out. */
function withBankBalance(
  state: GameStateResponse,
  next: number,
  brokenByThisWrite: boolean,
): GameStateResponse {
  const banked: GameStateResponse = { ...state, virtual_bank_vgp: String(next) };
  if (banked.bank_broken === true) return banked;
  if (!brokenByThisWrite && !bankIsBroken(state)) return banked;
  return { ...banked, bank_broken: true };
}

export function debitBank(state: GameStateResponse, amount: number): LedgerResult {
  const malformed = amountRefusal(amount);
  if (malformed !== null) return { ok: false, reason: malformed };
  const bank = bankFundsOf(state);
  return {
    ok: true,
    state: withBankBalance(state, (bank ?? 0) - amount, bank !== null && amount > 0 && bank - amount <= 0),
  };
}

/** Money paid TO the bank (D-15/Q1a: it increases authoritative bank funds). Never un-latches a break -- and,
 *  since `withBankBalance`, never un-breaks a legacy board whose break lived only in its balance either. */
export function creditBank(state: GameStateResponse, amount: number): LedgerResult {
  const malformed = amountRefusal(amount);
  if (malformed !== null) return { ok: false, reason: malformed };
  return { ok: true, state: withBankBalance(state, (bankFundsOf(state) ?? 0) + amount, false) };
}

function debitAccount(state: GameStateResponse, account: MoneyAccount, amount: number): LedgerResult {
  if (account === BANK) return debitBank(state, amount);
  if (isPlayerAccount(account)) return debitPlayer(state, account.player, amount);
  return debitTreasury(state, account.corporation, amount);
}

function creditAccount(state: GameStateResponse, account: MoneyAccount, amount: number): LedgerResult {
  if (account === BANK) return creditBank(state, amount);
  if (isPlayerAccount(account)) return creditPlayer(state, account.player, amount);
  return creditTreasury(state, account.corporation, amount);
}

/** One debit and its matching credit, or a refusal and nothing moved.
 *
 *  ATOMIC BY CONSTRUCTION: the debited board is a local value, so a refused credit is a refused transfer and
 *  the caller still holds the state it handed in. There is no partially-applied money movement anywhere in
 *  this engine, which is the property the conservation harness actually tests. */
export function transfer(
  state: GameStateResponse,
  from: MoneyAccount,
  to: MoneyAccount,
  amount: number,
): LedgerResult {
  const malformed = amountRefusal(amount);
  if (malformed !== null) return { ok: false, reason: malformed };
  /* A movement between one account and itself is a no-op rather than a refusal: it nets to zero under the old
     adjusters too, and whether the two ends MAY be the same is a rule (7.4/7.5), not arithmetic. */
  if (sameAccount(from, to)) return { ok: true, state };
  const debited = debitAccount(state, from, amount);
  if (!debited.ok) return debited;
  const credited = creditAccount(debited.state, to, amount);
  if (!credited.ok) {
    return { ok: false, reason: `${credited.reason} (nothing was taken from ${describe(from)}.)` };
  }
  return credited;
}

/* ==================================================================
    DESIGN NOTE 1562: THE CONSERVATION HARNESS
   ==================================================================
   Money on the table = the bank + every player's cash + every corporate treasury. Nothing else holds VGP:
   auction bids are ESCROWED rather than spent (the bid list is the escrow, #334a), share and train and
   private values are not money, and the JUNO pool is a different quantity entirely.

   THE TOTAL IS THE INVARIANT. Every gameplay action must leave it exactly as it found it; the only things
   that may move it are the ones that introduce or remove value BY DESIGN -- the initial deal, and the Yellow
   Sign cash award, which mints and is Stage 9's to fix (S9-1), not this batch's.

   `assertMoneyConserved` THROWS, and is for tests only. Production code asks `moneyConservationBreach` or
   nothing at all: a reducer that throws leaves an appended entry no rebuild can get past. */
export function moneyTotal(state: GameStateResponse): number {
  let total = 0;
  const bank = bankFundsOf(state);
  if (bank !== null) total += bank;
  for (const entry of state.player_cash) {
    const cash = Number(entry.cash_vgp);
    if (Number.isFinite(cash)) total += cash;
  }
  for (const company of state.public_companies) {
    const treasury = Number(company.treasury);
    if (Number.isFinite(treasury)) total += treasury;
  }
  return total;
}

/** A sentence naming the discrepancy, or `null` when the total is unchanged. Never throws. */
export function moneyConservationBreach(
  before: GameStateResponse,
  after: GameStateResponse,
): string | null {
  const was = moneyTotal(before);
  const now = moneyTotal(after);
  if (was === now) return null;
  const delta = now - was;
  const signed = delta >= 0 ? `+$${delta}` : `-$${Math.abs(delta)}`;
  return `Money on the table changed by ${signed}: $${was} before, $${now} after.`;
}

/** Test-only assertion. Throws with the figures when the total moved. */
export function assertMoneyConserved(
  before: GameStateResponse,
  after: GameStateResponse,
  label?: string,
): void {
  const breach = moneyConservationBreach(before, after);
  if (breach === null) return;
  throw new Error(label === undefined ? breach : `${label}: ${breach}`);
}
