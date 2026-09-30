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
  description = "Key ARNs (never aliases) for the Juno configuration: relayer.signer, settlement_key.signer, admission_key.signer."
  value       = { for purpose, key in aws_kms_key.signing : purpose => key.arn }
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
