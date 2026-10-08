# LIVE-5 L5-8: the LEDGER ACCOUNT's root (apply with the ledger account's credentials; `allowed_account_ids` refuses any
# other account). See infra/aws/README.md for the deploy order. State: an S3 backend configured at `terraform init`
# (-backend-config=...), one state per environment.

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
  allowed_account_ids = [var.ledger_account_id]

  default_tags {
    tags = { "gs:managed-by" = "terraform", "gs:stack" = "ledger", "gs:environment" = var.environment }
  }
}

module "ledger" {
  source = "../../modules/ledger"

  environment          = var.environment
  app_account_id       = var.app_account_id
  backup               = var.backup
  signing_keys_enabled = var.signing_keys_enabled
  relayer_key_count    = var.relayer_key_count
  financial_key_sets   = var.financial_key_sets
  remedy_key_count     = var.remedy_key_count

  # COST-1: the single host's app role beside (then instead of) the ECS task role.
  app_runtime_role_arns    = var.app_runtime_role_arns
  ecs_task_role_authorized = var.ecs_task_role_authorized
  tags                     = var.tags
}
