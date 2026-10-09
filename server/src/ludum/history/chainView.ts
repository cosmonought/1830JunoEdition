// LUDUM v1 -- player history (Lane C): ONE READING OF THE ESCROW'S `Game`, whatever form the port hands over.
//
// `LudumPorts.chainGame` returns `game: unknown /* parseGameResponse */`. Two forms are accepted, and nothing else:
//
//   RAW     the contract's own `GameResponse` JSON (`contracts/escrow/src/query.rs::game`): lowercase states, cosmwasm
//           nanosecond Timestamps. It is validated by the production parser (`parseGameResponse`, which throws on
//           anything unexpected) and then read for the fields that parser drops but the ledger needs, all of them
//           `state.rs` fields: `Seat.subsidy_paid`, `DisputeRecord.{disputed_at, resolution, resolved_at}` and
//           `Outcome.{bond_returned, bond_to_pool}`.
//   PARSED  `parseGameResponse`'s own `JunoGameResponse` (uppercase states, whole seconds). The dropped fields are
//           re-derived ONLY where the contract source makes them exact (below); otherwise they stay unknown (null)
//           and the ledger says "unavailable" rather than guessing.
//
// Derivations used for the PARSED form, each from the contract source:
//   * `subsidy_paid = gross_deposit - net_deposit`      (`execute/funding.rs`: net = gross - subsidy_cut(gross))
//   * `disputed_at = resolver_timeout_at - resolver_timeout_secs`, only while DISPUTED (`query.rs::deadlines`)
//   * the dispute's resolution from the terminal route (`execute/dispute.rs`): resolver_uphold -> upheld,
//     resolver_replace -> replaced, resolver_annul -> annulled, resolver_timeout_{payout,refund} -> resolver_timeout;
//     and a dispute record on a SETTLEABLE game -> resolver_timeout (the checkpoint fallback of the DISPUTED liveness
//     exit is the only way back from DISPUTED to SETTLEABLE). `resolved_at` is the outcome time for the resolver_* and
//     resolver_timeout_* routes (the same transaction); unknown otherwise.

import { JunoAbiError, parseGameResponse, type JunoGameResponse } from "../../escrow/juno/junoContract";

export type DisputeResolutionName = "upheld" | "replaced" | "annulled" | "resolver_timeout" | "annulled_by_consent";

export interface ChainSeatView {
  readonly wallet: string;
  readonly grossDeposit: bigint;
  readonly subsidyPaid: bigint;
  readonly netDeposit: bigint;
}

export interface ChainView {
  readonly chainGameId: string;
  /** `Game.state`, lowercased (the §4 escrow vocabulary). */
  readonly state: string;
  readonly anteGross: bigint;
  readonly anteNet: bigint;
  /** In `chain_seat_index` order (frozen at Start; before Start a Withdraw moves later seats up). */
  readonly seats: readonly ChainSeatView[];
  /** Start happened (the roster, bond and resolver are frozen). */
  readonly started: boolean;
  readonly resolverTimeoutSecs: bigint;
  readonly dispute: null | {
    readonly challenger: string;
    readonly bond: bigint;
    readonly evidenceHash: string;
    /** null: this form of the read does not carry it (PARSED, after the dispute ended). */
    readonly disputedAtSecs: bigint | null;
    /** null: unresolved (still DISPUTED). `unknown`: the read cannot say. */
    readonly resolution: DisputeResolutionName | null | "unknown";
    readonly resolvedAtSecs: bigint | null;
  };
  readonly outcome: null | {
    readonly route: string;
    /** Per seat, in `chain_seat_index` order: a payout or a refund (`state.rs::Outcome.amounts`). */
    readonly amounts: readonly bigint[];
    readonly atSecs: bigint;
    /** null: this form of the read does not carry it. */
    readonly bondReturned: bigint | null;
    readonly bondToPool: bigint | null;
  };
}

export type ChainViewResult = { readonly ok: true; readonly view: ChainView } | { readonly ok: false; readonly reason: string };

type Loose = Record<string, unknown>;
const isObject = (value: unknown): value is Loose => typeof value === "object" && value !== null && !Array.isArray(value);
const DECIMAL = /^(0|[1-9][0-9]{0,39})$/;
const NANOS = BigInt(1_000_000_000);
const RESOLUTIONS: readonly string[] = ["upheld", "replaced", "annulled", "resolver_timeout", "annulled_by_consent"];
const RAW_STATES: readonly string[] = ["funding", "funded", "in_progress", "settleable", "disputed", "settled", "cancelled", "annulled"];

class Unreadable extends Error {}
const need = (ok: boolean, where: string): void => {
  if (!ok) throw new Unreadable(`the chain answer has an unexpected ${where}`);
};
const dec = (value: unknown, where: string): bigint => {
  need(typeof value === "string" && DECIMAL.test(value), where);
  return BigInt(value as string);
};
const nanosToSecs = (value: unknown, where: string): bigint => dec(value, where) / NANOS;

/** The escrow's `Game`, read once into the shape the ledger uses -- or why it cannot be. */
export function readChainGame(game: unknown): ChainViewResult {
  try {
    if (!isObject(game) || !isObject(game.game)) return { ok: false, reason: "the chain answer is not a game" };
    const state = game.game.state;
    if (typeof state === "string" && RAW_STATES.includes(state)) return { ok: true, view: fromRaw(game) };
    return { ok: true, view: fromParsed(game as unknown as JunoGameResponse) };
  } catch (error) {
    if (error instanceof Unreadable || error instanceof JunoAbiError) return { ok: false, reason: error.message.slice(0, 200) };
    return { ok: false, reason: "the chain answer could not be read" };
  }
}

function fromRaw(raw: Loose): ChainView {
  const parsed = parseGameResponse(raw); // strict: throws JunoAbiError on anything unexpected
  const g = raw.game as Loose;
  const rawSeats = g.seats as unknown[];
  const seats = parsed.game.seats.map((seat, i) => {
    const r = rawSeats[i] as Loose;
    return { wallet: seat.wallet, grossDeposit: BigInt(seat.gross_deposit), subsidyPaid: dec(r.subsidy_paid, `seats[${i}].subsidy_paid`), netDeposit: BigInt(seat.net_deposit) };
  });
  let dispute: ChainView["dispute"] = null;
  if (parsed.game.dispute !== null) {
    const d = g.dispute as Loose;
    const resolution = d.resolution;
    need(resolution === null || (typeof resolution === "string" && RESOLUTIONS.includes(resolution)), "dispute.resolution");
    dispute = {
      challenger: parsed.game.dispute.challenger,
      bond: BigInt(parsed.game.dispute.bond),
      evidenceHash: parsed.game.dispute.evidence_hash,
      disputedAtSecs: nanosToSecs(d.disputed_at, "dispute.disputed_at"),
      resolution: resolution as DisputeResolutionName | null,
      resolvedAtSecs: d.resolved_at === null || d.resolved_at === undefined ? null : nanosToSecs(d.resolved_at, "dispute.resolved_at"),
    };
  }
  let outcome: ChainView["outcome"] = null;
  if (parsed.game.outcome !== null) {
    const o = g.outcome as Loose;
    outcome = {
      route: parsed.game.outcome.route,
      amounts: parsed.game.outcome.amounts.map((a) => BigInt(a)),
      atSecs: BigInt(parsed.game.outcome.at_secs),
      bondReturned: o.bond_returned === undefined ? null : dec(o.bond_returned, "outcome.bond_returned"),
      bondToPool: o.bond_to_pool === undefined ? null : dec(o.bond_to_pool, "outcome.bond_to_pool"),
    };
  }
  return common(parsed, seats, dispute, outcome);
}

function fromParsed(parsed: JunoGameResponse): ChainView {
  const g = parsed.game;
  need(isObject(g) && typeof g.state === "string" && Array.isArray(g.seats), "parsed game");
  const seats = g.seats.map((seat, i) => {
    const gross = dec(seat.gross_deposit, `seats[${i}].gross_deposit`);
    const net = dec(seat.net_deposit, `seats[${i}].net_deposit`);
    need(net <= gross, `seats[${i}] deposit split`);
    return { wallet: String(seat.wallet), grossDeposit: gross, subsidyPaid: gross - net, netDeposit: net };
  });
  const state = g.state.toLowerCase();
  need(RAW_STATES.includes(state), "game.state");
  const route = g.outcome?.route ?? null;
  let dispute: ChainView["dispute"] = null;
  if (g.dispute !== null) {
    const timeoutAt = parsed.deadlines?.resolver_timeout_at ?? null;
    const timeoutSecs = dec(g.terms.resolver_timeout_secs, "terms.resolver_timeout_secs");
    const byRoute: Record<string, DisputeResolutionName> = {
      resolver_uphold: "upheld",
      resolver_replace: "replaced",
      resolver_annul: "annulled",
      resolver_timeout_payout: "resolver_timeout",
      resolver_timeout_refund: "resolver_timeout",
    };
    const resolution: DisputeResolutionName | null | "unknown" =
      state === "disputed" ? null : route !== null && byRoute[route] !== undefined ? byRoute[route] : state === "settleable" ? "resolver_timeout" : "unknown";
    const sameTx = route !== null && byRoute[route] !== undefined;
    dispute = {
      challenger: String(g.dispute.challenger),
      bond: dec(g.dispute.bond, "dispute.bond"),
      evidenceHash: String(g.dispute.evidence_hash),
      disputedAtSecs: state === "disputed" && timeoutAt !== null ? dec(timeoutAt, "deadlines.resolver_timeout_at") - timeoutSecs : null,
      resolution,
      resolvedAtSecs: sameTx && g.outcome !== null ? dec(g.outcome.at_secs, "outcome.at_secs") : null,
    };
  }
  const outcome: ChainView["outcome"] =
    g.outcome === null
      ? null
      : { route: String(g.outcome.route), amounts: g.outcome.amounts.map((a, i) => dec(a, `outcome.amounts[${i}]`)), atSecs: dec(g.outcome.at_secs, "outcome.at_secs"), bondReturned: null, bondToPool: null };
  return common(parsed, seats, dispute, outcome);
}

function common(parsed: JunoGameResponse, seats: ChainSeatView[], dispute: ChainView["dispute"], outcome: ChainView["outcome"]): ChainView {
  const g = parsed.game;
  const state = g.state.toLowerCase();
  return {
    chainGameId: g.chain_game_id,
    state,
    anteGross: dec(g.ante_gross, "game.ante_gross"),
    anteNet: dec(g.ante_net, "game.ante_net"),
    seats,
    /* Start freezes the bond and the resolver (`execute/play.rs::start`); a game cancelled before Start has neither. */
    started: g.resolver !== null || g.bond !== null || !["funding", "funded"].includes(state) && state !== "cancelled",
    resolverTimeoutSecs: dec(g.terms.resolver_timeout_secs, "terms.resolver_timeout_secs"),
    dispute,
    outcome,
  };
}
