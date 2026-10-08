# ==================================================================
#  COST-1: THE REDUCED OBSERVABILITY TIER -- ONE LOG GROUP, FIVE ALARMS, ~ONE CONTINUOUS METRIC
# ==================================================================
#
# The LIVE-6 L6-5B matrix (34 alarms over ~38 continuously extracted series per task, plus composites and flip
# suppressors: ~$25/month on its own) is replaced, for the single host, by:
#   the log group      every AUDIT line and every metric record line (all values kept: Logs Insights reads them), 90 days;
#   HostHealthProblems the server's `single-host` metric profile (GS_METRICS_PROFILE): the count of standing problems at
#                      each 30 s status tick (not ready, pool writer unconfirmed, not primary / not the identity writer,
#                      money sweep stale >= 180 s, relayer unusable, escrow inactive, relayer paging, restored money games
#                      unverified, signer unavailable, and -- Phase 3 escrow 2.1 -- a timed money table FROZEN at an
#                      undecided minute 30 because its consent keys cannot be read on chain: ClockFinalityHeldTables >= 1).
#                      0 = healthy. Three consecutive minutes page.
#                      MISSING DATA IS BREACHING: a dead, stopped or wedged server pages through the same alarm.
#   HostCriticalEvents the sum of the incident counters (task loss of any cause, uncertain store, refused start, money
#                      sweep pass / game failures, relayer takeover not taken, KMS refused / invalid / other failure,
#                      a money game held journal-ahead). Published only when > 0: costs nothing in a quiet month.
#   EC2 StatusCheckFailed and CPUCreditBalance (free basic metrics: a burstable host that runs out of credits is held at
#                      its 20 % baseline, which a route-heavy turn on the single event loop can feel) and 18Cosmos/Host
#                      HostPressure (the host sampler's memory / swap / disk / OOM datapoint, published only under pressure).
# Which problem or event it was is in the log line (Logs Insights; queries in the module README). No alarm, metric or log
# line changes a money decision: the runtime never reads them.

resource "aws_cloudwatch_log_group" "host" {
  name              = local.log_group_name
  retention_in_days = var.log_retention_days
  log_group_class   = "STANDARD" # EMF extraction needs the Standard class
  tags              = local.tags
}

resource "aws_cloudwatch_metric_alarm" "health" {
  alarm_name          = "${local.name}-health"
  alarm_description   = "COST-1: the single host's game server is unhealthy or silent for 3 minutes (HostHealthProblems >= 1, or no status tick at all). See the log group's task-status lines for which problem."
  namespace           = local.app_metric_namespace
  metric_name         = "HostHealthProblems"
  dimensions          = { Environment = var.environment }
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 3
  datapoints_to_alarm = 3
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = var.alarm_action_arns
  ok_actions          = var.alarm_action_arns
  tags                = local.tags
}

resource "aws_cloudwatch_metric_alarm" "critical" {
  alarm_name          = "${local.name}-critical-event"
  alarm_description   = "COST-1: a financial / security incident counter fired (task loss, uncertain store, refused start, money sweep failure, relayer takeover not taken, KMS failure, money game held journal-ahead). See the log group."
  namespace           = local.app_metric_namespace
  metric_name         = "HostCriticalEvents"
  dimensions          = { Environment = var.environment }
  statistic           = "Sum"
  period              = 60
  evaluation_periods  = 1
  datapoints_to_alarm = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_action_arns
  ok_actions          = var.alarm_action_arns
  tags                = local.tags
}

resource "aws_cloudwatch_metric_alarm" "status_check" {
  alarm_name          = "${local.name}-status-check"
  alarm_description   = "COST-1: the EC2 instance or system status check failed (automatic recovery handles hardware; this says it happened)."
  namespace           = "AWS/EC2"
  metric_name         = "StatusCheckFailed"
  dimensions          = { InstanceId = aws_instance.host.id }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 2
  datapoints_to_alarm = 2
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_action_arns
  ok_actions          = var.alarm_action_arns
  tags                = local.tags
}

resource "aws_cloudwatch_metric_alarm" "pressure" {
  alarm_name          = "${local.name}-pressure"
  alarm_description   = "COST-1: the host sampler saw memory, swap or disk pressure, or a new OOM kill (gs-host-sample). See /var/log/gs-measure on the host."
  namespace           = local.host_metric_namespace
  metric_name         = "HostPressure"
  dimensions          = { Environment = var.environment }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  datapoints_to_alarm = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_action_arns
  ok_actions          = var.alarm_action_arns
  tags                = local.tags
}

resource "aws_cloudwatch_metric_alarm" "cpu_credits" {
  alarm_name          = "${local.name}-cpu-credits"
  alarm_description   = "COST-1: the burstable host is nearly out of CPU credits (standard mode: it will be held at its baseline, never billed for surplus). Sustained route-heavy play or a runaway process; see the host sampler's load. EXPECTED once after every launch or replacement: T4g/T3 in standard mode get no launch credits, so the balance starts near 0 and this alarm clears after ~75 min of light load."
  namespace           = "AWS/EC2"
  metric_name         = "CPUCreditBalance"
  dimensions          = { InstanceId = aws_instance.host.id }
  statistic           = "Minimum"
  period              = 300
  evaluation_periods  = 3
  datapoints_to_alarm = 3
  threshold           = 30
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_action_arns
  ok_actions          = var.alarm_action_arns
  tags                = local.tags
}
