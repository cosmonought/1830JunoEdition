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
// LIVE-2E: PROFILES ARE MANDATORY. A 200/201 also says `profile: {name, otherSessions}` or `profile: null`. "ready"
// means PROFILED -- the only state in which a link opens a socket (the upgrade refuses anything else). A browser with
// no profile is "unprofiled": its temporary session can only create, recover or link a profile (`profileApi.ts`), and
// `ProfileGate` holds the whole app behind that choice. The port answers by name only; no response carries an id.
//
// A BROWSER CANNOT SEE WHY A HANDSHAKE FAILED (only 1006), so the links count failed opens: after three in a row --
// or at once on a 4401 close -- they bootstrap again before their next attempt, which recovers a cookie that was
// rotated in another tab or lost with a response, then resume their backoff (serverLink 0.5-8 s, roomDocLink 1-10 s).
//
// `session-ended` IS TERMINAL FOR THIS PAGE. The links stop, and `SessionEndedNotice` asks the player; only their
// explicit "Continue" sends `{fresh: true}` (LIVE-2E: which leads to the profile gate, where the recovery key or a
// device-link code brings the profile back). Nothing here ever does that on its own -- a known session that ended must
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
}

/** LIVE-2E: the `/gs/api/*` routes a page may post to besides the bootstrap -- a closed list, so no caller can put a
 *  credential (or anything else) in a URL. */
export type SessionApiPath =
  | "session/revoke"
  | "profile"
  | "profile/recover"
  | "profile/link"
  | "profile/link-code"
  | "profile/recovery-key"
  | "profile/sign-out-others"
  /** ESCROW-3A: re-authenticate THIS session with the recovery key before a sensitive action. */
  | "profile/reauth"
  /** ESCROW-3A: the creating page received its recovery key (the lost-response rescue closes). */
  | "profile/key-received"
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
  /** The player's explicit decision, after `session-ended`, to start this browser over (LIVE-2E: unprofiled, at the
   *  profile gate). */
  startFresh(): Promise<SessionState>;
  subscribe(listener: () => void): () => void;
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

type FetchLike = (input: string, init: { method: string; credentials: "same-origin"; cache: "no-store"; headers: Record<string, string>; body: string }) => Promise<{
  status: number;
  json(): Promise<unknown>;
}>;

export interface HttpSessionOptions {
  endpoint: string;
  /** `window.fetch` when absent; a test passes its own. */
  fetch?: FetchLike;
}

/** LIVE-2E: the account a bootstrap body names -- a name and a count, nothing else -- or `null` (the profile gate). */
function accountOf(body: unknown): SessionAccount | null {
  const profile = body !== null && typeof body === "object" ? (body as { profile?: unknown }).profile : null;
  if (profile === null || typeof profile !== "object") return null;
  const { name, otherSessions } = profile as { name?: unknown; otherSessions?: unknown };
  if (typeof name !== "string" || name.trim() === "" || name.length > 64) return null;
  const others = typeof otherSessions === "number" && Number.isInteger(otherSessions) && otherSessions >= 0 ? otherSessions : 0;
  return { name, otherSessions: others };
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

  const post = async (fresh: boolean): Promise<SessionState> => {
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
      try {
        response = await request(`${apiBase}/${path}`, init(body));
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
      return { kind: "answered", status: response.status, body: parsed };
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
      return "This browser signed in to a profile, which replaced its earlier session.";
    case "signed-out-remotely":
      return "It was signed out from another of your devices.";
    default:
      return "This browser sent a session the server could not accept.";
  }
}
