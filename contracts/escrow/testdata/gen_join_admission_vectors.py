#!/usr/bin/env python3
"""Independent generator for the join-admission cross-language vectors.

Re-implements, from the specification text only (contracts/escrow/src/crypto.rs
module comment, 2026-09-28), the JOIN admission digest

    join = SHA-256("18JUNO/JOIN/v1" ‖ u16(len) ‖ chain_id ‖ u16(len) ‖ contract_addr
                   ‖ u64(chain_game_id) ‖ u16(len) ‖ wallet ‖ join_ticket(32) ‖ u64(expires_at))

(every integer fixed-width big-endian, no terminator, no JSON anywhere) and
deterministic RFC 6979 low-s secp256k1 signatures over it. It shares no code
with the Rust contract or the TypeScript server; the Rust tests
(tests/join_admission_vectors.rs) and the TypeScript tests
(frontend/src/utils/escrowJoinAdmissionVectors.test.ts,
server/src/escrow/juno/joinAdmission.test.ts) must reproduce every byte this
script writes, and the contract must accept exactly the vectors marked valid.

    pip install ecdsa          # python-ecdsa, pure Python
    python3 gen_join_admission_vectors.py > join_admission_vectors_v1.json

The keys are TEST keys (secret = SHA-256(public label)); their secrets are
printed so the server's development signer can be checked byte for byte.
"""

import hashlib
import json
import sys

from ecdsa import SECP256k1, SigningKey
from ecdsa.util import sigencode_string_canonize

N = SECP256k1.order
TAG_JOIN = b"18JUNO/JOIN/v1"
GENESIS_SECS = 1_790_000_000  # tests/common/mod.rs GENESIS_SECS
TTL = 15 * 60  # tests/common/mod.rs ADMISSION_TTL
U64_MAX = (1 << 64) - 1


def sha256(*parts: bytes) -> bytes:
    h = hashlib.sha256()
    for p in parts:
        h.update(p)
    return h.digest()


def be(value: int, width: int) -> bytes:
    return value.to_bytes(width, "big")


# ---------------------------------------------------------------- bech32 (BIP-173)
CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"


def _polymod(values):
    gen = [0x3B6A57B2, 0x26508E6D, 0x1EA119FA, 0x3D4233DD, 0x2A1462B3]
    chk = 1
    for v in values:
        top = chk >> 25
        chk = (chk & 0x1FFFFFF) << 5 ^ v
        for i in range(5):
            chk ^= gen[i] if ((top >> i) & 1) else 0
    return chk


def _hrp_expand(hrp):
    return [ord(x) >> 5 for x in hrp] + [0] + [ord(x) & 31 for x in hrp]


def _convertbits(data, frombits, tobits):
    acc, bits, ret, maxv = 0, 0, [], (1 << tobits) - 1
    for value in data:
        acc = (acc << frombits) | value
        bits += frombits
        while bits >= tobits:
            bits -= tobits
            ret.append((acc >> bits) & maxv)
    if bits:
        ret.append((acc << (tobits - bits)) & maxv)
    return ret


def bech32(hrp: str, data8: bytes) -> str:
    data5 = _convertbits(data8, 8, 5)
    values = _hrp_expand(hrp) + data5
    polymod = _polymod(values + [0] * 6) ^ 1
    checksum = [(polymod >> 5 * (5 - i)) & 31 for i in range(6)]
    return hrp + "1" + "".join(CHARSET[d] for d in data5 + checksum)


def addr_make(label: str) -> str:
    """cw-multi-test MockApiBech32("juno").addr_make(label)."""
    return bech32("juno", sha256(label.encode()))


def contract_address(code_id: int, instance_id: int) -> str:
    """cw-multi-test MockAddressGenerator (wasmd classic module address)."""
    return bech32("juno", sha256(sha256(b"module"), b"wasm\0", be(code_id, 8), be(instance_id, 8)))


def ticket(label: str) -> bytes:
    """tests/common/mod.rs ticket(label)."""
    return sha256(b"18JUNO/TEST/ticket/", label.encode())


# --------------------------------------------------------------- the construction
def join_preimage(chain_id: str, contract: str, chain_game_id: int, wallet: str,
                  join_ticket: bytes, expires_at: int) -> bytes:
    c, k, w = chain_id.encode(), contract.encode(), wallet.encode()
    assert len(join_ticket) == 32
    return (TAG_JOIN + be(len(c), 2) + c + be(len(k), 2) + k + be(chain_game_id, 8)
            + be(len(w), 2) + w + join_ticket + be(expires_at, 8))


# ------------------------------------------------------------------------- keys
def test_key(label: str) -> SigningKey:
    secret = int.from_bytes(sha256(label.encode()), "big")
    assert 0 < secret < N
    return SigningKey.from_secret_exponent(secret, curve=SECP256k1)


def pubkey(sk: SigningKey) -> bytes:
    return sk.get_verifying_key().to_string("compressed")


def sign(sk: SigningKey, digest: bytes) -> bytes:
    sig = sk.sign_digest_deterministic(digest, hashfunc=hashlib.sha256,
                                       sigencode=sigencode_string_canonize)
    assert int.from_bytes(sig[32:], "big") <= N // 2
    return sig


def high_s(sig: bytes) -> bytes:
    s = int.from_bytes(sig[32:], "big")
    return sig[:32] + be(N - s, 32)


def key_doc(label: str):
    sk = test_key(label)
    return {"label": label, "secret_hex": sk.to_string().hex(), "pubkey": pubkey(sk).hex()}


ADMISSION = test_key("18JUNO/TEST/admission/1")
OTHER = test_key("18JUNO/TEST/admission/2")
SETTLEMENT = test_key("18JUNO/TEST/signer/1")


def inputs_doc(i):
    return {
        "chain_id": i["chain_id"],
        "contract_addr": i["contract_addr"],
        "chain_game_id": str(i["chain_game_id"]),
        "wallet": i["wallet"],
        "join_ticket": i["join_ticket"].hex(),
        "expires_at": str(i["expires_at"]),
    }


def digest_of(i) -> bytes:
    return sha256(join_preimage(i["chain_id"], i["contract_addr"], i["chain_game_id"],
                                i["wallet"], i["join_ticket"], i["expires_at"]))


def vector(name, i, signature, valid, note, mutates=None):
    pre = join_preimage(i["chain_id"], i["contract_addr"], i["chain_game_id"], i["wallet"],
                        i["join_ticket"], i["expires_at"])
    digest = sha256(pre)
    ok = False
    if len(signature) == 64 and int.from_bytes(signature[32:], "big") <= N // 2:
        try:
            ok = ADMISSION.get_verifying_key().verify_digest(signature, digest)
        except Exception:  # noqa: BLE001 - BadSignatureError and malformed scalars
            ok = False
    assert ok == valid, name
    out = {
        "name": name,
        "note": note,
        "inputs": inputs_doc(i),
        "preimage": pre.hex(),
        "digest": digest.hex(),
        "signature": signature.hex(),
        "valid": valid,
    }
    if mutates is not None:
        out["mutates"] = mutates
    return out


def main():
    contract = contract_address(1, 0)  # the first instance the Rust Suite creates
    base = {
        "chain_id": "juno-1",
        "contract_addr": contract,
        "chain_game_id": 1,
        "wallet": addr_make("alice"),
        "join_ticket": ticket("alice"),
        "expires_at": GENESIS_SECS + TTL,
    }
    base_sig = sign(ADMISSION, digest_of(base))

    testnet = dict(base, chain_id="uni-7", wallet=addr_make("bob"), join_ticket=ticket("bob"))
    extremes = dict(base, chain_game_id=U64_MAX, expires_at=U64_MAX,
                    wallet=bech32("juno", sha256(b"18JUNO/TEST/contract-like-wallet")),
                    join_ticket=bytes(range(32)))

    keplr = dict(base, wallet=bech32("juno", sha256(b"18JUNO/TEST/keplr-wallet")[:20]))

    vectors = [
        vector("base", base, base_sig, True,
               "juno-1, the Suite's first contract, game 1, alice (players[1]) with ticket(alice), expiring 15 min after genesis"),
        vector("testnet", testnet, sign(ADMISSION, digest_of(testnet)), True,
               "uni-7 (SuiteBuilder::chain_id(TESTNET)), bob (players[2]) with ticket(bob)"),
        vector("extremes", extremes, sign(ADMISSION, digest_of(extremes)), True,
               "u64::MAX game id and expiry (big-endian width check); digest only"),
        vector("keplr-20-byte-wallet", keplr, sign(ADMISSION, digest_of(keplr)), True,
               "a 20-byte account address (the Keplr / secp256k1 account form, 43 characters); digest only"),
    ]

    # One field changed at a time, carrying BASE's signature (a copied admission).
    mutations = [
        ("chain_id", "another-chain", dict(base, chain_id="uni-7"),
         "the base admission replayed on another chain"),
        ("contract_addr", "another-contract", dict(base, contract_addr=contract_address(1, 1)),
         "the base admission replayed on a second escrow instance (the Suite's next contract)"),
        ("chain_game_id", "another-game", dict(base, chain_game_id=2),
         "the base admission replayed on another game of the same contract"),
        ("wallet", "another-wallet", dict(base, wallet=addr_make("mallory")),
         "the base admission copied into mallory's (the Suite's outsider) Join"),
        ("wallet", "uppercase-wallet", dict(base, wallet=base["wallet"].upper()),
         "the same account spelt in upper case: the chain's sender is lower case, so an admission signed over any other spelling never verifies"),
        ("join_ticket", "another-ticket", dict(base, join_ticket=base["join_ticket"][:31] + bytes([base["join_ticket"][31] ^ 1])),
         "the base admission with one ticket bit flipped"),
        ("expires_at", "another-expiry", dict(base, expires_at=base["expires_at"] + 1),
         "the base admission with its expiry extended by one second"),
    ]
    for field, name, inputs, note in mutations:
        vectors.append(vector(f"mutate-{name}", inputs, base_sig, False, note, mutates=field))

    r_flip = bytearray(base_sig)
    r_flip[0] ^= 0x01
    s_flip = bytearray(base_sig)
    s_flip[63] ^= 0x01
    signatures = [
        ("sig-r-bit", bytes(r_flip), "one bit of r flipped"),
        ("sig-s-bit", bytes(s_flip), "one bit of s flipped"),
        ("sig-high-s", high_s(base_sig), "the same signature as (r, n - s): ECDSA-valid, refused as not low-s"),
        ("sig-other-admission-key", sign(OTHER, digest_of(base)), "the right digest signed by another (e.g. rotated-out) admission key"),
        ("sig-settlement-key", sign(SETTLEMENT, digest_of(base)), "the right digest signed by the settlement signer key"),
        ("sig-truncated", base_sig[:63], "63 bytes"),
        ("sig-extended", base_sig + b"\x00", "65 bytes"),
        ("sig-empty", b"", "no bytes"),
        ("sig-zero", bytes(64), "r = s = 0"),
    ]
    for name, sig, note in signatures:
        vectors.append(vector(name, base, sig, False, note, mutates="signature"))

    doc = {
        "format": "18JUNO/JOIN/admission-vectors/v1",
        "spec": ("join = SHA-256(\"18JUNO/JOIN/v1\" || u16(len) || chain_id || u16(len) || contract_addr || "
                 "u64(chain_game_id) || u16(len) || wallet || join_ticket(32) || u64(expires_at)); "
                 "integers big-endian; secp256k1 ECDSA over the digest itself, 64-byte r||s, low-s; "
                 "the contract checks block_time_secs < expires_at first, then the signature against "
                 "Config.admission_pubkey with wallet = the Join transaction's sender"),
        "tag": TAG_JOIN.decode(),
        "genesis_secs": GENESIS_SECS,
        "keys": {
            "admission": key_doc("18JUNO/TEST/admission/1"),
            "other_admission": key_doc("18JUNO/TEST/admission/2"),
            "settlement": key_doc("18JUNO/TEST/signer/1"),
        },
        "vectors": vectors,
    }
    json.dump(doc, sys.stdout, indent=2, sort_keys=False)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
