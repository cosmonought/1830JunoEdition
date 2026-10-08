# COST-1: the single-host module -- plan/apply over a MOCKED provider (no AWS account, no credentials).
# Run: cd infra/aws/modules/single-host && terraform init -backend=false && terraform test

mock_provider "aws" {
  mock_data "aws_caller_identity" {
    defaults = { account_id = "111111111111" }
  }
  mock_data "aws_region" {
    defaults = { region = "us-east-1" }
  }
  mock_data "aws_partition" {
    defaults = { partition = "aws" }
  }
  mock_data "aws_ec2_managed_prefix_list" {
    defaults = { id = "pl-3b927c52" }
  }
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::111111111111:role/gs-staging-host-app" }
  }
  mock_resource "aws_iam_role_policy" {
    defaults = { id = "gs-staging-host-app:gs-single-host-runtime" }
  }
  mock_resource "aws_cloudwatch_log_group" {
    defaults = { arn = "arn:aws:logs:us-east-1:111111111111:log-group:/gs/staging/host" }
  }
  mock_resource "aws_eip" {
    defaults = { public_ip = "203.0.113.10", id = "eipalloc-0123456789abcdef0" }
  }
  mock_resource "aws_instance" {
    defaults = { id = "i-0123456789abcdef0" }
  }
}

variables {
  environment      = "staging"
  generation       = 1
  ledger_table_arn = "arn:aws:dynamodb:us-east-1:222222222222:table/gs-staging-ledger"
  signing_keys = {
    relayer    = "arn:aws:kms:us-east-1:222222222222:key/11111111-1111-4111-8111-111111111111"
    settlement = "arn:aws:kms:us-east-1:222222222222:key/22222222-2222-4222-8222-222222222222"
    admission  = "arn:aws:kms:us-east-1:222222222222:key/33333333-3333-4333-8333-333333333333"
  }
  escrow_enabled = true
  network = {
    vpc_id    = "vpc-0123456789abcdef0"
    subnet_id = "subnet-0bbbbbbbbbbbbbbb1"
  }
  instance = {
    ami_id = "ami-0123456789abcdef0"
  }
  origin_hostname = "gs-origin.example.org"
  allowed_origins = ["https://play.example.org"]
}

# ---------------------------------------------------------------- COST-2A: the verifier's fixtures ARE this rendering

run "host_policies_are_the_verifier_fixtures" {
  command = plan

  assert {
    condition     = jsondecode(local.host_policy) == jsondecode(file("${path.module}/../../fixtures/host-role-policy-staging.json"))
    error_message = "COST-2A: the host role's policy changed -- update infra/aws/fixtures/host-role-policy-staging.json AND the host verifier's judgement (server/src/aws/deploy/hostVerify.ts judgeHostPolicy) together."
  }
  assert {
    condition     = jsondecode(local.assume_role_policy) == jsondecode(file("${path.module}/../../fixtures/host-assume-role-policy-staging.json"))
    error_message = "COST-2A: the host role's trust policy changed -- update infra/aws/fixtures/host-assume-role-policy-staging.json AND hostVerify.ts checkHostIam together."
  }
}

# ---------------------------------------------------------------- the host itself

run "one_graviton_host_hardened" {
  command = apply

  assert {
    condition     = aws_instance.host.instance_type == "t4g.small"
    error_message = "the budget's default host is t4g.small"
  }
  assert {
    condition     = local.arch == "arm64"
    error_message = "t4g is linux/arm64"
  }
  assert {
    condition     = aws_instance.host.metadata_options[0].http_tokens == "required" && aws_instance.host.metadata_options[0].http_put_response_hop_limit == 2 && aws_instance.host.metadata_options[0].http_endpoint == "enabled"
    error_message = "IMDSv2 required, hop limit 2 (the container reaches the role; nothing else)"
  }
  assert {
    condition     = aws_instance.host.metadata_options[0].instance_metadata_tags == "disabled" && aws_instance.host.metadata_options[0].http_protocol_ipv6 == "disabled"
    error_message = "tags are not exposed through IMDS; IMDS is IPv4-only (the guard is IPv4)"
  }
  assert {
    condition     = aws_instance.host.credit_specification[0].cpu_credits == "standard"
    error_message = "burstable credits STANDARD: never billed for CPU surplus"
  }
  assert {
    condition     = aws_instance.host.monitoring == false
    error_message = "no detailed monitoring (billed per metric)"
  }
  assert {
    condition     = aws_instance.host.root_block_device[0].encrypted == true && aws_instance.host.root_block_device[0].volume_type == "gp3" && aws_instance.host.root_block_device[0].volume_size == 12
    error_message = "root volume: encrypted gp3, 12 GB"
  }
  assert {
    condition     = aws_instance.host.disable_api_termination == true
    error_message = "termination protection on by default"
  }
  assert {
    condition     = aws_instance.host.user_data_replace_on_change == true
    error_message = "host configuration is cattle: a changed cloud-init replaces the host"
  }
  assert {
    condition     = aws_instance.host.primary_network_interface[0].network_interface_id == aws_network_interface.host.id
    error_message = "the instance is launched on the ENI that holds the Elastic IP"
  }
  assert {
    condition     = aws_eip_association.host.network_interface_id == aws_network_interface.host.id
    error_message = "the EIP is on the ENI (it survives a host replacement)"
  }
  assert {
    condition     = aws_iam_instance_profile.host.role == aws_iam_role.host.name
    error_message = "the instance profile carries the host role"
  }
}

run "user_data_fits_and_carries_no_credential" {
  command = plan

  assert {
    condition     = ceil(length(base64gzip(local.user_data)) * 3 / 4) <= 16384
    error_message = "the compressed cloud-init must fit EC2's 16 KiB user-data limit"
  }
  assert {
    condition     = length(regexall("(?im)(^[ \\t]*(export[ \\t]+)?(AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN)[ \\t]*=|BEGIN [A-Z ]*PRIVATE KEY|\\b(AKIA|ASIA)[0-9A-Z]{16}\\b)", join("\n", [local.host_env, local.server_env, local.caddyfile, local.user_data]))) == 0
    error_message = "no credential, key or token in any host file"
  }
  assert {
    condition     = length(regexall("(?m)^(DATA_DIR|ESCROW_JUNO_CONFIG)=", local.server_env)) == 0
    error_message = "AWS mode has no data directory and no file escrow configuration"
  }
  assert {
    condition     = strcontains(local.server_env, "GS_STORAGE=aws\n") && strcontains(local.server_env, "GS_MODE=production\n") && strcontains(local.server_env, "GS_METRICS_PROFILE=single-host\n")
    error_message = "the server runs AWS storage, production mode, the single-host metric profile"
  }
  assert {
    condition     = strcontains(local.server_env, "GS_AWS_CONFIG_PARAMETER=arn:aws:ssm:us-east-1:111111111111:parameter/gs/staging/runtime/p1\n")
    error_message = "the ONE pool's existing runtime document"
  }
  assert {
    condition     = strcontains(local.server_env, "GS_TRUSTED_PROXY_HOPS=2\n") && strcontains(local.server_env, "GS_ALLOWED_ORIGINS=https://play.example.org\n")
    error_message = "CloudFront + Caddy = 2 hops; the exact browser origin"
  }
  assert {
    condition     = !strcontains(local.server_env, "ESCROW_MONEY_TABLES")
    error_message = "money tables stay off unless asked for"
  }
  assert {
    condition     = strcontains(local.host_env, "GS_EXPECTED_PUBLIC_IP=") && strcontains(local.host_env, "GS_ARCH=arm64\n") && strcontains(local.host_env, "GS_LOG_GROUP=/gs/staging/host\n")
    error_message = "the host knows its serving address, architecture and log group"
  }
  assert {
    condition     = strcontains(local.caddyfile, "gs-origin.example.org {") && strcontains(local.caddyfile, "reverse_proxy 127.0.0.1:8917") && strcontains(local.caddyfile, "health_uri /gs/readyz") && strcontains(local.caddyfile, "@gs path /gs /gs/*")
    error_message = "Caddy proxies exactly /gs and /gs/* to the loopback server, with the readiness health check"
  }
  assert {
    condition     = strcontains(local.caddyfile, "trusted_proxies static") && strcontains(local.caddyfile, "disable_tlsalpn_challenge") && !strcontains(local.caddyfile, "email ")
    error_message = "XFF appended (2 hops); HTTP-01 only; no ACME email invented"
  }
  assert {
    condition     = length(regexall("(?i)\\b(rewrite|uri strip_prefix|uri replace)\\b", local.caddyfile)) == 0
    error_message = "no path rewriting"
  }
  assert {
    condition     = length([for f in local.write_files : f if f.path == "/etc/gs/server.env" && f.permissions == "0640"]) == 1
    error_message = "server.env is root-readable only"
  }
  assert {
    condition     = length([for f in local.write_files : f if f.path == "/root/.docker/config.json"]) == 1 && strcontains(base64decode(base64encode(jsonencode({ credHelpers = { "111111111111.dkr.ecr.us-east-1.amazonaws.com" = "ecr-login" } }))), "ecr-login")
    error_message = "the ECR credential helper (instance role) -- no registry token is stored"
  }
}

run "network_cloudfront_only_no_ssh_no_8917" {
  command = plan

  assert {
    condition     = aws_vpc_security_group_ingress_rule.https_from_cloudfront.from_port == 443 && aws_vpc_security_group_ingress_rule.https_from_cloudfront.prefix_list_id == "pl-3b927c52" && aws_vpc_security_group_ingress_rule.https_from_cloudfront.cidr_ipv4 == null
    error_message = "443 only from CloudFront's origin-facing prefix list"
  }
  assert {
    condition     = aws_vpc_security_group_ingress_rule.acme_http01.from_port == 80 && aws_vpc_security_group_ingress_rule.acme_http01.to_port == 80
    error_message = "80 for ACME HTTP-01 only"
  }
  assert {
    condition     = length(aws_vpc_security_group_ingress_rule.emergency_ssh) == 0
    error_message = "no port 22 by default"
  }
  assert {
    condition     = keys(aws_vpc_security_group_egress_rule.https) == ["443"]
    error_message = "egress: 443 only (no Juno port added by default)"
  }
}

run "emergency_ssh_is_explicit_and_narrow" {
  command = plan
  variables {
    emergency_ssh_cidrs = ["198.51.100.7/32"]
  }
  assert {
    condition     = aws_vpc_security_group_ingress_rule.emergency_ssh["198.51.100.7/32"].from_port == 22
    error_message = "the emergency rule opens 22 to one address"
  }
}

run "emergency_ssh_refuses_a_wide_range" {
  command = plan
  variables {
    emergency_ssh_cidrs = ["0.0.0.0/0"]
  }
  expect_failures = [var.emergency_ssh_cidrs]
}

# ---------------------------------------------------------------- the role: the ECS task role's authority, one host

run "role_is_ec2_only_and_least_privilege" {
  command = plan

  assert {
    condition     = jsondecode(local.assume_role_policy).Statement[0].Principal.Service == "ec2.amazonaws.com"
    error_message = "only EC2 assumes the host role"
  }
  assert {
    condition     = jsondecode(local.assume_role_policy).Statement[0].Condition.StringEquals["aws:SourceAccount"] == "111111111111"
    error_message = "confused-deputy guard"
  }
  assert {
    condition     = toset([for s in local.host_policy_statements : s.Sid]) == toset(["GameTableReadAndCheck", "GameTableWriteNeverSystem", "IdentityTable", "LedgerReadAndCheck", "LedgerAppendNeverAppgen", "ReadRuntimeConfiguration", "SigningKeysPublicKey", "SigningKeysSignDigestOnly", "EcrAuthTokenUnscopable", "PullThisRepositoryOnly", "WriteThisHostLogsOnly", "HostPressureMetricOnly", "SsmAgentRegister", "SsmAgentChannelsUnscopable"])
    error_message = "exactly the expected statements"
  }
  assert {
    condition = alltrue([for s in local.host_policy_statements :
      !contains(flatten([s.Action]), "*") && length([for a in flatten([s.Action]) : a if can(regex("^(iam|sts|kms:(CreateGrant|PutKeyPolicy|ScheduleKeyDeletion|Decrypt|Encrypt)|dynamodb:(RestoreTableToPointInTime|DeleteTable|UpdateTable|CreateTable)|secretsmanager|ssm:(PutParameter|GetParameters|SendCommand)|ecs|elasticloadbalancing)", a))]) == 0
    ])
    error_message = "no admin, IAM, STS, key administration, table administration, restore, secret, deploy or ECS/ELB action"
  }
  assert {
    condition = alltrue([for s in local.host_policy_statements :
      !contains(flatten([s.Resource]), "*") || contains(["EcrAuthTokenUnscopable", "HostPressureMetricOnly", "SsmAgentChannelsUnscopable"], s.Sid)
    ])
    error_message = "a \"*\" resource only where AWS offers no resource scope (justified in iam.tf)"
  }
  assert {
    condition     = [for s in local.host_policy_statements : s.Condition.StringEquals["cloudwatch:namespace"] if s.Sid == "HostPressureMetricOnly"][0] == "18Cosmos/Host"
    error_message = "PutMetricData only into the host's own namespace"
  }
  assert {
    condition     = [for s in local.host_policy_statements : s.Condition["ForAllValues:StringNotEquals"]["dynamodb:LeadingKeys"] if s.Sid == "GameTableWriteNeverSystem"][0] == ["SYSTEM"]
    error_message = "the app never writes SYSTEM/* (routing, generation markers)"
  }
  assert {
    condition     = toset([for s in local.host_policy_statements : s.Condition["ForAllValues:StringNotEquals"]["dynamodb:LeadingKeys"] if s.Sid == "LedgerAppendNeverAppgen"][0]) == toset(["APPGEN", "APPGEN#HISTORY"])
    error_message = "the app never writes APPGEN or its history (adoption is the recovery role's)"
  }
  assert {
    condition     = [for s in local.host_policy_statements : s.Condition.StringEquals["kms:SigningAlgorithm"] if s.Sid == "SigningKeysSignDigestOnly"][0] == "ECDSA_SHA_256" && [for s in local.host_policy_statements : s.Condition.StringEquals["kms:MessageType"] if s.Sid == "SigningKeysSignDigestOnly"][0] == "DIGEST"
    error_message = "Sign: ECDSA_SHA_256 over a DIGEST only"
  }
  assert {
    condition     = toset(flatten([for s in local.host_policy_statements : s.Resource if s.Sid == "SigningKeysSignDigestOnly"])) == toset(values(var.signing_keys))
    error_message = "Sign on exactly the three configured keys"
  }
  assert {
    condition     = flatten([for s in local.host_policy_statements : s.Resource if s.Sid == "ReadRuntimeConfiguration"]) == ["arn:aws:ssm:us-east-1:111111111111:parameter/gs/staging/runtime/p1", "arn:aws:ssm:us-east-1:111111111111:parameter/gs/staging/juno-backend"]
    error_message = "exactly this pool's runtime document and the Juno document"
  }
  assert {
    condition     = flatten([for s in local.host_policy_statements : s.Resource if s.Sid == "PullThisRepositoryOnly"]) == ["arn:aws:ecr:us-east-1:111111111111:repository/gs-staging-server"]
    error_message = "pull from the one existing repository"
  }
  assert {
    condition     = flatten([for s in local.host_policy_statements : s.Resource if s.Sid == "GameTableReadAndCheck"]) == ["arn:aws:dynamodb:us-east-1:111111111111:table/gs-staging-game-g1"]
    error_message = "the serving game table only (no other generation is managed here)"
  }
}

run "role_follows_managed_generations_and_no_escrow" {
  command = plan
  variables {
    generation       = 2
    game_generations = [1, 2]
    signing_keys     = null
    escrow_enabled   = false
    ssm_agent        = false
  }
  assert {
    condition     = flatten([for s in local.host_policy_statements : s.Resource if s.Sid == "GameTableWriteNeverSystem"]) == ["arn:aws:dynamodb:us-east-1:111111111111:table/gs-staging-game-g1", "arn:aws:dynamodb:us-east-1:111111111111:table/gs-staging-game-g2"]
    error_message = "every managed generation (a restore's g<N+1> before the host restarts onto it)"
  }
  assert {
    condition     = length([for s in local.host_policy_statements : s if startswith(s.Sid, "SigningKeys") || startswith(s.Sid, "SsmAgent")]) == 0
    error_message = "no KMS without signing keys; no SSM agent grant when off"
  }
  assert {
    condition     = flatten([for s in local.host_policy_statements : s.Resource if s.Sid == "ReadRuntimeConfiguration"]) == ["arn:aws:ssm:us-east-1:111111111111:parameter/gs/staging/runtime/p1"]
    error_message = "no Juno document without escrow"
  }
}

# ---------------------------------------------------------------- budget-sensitive choices

run "instance_type_outside_the_budget_is_refused" {
  command = plan
  variables {
    instance = { ami_id = "ami-0123456789abcdef0", type = "t3.medium" }
  }
  expect_failures = [var.instance]
}

run "x86_fallback_is_amd64" {
  command = plan
  variables {
    instance = { ami_id = "ami-0123456789abcdef0", type = "t3.small" }
  }
  assert {
    condition     = local.arch == "amd64" && strcontains(local.host_env, "GS_ARCH=amd64\n")
    error_message = "t3 is linux/amd64"
  }
}

run "log_retention_capped" {
  command = plan
  variables {
    log_retention_days = 365
  }
  expect_failures = [var.log_retention_days]
}

run "observability_is_five_alarms" {
  command = plan
  assert {
    condition     = aws_cloudwatch_metric_alarm.health.metric_name == "HostHealthProblems" && aws_cloudwatch_metric_alarm.health.treat_missing_data == "breaching" && aws_cloudwatch_metric_alarm.health.evaluation_periods == 3
    error_message = "health: the derived gauge, 3 minutes, missing = breaching (heartbeat)"
  }
  assert {
    condition     = aws_cloudwatch_metric_alarm.critical.metric_name == "HostCriticalEvents" && aws_cloudwatch_metric_alarm.critical.treat_missing_data == "notBreaching" && aws_cloudwatch_metric_alarm.critical.statistic == "Sum"
    error_message = "critical: any incident counter in a minute"
  }
  assert {
    condition     = length(aws_cloudwatch_metric_alarm.health.dimensions) == 1 && aws_cloudwatch_metric_alarm.health.dimensions["Environment"] == "staging" && length(aws_cloudwatch_metric_alarm.critical.dimensions) == 1 && aws_cloudwatch_metric_alarm.critical.dimensions["Environment"] == "staging"
    error_message = "one dimension set, no pool duplication"
  }
  assert {
    condition     = aws_cloudwatch_metric_alarm.cpu_credits.metric_name == "CPUCreditBalance" && aws_cloudwatch_metric_alarm.cpu_credits.comparison_operator == "LessThanThreshold"
    error_message = "a CPU-credit warning for the burstable host (free basic metric)"
  }
  assert {
    condition     = aws_cloudwatch_log_group.host.retention_in_days == 90 && aws_cloudwatch_log_group.host.log_group_class == "STANDARD"
    error_message = "90 days, Standard class (EMF extraction)"
  }
}

run "edge_diagnostic_is_staging_only" {
  command = plan
  variables {
    edge_diagnostic_staging = true
  }
  assert {
    condition     = strcontains(local.server_env, "GS_EDGE_DIAGNOSTIC=staging\n")
    error_message = "the staging edge mirror for the CloudFront edge probes"
  }
}

run "edge_diagnostic_refused_in_prod" {
  command = plan
  variables {
    environment             = "prod"
    edge_diagnostic_staging = true
  }
  expect_failures = [var.edge_diagnostic_staging]
}

# Consolidated final pre-playtest integration: player reporting's reviewer list (GS_CONDUCT_REVIEWERS). Absent by default --
# the rendered server.env (and so the user data, which replaces the host on change) is exactly what it was without it.
run "conduct_reviewers_absent_by_default" {
  command = plan
  assert {
    condition     = !strcontains(local.server_env, "GS_CONDUCT_REVIEWERS")
    error_message = "no reviewer list unless one is given"
  }
  assert {
    condition     = endswith(local.server_env, "GS_METRICS_PROFILE=single-host\n")
    error_message = "with no reviewer (and no money tables / edge mirror), server.env ends exactly as before the reviewer input existed"
  }
}

run "conduct_reviewers_rendered" {
  command = plan
  variables {
    conduct_reviewers = ["Rita", "Moderator"]
  }
  assert {
    condition     = strcontains(local.server_env, "\nGS_CONDUCT_REVIEWERS=Rita,Moderator\n")
    error_message = "the reviewer usernames, comma-separated, as the server parses them"
  }
}

run "conduct_reviewers_refuse_separators" {
  command = plan
  variables {
    conduct_reviewers = ["Rita,Mallory"]
  }
  expect_failures = [var.conduct_reviewers]
}

run "budget_off_by_default" {
  command = plan
  assert {
    condition     = length(aws_budgets_budget.monthly) == 0
    error_message = "no budget without an explicit subscriber"
  }
}

run "budget_needs_a_subscriber" {
  command = plan
  variables {
    budget = { enabled = true }
  }
  expect_failures = [var.budget]
}

run "budget_thresholds" {
  command = plan
  variables {
    budget = { enabled = true, sns_topic_arn = "arn:aws:sns:us-east-1:111111111111:gs-billing" }
  }
  assert {
    condition     = aws_budgets_budget.monthly[0].limit_amount == "30.00" && aws_budgets_budget.monthly[0].time_unit == "MONTHLY" && aws_budgets_budget.monthly[0].budget_type == "COST"
    error_message = "a $30 monthly cost budget"
  }
  assert {
    condition     = toset([for n in aws_budgets_budget.monthly[0].notification : "${n.notification_type}-${n.threshold}"]) == toset(["ACTUAL-15", "ACTUAL-20", "FORECASTED-25", "ACTUAL-25", "ACTUAL-30"])
    error_message = "$15 / $20 actual, $25 forecast and actual, $30 actual"
  }
}

run "budget_above_the_ceiling_is_refused" {
  command = plan
  variables {
    budget = { enabled = true, limit_usd = 50, sns_topic_arn = "arn:aws:sns:us-east-1:111111111111:gs-billing" }
  }
  expect_failures = [var.budget]
}

run "ecr_lifecycle_off_while_ecs_is_the_rollback_path" {
  command = plan
  assert {
    condition     = length(aws_ecr_lifecycle_policy.server) == 0
    error_message = "no lifecycle policy by default (ECS circuit-breaker images must not expire before step I)"
  }
}

run "ecr_lifecycle_keeps_rollback_history" {
  command = plan
  variables {
    manage_ecr_lifecycle = true
  }
  assert {
    condition     = jsondecode(aws_ecr_lifecycle_policy.server[0].policy).rules[1].selection.countNumber == 20 && aws_ecr_lifecycle_policy.server[0].repository == "gs-staging-server"
    error_message = "the existing repository keeps the newest 20 images"
  }
}

# ---------------------------------------------------------------- PHASE 3 ESCROW 2.1: the DEDICATED REMEDY key
# Owner decision 2026-10-08: the host role signs remedy attestations with the remedy key ONLY, in its own statements; the
# three-key statements are unchanged. No remedy key by default (the fixture above): the host policy is byte-for-byte as before.

run "remedy_key_absent_by_default" {
  command = plan

  assert {
    condition     = length([for s in local.host_policy_statements : s if startswith(s.Sid, "RemedyKey")]) == 0
    error_message = "Default (remedy_signing_key = null): no remedy statement; the host policy is the unchanged fixture."
  }
}

run "remedy_key_has_its_own_statements_and_fixture" {
  command = plan
  variables {
    remedy_signing_key = "arn:aws:kms:us-east-1:222222222222:key/77777777-7777-4777-8777-777777777777"
  }

  assert {
    condition     = jsondecode(local.host_policy) == jsondecode(file("${path.module}/../../fixtures/host-role-policy-staging-remedy.json"))
    error_message = "The host role's policy with a remedy key must equal infra/aws/fixtures/host-role-policy-staging-remedy.json (the host verifier's GOOD evidence) -- update both and hostVerify.ts together."
  }
  assert {
    condition = (flatten([for s in local.host_policy_statements : s.Resource if s.Sid == "RemedyKeyPublicKey"]) == ["arn:aws:kms:us-east-1:222222222222:key/77777777-7777-4777-8777-777777777777"]
      && flatten([for s in local.host_policy_statements : s.Action if s.Sid == "RemedyKeyPublicKey"]) == ["kms:GetPublicKey"]
      && flatten([for s in local.host_policy_statements : s.Resource if s.Sid == "RemedyKeySignDigestOnly"]) == ["arn:aws:kms:us-east-1:222222222222:key/77777777-7777-4777-8777-777777777777"]
    && flatten([for s in local.host_policy_statements : s.Action if s.Sid == "RemedyKeySignDigestOnly"]) == ["kms:Sign"])
    error_message = "GetPublicKey and Sign on exactly the remedy key, in RemedyKeyPublicKey / RemedyKeySignDigestOnly."
  }
  assert {
    condition     = [for s in local.host_policy_statements : s.Condition.StringEquals if s.Sid == "RemedyKeySignDigestOnly"][0] == { "kms:SigningAlgorithm" = "ECDSA_SHA_256", "kms:MessageType" = "DIGEST" }
    error_message = "Remedy Sign: ECDSA_SHA_256 over a DIGEST only."
  }
  assert {
    condition     = toset(flatten([for s in local.host_policy_statements : s.Resource if s.Sid == "SigningKeysSignDigestOnly"])) == toset(values(var.signing_keys)) && toset(flatten([for s in local.host_policy_statements : s.Resource if s.Sid == "SigningKeysPublicKey"])) == toset(values(var.signing_keys))
    error_message = "The three-key statements are unchanged (never widened to the remedy key)."
  }
  assert {
    condition     = toset(flatten([for s in local.host_policy_statements : flatten([s.Resource]) if contains(flatten([s.Action]), "kms:Sign")])) == toset(concat(values(var.signing_keys), ["arn:aws:kms:us-east-1:222222222222:key/77777777-7777-4777-8777-777777777777"]))
    error_message = "Everything the host may Sign with: the three configured keys plus the remedy key -- nothing else, never '*'."
  }
}

run "remedy_key_refuses_an_alias" {
  command = plan
  variables {
    remedy_signing_key = "arn:aws:kms:us-east-1:222222222222:alias/gs-staging-remedy"
  }
  expect_failures = [var.remedy_signing_key]
}

run "remedy_key_refuses_a_configured_signing_key" {
  command = plan
  variables {
    remedy_signing_key = "arn:aws:kms:us-east-1:222222222222:key/22222222-2222-4222-8222-222222222222"
  }
  expect_failures = [var.remedy_signing_key]
}

run "remedy_key_needs_escrow" {
  command = plan
  variables {
    signing_keys       = null
    escrow_enabled     = false
    remedy_signing_key = "arn:aws:kms:us-east-1:222222222222:key/77777777-7777-4777-8777-777777777777"
  }
  expect_failures = [var.remedy_signing_key]
}
