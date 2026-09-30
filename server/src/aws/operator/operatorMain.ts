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

import { redactIdentity } from "../../persistence/opsRecorder";
import type { ParameterSource } from "../runtime/configSource";
import { inspectDeployment, inspectGame, listGames, type DeploymentInspection, type GameInspection, type GameListing, type Read } from "./inspect";
import { claimGameAsOperator, releaseGameAsOperator, setPrimary, takeGameAsOperator, type MutationContext, type MutationResult, type OperatorRun } from "./mutations";
import { LOCAL_DOCUMENT_FLAG, OperatorRefusal, RELAYER_FLAG, resolveOperatorTarget, type OperatorTarget } from "./operatorTarget";

export const AWS_USAGE = [
  "usage: gamesDoctor aws <command> (--aws-config <SSM parameter ARN> | GS_AWS_CONFIG_PARAMETER) [--json]",
  "  status                              the deployment: routing, APPGEN, pools, the identity-writer and relayer roles (read-only)",
  "  game <game_id>                      one game's owner and whether claim / take / release are allowed (read-only)",
  "  games [--money] [--month <yyyymm>]  every directory game, or every open money game, with its owner (read-only)",
  "  set-primary <pool> --expect-version <n> --note \"<why>\" [--apply]",
  "                                      SYSTEM/ROUTING compare-and-swap (a dry run without --apply)",
  "  claim <game_id> --note \"<why>\" [--apply]      an operator run takes a released game",
  "  take <game_id> --note \"<why>\" [--apply]       an operator run takes a game whose owner epoch is superseded",
  "  release <game_id> --run <op:r-...> --note \"<why>\" [--apply]",
  "                                      an operator run's hold ends",
  `  DynamoDB Local: GS_DYNAMODB_LOCAL_ENDPOINT=<loopback> with ${LOCAL_DOCUMENT_FLAG} <runtime document file> [${RELAYER_FLAG} <account>]`,
].join("\n");

export const EXIT = Object.freeze({ ok: 0, findings: 1, usage: 2, unknown: 3 });

const VALUE_FLAGS = new Set(["--aws-config", LOCAL_DOCUMENT_FLAG, RELAYER_FLAG, "--note", "--expect-version", "--run", "--month", "--data", "--escrow-config"]);
const BOOLEAN_FLAGS = new Set(["--json", "--apply", "--money"]);

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

/** `gamesDoctor aws <argv...>`. Returns the exit code. */
export async function runAwsOperator(argv: readonly string[], env: Readonly<Record<string, string | undefined>>, io: OperatorIo, seams: OperatorSeams = {}): Promise<number> {
  const args = parseOperatorArgs(argv);
  const { positional, unknown } = args;
  const [command, subject] = positional;
  if (unknown.length > 0 || args.problems.length > 0) {
    io.err(`gamesDoctor aws: ${[...(unknown.length > 0 ? [`unknown option ${unknown.join(", ")}`] : []), ...args.problems].join("; ")}\n${AWS_USAGE}`);
    return EXIT.usage;
  }
  const known = ["status", "game", "games", "set-primary", "claim", "take", "release"];
  if (command === undefined || !known.includes(command) || (command !== "status" && command !== "games" && subject === undefined)) {
    io.err(AWS_USAGE);
    return EXIT.usage;
  }
  const json = args.flags.has("--json");
  const apply = args.flags.has("--apply");
  if (apply && (command === "status" || command === "game" || command === "games")) {
    io.err(`gamesDoctor aws ${command} is read-only: --apply means nothing here`);
    return EXIT.usage;
  }
  let target: OperatorTarget;
  try {
    target = await resolveOperatorTarget({ argv, env, ...(seams.parameters !== undefined ? { parameters: seams.parameters } : {}), ...(seams.clientFor !== undefined ? { clientFor: seams.clientFor } : {}), ...(seams.readFile !== undefined ? { readFile: seams.readFile } : {}) });
  } catch (error) {
    io.err(`gamesDoctor aws: refusing -- ${error instanceof OperatorRefusal || error instanceof Error ? error.message : String(error)}`);
    return EXIT.usage;
  }
  const print = <T>(value: T, text: (value: T) => void) => (json ? io.out(JSON.stringify(value, null, 2)) : text(value));
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
    if (command === "games") {
      const month = one(args, "--month");
      const listing = await listGames(target, { money: args.flags.has("--money"), ...(month !== undefined ? { month } : {}) });
      print(listing, (l) => printListing(io, l));
      return listing.problems.length === 0 && listing.games.every((game) => SETTLED_OWNERS.includes(game.owner)) ? EXIT.ok : EXIT.findings;
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
    const detail = error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 300) : String(error).slice(0, 300);
    const mutation = command !== "status" && command !== "game" && command !== "games";
    io.err(`gamesDoctor aws ${command}: ${mutation ? "FAILED (see the run's evidence item, if one was written, before trying again)" : "a read failed (nothing was changed)"} -- ${detail}`);
    return mutation ? EXIT.unknown : EXIT.findings;
  } finally {
    target.destroy();
  }
}
