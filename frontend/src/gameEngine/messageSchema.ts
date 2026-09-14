// frontend/src/gameEngine/messageSchema.ts
//
// ==================================================================
//  DESIGN NOTE 1449: THE SHAPE OF A MESSAGE IS NOT THE LEGALITY OF A MOVE
// ==================================================================
//
// WHAT THIS FILE IS. The structural contract of every gameplay message, checked at runtime, so that what
// reaches `RoomSession.submit` is a `GameplayExecuteMsg` in fact and not merely by assertion.
//
// WHAT IT WAS BEFORE. `gameServer.ts` read `JSON.parse(String(raw)) as ClientFrame` and handed `frame.msg`
// straight to the session. A cast is a promise the compiler believes and the wire has never heard of.
// Measured against a live `RoomSession`, every one of these was answered `applied` and appended a permanent
// entry to the room's log:
//
//     {}                                  {Nonsense: {}}            {BuyStock: {}}
//     []                                  {BuyStock:{protocol_id:"x"}}   {BuyStock:{protocol_id:NaN}}
//     {SellStock:{percentage:Infinity}}   {LayTile:{q:1.5,r:"x"}}   two discriminants in one object
//
// The log is the game (#1160) and `logHash` commits over it (#1251), so a malformed frame did not merely
// get ignored -- it became part of the room's history and its commitment. The only thing standing between a
// stranger and that was the turn gate refusing them for an unrelated reason.
//
// ------------------------------------------------------------------
//  WHERE THE LINE IS DRAWN, AND WHY IT IS DRAWN THERE
// ------------------------------------------------------------------
//
// THIS LAYER ANSWERS ONE QUESTION: "is this a message at all?" A known discriminant, exactly one of them,
// with fields of the declared kinds. It does not know what a corporation is, what a turn is, or what the
// board looks like, and it must never learn -- 1830 is the reducer's, and a rule asked in two places is
// #1184's shape, which this project has paid for four times.
//
// SO A STRUCTURALLY VALID BUT ILLEGAL MOVE PASSES HERE AND IS REFUSED BY THE REDUCER. Buying a share you
// cannot afford, laying a tile that does not fit, running a route that does not connect: all well-formed
// messages, all the reducer's to refuse. What this stops is the frame that is not a move at all.
//
// UNKNOWN FIELDS ARE ALLOWED THROUGH. The table below was built from the DECLARED types and then checked
// against every message in every stored log -- and the logs carried fields the declarations do not mention
// (`RunMultipleRoutes` sends `trains` and `train_indices`; `LayTile` sends `token_cities`). Rejecting an
// unrecognised field would therefore have refused real traffic on the strength of an incomplete list, which
// is a worse failure than the one being fixed. Tightening this to a closed field set is a later decision
// with its own evidence; it is deliberately not taken here.
//
// NO BOUNDS ARE INVENTED. There is no maximum price, no maximum hex, no array length cap. The protocol does
// not supply one and a number this file made up would be a rule -- see the note on transport limits at the
// foot of the file.
//
// PURE AND SERVER-SAFE: no React, no DOM, no game state, no I/O. It lives in the engine because the message
// shapes are the engine's protocol; the server is what ENFORCES it, before `RoomSession.submit`.

/* ------------------------------------------------------------------ */
/* The field vocabulary                                               */
/* ------------------------------------------------------------------ */

/** A field's declared kind. `?` suffix marks it optional -- absent is fine, present must still be right.
 *
 *  `int` IS NOT `number`. Protocol fields that index a corporation, a hex or a log entry are integers, and
 *  `1.5` in one of them is as malformed as `"x"` -- it was `q: 1.5` that got through before this existed.
 *  Every numeric kind also excludes `NaN` and `Infinity`: `JSON.parse` cannot produce them, but a message
 *  can reach `submit` from a test or a future non-JSON transport, and `Number.isFinite` costs nothing. */
type FieldKind =
  | "int"
  | "finite"
  | "string"
  | "bool"
  | "string|null"
  | "int|null"
  | "array"
  | "object"
  | `enum:${string}`;

type FieldSpec = FieldKind | `${FieldKind}?`;

/** `Record<string, never>` on the wire: a body that must be an object and carries nothing this file names. */
const EMPTY: Readonly<Record<string, FieldSpec>> = {};

function checkField(value: unknown, spec: FieldSpec): string | null {
  const optional = spec.endsWith("?");
  const kind = (optional ? spec.slice(0, -1) : spec) as FieldKind;

  if (value === undefined) return optional ? null : "is missing";

  if (kind.startsWith("enum:")) {
    const allowed = kind.slice("enum:".length).split("|");
    if (typeof value !== "string") return "must be a string";
    return allowed.includes(value) ? null : `must be one of ${allowed.join(", ")}`;
  }

  switch (kind) {
    case "int":
      return Number.isInteger(value) ? null : "must be a whole number";
    case "finite":
      return typeof value === "number" && Number.isFinite(value) ? null : "must be a finite number";
    case "string":
      return typeof value === "string" ? null : "must be a string";
    case "bool":
      return typeof value === "boolean" ? null : "must be true or false";
    case "string|null":
      return value === null || typeof value === "string" ? null : "must be a string or null";
    case "int|null":
      return value === null || Number.isInteger(value) ? null : "must be a whole number or null";
    case "array":
      return Array.isArray(value) ? null : "must be an array";
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value)
        ? null
        : "must be an object";
    default:
      /* An unreachable arm (#788) written as a real failure rather than a silent pass: a kind added to the
         union and forgotten here must refuse, not admit. */
      return "has an unrecognised declared kind";
  }
}

/* ------------------------------------------------------------------ */
/* The table                                                          */
/* ------------------------------------------------------------------ */

/** Every gameplay discriminant the reducer dispatches on, with the fields it declares.
 *
 *  THIRTY-NINE, AND THE COUNT IS THE POINT. `applyOneAction` has 27 arms; the sandbox-only family
 *  (`isSandboxOnlyMsg`) adds 12 more that are handled before it or beside it. A discriminant absent from
 *  this table is refused, so adding an arm to the reducer without adding it here makes the message
 *  unreachable rather than unvalidated -- which is the failure direction worth having.
 *
 *  `game_id` IS OPTIONAL THROUGHOUT. The reducer never reads it and roughly a third of the messages in the
 *  stored logs omit it entirely; requiring it would refuse real traffic to enforce a field nothing uses. */
export const GAMEPLAY_MESSAGE_SCHEMA: Readonly<Record<string, Readonly<Record<string, FieldSpec>>>> = {
  /* ---- ordinary acting-player actions (the reducer's 27 arms) ---- */
  PassTurn: { game_id: "int?" },
  BuyStock: {
    game_id: "int?",
    protocol_id: "int",
    source: "enum:Ipo|Bank",
    par_value: "string|null?",
    quantity: "int?",
    certificate: "enum:double?",
  },
  SellStock: { game_id: "int?", protocol_id: "int", percentage: "finite" },
  LayTile: {
    game_id: "int?",
    protocol_id: "int",
    q: "int",
    r: "int",
    tile_id: "int",
    orientation: "int",
    ability_key: "string?",
    token_city: "int?",
    token_cities: "array?",
    bonus_lay: "bool?",
  },
  PlaceStationToken: { game_id: "int?", protocol_id: "int", q: "int", r: "int", city_index: "int?" },
  RunManualRoute: {
    game_id: "int?",
    protocol_id: "int",
    path: "array",
    payout_strategy: "enum:DeclareDividends|Withhold",
  },
  RunMultipleRoutes: {
    game_id: "int?",
    protocol_id: "int",
    routes: "array",
    revenue_seed: "finite?",
    revenue_turn: "string?",
    payout_strategy: "enum:DeclareDividends|Withhold?",
  },
  DeclareDividends: {
    game_id: "int?",
    protocol_id: "int",
    revenue_amount: "string",
    distribute: "bool",
  },
  /* #1326: `model_type` IS OPTIONAL, and the logs are how that was learned rather than the declaration.
     Sixty-six of the seventy-five stored purchases omit it: "an unnamed purchase is the queue head, as it
     always was", so requiring it here would have refused the ordinary depot buy and admitted only the named
     shelf tier -- the exact inversion of the rule. */
  BuyHardwareFromPool: {
    game_id: "int?",
    protocol_id: "int",
    model_type: "string?",
    returned_model_type: "string?",
  },
  EmergencyBuyHardware: { game_id: "int?", protocol_id: "int" },
  ExchangeTrainForDiesel: { game_id: "int?", protocol_id: "int", model_type: "string" },
  BuyTrainFromCorporation: {
    game_id: "int?",
    buyer_protocol_id: "int",
    seller_protocol_id: "int",
    model_type: "string",
    price: "string",
  },
  AdvanceOperatingSubPhase: { game_id: "int?", protocol_id: "int" },
  BeginOperatingRound: { game_id: "int?" },
  ExecuteOperatingRound: { game_id: "int?", public_company_choices: "array" },
  BidOnPrivate: { game_id: "int?", private_id: "int", bid_amount: "string" },
  BuyPrivateCompany: { game_id: "int?", protocol_id: "int", private_id: "int", price: "string" },
  WaterfallBuyLowest: { game_id: "int?" },
  WaterfallBidHigher: { game_id: "int?", private_id: "int", bid_amount: "string" },
  WaterfallPass: { game_id: "int?" },
  WaterfallMiniAuctionRaise: { game_id: "int?", bid_amount: "string" },
  WaterfallMiniAuctionPass: { game_id: "int?" },
  AcceptTrainOffer: { game_id: "int?", offer_id: "int" },
  RejectTrainOffer: { game_id: "int?", offer_id: "int" },
  RescindTrainOffer: { game_id: "int?", offer_id: "int" },
  /* #1450: a no-op arm in the reducer and, in room play, unreachable from the UI -- the shell's undo is
     `RevertTo`. Kept in the table because the message still exists and a validator that omitted it would
     turn a vestigial message into a rejected one, which is a behaviour change this batch has no business
     making. See the classification note in the batch report. */
  UndoLastAction: { game_id: "int?" },
  /* #1451: SYSTEM/DERIVED IN INTENT, CLIENT-SENT IN FACT. Validated like any other message; the question of
     who may send it is `turnAuthority`'s and is recorded as deferred. `cash` is a STRING in every stored
     occurrence, matching the contract's `Uint128` convention rather than the integer this file would have
     guessed. */
  YellowSignEvent: {
    game_id: "int?",
    protocol_id: "int",
    stage: "enum:mark|carcosa|fog",
    model: "string|null?",
    cash: "string?",
    revenue_seed: "finite?",
  },

  /* ---- the between-turn / exception family (`isSandboxOnlyMsg`) ---- */
  SetupGame: { players: "array", variants: "object?", build: "string?" },
  OpenStockRound: EMPTY,
  CloseRoom: EMPTY,
  SetBoPar: { player: "string", par_value: "string" },
  PlaceHomeStation: {
    game_id: "int?",
    company_id: "int",
    q: "int",
    r: "int",
    kind: "enum:home|dh",
    city_index: "int|null?",
    hex_label: "string?",
  },
  ExchangePrivate: {
    game_id: "int?",
    private_id: "int",
    company_id: "int",
    player: "string",
    source: "enum:Ipo|Bank",
    keep_open: "bool?",
  },
  RevertTo: { index: "int", player: "string", summary: "string?" },
  ProposePrivatePurchase: {
    game_id: "int?",
    private_id: "int",
    private_name: "string?",
    owner: "string",
    buyer_protocol_id: "int",
    buyer_ticker: "string?",
    price: "finite",
  },
  AnswerPrivatePurchase: { game_id: "int?", private_id: "int", accept: "bool" },
  ProposeTrainPurchase: {
    game_id: "int?",
    seller_protocol_id: "int",
    seller_ticker: "string?",
    seller_president: "string|null?",
    buyer_protocol_id: "int",
    buyer_ticker: "string?",
    model_type: "string",
    price: "string",
  },
  AnswerTrainPurchase: { game_id: "int?", seller_protocol_id: "int", accept: "bool" },
  BuyKanawhaLicense: { game_id: "int?", protocol_id: "int" },
};

/** Every discriminant this server will accept. Sorted for a readable refusal. */
export const GAMEPLAY_MESSAGE_KINDS: readonly string[] = Object.keys(GAMEPLAY_MESSAGE_SCHEMA).sort();

/* ------------------------------------------------------------------ */
/* The check                                                          */
/* ------------------------------------------------------------------ */

export type MessageValidation = { ok: true; kind: string } | { ok: false; reason: string };

/** Whether `msg` is structurally a gameplay message. Says nothing about whether the move is legal.
 *
 *  EXACTLY ONE DISCRIMINANT. `{ PassTurn: {...}, BuyStock: {...} }` was accepted before this existed and the
 *  reducer applied whichever arm it tested first -- a message whose meaning depended on the order of `if`
 *  statements. Two keys is not a message. */
export function validateGameplayMessage(msg: unknown): MessageValidation {
  if (typeof msg !== "object" || msg === null || Array.isArray(msg)) {
    return { ok: false, reason: "A gameplay message must be an object." };
  }

  const keys = Object.keys(msg as Record<string, unknown>);
  if (keys.length === 0) return { ok: false, reason: "That message names no action." };
  if (keys.length > 1) {
    return {
      ok: false,
      reason: `A message names one action; that one names ${keys.length} (${keys.join(", ")}).`,
    };
  }

  const kind = keys[0];
  const fields = GAMEPLAY_MESSAGE_SCHEMA[kind];
  if (fields === undefined) return { ok: false, reason: `"${kind}" is not an action this game has.` };

  const body = (msg as Record<string, unknown>)[kind];
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, reason: `${kind} must carry an object.` };
  }

  for (const [field, spec] of Object.entries(fields)) {
    const complaint = checkField((body as Record<string, unknown>)[field], spec);
    if (complaint !== null) return { ok: false, reason: `${kind}.${field} ${complaint}.` };
  }

  return { ok: true, kind };
}

/* ------------------------------------------------------------------ */
/* The envelope around it                                             */
/* ------------------------------------------------------------------ */

/** The submit frame's own fields, which were cast just as the message was.
 *
 *  `baseIndex` MATTERS MORE THAN IT LOOKS. `RoomSession.submit` compares it against the log's length to
 *  decide whether the client is stale and owed a catch-up; a non-number made that comparison `false` and
 *  skipped the check, so a client arbitrarily far behind could have a move applied on top of a board it had
 *  never seen. `-1` is the legitimate "I have nothing" value, so the floor is -1 rather than 0. */
export function validateSubmitEnvelope(frame: {
  build?: unknown;
  baseIndex?: unknown;
  submissionId?: unknown;
}): MessageValidation {
  if (typeof frame.build !== "string") return { ok: false, reason: "That frame names no build." };
  if (!Number.isInteger(frame.baseIndex) || (frame.baseIndex as number) < -1) {
    return { ok: false, reason: "That frame's baseIndex is not a log position." };
  }
  if (frame.submissionId !== undefined && typeof frame.submissionId !== "string") {
    return { ok: false, reason: "That frame's submissionId is not a string." };
  }
  return { ok: true, kind: "submit" };
}

/* ------------------------------------------------------------------ */
/* The outermost frame                                                */
/* ------------------------------------------------------------------ */

/** The frame kinds this server answers. Deliberately a list rather than per-kind schemas: the lobby, chat
 *  and roster frames are not gameplay and do not reach the reducer or the log, so the thin check here is
 *  "is this addressed to something that exists" and the handlers keep their own field handling. Widening
 *  that to full schemas is a separate decision; this one closes the case where a frame with no `kind` at
 *  all, or a non-object, falls through twelve `if`s and is silently dropped. */
export const CLIENT_FRAME_KINDS: readonly string[] = [
  "hello",
  "submit",
  "room-hello",
  "room-write",
  "seat-pin",
  "claim-seat",
  "find-seats",
  "chat-send",
  "presence-set",
  "lobby-hello",
  "lobby-watch",
  "lobby-write",
];

export function isRecognisedClientFrame(parsed: unknown): parsed is { kind: string } {
  return (
    typeof parsed === "object" &&
    parsed !== null &&
    !Array.isArray(parsed) &&
    typeof (parsed as { kind?: unknown }).kind === "string" &&
    CLIENT_FRAME_KINDS.includes((parsed as { kind: string }).kind)
  );
}

/* ==================================================================
    A NOTE ON TRANSPORT LIMITS, WHICH THIS FILE DOES NOT SET
   ==================================================================
   There is no cap here on frame size, string length or array length, and that is a decision rather than an
   omission. A limit is a policy: it needs a number, and a number invented in a validator becomes a rule
   nobody chose -- a route with more waypoints than someone guessed at, refused by the wire. The real
   protections for an oversized frame belong to the transport (`ws` accepts a `maxPayload` option, set once
   at the server rather than per message) and are worth setting deliberately, with a figure, in their own
   change. Recorded here so the absence is legible. */
