# ==================================================================
#  COST-1: THE HOST'S ONE ROLE -- THE ECS TASK ROLE'S AUTHORITY, NARROWED TO ONE HOST, AND NOTHING ELSE
# ==================================================================
#
#   gs-<env>-host-app   assumed ONLY by EC2 (this account) through the instance profile; credentials come from IMDSv2
#                       (short-lived, rotated by AWS). The server is the SAME AWS-mode runtime the ECS task ran, so its
#                       grants are the ECS task role's (stacks/app iam.tf "task"), statement for statement:
#     - the game table(s): read / condition-check; write everything but SYSTEM/* (routing, generation markers)
#     - the identity table: the identity writer's reads and writes
#     - the ledger (cross-account): read / condition-check; append everything but APPGEN and APPGEN#HISTORY
#     - ssm:GetParameter on exactly this pool's runtime document (+ the Juno document with escrow)
#     - kms:GetPublicKey and kms:Sign (ECDSA_SHA_256 over a DIGEST only) on exactly the configured keys
#   narrowed: ONE pool's document (the ECS role read every pool's).
#   plus what ECS's execution role / the platform did before, scoped:
#     - pull from the ONE existing ECR repository (GetAuthorizationToken is unscopable)
#     - write log events into the ONE host log group (the Docker awslogs driver)
#     - put metric data ONLY in the 18Cosmos/Host namespace (the host sampler's rare pressure datapoints)
#     - the SSM agent's minimum (Session Manager / Run Command), when `ssm_agent`
#   NEVER: SYSTEM/* writes, APPGEN, RestoreTableToPointInTime, table / key / policy administration, kms:CreateGrant,
#   iam:*, sts:AssumeRole of another role, Secrets Manager, ssm:GetParameter(s) on anything else. Deploy, bootstrap,
#   operator and recovery authority stay with the stacks/app roles operators assume -- never this role.
#
# The ledger and the KMS keys live in the LEDGER account: their resource / key policies (stacks/ledger) are the other half
# and must list this role's ARN (`app_runtime_role_arns`), or every ledger read and every Sign is refused (fail closed).

# The policies are plain JSON built here (not aws_iam_policy_document): reviewable in the plan and asserted statement by
# statement in tests/single-host.tftest.hcl.
locals {
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "Ec2ThisAccountOnly"
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = "ec2.amazonaws.com" }
      Condition = { StringEquals = { "aws:SourceAccount" = local.account } }
    }]
  })

  host_policy_statements = concat(
    [
      # --- game table(s): the L5-2 adapters, L5-3 ownership, the L5-6 relayer mirror (as the ECS task role) ----------
      {
        Sid      = "GameTableReadAndCheck"
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:Scan", "dynamodb:ConditionCheckItem"]
        Resource = local.game_table_arns
      },
      {
        Sid       = "GameTableWriteNeverSystem"
        Effect    = "Allow"
        Action    = ["dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem"]
        Resource  = local.game_table_arns
        Condition = { "ForAllValues:StringNotEquals" = { "dynamodb:LeadingKeys" = ["SYSTEM"] } }
      },
      # --- identity table: the L5-4 identity writer -------------------------------------------------------------------
      {
        Sid      = "IdentityTable"
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:Scan", "dynamodb:ConditionCheckItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem"]
        Resource = [local.identity_table_arn]
      },
      # --- ledger (cross-account; stacks/ledger's resource policy is the other half) ----------------------------------
      {
        Sid      = "LedgerReadAndCheck"
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:ConditionCheckItem"]
        Resource = [var.ledger_table_arn]
      },
      {
        Sid       = "LedgerAppendNeverAppgen"
        Effect    = "Allow"
        Action    = ["dynamodb:PutItem"]
        Resource  = [var.ledger_table_arn]
        Condition = { "ForAllValues:StringNotEquals" = { "dynamodb:LeadingKeys" = ["APPGEN", "APPGEN#HISTORY"] } }
      },
      # --- this pool's configuration documents (plain String parameters: no kms:Decrypt) ------------------------------
      {
        Sid      = "ReadRuntimeConfiguration"
        Effect   = "Allow"
        Action   = ["ssm:GetParameter"]
        Resource = concat([local.runtime_parameter_arn], var.escrow_enabled ? [local.juno_parameter_arn] : [])
      },
    ],
    # --- KMS: the configured signing keys, by key ARN (stacks/ledger's key policy is the other half) ----------------
    [for statement in [
      {
        Sid      = "SigningKeysPublicKey"
        Effect   = "Allow"
        Action   = ["kms:GetPublicKey"]
        Resource = try(values(var.signing_keys), [])
      },
      {
        Sid       = "SigningKeysSignDigestOnly"
        Effect    = "Allow"
        Action    = ["kms:Sign"]
        Resource  = try(values(var.signing_keys), [])
        Condition = { StringEquals = { "kms:SigningAlgorithm" = "ECDSA_SHA_256", "kms:MessageType" = "DIGEST" } }
      },
    ] : statement if var.signing_keys != null],
    # --- KMS: the DEDICATED REMEDY key (Phase 3 escrow 2.1; owner decision 2026-10-08), in its OWN statements ----------
    [for statement in [
      {
        Sid      = "RemedyKeyPublicKey"
        Effect   = "Allow"
        Action   = ["kms:GetPublicKey"]
        Resource = [var.remedy_signing_key]
      },
      {
        Sid       = "RemedyKeySignDigestOnly"
        Effect    = "Allow"
        Action    = ["kms:Sign"]
        Resource  = [var.remedy_signing_key]
        Condition = { StringEquals = { "kms:SigningAlgorithm" = "ECDSA_SHA_256", "kms:MessageType" = "DIGEST" } }
      },
    ] : statement if var.remedy_signing_key != null],
    [
      # --- the image: the ONE existing repository (GetAuthorizationToken has no resource-level scope) ---------------
      {
        Sid      = "EcrAuthTokenUnscopable"
        Effect   = "Allow"
        Action   = ["ecr:GetAuthorizationToken"]
        Resource = ["*"]
      },
      {
        Sid      = "PullThisRepositoryOnly"
        Effect   = "Allow"
        Action   = ["ecr:BatchCheckLayerAvailability", "ecr:GetDownloadUrlForLayer", "ecr:BatchGetImage"]
        Resource = [local.ecr_repository_arn]
      },
      # --- logs: the ONE host log group (the Docker awslogs driver; the group itself is Terraform's) ----------------
      {
        Sid      = "WriteThisHostLogsOnly"
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = ["${local.log_group_arn}:log-stream:*"]
      },
      # --- the host sampler's pressure datapoints: ONLY its own namespace (PutMetricData has no resource scope) ------
      {
        Sid       = "HostPressureMetricOnly"
        Effect    = "Allow"
        Action    = ["cloudwatch:PutMetricData"]
        Resource  = ["*"]
        Condition = { StringEquals = { "cloudwatch:namespace" = local.host_metric_namespace } }
      },
    ],
    # --- the SSM agent's minimum (Session Manager + Run Command over the PUBLIC endpoints: no interface endpoint) ----
    # ssmmessages:* and ec2messages:* support no resource-level scope; UpdateInstanceInformation is scoped to instances of
    # this account. Deliberately NOT AmazonSSMManagedInstanceCore: it grants ssm:GetParameter(s) on every parameter.
    [for statement in [
      {
        Sid      = "SsmAgentRegister"
        Effect   = "Allow"
        Action   = ["ssm:UpdateInstanceInformation", "ssm:ListInstanceAssociations"]
        Resource = ["arn:${local.partition}:ec2:${local.region}:${local.account}:instance/*"]
      },
      {
        Sid    = "SsmAgentChannelsUnscopable"
        Effect = "Allow"
        Action = [
          "ssmmessages:CreateControlChannel", "ssmmessages:CreateDataChannel", "ssmmessages:OpenControlChannel", "ssmmessages:OpenDataChannel",
          "ec2messages:AcknowledgeMessage", "ec2messages:DeleteMessage", "ec2messages:FailMessage", "ec2messages:GetEndpoint", "ec2messages:GetMessages", "ec2messages:SendReply",
        ]
        Resource = ["*"]
      },
    ] : statement if var.ssm_agent],
  )

  host_policy = jsonencode({ Version = "2012-10-17", Statement = local.host_policy_statements })
}

resource "aws_iam_role" "host" {
  name                 = local.role_name
  assume_role_policy   = local.assume_role_policy
  max_session_duration = 3600
  tags                 = local.tags
}

resource "aws_iam_instance_profile" "host" {
  name = local.role_name
  role = aws_iam_role.host.name
  tags = local.tags
}

resource "aws_iam_role_policy" "host" {
  name   = "gs-single-host-runtime"
  role   = aws_iam_role.host.id
  policy = local.host_policy
}
