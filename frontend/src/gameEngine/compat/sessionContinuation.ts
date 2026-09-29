// frontend/src/gameEngine/compat/sessionContinuation.ts
//
// ==================================================================
//  LIVE-4 (L4-2): WHAT A ROOM SESSION ASKS BEFORE IT INTERPRETS A LOG -- AND WHAT IT SAYS WHEN THE ANSWER IS NO
// ==================================================================
//
// `RoomSession` asks the canonical verdict (`continuationVerdict.ts`) every time it (re)interprets its log: at
// construction, at every restore, revert, discard and rollback, before a single entry is applied -- and again before a
// deal is stamped. It asks UNCONDITIONALLY: nothing about the dealing server's identity decides whether the question is
// put. (Before LIVE-4 the only money check ran when two build strings differed, #1252, so equal strings skipped it.)
//
// WHO ANSWERS. A hosted server hands its sessions its POOL'S hook (`SessionContinuation`, `server/src/
// continuationWiring.ts`): the pool's capability, the game's money facts from the settlement index, and the pool's
// serving decision (`serveDecision`). Every other caller -- a replay or operator tool, a certification game, the
// browser's re-derivation of a settlement -- has no pool behind it, and gets the GAMEPLAY half from this module: this
// code's own rules engine and hosted protocol, nothing money (such a caller serves no escrow, so no money answer is its
// to give) and nothing about serving (it serves nobody). For every log that existed before LIVE-4 that is exactly
// today's `replayCompatibility` + `replayRefusal`: a pinned deal this engine supports continues, any other pin is not
// continued, an unpinned deal follows the stated legacy policy.
//
// WHAT A "NO" IS. Derived, always: recomputed on every load and written nowhere -- no hold file, no record change, no
// financial transition. The session keeps a seeded engine (nothing interpreted), answers every hello and submit with
// the `incompatible` frame (its `why` added in L4-2 -- an additive field old clients ignore), and serves no history.
// Money CONFLICTS are durable in the canonical model, but writing them is L4-4's (the owning pool, under
// `CONFLICT_HOLD_CODES`); here a conflict is not served, like any other "no", and nothing is written.
//
// THE LOG'S OWN FORMAT FACT (T-25, the forward direction). The session is the reader of the game's log, so it is the
// one that classifies the log's format for the verdict: a PINNED log carrying something this build cannot have written
// -- a message kind it does not know, or a deal whose `variants.rules` revision is above its own -- was written by a
// newer build, and is `newer-format` (derived: route, never hold) instead of being misread by this reducer (whose
// default arm advances the seat on an unknown kind, and which reads an unknown revision as the nearest one it knows).
// See `logFormatOf`.

import { ACCEPTED_CLIENT_PROTOCOLS, HOSTED_PROTOCOL_VERSION } from "../protocolVersions";
import {
  RULES_ENGINE_VERSION,
  RULES_ENGINE_VERSION_FIELD,
  SUPPORTED_RULES_ENGINE_VERSIONS,
  replayRefusal,
  stampRulesEngineVersion,
  type ReplayCompatibility,
  type ReplayPolicy,
} from "../rulesVersion";
import { effectiveActions } from "../logRevert";
import type { ReplayEntry } from "../replayLog";
import { GAMEPLAY_MESSAGE_SCHEMA, hasOwn } from "../messageSchema";
import { CURRENT_RULES_REVISION } from "../gameVariants";
import { HOSTED_PROTOCOL_FIELD, type GameContinuationIdentity, type GameIdentityFacts } from "./continuationIdentity";
import { continuationVerdict, type ArtifactFormats, type ContinuationVerdict, type FormatFact, type ServeDecision } from "./continuationVerdict";
import { DEPLOYMENT_CAPABILITY_FORMAT, deploymentCapability, type DeploymentCapability } from "./deploymentCapability";

/* ------------------------------------------------------------------ */
/* The hook a hosted server gives its sessions                         */
/* ------------------------------------------------------------------ */

/** What a new deal is stamped with, or why this pool may not deal the table. */
export type DealingAnswer =
  | { readonly ok: true; readonly identity: GameContinuationIdentity }
  | { readonly ok: false; readonly reason: string };

/** A pool's answers for ONE game, handed to that game's session (`RoomSessionOptions.continuation`). */
export interface SessionContinuation {
  /** This pool's verdict for the game whose deal the session's effective log carries (`gameIdentityOfEntries`), and
   *  whose log the session -- its reader -- classified (`logFormatOf`, T-25). The caller supplies everything else the
   *  verdict reads -- the record's format, the money facts, the capability, the chain facts, the legacy policy. Pure
   *  from the session's point of view; never throws. */
  verdict(identity: GameIdentityFacts, log: FormatFact): ContinuationVerdict;
  /** The dealing identity (`dealingIdentity`): a no-money deal takes the pool's current rules and highest hosted
   *  protocol; a money deal its money identity's. Asked only when a deal is about to be stamped. */
  dealing(): DealingAnswer;
  /** Whether the pool serves the game NOW (`serveDecision`), given this pool's verdict and whether the board has ended.
   *  Absent: served whenever the verdict continues. Asked after every rebuild, before every submit (it carries the
   *  clock) and by the actor's serving review, so a resident game cannot outlive a drain deadline unnoticed. */
  serving?(input: { readonly verdict: ContinuationVerdict; readonly ended: boolean }): ServeDecision;
}

/* ------------------------------------------------------------------ */
/* The dealing identity, stamped                                       */
/* ------------------------------------------------------------------ */

/** The two fields a new deal is stamped with (a `GameContinuationIdentity`'s, from `SessionContinuation.dealing`). */
export interface DealingStamp {
  readonly rules_engine_version: number;
  readonly hosted_protocol: number;
}

/**
 * LIVE-4 (L4-2): THE DEAL CARRIES ITS SEMANTIC DEALING IDENTITY -- STAMPED BY THE SERVER, NEVER CLAIMED BY A CLIENT
 * (`serverIngress.ts` `normalizeForCommit` calls this for every deal). `rules_engine_version` (#1520) and
 * `hosted_protocol` are facts about the pool that dealt, written over whatever the message carried: a client's
 * `hosted_protocol` is dropped in every case, so the only way the field reaches a log is this stamp. With no dealing
 * identity (a session no pool configured) the deal is stamped exactly as before LIVE-4 -- this engine's rules pin
 * (`stampRulesEngineVersion`) and no hosted field, which every reader takes as protocol 1. The reducer reads neither
 * new field (its `SetupGame` arm reads `players`, `variants` and the rules pin only), so no board, digest or replay
 * moves; `build` is left exactly as the server built it -- historical and diagnostic, never a continuation input.
 */
export function stampDealingIdentity<T extends { SetupGame: Record<string, unknown> }>(msg: T, dealing: DealingStamp | undefined): T {
  const { [HOSTED_PROTOCOL_FIELD]: _claimed, ...body } = msg.SetupGame;
  if (dealing === undefined) return stampRulesEngineVersion({ ...msg, SetupGame: body });
  return {
    ...msg,
    SetupGame: { ...body, [RULES_ENGINE_VERSION_FIELD]: dealing.rules_engine_version, [HOSTED_PROTOCOL_FIELD]: dealing.hosted_protocol },
  };
}

/* ------------------------------------------------------------------ */
/* The gameplay half, for a session no pool configured                 */
/* ------------------------------------------------------------------ */

/** The formats a session with no pool behind it can vouch for: the log it was given, and no record (a caller that
 *  hands a session a log has read it, and nothing else is in play). */
export const LOCAL_FORMATS: ArtifactFormats = Object.freeze({ record: "current", log: "current" });

let localCapability: DeploymentCapability | null = null;

/**
 * This code's GAMEPLAY capability: the rules engine it deals and replays, the hosted protocol it reads and writes --
 * and no money at all (no financial protocol, codec, contract code or escrow deployment; nothing settled). The key of
 * this descriptor names no pool; it is what a session answers with when nobody told it which pool it belongs to.
 */
export function localGameplayCapability(): DeploymentCapability {
  if (localCapability === null) {
    localCapability = deploymentCapability({
      format: DEPLOYMENT_CAPABILITY_FORMAT,
      rules: { current: RULES_ENGINE_VERSION, supported: SUPPORTED_RULES_ENGINE_VERSIONS, certified: [] },
      hosted_protocols: [HOSTED_PROTOCOL_VERSION],
      financial_protocols: [],
      settlement_codecs: [],
      escrow_abi_checksums: [],
      escrow_deployments: [],
      client_protocols: ACCEPTED_CLIENT_PROTOCOLS,
    });
  }
  return localCapability;
}

/** The gameplay verdict with no pool behind it: `continuationVerdict` over the local capability, no money facts. `log`
 *  is the log's own format fact (`logFormatOf`); `current` when the caller has none. */
export function localContinuationVerdict(identity: GameIdentityFacts, policy: Pick<ReplayPolicy, "legacyLogs">, log: FormatFact = "current"): ContinuationVerdict {
  const formats: ArtifactFormats = log === "current" ? LOCAL_FORMATS : { ...LOCAL_FORMATS, log };
  return continuationVerdict({ formats, identity, money: null }, localGameplayCapability(), undefined, { legacyLogs: policy.legacyLogs });
}

/* ------------------------------------------------------------------ */
/* T-25: the forward direction -- a pinned log this build would misread */
/* ------------------------------------------------------------------ */

/**
 * LIVE-4 (L4-2), T-25: DEFENCE IN DEPTH FOR THE FORWARD DIRECTION (preflight D4-17, F-L4-9). The bump rubric says a
 * build that can WRITE something an older build with the same pin would misread must bump the rules engine. If that
 * discipline slips, the older build must not quietly misread the log -- the reducer does not refuse what it does not
 * know: its default arm ADVANCES THE SEAT on an unknown message kind, and `sellBuySellInForce` reads any revision above
 * one as revision one. So the log's reader classifies it here, and a log this build cannot have written is `newer`:
 *
 *   - an effective entry whose payload names a message kind this build's closed schema does not declare
 *     (`GAMEPLAY_MESSAGE_SCHEMA`: every kind any v11 server has accepted at ingress or derived itself -- the table has
 *     not lost a kind since v11 existed, and every server-appended kind is in it);
 *   - a deal whose `variants.rules` is a revision above this build's `CURRENT_RULES_REVISION` (every hosted deal is
 *     stamped with the dealing server's own revision, `roomService.ts` `buildSetupGame`, and a client may not name one
 *     at create).
 *
 * PINNED LOGS ONLY. An unpinned (legacy) log is the development corpus's, where the default arm's old behaviour IS the
 * recorded game: it is left exactly as it replays today (and refused anyway outside a development server). A payload
 * that is not a JSON object is left to the replay's own corruption handling, as before; nothing here holds anything.
 * The answer is a format FACT: the canonical verdict reads it first and answers `not-continued/newer-format` --
 * derived, routed to the pool that wrote it, never a hold. A log that passes is replayed byte for byte as before.
 */
export function logFormatOf(entries: readonly ReplayEntry[], identity: GameIdentityFacts): FormatFact {
  if (identity.kind !== "dealt") return "current";
  for (const entry of effectiveActions(entries)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(entry.payload);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
    for (const kind of Object.keys(parsed)) {
      if (!hasOwn(GAMEPLAY_MESSAGE_SCHEMA, kind)) return "newer";
    }
    if (hasOwn(parsed, "SetupGame") && dealFormatOf((parsed as { SetupGame: unknown }).SetupGame) === "newer") return "newer";
  }
  return "current";
}

/** T-25's deal half, which a deal line alone answers (discovery asks it of a log's first line): `newer` when the deal
 *  names a `variants.rules` revision above this build's own. Only meaningful for a pinned deal (the caller checks). */
export function dealFormatOf(setup: unknown): FormatFact {
  if (typeof setup !== "object" || setup === null || !hasOwn(setup, "variants")) return "current";
  const variants: unknown = (setup as { variants: unknown }).variants;
  if (typeof variants !== "object" || variants === null || !hasOwn(variants, "rules")) return "current";
  const rules: unknown = (variants as { rules: unknown }).rules;
  return typeof rules === "number" && Number.isFinite(rules) && rules > CURRENT_RULES_REVISION ? "newer" : "current";
}

/* ------------------------------------------------------------------ */
/* A history this pool does not read                                   */
/* ------------------------------------------------------------------ */

/**
 * The derived reasons that say this pool cannot READ the game's history at all -- another hosted protocol (what the
 * history means outside the reducer), a format a newer or an older build wrote. Under them the pool must not judge
 * the history either: the reconcile table's record-against-log checks (foreign actor, deal misplaced, ...) read that
 * history under THIS pool's meaning, and a durable hold concluded from a misreading would freeze the game for the pool
 * that does continue it. Discovery and the load skip those checks for these reasons (derived, nothing written). The
 * other derived reasons keep them: a game this pool reads but does not continue (another rules engine under the same
 * hosted protocol, a money reason, a serving decision) is read the same way by its own pool, and a malformed deal is
 * exactly what those checks exist for.
 */
export const HISTORY_NOT_READ_HERE: readonly string[] = Object.freeze(["hosted-protocol", "newer-format", "older-format"]);

/** Whether this verdict says the pool cannot read the game's history (`HISTORY_NOT_READ_HERE`). */
export function historyNotReadHere(verdict: ContinuationVerdict | null | undefined): boolean {
  return verdict !== null && verdict !== undefined && verdict.kind === "not-continued" && HISTORY_NOT_READ_HERE.includes(verdict.why);
}

/* ------------------------------------------------------------------ */
/* What the player reads                                               */
/* ------------------------------------------------------------------ */

/**
 * The player-facing sentence for a verdict that does not continue (the `incompatible` frame's `reason`). The two
 * cases #1520 already worded keep their words exactly -- an unsupported rules pin and an unpinned deal -- so every
 * client, test and runbook that knows them reads the same text. The operator's detail (the verdict's `detail`) goes to
 * the server's window, never to a player.
 */
export function notContinuedSentence(verdict: Exclude<ContinuationVerdict, { readonly kind: "continues" }>, compatibility: ReplayCompatibility, policy: ReplayPolicy): string {
  if (verdict.kind === "conflict") {
    return "This table's records disagree with each other, so it is paused until the server's operator looks at it. Its deposits and the game so far are untouched.";
  }
  switch (verdict.why) {
    case "rules-not-supported":
      if (compatibility.kind === "incompatible") return replayRefusal(compatibility, policy) as string;
      return "This game was dealt under a rules engine this server does not run. It cannot be continued here without reinterpreting its history, so it is left untouched.";
    case "legacy-unpinned":
      return (
        replayRefusal({ kind: "legacy" }, { ...policy, legacyLogs: "refuse" }) ??
        "This game was dealt before rules-engine versioning and carries no version. It is not reinterpreted under the current rules."
      );
    case "hosted-protocol":
      return "This game was recorded under a game-server protocol this server does not read. It cannot be continued here without reinterpreting its history, so it is left untouched.";
    case "malformed":
      /* A deal whose server-stamped fields are not versions, a financial record that is damaged or the held
         placeholder, or a pool that could not answer: said once, for all of them. */
      return "This game's records could not be checked on this server, so it is not continued here. It is left untouched.";
    case "newer-format":
    case "older-format":
      return "This game was saved by a different version of the game server, which this server cannot read. It is left untouched.";
    case "rules-not-certified":
    case "financial-protocol":
    case "settlement-codec":
      return "This table's escrow terms belong to a version of the game server that this one cannot settle, so it is not continued here. Its deposits and the game so far are untouched.";
    case "deployment-unavailable":
    case "deployment-unverified":
      return "This table's escrow is not served by this game server, so it is not continued here. Its deposits and the game so far are untouched.";
  }
  return "This game cannot be continued on this server. It is left untouched.";
}

/** The player-facing sentence for a serving decision that is not `serve` and whose reason is not the verdict. */
export function notServedSentence(decision: Exclude<ServeDecision, { readonly kind: "serve" }>): string {
  if (decision.kind === "release") return "This game now continues on the newer game server. It is kept exactly as it was.";
  switch (decision.why) {
    case "drain-expired":
      return "This game server stopped continuing games like this one seven days after a newer server took over. The game is kept exactly as it was.";
    case "pool-retired":
      return "This game server has been retired. The game is kept exactly as it was.";
    default:
      return "This game cannot be continued on this server. It is left untouched.";
  }
}
