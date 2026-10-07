/** @jest-environment node */
//
// Design note #1251 (harness): the settlement commitment, pinned to constants.
//
// THE CONSTANTS ARE THE TEST. A hash function that "works" is one whose output nobody has written down; the
// moment somebody changes the line format, the field order, or the digest, every checkpoint ever signed
// stops verifying -- and nothing else in this suite would notice. The values below were computed once and
// cross-checked against Node's `crypto` (SHA-256) at the time of writing. If this file goes red, either the
// change was intended (and every stored commitment is now void -- say so in a design note) or it was not.

export {};

const { sha256Hex, utf8Bytes } = require("../gameEngine/sha256") as typeof import("../gameEngine/sha256");
const { logHash, logHashInput, logEntryLine } =
  require("../gameEngine/logHash") as typeof import("../gameEngine/logHash");
const { buildSandboxLogExport } = require("./logExport") as typeof import("./logExport");

describe("SHA-256, against FIPS 180-4 and friends", () => {
  it("matches the published vectors", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")).toBe(
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    );
  });

  it("pads correctly at the block boundaries", () => {
    // 55, 56 and 64 bytes are the three lengths where a padding bug shows; cross-checked against node:crypto.
    expect(sha256Hex("x".repeat(55))).toMatch(/^d5e285683cd4efc0/);
    expect(sha256Hex("x".repeat(56))).toMatch(/^04c26261370ee754/);
    expect(sha256Hex("x".repeat(64))).toMatch(/^7ce100971f64e700/);
    expect(sha256Hex("x".repeat(119))).toMatch(/^000b48d4edf0fa7b/);
    expect(sha256Hex("a".repeat(1000))).toMatch(/^41edece42d63e8d9/);
  });

  it("hashes UTF-8 bytes, not UTF-16 code units", () => {
    /* Nicknames travel in `SetupGame`, and a nickname can be anything. The bytes of "Å" are two, of "✓"
       three, of "𝄞" four -- a hash over code units would agree with nobody else's. */
    expect(Array.from(utf8Bytes("Å✓𝄞"))).toEqual([0xc3, 0x85, 0xe2, 0x9c, 0x93, 0xf0, 0x9d, 0x84, 0x9e]);
    expect(sha256Hex("héllo wörld ✓ 𝄞")).toMatch(/^f7f53566f9b086b5/);
    // A lone surrogate encodes as U+FFFD, as TextEncoder does.
    expect(Array.from(utf8Bytes("\ud800"))).toEqual([0xef, 0xbf, 0xbd]);
  });
});

const ENTRIES = [
  { index: 1, actor: "p-bob", payload: '{"PassTurn":{"game_id":0}}', at: 1700000001000 },
  {
    index: 0,
    actor: "p-alice",
    payload: '{"SetupGame":{"players":[{"id":"p-alice","nickname":"Ålice"}],"variants":{}}}',
    at: 1700000000000,
    id: "s1",
    submission_id: "n1",
  },
  {
    index: 2,
    actor: "p-bob",
    payload: '{"AdvanceOperatingSubPhase":{"game_id":0,"protocol_id":1}}',
    derived: true,
  },
];

describe("the log hash, #1251", () => {
  it("pins the line format: (index, actor, at, derived) as JSON, a tab, the payload verbatim, a newline", () => {
    expect(logEntryLine({ index: 3, actor: "p-x", payload: "{}" })).toBe('[3,"p-x",null,false]\t{}\n');
    expect(logEntryLine({ index: 3, actor: "p-x", payload: "{}", at: 5, derived: true })).toBe(
      '[3,"p-x",5,true]\t{}\n',
    );
  });

  it("orders by index, hashes every rule-read field, and ignores id and nonce", () => {
    expect(logHashInput(ENTRIES)).toBe(
      '[0,"p-alice",1700000000000,false]\t{"SetupGame":{"players":[{"id":"p-alice","nickname":"Ålice"}],"variants":{}}}\n' +
        '[1,"p-bob",1700000001000,false]\t{"PassTurn":{"game_id":0}}\n' +
        '[2,"p-bob",null,true]\t{"AdvanceOperatingSubPhase":{"game_id":0,"protocol_id":1}}\n',
    );
    expect(logHash(ENTRIES)).toBe("def18ef5c1aa069033c7c520e3825e4abeefb605bfbac3a7b66da28dbe27c4c9");
    // The store's id and the transport's nonce are not the game's; changing them changes nothing.
    const renamed = ENTRIES.map((entry) => ({ ...entry, id: "other", submission_id: "other" }));
    expect(logHash(renamed)).toBe(logHash(ENTRIES));
  });

  it("changes when any hashed field changes -- the audit's four omissions included", () => {
    const base = logHash(ENTRIES);
    const edit = (at: number, patch: Partial<(typeof ENTRIES)[number]>) =>
      logHash(ENTRIES.map((entry, i) => (i === at ? { ...entry, ...patch } : entry)));
    expect(edit(0, { at: 1700000001001 })).not.toBe(base); // the clock reads `at`
    expect(edit(0, { actor: "p-carol" })).not.toBe(base); // the forfeit reads `actor`
    expect(edit(2, { derived: false })).not.toBe(base); // the reducer reads `derived`
    expect(edit(0, { payload: '{"PassTurn":{"game_id":1}}' })).not.toBe(base);
  });

  it("a prefix hashes on its own, which is what a checkpoint is", () => {
    expect(logHash(ENTRIES, 2)).toBe("d0b2965c0d0f6c08db9380b426d81b743d5840e2c694e9d2c33a15f7004e1098");
    expect(logHash(ENTRIES, 2)).toBe(logHash(ENTRIES.filter((entry) => entry.index < 2)));
    expect(logHash([])).toBe(sha256Hex(""));
    expect(logHash(ENTRIES, 0)).toBe(logHash([]));
  });

  it("refuses a duplicate index rather than tie-breaking it", () => {
    const doubled = [...ENTRIES, { index: 1, actor: "p-carol", payload: "{}" }];
    expect(() => logHash(doubled)).toThrow("two entries claim index 1");
  });

  it("rides on the debug export, and is null where the export already flags a duplicate", () => {
    const actions = ENTRIES.map((entry) => ({
      index: entry.index,
      id: `id${entry.index}`,
      actor: entry.actor,
      payload: entry.payload,
      derived: entry.derived === true,
      ...(entry.at === undefined ? {} : { at: entry.at }),
    }));
    const exported = buildSandboxLogExport(actions as never, "JUNO-TST", () => new Date(0));
    expect(exported.logHash).toBe(logHash(ENTRIES));
    const doubled = buildSandboxLogExport(
      [...actions, { ...actions[0], id: "dup" }] as never,
      "JUNO-TST",
      () => new Date(0),
    );
    expect(doubled.duplicateIndices).toEqual([1]);
    expect(doubled.logHash).toBeNull();
  });
});

describe("Phase 3 final clocks (owner ruling, 2026-10-07): the streamed and cumulative log hash is the same commitment", () => {
  const { Sha256, sha256HexOfBytes } = require("../gameEngine/sha256") as typeof import("../gameEngine/sha256");
  const { LogHashCursor, LOG_HASH_SEGMENT, cumulativeLogHash } = require("../gameEngine/logHash") as typeof import("../gameEngine/logHash");

  it("feeding SHA-256 in any chunks, and cloning midway, gives the one-shot digest", () => {
    const bytes = utf8Bytes("x".repeat(1_000) + "héllo ✓ 𝄞".repeat(50));
    const whole = sha256HexOfBytes(bytes);
    for (const step of [1, 7, 63, 64, 65, 500]) {
      const hasher = new Sha256();
      for (let at = 0; at < bytes.length; at += step) hasher.update(bytes.subarray(at, at + step));
      expect(hasher.digestHex()).toBe(whole);
    }
    const half = new Sha256().update(bytes.subarray(0, 333));
    const fork = half.clone();
    half.update(bytes.subarray(333));
    expect(half.digestHex()).toBe(whole);
    /* A clone is independent of what follows; a digest leaves the state as it was. */
    expect(fork.digestHex()).toBe(sha256HexOfBytes(bytes.subarray(0, 333)));
    expect(half.digestHex()).toBe(whole);
  });

  const history = (n: number, tag = "a") =>
    Array.from({ length: n }, (_, index) => ({ index, id: `${tag}${index}`, actor: index % 2 === 0 ? "p1" : "p2", payload: JSON.stringify({ PassTurn: { game_id: 0, n: index } }), at: 1_700_000_000_000 + index }));

  it("a cursor answers exactly logHash for every prefix, past segment boundaries, re-reading only from its nearest checkpoint", () => {
    const log = history(LOG_HASH_SEGMENT * 2 + 37);
    const cursor = new LogHashCursor();
    for (const n of [0, 1, 5, LOG_HASH_SEGMENT - 1, LOG_HASH_SEGMENT, LOG_HASH_SEGMENT + 1, LOG_HASH_SEGMENT * 2 + 37, 17, LOG_HASH_SEGMENT * 2]) {
      expect(cursor.hash(log, n)).toBe(logHash(log, n));
    }
    /* Growing one entry at a time, as a game does. */
    const grown = [...log];
    for (let k = 0; k < 5; k += 1) {
      grown.push(history(grown.length + 1)[grown.length]);
      expect(cursor.hash(grown)).toBe(logHash(grown));
    }
  });

  it("a history rolled back and appended again (other ids) is never answered from the old checkpoints", () => {
    const log = history(LOG_HASH_SEGMENT + 100);
    const cursor = new LogHashCursor();
    expect(cursor.hash(log)).toBe(logHash(log));
    /* (The id is not hashed -- the rewrite also changes what was played, as a real one does.) */
    const rewritten = [...log.slice(0, 50), ...history(LOG_HASH_SEGMENT + 100, "b").slice(50).map((entry) => ({ ...entry, actor: "p3" }))];
    expect(cursor.hash(rewritten)).toBe(logHash(rewritten));
    expect(cursor.hash(rewritten)).not.toBe(logHash(log));
  });

  it("an unordered log or a repeated index falls back to logHash's own ordering and refusal", () => {
    const cursor = new LogHashCursor();
    expect(cursor.hash(ENTRIES as never)).toBe(logHash(ENTRIES));
    const dup = [...history(3), { ...history(3)[2], id: "other" }];
    expect(() => cursor.hash(dup)).toThrow(/two entries claim index 2/);
  });

  it("REVIEW: an index out of order BEYOND the prefix, or entries without ids sharing a first object, are answered exactly as logHash answers them", () => {
    const base = history(6);
    /* [0,1,2,5,3,4], prefix 4: logHash sorts the whole array first, so its prefix is [0,1,2,3]. */
    const shuffled = [base[0], base[1], base[2], base[5], base[3], base[4]];
    const cursor = new LogHashCursor();
    expect(cursor.hash(base, 4)).toBe(logHash(base, 4));
    expect(cursor.hash(shuffled, 4)).toBe(logHash(shuffled, 4));
    /* Two id-less histories that share their first entry object but differ after it. */
    const first = { index: 0, actor: "p1", payload: "{}" };
    const one = [first, { index: 1, actor: "p1", payload: '{"a":1}' }, { index: 2, actor: "p1", payload: '{"a":2}' }];
    const two = [first, { index: 1, actor: "p2", payload: '{"b":1}' }, { index: 2, actor: "p2", payload: '{"b":2}' }];
    expect(cumulativeLogHash(one)).toBe(logHash(one));
    expect(cumulativeLogHash(two)).toBe(logHash(two));
    /* With ids, a different object at the anchor position is a different history. */
    const kept = history(LOG_HASH_SEGMENT + 5);
    const c2 = new LogHashCursor();
    expect(c2.hash(kept)).toBe(logHash(kept));
    const copy = kept.map((entry) => ({ ...entry, actor: entry.index >= 100 ? "p9" : entry.actor }));
    expect(c2.hash(copy)).toBe(logHash(copy));
  });

  it("cumulativeLogHash keeps one cursor per history (its first entry object)", () => {
    const log = history(LOG_HASH_SEGMENT + 3);
    expect(cumulativeLogHash(log)).toBe(logHash(log));
    expect(cumulativeLogHash(log.slice(0, 10))).toBe(logHash(log, 10));
    expect(cumulativeLogHash([])).toBe(logHash([]));
  });
});
