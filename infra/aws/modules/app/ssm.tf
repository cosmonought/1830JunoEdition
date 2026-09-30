# ==================================================================
#  LIVE-5 L5-8: THE TWO CONFIGURATION DOCUMENTS -- PLAIN `String` PARAMETERS, NEVER `SecureString`, NO SECRET IN EITHER
# ==================================================================
#
# One runtime document per pool (`/gs/<env>/runtime/<pool>`, 18COSMOS/AWS-RUNTIME/v1: the pool is in the document) and,
# with escrow, one Juno configuration (`/gs/<env>/juno-backend`, 18COSMOS/JUNO-BACKEND/v3). The task reads the LATEST
# version at startup and prints it (L5-7 owner decision 3); a changed document therefore reaches a pool only through a new
# deployment, which the ECS service's `triggers` start (ecs.tf). `insecure_value` (not `value`) so every change is visible
# in the plan: nothing here is secret, and the runtime refuses a SecureString outright.

resource "aws_ssm_parameter" "runtime" {
  for_each = var.pools

  name           = local.runtime_parameter_name[each.key]
  description    = "18Cosmos ${var.environment} pool ${each.key}: the AWS runtime document (18COSMOS/AWS-RUNTIME/v1). No secrets."
  type           = "String"
  data_type      = "text"
  tier           = "Intelligent-Tiering"
  insecure_value = local.runtime_document[each.key]
  tags           = merge(local.tags, { "gs:pool" = each.key })

  # Deploy order: the tables the document names exist first.
  depends_on = [aws_dynamodb_table.game, aws_dynamodb_table.identity]

  lifecycle {
    precondition {
      condition     = length(local.runtime_document[each.key]) <= 8192
      error_message = "The runtime document exceeds the 8 KB the runtime reads."
    }
    precondition {
      condition     = !local.escrow_enabled || var.signing_keys != null
      error_message = "escrow needs signing_keys (the ledger stack's signing_key_arns)."
    }
  }
}

resource "aws_ssm_parameter" "juno_backend" {
  count = local.escrow_enabled ? 1 : 0

  name           = local.juno_parameter_name
  description    = "18Cosmos ${var.environment}: the Juno backend configuration (18COSMOS/JUNO-BACKEND/v3; DynamoDB ledger, KMS key ARNs). No secrets."
  type           = "String"
  data_type      = "text"
  tier           = "Intelligent-Tiering"
  insecure_value = local.juno_document
  tags           = local.tags

  depends_on = [aws_dynamodb_table.game, aws_dynamodb_table.identity]

  lifecycle {
    precondition {
      condition     = var.signing_keys != null
      error_message = "escrow needs signing_keys (the ledger stack's signing_key_arns)."
    }
    precondition {
      condition     = length(local.juno_document) <= 8192
      error_message = "The Juno configuration exceeds the 8 KB the runtime reads."
    }
  }
}
