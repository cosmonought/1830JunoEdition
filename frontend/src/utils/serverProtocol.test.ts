/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 1207 (harness): THE PROTOCOL'S LOAD-BEARING PROPERTIES
// ==================================================================
//
// Most of this module is types, which the compiler checks. What it cannot check is the two behaviours the
// protocol actually rests on: that the log's bytes are canonical because ONE serialiser produces them, and
// that a payload survives a round trip into the state the sender meant.

export {};

const { mintLogEntry, buildsAgree } =
  require("./serverProtocol") as typeof import("./serverProtocol");

describe("minting the log's bytes", () => {
  it("produces identical bytes for the same move built in a different key order", () => {
    /* ==================================================================
        THE PROPERTY #1188 GOT BY ACCIDENT, NOW HELD ON PURPOSE
       ==================================================================
       `payload` used to be minted by whichever client dispatched, so two clients sending the same logical
       move could produce different text for it -- same state, different bytes. Harmless for replay, quietly
       awkward for a commitment that hashes those bytes.
       ONE SERIALISER ENDS IT. Both objects below describe one move and differ only in the order their
       literals were written, which is a property of the code that built them and not of the game. */
    const a = mintLogEntry({
      index: 4,
      id: "id4",
      actor: "p-alice",
      msg: { BuyStock: { game_id: 0, protocol_id: 1, quantity: 1 } } as never,
    });
    const b = mintLogEntry({
      index: 4,
      id: "id4",
      actor: "p-alice",
      msg: { BuyStock: { quantity: 1, protocol_id: 1, game_id: 0 } } as never,
    });
    expect(a.payload).toBe(b.payload);
  });

  it("round-trips to the message the sender meant", () => {
    /* The bytes are canonical, not lossy. A replay parses this back and hands it to the reducer, so anything
       reordered here must still be the same move on the other side. */
    const msg = {
      RunMultipleRoutes: {
        game_id: 0,
        protocol_id: 7,
        routes: [[{ hex: "G19" }, { hex: "F20" }]],
        trains: ["3"],
        revenue_turn: "7.1.7",
      },
    };
    const entry = mintLogEntry({ index: 1, id: "id1", actor: "p-bob", msg: msg as never });
    expect(JSON.parse(entry.payload)).toEqual(msg);
  });

  it("omits `derived` rather than writing it false", () => {
    /* #232 applied to the log: absent means "not a derived action". A field written on every entry to say
       "no" is a field that will eventually be written wrong -- and `effectiveActions` and the exporter both
       read this. */
    const player = mintLogEntry({ index: 1, id: "a", actor: "p", msg: { PassTurn: {} } as never });
    expect("derived" in player).toBe(false);

    const game = mintLogEntry({
      index: 2,
      id: "b",
      actor: "p",
      msg: { PassTurn: {} } as never,
      derived: true,
    });
    expect(game.derived).toBe(true);
  });

  it("omits an absent timestamp rather than stamping one", () => {
    /* The exporter takes the same line (#643): an entry with no clock is not an entry at time zero, and
       `turnClock` skips what it cannot time rather than counting it as an instantaneous turn. */
    const entry = mintLogEntry({ index: 1, id: "a", actor: "p", msg: { PassTurn: {} } as never });
    expect("at" in entry).toBe(false);
  });
});

describe("build agreement is exact", () => {
  it("refuses anything but an exact match", () => {
    /* #1206: the digest covers the WHOLE state, so one added field makes two builds incompatible for this
       purpose. A comparison that tolerated "compatible" versions would need somebody to define that against
       a digest with no notion of which fields matter -- and the honest answer is that all of them do. */
    expect(buildsAgree("abc123", "abc123")).toBe(true);
    expect(buildsAgree("abc123", "abc1234")).toBe(false);
    expect(buildsAgree("abc123", "")).toBe(false);
  });
});
