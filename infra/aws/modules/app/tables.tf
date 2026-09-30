# ==================================================================
#  LIVE-5 L5-8: THE APP ACCOUNT'S TWO AUTHORITATIVE TABLES (L5-7 §14)
# ==================================================================
#
# Both: string pk HASH + string sk RANGE, no GSI/LSI, on-demand, PITR, deletion protection, never a Global Table.
#   gs-<env>-game-g<N>   ONE PER MANAGED GENERATION (LIVE-6 L6-2, L6-4 §12.1 item 2): `game_generations` side by side, the
#                        serving one being `generation`. g<N> is never replaced by a switch: a restore's g<N+1> is made
#                        by RestoreTableToPointInTime outside Terraform, then imported (stacks/app), and this resource then
#                        RE-ENABLES its PITR and deletion protection (a restore carries neither) -- it has no TTL. g<N>
#                        stays managed and protected until explicitly retired (removed from the set, prevent_destroy lifted
#                        deliberately). SYSTEM/GENERATION is the bootstrap's (the first table) or the restore
#                        preparation's (L6-4), never Terraform's.
#                        no TTL (no authoritative item carries one). SYSTEM/ROUTING is written by the deploy bootstrap
#                        (`npm run awsDeploy -- bootstrap`), never by Terraform: a mutable control-plane record Terraform
#                        would otherwise "correct" back after an operator's flip (L6-2). POOL#<p> is the first task's.
#   gs-<env>-identity    TTL attribute `ttl` (grants, commit markers). ROLE#identity-writer is the first takeover's.

# L5-8 declared ONE game table; it is the same table, now keyed by its generation -- never replaced by this change.
moved {
  from = aws_dynamodb_table.game
  to   = aws_dynamodb_table.game["1"]
}

resource "aws_dynamodb_table" "game" {
  for_each = local.game_table_names

  name                        = each.value
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

  tags = merge(local.tags, { Name = each.value, "gs:component" = "game", "gs:generation" = each.key, "gs:serving" = tostring(each.key == tostring(var.generation)) })

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
