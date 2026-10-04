/** @jest-environment node */
//
// ==================================================================
//  PHASE 3 W2-A (OD-1): THE SHELL'S ONE HOLD ANSWER, HOLD x VIEWER
// ==================================================================
//
// For every authoritative hold the board can carry -- the three ordinary offers (unanswered, and the private one
// accepted-awaiting-settlement), the funding offer, the home station, the excess-train discard, the forced train
// purchase and the finished game -- and for every viewer role (the answerer, the proposer, the obligated
// president, another seated player, a seatless watcher, a spectator holding a seat's wallet), this pins:
//
//   - whether a shell hold exists, and its truthful sentence (the authority's own, names for ids);
//   - Skip / Pass-End Turn / Lay / Buy blocked exactly when the authority refuses that control's message;
//   - the legal RESOLUTION control kept: its message passes the hold, and the EXISTING seat authority (not a
//     second matrix written here) names exactly the right viewer -- never the watcher, never the spectator.
//
// The dock answer takes no viewer at all (it can only grey), so it is asserted identical for every role.

import type { MapGridResponse } from "../components/hexContractTypes";
import { authoritativeHoldRefusal } from "../gameEngine/authoritativeHolds";
import type { SandboxLogMsg } from "../gameEngine/gameSetup";
import type { GameStateResponse } from "../gameEngine/gameState";
import { emergencyFundingFor, emergencyPurchaseRefusal, fundingPrivateAnswerRefusal, fundingPrivateRescindRefusal } from "../gameEngine/emergencyFunding";
import { boardHomeHexToAxial, owedHomeStation } from "../gameEngine/homeStationAuthority";
import { rescindPrivatePurchaseRefusal } from "../gameEngine/privatePurchaseAuthority";
import { answerPrivateTradeRefusal, rescindPrivateTradeRefusal } from "../gameEngine/privateTradeAuthority";
import { discardTrainRefusal, pendingTrainDiscards } from "../gameEngine/trainDiscard";
import { dockHoldView, NO_DOCK_HOLD, type DockHoldView } from "./dockHoldView";
import { CA, DH, MH, operatingBoard, stockRoundBoard } from "./offerFixtures74";
import { apply, corridor, fundingBoard, GRID, M, NYC, P1, P2, P3, PRR, CO, privateOfferStages, withCorp, withState } from "./offerMatrix74Support";
import { privateOfferConsentRoles, trainOfferConsentRoles } from "./offerConsentView";
import { labelSentence } from "./stockRoundPrivateTrade";
import { viewerIsNamedActor } from "./waitingPromptView";

const LABELS: Record<string, string> = { [P1]: "Ann", [P2]: "Ben", [P3]: "Cy" };
const labelFor = (address: string) => LABELS[address] ?? address;
const WATCHER = ""; // a seatless room watcher's id (LIVE-2D)

type Role = "answerer" | "proposer" | "president" | "other" | "watcher" | "spectator";

/** A viewer: the id this tab acts as, and whether it is a read-only spectator. */
interface Viewer {
  address: string;
  spectator: boolean;
}

interface HoldCase {
  label: string;
  board: () => GameStateResponse;
  grid: MapGridResponse;
  /** The seats that hold each role on this board (a role a hold does not have is absent). */
  roles: Partial<Record<Role, Viewer>>;
  /** Text the sentence must carry (names, never ids, where a seat is named). */
  sentence: RegExp;
  /** The control surfaces this hold actually reaches in its round. */
  surfaces: { skipRendered?: boolean; lay?: boolean; buyBank?: boolean; proposeTrain?: "blocked" | "live"; proposePrivate?: boolean; pass?: boolean };
  /** The resolution messages and the existing seat authority that says who may send each. */
  resolutions: Array<{ name: string; msg: SandboxLogMsg; mayResolve: (state: GameStateResponse, viewer: Viewer) => boolean; who: Role[] }>;
}

const orBoard = () =>
  operatingBoard({
    privates: [
      { id: DH, owner: P2, cost: "70" },
      { id: CA, owner: P3, cost: "160" },
      { id: MH, owner: P1, cost: "110" },
    ],
  });
const srBoard = () =>
  stockRoundBoard({
    corps: [
      { id: PRR, ticker: "PRR", president: P1, trains: ["3"], treasury: "500", holdings: [[P1, 30], [P2, 20]], ipo: 50 },
      { id: NYC, ticker: "NYC", president: P2, trains: ["2"], treasury: "400", price: 90, holdings: [[P2, 30], [P3, 10], [P1, 10]], ipo: 50 },
    ],
    privates: [
      { id: DH, owner: P2, cost: "70" },
      { id: MH, owner: P1, cost: "110" },
      { id: CA, owner: P3, cost: "160" },
    ],
  });

const seated = (address: string): Viewer => ({ address, spectator: false });
const spectating = (address: string): Viewer => ({ address, spectator: true });
const watcher: Viewer = { address: WATCHER, spectator: false };

/** The W2-H viewer rule, explicit: only the named actor's own, non-spectating screen. */
const named = (actor: string | null | undefined, viewer: Viewer) =>
  viewerIsNamedActor({ spectator: viewer.spectator, actor, viewerAddress: viewer.address });

/* The offer prompts' seat authority is `offerConsentView` (W1-D). It takes no spectator flag -- the bar a spectator
   would act from is not rendered for one (App: `spectator ? <spectator dock> : ...`) -- so the spectator rule is the
   explicit W2-H one applied on top, which is the direction a prompt must also take. */
const privateAnswerer = (state: GameStateResponse, v: Viewer) => !v.spectator && privateOfferConsentRoles(state, v.address).viewerIsAnswerer;
const privateProposer = (state: GameStateResponse, v: Viewer) => !v.spectator && privateOfferConsentRoles(state, v.address).viewerIsProposer;
const trainAnswerer = (state: GameStateResponse, v: Viewer) => !v.spectator && trainOfferConsentRoles(state, v.address).viewerIsAnswerer;
const trainProposer = (state: GameStateResponse, v: Viewer) => !v.spectator && trainOfferConsentRoles(state, v.address).viewerIsProposer;
/* The rest are the authorities' own actor arguments, with an explicit seat: `null` would mean "do not judge". */
const actorPasses = (refusal: (actor: string) => string | null) => (v: Viewer) =>
  !v.spectator && v.address.length > 0 && refusal(v.address) === null;

const PRIVATE_OFFERED = () => apply(orBoard(), M.proposePrivate(DH, PRR, 100), P1);
const TRAIN_OFFERED = () => apply(orBoard(), M.proposeTrain(NYC, PRR, "3", "150"), P1);
const TRADE_OFFERED = () => apply(srBoard(), M.proposeTrade(DH, P2, P1, 50), P1);
const HOME_OWED = () => withCorp(orBoard(), PRR, { home_hex_label: "H12", station_token_hexes: [], station_tokens: [] });
/* PRR (Ann) operates and has bought the first 4: C&O (Cy) is over the new limit of 3 and must discard. */
const DISCARD_OWED = () =>
  withCorp(withCorp(operatingBoard(), PRR, { owned_trains: ["4"] }), CO, { owned_trains: ["3", "3", "3", "3"] });
const FORCED = () => fundingBoard(100, { privates: [{ id: DH, owner: P1, cost: "70" }] });
const FUNDING_OFFERED = () => ({
  ...FORCED(),
  private_purchase_offer: {
    private_id: DH,
    private_name: "Delaware & Hudson",
    owner: P1,
    buyer_protocol_id: NYC,
    buyer_ticker: "NYC",
    price: 70,
    funding: true as const,
  },
}) as GameStateResponse;
const ENDED = () => withState(operatingBoard(), { current_round_type: "GameEnd" });

const CASES: HoldCase[] = [
  {
    label: "standing private purchase offer (unanswered)",
    board: PRIVATE_OFFERED,
    grid: GRID,
    roles: { answerer: seated(P2), proposer: seated(P1), other: seated(P3), watcher, spectator: spectating(P2) },
    sentence: /^PRR's offer of \$100 for .* is waiting for its owner's answer; nothing else can happen until it is answered or withdrawn\.$/,
    surfaces: { skipRendered: true, lay: true, buyBank: true, proposeTrain: "blocked", proposePrivate: true },
    resolutions: [
      { name: "Accept / Reject", msg: M.answerPrivate(DH, true) as SandboxLogMsg, mayResolve: privateAnswerer, who: ["answerer"] },
      { name: "Rescind", msg: M.rescindPrivate(DH) as SandboxLogMsg, mayResolve: privateProposer, who: ["proposer"] },
    ],
  },
  {
    label: "standing private purchase offer (accepted, awaiting settlement)",
    board: () => privateOfferStages(orBoard(), DH, 100, P2).accepted,
    grid: GRID,
    roles: { proposer: seated(P1), other: seated(P3), watcher, spectator: spectating(P1) },
    sentence: /accepted and awaiting settlement; nothing else can happen until it settles\.$/,
    surfaces: { skipRendered: true, lay: true, buyBank: true, proposeTrain: "blocked", proposePrivate: true },
    resolutions: [
      /* The accepted offer has no answerer (`offerConsentView` gives it no roles; #1247). Its proposer may still
         withdraw it -- the authority's own rescission, judged with the seat. */
      {
        name: "Rescind",
        msg: M.rescindPrivate(DH) as SandboxLogMsg,
        mayResolve: (state, v) => actorPasses((actor) => rescindPrivatePurchaseRefusal(state, { private_id: DH }, actor))(v),
        who: ["proposer"],
      },
    ],
  },
  {
    label: "standing train purchase offer",
    board: TRAIN_OFFERED,
    grid: GRID,
    roles: { answerer: seated(P2), proposer: seated(P1), other: seated(P3), watcher, spectator: spectating(P2) },
    sentence: /^PRR's offer of \$150 for NYC's 3-train is waiting for the selling president's answer; nothing else can happen until it is answered or withdrawn\.$/,
    surfaces: { skipRendered: true, lay: true, buyBank: true, proposeTrain: "blocked", proposePrivate: true },
    resolutions: [
      { name: "Accept / Reject", msg: M.answerTrain(NYC, true) as SandboxLogMsg, mayResolve: trainAnswerer, who: ["answerer"] },
      { name: "Rescind", msg: M.rescindTrain(NYC) as SandboxLogMsg, mayResolve: trainProposer, who: ["proposer"] },
    ],
  },
  {
    label: "standing player <-> player private trade (Stock Round)",
    board: TRADE_OFFERED,
    grid: GRID,
    roles: { answerer: seated(P2), proposer: seated(P1), other: seated(P3), watcher, spectator: spectating(P2) },
    sentence: /between Ben and Ann for \$50 and is waiting for an answer; nothing else can happen until it is answered or withdrawn\.$/,
    surfaces: { pass: true },
    resolutions: [
      {
        name: "Accept / Reject",
        msg: M.answerTrade(DH, true) as SandboxLogMsg,
        mayResolve: (state, v) => actorPasses((actor) => answerPrivateTradeRefusal(state, { private_id: DH, accept: false }, actor))(v),
        who: ["answerer"],
      },
      {
        name: "Rescind",
        msg: M.rescindTrade(DH) as SandboxLogMsg,
        mayResolve: (state, v) => actorPasses((actor) => rescindPrivateTradeRefusal(state, { private_id: DH }, actor))(v),
        who: ["proposer"],
      },
    ],
  },
  {
    label: "funding private offer (emergency, v12)",
    board: FUNDING_OFFERED,
    grid: corridor(),
    roles: { answerer: seated(P2), proposer: seated(P1), other: seated(P3), watcher, spectator: spectating(P2) },
    sentence: /is on offer to NYC; nothing else can happen until its president answers or the seller withdraws\.$/,
    surfaces: { skipRendered: false, lay: true, buyBank: true, proposeTrain: "blocked", proposePrivate: true },
    resolutions: [
      {
        name: "Accept / Reject",
        msg: { AnswerFundingPrivateOffer: { game_id: 1, private_id: DH, accept: false } } as unknown as SandboxLogMsg,
        mayResolve: (state, v) => actorPasses((actor) => fundingPrivateAnswerRefusal(state, { private_id: DH, accept: false }, actor))(v),
        who: ["answerer"],
      },
      {
        name: "Rescind",
        msg: { RescindFundingPrivateOffer: { game_id: 1, private_id: DH } } as unknown as SandboxLogMsg,
        mayResolve: (state, v) => actorPasses((actor) => fundingPrivateRescindRefusal(state, { private_id: DH }, actor))(v),
        who: ["proposer"],
      },
    ],
  },
  {
    label: "home-station obligation",
    board: HOME_OWED,
    grid: GRID,
    roles: { president: seated(P1), other: seated(P2), watcher, spectator: spectating(P1) },
    sentence: /^PRR is starting its first operating turn and its home station is not on the board yet\. Ann must place it on .* before PRR can operate\.$/,
    surfaces: { skipRendered: true, lay: true, buyBank: true, proposeTrain: "blocked", proposePrivate: true },
    resolutions: [
      {
        name: "Place the home station",
        msg: { PlaceHomeStation: { company_id: PRR, q: 0, r: 0, kind: "home" } } as unknown as SandboxLogMsg,
        mayResolve: (state, v) => named(owedHomeStation(state, boardHomeHexToAxial)?.president, v),
        who: ["president"],
      },
    ],
  },
  {
    label: "excess-train discard obligation",
    board: DISCARD_OWED,
    grid: GRID,
    roles: { president: seated(P3), other: seated(P2), proposer: undefined, watcher, spectator: spectating(P3) },
    sentence: /^C&O holds 1 train more than the limit of 3; C&O's president must discard before anything else happens\.$/,
    surfaces: { skipRendered: true, lay: true, buyBank: true, proposeTrain: "blocked", proposePrivate: true },
    resolutions: [
      {
        name: "Discard",
        msg: M.discard(CO, "3") as SandboxLogMsg,
        mayResolve: (state, v) => actorPasses((actor) => discardTrainRefusal(state, { protocol_id: CO, model_type: "3" }, actor))(v),
        who: ["president"],
      },
    ],
  },
  {
    label: "forced train purchase (emergency funding obligation, v12)",
    board: FORCED,
    grid: corridor(),
    roles: { president: seated(P1), other: seated(P2), watcher, spectator: spectating(P1) },
    sentence: /^C&O must buy a 3-train \(\$180\) and cannot pay for it; its president must fund the purchase before anything else happens\.$/,
    /* The v12 funding hold lets a corporate trade through (it is one way out, D-6) -- so the train offer stays live
       while the depot purchase is refused. W3-K owns any change to this. */
    surfaces: { skipRendered: false, lay: true, buyBank: true, proposeTrain: "live", proposePrivate: true },
    resolutions: [
      {
        name: "Emergency purchase",
        msg: M.emergency(CO) as SandboxLogMsg,
        mayResolve: (state, v) =>
          actorPasses((actor) => {
            const refusal = emergencyPurchaseRefusal(state, CO, corridor(), actor);
            /* Only the seat test is this matrix's question; a president who must first sell shares is still the
               one who resolves it. */
            return refusal !== null && refusal.startsWith("Only ") ? refusal : null;
          })(v),
        who: ["president"],
      },
    ],
  },
  {
    label: "finished game",
    board: ENDED,
    grid: GRID,
    roles: { other: seated(P2), watcher, spectator: spectating(P1) },
    sentence: /^The game has ended\. Nothing further can be played\.$/,
    surfaces: { skipRendered: false, lay: true, buyBank: true, proposeTrain: "blocked", proposePrivate: true, pass: true },
    resolutions: [
      /* Nothing resolves it; the room's Close stays open to every seat (#899). */
      { name: "Close Room", msg: M.closeRoom as unknown as SandboxLogMsg, mayResolve: (_s, v) => !v.spectator && v.address.length > 0, who: ["other"] },
    ],
  },
];

const viewFor = (hold: HoldCase, state: GameStateResponse) =>
  dockHoldView({ state, mapGrid: hold.grid, homeHexToAxial: boardHomeHexToAxial, labelFor });

describe("no hold: every field is null (ordinary behaviour is untouched, OD-1)", () => {
  it.each([
    ["an Operating Round turn", orBoard()],
    ["a Stock Round turn", srBoard()],
  ])("%s", (_label, state) => {
    expect(dockHoldView({ state, mapGrid: GRID, labelFor })).toEqual(NO_DOCK_HOLD);
  });
  it("no board, or a scrubbed past board, reports nothing", () => {
    expect(dockHoldView({ state: null, labelFor })).toEqual(NO_DOCK_HOLD);
    expect(dockHoldView({ state: PRIVATE_OFFERED(), mapGrid: GRID, labelFor, scrubbing: true })).toEqual(NO_DOCK_HOLD);
  });
});

describe.each(CASES)("$label", (hold) => {
  const state = hold.board();
  const view: DockHoldView = viewFor(hold, state);

  it("is a real hold on this board", () => {
    if (hold.label.startsWith("forced")) expect(emergencyFundingFor(state, hold.grid)).not.toBeNull();
    if (hold.label.startsWith("excess")) expect(pendingTrainDiscards(state)?.required.ticker).toBe("C&O");
    if (hold.label.startsWith("home")) expect(owedHomeStation(state, boardHomeHexToAxial)?.ticker).toBe("PRR");
  });

  it("a shell hold exists, with the authority's own sentence (names for ids)", () => {
    const raw = authoritativeHoldRefusal(state, M.pass as SandboxLogMsg, { mapGrid: hold.grid, homeHexToAxial: boardHomeHexToAxial });
    expect(raw).not.toBeNull();
    expect(view.turnHoldReason).toBe(labelSentence(raw!, state.player_addresses, labelFor));
    expect(view.turnHoldReason).toMatch(hold.sentence);
    expect(view.turnHoldReason).not.toMatch(/\bp[123]\b/); // a seat id never reaches the screen
  });

  it("the bar's one prop is the refusal of every turn move it greys (Skip, Pass / End Turn, Pay / Withhold, Run)", () => {
    const ctx = { mapGrid: hold.grid, homeHexToAxial: boardHomeHexToAxial };
    for (const msg of [M.pass, M.advance(PRR), M.dividend(PRR), M.run(PRR), { WaterfallPass: { game_id: 1 } }]) {
      const raw = authoritativeHoldRefusal(state, msg as SandboxLogMsg, ctx);
      expect([Object.keys(msg)[0], raw === null ? null : labelSentence(raw, state.player_addresses, labelFor)]).toEqual([
        Object.keys(msg)[0],
        view.turnHoldReason,
      ]);
    }
    expect(view.pass).toBe(view.turnHoldReason);
    expect(view.skip).toBe(view.turnHoldReason);
  });

  it("Skip / Pass / Lay / Buy: blocked exactly where the authority refuses them", () => {
    // Skip greys under every Operating Round hold; where the bar renders it at all is the flag.
    if (hold.surfaces.skipRendered !== undefined) expect(view.skip).toBe(view.turnHoldReason);
    if (hold.surfaces.pass) expect(view.pass).not.toBeNull();
    if (hold.surfaces.lay) expect(view.layTile).toBe(view.turnHoldReason);
    if (hold.surfaces.buyBank) expect(view.buyTrainFromBank).toBe(view.turnHoldReason);
    if (hold.surfaces.proposeTrain === "blocked") expect(view.proposeTrainPurchase).toBe(view.turnHoldReason);
    if (hold.surfaces.proposeTrain === "live") expect(view.proposeTrainPurchase).toBeNull();
    if (hold.surfaces.proposePrivate) expect(view.proposePrivatePurchase).toBe(view.turnHoldReason);
    // A paid token and the D&H's free one are moves like any other; only the home placement resolves the home hold.
    expect(view.placeStationToken).toBe(view.turnHoldReason);
    expect(view.placeDhStation).toBe(view.turnHoldReason);
    expect(view.placeHomeStation).toBe(hold.label.startsWith("home") ? null : view.turnHoldReason);
  });

  it("the resolver is never blocked by their own hold: every resolution message passes it", () => {
    for (const { name, msg } of hold.resolutions) {
      expect([name, authoritativeHoldRefusal(state, msg, { mapGrid: hold.grid, homeHexToAxial: boardHomeHexToAxial })]).toEqual([name, null]);
    }
  });

  describe.each(Object.entries(hold.roles).filter((entry): entry is [Role, Viewer] => entry[1] !== undefined))("viewer: %s", (role, viewer) => {
    it("reads the same dock answer as every other seat (the view takes no viewer; it can only grey)", () => {
      expect(viewFor(hold, state)).toEqual(view);
      expect(view.turnHoldReason).not.toBeNull();
    });
    it("keeps exactly the resolution controls the existing seat authority gives this role", () => {
      for (const resolution of hold.resolutions) {
        expect([resolution.name, role, resolution.mayResolve(state, viewer)]).toEqual([
          resolution.name,
          role,
          resolution.who.includes(role),
        ]);
      }
    });
  });
});

describe("a resolver's message passes; the same seat's ordinary moves do not (no seat is exempt from the hold)", () => {
  it("the train offer's answerer can answer but cannot pass, skip, lay or buy", () => {
    const state = TRAIN_OFFERED();
    const view = dockHoldView({ state, mapGrid: GRID, labelFor });
    expect(authoritativeHoldRefusal(state, M.answerTrain(NYC, false) as SandboxLogMsg, { mapGrid: GRID })).toBeNull();
    expect([view.pass, view.skip, view.layTile, view.buyTrainFromBank].every((reason) => reason !== null)).toBe(true);
  });
});

/* ================================================================================================== */
describe("one call site, threaded to every consumer (source scan over the comment-stripped shell)", () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { readShell, readStripped, sliceBetween } = require("./sourceScan") as typeof import("./sourceScan");
  const SHELL = readShell();
  const BAR = readStripped("panels/ContextualActionBar.tsx");

  it("the shell derives the hold view exactly once, and asks the hold composition nowhere else", () => {
    expect(SHELL.split("dockHoldView(").length - 1).toBe(1);
    expect(SHELL).not.toContain("authoritativeHoldRefusal(");
    expect(SHELL).not.toContain("homeTokenBlock(");
  });

  it("every consumer reads a field of that one answer", () => {
    expect(SHELL).toContain("turnHoldReason={dockHold.turnHoldReason}");
    expect(sliceBetween(SHELL, "const passDisabledReason =", "return (")).toMatch(/^const passDisabledReason =\s*dockHold\.pass \?\?/);
    expect(sliceBetween(SHELL, "const tileLayDisabledReason = useMemo(", "const canLayTileNow")).toContain(
      `if (dockHold.layTile !== null) return \`Planning Mode: Tile lay disabled — ${String.fromCharCode(36)}{dockHold.layTile}\`;`,
    );
    expect(SHELL).toContain("canConfirm={controlsEnabled && pendingTokenHold === null}");
    expect(sliceBetween(SHELL, "const pendingTokenHold =", ";")).toMatch(/dockHold\.placeStationToken[\s\S]*dockHold\.placeHomeStation[\s\S]*dockHold\.placeDhStation/);
    expect(SHELL).toContain("blockedReason: dockHold.proposeTrainPurchase,");
    expect(SHELL).toContain("bankBlockedReason: dockHold.buyTrainFromBank,");
    expect(SHELL).toContain("blockedReason: dockHold.proposePrivatePurchase,");
  });

  it("P3-N009: the chain-era `trainOffers` register is no longer read for the train panel's reason", () => {
    expect(SHELL).not.toMatch(/\btrainOffers\b/);
    expect(SHELL).not.toContain("One offer at a time — answer or rescind the outstanding one first.");
  });

  it("the bar greys exactly the turn moves with the one prop, and forwards the panels' reasons", () => {
    expect(BAR).toContain("disabled={!sessionReady || turnHoldReason !== null}"); // Skip
    expect(BAR).toContain("disabled: mustBuyTrain || turnHoldReason !== null,"); // End Turn
    expect(BAR.split("disabled: turnHoldReason !== null,").length - 1).toBe(2); // Pay, Withhold
    expect(BAR).toContain("blockedReason={turnHoldReason}"); // Run Trains
    expect(BAR).toContain("blockedReason={privatePurchase.blockedReason ?? null}");
    expect(BAR).toContain("bankBlockedReason={trainPurchase.bankBlockedReason ?? null}");
    // The informational surfaces (OD-1) stay ungated by the hold.
    expect(sliceBetween(BAR, "const showRouteReadout =", ";")).not.toContain("turnHoldReason");
  });
});
