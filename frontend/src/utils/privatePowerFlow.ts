// frontend/src/utils/privatePowerFlow.ts
//
// A private power as the sequence of decisions it actually is.
//
// ==================================================================
//  DESIGN NOTE 847: THE POWER IS TWO STEPS, AND THE UI ASKED ONE QUESTION
// ==================================================================
//
// SPECIFIED: "rather than 'Lay Track,' I would rather the text for the Private Power subpanel read 'Use
// Power' and then a modal pop up that clearly walks players through the steps/options ... two lines, the
// first of which says something like 'You can lay track this turn on F16 ignoring the rules for connectivity
// and paying the usual terrain cost' and a 'Lay Track on F16' button that is activated, and a line below it
// that reads, 'THEN you can place one of your Station Tokens for free on F16, in addition to your usual
// Station Token action' with a grayed out 'Place Station Token' and 'Forfeit Station Token' buttons beside
// it."
//
// WHAT WAS THERE INSTEAD was a button labelled with the FIRST step, and a modal (#818) that appeared for the
// SECOND with no memory of the first. Reported as: "I gave you a whole work-flow for using DH's Private Power
// including modals and a means to 'escape' the Private Power, but it seems that only the 'Station Marker'
// modal pops up." Both halves existed; neither knew it was half of something.
//
// #818'S QUESTION IS NOT DELETED, IT BECOMES LINE TWO. That note's whole argument survives and is worth
// keeping where the code is: the free station must be TAKEN or FORFEITED explicitly, never by dismissal,
// because "I fear without the station marker modal that players may not realize they are forfeiting the
// special power". The Forfeit button is that sentence made into a control. What changes is that the question
// no longer arrives out of nowhere -- the player was shown it, greyed, before they laid the tile.
//
// THE ESCAPE IS A WINDOW, NOT A BUTTON THAT IS ALWAYS THERE. "an X button to cancel the private power usage
// (which should disappear once they've committed to its first action)". That is exactly right and it is why
// `cancellable` is computed rather than constant: before the lay, nothing has happened and the whole power
// can be put back; after it, the tile is on the board and the only remaining question is the token. An X
// offered after the lay would have to mean "forfeit", which is what the second line's own button says
// honestly -- #818's argument about the red X, one layer up.
//
// THE TWO POWERS ARE THE SAME SHAPE AT DIFFERENT LENGTHS. "Although it should be much simpler, I think CSL
// should have an identical modal flow for its one bonus track lay." One list, one renderer, and the C&SL's
// list has one entry -- rather than a second modal that would drift from this one.
//
// AND THE RULES DIFFERENCE IS RECORDED IN THE COPY. The D&H's tile is NOT free (#548/#725: "the mountain
// costs the usual $120 and only the TOKEN is free") and it CONSUMES the corporation's ordinary lay; the
// C&SL's is free and is EXTRA (#726). Both sentences say so, because the two powers being opposites is the
// mistake players and maintainers both make.

/* Design note #871: AND THE M&H, which is not a hex power at all. #847 built this for the two tile lays and
   its closing argument was "One list, one renderer, and the C&SL's list has one entry -- rather than a second
   modal that would drift from this one". A third power asking one question is that argument's own next case:
   requested as "like we did with the other Private Powers, let's have a modal pop up". */
export type PowerAbilityKey = "csl-tile" | "dh-tile" | "mh-exchange";

/** What has happened to the D&H's free station. `"none"` for a power that has no station step at all. */
export type StationOutcome = "none" | "pending" | "placed" | "forfeited";

export interface PowerFlowStep {
  key: "lay" | "station" | "exchange";
  /** The sentence above the buttons. */
  text: string;
  /** The committing button. */
  actionLabel: string;
  /** The D&H's forfeit; `null` where declining is not a decision the step offers. */
  declineLabel: string | null;
  /* ==================================================================
      DESIGN NOTE 872: THE MODAL WROTE COPY IT SAID IT DID NOT WRITE
     ==================================================================
     #848's opening claim: "It writes no rules and no copy -- every sentence and every label comes from that
     module, so the D&H's two lines and the C&SL's one cannot drift apart or from the catalog they describe."
     TWO STRINGS WERE NEVER TRUE OF THAT. The decline button's `title` read "Give up the free placement. The
     marker stays in the supply for an ordinary placement later." and the holder line read "{ticker} holds
     this power." -- both hardcoded in the component, and both D&H-shaped.
     IT COST NOTHING UNTIL A THIRD POWER ARRIVED, which is why it survived two passes: with only the two hex
     lays, "the marker stays in the supply" was true wherever a decline existed. The M&H's decline is not a
     forfeit at all -- nothing is given up, the question is simply not answered yet -- so inheriting that
     sentence would have told a player the opposite of the rule. */
  /** The decline button's hover text. `null` wherever `declineLabel` is. */
  declineHint: string | null;
  /** Already resolved -- both buttons greyed and the line reads as history. */
  done: boolean;
  /** Live now. A step is live when every step before it is done. */
  enabled: boolean;
}

export interface PowerFlow {
  abilityKey: PowerAbilityKey;
  title: string;
  /** Design note #872: who holds this, as a whole sentence. A corporation for the two hex powers and a PLAYER
   *  for the M&H (#441: "a PLAYER owning the MH may exchange it"), so the modal cannot assemble it from a
   *  ticker without being wrong for one of the three. */
  holderLine: string;
  steps: readonly PowerFlowStep[];
  /** Whether the X is offered. False the moment anything is committed. */
  cancellable: boolean;
  /** Every step resolved, so the modal has nothing left to ask. */
  complete: boolean;
}

/* ==================================================================
    DESIGN NOTE 871a: A UNION, SO THE M&H CANNOT BE ASKED FOR A HEX
   ==================================================================
   The first draft of this made `hexLabel` optional and defaulted it to `""` in the tile sentences. That
   compiles and produces "Lay Track on " for anyone who forgets it -- a blank where a board reference should
   be, in the one sentence telling a player where to go. The M&H reserves no hex at all (#312: "M&H reserves
   nothing at all because its power is the NYC exchange"), so the right shape is two inputs rather than one
   with a hole in it: the hex powers must supply a hex and the exchange cannot be handed one. */
export type PowerFlowInput =
  | {
      abilityKey: "csl-tile" | "dh-tile";
      /** Design note #872: the corporation's ticker. */
      holder: string;
      /** `F16` / `B20` -- named in every sentence, because a player has to go there. */
      hexLabel: string;
      /** The tile has been laid under this power. */
      layDone: boolean;
      /** Only meaningful for the D&H. */
      station: StationOutcome;
    }
  | {
      abilityKey: "mh-exchange";
      /** Design note #872: the OWNING PLAYER's name -- this power is player-scoped (#441). */
      holder: string;
      /** The revenue per Operating Round the exchange gives up. Absent only when the room has not reported
       *  it; the sentence then names the loss without a figure rather than printing a guess. */
      revenuePerOr?: number;
    };

/** The D&H's own hex is a mountain; the sentence says so because the token being free does not make the
 *  tile free, and that is the single most-confused fact about this power. */
function dhLayText(hexLabel: string): string {
  return (
    `You can lay track this turn on ${hexLabel} ignoring the rules for connectivity, ` +
    "paying the usual terrain cost. This uses the corporation's ordinary tile lay."
  );
}

function dhStationText(hexLabel: string): string {
  return (
    `THEN you can place one of your Station Tokens for free on ${hexLabel}, ` +
    "in addition to your usual Station Token action. " +
    /* #847a: what declining actually costs. The marker is not destroyed -- it returns to the supply and can
       be placed later at the ordinary price -- so the sentence says which of the two things is forfeited. */
    "Declining keeps the marker; only the free placement is lost."
  );
}

function cslLayText(hexLabel: string): string {
  return (
    `You can lay one extra tile this turn on ${hexLabel}, connected to nothing and at no cost. ` +
    "The corporation keeps its ordinary tile lay, so it may play two tiles this turn."
  );
}

/** The flow for one power, in the order a player performs it. */
export function privatePowerFlow(input: PowerFlowInput): PowerFlow {
  /* NARROWED BEFORE DESTRUCTURING, which is the whole point of the union above: `hexLabel` does not exist on
     the exchange arm and `revenuePerOr` does not exist on the tile arm, so neither can be read where it has
     no meaning. */
  const { abilityKey, holder } = input;

  if (input.abilityKey === "mh-exchange") {
    const { revenuePerOr } = input;
    /* ==================================================================
        DESIGN NOTE 871: ONE QUESTION, AND THE FIGURE IT TURNS ON
       ==================================================================
       SPECIFIED: "let's have a modal pop up when a player clicks it that basically says 'Exchanging this
       Private Company for an NYC share forfeits its $20/OR revenue. Are you sure?' and allows them to escape
       by selecting no."
       THE REVENUE IS THE WHOLE DECISION and it is why this sentence is short where the D&H's is long. #443
       found the same thing from the other side -- "Both exchanges are a trade... and a player weighing that
       needs the figure they are giving up" -- and put the number on the panel row. Here it goes in the
       question itself, because the question IS the trade.
       WHAT THE OLD PANEL ROW SAID, and why it goes: "Mohawk & Hudson -- the owner may exchange this private
       for a 10% share of the New York Central (NYC). The exchange closes this private permanently." Two
       sentences of rules on a surface a player reads every Stock Round, restating what the one button under
       them already says. Reported as "for some reason it has a multi-line/sentence explanation of this
       rule". #800's test settles it: a rule met once belongs where the decision is, not on a standing panel.
       DECLINING COSTS NOTHING, which is the difference from the D&H's line two and the reason this step has
       its own `declineHint`. #845 drew this distinction already: "Declining THIS one costs nothing: the
       power is still unspent... Two modals, two rules, and the difference is whether the question can be
       asked again." */
    const cost =
      revenuePerOr === undefined ? "its Operating Round revenue" : `its $${revenuePerOr}/OR revenue`;
    const exchange: PowerFlowStep = {
      key: "exchange",
      text: `Exchanging this Private Company for an NYC share forfeits ${cost}. Are you sure?`,
      actionLabel: "Exchange for NYC Share",
      declineLabel: "No, Keep the Private",
      declineHint: "Closes this question. The private company and its power are untouched.",
      done: false,
      enabled: true,
    };
    return {
      abilityKey,
      title: "Exchange the M&H for an NYC share?",
      holderLine: `${holder} holds this power.`,
      steps: [exchange],
      /* THE X AND THE "NO" BOTH MEAN THE SAME THING HERE, and that is correct rather than redundant: nothing
         is committed until the exchange fires, so every exit is the same exit. On the D&H they diverge, which
         is exactly why that flow withdraws its X once the tile is down. */
      cancellable: true,
      complete: false,
    };
  }

  const { hexLabel, layDone, station } = input;
  const lay: PowerFlowStep = {
    key: "lay",
    text: abilityKey === "dh-tile" ? dhLayText(hexLabel) : cslLayText(hexLabel),
    actionLabel: `Lay Track on ${hexLabel}`,
    declineLabel: null,
    declineHint: null,
    done: layDone,
    /* ENABLED EVEN WHEN DONE IS FALSE AND NOTHING ELSE IS. The first step is always the live one until it is
       taken -- there is no state where a power is open and its first step is unreachable. */
    enabled: !layDone,
  };

  if (abilityKey === "csl-tile") {
    return {
      abilityKey,
      title: "Use the C&SL's extra tile lay?",
      holderLine: `${holder} holds this power.`,
      steps: [lay],
      cancellable: !layDone,
      complete: layDone,
    };
  }

  const stationStep: PowerFlowStep = {
    key: "station",
    text: dhStationText(hexLabel),
    actionLabel: "Place Station Token",
    /* ==================================================================
        DESIGN NOTE 847a: THE TOKEN IS NOT FORFEITED, THE FREE PLACEMENT IS
       ==================================================================
       CORRECTED MID-BUILD: "'Forfeit Station Token' could be 'Forfeit Free Station Token' or something
       similar, since players are not actually forfeiting a station token, only its free placement."
       EXACTLY RIGHT, AND IT IS A RULES POINT rather than a wording one. The marker goes back to the
       corporation's supply and may be placed later at $40 or $100 like any other (#237's schedule); what is
       lost is this power's one free placement on this hex. A label reading "Forfeit Station Token" describes
       a piece leaving the game, which would make the choice look far worse than it is -- and #818's whole
       argument is that this decision must be understood, not merely made.
       "FREE PLACEMENT" RATHER THAN "FREE STATION TOKEN", which was the suggestion: the same correction
       applied to itself, since "free station token" still names the piece rather than the placement. */
    declineLabel: "Forfeit Free Placement",
    /* Design note #872: moved here out of the modal, unchanged. */
    declineHint:
      "Give up the free placement. The marker stays in the supply for an ordinary placement later.",
    done: station === "placed" || station === "forfeited",
    /* THE GREYING IS THE RULE, drawn. #548: the token REQUIRES the lay -- there is nothing to put a marker on
       until the tile is down -- so this is not a UI courtesy, it is 1830 refusing an order of operations. */
    enabled: layDone && station === "pending",
  };

  return {
    abilityKey,
    title: "Use the D&H's private power?",
    holderLine: `${holder} holds this power.`,
    steps: [lay, stationStep],
    /* NOTHING COMMITTED YET. Once the tile is on the board the power is partly spent and cannot be handed
       back; from then on the only exit is the forfeit button, which says what it does. */
    cancellable: !layDone && station === "pending",
    complete: layDone && stationStep.done,
  };
}

/** Whether the modal should be showing at all, given a flow.
 *
 *  A COMPLETED FLOW CLOSES ITSELF rather than waiting to be dismissed: the last click a player makes in this
 *  modal answers the last question in it, and a modal that lingers after that is asking nothing. */
export function powerFlowOpen(flow: PowerFlow | null): boolean {
  return flow !== null && !flow.complete;
}
