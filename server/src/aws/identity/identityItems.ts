// server/src/aws/identity/identityItems.ts
//
// ==================================================================
//  LIVE-5 L5-4: THE IDENTITY TABLE'S ITEMS -- KEYS, AND AN EXACT, STRICT CODEC
// ==================================================================
//
// One table (`gs-<env>-identity`, preflight §3.3), string `pk` / `sk`, no index. Every record the identity port knows is
// one item addressed by its own id, so every precondition names exactly one item and every read the identity writer or a
// verifier needs is a strong GetItem by key:
//
//   PRIN#<pr>              / META     a principal
//   PROF#<pf>              / META     a profile
//   SESS#<se>              / META     a session (its secret only as SHA-256)
//   FAM#<sf>               / META     a session family
//   LINK#<sha256>          / LINK     a "Link another device" code (only as SHA-256)
//   SEL#<rk>               / SEL      the UNIQUENESS item of a recovery selector: which profile holds it, or, once a
//                                     rotation retired it, `retired_at`. Never deleted. The one derived item the
//                                     adapter keeps -- `selector-unused` names a selector, not a profile, and only an
//                                     item keyed by the selector can make that term an atomic condition.
//   GRANT#<se>             / GRANT    a sensitive-auth grant (identity/grants.ts), TTL `expires_at` + 1 h
//   ROLE#identity-writer   / ROLE     the identity-writer role: `epoch` is ROLE_ID, checked inside every identity write;
//                                     `claim` is the token of the takeover that set it (`takeOverIdentityWriter`)
//   TXN#<token>            / TXN      the commit marker of one transaction (the attempt's ClientRequestToken), TTL 1 day:
//                                     written by the transaction it names, so a strong read of it settles an unknown
//                                     outcome exactly (preflight §4: "never taken at face value")
//   RESTORE#identity       / RESTORE  (LIVE-6 L6-4) the identity RESTORE marker: this table is a restored copy whose
//                                     security-journal replay is `replaying` (the table serves NOTHING: no load, no
//                                     serving takeover) or `complete` (it may serve). Absent: never restored.
//   REVIEW#<pf>            / REVIEW#<restore>   (LIVE-6 L6-4) a profile sent to OPERATOR REVIEW by a restore (an
//                                     unconfirmed recovery-key rotation, owner decision 2026-09-29): which restore, which
//                                     events (by id only -- never a selector or a hash), and what the replay did to the key.
//                                     One per restore: a later restore never overwrites an earlier one's.
//   TABLE#identity         / TABLE    (LIVE-6 L6-4) the table's OWN NAME: set by its first serving takeover (inside that
//                                     transaction), rewritten only by a restore's completion. A point-in-time copy carries
//                                     its source's name, so it serves nothing until its own replay completes.
//
// THE VALUES ARE THE RECORD'S OWN FIELDS, ONE ATTRIBUTE EACH, TYPED: a string is S, a time or count is N (a canonical
// decimal integer), a `null` is NULL -- every frozen field is present on every item, so what a condition tests is
// exactly what a load returns (no second copy of a field to drift from the first). `fmt` is this layout's own version
// (1): an item of another layout is refused, never reinterpreted.
//
// DECODING IS STRICT: the exact attribute set, the exact types, canonical numbers, the record's own shape check
// (`isPrincipal`, `isSession`...), and the key naming the record's own id. Anything else is damage -- the load refuses
// (`IdentityStoreCorruptError`), naming the item class and never its content.
//
// Deliberately NOT here (preflight §3.3 lists them): the `PRIN#/SESS#`, `PRIN#/FAM#`, `FAM#/SESS#` and `PRIN#/PROFILE`
// index items. Nothing reads them while the identity writer loads the whole table (§7.1, the MVA); a derived copy with
// no reader is write amplification, a share of every transaction's 100 actions, and one more thing that can disagree
// with the records. The read-through follow-up (beyond ~10^5 principals) adds them with their reader.

import type { AttributeValue } from "@aws-sdk/client-dynamodb";

import { isSensitiveAuthGrant, type SensitiveAuthGrant } from "../../identity/grants";
import { FAMILY_ID_PATTERN, PRINCIPAL_ID_PATTERN, PROFILE_ID_PATTERN, RECOVERY_SELECTOR_PATTERN, SESSION_ID_PATTERN } from "../../identity/ids";
import { isLinkCredential, isPrincipal, isProfile, isSession, isSessionFamily, type LinkCredential, type Principal, type Profile, type Session, type SessionFamily } from "../../identity/store";

export type Item = Record<string, AttributeValue>;
export interface ItemKey {
  readonly pk: string;
  readonly sk: string;
}

/** This layout's version, on every item the adapter writes (`fmt`). */
export const IDENTITY_ITEM_FORMAT = 1;
/** A grant item lives this long past its own `expires_at` before the table's TTL may collect it. */
export const GRANT_TTL_GRACE_SECONDS = 3_600;
/** A commit marker lives this long (its only reader is the settlement of an unknown outcome, seconds later). */
export const MARKER_TTL_SECONDS = 86_400;

export const ROLE_PK = "ROLE#identity-writer";
export const ROLE_KEY: ItemKey = Object.freeze({ pk: ROLE_PK, sk: "ROLE" });

export const keys = Object.freeze({
  principal: (id: string): ItemKey => ({ pk: `PRIN#${id}`, sk: "META" }),
  profile: (id: string): ItemKey => ({ pk: `PROF#${id}`, sk: "META" }),
  session: (id: string): ItemKey => ({ pk: `SESS#${id}`, sk: "META" }),
  family: (id: string): ItemKey => ({ pk: `FAM#${id}`, sk: "META" }),
  link: (hash: string): ItemKey => ({ pk: `LINK#${hash}`, sk: "LINK" }),
  selector: (selector: string): ItemKey => ({ pk: `SEL#${selector}`, sk: "SEL" }),
  grant: (sessionId: string): ItemKey => ({ pk: `GRANT#${sessionId}`, sk: "GRANT" }),
  /** One review record per (profile, restore): a later restore never overwrites an earlier one's. */
  review: (profileId: string, restoreId: string): ItemKey => ({ pk: `REVIEW#${profileId}`, sk: `REVIEW#${restoreId}` }),
  /** The identity table's own name (review round 2): set by the first serving takeover, rewritten only by a restore's
   *  completion -- a point-in-time copy carries its source's name and so serves nothing until its own replay. */
  self: (): ItemKey => ({ pk: "TABLE#identity", sk: "TABLE" }),
  marker: (token: string): ItemKey => ({ pk: `TXN#${token}`, sk: "TXN" }),
});

export const keyAttributes = (key: ItemKey): Item => ({ pk: { S: key.pk }, sk: { S: key.sk } });
export const keyText = (key: ItemKey): string => `${key.pk}|${key.sk}`;

/* ------------------------------------------------------------------ */
/* Field specifications, in each record's canonical key order           */
/* ------------------------------------------------------------------ */

type FieldType = "S" | "N" | "S?" | "N?";
type FieldSpec = ReadonlyArray<readonly [string, FieldType]>;

export const PRINCIPAL_FIELDS: FieldSpec = [
  ["principal_id", "S"],
  ["kind", "S"],
  ["status", "S"],
  ["created_at", "N"],
  ["activated_at", "N?"],
  ["last_seen_at", "N"],
  ["account_link", "S?"],
];
export const PROFILE_FIELDS: FieldSpec = [
  ["profile_id", "S"],
  ["principal_id", "S"],
  ["display_name", "S"],
  ["created_at", "N"],
  ["status", "S"],
  ["recovery_selector", "S"],
  ["recovery_hash", "S"],
  ["recovery_rotated_at", "N"],
  ["schema", "N"],
];
export const SESSION_FIELDS: FieldSpec = [
  ["session_id", "S"],
  ["principal_id", "S"],
  ["secret_hash", "S"],
  ["created_at", "N"],
  ["last_seen_at", "N"],
  ["expires_at", "N"],
  ["revoked_at", "N?"],
  ["revoke_reason", "S?"],
  ["rotated_to", "S?"],
  ["family_id", "S"],
];
export const FAMILY_FIELDS: FieldSpec = [
  ["family_id", "S"],
  ["principal_id", "S"],
  ["created_at", "N"],
  ["origin", "S"],
  ["revoked_at", "N?"],
  ["revoke_reason", "S?"],
];
export const LINK_FIELDS: FieldSpec = [
  ["link_hash", "S"],
  ["profile_id", "S"],
  ["created_at", "N"],
  ["expires_at", "N"],
  ["consumed_at", "N?"],
];
export const SELECTOR_FIELDS: FieldSpec = [
  ["recovery_selector", "S"],
  ["profile_id", "S"],
  ["retired_at", "N?"],
];
export const RESTORE_FIELDS: FieldSpec = [
  ["restore_id", "S"],
  ["state", "S"],
  ["identity_table", "S"],
  ["peer_table", "S"],
  ["restore_point", "N"],
  ["started_at", "N"],
  ["journal_digest", "S"],
  ["journal_events", "N"],
  ["completed_at", "N?"],
  ["reviews", "N?"],
];
export const REVIEW_FIELDS: FieldSpec = [
  ["profile_id", "S"],
  ["principal_id", "S"],
  ["restore_id", "S"],
  ["reason", "S"],
  ["opened_at", "N"],
  ["unconfirmed_events", "S"],
  ["confirmed_events", "S"],
  ["selector_state", "S"],
  ["prior_status", "S"],
  ["resolved_at", "N?"],
];
export const GRANT_FIELDS: FieldSpec = [
  ["session_id", "S"],
  ["family_id", "S"],
  ["selector", "S"],
  ["expires_at", "N"],
];

/** The uniqueness item of a recovery selector. */
export interface SelectorRecord {
  readonly recovery_selector: string;
  readonly profile_id: string;
  /** `null` while the profile holds it; the rotation's time once it was retired (a tombstone: it never resolves again). */
  readonly retired_at: number | null;
}

/** LIVE-6 L6-4: the identity restore marker. It serves only while `complete` AND naming this very table: `replaying` (the
 *  replay has not finished), `superseded` (the SOURCE of a restore: it never serves again) and a `complete` marker carried
 *  into a copy (it names another table) all serve nothing. */
export interface RestoreRecord {
  readonly restore_id: string;
  readonly state: "replaying" | "complete" | "superseded";
  /** The table this marker was written INTO (a point-in-time copy carries it over, naming its source: never served). */
  readonly identity_table: string;
  /** replaying / complete: the source the table was restored from; superseded: the restored table that replaces it. */
  readonly peer_table: string;
  /** The point in time the table was restored to (epoch ms; recorded -- the replay applies the WHOLE journal). */
  readonly restore_point: number;
  /** The replay's own fixed time: every time the replay writes is this one, so a resumed replay writes the same values. */
  readonly started_at: number;
  /** SHA-256 of the journal the last plan was computed from (the whole SEC# journal, canonical), and its event count. */
  readonly journal_digest: string;
  readonly journal_events: number;
  readonly completed_at: number | null;
  readonly reviews: number | null;
}

/** LIVE-6 L6-4: a profile under operator review after a restore. Ids of events only: never a selector or a hash. */
export interface ReviewRecord {
  readonly profile_id: string;
  readonly principal_id: string;
  readonly restore_id: string;
  readonly reason: "unconfirmed-recovery-key-rotation";
  readonly opened_at: number;
  /** Canonical JSON arrays of 32-hex event ids, ascending. */
  readonly unconfirmed_events: string;
  readonly confirmed_events: string;
  /** What the replay left as the profile's key: the confirmed chain's head kept (not implicated), or a quarantine key
   *  nobody holds (the head was implicated). Either way the profile is `disabled` until an operator resolves it. */
  readonly selector_state: "confirmed-head-retained" | "quarantined";
  /** The profile's status before THIS restore sent it to review: what a withdrawal of this review restores. */
  readonly prior_status: "active" | "disabled";
  /** Set by the operator's resolution (L6-3); `null` while open. */
  readonly resolved_at: number | null;
}

export const RESTORE_PK = "RESTORE#identity";
export const RESTORE_KEY: ItemKey = Object.freeze({ pk: RESTORE_PK, sk: "RESTORE" });
export const RESTORE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{2,63}$/;
const TABLE_NAME_PATTERN = /^[A-Za-z0-9_.-]{3,255}$/;
const HEX_64 = /^[0-9a-f]{64}$/;
const EVENT_IDS = /^\[("[0-9a-f]{32}"(,"[0-9a-f]{32}")*)?\]$/;
const isEventIdList = (value: unknown): value is string => {
  if (typeof value !== "string" || !EVENT_IDS.test(value)) return false;
  const ids = JSON.parse(value) as string[];
  return ids.every((id, at) => at === 0 || ids[at - 1] < id);
};
export const eventIdList = (ids: Iterable<string>): string => JSON.stringify([...new Set(ids)].sort());

export interface RoleRecord {
  readonly epoch: number;
  readonly task: string;
  readonly pool: string;
  readonly taken_at: number;
  /** The token of the takeover that set this epoch (how an unknown takeover outcome is settled). */
  readonly claim: string;
}

/* ------------------------------------------------------------------ */
/* Values                                                              */
/* ------------------------------------------------------------------ */

const CANONICAL_INTEGER = /^(0|[1-9][0-9]*)$/;

export const S = (value: string): AttributeValue => ({ S: value });
export const N = (value: number): AttributeValue => {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("identity items: a number attribute must be a non-negative safe integer");
  return { N: String(value) };
};
export const NULL: AttributeValue = Object.freeze({ NULL: true }) as AttributeValue;

function encodeValue(value: unknown, type: FieldType): AttributeValue {
  if (value === null && (type === "S?" || type === "N?")) return { NULL: true };
  if (type === "S" || type === "S?") {
    if (typeof value !== "string") throw new Error("identity items: a string field is not a string");
    return { S: value };
  }
  if (typeof value !== "number") throw new Error("identity items: a number field is not a number");
  return N(value);
}

/** The one type an attribute value carries, or null when it is not exactly one of S / N / NULL. */
function typeOf(value: AttributeValue | undefined): "S" | "N" | "NULL" | null {
  if (value === undefined || typeof value !== "object" || value === null) return null;
  const present = Object.entries(value).filter(([, inner]) => inner !== undefined);
  if (present.length !== 1) return null;
  const [name, inner] = present[0];
  if (name === "S" && typeof inner === "string") return "S";
  if (name === "N" && typeof inner === "string") return "N";
  if (name === "NULL" && inner === true) return "NULL";
  return null;
}

function decodeValue(value: AttributeValue | undefined, type: FieldType): { ok: true; value: unknown } | { ok: false } {
  const actual = typeOf(value);
  if (actual === "NULL") return type === "S?" || type === "N?" ? { ok: true, value: null } : { ok: false };
  if (actual === "S") return type === "S" || type === "S?" ? { ok: true, value: (value as { S: string }).S } : { ok: false };
  if (actual === "N") {
    if (type !== "N" && type !== "N?") return { ok: false };
    const text = (value as { N: string }).N;
    if (!CANONICAL_INTEGER.test(text)) return { ok: false };
    const number = Number(text);
    return Number.isSafeInteger(number) ? { ok: true, value: number } : { ok: false };
  }
  return { ok: false };
}

/** An item holding `record`'s fields exactly (plus the key, the layout version and any extra attributes given). */
export function encodeRecord(key: ItemKey, fields: FieldSpec, record: object, extra: Item = {}): Item {
  const out: Item = { ...keyAttributes(key), fmt: N(IDENTITY_ITEM_FORMAT) };
  for (const [name, type] of fields) out[name] = encodeValue((record as Record<string, unknown>)[name], type);
  for (const [name, value] of Object.entries(extra)) out[name] = value;
  return out;
}

/** The record an item holds, when it holds exactly the fields (and `extra` numeric attributes) and nothing else. */
function decodeRecord(item: Item, fields: FieldSpec, extra: readonly string[] = []): Record<string, unknown> | null {
  const expected = new Set(["pk", "sk", "fmt", ...fields.map(([name]) => name), ...extra]);
  const present = Object.keys(item).filter((name) => item[name] !== undefined);
  if (present.length !== expected.size || !present.every((name) => expected.has(name))) return null;
  const format = decodeValue(item.fmt, "N");
  if (!format.ok || format.value !== IDENTITY_ITEM_FORMAT) return null;
  const out: Record<string, unknown> = {};
  for (const [name, type] of fields) {
    const decoded = decodeValue(item[name], type);
    if (!decoded.ok) return null;
    out[name] = decoded.value;
  }
  for (const name of extra) {
    const decoded = decodeValue(item[name], "N");
    if (!decoded.ok) return null;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* The items the adapter writes                                        */
/* ------------------------------------------------------------------ */

export const principalItem = (record: Principal): Item => encodeRecord(keys.principal(record.principal_id), PRINCIPAL_FIELDS, record);
export const profileItem = (record: Profile): Item => encodeRecord(keys.profile(record.profile_id), PROFILE_FIELDS, record);
export const sessionItem = (record: Session): Item => encodeRecord(keys.session(record.session_id), SESSION_FIELDS, record);
export const familyItem = (record: SessionFamily): Item => encodeRecord(keys.family(record.family_id), FAMILY_FIELDS, record);
export const linkItem = (record: LinkCredential): Item => encodeRecord(keys.link(record.link_hash), LINK_FIELDS, record);
export const selectorItem = (record: SelectorRecord): Item => encodeRecord(keys.selector(record.recovery_selector), SELECTOR_FIELDS, record);
export const grantTtl = (expiresAt: number): number => Math.floor(expiresAt / 1000) + GRANT_TTL_GRACE_SECONDS;
export const grantItem = (record: SensitiveAuthGrant): Item => encodeRecord(keys.grant(record.session_id), GRANT_FIELDS, record, { ttl: N(grantTtl(record.expires_at)) });
export const restoreItem = (record: RestoreRecord): Item => encodeRecord(RESTORE_KEY, RESTORE_FIELDS, record);
export const reviewItem = (record: ReviewRecord): Item => encodeRecord(keys.review(record.profile_id, record.restore_id), REVIEW_FIELDS, record);
export const SELF_FIELDS: FieldSpec = [["identity_table", "S"]];
export const selfItem = (table: string): Item => encodeRecord(keys.self(), SELF_FIELDS, { identity_table: table });
export const markerTtl = (at: number): number => Math.floor(at / 1000) + MARKER_TTL_SECONDS;
export const markerItem = (token: string, at: number): Item => ({ ...keyAttributes(keys.marker(token)), fmt: N(IDENTITY_ITEM_FORMAT), at: N(at), ttl: N(markerTtl(at)) });

/* ------------------------------------------------------------------ */
/* Decoding any item of the table                                      */
/* ------------------------------------------------------------------ */

export type DecodedItem =
  | { readonly kind: "principal"; readonly record: Principal }
  | { readonly kind: "profile"; readonly record: Profile }
  | { readonly kind: "session"; readonly record: Session }
  | { readonly kind: "family"; readonly record: SessionFamily }
  | { readonly kind: "link"; readonly record: LinkCredential }
  | { readonly kind: "selector"; readonly record: SelectorRecord }
  | { readonly kind: "grant"; readonly record: SensitiveAuthGrant }
  | { readonly kind: "role"; readonly record: RoleRecord }
  | { readonly kind: "marker"; readonly record: { readonly token: string; readonly at: number } }
  | { readonly kind: "restore"; readonly record: RestoreRecord }
  | { readonly kind: "review"; readonly record: ReviewRecord }
  | { readonly kind: "self"; readonly record: { readonly identity_table: string } };

export type ItemClass = DecodedItem["kind"];

/** What an item is by its key alone (`null`: no item class of this layout has this key). */
export function classOfKey(pk: string, sk: string): ItemClass | null {
  if (pk === ROLE_PK) return sk === "ROLE" ? "role" : null;
  const hash = pk.indexOf("#");
  if (hash < 0) return null;
  const prefix = pk.slice(0, hash);
  const expected: Record<string, [ItemClass, string]> = {
    PRIN: ["principal", "META"],
    PROF: ["profile", "META"],
    SESS: ["session", "META"],
    FAM: ["family", "META"],
    LINK: ["link", "LINK"],
    SEL: ["selector", "SEL"],
    GRANT: ["grant", "GRANT"],
    TXN: ["marker", "TXN"],
    RESTORE: ["restore", "RESTORE"],
    REVIEW: ["review", "REVIEW#"],
    TABLE: ["self", "TABLE"],
  };
  const match = expected[prefix];
  if (match === undefined) return null;
  if (match[0] === "review") return sk.startsWith("REVIEW#") ? "review" : null;
  return match[1] === sk ? match[0] : null;
}

const TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ROLE_TEXT = /^[\x21-\x7e]{1,128}$/;
/** What the role item's `task` and `pool` may be: 1-128 printable ASCII characters, no space (the codec refuses others). */
export const isRoleText = (value: unknown): value is string => typeof value === "string" && ROLE_TEXT.test(value);

/** Decode one item strictly. `{ problem }` names the item class only -- never an id or a value. */
export function decodeItem(item: Item): DecodedItem | { readonly problem: string } {
  const pk = typeOf(item.pk) === "S" ? (item.pk as { S: string }).S : null;
  const sk = typeOf(item.sk) === "S" ? (item.sk as { S: string }).S : null;
  if (pk === null || sk === null) return { problem: "an item without string keys" };
  const kind = classOfKey(pk, sk);
  if (kind === null) return { problem: "an item of no class this build knows (another layout's, or damage)" };
  const suffix = pk.slice(pk.indexOf("#") + 1);
  const bad = { problem: `a ${kind} item is not a well-formed ${kind} record` };
  switch (kind) {
    case "principal": {
      const record = decodeRecord(item, PRINCIPAL_FIELDS);
      return record !== null && isPrincipal(record) && record.principal_id === suffix ? { kind, record } : bad;
    }
    case "profile": {
      const record = decodeRecord(item, PROFILE_FIELDS);
      return record !== null && isProfile(record) && record.profile_id === suffix ? { kind, record } : bad;
    }
    case "session": {
      const record = decodeRecord(item, SESSION_FIELDS);
      return record !== null && isSession(record) && record.session_id === suffix ? { kind, record } : bad;
    }
    case "family": {
      const record = decodeRecord(item, FAMILY_FIELDS);
      return record !== null && isSessionFamily(record) && record.family_id === suffix ? { kind, record } : bad;
    }
    case "link": {
      const record = decodeRecord(item, LINK_FIELDS);
      return record !== null && isLinkCredential(record) && record.link_hash === suffix ? { kind, record } : bad;
    }
    case "selector": {
      const record = decodeRecord(item, SELECTOR_FIELDS);
      const ok =
        record !== null &&
        typeof record.recovery_selector === "string" &&
        RECOVERY_SELECTOR_PATTERN.test(record.recovery_selector) &&
        record.recovery_selector === suffix &&
        typeof record.profile_id === "string" &&
        PROFILE_ID_PATTERN.test(record.profile_id) &&
        (record.retired_at === null || (typeof record.retired_at === "number" && Number.isSafeInteger(record.retired_at)));
      return ok ? { kind, record: record as unknown as SelectorRecord } : bad;
    }
    case "grant": {
      const record = decodeRecord(item, GRANT_FIELDS, ["ttl"]);
      const ok = record !== null && isSensitiveAuthGrant(record) && record.session_id === suffix && decodeValue(item.ttl, "N").ok && Number((item.ttl as { N: string }).N) === grantTtl(record.expires_at);
      return ok ? { kind, record: record as unknown as SensitiveAuthGrant } : bad;
    }
    case "role": {
      const names = Object.keys(item).filter((name) => item[name] !== undefined).sort();
      if (names.join(",") !== "claim,epoch,pk,pool,sk,taken_at,task") return bad;
      const epoch = decodeValue(item.epoch, "N");
      const takenAt = decodeValue(item.taken_at, "N");
      const task = decodeValue(item.task, "S");
      const pool = decodeValue(item.pool, "S");
      const claim = decodeValue(item.claim, "S");
      const ok =
        epoch.ok &&
        takenAt.ok &&
        task.ok &&
        pool.ok &&
        claim.ok &&
        (epoch.value as number) >= 1 &&
        ROLE_TEXT.test(task.value as string) &&
        ROLE_TEXT.test(pool.value as string) &&
        TOKEN_PATTERN.test(claim.value as string);
      return ok ? { kind, record: { epoch: epoch.value as number, task: task.value as string, pool: pool.value as string, taken_at: takenAt.value as number, claim: claim.value as string } } : bad;
    }
    case "restore": {
      const record = decodeRecord(item, RESTORE_FIELDS);
      const ok =
        record !== null &&
        suffix === "identity" &&
        typeof record.restore_id === "string" &&
        RESTORE_ID_PATTERN.test(record.restore_id) &&
        (record.state === "replaying" || record.state === "complete" || record.state === "superseded") &&
        typeof record.identity_table === "string" &&
        TABLE_NAME_PATTERN.test(record.identity_table) &&
        typeof record.peer_table === "string" &&
        TABLE_NAME_PATTERN.test(record.peer_table) &&
        record.peer_table !== record.identity_table &&
        typeof record.journal_digest === "string" &&
        HEX_64.test(record.journal_digest) &&
        (record.state === "complete") === (record.completed_at !== null) &&
        (record.state === "complete") === (record.reviews !== null);
      return ok ? { kind, record: record as unknown as RestoreRecord } : bad;
    }
    case "review": {
      const record = decodeRecord(item, REVIEW_FIELDS);
      const ok =
        record !== null &&
        typeof record.profile_id === "string" &&
        PROFILE_ID_PATTERN.test(record.profile_id) &&
        record.profile_id === suffix &&
        item.sk?.S === `REVIEW#${String(record.restore_id)}` &&
        typeof record.principal_id === "string" &&
        PRINCIPAL_ID_PATTERN.test(record.principal_id) &&
        typeof record.restore_id === "string" &&
        RESTORE_ID_PATTERN.test(record.restore_id) &&
        record.reason === "unconfirmed-recovery-key-rotation" &&
        isEventIdList(record.unconfirmed_events) &&
        (record.unconfirmed_events as string) !== "[]" &&
        isEventIdList(record.confirmed_events) &&
        (record.selector_state === "confirmed-head-retained" || record.selector_state === "quarantined") &&
        (record.prior_status === "active" || record.prior_status === "disabled");
      return ok ? { kind, record: record as unknown as ReviewRecord } : bad;
    }
    case "self": {
      const record = decodeRecord(item, SELF_FIELDS);
      const ok = record !== null && suffix === "identity" && typeof record.identity_table === "string" && TABLE_NAME_PATTERN.test(record.identity_table);
      return ok ? { kind, record: record as unknown as { identity_table: string } } : bad;
    }
    case "marker": {
      const names = Object.keys(item).filter((name) => item[name] !== undefined).sort();
      if (names.join(",") !== "at,fmt,pk,sk,ttl") return bad;
      const format = decodeValue(item.fmt, "N");
      const at = decodeValue(item.at, "N");
      const ttl = decodeValue(item.ttl, "N");
      const ok = format.ok && format.value === IDENTITY_ITEM_FORMAT && at.ok && ttl.ok && ttl.value === markerTtl(at.value as number) && TOKEN_PATTERN.test(suffix);
      return ok ? { kind, record: { token: suffix, at: at.value as number } } : bad;
    }
    default:
      return bad;
  }
}

/** The patterns a key's id must match, by class (for the planner's own assertions). */
export const ID_PATTERNS = Object.freeze({
  principal: PRINCIPAL_ID_PATTERN,
  profile: PROFILE_ID_PATTERN,
  session: SESSION_ID_PATTERN,
  family: FAMILY_ID_PATTERN,
  selector: RECOVERY_SELECTOR_PATTERN,
  token: TOKEN_PATTERN,
});
