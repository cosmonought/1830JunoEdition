// frontend/src/tutorial/presentation.ts
//
/* ==================================================================
    PHASE 3 FINAL PLAY TUTORIAL: PRESENTATION (layer C of three)
   ==================================================================
   WHAT A LESSON POINTS AT, AND WHAT THE COACH OFFERS BESIDE "GOT IT". Separate from the words (`lessons.ts`) and from
   what raises them (`triggers.ts`).

   ANCHORS ARE OWNED ATTRIBUTES, NOT TEXT. A spotlight target is an element carrying `data-tutorial-anchor="<id>"`,
   put there by the component that renders it (the action bar's step buttons, the market tokens, the stock panel's
   par buttons, ...). Nothing here matches visible text or walks the DOM looking for a likely element. A target that
   is not mounted -- the market chart on another tab, a button this step does not show -- simply means no spotlight:
   the coach falls back to an unanchored card.

   EVERY SPOTLIGHT IS ALSO SAID IN WORDS (`describe`), so what is highlighted makes sense without seeing it. */

import type { LessonId } from "./lessons";

/** The anchor ids components may carry. A market token's id carries its corporation: `market-token-<companyId>`. */
export type TutorialAnchorId =
  | "auction-dashboard"
  | "stock-par"
  | "stock-panel"
  | "action-go-to-map"
  | "action-station"
  | "auto-route"
  | "action-pay-dividends"
  | "action-go-to-trains"
  | "phase-badge"
  | "game-clock"
  | "money-panel"
  | "player-cards"
  | "tab-stock"
  | `market-token-${number}`;

export const TUTORIAL_ANCHOR_ATTRIBUTE = "data-tutorial-anchor";

/** The selector for one anchor id. */
export function anchorSelector(anchor: string): string {
  return `[${TUTORIAL_ANCHOR_ATTRIBUTE}="${anchor.replace(/["\\]/g, "")}"]`;
}

export interface LessonPresentation {
  /** What to highlight, in order of preference: the first one mounted and visible wins. */
  readonly anchors: readonly TutorialAnchorId[];
  /** The highlighted element in words. */
  readonly describe?: string;
  /** An extra, explicit action the coach offers: open the Stock Market chart. Never taken automatically. */
  readonly showMarket?: boolean;
}

/** A lesson's presentation, given the corporation it is about (if any). */
export function presentationFor(id: LessonId, subject?: number): LessonPresentation {
  const token: TutorialAnchorId[] = subject === undefined ? [] : [`market-token-${subject}`];
  switch (id) {
    case "auction.choices":
    case "auction.cascade":
    case "auction.allPass":
      return { anchors: ["auction-dashboard"], describe: "The auction panel." };
    case "stock.turn":
      return { anchors: ["stock-panel"], describe: "The Stock Round panel, where shares are bought and sold." };
    case "stock.par":
      return { anchors: ["stock-par", ...token], describe: "The par value choices." };
    case "operating.track":
      return { anchors: ["action-go-to-map"], describe: "The Lay Track button on the action bar." };
    case "operating.tokens":
      return { anchors: ["action-station"], describe: "The station button on the action bar." };
    case "operating.routes":
      return { anchors: ["auto-route"], describe: "The Auto-Route button." };
    case "operating.dividends":
      return { anchors: ["action-pay-dividends"], describe: "The pay-out button on the action bar." };
    case "operating.trains":
      return { anchors: ["action-go-to-trains"], describe: "The Buy Trains button on the action bar." };
    case "market.moves":
    case "market.firstWithhold":
      return {
        anchors: [...token, "tab-stock"],
        describe: "The corporation's token on the Stock Market chart, or the Stock Market tab.",
        showMarket: true,
      };
    case "trains.phases":
    case "trains.rust":
      return { anchors: ["phase-badge"], describe: "The phase badge on the action bar." };
    case "orientation.goal":
    case "orientation.money":
      return { anchors: ["player-cards"], describe: "The players' cards, showing each player's cash and net worth." };
    case "money.ante":
      return { anchors: ["money-panel"], describe: "The money panel." };
    case "pace.modes":
      return { anchors: ["game-clock"], describe: "The table's clock." };
    default:
      return { anchors: [] };
  }
}
