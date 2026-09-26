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
//! annul       = SHA-256("18JUNO/ANNUL/v1" ‖ domain ‖ u64(last_seq))        signed by every seat's consent key
//! ```
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
/// `last_seq`; a newer checkpoint makes an older annul signature useless.
pub fn annul_digest(domain: &[u8; 32], last_seq: u64) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(TAG_ANNUL);
    hasher.update(domain);
    hasher.update(last_seq.to_be_bytes());
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

/// [`check_signature`] for the settlement signer, with specific errors.
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
