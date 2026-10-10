// LUDUM v1 (Lane B2): the public `case` handler against fake ports. The chain answers are raw `GameResponse` JSON in the
// shape `contracts/escrow/src/query.rs` (and `escrow/juno/fakeJunoChain.ts`) emits, read through the production parser.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { caseRecord } from "./index";
import type { CaseRecord } from "../contract";
import type { LudumPorts } from "../ports";
import type { FinancialGameRecord } from "../../escrow/moneyLifecycle";
import type { TerminalSettlementEvidence } from "../../escrow/settlementEvidence";
import type { ChainIntentRecord } from "../../escrow/chainIntents";
import type { GameRecord } from "../../rooms/gameRecord";

const CONTRACT = "juno19vd5hphghprl2m8agchctyav8pmeh6p4x3vud6cfhd2y6ulwtf0s0jrk7x";
const CHAIN_ID = "uni-7";
const W0 = "juno1seatzeroxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const W1 = "juno1seatonexxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const LOG_HASH = "aa".repeat(32);
const BOARD_HASH = "bb".repeat(32);
const OTHER_HASH = "cc".repeat(32);
const OBSERVED = "2026-10-09T12:00:00.000Z";
const DISPUTED_AT = 1_790_000_000;
const RESOLVER_TIMEOUT = 2_592_000;
const nanos = (secs: number) => `${secs}000000000`;

/* Account data the server holds and must never put on this public wire. */
const GAME_ID = "g_secretgameid";
const PLAYER_IDS = ["player-alice-secret", "player-bob-secret"];
const PRINCIPAL = "pr_secretprincipal";
const DISPLAY_NAME = "Alice Secretname";

type DisputeKind = "none" | "open" | "resolved";

function rawGame(id: number, kind: DisputeKind, evidenceHash = LOG_HASH): unknown {
  const state = kind === "none" ? "settleable" : kind === "open" ? "disputed" : "settled";
  const payload = { seq: "7", kind: 1, reason: 1, log_len: "120", log_hash: LOG_HASH, appraisal_log_len: "120", appraisal_state_hash: BOARD_HASH, settlement_weights: ["600", "400"], signer_key_id: 1, payload_digest: "dd".repeat(32) };
  return {
    game: {
      chain_game_id: id,
      state,
      creator: W0,
      max_players: 2,
      mode: "live",
      rules_engine_version: 10,
      variants_digest: "ee".repeat(32),
      denom: "ujunox",
      ante_gross: "1000000",
      ante_net: "975000",
      terms: { challenge_window_secs: 600, liveness_window_secs: 86_400, resolver_timeout_secs: RESOLVER_TIMEOUT, treasury: "juno1treasury", subsidy_bps: 250, policy: "timed_remedy_v1" },
      pool: "1950000",
      seats: [W0, W1].map((wallet, i) => ({ wallet, consent_pubkey: `0${2 + i}${"11".repeat(32)}`, join_ticket: `${i}${i}`.repeat(32), gross_deposit: "1000000", subsidy_paid: "25000", net_deposit: "975000", joined_at: nanos(1_789_000_000) })),
      roster_hash: "ff".repeat(32),
      domain: "ab".repeat(32),
      bond: "1000000",
      resolver: "juno1fccq3dcjjn35fgt8u8jfz5kvcajfk604lhl85w25k6pr32q9r7psk6wrpu",
      last_seq: "7",
      settlement: { source: "settle", payload, accepted_at: nanos(DISPUTED_AT - 100), window_end: nanos(DISPUTED_AT + 500) },
      consent_bitmap: 0,
      dispute:
        kind === "none"
          ? null
          : { challenger: W1, bond: "1000000", evidence_hash: evidenceHash, disputed_at: nanos(DISPUTED_AT), resolution: kind === "resolved" ? "upheld" : null, resolved_at: kind === "resolved" ? nanos(DISPUTED_AT + 3600) : null },
      outcome: kind === "resolved" ? { route: "resolver_uphold", at: nanos(DISPUTED_AT + 3600), amounts: ["1170000", "780000"], dust: "0", distributed: "1950000", bond_returned: "0", bond_to_pool: "1000000" } : null,
      review_request: null,
      remedy: null,
    },
    paused: false,
    trusted_seq: "7",
    latest_checkpoint: null,
    deadlines: {
      funding_deadline: nanos(1_789_500_000),
      liveness_available_at: null,
      challenge_window_end: kind === "none" ? nanos(DISPUTED_AT + 500) : null,
      resolver_timeout_at: kind === "open" ? nanos(DISPUTED_AT + RESOLVER_TIMEOUT) : null,
    },
  };
}

const EVIDENCE: TerminalSettlementEvidence = {
  format: "18COSMOS/SETTLEMENT-EVIDENCE/v1",
  game_id: GAME_ID,
  log_len: 120,
  sealed_at: 1_789_999_000_000,
  log_hash: LOG_HASH,
  appraisal_log_len: 120,
  appraisal_state_hash: BOARD_HASH,
  rules_engine_version: 10,
  terminal_reason: "BankBroken",
  players: PLAYER_IDS,
  totals: { [PLAYER_IDS[0]]: "6000", [PLAYER_IDS[1]]: "4000" },
};

function financialRecord(chainGameId: string, over: { intent?: TerminalSettlementEvidence | null; rosterWallets?: string[]; contract?: string } = {}): FinancialGameRecord {
  const wallets = over.rosterWallets ?? [W0, W1];
  return {
    game_id: GAME_ID,
    phase: "disputed",
    intent: over.intent === undefined ? EVIDENCE : over.intent,
    binding: { deployment: { contract_address: over.contract ?? CONTRACT, chain_id: CHAIN_ID, denom: "ujunox" }, escrow: { chain_game_id: chainGameId } },
    roster: { roster: wallets.map((payout_address, chain_seat_index) => ({ chain_seat_index, player_id: PLAYER_IDS[chain_seat_index], payout_address, join_ticket_hex: "", consent_public_key_hex: "" })) },
    /* never on the wire */
    owner_principal: PRINCIPAL,
    display_name: DISPLAY_NAME,
  } as unknown as FinancialGameRecord;
}

interface Fakes {
  games?: Record<string, unknown>;
  financial?: Record<string, FinancialGameRecord>;
  evidence?: Record<string, TerminalSettlementEvidence>;
  provenance?: "chain-confirmed" | "chain-observed";
  chainThrows?: boolean;
  financialThrows?: boolean;
  pin?: LudumPorts["escrowPin"] extends () => infer R ? R : never;
  /** v1.1: the game records (seat nicknames) and the relayed chain intents. */
  records?: GameRecord[];
  intents?: Record<string, ChainIntentRecord[]>;
}

function ports(f: Fakes): LudumPorts {
  const forbidden = () => {
    throw new Error("the public case handler must not read account data");
  };
  return {
    records: f.records !== undefined ? () => f.records! : forbidden,
    seatOf: forbidden,
    financial: forbidden,
    financialByChainGameId: async (id) => {
      if (f.financialThrows) throw new Error("store down");
      return f.financial?.[id] ?? null;
    },
    terminalEvidence: async (gameId) => f.evidence?.[gameId] ?? null,
    chainGame: async (id) => {
      if (f.chainThrows) throw new Error("rpc down");
      const game = f.games?.[id];
      if (game === undefined) return null;
      const provenance = f.provenance ?? "chain-confirmed";
      return provenance === "chain-confirmed" ? { game, provenance, height: "4242", observedAt: OBSERVED } : { game, provenance, observedAt: OBSERVED };
    },
    escrowPin: () => (f.pin === undefined ? { contract: CONTRACT, chainId: CHAIN_ID, denom: "ujunox" } : f.pin),
    product: () => ({ key: "project-18xx", name: "Project 18XX" }),
    now: () => DISPUTED_AT * 1000,
    ...(f.intents !== undefined ? { chainIntents: async (gameId: string) => f.intents![gameId] ?? [] } : {}),
  };
}

async function ask(p: LudumPorts, body: unknown, principalId: string | null = null) {
  return caseRecord(body, { principalId }, p);
}

async function caseOf(p: LudumPorts, id: string): Promise<CaseRecord> {
  const answer = await ask(p, { chainGameId: id });
  assert.equal(answer.status, 200, JSON.stringify(answer.json));
  return answer.json as CaseRecord;
}

/** §4: `value` is null iff the provenance is `unavailable`, and an unavailable fact always has a reason. */
function assertFactShape(record: CaseRecord): void {
  for (const key of ["escrow", "dispute", "chainSettlement", "serverTerminal", "evidenceMatches"] as const) {
    const fact = record[key];
    assert.equal(fact.value === null, fact.provenance === "unavailable", key);
    if (fact.provenance === "unavailable") assert.ok(typeof fact.reason === "string" && fact.reason.length > 0, key);
  }
}

describe("ludum case: game kinds", () => {
  test("an open dispute: chain facts, server terminal, challenger seat, deadlines", async () => {
    const p = ports({ games: { "5": rawGame(5, "open") }, financial: { "5": financialRecord("5") } });
    const record = await caseOf(p, "5");
    assertFactShape(record);
    assert.equal(record.chainGameId, "5");
    assert.equal(record.contract, CONTRACT);
    assert.equal(record.chainId, CHAIN_ID);
    assert.deepEqual(record.escrow, { value: "disputed", provenance: "chain-confirmed", observedAt: OBSERVED, height: "4242" });
    assert.deepEqual(record.seats, [
      { chainSeatIndex: 0, wallet: W0, isChallenger: false, displayName: null },
      { chainSeatIndex: 1, wallet: W1, isChallenger: true, displayName: null },
    ]);
    assert.deepEqual(record.dispute.value, {
      challenger: W1,
      bond: { amount: "1000000", denom: "ujunox" },
      evidenceHash: LOG_HASH,
      disputedAt: new Date(DISPUTED_AT * 1000).toISOString(),
      resolverTimeoutAt: new Date((DISPUTED_AT + RESOLVER_TIMEOUT) * 1000).toISOString(),
    });
    assert.equal(record.dispute.provenance, "chain-confirmed");
    assert.equal(record.dispute.height, "4242");
    assert.deepEqual(record.chainSettlement.value, { seq: "7", logHash: LOG_HASH, appraisalStateHash: BOARD_HASH, weights: ["600", "400"] });
    assert.deepEqual(record.serverTerminal, {
      value: { logLen: 120, logHash: LOG_HASH, appraisalStateHash: BOARD_HASH, reason: "BankBroken", totalsBySeat: [{ chainSeatIndex: 0, dollars: 6000 }, { chainSeatIndex: 1, dollars: 4000 }] },
      provenance: "server-recorded",
    });
    assert.equal(record.evidenceMatches.value, "server-log");
  });

  test("a resolved dispute: the escrow state and the chain's dispute times (no live resolver deadline)", async () => {
    const p = ports({ games: { "6": rawGame(6, "resolved") }, financial: { "6": financialRecord("6") }, provenance: "chain-observed" });
    const record = await caseOf(p, "6");
    assertFactShape(record);
    assert.deepEqual(record.escrow, { value: "settled", provenance: "chain-observed", observedAt: OBSERVED });
    assert.equal(record.dispute.provenance, "chain-observed");
    assert.equal(record.dispute.height, undefined);
    /* query.rs drops the deadline once the game leaves DISPUTED; the record keeps disputed_at + resolver_timeout_secs. */
    assert.equal(record.dispute.value?.resolverTimeoutAt, new Date((DISPUTED_AT + RESOLVER_TIMEOUT) * 1000).toISOString());
    assert.equal(record.seats[1].isChallenger, true);
    assert.equal(record.evidenceMatches.value, "server-log");
  });

  test("a game that was never disputed: dispute and evidenceMatches are unavailable, the rest answers", async () => {
    const p = ports({ games: { "7": rawGame(7, "none") }, financial: { "7": financialRecord("7") } });
    const record = await caseOf(p, "7");
    assertFactShape(record);
    assert.equal(record.escrow.value, "settleable");
    assert.equal(record.dispute.provenance, "unavailable");
    assert.match(record.dispute.reason!, /no dispute/);
    assert.equal(record.evidenceMatches.provenance, "unavailable");
    assert.ok(record.seats.every((s) => !s.isChallenger));
    assert.equal(record.serverTerminal.provenance, "server-recorded");
  });

  test("an unknown game is 404 not-found", async () => {
    const answer = await ask(ports({ games: {} }), { chainGameId: "999" });
    assert.deepEqual(answer, { status: 404, json: { error: "not-found", detail: "the escrow has no such game" } });
  });

  test("a chain game this server never recorded: serverTerminal and evidenceMatches unavailable", async () => {
    const record = await caseOf(ports({ games: { "8": rawGame(8, "open") } }), "8");
    assertFactShape(record);
    assert.equal(record.dispute.provenance, "chain-confirmed");
    assert.equal(record.serverTerminal.provenance, "unavailable");
    assert.equal(record.evidenceMatches.provenance, "unavailable");
  });

  test("a signed-in caller gets exactly the same public record", async () => {
    const p = ports({ games: { "5": rawGame(5, "open") }, financial: { "5": financialRecord("5") } });
    assert.deepEqual(await ask(p, { chainGameId: "5" }, PRINCIPAL), await ask(p, { chainGameId: "5" }, null));
  });
});

describe("ludum case: evidenceMatches", () => {
  const cases: Array<[string, string, "server-log" | "server-board" | "neither"]> = [
    ["the server's log hash", LOG_HASH, "server-log"],
    ["the server's terminal board hash", BOARD_HASH, "server-board"],
    ["any other hash", OTHER_HASH, "neither"],
  ];
  for (const [label, hash, expected] of cases) {
    test(`evidence = ${label} -> ${expected}`, async () => {
      const p = ports({ games: { "5": rawGame(5, "open", hash) }, financial: { "5": financialRecord("5") } });
      const record = await caseOf(p, "5");
      assert.deepEqual(record.evidenceMatches, { value: expected, provenance: "server-recorded", observedAt: OBSERVED });
    });
  }

  test("the server's evidence is read from terminalEvidence when the record carries no intent", async () => {
    const p = ports({ games: { "5": rawGame(5, "open", BOARD_HASH) }, financial: { "5": financialRecord("5", { intent: null }) }, evidence: { [GAME_ID]: EVIDENCE } });
    assert.equal((await caseOf(p, "5")).evidenceMatches.value, "server-board");
  });

  test("no terminal evidence anywhere: unavailable", async () => {
    const p = ports({ games: { "5": rawGame(5, "open") }, financial: { "5": financialRecord("5", { intent: null }) } });
    const record = await caseOf(p, "5");
    assert.equal(record.serverTerminal.provenance, "unavailable");
    assert.equal(record.evidenceMatches.provenance, "unavailable");
  });

  test("a server record whose roster disagrees with the chain's seats is not used", async () => {
    const p = ports({ games: { "5": rawGame(5, "open") }, financial: { "5": financialRecord("5", { rosterWallets: [W1, W0] }) } });
    const record = await caseOf(p, "5");
    assert.match(record.serverTerminal.reason!, /roster/);
    assert.equal(record.evidenceMatches.provenance, "unavailable");
  });

  test("a server record bound to another contract or chain game is not used", async () => {
    for (const fin of [financialRecord("5", { contract: "juno1othercontract" }), financialRecord("55")]) {
      const record = await caseOf(ports({ games: { "5": rawGame(5, "open") }, financial: { "5": fin } }), "5");
      assert.match(record.serverTerminal.reason!, /not bound/);
    }
  });

  test("an unreadable server store degrades only the server facts", async () => {
    const record = await caseOf(ports({ games: { "5": rawGame(5, "open") }, financialThrows: true }), "5");
    assert.equal(record.dispute.provenance, "chain-confirmed");
    assert.match(record.serverTerminal.reason!, /could not be read/);
  });
});

describe("ludum case: no account data", () => {
  test("no principal, game id, player id or account name in any output (v1.1: a seat's TABLE name only, below)", async () => {
    const p = ports({
      games: { "5": rawGame(5, "open"), "6": rawGame(6, "resolved", BOARD_HASH), "7": rawGame(7, "none") },
      financial: { "5": financialRecord("5"), "6": financialRecord("6"), "7": financialRecord("7") },
      evidence: { [GAME_ID]: EVIDENCE },
    });
    const answers = [];
    for (const id of ["5", "6", "7", "999"]) answers.push(await ask(p, { chainGameId: id }, PRINCIPAL));
    answers.push(await ask(p, { chainGameId: "5", gameId: GAME_ID }, PRINCIPAL));
    const wire = JSON.stringify(answers);
    for (const secret of [GAME_ID, PRINCIPAL, DISPLAY_NAME, ...PLAYER_IDS, "pr_", "pf_", "principal", "username"]) {
      assert.ok(!wire.includes(secret), secret);
    }
  });

  test("the record has exactly the §5 CaseRecord keys", async () => {
    const record = await caseOf(ports({ games: { "5": rawGame(5, "open") }, financial: { "5": financialRecord("5") } }), "5");
    assert.deepEqual(Object.keys(record).sort(), ["chainGameId", "chainId", "chainSettlement", "contract", "dispute", "escrow", "evidenceMatches", "seats", "serverTerminal", "transactions"]);
    for (const seat of record.seats) assert.deepEqual(Object.keys(seat).sort(), ["chainSeatIndex", "displayName", "isChallenger", "wallet"]);
  });
});

/* v1.1 (owner request 2026-10-09): each seat's table name, and the transactions this server relayed. */
describe("ludum case v1.1: seat display names and relayed transactions", () => {
  const seatsRecord = (names: string[]): GameRecord =>
    ({ game_id: GAME_ID, seats: names.map((nickname, i) => ({ player_id: PLAYER_IDS[i], principal_id: `${PRINCIPAL}${i}`, nickname })) }) as unknown as GameRecord;
  const hash = (c: string) => c.repeat(64);
  const intent = (kind: string, over: Partial<ChainIntentRecord>): ChainIntentRecord =>
    ({ intent_id: `i-${kind}`, game_id: GAME_ID, op: { kind }, status: "confirmed", created_at: 1, updated_at: 2, attempts: [], confirmation: null, ...over }) as unknown as ChainIntentRecord;

  test("each chain seat carries its table name, mapped through the frozen roster -- never the principal or the player id", async () => {
    const record = await caseOf(ports({ games: { "5": rawGame(5, "open") }, financial: { "5": financialRecord("5") }, records: [seatsRecord(["Marlowe", "Quill"])] }), "5");
    assert.deepEqual(record.seats.map((seat) => seat.displayName), ["Marlowe", "Quill"]);
    const wire = JSON.stringify(record);
    for (const secret of [GAME_ID, PRINCIPAL, ...PLAYER_IDS]) assert.ok(!wire.includes(secret), secret);
  });

  test("no names when the roster does not match the chain, the record is unbound, or the index cannot be read", async () => {
    const mismatch = await caseOf(ports({ games: { "5": rawGame(5, "open") }, financial: { "5": financialRecord("5", { rosterWallets: [W1, W0] }) }, records: [seatsRecord(["Marlowe", "Quill"])] }), "5");
    assert.deepEqual(mismatch.seats.map((seat) => seat.displayName), [null, null]);
    const unbound = await caseOf(ports({ games: { "5": rawGame(5, "open") }, financial: { "5": financialRecord("5", { contract: "juno1other" }) }, records: [seatsRecord(["Marlowe", "Quill"])] }), "5");
    assert.deepEqual(unbound.seats.map((seat) => seat.displayName), [null, null]);
    const unreadable = await caseOf(ports({ games: { "5": rawGame(5, "open") }, financial: { "5": financialRecord("5") } }), "5");
    assert.deepEqual(unreadable.seats.map((seat) => seat.displayName), [null, null]);
  });

  test("relayed transactions: included (chain-observed, height) and broadcast (pending); failed and hashless ones left out", async () => {
    const intents = [
      intent("start", { created_at: 1, attempts: [{ phase: "included-success", tx_hash: hash("A"), inclusion: { height: "100" }, observed_at: 10 }] as never }),
      intent("checkpoint", { created_at: 2, status: "in-flight", attempts: [{ phase: "dead", tx_hash: hash("B") }, { phase: "broadcast", tx_hash: hash("C") }] as never }),
      intent("settle", { created_at: 3, confirmation: { how: "chain-state", tx_hash: null, height: null, detail: "", at: 5 } }),
      intent("finalize", { created_at: 4, status: "superseded", attempts: [{ phase: "included-failure", tx_hash: hash("D") }] as never }),
    ];
    const record = await caseOf(ports({ games: { "5": rawGame(5, "open") }, financial: { "5": financialRecord("5") }, intents: { [GAME_ID]: intents } }), "5");
    assert.equal(record.transactions?.provenance, "server-recorded");
    const relayed = record.transactions!.value!.relayed;
    assert.deepEqual(relayed.map((tx) => [tx.op, tx.txHash, tx.status.value, tx.status.provenance, tx.status.height ?? null]), [
      ["start", hash("A"), "included", "chain-observed", "100"],
      ["checkpoint", hash("C"), "broadcast", "pending", null],
    ]);
    assert.equal(record.transactions!.value!.walletSigned, "not-server-recorded");
  });

  test("no server record of the game: transactions unavailable, the rest still answers", async () => {
    const record = await caseOf(ports({ games: { "5": rawGame(5, "open") }, intents: {} }), "5");
    assert.equal(record.transactions?.provenance, "unavailable");
  });
});

describe("ludum case: requests and failures", () => {
  const p = ports({ games: { "5": rawGame(5, "open") } });
  for (const body of [null, [], "5", {}, { chainGameId: 5 }, { chainGameId: "05" }, { chainGameId: "-1" }, { chainGameId: "1.0" }, { chainGameId: "" }, { chainGameId: "18446744073709551616" }, { chainGameId: "5", extra: 1 }]) {
    test(`bad request: ${JSON.stringify(body)}`, async () => {
      const answer = await ask(p, body);
      assert.equal(answer.status, 400);
      assert.equal((answer.json as { error: string }).error, "bad-request");
    });
  }

  test("no pinned deployment, an unreachable chain, or an unparseable answer: 503 unavailable", async () => {
    const bad = [ports({ pin: null, games: { "5": rawGame(5, "open") } }), ports({ chainThrows: true }), ports({ games: { "5": { game: { state: "nonsense" } } } }), ports({ games: { "5": rawGame(6, "open") } })];
    for (const q of bad) {
      const answer = await ask(q, { chainGameId: "5" });
      assert.equal(answer.status, 503);
      assert.equal((answer.json as { error: string }).error, "unavailable");
    }
  });
});
