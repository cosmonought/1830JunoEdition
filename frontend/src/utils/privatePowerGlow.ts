// frontend/src/utils/privatePowerGlow.ts
//
// The colour a private power's own hex is marked with.
//
// ==================================================================
//  DESIGN NOTE 727: A DIFFERENT GLOW FOR A DIFFERENT PERMISSION
// ==================================================================
//
// REQUESTED: "for a corporation that owns one or both of these private companies, the associated hexes could
// have the rainbow glow from the waterfall auction rather than the standard white glow, and clicking them
// would prompt the corporation to use the special power."
//
// THE WHITE GLOW MEANS ONE THING AND THIS IS NOT IT. Since #716 the white perimeter means "your network
// reaches here and a tile fits" -- a statement about REACH. F16 and B20 are exactly the hexes a corporation
// may build on WITHOUT reaching them, so marking them the same way would be the third time this project has
// drawn one mark for two rules (see #719's selector row, #723's terrain badge). The powers deserve their own
// mark because they are their own permission.
//
// AND THE AUCTION'S PALETTE IS THE RIGHT BORROWING, for a reason beyond novelty: #320 chose it precisely
// because it "runs the full hue circle so it is unmistakably not any status colour". A player has already met
// it once, on the private company cards, which is where they acquired the thing this hex is about. The
// association is not decorative.
//
// THE STOPS LIVE HERE rather than in the auction dashboard, because two surfaces now draw them and the board's
// is a CANVAS GRADIENT while the auction's is CSS -- the one thing that cannot be shared is the mechanism, so
// what must be shared is the list. Two hard-coded palettes drifting apart is how the association quietly stops
// being one.
//
// See docs/ai_architecture/canvas_rendering.md, privatePowerGlow.ts #727.

/** The full hue circle, first and last stop matching so a repeating gradient loops seamlessly (#344). */
export const PRIVATE_POWER_GLOW_STOPS: readonly string[] = [
  "#ff4d4d",
  "#ff9f1c",
  "#ffd400",
  "#4ade80",
  "#22d3ee",
  "#4f7cff",
  "#a855f7",
  "#ff4dc4",
  "#ff4d4d",
];

/** Which of the acting corporation's private powers are still usable, as `"q,r"` keys.
 *
 *  A SET RATHER THAN A BOOLEAN PER HEX, so the renderer asks one question and the caller owns every rule about
 *  ownership, forfeit and expiry. Empty for a corporation holding neither private, which is most of them --
 *  and empty is also the answer once a power is spent, because a mark that outlives its permission is #724 by
 *  another route. */
export function privatePowerGlowKeys(
  entries: readonly { hex: { q: number; r: number } | null; usable: boolean }[],
): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const entry of entries) {
    if (entry.usable && entry.hex) keys.add(`${entry.hex.q},${entry.hex.r}`);
  }
  return keys;
}
