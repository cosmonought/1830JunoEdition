#!/usr/bin/env python3
# STEP 9 ACME HOTFIX reproduction ONLY: moto 5.2.3 drops three values hashicorp/aws 6.66.0 SENT at the create, so its
# read-back state differs from what AWS returns -- and a refreshed re-plan shows them as changes that real AWS would not:
#   aws_cloudwatch_log_group.host                       log_group_class "" (sent STANDARD) -> a REPLACE
#   aws_instance.host                                   disable_api_termination false (sent true), maintenance_options []
#   aws_vpc_security_group_ingress_rule.https_from_cloudfront  description null (sent; moto drops it on a prefix-list rule)
# This restores EXACTLY those values (what the apply sent, what AWS stores) in the pulled state; nothing else is edited.
# The completion plan is then made with -refresh=false (the mock would drop them again). stdin: state; stdout: state.
import json
import sys

state = json.load(sys.stdin)
FIX = {
    ("aws_cloudwatch_log_group", "host"): {"log_group_class": "STANDARD"},
    ("aws_instance", "host"): {"disable_api_termination": True, "maintenance_options": [{"auto_recovery": "default"}]},
    ("aws_vpc_security_group_ingress_rule", "https_from_cloudfront"): {"description": "HTTPS from CloudFront origin-facing servers only"},
}
done = set()
for r in state["resources"]:
    key = (r["type"], r["name"])
    if r.get("module") == "module.host" and r["mode"] == "managed" and key in FIX:
        for inst in r["instances"]:
            inst["attributes"].update(FIX[key])
        done.add(key)
if done != set(FIX):
    sys.exit(f"moto_gaps: not found in the state: {sorted(set(FIX) - done)}")
state["serial"] += 1
json.dump(state, sys.stdout, indent=2)
