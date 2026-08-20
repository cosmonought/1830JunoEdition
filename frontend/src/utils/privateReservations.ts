// Which hexes a private company is holding, and for how long.
//
// Design note #0: the reservation was real and stated in three places, all of
// them text -- the auction card, the powers panel and the rules reference. None
// is on screen while a president is choosing where to lay track, so a player
// discovers the block by having a placement refused.
//
// Design note #1: DERIVED FROM OWNERSHIP, not a static list. The badge has to
// CLEAR, and it clears two ways: CLOSED (the private leaves at Phase 5) and
// ABSENT (a room that does not report it -- no claim, no badge). UNOWNED STILL
// COUNTS: during the auction nobody holds the C&SL and the hex is still spoken
// for; ownership changes only the tooltip.
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

/** One private's claim on one hex. */
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
    power: "its owner may lay a tile here free, in addition to the corporation's normal lay",
  },
  {
    privateId: 3,
    hexLabel: "F16",
    initials: "DH",
    // Slot 4 = the Bottom-Left edge midpoint.
    slot: 4,
    power: "its owner may lay a tile AND place a station here at no cost",
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

/** Every hex currently spoken for by a private that is still in the game. Empty
 *  once both privates have closed, which is the state the badge exists to stop
 *  misrepresenting. */
export function activeReservations(
  privateCompanies: readonly PrivateCompanyState[] | null | undefined,
): HexReservation[] {
  if (!privateCompanies || privateCompanies.length === 0) return [];
  const out: HexReservation[] = [];

  for (const rule of RESERVATION_RULES) {
    const priv = privateCompanies.find((entry) => entry.private_id === rule.privateId);
    // Design note #1: absent or closed, no claim.
    if (!priv || priv.closed) continue;

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
): ReadonlyMap<string, HexReservation> {
  const map = new Map<string, HexReservation>();
  for (const entry of activeReservations(privateCompanies)) {
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
