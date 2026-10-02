# JX-4C: the ledger table's RESOURCE policy (the ledger account's half of the operator's journal Query), judged on the
# ACTUAL policy JSON the AWS provider renders -- Principal, Action, Resource and the aws:PrincipalArn / dynamodb:LeadingKeys
# conditions evaluated per case by the same evaluator as modules/app/tests/operator_evidence_policy.tftest.hcl (anything it
# does not decide exactly -- a partial wildcard, `?`, an inner `*`, ...IfExists, another condition key, a wildcard
# principal -- never supports a claim: not matching for "allowed", matching for "denied"; a Deny statement is refused).
#
# The provider is real but never reaches AWS (fake static credentials, validation calls skipped, the account overridden,
# the table overridden for its ARN: never created); only the resource-policy document and that table are applied.

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
  values = { account_id = "222222222222" }
}

override_resource {
  target = aws_dynamodb_table.ledger
  values = { arn = "arn:aws:dynamodb:us-east-1:222222222222:table/gs-staging-ledger" }
}

variables {
  environment    = "staging"
  app_account_id = "111111111111"
}

run "jx4c_operator_journal_query_on_the_rendered_resource_policy" {
  command = apply # a data source on a not-yet-created table is read at apply; the table itself is overridden (no API)
  plan_options {
    target = [data.aws_iam_policy_document.ledger_resource]
  }

  assert {
    condition = length([for c in [
      { action = "dynamodb:Query", key = "ATTI#0000000000000000000000000000000000000000000000000000000000000000", allowed = true, principal = "arn:aws:iam::111111111111:role/gs-staging-operator" },
      { action = "dynamodb:GetItem", key = "APPGEN", allowed = true, principal = "arn:aws:iam::111111111111:role/gs-staging-operator" },
      { action = "dynamodb:GetItem", key = "TXID#0000000000000000000000000000000000000000000000000000000000000000", allowed = true, principal = "arn:aws:iam::111111111111:role/gs-staging-operator" },
      { action = "dynamodb:Scan", key = null, allowed = true, principal = "arn:aws:iam::111111111111:role/gs-staging-operator" },
      { action = "dynamodb:Query", key = "SEC#pr_aaaaaaaaaaaaaaaaaaaaaaaaaa", allowed = false, principal = "arn:aws:iam::111111111111:role/gs-staging-operator" },
      { action = "dynamodb:Query", key = "APPGEN", allowed = false, principal = "arn:aws:iam::111111111111:role/gs-staging-operator" },
      { action = "dynamodb:Query", key = "APPGEN#HISTORY", allowed = false, principal = "arn:aws:iam::111111111111:role/gs-staging-operator" },
      { action = "dynamodb:Query", key = "FENCE#relayer#r1", allowed = false, principal = "arn:aws:iam::111111111111:role/gs-staging-operator" },
      { action = "dynamodb:Query", key = "TXID#0000000000000000000000000000000000000000000000000000000000000000", allowed = false, principal = "arn:aws:iam::111111111111:role/gs-staging-operator" },
      { action = "dynamodb:Query", key = "ATTI", allowed = false, principal = "arn:aws:iam::111111111111:role/gs-staging-operator" },
      { action = "dynamodb:PutItem", key = "ATTI#0000000000000000000000000000000000000000000000000000000000000000", allowed = false, principal = "arn:aws:iam::111111111111:role/gs-staging-operator" },
      { action = "dynamodb:PutItem", key = "APPGEN", allowed = false, principal = "arn:aws:iam::111111111111:role/gs-staging-operator" },
      { action = "dynamodb:UpdateItem", key = "APPGEN", allowed = false, principal = "arn:aws:iam::111111111111:role/gs-staging-operator" },
      { action = "dynamodb:DeleteItem", key = "ATTI#0000000000000000000000000000000000000000000000000000000000000000", allowed = false, principal = "arn:aws:iam::111111111111:role/gs-staging-operator" },
      { action = "dynamodb:BatchWriteItem", key = "ATTI#0000000000000000000000000000000000000000000000000000000000000000", allowed = false, principal = "arn:aws:iam::111111111111:role/gs-staging-operator" },
      { action = "dynamodb:ConditionCheckItem", key = "APPGEN", allowed = false, principal = "arn:aws:iam::111111111111:role/gs-staging-operator" },
      { action = "dynamodb:PartiQLUpdate", key = "APPGEN", allowed = false, principal = "arn:aws:iam::111111111111:role/gs-staging-operator" },
      { action = "dynamodb:Query", key = "ATTI#0000000000000000000000000000000000000000000000000000000000000000", allowed = false, principal = "arn:aws:iam::111111111111:role/gs-staging-deploy" },
      { action = "dynamodb:Query", key = "ATTI#0000000000000000000000000000000000000000000000000000000000000000", allowed = false, principal = "arn:aws:iam::333333333333:role/gs-staging-operator" },
      { action = "dynamodb:Query", key = "ATTI#0000000000000000000000000000000000000000000000000000000000000000", allowed = false, principal = "arn:aws:iam::222222222222:role/gs-staging-operator" },
      { action = "dynamodb:Query", key = "ATTI#0000000000000000000000000000000000000000000000000000000000000000", allowed = false, principal = "arn:aws:iam::111111111111:role/gs-prod-operator" },
      { action = "dynamodb:PutItem", key = "APPGEN", allowed = false, principal = "arn:aws:iam::111111111111:role/gs-staging-app-task" },
      { action = "dynamodb:UpdateItem", key = "APPGEN", allowed = false, principal = "arn:aws:iam::111111111111:role/gs-staging-app-task" },
      { action = "dynamodb:Query", key = "ATTI#0000000000000000000000000000000000000000000000000000000000000000", allowed = true, principal = "arn:aws:iam::111111111111:role/gs-staging-app-task" },
      { action = "dynamodb:PutItem", key = "ATTI#0000000000000000000000000000000000000000000000000000000000000000", allowed = true, principal = "arn:aws:iam::111111111111:role/gs-staging-app-task" },
      ] : c if(c.allowed ? !anytrue([for s in jsondecode(data.aws_iam_policy_document.ledger_resource.json).Statement :
        s.Effect == "Allow"
        && anytrue([for a in flatten([s.Action]) : a == c.action || a == "dynamodb:*" || a == "*" || (false && (strcontains(a, "*") || strcontains(a, "?")))])
        && anytrue([for r in flatten([s.Resource]) : r == "arn:aws:dynamodb:us-east-1:222222222222:table/gs-staging-ledger" || r == "*" || (false && (strcontains(r, "*") || strcontains(r, "?")))])
        && anytrue([for p in flatten([try(s.Principal.AWS, s.Principal, [])]) : p == "*" || p == try(c.principal, null) || p == "arn:aws:iam::${split(":", try(c.principal, null))[4]}:root" || (false && strcontains(p, "*"))])
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
        ]) : anytrue([for s in jsondecode(data.aws_iam_policy_document.ledger_resource.json).Statement :
        s.Effect == "Allow"
        && anytrue([for a in flatten([s.Action]) : a == c.action || a == "dynamodb:*" || a == "*" || (true && (strcontains(a, "*") || strcontains(a, "?")))])
        && anytrue([for r in flatten([s.Resource]) : r == "arn:aws:dynamodb:us-east-1:222222222222:table/gs-staging-ledger" || r == "*" || (true && (strcontains(r, "*") || strcontains(r, "?")))])
        && anytrue([for p in flatten([try(s.Principal.AWS, s.Principal, [])]) : p == "*" || p == try(c.principal, null) || p == "arn:aws:iam::${split(":", try(c.principal, null))[4]}:root" || (true && strcontains(p, "*"))])
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
    error_message = "LEDGER (resource half): the exact operator role may Query ATTI# only; GetItem/Scan unchanged; no write; APPGEN authority unchanged -- decided against expectation: ${join("; ", [for c in [
      { action = "dynamodb:Query", key = "ATTI#0000000000000000000000000000000000000000000000000000000000000000", allowed = true, principal = "arn:aws:iam::111111111111:role/gs-staging-operator" },
      { action = "dynamodb:GetItem", key = "APPGEN", allowed = true, principal = "arn:aws:iam::111111111111:role/gs-staging-operator" },
      { action = "dynamodb:GetItem", key = "TXID#0000000000000000000000000000000000000000000000000000000000000000", allowed = true, principal = "arn:aws:iam::111111111111:role/gs-staging-operator" },
      { action = "dynamodb:Scan", key = null, allowed = true, principal = "arn:aws:iam::111111111111:role/gs-staging-operator" },
      { action = "dynamodb:Query", key = "SEC#pr_aaaaaaaaaaaaaaaaaaaaaaaaaa", allowed = false, principal = "arn:aws:iam::111111111111:role/gs-staging-operator" },
      { action = "dynamodb:Query", key = "APPGEN", allowed = false, principal = "arn:aws:iam::111111111111:role/gs-staging-operator" },
      { action = "dynamodb:Query", key = "APPGEN#HISTORY", allowed = false, principal = "arn:aws:iam::111111111111:role/gs-staging-operator" },
      { action = "dynamodb:Query", key = "FENCE#relayer#r1", allowed = false, principal = "arn:aws:iam::111111111111:role/gs-staging-operator" },
      { action = "dynamodb:Query", key = "TXID#0000000000000000000000000000000000000000000000000000000000000000", allowed = false, principal = "arn:aws:iam::111111111111:role/gs-staging-operator" },
      { action = "dynamodb:Query", key = "ATTI", allowed = false, principal = "arn:aws:iam::111111111111:role/gs-staging-operator" },
      { action = "dynamodb:PutItem", key = "ATTI#0000000000000000000000000000000000000000000000000000000000000000", allowed = false, principal = "arn:aws:iam::111111111111:role/gs-staging-operator" },
      { action = "dynamodb:PutItem", key = "APPGEN", allowed = false, principal = "arn:aws:iam::111111111111:role/gs-staging-operator" },
      { action = "dynamodb:UpdateItem", key = "APPGEN", allowed = false, principal = "arn:aws:iam::111111111111:role/gs-staging-operator" },
      { action = "dynamodb:DeleteItem", key = "ATTI#0000000000000000000000000000000000000000000000000000000000000000", allowed = false, principal = "arn:aws:iam::111111111111:role/gs-staging-operator" },
      { action = "dynamodb:BatchWriteItem", key = "ATTI#0000000000000000000000000000000000000000000000000000000000000000", allowed = false, principal = "arn:aws:iam::111111111111:role/gs-staging-operator" },
      { action = "dynamodb:ConditionCheckItem", key = "APPGEN", allowed = false, principal = "arn:aws:iam::111111111111:role/gs-staging-operator" },
      { action = "dynamodb:PartiQLUpdate", key = "APPGEN", allowed = false, principal = "arn:aws:iam::111111111111:role/gs-staging-operator" },
      { action = "dynamodb:Query", key = "ATTI#0000000000000000000000000000000000000000000000000000000000000000", allowed = false, principal = "arn:aws:iam::111111111111:role/gs-staging-deploy" },
      { action = "dynamodb:Query", key = "ATTI#0000000000000000000000000000000000000000000000000000000000000000", allowed = false, principal = "arn:aws:iam::333333333333:role/gs-staging-operator" },
      { action = "dynamodb:Query", key = "ATTI#0000000000000000000000000000000000000000000000000000000000000000", allowed = false, principal = "arn:aws:iam::222222222222:role/gs-staging-operator" },
      { action = "dynamodb:Query", key = "ATTI#0000000000000000000000000000000000000000000000000000000000000000", allowed = false, principal = "arn:aws:iam::111111111111:role/gs-prod-operator" },
      { action = "dynamodb:PutItem", key = "APPGEN", allowed = false, principal = "arn:aws:iam::111111111111:role/gs-staging-app-task" },
      { action = "dynamodb:UpdateItem", key = "APPGEN", allowed = false, principal = "arn:aws:iam::111111111111:role/gs-staging-app-task" },
      { action = "dynamodb:Query", key = "ATTI#0000000000000000000000000000000000000000000000000000000000000000", allowed = true, principal = "arn:aws:iam::111111111111:role/gs-staging-app-task" },
      { action = "dynamodb:PutItem", key = "ATTI#0000000000000000000000000000000000000000000000000000000000000000", allowed = true, principal = "arn:aws:iam::111111111111:role/gs-staging-app-task" },
      ] : "${c.action} ${coalesce(c.key, "(no key)")}${try(" as ${c.principal}", "")}" if(c.allowed ? !anytrue([for s in jsondecode(data.aws_iam_policy_document.ledger_resource.json).Statement :
        s.Effect == "Allow"
        && anytrue([for a in flatten([s.Action]) : a == c.action || a == "dynamodb:*" || a == "*" || (false && (strcontains(a, "*") || strcontains(a, "?")))])
        && anytrue([for r in flatten([s.Resource]) : r == "arn:aws:dynamodb:us-east-1:222222222222:table/gs-staging-ledger" || r == "*" || (false && (strcontains(r, "*") || strcontains(r, "?")))])
        && anytrue([for p in flatten([try(s.Principal.AWS, s.Principal, [])]) : p == "*" || p == try(c.principal, null) || p == "arn:aws:iam::${split(":", try(c.principal, null))[4]}:root" || (false && strcontains(p, "*"))])
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
        ]) : anytrue([for s in jsondecode(data.aws_iam_policy_document.ledger_resource.json).Statement :
        s.Effect == "Allow"
        && anytrue([for a in flatten([s.Action]) : a == c.action || a == "dynamodb:*" || a == "*" || (true && (strcontains(a, "*") || strcontains(a, "?")))])
        && anytrue([for r in flatten([s.Resource]) : r == "arn:aws:dynamodb:us-east-1:222222222222:table/gs-staging-ledger" || r == "*" || (true && (strcontains(r, "*") || strcontains(r, "?")))])
        && anytrue([for p in flatten([try(s.Principal.AWS, s.Principal, [])]) : p == "*" || p == try(c.principal, null) || p == "arn:aws:iam::${split(":", try(c.principal, null))[4]}:root" || (true && strcontains(p, "*"))])
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
    condition     = length([for s in jsondecode(data.aws_iam_policy_document.ledger_resource.json).Statement : s if s.Effect != "Allow"]) == 0
    error_message = "The document has no Deny statement (the evaluator models Allow only: a Deny would make an ALLOWED claim unsound)."
  }

  assert {
    condition     = toset(flatten([for s in jsondecode(data.aws_iam_policy_document.ledger_resource.json).Statement : flatten([s.Action]) if anytrue([for op, m in try(s.Condition, {}) : contains(flatten([try(m["aws:PrincipalArn"], [])]), "arn:aws:iam::111111111111:role/gs-staging-operator")])])) == toset(["dynamodb:GetItem", "dynamodb:Scan", "dynamodb:Query"])
    error_message = "Every action the ledger grants the operator: GetItem and Scan (unchanged) and Query (JX-4C) -- nothing else."
  }
}
