/** @jest-environment node */
//
// ==================================================================
//  BATCH 7.5: VERSION 5, AND THE CLOSURE CHECKS THE BUMP OWES
// ==================================================================
//
// Batch 7 (7.1-7.4) changed what stored logs replay to and deferred the one bump to here. This file pins the
// bump the way every earlier bump pinned its own (Batch 4.6's trainDiscard 14, Batch 5's emergencyFunding 22,
// Batch 6's routeAuthority 23) and adds the replay-identity checks 7.4 made necessary: a historical
// corporation offer replays to the same numbered instance every time, `RevertTo` rebuilds it, and the version
// number takes no part in settlement identity.
//
// THE CORPUS CASES READ THE LOCAL DEVELOPMENT CORPUS (`server/data`, `frontend/sandbox-log-*`), which is not
// committed; like `moneyConservation.test.ts` they say nothing when the file is absent. The version cases need
// nothing but the engine.

import { existsSync, readFileSync } from "fs";
import { join } from "path";

import type { GameStateResponse } from "../gameEngine/gameState";
import type { ServerLogEntry } from "./roomSession";
import type { ExportedEntry, ReplayEntry } from "../gameEngine/replayLog";

const { replayLog, entriesFromExport, RoomEngine } = require("../gameEngine/replayLog") as typeof import("../gameEngine/replayLog");
const { sandboxReplayProviders } = require("../gameEngine/replayProviders") as typeof import("../gameEngine/replayProviders");
const { RoomSession } = require("./roomSession") as typeof import("./roomSession");
const { DEFAULT_SANDBOX_SCENARIO, sandboxScenario, sandboxScenarioState, sandboxWaterfallState } =
  require("../gameEngine/sandboxState") as typeof import("../gameEngine/sandboxState");
const { waterfallForRoster, withEmptyRoster } = require("../gameEngine/gameSetup") as typeof import("../gameEngine/gameSetup");
const { stateDigest } = require("../gameEngine/stateDigest") as typeof import("../gameEngine/stateDigest");
const { derivedEntryKey, trainOfferKey, privateOfferKey } = require("../gameEngine/derivedActions") as typeof import("../gameEngine/derivedActions");
const {
  DEVELOPMENT_CORPUS_POLICY,
  RULES_ENGINE_CHANGELOG,
  RULES_ENGINE_VERSION,
  RULES_ENGINE_VERSION_FIELD,
  SUPPORTED_RULES_ENGINE_VERSIONS,
  ReplayIncompatibleError,
} = require("../gameEngine/rulesVersion") as typeof import("../gameEngine/rulesVersion");

const P1 = "p1";
const P2 = "p2";

const seed = () => ({
  state: withEmptyRoster(sandboxScenarioState(DEFAULT_SANDBOX_SCENARIO, 0, "default")),
  waterfall: waterfallForRoster(sandboxWaterfallState(sandboxScenario(DEFAULT_SANDBOX_SCENARIO).phase, 0, true), []),
});

const dealtRoom = () => {
  const room = new RoomSession({ providers: sandboxReplayProviders(), seed: seed(), build: "b", mintId: () => "d" });
  const dealt = room.submit({
    actor: P1,
    build: "b",
    msg: { SetupGame: { players: [{ id: P1, nickname: "A" }, { id: P2, nickname: "B" }], variants: {}, build: "b" } } as never,
    baseIndex: -1,
  });
  expect(dealt.kind).toBe("applied");
  return room;
};

const repinned = (entries: readonly ServerLogEntry[], version: number): ServerLogEntry[] =>
  entries.map((row) => {
    const parsed = JSON.parse(row.payload) as { SetupGame?: Record<string, unknown> };
    return parsed.SetupGame
      ? { ...row, payload: JSON.stringify({ ...parsed, SetupGame: { ...parsed.SetupGame, [RULES_ENGINE_VERSION_FIELD]: version } }) }
      : { ...row };
  });

describe("RULES_ENGINE_VERSION 5 (Batch 7.5)", () => {
  it("is 5, the changelog's fifth row says why, and a new deal is stamped 5 on the log and on the board", () => {
    expect(RULES_ENGINE_VERSION).toBe(5);
    expect(SUPPORTED_RULES_ENGINE_VERSIONS).toEqual([5]);
    expect(RULES_ENGINE_CHANGELOG.map((row) => row.version)).toEqual([1, 2, 3, 4, 5]);
    expect(RULES_ENGINE_CHANGELOG[4].note).toMatch(/Batch 7/);
    expect(RULES_ENGINE_CHANGELOG[4].note).toMatch(/ledger/);
    expect(RULES_ENGINE_CHANGELOG[4].note).toMatch(/Stock Round/);
    expect(RULES_ENGINE_CHANGELOG[4].note).toMatch(/Schuylkill Valley/);
    expect(RULES_ENGINE_CHANGELOG[4].note).toMatch(/instance/);
    const room = dealtRoom();
    expect(room.rulesEngineVersion()).toBe(5);
    expect(room.state.rules_engine_version).toBe(5);
  });

  it("refuses a version-4 room before the reducer sees a single entry, on restore and headless, under EVERY policy", () => {
    const versionFour = repinned(dealtRoom().entries, 4);
    const applySpy = jest.spyOn(RoomEngine.prototype, "apply");
    try {
      const held = new RoomSession({ providers: sandboxReplayProviders(), seed: seed(), build: "b", mintId: () => "x" });
      held.restore(versionFour);
      expect(held.incompatible?.compatibility).toEqual({ kind: "incompatible", version: 4, supported: [5] });
      /* The development-corpus opt-in admits the UNPINNED, never the differently pinned (#1520): a version-4
         deal is not a legacy log, so the bridge does not reach it. */
      const underCorpusPolicy = new RoomSession({
        providers: sandboxReplayProviders(),
        seed: seed(),
        build: "b",
        mintId: () => "y",
        replayPolicy: DEVELOPMENT_CORPUS_POLICY,
      });
      underCorpusPolicy.restore(versionFour);
      expect(underCorpusPolicy.incompatible?.compatibility).toEqual({ kind: "incompatible", version: 4, supported: [5] });
      expect(() => replayLog(versionFour as ReplayEntry[], sandboxReplayProviders(), seed())).toThrow(ReplayIncompatibleError);
      expect(() => replayLog(versionFour as ReplayEntry[], sandboxReplayProviders(), seed(), undefined, DEVELOPMENT_CORPUS_POLICY)).toThrow(
        ReplayIncompatibleError,
      );
      expect(applySpy).not.toHaveBeenCalled();
    } finally {
      applySpy.mockRestore();
    }
  });

  it("leaves the legacy boundary exactly where #1520 put it: the server refuses an unpinned log, the corpus policy admits it", () => {
    const golden = join(__dirname, "__fixtures__", "replayGolden", "logs", "JUNO-CV4.log.jsonl");
    const entries = entriesFromExport(
      readFileSync(golden, "utf8").split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line) as ExportedEntry),
    );
    expect(() => replayLog(entries, sandboxReplayProviders(), seed())).toThrow(/before rules-engine versioning/);
    const admitted = replayLog(entries, sandboxReplayProviders(), seed(), undefined, DEVELOPMENT_CORPUS_POLICY);
    expect(admitted.applied).toBe(141);
    // An unpinned log stays unpinned: nothing in the replay writes the new number onto its board.
    expect(admitted.state.rules_engine_version).toBeUndefined();
  });

  it("takes no part in settlement identity: the same numbered offer keys identically on a board pinned 4 or 5", () => {
    const board = (pin: number) =>
      ({
        rules_engine_version: pin,
        public_companies: [{ company_id: 1, owned_trains: ["2"] }],
        train_purchase_offer: { seller_protocol_id: 2, seller_ticker: "NYC", seller_president: P2, buyer_protocol_id: 1, buyer_ticker: "PRR", model_type: "3", price: "150", accepted: true, instance: 7 },
        private_purchase_offer: null,
      }) as unknown as GameStateResponse;
    const train = { seller_protocol_id: 2, seller_ticker: "NYC", seller_president: P2, buyer_protocol_id: 1, buyer_ticker: "PRR", model_type: "3", price: "150", accepted: true as const, instance: 7 };
    expect(trainOfferKey(train, board(4))).toBe("offer:train:7");
    expect(trainOfferKey(train, board(5))).toBe(trainOfferKey(train, board(4)));
    const settle = { BuyTrainFromCorporation: { game_id: 0, protocol_id: 1, seller_protocol_id: 2, model_type: "3", price: "150" } } as never;
    expect(derivedEntryKey(board(5), settle)).toBe(derivedEntryKey(board(4), settle));
    const privateOffer = { private_id: 3, private_name: "D&H", owner: P2, buyer_protocol_id: 1, buyer_ticker: "PRR", price: 70, instance: 2 };
    expect(privateOfferKey(privateOffer as never)).toBe("offer:private:2");
  });
});

/* ------------------------------------------------------------------ */
/* Historical corporation offers replay to the same numbered instance */
/* ------------------------------------------------------------------ */

const SERVER_DIR = join(__dirname, "..", "..", "..", "server", "data");
const EXPORT_DIR = join(__dirname, "..", "..");

const jsonl = (file: string): ExportedEntry[] =>
  readFileSync(file, "utf8").split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line) as ExportedEntry);

const historical = [
  { name: "server/JUNO-CW7", file: join(SERVER_DIR, "JUNO-CW7.log.jsonl"), read: jsonl, proposal: 121, answer: 122, seller: 4, buyer: 8 },
  {
    name: "export/JUNO-QVC",
    file: join(EXPORT_DIR, "sandbox-log-JUNO-QVC.json"),
    read: (file: string) => (JSON.parse(readFileSync(file, "utf8")) as { actions: ExportedEntry[] }).actions,
    proposal: 59,
    answer: 60,
    seller: 4,
    buyer: 1,
  },
];

describe("historical corporation offers replay deterministically under version 5 (7.4's #1597, closed in 7.5)", () => {
  for (const log of historical) {
    it(`${log.name}: the stored proposal at ${log.proposal} is instance 1 on every replay, and RevertTo rebuilds it`, () => {
      if (!existsSync(log.file)) return; // local development corpus, not committed
      const entries = entriesFromExport(log.read(log.file));
      const run = (list: readonly ReplayEntry[]) => {
        const seen: Record<number, GameStateResponse> = {};
        const result = replayLog(list, sandboxReplayProviders(), seed(), ({ entry, stateBefore }) => {
          seen[entry.index] = stateBefore;
        }, DEVELOPMENT_CORPUS_POLICY);
        return { result, seen };
      };
      const first = run(entries);
      const second = run(entries);
      expect(stateDigest(second.result.state)).toBe(stateDigest(first.result.state));
      // The answer's board carries the proposal the log wrote, numbered by the arm, and the board ends on 1.
      const atAnswer = first.seen[log.answer];
      expect(atAnswer.offer_serial).toBe(1);
      expect(atAnswer.train_purchase_offer?.instance).toBe(1);
      expect(atAnswer.train_purchase_offer?.seller_protocol_id).toBe(log.seller);
      expect(atAnswer.train_purchase_offer?.buyer_protocol_id).toBe(log.buyer);
      expect(second.seen[log.answer].train_purchase_offer).toEqual(atAnswer.train_purchase_offer);
      expect(first.result.state.offer_serial).toBe(1);

      const actor = entries.find((entry) => entry.index === log.proposal)!.actor;
      const last = entries[entries.length - 1].index;
      const revertTo = (index: number): ReplayEntry[] => [
        ...entries,
        { index: last + 1, id: `revert-${index}`, actor, payload: JSON.stringify({ RevertTo: { index, player: actor, summary: "undo" } }) },
      ];
      // Reverting the proposal away rebuilds a board that never numbered an offer.
      const beforeProposal = run(revertTo(log.proposal));
      expect(beforeProposal.result.state.offer_serial).toBeUndefined();
      expect(beforeProposal.result.state.train_purchase_offer ?? null).toBeNull();
      // Reverting to just after the proposal rebuilds the same pending instance, twice alike.
      const pending = run(revertTo(log.answer));
      expect(pending.result.state.offer_serial).toBe(1);
      expect(pending.result.state.train_purchase_offer).toEqual(atAnswer.train_purchase_offer);
      expect(stateDigest(run(revertTo(log.answer)).result.state)).toBe(stateDigest(pending.result.state));
    });
  }
});
