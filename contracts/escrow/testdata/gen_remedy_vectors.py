#!/usr/bin/env python3
"""Independent generator for the escrow 2.1.0 REMEDY cross-language vectors.

Re-implements, from the specification text only (contracts/escrow/src/crypto.rs
and src/remedy.rs module comments, owner decision R1 of 2026-10-06, and the
owner ruling of 2026-10-07 that a seat's approval is judged at the remedy's
attested final_at -- `final_at < approve_until` -- never at the block time):

    remedy  = SHA-256("18JUNO/REMEDY/v1" ‖ encode(attestation))
    encode  = u8(version=1) ‖ domain(32) ‖ u64(chain_game_id) ‖ u8(remedy)
              ‖ u8(defaulting_seat) ‖ u8(strike) ‖ u64(overdue_epoch) ‖ u64(log_len)
              ‖ log_hash(32) ‖ u64(allowance_secs) ‖ u64(overdue_at) ‖ u64(final_at)
              ‖ u64(attested_at) ‖ u64(expires_at) ‖ evidence_hash(32) ‖ u16(remedy_key_id)
                                                                              (166 bytes)
    approve = SHA-256("18JUNO/REMEDY-APPROVE/v1" ‖ domain(32) ‖ u64(chain_game_id)
              ‖ u8(remedy) ‖ u8(defaulting_seat) ‖ u8(strike) ‖ u64(overdue_epoch)
              ‖ u64(log_len) ‖ log_hash(32) ‖ u64(overdue_at) ‖ u64(approve_until)
              ‖ u8(approving_seat))

and the settlement domain the attestation names

    roster_hash = SHA-256("18JUNO/ROSTER/v1" ‖ u8(n) ‖ for each wallet: u16(len) ‖ wallet)
    domain      = SHA-256("18JUNO/DOMAIN/v1" ‖ u16(len) ‖ chain_id ‖ u16(len) ‖ contract_addr
                          ‖ u64(chain_game_id) ‖ roster_hash ‖ u32(rules_engine_version)
                          ‖ variants_digest ‖ u128(ante_gross) ‖ u8(mode))

(every integer fixed-width big-endian, no terminator, no JSON anywhere), with
deterministic RFC 6979 low-s secp256k1 signatures over the digests. It shares
no code with the Rust contract or the TypeScript codec; the Rust tests
(tests/remedy_vectors.rs) reproduce every byte and EXECUTE every replayable
vector on chain with exactly the verdict recorded here, and the TypeScript test
(frontend/src/utils/escrowRemedyVectors.test.ts) reproduces every byte and the
signature verdict.

    pip install ecdsa          # python-ecdsa, pure Python
    python3 gen_remedy_vectors.py > remedy_vectors_v1.json

The keys are TEST keys (secret = SHA-256(public label)).
"""

import hashlib
import json
import sys

from ecdsa import SECP256k1, SigningKey
from ecdsa.util import sigencode_string_canonize

N = SECP256k1.order
TAG_REMEDY = b"18JUNO/REMEDY/v1"
TAG_APPROVE = b"18JUNO/REMEDY-APPROVE/v1"
TAG_ROSTER = b"18JUNO/ROSTER/v1"
TAG_DOMAIN = b"18JUNO/DOMAIN/v1"
TAG_SETTLE = b"18JUNO/SETTLE/v1"
TAG_ANNUL = b"18JUNO/ANNUL/v1"
GENESIS_SECS = 1_790_000_000  # tests/common/mod.rs GENESIS_SECS
HOUR, DAY = 3600, 86400
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


# ------------------------------------------------------------------- the domain
def roster_hash(wallets) -> bytes:
    out = TAG_ROSTER + be(len(wallets), 1)
    for w in wallets:
        b = w.encode()
        out += be(len(b), 2) + b
    return sha256(out)


def domain(chain_id, contract, game_id, wallets, rules, variants, ante, mode) -> bytes:
    c, k = chain_id.encode(), contract.encode()
    return sha256(TAG_DOMAIN + be(len(c), 2) + c + be(len(k), 2) + k + be(game_id, 8)
                  + roster_hash(wallets) + be(rules, 4) + variants + be(ante, 16) + be(mode, 1))


# ------------------------------------------------------------ the construction
FIELDS = ["version", "domain", "chain_game_id", "remedy", "defaulting_seat", "strike",
          "overdue_epoch", "log_len", "log_hash", "allowance_secs", "overdue_at", "final_at",
          "attested_at", "expires_at", "evidence_hash", "remedy_key_id"]


def encode(a) -> bytes:
    out = (be(a["version"], 1) + a["domain"] + be(a["chain_game_id"], 8) + be(a["remedy"], 1)
           + be(a["defaulting_seat"], 1) + be(a["strike"], 1) + be(a["overdue_epoch"], 8)
           + be(a["log_len"], 8) + a["log_hash"] + be(a["allowance_secs"], 8)
           + be(a["overdue_at"], 8) + be(a["final_at"], 8) + be(a["attested_at"], 8)
           + be(a["expires_at"], 8) + a["evidence_hash"] + be(a["remedy_key_id"], 2))
    assert len(out) == 166
    return out


def remedy_digest(a) -> bytes:
    return sha256(TAG_REMEDY + encode(a))


def approve_preimage(dom, game_id, remedy, seat, strike, epoch, log_len, log_hash, overdue_at,
                     approve_until, approving) -> bytes:
    return (TAG_APPROVE + dom + be(game_id, 8) + be(remedy, 1) + be(seat, 1) + be(strike, 1)
            + be(epoch, 8) + be(log_len, 8) + log_hash + be(overdue_at, 8)
            + be(approve_until, 8) + be(approving, 1))


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


def verifies(sk: SigningKey, digest: bytes, sig: bytes) -> bool:
    """The contract's rule: 64 bytes, low-s, ECDSA over the digest itself."""
    if len(sig) != 64 or int.from_bytes(sig[32:], "big") > N // 2:
        return False
    try:
        return sk.get_verifying_key().verify_digest(sig, digest)
    except Exception:  # noqa: BLE001 - BadSignatureError and malformed scalars
        return False


def key_doc(label: str):
    sk = test_key(label)
    return {"label": label, "pubkey": pubkey(sk).hex()}


REMEDY = test_key("18JUNO/TEST/remedy/1")  # remedy key id 1 of the Rust Suite
OTHER_REMEDY = test_key("18JUNO/TEST/remedy/2")  # never registered
SETTLEMENT = test_key("18JUNO/TEST/signer/1")
ADMISSION = test_key("18JUNO/TEST/admission/1")
SEATS = [test_key(f"18JUNO/TEST/seat/{i}") for i in range(3)]


# ------------------------------------------------------------------- the games
CONTRACT = contract_address(1, 0)  # the first instance the Rust Suite creates
WALLETS = [addr_make("creator"), addr_make("alice"), addr_make("bob")]
VARIANTS = sha256(b"18JUNO/TEST/variants")
GAMES = {
    # Live, the 20-minute action clock: started at genesis, replayed an hour in.
    "live": {"mode": 0, "allowance_secs": 20 * 60, "deadline": {"live_action_clock": {}}},
    # Timed Async, the 24-hour pace: started at genesis, replayed two days in.
    "async": {"mode": 1, "allowance_secs": DAY, "deadline": {"async_pace": {"allowance_secs": DAY}}},
}
for g in GAMES.values():
    g.update({
        "chain_id": "juno-1",
        "contract_addr": CONTRACT,
        "chain_game_id": 1,
        "wallets": WALLETS,
        "rules_engine_version": 10,
        "variants_digest": VARIANTS,
        "ante_gross": 2_000_000,
        "started_at": GENESIS_SECS,
    })
    g["roster_hash"] = roster_hash(g["wallets"])
    g["domain"] = domain(g["chain_id"], g["contract_addr"], g["chain_game_id"], g["wallets"],
                         g["rules_engine_version"], g["variants_digest"], g["ante_gross"], g["mode"])


def game_doc(g):
    return {
        "chain_id": g["chain_id"],
        "contract_addr": g["contract_addr"],
        "chain_game_id": str(g["chain_game_id"]),
        "wallets": g["wallets"],
        "rules_engine_version": g["rules_engine_version"],
        "variants_digest": g["variants_digest"].hex(),
        "ante_gross": str(g["ante_gross"]),
        "mode": g["mode"],
        "deadline": g["deadline"],
        "allowance_secs": str(g["allowance_secs"]),
        "started_at": str(g["started_at"]),
        "roster_hash": g["roster_hash"].hex(),
        "domain": g["domain"].hex(),
    }


def att_doc(a):
    out = {}
    for f in FIELDS:
        v = a[f]
        if isinstance(v, bytes):
            out[f] = v.hex()
        elif f in ("version", "remedy", "defaulting_seat", "strike", "remedy_key_id"):
            out[f] = v
        else:
            out[f] = str(v)  # Uint64 on the wire: a JSON string
    return out


def approvals_of(a, seats, *, until=None, signed_until=None, epoch=None, instance=None,
                 key_for=None, digest_for=None):
    """`approve_until`: the horizon each seat set (default: one day after the
    attestation's finality, so a re-attestation of the same decision carries
    the very same approvals); `preimage` / `digest`: the REMEDY-APPROVE bytes
    the attestation and that `approve_until` imply for the seat (what the
    contract verifies against); `signed_digest`: what the seat actually signed
    (different only in the mis-approval vectors: another `epoch`, another
    overdue `instance` = (log_len, log_hash, overdue_at), or another horizon
    `signed_until` than the one presented)."""
    until = a["final_at"] + DAY if until is None else until
    out = []
    for s in seats:
        pre = approve_preimage(a["domain"], a["chain_game_id"], a["remedy"], a["defaulting_seat"],
                               a["strike"], a["overdue_epoch"], a["log_len"], a["log_hash"],
                               a["overdue_at"], until, s)
        log_len, log_hash, overdue_at = (a["log_len"], a["log_hash"], a["overdue_at"]) \
            if instance is None else instance
        signed_pre = approve_preimage(a["domain"], a["chain_game_id"], a["remedy"],
                                      a["defaulting_seat"], a["strike"],
                                      a["overdue_epoch"] if epoch is None else epoch,
                                      log_len, log_hash, overdue_at,
                                      until if signed_until is None else signed_until, s)
        signed = sha256(signed_pre) if digest_for is None else digest_for(s)
        sk = SEATS[s] if key_for is None else key_for(s)
        out.append({"seat_index": s, "approve_until": str(until), "preimage": pre.hex(),
                    "digest": sha256(pre).hex(), "signed_digest": signed.hex(),
                    "signature": sign(sk, signed).hex(),
                    "signature_verifies": verifies(SEATS[s], sha256(pre), sign(sk, signed))})
    return out


def vector(name, game, a, *, signature=None, approvals=(), block_time, expect, note,
           mutates=None, replay=True):
    enc = encode(a)
    digest = sha256(TAG_REMEDY + enc)
    sig = sign(REMEDY, digest) if signature is None else signature
    out = {
        "name": name,
        "note": note,
        "game": game,
        "replay": replay,
        "block_time": str(block_time),
        "attestation": att_doc(a),
        "encoding": enc.hex(),
        "preimage": (TAG_REMEDY + enc).hex(),
        "digest": digest.hex(),
        "signature": sig.hex(),
        "signature_verifies": verifies(REMEDY, digest, sig),
        "approvals": list(approvals),
        "valid": expect.startswith("ok:"),
        "expect": expect,
    }
    if mutates is not None:
        out["mutates"] = mutates
    return out


def main():
    live, asy = GAMES["live"], GAMES["async"]
    B = GENESIS_SECS + HOUR  # live replay block time
    BA = GENESIS_SECS + 2 * DAY  # async replay block time
    evidence = sha256(b"18JUNO/TEST/clock-evidence")

    def live_att(remedy, seat, strike, epoch):
        overdue = B if remedy == 3 else B - 600
        return {"version": 1, "domain": live["domain"], "chain_game_id": 1, "remedy": remedy,
                "defaulting_seat": seat, "strike": strike, "overdue_epoch": epoch, "log_len": 0,
                "log_hash": sha256(b"18JUNO/TEST/remedy-log", be(0, 8)),
                "allowance_secs": live["allowance_secs"], "overdue_at": overdue, "final_at": B,
                "attested_at": B, "expires_at": B + HOUR, "evidence_hash": evidence,
                "remedy_key_id": 1}

    def async_att(remedy, seat, epoch):
        return {"version": 1, "domain": asy["domain"], "chain_game_id": 1, "remedy": remedy,
                "defaulting_seat": seat, "strike": 0, "overdue_epoch": epoch, "log_len": 0,
                "log_hash": sha256(b"18JUNO/TEST/remedy-log", be(0, 8)),
                "allowance_secs": asy["allowance_secs"], "overdue_at": GENESIS_SECS + DAY,
                "final_at": BA - 60, "attested_at": BA - 30, "expires_at": BA + 1800,
                "evidence_hash": evidence, "remedy_key_id": 1}

    annul = live_att(1, 2, 1, 7)
    fore = live_att(2, 1, 2, 8)
    strike3 = live_att(3, 0, 3, 9)
    a_annul = async_att(4, 2, 3)
    a_fore = async_att(5, 0, 4)
    vectors = [
        vector("live-timeout-annul", "live", annul, block_time=B, expect="ok:annulled",
               note="Live, seat 2 uncured at 30:00 on its first strike, no approval: neutral refund"),
        vector("live-foreclose", "live", fore, approvals=approvals_of(fore, [0, 2]), block_time=B,
               expect="ok:settled",
               note="Live, seat 1 uncured at 30:00 on its second strike, seats 0 and 2 approved: foreclosure"),
        vector("live-strike3", "live", strike3, block_time=B, expect="ok:settleable",
               note="Live, seat 0's third expiry: foreclosure stored for the challenge window"),
        vector("async-annul", "async", a_annul, approvals=approvals_of(a_annul, [0, 1]),
               block_time=BA, expect="ok:annulled",
               note="Timed Async (24 h), seat 2 overdue, seats 0 and 1 approved the neutral annulment"),
        vector("async-foreclose", "async", a_fore, approvals=approvals_of(a_fore, [1, 2]),
               block_time=BA, expect="ok:settled",
               note="Timed Async (24 h), seat 0 overdue, seats 1 and 2 approved the foreclosure"),
    ]
    extremes = dict(annul, chain_game_id=U64_MAX, overdue_epoch=U64_MAX, log_len=U64_MAX - 1,
                    allowance_secs=U64_MAX, overdue_at=U64_MAX - 3, final_at=U64_MAX - 2,
                    attested_at=U64_MAX - 1, expires_at=U64_MAX, remedy_key_id=0xFFFF, defaulting_seat=0xFF,
                    strike=0xFF, remedy=0xFF, domain=bytes(range(32)),
                    log_hash=bytes(range(32, 64)), evidence_hash=bytes(range(64, 96)))
    vectors.append(vector("extremes", "live", extremes, block_time=B, expect="digest-only",
                          note="every integer at its width's maximum (big-endian width check); not replayed",
                          replay=False))

    # One field changed at a time, carrying the base signature (a copied or
    # altered attestation). The contract's verdict, in its check order.
    base_sig = sign(REMEDY, remedy_digest(annul))
    other_contract = domain("juno-1", contract_address(1, 1), 1, WALLETS, 10, VARIANTS, 2_000_000, 0)
    mutations = [
        ("chain_game_id", "another-game", dict(annul, chain_game_id=2), "DomainMismatch",
         "the attestation of game 1 renamed to game 2"),
        ("domain", "another-contract", dict(annul, domain=other_contract), "DomainMismatch",
         "the domain of the same game id on a second escrow instance"),
        ("defaulting_seat", "another-seat", dict(annul, defaulting_seat=1), "InvalidSignature",
         "another defaulting seat"),
        ("remedy", "another-remedy", dict(annul, remedy=2), "InvalidSignature",
         "the neutral annulment relabelled as a foreclosure"),
        ("strike", "another-strike", dict(annul, strike=2), "InvalidSignature",
         "another strike"),
        ("overdue_epoch", "another-epoch", dict(annul, overdue_epoch=8), "InvalidSignature",
         "another overdue epoch"),
        ("log_len", "another-sequence", dict(annul, log_len=1), "InvalidSignature",
         "another log position"),
        ("log_hash", "another-log", dict(annul, log_hash=sha256(b"other-log")), "InvalidSignature",
         "another log hash"),
        ("allowance_secs", "another-allowance", dict(annul, allowance_secs=1201),
         "AllowanceMismatch { expected: 1200, got: 1201 }", "another action allowance"),
        ("final_at", "another-finality",
         dict(annul, overdue_at=annul["overdue_at"] - 1, final_at=annul["final_at"] - 1),
         "InvalidSignature", "the same overdue one second earlier"),
        ("expires_at", "another-expiry", dict(annul, expires_at=annul["expires_at"] - 1),
         "InvalidSignature", "the expiry moved by one second (within the TTL)"),
        ("expires_at", "beyond-ttl", dict(annul, expires_at=annul["attested_at"] + HOUR + 1),
         'RemedyTiming { reason: "expires_at lies more than the remedy TTL after attested_at" }',
         "a bearer life one second beyond the one-hour TTL"),
        ("evidence_hash", "stale-clock-evidence", dict(annul, evidence_hash=sha256(b"pre-outage")),
         "InvalidSignature", "another (stale) control-plane clock evidence hash"),
        ("remedy_key_id", "another-key-id", dict(annul, remedy_key_id=2),
         "UnknownRemedyKey { key_id: 2 }", "another remedy key id (not registered)"),
    ]
    for field, name, a, expect, note in mutations:
        vectors.append(vector(f"mutate-{name}", "live", a, signature=base_sig, block_time=B,
                              expect=expect, note=note, mutates=field))
    # Replayed a second later, so the moved attestation time is not in the future.
    vectors.append(vector("mutate-another-attestation-time", "live",
                          dict(annul, attested_at=annul["attested_at"] + 1), signature=base_sig,
                          block_time=B + 1, expect="InvalidSignature",
                          note="the attestation time moved by one second", mutates="attested_at"))

    enc = encode(annul)
    signatures = [
        ("sig-other-remedy-key", sign(OTHER_REMEDY, remedy_digest(annul)), "InvalidSignature",
         "the right digest signed by an unregistered remedy key"),
        ("sig-settlement-key", sign(SETTLEMENT, remedy_digest(annul)), "InvalidSignature",
         "the right digest signed by the settlement signer key (another key class)"),
        ("sig-admission-key", sign(ADMISSION, remedy_digest(annul)), "InvalidSignature",
         "the right digest signed by the join-admission key (another key class)"),
        ("sig-wrong-purpose-settle", sign(REMEDY, sha256(TAG_SETTLE + enc)), "InvalidSignature",
         "the remedy key over SETTLE-tagged bytes"),
        ("sig-wrong-purpose-raw", sign(REMEDY, sha256(enc)), "InvalidSignature",
         "the remedy key over the untagged encoding"),
        ("sig-high-s", high_s(base_sig), "HighS",
         "the same signature as (r, n - s): ECDSA-valid, refused as not low-s"),
        ("sig-truncated", base_sig[:63], "BadSignatureLength { got: 63 }", "63 bytes"),
    ]
    for name, sig, expect, note in signatures:
        vectors.append(vector(name, "live", annul, signature=sig, block_time=B, expect=expect,
                              note=note, mutates="signature"))

    # The same final decision attested again two hours later (it was not
    # relayed in time): a fresh attested_at, nothing else of it changes; the
    # very approvals of the foreclosure still count (they bind the overdue
    # instance, not the attestation's own time).
    late = B + 2 * HOUR
    reattested = dict(fore, attested_at=late, expires_at=late + 600)
    ahead = dict(annul, attested_at=B + 30, expires_at=B + 600)
    # The seats' horizon on the foreclosure's approvals (one day after its
    # finality); the decision attested again at its last second and an hour
    # past it (the approvals were valid at final_at: it still lands); and a
    # foreclosure that became FINAL only at that horizon (never counts).
    horizon = fore["final_at"] + DAY
    at_last = dict(fore, attested_at=horizon - 1, expires_at=horizon + 599)
    past = dict(fore, attested_at=horizon + HOUR, expires_at=horizon + HOUR + 600)
    final_at_horizon = dict(fore, overdue_at=horizon - 600, final_at=horizon,
                            attested_at=horizon, expires_at=horizon + 600)
    vectors += [
        vector("reattested-foreclose", "live", reattested,
               approvals=approvals_of(reattested, [0, 2]), block_time=late, expect="ok:settled",
               note="the live-foreclose decision, attested again two hours after its finality",
               mutates="attested_at"),
        vector("attested-in-future", "live", ahead, block_time=B,
               expect='RemedyTiming { reason: "attested_at lies after the block time" }',
               note="attested 30 s after the block time (a signer clock running ahead)",
               mutates="attested_at"),
        vector("expired", "live", annul, block_time=annul["expires_at"],
               expect=f"RemedyExpired {{ expires_at: {annul['expires_at']} }}",
               note="replayed at its expiry second", mutates="block_time"),
        vector("not-final", "live", annul, block_time=annul["final_at"] - 1,
               expect=f"RemedyNotFinal {{ final_at: {annul['final_at']} }}",
               note="replayed one second before 30:00", mutates="block_time"),
        vector("approval-last-second", "live", at_last, approvals=approvals_of(at_last, [0, 2]),
               block_time=horizon - 1, expect="ok:settled",
               note="the foreclosure attested again and relayed at its approvals' last usable second",
               mutates="block_time"),
        vector("approval-past-horizon", "live", past, approvals=approvals_of(past, [0, 2]),
               block_time=horizon + HOUR, expect="ok:settled",
               note="the same sealed decision attested again and relayed an hour after its "
                    "approvals' approve_until: they were valid at final_at, so it lands",
               mutates="block_time"),
        vector("approval-expired", "live", final_at_horizon,
               approvals=approvals_of(final_at_horizon, [0, 2], until=horizon),
               block_time=horizon,
               expect=f"ApprovalExpired {{ seat_index: 0, approve_until: {horizon}, "
                      f"final_at: {horizon} }}",
               note="a foreclosure FINAL at the approvals' approve_until: refused whatever the "
                    "block time (a lapsed approval never decides a finality)",
               mutates="approvals"),
        vector("approval-extended", "live", fore,
               approvals=approvals_of(fore, [0, 2], until=horizon + DAY, signed_until=horizon),
               block_time=B, expect="InvalidConsent { seat_index: 0 }",
               note="the approvals presented with a horizon one day beyond the one the seats signed",
               mutates="approvals"),
        vector("approval-missing", "live", fore, approvals=approvals_of(fore, [0]), block_time=B,
               expect="MissingConsent { seat_index: 2 }",
               note="seat 2 never approved", mutates="approvals"),
        vector("approval-defaulter", "live", fore, approvals=approvals_of(fore, [0, 1, 2]),
               block_time=B, expect="DefaulterCannotApprove { seat_index: 1 }",
               note="the defaulting seat 1 also signed", mutates="approvals"),
        vector("approval-other-epoch", "live", fore,
               approvals=approvals_of(fore, [0, 2], epoch=fore["overdue_epoch"] + 1),
               block_time=B, expect="InvalidConsent { seat_index: 0 }",
               note="approvals given for the next overdue epoch (a cure ended this one)",
               mutates="approvals"),
        vector("approval-cured-instance", "live", fore,
               approvals=approvals_of(fore, [0, 2], instance=(
                   fore["log_len"], sha256(b"18JUNO/TEST/remedy-log/cured"), fore["overdue_at"] - 900)),
               block_time=B, expect="InvalidConsent { seat_index: 0 }",
               note="approvals given for an earlier, cured overdue of the same strike and epoch "
                    "(another log state and overdue moment)",
               mutates="approvals"),
        vector("approval-wrong-purpose", "live", fore,
               approvals=approvals_of(fore, [0, 2],
                                      digest_for=lambda s: sha256(TAG_ANNUL + fore["domain"] + be(0, 8))),
               block_time=B, expect="InvalidConsent { seat_index: 0 }",
               note="the seats' ANNUL signatures offered as approvals", mutates="approvals"),
        vector("approvals-on-timeout-annul", "live", annul, approvals=approvals_of(annul, [0, 1]),
               block_time=B, expect="ApprovalsNotAllowed { remedy: 1 }",
               note="the Live 30:00 neutral annulment carries no vote", mutates="approvals"),
    ]

    doc = {
        "format": "18JUNO/REMEDY/vectors/v1",
        "spec": ("remedy = SHA-256(\"18JUNO/REMEDY/v1\" || encode); encode = u8(1) || domain(32) || "
                 "u64(chain_game_id) || u8(remedy) || u8(defaulting_seat) || u8(strike) || "
                 "u64(overdue_epoch) || u64(log_len) || log_hash(32) || u64(allowance_secs) || "
                 "u64(overdue_at) || u64(final_at) || u64(attested_at) || u64(expires_at) || "
                 "evidence_hash(32) || u16(remedy_key_id) (166 bytes); approve = "
                 "SHA-256(\"18JUNO/REMEDY-APPROVE/v1\" || domain(32) || u64(chain_game_id) || u8(remedy) "
                 "|| u8(defaulting_seat) || u8(strike) || u64(overdue_epoch) || u64(log_len) || "
                 "log_hash(32) || u64(overdue_at) || u64(approve_until) || u8(approving_seat)); "
                 "integers big-endian; "
                 "secp256k1 ECDSA over "
                 "the digest itself, 64-byte r||s, low-s"),
        "tag": TAG_REMEDY.decode(),
        "approve_tag": TAG_APPROVE.decode(),
        "genesis_secs": GENESIS_SECS,
        "keys": {
            "remedy": key_doc("18JUNO/TEST/remedy/1"),
            "other_remedy": key_doc("18JUNO/TEST/remedy/2"),
            "settlement": key_doc("18JUNO/TEST/signer/1"),
            "admission": key_doc("18JUNO/TEST/admission/1"),
            "seats": [key_doc(f"18JUNO/TEST/seat/{i}") for i in range(3)],
        },
        "games": {name: game_doc(g) for name, g in GAMES.items()},
        "vectors": vectors,
    }
    json.dump(doc, sys.stdout, indent=2, sort_keys=False)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
