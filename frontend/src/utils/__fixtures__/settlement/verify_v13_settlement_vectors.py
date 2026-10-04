#!/usr/bin/env python3
"""Phase 3 (rules v13 settlement certification): re-derive settlementV13CertificationVectors.json independently.

The TypeScript certification (frontend/src/utils/settlementV13Certification.test.ts) wrote the v13 evidence from the
v13 engine's terminal boards and the certified TypeScript primitives. This script shares NO code with the TypeScript:

  * an INDEPENDENT APPRAISAL, written here from SET-0A rev 2 section 4 and rulebook 6.6.3, over each terminal board's
    canonical text (settlementV13TerminalBoards.json) -- the pin (13 only), the roster, conservation of 100%, every
    parred corporation's chart price, the bankrupt president (shares only: cash and privates count 0), open privates at
    printed face -- compared seat by seat, component by component, with the pinned evidence;
  * the canonical form and the commitment: each board text is re-canonicalised here (sorted keys, no whitespace) and
    must be byte-identical, and SHA-256("18JUNO/STATE/v1\\n" || text) must be the pinned appraisal_state_hash;
  * the escrow crate's independent Python encoder (contracts/escrow/testdata/gen_payload_vectors.py, the generator the
    Rust contract's tests reproduce byte for byte) for every roster hash, domain (rules engine 13, and the recorded v10 /
    v11 / v12 domains at 10 / 11 / 12), payload byte, SETTLE and CONSENT digest;
  * floor(pool * w_i / sum) payouts and dust in Python's unbounded integers, on every pinned pool;
  * the fifteen SET-0C payloads at v13: weights, payouts and dust equal SET-0A rev 2's, and the bytes equal the frozen
    v10 bytes outside [1,33) (domain) and [91,123) (appraisal_state_hash).

    pip install ecdsa                          # gen_payload_vectors imports python-ecdsa
    python3 verify_v13_settlement_vectors.py   # exits 0 and prints a summary, or exits 1 naming the first mismatch
"""

import hashlib
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.normpath(os.path.join(HERE, "..", "..", "..", "..", ".."))
sys.path.insert(0, os.path.join(REPO, "contracts", "escrow", "testdata"))
sys.dont_write_bytecode = True  # leave no __pycache__ in the escrow crate

import gen_payload_vectors as spec  # noqa: E402  (the escrow crate's independent encoder)

STATE_TAG = b"18JUNO/STATE/v1\n"
DOMAIN_RANGE = range(1, 33)
HASH_RANGE = range(91, 123)


def fail(message):
    print(f"MISMATCH: {message}")
    sys.exit(1)


def check(cond, message):
    if not cond:
        fail(message)


def load(name):
    with open(os.path.join(HERE, name), encoding="utf-8") as handle:
        return json.load(handle)


def canonical(value):
    """The canonical text: sorted keys, no whitespace, integers as written, strings JSON-escaped."""
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        check(value.is_integer(), f"a non-integer number {value} on a board")
        return str(int(value))
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, list):
        return "[" + ",".join(canonical(entry) for entry in value) + "]"
    if isinstance(value, dict):
        return "{" + ",".join(json.dumps(key, ensure_ascii=False) + ":" + canonical(value[key]) for key in sorted(value)) + "}"
    fail(f"an unserialisable value {value!r}")


def amount(text, where):
    check(isinstance(text, str) and text.isdigit() and (text == "0" or not text.startswith("0")), f"{where}: amount {text!r}")
    return int(text)


def appraise(board, seat_ids, where):
    """NW(p) = cash + sum(pct / 10 * price) + sum(face of open privates owned); the bankrupt president: shares only."""
    check(board.get("rules_engine_version") == 13, f"{where}: pin {board.get('rules_engine_version')!r} is not 13")
    roster = board["player_addresses"]
    check(sorted(roster) == sorted(seat_ids) and len(set(roster)) == len(roster), f"{where}: roster != seats")
    check(2 <= len(seat_ids) <= 7, f"{where}: seat count")
    bankrupt = board.get("bankrupt_president")
    if bankrupt is not None:
        check(bankrupt in roster and board.get("current_round_type") == "GameEnd", f"{where}: bankrupt president outside GameEnd")
    cash = {}
    for row in board["player_cash"]:
        check(row["player"] in roster and row["player"] not in cash, f"{where}: cash row {row['player']}")
        cash[row["player"]] = amount(row["cash_vgp"], f"{where} cash")
    check(set(cash) == set(roster), f"{where}: a missing cash row")
    marks = board.get("market_positions") or {}
    shares = {player: 0 for player in roster}
    lines = {player: [] for player in roster}
    for company in board["public_companies"]:
        held = 0
        parred = company.get("par_value") is not None
        mark = marks.get(str(company["company_id"]))
        if parred:
            check(isinstance(mark, dict) and isinstance(mark.get("price"), int) and mark["price"] > 0, f"{where}: {company['ticker']} has no positive mark")
            price = mark["price"]
        else:
            check(mark is None, f"{where}: unparred {company['ticker']} carries a mark")
            price = 0
        for holding in company["player_holdings"]:
            pct = holding["percentage"]
            check(holding["player"] in roster and isinstance(pct, int) and pct > 0 and pct % 10 == 0, f"{where}: holding {holding}")
            held += pct
            shares[holding["player"]] += (pct // 10) * price
            lines[holding["player"]].append((company["ticker"], pct))
        ipo, pool = company["ipo_pool_percentage"], company["bank_pool_percentage"]
        check(held + ipo + pool == 100, f"{where}: {company['ticker']} {held} + {ipo} + {pool} != 100")
    privates = {player: 0 for player in roster}
    for priv in board["private_companies"]:
        face = amount(priv["cost"], f"{where} private {priv['private_id']}")
        check(face > 0, f"{where}: a zero face")
        check(priv.get("owner") is None or priv.get("owner_protocol_id") is None, f"{where}: a private with two owners")
        if not priv["closed"] and priv.get("owner") in roster and priv["owner"] != bankrupt:
            privates[priv["owner"]] += face
    out = []
    for player in seat_ids:
        is_bankrupt = player == bankrupt
        counted = 0 if is_bankrupt else cash[player]
        p = 0 if is_bankrupt else privates[player]
        out.append({
            "player_id": player, "bankrupt": is_bankrupt, "cash_in_state": str(cash[player]), "cash": str(counted),
            "shares": str(shares[player]), "privates": str(p), "total": str(counted + shares[player] + p),
        })
    return out


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


def check_payload(name, p, enc_hex, settle_hex, consent_hex, domain, n):
    check(p["domain"] == domain, f"{name}: payload domain is not its domain")
    check(p["seat_count"] == n == len(p["settlement_weights"]), f"{name}: seat count")
    enc = spec.encode(p)
    check(len(enc) == 136 + 16 * n, f"{name}: length")
    check(enc.hex() == enc_hex, f"{name}: encoding")
    settle = spec.settle_digest(enc)
    check(settle.hex() == settle_hex, f"{name}: settle digest")
    check(spec.consent_digest(p["domain"], p["seq"], settle).hex() == consent_hex, f"{name}: consent digest")
    check(p["version"] == 1 and p["kind"] in (0, 1) and 0 <= p["reason"] <= 5, f"{name}: enums")
    check((p["kind"] == 0) == (p["reason"] == 0), f"{name}: kind/reason coupling")
    check(p["seq"] == 2 * p["log_len"] + p["kind"], f"{name}: seq")
    check(p["appraisal_log_len"] == p["log_len"], f"{name}: A1")
    check(sum(p["settlement_weights"]) > 0, f"{name}: zero sum")
    return enc


def payouts(pool, weights):
    total = sum(weights)
    out = [pool * w // total for w in weights]
    return out, pool - sum(out)


def main():
    doc = load("settlementV13CertificationVectors.json")
    texts = load("settlementV13TerminalBoards.json")
    golden = load("SET0A_golden_vectors_rev2.derived.json")
    v10 = load("settlementPayloadVectorsV1.json")
    check(doc["format"] == "18JUNO/PHASE3/settlement-v13-certification/v1", "format")
    check(doc["rules_engine_version"] == 13, "rules engine")

    domains = {}
    for d in doc["domains"]:
        roster = spec.roster_hash(d["roster_wallets"])
        check(roster.hex() == d["roster_hash"], f"{d['name']}: roster hash")
        def dom(rules):
            return spec.settlement_domain(d["chain_id"], d["contract_addr"], int(d["chain_game_id"]), roster, rules,
                                          bytes.fromhex(d["variants_digest"]), int(d["ante_gross"]), d["mode"])
        check(d["rules_engine_version"] == 13 and dom(13).hex() == d["domain"], f"{d['name']}: v13 domain")
        check(dom(10).hex() == d["v10_domain"] and dom(11).hex() == d["v11_domain"] and dom(12).hex() == d["v12_domain"], f"{d['name']}: v10/v11/v12 domains")
        check(len({d["domain"], d["v10_domain"], d["v11_domain"], d["v12_domain"]}) == 4, f"{d['name']}: domains not distinct")
        domains[d["name"]] = (d, dom(13))

    # The fifteen SET-0C payloads at v13.
    cases = {c["name"]: c for c in golden["cases"]}
    v13_cases = {c["name"]: c for c in doc["cases"]}
    frozen = {v["name"]: v for v in v10["payload_vectors"]}
    for v in doc["payload_vectors"]:
        name = v["name"]
        d, dom = domains[v["domain_name"]]
        p = payload_from_wire(v["payload"])
        n = len(p["settlement_weights"])
        check(len(d["roster_wallets"]) == n, f"{name}: roster length")
        enc = check_payload(name, p, v["encoded"], v["settle_digest"], v["consent_digest"], dom, n)
        old = bytes.fromhex(frozen[name]["encoded"])
        check(len(old) == len(enc), f"{name}: v10 length")
        differ = [i for i in range(len(enc)) if enc[i] != old[i]]
        check(differ and all(i in DOMAIN_RANGE or i in HASH_RANGE for i in differ), f"{name}: bytes differ from v10 outside domain / appraisal hash")
        pay, dust = payouts(int(v["pool_ujuno"]), p["settlement_weights"])
        check([str(x) for x in pay] == v["payouts_ujuno"] and str(dust) == v["dust_ujuno"], f"{name}: payouts")
        case = cases.get(v["source_case"])
        if case is not None:
            check([str(w) for w in p["settlement_weights"]] == case["vector"], f"{name}: weights != SET-0A")
            check(v["payouts_ujuno"] == case["payouts_ujuno"] and v["dust_ujuno"] == case["dust_ujuno"], f"{name}: golden payouts")
            check(p["appraisal_state_hash"].hex() == v13_cases[v["source_case"]]["appraisal_state_hash"], f"{name}: appraisal hash != the v13 case's")

    # The v13 vectors: the independent appraisal over each terminal board.
    boards = texts["boards"]
    reasons = {"BankBroken": 1, "Bankruptcy": 2}
    bankruptcies = 0
    for entry in doc["vectors"]:
        name = entry["name"]
        text = boards[name]
        board = json.loads(text)
        check(canonical(board) == text, f"{name}: the board text is not canonical")
        state_hash = hashlib.sha256(STATE_TAG + text.encode("utf-8")).hexdigest()
        check(state_hash == entry["terminal"]["appraisal_state_hash"], f"{name}: appraisal_state_hash")
        check(board["current_round_type"] == "GameEnd", f"{name}: not GameEnd")
        check(board["variants"].get("rules") == 2, f"{name}: not rules revision 2")
        seat_ids = [s["player_id"] for s in entry["seat_mapping"]]
        check([s["seat_index"] for s in entry["seat_mapping"]] == list(range(len(seat_ids))), f"{name}: seat indices")
        components = appraise(board, seat_ids, name)
        check(components == entry["components"], f"{name}: components {components} != {entry['components']}")
        vector = [c["total"] for c in components]
        check(vector == entry["vector"], f"{name}: vector")
        if entry["reason"] == "Bankruptcy":
            bankruptcies += 1
            check(board.get("bankrupt_president") == "p1", f"{name}: bankrupt president")
            bankrupt = next(c for c in components if c["bankrupt"])
            check(bankrupt["cash"] == "0" and bankrupt["privates"] == "0", f"{name}: the bankrupt's cash / privates counted")
        else:
            check(board.get("bankrupt_president") is None and board.get("bank_broken") is True, f"{name}: bank break")
        d, dom = domains[entry["domain_name"]]
        p = payload_from_wire(entry["payload"])
        check(p["kind"] == 1 and p["reason"] == reasons[entry["reason"]] == entry["reason_code"], f"{name}: reason")
        check(p["log_len"] == entry["log_len"] and p["log_hash"].hex() == entry["log_hash"], f"{name}: log")
        check(p["appraisal_state_hash"].hex() == state_hash, f"{name}: payload appraisal hash")
        check([str(w) for w in p["settlement_weights"]] == vector, f"{name}: weights != the independent appraisal")
        check_payload(name, p, entry["encoded"], entry["settle_digest"], entry["consent_digest"], dom, len(seat_ids))
        for pool_entry in entry["pools"]:
            pay, dust = payouts(int(pool_entry["pool_ujuno"]), p["settlement_weights"])
            check([str(x) for x in pay] == pool_entry["payouts_ujuno"] and str(dust) == pool_entry["dust_ujuno"], f"{name}: payouts at {pool_entry['pool_ujuno']}")
            check(0 <= dust < len(seat_ids) and sum(pay) + dust == int(pool_entry["pool_ujuno"]), f"{name}: payout identity")
        det = entry["determinism"]
        check(len({det["live"], det["restore"], det["replay"], det["snapshot"], det["revert"]["terminal"], det["revert"]["restored"], state_hash}) == 1, f"{name}: determinism digests differ")

    # The v13 checkpoints.
    for entry in doc["checkpoints"]:
        name = entry["name"]
        text = texts["checkpoints"][name]
        board = json.loads(text)
        check(canonical(board) == text, f"{name}: the board text is not canonical")
        state_hash = hashlib.sha256(STATE_TAG + text.encode("utf-8")).hexdigest()
        check(state_hash == entry["appraisal_state_hash"], f"{name}: appraisal_state_hash")
        seat_ids = [s["player_id"] for s in entry["seat_mapping"]]
        vector = [c["total"] for c in appraise(board, seat_ids, name)]
        check(vector == entry["vector"], f"{name}: vector")
        d, dom = domains[entry["domain_name"]]
        p = payload_from_wire(entry["payload"])
        check(p["kind"] == 0 and p["reason"] == 0 and p["appraisal_state_hash"].hex() == state_hash, f"{name}: checkpoint fields")
        check([str(w) for w in p["settlement_weights"]] == vector, f"{name}: weights")
        check_payload(name, p, entry["encoded"], entry["settle_digest"], entry["consent_digest"], dom, len(seat_ids))

    print(f"OK: {len(doc['domains'])} v13 domains, {len(doc['payload_vectors'])} SET-0C payloads at v13, "
          f"{len(doc['vectors'])} v13 terminal vectors ({bankruptcies} bankruptcies) and {len(doc['checkpoints'])} checkpoints "
          f"re-derived independently: every canonical text, state hash, seat component, vector, payout, dust, byte and digest equal")


if __name__ == "__main__":
    main()
