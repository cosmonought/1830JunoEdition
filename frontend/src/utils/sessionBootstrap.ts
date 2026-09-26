// frontend/src/utils/sessionBootstrap.ts
//
// ==================================================================
//  LIVE-2B (LIVE-2 §4.3 "Client behavior"): THE SESSION IS BOOTSTRAPPED BEFORE ANY SOCKET OPENS
// ==================================================================
//
// A hosted game server authenticates a socket at the upgrade, by the `__Host-gs_session` cookie. So before any link
// opens a socket, the client asks for its session: `POST /gs/api/session` (same origin, JSON, credentials
// same-origin). The server answers 200 (the session holds -- rotated, with a new cookie, when older than a week),
// 201 (a new guest, with its cookie), or 401 `session-ended`. THE COOKIE IS HttpOnly: this file never reads it,
// never sees its value, and nothing the server returns carries it -- the browser keeps it and sends it.
//
// A BROWSER CANNOT SEE WHY A HANDSHAKE FAILED (only 1006), so the links count failed opens: after three in a row --
// or at once on a 4401 close -- they bootstrap again before their next attempt, which recovers a cookie that was
// rotated in another tab or lost with a response, then resume their backoff (serverLink 0.5-8 s, roomDocLink 1-10 s).
//
// `session-ended` IS TERMINAL FOR THIS PAGE. The links stop, and `SessionEndedNotice` asks the player; only their
// explicit "Continue as a new guest" sends `{fresh: true}` and replaces the identity. Nothing here ever does that
// on its own -- a known session that ended must never quietly become somebody new (LIVE-2 §4.1).
//
// Development-identity builds and tests use the always-ready port: their identity is on the socket URL.

import { DEV_IDENTITY_BUILD } from "./devIdentity";

export type SessionState = "unknown" | "ready" | "ended";

export interface SessionPort {
  readonly state: SessionState;
  /** Whether a bootstrap can change anything: true for the hosted port, false for the always-ready one (whose links
   *  therefore reconnect exactly as they did before LIVE-2B, synchronously). */
  readonly refreshable: boolean;
  /** The server's stable reason when `state` is "ended". */
  readonly endedReason: string | null;
  /** Bootstrap when needed (or when `force`d), resolving the state it leaves. Never rejects: "unknown" is a
   *  failure the caller retries on its own backoff. "ended" stays "ended". */
  ensure(force?: boolean): Promise<SessionState>;
  /** The player's explicit decision to continue as a new guest. */
  startFresh(): Promise<SessionState>;
  subscribe(listener: () => void): () => void;
}

/** Always ready: nothing to bootstrap (development identity, tests, a build with no game server). */
export function readySessionPort(): SessionPort {
  return {
    state: "ready",
    refreshable: false,
    endedReason: null,
    ensure: () => Promise.resolve("ready"),
    startFresh: () => Promise.resolve("ready"),
    subscribe: () => () => undefined,
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

/** The hosted bootstrap (LIVE-2 §4.1). */
export function httpSessionPort(options: HttpSessionOptions): SessionPort {
  const request: FetchLike = options.fetch ?? ((input, init) => window.fetch(input, init));
  let state: SessionState = "unknown";
  let endedReason: string | null = null;
  let inFlight: Promise<SessionState> | null = null;
  const listeners = new Set<() => void>();
  const set = (next: SessionState, reason: string | null = null) => {
    state = next;
    endedReason = reason;
    listeners.forEach((listener) => listener());
  };

  const post = async (fresh: boolean): Promise<SessionState> => {
    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await request(options.endpoint, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(fresh ? { fresh: true } : {}),
      });
    } catch {
      return state === "ended" ? "ended" : "unknown";
    }
    if (response.status === 200 || response.status === 201) {
      set("ready");
      return "ready";
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

  return {
    refreshable: true,
    get state() {
      return state;
    },
    get endedReason() {
      return endedReason;
    },
    ensure(force = false) {
      if (state === "ended") return Promise.resolve<SessionState>("ended");
      if (state === "ready" && !force) return Promise.resolve<SessionState>("ready");
      if (inFlight === null) {
        inFlight = post(false).finally(() => {
          inFlight = null;
        });
      }
      return inFlight;
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
    default:
      return "This browser sent a session the server could not accept.";
  }
}
