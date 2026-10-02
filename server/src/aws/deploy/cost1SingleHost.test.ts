// server/src/aws/deploy/cost1SingleHost.test.ts
//
// COST-1: the low-cost single-host deployment's MECHANICAL GUARDS (docs/hosting-budget.md). A future change that brings
// an expensive topology back into the active low-cost architecture fails here, unless the owner changes the budget
// decision -- this file, infra/aws/COST_BUDGET.json and docs/hosting-budget.md move together. What is pinned:
//   budget     the manifest's shape, the hard ceiling ($30) and target ($20), the items summing to the expected cost,
//              every listed configuration within the ceiling, and no Free Tier / credit counted
//   topology   the single-host module and stack (COST_BUDGET.json `scan_roots`) declare no prohibited resource type
//              (ALB, ECS, NAT, VPC endpoints, duplicated DynamoDB tables or KMS keys, a new CloudFront distribution,
//              autoscaling, databases, dashboards, ...), exactly ONE instance (no count / for_each) and ONE Elastic IP,
//              no provisioned DynamoDB capacity, standard CPU credits, no detailed monitoring, no SSH key, ONE pool,
//              the allowed instance types, the log-retention cap and the five alarms
//   exposure   the game server is published on 127.0.0.1 only; the security group admits 443 from CloudFront's prefix
//              list, 80 (ACME), and 22 only through the emergency variable -- never the server port; IMDSv2 required
//   secrets    no credential literal anywhere in the single-host files; no AWS credential env in the server's env
//   gate       stacks/app's compute = "none" gates every ECS-era fixed-cost resource (COST_BUDGET.json lists them)
//   kms        (P5-INT-1) the ledger's signing-key count -- the original three, the relayer rotation keys and JX-1K's
//              financial key sets -- is 3 by default (the budget's expected configuration) and 6 for the documented
//              LIVE-6 -> JX-1 transition (r2 + one financial pair), exactly max_kms_keys; no other key family exists. Keys
//              are prevent_destroy: getting back to 3 is a reviewed retirement (README "Relayer rotation"), never a tfvars edit

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

import { normalizeEol, readCheckoutText } from "../../testSupport/portability";

const REPO = path.resolve(__dirname, "../../../../../.."); // dist/server/src/aws/deploy -> the repository
/* RECON-1A W-03: every source assertion reads the checkout EOL-normalised (LIVE-6 W1's seam): a `$`-anchored or
   `\n`-split assertion means the same on a CRLF (Windows, core.autocrlf) checkout as on LF. The RAW bytes are judged
   separately, by the W-04 test below (the host's files must BE LF, not merely read as LF). */
const read = (rel: string): string => readCheckoutText(path.join(REPO, rel));

interface Budget {
  format: string;
  decision_record: string;
  currency: string;
  pricing_basis: string;
  hard_maximum_monthly: number;
  expected_target_monthly: number;
  expected_monthly: number;
  items: Array<{ service: string; monthly: number; basis: string }>;
  other_configurations: Record<string, number | string>;
  allowed_instance_types: string[];
  default_instance_type: string;
  max_instances: number;
  max_root_volume_gb: number;
  max_kms_keys: number;
  max_log_retention_days: number;
  max_alarms: number;
  prohibited_resource_types: string[];
  scan_roots: string[];
  ecs_era_compute_gate: { module: string; variable: string; low_cost_value: string; gated_resources: string[] };
  assumptions: string[];
}

const BUDGET = JSON.parse(read("infra/aws/COST_BUDGET.json")) as Budget;

/** Every file under the given repository-relative roots (recursively), as [relative path, text]. */
function filesUnder(roots: readonly string[], filter: (name: string) => boolean): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const walk = (rel: string): void => {
    const full = path.join(REPO, rel);
    for (const item of fs.readdirSync(full, { withFileTypes: true })) {
      const child = path.posix.join(rel, item.name);
      if (item.isDirectory()) {
        if (item.name === ".terraform") continue;
        walk(child);
      } else if (filter(item.name)) out.push([child, readCheckoutText(path.join(REPO, child))]);
    }
  };
  for (const root of roots) walk(root);
  return out;
}

/** HCL without comments (# and // line comments, block comments) -- crude but enough for declarations. */
function stripHcl(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => {
      let quoted = false;
      for (let i = 0; i < line.length; i += 1) {
        const c = line[i];
        if (c === '"' && line[i - 1] !== "\\") quoted = !quoted;
        if (!quoted && (c === "#" || (c === "/" && line[i + 1] === "/"))) return line.slice(0, i);
      }
      return line;
    })
    .join("\n");
}

const TF = filesUnder(BUDGET.scan_roots, (name) => name.endsWith(".tf")).map(([rel, text]) => [rel, stripHcl(text)] as const);
const TF_ALL = TF.map(([, text]) => text).join("\n");
const declared = (kind: "resource" | "data"): Array<{ type: string; name: string; file: string }> =>
  TF.flatMap(([file, text]) => [...text.matchAll(new RegExp(`^\\s*${kind}\\s+"([a-z0-9_]+)"\\s+"([A-Za-z0-9_-]+)"`, "gm"))].map((m) => ({ type: m[1], name: m[2], file })));
/** The body of `resource "<type>" "<name>" { ... }` (brace-matched). */
function body(type: string, name: string): string {
  const start = TF_ALL.search(new RegExp(`resource\\s+"${type}"\\s+"${name}"\\s*\\{`));
  assert.ok(start >= 0, `${type}.${name} is declared`);
  let depth = 0;
  for (let i = TF_ALL.indexOf("{", start); i < TF_ALL.length; i += 1) {
    if (TF_ALL[i] === "{") depth += 1;
    if (TF_ALL[i] === "}") {
      depth -= 1;
      if (depth === 0) return TF_ALL.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced ${type}.${name}`);
}

const HOST_FILES = filesUnder(["infra/aws/modules/single-host/files", "infra/aws/modules/single-host/templates", "infra/aws/single-host"], () => true);

describe("COST-1: the budget manifest", () => {
  test("its shape, ceiling and target are the owner's", () => {
    assert.equal(BUDGET.format, "18COSMOS/COST-BUDGET/v1");
    assert.equal(BUDGET.currency, "USD");
    assert.equal(BUDGET.hard_maximum_monthly, 30, "the owner's hard ceiling");
    assert.equal(BUDGET.expected_target_monthly, 20, "the owner's expected-cost target");
    assert.ok(fs.existsSync(path.join(REPO, BUDGET.decision_record)), "the decision record exists");
    assert.ok(read(BUDGET.decision_record).includes("COST_BUDGET.json"), "the decision record names the manifest");
    assert.ok(BUDGET.assumptions.length >= 5);
  });

  test("the items sum to the expected cost, which is within the target and the ceiling", () => {
    const sum = Math.round(BUDGET.items.reduce((total, item) => total + item.monthly, 0) * 100) / 100;
    assert.equal(sum, BUDGET.expected_monthly, `items sum ${sum}`);
    assert.ok(BUDGET.expected_monthly <= BUDGET.expected_target_monthly);
    assert.ok(BUDGET.expected_target_monthly <= BUDGET.hard_maximum_monthly);
    for (const item of BUDGET.items) {
      assert.ok(item.monthly >= 0 && item.basis.length > 10, item.service);
      assert.ok(!/free tier|credit|promotion/i.test(`${item.service} ${item.basis}`.replace(/no free tier for them/i, "")), `${item.service}: nothing free is counted`);
    }
  });

  test("every listed configuration stays within the hard ceiling", () => {
    for (const [name, value] of Object.entries(BUDGET.other_configurations)) {
      if (typeof value === "number") assert.ok(value <= BUDGET.hard_maximum_monthly, `${name}: ${value}`);
      else assert.match(value, /^\+\d+\.\d\d$/, name);
    }
    const worst = Math.max(...Object.values(BUDGET.other_configurations).filter((v): v is number => typeof v === "number"));
    const extras = Object.values(BUDGET.other_configurations).filter((v): v is string => typeof v === "string").reduce((t, v) => t + Number(v.slice(1)), 0);
    assert.ok(worst + extras <= BUDGET.hard_maximum_monthly, `the worst listed configuration with every listed extra: ${worst + extras}`);
  });
});

describe("COST-1: the active low-cost topology (single-host module + stack)", () => {
  test("no prohibited resource type is declared", () => {
    const found = declared("resource").filter((r) => BUDGET.prohibited_resource_types.includes(r.type));
    assert.deepEqual(found, [], "a prohibited (fixed-cost or duplicated) resource needs an owner budget decision");
    for (const r of declared("resource")) assert.ok(!/^aws_(lb|alb|ecs|nat|vpc_endpoint|eks|rds|db_|elasticache|globalaccelerator|apprunner)/.test(r.type), `${r.file}: ${r.type}`);
  });

  test("the stack instantiates only the single-host module", () => {
    const stack = TF.filter(([file]) => file.startsWith("infra/aws/stacks/single-host/")).map(([, text]) => text).join("\n");
    const modules = [...stack.matchAll(/module\s+"[^"]+"\s*\{[^}]*?source\s*=\s*"([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(modules, ["../../modules/single-host"]);
    assert.ok(!/modules\/app|modules\/ledger/.test(stack), "the low-cost stack never instantiates the ECS-era modules");
  });

  test("exactly ONE application host, ONE Elastic IP, ONE ENI -- never counted, never for_each", () => {
    const of = (type: string) => declared("resource").filter((r) => r.type === type);
    assert.equal(of("aws_instance").length, BUDGET.max_instances);
    assert.equal(of("aws_eip").length, 1);
    assert.equal(of("aws_network_interface").length, 1);
    for (const [type, name] of [["aws_instance", "host"], ["aws_eip", "host"], ["aws_network_interface", "host"]]) {
      assert.ok(!/^\s*(count|for_each)\s*=/m.test(body(type, name)), `${type}.${name} has no count / for_each`);
    }
  });

  test("ONE pool: the module takes a pool id, never a pool map", () => {
    const vars = read("infra/aws/modules/single-host/variables.tf");
    assert.match(vars, /variable "pool" \{[\s\S]*?type\s+=\s+string/);
    assert.ok(!/variable "pools"/.test(vars));
  });

  test("burstable credits standard, no detailed monitoring, no SSH key, IMDSv2 required", () => {
    const host = body("aws_instance", "host");
    assert.match(host, /cpu_credits\s*=\s*"standard"/);
    assert.ok(!/unlimited/.test(TF_ALL), "never CPU credits unlimited");
    assert.match(host, /monitoring\s*=\s*false/);
    assert.ok(!/key_name/.test(host), "no SSH key pair");
    assert.match(host, /http_tokens\s*=\s*"required"/);
    assert.match(host, /http_put_response_hop_limit\s*=\s*2/);
  });

  test("no provisioned capacity, no Container Insights, the instance types and log retention of the manifest", () => {
    assert.ok(!/PROVISIONED|read_capacity|write_capacity|containerInsights/.test(TF_ALL));
    const vars = read("infra/aws/modules/single-host/variables.tf");
    const allowed = /contains\(\[([^\]]+)\], var\.instance\.type\)/.exec(vars)?.[1].split(",").map((s) => s.trim().replace(/"/g, ""));
    assert.deepEqual(allowed, BUDGET.allowed_instance_types);
    assert.match(vars, new RegExp(`type\\s+=\\s+optional\\(string, "${BUDGET.default_instance_type}"\\)`));
    const retention = /contains\(\[([0-9, ]+)\], var\.log_retention_days\)/.exec(vars)?.[1].split(",").map(Number) ?? [];
    assert.ok(retention.length > 0 && Math.max(...retention) <= BUDGET.max_log_retention_days);
    assert.match(vars, /var\.instance\.root_volume_gb <= (\d+)/);
    assert.ok(Number(/var\.instance\.root_volume_gb <= (\d+)/.exec(vars)![1]) <= BUDGET.max_root_volume_gb);
  });

  test("the observability tier is the manifest's alarms (no composite, no dashboard)", () => {
    assert.equal(declared("resource").filter((r) => r.type === "aws_cloudwatch_metric_alarm").length, BUDGET.max_alarms);
  });
});

describe("COST-1: exposure and credentials", () => {
  test("the game server is published on 127.0.0.1 only; Caddy proxies to the loopback", () => {
    const run = read("infra/aws/modules/single-host/files/bin/gs-run");
    assert.match(run, /-p "127\.0\.0\.1:\$\{GS_CONTAINER_PORT\}:\$\{GS_CONTAINER_PORT\}"/);
    assert.ok(!/--network\s+host/.test(run), "the server never shares the host network");
    assert.ok(!/(^|\s)-p\s+"?(0\.0\.0\.0:)?\$\{?GS_CONTAINER_PORT/m.test(run));
    assert.match(read("infra/aws/modules/single-host/templates/Caddyfile.tftpl"), /reverse_proxy 127\.0\.0\.1:\$\{container_port\}/);
  });

  test("the security group admits 443 from CloudFront, 80 for ACME, 22 only by the emergency variable -- never the server port", () => {
    const ingress = declared("resource").filter((r) => r.type === "aws_vpc_security_group_ingress_rule");
    assert.deepEqual(ingress.map((r) => r.name).sort(), ["acme_http01", "emergency_ssh", "https_from_cloudfront"]);
    assert.match(body("aws_vpc_security_group_ingress_rule", "https_from_cloudfront"), /prefix_list_id\s*=\s*data\.aws_ec2_managed_prefix_list\.cloudfront_origin_facing\.id/);
    assert.match(body("aws_vpc_security_group_ingress_rule", "acme_http01"), /from_port\s*=\s*80\s/);
    assert.match(body("aws_vpc_security_group_ingress_rule", "emergency_ssh"), /for_each\s*=\s*toset\(var\.emergency_ssh_cidrs\)/);
    assert.ok(!/from_port\s*=\s*(8917|var\.container_port)/.test(TF_ALL), "no rule for the game server's port");
    assert.ok(!/associate_public_ip_address\s*=\s*true/.test(TF_ALL));
  });

  test("no credential literal in any single-host file; the server's environment carries references only", () => {
    const credential = /(^|\s)(export\s+)?(AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN)\s*=|\b(AKIA|ASIA)[0-9A-Z]{16}\b|BEGIN [A-Z ]*PRIVATE KEY|aws_secret_access_key/;
    for (const [file, text] of [...HOST_FILES, ...TF]) assert.ok(!credential.test(text), `${file} carries no credential`);
    const env = read("infra/aws/modules/single-host/templates/server.env.tftpl");
    for (const line of env.split("\n").filter((l) => /^[A-Z]/.test(l))) {
      assert.match(line, /^(GS_MODE|GS_STORAGE|GS_AWS_CONFIG_PARAMETER|PORT|GS_ALLOWED_ORIGINS|GS_TRUSTED_PROXY_HOPS|GS_METRICS_PROFILE|ESCROW_MONEY_TABLES|GS_EDGE_DIAGNOSTIC)=/, line);
    }
    assert.match(env, /^GS_STORAGE=aws$/m);
    assert.match(env, /^GS_METRICS_PROFILE=single-host$/m);
    assert.ok(!/AmazonSSMManagedInstanceCore|AdministratorAccess|PowerUserAccess/.test(TF_ALL), "no broad managed policy");
  });
});

describe("COST-1: stacks/app's ECS-era compute gate, and no new topology elsewhere", () => {
  const gate = BUDGET.ecs_era_compute_gate;
  const app = filesUnder([gate.module], (name) => name.endsWith(".tf")).map(([, text]) => stripHcl(text)).join("\n");
  /** The brace-matched body of `resource "<type>" "<name>"` in the app module. */
  const appBody = (type: string, name: string): string => {
    const start = app.search(new RegExp(`resource\\s+"${type}"\\s+"${name}"\\s*\\{`));
    assert.ok(start >= 0, `${type}.${name} exists`);
    let depth = 0;
    for (let i = app.indexOf("{", start); i < app.length; i += 1) {
      if (app[i] === "{") depth += 1;
      if (app[i] === "}" && --depth === 0) return app.slice(start, i + 1);
    }
    throw new Error(`unbalanced ${type}.${name}`);
  };
  const GATED = /^\s*(count|for_each)\s*=\s*[^\n]*(local\.ecs\b|local\.ecs_one|local\.ecs_pools|local\.alarm_keys)/m;

  test("compute is \"ecs\" by default (LIVE-6 unchanged) and \"none\" is accepted", () => {
    assert.match(app, /variable "compute" \{[\s\S]*?default\s+=\s+"ecs"/);
    assert.match(app, /contains\(\["ecs", "none"\], var\.compute\)/);
  });

  test("every listed ECS-era fixed-cost resource is gated on compute", () => {
    for (const address of gate.gated_resources) {
      const [type, name] = address.split(".");
      assert.match(appBody(type, name), GATED, `${address} is gated on compute`);
    }
    assert.match(app, /alarm_keys\s*=\s*local\.ecs \?/, "the L6-5B alarm matrix is gated");
  });

  test("ANY prohibited resource type in the app module is gated on compute (a new ALB / NAT / endpoint there cannot slip in)", () => {
    const legitimately_kept = new Set(["aws_dynamodb_table", "aws_cloudfront_distribution"]); // the authorities and the edge
    const resources = [...app.matchAll(/^\s*resource\s+"([a-z0-9_]+)"\s+"([A-Za-z0-9_-]+)"/gm)].map((m) => ({ type: m[1], name: m[2] }));
    for (const r of resources) {
      if (!BUDGET.prohibited_resource_types.includes(r.type) || legitimately_kept.has(r.type)) continue;
      assert.match(appBody(r.type, r.name), GATED, `${r.type}.${r.name} (prohibited in the low-cost topology) must be gated on compute`);
    }
  });

  test("no new stack or module appears without an owner budget decision", () => {
    const dirs = (rel: string) => fs.readdirSync(path.join(REPO, rel), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
    assert.deepEqual(dirs("infra/aws/stacks"), ["app", "ledger", "single-host"]);
    assert.deepEqual(dirs("infra/aws/modules"), ["app", "ledger", "single-host"]);
  });
});

describe("P5-INT-1: the ledger's signing keys under max_kms_keys (COST-1 x JX-1K)", () => {
  const ledgerMain = stripHcl(read("infra/aws/modules/ledger/main.tf"));
  const ledgerVars = stripHcl(read("infra/aws/modules/ledger/variables.tf"));
  const example = read("infra/aws/stacks/ledger/example.tfvars.example");
  /** The key count stacks/ledger creates for a configuration, by the module's own composition (pinned below). */
  const keyCount = (relayerKeyCount: number, financialKeySets: readonly string[]): number => 3 + (relayerKeyCount - 1) + 2 * financialKeySets.length;

  test("the module's signing keys are exactly the original three, the rotation keys and two per financial key set", () => {
    assert.match(
      ledgerMain,
      /signing_purpose\s*=\s*var\.signing_keys_enabled \? toset\(concat\(\["relayer", "settlement", "admission"\], \[for label in local\.relayer_rotation_labels : "relayer-\$\{label\}"\], local\.financial_key_purposes\)\) : toset\(\[\]\)/,
      "a new signing-key family needs this guard (and an owner budget decision)",
    );
    assert.match(ledgerMain, /relayer_rotation_labels\s*=\s*\[for n in range\(2, var\.relayer_key_count \+ 1\) : "r\$\{n\}"\]/);
    assert.match(ledgerMain, /financial_key_purposes\s*=\s*flatten\(\[for label in var\.financial_key_sets : \["settlement-\$\{label\}", "admission-\$\{label\}"\]\]\)/);
    assert.equal([...ledgerMain.matchAll(/resource\s+"aws_kms_key"/g)].length, 1, "one aws_kms_key resource (aws_kms_key.signing) in the ledger");
  });

  test("the defaults are the budget's expected configuration: three keys (after JX-1 the extra keys stay -- prevent_destroy -- until a reviewed retirement)", () => {
    assert.match(ledgerVars, /variable "relayer_key_count" \{[\s\S]*?default\s+=\s+1\s/);
    assert.match(ledgerVars, /variable "financial_key_sets" \{[\s\S]*?default\s+=\s+\[\]/);
    const kms = BUDGET.items.find((item) => /^KMS signing keys \(3\)/.test(item.service));
    assert.ok(kms, "the expected cost counts exactly 3 KMS keys");
  });

  test("the documented LIVE-6 -> JX-1 transition (r2 + the jx1 pair) is exactly max_kms_keys, priced as listed", () => {
    const rotation = /^#\s*relayer_key_count\s*=\s*(\d+)\s*$/m.exec(example);
    const sets = /^#\s*financial_key_sets\s*=\s*(\[[^\]]*\])\s*$/m.exec(example);
    assert.ok(rotation && sets, "stacks/ledger/example.tfvars.example documents the rotation and the financial key set");
    const transition = keyCount(Number(rotation[1]), JSON.parse(sets[1]) as string[]);
    assert.equal(transition, 6);
    assert.equal(transition, BUDGET.max_kms_keys, "the transition fits max_kms_keys -- and uses all of it");
    assert.equal(BUDGET.other_configurations["LIVE-6 -> JX-1 transition: up to 6 KMS keys"], `+${(BUDGET.max_kms_keys - 3).toFixed(2)}`, "$1 per key-month beyond the three");
    assert.ok(keyCount(Number(rotation[1]), [...(JSON.parse(sets[1]) as string[]), "jx2"]) > BUDGET.max_kms_keys, "a second financial key set during the transition needs an owner budget decision");
    assert.ok(keyCount(Number(rotation[1]) + 1, JSON.parse(sets[1]) as string[]) > BUDGET.max_kms_keys, "a further rotation during the transition needs an owner budget decision");
  });

  test("the single host signs with exactly the three configured keys, whichever set they come from", () => {
    const hostVars = read("infra/aws/modules/single-host/variables.tf");
    assert.match(hostVars, /variable "signing_keys" \{[\s\S]*?relayer\s+=\s+string\s+settlement\s+=\s+string\s+admission\s+=\s+string/);
    assert.match(hostVars, /length\(distinct\(values\(var\.signing_keys\)\)\) == 3/);
    const iam = stripHcl(read("infra/aws/modules/single-host/iam.tf"));
    assert.equal([...iam.matchAll(/Resource\s*=\s*try\(values\(var\.signing_keys\), \[\]\)/g)].length, 2, "GetPublicKey and Sign name exactly the configured key ARNs");
    assert.ok(!/kms:CreateGrant|kms:\*|"kms:Sign\*"/.test(iam), "no grant, no wildcard KMS action (comments stripped)");
  });
});

/* ------------------------------------------------------------------ */
/* RECON-1A W-04: the host's files are LF in every checkout             */
/* ------------------------------------------------------------------ */

/** Every file whose bytes reach or run on the Linux host, or drive it: embedded verbatim into the user data by
 *  modules/single-host/locals.tf (files/**, templates/**), the operator's bash twins, the module's bash harnesses. */
const HOST_INPUT_ROOTS = ["infra/aws/modules/single-host/files", "infra/aws/modules/single-host/templates"];
const hostInputs = (): string[] => {
  const out: string[] = [];
  const walk = (rel: string): void => {
    for (const item of fs.readdirSync(path.join(REPO, rel), { withFileTypes: true })) {
      const child = path.posix.join(rel, item.name);
      if (item.isDirectory()) walk(child);
      else out.push(child);
    }
  };
  for (const root of HOST_INPUT_ROOTS) walk(root);
  for (const dir of ["infra/aws/single-host", "infra/aws/modules/single-host/tests"]) for (const f of fs.readdirSync(path.join(REPO, dir))) if (f.endsWith(".sh")) out.push(path.posix.join(dir, f));
  return out.sort();
};
/** The RAW checkout bytes (never normalised): what Terraform's file() / templatefile() embeds and what bash executes. */
const rawCrOffenders = (files: readonly string[], readRaw: (rel: string) => Buffer = (rel) => fs.readFileSync(path.join(REPO, rel))): string[] => files.filter((f) => readRaw(f).includes(0x0d));
/** .gitattributes' `eol=lf` patterns (gitattributes glob: `**` any path, `*` within one segment). */
function lfPatterns(text: string): RegExp[] {
  return normalizeEol(text)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#"))
    .map((l) => l.split(/\s+/))
    .filter((parts) => parts.slice(1).includes("eol=lf"))
    .map(([pattern]) => new RegExp(`^${pattern.split("**").map((seg) => seg.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]")).join(".*")}$`));
}

describe("RECON-1A W-04: the single host's files are LF whatever core.autocrlf says", () => {
  const files = hostInputs();
  test("the inventory is the module's: every embedded script, unit and template, the operator's bash twins and the harnesses", () => {
    const locals = read("infra/aws/modules/single-host/locals.tf");
    for (const m of locals.matchAll(/(host_scripts|systemd_units)\s*=\s*(\[[^\]]*\])/g)) {
      const dir = m[1] === "host_scripts" ? "bin" : "systemd";
      for (const f of JSON.parse(m[2]) as string[]) assert.ok(files.includes(`infra/aws/modules/single-host/files/${dir}/${f}`), `${dir}/${f} is in the inventory`);
    }
    for (const t of ["Caddyfile.tftpl", "cloud-init.yaml.tftpl", "host.env.tftpl", "server.env.tftpl"]) assert.ok(files.includes(`infra/aws/modules/single-host/templates/${t}`), t);
    for (const f of ["infra/aws/single-host/gs-host.sh", "infra/aws/single-host/build-image.sh", "infra/aws/modules/single-host/tests/host-scripts.test.sh"]) assert.ok(files.includes(f), f);
    assert.ok(files.length >= 25, `${files.length} host inputs`);
  });
  test("no host input carries a carriage return (the raw checkout bytes)", () => {
    assert.deepEqual(rawCrOffenders(files), [], "a CR here ships `#!/usr/bin/env bash\\r` / CRLF units to the host and REPLACES it (user_data_replace_on_change)");
  });
  test("the detector is not vacuous: a CRLF copy of a host script is caught", () => {
    const fake = new Map<string, Buffer>([["gs-deploy", Buffer.from("#!/usr/bin/env bash\r\nset -euo pipefail\r\n")], ["gs-run", Buffer.from("#!/usr/bin/env bash\nexit 0\n")]]);
    assert.deepEqual(rawCrOffenders(["gs-deploy", "gs-run"], (f) => fake.get(f)!), ["gs-deploy"]);
  });
  test(".gitattributes pins every host input eol=lf (so a Windows core.autocrlf=true checkout writes LF)", () => {
    const patterns = lfPatterns(read(".gitattributes"));
    const unpinned = files.filter((f) => !patterns.some((re) => re.test(f)));
    assert.deepEqual(unpinned, [], "each host input must match an eol=lf pattern");
    /* and nothing beyond the host surface was swept in: the module's Terraform and the Windows twins stay text=auto */
    for (const f of ["infra/aws/modules/single-host/locals.tf", "infra/aws/single-host/gs-host.ps1", "infra/aws/modules/single-host/README.md", "server/src/aws/deploy/hostVerify.ts"]) assert.ok(!patterns.some((re) => re.test(f)), `${f} is not pinned`);
  });
  const git = spawnSync("git", ["-C", REPO, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8" });
  test("git itself resolves eol=lf for every host input", { skip: git.status === 0 && git.stdout.trim() === "true" ? false : "not a git checkout (the .gitattributes test above still holds)" }, () => {
    const r = spawnSync("git", ["-C", REPO, "check-attr", "eol", "--", ...files], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const answers = normalizeEol(r.stdout).trim().split("\n");
    assert.equal(answers.length, files.length);
    for (const a of answers) assert.match(a, /: eol: lf$/, a);
  });
});

