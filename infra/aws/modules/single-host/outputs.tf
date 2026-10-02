output "instance_id" {
  description = "The host (operator scripts address it by id through SSM Run Command)."
  value       = aws_instance.host.id
}

output "public_ip" {
  description = "The Elastic IP: the A record of `origin_hostname` must name it (an owner DNS action at migration)."
  value       = aws_eip.host.public_ip
}

output "origin_hostname" {
  description = "What the existing CloudFront distribution's /gs* origin must name (stacks/app edge.alb_origin_domain_name)."
  value       = var.origin_hostname
}

output "app_role_arn" {
  description = "The host's app role: stacks/ledger `app_runtime_role_arns` must list it (ledger table + KMS key policies)."
  value       = aws_iam_role.host.arn
}

output "log_group" {
  value = aws_cloudwatch_log_group.host.name
}

output "security_group_id" {
  value = aws_security_group.host.id
}

output "runtime_parameter_arn" {
  description = "The runtime document this host's server reads (written by stacks/app for pool `pool`)."
  value       = local.runtime_parameter_arn
}

output "image_repository" {
  description = "Where gs-deploy pulls from (by digest)."
  value       = "${local.ecr_registry}/${local.ecr_repository_name}"
}

output "architecture" {
  description = "The image platform the host needs (linux/<architecture>)."
  value       = local.arch
}

output "alarm_names" {
  value = [aws_cloudwatch_metric_alarm.health.alarm_name, aws_cloudwatch_metric_alarm.critical.alarm_name, aws_cloudwatch_metric_alarm.status_check.alarm_name, aws_cloudwatch_metric_alarm.pressure.alarm_name, aws_cloudwatch_metric_alarm.cpu_credits.alarm_name]
}
