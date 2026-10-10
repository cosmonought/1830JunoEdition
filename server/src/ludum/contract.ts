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
        authorizationWallet: { address: string; since: string } | null }; manageUrl: string;
      roles?: { reviewer: boolean } };                                // v1.1 (additive): draws the Moderation tab

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
  transactions?: Transactions;                                      // v1.1 (additive)
}

// B — POST case { chainGameId: string }  (PUBLIC, no session needed; contains no account data, no display names)
export interface CaseRecord {
  chainGameId: string; contract: string; chainId: string;
  escrow: Fact<string>;
  seats: Array<{ chainSeatIndex: number; wallet: string; isChallenger: boolean;         // wallets are already public on chain
                 displayName?: string | null }>;                    // v1.1 (owner, 2026-10-09): the seat account's unique display name
  dispute: Fact<{ challenger: string; bond: Junox; evidenceHash: string; disputedAt: string; resolverTimeoutAt: string }>;
  chainSettlement: Fact<{ seq: string; logHash: string; appraisalStateHash: string; weights: string[] }>;
  serverTerminal: Fact<{ logLen: number; logHash: string; appraisalStateHash: string; reason: string;
                         totalsBySeat: Array<{ chainSeatIndex: number; dollars: number }> }>;
  evidenceMatches: Fact<"server-log" | "server-board" | "neither">;  // challenger evidence_hash vs server's own log/board hashes
  transactions?: Transactions;                                      // v1.1 (additive)
}

// ==================================================================
//  v1.1 -- ADDITIVE AMENDMENT (docs/ludum/LUDUM_PLATFORM_ARCHITECTURE.md §5.1, owner request 2026-10-09)
// ==================================================================
//  Nothing above changes meaning; every new field is optional on the wire, so a v1 page keeps working. The error
//  vocabulary gains `conflict` (409, with `detail`) and `reauth-required` (403, with `confirmUrl`).

// The transactions THIS SERVER relayed for a game (start, checkpoints, settle, finalize, consents, annul, remedies). A
// wallet-signed transaction (create, join, challenge, a DAO proposal) never passes through the server: `walletSigned`
// says so, and a page finds those on chain itself.
export interface RelayedTransaction {
  op: "start" | "checkpoint" | "settle" | "finalize" | "consent" | "annul" | "remedy";
  txHash: string;                                                   // upper-case hex, as the chain indexes it
  status: Fact<"included" | "broadcast">;                           // included: chain-observed by the relayer, with height
  at: string;                                                       // ISO: when the server last recorded it
}
export type Transactions = Fact<{ relayed: RelayedTransaction[]; walletSigned: "not-server-recorded" }>;

// D — POST account {}  (profiled) -- the account's own page: its display name's state, and what tablemates see.
export type DisplayNameState = "changeable" | "changed" | "locked-playing" | "locked-seated";
export interface DisplayNameView { name: string; state: DisplayNameState; changedAt: string | null }
export interface AccountResponse {
  displayName: DisplayNameView;
  tablemates: Fact<{ memberSince: string; accountAgeDays: number; completedMoneyGames: number; unresolvedDisputes: number;
                     disputedGames: number; inactivityExits: number; authorizationWalletSince: string | null;
                     establishedOpponents: number | null }>;
  roles: { reviewer: boolean };
}

// E — POST display-name { name }  (profiled) -- the ONE change, before the account's first game. 200 { displayName };
// 400 bad-request "bad-name"; 409 conflict "taken" | "unchanged" | "already-changed" | "locked-playing" | "locked-seated".
export interface DisplayNameResponse { displayName: DisplayNameView }

// F — reviewer routes (a signed-in NON-reviewer gets 404 `not-found`, exactly like an unknown route). The same service,
// rules and confidentiality as Play's /gs/api/conduct/review/*: a reviewer never sees a case they are party to.
//   POST moderation-queue {}                                  -> { cases: CaseSummary[]; unreadable: number }
//   POST moderation-case { caseId }                           -> { case: CaseView }
//   POST moderation-decide { caseId, revision, status, note? } -> { case: CaseView }; 403 reauth-required { confirmUrl }
//     (a live "Confirm it's you", given on Play: https://play.netadao.org/?ludum=confirm&return=/moderation/)
// CaseSummary / CaseView are server/src/conduct/conductService.ts's reviewer views (no principal, username or wallet).
