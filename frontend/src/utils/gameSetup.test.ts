// frontend/src/utils/gameSetup.test.ts
//
// ==================================================================
//  DESIGN NOTE 526 (harness): THE NUMBERS A PLAYER COUNT DECIDES
// ==================================================================
//
// Two printed 1830 tables and the function that deals from them. Worth
// testing properly because the failure is silent and permanent: a game dealt
// with four players' cash for five people is not obviously wrong on screen,
// and by the time anyone notices, every purchase since has been made against
// the wrong balance.
//
// THE DETERMINISM IS THE OTHER HALF. Every client replays the same setup
// action, so `dealSandboxGame` must be a pure function of its input -- if it
// reads a clock or a random source, two browsers deal different tables from
// one log entry and diverge on move one. The shuffle is deliberately NOT in
// it, and one test states that as a property rather than trusting the note.

import type { GameStateResponse } from "./gameState";
import {
  BANK_START,
  CERT_LIMIT_BY_PLAYER_COUNT,
  MAX_PLAYERS,
  MIN_PLAYERS,
  STARTING_CASH_BY_PLAYER_COUNT,
  certLimitForPlayers,
  dealSandboxGame,
  isLegalPlayerCount,
  shuffleForTurnOrder,
  withEmptyRoster,
  startingCashForPlayers,
  type SetupPlayer,
} from "./gameSetup";

function players(count: number): SetupPlayer[] {
  return Array.from({ length: count }, (_, i) => ({ id: `p${i}`, nickname: `Player ${i}` }));
}

describe("the printed tables", () => {
  it("carries the real 1830 certificate limits", () => {
    // Straight from the rulebook's setup chart.
    expect(CERT_LIMIT_BY_PLAYER_COUNT).toEqual({ 2: 28, 3: 20, 4: 16, 5: 13, 6: 11 });
  });

  it("carries the real 1830 starting cash", () => {
    expect(STARTING_CASH_BY_PLAYER_COUNT).toEqual({ 2: 1200, 3: 800, 4: 600, 5: 480, 6: 400 });
  });

  it("covers exactly the counts 1830 defines", () => {
    for (let n = MIN_PLAYERS; n <= MAX_PLAYERS; n += 1) {
      expect(certLimitForPlayers(n)).not.toBeNull();
      expect(startingCashForPlayers(n)).not.toBeNull();
    }
    // And says so honestly outside them, rather than extrapolating.
    for (const n of [0, 1, 7, 12]) {
      expect(certLimitForPlayers(n)).toBeNull();
      expect(startingCashForPlayers(n)).toBeNull();
      expect(isLegalPlayerCount(n)).toBe(false);
    }
  });

  it("keeps the bank fixed regardless of headcount", () => {
    /* 1830's bank is $12,000 whoever is playing -- the count changes what is
       dealt OUT of it. A bank that scaled per player would make a six-hander
       a different game from the one in the box. */
    expect(BANK_START).toBe(12000);
  });
});

describe("dealSandboxGame", () => {
  it("deals every player the same starting cash for the count", () => {
    const dealt = dealSandboxGame({ players: players(4) });
    expect(dealt).not.toBeNull();
    expect(dealt!.startingCash).toBe(600);
    expect(dealt!.playerCash).toHaveLength(4);
    for (const row of dealt!.playerCash) expect(row.cash_vgp).toBe("600");
  });

  it("applies the certificate limit for the count", () => {
    expect(dealSandboxGame({ players: players(3) })!.certLimit).toBe(20);
    expect(dealSandboxGame({ players: players(6) })!.certLimit).toBe(11);
  });

  it("takes the players' cash OUT of the bank", () => {
    // Four at $600 is $2,400 of the $12,000.
    expect(dealSandboxGame({ players: players(4) })!.bankRemaining).toBe(12000 - 2400);
    expect(dealSandboxGame({ players: players(2) })!.bankRemaining).toBe(12000 - 2400);
  });

  it("preserves the order it was given", () => {
    /* Design note #526a: the shuffle happened on the host and travels in the
       payload. Re-ordering here would give every client a different table
       from the same log entry. */
    const roster = players(5);
    const dealt = dealSandboxGame({ players: roster });
    expect(dealt!.playerAddresses).toEqual(roster.map((p) => p.id));
  });

  it("refuses a count 1830 does not define", () => {
    /* A game that cannot be dealt correctly must not be dealt
       approximately -- one player, or seven, has no printed cash figure and
       inventing one would produce a game nobody can check. */
    expect(dealSandboxGame({ players: players(1) })).toBeNull();
    expect(dealSandboxGame({ players: players(7) })).toBeNull();
    expect(dealSandboxGame({ players: [] })).toBeNull();
  });

  it("is deterministic — the same input deals the same table twice", () => {
    /* THE PROPERTY THE WHOLE DESIGN RESTS ON. Every client runs this on the
       same action; if it varied, two browsers would diverge on move one. */
    const roster = players(4);
    expect(dealSandboxGame({ players: roster })).toEqual(dealSandboxGame({ players: roster }));
  });

  it("does not shuffle", () => {
    /* Stated as its own test because it is the one way this function could
       break determinism while passing everything above -- a shuffle inside
       it would still deal correct CASH, just to the wrong seats, and only
       across clients. */
    const roster = players(6);
    const runs = Array.from({ length: 12 }, () => dealSandboxGame({ players: roster })!.playerAddresses);
    for (const run of runs) expect(run).toEqual(roster.map((p) => p.id));
  });
});

describe("shuffleForTurnOrder", () => {
  it("keeps everybody, exactly once", () => {
    const roster = players(5);
    const shuffled = shuffleForTurnOrder(roster);
    expect(shuffled).toHaveLength(5);
    expect(new Set(shuffled.map((p) => p.id))).toEqual(new Set(roster.map((p) => p.id)));
  });

  it("does not mutate its input", () => {
    // The caller still holds the roster it is about to publish.
    const roster = players(5);
    const before = roster.map((p) => p.id);
    shuffleForTurnOrder(roster);
    expect(roster.map((p) => p.id)).toEqual(before);
  });

  it("actually varies the order", () => {
    /* A "shuffle" that returned its input would give the host seat one every
       game and nobody would notice for a while. Six players over 40 runs
       leaves a vanishing chance of a false failure. */
    const roster = players(6);
    const seen = new Set(
      Array.from({ length: 40 }, () => shuffleForTurnOrder(roster).map((p) => p.id).join(",")),
    );
    expect(seen.size).toBeGreaterThan(1);
  });
});

/* ==================================================================
 *  DESIGN NOTE 538 (harness): AN EMPTY TABLE CANNOT LOOK CORRECT
 * ==================================================================
 *
 * Three passes tried to make the setup event OVERWRITE the fixture's four
 * mock players, and the roster kept coming back. The lesson is not about any
 * one of those bugs -- it is that "overwrite the wrong value" fails silently
 * whenever the overwrite does not happen, and every failure looked like a
 * plausible four-player game.
 *
 * `withEmptyRoster` inverts that. A room boots with NO players, so the same
 * failures now show zero rows instead of four strangers. These tests pin the
 * inversion, because it is the property that makes the next regression
 * visible rather than the one that prevents it.
 */
function boardWithFourMocks(): GameStateResponse {
  return {
    player_addresses: ["a", "b", "c", "d"],
    player_cash: [
      { player: "a", cash_vgp: "400" },
      { player: "b", cash_vgp: "400" },
      { player: "c", cash_vgp: "400" },
      { player: "d", cash_vgp: "400" },
    ],
    max_players: 4,
    active_player_index: 2,
    priority_deal_index: 3,
    public_companies: [
      { company_id: 1, ticker: "PRR", president: "a", player_holdings: [{ player: "a", percentage: 20 }], is_floated: true },
      { company_id: 2, ticker: "NYC", president: "b", player_holdings: [], is_floated: false },
    ],
    private_companies: [{ private_id: 1, owner: "c", owner_protocol_id: null }],
  } as unknown as GameStateResponse;
}

describe("withEmptyRoster", () => {
  it("leaves no players at all", () => {
    // THE INVARIANT. Not "fewer players", not "the right players" -- none.
    const empty = withEmptyRoster(boardWithFourMocks());
    expect(empty.player_addresses).toEqual([]);
    expect(empty.player_cash).toEqual([]);
    expect(empty.max_players).toBe(0);
  });

  it("cuts every link from the board to a player", () => {
    /* A corporation presided over by somebody who is not in the game is a
       corporation nobody can act for -- every `canAct` compares a president
       against the viewer and none of them would ever match. */
    const empty = withEmptyRoster(boardWithFourMocks());
    for (const company of empty.public_companies) {
      expect(company.president).toBeNull();
      expect(company.player_holdings).toEqual([]);
      expect(company.is_floated).toBe(false);
    }
    for (const entry of empty.private_companies) {
      expect(entry.owner).toBeNull();
    }
  });

  it("keeps the board itself", () => {
    // Corporations, privates and the map are what a room plays WITH -- only
    // the links to absent players are cut.
    const empty = withEmptyRoster(boardWithFourMocks());
    expect(empty.public_companies).toHaveLength(2);
    expect(empty.public_companies[0].ticker).toBe("PRR");
    expect(empty.private_companies).toHaveLength(1);
  });

  it("returns NEW arrays, not the originals", () => {
    /* React compares by identity. A reducer handing back the same array is a
       re-render that never happens -- which is the half of this bug that
       looks like the overwrite failing when it actually succeeded. */
    const before = boardWithFourMocks();
    const empty = withEmptyRoster(before);
    expect(empty).not.toBe(before);
    expect(empty.player_addresses).not.toBe(before.player_addresses);
    expect(empty.public_companies).not.toBe(before.public_companies);
  });

  it("does not mutate the board it was given", () => {
    const before = boardWithFourMocks();
    withEmptyRoster(before);
    expect(before.player_addresses).toHaveLength(4);
    expect(before.public_companies[0].president).toBe("a");
  });

  it("deals cleanly on top of an emptied board", () => {
    /* The sequence a room actually runs: boot empty, then `SetupGame`. The
       dealt roster must be exactly the payload, with nothing left over. */
    const empty = withEmptyRoster(boardWithFourMocks());
    expect(empty.player_addresses).toHaveLength(0);
    const dealt = dealSandboxGame({
      players: [
        { id: "p-real1", nickname: "Ada" },
        { id: "p-real2", nickname: "Grace" },
      ],
    });
    expect(dealt!.playerAddresses).toEqual(["p-real1", "p-real2"]);
    expect(dealt!.playerAddresses).toHaveLength(2);
  });
});
