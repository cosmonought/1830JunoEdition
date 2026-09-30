# ==================================================================
#  LIVE-5 L5-8: THE ALB -- /gs* TO THE PRIMARY POOL, TARGET HEALTH = /gs/readyz, IDLE TIMEOUT FOR WEBSOCKETS
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

resource "aws_lb_target_group" "primary" {
  name                 = "${local.prefix}-primary" # stable: the primary pool it serves is its tag (a flip is L6-2's)
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

  tags = merge(local.tags, { "gs:pool" = local.primary_pool })

  lifecycle {
    precondition {
      condition     = length("${local.prefix}-primary") <= 32
      error_message = "The target group name gs-<environment>-primary must be at most 32 characters."
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

resource "aws_lb_listener_rule" "gs" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 10

  condition {
    path_pattern {
      values = ["/gs*"]
    }
  }

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.primary.arn
  }

  tags = local.tags
}
