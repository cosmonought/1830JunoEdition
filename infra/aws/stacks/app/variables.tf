# Types are checked by the module (modules/app/variables.tf); this root only passes them through.

variable "region" {
  description = "The app account's region: the runtime document's `region` (game and identity tables, SSM, ECS)."
  type        = string
}

variable "app_account_id" {
  description = "The account these credentials must be (explicit: a wrong profile refuses the plan)."
  type        = string
}

variable "environment" {
  type = string
}

variable "generation" {
  type = number
}

variable "ledger_table_arn" {
  type = string
}

variable "signing_keys" {
  type    = any
  default = null
}

variable "escrow" {
  type    = any
  default = null
}

variable "money_tables_nonmainnet" {
  type    = bool
  default = false
}

variable "network" {
  type = any
}

variable "build_id" {
  type = string
}

variable "container_port" {
  type    = number
  default = 8917
}

variable "allowed_origins" {
  type = list(string)
}

variable "trusted_proxy_hops" {
  type    = number
  default = 2
}

variable "pools" {
  type    = any
  default = { p1 = { primary = true } }
}

variable "start_services" {
  type    = bool
  default = false
}

variable "health_check_grace_period_seconds" {
  type    = number
  default = 300
}

variable "alb" {
  type = any
}

variable "edge" {
  type    = any
  default = {}
}

variable "log_retention_days" {
  type    = number
  default = 365
}

variable "bootstrap_trusted_principal_arns" {
  type = list(string)
}

variable "tags" {
  type    = map(string)
  default = {}
}
