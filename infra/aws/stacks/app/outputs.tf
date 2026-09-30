output "app" {
  description = "Everything the bootstrap, the verifier and the image push need (no secrets)."
  value = {
    game_table_name          = module.app.game_table_name
    identity_table_name      = module.app.identity_table_name
    primary_pool             = module.app.primary_pool
    runtime_parameter_arns   = module.app.runtime_parameter_arns
    juno_parameter_arn       = module.app.juno_parameter_arn
    role_arns                = module.app.role_arns
    ecr_repository_url       = module.app.ecr_repository_url
    cluster_name             = module.app.cluster_name
    service_names            = module.app.service_names
    task_definition_families = module.app.task_definition_families
    security_group_ids       = module.app.security_group_ids
    alb_dns_name             = module.app.alb_dns_name
    load_balancer_arn        = module.app.load_balancer_arn
    target_group_arns        = module.app.target_group_arns
    routes                   = module.app.routes
    listener_rule_priorities = module.app.listener_rule_priorities
    game_table_names         = module.app.game_table_names
    origin_request_policy_id = module.app.origin_request_policy_id
    distribution_id          = module.app.distribution_id
    alarm_namespace          = module.app.alarm_namespace
    alarms                   = module.app.alarms
    flip_suppression         = module.app.flip_suppression
  }
}
