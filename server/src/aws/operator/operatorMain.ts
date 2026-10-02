// server/src/aws/operator/operatorMain.ts
//
// ==================================================================
//  LIVE-6 L6-3: `gamesDoctor aws ...` -- THE OPERATOR'S AWS MODE (loaded only for `aws`; the file-mode commands never load it)
// ==================================================================
//
//   READ-ONLY (safe at any time, beside serving tasks):
//     aws status                        the deployment: configuration identity, SYSTEM/ROUTING, APPGEN, the pools it can
//                                       name, the identity-writer role, the relayer mirror against the ledger fence, findings
//     aws game <game_id>                one game: its HEAD owner (released / current / superseded / operator / orphaned /
//                                       ahead / inconsistent / unknown), the owner pool, its record, hold and financial
//                                       record (read by their own stores), and whether claim / take / release are allowed
//     aws wallet-grants <game_id>       JX-3B, read-only: one game's wallet grants, redacted (`tools/walletGrants.ts`)
//     aws money <game_id> [--chain] [--tx-bytes <intent_id> [--attempt <n> | --tx-hash <HASH>]]
//                                       JX-4B, read-only: one money game's evidence -- FIN and its frozen roster, the wallet
//                                       grants, every chain intent and EVERY attempt, the relay queue and the signing
//                                       journal (ATTI# / TXID#), judged (`moneyEvidence.ts`, `tools/moneyEvidence.ts`);
//                                       --chain adds read-only Juno queries of the bound deployment; --tx-bytes exports one
//                                       attempt's exact stored TxRaw (base64) for `frontend/scripts/jx2VerifyTx.js`
//     aws games [--money] [--month <yyyymm>]
//                                       every game of the directory (DIRKEYS -> DIR#), or every OPEN money game (FINKEYS ->
//                                       FINIDX#), with its owner class
//   MUTATIONS (a dry run unless --apply: without it NOTHING is written; each needs --note "<why>"):
//     aws set-primary <pool> --expect-version <n>
//                                       SYSTEM/ROUTING compare-and-swap (never the first routing: that is L5-8's bootstrap)
//     aws claim <game_id>               an operator run takes a RELEASED game
//     aws take <game_id>                an operator run takes a game whose owner epoch is SUPERSEDED (never a current owner)
//     aws release <game_id> --run <op:r-...>
//                                       an operator run's hold ends
//   LIVE-6 L6-2 -- THE FLIP, THE RECOVERY, RETIREMENT AND THE RESTORE'S ORPHANS (flip.ts, recovery.ts, retire.ts, orphans.ts):
//     aws flip <A> <B> --expect-version <n> --note "<why>" --evidence <dir> --flip-record <file> [--apply]
//                                       the preflight (a dry run without --apply), then the routing CAS and the observation
//                                       of both pools' role changes; every phase in the flip record (FLIP-EVIDENCE/v1)
//     aws flip-observe --flip-record <file>
//                                       resume the observation of a flip whose CAS landed
//     aws recover <A> --note "<why>" [--apply] [--limit <n>] [--money-wait-seconds <s>] [--flip-record <file>]
//                                       take + release every game still owned by A's SUPERSEDED epoch (never a current one)
//     aws retire-check <pool> [--evidence <dir>]       the retirement prerequisites (read-only)
//     aws orphans                       the restore's orphans: ledger SETTLE# / ATTI# the adopted table cannot account for
//   LIVE-6 L6-6 (RESTORE DRILL) -- THE STAGING FLIP-SUPPRESSION OVERLAP TEST (suppressionOverlap.ts; NOT a routing flip):
//     aws suppression-overlap open <A> <B> --minutes <n> --note "<why>" --record <file> [--apply]
//                                       the planned flip's own FlipWindowOpen suppression for A and B (staging only, at most
//                                       45 minutes); SYSTEM/ROUTING read before it, never written
//     aws suppression-overlap close --record <file> [--apply]
//                                       end it (its remaining minutes cancelled), SYSTEM/ROUTING read again and recorded
//   THE DEPLOYMENT: --aws-config <SSM parameter ARN> or GS_AWS_CONFIG_PARAMETER (L5-7's runtime document); for DynamoDB
//   Local, GS_DYNAMODB_LOCAL_ENDPOINT with --local-document <file> [--relayer <account>]. --json prints the structure.
//
// EXIT CODES: 0 -- clean (status / game / games), or the plan (dry run), or applied; 1 -- findings (a read that failed
// included), a refusal, or a conflict (nothing was written); 2 -- usage, or a deployment reference it refuses; 3 -- an
// UNKNOWN outcome (the message says how to settle it).
//
// OUTPUT: the answer on stdout; `AUDIT {...}` lines of every mutation on stderr (CloudWatch Logs on an ECS run: the file
// mode's `ops/audit.jsonl` has no AWS counterpart). Neither ever carries a credential or a configuration's content: ARNs,
// versions, table names, pools, tasks and the operator's note (which is refused if it looks like a credential).

import { promises as fsp } from "fs";
import * as fs from "fs";

import { redactIdentity } from "../../persistence/opsRecorder";
import { ssmParameterSource, type ParameterSource } from "../runtime/configSource";
import { parseAwsRuntimeConfigText, type AwsRuntimeConfig } from "../runtime/runtimeConfig";
import { parseFlipRecord, writeFlipRecord, type FlipRecord } from "../controlPlane/flipRecord";
import { closeFlipWindow, DEFAULT_OBSERVE_MS, observeFlip, runFlip, suppressFlipWindow, type FlipDeps } from "./flip";
import { cloudWatchSuppression } from "./flipSuppression";
import { createCloudWatchClient } from "../awsClients";
import type { FlipSuppressionPort } from "../controlPlane/flipSuppression";
import { orphansReport } from "./orphans";
import { closeSuppressionOverlap, openSuppressionOverlap, type OverlapAnswer, type OverlapDeps } from "./suppressionOverlap";
import { readRouting } from "../game/routing";
import { DEFAULT_MONEY_WAIT_MS, DEFAULT_RECOVERY_LIMIT, recoverFromPool, type RecoveryReport } from "./recovery";
import { retirementCheck, type RetirementReport } from "./retire";
import { awsWalletGrants, inspectDeployment, inspectGame, listGames, type DeploymentInspection, type GameInspection, type GameListing, type Read } from "./inspect";
import { walletGrantsText } from "../../tools/walletGrants";
import { moneyEvidenceText } from "../../tools/moneyEvidence";
import { createJunoRest } from "../../escrow/juno/junoRest";
import type { JunoBackendConfig } from "../../escrow/juno/junoConfig";
import { awsMoneyEvidence, awsTxBytes, chainReadPort, scrubOperatorText, type AwsMoneyEvidenceOptions, type ChainReadPort } from "./moneyEvidence";
import { claimGameAsOperator, releaseGameAsOperator, setPrimary, takeGameAsOperator, type MutationContext, type MutationResult, type OperatorRun } from "./mutations";
import { LOCAL_DOCUMENT_FLAG, OperatorRefusal, RELAYER_FLAG, resolveOperatorTarget, type OperatorTarget } from "./operatorTarget";

export const AWS_USAGE = [
  "usage: gamesDoctor aws <command> (--aws-config <SSM parameter ARN> | GS_AWS_CONFIG_PARAMETER) [--json]",
  "  status                              the deployment: routing, APPGEN, pools, the identity-writer and relayer roles (read-only)",
  "  game <game_id>                      one game's owner and whether claim / take / release are allowed (read-only)",
  "  games [--money] [--month <yyyymm>]  every directory game, or every open money game, with its owner (read-only)",
  "  wallet-grants <game_id>             JX-3B: one game's wallet grants, redacted (read-only; standing needs the identity table)",
  "  money <game_id> [--chain]           JX-4B: one money game's evidence -- FIN, roster, tickets, intents and every attempt, the",
  "                                      relay queue, the signing journal, with verdicts; --chain adds read-only Juno queries (read-only)",
  "  money <game_id> --tx-bytes <intent_id> [--attempt <n> | --tx-hash <HASH>]",
  "                                      JX-4B: one attempt's exact stored TxRaw, base64, on stdout (for jx2VerifyTx.js; read-only)",
  "  set-primary <pool> --expect-version <n> --note \"<why>\" [--apply]",
  "                                      SYSTEM/ROUTING compare-and-swap (a dry run without --apply)",
  "  claim <game_id> --note \"<why>\" [--apply]      an operator run takes a released game",
  "  take <game_id> --note \"<why>\" [--apply]       an operator run takes a game whose owner epoch is superseded",
  "  release <game_id> --run <op:r-...> --note \"<why>\" [--apply]",
  "                                      an operator run's hold ends",
  "  flip <A> <B> --expect-version <n> --note \"<why>\" --evidence <dir> --flip-record <file> [--apply] [--observe-seconds <s>]",
  "                                      L6-2: preflight, the routing CAS, the role-change observation (a dry run without --apply);",
  "                                      --rollback: back to the pool the roles never left, when B's promotion failed",
  "  flip-observe --flip-record <file> [--observe-seconds <s>]   resume a flip: settle an uncertain CAS from the routing, observe",
  "  recover <A> --note \"<why>\" [--apply] [--limit <n>] [--money-wait-seconds <s>] [--flip-record <file>]",
  "                                      take + release games still owned by A's superseded epoch (never a current owner)",
  "  retire-check <pool> [--evidence <dir>]                     the retirement prerequisites (read-only)",
  "  orphans                             ledger evidence the adopted game table cannot account for (read-only)",
  "  suppression-overlap open <A> <B> --minutes <n> --note \"<why>\" --record <file> [--apply]",
  "                                      L6-6 restore drill: a STAGING flip-suppression overlap test -- the planned flip's",
  "                                      FlipWindowOpen suppression for two pools, NOT a routing flip (SYSTEM/ROUTING only read)",
  "  suppression-overlap close --record <file> [--apply]        end that test; SYSTEM/ROUTING read again and recorded",
  `  DynamoDB Local: GS_DYNAMODB_LOCAL_ENDPOINT=<loopback> with ${LOCAL_DOCUMENT_FLAG} <runtime document file> [${RELAYER_FLAG} <account>] [--pool-document <pool>=<file> ...]`,
].join("\n");

export const EXIT = Object.freeze({ ok: 0, findings: 1, usage: 2, unknown: 3 });

const VALUE_FLAGS = new Set(["--aws-config", LOCAL_DOCUMENT_FLAG, RELAYER_FLAG, "--note", "--expect-version", "--run", "--month", "--data", "--escrow-config", "--evidence", "--flip-record", "--pool-document", "--limit", "--money-wait-seconds", "--observe-seconds", "--minutes", "--record", "--tx-bytes", "--attempt", "--tx-hash"]);
const BOOLEAN_FLAGS = new Set(["--json", "--apply", "--money", "--rollback", "--chain"]);
/** JX-4B: the only options `money` takes -- the deployment, the output form and its own read selectors. Anything else
 *  (--apply, --note, --expect-version, --run, ...) names a mutation mode and is refused: `money` writes nothing. */
const MONEY_OPTIONS = new Set(["--aws-config", LOCAL_DOCUMENT_FLAG, RELAYER_FLAG, "--json", "--chain", "--tx-bytes", "--attempt", "--tx-hash"]);
const MONEY_ONLY = ["--chain", "--tx-bytes", "--attempt", "--tx-hash"];

export interface OperatorIo {
  out(line: string): void;
  err(line: string): void;
}

export interface OperatorSeams {
  readonly parameters?: ParameterSource;
  readonly clientFor?: Parameters<typeof resolveOperatorTarget>[0]["clientFor"];
  readonly readFile?: (file: string) => Promise<string>;
  readonly now?: () => number;
  readonly newRun?: () => OperatorRun;
  readonly timing?: MutationContext["timing"];
  /** L6-2: the waits of the flip observation and the recovery's money wait (tests: no real clock). */
  readonly sleep?: (ms: number) => Promise<void>;
  /** L6-2: the flip observation's and money wait's poll interval (ms). */
  readonly pollMs?: number;
  /** JX-4B: `money --chain`'s read port from the deployment's escrow configuration (production: `createJunoRest` over its
   *  REST endpoints, narrowed to reads). */
  readonly chainRest?: (juno: JunoBackendConfig) => ChainReadPort;
  /** L6-5B: the planned-flip window's alarm suppression (production: CloudWatch in the deployment's region; DynamoDB
   *  Local: none). null: none. */
  readonly suppression?: FlipSuppressionPort | null;
}

export interface ParsedOperatorArgs {
  readonly positional: string[];
  /** Options this mode does not know. */
  readonly unknown: string[];
  /** The boolean flags given (read from the token walk: a word taken as an option's value is never a flag). */
  readonly flags: ReadonlySet<string>;
  /** Each value option's values, in order. */
  readonly values: ReadonlyMap<string, readonly string[]>;
  /** A value option with no value, or with another option where its value should be (review L2: `--note --apply`). */
  readonly problems: string[];
}

/** One walk over the words: positional words, boolean flags, value options -- a value is never an option. */
export function parseOperatorArgs(argv: readonly string[]): ParsedOperatorArgs {
  const positional: string[] = [];
  const unknown: string[] = [];
  const flags = new Set<string>();
  const values = new Map<string, string[]>();
  const problems: string[] = [];
  for (let at = 0; at < argv.length; at += 1) {
    const arg = argv[at];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg : arg.slice(0, eq);
    if (VALUE_FLAGS.has(name)) {
      let value: string | undefined;
      if (eq !== -1) value = arg.slice(eq + 1);
      else {
        value = argv[at + 1];
        if (value !== undefined && !value.startsWith("--")) at += 1;
        else value = undefined;
      }
      if (value === undefined || value === "" || value.startsWith("--")) problems.push(`${name} needs a value`);
      else values.set(name, [...(values.get(name) ?? []), value]);
    } else if (BOOLEAN_FLAGS.has(name) && eq === -1) flags.add(name);
    else unknown.push(name);
  }
  return { positional, unknown, flags, values, problems };
}

const one = (args: ParsedOperatorArgs, name: string): string | undefined => {
  const values = args.values.get(name) ?? [];
  return values.length === 0 ? undefined : values[values.length - 1];
};

function readWord<T>(read: Read<T>, ok: (value: T) => string): string {
  switch (read.state) {
    case "absent":
      return "ABSENT";
    case "ok":
      return ok(read.value);
    case "unreadable":
      return `UNREADABLE (${read.format}): ${read.detail}`;
    case "unavailable":
      return `COULD NOT BE READ: ${read.detail}`;
  }
}

function printDeployment(io: OperatorIo, report: DeploymentInspection): void {
  const t = report.target;
  io.out(`AWS deployment (READ-ONLY) -- ${t.kind === "aws" ? `runtime configuration ${t.config.arn} v${t.config.version}` : `DynamoDB Local, document ${t.config.file}`}`);
  io.out(`  environment ${t.environment}, region ${t.region}; configured pool ${t.configured_pool}, generation ${t.generation}`);
  io.out(`  tables: game ${t.game_table}, identity ${t.identity_table}, ledger ${t.ledger_table}`);
  io.out(
    `  escrow: ${t.escrow.state === "none" ? "none configured" : t.escrow.state === "ok" ? `relayer ${t.escrow.relayer}${t.escrow.arn !== null ? ` (${t.escrow.arn} v${t.escrow.version})` : ""}` : t.escrow.state === "not-read" ? "configured, not read (DynamoDB Local)" : `NOT USABLE: ${t.escrow.detail}`}`,
  );
  io.out(`  SYSTEM/ROUTING    ${readWord(report.routing, (r) => `primary ${r.primary_pool}, version ${r.routing_version}, set by ${r.updated_by} at ${r.updated_at}`)}`);
  io.out(`  APPGEN            ${readWord(report.appgen, (a) => `generation ${a.current_generation}${a.matches_configuration ? " (matches the configuration)" : " -- DIFFERS from the configuration"}`)}`);
  for (const pool of report.pools) {
    io.out(`  POOL#${pool.pool.padEnd(12)} [${pool.named_as.join(", ")}] ${readWord(pool.item, (p) => `epoch ${p.writer_epoch}, task ${p.writer_task}${p.taken_at !== null ? `, taken at ${p.taken_at}` : ""}${p.extra.length > 0 ? `; attributes this build never writes: ${p.extra.join(", ")}` : ""}`)}`);
  }
  const id = report.identity_writer;
  io.out(`  identity writer   ${readWord(id.role, (r) => `epoch ${r.epoch}, ${r.task} of pool ${r.pool}, taken at ${r.taken_at}`)}${id.holder !== null ? ` -- ${id.holder.holder}${id.holder.primary === false ? ", NOT the primary" : ""}` : ""}`);
  if (report.relayer !== null) {
    const r = report.relayer;
    io.out(`  relayer ${r.account}: ${r.consistency}${r.holder !== null ? ` -- ${r.holder.holder}${r.holder.primary === false ? ", NOT the primary" : ""}` : ""}`);
    io.out(`    mirror (game)   ${readWord(r.mirror, (m) => `epoch ${m.epoch}, ${m.task} of pool ${m.pool} (pool epoch ${m.pool_epoch}), taken at ${m.taken_at}`)}`);
    io.out(`    fence (ledger)  ${readWord(r.fence, (f) => `epoch ${f.epoch}`)}`);
  }
  if (report.findings.length === 0) io.out("FINDINGS: none");
  else for (const finding of report.findings) io.out(`FINDING: ${finding}`);
}

function printGame(io: OperatorIo, game: GameInspection): void {
  io.out(`game ${game.game_id} (READ-ONLY)`);
  io.out(`  HEAD              ${readWord(game.head, (h) => `owner ${h.owner_pool}, epoch ${h.pool_epoch}${h.owner_task !== null ? `, task ${h.owner_task}` : ""}; log ${h.log_next_index} entries, ${h.log_bytes} bytes`)}`);
  io.out(`  owner             ${game.owner.class.toUpperCase()} -- ${game.owner.detail}`);
  io.out(`  record            ${readWord(game.record, (r) => `version ${r.record_version}, schema ${r.record_schema}, ${r.status}${r.money ? ", a money table" : ""}`)}`);
  io.out(`  hold              ${readWord(game.hold, (h) => `HELD ${h.code}: ${h.detail}`)}`);
  io.out(`  financial         ${readWord(game.financial, (f) => `${f.phase}, version ${f.record_version}; ${f.continues_here ? "continued by this build" : `NOT continued by this build (${f.why})`}`)}`);
  if (game.operator_run !== null) io.out(`  operator run      ${readWord(game.operator_run, (r) => `${r.command ?? "?"} of ${r.subject ?? "?"} at ${r.started_at ?? "?"}: "${r.note ?? ""}"${r.outcome !== null ? ` -> ${r.outcome}` : ""}`)}`);
  for (const [name, verdict] of Object.entries(game.actions)) io.out(`  ${name.padEnd(8)}          ${verdict.allowed ? "ALLOWED" : "not allowed"} -- ${verdict.why}`);
}

function printListing(io: OperatorIo, listing: GameListing): void {
  const counts: Record<string, number> = {};
  for (const game of listing.games) counts[game.owner] = (counts[game.owner] ?? 0) + 1;
  io.out(`${listing.source === "open-money" ? "open money games" : "directory games"} (READ-ONLY): ${listing.games.length} -- ${Object.entries(counts).map(([cls, n]) => `${n} ${cls}`).join(", ") || "none"}`);
  for (const game of listing.games) io.out(`  ${game.game_id}  ${game.owner.padEnd(12)} ${game.owner_pool ?? "-"}${game.owner_epoch !== null ? `@${game.owner_epoch}` : ""}${SETTLED_OWNERS.includes(game.owner) ? "" : ` -- ${game.detail}`}`);
  for (const problem of listing.problems) io.out(`  INDEX: ${problem}`);
}

function printMutation(io: OperatorIo, result: MutationResult): void {
  const plan = result.kind === "planned" ? result.plan : result.plan;
  if (plan !== null) {
    io.out(`${plan.command} ${plan.subject}${result.kind === "planned" ? " -- DRY RUN: nothing was written (add --apply to make it)" : ""}`);
    io.out(`  before      ${JSON.stringify(plan.before)}`);
    io.out(`  after       ${JSON.stringify(plan.after)}`);
    for (const condition of plan.conditions) io.out(`  condition   ${condition}`);
    io.out(`  why         ${plan.why}`);
    for (const note of plan.notes) io.out(`  note        ${note}`);
  }
  switch (result.kind) {
    case "planned":
      return;
    case "refused":
      io.out(`REFUSED: ${result.reason}${result.run !== null ? ` (run ${result.run}; its evidence is in the table)` : ""}`);
      return;
    case "applied":
      io.out(`APPLIED by run ${result.run}: ${result.detail}`);
      return;
    case "conflict":
      io.out(`CONFLICT (run ${result.run}): ${result.detail}`);
      return;
    case "unknown":
      io.out(`UNKNOWN OUTCOME (run ${result.run}): ${result.detail}`);
      return;
  }
}

/** Owner classes that are an ordinary serving state (a superseded owner is what every game not yet loaded since a deploy
 *  shows: its pool's current task claims it at its next load). Anything else is reported (exit 1). */
const SETTLED_OWNERS: readonly string[] = Object.freeze(["released", "current", "superseded", "no-head"]);

const exitOf = (result: MutationResult): number => (result.kind === "planned" || result.kind === "applied" ? EXIT.ok : result.kind === "unknown" ? EXIT.unknown : EXIT.findings);

const r2exit = (clean: boolean): number => (clean ? EXIT.ok : EXIT.findings);

/** L6-2: each pool's runtime document, read exactly as its task reads it. AWS: the sibling SSM parameter of the configured
 *  one (`/gs/<env>/runtime/<pool>`, L5-8's naming); DynamoDB Local: `--pool-document <pool>=<file>` (the configured pool's
 *  own document is the target's). */
function documentsFor(target: OperatorTarget, args: ParsedOperatorArgs, seams: OperatorSeams): (pool: string) => Promise<AwsRuntimeConfig> {
  const files = new Map<string, string>();
  for (const entry of args.values.get("--pool-document") ?? []) {
    const eq = entry.indexOf("=");
    if (eq > 0) files.set(entry.slice(0, eq), entry.slice(eq + 1));
  }
  return async (pool) => {
    if (target.kind === "dynamodb-local") {
      const file = files.get(pool);
      if (file === undefined) {
        if (pool === target.config.pool) return target.config;
        throw new Error(`no --pool-document ${pool}=<file> given`);
      }
      return parseAwsRuntimeConfigText(seams.readFile !== undefined ? await seams.readFile(file) : (await fsp.readFile(file)).toString("utf8"));
    }
    const arn = target.source.arn;
    if (arn === null) throw new Error("the configured runtime document has no ARN");
    const sibling = arn.replace(/\/runtime\/[^/]+$/, `/runtime/${pool}`);
    if (!sibling.endsWith(`/runtime/${pool}`)) throw new Error(`the configured runtime document ${arn} does not follow /gs/<env>/runtime/<pool>`);
    const parameters = seams.parameters ?? ssmParameterSource();
    return parseAwsRuntimeConfigText((await parameters.read(sibling)).value);
  };
}

function printChecks(io: OperatorIo, checks: ReadonlyArray<{ readonly name: string; readonly status: string; readonly detail: string }>): void {
  for (const check of checks) io.out(`  ${check.status === "pass" ? "PASS" : check.status === "fail" ? "FAIL" : "SKIP"}  ${check.name} -- ${check.detail}`);
}

function printFlip(io: OperatorIo, record: FlipRecord): void {
  io.out(`flip ${record.from} -> ${record.to} (routing version ${record.expected_version}) -- ${record.verdict.toUpperCase()}`);
  io.out(" preflight:");
  printChecks(io, record.preflight.checks);
  if (record.cas !== null) io.out(` routing CAS: ${record.cas.outcome}${record.cas.run !== null ? ` (run ${record.cas.run})` : ""} -- ${record.cas.detail}`);
  const last = record.observations[record.observations.length - 1];
  if (last !== undefined) {
    io.out(" observation:");
    printChecks(io, last.checks);
  }
  if (record.window !== null) io.out(` planned-flip window: opened ${record.window.opened_at}, expires ${record.window.expires_at}${record.window.closed_at !== null ? `, closed ${record.window.closed_at}` : " (open until the recovery settles)"}`);
  const next: Record<string, string> = {
    planned: "DRY RUN: nothing was written. Re-run with --apply (and a fresh --evidence).",
    refused: "REFUSED: nothing of the flip was written.",
    flipped: "The routing moved; the role changes were not observed yet: run flip-observe.",
    "roles-settled": `NEXT: terraform apply with pools.${record.to}.primary = true (the /gs* rule), capture-evidence, awsDeploy verify --flip-record, then gamesDoctor aws recover ${record.from} --flip-record.`,
    timeout: "STOPPED: the role changes did not complete within the bound -- nothing is assumed; inspect (status, ECS) and run flip-observe.",
    unknown: `UNKNOWN: the routing CAS's outcome is not known -- run flip-observe with this record (it settles it from SYSTEM/ROUTING); if it says the CAS never landed, re-run the flip with --expect-version ${record.expected_version} and a NEW --flip-record (it can never move the routing twice).`,
  };
  io.out(next[record.verdict]);
}

function printRecovery(io: OperatorIo, report: RecoveryReport): void {
  io.out(`recover ${report.from} (the primary is ${report.primary ?? "?"})${report.apply ? "" : " -- DRY RUN: nothing was written"}`);
  io.out(`  games: ${Object.entries(report.counts).map(([k, n]) => `${n} ${k}`).join(", ") || "none"}`);
  for (const id of report.planned) io.out(`  WOULD take + release ${id}`);
  for (const a of report.acted) io.out(`  ${a.action === "taken-and-released" ? `TAKEN (${a.take_run}) + RELEASED (${a.release_run})` : `RELEASED this recovery's hold ${a.hold_run} (${a.release_run})`} ${a.game_id}${a.money ? " [money]" : ""}`);
  for (const id of report.money_claimed) io.out(`  CLAIMED by the primary's money sweep: ${id}`);
  for (const u of report.unresolved) io.out(`  UNRESOLVED ${u.game_id} (${u.class}): ${u.detail}`);
  for (const p of report.problems) io.out(`  PROBLEM: ${p}`);
  if (report.remaining > 0) io.out(`  ${report.remaining} more beyond --limit: run the pass again`);
  io.out(report.settled ? "RECOVERY SETTLED: nothing of the old epoch remains" : report.apply ? "NOT SETTLED (see above; the pass is resumable)" : "DRY RUN");
}

function printRetirement(io: OperatorIo, report: RetirementReport): void {
  io.out(`retire-check ${report.pool} (READ-ONLY) -- ${report.verdict.toUpperCase()}`);
  printChecks(io, report.checks);
}

/** `gamesDoctor aws <argv...>`. Returns the exit code. */
export async function runAwsOperator(argv: readonly string[], env: Readonly<Record<string, string | undefined>>, io: OperatorIo, seams: OperatorSeams = {}): Promise<number> {
  const args = parseOperatorArgs(argv);
  const { positional, unknown } = args;
  const [command, subject] = positional;
  if (unknown.length > 0 || args.problems.length > 0) {
    io.err(`gamesDoctor aws: ${[...(unknown.length > 0 ? [`unknown option ${unknown.join(", ")}`] : []), ...args.problems].join("; ")}\n${AWS_USAGE}`);
    return EXIT.usage;
  }
  const known = ["status", "game", "games", "wallet-grants", "money", "set-primary", "claim", "take", "release", "flip", "flip-observe", "recover", "retire-check", "orphans", "suppression-overlap"];
  const noSubject = ["status", "games", "flip-observe", "orphans"];
  if (
    command === undefined ||
    !known.includes(command) ||
    (!noSubject.includes(command) && subject === undefined) ||
    (command === "flip" && positional[2] === undefined) ||
    (command === "suppression-overlap" && !((subject === "open" && positional.length === 4) || (subject === "close" && positional.length === 2)))
  ) {
    io.err(AWS_USAGE);
    return EXIT.usage;
  }
  const json = args.flags.has("--json");
  const apply = args.flags.has("--apply");
  if (apply && (command === "status" || command === "game" || command === "games" || command === "wallet-grants" || command === "money" || command === "retire-check" || command === "orphans" || command === "flip-observe")) {
    io.err(`gamesDoctor aws ${command} is read-only: --apply means nothing here`);
    return EXIT.usage;
  }
  /* JX-4B: money's own options are its alone, and money takes no other (no mutation mode reaches it). */
  const given = [...args.flags, ...args.values.keys()];
  if (command === "money") {
    const foreign = given.filter((name) => !MONEY_OPTIONS.has(name));
    if (foreign.length > 0) {
      io.err(`gamesDoctor aws money is read-only: ${foreign.join(", ")} means nothing here (it writes nothing, signs nothing, sends nothing)`);
      return EXIT.usage;
    }
    if ((args.values.get("--tx-bytes")?.length ?? 0) > 1) {
      io.err("gamesDoctor aws money: --tx-bytes names ONE intent");
      return EXIT.usage;
    }
    if (!args.values.has("--tx-bytes") && (args.values.has("--attempt") || args.values.has("--tx-hash"))) {
      io.err("gamesDoctor aws money: --attempt / --tx-hash select an attempt for --tx-bytes");
      return EXIT.usage;
    }
    if (args.values.has("--tx-bytes") && args.flags.has("--chain")) {
      io.err("gamesDoctor aws money: --tx-bytes exports stored bytes only (no --chain)");
      return EXIT.usage;
    }
    /* The selectors, checked before anything is read: one of each at most, never both, well-formed. */
    const attempts = args.values.get("--attempt") ?? [];
    const hashes = args.values.get("--tx-hash") ?? [];
    if (attempts.length > 1 || hashes.length > 1 || (attempts.length > 0 && hashes.length > 0)) {
      io.err("gamesDoctor aws money: name the attempt ONCE, with --attempt <n> or --tx-hash <HASH> (not both)");
      return EXIT.usage;
    }
    if (attempts.length === 1 && !/^[1-9][0-9]{0,2}$/.test(attempts[0])) {
      io.err("gamesDoctor aws money: --attempt is an attempt number (1, 2, ...)");
      return EXIT.usage;
    }
    if (hashes.length === 1 && !/^[0-9A-Fa-f]{64}$/.test(hashes[0])) {
      io.err("gamesDoctor aws money: --tx-hash is a 64-hex transaction hash");
      return EXIT.usage;
    }
  } else {
    const misplaced = given.filter((name) => MONEY_ONLY.includes(name));
    if (misplaced.length > 0) {
      io.err(`gamesDoctor aws ${command}: ${misplaced.join(", ")} belongs to \`money\`\n${AWS_USAGE}`);
      return EXIT.usage;
    }
  }
  let target: OperatorTarget;
  /** L6-5B: the flip window's CloudWatch client, when one was made (destroyed with the target's clients). */
  let releaseCloudWatch: () => void = () => undefined;
  try {
    target = await resolveOperatorTarget({ argv, env, ...(seams.parameters !== undefined ? { parameters: seams.parameters } : {}), ...(seams.clientFor !== undefined ? { clientFor: seams.clientFor } : {}), ...(seams.readFile !== undefined ? { readFile: seams.readFile } : {}) });
  } catch (error) {
    io.err(`gamesDoctor aws: refusing -- ${error instanceof OperatorRefusal || error instanceof Error ? error.message : String(error)}`);
    return EXIT.usage;
  }
  const print = <T>(value: T, text: (value: T) => void) => (json ? io.out(JSON.stringify(value, null, 2)) : text(value));
  /* L6-5B: made only when a window can open or close (flip, recover, the L6-6 suppression-overlap test); never for a
     local deployment. */
  let cloudWatch: ReturnType<typeof createCloudWatchClient> | null = null;
  releaseCloudWatch = () => cloudWatch?.destroy();
  const suppressionPort = (): FlipSuppressionPort | null => {
    if (seams.suppression !== undefined) return seams.suppression;
    if (target.kind !== "aws") return null;
    cloudWatch ??= createCloudWatchClient({ kind: "aws", region: target.config.region });
    return cloudWatchSuppression(cloudWatch);
  };
  try {
    if (command === "status") {
      const report = await inspectDeployment(target);
      print(report, (r) => printDeployment(io, r));
      return report.findings.length === 0 ? EXIT.ok : EXIT.findings;
    }
    if (command === "game") {
      const game = await inspectGame(target, subject as string);
      print(game, (g) => printGame(io, g));
      const bad = [game.head, game.record, game.hold, game.financial].some((read) => read.state === "unreadable" || read.state === "unavailable") || !SETTLED_OWNERS.includes(game.owner.class);
      return bad || game.hold.state === "ok" ? EXIT.findings : EXIT.ok;
    }
    if (command === "wallet-grants") {
      const view = await awsWalletGrants(target, subject as string, (seams.now ?? Date.now)());
      print(view, (v) => {
        for (const text of walletGrantsText(v)) io.out(text);
      });
      return view.identity.read && view.record.read ? EXIT.ok : EXIT.findings;
    }
    if (command === "money") {
      const intentId = one(args, "--tx-bytes");
      if (intentId !== undefined) {
        const attemptText = one(args, "--attempt");
        const txHash = one(args, "--tx-hash");
        const selection = await awsTxBytes(target, subject as string, intentId, { ...(attemptText !== undefined ? { attempt: Number(attemptText) } : {}), ...(txHash !== undefined ? { txHash } : {}) });
        if (!selection.ok) {
          io.err(`gamesDoctor aws money --tx-bytes: REFUSED (nothing exported) -- ${selection.reason}`);
          return EXIT.findings;
        }
        const e = selection.export;
        if (json) io.out(JSON.stringify(e, null, 2));
        else {
          /* stdout carries the bytes ALONE (redirect it to a file for jx2VerifyTx.js --tx-file); the description goes to stderr. */
          io.out(e.tx_base64);
          io.err(`tx-bytes (READ-ONLY): game ${e.game_id} intent ${e.intent_id} (${e.op}) attempt ${e.attempt} of ${e.of_attempts} (${e.chosen_by}), phase ${e.phase}`);
          io.err(`  tx ${e.tx_hash}; SHA-256 of the stored bytes ${e.sha256_matches_tx_hash ? "= the tx hash" : "!= THE TX HASH (the stored attempt is damaged)"}`);
          io.err(`  account ${e.account} account_number ${e.account_number} sequence ${e.sequence} gas_limit ${e.gas_limit} fee ${e.fee.amount}${e.fee.denom} timeout_height ${e.timeout_height}`);
          io.err(`  verify offline: ${e.verify_with}`);
        }
        return e.sha256_matches_tx_hash ? EXIT.ok : EXIT.findings;
      }
      let chain: AwsMoneyEvidenceOptions["chain"] = null;
      if (args.flags.has("--chain")) {
        const juno = target.juno ?? null;
        if (juno === null) {
          chain = { unavailable: target.kind === "dynamodb-local" ? "DynamoDB Local reads no escrow configuration, so --chain has no deployment to query" : target.escrow.state === "none" ? "no escrow is configured" : "the escrow configuration was not read or is not usable" };
        } else {
          try {
            const port =
              seams.chainRest !== undefined
                ? chainReadPort(seams.chainRest(juno))
                : chainReadPort(createJunoRest({ endpoints: juno.endpoints, expectedChainId: juno.chainId, allowInsecureLocalHttp: juno.allowInsecureLocalHttp, timeoutMs: juno.timeoutMs, maxResponseBytes: 256 * 1024, maxCodeBytes: 4 * 1024 * 1024 }));
            chain = { port, expect: { configured_chain_id: juno.chainId, configured_contract: juno.contract, relayer: juno.relayer.address, operators: juno.trust.operators, resolvers: juno.trust.resolvers, admission_pubkey: juno.admissionKey.publicKeyHex } };
          } catch (error) {
            /* The error's NAME only: a refused endpoint's message could quote a URL (a provider key can sit in one). */
            chain = { unavailable: `no chain transport could be made from the escrow configuration's endpoints (${error instanceof Error ? error.name : "error"})` };
          }
        }
      }
      const view = await awsMoneyEvidence(target, subject as string, { now: (seams.now ?? Date.now)(), chain });
      print(view, (v) => {
        for (const text of moneyEvidenceText(v)) io.out(text);
      });
      return view.summary.clean ? EXIT.ok : EXIT.findings;
    }
    if (command === "games") {
      const month = one(args, "--month");
      const listing = await listGames(target, { money: args.flags.has("--money"), ...(month !== undefined ? { month } : {}) });
      print(listing, (l) => printListing(io, l));
      return listing.problems.length === 0 && listing.games.every((game) => SETTLED_OWNERS.includes(game.owner)) ? EXIT.ok : EXIT.findings;
    }
    if (command === "retire-check") {
      const report = await retirementCheck(target, subject as string, one(args, "--evidence") ?? null);
      print(report, (r) => printRetirement(io, r));
      return report.verdict === "blocked" ? EXIT.findings : EXIT.ok;
    }
    if (command === "orphans") {
      const report = await orphansReport(target);
      print(report, (r) => {
        io.out(`restore orphans (READ-ONLY) -- SYSTEM/GENERATION ${r.generation.state}${r.generation.origin !== null ? `, origin ${r.generation.origin}${r.generation.restore_id !== null ? ` (restore ${r.generation.restore_id}, point ${r.generation.restore_point})` : ""}` : ""}`);
        io.out(`  games read ${r.games_read}; instances bound ${r.bound_instances}; intents held ${r.intents_held}`);
        for (const instance of r.settle_orphans) io.out(`  ORPHAN SETTLE#${instance}  (reservations for an instance no game of this table binds)`);
        for (const intent of r.attempt_orphans) io.out(`  ORPHAN ATTI#${intent}  (relayer attempts for an intent no game of this table holds)`);
        io.out(`  chain games: NOT COVERED -- ${r.chain_games.detail}`);
        for (const problem of r.problems) io.out(`  NOTE: ${problem}`);
        io.out(r.settle_orphans.length + r.attempt_orphans.length === 0 ? "ORPHANS: none in the ledger" : `ORPHANS: ${r.settle_orphans.length + r.attempt_orphans.length} (review each; nothing was changed)`);
      });
      return r2exit(report.settle_orphans.length + report.attempt_orphans.length === 0 && report.problems.filter((p) => !p.startsWith("this game table was never restored")).length === 0);
    }
    if (command === "suppression-overlap") {
      const recordFile = one(args, "--record");
      if (recordFile === undefined) {
        io.err("gamesDoctor aws suppression-overlap: --record <file> is required (the test's evidence: normally <evidence>/restore-alarms/suppression-window.json)");
        return EXIT.usage;
      }
      const now = seams.now ?? (() => Date.now());
      const overlapDeps: OverlapDeps = {
        environment: target.config.environment,
        readRouting: () => readRouting(target.app, target.tables.game),
        poolDocument: async (pool) => {
          const doc = await documentsFor(target, args, seams)(pool);
          return { environment: doc.environment, pool: doc.pool };
        },
        suppression: apply ? suppressionPort() : null,
        now,
        audit: (event, fields) => {
          try {
            io.err(`AUDIT ${JSON.stringify(redactIdentity({ at: now(), event, tool: "gamesDoctor", ...fields }))}`);
          } catch {
            /* an audit line never stops the work it describes (the record is the evidence) */
          }
        },
      };
      let answer: OverlapAnswer;
      if (subject === "open") {
        const minutesText = one(args, "--minutes") ?? "";
        answer = await openSuppressionOverlap(overlapDeps, { pools: [positional[2] as string, positional[3] as string], minutes: /^[0-9]{1,3}$/.test(minutesText) ? Number(minutesText) : Number.NaN, note: one(args, "--note") ?? "", recordFile, apply });
      } else {
        if (one(args, "--minutes") !== undefined) {
          io.err("gamesDoctor aws suppression-overlap close takes no --minutes");
          return EXIT.usage;
        }
        answer = await closeSuppressionOverlap(overlapDeps, { recordFile, apply });
      }
      if (json) io.out(JSON.stringify(answer, null, 2));
      else {
        io.out(`suppression-overlap ${subject} (a STAGING flip-suppression overlap test; NOT a routing flip)${answer.kind === "planned" ? " -- DRY RUN: nothing was written or published (add --apply)" : ""}`);
        io.out(`${answer.kind.toUpperCase()}: ${answer.detail}`);
        if (answer.record !== null && answer.kind !== "planned") io.out(`  record ${recordFile}`);
      }
      return answer.kind === "refused" ? EXIT.findings : EXIT.ok;
    }
    const context: MutationContext = {
      target,
      now: seams.now ?? (() => Date.now()),
      build: env.BUILD_ID ?? "gamesDoctor",
      audit: (event, fields) => {
        try {
          io.err(`AUDIT ${JSON.stringify(redactIdentity({ at: (seams.now ?? Date.now)(), event, tool: "gamesDoctor", ...fields }))}`);
        } catch {
          /* an audit line never stops the work it describes (the run's evidence item is in the table) */
        }
      },
      ...(seams.newRun !== undefined ? { newRun: seams.newRun } : {}),
      ...(seams.timing !== undefined ? { timing: seams.timing } : {}),
    };
    const note = one(args, "--note") ?? "";
    const sleep = seams.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const seconds = (name: string, fallback: number): number => {
      const text = one(args, name);
      return text !== undefined && /^[0-9]{1,6}$/.test(text) ? Number(text) * 1000 : fallback;
    };
    if (command === "flip" || command === "flip-observe") {
      const recordFile = one(args, "--flip-record");
      if (recordFile === undefined && (apply || command === "flip-observe")) {
        io.err("gamesDoctor aws flip: --flip-record <file> is required (the flip's evidence, written before the routing moves; flip-observe resumes from it)");
        return EXIT.usage;
      }
      /* Review H1: a new flip never writes over a record whose window opened (its CAS may have landed): that one is resumed
         with flip-observe; a new flip takes a new file. An existing file this tool cannot read is not overwritten either. */
      if (command === "flip" && apply && recordFile !== undefined && fs.existsSync(recordFile)) {
        const existing = parseFlipRecord(fs.readFileSync(recordFile, "utf8"));
        if ("problem" in existing || existing.window !== null) {
          io.err(`gamesDoctor aws flip: ${recordFile} ${"problem" in existing ? `exists and is not a flip record (${existing.problem})` : `is the record of a flip whose window opened (verdict ${existing.verdict}): resume it with flip-observe, or give a NEW --flip-record`}; nothing was written`);
          return EXIT.usage;
        }
      }
      const deps: FlipDeps = {
        context,
        documents: documentsFor(target, args, seams),
        sleep,
        progress: (line) => io.err(line),
        ...(recordFile !== undefined ? { persist: (record: FlipRecord) => writeFlipRecord(recordFile, record) } : {}),
        ...(apply ? { suppression: suppressionPort() } : {}),
      };
      let record: FlipRecord;
      if (command === "flip") {
        const expected = one(args, "--expect-version");
        record = await runFlip(deps, {
          from: subject as string,
          to: positional[2] as string,
          expectVersion: expected !== undefined && /^[1-9][0-9]{0,15}$/.test(expected) ? Number(expected) : Number.NaN,
          note,
          apply,
          evidence: one(args, "--evidence") ?? null,
          observeMs: seconds("--observe-seconds", DEFAULT_OBSERVE_MS),
          rollback: args.flags.has("--rollback"),
          ...(seams.pollMs !== undefined ? { pollMs: seams.pollMs } : {}),
        });
      } else {
        const parsed = parseFlipRecord(fs.readFileSync(recordFile as string, "utf8"));
        if ("problem" in parsed) {
          io.err(`gamesDoctor aws flip-observe: ${parsed.problem}`);
          return EXIT.usage;
        }
        record = await observeFlip(deps, parsed, { observeMs: seconds("--observe-seconds", DEFAULT_OBSERVE_MS), ...(seams.pollMs !== undefined ? { pollMs: seams.pollMs } : {}) });
      }
      print(record, (r) => printFlip(io, r));
      return record.verdict === "planned" || record.verdict === "roles-settled" ? EXIT.ok : record.verdict === "unknown" || record.verdict === "timeout" || record.verdict === "flipped" ? EXIT.unknown : EXIT.findings;
    }
    if (command === "recover") {
      /* Review L7: the flip record is read and validated BEFORE the pass (never a failure after its mutations ran). */
      const recordFile = one(args, "--flip-record");
      let flipRecord: FlipRecord | null = null;
      if (recordFile !== undefined) {
        const parsed = fs.existsSync(recordFile) ? parseFlipRecord(fs.readFileSync(recordFile, "utf8")) : { problem: `${recordFile} does not exist` };
        if ("problem" in parsed || parsed.from !== subject) {
          io.err(`gamesDoctor aws recover: --flip-record ${recordFile}: ${"problem" in parsed ? parsed.problem : `it is the record of a flip from ${parsed.from}, not ${subject}`}; nothing was done`);
          return EXIT.usage;
        }
        flipRecord = parsed;
      }
      const report = await recoverFromPool(
        { context, sleep, progress: (line) => io.err(line) },
        {
          from: subject as string,
          note,
          apply,
          limit: (() => {
            const text = one(args, "--limit");
            return text !== undefined && /^[1-9][0-9]{0,5}$/.test(text) ? Number(text) : DEFAULT_RECOVERY_LIMIT;
          })(),
          moneyWaitMs: seconds("--money-wait-seconds", DEFAULT_MONEY_WAIT_MS),
          ...(seams.pollMs !== undefined ? { pollMs: seams.pollMs } : {}),
        },
      );
      print(report, (r) => printRecovery(io, r));
      if (report.settled && recordFile !== undefined && flipRecord !== null && flipRecord.verdict === "roles-settled") {
        /* L6-5B: the window's alarm suppression ends with it -- ONLY if this window's open was published, and ONCE: the
           record says `closed` BEFORE the -1 is published, and nothing is published unless that record was written (a
           re-run then finds it closed; a lost publication ends at expires_at anyway). Additive encoding (review M5, L-A). */
        const closeSuppression = flipRecord.window !== null && flipRecord.window.closed_at === null && flipRecord.window.suppression === "published";
        const windowClosed = closeFlipWindow(context, flipRecord, `the recovery of ${report.from} settled`);
        const closed = closeSuppression && windowClosed.window !== null ? { ...windowClosed, window: { ...windowClosed.window, suppression: "closed" as const } } : windowClosed;
        let written = false;
        try {
          writeFlipRecord(recordFile, closed);
          written = true;
        } catch (error) {
          io.err(`gamesDoctor aws recover: the recovery SETTLED, but the flip record could not be written back (${error instanceof Error ? error.message.slice(0, 200) : String(error)}): close the window by hand`);
        }
        if (closeSuppression && written) await suppressFlipWindow(suppressionPort(), context, closed, "close");
      }
      return report.problems.length > 0 ? EXIT.findings : report.unresolved.some((u) => u.class === "mutation") ? EXIT.unknown : report.unresolved.length > 0 || report.remaining > 0 ? EXIT.findings : EXIT.ok;
    }
    let result: MutationResult;
    if (command === "set-primary") {
      const expected = one(args, "--expect-version");
      result = await setPrimary(context, { pool: subject as string, expectVersion: expected !== undefined && /^[1-9][0-9]{0,15}$/.test(expected) ? Number(expected) : Number.NaN, note, apply });
    } else if (command === "claim") result = await claimGameAsOperator(context, { gameId: subject as string, note, apply });
    else if (command === "take") result = await takeGameAsOperator(context, { gameId: subject as string, note, apply });
    else result = await releaseGameAsOperator(context, { gameId: subject as string, run: one(args, "--run") ?? "", note, apply });
    print(result, (r) => printMutation(io, r));
    return exitOf(result);
  } catch (error) {
    /* Review L3: a read that failed where no per-item answer is given (a listing's index, say) -- reported as such, never
       as a usage error. A mutation catches its own failures; anything reaching here from one is not known to be harmless. */
    const raw = error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 300) : String(error).slice(0, 300);
    /* JX-4B: money's evidence carries no AWS identifier or endpoint, its failures included. */
    const detail = command === "money" ? scrubOperatorText(raw, target) : raw;
    const mutation = !["status", "game", "games", "wallet-grants", "money", "retire-check", "orphans"].includes(command);
    io.err(`gamesDoctor aws ${command}: ${mutation ? "FAILED (see the run's evidence item, if one was written, before trying again)" : "a read failed (nothing was changed)"} -- ${detail}`);
    return mutation ? EXIT.unknown : EXIT.findings;
  } finally {
    target.destroy();
    releaseCloudWatch();
  }
}
