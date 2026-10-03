#!/usr/bin/env python3
# infra/aws/fixtures/migration-plans/terraform-real/reproduce-7a/pre_cost1_state.py
#
# RECON-1 7A HOTFIX -- OFFLINE REPRODUCTION ONLY (a local moto mock; never an AWS account). Turns a Terraform state of
# stacks/app written by THIS branch's module (every COST-1 `count` resource at [0]) into the SHAPE of the accepted staging
# state, which was written BEFORE COST-1:
#   - the thirteen ECS-era singletons of modules/app/moved.tf, and the three ECS-era policy documents COST-1 also gave
#     `count`, at their UNINDEXED addresses (the moves Terraform then finds pending);
#   - the bootstrap and operator policies WITHOUT the six pending read statements (COST-2A's four HostVerifier*, JX-4C's
#     IdentityEvidenceRead / LedgerJournalQuery), in the mock and in the state (and the roles' inline_policy mirror);
#   - both ECS services drained to desired 0 in the mock while the state remembers 1 (the legacy desired-count drift).
# --keep-addresses: the same, but the addresses left at [0] (a state on which COST-1's moves are already done).
#
#   python3 pre_cost1_state.py <post-cost1.tfstate> <out terraform.tfstate> [--keep-addresses]
#
# Needs boto3 and a moto server at http://127.0.0.1:5000 holding the objects the state names (see ../README.md).

import json
import sys

import boto3

KW = dict(endpoint_url="http://127.0.0.1:5000", region_name="us-east-1", aws_access_key_id="test", aws_secret_access_key="test")
SINGLETONS = {
    ("aws_lb", "this"), ("aws_lb_listener", "https"), ("aws_lb_listener_rule", "gs"), ("aws_ecs_cluster", "this"),
    ("aws_iam_role", "execution"), ("aws_iam_role_policy", "execution"), ("aws_iam_role", "task"), ("aws_iam_role_policy", "task"),
    ("aws_security_group", "alb"), ("aws_vpc_security_group_ingress_rule", "alb_from_cloudfront"),
    ("aws_vpc_security_group_egress_rule", "alb_to_tasks"), ("aws_security_group", "task"), ("aws_vpc_security_group_ingress_rule", "task_from_alb"),
}
DATA = {("aws_iam_policy_document", "ecs_tasks_assume"), ("aws_iam_policy_document", "execution"), ("aws_iam_policy_document", "task")}
PENDING = {"bootstrap": ["HostVerifierDescribeUnscopable", "HostVerifierEcsEra", "HostVerifierHostRole", "HostVerifierBudgets"], "operator": ["IdentityEvidenceRead", "LedgerJournalQuery"]}


def main() -> None:
    src, out = sys.argv[1], sys.argv[2]
    keep = "--keep-addresses" in sys.argv
    st = json.load(open(src))
    iam = boto3.client("iam", **KW)
    docs = {}
    for r in st["resources"]:
        key = (r["type"], r["name"])
        if not keep and ((r["mode"] == "managed" and key in SINGLETONS) or (r["mode"] == "data" and key in DATA)):
            assert len(r["instances"]) == 1 and r["instances"][0]["index_key"] == 0, key
            del r["instances"][0]["index_key"]
        if r["mode"] == "managed" and r["type"] == "aws_iam_role_policy" and r["name"] in PENDING:
            a = r["instances"][0]["attributes"]
            doc = json.loads(a["policy"])
            doc["Statement"] = [s for s in doc["Statement"] if s.get("Sid") not in PENDING[r["name"]]]
            a["policy"] = json.dumps(doc, separators=(",", ":"))
            iam.put_role_policy(RoleName=a["role"], PolicyName=a["name"], PolicyDocument=a["policy"])
            docs[(a["role"], a["name"])] = a["policy"]
    for r in st["resources"]:
        if r["mode"] == "managed" and r["type"] == "aws_iam_role" and r["name"] in PENDING:
            for inst in r["instances"]:
                a = inst["attributes"]
                for ip in a.get("inline_policy") or []:
                    if (a["name"], ip["name"]) in docs:
                        got = iam.get_role_policy(RoleName=a["name"], PolicyName=ip["name"])["PolicyDocument"]
                        got = json.loads(got) if isinstance(got, str) else got
                        ip["policy"] = json.dumps(got, separators=(",", ":"), sort_keys=True)
    st["serial"] += 1
    json.dump(st, open(out, "w"), indent=2)
    ecs = boto3.client("ecs", **KW)
    for pool in ("p1", "p2"):
        ecs.update_service(cluster="gs-staging", service=f"gs-staging-{pool}", desiredCount=0)
    print(f"wrote {out} ({'addresses kept at [0]' if keep else 'pre-COST-1 addresses'}); pending grants removed; services drained 0/0")


if __name__ == "__main__":
    main()
