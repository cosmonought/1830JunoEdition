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
    The SERVING app generation: the runtime documents' `generation` and `game_table` (gs-<env>-game-g<generation>). The
    ledger's APPGEN must equal it, the table's SYSTEM/GENERATION must name it, and (after a restore) APPGEN's adoption must
    bind that table (L6-4 §5) -- every task refuses to start otherwise. Moving it N -> N+1 is the GENERATION SWITCH
    (LIVE-6 L6-2, infra/aws/README.md "Generation switch"): ONLY after `npm run recovery -- appgen-adopt` answered
    `committed` or `already-adopted` for exactly (N+1, gs-<env>-game-g<N+1>, restore) AND `npm run awsDeploy --
    generation-gate` passed. Moving it never destroys a table: the tables are `game_generations`.
  EOT
  type        = number
  validation {
    condition     = var.generation >= 1 && floor(var.generation) == var.generation
    error_message = "generation must be a positive whole number."
  }
}

variable "game_generations" {
  description = <<-EOT
    LIVE-6 L6-2 (L6-4 §12.1 item 2): EVERY game-table generation this stack manages, side by side -- gs-<env>-game-g<N> for
    each N. It must contain `generation` (the serving one). A restored g<N+1> is created OUTSIDE Terraform by
    RestoreTableToPointInTime, then added here and brought under management with an `import` block in the ROOT stack
    (stacks/app, "Generation switch"); this module then re-enables PITR and deletion protection on it (a restore carries
    neither). The old g<N> stays in this set -- protected (prevent_destroy, deletion protection) and still granted to the
    task role -- until it is explicitly RETIRED (removed from the set, with prevent_destroy lifted deliberately in a
    separate, reviewed change). Empty: just `generation`.
  EOT
  type        = set(number)
  default     = []
  validation {
    condition     = alltrue([for g in var.game_generations : g >= 1 && floor(g) == g])
    error_message = "game_generations holds positive whole numbers."
  }
}

variable "generation_adoption" {
  description = <<-EOT
    LIVE-6 L6-2: when the serving table is a RESTORE (its SYSTEM/GENERATION says origin "restore"), the adoption the
    `generation-gate` printed -- { generation, game_table, restore_id } -- and it must equal the table's marker, or the plan
    refuses to start or re-deploy any service. The ledger (another account) is not readable from this stack, so this is
    the gate's attestation carried into the plan; the tasks re-check the real adoption before they take their pools.
    null for a bootstrap table.
  EOT
  type = object({
    generation = number
    game_table = string
    restore_id = string
  })
  default = null
}

variable "identity_layout_version" {
  description = <<-EOT
    LIVE-6 L6-2 (L6-4 §12.3, the ONE-WAY identity-table layout): the identity layout the image at `build_id` reads. Once any
    L6-4-aware task has served against the identity table, an image that cannot read its `TABLE#identity` item must never
    run against it again -- not by a deploy and not by an ECS circuit-breaker rollback. Every task definition carries it as
    the tag gs:identity-layout; `awsDeploy verify` fails if any ACTIVE revision of a pool's family (a rollback target) does
    not. 2 = L6-4 and later. The FIRST AWS-mode deployment is already L6-4-aware, so no older revision ever exists.
  EOT
  type        = number
  default     = 2
  validation {
    condition     = var.identity_layout_version >= 2 && floor(var.identity_layout_version) == var.identity_layout_version
    error_message = "identity_layout_version must be >= 2: an image older than L6-4's identity layout never runs in AWS mode (L6-4 §12.3)."
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

variable "edge_diagnostic_staging" {
  description = "LIVE-6 L6-6: sets GS_EDGE_DIAGNOSTIC=staging, mounting /gs/diag/edge (a hashed mirror of each request) for the staging certification's edge probe. Never with a mainnet escrow, never in a prod* environment."
  type        = bool
  default     = false
  validation {
    condition     = !var.edge_diagnostic_staging || ((var.escrow == null || try(var.escrow.network_class, "") != "mainnet") && !startswith(var.environment, "prod"))
    error_message = "edge_diagnostic_staging is the staging certification's probe: refused with a mainnet escrow or in a prod* environment."
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
    One ECS service (one task), one target group and one exact-path ALB rule per pool. Exactly one pool is `primary`: the
    `/gs*` default rule forwards to ITS target group, and it is the pool SYSTEM/ROUTING names (the plan refuses the
    services otherwise). A non-primary pool's task is a ROUTER (LIVE-6 L6-1: /gs/readyz 200 `non-primary`, answers a
    game with a route frame) and is a healthy target of its own target group, reached at its trusted ws_path
    `/gs/p/<pool>` (the runtime document v2's `routes`). `desired_count` is 0 or 1: two tasks of one pool fence each other;
    0 is a drained (or retired, L6-2) pool -- never the primary. `bundle_path` (optional): the page path of the release
    whose bundle plays this pool's games (a route frame's bundle destination).
    A FLIP (L6-2) moves `primary` only AFTER `gamesDoctor aws flip` moved SYSTEM/ROUTING: it changes the /gs* rule's
    target and nothing of any service (no task is replaced by it).
  EOT
  type = map(object({
    primary       = bool
    desired_count = optional(number, 1)
    cpu           = optional(number, 1024)
    memory        = optional(number, 2048)
    bundle_path   = optional(string)
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
  validation {
    condition     = alltrue([for id, pool in var.pools : !pool.primary || pool.desired_count == 1])
    error_message = "The primary pool runs its one task (desired_count 1): a drained or retired pool is never the primary."
  }
  validation {
    condition     = length(var.pools) <= 32
    error_message = "At most 32 pools (the runtime's route table limit, MAX_ROUTE_ENTRIES)."
  }
  validation {
    condition     = alltrue([for id, pool in var.pools : pool.bundle_path == null ? true : can(regex("^/[A-Za-z0-9._~-]+(/[A-Za-z0-9._~-]+)*/?$", pool.bundle_path)) && !startswith(pool.bundle_path, "/gs")])
    error_message = "bundle_path is a plain absolute page path (never under /gs, never a host)."
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

variable "operator_trusted_principal_arns" {
  description = <<-EOT
    LIVE-6 L6-2 (L6-3 §11 item 4): who may assume gs-<env>-operator -- the `gamesDoctor aws` role (inspection, the routing
    CAS / flip, an operator run's claim / take / release, the flip's recovery pass, retirement checks, the orphans report).
    Empty: the role is not created. Never the task role.
  EOT
  type        = list(string)
  default     = []
}

variable "recovery_trusted_principal_arns" {
  description = <<-EOT
    LIVE-6 L6-2 (L6-4 §12.1 item 3): who may assume gs-<env>-recovery -- `npm run recovery` (APPGEN adoption, a restored
    table's preparation, the identity replay). Empty: the role is not created. Serving tasks never hold this authority.
  EOT
  type        = list(string)
  default     = []
}

variable "recovery_break_glass" {
  description = "LIVE-6 L6-2 (L6-4 §12.1 item 3): grant gs-<env>-recovery dynamodb:RestoreTableToPointInTime (a break-glass step: turn it on for the restore, off after)."
  type        = bool
  default     = false
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

variable "page_alarm_action_arns" {
  description = <<-EOT
    LIVE-6 L6-5B: where a PAGE alarm (alarm-contract.json `class` page) sends its ALARM and OK notifications -- ARNs of
    compatible CloudWatch alarm actions (an SNS topic, a Lambda function, an Incident Manager response plan, an OpsItem).
    Created elsewhere (this module creates no SNS topic or paging destination). May be EMPTY in staging: the alarms still
    evaluate, and `awsDeploy verify` still checks that every page alarm is wired to exactly this list.
  EOT
  type        = list(string)
  default     = []
  validation {
    condition     = alltrue([for arn in var.page_alarm_action_arns : can(regex("^arn:aws:(sns|lambda|ssm-incidents|ssm):[a-z0-9-]*:[0-9]{12}:.+$", arn))])
    error_message = "page_alarm_action_arns holds CloudWatch alarm action ARNs (sns, lambda, ssm-incidents or ssm) in the aws partition."
  }
}

variable "ticket_alarm_action_arns" {
  description = "LIVE-6 L6-5B: where a TICKET alarm sends its notifications (as page_alarm_action_arns; may be empty in staging). Never the same ARN as a page action: the two classes stay distinguishable."
  type        = list(string)
  default     = []
  validation {
    condition     = alltrue([for arn in var.ticket_alarm_action_arns : can(regex("^arn:aws:(sns|lambda|ssm-incidents|ssm):[a-z0-9-]*:[0-9]{12}:.+$", arn))])
    error_message = "ticket_alarm_action_arns holds CloudWatch alarm action ARNs (sns, lambda, ssm-incidents or ssm) in the aws partition."
  }
  validation {
    condition     = length(setintersection(toset(var.ticket_alarm_action_arns), toset(var.page_alarm_action_arns))) == 0
    error_message = "An action ARN is either a page destination or a ticket destination, never both (the classes must stay distinguishable)."
  }
}
