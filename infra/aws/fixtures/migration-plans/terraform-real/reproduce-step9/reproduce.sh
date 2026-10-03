#!/usr/bin/env bash
# STEP 9 ACME HOTFIX reproduction ONLY: the interrupted step 9 (17 of 18 reviewed resources created; the ACME HTTP-01
# rule refused for its description) and the corrected one-create completion plan -- against LOCAL mocks, never AWS.
#
#   reproduce.sh <scratch dir> <repo> <terraform binary> <pre-fix commit> <fixed commit>
#
# Needs: moto_server (moto 5.2.3) on 127.0.0.1:5000 and fake_cw_budgets.py on 127.0.0.1:5001 (CloudWatch + Budgets,
# which moto cannot serve to hashicorp/aws 6.66.0), both freshly started. Writes <scratch>/host-create-complete.json.
set -euo pipefail
S="$1"; REPO="$2"; TF="$3"; PRE="$4"; FIXED="$5"
HERE="$(cd "$(dirname "$0")" && pwd)"
rm -rf "$S/infra" && mkdir -p "$S"
git -C "$REPO" archive "$PRE" infra/aws | tar -x -C "$S" && mv "$S/infra/aws" "$S/infra.tmp" && rm -rf "$S/infra" && mv "$S/infra.tmp" "$S/infra"
ROOT="$S/infra/stacks/single-host"
cp "$HERE/provider_override.tf.example" "$ROOT/override.tf"

read -r VPC SUBNET AMI < <(python3 - <<'EOF'
import boto3
ec2 = boto3.client("ec2", endpoint_url="http://127.0.0.1:5000", region_name="us-east-1", aws_access_key_id="test", aws_secret_access_key="test")
vpc = ec2.create_vpc(CidrBlock="10.0.0.0/16")["Vpc"]["VpcId"]
subnet = ec2.create_subnet(VpcId=vpc, CidrBlock="10.0.1.0/24")["Subnet"]["SubnetId"]
ami = sorted(i["ImageId"] for i in ec2.describe_images(Owners=["amazon"])["Images"] if i.get("Architecture") == "arm64" and i["Name"].startswith("al2023-"))[0]
print(vpc, subnet, ami)
EOF
)
sed -e "s/@VPC@/$VPC/" -e "s/@SUBNET@/$SUBNET/" -e "s/@AMI@/$AMI/" "$HERE/staging.tfvars.example" > "$ROOT/staging.tfvars"
cd "$ROOT"
"$TF" init -input=false -no-color >/dev/null

# 1. THE INTERRUPTED APPLY, from the PRE-FIX module: every reviewed resource but the ACME rule (whose create AWS refused:
#    the apostrophe in "Let's Encrypt"). Terraform records a failed create as nothing, so the state holds the other 17.
T=()
for a in aws_instance.host aws_network_interface.host aws_eip.host aws_eip_association.host aws_security_group.host \
  aws_vpc_security_group_ingress_rule.https_from_cloudfront 'aws_vpc_security_group_egress_rule.https["443"]' \
  aws_iam_role.host aws_iam_instance_profile.host aws_iam_role_policy.host aws_cloudwatch_log_group.host \
  aws_cloudwatch_metric_alarm.health aws_cloudwatch_metric_alarm.critical aws_cloudwatch_metric_alarm.status_check \
  aws_cloudwatch_metric_alarm.pressure aws_cloudwatch_metric_alarm.cpu_credits 'aws_budgets_budget.monthly[0]'; do
  T+=("-target=module.host.$a")
done
"$TF" apply -input=false -no-color -auto-approve -var-file=staging.tfvars "${T[@]}" >/dev/null
test "$("$TF" state list | grep -vc '\.data\.')" = 17

# 2. moto's three dropped values restored in the state (moto_gaps.py: what the apply sent and AWS stores; nothing else).
"$TF" state pull | python3 "$HERE/moto_gaps.py" > restored.tfstate
"$TF" state push restored.tfstate

# 3. THE FIX: only network.tf's description changes; then the completion plan, UNTARGETED (the whole stack), without a
#    refresh (the mock would drop the three values again; the data sources are still read at plan time).
git -C "$REPO" show "$FIXED:infra/aws/modules/single-host/network.tf" > "$S/infra/modules/single-host/network.tf"
set +e
"$TF" plan -input=false -no-color -detailed-exitcode -refresh=false -var-file=staging.tfvars -out=stack.tfplan >/dev/null
code=$?
set -e
test "$code" = 2
# As the other terraform-real fixtures: the provider's `expressions` (the mock's endpoints, dummy credentials) removed.
"$TF" show -json stack.tfplan | python3 -c 'import json,sys; p=json.load(sys.stdin); [v.pop("expressions", None) for v in p["configuration"]["provider_config"].values()]; print(json.dumps(p, separators=(",", ":")))' > "$S/host-create-complete.json"
echo "VPC=$VPC SUBNET=$SUBNET AMI=$AMI -> $S/host-create-complete.json"
