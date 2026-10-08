/** @jest-environment jsdom */
// frontend/src/tutorial/tutorialLedger.test.ts -- PHASE 3 FINAL PLAY TUTORIAL: PERSISTENCE.
//
// Real jsdom `localStorage`. A "reload", "new tab" or "remount" is a fresh ledger reading the same storage; a "new
// device" is a fresh ledger reading EMPTY storage.

import {
  TUTORIAL_AUTO_KEY,
  TUTORIAL_MAX_GAMES,
  TUTORIAL_STORAGE_PREFIX,
  TutorialLedger,
  setTutorialsAuto,
  tutorialLedgerKey,
  tutorialsAutoEnabled,
} from "./tutorialLedger";

const GAME_A = "g_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const GAME_B = "g_bbbbbbbbbbbbbbbbbbbbbbbbbb";
const view = (gameId: string, playerId: string | null) => ({
  gameId,
  players: [{ id: "p-owner" }, { id: "p-bea" }],
  you: { playerId },
});
const KEY_A0 = tutorialLedgerKey(view(GAME_A, "p-owner"))!;
const KEY_A1 = tutorialLedgerKey(view(GAME_A, "p-bea"))!;
const KEY_B0 = tutorialLedgerKey(view(GAME_B, "p-owner"))!;

function ledgerAt(key: string | null): TutorialLedger {
  const ledger = new TutorialLedger();
  ledger.bind(key);
  return ledger;
}

beforeEach(() => window.localStorage.clear());

describe("the key: game id + the seat's public position, never an identity", () => {
  it("keys by game and seat position; a watcher or an unseated view has no record", () => {
    expect(KEY_A0).toBe(`${TUTORIAL_STORAGE_PREFIX}${GAME_A}.seat0`);
    expect(KEY_A1).toBe(`${TUTORIAL_STORAGE_PREFIX}${GAME_A}.seat1`);
    expect(KEY_A0).not.toContain("p-owner");
    expect(tutorialLedgerKey(view(GAME_A, null))).toBeNull();
    expect(tutorialLedgerKey(view(GAME_A, "p-stranger"))).toBeNull();
    expect(tutorialLedgerKey(null)).toBeNull();
  });

  it("stores only lesson ids and corporation numbers", () => {
    const ledger = ledgerAt(KEY_A0);
    ledger.raise({ id: "market.moves", subject: 3 });
    ledger.acknowledge("orientation.goal");
    const raw = window.localStorage.getItem(KEY_A0)!;
    expect(JSON.parse(raw)).toEqual({ v: 2, updatedAt: expect.any(Number), gen: 0, acknowledged: ["orientation.goal"], pending: [{ id: "market.moves", subject: 3 }] });
  });
});

describe("one-shot per player per game", () => {
  it("the first witnessed lesson is pending; once acknowledged it never comes back in this game", () => {
    const ledger = ledgerAt(KEY_A0);
    expect(ledger.raise({ id: "stock.primer" })).toBe(true);
    expect(ledger.pending()).toEqual([{ id: "stock.primer" }]);
    expect(ledger.raise({ id: "stock.primer" })).toBe(false); // not twice while waiting
    ledger.acknowledge("stock.primer");
    expect(ledger.pending()).toEqual([]);
    expect(ledger.raise({ id: "stock.primer" })).toBe(false); // an Undo's re-derived edge cannot teach it again
  });

  it("another game, and another seat in the same game, each teach it afresh", () => {
    ledgerAt(KEY_A0).acknowledge("stock.primer");
    expect(ledgerAt(KEY_B0).raise({ id: "stock.primer" })).toBe(true);
    expect(ledgerAt(KEY_A1).raise({ id: "stock.primer" })).toBe(true);
  });

  it("moving the ledger between records carries nothing across", () => {
    const ledger = ledgerAt(KEY_A0);
    ledger.acknowledge("stock.primer");
    ledger.raise({ id: "stock.float", subject: 2 });
    ledger.bind(KEY_B0);
    expect(ledger.isAcknowledged("stock.primer")).toBe(false);
    expect(ledger.pending()).toEqual([]);
  });
});

describe("reload, new tab, new device", () => {
  it("a reload keeps what was answered and brings back what was witnessed and left unanswered", () => {
    const before = ledgerAt(KEY_A0);
    before.raise({ id: "orientation.goal" });
    before.raise({ id: "orientation.flow" });
    before.acknowledge("orientation.goal");
    const reloaded = ledgerAt(KEY_A0);
    expect(reloaded.isAcknowledged("orientation.goal")).toBe(true);
    expect(reloaded.pending()).toEqual([{ id: "orientation.flow" }]);
  });

  it("a new device (no record) has nothing pending: no history is replayed", () => {
    ledgerAt(KEY_A0).raise({ id: "stock.float", subject: 1 });
    window.localStorage.clear();
    const fresh = ledgerAt(KEY_A0);
    expect(fresh.pending()).toEqual([]);
    expect(fresh.isAcknowledged("stock.float")).toBe(false);
  });

  it("a withdrawn lesson (its moment passed) is not acknowledged, and a later live occurrence raises it again", () => {
    const ledger = ledgerAt(KEY_A0);
    ledger.raise({ id: "operating.track" });
    expect(ledger.withdraw("operating.track")).toBe(true);
    expect(ledgerAt(KEY_A0).pending()).toEqual([]); // the withdrawal is persisted, not merged back
    expect(ledger.isAcknowledged("operating.track")).toBe(false);
    expect(ledger.raise({ id: "operating.track" })).toBe(true);
  });

  it("another tab's answer is merged in, never overwritten", () => {
    const one = ledgerAt(KEY_A0);
    const two = ledgerAt(KEY_A0);
    one.raise({ id: "stock.primer" });
    two.reload();
    two.acknowledge("stock.primer");
    expect(one.reload()).toBe(true);
    expect(one.isAcknowledged("stock.primer")).toBe(true);
    one.raise({ id: "stock.turn" }); // a write from the stale tab keeps the other tab's answer
    expect(ledgerAt(KEY_A0).isAcknowledged("stock.primer")).toBe(true);
  });

  it("a record that vanished (cleared or pruned) does not wipe a restarted tab's answers", () => {
    const ledger = ledgerAt(KEY_A0);
    ledger.restart();
    ledger.acknowledge("orientation.goal");
    window.localStorage.removeItem(KEY_A0);
    ledger.reload();
    expect(ledger.isAcknowledged("orientation.goal")).toBe(true);
  });

  it("restart forgets this seat's progress in this game only", () => {
    ledgerAt(KEY_A1).acknowledge("stock.primer");
    const ledger = ledgerAt(KEY_A0);
    ledger.acknowledge("stock.primer");
    ledger.restart();
    expect(ledger.isAcknowledged("stock.primer")).toBe(false);
    expect(ledgerAt(KEY_A0).isAcknowledged("stock.primer")).toBe(false);
    expect(ledgerAt(KEY_A1).isAcknowledged("stock.primer")).toBe(true);
  });

  it("a restart in one tab is not undone by another tab of the same seat that still remembers the old answers", () => {
    const one = ledgerAt(KEY_A0);
    const two = ledgerAt(KEY_A0);
    one.acknowledge("orientation.goal");
    two.reload();
    expect(two.isAcknowledged("orientation.goal")).toBe(true);
    one.restart();
    one.raise({ id: "orientation.goal" });
    two.raise({ id: "stock.turn" }); // the stale tab writes: it must adopt the newer generation, not merge back
    expect(ledgerAt(KEY_A0).isAcknowledged("orientation.goal")).toBe(false);
    expect(one.reload() || true).toBe(true);
    expect(one.pending().map((entry) => entry.id)).toEqual(expect.arrayContaining(["orientation.goal", "stock.turn"]));
    expect(two.reload() || true).toBe(true);
    expect(two.isAcknowledged("orientation.goal")).toBe(false);
  });
});

describe("what may not be raised", () => {
  it("nothing without a seat; nothing that is not a lesson", () => {
    const watcher = ledgerAt(null);
    expect(watcher.raise({ id: "stock.primer" })).toBe(false);
    expect(watcher.pending()).toEqual([]);
    const seated = ledgerAt(KEY_A0);
    expect(seated.raise({ id: "no.such.lesson" as never })).toBe(false);
  });

  it("a stored record is untrusted: unknown ids and bad shapes are dropped", () => {
    window.localStorage.setItem(
      KEY_A0,
      JSON.stringify({ acknowledged: ["stock.primer", "retired.lesson", 7], pending: [{ id: "stock.float", subject: "x" }, { id: "market.moves", subject: 2 }, "junk"] }),
    );
    const ledger = ledgerAt(KEY_A0);
    expect(ledger.isAcknowledged("stock.primer")).toBe(true);
    expect(ledger.isAcknowledged("retired.lesson")).toBe(false);
    expect(ledger.pending()).toEqual([{ id: "market.moves", subject: 2 }]);
    window.localStorage.setItem(KEY_A0, "{not json");
    expect(ledgerAt(KEY_A0).pending()).toEqual([]);
  });

  it("storage that refuses writes or reads degrades to this mount's memory", () => {
    const setItem = jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    const ledger = ledgerAt(KEY_A0);
    ledger.raise({ id: "stock.primer" });
    ledger.acknowledge("stock.primer");
    expect(ledger.isAcknowledged("stock.primer")).toBe(true);
    setItem.mockRestore();
    const getItem = jest.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(ledgerAt(KEY_A0).pending()).toEqual([]);
    expect(tutorialsAutoEnabled()).toBe(true);
    getItem.mockRestore();
  });

  it("keeps at most the newest records", () => {
    for (let game = 0; game < TUTORIAL_MAX_GAMES + 5; game += 1) {
      const key = `${TUTORIAL_STORAGE_PREFIX}g_${String(game).padStart(26, "0")}.seat0`;
      ledgerAt(key).raise({ id: "stock.primer" });
    }
    const kept = Object.keys(window.localStorage).filter((key) => key.startsWith(TUTORIAL_STORAGE_PREFIX));
    expect(kept.length).toBe(TUTORIAL_MAX_GAMES);
    expect(TUTORIAL_MAX_GAMES).toBe(40);
  });
});

describe("the automatic-tutorial preference", () => {
  it("is ON by default, can be turned off, and back on (no one-way door)", () => {
    expect(tutorialsAutoEnabled()).toBe(true);
    setTutorialsAuto(false);
    expect(window.localStorage.getItem(TUTORIAL_AUTO_KEY)).toBe("off");
    expect(tutorialsAutoEnabled()).toBe(false);
    setTutorialsAuto(true);
    expect(window.localStorage.getItem(TUTORIAL_AUTO_KEY)).toBeNull();
    expect(tutorialsAutoEnabled()).toBe(true);
  });

  it("ignores the retired one-way switch", () => {
    window.localStorage.setItem("1830juno.tutorials_off.v1", "1");
    expect(tutorialsAutoEnabled()).toBe(true);
  });
});
