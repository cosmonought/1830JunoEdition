// LUDUM v1 -- player history (Lane C): ONE SEAT'S JUNOX LEDGER, FROM THE ESCROW'S OWN ARITHMETIC.
//
// Every entry is derived from what `contracts/escrow/src` actually does, route by route -- never from a description:
//
//   DEPOSIT (`execute/funding.rs::create_game / join`): the seat sends `gross_deposit` (= the game's `ante_gross`);
//     `subsidy_paid = floor(gross * subsidy_bps / 10000)` is taken at once and never returned; `net_deposit` enters
//     the pool.                                                  -> ante_gross (out), subsidy (informational)
//   PAYOUT routes (`helpers.rs::pay_out`, `pay_foreclosure`): the seat receives `outcome.amounts[chain_seat_index]`.
//     all_consents_at_settle, consent_completed, finalized (`execute/play.rs`); resolver_uphold, resolver_replace,
//     resolver_timeout_payout, settleable_timeout_payout (`execute/dispute.rs`); remedy_foreclosure
//     (`execute/remedy.rs`, `payout.rs::foreclosure_split`: 0 to the defaulting seat).          -> payout (in)
//   REFUND routes (`helpers.rs::refund_all`): the seat receives its stored `net_deposit`, which is
//     `outcome.amounts[chain_seat_index]`. creator_cancel, deadline_cancel (`execute/funding.rs::cancel`);
//     resolver_annul, annul_by_consent, liveness_refund, settleable_timeout_refund, resolver_timeout_refund,
//     review_annul (`execute/dispute.rs`); remedy_timeout_annul, remedy_annul (`execute/remedy.rs`). -> refund (in)
//   WITHDRAW during funding (`execute/funding.rs::withdraw`): the seat is REMOVED from `Game.seats` and its net deposit
//     sent back in that transaction; the game keeps no trace of it. Its deposit and refund are therefore not provable
//     from the game, and are reported "unavailable", never reconstructed.
//   THE CHALLENGE BOND (`execute/dispute.rs`): the challenger sends exactly `Game.bond`.            -> bond_posted (out)
//     Uphold: the bond joins the pool and is paid out by the stored weights (`bond_to_pool`); the challenger's share of
//       it is inside its payout.                                                       -> bond_forfeited (informational)
//     Replace, Annul, the resolver timeout (with payout, refund or checkpoint fallback) and AnnulByConsent while
//       disputed: `close_dispute(.., return_bond = true)` sends the bond back.                    -> bond_returned (in)
//
// Signs (§4): an entry's `amount` is a non-negative magnitude, and its KIND says the direction -- ante_gross and
// bond_posted are out, bond_returned, payout and refund are in; subsidy and bond_forfeited are informational and are
// never added again (they are already inside ante_gross / bond_posted). Only `net` is signed: `net = Σ in - Σ out`,
// computed in BigInt. Network gas is excluded (`networkFeesIncluded: false`).
//
// Provenance (§4): chain entries carry the chain read's provenance; before a chain outcome exists the table's
// server-recorded terms and phase are used and labelled "server-recorded" or "pending"; `net` takes the weakest
// provenance of its inputs, and is unavailable (value null) when any input is.

import type { Fact, Junox, Provenance } from "../contract";
import type { GameMoneyTerms } from "../../rooms/gameRecord";
import type { FinancialGameRecord } from "../../escrow/moneyLifecycle";
import type { ChainView } from "./chainView";
import { chainFact, junox, pending, serverRecorded, unavailable, weakest, type ChainSource } from "./facts";

export type LedgerKind = "ante_gross" | "subsidy" | "bond_posted" | "bond_returned" | "bond_forfeited" | "payout" | "refund";
export interface LedgerEntry {
  readonly kind: LedgerKind;
  readonly amount: Junox;
  readonly fact: Fact<true>;
}
export interface Ledger {
  readonly entries: LedgerEntry[];
  readonly net: Fact<Junox>;
  readonly networkFeesIncluded: false;
}

export const PAYOUT_ROUTES: readonly string[] = Object.freeze([
  "all_consents_at_settle",
  "consent_completed",
  "finalized",
  "resolver_uphold",
  "resolver_replace",
  "resolver_timeout_payout",
  "settleable_timeout_payout",
  "remedy_foreclosure",
]);
export const REFUND_ROUTES: readonly string[] = Object.freeze([
  "creator_cancel",
  "deadline_cancel",
  "resolver_annul",
  "annul_by_consent",
  "liveness_refund",
  "settleable_timeout_refund",
  "resolver_timeout_refund",
  "review_annul",
  "remedy_timeout_annul",
  "remedy_annul",
]);
/** Routes that end a dispute in the same transaction, so the outcome's own bond fields describe that dispute. */
const DISPUTE_ENDING_ROUTES: readonly string[] = ["resolver_uphold", "resolver_replace", "resolver_annul", "resolver_timeout_payout", "resolver_timeout_refund"];
const BOND_RETURNED: readonly string[] = ["replaced", "annulled", "resolver_timeout", "annulled_by_consent"];

const SIGN: Readonly<Record<LedgerKind, -1 | 0 | 1>> = { ante_gross: -1, subsidy: 0, bond_posted: -1, bond_returned: 1, bond_forfeited: 0, payout: 1, refund: 1 };

const ZERO = BigInt(0);
const entry = (kind: LedgerKind, amount: bigint, fact: Fact<true>): LedgerEntry => ({ kind, amount: junox(amount), fact });
/** An entry whose amount cannot be proven: its amount is 0 and MEANINGLESS -- the fact says why. */
const unknownEntry = (kind: LedgerKind, reason: string): LedgerEntry => entry(kind, ZERO, unavailable<true>(reason));

/** `net = Σ signed entries`, at the weakest provenance of the entries it adds -- plus `extra` (e.g. a payout still
 *  pending, which is not an entry yet). Unavailable when any summed entry is. */
export function netOf(entries: readonly LedgerEntry[], extra: { provenance: Provenance; reason: string } | null = null): Fact<Junox> {
  let sum = ZERO;
  const provenances: Provenance[] = [];
  for (const e of entries) {
    const sign = SIGN[e.kind];
    if (sign === 0) continue;
    if (e.fact.provenance === "unavailable") return unavailable<Junox>(`${e.kind}: ${e.fact.reason ?? "unavailable"}`);
    provenances.push(e.fact.provenance);
    sum += BigInt(sign) * BigInt(e.amount.amount);
  }
  if (extra !== null) provenances.push(extra.provenance);
  const provenance = weakest(provenances);
  if (provenance === "unavailable") return unavailable<Junox>(extra?.reason ?? "unavailable");
  const value = junox(sum);
  if (provenance === "chain-confirmed" || provenance === "chain-observed") {
    /* Every summed input is a chain fact of one read: stamp the net with the weakest chain entry's stamp. */
    const stamp = entries.find((e) => SIGN[e.kind] !== 0 && e.fact.provenance === provenance)?.fact;
    return { value, provenance, ...(stamp?.height !== undefined ? { height: stamp.height } : {}), ...(stamp?.observedAt !== undefined ? { observedAt: stamp.observedAt } : {}) };
  }
  if (provenance === "pending") return pending(value, extra?.reason);
  return serverRecorded(value);
}

/** Where this account's seat sits on chain, as far as it can be proven. */
export type SeatOnChain =
  /** The frozen roster names the seat, and the chain shows its wallet at that index. */
  | { readonly kind: "seated"; readonly index: number; readonly wallet: string }
  /** The roster's wallet is not on the chain roster any more, before Start: a Withdraw. */
  | { readonly kind: "withdrawn"; readonly wallet: string }
  /** It cannot be proven which chain seat is this account's. */
  | { readonly kind: "unmapped"; readonly reason: string };

/** The roster maps `player_id -> chain seat -> payout wallet`; the chain must agree (wallet at that index). Before
 *  Start a Withdraw moves later seats up, so the wallet is looked for at any index. */
export function locateSeat(financial: FinancialGameRecord | null, playerId: string, chain: ChainView | null): SeatOnChain {
  const roster = financial?.roster ?? null;
  if (roster === null) return { kind: "unmapped", reason: "no frozen financial roster maps this seat to a chain seat" };
  const line = roster.roster.find((r) => r.player_id === playerId);
  if (line === undefined) return { kind: "unmapped", reason: "the frozen financial roster does not name this seat" };
  if (chain === null) return { kind: "seated", index: line.chain_seat_index, wallet: line.payout_address };
  const at = chain.seats.findIndex((s) => s.wallet === line.payout_address);
  if (at < 0) {
    return chain.started
      ? { kind: "unmapped", reason: "the chain roster does not hold this seat's wallet (chain-inconsistent)" }
      : { kind: "withdrawn", wallet: line.payout_address };
  }
  if (chain.started && at !== line.chain_seat_index) return { kind: "unmapped", reason: "the chain seat index differs from the frozen roster (chain-inconsistent)" };
  return { kind: "seated", index: at, wallet: line.payout_address };
}

/** The ledger from a successful chain read. */
export function ledgerFromChain(chain: ChainView, source: ChainSource, seat: SeatOnChain): Ledger {
  const fact = chainFact<true>(true, source);
  if (seat.kind === "withdrawn") {
    const why = "this seat withdrew before Start: the escrow removed it from the game and refunded its net deposit in that transaction, so neither amount is recorded on the game";
    const entries = [unknownEntry("ante_gross", why), unknownEntry("refund", why)];
    return { entries, net: netOf(entries), networkFeesIncluded: false };
  }
  if (seat.kind === "unmapped") {
    const entries = [unknownEntry("ante_gross", seat.reason)];
    return { entries, net: netOf(entries), networkFeesIncluded: false };
  }
  const onChain = chain.seats[seat.index];
  const entries: LedgerEntry[] = [entry("ante_gross", onChain.grossDeposit, fact), entry("subsidy", onChain.subsidyPaid, fact)];

  /* The challenge bond: only the challenger posted one. */
  const d = chain.dispute;
  if (d !== null && d.challenger === seat.wallet) {
    entries.push(entry("bond_posted", d.bond, fact));
    const route = chain.outcome?.route ?? null;
    const sameTx = route !== null && DISPUTE_ENDING_ROUTES.includes(route) ? chain.outcome : null;
    if (d.resolution === "unknown") {
      entries.push(unknownEntry("bond_returned", "the chain read does not say how the dispute ended"));
    } else if (d.resolution === "upheld") {
      if (sameTx !== null && sameTx.bondToPool !== null && sameTx.bondToPool !== d.bond) entries.push(unknownEntry("bond_forfeited", "the outcome's bond_to_pool disagrees with the dispute's bond"));
      else entries.push(entry("bond_forfeited", d.bond, fact));
    } else if (d.resolution !== null && BOND_RETURNED.includes(d.resolution)) {
      if (sameTx !== null && sameTx.bondReturned !== null && sameTx.bondReturned !== d.bond) entries.push(unknownEntry("bond_returned", "the outcome's bond_returned disagrees with the dispute's bond"));
      else entries.push(entry("bond_returned", d.bond, fact));
    }
    /* resolution null: still DISPUTED -- the bond is held beside the pool; nothing has come back yet. */
  }

  const o = chain.outcome;
  if (o === null) {
    return { entries, net: netOf(entries, { provenance: "pending", reason: `no chain outcome yet (escrow ${chain.state}): the payout or refund is pending` }), networkFeesIncluded: false };
  }
  const kind: LedgerKind | null = PAYOUT_ROUTES.includes(o.route) ? "payout" : REFUND_ROUTES.includes(o.route) ? "refund" : null;
  if (kind === null) entries.push(unknownEntry("payout", `the escrow route "${o.route}" is not one this ledger knows`));
  else if (seat.index >= o.amounts.length) entries.push(unknownEntry(kind, "the outcome has no amount for this chain seat"));
  else entries.push(entry(kind, o.amounts[seat.index], fact));
  return { entries, net: netOf(entries), networkFeesIncluded: false };
}

/** The ledger when the chain cannot be read (or no chain game is bound yet): the table's server-recorded terms and
 *  the financial phase, labelled as such. Nothing about the outcome is invented. */
export function ledgerWithoutChain(terms: GameMoneyTerms, financial: FinancialGameRecord | null, why: string): Ledger {
  const ante = BigInt(terms.ante_gross);
  const phase = financial?.phase ?? null;
  const bound = financial?.binding?.escrow != null;
  /* Started and still open: every seat deposited at the terms, nothing has been paid out. (Closed, disputed, held and
     cancelled tables are not here: their money moved, or may have, in ways only the chain can say.) */
  const dealt =
    financial !== null &&
    (["in-progress", "liveness", "terminal-eligible", "intent-prepared", "settleable"].includes(financial.phase) || (financial.phase === "funding" && financial.chain.started !== null));
  if (phase === "funding" && !dealt) {
    const entries = [entry("ante_gross", ante, pending<true>(true, "the table's terms: the deposit is expected, not yet seen on chain"))];
    return { entries, net: netOf(entries, { provenance: "pending", reason: `${why}; funding: nothing is settled` }), networkFeesIncluded: false };
  }
  if (dealt) {
    /* Start needs every seat funded at the table's terms, so the deposit is the server's own record of them. */
    const entries = [entry("ante_gross", ante, serverRecorded<true>(true))];
    return { entries, net: netOf(entries, { provenance: "pending", reason: `${why}; the payout or refund is pending` }), networkFeesIncluded: false };
  }
  const reason = !bound && financial !== null && phase !== "held" ? "no chain game is bound to this table" : phase === "held" ? `${why}; the table is held for operator review` : why;
  const entries = [unknownEntry("ante_gross", reason)];
  return { entries, net: netOf(entries), networkFeesIncluded: false };
}
