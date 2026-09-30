// server/src/aws/operator/l6_3Operator.test.ts
//
// ==================================================================
//  LIVE-6 L6-3: THE AWS OPERATOR TOOLING WITHOUT A TABLE -- REFERENCES, REFUSALS, PARSERS, VERDICTS, NO SECRET, FILE MODE UNCHANGED
// ==================================================================
//
// `npm test` (no DynamoDB). The table behaviour -- the CAS, the fences, the races, lost answers, dry runs writing nothing --
// is `persistence/conformance/operatorTooling.dynamoLocal.test.ts` (`npm run test:dynamodb-local`). Here:
//   1. the deployment is named exactly as an AWS task names it (L5-7's SSM reference and runtime document), fail closed:
//      static keys, a data directory, an escrow file, a missing / conflicting / malformed reference, a SecureString, a
//      document that does not check -- each refused, by NAME, never echoing a value;
//   2. the HEAD and pool-item parsers read exactly what the writers write, and nothing else (an unknown attribute on the
//      fence item is a later build's: never acted on);
//   3. the claim / take / release verdicts are the production rules (released -> claim; superseded -> take; CURRENT ->
//      stopped, with the reason; operator -> release only by its run);
//   4. notes, run ids, arguments;
//   5. nothing printed carries a credential or a configuration's content;
//   6. the file mode is unchanged and loads no AWS code: the `aws` entry is dynamic, and a real file-mode run loads no
//      AWS module at all.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { DynamoDBClient } from "@aws-sdk/client-dynamodb";

import { headKey, NO_OWNER, poolKey, type Item } from "../game/gameTable";
import { ssmParameterSource, type ParameterSource } from "../runtime/configSource";
import { claimVerdict, HEAD_ATTRIBUTES, ItemUnreadableError, LIVE_OWNER_TAKE_STOPPED, parseHeadItem, parsePoolItem, releaseVerdict, takeVerdict, type HeadView, type OwnerStatus, type Read } from "./inspect";
import { newOperatorRun, noteProblem, OPERATOR_RUN } from "./mutations";
import { AWS_USAGE, EXIT, parseOperatorArgs, runAwsOperator } from "./operatorMain";
import { OperatorRefusal, resolveOperatorTarget } from "./operatorTarget";
import { normalizeEol, readCheckoutText } from "../../testSupport/portability";

const RUNTIME_ARN = "arn:aws:ssm:us-east-1:123456789012:parameter/gs/prod/runtime";
const ESCROW_ARN = "arn:aws:ssm:us-east-1:123456789012:parameter/gs/prod/escrow";
const LEDGER_ARN = "arn:aws:dynamodb:us-east-1:210987654321:table/gs-prod-ledger";
const DOC = { format: "18COSMOS/AWS-RUNTIME/v1", environment: "prod", region: "us-east-1", pool: "p1", generation: 1, game_table: "gs-prod-game-g1", identity_table: "gs-prod-identity", ledger_table_arn: LEDGER_ARN, escrow: null };
const SECRET_VALUES = { AWS_ACCESS_KEY_ID: "AKIAHOSTILEHOSTILE00", AWS_SECRET_ACCESS_KEY: "hostile-secret-value-do-not-print", AWS_SESSION_TOKEN: "hostile-session-token-do-not-print" };

/** A fake SSM source: the documents by ARN (a value, or an error to throw). */
function parameters(values: Record<string, string | Error>): ParameterSource & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    async read(arn) {
      reads.push(arn);
      const value = values[arn];
      if (value === undefined) throw new Error(`no parameter ${arn}`);
      if (value instanceof Error) throw value;
      return { value, version: 7, arn };
    },
  };
}

/** A DynamoDB client that must never be asked anything (these tests stop before the table), or that fails every call. */
function stubClient(mode: "never" | "fails" = "never"): DynamoDBClient & { sent: number } {
  const stub = {
    sent: 0,
    async send() {
      stub.sent += 1;
      if (mode === "never") throw new Error("a stub client was asked to send");
      throw Object.assign(new Error("simulated: the endpoint did not answer"), { name: "TimeoutError" });
    },
    destroy() {
      /* nothing */
    },
  };
  return stub as unknown as DynamoDBClient & { sent: number };
}

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, sink: { out: (line: string) => out.push(line), err: (line: string) => err.push(line) } };
}

/* ==================================================================
    1. THE DEPLOYMENT REFERENCE (L5-7's model), FAIL CLOSED
   ================================================================== */
describe("L6-3 the deployment is named by L5-7's reference model, fail closed", () => {
  test("the SSM reference and the runtime document are read exactly as an AWS task reads them; the clients get the document's regions", async () => {
    const regions: string[] = [];
    const target = await resolveOperatorTarget({
      argv: ["--aws-config", RUNTIME_ARN],
      env: {},
      parameters: parameters({ [RUNTIME_ARN]: JSON.stringify({ ...DOC, ledger_table_arn: "arn:aws:dynamodb:eu-west-1:210987654321:table/gs-prod-ledger" }) }),
      clientFor: (t) => {
        regions.push(t.kind === "aws" ? t.region : "local");
        return stubClient();
      },
    });
    assert.equal(target.kind, "aws");
    assert.deepEqual(target.tables, { game: "gs-prod-game-g1", identity: "gs-prod-identity", ledger: "arn:aws:dynamodb:eu-west-1:210987654321:table/gs-prod-ledger" }, "the ledger is addressed by its full ARN (cross-account)");
    assert.deepEqual(regions, ["us-east-1", "eu-west-1"], "one client per region, the regions the document names");
    assert.deepEqual(target.source, { arn: RUNTIME_ARN, version: 7, file: null });
    assert.deepEqual(target.escrow, { state: "none" });
    const viaEnv = await resolveOperatorTarget({ argv: [], env: { GS_AWS_CONFIG_PARAMETER: RUNTIME_ARN }, parameters: parameters({ [RUNTIME_ARN]: JSON.stringify(DOC) }), clientFor: () => stubClient() });
    assert.equal(viaEnv.config.pool, "p1");
  });

  test("refused, by name and never by value: static keys, a data directory, an escrow file, no reference, two references, a malformed ARN, a document that does not check", async () => {
    const good = parameters({ [RUNTIME_ARN]: JSON.stringify(DOC) });
    const refuse = async (argv: string[], env: Record<string, string>, source: ParameterSource = good) => {
      try {
        await resolveOperatorTarget({ argv, env, parameters: source, clientFor: () => stubClient() });
      } catch (error) {
        assert.ok(error instanceof OperatorRefusal, String(error));
        for (const value of Object.values(SECRET_VALUES)) assert.ok(!error.message.includes(value), "a credential's VALUE is never in a message");
        return error.message;
      }
      assert.fail(`not refused: ${argv.join(" ")} ${JSON.stringify(Object.keys(env))}`);
    };
    assert.match(await refuse(["--aws-config", RUNTIME_ARN], SECRET_VALUES), /AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN are set/);
    assert.match(await refuse(["--aws-config", RUNTIME_ARN], { AWS_SESSION_TOKEN: SECRET_VALUES.AWS_SESSION_TOKEN }), /AWS_SESSION_TOKEN is set/);
    assert.match(await refuse(["--aws-config", RUNTIME_ARN, "--data", "/srv/data"], {}), /--data is a file-mode setting/);
    assert.match(await refuse(["--aws-config", RUNTIME_ARN, "--escrow-config", "x.json"], {}), /--escrow-config is a file-mode setting/);
    assert.match(await refuse([], {}), /GS_AWS_CONFIG_PARAMETER \(or --aws-config\) is required/);
    assert.match(await refuse(["--aws-config", RUNTIME_ARN], { GS_AWS_CONFIG_PARAMETER: RUNTIME_ARN.replace("prod", "stage") }), /disagree/);
    assert.match(await refuse(["--aws-config", "gs/prod/runtime"], {}), /not an SSM parameter ARN/);
    assert.match(await refuse(["--aws-config", `${RUNTIME_ARN}:3`], {}), /not an SSM parameter ARN/, "no version selector");
    assert.match(await refuse(["--aws-config", RUNTIME_ARN], {}, parameters({ [RUNTIME_ARN]: JSON.stringify({ ...DOC, pool: "op:r-1" }) })), /pool: an operator run/);
    assert.match(await refuse(["--aws-config", RUNTIME_ARN], {}, parameters({ [RUNTIME_ARN]: JSON.stringify({ ...DOC, extra: 1 }) })), /unknown field extra/);
    assert.match(await refuse(["--aws-config", RUNTIME_ARN, "--relayer", "juno1abc"], {}), /--relayer is for DynamoDB Local only/);
  });

  test("a SecureString is refused (a secret never goes in the configuration), and its value is never read into a message", async () => {
    const fake = {
      async send() {
        return { Parameter: { Type: "SecureString", ARN: RUNTIME_ARN, Name: "/gs/prod/runtime", Version: 3, Value: "hostile-secret-value-do-not-print" } };
      },
      destroy() {
        /* nothing */
      },
    } as unknown as ReturnType<NonNullable<NonNullable<Parameters<typeof ssmParameterSource>[0]>["client"]>>; // no SSM import outside the configuration source
    await assert.rejects(
      resolveOperatorTarget({ argv: ["--aws-config", RUNTIME_ARN], env: {}, parameters: ssmParameterSource({ client: () => fake }), clientFor: () => stubClient() }),
      (error: Error) => error instanceof OperatorRefusal && /SecureString/.test(error.message) && !error.message.includes("hostile-secret-value-do-not-print"),
    );
  });

  test("the escrow configuration gives the relayer ACCOUNT only; one that does not check is reported and the relayer is not inspected -- nothing else refuses", async () => {
    const withEscrow = JSON.stringify({ ...DOC, escrow: { config_parameter_arn: ESCROW_ARN } });
    const broken = await resolveOperatorTarget({ argv: ["--aws-config", RUNTIME_ARN], env: {}, parameters: parameters({ [RUNTIME_ARN]: withEscrow, [ESCROW_ARN]: "{not json" }), clientFor: () => stubClient() });
    assert.equal(broken.escrow.state, "unreadable");
    assert.match((broken.escrow as { detail: string }).detail, /not JSON/);
    const missing = await resolveOperatorTarget({ argv: ["--aws-config", RUNTIME_ARN], env: {}, parameters: parameters({ [RUNTIME_ARN]: withEscrow }), clientFor: () => stubClient() });
    assert.equal(missing.escrow.state, "unreadable");
  });

  test("DynamoDB Local: only with GS_DYNAMODB_LOCAL_ENDPOINT on loopback and --local-document; its tables are the document's; --relayer names the account", async () => {
    const readFile = async () => JSON.stringify({ ...DOC, escrow: { config_parameter_arn: ESCROW_ARN } });
    const seen: string[] = [];
    const clientFor = (t: { kind: string; endpoint?: string; region?: string }) => {
      seen.push(t.kind === "dynamodb-local" ? (t.endpoint as string) : (t.region as string));
      return stubClient();
    };
    const local = await resolveOperatorTarget({ argv: ["--local-document", "doc.json"], env: { GS_DYNAMODB_LOCAL_ENDPOINT: "http://127.0.0.1:8000", ...SECRET_VALUES }, readFile, clientFor });
    assert.equal(local.kind, "dynamodb-local");
    assert.deepEqual(local.tables, { game: "gs-prod-game-g1", identity: "gs-prod-identity", ledger: "gs-prod-ledger" }, "the ledger ARN's table part is the local table");
    assert.deepEqual(local.escrow, { state: "not-read", arn: ESCROW_ARN }, "no SSM locally");
    assert.deepEqual(seen, ["http://127.0.0.1:8000"]);
    const named = await resolveOperatorTarget({ argv: ["--local-document", "doc.json", "--relayer", "juno1relayer0000000000000000000000000000000"], env: { GS_DYNAMODB_LOCAL_ENDPOINT: "http://127.0.0.1:8000" }, readFile, clientFor });
    assert.deepEqual(named.escrow, { state: "ok", arn: null, version: null, relayer: "juno1relayer0000000000000000000000000000000" });
    await assert.rejects(resolveOperatorTarget({ argv: ["--local-document", "doc.json"], env: {}, readFile, clientFor }), /set GS_DYNAMODB_LOCAL_ENDPOINT/);
    await assert.rejects(resolveOperatorTarget({ argv: ["--local-document", "doc.json"], env: { GS_DYNAMODB_LOCAL_ENDPOINT: "https://dynamodb.us-east-1.amazonaws.com" }, readFile, clientFor }), OperatorRefusal);
    await assert.rejects(resolveOperatorTarget({ argv: ["--local-document", "doc.json", "--aws-config", RUNTIME_ARN], env: { GS_DYNAMODB_LOCAL_ENDPOINT: "http://127.0.0.1:8000" }, readFile, clientFor }), /two deployments/);
    await assert.rejects(resolveOperatorTarget({ argv: ["--local-document", "doc.json", "--relayer", "Not An Account"], env: { GS_DYNAMODB_LOCAL_ENDPOINT: "http://127.0.0.1:8000" }, readFile, clientFor }), /not a relayer account/);
  });
});

/* ==================================================================
    2. THE HEAD AND THE POOL ITEM, AS THEIR WRITERS WRITE THEM
   ================================================================== */
const G = "g_0000000000000000000000000a";
const S = (value: string) => ({ S: value });
const N = (value: number) => ({ N: String(value) });

describe("L6-3 the HEAD and the pool item are read exactly as written, and nothing else", () => {
  test("a HEAD made by a creation, one claimed since, and a released one", () => {
    const created: Item = { ...headKey(G), owner_pool: S("p1"), pool_epoch: N(3), log_next_index: N(0), log_bytes: N(0) };
    assert.deepEqual(parseHeadItem(created, G), { owner_pool: "p1", pool_epoch: 3, owner_task: null, log_next_index: 0, log_bytes: 0 });
    assert.equal(parseHeadItem({ ...created, owner_task: S("t-abc") }, G).owner_task, "t-abc");
    assert.equal(parseHeadItem({ ...created, owner_pool: S(NO_OWNER) }, G).owner_pool, NO_OWNER);
    assert.equal(parseHeadItem({ ...created, owner_pool: S("op:r-0123456789abcdef") }, G).owner_pool, "op:r-0123456789abcdef");
    assert.deepEqual([...HEAD_ATTRIBUTES].sort(), ["log_bytes", "log_next_index", "owner_pool", "owner_task", "pk", "pool_epoch", "sk"]);
  });

  test("damage is `corrupt` and an attribute this build never writes is `newer` -- the fence item is never acted on unless fully understood", () => {
    const base: Item = { ...headKey(G), owner_pool: S("p1"), pool_epoch: N(3), log_next_index: N(0), log_bytes: N(0) };
    const cases: Array<[Item, "corrupt" | "newer"]> = [
      [{ ...base, claim_gen: N(1) }, "newer"],
      [{ ...base, pool_epoch: S("3") }, "corrupt"],
      [{ ...base, pool_epoch: N(0) }, "corrupt"],
      [{ ...base, pool_epoch: { N: "03" } }, "corrupt"],
      [{ ...base, owner_pool: S("") }, "corrupt"],
      [{ ...base, owner_pool: N(1) }, "corrupt"],
      [{ ...base, owner_task: N(1) }, "corrupt"],
      [{ ...base, log_next_index: S("0") }, "corrupt"],
      [{ ...headKey("g_0000000000000000000000000b"), owner_pool: S("p1"), pool_epoch: N(1), log_next_index: N(0), log_bytes: N(0) }, "corrupt"],
    ];
    for (const [item, format] of cases) {
      assert.throws(() => parseHeadItem(item, G), (error: ItemUnreadableError) => error instanceof ItemUnreadableError && error.format === format, JSON.stringify(item));
    }
  });

  test("the pool item: epoch and task required (as the pool writer's self-check); an attribute this build never writes is listed", () => {
    const pool: Item = { ...poolKey("p1"), writer_epoch: N(4), writer_task: S("t-1"), taken_at: N(10) };
    assert.deepEqual(parsePoolItem(pool, "p1"), { pool: "p1", writer_epoch: 4, writer_task: "t-1", taken_at: 10, extra: [] });
    assert.deepEqual(parsePoolItem({ ...pool, status: S("retired") }, "p1").extra, ["status"]);
    for (const bad of [{ ...pool, writer_epoch: S("4") }, { ...pool, writer_task: N(1) }, { ...pool, taken_at: S("x") }, { ...poolKey("p2"), writer_epoch: N(1), writer_task: S("t") }]) {
      assert.throws(() => parsePoolItem(bad, "p1"), ItemUnreadableError);
    }
  });
});

/* ==================================================================
    3. THE PRODUCTION RULES FOR CLAIM / TAKE / RELEASE
   ================================================================== */
describe("L6-3 the operator's claim / take / release verdicts", () => {
  const head = (owner_pool: string, pool_epoch = 2): Read<HeadView> => ({ state: "ok", value: { owner_pool, pool_epoch, owner_task: null, log_next_index: 0, log_bytes: 0 } });
  const owner = (cls: OwnerStatus["class"], owner_pool: string, extra: string[] = []): OwnerStatus => ({
    class: cls,
    owner_pool,
    owner_epoch: 2,
    owner_task: null,
    pool: { state: "ok", value: { pool: owner_pool, writer_epoch: cls === "superseded" ? 3 : 2, writer_task: "t", taken_at: 0, extra } },
    detail: `${cls} detail`,
  });

  test("released -> claim only; superseded -> take only; CURRENT -> neither (the live-owner take is stopped, and says why); operator -> release by its own run only", () => {
    assert.deepEqual([claimVerdict(head(NO_OWNER), owner("released", NO_OWNER)).allowed, takeVerdict(head(NO_OWNER), owner("released", NO_OWNER)).allowed], [true, false]);
    assert.deepEqual([claimVerdict(head("p1"), owner("superseded", "p1")).allowed, takeVerdict(head("p1"), owner("superseded", "p1")).allowed], [false, true]);
    const current = takeVerdict(head("p1"), owner("current", "p1"));
    assert.equal(current.allowed, false);
    assert.equal(current.why, LIVE_OWNER_TAKE_STOPPED);
    assert.match(LIVE_OWNER_TAKE_STOPPED, /per-claim generation/);
    assert.equal(claimVerdict(head("p1"), owner("current", "p1")).why, LIVE_OWNER_TAKE_STOPPED);
    const run = "op:r-0123456789abcdef";
    assert.equal(releaseVerdict(head(run, 1), owner("operator", run), run).allowed, true);
    assert.equal(releaseVerdict(head(run, 1), owner("operator", run), "op:r-ffffffffffffffff").allowed, false);
    assert.equal(releaseVerdict(head("p1"), owner("current", "p1"), run).allowed, false, "a pool's own hold is never released here");
    assert.equal(claimVerdict(head(run, 1), owner("operator", run)).allowed, false);
    assert.equal(takeVerdict(head(run, 1), owner("operator", run)).allowed, false);
  });

  test("anything not fully understood refuses every action: an unreadable or unavailable HEAD, damage (orphaned / ahead / inconsistent / unknown), a pool item with attributes this build never writes", () => {
    for (const bad of [{ state: "unreadable", format: "newer", detail: "x" }, { state: "unavailable", detail: "x" }, { state: "absent" }] as Array<Read<HeadView>>) {
      assert.equal(claimVerdict(bad, owner("unknown", "p1")).allowed, false);
      assert.equal(takeVerdict(bad, owner("unknown", "p1")).allowed, false);
      assert.equal(releaseVerdict(bad, owner("unknown", "p1"), null).allowed, false);
    }
    for (const cls of ["orphaned", "ahead", "inconsistent", "unknown"] as const) {
      assert.equal(claimVerdict(head("p1"), owner(cls, "p1")).allowed, false, cls);
      assert.equal(takeVerdict(head("p1"), owner(cls, "p1")).allowed, false, cls);
    }
    assert.equal(takeVerdict(head("p1"), owner("superseded", "p1", ["status"])).allowed, false, "a later build's pool item");
  });
});

/* ==================================================================
    4. NOTES, RUN IDS, ARGUMENTS
   ================================================================== */
describe("L6-3 notes, run ids and arguments", () => {
  test("a note is printable, 1-300 characters, and never shaped like a credential", () => {
    assert.equal(noteProblem("the owning task was replaced at 12:04; moving the game to review"), null);
    for (const bad of [undefined, "", "   ", "x".repeat(301), "line\nbreak", "see AKIAIOSFODNN7EXAMPLE for access", "-----BEGIN PRIVATE KEY-----", "aws_secret_access_key=abc"]) assert.notEqual(noteProblem(bad), null, JSON.stringify(bad));
  });

  test("a run id is a fresh op: pool id every time (never primary, never reused)", () => {
    const a = newOperatorRun();
    const b = newOperatorRun();
    assert.match(a.run, OPERATOR_RUN);
    assert.notEqual(a.run, b.run);
    assert.equal(a.task, `gamesDoctor-${a.run.slice("op:r-".length)}`);
    assert.throws(() => newOperatorRun(() => "XYZ"));
  });

  test("usage, unknown options and --apply on a read-only command are exit 2 with nothing read", async () => {
    const parsed = parseOperatorArgs(["take", "g_1", "--note", "why --apply", "--apply", "--aws-config=arn"]);
    assert.deepEqual([parsed.positional, parsed.unknown, [...parsed.flags], parsed.values.get("--note"), parsed.problems], [["take", "g_1"], [], ["--apply"], ["why --apply"], []]);
    /* Review L2: a value is never an option, and an option is never a value. */
    assert.deepEqual(parseOperatorArgs(["take", "g_1", "--note", "--apply"]).problems, ["--note needs a value"]);
    assert.deepEqual([...parseOperatorArgs(["take", "g_1", "--note", "--apply"]).flags], ["--apply"]);
    assert.deepEqual(parseOperatorArgs(["release", "g_1", "--run"]).problems, ["--run needs a value"]);
    assert.deepEqual(parseOperatorArgs(["status", "--json=1"]).unknown, ["--json"]);
    for (const argv of [[], ["nonsense"], ["game"], ["take"], ["status", "--force"], ["status", "--apply"], ["games", "--apply"], ["take", "g_1", "--note", "--apply"], ["take", "g_1", "--note="]]) {
      const out = io();
      const reads = parameters({});
      assert.equal(await runAwsOperator(argv, {}, out.sink, { parameters: reads, clientFor: () => stubClient() }), EXIT.usage, argv.join(" "));
      assert.deepEqual(reads.reads, [], "nothing was read");
    }
    const out = io();
    await runAwsOperator(["status", "--force"], {}, out.sink);
    assert.match(out.err.join("\n"), /unknown option --force/);
    assert.ok(AWS_USAGE.includes("set-primary") && AWS_USAGE.includes("--expect-version"));
  });
});

/* ==================================================================
    5. NOTHING PRINTED CARRIES A CREDENTIAL OR A CONFIGURATION'S CONTENT
   ================================================================== */
describe("L6-3 no secret, no configuration content, in any output", () => {
  test("status and a refused mutation over an unreachable table: the reads are reported unavailable (never absent), and neither stdout nor stderr carries a credential value or the documents' content", async () => {
    const escrowDoc = JSON.stringify({ format: "18COSMOS/JUNO-BACKEND/v3", rest_endpoints: ["https://rpc.example/secret-path-token-do-not-print"] });
    const out = io();
    const client = stubClient("fails");
    const code = await runAwsOperator(["status", "--aws-config", RUNTIME_ARN], {}, out.sink, {
      parameters: parameters({ [RUNTIME_ARN]: JSON.stringify({ ...DOC, escrow: { config_parameter_arn: ESCROW_ARN } }), [ESCROW_ARN]: escrowDoc }),
      clientFor: () => client,
    });
    assert.equal(code, EXIT.findings);
    const text = [...out.out, ...out.err].join("\n");
    assert.match(text, /SYSTEM\/ROUTING {4}COULD NOT BE READ/);
    assert.match(text, /APPGEN {12}COULD NOT BE READ/);
    assert.ok(!/ABSENT/.test(text), "a failed read is never reported as absence");
    assert.ok(!text.includes("secret-path-token-do-not-print"), "the escrow configuration's content is never printed");
    assert.ok(client.sent > 0);
    /* The same with the credentials in the environment of a LOCAL run (where they are not refused: never read). */
    const local = io();
    await runAwsOperator(["take", G, "--note", "why", "--local-document", "doc.json"], { GS_DYNAMODB_LOCAL_ENDPOINT: "http://127.0.0.1:8000", ...SECRET_VALUES }, local.sink, {
      readFile: async () => JSON.stringify(DOC),
      clientFor: () => stubClient("fails"),
    });
    const localText = [...local.out, ...local.err].join("\n");
    for (const value of Object.values(SECRET_VALUES)) assert.ok(!localText.includes(value), `${value.slice(0, 8)}... is never printed`);
    assert.match(localText, /REFUSED/);
  });
});

/* ==================================================================
    6. THE FILE MODE IS UNCHANGED AND LOADS NO AWS CODE
   ================================================================== */
describe("L6-3 gamesDoctor's file mode is unchanged", () => {
  test("the aws entry is a dynamic import taken only for `aws`; gamesDoctor.ts imports no AWS module statically", () => {
    const root = path.resolve(__dirname, "../../../../../src"); // dist/server/src/aws/operator -> server/src
    /* As committed (LF): a Windows checkout's CRLF is not the code (LIVE-6 W1). */
    const doctor = readCheckoutText(path.join(root, "tools/gamesDoctor.ts"));
    const statics = [...doctor.matchAll(/^import[^;]*from\s+["']([^"']+)["'];?$/gm)].map((match) => match[1]);
    assert.ok(statics.length > 10, "the static imports were found");
    assert.ok(!statics.some((name) => /(^|\/)aws\//.test(name) || name.startsWith("@aws-sdk/")), statics.join(", "));
    const dynamicAws = /if \(argv\[0\] === "aws"\) \{\n\s+const \{ runAwsOperator \} = await import\("\.\.\/aws\/operator\/operatorMain"\);/;
    assert.match(doctor, dynamicAws);
    /* LIVE-6 W1, pinned on every platform: the file as a CRLF checkout holds it is what failed the owner's Windows gate
       (the code was right); read as committed -- normalized -- the same assertion binds. */
    const crlf = doctor.replace(/\n/g, "\r\n");
    assert.doesNotMatch(crlf, dynamicAws);
    assert.match(normalizeEol(crlf), dynamicAws);
  });

  test("a real file-mode run (the compiled CLI) loads no AWS SDK and no AWS adapter, runtime or operator module, and answers exactly as before", () => {
    /* (`aws/arns.ts` -- ARN parsing with no SDK import -- is the Juno configuration's, which file mode has always loaded.) */
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gs-l63-file-"));
    const probe = path.join(dir, "probe.js");
    fs.writeFileSync(probe, `process.on("exit", () => { const aws = Object.keys(require.cache).filter((f) => /@aws-sdk|[\\\\/]aws[\\\\/](game|identity|ownership|ledger|kms|runtime|operator|awsClients)/.test(f)); require("fs").writeFileSync(${JSON.stringify(path.join(dir, "loaded.json"))}, JSON.stringify(aws)); });\n`);
    const data = path.join(dir, "data");
    fs.mkdirSync(data);
    const cli = path.resolve(__dirname, "../../tools/gamesDoctor.js");
    try {
      const status = spawnSync(process.execPath, ["--require", probe, cli, "status", "--data", data], { encoding: "utf8" });
      assert.equal(status.status, 1, "no status file yet: exit 1, as before");
      assert.match(status.stdout, /No status file in/);
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "loaded.json"), "utf8")), [], "file mode loaded no AWS SDK or AWS module");
      const scan = spawnSync(process.execPath, ["--require", probe, cli, "scan-v10", "--data", data], { encoding: "utf8" });
      assert.equal(scan.status, 0);
      assert.match(scan.stdout, /VERDICT: CLEAN/);
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "loaded.json"), "utf8")), []);
      const usage = spawnSync(process.execPath, [cli, "nonsense", "--data", data], { encoding: "utf8" });
      assert.equal(usage.status, 2);
      assert.match(usage.stderr, /aws <command> \.\.\./, "the usage names the AWS mode");
      /* And the AWS mode is reached only as the FIRST word. */
      const aws = spawnSync(process.execPath, ["--require", probe, cli, "aws"], { encoding: "utf8", env: { PATH: process.env.PATH ?? "" } });
      assert.equal(aws.status, 2);
      assert.match(aws.stderr, /usage: gamesDoctor aws/);
      assert.ok((JSON.parse(fs.readFileSync(path.join(dir, "loaded.json"), "utf8")) as string[]).some((file) => /aws[\\/]operator[\\/]operatorMain/.test(file)), "`aws` loads the operator entry");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
