/** @jest-environment jsdom */
//
// ==================================================================
//  PHASE 3 W2-I: STATUS VISIBILITY
// ==================================================================
//
// AUD-01.07 / OD-6 (RESOLVED 2026-10-04, owner Option A) -- the game id stays OFF screen (LIVE-2 §7.2: the server's
//   key, not the game's name). The table's visible identity is unchanged: the room code, or "Private game". The Rules
//   Reference header's existing build line gains the board's own rules version: "Build <id> · Rules v13". Nothing new
//   in the top bar.
// AUD-02.08 -- a standing "Delayed auction owed" / "Delayed auction cancelled" status in the room strip, read off the
//   board's own fields (`delayedAuctionStatus`); the first 5-train's cancellation (D-55) turns owed into cancelled.
// AUD-11.03 -- the Rules Reference says the game is over at GameEnd instead of "No live round".

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

jest.mock("../context/WalletContext", () => ({
  useWallet: () => ({
    status: "disconnected",
    error: null,
    address: null,
    nativeBalance: null,
    disconnect: () => undefined,
  }),
}));
jest.mock("../context/GameSessionContext", () => ({
  useGameSession: () => ({ sessionStatus: "uninitialized", sessionError: null, sessionAddress: null, initializeSessionKey: () => undefined }),
}));
jest.mock("./ProfileMenu", () => ({ ProfileMenu: () => null }));
jest.mock("./ConnectWalletButton", () => ({ ConnectWalletButton: () => null }));

import RulesReference, { rulesVersionStampLabel, type RulesReferenceProps } from "./RulesReference";
import TopBar from "./TopBar";
import { DelayedAuctionStatusChip } from "./DelayedAuctionStatusChip";
import { CLIENT_BUILD_ID } from "../config";
import { boardRulesVersion, UI_BUILD_LABEL } from "../utils/buildStamp";
import { DELAYED_AUCTION_STATUS_COPY, delayedAuctionStatus } from "../utils/delayedAuctionStatus";
import { expectOrder, readShell, sliceBetween } from "../utils/sourceScan";
import type { GameStateResponse } from "../gameEngine/gameState";

type State = GameStateResponse;
type Engine = InstanceType<typeof import("../gameEngine/replayLog").RoomEngine>;

const RL = require("../gameEngine/replayLog") as typeof import("../gameEngine/replayLog");
const { sandboxReplayProviders } = require("../gameEngine/replayProviders") as typeof import("../gameEngine/replayProviders");
const { withEmptyRoster, waterfallForRoster } = require("../gameEngine/gameSetup") as typeof import("../gameEngine/gameSetup");
const SS = require("../gameEngine/sandboxState") as typeof import("../gameEngine/sandboxState");
const { applyPhaseChange } = require("../gameEngine/sandboxSession") as typeof import("../gameEngine/sandboxSession");
const { RULES_ENGINE_VERSION } = require("../gameEngine/rulesVersion") as typeof import("../gameEngine/rulesVersion");
const { BAO_COMPANY_ID, BAO_PRIVATE_ID, settleBaoPrivate } =
  require("../gameEngine/baltimorePrivate") as typeof import("../gameEngine/baltimorePrivate");
const { applyPrivateExchange } = require("../gameEngine/privateExchange") as typeof import("../gameEngine/privateExchange");
const MH_PRIVATE_ID = 4;

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
global.IS_REACT_ACT_ENVIRONMENT = true;

/* ---- A real board, dealt by the engine ---------------------------------------------------------- */

const A = "p-w2i-a01";
const B = "p-w2i-b02";
const C = "p-w2i-c03";
const OPAQUE_GAME_ID = "g_abcdefghijklmnopqrstuvwxyz";

let serial = 0;
const entry = (actor: string, msg: unknown) =>
  RL.entriesFromExport([{ index: serial, id: `w2i-${serial}`, actor, at: (serial += 1), msg: msg as never }])[0];

function dealt(delayed: boolean, pinned = true): State {
  const start = withEmptyRoster(SS.sandboxScenarioState(SS.DEFAULT_SANDBOX_SCENARIO, 0, "default"));
  const waterfall = waterfallForRoster(SS.sandboxWaterfallState(SS.sandboxScenario(SS.DEFAULT_SANDBOX_SCENARIO).phase, 0, true), []);
  const board = { ...start, waterfall } as State;
  const engine: Engine = new RL.RoomEngine(
    { ...sandboxReplayProviders(), ...(board.market_positions ? { initialMarket: board.market_positions } : {}) } as never,
    { state: board, waterfall } as never,
  );
  engine.apply(
    entry(A, {
      SetupGame: {
        players: [
          { id: A, nickname: "A" },
          { id: B, nickname: "B" },
          { id: C, nickname: "C" },
        ],
        variants: { delayedAuction: delayed, length: "standard", rules: 1 },
        ...(pinned ? { rules_engine_version: RULES_ENGINE_VERSION } : {}),
      },
    }),
  );
  return { ...engine.snapshot.state, waterfall: engine.snapshot.waterfall } as State;
}

/* ---- DOM ------------------------------------------------------------------------------------------ */

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
});

const render = (node: React.ReactElement) => act(() => root.render(node));
const mountRR = (props: Partial<RulesReferenceProps>) => render(<RulesReference {...props} />);
const byTestId = (id: string) => container.querySelector(`[data-testid="${id}"]`);
const required = (id: string) => {
  const node = byTestId(id);
  if (!node) throw new Error(`missing [data-testid="${id}"]`);
  return node as HTMLElement;
};
const click = (node: Element) => act(() => (node as HTMLElement).click());

/* ================================================================================================ */

describe("AUD-01.07 / OD-6: build id + the board's rules version on the Rules Reference's existing line", () => {
  it("renders `Build <id> · Rules v13` on the one build stamp, the version read off a really dealt board", () => {
    const board = dealt(false);
    expect(board.rules_engine_version).toBe(RULES_ENGINE_VERSION);
    mountRR({ rulesEngineVersion: boardRulesVersion(board) });
    const stamp = required("rules-build-stamp");
    expect(stamp.textContent).toBe(`${UI_BUILD_LABEL} · Rules v${RULES_ENGINE_VERSION}`);
    expect(stamp.textContent).toBe(`${UI_BUILD_LABEL} · Rules v13`);
    expect(required("rules-version-stamp").parentElement).toBe(stamp); // the same line, not a new one
    expect(stamp.getAttribute("title")).toContain(CLIENT_BUILD_ID);
    expect(stamp.getAttribute("title")).toContain("rules version");
  });

  it("the version is the BOARD's pin, not the client's constant", () => {
    const board = { ...dealt(false), rules_engine_version: 12 } as State; // a v12-pinned table on a v13 client
    mountRR({ rulesEngineVersion: boardRulesVersion(board) });
    expect(required("rules-build-stamp").textContent).toBe(`${UI_BUILD_LABEL} · Rules v12`);
  });

  it("a legacy unpinned board says so; with no board the stamp is the build alone (W1-I's line, unchanged)", () => {
    const legacy = dealt(false, false);
    expect(legacy.rules_engine_version ?? null).toBeNull();
    expect(boardRulesVersion(legacy)).toBeNull();
    mountRR({ rulesEngineVersion: boardRulesVersion(legacy) });
    expect(required("rules-build-stamp").textContent).toBe(`${UI_BUILD_LABEL} · ${rulesVersionStampLabel(null)}`);
    expect(required("rules-build-stamp").textContent).toContain("Rules unpinned (legacy)");
    expect(boardRulesVersion(null)).toBeUndefined();
    mountRR({ rulesEngineVersion: boardRulesVersion(null) });
    expect(required("rules-build-stamp").textContent).toBe(UI_BUILD_LABEL);
    expect(byTestId("rules-version-stamp")).toBeNull();
  });

  it("survives page navigation and a re-render with new round props", () => {
    mountRR({ rulesEngineVersion: 13, roundType: "StockRound", roundLabel: "SR2" });
    for (const page of ["stock", "operating", "tables", "overview"]) {
      click(required(`rules-page-${page}`));
      expect(required("rules-build-stamp").textContent).toBe(`${UI_BUILD_LABEL} · Rules v13`);
    }
    mountRR({ rulesEngineVersion: 13, roundType: "OperatingRound", roundLabel: "OR 2.1", operatingSubPhase: "Track" });
    expect(required("rules-build-stamp").textContent).toBe(`${UI_BUILD_LABEL} · Rules v13`);
  });

  it("adds no element to the header row (narrow widths: the line wraps as one quiet span)", () => {
    mountRR({});
    const before = required("rules-build-stamp").parentElement!.children.length;
    mountRR({ rulesEngineVersion: 13 });
    expect(required("rules-build-stamp").parentElement!.children.length).toBe(before);
  });

  it("the opaque game id is never rendered -- not in the Rules Reference, not in the top bar", () => {
    const board = { ...dealt(true), game_id: OPAQUE_GAME_ID } as unknown as State;
    mountRR({ rulesEngineVersion: boardRulesVersion(board), gameOver: false });
    expect(container.textContent).not.toContain(OPAQUE_GAME_ID);
    render(<TopBar roomName="JUNO-ABCD-EFGH" roomContext={<DelayedAuctionStatusChip board={board} />} />);
    expect(container.textContent).not.toContain(OPAQUE_GAME_ID);
    expect(container.innerHTML).not.toContain(OPAQUE_GAME_ID);
  });

  it("the top bar's visible identity is still the room code, or 'Private game' -- and it carries no build / rules diagnostic", () => {
    render(<TopBar roomName="JUNO-ABCD-EFGH" />);
    expect(container.querySelector("code")?.textContent).toBe("JUNO-ABCD-EFGH");
    expect(container.textContent).not.toContain(UI_BUILD_LABEL);
    expect(container.textContent).not.toMatch(/Rules v\d+/);
    render(<TopBar roomName="Private game" />);
    expect(container.querySelector("code")?.textContent).toBe("Private game");
    render(<TopBar roomName={null} />);
    expect(container.querySelector("code")).toBeNull();
  });

  it("the shell: the room name is still the code or 'Private game'; the version comes from the live board; no game_id or build stamp in the top bar", () => {
    const shell = readShell();
    expect(shell).toContain('roomName={sandboxRoomCode ? (sandboxRoom?.code ?? "Private game") : null}');
    expect(shell).toContain("rulesEngineVersion={boardRulesVersion(liveState)}");
    const topBar = sliceBetween(shell, "<TopBar", "roomName={");
    expect(topBar).not.toMatch(/game_id|UI_BUILD|rules_engine_version|boardRulesVersion|rulesVersionStampLabel/);
    const rrMount = sliceBetween(shell, "<RulesReference", "/>");
    expect(rrMount).not.toMatch(/game_id|gameId/);
  });
});

/* ================================================================================================ */

describe("AUD-02.08: the Delayed Auction's standing status, read off the board", () => {
  const operating = (board: State) => ({ ...board, current_round_type: "OperatingRound" }) as State;

  it("owed on a really dealt delayed game, through Stock and Operating Rounds", () => {
    const board = dealt(true);
    expect(board.private_auction_complete).toBe(false);
    expect(delayedAuctionStatus(board)).toBe("owed");
    expect(delayedAuctionStatus(operating(board))).toBe("owed");
  });

  it("the first 5-train's cancellation (D-55, the engine's own transition) turns owed into cancelled", () => {
    const before = operating(dealt(true));
    const after = applyPhaseChange(before, "5");
    expect(after.private_auction_complete).toBe(true); // the engine cancelled it
    expect(delayedAuctionStatus(before)).toBe("owed");
    expect(delayedAuctionStatus(after)).toBe("cancelled");
    expect(delayedAuctionStatus({ ...after, current_round_type: "StockRound" } as State)).toBe("cancelled");
  });

  it("an auction that RAN is not 'cancelled', even after Phase 5 closes its sold privates", () => {
    const board = operating(dealt(true));
    const held = {
      ...board,
      private_auction_complete: true,
      private_companies: board.private_companies.map((priv, i) => ({ ...priv, owner: [A, B, C][i % 3] })),
    } as State;
    expect(delayedAuctionStatus(held)).toBeNull();
    const closed = applyPhaseChange(held, "5");
    expect(closed.private_companies.every((priv) => priv.closed)).toBe(true);
    expect(delayedAuctionStatus(closed)).toBeNull();
  });

  it("review fix: the B&O's first-train closure and the M&H's NYC exchange (both release their owner) never read as cancelled", () => {
    const board = operating(dealt(true));
    const held = {
      ...board,
      private_auction_complete: true,
      private_companies: board.private_companies.map((priv, i) => ({ ...priv, owner: [A, B, C][i % 3] })),
    } as State;
    const bao = held.public_companies.find((company) => company.company_id === BAO_COMPANY_ID)!;
    const baoClosed = settleBaoPrivate({
      ...held,
      public_companies: held.public_companies.map((company) => (company === bao ? { ...company, owned_trains: ["2"] } : company)),
    } as State);
    const baoPriv = baoClosed.private_companies.find((priv) => priv.private_id === BAO_PRIVATE_ID)!;
    expect([baoPriv.closed, baoPriv.owner, baoPriv.owner_protocol_id]).toEqual([true, null, null]); // the engine released it
    expect(delayedAuctionStatus(baoClosed)).toBeNull();
    const mh = baoClosed.private_companies.find((priv) => priv.private_id === MH_PRIVATE_ID)!;
    const nyc = baoClosed.public_companies.find((company) => company.ticker === "NYC")!;
    const exchanged = applyPrivateExchange(baoClosed, {
      ok: true,
      privateId: MH_PRIVATE_ID,
      companyId: nyc.company_id,
      ticker: "NYC",
      player: mh.owner as string,
      source: "Ipo",
    });
    const mhAfter = exchanged.private_companies.find((priv) => priv.private_id === MH_PRIVATE_ID)!;
    expect([mhAfter.closed, mhAfter.owner]).toEqual([true, null]);
    expect(delayedAuctionStatus(exchanged)).toBeNull();
    // ...and Phase 5 on top of both still is not a cancellation.
    expect(delayedAuctionStatus(applyPhaseChange(exchanged, "5"))).toBeNull();
  });

  it("silent outside the variant, during the auction round itself, at GameEnd, and with no board", () => {
    const standard = dealt(false);
    expect(delayedAuctionStatus(standard)).toBeNull();
    expect(delayedAuctionStatus(applyPhaseChange(operating(standard), "5"))).toBeNull();
    const delayed = dealt(true);
    expect(delayedAuctionStatus({ ...delayed, current_round_type: "WaterfallAuction" } as State)).toBeNull();
    expect(delayedAuctionStatus({ ...delayed, current_round_type: "GameEnd" } as State)).toBeNull();
    expect(delayedAuctionStatus(null)).toBeNull();
  });

  it("the chip draws exactly that status, and follows the board across re-renders (a scrub shows the scrubbed board's)", () => {
    const owed = operating(dealt(true));
    const cancelled = applyPhaseChange(owed, "5");
    render(<DelayedAuctionStatusChip board={owed} />);
    expect(required("delayed-auction-status").textContent).toBe(DELAYED_AUCTION_STATUS_COPY.owed.label);
    expect(required("delayed-auction-status").getAttribute("data-status")).toBe("owed");
    expect(required("delayed-auction-status").getAttribute("title")).toBe(DELAYED_AUCTION_STATUS_COPY.owed.title);
    render(<DelayedAuctionStatusChip board={cancelled} />);
    expect(required("delayed-auction-status").textContent).toBe(DELAYED_AUCTION_STATUS_COPY.cancelled.label);
    render(<DelayedAuctionStatusChip board={owed} />); // scrubbed back behind the 5-train
    expect(required("delayed-auction-status").getAttribute("data-status")).toBe("owed");
    render(<DelayedAuctionStatusChip board={dealt(false)} />);
    expect(byTestId("delayed-auction-status")).toBeNull();
  });

  it("one chip, in the room strip, on every table kind, fed the shown board -- not log text", () => {
    const shell = readShell();
    const strip = sliceBetween(shell, "roomContext={", "roomName={");
    expect(strip.match(/<DelayedAuctionStatusChip/g)).toHaveLength(1);
    expect(strip).toContain("<DelayedAuctionStatusChip board={gameState} />");
    // After the sandbox / on-chain branch, so both draw it.
    expectOrder(strip, "On-chain game", "<DelayedAuctionStatusChip");
    expect(shell.match(/<DelayedAuctionStatusChip/g)).toHaveLength(1);
  });
});

/* ================================================================================================ */

describe("AUD-11.03: the Rules Reference's game-over state", () => {
  it("at GameEnd says the game is over, not 'No live round'", () => {
    mountRR({ roundType: null, gameOver: true });
    const strip = required("rules-context-strip");
    expect(strip.textContent).toContain("Game over");
    expect(strip.textContent).toContain("This game has ended");
    expect(strip.textContent).not.toContain("No live round");
    const current = required("rules-current-round");
    expect(current.querySelector("h3")?.textContent).toBe("Game over");
    expect(current.textContent).toContain("Final");
    expect(required("rules-no-round-lead").textContent).toContain("no further rounds will be played");
    expect(container.textContent).not.toContain("No live round");
  });

  it("without the flag the round-less reference is unchanged", () => {
    mountRR({ roundType: null });
    expect(required("rules-context-strip").textContent).toContain("No live round — showing the full reference.");
    expect(required("rules-current-round").querySelector("h3")?.textContent).toBe("No live round");
    expect(container.textContent).not.toContain("Game over");
  });

  it("a live round always wins over the flag (presentation only -- no new predicate)", () => {
    mountRR({ roundType: "StockRound", roundLabel: "SR3", gameOver: true });
    expect(container.textContent).not.toContain("Game over");
    expect(container.textContent).toContain("Stock Round 3");
  });

  it("survives page navigation", () => {
    mountRR({ roundType: null, gameOver: true, rulesEngineVersion: 13 });
    click(required("rules-page-tables"));
    expect(required("rules-context-strip").textContent).toContain("Game over");
    click(required("rules-page-overview"));
    expect(required("rules-current-round").querySelector("h3")?.textContent).toBe("Game over");
  });

  it("the shell passes the board's own GameEnd, and the round type stays null there (#898)", () => {
    const shell = readShell();
    const rrMount = sliceBetween(shell, "<RulesReference", "/>");
    expect(rrMount).toContain('gameOver={gameState?.current_round_type === "GameEnd"}');
    expect(rrMount.replace(/\s+/g, " ")).toContain('roundType={ gameState?.current_round_type === "GameEnd" ? null');
  });
});
