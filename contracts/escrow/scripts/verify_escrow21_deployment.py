#!/usr/bin/env python3
"""Escrow 2.1.0 read-only deployment verifier (Phase 3 release readiness; supersedes JX-1B's jx1b_verify.py for 2.1).

READS ONLY; SIGNS NOTHING; HOLDS NO KEY. Python 3 standard library only. The network part (`facts_of`) talks to a Juno
CometBFT RPC with curl (JSON-RPC `abci_query`, `status`); the JUDGEMENT (`judge`) is a pure function of two JSON
documents, so it is tested offline (`test_verify_escrow21_deployment.py`) and can re-judge a saved snapshot.

  verify    a 2.1 contract against an expectation file; exit 0 only when EVERY fact holds (the release's step 7)
              python3 verify_escrow21_deployment.py verify --contract <juno1...> --expect escrow21-expect.json --rpc URL
  judge     the same judgement over a SAVED facts file (no network): exit 0 only on PASS
              python3 verify_escrow21_deployment.py judge --facts facts.json --expect escrow21-expect.json
  snapshot  a contract's full read-only state as canonical JSON
              python3 verify_escrow21_deployment.py snapshot --contract <juno1...> --out facts.json --rpc URL
  same      two snapshots name the same contract state (heights ignored); exit 0 only when identical
              python3 verify_escrow21_deployment.py same before.json after.json

WHAT IS FIXED (never taken from the expectation file, never overridable):
  - the code checksum is the CERTIFIED escrow 2.1.0 artifact (c3bd0618...8219, 641,842 B, from e2a67c3); escrow 2.0.0's
    (5ecc3022...09e8, the JX-1 deployment) and the historical 1.0.0 (b263277a...9296) are refused by name;
  - cw2 (raw `contract_info` AND the config query's contract_name / contract_version) is
    crates.io:eighteen-cosmos-escrow 2.1.0.

WHAT THE EXPECTATION FILE MUST STATE (a missing key FAILS -- an unstated fact is never assumed):
  chain_id, code_id, wasm_admin (null for --no-admin), admin, operator, resolver, treasury, denom, admission_pubkey,
  signer_keys [{key_id, pubkey}], remedy_keys [{key_id, pubkey}].
THE FRESH-INSTANTIATE STATE IS FIXED (the release's step 7 verifies a NEW contract): not paused, an empty balance, no game,
  exactly one history entry (the instantiate), next_chain_game_id 1, next_signer_key_id = len(signer_keys) + 1,
  next_remedy_key_id = len(remedy_keys) + 1. The expectation file CANNOT loosen any of these; the facts must carry them
  (a facts file without `balances`, `games` or `history` FAILS). Only the explicit flag `--allow-not-fresh` (a later
  re-verification of a contract already in use) takes them from the expectation file instead, and it says so loudly.
OPTIONAL: params ({...}: exact when stated), label, creator.
The ACTIVE signer and remedy registries must be EXACTLY the stated keys, and nothing retired or compromised may sit beside
them on a fresh contract (the registry length must equal the stated count). The remedy key must be its OWN key (never the
settlement or admission key). The instantiate message (history[0]) must carry the same admin / operator / resolver /
treasury / denom / admission key / signer keys / remedy keys.
"""
import argparse
import base64
import json
import subprocess
import sys

CANONICAL_2_1_0 = "c3bd0618615e0d8688f71860a90f235a796b0152be84e2489ce6639e3a218219"
ESCROW_2_0_0 = "5ecc302221a2dab4bb4f0f71b632f2beeafe9523ebd7b33bd0e94d017b8d09e8"
HISTORICAL_1_0_0 = "b263277aa5d1d63c33e8e238f27ad2b9ee4749c9a66abe82ef3146d51d119296"
CONTRACT_NAME = "crates.io:eighteen-cosmos-escrow"
CONTRACT_VERSION = "2.1.0"
REQUIRED = ("chain_id", "code_id", "wasm_admin", "admin", "operator", "resolver", "treasury", "denom", "admission_pubkey", "signer_keys", "remedy_keys")
REGISTRY_PAGE = 30


# ---------------------------------------------------------------------------------------------------------------------
# The judgement (PURE: no network, no file, no clock)
# ---------------------------------------------------------------------------------------------------------------------

def _active(keys):
    return [{"key_id": k["key_id"], "pubkey": k["pubkey"]} for k in keys if k.get("retired_at") is None and not k.get("compromised")]


FRESH_KEYS = ("paused", "balance_empty", "games_empty", "history_len", "next_chain_game_id", "next_signer_key_id", "next_remedy_key_id")


def judge(facts, exp, allow_not_fresh=False):
    """Every problem with `facts` (a `facts_of` snapshot) against `exp` (the expectation file). [] = PASS.

    Without `allow_not_fresh` the fresh-instantiate state is FIXED: the expectation file's fresh keys are refused, never
    honoured (review MEDIUM: they could otherwise loosen the check)."""
    problems = []
    if not allow_not_fresh:
        loosened = [k for k in FRESH_KEYS if k in exp]
        exp = {k: v for k, v in exp.items() if k not in FRESH_KEYS}
        for k in loosened:
            problems.append(f"the expectation file states {k}: the fresh-instantiate state is fixed (use --allow-not-fresh only to re-verify a contract already in use)")
    for key in ("balances", "games", "history", "config", "signer_keys", "remedy_keys"):
        if key not in facts:
            problems.append(f"the facts carry no {key}: never assumed")
    for key in REQUIRED:
        if key not in exp:
            problems.append(f"the expectation file does not state {key} (an unstated fact is never assumed)")
    rpc = facts.get("rpc", {})
    if rpc.get("chain_id") != exp.get("chain_id"):
        problems.append(f"the RPC is on {rpc.get('chain_id')!r}, expected {exp.get('chain_id')!r}")
    if rpc.get("catching_up") is not False:
        problems.append("the RPC node is catching up (or did not say): its answers are not current")

    checksum = facts.get("checksum")
    if checksum == HISTORICAL_1_0_0:
        problems.append("the contract runs the historical escrow 1.0.0 artifact (its Join seats any payer): refused for money")
    elif checksum == ESCROW_2_0_0:
        problems.append("the contract runs escrow 2.0.0 (5ecc3022...09e8, the JX-1 artifact): not the 2.1 release")
    if checksum != CANONICAL_2_1_0:
        problems.append(f"checksum {checksum} is not the certified escrow 2.1.0 artifact {CANONICAL_2_1_0}")
    if "checksum" in exp and exp["checksum"] != CANONICAL_2_1_0:
        problems.append(f"the expectation file names checksum {exp['checksum']}: only the certified 2.1.0 artifact is accepted")

    expected_cw2 = {"contract": CONTRACT_NAME, "version": CONTRACT_VERSION}
    if facts.get("cw2") != expected_cw2:
        problems.append(f"cw2 contract_info is {facts.get('cw2')!r}, expected {expected_cw2!r}")
    config_response = facts.get("config") or {}
    if (config_response.get("contract_name"), config_response.get("contract_version")) != (CONTRACT_NAME, CONTRACT_VERSION):
        problems.append(f"the config query names {config_response.get('contract_name')!r} {config_response.get('contract_version')!r}, expected {CONTRACT_NAME} {CONTRACT_VERSION}")

    def want(name, actual, key, default=None, has_default=False):
        if key in exp:
            if actual != exp[key]:
                problems.append(f"{name}: chain has {actual!r}, expected {exp[key]!r}")
        elif has_default and actual != default:
            problems.append(f"{name}: chain has {actual!r}, expected {default!r} (a fresh instantiate)")

    want("code_id", facts.get("code_id"), "code_id")
    if "wasm_admin" in exp:
        want("wasm_admin", facts.get("wasm_admin"), "wasm_admin")
    want("label", facts.get("label"), "label")
    want("creator", facts.get("creator"), "creator")

    config = config_response.get("config") or {}
    for key in ("admin", "operator", "resolver", "treasury", "denom", "admission_pubkey"):
        want(f"config.{key}", config.get(key), key)
    want("config.params", config.get("params"), "params")
    want("config.paused", config.get("paused"), "paused", False, True)

    signer_keys = facts.get("signer_keys") or []
    remedy_keys = facts.get("remedy_keys") or []
    exp_signers = exp.get("signer_keys", [])
    exp_remedies = exp.get("remedy_keys", [])
    want("next_chain_game_id", config_response.get("next_chain_game_id"), "next_chain_game_id", 1, True)
    want("next_signer_key_id", config_response.get("next_signer_key_id"), "next_signer_key_id", len(exp_signers) + 1, True)
    want("next_remedy_key_id", config_response.get("next_remedy_key_id"), "next_remedy_key_id", len(exp_remedies) + 1, True)

    if "signer_keys" in exp:
        if _active(signer_keys) != exp_signers:
            problems.append(f"active signer keys: chain has {_active(signer_keys)!r}, expected {exp_signers!r}")
        if len(signer_keys) != len(exp_signers):
            problems.append(f"the signer registry holds {len(signer_keys)} keys (retired / compromised included), expected exactly {len(exp_signers)}")
    if "remedy_keys" in exp:
        if not exp_remedies:
            problems.append("the expectation file states no remedy key: a 2.1 release that runs timed money needs its dedicated REMEDY key (an empty list is refused here)")
        if _active(remedy_keys) != exp_remedies:
            problems.append(f"active REMEDY keys: chain has {_active(remedy_keys)!r}, expected exactly {exp_remedies!r} (a foreign active remedy key can end games)")
        if len(remedy_keys) != len(exp_remedies):
            problems.append(f"the REMEDY registry holds {len(remedy_keys)} keys (retired / compromised included), expected exactly {len(exp_remedies)}")
    others = {k["pubkey"] for k in signer_keys} | ({config.get("admission_pubkey")} if config.get("admission_pubkey") else set())
    for key in remedy_keys:
        if key.get("pubkey") in others:
            problems.append(f"remedy key {key.get('key_id')} is the settlement or admission key: the REMEDY authority must be its own key")

    if exp.get("balance_empty", True) is True and facts.get("balances"):
        problems.append(f"the contract holds {facts.get('balances')!r}; expected an empty balance")
    if exp.get("games_empty", True) is True and facts.get("games"):
        problems.append(f"the contract already has {len(facts.get('games'))} game(s); expected none (a fresh instantiate)")
    history = facts.get("history") or []
    history_len = exp.get("history_len", 1)
    if len(history) != history_len:
        problems.append(f"contract history has {len(history)} entries, expected {history_len} (a migrate or a second instantiate?)")
    if history and history[0].get("msg") is not None:
        init = history[0]["msg"]
        for key in ("admin", "operator", "resolver", "treasury", "denom", "admission_pubkey", "params"):
            if key in exp and init.get(key) != exp[key]:
                problems.append(f"instantiate msg {key}: {init.get(key)!r}, expected {exp[key]!r}")
        if "signer_keys" in exp and init.get("signer_keys") != [k["pubkey"] for k in exp_signers]:
            problems.append(f"instantiate msg signer_keys: {init.get('signer_keys')!r}, expected {[k['pubkey'] for k in exp_signers]!r}")
        if "remedy_keys" in exp and init.get("remedy_keys") != [k["pubkey"] for k in exp_remedies]:
            problems.append(f"instantiate msg remedy_keys: {init.get('remedy_keys')!r}, expected {[k['pubkey'] for k in exp_remedies]!r}")
    elif history:
        problems.append("the instantiate message is not readable from the contract history")
    return problems


# ---------------------------------------------------------------------------------------------------------------------
# The network part (read-only queries; never called by the tests)
# ---------------------------------------------------------------------------------------------------------------------

def _varint(n):
    out = b""
    while True:
        x = n & 0x7F
        n >>= 7
        if n:
            out += bytes([x | 0x80])
        else:
            return out + bytes([x])


def _field(tag, data):
    return bytes([tag]) + _varint(len(data)) + data


def _parse(buf):
    out, i = [], 0
    while i < len(buf):
        key = buf[i]
        i += 1
        num, wire = key >> 3, key & 7
        if wire == 0:
            v = s = 0
            while True:
                b = buf[i]
                i += 1
                v |= (b & 0x7F) << s
                s += 7
                if b < 0x80:
                    break
            out.append((num, v))
        elif wire == 2:
            n = s = 0
            while True:
                b = buf[i]
                i += 1
                n |= (b & 0x7F) << s
                s += 7
                if b < 0x80:
                    break
            out.append((num, buf[i:i + n]))
            i += n
        else:
            raise ValueError(f"unexpected wire type {wire}")
    return out


def _curl(args):
    return subprocess.run(["curl", "-sS", "-m", "30"] + args, capture_output=True, text=True, check=True).stdout


def _abci(rpc, path, data):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "abci_query", "params": {"path": path, "data": data.hex(), "prove": False}})
    resp = json.loads(_curl(["-H", "content-type: application/json", "-d", body, rpc]))["result"]["response"]
    if resp["code"] != 0:
        raise RuntimeError(f"{path}: code {resp['code']} {resp['log']}")
    return base64.b64decode(resp["value"] or ""), int(resp["height"])


def _smart(rpc, addr, query):
    raw, _ = _abci(rpc, "/cosmwasm.wasm.v1.Query/SmartContractState", _field(0x0A, addr) + _field(0x12, json.dumps(query).encode()))
    return json.loads(dict(_parse(raw))[1])


def _pages(rpc, addr, name):
    keys, after = [], None
    for _ in range(8):  # each registry holds at most 64 keys
        batch = _smart(rpc, addr, {name: {"start_after": after, "limit": REGISTRY_PAGE}})["keys"]
        keys += batch
        if len(batch) < REGISTRY_PAGE:
            break
        after = batch[-1]["key_id"]
    return keys


def _balances(rpc, address):
    raw, _ = _abci(rpc, "/cosmos.bank.v1beta1.Query/AllBalances", _field(0x0A, address.encode()))
    out = []
    for n, c in _parse(raw):
        if n == 1:
            coin = {k: v.decode() for k, v in _parse(c)}
            out.append({"denom": coin.get(1, ""), "amount": coin.get(2, "0")})
    return sorted(out, key=lambda b: b["denom"])


def _status(rpc):
    st = json.loads(_curl([rpc.rstrip("/") + "/status"]))["result"]
    return {"chain_id": st["node_info"]["network"], "height": int(st["sync_info"]["latest_block_height"]), "catching_up": st["sync_info"]["catching_up"]}


def facts_of(rpc, contract):
    addr = contract.encode()
    facts = {"rpc": _status(rpc), "contract": contract}
    raw, _ = _abci(rpc, "/cosmwasm.wasm.v1.Query/ContractInfo", _field(0x0A, addr))
    info = dict(_parse(dict(_parse(raw))[2]))
    facts["code_id"] = info.get(1)
    facts["creator"] = info.get(2, b"").decode()
    facts["wasm_admin"] = info[3].decode() if info.get(3) else None
    facts["label"] = info.get(4, b"").decode()
    raw, _ = _abci(rpc, "/cosmwasm.wasm.v1.Query/CodeInfo", bytes([0x08]) + _varint(facts["code_id"]))
    facts["checksum"] = dict(_parse(raw))[3].hex()
    raw, _ = _abci(rpc, "/cosmwasm.wasm.v1.Query/RawContractState", _field(0x0A, addr) + _field(0x12, b"contract_info"))
    facts["cw2"] = json.loads(dict(_parse(raw))[1])
    raw, _ = _abci(rpc, "/cosmwasm.wasm.v1.Query/ContractHistory", _field(0x0A, addr))
    history = []
    for n, entry in _parse(raw):
        if n != 1:
            continue
        e = dict(_parse(entry))
        history.append({"operation": e.get(1), "code_id": e.get(2), "msg": json.loads(e[4]) if e.get(4) else None})
    facts["history"] = history
    facts["config"] = _smart(rpc, addr, {"config": {}})
    facts["signer_keys"] = _pages(rpc, addr, "signer_keys")
    facts["remedy_keys"] = _pages(rpc, addr, "remedy_keys")
    games, after = [], None
    for _ in range(100):
        batch = _smart(rpc, addr, {"games": {"start_after": after, "limit": REGISTRY_PAGE}})["games"]
        games += batch
        if len(batch) < REGISTRY_PAGE:
            break
        last = batch[-1]
        after = last["game"]["chain_game_id"] if "game" in last else last["chain_game_id"]
    facts["games"] = games
    facts["balances"] = _balances(rpc, contract)
    return facts


# ---------------------------------------------------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------------------------------------------------

def _report(facts, exp, out=sys.stdout, allow_not_fresh=False):
    if allow_not_fresh:
        print("WARNING: --allow-not-fresh -- the fresh-instantiate state (paused, balance, games, history, next ids) is taken from the expectation file; this is NOT the release's new-contract verification", file=out)
    problems = judge(facts, exp, allow_not_fresh)
    if problems:
        print("ESCROW 2.1 DEPLOYMENT VERIFY: FAIL", file=out)
        for p in problems:
            print(" -", p, file=out)
        return 1
    print(f"ESCROW 2.1 DEPLOYMENT VERIFY: PASS at height {facts.get('rpc', {}).get('height')} (checksum {CANONICAL_2_1_0}, cw2 {CONTRACT_NAME} {CONTRACT_VERSION}, {len(exp['remedy_keys'])} remedy key(s))", file=out)
    return 0


def _load(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def main(argv=None):
    ap = argparse.ArgumentParser(description="Escrow 2.1.0 read-only deployment verifier (signs nothing)")
    sub = ap.add_subparsers(dest="cmd", required=True)
    v = sub.add_parser("verify")
    v.add_argument("--contract", required=True)
    v.add_argument("--expect", required=True)
    v.add_argument("--rpc", required=True)
    v.add_argument("--allow-not-fresh", action="store_true")
    j = sub.add_parser("judge")
    j.add_argument("--facts", required=True)
    j.add_argument("--expect", required=True)
    j.add_argument("--allow-not-fresh", action="store_true")
    s = sub.add_parser("snapshot")
    s.add_argument("--contract", required=True)
    s.add_argument("--out", required=True)
    s.add_argument("--rpc", required=True)
    m = sub.add_parser("same")
    m.add_argument("before")
    m.add_argument("after")
    a = ap.parse_args(argv)
    if a.cmd == "verify":
        facts = facts_of(a.rpc, a.contract)
        print(json.dumps(facts, indent=1, sort_keys=True))
        return _report(facts, _load(a.expect), allow_not_fresh=a.allow_not_fresh)
    if a.cmd == "judge":
        return _report(_load(a.facts), _load(a.expect), allow_not_fresh=a.allow_not_fresh)
    if a.cmd == "snapshot":
        facts = facts_of(a.rpc, a.contract)
        with open(a.out, "w", encoding="utf-8") as out:
            json.dump(facts, out, indent=1, sort_keys=True)
        print(f"snapshot of {a.contract} at height {facts['rpc']['height']} written to {a.out}")
        return 0
    x, y = _load(a.before), _load(a.after)
    x.pop("rpc", None)
    y.pop("rpc", None)
    if x == y:
        print("SAME: code, admin, label, history, config, signer and remedy keys, games and balance are unchanged")
        return 0
    print("CHANGED:")
    for k in sorted(set(x) | set(y)):
        if x.get(k) != y.get(k):
            print(f" - {k}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
