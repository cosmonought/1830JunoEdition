/** @jest-environment node */
// PHASE 3 FINAL CLOCKS: what the table says about its clock, state by state, in the owner's words -- ONE ordinary
// action clock on a Live table; a train offer shows the proposer's clock PAUSED and "Train offer — m:ss to respond"
// (the recipient is never shown as overdue); OVERDUE shows the time to the 30:00 finality, the cure, the vote and the
// automatic neutral outcome (never three countdowns); the strike notes; a voluntary pause told apart from a SYSTEM
// pause (whose copy is fixed and whose preserved timer is shown before anyone votes); Async shows its pace and an
// OVERDUE with no countdown; No-deadline never counts down. A tab that is not current shows no figure.

import { STRIKE_TWO_WARNING, SYSTEM_PAUSE_RESUME_SENTENCE, SYSTEM_PAUSE_SENTENCE, type RoomClockView } from "./clockProtocol";
import { ASYNC_OVERDUE_DETAIL, declinesBlock, formatClockDuration, LIVE_FORECLOSE_OUTCOME, LIVE_NEUTRAL_OUTCOME, presentClock, STRIKE_ONE_NOTE } from "./gameClockView";

const MIN = 60_000;
const ME = "p-me";
const BOB = "p-bob";
const CAROL = "p-carol";
const names: Record<string, string> = { [ME]: "Me", [BOB]: "Bob", [CAROL]: "Carol" };

function view(over: Partial<RoomClockView> = {}): RoomClockView {
  return {
    v: 2,
    deadline: "live",
    paceSecs: null,
    policyFrozen: true,
    money: false,
    state: "running",
    serverNow: 1_800_000_000_000,
    revision: 5,
    responsible: { seat: BOB, kind: "turn" },
    action: { remainingMs: 20 * MIN, running: true },
    trade: null,
    overdue: null,
    strikes: {},
    pause: { paused: false, request: null },
    system: null,
    ended: null,
    remedy: null,
    declines: [],
    annul: null,
    noDeadlineAcks: [],
    seats: [ME, BOB, CAROL],
    ...over,
  };
}

const present = (clock: RoomClockView, over: { since?: number; current?: boolean; me?: string | null } = {}) =>
  presentClock({ clock, sinceReceiptMs: over.since ?? 0, current: over.current ?? true, viewerPlayerId: over.me === undefined ? ME : over.me, nameOf: (seat) => names[seat] ?? "?" });

describe("Phase 3 final clocks: the Live action clock", () => {
  it("ONE ordinary action clock, counted on by monotonic time since the view arrived", () => {
    const p = present(view(), { since: 61_000 });
    expect(p).toMatchObject({ visible: true, state: "running", modeLabel: "Live", label: "Bob to act", value: "18:59", ticking: true, tone: "normal" });
    expect(present(view({ responsible: { seat: ME, kind: "turn" } })).label).toBe("Your action");
    expect(present(view({ action: { remainingMs: 3 * MIN, running: true } })).tone).toBe("warning");
    expect(formatClockDuration(20 * MIN)).toBe("20:00");
    expect(formatClockDuration(26 * 3_600_000 + 5 * MIN)).toBe("1d 2h");
  });

  it("a tab that is not current shows no figure at all", () => {
    expect(present(view(), { current: false })).toMatchObject({ state: "not-current", value: null, ticking: false });
  });

  it("a train offer: the proposer's clock visibly PAUSED and 'Train offer — m:ss to respond'; the recipient is not overdue", () => {
    const p = present(view({ state: "trade", action: null, responsible: { seat: BOB, kind: "offer-answer" }, trade: { proposer: ME, recipient: BOB, respond: { remainingMs: 10 * MIN, running: true }, proposerRemainingMs: 15 * MIN + 30_000 } }), { since: 2 * MIN + 55_000 });
    expect(p.label).toBe("Train offer — 7:05 to respond");
    expect(p.lines.join(" ")).toMatch(/Your action clock is paused at 15:30/);
    expect(p.lines.join(" ")).toMatch(/not an overdue/);
    expect(p.state).toBe("trade");
    expect(p.tone).not.toBe("overdue");
  });
});

describe("Phase 3 final clocks: OVERDUE, strikes and the third expiry", () => {
  const overdue = (over: Partial<NonNullable<RoomClockView["overdue"]>> = {}) =>
    view({
      state: "overdue",
      action: { remainingMs: 0, running: false },
      overdue: { seat: BOB, strike: 1, epoch: 1, overdueAt: 1_800_000_000_000, logLen: 9, logHash: "ab".repeat(32), finality: { remainingMs: 10 * MIN, running: true }, outcomeIfUncured: "timeout-annul", cure: "turn", proposal: null, ...over },
      strikes: { [BOB]: 1 },
    });

  it("OVERDUE with the time to the 30:00 finality, the cure, and the automatic neutral outcome -- one countdown only", () => {
    const p = present(overdue(), { since: 90_000 });
    expect(p).toMatchObject({ state: "overdue", label: "OVERDUE", value: "8:30 to 30:00", tone: "overdue" });
    expect(p.lines[0]).toBe("Bob is overdue. To continue the game, Bob must make their move.");
    expect(p.lines).toContain(LIVE_NEUTRAL_OUTCOME);
    expect(p.controls.propose).toEqual(["foreclose"]);
    expect(present(overdue(), { me: BOB }).controls.propose).toEqual([]);
  });

  it("the N-1 vote's status, and the minute-30 outcome it decides when complete", () => {
    const proposal = { id: 3, kind: "foreclose" as const, by: CAROL, yes: [CAROL], no: [], needed: [ME, CAROL], complete: false };
    let p = present(overdue({ proposal }));
    expect(p.lines.join(" ")).toMatch(/Foreclosure proposed by Carol: 1 of 2 agree\./);
    expect(p.controls.vote).toEqual({ id: 3, kind: "foreclose", mine: null });
    p = present(overdue({ proposal: { ...proposal, yes: [ME, CAROL], complete: true }, outcomeIfUncured: "foreclosure" }));
    expect(p.lines).toContain(LIVE_FORECLOSE_OUTCOME);
    expect(p.lines.join(" ")).toMatch(/decided at 30:00 unless cured first/);
    expect(p.controls.vote).toEqual({ id: 3, kind: "foreclose", mine: "yes" });
  });

  it("strike notes for the viewer: '1 of 2 overdue cures used', then the prominent warning", () => {
    expect(present(view({ strikes: { [ME]: 1 } })).lines).toContain(STRIKE_ONE_NOTE);
    expect(present(view({ strikes: { [ME]: 2 } })).warning).toBe(STRIKE_TWO_WARNING);
    expect(present(view({ strikes: { [BOB]: 2 } })).warning).toBeNull();
  });

  it("the third expiry: game ended by foreclosure, the money result challengeable -- never another cure clock", () => {
    const p = present(view({ state: "ended", money: true, ended: { kind: "live-strike3-foreclosure", at: 1, seat: BOB }, remedy: { kind: 3, status: "submitted", stale: [], overdue: { seat: BOB, strike: 3, epoch: 3, overdueAt: 1, logLen: 4, logHash: "ab".repeat(32) } } }));
    expect(p).toMatchObject({ state: "ended", label: "Foreclosed", value: null, ticking: false });
    expect(p.lines[0]).toMatch(/third action-clock expiry.*challenged on Juno; play does not resume/);
  });
});

describe("Phase 3 final clocks: voluntary pause and SYSTEM pause are told apart", () => {
  it("a request alone is not a pause; the paused state shows the preserved timer and the resume votes", () => {
    let p = present(view({ pause: { paused: false, request: { kind: "pause", id: 1, by: BOB, yes: [BOB], needed: [ME, BOB, CAROL] } } }));
    expect(p.state).toBe("running");
    expect(p.lines.join(" ")).toMatch(/Bob asked to pause — 1 of 3 agree\. The clock runs until everyone agrees\./);
    expect(p.controls.answerRequest).toEqual({ kind: "pause", id: 1, by: BOB });
    p = present(view({ state: "paused", action: { remainingMs: 6 * MIN + 12_000, running: false }, pause: { paused: true, request: null } }));
    expect(p).toMatchObject({ state: "paused", label: "Paused", tone: "paused", ticking: false });
    expect(p.lines.join(" ")).toMatch(/Bob: 6:12 on the action clock \(kept exactly\)/);
    expect(p.controls.requestResume).toBe(true);
  });

  it("SYSTEM pause: the owner's two sentences, the preserved timer before anyone votes, unanimity to resume", () => {
    const p = present(view({ state: "system-paused", action: { remainingMs: 6 * MIN + 12_000, running: false }, system: { since: 2, preservedAt: 1, yes: [BOB], needed: [ME, BOB, CAROL] } }));
    expect(p.lines[0]).toBe(SYSTEM_PAUSE_SENTENCE);
    expect(p.lines[1]).toBe(SYSTEM_PAUSE_RESUME_SENTENCE);
    expect(p.lines.join(" ")).toMatch(/6:12 on the action clock \(kept exactly\)/);
    expect(p.lines.join(" ")).toMatch(/1 of 3 agreed to resume/);
    expect(p.controls.systemResume).toBe(true);
    expect(p.controls.requestPause).toBe(false);
    expect(p.state).not.toBe("paused");
  });
});

describe("Phase 3 final clocks: Async and No-deadline", () => {
  it("Async: the pace and who is to act; OVERDUE with no automatic-annul countdown; the other N-1 may annul or foreclose", () => {
    const running = present(view({ deadline: "async-pace", paceSecs: 86_400, action: { remainingMs: 18 * 3_600_000 + 2 * MIN, running: true } }));
    expect(running).toMatchObject({ modeLabel: "Async · 24 hours", label: "Bob to act", value: "18h 02m" });
    const p = present(view({ deadline: "async-pace", paceSecs: 86_400, state: "overdue", overdue: { seat: BOB, strike: 0, epoch: 1, overdueAt: 1, logLen: 3, logHash: "ab".repeat(32), finality: null, outcomeIfUncured: null, cure: "turn", proposal: null } }));
    expect(p).toMatchObject({ label: "OVERDUE", value: null, ticking: false });
    expect(p.lines).toContain(ASYNC_OVERDUE_DETAIL);
    expect(p.controls.propose).toEqual(["foreclose", "annul"]);
  });

  it("No-deadline: 'No deadline', never a countdown", () => {
    const p = present(view({ deadline: "no-deadline", action: null }));
    expect(p).toMatchObject({ modeLabel: "No deadline", value: null, ticking: false });
  });
});

describe("Phase 3 final clocks: the unanimous annulment and the two-decline rule", () => {
  it("a free table offers 'Annul game' in every live state; a money table annuls through its escrow (not here)", () => {
    for (const state of ["running", "paused", "system-paused", "overdue"] as const) {
      expect(present(view({ state, ...(state === "system-paused" ? { system: { since: 1, preservedAt: 1, yes: [], needed: [ME, BOB, CAROL] } } : {}) })).controls.annul).toEqual({ mine: false, count: 0, needed: 3 });
    }
    expect(present(view({ money: true })).controls.annul).toBeNull();
    expect(present(view({ annul: { yes: [ME], needed: [ME, BOB, CAROL] } })).controls.annul).toEqual({ mine: true, count: 1, needed: 3 });
    expect(present(view(), { me: null }).controls.annul).toBeNull();
  });

  it("two declines from one recipient this Operating Round: the owner's sentence (never misconduct); other directions open", () => {
    const clock = view({ declines: [{ from: ME, to: BOB, count: 2 }, { from: ME, to: CAROL, count: 1 }] });
    expect(declinesBlock(clock, ME, BOB, "Bob")).toBe("Bob has declined two train offers from you this operating round.");
    expect(declinesBlock(clock, ME, CAROL, "Carol")).toBeNull();
    expect(declinesBlock(clock, BOB, ME, "Me")).toBeNull();
    expect(declinesBlock(view({ deadline: "async-pace", paceSecs: 86_400, declines: [{ from: ME, to: BOB, count: 2 }] }), ME, BOB, "Bob")).toBeNull();
  });
});
