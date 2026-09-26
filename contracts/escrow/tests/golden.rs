//! SET-0A rev 2 golden payout vectors (P1–P13, Q16 and the 13 case previews),
//! through the pure payout function every payout path uses, and through the
//! contract on chain wherever the vector's pool is reachable with equal
//! deposits.

mod common;

use common::*;
use cosmwasm_std::Uint128;
use eighteen_cosmos_escrow::msg::ExecuteMsg;
use eighteen_cosmos_escrow::payload::{
    REASON_BANKRUPTCY, REASON_BANK_BROKEN, REASON_CLEMENCY, REASON_FORFEIT,
};
use eighteen_cosmos_escrow::payout::proportional_split;
use eighteen_cosmos_escrow::state::{GameParams, GameState, Mode};
use eighteen_cosmos_escrow::ContractError;
use serde_json::Value;

fn extract() -> Value {
    serde_json::from_str(include_str!("../testdata/set0a_payout_vectors_rev2.json")).unwrap()
}

fn nums(v: &Value) -> Vec<u128> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|x| x.as_str().unwrap().parse().unwrap())
        .collect()
}

fn num(v: &Value) -> u128 {
    v.as_str().unwrap().parse().unwrap()
}

fn uints(xs: &[u128]) -> Vec<Uint128> {
    xs.iter().map(|x| Uint128::new(*x)).collect()
}

struct Vector {
    name: String,
    pool: u128,
    weights: Vec<u128>,
    expected: Option<(Vec<u128>, u128)>,
}

fn all_vectors() -> Vec<Vector> {
    let doc = extract();
    let mut out = Vec::new();
    for v in doc["payout_vectors"].as_array().unwrap() {
        out.push(Vector {
            name: v["name"].as_str().unwrap().to_string(),
            pool: num(&v["pool_ujuno"]),
            weights: nums(&v["weights"]),
            expected: if v.get("error").is_some() {
                None
            } else {
                Some((nums(&v["payouts_ujuno"]), num(&v["dust_ujuno"])))
            },
        });
    }
    let q = &doc["q16_reconstructed"];
    out.push(Vector {
        name: q["name"].as_str().unwrap().to_string(),
        pool: num(&q["pool_ujuno"]),
        weights: nums(&q["weights"]),
        expected: Some((nums(&q["payouts_ujuno"]), num(&q["dust_ujuno"]))),
    });
    for c in doc["case_previews"].as_array().unwrap() {
        out.push(Vector {
            name: c["name"].as_str().unwrap().to_string(),
            pool: num(&c["pool_ujuno"]),
            weights: nums(&c["vector"]),
            expected: Some((nums(&c["payouts_ujuno"]), num(&c["dust_ujuno"]))),
        });
    }
    out
}

#[test]
fn extract_provenance() {
    let doc = extract();
    assert!(doc["source"]
        .as_str()
        .unwrap()
        .contains("claude/SET0A_golden_vectors_2026-09-25.json"));
    assert!(doc["source"].as_str().unwrap().contains("revision 2"));
    assert_eq!(doc["payout_vectors"].as_array().unwrap().len(), 13);
    assert_eq!(doc["case_previews"].as_array().unwrap().len(), 13);
}

#[test]
fn every_golden_vector_through_the_payout_function() {
    let vectors = all_vectors();
    assert_eq!(vectors.len(), 27);
    for v in &vectors {
        let got = proportional_split(Uint128::new(v.pool), &uints(&v.weights));
        match &v.expected {
            None => assert_eq!(got, Err(ContractError::ZeroSumWeights {}), "{}", v.name),
            Some((payouts, dust)) => {
                let split = got.unwrap_or_else(|e| panic!("{}: {e}", v.name));
                let amounts: Vec<u128> = split.amounts.iter().map(|a| a.u128()).collect();
                assert_eq!(&amounts, payouts, "{}", v.name);
                assert_eq!(split.dust.u128(), *dust, "{}", v.name);
                // Σ payouts + dust = pool, every payout ≤ pool.
                let total: u128 = amounts.iter().sum::<u128>() + split.dust.u128();
                assert_eq!(total, v.pool, "{}", v.name);
                assert!(amounts.iter().all(|a| *a <= v.pool));
            }
        }
    }
}

#[test]
fn p11_to_p13_really_need_a_wide_intermediate() {
    let doc = extract();
    for v in doc["payout_vectors"].as_array().unwrap() {
        if v.get("requires_wide_intermediate").is_none() {
            continue;
        }
        let name = v["name"].as_str().unwrap();
        let pool = num(&v["pool_ujuno"]);
        let weights = nums(&v["weights"]);
        let flags: Vec<&str> = v["u128_overflow"]
            .as_array()
            .unwrap()
            .iter()
            .map(|f| f.as_str().unwrap())
            .collect();
        let sum_overflows = weights
            .iter()
            .try_fold(0u128, |acc, w| acc.checked_add(*w))
            .is_none();
        let product_overflows = weights.iter().any(|w| pool.checked_mul(*w).is_none());
        assert_eq!(flags.contains(&"sum"), sum_overflows, "{name}");
        assert_eq!(flags.contains(&"product"), product_overflows, "{name}");
        assert!(sum_overflows || product_overflows, "{name}");
        // A u128-only implementation (pool·w in u128, or multiply_ratio with a
        // u128 denominator) cannot evaluate these at all.
        if product_overflows {
            assert!(weights
                .iter()
                .any(|w| Uint128::new(pool).checked_mul(Uint128::new(*w)).is_err()));
        }
        if sum_overflows {
            assert!(weights
                .iter()
                .try_fold(Uint128::zero(), |acc, w| acc.checked_add(Uint128::new(*w)))
                .is_err());
        }
        // The contract's split reproduces them exactly (asserted above too).
        let split = proportional_split(Uint128::new(pool), &uints(&weights)).unwrap();
        assert_eq!(
            split.amounts.iter().map(|a| a.u128()).collect::<Vec<_>>(),
            nums(&v["payouts_ujuno"]),
            "{name}"
        );
    }
}

/// Runs one vector through the contract: n seats deposit `gross` each (at the
/// given subsidy), then a Terminal payload with every seat's consent settles
/// immediately. Asserts each wallet's and the treasury's balance change.
fn run_on_chain(
    name: &str,
    subsidy_bps: u16,
    gross: u128,
    reason: u8,
    weights: &[u128],
    expected: &(Vec<u128>, u128),
) {
    let n = weights.len();
    let params = GameParams {
        subsidy_bps,
        min_ante: Uint128::new(1),
        ..default_params()
    };
    let mut s = SuiteBuilder::default().params(params).build();
    let id = s.started_with(n, Mode::Live, gross);
    let before: Vec<u128> = (0..n).map(|i| s.balance(&s.players[i].clone())).collect();
    let treasury_before = s.balance(&s.treasury.clone());
    let p = s.terminal_payload(id, reason, 500, weights);
    let seats: Vec<usize> = (0..n).collect();
    let msg = s.settle_msg(id, &p, &seats);
    let op = s.operator.clone();
    s.exec(&op, &msg, &[])
        .unwrap_or_else(|e| panic!("{name}: {e}"));
    assert_eq!(s.state(id), GameState::Settled, "{name}");
    for (i, (player, b)) in s.players[..n].iter().zip(before.iter()).enumerate() {
        let delta = s.balance(player) - b;
        assert_eq!(delta, expected.0[i], "{name}: seat {i}");
    }
    assert_eq!(
        s.balance(&s.treasury.clone()) - treasury_before,
        expected.1,
        "{name}: dust"
    );
    assert_eq!(s.game(id).game.pool, Uint128::zero());
    s.assert_custody();
}

#[test]
fn golden_vectors_on_chain_with_default_subsidy() {
    // Pools of n × 1_950_000 are reached with 2 JUNO gross at 250 bps.
    let mut ran = 0;
    for v in all_vectors() {
        let Some(expected) = &v.expected else {
            continue;
        };
        let n = v.weights.len() as u128;
        if !(2..=7).contains(&n) || v.pool != n * NET {
            continue;
        }
        let reason = if v.name.contains("BANKRUPTCY") {
            REASON_BANKRUPTCY
        } else if v.name.starts_with("P8") {
            REASON_FORFEIT
        } else if v.name.starts_with("P9") || v.name.starts_with("P10") {
            REASON_CLEMENCY
        } else {
            REASON_BANK_BROKEN
        };
        run_on_chain(&v.name, 250, ANTE, reason, &v.weights, expected);
        ran += 1;
    }
    // P1, P2, P3, P4, P7, P8, P9, P10, P13 and all 13 case previews.
    assert_eq!(ran, 22);
}

#[test]
fn golden_vectors_on_chain_without_subsidy() {
    // Pools that are not n × 1_950_000 but are n × an integer, with 0 bps.
    let mut ran = 0;
    for v in all_vectors() {
        let Some(expected) = &v.expected else {
            continue;
        };
        let n = v.weights.len() as u128;
        if v.pool == n * NET || v.pool % n != 0 {
            continue;
        }
        run_on_chain(
            &v.name,
            0,
            v.pool / n,
            REASON_BANK_BROKEN,
            &v.weights,
            expected,
        );
        ran += 1;
    }
    // P6 (4 × 2.5e14) and Q16 (2 × 5e14). P11 (odd u128::MAX pool) and P12
    // (1e15 over 3 seats) cannot be built from equal deposits; the pure
    // function reproduces them above.
    assert_eq!(ran, 2);
}

#[test]
fn p5_all_zero_weights_are_refused_everywhere() {
    let mut s = Suite::new();
    let id = s.started(2);
    let cp = s.checkpoint_payload(id, 10, &[0, 0]);
    let msg = s.checkpoint_msg(id, &cp);
    let who = s.outsider.clone();
    assert_eq!(
        s.exec(&who, &msg, &[]).unwrap_err(),
        ContractError::ZeroSumWeights {}
    );
    let p = s.terminal_payload(id, REASON_BANK_BROKEN, 20, &[0, 0]);
    let msg = s.settle_msg(id, &p, &[0, 1]);
    assert_eq!(
        s.exec(&who, &msg, &[]).unwrap_err(),
        ContractError::ZeroSumWeights {}
    );
    assert_eq!(s.state(id), GameState::InProgress);
}

#[test]
fn wide_arithmetic_on_chain_beyond_u128() {
    // P11-shaped: two seats of 1e30 ujuno, weights u128::MAX and u128::MAX − 1.
    // pool·w ≈ 6.8e68 overflows u128; the result is exact.
    let params = GameParams {
        subsidy_bps: 0,
        min_ante: Uint128::new(1),
        ..default_params()
    };
    let gross: u128 = 1_000_000_000_000_000_000_000_000_000_000;
    let max = u128::MAX;
    // floor(2e30·(M)/(2M−1)) and floor(2e30·(M−1)/(2M−1)), computed independently
    // (Python big integers): 1e30 and 1e30 − 1; dust 1.
    let expected = (vec![gross, gross - 1], 1u128);
    let mut s = SuiteBuilder::default().params(params).build();
    let id = s.started_with(2, Mode::Live, gross);
    let p = s.terminal_payload(id, REASON_BANK_BROKEN, 77, &[max, max - 1]);
    let msg = s.settle_msg(id, &p, &[0, 1]);
    let before = (
        s.balance(&s.players[0].clone()),
        s.balance(&s.players[1].clone()),
    );
    let op = s.operator.clone();
    s.exec(&op, &msg, &[]).unwrap();
    assert_eq!(s.balance(&s.players[0].clone()) - before.0, expected.0[0]);
    assert_eq!(s.balance(&s.players[1].clone()) - before.1, expected.0[1]);
    assert_eq!(s.game(id).game.outcome.unwrap().dust.u128(), expected.1);
    s.assert_custody();
}

#[test]
fn settlement_preview_query_matches_the_payout() {
    let mut s = Suite::new();
    let id = s.started(3);
    s.settle(id, REASON_BANK_BROKEN, 50, &[2018, 2448, 2409], &[]);
    let preview: eighteen_cosmos_escrow::msg::SettlementPreviewResponse = s
        .app
        .wrap()
        .query_wasm_smart(
            s.contract.clone(),
            &eighteen_cosmos_escrow::msg::QueryMsg::SettlementPreview { chain_game_id: id },
        )
        .unwrap();
    // SYN-01 preview.
    assert_eq!(
        preview.payouts.iter().map(|a| a.u128()).collect::<Vec<_>>(),
        vec![1_717_134, 2_083_025, 2_049_840]
    );
    assert_eq!(preview.dust.u128(), 1);
    s.advance(DAY);
    let who = s.outsider.clone();
    s.exec(&who, &ExecuteMsg::Finalize { chain_game_id: id }, &[])
        .unwrap();
    let o = s.game(id).game.outcome.unwrap();
    assert_eq!(o.amounts, preview.payouts);
    assert_eq!(o.dust, preview.dust);
}
