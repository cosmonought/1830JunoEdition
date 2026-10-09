// ==================================================================
//  LUDUM API v1 -- THE FROZEN WIRE CONTRACT (types only; no runtime code)
// ==================================================================
//  Copied verbatim from docs/ludum/LUDUM_PLATFORM_ARCHITECTURE.md §5 (FROZEN). Any change is a coordinator amendment to
//  that document first. Lanes A, B2 and C import these types; none of them edits this file.
//
// server/src/ludum/contract.ts — types only
export type Provenance = "chain-confirmed" | "chain-observed" | "server-recorded" | "pending" | "unavailable";
export interface Fact<T> { value: T | null; provenance: Provenance; observedAt?: string; height?: string; reason?: string }
export interface Junox { amount: string; denom: "ujunox" }
export interface InGameMoney { dollars: number }
export interface Product { key: string; name: string }            // v1: { key: "project-18xx", name: "Project 18XX" } from server config

// A — POST session {}  (public; 200 either way)
export type SessionResponse =
  | { signedIn: false; signInUrl: string }                            // https://play.netadao.org/?ludum=signin&return=…
  | { signedIn: true; account: { name: string; username: string; memberSince: string /* YYYY-MM */;
        authorizationWallet: { address: string; since: string } | null }; manageUrl: string };

// C — POST games { cursor?: string; limit?: number /* 1..50, default 20 */ }  (profiled; 401 otherwise)
export interface GameSummary {
  gameId: string; joinCode: string | null; product: Product; variant: string | null;
  table: Fact<"waiting" | "active" | "completed" | "cancelled" | "expired" | "archived">;
  createdAt: string; startedAt: string | null; endedAt: string | null;
  seat: { displayName: string; chainSeatIndex: number | null };
  playerCount: number;
  money: null | {                                                   // null = no-money table
    chainGameId: string | null; contract: string; chainId: string;
    escrow: Fact<string>;                                           // chain Game.state, lowercased
    anteGross: Junox;                                               // terms (server-recorded until chain-confirmed)
    net: Fact<Junox>;
  };
  inGame: { rank: Fact<number>; finalNetWorth: Fact<InGameMoney> };
  disputed: Fact<boolean>;
}
export interface GamesResponse { games: GameSummary[]; nextCursor: string | null; asOf: string }

// C — POST game { gameId: string }  (profiled; 404 unless this account holds a seat)
export interface GameDetail extends GameSummary {
  seats: Array<{ displayName: string; chainSeatIndex: number | null; you: boolean;
                 finalNetWorth: Fact<InGameMoney>; rank: Fact<number> }>;
  terminal: Fact<{ reason: "BankBroken" | "Bankruptcy"; logLen: number; logHash: string }>;
  ledger: null | { entries: Array<{ kind: "ante_gross" | "subsidy" | "bond_posted" | "bond_returned" | "bond_forfeited" | "payout" | "refund";
                                    amount: Junox; fact: Fact<true> }>;
                   net: Fact<Junox>; networkFeesIncluded: false };
  dispute: null | Fact<{ challengerIsYou: boolean; bond: Junox; evidenceHash: string; disputedAt: string;
                         resolverTimeoutAt: string; resolution: "uphold" | "annul" | "replace" | null; resolvedAt: string | null }>;
  caseUrl: string | null;                                           // https://ludum.netadao.org/disputes/case/?id=<chainGameId>
}

// B — POST case { chainGameId: string }  (PUBLIC, no session needed; contains no account data, no display names)
export interface CaseRecord {
  chainGameId: string; contract: string; chainId: string;
  escrow: Fact<string>;
  seats: Array<{ chainSeatIndex: number; wallet: string; isChallenger: boolean }>;      // wallets are already public on chain
  dispute: Fact<{ challenger: string; bond: Junox; evidenceHash: string; disputedAt: string; resolverTimeoutAt: string }>;
  chainSettlement: Fact<{ seq: string; logHash: string; appraisalStateHash: string; weights: string[] }>;
  serverTerminal: Fact<{ logLen: number; logHash: string; appraisalStateHash: string; reason: string;
                         totalsBySeat: Array<{ chainSeatIndex: number; dollars: number }> }>;
  evidenceMatches: Fact<"server-log" | "server-board" | "neither">;  // challenger evidence_hash vs server's own log/board hashes
}
