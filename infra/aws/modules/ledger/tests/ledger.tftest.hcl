# LIVE-5 L5-8: the ledger module against L5-7 §14 -- over a MOCKED provider (no AWS account, no credentials).
# Run: cd infra/aws/modules/ledger && terraform init -backend=false && terraform test   (Terraform >= 1.10: test state keys)

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
      OperatorJournalQuery        = toset(["dynamodb:Query"])
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

/* ------------------------------------------------------------------ */
/* LIVE-6 relayer rotation: `relayer_key_count` (append-only)           */
/* ------------------------------------------------------------------ */
# One state ("rotation") carried through the runs below, as a real ledger stack's state is across applies. The mocked
# provider gives every CREATED key a fresh random ARN, so an ARN equal to the earlier run's proves the key was neither
# replaced nor recreated (`run.<name>.<output>` is that run's output).

run "rotation_baseline_one_relayer_key" {
  command   = apply
  state_key = "rotation"

  assert {
    condition     = toset(keys(aws_kms_key.signing)) == toset(["relayer", "settlement", "admission"]) && join(",", keys(output.relayer_key_arns)) == "r1" && output.relayer_key_arns.r1 == output.signing_key_arns.relayer
    error_message = "The ordinary deployment: exactly the three L5-8 keys; the one relayer key is r1, at signing_key_arns.relayer."
  }
  assert {
    condition     = aws_kms_key.signing["relayer"].tags == tomap(merge(local.tags, { Name = "gs-staging-relayer", "gs:signing-purpose" = "relayer" })) && aws_kms_key.signing["relayer"].description == "18Cosmos staging relayer signing key (secp256k1, digest only; named by key ARN, never an alias)"
    error_message = "The original relayer key keeps its L5-8 name, description and tags exactly (no rotation tag)."
  }
  assert {
    condition     = length([for s in data.aws_iam_policy_document.ledger_resource.statement : s if s.sid == "BootstrapRelayerFenceRead"]) == 0
    error_message = "One relayer key: the ledger's resource policy is L5-8/L6-2's, unchanged (no rotation read)."
  }
  assert {
    condition     = length(distinct([output.signing_key_arns.relayer, output.signing_key_arns.settlement, output.signing_key_arns.admission])) == 3
    error_message = "The mocked provider gives each created key its own ARN (the replacement checks below rely on it)."
  }
}

run "prepared_rotation_adds_exactly_one_relayer_key" {
  command   = apply
  state_key = "rotation"
  variables {
    relayer_key_count = 2
  }

  assert {
    condition     = toset(keys(aws_kms_key.signing)) == toset(["relayer", "settlement", "admission", "relayer-r2"])
    error_message = "Preparing a rotation adds ONE key, relayer-r2, beside the three."
  }
  assert {
    condition     = output.signing_key_arns == run.rotation_baseline_one_relayer_key.signing_key_arns
    error_message = "The current relayer key and the settlement and admission keys are untouched: the same ARNs (not replaced, not recreated)."
  }
  assert {
    condition     = join(",", keys(output.relayer_key_arns)) == "r1,r2" && output.relayer_key_arns.r1 == run.rotation_baseline_one_relayer_key.relayer_key_arns.r1 && !contains(values(output.signing_key_arns), output.relayer_key_arns.r2)
    error_message = "relayer_key_arns: r1 the original key (unchanged), r2 a new, distinct key."
  }
  assert {
    condition = (aws_kms_key.signing["relayer-r2"].customer_master_key_spec == "ECC_SECG_P256K1" && aws_kms_key.signing["relayer-r2"].key_usage == "SIGN_VERIFY"
      && !aws_kms_key.signing["relayer-r2"].multi_region && !aws_kms_key.signing["relayer-r2"].enable_key_rotation && aws_kms_key.signing["relayer-r2"].is_enabled
    && aws_kms_key.signing["relayer-r2"].deletion_window_in_days == 30)
    error_message = "The new relayer key is the same secp256k1 SIGN_VERIFY key, single-region, 30-day deletion window."
  }
  assert {
    condition     = data.aws_iam_policy_document.signing["relayer-r2"].statement == data.aws_iam_policy_document.signing["relayer"].statement
    error_message = "The new key's policy is the relayer key's, statement for statement: the task role's GetPublicKey and digest-only Sign, the bootstrap role's Describe/GetPublicKey/ListGrants, no CreateGrant."
  }
  assert {
    condition     = aws_kms_key.signing["relayer-r2"].tags == tomap(merge(local.tags, { Name = "gs-staging-relayer-r2", "gs:signing-purpose" = "relayer", "gs:relayer-key" = "r2" }))
    error_message = "The rotation key is tagged purpose relayer, label r2."
  }
  assert {
    condition = alltrue([for k in ["relayer", "settlement", "admission"] :
    aws_kms_key.signing[k].tags == tomap(merge(local.tags, { Name = "gs-staging-${k}", "gs:signing-purpose" = k })) && aws_kms_key.signing[k].description == "18Cosmos staging ${k} signing key (secp256k1, digest only; named by key ARN, never an alias)"])
    error_message = "The three L5-8 keys' descriptions and tags are unchanged (no in-place update either)."
  }
  assert {
    condition = (toset(one([for s in data.aws_iam_policy_document.ledger_resource.statement : s if s.sid == "BootstrapRelayerFenceRead"]).actions) == toset(["dynamodb:GetItem"])
      && toset([for c in one([for s in data.aws_iam_policy_document.ledger_resource.statement : s if s.sid == "BootstrapRelayerFenceRead"]).condition : "${c.test}|${c.variable}|${join(",", c.values)}"]) == toset([
        "ArnEquals|aws:PrincipalArn|arn:aws:iam::111111111111:role/gs-staging-bootstrap",
        "ForAllValues:StringLike|dynamodb:LeadingKeys|FENCE#relayer#*",
    ]))
    error_message = "With a rotation the bootstrap / verifier role may READ the relayer fences (GetItem, FENCE#relayer#* only) for the post-rotation proof -- nothing else changes in the ledger policy."
  }
  assert {
    condition = { for s in data.aws_iam_policy_document.ledger_resource.statement : s.sid => toset(s.actions) if s.sid != "BootstrapRelayerFenceRead" } == {
      AppTaskLedgerRead           = toset(["dynamodb:GetItem", "dynamodb:Query", "dynamodb:ConditionCheckItem"])
      AppTaskLedgerPutNeverAppgen = toset(["dynamodb:PutItem"])
      BootstrapAppgenOnly         = toset(["dynamodb:GetItem", "dynamodb:PutItem"])
      BootstrapAppgenHistoryRead  = toset(["dynamodb:GetItem"])
      OperatorLedgerReadOnly      = toset(["dynamodb:GetItem", "dynamodb:Scan"])
      OperatorJournalQuery        = toset(["dynamodb:Query"])
      RecoveryLedgerRead          = toset(["dynamodb:GetItem", "dynamodb:Query", "dynamodb:Scan"])
      RecoveryAppgenAdoption      = toset(["dynamodb:UpdateItem"])
      RecoveryAppgenHistoryAppend = toset(["dynamodb:PutItem"])
      BootstrapDescribe           = toset(["dynamodb:DescribeTable"])
    }
    error_message = "Every other ledger grant is unchanged by a rotation."
  }
}

run "a_later_rotation_adds_r3_and_keeps_r1_r2" {
  command   = apply
  state_key = "rotation"
  variables {
    relayer_key_count = 3
  }

  assert {
    condition     = toset(keys(aws_kms_key.signing)) == toset(["relayer", "settlement", "admission", "relayer-r2", "relayer-r3"]) && join(",", keys(output.relayer_key_arns)) == "r1,r2,r3"
    error_message = "The next rotation is one more count: r3 beside r1 and r2 (no schema change per rotation)."
  }
  assert {
    condition     = output.signing_key_arns == run.rotation_baseline_one_relayer_key.signing_key_arns && output.relayer_key_arns.r2 == run.prepared_rotation_adds_exactly_one_relayer_key.relayer_key_arns.r2
    error_message = "r1, r2, settlement and admission keep their keys (same ARNs)."
  }
}

# Removing a relayer key is refused. An OLDER key cannot be named for removal at all (the count is append-only: r1 is
# structural, the labels are contiguous). Lowering the count would destroy the NEWEST key: `prevent_destroy` refuses that
# plan ("Instance cannot be destroyed"), which `terraform test` cannot express as an expected failure -- the report records
# that plan's refusal, run by hand against this same state.
run "the_original_relayer_key_can_never_be_dropped" {
  command = plan
  variables {
    relayer_key_count = 0
  }
  expect_failures = [var.relayer_key_count]
}

run "a_relayer_key_count_is_a_whole_number" {
  command = plan
  variables {
    relayer_key_count = 1.5
  }
  expect_failures = [var.relayer_key_count]
}

run "a_rotation_needs_the_signing_keys" {
  command   = plan
  state_key = "no-keys-rotation"
  variables {
    signing_keys_enabled = false
    relayer_key_count    = 2
  }
  expect_failures = [var.relayer_key_count]
}

# ---------------------------------------------------------------- COST-1: the single host's app role

run "cost1_default_authorises_only_the_ecs_task_role" {
  command = plan
  assert {
    condition     = jsonencode(local.app_runtime_role_arns) == jsonencode(["arn:aws:iam::111111111111:role/gs-staging-app-task"])
    error_message = "the defaults keep every ledger / key policy exactly as before (the ECS task role only)"
  }
}

run "cost1_host_role_beside_the_task_role" {
  command = plan
  variables {
    app_runtime_role_arns = ["arn:aws:iam::111111111111:role/gs-staging-host-app"]
  }
  assert {
    condition     = jsonencode(local.app_runtime_role_arns) == jsonencode(["arn:aws:iam::111111111111:role/gs-staging-app-task", "arn:aws:iam::111111111111:role/gs-staging-host-app"])
    error_message = "the host role gets the task role's grants, beside it (the migration window)"
  }
}

run "cost1_host_role_instead_of_the_task_role" {
  command = plan
  variables {
    app_runtime_role_arns    = ["arn:aws:iam::111111111111:role/gs-staging-host-app"]
    ecs_task_role_authorized = false
  }
  assert {
    condition     = jsonencode(local.app_runtime_role_arns) == jsonencode(["arn:aws:iam::111111111111:role/gs-staging-host-app"])
    error_message = "after the ECS services are gone, only the host role"
  }
}

run "cost1_never_an_operator_or_foreign_role" {
  command = plan
  variables {
    app_runtime_role_arns = ["arn:aws:iam::111111111111:role/gs-staging-recovery"]
  }
  expect_failures = [var.app_runtime_role_arns]
}

run "cost1_never_another_account" {
  command = plan
  variables {
    app_runtime_role_arns = ["arn:aws:iam::333333333333:role/gs-staging-host-app"]
  }
  expect_failures = [var.app_runtime_role_arns]
}

run "cost1_some_app_role_always_remains" {
  command = plan
  variables {
    ecs_task_role_authorized = false
  }
  expect_failures = [var.ecs_task_role_authorized]
}

run "cost1_never_any_other_app_role" {
  command = plan
  variables {
    app_runtime_role_arns = ["arn:aws:iam::111111111111:role/gs-staging-deploy"]
  }
  expect_failures = [var.app_runtime_role_arns]
}

/* ------------------------------------------------------------------ */
/* JX-1K financial key sets: `financial_key_sets` (append-only)          */
/* ------------------------------------------------------------------ */
# One state ("financial") carried through the runs below, as with the rotation: an ARN equal to the earlier run's proves the
# key was neither replaced nor recreated.

run "financial_baseline_is_the_three_keys" {
  command   = apply
  state_key = "financial"

  assert {
    condition     = toset(keys(aws_kms_key.signing)) == toset(["relayer", "settlement", "admission"]) && length(output.financial_key_arns) == 0
    error_message = "Default []: exactly the three L5-8 keys, no financial key set (financial_key_arns = {})."
  }
  assert {
    condition     = toset(keys(output.signing_key_arns)) == toset(["relayer", "settlement", "admission"]) && join(",", keys(output.relayer_key_arns)) == "r1"
    error_message = "Default []: signing_key_arns and relayer_key_arns are the L5-8 / LIVE-6 outputs."
  }
  assert {
    condition = alltrue([for k in ["relayer", "settlement", "admission"] :
    aws_kms_key.signing[k].tags == tomap(merge(local.tags, { Name = "gs-staging-${k}", "gs:signing-purpose" = k })) && aws_kms_key.signing[k].description == "18Cosmos staging ${k} signing key (secp256k1, digest only; named by key ARN, never an alias)"])
    error_message = "Default []: the three keys' names, descriptions and tags are exactly L5-8's (no gs:key-set tag)."
  }
}

run "a_financial_key_set_adds_exactly_settlement_and_admission" {
  command   = apply
  state_key = "financial"
  variables {
    financial_key_sets = ["jx1"]
  }

  assert {
    condition     = toset(keys(aws_kms_key.signing)) == toset(["relayer", "settlement", "admission", "settlement-jx1", "admission-jx1"])
    error_message = "The jx1 set adds exactly settlement-jx1 and admission-jx1 -- no relayer key."
  }
  assert {
    condition     = output.signing_key_arns == run.financial_baseline_is_the_three_keys.signing_key_arns && output.relayer_key_arns == run.financial_baseline_is_the_three_keys.relayer_key_arns
    error_message = "The original relayer, settlement and admission keys are untouched (same ARNs: not replaced, not recreated); signing_key_arns stays the original three."
  }
  assert {
    condition     = join(",", keys(output.financial_key_arns)) == "jx1" && join(",", keys(output.financial_key_arns["jx1"])) == "admission,settlement"
    error_message = "financial_key_arns = { jx1 = { settlement, admission } }."
  }
  assert {
    condition = (output.financial_key_arns["jx1"].settlement == aws_kms_key.signing["settlement-jx1"].arn && output.financial_key_arns["jx1"].admission == aws_kms_key.signing["admission-jx1"].arn
    && length(distinct(concat(values(output.signing_key_arns), [output.financial_key_arns["jx1"].settlement, output.financial_key_arns["jx1"].admission]))) == 5)
    error_message = "financial_key_arns.jx1 names the two new keys, distinct from each other and from the original three."
  }
  assert {
    condition = alltrue([for k in ["settlement-jx1", "admission-jx1"] :
      aws_kms_key.signing[k].customer_master_key_spec == "ECC_SECG_P256K1" && aws_kms_key.signing[k].key_usage == "SIGN_VERIFY"
      && !aws_kms_key.signing[k].multi_region && !aws_kms_key.signing[k].enable_key_rotation && aws_kms_key.signing[k].is_enabled
    && aws_kms_key.signing[k].deletion_window_in_days == 30])
    error_message = "The new keys are the same secp256k1 SIGN_VERIFY keys: single-region, no rotation, enabled, 30-day deletion window."
  }
  assert {
    condition     = data.aws_iam_policy_document.signing["settlement-jx1"].statement == data.aws_iam_policy_document.signing["settlement"].statement && data.aws_iam_policy_document.signing["admission-jx1"].statement == data.aws_iam_policy_document.signing["admission"].statement
    error_message = "The new keys' policies are the originals', statement for statement: task GetPublicKey + digest-only Sign, bootstrap read, no CreateGrant."
  }
  assert {
    condition     = aws_kms_key.signing["settlement-jx1"].policy == data.aws_iam_policy_document.signing["settlement-jx1"].json && aws_kms_key.signing["admission-jx1"].policy == data.aws_iam_policy_document.signing["admission-jx1"].json
    error_message = "Each new key carries its policy document."
  }
  assert {
    condition = (aws_kms_key.signing["settlement-jx1"].tags == tomap(merge(local.tags, { Name = "gs-staging-settlement-jx1", "gs:signing-purpose" = "settlement", "gs:key-set" = "jx1" }))
    && aws_kms_key.signing["admission-jx1"].tags == tomap(merge(local.tags, { Name = "gs-staging-admission-jx1", "gs:signing-purpose" = "admission", "gs:key-set" = "jx1" })))
    error_message = "Tagged by purpose (settlement / admission) and key set (jx1); no gs:relayer-key."
  }
  assert {
    condition     = aws_kms_key.signing["settlement-jx1"].description == "18Cosmos staging settlement-jx1 signing key (secp256k1, digest only; named by key ARN, never an alias)"
    error_message = "The new key's description names it."
  }
  assert {
    condition = alltrue([for k in ["relayer", "settlement", "admission"] :
    aws_kms_key.signing[k].tags == tomap(merge(local.tags, { Name = "gs-staging-${k}", "gs:signing-purpose" = k })) && aws_kms_key.signing[k].description == "18Cosmos staging ${k} signing key (secp256k1, digest only; named by key ARN, never an alias)"])
    error_message = "The three L5-8 keys' descriptions and tags are unchanged (no in-place update either)."
  }
  assert {
    condition     = length([for s in data.aws_iam_policy_document.ledger_resource.statement : s if s.sid == "BootstrapRelayerFenceRead"]) == 0
    error_message = "A financial key set changes nothing in the ledger table's resource policy (it is not a relayer rotation)."
  }
}

run "a_second_financial_key_set_keeps_the_first" {
  command   = apply
  state_key = "financial"
  variables {
    financial_key_sets = ["jx1", "jx2"]
  }

  assert {
    condition     = toset(keys(aws_kms_key.signing)) == toset(["relayer", "settlement", "admission", "settlement-jx1", "admission-jx1", "settlement-jx2", "admission-jx2"])
    error_message = "Appending jx2 adds exactly its pair."
  }
  assert {
    condition     = output.financial_key_arns["jx1"] == run.a_financial_key_set_adds_exactly_settlement_and_admission.financial_key_arns["jx1"] && output.signing_key_arns == run.financial_baseline_is_the_three_keys.signing_key_arns
    error_message = "jx1's keys and the original three keep their ARNs."
  }
}

run "financial_keys_beside_a_rotation" {
  command   = apply
  state_key = "rotation"
  variables {
    relayer_key_count  = 3
    financial_key_sets = ["jx1"]
  }

  assert {
    condition     = toset(keys(aws_kms_key.signing)) == toset(["relayer", "settlement", "admission", "relayer-r2", "relayer-r3", "settlement-jx1", "admission-jx1"])
    error_message = "Beside a rotation, a financial key set adds only its own pair."
  }
  assert {
    condition = (output.signing_key_arns == run.rotation_baseline_one_relayer_key.signing_key_arns
      && output.relayer_key_arns == run.a_later_rotation_adds_r3_and_keeps_r1_r2.relayer_key_arns && join(",", keys(output.relayer_key_arns)) == "r1,r2,r3"
    && join(",", keys(output.financial_key_arns)) == "jx1")
    error_message = "r1..r3 and the original three are untouched (same ARNs); relayer_key_arns never lists a financial key."
  }
  assert {
    condition     = aws_kms_key.signing["relayer-r2"].tags == tomap(merge(local.tags, { Name = "gs-staging-relayer-r2", "gs:signing-purpose" = "relayer", "gs:relayer-key" = "r2" }))
    error_message = "A rotation key's tags are unchanged by a financial key set."
  }
}

run "a_financial_label_is_never_a_relayer_label" {
  command = plan
  variables {
    financial_key_sets = ["r2"]
  }
  expect_failures = [var.financial_key_sets]
}

run "a_financial_label_has_no_hyphen" {
  command = plan
  variables {
    financial_key_sets = ["jx-1"]
  }
  expect_failures = [var.financial_key_sets]
}

run "a_financial_label_is_lowercase" {
  command = plan
  variables {
    financial_key_sets = ["JX1"]
  }
  expect_failures = [var.financial_key_sets]
}

run "a_financial_label_starts_with_a_letter" {
  command = plan
  variables {
    financial_key_sets = ["1jx"]
  }
  expect_failures = [var.financial_key_sets]
}

run "a_financial_label_is_bounded" {
  command = plan
  variables {
    financial_key_sets = ["jabcdefghijklmnop"] # 17 characters
  }
  expect_failures = [var.financial_key_sets]
}

run "a_financial_label_is_named_once" {
  command = plan
  variables {
    financial_key_sets = ["jx1", "jx1"]
  }
  expect_failures = [var.financial_key_sets]
}

run "a_financial_key_set_needs_the_signing_keys" {
  command   = plan
  state_key = "no-keys-financial"
  variables {
    signing_keys_enabled = false
    financial_key_sets   = ["jx1"]
  }
  expect_failures = [var.financial_key_sets]
}

/* ------------------------------------------------------------------ */
/* P5-INT-1: COST-1's app runtime roles x JX-1K's financial key sets   */
/* ------------------------------------------------------------------ */
# The "financial" state continues (jx1 + jx2 applied above): authorising the single host's app role changes only the key
# policies -- every key keeps its ARN (none replaced) -- and every financial key carries exactly the original keys' grants
# to exactly the configured runtime roles, the digest-only Sign conditions intact. (The mocked policy document renders a
# constant JSON, so these runs pin the policy STATEMENTS and the ARNs; the in-place update is the provider's semantics.)

run "p5int_financial_keys_authorise_the_host_role_beside_the_task_role" {
  command   = apply
  state_key = "financial"
  variables {
    financial_key_sets    = ["jx1", "jx2"]
    app_runtime_role_arns = ["arn:aws:iam::111111111111:role/gs-staging-host-app"]
  }

  assert {
    condition = (output.signing_key_arns == run.financial_baseline_is_the_three_keys.signing_key_arns
    && output.financial_key_arns == run.a_second_financial_key_set_keeps_the_first.financial_key_arns)
    error_message = "Authorising the host role replaces no key: the original three and both financial pairs keep their ARNs."
  }
  assert {
    condition = alltrue([for k in ["settlement-jx1", "admission-jx1", "settlement-jx2", "admission-jx2"] :
      length([for s in data.aws_iam_policy_document.signing[k].statement : s if contains(["AppTaskPublicKey", "AppTaskSignDigestOnly"], s.sid)
        && toset(flatten([for c in s.condition : c.values if c.variable == "aws:PrincipalArn"])) == toset(["arn:aws:iam::111111111111:role/gs-staging-app-task", "arn:aws:iam::111111111111:role/gs-staging-host-app"])
    && toset(flatten([for p in s.principals : p.identifiers])) == toset(["arn:aws:iam::111111111111:root"])]) == 2])
    error_message = "Every financial key's GetPublicKey and Sign statements name exactly the ECS task role and the host role (the migration window), from the app account only."
  }
  assert {
    condition = alltrue([for k in ["settlement-jx1", "admission-jx1", "settlement-jx2", "admission-jx2"] :
      length([for s in data.aws_iam_policy_document.signing[k].statement : s if s.sid == "AppTaskSignDigestOnly"
        && toset([for c in s.condition : "${c.variable}=${join(",", c.values)}" if c.variable != "aws:PrincipalArn"]) == toset(["kms:SigningAlgorithm=ECDSA_SHA_256", "kms:MessageType=DIGEST"])
    && toset(s.actions) == toset(["kms:Sign"])]) == 1])
    error_message = "The host role's Sign on a financial key stays ECDSA_SHA_256 over a DIGEST only (no restriction weakened)."
  }
  assert {
    condition     = alltrue([for k in ["settlement-jx1", "admission-jx1", "settlement-jx2", "admission-jx2"] : data.aws_iam_policy_document.signing[k].statement == data.aws_iam_policy_document.signing[startswith(k, "settlement-") ? "settlement" : "admission"].statement])
    error_message = "A financial key's policy stays the original key's, statement for statement, with the host role authorised."
  }
}

run "p5int_financial_keys_host_role_only_after_ecs" {
  command   = apply
  state_key = "financial"
  variables {
    financial_key_sets       = ["jx1", "jx2"]
    app_runtime_role_arns    = ["arn:aws:iam::111111111111:role/gs-staging-host-app"]
    ecs_task_role_authorized = false
  }

  assert {
    condition = (output.signing_key_arns == run.financial_baseline_is_the_three_keys.signing_key_arns
    && output.financial_key_arns == run.a_second_financial_key_set_keeps_the_first.financial_key_arns)
    error_message = "Retiring the ECS task role's grants replaces no key."
  }
  assert {
    condition = alltrue([for k in ["relayer", "settlement", "admission", "settlement-jx1", "admission-jx1", "settlement-jx2", "admission-jx2"] :
      length([for s in data.aws_iam_policy_document.signing[k].statement : s if contains(["AppTaskPublicKey", "AppTaskSignDigestOnly"], s.sid)
    && toset(flatten([for c in s.condition : c.values if c.variable == "aws:PrincipalArn"])) == toset(["arn:aws:iam::111111111111:role/gs-staging-host-app"])]) == 2])
    error_message = "After the ECS services are gone, every key -- original and financial -- grants GetPublicKey / Sign to the host role only."
  }
}

/* ------------------------------------------------------------------ */
/* JX-4C: the operator's journal Query -- the ledger's half              */
/* ------------------------------------------------------------------ */

run "jx4c_operator_journal_query_is_atti_only_for_the_exact_operator" {
  command = plan

  assert {
    condition = (toset(one([for s in data.aws_iam_policy_document.ledger_resource.statement : s if s.sid == "OperatorJournalQuery"]).actions) == toset(["dynamodb:Query"])
      && toset([for c in one([for s in data.aws_iam_policy_document.ledger_resource.statement : s if s.sid == "OperatorJournalQuery"]).condition : "${c.test}|${c.variable}|${join(",", c.values)}"]) == toset([
        "ArnEquals|aws:PrincipalArn|arn:aws:iam::111111111111:role/gs-staging-operator",
        "ForAllValues:StringLike|dynamodb:LeadingKeys|ATTI#*",
        "Null|dynamodb:LeadingKeys|false",
      ])
    && toset(flatten([for p in one([for s in data.aws_iam_policy_document.ledger_resource.statement : s if s.sid == "OperatorJournalQuery"]).principals : p.identifiers])) == toset(["arn:aws:iam::111111111111:root"]))
    error_message = "JX-4C: the ledger lets exactly gs-<env>-operator (account root + aws:PrincipalArn) Query ATTI#<intent> partitions -- nothing else."
  }
  assert {
    condition     = toset(flatten([for s in data.aws_iam_policy_document.ledger_resource.statement : s.actions if anytrue([for c in s.condition : contains(c.values, "arn:aws:iam::111111111111:role/gs-staging-operator") if c.variable == "aws:PrincipalArn"])])) == toset(["dynamodb:GetItem", "dynamodb:Scan", "dynamodb:Query"])
    error_message = "JX-4C: everything the ledger grants the operator is a read (GetItem and Scan unchanged, Query new) -- no write, no APPGEN authority."
  }
  assert {
    condition     = alltrue([for k, d in data.aws_iam_policy_document.signing : alltrue([for s in d.statement : alltrue([for c in s.condition : !contains(c.values, "arn:aws:iam::111111111111:role/gs-staging-operator")])])])
    error_message = "JX-4C: no signing key names the operator (no Sign, no GetPublicKey)."
  }
}

/* ------------------------------------------------------------------ */
/* PHASE 3 ESCROW 2.1: the DEDICATED REMEDY keys (`remedy_key_count`)  */
/* ------------------------------------------------------------------ */
# Owner decision 2026-10-08: the escrow 2.1.0 REMEDY attestation authority is its OWN signing purpose -- never the relayer,
# settlement or admission key. One state ("remedy") carried through: an ARN equal to an earlier run's proves the key was
# neither replaced nor recreated.

run "remedy_baseline_no_remedy_key" {
  command   = apply
  state_key = "remedy"

  assert {
    condition     = toset(keys(aws_kms_key.signing)) == toset(["relayer", "settlement", "admission"]) && length(output.remedy_key_arns) == 0
    error_message = "Default remedy_key_count = 0: exactly the three L5-8 keys and no remedy key (remedy_key_arns = {}): every existing plan is unchanged."
  }
}

run "a_remedy_key_is_its_own_purpose" {
  command   = apply
  state_key = "remedy"
  variables {
    remedy_key_count = 1
  }

  assert {
    condition     = toset(keys(aws_kms_key.signing)) == toset(["relayer", "settlement", "admission", "remedy-r1"])
    error_message = "remedy_key_count = 1 adds exactly remedy-r1 -- no relayer, settlement or admission key."
  }
  assert {
    condition     = output.signing_key_arns == run.remedy_baseline_no_remedy_key.signing_key_arns && output.relayer_key_arns == run.remedy_baseline_no_remedy_key.relayer_key_arns && length(output.financial_key_arns) == 0
    error_message = "The original relayer, settlement and admission keys are untouched (same ARNs); signing_key_arns stays exactly the original three."
  }
  assert {
    condition     = join(",", keys(output.remedy_key_arns)) == "r1" && output.remedy_key_arns["r1"] == aws_kms_key.signing["remedy-r1"].arn && !contains(values(output.signing_key_arns), output.remedy_key_arns["r1"])
    error_message = "remedy_key_arns = { r1 = <the remedy key> }, never one of the signing_key_arns."
  }
  assert {
    condition = (aws_kms_key.signing["remedy-r1"].customer_master_key_spec == "ECC_SECG_P256K1" && aws_kms_key.signing["remedy-r1"].key_usage == "SIGN_VERIFY"
      && !aws_kms_key.signing["remedy-r1"].multi_region && !aws_kms_key.signing["remedy-r1"].enable_key_rotation && aws_kms_key.signing["remedy-r1"].is_enabled
    && aws_kms_key.signing["remedy-r1"].deletion_window_in_days == 30)
    error_message = "The remedy key is a secp256k1 SIGN_VERIFY key: single-region, no rotation, enabled, 30-day deletion window."
  }
  assert {
    condition     = aws_kms_key.signing["remedy-r1"].tags == tomap(merge(local.tags, { Name = "gs-staging-remedy-r1", "gs:signing-purpose" = "remedy", "gs:remedy-key" = "r1" }))
    error_message = "Tagged by its OWN purpose (remedy) and label (r1); never a relayer, settlement or admission tag, no key set."
  }
  assert {
    condition     = aws_kms_key.signing["remedy-r1"].policy == data.aws_iam_policy_document.signing["remedy-r1"].json && aws_kms_key.signing["remedy-r1"].description == "18Cosmos staging remedy-r1 signing key (secp256k1, digest only; named by key ARN, never an alias)"
    error_message = "The remedy key carries its own policy document and names itself."
  }
  assert {
    condition = (toset([for s in data.aws_iam_policy_document.signing["remedy-r1"].statement : s.sid]) == toset(["KeyAdministrationWithoutSigning", "AppTaskPublicKey", "AppTaskSignDigestOnly", "BootstrapVerifyReadOnly"])
      && toset(one([for s in data.aws_iam_policy_document.signing["remedy-r1"].statement : s if s.sid == "AppTaskSignDigestOnly"]).actions) == toset(["kms:Sign"])
      && toset([for c in one([for s in data.aws_iam_policy_document.signing["remedy-r1"].statement : s if s.sid == "AppTaskSignDigestOnly"]).condition : "${c.test}|${c.variable}|${join(",", c.values)}"]) == toset([
        "ArnEquals|aws:PrincipalArn|arn:aws:iam::111111111111:role/gs-staging-app-task", "StringEquals|kms:SigningAlgorithm|ECDSA_SHA_256", "StringEquals|kms:MessageType|DIGEST",
      ])
      && toset(one([for s in data.aws_iam_policy_document.signing["remedy-r1"].statement : s if s.sid == "BootstrapVerifyReadOnly"]).actions) == toset(["kms:DescribeKey", "kms:GetPublicKey", "kms:ListGrants"])
    && !contains(one([for s in data.aws_iam_policy_document.signing["remedy-r1"].statement : s if s.sid == "KeyAdministrationWithoutSigning"]).actions, "kms:Sign"))
    error_message = "Least privilege: only the app task role signs with the remedy key (ECDSA_SHA_256 over a DIGEST), the bootstrap role only reads, the account administers but never signs."
  }
  assert {
    condition     = alltrue(flatten([for s in data.aws_iam_policy_document.signing["remedy-r1"].statement : [for a in s.actions : a != "kms:CreateGrant" && a != "kms:*"]]))
    error_message = "Nobody may CreateGrant on the remedy key (a grant would hand out Sign without appearing in the policy), and no kms:*."
  }
  assert {
    condition     = data.aws_iam_policy_document.signing["remedy-r1"].statement == data.aws_iam_policy_document.signing["settlement"].statement
    error_message = "The remedy key's policy is exactly the established signing-key policy (no grant broader than the existing keys')."
  }
  assert {
    condition = alltrue([for k in ["relayer", "settlement", "admission"] :
    aws_kms_key.signing[k].tags == tomap(merge(local.tags, { Name = "gs-staging-${k}", "gs:signing-purpose" = k })) && aws_kms_key.signing[k].description == "18Cosmos staging ${k} signing key (secp256k1, digest only; named by key ARN, never an alias)"])
    error_message = "The three L5-8 keys' descriptions and tags are unchanged."
  }
  assert {
    condition     = length([for s in data.aws_iam_policy_document.ledger_resource.statement : s if s.sid == "BootstrapRelayerFenceRead"]) == 0
    error_message = "A remedy key changes nothing in the ledger table's resource policy."
  }
}

run "a_prepared_remedy_rotation_adds_r2_and_keeps_r1" {
  command   = apply
  state_key = "remedy"
  variables {
    remedy_key_count = 2
  }

  assert {
    condition     = toset(keys(aws_kms_key.signing)) == toset(["relayer", "settlement", "admission", "remedy-r1", "remedy-r2"]) && join(",", keys(output.remedy_key_arns)) == "r1,r2"
    error_message = "remedy_key_count = 2 prepares remedy-r2 beside remedy-r1."
  }
  assert {
    condition     = output.remedy_key_arns["r1"] == run.a_remedy_key_is_its_own_purpose.remedy_key_arns["r1"] && output.signing_key_arns == run.remedy_baseline_no_remedy_key.signing_key_arns
    error_message = "The current remedy key and the original three are untouched (same ARNs)."
  }
  assert {
    condition     = aws_kms_key.signing["remedy-r2"].tags == tomap(merge(local.tags, { Name = "gs-staging-remedy-r2", "gs:signing-purpose" = "remedy", "gs:remedy-key" = "r2" })) && data.aws_iam_policy_document.signing["remedy-r2"].statement == data.aws_iam_policy_document.signing["remedy-r1"].statement
    error_message = "The prepared key has the same spec and policy as r1, its own label."
  }
}

run "the_remedy_key_can_never_be_dropped_by_the_count" {
  command   = plan
  state_key = "remedy"
  variables {
    remedy_key_count = -1
  }
  expect_failures = [var.remedy_key_count]
}

run "a_remedy_key_count_is_a_whole_bounded_number" {
  command = plan
  variables {
    remedy_key_count = 17
  }
  expect_failures = [var.remedy_key_count]
}

run "a_remedy_key_needs_the_signing_keys" {
  command = plan
  variables {
    signing_keys_enabled = false
    remedy_key_count     = 1
  }
  expect_failures = [var.remedy_key_count]
}

run "a_remedy_key_beside_a_financial_set_and_a_rotation" {
  command = plan
  variables {
    relayer_key_count  = 2
    financial_key_sets = ["jx1"]
    remedy_key_count   = 1
  }

  assert {
    condition     = toset(keys(aws_kms_key.signing)) == toset(["relayer", "relayer-r2", "settlement", "admission", "settlement-jx1", "admission-jx1", "remedy-r1"])
    error_message = "The purposes compose without collision: a rotation, a financial set and the remedy key each add only their own keys."
  }
  assert {
    condition     = aws_kms_key.signing["remedy-r1"].tags["gs:signing-purpose"] == "remedy" && !contains(keys(aws_kms_key.signing["remedy-r1"].tags), "gs:key-set") && !contains(keys(aws_kms_key.signing["remedy-r1"].tags), "gs:relayer-key")
    error_message = "The remedy key is never tagged as a relayer key or a financial key set."
  }
}

run "a_remedy_key_authorises_the_host_role_like_every_signing_key" {
  command = plan
  variables {
    remedy_key_count         = 1
    app_runtime_role_arns    = ["arn:aws:iam::111111111111:role/gs-staging-host-app"]
    ecs_task_role_authorized = false
  }

  assert {
    condition = length([for s in data.aws_iam_policy_document.signing["remedy-r1"].statement : s if contains(["AppTaskPublicKey", "AppTaskSignDigestOnly"], s.sid)
    && toset(flatten([for c in s.condition : c.values if c.variable == "aws:PrincipalArn"])) == toset(["arn:aws:iam::111111111111:role/gs-staging-host-app"])]) == 2
    error_message = "On the single host, exactly the host's app role may GetPublicKey / Sign with the remedy key -- the same runtime roles as every signing key, nobody else."
  }
}
