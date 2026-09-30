# LIVE-5 L5-8: the ledger module against L5-7 §14 -- over a MOCKED provider (no AWS account, no credentials).
# Run: cd infra/aws/modules/ledger && terraform init -backend=false && terraform test

mock_provider "aws" {
  mock_data "aws_caller_identity" {
    defaults = { account_id = "222222222222" }
  }
  mock_data "aws_region" {
    defaults = { region = "us-east-1" }
  }
  mock_data "aws_partition" {
    defaults = { partition = "aws" }
  }
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }
  mock_resource "aws_dynamodb_table" {
    defaults = { arn = "arn:aws:dynamodb:us-east-1:222222222222:table/gs-staging-ledger" }
  }
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::222222222222:role/gs-staging-ledger-backup" }
  }
}

variables {
  environment    = "staging"
  app_account_id = "111111111111"
}

run "ledger_table_matches_the_contract" {
  command = apply

  assert {
    condition = (aws_dynamodb_table.ledger.name == "gs-staging-ledger" && aws_dynamodb_table.ledger.hash_key == "pk" && aws_dynamodb_table.ledger.range_key == "sk"
      && toset([for a in aws_dynamodb_table.ledger.attribute : "${a.name}:${a.type}"]) == toset(["pk:S", "sk:S"])
    && aws_dynamodb_table.ledger.billing_mode == "PAY_PER_REQUEST")
    error_message = "gs-<env>-ledger: string pk/sk, on-demand."
  }
  assert {
    condition     = aws_dynamodb_table.ledger.point_in_time_recovery[0].enabled && aws_dynamodb_table.ledger.deletion_protection_enabled
    error_message = "PITR and deletion protection."
  }
  assert {
    condition     = length(aws_dynamodb_table.ledger.global_secondary_index) == 0 && length(aws_dynamodb_table.ledger.local_secondary_index) == 0 && length(aws_dynamodb_table.ledger.replica) == 0
    error_message = "No GSI/LSI; never a Global Table."
  }
  assert {
    condition     = length([for t in aws_dynamodb_table.ledger.ttl : t if t.enabled]) == 0
    error_message = "No TTL on the ledger."
  }
}

run "resource_policy_is_narrower_than_the_app_tables" {
  command = apply

  assert {
    condition = { for s in data.aws_iam_policy_document.ledger_resource.statement : s.sid => toset(s.actions) } == {
      AppTaskLedgerRead           = toset(["dynamodb:GetItem", "dynamodb:Query", "dynamodb:ConditionCheckItem"])
      AppTaskLedgerPutNeverAppgen = toset(["dynamodb:PutItem"])
      BootstrapAppgenOnly         = toset(["dynamodb:GetItem", "dynamodb:PutItem"])
      BootstrapAppgenHistoryRead  = toset(["dynamodb:GetItem"])
      OperatorLedgerReadOnly      = toset(["dynamodb:GetItem", "dynamodb:Scan"])
      RecoveryLedgerRead          = toset(["dynamodb:GetItem", "dynamodb:Query", "dynamodb:Scan"])
      RecoveryAppgenAdoption      = toset(["dynamodb:UpdateItem"])
      RecoveryAppgenHistoryAppend = toset(["dynamodb:PutItem"])
      BootstrapDescribe           = toset(["dynamodb:DescribeTable"])
    }
    error_message = "The task: GetItem, Query, ConditionCheckItem, PutItem (never APPGEN) -- no UpdateItem, DeleteItem or Scan. L6-2: the operator reads only; the recovery role's only update is APPGEN, its only put the adoption history."
  }
  assert {
    condition = alltrue([for s in data.aws_iam_policy_document.ledger_resource.statement :
      contains([for c in s.condition : "${c.test}|${c.variable}|${join(",", c.values)}"],
    "ArnEquals|aws:PrincipalArn|arn:aws:iam::111111111111:role/gs-staging-${startswith(s.sid, "AppTask") ? "app-task" : startswith(s.sid, "Operator") ? "operator" : startswith(s.sid, "Recovery") ? "recovery" : "bootstrap"}")])
    error_message = "Every grant names the exact app-account role (account root + aws:PrincipalArn)."
  }
  assert {
    condition = (contains([for c in one([for s in data.aws_iam_policy_document.ledger_resource.statement : s if s.sid == "AppTaskLedgerPutNeverAppgen"]).condition : "${c.test}|${c.variable}|${join(",", c.values)}"], "ForAllValues:StringNotEquals|dynamodb:LeadingKeys|APPGEN,APPGEN#HISTORY")
    && contains([for c in one([for s in data.aws_iam_policy_document.ledger_resource.statement : s if s.sid == "BootstrapAppgenOnly"]).condition : "${c.test}|${c.variable}|${join(",", c.values)}"], "ForAllValues:StringEquals|dynamodb:LeadingKeys|APPGEN"))
    error_message = "APPGEN and APPGEN#HISTORY: never the task's write (L6-2 review M4); APPGEN the bootstrap's only item."
  }
  assert {
    condition = (contains([for c in one([for s in data.aws_iam_policy_document.ledger_resource.statement : s if s.sid == "RecoveryAppgenAdoption"]).condition : "${c.test}|${c.variable}|${join(",", c.values)}"], "ForAllValues:StringEquals|dynamodb:LeadingKeys|APPGEN")
    && contains([for c in one([for s in data.aws_iam_policy_document.ledger_resource.statement : s if s.sid == "RecoveryAppgenHistoryAppend"]).condition : "${c.test}|${c.variable}|${join(",", c.values)}"], "ForAllValues:StringEquals|dynamodb:LeadingKeys|APPGEN#HISTORY"))
    error_message = "L6-2 (L6-4 §12.1): the recovery role updates APPGEN only and appends APPGEN#HISTORY only."
  }
  assert {
    condition     = aws_dynamodb_resource_policy.ledger.resource_arn == aws_dynamodb_table.ledger.arn
    error_message = "The resource policy is on the ledger table."
  }
}

run "signing_keys_are_secp256k1_digest_signers" {
  command = apply

  assert {
    condition     = toset(keys(aws_kms_key.signing)) == toset(["relayer", "settlement", "admission"])
    error_message = "Three separate keys: relayer, settlement, admission."
  }
  assert {
    condition = alltrue([for k in aws_kms_key.signing :
    k.customer_master_key_spec == "ECC_SECG_P256K1" && k.key_usage == "SIGN_VERIFY" && !k.multi_region && !k.enable_key_rotation])
    error_message = "ECC_SECG_P256K1 / SIGN_VERIFY, single-region."
  }
  assert {
    condition = alltrue([for purpose, doc in data.aws_iam_policy_document.signing :
      toset([for c in one([for s in doc.statement : s if s.sid == "AppTaskSignDigestOnly"]).condition : "${c.test}|${c.variable}|${join(",", c.values)}"]) == toset([
        "ArnEquals|aws:PrincipalArn|arn:aws:iam::111111111111:role/gs-staging-app-task",
        "StringEquals|kms:SigningAlgorithm|ECDSA_SHA_256",
        "StringEquals|kms:MessageType|DIGEST",
      ])
    ])
    error_message = "Only the app task role signs, only ECDSA_SHA_256 over a DIGEST."
  }
  assert {
    condition = alltrue([for purpose, doc in data.aws_iam_policy_document.signing :
    alltrue([for s in doc.statement : alltrue([for a in s.actions : !contains(["kms:Sign", "kms:*", "kms:CreateGrant", "kms:Create*", "kms:Sign*"], a)]) if s.sid != "AppTaskSignDigestOnly"])])
    error_message = "No other statement grants kms:Sign, kms:* or kms:CreateGrant (a grant would hand out Sign unseen) -- not even the key's own account."
  }
  assert {
    condition = alltrue([for purpose, doc in data.aws_iam_policy_document.signing :
    toset(one([for s in doc.statement : s if s.sid == "BootstrapVerifyReadOnly"]).actions) == toset(["kms:DescribeKey", "kms:GetPublicKey", "kms:ListGrants"])])
    error_message = "The bootstrap / verifier reads the keys, never signs."
  }
}

run "ledger_backup_is_its_own_locked_boundary" {
  command = apply

  assert {
    condition     = aws_backup_selection.ledger.resources == toset([aws_dynamodb_table.ledger.arn])
    error_message = "The backup plan selects the ledger only (never restored with the app)."
  }
  assert {
    condition     = aws_backup_vault_lock_configuration.ledger.min_retention_days == 35 && aws_backup_vault_lock_configuration.ledger.changeable_for_days == null
    error_message = "Governance-mode vault lock by default, min retention = the plan's."
  }
  assert {
    condition     = toset(one(data.aws_iam_policy_document.vault_access.statement).actions) == toset(["backup:DeleteRecoveryPoint", "backup:UpdateRecoveryPointLifecycle"]) && one(data.aws_iam_policy_document.vault_access.statement).effect == "Deny"
    error_message = "The vault denies early deletion and shortening of recovery points."
  }
  assert {
    condition     = aws_iam_role_policy_attachment.backup.policy_arn == "arn:aws:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForBackup"
    error_message = "The backup role backs up; it has no restore policy (restore + adoption is L6-4's)."
  }
}

run "compliance_lock_needs_a_cooling_off_window" {
  command = plan
  variables {
    backup = { vault_lock_mode = "compliance" }
  }
  expect_failures = [var.backup]
}

run "no_keys_when_disabled" {
  command = apply
  # A fresh state: in the shared one the keys already exist, and prevent_destroy refuses to remove them (as it must).
  state_key = "no-keys"
  variables {
    signing_keys_enabled = false
  }
  assert {
    condition     = length(aws_kms_key.signing) == 0
    error_message = "signing_keys_enabled = false creates no key."
  }
}
