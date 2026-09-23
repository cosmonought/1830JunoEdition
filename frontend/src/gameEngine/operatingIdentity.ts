// frontend/src/gameEngine/operatingIdentity.ts
//
// Which corporation a message may act for during an Operating Turn.
//
// ==================================================================
//  DESIGN NOTE 1510: THE CORPORATION IN THE MESSAGE IS A CLAIM, NOT A FACT
// ==================================================================
//
// `LayTile`, `PlaceStationToken` and `RunMultipleRoutes` all carry a `protocol_id`, and until this note the
// reducer applied each of them to whichever corporation the message named. The comment above the arms said
// so plainly: "protocol_id comes off the message, not the queue cursor." The seat gate (`turnAuthority`,
// #1205) checks that the SENDER is the operating corporation's president -- it says nothing about which
// corporation the sender then acts for. A president of two corporations, or a hand-built message, could lay
// track, place a token or run trains as a corporation that was not operating, and the arm would charge that
// corporation's treasury and write its board.
//
// THIS IS THE CHECK #1182 WROTE AND REVERTED, and the reason it was reverted is the reason it is safe now.
// That note extended `dividendRefusal`'s cursor comparison to these three arms and withdrew it within a day,
// because `active_corporation_index` was only meaningful against an operating order that each client sorted
// on its own market chart: two browsers, two queues, and a refusal keyed on the queue made the board's
// contents depend on their disagreement. #1196 put the chart on the state and #1197 moved the chart step
// inside the reducer, so `buildOperatingOrder` is now a function of the log; #1205 put one server in charge
// of applying it. Both halves of the comparison are identical on every client by construction, which is the
// exact condition #1182 set for restoring the gate. Batch 2 (#1449) recorded the gate as still missing.
//
// THE SAME LOOKUP THE OTHER GATES USE. `dividendRefusal`, `trainPurchaseRefusal` and `kanawhaLicenseRefusal`
// all ask `operatingCorporationId` and all let an unresolvable cursor through -- "refusing there would brick
// a board on the strength of a missing field rather than a broken rule". This module asks the same function
// and takes the same position, so the four gates cannot come to disagree about who is operating.
//
// OUTSIDE AN OPERATING ROUND THERE IS NO OPERATING CORPORATION, so these messages are refused there outright,
// as a dividend declaration or a train purchase already is. No private power lays track or places a token in
// a Stock Round: the D&H, C&StL and JK abilities are all exercised by the owning corporation on its own
// Operating Turn, and they arrive as ordinary `LayTile`s naming that corporation.
//
// WHAT THIS DOES NOT DECIDE. Whether the lay is legal (`layRefused`, #757), whether the circle is free
// (`stationPlacementRefusal`, #1511), whether the route is valid -- every one of those stays where it is.
// This asks one question: is the corporation named the corporation whose turn it is. `RunManualRoute` is
// covered as well: nothing dispatches it any more (#1051), but the schema still admits it and it credits a
// treasury, so a hand-built one is the same hole with an older name.

import type { GameStateResponse } from "./gameState";
import type { SandboxLogMsg } from "./gameSetup";
import { operatingCorporationId } from "./dividendGate";

/** The corporation an operating-turn message claims to act for, or `null` for a message this gate does not
 *  cover. Kept as one function so the reducer and the tests name the same family. */
export function operatingActionCorporation(
  msg: SandboxLogMsg,
): { companyId: number; verb: string } | null {
  if ("LayTile" in msg) return { companyId: msg.LayTile.protocol_id, verb: "lays track" };
  if ("PlaceStationToken" in msg) {
    return { companyId: msg.PlaceStationToken.protocol_id, verb: "places a station token" };
  }
  if ("RunMultipleRoutes" in msg) {
    return { companyId: msg.RunMultipleRoutes.protocol_id, verb: "runs its trains" };
  }
  if ("RunManualRoute" in msg) return { companyId: msg.RunManualRoute.protocol_id, verb: "runs its trains" };
  return null;
}

/** Why this message may not act for the corporation it names, or `null` if it may.
 *
 *  A REASON RATHER THAN A BOOLEAN, for #748's reason: the shell logs the string, and a refusal a player cannot
 *  read is indistinguishable from a bug. `null` for a message outside the family -- this gate has no opinion
 *  about a share purchase. */
export function operatingIdentityRefusal(state: GameStateResponse, msg: SandboxLogMsg): string | null {
  const claim = operatingActionCorporation(msg);
  if (claim === null) return null;

  /* A ROUND THE STATE DOES NOT NAME IS NOT A ROUND THAT IS NOT AN OPERATING ROUND (#232: absent is "not
     said", never "no"). Every dealt board carries the field; the fixtures that omit it are exercising an arm
     in isolation, and refusing them would be judging on a field nobody gave. */
  if (state.current_round_type === undefined) return null;
  if (state.current_round_type !== "OperatingRound") {
    return "A corporation only acts during an Operating Round.";
  }

  const acting = operatingCorporationId(state);
  /* AN UNRESOLVABLE CURSOR FAILS CLOSED HERE, and this is the one place the four gates deliberately differ.
     `dividendGate` and `trainPurchaseGate` let a `null` cursor through because "refusing there would brick a
     board on the strength of a missing field rather than a broken rule" -- and for them the board still has
     somewhere to go, since the auto-skip and the forced withhold are derived. These four messages are not
     derived by anything: each names the corporation it acts FOR, and if the board cannot say who is operating
     then no corporation is, and applying the message would charge a treasury on the message's own word --
     the exact fault this gate exists to close. An Operating Round cannot open without a floated corporation
     (Batch 1.1), so a live board never reaches this arm; a fixture that does is asking the arm in isolation
     and gets a refusal it can see. */
  if (acting === null) {
    return "No corporation is operating, so nothing may act for one.";
  }

  if (acting !== claim.companyId) {
    const named = state.public_companies.find((entry) => entry.company_id === claim.companyId);
    const operating = state.public_companies.find((entry) => entry.company_id === acting);
    return `Only the operating corporation ${claim.verb} — ${operating?.ticker ?? `#${acting}`} is operating, not ${
      named?.ticker ?? `#${claim.companyId}`
    }.`;
  }

  return null;
}
