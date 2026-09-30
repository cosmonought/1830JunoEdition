output "game_table_name" {
  description = "The SERVING game table (generation `generation`)."
  value       = aws_dynamodb_table.game[tostring(var.generation)].name
}

output "game_table_names" {
  description = "Every managed game-table generation (L6-2 / L6-4: side by side until one is explicitly retired)."
  value       = { for g, t in aws_dynamodb_table.game : g => t.name }
}

output "identity_table_name" {
  value = aws_dynamodb_table.identity.name
}

output "primary_pool" {
  description = "The pool SYSTEM/ROUTING must name (the bootstrap's, or the last flip's); the /gs* rule forwards to its target group."
  value       = local.primary_pool
}

output "routes" {
  description = "The trusted route table written into every runtime document v2 (pool -> ws_path / bundle_path)."
  value       = local.pool_route
}

output "listener_rule_priorities" {
  description = "Each pool's exact-path rule priority, and the /gs* default's (verifier-checkable)."
  value       = { pools = local.pool_rule_priority, gs = local.gs_rule_priority }
}

output "runtime_parameter_arns" {
  description = "Per pool: GS_AWS_CONFIG_PARAMETER, and the bootstrap's / verifier's --runtime-parameter."
  value       = local.runtime_parameter_arn
}

output "juno_parameter_arn" {
  value = local.escrow_enabled ? local.juno_parameter_arn : null
}

output "role_arns" {
  value = {
    task      = aws_iam_role.task.arn
    execution = aws_iam_role.execution.arn
    bootstrap = aws_iam_role.bootstrap.arn
    operator  = length(aws_iam_role.operator) == 1 ? aws_iam_role.operator[0].arn : null
    recovery  = length(aws_iam_role.recovery) == 1 ? aws_iam_role.recovery[0].arn : null
  }
}

output "ecr_repository_url" {
  description = "Push the image as <url>:<build_id> before starting the services (tags are immutable)."
  value       = aws_ecr_repository.server.repository_url
}

output "cluster_name" {
  value = aws_ecs_cluster.this.name
}

output "service_names" {
  value = { for id, _ in var.pools : id => "${local.prefix}-${id}" }
}

output "task_definition_families" {
  value = { for id, _ in var.pools : id => aws_ecs_task_definition.pool[id].family }
}

output "security_group_ids" {
  value = { alb = aws_security_group.alb.id, task = aws_security_group.task.id }
}

output "alb_dns_name" {
  description = "Point edge.alb_origin_domain_name (a name the ALB certificate covers) at this."
  value       = aws_lb.this.dns_name
}

output "load_balancer_arn" {
  value = aws_lb.this.arn
}

output "target_group_arns" {
  description = "One target group per pool (LIVE-6 L6-2)."
  value       = { for id, tg in aws_lb_target_group.pool : id => tg.arn }
}

output "origin_request_policy_id" {
  description = "Attach to the /gs* behaviour of an existing distribution (with the managed CachingDisabled cache policy)."
  value       = aws_cloudfront_origin_request_policy.gs.id
}

output "caching_disabled_policy_id" {
  value = local.caching_disabled_policy_id
}

output "distribution_id" {
  value = var.edge.create_distribution ? aws_cloudfront_distribution.site[0].id : null
}

# ---------------- LIVE-6 L6-5B: the alarms (identifiers only: no action ARN, no state) ----------------

output "alarm_namespace" {
  description = "The namespace every game-server alarm reads (L6-5A's EMF)."
  value       = local.alarm_namespace
}

output "alarms" {
  description = "Every alarm by contract key (`<id>`, `<pool>/<id>`, `primary/<id>`): its stable name, class, scope, the pool it watches (null: environment), whether it is flip-suppressible and, if so, the composite that carries its actions. For L6-2's flip, L6-6's staging certification and operator verification."
  value = {
    for key, a in local.alarm_instances : key => {
      name         = a.name
      class        = a.class
      scope        = a.scope
      pool         = a.pool
      suppressible = a.suppressible
      notify       = a.suppressible ? "${a.name}-notify" : null
    }
  }
}

output "flip_suppression" {
  description = "The planned-flip suppression seam (L6-2 -> L6-5B): the per-pool suppressor alarms and the metric `gamesDoctor aws flip` publishes into them."
  value = {
    namespace          = local.suppressor.namespace
    metric             = local.suppressor.metric
    statistic          = local.suppressor.statistic
    max_window_minutes = local.suppressor.max_window_minutes
    suppressors        = local.suppressor_name
  }
}
