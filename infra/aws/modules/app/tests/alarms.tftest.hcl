# LIVE-6 L6-5B: the alarms, the TASK# TTL and the planned-flip suppression -- PLAN only, over a MOCKED provider.
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
/* PART D: TASK# TTL on every managed game generation                   */
/* ------------------------------------------------------------------ */

run "task_ttl_on_every_managed_game_generation_and_identity_unchanged" {
  command = plan

  variables {
    game_generations = [1, 2, 3]
  }

  assert {
    condition     = length(aws_dynamodb_table.game) == 3 && alltrue([for g, t in aws_dynamodb_table.game : length(t.ttl) == 1 && one(t.ttl).enabled && one(t.ttl).attribute_name == "ttl"])
    error_message = "Every managed game-table generation (a straggler of an old generation writes its TASK# heartbeat into ITS table) has TTL on exactly `ttl`."
  }
  assert {
    condition     = length(aws_dynamodb_table.identity.ttl) == 1 && one(aws_dynamodb_table.identity.ttl).enabled && one(aws_dynamodb_table.identity.ttl).attribute_name == "ttl"
    error_message = "The identity table's TTL (grants, commit markers) is unchanged: enabled on `ttl`."
  }
  assert {
    condition     = alltrue([for g, t in aws_dynamodb_table.game : one(t.point_in_time_recovery).enabled && t.deletion_protection_enabled])
    error_message = "TTL changes nothing else about a game table (PITR and deletion protection stay on)."
  }
}

/* ------------------------------------------------------------------ */
/* PART E / F / I / J: the alarms                                       */
/* ------------------------------------------------------------------ */

run "every_contract_alarm_exists_with_stable_names_before_the_services" {
  command = plan

  assert {
    condition = toset(keys(aws_cloudwatch_metric_alarm.gs)) == toset([
      "a1-unexpected-task-loss", "a3-store-uncertain", "a3-store-restart-loop", "a4-startup-refused", "a4g-generation-refused", "a4i-identity-restore-refused",
      "a5c-money-sweep-passes-failing", "a6b-relayer-takeover-not-taken", "a8-kms-refused", "a9-kms-invalid-answer", "a10-signer-unavailable", "r1-generation-lost", "r2-money-journal-ahead",
      "p1/a2-writer-epoch-conflict", "p1/a5-money-sweep-stale", "p1/a5b-money-sweep-games-failing", "p1/a11-readiness-flapping", "p1/a12-prolonged-unready", "p1/a12b-pool-writer-unconfirmed",
      "p1/a14-task-status-write-failures", "p1/a15-relayer-paging", "p1/r3-restore-unverified",
      "primary/a6-relayer-unusable", "primary/a7-escrow-inactive",
    ])
    error_message = "The contract's alarms, by scope; the heartbeat (A13, missing = breaching) only once the services run."
  }
  assert {
    condition     = aws_cloudwatch_metric_alarm.gs["a1-unexpected-task-loss"].alarm_name == "gs-staging-a1-unexpected-task-loss" && aws_cloudwatch_metric_alarm.gs["p1/a12-prolonged-unready"].alarm_name == "gs-staging-p1-a12-prolonged-unready" && aws_cloudwatch_metric_alarm.gs["primary/a6-relayer-unusable"].alarm_name == "gs-staging-primary-a6-relayer-unusable"
    error_message = "Stable names: gs-<env>-<id>, gs-<env>-<pool>-<id>, gs-<env>-primary-<id>."
  }
  assert {
    condition     = output.alarm_namespace == "18Cosmos/GameServer" && alltrue([for k, a in aws_cloudwatch_metric_alarm.gs : alltrue([for q in a.metric_query : length(q.metric) == 0 || one(q.metric).namespace == "18Cosmos/GameServer"])])
    error_message = "Every alarm reads L6-5A's namespace, 18Cosmos/GameServer."
  }
}

run "dimensions_are_environment_and_pool_only_and_no_alarm_is_per_task" {
  command = plan

  variables {
    start_services = true
    pools = {
      p1 = { primary = true }
      p2 = { primary = false }
      p3 = { primary = false, desired_count = 0 }
    }
  }

  assert {
    condition = alltrue([for k, a in aws_cloudwatch_metric_alarm.gs : alltrue([for q in a.metric_query : length(q.metric) == 0 || (
      toset(keys(one(q.metric).dimensions)) == toset(["Environment"]) || toset(keys(one(q.metric).dimensions)) == toset(["Environment", "Pool"])
    )])])
    error_message = "No Task, Build, Generation, Epoch, Game, Principal, Wallet, Key ARN or condition code is ever an alarm dimension: [Environment] or [Environment, Pool] only."
  }
  assert {
    condition     = alltrue([for k, a in aws_cloudwatch_metric_alarm.gs : alltrue([for q in a.metric_query : length(q.metric) == 0 || (one(q.metric).dimensions.Environment == "staging" && contains(["p1", "p2", "p3"], lookup(one(q.metric).dimensions, "Pool", "p1")))])])
    error_message = "Dimension values are the environment label and a pool id -- never a task id, a build or an ARN."
  }
  assert {
    condition     = length(aws_cloudwatch_metric_alarm.gs) == 13 + 3 * 9 + 3 && length(aws_cloudwatch_metric_alarm.flip_window) == 3 && length(aws_cloudwatch_composite_alarm.notify) == 3 * 3 + 2
    error_message = "Per environment 13, per pool 9 (a drained pool too: it simply has no data), 3 for the primary, one suppressor per pool: nothing per task."
  }
  assert {
    condition     = alltrue([for k, a in aws_cloudwatch_metric_alarm.gs : a.threshold >= 0 && a.evaluation_periods >= 1 && a.datapoints_to_alarm <= a.evaluation_periods])
    error_message = "Well-formed thresholds and evaluation windows."
  }
}

run "a1_counts_every_loss_but_a_proven_supersession" {
  command = plan

  assert {
    condition = (
      one([for q in aws_cloudwatch_metric_alarm.gs["a1-unexpected-task-loss"].metric_query : q if q.id == "e1"]).expression == "FILL(m1, 0) - FILL(m2, 0)"
      && one([for q in aws_cloudwatch_metric_alarm.gs["a1-unexpected-task-loss"].metric_query : q if q.id == "e1"]).return_data
      && one(one([for q in aws_cloudwatch_metric_alarm.gs["a1-unexpected-task-loss"].metric_query : q if q.id == "m1"]).metric).metric_name == "TaskLost"
      && one(one([for q in aws_cloudwatch_metric_alarm.gs["a1-unexpected-task-loss"].metric_query : q if q.id == "m2"]).metric).metric_name == "TaskSuperseded"
      && !one([for q in aws_cloudwatch_metric_alarm.gs["a1-unexpected-task-loss"].metric_query : q if q.id == "m1"]).return_data
      && one(one([for q in aws_cloudwatch_metric_alarm.gs["a1-unexpected-task-loss"].metric_query : q if q.id == "m1"]).metric).dimensions.Environment == "staging"
      && length(one(one([for q in aws_cloudwatch_metric_alarm.gs["a1-unexpected-task-loss"].metric_query : q if q.id == "m1"]).metric).dimensions) == 1
    )
    error_message = "A1 = TaskLost - TaskSuperseded at [Environment] (a proven same-pool supersession is a deploy, not a page)."
  }
  assert {
    condition     = aws_cloudwatch_metric_alarm.gs["a1-unexpected-task-loss"].comparison_operator == "GreaterThanOrEqualToThreshold" && aws_cloudwatch_metric_alarm.gs["a1-unexpected-task-loss"].threshold == 1 && aws_cloudwatch_metric_alarm.gs["a1-unexpected-task-loss"].treat_missing_data == "notBreaching"
    error_message = "A1: >= 1 in one minute, missing data is no loss."
  }
}

run "a3_ticket_first_page_on_a_restart_loop" {
  command = plan

  assert {
    condition     = aws_cloudwatch_metric_alarm.gs["a3-store-uncertain"].period == null && one(one(aws_cloudwatch_metric_alarm.gs["a3-store-uncertain"].metric_query).metric).period == 60 && aws_cloudwatch_metric_alarm.gs["a3-store-uncertain"].threshold == 1 && one(one(aws_cloudwatch_metric_alarm.gs["a3-store-restart-loop"].metric_query).metric).period == 900 && aws_cloudwatch_metric_alarm.gs["a3-store-restart-loop"].threshold == 2
    error_message = "A3: the first store-uncertain in a minute; the restart loop is >= 2 in 15 minutes."
  }
}

run "kms_expressions" {
  command = plan

  assert {
    condition     = one(one(aws_cloudwatch_metric_alarm.gs["a8-kms-refused"].metric_query).metric).metric_name == "KmsRefused" && one(one(aws_cloudwatch_metric_alarm.gs["a9-kms-invalid-answer"].metric_query).metric).metric_name == "KmsInvalidAnswer" && aws_cloudwatch_metric_alarm.gs["a8-kms-refused"].threshold == 1 && aws_cloudwatch_metric_alarm.gs["a9-kms-invalid-answer"].threshold == 1
    error_message = "A8 / A9: any refused key or invalid answer pages."
  }
  assert {
    condition = (
      one([for q in aws_cloudwatch_metric_alarm.gs["a10-signer-unavailable"].metric_query : q if q.id == "e1"]).expression == "IF((FILL(t, 0) + FILL(o, 0) + FILL(w, 0)) > 0 AND FILL(s, 0) == 0, 1, 0)"
      && toset([for q in aws_cloudwatch_metric_alarm.gs["a10-signer-unavailable"].metric_query : "${q.id}=${one(q.metric).metric_name}" if length(q.metric) == 1]) == toset(["t=KmsTransient", "o=KmsOtherFailure", "w=KmsSignWithheld", "s=KmsSigns"])
      && aws_cloudwatch_metric_alarm.gs["a10-signer-unavailable"].evaluation_periods == 5 && aws_cloudwatch_metric_alarm.gs["a10-signer-unavailable"].datapoints_to_alarm == 5
    )
    error_message = "A10: L6-5A's expression -- KmsSignWithheld (KMS never called) counts as unavailable only while no Sign succeeds, 5 minutes running."
  }
}

run "heartbeat_primary_only_missing_data_breaching" {
  command = plan

  variables {
    start_services = true
    pools = {
      p1 = { primary = true }
      p2 = { primary = false }
    }
  }

  assert {
    condition     = aws_cloudwatch_metric_alarm.gs["primary/a13-primary-heartbeat"].treat_missing_data == "breaching" && one(one(aws_cloudwatch_metric_alarm.gs["primary/a13-primary-heartbeat"].metric_query).metric).stat == "SampleCount" && one(one(aws_cloudwatch_metric_alarm.gs["primary/a13-primary-heartbeat"].metric_query).metric).metric_name == "Primary"
    error_message = "A13: no `Primary` status sample (reported only by the identity-writer's task) for 3 minutes; missing data is breaching -- left on a demoted pool, it pages."
  }
  assert {
    condition     = alltrue([for id in ["a6-relayer-unusable", "a7-escrow-inactive", "a13-primary-heartbeat"] : one(one(aws_cloudwatch_metric_alarm.gs["primary/${id}"].metric_query).metric).dimensions.Pool == "p1"]) && length([for k, a in aws_cloudwatch_metric_alarm.gs : k if startswith(k, "p2/a13") || startswith(k, "p2/a6") || startswith(k, "p2/a7")]) == 0
    error_message = "A6, A7 and A13 watch the primary pool only: a healthy non-primary router never pages them."
  }
  assert {
    condition     = alltrue([for k, a in aws_cloudwatch_metric_alarm.gs : a.treat_missing_data == "notBreaching" if k != "primary/a13-primary-heartbeat"])
    error_message = "Only the heartbeat treats missing data as breaching: a drained pool or a non-holder emits nothing and pages nothing."
  }
}

run "a_flip_moves_the_primary_alarms_in_place" {
  command = plan

  variables {
    start_services = true
    pools = {
      p1 = { primary = false }
      p2 = { primary = true }
    }
  }

  override_data {
    target = data.aws_dynamodb_table_item.routing[0]
    values = { item = "{\"pk\":{\"S\":\"SYSTEM\"},\"sk\":{\"S\":\"ROUTING\"},\"fmt\":{\"N\":\"1\"},\"primary_pool\":{\"S\":\"p2\"},\"routing_version\":{\"N\":\"2\"},\"updated_at\":{\"N\":\"0\"},\"updated_by\":{\"S\":\"gamesDoctor/op:r-0000000000000000\"},\"claim\":{\"S\":\"c\"},\"generation\":{\"N\":\"1\"},\"game_table\":{\"S\":\"gs-staging-game-g1\"},\"origin\":{\"S\":\"bootstrap\"},\"restore_id\":{\"NULL\":true}}" }
  }

  assert {
    condition     = aws_cloudwatch_metric_alarm.gs["primary/a6-relayer-unusable"].alarm_name == "gs-staging-primary-a6-relayer-unusable" && alltrue([for id in ["a6-relayer-unusable", "a7-escrow-inactive", "a13-primary-heartbeat"] : one(one(aws_cloudwatch_metric_alarm.gs["primary/${id}"].metric_query).metric).dimensions.Pool == "p2"])
    error_message = "A flip keeps the primary alarms' names and moves their Pool dimension to the new primary, in the same plan as the /gs* rule."
  }
  assert {
    condition     = aws_cloudwatch_composite_alarm.notify["primary/a6-relayer-unusable"].actions_suppressor[0].alarm == "gs-staging-p2-flip-window"
    error_message = "A primary alarm is suppressed by its CURRENT pool's window (both flip pools have one)."
  }
}

# (The refusal of a primary alarm onto a pool SYSTEM/ROUTING does not name is proven in app.tftest.hcl -- "a_flip_before_the_
# routing_moved_is_refused" and "a_missing_or_foreign_routing_refuses_the_services" -- where the tables exist in the test
# state: here every table is still to be created, so the plan defers the routing read and the precondition is unknown.)

run "no_escrow_no_escrow_alarms" {
  command = plan

  variables {
    escrow       = null
    signing_keys = null
  }

  assert {
    condition     = length([for k, a in aws_cloudwatch_metric_alarm.gs : k if length(regexall("a6-|a6b-|a7-|a8-|a9-|a10-|a15-|r2-|r3-", k)) > 0]) == 0
    error_message = "Without escrow there is no relayer, KMS or money alarm (nothing would ever emit their metrics)."
  }
  assert {
    condition     = contains(keys(aws_cloudwatch_metric_alarm.gs), "a1-unexpected-task-loss") && contains(keys(aws_cloudwatch_metric_alarm.gs), "r1-generation-lost") && contains(keys(aws_cloudwatch_metric_alarm.gs), "a4g-generation-refused")
    error_message = "The loss, refusal and generation alarms exist with or without escrow."
  }
}

/* ------------------------------------------------------------------ */
/* Actions: page / ticket classes; empty lists valid                    */
/* ------------------------------------------------------------------ */

run "empty_staging_action_lists_are_valid" {
  command = plan

  assert {
    condition     = alltrue([for k, a in aws_cloudwatch_metric_alarm.gs : length(a.alarm_actions) == 0 && a.actions_enabled]) && alltrue([for k, c in aws_cloudwatch_composite_alarm.notify : length(c.alarm_actions) == 0 && c.actions_enabled])
    error_message = "Staging may name no destination: the alarms exist, evaluate and keep their actions ENABLED (nothing is muted)."
  }
}

run "page_and_ticket_classes_are_wired_to_their_own_lists" {
  command = plan

  variables {
    page_alarm_action_arns   = ["arn:aws:sns:us-east-1:111111111111:gs-staging-page"]
    ticket_alarm_action_arns = ["arn:aws:sns:us-east-1:111111111111:gs-staging-ticket"]
  }

  assert {
    condition = alltrue([for k, a in aws_cloudwatch_metric_alarm.gs : a.alarm_actions == toset(
      contains(keys(aws_cloudwatch_composite_alarm.notify), k) ? [] : (a.tags["gs:alarm-class"] == "page" ? ["arn:aws:sns:us-east-1:111111111111:gs-staging-page"] : ["arn:aws:sns:us-east-1:111111111111:gs-staging-ticket"])
    ) && a.ok_actions == a.alarm_actions])
    error_message = "A direct alarm notifies its own class's list (ALARM and OK); a suppressible one notifies only through its composite."
  }
  assert {
    condition     = alltrue([for k, c in aws_cloudwatch_composite_alarm.notify : c.alarm_actions == toset(c.tags["gs:alarm-class"] == "page" ? ["arn:aws:sns:us-east-1:111111111111:gs-staging-page"] : ["arn:aws:sns:us-east-1:111111111111:gs-staging-ticket"])])
    error_message = "A composite notifies its alarm's class."
  }
  assert {
    condition = alltrue([for id in ["a1-unexpected-task-loss", "a3-store-restart-loop", "a4-startup-refused", "a4g-generation-refused", "a4i-identity-restore-refused", "r1-generation-lost", "r2-money-journal-ahead", "a8-kms-refused", "a9-kms-invalid-answer", "a10-signer-unavailable", "p1/a15-relayer-paging", "p1/r3-restore-unverified", "p1/a5-money-sweep-stale", "p1/a2-writer-epoch-conflict", "primary/a7-escrow-inactive"] :
    aws_cloudwatch_metric_alarm.gs[id].tags["gs:alarm-class"] == "page"])
    error_message = "The PAGE class: losses, restart loops, refusals, generation / restore failures, KMS, the relayer's page, the sweep, the escrow."
  }
}

run "overlapping_page_and_ticket_destinations_are_refused" {
  command = plan

  variables {
    page_alarm_action_arns   = ["arn:aws:sns:us-east-1:111111111111:gs-staging-alerts"]
    ticket_alarm_action_arns = ["arn:aws:sns:us-east-1:111111111111:gs-staging-alerts"]
  }

  expect_failures = [var.ticket_alarm_action_arns]
}

run "a_non_action_arn_is_refused" {
  command = plan

  variables {
    page_alarm_action_arns = ["arn:aws:iam::111111111111:role/not-an-action"]
  }

  expect_failures = [var.page_alarm_action_arns]
}

/* ------------------------------------------------------------------ */
/* PART G: planned-flip suppression                                     */
/* ------------------------------------------------------------------ */

run "only_the_flip_effects_are_suppressible_never_a_loss_a_refusal_a_restore_or_a_relayer_page" {
  command = plan

  variables {
    start_services           = true
    page_alarm_action_arns   = ["arn:aws:sns:us-east-1:111111111111:gs-staging-page"]
    ticket_alarm_action_arns = ["arn:aws:sns:us-east-1:111111111111:gs-staging-ticket"]
  }

  assert {
    condition     = toset(keys(aws_cloudwatch_composite_alarm.notify)) == toset(["p1/a11-readiness-flapping", "p1/a12-prolonged-unready", "p1/a12b-pool-writer-unconfirmed", "primary/a6-relayer-unusable", "primary/a13-primary-heartbeat"])
    error_message = "Exactly the flip's expected effects are suppressible: readiness / target-health flap (A11), unready during the restart (A12), the pool writer during it (A12b), the relayer moving with the primary (A6), the primary's restart gap (A13)."
  }
  assert {
    condition = alltrue([for id in ["a1-unexpected-task-loss", "a3-store-uncertain", "a3-store-restart-loop", "a4-startup-refused", "a4g-generation-refused", "a4i-identity-restore-refused", "r1-generation-lost", "r2-money-journal-ahead", "p1/r3-restore-unverified", "p1/a15-relayer-paging", "p1/a5-money-sweep-stale", "p1/a5b-money-sweep-games-failing", "a5c-money-sweep-passes-failing", "primary/a7-escrow-inactive", "a8-kms-refused", "a9-kms-invalid-answer", "a10-signer-unavailable"] :
    !contains(keys(aws_cloudwatch_composite_alarm.notify), id) && length(aws_cloudwatch_metric_alarm.gs[id].alarm_actions) == 1])
    error_message = "NEVER suppressed: exit 3 / 4, store-uncertain, refusals (generation, adoption, identity restore), generation loss, journal-ahead, unverified restored games, the relayer's page, the money sweep, escrow, KMS -- each notifies directly and has no composite."
  }
  assert {
    condition = alltrue([for k, c in aws_cloudwatch_composite_alarm.notify :
      c.alarm_rule == "ALARM(\"${aws_cloudwatch_metric_alarm.gs[k].alarm_name}\")" && length(aws_cloudwatch_metric_alarm.gs[k].alarm_actions) == 0 && length(aws_cloudwatch_metric_alarm.gs[k].ok_actions) == 0
      && c.actions_suppressor[0].wait_period == 120 && c.actions_suppressor[0].extension_period == 120
    ])
    error_message = "A suppressible alarm's metric alarm has no actions (its state is untouched), and its composite carries them with a bounded suppressor."
  }
}

run "the_suppressor_is_the_pools_own_window_and_expires_by_itself" {
  command = plan

  variables {
    pools = {
      p1 = { primary = true }
      p2 = { primary = false }
      p3 = { primary = false }
    }
  }

  assert {
    condition = alltrue([for p in ["p1", "p2", "p3"] :
      aws_cloudwatch_metric_alarm.flip_window[p].alarm_name == "gs-staging-${p}-flip-window"
      && aws_cloudwatch_metric_alarm.flip_window[p].namespace == "18Cosmos/Operator" && aws_cloudwatch_metric_alarm.flip_window[p].metric_name == "FlipWindowOpen"
      && aws_cloudwatch_metric_alarm.flip_window[p].statistic == "Sum" && aws_cloudwatch_metric_alarm.flip_window[p].period == 60
      && aws_cloudwatch_metric_alarm.flip_window[p].treat_missing_data == "notBreaching"
      && aws_cloudwatch_metric_alarm.flip_window[p].dimensions.Environment == "staging" && aws_cloudwatch_metric_alarm.flip_window[p].dimensions.Pool == p && length(aws_cloudwatch_metric_alarm.flip_window[p].dimensions) == 2
      && length(aws_cloudwatch_metric_alarm.flip_window[p].alarm_actions) == 0
    ])
    error_message = "One suppressor per pool: ALARM only while the minute's open windows sum to >= 1 (+1 per open, -1 per close: overlapping windows compose); missing data -- the pre-published minutes ran out, whoever died -- is OK, so suppression ends by itself."
  }
  assert {
    condition     = alltrue([for k, c in aws_cloudwatch_composite_alarm.notify : c.actions_suppressor[0].alarm == "gs-staging-${split("/", k)[0] == "primary" ? "p1" : split("/", k)[0]}-flip-window"])
    error_message = "Each composite is suppressed by ITS pool's window only: an unrelated pool is never suppressed."
  }
  assert {
    condition     = output.flip_suppression.max_window_minutes == 45 && output.flip_suppression.suppressors == { p1 = "gs-staging-p1-flip-window", p2 = "gs-staging-p2-flip-window", p3 = "gs-staging-p3-flip-window" }
    error_message = "The seam's identifiers are outputs (L6-2's flip, L6-6's certification)."
  }
  assert {
    condition     = alltrue([for k, a in aws_cloudwatch_metric_alarm.gs : alltrue([for q in a.metric_query : length(q.metric) == 0 || one(q.metric).namespace != "18Cosmos/Operator"])])
    error_message = "The operator's namespace drives only the suppressors; no game-server alarm reads it."
  }
}

run "operator_may_publish_only_the_flip_window_and_the_verifier_may_describe_alarms" {
  command = plan

  variables {
    operator_trusted_principal_arns = ["arn:aws:iam::111111111111:role/ops-humans"]
  }

  assert {
    condition = (
      one([for s in data.aws_iam_policy_document.operator.statement : s if s.sid == "FlipWindowMetricsOnly"]).actions == toset(["cloudwatch:PutMetricData"])
      && toset([for c in one([for s in data.aws_iam_policy_document.operator.statement : s if s.sid == "FlipWindowMetricsOnly"]).condition : "${c.test}|${c.variable}|${join(",", c.values)}"]) == toset(["StringEquals|cloudwatch:namespace|18Cosmos/Operator"])
    )
    error_message = "The operator publishes only into 18Cosmos/Operator (never a game-server metric)."
  }
  assert {
    condition     = alltrue([for s in data.aws_iam_policy_document.operator.statement : alltrue([for a in s.actions : !contains(["cloudwatch:DisableAlarmActions", "cloudwatch:EnableAlarmActions", "cloudwatch:SetAlarmState", "cloudwatch:DeleteAlarms", "cloudwatch:PutMetricAlarm", "cloudwatch:PutCompositeAlarm"], a)])])
    error_message = "Nobody's flip can mute, rewrite or delete an alarm: the only lever is the bounded window datapoints."
  }
  assert {
    condition     = alltrue([for s in data.aws_iam_policy_document.task.statement : alltrue([for a in s.actions : !startswith(a, "cloudwatch:")])])
    error_message = "The serving task has no CloudWatch permission at all (EMF goes through its log group)."
  }
  assert {
    condition     = one([for s in data.aws_iam_policy_document.bootstrap.statement : s if s.sid == "VerifierAlarms"]).actions == toset(["cloudwatch:DescribeAlarms"])
    error_message = "The verifier's capture reads the alarms (describe only)."
  }
}
