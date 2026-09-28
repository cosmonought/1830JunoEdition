//! The join admission (2026-09-28 security repair of the junk-Join blocker).
//!
//! Before it, `Join` checked only the ticket's 32-byte shape: any wallet paying
//! the exact ante took a seat, including with a ticket copied out of an honest
//! player's visible `Join`. Now `Join` needs the admission key's signature over
//! (this chain, this contract, this game, the SENDER, this ticket, the expiry),
//! verified before anything is written. These tests attack it from every side
//! and check that everything else `Join` did is unchanged.

mod common;

use common::*;
use cosmwasm_std::{coins, Addr, HexBinary, Uint128, Uint64};
use eighteen_cosmos_escrow::msg::{ExecuteMsg, JoinAdmission};
use eighteen_cosmos_escrow::state::{GameState, Mode};
use eighteen_cosmos_escrow::ContractError;

fn join_with(id: u64, seat: usize, join_ticket: HexBinary, admission: JoinAdmission) -> ExecuteMsg {
    ExecuteMsg::Join {
        chain_game_id: id,
        consent_pubkey: Key::seat(seat).pubkey,
        join_ticket,
        admission,
    }
}

fn admin_exec(
    s: &mut Suite,
    msg: &ExecuteMsg,
) -> Result<cw_multi_test::AppResponse, ContractError> {
    let admin = s.admin.clone();
    s.exec(&admin, msg, &[])
}

/// Refused with `want`, and nothing at all moved: no seat, no ante, no fee.
fn refused_cleanly(s: &mut Suite, sender: &Addr, id: u64, msg: &ExecuteMsg, want: ContractError) {
    let game = s.game(id).game;
    let treasury = s.treasury.clone();
    let (sender_before, contract_before, treasury_before) = (
        s.balance(sender),
        s.contract_balance(),
        s.balance(&treasury),
    );
    assert_eq!(s.exec(sender, msg, &coins(ANTE, DENOM)).unwrap_err(), want);
    assert_eq!(s.game(id).game, game, "no seat was written");
    assert_eq!(s.balance(sender), sender_before, "no ante was taken");
    assert_eq!(s.contract_balance(), contract_before);
    assert_eq!(s.balance(&treasury), treasury_before, "no fee was taken");
    s.assert_custody();
}

// ------------------------------------------------------------------ positive

#[test]
fn an_admitted_wallet_joins_and_everything_else_is_as_before() {
    let mut s = Suite::new();
    let id = s.create(0, 3, Mode::Live, ANTE);
    let treasury = s.treasury.clone();
    let fee_before = s.balance(&treasury);
    let alice = s.players[1].clone();
    let msg = s.join_msg(id, 1);
    let res = s.exec(&alice, &msg, &coins(ANTE, DENOM)).unwrap();
    assert_eq!(attr(&res, "action"), "join");
    assert_eq!(attr(&res, "wallet"), alice.as_str());
    assert_eq!(attr(&res, "chain_seat_index"), "1");
    let g = s.game(id).game;
    assert_eq!(g.seats[1].wallet, alice);
    assert_eq!(g.seats[1].join_ticket, ticket("alice"));
    assert_eq!(g.seats[1].consent_pubkey, Key::seat(1).pubkey);
    assert_eq!(g.seats[1].gross_deposit.u128(), ANTE);
    assert_eq!(g.seats[1].net_deposit.u128(), NET);
    assert_eq!(g.state, GameState::Funding);
    // The fee is unchanged: the subsidy of THIS deposit went to the treasury.
    assert_eq!(s.balance(&treasury), fee_before + SUBSIDY);
    s.join(id, 2, ANTE);
    assert_eq!(s.state(id), GameState::Funded);
    // Start still commits the seats' wallets (the admitted ones) and works.
    s.start(id);
    assert_eq!(s.state(id), GameState::InProgress);
    s.assert_custody();
}

#[test]
fn create_game_needs_no_admission_and_is_unchanged() {
    let mut s = Suite::new();
    let id = s.create(0, 2, Mode::Async, ANTE);
    let g = s.game(id).game;
    assert_eq!(g.creator, s.players[0]);
    assert_eq!(g.seats.len(), 1);
    assert_eq!(g.seats[0].join_ticket, ticket("creator"));
}

// -------------------------------------------------------------- unauthorized

#[test]
fn a_random_wallet_paying_the_exact_ante_is_refused() {
    let mut s = Suite::new();
    let id = s.create(0, 3, Mode::Live, ANTE);
    let mallory = s.outsider.clone();
    let junk_ticket = HexBinary::from(vec![0xab; 32]);
    for signature in [
        HexBinary::from(vec![0x11; 64]),
        HexBinary::from(vec![]),
        Key::seat(5).sign(&[9; 32]),
    ] {
        let admission = JoinAdmission {
            expires_at: Uint64::new(s.now().seconds() + ADMISSION_TTL),
            signature,
        };
        let msg = join_with(id, 5, junk_ticket.clone(), admission);
        refused_cleanly(
            &mut s,
            &mallory,
            id,
            &msg,
            ContractError::InvalidAdmission {},
        );
    }
}

#[test]
fn a_copied_honest_ticket_or_admission_seats_nobody_else() {
    let mut s = Suite::new();
    let id = s.create(0, 3, Mode::Live, ANTE);
    let alice = s.players[1].clone();
    let mallory = s.outsider.clone();
    // Alice's Join is public while pending: mallory copies it verbatim
    // (ticket AND admission), with her own consent key and the exact ante.
    let alices = s.join_msg(id, 1);
    let copied = match alices.clone() {
        ExecuteMsg::Join {
            chain_game_id,
            join_ticket,
            admission,
            ..
        } => ExecuteMsg::Join {
            chain_game_id,
            consent_pubkey: Key::seat(6).pubkey,
            join_ticket,
            admission,
        },
        _ => unreachable!(),
    };
    refused_cleanly(
        &mut s,
        &mallory,
        id,
        &copied,
        ContractError::InvalidAdmission {},
    );
    // Front-running the last seat therefore fails; alice's own Join lands.
    s.exec(&alice, &alices, &coins(ANTE, DENOM)).unwrap();
    // Even an admitted player cannot reuse his admission for a second wallet
    // he controls: bob's admission is for bob.
    let bob = s.players[2].clone();
    let bobs = s.join_msg(id, 2);
    let erin = s.players[5].clone();
    refused_cleanly(&mut s, &erin, id, &bobs, ContractError::InvalidAdmission {});
    s.exec(&bob, &bobs, &coins(ANTE, DENOM)).unwrap();
    assert_eq!(s.state(id), GameState::Funded);
    let wallets: Vec<Addr> = s
        .game(id)
        .game
        .seats
        .iter()
        .map(|seat| seat.wallet.clone())
        .collect();
    assert_eq!(wallets, vec![s.players[0].clone(), alice, bob]);
}

#[test]
fn an_admission_is_bound_to_its_game_ticket_and_expiry() {
    let mut s = Suite::new();
    let one = s.create(0, 3, Mode::Live, ANTE);
    let two = s.create(3, 3, Mode::Live, ANTE);
    let alice = s.players[1].clone();
    let for_one = s.admission_for(one, &alice, &ticket("alice"));
    // Another game of the same contract.
    let msg = join_with(two, 1, ticket("alice"), for_one.clone());
    refused_cleanly(
        &mut s,
        &alice,
        two,
        &msg,
        ContractError::InvalidAdmission {},
    );
    // A changed ticket (the admission covers exactly one ticket).
    let msg = join_with(one, 1, ticket("alice-2"), for_one.clone());
    refused_cleanly(
        &mut s,
        &alice,
        one,
        &msg,
        ContractError::InvalidAdmission {},
    );
    // A changed expiry (later or earlier) is not the signed expiry.
    for delta in [1i64, -1] {
        let mut stretched = for_one.clone();
        stretched.expires_at = Uint64::new((stretched.expires_at.u64() as i64 + delta) as u64);
        let msg = join_with(one, 1, ticket("alice"), stretched);
        refused_cleanly(
            &mut s,
            &alice,
            one,
            &msg,
            ContractError::InvalidAdmission {},
        );
    }
    // The untouched admission works in its own game.
    s.exec(
        &alice,
        &join_with(one, 1, ticket("alice"), for_one),
        &coins(ANTE, DENOM),
    )
    .unwrap();
}

#[test]
fn malformed_and_foreign_signatures_are_refused_without_panicking() {
    let mut s = Suite::new();
    let id = s.create(0, 3, Mode::Live, ANTE);
    let alice = s.players[1].clone();
    let expires_at = s.now().seconds() + ADMISSION_TTL;
    let digest = s.admission_digest(id, &alice, &ticket("alice"), expires_at);
    let good = s.admission.sign_bytes(&digest);
    let mut bad: Vec<HexBinary> = vec![
        HexBinary::from(vec![]),
        HexBinary::from(good[..63].to_vec()),
        HexBinary::from([good.as_slice(), &[0]].concat()),
        HexBinary::from([good.as_slice(), good.as_slice()].concat()),
        HexBinary::from(vec![0u8; 64]),
        HexBinary::from(vec![0xffu8; 64]),
        HexBinary::from(high_s(good).to_vec()),
        Key::admission(2).sign(&digest),
        Key::signer(1).sign(&digest),
        Key::seat(1).sign(&digest),
    ];
    for i in [0usize, 31, 32, 63] {
        let mut flipped = good;
        flipped[i] ^= 0x80;
        bad.push(HexBinary::from(flipped.to_vec()));
    }
    for signature in bad {
        let msg = join_with(
            id,
            1,
            ticket("alice"),
            JoinAdmission {
                expires_at: Uint64::new(expires_at),
                signature,
            },
        );
        refused_cleanly(&mut s, &alice, id, &msg, ContractError::InvalidAdmission {});
    }
    let msg = join_with(
        id,
        1,
        ticket("alice"),
        JoinAdmission {
            expires_at: Uint64::new(expires_at),
            signature: HexBinary::from(good.to_vec()),
        },
    );
    s.exec(&alice, &msg, &coins(ANTE, DENOM)).unwrap();
}

#[test]
fn a_join_without_an_admission_field_does_not_parse() {
    // The pre-repair wire shape (no `admission`) is not a message any more.
    let json = r#"{"join":{"chain_game_id":1,"consent_pubkey":"02","join_ticket":"00"}}"#;
    assert!(cosmwasm_std::from_json::<ExecuteMsg>(json.as_bytes()).is_err());
}

// ------------------------------------------------------------------ expiry

#[test]
fn the_admission_expires_at_block_time_expires_at() {
    let mut s = Suite::new();
    let id = s.create(0, 4, Mode::Live, ANTE);
    let alice = s.players[1].clone();
    let now = s.now().seconds();
    let admission = s.admission_until(id, &alice, &ticket("alice"), now + 10);
    let msg = join_with(id, 1, ticket("alice"), admission);
    s.advance(10);
    refused_cleanly(
        &mut s,
        &alice,
        id,
        &msg,
        ContractError::AdmissionExpired {
            expires_at: now + 10,
        },
    );
    // One second earlier it is still good.
    let mut s = Suite::new();
    let id = s.create(0, 4, Mode::Live, ANTE);
    let admission = s.admission_until(id, &alice, &ticket("alice"), now + 10);
    s.advance(9);
    s.exec(
        &alice,
        &join_with(id, 1, ticket("alice"), admission),
        &coins(ANTE, DENOM),
    )
    .unwrap();
    // A zero or past expiry is refused even when correctly signed.
    let bob = s.players[2].clone();
    for past in [0, now] {
        let admission = s.admission_until(id, &bob, &ticket("bob"), past);
        let msg = join_with(id, 2, ticket("bob"), admission);
        refused_cleanly(
            &mut s,
            &bob,
            id,
            &msg,
            ContractError::AdmissionExpired { expires_at: past },
        );
    }
}

#[test]
fn withdraw_and_rejoin_reuses_the_admission_only_until_it_expires() {
    let mut s = Suite::new();
    let id = s.create(0, 4, Mode::Live, ANTE);
    let alice = s.players[1].clone();
    let msg = s.join_msg(id, 1);
    s.exec(&alice, &msg, &coins(ANTE, DENOM)).unwrap();
    // The same bytes again: already seated.
    assert_eq!(
        s.exec(&alice, &msg, &coins(ANTE, DENOM)).unwrap_err(),
        ContractError::AlreadyJoined { chain_game_id: id }
    );
    s.exec(&alice, &ExecuteMsg::Withdraw { chain_game_id: id }, &[])
        .unwrap();
    // Within its lifetime the admission still names (this game, alice, her
    // ticket): the same player re-seats herself.
    s.exec(&alice, &msg, &coins(ANTE, DENOM)).unwrap();
    s.exec(&alice, &ExecuteMsg::Withdraw { chain_game_id: id }, &[])
        .unwrap();
    // After it, the server must be asked again (which re-checks the ticket).
    s.advance(ADMISSION_TTL);
    let expires_at = match &msg {
        ExecuteMsg::Join { admission, .. } => admission.expires_at.u64(),
        _ => unreachable!(),
    };
    refused_cleanly(
        &mut s,
        &alice,
        id,
        &msg,
        ContractError::AdmissionExpired { expires_at },
    );
    let fresh = s.join_msg(id, 1);
    s.exec(&alice, &fresh, &coins(ANTE, DENOM)).unwrap();
}

// ------------------------------------------------------------------ rotation

#[test]
fn only_the_admin_sets_the_admission_key_and_never_to_a_signer_key() {
    let mut s = Suite::new();
    let new_key = Key::admission(2).pubkey;
    let mallory = s.outsider.clone();
    assert_eq!(
        s.exec(
            &mallory,
            &ExecuteMsg::SetAdmissionKey {
                pubkey: new_key.clone()
            },
            &[]
        )
        .unwrap_err(),
        ContractError::Unauthorized {
            role: "admin".to_string()
        }
    );
    let operator = s.operator.clone();
    assert!(s
        .exec(
            &operator,
            &ExecuteMsg::SetAdmissionKey {
                pubkey: new_key.clone()
            },
            &[]
        )
        .is_err());
    let admin = s.admin.clone();
    assert_eq!(
        s.exec(
            &admin,
            &ExecuteMsg::SetAdmissionKey {
                pubkey: new_key.clone()
            },
            &coins(1, DENOM)
        )
        .unwrap_err(),
        ContractError::NonPayable {}
    );
    for (bad, want) in [
        (
            HexBinary::from(vec![0x02; 32]),
            ContractError::BadPubkey {
                field: "admission_pubkey".to_string(),
            },
        ),
        (
            HexBinary::from(vec![0x04; 65]),
            ContractError::BadPubkey {
                field: "admission_pubkey".to_string(),
            },
        ),
        (
            Key::signer(1).pubkey,
            ContractError::InvalidParams {
                reason: "the join-admission key cannot be settlement signer key 1".to_string(),
            },
        ),
    ] {
        assert_eq!(
            admin_exec(&mut s, &ExecuteMsg::SetAdmissionKey { pubkey: bad }).unwrap_err(),
            want
        );
    }
    // A retired (even compromised) signer key stays unusable as the admission key.
    admin_exec(
        &mut s,
        &ExecuteMsg::AddSignerKey {
            pubkey: Key::signer(2).pubkey,
        },
    )
    .unwrap();
    admin_exec(
        &mut s,
        &ExecuteMsg::RetireSignerKey {
            key_id: 2,
            compromised: true,
        },
    )
    .unwrap();
    assert!(matches!(
        admin_exec(
            &mut s,
            &ExecuteMsg::SetAdmissionKey {
                pubkey: Key::signer(2).pubkey
            }
        )
        .unwrap_err(),
        ContractError::InvalidParams { .. }
    ));
    // And the admission key can never become a signer key.
    assert_eq!(
        admin_exec(
            &mut s,
            &ExecuteMsg::AddSignerKey {
                pubkey: Key::admission(1).pubkey
            }
        )
        .unwrap_err(),
        ContractError::InvalidParams {
            reason: "a settlement signer key cannot be a current or former join-admission key"
                .to_string()
        }
    );
    assert_eq!(s.config().config.admission_pubkey, Key::admission(1).pubkey);
    let res = admin_exec(
        &mut s,
        &ExecuteMsg::SetAdmissionKey {
            pubkey: new_key.clone(),
        },
    )
    .unwrap();
    assert_eq!(attr(&res, "admission_pubkey"), new_key.to_hex());
    assert_eq!(s.config().config.admission_pubkey, new_key);
}

#[test]
fn rotation_invalidates_pending_admissions_at_once_and_keeps_seats() {
    let mut s = Suite::new();
    let id = s.create(0, 4, Mode::Live, ANTE);
    s.join(id, 1, ANTE);
    let bob = s.players[2].clone();
    let pending = s.join_msg(id, 2); // signed by key 1, not yet included
    admin_exec(
        &mut s,
        &ExecuteMsg::SetAdmissionKey {
            pubkey: Key::admission(2).pubkey,
        },
    )
    .unwrap();
    // The in-flight Join fails and moves nothing (no funds are stranded).
    refused_cleanly(
        &mut s,
        &bob,
        id,
        &pending,
        ContractError::InvalidAdmission {},
    );
    // Seats taken under the old key are untouched.
    assert_eq!(s.game(id).game.seats[1].wallet, s.players[1]);
    // The server re-issues under the new key and the Join lands.
    s.admission = Key::admission(2);
    let reissued = s.join_msg(id, 2);
    s.exec(&bob, &reissued, &coins(ANTE, DENOM)).unwrap();
    // A FORMER admission key (perhaps rotated out because it leaked) can never
    // come back as a settlement signer key.
    assert_eq!(
        admin_exec(
            &mut s,
            &ExecuteMsg::AddSignerKey {
                pubkey: Key::admission(1).pubkey,
            },
        )
        .unwrap_err(),
        ContractError::InvalidParams {
            reason: "a settlement signer key cannot be a current or former join-admission key"
                .to_string()
        }
    );
    // Rotating back is allowed (the key is not a signer key).
    admin_exec(
        &mut s,
        &ExecuteMsg::SetAdmissionKey {
            pubkey: Key::admission(1).pubkey,
        },
    )
    .unwrap();
    s.admission = Key::admission(1);
    s.join(id, 3, ANTE);
    assert_eq!(s.state(id), GameState::Funded);
}

// --------------------------------------------------------- existing semantics

#[test]
fn an_admission_does_not_relax_any_other_join_rule() {
    let mut s = Suite::new();
    let id = s.create(0, 2, Mode::Live, ANTE);
    let alice = s.players[1].clone();
    let msg = s.join_msg(id, 1);
    // Exact ante, one coin of the denom.
    for wrong in [ANTE - 1, ANTE + 1] {
        assert_eq!(
            s.exec(&alice, &msg, &coins(wrong, DENOM)).unwrap_err(),
            ContractError::WrongAnte {
                expected: Uint128::new(ANTE),
                got: Uint128::new(wrong)
            }
        );
    }
    assert_eq!(
        s.exec(&alice, &msg, &coins(ANTE, "uatom")).unwrap_err(),
        ContractError::InvalidFunds {
            denom: DENOM.to_string()
        }
    );
    // Consent keys stay unique within a game.
    let dup = join_with(
        id,
        0,
        ticket("alice"),
        s.admission_for(id, &alice, &ticket("alice")),
    );
    assert_eq!(
        s.exec(&alice, &dup, &coins(ANTE, DENOM)).unwrap_err(),
        ContractError::ConsentKeyInUse { seat_index: 0 }
    );
    // Pause still wins.
    admin_exec(&mut s, &ExecuteMsg::Pause {}).unwrap();
    assert_eq!(
        s.exec(&alice, &msg, &coins(ANTE, DENOM)).unwrap_err(),
        ContractError::Paused {}
    );
    admin_exec(&mut s, &ExecuteMsg::Unpause {}).unwrap();
    s.exec(&alice, &msg, &coins(ANTE, DENOM)).unwrap();
    // Max players: a full (FUNDED) game takes no one, admitted or not.
    let bob = s.players[2].clone();
    let late = s.join_msg(id, 2);
    assert!(matches!(
        s.exec(&bob, &late, &coins(ANTE, DENOM)).unwrap_err(),
        ContractError::WrongState { .. }
    ));
    // The funding deadline still closes Join, whatever the admission says.
    let mut s = Suite::new();
    let id = s.create(0, 3, Mode::Live, ANTE);
    let long = s.admission_until(id, &alice, &ticket("alice"), s.now().seconds() + 3 * DAY);
    s.advance(DAY);
    assert_eq!(
        s.exec(
            &alice,
            &join_with(id, 1, ticket("alice"), long),
            &coins(ANTE, DENOM)
        )
        .unwrap_err(),
        ContractError::FundingClosed {}
    );
}

#[test]
fn the_junk_join_griefing_path_is_closed_and_the_honest_table_starts() {
    // The ESCROW-3B scenario: one seat open, an outsider races the honest last
    // joiner with any ticket (or the honest one) and the exact ante.
    let mut s = Suite::new();
    let id = s.create(0, 3, Mode::Live, ANTE);
    s.join(id, 1, ANTE);
    let mallory = s.outsider.clone();
    let bobs_ticket = ticket("bob");
    for junk_ticket in [HexBinary::from(vec![0xab; 32]), bobs_ticket.clone()] {
        // Mallory may even hold a GENUINE admission -- for another game.
        let other = s.create(4, 3, Mode::Live, ANTE);
        let foreign = s.admission_for(other, &mallory, &junk_ticket);
        let msg = join_with(id, 6, junk_ticket, foreign);
        refused_cleanly(
            &mut s,
            &mallory,
            id,
            &msg,
            ContractError::InvalidAdmission {},
        );
    }
    assert_eq!(
        s.state(id),
        GameState::Funding,
        "the table was not filled by a junk seat"
    );
    s.join(id, 2, ANTE);
    s.start(id);
    assert_eq!(s.state(id), GameState::InProgress);
}
