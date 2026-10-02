# ==================================================================
#  COST-1: THE ACCOUNT'S MONTHLY AWS BUDGET (Part 15) -- PLANNED, NOT DEPLOYED BY DEFAULT
# ==================================================================
#
# One COST budget of `limit_usd` (default the owner's $30 ceiling), UNBLENDED cost, all services, monthly, with five
# notifications -- AWS allows up to ten per budget, each needing at least one subscriber (one SNS topic and up to ten
# email addresses):
#   ACTUAL     >= $15   early warning
#   ACTUAL     >= $20   the expected-cost target is exceeded
#   FORECASTED >= $25   the month is heading for the ceiling (AWS needs some billing history before it forecasts)
#   ACTUAL     >= $25   the ceiling is close
#   ACTUAL     >= $30   the HARD ceiling
# Budgets that only notify cost nothing. It is not an action-enabled budget: nothing is stopped automatically (stopping the
# host is money-safe but takes the game offline -- an owner decision, docs/hosting-budget.md). Created only when
# `budget.enabled` and a subscriber is named; no address is ever invented.

locals {
  budget_thresholds = [
    { type = "ACTUAL", amount = 15 },
    { type = "ACTUAL", amount = 20 },
    { type = "FORECASTED", amount = 25 },
    { type = "ACTUAL", amount = 25 },
    { type = "ACTUAL", amount = 30 },
  ]
}

resource "aws_budgets_budget" "monthly" {
  count        = var.budget.enabled ? 1 : 0
  name         = "${local.prefix}-monthly-ceiling"
  budget_type  = "COST"
  limit_amount = format("%.2f", var.budget.limit_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  dynamic "notification" {
    for_each = { for t in local.budget_thresholds : "${t.type}-${t.amount}" => t if t.amount <= var.budget.limit_usd }
    content {
      comparison_operator        = "GREATER_THAN"
      notification_type          = notification.value.type
      threshold                  = notification.value.amount
      threshold_type             = "ABSOLUTE_VALUE"
      subscriber_email_addresses = var.budget.email_addresses
      subscriber_sns_topic_arns  = var.budget.sns_topic_arn == null ? [] : [var.budget.sns_topic_arn]
    }
  }

  tags = local.tags
}
