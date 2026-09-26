// server/src/ingress/limits.ts
//
// ==================================================================
//  LIVE-2A: THE SERVER-LOCAL LIMITS, IN ONE PLACE (LIVE-2 §11.3, §12)
// ==================================================================
//
// Every number here is LIVE-2's, frozen by the design, and every one is a transport-sanity bound rather than a
// rule of 1830: a 32 KiB frame is five times the worst legitimate move, a playtest table sends a handful of moves
// a minute, and nobody types twenty chat lines in a second. They exist so that one socket -- a buggy tab or a
// hostile script -- cannot grow a log, a queue, a buffer or a server window without bound.
//
// IN-PROCESS AND PER SOCKET, deliberately. LIVE-2A has no authenticated principal yet (that is 2B), and with the
// legacy claimed identity a "per seat" bucket is exactly as strong as a per-socket one: a claim costs nothing.
// Per-IP, per-principal, per-game and global buckets arrive with the identities they are keyed by (2B/2C); the
// edge's limits are LIVE-5's. Tests override any value through `GameServerOptions.limits`.

/** LIVE-2 §11.3 / §12.2. */
export interface IngressLimits {
  /** `ws` `maxPayload`: a larger frame is closed 1009 by `ws` before a byte of it is parsed. */
  maxPayloadBytes: number;
  /** Frames received on one socket and not yet finished; beyond this the socket is closed 1008. */
  maxPendingFrames: number;
  /** Bytes queued to one socket and not yet flushed; beyond this the slow consumer is closed 1013. */
  maxOutboundBufferedBytes: number;
  /** Server ping period, and how long a socket may go without a pong before it is terminated. */
  pingIntervalMs: number;
  pongTimeoutMs: number;
  /** Consecutive `rate-limited` answers on one socket before it is closed 4429. */
  maxConsecutiveRateLimited: number;
  /** Entries per game; a submit that would begin past this is refused `log-full`. The alarm is logged at half. */
  logEntryCap: number;
  logEntryAlarm: number;
  /** Reverts per seat per hour: of the seat's own action, and (the host) of another seat's. */
  selfRevertsPerHour: number;
  hostRevertsOfOthersPerHour: number;
  /** Server-log payload excerpts (LIVE-2 §11.6). */
  logExcerptBytes: number;
  buckets: Record<BucketName, BucketSpec>;
}

export type BucketName = "submit" | "chat" | "presence" | "hello" | "control" | "roomOps" | "malformed";

/** A token bucket: `capacity` tokens, refilled at `refillPerSecond`. */
export interface BucketSpec {
  capacity: number;
  refillPerSecond: number;
}

const perMinute = (count: number) => count / 60;

export const DEFAULT_INGRESS_LIMITS: IngressLimits = Object.freeze({
  maxPayloadBytes: 32 * 1024,
  maxPendingFrames: 64,
  maxOutboundBufferedBytes: 8 * 1024 * 1024,
  pingIntervalMs: 25_000,
  pongTimeoutMs: 60_000,
  maxConsecutiveRateLimited: 20,
  logEntryCap: 10_000,
  logEntryAlarm: 5_000,
  selfRevertsPerHour: 30,
  hostRevertsOfOthersPerHour: 10,
  logExcerptBytes: 512,
  buckets: Object.freeze({
    /* Gameplay submits: burst 20, then 3 per second. */
    submit: { capacity: 20, refillPerSecond: 3 },
    /* Chat: burst 5, then one line every 3 seconds (20 a minute). */
    chat: { capacity: 5, refillPerSecond: 1 / 3 },
    /* Presence: burst 10, then 5 per second; an over-rate hint is dropped, not answered. */
    presence: { capacity: 10, refillPerSecond: 5 },
    /* `hello` (a full catch-up): 10 a minute. */
    hello: { capacity: 10, refillPerSecond: perMinute(10) },
    /* `room-hello`, `lobby-hello`, `lobby-watch` (the `rooms-watch` family): 30 a minute. */
    control: { capacity: 30, refillPerSecond: perMinute(30) },
    /* Room-document writes and seat requests (the membership ops): burst 10, then 20 a minute. */
    roomOps: { capacity: 10, refillPerSecond: perMinute(20) },
    /* Malformed frames: 10 a minute; the eleventh inside the window closes the socket 1008. */
    malformed: { capacity: 10, refillPerSecond: perMinute(10) },
  }),
}) as IngressLimits;

/** The defaults with a test's (or an operator's) overrides; bucket specs merge per bucket. */
export function resolveLimits(over: Partial<Omit<IngressLimits, "buckets">> & { buckets?: Partial<Record<BucketName, BucketSpec>> } = {}): IngressLimits {
  const { buckets, ...rest } = over;
  return {
    ...DEFAULT_INGRESS_LIMITS,
    ...rest,
    buckets: { ...DEFAULT_INGRESS_LIMITS.buckets, ...(buckets ?? {}) },
  };
}

export type IngressLimitOverrides = Parameters<typeof resolveLimits>[0];

/** One token bucket. Pure arithmetic on an injected clock, so a test can step it. */
export class TokenBucket {
  private tokens: number;
  private at: number;

  constructor(
    private readonly spec: BucketSpec,
    private readonly now: () => number,
  ) {
    this.tokens = spec.capacity;
    this.at = now();
  }

  private refill(): void {
    const now = this.now();
    const elapsed = Math.max(0, now - this.at) / 1000;
    this.tokens = Math.min(this.spec.capacity, this.tokens + elapsed * this.spec.refillPerSecond);
    this.at = now;
  }

  /** Take one token: `0` when granted, else the milliseconds until one would be. */
  take(): number {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return 0;
    }
    if (this.spec.refillPerSecond <= 0) return Number.MAX_SAFE_INTEGER;
    return Math.max(1, Math.ceil(((1 - this.tokens) / this.spec.refillPerSecond) * 1000));
  }
}

/** A socket's buckets, created on first use. */
export class SocketBuckets {
  private readonly buckets = new Map<BucketName, TokenBucket>();
  /** Consecutive `rate-limited` answers; any granted frame resets it. */
  consecutiveLimited = 0;

  constructor(
    private readonly limits: IngressLimits,
    private readonly now: () => number,
  ) {}

  take(name: BucketName): number {
    let bucket = this.buckets.get(name);
    if (bucket === undefined) {
      bucket = new TokenBucket(this.limits.buckets[name], this.now);
      this.buckets.set(name, bucket);
    }
    return bucket.take();
  }
}

/** A sliding one-hour window of events, bounded by its own limit (never more than `limit` timestamps kept). */
export class HourlyBudget {
  private readonly events: number[] = [];

  constructor(
    private readonly limit: number,
    private readonly now: () => number,
    private readonly windowMs = 60 * 60 * 1000,
  ) {}

  private prune(): void {
    const floor = this.now() - this.windowMs;
    while (this.events.length > 0 && this.events[0] <= floor) this.events.shift();
  }

  /** `0` when one more is within budget, else the milliseconds until one is. */
  retryAfter(): number {
    this.prune();
    if (this.events.length < this.limit) return 0;
    return Math.max(1, this.events[0] + this.windowMs - this.now());
  }

  record(): void {
    this.prune();
    this.events.push(this.now());
    if (this.events.length > this.limit) this.events.splice(0, this.events.length - this.limit);
  }
}

/** LIVE-2 §11.6: a payload for a server log line -- never more than `maxBytes` of it, whatever a client sent. */
export function excerpt(value: unknown, maxBytes: number): string {
  let text: string;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
  } catch {
    text = "[unserializable]";
  }
  const total = Buffer.byteLength(text, "utf8");
  if (total <= maxBytes) return text;
  /* Cut on a code-point boundary, and say how much was left out -- the whole line, marker included, within
     `maxBytes`, so a multi-megabyte frame costs the window exactly one short line. */
  const marker = `… [${total} bytes, truncated]`;
  const room = Math.max(0, maxBytes - Buffer.byteLength(marker, "utf8"));
  let cut = Array.from(text.slice(0, room)).join("");
  while (Buffer.byteLength(cut, "utf8") > room) cut = Array.from(cut).slice(0, -1).join("");
  return `${cut}${marker}`;
}
