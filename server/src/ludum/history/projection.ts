// LUDUM v1 -- player history (Lane C): A SEATED ACCOUNT'S VIEW OF ONE GAME (§5 `GameSummary` / `GameDetail`).
//
// What leaves the server: the game's own facts, this account's seat, the other seats' DISPLAY NAMES (nicknames) and
// their in-game results. Never a principal id, a player id, another account's data, or a wallet (the case page reads
// wallets from the chain itself). In-game dollars (`InGameMoney`) and JUNOX (`Junox`) are separate fields of separate
// types and are never summed or compared.

import type { Fact, GameDetail, GameSummary, InGameMoney, Junox } from "../contract";
import type { LudumPorts } from "../ports";
import type { GameRecord, Seat } from "../../rooms/gameRecord";
import type { FinancialGameRecord } from "../../escrow/moneyLifecycle";
import type { TerminalSettlementEvidence } from "../../escrow/settlementEvidence";
import { readChainGame, type ChainView } from "./chainView";
import { chainFact, isoOfMs, isoOfSecs, junox, serverRecorded, unavailable, type ChainSource } from "./facts";
import { ledgerFromChain, ledgerWithoutChain, locateSeat, type Ledger, type SeatOnChain } from "./ledger";

export const LUDUM_ORIGIN = "https://ludum.netadao.org";
export const caseUrlOf = (chainGameId: string): string => `${LUDUM_ORIGIN}/disputes/case/?id=${chainGameId}`;

const NOT_RECORDED = "not recorded; replay required";

type TableStatus = "waiting" | "active" | "completed" | "cancelled" | "expired" | "archived";

/** The table status from the record alone (the log's facts are not a port): the record's own status, its derived
 *  timestamps, and archival. Labelled server-recorded. */
export function tableStatusOf(record: GameRecord, now: number): TableStatus {
  if (record.archived_at !== null) return "archived";
  if (record.status === "cancelled" || record.status === "expired") return record.status;
  if (record.status === "completed" || record.completed_at !== null) return "completed";
  if (record.status === "active" || record.started_at !== null) return "active";
  if (record.expires_at !== null && now >= record.expires_at) return "expired";
  return "waiting";
}

/** A short, human label for the table's variants ("standard · live · delayed auction"), or null. */
export function variantLabelOf(record: GameRecord): string | null {
  const v = record.variants as unknown as Record<string, unknown> | null;
  if (v === null || typeof v !== "object") return null;
  const parts: string[] = [];
  if (typeof v.length === "string") parts.push(v.length);
  if (typeof v.mode === "string") parts.push(v.mode);
  for (const [key, value] of Object.entries(v)) if (value === true) parts.push(key.replace(/[A-Z]/g, (c) => ` ${c.toLowerCase()}`));
  return parts.length === 0 ? null : parts.join(" · ");
}

/** Everything one game's view is built from (read once per game). */
interface Inputs {
  readonly record: GameRecord;
  readonly seat: Seat;
  readonly financial: FinancialGameRecord | null;
  readonly evidence: TerminalSettlementEvidence | null;
  readonly chainGameId: string | null;
  readonly chain: { readonly view: ChainView; readonly source: ChainSource } | { readonly view: null; readonly reason: string } | null;
}

async function inputsOf(ports: LudumPorts, record: GameRecord, seat: Seat): Promise<Inputs> {
  if (record.money === null) {
    /* A no-money table has no financial record and no chain game; its result needs a replay (§1.5). */
    return { record, seat, financial: null, evidence: null, chainGameId: null, chain: null };
  }
  const [financial, evidence] = await Promise.all([
    ports.financial(record.game_id).catch(() => null),
    ports.terminalEvidence(record.game_id).catch(() => null),
  ]);
  const chainGameId = financial?.binding?.escrow?.chain_game_id ?? null;
  if (chainGameId === null || !/^[0-9]{1,20}$/.test(chainGameId)) return { record, seat, financial, evidence, chainGameId: null, chain: null };
  const pin = ports.escrowPin();
  if (pin === null || pin.contract !== record.money.contract_address || pin.chainId !== record.money.chain_id) {
    return { record, seat, financial, evidence, chainGameId, chain: { view: null, reason: "this server does not read the escrow deployment this table is pinned to" } };
  }
  let answer: Awaited<ReturnType<LudumPorts["chainGame"]>>;
  try {
    answer = await ports.chainGame(chainGameId);
  } catch {
    return { record, seat, financial, evidence, chainGameId, chain: { view: null, reason: "the chain could not be read" } };
  }
  if (answer === null) return { record, seat, financial, evidence, chainGameId, chain: { view: null, reason: `the escrow has no game ${chainGameId}` } };
  const read = readChainGame(answer.game);
  if (!read.ok) return { record, seat, financial, evidence, chainGameId, chain: { view: null, reason: read.reason } };
  if (read.view.chainGameId !== chainGameId) return { record, seat, financial, evidence, chainGameId, chain: { view: null, reason: "the chain answered for another game" } };
  const source: ChainSource = { provenance: answer.provenance, observedAt: answer.observedAt, ...(answer.height !== undefined ? { height: answer.height } : {}) };
  return { record, seat, financial, evidence, chainGameId, chain: { view: read.view, source } };
}

/** The server's own reading of the escrow state, when the chain cannot be read: only what its phase proves. */
function escrowFromServer(financial: FinancialGameRecord | null, why: string): Fact<string> {
  if (financial === null) return unavailable(`${why}; no financial record`);
  switch (financial.phase) {
    case "closed":
      return financial.chain_outcome !== null ? serverRecorded(financial.chain_outcome.state.toLowerCase()) : unavailable(why);
    case "cancelled":
      return serverRecorded("cancelled");
    case "settleable":
    case "disputed":
      return serverRecorded(financial.phase);
    case "funding":
      return financial.binding?.escrow == null ? unavailable("no chain game is bound to this table yet") : serverRecorded(financial.chain.started !== null ? "in_progress" : "funding");
    case "held":
      return unavailable(`${why}; the table is held for operator review`);
    default:
      return financial.chain.started !== null ? serverRecorded("in_progress") : unavailable(why);
  }
}

/** Rank and final net worth of each player, from the server's terminal settlement evidence (in-game dollars). */
function inGameResults(inputs: Inputs): (playerId: string) => { rank: Fact<number>; finalNetWorth: Fact<InGameMoney> } {
  if (inputs.record.money === null) return () => ({ rank: unavailable(NOT_RECORDED), finalNetWorth: unavailable(NOT_RECORDED) });
  const evidence = inputs.evidence;
  if (evidence === null || evidence.game_id !== inputs.record.game_id) {
    const why = "no terminal result is recorded for this game";
    return () => ({ rank: unavailable(why), finalNetWorth: unavailable(why) });
  }
  const totals = new Map<string, bigint>();
  for (const [player, total] of Object.entries(evidence.totals)) if (/^-?(0|[1-9][0-9]{0,30})$/.test(total)) totals.set(player, BigInt(total));
  return (playerId) => {
    const mine = totals.get(playerId);
    if (mine === undefined) return { rank: unavailable("the recorded result does not name this seat"), finalNetWorth: unavailable("the recorded result does not name this seat") };
    let above = 0;
    for (const other of totals.values()) if (other > mine) above += 1;
    const dollars = Number(mine);
    return {
      rank: serverRecorded(above + 1),
      finalNetWorth: Number.isSafeInteger(dollars) ? serverRecorded({ dollars }) : unavailable("the recorded total is out of range"),
    };
  };
}

interface Built {
  readonly summary: GameSummary;
  readonly ledger: Ledger | null;
  readonly seatOnChain: SeatOnChain | null;
  readonly inputs: Inputs;
  readonly results: ReturnType<typeof inGameResults>;
}

function build(inputs: Inputs, ports: LudumPorts): Built {
  const { record, seat, financial, chain } = inputs;
  const now = ports.now();
  const results = inGameResults(inputs);
  const mine = results(seat.player_id);
  let money: GameSummary["money"] = null;
  let ledger: Ledger | null = null;
  let seatOnChain: SeatOnChain | null = null;
  let disputed: Fact<boolean> = serverRecorded(false);
  if (record.money !== null) {
    const terms = record.money;
    let escrow: Fact<string>;
    let anteGross: Junox = junox(BigInt(terms.ante_gross));
    if (chain !== null && chain.view !== null) {
      seatOnChain = locateSeat(financial, seat.player_id, chain.view);
      ledger = ledgerFromChain(chain.view, chain.source, seatOnChain);
      escrow = chainFact(chain.view.state, chain.source);
      anteGross = junox(chain.view.anteGross);
      disputed = chainFact(chain.view.dispute !== null, chain.source);
    } else {
      const why = chain === null ? "no chain game is bound to this table" : chain.reason;
      seatOnChain = financial === null ? null : locateSeat(financial, seat.player_id, null);
      ledger = ledgerWithoutChain(terms, financial, why);
      escrow = escrowFromServer(financial, why);
      const phase = financial?.phase ?? null;
      disputed =
        phase === "disputed" ? serverRecorded(true) : phase === "funding" || phase === "cancelled" ? serverRecorded(false) : unavailable(`${why}: whether it was disputed is a chain fact`);
    }
    money = { chainGameId: inputs.chainGameId, contract: terms.contract_address, chainId: terms.chain_id, escrow, anteGross, net: ledger.net };
  }
  const summary: GameSummary = {
    gameId: record.game_id,
    joinCode: record.join_code,
    product: ports.product(),
    variant: variantLabelOf(record),
    table: serverRecorded(tableStatusOf(record, now)),
    createdAt: isoOfMs(record.created_at) ?? new Date(0).toISOString(),
    startedAt: isoOfMs(record.started_at),
    endedAt: isoOfMs(record.completed_at ?? record.cancelled_at ?? record.closed_at),
    seat: { displayName: seat.nickname, chainSeatIndex: seatOnChain?.kind === "seated" ? seatOnChain.index : null },
    playerCount: record.seats.length,
    money,
    inGame: { rank: mine.rank, finalNetWorth: mine.finalNetWorth },
    disputed,
  };
  return { summary, ledger, seatOnChain, inputs, results };
}

export async function summaryOf(ports: LudumPorts, record: GameRecord, seat: Seat): Promise<GameSummary> {
  return build(await inputsOf(ports, record, seat), ports).summary;
}

export async function detailOf(ports: LudumPorts, record: GameRecord, seat: Seat): Promise<GameDetail> {
  const built = build(await inputsOf(ports, record, seat), ports);
  const { inputs, results, ledger, seatOnChain } = built;
  const roster = inputs.financial?.roster ?? null;
  const seats = record.seats.map((other) => {
    const line = roster?.roster.find((r) => r.player_id === other.player_id) ?? null;
    const r = results(other.player_id);
    return { displayName: other.nickname, chainSeatIndex: record.money === null ? null : line?.chain_seat_index ?? null, you: other.player_id === seat.player_id, finalNetWorth: r.finalNetWorth, rank: r.rank };
  });
  const evidence = inputs.evidence;
  const terminal: GameDetail["terminal"] =
    record.money === null
      ? unavailable(NOT_RECORDED)
      : evidence !== null && evidence.game_id === record.game_id
        ? serverRecorded({ reason: evidence.terminal_reason, logLen: evidence.log_len, logHash: evidence.log_hash })
        : unavailable("no terminal result is recorded for this game");
  let dispute: GameDetail["dispute"] = null;
  const chain = inputs.chain;
  if (chain !== null && chain.view !== null && chain.view.dispute !== null) {
    const d = chain.view.dispute;
    const disputedAt = d.disputedAtSecs === null ? null : isoOfSecs(d.disputedAtSecs);
    const timeoutAt = d.disputedAtSecs === null ? null : isoOfSecs(d.disputedAtSecs + chain.view.resolverTimeoutSecs);
    if (seatOnChain?.kind !== "seated") dispute = unavailable("this seat is not mapped to a chain seat, so the challenger cannot be compared");
    else if (disputedAt === null || timeoutAt === null) dispute = unavailable("the chain read does not carry the dispute's time");
    else if (d.resolution === "unknown") dispute = unavailable("the chain read does not say how the dispute ended");
    else {
      const resolution = d.resolution === "upheld" ? "uphold" : d.resolution === "replaced" ? "replace" : d.resolution === "annulled" ? "annul" : null;
      dispute = chainFact(
        {
          challengerIsYou: d.challenger === seatOnChain.wallet,
          bond: junox(d.bond),
          evidenceHash: d.evidenceHash,
          disputedAt,
          resolverTimeoutAt: timeoutAt,
          resolution,
          resolvedAt: d.resolvedAtSecs === null ? null : isoOfSecs(d.resolvedAtSecs),
        },
        chain.source,
      );
    }
  } else if (record.money !== null && (chain === null || chain.view === null) && inputs.financial?.phase === "disputed") {
    dispute = unavailable(`${chain === null ? "no chain game is bound" : chain.reason}; the server recorded this game as disputed`);
  }
  const caseUrl = inputs.chainGameId !== null && dispute !== null ? caseUrlOf(inputs.chainGameId) : null;
  return { ...built.summary, seats, terminal, ledger: ledger === null ? null : { entries: ledger.entries, net: ledger.net, networkFeesIncluded: false }, dispute, caseUrl };
}
