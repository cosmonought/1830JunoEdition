#!/usr/bin/env python3
"""SET-0C: re-derive settlementPayloadVectorsV1.json with the escrow crate's independent Python encoder.

The TypeScript builder wrote settlementPayloadVectorsV1.json from the SET-0A golden boards. This script shares no
code with the TypeScript: it imports the frozen constructions of contracts/escrow/testdata/gen_payload_vectors.py (the
generator the Rust contract's tests/vectors.rs reproduces byte for byte) and recomputes, for every vector:

  * every roster hash and domain from its recorded inputs;
  * the 136 + 16*n encoding from the payload's JSON fields, its length, SETTLE and CONSENT digests;
  * the A1/seq shape rules and the contract's payload rules (2..7 seats, sum of weights > 0);
  * floor(pool * w_i / sum) payouts and dust, in Python's unbounded integers;
  * appraisal_state_hash and settlement_weights against SET-0A rev 2 (the SET-0B derived fixture).

    pip install ecdsa                       # gen_payload_vectors imports python-ecdsa
    python3 verify_set0c_payload_vectors.py # exits 0 and prints a summary, or exits 1 naming the first mismatch
"""

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.normpath(os.path.join(HERE, "..", "..", "..", "..", ".."))
sys.path.insert(0, os.path.join(REPO, "contracts", "escrow", "testdata"))
sys.dont_write_bytecode = True  # leave no __pycache__ in the escrow crate

import gen_payload_vectors as spec  # noqa: E402  (the escrow crate's independent encoder)


def fail(message):
    print(f"MISMATCH: {message}")
    sys.exit(1)


def check(cond, message):
    if not cond:
        fail(message)


def payload_from_wire(w):
    return {
        "version": w["version"], "domain": bytes.fromhex(w["domain"]), "seq": int(w["seq"]),
        "kind": w["kind"], "reason": w["reason"], "log_len": int(w["log_len"]),
        "log_hash": bytes.fromhex(w["log_hash"]), "appraisal_log_len": int(w["appraisal_log_len"]),
        "appraisal_state_hash": bytes.fromhex(w["appraisal_state_hash"]),
        "state_schema_version": w["state_schema_version"], "seat_count": w["seat_count"],
        "settlement_weights": [int(x) for x in w["settlement_weights"]],
        "signer_key_id": w["signer_key_id"], "issued_at": int(w["issued_at"]),
    }


def main():
    doc = json.load(open(os.path.join(HERE, "settlementPayloadVectorsV1.json")))
    golden = json.load(open(os.path.join(HERE, "SET0A_golden_vectors_rev2.derived.json")))
    rust = json.load(open(os.path.join(REPO, "contracts", "escrow", "testdata", "payload_vectors_v1.json")))
    check(doc["format"] == "18JUNO/SET0C/settlement-payload-vectors/v1", "format")

    domains = {}
    for d in doc["domains"]:
        roster = spec.roster_hash(d["roster_wallets"])
        check(roster.hex() == d["roster_hash"], f"{d['name']}: roster hash")
        dom = spec.settlement_domain(d["chain_id"], d["contract_addr"], int(d["chain_game_id"]), roster,
                                     d["rules_engine_version"], bytes.fromhex(d["variants_digest"]),
                                     int(d["ante_gross"]), d["mode"])
        check(dom.hex() == d["domain"], f"{d['name']}: domain")
        if d["supplied_by_rust_vectors"]:
            supplied = next(v for v in rust["domain_vectors"] if v["name"] == d["supplied_by_rust_vectors"])
            check(supplied["domain"] == d["domain"], f"{d['name']}: differs from the Rust/Python domain vector")
        domains[d["name"]] = (d, dom)

    cases = {c["name"]: c for c in golden["cases"]}
    for v in doc["payload_vectors"]:
        name = v["name"]
        d, dom = domains[v["domain_name"]]
        p = payload_from_wire(v["payload"])
        n = len(p["settlement_weights"])
        check(p["seat_count"] == n and len(d["roster_wallets"]) == n, f"{name}: seat count / roster length")
        check(p["domain"] == dom, f"{name}: payload domain is not its domain")
        enc = spec.encode(p)
        check(len(enc) == 136 + 16 * n == v["encoded_len"], f"{name}: length")
        check(enc.hex() == v["encoded"], f"{name}: encoding")
        settle = spec.settle_digest(enc)
        check(settle.hex() == v["settle_digest"], f"{name}: settle digest")
        check(spec.consent_digest(p["domain"], p["seq"], settle).hex() == v["consent_digest"], f"{name}: consent digest")
        # Shape rules (ESCROW-1.5 section 5, SET-0A A1) and the contract's payload rules.
        check(p["version"] == 1 and p["kind"] in (0, 1) and 0 <= p["reason"] <= 5, f"{name}: enums")
        check((p["kind"] == 0) == (p["reason"] == 0), f"{name}: kind/reason coupling")
        check(p["seq"] == 2 * p["log_len"] + p["kind"], f"{name}: seq")
        check(p["appraisal_log_len"] == p["log_len"], f"{name}: A1 (checkpoint and reasons 1, 2, 5)")
        check(2 <= n <= 7 and sum(p["settlement_weights"]) > 0, f"{name}: n / zero sum")
        # Payout arithmetic in unbounded integers.
        pool, s = int(v["pool_ujuno"]), sum(p["settlement_weights"])
        payouts = [pool * w // s for w in p["settlement_weights"]]
        check([str(x) for x in payouts] == v["payouts_ujuno"], f"{name}: payouts")
        check(str(pool - sum(payouts)) == v["dust_ujuno"], f"{name}: dust")
        # The real fields against SET-0A rev 2.
        case = cases.get(v["source_case"])
        if case is not None:
            check(p["appraisal_state_hash"].hex() == case["terminal_state_hash_v1"], f"{name}: appraisal_state_hash")
            check([str(w) for w in p["settlement_weights"]] == case["vector"], f"{name}: settlement_weights")
            check([s["player_id"] for s in v["seat_mapping"]] == case["seat_mapping"], f"{name}: seat mapping")
            check(v["payouts_ujuno"] == case["payouts_ujuno"] and v["dust_ujuno"] == case["dust_ujuno"],
                  f"{name}: golden payouts")
    print(f"OK: {len(doc['domains'])} domains and {len(doc['payload_vectors'])} payloads re-derived by the Python "
          f"encoder; every byte, digest, payout and golden field equal")


if __name__ == "__main__":
    main()
