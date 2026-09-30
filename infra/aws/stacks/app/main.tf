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
  ledger_table_arn                  = var.ledger_table_arn
  signing_keys                      = var.signing_keys
  escrow                            = var.escrow
  money_tables_nonmainnet           = var.money_tables_nonmainnet
  edge_diagnostic_staging           = var.edge_diagnostic_staging
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
  tags                              = var.tags
}
