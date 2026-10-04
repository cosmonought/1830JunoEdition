/** @jest-environment node */
//
// ==================================================================
//  PHASE 3 W2-E (U-35 iv, K-17; owner ruling OD-3): A QUEUED M&H EXCHANGE IS NOT AN EXECUTED ONE
// ==================================================================
//
// Driven through a ROOM (the server path every client replays), so every board below is one the reducer actually
// produced -- `pending_mh_exchange` written by the queue, cleared by the settlement -- and the sentences are read
// off those boards exactly as the shell reads them:
//
//   1. a queued request reads REQUESTED, never EXECUTED, and the requester alone is acknowledged;
//   2. it stays visibly pending (the chip and the table view) until the boundary, and not one step longer;
//   3. at the boundary it reads EXECUTED only if the certificate moved and the M&H closed;
//   4. a request that became impossible reads OD-3's generic "expired" line -- no guessed reason, no substitution;
//   5. the owner's own-turn exchange reads EXECUTED at once and never passes through "pending";
//   6. W1-C stands: the pile in every sentence is the request's, and the shell still asks the authority.

import { MH_PRIVATE_ID } from "../gameEngine/privateExchange";
import { CURRENT_RULES_REVISION } from "../gameEngine/gameVariants";
import { RULES_ENGINE_VERSION } from "../gameEngine/rulesVersion";
import { cellAt } from "../components/marketChart";
import type { GameStateResponse } from "../gameEngine/gameState";
import type { MapGridResponse } from "../components/hexContractTypes";
import { describeGameplayAction } from "./actionLog";
import {
  MH_EXCHANGE_EXPIRED_SENTENCE,
  mhExchangeDispatchOutcome,
  mhQueuedAcknowledgement,
  mhSettlementOutcome,
  mhSettlementSentence,
  pendingMhExchangeView,
  withPendingMhExchangeChip,
} from "./mhQueuedExchange";
import { stockRoundExchangeOffers } from "./activePrivatePower";
import { roomFor } from "./offerMatrix74Support";
import { readShell, sliceBetween } from "./sourceScan";

const P1 = "p1";
const P2 = "p2";
const P3 = "p3";
const NYC = 2;
const NAMES: Record<string, string> = { [P1]: "Alice", [P2]: "Bob", [P3]: "Cara" };
const nameFor = (address: string) => NAMES[address] ?? address;

function cell(x: number, y: number) {
  const found = cellAt(x, y);
  if (!found) throw new Error(`no chart cell at (${x}, ${y})`);
  return { x, y, price: found.price };
}
const NORMAL = cell(9, 7);

/** A Stock Round board: P1 owns the M&H, `seat` is seated, NYC floated with the given piles. */
function board(seat: number, ipo: number, pool: number): GameStateResponse {
  const players = [P1, P2, P3];
  return {
    game_id: 1,
    variants: { rules: CURRENT_RULES_REVISION },
    rules_engine_version: RULES_ENGINE_VERSION,
    player_addresses: players,
    player_cash: players.map((player) => ({ player, cash_vgp: "500" })),
    virtual_bank_vgp: "10000",
    private_companies: [
      { private_id: MH_PRIVATE_ID, name: "Mohawk & Hudson", cost: "110", revenue_per_or: "20", owner: P1, owner_protocol_id: null, closed: false },
    ],
    current_round_type: "StockRound",
    macro_round_number: 3,
    active_player_index: seat,
    priority_deal_index: 0,
    last_trader_index: null,
    consecutive_passes: 0,
    active_operating_order: [],
    active_corporation_index: 0,
    sub_round_index: 0,
    operating_round_sequence_length: 1,
    operating_round_just_ended: false,
    stock_round_just_ended: false,
    current_global_era: "Yellow",
    bought_this_turn: 0,
    turn_action_taken: false,
    market_positions: { [NYC]: { ...NORMAL, enteredAt: 1 } },
    public_companies: [
      {
        company_id: NYC,
        ticker: "NYC",
        is_floated: true,
        president: P2,
        par_value: "100",
        ipo_pool_percentage: ipo,
        bank_pool_percentage: pool,
        treasury: "300",
        owned_trains: [],
        /* Bob presides with at most 40%, Cara holds the rest -- so Bob may still buy (the 60% cap). */
        player_holdings: [
          { player: P2, percentage: Math.min(40, 100 - ipo - pool) },
          ...(100 - ipo - pool > 40 ? [{ player: P3, percentage: 100 - ipo - pool - 40 }] : []),
        ],
        station_token_hexes: [],
        station_tokens: [],
        station_token_limit: 3,
        home_hex_label: null,
        last_route_revenue: "0",
      },
    ],
  } as unknown as GameStateResponse;
}

const EXCHANGE = (source: "Ipo" | "Bank") => ({
  ExchangePrivate: { game_id: 1, private_id: MH_PRIVATE_ID, company_id: NYC, player: P1, source },
});
const PASS = { PassTurn: { game_id: 1 } };
const BUY_NYC = (source: "Ipo" | "Bank") => ({
  BuyStock: { game_id: 1, protocol_id: NYC, quantity: 1, source, par_value: "100" },
});

const GRID = { game_id: 1, tiles: [] } as unknown as MapGridResponse;
const narrate = (msg: unknown, before: GameStateResponse, after: GameStateResponse | undefined) =>
  describeGameplayAction(msg as never, {
    gameState: before,
    afterState: after,
    mapGrid: GRID,
    era: "Yellow",
    labelForAddress: nameFor,
  });

const mhOf = (state: GameStateResponse) => state.private_companies.find((p) => p.private_id === MH_PRIVATE_ID)!;
const nycOf = (state: GameStateResponse) => state.public_companies.find((c) => c.company_id === NYC)!;
const held = (state: GameStateResponse, player: string) =>
  nycOf(state).player_holdings.find((h) => h.player === player)?.percentage ?? 0;

/** Bob is seated; Alice queues from `source`; returns every board along the way.
 *
 *  PHASE 3 W2-A x W3-K reconciliation (rules v13, OD-2): this board deals the CURRENT rules revision, where ONE
 *  "Pass Turn" ends a Stock Round turn (`rulesV13StockRound.test.ts`). The revision-1 driver this replaced reached
 *  the boundary with two Passes (Sell -> Buy, then end, #1443) and used the first as the "non-boundary" step; on
 *  revision 2 that first Pass IS the boundary. The non-boundary step is now Bob's one ordinary Buy, taken from the
 *  pile Alice did NOT choose (so her request stays legal), which leaves the turn with Bob until his Pass Turn. A
 *  test that supplies `beforeBoundary` supplies its own mid-turn step instead. */
function queuedThenBoundary(source: "Ipo" | "Bank", ipo = 30, pool = 20, beforeBoundary?: (submit: (a: string, m: unknown) => void) => void) {
  const seed = board(1, ipo, pool);
  const { room, submit } = roomFor(seed);
  submit(P1, EXCHANGE(source));
  const queued = room.state;
  if (beforeBoundary) beforeBoundary(submit);
  else submit(P2, BUY_NYC(source === "Ipo" ? "Bank" : "Ipo")); // Bob's one Buy: still Bob's turn (OD-2), not a boundary
  const preBoundary = room.state;
  const midTurn = preBoundary;
  submit(P2, PASS); // OD-2: one Pass Turn ends Bob's turn -- the boundary
  const settled = room.state;
  return { seed, queued, preBoundary, midTurn, settled };
}

describe("1. a queued request reads REQUESTED, and only the requester is acknowledged", () => {
  it("the reducer queued it (the board is the authority), and the log line says so -- not EXECUTED", () => {
    const { seed, queued } = queuedThenBoundary("Ipo");
    expect(queued.pending_mh_exchange).toEqual({ player: P1, private_id: MH_PRIVATE_ID, company_id: NYC, source: "Ipo" });
    expect(mhOf(queued).closed).toBe(false);

    expect(mhExchangeDispatchOutcome(seed, queued, { private_id: MH_PRIVATE_ID, player: P1 })).toBe("requested");
    const line = narrate(EXCHANGE("Ipo"), seed, queued)!;
    expect(line).toBe(
      "M&H exchange REQUESTED — Alice asked to exchange the Mohawk & Hudson for a 10% share of NYC from the IPO. " +
        "It is queued, not executed: it executes at the next turn boundary only if it is still legal then.",
    );
    expect(line).not.toContain("EXECUTED");
    expect(line).not.toContain("closes");
    // Queuing is not a settlement.
    expect(mhSettlementSentence(seed, queued, nameFor)).toBeNull();
  });

  it("the acknowledgement goes to the requester, and to nobody else", () => {
    const { seed, queued } = queuedThenBoundary("Ipo");
    expect(mhQueuedAcknowledgement(seed, queued, P1)).toBe(
      "Your M&H exchange request (a 10% NYC share from the IPO) is queued, not executed. " +
        "It executes at the next turn boundary only if it is still legal then; nothing is reserved until it does.",
    );
    expect(mhQueuedAcknowledgement(seed, queued, P2)).toBeNull();
    expect(mhQueuedAcknowledgement(seed, queued, null)).toBeNull();
    // Not re-acknowledged by later actions while it stands.
    const { queued: q, preBoundary } = queuedThenBoundary("Ipo");
    expect(mhQueuedAcknowledgement(q, preBoundary, P1)).toBeNull();
  });
});

describe("2. the request stays visibly pending until the boundary, and not one step longer", () => {
  it("chip and table read the same view while it stands, including through the non-boundary Buy", () => {
    const { seed, queued, midTurn, settled } = queuedThenBoundary("Ipo");
    // The non-boundary step really happened (OD-2): Bob bought from the Bank Pool and still holds the turn.
    expect(held(midTurn, P2)).toBe(held(queued, P2) + 10);
    expect(nycOf(midTurn).bank_pool_percentage).toBe(nycOf(queued).bank_pool_percentage - 10);
    expect(midTurn.active_player_index).toBe(1);
    expect(settled.active_player_index).not.toBe(1);
    expect(pendingMhExchangeView(seed, nameFor)).toBeNull();
    for (const standing of [queued, midTurn]) {
      const view = pendingMhExchangeView(standing, nameFor)!;
      expect(view.privateId).toBe(MH_PRIVATE_ID);
      expect(view.requester).toBe(P1);
      expect(view.marker).toBe("Exchange requested — pending");
      expect(view.chipLabel).toBe("MH exchange pending");
      expect(view.sentence).toContain("Alice has requested to exchange the Mohawk & Hudson for a 10% share of NYC from the IPO.");
      expect(view.sentence).toContain("Queued, not executed");
    }
    expect(mhSettlementSentence(queued, midTurn, nameFor)).toBeNull();
    expect(pendingMhExchangeView(settled, nameFor)).toBeNull();
  });

  it("the M&H chip is relabelled and greyed with the pending sentence; other chips and an empty view are untouched", () => {
    const { queued } = queuedThenBoundary("Ipo");
    const offers = stockRoundExchangeOffers({ state: queued, viewerAddress: P1, sandbox: true, mhPrivateId: MH_PRIVATE_ID });
    expect(offers).toHaveLength(1);
    const view = pendingMhExchangeView(queued, nameFor);
    const shown = withPendingMhExchangeChip(offers, view);
    expect(shown[0].chipLabel).toBe("MH exchange pending");
    expect(shown[0].blockedReason).toBe(view!.sentence);

    const other = [{ abilityKey: "dh-tile", chipLabel: "Lay Track (F16)" }];
    expect(withPendingMhExchangeChip(other, view)).toEqual(other);
    expect(withPendingMhExchangeChip(offers, null)).toBe(offers);
  });
});

describe("3. at the boundary it reads EXECUTED only when the exchange actually happened", () => {
  it.each([
    ["Ipo", "IPO"],
    ["Bank", "Bank Pool"],
  ] as const)("chosen %s: the certificate moved, the M&H closed, and the line names that pile", (source, label) => {
    const { midTurn, settled } = queuedThenBoundary(source);
    expect(settled.pending_mh_exchange).toBeNull();
    expect(held(settled, P1)).toBe(10);
    expect(mhOf(settled).closed).toBe(true);

    expect(mhSettlementOutcome(midTurn, settled)?.kind).toBe("executed");
    expect(mhSettlementSentence(midTurn, settled, nameFor)).toBe(
      `M&H exchange EXECUTED — Alice exchanged the Mohawk & Hudson for a 10% share of NYC from the ${label}. The private company closes.`,
    );
    // The boundary action's own line is Bob's Pass -- the settlement does not borrow it.
    expect(narrate(PASS, midTurn, settled)).not.toContain("M&H");
  });
});

describe("4. a request that became impossible reads OD-3's generic line -- and nothing is substituted", () => {
  it("the chosen IPO empties before the boundary: expired, M&H still open, the Bank Pool untouched", () => {
    const { preBoundary, settled } = queuedThenBoundary("Ipo", 10, 30, (submit) => submit(P2, BUY_NYC("Ipo")));
    /* Bob bought; his turn continues until ONE Pass Turn ends it (OD-2; on revision 1 the same single Pass, #1443):
       the boundary is that Pass. */
    const midTurn = preBoundary;
    expect(nycOf(preBoundary).ipo_pool_percentage).toBe(0);
    expect(preBoundary.pending_mh_exchange).not.toBeNull(); // still standing after Bob's purchase
    expect(settled.pending_mh_exchange).toBeNull();
    expect(mhOf(settled).closed).toBe(false);
    expect(held(settled, P1)).toBe(0);
    expect(nycOf(settled).bank_pool_percentage).toBe(30); // never rerouted (R2)

    expect(mhSettlementOutcome(midTurn, settled)?.kind).toBe("expired");
    const line = mhSettlementSentence(midTurn, settled, nameFor)!;
    expect(line).toBe(`Alice's ${MH_EXCHANGE_EXPIRED_SENTENCE}`);
    expect(MH_EXCHANGE_EXPIRED_SENTENCE).toBe("M&H exchange request expired before it could execute.");
    expect(line).not.toContain("EXECUTED");
  });

  it("the M&H closed by something else (Phase 5) with no share received is expired, not executed", () => {
    const { queued } = queuedThenBoundary("Ipo");
    const closedElsewhere = {
      ...queued,
      pending_mh_exchange: null,
      private_companies: queued.private_companies.map((p) => ({ ...p, closed: true, owner: null })),
    } as GameStateResponse;
    expect(mhSettlementOutcome(queued, closedElsewhere)?.kind).toBe("expired");
  });
});

describe("5. the owner's own-turn exchange executes at once and never passes through pending", () => {
  it("EXECUTED on the dispatch itself; no pending, no settlement line, no acknowledgement", () => {
    const seed = board(0, 30, 20); // Alice seated
    const { room, submit } = roomFor(seed);
    submit(P1, EXCHANGE("Bank"));
    const after = room.state;
    expect(after.pending_mh_exchange ?? null).toBeNull();
    expect(mhOf(after).closed).toBe(true);

    expect(narrate(EXCHANGE("Bank"), seed, after)).toBe(
      "M&H exchange EXECUTED — Alice exchanged the Mohawk & Hudson for a 10% share of NYC from the Bank Pool. The private company closes.",
    );
    expect(mhSettlementSentence(seed, after, nameFor)).toBeNull();
    expect(mhQueuedAcknowledgement(seed, after, P1)).toBeNull();
    expect(pendingMhExchangeView(after, nameFor)).toBeNull();
  });

  it("a second request while one stands is refused by the authority; its line claims neither REQUESTED nor EXECUTED", () => {
    const { queued } = queuedThenBoundary("Ipo");
    const { room, submit } = roomFor(queued);
    submit(P1, EXCHANGE("Bank"));
    const after = room.state;
    expect(after.pending_mh_exchange).toEqual(queued.pending_mh_exchange); // the first request, unchanged
    const line = narrate(EXCHANGE("Bank"), queued, after)!;
    expect(line).toBe("Alice requested an exchange of the Mohawk & Hudson for a 10% share of NYC from the Bank Pool.");
  });
});

describe("6. the shell wiring (source pins) -- W1-C preserved", () => {
  const APP = readShell();

  it("the settlement line and the acknowledgement are read beside the float, from `before` and `after`", () => {
    const code = sliceBetween(APP, "const mhSettled = mhSettlementSentence(", "describeFloat(previously, company)");
    expect(code).toContain("mhSettlementSentence(");
    expect(code).toContain('logInfo("Private Power", mhSettled)');
    expect(code).toContain("mhQueuedAcknowledgement(before, after, viewerAddressRef.current)");
    expect(code).toContain("showActionToast(mhQueued)");
  });

  it("the chip and both player-card mounts read the one pending view", () => {
    const chip = sliceBetween(APP, "const stockRoundPowerOffers", "const privatePowerOffersRef");
    expect(chip).toContain("return withPendingMhExchangeChip(");
    expect(chip).toContain("pendingMhExchangeView(gameState,");
    expect(APP.split("privatePendingNote={pendingMhExchangeNote}").length - 1).toBe(2);
    expect(APP).toContain("pendingMhExchangeView(gameState,");
  });

  it("the dispatch still asks the authority per pile and sends the chosen pile (W1-C)", () => {
    const body = sliceBetween(APP, "const runPrivateExchange = useCallback(", "const handlePowerFlowAct");
    expect(body).toContain("mhExchangeRequestFor(");
    expect(body).toContain("source: request.source,");
    expect(body).not.toContain('"Ipo"');
    expect(body).not.toContain('"Bank"');
  });
});
