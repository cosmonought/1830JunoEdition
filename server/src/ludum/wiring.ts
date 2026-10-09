// server/src/ludum/wiring.ts
//
// ==================================================================
//  LUDUM v1 (Lane A): THE ONE PRODUCTION `LudumPorts` (§9) -- READ-ONLY VIEWS OF WHAT THE SERVER ALREADY HOLDS
// ==================================================================
//
//   records()                  the room host's record index (a snapshot: `RoomHost.records`)
//   seatOf                     `rooms/gameRecord.ts`'s own `seatOf`
//   financial(gameId)          the money layer's financial record (`MoneyTables.financialRecord`); null without money
//   financialByChainGameId     the money record whose binding names that chain game: a scan of the money tables' records
//                              (O(money tables)); a match is remembered, because a binding is write-once
//   terminalEvidence(gameId)   the financial record's `intent` -- the terminal settlement evidence, derived once
//   chainGame(chainGameId)     the escrow game from the chain (`MoneyTables.ludumChain.game`): a quorum read where two or
//                              more endpoints are configured (`chain-confirmed`), else one endpoint's (`chain-observed`,
//                              with its height); null when the chain has no such game
//   escrowPin()                the pinned deployment -- null without money, or when its denom is not `ujunox`
//   product()                  { key: "project-18xx", name: APP_NAME }
//
// Nothing here writes, caches a chain fact, or reads an identity record: principals stay on the server (the handlers see
// `LudumCaller.principalId` and these ports only).

import { APP_NAME } from "../../../frontend/src/config";
import { seatOf, type GameRecord } from "../rooms/gameRecord";
import type { FinancialGameRecord } from "../escrow/moneyLifecycle";
import type { MoneyTables } from "../escrow/moneyTables";
import type { Product } from "./contract";
import type { LudumPorts } from "./ports";

const CHAIN_GAME_ID = /^[1-9][0-9]{0,19}$/;

/** The product key of a display name: lower case, words joined by `-` ("Project 18XX" -> "project-18xx"). */
export const productKeyOf = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/** INTEGRATION (archived-history gap, docs/ludum/LUDUM_PLATFORM_ARCHITECTURE.md §12): `records()` is the room host's
 *  in-memory index, which is complete only after startup discovery listed every record without a store fault. While it is
 *  not, `records()` THROWS this (the ingress answers 503 `unavailable`) -- a partial index is never served as an
 *  account's whole history. */
export class LudumIndexIncomplete extends Error {}

export type LudumIndexState = { readonly complete: true } | { readonly complete: false; readonly reason: string };

export interface LudumWiringDeps {
  /** `RoomHost.records`. */
  readonly records: () => readonly GameRecord[];
  /** Whether `records` is the whole durable record set (absent: assumed complete -- tests and tools only). */
  readonly index?: () => LudumIndexState;
  /** The money layer, or null when this server has none (every money port then answers null). */
  readonly money: () => MoneyTables | null;
  readonly now: () => number;
  readonly product?: Product;
}

export function createLudumPorts(deps: LudumWiringDeps): LudumPorts {
  const product: Product = Object.freeze(deps.product ?? { key: productKeyOf(APP_NAME), name: APP_NAME });
  /** chain game id -> game id, for bindings already found (a binding never changes once written). */
  const byChain = new Map<string, string>();

  const financial = async (gameId: string): Promise<FinancialGameRecord | null> => {
    const money = deps.money();
    return money === null ? null : money.financialRecord(gameId);
  };
  const chainIdOf = (record: FinancialGameRecord | null): string | null => record?.binding?.escrow?.chain_game_id ?? null;

  const records = (): readonly GameRecord[] => {
    const state = deps.index?.() ?? { complete: true as const };
    if (!state.complete) throw new LudumIndexIncomplete(state.reason);
    return deps.records();
  };

  return {
    records,
    seatOf: (record, principalId) => seatOf(record, principalId),
    financial,
    async financialByChainGameId(chainGameId) {
      if (!CHAIN_GAME_ID.test(chainGameId) || deps.money() === null) return null;
      const known = byChain.get(chainGameId);
      if (known !== undefined) {
        const record = await financial(known);
        if (chainIdOf(record) === chainGameId) return record;
        byChain.delete(chainGameId);
      }
      for (const game of records()) {
        if (game.money === null) continue;
        const record = await financial(game.game_id);
        const bound = chainIdOf(record);
        if (bound !== null) byChain.set(bound, game.game_id);
        if (bound === chainGameId) return record;
      }
      return null;
    },
    async terminalEvidence(gameId) {
      return (await financial(gameId))?.intent ?? null;
    },
    async chainGame(chainGameId) {
      const money = deps.money();
      if (money === null || !CHAIN_GAME_ID.test(chainGameId)) return null;
      return money.ludumChain.game(chainGameId);
    },
    escrowPin() {
      const money = deps.money();
      if (money === null) return null;
      const pin = money.ludumChain.pin();
      if (pin.denom !== "ujunox") return null;
      return { contract: pin.contract, chainId: pin.chainId, denom: "ujunox" };
    },
    product: () => product,
    now: () => deps.now(),
  };
}
