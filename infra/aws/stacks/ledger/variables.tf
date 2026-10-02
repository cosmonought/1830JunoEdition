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

variable "tags" {
  type    = map(string)
  default = {}
}

# COST-1 (infra/aws/SINGLE_HOST_MIGRATION.md): the single host's app role (stacks/single-host output `app_role_arn`).
variable "app_runtime_role_arns" {
  type    = list(string)
  default = []
}

variable "ecs_task_role_authorized" {
  type    = bool
  default = true
}
