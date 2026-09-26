// frontend/src/gameEngine/settlementAppraisal.ts
//
// ==================================================================
//  SET-0B: THE CANONICAL SETTLEMENT APPRAISAL
// ==================================================================
//
// WHAT THIS IS. The one integer function that turns a committed board into the escrow's settlement vector. The
// specification is `claude/SET0A_NET_WORTH_VALUATION_AUDIT_2026-09-25.md` (revision 2) §4-§8, §11, §12 and §18;
// nothing here chooses a rule, it implements that one:
//
//   NW(p) = cash(p) + Σ_c (pct(p,c) / 10) · sv(c) + Σ face(open private owned by p)      p not bankrupt
//   NW(p) =           Σ_c (pct(p,c) / 10) · sv(c)                                        p = bankrupt_president
//   sv(c) = state.market_positions[c].price   if c is PARRED (par_value set)
//         = 0                                 if c is UNPARRED (par_value null)
//
// UNPARRED, NOT UNFLOATED. A parred corporation has a share value from the moment its token goes on the chart
// (rulebook §4.2 / full §5.2, owner report #711); a parred-but-unfloated corporation's shares are worth that
// token, and only a corporation nobody has parred -- the C&A's PRR grant, the M&H's NYC share before NYC pars --
// scores $0. Floating is never read.
//
// THE BOARD'S OWN TOKEN, NEVER A MIRROR. The price comes from `state.market_positions`, which the reducer's chart
// step writes; no render mirror, no Classic price list, no par fallback. A Dynamic Stock Market $450 cell is just
// a number on the token.
//
// WHAT IS NOT AN INPUT: treasuries, trains of every kind, station tokens, licences, revenue fields, IPO and Bank
// Pool percentages (read only for the conservation check), the bank, auction bids, pending offers, `settled_price`,
// statistics, `total_juno_pool`, and the turn order. Result order is CHAIN SEAT ORDER (`seats[i].seat_index === i`).
//
// FAIL CLOSED. A structurally impossible board is refused with a named code (§18), never rounded, zeroed or
// ignored. Every amount is `bigint`; no `Number` arithmetic, no `Math.round`, no float percentage. No bigint
// literals either: the frontend targets ES5, so constants are built with `BigInt(...)` (as `anteMath.ts` does).
//
// ZERO IS A LEGAL ENTRY AND A LEGAL VECTOR HERE (SYN-10, Q13). Refusing a zero SUM is the payload builder's and
// the preview's job (`SETTLEMENT_ZERO_SUM`, `settlementPreview.ts`), not the appraiser's.

import type { GameStateResponse } from "./gameState";
import { SUPPORTED_RULES_ENGINE_VERSIONS } from "./rulesVersion";

/* ------------------------------------------------------------------ */
/* Errors                                                             */
/* ------------------------------------------------------------------ */

/** The frozen SET-0A codes (§12, §18), plus the policy/preview/digest codes. Two codes are SET-0B additions for
 *  shapes SET-0A names no code for: `MALFORMED_STATE` (a field of the wrong JSON type, e.g. `closed` not a boolean,
 *  a holdings list that is not an array, a mark naming no corporation) and `UNSUPPORTED_RULES_ENGINE_VERSION` (a
 *  pinned board this appraiser's semantics are not certified for). Neither replaces a SET-0A code. */
export type SettlementErrorCode =
  // board pin
  | "UNPINNED_BOARD"
  | "UNSUPPORTED_RULES_ENGINE_VERSION"
  // seats / roster (§12)
  | "BAD_SEAT_COUNT"
  | "SEAT_INDEX_NOT_CONTIGUOUS"
  | "DUPLICATE_PLAYER_ID"
  | "DUPLICATE_ROSTER_ENTRY"
  | "ROSTER_LENGTH_MISMATCH"
  | "STATE_PLAYER_NOT_SEATED"
  | "SEATED_PLAYER_NOT_IN_STATE"
  // cash
  | "CASH_FOR_UNSEATED_PLAYER"
  | "MISSING_CASH_ROW"
  | "DUPLICATE_CASH_ROW"
  // amounts / integers
  | "MALFORMED_AMOUNT"
  | "AMOUNT_OUT_OF_RANGE"
  | "MALFORMED_INTEGER"
  | "MALFORMED_PERCENT"
  // shares
  | "DUPLICATE_COMPANY"
  | "DUPLICATE_HOLDING_ROW"
  | "HOLDING_BY_UNSEATED_PLAYER"
  | "HOLDINGS_EXCEED_100"
  | "PERCENT_NOT_CONSERVED"
  | "PARRED_WITHOUT_MARK"
  | "UNPARRED_WITH_MARK"
  | "NON_POSITIVE_PRICE"
  // privates
  | "DUPLICATE_PRIVATE"
  | "PRIVATE_DOUBLE_OWNER"
  | "PRIVATE_OWNED_BY_UNSEATED_PLAYER"
  | "PRIVATE_OWNED_BY_UNKNOWN_CORPORATION"
  // bankruptcy
  | "BANKRUPT_NOT_SEATED"
  | "BANKRUPT_BEFORE_GAME_END"
  // shape (SET-0B addition)
  | "MALFORMED_STATE"
  // settlement layers
  | "SETTLEMENT_ZERO_SUM"
  | "REASON_NOT_SUPPORTED"
  // digest layer
  | "STATE_NOT_HASHABLE"
  | "NON_CANONICAL_STATE_TEXT";

/** A refusal. `message` is `CODE: detail`, the form the SET-0A golden file records. */
export class SettlementAppraisalError extends Error {
  readonly code: SettlementErrorCode;
  readonly detail: string;

  constructor(code: SettlementErrorCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "SettlementAppraisalError";
    this.code = code;
    this.detail = detail;
    // ES5 target: restore the prototype so `instanceof` holds for a subclassed Error.
    Object.setPrototypeOf(this, SettlementAppraisalError.prototype);
  }
}

const refuse = (code: SettlementErrorCode, detail: string): never => {
  throw new SettlementAppraisalError(code, detail);
};

/* ------------------------------------------------------------------ */
/* Integer rules (§11)                                                */
/* ------------------------------------------------------------------ */

const ZERO = BigInt(0);
const TEN = BigInt(10);
/** Every raw board amount must be one the reducer (which computes in safe-integer JS numbers) could produce. This
 *  bounds INPUTS only; totals and settlement weights are never capped here (A2). */
const MAX_BOARD_AMOUNT = BigInt(Number.MAX_SAFE_INTEGER);
const CANONICAL_DECIMAL = /^(0|[1-9][0-9]*)$/;

/** The contract's roster bound, 2..7 (OD-SET-2 (a); ESCROW-2 amendment A3). */
export const MIN_SETTLEMENT_SEATS = 2;
export const MAX_SETTLEMENT_SEATS = 7;

/** A canonical whole-VGP board amount as `bigint`. Only a STRING of canonical decimal digits is accepted: the legacy
 *  numeric spelling `vgpAmount.ts` admits is a wire-message allowance and never appears in state. */
export function parseBoardAmount(value: unknown, where: string): bigint {
  if (typeof value !== "string" || !CANONICAL_DECIMAL.test(value)) {
    return refuse("MALFORMED_AMOUNT", `${where}=${describe(value)}`);
  }
  const parsed = BigInt(value);
  if (parsed > MAX_BOARD_AMOUNT) return refuse("AMOUNT_OUT_OF_RANGE", `${where}=${value}`);
  return parsed;
}

/** A JS-number count (percentage, price, id) that must be a safe integer and not `-0`. */
function safeInteger(value: unknown, where: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || Object.is(value, -0)) {
    return refuse("MALFORMED_INTEGER", `${where}=${String(value)}`);
  }
  return value;
}

/** How a malformed amount is quoted in a refusal: JSON text, so `"-5"` and `500` read differently. */
function describe(value: unknown): string {
  if (value === undefined) return "undefined";
  if (typeof value === "bigint") return `${value.toString()}n`;
  try {
    const text = JSON.stringify(value);
    return text === undefined ? String(value) : text;
  } catch {
    return String(value);
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** An own ENUMERABLE property -- exactly what `canonicalJson` (`Object.keys`) commits to, so a non-enumerable or
 *  inherited field can never be appraised without being hashed. */
const own = (record: Record<string, unknown>, key: string): unknown =>
  Object.prototype.propertyIsEnumerable.call(record, key) ? record[key] : undefined;

/* ------------------------------------------------------------------ */
/* The plain snapshot: one read of every value                        */
/* ------------------------------------------------------------------ */

const notHashable = (detail: string): never => refuse("STATE_NOT_HASHABLE", detail);

function snapshotValue(value: unknown, path: string, stack: object[]): unknown {
  if (value === null) return null;
  switch (typeof value) {
    case "string":
      /* canonicalJson's own refusal markers: text carrying one was produced from a board that had no JSON form
         (raw `canonicalJson` output fed to `appraiseCommittedState`). Refused wherever it appears. */
      if (value.indexOf("__nonfinite:") === 0 || value.indexOf("__unserialisable:") === 0) {
        notHashable(`${path} carries a canonicalJson sentinel`);
      }
      return value;
    case "boolean":
      return value;
    case "number":
      if (!Number.isFinite(value)) notHashable(`${path} is ${String(value)}`);
      // -0 is read as the 0 the canonical text commits to, so the live and committed paths see one board.
      return value === 0 ? 0 : value;
    case "object":
      break;
    default:
      // undefined here means a top-level or array-element `undefined`; object properties handle theirs below.
      return notHashable(`${path} is ${typeof value === "undefined" ? "undefined" : `a ${typeof value}`}`);
  }
  const object = value as object;
  if (stack.indexOf(object) >= 0) notHashable(`${path} is a cycle`);
  stack.push(object);
  const keys = Reflect.ownKeys(object);
  let copy: unknown;
  if (Array.isArray(object)) {
    const length = (object as unknown[]).length;
    const out: unknown[] = [];
    for (let at = 0; at < length; at += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(object, String(at));
      if (descriptor === undefined) notHashable(`${path}[${at}] is a hole`);
      if (descriptor!.get !== undefined || descriptor!.set !== undefined) notHashable(`${path}[${at}] is an accessor`);
      if (descriptor!.value === undefined) notHashable(`${path}[${at}] is undefined`);
      out.push(snapshotValue(descriptor!.value, `${path}[${at}]`, stack));
    }
    // An array carries nothing but its elements and its length: any other own key is state the hash would drop.
    for (const key of keys) {
      if (key === "length" || (typeof key === "string" && /^(0|[1-9][0-9]*)$/.test(key) && Number(key) < length)) continue;
      notHashable(`${path} carries a non-index key ${String(key)}`);
    }
    copy = out;
  } else {
    const proto = Object.getPrototypeOf(object);
    if (proto !== Object.prototype && proto !== null) notHashable(`${path} is not a plain object`);
    const out: Record<string, unknown> = {};
    for (const key of keys) {
      if (typeof key === "symbol") notHashable(`${path} has a symbol key`);
      const name = key as string;
      if (name === "__proto__") notHashable(`${path} has a __proto__ key`);
      const descriptor = Object.getOwnPropertyDescriptor(object, name)!;
      if (!descriptor.enumerable) notHashable(`${path}.${name} is not enumerable`);
      if (descriptor.get !== undefined || descriptor.set !== undefined) notHashable(`${path}.${name} is an accessor`);
      // `undefined` properties are dropped, exactly as `canonicalJson` drops them (#232): absent == undefined.
      if (descriptor.value === undefined) continue;
      out[name] = snapshotValue(descriptor.value, `${path}.${name}`, stack);
    }
    copy = out;
  }
  stack.pop();
  return copy;
}

/**
 * A deep PLAIN copy of a board, made by reading every value exactly once, or `STATE_NOT_HASHABLE`.
 *
 * WHY A COPY. `canonicalJson` and the appraiser each read the board; a getter, a Proxy, a non-enumerable or inherited
 * field, a hole or a symbol key could make two reads -- or the two readers -- see different boards. The snapshot
 * reads once, refuses everything that is not plain JSON data (non-finite numbers, bigints, functions, symbols, class
 * instances, accessors, cycles, holes, `undefined` array elements, `__proto__` keys, non-index array keys), and
 * returns ordinary objects whose `canonicalJson` is exactly what the hash commits to and whose fields are exactly
 * what the appraiser reads. Both the hash and the appraisal are computed from a snapshot, never from the caller's
 * object.
 */
export function settlementSnapshot(state: unknown): Record<string, unknown> {
  if (!isRecord(state)) return notHashable("the board is not a plain object");
  try {
    return snapshotValue(state, "$", []) as Record<string, unknown>;
  } catch (error) {
    if (error instanceof SettlementAppraisalError) throw error;
    // A revoked Proxy, a throwing trap, nesting deep enough to exhaust the stack: not a board, and a coded refusal.
    return notHashable(`the board could not be read (${error instanceof Error ? error.name : "error"})`);
  }
}

/** `null` and absent are the same answer: `canonicalJson` drops `undefined` and keeps `null` (§17). */
const absent = (value: unknown): boolean => value === undefined || value === null;

/* ------------------------------------------------------------------ */
/* Public shapes                                                      */
/* ------------------------------------------------------------------ */

/** One escrow seat: `player_id` is the log's seat id; `seat_index` is the chain roster position (deposit order).
 *  Supplied from `SetupGame.escrow.seats[]`, never from a client. */
export interface SettlementSeat {
  seat_index: number;
  player_id: string;
}

/** One holding row, valued. `share_value` is `null` for an unparred corporation (whose shares score $0). */
export interface SettlementHoldingLine {
  company_id: number;
  ticker: string;
  percent: number;
  share_value: bigint | null;
  value: bigint;
}

/** One private counted for the seat: open and player-owned, at printed face (never `settled_price`). */
export interface SettlementPrivateLine {
  private_id: number;
  face: bigint;
}

/** One seat's appraisal. `total` is the settlement vector entry. */
export interface SeatAppraisal {
  player_id: string;
  seat_index: number;
  /** Cash as the board holds it. */
  cash_state: bigint;
  /** Cash as the settlement counts it: `cash_state`, or 0 for the bankrupt president (rulebook 6.6.3 note). */
  cash_counted: bigint;
  shares: bigint;
  /** Face value of the privates counted (0 for the bankrupt president). */
  privates: bigint;
  total: bigint;
  bankrupt: boolean;
  /** Every holding row of the seat, in `public_companies` order, unparred rows included at $0. */
  holdings: readonly SettlementHoldingLine[];
  /** The privates counted, in `private_companies` order. Empty for the bankrupt president. */
  private_lines: readonly SettlementPrivateLine[];
}

/* ------------------------------------------------------------------ */
/* The appraiser                                                      */
/* ------------------------------------------------------------------ */

interface CompanyFacts {
  company_id: number;
  ticker: string;
  /** `null` when unparred. */
  share_value: bigint | null;
  /** player -> percent */
  holdings: Map<string, number>;
  /** Holding rows in board order, for the lines. */
  order: Array<{ player: string; percent: number }>;
}

function checkPin(state: Record<string, unknown>): void {
  const version = own(state, "rules_engine_version");
  if (absent(version)) refuse("UNPINNED_BOARD", `rules_engine_version=${String(version)}`);
  if (typeof version !== "number" || !Number.isSafeInteger(version) || SUPPORTED_RULES_ENGINE_VERSIONS.indexOf(version) < 0) {
    refuse(
      "UNSUPPORTED_RULES_ENGINE_VERSION",
      `rules_engine_version=${describe(version)} (supported: ${SUPPORTED_RULES_ENGINE_VERSIONS.join(", ")})`,
    );
  }
}

/** Validates the mapping. Returns player -> seat_index and the seated ids in seat order -- read ONCE here and used
 *  everywhere after, so a seat object that answered differently on a second read cannot move a payout. */
function checkSeats(state: Record<string, unknown>, seats: unknown): { seated: Map<string, number>; ids: string[] } {
  if (!Array.isArray(seats)) return refuse("BAD_SEAT_COUNT", `n=${describe(seats)}`);
  const n = seats.length;
  if (n < MIN_SETTLEMENT_SEATS || n > MAX_SETTLEMENT_SEATS) refuse("BAD_SEAT_COUNT", `n=${n}`);

  const seated = new Map<string, number>();
  const ids: string[] = [];
  for (let position = 0; position < n; position += 1) {
    const seat = seats[position] as unknown;
    if (!isRecord(seat)) refuse("MALFORMED_STATE", `seats[${position}] is not a seat`);
    const record = seat as Record<string, unknown>;
    const index = own(record, "seat_index");
    if (index !== position) {
      refuse("SEAT_INDEX_NOT_CONTIGUOUS", `position ${position} carries seat_index ${describe(index)}`);
    }
    const id = own(record, "player_id");
    if (typeof id !== "string" || id.length === 0) {
      refuse("MALFORMED_STATE", `seats[${position}].player_id=${describe(id)}`);
    }
    if (seated.has(id as string)) refuse("DUPLICATE_PLAYER_ID", id as string);
    seated.set(id as string, position);
    ids.push(id as string);
  }

  const roster = own(state, "player_addresses");
  if (!Array.isArray(roster)) return refuse("MALFORMED_STATE", "player_addresses is not an array");
  const inState = new Map<string, true>();
  for (const entry of roster as unknown[]) {
    if (typeof entry !== "string") return refuse("MALFORMED_STATE", `player_addresses entry ${describe(entry)}`);
    if (inState.has(entry)) refuse("DUPLICATE_ROSTER_ENTRY", entry);
    inState.set(entry, true);
  }
  if (roster.length !== n) refuse("ROSTER_LENGTH_MISMATCH", `state ${roster.length} vs seats ${n}`);
  for (const entry of roster as string[]) {
    if (!seated.has(entry)) refuse("STATE_PLAYER_NOT_SEATED", entry);
  }
  seated.forEach((_index, id) => {
    if (!inState.has(id)) refuse("SEATED_PLAYER_NOT_IN_STATE", id);
  });
  return { seated, ids };
}

/** The bankrupt president, or `null`. Valid only when seated and at `GameEnd` (§8; DECISIONS A7). */
function checkBankrupt(state: Record<string, unknown>, seated: Map<string, number>): string | null {
  const bankrupt = own(state, "bankrupt_president");
  if (absent(bankrupt)) return null;
  if (typeof bankrupt !== "string" || !seated.has(bankrupt)) {
    return refuse("BANKRUPT_NOT_SEATED", typeof bankrupt === "string" ? bankrupt : describe(bankrupt));
  }
  const round = own(state, "current_round_type");
  if (round !== "GameEnd") refuse("BANKRUPT_BEFORE_GAME_END", String(round));
  return bankrupt;
}

function readCash(state: Record<string, unknown>, seated: Map<string, number>): Map<string, bigint> {
  const rows = own(state, "player_cash");
  if (!Array.isArray(rows)) return refuse("MALFORMED_STATE", "player_cash is not an array");
  const cash = new Map<string, bigint>();
  for (const row of rows as unknown[]) {
    if (!isRecord(row)) return refuse("MALFORMED_STATE", "player_cash row is not an object");
    const player = own(row, "player");
    if (typeof player !== "string") return refuse("MALFORMED_STATE", `player_cash row player=${describe(player)}`);
    if (!seated.has(player)) refuse("CASH_FOR_UNSEATED_PLAYER", player);
    if (cash.has(player)) refuse("DUPLICATE_CASH_ROW", player);
    cash.set(player, parseBoardAmount(own(row, "cash_vgp"), `cash_vgp[${player}]`));
  }
  seated.forEach((_index, id) => {
    if (!cash.has(id)) refuse("MISSING_CASH_ROW", id);
  });
  return cash;
}

/** A percentage row or pool: safe integer, multiple of 10, within [min, 100]. */
function percentOf(value: unknown, where: string, min: number): number {
  const pct = safeInteger(value, where);
  if (pct % 10 !== 0 || pct < min || pct > 100) refuse("MALFORMED_PERCENT", `${where}=${pct}`);
  return pct;
}

function readCompanies(state: Record<string, unknown>, seated: Map<string, number>): CompanyFacts[] {
  const companies = own(state, "public_companies");
  if (!Array.isArray(companies)) return refuse("MALFORMED_STATE", "public_companies is not an array");

  const marksRaw = own(state, "market_positions");
  if (!absent(marksRaw) && !isRecord(marksRaw)) return refuse("MALFORMED_STATE", "market_positions is not an object");
  const marks = (absent(marksRaw) ? {} : marksRaw) as Record<string, unknown>;

  const facts: CompanyFacts[] = [];
  const ids = new Map<number, true>();
  for (const raw of companies as unknown[]) {
    if (!isRecord(raw)) return refuse("MALFORMED_STATE", "public_companies entry is not an object");
    const id = safeInteger(own(raw, "company_id"), "company.company_id");
    const tickerRaw = own(raw, "ticker");
    if (typeof tickerRaw !== "string" || tickerRaw.length === 0) {
      return refuse("MALFORMED_STATE", `company ${id}.ticker=${describe(tickerRaw)}`);
    }
    const ticker = tickerRaw;
    if (ids.has(id)) refuse("DUPLICATE_COMPANY", String(id));
    ids.set(id, true);

    /* PARRED IS `par_value` SET. Its spelling is validated for every corporation, held or not (the SET-0A
       prototype's own review caught a draft that skipped unheld ones). */
    const par = own(raw, "par_value");
    const parred = !absent(par);
    if (parred) parseBoardAmount(par, `${ticker}.par_value`);

    const mark = own(marks, String(id));
    let shareValue: bigint | null = null;
    if (parred) {
      if (absent(mark)) refuse("PARRED_WITHOUT_MARK", ticker);
      if (!isRecord(mark)) return refuse("MALFORMED_STATE", `market_positions[${id}] is not a mark`);
      const price = safeInteger(own(mark, "price"), `${ticker}.mark.price`);
      if (price <= 0) refuse("NON_POSITIVE_PRICE", `${ticker}=${price}`);
      shareValue = BigInt(price);
    } else if (!absent(mark)) {
      refuse("UNPARRED_WITH_MARK", ticker);
    }

    const rows = own(raw, "player_holdings");
    if (!Array.isArray(rows)) return refuse("MALFORMED_STATE", `${ticker}.player_holdings is not an array`);
    const holdings = new Map<string, number>();
    const order: Array<{ player: string; percent: number }> = [];
    let held = 0;
    for (const row of rows as unknown[]) {
      if (!isRecord(row)) return refuse("MALFORMED_STATE", `${ticker}.player_holdings row is not an object`);
      const player = own(row, "player");
      if (typeof player !== "string") return refuse("MALFORMED_STATE", `${ticker}.holding player=${describe(player)}`);
      if (!seated.has(player)) refuse("HOLDING_BY_UNSEATED_PLAYER", `${ticker}:${player}`);
      if (holdings.has(player)) refuse("DUPLICATE_HOLDING_ROW", `${ticker}:${player}`);
      /* 0% ROWS ARE REFUSED: the state type omits them and every corpus board agrees (§11). */
      const pct = percentOf(own(row, "percentage"), `${ticker}.holding[${player}]`, 10);
      holdings.set(player, pct);
      order.push({ player, percent: pct });
      held += pct;
    }
    const ipo = percentOf(own(raw, "ipo_pool_percentage"), `${ticker}.ipo_pool_percentage`, 0);
    const pool = percentOf(own(raw, "bank_pool_percentage"), `${ticker}.bank_pool_percentage`, 0);
    /* CONSERVATION. Held + IPO + Bank Pool is exactly 100 on every certified board; a minted certificate (DA-F6's
       C&A grant from an empty pile) is exactly what this refuses. Every term is a small safe integer, so this
       JS-number sum is exact. */
    if (held > 100) refuse("HOLDINGS_EXCEED_100", `${ticker}=${held}`);
    if (held + ipo + pool !== 100) {
      refuse("PERCENT_NOT_CONSERVED", `${ticker}: holders ${held} + ipo ${ipo} + pool ${pool}`);
    }
    facts.push({ company_id: id, ticker, share_value: shareValue, holdings, order });
  }

  /* A MARK NAMING NO CORPORATION is not a price of anything; a board carrying one is not a board this engine
     produced. `null` entries for unparred corporations are the ordinary shape and pass. */
  for (const key of Object.keys(marks)) {
    if (absent(marks[key])) continue;
    if (!facts.some((fact) => String(fact.company_id) === key)) {
      refuse("MALFORMED_STATE", `market_positions[${key}] names no corporation`);
    }
  }
  return facts;
}

interface PrivateFacts {
  private_id: number;
  closed: boolean;
  owner: string | null;
  face: bigint;
}

function readPrivates(
  state: Record<string, unknown>,
  seated: Map<string, number>,
  companies: readonly CompanyFacts[],
): PrivateFacts[] {
  const privates = own(state, "private_companies");
  if (!Array.isArray(privates)) return refuse("MALFORMED_STATE", "private_companies is not an array");
  const out: PrivateFacts[] = [];
  const ids = new Map<number, true>();
  for (const raw of privates as unknown[]) {
    if (!isRecord(raw)) return refuse("MALFORMED_STATE", "private_companies entry is not an object");
    const id = safeInteger(own(raw, "private_id"), "private.private_id");
    if (ids.has(id)) refuse("DUPLICATE_PRIVATE", String(id));
    ids.set(id, true);

    const closed = own(raw, "closed");
    if (typeof closed !== "boolean") return refuse("MALFORMED_STATE", `private ${id}.closed=${describe(closed)}`);

    const ownerRaw = own(raw, "owner");
    const corpRaw = own(raw, "owner_protocol_id");
    const owner = absent(ownerRaw) ? null : ownerRaw;
    const corp = absent(corpRaw) ? null : safeInteger(corpRaw, `private ${id}.owner_protocol_id`);
    if (owner !== null && typeof owner !== "string") {
      return refuse("MALFORMED_STATE", `private ${id}.owner=${describe(owner)}`);
    }
    if (owner !== null && corp !== null) refuse("PRIVATE_DOUBLE_OWNER", String(id));
    if (owner !== null && !seated.has(owner as string)) {
      refuse("PRIVATE_OWNED_BY_UNSEATED_PLAYER", `${id}:${owner as string}`);
    }
    if (corp !== null && !companies.some((company) => company.company_id === corp)) {
      refuse("PRIVATE_OWNED_BY_UNKNOWN_CORPORATION", `${id}:${corp}`);
    }
    /* THE PRINTED FACE, validated on every private: `cost` must be a canonical POSITIVE whole amount (§7). */
    const face = parseBoardAmount(own(raw, "cost"), `private ${id}.cost`);
    if (face === ZERO) refuse("MALFORMED_AMOUNT", `private ${id}.cost="0" (a face value is positive)`);
    out.push({ private_id: id, closed: closed as boolean, owner: owner as string | null, face });
  }
  return out;
}

const frozen = <T>(value: T): T => Object.freeze(value);

/**
 * Appraises every seat of a board, in chain seat order.
 *
 * `seats` is the escrow mapping (`SetupGame.escrow.seats[]`): 2..7 entries, `seats[i].seat_index === i`, each
 * player exactly once, and exactly the board's players. The board's turn order is never read for anything but
 * set equality. Throws `SettlementAppraisalError` on any structurally impossible input.
 */
export function appraiseSeats(state: GameStateResponse, seats: readonly SettlementSeat[]): readonly SeatAppraisal[] {
  if (!isRecord(state)) return refuse("MALFORMED_STATE", "the board is not an object");
  /* THE SNAPSHOT, NOT THE CALLER'S OBJECT: the same one-read plain copy the hash is computed from, so the appraiser
     and `terminalStateHashV1` accept the same boards and read the same fields. */
  const board = settlementSnapshot(state);

  checkPin(board);
  const { seated, ids } = checkSeats(board, seats);
  const bankrupt = checkBankrupt(board, seated);
  const cash = readCash(board, seated);
  const companies = readCompanies(board, seated);
  const privates = readPrivates(board, seated, companies);

  const result: SeatAppraisal[] = [];
  for (let index = 0; index < ids.length; index += 1) {
    const player = ids[index];
    const isBankrupt = player === bankrupt;

    let shares = ZERO;
    const holdings: SettlementHoldingLine[] = [];
    for (const company of companies) {
      const pct = company.holdings.get(player);
      if (pct === undefined) continue;
      /* pct is a validated multiple of 10: `BigInt(pct) / 10` is exact. The president's certificate and the LPF
         double certificate are 20% = two units; certificate cards never matter to value. */
      const units = BigInt(pct) / TEN;
      const value = company.share_value === null ? ZERO : units * company.share_value;
      shares += value;
      holdings.push(
        frozen({ company_id: company.company_id, ticker: company.ticker, percent: pct, share_value: company.share_value, value }),
      );
    }

    /* OPEN AND PLAYER-OWNED, AT FACE. Closed, corporation-owned and unsold privates add nothing (§7.0). The
       bankrupt president's privates are not counted (6.6.3 names shares only; OD-SET-1 (a)). */
    const privateLines: SettlementPrivateLine[] = [];
    let privateTotal = ZERO;
    if (!isBankrupt) {
      for (const priv of privates) {
        if (priv.closed || priv.owner !== player) continue;
        privateLines.push(frozen({ private_id: priv.private_id, face: priv.face }));
        privateTotal += priv.face;
      }
    }

    const cashState = cash.get(player) as bigint;
    const cashCounted = isBankrupt ? ZERO : cashState;
    result.push(
      frozen({
        player_id: player,
        seat_index: index,
        cash_state: cashState,
        cash_counted: cashCounted,
        shares,
        privates: privateTotal,
        total: cashCounted + shares + privateTotal,
        bankrupt: isBankrupt,
        holdings: frozen(holdings),
        private_lines: frozen(privateLines),
      }),
    );
  }
  return frozen(result);
}

/** The base settlement vector: `result[i]` is the net worth of `seats[i]`, whole VGP, in chain seat order. */
export function baseNetWorthVector(state: GameStateResponse, seats: readonly SettlementSeat[]): readonly bigint[] {
  return frozen(appraiseSeats(state, seats).map((seat) => seat.total));
}
