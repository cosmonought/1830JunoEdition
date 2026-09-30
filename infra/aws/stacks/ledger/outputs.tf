output "ledger_table_arn" {
  value = module.ledger.ledger_table_arn
}

output "signing_key_arns" {
  value = module.ledger.signing_key_arns
}

output "kms_region" {
  value = module.ledger.kms_region
}

output "backup_vault_arn" {
  value = module.ledger.backup_vault_arn
}

output "granted_principals" {
  value = module.ledger.granted_principals
}
