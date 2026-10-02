# ==================================================================
#  LIVE-5 L5-8: ONE TASK PER POOL -- AND A ROLLOUT THAT DOES NOT PLAN TWO TASKS OF ONE POOL
# ==================================================================
#
# THE ROLLOUT (L5-7 §14: "two tasks of one pool fence each other in turn"). A pool is one writer: the newest task to take
# `POOL#<p>` fences every older one, which exits 3 at once (no graceful drain). ECS's generic rolling default
# (minimumHealthyPercent 100 / maximumPercent 200) starts the new task BEFORE stopping the old one, so on every deploy:
#   - the new task takes the pool while the old one is still serving: the old one is FENCED, not drained (exit 3, its
#     identity confirmations and in-flight work cut off, an `aws.task-lost` audit line -- a false page for L6-5);
#   - the overlap buys no availability: the old task stops serving the moment the new one takes the pool, and the new one
#     is not ready until its identity load, discovery and first money sweep are done;
#   - worse, the old deployment's task has died unexpectedly, and the scheduler may start a replacement that takes the pool
#     back and fences the NEW task -- a fence ping-pong until one deployment wins.
# So every pool's service is STOP-FIRST: minimumHealthyPercent 0 / maximumPercent 100. ECS deregisters the old task and
# sends it SIGTERM; it runs L5-7's graceful shutdown (readiness 503 -> ... -> identity.settled() -> exit 0, bounded to fit
# stopTimeout 120 s). The same rule closes the other ways ECS overlaps tasks on purpose:
#   - Availability Zone rebalancing (ENABLED by default on new services since 2025) starts a task before stopping one:
#     DISABLED explicitly (it is also incompatible with maximumPercent 100);
#   - the circuit breaker's rollback is itself a stop-first deployment of the previous revision;
#   - Fargate maintenance replacements honour minimumHealthyPercent 0 (stop, then start).
# WHAT STOP-FIRST DOES NOT GUARANTEE (review M1): maximumPercent counts RUNNING/PENDING tasks, and a task that is
# deregistering or running its shutdown may no longer count -- so ECS can start the new task while the old one is still
# draining. The new task then takes the pool and the old one exits 3 mid-drain: SAFE (every write is fenced; nothing the
# old task sends after the takeover lands), but its drain is cut short and an `aws.task-lost` line is written. For a
# rollout with NO overlap at all, drain the pool first -- infra/aws/scripts/drain-pool.{sh,ps1} scales the service to 0
# and waits until its task has STOPPED -- then `terraform apply` (desired_count 1 starts the new task from nothing). That
# is the documented production procedure (infra/aws/README.md "Rollout"); the staging gate observes the ordering.
# The price either way is a gap per deploy (the old task's drain + the new task's startup), accepted for the MVA.
#
# NEVER run a second task of a pool outside its service (`aws ecs run-task` with this task definition): it takes the pool,
# the service's task exits 3, ECS restarts it, it takes the pool back -- the same ping-pong. Operator runs use `op:` ids (L6).

resource "aws_ecr_repository" "server" {
  name                 = "${local.prefix}-server"
  image_tag_mutability = "IMMUTABLE" # BUILD_ID names exactly one image
  force_delete         = false

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = local.tags
}

resource "aws_ecs_cluster" "this" {
  count = local.ecs_one

  name = local.prefix

  setting {
    name  = "containerInsights"
    value = "enabled"
  }

  tags = local.tags
}

resource "aws_cloudwatch_log_group" "pool" {
  for_each          = local.ecs_pools
  name              = "/gs/${var.environment}/${each.key}"
  retention_in_days = var.log_retention_days
  tags              = merge(local.tags, { "gs:pool" = each.key })
}

resource "aws_ecs_task_definition" "pool" {
  for_each = local.ecs_pools

  family                   = "${local.prefix}-${each.key}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = tostring(each.value.cpu)
  memory                   = tostring(each.value.memory)
  execution_role_arn       = aws_iam_role.execution[0].arn
  task_role_arn            = aws_iam_role.task[0].arn
  skip_destroy             = true # keep earlier revisions ACTIVE: the circuit breaker rolls back to them

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([
    {
      name      = "game-server"
      image     = "${local.account}.dkr.ecr.${local.region}.amazonaws.com/${aws_ecr_repository.server.name}:${var.build_id}"
      essential = true
      user      = "node"

      portMappings = [{ containerPort = var.container_port, hostPort = var.container_port, protocol = "tcp" }]

      # References only (L5-7 §14). NEVER here: DATA_DIR, ESCROW_JUNO_CONFIG, AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY /
      # AWS_SESSION_TOKEN (the runtime refuses each), and no `secrets` / `environmentFiles` (a secret is read by the
      # application from Secrets Manager by reference, never injected into the environment).
      environment = local.container_environment[each.key]

      # Fargate's maximum: the graceful shutdown's drains are bounded to fit it (L5-7 §7).
      stopTimeout = 120

      # Liveness only (/gs/healthz); readiness (/gs/readyz) is the ALB target group's. startPeriod covers the startup up to
      # the listening server (configuration, generation, pool, identity role and load).
      healthCheck = {
        command     = local.healthz_command
        interval    = 15
        timeout     = 5
        retries     = 4
        startPeriod = 300
      }

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.pool[each.key].name
          awslogs-region        = local.region
          awslogs-stream-prefix = "gs"
        }
      }

      # AWS mode keeps no data directory and writes nothing to disk.
      readonlyRootFilesystem = true
      linuxParameters        = { initProcessEnabled = true }
    }
  ])

  # L6-2 (L6-4 §12.3): the identity layout this image reads -- every revision declares it, so every rollback target does.
  tags = merge(local.tags, { "gs:pool" = each.key }, local.identity_layout_tag)

  # Deploy order: the documents the task reads, and its role, exist before its definition.
  depends_on = [aws_ssm_parameter.runtime, aws_ssm_parameter.juno_backend, aws_iam_role_policy.task[0]]
}

# The plan reads SYSTEM/ROUTING (the bootstrap's) before it creates any service: a task never repairs a missing routing
# or APPGEN (L5-8 deploy order step 5), so a service is never started before the bootstrap.
data "aws_dynamodb_table_item" "routing" {
  count      = var.start_services ? 1 : 0
  table_name = aws_dynamodb_table.game[tostring(var.generation)].name
  key        = jsonencode({ pk = { S = "SYSTEM" }, sk = { S = "ROUTING" } })
}

# LIVE-6 L6-2 (L6-4): the SERVING table's own generation marker. Every task refuses to start unless it names this
# generation and this table (L6-4 §5); the plan refuses first, so a runtime document can never be switched to a table
# that is not prepared as this generation. After a restore it must also be the adoption the generation gate attested
# (`generation_adoption`; the ledger's real adoption is re-checked by every task before it takes its pool).
data "aws_dynamodb_table_item" "generation" {
  count      = var.start_services ? 1 : 0
  table_name = aws_dynamodb_table.game[tostring(var.generation)].name
  key        = jsonencode({ pk = { S = "SYSTEM" }, sk = { S = "GENERATION" } })
}

locals {
  routing_item    = var.start_services ? try(jsondecode(data.aws_dynamodb_table_item.routing[0].item), null) : null
  routing_primary = try(local.routing_item.primary_pool.S, null)
  routing_format  = try(local.routing_item.fmt.N, null)

  marker_item       = var.start_services ? try(jsondecode(data.aws_dynamodb_table_item.generation[0].item), null) : null
  marker_generation = try(local.marker_item.generation.N, null)
  marker_table      = try(local.marker_item.game_table.S, null)
  marker_origin     = try(local.marker_item.origin.S, null)
  marker_restore_id = try(local.marker_item.restore_id.S, null)
  marker_names_this = local.marker_generation == tostring(var.generation) && local.marker_table == local.game_table_name
  marker_adoption_ok = local.marker_origin == "bootstrap" ? var.generation_adoption == null : (
    local.marker_origin == "restore" && var.generation_adoption != null
    && try(var.generation_adoption.generation == var.generation && var.generation_adoption.game_table == local.game_table_name && var.generation_adoption.restore_id == local.marker_restore_id, false)
  )
}

resource "aws_ecs_service" "pool" {
  for_each = var.start_services ? local.ecs_pools : {}

  name                = "${local.prefix}-${each.key}"
  cluster             = aws_ecs_cluster.this[0].id
  task_definition     = aws_ecs_task_definition.pool[each.key].arn
  desired_count       = each.value.desired_count
  launch_type         = "FARGATE"
  platform_version    = "1.4.0"
  scheduling_strategy = "REPLICA"

  # STOP-FIRST (see the header): never two tasks of one pool.
  deployment_minimum_healthy_percent = 0
  deployment_maximum_percent         = 100
  availability_zone_rebalancing      = "DISABLED"

  deployment_controller {
    type = "ECS"
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  enable_execute_command  = false
  enable_ecs_managed_tags = true
  propagate_tags          = "SERVICE"
  wait_for_steady_state   = false

  # A new runtime or Juno document reaches a running pool only through a new deployment (the task reads the latest version
  # at startup): a changed document starts one.
  force_new_deployment = true
  triggers = {
    runtime_document = sha256(local.runtime_document[each.key])
    juno_document    = sha256(coalesce(local.juno_document, "none"))
  }

  network_configuration {
    subnets          = var.network.task_subnet_ids
    security_groups  = [aws_security_group.task[0].id]
    assign_public_ip = false
  }

  # LIVE-6 L6-2: EVERY pool behind its OWN target group (L6-1's non-primary router answers readiness 200). Nothing here
  # depends on which pool is primary: a flip (the /gs* rule's target, alb.tf) never updates a service -- an update would
  # redeploy it (force_new_deployment) and replace its task outside the drain-first procedure.
  load_balancer {
    target_group_arn = aws_lb_target_group.pool[each.key].arn
    container_name   = "game-server"
    container_port   = var.container_port
  }
  health_check_grace_period_seconds = var.health_check_grace_period_seconds

  tags = merge(local.tags, { "gs:pool" = each.key })

  depends_on = [aws_lb_listener_rule.gs, aws_lb_listener_rule.pool, aws_iam_role_policy.task, aws_iam_role_policy.execution]

  lifecycle {
    precondition {
      condition     = local.routing_format == "1" && local.routing_primary == local.primary_pool
      error_message = "SYSTEM/ROUTING must exist and name the primary pool before any service starts or the /gs* rule moves: run `npm run awsDeploy -- bootstrap ... --apply` first; for a FLIP, `gamesDoctor aws flip ... --apply` moves the routing BEFORE this stack's `primary` flag follows it."
    }
    precondition {
      condition     = local.marker_names_this
      error_message = "The serving game table's SYSTEM/GENERATION must name this generation and table (L6-4): the bootstrap writes it for the first table, a restore's `table-prepare` for a restored one. A runtime document is never switched to an unprepared table."
    }
    precondition {
      condition     = local.marker_adoption_ok
      error_message = "The serving table is a restore: set generation_adoption to what `npm run awsDeploy -- generation-gate` printed (the ledger adopted exactly this table and restore) -- or it is a bootstrap table and generation_adoption must be null."
    }
  }
}
