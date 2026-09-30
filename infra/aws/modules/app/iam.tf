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
#   gs-<env>-bootstrap      the deploy pipeline / operator: create-if-absent SYSTEM/ROUTING and APPGEN, and READ
#                           everything the verifier checks. It has no other write and cannot sign.
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
    resources = [local.game_table_arn]
  }
  statement {
    sid       = "GameTableWriteNeverSystem"
    actions   = ["dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem"]
    resources = [local.game_table_arn]
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
  statement {
    sid       = "LedgerAppendNeverAppgen"
    actions   = ["dynamodb:PutItem"]
    resources = [var.ledger_table_arn]
    condition {
      test     = "ForAllValues:StringNotEquals"
      variable = "dynamodb:LeadingKeys"
      values   = ["APPGEN"]
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
  statement {
    sid       = "DescribeTables"
    actions   = ["dynamodb:DescribeTable", "dynamodb:DescribeContinuousBackups", "dynamodb:DescribeTimeToLive"]
    resources = [local.game_table_arn, local.identity_table_arn, var.ledger_table_arn]
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
  statement {
    sid       = "VerifierEdge"
    actions   = ["cloudfront:GetDistributionConfig", "cloudfront:GetOriginRequestPolicy"]
    resources = ["arn:${local.partition}:cloudfront::${local.account}:distribution/*", "arn:${local.partition}:cloudfront::${local.account}:origin-request-policy/*"]
  }
  statement {
    sid = "VerifierDescribeUnscopable"
    actions = [
      "ecs:DescribeTaskDefinition",
      "elasticloadbalancing:DescribeTargetGroups", "elasticloadbalancing:DescribeLoadBalancers", "elasticloadbalancing:DescribeLoadBalancerAttributes",
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
