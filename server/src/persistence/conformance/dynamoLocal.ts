// server/src/persistence/conformance/dynamoLocal.ts
//
// ==================================================================
//  LIVE-5 L5-1: THE DYNAMODB-LOCAL TEST SUBSTRATE (tables per case, deterministic cleanup, client-level faults)
// ==================================================================
//
// What every LIVE-5 DynamoDB suite stands on:
//
//   REACH      only through `createDynamoDbClient({ kind: "dynamodb-local", endpoint })` (`aws/awsClients.ts`): a loopback
//              http endpoint, dummy credentials, a fake region, SDK retries off, bounded timeouts. `requireLocal` refuses
//              any client that was not built that way, so no suite can be handed a client that reaches AWS.
//   ISOLATION  one table per case, named `gs-l5conf-<run>-<n>-<label>`: `<run>` is random per process, so two runs (two
//              terminals, a crashed earlier run) never share a table.
//   CLEANUP    deterministic and narrow: `dropAll` deletes exactly the tables this object created -- never a listing, never
//              a pattern -- and each case drops its own table when it ends (the harness's `defer`).
//   BOUNDS     every call carries `deadline()`; creation checks the table is ACTIVE once (DynamoDB Local creates tables
//              synchronously) instead of polling with sleeps.
//   FAULTS     `installFaults(client, script)`: the SAME `FaultScript` the file seam uses, applied per command (op = the
//              command name, e.g. "TransactWriteItemsCommand"; detail = the command input as JSON). `fail` answers a
//              service rejection before anything is sent (ThrottlingException unless the rule names another); `lose-answer`
//              sends the request -- DynamoDB applies it -- and then fails the caller with a timeout; `stall` holds the
//              request at a gate before it is sent; `duplicate` sends it twice.

import { randomBytes } from "crypto";
import { CreateTableCommand, DeleteTableCommand, DescribeTableCommand, type DynamoDBClient } from "@aws-sdk/client-dynamodb";

import { deadline, LOCAL_TEST_CREDENTIALS, LOCAL_TEST_REGION, localEndpointProblem } from "../../aws/awsClients";
import { arrive, type FaultScript } from "./faults";

export const TABLE_PREFIX = "gs-l5conf-";

export const newRunId = (): string => randomBytes(5).toString("hex");

/** Refuse any client that is not a DynamoDB Local client made by `createDynamoDbClient`. */
export async function requireLocal(client: DynamoDBClient): Promise<void> {
  const endpoint = await client.config.endpoint?.();
  if (endpoint === undefined) throw new Error("refusing a DynamoDB client with no explicit endpoint: it would resolve a real AWS endpoint");
  const url = `${endpoint.protocol}//${endpoint.hostname}${endpoint.port !== undefined ? `:${endpoint.port}` : ""}${endpoint.path}`;
  const problem = localEndpointProblem(url);
  if (problem !== null) throw new Error(`refusing a DynamoDB client: ${problem}`);
  if ((await client.config.region()) !== LOCAL_TEST_REGION) throw new Error("refusing a DynamoDB client that is not signed for the local test region");
  const credentials = await client.config.credentials();
  if (credentials.accessKeyId !== LOCAL_TEST_CREDENTIALS.accessKeyId) throw new Error("refusing a DynamoDB client that carries real credentials");
}

export class ConformanceTables {
  private readonly created = new Set<string>();
  private next = 0;

  constructor(
    private readonly client: DynamoDBClient,
    readonly runId: string = newRunId(),
  ) {}

  get prefix(): string {
    return `${TABLE_PREFIX}${this.runId}-`;
  }

  /** A fresh table (`pk` S hash, `sk` S range, on demand), ACTIVE on return. */
  async create(label: string): Promise<string> {
    await requireLocal(this.client);
    const name = `${this.prefix}${(this.next += 1)}-${label.replace(/[^A-Za-z0-9_.-]/g, "-")}`.slice(0, 255);
    await this.client.send(
      new CreateTableCommand({
        TableName: name,
        KeySchema: [
          { AttributeName: "pk", KeyType: "HASH" },
          { AttributeName: "sk", KeyType: "RANGE" },
        ],
        AttributeDefinitions: [
          { AttributeName: "pk", AttributeType: "S" },
          { AttributeName: "sk", AttributeType: "S" },
        ],
        BillingMode: "PAY_PER_REQUEST",
      }),
      { abortSignal: deadline() },
    );
    this.created.add(name);
    const described = await this.client.send(new DescribeTableCommand({ TableName: name }), { abortSignal: deadline() });
    if (described.Table?.TableStatus !== "ACTIVE") throw new Error(`table ${name} is ${described.Table?.TableStatus ?? "missing"} after creation (DynamoDB Local creates tables synchronously)`);
    return name;
  }

  /** Delete one table this object created (anything else is refused). */
  async drop(name: string): Promise<void> {
    if (!this.created.has(name) || !name.startsWith(this.prefix)) throw new Error(`refusing to delete ${name}: this run did not create it`);
    await this.client.send(new DeleteTableCommand({ TableName: name }), { abortSignal: deadline() });
    this.created.delete(name);
  }

  async dropAll(): Promise<void> {
    for (const name of [...this.created]) await this.drop(name);
  }

  get live(): readonly string[] {
    return [...this.created];
  }
}

/** A service-shaped error: `name` is what the SDK's modeled exceptions carry. */
function serviceError(name: string, message: string): Error {
  return Object.assign(new Error(message), { name, $fault: "client", $metadata: {} });
}

/** Apply `script` to every command this client sends. Returns the uninstaller. */
export function installFaults(client: DynamoDBClient, script: FaultScript): () => void {
  const name = `gsConformanceFaults-${newRunId()}`;
  client.middlewareStack.add(
    (next, context) => async (args) => {
      const op = (context as { commandName?: string }).commandName ?? "unknown";
      const detail = JSON.stringify((args as { input?: unknown }).input ?? null);
      const action = script.take(op, detail);
      if (action === null) return next(args);
      switch (action.kind) {
        case "fail":
          throw serviceError(action.code && action.code !== "EIO" ? action.code : "ThrottlingException", `injected: ${op} rejected before it was sent`);
        case "lose-answer": {
          await next(args);
          throw serviceError("TimeoutError", `injected: ${op} was applied and its answer lost`);
        }
        case "stall":
          arrive(action.gate);
          await action.gate.opened;
          return next(args);
        case "duplicate":
          await next(args).catch(() => undefined);
          return next(args);
        default:
          throw new Error(`fault ${action.kind} does not apply to a DynamoDB command`);
      }
    },
    { step: "initialize", name },
  );
  return () => {
    client.middlewareStack.remove(name);
  };
}
