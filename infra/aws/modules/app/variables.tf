# LIVE-5 L5-8: the app account's inputs. Names follow L5-7 §14 exactly: gs-<environment>-game-g<generation>,
# gs-<environment>-identity, gs-<environment>-ledger (the ledger stack's), roles gs-<environment>-app-task /
# gs-<environment>-bootstrap (the ledger stack grants those two by name).

variable "environment" {
  description = "The runtime document's `environment` label (^[a-z][a-z0-9-]{0,31}$)."
  type        = string
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{0,31}$", var.environment))
    error_message = "environment must match ^[a-z][a-z0-9-]{0,31}$ (the runtime document's rule)."
  }
}

variable "generation" {
  description = <<-EOT
    The adopted app generation (the runtime document's `generation`; the ledger's APPGEN must equal it; the game table is
    gs-<env>-game-g<generation>). Changing it is NOT a deploy: the game table would be replaced, which prevent_destroy and
    deletion protection refuse. Adopting a new generation after a restore is L6-4's.
  EOT
  type        = number
  validation {
    condition     = var.generation >= 1 && floor(var.generation) == var.generation
    error_message = "generation must be a positive whole number."
  }
}

variable "ledger_table_arn" {
  description = "The ledger stack's output: arn:aws:dynamodb:<region>:<ledger account>:table/gs-<environment>-ledger."
  type        = string
  validation {
    condition     = can(regex("^arn:aws:dynamodb:[a-z]{2}(-[a-z]+)+-[0-9]{1,2}:[0-9]{12}:table/gs-${var.environment}-ledger$", var.ledger_table_arn))
    error_message = "ledger_table_arn must be the full table ARN of gs-<environment>-ledger in the aws partition."
  }
}

variable "signing_keys" {
  description = "The ledger stack's signing_key_arns (key ARNs, never aliases), or null while escrow is off."
  type = object({
    relayer    = string
    settlement = string
    admission  = string
  })
  default = null
  validation {
    condition = var.signing_keys == null ? true : alltrue([
      for arn in values(var.signing_keys) : can(regex("^arn:aws:kms:[a-z]{2}(-[a-z]+)+-[0-9]{1,2}:[0-9]{12}:key/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|mrk-[0-9a-f]{32})$", arn))
    ])
    error_message = "Every signing key must be a KMS KEY ARN (arn:aws:kms:<region>:<account>:key/<id>); an alias is refused."
  }
  validation {
    condition     = var.signing_keys == null ? true : length(distinct(values(var.signing_keys))) == 3 && length(distinct([for arn in values(var.signing_keys) : split(":", arn)[3]])) == 1
    error_message = "The three signing keys must be three different keys in ONE region (the Juno configuration's KMS region)."
  }
}

variable "escrow" {
  description = <<-EOT
    null: no escrow (the runtime document's `escrow` is null; money games stay off). Otherwise the NON-SECRET fields of the
    Juno configuration `18COSMOS/JUNO-BACKEND/v3`, exactly as `parseJunoBackendConfig` names them; this module adds only
    `format`, `journal` ({kind: dynamodb, table_arn: ledger_table_arn}) and each signer ({kind: kms, key_ref: <key ARN>}).
    Optional fields left null are OMITTED (the parser's defaults apply). The public keys and the relayer address come from
    `npm run awsDeploy -- signer-keys` (derived from the KMS keys exactly as the server derives them).
  EOT
  type = object({
    chain_id         = string
    network_class    = string
    rest_endpoints   = list(string)
    contract_address = string
    code_checksum    = string
    wasm_admin       = string # null: an immutable contract (the key is still written, as the parser requires)
    denom            = string
    asset_symbol     = string
    relayer_address  = string
    settlement_key = object({
      signer_key_id  = number
      public_key_hex = string
    })
    admission_key = object({
      public_key_hex = string
      ttl_secs       = optional(number)
    })
    trust = object({
      operators                 = list(string)
      resolvers                 = list(string)
      min_challenge_window_secs = string
      min_liveness_window_secs  = string
      min_resolver_timeout_secs = string
    })
    gas = optional(object({
      multiplier = optional(string)
      gas_price  = optional(string)
      min_gas    = optional(string)
      max_gas    = optional(string)
      max_fee    = optional(string)
    }))
    timeout_blocks     = optional(number)
    request_timeout_ms = optional(number)
  })
  default = null
  validation {
    condition     = var.escrow == null ? true : contains(["mainnet", "testnet", "local"], var.escrow.network_class)
    error_message = "escrow.network_class must be mainnet, testnet or local."
  }
  validation {
    condition     = var.escrow == null ? true : alltrue([for url in var.escrow.rest_endpoints : startswith(url, "https://")])
    error_message = "escrow.rest_endpoints must be https (allow_insecure_local_http is refused in production and is never written)."
  }
}

variable "money_tables_nonmainnet" {
  description = "Sets ESCROW_MONEY_TABLES=nonmainnet (staging on a NON-mainnet chain only). Never for mainnet."
  type        = bool
  default     = false
  validation {
    condition     = !var.money_tables_nonmainnet || (var.escrow != null && try(var.escrow.network_class, "") != "mainnet")
    error_message = "money_tables_nonmainnet needs escrow on a non-mainnet chain."
  }
}

variable "network" {
  description = <<-EOT
    The existing VPC (this slice does not design networks).
      vpc_id                      the VPC.
      task_subnet_ids             PRIVATE subnets for the tasks (no public IP is ever assigned).
      alb_subnet_ids              public subnets for the internet-facing ALB (CloudFront's origin).
      private_route_table_ids     route tables of the task subnets (the DynamoDB and S3 gateway endpoints).
      create_interface_endpoints  KMS, SSM, CloudWatch Logs, ECR API/DKR interface endpoints (private DNS).
      juno_egress_ports           TCP ports of the Juno REST endpoints (public egress; https).
  EOT
  type = object({
    vpc_id                     = string
    task_subnet_ids            = list(string)
    alb_subnet_ids             = list(string)
    private_route_table_ids    = optional(list(string), [])
    create_interface_endpoints = optional(bool, true)
    juno_egress_ports          = optional(list(number), [443])
  })
  validation {
    condition     = length(var.network.task_subnet_ids) >= 1 && length(var.network.alb_subnet_ids) >= 2
    error_message = "At least one task subnet and two ALB subnets (an ALB spans two Availability Zones)."
  }
}

variable "build_id" {
  description = "The image tag in this stack's ECR repository, and the task's BUILD_ID (L5-7 §14: BUILD_ID=<image tag>)."
  type        = string
  validation {
    condition     = can(regex("^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$", var.build_id))
    error_message = "build_id must be a valid image tag ([A-Za-z0-9][A-Za-z0-9._-]{0,127})."
  }
}

variable "container_port" {
  description = "PORT: the server listens on 0.0.0.0:<port> in AWS mode; only the ALB's security group reaches it."
  type        = number
  default     = 8917
}

variable "allowed_origins" {
  description = "GS_ALLOWED_ORIGINS: the exact https origin(s) the game is served from."
  type        = list(string)
  validation {
    condition     = length(var.allowed_origins) >= 1 && alltrue([for o in var.allowed_origins : can(regex("^https://[^/]+$", o))])
    error_message = "allowed_origins must be https origins without a path."
  }
}

variable "trusted_proxy_hops" {
  description = "GS_TRUSTED_PROXY_HOPS: CloudFront + ALB = 2 (verify with a header capture in staging)."
  type        = number
  default     = 2
}

variable "pools" {
  description = <<-EOT
    One ECS service (one task) per pool. Exactly one pool is `primary`: the ALB target group is its alone, and the
    bootstrap names it in SYSTEM/ROUTING. A non-primary pool is a STANDBY (L5-7 §4): it holds its pool, serves nobody and
    answers /gs/readyz 503 not-primary, so it is never behind the ALB (its health check would never pass) -- LIVE-6 adds
    the IdentityVerifier, routing flips and promotion. `desired_count` is 0 or 1: two tasks of one pool fence each other.
  EOT
  type = map(object({
    primary       = bool
    desired_count = optional(number, 1)
    cpu           = optional(number, 1024)
    memory        = optional(number, 2048)
  }))
  default = { p1 = { primary = true } }
  validation {
    condition     = length([for id, pool in var.pools : id if pool.primary]) == 1
    error_message = "Exactly one pool must be primary."
  }
  validation {
    condition     = alltrue([for id, pool in var.pools : can(regex("^[a-z][a-z0-9-]{0,15}$", id))])
    error_message = "Pool ids must match ^[a-z][a-z0-9-]{0,15}$ (a pool id the runtime accepts, never an operator run)."
  }
  validation {
    condition     = alltrue([for id, pool in var.pools : contains([0, 1], pool.desired_count)])
    error_message = "desired_count is 0 or 1 per pool (two tasks of one pool fence each other)."
  }
}

variable "start_services" {
  description = <<-EOT
    false (the first apply): everything except the ECS services. Run the bootstrap (APPGEN + SYSTEM/ROUTING) and verify,
    then apply with true. With true, the plan itself reads SYSTEM/ROUTING and refuses to create the services unless it
    names the primary pool.
  EOT
  type        = bool
  default     = false
}

variable "health_check_grace_period_seconds" {
  description = "How long ECS ignores the ALB's /gs/readyz verdict after a task starts: identity load + discovery + the first money sweep."
  type        = number
  default     = 300
  validation {
    condition     = var.health_check_grace_period_seconds >= 120 && var.health_check_grace_period_seconds <= 3600
    error_message = "health_check_grace_period_seconds must be 120..3600 (L5-7 §14: at least 120)."
  }
}

variable "alb" {
  description = "The internet-facing ALB CloudFront reaches (HTTPS only; its certificate covers edge.alb_origin_domain_name)."
  type = object({
    certificate_arn              = string
    idle_timeout_seconds         = optional(number, 300)
    deregistration_delay_seconds = optional(number, 15)
    deletion_protection          = optional(bool, true)
  })
  validation {
    condition     = var.alb.idle_timeout_seconds >= 120 && var.alb.idle_timeout_seconds <= 4000
    error_message = "alb.idle_timeout_seconds must be >= 120 (WebSockets; L5-7 §14)."
  }
}

variable "edge" {
  description = <<-EOT
    The CloudFront edge. Its /gs* behaviour ALWAYS forwards every query string unchanged (cp, cr, cb and any later protocol
    field), all cookies and Origin (plus the WebSocket handshake headers), with caching disabled. The policies are always
    created; the distribution only when create_distribution (otherwise attach the output policy ids to an existing one's
    /gs* behaviour -- `awsDeploy verify` checks whichever distribution serves the site).
  EOT
  type = object({
    create_distribution     = optional(bool, false)
    aliases                 = optional(list(string), [])
    viewer_certificate_arn  = optional(string) # ACM in us-east-1
    site_origin_domain_name = optional(string) # the static site's origin (default behaviour)
    alb_origin_domain_name  = optional(string) # a DNS name for the ALB that its certificate covers
    price_class             = optional(string, "PriceClass_100")
    origin_read_timeout     = optional(number, 60)
  })
  default = {}
  validation {
    condition     = !var.edge.create_distribution || (var.edge.viewer_certificate_arn != null && var.edge.site_origin_domain_name != null && var.edge.alb_origin_domain_name != null && length(var.edge.aliases) >= 1)
    error_message = "create_distribution needs aliases, viewer_certificate_arn, site_origin_domain_name and alb_origin_domain_name."
  }
}

variable "log_retention_days" {
  description = "CloudWatch Logs retention for the task logs (the AUDIT lines live there)."
  type        = number
  default     = 365
}

variable "bootstrap_trusted_principal_arns" {
  description = "Who may assume gs-<env>-bootstrap (the pipeline's / operators' roles). The task role never can."
  type        = list(string)
  validation {
    condition     = length(var.bootstrap_trusted_principal_arns) >= 1
    error_message = "Name at least one principal that runs the bootstrap and the verifier."
  }
}

variable "tags" {
  description = "Tags on every resource."
  type        = map(string)
  default     = {}
}
