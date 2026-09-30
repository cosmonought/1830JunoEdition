# ==================================================================
#  LIVE-5 L5-8: NAMES, ARNs AND THE TWO SSM DOCUMENTS -- RENDERED EXACTLY AS L5-7's PARSERS READ THEM
# ==================================================================
#
# Every ARN the documents or the policies carry is BUILT from the account, the region and the naming convention, never
# read back from a resource: the documents are then plan-time values (reviewable in the plan, and the same bytes in the
# plan-only tests), and a name that drifted from the convention is a validation error, not a silent new reference.

data "aws_partition" "current" {}
data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

locals {
  partition = data.aws_partition.current.partition
  account   = data.aws_caller_identity.current.account_id
  region    = data.aws_region.current.region
  prefix    = "gs-${var.environment}"

  game_table_name     = "${local.prefix}-game-g${var.generation}"
  identity_table_name = "${local.prefix}-identity"
  game_table_arn      = "arn:${local.partition}:dynamodb:${local.region}:${local.account}:table/${local.game_table_name}"
  identity_table_arn  = "arn:${local.partition}:dynamodb:${local.region}:${local.account}:table/${local.identity_table_name}"

  task_role_name      = "${local.prefix}-app-task"
  execution_role_name = "${local.prefix}-app-execution"
  bootstrap_role_name = "${local.prefix}-bootstrap"

  primary_pool = one([for id, pool in var.pools : id if pool.primary])

  # SSM parameter names and ARNs (`parameter` + the name, whose leading slash is the ARN's separator).
  runtime_parameter_name = { for id, _ in var.pools : id => "/gs/${var.environment}/runtime/${id}" }
  runtime_parameter_arn  = { for id, name in local.runtime_parameter_name : id => "arn:${local.partition}:ssm:${local.region}:${local.account}:parameter${name}" }
  juno_parameter_name    = "/gs/${var.environment}/juno-backend"
  juno_parameter_arn     = "arn:${local.partition}:ssm:${local.region}:${local.account}:parameter${local.juno_parameter_name}"

  escrow_enabled = var.escrow != null

  # 18COSMOS/AWS-RUNTIME/v1 -- every field of `runtimeConfig.ts`, nothing else (the parser refuses unknown fields).
  runtime_document = {
    for id, _ in var.pools : id => jsonencode({
      format           = "18COSMOS/AWS-RUNTIME/v1"
      environment      = var.environment
      region           = local.region
      pool             = id
      generation       = var.generation
      game_table       = local.game_table_name
      identity_table   = local.identity_table_name
      ledger_table_arn = var.ledger_table_arn
      escrow           = local.escrow_enabled ? { config_parameter_arn = local.juno_parameter_arn } : null
    })
  }

  # 18COSMOS/JUNO-BACKEND/v3 -- `junoConfig.ts`'s fields. Optional fields the operator left null are OMITTED (a JSON null
  # is not "absent" to the parser). allow_insecure_local_http and dev_signer are never written (production refuses both).
  juno_gas = local.escrow_enabled ? { for k, v in coalesce(var.escrow.gas, {}) : k => v if v != null } : {}
  juno_document = local.escrow_enabled ? jsonencode(merge(
    {
      format           = "18COSMOS/JUNO-BACKEND/v3"
      chain_id         = var.escrow.chain_id
      network_class    = var.escrow.network_class
      rest_endpoints   = var.escrow.rest_endpoints
      contract_address = var.escrow.contract_address
      code_checksum    = var.escrow.code_checksum
      wasm_admin       = var.escrow.wasm_admin
      denom            = var.escrow.denom
      asset_symbol     = var.escrow.asset_symbol
      relayer = {
        address = var.escrow.relayer_address
        signer  = { kind = "kms", key_ref = try(var.signing_keys.relayer, null) }
      }
      settlement_key = {
        signer_key_id  = var.escrow.settlement_key.signer_key_id
        public_key_hex = var.escrow.settlement_key.public_key_hex
        signer         = { kind = "kms", key_ref = try(var.signing_keys.settlement, null) }
      }
      admission_key = merge(
        {
          public_key_hex = var.escrow.admission_key.public_key_hex
          signer         = { kind = "kms", key_ref = try(var.signing_keys.admission, null) }
        },
        var.escrow.admission_key.ttl_secs == null ? {} : { ttl_secs = var.escrow.admission_key.ttl_secs },
      )
      trust   = var.escrow.trust
      journal = { kind = "dynamodb", table_arn = var.ledger_table_arn }
    },
    length(local.juno_gas) == 0 ? {} : { gas = local.juno_gas },
    var.escrow.timeout_blocks == null ? {} : { timeout_blocks = var.escrow.timeout_blocks },
    var.escrow.request_timeout_ms == null ? {} : { request_timeout_ms = var.escrow.request_timeout_ms },
  )) : null

  # The container's environment: EXACTLY L5-7 §14's names. References only -- no secret, no credential, no data directory.
  container_environment = {
    for id, _ in var.pools : id => concat(
      [
        { name = "GS_MODE", value = "production" },
        { name = "GS_STORAGE", value = "aws" },
        { name = "GS_AWS_CONFIG_PARAMETER", value = local.runtime_parameter_arn[id] },
        { name = "BUILD_ID", value = var.build_id },
        { name = "PORT", value = tostring(var.container_port) },
        { name = "GS_ALLOWED_ORIGINS", value = join(",", var.allowed_origins) },
        { name = "GS_TRUSTED_PROXY_HOPS", value = tostring(var.trusted_proxy_hops) },
      ],
      var.money_tables_nonmainnet ? [{ name = "ESCROW_MONEY_TABLES", value = "nonmainnet" }] : [],
      var.edge_diagnostic_staging ? [{ name = "GS_EDGE_DIAGNOSTIC", value = "staging" }] : [],
    )
  }

  # The container health check: GET /gs/healthz on the loopback (the image carries node, not curl).
  healthz_command = [
    "CMD",
    "node",
    "-e",
    "require('http').get('http://127.0.0.1:'+process.env.PORT+'/gs/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1)).setTimeout(4000,function(){this.destroy();process.exit(1)})",
  ]

  tags = merge(var.tags, { "gs:environment" = var.environment, "gs:slice" = "live5-l5-8" })
}
