# ==================================================================
#  COST-1: THE ONE APPLICATION HOST
# ==================================================================
#
# STATELESS: the host keeps no application data (the server runs in AWS storage mode -- DynamoDB, the ledger, KMS, SSM),
# so losing it loses nothing but availability, and REPLACING it (a new AMI, new cloud-init) is the host-level deploy:
#   1. turn termination_protection off, 2. apply: the old instance is DESTROYED before the new one is created (it holds the
#   ENI the new one needs), 3. turn it back on. The new host boots with the same Elastic IP and starts nothing until the
#   operator deploys an image onto it (gs-deploy); its first process then takes the pool, fencing any straggler.
#
# HARDENING
#   IMDSv2 only (http_tokens required); hop limit 2 so the game-server CONTAINER (Docker bridge network) can reach the
#     instance role's credentials -- Caddy (host network, its own uid) is rejected by gs-imds-guard;
#   CPU credits STANDARD (burstable: never billed for surplus -- the default "unlimited" can cost more than the host);
#   detailed monitoring off; root volume gp3, encrypted, deleted with the instance (it holds nothing);
#   simplified automatic recovery on (a host-hardware failure restarts the instance on new hardware, same ENI/EIP);
#   termination protection on by default; no key pair (no SSH key exists at all).

resource "aws_instance" "host" {
  ami                  = var.instance.ami_id
  instance_type        = var.instance.type
  iam_instance_profile = aws_iam_instance_profile.host.name
  monitoring           = false
  user_data_base64     = base64gzip(local.user_data)
  # Host configuration is cattle: a changed cloud-init REPLACES the host (destroy first: it holds the ENI).
  user_data_replace_on_change = true
  disable_api_termination     = var.termination_protection

  primary_network_interface {
    network_interface_id = aws_network_interface.host.id
  }

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 2
    http_protocol_ipv6          = "disabled" # the IMDS guard (iptables) is IPv4; keep IMDS IPv4-only
    instance_metadata_tags      = "disabled"
  }

  credit_specification {
    cpu_credits = "standard"
  }

  maintenance_options {
    auto_recovery = "default"
  }

  root_block_device {
    volume_type           = "gp3"
    volume_size           = var.instance.root_volume_gb
    encrypted             = true
    delete_on_termination = true
    tags                  = merge(local.tags, { Name = local.name })
  }

  tags = merge(local.tags, { Name = local.name, "gs:pool" = var.pool, "gs:arch" = local.arch })

  # The Elastic IP must be on the ENI before the first boot: cloud-init installs packages and the host's preflight
  # compares IMDS's public address with the expected one.
  depends_on = [aws_eip_association.host, aws_iam_role_policy.host]

  lifecycle {
    precondition {
      # EC2's 16 KiB limit applies to the user data's bytes before base64 -- here, the gzip stream cloud-init unpacks.
      condition     = ceil(length(base64gzip(local.user_data)) * 3 / 4) <= 16384
      error_message = "The host's compressed cloud-init exceeds EC2's 16 KiB user-data limit."
    }
  }
}
