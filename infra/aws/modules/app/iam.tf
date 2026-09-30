# ==================================================================
#  LIVE-5 L5-8: THREE ROLES, THREE AUTHORITIES (L5-7 §14 "task role")
# ==================================================================
#
#   gs-<env>-app-execution  ECS itself: pull the image, write the task's log stream. Nothing of the application.
#   gs-<env>-app-task       the application -- the ONLY credential source of a running task (static keys are refused by
#                           the runtime). Exactly the DynamoDB actions the L5-2..L5-6 adapters send, per table; KMS
#                           GetPublicKey + Sign (ECDSA_SHA_256 over a DIGEST) on the three keys; ssm:GetParameter on the
#                           two documents. No Secrets Manager (nothing consumes a secret yet), no logs (the execution
#                           role's), no ECS Exec. It never writes SYSTEM/* (the routing) or APPGEN.
#   gs-<env>-bootstrap      the deploy pipeline / operator: create-if-absent SYSTEM/ROUTING, SYSTEM/GENERATION (L6-4)
#                           and APPGEN, and READ everything the verifier and the generation gate check. It has no other
#                           write and cannot sign.
#   gs-<env>-operator       (LIVE-6 L6-2; L6-3 §11 item 4) `gamesDoctor aws`: read the game table, the identity-writer
#                           role and the ledger's APPGEN / FENCE# (and scan it, read-only, for the orphans report); write
#                           only the routing CAS (SYSTEM), its evidence (OPRUN#), an operator run's HEAD claim / take /
#                           release (GAME#) and its run pool (POOL#op:*). No identity write, no relayer, no KMS, no
#                           delete. Created only when operator_trusted_principal_arns names someone.
#   gs-<env>-recovery       (LIVE-6 L6-2; L6-4 §12.1 item 3) `npm run recovery`: APPGEN adoption (+ its history item),
#                           a restored table's SYSTEM/GENERATION, the identity replay on a restored identity table;
#                           RestoreTableToPointInTime only with recovery_break_glass. Created only when
#                           recovery_trusted_principal_arns names someone.
#
# LIVE-6 L6-2: THE TASK ROLE IS UNCHANGED BY NON-PRIMARY SERVING. A non-primary pool's task (L6-1's router) sends only
# GetItems and its own pool takeover / self-check -- all already granted -- and it is promoted by RESTARTING into the
# primary role (exit 5), with the SAME task definition and role: any pool's task may be the primary tomorrow, so its role
# must already be the primary's. What keeps a non-primary task from acting as the primary is not IAM (IAM cannot see
# SYSTEM/ROUTING) but the fences: every role takeover carries `ConditionCheck SYSTEM/ROUTING primary_pool = :P` and the
# pool epoch inside its own transaction (L5-3), and the router's code writes nothing (L6-1, tested). The operator's and
# the recovery's authority are separate roles no task can assume. The one task-role change: every MANAGED game-table
# generation (L6-4 §12.1 item 3: g<N+1> before its tasks start; g<N> while an old task may still run).
#
# DynamoDB authorises a TransactWriteItems / TransactGetItems per underlying action (Put/Update/Delete/ConditionCheckItem
# / GetItem), so the lists below are complete for the transactions too.
#
# WHAT AWS CANNOT SCOPE BY RESOURCE (and is therefore "*"): ecr:GetAuthorizationToken (execution role); for the
# verifier's read-only describes, ecs:DescribeTaskDefinition, elasticloadbalancing:Describe*, ec2:DescribeSecurityGroups
# and ec2:DescribeSecurityGroupRules (bootstrap role). The task role has no "*" resource.

data "aws_iam_policy_document" "ecs_tasks_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account]
    }
    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:${local.partition}:ecs:${local.region}:${local.account}:*"]
    }
  }
}

/* ------------------------------------------------------------------ */
/* Execution role                                                       */
/* ------------------------------------------------------------------ */

resource "aws_iam_role" "execution" {
  name               = local.execution_role_name
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
  tags               = local.tags
}

data "aws_iam_policy_document" "execution" {
  statement {
    sid       = "EcrAuthTokenUnscopable"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }
  statement {
    sid       = "PullThisRepositoryOnly"
    actions   = ["ecr:BatchCheckLayerAvailability", "ecr:GetDownloadUrlForLayer", "ecr:BatchGetImage"]
    resources = [aws_ecr_repository.server.arn]
  }
  statement {
    sid       = "WriteThisServiceLogsOnly"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = [for id, group in aws_cloudwatch_log_group.pool : "${group.arn}:log-stream:*"]
  }
}

resource "aws_iam_role_policy" "execution" {
  name   = "ecs-execution"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.execution.json
}

/* ------------------------------------------------------------------ */
/* Application task role                                                */
/* ------------------------------------------------------------------ */

resource "aws_iam_role" "task" {
  name               = local.task_role_name
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
  tags               = local.tags
}

data "aws_iam_policy_document" "task" {
  # --- game table: the L5-2 adapters, L5-3 ownership, the L5-6 relayer mirror --------------------------------------
  statement {
    sid       = "GameTableReadAndCheck"
    actions   = ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:Scan", "dynamodb:ConditionCheckItem"]
    resources = values(local.game_table_arns)
  }
  statement {
    sid       = "GameTableWriteNeverSystem"
    actions   = ["dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem"]
    resources = values(local.game_table_arns)
    # Defence in depth (the routing's own CAS and the role takeovers' ConditionChecks are the safety): a task reads
    # SYSTEM/ROUTING and checks it inside its takeovers, and never writes it.
    condition {
      test     = "ForAllValues:StringNotEquals"
      variable = "dynamodb:LeadingKeys"
      values   = ["SYSTEM"]
    }
  }

  # --- identity table: the L5-4 identity writer ------------------------------------------------------------------
  statement {
    sid = "IdentityTable"
    actions = [
      "dynamodb:GetItem", "dynamodb:Scan", "dynamodb:ConditionCheckItem",
      "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem",
    ]
    resources = [local.identity_table_arn]
  }

  # --- ledger (cross-account; the ledger stack's resource policy is the other half) ------------------------------
  statement {
    sid       = "LedgerReadAndCheck"
    actions   = ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:ConditionCheckItem"]
    resources = [var.ledger_table_arn]
  }
  # LIVE-6 L6-2 (review M4): nor APPGEN#HISTORY -- a task pre-creating GEN#<N+1> would block that adoption for good;
  # adoption authority is the recovery role's alone.
  statement {
    sid       = "LedgerAppendNeverAppgen"
    actions   = ["dynamodb:PutItem"]
    resources = [var.ledger_table_arn]
    condition {
      test     = "ForAllValues:StringNotEquals"
      variable = "dynamodb:LeadingKeys"
      values   = ["APPGEN", "APPGEN#HISTORY"]
    }
  }

  # --- the two configuration documents (plain String parameters: no kms:Decrypt) ---------------------------------
  statement {
    sid       = "ReadRuntimeConfiguration"
    actions   = ["ssm:GetParameter"]
    resources = concat(values(local.runtime_parameter_arn), local.escrow_enabled ? [local.juno_parameter_arn] : [])
  }

  # --- KMS: the three signing keys, by key ARN ---------------------------------------------------------------------
  dynamic "statement" {
    for_each = var.signing_keys == null ? [] : [1]
    content {
      sid       = "SigningKeysPublicKey"
      actions   = ["kms:GetPublicKey"]
      resources = values(var.signing_keys)
    }
  }
  dynamic "statement" {
    for_each = var.signing_keys == null ? [] : [1]
    content {
      sid       = "SigningKeysSignDigestOnly"
      actions   = ["kms:Sign"]
      resources = values(var.signing_keys)
      condition {
        test     = "StringEquals"
        variable = "kms:SigningAlgorithm"
        values   = ["ECDSA_SHA_256"]
      }
      condition {
        test     = "StringEquals"
        variable = "kms:MessageType"
        values   = ["DIGEST"]
      }
    }
  }
}

resource "aws_iam_role_policy" "task" {
  name   = "gs-runtime"
  role   = aws_iam_role.task.id
  policy = data.aws_iam_policy_document.task.json
}

/* ------------------------------------------------------------------ */
/* Bootstrap / verify role (the pipeline or an operator assumes it)     */
/* ------------------------------------------------------------------ */

data "aws_iam_policy_document" "bootstrap_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "AWS"
      identifiers = var.bootstrap_trusted_principal_arns
    }
  }
}

resource "aws_iam_role" "bootstrap" {
  name               = local.bootstrap_role_name
  assume_role_policy = data.aws_iam_policy_document.bootstrap_assume.json
  tags               = local.tags
}

data "aws_iam_policy_document" "bootstrap" {
  statement {
    sid       = "RoutingItemOnly"
    actions   = ["dynamodb:GetItem", "dynamodb:PutItem"]
    resources = [local.game_table_arn]
    condition {
      test     = "ForAllValues:StringEquals"
      variable = "dynamodb:LeadingKeys"
      values   = ["SYSTEM"]
    }
  }
  # L6-2: the generation gate reads a restored table's SYSTEM/GENERATION before the switch (every managed generation).
  # LIVE-6 L6-2 (for L6-7): `awsDeploy relayer-rotation-gate` reads the OLD relayer's RELAYQ#<address> completely (Query,
  # strongly consistent, every page) -- read-only, that partition prefix only.
  statement {
    sid       = "RelayQueueRead"
    actions   = ["dynamodb:Query"]
    resources = values(local.game_table_arns)
    condition {
      test     = "ForAllValues:StringLike"
      variable = "dynamodb:LeadingKeys"
      values   = ["RELAYQ#*"]
    }
  }
  statement {
    sid       = "GenerationMarkersRead"
    actions   = ["dynamodb:GetItem"]
    resources = values(local.game_table_arns)
    condition {
      test     = "ForAllValues:StringEquals"
      variable = "dynamodb:LeadingKeys"
      values   = ["SYSTEM"]
    }
  }
  statement {
    sid       = "AppgenItemOnly"
    actions   = ["dynamodb:GetItem", "dynamodb:PutItem"]
    resources = [var.ledger_table_arn]
    condition {
      test     = "ForAllValues:StringEquals"
      variable = "dynamodb:LeadingKeys"
      values   = ["APPGEN"]
    }
  }
  # L6-2: the generation gate reads APPGEN's adoption history item (read only).
  statement {
    sid       = "AppgenHistoryRead"
    actions   = ["dynamodb:GetItem"]
    resources = [var.ledger_table_arn]
    condition {
      test     = "ForAllValues:StringEquals"
      variable = "dynamodb:LeadingKeys"
      values   = ["APPGEN#HISTORY"]
    }
  }
  statement {
    sid       = "DescribeTables"
    actions   = ["dynamodb:DescribeTable", "dynamodb:DescribeContinuousBackups", "dynamodb:DescribeTimeToLive"]
    resources = concat(values(local.game_table_arns), [local.identity_table_arn, var.ledger_table_arn])
  }
  statement {
    sid       = "ReadConfiguration"
    actions   = ["ssm:GetParameter"]
    resources = concat(values(local.runtime_parameter_arn), local.escrow_enabled ? [local.juno_parameter_arn] : [])
  }
  dynamic "statement" {
    for_each = var.signing_keys == null ? [] : [1]
    content {
      sid       = "SigningKeysReadOnly"
      actions   = ["kms:DescribeKey", "kms:GetPublicKey", "kms:ListGrants"]
      resources = values(var.signing_keys)
    }
  }
  statement {
    sid       = "VerifierDescribeServices"
    actions   = ["ecs:DescribeServices"]
    resources = ["arn:${local.partition}:ecs:${local.region}:${local.account}:service/${local.prefix}/*"]
  }
  # L6-2: the flip evidence -- each pool's stopped tasks (their exit codes) and its family's ACTIVE revisions (rollback
  # targets: the identity-layout tag) -- read only, this cluster's. LIVE-6 L6-6 (converged): the staging certification's
  # captures (each pool's running tasks, every task in the cluster, desired RUNNING and STOPPED) use this same statement.
  statement {
    sid       = "VerifierTasksOfThisCluster"
    actions   = ["ecs:ListTasks", "ecs:DescribeTasks"]
    resources = ["*"]
    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = ["arn:${local.partition}:ecs:${local.region}:${local.account}:cluster/${local.prefix}"]
    }
  }
  statement {
    sid       = "VerifierEdge"
    actions   = ["cloudfront:GetDistributionConfig", "cloudfront:GetDistribution", "cloudfront:GetOriginRequestPolicy"]
    resources = ["arn:${local.partition}:cloudfront::${local.account}:distribution/*", "arn:${local.partition}:cloudfront::${local.account}:origin-request-policy/*"]
  }
  # LIVE-6 final convergence (L6-6R x L6-5A/L6-5B): the staging certification's restore-quiet evidence -- a strongly
  # consistent, paginated Scan of the PREVIOUS generation's game table for its diagnostic TASK# heartbeats (a fresh one
  # after the stop fails the drill; none proves nothing; never a lease). A Scan cannot be narrowed by LeadingKeys, so it is
  # granted on the NON-serving managed generations only -- never the serving table, the identity table or the ledger --
  # and the runtime task role gains nothing (it is `stage-cert certify`'s read, under this role).
  dynamic "statement" {
    for_each = length(local.old_game_table_arns) == 0 ? [] : [1]
    content {
      sid       = "RestoreQuietOldGenerationHeartbeats"
      actions   = ["dynamodb:Scan"]
      resources = local.old_game_table_arns
    }
  }
  # LIVE-6 L6-5B: the alarm evidence (capture-evidence: `describe-alarms --alarm-name-prefix gs-<env>-`), read only. A
  # listing by name prefix is not reliably scopable to alarm ARNs, and the answer holds no secret.
  statement {
    sid       = "VerifierAlarms"
    actions   = ["cloudwatch:DescribeAlarms"]
    resources = ["*"]
  }
  statement {
    sid = "VerifierDescribeUnscopable"
    actions = [
      "ecs:DescribeTaskDefinition", "ecs:ListTaskDefinitions",
      "elasticloadbalancing:DescribeTargetGroups", "elasticloadbalancing:DescribeTargetHealth", "elasticloadbalancing:DescribeLoadBalancers", "elasticloadbalancing:DescribeLoadBalancerAttributes",
      "elasticloadbalancing:DescribeListeners", "elasticloadbalancing:DescribeRules",
      "ec2:DescribeSecurityGroups", "ec2:DescribeSecurityGroupRules",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "bootstrap" {
  name   = "gs-bootstrap-verify"
  role   = aws_iam_role.bootstrap.id
  policy = data.aws_iam_policy_document.bootstrap.json
}

/* ------------------------------------------------------------------ */
/* LIVE-6 L6-2: the operator role (`gamesDoctor aws`, L6-3 §11 item 4)  */
/* ------------------------------------------------------------------ */

data "aws_iam_policy_document" "operator_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "AWS"
      identifiers = length(var.operator_trusted_principal_arns) > 0 ? var.operator_trusted_principal_arns : ["arn:${local.partition}:iam::${local.account}:root"]
    }
  }
}

resource "aws_iam_role" "operator" {
  count              = length(var.operator_trusted_principal_arns) > 0 ? 1 : 0
  name               = local.operator_role_name
  assume_role_policy = data.aws_iam_policy_document.operator_assume.json
  tags               = local.tags
}

data "aws_iam_policy_document" "operator" {
  # Reads: HEADs, pools, the routing and markers, OPRUN evidence, the directory / money indexes, the records' own loads.
  statement {
    sid       = "GameTableRead"
    actions   = ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:ConditionCheckItem"]
    resources = values(local.game_table_arns)
  }
  # Writes: the routing CAS and the run's evidence (PutItem), a HEAD's claim / take / release and the run's own pool
  # (UpdateItem). IAM cannot restrict the sort key: SYSTEM covers SYSTEM/ROUTING (the operator's), GAME# covers the HEAD
  # (the only GAME# item the tool updates -- its code and its import guard, L6-3). Never a delete, never a pool other than
  # an operator run's. Review M5: each write is further limited to the ATTRIBUTES those items carry -- a PutItem can
  # never carry a SYSTEM/GENERATION marker's fields (generation, game_table, origin, restore_*: the recovery role's), and
  # an UpdateItem can touch only the ownership fields (never a financial record, intent or hold). Defence in depth: the
  # conditions inside every write are the safety (staging gate: confirm a real flip / take / release is not denied).
  statement {
    sid       = "RoutingAndEvidence"
    actions   = ["dynamodb:PutItem"]
    resources = values(local.game_table_arns)
    condition {
      test     = "ForAllValues:StringLike"
      variable = "dynamodb:LeadingKeys"
      values   = ["SYSTEM", "OPRUN#*"]
    }
    condition {
      test     = "ForAllValues:StringEquals"
      variable = "dynamodb:Attributes"
      values   = ["pk", "sk", "fmt", "primary_pool", "routing_version", "updated_at", "updated_by", "claim", "run", "task", "command", "subject", "note", "started_at", "tool", "build", "outcome", "detail", "at"]
    }
  }
  statement {
    sid       = "OperatorRunHeadsAndRunPools"
    actions   = ["dynamodb:UpdateItem"]
    resources = values(local.game_table_arns)
    condition {
      test     = "ForAllValues:StringLike"
      variable = "dynamodb:LeadingKeys"
      values   = ["GAME#*", "POOL#op:*"]
    }
    condition {
      test     = "ForAllValues:StringEquals"
      variable = "dynamodb:Attributes"
      values   = ["pk", "sk", "owner_pool", "pool_epoch", "owner_task", "writer_epoch", "writer_task", "taken_at"]
    }
  }
  statement {
    sid       = "IdentityWriterRoleRead"
    actions   = ["dynamodb:GetItem"]
    resources = [local.identity_table_arn]
    condition {
      test     = "ForAllValues:StringEquals"
      variable = "dynamodb:LeadingKeys"
      values   = ["ROLE#identity-writer"]
    }
  }
  statement {
    sid       = "LedgerRead"
    actions   = ["dynamodb:GetItem", "dynamodb:Scan"]
    resources = [var.ledger_table_arn]
  }
  statement {
    sid       = "ReadConfiguration"
    actions   = ["ssm:GetParameter"]
    resources = concat(values(local.runtime_parameter_arn), local.escrow_enabled ? [local.juno_parameter_arn] : [])
  }
  # LIVE-6 L6-5B: the planned-flip window's suppressor datapoints (`gamesDoctor aws flip` opens, the settled recovery
  # closes) -- ONLY into the operator namespace: never a game-server metric (18Cosmos/GameServer is the tasks' EMF).
  statement {
    sid       = "FlipWindowMetricsOnly"
    actions   = ["cloudwatch:PutMetricData"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "cloudwatch:namespace"
      values   = [local.suppressor.namespace]
    }
  }
}

resource "aws_iam_role_policy" "operator" {
  count  = length(aws_iam_role.operator)
  name   = "gs-operator"
  role   = aws_iam_role.operator[0].id
  policy = data.aws_iam_policy_document.operator.json
}

/* ------------------------------------------------------------------ */
/* LIVE-6 L6-2: the recovery role (`npm run recovery`, L6-4 §12.1 item 3) */
/* ------------------------------------------------------------------ */

data "aws_iam_policy_document" "recovery_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "AWS"
      identifiers = length(var.recovery_trusted_principal_arns) > 0 ? var.recovery_trusted_principal_arns : ["arn:${local.partition}:iam::${local.account}:root"]
    }
  }
}

resource "aws_iam_role" "recovery" {
  count              = length(var.recovery_trusted_principal_arns) > 0 ? 1 : 0
  name               = local.recovery_role_name
  assume_role_policy = data.aws_iam_policy_document.recovery_assume.json
  tags               = local.tags
}

data "aws_iam_policy_document" "recovery" {
  statement {
    sid       = "LedgerReadAndScan"
    actions   = ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:Scan"]
    resources = [var.ledger_table_arn]
  }
  statement {
    sid       = "AppgenAdoption"
    actions   = ["dynamodb:UpdateItem"]
    resources = [var.ledger_table_arn]
    condition {
      test     = "ForAllValues:StringEquals"
      variable = "dynamodb:LeadingKeys"
      values   = ["APPGEN"]
    }
  }
  statement {
    sid       = "AppgenHistoryAppend"
    actions   = ["dynamodb:PutItem"]
    resources = [var.ledger_table_arn]
    condition {
      test     = "ForAllValues:StringEquals"
      variable = "dynamodb:LeadingKeys"
      values   = ["APPGEN#HISTORY"]
    }
  }
  statement {
    sid       = "GameTableMarkers"
    actions   = ["dynamodb:GetItem"]
    resources = values(local.game_table_arns)
    condition {
      test     = "ForAllValues:StringEquals"
      variable = "dynamodb:LeadingKeys"
      values   = ["SYSTEM"]
    }
  }
  # Review M5: the preparation's PutItem carries only the marker's fields -- never a routing's (primary_pool,
  # routing_version): the recovery role cannot write a routing.
  statement {
    sid       = "GameTableMarkerPrepare"
    actions   = ["dynamodb:PutItem"]
    resources = values(local.game_table_arns)
    condition {
      test     = "ForAllValues:StringEquals"
      variable = "dynamodb:LeadingKeys"
      values   = ["SYSTEM"]
    }
    condition {
      test     = "ForAllValues:StringEquals"
      variable = "dynamodb:Attributes"
      values   = ["pk", "sk", "fmt", "generation", "game_table", "origin", "restored_from_generation", "restored_from_table", "restore_point", "restore_id", "prepared_at", "prepared_by", "claim"]
    }
  }
  statement {
    sid       = "IdentityTablesReplay"
    actions   = ["dynamodb:GetItem", "dynamodb:Scan", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:ConditionCheckItem"]
    resources = [local.identity_tables_arns]
  }
  dynamic "statement" {
    for_each = var.recovery_break_glass ? [1] : []
    content {
      sid = "BreakGlassRestoreToPointInTime"
      # A PITR restore writes the NEW table through these actions (AWS documents the target's write permissions as required).
      actions   = ["dynamodb:RestoreTableToPointInTime", "dynamodb:DescribeTable", "dynamodb:DescribeContinuousBackups", "dynamodb:BatchWriteItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:GetItem", "dynamodb:Query", "dynamodb:Scan"]
      resources = concat(values(local.game_table_arns), [local.identity_tables_arns], ["arn:${local.partition}:dynamodb:${local.region}:${local.account}:table/${local.prefix}-game-g*"])
    }
  }
}

resource "aws_iam_role_policy" "recovery" {
  count  = length(aws_iam_role.recovery)
  name   = "gs-recovery"
  role   = aws_iam_role.recovery[0].id
  policy = data.aws_iam_policy_document.recovery.json
}
