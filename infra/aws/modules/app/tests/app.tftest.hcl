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
    defaults = { item = "{\"pk\":{\"S\":\"SYSTEM\"},\"sk\":{\"S\":\"ROUTING\"},\"fmt\":{\"N\":\"1\"},\"primary_pool\":{\"S\":\"p1\"},\"routing_version\":{\"N\":\"1\"},\"updated_at\":{\"N\":\"0\"},\"updated_by\":{\"S\":\"test\"},\"claim\":{\"S\":\"c\"}}" }
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
    condition     = aws_dynamodb_table.game.name == "gs-staging-game-g1" && aws_dynamodb_table.identity.name == "gs-staging-identity"
    error_message = "Table names must be gs-<env>-game-g<N> and gs-<env>-identity."
  }
  assert {
    condition = alltrue([for t in [aws_dynamodb_table.game, aws_dynamodb_table.identity] :
      t.hash_key == "pk" && t.range_key == "sk" && t.billing_mode == "PAY_PER_REQUEST" && t.deletion_protection_enabled
      && toset([for a in t.attribute : "${a.name}:${a.type}"]) == toset(["pk:S", "sk:S"])
      && length(t.global_secondary_index) == 0 && length(t.local_secondary_index) == 0 && length(t.replica) == 0
      && t.point_in_time_recovery[0].enabled
    ])
    error_message = "Both tables: string pk/sk, on-demand, deletion protection, PITR, no GSI/LSI, never a Global Table."
  }
  assert {
    condition     = length([for t in aws_dynamodb_table.game.ttl : t if t.enabled]) == 0
    error_message = "The game table has no TTL."
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
    condition = { for s in data.aws_iam_policy_document.task.statement : s.sid => toset(s.actions) } == {
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
    condition     = alltrue([for s in data.aws_iam_policy_document.task.statement : !contains(s.resources, "*")])
    error_message = "The task role has no '*' resource."
  }
  assert {
    condition     = alltrue([for s in concat(data.aws_iam_policy_document.task.statement, data.aws_iam_policy_document.execution.statement) : alltrue([for a in s.actions : !startswith(a, "secretsmanager:") && !startswith(a, "ssmmessages:")])])
    error_message = "No Secrets Manager permission (no consumer yet) and no ECS Exec channel."
  }
  assert {
    condition     = toset(one([for s in data.aws_iam_policy_document.task.statement : s if s.sid == "LedgerReadAndCheck"]).resources) == toset(["arn:aws:dynamodb:us-east-1:222222222222:table/gs-staging-ledger"])
    error_message = "The ledger is granted by its full (cross-account) table ARN."
  }
  assert {
    condition = toset([for c in one([for s in data.aws_iam_policy_document.task.statement : s if s.sid == "SigningKeysSignDigestOnly"]).condition : "${c.test}|${c.variable}|${join(",", c.values)}"]) == toset([
      "StringEquals|kms:SigningAlgorithm|ECDSA_SHA_256", "StringEquals|kms:MessageType|DIGEST",
    ])
    error_message = "kms:Sign only with ECDSA_SHA_256 over a DIGEST."
  }
  assert {
    condition = alltrue([
      for sid, key in { GameTableWriteNeverSystem = "SYSTEM", LedgerAppendNeverAppgen = "APPGEN" } :
      toset([for c in one([for s in data.aws_iam_policy_document.task.statement : s if s.sid == sid]).condition : "${c.test}|${c.variable}|${join(",", c.values)}"]) == toset(["ForAllValues:StringNotEquals|dynamodb:LeadingKeys|${key}"])
    ])
    error_message = "The task never writes SYSTEM/* (routing) or APPGEN."
  }
  assert {
    condition     = toset(one([for s in data.aws_iam_policy_document.task.statement : s if s.sid == "ReadRuntimeConfiguration"]).resources) == toset(["arn:aws:ssm:us-east-1:111111111111:parameter/gs/staging/runtime/p1", "arn:aws:ssm:us-east-1:111111111111:parameter/gs/staging/juno-backend"])
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
    error_message = "The bootstrap role cannot sign, update, delete or scan."
  }
  assert {
    condition     = alltrue([for s in data.aws_iam_policy_document.bootstrap.statement : alltrue([for a in s.actions : !contains(["ecs:RunTask", "ecs:StartTask", "ecs:UpdateService", "ecs:StopTask", "logs:GetLogEvents", "iam:PassRole"], a)])])
    error_message = "LIVE-6 L6-6: the bootstrap/verify role reads the staging captures; it can start, change or stop no task."
  }
  assert {
    condition     = aws_iam_role.bootstrap.name == "gs-staging-bootstrap" && aws_iam_role.task.name == "gs-staging-app-task" && aws_iam_role.execution.name == "gs-staging-app-execution"
    error_message = "Role names are the ones the ledger stack grants."
  }
}

run "alb_readiness_and_websocket_idle" {
  command = apply

  assert {
    condition     = aws_lb_target_group.primary.health_check[0].path == "/gs/readyz" && aws_lb_target_group.primary.health_check[0].matcher == "200" && aws_lb_target_group.primary.target_type == "ip"
    error_message = "Target health is /gs/readyz, 200 only (ip targets: awsvpc)."
  }
  assert {
    condition     = aws_lb.this.idle_timeout >= 120
    error_message = "The ALB idle timeout is at least 120 s (WebSockets)."
  }
  assert {
    condition     = one(aws_lb_listener_rule.gs.condition).path_pattern[0].values == toset(["/gs*"])
    error_message = "/gs* goes to the primary pool's target group."
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
    condition = (aws_vpc_security_group_ingress_rule.task_from_alb.referenced_security_group_id == aws_security_group.alb.id
      && aws_vpc_security_group_ingress_rule.task_from_alb.cidr_ipv4 == null && aws_vpc_security_group_ingress_rule.task_from_alb.cidr_ipv6 == null
      && aws_vpc_security_group_ingress_rule.task_from_alb.prefix_list_id == null
    && aws_vpc_security_group_ingress_rule.task_from_alb.from_port == 8917 && aws_vpc_security_group_ingress_rule.task_from_alb.to_port == 8917)
    error_message = "The task's only ingress: the container port from the ALB's security group."
  }
  assert {
    condition     = aws_vpc_security_group_ingress_rule.alb_from_cloudfront.prefix_list_id == "pl-3b927c52" && aws_vpc_security_group_ingress_rule.alb_from_cloudfront.cidr_ipv4 == null
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
    error_message = "The primary is behind the target group, with a startup grace of at least 120 s."
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

  expect_failures = [aws_ecs_service.pool]
}

run "two_pools_only_the_primary_behind_the_alb" {
  command = apply

  variables {
    start_services = true
    pools = {
      p1 = { primary = true }
      p2 = { primary = false }
    }
  }

  assert {
    condition     = length(aws_ecs_service.pool["p2"].load_balancer) == 0 && aws_ecs_service.pool["p2"].health_check_grace_period_seconds == null
    error_message = "A standby answers /gs/readyz 503 forever: it is never behind the ALB."
  }
  assert {
    condition     = jsondecode(aws_ssm_parameter.runtime["p2"].insecure_value) == jsondecode(file("${path.module}/../../fixtures/runtime-staging-p2.json"))
    error_message = "Each pool has its own runtime document (its pool id)."
  }
  assert {
    condition     = aws_ecs_service.pool["p2"].deployment_maximum_percent == 100 && aws_ecs_service.pool["p2"].deployment_minimum_healthy_percent == 0
    error_message = "Every pool is stop-first."
  }
  assert {
    condition     = aws_lb_target_group.primary.name == "gs-staging-primary" && aws_lb_target_group.primary.tags["gs:pool"] == "p1"
    error_message = "The target group is the primary pool's (a stable name; the pool is its tag)."
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
    condition     = length(aws_ssm_parameter.juno_backend) == 0 && alltrue([for s in data.aws_iam_policy_document.task.statement : alltrue([for a in s.actions : !startswith(a, "kms:")])])
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
