// frontend/src/utils/oneSandbox.test.ts
//
// ==================================================================
//  DESIGN NOTE 578 (harness): THE SECOND PATH MUST NOT COME BACK
// ==================================================================
//
// The consolidation removed a whole mode: no hotseat, no mock roster, no
// seat switcher, no solo board. What made it worth doing was not the line
// count -- it was that almost every desync this project has reported was
// "the solo path and the room path disagree about something":
//
//   #534  who "you" are differed between them
//   #536  a room is not a hotseat, so the turn gate applies
//   #538  a room must not load the fixture's four mock players
//   #542  ...and neither must the auction's separate atom
//   #574  an Operating Round shortcut written for solo, silently skipping
//         a step in a real game
//
// A deleted branch cannot be re-added by accident, but it CAN be re-added on
// purpose by a future reader who finds solo mode convenient and does not
// know what it cost. These tests are the note that argues back: they pin the
// invariants that only hold because there is one path, so reintroducing the
// second one fails here rather than in somebody's game three rounds in.

import { SEAT_COLORS, sandboxPlayerLabel, setRoomColors, setRoomNicknames } from "./playerLabels";
import { SANDBOX_PLAYERS } from "./sandboxState";
import { withEmptyRoster } from "./gameSetup";
import type { GameStateResponse } from "./gameState";

afterEach(() => setRoomColors({}));

describe("the fixture roster never reaches a player", () => {
  it("refuses to name a room id from the fixture table", () => {
    /* Design note #537b: once a roster exists the fixture is unreachable. A
       player mislabelled "Alice" is far worse than one labelled with a raw
       id, because it looks correct -- and it would be a name belonging to
       somebody not in the game, on a surface whose whole job is saying who
       is. */
    setRoomNicknames({ "p-ada": "Ada" });
    expect(sandboxPlayerLabel("p-ada")).toBe("Ada");
    expect(sandboxPlayerLabel("p-unknown")).toBeNull();
    for (const mock of SANDBOX_PLAYERS) {
      expect(sandboxPlayerLabel(mock)).toBeNull();
    }
  });

  it("strips the fixture's players, cash and ownership from a booted board", () => {
    /* Design note #538: a room's roster is not "the fixture, corrected" --
       it is "nothing, until the log says otherwise". Every sandbox session
       is a room now, so this runs every time rather than on one branch. */
    const fixture = {
      player_addresses: [...SANDBOX_PLAYERS],
      player_cash: SANDBOX_PLAYERS.map((p) => ({ player: p, cash_vgp: "600" })),
      max_players: 4,
      public_companies: [
        {
          company_id: 1,
          ticker: "PRR",
          president: SANDBOX_PLAYERS[0],
          is_floated: true,
          par_value: "100",
          ipo_pool_percentage: 40,
          bank_pool_percentage: 30,
          treasury: "820",
          player_holdings: [{ player: SANDBOX_PLAYERS[0], percentage: 60 }],
        },
      ],
      private_companies: [{ private_id: 1, owner: SANDBOX_PLAYERS[1], closed: false }],
    } as unknown as GameStateResponse;

    const booted = withEmptyRoster(fixture);
    expect(booted.player_addresses).toEqual([]);
    /* Design note #594: and everything a PLAYED GAME wrote. `par_value` was
       the one that got away -- it looks like a printed property and is not,
       so a room booted with eight already-started corporations and the first
       founding purchase silently became an ordinary buy. */
    expect(booted.public_companies[0].par_value).toBeNull();
    expect(booted.public_companies[0].ipo_pool_percentage).toBe(100);
    expect(booted.public_companies[0].bank_pool_percentage).toBe(0);
    expect(booted.public_companies[0].treasury).toBe("0");
    expect(booted.player_cash).toEqual([]);
    expect(booted.max_players).toBe(0);
    expect(booted.public_companies[0].president).toBeNull();
    expect(booted.public_companies[0].player_holdings).toEqual([]);
    expect(booted.public_companies[0].is_floated).toBe(false);
    expect(booted.private_companies[0].owner).toBeNull();
  });

  it("does not mutate the fixture it strips", () => {
    /* The fixture is module state shared by every boot. Mutating it would
       make the SECOND room in a session start from the first one's leavings
       -- a bug that cannot be reproduced without playing two games. */
    const fixture = {
      player_addresses: [...SANDBOX_PLAYERS],
      player_cash: [],
      public_companies: [],
      private_companies: [],
    } as unknown as GameStateResponse;
    withEmptyRoster(fixture);
    expect(fixture.player_addresses).toEqual([...SANDBOX_PLAYERS]);
  });
});

describe("one seat, one colour, no mock identities", () => {
  it("seats six players without a repeat", () => {
    /* The colours now stripe the action bar (design note #570), so a repeat
       is not cosmetic -- it is two players who cannot tell whose turn it is
       from the cue that exists to tell them. */
    expect(new Set(SEAT_COLORS).size).toBe(SEAT_COLORS.length);
    expect(SEAT_COLORS.length).toBeGreaterThanOrEqual(6);
  });

  it("keeps the fixture's four mocks out of the seat registry", () => {
    // Nothing should ever assign a colour to a mock: they are never seated.
    setRoomColors({ "p-ada": SEAT_COLORS[0] });
    for (const mock of SANDBOX_PLAYERS) {
      expect(sandboxPlayerLabel(mock)).toBeNull();
    }
  });
});
