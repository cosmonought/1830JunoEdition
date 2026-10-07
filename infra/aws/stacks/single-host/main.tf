# COST-1: the LOW-COST single-host deployment's root (the APP account; `allowed_account_ids` refuses any other account).
# It creates ONLY the host and what the host needs (modules/single-host); every authority it serves -- the game and
# identity tables, the SSM documents, the ECR repository, the CloudFront distribution (stacks/app) and the ledger table
# and signing keys (stacks/ledger) -- already exists and is REFERENCED, never created. The budget decision and its guard:
# docs/hosting-budget.md, infra/aws/COST_BUDGET.json. The migration from the ECS topology: infra/aws/SINGLE_HOST_MIGRATION.md.
# State: an S3 backend configured at `terraform init` (-backend-config=...), one state per environment.

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
    tags = { "gs:managed-by" = "terraform", "gs:stack" = "single-host", "gs:environment" = var.environment, "gs:cost" = "single-host" }
  }
}

module "host" {
  source = "../../modules/single-host"

  environment             = var.environment
  pool                    = var.pool
  generation              = var.generation
  game_generations        = var.game_generations
  ledger_table_arn        = var.ledger_table_arn
  signing_keys            = var.signing_keys
  escrow_enabled          = var.escrow_enabled
  network                 = var.network
  instance                = var.instance
  origin_hostname         = var.origin_hostname
  acme_email              = var.acme_email
  allowed_origins         = var.allowed_origins
  trusted_proxy_hops      = var.trusted_proxy_hops
  money_tables_nonmainnet = var.money_tables_nonmainnet
  edge_diagnostic_staging = var.edge_diagnostic_staging
  conduct_reviewers       = var.conduct_reviewers
  caddy_image             = var.caddy_image
  ecr_repository_name     = var.ecr_repository_name
  manage_ecr_lifecycle    = var.manage_ecr_lifecycle
  ecr_keep_images         = var.ecr_keep_images
  log_retention_days      = var.log_retention_days
  alarm_action_arns       = var.alarm_action_arns
  ssm_agent               = var.ssm_agent
  emergency_ssh_cidrs     = var.emergency_ssh_cidrs
  termination_protection  = var.termination_protection
  budget                  = var.budget
  tags                    = var.tags
}
