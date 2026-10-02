output "instance_id" {
  value = module.host.instance_id
}

output "public_ip" {
  description = "The origin hostname's A record must name this (owner DNS action, migration step G)."
  value       = module.host.public_ip
}

output "origin_hostname" {
  value = module.host.origin_hostname
}

output "app_role_arn" {
  description = "Add to stacks/ledger `app_runtime_role_arns` (ledger account apply) BEFORE the first deploy."
  value       = module.host.app_role_arn
}

output "log_group" {
  value = module.host.log_group
}

output "image_repository" {
  value = module.host.image_repository
}

output "architecture" {
  value = module.host.architecture
}

output "runtime_parameter_arn" {
  value = module.host.runtime_parameter_arn
}

output "alarm_names" {
  value = module.host.alarm_names
}
