// frontend/src/utils/sessionBootstrap.ts
//
// ==================================================================
//  LIVE-2B (LIVE-2 §4.3 "Client behavior"): THE SESSION IS BOOTSTRAPPED BEFORE ANY SOCKET OPENS
// ==================================================================
//
// A hosted game server authenticates a socket at the upgrade, by the `__Host-gs_session` cookie. So before any link
// opens a socket, the client asks for its session: `POST /gs/api/session` (same origin, JSON, credentials
// same-origin). The server answers 200 (the session holds -- rotated, with a new cookie, when older than a week),
// 201 (a new, temporary session, with its cookie), or 401 `session-ended`. THE COOKIE IS HttpOnly: this file never
// reads it, never sees its value, and nothing the server returns carries it -- the browser keeps it and sends it.
//
// LIVE-2E: a 200/201 also says `profile: {name, otherSessions}` or `profile: null`. "ready" means SIGNED IN (a
// profiled session). P3-ACCT (owner, 2026-10-05: PUBLIC FIRST): a browser with no account is "unprofiled" -- a
// visitor. Its temporary session opens sockets too, for the public, read-only surface (the public list, Watch, the
// rules); every identity-bearing or money action needs an account first (`utils/accountPrompt.ts` asks through
// `components/AccountDialog.tsx`, then resumes the action). Nothing holds the app behind the bootstrap any more. The port answers by name only; no response
// carries an id.
//
// P3-ACCT: A SIGN-IN REPLACES THE SESSION. Creating an account, logging in, recovering one with its Authorization
// Wallet ("Forgot password?") and changing the password give this browser a FRESH session (the old one is revoked `replaced`, and its sockets close 4401). While such a request is in
// flight, a bootstrap waits for it -- so a socket that closed under the old session reconnects with the NEW cookie, not
// a bootstrap that raced the response. And a bootstrap told `replaced` asks once more after a moment: another tab of
// this browser may have just signed in, and its new cookie may still be landing in the jar. The wait is bounded: a
// sign-in that does not answer within `SIGN_IN_TIMEOUT_MS` is given up (review M3).
//
// A BROWSER CANNOT SEE WHY A HANDSHAKE FAILED (only 1006), so the links count failed opens: after three in a row --
// or at once on a 4401 close -- they bootstrap again before their next attempt, which recovers a cookie that was
// rotated in another tab or lost with a response, then resume their backoff (serverLink 0.5-8 s, roomDocLink 1-10 s).
//
// `session-ended` IS TERMINAL FOR THIS PAGE. The links stop, and `SessionEndedNotice` asks the player; only their
// explicit "Continue" sends `{fresh: true}` (P3-ACCT: a signed-out visitor again, on the public homepage, where Log in
// brings the account back -- PHASE 3 FINAL: a `retired` session belonged to an account made before Authorization
// Wallets, and its owner makes a new account).
// Nothing here ever does that on its own -- a known session that ended must
// never quietly become somebody new (LIVE-2 §4.1).
//
// Development-identity builds and tests use the always-ready port: their identity is on the socket URL, and the
// server gives each one a synthetic development profile. That port has no HTTP surface, so its profile actions
// answer "unavailable".

import { DEV_IDENTITY_BUILD } from "./devIdentity";

export type SessionState = "unknown" | "unprofiled" | "ready" | "ended";

/** LIVE-2E: who this browser plays as -- by NAME only (the server never sends an id). `development` marks the
 *  always-ready port's stand-in, which has no credentials to manage. */
export interface SessionAccount {
  readonly name: string;
  /** How many OTHER devices are signed in to this profile (for "Sign out other devices"). */
  readonly otherSessions: number;
  readonly development?: boolean;
  /** PHASE 3 FINAL: the account's username (told only to its own session; empty for the development stand-in). An open
   *  table compares it to notice that THIS BROWSER changed account under it (another tab signed in or out) -- and asks,
   *  never re-seating the table silently as someone else (`utils/tableAccountGuard.ts`). */
  readonly username?: string;
}

/** LIVE-2E: the `/gs/api/*` routes a page may post to besides the bootstrap -- a closed list, so no caller can put a
 *  credential (or anything else) in a URL. */
export type SessionApiPath =
  | "session/revoke"
  | "profile/sign-out-others"
  /** ESCROW-3A: "Confirm it's you" -- re-authenticate THIS session with the account's password before a sensitive action. */
  | "profile/reauth"
  /** The account (`profileApi.ts`): username + password + the Authorization Wallet. */
  | "account/create"
  | "account/login"
  | "account/me"
  /** "Change password" (signed in). */
  | "account/password"
  /** PHASE 3 FINAL: the Authorization Wallet's texts (CREATE / RECOVER), "Forgot password?" by it, and its replacement. */
  | "account/authorization"
  | "account/recover"
  | "account/authorization-wallet/challenge"
  | "account/authorization-wallet/replace"
  /** P3-ACCT: the factual trust indicators (`trustApi.ts`); no id, username or wallet in any answer. */
  | "trust/table"
  | "trust/me"
  /** ESCROW-4: the real-money routes (`utils/../money/moneyApi.ts`); the session's own authority, closed bodies. */
  | "money/config"
  | "money/wallet-challenge"
  | "money/wallet-link"
  | "money/join-admission"
  | "money/deposit-sent"
  | "money/consent-key"
  | "money/consent"
  | "money/annul"
  | "money/escrow-details"
  | "money/deposits";

/** A `/gs/api/*` body: a closed object of strings (ESCROW-4: and the one boolean a wallet link may carry). */
export type SessionApiBody = Record<string, string | boolean>;

/** What a `/gs/api/*` call came back with. Never a rejection: "network" when nothing answered, "unavailable" when
 *  this port has no HTTP surface at all (development identity, no game server). */
export type SessionApiAnswer =
  | { kind: "answered"; status: number; body: Record<string, unknown> | null }
  | { kind: "network" }
  | { kind: "unavailable" };

export interface SessionPort {
  readonly state: SessionState;
  /** Whether a bootstrap can change anything: true for the hosted port, false for the always-ready one (whose links
   *  therefore reconnect exactly as they did before LIVE-2B, synchronously). */
  readonly refreshable: boolean;
  /** The server's stable reason when `state` is "ended". */
  readonly endedReason: string | null;
  /** LIVE-2E: the profile, as the last bootstrap answered it; `null` unless `state` is "ready". */
  readonly account: SessionAccount | null;
  /** Bootstrap when needed (or when `force`d), resolving the state it leaves. Never rejects: "unknown" is a
   *  failure the caller retries on its own backoff. "ended" stays "ended". LIVE-2E: "unprofiled" is an answer, not a
   *  failure -- it is kept (no request) until a profile action forces the next bootstrap. */
  ensure(force?: boolean): Promise<SessionState>;
  /** The player's explicit decision, after `session-ended`, to start this browser over (P3-ACCT: a signed-out
   *  visitor on the public homepage). */
  startFresh(): Promise<SessionState>;
  subscribe(listener: () => void): () => void;
  /** PHASE 3 FINAL (§9): how many account changes THIS PAGE made itself (a create, log-in, recovery, password change or
   *  sign-out it sent and the server accepted). An open table compares it to tell its own tab's sign-in from another
   *  tab's (`utils/tableAccountGuard.ts`). Absent on the always-ready port. */
  readonly localChanges?: number;
  /** LIVE-2E: POST a closed JSON body to one of the profile routes, on the bootstrap's origin and terms. */
  api(path: SessionApiPath, body: SessionApiBody): Promise<SessionApiAnswer>;
}

/** LIVE-2E: the always-ready port's stand-in profile. The server names a development tab's profile itself. */
const DEVELOPMENT_ACCOUNT: SessionAccount = Object.freeze({ name: "Development", otherSessions: 0, development: true });

/** Always ready: nothing to bootstrap (development identity, tests, a build with no game server). */
export function readySessionPort(): SessionPort {
  return {
    state: "ready",
    refreshable: false,
    endedReason: null,
    account: DEVELOPMENT_ACCOUNT,
    ensure: () => Promise.resolve("ready"),
    startFresh: () => Promise.resolve("ready"),
    subscribe: () => () => undefined,
    api: () => Promise.resolve({ kind: "unavailable" }),
  };
}

/** `wss://host/gs` -> `https://host/gs/api/session`; `null` for anything that is not a ws(s) URL. */
export function sessionEndpointFor(socketUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(socketUrl);
  } catch {
    return null;
  }
  const protocol = url.protocol === "wss:" ? "https:" : url.protocol === "ws:" ? "http:" : null;
  if (protocol === null) return null;
  const base = url.pathname.replace(/\/+$/, "");
  const prefix = base.endsWith("/gs") ? base : `${base}/gs`;
  return `${protocol}//${url.host}${prefix}/api/session`;
}

type FetchLike = (input: string, init: { method: string; credentials: "same-origin"; cache: "no-store"; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{
  status: number;
  json(): Promise<unknown>;
}>;

export interface HttpSessionOptions {
  endpoint: string;
  /** `window.fetch` when absent; a test passes its own. */
  fetch?: FetchLike;
  /** P3-ACCT: how long a bootstrap told `replaced` waits before asking once more (default 750 ms; tests pass 0). */
  replacedRetryMs?: number;
  /** P3-ACCT (review M3): the longest a sign-in request is waited for -- and so the longest it holds this page's
   *  bootstraps -- before it counts as unreachable (default 30 s). */
  signInTimeoutMs?: number;
}

/** P3-ACCT (review M3): a sign-in that never answers is given up after this (the dialog says the server couldn't be
 *  reached; nothing is resumed). */
export const SIGN_IN_TIMEOUT_MS = 30_000;

/** P3-ACCT: the routes that REPLACE this browser's session (a sign-in of any kind). While one is in flight, a bootstrap
 *  waits for it (see the header). */
export const SESSION_REPLACING_PATHS: ReadonlySet<SessionApiPath> = new Set<SessionApiPath>(["account/create", "account/login", "account/recover", "account/password"]);

/** LIVE-2E: the account a bootstrap body names -- a name, a count and (PHASE 3 FINAL) the username, nothing else -- or
 *  `null` (signed out: a visitor). */
function accountOf(body: unknown): SessionAccount | null {
  const profile = body !== null && typeof body === "object" ? (body as { profile?: unknown }).profile : null;
  if (profile === null || typeof profile !== "object") return null;
  const { name, otherSessions, username } = profile as { name?: unknown; otherSessions?: unknown; username?: unknown };
  if (typeof name !== "string" || name.trim() === "" || name.length > 64) return null;
  const others = typeof otherSessions === "number" && Number.isInteger(otherSessions) && otherSessions >= 0 ? otherSessions : 0;
  return { name, otherSessions: others, ...(typeof username === "string" && username.length <= 256 ? { username } : {}) };
}

/** The hosted bootstrap (LIVE-2 §4.1). */
export function httpSessionPort(options: HttpSessionOptions): SessionPort {
  const request: FetchLike = options.fetch ?? ((input, init) => window.fetch(input, init));
  /* LIVE-2E: every profile route shares the bootstrap's `/gs/api` prefix and origin. */
  const apiBase = options.endpoint.replace(/\/session$/, "");
  let state: SessionState = "unknown";
  let endedReason: string | null = null;
  let account: SessionAccount | null = null;
  let inFlight: Promise<SessionState> | null = null;
  let queued: Promise<SessionState> | null = null;
  /* P3-ACCT: a sign-in on the wire (it replaces the session): bootstraps wait for its answer. */
  let replacing: Promise<unknown> | null = null;
  /* PHASE 3 FINAL (§9): account changes this page made itself. */
  let localChanges = 0;
  const replacedRetryMs = options.replacedRetryMs ?? 750;
  const signInTimeoutMs = options.signInTimeoutMs ?? SIGN_IN_TIMEOUT_MS;
  const listeners = new Set<() => void>();
  const set = (next: SessionState, reason: string | null = null, nextAccount: SessionAccount | null = null) => {
    state = next;
    endedReason = reason;
    account = nextAccount;
    listeners.forEach((listener) => listener());
  };
  const init = (body: object) => ({
    method: "POST",
    credentials: "same-origin" as const,
    cache: "no-store" as const,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const post = async (fresh: boolean, retried = false): Promise<SessionState> => {
    /* P3-ACCT: never race a sign-in this page has on the wire -- ask once its answer (and its cookie) is in. */
    while (replacing !== null) await replacing.catch(() => undefined);
    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await request(options.endpoint, init(fresh ? { fresh: true } : {}));
    } catch {
      return state === "ended" ? "ended" : "unknown";
    }
    if (response.status === 200 || response.status === 201) {
      /* LIVE-2E: a session is not enough to play -- "ready" is a profiled one. A body that cannot be read is not an
         answer about the profile either way, so the caller retries. */
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        return state === "ended" ? "ended" : "unknown";
      }
      const named = accountOf(body);
      set(named === null ? "unprofiled" : "ready", null, named);
      return state;
    }
    if (response.status === 401) {
      let reason = "ended";
      try {
        const body = (await response.json()) as { error?: unknown; reason?: unknown } | null;
        if (body && body.error === "session-ended" && typeof body.reason === "string" && /^[a-z-]{1,32}$/.test(body.reason)) {
          reason = body.reason;
        }
      } catch {
        /* the status says enough */
      }
      /* P3-ACCT: `replaced` means this browser signed in -- maybe in ANOTHER tab, whose new cookie can still be landing
         in the jar when this tab's socket closes. One more ask, after a moment, settles it; the server decides both. */
      if (reason === "replaced" && !retried && !fresh) {
        await new Promise((resolve) => setTimeout(resolve, replacedRetryMs));
        return post(false, true);
      }
      set("ended", reason);
      return "ended";
    }
    /* 403 (origin), 429 (rate), 503 (the store), anything else: not an identity decision. The caller retries. */
    return state === "ended" ? "ended" : "unknown";
  };

  const start = (): Promise<SessionState> => {
    const pending = post(false).finally(() => {
      if (inFlight === pending) inFlight = null;
    });
    inFlight = pending;
    return pending;
  };

  return {
    refreshable: true,
    get state() {
      return state;
    },
    get endedReason() {
      return endedReason;
    },
    get account() {
      return account;
    },
    ensure(force = false) {
      if (state === "ended") return Promise.resolve<SessionState>("ended");
      if ((state === "ready" || state === "unprofiled") && !force) return Promise.resolve<SessionState>(state);
      if (inFlight === null) return start();
      if (!force) return inFlight;
      /* LIVE-2E: a FORCED bootstrap must describe the session as it is after the caller's own change (a profile just
         created, other devices just signed out) -- so it never joins a request that was already on the wire before
         that change. One follow-up, shared by every forced caller meanwhile. */
      if (queued === null) {
        const follow = inFlight.then(() => {
          if (queued === follow) queued = null;
          if (state === "ended") return "ended" as SessionState;
          return inFlight ?? start();
        });
        queued = follow;
      }
      return queued;
    },
    startFresh() {
      return post(true);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async api(path, body) {
      let response: Awaited<ReturnType<FetchLike>>;
      const replaces = SESSION_REPLACING_PATHS.has(path);
      /* Review M3: a sign-in is bounded -- aborted (where the browser can) and given up after `signInTimeoutMs`, so it
         can never hold this page's bootstraps, or the dialog's busy state, for ever. */
      const abort = replaces && typeof AbortController !== "undefined" ? new AbortController() : null;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const call = replaces
        ? Promise.race([
            request(`${apiBase}/${path}`, abort === null ? init(body) : { ...init(body), signal: abort.signal }),
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(() => {
                abort?.abort();
                reject(new Error("sign-in timed out"));
              }, signInTimeoutMs);
            }),
          ])
        : request(`${apiBase}/${path}`, init(body));
      if (replaces) {
        const held = call.then(
          () => undefined,
          () => undefined,
        );
        replacing = held;
        void held.then(() => {
          if (timer !== null) clearTimeout(timer);
          if (replacing === held) replacing = null;
        });
      }
      try {
        response = await call;
      } catch {
        return { kind: "network" };
      }
      let parsed: Record<string, unknown> | null = null;
      if (response.status !== 204) {
        try {
          const value = await response.json();
          if (value !== null && typeof value === "object" && !Array.isArray(value)) parsed = value as Record<string, unknown>;
        } catch {
          /* the status says enough */
        }
      }
      /* Counted BEFORE the caller's bootstrap re-reads the account, so a table reading the new account already sees it. */
      if ((replaces || path === "session/revoke") && response.status >= 200 && response.status < 300) localChanges += 1;
      return { kind: "answered", status: response.status, body: parsed };
    },
    get localChanges() {
      return localChanges;
    },
  };
}

let installed: SessionPort | null = null;

/** The app's port, installed once at startup (`index.tsx`). Tests that install one reset it with `null`. */
export function installSessionPort(port: SessionPort | null): void {
  installed = port;
}

/** The port the links use: the installed one, or always-ready when nothing was installed (tests, tools). */
export function sessionPort(): SessionPort {
  return installed ?? READY;
}

const READY = readySessionPort();

/** What `index.tsx` installs: always-ready in a development-identity build or with no game server; the HTTP
 *  bootstrap against the game server's origin otherwise. */
export function createAppSessionPort(socketUrl: string | undefined): SessionPort {
  if (DEV_IDENTITY_BUILD || !socketUrl) return readySessionPort();
  const endpoint = sessionEndpointFor(socketUrl);
  return endpoint === null ? readySessionPort() : httpSessionPort({ endpoint });
}

/** The words for a stable `session-ended` reason. */
export function sessionEndedSentence(reason: string | null): string {
  switch (reason) {
    case "expired":
      return "It was not used for 30 days, or reached its 180-day limit.";
    case "logout":
      return "It was signed out on this browser.";
    case "evicted":
      return "It was signed in on too many browsers, and this one was the oldest.";
    case "operator":
    case "principal-disabled":
      return "It was ended by the server's operator.";
    case "rotated":
      return "It was replaced by a newer one that this browser never received.";
    /* LIVE-2E */
    case "replaced":
      return "This browser signed in to an account, which replaced its earlier session.";
    case "signed-out-remotely":
      return "It was signed out from another of your devices.";
    /* PHASE 3 FINAL */
    case "retired":
      return "It belonged to an account made before Authorization Wallets. That account is retired: create a new account to keep playing.";
    default:
      return "This browser sent a session the server could not accept.";
  }
}
