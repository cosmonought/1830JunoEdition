// frontend/src/utils/privateReservations.ts
//
// Which hexes a private company is holding, and for how long.
//
// ===================================================================
//  DESIGN NOTE 0: THE RESERVATION EXISTED ONLY AS PROSE
// ===================================================================
//
// REPORTED: the map gives no indication that a hex is reserved by a private
// company -- Burlington by the Champlain & St. Lawrence, Scranton by the
// Delaware & Hudson.
//
// The reservation was real and stated in three places, all of them text: the
// auction card's ability line, `PrivatePowerPanel`'s description, and the
// rules reference. None of them is on screen while a president is choosing
// where to lay track, which is the one moment the fact matters. A player
// discovers the block by having a placement refused.
//
// ===================================================================
//  DESIGN NOTE 1: DERIVED FROM OWNERSHIP, NOT HARDCODED ON
// ===================================================================
//
// The badge has to CLEAR, and the two ways it clears are different:
//
//   CLOSED   the private leaves the game at Phase 5 and its hold goes with
//            it. `PrivateCompanyState.closed` says so directly.
//   ABSENT   a room that does not report the private at all -- an older
//            contract, or a variant without it. No claim, no badge.
//
// So this reads the live roster every time rather than baking a static list
// of blocked hexes into the renderer. A badge that cannot turn off would be
// worse than no badge by the middle of the game: it would be marking a
// restriction that no longer exists, on the board a player is planning
// against.
//
// UNOWNED STILL COUNTS. During the auction nobody holds the C&SL yet and the
// hex is still spoken for -- no corporation may build there. The badge is
// about the HEX's availability, which the private's existence decides; who
// owns it changes only the tooltip.
//
// ===================================================================
//  DESIGN NOTE 2: THE COORDINATES COME FROM THE BOARD, NOT FROM HERE
// ===================================================================
//
// The table below stores hex LABELS ("B20"), and `HEX_LABEL_TO_AXIAL`
// resolves them. Storing `(q, r)` pairs here would be a second copy of the
// board's own geometry, free to drift from it -- and `hexBoardData.ts`
// already had to move F16 once (design note #123, the missed Scranton city).
// A label that no longer resolves yields no reservation rather than a badge
// floating at (0, 0).
//
// See `WaterfallAuctionDashboard.tsx` design note #312 for why D&H holds F16
// and M&H holds nothing, and for the divergence from `auction.rs` that
// follows from it.

import { STATIC_BOARD_HEXES, NAMED_HEX_LABELS } from "../components/hexBoardData";
import type { PrivateCompanyState } from "./gameState";

/** One private's claim on one hex. */
interface ReservationRule {
  privateId: number;
  /** Board label, resolved against `STATIC_BOARD_HEXES` -- design note #2. */
  hexLabel: string;
  /** What the badge prints. Short enough to sit on a hex corner at the
   *  smallest zoom the board renders at. */
  initials: string;
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
    initials: "C&SL",
    power: "its owner may lay a tile here free, in addition to the corporation's normal lay",
  },
  {
    privateId: 3,
    hexLabel: "F16",
    initials: "D&H",
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
  /** `null` while the private is still in the auction. */
  ownerAddress: string | null;
  power: string;
}

/** `"q,r"`, matching `trackReach.ts`'s key so a caller holding both can
 *  compare them without a second convention. */
export function reservationKey(q: number, r: number): string {
  return `${q},${r}`;
}

/**
 * Every hex currently spoken for by a private that is still in the game.
 *
 * Empty once both privates have closed, which is the state the badge exists
 * to stop misrepresenting.
 */
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

/**
 * The tooltip line for one reservation.
 *
 * Names the holder when there is one, because "reserved by the D&H" and
 * "reserved by the D&H, which Carol owns" lead to different decisions: the
 * second tells a president whether the block is theirs to use.
 */
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
