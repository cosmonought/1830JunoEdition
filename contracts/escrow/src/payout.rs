//! Money arithmetic: the deposit split, the challenge bond and the proportional
//! payout. Every ratio is computed in a 256-bit checked intermediate.
//!
//! PAYOUT (SET-0A rev 2 A2): `payout_i = floor(pool · w_i / Σw)`, dust = pool −
//! Σ payout_i, dust → treasury. `settlement_weights` are unsigned u128 with no
//! product-level cap below u128, so neither `Σw` nor `pool · w_i` is required to
//! fit a `Uint128`:
//!
//! * `Σw` is summed in `Uint256` (≤ 255 · (2¹²⁸ − 1) < 2¹³⁶);
//! * `pool · w_i` is multiplied in `Uint256` (< 2²⁵⁶);
//! * the quotient is ≤ `pool` because `w_i ≤ Σw`, so the checked downcast to
//!   `Uint128` cannot fail;
//! * `Σ ⌊pool·w_i/Σw⌋ ≤ ⌊pool·Σw/Σw⌋ = pool`, so `dust = pool − Σ payout_i ≥ 0`.
//!
//! `Uint128::multiply_ratio` is deliberately not used: its denominator is a
//! `u128`, which cannot hold `Σw` (golden vectors P11 and P13).

use cosmwasm_std::{Uint128, Uint256};

use crate::error::ContractError;

/// Basis-point denominator.
pub const BPS_DENOMINATOR: u128 = 10_000;

/// The result of a proportional split.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Split {
    /// One amount per seat, in `chain_seat_index` order.
    pub amounts: Vec<Uint128>,
    /// `pool − Σ amounts`, sent to the treasury.
    pub dust: Uint128,
}

/// `payout_i = floor(pool · w_i / Σw)` with a `Uint256` intermediate.
pub fn proportional_split(pool: Uint128, weights: &[Uint128]) -> Result<Split, ContractError> {
    let mut sum = Uint256::zero();
    for weight in weights {
        sum = sum.checked_add(Uint256::from(*weight))?;
    }
    if sum.is_zero() {
        return Err(ContractError::ZeroSumWeights {});
    }
    let pool_wide = Uint256::from(pool);
    let mut paid = Uint128::zero();
    let mut amounts = Vec::with_capacity(weights.len());
    for weight in weights {
        let quotient = pool_wide
            .checked_mul(Uint256::from(*weight))?
            .checked_div(sum)?;
        let amount = Uint128::try_from(quotient)?;
        paid = paid.checked_add(amount)?;
        amounts.push(amount);
    }
    let dust = pool.checked_sub(paid)?;
    Ok(Split { amounts, dust })
}

/// `true` iff the weights sum to more than zero (checked in `Uint256`).
pub fn weights_have_positive_sum(weights: &[Uint128]) -> Result<bool, ContractError> {
    let mut sum = Uint256::zero();
    for weight in weights {
        sum = sum.checked_add(Uint256::from(*weight))?;
    }
    Ok(!sum.is_zero())
}

/// `floor(amount · bps / 10_000)` with a `Uint256` intermediate.
fn bps_of(amount: Uint128, bps: u16) -> Result<Uint128, ContractError> {
    let wide = Uint256::from(amount)
        .checked_mul(Uint256::from(u128::from(bps)))?
        .checked_div(Uint256::from(BPS_DENOMINATOR))?;
    Ok(Uint128::try_from(wide)?)
}

/// The gas-subsidy cut of one deposit: `floor(gross · subsidy_bps / 10_000)`,
/// the same formula as the legacy `escrow::subsidy_cut` and the frontend
/// `anteMath.anteBreakdown`. Requires `subsidy_bps ≤ 10_000`.
pub fn subsidy_cut(gross: Uint128, subsidy_bps: u16) -> Result<Uint128, ContractError> {
    if u128::from(subsidy_bps) > BPS_DENOMINATOR {
        return Err(ContractError::InvalidParams {
            reason: "subsidy_bps above 10000".to_string(),
        });
    }
    bps_of(gross, subsidy_bps)
}

/// Challenge bond frozen at `Start` (ESCROW-1.5 §8.2):
/// `max(bond_floor, floor(ante_net · bond_bps / 10_000))`.
pub fn bond_amount(
    ante_net: Uint128,
    bond_bps: u16,
    bond_floor: Uint128,
) -> Result<Uint128, ContractError> {
    let proportional = bps_of(ante_net, bond_bps)?;
    Ok(if proportional > bond_floor {
        proportional
    } else {
        bond_floor
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn u(v: u128) -> Uint128 {
        Uint128::new(v)
    }

    #[test]
    fn simple_split_and_dust() {
        let s = proportional_split(u(5_850_000), &[u(1301), u(977), u(3)]).unwrap();
        assert_eq!(s.amounts, vec![u(3_336_628), u(2_505_677), u(7_693)]);
        assert_eq!(s.dust, u(2));
    }

    #[test]
    fn zero_sum_is_refused() {
        assert_eq!(
            proportional_split(u(3_900_000), &[u(0), u(0)]),
            Err(ContractError::ZeroSumWeights {})
        );
        assert_eq!(
            proportional_split(u(1), &[]),
            Err(ContractError::ZeroSumWeights {})
        );
    }

    #[test]
    fn wide_intermediates_never_overflow() {
        // Sum and product both exceed u128; every payout still fits.
        let max = u(u128::MAX);
        let s = proportional_split(max, &[max, max, max, max, max, max, max]).unwrap();
        let total: u128 = s.amounts.iter().map(|a| a.u128()).sum::<u128>() + s.dust.u128();
        assert_eq!(total, u128::MAX);
        for a in &s.amounts {
            assert!(*a <= max);
        }
    }

    #[test]
    fn subsidy_matches_legacy_and_frontend() {
        // 2 JUNO gross at 250 bps -> 50_000 subsidy, 1_950_000 net (golden vectors).
        assert_eq!(subsidy_cut(u(2_000_000), 250).unwrap(), u(50_000));
        assert_eq!(subsidy_cut(u(1), 250).unwrap(), u(0));
        assert_eq!(subsidy_cut(u(39), 250).unwrap(), u(0));
        assert_eq!(subsidy_cut(u(40), 250).unwrap(), u(1));
        assert_eq!(subsidy_cut(u(u128::MAX), 10_000).unwrap(), u(u128::MAX));
        assert!(subsidy_cut(u(1), 10_001).is_err());
    }

    #[test]
    fn bond_is_max_of_floor_and_bps() {
        // Launch defaults: 50 % of net ante, floor 1 JUNO.
        assert_eq!(
            bond_amount(u(1_950_000), 5_000, u(1_000_000)).unwrap(),
            u(1_000_000)
        );
        assert_eq!(
            bond_amount(u(3_900_000), 5_000, u(1_000_000)).unwrap(),
            u(1_950_000)
        );
        assert_eq!(bond_amount(u(0), 5_000, u(0)).unwrap(), u(0));
        // bps above 10_000 cannot overflow the intermediate; an unrepresentable result is refused.
        assert!(bond_amount(u(u128::MAX), u16::MAX, u(0)).is_err());
    }
}
