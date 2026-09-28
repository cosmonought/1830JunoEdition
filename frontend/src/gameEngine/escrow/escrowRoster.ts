// frontend/src/gameEngine/escrow/escrowRoster.ts
//
// ==================================================================
//  GNOLAND-1: THE ROSTER FREEZE -- ONE CHAIN READ, ONE DETERMINISTIC MAP ONTO LIVE player_ids
// ==================================================================
//
// The money equivalent of LIVE-2C's `NoMoneyRosterSource.plan`, reduced to its pure core. The chain never builds the
// gameplay roster: the SERVER's authoritative seats (LIVE-2C `record.seats`, their `player_id`s) are the roster; the
// chain only reports which funded seat sits at which chain position under which payout address, and which join
// ticket it carried. This function joins the two, refuses anything it cannot join exactly, and commits nothing:
// the caller (ESCROW-3's start-intent task) commits the result together with the intent, in one actor task.
//
// Why here and not at funding time: chain seat positions MOVE while funding (ESCROW-2 `Withdraw` is `Vec::remove`),
// so `chain_seat_index` is only meaningful from the read this function is given, and the roster hash the relayer's
// `Start` carries is what makes the chain refuse any change after that read (RosterHashMismatch / WrongState).
//
// GNOLAND-1 review fix (F2): a join ticket commits to the WALLET it was issued for. The contract only checks a
// ticket's length, so a ticket copied out of another player's pending `Join` would otherwise bind the copier's
// wallet to the victim's player_id. Here the ticket is recomputed from the chain seat's own wallet: a copied ticket
// cannot match, and the copier's deposit stays unbound (refundable by `Withdraw`), never someone else's seat.

import { sha256HexOfBytes, utf8Bytes } from "../sha256";
import type { EscrowCodec } from "./escrowCodec";
import {
  escrowInstanceKey,
  type EscrowBindingV2,
  type EscrowGameView,
  type EscrowRosterFreeze,
  type EscrowSeatClaim,
} from "./escrowModel";

const TICKET_TAG = "18COSMOS/TICKET/v1";

/**
 * The join ticket the server issues to ONE player for ONE wallet in ONE room:
 *   SHA-256("18COSMOS/TICKET/v1" ‖ lp(backend) ‖ lp(chain_id) ‖ lp(deployment) ‖ lp(game_id) ‖ lp(player_id) ‖
 *           lp(wallet) ‖ lp(secret))
 * `game_id` is the LIVE id (the chain game id does not exist yet when the creator's CreateGame carries its ticket);
 * `secret` is server-side randomness that never leaves the server, so nobody else can mint a valid ticket. The
 * player declares the wallet BEFORE the ticket is issued.
 *
 * ESCROW-3A (INTEGRATION-1 F-2): there is NO seat rebind -- LIVE-2E built none, and recovery restores the same principal
 * and seat. Revocation is the server's ticket ledger (`server/src/escrow/walletTickets.ts`): one outstanding ticket per
 * (game, player_id), issued only to a recently re-authenticated session, and standing only while the security context it
 * was issued under stands (the issuing device not signed out, no "Sign out other devices", the recovery key unrotated).
 * Its `ticketOf` is what the freeze below receives. (Comment only: this function and its bytes are unchanged.)
 */
export function joinTicketV1(args: {
  readonly backend: string;
  readonly chain_id: string;
  readonly deployment_id: string;
  readonly game_id: string;
  readonly player_id: string;
  readonly wallet: string;
  readonly secret_hex: string;
}): string {
  const parts = [TICKET_TAG, args.backend, args.chain_id, args.deployment_id, args.game_id, args.player_id, args.wallet, args.secret_hex];
  return sha256HexOfBytes(utf8Bytes(parts.map((part) => `${part.length}:${part}`).join("|")));
}

/** Product policy for the trust facts outside the domain (who can move this game's money, and how fast). */
export interface EscrowTrustPolicy {
  readonly operators: readonly string[];
  readonly resolvers: readonly string[];
  readonly min_challenge_window_secs: bigint;
  readonly min_liveness_window_secs: bigint;
  readonly min_resolver_timeout_secs: bigint;
}

export type RosterFreezeRefusal =
  | { readonly code: "wrong-instance"; readonly detail: string }
  | { readonly code: "not-funded"; readonly detail: string }
  | { readonly code: "paused"; readonly detail: string }
  | { readonly code: "terms-mismatch"; readonly detail: string }
  | { readonly code: "trust-policy"; readonly detail: string }
  | { readonly code: "unbound-seat"; readonly chain_seat_index: number; readonly detail: string }
  | { readonly code: "unfunded-player"; readonly player_id: string; readonly detail: string }
  | { readonly code: "claim-conflict"; readonly detail: string };

export type RosterFreezeResult = { readonly ok: true; readonly freeze: EscrowRosterFreeze } | { readonly ok: false; readonly refusal: RosterFreezeRefusal };

const no = (refusal: RosterFreezeRefusal): RosterFreezeResult => ({ ok: false, refusal });

/** The trust facts a game will run under, checked against policy (usable at the freeze and again at the deal). */
export function checkEscrowTrust(view: EscrowGameView, binding: EscrowBindingV2, policy: EscrowTrustPolicy): string | null {
  const t = view.trust;
  if (t.denom !== binding.asset.denom) return `denomination ${t.denom} is not the bound ${binding.asset.denom}`;
  if (policy.operators.indexOf(t.operator) < 0) return "the deployment's operator is not an accepted operator";
  if (policy.resolvers.indexOf(t.resolver_config) < 0) return "the deployment's resolver is not an accepted resolver";
  if (t.resolver_game !== null && policy.resolvers.indexOf(t.resolver_game) < 0) return "the game's snapshotted resolver is not an accepted resolver";
  const secs = (value: string) => (/^(0|[1-9][0-9]*)$/.test(value) ? BigInt(value) : BigInt(-1));
  if (secs(t.challenge_window_secs) < policy.min_challenge_window_secs) return "the challenge window is below policy";
  if (secs(t.liveness_window_secs) < policy.min_liveness_window_secs) return "the liveness window is below policy";
  if (secs(t.resolver_timeout_secs) < policy.min_resolver_timeout_secs) return "the resolver timeout is below policy";
  return null;
}

/**
 * Joins the chain's FUNDED roster to the LIVE seats through the seat claims. Deterministic: the output depends only
 * on the arguments, and `roster[i]` is chain seat i. Refuses rather than guesses:
 *   - the view is not this binding's instance; the chain is not FUNDED, is paused, or disagrees with the binding's
 *     terms/commitments; a trust fact is outside policy;
 *   - a chain seat has no claim, its ticket is not the ticket recomputed for (its player, ITS wallet), or its wallet
 *     proof names another game, player or wallet (an unknown deposit is never adopted);
 *   - a LIVE seat has no chain seat, or two claims name one player or one address.
 */
export function freezeEscrowRoster<I>(args: {
  readonly binding: EscrowBindingV2;
  readonly game_id: string;
  readonly codec: EscrowCodec<I>;
  readonly liveSeats: readonly { readonly player_id: string }[];
  readonly claims: readonly EscrowSeatClaim[];
  readonly view: EscrowGameView;
  /** The standing ticket issued to `player_id` for `wallet`, or a value no chain ticket equals (the server's ticket
   *  ledger, `server/src/escrow/walletTickets.ts` `lookupOf`; the ticket secret itself is never kept). */
  readonly ticketOf: (playerId: string, wallet: string) => string;
  readonly trust: EscrowTrustPolicy;
  /** The backend's domain inputs for this binding and a roster hash (e.g. `junoDomainInputsOf`). */
  readonly domainInputs: (rosterHash: string) => I;
  readonly now: number;
}): RosterFreezeResult {
  const { binding, codec, liveSeats, claims, view } = args;
  if (codec.id !== binding.codec) throw new Error("freezeEscrowRoster: the codec is not the binding's");
  if (view.instance !== escrowInstanceKey(binding)) return no({ code: "wrong-instance", detail: "the chain view is not this binding's game" });
  if (view.state !== "FUNDED") return no({ code: "not-funded", detail: `the escrow is ${view.state}` });
  if (view.paused) return no({ code: "paused", detail: "the escrow deployment is paused" });
  const terms = binding.terms;
  const same =
    view.ante_gross === terms.ante_gross &&
    view.ante_net === terms.ante_net &&
    view.max_players === terms.max_players &&
    view.mode === terms.mode &&
    view.rules_engine_version === binding.commitments.rules_engine_version &&
    view.variants_digest === binding.commitments.variants_digest;
  if (!same) return no({ code: "terms-mismatch", detail: "the chain's game terms are not the bound terms" });
  const trustProblem = checkEscrowTrust(view, binding, args.trust);
  if (trustProblem !== null) return no({ code: "trust-policy", detail: trustProblem });
  if (view.seats.length !== terms.max_players || liveSeats.length !== view.seats.length) {
    return no({ code: "not-funded", detail: `${view.seats.length} chain seats, ${liveSeats.length} LIVE seats, ${terms.max_players} required` });
  }

  /* Claims must be a function in both directions before they are used. */
  for (let a = 0; a < claims.length; a += 1) {
    for (let b = a + 1; b < claims.length; b += 1) {
      if (claims[a].player_id === claims[b].player_id) return no({ code: "claim-conflict", detail: `player ${claims[a].player_id} has two claims` });
      if (claims[a].payout_address === claims[b].payout_address) return no({ code: "claim-conflict", detail: "one payout address is claimed twice" });
    }
  }

  const roster: EscrowRosterFreeze["roster"][number][] = [];
  for (let index = 0; index < view.seats.length; index += 1) {
    const seat = view.seats[index];
    if (seat.chain_seat_index !== index) return no({ code: "terms-mismatch", detail: `chain seat ${index} reports index ${seat.chain_seat_index}` });
    const address = codec.canonicalAddress(seat.payout_address, `chain seat ${index}`);
    const claim = claims.find((entry) => entry.payout_address === address);
    if (claim === undefined) return no({ code: "unbound-seat", chain_seat_index: index, detail: "a funded seat is not bound to any player" });
    const evidence = claim.evidence;
    const proven =
      evidence.kind === "join-ticket"
        ? seat.join_ticket_hex === args.ticketOf(claim.player_id, address) && evidence.ticket_hex === seat.join_ticket_hex
        : evidence.bound_game_id === args.game_id && evidence.bound_player_id === claim.player_id && evidence.bound_wallet === address;
    if (!proven) return no({ code: "unbound-seat", chain_seat_index: index, detail: "the seat's evidence does not bind this wallet to this player" });
    if (!liveSeats.some((live) => live.player_id === claim.player_id)) {
      return no({ code: "unbound-seat", chain_seat_index: index, detail: "the seat is claimed for a player who holds no LIVE seat" });
    }
    roster.push(
      Object.freeze({
        chain_seat_index: index,
        player_id: claim.player_id,
        payout_address: address,
        join_ticket_hex: seat.join_ticket_hex,
        consent_public_key_hex: seat.consent_public_key_hex,
      }),
    );
  }
  for (const live of liveSeats) {
    if (!roster.some((entry) => entry.player_id === live.player_id)) {
      return no({ code: "unfunded-player", player_id: live.player_id, detail: "a seated player has no funded chain seat" });
    }
  }

  const rosterHash = codec.rosterHash(roster.map((entry) => entry.payout_address)).hex;
  const expected = codec.bindDomain(args.domainInputs(rosterHash)).domain.hex;
  return {
    ok: true,
    freeze: Object.freeze({ roster: Object.freeze(roster), roster_hash: rosterHash, expected_domain: expected, frozen_at: args.now }),
  };
}
