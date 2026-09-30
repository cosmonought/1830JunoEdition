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

variable "tags" {
  type    = map(string)
  default = {}
}
