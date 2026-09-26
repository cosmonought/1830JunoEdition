//! SetConsentKey: a seat's own wallet rotates the key its consents are checked
//! against. Allowed in FUNDING, FUNDED, IN_PROGRESS and SETTLEABLE; works while
//! paused; never changes the roster hash or the settlement domain.

mod common;

use common::*;
use cosmwasm_std::{coins, HexBinary};
use eighteen_cosmos_escrow::crypto::{self, DomainInputs};
use eighteen_cosmos_escrow::msg::{ExecuteMsg, SeatSignature};
use eighteen_cosmos_escrow::state::{GameState, Mode};
use eighteen_cosmos_escrow::ContractError;

fn rotate(id: u64, key: &HexBinary) -> ExecuteMsg {
    ExecuteMsg::SetConsentKey {
        chain_game_id: id,
        new_pubkey: key.clone(),
    }
}

fn rotated(seat: usize) -> Key {
    Key::from_label(&format!("18JUNO/TEST/seat/{seat}/rotated"))
}

#[test]
fn rotation_records_the_new_key_and_repeating_it_is_a_no_op() {
    let mut s = Suite::new();
    let id = s.create(0, 3, Mode::Live, ANTE);
    s.join(id, 1, ANTE);
    s.advance(60);
    let t = s.now();
    let alice = s.players[1].clone();
    let k = rotated(1);
    let res = s.exec(&alice, &rotate(id, &k.pubkey), &[]).unwrap();
    assert_eq!(attr(&res, "changed"), "true");
    assert_eq!(attr(&res, "chain_seat_index"), "1");
    let g = s.game(id).game;
    assert_eq!(g.seats[1].consent_pubkey, k.pubkey);
    assert_eq!(g.seats[1].consent_key_rotated_at, Some(t));
    assert_eq!(g.seats[0].consent_pubkey, Key::seat(0).pubkey);
    assert_eq!(g.seats[0].consent_key_rotated_at, None);

    s.advance(60);
    let res = s.exec(&alice, &rotate(id, &k.pubkey), &[]).unwrap();
    assert_eq!(attr(&res, "changed"), "false");
    assert_eq!(s.game(id).game.seats[1].consent_key_rotated_at, Some(t));
}

#[test]
fn only_the_seat_wallet_may_rotate_and_it_takes_no_funds() {
    let mut s = Suite::new();
    let id = s.started(3);
    let k = rotated(1);
    for who in [
        s.admin.clone(),
        s.operator.clone(),
        s.resolver.clone(),
        s.outsider.clone(),
        s.players[5].clone(),
    ] {
        assert_eq!(
            s.exec(&who, &rotate(id, &k.pubkey), &[]).unwrap_err(),
            ContractError::NotSeated { chain_game_id: id }
        );
    }
    let alice = s.players[1].clone();
    assert_eq!(
        s.exec(&alice, &rotate(id, &k.pubkey), &coins(1, DENOM))
            .unwrap_err(),
        ContractError::NonPayable {}
    );
    assert_eq!(s.game(id).game.seats[1].consent_pubkey, Key::seat(1).pubkey);
    assert_eq!(
        s.exec(&alice, &rotate(999, &k.pubkey), &[]).unwrap_err(),
        ContractError::GameNotFound { chain_game_id: 999 }
    );
}

#[test]
fn allowed_in_funding_funded_in_progress_and_settleable() {
    let mut s = Suite::new();
    let funding = s.create(0, 3, Mode::Live, ANTE);
    s.join(funding, 1, ANTE);
    let funded = s.funded(3);
    let in_progress = s.started(3);
    let (settleable, _) = s.settleable(3);
    let expected = [
        (funding, GameState::Funding),
        (funded, GameState::Funded),
        (in_progress, GameState::InProgress),
        (settleable, GameState::Settleable),
    ];
    let alice = s.players[1].clone();
    let k = rotated(1);
    for (id, state) in expected {
        assert_eq!(s.state(id), state);
        s.exec(&alice, &rotate(id, &k.pubkey), &[]).unwrap();
        assert_eq!(s.game(id).game.seats[1].consent_pubkey, k.pubkey);
        assert_eq!(s.state(id), state, "rotation never changes the state");
    }
}

#[test]
fn refused_once_disputed_or_terminal() {
    let mut s = Suite::new();
    let (disputed, _) = s.disputed(3);
    let settled = s.settled(3);
    let cancelled = s.cancelled(3);
    let annulled = s.annulled(3);
    let alice = s.players[1].clone();
    let k = rotated(1);
    for (id, actual) in [
        (disputed, "disputed"),
        (settled, "settled"),
        (cancelled, "cancelled"),
        (annulled, "annulled"),
    ] {
        assert_eq!(
            s.exec(&alice, &rotate(id, &k.pubkey), &[]).unwrap_err(),
            ContractError::WrongState {
                expected: "funding or funded or in_progress or settleable".to_string(),
                actual: actual.to_string(),
            }
        );
    }
}

#[test]
fn works_while_paused() {
    let mut s = Suite::new();
    let id = s.started(3);
    s.pause();
    let bob = s.players[2].clone();
    let k = rotated(2);
    s.exec(&bob, &rotate(id, &k.pubkey), &[]).unwrap();
    assert_eq!(s.game(id).game.seats[2].consent_pubkey, k.pubkey);
}

#[test]
fn settle_consents_are_checked_against_the_current_key() {
    let mut s = Suite::new();
    let id = s.started(3);
    let alice = s.players[1].clone();
    let k = rotated(1);
    s.exec(&alice, &rotate(id, &k.pubkey), &[]).unwrap();

    let p = s.terminal_payload(id, 1, 200, &[1, 2, 3]);
    let op = s.operator.clone();
    // Seat 1's OLD key: the whole Settle is refused.
    let stale = s.settle_msg(id, &p, &[0, 1, 2]);
    assert_eq!(
        s.exec(&op, &stale, &[]).unwrap_err(),
        ContractError::InvalidConsent { seat_index: 1 }
    );
    assert_eq!(s.state(id), GameState::InProgress);

    let digest = s.consent_digest(id, &p);
    let (payload, signature) = s.signed(&p);
    let mut consents = s.consents(id, &p, &[0, 2]);
    consents.push(SeatSignature {
        seat_index: 1,
        signature: k.sign(&digest),
    });
    s.exec(
        &op,
        &ExecuteMsg::Settle {
            chain_game_id: id,
            payload,
            signature,
            consents,
        },
        &[],
    )
    .unwrap();
    assert_eq!(s.state(id), GameState::Settled);
    s.assert_custody();
}

#[test]
fn consent_message_uses_the_key_current_at_submission() {
    let mut s = Suite::new();
    let id = s.started(3);
    let p = s.settle(id, 1, 200, &[1, 2, 3], &[0, 2]);
    assert_eq!(s.state(id), GameState::Settleable);
    let alice = s.players[1].clone();
    let k = rotated(1);
    s.exec(&alice, &rotate(id, &k.pubkey), &[]).unwrap();

    let digest = s.consent_digest(id, &p);
    let who = s.outsider.clone();
    let old = ExecuteMsg::Consent {
        chain_game_id: id,
        seat_index: 1,
        signature: Key::seat(1).sign(&digest),
    };
    assert_eq!(
        s.exec(&who, &old, &[]).unwrap_err(),
        ContractError::InvalidConsent { seat_index: 1 }
    );
    let new = ExecuteMsg::Consent {
        chain_game_id: id,
        seat_index: 1,
        signature: k.sign(&digest),
    };
    s.exec(&who, &new, &[]).unwrap();
    assert_eq!(s.state(id), GameState::Settled);
}

#[test]
fn annul_signatures_are_checked_against_the_current_key() {
    let mut s = Suite::new();
    let id = s.started(3);
    let bob = s.players[2].clone();
    let k = rotated(2);
    s.exec(&bob, &rotate(id, &k.pubkey), &[]).unwrap();
    let who = s.outsider.clone();
    let old = s.annul_sigs(id, &[0, 1, 2], 0);
    assert_eq!(
        s.exec(
            &who,
            &ExecuteMsg::AnnulByConsent {
                chain_game_id: id,
                consents: old,
            },
            &[],
        )
        .unwrap_err(),
        ContractError::InvalidConsent { seat_index: 2 }
    );
    let mut sigs = s.annul_sigs(id, &[0, 1], 0);
    let digest = crypto::annul_digest(&s.domain(id), 0);
    sigs.push(SeatSignature {
        seat_index: 2,
        signature: k.sign(&digest),
    });
    s.exec(
        &who,
        &ExecuteMsg::AnnulByConsent {
            chain_game_id: id,
            consents: sigs,
        },
        &[],
    )
    .unwrap();
    assert_eq!(s.state(id), GameState::Annulled);
}

#[test]
fn rotation_never_changes_the_roster_hash_or_domain() {
    let mut s = Suite::new();
    let id = s.started(3);
    let g = s.game(id).game;
    let (domain, roster) = (g.domain.clone(), g.roster_hash.clone());
    for seat in 0..3 {
        let who = s.players[seat].clone();
        s.exec(&who, &rotate(id, &rotated(seat).pubkey), &[])
            .unwrap();
    }
    let g = s.game(id).game;
    assert_eq!(g.domain, domain);
    assert_eq!(g.roster_hash, roster);
    assert_eq!(g.last_seq.u64(), 0);

    // A rotation before Start does not enter the domain frozen at Start: it is
    // exactly the domain of the wallets alone.
    let a = s.funded(2);
    let creator = s.players[0].clone();
    s.exec(&creator, &rotate(a, &rotated(0).pubkey), &[])
        .unwrap();
    s.start(a);
    let wallets: Vec<String> = s
        .game(a)
        .game
        .seats
        .iter()
        .map(|x| x.wallet.to_string())
        .collect();
    let expected = crypto::settlement_domain(&DomainInputs {
        chain_id: MAINNET,
        contract_addr: s.contract.as_str(),
        chain_game_id: a,
        roster_hash: crypto::roster_hash(&wallets).unwrap(),
        rules_engine_version: RULES_ENGINE_VERSION,
        variants_digest: sha256(&[b"18JUNO/TEST/variants"]),
        ante_gross: ANTE,
        mode: 0,
    })
    .unwrap();
    assert_eq!(s.domain(a), expected);
}

#[test]
fn malformed_keys_are_refused() {
    let mut s = Suite::new();
    let id = s.started(3);
    let alice = s.players[1].clone();
    let mut prefix04 = Key::seat(9).pubkey.to_vec();
    prefix04[0] = 0x04;
    let uncompressed = {
        let k = Key::seat(9);
        HexBinary::from(k.sk.verifying_key().to_encoded_point(false).as_bytes())
    };
    for bad in [
        HexBinary::from(vec![0x02u8; 32]),
        HexBinary::from(vec![0x02u8; 34]),
        HexBinary::from(prefix04),
        HexBinary::from(vec![0u8; 33]),
        HexBinary::from(Vec::<u8>::new()),
        uncompressed,
    ] {
        assert_eq!(
            s.exec(&alice, &rotate(id, &bad), &[]).unwrap_err(),
            ContractError::BadPubkey {
                field: "new_pubkey".to_string()
            }
        );
    }
    assert_eq!(s.game(id).game.seats[1].consent_pubkey, Key::seat(1).pubkey);
}

/// A consent counts only while the key that gave it is the seat's current key
/// (ESCROW-2.1; in ESCROW-2 a recorded consent survived a rotation).
#[test]
fn a_rotation_withdraws_the_seats_recorded_consent() {
    let mut s = Suite::new();
    let id = s.started(3);
    let p = s.settle(id, 1, 200, &[1, 2, 3], &[0, 1]);
    assert_eq!(s.game(id).game.consent_bitmap, 0b011);
    let creator = s.players[0].clone();
    // Re-setting the current key is a no-op and withdraws nothing.
    let res = s
        .exec(&creator, &rotate(id, &Key::seat(0).pubkey), &[])
        .unwrap();
    assert_eq!(attr(&res, "consent_withdrawn"), "false");
    assert_eq!(s.game(id).game.consent_bitmap, 0b011);
    // A real rotation withdraws seat 0's consent, and only seat 0's.
    let res = s
        .exec(&creator, &rotate(id, &rotated(0).pubkey), &[])
        .unwrap();
    assert_eq!(attr(&res, "consent_withdrawn"), "true");
    let g = s.game(id).game;
    assert_eq!(g.consent_bitmap, 0b010);
    assert_eq!(g.state, GameState::Settleable);
    // Seat 0 consents again with its new key; seat 2 completes it.
    let digest = s.consent_digest(id, &p);
    let who = s.outsider.clone();
    for (seat, key) in [(0u8, rotated(0)), (2, Key::seat(2))] {
        s.exec(
            &who,
            &ExecuteMsg::Consent {
                chain_game_id: id,
                seat_index: seat,
                signature: key.sign(&digest),
            },
            &[],
        )
        .unwrap();
    }
    assert_eq!(s.state(id), GameState::Settled);
}

/// Seat 0 consents with K0 and rotates away; seat 1 adopts K0; K0's on-chain
/// signature is replayed as seat 1's consent. Seat 0's consent went with the
/// rotation, so K0 still fills one seat only and 3-of-3 still needs three
/// distinct keys (review finding, ESCROW-2.1).
#[test]
fn one_key_cannot_fill_two_seats_across_a_rotation() {
    let mut s = Suite::new();
    let id = s.started(3);
    let p = s.settle(id, 1, 200, &[1, 2, 3], &[0]);
    let digest = s.consent_digest(id, &p);
    let k0_sig = Key::seat(0).sign(&digest);
    let creator = s.players[0].clone();
    let alice = s.players[1].clone();
    s.exec(&creator, &rotate(id, &rotated(0).pubkey), &[])
        .unwrap();
    s.exec(&alice, &rotate(id, &Key::seat(0).pubkey), &[])
        .unwrap();
    let who = s.outsider.clone();
    let consent = |seat: u8, signature: HexBinary| ExecuteMsg::Consent {
        chain_game_id: id,
        seat_index: seat,
        signature,
    };
    s.exec(&who, &consent(1, k0_sig.clone()), &[]).unwrap();
    s.exec(&who, &consent(2, Key::seat(2).sign(&digest)), &[])
        .unwrap();
    // Two private keys have signed: not settled.
    let g = s.game(id).game;
    assert_eq!(g.consent_bitmap, 0b110);
    assert_eq!(g.state, GameState::Settleable);
    // K0's signature cannot go back on seat 0 either.
    assert_eq!(
        s.exec(&who, &consent(0, k0_sig), &[]).unwrap_err(),
        ContractError::InvalidConsent { seat_index: 0 }
    );
    // Only seat 0's own current key completes it.
    s.exec(&who, &consent(0, rotated(0).sign(&digest)), &[])
        .unwrap();
    assert_eq!(s.state(id), GameState::Settled);
}

#[test]
fn join_refuses_a_consent_key_another_seat_already_holds() {
    let mut s = Suite::new();
    let id = s.create(0, 4, Mode::Live, ANTE);
    s.join(id, 1, ANTE);
    let bob = s.players[2].clone();
    for (holder, key) in [(0u8, Key::seat(0)), (1, Key::seat(1))] {
        let msg = ExecuteMsg::Join {
            chain_game_id: id,
            consent_pubkey: key.pubkey.clone(),
            join_ticket: ticket("bob"),
        };
        assert_eq!(
            s.exec(&bob, &msg, &coins(ANTE, DENOM)).unwrap_err(),
            ContractError::ConsentKeyInUse { seat_index: holder }
        );
    }
    // Upper-case hex decodes to the same bytes: still the same key.
    let upper = HexBinary::from_hex(&Key::seat(0).pubkey.to_hex().to_uppercase()).unwrap();
    assert_eq!(
        s.exec(
            &bob,
            &ExecuteMsg::Join {
                chain_game_id: id,
                consent_pubkey: upper,
                join_ticket: ticket("bob"),
            },
            &coins(ANTE, DENOM),
        )
        .unwrap_err(),
        ContractError::ConsentKeyInUse { seat_index: 0 }
    );
    assert_eq!(s.game(id).game.seats.len(), 2);
    // A distinct key is accepted.
    s.join(id, 2, ANTE);
    assert_eq!(s.game(id).game.seats.len(), 3);
    s.assert_custody();
}

#[test]
fn a_withdrawn_seats_key_is_free_again() {
    let mut s = Suite::new();
    let id = s.create(0, 3, Mode::Live, ANTE);
    s.join(id, 1, ANTE);
    let alice = s.players[1].clone();
    s.exec(&alice, &ExecuteMsg::Withdraw { chain_game_id: id }, &[])
        .unwrap();
    let bob = s.players[2].clone();
    s.exec(
        &bob,
        &ExecuteMsg::Join {
            chain_game_id: id,
            consent_pubkey: Key::seat(1).pubkey,
            join_ticket: ticket("bob"),
        },
        &coins(ANTE, DENOM),
    )
    .unwrap();
    assert_eq!(s.game(id).game.seats[1].consent_pubkey, Key::seat(1).pubkey);
}

#[test]
fn rotation_refuses_another_seats_current_key() {
    let mut s = Suite::new();
    let id = s.started(3);
    let alice = s.players[1].clone();
    for (holder, key) in [(0u8, Key::seat(0)), (2, Key::seat(2))] {
        assert_eq!(
            s.exec(&alice, &rotate(id, &key.pubkey), &[]).unwrap_err(),
            ContractError::ConsentKeyInUse { seat_index: holder }
        );
    }
    // Own current key: the idempotent no-op; a fresh key: accepted.
    let res = s
        .exec(&alice, &rotate(id, &Key::seat(1).pubkey), &[])
        .unwrap();
    assert_eq!(attr(&res, "changed"), "false");
    s.exec(&alice, &rotate(id, &rotated(1).pubkey), &[])
        .unwrap();
    // Once alice moved away, her old key is no seat's current key any more.
    let bob = s.players[2].clone();
    s.exec(&bob, &rotate(id, &Key::seat(1).pubkey), &[])
        .unwrap();
    let keys: Vec<HexBinary> = s
        .game(id)
        .game
        .seats
        .iter()
        .map(|x| x.consent_pubkey.clone())
        .collect();
    assert_eq!(
        keys,
        vec![Key::seat(0).pubkey, rotated(1).pubkey, Key::seat(1).pubkey]
    );
    // And now the creator cannot take bob's (formerly alice's) key.
    let creator = s.players[0].clone();
    assert_eq!(
        s.exec(&creator, &rotate(id, &Key::seat(1).pubkey), &[])
            .unwrap_err(),
        ContractError::ConsentKeyInUse { seat_index: 2 }
    );
}

#[test]
fn n_of_n_needs_n_distinct_consent_keys() {
    // A shared key could previously sign for two seats (the CONSENT and ANNUL
    // digests carry no seat index). Keys are now unique per game and a
    // rotation withdraws the seat's recorded consent, so each recorded
    // consent is backed by that seat's own current key.
    let mut s = Suite::new();
    let id = s.started(3);
    let alice = s.players[1].clone();
    assert!(matches!(
        s.exec(&alice, &rotate(id, &Key::seat(0).pubkey), &[])
            .unwrap_err(),
        ContractError::ConsentKeyInUse { .. }
    ));
    // Seat 0's key cannot stand in for seat 1 in a settlement ...
    let p = s.terminal_payload(id, 1, 300, &[3, 1, 1]);
    let digest = s.consent_digest(id, &p);
    let sig0 = Key::seat(0).sign(&digest);
    let (payload, signature) = s.signed(&p);
    let op = s.operator.clone();
    let consents = vec![
        SeatSignature {
            seat_index: 0,
            signature: sig0.clone(),
        },
        SeatSignature {
            seat_index: 1,
            signature: sig0,
        },
        SeatSignature {
            seat_index: 2,
            signature: Key::seat(2).sign(&digest),
        },
    ];
    assert_eq!(
        s.exec(
            &op,
            &ExecuteMsg::Settle {
                chain_game_id: id,
                payload,
                signature,
                consents,
            },
            &[],
        )
        .unwrap_err(),
        ContractError::InvalidConsent { seat_index: 1 }
    );
    // ... nor in an annul.
    let annul = crypto::annul_digest(&s.domain(id), 0);
    let a0 = Key::seat(0).sign(&annul);
    let who = s.outsider.clone();
    assert_eq!(
        s.exec(
            &who,
            &ExecuteMsg::AnnulByConsent {
                chain_game_id: id,
                consents: vec![
                    SeatSignature {
                        seat_index: 0,
                        signature: a0.clone(),
                    },
                    SeatSignature {
                        seat_index: 1,
                        signature: a0,
                    },
                    SeatSignature {
                        seat_index: 2,
                        signature: Key::seat(2).sign(&annul),
                    },
                ],
            },
            &[],
        )
        .unwrap_err(),
        ContractError::InvalidConsent { seat_index: 1 }
    );
    // Every seat's own key: accepted.
    let sigs = s.annul_sigs(id, &[0, 1, 2], 0);
    s.exec(
        &who,
        &ExecuteMsg::AnnulByConsent {
            chain_game_id: id,
            consents: sigs,
        },
        &[],
    )
    .unwrap();
    assert_eq!(s.state(id), GameState::Annulled);
    let g = s.game(id).game;
    let mut keys: Vec<Vec<u8>> = g.seats.iter().map(|x| x.consent_pubkey.to_vec()).collect();
    keys.sort();
    keys.dedup();
    assert_eq!(keys.len(), 3, "three seats, three distinct keys");
}
