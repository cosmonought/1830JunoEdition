// frontend/src/gameEngine/compat/continuationVerdict.ts
//
// ==================================================================
//  LIVE-4 (L4-1): THE ONE ANSWER TO "MAY THIS POOL CONTINUE THIS GAME?", AND WHO SERVES IT DURING A DRAIN
// ==================================================================
//
// `continuationVerdict(game, capability)` is pure: facts in, a verdict out, no I/O. It has exactly three answers, and
// the difference between the last two is the whole point:
//
//   continues        this pool replays and plays the game (a money game only where its escrow is served too: the
//                    checkpoints protect only positions this pool can sign).
//   not-continued    DERIVED. This pool cannot carry the game on, and nothing is wrong with the game: another pool
//                    may. It is recomputed on every load and WRITES NOTHING -- no hold, no transition, no `defer` --
//                    so a pool that knows less than the game's own pool never damages it. Its `why` says where it
//                    belongs (route) or what an operator should look at (page).
//   conflict         DURABLE. Two verified facts about the game contradict each other, and no pool can continue it
//                    until an operator decides. Only three shapes: the escrow contract at the game's address REPORTING,
//                    on chain, another code checksum or denom than the game was bound to; a money identity that
//                    disagrees with its own deal or its own deployment; and a money table whose financial record is
//                    missing. Each maps to an existing hold code (`CONFLICT_HOLD_CODES`); only the game's owning pool
//                    writes it.
//
// FORMAT FACTS COME FIRST. Every durable artifact of the game is classified by the store that reads it -- current,
// newer, older-unread, corrupt (`formatFactOf`) -- and the verdict reads those classes before anything else. A NEWER
// format is another build's writing, never damage: it is `not-continued/newer-format`, derived, and the pool that
// wrote it continues the game. An OLDER format this build no longer reads is the same, the other way round. Only an
// artifact in a format this build reads, that does not parse as that format, is `malformed` -- and even that is not a
// conflict here: the stores' existing corruption holds (`record-unreadable`, `log-corrupt`) still apply to it.
//
// THE BUILD HAS NO VOTE. Nothing here reads a build id: the game's facts are its deal's versions and its money
// identity, and the pool's are its capability. Two builds with equal facts give equal answers.
//
// EVALUATION ORDER (the first failure decides; preflight §7.1):
//   1. formats: newer, then older-unread, then corrupt, each in artifact order (record, log, fin, tickets, intents);
//   2. the deal: malformed; legacy (unpinned) -- admitted only by an explicit development-corpus policy, never for money;
//   3. the dealt gameplay identity: rules ∈ supported, then hosted ∈ hosted_protocols;
//   4. money present: a missing financial record is a conflict; ESCROW-3A's held placeholder is already held (malformed);
//   5. the money identity, by set membership, in ESCROW-3A's order: malformed, rules-not-supported,
//      rules-not-certified, hosted-protocol, financial-protocol, settlement-codec. For a table not yet dealt that is
//      exactly what `moneyContinuationVerdict` answers, reason for reason, with single-valued sets. For a dealt game the
//      deal is read first (steps 2-3), so two derived reasons can differ from ESCROW-3A's, never whether the game is
//      continued: a deal whose hosted protocol this pool does not read is named before an uncertified rules version,
//      and a deal this pool does not play or read is named before a malformed money identity;
//   6. agreement: the money identity's rules and hosted protocol are the deal's, and its codec is its deployment's;
//   7. the deployment: its key served here; then, where the chain was read this run, the game's code checksum and
//      denom are the chain's (else a CONFLICT: the contract at that address is not what the game was bound to) -- and,
//      where it was NOT read this run, a game whose financial record is held for a deployment conflict is
//      `deployment-unverified` (DERIVED, L4-7: the durable hold outlives the run's facts, and only a new verification-
//      grade read may conclude the conflict again or clear it); then the configured facts are the game's (else
//      `deployment-unverified`, DERIVED: a configuration typo, or a declared fact no chain read attests, must never
//      mass-hold money games).

import {
  ABSENT_HOSTED_PROTOCOL,
  gameContinuationIdentity,
  gameplayIdentityOfMoney,
  isMoneyContinuationIdentity,
  isVersionNumber,
  type GameContinuationIdentity,
  type GameIdentityFacts,
  type MoneyContinuationIdentity,
} from "./continuationIdentity";
import {
  CHAIN_ATTESTED_FACT_FIELDS,
  deploymentCapability,
  deploymentFactDifference,
  deploymentKey,
  newDealHostedProtocol,
  servedDeployment,
  type DeploymentCapability,
  type DeploymentPin,
} from "./deploymentCapability";
import type { ReplayPolicy } from "../rulesVersion";

/* ------------------------------------------------------------------ */
/* Format facts                                                        */
/* ------------------------------------------------------------------ */

/** How THIS build classifies one stored artifact's format. Decided by the store that reads it, never guessed. */
export type FormatFact = "current" | "newer" | "older-unread" | "corrupt";

/** The artifacts a game may have, in the order the verdict reads them. The money ones are absent for a no-money game. */
export const GAME_ARTIFACTS = Object.freeze(["record", "log", "fin", "tickets", "intents"] as const);
export type GameArtifact = (typeof GAME_ARTIFACTS)[number];

export interface ArtifactFormats {
  readonly record: FormatFact;
  readonly log: FormatFact;
  readonly fin?: FormatFact;
  readonly tickets?: FormatFact;
  readonly intents?: FormatFact;
}

/**
 * The class of a stored format version against the versions this build reads (and writes).
 *
 *  - read here: `current` (the store still has to parse it; a shape that fails that parse is `corrupt`);
 *  - above every version read here: `newer` -- a later build wrote it;
 *  - otherwise a real version this build does not read: `older-unread` -- an earlier build wrote it;
 *  - not a version at all (absent, not a positive integer): `corrupt`.
 *
 * Newer and older-unread are never corruption and never a hold: they name the build that can read the artifact.
 */
export function formatFactOf(version: unknown, readable: readonly number[]): FormatFact {
  if (readable.length === 0 || !readable.every(isVersionNumber)) throw new TypeError("a store reads at least one format version");
  if (!isVersionNumber(version)) return "corrupt";
  if (readable.includes(version)) return "current";
  const newest = readable.reduce((a, b) => (b > a ? b : a), readable[0]);
  return version > newest ? "newer" : "older-unread";
}

/* ------------------------------------------------------------------ */
/* The game's facts                                                    */
/* ------------------------------------------------------------------ */

/** What the game's financial side says. `null` for a no-money game. */
export type MoneyFacts =
  | null
  /** A money GameRecord with no financial record. */
  | { readonly kind: "missing" }
  /** ESCROW-3A's placeholder for a missing record: already held, with no continuation identity. */
  | { readonly kind: "placeholder" }
  /** The financial record: its stored continuation identity (unparsed) and its write-once deployment pin. `held` (L4-7):
   *  the code the record is HELD under, when it is held (a financial hold is durable: the owning pool wrote it); absent or
   *  null when it is not held. The verdict reads only one code of it -- `CONFLICT_HOLD_CODES["deployment-conflict"]`, the
   *  durable record of a verified deployment conflict (a verified conflict supersedes any weaker hold, so it is always
   *  recorded under this code: `moneyLifecycle.ts`) -- and only while this run has no chain facts (step 7). */
  | { readonly kind: "record"; readonly mci: unknown; readonly deployment: DeploymentPin | null; readonly held?: string | null };

export interface GameContinuationFacts {
  readonly formats: ArtifactFormats;
  readonly identity: GameIdentityFacts;
  readonly money: MoneyFacts;
}

/* ------------------------------------------------------------------ */
/* The verdict                                                         */
/* ------------------------------------------------------------------ */

export type NotContinuedWhy =
  | "legacy-unpinned"
  | "malformed"
  | "newer-format"
  | "older-format"
  | "rules-not-supported"
  | "hosted-protocol"
  | "rules-not-certified"
  | "financial-protocol"
  | "settlement-codec"
  | "deployment-unavailable"
  | "deployment-unverified";

export type ConflictWhy = "deployment-conflict" | "identity-conflict" | "financial-record-missing";

export type ContinuationVerdict =
  | { readonly kind: "continues" }
  /** Derived: recomputed on every load, written nowhere. Route the game, or page an operator. */
  | { readonly kind: "not-continued"; readonly why: NotContinuedWhy; readonly detail: string }
  /** Durable: contradictory verified facts. The owning pool holds the game under `CONFLICT_HOLD_CODES[why]`. */
  | { readonly kind: "conflict"; readonly why: ConflictWhy; readonly detail: string };

/** The existing financial hold each conflict is recorded under (`FinancialHoldCode`, `server/src/escrow/moneyLifecycle.ts`).
 *  A `not-continued` verdict has no hold code on purpose. */
export const CONFLICT_HOLD_CODES: Readonly<Record<ConflictWhy, "binding-mismatch" | "continuation-incompatible" | "financial-record-missing">> =
  Object.freeze({
    "deployment-conflict": "binding-mismatch",
    "identity-conflict": "continuation-incompatible",
    "financial-record-missing": "financial-record-missing",
  });

/** What the chain itself reported for one deployment this run (`CHAIN_ATTESTED_FACT_FIELDS`). */
export interface ChainAttestedFacts {
  readonly code_checksum: string;
  readonly denom: string;
}

/** What this run learned from the chain: per deployment key, the facts the contract at that address reported. A key
 *  that is absent has not been read (the RPC is down, or verification has not run yet), and then no fact difference on
 *  it is ever a conflict. Filled by the escrow backend (L4-4); never from configuration.
 *
 *  THE CONTRACT FOR AN ENTRY, because a conflict is the one answer that writes a durable hold: it comes only from a
 *  VERIFICATION-GRADE read -- every configured endpoint answers the configured chain id and is not syncing, and when
 *  two or more endpoints are configured they agree (a quorum read, as "funded" is read) -- never from one failover
 *  answer, which a single lagging or rogue endpoint could supply. An entry that is not well formed (a checksum that is
 *  not 64 lowercase hex, a denom that is not a printable token) is treated as NOT READ: garbage can never conclude a
 *  conflict. */
export interface ContinuationRuntime {
  readonly chainFacts: ReadonlyMap<string, ChainAttestedFacts>;
}

/** How an unpinned (legacy) deal is treated: refused, unless a development server says otherwise by name. */
export interface ContinuationPolicy {
  readonly legacyLogs: ReplayPolicy["legacyLogs"];
}

const NOTHING_READ: ContinuationRuntime = Object.freeze({ chainFacts: new Map<string, ChainAttestedFacts>() });
const REFUSE_LEGACY: ContinuationPolicy = Object.freeze({ legacyLogs: "refuse" });
const CONTINUES: ContinuationVerdict = Object.freeze({ kind: "continues" });

const notContinued = (why: NotContinuedWhy, detail: string): ContinuationVerdict => Object.freeze({ kind: "not-continued", why, detail });
const CHAIN_CHECKSUM = /^[0-9a-f]{64}$/;
const CHAIN_DENOM = /^[\x21-\x7e]{1,128}$/;

/** The chain's facts for `key`, or undefined when there are none worth concluding on (absent or not well formed). */
function chainFactsFor(runtime: ContinuationRuntime, key: string): ChainAttestedFacts | undefined {
  const entry: unknown = runtime.chainFacts.get(key);
  if (typeof entry !== "object" || entry === null) return undefined;
  const facts = entry as { readonly code_checksum?: unknown; readonly denom?: unknown };
  if (typeof facts.code_checksum !== "string" || !CHAIN_CHECKSUM.test(facts.code_checksum)) return undefined;
  if (typeof facts.denom !== "string" || !CHAIN_DENOM.test(facts.denom)) return undefined;
  return { code_checksum: facts.code_checksum, denom: facts.denom };
}
const conflict = (why: ConflictWhy, detail: string): ContinuationVerdict => Object.freeze({ kind: "conflict", why, detail });
const list = (values: readonly (number | string)[]): string => (values.length === 0 ? "none" : values.join(", "));

function formatFailure(formats: ArtifactFormats): ContinuationVerdict | null {
  const classOf = (artifact: GameArtifact): FormatFact | undefined => {
    const fact = formats[artifact];
    if (fact === undefined) return undefined;
    /* Anything that is not one of the four classes is treated as damage: fail closed, still without a write. */
    return fact === "current" || fact === "newer" || fact === "older-unread" || fact === "corrupt" ? fact : "corrupt";
  };
  for (const artifact of GAME_ARTIFACTS) {
    if (classOf(artifact) === "newer") return notContinued("newer-format", `the game's ${artifact} is in a format newer than this pool reads`);
  }
  for (const artifact of GAME_ARTIFACTS) {
    if (classOf(artifact) === "older-unread") return notContinued("older-format", `the game's ${artifact} is in an older format this pool no longer reads`);
  }
  for (const artifact of GAME_ARTIFACTS) {
    if (classOf(artifact) === "corrupt") return notContinued("malformed", `the game's ${artifact} does not parse as a format this pool reads`);
  }
  return null;
}

/** A pin read from a stored record: the verdict never throws on stored bytes, it classifies them. */
function storedPin(pin: DeploymentPin): DeploymentPin | null {
  try {
    return servedDeployment(pin).pin;
  } catch {
    return null;
  }
}

/**
 * May the pool described by `capability` continue this game? Pure; fail-closed; never reads a build.
 *
 * `runtime.chainFacts` defaults to nothing read, so without the chain's own answer a fact difference is never a
 * conflict. `policy.legacyLogs` defaults to `refuse`, as on every production server (a pool always runs with it).
 */
export function continuationVerdict(
  game: GameContinuationFacts,
  capability: DeploymentCapability,
  runtime: ContinuationRuntime = NOTHING_READ,
  policy: ContinuationPolicy = REFUSE_LEGACY,
): ContinuationVerdict {
  const pool = deploymentCapability(capability);

  /* 1. Formats. */
  const formats = formatFailure(game.formats);
  if (formats !== null) return formats;

  /* 2. The deal. */
  const identity = game.identity;
  if (identity.kind === "malformed") return notContinued("malformed", identity.detail);
  if (identity.kind === "legacy") {
    if (game.money !== null) return notContinued("legacy-unpinned", "a money game's deal carries no rules pin; it is never continued unpinned");
    if (policy.legacyLogs !== "development-corpus") {
      return notContinued("legacy-unpinned", "the game was dealt before rules-engine versioning and carries no pin; it is not reinterpreted");
    }
    /* A legacy deal predates the hosted field, so it is hosted protocol 1 (OD-L4-1): admitted only where 1 is read. */
    if (!pool.hosted_protocols.includes(ABSENT_HOSTED_PROTOCOL)) {
      return notContinued("hosted-protocol", `an unpinned deal is hosted protocol ${ABSENT_HOSTED_PROTOCOL}; this pool reads ${list(pool.hosted_protocols)}`);
    }
    return CONTINUES;
  }

  /* 3. The dealt gameplay identity. */
  let dealt: GameContinuationIdentity | null = null;
  if (identity.kind === "dealt") {
    dealt = identity.gci;
    if (!pool.rules.supported.includes(dealt.rules_engine_version)) {
      return notContinued("rules-not-supported", `the game plays rules engine ${dealt.rules_engine_version}; this pool plays ${list(pool.rules.supported)}`);
    }
    if (!pool.hosted_protocols.includes(dealt.hosted_protocol)) {
      return notContinued("hosted-protocol", `the game was dealt under hosted protocol ${dealt.hosted_protocol}; this pool reads ${list(pool.hosted_protocols)}`);
    }
  }

  /* 4. Money present. */
  const money = game.money;
  if (money === null) return CONTINUES;
  if (money.kind === "missing") return conflict("financial-record-missing", "a money table has no financial record; it is never guessed at");
  if (money.kind === "placeholder") return notContinued("malformed", "the financial record is the held placeholder for a missing record; restore the original");

  /* 5. The money identity, by set membership (ESCROW-3A's reasons, in ESCROW-3A's order). */
  if (!isMoneyContinuationIdentity(money.mci)) return notContinued("malformed", "the stored continuation identity is not a v1 identity");
  const mci: MoneyContinuationIdentity = money.mci;
  if (!pool.rules.supported.includes(mci.rules_engine_version)) {
    return notContinued("rules-not-supported", `the game plays rules engine ${mci.rules_engine_version}; this pool plays ${list(pool.rules.supported)}`);
  }
  if (!pool.rules.certified.includes(mci.rules_engine_version)) {
    return notContinued("rules-not-certified", `rules engine ${mci.rules_engine_version} is not settlement-certified on this pool`);
  }
  if (!pool.hosted_protocols.includes(mci.hosted_protocol)) {
    return notContinued("hosted-protocol", `hosted protocol ${mci.hosted_protocol}; this pool reads ${list(pool.hosted_protocols)}`);
  }
  if (!pool.financial_protocols.includes(mci.financial_protocol)) {
    return notContinued("financial-protocol", `financial protocol ${mci.financial_protocol}; this pool speaks ${list(pool.financial_protocols)}`);
  }
  if (!pool.settlement_codecs.includes(mci.settlement_codec)) {
    return notContinued("settlement-codec", `settlement codec ${mci.settlement_codec} is not carried by this pool`);
  }

  /* 6. Agreement: the money identity is the deal's, and its codec is its deployment's. */
  if (dealt !== null && (dealt.rules_engine_version !== mci.rules_engine_version || dealt.hosted_protocol !== mci.hosted_protocol)) {
    return conflict(
      "identity-conflict",
      `the deal is rules ${dealt.rules_engine_version} / hosted ${dealt.hosted_protocol}; the money identity says rules ${mci.rules_engine_version} / hosted ${mci.hosted_protocol}`,
    );
  }
  if (money.deployment === null) return notContinued("malformed", "the money game has no pinned deployment");
  const pin = storedPin(money.deployment);
  if (pin === null) return notContinued("malformed", "the money game's pinned deployment is not a well-formed pin");
  if (mci.settlement_codec !== pin.codec) {
    return conflict("identity-conflict", `the money identity's codec is ${mci.settlement_codec}; its deployment speaks ${pin.codec}`);
  }

  /* 7. The deployment: served here; the chain's facts, where it was read; then the configured facts. */
  const key = deploymentKey(pin);
  const served = pool.escrow_deployments.find((deployment) => deployment.key === key);
  if (served === undefined) return notContinued("deployment-unavailable", `the game's escrow ${key} is not served by this pool`);
  const chain = chainFactsFor(runtime, key);
  if (chain !== undefined) {
    for (const field of CHAIN_ATTESTED_FACT_FIELDS) {
      if (chain[field] !== pin[field]) {
        return conflict("deployment-conflict", `the escrow at ${key} reports ${field}=${chain[field]} on chain; the game was bound with ${field}=${pin[field]}`);
      }
    }
  } else if (money.held === CONFLICT_HOLD_CODES["deployment-conflict"]) {
    /* L4-7: A VERIFIED CONFLICT DOES NOT DISAPPEAR WITH THE PROCESS. The chain's facts live for one run; the owning pool's
       hold for a deployment conflict is durable -- written the moment the conflict is learned, and superseding any
       weaker hold the record was under (`moneyLifecycle.ts`). A run that has not read this deployment at verification
       grade yet (a restart, an unreachable chain) cannot tell whether the contradiction that hold records still stands,
       so it does not continue the game -- DERIVED, written nowhere (never a second hold, never an intent hold: only a
       verification-grade read concludes a conflict). Once the chain is read, the facts decide as before: a contradiction
       is the conflict again; agreement continues the game (its money stays held until an operator's release, which
       itself needs an agreeing read). Any other hold is unaffected: gameplay continues while its money waits. */
    return notContinued(
      "deployment-unverified",
      `the game's escrow ${key} is held (${money.held}), and this run has not read that deployment at verification grade: it is not continued until the chain is read`,
    );
  }
  const differs = deploymentFactDifference(served.pin, pin);
  if (differs !== null) {
    const why = chain === undefined ? "the chain has not been read this run" : (CHAIN_ATTESTED_FACT_FIELDS as readonly string[]).includes(differs) ? "the chain agrees with the game, so the configuration is what is wrong" : "no chain read attests this fact";
    return notContinued("deployment-unverified", `the game's escrow ${key} was bound with ${differs}=${pin[differs]}; this pool is configured with ${differs}=${served.pin[differs]} (${why})`);
  }
  return CONTINUES;
}

/**
 * The identity a NEW deal is stamped with (L4-2 threads it into the stamp). A money game's deal is dealt under its
 * money identity's rules and hosted protocol -- committed on chain at `CreateGame` and hashed into the settlement
 * domain -- never under whatever this pool would give a new no-money table. A no-money deal takes the pool's current
 * rules and its highest hosted protocol. The caller has already asked `continuationVerdict`: this only says what to
 * stamp.
 */
export function dealingIdentity(capability: DeploymentCapability, money: MoneyContinuationIdentity | null): GameContinuationIdentity {
  if (money !== null) return gameplayIdentityOfMoney(money);
  const pool = deploymentCapability(capability);
  return gameContinuationIdentity(pool.rules.current, newDealHostedProtocol(pool));
}

/* ------------------------------------------------------------------ */
/* Serving across pools: the drain                                     */
/* ------------------------------------------------------------------ */

/** Owner direction: an old pool serves a no-money game that only it continues until the game is terminal, or until
 *  this long after the flip, whichever comes first. Seven days, in milliseconds (an integer). Money is never timed out. */
export const NO_MONEY_DRAIN_MS = 7 * 24 * 60 * 60 * 1000;

/** A pool's role (LIVE-5's `POOL#` status). `flipped_at` is when it stopped being the primary (ms since the epoch). */
export interface PoolServingState {
  readonly role: "primary" | "draining" | "retired";
  readonly flipped_at: number | null;
}

export interface ServedGameFacts {
  /** THIS pool's verdict for the game. */
  readonly verdict: ContinuationVerdict;
  readonly money: boolean;
  /** Gameplay has ended (the terminal seal). For a no-money game this ends the drain. */
  readonly terminal: boolean;
  /** Money only: the financial lifecycle is closed or cancelled, so nothing is left to sign, relay or watch. */
  readonly money_closed: boolean;
  /** The CURRENT PRIMARY's full verdict for the game (identity and, for money, its deployment served with the same
   *  facts), or null when this pool is the primary. Draining pools never claim a game, so the primary is the only
   *  pool a game can move to: "another live pool continues it" is exactly "the primary continues it". It must be the
   *  primary's OWN verdict -- its code classifying the game's artifacts against its own formats -- never this pool's
   *  facts run against the primary's capability: format facts are relative to the build that classified them, so an
   *  artifact this pool cannot read may be one the primary reads (LIVE-6 obtains it from the primary). */
  readonly primary_verdict: ContinuationVerdict | null;
}

/* `blocks_retirement` on every answer: whether this game still keeps a DRAINING pool from retiring (a primary never
   retires, a retired pool is gone). An open money game that no other pool will take blocks it whatever this pool's own
   verdict says -- held, damaged or served -- so no retirement can leave a funded game with no pool at all. */
export type ServeDecision =
  /** Serve here. `drain_deadline` bounds a draining pool's no-money game. */
  | { readonly kind: "serve"; readonly drain_deadline: number | null; readonly blocks_retirement: boolean }
  /** The primary continues it: the owning (draining) pool releases it, under its own fence, and the primary claims it at
   *  its next load. Derived. */
  | { readonly kind: "release"; readonly detail: string; readonly blocks_retirement: false }
  /** Not served here. `verdict` is this pool's when the verdict itself is the reason. */
  | {
      readonly kind: "decline";
      readonly why: "pool-retired" | "not-continued" | "conflict" | "drain-expired";
      readonly verdict: ContinuationVerdict | null;
      readonly detail: string;
      readonly blocks_retirement: boolean;
    };

/** When a draining pool stops serving the no-money games only it continues, or null if its flip time is not a time. */
export function noMoneyDrainDeadline(pool: PoolServingState): number | null {
  const flipped = pool.flipped_at;
  if (typeof flipped !== "number" || !Number.isSafeInteger(flipped) || flipped < 0) return null;
  const deadline = flipped + NO_MONEY_DRAIN_MS;
  return Number.isSafeInteger(deadline) ? deadline : null;
}

/**
 * Whether THIS pool serves the game now, and whether it holds a draining pool open. Pure: `now` is the caller's clock,
 * in milliseconds since the epoch (`Date.now()`). Re-evaluated per submit and on a timer by the caller (L4-2 / LIVE-6),
 * so a resident game cannot outlive its deadline unnoticed.
 *
 *   - a retired pool serves nothing;
 *   - the primary serves everything it continues, with no deadline, and declines (never writes) the rest;
 *   - a draining pool RELEASES every game the primary continues -- including one it cannot read itself any more
 *     (a derived `not-continued` here) -- except one it has found in CONFLICT, which the operator must resolve first.
 *     It keeps the rest:
 *       money      served until its lifecycle closes -- no timer, ever; and an open money game it keeps, served or
 *                  not (held, damaged), blocks its retirement, so it never strands a funded game;
 *       no-money   served until terminal, or until `flipped_at + NO_MONEY_DRAIN_MS`, whichever is first; at the
 *                  deadline exactly it is expired. A terminal game is still shown while the pool lives, and holds nothing.
 *
 * Fail-closed where the clock cannot be trusted: a draining pool with no valid flip time, or a `now` that is not a
 * finite number, serves no non-terminal no-money game -- and still serves every money game, which no clock decides.
 */
export function serveDecision(game: ServedGameFacts, pool: PoolServingState, now: number): ServeDecision {
  if (pool.role === "retired") return Object.freeze({ kind: "decline", why: "pool-retired", verdict: null, detail: "this pool is retired", blocks_retirement: false });
  const verdict = game.verdict;
  const declined = (reason: Exclude<ContinuationVerdict, { readonly kind: "continues" }>, blocks: boolean): ServeDecision =>
    Object.freeze({ kind: "decline", why: reason.kind === "conflict" ? "conflict" : "not-continued", verdict: reason, detail: reason.detail, blocks_retirement: blocks });
  if (pool.role === "primary") {
    return verdict.kind === "continues" ? Object.freeze({ kind: "serve", drain_deadline: null, blocks_retirement: false }) : declined(verdict, false);
  }

  /* Draining. */
  const openMoney = game.money && !game.money_closed;
  if (verdict.kind !== "conflict" && game.primary_verdict !== null && game.primary_verdict.kind === "continues") {
    return Object.freeze({ kind: "release", detail: "the primary continues this game; it moves there", blocks_retirement: false });
  }
  if (verdict.kind !== "continues") return declined(verdict, openMoney);
  if (game.money) return Object.freeze({ kind: "serve", drain_deadline: null, blocks_retirement: openMoney });
  if (game.terminal) return Object.freeze({ kind: "serve", drain_deadline: null, blocks_retirement: false });
  const deadline = noMoneyDrainDeadline(pool);
  if (deadline === null) {
    return Object.freeze({ kind: "decline", why: "drain-expired", verdict: null, detail: "this pool's flip time is not known, so its no-money drain cannot be bounded", blocks_retirement: false });
  }
  if (typeof now !== "number" || !Number.isFinite(now)) {
    return Object.freeze({ kind: "decline", why: "drain-expired", verdict: null, detail: "the clock is not a time, so the no-money drain cannot be checked", blocks_retirement: false });
  }
  if (now < deadline) return Object.freeze({ kind: "serve", drain_deadline: deadline, blocks_retirement: true });
  return Object.freeze({ kind: "decline", why: "drain-expired", verdict: null, detail: `the no-money drain ended at ${new Date(deadline).toISOString()} (7 days after the flip)`, blocks_retirement: false });
}
