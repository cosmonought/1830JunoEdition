# ==================================================================
#  COST-1: THE ECS-ERA SINGLETONS GAINED `count` (var.compute). These moves keep every existing object at its address's
#  instance [0], so a plan with compute = "ecs" (the default) changes NOTHING in an existing state: no replacement, no
#  destroy (Terraform would also infer each move; they are explicit here so the plan reviewer sees them).
# ==================================================================

moved {
  from = aws_lb.this
  to   = aws_lb.this[0]
}

moved {
  from = aws_lb_listener.https
  to   = aws_lb_listener.https[0]
}

moved {
  from = aws_lb_listener_rule.gs
  to   = aws_lb_listener_rule.gs[0]
}

moved {
  from = aws_ecs_cluster.this
  to   = aws_ecs_cluster.this[0]
}

moved {
  from = aws_iam_role.execution
  to   = aws_iam_role.execution[0]
}

moved {
  from = aws_iam_role_policy.execution
  to   = aws_iam_role_policy.execution[0]
}

moved {
  from = aws_iam_role.task
  to   = aws_iam_role.task[0]
}

moved {
  from = aws_iam_role_policy.task
  to   = aws_iam_role_policy.task[0]
}

moved {
  from = aws_security_group.alb
  to   = aws_security_group.alb[0]
}

moved {
  from = aws_vpc_security_group_ingress_rule.alb_from_cloudfront
  to   = aws_vpc_security_group_ingress_rule.alb_from_cloudfront[0]
}

moved {
  from = aws_vpc_security_group_egress_rule.alb_to_tasks
  to   = aws_vpc_security_group_egress_rule.alb_to_tasks[0]
}

moved {
  from = aws_security_group.task
  to   = aws_security_group.task[0]
}

moved {
  from = aws_vpc_security_group_ingress_rule.task_from_alb
  to   = aws_vpc_security_group_ingress_rule.task_from_alb[0]
}
