// frontend/src/gameEngine/messageSchema.ts
//
// ==================================================================
//  DESIGN NOTE 1449: THE SHAPE OF A MESSAGE IS NOT THE LEGALITY OF A MOVE
// ==================================================================
//
// WHAT THIS FILE IS. The structural contract of every logged room message, checked at runtime, so that what
// reaches `RoomSession.submit` is a `SandboxLogMsg` in fact and not merely by assertion. (Stage 10.5, S10-9:
// that is the log-wide family -- the contract's `GameplayExecuteMsg` plus the room-only `isSandboxOnlyMsg`
// events, both of which this table has always admitted; the table's key set is pinned against the union by
// `stage105TypeWire.test.ts`. The chain's own set is `GAMEPLAY_MESSAGE_KEYS` and is not this table.)
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
// UNKNOWN FIELDS ARE STRIPPED, NOT REFUSED (LIVE-2A, LIVE-2 §11.2). The table below was built from the DECLARED
// types and then checked against every message in every stored log -- and the logs carried fields the
// declarations did not mention (`RunMultipleRoutes` sends `trains` and `train_indices`; `LayTile` sends
// `token_cities`), which is why this file used to let unknown fields THROUGH. Those fields are declared now, and
// `parseGameplayMessage` REBUILDS every message from its declared fields alone, recursively -- waypoints, the
// deal's players, the variants, `token_cities` pairs -- so nothing undeclared can reach the permanent, hashed log.
// Refusing would add a lockstep risk on every narration field for no security gain; stripping guarantees the
// property that matters. The reducer provably reads only declared fields (`ingressStrip.test.ts`).
//
// BOUNDS ARE TRANSPORT SANITY, NOT RULES (LIVE-2 §11.3, the #1553 precedent). Every string kind has a ceiling
// (`id` 32, `amount` 32, `narration` 64, `summary` 160) and every array kind a length (16, and #1553's route
// limits) far above any legal value -- the longest string in the whole corpus is 26 characters. An integer is a
// SAFE integer: `1e300` is not a corporation. What is LEGAL stays the reducer's and the authority's.
//
// NO INHERITED KEYS (LIVE-2 §11.1 item 4). The tables are null-prototype objects read through `hasOwn`, and the
// keys `__proto__`, `constructor` and `prototype` are refused anywhere in a frame -- `{"constructor":{}}` used to
// validate, because the plain-object table answered `Object` for it.
//
// PURE AND SERVER-SAFE: no React, no DOM, no game state, no I/O. It lives in the engine because the message
// shapes are the engine's protocol; the server is what ENFORCES it, before `RoomSession.submit`.

/* ------------------------------------------------------------------ */
/* Inherited keys, nesting, and the one text sanitizer (LIVE-2A)       */
/* ------------------------------------------------------------------ */

/** LIVE-2 §11.1 item 4: refused anywhere in a frame, at any depth. */
export const FORBIDDEN_FRAME_KEYS: readonly string[] = ["__proto__", "constructor", "prototype"];

/** How deep any frame may nest. The deepest legitimate frame (a presence draft, a run's waypoint) is about six. */
export const MAX_FRAME_DEPTH = 16;

/** `Object.hasOwn`, spelled so an ES2020 library target compiles it. Never `key in table`. */
export function hasOwn(target: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(target, key);
}

/** A frozen null-prototype table: `table["constructor"]` is `undefined`, not `Object`. */
function nullTable<V>(entries: Record<string, V>): Readonly<Record<string, V>> {
  const out = Object.create(null) as Record<string, V>;
  for (const key of Object.keys(entries)) {
    Object.defineProperty(out, key, { value: entries[key], enumerable: true });
  }
  return Object.freeze(out);
}

/** A rebuilt object's field, DEFINED rather than assigned -- never `out[key] = ...` (LIVE-2 §11.1 item 4). The key
 *  always comes from a declared table, never from the frame. */
function define(out: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true });
}

/** A forbidden key anywhere, or nesting past `MAX_FRAME_DEPTH`; `null` when neither. ITERATIVE, so a hostile frame
 *  of ten thousand nested arrays cannot exhaust the stack of the process that is refusing it. */
export function frameHazard(value: unknown): "forbidden-key" | "too-deep" | null {
  const stack: Array<{ node: unknown; depth: number }> = [{ node: value, depth: 0 }];
  while (stack.length > 0) {
    const { node, depth } = stack.pop() as { node: unknown; depth: number };
    if (typeof node !== "object" || node === null) continue;
    if (depth > MAX_FRAME_DEPTH) return "too-deep";
    if (Array.isArray(node)) {
      for (const item of node) stack.push({ node: item, depth: depth + 1 });
      continue;
    }
    for (const key of Object.keys(node)) {
      if (FORBIDDEN_FRAME_KEYS.includes(key)) return "forbidden-key";
      stack.push({ node: (node as Record<string, unknown>)[key], depth: depth + 1 });
    }
  }
  return null;
}

/* ==================================================================
    LIVE-2 §11.2: THE SINGLE SANITIZER
   ==================================================================
   Every string the server commits or broadcasts on a player's behalf -- a chat line, a nickname, an undo's
   summary, narration it could not derive from the board -- passes through this one function: NFC, then every
   Unicode control (`Cc`) and format (`Cf`) character removed, which is every bidi override and isolate as well as
   C0/C1. Built at runtime because the engine compiles to ES5, where a `u`-flagged literal does not parse. */
const CONTROL_OR_FORMAT = new RegExp("[\\p{Cc}\\p{Cf}]", "gu");

/** NFC, controls and format characters stripped, and at most `max` code points (never half a surrogate pair). */
export function sanitizeText(raw: string, max: number): string {
  const normal = typeof raw.normalize === "function" ? raw.normalize("NFC") : raw;
  const clean = normal.replace(CONTROL_OR_FORMAT, "");
  const points = Array.from(clean);
  return points.length <= max ? clean : points.slice(0, max).join("");
}

/** A display name: sanitized, whitespace collapsed, trimmed, capped (LIVE-2 §11.3: nickname 1-24 after this). */
export function sanitizeName(raw: unknown, max: number): string {
  if (typeof raw !== "string") return "";
  return sanitizeText(raw.replace(/\s+/g, " ").trim(), max).trim();
}

/* ------------------------------------------------------------------ */
/* The field vocabulary                                               */
/* ------------------------------------------------------------------ */

/** A field's declared kind. `?` suffix marks it optional -- absent is fine, present must still be right.
 *
 *  `int` IS NOT `number`. Protocol fields that index a corporation, a hex or a log entry are integers, and
 *  `1.5` in one of them is as malformed as `"x"` -- it was `q: 1.5` that got through before this existed.
 *  LIVE-2A: and a SAFE integer -- `Number.isInteger(1e300)` is true, `Number.isSafeInteger` is not.
 *  Every numeric kind also excludes `NaN` and `Infinity`: `JSON.parse` cannot produce them, but a message
 *  can reach `submit` from a test or a future non-JSON transport, and `Number.isFinite` costs nothing.
 *
 *  LIVE-2A (§11.3): THERE IS NO UNBOUNDED STRING KIND. `id` names a thing (<= 32), `amount` is a figure the
 *  authority parses (<= 32), `narration` is text a log line or prompt shows (<= 64), `summary` is an undo's
 *  sentence (<= 160). Arrays are bounded too: `ints` / `ids` / `pairs` / `choices` / `players` hold at most 16. */
type FieldKind =
  | "int"
  | "finite"
  | "bool"
  | "int|null"
  | "id"
  | "id|null"
  | "amount"
  | "finite|amount"
  | "narration"
  | "narration|null"
  | "summary"
  | "waypoints"
  | "routes"
  | "ints"
  | "ids"
  | "pairs"
  | "choices"
  | "players"
  | "variants"
  | `enum:${string}`;

type FieldSpec = FieldKind | `${FieldKind}?`;

/** `Record<string, never>` on the wire: a body that must be an object and carries nothing this file names. */
const EMPTY: Readonly<Record<string, FieldSpec>> = nullTable<FieldSpec>({});

/** #1553: transport sanity bounds on a run (see the `routes` arm below). Not rules. */
export const MAX_ROUTES_PER_RUN = 64;
export const MAX_WAYPOINTS_PER_ROUTE = 512;

/** LIVE-2 §11.3: the string and array ceilings. Transport sanity, documented as such; never a rule. */
export const MAX_ID_LENGTH = 32;
export const MAX_AMOUNT_LENGTH = 32;
export const MAX_NARRATION_LENGTH = 64;
export const MAX_SUMMARY_LENGTH = 160;
export const MAX_HEX_LABEL_LENGTH = 16;
export const MAX_LIST_LENGTH = 16;

/** A parsed field: the rebuilt value, or the complaint. */
type Parsed = { ok: true; value: unknown } | { ok: false; complaint: string };
const good = (value: unknown): Parsed => ({ ok: true, value });
const bad = (complaint: string): Parsed => ({ ok: false, complaint });

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const boundedString = (value: unknown, max: number): Parsed =>
  typeof value !== "string" ? bad("must be a string") : value.length > max ? bad("is too long") : good(value);

/** One waypoint, CLOSED: `hex`, and optionally `city_node` and `bypass`; anything else is not carried. */
function parseWaypoints(value: unknown): Parsed {
  if (!Array.isArray(value)) return bad("must be an array of waypoints");
  if (value.length > MAX_WAYPOINTS_PER_ROUTE) return bad(`has a route of more than ${MAX_WAYPOINTS_PER_ROUTE} waypoints`);
  const out: unknown[] = [];
  for (const waypoint of value) {
    if (!isPlainObject(waypoint)) return bad("has a waypoint that is not an object");
    const { hex, city_node, bypass } = waypoint;
    if (typeof hex !== "string" || hex.length === 0 || hex.length > MAX_HEX_LABEL_LENGTH) return bad("has a waypoint with no hex label");
    if (city_node !== undefined && !Number.isSafeInteger(city_node)) return bad("has a waypoint whose city_node is not a whole number");
    if (bypass !== undefined && typeof bypass !== "boolean") return bad("has a waypoint whose bypass is not true or false");
    const rebuilt: Record<string, unknown> = {};
    define(rebuilt, "hex", hex);
    if (city_node !== undefined) define(rebuilt, "city_node", city_node);
    if (bypass !== undefined) define(rebuilt, "bypass", bypass);
    out.push(rebuilt);
  }
  return good(out);
}

/** The variant keys the reducer reads from a deal (LIVE-2 Appendix A.2), with their shapes. Closed: anything else
 *  is stripped, and a declared key of the wrong shape refuses the message. */
const VARIANT_FIELDS: Readonly<Record<string, FieldSpec>> = nullTable<FieldSpec>({
  length: "enum:short|standard|long?",
  mode: "enum:live|async?",
  delayedAuction: "bool?",
  gentleRust: "bool?",
  unpredictableRevenue: "bool?",
  dynamicStockMarket: "bool?",
  expandedMap: "bool?",
  plusTiles: "bool?",
  levelPlayingField: "bool?",
  rules: "int?",
});

/** The deal's seat, CLOSED: the reducer reads `id`; the shell narrates `nickname` and paints `color`. */
const SETUP_PLAYER_FIELDS: Readonly<Record<string, FieldSpec>> = nullTable<FieldSpec>({
  id: "narration",
  nickname: "narration?",
  color: "id?",
});

/** An Operating Round payout choice (`PublicCompanyPayoutChoiceDto`), CLOSED. */
const CHOICE_FIELDS: Readonly<Record<string, FieldSpec>> = nullTable<FieldSpec>({
  company_id: "int",
  payout: "bool",
});

/** Rebuild an object from `fields` alone. Unknown keys are counted into `strip` and not carried. */
function parseObject(
  value: unknown,
  fields: Readonly<Record<string, FieldSpec>>,
  strip: { count: number },
  label: string,
): Parsed {
  if (!isPlainObject(value)) return bad(`must be ${label}`);
  const out: Record<string, unknown> = {};
  for (const field of Object.keys(fields)) {
    const parsed = parseField(value[field], fields[field], strip);
    if (!parsed.ok) return bad(`${field} ${parsed.complaint}`);
    if (parsed.value !== undefined) define(out, field, parsed.value);
  }
  for (const key of Object.keys(value)) if (!hasOwn(fields, key)) strip.count += 1;
  return good(out);
}

function parseList(value: unknown, what: string, item: (entry: unknown) => Parsed): Parsed {
  if (!Array.isArray(value)) return bad(`must be an array of ${what}`);
  if (value.length > MAX_LIST_LENGTH) return bad(`lists more than ${MAX_LIST_LENGTH} ${what}`);
  const out: unknown[] = [];
  for (const entry of value) {
    const parsed = item(entry);
    if (!parsed.ok) return parsed;
    out.push(parsed.value);
  }
  return good(out);
}

/** One field, parsed: its rebuilt value (`undefined` when an optional field is absent), or the complaint. */
function parseField(value: unknown, spec: FieldSpec, strip: { count: number }): Parsed {
  const optional = spec.endsWith("?");
  const kind = (optional ? spec.slice(0, -1) : spec) as FieldKind;

  if (value === undefined) return optional ? good(undefined) : bad("is missing");

  if (kind.startsWith("enum:")) {
    const allowed = kind.slice("enum:".length).split("|");
    if (typeof value !== "string") return bad("must be a string");
    return allowed.includes(value) ? good(value) : bad(`must be one of ${allowed.join(", ")}`);
  }

  switch (kind) {
    case "int":
      return Number.isSafeInteger(value) ? good(value) : bad("must be a whole number");
    case "finite":
      return typeof value === "number" && Number.isFinite(value) ? good(value) : bad("must be a finite number");
    /* Stage 10.5 (S10-9): a price that may arrive in either wire spelling -- the canonical string every new write
       uses, or the JSON number a stored log carries. SHAPE ONLY, like `BuyTrainFromCorporation.price`: whether the
       text or number is a well-formed whole amount, and a legal one, is the authority's (`vgpAmount.ts` inside
       `privatePurchaseRefusal`), so ingress answers the authority's sentence (§16). */
    case "finite|amount":
      if (typeof value === "number") return Number.isFinite(value) ? good(value) : bad("must be a number or a string");
      return typeof value === "string" ? boundedString(value, MAX_AMOUNT_LENGTH) : bad("must be a number or a string");
    case "bool":
      return typeof value === "boolean" ? good(value) : bad("must be true or false");
    case "int|null":
      return value === null || Number.isSafeInteger(value) ? good(value) : bad("must be a whole number or null");
    case "id":
      return boundedString(value, MAX_ID_LENGTH);
    case "id|null":
      return value === null ? good(null) : typeof value === "string" ? boundedString(value, MAX_ID_LENGTH) : bad("must be a string or null");
    case "amount":
      return boundedString(value, MAX_AMOUNT_LENGTH);
    case "narration":
      return boundedString(value, MAX_NARRATION_LENGTH);
    case "narration|null":
      return value === null
        ? good(null)
        : typeof value === "string"
          ? boundedString(value, MAX_NARRATION_LENGTH)
          : bad("must be a string or null");
    case "summary":
      return boundedString(value, MAX_SUMMARY_LENGTH);
    /* ==================================================================
        DESIGN NOTE 1553: A ROUTE'S SHAPE, AT THE DOOR -- ITS LEGALITY, IN THE REDUCER (Batch 6)
       ==================================================================
       `routes` was declared "array", which admitted `[[1, 2], "x", null]` and let the reducer discover the
       shape by throwing. The element shape is protocol (`RouteWaypointDto`: `hex` string, optional integer
       `city_node`, optional `bypass`), so it is checked here; whether the hexes exist, connect, or may be run
       is 1830 and stays `routeAuthority.ts`'s. THE ONE BOUND IS A TRANSPORT SANITY LIMIT, NOT A RULE: no
       corporation owns more than a handful of trains and no board has more than about a hundred hexes, so a
       frame with 64 routes or a 512-waypoint route is not a move anybody made -- refused so the reducer's walk
       is never asked to price a megabyte. The real limits (trains owned, the board) are the reducer's.
       LIVE-2A: and a waypoint is CLOSED -- rebuilt from `hex`, `city_node` and `bypass` alone. */
    case "waypoints":
      return parseWaypoints(value);
    case "routes": {
      if (!Array.isArray(value)) return bad("must be an array of routes");
      if (value.length > MAX_ROUTES_PER_RUN) return bad(`lists more than ${MAX_ROUTES_PER_RUN} routes`);
      const out: unknown[] = [];
      for (const route of value) {
        const parsed = parseWaypoints(route);
        if (!parsed.ok) return parsed;
        out.push(parsed.value);
      }
      return good(out);
    }
    case "ints":
      return parseList(value, "whole numbers", (entry) =>
        Number.isSafeInteger(entry) ? good(entry) : bad("must be an array of whole numbers"),
      );
    case "ids":
      return parseList(value, "strings", (entry) =>
        typeof entry !== "string" ? bad("must be an array of strings") : boundedString(entry, MAX_ID_LENGTH),
      );
    /* `token_cities` is read as `new Map<number, number>(pairs)` (`sandboxSession.ts`), so each entry is exactly a
       pair of whole numbers -- a third element is not carried, and a pair that is not two numbers refuses. */
    case "pairs":
      return parseList(value, "pairs", (entry) =>
        Array.isArray(entry) && entry.length === 2 && Number.isSafeInteger(entry[0]) && Number.isSafeInteger(entry[1])
          ? good([entry[0], entry[1]])
          : bad("must be an array of [whole number, whole number] pairs"),
      );
    case "choices":
      return parseList(value, "payout choices", (entry) => {
        const parsed = parseObject(entry, CHOICE_FIELDS, strip, "an object");
        return parsed.ok ? parsed : bad(`has a payout choice that ${parsed.complaint}`);
      });
    case "players":
      return parseList(value, "players", (entry) => {
        const parsed = parseObject(entry, SETUP_PLAYER_FIELDS, strip, "an object");
        return parsed.ok ? parsed : bad(`has a player whose ${parsed.complaint}`);
      });
    case "variants":
      return parseObject(value, VARIANT_FIELDS, strip, "an object");
    default:
      /* An unreachable arm (#788) written as a real failure rather than a silent pass: a kind added to the
         union and forgotten here must refuse, not admit. */
      return bad("has an unrecognised declared kind");
  }
}

/* ------------------------------------------------------------------ */
/* The table                                                          */
/* ------------------------------------------------------------------ */

/** Every gameplay discriminant the reducer dispatches on, with the fields it declares.
 *
 *  THIRTY-NINE, AND THE COUNT IS THE POINT. `applyOneAction` has 27 arms; the sandbox-only family
 *  (`isSandboxOnlyMsg`) adds 12 more that are handled before it or beside it. (Later batches have grown the
 *  table -- Batch 5's four, Batch 7.4's five (#1594) -- and `messageSchema.test.ts` pins the live count.) A discriminant absent from
 *  this table is refused, so adding an arm to the reducer without adding it here makes the message
 *  unreachable rather than unvalidated -- which is the failure direction worth having.
 *
 *  `game_id` IS OPTIONAL THROUGHOUT. The reducer never reads it and roughly a third of the messages in the
 *  stored logs omit it entirely; requiring it would refuse real traffic to enforce a field nothing uses. */
const RAW_GAMEPLAY_MESSAGE_SCHEMA: Record<string, Readonly<Record<string, FieldSpec>>> = {
  /* ---- ordinary acting-player actions (the reducer's 27 arms) ---- */
  PassTurn: { game_id: "int?" },
  BuyStock: {
    game_id: "int?",
    protocol_id: "int",
    source: "enum:Ipo|Bank",
    par_value: "id|null?",
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
    ability_key: "id?",
    token_city: "int?",
    token_cities: "pairs?",
    bonus_lay: "bool?",
  },
  PlaceStationToken: { game_id: "int?", protocol_id: "int", q: "int", r: "int", city_index: "int?" },
  RunManualRoute: {
    game_id: "int?",
    protocol_id: "int",
    path: "waypoints",
    payout_strategy: "enum:DeclareDividends|Withhold",
  },
  // #1553: the element shapes are protocol; `trains` / `train_indices` were undeclared (see the header).
  RunMultipleRoutes: {
    game_id: "int?",
    protocol_id: "int",
    routes: "routes",
    trains: "ids?",
    train_indices: "ints?",
    revenue_seed: "finite?",
    revenue_turn: "id?",
    payout_strategy: "enum:DeclareDividends|Withhold?",
  },
  DeclareDividends: {
    game_id: "int?",
    protocol_id: "int",
    revenue_amount: "amount",
    distribute: "bool",
  },
  /* #1326: `model_type` IS OPTIONAL, and the logs are how that was learned rather than the declaration.
     Sixty-six of the seventy-five stored purchases omit it: "an unnamed purchase is the queue head, as it
     always was", so requiring it here would have refused the ordinary depot buy and admitted only the named
     shelf tier -- the exact inversion of the rule. */
  BuyHardwareFromPool: {
    game_id: "int?",
    protocol_id: "int",
    model_type: "id?",
    returned_model_type: "id?",
  },
  EmergencyBuyHardware: { game_id: "int?", protocol_id: "int" },
  ExchangeTrainForDiesel: { game_id: "int?", protocol_id: "int", model_type: "id" },
  DiscardTrain: { game_id: "int?", protocol_id: "int", model_type: "id" }, // #1530
  // #1541: the emergency private sale and the bankruptcy declaration.
  OfferPrivateForFunding: { game_id: "int?", private_id: "int", buyer_protocol_id: "int", price: "int" },
  AnswerFundingPrivateOffer: { game_id: "int?", private_id: "int", accept: "bool" },
  RescindFundingPrivateOffer: { game_id: "int?", private_id: "int" },
  DeclareBankruptcy: { game_id: "int?" },
  /* UR-4 (OD-UR-5(c) = 5c-2): `gilded` names the COPY sold when the seller holds a gold-trimmed copy of the model --
     `true` the gilded copy (the Blood Price), `false` an ordinary one. OPTIONAL: every stored sale omits it, and an
     unnamed sale is still legal wherever it cannot be ambiguous. SHAPE ONLY, as ever: whether the named copy exists,
     and whether an unnamed sale is ambiguous, is the authority's (`trainSaleRefusal`). */
  BuyTrainFromCorporation: {
    game_id: "int?",
    buyer_protocol_id: "int",
    seller_protocol_id: "int",
    model_type: "id",
    price: "amount",
    gilded: "bool?",
  },
  AdvanceOperatingSubPhase: { game_id: "int?", protocol_id: "int" },
  BeginOperatingRound: { game_id: "int?" },
  ExecuteOperatingRound: { game_id: "int?", public_company_choices: "choices" },
  BidOnPrivate: { game_id: "int?", private_id: "int", bid_amount: "amount" },
  BuyPrivateCompany: { game_id: "int?", protocol_id: "int", private_id: "int", price: "amount" },
  WaterfallBuyLowest: { game_id: "int?" },
  WaterfallBidHigher: { game_id: "int?", private_id: "int", bid_amount: "amount" },
  WaterfallPass: { game_id: "int?" },
  WaterfallMiniAuctionRaise: { game_id: "int?", bid_amount: "amount" },
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
     guessed.
     ==================================================================
      DESIGN NOTE 1661 (S9-1): FOUR OUTCOME FIELDS, NOW LEGACY REPLAY DATA
     ==================================================================
     `stage`, `model`, `cash` and `revenue_seed` WERE THE DEFECT: a client chose the outcome of a random event
     and the reducer applied it. They are OPTIONAL now and a live dispatch omits them; the authoritative arm
     derives all four from the committed board (`yellowSign.ts` #1661). They stay in the table because every
     stored `YellowSignEvent` in the corpus carries them and an unpinned board still replays from them -- a
     validator that dropped them would turn historical entries into rejected ones, which is precisely the
     behaviour change #1450's note refuses to make for a vestigial field.
     `debug_force` IS A BOOLEAN, NOT A STAGE, and that is the whole of why it is safe to admit: it waives the
     chance and the window (#1128), and the board still says which stage the waiver lands on. Shape validation
     cannot tell an ordinary client from a playtest host, and it does not have to -- there is no stage here to
     forge. */
  YellowSignEvent: {
    game_id: "int?",
    protocol_id: "int",
    stage: "enum:mark|carcosa|fog?",
    model: "id|null?",
    cash: "amount?",
    revenue_seed: "finite?",
    debug_force: "bool?",
  },

  /* ---- the between-turn / exception family (`isSandboxOnlyMsg`) ---- */
  SetupGame: { players: "players", variants: "variants?", build: "narration?", rules_engine_version: "int?" }, // #1520
  OpenStockRound: EMPTY,
  CloseRoom: EMPTY,
  SetBoPar: { player: "narration", par_value: "id" },
  PlaceHomeStation: {
    game_id: "int?",
    company_id: "int",
    q: "int",
    r: "int",
    kind: "enum:home|dh",
    city_index: "int|null?",
    hex_label: "id?",
  },
  ExchangePrivate: {
    game_id: "int?",
    private_id: "int",
    company_id: "int",
    player: "narration",
    source: "enum:Ipo|Bank",
    keep_open: "bool?",
  },
  RevertTo: { index: "int", player: "narration", summary: "summary?" },
  ProposePrivatePurchase: {
    game_id: "int?",
    private_id: "int",
    private_name: "narration?",
    owner: "narration",
    buyer_protocol_id: "int",
    buyer_ticker: "narration?",
    // Stage 10.5 (S10-9): was "finite" (strings refused). A new proposal writes the canonical whole-VGP string; a
    // stored log's number is still admitted. Malformed / fractional / out-of-band values are the authority's refusal.
    price: "finite|amount",
  },
  AnswerPrivatePurchase: { game_id: "int?", private_id: "int", accept: "bool" },
  ProposeTrainPurchase: {
    game_id: "int?",
    seller_protocol_id: "int",
    seller_ticker: "narration?",
    seller_president: "narration|null?",
    buyer_protocol_id: "int",
    buyer_ticker: "narration?",
    model_type: "id",
    price: "amount",
    gilded: "bool?", // UR-4: the copy on offer -- see `BuyTrainFromCorporation`
  },
  AnswerTrainPurchase: { game_id: "int?", seller_protocol_id: "int", accept: "bool" },
  /* #1594 (Batch 7.4): the two ordinary rescissions (S7-14) and the player <-> player private-company trade
     (S7-9, ruled Q12). Shape only, as ever: who may send each, and whether the trade is legal, are
     `turnAuthority`'s and the reducer's (`privateTradeRefusal`). `price` is an INT because the rule is "any
     mutually agreed price" in whole dollars and $0 is legal; the reducer refuses a negative one. */
  RescindPrivatePurchase: { game_id: "int?", private_id: "int" },
  RescindTrainPurchase: { game_id: "int?", seller_protocol_id: "int" },
  ProposePrivateTrade: { game_id: "int?", private_id: "int", seller: "narration", buyer: "narration", price: "int" },
  AnswerPrivateTrade: { game_id: "int?", private_id: "int", accept: "bool" },
  RescindPrivateTrade: { game_id: "int?", private_id: "int" },
  BuyKanawhaLicense: { game_id: "int?", protocol_id: "int" },
};

/** Every gameplay discriminant and its declared fields, as null-prototype tables (LIVE-2 §11.1 item 4): a lookup
 *  of `constructor`, `toString` or `__proto__` finds nothing, where the plain object found `Object`. */
export const GAMEPLAY_MESSAGE_SCHEMA: Readonly<Record<string, Readonly<Record<string, FieldSpec>>>> = (() => {
  const out: Record<string, Readonly<Record<string, FieldSpec>>> = {};
  for (const kind of Object.keys(RAW_GAMEPLAY_MESSAGE_SCHEMA)) {
    Object.defineProperty(out, kind, { value: nullTable(RAW_GAMEPLAY_MESSAGE_SCHEMA[kind]), enumerable: true });
  }
  return nullTable(out);
})();

/** Every discriminant this server will accept. Sorted for a readable refusal. */
export const GAMEPLAY_MESSAGE_KINDS: readonly string[] = Object.keys(GAMEPLAY_MESSAGE_SCHEMA).sort();

/* ------------------------------------------------------------------ */
/* The parse, and the check it replaces                               */
/* ------------------------------------------------------------------ */

export type MessageValidation = { ok: true; kind: string } | { ok: false; reason: string };

/** A parsed gameplay message: a NEW object built from the declared fields alone, and how many undeclared fields
 *  (at any depth) were left behind -- the `ingress.stripped` count. Never the input object. */
export type GameplayParse =
  | { ok: true; kind: string; value: Record<string, unknown>; stripped: number }
  | { ok: false; reason: string };

/* ==================================================================
    LIVE-2 §11.4: FIXED SENTENCES, NEVER THE CLIENT'S TEXT
   ==================================================================
   The old refusals echoed what they were refusing -- every key of a two-key message, an unknown discriminant,
   whatever a client had typed where a kind belongs. A refusal is shown to a player and printed in a window;
   neither is a place for text a stranger chose. Kind and field names below come from the TABLE, never the frame. */
const NOT_AN_OBJECT = "A gameplay message must be an object.";
const FORBIDDEN_KEY = "That message carries a field name the server does not accept.";
const TOO_DEEP = "That message is nested too deeply.";
const NO_ACTION = "That message names no action.";
const SEVERAL_ACTIONS = "A message names one action; that one names several.";
const UNKNOWN_ACTION = "That is not an action this game has.";
const BODY_NOT_OBJECT = "That action must carry an object.";

/** LIVE-2A (§11.1): parse, don't validate. The server hands `value` -- never the raw frame -- to
 *  `RoomSession.submit`, so what the log commits is exactly the declared shape. Says nothing about legality. */
export function parseGameplayMessage(msg: unknown): GameplayParse {
  if (!isPlainObject(msg)) return { ok: false, reason: NOT_AN_OBJECT };
  const hazard = frameHazard(msg);
  if (hazard === "forbidden-key") return { ok: false, reason: FORBIDDEN_KEY };
  if (hazard === "too-deep") return { ok: false, reason: TOO_DEEP };

  /* EXACTLY ONE DISCRIMINANT. `{ PassTurn: {...}, BuyStock: {...} }` was accepted before #1449 and the reducer
     applied whichever arm it tested first -- a message whose meaning depended on the order of `if` statements. */
  const keys = Object.keys(msg);
  if (keys.length === 0) return { ok: false, reason: NO_ACTION };
  if (keys.length > 1) return { ok: false, reason: SEVERAL_ACTIONS };

  const kind = keys[0];
  if (!hasOwn(GAMEPLAY_MESSAGE_SCHEMA, kind)) return { ok: false, reason: UNKNOWN_ACTION };
  const fields = GAMEPLAY_MESSAGE_SCHEMA[kind];

  const body = msg[kind];
  if (!isPlainObject(body)) return { ok: false, reason: BODY_NOT_OBJECT };

  const strip = { count: 0 };
  const rebuilt: Record<string, unknown> = {};
  for (const field of Object.keys(fields)) {
    const parsed = parseField(body[field], fields[field], strip);
    if (!parsed.ok) return { ok: false, reason: `${kind}.${field} ${parsed.complaint}.` };
    if (parsed.value !== undefined) define(rebuilt, field, parsed.value);
  }
  for (const key of Object.keys(body)) if (!hasOwn(fields, key)) strip.count += 1;

  const value: Record<string, unknown> = {};
  define(value, kind, rebuilt);
  return { ok: true, kind, value, stripped: strip.count };
}

/** Whether `msg` is structurally a gameplay message. Says nothing about whether the move is legal. A thin wrapper
 *  over `parseGameplayMessage` for the callers that only need the verdict. */
export function validateGameplayMessage(msg: unknown): MessageValidation {
  const parsed = parseGameplayMessage(msg);
  return parsed.ok ? { ok: true, kind: parsed.kind } : parsed;
}

/* ------------------------------------------------------------------ */
/* The envelope around it                                             */
/* ------------------------------------------------------------------ */

/** LIVE-2 §11.3: the identifier patterns a frame's own fields must match. */
export const SUBMISSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const BUILD_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
/** LIVE-2 §11.3: `baseIndex` is a safe integer in [-1, 10,000,000]. The upper bound "<= the room's watermark" is
 *  LIVE-3's two-sided staleness (`ahead`), already enforced by `RoomSession`. */
export const MAX_BASE_INDEX = 10_000_000;
/** An entry id the client holds at `baseIndex`. Opaque (legacy rooms minted other shapes), bounded. */
export const MAX_BASE_ID_LENGTH = 128;

const isBaseIndex = (value: unknown): boolean =>
  Number.isSafeInteger(value) && (value as number) >= -1 && (value as number) <= MAX_BASE_INDEX;

/** The submit frame's own fields, which were cast just as the message was.
 *
 *  `baseIndex` MATTERS MORE THAN IT LOOKS. `RoomSession.submit` compares it against the log's length to
 *  decide whether the client is stale and owed a catch-up; a non-number made that comparison `false` and
 *  skipped the check, so a client arbitrarily far behind could have a move applied on top of a board it had
 *  never seen. `-1` is the legitimate "I have nothing" value, so the floor is -1 rather than 0.
 *
 *  LIVE-2A (§11.3): `submissionId` IS REQUIRED AND BOUNDED -- the `(actor, submissionId)` nonce is what makes a
 *  retry idempotent, and an unbounded one is a key a client can make as large as a frame. */
export function validateSubmitEnvelope(frame: {
  build?: unknown;
  baseIndex?: unknown;
  baseId?: unknown;
  submissionId?: unknown;
}): MessageValidation {
  if (typeof frame.build !== "string" || !BUILD_PATTERN.test(frame.build)) {
    return { ok: false, reason: "That frame names no build." };
  }
  if (!isBaseIndex(frame.baseIndex)) {
    return { ok: false, reason: "That frame's baseIndex is not a log position." };
  }
  /* LIVE-3A: the anchor is an entry id or absent. Anything else is not a claim about history at all. */
  if (
    frame.baseId !== undefined &&
    (typeof frame.baseId !== "string" || frame.baseId.length === 0 || frame.baseId.length > MAX_BASE_ID_LENGTH)
  ) {
    return { ok: false, reason: "That frame's baseId is not an entry id." };
  }
  if (typeof frame.submissionId !== "string" || !SUBMISSION_ID_PATTERN.test(frame.submissionId)) {
    return { ok: false, reason: "That frame's submissionId is missing or not a submission id." };
  }
  return { ok: true, kind: "submit" };
}

/* ------------------------------------------------------------------ */
/* The outermost frame: CLOSED control-frame schemas (LIVE-2A)          */
/* ------------------------------------------------------------------ */

/** The frame kinds this server answers. LIVE-2A: `find-seats` is gone (LIVE-2 §10.5, §15 #6). */
export const CLIENT_FRAME_KINDS: readonly string[] = [
  "hello",
  "submit",
  "room-hello",
  "room-write",
  "seat-pin",
  "claim-seat",
  "chat-send",
  "presence-set",
  "lobby-hello",
  "lobby-watch",
  "lobby-write",
];

export function isRecognisedClientFrame(parsed: unknown): parsed is { kind: string } {
  return (
    isPlainObject(parsed) && typeof parsed.kind === "string" && CLIENT_FRAME_KINDS.includes(parsed.kind)
  );
}

/** A control-frame field's check: `null` when it is acceptable (absent included, for an optional field). */
type FrameCheck = (value: unknown) => boolean;
type FrameFields = Readonly<Record<string, { check: FrameCheck; optional?: true }>>;

const req = (check: FrameCheck) => ({ check });
const opt = (check: FrameCheck) => ({ check, optional: true as const });
const str = (max: number, pattern?: RegExp): FrameCheck => (value) =>
  typeof value === "string" && value.length <= max && (pattern === undefined || pattern.test(value));
const isBool: FrameCheck = (value) => typeof value === "boolean";
const isObject: FrameCheck = (value) => isPlainObject(value);

/** The legacy room code (`JUNO-XXX`), the lobby socket's `~lobby`, and a test's room name. */
export const ROOM_PATTERN = /^[A-Za-z0-9~_.-]{1,40}$/;
/** A claimed identity: a `p-` player id or a wallet address. Believed (#1210) -- but bounded. */
const CLAIM_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
/** LIVE-2 §11.3: a chat line is at most 500 characters; longer is refused, not truncated. */
export const MAX_CHAT_TEXT_LENGTH = 500;

/* ---- presence (LIVE-2 §11.3): closed, <= 4 KiB serialized ---- */
export const MAX_PRESENCE_BYTES = 4 * 1024;
const PRESENCE_KEY = /^(?:[0-9]|1[0-5])$/; // train index 0-15
const MAX_PRESENCE_TRAINS = 8;
const MAX_PRESENCE_DRAFT_POINTS = 128;
const MAX_PRESENCE_COORDINATE = 256;
const MAX_PRESENCE_ROUTE_VALUE = 1_000_000;

function presenceStateOk(value: unknown): boolean {
  if (value === null) return true;
  if (!isPlainObject(value)) return false;
  for (const key of Object.keys(value)) {
    if (!["playerId", "at", "routeDrafts", "routeValues", "actingCompanyId"].includes(key)) return false;
  }
  /* `playerId` and `at` are OVERWRITTEN by the server (#1397); a client may send its own, bounded. */
  if (value.playerId !== undefined && !str(128)(value.playerId)) return false;
  if (value.at !== undefined && !(typeof value.at === "number" && Number.isFinite(value.at))) return false;
  if (value.actingCompanyId !== undefined && value.actingCompanyId !== null && !Number.isSafeInteger(value.actingCompanyId)) {
    return false;
  }
  if (value.routeDrafts !== undefined) {
    if (!isPlainObject(value.routeDrafts)) return false;
    const trains = Object.keys(value.routeDrafts);
    if (trains.length > MAX_PRESENCE_TRAINS) return false;
    for (const train of trains) {
      if (!PRESENCE_KEY.test(train)) return false;
      const points = value.routeDrafts[train];
      if (!Array.isArray(points) || points.length > MAX_PRESENCE_DRAFT_POINTS) return false;
      for (const point of points) {
        if (!Array.isArray(point) || point.length !== 2) return false;
        for (const coordinate of point) {
          if (!Number.isSafeInteger(coordinate) || Math.abs(coordinate as number) > MAX_PRESENCE_COORDINATE) return false;
        }
      }
    }
  }
  if (value.routeValues !== undefined) {
    if (!isPlainObject(value.routeValues)) return false;
    const trains = Object.keys(value.routeValues);
    if (trains.length > MAX_PRESENCE_TRAINS) return false;
    for (const train of trains) {
      const figure = value.routeValues[train];
      if (!PRESENCE_KEY.test(train)) return false;
      if (!Number.isSafeInteger(figure) || (figure as number) < 0 || (figure as number) > MAX_PRESENCE_ROUTE_VALUE) return false;
    }
  }
  return JSON.stringify(value).length <= MAX_PRESENCE_BYTES;
}

/* ---- the legacy room-document writes (LIVE-2A §13.4 step 1) ---- */

/** A variants object on a legacy `host` write: the known keys only, each of its declared shape. */
function variantsOk(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  const parsed = parseObject(value, VARIANT_FIELDS, { count: 0 }, "an object");
  if (!parsed.ok) return false;
  return Object.keys(value).every((key) => hasOwn(VARIANT_FIELDS, key));
}

const SEAT_PLAYER_FIELDS: FrameFields = nullTable({
  id: req(str(128, CLAIM_PATTERN)),
  nickname: req(str(MAX_NARRATION_LENGTH)),
  isReady: req(isBool),
  color: opt(str(MAX_ID_LENGTH)),
  /* Stamped by `publicDoc` on every broadcast seat; a client that echoes its own seat back carries it. Ignored. */
  hasPin: opt(isBool),
});

/** LIVE-2A: `variants` and `forced-sign` are DELETED (LIVE-2 §9.1, §13.2). `status` survives as a server-derived
 *  echo until 2D deletes it. */
const ROOM_WRITE_OPS: Readonly<Record<string, FrameFields>> = nullTable<FrameFields>({
  host: nullTable({
    op: req(str(16)),
    hostId: req(str(128, CLAIM_PATTERN)),
    nickname: req(str(MAX_NARRATION_LENGTH)),
    variants: req(variantsOk),
    visibility: opt((value) => value === "public" || value === "private"),
    playerCount: opt((value) => value === null || Number.isSafeInteger(value)),
    anteUjuno: opt(str(MAX_AMOUNT_LENGTH)),
  }),
  "upsert-player": nullTable({
    op: req(str(16)),
    player: req((value) => closedOk(value, SEAT_PLAYER_FIELDS)),
  }),
  status: nullTable({ op: req(str(16)), status: req(str(16)) }),
  kick: nullTable({ op: req(str(16)), playerId: req(str(128, CLAIM_PATTERN)) }),
});

function roomWriteOk(value: unknown): boolean {
  if (!isPlainObject(value) || typeof value.op !== "string" || !hasOwn(ROOM_WRITE_OPS, value.op)) return false;
  return closedOk(value, ROOM_WRITE_OPS[value.op]);
}

/** Every key declared, every declared key of its shape, every required key present. */
function closedOk(value: unknown, fields: FrameFields): boolean {
  if (!isPlainObject(value)) return false;
  for (const key of Object.keys(value)) if (!hasOwn(fields, key)) return false;
  for (const key of Object.keys(fields)) {
    const { check, optional } = fields[key];
    if (value[key] === undefined) {
      if (!optional) return false;
      continue;
    }
    if (!check(value[key])) return false;
  }
  return true;
}

/** LIVE-2 §11.2: every control frame is CLOSED -- an unknown field is `bad-frame`, not ignored. Each schema is
 *  what today's client sends, field for field (`serverLink.ts`, `roomDocLink.ts`, `lobby.ts`). */
const CONTROL_FRAMES: Readonly<Record<string, FrameFields>> = nullTable<FrameFields>({
  hello: nullTable({
    kind: req(str(16)),
    room: req(str(40, ROOM_PATTERN)),
    build: req(str(64, BUILD_PATTERN)),
    claim: opt(str(128, CLAIM_PATTERN)),
    pin: opt(str(16)),
    token: opt(str(64, REQUEST_ID_PATTERN)),
    baseIndex: opt(isBaseIndex),
    baseId: opt((value) => typeof value === "string" && value.length > 0 && value.length <= MAX_BASE_ID_LENGTH),
  }),
  /* The submit ENVELOPE is closed; its `msg` is a gameplay body, parsed (and stripped) by `parseGameplayMessage`. */
  submit: nullTable({
    kind: req(str(16)),
    build: req(str(64)),
    msg: req(() => true),
    baseIndex: req(() => true),
    baseId: opt(() => true),
    submissionId: opt(() => true),
  }),
  "room-hello": nullTable({
    kind: req(str(16)),
    room: req(str(40, ROOM_PATTERN)),
    build: opt(str(64, BUILD_PATTERN)),
    claim: opt(str(128, CLAIM_PATTERN)),
    pin: opt(str(16)),
    token: opt(str(64, REQUEST_ID_PATTERN)),
  }),
  "room-write": nullTable({
    kind: req(str(16)),
    room: req(str(40, ROOM_PATTERN)),
    write: req(roomWriteOk),
  }),
  "seat-pin": nullTable({
    kind: req(str(16)),
    room: req(str(40, ROOM_PATTERN)),
    requestId: req(str(64, REQUEST_ID_PATTERN)),
    playerId: req(str(128, CLAIM_PATTERN)),
    pin: req(str(16)),
    currentPin: opt(str(16)),
  }),
  "claim-seat": nullTable({
    kind: req(str(16)),
    room: req(str(40, ROOM_PATTERN)),
    requestId: req(str(64, REQUEST_ID_PATTERN)),
    playerId: req(str(128, CLAIM_PATTERN)),
    pin: req(str(16)),
  }),
  "chat-send": nullTable({
    kind: req(str(16)),
    room: req(str(40, ROOM_PATTERN)),
    text: req(str(MAX_CHAT_TEXT_LENGTH)),
    displayName: opt(str(MAX_NARRATION_LENGTH)),
  }),
  "presence-set": nullTable({
    kind: req(str(16)),
    room: req(str(40, ROOM_PATTERN)),
    state: req(presenceStateOk),
  }),
  "lobby-hello": nullTable({ kind: req(str(16)) }),
  "lobby-watch": nullTable({
    kind: req(str(16)),
    roomId: req((value) => value === null || str(64)(value)),
  }),
  /* Parked (LIVE-0): refused whole by the server, so the write itself is carried but never interpreted. */
  "lobby-write": nullTable({
    kind: req(str(16)),
    requestId: req(str(64, REQUEST_ID_PATTERN)),
    write: req(isObject),
  }),
});

export type ClientFrameParse =
  | { ok: true; frame: { kind: string } & Record<string, unknown> }
  | { ok: false; reason: string; kind: string | null };

/** LIVE-2 §11.4: the fixed sentences a malformed control frame is answered with. */
export const BAD_FRAME_REASONS = Object.freeze({
  notObject: "That frame is not an object.",
  forbiddenKey: "That frame carries a field name the server does not accept.",
  tooDeep: "That frame is nested too deeply.",
  unknownKind: "That is not a frame this server answers.",
  malformed: "That frame is not in the shape the server accepts.",
});

/** LIVE-2A (§11.1 item 3, §11.2): the outermost check, CLOSED. `kind` in the refusal is set only when it is one of
 *  the known kinds -- so a caller may shape its answer by kind without ever echoing a stranger's. */
export function parseClientFrame(parsed: unknown): ClientFrameParse {
  if (!isPlainObject(parsed)) return { ok: false, reason: BAD_FRAME_REASONS.notObject, kind: null };
  const hazard = frameHazard(parsed);
  if (hazard !== null) {
    return {
      ok: false,
      reason: hazard === "forbidden-key" ? BAD_FRAME_REASONS.forbiddenKey : BAD_FRAME_REASONS.tooDeep,
      kind: typeof parsed.kind === "string" && hasOwn(CONTROL_FRAMES, parsed.kind) ? parsed.kind : null,
    };
  }
  const kind = parsed.kind;
  if (typeof kind !== "string" || !hasOwn(CONTROL_FRAMES, kind)) {
    return { ok: false, reason: BAD_FRAME_REASONS.unknownKind, kind: null };
  }
  if (!closedOk(parsed, CONTROL_FRAMES[kind])) return { ok: false, reason: BAD_FRAME_REASONS.malformed, kind };
  return { ok: true, frame: parsed as { kind: string } & Record<string, unknown> };
}

/* ==================================================================
    TRANSPORT LIMITS (LIVE-2A)
   ==================================================================
   This file used to say it set no bounds, and why: a number invented in a validator is a rule nobody chose. LIVE-2
   §11.3 chose them -- each a transport-sanity ceiling far above any legal value, documented beside its kind above --
   and the transport's own limits (the 32 KiB frame, no compression, the per-socket buckets) are the server's
   (`server/src/ingress/limits.ts`). */
