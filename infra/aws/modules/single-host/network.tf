# ==================================================================
#  COST-1: THE NETWORK -- ONE PUBLIC SUBNET, ONE ENI, ONE ELASTIC IP, ONE SECURITY GROUP. NO NAT, NO ENDPOINTS, NO ALB.
# ==================================================================
#
# INBOUND
#   443  from CloudFront's origin-facing managed prefix list ONLY (the same boundary the ALB had): every HTTPS request
#        that reaches Caddy came through CloudFront, which is why Caddy may trust X-Forwarded-For (2 hops, as before).
#   80   from anywhere, for Let's Encrypt's HTTP-01 validation ONLY: Caddy answers the ACME challenge path and 404 for
#        everything else (it never proxies on port 80). TLS-ALPN-01 cannot reach 443, so it is disabled in the Caddyfile.
#   22   NOTHING by default. `emergency_ssh_cidrs` (<= 2 single addresses) opens it for EC2 Instance Connect, temporarily.
#   8917 never: the game server is published on the host's loopback (127.0.0.1) only, and this group has no rule for it.
# OUTBOUND
#   443  (and any extra Juno REST port): the AWS public regional endpoints (DynamoDB, KMS, SSM, Logs, ECR, CloudWatch,
#        STS), the Juno REST endpoints, Let's Encrypt, the AL2023 package repositories. Link-local services (IMDS, the
#        Amazon Time Sync Service, the VPC resolver) are not filtered by security groups.
#
# THE ENI AND THE EIP OUTLIVE THE INSTANCE: the Elastic IP is associated with the ENI, and the instance is launched ON that
# ENI, so the host has its public address from its first boot (cloud-init needs the network), and a replacement host gets
# the SAME address -- after the old one is gone: an ENI can be one instance's primary interface at a time, so Terraform
# must destroy the old instance before it creates the new one (never two serving hosts).

data "aws_ec2_managed_prefix_list" "cloudfront_origin_facing" {
  name = "com.amazonaws.global.cloudfront.origin-facing"
}

resource "aws_security_group" "host" {
  name        = local.name
  description = "18Cosmos ${var.environment} single host: HTTPS from CloudFront only, HTTP for ACME only"
  vpc_id      = var.network.vpc_id
  tags        = merge(local.tags, { Name = local.name })
}

resource "aws_vpc_security_group_ingress_rule" "https_from_cloudfront" {
  security_group_id = aws_security_group.host.id
  description       = "HTTPS from CloudFront origin-facing servers only"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  prefix_list_id    = data.aws_ec2_managed_prefix_list.cloudfront_origin_facing.id
}

resource "aws_vpc_security_group_ingress_rule" "acme_http01" {
  security_group_id = aws_security_group.host.id
  # STEP 9 ACME HOTFIX: an EC2 security-group rule description accepts only a-z A-Z 0-9 space and ._-:/()#,@[]+=&;{}!$*
  # -- the former "Let's Encrypt ..." apostrophe was refused by AWS at apply (InvalidParameterValue), the only resource of
  # step 9 that failed. Pinned by cost1SingleHost.test.ts; host-create-complete judges the same character set.
  description       = "ACME HTTP-01 only - Caddy challenge or 404 on port 80"
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_ingress_rule" "emergency_ssh" {
  for_each          = toset(var.emergency_ssh_cidrs)
  security_group_id = aws_security_group.host.id
  description       = "EMERGENCY EC2 Instance Connect only; remove after use"
  ip_protocol       = "tcp"
  from_port         = 22
  to_port           = 22
  cidr_ipv4         = each.value
}

resource "aws_vpc_security_group_egress_rule" "https" {
  for_each          = toset([for port in distinct(concat([443], var.network.juno_egress_ports)) : tostring(port)])
  security_group_id = aws_security_group.host.id
  description       = "AWS public endpoints, Juno REST endpoints, ACME, package repositories"
  ip_protocol       = "tcp"
  from_port         = tonumber(each.key)
  to_port           = tonumber(each.key)
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_network_interface" "host" {
  subnet_id         = var.network.subnet_id
  security_groups   = [aws_security_group.host.id]
  source_dest_check = true
  description       = "18Cosmos ${var.environment} single host (survives host replacement)"
  tags              = merge(local.tags, { Name = local.name })
}

resource "aws_eip" "host" {
  domain = "vpc"
  tags   = merge(local.tags, { Name = local.name })
}

resource "aws_eip_association" "host" {
  allocation_id        = aws_eip.host.id
  network_interface_id = aws_network_interface.host.id
}
