//! `RemedyAttestationV1`: the one message a REMEDY key signs (escrow 2.1.0,
//! owner decision R1, 2026-10-06).
//!
//! Fixed width, big-endian, no length prefixes, version first:
//!
//! ```text
//! version 1 | domain 32 | chain_game_id 8 | remedy 1 | defaulting_seat 1 | strike 1 |
//! overdue_epoch 8 | log_len 8 | log_hash 32 | allowance_secs 8 | overdue_at 8 |
//! final_at 8 | attested_at 8 | expires_at 8 | evidence_hash 32 | remedy_key_id 2
//! ```
//!
//! Total: 166 bytes. `digest = SHA-256("18JUNO/REMEDY/v1" ‖ encoding)`
//! (`crypto::remedy_digest`). As with settlement payloads, the contract never
//! hashes client bytes: the structured message is converted to
//! [`RemedyAttestation`] and re-encoded here.
//!
//! Field meaning (all times are Unix seconds, compared with block time):
//!
//! * `domain` — the game's settlement domain (chain id, contract, game,
//!   roster, rules version, variants, ante, mode), and `chain_game_id` again in
//!   clear, so an attestation names exactly one game of one contract.
//! * `remedy` — [`crate::state::RemedyKind`] byte (1..=5).
//! * `defaulting_seat` — the OVERDUE seat's `chain_seat_index`.
//! * `strike` — Live: the seat's ordinary overdue count in this game (1, 2 or
//!   3); Timed Async: 0.
//! * `overdue_epoch` — the server's identifier of this overdue instance
//!   (monotonic per game; a cure ends an epoch, and REMEDY-APPROVE signatures
//!   name it).
//! * `log_len` / `log_hash` — the exact authoritative log position the fact
//!   was resolved at; `2·log_len + 1` must exceed the game's trusted sequence,
//!   so a checkpoint beyond it (proof that play went on) makes it stale.
//! * `allowance_secs` — the action allowance the game was funded with.
//! * `overdue_at` — when the allowance expired (at least one allowance after
//!   the game's start); `final_at` — when the remedy became final (Live 1/2:
//!   at least `overdue_at + 600`, later by exactly the time a voluntary or
//!   system pause froze the cure window; Live 3: `overdue_at`; Async: when the
//!   N−1 consensus completed, `≥ overdue_at`).
//! * `attested_at` — when the REMEDY key signed (`≥ final_at`: a remedy is
//!   attested only once final; `≤` block time when it executes). A final fact
//!   that did not land (an admin pause, a relayer outage) is attested again
//!   with a fresh `attested_at`; nothing else of it changes.
//! * `expires_at` — the attestation is refused from this time on; after
//!   `attested_at` and at most [`crate::state::MAX_REMEDY_TTL_SECS`] after it,
//!   so no signed attestation is a bearer instrument for longer than that.
//! * `evidence_hash` — SHA-256 of the control-plane clock evidence (stored, not
//!   interpreted).
//! * `remedy_key_id` — the REMEDY key that signs.

use cosmwasm_std::{HexBinary, Uint64};

use crate::error::ContractError;
use crate::msg::RemedyAttestationV1;
use crate::payload::{fixed_bytes, Reader};

/// The only attestation format this contract accepts.
pub const REMEDY_VERSION: u8 = 1;
/// The encoding's exact length.
pub const REMEDY_ENCODED_LEN: usize = 166;

/// The fixed-width, already length-checked form of a remedy attestation.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RemedyAttestation {
    pub version: u8,
    pub domain: [u8; 32],
    pub chain_game_id: u64,
    pub remedy: u8,
    pub defaulting_seat: u8,
    pub strike: u8,
    pub overdue_epoch: u64,
    pub log_len: u64,
    pub log_hash: [u8; 32],
    pub allowance_secs: u64,
    pub overdue_at: u64,
    pub final_at: u64,
    pub attested_at: u64,
    pub expires_at: u64,
    pub evidence_hash: [u8; 32],
    pub remedy_key_id: u16,
}

impl RemedyAttestation {
    /// The canonical 166-byte encoding.
    pub fn encode(&self) -> Result<Vec<u8>, ContractError> {
        let mut out = Vec::with_capacity(REMEDY_ENCODED_LEN);
        out.push(self.version);
        out.extend_from_slice(&self.domain);
        out.extend_from_slice(&self.chain_game_id.to_be_bytes());
        out.push(self.remedy);
        out.push(self.defaulting_seat);
        out.push(self.strike);
        out.extend_from_slice(&self.overdue_epoch.to_be_bytes());
        out.extend_from_slice(&self.log_len.to_be_bytes());
        out.extend_from_slice(&self.log_hash);
        out.extend_from_slice(&self.allowance_secs.to_be_bytes());
        out.extend_from_slice(&self.overdue_at.to_be_bytes());
        out.extend_from_slice(&self.final_at.to_be_bytes());
        out.extend_from_slice(&self.attested_at.to_be_bytes());
        out.extend_from_slice(&self.expires_at.to_be_bytes());
        out.extend_from_slice(&self.evidence_hash);
        out.extend_from_slice(&self.remedy_key_id.to_be_bytes());
        if out.len() != REMEDY_ENCODED_LEN {
            return Err(ContractError::Invariant {
                reason: "encoded remedy attestation length".to_string(),
            });
        }
        Ok(out)
    }

    /// Strict inverse of [`RemedyAttestation::encode`]: exactly 166 bytes and
    /// version 1. Not used at runtime; tests and off-chain tooling use it to
    /// prove the encoding is injective.
    pub fn decode(bytes: &[u8]) -> Result<RemedyAttestation, ContractError> {
        if bytes.len() != REMEDY_ENCODED_LEN {
            return Err(ContractError::MalformedRemedy {
                reason: format!(
                    "{} bytes, expected exactly {REMEDY_ENCODED_LEN}",
                    bytes.len()
                ),
            });
        }
        let mut r = Reader { bytes, pos: 0 };
        let version = r.u8()?;
        if version != REMEDY_VERSION {
            return Err(ContractError::BadVersion { got: version });
        }
        let out = RemedyAttestation {
            version,
            domain: r.array32()?,
            chain_game_id: r.u64()?,
            remedy: r.u8()?,
            defaulting_seat: r.u8()?,
            strike: r.u8()?,
            overdue_epoch: r.u64()?,
            log_len: r.u64()?,
            log_hash: r.array32()?,
            allowance_secs: r.u64()?,
            overdue_at: r.u64()?,
            final_at: r.u64()?,
            attested_at: r.u64()?,
            expires_at: r.u64()?,
            evidence_hash: r.array32()?,
            remedy_key_id: r.u16()?,
        };
        if r.pos != bytes.len() {
            return Err(ContractError::MalformedRemedy {
                reason: "trailing bytes".to_string(),
            });
        }
        Ok(out)
    }

    /// `2·log_len + 1`: the attestation's position on the settlement sequence
    /// (that of a Terminal payload at the same log length).
    pub fn seq(&self) -> Result<u64, ContractError> {
        self.log_len
            .checked_mul(2)
            .and_then(|v| v.checked_add(1))
            .ok_or(ContractError::Overflow {})
    }
}

impl TryFrom<&RemedyAttestationV1> for RemedyAttestation {
    type Error = ContractError;

    fn try_from(wire: &RemedyAttestationV1) -> Result<Self, Self::Error> {
        Ok(RemedyAttestation {
            version: wire.version,
            domain: fixed_bytes::<32>("attestation.domain", &wire.domain)?,
            chain_game_id: wire.chain_game_id.u64(),
            remedy: wire.remedy,
            defaulting_seat: wire.defaulting_seat,
            strike: wire.strike,
            overdue_epoch: wire.overdue_epoch.u64(),
            log_len: wire.log_len.u64(),
            log_hash: fixed_bytes::<32>("attestation.log_hash", &wire.log_hash)?,
            allowance_secs: wire.allowance_secs.u64(),
            overdue_at: wire.overdue_at.u64(),
            final_at: wire.final_at.u64(),
            attested_at: wire.attested_at.u64(),
            expires_at: wire.expires_at.u64(),
            evidence_hash: fixed_bytes::<32>("attestation.evidence_hash", &wire.evidence_hash)?,
            remedy_key_id: wire.remedy_key_id,
        })
    }
}

impl From<&RemedyAttestation> for RemedyAttestationV1 {
    fn from(a: &RemedyAttestation) -> Self {
        RemedyAttestationV1 {
            version: a.version,
            domain: HexBinary::from(a.domain.as_slice()),
            chain_game_id: Uint64::new(a.chain_game_id),
            remedy: a.remedy,
            defaulting_seat: a.defaulting_seat,
            strike: a.strike,
            overdue_epoch: Uint64::new(a.overdue_epoch),
            log_len: Uint64::new(a.log_len),
            log_hash: HexBinary::from(a.log_hash.as_slice()),
            allowance_secs: Uint64::new(a.allowance_secs),
            overdue_at: Uint64::new(a.overdue_at),
            final_at: Uint64::new(a.final_at),
            attested_at: Uint64::new(a.attested_at),
            expires_at: Uint64::new(a.expires_at),
            evidence_hash: HexBinary::from(a.evidence_hash.as_slice()),
            remedy_key_id: a.remedy_key_id,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> RemedyAttestation {
        RemedyAttestation {
            version: 1,
            domain: [0x11; 32],
            chain_game_id: 7,
            remedy: 2,
            defaulting_seat: 1,
            strike: 2,
            overdue_epoch: 9,
            log_len: 41,
            log_hash: [0x22; 32],
            allowance_secs: 1200,
            overdue_at: 1_790_000_000,
            final_at: 1_790_000_600,
            attested_at: 1_790_000_660,
            expires_at: 1_790_003_600,
            evidence_hash: [0x33; 32],
            remedy_key_id: 3,
        }
    }

    #[test]
    fn round_trips_and_has_the_frozen_length() {
        let a = sample();
        let bytes = a.encode().unwrap();
        assert_eq!(bytes.len(), REMEDY_ENCODED_LEN);
        assert_eq!(RemedyAttestation::decode(&bytes).unwrap(), a);
        let wire = RemedyAttestationV1::from(&a);
        assert_eq!(RemedyAttestation::try_from(&wire).unwrap(), a);
    }

    #[test]
    fn decode_is_strict() {
        let bytes = sample().encode().unwrap();
        assert!(RemedyAttestation::decode(&bytes[..REMEDY_ENCODED_LEN - 1]).is_err());
        let mut long = bytes.clone();
        long.push(0);
        assert!(RemedyAttestation::decode(&long).is_err());
        let mut v2 = bytes;
        v2[0] = 2;
        assert_eq!(
            RemedyAttestation::decode(&v2).unwrap_err(),
            ContractError::BadVersion { got: 2 }
        );
    }

    #[test]
    fn every_byte_is_covered() {
        // Flipping any single byte changes the decoded attestation (or makes
        // it undecodable): no byte of the encoding is ignored.
        let a = sample();
        let bytes = a.encode().unwrap();
        for i in 0..bytes.len() {
            let mut b = bytes.clone();
            b[i] ^= 0x01;
            match RemedyAttestation::decode(&b) {
                Ok(other) => assert_ne!(other, a, "byte {i} ignored"),
                Err(_) => assert_eq!(i, 0, "only the version byte refuses"),
            }
        }
    }

    #[test]
    fn seq_is_terminal_position() {
        assert_eq!(sample().seq().unwrap(), 83);
        let mut a = sample();
        a.log_len = u64::MAX;
        assert!(a.seq().is_err());
    }
}
