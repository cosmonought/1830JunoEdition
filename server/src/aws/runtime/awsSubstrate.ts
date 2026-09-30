// server/src/aws/runtime/awsSubstrate.ts
//
// ==================================================================
//  LIVE-5 L5-7: THE REAL SUBSTRATE -- THE CERTIFIED L5-2 ... L5-6 PIECES, AS BUILT, BEHIND THE RUNTIME'S PORT
// ==================================================================
//
// Nothing here decides an order or a reaction (that is `awsRuntime.ts`) and nothing here is a new mechanism: each method
// is one call into a certified module, with this task's clients, tables and generation. The clients come from
// `awsClients.ts` only (`createAwsClients`): one DynamoDB client for the app account's region (the game and identity
// tables -- the identity-writer takeover is one cross-table transaction, so they share it), one for the ledger's region
// (the same client when the regions agree; the ledger is reached cross-account by its full table ARN), and a KMS client
// for the escrow configuration's one KMS region.
//
// LIVE-6 L6-1 adds three READ-ONLY methods, each one call into a certified reader: `readRouting` (L5-3's strict read of
// `SYSTEM/ROUTING`, for the routing watch), `identityVerifier` (the verifier over the identity table: strong GetItems of
// L5-4's items, never the writer) and `gameDirectory` (strong reads of a game's HEAD, the routing and a record) -- the
// last two only for a non-primary task.
//
// Two small READ-ONLY helpers are this module's own (there is no DynamoDB counterpart of the file-mode readers yet):
//   - the escrow's `readLog` is a SEPARATE instance of the L5-2 log store, which never appends: the actors' instance
//     remembers what it validated and where each log continues, and a read from the escrow side must never move that;
//   - the deal's identity and the log's format class are read from the stored lines with the file mode's own readers
//     (`dealIdentityOfLog`, `logFormatOfLog`) over the exact bytes a file log would hold -- no cache, no write, and a
//     missing log is `undealt` / `current`, as on disk.

import type { DynamoDBClient } from "@aws-sdk/client-dynamodb";

import { dealIdentityOfLog, logFormatOfLog } from "../../escrow/dealIdentity";
import { GAME_ID_PATTERN } from "../../rooms/gameRecord";
import { createDynamoDbClient, createKmsClient } from "../awsClients";
import { createDynamoFinancialStore } from "../game/dynamoFinancialStore";
import { createDynamoHoldStore } from "../game/dynamoHoldStore";
import { createDynamoIntentStore } from "../game/dynamoIntentStore";
import { createDynamoLogStore } from "../game/dynamoLogStore";
import { createDynamoRecordStore } from "../game/dynamoRecordStore";
import { createDynamoTicketStore } from "../game/dynamoTicketStore";
import { gamePk, LOG_PREFIX, queryAll } from "../game/gameTable";
import { readGenerationMarker } from "../game/generationMarker";
import { readAppGeneration } from "../ledger/appGeneration";
import type { ResendTiming } from "../game/transact";
import { createDynamoIdentityStore } from "../identity/dynamoIdentityStore";
import { createDynamoSecurityJournal } from "../identity/dynamoSecurityJournal";
import { createDynamoIdentityVerifier } from "../identity/identityVerifier";
import { readRouting } from "../game/routing";
import { poolGameDirectory } from "../ownership/gameDirectory";
import { kmsDigestClient } from "../kms/kmsDigestClient";
import { openDynamoSigningLedger, readAdoptedGeneration, type DynamoSigningLedger } from "../ledger/dynamoSigningLedger";
import { createPoolGameOwnership } from "../ownership/poolGameOwnership";
import { PoolWriter } from "../ownership/poolWriter";
import { takeRelayerRole } from "../ownership/relayerRole";
import { generationProbe, takeIdentityWriterRole } from "../ownership/roles";
import type { AwsSubstrate } from "./awsRuntime";
import type { AwsRuntimeConfig } from "./runtimeConfig";

export interface AwsClients {
  /** The app account's region: the game and identity tables. */
  readonly app: DynamoDBClient;
  /** The ledger's region (the same client when the regions agree). */
  readonly ledger: DynamoDBClient;
}

/** The DynamoDB clients of an AWS task, from the runtime document's explicit regions (never the environment's). */
export function createAwsClients(config: AwsRuntimeConfig): AwsClients {
  const app = createDynamoDbClient({ kind: "aws", region: config.region });
  const ledger = config.ledger.region === config.region ? app : createDynamoDbClient({ kind: "aws", region: config.ledger.region });
  return { app, ledger };
}

export interface AwsSubstrateOptions {
  readonly config: AwsRuntimeConfig;
  readonly clients: AwsClients;
  /** The table each client addresses. Production: the document's names, and the ledger's full ARN (cross-account). The
   *  DynamoDB Local tests pass local names. */
  readonly tables?: { readonly game: string; readonly identity: string; readonly ledger: string };
  /** Tests only: the KMS port (production: `kmsDigestClient(createKmsClient({ kind: "aws", region }))`). */
  readonly kms?: (region: string) => import("../../escrow/juno/signer").KmsClient;
  /** Tests only: shorter resend waits for the game-table adapters. */
  readonly timing?: Partial<ResendTiming>;
}

/** The exact bytes a file log of `gameId` would hold (`line` + "\n" per stored entry, in index order); `null`: no log. */
async function storedLogBytes(client: DynamoDBClient, table: string, gameId: string): Promise<Buffer | null> {
  if (!GAME_ID_PATTERN.test(gameId)) throw new Error(`${gameId} is not a game id`);
  const items = await queryAll(client, table, gamePk(gameId), { prefix: LOG_PREFIX });
  if (items.length === 0) return null;
  /* An item without a line (damage) becomes an empty line: the file reader classifies it exactly as a damaged line. */
  return Buffer.from(items.map((item) => `${(item.line?.S ?? "").replace(/\n/g, "")}\n`).join(""), "utf8");
}

export function realAwsSubstrate(options: AwsSubstrateOptions): AwsSubstrate<PoolWriter, DynamoSigningLedger> {
  const { config, clients } = options;
  const tables = options.tables ?? { game: config.gameTable, identity: config.identityTable, ledger: config.ledger.arn };
  const timing = options.timing;
  return {
    adoptedGeneration: () => readAdoptedGeneration(clients.ledger, tables.ledger),

    tableGeneration: () => readGenerationMarker(clients.app, tables.game),

    adoptionBinding: async () => {
      const appgen = await readAppGeneration(clients.ledger, tables.ledger); // strict: an item this build cannot read throws
      if (appgen === null) throw new Error("the ledger has no APPGEN");
      if (appgen.current_generation !== config.generation) throw new Error(`the ledger's APPGEN moved to ${appgen.current_generation} during the startup`);
      return appgen.adoption === null ? null : { game_table: appgen.adoption.game_table, restore_id: appgen.adoption.restore_id };
    },

    takePool: ({ task, now, onLost, warn }) => PoolWriter.take({ client: clients.app, table: tables.game, pool: config.pool, task, now, onLost, warn }),

    generationProbe: () => generationProbe(clients.ledger, tables.ledger, config.generation),

    takeIdentityWriterRole: (writer) => takeIdentityWriterRole(writer, { client: clients.app, table: tables.identity }, { now: () => Date.now() }),

    openIdentityStore: (epoch, hooks) => createDynamoIdentityStore(clients.app, tables.identity, { epoch, onFenced: hooks.onFenced, onRestartRequired: hooks.onRestartRequired, warn: hooks.warn }),

    securityJournal: (hooks) => createDynamoSecurityJournal(clients.ledger, tables.ledger, { generation: config.generation, onFenced: hooks.onFenced }),

    openLedger: ({ relayer, onFenced }) => openDynamoSigningLedger(clients.ledger, { table: tables.ledger, generation: config.generation, relayer: { address: relayer }, onFenced }),

    takeRelayerRole: (writer, ledger) => takeRelayerRole(writer, { ledger, now: () => Date.now(), ...(timing !== undefined ? { timing } : {}) }),

    gameStores(writer, { relayQueue, relayerRole }) {
      const base = { client: clients.app, table: tables.game, fence: writer.fence, ...(timing !== undefined ? { timing } : {}) };
      const reader = createDynamoLogStore(base); // read-only: never appends (see the header)
      return {
        fence: writer.fence,
        log: createDynamoLogStore(base),
        readLog: (gameId) => reader.loadLog(gameId),
        readDeal: async (gameId) => {
          const bytes = await storedLogBytes(clients.app, tables.game, gameId);
          return bytes === null ? { kind: "undealt" } : dealIdentityOfLog(bytes);
        },
        readLogFormat: async (gameId) => {
          const bytes = await storedLogBytes(clients.app, tables.game, gameId);
          return bytes === null ? "current" : logFormatOfLog(bytes);
        },
        records: createDynamoRecordStore(base),
        holds: createDynamoHoldStore(base),
        financial: createDynamoFinancialStore(base),
        tickets: createDynamoTicketStore(base),
        intents: relayQueue === null ? null : createDynamoIntentStore({ ...base, relayQueue }),
        relayerIntents: relayQueue === null || relayerRole === null ? null : createDynamoIntentStore({ ...base, relayQueue, relayerRole }),
      };
    },

    ownership: (writer, { onClaimed, warn }) => createPoolGameOwnership({ client: clients.app, table: tables.game, writer, warn, ...(onClaimed !== undefined ? { onClaimed } : {}), ...(timing !== undefined ? { timing } : {}) }),

    kms: (region) => options.kms?.(region) ?? kmsDigestClient(createKmsClient({ kind: "aws", region }), { region }),

    /* LIVE-6 L6-1: read-only, every one (the routing watch; a non-primary task's verifier and directory). */
    readRouting: () => readRouting(clients.app, tables.game),

    identityVerifier: () => createDynamoIdentityVerifier(clients.app, tables.identity),

    gameDirectory: (writer) => poolGameDirectory({ client: clients.app, table: tables.game, fence: writer.fence }),
  };
}
