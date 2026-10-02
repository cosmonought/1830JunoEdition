# COST-1: the app module with compute = "none" -- the single host serves; this stack keeps only the authorities and the
# edge. Over a MOCKED provider (no AWS account, no credentials). The mocks and variables are app.tftest.hcl's.
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

run "none_keeps_the_authorities_and_the_edge" {
  command = plan
  variables {
    compute = "none"
    pools   = { p1 = { primary = true } }
    edge = {
      create_distribution     = true
      aliases                 = ["play.example.com"]
      viewer_certificate_arn  = "arn:aws:acm:us-east-1:111111111111:certificate/55555555-5555-4555-8555-555555555555"
      site_origin_domain_name = "site-origin.example.com"
      alb_origin_domain_name  = "gs-origin.example.com" # COST-1: now the single host's Caddy origin
    }
  }

  # --- kept: the authorities, the documents, the image repository, the operator roles, the edge
  assert {
    condition     = aws_dynamodb_table.game["1"].deletion_protection_enabled && aws_dynamodb_table.identity.deletion_protection_enabled && aws_dynamodb_table.game["1"].point_in_time_recovery[0].enabled
    error_message = "the game and identity tables stay, protected, PITR on"
  }
  assert {
    condition     = length(aws_ssm_parameter.runtime) == 1 && jsondecode(aws_ssm_parameter.runtime["p1"].insecure_value).routes == { p1 = { ws_path = "/gs/p/p1" } }
    error_message = "one pool's runtime document v2, its route table naming only p1"
  }
  assert {
    condition     = length(aws_ssm_parameter.juno_backend) == 1
    error_message = "the Juno document stays (escrow configured)"
  }
  assert {
    condition     = aws_ecr_repository.server.image_tag_mutability == "IMMUTABLE"
    error_message = "the image repository stays (the host pulls from it)"
  }
  assert {
    condition     = aws_iam_role.bootstrap.name == "gs-staging-bootstrap"
    error_message = "the bootstrap / verify role stays (deploy authority is never the app's)"
  }
  assert {
    condition     = length(aws_cloudfront_distribution.site) == 1 && one([for o in aws_cloudfront_distribution.site[0].origin : o.domain_name if o.origin_id == "gs-alb"]) == "gs-origin.example.com"
    error_message = "the SAME distribution; its /gs* origin is the single host's origin name"
  }
  assert {
    condition     = length([for b in aws_cloudfront_distribution.site[0].ordered_cache_behavior : b if b.path_pattern == "/gs*" && b.target_origin_id == "gs-alb" && b.cache_policy_id == "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"]) == 1 && aws_cloudfront_origin_request_policy.gs.query_strings_config[0].query_string_behavior == "all"
    error_message = "the /gs* behaviour keeps its policy: ALL query strings, cookies, Origin + WebSocket headers"
  }

  # --- gone: every ECS-era fixed-cost resource
  assert {
    condition     = length(aws_lb.this) == 0 && length(aws_lb_listener.https) == 0 && length(aws_lb_target_group.pool) == 0 && length(aws_lb_listener_rule.pool) == 0 && length(aws_lb_listener_rule.gs) == 0
    error_message = "no ALB, listener, target group or rule"
  }
  assert {
    condition     = length(aws_ecs_cluster.this) == 0 && length(aws_ecs_service.pool) == 0 && length(aws_ecs_task_definition.pool) == 0 && length(aws_cloudwatch_log_group.pool) == 0
    error_message = "no ECS cluster (no Container Insights), service, task definition or pool log group"
  }
  assert {
    condition     = length(aws_vpc_endpoint.interface) == 0 && length(aws_vpc_endpoint.gateway) == 0 && length(aws_security_group.endpoints) == 0
    error_message = "no VPC endpoint"
  }
  assert {
    condition     = length(aws_security_group.alb) == 0 && length(aws_security_group.task) == 0 && length(aws_vpc_security_group_egress_rule.task_https) == 0
    error_message = "no ALB / task security group"
  }
  assert {
    condition     = length(aws_iam_role.task) == 0 && length(aws_iam_role.execution) == 0
    error_message = "no ECS task / execution role (the host has its own, stacks/single-host)"
  }
  assert {
    condition     = length(aws_cloudwatch_metric_alarm.gs) == 0 && length(aws_cloudwatch_metric_alarm.flip_window) == 0 && length(aws_cloudwatch_composite_alarm.notify) == 0
    error_message = "no L6-5B alarm matrix (the single host has its own five alarms)"
  }
  assert {
    condition     = output.load_balancer_arn == null && output.cluster_name == null && output.alarms == {}
    error_message = "the ECS-era outputs are null"
  }
}

run "none_needs_no_alb_or_task_subnets" {
  command = plan
  variables {
    compute = "none"
    pools   = { p1 = { primary = true } }
    network = {
      vpc_id          = "vpc-0123456789abcdef0"
      task_subnet_ids = []
      alb_subnet_ids  = []
    }
  }
  assert {
    condition     = length(aws_lb.this) == 0
    error_message = "compute none needs no ECS-era network"
  }
}

run "ecs_still_needs_two_alb_subnets" {
  command = plan
  variables {
    network = {
      vpc_id          = "vpc-0123456789abcdef0"
      task_subnet_ids = ["subnet-0aaaaaaaaaaaaaaa1"]
      alb_subnet_ids  = ["subnet-0bbbbbbbbbbbbbbb1"]
    }
  }
  expect_failures = [var.network]
}

run "compute_is_ecs_or_none" {
  command = plan
  variables {
    compute = "fargate"
  }
  expect_failures = [var.compute]
}

run "none_with_the_host_serving_keeps_the_generation_gates" {
  command = apply

  override_data {
    target = data.aws_dynamodb_table_item.routing[0]
    values = { item = "{\"pk\":{\"S\":\"SYSTEM\"},\"sk\":{\"S\":\"ROUTING\"},\"fmt\":{\"N\":\"1\"},\"primary_pool\":{\"S\":\"p1\"},\"routing_version\":{\"N\":\"1\"},\"updated_at\":{\"N\":\"0\"},\"updated_by\":{\"S\":\"x\"},\"claim\":{\"S\":\"c\"}}" }
  }
  override_data {
    target = data.aws_dynamodb_table_item.generation[0]
    values = { item = "{\"pk\":{\"S\":\"SYSTEM\"},\"sk\":{\"S\":\"GENERATION\"},\"generation\":{\"N\":\"1\"},\"game_table\":{\"S\":\"gs-staging-game-g1\"},\"origin\":{\"S\":\"bootstrap\"},\"restore_id\":{\"NULL\":true}}" }
  }
  variables {
    compute        = "none"
    start_services = true
    pools          = { p1 = { primary = true } }
  }
  assert {
    condition     = local.marker_names_this && local.routing_primary == "p1" && local.marker_adoption_ok
    error_message = "the plan reads the routing and the generation marker (the mock: p1, g1 bootstrap) and passes"
  }
}

run "none_refuses_a_document_for_an_unprepared_generation" {
  command   = apply
  state_key = "unprepared-g2"

  override_data {
    target = data.aws_dynamodb_table_item.routing[0]
    values = { item = "{\"pk\":{\"S\":\"SYSTEM\"},\"sk\":{\"S\":\"ROUTING\"},\"fmt\":{\"N\":\"1\"},\"primary_pool\":{\"S\":\"p1\"},\"routing_version\":{\"N\":\"1\"},\"updated_at\":{\"N\":\"0\"},\"updated_by\":{\"S\":\"x\"},\"claim\":{\"S\":\"c\"}}" }
  }
  override_data {
    target = data.aws_dynamodb_table_item.generation[0]
    values = { item = "{\"pk\":{\"S\":\"SYSTEM\"},\"sk\":{\"S\":\"GENERATION\"},\"generation\":{\"N\":\"1\"},\"game_table\":{\"S\":\"gs-staging-game-g1\"},\"origin\":{\"S\":\"bootstrap\"},\"restore_id\":{\"NULL\":true}}" }
  }
  variables {
    compute          = "none"
    start_services   = true
    pools            = { p1 = { primary = true } }
    generation       = 2
    game_generations = [1, 2]
  }
  expect_failures = [aws_ssm_parameter.runtime]
}

run "none_refuses_a_routing_naming_another_pool" {
  command   = apply
  state_key = "foreign-routing"

  override_data {
    target = data.aws_dynamodb_table_item.routing[0]
    values = { item = "{\"pk\":{\"S\":\"SYSTEM\"},\"sk\":{\"S\":\"ROUTING\"},\"fmt\":{\"N\":\"1\"},\"primary_pool\":{\"S\":\"p1\"},\"routing_version\":{\"N\":\"1\"},\"updated_at\":{\"N\":\"0\"},\"updated_by\":{\"S\":\"x\"},\"claim\":{\"S\":\"c\"}}" }
  }
  override_data {
    target = data.aws_dynamodb_table_item.generation[0]
    values = { item = "{\"pk\":{\"S\":\"SYSTEM\"},\"sk\":{\"S\":\"GENERATION\"},\"generation\":{\"N\":\"1\"},\"game_table\":{\"S\":\"gs-staging-game-g1\"},\"origin\":{\"S\":\"bootstrap\"},\"restore_id\":{\"NULL\":true}}" }
  }
  variables {
    compute        = "none"
    start_services = true
    pools          = { p2 = { primary = true } }
  }
  expect_failures = [aws_ssm_parameter.runtime]
}
