# ==================================================================
#  LIVE-6 L6-5B: THE CLOUDWATCH ALARMS -- FROM ONE CONTRACT, OVER L6-5A's EMF METRICS
# ==================================================================
#
# EVERY alarm is one entry of `alarm-contract.json`, the SAME file `awsDeploy verify` judges the live alarms against
# (server/src/aws/controlPlane/alarmContract.ts carries a copy that persistence/conformance/l6_5bAlarms.test.ts pins to this file). Nothing
# here invents a metric: each names a metric of L6-5A's catalog (+ L6-5B's additions) in namespace 18Cosmos/GameServer,
# with the ONLY dimensions that catalog emits -- [Environment] or [Environment, Pool]. No task, build, generation, epoch,
# game, principal, wallet, key or ARN is ever a dimension, and no alarm exists per task. No Logs metric filter exists at
# all: every signal is an EMF metric the task writes itself (a filter over an AUDIT line would be a second series).
#
# SCOPE (the contract's `scope`):
#   environment  one alarm per environment, dimension [Environment] -- the forced-exit and failure counters (they must
#                survive a pool change; they are never tied to which pool is primary).
#   pool         one alarm PER POOL, [Environment, Pool]. A drained pool emits nothing (notBreaching: never a page). The
#                relayer's page (A15) and a restored table's unverified games (R3) are per pool on EVERY pool: only the
#                role holder / the primary emits them, so they follow the role itself, never the Terraform `primary` flag.
#   primary      ONE alarm named `gs-<env>-primary-<id>` whose Pool dimension is the pool marked `primary` (A6, A7, A13;
#                A13 counts the `Primary` gauge -- only the identity-writer's task reports it -- so a primary alarm left on
#                a demoted pool PAGES (missing data breaching) instead of being satisfied by that pool's router).
#                A FLIP moves it explicitly: `pools.<B>.primary = true` is an in-place UPDATE of these alarms' Pool
#                dimension in the same plan that moves the /gs* rule (their names never change), and the plan refuses
#                it unless SYSTEM/ROUTING already names B (the precondition below, the same as the services'). The
#                verifier fails a primary alarm that watches any pool but --primary-pool, so a stale attachment is
#                never silent.
#
# ACTIONS: `page_alarm_action_arns` / `ticket_alarm_action_arns` by the contract's `class` (both may be empty in
# staging). OK actions go to the same list (a page resolves itself).
#
# PLANNED-FLIP SUPPRESSION (L6-2's window; the state machine in the L6-5B report):
#   - a SUPPRESSIBLE alarm (the contract's `suppressible`: A6, A11, A12, A12b, A13 -- the flip's expected effects: the two
#     pools' exit-5 restarts, the non-primary transition, their readiness / target-health flap) is a metric alarm WITH
#     NO ACTIONS plus a composite `<name>-notify` = ALARM(<name>) that carries the actions and an `actions_suppressor`:
#     its pool's `gs-<env>-<pool>-flip-window` alarm. Only ACTIONS are suppressed: the metric alarm's state, history and
#     the metrics themselves are untouched. When suppression ends, CloudWatch acts on the composite's CURRENT state (a
#     failure that is still there after the window still notifies);
#   - the suppressor `gs-<env>-<pool>-flip-window` is ALARM only while its pool's FlipWindowOpen datapoints (namespace
#     18Cosmos/Operator, published by `gamesDoctor aws flip` when the window opens: +1 per minute up to the window's
#     expires_at, never more than 45 minutes; a close writes -1 over the same remaining minutes) SUM to at least 1 in the
#     minute. Additive, so overlapping windows (a re-run, a flip back) compose and a close ends only its own. Missing data
#     is OK: when the pre-published minutes run out -- the operator's process may be long dead -- the suppression ENDS by
#     itself. Nothing ever needs to "re-enable" an alarm, and no alarm's actions are disabled;
#   - EVERY other alarm has its actions directly and no composite: nothing can suppress an exit 3 / 4 (A1, A3), a refused
#     start or a generation / adoption / identity-restore refusal (A4*), a generation loss (R1), a money sweep failure
#     (A5*), a journal-ahead hold or an unverified restored game (R2, R3), a KMS failure (A8-A10) or the relayer's page
#     (A15). A restore/adoption is a different event from a flip: no restore alarm is in the suppressible class at all.

locals {
  alarm_contract  = jsondecode(file("${path.module}/alarm-contract.json"))
  alarm_namespace = local.alarm_contract.namespace
  suppressor      = local.alarm_contract.suppressor

  # The contract's alarms this configuration deploys (escrow-only alarms without escrow do not exist; the heartbeat,
  # whose missing data is breaching, only once the services run).
  alarm_specs = [for a in local.alarm_contract.alarms : a if a.requires == null || (a.requires == "escrow" && local.escrow_enabled) || (a.requires == "services" && var.start_services)]

  alarm_instances = merge(
    { for a in local.alarm_specs : a.id => merge(a, { key = a.id, name = "${local.prefix}-${a.id}", pool = null }) if a.scope == "environment" },
    merge([for pool in local.pool_ids : { for a in local.alarm_specs : "${pool}/${a.id}" => merge(a, { key = "${pool}/${a.id}", name = "${local.prefix}-${pool}-${a.id}", pool = pool }) if a.scope == "pool" }]...),
    { for a in local.alarm_specs : "primary/${a.id}" => merge(a, { key = "primary/${a.id}", name = "${local.prefix}-primary-${a.id}", pool = local.primary_pool }) if a.scope == "primary" },
  )
  alarm_keys = local.ecs ? toset(keys(local.alarm_instances)) : toset([]) # COST-1: compute "none" -> the single host's own four alarms
  alarm_actions_of = {
    page   = var.page_alarm_action_arns
    ticket = var.ticket_alarm_action_arns
  }
  suppressor_name = { for pool in local.pool_ids : pool => "${local.prefix}-${pool}-flip-window" }
}

resource "aws_cloudwatch_metric_alarm" "flip_window" {
  for_each = local.ecs ? toset(local.pool_ids) : toset([])

  alarm_name          = local.suppressor_name[each.key]
  alarm_description   = "LIVE-6 L6-5B: ALARM exactly while a planned flip window (L6-2) including pool ${each.key} is open and unexpired. It has no actions: it only suppresses the ACTIONS of this pool's suppressible composites."
  namespace           = local.suppressor.namespace
  metric_name         = local.suppressor.metric
  statistic           = local.suppressor.statistic
  period              = local.suppressor.period
  evaluation_periods  = 1
  datapoints_to_alarm = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = local.suppressor.threshold
  treat_missing_data  = local.suppressor.missing
  dimensions          = { Environment = var.environment, Pool = each.key }
  actions_enabled     = true
  alarm_actions       = []
  ok_actions          = []
  tags                = merge(local.tags, { "gs:pool" = each.key, "gs:alarm" = "flip-window" })
}

resource "aws_cloudwatch_metric_alarm" "gs" {
  for_each = local.alarm_keys

  alarm_name          = local.alarm_instances[each.key].name
  alarm_description   = local.alarm_instances[each.key].description
  evaluation_periods  = local.alarm_instances[each.key].evaluation_periods
  datapoints_to_alarm = local.alarm_instances[each.key].datapoints_to_alarm
  comparison_operator = local.alarm_instances[each.key].comparison
  threshold           = local.alarm_instances[each.key].threshold
  treat_missing_data  = local.alarm_instances[each.key].missing
  actions_enabled     = true
  # A suppressible alarm notifies only through its composite (below); every other alarm notifies directly.
  alarm_actions = local.alarm_instances[each.key].suppressible ? [] : local.alarm_actions_of[local.alarm_instances[each.key].class]
  ok_actions    = local.alarm_instances[each.key].suppressible ? [] : local.alarm_actions_of[local.alarm_instances[each.key].class]

  dynamic "metric_query" {
    for_each = local.alarm_instances[each.key].metrics
    content {
      id          = metric_query.value.id
      return_data = local.alarm_instances[each.key].expression == null
      metric {
        namespace   = local.alarm_namespace
        metric_name = metric_query.value.metric
        period      = local.alarm_instances[each.key].period
        stat        = metric_query.value.stat
        dimensions  = local.alarm_instances[each.key].pool == null ? { Environment = var.environment } : { Environment = var.environment, Pool = local.alarm_instances[each.key].pool }
      }
    }
  }
  dynamic "metric_query" {
    for_each = local.alarm_instances[each.key].expression == null ? [] : [local.alarm_instances[each.key].expression]
    content {
      id          = "e1"
      expression  = metric_query.value
      label       = local.alarm_instances[each.key].id
      return_data = true
    }
  }

  tags = merge(local.tags, { "gs:alarm" = local.alarm_instances[each.key].id, "gs:alarm-class" = local.alarm_instances[each.key].class, "gs:alarm-scope" = local.alarm_instances[each.key].scope }, local.alarm_instances[each.key].pool == null ? {} : { "gs:pool" = local.alarm_instances[each.key].pool })

  lifecycle {
    # A primary-only alarm follows the pool SYSTEM/ROUTING names (the flip moves the routing FIRST, then this flag), like
    # the /gs* rule and the services -- never onto a pool the routing does not name.
    precondition {
      condition     = local.alarm_instances[each.key].scope != "primary" || !var.start_services || local.routing_primary == local.primary_pool
      error_message = "A primary-only alarm is moved onto the pool marked primary only after SYSTEM/ROUTING names it (`gamesDoctor aws flip ... --apply` first)."
    }
  }
}

resource "aws_cloudwatch_composite_alarm" "notify" {
  for_each = toset([for key in local.alarm_keys : key if local.alarm_instances[key].suppressible])

  alarm_name        = "${local.alarm_instances[each.key].name}-notify"
  alarm_description = "LIVE-6 L6-5B: the actions of ${local.alarm_instances[each.key].name}, suppressed only while ${local.suppressor_name[local.alarm_instances[each.key].pool]} (a planned flip window of that pool) is in ALARM."
  alarm_rule        = "ALARM(\"${aws_cloudwatch_metric_alarm.gs[each.key].alarm_name}\")"
  actions_enabled   = true
  alarm_actions     = local.alarm_actions_of[local.alarm_instances[each.key].class]
  ok_actions        = local.alarm_actions_of[local.alarm_instances[each.key].class]

  actions_suppressor {
    alarm            = aws_cloudwatch_metric_alarm.flip_window[local.alarm_instances[each.key].pool].alarm_name
    wait_period      = local.suppressor.wait_period
    extension_period = local.suppressor.extension_period
  }

  tags = merge(local.tags, { "gs:alarm" = local.alarm_instances[each.key].id, "gs:alarm-class" = local.alarm_instances[each.key].class, "gs:pool" = local.alarm_instances[each.key].pool })
}
