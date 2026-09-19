/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 1451 (harness): THE RUNNING ORDER IS THE PART WITH LOGIC
// ==================================================================
//
// FOUR TRANSACTIONS, TWO OF WHICH HAVE TWO STEPS, and the difference between them is a procedure rather than
// a preference:
//
//   A BUY PAYS THEN IS CROWNED. The purchase causes the takeover, so the crown must not move first.
//   A SALE IS UNCROWNED THEN DELIVERS. The president gives up the certificate as part of the sale.
//
// THE PAIR ADVANCES AND THE CARD DOES NOT. That is what these cases actually assert: every stage names two
// entities, a takeover's three parties are never all named at once, and the sequence is one continuous
// window rather than two that could be mistaken for two transactions.
//
// AND THE WHOLE OWNERSHIP LAGS, NOT JUST THE CROWN (#1452). The `applications` list below is what says WHEN
// the visible figures advance from `before` toward `after`; the stage list says what is moving while they do.
// The two are close together and deliberately not the same instant -- a transfer's figures land
// three-quarters of the way through its own stage, on the merge, so the certificate is what reveals them.

export {};

const {
  buildFocusSequence,
  isStageParticipant,
  FOCUS_RELEASE_MS,
  HANDOVER_AT_MS,
  PRESIDENCY_MS,
  STOCK_TRANSFER_CSS,
  TRANSFER_MS,
  TRANSFER_RESOLVE_AT_MS,
} = require("./stockTransferFocus") as typeof import("./stockTransferFocus");
const { readStripped, sliceBetween } =
  require("../utils/sourceScan") as typeof import("../utils/sourceScan");

const ALICE = "juno1alice";
const BOB = "juno1bob";

const snap = (president: string | null, holdings: Record<string, number>, bank = 20) => ({
  ipo_pool_percentage: 10,
  bank_pool_percentage: bank,
  player_holdings: Object.keys(holdings).map((player) => ({ player, percentage: holdings[player] })),
  president,
});

const ordinary = {
  companyId: 1,
  ticker: "PRR",
  kind: "buy" as const,
  transfer: { from: "Bank", to: ALICE, percentage: 30 },
  presidency: null,
  before: snap(ALICE, { [ALICE]: 40 }, 50),
  after: snap(ALICE, { [ALICE]: 70 }, 20),
};
const takeoverBuy = {
  ...ordinary,
  transfer: { from: "Bank", to: BOB, percentage: 20 },
  presidency: { from: ALICE, to: BOB },
  before: snap(ALICE, { [ALICE]: 40, [BOB]: 30 }, 20),
  after: snap(BOB, { [ALICE]: 40, [BOB]: 50 }, 0),
};
const takeoverSell = {
  ...takeoverBuy,
  kind: "sell" as const,
  transfer: { from: ALICE, to: "Bank", percentage: 20 },
  before: snap(ALICE, { [ALICE]: 40, [BOB]: 30 }, 0),
  after: snap(BOB, { [ALICE]: 20, [BOB]: 30 }, 20),
};

const kinds = (transaction: Parameters<typeof buildFocusSequence>[0]) =>
  (buildFocusSequence(transaction)?.stages ?? []).map((stage) => stage.kind);

describe("an ordinary transfer", () => {
  it("is one stage between the two entities, inside the timing band", () => {
    const sequence = buildFocusSequence(ordinary);
    expect(kinds(ordinary)).toEqual(["transfer"]);
    expect(sequence?.stages[0]).toMatchObject({ from: "Bank", to: ALICE, percentage: 30, at: 0 });
    /* "roughly within the previously discussed 200-400 ms range", release included. */
    expect(sequence?.totalMs).toBe(TRANSFER_MS + FOCUS_RELEASE_MS);
    expect(sequence?.totalMs).toBeGreaterThanOrEqual(200);
    expect(sequence?.totalMs).toBeLessThanOrEqual(400);
  });

  it("carries ONE grouped percentage, whatever the certificate count", () => {
    /* Three ordinary shares are one 30% stage, not three 10% ones. */
    expect(buildFocusSequence(ordinary)?.stages.length).toBe(1);
    expect(buildFocusSequence(ordinary)?.stages[0].percentage).toBe(30);
  });

  it("shows nothing at all when nothing moved", () => {
    expect(buildFocusSequence(null)).toBeNull();
    expect(buildFocusSequence({ ...ordinary, transfer: null, presidency: null })).toBeNull();
  });
});

describe("a buy that takes the presidency", () => {
  it("pays first and is crowned second", () => {
    expect(kinds(takeoverBuy)).toEqual(["transfer", "crown-out", "exchange", "handover"]);
  });

  it("emphasises the source and the buyer, THEN the two presidents -- never all three", () => {
    const sequence = buildFocusSequence(takeoverBuy);
    const [purchase, ...handoff] = sequence!.stages;
    expect([purchase.from, purchase.to]).toEqual(["Bank", BOB]);
    handoff.forEach((stage) => expect([stage.from, stage.to]).toEqual([ALICE, BOB]));
    /* The displaced president is not lit while the purchase runs, and the pool is not lit while the crown
       moves. That is the whole of "do not show all three entities at equal emphasis". */
    expect(isStageParticipant(purchase, ALICE)).toBe(false);
    expect(isStageParticipant(handoff[0], "Bank")).toBe(false);
  });

  it("runs as one unbroken window", () => {
    const sequence = buildFocusSequence(takeoverBuy)!;
    /* No gap anywhere: each stage starts at or before the previous one ends, so the card is never holding a
       border over nothing -- which is what would make two steps read as two transactions. */
    sequence.stages.forEach((stage, index) => {
      if (index === 0) return;
      const previous = sequence.stages[index - 1];
      expect(stage.at).toBeLessThanOrEqual(previous.at + previous.durationMs);
    });
    expect(sequence.totalMs).toBe(TRANSFER_MS + PRESIDENCY_MS + FOCUS_RELEASE_MS);
  });
});

describe("a sale that loses the presidency", () => {
  it("is uncrowned first and delivers second", () => {
    expect(kinds(takeoverSell)).toEqual(["crown-out", "exchange", "handover", "transfer"]);
  });

  it("puts the shares into the Bank Pool only after the crown has changed hands", () => {
    const sequence = buildFocusSequence(takeoverSell)!;
    const sale = sequence.stages[sequence.stages.length - 1];
    const handover = sequence.stages[2];
    expect(sale.kind).toBe("transfer");
    expect([sale.from, sale.to]).toEqual([ALICE, "Bank"]);
    expect(sale.at).toBeGreaterThanOrEqual(handover.at);
  });

  it("takes the same total as the buy -- the order differs, the length does not", () => {
    expect(buildFocusSequence(takeoverSell)?.totalMs).toBe(buildFocusSequence(takeoverBuy)?.totalMs);
  });
});

describe("the beats at which the visible figures advance (design note #1452)", () => {
  const applied = (transaction: Parameters<typeof buildFocusSequence>[0]) =>
    (buildFocusSequence(transaction)?.applications ?? []).map(
      (entry) => `${entry.applies.join("+")}@${entry.at}`,
    );

  it("changes an ordinary transfer's figures on the merge, not on departure and not after", () => {
    /* "Do not show the destination's final holding before the transfer reaches it." The proxy sets off at 0
       and is gone at TRANSFER_MS; the figures move between the two, while the chip is contracting into the
       cell it lands on. */
    expect(applied(ordinary)).toEqual([`transfer@${TRANSFER_RESOLVE_AT_MS}`]);
    expect(TRANSFER_RESOLVE_AT_MS).toBeGreaterThan(0);
    expect(TRANSFER_RESOLVE_AT_MS).toBeLessThan(TRANSFER_MS);
  });

  it("applies a buy takeover's PURCHASE first and its CROWN second", () => {
    expect(applied(takeoverBuy)).toEqual([
      `transfer@${TRANSFER_RESOLVE_AT_MS}`,
      `presidency@${TRANSFER_MS + HANDOVER_AT_MS}`,
    ]);
  });

  it("applies a sell takeover's CROWN first and its SALE second", () => {
    expect(applied(takeoverSell)).toEqual([
      `presidency@${HANDOVER_AT_MS}`,
      `transfer@${PRESIDENCY_MS + TRANSFER_RESOLVE_AT_MS}`,
    ]);
  });

  it("lands the crown exactly on the handover beat, where the rows move and it is drawn", () => {
    const sequence = buildFocusSequence(takeoverSell)!;
    const handover = sequence.stages.find((entry) => entry.kind === "handover")!;
    const crown = sequence.applications.find((entry) => entry.applies.includes("presidency"))!;
    expect(crown.at).toBe(handover.at);
  });

  it("brings a corporation's FIRST president in with the shares, on one beat (design note #1453)", () => {
    /* `null -> ALICE` is a par purchase, not a duel: there is no outgoing president to uncrown and nothing to
       exchange. But the crown must still arrive WHEN THE CERTIFICATE DOES, or the card holds
       `president: null` for the whole transfer and snaps at release -- and `certificateCardsInPool` reads
       that field, so the President's Certificate would be drawn as still sitting in the IPO while the
       purchase that bought it has already resolved. */
    const firstPresident = {
      companyId: 1,
      ticker: "PRR",
      kind: "buy" as const,
      transfer: { from: "Ipo", to: ALICE, percentage: 20 },
      presidency: null,
      before: { ...snap(null, {}, 0), ipo_pool_percentage: 100 },
      after: { ...snap(ALICE, { [ALICE]: 20 }, 0), ipo_pool_percentage: 80 },
    };
    /* ONE application carrying BOTH fields -- not two at the same instant, which would be two renders with a
       paintable frame between them. */
    expect(applied(firstPresident)).toEqual([`transfer+presidency@${TRANSFER_RESOLVE_AT_MS}`]);
    /* And NO exchange animation: one stage, so `handoverIndex` is -1 and the panel plays no crown-out. */
    expect(kinds(firstPresident)).toEqual(["transfer"]);
  });

  it("does not move the crown on an ordinary trade that leaves the presidency alone", () => {
    /* The same branch, with the president unchanged: only the transfer advances. `before.president ===
       after.president` is the whole test, and it is a comparison of two authoritative values rather than a
       question about who should preside. */
    expect(applied(ordinary)).toEqual([`transfer@${TRANSFER_RESOLVE_AT_MS}`]);
  });

  it("names where the crown lands for BOTH procedures, and nowhere when it does not move", () => {
    /* #1455: `presidency` is the two-player exchange and is null for a first president -- so the ARRIVAL,
       which both procedures share, needs its own name or the card cannot draw the second without the
       first. */
    const firstPresident = {
      companyId: 1,
      ticker: "PRR",
      kind: "buy" as const,
      transfer: { from: "Ipo", to: ALICE, percentage: 20 },
      presidency: null,
      before: { ...snap(null, {}, 0), ipo_pool_percentage: 100 },
      after: { ...snap(ALICE, { [ALICE]: 20 }, 0), ipo_pool_percentage: 80 },
    };
    expect(buildFocusSequence(firstPresident)?.crownArrivesOn).toBe(ALICE);
    expect(buildFocusSequence(firstPresident)?.presidency).toBeNull();
    expect(buildFocusSequence(takeoverBuy)?.crownArrivesOn).toBe(BOB);
    expect(buildFocusSequence(ordinary)?.crownArrivesOn).toBeNull();
  });

  it("has applied everything before the card lets go", () => {
    /* Otherwise the release would be a visible jump: the staged board must already equal the committed one
       by the time authoritative rendering takes back over. */
    [ordinary, takeoverBuy, takeoverSell].forEach((transaction) => {
      const sequence = buildFocusSequence(transaction)!;
      sequence.applications.forEach((entry) => expect(entry.at).toBeLessThan(sequence.totalMs));
    });
  });
});

describe("the mechanisms a render test cannot observe", () => {
  const PANEL = readStripped("components/StockRoundPanel.tsx");

  it("adjusts the sequence's local state DURING RENDER, never in an effect (design note #1456)", () => {
    /* THE PROPERTY IS ABOUT A RENDER THAT IS NEVER COMMITTED, so `act` cannot see it: it flushes to a
       settled DOM either way, which is why the old effect-based reset passed its own supersession test while
       leaking a paintable frame. What a scan CAN state is the mechanism.
       The three values live in ONE object carrying the sequence they belong to, the mismatch is detected and
       replaced in the component body, and `live` -- not `progress` -- is what the hook returns, so even the
       discarded pass is correct. */
    const hook = sliceBetween(PANEL, "function useStockTransferFocus(", "interface ProxyPath");
    expect(hook).toContain("const live = progress.sequence === sequence ? progress : startOfSequence(sequence);");
    expect(hook).toContain("if (live !== progress) setProgress(live);");
    expect(hook).toContain("stageIndex: live.stageIndex");
    expect(hook).toContain("applied: live.applied");
    /* And no effect resets them -- the fault that was fixed. */
    expect(hook).not.toContain("setProgress(startOfSequence(sequence));");
    expect(hook).not.toContain("setStageIndex(0)");
    expect(hook).not.toContain("setApplied(NOTHING_APPLIED)");
  });

  it("refuses a timer that does not belong to the sequence on screen", () => {
    const hook = sliceBetween(PANEL, "function useStockTransferFocus(", "interface ProxyPath");
    expect(hook).toContain("setProgress((was) => (was.sequence !== sequence ? was : step(was)));");
  });

  it("plays the presidency cue off the same two values the crown reads (design note #1457)", () => {
    /* ONE SEMANTIC SOURCE. If this ever started asking the DOM, or the authoritative board, the sound and
       the animation would be two answers to one question. */
    const hook = sliceBetween(PANEL, "const cuedForRef", "return {");
    expect(hook).toContain("live.applied.presidency");
    expect(hook).toContain("sequence.crownArrivesOn !== null");
    expect(hook).toContain("if (cuedForRef.current === sequence) return;");
    /* And the panel neither owns a player nor a volume -- the shell plays it through the shared helper. */
    expect(PANEL).not.toContain("new Audio");
    expect(PANEL).not.toContain("playVariantCue");
  });

  it("names the clip once, beside the beat it belongs to", () => {
    const APP = readStripped("App.tsx");
    expect(APP).toContain("playVariantCue(PRESIDENCY_SFX, sfxEnabledRef.current)");
    /* No fourth category and no second volume control -- the ruling was explicit. */
    expect(APP).not.toContain("sfxPresidency");
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    expect(fs.existsSync(path.join(__dirname, "..", "..", "public", "audio", "presidency.mp3"))).toBe(true);
  });
});

describe("the restraint", () => {
  const PANEL = readStripped("components/StockRoundPanel.tsx");

  it("never leaves the card", () => {
    /* THE VISUAL-LANGUAGE RULE, AS AN ABSENCE. Slide-out movement across the shell belongs to money
       (`TreasuryMoneyMachine` #1272). Nothing here is fixed, nothing is portalled, and the proxy is
       positioned inside the ownership table. */
    expect(STOCK_TRANSFER_CSS).not.toContain("position: fixed");
    expect(PANEL).not.toContain("createPortal");
    expect(PANEL).not.toContain("document.body");
    expect(STOCK_TRANSFER_CSS).toContain("position: absolute");
  });

  it("moves and fades, and does nothing arcade-like", () => {
    ["blur(", "filter:", "box-shadow:", "infinite", "alternate"].forEach((banned) =>
      expect(STOCK_TRANSFER_CSS).not.toContain(banned),
    );
    expect(STOCK_TRANSFER_CSS).toContain("transform: translate(");
    expect(STOCK_TRANSFER_CSS).toContain("opacity:");
  });

  it("subdues nonparticipants without disabling the card", () => {
    /* "Something in the neighbourhood of 40-60% opacity for nonparticipants may be appropriate ... We want
       clear focus, not a nearly-disabled-looking card." */
    const dim = STOCK_TRANSFER_CSS.match(/\.app-stock-row-dim\s*\{[^}]*opacity:\s*([\d.]+)/);
    expect(dim).not.toBeNull();
    const opacity = Number(dim![1]);
    expect(opacity).toBeGreaterThanOrEqual(0.4);
    expect(opacity).toBeLessThanOrEqual(0.6);
  });

  it("names its durations once (#970)", () => {
    /* The stylesheet owns the CURVES; the panel writes every duration inline from the constants. Three
       literals that happen to agree is a coincidence, not an invariant. */
    expect(STOCK_TRANSFER_CSS).not.toContain("animation-duration");
    expect(STOCK_TRANSFER_CSS).not.toMatch(/animation:[^;]*\dms/);
  });
});
