// frontend/src/components/phase3W3JRulesReferenceReservation.test.ts
//
// ==================================================================
//  PHASE 3 W3-J (AUD-25.02, MEDIUM): THE RULES REFERENCE NO LONGER CONTRADICTS THE PRIVATE-HEX AUTHORITY
// ==================================================================
//
// The Operating Round gotcha (and the Track watch line that quotes it) said "The CSL and DH exception hexes are not
// reserved: any corporation may tile them under the normal connection rules". The `LayTile` authority bars the C&SL's
// B20 while a player owns it (`privateHexRefusal`); only the D&H's F16 is excepted (#1694a). W3-J quoted the page's
// general track rule plus the DH card's lapse sentence; read literally, the general rule still barred F16 under a
// player-owned D&H. The consolidated integration (owner-approved COPY-ONLY correction, 2026-10-05) tells the two hexes
// apart. This file pins (1) the copy -- B20 follows the rule, F16 is the one exception -- and (2) every claim the copy
// makes against the engine authority itself, so a later change to either side breaks here. No engine change.

import { readFileSync } from "fs";
import { join } from "path";

import { watchItemsFor } from "./RulesReference";
import { STATIC_BOARD_HEXES } from "./hexBoardData";
import { privateHexRefusal } from "../gameEngine/privateReservations";
import { CSL_PRIVATE_ID, DH_PRIVATE_ID, dhPowerState } from "../gameEngine/dhPower";
import { cslBonusEntitlement } from "../gameEngine/privateLayClaim";
import { sandboxGameState } from "../gameEngine/sandboxState";
import { RULES_ENGINE_VERSION } from "../gameEngine/rulesVersion";
import { resolveVariants } from "../gameEngine/gameVariants";
import { withRules } from "../gameEngine/boardSelection";
import type { GameStateResponse } from "../gameEngine/gameState";

const SOURCE = readFileSync(join(__dirname, "RulesReference.tsx"), "utf8");
const TRACK_RULE =
  "A corporation may not place a tile on a hex containing a Private Company owned by a player. A hex containing a closed Private Company or a Private Company owned by a corporation may be tiled.";
const DH_LAPSE = "If another corporation lays a tile on the DH starting hex under the ordinary rules, the DH special ability is no longer available.";
/** The gotcha after the consolidated integration's copy-only correction: B-20 follows the rule, F-16 is the exception. */
const GOTCHA =
  "A corporation may not place a tile on a hex containing a Private Company owned by a player; once a corporation owns that Private Company, or it closes, the hex may be tiled. The CSL hex (B-20) follows that rule: no corporation may tile it while a player owns the CSL, and the corporation that owns the CSL may make its extra CSL tile lay there. The DH starting hex (F-16) is the one exception: any corporation may tile it under the ordinary rules even while a player owns the DH. If another corporation does, the DH special ability is no longer available; until then, the corporation that owns the DH keeps its special DH placement there.";
const STANDARD = resolveVariants({});

const occurrences = (needle: string) => SOURCE.split(needle).length - 1;

function privatesOn(): string {
  const item = watchItemsFor("or:Track").find((entry) => entry.label === "Privates on the map");
  if (!item) throw new Error("the Track watch line 'Privates on the map' is missing");
  return item.text;
}

type Owner = "player" | "corporation" | "closed";
function boardWith(privateId: number, owner: Owner): GameStateResponse {
  const base = sandboxGameState("OperatingRound", 1);
  return {
    ...base,
    variants: STANDARD,
    rules_engine_version: RULES_ENGINE_VERSION,
    player_addresses: ["p-alice", "p-bob"],
    private_companies: base.private_companies.map((entry) => {
      if (entry.private_id !== privateId) return { ...entry, owner: null, owner_protocol_id: null, closed: false };
      if (owner === "player") return { ...entry, owner: "p-alice", owner_protocol_id: null, closed: false };
      if (owner === "corporation") return { ...entry, owner: null, owner_protocol_id: 1, closed: false };
      return { ...entry, owner: "p-alice", owner_protocol_id: null, closed: true };
    }),
  } as GameStateResponse;
}
function hexOf(label: string): { q: number; r: number } {
  const hex = withRules(STANDARD, () => STATIC_BOARD_HEXES.find((entry) => entry.label === label));
  if (!hex) throw new Error(`no ${label}`);
  return { q: hex.q, r: hex.r };
}
const refusalAt = (state: GameStateResponse, label: string) =>
  withRules(STANDARD, () => privateHexRefusal(state, hexOf(label).q, hexOf(label).r));

describe("AUD-25.02: the private-hex gotcha tells the CSL's B-20 and the DH's F-16 apart", () => {
  it("no line on the page says the CSL / DH hexes are 'not reserved'", () => {
    expect(SOURCE).not.toMatch(/exception hexes are not reserved/);
    expect(privatesOn()).not.toMatch(/not reserved/);
  });

  it("the Track watch line is the corrected gotcha", () => {
    expect(privatesOn()).toBe(GOTCHA);
  });

  it("B-20 is named under the player-owned rule and F-16 as its one exception -- the general rule alone is not the whole line", () => {
    /* The literal reading W3-J's quotation allowed: the general rule, followed by nothing that excepts F-16. */
    expect(privatesOn()).not.toBe(`${TRACK_RULE} ${DH_LAPSE}`);
    expect(GOTCHA).toContain("The CSL hex (B-20) follows that rule: no corporation may tile it while a player owns the CSL");
    expect(GOTCHA).toContain("The DH starting hex (F-16) is the one exception: any corporation may tile it under the ordinary rules even while a player owns the DH.");
    expect(GOTCHA).toContain("If another corporation does, the DH special ability is no longer available");
  });

  it("the page's own source sentences are unchanged: the track step's general rule and the DH card's lapse sentence", () => {
    // Copy-only and local to the gotcha: the track step and the DH card keep their wording, each once.
    expect(occurrences(TRACK_RULE)).toBe(1);
    expect(occurrences(DH_LAPSE)).toBe(1);
  });
});

describe("W3-J AUD-25.02: every claim the copy makes is the engine authority's answer", () => {
  it("'may not place a tile on a hex containing a Private Company owned by a player' -- the C&SL's B20 is barred", () => {
    expect(refusalAt(boardWith(CSL_PRIVATE_ID, "player"), "B20")).toMatch(/B20/);
  });

  it("'a closed Private Company or a Private Company owned by a corporation may be tiled' -- B20 opens", () => {
    expect(refusalAt(boardWith(CSL_PRIVATE_ID, "corporation"), "B20")).toBeNull();
    expect(refusalAt(boardWith(CSL_PRIVATE_ID, "closed"), "B20")).toBeNull();
  });

  it("'if another corporation lays a tile on the DH starting hex under the ordinary rules' -- F16 is open while a player owns the D&H", () => {
    // #1694a: the one exception -- the authority never bars F16; laying there ends the D&H's special power.
    expect(refusalAt(boardWith(DH_PRIVATE_ID, "player"), "F16")).toBeNull();
    expect(refusalAt(boardWith(DH_PRIVATE_ID, "corporation"), "F16")).toBeNull();
  });

  it("'the corporation that owns the CSL may make its extra CSL tile lay there' -- the owning corporation's bonus, and only its", () => {
    const owned = boardWith(CSL_PRIVATE_ID, "corporation"); // owner_protocol_id 1
    expect(cslBonusEntitlement(owned, 1)).toBe(true);
    expect(cslBonusEntitlement(owned, 2)).toBe(false);
    expect(cslBonusEntitlement(boardWith(CSL_PRIVATE_ID, "player"), 1)).toBe(false);
  });

  it("'the DH special ability is no longer available' once another corporation tiles F16; 'until then' the owner keeps it", () => {
    expect(dhPowerState({ hexBuilt: true, layUsed: false, tokenUsed: false }).forfeited).toBe(true);
    expect(dhPowerState({ hexBuilt: false, layUsed: false, tokenUsed: false }).layAvailable).toBe(true);
  });
});
