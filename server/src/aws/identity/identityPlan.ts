// server/src/aws/identity/identityPlan.ts
//
// ==================================================================
//  LIVE-5 L5-4: ONE IDENTITY CHANGE AS DYNAMODB TRANSACTIONS -- EVERY PRECONDITION A CONDITION OF THE WRITE
// ==================================================================
//
// Pure: a change (the identity port's `IdentityChange`) in, the TransactWriteItems actions out. The committer
// (`dynamoIdentityStore.ts`) adds the role fence and the commit marker to each transaction and sends it.
//
// WHAT IS A CONDITION, AND WHAT IS NOT. A change's verdict (the journal store's `IdentityIndex.check` +
// `preconditionFailure`) has two parts:
//   - what the change says about ITSELF -- its shape, one record once, the relations between two records it carries
//     (a session and the family it founds, a profile and the principal it binds, two profiles claiming one selector).
//     Decided here, before anything is sent, from the change alone: refused DEFINITE.
//   - what it asks of the STORED state -- every precondition (`expect`), and every relation to a record the change does
//     not carry (a session's family, a profile's principal, a link's profile, a principal's profile), and every rule
//     about a record's own past (a session never moves family; a family never moves principal, changes origin or
//     reopens; a profile never moves principal; a bound principal never leaves its profile). EACH OF THESE IS A
//     CONDITION ON THE ITEM IT NAMES, IN THE SAME TRANSACTION AS THE WRITE: on the item's own Put or Delete when the
//     change writes it, a ConditionCheck when it does not. DynamoDB forbids two actions on one item, so every term
//     that names one item is merged (AND) into that item's one action.
// The writer's own view is consulted for exactly one thing, the recovery selector a changed profile holds now (to retire
// its uniqueness item) -- and that is PINNED by a condition too, so a stale view can only ever refuse.
// `identityPlan.test` / the DynamoDB differential suite send random changes with NO pre-check and require the store's
// verdict to be exactly the pure verdict.
//
// THE USERNAME UNIQUENESS ITEM (`USER#<login key>`, P3-ACCT). A profile written with a username claims `USER#k` in the
// same transaction (condition: absent, or already this profile's); a profile's username, once set, never changes or
// goes (a condition on the profile's own Put). `login-unused` is `USER#k` absent.
//
// THE SELECTOR UNIQUENESS ITEM (`SEL#<rk>`, identityItems.ts). Invariant: it is live (`retired_at` NULL) with
// `profile_id` P exactly when profile P holds that selector. A profile written with selector s claims `SEL#s` (condition:
// absent, retired, or held by this profile or by one this change moves off s); the selector a changed profile gives up
// is retired (condition: it is live and this profile's). `selector-unused` is `SEL#s` absent or retired -- what the
// memory and journal stores mean by "no stored profile holds it".
//
// ONE CHANGE, MORE THAN ONE TRANSACTION. A transaction holds at most 100 items; a sign-out of a principal who has been
// rotating on several devices for months can end more sessions than that (every rotated session of the principal ends
// with a logout, LIVE-2F/3D C1-01). Such a change is split into chunks, IN AN ORDER THAT KEEPS EVERY PREFIX A VALID,
// SAFE IDENTITY SET -- EVERY SECURITY EFFECT BEFORE ANYTHING ELSE (L5-4 review F1):
//   1. the gate: every ConditionCheck carrying a precondition of the change (nothing is written unless all hold);
//   2. principals (a disable), then profiles with their selector items (a key rotation) -- a principal and the profile
//      it binds, and every profile of a selector swap, are ONE unit, never split (a half-bound pair would not load);
//   3. the security effects of a sign-out:
//      a. families -- the unit of revocation: a revoked family ends every member at once, whatever the members' own
//         records say (`classify`, `authenticate`, `socketVerdict` all read it);
//      b. link codes, dropped or written (a signed-out device's profile keeps no outstanding code, LIVE-2E H1; a
//         consumed code is single-use);
//      c. every session a SECURITY revocation ends whose family this change does not revoke -- "sign out other
//         devices" keeps the caller's family open and ends its other members one by one; a logout ends the principal's
//         rotated sessions of other families (C1-01) -- newest first (the newest are the ones still in use);
//   4. every other session write (a mint, a rotation, a member its revoked family already covers);
//   5. session records dropped (the write-behind's collection of dead records: no security effect).
// Each write carries its relation checks in its own transaction. A crash between chunks leaves a prefix that loads and
// is safe (the committer reports it UNKNOWN and holds itself until a restart reads the truth); see the committer. What
// is NOT promised: a change whose step-3 writes alone exceed one transaction (about 90 sessions ended one by one) can be
// cut inside step 3; the prefix still loads, and the user's retry after the restart ends the rest.

import type { AttributeValue, TransactWriteItem } from "@aws-sdk/client-dynamodb";

import {
  changeIdProblem,
  changeShapeProblem,
  isLinkCredential,
  isPrincipal,
  isProfile,
  isSecurityRevocation,
  isSession,
  isSessionFamily,
  loginOf,
  type IdentityChange,
  type IdentityPrecondition,
  type Principal,
  type Profile,
} from "../../identity/store";
import {
  familyItem,
  keys,
  keyAttributes,
  keyText,
  linkItem,
  N,
  principalItem,
  profileItem,
  S,
  selectorItem,
  sessionItem,
  userItem,
  type Item,
  type ItemClass,
  type ItemKey,
} from "./identityItems";

/** DynamoDB's limit on the items of one TransactWriteItems. */
export const MAX_TRANSACTION_ACTIONS = 100;
/** The role fence and the commit marker take two of every transaction's actions. */
export const CHUNK_BUDGET = MAX_TRANSACTION_ACTIONS - 2;

/* ------------------------------------------------------------------ */
/* Conditions, as data (rendered to a ConditionExpression per action)   */
/* ------------------------------------------------------------------ */

export type Clause =
  | { readonly op: "absent" }
  | { readonly op: "exists" }
  | { readonly op: "eq"; readonly attr: string; readonly value: AttributeValue }
  | { readonly op: "null"; readonly attr: string }
  | { readonly op: "not-null"; readonly attr: string }
  /** P3-ACCT: the item has no such attribute at all (a schema-1 profile has no `login_key`). */
  | { readonly op: "attr-absent"; readonly attr: string }
  | { readonly op: "gt"; readonly attr: string; readonly value: AttributeValue }
  | { readonly op: "lt"; readonly attr: string; readonly value: AttributeValue }
  | { readonly op: "in"; readonly attr: string; readonly values: readonly AttributeValue[] }
  | { readonly op: "or"; readonly of: readonly Clause[] }
  | { readonly op: "and"; readonly of: readonly Clause[] };

export const cl = Object.freeze({
  absent: (): Clause => ({ op: "absent" }),
  exists: (): Clause => ({ op: "exists" }),
  eqS: (attr: string, value: string): Clause => ({ op: "eq", attr, value: S(value) }),
  eqN: (attr: string, value: number): Clause => ({ op: "eq", attr, value: N(value) }),
  isNull: (attr: string): Clause => ({ op: "null", attr }),
  notNull: (attr: string): Clause => ({ op: "not-null", attr }),
  attrAbsent: (attr: string): Clause => ({ op: "attr-absent", attr }),
  gtN: (attr: string, value: number): Clause => ({ op: "gt", attr, value: N(value) }),
  ltN: (attr: string, value: number): Clause => ({ op: "lt", attr, value: N(value) }),
  inS: (attr: string, values: readonly string[]): Clause => ({ op: "in", attr, values: values.map(S) }),
  or: (...of: Clause[]): Clause => ({ op: "or", of }),
  and: (...of: Clause[]): Clause => ({ op: "and", of }),
});

/** Placeholders for one expression: every attribute name goes through `#n<k>` (several are reserved words). */
class Expression {
  readonly names: Record<string, string> = {};
  readonly values: Record<string, AttributeValue> = {};
  private readonly byName = new Map<string, string>();
  private valueCount = 0;

  name(attr: string): string {
    let placeholder = this.byName.get(attr);
    if (placeholder === undefined) {
      placeholder = `#n${this.byName.size}`;
      this.byName.set(attr, placeholder);
      this.names[placeholder] = attr;
    }
    return placeholder;
  }

  value(value: AttributeValue): string {
    const placeholder = `:v${this.valueCount}`;
    this.valueCount += 1;
    this.values[placeholder] = value;
    return placeholder;
  }

  render(clause: Clause): string {
    switch (clause.op) {
      case "absent":
        return `attribute_not_exists(${this.name("pk")})`;
      case "exists":
        return `attribute_exists(${this.name("pk")})`;
      case "eq":
        return `${this.name(clause.attr)} = ${this.value(clause.value)}`;
      case "null":
        return `attribute_type(${this.name(clause.attr)}, ${this.value(S("NULL"))})`;
      case "not-null":
        return `NOT attribute_type(${this.name(clause.attr)}, ${this.value(S("NULL"))})`;
      case "attr-absent":
        return `attribute_not_exists(${this.name(clause.attr)})`;
      case "gt":
        return `${this.name(clause.attr)} > ${this.value(clause.value)}`;
      case "lt":
        return `${this.name(clause.attr)} < ${this.value(clause.value)}`;
      case "in":
        return `${this.name(clause.attr)} IN (${clause.values.map((value) => this.value(value)).join(", ")})`;
      case "or":
        return clause.of.map((inner) => `(${this.render(inner)})`).join(" OR ");
      case "and":
        return clause.of.map((inner) => `(${this.render(inner)})`).join(" AND ");
      default:
        throw new Error("identity plan: an unknown clause");
    }
  }
}

/* ------------------------------------------------------------------ */
/* The plan                                                            */
/* ------------------------------------------------------------------ */

export type ActionOp = "put" | "delete" | "check";

interface ItemSpec {
  readonly key: ItemKey;
  readonly text: string;
  readonly cls: ItemClass;
  op: ActionOp;
  item?: Item;
  /** Clauses, deduplicated by their JSON. */
  readonly clauses: Map<string, Clause>;
  /** Why each clause is there (kinds and positions only -- never an id): the refusal message when one fails. */
  readonly reasons: string[];
  /** A ConditionCheck carrying at least one PRECONDITION: it belongs to the first transaction (the gate). */
  gate: boolean;
}

export interface PlannedAction {
  readonly action: TransactWriteItem;
  readonly op: ActionOp;
  readonly cls: ItemClass;
  readonly reasons: readonly string[];
}

export interface PlannedChunk {
  readonly actions: readonly PlannedAction[];
}

export type IdentityPlan = { readonly kind: "plan"; readonly chunks: readonly PlannedChunk[] } | { readonly kind: "refused"; readonly detail: string };

/** What the planner asks of the writer's view: the recovery selector a profile holds now (undefined: no such profile).
 *  Every answer is pinned by a condition, so a wrong one can only make the transaction refuse. */
export interface IdentityPlanView {
  profileSelector(profileId: string): string | undefined;
}

/** The order of a change's writes across transactions (the header's steps): lower lands first. */
export const WRITE_ORDER = Object.freeze({
  principal: 20,
  profile: 21,
  family: 30,
  link: 31,
  endedSession: 32,
  session: 40,
  droppedSession: 50,
});

/** Why the change contradicts ITSELF (`null`: it does not). Decided from the change alone, before anything is sent. */
export function internalProblem(change: IdentityChange): string | null {
  const shape = changeShapeProblem(change) ?? changeIdProblem(change);
  if (shape !== null) return shape;
  const principals = new Map<string, Principal>();
  for (const [at, record] of (change.principals ?? []).entries()) {
    if (!isPrincipal(record)) return `principal #${at} is not a principal record`;
    if (record.activated_at === null) return `principal #${at} was never activated`;
    principals.set(record.principal_id, record);
  }
  const profiles = new Map<string, Profile>();
  for (const [at, record] of (change.profiles ?? []).entries()) {
    if (!isProfile(record)) return `profile #${at} is not a profile record`;
    profiles.set(record.profile_id, record);
  }
  const families = new Map<string, string>();
  for (const [at, record] of (change.families ?? []).entries()) {
    if (!isSessionFamily(record)) return `session family #${at} is not a family record`;
    families.set(record.family_id, record.principal_id);
  }
  for (const [at, record] of (change.sessions ?? []).entries()) {
    if (!isSession(record)) return `session #${at} is not a session record`;
    const familyPrincipal = families.get(record.family_id);
    if (familyPrincipal !== undefined && familyPrincipal !== record.principal_id) return `session #${at} names no session family of its principal`;
  }
  for (const [at, record] of (change.links ?? []).entries()) {
    if (!isLinkCredential(record)) return `link code #${at} is not a link record`;
  }
  for (const [at, record] of [...principals.values()].entries()) {
    if (record.kind !== "profile") continue;
    const bound = profiles.get(record.account_link as string);
    if (bound !== undefined && bound.principal_id !== record.principal_id) return `principal #${at}: a profile principal is not bound to its profile both ways`;
  }
  const claimed = new Set<string>();
  const logins = new Set<string>();
  for (const [at, record] of [...profiles.values()].entries()) {
    const owner = principals.get(record.principal_id);
    if (owner !== undefined && (owner.kind !== "profile" || owner.account_link !== record.profile_id)) return `profile #${at} is not bound to its principal both ways`;
    if (claimed.has(record.recovery_selector)) return `profile #${at} repeats a recovery selector`;
    claimed.add(record.recovery_selector);
    const login = loginOf(record);
    if (login !== null && logins.has(login.key)) return `profile #${at} repeats a username`;
    if (login !== null) logins.add(login.key);
  }
  return null;
}

/** The action for one precondition: its item, and its clause. */
function preconditionTarget(condition: IdentityPrecondition): { key: ItemKey; cls: ItemClass; clause: Clause } {
  switch (condition.kind) {
    case "principal-absent":
      return { key: keys.principal(condition.principal_id), cls: "principal", clause: cl.absent() };
    case "principal-unprofiled":
      return { key: keys.principal(condition.principal_id), cls: "principal", clause: cl.and(cl.eqS("kind", "unprofiled"), cl.eqS("status", "active")) };
    case "profile-absent":
      return { key: keys.profile(condition.profile_id), cls: "profile", clause: cl.absent() };
    case "selector-unused":
      return { key: keys.selector(condition.recovery_selector), cls: "selector", clause: cl.or(cl.absent(), cl.notNull("retired_at")) };
    case "profile-selector":
      return { key: keys.profile(condition.profile_id), cls: "profile", clause: cl.eqS("recovery_selector", condition.recovery_selector) };
    case "session-absent":
      return { key: keys.session(condition.session_id), cls: "session", clause: cl.absent() };
    case "session-open":
      /* Stored, and not SECURITY-revoked: live, or rotated (and so still in its grace, which the service judges). */
      return { key: keys.session(condition.session_id), cls: "session", clause: cl.and(cl.exists(), cl.or(cl.isNull("revoke_reason"), cl.eqS("revoke_reason", "rotated"))) };
    case "link-absent":
      return { key: keys.link(condition.link_hash), cls: "link", clause: cl.absent() };
    case "link-unconsumed":
      return { key: keys.link(condition.link_hash), cls: "link", clause: cl.and(cl.exists(), cl.isNull("consumed_at"), cl.gtN("expires_at", condition.at)) };
    case "family-absent":
      return { key: keys.family(condition.family_id), cls: "family", clause: cl.absent() };
    case "family-open":
      return { key: keys.family(condition.family_id), cls: "family", clause: cl.and(cl.exists(), cl.isNull("revoked_at")) };
    case "login-unused":
      return { key: keys.user(condition.login_key), cls: "user", clause: cl.absent() };
    case "profile-no-login":
      return { key: keys.profile(condition.profile_id), cls: "profile", clause: cl.and(cl.exists(), cl.or(cl.attrAbsent("login_key"), cl.isNull("login_key"))) };
    case "profile-wallet":
      return {
        key: keys.profile(condition.profile_id),
        cls: "profile",
        /* Legacy only (review NEW-2): never holds for a schema-3 (Authorization Wallet) profile. */
        clause: cl.and(cl.exists(), cl.ltN("schema", 3), condition.wallet_address === null ? cl.or(cl.attrAbsent("wallet_address"), cl.isNull("wallet_address")) : cl.eqS("wallet_address", condition.wallet_address)),
      };
    case "profile-authorization-wallet":
      /* PHASE 3 FINAL (review L3): the Authorization Wallet's designation -- address AND since -- exactly as the
         memory store compares it. */
      return {
        key: keys.profile(condition.profile_id),
        cls: "profile",
        clause: cl.and(cl.exists(), cl.eqN("schema", 3), cl.eqS("wallet_address", condition.wallet_address), cl.eqN("wallet_verified_at", condition.wallet_since)),
      };
    case "profile-password":
      /* P3-ACCT POLICY: the password generation's compare-and-swap (the hash carries a fresh salt every time). */
      return { key: keys.profile(condition.profile_id), cls: "profile", clause: cl.and(cl.exists(), cl.eqS("password_hash", condition.password_hash)) };
    default:
      throw new Error("identity plan: an unknown precondition (the shape check refuses it first)");
  }
}

/** Plan a change: refused (DEFINITE, from the change alone), or the transactions that carry it. */
export function planIdentityChange(change: IdentityChange, view: IdentityPlanView, table: string, budget: number = CHUNK_BUDGET): IdentityPlan {
  const problem = internalProblem(change);
  if (problem !== null) return { kind: "refused", detail: problem };

  const specs = new Map<string, ItemSpec>();
  const spec = (key: ItemKey, cls: ItemClass): ItemSpec => {
    const text = keyText(key);
    let found = specs.get(text);
    if (found === undefined) {
      found = { key, text, cls, op: "check", clauses: new Map(), reasons: [], gate: false };
      specs.set(text, found);
    }
    return found;
  };
  const add = (target: ItemSpec, clause: Clause, reason: string) => {
    const id = JSON.stringify(clause);
    if (!target.clauses.has(id)) target.clauses.set(id, clause);
    if (!target.reasons.includes(reason)) target.reasons.push(reason);
  };
  const write = (target: ItemSpec, item: Item) => {
    target.op = "put";
    target.item = item;
  };
  /** Relation checks: the write that depends on a stored record -> the check specs it needs (in its own transaction). */
  const dependsOn = new Map<string, Set<string>>();
  const depend = (writer: ItemSpec, target: ItemSpec, clause: Clause, reason: string) => {
    add(target, clause, reason);
    let set = dependsOn.get(writer.text);
    if (set === undefined) {
      set = new Set();
      dependsOn.set(writer.text, set);
    }
    set.add(target.text);
  };

  const principalsInChange = new Set((change.principals ?? []).map((record) => record.principal_id));
  const profilesInChange = new Map((change.profiles ?? []).map((record) => [record.profile_id, record] as const));
  const familiesInChange = new Set((change.families ?? []).map((record) => record.family_id));

  /* ---- the records the change writes, each with the rules about its own past ---- */
  for (const record of change.principals ?? []) {
    const target = spec(keys.principal(record.principal_id), "principal");
    write(target, principalItem(record));
    add(
      target,
      record.kind === "profile" ? cl.or(cl.absent(), cl.eqS("kind", "unprofiled"), cl.eqS("account_link", record.account_link as string)) : cl.or(cl.absent(), cl.eqS("kind", "unprofiled")),
      "a principal never leaves the profile it is bound to",
    );
  }
  for (const record of change.profiles ?? []) {
    const target = spec(keys.profile(record.profile_id), "profile");
    write(target, profileItem(record));
    add(target, cl.or(cl.absent(), cl.eqS("principal_id", record.principal_id)), "a profile never moves to another principal");
    const held = view.profileSelector(record.profile_id);
    add(target, held === undefined ? cl.absent() : cl.eqS("recovery_selector", held), "the writer's view of the profile's selector (pinned)");
    /* P3-ACCT: a username, once set, never changes or goes; a schema-2 record never becomes schema 1. */
    const login = loginOf(record);
    const unset = [cl.attrAbsent("login_key"), cl.isNull("login_key")];
    add(target, cl.or(cl.absent(), ...unset, ...(login === null ? [] : [cl.eqS("login_key", login.key)])), "a profile's username never changes or goes");
    if (record.schema === 1) add(target, cl.or(cl.absent(), cl.attrAbsent("login_key")), "a profile never returns to schema 1");
    /* PHASE 3 FINAL: a schema-3 profile (the Authorization Wallet model) is made as one and stays one; no legacy record
       ever becomes one (there is no migration). */
    add(target, record.schema === 3 ? cl.or(cl.absent(), cl.gtN("schema", 2)) : cl.or(cl.absent(), cl.ltN("schema", 3)), "a profile never changes between the legacy and the Authorization Wallet schema");
  }
  for (const record of change.families ?? []) {
    const target = spec(keys.family(record.family_id), "family");
    write(target, familyItem(record));
    const same = [cl.eqS("principal_id", record.principal_id), cl.eqS("origin", record.origin)];
    if (record.revoked_at === null) same.push(cl.isNull("revoked_at"));
    add(target, cl.or(cl.absent(), cl.and(...same)), "a family never moves, changes its origin or reopens");
  }
  for (const record of change.sessions ?? []) {
    const target = spec(keys.session(record.session_id), "session");
    write(target, sessionItem(record));
    add(target, cl.or(cl.absent(), cl.eqS("family_id", record.family_id)), "a session never moves to another family");
  }
  for (const record of change.links ?? []) write(spec(keys.link(record.link_hash), "link"), linkItem(record));
  for (const id of change.dropSessions ?? []) spec(keys.session(id), "session").op = "delete";
  for (const hash of change.dropLinks ?? []) spec(keys.link(hash), "link").op = "delete";

  /* ---- the selector uniqueness items ---- */
  const claims = new Map((change.profiles ?? []).map((record) => [record.recovery_selector, record] as const));
  for (const record of change.profiles ?? []) {
    const held = view.profileSelector(record.profile_id);
    /* A profile in this change that gives up the selector `record` claims: that one may still hold it now. */
    const movers = (change.profiles ?? [])
      .filter((other) => other.profile_id !== record.profile_id && view.profileSelector(other.profile_id) === record.recovery_selector && other.recovery_selector !== record.recovery_selector)
      .map((other) => other.profile_id);
    const target = spec(keys.selector(record.recovery_selector), "selector");
    write(target, selectorItem({ recovery_selector: record.recovery_selector, profile_id: record.profile_id, retired_at: null }));
    add(target, cl.or(cl.absent(), cl.notNull("retired_at"), cl.inS("profile_id", [record.profile_id, ...movers])), "no other profile holds the selector");
    if (held !== undefined && held !== record.recovery_selector && !claims.has(held)) {
      const retired = spec(keys.selector(held), "selector");
      write(retired, selectorItem({ recovery_selector: held, profile_id: record.profile_id, retired_at: record.recovery_rotated_at }));
      add(retired, cl.and(cl.eqS("profile_id", record.profile_id), cl.isNull("retired_at")), "the retired selector was this profile's (pinned)");
    }
  }

  /* ---- P3-ACCT: the username uniqueness items (claimed with the profile that takes the username) ---- */
  for (const record of change.profiles ?? []) {
    const login = loginOf(record);
    if (login === null) continue;
    const target = spec(keys.user(login.key), "user");
    write(target, userItem({ login_key: login.key, profile_id: record.profile_id }));
    add(target, cl.or(cl.absent(), cl.eqS("profile_id", record.profile_id)), "no other profile holds the username");
  }

  /* ---- relations to records the change does not carry ---- */
  for (const record of change.families ?? []) {
    if (!principalsInChange.has(record.principal_id)) {
      depend(spec(keys.family(record.family_id), "family"), spec(keys.principal(record.principal_id), "principal"), cl.exists(), "a family's principal is stored");
    }
  }
  for (const record of change.principals ?? []) {
    if (record.kind === "profile" && !profilesInChange.has(record.account_link as string)) {
      depend(spec(keys.principal(record.principal_id), "principal"), spec(keys.profile(record.account_link as string), "profile"), cl.eqS("principal_id", record.principal_id), "a profile principal's profile names it back");
    }
  }
  for (const record of change.profiles ?? []) {
    if (!principalsInChange.has(record.principal_id)) {
      depend(
        spec(keys.profile(record.profile_id), "profile"),
        spec(keys.principal(record.principal_id), "principal"),
        cl.and(cl.eqS("kind", "profile"), cl.eqS("account_link", record.profile_id)),
        "a profile's principal is bound to it",
      );
    }
  }
  for (const record of change.sessions ?? []) {
    const writer = spec(keys.session(record.session_id), "session");
    if (!principalsInChange.has(record.principal_id)) depend(writer, spec(keys.principal(record.principal_id), "principal"), cl.exists(), "a session's principal is stored");
    if (!familiesInChange.has(record.family_id)) depend(writer, spec(keys.family(record.family_id), "family"), cl.eqS("principal_id", record.principal_id), "a session's family is its principal's");
  }
  for (const record of change.links ?? []) {
    if (!profilesInChange.has(record.profile_id)) depend(spec(keys.link(record.link_hash), "link"), spec(keys.profile(record.profile_id), "profile"), cl.exists(), "a link code's profile is stored");
  }

  /* ---- the preconditions: each a clause on the item it names ---- */
  for (const [at, condition] of (change.expect ?? []).entries()) {
    const target = preconditionTarget(condition);
    const item = spec(target.key, target.cls);
    add(item, target.clause, `precondition #${at} (${condition.kind})`);
    if (item.op === "check") item.gate = true;
  }

  /* A relation target the change also writes would have been decided from the change itself: never a check here. */
  for (const [writer, targets] of dependsOn) {
    for (const target of targets) {
      if ((specs.get(target) as ItemSpec).op !== "check") throw new Error(`identity plan: a relation check names an item the change writes (${writer})`);
    }
  }

  /* ---- units: what must share one transaction ---- */
  const parent = new Map<string, string>();
  const find = (text: string): string => {
    let root = text;
    while (parent.get(root) !== undefined && parent.get(root) !== root) root = parent.get(root) as string;
    parent.set(text, root);
    return root;
  };
  const union = (a: string, b: string) => {
    const [ra, rb] = [find(a), find(b)];
    if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
  };
  const writes = [...specs.values()].filter((item) => item.op !== "check");
  for (const item of writes) parent.set(item.text, item.text);
  for (const record of change.profiles ?? []) {
    const profileText = keyText(keys.profile(record.profile_id));
    union(profileText, keyText(keys.selector(record.recovery_selector)));
    const held = view.profileSelector(record.profile_id);
    if (held !== undefined && specs.get(keyText(keys.selector(held)))?.op === "put") union(profileText, keyText(keys.selector(held)));
    if (principalsInChange.has(record.principal_id)) union(profileText, keyText(keys.principal(record.principal_id)));
    const login = loginOf(record);
    if (login !== null) union(profileText, keyText(keys.user(login.key)));
  }
  for (const record of change.principals ?? []) {
    if (record.kind === "profile" && profilesInChange.has(record.account_link as string)) union(keyText(keys.principal(record.principal_id)), keyText(keys.profile(record.account_link as string)));
  }
  const units = new Map<string, ItemSpec[]>();
  for (const item of writes) {
    const root = find(item.text);
    units.set(root, [...(units.get(root) ?? []), item]);
  }
  /* ---- the order (the header's steps) ---- */
  const revokedHere = new Set((change.families ?? []).filter((record) => record.revoked_at !== null).map((record) => record.family_id));
  /** Each session a security revocation ends that no family revocation of this change covers -> its creation time. */
  const endedAlone = new Map<string, number>();
  for (const record of change.sessions ?? []) {
    if (isSecurityRevocation(record.revoke_reason) && !revokedHere.has(record.family_id)) endedAlone.set(keyText(keys.session(record.session_id)), record.created_at);
  }
  const rank = (item: ItemSpec): readonly [number, number] => {
    switch (item.cls) {
      case "principal":
        return [WRITE_ORDER.principal, 0];
      case "profile":
      case "selector":
      case "user":
        return [WRITE_ORDER.profile, 0];
      case "family":
        return [WRITE_ORDER.family, 0];
      case "link":
        return [WRITE_ORDER.link, 0];
      case "session": {
        if (item.op === "delete") return [WRITE_ORDER.droppedSession, 0];
        const created = endedAlone.get(item.text);
        return created === undefined ? [WRITE_ORDER.session, 0] : [WRITE_ORDER.endedSession, -created];
      }
      default:
        throw new Error(`identity plan: a change never writes a ${item.cls} item`);
    }
  };
  const before = (a: ItemSpec, b: ItemSpec): number => {
    const [rankA, subA] = rank(a);
    const [rankB, subB] = rank(b);
    return rankA - rankB || subA - subB || (a.text < b.text ? -1 : a.text > b.text ? 1 : 0);
  };
  const ordered = [...units.values()].map((members) => members.sort(before)).sort((a, b) => before(a[0], b[0]));

  /* ---- packing: the gate first, then units in order, each with its relation checks ---- */
  const gates = [...specs.values()].filter((item) => item.op === "check" && item.gate).sort((a, b) => (a.text < b.text ? -1 : 1));
  if (gates.length > budget) return { kind: "refused", detail: `the change has ${gates.length} preconditions on records it does not write -- more than one transaction can check at once` };
  const chunks: ItemSpec[][] = [];
  let current: ItemSpec[] = [...gates];
  let inCurrent = new Set(current.map((item) => item.text));
  for (const members of ordered) {
    const needed = (within: Set<string>) => {
      const out: ItemSpec[] = [];
      const seen = new Set<string>();
      for (const member of members) {
        for (const target of dependsOn.get(member.text) ?? []) {
          if (!within.has(target) && !seen.has(target)) {
            seen.add(target);
            out.push(specs.get(target) as ItemSpec);
          }
        }
      }
      return out;
    };
    let checks = needed(inCurrent);
    if (current.length + checks.length + members.length > budget && current.length > 0) {
      chunks.push(current);
      current = [];
      inCurrent = new Set();
      checks = needed(inCurrent);
    }
    if (checks.length + members.length > budget) return { kind: "refused", detail: `one unit of the change needs ${checks.length + members.length} items in a single transaction` };
    for (const item of [...checks.sort((a, b) => (a.text < b.text ? -1 : 1)), ...members]) {
      current.push(item);
      inCurrent.add(item.text);
    }
  }
  if (current.length > 0 || chunks.length === 0) chunks.push(current);

  /* ---- rendering ---- */
  const render = (item: ItemSpec): PlannedAction => {
    const expression = new Expression();
    const clauses = [...item.clauses.values()];
    const condition = clauses.length === 0 ? undefined : clauses.length === 1 ? expression.render(clauses[0]) : expression.render(cl.and(...clauses));
    const withCondition =
      condition === undefined ? {} : { ConditionExpression: condition, ExpressionAttributeNames: expression.names, ...(Object.keys(expression.values).length > 0 ? { ExpressionAttributeValues: expression.values } : {}) };
    let action: TransactWriteItem;
    if (item.op === "put") action = { Put: { TableName: table, Item: item.item as Item, ...withCondition } };
    else if (item.op === "delete") action = { Delete: { TableName: table, Key: keyAttributes(item.key), ...withCondition } };
    else {
      if (condition === undefined) throw new Error("identity plan: a check with no condition");
      action = { ConditionCheck: { TableName: table, Key: keyAttributes(item.key), ConditionExpression: condition, ExpressionAttributeNames: expression.names, ...(Object.keys(expression.values).length > 0 ? { ExpressionAttributeValues: expression.values } : {}) } };
    }
    return { action, op: item.op, cls: item.cls, reasons: [...item.reasons] };
  };
  return { kind: "plan", chunks: chunks.map((members) => ({ actions: members.map(render) })) };
}
