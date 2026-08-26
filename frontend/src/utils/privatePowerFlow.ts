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

export type PowerAbilityKey = "csl-tile" | "dh-tile";

/** What has happened to the D&H's free station. `"none"` for a power that has no station step at all. */
export type StationOutcome = "none" | "pending" | "placed" | "forfeited";

export interface PowerFlowStep {
  key: "lay" | "station";
  /** The sentence above the buttons. */
  text: string;
  /** The committing button. */
  actionLabel: string;
  /** The D&H's forfeit; `null` where declining is not a decision the step offers. */
  declineLabel: string | null;
  /** Already resolved -- both buttons greyed and the line reads as history. */
  done: boolean;
  /** Live now. A step is live when every step before it is done. */
  enabled: boolean;
}

export interface PowerFlow {
  abilityKey: PowerAbilityKey;
  title: string;
  steps: readonly PowerFlowStep[];
  /** Whether the X is offered. False the moment anything is committed. */
  cancellable: boolean;
  /** Every step resolved, so the modal has nothing left to ask. */
  complete: boolean;
}

export interface PowerFlowInput {
  abilityKey: PowerAbilityKey;
  /** `F16` / `B20` -- named in every sentence, because a player has to go there. */
  hexLabel: string;
  /** The tile has been laid under this power. */
  layDone: boolean;
  /** Only meaningful for the D&H. */
  station: StationOutcome;
}

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
  const { abilityKey, hexLabel, layDone, station } = input;

  const lay: PowerFlowStep = {
    key: "lay",
    text: abilityKey === "dh-tile" ? dhLayText(hexLabel) : cslLayText(hexLabel),
    actionLabel: `Lay Track on ${hexLabel}`,
    declineLabel: null,
    done: layDone,
    /* ENABLED EVEN WHEN DONE IS FALSE AND NOTHING ELSE IS. The first step is always the live one until it is
       taken -- there is no state where a power is open and its first step is unreachable. */
    enabled: !layDone,
  };

  if (abilityKey === "csl-tile") {
    return {
      abilityKey,
      title: "Use the C&SL's extra tile lay?",
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
    done: station === "placed" || station === "forfeited",
    /* THE GREYING IS THE RULE, drawn. #548: the token REQUIRES the lay -- there is nothing to put a marker on
       until the tile is down -- so this is not a UI courtesy, it is 1830 refusing an order of operations. */
    enabled: layDone && station === "pending",
  };

  return {
    abilityKey,
    title: "Use the D&H's private power?",
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
