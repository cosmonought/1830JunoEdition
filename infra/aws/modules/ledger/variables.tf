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

variable "relayer_key_count" {
  description = <<-EOT
    LIVE-6 relayer rotation: how many relayer signing keys this ledger holds (>= 1; default 1 = the L5-8 deployment,
    unchanged). Key 1 (`r1`) is the original relayer key at its unchanged address `aws_kms_key.signing["relayer"]`; key N >= 2
    (`rN`) is `aws_kms_key.signing["relayer-rN"]`, same spec, same key policy, `prevent_destroy`. APPEND-ONLY: raise it by
    one to PREPARE a rotation (the new key exists beside the current one; the app stack still names the current one).
    Lowering it would destroy the newest key: `prevent_destroy` refuses the plan. An older key cannot be removed through
    this variable at all -- retiring a relayer key is a separate, reviewed change. Output: `relayer_key_arns`.
  EOT
  type        = number
  default     = 1
  validation {
    condition     = var.relayer_key_count >= 1 && var.relayer_key_count <= 16 && floor(var.relayer_key_count) == var.relayer_key_count
    error_message = "relayer_key_count must be a whole number 1..16: the original relayer key (r1) can never be dropped by this variable."
  }
  validation {
    condition     = var.relayer_key_count == 1 || var.signing_keys_enabled
    error_message = "relayer_key_count > 1 needs signing_keys_enabled: a rotation key is a signing key."
  }
}

variable "app_runtime_role_arns" {
  description = <<-EOT
    COST-1: further APP RUNTIME roles (beside the ECS task role gs-<env>-app-task) that get exactly the task role's ledger
    grants (read / condition-check; append everything but APPGEN and APPGEN#HISTORY) and its key grants (GetPublicKey;
    Sign with ECDSA_SHA_256 over a DIGEST). ALLOWLIST: only the single host's app role gs-<env>-host-app of the app
    account (stacks/single-host output `app_role_arn`) -- never a deploy, operator, recovery, backup or any other role,
    present or future. Default empty: every policy is unchanged.
  EOT
  type        = list(string)
  default     = []
  validation {
    condition     = alltrue([for arn in var.app_runtime_role_arns : arn == "arn:aws:iam::${var.app_account_id}:role/gs-${var.environment}-host-app"])
    error_message = "app_runtime_role_arns: only the single host's app role, arn:aws:iam::<app account>:role/gs-<environment>-host-app (an allowlist: no other role may sign or append to the ledger)."
  }
  validation {
    condition     = length(distinct(var.app_runtime_role_arns)) == length(var.app_runtime_role_arns)
    error_message = "app_runtime_role_arns lists each role once."
  }
}

variable "ecs_task_role_authorized" {
  description = "COST-1: whether the ECS task role (gs-<env>-app-task) keeps its ledger and key grants. Default true (unchanged). Set false only AFTER the ECS services are gone (infra/aws/SINGLE_HOST_MIGRATION.md step I): a later role of that name would otherwise inherit them."
  type        = bool
  default     = true
  validation {
    condition     = var.ecs_task_role_authorized || length(var.app_runtime_role_arns) > 0
    error_message = "At least one app runtime role must remain authorised (the ECS task role or an app_runtime_role_arns entry)."
  }
}

variable "financial_key_sets" {
  description = <<-EOT
    JX-1K (Phase 5): labels of ADDITIONAL settlement + admission key PAIRS. Each label <l> creates exactly
    `settlement-<l>` and `admission-<l>` (`aws_kms_key.signing["settlement-<l>"]` / `["admission-<l>"]`) beside the
    original three -- same spec (ECC_SECG_P256K1 / SIGN_VERIFY, single-region), same key policy, `prevent_destroy`.
    Default [] = the L5-8 / LIVE-6 deployment, unchanged. APPEND-ONLY: removing a label would destroy its keys and
    `prevent_destroy` refuses that plan. These are financial signing keys, never relayer-rotation keys. WHICH pair the
    deployment signs with is the app stack's `signing_keys.settlement` / `signing_keys.admission` (by key ARN), never this
    module's. Output: `financial_key_arns`.
  EOT
  type        = list(string)
  default     = []
  nullable    = false
  validation {
    condition     = alltrue([for l in var.financial_key_sets : can(regex("^[a-z][a-z0-9]{1,15}$", l)) && !can(regex("^r[0-9]+$", l))])
    error_message = "financial_key_sets: each label must match ^[a-z][a-z0-9]{1,15}$ (lowercase, starts with a letter, no hyphen, 2..16 chars) and must not be r<N> (the relayer rotation labels)."
  }
  validation {
    condition     = length(distinct(var.financial_key_sets)) == length(var.financial_key_sets)
    error_message = "financial_key_sets: each label at most once."
  }
  validation {
    condition     = length(var.financial_key_sets) == 0 || var.signing_keys_enabled
    error_message = "financial_key_sets needs signing_keys_enabled: a financial key is a signing key."
  }
}

variable "remedy_key_count" {
  description = <<-EOT
    PHASE 3 ESCROW 2.1 (owner decision 2026-10-08): how many DEDICATED REMEDY signing keys this ledger holds -- escrow 2.1.0's
    REMEDY attestation authority, its own signing purpose (never the relayer, settlement or admission key). Default 0: no
    remedy key, every existing plan unchanged (and the server, configured without one, refuses every timed money table: fail
    closed). Key N is `aws_kms_key.signing["remedy-r<N>"]` -- same spec (ECC_SECG_P256K1 / SIGN_VERIFY, single-region), same
    least-privilege key policy, `prevent_destroy`. APPEND-ONLY: raise it by one to create the first key or to PREPARE a
    rotation (the new key exists beside the current one; the app stack's `remedy_signing_key` still names the current one).
    Lowering it would destroy the newest key: `prevent_destroy` refuses that plan. Output: `remedy_key_arns`.
  EOT
  type        = number
  default     = 0
  nullable    = false
  validation {
    condition     = var.remedy_key_count >= 0 && var.remedy_key_count <= 16 && floor(var.remedy_key_count) == var.remedy_key_count
    error_message = "remedy_key_count must be a whole number 0..16."
  }
  validation {
    condition     = var.remedy_key_count == 0 || var.signing_keys_enabled
    error_message = "remedy_key_count > 0 needs signing_keys_enabled: a remedy key is a signing key."
  }
}

variable "tags" {
  description = "Tags on every resource."
  type        = map(string)
  default     = {}
}
