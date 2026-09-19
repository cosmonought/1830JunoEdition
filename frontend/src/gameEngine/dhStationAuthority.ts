// frontend/src/gameEngine/dhStationAuthority.ts
//
// Whether a `PlaceHomeStation{kind: "dh"}` may be applied right now -- the D&H's OWN legality, asked by the
// reducer's arm (`placeDhFreeStationToken`) and by ingress (`turnRefusal`) so the two locks cannot disagree.
// Stage 9, Slice 9.4b (S9-12).
//
// ==================================================================
//  DESIGN NOTE 1660: THE GAP WAS THE D&H'S OWN RULES, NOT THE ACTOR'S
// ==================================================================
//
// FOUND BY SLICE 8.2, READING THE CODE (`RULES_HARDENING_BACKLOG.md` S9-12). `PlaceHomeStation{kind: "dh"}`
// was refused at ingress only for the wrong actor (`turnAuthority.ts`'s `roomMessageRefusal`: the corporation's
// president, and -- so the comment there claimed -- the D&H's owner), and the reducer's arm
// (`placeDhFreeStationToken`, #1615) checked only that the corporation was floated and not already on the
// hex. Neither lock asked the D&H's own conditions: its hex, the owning corporation, once, or the base game's
// rule that a station not placed on the turn the lay happened needs an ordinary legal route instead
// (the D&H description / Table T-05, p. 47 of the full rulebook). A hand-crafted `PlaceHomeStation{kind: "dh"}`
// could place a free, unconnected station for the D&H's owner's corporation on any hex, at any time, any number
// of times.
//
// AND THE OWNER CHECK THAT WAS THERE WAS ANSWERING THE WRONG QUESTION. `roomMessageRefusal` compared the
// ACTING PLAYER against `private_companies[DH].owner` -- the private's PLAYER-owner field. `owner` and
// `owner_protocol_id` are mutually exclusive (`gameState.ts` #379: "a private can belong to a company, not a
// player"), and the D&H's power belongs to "the owning CORPORATION" (`dhPower.ts`'s own description) -- which
// is only a real state once `owner_protocol_id` is set and `owner` is `null`. So the one check ingress asked
// could never pass for the only board the power is meant to be usable on: a legitimately corporation-owned
// D&H reads `dh.owner === null`, and `null !== actor` refuses every actor there is. (This is why the 18-file
// corpus's one `kind: "dh"` entry, 3XD 115, already replays as refused under the pre-9.4b code -- not because
// the free station was illegal there, but because the wrong field was being asked.) The real question --
// does THIS operating corporation own the D&H -- is asked here instead, and the player-owner branch is
// retired from `roomMessageRefusal` rather than repaired in place: the corporation's president is already
// checked there (as for `kind: "home"`), and corporate ownership is exactly the kind of legality question
// #1611 / #1630 already established belongs in `turnRefusal`'s room-message branch, not in the owner gate.
//
// THE TIMING HALF NEEDED A NEW FACT ON THE BOARD, FOR THE SAME REASON #1183's `last_run_turn_key` AND #1204's
// `used_private_abilities` did: Undo replays the log, so anything the reducer must decide has to travel in the
// state the reducer replays, and nothing already on the board answers "was the lay THIS corporation's turn".
// `used_private_abilities` is an additive, un-timestamped set -- it can say the D&H's lay has EVER happened,
// never WHEN -- and `operating_sub_phase` resets every turn, so a corporation revisiting the cursor on a much
// later turn would read exactly the same "Track" it read on the turn it laid F16. `dh_station_pending`
// (`gameState.ts` design note #1660) is the missing fact: the company id that just spent `dh-tile`, written by
// the `LayTile` arm and cleared wherever every other turn-scoped fact in `settleOperatingCursor` already is.
// This module reads it rather than re-deriving anything from the log.
//
// REUSES THE STATION AUTHORITY STAGE 9.2 BUILT, RATHER THAN DUPLICATING IT. `evaluateStationPlacement` already
// asks every question this station's CITY presents -- the corporation's own token allowance, whether F16 has a
// city at all (it does, the moment tile #57 is down), one token per corporation per city, slot occupancy, the
// tiled-OO-home closure and every home reservation -- and every one of those is as true for a free station as
// for a paid one. The one printed exemption is connectivity ("ignoring track connection rules"), so that
// function grew one opt-in boolean (`skipConnectivity`, `stationTokens.ts` design note #1660) rather than a
// second city-remapping algorithm; this module is the only caller that ever sets it, and only after confirming
// the hex is F16 and the D&H's own conditions already hold -- so the exemption cannot travel anywhere the
// printed rule did not put it.

import type { GameStateResponse, PublicCompanyState } from "./gameState";
import type { MapGridResponse } from "../components/hexContractTypes";
import { operatingCorporationId } from "./dividendGate";
import { DH_HEX_LABEL, DH_PRIVATE_ID, dhPowerState } from "./dhPower";
import { privateHexFor } from "./privateReservations";
import { cityCountAt, evaluateStationPlacement } from "./stationTokens";

/** The body of a `PlaceHomeStation{kind: "dh"}`, as far as this rule reads it. */
export interface DhStationPlacement {
  company_id: number;
  q: number;
  r: number;
  city_index?: number | null;
}

type DhCompany = Pick<
  PublicCompanyState,
  "company_id" | "ticker" | "is_floated" | "station_token_hexes" | "station_token_limit" | "station_tokens"
>;

/** Whether F16 currently carries a laid tile -- the same read `nextDerivedAction`'s
 *  `dhFreeStationAvailableFor` call makes (#1237), so the forfeit test and the derived-action loop cannot
 *  come to disagree about it. */
function dhHexBuilt(mapGrid: MapGridResponse): boolean {
  const hex = privateHexFor(DH_PRIVATE_ID);
  return hex !== null && mapGrid.tiles.some((tile) => tile.q === hex.q && tile.r === hex.r);
}

/** Design note #1660: why this D&H free-station placement must not be applied, or `null` if it may be. For
 *  `kind: "dh"` only -- an ordinary `kind: "home"` placement is `homePlacementRefusal`'s question, not this
 *  one (#1615). */
export function dhStationRefusal(
  state: GameStateResponse,
  placement: DhStationPlacement,
  mapGrid: MapGridResponse | undefined,
): string | null {
  const company = (state.public_companies ?? []).find(
    (entry) => entry.company_id === placement.company_id,
  ) as DhCompany | undefined;
  if (!company) return "That corporation is not in this game.";
  const { ticker } = company;

  // ---- The target. Only F16, ever (#725: "the only hex either half of this power can touch"). ----
  const dhHex = privateHexFor(DH_PRIVATE_ID);
  if (!dhHex || placement.q !== dhHex.q || placement.r !== dhHex.r) {
    return `The Delaware & Hudson's free station goes on ${DH_HEX_LABEL}, not there.`;
  }

  // ---- Ownership. The OWNING CORPORATION's power (dhPower.ts), never the player who once held it. ----
  const dh = state.private_companies.find((entry) => entry.private_id === DH_PRIVATE_ID);
  if (!dh || dh.closed) return "The Delaware & Hudson is not in play.";
  if (dh.owner_protocol_id !== company.company_id) {
    return `Only the corporation that owns the Delaware & Hudson may use its free station, and ${ticker} does not.`;
  }
  if (!company.is_floated) {
    return `${ticker} has not floated, so it cannot use the Delaware & Hudson's free station.`;
  }

  // ---- The acting corporation. Its own operating turn, not merely a turn it once had. ----
  if (operatingCorporationId(state) !== company.company_id) {
    return `${ticker} places the Delaware & Hudson's free station on its own operating turn, and it is not operating now.`;
  }

  // ---- Not already there. The idempotent "used" signal for this predicate: a successful placement always
  //      adds F16 to `station_token_hexes`, so this alone catches repeat use. `used_private_abilities`'s
  //      "dh-token" entry is NOT asked here -- the reducer's pre-arm bookkeeping (#1204, `abilitySpentBy`)
  //      marks it before every arm runs, including this predicate's own caller (`placeDhFreeStationToken`),
  //      so by the time a first, legal call reaches this point that entry is already set and would falsely
  //      refuse the very placement that is setting it. `station_token_hexes` has no such self-reference: it
  //      is written only by a placement that has already been allowed. ----
  if (company.station_token_hexes.some(([hq, hr]) => hq === placement.q && hr === placement.r)) {
    return `${ticker} already has a station token on ${DH_HEX_LABEL}.`;
  }

  // ---- The lay, and lapse. dhPower.ts's own state machine, asked rather than re-derived -- but only for
  //      `forfeited` (which `hexBuilt && !layUsed` computes without reference to the token at all) and the
  //      lay itself. `tokenAvailable` is fed by the same self-referential `used_private_abilities` entry the
  //      check above replaces, so it is deliberately never asked here. ----
  const usedAbilities = state.used_private_abilities ?? [];
  const layUsed = usedAbilities.includes("dh-tile");
  const power = dhPowerState({
    hexBuilt: mapGrid !== undefined && dhHexBuilt(mapGrid),
    layUsed,
    tokenUsed: false,
  });
  if (power.forfeited) return power.tokenBlockedReason;
  if (!layUsed) {
    return `${DH_HEX_LABEL}'s tile has not been laid by the Delaware & Hudson's own power yet -- the free station comes with that lay, not on its own.`;
  }

  // ---- Timing. The SAME operating turn as the lay (Table T-05 / the D&H description, p. 47): a station not
  //      placed on that turn needs an ordinary, connected, paid placement instead -- through
  //      `PlaceStationToken`, not this message. `dh_station_pending` (gameState.ts #1660) is that turn's own
  //      record, cleared everywhere `operating_sub_phase` itself is. ----
  if (state.dh_station_pending !== company.company_id) {
    return (
      `The Delaware & Hudson's free station only comes with the same turn's lay. That turn has ended, so ` +
      `${ticker} would need an ordinary, connected station on ${DH_HEX_LABEL} instead.`
    );
  }

  if (mapGrid === undefined) return null; // #757: the board-dependent arms need the grid

  // ---- The city, the allowance, occupancy and every reservation -- Stage 9.2's own authority, with
  //      connectivity the one thing it is told to skip (#1660). ----
  const cities = cityCountAt(mapGrid, placement.q, placement.r);
  if (cities === 0) {
    return `${DH_HEX_LABEL} has no city to place a station in -- the tile #57 lay comes first.`;
  }
  const requested = placement.city_index ?? null;
  let cityIndex: number;
  if (cities === 1) {
    if (requested !== null && requested !== 0) {
      return `${DH_HEX_LABEL} has one city; there is no city ${requested + 1} there.`;
    }
    cityIndex = 0;
  } else {
    if (requested === null || !Number.isInteger(requested) || requested < 0 || requested >= cities) {
      return `${DH_HEX_LABEL} has ${cities} cities; the placement must name a real one.`;
    }
    cityIndex = requested;
  }

  const verdict = evaluateStationPlacement({
    mapGrid,
    q: placement.q,
    r: placement.r,
    company,
    allCompanies: state.public_companies,
    cityIndex,
    skipConnectivity: true,
  });
  return verdict.allowed ? null : (verdict.reason ?? `${ticker}'s free station cannot be placed there.`);
}
