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

#[test]
fn a_recorded_consent_survives_a_later_rotation() {
    let mut s = Suite::new();
    let id = s.started(3);
    s.settle(id, 1, 200, &[1, 2, 3], &[0]);
    let creator = s.players[0].clone();
    s.exec(&creator, &rotate(id, &rotated(0).pubkey), &[])
        .unwrap();
    let g = s.game(id).game;
    assert_eq!(g.consent_bitmap, 0b001);
    assert_eq!(g.state, GameState::Settleable);
}

#[test]
fn a_seat_may_share_another_seats_key_which_acts_as_delegation() {
    // Documented behaviour: the CONSENT digest carries no seat index, so a
    // consent key shared by two seats authorises both.
    let mut s = Suite::new();
    let id = s.started(2);
    let alice = s.players[1].clone();
    s.exec(&alice, &rotate(id, &Key::seat(0).pubkey), &[])
        .unwrap();
    let p = s.terminal_payload(id, 1, 300, &[3, 1]);
    let digest = s.consent_digest(id, &p);
    let sig = Key::seat(0).sign(&digest);
    let (payload, signature) = s.signed(&p);
    let op = s.operator.clone();
    s.exec(
        &op,
        &ExecuteMsg::Settle {
            chain_game_id: id,
            payload,
            signature,
            consents: vec![
                SeatSignature {
                    seat_index: 0,
                    signature: sig.clone(),
                },
                SeatSignature {
                    seat_index: 1,
                    signature: sig,
                },
            ],
        },
        &[],
    )
    .unwrap();
    assert_eq!(s.state(id), GameState::Settled);
}
