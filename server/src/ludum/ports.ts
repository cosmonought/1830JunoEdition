// ==================================================================
//  LUDUM v1 -- THE DATA PORTS EVERY LUDUM HANDLER READS THROUGH (types only)
// ==================================================================
//  Copied from docs/ludum/LUDUM_PLATFORM_ARCHITECTURE.md §9 (FROZEN), typed against the real records. Lane A builds the one
//  production implementation (`wiring.ts`); handlers (Lanes B2, C) see only this interface and are tested with fakes.
//  `LudumCaller.principalId` is the authenticated principal or null (signed out) -- it never leaves the server.

import type { GameRecord, Seat } from "../rooms/gameRecord";
import type { FinancialGameRecord } from "../escrow/moneyLifecycle";
import type { TerminalSettlementEvidence } from "../escrow/settlementEvidence";
import type { Product } from "./contract";

export interface LudumPorts {
  records(): Iterable<GameRecord>;                                   // read-only view of roomHost recordIndex
  seatOf(record: GameRecord, principalId: string): Seat | null;
  financial(gameId: string): Promise<FinancialGameRecord | null>;
  financialByChainGameId(chainGameId: string): Promise<FinancialGameRecord | null>;
  terminalEvidence(gameId: string): Promise<TerminalSettlementEvidence | null>;
  chainGame(chainGameId: string): Promise<{ game: unknown /* the RAW contract GameResponse, already validated by parseGameResponse */; provenance: "chain-confirmed" | "chain-observed"; height?: string; observedAt: string } | null>;
  escrowPin(): { contract: string; chainId: string; denom: "ujunox" } | null;
  product(): Product;
  now(): number;
}
export interface LudumCaller { principalId: string | null /* null = signed out */ }
export type LudumHandler = (body: unknown, caller: LudumCaller, ports: LudumPorts) => Promise<{ status: number; json: unknown }>;
