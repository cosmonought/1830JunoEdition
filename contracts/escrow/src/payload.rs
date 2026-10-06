//! `SettlementPayloadV1`: the one message the settlement signer signs.
//!
//! The layout is the AMENDED v1 layout frozen by ESCROW-1.5 §6.1 as amended by
//! SET-0A rev 2 §21 (A1/A2). Every field is fixed width, integers are big-endian,
//! and the roster length `n` is explicit, so the encoding is prefix-free and
//! injective:
//!
//! ```text
//! version 1 | domain 32 | seq 8 BE | kind 1 | reason 1 | log_len 8 BE | log_hash 32 |
//! appraisal_log_len 8 BE | appraisal_state_hash 32 | state_schema_version 2 BE | n 1 |
//! settlement_weights 16·n (u128 BE each) | signer_key_id 2 BE | issued_at 8 BE
//! ```
//!
//! Total: `136 + 16·n` bytes.
//!
//! The contract never hashes client-supplied bytes. A payload arrives as a
//! structured message (`crate::msg::SettlementPayloadV1`), is converted into the
//! fixed-width [`Payload`], and is re-encoded here; the signature is checked
//! against the digest of those re-encoded bytes.

use cosmwasm_std::{HexBinary, Uint128, Uint64};

use crate::error::ContractError;
use crate::msg::SettlementPayloadV1;

/// The only payload format this contract accepts.
pub const PAYLOAD_VERSION: u8 = 1;

/// `kind` byte: a signed round-boundary snapshot.
pub const KIND_CHECKPOINT: u8 = 0;
/// `kind` byte: a signed end-of-game settlement.
pub const KIND_TERMINAL: u8 = 1;

/// Frozen reason enum (ESCROW-1.5 §5.3). Values 6..=255 are reserved and refused.
pub const REASON_ROUND_BOUNDARY: u8 = 0;
pub const REASON_BANK_BROKEN: u8 = 1;
pub const REASON_BANKRUPTCY: u8 = 2;
pub const REASON_FORFEIT: u8 = 3;
pub const REASON_CLEMENCY: u8 = 4;
pub const REASON_RESOLVER_CORRECTION: u8 = 5;

/// Bytes of every field except the weights.
pub const FIXED_ENCODED_LEN: usize = 136;
/// Bytes per settlement weight (u128 big-endian).
pub const WEIGHT_ENCODED_LEN: usize = 16;

/// `136 + 16·n`, or `None` if it would not fit a `usize`.
pub fn encoded_len(seat_count: usize) -> Option<usize> {
    seat_count
        .checked_mul(WEIGHT_ENCODED_LEN)?
        .checked_add(FIXED_ENCODED_LEN)
}

/// The fixed-width, already length-checked form of a settlement payload.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Payload {
    pub version: u8,
    pub domain: [u8; 32],
    pub seq: u64,
    pub kind: u8,
    pub reason: u8,
    pub log_len: u64,
    pub log_hash: [u8; 32],
    pub appraisal_log_len: u64,
    pub appraisal_state_hash: [u8; 32],
    pub state_schema_version: u16,
    pub settlement_weights: Vec<u128>,
    pub signer_key_id: u16,
    pub issued_at: u64,
}

/// Which message a payload is being used by; each allows a different kind/reason.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PayloadUse {
    /// `Checkpoint`: kind 0, reason 0 (RoundBoundary).
    Checkpoint,
    /// `Settle`: kind 1, reason 1..=4 (ResolverCorrection is only for the resolver).
    Settle,
    /// `Resolve { Replace }`: kind 1, reason 5 (ResolverCorrection).
    ResolverReplace,
}

impl Payload {
    /// The explicit `n` byte. A payload can only carry up to 255 weights; the
    /// contract then requires `n` to equal the frozen roster length (2..=7).
    pub fn seat_count(&self) -> Result<u8, ContractError> {
        u8::try_from(self.settlement_weights.len()).map_err(|_| ContractError::MalformedPayload {
            reason: "more than 255 settlement weights".to_string(),
        })
    }

    /// The canonical `136 + 16·n` byte encoding.
    pub fn encode(&self) -> Result<Vec<u8>, ContractError> {
        let n = self.seat_count()?;
        let len = encoded_len(self.settlement_weights.len()).ok_or(ContractError::Overflow {})?;
        let mut out = Vec::with_capacity(len);
        out.push(self.version);
        out.extend_from_slice(&self.domain);
        out.extend_from_slice(&self.seq.to_be_bytes());
        out.push(self.kind);
        out.push(self.reason);
        out.extend_from_slice(&self.log_len.to_be_bytes());
        out.extend_from_slice(&self.log_hash);
        out.extend_from_slice(&self.appraisal_log_len.to_be_bytes());
        out.extend_from_slice(&self.appraisal_state_hash);
        out.extend_from_slice(&self.state_schema_version.to_be_bytes());
        out.push(n);
        for weight in &self.settlement_weights {
            out.extend_from_slice(&weight.to_be_bytes());
        }
        out.extend_from_slice(&self.signer_key_id.to_be_bytes());
        out.extend_from_slice(&self.issued_at.to_be_bytes());
        if out.len() != len {
            return Err(ContractError::Invariant {
                reason: "encoded payload length".to_string(),
            });
        }
        Ok(out)
    }

    /// Strict inverse of [`Payload::encode`]: exactly `136 + 16·n` bytes and
    /// version 1, nothing more and nothing less. The contract does not need this
    /// at runtime (it re-encodes structured payloads); it exists so tests and
    /// off-chain Rust tooling can prove the encoding is injective.
    pub fn decode(bytes: &[u8]) -> Result<Payload, ContractError> {
        let mut r = Reader { bytes, pos: 0 };
        let version = r.u8()?;
        if version != PAYLOAD_VERSION {
            return Err(ContractError::BadVersion { got: version });
        }
        let domain = r.array32()?;
        let seq = r.u64()?;
        let kind = r.u8()?;
        let reason = r.u8()?;
        let log_len = r.u64()?;
        let log_hash = r.array32()?;
        let appraisal_log_len = r.u64()?;
        let appraisal_state_hash = r.array32()?;
        let state_schema_version = r.u16()?;
        let n = r.u8()?;
        let expected = encoded_len(usize::from(n)).ok_or(ContractError::Overflow {})?;
        if bytes.len() != expected {
            return Err(ContractError::MalformedPayload {
                reason: format!(
                    "{} bytes for n = {}, expected exactly {}",
                    bytes.len(),
                    n,
                    expected
                ),
            });
        }
        let mut settlement_weights = Vec::with_capacity(usize::from(n));
        for _ in 0..n {
            settlement_weights.push(r.u128()?);
        }
        let signer_key_id = r.u16()?;
        let issued_at = r.u64()?;
        if r.pos != bytes.len() {
            return Err(ContractError::MalformedPayload {
                reason: "trailing bytes".to_string(),
            });
        }
        Ok(Payload {
            version,
            domain,
            seq,
            kind,
            reason,
            log_len,
            log_hash,
            appraisal_log_len,
            appraisal_state_hash,
            state_schema_version,
            settlement_weights,
            signer_key_id,
            issued_at,
        })
    }

    /// Game-independent structural rules: version, the frozen kind/reason
    /// enums and their coupling, the message's allowed kind/reason, the
    /// `seq = 2·log_len + kind_bit` derivation and the A1 appraisal rule.
    pub fn check_shape(&self, usage: PayloadUse) -> Result<(), ContractError> {
        if self.version != PAYLOAD_VERSION {
            return Err(ContractError::BadVersion { got: self.version });
        }
        if self.kind != KIND_CHECKPOINT && self.kind != KIND_TERMINAL {
            return Err(ContractError::BadKind { got: self.kind });
        }
        if self.reason > REASON_RESOLVER_CORRECTION {
            return Err(ContractError::UnknownReason { got: self.reason });
        }
        // ESCROW-1.5 §5.4: a Checkpoint with reason != 0 or a Terminal with
        // reason == 0 is refused.
        let coupled = if self.kind == KIND_CHECKPOINT {
            self.reason == REASON_ROUND_BOUNDARY
        } else {
            self.reason != REASON_ROUND_BOUNDARY
        };
        if !coupled {
            return Err(ContractError::ReasonNotAllowed {
                reason: self.reason,
            });
        }
        match usage {
            PayloadUse::Checkpoint => {
                if self.kind != KIND_CHECKPOINT {
                    return Err(ContractError::WrongKind {
                        expected: "checkpoint".to_string(),
                    });
                }
            }
            PayloadUse::Settle => {
                if self.kind != KIND_TERMINAL {
                    return Err(ContractError::WrongKind {
                        expected: "terminal".to_string(),
                    });
                }
                // §9.1 Settle: reason ∈ 1..4. ResolverCorrection is resolver-only.
                if !(REASON_BANK_BROKEN..=REASON_CLEMENCY).contains(&self.reason) {
                    return Err(ContractError::ReasonNotAllowed {
                        reason: self.reason,
                    });
                }
            }
            PayloadUse::ResolverReplace => {
                if self.kind != KIND_TERMINAL {
                    return Err(ContractError::WrongKind {
                        expected: "terminal".to_string(),
                    });
                }
                if self.reason != REASON_RESOLVER_CORRECTION {
                    return Err(ContractError::ReasonNotAllowed {
                        reason: self.reason,
                    });
                }
            }
        }
        // §5.2: seq = 2·log_len + kind_bit (Checkpoint 0, Terminal 1).
        let expected_seq = self
            .log_len
            .checked_mul(2)
            .and_then(|doubled| doubled.checked_add(u64::from(self.kind)));
        if expected_seq != Some(self.seq) {
            return Err(ContractError::BadSeq { seq: self.seq });
        }
        // A1: appraisal_log_len ≤ log_len on every payload, with equality for
        // Checkpoint and for reasons 1 (BankBroken), 2 (Bankruptcy) and
        // 5 (ResolverCorrection). Forfeit (3) and Clemency (4) may appraise an
        // earlier round-boundary board.
        let must_equal = self.kind == KIND_CHECKPOINT
            || matches!(
                self.reason,
                REASON_BANK_BROKEN | REASON_BANKRUPTCY | REASON_RESOLVER_CORRECTION
            );
        let ok = if must_equal {
            self.appraisal_log_len == self.log_len
        } else {
            self.appraisal_log_len <= self.log_len
        };
        if !ok {
            return Err(ContractError::BadAppraisalLogLen {
                appraisal_log_len: self.appraisal_log_len,
                log_len: self.log_len,
            });
        }
        Ok(())
    }
}

/// Copies a hex field into a fixed-size array, refusing any other length.
pub fn fixed_bytes<const N: usize>(
    field: &str,
    value: &HexBinary,
) -> Result<[u8; N], ContractError> {
    let slice = value.as_slice();
    <[u8; N]>::try_from(slice).map_err(|_| ContractError::BadLength {
        field: field.to_string(),
        expected: N,
        got: slice.len(),
    })
}

impl TryFrom<&SettlementPayloadV1> for Payload {
    type Error = ContractError;

    fn try_from(wire: &SettlementPayloadV1) -> Result<Self, Self::Error> {
        if usize::from(wire.seat_count) != wire.settlement_weights.len() {
            return Err(ContractError::SeatCountMismatch {
                seat_count: wire.seat_count,
                weights: wire.settlement_weights.len(),
            });
        }
        Ok(Payload {
            version: wire.version,
            domain: fixed_bytes::<32>("payload.domain", &wire.domain)?,
            seq: wire.seq.u64(),
            kind: wire.kind,
            reason: wire.reason,
            log_len: wire.log_len.u64(),
            log_hash: fixed_bytes::<32>("payload.log_hash", &wire.log_hash)?,
            appraisal_log_len: wire.appraisal_log_len.u64(),
            appraisal_state_hash: fixed_bytes::<32>(
                "payload.appraisal_state_hash",
                &wire.appraisal_state_hash,
            )?,
            state_schema_version: wire.state_schema_version,
            settlement_weights: wire.settlement_weights.iter().map(|w| w.u128()).collect(),
            signer_key_id: wire.signer_key_id,
            issued_at: wire.issued_at.u64(),
        })
    }
}

impl TryFrom<&Payload> for SettlementPayloadV1 {
    type Error = ContractError;

    fn try_from(p: &Payload) -> Result<Self, Self::Error> {
        Ok(SettlementPayloadV1 {
            version: p.version,
            domain: HexBinary::from(p.domain.as_slice()),
            seq: Uint64::new(p.seq),
            kind: p.kind,
            reason: p.reason,
            log_len: Uint64::new(p.log_len),
            log_hash: HexBinary::from(p.log_hash.as_slice()),
            appraisal_log_len: Uint64::new(p.appraisal_log_len),
            appraisal_state_hash: HexBinary::from(p.appraisal_state_hash.as_slice()),
            state_schema_version: p.state_schema_version,
            seat_count: p.seat_count()?,
            settlement_weights: p
                .settlement_weights
                .iter()
                .map(|w| Uint128::new(*w))
                .collect(),
            signer_key_id: p.signer_key_id,
            issued_at: Uint64::new(p.issued_at),
        })
    }
}

/// Bounds-checked big-endian reader for [`Payload::decode`].
pub(crate) struct Reader<'a> {
    pub(crate) bytes: &'a [u8],
    pub(crate) pos: usize,
}

impl<'a> Reader<'a> {
    fn take(&mut self, len: usize) -> Result<&'a [u8], ContractError> {
        let end = self
            .pos
            .checked_add(len)
            .ok_or(ContractError::Overflow {})?;
        let out = self
            .bytes
            .get(self.pos..end)
            .ok_or_else(|| ContractError::MalformedPayload {
                reason: "truncated".to_string(),
            })?;
        self.pos = end;
        Ok(out)
    }

    pub(crate) fn u8(&mut self) -> Result<u8, ContractError> {
        Ok(self.take(1)?[0])
    }

    pub(crate) fn u16(&mut self) -> Result<u16, ContractError> {
        let mut buf = [0u8; 2];
        buf.copy_from_slice(self.take(2)?);
        Ok(u16::from_be_bytes(buf))
    }

    pub(crate) fn u64(&mut self) -> Result<u64, ContractError> {
        let mut buf = [0u8; 8];
        buf.copy_from_slice(self.take(8)?);
        Ok(u64::from_be_bytes(buf))
    }

    pub(crate) fn u128(&mut self) -> Result<u128, ContractError> {
        let mut buf = [0u8; 16];
        buf.copy_from_slice(self.take(16)?);
        Ok(u128::from_be_bytes(buf))
    }

    pub(crate) fn array32(&mut self) -> Result<[u8; 32], ContractError> {
        let mut buf = [0u8; 32];
        buf.copy_from_slice(self.take(32)?);
        Ok(buf)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(n: usize, kind: u8, reason: u8) -> Payload {
        let log_len = 41u64;
        Payload {
            version: 1,
            domain: [0x11; 32],
            seq: 2 * log_len + u64::from(kind),
            kind,
            reason,
            log_len,
            log_hash: [0x22; 32],
            appraisal_log_len: log_len,
            appraisal_state_hash: [0x33; 32],
            state_schema_version: 1,
            settlement_weights: (0..n).map(|i| 1000 + i as u128).collect(),
            signer_key_id: 1,
            issued_at: 1_758_000_000,
        }
    }

    #[test]
    fn encoded_length_is_136_plus_16n() {
        for n in 0..=7usize {
            let p = sample(n, KIND_CHECKPOINT, 0);
            assert_eq!(p.encode().unwrap().len(), 136 + 16 * n);
            assert_eq!(encoded_len(n), Some(136 + 16 * n));
        }
    }

    #[test]
    fn decode_is_the_exact_inverse() {
        for n in 2..=7usize {
            let p = sample(n, KIND_TERMINAL, REASON_BANK_BROKEN);
            let bytes = p.encode().unwrap();
            assert_eq!(Payload::decode(&bytes).unwrap(), p);
        }
    }

    #[test]
    fn decode_refuses_truncation_and_trailing_bytes() {
        let bytes = sample(3, KIND_TERMINAL, REASON_BANK_BROKEN)
            .encode()
            .unwrap();
        for cut in 0..bytes.len() {
            assert!(
                Payload::decode(&bytes[..cut]).is_err(),
                "truncated at {cut}"
            );
        }
        let mut longer = bytes.clone();
        longer.push(0);
        assert!(Payload::decode(&longer).is_err());
    }

    #[test]
    fn decode_refuses_a_seat_count_that_disagrees_with_the_length() {
        let mut bytes = sample(3, KIND_TERMINAL, REASON_BANK_BROKEN)
            .encode()
            .unwrap();
        // n lives at offset 125 (1+32+8+1+1+8+32+8+32+2).
        assert_eq!(bytes[125], 3);
        bytes[125] = 2;
        assert!(Payload::decode(&bytes).is_err());
        bytes[125] = 4;
        assert!(Payload::decode(&bytes).is_err());
    }

    #[test]
    fn seq_rule_and_kind_reason_coupling() {
        let mut p = sample(2, KIND_CHECKPOINT, 0);
        assert!(p.check_shape(PayloadUse::Checkpoint).is_ok());
        p.seq += 1;
        assert_eq!(
            p.check_shape(PayloadUse::Checkpoint),
            Err(ContractError::BadSeq { seq: 83 })
        );
        let mut t = sample(2, KIND_TERMINAL, REASON_BANKRUPTCY);
        assert!(t.check_shape(PayloadUse::Settle).is_ok());
        t.seq -= 1;
        assert!(matches!(
            t.check_shape(PayloadUse::Settle),
            Err(ContractError::BadSeq { .. })
        ));
        // Checkpoint with reason != 0, Terminal with reason 0.
        let c = sample(2, KIND_CHECKPOINT, REASON_BANK_BROKEN);
        assert!(matches!(
            c.check_shape(PayloadUse::Checkpoint),
            Err(ContractError::ReasonNotAllowed { reason: 1 })
        ));
        let t0 = sample(2, KIND_TERMINAL, 0);
        assert!(matches!(
            t0.check_shape(PayloadUse::Settle),
            Err(ContractError::ReasonNotAllowed { reason: 0 })
        ));
    }

    #[test]
    fn every_reserved_reason_and_unknown_kind_is_refused() {
        for reason in 6..=255u8 {
            let p = sample(2, KIND_TERMINAL, reason);
            assert_eq!(
                p.check_shape(PayloadUse::Settle),
                Err(ContractError::UnknownReason { got: reason })
            );
        }
        for kind in 2..=255u8 {
            let mut p = sample(2, KIND_TERMINAL, REASON_BANK_BROKEN);
            p.kind = kind;
            assert_eq!(
                p.check_shape(PayloadUse::Settle),
                Err(ContractError::BadKind { got: kind })
            );
        }
    }

    #[test]
    fn settle_and_replace_reason_sets_are_disjoint() {
        for reason in 1..=4u8 {
            let p = sample(2, KIND_TERMINAL, reason);
            assert!(p.check_shape(PayloadUse::Settle).is_ok());
            assert!(matches!(
                p.check_shape(PayloadUse::ResolverReplace),
                Err(ContractError::ReasonNotAllowed { .. })
            ));
        }
        let r = sample(2, KIND_TERMINAL, REASON_RESOLVER_CORRECTION);
        assert!(r.check_shape(PayloadUse::ResolverReplace).is_ok());
        assert!(matches!(
            r.check_shape(PayloadUse::Settle),
            Err(ContractError::ReasonNotAllowed { reason: 5 })
        ));
    }

    #[test]
    fn appraisal_rule_a1() {
        // Equality required: Checkpoint, BankBroken, Bankruptcy, ResolverCorrection.
        for (kind, reason, usage) in [
            (KIND_CHECKPOINT, 0, PayloadUse::Checkpoint),
            (KIND_TERMINAL, REASON_BANK_BROKEN, PayloadUse::Settle),
            (KIND_TERMINAL, REASON_BANKRUPTCY, PayloadUse::Settle),
            (
                KIND_TERMINAL,
                REASON_RESOLVER_CORRECTION,
                PayloadUse::ResolverReplace,
            ),
        ] {
            let mut p = sample(2, kind, reason);
            p.appraisal_log_len = p.log_len - 1;
            assert!(matches!(
                p.check_shape(usage),
                Err(ContractError::BadAppraisalLogLen { .. })
            ));
            p.appraisal_log_len = p.log_len + 1;
            assert!(matches!(
                p.check_shape(usage),
                Err(ContractError::BadAppraisalLogLen { .. })
            ));
        }
        // Forfeit / Clemency: ≤ allowed, > refused.
        for reason in [REASON_FORFEIT, REASON_CLEMENCY] {
            let mut p = sample(2, KIND_TERMINAL, reason);
            p.appraisal_log_len = 0;
            assert!(p.check_shape(PayloadUse::Settle).is_ok());
            p.appraisal_log_len = p.log_len;
            assert!(p.check_shape(PayloadUse::Settle).is_ok());
            p.appraisal_log_len = p.log_len + 1;
            assert!(matches!(
                p.check_shape(PayloadUse::Settle),
                Err(ContractError::BadAppraisalLogLen { .. })
            ));
        }
    }

    #[test]
    fn seq_overflow_is_refused_not_wrapped() {
        let mut p = sample(2, KIND_TERMINAL, REASON_BANK_BROKEN);
        p.log_len = u64::MAX / 2 + 1;
        p.appraisal_log_len = p.log_len;
        p.seq = p.log_len.wrapping_mul(2).wrapping_add(1);
        assert!(matches!(
            p.check_shape(PayloadUse::Settle),
            Err(ContractError::BadSeq { .. })
        ));
    }
}
