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
//
// LIVE-2B adds the IDENTITY limits (`identity` below): per IP key (IPv4 /32, IPv6 /64 with a /48 aggregate at ten
// times the limit), per session, per principal and global -- the upgrade and bootstrap budgets, the socket caps
// and the malformed-close cooldown of LIVE-2 §12.2. Every per-socket bucket above stays, as defence in depth. The
// §12.2 limits keyed by GAME or SEAT (room creation, join-code failures, membership ops per principal, per-game
// submits, transfer codes, viewers per room) wait for LIVE-2C's GameRecord: there is nothing honest to key them by
// before a seat has an authoritative owner.

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
  /** LIVE-2B (LIVE-2 §12.2): identity, upgrade and socket limits. */
  identity: IdentityLimits;
  /** LIVE-2C (LIVE-2 §12.2): the limits keyed by principal, game and seat, now that seats have owners. */
  rooms: RoomLimits;
}

/** LIVE-2C (LIVE-2 §12.2). */
export interface RoomLimits {
  /** Room creation: per principal, per IP key, and for the whole server. */
  createsPerPrincipal: BucketSpec;
  createsPerIp: BucketSpec;
  createsGlobal: BucketSpec;
  /** Hosted non-terminal rooms per principal (`limit-reached`). */
  maxHostedRooms: number;
  /** Seated non-terminal games per principal (`limit-reached`). */
  maxSeatedGames: number;
  /** Join-code failures: per principal and per IP key (10 minutes), and for the whole server (an hour). */
  joinFailuresPerPrincipal: BucketSpec;
  joinFailuresPerIp: BucketSpec;
  joinFailuresGlobal: BucketSpec;
  /** Membership ops (join, take, release, leave, ready, profile) per principal. */
  membershipOpsPerPrincipal: BucketSpec;
  /** Gameplay submits per seat and per game. */
  submitsPerSeat: BucketSpec;
  submitsPerGame: BucketSpec;
  /** Chat per principal per game. */
  chatPerSeat: BucketSpec;
  /** Join-code rotations (rotate-code, going private) per game: each rewrites the join index. */
  codeRotationsPerGame: BucketSpec;
  /** The public list is rebroadcast at most this often. */
  listCoalesceMs: number;
  /** An unknown game id is remembered as unknown this long (no repeated store reads). */
  unknownGameTtlMs: number;
  maxUnknownGames: number;
  /** A socket that authenticated but never subscribed to anything is closed 1000 after this. */
  unsubscribedReapMs: number;
}

/** LIVE-2B (LIVE-2 §4.3, §12.2). */
export interface IdentityLimits {
  /** Upgrades that failed (Origin, authentication, principal cap), per IP key: burst 20, 30 a minute. */
  failedUpgradesPerIp: BucketSpec;
  /** Every upgrade attempt, per IP key: 60 a minute. */
  upgradesPerIp: BucketSpec;
  /** Every upgrade attempt, the whole server: 50 a second (503 beyond). */
  upgradesGlobal: BucketSpec;
  /** Bootstraps that create a principal, per IP key: burst 10, then 20 an hour. */
  guestCreatesPerIp: BucketSpec;
  /** Bootstraps that create a principal, the whole server: 600 an hour. */
  guestCreatesGlobal: BucketSpec;
  /** Bootstraps (and revokes) presenting an existing session, per session: 60 a minute. */
  bootstrapsPerSession: BucketSpec;
  /** LIVE-2B adversarial review: successors minted from rotated sessions inside their 24-hour grace, PER PRINCIPAL
   *  (each is a new durable session record for an activated guest): burst 5, then 10 an hour. Two tabs and a lost
   *  Set-Cookie need two or three; a replayed or stolen rotated cookie gets no more. */
  graceMintsPerSession: BucketSpec;
  /** LIVE-2E: profile creations, per IP key (each writes durable records): burst 5, then 10 an hour. */
  profileCreatesPerIp: BucketSpec;
  /** LIVE-2E: profile creations, the whole server: 300 an hour. */
  profileCreatesGlobal: BucketSpec;
  /** LIVE-2E: recovery-key and link-code redemptions -- right or wrong -- per IP key: burst 10, then 30 an hour.
   *  Independent of every room limit; a guess costs the same as a right answer. */
  credentialRedeemsPerIp: BucketSpec;
  /** LIVE-2E: the same, per SESSION (the browser making them): burst 10, then 30 an hour. There is no server-wide
   *  redemption budget (LIVE-2E review M1): it would let a few addresses switch recovery off for everybody. */
  credentialRedeemsPerSession: BucketSpec;
  /** LIVE-2E: link-code issues, recovery-key rotations and "sign out other devices", per SESSION (review H1: a
   *  principal-wide budget let one device starve the owner's others): burst 6, then 30 an hour. */
  profileActionsPerSession: BucketSpec;
  /** P3-ACCT: username/password sign-in attempts -- right or wrong -- per SESSION (the browser making them): burst 10,
   *  then 30 an hour. */
  passwordLoginsPerSession: BucketSpec;
  /** P3-ACCT: WRONG passwords per IP key (and /48): burst 20, then 60 an hour. Unlike a recovery key's 256 bits, a
   *  password can be guessed, so once this is spent EVERY password attempt from the address is refused 429 -- before
   *  any check -- until it refills (a neighbour's typos can delay a sign-in; nobody can keep guessing). */
  passwordFailuresPerIp: BucketSpec;
  /** P3-ACCT: WRONG passwords per USERNAME (its canonical key; an unknown username is charged exactly like a known one,
   *  so the budget says nothing about which exist), from every address together: burst 50, then 100 an hour -- the
   *  backstop against a distributed guess. (Review M2: deliberately wider than the per-address one below, so a stranger
   *  who knows a username cannot cheaply lock its owner out of signing in elsewhere; and a signed-in session's own
   *  "Confirm it's you" never reads it -- `passwordReauthFailuresPerSession`.) */
  passwordFailuresPerAccount: BucketSpec;
  /** P3-ACCT (review M2): WRONG passwords per USERNAME from ONE address key: burst 10, then 20 an hour. */
  passwordFailuresPerAccountAddress: BucketSpec;
  /** P3-ACCT (review M2): WRONG passwords in "Confirm it's you" per SESSION FAMILY (one signed-in device, its rotated
   *  cookies included -- re-review N-1): burst 10, then 20 an hour. Nobody else's guesses can block the owner's own
   *  confirmation. */
  passwordReauthFailuresPerFamily: BucketSpec;
  /** P3-ACCT (re-review N-1): WRONG passwords in "Confirm it's you" per ACCOUNT, across all of its signed-in devices:
   *  burst 20, then 20 an hour -- the backstop that keeps a stolen cookie from guessing the password at the speed it
   *  can mint new sessions (link codes, rotated cookies). Only the account's own sessions can spend it; an owner kept
   *  out of "Confirm it's you" by a thief still signs in afresh (a sign-in confirms for its first minutes) and signs the
   *  other devices out. */
  passwordReauthFailuresPerAccount: BucketSpec;
  /** LIVE-2E: sockets per SESSION -- one browser or device, all of its tabs (they share the cookie). */
  maxSocketsPerSession: number;
  /** Sockets per principal, across every session (device) that authenticates it. */
  maxSocketsPerPrincipal: number;
  maxSocketsPerProvisionalPrincipal: number;
  maxSocketsPerIp: number;
  maxSocketsGlobal: number;
  /** Malformed-flood closes (LIVE-2A's 1008, and ws's 1009) from one IP key within the window that start a cooldown. */
  malformedClosesForCooldown: number;
  malformedCloseWindowMs: number;
  /** How long an IP key's upgrades are refused 429 after that. */
  malformedCooldownMs: number;
  /** An IPv6 /48 is allowed this many times a /64's budget. */
  ipv6AggregateFactor: number;
  /** Keys a keyed limiter holds before it forgets its oldest (full buckets are pruned every sweep). */
  maxTrackedKeys: number;
  /** The session sweep, the identity write-behind and the limiter pruning: every 60 s. */
  sweepIntervalMs: number;
  /** `/gs/api/*` request bodies. */
  maxApiBodyBytes: number;
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
  identity: Object.freeze({
    failedUpgradesPerIp: { capacity: 20, refillPerSecond: perMinute(30) },
    upgradesPerIp: { capacity: 60, refillPerSecond: perMinute(60) },
    upgradesGlobal: { capacity: 50, refillPerSecond: 50 },
    guestCreatesPerIp: { capacity: 10, refillPerSecond: 20 / 3600 },
    guestCreatesGlobal: { capacity: 600, refillPerSecond: 600 / 3600 },
    bootstrapsPerSession: { capacity: 60, refillPerSecond: perMinute(60) },
    graceMintsPerSession: { capacity: 5, refillPerSecond: 10 / 3600 },
    profileCreatesPerIp: { capacity: 5, refillPerSecond: 10 / 3600 },
    profileCreatesGlobal: { capacity: 300, refillPerSecond: 300 / 3600 },
    credentialRedeemsPerIp: { capacity: 10, refillPerSecond: 30 / 3600 },
    credentialRedeemsPerSession: { capacity: 10, refillPerSecond: 30 / 3600 },
    profileActionsPerSession: { capacity: 6, refillPerSecond: 30 / 3600 },
    passwordLoginsPerSession: { capacity: 10, refillPerSecond: 30 / 3600 },
    passwordFailuresPerIp: { capacity: 20, refillPerSecond: 60 / 3600 },
    passwordFailuresPerAccount: { capacity: 50, refillPerSecond: 100 / 3600 },
    passwordFailuresPerAccountAddress: { capacity: 10, refillPerSecond: 20 / 3600 },
    passwordReauthFailuresPerFamily: { capacity: 10, refillPerSecond: 20 / 3600 },
    passwordReauthFailuresPerAccount: { capacity: 20, refillPerSecond: 20 / 3600 },
    /* LIVE-2E: THE CAPS FROM THE CLIENT'S ACTUAL TOPOLOGY. One tab holds at most THREE sockets: the lobby channel
       (the public list and the create/join ops; it closes 1.5 s after nothing listens), one room channel per open
       table (its view, chat and presence share it) and the game-log link -- two while seated at a table, one in the
       lobby, three only in the moment between them. So a session (a browser: its tabs share the cookie) is allowed
       FOUR TABS at that peak (12), and a principal TWO DEVICES at theirs (24). The per-address (64, 640 per /48) and
       global (2,000) caps are unchanged: a household or a NAT is bounded exactly as before. A new, never-activated
       browser gets two tabs (6) -- enough not to be refused for opening a second tab, still bounded per address. */
    maxSocketsPerSession: 12,
    maxSocketsPerPrincipal: 24,
    maxSocketsPerProvisionalPrincipal: 6,
    maxSocketsPerIp: 64,
    maxSocketsGlobal: 2_000,
    malformedClosesForCooldown: 3,
    malformedCloseWindowMs: 10 * 60 * 1000,
    malformedCooldownMs: 5 * 60 * 1000,
    ipv6AggregateFactor: 10,
    maxTrackedKeys: 100_000,
    sweepIntervalMs: 60_000,
    maxApiBodyBytes: 4 * 1024,
  }),
  rooms: Object.freeze({
    createsPerPrincipal: { capacity: 5, refillPerSecond: 5 / 3600 },
    createsPerIp: { capacity: 10, refillPerSecond: 10 / 3600 },
    createsGlobal: { capacity: 60, refillPerSecond: 60 / 3600 },
    maxHostedRooms: 3,
    maxSeatedGames: 10,
    joinFailuresPerPrincipal: { capacity: 10, refillPerSecond: 10 / 600 },
    joinFailuresPerIp: { capacity: 30, refillPerSecond: 30 / 600 },
    joinFailuresGlobal: { capacity: 1_000, refillPerSecond: 1_000 / 3600 },
    membershipOpsPerPrincipal: { capacity: 10, refillPerSecond: perMinute(20) },
    submitsPerSeat: { capacity: 20, refillPerSecond: 3 },
    submitsPerGame: { capacity: 30, refillPerSecond: 10 },
    chatPerSeat: { capacity: 5, refillPerSecond: 1 / 3 },
    codeRotationsPerGame: { capacity: 5, refillPerSecond: 5 / 3600 },
    listCoalesceMs: 1_000,
    unknownGameTtlMs: 60_000,
    maxUnknownGames: 100_000,
    unsubscribedReapMs: 60_000,
  }),
}) as IngressLimits;

/** The defaults with a test's (or an operator's) overrides; bucket specs merge per bucket. */
export function resolveLimits(
  over: Partial<Omit<IngressLimits, "buckets" | "identity" | "rooms">> & {
    buckets?: Partial<Record<BucketName, BucketSpec>>;
    identity?: Partial<IdentityLimits>;
    rooms?: Partial<RoomLimits>;
  } = {},
): IngressLimits {
  const { buckets, identity, rooms, ...rest } = over;
  return {
    ...DEFAULT_INGRESS_LIMITS,
    ...rest,
    buckets: { ...DEFAULT_INGRESS_LIMITS.buckets, ...(buckets ?? {}) },
    identity: { ...DEFAULT_INGRESS_LIMITS.identity, ...(identity ?? {}) },
    rooms: { ...DEFAULT_INGRESS_LIMITS.rooms, ...(rooms ?? {}) },
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
    const wait = this.peek();
    if (wait === 0) this.tokens -= 1;
    return wait;
  }

  /** P3-ACCT (review M3): give back a token taken for an attempt that turned out not to count (a RESERVATION: the
   *  token is taken before the slow check, so concurrent attempts cannot overshoot the budget, and returned after). */
  give(): void {
    this.refill();
    this.tokens = Math.min(this.spec.capacity, this.tokens + 1);
  }

  /** What `take` would answer, without taking. */
  peek(): number {
    this.refill();
    if (this.tokens >= 1) return 0;
    if (this.spec.refillPerSecond <= 0) return Number.MAX_SAFE_INTEGER;
    return Math.max(1, Math.ceil(((1 - this.tokens) / this.spec.refillPerSecond) * 1000));
  }

  /** Refilled to capacity: indistinguishable from a bucket never made, so a keyed limiter may forget it. */
  full(): boolean {
    this.refill();
    return this.tokens >= this.spec.capacity;
  }
}

/** LIVE-2B: token buckets by key (an IP key, a session id, "global"), bounded in memory. A full bucket is the same as
 *  no bucket, so `prune` forgets every full one; past `maxKeys` the oldest key is forgotten too (a flood of fresh
 *  keys is already bounded by the global buckets, which have one key). */
export class KeyedBuckets {
  private readonly buckets = new Map<string, TokenBucket>();

  constructor(
    private readonly spec: BucketSpec,
    private readonly now: () => number,
    private readonly maxKeys = 100_000,
  ) {}

  private bucket(key: string): TokenBucket {
    let bucket = this.buckets.get(key);
    if (bucket === undefined) {
      bucket = new TokenBucket(this.spec, this.now);
      this.buckets.set(key, bucket);
      while (this.buckets.size > this.maxKeys) this.buckets.delete(this.buckets.keys().next().value as string);
    }
    return bucket;
  }

  take(key: string): number {
    return this.bucket(key).take();
  }

  /** Return a reserved token (a forgotten -- full -- bucket has nothing to return). */
  give(key: string): void {
    this.buckets.get(key)?.give();
  }

  peek(key: string): number {
    const bucket = this.buckets.get(key);
    return bucket === undefined ? 0 : bucket.peek();
  }

  prune(): void {
    for (const [key, bucket] of this.buckets) if (bucket.full()) this.buckets.delete(key);
  }

  get size(): number {
    return this.buckets.size;
  }
}

/** LIVE-2B: an IP-keyed budget: the /64 (or /32) bucket, and for IPv6 its /48 aggregate at `factor` times the spec. */
export class IpBuckets {
  private readonly keyed: KeyedBuckets;
  private readonly aggregate: KeyedBuckets;

  constructor(spec: BucketSpec, now: () => number, factor: number, maxKeys: number) {
    this.keyed = new KeyedBuckets(spec, now, maxKeys);
    this.aggregate = new KeyedBuckets({ capacity: spec.capacity * factor, refillPerSecond: spec.refillPerSecond * factor }, now, maxKeys);
  }

  /** Both or neither: a refusal by either spends nothing. */
  take(ip: { key: string; aggregate: string | null }): number {
    const wait = this.peek(ip);
    if (wait > 0) return wait;
    this.keyed.take(ip.key);
    if (ip.aggregate !== null) this.aggregate.take(ip.aggregate);
    return 0;
  }

  peek(ip: { key: string; aggregate: string | null }): number {
    return Math.max(this.keyed.peek(ip.key), ip.aggregate === null ? 0 : this.aggregate.peek(ip.aggregate));
  }

  /** Return what a granted `take` reserved (both buckets). */
  give(ip: { key: string; aggregate: string | null }): void {
    this.keyed.give(ip.key);
    if (ip.aggregate !== null) this.aggregate.give(ip.aggregate);
  }

  prune(): void {
    this.keyed.prune();
    this.aggregate.prune();
  }

  get size(): number {
    return this.keyed.size + this.aggregate.size;
  }
}

/** LIVE-2B (LIVE-2 §11.4 item 2): malformed-flood closes by IP key; `threshold` inside `windowMs` refuses that key's
 *  upgrades for `cooldownMs`. Bounded: a key's history never exceeds the threshold, and expired keys are pruned. */
export class MalformedCooldowns {
  private readonly closes = new Map<string, number[]>();
  private readonly until = new Map<string, number>();

  constructor(
    private readonly threshold: number,
    private readonly windowMs: number,
    private readonly cooldownMs: number,
    private readonly now: () => number,
    private readonly maxKeys = 100_000,
  ) {}

  /** Record one close; true when it started a cooldown. */
  record(key: string): boolean {
    const now = this.now();
    const recent = (this.closes.get(key) ?? []).filter((at) => now - at < this.windowMs);
    recent.push(now);
    if (recent.length >= this.threshold) {
      this.closes.delete(key);
      this.until.set(key, now + this.cooldownMs);
      return true;
    }
    this.closes.set(key, recent);
    while (this.closes.size > this.maxKeys) this.closes.delete(this.closes.keys().next().value as string);
    return false;
  }

  /** Milliseconds of cooldown left for `key`, or 0. */
  remaining(key: string): number {
    const until = this.until.get(key);
    if (until === undefined) return 0;
    const left = until - this.now();
    if (left <= 0) {
      this.until.delete(key);
      return 0;
    }
    return left;
  }

  prune(): void {
    const now = this.now();
    for (const [key, at] of this.closes) if (at.every((time) => now - time >= this.windowMs)) this.closes.delete(key);
    for (const [key, until] of this.until) if (until <= now) this.until.delete(key);
  }

  get size(): number {
    return this.closes.size + this.until.size;
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
