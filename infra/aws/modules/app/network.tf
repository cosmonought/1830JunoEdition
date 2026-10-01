# ==================================================================
#  LIVE-5 L5-8: THE NETWORK CONTRACT -- awsvpc TASKS REACHABLE ONLY FROM THE ALB; THE ALB ONLY FROM CLOUDFRONT
# ==================================================================
#
# AWS mode binds 0.0.0.0:$PORT on the task's ENI (L5-7 owner decision 4), so the security group IS the boundary:
#   task SG    ingress: the container port, from the ALB's security group ONLY (no CIDR, no prefix list, no public IP)
#              egress:  TCP 443 (DynamoDB, KMS, SSM, CloudWatch Logs, ECR -- through the VPC endpoints below when they
#                       exist -- and the Juno REST endpoints) and any extra Juno REST port. Nothing else.
#   ALB SG     ingress: 443 from CloudFront's origin-facing managed prefix list only; egress: the container port to the task SG.
#
# PUBLIC EGRESS THAT REMAINS: the Juno REST endpoints are on the internet (a NAT gateway on the task subnets' route --
# the existing VPC's, not this slice's). With create_interface_endpoints and the gateway endpoints, every AWS API the task
# and ECS use stays in the VPC; without them, those go out through the same NAT to the regions' public endpoints (the SDK
# clients pin the region's own endpoint -- `awsClients.ts`). The ledger and KMS keys in another REGION are reached through
# the public endpoint either way (a VPC endpoint serves only its own region).

data "aws_ec2_managed_prefix_list" "cloudfront_origin_facing" {
  name = "com.amazonaws.global.cloudfront.origin-facing"
}

resource "aws_security_group" "alb" {
  name        = "${local.prefix}-alb"
  description = "18Cosmos ${var.environment} ALB: HTTPS from CloudFront only"
  vpc_id      = var.network.vpc_id
  tags        = merge(local.tags, { Name = "${local.prefix}-alb" })
}

resource "aws_vpc_security_group_ingress_rule" "alb_from_cloudfront" {
  security_group_id = aws_security_group.alb.id
  description       = "HTTPS from CloudFront origin-facing servers"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  prefix_list_id    = data.aws_ec2_managed_prefix_list.cloudfront_origin_facing.id
}

resource "aws_vpc_security_group_egress_rule" "alb_to_tasks" {
  security_group_id            = aws_security_group.alb.id
  description                  = "To the game server tasks only"
  ip_protocol                  = "tcp"
  from_port                    = var.container_port
  to_port                      = var.container_port
  referenced_security_group_id = aws_security_group.task.id
}

resource "aws_security_group" "task" {
  name        = "${local.prefix}-task"
  description = "18Cosmos ${var.environment} game server tasks: the container port from the ALB only"
  vpc_id      = var.network.vpc_id
  tags        = merge(local.tags, { Name = "${local.prefix}-task" })
}

resource "aws_vpc_security_group_ingress_rule" "task_from_alb" {
  security_group_id            = aws_security_group.task.id
  description                  = "The game server port, from the ALB security group only"
  ip_protocol                  = "tcp"
  from_port                    = var.container_port
  to_port                      = var.container_port
  referenced_security_group_id = aws_security_group.alb.id
}

resource "aws_vpc_security_group_egress_rule" "task_https" {
  for_each          = toset([for port in distinct(concat([443], var.network.juno_egress_ports)) : tostring(port)])
  security_group_id = aws_security_group.task.id
  description       = "AWS APIs (or their VPC endpoints) and the Juno REST endpoints"
  ip_protocol       = "tcp"
  from_port         = tonumber(each.key)
  to_port           = tonumber(each.key)
  cidr_ipv4         = "0.0.0.0/0"
}

/* ------------------------------------------------------------------ */
/* VPC endpoints (in-VPC AWS APIs; no networking redesign)              */
/* ------------------------------------------------------------------ */

resource "aws_vpc_endpoint" "gateway" {
  for_each          = length(var.network.private_route_table_ids) == 0 ? toset([]) : toset(["dynamodb", "s3"])
  vpc_id            = var.network.vpc_id
  service_name      = "com.amazonaws.${local.region}.${each.key}"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = var.network.private_route_table_ids
  tags              = merge(local.tags, { Name = "${local.prefix}-${each.key}" })
}

resource "aws_security_group" "endpoints" {
  count       = var.network.create_interface_endpoints ? 1 : 0
  name        = "${local.prefix}-endpoints"
  description = "18Cosmos ${var.environment} interface endpoints: HTTPS from the tasks"
  vpc_id      = var.network.vpc_id
  tags        = merge(local.tags, { Name = "${local.prefix}-endpoints" })
}

resource "aws_vpc_security_group_ingress_rule" "endpoints_from_tasks" {
  count                        = var.network.create_interface_endpoints ? 1 : 0
  security_group_id            = aws_security_group.endpoints[0].id
  description                  = "HTTPS from the game server tasks"
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
  referenced_security_group_id = aws_security_group.task.id
}

resource "aws_vpc_endpoint" "interface" {
  for_each            = var.network.create_interface_endpoints ? toset(["kms", "ssm", "logs", "ecr.api", "ecr.dkr"]) : toset([])
  vpc_id              = var.network.vpc_id
  service_name        = "com.amazonaws.${local.region}.${each.key}"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = var.network.task_subnet_ids
  security_group_ids  = [aws_security_group.endpoints[0].id]
  private_dns_enabled = true
  tags                = merge(local.tags, { Name = "${local.prefix}-${replace(each.key, ".", "-")}" })
}
