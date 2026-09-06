// frontend/src/utils/stateDigest.ts
//
// A short, exact fingerprint of a board, for catching two clients that have drifted apart.
//
// ==================================================================
//  DESIGN NOTE 1206: THE LOG'S CANONICAL FORM DOES NOT HELP HERE
// ==================================================================
//
// THE SETTLEMENT COMMITMENT AVOIDS CANONICALISATION ENTIRELY, and that was worth saying loudly when it was
// found: `SandboxAction.payload` is JSON TEXT minted once by the dispatching client and never re-serialized,
// so hashing the log is hashing bytes that already agree (#1188). No key ordering to fix, no number
// formatting to pin.
//
// NONE OF WHICH IS ANY USE FOR DIVERGENCE DETECTION, and the reason is worth stating plainly because it
// nearly went unnoticed. Every client holds the SAME LOG by construction -- that is what an append-only log
// IS. The whole failure this project has been chasing since §5a is two clients deriving DIFFERENT STATE from
// identical entries. So a log hash would agree in exactly the case worth catching.
//
// DETECTING IT MEANS HASHING STATE, WHICH MEANS CANONICALISING STATE. The trap I warned about for settlement
// is real here instead: `JSON.stringify` emits keys in insertion order, so two objects with identical
// contents built by different code paths serialise differently, and a digest built on that reports
// divergence on every second message. It works in a test and fails on one browser months later.
//
// SO THE RULES ARE EXPLICIT AND TESTED:
//
//   KEYS ARE SORTED, RECURSIVELY. Insertion order is a property of how an object was built, not of what it
//   contains, and two clients build the same board by different routes constantly -- one from a replay, one
//   from a live drain.
//
//   ARRAYS KEEP THEIR ORDER, because in this game order IS content: `active_operating_order` is the whole of
//   §5a, and `owned_trains` carries #275's identity as a position.
//
//   `undefined` IS OMITTED AND `null` IS KEPT. #232's rule, encoded: absent means "this build does not say"
//   and is indistinguishable from a key that was never written, while `null` is a positive answer somebody
//   recorded. Collapsing the two would hide exactly the field a divergence hunt wants to see.
//
//   NUMBERS GO THROUGH `String(n)`, and the project's own rule is what makes that safe: no floats anywhere
//   (fixed-point `Uint128` scaled to six places), so there is no `0.1 + 0.2` to format two ways. `-0` is
//   normalised to `0` because it is the one integer JavaScript prints two ways.
//
// THE HASH IS FNV-1a, AND #1051's LESSON IS OBSERVED RATHER THAN REPEATED. That note found the revenue die
// firing 29% at one face because `carcosaRollHits` read `spun % 10` -- FNV's LOW BITS are dominated by the
// characters processed last, and two nearly identical short keys share them. The fault was the modulus, not
// the hash. Here the whole 32 bits are used, over inputs thousands of characters long that differ throughout,
// and nothing takes a remainder of the result. Doubled to 64 bits with a second offset basis, because a
// 32-bit digest collides at around 77,000 comparisons by the birthday bound and a long game makes tens of
// thousands.
//
// THIS IS NOT A CRYPTOGRAPHIC HASH AND MUST NOT BECOME ONE BY ACCIDENT. It detects ACCIDENTAL divergence
// between cooperating clients. Settlement is a different job with an adversary in it, and it hashes the LOG
// with a real digest -- see the migration plan. Anything that starts trusting this value against a
// motivated party is a bug.

import type { GameStateResponse } from "./gameState";

/** The canonical text form of any JSON-ish value. Exported for the tests, and for a divergence report that
 *  wants to show WHERE two boards differ rather than only that they do. */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";

  const kind = typeof value;
  if (kind === "number") {
    const n = value as number;
    /* NOT FINITE IS A BUG, NOT A VALUE. `NaN` and the infinities have no JSON form and `JSON.stringify`
       silently writes `null` for them -- which would make a corrupted board digest as a clean one. Named
       instead, so a divergence hunt sees the corruption rather than a mismatch it cannot explain. */
    if (!Number.isFinite(n)) return `"__nonfinite:${String(n)}"`;
    // `-0` is the one integer JavaScript prints two ways, and `Object.is(-0, 0)` is false.
    return String(n === 0 ? 0 : n);
  }
  if (kind === "string" || kind === "boolean") return JSON.stringify(value);
  /* A function or a symbol on a board is a programming error rather than data; naming it beats `undefined`
     silently vanishing and taking a real difference with it. */
  if (kind === "function" || kind === "symbol") return `"__unserialisable:${kind}"`;

  if (Array.isArray(value)) {
    /* ORDER IS CONTENT. `active_operating_order` is the whole of §5a and `owned_trains` carries #275's
       identity as a position, so an array is never sorted here -- only its elements canonicalised.
       `undefined` INSIDE an array becomes `null`, matching `JSON.stringify`: a hole is a position, and
       dropping it would shift every index after it. */
    return `[${value.map((entry) => (entry === undefined ? "null" : canonicalJson(entry))).join(",")}]`;
  }

  if (kind === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      /* #232: `undefined` is "this build does not say" and must be indistinguishable from a key nobody
         wrote. `null` survives, because somebody recorded it on purpose. */
      .filter((key) => record[key] !== undefined)
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }

  // `undefined` at the top level. Reached only by a direct call; object keys are filtered above.
  return "null";
}

/** FNV-1a over one 32-bit lane. Kept private: the exported digest uses two.
 *
 *  THE PRIME BY SHIFTS, not by multiplication -- `hash * 16777619` overflows the 53-bit float mantissa and
 *  loses the high bits, which `gameVariants.ts` records having learned. */
function fnv1a(text: string, offsetBasis: number): number {
  let hash = offsetBasis >>> 0;
  for (let at = 0; at < text.length; at += 1) {
    hash ^= text.charCodeAt(at);
    hash =
      (hash +
        ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>>
      0;
  }
  return hash >>> 0;
}

/** A 64-bit fingerprint of the canonical text, as 16 lowercase hex characters. */
export function digestOf(canonical: string): string {
  /* TWO LANES, DIFFERENT BASES. One 32-bit lane collides at roughly 77,000 comparisons by the birthday
     bound, and a long game produces tens of thousands of settle points across a table -- close enough to
     matter, and a false divergence report costs a debugging session. The second basis is the FNV offset with
     its bits inverted; any independent constant does, and this one needs no explanation beyond being
     visibly not the first. */
  const low = fnv1a(canonical, 0x811c9dc5);
  const high = fnv1a(canonical, ~0x811c9dc5);
  return high.toString(16).padStart(8, "0") + low.toString(16).padStart(8, "0");
}

/** The fingerprint of a board.
 *
 *  THE WHOLE STATE, not a chosen subset, and that is the safer default: a digest over hand-picked fields
 *  reports agreement about everything it forgot to include, and the fields worth forgetting are exactly the
 *  ones nobody thought about. Both sides run the same build, so an additive field appears on both at once.
 *  A VERSION SKEW BETWEEN CLIENT AND SERVER IS THEREFORE A REAL FAILURE MODE and not a hypothetical: an old
 *  client will disagree with a new server about a field that is not a divergence at all. The transport has to
 *  carry a build identifier and say so plainly, rather than letting it surface as a phantom desync -- which
 *  is precisely the thing this whole migration exists to stop chasing. */
export function stateDigest(state: GameStateResponse): string {
  return digestOf(canonicalJson(state));
}
