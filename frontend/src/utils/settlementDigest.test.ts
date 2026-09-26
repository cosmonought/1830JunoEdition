/** @jest-environment node */
// frontend/src/utils/settlementDigest.test.ts
//
// ==================================================================
//  SET-0B: terminal_state_hash_v1 AND THE COMMITTED-STATE APPRAISAL
// ==================================================================
//
// The hash is pinned to the SET-0A goldens (settlementGoldens.test.ts). This suite pins the CONSTRUCTION -- tag,
// shared canonical form, determinism under construction order, refusal of anything that is not plainly hashable --
// and the one property the committed-state helper exists for: the vector is appraised from exactly the bytes that
// were hashed, never from a live object that could say something else.

import { canonicalJson } from "../gameEngine/stateDigest";
import { sha256Hex } from "../gameEngine/sha256";
import {
  STATE_HASH_TAG_V1,
  appraiseCommittedState,
  commitAndAppraise,
  canonicalStateText,
  terminalStateHashV1,
  terminalStateHashV1OfText,
} from "../gameEngine/settlementDigest";
import { SettlementAppraisalError, baseNetWorthVector, type SettlementSeat } from "../gameEngine/settlementAppraisal";
import * as engine from "../gameEngine";
import type { GameStateResponse } from "../gameEngine/gameState";
import { goldenBoards } from "./settlementGoldenBoards";

type Loose = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const SYN01 = goldenBoards().boards["SYN-01-CLASSIC-BANKBREAK"];
const SYN01_HASH = "8b5b24d510eb021b08ea25a05d4a18246f5c01793a97845dfdb2d436fe276b2c";
const SEATS: SettlementSeat[] = [
  { seat_index: 0, player_id: "p2" },
  { seat_index: 1, player_id: "p1" },
  { seat_index: 2, player_id: "p3" },
];
const copy = (): Loose => JSON.parse(JSON.stringify(SYN01)) as Loose;

function code(run: () => unknown): string {
  try {
    run();
    return "OK";
  } catch (error) {
    if (!(error instanceof SettlementAppraisalError)) throw error;
    return error.code;
  }
}

describe("terminal_state_hash_v1: the construction", () => {
  it("is SHA-256 over the tag and the shared canonicalJson, nothing else", () => {
    expect(STATE_HASH_TAG_V1).toBe("18JUNO/STATE/v1\n");
    expect(terminalStateHashV1(SYN01)).toBe(sha256Hex(`18JUNO/STATE/v1\n${canonicalJson(SYN01)}`));
    expect(terminalStateHashV1(SYN01)).toBe(SYN01_HASH);
    expect(canonicalStateText(SYN01)).toBe(canonicalJson(SYN01));
    expect(terminalStateHashV1OfText(canonicalStateText(SYN01))).toBe(SYN01_HASH);
  });

  it("is lowercase hex of 32 bytes", () => {
    expect(terminalStateHashV1(SYN01)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is independent of object construction order (sorted keys, recursively)", () => {
    const reversed = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(reversed);
      if (value && typeof value === "object") {
        const out: Loose = {};
        for (const key of Object.keys(value as object).reverse()) out[key] = reversed((value as Loose)[key]);
        return out;
      }
      return value;
    };
    const rebuilt = reversed(SYN01) as GameStateResponse;
    expect(Object.keys(rebuilt)[0]).not.toBe(Object.keys(SYN01)[0]);
    expect(terminalStateHashV1(rebuilt)).toBe(SYN01_HASH);
  });

  it("drops undefined and keeps null, as the shared form does (#232)", () => {
    expect(terminalStateHashV1({ ...copy(), some_new_field: undefined } as unknown as GameStateResponse)).toBe(SYN01_HASH);
    expect(terminalStateHashV1({ ...copy(), some_new_field: null } as unknown as GameStateResponse)).not.toBe(SYN01_HASH);
  });

  it("normalises -0 to 0, as the shared form does", () => {
    const negZero = copy();
    negZero.consecutive_passes = -0;
    expect(terminalStateHashV1(negZero as GameStateResponse)).toBe(SYN01_HASH);
  });

  it("any one-field mutation changes the hash (cash, share, price, private, bankrupt, variant, array order, nested flag)", () => {
    const mutations: Array<(b: Loose) => void> = [
      (b) => { b.player_cash[0].cash_vgp = "641"; },
      (b) => { b.public_companies[0].player_holdings[0].percentage = 50; },
      (b) => { b.market_positions["1"].price = 101; },
      (b) => { b.private_companies[0].closed = true; },
      (b) => { b.bankrupt_president = "p1"; },
      (b) => { b.variants.gentleRust = true; },
      (b) => { b.active_operating_order = [1, 2, 3, 4, 5]; },
      (b) => { b.public_companies[0].treasury = "701"; }, // not an appraisal input, still committed
      (b) => { b.player_addresses = ["p2", "p1", "p3"]; },
    ];
    const seen = new Set<string>([SYN01_HASH]);
    for (const mutate of mutations) {
      const b = copy();
      mutate(b);
      const hash = terminalStateHashV1(b as GameStateResponse);
      expect(seen.has(hash)).toBe(false);
      seen.add(hash);
    }
  });
});

describe("terminal_state_hash_v1: what cannot be hashed is refused, not sentinelled", () => {
  const cases: Array<[string, (b: Loose) => void]> = [
    ["NaN", (b) => { b.macro_round_number = NaN; }],
    ["Infinity", (b) => { b.macro_round_number = Infinity; }],
    ["a bigint (canonicalJson would write null)", (b) => { b.player_cash[0].cash_vgp = BigInt(640); }],
    ["a function", (b) => { b.hook = () => 1; }],
    ["a symbol", (b) => { b.tag = Symbol("x"); }],
    ["a Date (a non-plain object)", (b) => { b.at = new Date(0); }],
    ["a Map", (b) => { b.lookup = new Map(); }],
    ["a class instance", (b) => { b.thing = new (class Thing { x = 1; })(); }],
    ["a getter", (b) => { Object.defineProperty(b, "sneaky", { enumerable: true, get: () => 1 }); }],
    ["a cycle", (b) => { b.self = b; }],
    ["NaN deep inside an array", (b) => { b.public_companies[2].station_tokens[0][2] = NaN; }],
  ];
  for (const [name, mutate] of cases) {
    it(name, () => {
      const b = copy();
      mutate(b);
      expect(code(() => terminalStateHashV1(b as GameStateResponse))).toBe("STATE_NOT_HASHABLE");
      expect(code(() => canonicalStateText(b as GameStateResponse))).toBe("STATE_NOT_HASHABLE");
    });
  }
  it("a board that is not a plain object: undefined, null, an array, a string, a number (review L5)", () => {
    for (const bad of [undefined, null, [], "x", 5]) {
      expect(code(() => terminalStateHashV1(bad as unknown as GameStateResponse))).toBe("STATE_NOT_HASHABLE");
    }
  });
  const moreCases: Array<[string, (b: Loose) => void]> = [
    ["a hole in an array (canonicalJson would write [1,,3], which is not JSON; review L1)", (b) => { b.pad = [1, , 3]; }], // eslint-disable-line no-sparse-arrays
    ["an undefined array element (canonicalJson would write null; the parse would disagree with the live read)", (b) => { b.pad = [1, undefined, 3]; }],
    ["a non-enumerable field (hashed by nobody, readable by anybody; review M2)", (b) => { Object.defineProperty(b, "bankrupt_president", { value: "p1", enumerable: false }); }],
    ["a symbol key", (b) => { b[Symbol("hidden") as unknown as string] = 1; }],
    ["a __proto__ own key", (b) => { Object.defineProperty(b, "__proto__", { value: { bankrupt_president: "p1" }, enumerable: true }); }],
    ["a non-index key on an array", (b) => { const list = [1, 2]; (list as unknown as Loose).extra = 3; b.pad = list; }],
  ];
  for (const [name, mutate] of moreCases) {
    it(name, () => {
      const b = copy();
      mutate(b);
      expect(code(() => terminalStateHashV1(b as GameStateResponse))).toBe("STATE_NOT_HASHABLE");
    });
  }
  it("a Proxy is read once per field: its get trap cannot put a sentinel into the committed text (review M1)", () => {
    const target = copy();
    let reads = 0;
    const px = new Proxy(target, { get: (t, key) => (key === "macro_round_number" && (reads += 1) > 1 ? Infinity : (t as Loose)[key as string]) });
    const text = canonicalStateText(px as GameStateResponse);
    expect(text).not.toContain("__nonfinite");
    expect(text).toBe(canonicalStateText(target as GameStateResponse));
  });
  it("a Proxy whose descriptors change between reads still yields ONE committed board: hash and vector come from the same text", () => {
    const target = copy();
    let reads = 0;
    const cashRow = target.player_cash[1] as Loose; // p2
    const px = new Proxy(cashRow, {
      getOwnPropertyDescriptor: (t, key) => {
        const d = Reflect.getOwnPropertyDescriptor(t, key);
        return key === "cash_vgp" && d && (reads += 1) > 1 ? { ...d, value: "999999" } : d;
      },
    });
    target.player_cash[1] = px;
    const committed = commitAndAppraise(target as GameStateResponse, SEATS);
    const reparsed = JSON.parse(committed.canonical_text) as Loose;
    expect(committed.appraisal_state_hash).toBe(sha256Hex(`18JUNO/STATE/v1\n${committed.canonical_text}`));
    expect(String(committed.vector[0])).toBe(String(BigInt(reparsed.player_cash[1].cash_vgp) + BigInt(1338 + 150)));
  });
  it("text carrying a __proto__ key is refused on the committed path too (review I1)", () => {
    const text = canonicalStateText(SYN01).replace('{"active_corporation_index"', '{"__proto__":{"bankrupt_president":"p1"},"active_corporation_index"');
    expect(code(() => appraiseCommittedState(text, SEATS))).toBe("STATE_NOT_HASHABLE");
  });
  it("an object with a null prototype is plain and hashes like its literal twin", () => {
    const bare = Object.assign(Object.create(null) as Loose, copy());
    expect(terminalStateHashV1(bare as GameStateResponse)).toBe(SYN01_HASH);
  });
  it("a canonicalJson sentinel string is refused wherever it appears (review recheck, M1 residual)", () => {
    const b = copy();
    b.note = "__nonfinite:NaN";
    expect(code(() => terminalStateHashV1(b as GameStateResponse))).toBe("STATE_NOT_HASHABLE");
    // Raw canonicalJson of a board with no JSON form cannot be committed through the text path either.
    const bad = copy();
    bad.macro_round_number = Infinity;
    const rawText = canonicalJson(bad);
    expect(rawText).toContain("__nonfinite:Infinity");
    expect(code(() => appraiseCommittedState(rawText, SEATS))).toBe("STATE_NOT_HASHABLE");
    expect(code(() => terminalStateHashV1OfText(rawText))).toBe("STATE_NOT_HASHABLE");
  });
  it("-0 anywhere is read as 0 by both paths (review recheck H1)", () => {
    const b = copy();
    b.public_companies[5].bank_pool_percentage = -0;
    expect(terminalStateHashV1(b as GameStateResponse)).toBe(SYN01_HASH);
    expect(commitAndAppraise(b as GameStateResponse, SEATS).vector.map(String)).toEqual(["2018", "2448", "2409"]);
    expect(baseNetWorthVector(b as GameStateResponse, SEATS).map(String)).toEqual(["2018", "2448", "2409"]);
  });
  it("a revoked Proxy and pathological nesting are coded refusals, not raw errors (review recheck H5, H6)", () => {
    const { proxy, revoke } = Proxy.revocable(copy(), {});
    revoke();
    expect(code(() => terminalStateHashV1({ ...copy(), inner: proxy } as unknown as GameStateResponse))).toBe("STATE_NOT_HASHABLE");
    let deep: Loose = {};
    const root = deep;
    for (let i = 0; i < 50000; i += 1) {
      deep.next = {};
      deep = deep.next;
    }
    expect(code(() => terminalStateHashV1({ ...copy(), deep: root } as unknown as GameStateResponse))).toBe("STATE_NOT_HASHABLE");
  });
  it("two separate live calls can see two boards if the caller mutates between them; commitAndAppraise cannot", () => {
    const live = copy();
    const hash = terminalStateHashV1(live as GameStateResponse);
    live.player_cash[1].cash_vgp = "5000";
    expect(hash).toBe(SYN01_HASH);
    expect(String(baseNetWorthVector(live as GameStateResponse, SEATS)[0])).toBe("6488"); // the documented hazard
    const committed = commitAndAppraise(live as GameStateResponse, SEATS);
    expect(committed.appraisal_state_hash).toBe(sha256Hex(`18JUNO/STATE/v1\n${committed.canonical_text}`));
    expect(String(committed.vector[0])).toBe("6488");
    expect(committed.appraisal_state_hash).not.toBe(SYN01_HASH);
  });
});

describe("appraiseCommittedState: the vector is appraised from exactly the hashed bytes", () => {
  const text = canonicalStateText(SYN01);

  it("returns the hash of the text and the vector of the board those bytes encode", () => {
    const committed = appraiseCommittedState(text, SEATS);
    expect(committed.appraisal_state_hash).toBe(SYN01_HASH);
    expect(committed.vector.map(String)).toEqual(["2018", "2448", "2409"]);
    expect(committed.appraisals.map((seat) => seat.player_id)).toEqual(["p2", "p1", "p3"]);
  });

  it("the appraised board is a fresh deep-frozen parse, not any caller's object", () => {
    const committed = appraiseCommittedState(text, SEATS);
    expect(committed.state).not.toBe(SYN01);
    expect(Object.isFrozen(committed.state)).toBe(true);
    expect(Object.isFrozen((committed.state as Loose).public_companies[0].player_holdings[0])).toBe(true);
    expect(Object.isFrozen(committed)).toBe(true);
  });

  it("an accessor property is refused outright (a getter could answer the hash and the appraisal differently)", () => {
    /* The attack the helper exists for: hash a live object, then appraise it again, and a getter (or any mutation in
       between) makes the two describe different boards. An accessor is refused at hashing and at appraisal, and the
       committed path never reads a live object at all. */
    const live = copy();
    let reads = 0;
    Object.defineProperty(live.player_cash[0], "cash_vgp", { enumerable: true, get: () => ((reads += 1) === 1 ? "640" : "9999") });
    expect(code(() => canonicalStateText(live as GameStateResponse))).toBe("STATE_NOT_HASHABLE");
  });

  it("text that is not canonical is refused: whitespace, key order, number spelling, duplicate keys, overflow", () => {
    const pretty = JSON.stringify(JSON.parse(text), null, 1);
    const cases = [
      pretty,
      // two keys swapped:
      text.replace('{"active_corporation_index":4,"active_operating_order"', '{"active_operating_order":[2,1,3,4,5],"active_corporation_index":4,"_"').replace(',"_":[2,1,3,4,5]', ""),
      text.replace('"macro_round_number":3', '"macro_round_number":3.0'),
      text.replace('"macro_round_number":3', '"macro_round_number":3e0'),
      text.replace('"game_id":1', '"game_id":1,"game_id":1'),
      text.replace('"macro_round_number":3', '"macro_round_number":1e400'),
      `${text}\n`,
      ` ${text}`,
      "not json",
      "[]",
      "null",
    ];
    for (const bad of cases) expect(code(() => appraiseCommittedState(bad, SEATS))).toBe("NON_CANONICAL_STATE_TEXT");
    expect(code(() => appraiseCommittedState(SYN01 as unknown as string, SEATS))).toBe("NON_CANONICAL_STATE_TEXT");
    expect(code(() => terminalStateHashV1OfText(pretty))).toBe("NON_CANONICAL_STATE_TEXT");
  });

  it("a board mutated after its text was taken appraises the TEXT, not the mutation", () => {
    const live = copy();
    const committedText = canonicalStateText(live as GameStateResponse);
    live.player_cash[0].cash_vgp = "999999";
    const committed = appraiseCommittedState(committedText, SEATS);
    expect(committed.appraisal_state_hash).toBe(SYN01_HASH);
    expect(committed.vector.map(String)).toEqual(["2018", "2448", "2409"]);
  });

  it("appraisal refusals surface through the committed path unchanged", () => {
    const b = copy();
    delete b.market_positions["1"];
    expect(() => appraiseCommittedState(canonicalStateText(b as GameStateResponse), SEATS)).toThrow("PARRED_WITHOUT_MARK: PRR");
  });
});

describe("the engine's front door", () => {
  it("exports the four modules' public surface for the server (ESCROW-3)", () => {
    for (const name of [
      "appraiseSeats",
      "baseNetWorthVector",
      "SettlementAppraisalError",
      "appraiseCommittedState",
      "commitAndAppraise",
      "canonicalStateText",
      "terminalStateHashV1",
      "terminalStateHashV1OfText",
      "STATE_HASH_TAG_V1",
      "terminalSettlementWeights",
      "SETTLEMENT_REASON_CODE",
      "payoutPreview",
      "payoutPreviewDecimal",
      "U128_MAX",
    ]) {
      expect((engine as Record<string, unknown>)[name]).toBeDefined();
    }
  });
});
