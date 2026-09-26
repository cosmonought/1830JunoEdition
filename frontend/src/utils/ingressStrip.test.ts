/** @jest-environment node */
// frontend/src/utils/ingressStrip.test.ts
//
// ==================================================================
//  LIVE-2A (LIVE-2 §11.1, §11.2): STRIP-AT-COMMIT, PROVEN RATHER THAN EVIDENCED
// ==================================================================
//
// LIVE-2's Appendix A found, by probe, that the corpus carries no undeclared fields and that the reducer read none
// -- for 10 of the 18 kinds present. Its instruction to LIVE-2A was to turn that into a permanent test for EVERY kind
// in `GAMEPLAY_MESSAGE_SCHEMA`: the read audit, and "the canonical bytes of each corpus payload are unchanged by
// `parseGameplayMessage`". Both are here, with the parse's own contract: a NEW object, rebuilt from declared fields
// alone at every depth, bounded, with no inherited key anywhere.

import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

import {
  GAMEPLAY_MESSAGE_KINDS,
  GAMEPLAY_MESSAGE_SCHEMA,
  MAX_CHAT_TEXT_LENGTH,
  frameHazard,
  parseClientFrame,
  parseGameplayMessage,
  sanitizeName,
  sanitizeText,
} from "../gameEngine/messageSchema";
import { canonicalJson } from "../gameEngine/stateDigest";
import { RoomSession, type ServerLogEntry } from "./roomSession";
import { sandboxReplayProviders } from "../gameEngine/replayProviders";
import {
  DEFAULT_SANDBOX_SCENARIO,
  sandboxScenario,
  sandboxScenarioState,
  sandboxWaterfallState,
} from "../gameEngine/sandboxState";
import { waterfallForRoster, withEmptyRoster } from "../gameEngine/gameSetup";
import { DEVELOPMENT_CORPUS_POLICY } from "../gameEngine/rulesVersion";

/* ------------------------------------------------------------------ */
/* Fixtures: one well-formed body per kind, from the declared shapes   */
/* ------------------------------------------------------------------ */

/** A value of the declared kind -- the smallest well-formed one. */
function sample(spec: string): unknown {
  const kind = spec.endsWith("?") ? spec.slice(0, -1) : spec;
  if (kind.startsWith("enum:")) return kind.slice(5).split("|")[0];
  switch (kind) {
    case "int":
    case "int|null":
      return 1;
    case "finite":
      return 0.5;
    case "finite|amount":
    case "amount":
      return "10";
    case "bool":
      return true;
    case "id":
    case "id|null":
      return "2";
    case "narration":
    case "narration|null":
      return "p-a";
    case "summary":
      return "Undo — a move";
    case "waypoints":
      return [{ hex: "E5", city_node: 0, bypass: false }];
    case "routes":
      return [[{ hex: "E5", city_node: 0 }, { hex: "F6" }]];
    case "ints":
      return [0, 1];
    case "ids":
      return ["2", "3"];
    case "pairs":
      return [[1, 0]];
    case "choices":
      return [{ company_id: 1, payout: true }];
    case "players":
      return [
        { id: "p-a", nickname: "A", color: "red" },
        { id: "p-b", nickname: "B" },
      ];
    case "variants":
      return { length: "standard", mode: "live", gentleRust: false, rules: 1 };
    default:
      throw new Error(`no sample for ${spec}`);
  }
}

function fixture(kind: string): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const [field, spec] of Object.entries(GAMEPLAY_MESSAGE_SCHEMA[kind])) body[field] = sample(spec);
  return { [kind]: body };
}

/** Every nested object in a value gets an undeclared key; returns the polluted copy. */
function polluted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(polluted);
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = { undeclaredProbe: "x".repeat(100) };
    for (const [key, inner] of Object.entries(value)) out[key] = polluted(inner);
    return out;
  }
  return value;
}

/* ------------------------------------------------------------------ */
/* The parse's contract                                                */
/* ------------------------------------------------------------------ */

describe("parseGameplayMessage rebuilds every kind from its declared fields (LIVE-2 §11.1)", () => {
  it.each(GAMEPLAY_MESSAGE_KINDS.map((kind) => [kind]))("%s: a well-formed body round-trips exactly", (kind) => {
    const msg = fixture(kind);
    const parsed = parseGameplayMessage(msg);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).not.toBe(msg);
    expect(canonicalJson(parsed.value)).toBe(canonicalJson(msg));
    expect(parsed.stripped).toBe(0);
  });

  it.each(GAMEPLAY_MESSAGE_KINDS.map((kind) => [kind]))(
    "%s: undeclared fields -- top level and nested at every depth -- are stripped, and counted",
    (kind) => {
      const clean = fixture(kind);
      const dirty = { [kind]: polluted((clean as Record<string, unknown>)[kind]) };
      const parsed = parseGameplayMessage(dirty);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(canonicalJson(parsed.value)).toBe(canonicalJson(clean));
      expect(JSON.stringify(parsed.value)).not.toContain("undeclaredProbe");
      expect(parsed.stripped).toBeGreaterThanOrEqual(1);
    },
  );

  it("bounds every string and array kind, and every integer is safe (§11.3)", () => {
    const refused = (msg: unknown) => {
      const parsed = parseGameplayMessage(msg);
      return parsed.ok ? null : parsed.reason;
    };
    expect(refused({ BuyStock: { protocol_id: 2 ** 53, source: "Ipo" } })).toMatch(/whole number/);
    expect(refused({ LayTile: { protocol_id: 1, q: 1e300, r: 0, tile_id: 7, orientation: 0 } })).toMatch(/whole number/);
    expect(refused({ DiscardTrain: { protocol_id: 1, model_type: "x".repeat(33) } })).toMatch(/too long/);
    expect(refused({ DeclareDividends: { protocol_id: 1, revenue_amount: "9".repeat(33), distribute: true } })).toMatch(/too long/);
    expect(refused({ SetBoPar: { player: "p".repeat(65), par_value: "100" } })).toMatch(/too long/);
    expect(refused({ RevertTo: { index: 1, player: "p-a", summary: "s".repeat(161) } })).toMatch(/too long/);
    expect(refused({ RevertTo: { index: 1, player: "p-a", summary: "s".repeat(160) } })).toBeNull();
    expect(refused({ RunMultipleRoutes: { protocol_id: 1, routes: [], train_indices: Array(17).fill(0) } })).toMatch(/more than 16/);
    expect(refused({ ExecuteOperatingRound: { public_company_choices: Array(17).fill({ company_id: 1, payout: true }) } })).toMatch(/more than 16/);
    expect(refused({ RunManualRoute: { protocol_id: 1, path: Array(513).fill({ hex: "A1" }), payout_strategy: "Withhold" } })).toMatch(/more than 512/);
  });

  it("closes the nested shapes: waypoints, the deal's players, token_cities pairs, payout choices (§11.3)", () => {
    const ok = (msg: unknown) => parseGameplayMessage(msg).ok;
    expect(ok({ RunManualRoute: { protocol_id: 1, path: [{ hex: "A1", city_node: 1.5 }], payout_strategy: "Withhold" } })).toBe(false);
    expect(ok({ RunManualRoute: { protocol_id: 1, path: [{ hex: "A".repeat(17) }], payout_strategy: "Withhold" } })).toBe(false);
    expect(ok({ SetupGame: { players: [{ nickname: "no id" }] } })).toBe(false);
    expect(ok({ SetupGame: { players: [{ id: 7 }] } })).toBe(false);
    expect(ok({ SetupGame: { players: [{ id: "p-a", color: "c".repeat(33) }] } })).toBe(false);
    expect(ok({ LayTile: { protocol_id: 1, q: 0, r: 0, tile_id: 7, orientation: 0, token_cities: [[1]] } })).toBe(false);
    expect(ok({ LayTile: { protocol_id: 1, q: 0, r: 0, tile_id: 7, orientation: 0, token_cities: [[1, "2"]] } })).toBe(false);
    expect(ok({ ExecuteOperatingRound: { public_company_choices: [{ company_id: 1 }] } })).toBe(false);
    expect(ok({ SetupGame: { players: [], variants: { length: "forever" } } })).toBe(false);
  });

  it("refuses inherited keys anywhere, and never answers with the frame's own text (§11.1 item 4, §11.4)", () => {
    for (const text of [
      '{"constructor":{}}',
      '{"__proto__":{"PassTurn":{}}}',
      '{"PassTurn":{"__proto__":{"polluted":1}}}',
      '{"SetupGame":{"players":[{"id":"p-a","constructor":1}]}}',
      '{"RunManualRoute":{"protocol_id":1,"path":[{"hex":"A1","prototype":{}}],"payout_strategy":"Withhold"}}',
    ]) {
      const parsed = parseGameplayMessage(JSON.parse(text));
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.reason).not.toMatch(/constructor|__proto__|prototype|polluted/);
    }
    for (const kind of ["toString", "hasOwnProperty", "valueOf", "constructor"]) {
      const parsed = parseGameplayMessage({ [kind]: {} });
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.reason).not.toContain(kind);
    }
    expect(GAMEPLAY_MESSAGE_SCHEMA.constructor).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    const two = parseGameplayMessage({ PassTurn: {}, DropTable_7731: {} });
    expect(two.ok).toBe(false);
    if (!two.ok) expect(two.reason).not.toContain("DropTable_7731");
    const unknown = parseGameplayMessage({ DropTable_7731: {} });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.reason).not.toContain("DropTable_7731");
  });

  it("scans iteratively: ten thousand nested arrays are refused, not a stack overflow", () => {
    let deep: unknown = 0;
    for (let n = 0; n < 10_000; n += 1) deep = [deep];
    expect(frameHazard({ PassTurn: { game_id: deep } })).toBe("too-deep");
    expect(parseGameplayMessage({ PassTurn: { game_id: deep } }).ok).toBe(false);
  });
});

describe("the closed control frames (LIVE-2 §11.2)", () => {
  /* LIVE-2D: every game is addressed by its server-minted `gameId`; the legacy room protocol is gone. */
  const GAME = "g_0123456789abcdefghjkmnpqr0";
  const VARIANTS = { length: "standard", mode: "live", delayedAuction: false, gentleRust: false, unpredictableRevenue: false, dynamicStockMarket: false, expandedMap: false, plusTiles: false, levelPlayingField: false };

  it("accepts what today's client sends, field for field", () => {
    const good = [
      { kind: "hello", gameId: GAME, build: "dev", baseIndex: 7, baseId: "s1-1" },
      { kind: "hello", gameId: GAME, build: "dev", baseIndex: -1 },
      { kind: "submit", build: "dev", msg: { PassTurn: {} }, baseIndex: -1, baseId: "s1-1", submissionId: "ab12-3" },
      { kind: "room-hello", gameId: GAME },
      { kind: "chat-send", gameId: GAME, text: "x".repeat(MAX_CHAT_TEXT_LENGTH) },
      { kind: "presence-set", gameId: GAME, state: { playerId: "p-abc", at: 1, routeDrafts: { 0: [[1, 2]] }, routeValues: { 0: 90 }, actingCompanyId: 3 } },
      { kind: "presence-set", gameId: GAME, state: null },
      { kind: "rooms-watch", on: true },
      { kind: "rooms-watch", on: false },
      { kind: "room-op", requestId: "rmf2k1", op: { type: "create", visibility: "public", exactPlayers: null, variants: VARIANTS, nickname: "Host" } },
      { kind: "room-op", requestId: "rmf2k2", op: { type: "create", visibility: "private", exactPlayers: 4, variants: VARIANTS, nickname: "Host", color: null, stake: "5000000" } },
      { kind: "room-op", requestId: "rmf2k3", op: { type: "join", code: "JUNO-7K4M-Q2ZP", takeSeat: true } },
      { kind: "room-op", requestId: "rmf2k4", gameId: GAME, op: { type: "take-seat" } },
      { kind: "room-op", requestId: "rmf2k5", gameId: GAME, op: { type: "release-seat" } },
      { kind: "room-op", requestId: "rmf2k6", gameId: GAME, op: { type: "leave" } },
      { kind: "room-op", requestId: "rmf2k7", gameId: GAME, op: { type: "set-ready", ready: true } },
      { kind: "room-op", requestId: "rmf2k8", gameId: GAME, op: { type: "set-profile", nickname: "Ada", color: null } },
      { kind: "room-op", requestId: "rmf2k9", gameId: GAME, op: { type: "set-visibility", visibility: "private" } },
      { kind: "room-op", requestId: "rmf2ka", gameId: GAME, op: { type: "rotate-code" } },
      { kind: "room-op", requestId: "rmf2kb", gameId: GAME, op: { type: "kick", playerId: "p-0123456789abcdef" } },
      { kind: "room-op", requestId: "rmf2kc", gameId: GAME, op: { type: "transfer-host", toPlayerId: "p-0123456789abcdef" } },
      { kind: "room-op", requestId: "rmf2kd", gameId: GAME, op: { type: "start-game" } },
      { kind: "room-op", requestId: "rmf2ke", gameId: GAME, op: { type: "cancel-room" } },
    ];
    for (const frame of good) {
      const label = `${frame.kind}${"op" in frame ? `:${(frame.op as { type: string }).type}` : ""}`;
      expect([label, parseClientFrame(JSON.parse(JSON.stringify(frame))).ok]).toEqual([label, true]);
    }
  });

  it("refuses an unknown field, a deleted op, a deleted frame kind, and an oversized value", () => {
    const bad = [
      { kind: "hello", gameId: GAME, build: "dev", extra: 1 },
      /* LIVE-2B: identity is the upgrade's; a frame that names one is refused. */
      { kind: "hello", gameId: GAME, build: "dev", claim: "p-abc" },
      { kind: "room-hello", gameId: GAME, claim: "p-abc" },
      /* LIVE-2D: no room code as a key, and no seat PIN or token, on any frame. */
      { kind: "hello", room: "JUNO-4T2", build: "dev" },
      { kind: "hello", gameId: GAME, build: "dev", pin: "1234" },
      { kind: "hello", gameId: GAME, build: "dev", token: "k3-abc" },
      { kind: "hello", build: "dev" },
      { kind: "hello", gameId: "JUNO-7K4M-Q2ZP", build: "dev" },
      { kind: "room-hello", room: "JUNO-4T2" },
      { kind: "room-hello", room: "~lobby" },
      { kind: "chat-send", room: "JUNO-4T2", text: "hi" },
      /* The server signs a chat line; a frame cannot name its author. */
      { kind: "chat-send", gameId: GAME, text: "hi", displayName: "A" },
      { kind: "chat-send", gameId: GAME, text: "hi", author: "p-0123456789abcdef" },
      { kind: "presence-set", room: "JUNO-4T2", state: null },
      /* The retired legacy protocol, kind by kind. */
      { kind: "find-seats", requestId: "r1", pin: "1234" },
      { kind: "room-write", room: "JUNO-4T2", write: { op: "upsert-player", player: { id: "p-abc", nickname: "A", isReady: true } } },
      { kind: "room-write", room: "JUNO-4T2", write: { op: "forced-sign", stage: "mark" } },
      { kind: "seat-pin", room: "JUNO-4T2", requestId: "r1-x", playerId: "p-abc", pin: "1234" },
      { kind: "claim-seat", room: "JUNO-4T2", requestId: "r1-x", playerId: "p-abc", pin: "1234" },
      { kind: "lobby-hello" },
      { kind: "lobby-watch", roomId: null },
      { kind: "lobby-write", requestId: "r2", write: { op: "heartbeat", roomId: "r1" } },
      /* No room op names who is asking, a host, a record field, or a rules revision. */
      { kind: "room-op", requestId: "r3", op: { type: "create", visibility: "public", exactPlayers: null, variants: { ...VARIANTS, rules: 1 }, nickname: "H" } },
      { kind: "room-op", requestId: "r3", op: { type: "create", visibility: "public", exactPlayers: null, variants: VARIANTS, nickname: "H", hostId: "p-0123456789abcdef" } },
      { kind: "room-op", requestId: "r3", op: { type: "join", code: "JUNO-7K4M-Q2ZP", takeSeat: true, playerId: "p-0123456789abcdef" } },
      { kind: "room-op", requestId: "r3", gameId: GAME, op: { type: "set-ready", ready: true, playerId: "p-0123456789abcdef" } },
      { kind: "room-op", requestId: "r3", gameId: GAME, op: { type: "kick", playerId: "alice" } },
      { kind: "room-op", requestId: "r3", gameId: GAME, op: { type: "set-variants", variants: VARIANTS } },
      { kind: "room-op", requestId: "r3", gameId: GAME, op: { type: "start-game", deal: { players: [] } } },
      { kind: "room-op", requestId: "r3", gameId: GAME, actor: "p-0123456789abcdef", op: { type: "start-game" } },
      { kind: "chat-send", gameId: GAME, text: "x".repeat(MAX_CHAT_TEXT_LENGTH + 1) },
      { kind: "presence-set", gameId: GAME, state: { routeDrafts: { 16: [[1, 2]] } } },
      { kind: "presence-set", gameId: GAME, state: { routeDrafts: { 0: [[1, 257]] } } },
      { kind: "presence-set", gameId: GAME, state: { routeValues: { 0: 1_000_001 } } },
      { kind: "hello", gameId: `${GAME}${"x".repeat(41)}`, build: "dev" },
      { kind: "submit", build: "dev", msg: {}, baseIndex: 0, submissionId: "a", sneaky: true },
    ];
    for (const frame of bad) expect([JSON.stringify(frame).slice(0, 90), parseClientFrame(frame).ok]).toEqual([JSON.stringify(frame).slice(0, 90), false]);
  });
});

describe("the single sanitizer (LIVE-2 §11.2)", () => {
  it("normalizes to NFC and strips every control and format character, bidi overrides included", () => {
    expect(sanitizeText("é", 10)).toBe("é");
    expect(sanitizeText("a‮b⁦c\u0007d​e", 10)).toBe("abcde");
    expect(sanitizeText("😀😀😀", 2)).toBe("😀😀");
    expect(sanitizeName("  Bob \t the\n Builder ‮ ", 24)).toBe("Bob the Builder");
    expect(sanitizeName("x".repeat(30), 24)).toHaveLength(24);
    expect(sanitizeName(7, 24)).toBe("");
  });
});

/* ------------------------------------------------------------------ */
/* The reducer reads only declared fields -- every kind, and the corpus */
/* ------------------------------------------------------------------ */

const SEATS = [
  { id: "p-a", nickname: "A" },
  { id: "p-b", nickname: "B" },
];

function room(entries?: readonly ServerLogEntry[]): RoomSession {
  let minted = 0;
  const session = new RoomSession({
    providers: sandboxReplayProviders(),
    seed: {
      state: withEmptyRoster(sandboxScenarioState(DEFAULT_SANDBOX_SCENARIO, 0, "default")),
      waterfall: waterfallForRoster(sandboxWaterfallState(sandboxScenario(DEFAULT_SANDBOX_SCENARIO).phase, 0, true), []),
    },
    build: "dev",
    mintId: () => `t-${(minted += 1)}`,
    replayPolicy: DEVELOPMENT_CORPUS_POLICY,
  });
  if (entries) session.restore(entries);
  return session;
}

/** Names a JS runtime asks of any object in passing -- not message fields. */
const RUNTIME_NAMES = new Set(["toJSON", "then", "constructor", "valueOf", "toString", "$$typeof", "asymmetricMatch", "nodeType", "length"]);

/** Wrap every object in a message in a read-recording proxy; `reads` collects `path.field` for each get. */
function tracked(value: unknown, path: string, reads: Set<string>): unknown {
  if (typeof value !== "object" || value === null) return value;
  const inner: unknown = Array.isArray(value)
    ? value.map((item) => tracked(item, `${path}[]`, reads))
    : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, tracked(item, `${path}.${key}`, reads)]));
  return new Proxy(inner as object, {
    get(target, property, receiver) {
      if (typeof property === "string" && !RUNTIME_NAMES.has(property) && !/^\d+$/.test(property)) {
        reads.add(Array.isArray(target) ? `${path}[].${property}` : `${path}.${property}`);
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

/** The field paths a kind declares (top-level, and the closed nested shapes' own fields). */
function declaredPaths(kind: string): Set<string> {
  const out = new Set<string>([kind]);
  for (const [field, spec] of Object.entries(GAMEPLAY_MESSAGE_SCHEMA[kind])) {
    const base = `${kind}.${field}`;
    out.add(base);
    const shape = spec.replace(/\?$/, "");
    const nested: Record<string, string[]> = {
      waypoints: ["hex", "city_node", "bypass"],
      routes: ["hex", "city_node", "bypass"],
      players: ["id", "nickname", "color"],
      choices: ["company_id", "payout"],
      variants: ["length", "mode", "delayedAuction", "gentleRust", "unpredictableRevenue", "dynamicStockMarket", "expandedMap", "plusTiles", "levelPlayingField", "rules"],
    };
    for (const inner of nested[shape] ?? []) {
      out.add(`${base}.${inner}`);
      out.add(`${base}[].${inner}`);
      out.add(`${base}[][].${inner}`);
    }
  }
  return out;
}

/** Array methods an engine calls on a declared array are reads of the ARRAY, not of an undeclared field. */
const ARRAY_METHOD = /\[\]\.(map|filter|find|some|every|forEach|reduce|slice|includes|indexOf|concat|entries|keys|values|flatMap|join|sort|findIndex|at|push|flat)$|\.(map|filter|find|some|every|forEach|reduce|slice|includes|indexOf|concat|entries|keys|values|flatMap|join|sort|findIndex|at|push|flat)$/;

describe("the reducer reads only declared fields (LIVE-2 §11.2, Appendix A.2 made permanent)", () => {
  it("for every kind in the schema, on a dealt board: no undeclared field is read", () => {
    const undeclared: string[] = [];
    const everyRead = new Set<string>();
    for (const kind of GAMEPLAY_MESSAGE_KINDS) {
      const session = room();
      session.submit({ actor: "p-a", build: "dev", baseIndex: -1, msg: { SetupGame: { build: "dev", players: SEATS, variants: { rules: 1 } } } as never, submissionId: "deal" });
      const reads = new Set<string>();
      const msg = tracked(fixture(kind), "", reads) as never;
      try {
        session.submit({ actor: "p-a", build: "dev", baseIndex: session.nextIndex - 1, msg, submissionId: `k-${kind}` });
      } catch {
        /* a synthetic body the engine throws on is still a body whose reads were recorded */
      }
      const declared = declaredPaths(kind);
      reads.forEach((read) => everyRead.add(read.replace(/^\./, "")));
      for (const read of Array.from(reads)) {
        const clean = read.replace(/^\./, "");
        if (ARRAY_METHOD.test(clean)) continue;
        if (!declared.has(clean)) undeclared.push(clean);
      }
    }
    expect(undeclared).toEqual([]);
    /* NOT VACUOUS: the proxies did see the engine read the declared fields it decides on. */
    expect(everyRead.size).toBeGreaterThan(40);
    for (const read of ["BuyStock.protocol_id", "LayTile.tile_id", "RevertTo.index"]) expect(everyRead).toContain(read);
  });

  const FIXTURES = join(__dirname, "__fixtures__");
  const corpus = (): string[] => {
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const at = join(dir, name);
        if (statSync(at).isDirectory()) walk(at);
        else if (name.endsWith(".jsonl")) out.push(at);
      }
    };
    walk(FIXTURES);
    return out;
  };

  it("replaying every corpus log reads no undeclared field", () => {
    const files = corpus();
    expect(files.length).toBeGreaterThan(0);
    const reads = new Set<string>();
    const original = JSON.parse;
    const kinds = new Set(GAMEPLAY_MESSAGE_KINDS);
    JSON.parse = ((text: string, reviver?: (this: unknown, key: string, value: unknown) => unknown) => {
      const value = original(text, reviver);
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        const keys = Object.keys(value);
        if (keys.length === 1 && kinds.has(keys[0])) return tracked(value, "", reads);
      }
      return value;
    }) as typeof JSON.parse;
    let replayed = 0;
    try {
      for (const file of files) {
        const entries = readFileSync(file, "utf8")
          .split("\n")
          .filter((line) => line.trim())
          .map((line) => original(line) as ServerLogEntry);
        room(entries);
        replayed += entries.length;
      }
    } finally {
      JSON.parse = original;
    }
    expect(replayed).toBeGreaterThan(200);
    // NOT VACUOUS: Appendix A.2's reads, seen again.
    for (const read of ["SetupGame.players", "SetupGame.variants", "RevertTo.index", "LayTile.tile_id"]) {
      expect(Array.from(reads).map((r) => r.replace(/^\./, ""))).toContain(read);
    }
    const undeclared = Array.from(reads)
      .map((read) => read.replace(/^\./, ""))
      .filter((read) => !ARRAY_METHOD.test(read))
      .filter((read) => !declaredPaths(read.split(/[.[]/)[0]).has(read));
    expect(undeclared).toEqual([]);
  });

  it("the canonical bytes of every corpus payload are unchanged by the parse -- nothing real is stripped", () => {
    let checked = 0;
    const changed: string[] = [];
    for (const file of corpus()) {
      for (const line of readFileSync(file, "utf8").split("\n")) {
        if (!line.trim()) continue;
        const entry = JSON.parse(line) as { payload: string };
        const msg = JSON.parse(entry.payload);
        const parsed = parseGameplayMessage(msg);
        checked += 1;
        if (!parsed.ok) {
          changed.push(`${file}: refused -- ${parsed.reason}`);
          continue;
        }
        if (canonicalJson(parsed.value) !== canonicalJson(msg) || parsed.stripped !== 0) {
          changed.push(`${file}: ${Object.keys(msg)[0]} changed`);
        }
      }
    }
    expect(checked).toBeGreaterThan(200);
    expect(changed).toEqual([]);
  });
});
