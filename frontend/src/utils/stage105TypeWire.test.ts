/** @jest-environment node */
//
// ==================================================================
//  STAGE 10.5 (S10-9): THE LOGGED-MESSAGE TYPE BOUNDARY AND THE PRIVATE-OFFER PRICE WIRE
// ==================================================================
//
// A. TYPES. `SandboxLogMsg` (gameSetup.ts) is the ONE log-wide union -- `GameplayExecuteMsg` plus the room-only
//    `SandboxOnlyMsg` events -- and every boundary that carries any logged message is typed with it. The chain /
//    session-key set stays `GameplayExecuteMsg` / `GAMEPLAY_MESSAGE_KEYS`, unwidened. MOST OF PART A IS PROVED BY
//    THE COMPILER: the `Equals` constants and the `@ts-expect-error` lines below fail `tsc --noEmit` if a boundary
//    drifts or the chain set is widened (an unused `@ts-expect-error` is itself an error). The runtime cases pin
//    the same facts where a runtime list exists (the schema, `GAMEPLAY_MESSAGE_KEYS`, `isSandboxOnlyMsg`).
//
// B. PRICE. A new `ProposePrivatePurchase` writes the canonical whole-VGP STRING; a stored numeric one is still
//    read, keeps its number in state (replay-preserving) and settles; spellings are compared by VALUE through
//    `vgpAmount.ts`, and malformed / fractional spellings are refused rather than coerced. The train offer
//    (already a string) and the player <-> player trade (a number by rule) are unchanged.

import type { GameplayExecuteMsg, ExecViaSessionKeyOptions, GameplayMessageKey } from "./sessionKey";
import type { SandboxLogMsg, SandboxOnlyMsg, SetupGameMsg, RevertToMsg, ProposePrivatePurchaseMsg } from "../gameEngine/gameSetup";
import type { SubmitInput } from "./roomSession";
import type { SubmitRequest } from "./serverProtocol";
import type { ServerLink } from "./serverLink";
import type { ReplayObserver, ReplayProviders } from "../gameEngine/replayLog";
import type { FundingPrivatePurchaseOffer, OrdinaryPrivatePurchaseOffer, TrainPurchaseOffer, PrivateTradeOffer } from "../gameEngine/gameState";
import type { useGameSession } from "../context/GameSessionContext";

const { GAMEPLAY_MESSAGE_KEYS, execViaSessionKey } = require("./sessionKey") as typeof import("./sessionKey");
const { isSandboxOnlyMsg, chainGameplayMsg } = require("../gameEngine/gameSetup") as typeof import("../gameEngine/gameSetup");
const { GAMEPLAY_MESSAGE_KINDS, GAMEPLAY_MESSAGE_SCHEMA, validateGameplayMessage } =
  require("../gameEngine/messageSchema") as typeof import("../gameEngine/messageSchema");
const { applySandboxAction, applySandboxWaterfallAction, applySandboxMarketAction, sandboxChartStepReport } =
  require("../gameEngine/sandboxSession") as typeof import("../gameEngine/sandboxSession");
const { turnRefusal } = require("../gameEngine/turnAuthority") as typeof import("../gameEngine/turnAuthority");
const { sandboxActionContext } = require("../gameEngine/actionContext") as typeof import("../gameEngine/actionContext");
const { mintLogEntry } = require("./serverProtocol") as typeof import("./serverProtocol");
const { RoomEngine, replayLog } = require("../gameEngine/replayLog") as typeof import("../gameEngine/replayLog");
const { RoomSession } = require("./roomSession") as typeof import("./roomSession");
const { refusalReasonFor, actionWasRefused } = require("./refusedAction") as typeof import("./refusedAction");
const { sandboxReplayProviders } = require("../gameEngine/replayProviders") as typeof import("../gameEngine/replayProviders");
const { DEFAULT_SANDBOX_SCENARIO, sandboxScenario, sandboxScenarioState, sandboxWaterfallState } =
  require("../gameEngine/sandboxState") as typeof import("../gameEngine/sandboxState");
const { waterfallForRoster, withEmptyRoster } = require("../gameEngine/gameSetup") as typeof import("../gameEngine/gameSetup");
const { canonicalWholeVgp, sameWholeVgp, wholeVgpNumber, wholeVgpString, isWholeVgp } =
  require("../gameEngine/vgpAmount") as typeof import("../gameEngine/vgpAmount");
const { privateSettlementMatches, trainSettlementMatches } =
  require("../gameEngine/pendingOfferHold") as typeof import("../gameEngine/pendingOfferHold");
const { privatePurchaseRefusal } = require("../gameEngine/privatePurchaseAuthority") as typeof import("../gameEngine/privatePurchaseAuthority");
const { nextDerivedAction, derivedEntryKey } = require("../gameEngine/derivedActions") as typeof import("../gameEngine/derivedActions");
const { moneyTotal } = require("../gameEngine/cashLedger") as typeof import("../gameEngine/cashLedger");
const { logHash } = require("../gameEngine/logHash") as typeof import("../gameEngine/logHash");
const { DEVELOPMENT_CORPUS_POLICY } = require("../gameEngine/rulesVersion") as typeof import("../gameEngine/rulesVersion");
const F = require("./offerFixtures74") as typeof import("./offerFixtures74");
const S = require("./offerMatrix74Support") as typeof import("./offerMatrix74Support");

type GameStateResponse = import("../gameEngine/gameState").GameStateResponse;

const { P1, P2, PRR, NYC, DH, operatingBoard, stockRoundBoard } = F;
const { apply, ingress, same, priv, cash, treasury, M, GRID } = S;

/* ================================================================== */
/* Type-level machinery (erased at runtime; judged by tsc --noEmit)    */
/* ================================================================== */

type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type KeysOf<U> = U extends unknown ? keyof U : never;

/* ---- A5.5: every boundary that handles the log-wide family says so -------------------------------------- */
const reducerTakesLog: Equals<Parameters<typeof applySandboxAction>[1], SandboxLogMsg> = true;
const waterfallStepTakesLog: Equals<Parameters<typeof applySandboxWaterfallAction>[1], SandboxLogMsg> = true;
const chartStepTakesLog: Equals<Parameters<typeof applySandboxMarketAction>[1], SandboxLogMsg> = true;
const chartReportTakesLog: Equals<Parameters<typeof sandboxChartStepReport>[1], SandboxLogMsg> = true;
const observerSeesLog: Equals<Parameters<ReplayObserver>[0]["msg"], SandboxLogMsg> = true;
const marketProviderSeesLog: Equals<Parameters<ReplayProviders["marketContext"]>[1], SandboxLogMsg> = true;
const turnAuthorityTakesLog: Equals<Parameters<typeof turnRefusal>[0]["msg"], SandboxLogMsg> = true;
const actionContextTakesLog: Equals<Parameters<typeof sandboxActionContext>[1]["msg"], SandboxLogMsg> = true;
const roomSubmitTakesLog: Equals<SubmitInput["msg"], SandboxLogMsg> = true;
const wireSubmitCarriesLog: Equals<SubmitRequest["msg"], SandboxLogMsg> = true;
const mintTakesLog: Equals<Parameters<typeof mintLogEntry>[0]["msg"], SandboxLogMsg> = true;
const linkSubmitTakesLog: Equals<Parameters<ServerLink["submit"]>[0], SandboxLogMsg> = true;
const receiptTakesLog: Equals<Parameters<typeof refusalReasonFor>[1], SandboxLogMsg> = true;
const receiptRefusedTakesLog: Equals<Parameters<typeof actionWasRefused>[2], SandboxLogMsg> = true;
// The derived-entry mint is gameplay-only by construction (a derived entry is always a contract message).
const derivedMintIsGameplay: Equals<Parameters<Parameters<InstanceType<typeof RoomEngine>["settleOwed"]>[0]>[0], GameplayExecuteMsg> = true;

/* ---- A2 / A5.4: the chain boundary is NOT widened ------------------------------------------------------ */
const sessionKeyTakesGameplayOnly: Equals<ExecViaSessionKeyOptions["msg"], GameplayExecuteMsg> = true;
const execGameplayTakesGameplayOnly: Equals<Parameters<ReturnType<typeof useGameSession>["execGameplay"]>[0], GameplayExecuteMsg> = true;
const allowListIsTheGameplayKeys: Equals<KeysOf<GameplayExecuteMsg>, GameplayMessageKey> = true;
const noRoomEventOnTheChain: Equals<Extract<GameplayMessageKey, KeysOf<SandboxOnlyMsg>>, never> = true;
const theLogIsExactlyBoth: Equals<SandboxLogMsg, GameplayExecuteMsg | SandboxOnlyMsg> = true;
const narrowingYieldsGameplay: Equals<ReturnType<typeof chainGameplayMsg>, GameplayExecuteMsg | null> = true;

/* ---- B: the price types --------------------------------------------------------------------------------- */
const proposalPriceBothSpellings: Equals<ProposePrivatePurchaseMsg["ProposePrivatePurchase"]["price"], string | number> = true;
const ordinaryOfferBothSpellings: Equals<OrdinaryPrivatePurchaseOffer["price"], string | number> = true;
const fundingOfferStaysNumber: Equals<FundingPrivatePurchaseOffer["price"], number> = true;
const trainOfferStaysString: Equals<TrainPurchaseOffer["price"], string> = true;
const tradeOfferStaysNumber: Equals<PrivateTradeOffer["price"], number> = true;

const TYPE_PROOFS = [
  reducerTakesLog, waterfallStepTakesLog, chartStepTakesLog, chartReportTakesLog, observerSeesLog, marketProviderSeesLog,
  turnAuthorityTakesLog, actionContextTakesLog, roomSubmitTakesLog, wireSubmitCarriesLog, mintTakesLog, linkSubmitTakesLog,
  receiptTakesLog, receiptRefusedTakesLog, derivedMintIsGameplay, sessionKeyTakesGameplayOnly, execGameplayTakesGameplayOnly,
  allowListIsTheGameplayKeys, noRoomEventOnTheChain, theLogIsExactlyBoth, narrowingYieldsGameplay,
  proposalPriceBothSpellings, ordinaryOfferBothSpellings, fundingOfferStaysNumber, trainOfferStaysString, tradeOfferStaysNumber,
];

/* ---- the one list of room-only keys, exhaustive by construction (a missing or extra key fails tsc) ------ */
const SANDBOX_ONLY_KEYS: Record<KeysOf<SandboxOnlyMsg>, true> = {
  SetupGame: true,
  OpenStockRound: true,
  CloseRoom: true,
  SetBoPar: true,
  PlaceHomeStation: true,
  ExchangePrivate: true,
  ProposePrivatePurchase: true,
  AnswerPrivatePurchase: true,
  ProposeTrainPurchase: true,
  AnswerTrainPurchase: true,
  RescindPrivatePurchase: true,
  RescindTrainPurchase: true,
  ProposePrivateTrade: true,
  AnswerPrivateTrade: true,
  RescindPrivateTrade: true,
  BuyKanawhaLicense: true,
  RevertTo: true,
};

const BUILD = "b-105";
const ALICE = "p-alice";
const BOB = "p-bob";
const SETUP: SetupGameMsg = {
  SetupGame: { players: [{ id: ALICE, nickname: "Alice" }, { id: BOB, nickname: "Bob" }], variants: {} },
};

function dealtRoom() {
  let n = 0;
  const room = new RoomSession({
    providers: sandboxReplayProviders(),
    seed: {
      state: withEmptyRoster(sandboxScenarioState(DEFAULT_SANDBOX_SCENARIO, 0, "default")),
      waterfall: waterfallForRoster(sandboxWaterfallState(sandboxScenario(DEFAULT_SANDBOX_SCENARIO).phase, 0, true), []),
    },
    build: BUILD,
    mintId: () => `id${(n += 1)}`,
  });
  return room;
}

/* ================================================================== */
/* A. The logged-message boundary                                      */
/* ================================================================== */

describe("A. the log-wide type is one union and the chain's set stays narrow", () => {
  it("every compile-time proof above held (tsc is the judge; this only keeps the constants live)", () => {
    expect(TYPE_PROOFS.every((proof) => proof === true)).toBe(true);
  });

  it("A2: GAMEPLAY_MESSAGE_KEYS holds no room-only key, and isSandboxOnlyMsg is exactly the room-only list", () => {
    const roomOnly = Object.keys(SANDBOX_ONLY_KEYS);
    expect(roomOnly).toHaveLength(17);
    for (const key of roomOnly) {
      expect([key, (GAMEPLAY_MESSAGE_KEYS as readonly string[]).includes(key)]).toEqual([key, false]);
      expect([key, isSandboxOnlyMsg({ [key]: {} })]).toEqual([key, true]);
    }
    for (const key of GAMEPLAY_MESSAGE_KEYS) expect([key, isSandboxOnlyMsg({ [key]: {} })]).toEqual([key, false]);
  });

  it("A3: the ingress schema admits exactly the log-wide family -- the gameplay keys plus the room-only keys, nothing else", () => {
    const expected = [...GAMEPLAY_MESSAGE_KEYS, ...Object.keys(SANDBOX_ONLY_KEYS)].sort();
    expect([...GAMEPLAY_MESSAGE_KINDS]).toEqual(expected);
  });

  it("A5.1: a contract gameplay message passes the logged path (reducer, ingress, room)", () => {
    const room = dealtRoom();
    expect(room.submit({ actor: ALICE, build: BUILD, msg: SETUP, baseIndex: -1 }).kind).toBe("applied");
    const buyer = room.state.waterfall?.current_turn as string;
    const buy: GameplayExecuteMsg = { WaterfallBuyLowest: { game_id: 0 } };
    expect(room.submit({ actor: buyer, build: BUILD, msg: buy, baseIndex: room.nextIndex - 1 }).kind).toBe("applied");
    expect(chainGameplayMsg(buy)).toBe(buy);
  });

  it("A5.2: SetupGame passes the room, the log and the replay as itself -- no cast, and never a chain message", () => {
    const room = dealtRoom();
    const frame = room.submit({ actor: ALICE, build: BUILD, msg: SETUP, baseIndex: -1 });
    expect(frame.kind).toBe("applied");
    expect(room.state.player_addresses).toEqual([ALICE, BOB]);
    expect(chainGameplayMsg(SETUP)).toBeNull();
    const replayed = replayLog(room.entries.map((entry) => ({ ...entry })), sandboxReplayProviders(), {
      state: withEmptyRoster(sandboxScenarioState(DEFAULT_SANDBOX_SCENARIO, 0, "default")),
      waterfall: waterfallForRoster(sandboxWaterfallState(sandboxScenario(DEFAULT_SANDBOX_SCENARIO).phase, 0, true), []),
    });
    expect(replayed.applied).toBe(1);
    expect(replayed.state.player_addresses).toEqual([ALICE, BOB]);
    // The deal is minted into the log by the one serialiser, typed as the log-wide union.
    const minted = mintLogEntry({ index: 0, id: "x", actor: ALICE, msg: SETUP });
    expect(JSON.parse(minted.payload)).toEqual(SETUP);
  });

  it("A5.3: an offer and a RevertTo pass the logged path as themselves", () => {
    const seed = operatingBoard();
    const proposal: ProposePrivatePurchaseMsg = {
      ProposePrivatePurchase: { private_id: DH, private_name: "Delaware & Hudson", owner: P2, buyer_protocol_id: PRR, buyer_ticker: "PRR", price: "100" },
    };
    const { room, submit, kinds } = S.roomFor(seed);
    expect(kinds(submit(P1, proposal))).toEqual(["ProposePrivatePurchase"]);
    const revert: RevertToMsg = { RevertTo: { index: 0, player: P1, summary: "undo" } };
    expect(chainGameplayMsg(revert)).toBeNull();
    expect(turnRefusal({ state: room.state, waterfall: null, actor: P1, msg: revert, host: P1, log: room.entries, mapGrid: GRID })).toBeNull();
    expect(submit(P1, revert).kind).toBe("applied");
    expect(room.state.private_purchase_offer ?? null).toBeNull();
  });

  it("A5.4: a room-only message cannot reach the session-key executor without narrowing", async () => {
    // @ts-expect-error -- SetupGame is not a contract message; the session key's type refuses it.
    const unnarrowed: ExecViaSessionKeyOptions["msg"] = SETUP;
    const logged: SandboxLogMsg = { RevertTo: { index: 0, player: P1, summary: "undo" } };
    // @ts-expect-error -- a log-wide value is not a chain value until `chainGameplayMsg` / `isSandboxOnlyMsg` says so.
    const direct: GameplayExecuteMsg = logged;
    expect(chainGameplayMsg(logged)).toBeNull();
    // And the runtime lock behind the type: the executor refuses a non-allow-listed key before touching a client.
    await expect(
      execViaSessionKey({
        sessionClient: {} as never,
        sessionAddress: "juno1session",
        masterAddress: "juno1master",
        msg: unnarrowed,
        feeGranter: "juno1granter",
      }),
    ).rejects.toThrow('"SetupGame" is not in GAMEPLAY_MESSAGE_KEYS');
    expect(direct).toBe(logged);
  });
});

/* ================================================================== */
/* B. The private-offer price                                          */
/* ================================================================== */

const DH_BAND = "The price must be a whole number between $35 and $140 (half to twice Delaware & Hudson's $70 face value).";
const proposeAt = (price: unknown) => ({
  ProposePrivatePurchase: { game_id: 1, private_id: DH, private_name: "narration", owner: "narration", buyer_protocol_id: PRR, buyer_ticker: "narration", price },
});

describe("B. vgpAmount: one reading of a whole-VGP amount", () => {
  it("canonical strings and legacy safe-integer numbers parse; the two spellings of one value are the same value", () => {
    expect(canonicalWholeVgp("100")).toBe("100");
    expect(canonicalWholeVgp(100)).toBe("100");
    expect(canonicalWholeVgp("0")).toBe("0");
    expect(canonicalWholeVgp(0)).toBe("0");
    expect(sameWholeVgp(100, "100")).toBe(true);
    expect(sameWholeVgp("100", 100)).toBe(true);
    expect(sameWholeVgp(100, "101")).toBe(false);
    expect(wholeVgpNumber("140")).toBe(140);
    expect(wholeVgpString(100)).toBe("100");
  });

  it("malformed spellings are malformed -- never coerced (\"1e2\" is not $100)", () => {
    for (const bad of ["1e2", " 100", "100 ", "0x64", "100.0", "0100", "", "+100", "-5", "1_000", "١٠٠", "Infinity", "NaN"]) {
      expect([bad, canonicalWholeVgp(bad)]).toEqual([bad, null]);
      expect([bad, sameWholeVgp(bad, 100)]).toEqual([bad, false]);
    }
    for (const bad of [70.5, -5, -0, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, null, undefined, true, {}, [100]]) {
      expect([String(bad), canonicalWholeVgp(bad)]).toEqual([String(bad), null]);
    }
    // Two malformed amounts are never "the same".
    expect(sameWholeVgp("1e2", "1e2")).toBe(false);
    expect(() => wholeVgpString(70.5)).toThrow(RangeError);
  });

  it("no precision is lost: a string beyond the safe range is still one canonical value, but never a JS number", () => {
    const huge = "340282366920938463463374607431768211455"; // u128::MAX
    expect(canonicalWholeVgp(huge)).toBe(huge);
    expect(sameWholeVgp(huge, "340282366920938463463374607431768211454")).toBe(false);
    expect(wholeVgpNumber(huge)).toBeNull();
  });
});

describe("B. the corporation-private offer: canonical new writes, legacy numbers still read", () => {
  it("B6.1 + B6.10: a NEW (string) proposal is stored as the canonical string; the answer derives the exact settlement; one payment", () => {
    const seed = operatingBoard();
    const { room, submit, kinds, logged } = S.roomFor(seed);
    expect(kinds(submit(P1, proposeAt("100")))).toEqual(["ProposePrivatePurchase"]);
    expect(room.state.private_purchase_offer).toMatchObject({ private_id: DH, owner: P2, buyer_protocol_id: PRR, price: "100", instance: 1 });
    expect(JSON.parse(logged("ProposePrivatePurchase")[0].payload).ProposePrivatePurchase.price).toBe("100");
    const offered = room.state;
    // The accepted board owes exactly the settlement, keyed on the offer instance.
    const accepted = apply(offered, M.answerPrivate(DH, true), P2);
    const owed = nextDerivedAction({ state: accepted, mapGrid: GRID, emitted: new Set() })!;
    expect(owed.msg).toEqual({ BuyPrivateCompany: { game_id: 0, protocol_id: PRR, private_id: DH, price: "100" } });
    expect(derivedEntryKey(accepted, owed.msg)).toBe("offer:private:1");
    // Through the room: the answer burst carries exactly one derived settlement.
    expect(kinds(submit(P2, M.answerPrivate(DH, true)))).toEqual(["AnswerPrivatePurchase", "BuyPrivateCompany*"]);
    expect(room.state.private_purchase_offer).toBeNull();
    expect(priv(room.state, DH)).toMatchObject({ owner: null, owner_protocol_id: PRR });
    expect(treasury(room.state, PRR)).toBe(400);
    expect(cash(room.state, P2)).toBe(400);
    expect(moneyTotal(room.state)).toBe(moneyTotal(seed));
    expect(logged("BuyPrivateCompany")).toHaveLength(1);
  });

  it("B6.2: a LEGACY (numeric) proposal is still accepted, keeps its number in state, and settles legally", () => {
    const seed = operatingBoard();
    const { room, submit, kinds, logged } = S.roomFor(seed);
    expect(kinds(submit(P1, proposeAt(100)))).toEqual(["ProposePrivatePurchase"]);
    expect(room.state.private_purchase_offer?.price).toBe(100); // the stored spelling, verbatim
    expect(kinds(submit(P2, M.answerPrivate(DH, true)))).toEqual(["AnswerPrivatePurchase", "BuyPrivateCompany*"]);
    // The derived settlement is the byte-identical canonical string `String(100)` always wrote.
    expect(JSON.parse(logged("BuyPrivateCompany")[0].payload).BuyPrivateCompany.price).toBe("100");
    expect(priv(room.state, DH)).toMatchObject({ owner: null, owner_protocol_id: PRR });
    expect(treasury(room.state, PRR)).toBe(400);
    expect(moneyTotal(room.state)).toBe(moneyTotal(seed));
  });

  it("B6.2 (replay): a stored numeric log replays through RoomEngine with the number in state and its payload bytes untouched", () => {
    const seed = operatingBoard();
    const entries = [
      S.entry(0, P1, proposeAt(100)),
      S.entry(1, P2, M.answerPrivate(DH, true)),
      S.entry(2, P2, { BuyPrivateCompany: { game_id: 0, protocol_id: PRR, private_id: DH, price: "100" } }, true),
    ].map((entry) => Object.freeze(entry));
    const payloads = entries.map((entry) => entry.payload);
    const hashBefore = logHash(entries);
    const offers: unknown[] = [];
    const result = replayLog(entries, { ...sandboxReplayProviders(), initialGrid: GRID }, { state: seed, waterfall: null }, ({ stateBefore }) => {
      offers.push(stateBefore.private_purchase_offer?.price ?? null);
    }, DEVELOPMENT_CORPUS_POLICY);
    expect(result.applied).toBe(3);
    expect(offers).toEqual([null, 100, 100]); // the offer's legacy number, as the proposal wrote it
    expect(priv(result.state, DH)).toMatchObject({ owner_protocol_id: PRR });
    expect(entries.map((entry) => entry.payload)).toEqual(payloads);
    expect(logHash(entries)).toBe(hashBefore);
  });

  it("B6.3: equal values in the two spellings match; B6.4: a different value does not, and is refused", () => {
    const legacy = { private_id: DH, private_name: "D&H", owner: P2, buyer_protocol_id: PRR, buyer_ticker: "PRR", price: 100, accepted: true as const };
    const modern = { ...legacy, price: "100" };
    for (const offer of [legacy, modern]) {
      expect(privateSettlementMatches(offer, { protocol_id: PRR, private_id: DH, price: "100" })).toBe(true);
      expect(privateSettlementMatches(offer, { protocol_id: PRR, private_id: DH, price: 100 })).toBe(true);
      expect(privateSettlementMatches(offer, { protocol_id: PRR, private_id: DH, price: "101" })).toBe(false);
      expect(privateSettlementMatches(offer, { protocol_id: PRR, private_id: DH, price: "1e2" })).toBe(false);
      expect(privateSettlementMatches(offer, { protocol_id: PRR, private_id: DH, price: "100.0" })).toBe(false);
    }
    // A mismatched settlement against an accepted numeric offer: held at ingress, nothing moves at the reducer.
    const { accepted } = S.privateOfferStages(operatingBoard(), DH, 100, P2);
    const wrong = M.buyPrivate(PRR, DH, "101");
    expect(ingress(accepted, P1, wrong)).not.toBeNull();
    expect(same(apply(accepted, wrong, P1), accepted)).toBe(true);
    const right = M.buyPrivate(PRR, DH, "100");
    expect(ingress(accepted, P1, right)).toBeNull();
    expect(same(apply(accepted, right, P1), accepted)).toBe(false);
  });

  it("B6.5 / B6.6: malformed or fractional prices are the authority's refusal at ingress and in the reducer -- never coerced", () => {
    const seed = operatingBoard();
    for (const bad of ["1e2", " 100", "0x64", "100.0", "0100", "", "70.5", 70.5, -35]) {
      const msg = proposeAt(bad);
      // Shape-valid (a string or a number, #1449 / §16: the value is the authority's), then refused with its sentence.
      expect([String(bad), validateGameplayMessage(msg).ok]).toEqual([String(bad), true]);
      expect([String(bad), ingress(seed, P1, msg)]).toEqual([String(bad), DH_BAND]);
      expect([String(bad), same(apply(seed, msg, P1), seed)]).toEqual([String(bad), true]);
    }
    // Neither a string nor a number is not a price at all.
    for (const shapeless of [null, true, {}, [100]]) expect(validateGameplayMessage(proposeAt(shapeless)).ok).toBe(false);
    // The settlement message: "1e2" was read as $100 by `Number`; it is now a malformed price.
    expect(privatePurchaseRefusal(seed, { buyerId: PRR, privateId: DH, price: "1e2" }, null, "settlement")).toBe(DH_BAND);
    expect(privatePurchaseRefusal(seed, { buyerId: PRR, privateId: DH, price: "100" }, null, "settlement")).toBeNull();
    // Both well-formed spellings are admitted by the schema.
    expect(validateGameplayMessage(proposeAt("100")).ok).toBe(true);
    expect(validateGameplayMessage(proposeAt(100)).ok).toBe(true);
    expect(GAMEPLAY_MESSAGE_SCHEMA.ProposePrivatePurchase.price).toBe("finite|string");
    expect(isWholeVgp("100") && isWholeVgp(100)).toBe(true);
  });

  it("B6.7: $0 is a well-formed amount and is refused by this family's own rule (the band's floor), not by the parser", () => {
    const seed = operatingBoard();
    for (const zero of ["0", 0]) {
      expect(validateGameplayMessage(proposeAt(zero)).ok).toBe(true);
      expect(ingress(seed, P1, proposeAt(zero))).toBe(DH_BAND);
      expect(same(apply(seed, proposeAt(zero), P1), seed)).toBe(true);
    }
  });
});

describe("B. the neighbours are not migrated", () => {
  it("B6.8: the train offer stays the canonical string end to end, and its settlement is unchanged", () => {
    const { offered, accepted } = S.trainOfferStages(operatingBoard(), NYC, "3", "150", P2);
    expect(offered.train_purchase_offer?.price).toBe("150");
    const owed = nextDerivedAction({ state: accepted, mapGrid: GRID, emitted: new Set() })!;
    expect(owed.msg).toMatchObject({ BuyTrainFromCorporation: { buyer_protocol_id: PRR, seller_protocol_id: NYC, model_type: "3", price: "150" } });
    expect(trainSettlementMatches(accepted.train_purchase_offer!, { buyer_protocol_id: PRR, seller_protocol_id: NYC, model_type: "3", price: "150" })).toBe(true);
    expect(GAMEPLAY_MESSAGE_SCHEMA.ProposeTrainPurchase.price).toBe("string");
    expect(GAMEPLAY_MESSAGE_SCHEMA.BuyTrainFromCorporation.price).toBe("string");
  });

  it("B6.9: the player <-> player trade keeps its whole-number price (and $0 stays legal there)", () => {
    const board = stockRoundBoard();
    const offered = apply(board, M.proposeTrade(DH, P2, P1, 0), P1);
    expect(offered.private_trade_offer).toMatchObject({ private_id: DH, seller: P2, buyer: P1, price: 0 });
    expect(GAMEPLAY_MESSAGE_SCHEMA.ProposePrivateTrade.price).toBe("int");
    expect(validateGameplayMessage({ ProposePrivateTrade: { private_id: DH, seller: P2, buyer: P1, price: "50" } }).ok).toBe(false);
  });

  it("B6.11: the funding offer keeps its integer price (a separate gameplay message, settled by its own arm)", () => {
    expect(GAMEPLAY_MESSAGE_SCHEMA.OfferPrivateForFunding.price).toBe("int");
    expect(validateGameplayMessage({ OfferPrivateForFunding: { private_id: DH, buyer_protocol_id: NYC, price: "100" } }).ok).toBe(false);
  });
});

export {};
