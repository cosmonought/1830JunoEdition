// frontend/src/utils/dhPower.ts
//
// The Delaware & Hudson's F16 powers, and the order they have to happen in.
//
// ==================================================================
//  DESIGN NOTE 725: ONE POWER IN TWO STEPS, NOT TWO POWERS
// ==================================================================
//
// REPORTED, in three parts:
//   (a) "I click the 'Lay Track' button ... and it illuminates the correct hex, but it does not allow me to
//       actually lay track. The special power allows players to lay the track without respect to network
//       connectivity rules."
//   (b) "the Place Station for free action does seem to work, but it should only be allowed if the track lay
//       also happened (so the rules summary ... is inaccurate)"
//   (c) "players either lay track #57 and pay the $120 mountain fee, OR they lay track #57 and pay the mountain
//       fee AND place a free station. Conversely, if another player has already laid track on F16, all of DH's
//       powers are forfeited."
//
// #442 GOT THE STRUCTURE EXACTLY BACKWARDS, and said so in as many words: "the rulebook grants the tile and the
// token independently -- a corporation may take either, both, or neither -- and one button could not express
// that". That reasoning produced two independent buttons, which is why the token worked on its own. The truth
// is the opposite: there is ONE power with an optional second half, and the token is unreachable without the
// lay. Two buttons are still the right control; what was missing is that the second depends on the first.
//
// AND (a) IS A CONSEQUENCE OF THE SAME MISREADING. The lay was routed through the ordinary tile flow, which
// since #716 refuses to open a ring on any hex outside the acting corporation's network -- correct for an
// ordinary lay and precisely what this power exists to override. The power's whole value is reaching F16
// before your track does. So the button lit the hex and the click did nothing, which reads as a broken
// control rather than as a rule.
//
// THE FORFEIT IS WHAT MAKES THE $120 ORDINARY -- stated carefully, because the first version of this paragraph
// was not. It said "the D&H lay is always the FIRST build on that hex", which reads as a claim about F16 and is
// false: anybody may build there first, and usually will if the D&H sits on its power. REPORTED: "The forfeit
// does not mean that F16 can only have its first track lay by a corporation owning DH."
//
// The true and much narrower statement is conditional. WHENEVER THE POWER'S LAY IS TAKEN, F16 was unbuilt a
// moment earlier -- because a built F16 would already have forfeited it. So the power's lay, on the occasions
// it happens at all, is a first build, and #723's terrain ledger charges the mountain fee through the ordinary
// path with no special case. Nothing here reserves the hex.
//
// AND THE FORFEIT IS INDIFFERENT TO WHO BUILT. Confirmed on report: a tile laid on F16 by the OWNING
// corporation's ordinary lay forfeits the power exactly as a rival's would. The power is a specific lay, not a
// claim on the hex, and satisfying it by other means does not satisfy it. That is a sharp edge -- a president
// can spend their own power without noticing -- so it is warned about at the moment of the lay rather than
// discovered afterwards; see `dhSelfLayWarning` below.
//
// CONFIRMED SEPARATELY, because the report did not say and the caption could not be trusted:
//   * the F16 lay is INSTEAD OF the corporation's normal tile lay for the turn, not in addition to it. #442's
//     caption claimed "in addition to its normal lay" and that claim is now known false.
//   * the free token is IN ADDITION TO the corporation's normal token placement. It still comes out of the
//     corporation's own token supply -- free means no cash, not no token.
//
// See docs/ai_architecture/contract_economy.md, dhPower.ts #725.

/** The Delaware & Hudson's `private_id`, matching `privateReservations.ts`. */
export const DH_PRIVATE_ID = 3;

/** F16 -- Scranton. The only hex either half of this power can touch. */
export const DH_HEX_LABEL = "F16";

/** The tile the power lays. A mountain hex with no city takes exactly one yellow tile, and naming it here
 *  keeps the rules summary and the picker quoting the same number. */
export const DH_TILE_ID = 57;

export interface DhPowerInput {
  /** Whether F16 already carries a laid tile. */
  hexBuilt: boolean;
  /** Whether the D&H's own lay has been taken. */
  layUsed: boolean;
  /** Whether the free token has been taken. */
  tokenUsed: boolean;
}

export interface DhPowerState {
  /** Somebody else built on F16 first: both halves are gone for good. */
  forfeited: boolean;
  layAvailable: boolean;
  tokenAvailable: boolean;
  /** Why the lay cannot be taken, or `null`. */
  layBlockedReason: string | null;
  /** Why the token cannot be taken, or `null`. */
  tokenBlockedReason: string | null;
}

const FORFEITED =
  `Another corporation has already built on ${DH_HEX_LABEL}, so the D&H's powers are gone for the rest of the game.`;

/** THE ORDER, AND WHAT CLOSES EACH DOOR.
 *
 *  `hexBuilt && !layUsed` is the forfeit test, and the conjunction is the whole of it: a tile on F16 that this
 *  power did not lay can only have come from somebody else. Testing `hexBuilt` alone would forfeit the power
 *  the instant it was used, taking the token with it. */
export function dhPowerState(input: DhPowerInput): DhPowerState {
  const forfeited = input.hexBuilt && !input.layUsed;
  if (forfeited) {
    return {
      forfeited: true,
      layAvailable: false,
      tokenAvailable: false,
      layBlockedReason: FORFEITED,
      tokenBlockedReason: FORFEITED,
    };
  }

  const layAvailable = !input.layUsed;
  /* (b), AS A GATE RATHER THAN A SENTENCE. The token is the second half of the lay, so it cannot be reached
     until the lay has happened -- which is what makes greying it the honest control: the player is not being
     refused, they are being shown the order. */
  const tokenAvailable = input.layUsed && !input.tokenUsed;

  return {
    forfeited: false,
    layAvailable,
    tokenAvailable,
    layBlockedReason: layAvailable ? null : "Already used this game.",
    tokenBlockedReason: tokenAvailable
      ? null
      : input.tokenUsed
        ? "Already used this game."
        : `Lay the ${DH_HEX_LABEL} tile first — the free station comes with that lay, not on its own.`,
  };
}

/** The one sentence the rules summary, the auction card and the power row all print.
 *
 *  Stated once because #442's version was wrong in three places at once and had to be corrected in three
 *  places. A rule this fiddly should have exactly one wording. */
export const DH_POWER_DESCRIPTION =
  `Delaware & Hudson — the owning corporation may lay tile #${DH_TILE_ID} on ${DH_HEX_LABEL} for the usual $120 mountain cost, ` +
  `ignoring track connection rules, INSTEAD OF its normal tile lay that turn. Having laid it, it may also place a ` +
  `station token there for $0, in addition to its normal placement. The station is only available with the lay. ` +
  `If any other corporation builds on ${DH_HEX_LABEL} first, both powers are forfeited.`;


/** The warning shown to a president about to forfeit their own D&H power by laying F16 the ordinary way.
 *
 *  Design note #725a. REPORTED, on confirming that a self-lay forfeits like any other: "we may want to include
 *  a flag of some sort that says 'Hey, you own this private company, do you want to use it?'"
 *
 *  THE SHARPEST EDGE IN THIS POWER, and the only one a player cannot see coming. Every other way of losing it
 *  is somebody else's move; this one is your own, it looks like an ordinary tile lay, and the thing it destroys
 *  is not the lay you are making but the FREE STATION you no longer get. A president who wanted F16 track and a
 *  president who wanted the D&H's package both click the same hex.
 *
 *  A WARNING RATHER THAN A BLOCK. Laying F16 normally is legal and is occasionally what a president actually
 *  wants -- the power costs them their whole tile lay for the turn, and a corporation with a better use for it
 *  may prefer to reach F16 with ordinary track later. Refusing the click would be inventing a rule; saying what
 *  it costs is the same treatment #700 gives the depot ceiling.
 *
 *  `null` whenever there is nothing at stake: not this hex, not the owner, or the power already spent or gone.
 */
export function dhSelfLayWarning(input: {
  /** The hex about to be laid. */
  q: number;
  r: number;
  /** The D&H's hex, from the reservation table -- injected so this module holds no board data. */
  dhHex: { q: number; r: number } | null;
  /** Whether the acting corporation owns the D&H. */
  actingOwnsDh: boolean;
  /** The power's current state, from `dhPowerState`. */
  power: Pick<DhPowerState, "forfeited" | "layAvailable">;
  /** Whether this lay is the POWER being exercised, in which case there is nothing to warn about. */
  usingPower: boolean;
}): string | null {
  if (input.usingPower) return null;
  if (!input.actingOwnsDh) return null;
  if (!input.dhHex) return null;
  if (input.q !== input.dhHex.q || input.r !== input.dhHex.r) return null;
  /* Nothing left to lose: already forfeited, or the power's lay already taken. */
  if (input.power.forfeited || !input.power.layAvailable) return null;
  return (
    `You own the Delaware & Hudson. Laying ${DH_HEX_LABEL} yourself forfeits its power — ` +
    `use "Lay Track (${DH_HEX_LABEL})" instead to keep the free station token.`
  );
}


/* ==================================================================
 *  DESIGN NOTE 726: THE C&SL IS THE SAME SHAPE, MINUS THE STATION
 * ==================================================================
 *
 * REPORTED: "CSL likely needs similar treatment: it provides the owning corporation with an EXTRA track lay on
 * B20 and that track does not need to obey connectivity."
 *
 * "LIKELY" WAS RIGHT, AND THE HALF THAT WAS ALREADY FIXED IS INSTRUCTIVE. #725 routed the connectivity waiver
 * through the `private-tile` errand rather than through anything named after the D&H, so the C&SL inherited it
 * the moment that landed -- both powers arm the same errand and the same hex key. That was luck rather than
 * design, and it is the argument for the errand being the unit: a rule attached to "the armed private-tile
 * hex" covers every private power that lays a tile, including ones not yet written.
 *
 * WHAT DID NOT CARRY IS THE FORFEIT AND THE WARNING, because those were written against the D&H's own state.
 *
 * THE ONE REAL DIFFERENCE IS THE LAY'S COST TO THE TURN. The D&H's lay REPLACES the corporation's normal tile
 * lay; the C&SL's is EXTRA, on top of it. The existing C&SL caption already said "in addition to its normal
 * lay" and, unlike the D&H's, was correct -- so it is kept verbatim rather than rewritten, and the difference
 * between the two powers is now stated rather than accidental.
 *
 * NO STATION HALF AT ALL, so `cslPowerState` returns no token fields. Modelling one and leaving it permanently
 * false would invite a future reader to wire up a button for it.
 */

/** The Champlain & St. Lawrence's `private_id`, matching `privateReservations.ts`. */
export const CSL_PRIVATE_ID = 2;

/** B20 -- Burlington. */
export const CSL_HEX_LABEL = "B20";

export interface CslPowerState {
  forfeited: boolean;
  layAvailable: boolean;
  layBlockedReason: string | null;
}

export function cslPowerState(input: { hexBuilt: boolean; layUsed: boolean }): CslPowerState {
  /* Same conjunction as the D&H's and for the same reason: a tile on B20 that this power did not lay can only
     have come from somewhere else, and testing `hexBuilt` alone would forfeit the power by using it. */
  const forfeited = input.hexBuilt && !input.layUsed;
  if (forfeited) {
    return {
      forfeited: true,
      layAvailable: false,
      layBlockedReason: `Another corporation has already built on ${CSL_HEX_LABEL}, so the C&SL's power is gone for the rest of the game.`,
    };
  }
  return {
    forfeited: false,
    layAvailable: !input.layUsed,
    layBlockedReason: input.layUsed ? "Already used this game." : null,
  };
}

export const CSL_POWER_DESCRIPTION =
  `Champlain & St. Lawrence — the owning corporation may lay a tile on ${CSL_HEX_LABEL} (Burlington) free, ` +
  `ignoring track connection rules, IN ADDITION TO its normal tile lay that turn. ` +
  `If any other corporation builds on ${CSL_HEX_LABEL} first, the power is forfeited.`;

/** The self-lay warning, for either private.
 *
 *  Design note #726: `dhSelfLayWarning` above is the D&H's specialisation and stays, because its sentence
 *  names the station it costs. This is the general one -- same trap, same reasoning, one fewer thing to lose.
 */
export function privateSelfLayWarning(input: {
  q: number;
  r: number;
  hex: { q: number; r: number } | null;
  actingOwns: boolean;
  layAvailable: boolean;
  forfeited: boolean;
  usingPower: boolean;
  privateName: string;
  hexLabel: string;
  buttonLabel: string;
}): string | null {
  if (input.usingPower || !input.actingOwns || !input.hex) return null;
  if (input.q !== input.hex.q || input.r !== input.hex.r) return null;
  if (input.forfeited || !input.layAvailable) return null;
  return (
    `You own the ${input.privateName}. Laying ${input.hexLabel} yourself forfeits its power — ` +
    `use "${input.buttonLabel}" instead.`
  );
}
