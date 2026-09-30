# LIVE-5 L5-8: the ledger account's inputs. Everything this module grants to the app account is granted to the app
# ACCOUNT's root with an `aws:PrincipalArn` condition naming exactly the role (the naming convention below), so this stack
# can be applied before the app stack's roles exist -- and a recreated role is not silently locked out (a key or table
# policy that names a role ARN directly is bound to that role's unique id).

variable "environment" {
  description = "The runtime document's `environment` label (^[a-z][a-z0-9-]{0,31}$). Every name here is gs-<environment>-..."
  type        = string
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{0,31}$", var.environment))
    error_message = "environment must match ^[a-z][a-z0-9-]{0,31}$ (the runtime document's rule)."
  }
}

variable "app_account_id" {
  description = "The app account (ECS, game and identity tables, SSM). May equal this account (the single-account form)."
  type        = string
  validation {
    condition     = can(regex("^[0-9]{12}$", var.app_account_id))
    error_message = "app_account_id must be 12 digits."
  }
}

variable "backup" {
  description = <<-EOT
    The ledger's separate durability boundary (L5-7 §14: never restored with the app; AWS Backup + vault lock).
      schedule             cron for the daily backup rule (UTC).
      retention_days       how long each recovery point is kept (vault lock's min/max bound it).
      vault_lock_mode      "governance" (default: a lock that principals with backup:BypassVaultLock can still manage)
                           or "compliance" (IMMUTABLE once changeable_for_days has passed -- an owner decision).
      changeable_for_days  compliance mode only: the cooling-off window (>= 3) before the lock becomes permanent.
      copy_to_vault_arn    optional: a vault in another account/region each recovery point is also copied to.
      vault_kms_key_arn    optional: a customer-managed key for the vault (required by AWS for cross-account copies).
  EOT
  type = object({
    schedule            = optional(string, "cron(17 3 * * ? *)")
    retention_days      = optional(number, 35)
    vault_lock_mode     = optional(string, "governance")
    changeable_for_days = optional(number, null)
    copy_to_vault_arn   = optional(string, null)
    vault_kms_key_arn   = optional(string, null)
  })
  default = {}
  validation {
    condition     = contains(["governance", "compliance"], var.backup.vault_lock_mode)
    error_message = "backup.vault_lock_mode must be governance or compliance."
  }
  validation {
    condition     = var.backup.vault_lock_mode == "governance" ? var.backup.changeable_for_days == null : (var.backup.changeable_for_days != null && var.backup.changeable_for_days >= 3)
    error_message = "backup.changeable_for_days is required (>= 3) in compliance mode and not allowed in governance mode."
  }
  validation {
    condition     = var.backup.retention_days >= 7 && var.backup.retention_days <= 3650
    error_message = "backup.retention_days must be 7..3650."
  }
}

variable "signing_keys_enabled" {
  description = "Create the three KMS signing keys (relayer, settlement, admission). Required before escrow is enabled in the app stack."
  type        = bool
  default     = true
}

variable "tags" {
  description = "Tags on every resource."
  type        = map(string)
  default     = {}
}
