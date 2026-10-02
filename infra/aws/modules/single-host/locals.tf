# ==================================================================
#  COST-1: NAMES, ARNs AND THE HOST'S FILES
# ==================================================================
#
# Every ARN is BUILT from the account, the region and the LIVE-5 naming convention (as stacks/app builds them), never read
# back from another stack's resources: the host refers to the existing authorities, it never owns them.

data "aws_partition" "current" {}
data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

locals {
  partition = data.aws_partition.current.partition
  account   = data.aws_caller_identity.current.account_id
  region    = data.aws_region.current.region
  prefix    = "gs-${var.environment}"
  name      = "${local.prefix}-host"

  # The architecture follows the instance type: Graviton (t4g) is linux/arm64, t3 is linux/amd64.
  arch = startswith(var.instance.type, "t4g.") ? "arm64" : "amd64"

  game_generations   = toset([for g in setunion(var.game_generations, [var.generation]) : tostring(g)])
  game_table_arns    = sort([for g in local.game_generations : "arn:${local.partition}:dynamodb:${local.region}:${local.account}:table/${local.prefix}-game-g${g}"])
  identity_table_arn = "arn:${local.partition}:dynamodb:${local.region}:${local.account}:table/${local.prefix}-identity"

  runtime_parameter_arn = "arn:${local.partition}:ssm:${local.region}:${local.account}:parameter/gs/${var.environment}/runtime/${var.pool}"
  juno_parameter_arn    = "arn:${local.partition}:ssm:${local.region}:${local.account}:parameter/gs/${var.environment}/juno-backend"

  ecr_repository_name = coalesce(var.ecr_repository_name, "${local.prefix}-server")
  ecr_repository_arn  = "arn:${local.partition}:ecr:${local.region}:${local.account}:repository/${local.ecr_repository_name}"
  ecr_registry        = "${local.account}.dkr.ecr.${local.region}.amazonaws.com"

  log_group_name = "/gs/${var.environment}/host"
  log_group_arn  = "arn:${local.partition}:logs:${local.region}:${local.account}:log-group:${local.log_group_name}"

  # The app role's name. stacks/ledger authorises it by ARN (`app_runtime_role_arns`), beside or instead of the ECS task role.
  role_name = "${local.prefix}-host-app"

  # The host's CloudWatch namespace for its own (rare) pressure datapoints; the game server's is 18Cosmos/GameServer.
  host_metric_namespace = "18Cosmos/Host"
  app_metric_namespace  = "18Cosmos/GameServer"

  # Caddy's unprivileged uid on the host (Caddy uses host networking; gs-imds-guard rejects this uid's IMDS traffic).
  caddy_uid = 2001

  tags = merge(var.tags, { "gs:environment" = var.environment, "gs:component" = "single-host", "gs:slice" = "cost-1" })

  # ---- the host's files (cloud-init write_files). Scripts are read verbatim (never templated); the whole user data is gzipped once. ----
  host_env = templatefile("${path.module}/templates/host.env.tftpl", {
    environment           = var.environment
    region                = local.region
    arch                  = local.arch
    ecr_registry          = local.ecr_registry
    ecr_repository        = local.ecr_repository_name
    log_group             = local.log_group_name
    expected_public_ip    = aws_eip.host.public_ip
    origin_hostname       = var.origin_hostname
    caddy_image           = var.caddy_image
    caddy_uid             = local.caddy_uid
    server_memory         = var.instance.server_memory
    container_port        = var.container_port
    host_metric_namespace = local.host_metric_namespace
  })
  # The server's environment: REFERENCES ONLY (L5-7 §14) -- no secret, no credential, no data directory. BUILD_ID comes
  # from the release file the deploy writes. The runtime refuses static AWS keys, DATA_DIR and ESCROW_JUNO_CONFIG anyway.
  server_env = templatefile("${path.module}/templates/server.env.tftpl", {
    runtime_parameter_arn = local.runtime_parameter_arn
    container_port        = var.container_port
    allowed_origins       = join(",", var.allowed_origins)
    trusted_proxy_hops    = var.trusted_proxy_hops
    money_tables          = var.money_tables_nonmainnet
    edge_diagnostic       = var.edge_diagnostic_staging
  })
  caddyfile = templatefile("${path.module}/templates/Caddyfile.tftpl", {
    origin_hostname = var.origin_hostname
    acme_email      = var.acme_email
    container_port  = var.container_port
  })

  host_scripts  = ["gs-preflight", "gs-run", "gs-exit-hold", "gs-deploy", "gs-rollback", "gs-stop", "gs-health", "gs-host-sample", "gs-measure-report", "gs-lib.sh"]
  systemd_units = ["gs-server.service", "gs-caddy.service", "gs-imds-guard.service", "gs-host-sample.service", "gs-host-sample.timer"]

  write_files = concat(
    [
      { path = "/etc/gs/host.env", permissions = "0644", content = local.host_env },
      { path = "/etc/gs/server.env", permissions = "0640", content = local.server_env },
      { path = "/etc/gs/Caddyfile", permissions = "0644", content = local.caddyfile },
      { path = "/etc/docker/daemon.json", permissions = "0644", content = file("${path.module}/files/docker/daemon.json") },
      { path = "/root/.docker/config.json", permissions = "0600", content = jsonencode({ credHelpers = { (local.ecr_registry) = "ecr-login" } }) },
      { path = "/opt/gs/measure/gs-measure.cjs", permissions = "0644", content = file("${path.module}/files/measure/gs-measure.cjs") },
    ],
    [for s in local.host_scripts : { path = "/opt/gs/bin/${s}", permissions = "0755", content = file("${path.module}/files/bin/${s}") }],
    [for u in local.systemd_units : { path = "/etc/systemd/system/${u}", permissions = "0644", content = file("${path.module}/files/systemd/${u}") }],
  )

  user_data = templatefile("${path.module}/templates/cloud-init.yaml.tftpl", {
    write_files = local.write_files
    swap_mb     = var.instance.swap_mb
    caddy_uid   = local.caddy_uid
  })
}
