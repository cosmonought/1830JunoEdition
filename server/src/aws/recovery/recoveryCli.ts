// server/src/aws/recovery/recoveryCli.ts
//
// LIVE-6 L6-4: `npm run recovery -- <command> [--flag value ...]` -- the restore's operator commands (recoveryOps.ts).
// Mutating commands only PLAN unless `--apply` is given (and the adoption also needs `--stopped`). One JSON answer on
// stdout; exit 0 (done / planned / already done), 1 (refused / conflict), 2 (usage), 3 (unknown / incomplete: re-run).
//
//   appgen-status     --ledger <table|arn>
//   table-prepare     --game-table <new> --generation <M> --from-generation <N> --from-table <old> --restore-point <ms>
//                     --restore-id <id> --by <run> [--apply]
//   appgen-adopt      --ledger <table|arn> --expected <N> --generation <M> --game-table <new> --restore-id <id> --by <run>
//                     [--apply --stopped]
//   identity-status   --identity-table <restored>
//   identity-replay   --identity-table <restored> --ledger <table|arn> --restore-id <id> --restore-point <ms> --by <run>
//                     (--source-table <old> | --source-gone <old>) [--apply]
//
// Clients: `--region <r>` (the app account's; `--ledger-region`, default the ledger ARN's region or `--region`), from the
// task role / SSO profile through `awsClients.ts` (never static keys in flags); or `--dynamodb-local <http://127.0.0.1:port>`
// for a drill on DynamoDB Local.

import { createDynamoDbClient, type AwsTarget } from "../awsClients";
import { appgenAdopt, appgenStatus, assertPrintable, identityReplay, identityStatus, tablePrepare, type RecoveryClients } from "./recoveryOps";

type Flags = Map<string, string | true>;

export class UsageError extends Error {}

export function parseFlags(argv: readonly string[]): { readonly command: string; readonly flags: Flags } {
  const [command, ...rest] = argv;
  if (command === undefined || command.startsWith("--")) throw new UsageError("a command is required");
  const flags: Flags = new Map();
  for (let at = 0; at < rest.length; at += 1) {
    const name = rest[at];
    if (!name.startsWith("--")) throw new UsageError(`unexpected argument ${JSON.stringify(name)}`);
    const next = rest[at + 1];
    if (next === undefined || next.startsWith("--")) flags.set(name.slice(2), true);
    else {
      flags.set(name.slice(2), next);
      at += 1;
    }
  }
  return { command, flags };
}

const text = (flags: Flags, name: string): string => {
  const value = flags.get(name);
  if (typeof value !== "string") throw new UsageError(`--${name} <value> is required`);
  return value;
};
const int = (flags: Flags, name: string): number => {
  const value = text(flags, name);
  if (!/^(0|[1-9][0-9]{0,15})$/.test(value)) throw new UsageError(`--${name} must be a whole number`);
  return Number(value);
};
const bool = (flags: Flags, name: string): boolean => flags.get(name) === true;

function targets(flags: Flags): { readonly app: AwsTarget; readonly ledger: AwsTarget } {
  const local = flags.get("dynamodb-local");
  if (typeof local === "string") return { app: { kind: "dynamodb-local", endpoint: local }, ledger: { kind: "dynamodb-local", endpoint: local } };
  const region = text(flags, "region");
  const ledgerTable = flags.get("ledger");
  const arnRegion = typeof ledgerTable === "string" ? /^arn:aws:dynamodb:([a-z0-9-]+):/.exec(ledgerTable)?.[1] : undefined;
  const ledgerRegion = typeof flags.get("ledger-region") === "string" ? (flags.get("ledger-region") as string) : (arnRegion ?? region);
  return { app: { kind: "aws", region }, ledger: { kind: "aws", region: ledgerRegion } };
}

/** One command; the answer and its exit code. Never prints: the caller does (after `assertPrintable`). */
export async function runRecoveryCommand(argv: readonly string[], clientsFor: (flags: Flags) => RecoveryClients, now: () => number = () => Date.now()): Promise<{ readonly exitCode: number; readonly answer: unknown }> {
  const { command, flags } = parseFlags(argv);
  const clients = clientsFor(flags);
  const exitOf = (kind: string): number => (["committed", "prepared", "complete", "planned", "ready", "already-adopted", "already-prepared", "already-complete", "status"].includes(kind) ? 0 : kind === "unknown" || kind === "incomplete" ? 3 : 1);
  switch (command) {
    case "appgen-status":
      return { exitCode: 0, answer: { kind: "status", ...(await appgenStatus(clients)) } };
    case "table-prepare": {
      const answer = await tablePrepare(
        clients,
        {
          gameTable: text(flags, "game-table"),
          generation: int(flags, "generation"),
          restoredFrom: { generation: int(flags, "from-generation"), table: text(flags, "from-table") },
          restorePoint: int(flags, "restore-point"),
          restoreId: text(flags, "restore-id"),
          by: text(flags, "by"),
          now: Math.floor(now()),
        },
        bool(flags, "apply"),
      );
      return { exitCode: exitOf(answer.kind), answer: { dry_run: !bool(flags, "apply"), ...answer } };
    }
    case "appgen-adopt": {
      const answer = await appgenAdopt(
        clients,
        { expected: int(flags, "expected"), generation: int(flags, "generation"), gameTable: text(flags, "game-table"), restoreId: text(flags, "restore-id"), by: text(flags, "by") },
        { apply: bool(flags, "apply"), stopped: bool(flags, "stopped"), now },
      );
      return { exitCode: exitOf(answer.kind), answer: { dry_run: !bool(flags, "apply"), ...answer } };
    }
    case "identity-status":
      return { exitCode: 0, answer: { kind: "status", ...(await identityStatus(clients, text(flags, "identity-table"))) } };
    case "identity-replay": {
      const fence = flags.get("source-table");
      const gone = flags.get("source-gone");
      if ((typeof fence === "string") === (typeof gone === "string")) throw new UsageError("exactly one of --source-table <old> (fenced) or --source-gone <old> (verified absent) is required");
      const answer = await identityReplay(
        clients,
        {
          table: text(flags, "identity-table"),
          restoreId: text(flags, "restore-id"),
          restorePoint: int(flags, "restore-point"),
          source: typeof fence === "string" ? { kind: "fence", table: fence } : { kind: "gone", table: gone as string },
          by: text(flags, "by"),
        },
        { apply: bool(flags, "apply"), now },
      );
      return { exitCode: exitOf(answer.kind), answer: { dry_run: !bool(flags, "apply"), ...answer } };
    }
    default:
      throw new UsageError(`unknown command ${JSON.stringify(command)}`);
  }
}

export function clientsFromFlags(flags: Flags): RecoveryClients {
  const target = targets(flags);
  const app = createDynamoDbClient(target.app);
  const ledgerClient = target.ledger.kind === target.app.kind && JSON.stringify(target.ledger) === JSON.stringify(target.app) ? app : createDynamoDbClient(target.ledger);
  const ledger = flags.get("ledger");
  return { app, ledger: { client: ledgerClient, table: typeof ledger === "string" ? ledger : "" } };
}

async function main(): Promise<void> {
  let exitCode = 2;
  try {
    const result = await runRecoveryCommand(process.argv.slice(2), clientsFromFlags);
    exitCode = result.exitCode;
    process.stdout.write(`${assertPrintable(JSON.stringify(result.answer, null, 2))}\n`);
  } catch (error) {
    exitCode = error instanceof UsageError ? 2 : 3;
    const message = `${error instanceof UsageError ? "usage: " : "error: "}${error instanceof Error ? error.message : String(error)}`;
    let printable: string;
    try {
      printable = assertPrintable(message);
    } catch {
      printable = "error: the failure's message was withheld (it would print an identifier this tool never prints)";
    }
    process.stderr.write(`${printable}\n`);
  }
  process.exit(exitCode);
}

if (require.main === module) void main();
