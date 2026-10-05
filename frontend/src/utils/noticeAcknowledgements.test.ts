/** @jest-environment jsdom */
// frontend/src/utils/noticeAcknowledgements.test.ts -- W3-A / OD-5(a): AUD-11.02 and P3-N019.
//
// THE LEDGER ITSELF, AGAINST THE BROWSER'S REAL STORAGE. "A remount", "a reload" and "a new tab" are each a FRESH
// `NoticeLedger` reading the same `localStorage` -- which is exactly what the shell does on each of them -- with the
// tab's own `sessionStorage` wiped for the new tab, because that is what a new tab has and what #1107 relied on.

import {
  NOTICE_ACK_MAX_GAMES,
  NOTICE_ACK_STORAGE_PREFIX,
  NoticeLedger,
  PHASE_THREE_NOTICE_KEY,
  fleetLossNoticeKey,
  heraldFloatNoticeKey,
  noticeLedgerKey,
  privateRevenueNoticeKey,
  type NoticeLedgerViewer,
} from "./noticeAcknowledgements";
import { nextDueNotice, type FleetLossNotice } from "./fleetLossNotice";

const RUST: FleetLossNotice = {
  companyId: 3,
  ticker: "PRR",
  cause: "rust",
  trains: ["2", "2"],
  arrivingTier: "4",
  trainLimit: null,
};
const LIMIT: FleetLossNotice = { ...RUST, cause: "limit", trains: ["3"], trainLimit: 3 };
const REVENUE = {
  viewerName: "Ann",
  viewerSeatColor: null,
  lines: [{ privateId: 1, label: "Schuylkill Valley", value: "$5" }],
  total: 5,
  cashBefore: 100,
  cashAfter: 105,
  others: [],
  roundLabel: "OR 2.1",
};
const HERALD = { companyId: 3, ticker: "PRR", hexLabel: "H12", place: "Altoona (H12)", revenue: 10, firstTokenCost: 40 };

function viewer(gameId: string, playerId: string | null, roster: string[] = ["p-ann", "p-bo", "p-cy"]): NoticeLedgerViewer {
  return { gameId, players: roster.map((id) => ({ id })), you: { playerId } };
}

const GAME_A = viewer("g_A", "p-bo");
const KEY_A = noticeLedgerKey(GAME_A) as string;

/** What the shell does on every mount: a fresh ledger, bound to this viewer's record. */
function mount(key: string | null, unwitnessed: () => boolean = () => false): NoticeLedger {
  const ledger = new NoticeLedger(unwitnessed);
  ledger.bind(key);
  return ledger;
}

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  jest.restoreAllMocks();
});

describe("whose record (OD-5(a): per user, per game) -- and LIVE-2D: no player id is persisted", () => {
  it("keys by the game and the seat's public table position, never by the seat's id", () => {
    expect(KEY_A).toBe(`${NOTICE_ACK_STORAGE_PREFIX}g_A.seat1`);
    expect(KEY_A).not.toContain("p-bo");
    expect(noticeLedgerKey(viewer("g_A", null))).toBe(`${NOTICE_ACK_STORAGE_PREFIX}g_A.watcher`);
    expect(noticeLedgerKey(viewer("g_A", "p-stranger"))).toBe(`${NOTICE_ACK_STORAGE_PREFIX}g_A.watcher`);
    expect(noticeLedgerKey(null)).toBeNull();
  });

  it("writes nothing that holds the seat's id, and nothing to sessionStorage", () => {
    const ledger = mount(KEY_A);
    ledger.remember({ kind: "fleetLoss", key: fleetLossNoticeKey(RUST), payload: RUST });
    ledger.acknowledge(PHASE_THREE_NOTICE_KEY);
    const everything = Object.keys(window.localStorage).map((key) => `${key}=${window.localStorage.getItem(key)}`);
    expect(everything.join(" ")).not.toContain("p-bo");
    expect(window.sessionStorage.length).toBe(0);
  });
});

describe("1-2. an acknowledged notice stays acknowledged (P3-N019, AUD-11.02)", () => {
  it("does not return after a remount", () => {
    mount(KEY_A).acknowledge(fleetLossNoticeKey(RUST));
    const remounted = mount(KEY_A);
    expect(remounted.isAcknowledged(fleetLossNoticeKey(RUST))).toBe(true);
    expect(remounted.has(fleetLossNoticeKey(RUST))).toBe(true);
    expect(nextDueNotice([RUST], remounted)).toBeNull();
  });

  it("does not return in a new tab -- the tab's sessionStorage is not the authority any more", () => {
    mount(KEY_A).acknowledge(fleetLossNoticeKey(RUST));
    window.sessionStorage.clear(); // a new tab starts with its own, empty session
    const newTab = mount(KEY_A);
    expect(nextDueNotice([RUST, LIMIT], newTab)).toBe(LIMIT);
  });

  it("holds every one-shot kind, not only Fleet Loss", () => {
    const first = mount(KEY_A);
    first.acknowledge(privateRevenueNoticeKey("OR 2.1"));
    first.acknowledge(PHASE_THREE_NOTICE_KEY);
    first.acknowledge(heraldFloatNoticeKey(3));
    const reloaded = mount(KEY_A);
    expect(reloaded.isAcknowledged(privateRevenueNoticeKey("OR 2.1"))).toBe(true);
    expect(reloaded.isAcknowledged(privateRevenueNoticeKey("OR 3.1"))).toBe(false);
    expect(reloaded.isAcknowledged(PHASE_THREE_NOTICE_KEY)).toBe(true);
    expect(reloaded.isAcknowledged(heraldFloatNoticeKey(3))).toBe(true);
  });

  it("closes a notice another of this player's tabs answered (reload on the storage event)", () => {
    const tabOne = mount(KEY_A);
    const tabTwo = mount(KEY_A);
    tabOne.acknowledge(PHASE_THREE_NOTICE_KEY);
    expect(tabTwo.isAcknowledged(PHASE_THREE_NOTICE_KEY)).toBe(false);
    expect(tabTwo.reload()).toBe(true);
    expect(tabTwo.isAcknowledged(PHASE_THREE_NOTICE_KEY)).toBe(true);
    expect(tabTwo.reload()).toBe(false); // nothing new the second time
  });
});

describe("AUD-11.02: a notice this player saw and has not answered survives the reload", () => {
  it("comes back after a reload with what it needs to render, and goes once answered", () => {
    const first = mount(KEY_A);
    expect(first.remember({ kind: "privateRevenue", key: privateRevenueNoticeKey("OR 2.1"), payload: REVENUE })).toBe(true);
    expect(first.remember({ kind: "herald", key: heraldFloatNoticeKey(3), payload: HERALD })).toBe(true);
    expect(first.remember({ kind: "phaseThree", key: PHASE_THREE_NOTICE_KEY, payload: null })).toBe(true);
    const reloaded = mount(KEY_A);
    expect(reloaded.pendingOf("privateRevenue").map((entry) => entry.payload)).toEqual([REVENUE]);
    expect(reloaded.pendingOf("herald").map((entry) => entry.payload)).toEqual([HERALD]);
    expect(reloaded.pendingOf("phaseThree")).toHaveLength(1);
    reloaded.acknowledge(privateRevenueNoticeKey("OR 2.1"));
    expect(mount(KEY_A).pendingOf("privateRevenue")).toEqual([]);
  });

  it("a newer payout replaces an older unanswered one, as the shell's single slot does", () => {
    const ledger = mount(KEY_A);
    ledger.remember({ kind: "privateRevenue", key: privateRevenueNoticeKey("OR 2.1"), payload: REVENUE });
    ledger.remember({
      kind: "privateRevenue",
      key: privateRevenueNoticeKey("OR 3.1"),
      payload: { ...REVENUE, roundLabel: "OR 3.1" },
    });
    expect(mount(KEY_A).pendingOf("privateRevenue").map((entry) => entry.key)).toEqual([privateRevenueNoticeKey("OR 3.1")]);
  });

  it("does not remember an answered event again, nor a payload it could not render", () => {
    const ledger = mount(KEY_A);
    ledger.acknowledge(fleetLossNoticeKey(RUST));
    expect(ledger.remember({ kind: "fleetLoss", key: fleetLossNoticeKey(RUST), payload: RUST })).toBe(false);
    expect(ledger.remember({ kind: "herald", key: heraldFloatNoticeKey(9), payload: { ticker: "B&O" } })).toBe(false);
    expect(ledger.pendingOf("fleetLoss")).toEqual([]);
    expect(ledger.pendingOf("herald")).toEqual([]);
  });

  it("keeps what was answered before the room view named the seat", () => {
    const ledger = new NoticeLedger();
    ledger.bind(null); // the view has not arrived yet
    ledger.acknowledge(PHASE_THREE_NOTICE_KEY);
    ledger.bind(KEY_A);
    expect(mount(KEY_A).isAcknowledged(PHASE_THREE_NOTICE_KEY)).toBe(true);
  });
});

describe("3. another game, and another seat, have their own records", () => {
  it("an acknowledgement in one game is not one in the next", () => {
    mount(KEY_A).acknowledge(fleetLossNoticeKey(RUST));
    mount(KEY_A).acknowledge(PHASE_THREE_NOTICE_KEY);
    const otherGame = mount(noticeLedgerKey(viewer("g_B", "p-bo")));
    expect(otherGame.isAcknowledged(fleetLossNoticeKey(RUST))).toBe(false);
    expect(otherGame.isAcknowledged(PHASE_THREE_NOTICE_KEY)).toBe(false);
    expect(nextDueNotice([RUST], otherGame)).toBe(RUST);
  });

  it("another seat at the same table -- even in the same browser -- has its own", () => {
    mount(KEY_A).acknowledge(PHASE_THREE_NOTICE_KEY);
    const ann = mount(noticeLedgerKey(viewer("g_A", "p-ann")));
    expect(ann.isAcknowledged(PHASE_THREE_NOTICE_KEY)).toBe(false);
  });

  it("moving the ledger to another record carries nothing across", () => {
    const ledger = mount(KEY_A);
    ledger.acknowledge(PHASE_THREE_NOTICE_KEY);
    ledger.bind(noticeLedgerKey(viewer("g_B", "p-bo")));
    expect(ledger.isAcknowledged(PHASE_THREE_NOTICE_KEY)).toBe(false);
  });
});

describe("4-5. a late joiner gets no backlog; Fleet Loss does not replay old history", () => {
  it("during a history this viewer did not witness, every event counts as already shown", () => {
    let loading = true;
    const lateJoiner = mount(noticeLedgerKey(viewer("g_A", "p-cy")), () => loading);
    expect(lateJoiner.has(fleetLossNoticeKey(RUST))).toBe(true);
    expect(lateJoiner.has(fleetLossNoticeKey(LIMIT))).toBe(true);
    loading = false; // the table has loaded: what happens now is witnessed
    expect(lateJoiner.has(fleetLossNoticeKey(RUST))).toBe(false);
  });

  it("except this player's own unanswered notices, which their record brings back", () => {
    mount(KEY_A).remember({ kind: "fleetLoss", key: fleetLossNoticeKey(RUST), payload: RUST });
    const reloading = mount(KEY_A, () => true);
    expect(reloading.has(fleetLossNoticeKey(RUST))).toBe(false); // their own: queued again
    expect(reloading.has(fleetLossNoticeKey(LIMIT))).toBe(true); // never witnessed: no backlog
    expect(reloading.pendingOf("fleetLoss").map((entry) => entry.payload)).toEqual([RUST]);
  });

  it("an answered event stays answered whatever the history is doing", () => {
    mount(KEY_A).acknowledge(fleetLossNoticeKey(RUST));
    expect(mount(KEY_A, () => true).has(fleetLossNoticeKey(RUST))).toBe(true);
    expect(mount(KEY_A, () => false).has(fleetLossNoticeKey(RUST))).toBe(true);
  });
});

describe("storage that misbehaves", () => {
  it("a corrupt record reads as empty and the ledger still works", () => {
    window.localStorage.setItem(KEY_A, "{not json");
    const ledger = mount(KEY_A);
    expect(ledger.isAcknowledged(PHASE_THREE_NOTICE_KEY)).toBe(false);
    ledger.acknowledge(PHASE_THREE_NOTICE_KEY);
    expect(mount(KEY_A).isAcknowledged(PHASE_THREE_NOTICE_KEY)).toBe(true);
  });

  it("a stored entry that fails its shape check is dropped, not rendered", () => {
    window.localStorage.setItem(
      KEY_A,
      JSON.stringify({ v: 1, acknowledged: [7, "phase-three"], pending: [{ kind: "fleetLoss", key: "x", payload: { ticker: 1 } }] }),
    );
    const ledger = mount(KEY_A);
    expect(ledger.pendingOf("fleetLoss")).toEqual([]);
    expect(ledger.isAcknowledged("phase-three")).toBe(true);
  });

  it("a browser that refuses storage keeps this mount's memory", () => {
    jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const ledger = mount(KEY_A);
    ledger.acknowledge(PHASE_THREE_NOTICE_KEY);
    expect(ledger.isAcknowledged(PHASE_THREE_NOTICE_KEY)).toBe(true);
  });

  it("keeps a bounded number of games' records, the newest ones", () => {
    const now = jest.spyOn(Date, "now");
    for (let game = 0; game < NOTICE_ACK_MAX_GAMES + 5; game += 1) {
      now.mockReturnValue(1_000 + game);
      mount(noticeLedgerKey(viewer(`g_${game}`, "p-bo"))).acknowledge(PHASE_THREE_NOTICE_KEY);
    }
    const kept = Object.keys(window.localStorage).filter((key) => key.startsWith(NOTICE_ACK_STORAGE_PREFIX));
    expect(kept).toHaveLength(NOTICE_ACK_MAX_GAMES);
    expect(kept).toContain(noticeLedgerKey(viewer(`g_${NOTICE_ACK_MAX_GAMES + 4}`, "p-bo")));
    expect(kept).not.toContain(noticeLedgerKey(viewer("g_0", "p-bo")));
  });
});
