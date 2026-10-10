/** @jest-environment node */
// frontend/src/utils/roomDesign.test.ts -- PLAY HOST A GAME + WAITING ROOM (approved design, "play-host-waiting-handoff"):
// the pure parts -- the pace and bank lines, "How the clock works" word for word (§9.3), the sign's status, the tear,
// the status sentence and the blockers (§6), and the Keplr approval count of the one-button Ante (§7).

import { ANTE_STATUS } from "../money/moneyFlow";
import type { RoomMoneyView } from "./moneyProtocol";
import {
  anteFeeSentence,
  approvalOf,
  approvalStatus,
  bankText,
  clockRules,
  cutsFor,
  departureBlocker,
  feePercent,
  leadSentence,
  paceModeCell,
  paceText,
  paperOffset,
  passSeed,
  plannedApprovals,
  roomStatus,
  type LeadInput,
} from "./roomDesign";

describe("§5, §9: the pace and the bank, as the sign and the settings say them", () => {
  it("says Live, an Async pace, or no deadline", () => {
    expect(paceText({ mode: "live", deadline: "live", paceSecs: null })).toBe("Live · 20m per action");
    expect(paceText({ mode: "async", deadline: "async-pace", paceSecs: 172_800 })).toBe("Async · 2d per action");
    expect(paceText({ mode: "async", deadline: "async-pace", paceSecs: 86_400 })).toBe("Async · 24h per action");
    expect(paceText({ mode: "async", deadline: "no-deadline", paceSecs: null })).toBe("Async · no deadline");
    /* Not read yet: no guess. */
    expect(paceText({ mode: "async", deadline: null, paceSecs: null })).toBe("Async");
  });

  it("gives the preview row's Mode cell", () => {
    expect(paceModeCell({ mode: "live", deadline: "live", paceSecs: null })).toBe("Live");
    expect(paceModeCell({ mode: "async", deadline: "async-pace", paceSecs: 172_800 })).toBe("Async: 2d");
    expect(paceModeCell({ mode: "async", deadline: "no-deadline", paceSecs: null })).toBe("Async");
  });

  it("names the bank with its length", () => {
    expect(bankText("standard")).toBe("$12,000 (Standard)");
    expect(bankText("short")).toBe("$4,500 (Short)");
    expect(bankText("long")).toBe("$20,000 (Long)");
  });

  it("takes the fee from the deployment's basis points, never a constant", () => {
    expect(feePercent(250)).toBe("2.5%");
    expect(feePercent(100)).toBe("1%");
    expect(feePercent(null)).toBeNull();
    expect(anteFeeSentence("10000000", 250, 6, "JUNOX")).toBe("Each seat deposits 10 JUNOX; the 2.5% developer fee (0.25 JUNOX) isn't refunded.");
    expect(anteFeeSentence("2500000", 100, 6, "JUNOX")).toBe("Each seat deposits 2.5 JUNOX; the 1% developer fee (0.025 JUNOX) isn't refunded.");
    expect(anteFeeSentence("2500000", null, 6, "JUNOX")).toBe("Each seat deposits 2.5 JUNOX; the escrow's developer fee isn't refunded.");
  });
});

describe("§9.3: How the clock works, exactly as written", () => {
  it("Live", () => {
    expect(clockRules({ mode: "live", deadline: "live", paceSecs: null }, 250)).toEqual([
      "Live: 20:00 for each required action.",
      "A player who runs out is marked Overdue and has until 30:00 to make the move; play waits for it. If they don't make it, the game ends: their ante is forfeited if every other player has voted for that, and otherwise every ante is returned, less the 2.5% fee.",
      "A player may only be Overdue twice in a game. A third Overdue automatically ends the game and forfeits their ante, which is split among the other players.",
      "A trade offer that pauses its maker's clock (a train offer, for example) gives its recipient 10:00 to answer. Each required action gets at most 10:00 of paused time in total; after that, the maker's clock keeps running while the offer waits.",
    ]);
  });

  it("Async with a deadline (the bracketed value from the table)", () => {
    expect(clockRules({ mode: "async", deadline: "async-pace", paceSecs: 172_800 }, 250)).toEqual([
      "Async: 2 days for each required action.",
      "A player who runs out is marked Overdue. Nothing happens automatically: play isn't held up and no money moves.",
      'The other players may all agree to annul the game (every ante is returned, less the 2.5% fee) or to foreclose (the Overdue player\'s ante is forfeited and split among them). One "no" vote stops it, and making the move first ends the Overdue.',
      "There is no limit on Overdues in Async, and nothing ends the game automatically.",
      "A trade offer doesn't pause its maker's clock; the wait for an answer counts against the maker.",
    ]);
    for (const [secs, long] of [[43_200, "12 hours"], [86_400, "24 hours"], [259_200, "3 days"], [604_800, "7 days"]] as const) {
      expect(clockRules({ mode: "async", deadline: "async-pace", paceSecs: secs }, 250)[0]).toBe(`Async: ${long} for each required action.`);
    }
  });

  it("Async with no deadline", () => {
    expect(clockRules({ mode: "async", deadline: "no-deadline", paceSecs: null }, 250)).toEqual([
      "Async with no deadline: nothing is timed, and no player can ever become Overdue.",
      "The game ends when it is finished, or when every player agrees to annul it.",
      "If it doesn't finish and not every player agrees to annul it, the antes in escrow may stay locked indefinitely.",
    ]);
  });

  it("follows the deployment's fee", () => {
    expect(clockRules({ mode: "live", deadline: "live", paceSecs: null }, 100)[1]).toContain("less the 1% fee.");
    expect(clockRules({ mode: "live", deadline: "live", paceSecs: null }, null)[1]).toContain("less the escrow's fee.");
  });
});

describe("§5: the sign's status", () => {
  it("is Departing once started, Full when every seat is taken, Final call (exact only) with one left, else Boarding", () => {
    expect(roomStatus({ departing: true, seated: 1, cap: 4, exact: true })).toBe("departing");
    expect(roomStatus({ departing: false, seated: 4, cap: 4, exact: true })).toBe("full");
    expect(roomStatus({ departing: false, seated: 3, cap: 4, exact: true })).toBe("final-call");
    expect(roomStatus({ departing: false, seated: 6, cap: 7, exact: false })).toBe("boarding");
    expect(roomStatus({ departing: false, seated: 2, cap: 4, exact: true })).toBe("boarding");
  });
});

describe("§6: the paper and the tear", () => {
  it("seeds a pass's patch of paper from its seat, the same way every time, inside the 512px tile", () => {
    const seed = passSeed("p_abc|2");
    expect(passSeed("p_abc|2")).toBe(seed);
    expect(passSeed("p_abc|3")).not.toBe(seed);
    const { x, y } = paperOffset(seed);
    expect(x).toBeLessThanOrEqual(0);
    expect(x).toBeGreaterThan(-512);
    expect(y).toBeLessThanOrEqual(0);
    expect(y).toBeGreaterThan(-512);
  });

  it("cuts one ragged profile of 22 segments, up to 7px deep, into both pieces so the torn edges match", () => {
    const { main, stub } = cutsFor(passSeed("p_abc|2"));
    expect(cutsFor(passSeed("p_abc|2"))).toEqual({ main, stub });
    /* The interior points (the corners, at 0 and 100%, are the ends of the cut). */
    const mainJags = Array.from(main.matchAll(/calc\(100% - ([\d.]+)px\) ([\d.]+)%/g)).map((m) => [Number(m[1]), m[2]] as const).filter(([, y]) => y !== "100");
    const stubJags = Array.from(stub.matchAll(/([\d.]+)px ([\d.]+)%/g)).map((m) => [Number(m[1]), m[2]] as const).filter(([, y]) => y !== "100");
    /* 21 interior points on each edge, the stub's listed bottom-up */
    expect(mainJags).toHaveLength(21);
    expect(stubJags).toHaveLength(21);
    for (const [jag] of mainJags) {
      expect(jag).toBeGreaterThanOrEqual(0);
      expect(jag).toBeLessThanOrEqual(7);
    }
    /* The same profile, offset by the tear's width: the stub's x is 7 - the main's jag, at the same height. */
    const reversed = stubJags.slice().reverse();
    mainJags.forEach(([jag, y], i) => {
      expect(reversed[i][1]).toBe(y);
      expect(reversed[i][0]).toBeCloseTo(7 - jag, 1);
    });
  });
});

const VIEW = (over: { funded?: number; seats?: number; deadline?: number | null } = {}): RoomMoneyView =>
  ({
    deployment: { backend: "juno-cosmwasm", chainId: "uni-7", networkClass: "testnet", contract: "juno1x", codeChecksum: "x", denom: "ujunox", symbol: "JUNOX", exponent: 6 },
    terms: { anteGross: "10000000", feeBps: 250, anteNet: null, pot: null, mode: "live", seats: over.seats ?? 4, minAnte: null, rulesEngineVersion: null },
    escrow: { chainGameId: "7", state: "FUNDING", paused: false, fundingDeadline: over.deadline ?? null, observedAt: 1, fundedSeats: over.funded ?? 0, foreignSeats: 0, fullyFundedAt: null },
    seats: [],
    start: { state: "not-ready", blocker: null, anyoneMayStartAt: null, canStart: false, epoch: 0 },
    settlement: null,
    you: null,
    held: false,
  }) as RoomMoneyView;

describe("§6: the blocker sentences, in the design's wording", () => {
  it("waits for every seat (exact), or for two players (Any)", () => {
    expect(departureBlocker(VIEW(), "need-seats", 0, { exact: true, seated: 2, cap: 4 })).toBe("Waiting for every seat to be taken (4 players).");
    expect(departureBlocker(VIEW(), "need-seats", 0, { exact: false, seated: 1, cap: 7 })).toBe("Waiting for at least 2 players.");
  });

  it("says 'to ante', matching the button, and when funding closes", () => {
    expect(departureBlocker(VIEW({ funded: 2 }), "need-funding", 0, { exact: true, seated: 4, cap: 4 })).toBe("Waiting for 2 players to ante.");
    expect(departureBlocker(VIEW({ funded: 3 }), "need-funding", 0, { exact: true, seated: 4, cap: 4 })).toBe("Waiting for 1 player to ante.");
    expect(departureBlocker(VIEW({ funded: 1, deadline: Date.UTC(2026, 9, 10, 8, 53) }), "need-funding", Date.UTC(2026, 9, 10, 7, 0), { exact: true, seated: 4, cap: 4 })).toMatch(/^Waiting for 3 players to ante\. Funding closes at /);
  });

  it("keeps Play's own sentences for the other money states", () => {
    expect(departureBlocker(VIEW(), "paused", 0, { exact: true, seated: 4, cap: 4 })).toBe("Juno's escrow is paused right now; the table starts once it resumes.");
    expect(departureBlocker(VIEW(), "deposit-in-flight", 0, { exact: true, seated: 4, cap: 4 })).toBe("A deposit is on its way to Juno.");
    expect(departureBlocker(VIEW(), null, 0, { exact: true, seated: 4, cap: 4 })).toBeNull();
  });
});

describe("§6: the status sentence on your pass", () => {
  const base: LeadInput = { departing: false, isHost: false, hostName: "Marlowe", ante: "10 JUNOX", exact: true, seated: 4, approving: false, funding: "none", sending: false, escrowOpen: true, allIn: false, canStart: false, blocker: "Waiting for 2 players to ante.", special: null };
  it("reads the design's table, row by row", () => {
    expect(leadSentence({ ...base, isHost: true, escrowOpen: false })).toBe("Ante 10 JUNOX to open the table on Juno. The others ante once it's open.");
    expect(leadSentence({ ...base, escrowOpen: false })).toBe("Marlowe antes first, which opens the table on Juno. Your Ante button works once it's open.");
    expect(leadSentence(base)).toBe("Ante 10 JUNOX to board. Keplr asks you to approve each step; nothing moves until you do.");
    expect(leadSentence({ ...base, approving: true })).toBe("Keplr shows each step before anything moves. Approve it there.");
    expect(leadSentence({ ...base, funding: "sent" })).toBe("Your ante is on its way to Juno.");
    expect(leadSentence({ ...base, sending: true })).toBe("Your ante is on its way to Juno.");
    expect(leadSentence({ ...base, funding: "funded" })).toBe("You're on board. Waiting for 2 players to ante.");
    expect(leadSentence({ ...base, funding: "funded", allIn: true, blocker: null })).toBe("You're on board. Every seat has anted; waiting for the host to start the game…");
    expect(leadSentence({ ...base, funding: "funded", allIn: true, exact: false, blocker: null })).toBe("You're on board. Everyone seated has anted; waiting for the host to start the game…");
    expect(leadSentence({ ...base, isHost: true, funding: "funded", canStart: true })).toBe("Every seat has anted. Start locks the seats and deals the game.");
    expect(leadSentence({ ...base, isHost: true, funding: "funded", canStart: true, exact: false, seated: 3 })).toBe("Everyone seated has anted. Start deals the game for 3; open seats close.");
    expect(leadSentence({ ...base, isHost: true, funding: "funded" })).toBe("Waiting for 2 players to ante.");
    expect(leadSentence({ ...base, departing: true })).toBe("Departing.");
  });

  it("gives Play's own sentence for a state the design leaves to Play", () => {
    expect(leadSentence({ ...base, special: "This table's money is on hold for review." })).toBe("This table's money is on hold for review.");
  });
});

describe("§7: the one-button Ante's Keplr approvals", () => {
  it("plans connect, the free proof and the deposit for a first-time player; the deposit alone for a returning one", () => {
    expect(plannedApprovals({ connected: false, linked: false, proofRefused: false, isHost: false })).toEqual(["connect", "verify", "deposit"]);
    expect(plannedApprovals({ connected: true, linked: true, proofRefused: false, isHost: false })).toEqual(["deposit"]);
    expect(plannedApprovals({ connected: true, linked: true, proofRefused: true, isHost: false })).toEqual(["verify", "deposit"]);
    /* The host's CreateGame needs no fresh proof: the server never asks the host to re-prove. */
    expect(plannedApprovals({ connected: true, linked: true, proofRefused: true, isHost: true })).toEqual(["deposit"]);
  });

  it("names the approval Keplr is showing, counted against the plan", () => {
    const plan = plannedApprovals({ connected: false, linked: false, proofRefused: false, isHost: false });
    expect(approvalStatus(plan, [])).toBeNull();
    expect(approvalStatus(plan, ["connect"])).toBe("Check Keplr: connect your wallet (1 of 3).");
    expect(approvalStatus(plan, ["connect", "verify"])).toBe("Check Keplr: sign a free message proving the wallet is yours (2 of 3).");
    expect(approvalStatus(plan, ["connect", "verify", "deposit"])).toBe("Check Keplr: approve the deposit (3 of 3).");
    expect(approvalStatus(["deposit"], ["deposit"])).toBe("Check Keplr: approve the deposit (1 of 1).");
  });

  it("drops the count -- never shows a wrong one -- when an unplanned approval appears", () => {
    /* A returning player whose deposit the server refused for an old proof: the re-proof wasn't planned. */
    expect(approvalStatus(["deposit"], ["deposit", "verify"])).toBe("Check Keplr: sign a free message proving the wallet is yours.");
    expect(approvalStatus(["verify", "deposit"], ["deposit"])).toBe("Check Keplr: approve the deposit.");
  });

  it("reads which approval from the Ante's own status line", () => {
    expect(approvalOf(ANTE_STATUS.connecting)).toBe("connect");
    expect(approvalOf(ANTE_STATUS.verifying)).toBe("verify");
    expect(approvalOf(ANTE_STATUS.depositing)).toBe("deposit");
    expect(approvalOf(null)).toBeNull();
  });
});
