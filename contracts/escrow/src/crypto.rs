//! Domain separation, digests and signature checks (ESCROW-1.5 §6.2–§6.3).
//!
//! Every tag is ASCII with no terminator. Every integer is fixed width and
//! big-endian, as in the payload encoding (§6.1): `u16(len)`, `u64(game_id)`,
//! `u32(rules_engine_version)`, `u128(ante_gross)` and `u8(mode)` below are all
//! big-endian.
//!
//! ```text
//! roster_hash = SHA-256("18JUNO/ROSTER/v1" ‖ u8(n) ‖ for i in 0..n: u16(len) ‖ addr_i)
//! domain      = SHA-256("18JUNO/DOMAIN/v1" ‖ u16(len) ‖ chain_id ‖ u16(len) ‖ contract_addr
//!                       ‖ u64(chain_game_id) ‖ roster_hash ‖ u32(rules_engine_version)
//!                       ‖ variants_digest ‖ u128(ante_gross) ‖ u8(mode))
//! settle      = SHA-256("18JUNO/SETTLE/v1" ‖ encode(payload))         signed by the settlement key
//! consent     = SHA-256("18JUNO/CONSENT/v1" ‖ domain ‖ u64(seq) ‖ settle)   signed by a seat's consent key
//! annul       = SHA-256("18JUNO/ANNUL/v1" ‖ domain ‖ u64(seq))             signed by every seat's consent key
//! join        = SHA-256("18JUNO/JOIN/v1" ‖ u16(len) ‖ chain_id ‖ u16(len) ‖ contract_addr
//!                       ‖ u64(chain_game_id) ‖ u16(len) ‖ wallet ‖ join_ticket ‖ u64(expires_at))
//!                                                                        signed by the admission key
//! remedy      = SHA-256("18JUNO/REMEDY/v1" ‖ encode(attestation))      signed by a REMEDY key
//! approve     = SHA-256("18JUNO/REMEDY-APPROVE/v1" ‖ domain ‖ u64(chain_game_id) ‖ u8(remedy)
//!                       ‖ u8(defaulting_seat) ‖ u8(strike) ‖ u64(overdue_epoch) ‖ u64(log_len)
//!                       ‖ log_hash ‖ u64(overdue_at) ‖ u64(approve_until) ‖ u8(approving_seat))
//!                                                                  signed by a seat's consent key
//! ```
//!
//! REMEDY (escrow 2.1.0, owner decision R1, 2026-10-06): the dedicated remedy
//! attestation key's statement that an off-chain timing fact became FINAL:
//! which seat defaulted, on which strike and overdue epoch, at which exact log
//! position, when it became overdue and final, when it was attested and until
//! when the statement may be used, and the hash of the control-plane clock
//! evidence. The 166-byte encoding is in `remedy::RemedyAttestation::encode`.
//! REMEDY-APPROVE: one non-defaulting seat's approval of one remedy kind
//! against one defaulting seat for ONE overdue instance -- its strike, epoch,
//! the exact log position it stalled at and the moment it became overdue, each
//! of which must equal the attestation's -- and the approving seat's own
//! horizon (`approve_until`). It names neither the attestation's finality nor
//! its expiry, so a seat approves while the overdue is pending and the remedy
//! key decides finality. The approval is judged AT the attested `final_at`
//! (owner ruling, 2026-10-07): it counts only if `final_at` is strictly before
//! its horizon and it verifies under the consent key the seat held at
//! `final_at`; the block time it lands in is never consulted, so a sealed
//! decision (and its re-attestation, which keeps `final_at`) lands through any
//! later expiry or rotation. The signed bytes are those of REMEDY-APPROVE/v1,
//! unchanged. An approval of an overdue that was later cured is stopped on
//! chain by the checkpoint past the stall (the fence), and off chain by the
//! REMEDY key, which attests only a decision the clock sealed. Neither digest is ever signed by
//! a settlement signer key or the admission key; every tag differs, so no
//! signature made for one purpose verifies for another.
//!
//! JOIN (the join admission, 2026-09-28): the hosted server's authorization for
//! ONE wallet (the `Join` transaction's own sender, never a message field) to
//! take a seat in ONE game of THIS contract on THIS chain, carrying ONE join
//! ticket, until `expires_at` (Unix seconds, compared with block time). The
//! ticket is exactly 32 bytes, so it needs no length prefix. The admission key
//! is `Config::admission_pubkey`, never a settlement signer key.
//!
//! The ANNUL `seq` is the game's trusted sequence (`GameResponse::trusted_seq`,
//! ESCROW-2.1 OD-ESC2-3): equal to `last_seq` unless a signer key was marked
//! compromised. The byte layout is unchanged.
//!
//! Signatures are secp256k1, 64-byte `r ‖ s`, low-s normalised, over the 32-byte
//! digest; public keys are 33-byte compressed SEC1. `Api::secp256k1_verify`
//! (cosmwasm-crypto 1.5) normalises high-s signatures before verifying, i.e. it
//! ACCEPTS them, so the low-s rule is enforced here explicitly.

use cosmwasm_std::Api;
use sha2::{Digest, Sha256};

use crate::error::ContractError;

pub const TAG_DOMAIN: &[u8] = b"18JUNO/DOMAIN/v1";
pub const TAG_ROSTER: &[u8] = b"18JUNO/ROSTER/v1";
pub const TAG_SETTLE: &[u8] = b"18JUNO/SETTLE/v1";
pub const TAG_CONSENT: &[u8] = b"18JUNO/CONSENT/v1";
pub const TAG_ANNUL: &[u8] = b"18JUNO/ANNUL/v1";
/// The join admission (see the module comment).
pub const TAG_JOIN: &[u8] = b"18JUNO/JOIN/v1";
/// The remedy attestation (see the module comment).
pub const TAG_REMEDY: &[u8] = b"18JUNO/REMEDY/v1";
/// A non-defaulting seat's approval of a remedy (see the module comment).
pub const TAG_REMEDY_APPROVE: &[u8] = b"18JUNO/REMEDY-APPROVE/v1";
/// `evidence_hash = SHA-256(tag ‖ exported log bytes)`. Computed off-chain; the
/// contract stores the 32 bytes a challenger supplies and never interprets them.
pub const TAG_EVIDENCE: &[u8] = b"18JUNO/EVIDENCE/v1";

/// Compressed SEC1 public key length.
pub const COMPRESSED_PUBKEY_LEN: usize = 33;
/// `r ‖ s` signature length.
pub const SIGNATURE_LEN: usize = 64;

/// ⌊n/2⌋ for the secp256k1 group order
/// n = FFFFFFFF FFFFFFFF FFFFFFFF FFFFFFFE BAAEDCE6 AF48A03B BFD25E8C D0364141.
/// A signature is low-s iff `s ≤ SECP256K1_HALF_ORDER`.
pub const SECP256K1_HALF_ORDER: [u8; 32] = [
    0x7f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0x5d, 0x57, 0x6e, 0x73, 0x57, 0xa4, 0x50, 0x1d, 0xdf, 0xe9, 0x2f, 0x46, 0x68, 0x1b, 0x20, 0xa0,
];

/// Inputs of the settlement domain, frozen at `Start`.
#[derive(Clone, Debug)]
pub struct DomainInputs<'a> {
    /// The exact chain id the node reports (`env.block.chain_id`), e.g. `juno-1`.
    pub chain_id: &'a str,
    /// This contract's bech32 address (`env.contract.address`).
    pub contract_addr: &'a str,
    pub chain_game_id: u64,
    pub roster_hash: [u8; 32],
    pub rules_engine_version: u32,
    pub variants_digest: [u8; 32],
    pub ante_gross: u128,
    /// 0 = live, 1 = async.
    pub mode: u8,
}

fn u16_len(field: &str, bytes: &[u8]) -> Result<[u8; 2], ContractError> {
    u16::try_from(bytes.len())
        .map(u16::to_be_bytes)
        .map_err(|_| ContractError::InvalidParams {
            reason: format!("{field} is longer than 65535 bytes"),
        })
}

/// `roster_hash` over the wallets in `chain_seat_index` order. Addresses only,
/// so rotating a consent key never changes it (or the domain).
pub fn roster_hash<S: AsRef<str>>(wallets: &[S]) -> Result<[u8; 32], ContractError> {
    let n = u8::try_from(wallets.len()).map_err(|_| ContractError::InvalidParams {
        reason: "roster longer than 255 seats".to_string(),
    })?;
    let mut hasher = Sha256::new();
    hasher.update(TAG_ROSTER);
    hasher.update([n]);
    for wallet in wallets {
        let bytes = wallet.as_ref().as_bytes();
        hasher.update(u16_len("roster address", bytes)?);
        hasher.update(bytes);
    }
    Ok(hasher.finalize().into())
}

/// The settlement domain every payload, consent and annul signature is bound to.
pub fn settlement_domain(d: &DomainInputs) -> Result<[u8; 32], ContractError> {
    let mut hasher = Sha256::new();
    hasher.update(TAG_DOMAIN);
    hasher.update(u16_len("chain_id", d.chain_id.as_bytes())?);
    hasher.update(d.chain_id.as_bytes());
    hasher.update(u16_len("contract address", d.contract_addr.as_bytes())?);
    hasher.update(d.contract_addr.as_bytes());
    hasher.update(d.chain_game_id.to_be_bytes());
    hasher.update(d.roster_hash);
    hasher.update(d.rules_engine_version.to_be_bytes());
    hasher.update(d.variants_digest);
    hasher.update(d.ante_gross.to_be_bytes());
    hasher.update([d.mode]);
    Ok(hasher.finalize().into())
}

/// The digest the settlement signer signs: `SHA-256(SETTLE tag ‖ encode(payload))`.
pub fn settle_digest(encoded_payload: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(TAG_SETTLE);
    hasher.update(encoded_payload);
    hasher.finalize().into()
}

/// The digest a seat's consent key signs to consent to one specific payload.
pub fn consent_digest(domain: &[u8; 32], seq: u64, settle_digest: &[u8; 32]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(TAG_CONSENT);
    hasher.update(domain);
    hasher.update(seq.to_be_bytes());
    hasher.update(settle_digest);
    hasher.finalize().into()
}

/// The digest every seat's consent key signs to annul a game at its current
/// trusted sequence; a newer trusted checkpoint makes an older annul signature
/// useless.
pub fn annul_digest(domain: &[u8; 32], seq: u64) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(TAG_ANNUL);
    hasher.update(domain);
    hasher.update(seq.to_be_bytes());
    hasher.finalize().into()
}

/// The digest the admission key signs to let `wallet` join `chain_game_id` of
/// `contract_addr` on `chain_id` with `join_ticket` until `expires_at`.
pub fn join_admission_digest(
    chain_id: &str,
    contract_addr: &str,
    chain_game_id: u64,
    wallet: &str,
    join_ticket: &[u8; 32],
    expires_at: u64,
) -> Result<[u8; 32], ContractError> {
    let mut hasher = Sha256::new();
    hasher.update(TAG_JOIN);
    hasher.update(u16_len("chain_id", chain_id.as_bytes())?);
    hasher.update(chain_id.as_bytes());
    hasher.update(u16_len("contract address", contract_addr.as_bytes())?);
    hasher.update(contract_addr.as_bytes());
    hasher.update(chain_game_id.to_be_bytes());
    hasher.update(u16_len("wallet", wallet.as_bytes())?);
    hasher.update(wallet.as_bytes());
    hasher.update(join_ticket);
    hasher.update(expires_at.to_be_bytes());
    Ok(hasher.finalize().into())
}

/// The digest a REMEDY key signs: `SHA-256(REMEDY tag ‖ encode(attestation))`.
pub fn remedy_digest(encoded_attestation: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(TAG_REMEDY);
    hasher.update(encoded_attestation);
    hasher.finalize().into()
}

/// The digest seat `approving_seat`'s consent key signs to approve `remedy`
/// against `defaulting_seat` for ONE overdue instance of the game bound by
/// `domain` / `chain_game_id`: its `strike`, `overdue_epoch`, the exact log
/// position it stalled at (`log_len`, `log_hash` -- the log does not move while
/// a seat is overdue; a cure is what ends the instance) and the moment it
/// became overdue (`overdue_at`). Each of them must equal the attestation's,
/// so an approval given for one overdue never counts for another, whatever
/// the REMEDY key later attests (a cured overdue's approvals are dead once a
/// checkpoint past the stall lands), and `approve_until`: the seat's own bound
/// on the decision it approves -- the attested `final_at` must be strictly
/// before it. The attestation's finality and expiry are not bound: the
/// approval is judged at `final_at` under the key the seat held then, so it
/// survives later expiry, later key rotation and the re-attestation of the
/// same final decision.
#[allow(clippy::too_many_arguments)]
pub fn remedy_approve_digest(
    domain: &[u8; 32],
    chain_game_id: u64,
    remedy: u8,
    defaulting_seat: u8,
    strike: u8,
    overdue_epoch: u64,
    log_len: u64,
    log_hash: &[u8; 32],
    overdue_at: u64,
    approve_until: u64,
    approving_seat: u8,
) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(TAG_REMEDY_APPROVE);
    hasher.update(domain);
    hasher.update(chain_game_id.to_be_bytes());
    hasher.update([remedy, defaulting_seat, strike]);
    hasher.update(overdue_epoch.to_be_bytes());
    hasher.update(log_len.to_be_bytes());
    hasher.update(log_hash);
    hasher.update(overdue_at.to_be_bytes());
    hasher.update(approve_until.to_be_bytes());
    hasher.update([approving_seat]);
    hasher.finalize().into()
}

/// `true` iff the `s` half of `r ‖ s` is at most ⌊n/2⌋. Big-endian byte
/// comparison of equal-length arrays is numeric comparison.
pub fn is_low_s(signature: &[u8; SIGNATURE_LEN]) -> bool {
    signature[32..] <= SECP256K1_HALF_ORDER[..]
}

/// Accepts exactly a 33-byte compressed SEC1 key (prefix 0x02 or 0x03).
/// `Api::secp256k1_verify` would also take a 65-byte uncompressed key; the
/// frozen design only allows the compressed form.
pub fn parse_compressed_pubkey(
    field: &str,
    bytes: &[u8],
) -> Result<[u8; COMPRESSED_PUBKEY_LEN], ContractError> {
    let key =
        <[u8; COMPRESSED_PUBKEY_LEN]>::try_from(bytes).map_err(|_| ContractError::BadPubkey {
            field: field.to_string(),
        })?;
    if key[0] != 0x02 && key[0] != 0x03 {
        return Err(ContractError::BadPubkey {
            field: field.to_string(),
        });
    }
    Ok(key)
}

/// `true` iff the (format-valid) compressed key decodes to a point on the
/// curve. Uses the verifier itself: an off-curve key makes it return an error,
/// an on-curve key with an unrelated signature makes it return `Ok(false)`.
pub fn pubkey_on_curve(api: &dyn Api, key: &[u8; COMPRESSED_PUBKEY_LEN]) -> bool {
    let mut probe_sig = [0u8; SIGNATURE_LEN];
    probe_sig[31] = 1; // r = 1
    probe_sig[63] = 1; // s = 1 (low-s)
    api.secp256k1_verify(&[0x5a; 32], &probe_sig, key).is_ok()
}

/// Why a signature was refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SignatureFault {
    Length(usize),
    HighS,
    Invalid,
}

/// Verifies a 64-byte low-s secp256k1 signature over a 32-byte digest.
/// Verifier errors (malformed scalars, off-curve key) count as invalid.
pub fn check_signature(
    api: &dyn Api,
    digest: &[u8; 32],
    signature: &[u8],
    pubkey: &[u8],
) -> Result<(), SignatureFault> {
    let sig = <[u8; SIGNATURE_LEN]>::try_from(signature)
        .map_err(|_| SignatureFault::Length(signature.len()))?;
    if !is_low_s(&sig) {
        return Err(SignatureFault::HighS);
    }
    match api.secp256k1_verify(digest, &sig, pubkey) {
        Ok(true) => Ok(()),
        Ok(false) | Err(_) => Err(SignatureFault::Invalid),
    }
}

/// [`check_signature`] for the settlement signer (and the remedy key), with
/// specific errors.
pub fn verify_settlement_signature(
    api: &dyn Api,
    digest: &[u8; 32],
    signature: &[u8],
    pubkey: &[u8],
) -> Result<(), ContractError> {
    check_signature(api, digest, signature, pubkey).map_err(|fault| match fault {
        SignatureFault::Length(got) => ContractError::BadSignatureLength { got },
        SignatureFault::HighS => ContractError::HighS {},
        SignatureFault::Invalid => ContractError::InvalidSignature {},
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn half_order_is_floor_of_n_over_2() {
        // n = FFFF…FFFE BAAEDCE6 AF48A03B BFD25E8C D0364141, checked by long division.
        let n: [u8; 32] = [
            0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
            0xff, 0xfe, 0xba, 0xae, 0xdc, 0xe6, 0xaf, 0x48, 0xa0, 0x3b, 0xbf, 0xd2, 0x5e, 0x8c,
            0xd0, 0x36, 0x41, 0x41,
        ];
        let mut half = [0u8; 32];
        let mut carry = 0u16;
        for (i, byte) in n.iter().enumerate() {
            let cur = (carry << 8) | u16::from(*byte);
            half[i] = (cur / 2) as u8;
            carry = cur % 2;
        }
        assert_eq!(half, SECP256K1_HALF_ORDER);
    }

    #[test]
    fn low_s_boundary() {
        let mut sig = [0u8; 64];
        sig[32..].copy_from_slice(&SECP256K1_HALF_ORDER);
        assert!(is_low_s(&sig));
        sig[63] = sig[63].wrapping_add(1); // half + 1
        assert!(!is_low_s(&sig));
    }

    #[test]
    fn compressed_pubkey_format() {
        let mut key = [0x02u8; 33];
        assert!(parse_compressed_pubkey("k", &key).is_ok());
        key[0] = 0x03;
        assert!(parse_compressed_pubkey("k", &key).is_ok());
        key[0] = 0x04;
        assert!(parse_compressed_pubkey("k", &key).is_err());
        assert!(parse_compressed_pubkey("k", &[0x04u8; 65]).is_err());
        assert!(parse_compressed_pubkey("k", &[0x02u8; 32]).is_err());
    }

    #[test]
    fn join_admission_digest_binds_every_field() {
        let ticket = [7u8; 32];
        let base = join_admission_digest("juno-1", "juno1contract", 5, "juno1wallet", &ticket, 99)
            .unwrap();
        let mut other_ticket = ticket;
        other_ticket[31] ^= 1;
        for changed in [
            join_admission_digest("uni-7", "juno1contract", 5, "juno1wallet", &ticket, 99),
            join_admission_digest("juno-1", "juno1contracT", 5, "juno1wallet", &ticket, 99),
            join_admission_digest("juno-1", "juno1contract", 6, "juno1wallet", &ticket, 99),
            join_admission_digest("juno-1", "juno1contract", 5, "juno1wallez", &ticket, 99),
            join_admission_digest(
                "juno-1",
                "juno1contract",
                5,
                "juno1wallet",
                &other_ticket,
                99,
            ),
            join_admission_digest("juno-1", "juno1contract", 5, "juno1wallet", &ticket, 100),
        ] {
            assert_ne!(changed.unwrap(), base);
        }
        // Length prefixes: moving a byte between chain id and contract changes it.
        assert_ne!(
            join_admission_digest("juno-1j", "uno1contract", 5, "juno1wallet", &ticket, 99)
                .unwrap(),
            base
        );
    }

    #[test]
    fn tags_are_pairwise_distinct_and_prefix_free() {
        let tags = [
            TAG_DOMAIN,
            TAG_ROSTER,
            TAG_SETTLE,
            TAG_CONSENT,
            TAG_ANNUL,
            TAG_JOIN,
            TAG_EVIDENCE,
            TAG_REMEDY,
            TAG_REMEDY_APPROVE,
        ];
        for (i, a) in tags.iter().enumerate() {
            for (j, b) in tags.iter().enumerate() {
                if i != j {
                    assert!(!b.starts_with(a), "{:?} prefixes {:?}", a, b);
                }
            }
        }
    }

    #[test]
    fn remedy_approve_digest_binds_every_field() {
        let domain = [9u8; 32];
        let log = [4u8; 32];
        let base = remedy_approve_digest(&domain, 5, 2, 1, 2, 7, 40, &log, 1_000, 9_000, 0);
        let mut other = domain;
        other[0] ^= 1;
        let mut other_log = log;
        other_log[31] ^= 1;
        for changed in [
            remedy_approve_digest(&other, 5, 2, 1, 2, 7, 40, &log, 1_000, 9_000, 0),
            remedy_approve_digest(&domain, 6, 2, 1, 2, 7, 40, &log, 1_000, 9_000, 0),
            remedy_approve_digest(&domain, 5, 5, 1, 2, 7, 40, &log, 1_000, 9_000, 0),
            remedy_approve_digest(&domain, 5, 2, 0, 2, 7, 40, &log, 1_000, 9_000, 0),
            remedy_approve_digest(&domain, 5, 2, 1, 1, 7, 40, &log, 1_000, 9_000, 0),
            remedy_approve_digest(&domain, 5, 2, 1, 2, 8, 40, &log, 1_000, 9_000, 0),
            remedy_approve_digest(&domain, 5, 2, 1, 2, 7, 41, &log, 1_000, 9_000, 0),
            remedy_approve_digest(&domain, 5, 2, 1, 2, 7, 40, &other_log, 1_000, 9_000, 0),
            remedy_approve_digest(&domain, 5, 2, 1, 2, 7, 40, &log, 1_001, 9_000, 0),
            remedy_approve_digest(&domain, 5, 2, 1, 2, 7, 40, &log, 1_000, 9_001, 0),
            remedy_approve_digest(&domain, 5, 2, 1, 2, 7, 40, &log, 1_000, 9_000, 2),
        ] {
            assert_ne!(changed, base);
        }
    }

    #[test]
    fn roster_hash_is_order_sensitive_and_length_prefixed() {
        let a = roster_hash(&["juno1aaa", "juno1bbb"]).unwrap();
        let b = roster_hash(&["juno1bbb", "juno1aaa"]).unwrap();
        assert_ne!(a, b);
        // "ab"+"c" and "a"+"bc" must differ (length prefixes).
        assert_ne!(
            roster_hash(&["ab", "c"]).unwrap(),
            roster_hash(&["a", "bc"]).unwrap()
        );
    }
}
