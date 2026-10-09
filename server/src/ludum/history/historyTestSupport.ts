// LUDUM v1 -- player history (Lane C): test fixtures. Fake `LudumPorts` over in-memory records and the offline escrow
// (`escrow/juno/fakeJunoChain.ts`), whose `smart` answers the contract's own `GameResponse` JSON.

import type { LudumPorts } from "../ports";
import { seatOf, MONEY_TABLE_FORMAT, type GameRecord, type Seat } from "../../rooms/gameRecord";
import { FINANCIAL_FORMAT, FINANCIAL_VERSION, MONEY_BINDING_FORMAT, NO_CHAIN_PROGRESS, type FinancialGameRecord, type FinancialPhase } from "../../escrow/moneyLifecycle";
import { SETTLEMENT_EVIDENCE_FORMAT, type TerminalSettlementEvidence } from "../../escrow/settlementEvidence";
import { FakeJunoChain, type FakeSeat } from "../../escrow/juno/fakeJunoChain";
import { parseGameResponse, QUERY } from "../../escrow/juno/junoContract";

export const CHAIN_ID = "uni-7";
export const CONTRACT = "juno19vd5hphghprl2m8agchctyav8pmeh6p4x3vud6cfhd2y6ulwtf0s0jrk7x";
export const RESOLVER = "juno1resolverdaocore";
export const T0 = 1_760_000_000_000;

/** 2 JUNOX gross at 250 bps: 50_000 subsidy, 1_950_000 net (the contract's golden vector); bond floor 1 JUNOX. */
export const ANTE_GROSS = "2000000";
export const ANTE_NET = "1950000";
export const BOND = "1000000";

export const PEOPLE = [
  { principal: "pr_alice", player: "p-alice", nick: "Alice", wallet: "juno1alicewallet" },
  { principal: "pr_bob", player: "p-bob", nick: "Bob", wallet: "juno1bobwallet" },
  { principal: "pr_carol", player: "p-carol", nick: "Carol", wallet: "juno1carolwallet" },
] as const;

const hex = (byte: string, bytes: number) => byte.repeat(bytes);

let serial = 0;
/** A valid `g_` id, distinct per call. */
export function gameIdOf(n = (serial += 1)): string {
  const alphabet = "0123456789abcdefghjkmnpqrstvwxyz";
  let body = "";
  let x = n;
  for (let i = 0; i < 25; i += 1) {
    body = alphabet[x % 32] + body;
    x = Math.floor(x / 32);
  }
  return `g_${body}0`;
}

function seatFor(person: (typeof PEOPLE)[number], at: number): Seat {
  return { player_id: person.player, principal_id: person.principal, binding_epoch: 0, joined_at: at, bound_at: at, ready: true, nickname: person.nick, color: null, payout_address: null, chain_seat_index: null };
}

export function recordOf(over: { gameId?: string; money?: boolean; createdAt?: number; people?: number; status?: GameRecord["status"]; startedAt?: number | null; completedAt?: number | null; archivedAt?: number | null } = {}): GameRecord {
  const created = over.createdAt ?? T0;
  const people = PEOPLE.slice(0, over.people ?? 3);
  const money = over.money ?? true;
  return {
    record_schema: money ? 2 : 1,
    record_version: 1,
    game_id: over.gameId ?? gameIdOf(),
    join_code: null,
    visibility: "private",
    status: over.status ?? "completed",
    archived_at: over.archivedAt ?? null,
    host_player_id: people[0].player,
    seats: people.map((p) => seatFor(p, created)),
    seat_cap: people.length,
    exact_players: money ? people.length : null,
    variants: { length: "standard", mode: "live", delayedAuction: true } as unknown as GameRecord["variants"],
    admitted: [],
    kicked_principals: [],
    turn_order: null,
    rules_engine_version: null,
    protocol_version: null,
    created_at: created,
    created_by_principal: people[0].principal,
    started_at: over.startedAt === undefined ? created + 1000 : over.startedAt,
    completed_at: over.completedAt === undefined ? created + 2000 : over.completedAt,
    closed_at: null,
    cancelled_at: null,
    expires_at: null,
    last_activity_at: created,
    money: money
      ? {
          format: MONEY_TABLE_FORMAT,
          backend: "juno-cosmwasm",
          chain_id: CHAIN_ID,
          network_class: "testnet",
          contract_address: CONTRACT,
          code_checksum: hex("c", 64),
          denom: "ujunox",
          symbol: "JUNOX",
          exponent: 6,
          ante_gross: ANTE_GROSS,
          mode: "live",
        }
      : null,
    policy: { host_undo: money ? "none" : "last-action", private_spectators: false, spectator_chat: false, max_viewers: 50 },
  };
}

/** The server's financial record for a money table: bound to `chainGameId`, the roster frozen in seat order. */
export function financialOf(gameId: string, chainGameId: string | null, phase: FinancialPhase, over: { roster?: boolean; started?: boolean; people?: number } = {}): FinancialGameRecord {
  const people = PEOPLE.slice(0, over.people ?? 3);
  const roster = over.roster ?? chainGameId !== null;
  return {
    format: FINANCIAL_FORMAT,
    version: FINANCIAL_VERSION,
    game_id: gameId,
    record_version: 1,
    phase,
    continuation: null,
    created_at: T0,
    updated_at: T0,
    last_activity_at: null,
    terminal: null,
    intent: null,
    hold: phase === "held" ? { code: "game-held", detail: "test", at: T0, from: "in-progress" } : null,
    transitions: [],
    binding: {
      format: MONEY_BINDING_FORMAT,
      deployment: { backend: "juno-cosmwasm", codec: "juno-cosmwasm-v1", chain_id: CHAIN_ID, network_class: "testnet", contract_address: CONTRACT, code_checksum: hex("c", 64), denom: "ujunox" } as never,
      escrow: chainGameId === null ? null : ({ chain_game_id: chainGameId } as never),
    },
    roster: roster
      ? {
          roster: people.map((p, i) => ({ chain_seat_index: i, player_id: p.player, payout_address: p.wallet, join_ticket_hex: hex(String(i + 1), 64), consent_public_key_hex: `02${hex(String(i + 1), 64)}` })),
          roster_hash: hex("a", 64),
          expected_domain: hex("b", 64),
          frozen_at: T0,
        }
      : null,
    roster_epoch: roster ? 1 : 0,
    chain: over.started === false ? NO_CHAIN_PROGRESS : { ...NO_CHAIN_PROGRESS, started: { height: "100", domain: hex("b", 64), at: T0 } },
    chain_outcome: phase === "closed" ? { state: "SETTLED", route: "finalized", observed_at: T0 } : null,
  };
}

export function evidenceOf(gameId: string, totals: Record<string, string>): TerminalSettlementEvidence {
  return {
    format: SETTLEMENT_EVIDENCE_FORMAT,
    game_id: gameId,
    log_len: 40,
    sealed_at: T0,
    log_hash: hex("1", 64),
    appraisal_log_len: 40,
    appraisal_state_hash: hex("2", 64),
    rules_engine_version: 1,
    terminal_reason: "BankBroken",
    players: Object.keys(totals),
    totals,
  };
}

export function chainOf(): FakeJunoChain {
  return new FakeJunoChain({
    chainId: CHAIN_ID,
    contract: CONTRACT,
    operator: "juno1relayer",
    resolver: RESOLVER,
    treasury: "juno1treasury",
    denom: "ujunox",
    admin: null,
    codeId: "125",
    codeChecksum: hex("c", 64),
    signerKeys: [`02${hex("9", 64)}`],
    admissionPubkey: `02${hex("8", 64)}`,
    challengeWindowSecs: 600,
    resolverTimeoutSecs: 2_592_000,
    subsidyBps: 250,
  });
}

export const fakeSeats = (people = 3): FakeSeat[] =>
  PEOPLE.slice(0, people).map((p, i) => ({ wallet: p.wallet, consent_pubkey: `02${hex(String(i + 1), 64)}`, join_ticket: hex(String(i + 1), 64) }));

/** A FUNDED chain game for the three people (CreateGame + Joins, as the wallets would have made it). */
export const fundedChainGame = (chain: FakeJunoChain, people = 3): string =>
  chain.seedFundedGame({ seats: fakeSeats(people), anteGross: ANTE_GROSS, anteNet: ANTE_NET, rulesEngineVersion: 1, variantsDigest: hex("d", 64) });

/** Start then Settle, as `play.rs` stores them: the bond and resolver frozen, a stored settlement with these weights,
 *  its challenge window open (state SETTLEABLE). */
export function settleOn(chain: FakeJunoChain, chainGameId: string, weights: readonly string[]): void {
  const g = chain.games.get(Number(chainGameId))!;
  g.state = "settleable";
  g.started_at = chain.time;
  g.resolver = RESOLVER;
  g.bond = BOND;
  g.roster_hash = hex("a", 64);
  g.domain = hex("b", 64);
  g.last_seq = "81";
  g.settlement = {
    source: "server_settle",
    payload: {
      seq: "81", kind: 1, reason: 1, log_len: "40", log_hash: hex("1", 64), appraisal_log_len: "40", appraisal_state_hash: hex("2", 64), state_schema_version: 1,
      settlement_weights: [...weights], signer_key_id: 1, issued_at: String(chain.time), payload_digest: hex("e", 64),
    },
    accepted_at: chain.time,
    window_end: chain.time + 600,
  };
}

/** Start only (IN_PROGRESS). */
export function startOn(chain: FakeJunoChain, chainGameId: string): void {
  const g = chain.games.get(Number(chainGameId))!;
  g.state = "in_progress";
  g.started_at = chain.time;
  g.resolver = RESOLVER;
  g.bond = BOND;
}

export interface World {
  readonly chain: FakeJunoChain;
  readonly records: GameRecord[];
  readonly financial: Map<string, FinancialGameRecord>;
  readonly evidence: Map<string, TerminalSettlementEvidence>;
  /** How `chainGame` answers: the raw contract JSON, the production parser's output, a single endpoint, or failure. */
  mode: "raw-quorum" | "parsed-quorum" | "observed" | "throws" | "null";
  readonly ports: LudumPorts;
}

export function worldOf(): World {
  const chain = chainOf();
  const world: World = {
    chain,
    records: [],
    financial: new Map(),
    evidence: new Map(),
    mode: "raw-quorum",
    ports: undefined as unknown as LudumPorts,
  };
  const ports: LudumPorts = {
    records: () => world.records,
    seatOf: (record, principalId) => seatOf(record, principalId),
    financial: async (gameId) => world.financial.get(gameId) ?? null,
    financialByChainGameId: async (id) => [...world.financial.values()].find((f) => f.binding?.escrow?.chain_game_id === id) ?? null,
    terminalEvidence: async (gameId) => world.evidence.get(gameId) ?? null,
    chainGame: async (id) => {
      if (world.mode === "throws") throw new Error("node down");
      if (world.mode === "null" || !chain.games.has(Number(id))) return null;
      const raw = await chain.smart(CONTRACT, QUERY.game(id));
      const observedAt = new Date(T0).toISOString();
      if (world.mode === "observed") return { game: raw, provenance: "chain-observed", observedAt };
      return { game: world.mode === "parsed-quorum" ? parseGameResponse(raw) : raw, provenance: "chain-confirmed", height: String(chain.height), observedAt };
    },
    escrowPin: () => ({ contract: CONTRACT, chainId: CHAIN_ID, denom: "ujunox" }),
    product: () => ({ key: "project-18xx", name: "Project 18XX" }),
    now: () => T0 + 10_000,
  };
  (world as { ports: LudumPorts }).ports = ports;
  return world;
}

/** A money table for the three people, bound to a fresh chain game, registered in the world. */
export function moneyTable(world: World, phase: FinancialPhase = "closed", over: { roster?: boolean; started?: boolean; createdAt?: number } = {}): { gameId: string; chainGameId: string } {
  const chainGameId = fundedChainGame(world.chain);
  const record = recordOf({ createdAt: over.createdAt });
  world.records.push(record);
  world.financial.set(record.game_id, financialOf(record.game_id, chainGameId, phase, over));
  return { gameId: record.game_id, chainGameId };
}
