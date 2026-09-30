# ==================================================================
#  LIVE-5 L5-8 / LIVE-6 L6-2: THE ALB -- EACH POOL'S EXACT ws_path TO ITS OWN TARGET GROUP, /gs* TO THE PRIMARY'S,
#  TARGET HEALTH = /gs/readyz, IDLE TIMEOUT FOR WEBSOCKETS
# ==================================================================
#
# Target health is READINESS (`/gs/readyz`: 200 only while this task may serve -- pool writer current, identity loaded,
# first money sweep done, not stopping), never liveness (`/gs/healthz` is the container's own check, ecs.tf). ALB listener
# rules do not rewrite query strings; the path pattern forwards /gs* with its query unchanged.

resource "aws_lb" "this" {
  name                       = "${local.prefix}-alb"
  load_balancer_type         = "application"
  internal                   = false
  subnets                    = var.network.alb_subnet_ids
  security_groups            = [aws_security_group.alb.id]
  idle_timeout               = var.alb.idle_timeout_seconds
  drop_invalid_header_fields = true
  enable_deletion_protection = var.alb.deletion_protection
  tags                       = local.tags

  lifecycle {
    precondition {
      condition     = length("${local.prefix}-alb") <= 32
      error_message = "The load balancer name gs-<environment>-alb must be at most 32 characters."
    }
  }
}

# LIVE-6 L6-2: ONE TARGET GROUP PER POOL. Every pool's task is a target of its own group: the primary's answers readiness
# 200 as the primary, a non-primary pool's (L6-1's router) 200 `non-primary` -- so no pool is kept off the ALB any more
# (L5-8's "only the primary behind the ALB" assumed L5-7's standby, whose readyz was 503 forever). A drained or retired
# pool (desired_count 0) keeps its group, empty. The name is the pool's (gs-<env>-<pool>, like its service); L5-8's single
# gs-<env>-primary group is gone -- it was never deployed.
resource "aws_lb_target_group" "pool" {
  for_each = var.pools

  name                 = "${local.prefix}-${each.key}"
  target_type          = "ip"
  protocol             = "HTTP"
  port                 = var.container_port
  vpc_id               = var.network.vpc_id
  deregistration_delay = var.alb.deregistration_delay_seconds # stop-first: this delay is part of every deploy's gap

  health_check {
    enabled             = true
    protocol            = "HTTP"
    port                = "traffic-port"
    path                = "/gs/readyz"
    matcher             = "200"
    interval            = 10
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  tags = merge(local.tags, { "gs:pool" = each.key })

  lifecycle {
    precondition {
      condition     = length("${local.prefix}-${each.key}") <= 32
      error_message = "The target group name gs-<environment>-<pool> must be at most 32 characters."
    }
  }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.this.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.alb.certificate_arn

  default_action {
    type = "fixed-response"
    fixed_response {
      content_type = "text/plain"
      message_body = "not found"
      status_code  = "404"
    }
  }

  tags = local.tags
}

# THE RULES (LIVE-6 L6-2). Deterministic and verifier-checkable (`awsDeploy verify`, aws/controlPlane/evidence.ts):
#   priority 100 + i   one per pool, in sorted pool order: the EXACT path of the pool's trusted ws_path (`/gs/p/<pool>`,
#                      no wildcard) -> that pool's target group. Exact and distinct, so no pool rule shadows another
#                      (`/gs/p/p1` does not match `/gs/p/p10`), and each precedes the default.
#   priority 1000      `/gs*` -> the PRIMARY pool's target group: `/gs` (every client's entry socket), `/gs/api/*` (the
#                      identity writer's HTTP API), and anything else under /gs. A flip moves only this rule's target.
# ALB path patterns never see the query string, and a forward never rewrites it: /gs* keeps cp / cr / cb intact.
resource "aws_lb_listener_rule" "pool" {
  for_each = var.pools

  listener_arn = aws_lb_listener.https.arn
  priority     = local.pool_rule_priority[each.key]

  condition {
    path_pattern {
      values = [local.pool_route[each.key].ws_path]
    }
  }

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.pool[each.key].arn
  }

  tags = merge(local.tags, { "gs:pool" = each.key })
}

resource "aws_lb_listener_rule" "gs" {
  listener_arn = aws_lb_listener.https.arn
  priority     = local.gs_rule_priority

  condition {
    path_pattern {
      values = ["/gs*"]
    }
  }

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.pool[local.primary_pool].arn
  }

  tags = merge(local.tags, { "gs:primary" = local.primary_pool })
}
