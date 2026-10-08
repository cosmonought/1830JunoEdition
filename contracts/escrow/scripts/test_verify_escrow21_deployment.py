#!/usr/bin/env python3
"""Offline tests of verify_escrow21_deployment.py's JUDGEMENT (no network, no chain: the facts are fixtures).

  python3 -m unittest contracts/escrow/scripts/test_verify_escrow21_deployment.py      (from the repository root)
"""
import copy
import io
import json
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import verify_escrow21_deployment as v  # noqa: E402

FIXTURES = os.path.join(HERE, "fixtures")


def load(name):
    with open(os.path.join(FIXTURES, name), encoding="utf-8") as f:
        return json.load(f)


class Escrow21DeploymentJudgement(unittest.TestCase):
    def setUp(self):
        self.facts = load("escrow21-facts.good.json")
        self.exp = load("escrow21-expect.example.json")

    def problems(self, facts=None, exp=None):
        return v.judge(self.facts if facts is None else facts, self.exp if exp is None else exp)

    def assertFailsWith(self, facts, exp, pattern):
        problems = self.problems(facts, exp)
        self.assertTrue(problems, "expected a FAIL")
        self.assertTrue(any(pattern in p for p in problems), f"no problem mentions {pattern!r}: {problems}")

    def test_the_fixed_constants_are_the_certified_artifact(self):
        self.assertEqual(v.CANONICAL_2_1_0, "c3bd0618615e0d8688f71860a90f235a796b0152be84e2489ce6639e3a218219")
        self.assertEqual((v.CONTRACT_NAME, v.CONTRACT_VERSION), ("crates.io:eighteen-cosmos-escrow", "2.1.0"))
        self.assertNotIn(v.ESCROW_2_0_0, (v.CANONICAL_2_1_0,))

    def test_a_correct_fresh_2_1_deployment_passes(self):
        self.assertEqual(self.problems(), [])
        out = io.StringIO()
        self.assertEqual(v._report(self.facts, self.exp, out), 0)
        self.assertIn("ESCROW 2.1 DEPLOYMENT VERIFY: PASS", out.getvalue())

    def test_the_checksum_is_fixed_never_overridable(self):
        for checksum, why in [(v.ESCROW_2_0_0, "escrow 2.0.0"), (v.HISTORICAL_1_0_0, "1.0.0"), ("11" * 32, "not the certified")]:
            f = copy.deepcopy(self.facts)
            f["checksum"] = checksum
            self.assertFailsWith(f, self.exp, why)
            exp = dict(self.exp, checksum=checksum)  # the expectation file cannot widen it
            self.assertFailsWith(f, exp, "not the certified")

    def test_cw2_must_be_the_escrow_at_2_1_0_in_both_places(self):
        f = copy.deepcopy(self.facts)
        f["cw2"]["version"] = "2.0.0"
        self.assertFailsWith(f, self.exp, "cw2 contract_info")
        f = copy.deepcopy(self.facts)
        f["config"]["contract_version"] = "2.0.0"
        self.assertFailsWith(f, self.exp, "the config query names")
        f = copy.deepcopy(self.facts)
        f["cw2"]["contract"] = "crates.io:other"
        self.assertFailsWith(f, self.exp, "cw2 contract_info")

    def test_every_release_critical_fact_must_be_stated(self):
        for key in v.REQUIRED:
            exp = dict(self.exp)
            del exp[key]
            self.assertFailsWith(self.facts, exp, f"does not state {key}")

    def test_operator_admin_and_wasm_admin(self):
        exp = dict(self.exp, operator="juno1qyqszqgpqyqszqgpqyqszqgpqyqszqgpjnp7du")
        self.assertFailsWith(self.facts, exp, "config.operator")
        f = copy.deepcopy(self.facts)
        f["wasm_admin"] = "juno1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqnrql8a"
        self.assertFailsWith(f, self.exp, "wasm_admin")
        f = copy.deepcopy(self.facts)
        f["config"]["config"]["admin"] = "juno1qyqszqgpqyqszqgpqyqszqgpqyqszqgpjnp7du"
        self.assertFailsWith(f, self.exp, "config.admin")

    def test_signer_registry_and_admission_key(self):
        f = copy.deepcopy(self.facts)
        f["signer_keys"].append({"key_id": 2, "pubkey": "02" + "aa" * 32, "added_at": "1", "retired_at": None, "compromised": False})
        self.assertFailsWith(f, self.exp, "active signer keys")
        f = copy.deepcopy(self.facts)
        f["signer_keys"].append({"key_id": 2, "pubkey": "02" + "aa" * 32, "added_at": "1", "retired_at": "2", "compromised": False})
        self.assertFailsWith(f, self.exp, "the signer registry holds 2 keys")
        f = copy.deepcopy(self.facts)
        f["config"]["config"]["admission_pubkey"] = "02" + "bb" * 32
        self.assertFailsWith(f, self.exp, "config.admission_pubkey")

    def test_the_remedy_registry_is_exactly_the_configured_key(self):
        f = copy.deepcopy(self.facts)
        f["remedy_keys"] = []
        self.assertFailsWith(f, self.exp, "active REMEDY keys")
        f = copy.deepcopy(self.facts)
        f["remedy_keys"].append({"key_id": 2, "pubkey": "02" + "cc" * 32, "added_at": "1", "retired_at": None, "compromised": False})
        self.assertFailsWith(f, self.exp, "a foreign active remedy key can end games")
        f = copy.deepcopy(self.facts)
        f["remedy_keys"][0]["retired_at"] = "1760000000000000001"
        self.assertFailsWith(f, self.exp, "active REMEDY keys")
        f = copy.deepcopy(self.facts)
        f["remedy_keys"][0]["compromised"] = True
        self.assertFailsWith(f, self.exp, "active REMEDY keys")
        f = copy.deepcopy(self.facts)
        f["remedy_keys"].append({"key_id": 2, "pubkey": "02" + "cc" * 32, "added_at": "1", "retired_at": "2", "compromised": True})
        self.assertFailsWith(f, self.exp, "the REMEDY registry holds 2 keys")
        self.assertFailsWith(self.facts, dict(self.exp, remedy_keys=[]), "states no remedy key")
        f = copy.deepcopy(self.facts)
        f["config"]["next_remedy_key_id"] = 3
        self.assertFailsWith(f, self.exp, "next_remedy_key_id")

    def test_the_remedy_key_is_never_the_settlement_or_admission_key(self):
        settlement = self.facts["signer_keys"][0]["pubkey"]
        f = copy.deepcopy(self.facts)
        f["remedy_keys"][0]["pubkey"] = settlement
        exp = dict(self.exp, remedy_keys=[{"key_id": 1, "pubkey": settlement}])
        self.assertFailsWith(f, exp, "must be its own key")
        admission = self.facts["config"]["config"]["admission_pubkey"]
        f = copy.deepcopy(self.facts)
        f["remedy_keys"][0]["pubkey"] = admission
        self.assertFailsWith(f, dict(self.exp, remedy_keys=[{"key_id": 1, "pubkey": admission}]), "must be its own key")

    def test_the_fresh_initial_state(self):
        f = copy.deepcopy(self.facts)
        f["config"]["config"]["paused"] = True
        self.assertFailsWith(f, self.exp, "config.paused")
        f = copy.deepcopy(self.facts)
        f["balances"] = [{"denom": "ujunox", "amount": "1"}]
        self.assertFailsWith(f, self.exp, "expected an empty balance")
        f = copy.deepcopy(self.facts)
        f["games"] = [{"chain_game_id": 1}]
        self.assertFailsWith(f, self.exp, "expected none")
        f = copy.deepcopy(self.facts)
        f["history"].append({"operation": 2, "code_id": 4243, "msg": {}})
        self.assertFailsWith(f, self.exp, "contract history has 2 entries")
        f = copy.deepcopy(self.facts)
        f["config"]["next_chain_game_id"] = 2
        self.assertFailsWith(f, self.exp, "next_chain_game_id")
        f = copy.deepcopy(self.facts)
        f["config"]["config"]["paused"] = True
        self.assertFailsWith(f, self.exp, "a fresh instantiate")

    def test_the_expectation_file_cannot_loosen_the_fresh_state(self):
        """Review MEDIUM: paused / balance / games / history / next ids stated in the file could make a used contract PASS."""
        used = copy.deepcopy(self.facts)
        used["config"]["config"]["paused"] = True
        used["balances"] = [{"denom": "ujunox", "amount": "5"}]
        used["games"] = [{"chain_game_id": 1}]
        used["history"].append({"operation": 2, "code_id": 4243, "msg": {}})
        loose = dict(self.exp, paused=True, balance_empty=False, games_empty=False, history_len=2)
        problems = self.problems(used, loose)
        self.assertTrue(any("the fresh-instantiate state is fixed" in p for p in problems), problems)
        self.assertTrue(any("expected an empty balance" in p for p in problems), problems)
        self.assertTrue(any("contract history has 2 entries" in p for p in problems), problems)
        # Only the explicit flag takes them from the file -- and the report says so.
        self.assertEqual(v.judge(used, loose, allow_not_fresh=True), [])
        out = io.StringIO()
        self.assertEqual(v._report(used, loose, out, allow_not_fresh=True), 0)
        self.assertIn("WARNING: --allow-not-fresh", out.getvalue())

    def test_facts_missing_the_state_fail(self):
        for key in ("balances", "games", "history", "remedy_keys"):
            f = copy.deepcopy(self.facts)
            del f[key]
            self.assertFailsWith(f, self.exp, f"the facts carry no {key}")

    def test_the_instantiate_message_carries_the_same_keys(self):
        f = copy.deepcopy(self.facts)
        f["history"][0]["msg"]["remedy_keys"] = []
        self.assertFailsWith(f, self.exp, "instantiate msg remedy_keys")
        f = copy.deepcopy(self.facts)
        f["history"][0]["msg"]["signer_keys"] = ["02" + "dd" * 32]
        self.assertFailsWith(f, self.exp, "instantiate msg signer_keys")
        f = copy.deepcopy(self.facts)
        f["history"][0]["msg"]["operator"] = "juno1qyqszqgpqyqszqgpqyqszqgpqyqszqgpjnp7du"
        self.assertFailsWith(f, self.exp, "instantiate msg operator")

    def test_the_rpc_must_be_the_expected_current_chain(self):
        f = copy.deepcopy(self.facts)
        f["rpc"]["chain_id"] = "juno-1"
        self.assertFailsWith(f, self.exp, "the RPC is on")
        f = copy.deepcopy(self.facts)
        f["rpc"]["catching_up"] = True
        self.assertFailsWith(f, self.exp, "catching up")

    def test_the_judge_command_reads_saved_facts_only(self):
        self.assertEqual(v.main(["judge", "--facts", os.path.join(FIXTURES, "escrow21-facts.good.json"), "--expect", os.path.join(FIXTURES, "escrow21-expect.example.json")]), 0)

    def test_the_judgement_never_touches_the_network(self):
        def refuse(*_args, **_kwargs):
            raise AssertionError("the judgement must not run curl")
        saved = v.subprocess.run
        v.subprocess.run = refuse
        try:
            self.assertEqual(self.problems(), [])
        finally:
            v.subprocess.run = saved


if __name__ == "__main__":
    unittest.main()
