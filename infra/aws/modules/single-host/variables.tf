# ==================================================================
#  COST-1: THE SINGLE-HOST DEPLOYMENT'S INPUTS (docs/hosting-budget.md; infra/aws/COST_BUDGET.json)
# ==================================================================
#
# This module creates ONLY the host and what the host itself needs. Every authority it serves is an EXISTING resource,
# named here by the same conventions the LIVE-5/LIVE-6 stacks use, never created or duplicated:
#   DynamoDB  gs-<env>-game-g<N> (every managed generation), gs-<env>-identity   (stacks/app)
#             the ledger table, by ARN                                          (stacks/ledger, the ledger account)
#   KMS       the relayer / settlement / admission keys, by key ARN              (stacks/ledger)
#   SSM       /gs/<env>/runtime/<pool> and /gs/<env>/juno-backend                (stacks/app)
#   ECR       gs-<env>-server                                                     (stacks/app)
#   CloudFront the existing distribution; its /gs* origin is pointed at `origin_hostname` (stacks/app `edge`)

variable "environment" {
  description = "The environment label (the runtime document's `environment`; resources are named gs-<environment>-...)."
  type        = string
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{0,15}$", var.environment))
    error_message = "environment must match ^[a-z][a-z0-9-]{0,15}$ (the LIVE-5 naming convention)."
  }
}

variable "pool" {
  description = "The ONE pool this host serves (its runtime document is /gs/<environment>/runtime/<pool>). The single host keeps the certified pool-writer fence: a second process or host taking this pool fences the first."
  type        = string
  default     = "p1"
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{0,15}$", var.pool))
    error_message = "pool must be a pool id the runtime accepts (^[a-z][a-z0-9-]{0,15}$), never an operator run."
  }
}

variable "generation" {
  description = "The SERVING game-table generation (gs-<environment>-game-g<generation>), as in stacks/app."
  type        = number
  validation {
    condition     = var.generation >= 1 && floor(var.generation) == var.generation
    error_message = "generation must be a positive whole number."
  }
}

variable "game_generations" {
  description = "Every MANAGED game-table generation the app role may reach (stacks/app `game_generations`): a restore's g<N+1> is listed before the host restarts onto it."
  type        = set(number)
  default     = []
}

variable "ledger_table_arn" {
  description = "The ledger table's ARN (stacks/ledger output). Cross-account: the ledger stack must authorise THIS host's role (`app_runtime_role_arns`)."
  type        = string
  validation {
    condition     = can(regex("^arn:aws:dynamodb:[a-z0-9-]+:[0-9]{12}:table/[A-Za-z0-9_.-]+$", var.ledger_table_arn))
    error_message = "ledger_table_arn must be a DynamoDB table ARN in the commercial aws partition."
  }
}

variable "signing_keys" {
  description = "The KMS signing keys the escrow configuration names (relayer, settlement, admission), by key ARN; null without escrow. The host role may GetPublicKey and Sign (ECDSA_SHA_256 over a DIGEST) with exactly these."
  type = object({
    relayer    = string
    settlement = string
    admission  = string
  })
  default = null
  validation {
    condition     = var.signing_keys == null || alltrue([for arn in values(var.signing_keys) : can(regex("^arn:aws:kms:[a-z0-9-]+:[0-9]{12}:key/[0-9a-f-]{36}$", arn))])
    error_message = "signing_keys must be KMS key ARNs (never aliases)."
  }
  validation {
    condition     = var.signing_keys == null || length(distinct(values(var.signing_keys))) == 3
    error_message = "the relayer, settlement and admission keys must be three distinct keys."
  }
}

variable "escrow_enabled" {
  description = "Whether the runtime document carries escrow (the host role then reads /gs/<environment>/juno-backend)."
  type        = bool
  default     = false
}

variable "network" {
  description = <<-EOT
    The host's network: ONE public subnet (a route to an internet gateway) of an existing VPC. No NAT, no endpoints.
      vpc_id             the VPC
      subnet_id          a public subnet
      juno_egress_ports  TCP ports of the Juno REST endpoints besides 443 (default none)
  EOT
  type = object({
    vpc_id            = string
    subnet_id         = string
    juno_egress_ports = optional(list(number), [])
  })
}

variable "instance" {
  description = <<-EOT
    The ONE application host.
      type            t4g.small (the default and the budget's target: 2 GB, Graviton); t4g.micro only after the memory
                      measurement plan says so; t3.small / t3.micro are the x86 fallback (COST_BUDGET.json allow-list)
      ami_id          an Amazon Linux 2023 AMI of the type's architecture, pinned (a change REPLACES the host)
      root_volume_gb  gp3, encrypted
      swap_mb         a swap file (a safety net for the measurement window, not capacity)
      server_memory   the game-server container's memory limit (docker --memory)
  EOT
  type = object({
    type           = optional(string, "t4g.small")
    ami_id         = string
    root_volume_gb = optional(number, 12)
    swap_mb        = optional(number, 1024)
    server_memory  = optional(string, "1536m")
  })
  validation {
    condition     = contains(["t4g.small", "t4g.micro", "t3.small", "t3.micro"], var.instance.type)
    error_message = "instance.type must be one of the budget's allowed types: t4g.small, t4g.micro, t3.small, t3.micro (infra/aws/COST_BUDGET.json)."
  }
  validation {
    condition     = can(regex("^ami-[0-9a-f]{8,17}$", var.instance.ami_id))
    error_message = "instance.ami_id must be an AMI id (pinned; never resolved at plan time)."
  }
  validation {
    condition     = var.instance.root_volume_gb >= 8 && var.instance.root_volume_gb <= 30
    error_message = "instance.root_volume_gb must be 8..30 (the host keeps no application data)."
  }
  validation {
    condition     = var.instance.swap_mb >= 0 && var.instance.swap_mb <= 4096
    error_message = "instance.swap_mb must be 0..4096."
  }
  validation {
    condition     = can(regex("^[0-9]{3,5}m$", var.instance.server_memory))
    error_message = "instance.server_memory must be a docker memory size in MiB, e.g. 1536m."
  }
}

variable "origin_hostname" {
  description = "The public DNS name CloudFront uses as the /gs* origin (e.g. gs-origin.example.org). It must resolve to this host's Elastic IP (an owner DNS action at migration time); Caddy obtains its certificate for it from Let's Encrypt (HTTP-01 on port 80)."
  type        = string
  validation {
    condition     = can(regex("^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,63}$", var.origin_hostname))
    error_message = "origin_hostname must be a lower-case DNS name."
  }
}

variable "acme_email" {
  description = "Optional contact address for Let's Encrypt expiry notices. Null: none is sent (no address is ever invented)."
  type        = string
  default     = null
  validation {
    condition     = var.acme_email == null || can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.acme_email))
    error_message = "acme_email must be an email address or null."
  }
}

variable "allowed_origins" {
  description = "GS_ALLOWED_ORIGINS: the exact https origins the browser uses (e.g. https://play.example.org)."
  type        = list(string)
  validation {
    condition     = length(var.allowed_origins) >= 1 && alltrue([for o in var.allowed_origins : can(regex("^https://[a-z0-9.-]+(:[0-9]+)?$", o))])
    error_message = "allowed_origins must be exact https origins (no path, no wildcard)."
  }
}

variable "trusted_proxy_hops" {
  description = "GS_TRUSTED_PROXY_HOPS: CloudFront + Caddy = 2 (the same count as CloudFront + ALB, so the edge proof carries over)."
  type        = number
  default     = 2
}

variable "money_tables_nonmainnet" {
  description = "Sets ESCROW_MONEY_TABLES=nonmainnet (money tables on a non-mainnet escrow only; the runtime refuses mainnet)."
  type        = bool
  default     = false
}

variable "edge_diagnostic_staging" {
  description = "LIVE-6 L6-6's staging edge mirror (/gs/diag/edge, GS_EDGE_DIAGNOSTIC=staging) for the edge certification probes through CloudFront. Refused in prod* environments here; the server also refuses it beside a mainnet escrow."
  type        = bool
  default     = false
  validation {
    condition     = !var.edge_diagnostic_staging || !startswith(var.environment, "prod")
    error_message = "edge_diagnostic_staging is a staging probe: refused in a prod* environment."
  }
}

variable "conduct_reviewers" {
  description = "GS_CONDUCT_REVIEWERS: the USERNAMES that may open the conduct-report review panel (player reporting; usernames, no secret). Each must be held by an account when the server starts, or the server refuses to start (fail closed). Empty (the default): reports are received and kept, and nobody can review them; the rendered environment is then byte-identical to a module without this input."
  type        = list(string)
  default     = []
  validation {
    condition     = length(var.conduct_reviewers) <= 32 && alltrue([for name in var.conduct_reviewers : can(regex("^[^\\s,\\p{Cc}\\p{Cf}]{1,64}$", name))])
    error_message = "conduct_reviewers: at most 32 usernames, each 1-64 characters with no whitespace, comma or control character."
  }
}

variable "container_port" {
  description = "The game server's port inside its container; published on the host's LOOPBACK only."
  type        = number
  default     = 8917
}

variable "caddy_image" {
  description = "The Caddy image, pinned by its multi-arch INDEX digest (public.ecr.aws mirror of the official image)."
  type        = string
  default     = "public.ecr.aws/docker/library/caddy:2-alpine@sha256:6aeddd44c3078b0f9a35206472a11420648a79c184603ef95957d0a20044cb2b"
  validation {
    condition     = can(regex("@sha256:[0-9a-f]{64}$", var.caddy_image))
    error_message = "caddy_image must be pinned by digest (@sha256:...)."
  }
}

variable "ecr_repository_name" {
  description = "The EXISTING ECR repository the host pulls from (stacks/app's gs-<environment>-server). Null: that convention."
  type        = string
  default     = null
}

variable "manage_ecr_lifecycle" {
  description = "Attach a lifecycle policy to the existing repository (keep the newest `ecr_keep_images` images; untagged after 7 days). OFF by default: turn it on only once the ECS services are gone (SINGLE_HOST_MIGRATION.md step I) -- while ECS is the rollback path, its circuit-breaker images must not expire."
  type        = bool
  default     = false
}

variable "ecr_keep_images" {
  description = "How many images the ECR lifecycle policy keeps (release history for rollback; ~0.1 GB each)."
  type        = number
  default     = 20
  validation {
    condition     = var.ecr_keep_images >= 5 && var.ecr_keep_images <= 100
    error_message = "ecr_keep_images must be 5..100."
  }
}

variable "log_retention_days" {
  description = "CloudWatch Logs retention of the host's log group (the AUDIT and metric lines). The budget allows at most 90."
  type        = number
  default     = 90
  validation {
    condition     = contains([7, 14, 30, 60, 90], var.log_retention_days)
    error_message = "log_retention_days must be one of 7, 14, 30, 60, 90 (COST_BUDGET.json caps it at 90)."
  }
}

variable "alarm_action_arns" {
  description = "Where the five alarms notify (SNS topics etc., created elsewhere). Empty is valid: the alarms still evaluate."
  type        = list(string)
  default     = []
}

variable "ssm_agent" {
  description = "Grant the SSM agent its minimum (Session Manager and Run Command over the public SSM endpoints; free on EC2). The operator workflow (gs-host.ps1) uses Run Command; there is no SSH."
  type        = bool
  default     = true
}

variable "emergency_ssh_cidrs" {
  description = "EMERGENCY ONLY, default empty (no port 22 at all): at most two /32 operator addresses for EC2 Instance Connect. Remove again after use."
  type        = list(string)
  default     = []
  validation {
    condition     = length(var.emergency_ssh_cidrs) <= 2 && alltrue([for c in var.emergency_ssh_cidrs : can(regex("^([0-9]{1,3}\\.){3}[0-9]{1,3}/32$", c))])
    error_message = "emergency_ssh_cidrs takes at most two single addresses (x.x.x.x/32)."
  }
}

variable "termination_protection" {
  description = "EC2 termination protection: a host replacement is a deliberate two-step change (turn this off, then apply)."
  type        = bool
  default     = true
}

variable "budget" {
  description = <<-EOT
    The account's monthly AWS Budget (COST-1 Part 15). Created only when `enabled` and at least one subscriber is named
    (AWS requires one per notification; no address is ever invented). Thresholds: $15 actual, $20 actual, $25 forecast,
    $25 actual, $30 actual (the hard ceiling).
  EOT
  type = object({
    enabled         = optional(bool, false)
    limit_usd       = optional(number, 30)
    email_addresses = optional(list(string), [])
    sns_topic_arn   = optional(string)
  })
  default = {}
  validation {
    condition     = !var.budget.enabled || length(var.budget.email_addresses) + (var.budget.sns_topic_arn == null ? 0 : 1) >= 1
    error_message = "budget.enabled needs at least one subscriber (email_addresses or sns_topic_arn)."
  }
  validation {
    condition     = length(var.budget.email_addresses) <= 10
    error_message = "AWS Budgets allows at most 10 email subscribers per notification."
  }
  validation {
    condition     = var.budget.limit_usd > 0 && var.budget.limit_usd <= 30
    error_message = "budget.limit_usd must be > 0 and at most the owner's $30 ceiling."
  }
}

variable "tags" {
  description = "Extra tags."
  type        = map(string)
  default     = {}
}
