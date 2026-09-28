// frontend/src/gameEngine/protocolVersions.ts
//
// ==================================================================
//  LIVE-4 (L4-1): THE VERSION AXES BESIDE THE RULES ENGINE -- HOSTED, FINANCIAL AND CLIENT PROTOCOL
// ==================================================================
//
// `RULES_ENGINE_VERSION` (`rulesVersion.ts`) says which program a game's log is. Three more hand-bumped integers say
// what else two builds must agree on before one may continue what the other wrote, or talk to what the other serves.
// Each is its own axis, with its own changelog, and none of them is a build id:
//
//   HOSTED_PROTOCOL_VERSION     the meaning of a game's durable history OUTSIDE the reducer, and the formats of its
//                               per-game non-financial artifacts. Per game: stamped into the deal (LIVE-4 L4-2).
//   FINANCIAL_PROTOCOL_VERSION  the meaning and format of every durable financial artifact of a money game, and every
//                               decision rule of its money lifecycle. Per money game: frozen in its continuation
//                               identity (`18COSMOS/MONEY-CONTINUATION/v1`) at creation.
//   CLIENT_PROTOCOL_VERSION     the wire between a bundle and a server: frame kinds and fields on both sockets, close
//                               codes, the `/gs/api/*` routes and bodies. Per connection, never per game.
//
// The settlement codec (`18JUNO/v1`) is a fifth axis with its own identity string (`escrowCodec.ts`); certifying a new
// rules version for settlement is a literal of its own (`SETTLEMENT_CERTIFIED_RULES_ENGINE_VERSIONS`). Neither is here.
//
// THEY LIVE HERE, BESIDE THE RULES CHANGELOG, because both sides read them: the server stamps and checks them, the
// browser announces the client protocol, and the canonical compatibility model (`compat/`) reads all of them. Before
// LIVE-4 the hosted and financial constants lived in `server/src/escrow/moneyContinuation.ts`, which re-exports them
// unchanged, so no importer moved. Moving a constant is not a bump: the values below are exactly the ones ESCROW-4
// closed with (hosted 1, financial 3).
//
// ------------------------------------------------------------------
//  THE BUMP QUESTION IS ASKED IN BOTH DIRECTIONS (LIVE-4 preflight D4-17)
// ------------------------------------------------------------------
//
// Every semantic change answers two questions, not one:
//
//   1. BACKWARDS. Would the new build read an old durable artifact differently -- replay it to another board, read
//      its stored bytes into another committed view, decide its money another way -- or be unable to read it?
//   2. FORWARDS. Could an OLDER build carrying the SAME semantic versions misread an artifact the new build can now
//      write -- a field it ignores, a value it reads as the nearest one it knows, a shape it holds as corrupt?
//
// Either answer "yes" bumps the axis the artifact belongs to. The second question is the one exact build pinning used
// to hide: while every deploy was its own island, nothing older ever read anything newer. Under LIVE-4 two builds with
// equal versions continue each other's games -- a rolling replacement, a same-pool rollback, a stale tab -- so EQUAL
// VERSIONS (and so an equal capability key, `compat/deploymentCapability.ts`) must mean MUTUALLY readable and
// continuable, not merely "the new one can read the old". A bump no reader needed is cheap; a missed one is a game
// silently reinterpreted.
//
// A CHANGELOG ROW IS THE BUMP. Each constant equals the `version` of its changelog's last row, and a test pins it
// (`live4CanonicalModel.test.ts`). The number is meaningless without the row that says what moved and why, in the
// same way as `RULES_ENGINE_CHANGELOG`.

/** One row: the version, and what it means. */
export interface ProtocolChangelogRow {
  readonly version: number;
  readonly note: string;
}

/* ------------------------------------------------------------------ */
/* Hosted protocol                                                     */
/* ------------------------------------------------------------------ */

/** The hosted (history) protocol this build reads and writes. A deal that carries no `hosted_protocol` field was dealt
 *  under 1 (every game dealt before LIVE-4). Bump it, with a row below, when two servers could read the same durable
 *  bytes of a game differently outside the reducer, or could not read or write each other's per-game artifacts --
 *  whichever of them wrote the bytes. Do NOT bump it for the reducer (that is the rules engine) or for the wire (the
 *  client protocol).
 *
 *  A restore change that only adds or removes a HOLD CONDITION is not a bump either, but it is not free: a same-key
 *  rollback re-applies the older condition, which may durably re-hold games the newer one released, so a store scan
 *  (`gamesDoctor compat`, L4-6) runs before such a deploy and before its rollback (preflight §4.2).
 *
 *  ONE THING EVERY HOSTED PROTOCOL MUST KEEP, in both directions: the deal carries an integer `rules_engine_version` and
 *  a positive-integer `hosted_protocol` (or none, for 1). That is how an older pool tells a newer deal from a damaged
 *  one (`compat/continuationIdentity.ts`): a later protocol that restructured the deal would be read as `malformed` by
 *  every older pool rather than as `hosted-protocol`, and today's reconcile would hold it (`rules-pin-mismatch`). */
export const HOSTED_PROTOCOL_VERSION = 1;

export const HOSTED_PROTOCOL_CHANGELOG: ReadonlyArray<ProtocolChangelogRow> = Object.freeze([
  Object.freeze({
    version: 1,
    note:
      "LIVE-2 / LIVE-3, as it stands at ESCROW-4 (031593e): a game's server-owned history is the append-only log " +
      "and its commit protocol (LIVE-3A/3B); the server-built deal, whose rules pin the server stamps over any " +
      "client value (its `build` is historical only); the terminal seal and the sealed prefix (`sealOf`, " +
      "`sealedPrefix`); the ingress reads of the raw log (seed reuse by turn key after an undo, #1051); the " +
      "restore's reading of the log into the committed view and the GameRecord's log-implied fields; and the " +
      "GameRecord at `record_schema: 1` for every no-money table, with `protocol_version: null`. ESCROW-4's " +
      "money-only `record_schema: 2` travels with financial protocol 3 and does not move this axis. Every game " +
      "dealt so far is protocol 1, and a deal that carries no `hosted_protocol` field is read as 1 (LIVE-4 " +
      "OD-L4-1).",
  }),
]);

/* ------------------------------------------------------------------ */
/* Financial protocol                                                  */
/* ------------------------------------------------------------------ */

/** The money lifecycle protocol: the meaning and format of EVERY durable financial artifact of a game (the financial
 *  record, its chain intents and attempts, the wallet-ticket ledger) and every decision rule of its money lifecycle
 *  (LIVE-4 preflight §4.3). No money game was ever created under 1 or 2 (money games were disabled until ESCROW-4), so
 *  no bump so far strands anything and none carries migration machinery: an artifact of an older protocol is refused
 *  (the continuation verdict, the stores' exact-shape readers), never reinterpreted. From the first production money
 *  game on, a bump means a drain: the old pool serves its games until they close. */
export const FINANCIAL_PROTOCOL_VERSION = 3;

export const FINANCIAL_PROTOCOL_CHANGELOG: ReadonlyArray<ProtocolChangelogRow> = Object.freeze([
  Object.freeze({
    version: 1,
    note:
      "ESCROW-3A: the financial record, the money continuation identity frozen at creation, and the settlement " +
      "seam keyed by (gameId, seal.log_len). No money game was ever created under it.",
  }),
  Object.freeze({
    version: 2,
    note:
      "ESCROW-3B: record v2 (the money binding, the frozen roster, the post-intent chain phases) and chain " +
      "intents persisted before broadcast; as of 6f05c80 it also carried ESCROW-JOIN's grant " +
      "`admitted_until_secs` and its no-supersede-while-admitted rule (shipped under 2; retired by 3).",
  }),
  Object.freeze({
    version: 3,
    note:
      "ESCROW-4: the ticket file's v3 grants (the persisted ADR-036 wallet-control proof, registered consent keys, " +
      "the relink origin and the CreateGame discovery floor) and their rules (proof-gated admission, R-J1, the " +
      "exact link refusals, relink of a seat's own deposit); the relayed CONSENT / ANNUL chain intents and their " +
      "key-suffixed instances; W-13's quorum-checked host binding; the close of a table that ended unbound; and " +
      "the money GameRecord (`record_schema: 2`, written for money tables only -- no-money records stay exactly " +
      "schema 1, so the hosted protocol does not move). A protocol-2 grant file is refused, never reinterpreted.",
  }),
]);

/* ------------------------------------------------------------------ */
/* Client protocol                                                     */
/* ------------------------------------------------------------------ */

/** A socket that announces no client protocol at all: a pre-LIVE-4 bundle (LIVE-4 OD-L4-1). It keeps exactly the
 *  treatment it has today -- the exact build comparison on `submit`, answered `build-skew` -- and it is never sent a
 *  LIVE-4 answer it does not know (`reload`, `route`, close 4426), because such a bundle would reconnect-loop on it. */
export const LEGACY_CLIENT_PROTOCOL = 0;

/** The client protocol a LIVE-4 bundle announces at the upgrade. Declared here by L4-1; first SPOKEN when L4-3 wires
 *  the announcement and its answers. Bump it when a client -> server frame, field or route is removed, made required
 *  or changes meaning, when a server -> client frame changes meaning, or when a correct client must understand a new
 *  server frame. An additive server -> client field, a frame a tolerant client may ignore, and a new client -> server
 *  frame or route shipped server-first are not bumps. */
export const CLIENT_PROTOCOL_VERSION = 1;

export const CLIENT_PROTOCOL_CHANGELOG: ReadonlyArray<ProtocolChangelogRow> = Object.freeze([
  Object.freeze({
    version: 0,
    note:
      "The legacy wire, as it stands at ESCROW-4 (031593e): nothing is announced at the upgrade; frames carry " +
      "`build`, which the server compares only on `submit` (`build-skew`); the log and room channels' frames and " +
      "close codes as LIVE-2D/2A/3A left them; the `/gs/api/*` routes, the ESCROW-4 money routes included " +
      "(server-first). A socket that announces nothing is protocol 0 and keeps exactly this treatment; it is " +
      "never sent `reload`, `route` or close 4426 (OD-L4-1). Retired once the first production bundle ships.",
  }),
  Object.freeze({
    version: 1,
    note:
      "LIVE-4 (declared by L4-1; spoken once L4-3 wires it): everything in protocol 0, plus the announcement at " +
      "the upgrade -- `cp` (this version), `cr` (the bundle's supported rules engines; required from protocol 1 " +
      "on) and `cb` (the bundle's build, diagnostic only) -- and the answers a protocol-1 client treats as terminal " +
      "for its link: `reload` (client-protocol, client-rules, client-announcement), `route` (the client half; " +
      "LIVE-6 adds the server half) and close 4426; an explicit `error` case on the log channel, after which an " +
      "unknown server frame is ignored rather than treated as an error (F-L4-7).",
  }),
]);

/** The client protocol THIS build's bundle actually announces. The legacy protocol today: the bundle sends no
 *  announcement until L4-3 wires it, and then this becomes `CLIENT_PROTOCOL_VERSION`. The preflight's invariant (§5.1:
 *  the accepted set includes the release's own bundle's protocol) is kept against THIS constant, so a bundle can never
 *  ship announcing a protocol its own server does not accept. */
export const ANNOUNCED_CLIENT_PROTOCOL: number = LEGACY_CLIENT_PROTOCOL;

/** The client protocols a server of THIS build serves: the canonical capability's `client_protocols`. Only the legacy
 *  protocol today, because this build parses no announcement -- every socket is treated as protocol 0, exactly as
 *  before LIVE-4. L4-3 adds `CLIENT_PROTOCOL_VERSION` in the same change that implements the announcement and its
 *  answers: a protocol is listed only once this build completely implements it (LIVE-4 preflight §5.1, "listed ⇒
 *  implemented"), and retiring protocol 0 later is a change to this list, so it moves the capability key. */
export const ACCEPTED_CLIENT_PROTOCOLS: readonly number[] = Object.freeze([LEGACY_CLIENT_PROTOCOL]);
