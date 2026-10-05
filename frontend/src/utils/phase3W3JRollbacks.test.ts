/** @jest-environment node */
// frontend/src/utils/phase3W3JRollbacks.test.ts
//
// ==================================================================
//  PHASE 3 W3-J: WHAT A REFUSED PRESS TAKES BACK -- AUD-25.04, AUD-25.05 (the non-RED half), AUD-25.13 #8
// ==================================================================
//
// The decisions are pure functions (`freeStationInFlight.ts`, `refusedPressRollback.ts`) exercised here on real
// boards through the real reducer where a board is involved; the shell's call sites (outside every RED region) are
// pinned at their lines, because the shell itself cannot be executed under jest (W3-C's recorded residual, AUD-25.13
// #10). The rule every case keeps: a press is taken back ONLY when the room said it was not applied (`false`); an
// applied answer (`true`) is never rolled back, however its acknowledgement and its entry are ordered.

import { activateBoard, STANDARD_BOARD, STATIC_BOARD_HEXES } from "../components/hexBoardData";
import { boardHomeHexToAxial } from "../gameEngine/homeStationAuthority";
import { pendingHomeTokens } from "../gameEngine/sandboxSession";
import type { GameStateResponse } from "../gameEngine/gameState";
import { board, P1, P2, P3, PRR, NYC } from "./offerFixtures74";
import { applyAsRoom, same, withCorp } from "./offerMatrix74Support";
import {
  freeStationSettlement,
  homePromptPending,
  inFlightReleasedByBoard,
  type FreeStationInFlight,
} from "./freeStationInFlight";
import { errandAfterRefusedLay, ghostAfterRefusedLay, tabAfterRefusedErrandLay } from "./refusedPressRollback";
import { rollBackIfRefused } from "./submissionAnswer";
import { readShell, sliceBetween } from "./sourceScan";

afterAll(() => activateBoard(STANDARD_BOARD));

const BO = 4;
const GRID = { game_id: 1, tiles: [] } as never;
const table = boardHomeHexToAxial;
const hexAt = (label: string) => {
  const hex = STATIC_BOARD_HEXES.find((entry) => entry.label === label);
  if (!hex) throw new Error(`no ${label}`);
  return hex;
};
const home = (companyId: number, label: string) => ({
  PlaceHomeStation: { game_id: 1, company_id: companyId, q: hexAt(label).q, r: hexAt(label).r, kind: "home", city_index: null, hex_label: label },
});

/** Operating Round: B&O (P2) at the start of its first operating turn, home I15 unplaced -- the board owes it. */
function owingBoard(): GameStateResponse {
  const state = board({
    round: "OperatingRound",
    corps: [
      { id: PRR, ticker: "PRR", president: P1, trains: ["2"], treasury: "500", price: 100 },
      { id: BO, ticker: "B&O", president: P2, trains: [], treasury: "900", price: 90 },
      { id: NYC, ticker: "NYC", president: P3, trains: [], treasury: "700", price: 71 },
    ],
    operating: BO,
    step: "Track",
  });
  const h12: [number, number] = [hexAt("H12").q, hexAt("H12").r];
  let out = withCorp(state, PRR, { home_hex_label: "H12", station_token_hexes: [h12], station_tokens: [] });
  out = withCorp(out, BO, { home_hex_label: "I15" });
  out = withCorp(out, NYC, { home_hex_label: "E19", station_token_hexes: [[hexAt("E19").q, hexAt("E19").r]], station_tokens: [] });
  return out;
}
const owedOn = (state: GameStateResponse) => pendingHomeTokens(state, table, GRID)[0] ?? null;

describe("AUD-25.04: the home prompt does not ask again while the placement is in flight", () => {
  const before = owingBoard();
  const owed = owedOn(before);
  const marker: FreeStationInFlight = { companyId: BO, kind: "home-station" };

  it("the board owes B&O its home; with nothing in flight the President is asked", () => {
    expect(owed?.companyId).toBe(BO);
    expect(homePromptPending(owed, false, null)).toBe(owed);
    // The armed errand is the map's question, exactly as before (#440).
    expect(homePromptPending(owed, true, null)).toBeNull();
  });

  it("once pressed, the prompt is held for the round trip -- the board still owes the token until the entry arrives", () => {
    expect(homePromptPending(owed, false, marker)).toBeNull();
    // The defect: the old mount (`homeStationPlacement ? null : pendingHomeToken`) asked again here.
    expect(inFlightReleasedByBoard(marker, owed)).toBe(false);
  });

  it("APPLIED: the answer alone does not release it (no flash); the board's entry does", () => {
    expect(freeStationSettlement(true)).toBe("hold");
    // Acknowledged before the drain: the board still owes, the marker holds, the prompt stays down.
    expect(inFlightReleasedByBoard(marker, owed)).toBe(false);
    // The entry lands through the real reducer: the board stops owing, the marker releases.
    const placed = applyAsRoom(before, home(BO, "I15"), P2, GRID);
    expect(same(placed, before)).toBe(false);
    expect(owedOn(placed)).toBeNull();
    expect(inFlightReleasedByBoard(marker, owedOn(placed))).toBe(true);
  });

  it("REFUSED: released at once, and the board -- which applied nothing -- asks again for a second try", () => {
    const refused = applyAsRoom(before, home(BO, "F6"), P2, GRID); // not B&O's home hex: refused, nothing applied
    expect(same(refused, before)).toBe(true);
    expect(freeStationSettlement(false)).toBe("refused");
    expect(homePromptPending(owedOn(refused), false, null)?.companyId).toBe(BO);
  });

  it("no room answer (the solo sandbox applied inside the click): nothing is in flight", () => {
    expect(freeStationSettlement(undefined)).toBe("release");
    expect(freeStationSettlement(null)).toBe("release");
  });

  it("another corporation's debt is never held by this marker, and a D&H station holds nothing past its answer", () => {
    expect(homePromptPending({ companyId: NYC }, false, marker)).toEqual({ companyId: NYC });
    expect(inFlightReleasedByBoard(marker, { companyId: NYC })).toBe(true);
    const dh: FreeStationInFlight = { companyId: PRR, kind: "private-station" };
    expect(homePromptPending(owed, false, dh)).toBe(owed);
    expect(inFlightReleasedByBoard(dh, owed)).toBe(true);
  });
});

describe("AUD-25.04: a refused D&H station gives the power back (the shell's call site)", () => {
  const shell = readShell();
  const committer = sliceBetween(shell, "const commitFreeStationPlacement = useCallback(", "const handleConfirmBoPar = useCallback(");

  it("the dispatch's answer is kept, the marker set, and the settlement asked of the room's answer", () => {
    expect(committer).toContain("const answer = runGameplayActionRef.current?.(");
    expect(committer).toContain("setFreeStationInFlight(marker);");
    expect(committer).toContain("const settlement = freeStationSettlement(settled);");
    expect(committer).toContain('if (settlement === "hold" && marker.kind === "home-station") return settled;');
  });

  it("only a refusal deletes the spent key (`dh-token`) -- an applied placement keeps it", () => {
    const refusedArm = committer.slice(committer.indexOf('if (settlement === "refused" && spentKey !== null) {'));
    expect(refusedArm).toContain("next.delete(spentKey);");
    expect(committer.indexOf("next.delete(spentKey);")).toBeGreaterThan(committer.indexOf('settlement === "refused"'));
  });

  it("the prompt's mount and the board's release are wired", () => {
    expect(sliceBetween(shell, "<HomeStationPrompt", "onPlace={handlePlaceHomeStation}")).toContain(
      "pending={homePromptPending(pendingHomeToken, homeStationPlacement !== null, freeStationInFlight)}",
    );
    expect(shell).toContain("if (inFlightReleasedByBoard(freeStationInFlight, pendingHomeToken)) setFreeStationInFlight(null);");
  });
});

describe("AUD-25.05: the held ghost goes with a refused lay", () => {
  const sent = { q: 3, r: 4, tileId: 57 };

  it("the ghost this lay committed is dropped at once (not on its 4 s clock)", () => {
    expect(ghostAfterRefusedLay({ ...sent, orientation: 0, committed: true }, sent)).toBeNull();
  });

  it("a preview the player opened since, or another lay's ghost, is theirs and stays", () => {
    const opened = { ...sent, orientation: 0 };
    expect(ghostAfterRefusedLay(opened, sent)).toBe(opened);
    const other = { q: 3, r: 4, tileId: 15, orientation: 0, committed: true };
    expect(ghostAfterRefusedLay(other, sent)).toBe(other);
    expect(ghostAfterRefusedLay(null, sent)).toBeNull();
  });

  it("only on a refusal: an applied lay leaves the ghost for the board to release", async () => {
    let ghost: { q: number; r: number; tileId: number; committed: boolean } | null = { ...sent, committed: true };
    await rollBackIfRefused(Promise.resolve(true), () => (ghost = ghostAfterRefusedLay(ghost, sent)));
    expect(ghost).not.toBeNull();
    await rollBackIfRefused(Promise.resolve(false), () => (ghost = ghostAfterRefusedLay(ghost, sent)));
    expect(ghost).toBeNull();
  });
});

describe("AUD-25.13 #8: a refused errand lay reopens its errand", () => {
  const errand = { kind: "private-tile" as const, companyId: PRR, q: 7, r: 2, hexLabel: "F16", abilityKey: "dh-tile", returnTab: "corps" };

  it("the errand the lay closed stands again, as it was armed (its own return tab)", () => {
    expect(errandAfterRefusedLay(errand, null, "Track", PRR)).toBe(errand);
  });

  it("not over an errand the player has armed since, and not past its step", () => {
    const since = { ...errand, abilityKey: "csl-tile", hexLabel: "B20" };
    expect(errandAfterRefusedLay(errand, since, "Track", PRR)).toBe(since);
    expect(errandAfterRefusedLay(errand, null, "Tokens", PRR)).toBeNull();
    expect(errandAfterRefusedLay(errand, null, null, PRR)).toBeNull();
  });

  it("(review) not for a corporation that is no longer the one acting -- the turn moved on", () => {
    expect(errandAfterRefusedLay(errand, null, "Track", NYC)).toBeNull();
  });

  it("a lay that closed no errand changes nothing", () => {
    expect(errandAfterRefusedLay(null, null, "Track", PRR)).toBeNull();
    expect(errandAfterRefusedLay(null, errand, "Track", PRR)).toBe(errand);
  });

  it("the map comes back only if the player is still on the tab the lay sent them to", () => {
    expect(tabAfterRefusedErrandLay("corps", errand, "map")).toBe("map");
    expect(tabAfterRefusedErrandLay("ledger", errand, "map")).toBe("ledger");
    expect(tabAfterRefusedErrandLay("corps", null, "map")).toBe("corps");
  });
});

describe("AUD-25.05 / AUD-25.13 #8: the shell's call sites (outside every RED region)", () => {
  const shell = readShell();

  it("the lay's rollback drops its ghost and reopens the errand it closed", () => {
    const rollback = sliceBetween(shell, "void rollBackIfRefused(layAnswer, () => {", "handleRingConfirmed();");
    expect(rollback).toContain("setPreviewTile((current) => ghostAfterRefusedLay(current, { q, r, tileId }));");
    expect(rollback).toContain("setHomeStationPlacement((current) => errandAfterRefusedLay(closedErrand, current, step, acting));");
    expect(rollback).toContain("const acting = actingProtocolIdRef.current;");
    expect(rollback).toContain('setActiveMainTab((tab) => tabAfterRefusedErrandLay(tab, closedErrand, "map"));');
    expect(rollback).toContain("const step = orSubPhaseRef.current;");
    // W3-C's two takebacks are kept.
    expect(rollback).toContain("next.delete(errandKey);");
    expect(rollback).toContain("if (spentAbility === JK_TILE_ABILITY_KEY) setJkLayArmed(true);");
  });

  it("the token confirm drops its picture, and a refused paid token puts the step and the targeting back", () => {
    const confirm = sliceBetween(shell, "const handleConfirmTokenPlacement = useCallback(", "const handleCancelTokenPlacement = useCallback(");
    expect(confirm).toContain("const dropPicture = () => setCommittedStation((current) => (current === committed ? null : current));");
    expect(confirm).toContain("void rollBackIfRefused(commitFreeStationPlacement({ q, r, cityIndex }), dropPicture);");
    const paid = confirm.slice(confirm.indexOf("void rollBackIfRefused(placed, () => {"));
    expect(paid).toContain("dropPicture();");
    expect(paid).toContain('setLiveOrSubPhase((current) => (current === "Routes" ? "Tokens" : current));');
    expect(paid).toContain("if (isMyTurnRef.current) setTokenTargetMode(true);");
  });

  it("End Turn's market lesson waits for the pass, and not for a refused one", () => {
    const endTurn = sliceBetween(shell, "const handleEndOperatingTurn = useCallback(", "}, [handlePassTurn, viewerAddress, gameState]);");
    expect(endTurn).toContain("const passed = handlePassTurn();");
    const lesson = endTurn.slice(endTurn.indexOf("void Promise.resolve(passed).then((answer) => {"));
    expect(lesson.indexOf("if (submissionRefused(answer)) return;")).toBeGreaterThan(-1);
    expect(lesson.indexOf("if (submissionRefused(answer)) return;")).toBeLessThan(lesson.indexOf("setMarketTutorialArmed(true);"));
    expect(lesson.indexOf("setMarketTutorialArmed(true);")).toBeGreaterThan(-1);
  });
});
