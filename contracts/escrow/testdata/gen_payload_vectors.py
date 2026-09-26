#!/usr/bin/env python3
"""Independent generator for the ESCROW-2 cross-language payload vectors.

Re-implements, from the frozen specification text only (ESCROW-1.5 §6 as
amended by SET-0A rev 2 §21: A1 appraisal_log_len, A2 settlement_weights, A3),
the canonical SettlementPayloadV1 encoding, the 18JUNO/*/v1 domain-separated
digests and deterministic RFC 6979 low-s secp256k1 signatures. It shares no
code with the Rust contract; the Rust tests (tests/vectors.rs) must reproduce
every byte this script writes.

    pip install ecdsa          # python-ecdsa, pure Python
    python3 gen_payload_vectors.py > payload_vectors_v1.json

SET-0B (TypeScript encoder) and ESCROW-3 (server signer) should reproduce the
same file byte for byte.
"""

import hashlib
import json
import sys

from ecdsa import SECP256k1, SigningKey
from ecdsa.util import sigencode_string_canonize

U128_MAX = (1 << 128) - 1
N = SECP256k1.order

TAG_DOMAIN = b"18JUNO/DOMAIN/v1"
TAG_ROSTER = b"18JUNO/ROSTER/v1"
TAG_SETTLE = b"18JUNO/SETTLE/v1"
TAG_CONSENT = b"18JUNO/CONSENT/v1"
TAG_ANNUL = b"18JUNO/ANNUL/v1"


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


# ------------------------------------------------------------- frozen constructions
def roster_hash(wallets):
    parts = [TAG_ROSTER, be(len(wallets), 1)]
    for w in wallets:
        raw = w.encode()
        parts += [be(len(raw), 2), raw]
    return sha256(*parts)


def settlement_domain(chain_id, contract, chain_game_id, roster, rules_engine_version,
                      variants_digest, ante_gross, mode):
    c, k = chain_id.encode(), contract.encode()
    return sha256(TAG_DOMAIN, be(len(c), 2), c, be(len(k), 2), k, be(chain_game_id, 8), roster,
                  be(rules_engine_version, 4), variants_digest, be(ante_gross, 16), be(mode, 1))


def encode(p) -> bytes:
    n = len(p["settlement_weights"])
    assert p["seat_count"] == n
    out = (be(p["version"], 1) + p["domain"] + be(p["seq"], 8) + be(p["kind"], 1)
           + be(p["reason"], 1) + be(p["log_len"], 8) + p["log_hash"]
           + be(p["appraisal_log_len"], 8) + p["appraisal_state_hash"]
           + be(p["state_schema_version"], 2) + be(n, 1)
           + b"".join(be(w, 16) for w in p["settlement_weights"])
           + be(p["signer_key_id"], 2) + be(p["issued_at"], 8))
    assert len(out) == 136 + 16 * n
    return out


def settle_digest(encoded):
    return sha256(TAG_SETTLE, encoded)


def consent_digest(domain, seq, settle):
    return sha256(TAG_CONSENT, domain, be(seq, 8), settle)


def annul_digest(domain, last_seq):
    return sha256(TAG_ANNUL, domain, be(last_seq, 8))


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


SIGNER = ("18JUNO/TEST/signer/1", test_key("18JUNO/TEST/signer/1"))
SEATS = [(f"18JUNO/TEST/seat/{i}", test_key(f"18JUNO/TEST/seat/{i}")) for i in range(7)]


def hx(b: bytes) -> str:
    return b.hex()


def wire(p):
    """The JSON shape of crate::msg::SettlementPayloadV1."""
    return {
        "version": p["version"], "domain": hx(p["domain"]), "seq": str(p["seq"]),
        "kind": p["kind"], "reason": p["reason"], "log_len": str(p["log_len"]),
        "log_hash": hx(p["log_hash"]), "appraisal_log_len": str(p["appraisal_log_len"]),
        "appraisal_state_hash": hx(p["appraisal_state_hash"]),
        "state_schema_version": p["state_schema_version"], "seat_count": p["seat_count"],
        "settlement_weights": [str(w) for w in p["settlement_weights"]],
        "signer_key_id": p["signer_key_id"], "issued_at": str(p["issued_at"]),
    }


def main():
    assert addr_make("creator") == "juno1h34lmpywh4upnjdg90cjf4j70aee6z8qqfspugamjp42e4q28kqsksmtyp"
    doc = {
        "format": "18JUNO/ESCROW2/payload-vectors/v1",
        "spec": "ESCROW-1.5 section 6 as amended by SET-0A rev 2 section 21 (A1-A3); "
                "payload = 136 + 16*n bytes, all integers big-endian",
        "generator": "contracts/escrow/testdata/gen_payload_vectors.py (independent Python: "
                     "hashlib + python-ecdsa RFC 6979, low-s canonical); not the Rust encoder",
        "keys": {
            "note": "secret = SHA-256(label) as a big-endian scalar; test keys only",
            "signer": {"label": SIGNER[0], "pubkey": hx(pubkey(SIGNER[1]))},
            "seats": [{"label": l, "pubkey": hx(pubkey(k))} for l, k in SEATS],
        },
        "roster_vectors": [],
        "domain_vectors": [],
        "payload_vectors": [],
        "annul_vectors": [],
    }

    # ---------------------------------------------------------------- rosters
    rosters = {
        "two-seat": [addr_make("creator"), addr_make("alice")],
        "three-seat": [addr_make("creator"), addr_make("alice"), addr_make("bob")],
        "seven-seat": [addr_make(f"player-{i}") for i in range(7)],
    }
    for name, wallets in rosters.items():
        doc["roster_vectors"].append({"name": name, "wallets": wallets,
                                      "roster_hash": hx(roster_hash(wallets))})

    # ---------------------------------------------------------------- domains
    variants_digest = sha256(b"18JUNO/TEST/variants")
    contract = contract_address(1, 0)
    domains = {}
    for name, chain_id, roster_name, gid, mode, ante in [
        ("mainnet-two-seat-live", "juno-1", "two-seat", 1, 0, 2_000_000),
        ("testnet-two-seat-live", "uni-7", "two-seat", 1, 0, 2_000_000),
        ("mainnet-three-seat-async", "juno-1", "three-seat", 7, 1, 5_000_000),
        ("mainnet-seven-seat-live", "juno-1", "seven-seat", 42, 0, 2_000_000),
        ("mainnet-two-seat-live-game-2", "juno-1", "two-seat", 2, 0, 2_000_000),
    ]:
        rh = roster_hash(rosters[roster_name])
        d = settlement_domain(chain_id, contract, gid, rh, 10, variants_digest, ante, mode)
        domains[name] = d
        doc["domain_vectors"].append({
            "name": name, "chain_id": chain_id, "contract_addr": contract,
            "chain_game_id": gid, "roster": roster_name, "roster_hash": hx(rh),
            "rules_engine_version": 10, "variants_digest": hx(variants_digest),
            "ante_gross": str(ante), "mode": mode, "domain": hx(d)})

    # --------------------------------------------------------------- payloads
    log_hash = sha256(b"18JUNO/TEST/log")
    state_hash = sha256(b"18JUNO/TEST/state")

    def payload(domain_name, kind, reason, log_len, weights, appraisal=None, **over):
        p = {"version": 1, "domain": domains[domain_name], "seq": 2 * log_len + kind,
             "kind": kind, "reason": reason, "log_len": log_len, "log_hash": log_hash,
             "appraisal_log_len": log_len if appraisal is None else appraisal,
             "appraisal_state_hash": state_hash, "state_schema_version": 1,
             "seat_count": len(weights), "settlement_weights": weights,
             "signer_key_id": 1, "issued_at": 1_758_844_800}
        p.update(over)
        return p

    cases = [
        ("two-seat-checkpoint", "Checkpoint, 2 seats",
         payload("mainnet-two-seat-live", 0, 0, 120, [1205, 1230])),
        ("two-seat-terminal-bankbroken", "Terminal BankBroken, 2 seats (SYN-13 weights)",
         payload("mainnet-two-seat-live", 1, 1, 377, [1791, 1858])),
        ("three-seat-terminal-bankruptcy", "Terminal Bankruptcy, 3 seats (SYN-04 weights)",
         payload("mainnet-three-seat-async", 1, 2, 900, [2018, 1578, 2409])),
        ("three-seat-resolver-correction", "Terminal ResolverCorrection (reason 5), 3 seats",
         payload("mainnet-three-seat-async", 1, 5, 901, [2018, 1600, 2409])),
        ("three-seat-forfeit-earlier-appraisal", "Terminal Forfeit, appraisal_log_len < log_len (P8 weights)",
         payload("mainnet-three-seat-async", 1, 3, 950, [0, 1000, 500], appraisal=880)),
        ("three-seat-clemency-earlier-appraisal", "Terminal Clemency, appraisal_log_len < log_len (P9 weights)",
         payload("mainnet-three-seat-async", 1, 4, 950, [2_925_000_000, 3_900_000_000, 1_950_000_000], appraisal=880)),
        ("seven-seat-checkpoint", "Checkpoint, 7 seats (SYN-12 weights)",
         payload("mainnet-seven-seat-live", 0, 0, 1500, [0, 360, 360, 2409, 2018, 2448, 5])),
        ("seven-seat-terminal-bankbroken", "Terminal BankBroken, 7 seats (SYN-12 weights)",
         payload("mainnet-seven-seat-live", 1, 1, 1512, [0, 360, 360, 2409, 2018, 2448, 5])),
        ("two-seat-max-u128-weights", "Terminal BankBroken, both weights u128::MAX (P11)",
         payload("mainnet-two-seat-live", 1, 1, 400, [U128_MAX, U128_MAX])),
        ("seven-seat-max-u128-weights", "Terminal BankBroken, six u128::MAX weights and 1 (P13)",
         payload("mainnet-seven-seat-live", 1, 1, 1600, [U128_MAX] * 6 + [1])),
        ("two-seat-byte-order-sentinel", "every integer field has distinct bytes, to catch byte-order bugs",
         payload("mainnet-two-seat-live", 1, 1, 0x0102030405060708,
                 [0x0102030405060708090A0B0C0D0E0F10, 0x1112131415161718191A1B1C1D1E1F20],
                 state_schema_version=0x2122, signer_key_id=0x3132, issued_at=0x4142434445464748)),
    ]
    for name, description, p in cases:
        enc = encode(p)
        settle = settle_digest(enc)
        consent = consent_digest(p["domain"], p["seq"], settle)
        doc["payload_vectors"].append({
            "name": name, "description": description, "payload": wire(p),
            "encoded_len": len(enc), "encoded": hx(enc), "settle_digest": hx(settle),
            "signer_signature": hx(sign(SIGNER[1], settle)),
            "consent_digest": hx(consent),
            "consent_signatures": [hx(sign(k, consent)) for _, k in SEATS[: len(p["settlement_weights"])]],
        })

    # ------------------------------------------------------------------ annul
    for name, last_seq in [("mainnet-three-seat-async", 0), ("mainnet-three-seat-async", 1801),
                           ("mainnet-seven-seat-live", 3000)]:
        n = 3 if "three" in name else 7
        a = annul_digest(domains[name], last_seq)
        doc["annul_vectors"].append({"domain_vector": name, "last_seq": str(last_seq),
                                     "annul_digest": hx(a),
                                     "seat_signatures": [hx(sign(k, a)) for _, k in SEATS[:n]]})

    json.dump(doc, sys.stdout, indent=1)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
