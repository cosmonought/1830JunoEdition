// Which hexes carry a private company's special power, and for how long.
//
// Design note #0: the power is real and stated in three places, all of them text -- the auction card, the
// powers panel and the rules reference. None is on screen while a president is choosing where to lay track.
//
// Design note #714: THE REST OF #0 WAS WRONG, AND SO IS THIS FILE'S NAME.
//
// It read "so a player discovers the block by having a placement refused". There is no block. REPORTED:
// "these hexes are actually not locked by the private companies: any corporation can build on those hexes
// following the usual rules, it's only that the owning corporations of DH or CSL get their special power."
//
// So the badge is an OPPORTUNITY its owner should not miss, not a wall everyone else must route around --
// which is why it was drawn as a padlock and captioned "Reserved by", both now corrected. The `power` strings
// below were accurate the whole time; nothing rendered them, and the two surfaces that DID render something
// invented a shorter claim that happened to be false.
//
// THE VOCABULARY IS LEFT ALONE ON PURPOSE. "Reservation" is wrong and it is wrong in seven exported symbols
// across four files; renaming them is mechanical, touches a lot of lines, and would bury the one-line fixes
// that matter. Recorded here rather than done quietly, so the misnomer is a known debt and not a belief.
//
// Design note #1: DERIVED FROM OWNERSHIP, not a static list. The badge has to
// CLEAR, and it clears two ways: CLOSED (the private leaves at Phase 5) and
// ABSENT (a room that does not report it -- no claim, no badge). UNOWNED STILL
// COUNTS: during the auction nobody holds the C&SL and the hex still carries the
// power; ownership changes only who can use it.
//
// Design note #2: the table stores hex LABELS and `HEX_LABEL_TO_AXIAL` resolves
// them. Storing `(q, r)` here would be a second copy of the board's geometry,
// free to drift -- `hexBoardData.ts` already had to move F16 once (#123). See
// `WaterfallAuctionDashboard.tsx` design note #312 for why D&H holds F16 and M&H
// holds nothing, and the `auction.rs` divergence that follows.
//
// See docs/ai_architecture/hex_tile_math.md, privateReservations.ts #0 - #2.

import { STATIC_BOARD_HEXES, NAMED_HEX_LABELS } from "../components/hexBoardData";
import type { PrivateCompanyState } from "./gameState";

/** One private's special power on one hex. Design note #714: a POWER, not a claim -- anybody may build
 *  here under the ordinary rules. */
interface ReservationRule {
  privateId: number;
  /** Board label, resolved against `STATIC_BOARD_HEXES` -- design note #2. */
  hexLabel: string;
  /** What the badge prints. Design note #364 in `hexCanvasPrimitives.ts`:
   *  NO AMPERSAND -- "CSL", not "C&SL". The character costs width on a hex
   *  corner and adds nothing at seven pixels. */
  initials: string;
  /* Design note #3: each badge has a FIXED home. The 13-slot numbering from
     `hexGeometry.ts` (1-6 edge midpoints, 7-12 corner vertices). These two are
     pinned rather than negotiated through the shared claiming ledger, because
     there are exactly two of them on two known hexes and both had to go where they
     cannot reach a neighbour -- the overflow bug design note #364 records. A
     claimed slot is right when passes compete; a chosen one is right when the
     position itself is the fix. */
  slot: number;
  /** One line for the tooltip, in the player's terms rather than the
   *  contract's. */
  power: string;
}

/* 1830's two hex-holding privates on this board. Schuylkill Valley has no
   ability at all, and Camden & Amboy, Mohawk & Hudson and the B&O grant
   SHARES rather than hold ground -- a badge for them would be marking a hex
   that nothing prevents anyone from building on. */
const RESERVATION_RULES: readonly ReservationRule[] = [
  {
    privateId: 2,
    hexLabel: "B20",
    initials: "CSL",
    // Slot 10 = the Bottom Point vertex.
    slot: 10,
    // Design note #726: connection rules named, which is the half the badge never mentioned.
    power: "its owner may lay a tile here free, ignoring connection rules, in addition to its normal lay",
  },
  {
    privateId: 3,
    hexLabel: "F16",
    initials: "DH",
    // Slot 4 = the Bottom-Left edge midpoint.
    slot: 4,
    /* Design note #725: CORRECTED. This said "lay a tile AND place a station here at no cost", which is wrong
       twice -- the tile costs the $120 mountain fee, and the station is not independent of the lay. `dhPower.ts`
       carries the full rule; this is the badge-length version of it. */
    power: "its owner may lay a tile here for $120, ignoring connection rules, and then place a station free",
  },
];

/** A live claim, resolved to board coordinates and ready to draw. */
export interface HexReservation {
  q: number;
  r: number;
  hexLabel: string;
  /** Place name, when the board has one -- "Burlington" reads better than
   *  "B20" in a tooltip. */
  placeName: string | null;
  privateId: number;
  privateName: string;
  initials: string;
  /** Design note #3: the fixed slot this hex's badge draws on. */
  slot: number;
  /** `null` while the private is still in the auction. */
  ownerAddress: string | null;
  power: string;
}

/** `"q,r"`, matching `trackReach.ts`'s key so a caller holding both can
 *  compare them without a second convention. */
export function reservationKey(q: number, r: number): string {
  return `${q},${r}`;
}

/* ==================================================================
    DESIGN NOTE 1176: THE BADGE OUTLIVED THE POWER IT ADVERTISES
   ==================================================================
   REPORTED: "the private company acronyms+stars are lingering on hexes even after tiles have been laid on
   them ... as soon as any tile is laid on these hexes, their private powers are disabled and the markers are
   removed."
   AND THE POWERS REALLY WERE DISABLED. `dhPowerState` and `cslPowerState` both compute
   `forfeited = hexBuilt && !layUsed` and the offers, the chips and the hex glow all read it. The BADGE read
   something else: this function, which clears on `closed` and on absence and has never known whether anybody
   has built. #891's shape once more -- two surfaces answering one question two ways -- and the half that was
   wrong is the half a president actually looks at while choosing where to lay.
   THE LIVE SET IS PASSED IN RATHER THAN RECOMPUTED. The tempting fix is to hand this the laid tiles and test
   `hexBuilt` here, and it would be a THIRD reading of the same fact, free to drift from the two that already
   agree. What the caller passes is the conclusion those two already reached.
   AND IT IS "STILL HAS AN UNSPENT POWER", NOT "NOBODY HAS BUILT", which the D&H makes matter: its owner
   laying its own tile sets `hexBuilt` while leaving `tokenAvailable` true (the free station is the second
   half of that lay), so the badge must survive its own tile and die on somebody else's.
   REQUIRED, NOT OPTIONAL. An optional parameter would let a caller keep the old behaviour by saying nothing,
   which is exactly how the badge and the power came to disagree in the first place. */

/** Every hex carrying a live private's power. Empty once both privates have closed, which is the state the
 *  badge exists to stop misrepresenting. */
export function activeReservations(
  privateCompanies: readonly PrivateCompanyState[] | null | undefined,
  /** Design note #1176: the ids whose power on their own hex is still worth advertising. */
  livePowerIds: ReadonlySet<number>,
): HexReservation[] {
  if (!privateCompanies || privateCompanies.length === 0) return [];
  const out: HexReservation[] = [];

  for (const rule of RESERVATION_RULES) {
    const priv = privateCompanies.find((entry) => entry.private_id === rule.privateId);
    // Design note #1: absent or closed, no claim.
    if (!priv || priv.closed) continue;
    // Design note #1176: spent or forfeited, no badge -- the power is what the badge is about.
    if (!livePowerIds.has(rule.privateId)) continue;

    const hex = STATIC_BOARD_HEXES.find((entry) => entry.label === rule.hexLabel);
    // Design note #2: a label the board does not carry draws nothing.
    if (!hex) continue;

    out.push({
      q: hex.q,
      r: hex.r,
      hexLabel: rule.hexLabel,
      placeName: NAMED_HEX_LABELS[rule.hexLabel] ?? null,
      privateId: rule.privateId,
      privateName: priv.name,
      initials: rule.initials,
      slot: rule.slot,
      ownerAddress: priv.owner ?? null,
      power: rule.power,
    });
  }

  return out;
}

/** Keyed by `"q,r"` for the draw loop, which tests every hex every frame and
 *  must not run a linear scan per hex -- the same reasoning as `layFocus`'s
 *  sets in `HexGridRenderer` design note #223. */
export function reservationsByHex(
  privateCompanies: readonly PrivateCompanyState[] | null | undefined,
  // Design note #1176: carried straight through -- the draw loop asks the same question the panel does.
  livePowerIds: ReadonlySet<number>,
): ReadonlyMap<string, HexReservation> {
  const map = new Map<string, HexReservation>();
  for (const entry of activeReservations(privateCompanies, livePowerIds)) {
    map.set(reservationKey(entry.q, entry.r), entry);
  }
  return map;
}

/** The tooltip line for one reservation. Names the holder when there is one,
 *  because "reserved by the D&H" and "reserved by the D&H, which Carol owns" lead
 *  to different decisions: the second tells a president whether the block is
 *  theirs to use. */
export function describeReservation(
  reservation: HexReservation,
  labelForAddress?: (address: string) => string | null,
): string {
  const where = reservation.placeName
    ? `${reservation.hexLabel} (${reservation.placeName})`
    : reservation.hexLabel;
  const owner = reservation.ownerAddress
    ? (labelForAddress?.(reservation.ownerAddress) ?? reservation.ownerAddress)
    : null;
  const held = owner
    ? `held by ${reservation.privateName}, owned by ${owner}`
    : `held by ${reservation.privateName}, still unsold in the auction`;
  return `${where} is reserved — ${held}. No other corporation may lay track here until the private closes; ${reservation.power}.`;
}

/* Design note #444: WHERE a private's power acts, which is a printed property of
   the board and true whether the private is owned, unowned or closed -- a
   different question from `activeReservations` above, which filters on ownership
   and closure because a badge must not mark a hex nothing protects.

   Separate rather than a flag, because conflating them is how a power would
   silently stop being executable at the moment the badge stopped drawing. `null`
   for the four privates that hold no ground, and for a label the board does not
   carry. */
export function privateHexFor(
  privateId: number,
): { q: number; r: number; hexLabel: string } | null {
  const rule = RESERVATION_RULES.find((entry) => entry.privateId === privateId);
  if (!rule) return null;
  const hex = STATIC_BOARD_HEXES.find((entry) => entry.label === rule.hexLabel);
  if (!hex) return null;
  return { q: hex.q, r: hex.r, hexLabel: rule.hexLabel };
}
