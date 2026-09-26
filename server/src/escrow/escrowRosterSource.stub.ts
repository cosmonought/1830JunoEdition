// server/src/escrow/escrowRosterSource.stub.ts
//
// ==================================================================
//  GNOLAND-1: THE MONEY ROSTER SOURCE'S PLACE IN LIVE-2C's START GATE (compile-only)
// ==================================================================
//
// LIVE-2C's start authority stays exactly as it is: the host's `start-game` → one actor task → `RosterSource.plan`
// → `buildSetupGame` → `assertDeal` → append. For a money room ESCROW-3 splits that into LIVE-3 §11.4's three tasks
// and plugs this source into the LAST one (`escrow-deal`), where it may only confirm what the first one froze:
//
//   task `escrow-start-requested` (host press): freezeEscrowRoster(binding, codec, record.seats, claims, chain view)
//       → commit {money.state.freeze, seats[].chain_seat_index/payout_address, start intent} (roster now frozen)
//   relayer (outside the actor): Start{roster_hash} through a durable intent; inclusion observed
//   task `escrow-deal`: re-read the chain → EscrowRosterSource.plan(record) → the ordinary deal
//
// `plan` answers a StartPlan only when the chain says IN_PROGRESS with exactly the frozen roster hash and domain;
// the turn order is still the server's crypto shuffle of the authoritative seats (the chain's order is the
// SETTLEMENT order, carried separately in SetupGame.escrow). The chain never builds the gameplay roster.
//
// Today (record_schema 1, `money: null`) every money plan refuses: nothing here can start a money game.

import type { GameRecord } from "../rooms/gameRecord";
import type { RosterSource, StartPlan, StartRefusal } from "../rooms/roomService";

export class EscrowRosterSource implements RosterSource {
  async plan(record: GameRecord, _ctx: { shuffle: <T>(items: readonly T[]) => T[]; now: number }): Promise<StartPlan | StartRefusal> {
    if (record.money === null) {
      return { refusal: "wrong-state", code: "wrong-state", reason: "This table has no verified escrow." };
    }
    /* ESCROW-3 (record_schema 2, money: EscrowMoney):
         1. money.state.freeze !== null and the start intent is included-success (else "wrong-state");
         2. the task's fresh chain view: IN_PROGRESS, roster_hash === freeze.roster_hash, domain === freeze.expected_domain
            (else HOLD `inconsistent`, never a deal);
         3. every freeze.roster[i].player_id holds exactly one record seat (assertDeal re-checks names);
         4. return { turnOrder: ctx.shuffle(record.seats), variants: record.variants, escrow: dealBinding(freeze) }. */
    return { refusal: "wrong-state", code: "wrong-state", reason: "Money tables are not enabled on this server." };
  }
}
