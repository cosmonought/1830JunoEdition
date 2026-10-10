// ==================================================================
//  LUDUM v1 -- THE DATA PORTS EVERY LUDUM HANDLER READS THROUGH (types only)
// ==================================================================
//  Copied from docs/ludum/LUDUM_PLATFORM_ARCHITECTURE.md §9 (FROZEN), typed against the real records. Lane A builds the one
//  production implementation (`wiring.ts`); handlers (Lanes B2, C) see only this interface and are tested with fakes.
//  `LudumCaller.principalId` is the authenticated principal or null (signed out) -- it never leaves the server.

import type { GameRecord, Seat } from "../rooms/gameRecord";
import type { FinancialGameRecord } from "../escrow/moneyLifecycle";
import type { TerminalSettlementEvidence } from "../escrow/settlementEvidence";
import type { ChainIntentRecord } from "../escrow/chainIntents";
import type { CaseSummary, CaseView, DecideAnswer } from "../conduct/conductService";
import type { DisplayNameChangeOutcome, DisplayNameState } from "../identity/sessions";
import type { TrustFacts } from "../rooms/trustFacts";
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
  /** v1.1: an account's CURRENT unique display name (`IdentityService.profileName`), or null (none, or not active).
   *  The public case record names seats by it -- never by a seat's free table nickname, which any player may set. */
  accountDisplayName?(principalId: string): string | null;
  /** v1.1: the chain transactions this server relayed for a game (`escrow/chainIntents.ts`). Absent: none recorded here. */
  chainIntents?(gameId: string): Promise<readonly ChainIntentRecord[]>;
  /** v1.1: the account's own page and the reviewers' routes. Absent: those routes answer 503 `unavailable`. */
  members?: LudumMemberPorts;
}

/** v1.1: identity, trust and conduct, for the `account`, `display-name` and `moderation-*` handlers. Every method takes the
 *  caller's own principal (from the ingress); nothing here is reachable for another account. */
export interface LudumMemberPorts {
  displayName(principalId: string): { name: string; state: DisplayNameState } | null;
  changeDisplayName(principalId: string, name: string): Promise<DisplayNameChangeOutcome>;
  tablemateFacts(principalId: string): Promise<TrustFacts | null>;
  /** One of the conduct reviewers bound at startup (the configured reviewer usernames), AND the conduct service is enabled. */
  isReviewer(principalId: string): boolean;
  queue(principalId: string): Promise<{ readonly cases: readonly CaseSummary[]; readonly unreadable: number }>;
  caseView(caseId: string, principalId: string): Promise<CaseView | null>;
  decide(input: { caseId: string; revision: number; status: string; note: string | null; reviewerPrincipalId: string }): Promise<DecideAnswer>;
  /** Play's "Confirm it's you", returning to `returnPath` on Ludum. */
  confirmUrl(returnPath: string): string;
}
export interface LudumCaller {
  principalId: string | null /* null = signed out */;
  /** v1.1: the session holds a live sensitive grant ("Confirm it's you", or a fresh sign-in's own). Absent: false. */
  sensitiveAuth?: boolean;
}
export type LudumHandler = (body: unknown, caller: LudumCaller, ports: LudumPorts) => Promise<{ status: number; json: unknown }>;
