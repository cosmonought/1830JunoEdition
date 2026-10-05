// frontend/src/components/phase3W3JRulesReferenceReservation.test.ts
//
// ==================================================================
//  PHASE 3 W3-J (AUD-25.02, MEDIUM): THE RULES REFERENCE NO LONGER CONTRADICTS THE PRIVATE-HEX AUTHORITY
// ==================================================================
//
// The Operating Round gotcha (and the Track watch line that quotes it) said "The CSL and DH exception hexes are not
// reserved: any corporation may tile them under the normal connection rules". The `LayTile` authority bars the C&SL's
// B20 while a player owns it (`privateHexRefusal`); only the D&H's F16 is excepted (#1694a). The line now quotes the
// page's own authoritative sentences verbatim. This file pins (1) the copy against its sources, and (2) every claim
// the copy makes against the engine authority itself, so a later change to either side breaks here.

import { readFileSync } from "fs";
import { join } from "path";

import { watchItemsFor } from "./RulesReference";
import { STATIC_BOARD_HEXES } from "./hexBoardData";
import { privateHexRefusal } from "../gameEngine/privateReservations";
import { CSL_PRIVATE_ID, DH_PRIVATE_ID } from "../gameEngine/dhPower";
import { sandboxGameState } from "../gameEngine/sandboxState";
import { RULES_ENGINE_VERSION } from "../gameEngine/rulesVersion";
import { resolveVariants } from "../gameEngine/gameVariants";
import { withRules } from "../gameEngine/boardSelection";
import type { GameStateResponse } from "../gameEngine/gameState";

const SOURCE = readFileSync(join(__dirname, "RulesReference.tsx"), "utf8");
const TRACK_RULE =
  "A corporation may not place a tile on a hex containing a Private Company owned by a player. A hex containing a closed Private Company or a Private Company owned by a corporation may be tiled.";
const DH_LAPSE = "If another corporation lays a tile on the DH starting hex under the ordinary rules, the DH special ability is no longer available.";
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

describe("W3-J AUD-25.02: the private-hex gotcha quotes the page's authoritative sentences", () => {
  it("no line on the page says the CSL / DH hexes are 'not reserved'", () => {
    expect(SOURCE).not.toMatch(/exception hexes are not reserved/);
    expect(privatesOn()).not.toMatch(/not reserved/);
  });

  it("the Track watch line is exactly the track step's private-hex rule plus the DH card's lapse sentence", () => {
    expect(privatesOn()).toBe(`${TRACK_RULE} ${DH_LAPSE}`);
  });

  it("each sentence is the page's own wording, not new copy: it exists outside the gotcha too", () => {
    // Once in the track step's detail (`p:`) and once in the gotcha that quotes it.
    expect(occurrences(TRACK_RULE)).toBe(2);
    // Once on the DH card's detail and once in the gotcha that quotes it.
    expect(occurrences(DH_LAPSE)).toBe(2);
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
});
