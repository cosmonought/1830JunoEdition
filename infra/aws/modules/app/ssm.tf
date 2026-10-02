# ==================================================================
#  LIVE-5 L5-8: THE TWO CONFIGURATION DOCUMENTS -- PLAIN `String` PARAMETERS, NEVER `SecureString`, NO SECRET IN EITHER
# ==================================================================
#
# One runtime document per pool (`/gs/<env>/runtime/<pool>`, 18COSMOS/AWS-RUNTIME/v2 since LIVE-6 L6-2: the pool is in the
# document, and so is the deployment's trusted route table -- the same `routes` in every pool's document) and,
# with escrow, one Juno configuration (`/gs/<env>/juno-backend`, 18COSMOS/JUNO-BACKEND/v3). The task reads the LATEST
# version at startup and prints it (L5-7 owner decision 3); a changed document therefore reaches a pool only through a new
# deployment, which the ECS service's `triggers` start (ecs.tf). `insecure_value` (not `value`) so every change is visible
# in the plan: nothing here is secret, and the runtime refuses a SecureString outright.

resource "aws_ssm_parameter" "runtime" {
  for_each = var.pools

  name           = local.runtime_parameter_name[each.key]
  description    = "18Cosmos ${var.environment} pool ${each.key}: the AWS runtime document (18COSMOS/AWS-RUNTIME/v2). No secrets."
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
    # COST-1: with compute = "none" there is no ECS service to carry the plan-time gates, so the SAME gates move here
    # (start_services = true: the single host serves): no runtime document ever names a table that is not prepared as
    # this generation, a restore that is not the attested adoption, or a routing that does not name the primary pool.
    precondition {
      condition     = local.ecs || !var.start_services || (local.routing_format == "1" && local.routing_primary == local.primary_pool)
      error_message = "compute = none: SYSTEM/ROUTING must exist and name the primary pool before a runtime document is written for it."
    }
    precondition {
      condition     = local.ecs || !var.start_services || local.marker_names_this
      error_message = "compute = none: the serving game table's SYSTEM/GENERATION must name this generation and table (L6-4) before the runtime document names it."
    }
    precondition {
      condition     = local.ecs || !var.start_services || local.marker_adoption_ok
      error_message = "compute = none: the serving table is a restore -- set generation_adoption to what `npm run awsDeploy -- generation-gate` printed (or it is a bootstrap table and generation_adoption must be null)."
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
