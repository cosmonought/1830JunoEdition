// server/src/escrow/walletTickets.ts
//
// ==================================================================
//  ESCROW-3A (brief §9, INTEGRATION-1 F-2): WALLET JOIN TICKETS -- ONE OUTSTANDING PER SEAT, ENDED BY SECURITY EVENTS
// ==================================================================
//
// THE MODEL (there is no seat rebind):
//
//   profile / principal controls the durable seat  ->  the seat owns its player_id  ->  the financial roster binds that
//   player_id to a chain seat and a payout wallet (the deposit that carried the seat's ticket).
//
// GNOLAND-1's `joinTicketV1(backend, chain, deployment, game_id, player_id, wallet, secret)` binds a ticket to ONE wallet
// for ONE seat; `freezeEscrowRoster` recomputes it through `ticketOf(player_id, wallet)` and adopts a chain seat only if
// its deposit carried exactly that ticket. GNOLAND-1 assumed "a rebind (LIVE-2E) rotates the room secret, revoking every
// unredeemed ticket" -- LIVE-2E built no rebind, and its security events touch no room (F-2). This ledger replaces that
// assumption:
//
//   ISSUE        a ticket is issued to the seat's CURRENT principal, from one session, for one declared wallet, and only
//                on a session that has re-authenticated recently (ESCROW-3A §10B: a stolen live session cannot bind a
//                wallet). Its secret is fresh randomness, used once and not kept: the ledger keeps the ticket itself
//                (the value the wallet puts on chain -- public once used, and bound to that one wallet) and the
//                SECURITY CONTEXT it was issued under: (principal, session family, recovery selector).
//   ONE          per (game_id, player_id): a new issue SUPERSEDES the outstanding one (epoch + 1), so a seat never has two
//                live tickets, and two funded wallets cannot both claim it.
//   STANDING     derived, not remembered: a ticket stands only while identity says its context does
//                (`IdentityService.securityStanding`) -- the issuing device not signed out, no "Sign out other devices"
//                from another device, the recovery key not rotated, the profile and principal active -- and while the
//                principal still holds the seat. A crash that loses a revocation event loses nothing: the next
//                `ticketOf` asks identity again. Security events are ALSO recorded here (`revokeForSecurityEvent`) so
//                the ledger file says what ended each ticket.
//   FROZEN       once the roster is frozen (ESCROW-3B commits the freeze), the claims it adopted are FROZEN with it: a
//                later sign-out cannot un-bind a deposit the chain already started with (that would strand a funded,
//                started game). Only unfrozen tickets are subject to standing. The freeze is the GAME's fact
//                (`frozen_at` on its ledger document), not inferred from its grants: a freeze with no standing ticket
//                still closes issuing. ESCROW-3B (reversible until Start is confirmed): the freeze carries the roster
//                freeze's time as its TOKEN; `unfreeze(token)` releases exactly that freeze -- only when the financial
//                record releases its roster because the chain PROVED that Start can never happen -- and the table's
//                tickets are subject to standing again (the pre-Start funded state). A confirmed Start never unfreezes.
//
//   ADMITTED     ESCROW-JOIN (2026-09-28): the contract's Join now needs the server's ADMISSION (a signature over this
//                game, the wallet, the ticket and an expiry; `escrowService.authorizeJoin`). The ledger records, on the
//                grant, the latest expiry it was admitted until (`admitted_until_secs`, Unix seconds) BEFORE the signature
//                leaves the server. An admission cannot be recalled from the chain, so while one is outstanding the
//                seat's ticket is NOT superseded (`issue` refuses `admission-outstanding` until it expires): otherwise a
//                second wallet could be admitted for the same seat while the first still can join -- more admitted
//                wallets than seats. `outstandingAdmissions` tells the room host (ESCROW-4) which seats must not move.
//
// Money games are disabled: nothing issues a ticket in production yet. ESCROW-3B/4 call `issue` from the wallet
// declaration flow and pass `ticketOf` to `freezeEscrowRoster`.

import { randomBytes } from "crypto";

import { joinTicketV1 } from "../../../frontend/src/gameEngine/escrow/escrowRoster";
import type { SecurityStanding } from "../identity/sessions";

export const WALLET_TICKET_FORMAT = "gs-wallet-ticket";

export interface WalletTicketContext {
  readonly principalId: string;
  readonly familyId: string;
  readonly recoverySelector: string;
}

export interface WalletTicketGrant {
  readonly format: typeof WALLET_TICKET_FORMAT;
  readonly game_id: string;
  readonly player_id: string;
  /** +1 per issue for this seat: the newest is the only one that can stand. */
  readonly epoch: number;
  readonly wallet: string;
  /** The ticket the wallet carries on chain (hex). Not a secret once used, and bound to `wallet` alone. */
  readonly ticket: string;
  readonly issued_at: number;
  /** Server-private (never on the wire or on chain): what the ticket was issued under. */
  readonly issued_under: { readonly principal_id: string; readonly family_id: string; readonly recovery_selector: string };
  /** Set by a superseding issue or a recorded security event (standing is still derived when this is null). */
  readonly revoked_at: number | null;
  readonly revoke_reason: "superseded" | "security-event" | "seat-lost" | null;
  /** The roster froze with this ticket's claim: no later event un-binds it. */
  readonly frozen_at: number | null;
  /** ESCROW-JOIN: the latest `expires_at` (Unix SECONDS, chain time) of a Join admission issued for this grant; null
   *  if none was. While it is in the future the grant is not superseded. */
  readonly admitted_until_secs: number | null;
}

/** One game's ledger: its grants, and whether its roster froze (the game's fact, set once by `freeze`). */
export interface WalletTicketDocument {
  readonly frozen_at: number | null;
  readonly grants: readonly WalletTicketGrant[];
}

export interface WalletTicketStore {
  /** The document and its version, read together (a CAS `put` names the version it read). */
  load(gameId: string): Promise<{ readonly version: number; readonly document: WalletTicketDocument }>;
  /** Replace a game's document whole, if its version is still `expected` (CAS; LIVE-5: one item per game). */
  put(gameId: string, document: WalletTicketDocument, expected: number): Promise<"committed" | "conflict">;
  /** ESCROW-3B: every game with a ledger document (the security-event hook walks them). */
  listGames?(): Promise<string[]>;
}

export function createMemoryWalletTicketStore(): WalletTicketStore & { readonly games: Map<string, { version: number; document: WalletTicketDocument }> } {
  const games = new Map<string, { version: number; document: WalletTicketDocument }>();
  const copy = (document: WalletTicketDocument) => JSON.parse(JSON.stringify(document)) as WalletTicketDocument;
  return {
    games,
    async load(gameId) {
      const stored = games.get(gameId);
      return { version: stored?.version ?? 0, document: stored === undefined ? { frozen_at: null, grants: [] } : copy(stored.document) };
    },
    async put(gameId, document, expected) {
      if ((games.get(gameId)?.version ?? 0) !== expected) return "conflict";
      games.set(gameId, { version: expected + 1, document: copy(document) });
      return "committed";
    },
    async listGames() {
      return [...games.keys()].sort();
    },
  };
}

export interface WalletTicketDeps {
  readonly store: WalletTicketStore;
  /** Identity's verdict on a security context (`IdentityService.securityStanding`). */
  readonly standing: (context: WalletTicketContext) => SecurityStanding;
  /** Whether this principal still holds this seat (the GameRecord's `seatOf`). There is no rebind, so this is a
   *  consistency check, never a transfer. */
  readonly holdsSeat: (gameId: string, principalId: string, playerId: string) => boolean;
  readonly now: () => number;
  readonly random?: (size: number) => Buffer;
}

export type IssueRefusal = "reauth-required" | "not-seated" | "security-context-ended" | "frozen" | "conflict" | "admission-outstanding";

/** ESCROW-JOIN: the chain compares an admission's expiry with BLOCK time, which may trail this server's clock by a block
 *  or so (and by more on a slow chain). The ledger treats an admission as outstanding until this long after its expiry,
 *  so a ticket is never superseded while the chain could still honour the old admission. */
export const ADMISSION_CLOCK_SKEW_MS = 120_000;

/** Whether an admission recorded until `untilSecs` (chain seconds) may still land on chain at server time `now` (ms). */
export const admissionOutstanding = (untilSecs: number | null, now: number): boolean => untilSecs !== null && untilSecs * 1000 + ADMISSION_CLOCK_SKEW_MS > now;

/** A seat's standing grant, as `authorizeJoin` checks it (server-private: never on the wire). */
export interface StandingGrant {
  readonly player_id: string;
  readonly epoch: number;
  readonly wallet: string;
  readonly ticket: string;
  readonly principal_id: string;
  readonly admitted_until_secs: number | null;
}

export interface TicketBinding {
  readonly backend: string;
  readonly chain_id: string;
  readonly deployment_id: string;
}

export function createWalletTicketLedger(deps: WalletTicketDeps) {
  const random = deps.random ?? ((size: number) => randomBytes(size));

  const contextOf = (grant: WalletTicketGrant): WalletTicketContext => ({
    principalId: grant.issued_under.principal_id,
    familyId: grant.issued_under.family_id,
    recoverySelector: grant.issued_under.recovery_selector,
  });

  /** Whether a grant stands NOW: newest for its seat, not revoked, and (unless frozen) its security context standing
   *  and its principal still seated. */
  function stands(grant: WalletTicketGrant, newest: boolean): boolean {
    if (!newest || grant.revoked_at !== null) return false;
    if (grant.frozen_at !== null) return true;
    if (deps.standing(contextOf(grant)).kind !== "standing") return false;
    return deps.holdsSeat(grant.game_id, grant.issued_under.principal_id, grant.player_id);
  }

  const newestOf = (grants: readonly WalletTicketGrant[], playerId: string): WalletTicketGrant | undefined =>
    grants.filter((grant) => grant.player_id === playerId).sort((a, b) => b.epoch - a.epoch)[0];

  return {
    /** Issue the seat's ticket for `wallet` -- superseding any outstanding one. The caller has established that the
     *  requesting session re-authenticated recently (`reauthorized`) and passes ITS security context. */
    async issue(input: {
      readonly binding: TicketBinding;
      readonly gameId: string;
      readonly playerId: string;
      readonly wallet: string;
      readonly context: WalletTicketContext;
      readonly reauthorized: boolean;
    }): Promise<{ readonly ok: true; readonly ticket: string; readonly epoch: number } | { readonly ok: false; readonly refusal: IssueRefusal }> {
      if (!input.reauthorized) return { ok: false, refusal: "reauth-required" };
      if (deps.standing(input.context).kind !== "standing") return { ok: false, refusal: "security-context-ended" };
      if (!deps.holdsSeat(input.gameId, input.context.principalId, input.playerId)) return { ok: false, refusal: "not-seated" };
      const { version, document } = await deps.store.load(input.gameId);
      if (document.frozen_at !== null) return { ok: false, refusal: "frozen" };
      const grants = [...document.grants];
      const now = deps.now();
      const previous = newestOf(grants, input.playerId);
      /* ESCROW-JOIN: an outstanding admission can still seat its wallet on chain; no second wallet for this seat until
         it expires (whatever ended the grant meanwhile -- a revoked grant's admission is just as usable on chain). */
      if (previous !== undefined && admissionOutstanding(previous.admitted_until_secs, now)) return { ok: false, refusal: "admission-outstanding" };
      const epoch = (previous?.epoch ?? 0) + 1;
      const ticket = joinTicketV1({
        backend: input.binding.backend,
        chain_id: input.binding.chain_id,
        deployment_id: input.binding.deployment_id,
        game_id: input.gameId,
        player_id: input.playerId,
        wallet: input.wallet,
        secret_hex: random(32).toString("hex"), // used once, never kept
      });
      const next = grants.map((grant) =>
        grant.player_id === input.playerId && grant.revoked_at === null ? { ...grant, revoked_at: now, revoke_reason: "superseded" as const } : grant,
      );
      next.push({
        format: WALLET_TICKET_FORMAT,
        game_id: input.gameId,
        player_id: input.playerId,
        epoch,
        wallet: input.wallet,
        ticket,
        issued_at: now,
        issued_under: { principal_id: input.context.principalId, family_id: input.context.familyId, recovery_selector: input.context.recoverySelector },
        revoked_at: null,
        revoke_reason: null,
        frozen_at: null,
        admitted_until_secs: null,
      });
      if ((await deps.store.put(input.gameId, { frozen_at: null, grants: next }, version)) !== "committed") return { ok: false, refusal: "conflict" };
      return { ok: true, ticket, epoch };
    },

    /** `freezeEscrowRoster`'s `ticketOf`: the standing ticket of this seat for exactly this wallet, or a value no chain
     *  ticket can equal (an ended, superseded or other-wallet ticket adopts nothing: that deposit stays unbound and
     *  refundable by the wallet's own pre-Start `Withdraw`). */
    async ticketOf(gameId: string, playerId: string, wallet: string): Promise<string> {
      const { grants } = (await deps.store.load(gameId)).document;
      const newest = newestOf(grants, playerId);
      if (newest === undefined || newest.wallet !== wallet || !stands(newest, true)) return "";
      return newest.ticket;
    },

    /** `freezeEscrowRoster`'s synchronous `ticketOf`, read once for one game (ESCROW-3B: in the SAME actor task as the
     *  freeze, then `freeze` commits the claims it adopted). */
    async lookupOf(gameId: string): Promise<(playerId: string, wallet: string) => string> {
      const { grants } = (await deps.store.load(gameId)).document;
      const standing = new Map<string, { wallet: string; ticket: string }>();
      for (const playerId of new Set(grants.map((grant) => grant.player_id))) {
        const newest = newestOf(grants, playerId);
        if (newest !== undefined && stands(newest, true)) standing.set(playerId, { wallet: newest.wallet, ticket: newest.ticket });
      }
      return (playerId, wallet) => {
        const found = standing.get(playerId);
        return found !== undefined && found.wallet === wallet ? found.ticket : "";
      };
    },

    /** ESCROW-3B: the standing ticket of every seat (newest per seat, standing now): what the roster freeze adopts
     *  claims from -- a chain seat is claimed only by the grant whose ticket AND wallet it carries. */
    async standingGrants(gameId: string): Promise<ReadonlyArray<{ readonly player_id: string; readonly wallet: string; readonly ticket: string }>> {
      const { grants } = (await deps.store.load(gameId)).document;
      const out: Array<{ player_id: string; wallet: string; ticket: string }> = [];
      for (const playerId of new Set(grants.map((grant) => grant.player_id))) {
        const newest = newestOf(grants, playerId);
        if (newest !== undefined && stands(newest, true)) out.push({ player_id: playerId, wallet: newest.wallet, ticket: newest.ticket });
      }
      return out;
    },

    /** ESCROW-JOIN: the seat's newest grant if it stands now, with the principal it was issued to (null otherwise). */
    async standingGrantOf(gameId: string, playerId: string): Promise<StandingGrant | null> {
      const { document } = await deps.store.load(gameId);
      const newest = newestOf(document.grants, playerId);
      if (newest === undefined || !stands(newest, true)) return null;
      return { player_id: newest.player_id, epoch: newest.epoch, wallet: newest.wallet, ticket: newest.ticket, principal_id: newest.issued_under.principal_id, admitted_until_secs: newest.admitted_until_secs };
    },

    /** ESCROW-JOIN, BEFORE an admission's signature leaves the server: the grant it names (this epoch, wallet and
     *  ticket; the newest, standing, unfrozen) is admitted until `expiresAt` (Unix seconds; only ever raised). Anything
     *  else -- a superseded or ended grant, a frozen game, a concurrent write -- refuses, and no admission is signed. */
    async recordAdmission(input: { readonly gameId: string; readonly playerId: string; readonly epoch: number; readonly wallet: string; readonly ticket: string; readonly expiresAt: number }): Promise<"committed" | "conflict" | "refused"> {
      if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= 0) return "refused";
      const { version, document } = await deps.store.load(input.gameId);
      if (document.frozen_at !== null) return "refused";
      const newest = newestOf(document.grants, input.playerId);
      if (newest === undefined || newest.epoch !== input.epoch || newest.wallet !== input.wallet || newest.ticket !== input.ticket || !stands(newest, true)) return "refused";
      const until = Math.max(newest.admitted_until_secs ?? 0, input.expiresAt);
      const grants = document.grants.map((grant) => (grant === newest ? { ...grant, admitted_until_secs: until } : grant));
      return deps.store.put(input.gameId, { frozen_at: document.frozen_at, grants }, version);
    },

    /** ESCROW-JOIN: every seat with an admission still usable on chain at `now` (ms; with the clock-skew margin).
     *  ESCROW-4's room host must not release or reassign these seats until then (an admission cannot be recalled from
     *  the chain): otherwise the admitted wallet can still fill a chain seat nobody can claim (`unbound-seat`). */
    async outstandingAdmissions(gameId: string, now: number = deps.now()): Promise<ReadonlyArray<{ readonly player_id: string; readonly wallet: string; readonly admitted_until_secs: number }>> {
      const { grants } = (await deps.store.load(gameId)).document;
      return grants
        .filter((grant) => admissionOutstanding(grant.admitted_until_secs, now))
        .map((grant) => ({ player_id: grant.player_id, wallet: grant.wallet, admitted_until_secs: grant.admitted_until_secs as number }));
    },

    /** Games whose ledger holds an unfrozen, unrevoked grant issued under `principalId` (the security-event hook's
     *  target list; `WalletTicketStore.games` enumerates the ledger). */
    async gamesOfPrincipal(principalId: string): Promise<string[]> {
      const out: string[] = [];
      for (const gameId of (await deps.store.listGames?.()) ?? []) {
        const { grants } = (await deps.store.load(gameId)).document;
        if (grants.some((grant) => grant.issued_under.principal_id === principalId && grant.revoked_at === null && grant.frozen_at === null)) out.push(gameId);
      }
      return out;
    },

    /** Record security events against the unfrozen grants they end (observability; standing is derived anyway). */
    async revokeForSecurityEvent(gameId: string): Promise<number> {
      const { version, document } = await deps.store.load(gameId);
      const grants = document.grants;
      const now = deps.now();
      let ended = 0;
      const next = grants.map((grant) => {
        if (grant.revoked_at !== null || grant.frozen_at !== null) return grant;
        const standing = deps.standing(contextOf(grant));
        if (standing.kind === "standing" && deps.holdsSeat(grant.game_id, grant.issued_under.principal_id, grant.player_id)) return grant;
        ended += 1;
        return { ...grant, revoked_at: now, revoke_reason: standing.kind === "standing" ? ("seat-lost" as const) : ("security-event" as const) };
      });
      if (ended > 0 && (await deps.store.put(gameId, { frozen_at: document.frozen_at, grants: next }, version)) !== "committed") return 0;
      return ended;
    },

    /** ESCROW-3B, in the SAME actor task as the roster freeze: the standing tickets are frozen with the claims. `token`
     *  (the roster freeze's `frozen_at`) names this freeze: a repeat of it changes nothing; ANOTHER freeze still in place
     *  (one a crash left without its roster, or a release not yet finished) is a conflict. */
    async freeze(gameId: string, token?: number): Promise<"committed" | "conflict"> {
      const { version, document } = await deps.store.load(gameId);
      if (document.frozen_at !== null) return token === undefined || document.frozen_at === token ? "committed" : "conflict";
      const grants = document.grants;
      const now = token ?? deps.now();
      const newestBySeat = new Map<string, number>();
      for (const grant of grants) newestBySeat.set(grant.player_id, Math.max(newestBySeat.get(grant.player_id) ?? 0, grant.epoch));
      const next = grants.map((grant) => (grant.frozen_at === null && stands(grant, newestBySeat.get(grant.player_id) === grant.epoch) ? { ...grant, frozen_at: now } : grant));
      return deps.store.put(gameId, { frozen_at: now, grants: next }, version);
    },

    /** The ledger's freeze token (null: not frozen). */
    async frozenAt(gameId: string): Promise<number | null> {
      return (await deps.store.load(gameId)).document.frozen_at;
    },

    /** ESCROW-3B: release exactly the freeze `token` names (the chain proved its Start can never happen, or a crash left
     *  a ledger freeze with no financial roster). Its grants return to derived standing; issuing reopens. Releasing a
     *  ledger that is not frozen is done already; another freeze is a conflict. */
    async unfreeze(gameId: string, token: number): Promise<"committed" | "conflict"> {
      const { version, document } = await deps.store.load(gameId);
      if (document.frozen_at === null) return "committed";
      if (document.frozen_at !== token) return "conflict";
      const grants = document.grants.map((grant) => (grant.frozen_at !== null ? { ...grant, frozen_at: null } : grant));
      return deps.store.put(gameId, { frozen_at: null, grants }, version);
    },
  };
}

export type WalletTicketLedger = ReturnType<typeof createWalletTicketLedger>;
