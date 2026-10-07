# Types and validation live in the module (modules/single-host/variables.tf); this root only passes them through.

variable "region" {
  description = "The app account's region (the runtime document's `region`)."
  type        = string
}

variable "app_account_id" {
  description = "The account these credentials must be (explicit: a wrong profile refuses the plan)."
  type        = string
}

variable "environment" {
  type = string
}

variable "pool" {
  type    = string
  default = "p1"
}

variable "generation" {
  type = number
}

variable "game_generations" {
  type    = set(number)
  default = []
}

variable "ledger_table_arn" {
  type = string
}

variable "signing_keys" {
  type    = any
  default = null
}

variable "escrow_enabled" {
  type    = bool
  default = false
}

variable "network" {
  type = any
}

variable "instance" {
  type = any
}

variable "origin_hostname" {
  type = string
}

variable "acme_email" {
  type    = string
  default = null
}

variable "allowed_origins" {
  type = list(string)
}

variable "trusted_proxy_hops" {
  type    = number
  default = 2
}

variable "money_tables_nonmainnet" {
  type    = bool
  default = false
}

variable "edge_diagnostic_staging" {
  type    = bool
  default = false
}

variable "conduct_reviewers" {
  description = "GS_CONDUCT_REVIEWERS (the module validates it). Changing it changes the host's user data: see infra/aws/SINGLE_HOST_MIGRATION.md before planning it on a running host."
  type        = list(string)
  default     = []
}

variable "caddy_image" {
  type    = string
  default = "public.ecr.aws/docker/library/caddy:2-alpine@sha256:6aeddd44c3078b0f9a35206472a11420648a79c184603ef95957d0a20044cb2b"
}

variable "ecr_repository_name" {
  type    = string
  default = null
}

variable "manage_ecr_lifecycle" {
  type    = bool
  default = false
}

variable "ecr_keep_images" {
  type    = number
  default = 20
}

variable "log_retention_days" {
  type    = number
  default = 90
}

variable "alarm_action_arns" {
  type    = list(string)
  default = []
}

variable "ssm_agent" {
  type    = bool
  default = true
}

variable "emergency_ssh_cidrs" {
  type    = list(string)
  default = []
}

variable "termination_protection" {
  type    = bool
  default = true
}

variable "budget" {
  type    = any
  default = {}
}

variable "tags" {
  type    = map(string)
  default = {}
}
