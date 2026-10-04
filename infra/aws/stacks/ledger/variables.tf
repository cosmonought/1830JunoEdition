variable "region" {
  description = "The ledger's region (and the KMS keys'). The runtime reads it from the ledger ARN, never the environment."
  type        = string
}

variable "ledger_account_id" {
  description = "The account these credentials must be (explicit: a wrong profile refuses the plan)."
  type        = string
}

variable "environment" {
  type = string
}

variable "app_account_id" {
  type = string
}

variable "backup" {
  type    = any
  default = {}
}

variable "signing_keys_enabled" {
  type    = bool
  default = true
}

# LIVE-6 relayer rotation (modules/ledger: append-only; raise by one to PREPARE a rotation, never lower it).
variable "relayer_key_count" {
  type    = number
  default = 1
}

# JX-1K (modules/ledger: append-only by label; never remove one): additional settlement + admission key pairs, e.g. ["jx1"].
variable "financial_key_sets" {
  type    = list(string)
  default = []
}

variable "tags" {
  type    = map(string)
  default = {}
}

# COST-1 (infra/aws/SINGLE_HOST_MIGRATION.md): the single host's app role (stacks/single-host output `app_role_arn`).
variable "app_runtime_role_arns" {
  type    = list(string)
  default = []
}

# PHASE 1 CLEAN-BUILD RESET: NO DEFAULT. Every plan of this root states it: after the ECS teardown it is false, and an
# omitted line can never re-grant the deleted task role's NAME (a later role of that name would inherit the ledger and
# key grants). infra/aws/PHASE1_LEGACY_TEARDOWN.md T5. The module's own default is unchanged.
variable "ecs_task_role_authorized" {
  type = bool
}
