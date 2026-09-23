// Which hexes carry a private company's special power, and for how long.
//
// Design note #0: the power is real and stated in three places, all of them text -- the auction card, the
// powers panel and the rules reference. None is on screen while a president is choosing where to lay track.
//
// Design note #714 (HISTORICAL -- ITS CONCLUSION WAS WRONG AND IS CORRECTED BY #1694 BELOW, Stage 10.6).
//
// What #714 recorded: that #0's "a player discovers the block by having a placement refused" was false, that
// "there is no block", that "any corporation can build on those hexes following the usual rules", and that the
// CSL / DH markers were only an OPPORTUNITY for the owning corporation's special power. The padlock became a star
// and "Reserved by" left the tooltip on that reading.
//
// WHAT WAS WRONG, PRECISELY: #714's BLANKET conclusion -- that a private's location is only ever an opportunity and
// never a restriction. OWNER RULING (Stage 10.6, S6-7, confirming the Stage-6 backlog entry and rulebook 6.2.1 (4)):
// a railroad may not lay a tile on a hex holding a private company owned by a PLAYER -- SV G15, CSL B20, MH D18,
// CA H18, BO I13 and I15, and under the Level Playing Field the JK's K9 and K11 -- until a corporation buys the
// private or it closes. The owner does not recall authorising #714's contrary reading.
//
// WHAT WAS RIGHT, AND STAYS: the D&H's F16. The revised (2018) D&H text is a SPECIFIC EXCEPTION to that general rule:
// other railroads may lay on F16 under the ordinary rules, and if one does the D&H's special effects are no longer
// available. So F16 is not barred while a player owns the D&H (#1694a below) -- #714's report was accurate for that
// hex, and wrong only when generalised to every private. And the CSL / DH SPECIAL POWERS remain a separate matter
// from the location rule: an opportunity for the OWNING CORPORATION (the star badge, `activeReservations`), usable
// only once a corporation owns the private -- exactly when the general restriction has been released.
//
// Kept as the record of why the board drew no restriction for so long; the restriction itself is
// `privateHexStatuses` / `privateHexRefusal` (#1694), asked by the `LayTile` authority and drawn by the board.
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
import type { GameStateResponse, PrivateCompanyState } from "./gameState";
import { resolveVariants } from "./gameVariants";
import { JK_PRIVATE_ID } from "./levelPlayingField";
import { privateAcronym } from "../utils/privateCatalog";
import { stage106LayAuthorityInForce } from "./rulesVersion";

/* ==================================================================
    DESIGN NOTE 1694 (Stage 10.6, S6-7): EVERY PRIVATE'S PRINTED LOCATION, IN ONE TABLE
   ==================================================================
   The one private-to-hex source. The `LayTile` authority's restriction (`privateHexRefusal`), the board's
   restriction markers (`privateHexMarkers`) and the CSL / DH power badges (`RESERVATION_RULES`, which now reads
   its hex from here) all resolve a private's ground through this table, so the refusal and the mark cannot name
   different hexes. Labels, not coordinates (#2), resolved against the board IN EFFECT.

   BASE / CLASSIC: SV G15, CSL B20, DH F16, MH D18, CA H18, BO I13 + I15 (the rulebook's private appendix, which
   `RulesReference.tsx` prints). LEVEL PLAYING FIELD ONLY: the JK's K9 + K11 -- its PRIVATE-COMPANY LOCATION. That
   is NOT the JK's special power, which is the half-price lay beside Coal River (L8) judged by `jkTileRefusal`
   (`kanawhaLicense.ts`, #1323); K9 happens to be one of Coal River's neighbours, and the two facts stay two:
   nothing here reads Coal River, and nothing there reads this table. A table without the Level Playing Field never
   sees the JK's row. */
interface PrivateLocationRule {
  privateId: number;
  /** Board labels, resolved against `STATIC_BOARD_HEXES` (the board in effect). */
  hexLabels: readonly string[];
  /** #1694a: the rule-specific exception to the general player-owned restriction, where one exists. Only the D&H
   *  has one: its revised (2018) text lets any other railroad lay on F16 under the ordinary rules, which ends the
   *  D&H's special effects. */
  ordinaryLayForfeitsPower?: true;
  /** Present only on a row that exists in the Level Playing Field alone. */
  levelPlayingFieldOnly?: true;
}

const PRIVATE_LOCATION_RULES: readonly PrivateLocationRule[] = [
  { privateId: 1, hexLabels: ["G15"] }, // Schuylkill Valley
  { privateId: 2, hexLabels: ["B20"] }, // Champlain & St. Lawrence
  { privateId: 3, hexLabels: ["F16"], ordinaryLayForfeitsPower: true }, // Delaware & Hudson -- #1694a
  { privateId: 4, hexLabels: ["D18"] }, // Mohawk & Hudson
  { privateId: 5, hexLabels: ["H18"] }, // Camden & Amboy
  { privateId: 6, hexLabels: ["I13", "I15"] }, // Baltimore & Ohio
  { privateId: JK_PRIVATE_ID, hexLabels: ["K9", "K11"], levelPlayingFieldOnly: true }, // James River & Kanawha
];

/** The printed location labels of `privateId` under these variants -- `[]` for a private this table does not carry
 *  or the JK outside the Level Playing Field. */
export function privateLocationLabels(
  privateId: number,
  variants?: GameStateResponse["variants"],
): readonly string[] {
  const rule = PRIVATE_LOCATION_RULES.find((entry) => entry.privateId === privateId);
  if (!rule) return [];
  if (rule.levelPlayingFieldOnly && !resolveVariants(variants).levelPlayingField) return [];
  return rule.hexLabels;
}

/** One private's special power on one hex. Design note #714: a POWER, not a claim -- anybody may build
 *  here under the ordinary rules, ONCE no player owns the private (#1694, Stage 10.6: while a PLAYER owns it the
 *  hex is barred on a pinned board, the D&H's F16 excepted -- `privateHexStatuses`, not this table). */
interface ReservationRule {
  /** #1694: the power acts on this private's (single) printed location, read from `PRIVATE_LOCATION_RULES`;
   *  the initials are the catalog's acronym (#829 / #364: no ampersand). Neither is restated here. */
  privateId: number;
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
    // Slot 3 = the Bottom-Right edge midpoint. Design note #1288: moved off the bottom point, where the Level
    // Playing Field's plates now sit, to the edge beside it -- same on every board, so the badge has one home.
    slot: 3,
    // Design note #726: connection rules named, which is the half the badge never mentioned.
    power: "its owner may lay a tile here free, ignoring connection rules, in addition to its normal lay",
  },
  {
    privateId: 3,
    // Slot 4 = the Bottom-Left edge midpoint.
    slot: 4,
    /* Design note #725: CORRECTED. This said "lay a tile AND place a station here at no cost", which is wrong
       twice -- the tile costs the $120 mountain fee, and the station is not independent of the lay. `dhPower.ts`
       carries the full rule; this is the badge-length version of it. */
    power: "its owner may lay a tile here for $120, ignoring connection rules, and then place a station free",
  },
];

/** #1694: a power rule's hex label -- its private's first (and, for CSL and DH, only) printed location. */
function powerHexLabel(rule: ReservationRule): string | null {
  return PRIVATE_LOCATION_RULES.find((entry) => entry.privateId === rule.privateId)?.hexLabels[0] ?? null;
}

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

    const hexLabel = powerHexLabel(rule);
    const hex = hexLabel === null ? undefined : STATIC_BOARD_HEXES.find((entry) => entry.label === hexLabel);
    // Design note #2: a label the board does not carry draws nothing.
    if (!hex || hexLabel === null) continue;

    out.push({
      q: hex.q,
      r: hex.r,
      hexLabel,
      placeName: NAMED_HEX_LABELS[hexLabel] ?? null,
      privateId: rule.privateId,
      privateName: priv.name,
      initials: privateAcronym(rule.privateId) ?? String(rule.privateId),
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
  /* #1694: the restriction is the PLAYER-OWNED one -- released by a corporation's purchase or by closure, not by
     closure alone (the sentence this replaced said "until the private closes"). */
  return `${where} is marked — ${held}. While a player owns it no tile may be laid here; ${reservation.power}.`;
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
  const hexLabel = powerHexLabel(rule);
  const hex = hexLabel === null ? undefined : STATIC_BOARD_HEXES.find((entry) => entry.label === hexLabel);
  if (!hex || hexLabel === null) return null;
  return { q: hex.q, r: hex.r, hexLabel };
}

/* ==================================================================
    DESIGN NOTE 1694 (Stage 10.6, S6-7): WHILE A PLAYER OWNS A PRIVATE, NO TILE MAY BE LAID ON ITS HEX
   ==================================================================
   OWNER RULING (Stage 10.6), confirming S6-7 and rulebook 6.2.1 (4): while a private company is OWNED BY A
   PLAYER, its printed hex or hexes (the table at the head of this file) are closed to tile laying. The
   restriction is released when the private is no longer player-owned -- bought by a corporation
   (`owner_protocol_id`) or closed.

   THE CONDITION, EXACTLY: open (`closed` false) AND held by a player (`owner` a non-empty address, no
   `owner_protocol_id` -- the two are mutually exclusive by `gameState.ts`'s contract; a corporation owner wins if
   a hand-built state ever carries both). AN UNSOLD PRIVATE DOES NOT RESTRICT: the rule, as the owner stated it and
   as S6-7 was filed, is the PLAYER-OWNED private; nothing in the project's rule authority blocks a hex for a
   private still in the auction (and in the standard game no tile is laid before the auction has sold everything).

   ON A PINNED BOARD ONLY (#1696, `stage106LayAuthorityInForce`): a legacy development log keeps the reading it was
   played under, and -- because this one function feeds the authority, the markers and the click -- the board never
   marks a legacy hex the replay leaves open.

   DESIGN NOTE 1694a -- THE D&H'S F16 IS THE ONE SPECIFIC EXCEPTION. The revised (2018) D&H text: other railroads may
   lay a tile on F16 under the ordinary rules; if one does, the D&H's special effects are no longer available. The
   specific text overrides the general rule at F16, so a player-owned D&H does NOT bar F16: its status is
   `opens-forfeiting-power` rather than `barred`. An ordinary foreign lay there is judged by the ordinary rules
   (geometry, connectivity, terrain) and forfeits the power through the existing machinery (`dhPowerState`:
   `hexBuilt && !layUsed`). The D&H-owning corporation's own disconnected lay is the power (`privateLayClaim.ts`).

   ONE STATUS, THREE READERS. `privateHexStatuses` is what the `LayTile` authority refuses on (`privateHexRefusal`,
   `barred` only), what the board draws (`privateHexMarkers`) and what the hover and the click say
   (`describePrivateHexStatus`) -- so the board cannot mark a hex the authority lets anybody build on, leave unmarked
   a hex it refuses, or describe F16 as closed.

   THE SPECIAL POWERS NEED NO FURTHER EXCEPTION. The C&SL's bonus lay, the D&H's lay and the JK's half-price lay are
   each exercised by the OWNING CORPORATION -- so whenever one is usable the private is corporation-owned and its
   location restriction has already been released. No "the owner may ignore the block" rule exists or is added. */

/** What a player-owned private does to one of its hexes. */
export type PrivateHexEffect =
  /** The general rule: no tile may be laid here while a player owns the private. */
  | "barred"
  /** #1694a, the D&H's F16: any railroad may lay here under the ordinary rules, which ends the private's special
   *  effects. */
  | "opens-forfeiting-power";

/** One hex a player-owned private currently governs. */
export interface PrivateHexRestriction {
  q: number;
  r: number;
  hexLabel: string;
  placeName: string | null;
  privateId: number;
  privateName: string;
  initials: string;
  /** The player who owns it. */
  ownerAddress: string;
  effect: PrivateHexEffect;
}

/** Whether this private governs its hexes: open and owned by a PLAYER (#1694). */
export function isPlayerOwnedPrivate(
  priv: Pick<PrivateCompanyState, "owner" | "owner_protocol_id" | "closed"> | null | undefined,
): boolean {
  if (!priv || priv.closed === true) return false;
  if (priv.owner_protocol_id !== null && priv.owner_protocol_id !== undefined) return false;
  return typeof priv.owner === "string" && priv.owner !== "";
}

/** Every hex a player-owned private governs on this board, under these variants, on the board in effect -- `[]` on a
 *  legacy (unpinned) board (#1696) and whenever no private is player-owned. */
export function privateHexStatuses(
  state: Pick<GameStateResponse, "private_companies" | "variants" | "rules_engine_version"> | null | undefined,
): PrivateHexRestriction[] {
  if (!stage106LayAuthorityInForce(state)) return [];
  const privates = state?.private_companies ?? [];
  if (privates.length === 0) return [];
  const out: PrivateHexRestriction[] = [];
  for (const rule of PRIVATE_LOCATION_RULES) {
    const labels = privateLocationLabels(rule.privateId, state?.variants);
    if (labels.length === 0) continue;
    const priv = privates.find((entry) => entry.private_id === rule.privateId);
    if (!priv || !isPlayerOwnedPrivate(priv)) continue;
    for (const label of labels) {
      const hex = STATIC_BOARD_HEXES.find((entry) => entry.label === label);
      if (!hex) continue; // #2: a label the board does not carry governs nothing
      out.push({
        q: hex.q,
        r: hex.r,
        hexLabel: label,
        placeName: NAMED_HEX_LABELS[label] ?? null,
        privateId: rule.privateId,
        privateName: priv.name,
        initials: privateAcronym(rule.privateId) ?? String(rule.privateId),
        ownerAddress: priv.owner as string,
        effect: rule.ordinaryLayForfeitsPower ? "opens-forfeiting-power" : "barred",
      });
    }
  }
  return out;
}

/** The hexes actually BARRED to tile laying -- `privateHexStatuses` without the D&H's F16 exception (#1694a). */
export function privateHexRestrictions(
  state: Pick<GameStateResponse, "private_companies" | "variants" | "rules_engine_version"> | null | undefined,
): PrivateHexRestriction[] {
  return privateHexStatuses(state).filter((entry) => entry.effect === "barred");
}

/** The barring restriction standing on `(q, r)`, or `null`. */
export function privateHexRestrictionAt(
  state: Pick<GameStateResponse, "private_companies" | "variants" | "rules_engine_version"> | null | undefined,
  q: number,
  r: number,
): PrivateHexRestriction | null {
  return privateHexRestrictions(state).find((entry) => entry.q === q && entry.r === r) ?? null;
}

/** The one sentence for a private hex's status -- the authority's refusal, the click and the hover all print it. */
export function describePrivateHexStatus(status: PrivateHexRestriction): string {
  const where = status.placeName ? `${status.hexLabel} (${status.placeName})` : status.hexLabel;
  if (status.effect === "opens-forfeiting-power") {
    return (
      `${where} is the ${status.privateName}'s hex and a player owns it: any railroad may still lay here under the ` +
      `ordinary rules, but doing so ends the ${status.privateName}'s special power.`
    );
  }
  return (
    `${where} is the ${status.privateName}'s hex, and a player owns it: no tile may be laid there until a ` +
    `corporation buys the private or it closes.`
  );
}

/** The `LayTile` authority's question (#1694): why no tile may be laid on `(q, r)`, or `null`. */
export function privateHexRefusal(
  state: Pick<GameStateResponse, "private_companies" | "variants" | "rules_engine_version">,
  q: number,
  r: number,
): string | null {
  const restriction = privateHexRestrictionAt(state, q, r);
  return restriction === null ? null : describePrivateHexStatus(restriction);
}

/* ==================================================================
    DESIGN NOTE 1695 (Stage 10.6, S6-7): ONE MARK PER PRIVATE HEX -- A FRAME FOR A BARRED HEX, A STAR FOR A POWER
   ==================================================================
   The board had one private mark, the CSL / DH star (#714), which says "a special power acts here". S6-7 adds a
   different fact -- "a player-owned private bars this hex" -- which is true of six privates' ground and must not
   read as a power. So the two facts get two visual elements that COMPOSE:
     * BARRED (player-owned, `effect: "barred"`): the private's initials in a thin rectangular frame -- a deed;
     * SPECIAL POWER (CSL / DH, `activeReservations`): the five-pointed star, as since #714;
     * both at once (a player-owned C&SL whose power is live): the framed initials with the star inside the frame.
   THE D&H's F16 (#1694a) IS NOT BARRED, so it never wears the frame: while its power is live it shows the star, and
   its status (`opens-forfeiting-power`) rides on the mark so the hover says -- in `describePrivateHexStatus`'s one
   sentence -- that anyone may still lay there and that doing so ends the power. Once the power is gone there is
   nothing left to say and no mark is drawn.
   One mark per hex, so the board stays quiet. The status half is `privateHexStatuses` -- the list the authority
   refuses on -- so the frame appears and disappears exactly when the refusal does. */
export interface PrivateHexMarker {
  q: number;
  r: number;
  hexLabel: string;
  privateId: number;
  initials: string;
  /** A player-owned private BARS this hex (the authority refuses a lay here): the frame. */
  restricted: boolean;
  /** A live CSL / DH special power acts here: the star. */
  specialPower: boolean;
  /** The fixed slot a power badge draws on (#3); `null` for a frame-only mark, which the renderer places through its
   *  slot ledger. */
  slot: number | null;
  /** The player-owned status on this hex, barred or not -- what the hover describes. */
  status: PrivateHexRestriction | null;
  reservation: HexReservation | null;
}

/** The marks the board draws for private companies, from the two derivations above. */
export function privateHexMarkers(
  statuses: readonly PrivateHexRestriction[],
  reservations: Iterable<HexReservation>,
): PrivateHexMarker[] {
  const byKey = new Map<string, PrivateHexMarker>();
  const statusAt = new Map<string, PrivateHexRestriction>();
  for (const status of statuses) statusAt.set(reservationKey(status.q, status.r), status);
  for (const status of statuses) {
    if (status.effect !== "barred") continue; // #1694a: an open hex is marked only through its live power
    byKey.set(reservationKey(status.q, status.r), {
      q: status.q,
      r: status.r,
      hexLabel: status.hexLabel,
      privateId: status.privateId,
      initials: status.initials,
      restricted: true,
      specialPower: false,
      slot: null,
      status,
      reservation: null,
    });
  }
  for (const reservation of Array.from(reservations)) {
    const key = reservationKey(reservation.q, reservation.r);
    const existing = byKey.get(key);
    if (existing && existing.privateId === reservation.privateId) {
      byKey.set(key, { ...existing, specialPower: true, slot: reservation.slot, reservation });
      continue;
    }
    if (existing) continue; // two privates never share a hex (#312)
    const status = statusAt.get(key);
    byKey.set(key, {
      q: reservation.q,
      r: reservation.r,
      hexLabel: reservation.hexLabel,
      privateId: reservation.privateId,
      initials: reservation.initials,
      restricted: false,
      specialPower: true,
      slot: reservation.slot,
      status: status && status.privateId === reservation.privateId ? status : null,
      reservation,
    });
  }
  return Array.from(byKey.values());
}
