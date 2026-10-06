// server/src/identity/authorizationWallet.ts
//
// ==================================================================
//  PHASE 3 (FINAL ACCOUNT / AUTHORIZATION WALLET): THE ACCOUNT ACTIONS AN AUTHORIZATION WALLET SIGNS -- MINTED HERE,
//  SINGLE USE, SHORT-LIVED, BOUND TO ONE BROWSER SESSION AND ONE ACCOUNT ACTION
// ==================================================================
//
// THE MODEL (owner ruling 2026-10-06): the PROFILE / ACCOUNT IS THE PLAYER. Every active account has exactly ONE
// designated Authorization Wallet -- a profile-level authority proven by an ADR-036 signature, used to create the account,
// to recover it ("Forgot password?") and to approve its own replacement. It is never the ordinary login (username +
// password), never asked for by ordinary play, and never inferred from whatever wallet Keplr has selected.
//
// A text (`frontend/src/utils/profileAuthorizationV1.ts`) is minted for ONE request of ONE browser session:
//   CREATE           this unprofiled session, the username it is about to create, the wallet that will be designated.
//   RECOVER          this unprofiled session, a username, the wallet that claims to be its Authorization Wallet. NOTHING
//                    is looked up when it is minted (no enumeration oracle: the server says nothing about a username to a
//                    browser that has not proven the matching wallet); the match is decided when the signature arrives.
//   REPLACE-APPROVE  this signed-in session (under an explicit "Confirm it's you"), its profile, the CURRENT
//   REPLACE-ACCEPT   Authorization Wallet and the NEW one -- two texts sharing one OPERATION; a replacement needs both.
//
// SINGLE USE: an operation is taken whole (`take` marks it in use; a second take of the same operation, concurrent or
// later, finds it in use or spent -- a replay is refused); a transient failure (the KDF busy, the store unavailable)
// RELEASES it so the same signature can be sent again; every other outcome SPENDS it. Each session holds at most one open
// operation per purpose (a new mint replaces it), and the book is bounded. MEMORY ONLY: a restart drops every open
// operation (the player signs again) -- the same rule as the wallet-link challenges and the "Confirm it's you" grants.
//
// INVALIDATION: a replacement of the Authorization Wallet purges every open RECOVER operation naming that account and
// every open replacement of that profile, in the same identity-queue task that committed it -- an operation issued under
// the old designation never answers again (and a RECOVER is anyway accepted only for the profile's CURRENT wallet).
//
// Verification is the project's existing ADR-036 machinery (`escrow/walletProof.ts` `verifyAdr036`): the server rebuilds
// the sign doc from the text it minted and the wallet it expects, verifies the secp256k1 signature, and derives the
// address from the key. Nothing here is a secret, and nothing here is logged.

import { randomBytes } from "crypto";

import {
  PROFILE_AUTHORIZATION_TTL_MS,
  profileAuthorizationText,
  type ProfileAuthorizationPurpose,
} from "../../../frontend/src/utils/profileAuthorizationV1";
import { verifyAdr036 } from "../escrow/walletProof";

/** One signature as Keplr returned it (base64). */
export interface AuthorizationSignature {
  readonly pubKey: unknown;
  readonly signature: unknown;
}

/** What one operation is bound to (server-private ids: never on the wire). */
export interface AuthorizationBinding {
  readonly sessionId: string;
  readonly familyId: string;
  /** CREATE / RECOVER: the canonical login key the text names. REPLACE: the profile's. */
  readonly loginKey: string;
  /** REPLACE only: the profile, and the credential epoch (internal) it was minted under. */
  readonly profileId: string | null;
  readonly epoch: string | null;
}

export type AuthorizationKind = "create" | "recover" | "replace";

interface AuthorizationText {
  readonly purpose: ProfileAuthorizationPurpose;
  readonly signer: string;
  readonly text: string;
  readonly nonce: string;
}

export interface AuthorizationOperation {
  readonly operation: string;
  readonly kind: AuthorizationKind;
  readonly binding: AuthorizationBinding;
  /** The wallet that is (RECOVER) or becomes (CREATE, REPLACE) the Authorization Wallet. */
  readonly wallet: string;
  /** REPLACE: the current Authorization Wallet the operation replaces. */
  readonly replaces: string | null;
  readonly texts: readonly AuthorizationText[];
  readonly expiresAt: number;
}

interface Entry {
  readonly op: AuthorizationOperation;
  state: "open" | "in-use" | "spent";
  /** Who asked (security review NEW-1): the requesting address's bucket key (an IPv4 address or an IPv6 /64) and its
   *  aggregate (the IPv6 /48; the address itself for IPv4). "local" when the caller named none (tests, tools). */
  readonly client: string;
  readonly group: string;
}

/** The requesting address of a mint (the HTTP layer's `IpKey`). */
export interface AuthorizationClient {
  readonly key: string;
  readonly aggregate: string | null;
}

/** Live (open or in-use) CREATE / RECOVER operations one address may hold, and one IPv6 /48 (security review NEW-1). A
 *  household's browsers fit easily; a flood from one place is refused at its own door. REPLACE is not counted: it needs
 *  an explicitly confirmed signed-in session, one operation each. */
export const LIVE_OPERATIONS_PER_CLIENT = 16;
export const LIVE_OPERATIONS_PER_GROUP = 128;
/** A /48 (or IPv4 address) holding at most this many live operations is never evicted to make room (second re-review
 *  LOW: a household's two open RECOVERs are not the "biggest holder" an attacker can make of it by spreading its own
 *  operations thinly). Past the bound with no bigger holder, a newcomer is refused instead. */
export const NEVER_EVICTED_AT_OR_BELOW = 4;

export type TakeOutcome = { readonly kind: "open"; readonly op: AuthorizationOperation } | { readonly kind: "unknown" } | { readonly kind: "used" };

export type VerifyOutcome = { readonly ok: true } | { readonly ok: false; readonly why: "bad-key" | "bad-signature" | "wrong-wallet" };

const HEX_32 = /^[0-9a-f]{32}$/;

export function createAuthorizationBook(options: { readonly appName: string; readonly max?: number; readonly random?: (size: number) => Buffer }) {
  const byOperation = new Map<string, Entry>();
  /** `<session>\u0000<kind>` -> its open operation. */
  const openBySession = new Map<string, string>();
  const max = options.max ?? 10_000;
  const random = options.random ?? ((size: number) => randomBytes(size));
  const slot = (sessionId: string, kind: AuthorizationKind) => `${sessionId}\u0000${kind}`;

  function drop(operation: string): void {
    const entry = byOperation.get(operation);
    if (entry === undefined) return;
    byOperation.delete(operation);
    const key = slot(entry.op.binding.sessionId, entry.op.kind);
    if (openBySession.get(key) === operation) openBySession.delete(key);
  }

  function prune(now: number): void {
    for (const [operation, entry] of byOperation) if (entry.op.expiresAt <= now) drop(operation);
  }

  /** The bounded part of the book: every operation but REPLACE (see `LIVE_OPERATIONS_PER_CLIENT`). */
  const bounded = (entry: Entry): boolean => entry.op.kind !== "replace";
  const boundedSize = (): number => {
    let size = 0;
    for (const entry of byOperation.values()) if (bounded(entry)) size += 1;
    return size;
  };

  /** Room for one more CREATE / RECOVER operation from `who`?
   *  1. Per address and per /48: a client already holding its share of LIVE operations is refused (only itself).
   *  2. The whole book: expired ones are gone (`prune`); then SPENT ones go, oldest first (they only answer a replay
   *     "used"); then -- fair share -- the oldest OPEN (never IN-USE: its signature is being checked) operation of the
   *     /48 holding the MOST live operations goes, if that is a bigger holder than the asker's own. So a flood fills only
   *     its own share, a newcomer from elsewhere always gets in, and no in-flight operation is ever dropped (review L2,
   *     NEW-1). Otherwise the mint is refused. */
  function room(who: { client: string; group: string }): boolean {
    const liveByGroup = new Map<string, number>();
    let liveOfClient = 0;
    for (const entry of byOperation.values()) {
      if (!bounded(entry) || entry.state === "spent") continue;
      liveByGroup.set(entry.group, (liveByGroup.get(entry.group) ?? 0) + 1);
      if (entry.client === who.client) liveOfClient += 1;
    }
    if (liveOfClient >= LIVE_OPERATIONS_PER_CLIENT || (liveByGroup.get(who.group) ?? 0) >= LIVE_OPERATIONS_PER_GROUP) return false;
    let size = boundedSize();
    if (size < max) return true;
    for (const [operation, entry] of byOperation) {
      if (size < max) break;
      if (bounded(entry) && entry.state === "spent") {
        drop(operation);
        size -= 1;
      }
    }
    while (size >= max) {
      let biggest: string | null = null;
      for (const [group, count] of liveByGroup) if (biggest === null || count > (liveByGroup.get(biggest) ?? 0)) biggest = group;
      if (biggest === null || biggest === who.group || (liveByGroup.get(biggest) ?? 0) <= (liveByGroup.get(who.group) ?? 0) || (liveByGroup.get(biggest) ?? 0) <= NEVER_EVICTED_AT_OR_BELOW) return false;
      let evicted = false;
      for (const [operation, entry] of byOperation) {
        if (bounded(entry) && entry.group === biggest && entry.state === "open") {
          drop(operation);
          evicted = true;
          break;
        }
      }
      /* Every one of the biggest holder's operations is in use: nothing of anyone's is dropped. */
      if (!evicted) return false;
      liveByGroup.set(biggest, (liveByGroup.get(biggest) ?? 1) - 1);
      size -= 1;
    }
    return true;
  }

  const hex = (): string => random(16).toString("hex");

  return {
    /** Mint one operation (replacing this session's open one of the same kind). `wallets` per purpose: CREATE / RECOVER
     *  one text signed by `wallet`; REPLACE two texts -- APPROVE signed by `replaces`, ACCEPT by `wallet`. */
    mint(input: {
      readonly kind: AuthorizationKind;
      readonly binding: AuthorizationBinding;
      readonly site: string;
      /** The username as the player typed it (for the text; the binding carries the canonical key). */
      readonly account: string;
      readonly wallet: string;
      readonly replaces: string | null;
      /** An upper bound on the expiry (REPLACE: the "Confirm it's you" grant it is minted under). */
      readonly notAfter?: number;
      /** The requesting address (security review NEW-1); absent: "local". */
      readonly client?: AuthorizationClient;
    }, now: number): AuthorizationOperation | null {
      prune(now);
      /* This session's own open operation of this kind is replaced below: it never counts against the bound. */
      const own = openBySession.get(slot(input.binding.sessionId, input.kind));
      if (own !== undefined && byOperation.get(own)?.state === "open") drop(own);
      const who = { client: input.client?.key ?? "local", group: input.client?.aggregate ?? input.client?.key ?? "local" };
      if (input.kind !== "replace" && !room(who)) return null;
      const expiresAt = Math.min(now + PROFILE_AUTHORIZATION_TTL_MS, input.notAfter ?? Number.MAX_SAFE_INTEGER);
      const operation = hex();
      const purposes: Array<{ readonly purpose: ProfileAuthorizationPurpose; readonly signer: string }> =
        input.kind === "create"
          ? [{ purpose: "CREATE", signer: input.wallet }]
          : input.kind === "recover"
            ? [{ purpose: "RECOVER", signer: input.wallet }]
            : [
                { purpose: "REPLACE-APPROVE", signer: input.replaces as string },
                { purpose: "REPLACE-ACCEPT", signer: input.wallet },
              ];
      const texts = purposes.map(({ purpose, signer }) => {
        const nonce = input.kind === "replace" ? hex() : operation;
        const text = profileAuthorizationText({
          appName: options.appName,
          purpose,
          site: input.site,
          account: input.account,
          authorizationWallet: input.wallet,
          replaces: input.kind === "replace" ? input.replaces : null,
          signer,
          operation,
          nonce,
          expiresAt,
        });
        return { purpose, signer, text, nonce };
      });
      const op: AuthorizationOperation = { operation, kind: input.kind, binding: input.binding, wallet: input.wallet, replaces: input.kind === "replace" ? input.replaces : null, texts, expiresAt };
      const key = slot(input.binding.sessionId, input.kind);
      const previous = openBySession.get(key);
      if (previous !== undefined && byOperation.get(previous)?.state === "open") drop(previous);
      byOperation.set(operation, { op, state: "open", client: who.client, group: who.group });
      openBySession.set(key, operation);
      return op;
    },

    /** The operation a request names, if it is THIS session's (same session and family), of this kind, open and live.
     *  Marks it in use: no other request can take it until it is released or spent. */
    take(operation: unknown, kind: AuthorizationKind, session: { readonly sessionId: string; readonly familyId: string }, now: number): TakeOutcome {
      prune(now);
      if (typeof operation !== "string" || !HEX_32.test(operation)) return { kind: "unknown" };
      const entry = byOperation.get(operation);
      if (entry === undefined || entry.op.kind !== kind || entry.op.binding.sessionId !== session.sessionId || entry.op.binding.familyId !== session.familyId) return { kind: "unknown" };
      if (entry.state !== "open") return { kind: "used" };
      entry.state = "in-use";
      return { kind: "open", op: entry.op };
    },

    /** A transient failure: the same signatures may be sent again (still single use: one taker at a time). */
    release(operation: string): void {
      const entry = byOperation.get(operation);
      if (entry !== undefined && entry.state === "in-use") entry.state = "open";
    },

    /** Spent: never answered again (kept, as spent, until it expires -- a replay reads "used", not "unknown"). */
    spend(operation: string): void {
      const entry = byOperation.get(operation);
      if (entry !== undefined) entry.state = "spent";
      const key = entry === undefined ? null : slot(entry.op.binding.sessionId, entry.op.kind);
      if (key !== null && openBySession.get(key) === operation) openBySession.delete(key);
    },

    /** A replacement committed: every open RECOVER naming this account, and every open replacement of this profile,
     *  dies now (issued under the old designation). Returns how many. */
    purgeAccount(loginKey: string, profileId: string, except?: string): number {
      let purged = 0;
      for (const [operation, entry] of [...byOperation]) {
        /* The operation that caused the purge is spent by its caller (a replay of it then reads "used"). */
        if (operation === except) continue;
        const recover = entry.op.kind === "recover" && entry.op.binding.loginKey === loginKey;
        const replace = entry.op.kind === "replace" && entry.op.binding.profileId === profileId;
        if ((recover || replace) && entry.state !== "spent") {
          drop(operation);
          purged += 1;
        }
      }
      return purged;
    },

    /** Test support: how many operations are held (any state). */
    size: () => byOperation.size,
  };
}

export type AuthorizationBook = ReturnType<typeof createAuthorizationBook>;

/** One text of an operation, verified: an ADR-036 signature by the text's own signer over exactly that text. */
export function verifyAuthorization(text: { readonly signer: string; readonly text: string }, signed: AuthorizationSignature, now: number): VerifyOutcome {
  const verdict = verifyAdr036({
    wallet: text.signer,
    text: text.text,
    pubKeyBase64: typeof signed.pubKey === "string" ? signed.pubKey : "",
    signatureBase64: typeof signed.signature === "string" ? signed.signature : "",
    now,
  });
  return verdict.ok ? { ok: true } : { ok: false, why: verdict.why };
}
