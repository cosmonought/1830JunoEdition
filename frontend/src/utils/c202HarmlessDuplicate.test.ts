/** @jest-environment node */
//
// ==================================================================
//  C2-02 (DA-7, 2026-09-27): A HARMLESS DUPLICATE ANSWER IS SETTLED, NOT RECORDED
// ==================================================================
//
// LIVE-2F/3D found it (`claude/LIVE2F_LIVE3D_HOSTED_AUTHORITY_CERTIFICATION_2026-09-27.md` §6, C2-02): a consent answer
// that finds nothing to answer -- #662's "harmless duplicate" -- was APPLIED AND APPENDED by the room (#1687 kept it
// that way, like `CloseRoom`'s race loser). Ingress asks no seat question once there is nothing to answer, so any
// seated player, off turn and party to nothing, could commit one: an entry that did nothing, became the table's last
// action (so the one-step undo of the real move beneath it was refused, RV-6), and could be repeated at the submit
// budget until the log reached its cap. The path was `consentAnswerRefusal` -> `harmlessDuplicateAnswer` ->
// `unchangedMeansRefused` keeping the entry.
//
// THE INVARIANTS PINNED HERE, all through a real `RoomSession`:
//   1. a harmless duplicate never becomes history -- nothing appended, the board and the digest untouched -- for every
//      one of the four answer kinds, from an off-turn seat party to nothing, however often it is sent;
//   2. it cannot displace the meaningful previous action: after any number of them, the one-step undo still lands on
//      the last real decision, for its own player and for the host;
//   3. legitimate duplicate DELIVERY is idempotent: a retry of the answer that landed (same nonce) is the #1209
//      catch-up carrying its own entry; a second press (new nonce) is settled with the no-blame sentence, and its own
//      retry meets the same answer;
//   4. the counterparty's first legal response still lands, and an answer that is illegal while its offer STANDS is
//      still refused with its own sentence (not this one);
//   5. restore / replay stay deterministic, and a duplicate a room committed before this fix still replays as the
//      no-op it always was -- stored logs are not rewritten.

export {};

const { RoomSession } = require("./roomSession") as typeof import("./roomSession");
const { stateDigest } = require("../gameEngine/stateDigest") as typeof import("../gameEngine/stateDigest");
const { replayLog } = require("../gameEngine/replayLog") as typeof import("../gameEngine/replayLog");
const { sandboxReplayProviders } = require("../gameEngine/replayProviders") as typeof import("../gameEngine/replayProviders");
const { DEVELOPMENT_CORPUS_POLICY } = require("../gameEngine/rulesVersion") as typeof import("../gameEngine/rulesVersion");
const { effectiveActions, revertRefusal } = require("../gameEngine/logRevert") as typeof import("../gameEngine/logRevert");
const { turnRefusal } = require("../gameEngine/turnAuthority") as typeof import("../gameEngine/turnAuthority");
const { harmlessDuplicateAnswer, HARMLESS_DUPLICATE_ANSWER_SENTENCE } =
  require("../gameEngine/harmlessDuplicate") as typeof import("../gameEngine/harmlessDuplicate");
const { actionWasRefused } = require("./refusedAction") as typeof import("./refusedAction");
const { moneyTotal } = require("../gameEngine/cashLedger") as typeof import("../gameEngine/cashLedger");
const F = require("./offerFixtures74") as typeof import("./offerFixtures74");
const S = require("./offerMatrix74Support") as typeof import("./offerMatrix74Support");

type GameStateResponse = import("../gameEngine/gameState").GameStateResponse;
type ServerLogEntry = import("./roomSession").ServerLogEntry;
type Room = InstanceType<typeof RoomSession>;

const { P1, P2, P3, PRR, NYC, DH, operatingBoard } = F;
const { withCorp, priv, trains, M, GRID } = S;

/** Every consent answer, each naming something that is no longer on offer. */
const ANSWERS: ReadonlyArray<[string, unknown]> = [
  ["AnswerPrivatePurchase", M.answerPrivate(DH, true)],
  ["AnswerTrainPurchase", M.answerTrain(NYC, true)],
  ["AnswerPrivateTrade", M.answerTrade(DH, true)],
  ["AnswerFundingPrivateOffer", { AnswerFundingPrivateOffer: { game_id: 1, private_id: DH, accept: true } }],
];

/** A room whose PRR has just bought the D&H from P2 through an accepted offer: 0 propose (P1), 1 answer (P2), 2
 *  settlement*. Nothing is on offer any more. */
function settledRoom(seed: GameStateResponse = operatingBoard()) {
  const harness = S.roomFor(seed);
  expect(harness.submit(P1, M.proposePrivate(DH, PRR, 100)).kind).toBe("applied");
  expect(harness.kinds(harness.submit(P2, M.answerPrivate(DH, true)))).toEqual(["AnswerPrivatePurchase", "BuyPrivateCompany*"]);
  expect(harness.room.state.private_purchase_offer ?? null).toBeNull();
  expect(priv(harness.room.state, DH).owner_protocol_id).toBe(PRR);
  return harness;
}

const send = (room: Room, actor: string, msg: unknown, submissionId?: string) =>
  room.submit({
    actor,
    build: "b",
    host: P1,
    msg: msg as never,
    baseIndex: room.nextIndex - 1,
    ...(submissionId === undefined ? {} : { submissionId }),
  });

/** The room's log, board and digest: what "nothing happened" is measured against. */
const snapshot = (room: Room) => ({
  entries: room.entries.length,
  lastId: room.entries[room.entries.length - 1]?.id ?? null,
  digest: stateDigest(room.state),
  json: JSON.stringify(room.state),
});

describe("C2-02: a harmless duplicate answer is settled for its sender and never recorded", () => {
  it("1. an off-turn seat that is party to nothing cannot grow the log -- every answer kind, over and over", () => {
    const { room } = settledRoom();
    const before = snapshot(room);
    for (let round = 0; round < 5; round += 1) {
      for (const [kind, msg] of ANSWERS) {
        // The board has nothing to answer, so ingress's #662 exemption still admits it (no rules refusal is claimed)...
        expect([kind, harmlessDuplicateAnswer(room.state, msg)]).toEqual([kind, true]);
        expect([kind, turnRefusal({ state: room.state, waterfall: null, actor: P3, msg: msg as never, host: P1, log: room.entries, mapGrid: GRID })]).toEqual([kind, null]);
        // ...and the room settles it without a word of blame and without an entry.
        expect([kind, send(room, P3, msg)]).toEqual([kind, expect.objectContaining({ kind: "refused", reason: HARMLESS_DUPLICATE_ANSWER_SENTENCE })]);
        expect([kind, snapshot(room)]).toEqual([kind, before]);
      }
    }
    // The shell's own receipt is unchanged: a solo table still prints no REFUSED line for it.
    for (const [kind, msg] of ANSWERS) {
      expect([kind, actionWasRefused(room.state, { ...room.state }, msg as never)]).toEqual([kind, false]);
    }
  });

  it("2. it cannot displace the last real decision from the one-step undo -- for its own player, and for the host", () => {
    // Before C2-02 the duplicate became the last live non-derived entry, so both of these were refused (RV-6 / RV-7).
    for (const undoer of [P2, P1]) {
      const { room, kinds } = settledRoom();
      for (let n = 0; n < 3; n += 1) for (const [, msg] of ANSWERS) send(room, P3, msg);
      const last = [...effectiveActions(room.entries)].reverse().find((entry) => !entry.derived)!;
      expect([last.index, last.actor, Object.keys(JSON.parse(last.payload))[0]]).toEqual([1, P2, "AnswerPrivatePurchase"]);
      expect(revertRefusal({ log: room.entries, index: 1, actor: undoer, isHost: undoer === P1, board: room.state })).toBeNull();
      const undone = send(room, undoer, M.revert(1, undoer));
      expect([undoer, undone.kind]).toEqual([undoer, "applied"]);
      expect(kinds(undone)).toEqual(["RevertTo"]);
      // The acceptance and its settlement are taken back together; the offer stands again, unanswered.
      expect(room.state.private_purchase_offer).toMatchObject({ private_id: DH, owner: P2, instance: 1 });
      expect(priv(room.state, DH).owner).toBe(P2);
    }
  });

  it("3. duplicate DELIVERY is idempotent: the landed answer's retry is its own catch-up; a second press is settled, and so is its retry", () => {
    const harness = S.roomFor(operatingBoard());
    const { room } = harness;
    harness.submit(P1, M.proposePrivate(DH, PRR, 100));
    const first = send(room, P2, M.answerPrivate(DH, true), "answer-1");
    expect(first.kind).toBe("applied");
    const landed = snapshot(room);
    const own = room.entries.find((entry) => (entry as ServerLogEntry).submission_id === "answer-1")!;
    expect(Object.keys(JSON.parse(own.payload))).toEqual(["AnswerPrivatePurchase"]);

    // A retry of the SAME submission (a dropped socket) -- even from a client that never saw its answer land.
    const retry = room.submit({ actor: P2, build: "b", host: P1, msg: M.answerPrivate(DH, true) as never, baseIndex: own.index - 1, submissionId: "answer-1" });
    expect(retry.kind).toBe("catch-up");
    expect(((retry as { entries: ServerLogEntry[] }).entries).map((entry) => entry.id)).toContain(own.id);
    expect(snapshot(room)).toEqual(landed);

    // A second press (a new nonce): nothing to answer any more -- settled, not recorded, not remembered.
    for (let n = 0; n < 2; n += 1) {
      expect(send(room, P2, M.answerPrivate(DH, true), "answer-2")).toMatchObject({ kind: "refused", reason: HARMLESS_DUPLICATE_ANSWER_SENTENCE });
      expect(snapshot(room)).toEqual(landed);
    }
    expect(room.entries.filter((entry) => (entry as ServerLogEntry).submission_id === "answer-2")).toEqual([]);
    expect(moneyTotal(room.state)).toBe(moneyTotal(operatingBoard()));
  });

  it("4. the counterparty's first legal answer lands; an answer illegal while its offer STANDS keeps its own refusal", () => {
    const seed = withCorp(operatingBoard(), NYC, { owned_trains: ["3", "3", "2"] });
    const { room, submit, kinds } = S.roomFor(seed);
    submit(P1, M.proposeTrain(NYC, PRR, "3", "150"));
    const standing = snapshot(room);
    // Not the selling president: ingress's own sentence, not the harmless one; nothing appended.
    expect(submit(P3, M.answerTrain(NYC, true))).toMatchObject({ kind: "refused", reason: "Only the selling corporation's president can answer that offer." });
    expect(harmlessDuplicateAnswer(room.state, M.answerTrain(NYC, true))).toBe(false);
    expect(snapshot(room)).toEqual(standing);
    // The seller's president answers: applied, the settlement derived, exactly once.
    expect(kinds(submit(P2, M.answerTrain(NYC, true)))).toEqual(["AnswerTrainPurchase", "BuyTrainFromCorporation*"]);
    expect(trains(room.state, NYC)).toEqual(["3", "2"]);
    // And the same answer again is now the harmless duplicate.
    const settled = snapshot(room);
    expect(submit(P2, M.answerTrain(NYC, true))).toMatchObject({ kind: "refused", reason: HARMLESS_DUPLICATE_ANSWER_SENTENCE });
    expect(snapshot(room)).toEqual(settled);
  });

  it("5. restore and replay agree, and a duplicate committed before this fix still replays as the no-op it was", () => {
    const seed = operatingBoard();
    const { room } = settledRoom(seed);
    for (const [, msg] of ANSWERS) send(room, P3, msg);
    const live = snapshot(room);
    // The room's own log: restore it twice, replay it once -- one board.
    for (let pass = 0; pass < 2; pass += 1) {
      const restored = S.roomFor(seed);
      restored.room.restore(room.entries as ServerLogEntry[]);
      expect(stateDigest(restored.room.state)).toBe(live.digest);
    }
    const providers = { ...sandboxReplayProviders(), initialGrid: GRID };
    expect(stateDigest(replayLog(room.entries, providers, { state: seed, waterfall: null }, undefined, DEVELOPMENT_CORPUS_POLICY).state)).toBe(live.digest);

    // A pre-fix room's log: the same history with the duplicates committed as entries (what #1687 wrote).
    const legacy: ServerLogEntry[] = [...(room.entries as ServerLogEntry[])];
    for (const [kind, msg] of ANSWERS) {
      legacy.push({ index: legacy.length, id: `legacy-dup-${kind}`, actor: P3, payload: JSON.stringify(msg) } as ServerLogEntry);
    }
    const old = S.roomFor(seed);
    old.room.restore(legacy);
    expect(stateDigest(old.room.state)).toBe(live.digest); // no-ops, as they always were
    expect(old.room.entries).toHaveLength(legacy.length); // and nothing rewrote the stored log
    expect(stateDigest(replayLog(legacy, providers, { state: seed, waterfall: null }, undefined, DEVELOPMENT_CORPUS_POLICY).state)).toBe(live.digest);
  });
});
