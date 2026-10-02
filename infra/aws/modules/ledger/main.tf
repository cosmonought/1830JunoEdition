# ==================================================================
#  LIVE-5 L5-8: THE LEDGER ACCOUNT -- THE LEDGER TABLE, ITS SEPARATE DURABILITY BOUNDARY, AND THE THREE SIGNING KEYS
# ==================================================================
#
# L5-7 §14 (the contract this implements):
#   gs-<env>-ledger   string pk HASH + string sk RANGE, no GSI/LSI, on-demand, PITR, deletion protection, never a Global
#                     Table, NO TTL. The app task reaches it cross-account by its full table ARN (resource policy below).
#                     APPGEN / APPGEN = {schema 1, current_generation N} must exist before the first start -- written
#                     by the deploy bootstrap (`npm run awsDeploy -- bootstrap`), NEVER by Terraform: it is a mutable
#                     control-plane record (L6-4 moves it), and a Terraform-managed item would later be "corrected" back.
#   KMS               three ECC_SECG_P256K1 / SIGN_VERIFY keys (relayer, settlement, admission), named by KEY ARN in the
#                     Juno configuration (never an alias); the task role may GetPublicKey, and Sign only with
#                     ECDSA_SHA_256 over a DIGEST.
#
# GRANTS TO THE APP ACCOUNT are made to its account root with an `aws:PrincipalArn` condition naming the exact role
# (gs-<env>-app-task, gs-<env>-bootstrap). Both halves are required cross-account: this policy AND the role's own IAM policy
# (the app stack). The task role's ledger rights are narrower than on the game/identity tables: GetItem, Query,
# ConditionCheckItem, and PutItem on any partition EXCEPT APPGEN -- no UpdateItem, no DeleteItem, no Scan.
#
# NOTHING HERE RESTORES OR ADOPTS: AWS Backup keeps recovery points in a locked vault; restoring one and adopting a new
# generation is L6-4's.

data "aws_partition" "current" {}
data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

locals {
  partition      = data.aws_partition.current.partition
  ledger_account = data.aws_caller_identity.current.account_id
  region         = data.aws_region.current.region
  table_name     = "gs-${var.environment}-ledger"
  app_root       = "arn:${local.partition}:iam::${var.app_account_id}:root"
  ledger_root    = "arn:${local.partition}:iam::${local.ledger_account}:root"
  task_role_arn  = "arn:${local.partition}:iam::${var.app_account_id}:role/gs-${var.environment}-app-task"
  bootstrap_arn  = "arn:${local.partition}:iam::${var.app_account_id}:role/gs-${var.environment}-bootstrap"
  # LIVE-6 L6-2: the operator (`gamesDoctor aws`, read only here) and the recovery (`npm run recovery`, L6-4) roles.
  operator_arn    = "arn:${local.partition}:iam::${var.app_account_id}:role/gs-${var.environment}-operator"
  recovery_arn    = "arn:${local.partition}:iam::${var.app_account_id}:role/gs-${var.environment}-recovery"
  signing_purpose = var.signing_keys_enabled ? toset(concat(["relayer", "settlement", "admission"], [for label in local.relayer_rotation_labels : "relayer-${label}"])) : toset([])
  tags            = merge(var.tags, { "gs:environment" = var.environment, "gs:component" = "ledger", "gs:slice" = "live5-l5-8" })
}

locals {
  # LIVE-6 relayer rotation: the relayer keys beyond the original one, `r2` ... `r<relayer_key_count>`, join
  # `signing_purpose` above as `relayer-r<N>`. The original (`r1`) stays at its L5-8 address `aws_kms_key.signing["relayer"]`:
  # never renamed, never replaced. Each extra key is ONE MORE instance of the same resource, with the same spec, the same
  # key policy and `prevent_destroy`.
  relayer_rotation_labels = [for n in range(2, var.relayer_key_count + 1) : "r${n}"]
  # The certification's post-rotation proof reads the relayer fences (bootstrap role, read only): only once a rotation exists.
  relayer_rotation_reads = var.signing_keys_enabled && var.relayer_key_count > 1
}

/* ------------------------------------------------------------------ */
/* The ledger table                                                     */
/* ------------------------------------------------------------------ */

resource "aws_dynamodb_table" "ledger" {
  name                        = local.table_name
  billing_mode                = "PAY_PER_REQUEST"
  hash_key                    = "pk"
  range_key                   = "sk"
  table_class                 = "STANDARD"
  deletion_protection_enabled = true

  attribute {
    name = "pk"
    type = "S"
  }
  attribute {
    name = "sk"
    type = "S"
  }

  point_in_time_recovery {
    enabled                 = true
    recovery_period_in_days = 35
  }

  # No `ttl` block (no ledger item may expire), no `global_secondary_index` / `local_secondary_index`, no `replica`
  # (never a Global Table), no stream. Encryption: DynamoDB's default (an AWS owned key).

  tags = merge(local.tags, { Name = local.table_name })

  lifecycle {
    # Deletion protection is the AWS-side guard; this is Terraform's own: a plan that would destroy or REPLACE the ledger
    # (a renamed table is a replacement) fails instead of being applied.
    prevent_destroy = true

    precondition {
      condition     = local.partition == "aws"
      error_message = "The runtime's ARN parsers accept only the commercial `aws` partition."
    }
  }
}

data "aws_iam_policy_document" "ledger_resource" {
  statement {
    sid       = "AppTaskLedgerRead"
    effect    = "Allow"
    actions   = ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:ConditionCheckItem"]
    resources = [aws_dynamodb_table.ledger.arn]
    principals {
      type        = "AWS"
      identifiers = [local.app_root]
    }
    condition {
      test     = "ArnEquals"
      variable = "aws:PrincipalArn"
      values   = [local.task_role_arn]
    }
  }

  statement {
    sid       = "AppTaskLedgerPutNeverAppgen"
    effect    = "Allow"
    actions   = ["dynamodb:PutItem"]
    resources = [aws_dynamodb_table.ledger.arn]
    principals {
      type        = "AWS"
      identifiers = [local.app_root]
    }
    condition {
      test     = "ArnEquals"
      variable = "aws:PrincipalArn"
      values   = [local.task_role_arn]
    }
    # Defence in depth (the fences are the safety): the task never writes APPGEN or APPGEN#HISTORY (L6-2 review M4: a
    # pre-created GEN#<N+1> would block that adoption for good); the bootstrap and the recovery role do.
    condition {
      test     = "ForAllValues:StringNotEquals"
      variable = "dynamodb:LeadingKeys"
      values   = ["APPGEN", "APPGEN#HISTORY"]
    }
  }

  statement {
    sid       = "BootstrapAppgenOnly"
    effect    = "Allow"
    actions   = ["dynamodb:GetItem", "dynamodb:PutItem"]
    resources = [aws_dynamodb_table.ledger.arn]
    principals {
      type        = "AWS"
      identifiers = [local.app_root]
    }
    condition {
      test     = "ArnEquals"
      variable = "aws:PrincipalArn"
      values   = [local.bootstrap_arn]
    }
    condition {
      test     = "ForAllValues:StringEquals"
      variable = "dynamodb:LeadingKeys"
      values   = ["APPGEN"]
    }
  }

  # LIVE-6 L6-2: the generation gate reads APPGEN's adoption history (read only).
  statement {
    sid       = "BootstrapAppgenHistoryRead"
    effect    = "Allow"
    actions   = ["dynamodb:GetItem"]
    resources = [aws_dynamodb_table.ledger.arn]
    principals {
      type        = "AWS"
      identifiers = [local.app_root]
    }
    condition {
      test     = "ArnEquals"
      variable = "aws:PrincipalArn"
      values   = [local.bootstrap_arn]
    }
    condition {
      test     = "ForAllValues:StringEquals"
      variable = "dynamodb:LeadingKeys"
      values   = ["APPGEN#HISTORY"]
    }
  }

  # LIVE-6 L6-2 (L6-3 §11 item 4): the operator reads APPGEN and the relayer fences, and scans (read-only) for the
  # restore's orphans report. No write.
  statement {
    sid       = "OperatorLedgerReadOnly"
    effect    = "Allow"
    actions   = ["dynamodb:GetItem", "dynamodb:Scan"]
    resources = [aws_dynamodb_table.ledger.arn]
    principals {
      type        = "AWS"
      identifiers = [local.app_root]
    }
    condition {
      test     = "ArnEquals"
      variable = "aws:PrincipalArn"
      values   = [local.operator_arn]
    }
  }

  # LIVE-6 L6-2 (L6-4 §12.1 item 3): the recovery role -- reads and scans (the SEC# journal replay), adopts APPGEN (its one
  # update) and appends the adoption's history item. Never a delete; never another item's update.
  statement {
    sid       = "RecoveryLedgerRead"
    effect    = "Allow"
    actions   = ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:Scan"]
    resources = [aws_dynamodb_table.ledger.arn]
    principals {
      type        = "AWS"
      identifiers = [local.app_root]
    }
    condition {
      test     = "ArnEquals"
      variable = "aws:PrincipalArn"
      values   = [local.recovery_arn]
    }
  }

  statement {
    sid       = "RecoveryAppgenAdoption"
    effect    = "Allow"
    actions   = ["dynamodb:UpdateItem"]
    resources = [aws_dynamodb_table.ledger.arn]
    principals {
      type        = "AWS"
      identifiers = [local.app_root]
    }
    condition {
      test     = "ArnEquals"
      variable = "aws:PrincipalArn"
      values   = [local.recovery_arn]
    }
    condition {
      test     = "ForAllValues:StringEquals"
      variable = "dynamodb:LeadingKeys"
      values   = ["APPGEN"]
    }
  }

  statement {
    sid       = "RecoveryAppgenHistoryAppend"
    effect    = "Allow"
    actions   = ["dynamodb:PutItem"]
    resources = [aws_dynamodb_table.ledger.arn]
    principals {
      type        = "AWS"
      identifiers = [local.app_root]
    }
    condition {
      test     = "ArnEquals"
      variable = "aws:PrincipalArn"
      values   = [local.recovery_arn]
    }
    condition {
      test     = "ForAllValues:StringEquals"
      variable = "dynamodb:LeadingKeys"
      values   = ["APPGEN#HISTORY"]
    }
  }

  # LIVE-6 relayer rotation: the staging certification's post-rotation proof (`stage-cert certify --scenario
  # relayer-rotation-drill`, bootstrap role) reads `FENCE#relayer#<address>` -- the relayer epoch the ledger minted -- to
  # compare it with the game table's mirror. GetItem only, those partitions only; present only once a second relayer key
  # exists (an ordinary one-relayer deployment's policy is unchanged).
  dynamic "statement" {
    for_each = local.relayer_rotation_reads ? [1] : []
    content {
      sid       = "BootstrapRelayerFenceRead"
      effect    = "Allow"
      actions   = ["dynamodb:GetItem"]
      resources = [aws_dynamodb_table.ledger.arn]
      principals {
        type        = "AWS"
        identifiers = [local.app_root]
      }
      condition {
        test     = "ArnEquals"
        variable = "aws:PrincipalArn"
        values   = [local.bootstrap_arn]
      }
      condition {
        test     = "ForAllValues:StringLike"
        variable = "dynamodb:LeadingKeys"
        values   = ["FENCE#relayer#*"]
      }
    }
  }

  statement {
    sid       = "BootstrapDescribe"
    effect    = "Allow"
    actions   = ["dynamodb:DescribeTable"]
    resources = [aws_dynamodb_table.ledger.arn]
    principals {
      type        = "AWS"
      identifiers = [local.app_root]
    }
    condition {
      test     = "ArnEquals"
      variable = "aws:PrincipalArn"
      values   = [local.bootstrap_arn]
    }
  }
}

resource "aws_dynamodb_resource_policy" "ledger" {
  resource_arn = aws_dynamodb_table.ledger.arn
  policy       = data.aws_iam_policy_document.ledger_resource.json
}

/* ------------------------------------------------------------------ */
/* The separate durability boundary: AWS Backup into a locked vault      */
/* ------------------------------------------------------------------ */

resource "aws_backup_vault" "ledger" {
  name          = local.table_name
  kms_key_arn   = var.backup.vault_kms_key_arn
  force_destroy = false
  tags          = local.tags
}

resource "aws_backup_vault_lock_configuration" "ledger" {
  backup_vault_name   = aws_backup_vault.ledger.name
  min_retention_days  = var.backup.retention_days
  max_retention_days  = 3650
  changeable_for_days = var.backup.vault_lock_mode == "compliance" ? var.backup.changeable_for_days : null
}

data "aws_iam_policy_document" "vault_access" {
  statement {
    sid       = "NoEarlyDeletionOrShortening"
    effect    = "Deny"
    actions   = ["backup:DeleteRecoveryPoint", "backup:UpdateRecoveryPointLifecycle"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = ["*"]
    }
  }
}

resource "aws_backup_vault_policy" "ledger" {
  backup_vault_name = aws_backup_vault.ledger.name
  policy            = data.aws_iam_policy_document.vault_access.json
}

data "aws_iam_policy_document" "backup_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["backup.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "backup" {
  name               = "gs-${var.environment}-ledger-backup"
  assume_role_policy = data.aws_iam_policy_document.backup_assume.json
  tags               = local.tags
}

# Backup only: nothing here may restore (restoring the ledger and adopting a generation is L6-4's, by an operator).
resource "aws_iam_role_policy_attachment" "backup" {
  role       = aws_iam_role.backup.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForBackup"
}

resource "aws_backup_plan" "ledger" {
  name = local.table_name

  rule {
    rule_name         = "daily"
    target_vault_name = aws_backup_vault.ledger.name
    schedule          = var.backup.schedule
    start_window      = 60
    completion_window = 360

    lifecycle {
      delete_after = var.backup.retention_days
    }

    dynamic "copy_action" {
      for_each = var.backup.copy_to_vault_arn == null ? [] : [var.backup.copy_to_vault_arn]
      content {
        destination_vault_arn = copy_action.value
        lifecycle {
          delete_after = var.backup.retention_days
        }
      }
    }
  }

  tags = local.tags
}

resource "aws_backup_selection" "ledger" {
  name         = local.table_name
  plan_id      = aws_backup_plan.ledger.id
  iam_role_arn = aws_iam_role.backup.arn
  # The ledger ONLY: the game and identity tables are the app's (PITR), and are never restored together with it.
  resources = [aws_dynamodb_table.ledger.arn]
}

/* ------------------------------------------------------------------ */
/* The three signing keys (and, for a relayer rotation, more relayer keys) */
/* ------------------------------------------------------------------ */
#
# LIVE-6 RELAYER ROTATION. An asymmetric KMS key cannot rotate: a new relayer key is a new Juno account (preflight §11.7).
# `relayer_key_count` (default 1: the L5-8 deployment, byte for byte) is APPEND-ONLY. Raising it by one PREPARES a
# rotation: the next key `relayer-r<N>` is created BESIDE the current one, with exactly the same spec and key policy (the
# app task role may GetPublicKey and Sign ECDSA_SHA_256 over a DIGEST; the bootstrap / verifier role may DescribeKey,
# GetPublicKey and ListGrants; nobody may CreateGrant), so `awsDeploy signer-keys` derives its address before anything
# is switched. WHICH key the deployment uses is the app stack's choice (`signing_keys.relayer`, by key ARN), never
# this module's: the prepared key signs nothing until the app stack names it, because the task role's own IAM policy
# names only the configured keys (both halves are required). The old key is never destroyed here: lowering the count
# would destroy the NEWEST key and `prevent_destroy` refuses that plan; an OLDER key cannot be named for removal at all.
# Retiring a relayer key is a separate, reviewed change (a `removed` block with `destroy = false`, then a scheduled
# deletion by hand), never a variable.

data "aws_iam_policy_document" "signing" {
  for_each = local.signing_purpose

  # This account administers the key but, deliberately, is not granted kms:Sign (or Verify) here, NOR kms:CreateGrant (a
  # grant would hand Sign to anyone without appearing in this policy): only the app task role signs. (An administrator
  # could still rewrite this policy -- PutKeyPolicy -- which CloudTrail records; `awsDeploy verify` checks that no key
  # carries a grant.)
  statement {
    sid    = "KeyAdministrationWithoutSigning"
    effect = "Allow"
    actions = [
      "kms:Describe*", "kms:Get*", "kms:List*", "kms:PutKeyPolicy", "kms:UpdateKeyDescription",
      "kms:EnableKey", "kms:DisableKey", "kms:RevokeGrant", "kms:RetireGrant", "kms:TagResource", "kms:UntagResource",
      "kms:ScheduleKeyDeletion", "kms:CancelKeyDeletion",
    ]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = [local.ledger_root]
    }
  }

  statement {
    sid       = "AppTaskPublicKey"
    effect    = "Allow"
    actions   = ["kms:GetPublicKey"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = [local.app_root]
    }
    condition {
      test     = "ArnEquals"
      variable = "aws:PrincipalArn"
      values   = [local.task_role_arn]
    }
  }

  statement {
    sid       = "AppTaskSignDigestOnly"
    effect    = "Allow"
    actions   = ["kms:Sign"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = [local.app_root]
    }
    condition {
      test     = "ArnEquals"
      variable = "aws:PrincipalArn"
      values   = [local.task_role_arn]
    }
    condition {
      test     = "StringEquals"
      variable = "kms:SigningAlgorithm"
      values   = ["ECDSA_SHA_256"]
    }
    condition {
      test     = "StringEquals"
      variable = "kms:MessageType"
      values   = ["DIGEST"]
    }
  }

  statement {
    sid       = "BootstrapVerifyReadOnly"
    effect    = "Allow"
    actions   = ["kms:DescribeKey", "kms:GetPublicKey", "kms:ListGrants"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = [local.app_root]
    }
    condition {
      test     = "ArnEquals"
      variable = "aws:PrincipalArn"
      values   = [local.bootstrap_arn]
    }
  }
}

resource "aws_kms_key" "signing" {
  for_each = local.signing_purpose

  description              = "18Cosmos ${var.environment} ${each.key} signing key (secp256k1, digest only; named by key ARN, never an alias)"
  customer_master_key_spec = "ECC_SECG_P256K1"
  key_usage                = "SIGN_VERIFY"
  multi_region             = false
  is_enabled               = true
  enable_key_rotation      = false # asymmetric keys cannot rotate; a new key is a new identity on chain
  deletion_window_in_days  = 30
  policy                   = data.aws_iam_policy_document.signing[each.key].json

  # The original three keep their L5-8 tags exactly; a rotation key's purpose is `relayer`, its label says which one.
  tags = merge(local.tags, { Name = "gs-${var.environment}-${each.key}", "gs:signing-purpose" = startswith(each.key, "relayer-") ? "relayer" : each.key }, startswith(each.key, "relayer-") ? { "gs:relayer-key" = trimprefix(each.key, "relayer-") } : {})

  lifecycle {
    # Destroying a signing key destroys the relayer account / the settlement or admission identity.
    prevent_destroy = true
  }
}
