// frontend/src/utils/terrainFee.ts
//
// What building on a hex costs, and why it costs it only once.
//
// ==================================================================
//  DESIGN NOTE 723: THE GROUND IS PAID FOR ONCE
// ==================================================================
//
// REPORTED: "terrain costs only charge a corporation the first time anything happens on the hex (be it a track
// lay or an upgrade over a preprinted one, like G19). It is wrong to keep charging the terrain cost for every
// lay track action on a terrain hex." And: "I mentioned this before but it doesn't seem to have been
// addressed."
//
// IT WAS ADDRESSED IN THE WRONG PLACE, WHICH IS WHY IT LOOKED FIXED. #673 built `pendingTileCost` -- the
// figure the radial confirm and the treasury projection show -- and implemented the rule there: an upgrade
// previews as free. The reducer that actually MOVES the money charged `terrainBuildFeeAt(q, r)` on every
// `LayTile`, unconditionally, and always had.
//
// SO THE UI SAID $0 AND THE TREASURY LOST $120, which is the worst possible arrangement of a wrong rule: the
// only surface a player could check agreed with them. #673's own note claims the opposite in as many words --
// "the same one the reducer charges ... so the projection, the badge and the debit cannot disagree" -- and it
// is false. That sentence is why this went unnoticed through a report: the note reads as though somebody had
// verified it, and nobody had.
//
// THE RECURRING SHAPE, ONCE MORE: a rule written into a projection, a predicate or a comment and never into
// the authority. #712's 60% cap, #713's successor rule, #714's private powers, and now this. What is different
// here is that the note asserted the enforcement existed, so the usual tell -- a rule with no call site -- was
// hidden behind a sentence.
//
// IT IS THE HEX THAT IS PAID FOR, NOT THE TILE. The report's parenthesis is the precise statement of the rule
// and it settles the case that would otherwise be ambiguous: G19 carries a PREPRINTED yellow tile and an $80
// river fee, and the first corporation to upgrade it pays. "Anything happens on the hex" is the trigger, so
// preprinted track does not count as somebody having already paid -- nobody has. Our board models preprints as
// hex properties (`printedColor`) rather than as entries in `tiles`, so this falls out correctly, but it falls
// out correctly by accident and is worth pinning.
//
// WHY A SET IN STATE RATHER THAN A LOOK AT THE BOARD. `mapGrid` is a separate atom: the reducer is handed one
// through `ctx`, but during an Undo rebuild the log is replayed inside a loop that closes over a React value
// captured at render, so it does not advance tile by tile. Keying the charge off it would work live and
// mis-charge on every replay -- and a replay is how every Undo settles, so the divergence would be permanent
// rather than transient. The set travels in the state the reducer replays, which makes the answer a function
// of the log and nothing else.
//
// See docs/ai_architecture/hex_tile_math.md, terrainFee.ts #723.

/** One hex, as a set key. `"q,r"` and not a template of the two numbers elsewhere: two spellings of one key is
 *  how a set silently stops matching itself. */
export function terrainFeeKey(q: number, r: number): string {
  return `${q},${r}`;
}

/** Whether this hex's terrain fee has already been charged to somebody. */
export function hasPaidTerrain(
  paid: readonly string[] | null | undefined,
  q: number,
  r: number,
): boolean {
  return (paid ?? []).includes(terrainFeeKey(q, r));
}

/** What laying on `(q, r)` costs RIGHT NOW: the posted fee on the first build, nothing after.
 *
 *  `feeAt` is injected rather than imported so the one rule can be asked by the reducer, by the projection and
 *  by a test with a fixture board -- and so this module states the RULE while `hexBoardData` states the
 *  TERRAIN. They change for different reasons. */
export function terrainFeeDue(
  paid: readonly string[] | null | undefined,
  q: number,
  r: number,
  feeAt: (q: number, r: number) => number,
): number {
  if (hasPaidTerrain(paid, q, r)) return 0;
  const fee = feeAt(q, r);
  return Number.isFinite(fee) && fee > 0 ? fee : 0;
}

/** The set after a lay on `(q, r)` has been settled.
 *
 *  Records only hexes that actually COST something, so the invariant stays readable: a key is here because a
 *  fee was paid for it. Clear ground never enters, and re-recording a hex already present returns the same
 *  array so a replayed lay cannot grow it. */
export function withTerrainPaid(
  paid: readonly string[] | null | undefined,
  q: number,
  r: number,
  fee: number,
): readonly string[] {
  const current = paid ?? [];
  if (fee <= 0) return current;
  const key = terrainFeeKey(q, r);
  return current.includes(key) ? current : [...current, key];
}
