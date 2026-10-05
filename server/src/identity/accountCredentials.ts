// server/src/identity/accountCredentials.ts
//
// ==================================================================
//  PHASE 3 (P3-ACCT): USERNAME + PASSWORD -- THE ORDINARY ACCOUNT CREDENTIAL
// ==================================================================
//
// The owner's account model (2026-10-05): a player signs in with a USERNAME and a PASSWORD. The username is a LOGIN
// identifier only -- never an authority key: every seat, grant and ticket still names the opaque principal, and the
// profile id stays private. A new account gets NO player-facing recovery key.
//
// WHAT THIS FILE OWNS (and nothing else):
//   - the username's canonical form (the uniqueness / lookup key) and the technical bounds of what can be one;
//   - the password's technical bounds and its one security floor;
//   - the password KDF: Node's own `crypto.scrypt` (no new dependency, no home-made cryptography), a random 16-byte salt
//     per account, the parameters stored WITH the hash (so they can be raised later without a migration), and a
//     constant-time comparison of the derived bytes;
//   - a bound on how many KDF computations run at once (each is deliberately expensive: a flood of logins must not
//     take the server's thread pool, so beyond the bound a request is answered "busy", never queued without limit);
//   - the SEALED recovery digest of an account that has no recovery key.
//
// POLICY THAT IS THE OWNER'S, NOT THIS FILE'S (reported as residual owner decisions; the values below are technical
// bounds and one published security floor, not product choices):
//   - the username's allowed characters / scripts, its minimum length, and any reserved names: today any printable
//     text without whitespace, control or format characters, 1-64 characters after NFKC normalisation;
//   - the password's minimum length: today 8 characters, the floor of NIST SP 800-63B §5.1.1.2 for a memorised secret
//     the user chooses (raising it is a one-line change; lowering it below 8 is not recommended); any composition or
//     breached-password rule (none today).
//
// NEVER LOGGED, NEVER STORED IN THE CLEAR: a password reaches this file once, in a POST body, and leaves it only as the
// scrypt hash. Nothing here prints, and no error message carries a username or a password.

import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual, type ScryptOptions } from "crypto";

/* ==================================================================
    USERNAMES
   ================================================================== */

/** Technical bound: a username is at most this many characters (code points) after normalisation. */
export const LOGIN_NAME_MAX = 64;

/* Whitespace, control (Cc), format (Cf), unassigned (Cn), private-use (Co), surrogate (Cs) and line/paragraph
   separators: none may appear in a username (each makes two names that look alike, or one that cannot be typed). */
const FORBIDDEN_IN_LOGIN = /[\s\p{Cc}\p{Cf}\p{Cn}\p{Co}\p{Cs}\p{Zl}\p{Zp}\p{Zs}]/u;

const codePoints = (text: string): number => [...text].length;

/** The bounds a name and its canonical key must both meet. */
function withinNameBounds(name: string): boolean {
  const length = codePoints(name);
  return length >= 1 && length <= LOGIN_NAME_MAX && !FORBIDDEN_IN_LOGIN.test(name);
}

/** A username as the player typed it, normalised (NFKC, outer whitespace trimmed) -- or `null` when it cannot be one.
 *  Its CANONICAL KEY must be within the same bounds (review L1: lower-casing can lengthen a name -- "İ" becomes two
 *  code points -- and a key the store would refuse is refused here, before any KDF work or budget). */
export function cleanLoginName(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > LOGIN_NAME_MAX * 4) return null;
  const name = raw.normalize("NFKC").trim();
  if (!withinNameBounds(name) || !withinNameBounds(loginKeyOf(name))) return null;
  return name;
}

/** The username's canonical form -- what is unique and what a login looks up: NFKC, lower-cased, NFKC again (so
 *  "Brad", "BRAD" and "brad" are one account, and no two spellings of one name can both be taken). */
export function loginKeyOf(name: string): string {
  return name.normalize("NFKC").toLowerCase().normalize("NFKC");
}

/** A stored username (`login_name`): exactly what `cleanLoginName` returns for itself. */
export const isLoginName = (value: unknown): value is string => typeof value === "string" && cleanLoginName(value) === value;

/** A stored login key: a username's canonical form, which is its own canonical form. */
export const isLoginKey = (value: unknown): value is string => isLoginName(value) && loginKeyOf(value) === value;

/* ==================================================================
    PASSWORDS
   ================================================================== */

/** The one security floor (NIST SP 800-63B §5.1.1.2). Owner-adjustable; see the header. */
export const PASSWORD_MIN_LENGTH = 8;
/** Technical bound on the KDF's input (a denial-of-service bound, not a policy): 1 KiB of UTF-8. */
export const PASSWORD_MAX_BYTES = 1024;

export type PasswordProblem = "too-short" | "too-long" | "invalid";

/** A password as typed, normalised (NFKC; NIST recommends a normalisation so one secret has one byte form) -- or why
 *  it cannot be one. Whitespace is part of a password and is never trimmed. */
export function cleanPassword(raw: unknown): { ok: true; password: string } | { ok: false; problem: PasswordProblem } {
  if (typeof raw !== "string") return { ok: false, problem: "too-short" };
  if (raw.length > PASSWORD_MAX_BYTES) return { ok: false, problem: "too-long" };
  /* Review N4: a lone surrogate has no UTF-8 form (it would collapse to U+FFFD in the KDF's input, so two different
     passwords would be one): refused, never silently rewritten. */
  if (/\p{Cs}/u.test(raw)) return { ok: false, problem: "invalid" };
  const password = raw.normalize("NFKC");
  if (Buffer.byteLength(password, "utf8") > PASSWORD_MAX_BYTES) return { ok: false, problem: "too-long" };
  if (codePoints(password) < PASSWORD_MIN_LENGTH) return { ok: false, problem: "too-short" };
  return { ok: true, password };
}

/* ==================================================================
    THE KDF (scrypt)
   ================================================================== */

export interface PasswordKdfParams {
  /** log2 of scrypt's N (CPU/memory cost). */
  readonly logN: number;
  /** Block size. */
  readonly r: number;
  /** Parallelisation. */
  readonly p: number;
}

/** OWASP's scrypt row "N=2^15, r=8, p=3" (equivalent work to N=2^17, r=8, p=1, with a quarter of the memory per
 *  computation: 32 MiB -- what a small host can afford several of at once). */
export const DEFAULT_PASSWORD_KDF: PasswordKdfParams = Object.freeze({ logN: 15, r: 8, p: 3 });
/** What a stored hash may carry (anything else is not a hash this build reads). The floor is for tests' fast params. */
const KDF_LIMITS = Object.freeze({ logN: [10, 20] as const, r: [1, 32] as const, p: [1, 16] as const });
const SALT_BYTES = 16;
const KEY_BYTES = 32;
const HASH_TAG = "scrypt";
const HASH_VERSION = "1";
/** `scrypt$1$<logN>$<r>$<p>$<salt: 22 base64url>$<key: 43 base64url>` */
const HASH_PATTERN = /^scrypt\$1\$(\d{1,2})\$(\d{1,2})\$(\d{1,2})\$([A-Za-z0-9_-]{21}[AQgw])\$([A-Za-z0-9_-]{42}[AEIMQUYcgkosw048])$/;

const within = (value: number, [low, high]: readonly [number, number]) => Number.isSafeInteger(value) && value >= low && value <= high;
/** scrypt's memory bound (`scryptOptions`): parameters needing more are not a hash this build can verify. */
const KDF_MAXMEM = 256 * 1024 * 1024;
const fitsMemory = (params: PasswordKdfParams) => 128 * 2 ** params.logN * params.r <= KDF_MAXMEM;

function parseHash(stored: string): { params: PasswordKdfParams; salt: Buffer; key: Buffer } | null {
  const match = HASH_PATTERN.exec(stored);
  if (match === null) return null;
  const params = { logN: Number(match[1]), r: Number(match[2]), p: Number(match[3]) };
  if (!within(params.logN, KDF_LIMITS.logN) || !within(params.r, KDF_LIMITS.r) || !within(params.p, KDF_LIMITS.p) || !fitsMemory(params)) return null;
  if (String(params.logN) !== match[1] || String(params.r) !== match[2] || String(params.p) !== match[3]) return null; // canonical numbers only
  const salt = Buffer.from(match[4], "base64url");
  const key = Buffer.from(match[5], "base64url");
  if (salt.length !== SALT_BYTES || key.length !== KEY_BYTES || salt.toString("base64url") !== match[4] || key.toString("base64url") !== match[5]) return null;
  return { params, salt, key };
}

/** A stored password hash this build can verify. */
export const isPasswordHash = (value: unknown): value is string => typeof value === "string" && parseHash(value) !== null;

const scryptOptions = (params: PasswordKdfParams): ScryptOptions => ({
  N: 2 ** params.logN,
  r: params.r,
  p: params.p,
  /* scrypt needs 128 * N * r bytes; the default cap (32 MiB) is exactly the default parameters' need, so leave room. */
  maxmem: KDF_MAXMEM,
});

function derive(password: string, salt: Buffer, params: PasswordKdfParams): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password.normalize("NFKC"), salt, KEY_BYTES, scryptOptions(params), (error, key) => (error ? reject(error) : resolve(key)));
  });
}

/** Hash a password (already through `cleanPassword`) with a fresh random salt. */
export async function hashPassword(password: string, params: PasswordKdfParams = DEFAULT_PASSWORD_KDF, random: (size: number) => Buffer = randomBytes): Promise<string> {
  if (!within(params.logN, KDF_LIMITS.logN) || !within(params.r, KDF_LIMITS.r) || !within(params.p, KDF_LIMITS.p) || !fitsMemory(params)) throw new Error("password KDF: parameters out of range");
  const salt = random(SALT_BYTES);
  const key = await derive(password, salt, params);
  return `${HASH_TAG}$${HASH_VERSION}$${params.logN}$${params.r}$${params.p}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

/* An unknown username is verified against this hash -- the same work as a real one, so neither the answer nor its time
   says whether the name exists. Made once per process and per parameter set (its password is random and discarded). */
const dummies = new Map<string, Promise<string>>();
function dummyHash(params: PasswordKdfParams): Promise<string> {
  const key = `${params.logN}/${params.r}/${params.p}`;
  let made = dummies.get(key);
  if (made === undefined) {
    const making = hashPassword(randomBytes(24).toString("base64url"), params);
    dummies.set(key, making);
    /* Review N1: a failure is never cached (it would answer every unknown username differently from a known one). */
    making.catch(() => {
      if (dummies.get(key) === making) dummies.delete(key);
    });
    made = making;
  }
  return made;
}

/** Review N1: make the dummy hash at start-up, so the first unknown-username login after a restart does the same KDF
 *  work as any other (one computation, not two). Never rejects. */
export function warmPasswordKdf(params: PasswordKdfParams = DEFAULT_PASSWORD_KDF): Promise<void> {
  return dummyHash(params).then(
    () => undefined,
    () => undefined,
  );
}

/** Whether `password` is the one `stored` was made from. `stored === null` (no such account, or no password) does the
 *  same work against a dummy and answers false. Constant time in the comparison; never throws for a wrong password. */
export async function verifyPassword(password: string, stored: string | null, params: PasswordKdfParams = DEFAULT_PASSWORD_KDF): Promise<boolean> {
  const parsed = stored === null ? null : parseHash(stored);
  const target = parsed ?? parseHash(await dummyHash(params));
  if (target === null) return false;
  const derived = await derive(password, target.salt, target.params);
  const same = timingSafeEqual(derived, target.key);
  return same && parsed !== null;
}

/* ==================================================================
    THE KDF'S CONCURRENCY BOUND
   ================================================================== */

/** At most `limit` KDF computations at once; beyond it, `run` answers `busy` at once (the caller says "try again").
 *
 *  Review M1 (starvation): one client -- an address key -- may have at most `perClient` computations in flight (two:
 *  neighbours behind one NAT rarely sign in within the same quarter-second), so a single address cannot fill the gate;
 *  and the last slot is RESERVED for an already-signed-in session confirming it's you (`authenticated`), so an
 *  anonymous flood of logins and creates can never lock a player out of their own sensitive actions. (The gate stays well below libuv's thread pool, which the entry points widen: `threadPool.ts`.) */
export class KdfGate {
  private running = 0;
  private readonly byClient = new Map<string, number>();
  busyRefusals = 0;

  constructor(
    readonly limit: number = 4,
    readonly perClient: number = 2,
  ) {}

  async run<T>(task: () => Promise<T>, options: { client?: string; authenticated?: boolean } = {}): Promise<{ kind: "ok"; value: T } | { kind: "busy" }> {
    const ceiling = options.authenticated === true || this.limit <= 1 ? this.limit : this.limit - 1;
    const client = options.client;
    if (this.running >= ceiling || (client !== undefined && (this.byClient.get(client) ?? 0) >= this.perClient)) {
      this.busyRefusals += 1;
      return { kind: "busy" };
    }
    this.running += 1;
    if (client !== undefined) this.byClient.set(client, (this.byClient.get(client) ?? 0) + 1);
    try {
      return { kind: "ok", value: await task() };
    } finally {
      this.running -= 1;
      if (client !== undefined) {
        const left = (this.byClient.get(client) ?? 1) - 1;
        if (left <= 0) this.byClient.delete(client);
        else this.byClient.set(client, left);
      }
    }
  }

  get inFlight(): number {
    return this.running;
  }
}

/* ==================================================================
    AN ACCOUNT WITH NO RECOVERY KEY
   ==================================================================
   The profile record keeps `recovery_selector` / `recovery_hash` (ESCROW-3A binds every sensitive grant and every wallet
   ticket to the selector: it is the profile's CREDENTIAL EPOCH, and changing that would move a protocol line). A new
   username/password account gets a fresh random selector -- never shown anywhere -- and a SEALED digest: SHA-256 of a
   domain-tagged text far longer than a key's 32-byte secret, so no recovery key can ever match it (a second preimage),
   and anyone can tell from the record alone that the profile has no recovery key. */
const SEALED_TAG = "18COSMOS/ACCOUNT/NO-RECOVERY-KEY/v1\n";

export function sealedRecoveryDigest(selector: string): string {
  return createHash("sha256").update(SEALED_TAG).update(`${selector}\n`).digest("hex");
}

/** Whether a profile's recovery digest is a real recovery key's (a legacy profile) rather than the sealed one. */
export const hasRecoveryKey = (profile: { readonly recovery_selector: string; readonly recovery_hash: string }): boolean => profile.recovery_hash !== sealedRecoveryDigest(profile.recovery_selector);
