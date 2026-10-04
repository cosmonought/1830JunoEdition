/** @jest-environment node */
// ESCROW-4 (review S-H1): "Approve payout now" is offered only for a payout this device re-derived itself. A terminal
// board reached by a real room (SET-0B's SYN-01: played by RoomSession to GameEnd), laid out in a chain order that is NOT
// turn order, stands in for the sealed prefix's replay; everything else is the real check:
//   - the exact payout matches -- with room-close markers after the seal;
//   - skewed or swapped weights, a history that isn't this device's, gameplay after the seal, a board that isn't at
//     GameEnd, a roster that puts this player on another chain seat than Juno shows: each is a mismatch;
//   - what this device can't establish (no replay, a checkpoint promoted by the inactivity exit) is "unavailable".

import { appraiseCommittedState, canonicalStateText } from "../gameEngine/settlementDigest";
import { logHash, type HashableLogEntry } from "../gameEngine/logHash";
import { SETTLEMENT_PAYLOAD_KIND, SETTLEMENT_PAYLOAD_REASON, SETTLEMENT_PAYLOAD_VERSION, type SettlementPayloadV1 } from "../gameEngine/settlementPayload";
import type { GameStateResponse } from "../gameEngine/gameState";
import { syn01ClassicBankBreak } from "../utils/settlementGoldenBoards";
import { checkTerminalSettlement, type RosterSeat } from "./settlementCheck";
import { settleDigestV1, settlementPayloadToWire } from "../gameEngine/settlementPayload";
import { verifyRecordedSettlement } from "./moneyActions";
import { linked, moneyView, scriptedPort, testServices, TEST_CONTRACT, TEST_WALLET, T0 } from "./moneyTestSupport";
import type { ChainGameFacts } from "./walletChecks";

const { board } = syn01ClassicBankBreak();
const players = [...board.player_addresses];
/* Chain order: deposit order, here the reverse of turn order (so a check that ignored the roster would fail). */
const roster: RosterSeat[] = players.map((playerId, turn) => ({ playerId, chainSeatIndex: players.length - 1 - turn }));
const chainOrder = [...roster].sort((a, b) => a.chainSeatIndex - b.chainSeatIndex).map((seat) => ({ seat_index: seat.chainSeatIndex, player_id: seat.playerId }));
const appraised = appraiseCommittedState(canonicalStateText(board), chainOrder);

const LOG_LEN = 12;
const played: HashableLogEntry[] = Array.from({ length: LOG_LEN }, (_unused, index) => ({ index, actor: players[index % players.length], payload: JSON.stringify({ Move: index }), at: 1000 + index }));
const closed: HashableLogEntry[] = [...played, { index: LOG_LEN, actor: players[0], payload: JSON.stringify({ CloseRoom: {} }), at: 5000 }];

const payload = (over: Partial<SettlementPayloadV1> = {}): SettlementPayloadV1 => ({
  version: SETTLEMENT_PAYLOAD_VERSION,
  domain: "aa".repeat(32),
  seq: BigInt(2 * LOG_LEN + SETTLEMENT_PAYLOAD_KIND.Terminal),
  kind: SETTLEMENT_PAYLOAD_KIND.Terminal,
  reason: SETTLEMENT_PAYLOAD_REASON.BankBroken,
  log_len: BigInt(LOG_LEN),
  log_hash: logHash(played, LOG_LEN),
  appraisal_log_len: BigInt(LOG_LEN),
  appraisal_state_hash: appraised.appraisal_state_hash,
  state_schema_version: 1,
  seat_count: appraised.vector.length,
  settlement_weights: [...appraised.vector],
  signer_key_id: 1,
  issued_at: BigInt(0),
  ...over,
});

const me = roster[0];
const replayed = (at: GameStateResponse | null) => (prefix: readonly HashableLogEntry[]) => (prefix.length === LOG_LEN ? at : null);
const check = (over: Partial<Parameters<typeof checkTerminalSettlement>[0]> = {}) =>
  checkTerminalSettlement({ payload: payload(), log: closed, roster, playerId: me.playerId, chainSeatIndex: me.chainSeatIndex, replay: replayed(board), ...over });

describe("ESCROW-4 (S-H1): the recorded payout, re-derived on this device", () => {
  it("the exact payout matches, room-close markers after the seal included", () => {
    expect(appraised.vector.some((weight, index) => weight !== appraised.vector[appraised.vector.length - 1 - index])).toBe(true); // the order matters here
    expect(check()).toEqual({ result: "match", detail: expect.stringMatching(/counted here/) });
    expect(check({ log: played }).result).toBe("match");
  });

  it("skewed or swapped weights are a mismatch", () => {
    const skewed = [...appraised.vector];
    skewed[0] += BigInt(1);
    expect(check({ payload: payload({ settlement_weights: skewed }) }).result).toBe("mismatch");
    const swapped = [...appraised.vector].reverse();
    expect(check({ payload: payload({ settlement_weights: swapped }) })).toEqual({ result: "mismatch", detail: expect.stringMatching(/own count of the final standings/) });
  });

  it("a roster that moves this player off the chain seat Juno shows as theirs is a mismatch (a consistent swap included)", () => {
    const swappedRoster = roster.map((seat) => ({ ...seat, chainSeatIndex: players.length - 1 - seat.chainSeatIndex }));
    const swappedWeights = [...appraised.vector].reverse();
    /* The server swapped the roster AND the weights consistently: only this device's own chain seat exposes it. */
    expect(check({ roster: swappedRoster, payload: payload({ settlement_weights: swappedWeights }) })).toEqual({ result: "mismatch", detail: expect.stringMatching(/your seat on Juno/) });
    expect(check({ roster: roster.slice(1) }).result).toBe("mismatch");
    expect(check({ roster: [...roster.slice(1), { ...roster[1] }] }).result).toBe("mismatch");
  });

  it("a history that isn't this device's, gameplay after the seal, or a board not at GameEnd: mismatch", () => {
    const other = played.map((entry, index) => (index === 3 ? { ...entry, payload: JSON.stringify({ Move: 99 }) } : entry));
    expect(check({ log: other })).toEqual({ result: "mismatch", detail: expect.stringMatching(/doesn't cover the moves/) });
    const more = [...played, { index: LOG_LEN, actor: players[0], payload: JSON.stringify({ Move: LOG_LEN }), at: 6000 }];
    expect(check({ log: more })).toEqual({ result: "mismatch", detail: expect.stringMatching(/ends before the last move/) });
    expect(check({ replay: replayed({ ...board, current_round_type: "OperatingRound" } as GameStateResponse) }).result).toBe("mismatch");
  });

  it("what this device can't establish is unavailable, never a match", () => {
    expect(check({ replay: replayed(null) }).result).toBe("unavailable");
    expect(check({ log: played.slice(0, LOG_LEN - 1) }).result).toBe("unavailable");
    expect(check({ payload: payload({ kind: SETTLEMENT_PAYLOAD_KIND.Checkpoint, reason: 0, seq: BigInt(2 * LOG_LEN) }) }).result).toBe("unavailable");
    expect(check({ log: closed.map((entry, index) => (index === 2 ? { ...entry, index: 7 } : entry)) }).result).toBe("unavailable");
  });
});

describe("ESCROW-4 (S-H1, verification pass): what a device approves is what JUNO holds, on the seat its own key sits on", () => {
  const good = payload();
  const digest = settleDigestV1(good);
  async function world(over: { facts?: Partial<ChainGameFacts>; keyAt?: number } = {}) {
    const services = testServices();
    const made = await services.keys.create({ chainId: "uni-7", contract: TEST_CONTRACT, gameId: "g_table", playerId: me.playerId, wallet: TEST_WALLET });
    if (!made.ok) throw new Error(made.reason);
    const keyAt = over.keyAt ?? me.chainSeatIndex;
    const seats = players.map((_unused, index) => ({ wallet: `juno1seat${index}`, joinTicket: "ab".repeat(32), consentPubkey: index === keyAt ? made.pubkey : `02${String(index).repeat(64).slice(0, 64)}` }));
    services.wallet.game = {
      state: "SETTLEABLE", creator: "juno1seat0", maxPlayers: players.length, mode: "live", rulesEngineVersion: 11, variantsDigest: "00".repeat(32), denom: "ujunox", anteGross: "1000000",
      seats, fundingDeadlineMs: null, paused: false, domain: good.domain, trustedSeq: "3", settlement: { seq: good.seq.toString(), payloadDigest: digest }, bond: null, challengeWindowEndMs: null, resolverTimeoutAtMs: null, resolverTimeoutSecs: null, dispute: null, ...over.facts,
    };
    const port = scriptedPort();
    port.answer("money/escrow-details", 200, { ok: true, checkpoint: null, settlement: { seq: good.seq.toString(), log_len: LOG_LEN, round_key: null, payload: settlementPayloadToWire(good), signature: "ab", settle_digest: digest, status: "confirmed" }, chain: null, roster });
    const view = moneyView({
      escrow: { chainGameId: "7", state: "SETTLEABLE" },
      terms: { pot: "1980000" },
      settlement: { status: "recorded", phase: "settleable", chainState: "SETTLEABLE", seq: good.seq.toString(), settleDigest: digest, domain: good.domain, source: "terminal_payload", windowEnd: T0 + 600_000, livenessAvailableAt: null, resolverTimeoutAt: null, consentedSeats: [], payable: true, amounts: null, route: null, trustedSeq: "3", annulSigned: [], lastCheckpoint: null, bond: "0" },
      you: linked([made.pubkey], { playerId: me.playerId, funding: "funded", chainSeatIndex: me.chainSeatIndex, payoutWallet: TEST_WALLET, chainConsentKey: made.pubkey }),
    });
    return { services, port, view, key: made.pubkey };
  }
  const verify = async (w: Awaited<ReturnType<typeof world>>) => verifyRecordedSettlement("g_table", w.view, closed, null, w.port, w.services, replayed(board));

  it("the payload Juno stores, on the seat this device's key sits on: match -- and the approval is bound to Juno's values and this key", async () => {
    const w = await world();
    const checked = await verify(w);
    expect(checked).toMatchObject({ result: "match", settleDigest: digest, domain: good.domain, seq: good.seq.toString(), signingKey: w.key });
  });

  it("another escrow game (another domain), another stored payload, a device key on another seat, or none: never a match", async () => {
    expect((await verify(await world({ facts: { domain: "bb".repeat(32) } }))).result).toBe("unavailable");
    expect((await verify(await world({ facts: { settlement: { seq: good.seq.toString(), payloadDigest: "cd".repeat(32) } } }))).result).toBe("unavailable");
    expect((await verify(await world({ facts: { state: "IN_PROGRESS" } }))).result).toBe("unavailable");
    /* The server's roster says this player is on seat `me`, but Juno shows this device's key elsewhere. */
    const elsewhere = players.length - 1 - me.chainSeatIndex === me.chainSeatIndex ? 0 : players.length - 1 - me.chainSeatIndex;
    expect((await verify(await world({ keyAt: elsewhere }))).result).toBe("mismatch");
    expect((await verify(await world({ keyAt: 99 }))).result).toBe("unavailable");
  });
});
