/** @jest-environment jsdom */
//
// PHASE 3 (P3-N032): REPORTING A PLAYER, AND THE REVIEW PANEL -- CLIENT SIDE.
//
//   the control      shows only to a SEATED viewer with someone to report: never to a watcher, a kicked principal, a
//                    Watch tab or a table-less view; it never lists the viewer themselves
//   the dialog       neutral wording, says what a report does NOT do; Send waits for a player and a category; the note is
//                    bounded (a counter; over the bound, Send is off -- never cut); the exact closed room op is sent (no
//                    evidence, seat or principal field; an empty note left out); received / already / refused are shown
//   the note         one sanitizer both sides: controls, bidi and zero-width marks removed, whitespace collapsed,
//                    malformed text and an over-long note refused
//   the schema       `report-player` is a CLOSED room op: known categories only, bounded note, a seat id, nothing else
//   the review panel reads the queue and a case strictly (no private id survives the parser), shows the reporter's note
//                    as TEXT, asks "Confirm it's you" when the server wants it, reloads a stale case, never offers a
//                    party a decision; the profile menu offers it only to a reviewer account

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { ReportPlayerControl, ReportPlayerDialog, reportablePlayers } from "./ReportPlayerControl";
import { ConductReviewPanel } from "./ConductReviewPanel";
import { ProfileMenu } from "./ProfileMenu";
import { ModalLayerHost } from "./ModalPortal";
import type { RoomView } from "../utils/roomProtocol";
import { checkConductNote, CONDUCT_CATEGORY_LABELS, CONDUCT_TRANSITIONS, MAX_REPORT_NOTE_LENGTH } from "../utils/conductReport";
import { caseSummaryOf, caseViewOf, reportOutcomeOf, reportPlayerOp, type ReportPlayerBody } from "../utils/conductApi";
import { parseClientFrame } from "../gameEngine/messageSchema";
import { httpSessionPort } from "../utils/sessionBootstrap";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
global.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let layerContainer: HTMLDivElement;
let layerRoot: Root;

beforeAll(() => {
  /* jsdom has no <dialog> modality: the NativeModal fallback keeps the surface rendered. */
  const proto = HTMLDialogElement.prototype as unknown as { showModal?: () => void; close?: () => void };
  if (typeof proto.showModal !== "function") proto.showModal = function showModal(this: HTMLDialogElement) { this.setAttribute("open", ""); };
  if (typeof proto.close !== "function") proto.close = function close(this: HTMLDialogElement) { this.removeAttribute("open"); };
});

beforeEach(() => {
  layerContainer = document.createElement("div");
  document.body.appendChild(layerContainer);
  layerRoot = createRoot(layerContainer);
  act(() => layerRoot.render(<ModalLayerHost />));
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  act(() => layerRoot.unmount());
  container.remove();
  layerContainer.remove();
});

/* Every modal surface renders into the app's modal layer: it is mounted first, in its own root, as the app mounts it. */
const show = (node: React.ReactNode) => root.render(node);

const flush = async () => {
  await act(async () => {
    for (let n = 0; n < 6; n += 1) await Promise.resolve();
  });
};

function room(over: Partial<RoomView["you"]> = {}, players = ["p-aaaaaaaaaaaaaaaa", "p-bbbbbbbbbbbbbbbb", "p-cccccccccccccccc"]): RoomView {
  return {
    gameId: "g_0000000000000000000000000w",
    code: "JUNO-AAAA-AAAA",
    joinable: false,
    visibility: "public",
    status: "playing",
    lifecycle: "active",
    closed: false,
    held: false,
    holdKind: null,
    hostId: players[0],
    players: players.map((id, at) => ({ id, nickname: ["Ann", "Ben", "Cid"][at] ?? id, isReady: true, online: true })),
    playerCount: players.length,
    seatCap: 6,
    variants: {} as RoomView["variants"],
    createdAtMs: 1,
    undoPolicy: "last-action" as unknown as RoomView["undoPolicy"],
    you: { role: "player", playerId: players[0], kicked: false, canStart: false, ...over },
  } as RoomView;
}

const click = (testId: string) => act(() => (document.querySelector(`[data-testid="${testId}"]`) as HTMLElement).click());
const byId = (testId: string) => document.querySelector(`[data-testid="${testId}"]`);
function type(testId: string, value: string) {
  const field = byId(testId) as HTMLTextAreaElement;
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set as (v: string) => void;
    setter.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/* ==================================================================
    THE CONTROL AND THE DIALOG
   ================================================================== */

describe("P3-N032 the Report control", () => {
  test("shows only to a seated viewer, listing every OTHER seat; never a watcher, a kicked principal, a Watch tab or no table", () => {
    expect(reportablePlayers(room()).map((player) => player.nickname)).toEqual(["Ben", "Cid"]);
    expect(reportablePlayers(room({ playerId: null, role: "watcher" as RoomView["you"]["role"] }))).toEqual([]);
    expect(reportablePlayers(room({ kicked: true }))).toEqual([]);
    expect(reportablePlayers(room(), true)).toEqual([]);
    expect(reportablePlayers(null)).toEqual([]);
    expect(reportablePlayers(room({}, ["p-aaaaaaaaaaaaaaaa"]))).toEqual([]);
    act(() => show(<ReportPlayerControl room={room({ playerId: null })} onReport={async () => ({ ok: true, data: {} })} />));
    expect(byId("report-player-open")).toBeNull();
    act(() => show(<ReportPlayerControl room={room()} watchOnly onReport={async () => ({ ok: true, data: {} })} />));
    expect(byId("report-player-open")).toBeNull();
    act(() => show(<ReportPlayerControl room={room()} onReport={async () => ({ ok: true, data: {} })} />));
    expect(byId("report-player-open")).not.toBeNull();
  });

  test("the dialog: neutral wording that says what a report does not do; Send waits for a player and a category; the exact closed op is sent", async () => {
    const sent: ReportPlayerBody[] = [];
    act(() =>
      show(
        <ReportPlayerDialog
          players={[{ id: "p-bbbbbbbbbbbbbbbb", nickname: "Ben" }, { id: "p-cccccccccccccccc", nickname: "Cid" }]}
          onReport={async (body) => {
            sent.push(body);
            return { ok: true, data: { received: "new", message: "Your report was sent to the operator for review." } };
          }}
          onClose={() => undefined}
        />,
      ),
    );
    const explainer = byId("report-player-explainer")?.textContent ?? "";
    expect(explainer).toMatch(/does not change the game, any money, or anyone's profile/);
    expect(explainer).toMatch(/other player is not told/);
    for (const label of Object.values(CONDUCT_CATEGORY_LABELS)) expect(document.body.textContent).toContain(label);
    expect(document.body.textContent).not.toMatch(/cheat|guilty|\bban|punish|score/i);
    const send = () => byId("report-player-send") as HTMLButtonElement;
    expect(send().disabled).toBe(true);
    click("report-player-pick-p-bbbbbbbbbbbbbbbb");
    expect(send().disabled).toBe(true);
    click("report-category-offer-spam");
    expect(send().disabled).toBe(false);
    type("report-note", "   ");
    await act(async () => send().click());
    await flush();
    expect(sent).toEqual([{ type: "report-player", playerId: "p-bbbbbbbbbbbbbbbb", category: "offer-spam" }]);
    expect(byId("report-player-received")?.textContent).toBe("Report received.");
  });

  test("the note is bounded by a counter (Send off over the bound, never cut); an 'already received' and a refusal are said as the server says them", async () => {
    let answer: { ok: true; data: Record<string, unknown> } | { ok: false; code: string; reason: string } = { ok: false, code: "rate-limited", reason: "You have sent several reports recently. Wait a while before sending another." };
    const sent: ReportPlayerBody[] = [];
    act(() =>
      show(
        <ReportPlayerDialog
          players={[{ id: "p-bbbbbbbbbbbbbbbb", nickname: "Ben" }]}
          onReport={async (body) => {
            sent.push(body);
            return answer;
          }}
          onClose={() => undefined}
        />,
      ),
    );
    click("report-category-stalling");
    type("report-note", "x".repeat(MAX_REPORT_NOTE_LENGTH + 1));
    expect((byId("report-player-send") as HTMLButtonElement).disabled).toBe(true);
    expect(byId("report-note-count")?.textContent).toMatch(/501 \/ 500/);
    type("report-note", "Kept offering after I declined.");
    await act(async () => (byId("report-player-send") as HTMLButtonElement).click());
    await flush();
    expect(byId("report-player-error")?.textContent).toMatch(/Wait a while/);
    expect(sent[0]).toEqual({ type: "report-player", playerId: "p-bbbbbbbbbbbbbbbb", category: "stalling", note: "Kept offering after I declined." });
    answer = { ok: true, data: { received: "already", message: "You have already reported this player for this at this table." } };
    await act(async () => (byId("report-player-send") as HTMLButtonElement).click());
    await flush();
    expect(byId("report-player-received")?.textContent).toBe("Already received.");
  });

  test("past the bound on the reporter's own reports the answer says so, in the server's words", () => {
    expect(reportOutcomeOf({ ok: true, data: { received: "capped", message: "You have reported this player for this several times in this game." } })).toEqual({ ok: true, received: "capped", message: "You have reported this player for this several times in this game." });
  });
});

/* ==================================================================
    THE NOTE, THE SCHEMA, THE WORKFLOW
   ================================================================== */

describe("P3-N032 the note, the closed frame and the workflow", () => {
  test("one sanitizer: controls, bidi overrides and zero-width marks removed, whitespace collapsed; malformed and over-long refused", () => {
    expect(checkConductNote("  hi\nthere‮​\u0007 ")).toEqual({ ok: true, note: "hi there" });
    expect(checkConductNote("\u001b[31mred")).toEqual({ ok: true, note: "[31mred" });
    expect(checkConductNote("")).toEqual({ ok: true, note: null });
    expect(checkConductNote(undefined)).toEqual({ ok: true, note: null });
    expect(checkConductNote("bad \ud800")).toEqual({ ok: false, problem: "malformed" });
    expect(checkConductNote(7)).toEqual({ ok: false, problem: "malformed" });
    expect(checkConductNote("x".repeat(MAX_REPORT_NOTE_LENGTH + 1))).toEqual({ ok: false, problem: "too-long" });
    expect(checkConductNote("😀".repeat(MAX_REPORT_NOTE_LENGTH))).toEqual({ ok: true, note: "😀".repeat(MAX_REPORT_NOTE_LENGTH) });
    /* NFC can lengthen a text: measured again after cleaning, refused rather than cut. */
    expect(checkConductNote("\ufb2c".repeat(MAX_REPORT_NOTE_LENGTH))).toEqual({ ok: false, problem: "too-long" });
  });

  test("`report-player` is a closed room op: a seat id, a known category, a bounded note -- nothing else", () => {
    const frame = (op: Record<string, unknown>) => parseClientFrame({ kind: "room-op", requestId: "rq-1", gameId: "g_0000000000000000000000000w", op: { type: "report-player", ...op } });
    expect(frame({ playerId: "p-bbbbbbbbbbbbbbbb", category: "harassment" }).ok).toBe(true);
    expect(frame(reportPlayerOp("p-bbbbbbbbbbbbbbbb", "collusion", "a note") as unknown as Record<string, unknown>).ok).toBe(true);
    expect(frame({ playerId: "p-bbbbbbbbbbbbbbbb", category: "cheating" }).ok).toBe(false);
    expect(frame({ playerId: "p-bbbbbbbbbbbbbbbb" }).ok).toBe(false);
    expect(frame({ playerId: "pr_secret", category: "other" }).ok).toBe(false);
    expect(frame({ playerId: "p-bbbbbbbbbbbbbbbb", category: "other", note: "x".repeat(MAX_REPORT_NOTE_LENGTH * 2 + 1) }).ok).toBe(false);
    expect(frame({ playerId: "p-bbbbbbbbbbbbbbbb", category: "other", note: "😀".repeat(MAX_REPORT_NOTE_LENGTH) }).ok).toBe(true);
    expect(frame({ playerId: "p-bbbbbbbbbbbbbbbb", category: "other", evidence: {} }).ok).toBe(false);
    expect(frame({ playerId: "p-bbbbbbbbbbbbbbbb", category: "other", reporter: "p-x" }).ok).toBe(false);
  });

  test("the workflow: nothing returns to Open; a closed case can only be reopened for review", () => {
    for (const next of Object.values(CONDUCT_TRANSITIONS)) expect(next).not.toContain("open");
    expect(CONDUCT_TRANSITIONS["no-violation"]).toEqual(["under-review"]);
    expect(CONDUCT_TRANSITIONS["conduct-confirmed"]).toEqual(["under-review"]);
  });
});

/* ==================================================================
    THE REVIEW PANEL
   ================================================================== */

const CASE_ID = `cc_${"a".repeat(32)}`;
const party = (playerId: string, nickname: string, account: string) => ({ playerId, nickname, account, joinedAt: 1_779_999_000_000 });
const summary = (over: Record<string, unknown> = {}) => ({
  caseId: CASE_ID,
  gameId: "g_0000000000000000000000000w",
  category: "offer-spam",
  categoryLabel: "Abusive trade-offer spam",
  createdAt: 1_780_000_000_000,
  lastReportAt: 1_780_000_000_000,
  reports: 1,
  status: "open",
  statusLabel: "Open",
  revision: 1,
  reporter: party("p-aaaaaaaaaaaaaaaa", "Ann", "acct-0123456789ab"),
  reported: party("p-bbbbbbbbbbbbbbbb", "Ben", "acct-ba9876543210"),
  hasNote: true,
  ...over,
});
const counts = { offers: 6, accepted: 0, declined: 0, rescinded: 1, forgone: 0, undos: 0, passes: 0, actions: 7 };
const caseBody = (over: Record<string, unknown> = {}) => ({
  ...summary(),
  note: "<img src=x onerror=alert(1)> kept offering",
  evidence: {
    source: "server",
    captured_at: 1_780_000_000_000,
    server_build: "b1",
    rules: { deal_pin: 13, engine: 13 },
    table: { visibility: "public", status: "active", money: false, seats: 3 },
    log: { captured: true, entries: 14, hash: "f".repeat(64), window_from: 0, window_to: 13 },
    timeline: [{ i: 1, at: 1_780_000_001_000, type: "ProposeTrainPurchase", by: "reported", derived: false }, { i: 2, at: 1_780_000_002_000, type: "AnswerTrainPurchase", by: "reporter", derived: false, outcome: "declined" }],
    counts: { reporter: { ...counts, offers: 0, declined: 6, rescinded: 0, actions: 6 }, reported: counts },
    chat: { lines: [{ id: "c1", at: 1_780_000_003_000, by: "reported", text: "lol" }] },
    money: null,
    clock: null,
    not_captured: ["Overdue and foreclosure events: this build has no such events."],
  },
  rereports: [],
  history: [],
  related: { total: 2, active: 1, reporters: 1, games: 2, confirmed: 0, closedNoViolation: 1, known: true },
  verification: { verified: true, detail: "The log's first 14 entries still hash to the value the report recorded." },
  ...over,
});

function reviewServer() {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const answers = new Map<string, Array<{ status: number; body: unknown }>>();
  const port = httpSessionPort({
    endpoint: "https://play.example/gs/api/session",
    replacedRetryMs: 0,
    fetch: async (input, init) => {
      const where = new URL(input).pathname;
      calls.push({ path: where, body: JSON.parse(init.body || "{}") as Record<string, unknown> });
      if (where === "/gs/api/session") return { status: 200, json: async () => ({ ok: true, expiresAt: 1, profile: { name: "Rita", otherSessions: 0 } }) };
      const next = answers.get(where)?.shift();
      if (!next) return { status: 404, json: async () => ({ error: "not-found" }) };
      return { status: next.status, json: async () => next.body };
    },
  });
  return { port, calls, queue: (where: string, status: number, body: unknown) => answers.set(where, [...(answers.get(where) ?? []), { status, body }]) };
}

describe("P3-N032 the review panel", () => {
  test("the parsers keep only the expected shape: a party with an id-like account, or a principal id anywhere, is dropped", () => {
    expect(caseSummaryOf(summary())).not.toBeNull();
    expect(caseSummaryOf(summary({ reporter: party("p-aaaaaaaaaaaaaaaa", "Ann", "pr_0123456789") }))).toBeNull();
    expect(caseSummaryOf(summary({ caseId: "../etc" }))).toBeNull();
    expect(caseViewOf(caseBody({ rereports: [{ at: 1, note: "again", log: { entries: 15, hash: "e".repeat(64) }, counts: { reporter: counts, reported: counts }, chat: [] }] }))?.rereports.length).toBe(1);
    expect(caseViewOf(caseBody({ rereports: [{ at: 1, note: null, log: { captured: false, entries: 0, hash: null }, counts: { reporter: counts, reported: counts }, chat: [] }] }))?.rereports[0].log.captured).toBe(false);
    expect(caseViewOf(caseBody({ rereports: [{ at: 1, note: "again" }] }))).toBeNull();
    const view = caseViewOf(caseBody());
    expect(view).not.toBeNull();
    expect(JSON.stringify(view)).not.toMatch(/\bpr_|\bpf_|\bse_|\bsf_|\brk_/);
  });

  test("queue -> case: the evidence is shown, the reporter's note is TEXT, and a decision asks Confirm it's you when the server wants it", async () => {
    const server = reviewServer();
    server.queue("/gs/api/conduct/review/queue", 200, { ok: true, cases: [summary()], unreadable: 0 });
    server.queue("/gs/api/conduct/review/case", 200, { ok: true, case: caseBody() });
    server.queue("/gs/api/conduct/review/decide", 403, { error: "reauth-required" });
    act(() => show(<ConductReviewPanel onClose={() => undefined} port={server.port} />));
    await flush();
    click(`conduct-case-${CASE_ID}`);
    await flush();
    expect(byId("conduct-case-note")?.textContent).toBe("<img src=x onerror=alert(1)> kept offering");
    expect(document.querySelector("img")).toBeNull();
    expect(byId("conduct-case-verification")?.textContent).toMatch(/Verified/);
    expect(byId("conduct-case-counts")?.textContent).toMatch(/Offers made06/);
    expect(byId("conduct-case-chat")?.textContent).toMatch(/lol/);
    expect(byId("conduct-case-related")?.textContent).toBe("2 (1 waiting) · from 1 reporter(s) at 2 table(s) · 0 confirmed, 1 no violation");
    const select = byId("conduct-decision-status") as HTMLSelectElement;
    expect(Array.from(select.options).map((option) => option.value)).toEqual(["", ...CONDUCT_TRANSITIONS.open]);
    act(() => {
      select.value = "under-review";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => (byId("conduct-decision-save") as HTMLButtonElement).click());
    await flush();
    expect(byId("conduct-reauth-confirm")).not.toBeNull();
    const decide = server.calls.find((call) => call.path === "/gs/api/conduct/review/decide");
    expect(decide?.body).toEqual({ caseId: CASE_ID, revision: 1, status: "under-review", note: null });
  });

  test("a stale case offers a reload; a case the server will not serve (a party's) says so and offers nothing", async () => {
    const server = reviewServer();
    server.queue("/gs/api/conduct/review/queue", 200, { ok: true, cases: [summary()], unreadable: 1 });
    server.queue("/gs/api/conduct/review/case", 200, { ok: true, case: caseBody() });
    server.queue("/gs/api/conduct/review/decide", 409, { error: "stale", reason: "This case changed since you opened it. Reload it and decide again." });
    act(() => show(<ConductReviewPanel onClose={() => undefined} port={server.port} />));
    await flush();
    expect(document.body.textContent).toMatch(/1 stored case\(s\) cannot be read/);
    click(`conduct-case-${CASE_ID}`);
    await flush();
    const select = byId("conduct-decision-status") as HTMLSelectElement;
    act(() => {
      select.value = "no-violation";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => (byId("conduct-decision-save") as HTMLButtonElement).click());
    await flush();
    expect(byId("conduct-decision-error")?.textContent).toMatch(/changed since you opened it/);
    expect(byId("conduct-decision-reload")).not.toBeNull();

    const partyServer = reviewServer();
    partyServer.queue("/gs/api/conduct/review/queue", 200, { ok: true, cases: [summary()], unreadable: 0 });
    partyServer.queue("/gs/api/conduct/review/case", 404, { error: "no-such-case" });
    act(() => show(<ConductReviewPanel key="party" onClose={() => undefined} port={partyServer.port} />));
    await flush();
    click(`conduct-case-${CASE_ID}`);
    await flush();
    expect(byId("conduct-review-error")?.textContent).toMatch(/no longer exists/);
    expect(byId("conduct-decision-status")).toBeNull();
  });

  test("the profile menu offers the review panel only to an account the server names as a reviewer", async () => {
    const plain = reviewServer();
    plain.queue("/gs/api/conduct/me", 200, { ok: true, reviewer: false });
    await plain.port.ensure();
    await act(async () => show(<ProfileMenu port={plain.port} />));
    await flush();
    act(() => (byId("profile-chip") as HTMLElement).click());
    await flush();
    expect(byId("profile-menu-conduct-review")).toBeNull();
    const reviewer = reviewServer();
    reviewer.queue("/gs/api/conduct/me", 200, { ok: true, reviewer: true });
    await reviewer.port.ensure();
    await act(async () => show(<ProfileMenu key="reviewer" port={reviewer.port} />));
    await flush();
    act(() => (byId("profile-chip") as HTMLElement).click());
    await flush();
    expect(byId("profile-menu-conduct-review")).not.toBeNull();
  });
});
