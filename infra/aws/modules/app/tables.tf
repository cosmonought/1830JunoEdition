# ==================================================================
#  LIVE-5 L5-8: THE APP ACCOUNT'S TWO AUTHORITATIVE TABLES (L5-7 §14)
# ==================================================================
#
# Both: string pk HASH + string sk RANGE, no GSI/LSI, on-demand, PITR, deletion protection, never a Global Table.
#   gs-<env>-game-g<N>   no TTL (no authoritative item carries one). SYSTEM/ROUTING is written by the deploy bootstrap
#                        (`npm run awsDeploy -- bootstrap`), never by Terraform: a mutable control-plane record Terraform
#                        would otherwise "correct" back after an operator's flip (L6-2). POOL#<p> is the first task's.
#   gs-<env>-identity    TTL attribute `ttl` (grants, commit markers). ROLE#identity-writer is the first takeover's.

resource "aws_dynamodb_table" "game" {
  name                        = local.game_table_name
  billing_mode                = "PAY_PER_REQUEST"
  hash_key                    = "pk"
  range_key                   = "sk"
  table_class                 = "STANDARD"
  deletion_protection_enabled = true

  attribute {
    name = "pk"
    type = "S"
  }
  attribute {
    name = "sk"
    type = "S"
  }

  point_in_time_recovery {
    enabled                 = true
    recovery_period_in_days = 35
  }

  tags = merge(local.tags, { Name = local.game_table_name, "gs:component" = "game" })

  lifecycle {
    prevent_destroy = true

    precondition {
      condition     = local.partition == "aws"
      error_message = "The runtime's ARN parsers accept only the commercial `aws` partition."
    }
  }
}

resource "aws_dynamodb_table" "identity" {
  name                        = local.identity_table_name
  billing_mode                = "PAY_PER_REQUEST"
  hash_key                    = "pk"
  range_key                   = "sk"
  table_class                 = "STANDARD"
  deletion_protection_enabled = true

  attribute {
    name = "pk"
    type = "S"
  }
  attribute {
    name = "sk"
    type = "S"
  }

  ttl {
    enabled        = true
    attribute_name = "ttl"
  }

  point_in_time_recovery {
    enabled                 = true
    recovery_period_in_days = 35
  }

  tags = merge(local.tags, { Name = local.identity_table_name, "gs:component" = "identity" })

  lifecycle {
    prevent_destroy = true
  }
}
