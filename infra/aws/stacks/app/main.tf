# LIVE-5 L5-8: the APP ACCOUNT's root (apply with the app account's credentials; `allowed_account_ids` refuses any other
# account). Apply twice: start_services = false, then -- after `npm run awsDeploy -- bootstrap ... --apply` and `verify` --
# start_services = true. See infra/aws/README.md for the whole deploy order.

terraform {
  required_version = ">= 1.9.0, < 2.0.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "6.66.0"
    }
  }

  backend "s3" {}
}

provider "aws" {
  region              = var.region
  allowed_account_ids = [var.app_account_id]

  default_tags {
    tags = { "gs:managed-by" = "terraform", "gs:stack" = "app", "gs:environment" = var.environment }
  }
}

module "app" {
  source = "../../modules/app"

  environment                       = var.environment
  generation                        = var.generation
  game_generations                  = var.game_generations
  generation_adoption               = var.generation_adoption
  compute                           = var.compute
  identity_layout_version           = var.identity_layout_version
  ledger_table_arn                  = var.ledger_table_arn
  signing_keys                      = var.signing_keys
  relayer_rotation_key_arns         = var.relayer_rotation_key_arns
  escrow                            = var.escrow
  money_tables_nonmainnet           = var.money_tables_nonmainnet
  edge_diagnostic_staging           = var.edge_diagnostic_staging
  conduct_reviewers                 = var.conduct_reviewers
  network                           = var.network
  build_id                          = var.build_id
  container_port                    = var.container_port
  allowed_origins                   = var.allowed_origins
  trusted_proxy_hops                = var.trusted_proxy_hops
  pools                             = var.pools
  start_services                    = var.start_services
  health_check_grace_period_seconds = var.health_check_grace_period_seconds
  alb                               = var.alb
  edge                              = var.edge
  log_retention_days                = var.log_retention_days
  bootstrap_trusted_principal_arns  = var.bootstrap_trusted_principal_arns
  operator_trusted_principal_arns   = var.operator_trusted_principal_arns
  recovery_trusted_principal_arns   = var.recovery_trusted_principal_arns
  recovery_break_glass              = var.recovery_break_glass
  page_alarm_action_arns            = var.page_alarm_action_arns
  ticket_alarm_action_arns          = var.ticket_alarm_action_arns
  tags                              = var.tags
}

# LIVE-6 L6-2 (L6-4 §12.1 item 2): A RESTORED GAME TABLE IS IMPORTED, NEVER CREATED. After `RestoreTableToPointInTime`
# made gs-<env>-game-g<N+1> (outside Terraform) and `npm run recovery -- table-prepare` marked it, add N+1 to
# `game_generations` and uncomment (import blocks live only in a root module):
#
# import {
#   to = module.app.aws_dynamodb_table.game["2"]
#   id = "gs-staging-game-g2"
# }
#
# The next plan then shows the import AND an in-place update re-enabling point-in-time recovery and deletion protection (a
# restore carries neither). `generation` itself moves to N+1 only after `appgen-adopt` settled and `awsDeploy
# generation-gate` passed (infra/aws/README.md "Generation switch").
