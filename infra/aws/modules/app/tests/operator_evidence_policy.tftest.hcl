# JX-4C: the operator role's evidence reads, judged on the ACTUAL policy JSON the AWS provider renders (no mocked policy
# document): `data.aws_iam_policy_document.operator.json` is decoded and every case below is decided by a small
# evaluator of what that JSON allows -- Action, Resource and the dynamodb:LeadingKeys conditions (ForAllValues:StringLike /
# StringEquals / StringNotEquals / StringNotLike, and Null, with the AWS semantics that ForAllValues over an ABSENT key is
# true and only a Null "false" refuses a Scan). Decided exactly: an exact action, `dynamodb:*` or `*`; an exact resource or
# `*`; a pattern with at most one `*`, at its end. ANYTHING else -- a partial action or resource wildcard, `?`, an inner
# `*`, an ...IfExists operator, any other condition key -- is unknown: it counts as NOT matching for an "allowed" claim and
# as MATCHING for a "denied" claim, so neither claim is ever made on a guess. A Deny statement is refused outright.
#
# The provider is real but never reaches AWS: fake static credentials, every validation call skipped, and the account /
# prefix-list data overridden; only the operator policy (and what it depends on) is planned.
#
# Run: cd infra/aws/modules/app && terraform init -backend=false && terraform test -filter=tests/operator_evidence_policy.tftest.hcl

provider "aws" {
  region                      = "us-east-1"
  access_key                  = "test-not-a-key"
  secret_key                  = "test-not-a-secret"
  skip_credentials_validation = true
  skip_requesting_account_id  = true
  skip_metadata_api_check     = true
  skip_region_validation      = true
}

override_data {
  target = data.aws_caller_identity.current
  values = { account_id = "111111111111" }
}

override_data {
  target = data.aws_ec2_managed_prefix_list.cloudfront_origin_facing
  values = { id = "pl-3b927c52" }
}

variables {
  environment      = "staging"
  generation       = 1
  ledger_table_arn = "arn:aws:dynamodb:us-east-1:222222222222:table/gs-staging-ledger"
  signing_keys = {
    relayer    = "arn:aws:kms:us-east-1:222222222222:key/11111111-1111-4111-8111-111111111111"
    settlement = "arn:aws:kms:us-east-1:222222222222:key/22222222-2222-4222-8222-222222222222"
    admission  = "arn:aws:kms:us-east-1:222222222222:key/33333333-3333-4333-8333-333333333333"
  }
  network = {
    vpc_id                  = "vpc-0123456789abcdef0"
    task_subnet_ids         = ["subnet-0aaaaaaaaaaaaaaa1", "subnet-0aaaaaaaaaaaaaaa2"]
    alb_subnet_ids          = ["subnet-0bbbbbbbbbbbbbbb1", "subnet-0bbbbbbbbbbbbbbb2"]
    private_route_table_ids = ["rtb-0ccccccccccccccc1"]
  }
  build_id                         = "2026-10-02-jx4c"
  allowed_origins                  = ["https://play.example.com"]
  alb                              = { certificate_arn = "arn:aws:acm:us-east-1:111111111111:certificate/44444444-4444-4444-8444-444444444444" }
  bootstrap_trusted_principal_arns = ["arn:aws:iam::111111111111:role/deploy-pipeline"]
  operator_trusted_principal_arns  = ["arn:aws:iam::111111111111:role/ops-humans"]
  edge = {
    create_distribution     = true
    aliases                 = ["play.example.com"]
    viewer_certificate_arn  = "arn:aws:acm:us-east-1:111111111111:certificate/55555555-5555-4555-8555-555555555555"
    site_origin_domain_name = "site-origin.example.com"
    alb_origin_domain_name  = "gs-origin.example.com"
  }

}

run "jx4c_operator_evidence_reads_on_the_rendered_policy" {
  command = plan
  plan_options {
    target = [data.aws_iam_policy_document.operator]
  }

  assert {
    condition = length([for c in [
      { action = "dynamodb:GetItem", key = "PRIN#pr_aaaaaaaaaaaaaaaaaaaaaaaaaa", allowed = true },
      { action = "dynamodb:GetItem", key = "PROF#pf_aaaaaaaaaaaaaaaaaaaaaaaaaa", allowed = true },
      { action = "dynamodb:GetItem", key = "FAM#sf_aaaaaaaaaaaaaaaaaaaaaaaaaa", allowed = true },
      { action = "dynamodb:GetItem", key = "ROLE#identity-writer", allowed = true },
      { action = "dynamodb:GetItem", key = "SESS#se_aaaaaaaaaaaaaaaaaaaaaaaaaa", allowed = false },
      { action = "dynamodb:GetItem", key = "LINK#0000000000000000000000000000000000000000000000000000000000000000", allowed = false },
      { action = "dynamodb:GetItem", key = "SEL#rk_aaaaaaaaaaaaaaaaaaaaaaaaaa", allowed = false },
      { action = "dynamodb:GetItem", key = "GRANT#se_aaaaaaaaaaaaaaaaaaaaaaaaaa", allowed = false },
      { action = "dynamodb:GetItem", key = "TXN#token", allowed = false },
      { action = "dynamodb:GetItem", key = "RESTORE#identity", allowed = false },
      { action = "dynamodb:GetItem", key = "REVIEW#pf_aaaaaaaaaaaaaaaaaaaaaaaaaa", allowed = false },
      { action = "dynamodb:GetItem", key = "TABLE#identity", allowed = false },
      { action = "dynamodb:GetItem", key = "ROLE#relayer#r1", allowed = false },
      { action = "dynamodb:GetItem", key = "PRINCIPAL", allowed = false },
      { action = "dynamodb:Query", key = "PRIN#pr_aaaaaaaaaaaaaaaaaaaaaaaaaa", allowed = false },
      { action = "dynamodb:Query", key = "SESS#se_aaaaaaaaaaaaaaaaaaaaaaaaaa", allowed = false },
      { action = "dynamodb:Scan", key = null, allowed = false },
      { action = "dynamodb:BatchGetItem", key = "PRIN#pr_aaaaaaaaaaaaaaaaaaaaaaaaaa", allowed = false },
      { action = "dynamodb:PartiQLSelect", key = "PRIN#pr_aaaaaaaaaaaaaaaaaaaaaaaaaa", allowed = false },
      { action = "dynamodb:PutItem", key = "PRIN#pr_aaaaaaaaaaaaaaaaaaaaaaaaaa", allowed = false },
      { action = "dynamodb:UpdateItem", key = "PROF#pf_aaaaaaaaaaaaaaaaaaaaaaaaaa", allowed = false },
      { action = "dynamodb:DeleteItem", key = "FAM#sf_aaaaaaaaaaaaaaaaaaaaaaaaaa", allowed = false },
      { action = "dynamodb:BatchWriteItem", key = "PRIN#pr_aaaaaaaaaaaaaaaaaaaaaaaaaa", allowed = false },
      { action = "dynamodb:ConditionCheckItem", key = "PRIN#pr_aaaaaaaaaaaaaaaaaaaaaaaaaa", allowed = false },
      { action = "dynamodb:PutItem", key = "ROLE#identity-writer", allowed = false },
      { action = "dynamodb:UpdateItem", key = "ROLE#identity-writer", allowed = false },
      ] : c if(c.allowed ? !anytrue([for s in jsondecode(data.aws_iam_policy_document.operator.json).Statement :
        s.Effect == "Allow"
        && anytrue([for a in flatten([s.Action]) : a == c.action || a == "dynamodb:*" || a == "*" || (false && (strcontains(a, "*") || strcontains(a, "?")))])
        && anytrue([for r in flatten([s.Resource]) : r == "arn:aws:dynamodb:us-east-1:111111111111:table/gs-staging-identity" || r == "*" || (false && (strcontains(r, "*") || strcontains(r, "?")))])

        && alltrue([for op, m in try(s.Condition, {}) : alltrue([for ck, cv in m : (
          endswith(op, "IfExists") ? false :
          ck == "dynamodb:LeadingKeys" ? (
            op == "Null" ? ((c.key == null) == (lower(tostring(flatten([cv])[0])) == "true")) :
            c.key == null ? startswith(op, "ForAllValues:") :
            op == "ForAllValues:StringLike" ? anytrue([for p in flatten([cv]) : ((!strcontains(p, "?") && !strcontains(trimsuffix(p, "*"), "*")) ? (endswith(p, "*") ? startswith(c.key, trimsuffix(p, "*")) : c.key == p) : false)]) :
            op == "ForAllValues:StringEquals" ? contains(flatten([cv]), c.key) :
            op == "ForAllValues:StringNotEquals" ? !contains(flatten([cv]), c.key) :
            op == "ForAllValues:StringNotLike" ? !anytrue([for p in flatten([cv]) : ((!strcontains(p, "?") && !strcontains(trimsuffix(p, "*"), "*")) ? (endswith(p, "*") ? startswith(c.key, trimsuffix(p, "*")) : c.key == p) : !false)]) :
            false
          ) :
          ck == "aws:PrincipalArn" && try(c.principal, null) != null ? (
            op == "ArnEquals" || op == "StringEquals" ? contains(flatten([cv]), try(c.principal, null)) :
            op == "ArnLike" || op == "StringLike" ? anytrue([for p in flatten([cv]) : ((!strcontains(p, "?") && !strcontains(trimsuffix(p, "*"), "*")) ? (endswith(p, "*") ? startswith(try(c.principal, null), trimsuffix(p, "*")) : try(c.principal, null) == p) : false)]) :
            false
          ) :
          false
        )])])
        ]) : anytrue([for s in jsondecode(data.aws_iam_policy_document.operator.json).Statement :
        s.Effect == "Allow"
        && anytrue([for a in flatten([s.Action]) : a == c.action || a == "dynamodb:*" || a == "*" || (true && (strcontains(a, "*") || strcontains(a, "?")))])
        && anytrue([for r in flatten([s.Resource]) : r == "arn:aws:dynamodb:us-east-1:111111111111:table/gs-staging-identity" || r == "*" || (true && (strcontains(r, "*") || strcontains(r, "?")))])

        && alltrue([for op, m in try(s.Condition, {}) : alltrue([for ck, cv in m : (
          endswith(op, "IfExists") ? true :
          ck == "dynamodb:LeadingKeys" ? (
            op == "Null" ? ((c.key == null) == (lower(tostring(flatten([cv])[0])) == "true")) :
            c.key == null ? startswith(op, "ForAllValues:") :
            op == "ForAllValues:StringLike" ? anytrue([for p in flatten([cv]) : ((!strcontains(p, "?") && !strcontains(trimsuffix(p, "*"), "*")) ? (endswith(p, "*") ? startswith(c.key, trimsuffix(p, "*")) : c.key == p) : true)]) :
            op == "ForAllValues:StringEquals" ? contains(flatten([cv]), c.key) :
            op == "ForAllValues:StringNotEquals" ? !contains(flatten([cv]), c.key) :
            op == "ForAllValues:StringNotLike" ? !anytrue([for p in flatten([cv]) : ((!strcontains(p, "?") && !strcontains(trimsuffix(p, "*"), "*")) ? (endswith(p, "*") ? startswith(c.key, trimsuffix(p, "*")) : c.key == p) : !true)]) :
            true
          ) :
          ck == "aws:PrincipalArn" && try(c.principal, null) != null ? (
            op == "ArnEquals" || op == "StringEquals" ? contains(flatten([cv]), try(c.principal, null)) :
            op == "ArnLike" || op == "StringLike" ? anytrue([for p in flatten([cv]) : ((!strcontains(p, "?") && !strcontains(trimsuffix(p, "*"), "*")) ? (endswith(p, "*") ? startswith(try(c.principal, null), trimsuffix(p, "*")) : try(c.principal, null) == p) : true)]) :
            true
          ) :
          true
        )])])
    ]))]) == 0
    error_message = "IDENTITY: GetItem of PRIN#/PROF#/FAM# (+ the identity-writer role) only -- no other class, no Query/Scan, no write -- decided against expectation: ${join("; ", [for c in [
      { action = "dynamodb:GetItem", key = "PRIN#pr_aaaaaaaaaaaaaaaaaaaaaaaaaa", allowed = true },
      { action = "dynamodb:GetItem", key = "PROF#pf_aaaaaaaaaaaaaaaaaaaaaaaaaa", allowed = true },
      { action = "dynamodb:GetItem", key = "FAM#sf_aaaaaaaaaaaaaaaaaaaaaaaaaa", allowed = true },
      { action = "dynamodb:GetItem", key = "ROLE#identity-writer", allowed = true },
      { action = "dynamodb:GetItem", key = "SESS#se_aaaaaaaaaaaaaaaaaaaaaaaaaa", allowed = false },
      { action = "dynamodb:GetItem", key = "LINK#0000000000000000000000000000000000000000000000000000000000000000", allowed = false },
      { action = "dynamodb:GetItem", key = "SEL#rk_aaaaaaaaaaaaaaaaaaaaaaaaaa", allowed = false },
      { action = "dynamodb:GetItem", key = "GRANT#se_aaaaaaaaaaaaaaaaaaaaaaaaaa", allowed = false },
      { action = "dynamodb:GetItem", key = "TXN#token", allowed = false },
      { action = "dynamodb:GetItem", key = "RESTORE#identity", allowed = false },
      { action = "dynamodb:GetItem", key = "REVIEW#pf_aaaaaaaaaaaaaaaaaaaaaaaaaa", allowed = false },
      { action = "dynamodb:GetItem", key = "TABLE#identity", allowed = false },
      { action = "dynamodb:GetItem", key = "ROLE#relayer#r1", allowed = false },
      { action = "dynamodb:GetItem", key = "PRINCIPAL", allowed = false },
      { action = "dynamodb:Query", key = "PRIN#pr_aaaaaaaaaaaaaaaaaaaaaaaaaa", allowed = false },
      { action = "dynamodb:Query", key = "SESS#se_aaaaaaaaaaaaaaaaaaaaaaaaaa", allowed = false },
      { action = "dynamodb:Scan", key = null, allowed = false },
      { action = "dynamodb:BatchGetItem", key = "PRIN#pr_aaaaaaaaaaaaaaaaaaaaaaaaaa", allowed = false },
      { action = "dynamodb:PartiQLSelect", key = "PRIN#pr_aaaaaaaaaaaaaaaaaaaaaaaaaa", allowed = false },
      { action = "dynamodb:PutItem", key = "PRIN#pr_aaaaaaaaaaaaaaaaaaaaaaaaaa", allowed = false },
      { action = "dynamodb:UpdateItem", key = "PROF#pf_aaaaaaaaaaaaaaaaaaaaaaaaaa", allowed = false },
      { action = "dynamodb:DeleteItem", key = "FAM#sf_aaaaaaaaaaaaaaaaaaaaaaaaaa", allowed = false },
      { action = "dynamodb:BatchWriteItem", key = "PRIN#pr_aaaaaaaaaaaaaaaaaaaaaaaaaa", allowed = false },
      { action = "dynamodb:ConditionCheckItem", key = "PRIN#pr_aaaaaaaaaaaaaaaaaaaaaaaaaa", allowed = false },
      { action = "dynamodb:PutItem", key = "ROLE#identity-writer", allowed = false },
      { action = "dynamodb:UpdateItem", key = "ROLE#identity-writer", allowed = false },
      ] : "${c.action} ${coalesce(c.key, "(no key)")}${try(" as ${c.principal}", "")}" if(c.allowed ? !anytrue([for s in jsondecode(data.aws_iam_policy_document.operator.json).Statement :
        s.Effect == "Allow"
        && anytrue([for a in flatten([s.Action]) : a == c.action || a == "dynamodb:*" || a == "*" || (false && (strcontains(a, "*") || strcontains(a, "?")))])
        && anytrue([for r in flatten([s.Resource]) : r == "arn:aws:dynamodb:us-east-1:111111111111:table/gs-staging-identity" || r == "*" || (false && (strcontains(r, "*") || strcontains(r, "?")))])

        && alltrue([for op, m in try(s.Condition, {}) : alltrue([for ck, cv in m : (
          endswith(op, "IfExists") ? false :
          ck == "dynamodb:LeadingKeys" ? (
            op == "Null" ? ((c.key == null) == (lower(tostring(flatten([cv])[0])) == "true")) :
            c.key == null ? startswith(op, "ForAllValues:") :
            op == "ForAllValues:StringLike" ? anytrue([for p in flatten([cv]) : ((!strcontains(p, "?") && !strcontains(trimsuffix(p, "*"), "*")) ? (endswith(p, "*") ? startswith(c.key, trimsuffix(p, "*")) : c.key == p) : false)]) :
            op == "ForAllValues:StringEquals" ? contains(flatten([cv]), c.key) :
            op == "ForAllValues:StringNotEquals" ? !contains(flatten([cv]), c.key) :
            op == "ForAllValues:StringNotLike" ? !anytrue([for p in flatten([cv]) : ((!strcontains(p, "?") && !strcontains(trimsuffix(p, "*"), "*")) ? (endswith(p, "*") ? startswith(c.key, trimsuffix(p, "*")) : c.key == p) : !false)]) :
            false
          ) :
          ck == "aws:PrincipalArn" && try(c.principal, null) != null ? (
            op == "ArnEquals" || op == "StringEquals" ? contains(flatten([cv]), try(c.principal, null)) :
            op == "ArnLike" || op == "StringLike" ? anytrue([for p in flatten([cv]) : ((!strcontains(p, "?") && !strcontains(trimsuffix(p, "*"), "*")) ? (endswith(p, "*") ? startswith(try(c.principal, null), trimsuffix(p, "*")) : try(c.principal, null) == p) : false)]) :
            false
          ) :
          false
        )])])
        ]) : anytrue([for s in jsondecode(data.aws_iam_policy_document.operator.json).Statement :
        s.Effect == "Allow"
        && anytrue([for a in flatten([s.Action]) : a == c.action || a == "dynamodb:*" || a == "*" || (true && (strcontains(a, "*") || strcontains(a, "?")))])
        && anytrue([for r in flatten([s.Resource]) : r == "arn:aws:dynamodb:us-east-1:111111111111:table/gs-staging-identity" || r == "*" || (true && (strcontains(r, "*") || strcontains(r, "?")))])

        && alltrue([for op, m in try(s.Condition, {}) : alltrue([for ck, cv in m : (
          endswith(op, "IfExists") ? true :
          ck == "dynamodb:LeadingKeys" ? (
            op == "Null" ? ((c.key == null) == (lower(tostring(flatten([cv])[0])) == "true")) :
            c.key == null ? startswith(op, "ForAllValues:") :
            op == "ForAllValues:StringLike" ? anytrue([for p in flatten([cv]) : ((!strcontains(p, "?") && !strcontains(trimsuffix(p, "*"), "*")) ? (endswith(p, "*") ? startswith(c.key, trimsuffix(p, "*")) : c.key == p) : true)]) :
            op == "ForAllValues:StringEquals" ? contains(flatten([cv]), c.key) :
            op == "ForAllValues:StringNotEquals" ? !contains(flatten([cv]), c.key) :
            op == "ForAllValues:StringNotLike" ? !anytrue([for p in flatten([cv]) : ((!strcontains(p, "?") && !strcontains(trimsuffix(p, "*"), "*")) ? (endswith(p, "*") ? startswith(c.key, trimsuffix(p, "*")) : c.key == p) : !true)]) :
            true
          ) :
          ck == "aws:PrincipalArn" && try(c.principal, null) != null ? (
            op == "ArnEquals" || op == "StringEquals" ? contains(flatten([cv]), try(c.principal, null)) :
            op == "ArnLike" || op == "StringLike" ? anytrue([for p in flatten([cv]) : ((!strcontains(p, "?") && !strcontains(trimsuffix(p, "*"), "*")) ? (endswith(p, "*") ? startswith(try(c.principal, null), trimsuffix(p, "*")) : try(c.principal, null) == p) : true)]) :
            true
          ) :
          true
        )])])
    ]))])}"
  }
  assert {
    condition     = length([for s in jsondecode(data.aws_iam_policy_document.operator.json).Statement : s if s.Effect != "Allow"]) == 0
    error_message = "The document has no Deny statement (the evaluator models Allow only: a Deny would make an ALLOWED claim unsound)."
  }

  assert {
    condition = length([for c in [
      { action = "dynamodb:Query", key = "ATTI#0000000000000000000000000000000000000000000000000000000000000000", allowed = true },
      { action = "dynamodb:GetItem", key = "TXID#0000000000000000000000000000000000000000000000000000000000000000", allowed = true },
      { action = "dynamodb:GetItem", key = "APPGEN", allowed = true },
      { action = "dynamodb:Scan", key = null, allowed = true },
      { action = "dynamodb:Query", key = "SEC#pr_aaaaaaaaaaaaaaaaaaaaaaaaaa", allowed = false },
      { action = "dynamodb:Query", key = "APPGEN", allowed = false },
      { action = "dynamodb:Query", key = "APPGEN#HISTORY", allowed = false },
      { action = "dynamodb:Query", key = "FENCE#relayer#r1", allowed = false },
      { action = "dynamodb:Query", key = "TXID#0000000000000000000000000000000000000000000000000000000000000000", allowed = false },
      { action = "dynamodb:Query", key = "ATTEMPT#x", allowed = false },
      { action = "dynamodb:Query", key = "ATTI", allowed = false },
      { action = "dynamodb:PutItem", key = "ATTI#0000000000000000000000000000000000000000000000000000000000000000", allowed = false },
      { action = "dynamodb:PutItem", key = "APPGEN", allowed = false },
      { action = "dynamodb:UpdateItem", key = "APPGEN", allowed = false },
      { action = "dynamodb:DeleteItem", key = "ATTI#0000000000000000000000000000000000000000000000000000000000000000", allowed = false },
      { action = "dynamodb:BatchWriteItem", key = "ATTI#0000000000000000000000000000000000000000000000000000000000000000", allowed = false },
      { action = "dynamodb:ConditionCheckItem", key = "APPGEN", allowed = false },
      { action = "dynamodb:PartiQLUpdate", key = "APPGEN", allowed = false },
      ] : c if(c.allowed ? !anytrue([for s in jsondecode(data.aws_iam_policy_document.operator.json).Statement :
        s.Effect == "Allow"
        && anytrue([for a in flatten([s.Action]) : a == c.action || a == "dynamodb:*" || a == "*" || (false && (strcontains(a, "*") || strcontains(a, "?")))])
        && anytrue([for r in flatten([s.Resource]) : r == "arn:aws:dynamodb:us-east-1:222222222222:table/gs-staging-ledger" || r == "*" || (false && (strcontains(r, "*") || strcontains(r, "?")))])

        && alltrue([for op, m in try(s.Condition, {}) : alltrue([for ck, cv in m : (
          endswith(op, "IfExists") ? false :
          ck == "dynamodb:LeadingKeys" ? (
            op == "Null" ? ((c.key == null) == (lower(tostring(flatten([cv])[0])) == "true")) :
            c.key == null ? startswith(op, "ForAllValues:") :
            op == "ForAllValues:StringLike" ? anytrue([for p in flatten([cv]) : ((!strcontains(p, "?") && !strcontains(trimsuffix(p, "*"), "*")) ? (endswith(p, "*") ? startswith(c.key, trimsuffix(p, "*")) : c.key == p) : false)]) :
            op == "ForAllValues:StringEquals" ? contains(flatten([cv]), c.key) :
            op == "ForAllValues:StringNotEquals" ? !contains(flatten([cv]), c.key) :
            op == "ForAllValues:StringNotLike" ? !anytrue([for p in flatten([cv]) : ((!strcontains(p, "?") && !strcontains(trimsuffix(p, "*"), "*")) ? (endswith(p, "*") ? startswith(c.key, trimsuffix(p, "*")) : c.key == p) : !false)]) :
            false
          ) :
          ck == "aws:PrincipalArn" && try(c.principal, null) != null ? (
            op == "ArnEquals" || op == "StringEquals" ? contains(flatten([cv]), try(c.principal, null)) :
            op == "ArnLike" || op == "StringLike" ? anytrue([for p in flatten([cv]) : ((!strcontains(p, "?") && !strcontains(trimsuffix(p, "*"), "*")) ? (endswith(p, "*") ? startswith(try(c.principal, null), trimsuffix(p, "*")) : try(c.principal, null) == p) : false)]) :
            false
          ) :
          false
        )])])
        ]) : anytrue([for s in jsondecode(data.aws_iam_policy_document.operator.json).Statement :
        s.Effect == "Allow"
        && anytrue([for a in flatten([s.Action]) : a == c.action || a == "dynamodb:*" || a == "*" || (true && (strcontains(a, "*") || strcontains(a, "?")))])
        && anytrue([for r in flatten([s.Resource]) : r == "arn:aws:dynamodb:us-east-1:222222222222:table/gs-staging-ledger" || r == "*" || (true && (strcontains(r, "*") || strcontains(r, "?")))])

        && alltrue([for op, m in try(s.Condition, {}) : alltrue([for ck, cv in m : (
          endswith(op, "IfExists") ? true :
          ck == "dynamodb:LeadingKeys" ? (
            op == "Null" ? ((c.key == null) == (lower(tostring(flatten([cv])[0])) == "true")) :
            c.key == null ? startswith(op, "ForAllValues:") :
            op == "ForAllValues:StringLike" ? anytrue([for p in flatten([cv]) : ((!strcontains(p, "?") && !strcontains(trimsuffix(p, "*"), "*")) ? (endswith(p, "*") ? startswith(c.key, trimsuffix(p, "*")) : c.key == p) : true)]) :
            op == "ForAllValues:StringEquals" ? contains(flatten([cv]), c.key) :
            op == "ForAllValues:StringNotEquals" ? !contains(flatten([cv]), c.key) :
            op == "ForAllValues:StringNotLike" ? !anytrue([for p in flatten([cv]) : ((!strcontains(p, "?") && !strcontains(trimsuffix(p, "*"), "*")) ? (endswith(p, "*") ? startswith(c.key, trimsuffix(p, "*")) : c.key == p) : !true)]) :
            true
          ) :
          ck == "aws:PrincipalArn" && try(c.principal, null) != null ? (
            op == "ArnEquals" || op == "StringEquals" ? contains(flatten([cv]), try(c.principal, null)) :
            op == "ArnLike" || op == "StringLike" ? anytrue([for p in flatten([cv]) : ((!strcontains(p, "?") && !strcontains(trimsuffix(p, "*"), "*")) ? (endswith(p, "*") ? startswith(try(c.principal, null), trimsuffix(p, "*")) : try(c.principal, null) == p) : true)]) :
            true
          ) :
          true
        )])])
    ]))]) == 0
    error_message = "LEDGER (app half): Query of ATTI# partitions only; GetItem/Scan unchanged; no write -- decided against expectation: ${join("; ", [for c in [
      { action = "dynamodb:Query", key = "ATTI#0000000000000000000000000000000000000000000000000000000000000000", allowed = true },
      { action = "dynamodb:GetItem", key = "TXID#0000000000000000000000000000000000000000000000000000000000000000", allowed = true },
      { action = "dynamodb:GetItem", key = "APPGEN", allowed = true },
      { action = "dynamodb:Scan", key = null, allowed = true },
      { action = "dynamodb:Query", key = "SEC#pr_aaaaaaaaaaaaaaaaaaaaaaaaaa", allowed = false },
      { action = "dynamodb:Query", key = "APPGEN", allowed = false },
      { action = "dynamodb:Query", key = "APPGEN#HISTORY", allowed = false },
      { action = "dynamodb:Query", key = "FENCE#relayer#r1", allowed = false },
      { action = "dynamodb:Query", key = "TXID#0000000000000000000000000000000000000000000000000000000000000000", allowed = false },
      { action = "dynamodb:Query", key = "ATTEMPT#x", allowed = false },
      { action = "dynamodb:Query", key = "ATTI", allowed = false },
      { action = "dynamodb:PutItem", key = "ATTI#0000000000000000000000000000000000000000000000000000000000000000", allowed = false },
      { action = "dynamodb:PutItem", key = "APPGEN", allowed = false },
      { action = "dynamodb:UpdateItem", key = "APPGEN", allowed = false },
      { action = "dynamodb:DeleteItem", key = "ATTI#0000000000000000000000000000000000000000000000000000000000000000", allowed = false },
      { action = "dynamodb:BatchWriteItem", key = "ATTI#0000000000000000000000000000000000000000000000000000000000000000", allowed = false },
      { action = "dynamodb:ConditionCheckItem", key = "APPGEN", allowed = false },
      { action = "dynamodb:PartiQLUpdate", key = "APPGEN", allowed = false },
      ] : "${c.action} ${coalesce(c.key, "(no key)")}${try(" as ${c.principal}", "")}" if(c.allowed ? !anytrue([for s in jsondecode(data.aws_iam_policy_document.operator.json).Statement :
        s.Effect == "Allow"
        && anytrue([for a in flatten([s.Action]) : a == c.action || a == "dynamodb:*" || a == "*" || (false && (strcontains(a, "*") || strcontains(a, "?")))])
        && anytrue([for r in flatten([s.Resource]) : r == "arn:aws:dynamodb:us-east-1:222222222222:table/gs-staging-ledger" || r == "*" || (false && (strcontains(r, "*") || strcontains(r, "?")))])

        && alltrue([for op, m in try(s.Condition, {}) : alltrue([for ck, cv in m : (
          endswith(op, "IfExists") ? false :
          ck == "dynamodb:LeadingKeys" ? (
            op == "Null" ? ((c.key == null) == (lower(tostring(flatten([cv])[0])) == "true")) :
            c.key == null ? startswith(op, "ForAllValues:") :
            op == "ForAllValues:StringLike" ? anytrue([for p in flatten([cv]) : ((!strcontains(p, "?") && !strcontains(trimsuffix(p, "*"), "*")) ? (endswith(p, "*") ? startswith(c.key, trimsuffix(p, "*")) : c.key == p) : false)]) :
            op == "ForAllValues:StringEquals" ? contains(flatten([cv]), c.key) :
            op == "ForAllValues:StringNotEquals" ? !contains(flatten([cv]), c.key) :
            op == "ForAllValues:StringNotLike" ? !anytrue([for p in flatten([cv]) : ((!strcontains(p, "?") && !strcontains(trimsuffix(p, "*"), "*")) ? (endswith(p, "*") ? startswith(c.key, trimsuffix(p, "*")) : c.key == p) : !false)]) :
            false
          ) :
          ck == "aws:PrincipalArn" && try(c.principal, null) != null ? (
            op == "ArnEquals" || op == "StringEquals" ? contains(flatten([cv]), try(c.principal, null)) :
            op == "ArnLike" || op == "StringLike" ? anytrue([for p in flatten([cv]) : ((!strcontains(p, "?") && !strcontains(trimsuffix(p, "*"), "*")) ? (endswith(p, "*") ? startswith(try(c.principal, null), trimsuffix(p, "*")) : try(c.principal, null) == p) : false)]) :
            false
          ) :
          false
        )])])
        ]) : anytrue([for s in jsondecode(data.aws_iam_policy_document.operator.json).Statement :
        s.Effect == "Allow"
        && anytrue([for a in flatten([s.Action]) : a == c.action || a == "dynamodb:*" || a == "*" || (true && (strcontains(a, "*") || strcontains(a, "?")))])
        && anytrue([for r in flatten([s.Resource]) : r == "arn:aws:dynamodb:us-east-1:222222222222:table/gs-staging-ledger" || r == "*" || (true && (strcontains(r, "*") || strcontains(r, "?")))])

        && alltrue([for op, m in try(s.Condition, {}) : alltrue([for ck, cv in m : (
          endswith(op, "IfExists") ? true :
          ck == "dynamodb:LeadingKeys" ? (
            op == "Null" ? ((c.key == null) == (lower(tostring(flatten([cv])[0])) == "true")) :
            c.key == null ? startswith(op, "ForAllValues:") :
            op == "ForAllValues:StringLike" ? anytrue([for p in flatten([cv]) : ((!strcontains(p, "?") && !strcontains(trimsuffix(p, "*"), "*")) ? (endswith(p, "*") ? startswith(c.key, trimsuffix(p, "*")) : c.key == p) : true)]) :
            op == "ForAllValues:StringEquals" ? contains(flatten([cv]), c.key) :
            op == "ForAllValues:StringNotEquals" ? !contains(flatten([cv]), c.key) :
            op == "ForAllValues:StringNotLike" ? !anytrue([for p in flatten([cv]) : ((!strcontains(p, "?") && !strcontains(trimsuffix(p, "*"), "*")) ? (endswith(p, "*") ? startswith(c.key, trimsuffix(p, "*")) : c.key == p) : !true)]) :
            true
          ) :
          ck == "aws:PrincipalArn" && try(c.principal, null) != null ? (
            op == "ArnEquals" || op == "StringEquals" ? contains(flatten([cv]), try(c.principal, null)) :
            op == "ArnLike" || op == "StringLike" ? anytrue([for p in flatten([cv]) : ((!strcontains(p, "?") && !strcontains(trimsuffix(p, "*"), "*")) ? (endswith(p, "*") ? startswith(try(c.principal, null), trimsuffix(p, "*")) : try(c.principal, null) == p) : true)]) :
            true
          ) :
          true
        )])])
    ]))])}"
  }
  assert {
    condition     = length([for s in jsondecode(data.aws_iam_policy_document.operator.json).Statement : s if s.Effect != "Allow"]) == 0
    error_message = "The document has no Deny statement (the evaluator models Allow only: a Deny would make an ALLOWED claim unsound)."
  }

  assert {
    condition     = length([for s in jsondecode(data.aws_iam_policy_document.operator.json).Statement : s if anytrue([for a in flatten([s.Action]) : startswith(a, "kms:") || a == "*"]) || anytrue([for r in flatten([s.Resource]) : strcontains(r, ":kms:")])]) == 0
    error_message = "KMS: the operator has no KMS action and names no key (no Sign, no GetPublicKey)."
  }
  assert {
    condition = (one([for s in jsondecode(data.aws_iam_policy_document.operator.json).Statement : s if s.Sid == "IdentityEvidenceRead"]).Resource == "arn:aws:dynamodb:us-east-1:111111111111:table/gs-staging-identity"
    && one([for s in jsondecode(data.aws_iam_policy_document.operator.json).Statement : s if s.Sid == "LedgerJournalQuery"]).Resource == "arn:aws:dynamodb:us-east-1:222222222222:table/gs-staging-ledger")
    error_message = "The two JX-4C statements are rendered, each on its one table (never an index, never *)."
  }
}
