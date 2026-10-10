// server/src/ludum/transactions.ts
//
// ==================================================================
//  LUDUM v1.1: THE TRANSACTIONS THIS SERVER RELAYED FOR A GAME (`Transactions`) -- FOR THE GAME RECORD AND CASE FILE DOCKETS
// ==================================================================
//
// Read from the money layer's chain intents (`escrow/chainIntents.ts`), never from a client. One entry per intent that has
// a transaction hash worth showing:
//   * included -- the relayer saw the attempt included successfully (`included-success`, or the intent's own `tx`
//     confirmation): `chain-observed`, with the inclusion height when the node said;
//   * broadcast -- still in flight, the latest attempt accepted into a mempool: `pending` (it may yet be replaced).
// An intent confirmed from chain STATE (no hash known), superseded, held, or with only failed attempts is left out: the
// docket names transactions, not the server's internal retries. Wallet-signed transactions (create, join, challenge, a
// DAO proposal) never pass through the server; `walletSigned` says so.

import type { ChainIntentRecord } from "../escrow/chainIntents";
import type { Fact, RelayedTransaction, Transactions } from "./contract";
import type { LudumPorts } from "./ports";

const TX_HASH = /^[0-9A-F]{64}$/;
const OPS: ReadonlySet<string> = new Set(["start", "checkpoint", "settle", "finalize", "consent", "annul", "remedy"]);

const iso = (ms: number): string => new Date(ms).toISOString();

/** One intent's docket entry, or null (nothing worth showing: see the header). */
export function relayedOf(intent: ChainIntentRecord): RelayedTransaction | null {
  if (!OPS.has(intent.op.kind)) return null;
  const op = intent.op.kind as RelayedTransaction["op"];
  const included = intent.attempts.find((attempt) => attempt.phase === "included-success" && TX_HASH.test(attempt.tx_hash));
  const confirmedHash = intent.confirmation?.how === "tx" && intent.confirmation.tx_hash !== null && TX_HASH.test(intent.confirmation.tx_hash) ? intent.confirmation.tx_hash : null;
  if (included !== undefined || confirmedHash !== null) {
    const txHash = included?.tx_hash ?? (confirmedHash as string);
    const height = included?.inclusion?.height ?? intent.confirmation?.height ?? null;
    const observed = included?.observed_at ?? intent.confirmation?.at ?? intent.updated_at;
    const status: Fact<"included"> = { value: "included", provenance: "chain-observed", observedAt: iso(observed), ...(height !== null ? { height } : {}) };
    return { op, txHash, status, at: iso(intent.updated_at) };
  }
  if (intent.status !== "pending" && intent.status !== "in-flight") return null;
  const live = [...intent.attempts].reverse().find((attempt) => attempt.phase === "broadcast" && TX_HASH.test(attempt.tx_hash));
  if (live === undefined) return null;
  return { op, txHash: live.tx_hash, status: { value: "broadcast", provenance: "pending" }, at: iso(intent.updated_at) };
}

/** Every relayed transaction of a game, oldest first; `unavailable` when this server keeps none or cannot read them. */
export async function transactionsOf(ports: LudumPorts, gameId: string | null): Promise<Transactions> {
  if (gameId === null) return { value: null, provenance: "unavailable", reason: "this server holds no record of this game" };
  if (ports.chainIntents === undefined) return { value: null, provenance: "unavailable", reason: "this server relays no transactions" };
  let intents: readonly ChainIntentRecord[];
  try {
    intents = await ports.chainIntents(gameId);
  } catch {
    return { value: null, provenance: "unavailable", reason: "this server's transaction records could not be read" };
  }
  const relayed = [...intents]
    .sort((a, b) => a.created_at - b.created_at || (a.intent_id < b.intent_id ? -1 : 1))
    .map(relayedOf)
    .filter((entry): entry is RelayedTransaction => entry !== null);
  return { value: { relayed, walletSigned: "not-server-recorded" }, provenance: "server-recorded", observedAt: iso(ports.now()) };
}
