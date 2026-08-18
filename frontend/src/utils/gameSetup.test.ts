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
