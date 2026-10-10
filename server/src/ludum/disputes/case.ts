// ==================================================================
//  LUDUM v1 -- POST case { chainGameId }: ONE ESCROW GAME'S DISPUTE CASE (§5 `CaseRecord`, PUBLIC)
// ==================================================================
//  A public read: `caller` is ignored, and the answer carries no account data -- no principal, no `g_…` game id, no log
//  `player_id`. Chain seat wallets are public on chain already.
//  v1.1 (owner, 2026-10-09): each seat's DISPLAY NAME -- the seat account's CURRENT unique display name (never the seat's
//  table nickname, which any player may set to anything, another player's name included) -- mapped through the same
//  frozen roster as `serverTerminal`; null where it cannot be mapped. And the transactions this server relayed for the
//  game (`../transactions.ts`).
//
//  Every part is a §4 `Fact`:
//    * escrow / seats / dispute / chainSettlement -- the chain's own answer, with the port's provenance
//      ("chain-confirmed" + height for a quorum read, else "chain-observed"); parsed by the production parser.
//    * serverTerminal -- the server's own durable financial record ("server-recorded"), mapped to chain seats through
//      its frozen roster, which must agree with the chain's seat wallets.
//    * evidenceMatches -- the challenger's on-chain `evidence_hash` against the two hashes a challenger's device can
//      submit (`frontend/src/money/moneyActions.ts`): `logHash` of the log ("server-log") and `terminalStateHashV1` of
//      the terminal board ("server-board"). Its provenance is the weaker of its two inputs.
//  A part that cannot be known now is `unavailable` with a reason; the rest of the record still answers. Only an
//  unreadable chain answer (or no pinned deployment) makes the whole call 503; a chain with no such game is 404.

import type { CaseRecord, Fact, Junox, Provenance } from "../contract";
import type { LudumHandler, LudumPorts } from "../ports";
import { parseGameResponse, type JunoGameResponse } from "../../escrow/juno/junoContract";
import type { FinancialGameRecord } from "../../escrow/moneyLifecycle";
import type { TerminalSettlementEvidence } from "../../escrow/settlementEvidence";
import { transactionsOf } from "../transactions";

type Answer = { status: number; json: unknown };
type ChainRead = NonNullable<Awaited<ReturnType<LudumPorts["chainGame"]>>>;

/** u64, canonical decimal (no sign, no leading zero). */
const CHAIN_GAME_ID = /^(0|[1-9][0-9]{0,19})$/;
const U64_MAX = (BigInt(1) << BigInt(64)) - BigInt(1);
const NANOS = BigInt(1_000_000_000);

const badRequest = (detail: string): Answer => ({ status: 400, json: { error: "bad-request", detail } });
const notFound = (): Answer => ({ status: 404, json: { error: "not-found", detail: "the escrow has no such game" } });
const unavailableAnswer = (detail: string): Answer => ({ status: 503, json: { error: "unavailable", detail } });

const unavailable = <T>(reason: string): Fact<T> => ({ value: null, provenance: "unavailable", reason });

/** The closed request schema: exactly `{ chainGameId: "<u64 decimal>" }`. */
function chainGameIdOf(body: unknown): string | Answer {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return badRequest("the body must be a JSON object");
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== "chainGameId") return badRequest("the body must be exactly { chainGameId }");
  const id = (body as { chainGameId: unknown }).chainGameId;
  if (typeof id !== "string" || !CHAIN_GAME_ID.test(id) || BigInt(id) > U64_MAX) return badRequest("chainGameId must be a decimal string");
  return id;
}

/** A cosmwasm `Timestamp` (nanoseconds, decimal string) as whole seconds, or null. */
function secondsOfNanos(value: unknown): bigint | null {
  return typeof value === "string" && /^(0|[1-9][0-9]{0,30})$/.test(value) ? BigInt(value) / NANOS : null;
}

/** Whole seconds (bigint or decimal string) as ISO-8601, or null when out of the Date range. */
function isoOfSeconds(secs: bigint | string): string | null {
  const s = typeof secs === "string" ? BigInt(secs) : secs;
  if (s > BigInt(8_640_000_000_000)) return null;
  return new Date(Number(s) * 1000).toISOString();
}

/** §4: the weaker of two provenances. */
const STRENGTH: Readonly<Record<Provenance, number>> = { unavailable: 0, pending: 1, "server-recorded": 2, "chain-observed": 3, "chain-confirmed": 4 };
const weaker = (a: Provenance, b: Provenance): Provenance => (STRENGTH[a] <= STRENGTH[b] ? a : b);

export const caseRecord: LudumHandler = async (body, _caller, ports) => {
  const id = chainGameIdOf(body);
  if (typeof id !== "string") return id;

  const pin = ports.escrowPin();
  if (pin === null) return unavailableAnswer("no escrow deployment is pinned on this server");

  let read: ChainRead | null;
  try {
    read = await ports.chainGame(id);
  } catch {
    return unavailableAnswer("the chain could not be read");
  }
  if (read === null) return notFound();

  let parsed: JunoGameResponse;
  try {
    parsed = parseGameResponse(read.game);
  } catch {
    return unavailableAnswer("the chain's answer could not be parsed");
  }
  const game = parsed.game;
  if (game.chain_game_id !== id) return unavailableAnswer("the chain answered for a different game");
  if (game.denom !== pin.denom) return unavailableAnswer("the chain game is not in the pinned denomination");

  const chainFact = <T>(value: T): Fact<T> => ({
    value,
    provenance: read!.provenance,
    observedAt: read!.observedAt,
    ...(read!.provenance === "chain-confirmed" && read!.height !== undefined ? { height: read!.height } : {}),
  });

  const challenger = game.dispute?.challenger ?? null;
  const dispute = disputeFact(read.game, parsed, chainFact);
  const chainSettlement: CaseRecord["chainSettlement"] =
    game.settlement === null
      ? unavailable("no settlement is recorded on chain for this game")
      : chainFact({
          seq: game.settlement.payload.seq,
          logHash: game.settlement.payload.log_hash,
          appraisalStateHash: game.settlement.payload.appraisal_state_hash,
          weights: [...game.settlement.payload.settlement_weights],
        });

  const serverTerminal = await serverTerminalOf(id, parsed, pin.contract, ports);
  const local = await localGameOf(id, parsed, pin.contract, ports);

  const record: CaseRecord = {
    chainGameId: id,
    contract: pin.contract,
    chainId: pin.chainId,
    escrow: chainFact(game.state.toLowerCase()),
    seats: game.seats.map((seat, chainSeatIndex) => ({
      chainSeatIndex,
      wallet: seat.wallet,
      isChallenger: challenger !== null && seat.wallet === challenger,
      displayName: local?.names.get(chainSeatIndex) ?? null,
    })),
    dispute,
    chainSettlement,
    serverTerminal,
    evidenceMatches: evidenceMatchesOf(game.dispute?.evidence_hash ?? null, dispute, serverTerminal),
    transactions: await transactionsOf(ports, local?.gameId ?? null),
  };
  return { status: 200, json: record };
};

/** The chain's dispute record. `disputed_at` is read from the raw answer (the shared parser does not keep it);
 *  `resolverTimeoutAt` is the chain's own deadline while DISPUTED, else `disputed_at + terms.resolver_timeout_secs`
 *  -- exactly `contracts/escrow/src/query.rs` `deadlines`. */
function disputeFact(raw: unknown, parsed: JunoGameResponse, chainFact: <T>(value: T) => Fact<T>): CaseRecord["dispute"] {
  const d = parsed.game.dispute;
  if (d === null) return unavailable("no dispute is recorded on chain for this game");
  const rawDispute = (raw as { game?: { dispute?: { disputed_at?: unknown } } }).game?.dispute;
  const disputedSecs = secondsOfNanos(rawDispute?.disputed_at);
  const timeoutSecs = parsed.deadlines.resolver_timeout_at !== null ? BigInt(parsed.deadlines.resolver_timeout_at) : disputedSecs !== null ? disputedSecs + BigInt(parsed.game.terms.resolver_timeout_secs) : null;
  if (disputedSecs === null || timeoutSecs === null) return unavailable("the chain's answer does not carry the dispute time");
  const disputedAt = isoOfSeconds(disputedSecs);
  const resolverTimeoutAt = isoOfSeconds(timeoutSecs);
  if (disputedAt === null || resolverTimeoutAt === null) return unavailable("the chain's dispute time is out of range");
  const bond: Junox = { amount: d.bond, denom: "ujunox" };
  return chainFact({ challenger: d.challenger, bond, evidenceHash: d.evidence_hash, disputedAt, resolverTimeoutAt });
}

/** The server's own terminal evidence for this chain game, by chain seat -- only when the server's record is bound to
 *  exactly this deployment and chain game, and its frozen roster names exactly the chain's seat wallets. */
async function serverTerminalOf(id: string, parsed: JunoGameResponse, contract: string, ports: LudumPorts): Promise<CaseRecord["serverTerminal"]> {
  let financial: FinancialGameRecord | null;
  let evidence: TerminalSettlementEvidence | null;
  try {
    financial = await ports.financialByChainGameId(id);
    if (financial === null) return unavailable("this server holds no record of this chain game");
    const escrow = financial.binding?.escrow ?? null;
    if (escrow === null || escrow.chain_game_id !== id || financial.binding!.deployment.contract_address !== contract) return unavailable("this server's record is not bound to this chain game");
    evidence = financial.intent ?? (await ports.terminalEvidence(financial.game_id));
  } catch {
    return unavailable("this server's record could not be read");
  }
  if (evidence === null) return unavailable("this server has no terminal evidence for this game");

  const roster = financial.roster?.roster ?? null;
  const seats = parsed.game.seats;
  if (roster === null || roster.length !== seats.length) return unavailable("this server's frozen roster does not match the chain's seats");
  const totalsBySeat: Array<{ chainSeatIndex: number; dollars: number }> = [];
  for (let i = 0; i < seats.length; i += 1) {
    const entry = roster.find((r) => r.chain_seat_index === i);
    if (entry === undefined || entry.payout_address !== seats[i].wallet) return unavailable("this server's frozen roster does not match the chain's seats");
    const total = evidence.totals[entry.player_id];
    const dollars = typeof total === "string" && /^(0|[1-9][0-9]*)$/.test(total) ? Number(total) : NaN;
    if (!Number.isSafeInteger(dollars)) return unavailable("this server's terminal totals are incomplete");
    totalsBySeat.push({ chainSeatIndex: i, dollars });
  }
  return {
    value: { logLen: evidence.log_len, logHash: evidence.log_hash, appraisalStateHash: evidence.appraisal_state_hash, reason: evidence.terminal_reason, totalsBySeat },
    provenance: "server-recorded",
  };
}

/** v1.1: this server's game for the chain game -- only when its record is bound to exactly this deployment and chain
 *  game and its frozen roster names exactly the chain's seat wallets -- with each chain seat's display name (the seat
 *  account's unique display name, by the roster's `player_id`). Null otherwise (the case still answers, without names). */
async function localGameOf(id: string, parsed: JunoGameResponse, contract: string, ports: LudumPorts): Promise<{ gameId: string; names: Map<number, string> } | null> {
  let financial: FinancialGameRecord | null;
  try {
    financial = await ports.financialByChainGameId(id);
  } catch {
    return null;
  }
  const escrow = financial?.binding?.escrow ?? null;
  if (financial === null || escrow === null || escrow.chain_game_id !== id || financial.binding!.deployment.contract_address !== contract) return null;
  const names = new Map<number, string>();
  const roster = financial.roster?.roster ?? null;
  const seats = parsed.game.seats;
  if (roster === null || roster.length !== seats.length) return { gameId: financial.game_id, names };
  let record = null;
  try {
    for (const candidate of ports.records()) {
      if (candidate.game_id === financial.game_id) {
        record = candidate;
        break;
      }
    }
  } catch {
    return { gameId: financial.game_id, names };
  }
  for (let i = 0; i < seats.length; i += 1) {
    const entry = roster.find((r) => r.chain_seat_index === i);
    if (entry === undefined || entry.payout_address !== seats[i].wallet) return { gameId: financial.game_id, names: new Map() };
    const seat = record?.seats.find((s) => s.player_id === entry.player_id);
    const name = seat !== undefined && ports.accountDisplayName !== undefined ? ports.accountDisplayName(seat.principal_id) : null;
    if (name !== null) names.set(i, name);
  }
  return { gameId: financial.game_id, names };
}

/** The challenger's evidence hash against the server's own log hash and terminal board hash. */
function evidenceMatchesOf(evidenceHash: string | null, dispute: CaseRecord["dispute"], terminal: CaseRecord["serverTerminal"]): CaseRecord["evidenceMatches"] {
  if (evidenceHash === null || dispute.value === null) return unavailable(dispute.reason ?? "no dispute is recorded on chain for this game");
  if (terminal.value === null) return unavailable(terminal.reason ?? "this server has no terminal evidence for this game");
  const hash = evidenceHash.toLowerCase();
  const value = hash === terminal.value.logHash.toLowerCase() ? "server-log" : hash === terminal.value.appraisalStateHash.toLowerCase() ? "server-board" : "neither";
  return {
    value,
    provenance: weaker(dispute.provenance, terminal.provenance),
    ...(dispute.observedAt !== undefined ? { observedAt: dispute.observedAt } : {}),
  };
}
