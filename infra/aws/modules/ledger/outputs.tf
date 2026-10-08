# What the app stack needs (and nothing private: a KMS key's private half never leaves KMS; the public keys and the relayer
# address are read by `npm run awsDeploy -- signer-keys`, which derives them exactly as the server does).

output "ledger_table_arn" {
  description = "The runtime document's ledger_table_arn and the Juno configuration's journal.table_arn (the same value)."
  value       = aws_dynamodb_table.ledger.arn
}

output "ledger_table_name" {
  value = aws_dynamodb_table.ledger.name
}

output "ledger_account_id" {
  value = local.ledger_account
}

output "ledger_region" {
  value = local.region
}

output "signing_key_arns" {
  description = "Key ARNs (never aliases) for the Juno configuration: relayer.signer, settlement_key.signer, admission_key.signer. `relayer` is always the ORIGINAL relayer key (r1); a rotation's keys are in relayer_key_arns. Exactly the ORIGINAL three: a financial key set's keys are in financial_key_arns."
  value       = { for purpose, key in aws_kms_key.signing : purpose => key.arn if contains(["relayer", "settlement", "admission"], purpose) }
}

output "relayer_key_arns" {
  description = <<-EOT
    LIVE-6 relayer rotation: every relayer key by label -- `r1` (the original, = signing_key_arns.relayer) and `r2` ...
    `r<relayer_key_count>`. The app stack names exactly one of them as `signing_keys.relayer` (the configured relayer) and
    lists the others it must still read (the prepared next key, or the previous key kept for rollback) in
    `relayer_rotation_key_arns`. `signing_key_arns.relayer` stays the ORIGINAL key, whatever is configured.
  EOT
  value       = var.signing_keys_enabled ? merge({ r1 = aws_kms_key.signing["relayer"].arn }, { for label in local.relayer_rotation_labels : label => aws_kms_key.signing["relayer-${label}"].arn }) : {}
}

output "financial_key_arns" {
  description = <<-EOT
    JX-1K financial key sets: { <label> = { settlement = <key ARN>, admission = <key ARN> } } for each
    `financial_key_sets` label ({} by default). The app stack names one pair as `signing_keys.settlement` /
    `signing_keys.admission`; `signing_key_arns` stays the ORIGINAL three, whatever is configured.
  EOT
  value       = var.signing_keys_enabled ? { for label in var.financial_key_sets : label => { settlement = aws_kms_key.signing["settlement-${label}"].arn, admission = aws_kms_key.signing["admission-${label}"].arn } } : {}
}

output "remedy_key_arns" {
  description = <<-EOT
    PHASE 3 ESCROW 2.1: the DEDICATED REMEDY keys by label -- { r1 = <key ARN>, ... } for `remedy_key_count` ({} by
    default). The app stack names exactly one as `remedy_signing_key` (with its on-chain `escrow.remedy_key`); the
    single-host stack the same one. Never part of `signing_key_arns` or `financial_key_arns`.
  EOT
  value       = var.signing_keys_enabled ? { for label in local.remedy_key_labels : label => aws_kms_key.signing["remedy-${label}"].arn } : {}
}

output "kms_region" {
  description = "The one KMS region of the Juno configuration (the keys' region)."
  value       = local.region
}

output "backup_vault_arn" {
  value = aws_backup_vault.ledger.arn
}

output "granted_principals" {
  description = "The app-account role ARNs this stack's resource and key policies grant (by aws:PrincipalArn)."
  value       = { app_task = local.task_role_arn, bootstrap = local.bootstrap_arn }
}
