// frontend/src/gameEngine/vgpAmount.ts
//
// ==================================================================
//  STAGE 10.5 (S10-9): A WHOLE-VGP AMOUNT ON THE WIRE, AND THE ONE WAY TO READ IT
// ==================================================================
//
// THE DEBT. `ProposePrivatePurchase.price` / `PrivatePurchaseOffer.price` were JS numbers while the settlement
// the offer derives -- `BuyPrivateCompany.price` -- and the train offer beside it are strings, the contract's
// `Uint128` convention. The corporation-private offer now writes the string too. Stored logs already carry the
// numeric spelling, and a stored payload is settlement evidence (`logHash`, #1251): it is never rewritten, and
// the reducer keeps writing whichever spelling the message carried, so an old log replays to exactly the board
// it always did.
//
// SO A PRICE MAY ARRIVE IN TWO SPELLINGS, and every authority that reads one reads it HERE:
//   * canonical (every new write): a decimal string of digits with no sign, no leading zero (except "0" itself),
//     no exponent, no whitespace, no fraction -- the one spelling per value, so equal values are equal text;
//   * legacy (stored logs only): a JSON number that is a non-negative SAFE integer (and not -0).
// Anything else -- "1e2", " 100", "0x64", "100.0", "0100", "", 100.5, -5, NaN -- is MALFORMED, never coerced.
// `Number("1e2") === 100` is exactly the accidental acceptance this file exists to end.
//
// NO PRECISION IS LOST. Two spellings are compared as canonical TEXT, never through `Number`. A JS number is
// produced only on request (`wholeVgpNumber`) and only when the value is a safe integer; every bound a caller then
// applies (a private's price band, a treasury) is far inside that range.
//
// $0 IS A VALUE, NOT AN ERROR: "0" / 0 parse. Whether $0 is LEGAL is the transaction family's rule (the private
// band's floor is half the face value; a player <-> player trade admits $0), asked by its own authority.

/** A canonical whole-VGP amount: the new-write spelling (the contract's `Uint128` string convention). */
export type WholeVgpString = string;

/** The legacy spelling a pre-Stage-10.5 stored message may carry: a JSON number. Read, never newly written. */
export type LegacyVgpNumber = number;

/** What a reader may be handed: the canonical string, or a stored log's legacy number. */
export type VgpWire = WholeVgpString | LegacyVgpNumber;

const CANONICAL_WHOLE = /^(0|[1-9][0-9]*)$/;

/** The canonical string for a well-formed amount in either spelling, or `null` when it is malformed. */
export function canonicalWholeVgp(value: unknown): WholeVgpString | null {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) return null;
    return String(value);
  }
  if (typeof value === "string") return CANONICAL_WHOLE.test(value) ? value : null;
  return null;
}

/** Whether `value` is a well-formed whole-VGP amount in either spelling. */
export function isWholeVgp(value: unknown): value is VgpWire {
  return canonicalWholeVgp(value) !== null;
}

/** Whether two amounts are the SAME monetary value, whatever their spellings: `100` and `"100"` are; a malformed
 *  amount equals nothing (not even itself), so a comparison can never be satisfied by two bad inputs. */
export function sameWholeVgp(a: unknown, b: unknown): boolean {
  const left = canonicalWholeVgp(a);
  return left !== null && left === canonicalWholeVgp(b);
}

/** The amount as a JS number, for arithmetic against a bound -- `null` when malformed or beyond the safe-integer
 *  range (such a value is refused, never rounded). */
export function wholeVgpNumber(value: unknown): number | null {
  const canonical = canonicalWholeVgp(value);
  if (canonical === null) return null;
  const n = Number(canonical);
  return Number.isSafeInteger(n) ? n : null;
}

/** The canonical new-write spelling of a whole-dollar amount a producer (a UI control) holds as a number. Throws on
 *  a value that is not a non-negative safe integer: a producer handing a fraction to the wire is a coding error,
 *  and the authority would refuse it anyway. */
export function wholeVgpString(amount: number): WholeVgpString {
  const canonical = canonicalWholeVgp(amount);
  if (canonical === null) throw new RangeError(`Not a whole-VGP amount: ${String(amount)}`);
  return canonical;
}
