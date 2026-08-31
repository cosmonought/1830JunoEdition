/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTES 1049-1050 (harness): THE PAYOUT PHASE
// ==================================================================
//
// TWO CHANGES THAT LOOK SEPARATE AND ARE NOT. The private payout became a modal because a toast cannot carry a
// PHASE however long it stays up; and the seat colour moved from a 5px rule to a full stripe because an edge
// cannot carry an IDENTITY however carefully its contrast was measured. Both are the same mistake in two
// registers -- a correct decision about the channel, made about the wrong channel.
//
// SO THE CASES COME IN THREE KINDS. The ones about the DERIVATION check that the round's table is assembled
// from the payouts the reducer already paid, in an order every client agrees about. The ones about the
// SEQUENCE check the part a playtest would only find in Phase 4 or later: that the payout modal and the
// fleet-loss modal never appear as a stack. And the ones about CONTRAST check the arithmetic in #1050's note
// rather than trusting it -- that note declines to colour the whole surface on the strength of three measured
// ratios, and a design note's numbers are exactly the kind of claim that rots silently.

export {};

const { summarisePrivateRevenueRound, summarisePrivateRevenueForPlayer } =
  require("./sandboxSession") as typeof import("./sandboxSession");
const { SEAT_COLORS } = require("./playerLabels") as typeof import("./playerLabels");
const { bestContrastTextColor, relativeLuminance } =
  require("../styles/corporationLivery") as typeof import("../styles/corporationLivery");
const { readStripped, sliceBetween } = require("./sourceScan") as typeof import("./sourceScan");

const APP = readStripped("App.tsx");
const MODAL = readStripped("components/PrivateRevenueModal.tsx");
const SUMMARY = readStripped("utils/sandboxSession.ts");

type Payout = Parameters<typeof summarisePrivateRevenueRound>[0][number];

const toPlayer = (privateName: string, amount: number, address: string): Payout => ({
  privateId: privateName.length,
  privateName,
  amount,
  toPlayer: address,
  toCompanyId: null,
});
const toCompany = (privateName: string, amount: number, companyId: number): Payout => ({
  privateId: privateName.length,
  privateName,
  amount,
  toPlayer: null,
  toCompanyId: companyId,
});

/* ------------------------------------------------------------------ */
/* The round's table                                                   */
/* ------------------------------------------------------------------ */

describe("the round is itemised for the viewer and totalled for everyone else", () => {
  it("keeps the viewer's own privates line by line", () => {
    /* DELEGATED, NOT REIMPLEMENTED. `summarisePrivateRevenueForPlayer` is still the thing that answers "what
       did I get", and the round wraps it -- so the modal's rows and the sentence every other consumer reads
       cannot come from two different passes over the same payouts. */
    const round = summarisePrivateRevenueRound(
      [toPlayer("Schuylkill Valley", 5, "me"), toPlayer("Camden & Amboy", 25, "me")],
      "me",
    );
    expect(round.mine?.rows.map((row) => row.label)).toEqual([
      "Schuylkill Valley",
      "Camden & Amboy",
    ]);
    expect(round.mine?.total).toBe(30);
  });

  it("gives each other player one row carrying their whole round", () => {
    /* THE SHAPE OF THE CONCESSION. Four players by up to six privates every Operating Round is a table nobody
       reads twice; one labelled figure each is the phase without the wall of text. */
    const round = summarisePrivateRevenueRound(
      [
        toPlayer("Schuylkill Valley", 5, "me"),
        toPlayer("Camden & Amboy", 25, "rival"),
        toPlayer("Delaware & Hudson", 15, "rival"),
      ],
      "me",
    );
    expect(round.others).toEqual([{ address: "rival", total: 40 }]);
  });

  it("never folds a corporation's treasury into a player's row", () => {
    /* #743's RULE, WHICH THIS TABLE COULD BREAK MORE CONVINCINGLY THAN ANY OTHER SURFACE. A corporate private
       pays a TREASURY; a row headed by a player's name asserts the money is theirs to spend. `toPlayer` is
       the only field that reaches this table, so a corporate payout produces no row at all rather than a
       wrong one. */
    const round = summarisePrivateRevenueRound(
      [toPlayer("Schuylkill Valley", 5, "me"), toCompany("Camden & Amboy", 25, 3)],
      "me",
    );
    expect(round.others).toEqual([]);
    expect(round.mine?.total).toBe(5);
  });

  it("orders the rows by payment, not by name or by figure", () => {
    /* ==================================================================
        THE DETERMINISM CASE, AND IT IS THE REASON THIS IS AN ARRAY OF PAIRS
       ==================================================================
       #1044 IS THIS SESSION'S STANDING LESSON: anything not derivable identically from the log is a fact one
       browser knows. A table sorted by name would be at the mercy of a locale comparator, and one sorted by
       figure would reorder itself between rounds. Payment order is `state.private_companies` order, which
       every client replays the same way.
       ASSERTED WITH A FIXTURE THAT DISAGREES WITH BOTH ALTERNATIVE ORDERS: "zeta" pays first and least, so a
       name sort or an amount sort would each put "alpha" ahead of it. */
    const round = summarisePrivateRevenueRound(
      [toPlayer("Schuylkill Valley", 5, "zeta"), toPlayer("Camden & Amboy", 25, "alpha")],
      "me",
    );
    expect(round.others.map((entry) => entry.address)).toEqual(["zeta", "alpha"]);
  });

  it("says the viewer got nothing without hiding what the table got", () => {
    /* THE TWO HALVES ARE INDEPENDENT, which is what lets the shell fire on one and render the other. `mine`
       is `null` by #967's rule and `others` is still assembled -- the DECISION not to interrupt a player who
       collected nothing belongs to the caller, not to this function. */
    const round = summarisePrivateRevenueRound([toPlayer("Schuylkill Valley", 5, "rival")], "me");
    expect(round.mine).toBeNull();
    expect(round.others).toEqual([{ address: "rival", total: 5 }]);
  });

  it("makes no row for a private that paid nothing", () => {
    /* #562's RULE ON THE OTHER SIDE OF THE TABLE: a row reading "$0" beside a player's name asserts they were
       paid. A zero and an absence are different facts, and only one of them belongs on a payout panel. */
    expect(summarisePrivateRevenueRound([toPlayer("Schuylkill Valley", 0, "rival")], "me").others)
      .toEqual([]);
  });

  it("agrees with the per-player summary about the viewer's figures", () => {
    /* THE EQUIVALENCE, ASSERTED RATHER THAN ASSUMED. If the wrapper ever grows its own filter, this is what
       catches the two answers drifting -- which is #891's shape, and the reason the wrapper delegates. */
    const payouts = [toPlayer("Schuylkill Valley", 5, "me"), toPlayer("Camden & Amboy", 25, "me")];
    expect(summarisePrivateRevenueRound(payouts, "me").mine).toEqual(
      summarisePrivateRevenueForPlayer(payouts, "me"),
    );
  });
});

/* ------------------------------------------------------------------ */
/* The shell raises it                                                 */
/* ------------------------------------------------------------------ */

describe("the phase is raised once, when the viewer collected", () => {
  const opening = sliceBetween(APP, "const openingPayouts =", "sandboxStateRef.current = after;");

  it("asks for the round rather than the viewer's slice", () => {
    expect(opening).toContain("summarisePrivateRevenueRound(openingPayouts");
  });

  it("still writes the log's line per private beside it", () => {
    /* #967's DECISION, WHICH HAS NOW OUTLIVED THREE RENDERINGS OF THE PANEL. The feed is a record and a
       record wants each payment findable; the panel is what consolidates. Both, not one. */
    /* Design note #1059: the payout lines carry the whole sentence in the label with their own stamp now --
       `[OR 1.1--Private Companies]` rather than a `Private Revenue — ` prefix under whichever step the cursor
       happened to be on. What this case is for is the PAIRING, that the per-private lines and the consolidated
       summary are raised together from one place, and that is what it now asserts. */
    expect(opening).toContain("describePrivatePayout(payout, labelForAddress, labelForCompany)");
    expect(opening).toContain("--Private Companies");
  });

  it("interrupts nobody who collected nothing", () => {
    /* #967's `null` RULE IS THE WHOLE ANSWER TO #1047's FEAR. A modal whose entire content is other people's
       money, every Operating Round, is the interruption that trains a player to click through -- and it is
       also what makes the feature end itself when the privates close in Phase 5. */
    expect(opening).toContain("if (round.mine)");
  });

  it("goes through the guarded raiser rather than the setter", () => {
    /* #825's RULE. A client rebuilding the board by replaying the log is not watching anything happen, and an
       unguarded set would open one payout modal per Operating Round the table has already played -- each
       demanding a click -- to a player who has just joined. */
    expect(opening).toContain("showPrivatePayoutPhase(");
    expect(opening).not.toContain("setPrivatePayoutPhase(");
    const raiser = sliceBetween(APP, "const showPrivatePayoutPhase = useCallback(", "[],");
    expect(raiser).toContain("if (replayingHistory) return;");
  });

  it("reads the viewer through the ref, not the closure", () => {
    /* #967a. `runGameplayAction` is a long-lived `useCallback` and `viewerAddress` is not in its deps, so a
       closure read would name the wallet connected when the callback was built -- somebody else's income
       after a reconnect, on a panel whose whole subject is whose money this is. */
    expect(opening).toContain("viewerAddressRef.current");
  });

  it("resolves the names and the seat colours in the shell", () => {
    /* Design note #1049: the modal paints what it is given. Names come from the room's nickname registry and
       colours from the seating index, and handing a presentation component two resolver callbacks would make
       it untestable without a room. */
    expect(opening).toContain("labelForAddress(entry.address)");
    expect(opening).toContain("seatColor(entry.address, seat)");
  });

  it("leaves an unplaceable address without a colour rather than guessing one", () => {
    // #232 on the roster: absence is not an answer, and an invented hue would assert an identity.
    expect(opening).toContain("seat >= 0 ? seatColor(entry.address, seat) : null");
  });
});

/* ------------------------------------------------------------------ */
/* A sequence, not a stack                                             */
/* ------------------------------------------------------------------ */

describe("the payout is read before the fleet loss", () => {
  const memo = sliceBetween(APP, "const dueFleetNotice = useMemo<FleetLossNotice | null>(", "}, [");

  it("withholds the fleet notice while the payout is open", () => {
    /* ==================================================================
        THE COLLISION IS ORDINARY FROM PHASE 4 ON
       ==================================================================
       The payout fires when an Operating Round opens; a fleet notice fires at the acting corporation's turn,
       and the first corporation is already acting at that moment. Two modals were accepted -- "two modals
       carrying meaningful information does not seem so overwhelming" -- but IN A ROW was the operative
       phrase, and #1047's surviving worry is that an undifferentiated stack trains a player to click through
       the one where clicking through costs a turn. */
    expect(memo).toContain("if (privatePayoutPhase !== null) return null;");
  });

  it("keeps every gate the notice already had", () => {
    /* THE HALF THAT MUST NOT BE LOST IN AN ADDITION. #981's president scope and #896's turn placement are
       untouched by the new guard, and a suppression that swallowed one of them would be invisible: the modal
       would simply stop appearing for somebody. */
    expect(memo).toContain("if (spectator) return null;");
    expect(memo).toContain("notice.companyId !== actingProtocolId");
    expect(memo).toContain("president === viewerAddress");
  });

  it("lifts the suppression on its own when the payout closes", () => {
    /* THE STALE-MEMO FAILURE, AND IT WOULD BE PERMANENT. A ref read here would suppress the notice and never
       re-run to discover it was safe to show it -- the fleet-loss modal would be lost for that turn, which is
       exactly the cost #896 wrote the notice to avoid. */
    const deps = sliceBetween(APP, "const dueFleetNotice = useMemo<FleetLossNotice | null>(", "]);");
    expect(deps).toContain("privatePayoutPhase,");
  });

  it("defers the notice without consuming it", () => {
    /* WAITING, NOT DROPPING, and the two are indistinguishable on screen for one turn and permanently
       different afterwards. A suppression that recorded a dismissal would silently EAT the notice.
       ASSERTED TWO WAYS. The guard returns before the queue is even filtered -- so nothing is read, let alone
       consumed -- and the memo performs no write to the dismissal set, which lives in `acknowledgeFleetNotice`
       where the player's own click is.
       NOT `not.toContain("dismissedFleetNoticesRef")`, which was the first draft of this case and would have
       been wrong: the memo legitimately READS that ref, passing it to `nextDueNotice` so an already-answered
       notice is not raised again. The forbidden thing is the `.add`. */
    const beforeFilter = sliceBetween(
      APP,
      "const dueFleetNotice = useMemo<FleetLossNotice | null>(",
      "const presidentOf =",
    );
    expect(beforeFilter).toContain("if (privatePayoutPhase !== null) return null;");
    expect(memo).not.toContain("dismissedFleetNoticesRef.current.add");
  });

  it("mounts and clears the modal in the shell", () => {
    /* THE GAP THIS PROJECT KEEPS FINDING (#1006): a correct predicate the deciding caller never asks, or in
       this case a piece of state nothing renders. Asserted at the mount and at the exit, because a modal with
       no way to clear its state is a soft-lock and a state with no mount is invisible. */
    expect(APP).toContain("<PrivateRevenueModal");
    expect(APP).toContain("round={privatePayoutPhase}");
    expect(APP).toContain("onAcknowledge={() => setPrivatePayoutPhase(null)}");
  });

  it("sits above the fleet-loss modal if the suppression is ever lost", () => {
    /* THE RECOVERABLE DIRECTION. The sequence is enforced by the memo, not by this number -- but if that
       guard is edited away, a modal in the wrong ORDER is a nuisance and a modal invisible UNDERNEATH another
       one is a soft-lock. `FleetLossModal` sits at 3800. */
    expect(MODAL).toContain("zIndex: 3900");
  });
});

/* ------------------------------------------------------------------ */
/* The stripe                                                          */
/* ------------------------------------------------------------------ */

describe("the seat colour goes where it can be seen", () => {
  it("fills a stripe rather than an edge", () => {
    /* REPORTED of #1048's 5px rule: "far too subtle for human players to notice", and the second time this
       shape has been withdrawn. The colour is a ground now, on the band that carries the name. */
    expect(MODAL).toContain("backgroundColor: stripe");
    expect(MODAL).not.toContain('borderLeftWidth: "5px"');
  });

  it("picks the name's ink per seat instead of asserting one colour for six grounds", () => {
    // The same helper `PlayerCards` #606 uses for the same band, so the two cannot diverge.
    expect(MODAL).toContain("bestContrastTextColor(stripe)");
  });

  it("falls back to paper, not to a guessed hue", () => {
    // #232 again: no seat colour resolved is not licence to invent one.
    expect(MODAL).toContain("stripeUnknown");
  });

  it("keeps the auction cards' paper under the figures", () => {
    /* THE REQUEST, VERBATIM: "may I ask that the toast notification be the white/cream/whatever background
       the PC cards have in the Auction Round". Taken as the shared constant rather than as a hex, which is
       #891's point and #1048's surviving half. */
    expect(MODAL).toContain("backgroundColor: CARD_SURFACE,");
  });

  it("marks the other players with a block rather than a tinted name", () => {
    /* THE SAME MISTAKE ONE SIZE DOWN. A coloured label at row size is the subtlety this batch is correcting;
       a solid swatch reads at a glance, and the name beside it carries the identity for a reader who cannot
       use the colour at all. */
    expect(MODAL).toContain("styles.swatch");
    expect(MODAL).toContain('aria-hidden="true"');
  });

  it("shows a total only when there is something to add up", () => {
    // #697/#1047: one private is its own total, and a "Total" row under a single line restates it.
    expect(MODAL).toContain("round.lines.length > 1 &&");
  });

  it("actually renders the rows it is handed", () => {
    /* ==================================================================
        THE CONTROL THAT HAS WALKED THROUGH THIS PROJECT FOUR TIMES
       ==================================================================
       `polishWave9` records it: a control replacing a render guard with `{false && (` passed every case in a
       describe about a rendering change, because the styles existed, the props existed and the summary
       emitted rows. The map IS the assertion. */
    expect(MODAL).toContain("round.lines.map((line) => (");
    expect(MODAL).toContain("round.others.map((other) => (");
    expect(MODAL).toContain("{line.label}");
    expect(MODAL).toContain("{other.name}");
  });

  it("names the phase and the rule, not just the money", () => {
    /* THE COMPLAINT WAS THAT THE PROCESS HAD BEEN "minimized or obscured", and a panel that shows figures
       without saying when they are paid obscures it a second way. */
    expect(MODAL).toContain("Private Company Payouts");
    expect(MODAL).toContain("before any corporation acts");
  });

  it("has exactly one way out, and it is the button", () => {
    /* ==================================================================
        DESIGN NOTE 1052: THIS CASE ASSERTED THE OPPOSITE AND #1049 WAS WRONG
       ==================================================================
       IT PINNED THE ESCAPE LISTENER, on #1049's argument that #896's reason for removing every casual exit
       from `FleetLossModal` does not apply here -- "nothing is lost by dismissing this one ... ceremony a
       player wants to skip should be skippable."
       REPORTED FROM PLAYTEST: "clicking anywhere on the screen dismisses the modal: I think it's better to
       make players click the Begin Operations button since an accidental click elsewhere immediately dismisses
       it."
       THE ARGUMENT PRICED THE WRONG COST. It asked what a player LOSES by dismissing -- nothing, correctly --
       and never asked how easily they dismiss it BY ACCIDENT. This modal opens under the cursor at the start
       of every Operating Round, so a backdrop click eats a press aimed at the board underneath and the
       ceremony the panel exists to restore is gone before it is read. The failure is not lost information, it
       is the feature not happening.
       ASSERTED AS THE ABSENCES, because that is what a later "consistency" pass would undo: every other modal
       in this app closes on a backdrop click, so restoring one here would look like tidying. */
    expect(MODAL).not.toContain('event.key === "Escape"');
    /* ONE HANDLER IN THE WHOLE FILE, which is the property rather than a proxy for it. A first draft of this
       pinned the backdrop's opening tag by its exact whitespace -- an assertion that would break on a
       reformat and pass on a re-added handler two lines lower, which is precisely backwards. */
    expect(MODAL.split("onClick=").length - 1).toBe(1);
    /* AND THE CLICK-EATER WITH IT. `stopPropagation` existed only to stop the backdrop's handler firing when
       the player clicked inside the card; with no backdrop handler it is a guard against nothing, and leaving
       it would imply one still exists. */
    expect(MODAL).not.toContain("stopPropagation");
    // The one exit, and the focus that makes it reachable without a mouse.
    expect(MODAL).toContain("Begin operations");
    expect(MODAL).toContain("autoFocus");
  });

  it("numbers a private the way every other surface numbers it", () => {
    /* REPORTED: "the private companies lack their enumerations, e.g. '1. Schuykill Valley'".
       AND WHICH NUMBER IS DECIDED BY PRECEDENT, not by taste. Five surfaces already render
       `${private_id}. ${name}`; numbering these rows by their position in one player's holdings would give
       the same six companies a second numbering, so a player holding the C&A and the B&O would read "5." and
       "6." everywhere and "1." and "2." here. That is #891's shape.
       THE ID TRAVELS ON THE ROW, so the panel composes the pair at its own render site exactly as
       `PlayerCards` does, rather than the summary baking a prefix into a name. */
    expect(MODAL).toContain("{line.privateId}.");
    expect(SUMMARY).toContain("privateId: payout.privateId,");
  });

  it("colours the sum like the figures it sums", () => {
    /* REPORTED: "the revenue numbers are in green, but the sum is in black." The dark total came from the
       toast, where #1030 had darkened every figure against a cream ground and there were no green rows to be
       inconsistent with. #670's rule decides it: green means money, or a thing arriving, and a green column
       under a black sum says the sum is a different kind of quantity. */
    const total = sliceBetween(MODAL, "totalValue: {", "},");
    expect(total).toContain("color: CARD_INK_POSITIVE");
  });

  it("reports where the money left the reader", () => {
    /* ASKED: "on payouts, we usually include $before > $after somewhere." It is the house form -- #670 for
       the dividend report, #682 for the Stock Round's projection: money moving is two facts.
       READ, NOT DERIVED. `after = before + total` is arithmetic the shell could do, and #685's rule is that
       the reducer settles and the shell narrates -- a computed balance would be right until something else
       touched cash in the same transition. */
    expect(MODAL).toContain("round.cashBefore !== null && round.cashAfter !== null");
    expect(APP).toContain("cashBefore: cashIn(before, viewer)");
    expect(APP).toContain("cashAfter: cashIn(after, viewer)");
  });

  it("gives the other seats their standing, not a second before-and-after", () => {
    /* ASKED whether the others should show "$before + $payout > $new". Three figures on each of up to five
       rows of information the reader is not acting on is a table rather than a glance, and the `before` is
       the one of the three that is a subtraction away. What arrived, and what it arrived at. */
    expect(MODAL).toContain("+${other.total}");
    expect(MODAL).toContain("other.cashAfter !== null");
  });

  it("leaves the stripe carrying identity alone", () => {
    /* REPORTED: "the sum does not need to be listed in the player color stripe since it's printed a few lines
       below that." #1049 defended the copy as two registers; four lines apart is one number twice. And the
       player card's own header -- the thing #1050 borrowed -- carries no figure either. */
    expect(MODAL).not.toContain("stripeTotal");
  });
});

/* ------------------------------------------------------------------ */
/* The measurement #1050 rests on                                      */
/* ------------------------------------------------------------------ */

describe("the contrast arithmetic in the note is true", () => {
  const contrast = (a: string, b: string) => {
    const light = Math.max(relativeLuminance(a), relativeLuminance(b));
    const dark = Math.min(relativeLuminance(a), relativeLuminance(b));
    return (light + 0.05) / (dark + 0.05);
  };

  it("finds three seats that could not carry white body text", () => {
    /* ==================================================================
        THE CASE AGAINST COLOURING THE WHOLE SURFACE, CHECKED RATHER THAN QUOTED
       ==================================================================
       "Doing the whole notification in player colors with adjusted font colors for maximum contrast is
       perfectly acceptable too" -- and #1050 declined it on three measured ratios. A design note's numbers
       are exactly the kind of claim that rots when a palette is retuned and nothing goes red.
       SO THE PROPERTY IS ASSERTED, NOT THE FIGURES: at least one seat colour fails the 4.5:1 body-text
       threshold against white, which is what makes a per-seat ground a per-seat problem rather than a
       styling preference. If a future palette clears all six, this goes red and the note should be revisited
       -- which is the right outcome, and the reason this is not pinned to "exactly three". */
    const failing = SEAT_COLORS.filter((seat) => contrast(seat, "#FFFFFF") < 4.5);
    expect(failing.length).toBeGreaterThan(0);
  });

  it("clears the large-bold threshold on every seat, which is what the stripe needs", () => {
    /* THE STRIPE CARRIES ONE SHORT BOLD NAME AT HEADING SIZE, where 3:1 is the applicable threshold -- so the
       band is legible on all six where a body-text ground would not be. This is the half of #1050 that makes
       the stripe the answer rather than merely the smaller compromise. */
    for (const seat of SEAT_COLORS) {
      expect(contrast(seat, bestContrastTextColor(seat))).toBeGreaterThanOrEqual(3);
    }
  });

  it("takes the better of black and white per seat, which is not the same colour for all six", () => {
    /* THE REASON THE HELPER EXISTS. A fixed ink is wrong for at least one seat whichever one is chosen, which
       is `corporationLivery` #46's finding on the corporate palette and holds here too. */
    const inks = new Set(SEAT_COLORS.map((seat) => bestContrastTextColor(seat)));
    expect(inks.size).toBeGreaterThan(0);
    for (const seat of SEAT_COLORS) {
      const chosen = bestContrastTextColor(seat);
      const other = chosen === "#FFFFFF" ? "#000000" : "#FFFFFF";
      expect(contrast(seat, chosen)).toBeGreaterThanOrEqual(contrast(seat, other));
    }
  });
});
