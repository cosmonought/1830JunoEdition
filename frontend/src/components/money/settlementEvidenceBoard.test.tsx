/** @jest-environment jsdom */
//
// ==================================================================
//  INTEGRATED CLOSURE (6.5-B integration review I-4): A DISPUTE'S EVIDENCE IS THE LIVE BOARD
// ==================================================================
//
// `SettlementBand` hands its `board` to `settlementTx`, and a Dispute sends `terminalStateHashV1(board)` to Juno as
// its evidence (`moneyActions.ts`). While the epilogue's round scrubber is set, the shell DRAWS a past board:
// `gameState` is the log replayed to the scrubbed round's end, and `liveState` is the table's own board (design note
// #1425). Both money mounts -- the result's band and the table bar's strip -- used to be handed `gameState`, so a
// Dispute pressed mid-scrub sent a past round's board as its evidence. Both are now handed `liveState`. Only a
// dispute's evidence was affected: the payout check ignores the board (`verifyRecordedSettlement`'s `_board`), and no
// settlement byte, protocol or version changes.
//
// PROVEN BY BEHAVIOUR:
//   - the premise, with the scrubber's own replay of a completed game (the frozen JUNO-CV4 golden log): its last round
//     is the live board, and a past round commits to other evidence -- so which board a mount is handed decides what
//     a dispute sends;
//   - both forms of the band, rendered and pressed through the real Dispute flow on a device whose copy of the game
//     does not match the recorded payout (so both lead with Dispute), against a fake Keplr that records what it
//     signs: each sends exactly the hash of the board it is handed. Handed the live board, it sends the live board's
//     hash whether or not the epilogue is being scrubbed; handed the scrubbed one (the old wiring, mid-scrub), it
//     sends the past round's.
// PINNED IN SOURCE, supplementally (`AppShell` has no render harness yet; APP-TEST-0B designs one): the shell hands
// both mounts `liveState` and never `gameState`, and `gameState` is still the scrubber's board over `liveState` -- so a
// table that is not being scrubbed draws, and disputes with, the one live board.

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "fs";
import { join } from "path";

import { SettlementBand } from "./SettlementBand";
import { activateBoard, STANDARD_BOARD } from "../hexBoardData";
import { installMoneyServicesForTests } from "../../money/moneySession";
import { linked, moneyView, scriptedPort, testServices, TEST_CONTRACT, TEST_WALLET, TICKET, T0 } from "../../money/moneyTestSupport";
import type { RosterSeat } from "../../money/settlementCheck";
import type { ChainGameFacts } from "../../money/walletChecks";
import { resolveVariants } from "../../gameEngine/gameVariants";
import type { GameStateResponse } from "../../gameEngine/gameState";
import { logHash, type HashableLogEntry } from "../../gameEngine/logHash";
import { DEVELOPMENT_CORPUS_POLICY } from "../../gameEngine/rulesVersion";
import { terminalStateHashV1 } from "../../gameEngine/settlementDigest";
import {
  SETTLEMENT_PAYLOAD_KIND,
  SETTLEMENT_PAYLOAD_REASON,
  SETTLEMENT_PAYLOAD_VERSION,
  settleDigestV1,
  settlementPayloadToWire,
  type SettlementPayloadV1,
} from "../../gameEngine/settlementPayload";
import { gameHistoryFrom } from "../../utils/gameHistory";
import type { RoomMoneyView } from "../../utils/moneyProtocol";
import type { RoomView } from "../../utils/roomProtocol";
import { replaySnapshotAtRound, roundEndExclusive } from "../../utils/roundReplay";
import { readShell } from "../../utils/sourceScan";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
global.IS_REACT_ACT_ENVIRONMENT = true;

/* ------------------------------------------------------------------ */
/* The boards: the scrubber's own replay of a completed game          */
/* ------------------------------------------------------------------ */

/* The frozen golden copy of JUNO-CV4 (`roundReplay.test.ts` scrubs the same game), read under the development
   corpus's policy on both sides, as `replaySnapshotAtRound` requires. */
const LOG = readFileSync(join(__dirname, "..", "..", "utils", "__fixtures__", "replayGolden", "logs", "JUNO-CV4.log.jsonl"), "utf8")
  .split("\n")
  .filter((line) => line.trim().length > 0)
  .map((line) => JSON.parse(line)) as never;
const history = gameHistoryFrom(LOG, DEVELOPMENT_CORPUS_POLICY);
const LAST = history.rounds.length - 1;
const SCRUBBED_AT = history.rounds.findIndex((round) => round.label === "OR 4.1");
const boardAtRound = (at: number): GameStateResponse => {
  const snapshot = replaySnapshotAtRound(LOG, history.rounds, at, DEVELOPMENT_CORPUS_POLICY);
  if (snapshot === null) throw new Error(`the scrubber has no board at round ${at}`);
  return snapshot.state;
};

/* ------------------------------------------------------------------ */
/* A recorded payout this device disputes                             */
/* ------------------------------------------------------------------ */

/* The history the server's payout was built from, and this device's own copy, which differs at one move: the check
   finds "doesn't cover the moves this device played" (a mismatch), so both forms of the band lead with Dispute. */
const LOG_LEN = 12;
const recordedHistory: HashableLogEntry[] = Array.from({ length: LOG_LEN }, (_unused, index) => ({
  index,
  actor: index % 2 === 0 ? "p-me" : "p-other",
  payload: JSON.stringify({ Move: index }),
  at: 1000 + index,
}));
const deviceLog: HashableLogEntry[] = recordedHistory.map((entry) => (entry.index === 3 ? { ...entry, payload: JSON.stringify({ Move: 99 }) } : entry));
const recorded: SettlementPayloadV1 = {
  version: SETTLEMENT_PAYLOAD_VERSION,
  domain: "aa".repeat(32),
  seq: BigInt(2 * LOG_LEN + SETTLEMENT_PAYLOAD_KIND.Terminal),
  kind: SETTLEMENT_PAYLOAD_KIND.Terminal,
  reason: SETTLEMENT_PAYLOAD_REASON.BankBroken,
  log_len: BigInt(LOG_LEN),
  log_hash: logHash(recordedHistory, LOG_LEN),
  appraisal_log_len: BigInt(LOG_LEN),
  appraisal_state_hash: "cd".repeat(32),
  state_schema_version: 1,
  seat_count: 2,
  settlement_weights: [BigInt(3), BigInt(1)],
  signer_key_id: 1,
  issued_at: BigInt(0),
};
const digest = settleDigestV1(recorded);
const roster: RosterSeat[] = [
  { playerId: "p-me", chainSeatIndex: 0 },
  { playerId: "p-other", chainSeatIndex: 1 },
];

function room(money: RoomMoneyView): RoomView {
  return {
    gameId: "g_table",
    code: "JUNO-AAAA-BBBB",
    joinable: false,
    visibility: "public",
    status: "playing",
    lifecycle: "completed",
    closed: false,
    held: false,
    holdKind: null,
    hostId: "p-other",
    players: [
      { id: "p-me", nickname: "Brad", isReady: true, online: true },
      { id: "p-other", nickname: "Ana", isReady: true, online: true },
    ],
    playerCount: 2,
    seatCap: 2,
    variants: resolveVariants({} as never),
    createdAtMs: T0,
    undoPolicy: { host_undo: "none" },
    you: { role: "player", playerId: "p-me", kicked: false, canStart: false },
    money,
  };
}

/** A seat whose payout Juno recorded, whose device holds the seat's key, and whose own copy of the game disagrees. */
async function disputingSeat() {
  const services = testServices();
  installMoneyServicesForTests(services);
  const made = await services.keys.create({ chainId: "uni-7", contract: TEST_CONTRACT, gameId: "g_table", playerId: "p-me", wallet: TEST_WALLET });
  if (!made.ok) throw new Error(made.reason);
  const facts: ChainGameFacts = {
    state: "SETTLEABLE",
    creator: "juno1seat1",
    maxPlayers: 2,
    mode: "live",
    rulesEngineVersion: 11,
    variantsDigest: "00".repeat(32),
    denom: "ujunox",
    anteGross: "1000000",
    seats: [
      { wallet: TEST_WALLET, joinTicket: TICKET, consentPubkey: made.pubkey },
      { wallet: "juno1seat1", joinTicket: "ab".repeat(32), consentPubkey: `02${"22".repeat(32)}` },
    ],
    fundingDeadlineMs: null,
    paused: false,
    domain: recorded.domain,
    trustedSeq: "3",
    settlement: { seq: recorded.seq.toString(), payloadDigest: digest },
    /* W2-M (JX-6C): Juno, re-read before the Dispute, still holds this payout, this bond and an open window. */
    bond: "500000",
    challengeWindowEndMs: T0 + 600_000,
    resolverTimeoutAtMs: null,
    resolverTimeoutSecs: 7_200,
    dispute: null,
  };
  services.wallet.game = facts;
  const port = scriptedPort();
  const details = { ok: true, checkpoint: null, settlement: { seq: recorded.seq.toString(), log_len: LOG_LEN, round_key: null, payload: settlementPayloadToWire(recorded), signature: "ab", settle_digest: digest, status: "confirmed" }, chain: null, roster };
  for (let answer = 0; answer < 3; answer += 1) port.answer("money/escrow-details", 200, details);
  const view = moneyView({
    escrow: { chainGameId: "7", state: "SETTLEABLE" },
    terms: { pot: "1980000" },
    settlement: {
      status: "recorded",
      phase: "settleable",
      chainState: "SETTLEABLE",
      seq: recorded.seq.toString(),
      settleDigest: digest,
      domain: recorded.domain,
      source: "terminal_payload",
      windowEnd: T0 + 600_000,
      livenessAvailableAt: null,
      resolverTimeoutAt: T0 + 1_200_000,
      consentedSeats: [],
      payable: true,
      amounts: null,
      route: null,
      trustedSeq: "3",
      annulSigned: [],
      lastCheckpoint: null,
      bond: "500000",
    },
    you: linked([made.pubkey], { funding: "funded", chainSeatIndex: 0, payoutWallet: TEST_WALLET, chainConsentKey: made.pubkey, actions: ["challenge"] }),
  });
  return { services, port, room: room(view) };
}

/* ------------------------------------------------------------------ */
/* Rendering                                                          */
/* ------------------------------------------------------------------ */

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  installMoneyServicesForTests(null);
});
afterAll(() => activateBoard(STANDARD_BOARD));

const settle = async () => {
  await act(async () => {
    for (let n = 0; n < 30; n += 1) await Promise.resolve();
  });
};
const byTestId = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const buttonNamed = (label: string) => Array.from(container.querySelectorAll("button")).find((button) => button.textContent === label) ?? null;
/** The band checks the recorded payout on mount; a few turns of the event loop are enough for the fake port and chain. */
const settleUntil = async (found: () => Element | null): Promise<Element> => {
  for (let round = 0; round < 10; round += 1) {
    const element = found();
    if (element !== null) return element;
    await settle();
  }
  throw new Error("the band never offered what the test waits for");
};
const press = async (element: Element) => {
  act(() => (element as HTMLElement).click());
  await settle();
};

/** Render one form of the band handed `board`, press Dispute, confirm, and return the evidence Keplr was asked to sign. */
async function disputeEvidence(compact: boolean, board: GameStateResponse): Promise<string> {
  const seat = await disputingSeat();
  act(() => root.render(<SettlementBand room={seat.room} compact={compact} log={deviceLog} board={board} port={seat.port} services={seat.services} />));
  await settle();
  if (compact) {
    await press(await settleUntil(() => byTestId("money-strip-challenge")));
    await press(await settleUntil(() => buttonNamed("Continue in Keplr")));
  } else {
    await press(await settleUntil(() => byTestId("settlement-action-challenge")));
    await press(await settleUntil(() => byTestId("settlement-continue")));
  }
  const challenges = seat.services.wallet.signed.filter((message) => message.kind === "challenge");
  expect(challenges).toHaveLength(1);
  const sent = JSON.parse(challenges[0].msgJson) as { challenge: { chain_game_id: number; evidence_hash: string } };
  expect(sent.challenge.chain_game_id).toBe(7);
  return sent.challenge.evidence_hash;
}

/* ------------------------------------------------------------------ */
/* The tests                                                          */
/* ------------------------------------------------------------------ */

describe("a Dispute's evidence is the live board, whether or not the epilogue is being scrubbed (I-4)", () => {
  const live = boardAtRound(LAST);
  const scrubbed = boardAtRound(SCRUBBED_AT);

  it("the premise: the scrubber's last round is the live board, and a past round commits to other evidence", () => {
    /* Design note #1425: the last round runs to the end of the log, and is the live board. */
    expect(history.rounds[LAST].label).toBe("Final");
    expect(roundEndExclusive(history.rounds, LAST)).toBe(Number.POSITIVE_INFINITY);
    expect(SCRUBBED_AT).toBeGreaterThan(0);
    expect(SCRUBBED_AT).toBeLessThan(LAST);
    expect(terminalStateHashV1(live)).toMatch(/^[0-9a-f]{64}$/);
    expect(terminalStateHashV1(scrubbed)).toMatch(/^[0-9a-f]{64}$/);
    expect(terminalStateHashV1(scrubbed)).not.toBe(terminalStateHashV1(live));
  });

  const forms: ReadonlyArray<readonly [string, boolean]> = [
    ["the result's band", false],
    ["the table bar's strip", true],
  ];

  it.each(forms)("%s, handed the live board, sends the live board's hash", async (_form, compact) => {
    const evidence = await disputeEvidence(compact, live);
    expect(evidence).toBe(terminalStateHashV1(live));
    expect(evidence).not.toBe(terminalStateHashV1(scrubbed));
  });

  it.each(forms)("%s sends whatever board it is handed: the scrubbed one, under the old wiring, sends a past round's hash", async (_form, compact) => {
    const evidence = await disputeEvidence(compact, scrubbed);
    expect(evidence).toBe(terminalStateHashV1(scrubbed));
    expect(evidence).not.toBe(terminalStateHashV1(live));
  });
});

describe("the shell hands both money mounts the live board (supplemental source pin)", () => {
  const shell = readShell();

  it("every SettlementBand mount -- the result's band and the table bar's strip -- takes liveState, never gameState", () => {
    const mounts = Array.from(shell.matchAll(/<SettlementBand\b[\s\S]*?\/>/g), (match) => match[0]);
    expect(mounts).toHaveLength(2);
    expect(mounts.filter((mount) => /\bcompact\b/.test(mount))).toHaveLength(1);
    for (const mount of mounts) {
      expect(mount).toMatch(/\bboard=\{liveState\}/);
      expect(mount).not.toMatch(/\bboard=\{gameState\}/);
    }
    expect(shell).not.toMatch(/<SettlementBand\b[^>]*\bboard=\{gameState\}/);
  });

  it("gameState is still the scrubber's board over liveState, so a table that is not scrubbed draws and disputes with one board", () => {
    expect(shell).toContain("const liveState = sandboxState ?? liveGameState;");
    expect(shell).toContain("const gameState = replaySnapshot?.state ?? liveState;");
  });
});
