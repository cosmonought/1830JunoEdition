//! 18Cosmos settlement escrow (ESCROW-2).
//!
//! A vault, deposit/ante holder, roster and wallet record, signature verifier,
//! settlement/challenge state machine and proportional payout calculator. It is
//! NOT a rules engine, a board store or a source of gameplay authority: the
//! TypeScript server is the only gameplay authority, and this contract only
//! consumes the server-signed `settlement_weights`.
//!
//! Specification: ESCROW-1.5 (`ESCROW_LIVE_RECONCILIATION_2026-09-25.md`, as
//! amended) and SET-0A rev 2 §20–§21.
#![cfg_attr(not(test), deny(clippy::arithmetic_side_effects))]

pub mod contract;
pub mod crypto;
pub mod error;
mod execute;
pub mod helpers;
pub mod msg;
pub mod payload;
pub mod payout;
pub mod query;
pub mod state;

pub use crate::error::ContractError;
