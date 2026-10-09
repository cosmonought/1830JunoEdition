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

# LIVE-6 relayer rotation: the prepared next / retained previous relayer key (infra/aws/README.md "Relayer rotation").
variable "relayer_rotation_key_arns" {
  type    = list(string)
  default = []
}

# PHASE 3 ESCROW 2.1: the DEDICATED REMEDY key (the ledger stack's remedy_key_arns.<label>), with escrow.remedy_key.
variable "remedy_signing_key" {
  type    = string
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

variable "edge_diagnostic_staging" {
  type    = bool
  default = false
}

variable "conduct_reviewers" {
  type    = list(string)
  default = []
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

variable "ludum_origins" {
  description = "The Ludum site's exact https origin(s) for the runtime document (modules/app validates). Default [] = no field."
  type        = list(string)
  default     = []
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

variable "game_generations" {
  type    = set(number)
  default = []
}

variable "generation_adoption" {
  type = object({
    generation = number
    game_table = string
    restore_id = string
  })
  default = null
}

variable "identity_layout_version" {
  type    = number
  default = 2
}

variable "operator_trusted_principal_arns" {
  type    = list(string)
  default = []
}

variable "recovery_trusted_principal_arns" {
  type    = list(string)
  default = []
}

variable "recovery_break_glass" {
  type    = bool
  default = false
}

variable "bootstrap_trusted_principal_arns" {
  type = list(string)
}

variable "tags" {
  type    = map(string)
  default = {}
}

variable "page_alarm_action_arns" {
  description = "LIVE-6 L6-5B: CloudWatch alarm action ARNs for PAGE alarms (may be empty in staging; see the module)."
  type        = list(string)
  default     = []
}

variable "ticket_alarm_action_arns" {
  description = "LIVE-6 L6-5B: CloudWatch alarm action ARNs for TICKET alarms (may be empty in staging; never a page ARN)."
  type        = list(string)
  default     = []
}

# COST-1: "ecs" (default, unchanged) or "none" -- the single host serves (stacks/single-host); this stack then keeps only
# the tables, the SSM documents, ECR, the operator roles and CloudFront. infra/aws/SINGLE_HOST_MIGRATION.md step I.
variable "compute" {
  type    = string
  default = "ecs"
}
