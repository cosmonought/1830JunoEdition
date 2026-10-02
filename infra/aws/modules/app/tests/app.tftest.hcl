# LIVE-5 L5-8: the app module against L5-7 §14 -- plan/apply over a MOCKED provider (no AWS account, no credentials).
# Run: cd infra/aws/modules/app && terraform init -backend=false && terraform test

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
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }
  mock_data "aws_ec2_managed_prefix_list" {
    defaults = { id = "pl-3b927c52" }
  }
  mock_data "aws_dynamodb_table_item" {
    # One mock item answers BOTH plan-time reads (the routing's fields and L6-4's SYSTEM/GENERATION fields): the routing
    # names p1, the serving table g1 carries a bootstrap marker for generation 1. Runs override either where it matters.
    defaults = { item = "{\"pk\":{\"S\":\"SYSTEM\"},\"sk\":{\"S\":\"ROUTING\"},\"fmt\":{\"N\":\"1\"},\"primary_pool\":{\"S\":\"p1\"},\"routing_version\":{\"N\":\"1\"},\"updated_at\":{\"N\":\"0\"},\"updated_by\":{\"S\":\"test\"},\"claim\":{\"S\":\"c\"},\"generation\":{\"N\":\"1\"},\"game_table\":{\"S\":\"gs-staging-game-g1\"},\"origin\":{\"S\":\"bootstrap\"},\"restore_id\":{\"NULL\":true}}" }
  }
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::111111111111:role/gs-staging-mock" }
  }
  mock_resource "aws_ecs_task_definition" {
    defaults = { arn = "arn:aws:ecs:us-east-1:111111111111:task-definition/gs-staging-p1:1" }
  }
  mock_resource "aws_lb_target_group" {
    defaults = { arn = "arn:aws:elasticloadbalancing:us-east-1:111111111111:targetgroup/gs-staging-p1/0123456789abcdef" }
  }
  mock_resource "aws_lb" {
    defaults = { arn = "arn:aws:elasticloadbalancing:us-east-1:111111111111:loadbalancer/app/gs-staging-alb/0123456789abcdef" }
  }
  mock_resource "aws_lb_listener" {
    defaults = { arn = "arn:aws:elasticloadbalancing:us-east-1:111111111111:listener/app/gs-staging-alb/0123456789abcdef/0123456789abcdef" }
  }
  mock_resource "aws_ecr_repository" {
    defaults = { arn = "arn:aws:ecr:us-east-1:111111111111:repository/gs-staging-server" }
  }
  mock_resource "aws_cloudwatch_log_group" {
    defaults = { arn = "arn:aws:logs:us-east-1:111111111111:log-group:/gs/staging/p1" }
  }
  mock_resource "aws_ecs_cluster" {
    defaults = { arn = "arn:aws:ecs:us-east-1:111111111111:cluster/gs-staging" }
  }
  mock_resource "aws_dynamodb_table" {
    defaults = { arn = "arn:aws:dynamodb:us-east-1:111111111111:table/gs-staging-mock" }
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
  escrow = {
    chain_id         = "uni-7"
    network_class    = "testnet"
    rest_endpoints   = ["https://juno-testnet-rest.example.net"]
    contract_address = "juno1qurswpc8qurswpc8qurswpc8qurswpc8qurswpc8qurswpc8qursaq28r5"
    code_checksum    = "5ecc302221a2dab4bb4f0f71b632f2beeafe9523ebd7b33bd0e94d017b8d09e8"
    wasm_admin       = null
    denom            = "ujunox"
    asset_symbol     = "JUNOX"
    relayer_address  = "juno1xc5etfhxjg4qfc9cx25qh3tvxdcf5skjj5epte"
    settlement_key   = { signer_key_id = 1, public_key_hex = "03d01115d548e7561b15c38f004d734633687cf4419620095bc5b0f47070afe85a" }
    admission_key    = { public_key_hex = "03f28773c2d975288bc7d1d205c3748651b075fbc6610e58cddeeddf8f19405aa8", ttl_secs = 600 }
    trust = {
      operators                 = ["juno1xc5etfhxjg4qfc9cx25qh3tvxdcf5skjj5epte"]
      resolvers                 = ["juno1wfk5fda0sg5z2lqrpwh7wexnckpe6hqzljkt4v"]
      min_challenge_window_secs = "3600"
      min_liveness_window_secs  = "3600"
      min_resolver_timeout_secs = "3600"
    }
    timeout_blocks = 60
  }
  network = {
    vpc_id                  = "vpc-0123456789abcdef0"
    task_subnet_ids         = ["subnet-0aaaaaaaaaaaaaaa1", "subnet-0aaaaaaaaaaaaaaa2"]
    alb_subnet_ids          = ["subnet-0bbbbbbbbbbbbbbb1", "subnet-0bbbbbbbbbbbbbbb2"]
    private_route_table_ids = ["rtb-0ccccccccccccccc1"]
  }
  build_id                         = "2026-09-30-test"
  allowed_origins                  = ["https://play.example.com"]
  alb                              = { certificate_arn = "arn:aws:acm:us-east-1:111111111111:certificate/44444444-4444-4444-8444-444444444444" }
  bootstrap_trusted_principal_arns = ["arn:aws:iam::111111111111:role/deploy-pipeline"]
  edge = {
    create_distribution     = true
    aliases                 = ["play.example.com"]
    viewer_certificate_arn  = "arn:aws:acm:us-east-1:111111111111:certificate/55555555-5555-4555-8555-555555555555"
    site_origin_domain_name = "site-origin.example.com"
    alb_origin_domain_name  = "gs-origin.example.com"
  }
}

/* ------------------------------------------------------------------ */
/* Phase A (start_services = false): everything but the services         */
/* ------------------------------------------------------------------ */

run "tables_match_the_contract" {
  command = apply

  assert {
    condition     = aws_dynamodb_table.game["1"].name == "gs-staging-game-g1" && aws_dynamodb_table.identity.name == "gs-staging-identity" && length(aws_dynamodb_table.game) == 1
    error_message = "Table names must be gs-<env>-game-g<N> and gs-<env>-identity."
  }
  assert {
    condition = alltrue([for t in [aws_dynamodb_table.game["1"], aws_dynamodb_table.identity] :
      t.hash_key == "pk" && t.range_key == "sk" && t.billing_mode == "PAY_PER_REQUEST" && t.deletion_protection_enabled
      && toset([for a in t.attribute : "${a.name}:${a.type}"]) == toset(["pk:S", "sk:S"])
      && length(t.global_secondary_index) == 0 && length(t.local_secondary_index) == 0 && length(t.replica) == 0
      && t.point_in_time_recovery[0].enabled
    ])
    error_message = "Both tables: string pk/sk, on-demand, deletion protection, PITR, no GSI/LSI, never a Global Table."
  }
  assert {
    condition     = one(aws_dynamodb_table.game["1"].ttl).enabled && one(aws_dynamodb_table.game["1"].ttl).attribute_name == "ttl"
    error_message = "LIVE-6 L6-5B: the game table's TTL is `ttl` -- carried ONLY by L6-5A's diagnostic TASK# items (was: no TTL)."
  }
  assert {
    condition     = aws_dynamodb_table.identity.ttl[0].enabled && aws_dynamodb_table.identity.ttl[0].attribute_name == "ttl"
    error_message = "The identity table's TTL attribute is `ttl`."
  }
}

run "documents_render_exactly_what_the_runtime_parses" {
  command = apply

  assert {
    condition     = jsondecode(aws_ssm_parameter.runtime["p1"].insecure_value) == jsondecode(file("${path.module}/../../fixtures/runtime-staging-p1.json"))
    error_message = "The runtime document must equal infra/aws/fixtures/runtime-staging-p1.json (which the server's parser checks)."
  }
  assert {
    condition     = jsondecode(aws_ssm_parameter.juno_backend[0].insecure_value) == jsondecode(file("${path.module}/../../fixtures/juno-backend-staging.json"))
    error_message = "The Juno document must equal infra/aws/fixtures/juno-backend-staging.json (which the server's parser checks)."
  }
  assert {
    condition     = aws_ssm_parameter.runtime["p1"].type == "String" && aws_ssm_parameter.juno_backend[0].type == "String"
    error_message = "Both documents are plain String parameters (the runtime refuses a SecureString)."
  }
  assert {
    condition     = aws_ssm_parameter.runtime["p1"].name == "/gs/staging/runtime/p1" && aws_ssm_parameter.juno_backend[0].name == "/gs/staging/juno-backend"
    error_message = "Parameter names follow /gs/<env>/runtime/<pool> and /gs/<env>/juno-backend."
  }
  assert {
    condition     = jsondecode(aws_ssm_parameter.juno_backend[0].insecure_value).journal.table_arn == jsondecode(aws_ssm_parameter.runtime["p1"].insecure_value).ledger_table_arn
    error_message = "The Juno journal is the runtime's ledger (one task, one ledger)."
  }
  assert {
    condition     = !strcontains(aws_ssm_parameter.juno_backend[0].insecure_value, "alias/") && !strcontains(aws_ssm_parameter.juno_backend[0].insecure_value, "dev_signer") && !strcontains(aws_ssm_parameter.juno_backend[0].insecure_value, "allow_insecure_local_http")
    error_message = "No alias, no development signer, no insecure http in the Juno document."
  }
}

run "task_definition_carries_references_only" {
  command = apply

  assert {
    condition = toset([for e in jsondecode(aws_ecs_task_definition.pool["p1"].container_definitions)[0].environment : e.name]) == toset([
      "GS_MODE", "GS_STORAGE", "GS_AWS_CONFIG_PARAMETER", "BUILD_ID", "PORT", "GS_ALLOWED_ORIGINS", "GS_TRUSTED_PROXY_HOPS",
    ])
    error_message = "The environment is exactly L5-7 §14's names (no money switch unless asked)."
  }
  assert {
    condition = { for e in jsondecode(aws_ecs_task_definition.pool["p1"].container_definitions)[0].environment : e.name => e.value } == {
      GS_MODE                 = "production"
      GS_STORAGE              = "aws"
      GS_AWS_CONFIG_PARAMETER = "arn:aws:ssm:us-east-1:111111111111:parameter/gs/staging/runtime/p1"
      BUILD_ID                = "2026-09-30-test"
      PORT                    = "8917"
      GS_ALLOWED_ORIGINS      = "https://play.example.com"
      GS_TRUSTED_PROXY_HOPS   = "2"
    }
    error_message = "The environment's values."
  }
  assert {
    condition = alltrue([for k in ["secrets", "environmentFiles"] : !contains(keys(jsondecode(aws_ecs_task_definition.pool["p1"].container_definitions)[0]), k)]) && alltrue([
      for forbidden in ["DATA_DIR", "ESCROW_JUNO_CONFIG", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"] :
      !strcontains(aws_ecs_task_definition.pool["p1"].container_definitions, forbidden)
    ])
    error_message = "No secrets/environmentFiles injection, no data directory, no escrow file, no static credentials."
  }
  assert {
    condition     = jsondecode(aws_ecs_task_definition.pool["p1"].container_definitions)[0].stopTimeout == 120
    error_message = "stopTimeout is 120 s (the graceful shutdown's bound)."
  }
  assert {
    condition     = strcontains(join(" ", jsondecode(aws_ecs_task_definition.pool["p1"].container_definitions)[0].healthCheck.command), "/gs/healthz") && !strcontains(join(" ", jsondecode(aws_ecs_task_definition.pool["p1"].container_definitions)[0].healthCheck.command), "readyz")
    error_message = "The container health check is liveness: /gs/healthz."
  }
  assert {
    condition     = jsondecode(aws_ecs_task_definition.pool["p1"].container_definitions)[0].logConfiguration.logDriver == "awslogs" && aws_ecs_task_definition.pool["p1"].network_mode == "awsvpc"
    error_message = "awslogs and awsvpc."
  }
  assert {
    condition     = jsondecode(aws_ecs_task_definition.pool["p1"].container_definitions)[0].image == "111111111111.dkr.ecr.us-east-1.amazonaws.com/gs-staging-server:2026-09-30-test"
    error_message = "The image is this stack's repository at the BUILD_ID tag."
  }
  assert {
    condition     = length(aws_ecs_service.pool) == 0
    error_message = "start_services = false creates no service (the bootstrap comes first)."
  }
}

run "task_role_is_least_privilege" {
  command = apply

  assert {
    condition = { for s in data.aws_iam_policy_document.task[0].statement : s.sid => toset(s.actions) } == {
      GameTableReadAndCheck     = toset(["dynamodb:GetItem", "dynamodb:Query", "dynamodb:Scan", "dynamodb:ConditionCheckItem"])
      GameTableWriteNeverSystem = toset(["dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem"])
      IdentityTable             = toset(["dynamodb:GetItem", "dynamodb:Scan", "dynamodb:ConditionCheckItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem"])
      LedgerReadAndCheck        = toset(["dynamodb:GetItem", "dynamodb:Query", "dynamodb:ConditionCheckItem"])
      LedgerAppendNeverAppgen   = toset(["dynamodb:PutItem"])
      ReadRuntimeConfiguration  = toset(["ssm:GetParameter"])
      SigningKeysPublicKey      = toset(["kms:GetPublicKey"])
      SigningKeysSignDigestOnly = toset(["kms:Sign"])
    }
    error_message = "The task role's statements are exactly L5-7 §14's action list."
  }
  assert {
    condition     = alltrue([for s in data.aws_iam_policy_document.task[0].statement : !contains(s.resources, "*")])
    error_message = "The task role has no '*' resource."
  }
  assert {
    condition     = alltrue([for s in concat(data.aws_iam_policy_document.task[0].statement, data.aws_iam_policy_document.execution[0].statement) : alltrue([for a in s.actions : !startswith(a, "secretsmanager:") && !startswith(a, "ssmmessages:")])])
    error_message = "No Secrets Manager permission (no consumer yet) and no ECS Exec channel."
  }
  assert {
    condition     = toset(one([for s in data.aws_iam_policy_document.task[0].statement : s if s.sid == "LedgerReadAndCheck"]).resources) == toset(["arn:aws:dynamodb:us-east-1:222222222222:table/gs-staging-ledger"])
    error_message = "The ledger is granted by its full (cross-account) table ARN."
  }
  assert {
    condition = toset([for c in one([for s in data.aws_iam_policy_document.task[0].statement : s if s.sid == "SigningKeysSignDigestOnly"]).condition : "${c.test}|${c.variable}|${join(",", c.values)}"]) == toset([
      "StringEquals|kms:SigningAlgorithm|ECDSA_SHA_256", "StringEquals|kms:MessageType|DIGEST",
    ])
    error_message = "kms:Sign only with ECDSA_SHA_256 over a DIGEST."
  }
  assert {
    condition = alltrue([
      for sid, key in { GameTableWriteNeverSystem = "SYSTEM", LedgerAppendNeverAppgen = "APPGEN,APPGEN#HISTORY" } :
      toset([for c in one([for s in data.aws_iam_policy_document.task[0].statement : s if s.sid == sid]).condition : "${c.test}|${c.variable}|${join(",", c.values)}"]) == toset(["ForAllValues:StringNotEquals|dynamodb:LeadingKeys|${key}"])
    ])
    error_message = "The task never writes SYSTEM/* (routing), APPGEN or APPGEN#HISTORY (L6-2 review M4)."
  }
  assert {
    condition     = toset(one([for s in data.aws_iam_policy_document.task[0].statement : s if s.sid == "ReadRuntimeConfiguration"]).resources) == toset(["arn:aws:ssm:us-east-1:111111111111:parameter/gs/staging/runtime/p1", "arn:aws:ssm:us-east-1:111111111111:parameter/gs/staging/juno-backend"])
    error_message = "ssm:GetParameter on the two documents only."
  }
}

run "bootstrap_role_is_separate_and_narrow" {
  command = apply

  assert {
    condition = alltrue([
      for sid, key in { RoutingItemOnly = "SYSTEM", AppgenItemOnly = "APPGEN" } :
      toset([for c in one([for s in data.aws_iam_policy_document.bootstrap.statement : s if s.sid == sid]).condition : "${c.test}|${c.variable}|${join(",", c.values)}"]) == toset(["ForAllValues:StringEquals|dynamodb:LeadingKeys|${key}"])
    ])
    error_message = "The bootstrap writes only SYSTEM/* on the game table and APPGEN on the ledger."
  }
  assert {
    condition     = alltrue([for s in data.aws_iam_policy_document.bootstrap.statement : alltrue([for a in s.actions : !contains(["kms:Sign", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:Scan"], a)])])
    error_message = "The bootstrap role cannot sign, update, delete or scan (one serving generation: no old table to scan)."
  }
  assert {
    condition     = alltrue([for s in data.aws_iam_policy_document.bootstrap.statement : alltrue([for a in s.actions : !contains(["ecs:RunTask", "ecs:StartTask", "ecs:UpdateService", "ecs:StopTask", "logs:GetLogEvents", "iam:PassRole"], a)])])
    error_message = "LIVE-6 L6-6: the bootstrap/verify role reads the staging captures; it can start, change or stop no task."
  }
  assert {
    condition = alltrue([for s in data.aws_iam_policy_document.bootstrap.statement : alltrue([for a in s.actions : !contains([
      "dynamodb:TransactWriteItems", "dynamodb:BatchWriteItem", "kms:CreateGrant", "kms:ScheduleKeyDeletion",
      "cloudwatch:PutMetricData", "cloudwatch:SetAlarmState", "cloudwatch:DisableAlarmActions", "cloudwatch:EnableAlarmActions", "cloudwatch:PutMetricAlarm", "cloudwatch:DeleteAlarms",
      "ecs:RegisterTaskDefinition", "ecs:DeregisterTaskDefinition", "elasticloadbalancing:ModifyRule", "elasticloadbalancing:ModifyListener", "cloudfront:UpdateDistribution",
      "dynamodb:RestoreTableToPointInTime", "ssm:PutParameter",
    ], a)])])
    error_message = "LIVE-6 final convergence: the verifier role has no gameplay, recovery, flip, alarm or deployment mutation."
  }
  assert {
    condition     = aws_iam_role.bootstrap.name == "gs-staging-bootstrap" && aws_iam_role.task[0].name == "gs-staging-app-task" && aws_iam_role.execution[0].name == "gs-staging-app-execution"
    error_message = "Role names are the ones the ledger stack grants."
  }
  # COST-2A: the host verifier's reads are describe / get / list only, IAM on the host role alone, and no Run Command.
  assert {
    condition     = alltrue([for s in data.aws_iam_policy_document.bootstrap.statement : !startswith(s.sid, "HostVerifier") || alltrue([for a in s.actions : can(regex("^[a-z0-9]+:(Describe|Get|List|View)[A-Za-z]+$", a))])])
    error_message = "COST-2A: the host verifier's statements grant describe / get / list / view actions only."
  }
  assert {
    condition     = toset(one([for s in data.aws_iam_policy_document.bootstrap.statement : s if s.sid == "HostVerifierHostRole"]).resources) == toset(["arn:aws:iam::111111111111:role/gs-staging-host-app", "arn:aws:iam::111111111111:instance-profile/gs-staging-host-app"])
    error_message = "COST-2A: the verifier reads the host role and its instance profile only."
  }
  assert {
    condition     = alltrue([for s in data.aws_iam_policy_document.bootstrap.statement : alltrue([for a in s.actions : !contains(["ssm:SendCommand", "ssm:StartSession", "ssm:GetParameters", "ec2:ModifyInstanceAttribute", "ec2:StopInstances", "ec2:TerminateInstances", "iam:PassRole", "secretsmanager:GetSecretValue"], a)])])
    error_message = "COST-2A: the verifier role runs nothing on the host and changes no instance (the gs-health status line is the operator's opt-in)."
  }
}

run "alb_readiness_and_websocket_idle" {
  command = apply

  assert {
    condition     = aws_lb_target_group.pool["p1"].health_check[0].path == "/gs/readyz" && aws_lb_target_group.pool["p1"].health_check[0].matcher == "200" && aws_lb_target_group.pool["p1"].target_type == "ip" && aws_lb_target_group.pool["p1"].name == "gs-staging-p1"
    error_message = "Target health is /gs/readyz, 200 only (ip targets: awsvpc)."
  }
  assert {
    condition     = aws_lb.this[0].idle_timeout >= 120
    error_message = "The ALB idle timeout is at least 120 s (WebSockets)."
  }
  assert {
    condition     = one(aws_lb_listener_rule.gs[0].condition).path_pattern[0].values == toset(["/gs*"]) && aws_lb_listener_rule.gs[0].priority == 1000
    error_message = "/gs* (the default, priority 1000) goes to the primary pool's target group."
  }
  assert {
    condition     = one(aws_lb_listener_rule.pool["p1"].condition).path_pattern[0].values == toset(["/gs/p/p1"]) && aws_lb_listener_rule.pool["p1"].priority == 100
    error_message = "L6-2: each pool's EXACT trusted ws_path (no wildcard) is a rule of its own, before the default."
  }
}

run "edge_forwards_every_query_string" {
  command = apply

  assert {
    condition     = aws_cloudfront_origin_request_policy.gs.query_strings_config[0].query_string_behavior == "all"
    error_message = "/gs* must forward ALL query strings unchanged (cp, cr, cb, and any later protocol field) -- never an allow-list."
  }
  assert {
    condition     = length(aws_cloudfront_origin_request_policy.gs.query_strings_config[0].query_strings) == 0
    error_message = "No query-string list at all (an allow-list would drop future protocol fields)."
  }
  assert {
    condition     = aws_cloudfront_origin_request_policy.gs.cookies_config[0].cookie_behavior == "all"
    error_message = "All cookies are forwarded (the session cookie)."
  }
  assert {
    condition     = length(setsubtract(toset(["Origin", "Sec-WebSocket-Key", "Sec-WebSocket-Version"]), toset(aws_cloudfront_origin_request_policy.gs.headers_config[0].headers[0].items))) == 0
    error_message = "Origin and the WebSocket handshake headers are forwarded."
  }
  assert {
    condition = alltrue([for b in aws_cloudfront_distribution.site[0].ordered_cache_behavior :
      b.cache_policy_id == "4135ea2d-6df8-44a3-9df3-4b5a84be39ad" && b.origin_request_policy_id == aws_cloudfront_origin_request_policy.gs.id && b.target_origin_id == "gs-alb" && contains(b.allowed_methods, "POST")
    if b.path_pattern == "/gs*"]) && length([for b in aws_cloudfront_distribution.site[0].ordered_cache_behavior : b if b.path_pattern == "/gs*"]) == 1
    error_message = "The /gs* behaviour: caching disabled, the all-query origin request policy, the ALB origin, every method."
  }
}

run "network_admits_the_alb_only" {
  command = apply

  assert {
    condition = (aws_vpc_security_group_ingress_rule.task_from_alb[0].referenced_security_group_id == aws_security_group.alb[0].id
      && aws_vpc_security_group_ingress_rule.task_from_alb[0].cidr_ipv4 == null && aws_vpc_security_group_ingress_rule.task_from_alb[0].cidr_ipv6 == null
      && aws_vpc_security_group_ingress_rule.task_from_alb[0].prefix_list_id == null
    && aws_vpc_security_group_ingress_rule.task_from_alb[0].from_port == 8917 && aws_vpc_security_group_ingress_rule.task_from_alb[0].to_port == 8917)
    error_message = "The task's only ingress: the container port from the ALB's security group."
  }
  assert {
    condition     = aws_vpc_security_group_ingress_rule.alb_from_cloudfront[0].prefix_list_id == "pl-3b927c52" && aws_vpc_security_group_ingress_rule.alb_from_cloudfront[0].cidr_ipv4 == null
    error_message = "The ALB admits CloudFront's origin-facing prefix list only."
  }
  assert {
    condition     = toset([for r in aws_vpc_security_group_egress_rule.task_https : r.from_port]) == toset([443])
    error_message = "Task egress: HTTPS only (AWS APIs / endpoints and the Juno REST endpoints)."
  }
  assert {
    condition     = toset(keys(aws_vpc_endpoint.interface)) == toset(["kms", "ssm", "logs", "ecr.api", "ecr.dkr"]) && toset(keys(aws_vpc_endpoint.gateway)) == toset(["dynamodb", "s3"])
    error_message = "VPC endpoints for DynamoDB, S3 (ECR layers), KMS, SSM, Logs and ECR."
  }
}

/* ------------------------------------------------------------------ */
/* Phase B (start_services = true): stop-first services                  */
/* ------------------------------------------------------------------ */

run "services_are_stop_first_one_task_per_pool" {
  command = apply

  variables {
    start_services = true
  }

  assert {
    condition     = aws_ecs_service.pool["p1"].deployment_minimum_healthy_percent == 0 && aws_ecs_service.pool["p1"].deployment_maximum_percent == 100
    error_message = "Stop-first: minimumHealthyPercent 0 / maximumPercent 100 (two tasks of one pool fence each other)."
  }
  assert {
    condition     = aws_ecs_service.pool["p1"].availability_zone_rebalancing == "DISABLED"
    error_message = "AZ rebalancing (start-before-stop) is disabled."
  }
  assert {
    condition     = aws_ecs_service.pool["p1"].desired_count == 1 && !aws_ecs_service.pool["p1"].enable_execute_command
    error_message = "One task per pool; no ECS Exec."
  }
  assert {
    condition     = aws_ecs_service.pool["p1"].deployment_circuit_breaker[0].enable && aws_ecs_service.pool["p1"].deployment_circuit_breaker[0].rollback
    error_message = "The circuit breaker rolls back (itself stop-first)."
  }
  assert {
    condition     = length(aws_ecs_service.pool["p1"].load_balancer) == 1 && one(aws_ecs_service.pool["p1"].load_balancer).container_port == 8917 && aws_ecs_service.pool["p1"].health_check_grace_period_seconds >= 120
    error_message = "Every pool is behind its own target group, with a startup grace of at least 120 s."
  }
  assert {
    condition     = !aws_ecs_service.pool["p1"].network_configuration[0].assign_public_ip
    error_message = "No public IP on a task."
  }
}

run "a_missing_or_foreign_routing_refuses_the_services" {
  command = plan

  variables {
    start_services = true
  }

  override_data {
    target = data.aws_dynamodb_table_item.routing[0]
    values = { item = "{\"pk\":{\"S\":\"SYSTEM\"},\"sk\":{\"S\":\"ROUTING\"},\"fmt\":{\"N\":\"1\"},\"primary_pool\":{\"S\":\"p9\"},\"routing_version\":{\"N\":\"1\"},\"updated_at\":{\"N\":\"0\"},\"updated_by\":{\"S\":\"x\"},\"claim\":{\"S\":\"c\"}}" }
  }

  expect_failures = [aws_ecs_service.pool, aws_cloudwatch_metric_alarm.gs] # L6-5B: the primary-only alarms refuse the same move
}

run "two_pools_each_behind_its_own_target_group_on_its_exact_path" {
  command = apply

  variables {
    start_services = true
    pools = {
      p1 = { primary = true }
      p2 = { primary = false }
    }
  }

  override_resource {
    target = aws_lb_target_group.pool["p1"]
    values = { arn = "arn:aws:elasticloadbalancing:us-east-1:111111111111:targetgroup/gs-staging-p1/1111111111111111" }
  }
  override_resource {
    target = aws_lb_target_group.pool["p2"]
    values = { arn = "arn:aws:elasticloadbalancing:us-east-1:111111111111:targetgroup/gs-staging-p2/2222222222222222" }
  }

  assert {
    condition     = one(aws_ecs_service.pool["p2"].load_balancer).target_group_arn == aws_lb_target_group.pool["p2"].arn && one(aws_ecs_service.pool["p1"].load_balancer).target_group_arn == aws_lb_target_group.pool["p1"].arn && aws_ecs_service.pool["p2"].health_check_grace_period_seconds >= 120
    error_message = "L6-2: a non-primary pool (L6-1's router answers readiness 200) is behind ITS OWN target group -- never another pool's."
  }
  assert {
    condition     = jsondecode(aws_ssm_parameter.runtime["p2"].insecure_value) == jsondecode(file("${path.module}/../../fixtures/runtime-staging-p2.json"))
    error_message = "Each pool has its own runtime document v2 (its pool id), carrying the deployment's whole route table."
  }
  assert {
    condition     = jsondecode(aws_ssm_parameter.runtime["p1"].insecure_value).routes == jsondecode(aws_ssm_parameter.runtime["p2"].insecure_value).routes
    error_message = "Every pool's document carries the SAME trusted route table."
  }
  assert {
    condition     = { for id, r in aws_lb_listener_rule.pool : id => [r.priority, one(r.condition).path_pattern[0].values, one(r.action).target_group_arn] } == { p1 = [100, toset(["/gs/p/p1"]), aws_lb_target_group.pool["p1"].arn], p2 = [101, toset(["/gs/p/p2"]), aws_lb_target_group.pool["p2"].arn] }
    error_message = "Each pool's exact ws_path -> its own target group, in deterministic priority order (100 + sorted index)."
  }
  assert {
    condition     = one(aws_lb_listener_rule.gs[0].action).target_group_arn == aws_lb_target_group.pool["p1"].arn && alltrue([for r in aws_lb_listener_rule.pool : r.priority < aws_lb_listener_rule.gs[0].priority])
    error_message = "The /gs* default forwards to the primary's target group, AFTER every exact pool rule (no pool is shadowed)."
  }
  assert {
    condition     = aws_ecs_service.pool["p2"].deployment_maximum_percent == 100 && aws_ecs_service.pool["p2"].deployment_minimum_healthy_percent == 0
    error_message = "Every pool is stop-first."
  }
  assert {
    condition     = alltrue([for svc in aws_ecs_service.pool : !contains(keys(svc.tags), "gs:primary")])
    error_message = "Nothing on a service names the primary: a flip must never update (and so redeploy) a service."
  }
}

run "a_flip_moves_only_the_gs_rule" {
  command = apply

  variables {
    start_services = true
    pools = {
      p1 = { primary = false }
      p2 = { primary = true }
    }
  }

  override_data {
    target = data.aws_dynamodb_table_item.routing[0]
    values = { item = "{\"pk\":{\"S\":\"SYSTEM\"},\"sk\":{\"S\":\"ROUTING\"},\"fmt\":{\"N\":\"1\"},\"primary_pool\":{\"S\":\"p2\"},\"routing_version\":{\"N\":\"2\"},\"updated_at\":{\"N\":\"0\"},\"updated_by\":{\"S\":\"gamesDoctor/op:r-0000000000000000\"},\"claim\":{\"S\":\"c\"}}" }
  }
  override_resource {
    target = aws_lb_target_group.pool["p2"]
    values = { arn = "arn:aws:elasticloadbalancing:us-east-1:111111111111:targetgroup/gs-staging-p2/2222222222222222" }
  }

  assert {
    condition     = one(aws_lb_listener_rule.gs[0].action).target_group_arn == aws_lb_target_group.pool["p2"].arn
    error_message = "After the routing names p2 (gamesDoctor aws flip), primary = p2 moves the /gs* default to p2's target group."
  }
  assert {
    condition     = jsondecode(aws_ssm_parameter.runtime["p1"].insecure_value) == jsondecode(replace(file("${path.module}/../../fixtures/runtime-staging-p2.json"), "\"pool\": \"p2\"", "\"pool\": \"p1\""))
    error_message = "The documents do not depend on which pool is primary: a flip re-renders nothing a task reads (no redeploy)."
  }
}

run "a_flip_before_the_routing_moved_is_refused" {
  command = plan

  variables {
    start_services = true
    pools = {
      p1 = { primary = false }
      p2 = { primary = true }
    }
  }

  expect_failures = [aws_ecs_service.pool, aws_cloudwatch_metric_alarm.gs] # L6-5B: the primary-only alarms refuse the same move
}

run "refuses_a_drained_primary" {
  command = plan
  variables {
    pools = { p1 = { primary = true, desired_count = 0 } }
  }
  expect_failures = [var.pools]
}

/* ------------------------------------------------------------------ */
/* LIVE-6 L6-2: game-table generations side by side (L6-4 §12.1)        */
/* ------------------------------------------------------------------ */

run "generations_side_by_side_the_old_one_kept_protected" {
  state_key = "generations" # its own state: g2 is prevent_destroy (a later run without it would have to destroy it)

  command = apply

  variables {
    generation       = 2
    game_generations = [1, 2]
  }

  assert {
    condition     = toset([for g, t in aws_dynamodb_table.game : "${g}=${t.name}"]) == toset(["1=gs-staging-game-g1", "2=gs-staging-game-g2"])
    error_message = "g<N> and g<N+1> side by side: moving the serving generation never removes the old table."
  }
  assert {
    condition     = alltrue([for t in aws_dynamodb_table.game : t.deletion_protection_enabled && t.point_in_time_recovery[0].enabled && one(t.ttl).enabled && one(t.ttl).attribute_name == "ttl"])
    error_message = "Every generation (an imported restore included) is re-protected: deletion protection and PITR on, and (L6-5B) TTL on `ttl` for its TASK# items."
  }
  assert {
    condition     = jsondecode(aws_ssm_parameter.runtime["p1"].insecure_value).generation == 2 && jsondecode(aws_ssm_parameter.runtime["p1"].insecure_value).game_table == "gs-staging-game-g2"
    error_message = "The serving generation is `generation`."
  }
  assert {
    condition     = toset(one([for s in data.aws_iam_policy_document.task[0].statement : s if s.sid == "GameTableReadAndCheck"]).resources) == toset(["arn:aws:dynamodb:us-east-1:111111111111:table/gs-staging-game-g1", "arn:aws:dynamodb:us-east-1:111111111111:table/gs-staging-game-g2"])
    error_message = "The task role reaches every managed generation (g<N+1> before its tasks start; g<N> while an old task may run)."
  }
}

run "the_verifier_scans_only_the_old_generation_for_heartbeats" {
  state_key = "generations" # its own state: g2 is prevent_destroy (a later run without it would have to destroy it)

  command = plan

  variables {
    generation       = 2
    game_generations = [1, 2]
  }

  assert {
    condition     = one([for s in data.aws_iam_policy_document.bootstrap.statement : s if s.sid == "RestoreQuietOldGenerationHeartbeats"]).actions == toset(["dynamodb:Scan"]) && toset(one([for s in data.aws_iam_policy_document.bootstrap.statement : s if s.sid == "RestoreQuietOldGenerationHeartbeats"]).resources) == toset(["arn:aws:dynamodb:us-east-1:111111111111:table/gs-staging-game-g1"])
    error_message = "LIVE-6 final convergence: the certifier/verifier role scans the PREVIOUS generation's game table (its TASK# heartbeats) and nothing else."
  }
  assert {
    condition     = alltrue([for s in data.aws_iam_policy_document.bootstrap.statement : s.sid == "RestoreQuietOldGenerationHeartbeats" || !contains(s.actions, "dynamodb:Scan")])
    error_message = "No other bootstrap statement scans: never the serving table, the identity table or the ledger."
  }
  assert {
    condition     = alltrue([for s in data.aws_iam_policy_document.task[0].statement : s.sid != "RestoreQuietOldGenerationHeartbeats"]) && toset(one([for s in data.aws_iam_policy_document.task[0].statement : s if s.sid == "GameTableReadAndCheck"]).resources) == toset(["arn:aws:dynamodb:us-east-1:111111111111:table/gs-staging-game-g1", "arn:aws:dynamodb:us-east-1:111111111111:table/gs-staging-game-g2"])
    error_message = "The runtime task role gains no new authority."
  }
}

run "an_unprepared_serving_table_refuses_the_services" {
  state_key = "generations" # its own state: g2 is prevent_destroy (a later run without it would have to destroy it)

  command = plan

  variables {
    start_services   = true
    generation       = 2
    game_generations = [1, 2]
  }

  expect_failures = [aws_ecs_service.pool]
}

run "a_restored_serving_table_needs_the_gates_adoption" {
  state_key = "generations" # its own state: g2 is prevent_destroy (a later run without it would have to destroy it)

  command = plan

  variables {
    start_services   = true
    generation       = 2
    game_generations = [1, 2]
  }

  override_data {
    target = data.aws_dynamodb_table_item.generation[0]
    values = { item = "{\"generation\":{\"N\":\"2\"},\"game_table\":{\"S\":\"gs-staging-game-g2\"},\"origin\":{\"S\":\"restore\"},\"restore_id\":{\"S\":\"r-2026-10-01\"}}" }
  }

  expect_failures = [aws_ecs_service.pool]
}

run "a_restored_serving_table_with_the_gates_adoption_starts" {
  state_key = "generations" # its own state: g2 is prevent_destroy (a later run without it would have to destroy it)

  command = apply

  variables {
    start_services      = true
    generation          = 2
    game_generations    = [1, 2]
    generation_adoption = { generation = 2, game_table = "gs-staging-game-g2", restore_id = "r-2026-10-01" }
  }

  override_data {
    target = data.aws_dynamodb_table_item.generation[0]
    values = { item = "{\"generation\":{\"N\":\"2\"},\"game_table\":{\"S\":\"gs-staging-game-g2\"},\"origin\":{\"S\":\"restore\"},\"restore_id\":{\"S\":\"r-2026-10-01\"}}" }
  }

  assert {
    condition     = length(aws_ecs_service.pool) == 1
    error_message = "The adopted restore serves once the gate's attestation matches the table's marker."
  }
}

run "task_definitions_declare_the_identity_layout" {
  command = apply

  assert {
    condition     = aws_ecs_task_definition.pool["p1"].tags["gs:identity-layout"] == "2"
    error_message = "L6-4 §12.3: every revision (so every rollback target) declares the one-way identity layout."
  }
}

run "refuses_a_pre_l6_4_identity_layout" {
  command = plan
  variables {
    identity_layout_version = 1
  }
  expect_failures = [var.identity_layout_version]
}

/* ------------------------------------------------------------------ */
/* LIVE-6 L6-2: the operator and recovery roles (separate authority)   */
/* ------------------------------------------------------------------ */

run "operator_and_recovery_are_separate_roles" {
  command = apply

  variables {
    operator_trusted_principal_arns = ["arn:aws:iam::111111111111:role/ops-humans"]
    recovery_trusted_principal_arns = ["arn:aws:iam::111111111111:role/ops-breakglass"]
  }

  assert {
    condition     = aws_iam_role.operator[0].name == "gs-staging-operator" && aws_iam_role.recovery[0].name == "gs-staging-recovery"
    error_message = "The operator and recovery roles, by the names the ledger stack grants."
  }
  assert {
    condition = alltrue([for s in data.aws_iam_policy_document.operator.statement : alltrue([for a in s.actions :
    !startswith(a, "kms:") && !contains(["dynamodb:DeleteItem", "dynamodb:BatchWriteItem", "dynamodb:RestoreTableToPointInTime"], a)])])
    error_message = "The operator never signs, deletes or restores."
  }
  assert {
    condition     = toset([for c in one([for s in data.aws_iam_policy_document.operator.statement : s if s.sid == "IdentityWriterRoleRead"]).condition : "${c.test}|${c.variable}|${join(",", c.values)}"]) == toset(["ForAllValues:StringEquals|dynamodb:LeadingKeys|ROLE#identity-writer"]) && one([for s in data.aws_iam_policy_document.operator.statement : s if s.sid == "IdentityWriterRoleRead"]).actions == toset(["dynamodb:GetItem"])
    error_message = "The operator reads the identity-writer role item only -- no identity write, no session read."
  }
  assert {
    condition     = toset([for c in one([for s in data.aws_iam_policy_document.operator.statement : s if s.sid == "OperatorRunHeadsAndRunPools"]).condition : "${c.test}|${c.variable}|${join(",", c.values)}"]) == toset(["ForAllValues:StringLike|dynamodb:LeadingKeys|GAME#*,POOL#op:*", "ForAllValues:StringEquals|dynamodb:Attributes|pk,sk,owner_pool,pool_epoch,owner_task,writer_epoch,writer_task,taken_at"])
    error_message = "The operator updates HEADs and its own run pools only (never a serving pool's item), and only their ownership fields (review M5)."
  }
  assert {
    condition = alltrue([for sid, forbidden in { RoutingAndEvidence = ["generation", "game_table", "origin", "restore_id"], GameTableMarkerPrepare = ["primary_pool", "routing_version"] } :
      length(setintersection(toset(flatten([for c in one(concat([for s in data.aws_iam_policy_document.operator.statement : s if s.sid == sid], [for s in data.aws_iam_policy_document.recovery.statement : s if s.sid == sid])).condition : c.values if c.variable == "dynamodb:Attributes"])), toset(forbidden))) == 0
    && length([for c in one(concat([for s in data.aws_iam_policy_document.operator.statement : s if s.sid == sid], [for s in data.aws_iam_policy_document.recovery.statement : s if s.sid == sid])).condition : c if c.variable == "dynamodb:Attributes"]) == 1])
    error_message = "Review M5: the operator's PutItem can never carry a generation marker, the recovery role's never a routing."
  }
  assert {
    condition     = alltrue([for s in data.aws_iam_policy_document.recovery.statement : alltrue([for a in s.actions : !startswith(a, "kms:")])]) && length([for s in data.aws_iam_policy_document.recovery.statement : s if s.sid == "BreakGlassRestoreToPointInTime"]) == 0
    error_message = "The recovery role never signs; RestoreTableToPointInTime only with recovery_break_glass."
  }
  assert {
    condition     = alltrue([for s in data.aws_iam_policy_document.task[0].statement : alltrue([for a in s.actions : !contains(["dynamodb:RestoreTableToPointInTime"], a)])]) && !contains([for s in data.aws_iam_policy_document.task[0].statement : s.sid], "AppgenAdoption")
    error_message = "A serving task never holds adoption or restore authority."
  }
}

run "the_bootstrap_role_reads_relay_queues_only_by_query" {
  command = apply

  assert {
    condition     = toset([for c in one([for s in data.aws_iam_policy_document.bootstrap.statement : s if s.sid == "RelayQueueRead"]).condition : "${c.test}|${c.variable}|${join(",", c.values)}"]) == toset(["ForAllValues:StringLike|dynamodb:LeadingKeys|RELAYQ#*"]) && one([for s in data.aws_iam_policy_document.bootstrap.statement : s if s.sid == "RelayQueueRead"]).actions == toset(["dynamodb:Query"])
    error_message = "L6-2 for L6-7: the relayer-rotation gate reads RELAYQ# partitions only, read-only."
  }
}

run "no_operator_or_recovery_role_by_default" {
  command = apply

  assert {
    condition     = length(aws_iam_role.operator) == 0 && length(aws_iam_role.recovery) == 0
    error_message = "Neither role exists unless someone is named to assume it."
  }
}

run "no_escrow_no_keys_no_juno_document" {
  command = apply

  variables {
    escrow       = null
    signing_keys = null
  }

  assert {
    condition     = jsondecode(aws_ssm_parameter.runtime["p1"].insecure_value) == jsondecode(file("${path.module}/../../fixtures/runtime-staging-p1-noescrow.json"))
    error_message = "Without escrow the runtime document's escrow is null."
  }
  assert {
    condition     = length(aws_ssm_parameter.juno_backend) == 0 && alltrue([for s in data.aws_iam_policy_document.task[0].statement : alltrue([for a in s.actions : !startswith(a, "kms:")])])
    error_message = "No Juno document and no KMS permission without escrow."
  }
}

run "money_switch_is_explicit_and_non_mainnet" {
  command = apply

  variables {
    money_tables_nonmainnet = true
  }

  assert {
    condition     = contains([for e in jsondecode(aws_ecs_task_definition.pool["p1"].container_definitions)[0].environment : "${e.name}=${e.value}"], "ESCROW_MONEY_TABLES=nonmainnet")
    error_message = "The staging money switch is the only optional variable."
  }
}

run "edge_diagnostic_is_explicit_and_staging_only" {
  command = apply

  variables {
    edge_diagnostic_staging = true
  }

  assert {
    condition     = contains([for e in jsondecode(aws_ecs_task_definition.pool["p1"].container_definitions)[0].environment : "${e.name}=${e.value}"], "GS_EDGE_DIAGNOSTIC=staging")
    error_message = "LIVE-6 L6-6: the staging edge mirror is an explicit, named switch."
  }
}

run "edge_diagnostic_is_off_by_default" {
  command = apply

  assert {
    condition     = alltrue([for id, td in aws_ecs_task_definition.pool : !contains([for e in jsondecode(td.container_definitions)[0].environment : e.name], "GS_EDGE_DIAGNOSTIC")])
    error_message = "LIVE-6 L6-6: no task carries the edge mirror unless asked."
  }
}

/* ------------------------------------------------------------------ */
/* Refusals                                                             */
/* ------------------------------------------------------------------ */

run "refuses_the_edge_diagnostic_in_prod" {
  command = plan
  variables {
    environment             = "prod"
    ledger_table_arn        = "arn:aws:dynamodb:us-east-1:222222222222:table/gs-prod-ledger"
    edge_diagnostic_staging = true
  }
  expect_failures = [var.edge_diagnostic_staging]
}

run "refuses_the_edge_diagnostic_beside_mainnet_escrow" {
  command = plan
  variables {
    escrow = {
      chain_id         = "juno-1"
      network_class    = "mainnet"
      rest_endpoints   = ["https://a.example.net", "https://b.example.net"]
      contract_address = "juno1qurswpc8qurswpc8qurswpc8qurswpc8qurswpc8qurswpc8qursaq28r5"
      code_checksum    = "5ecc302221a2dab4bb4f0f71b632f2beeafe9523ebd7b33bd0e94d017b8d09e8"
      wasm_admin       = null
      denom            = "ujuno"
      asset_symbol     = "JUNO"
      relayer_address  = "juno1xc5etfhxjg4qfc9cx25qh3tvxdcf5skjj5epte"
      settlement_key   = { signer_key_id = 1, public_key_hex = "03d01115d548e7561b15c38f004d734633687cf4419620095bc5b0f47070afe85a" }
      admission_key    = { public_key_hex = "03f28773c2d975288bc7d1d205c3748651b075fbc6610e58cddeeddf8f19405aa8" }
      trust = {
        operators                 = ["juno1xc5etfhxjg4qfc9cx25qh3tvxdcf5skjj5epte"]
        resolvers                 = ["juno1wfk5fda0sg5z2lqrpwh7wexnckpe6hqzljkt4v"]
        min_challenge_window_secs = "3600"
        min_liveness_window_secs  = "3600"
        min_resolver_timeout_secs = "3600"
      }
    }
    edge_diagnostic_staging = true
  }
  expect_failures = [var.edge_diagnostic_staging]
}

run "refuses_two_primaries" {
  command = plan
  variables {
    pools = { p1 = { primary = true }, p2 = { primary = true } }
  }
  expect_failures = [var.pools]
}

run "refuses_two_tasks_in_a_pool" {
  command = plan
  variables {
    pools = { p1 = { primary = true, desired_count = 2 } }
  }
  expect_failures = [var.pools]
}

run "refuses_a_kms_alias" {
  command = plan
  variables {
    signing_keys = {
      relayer    = "arn:aws:kms:us-east-1:222222222222:alias/gs-relayer"
      settlement = "arn:aws:kms:us-east-1:222222222222:key/22222222-2222-4222-8222-222222222222"
      admission  = "arn:aws:kms:us-east-1:222222222222:key/33333333-3333-4333-8333-333333333333"
    }
  }
  expect_failures = [var.signing_keys]
}

run "refuses_a_mainnet_money_switch" {
  command = plan
  variables {
    escrow = {
      chain_id         = "juno-1"
      network_class    = "mainnet"
      rest_endpoints   = ["https://a.example.net", "https://b.example.net"]
      contract_address = "juno1qurswpc8qurswpc8qurswpc8qurswpc8qurswpc8qurswpc8qursaq28r5"
      code_checksum    = "5ecc302221a2dab4bb4f0f71b632f2beeafe9523ebd7b33bd0e94d017b8d09e8"
      wasm_admin       = null
      denom            = "ujuno"
      asset_symbol     = "JUNO"
      relayer_address  = "juno1xc5etfhxjg4qfc9cx25qh3tvxdcf5skjj5epte"
      settlement_key   = { signer_key_id = 1, public_key_hex = "03d01115d548e7561b15c38f004d734633687cf4419620095bc5b0f47070afe85a" }
      admission_key    = { public_key_hex = "03f28773c2d975288bc7d1d205c3748651b075fbc6610e58cddeeddf8f19405aa8" }
      trust = {
        operators                 = ["juno1xc5etfhxjg4qfc9cx25qh3tvxdcf5skjj5epte"]
        resolvers                 = ["juno1wfk5fda0sg5z2lqrpwh7wexnckpe6hqzljkt4v"]
        min_challenge_window_secs = "3600"
        min_liveness_window_secs  = "3600"
        min_resolver_timeout_secs = "3600"
      }
    }
    money_tables_nonmainnet = true
  }
  expect_failures = [var.money_tables_nonmainnet]
}

run "refuses_a_short_grace_or_idle_timeout" {
  command = plan
  variables {
    health_check_grace_period_seconds = 60
    alb                               = { certificate_arn = "arn:aws:acm:us-east-1:111111111111:certificate/44444444-4444-4444-8444-444444444444", idle_timeout_seconds = 60 }
  }
  expect_failures = [var.health_check_grace_period_seconds, var.alb]
}

run "refuses_another_environments_ledger" {
  command = plan
  variables {
    ledger_table_arn = "arn:aws:dynamodb:us-east-1:222222222222:table/gs-prod-ledger"
  }
  expect_failures = [var.ledger_table_arn]
}

run "refuses_escrow_without_signing_keys" {
  command = plan
  variables {
    signing_keys = null
  }
  expect_failures = [aws_ssm_parameter.runtime, aws_ssm_parameter.juno_backend]
}

/* ------------------------------------------------------------------ */
/* LIVE-6 relayer rotation: `relayer_rotation_key_arns`                 */
/* ------------------------------------------------------------------ */
# The ledger stack's relayer_key_arns: r1 = 1111... (the configured relayer in `variables` above), r2 = 6666... (prepared).

run "ordinary_deployment_reads_and_signs_exactly_the_three_keys" {
  command = apply

  assert {
    condition = alltrue([for sid in ["SigningKeysPublicKey", "SigningKeysSignDigestOnly"] : toset(one([for s in data.aws_iam_policy_document.task[0].statement : s if s.sid == sid]).resources) == toset([
      "arn:aws:kms:us-east-1:222222222222:key/11111111-1111-4111-8111-111111111111",
      "arn:aws:kms:us-east-1:222222222222:key/22222222-2222-4222-8222-222222222222",
      "arn:aws:kms:us-east-1:222222222222:key/33333333-3333-4333-8333-333333333333",
    ])])
    error_message = "The task role reaches exactly the three configured keys."
  }
  assert {
    condition     = toset(one([for s in data.aws_iam_policy_document.bootstrap.statement : s if s.sid == "SigningKeysReadOnly"]).resources) == toset(values(var.signing_keys))
    error_message = "No rotation: the bootstrap role reads exactly the three configured keys (L5-8, unchanged)."
  }
  assert {
    condition     = length([for s in data.aws_iam_policy_document.bootstrap.statement : s if startswith(s.sid, "RelayerRotation")]) == 0
    error_message = "No rotation: no rotation-proof read exists (an ordinary one-relayer deployment's policies are unchanged)."
  }
}

run "prepared_rotation_reads_the_new_key_and_signs_with_the_old" {
  command = apply
  variables {
    relayer_rotation_key_arns = ["arn:aws:kms:us-east-1:222222222222:key/66666666-6666-4666-8666-666666666666"]
  }

  assert {
    condition = alltrue([for sid in ["SigningKeysPublicKey", "SigningKeysSignDigestOnly"] : toset(one([for s in data.aws_iam_policy_document.task[0].statement : s if s.sid == sid]).resources) == toset([
      "arn:aws:kms:us-east-1:222222222222:key/11111111-1111-4111-8111-111111111111",
      "arn:aws:kms:us-east-1:222222222222:key/22222222-2222-4222-8222-222222222222",
      "arn:aws:kms:us-east-1:222222222222:key/33333333-3333-4333-8333-333333333333",
    ])])
    error_message = "Prepared, not switched: the task role still signs with exactly the configured keys -- never the prepared one."
  }
  assert {
    condition = toset(one([for s in data.aws_iam_policy_document.bootstrap.statement : s if s.sid == "SigningKeysReadOnly"]).resources) == toset([
      "arn:aws:kms:us-east-1:222222222222:key/11111111-1111-4111-8111-111111111111",
      "arn:aws:kms:us-east-1:222222222222:key/22222222-2222-4222-8222-222222222222",
      "arn:aws:kms:us-east-1:222222222222:key/33333333-3333-4333-8333-333333333333",
      "arn:aws:kms:us-east-1:222222222222:key/66666666-6666-4666-8666-666666666666",
    ]) && one([for s in data.aws_iam_policy_document.bootstrap.statement : s if s.sid == "SigningKeysReadOnly"]).actions == toset(["kms:DescribeKey", "kms:GetPublicKey", "kms:ListGrants"])
    error_message = "The old and the new relayer key identities are both readable by the verifier (signer-keys derives the new address before anything switches) -- read only."
  }
  assert {
    condition = (one([for s in data.aws_iam_policy_document.bootstrap.statement : s if s.sid == "RelayerRotationProofGameRead"]).actions == toset(["dynamodb:GetItem"])
      && toset(one([for s in data.aws_iam_policy_document.bootstrap.statement : s if s.sid == "RelayerRotationProofGameRead"]).resources) == toset(["arn:aws:dynamodb:us-east-1:111111111111:table/gs-staging-game-g1"])
      && toset([for c in one([for s in data.aws_iam_policy_document.bootstrap.statement : s if s.sid == "RelayerRotationProofGameRead"]).condition : "${c.test}|${c.variable}|${join(",", c.values)}"]) == toset(["ForAllValues:StringLike|dynamodb:LeadingKeys|ROLE#relayer#*,POOL#*,TASK#*"])
      && one([for s in data.aws_iam_policy_document.bootstrap.statement : s if s.sid == "RelayerRotationProofFenceRead"]).actions == toset(["dynamodb:GetItem"])
      && toset(one([for s in data.aws_iam_policy_document.bootstrap.statement : s if s.sid == "RelayerRotationProofFenceRead"]).resources) == toset(["arn:aws:dynamodb:us-east-1:222222222222:table/gs-staging-ledger"])
    && toset([for c in one([for s in data.aws_iam_policy_document.bootstrap.statement : s if s.sid == "RelayerRotationProofFenceRead"]).condition : "${c.test}|${c.variable}|${join(",", c.values)}"]) == toset(["ForAllValues:StringLike|dynamodb:LeadingKeys|FENCE#relayer#*"]))
    error_message = "The post-rotation proof's reads: GetItem only -- the serving table's ROLE#relayer#*, POOL#*, TASK#* and the ledger's FENCE#relayer#*."
  }
  assert {
    condition     = jsondecode(aws_ssm_parameter.juno_backend[0].insecure_value) == jsondecode(file("${path.module}/../../fixtures/juno-backend-staging.json"))
    error_message = "Preparing changes no document: the Juno configuration still names the old relayer key and address."
  }
}

run "switched_rotation_signs_with_the_new_key_and_keeps_the_old_readable" {
  command = apply
  variables {
    signing_keys = {
      relayer    = "arn:aws:kms:us-east-1:222222222222:key/66666666-6666-4666-8666-666666666666"
      settlement = "arn:aws:kms:us-east-1:222222222222:key/22222222-2222-4222-8222-222222222222"
      admission  = "arn:aws:kms:us-east-1:222222222222:key/33333333-3333-4333-8333-333333333333"
    }
    relayer_rotation_key_arns = ["arn:aws:kms:us-east-1:222222222222:key/11111111-1111-4111-8111-111111111111"]
  }

  assert {
    condition = alltrue([for sid in ["SigningKeysPublicKey", "SigningKeysSignDigestOnly"] : toset(one([for s in data.aws_iam_policy_document.task[0].statement : s if s.sid == sid]).resources) == toset([
      "arn:aws:kms:us-east-1:222222222222:key/66666666-6666-4666-8666-666666666666",
      "arn:aws:kms:us-east-1:222222222222:key/22222222-2222-4222-8222-222222222222",
      "arn:aws:kms:us-east-1:222222222222:key/33333333-3333-4333-8333-333333333333",
    ])])
    error_message = "Switched: the task role signs with the NEW relayer key and the unchanged settlement and admission keys -- the old relayer key is gone from it."
  }
  assert {
    condition     = contains(one([for s in data.aws_iam_policy_document.bootstrap.statement : s if s.sid == "SigningKeysReadOnly"]).resources, "arn:aws:kms:us-east-1:222222222222:key/11111111-1111-4111-8111-111111111111") && length(one([for s in data.aws_iam_policy_document.bootstrap.statement : s if s.sid == "SigningKeysReadOnly"]).resources) == 4
    error_message = "The previous relayer key stays readable by the verifier (rollback), and nothing more."
  }
  assert {
    condition = (jsondecode(aws_ssm_parameter.juno_backend[0].insecure_value).relayer.signer.key_ref == "arn:aws:kms:us-east-1:222222222222:key/66666666-6666-4666-8666-666666666666"
      && jsondecode(aws_ssm_parameter.juno_backend[0].insecure_value).settlement_key == jsondecode(file("${path.module}/../../fixtures/juno-backend-staging.json")).settlement_key
    && jsondecode(aws_ssm_parameter.juno_backend[0].insecure_value).admission_key == jsondecode(file("${path.module}/../../fixtures/juno-backend-staging.json")).admission_key)
    error_message = "The Juno configuration's relayer signer moves to the new key; the settlement and admission keys (key refs and public keys) are byte-identical."
  }
}

run "refuses_a_rotation_key_alias" {
  command = plan
  variables {
    relayer_rotation_key_arns = ["arn:aws:kms:us-east-1:222222222222:alias/gs-relayer-r2"]
  }
  expect_failures = [var.relayer_rotation_key_arns]
}

run "refuses_a_configured_key_as_a_rotation_key" {
  command = plan
  variables {
    relayer_rotation_key_arns = ["arn:aws:kms:us-east-1:222222222222:key/22222222-2222-4222-8222-222222222222"]
  }
  expect_failures = [var.relayer_rotation_key_arns]
}

run "refuses_the_configured_relayer_as_its_own_rotation_key" {
  command = plan
  variables {
    relayer_rotation_key_arns = ["arn:aws:kms:us-east-1:222222222222:key/11111111-1111-4111-8111-111111111111"]
  }
  expect_failures = [var.relayer_rotation_key_arns]
}

run "refuses_a_rotation_key_in_another_region_or_twice" {
  command = plan
  variables {
    relayer_rotation_key_arns = ["arn:aws:kms:us-west-2:222222222222:key/66666666-6666-4666-8666-666666666666", "arn:aws:kms:us-west-2:222222222222:key/66666666-6666-4666-8666-666666666666"]
  }
  expect_failures = [var.relayer_rotation_key_arns]
}

run "refuses_a_rotation_without_signing_keys" {
  command = plan
  variables {
    escrow                    = null
    signing_keys              = null
    relayer_rotation_key_arns = ["arn:aws:kms:us-east-1:222222222222:key/66666666-6666-4666-8666-666666666666"]
  }
  expect_failures = [var.relayer_rotation_key_arns]
}
