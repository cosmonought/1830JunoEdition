// frontend/src/components/TutorialModal.tsx
//
// First-Time User Experience explainers -- a small, dismissible, paged
// modal shown on entering a phase whose rules are not guessable from the UI.
//
// ===================================================================
//  DESIGN NOTE 0: WHAT THIS IS FOR, AND WHAT IT MUST NOT BECOME
// ===================================================================
//
// The waterfall auction is the one phase in this game whose mechanics
// cannot be inferred by looking at it. A player can see six cards, a Buy
// button on the cheapest and Place Bid on the rest, and still have no idea
// what happens when the cheapest is bought -- because the cascade is a
// consequence, not a control. That is precisely the gap a tutorial should
// fill.
//
// The rule this file holds itself to: EXPLAIN CONSEQUENCES, NOT CONTROLS.
// A modal that says "click Buy to buy" is worse than nothing -- it trains
// players to dismiss tutorials unread, which then costs them the one that
// mattered. Every page here describes something that HAPPENS TO YOU, not
// something you press.
//
// ===================================================================
//  DESIGN NOTE 1: THE PREFERENCE IS GLOBAL AND PERSISTENT
// ===================================================================
//
// "Turn tutorials off" is deliberately a GLOBAL switch, not a per-tutorial
// "don't show this one again". Someone who does not want to be taught the
// auction does not want to be taught the stock round either, and making
// them refuse each one separately is the same annoyance repeated.
//
// It persists in `localStorage`, not `sessionStorage`: a tutorial that
// returns every time the tab is reopened has not really been dismissed.
// Storage access is wrapped because private browsing throws on access --
// in that case the preference simply does not persist, which is a
// degraded experience rather than a crash.
//
// SEEN-TRACKING IS SEPARATE FROM THE OFF SWITCH. A tutorial is shown once
// per player per topic (tracked by key) even with tutorials ON, because the
// alternative -- re-showing the auction explainer at the start of every
// auction -- is exactly the behaviour that makes people turn tutorials off
// in the first place.

import React, { useCallback, useEffect, useState } from "react";
import { CONTROL_PADDING, FONT_FAMILY, FONT_SIZE, LINE_HEIGHT } from "../styles/typography";

const TUTORIALS_OFF_KEY = "1830juno.tutorials_off.v1";
const SEEN_PREFIX = "1830juno.tutorial_seen.v1.";
/** Design note #412: opt-IN, and the polarity is the whole point -- see
 *  `tutorialMode` below. */
const TUTORIAL_MODE_KEY = "1830juno.tutorial_mode.v1";

function readFlag(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === "1";
  } catch {
    // Private browsing / storage disabled. Treat as "not set" -- the
    // tutorial shows, which is the safe direction for a first-time user.
    return false;
  }
}

function writeFlag(key: string, value: boolean): void {
  try {
    if (value) window.localStorage.setItem(key, "1");
    else window.localStorage.removeItem(key);
  } catch {
    /* see readFlag -- non-persistence is acceptable, a crash is not */
  }
}

/** Whether tutorials are globally suppressed. */
export function tutorialsDisabled(): boolean {
  return readFlag(TUTORIALS_OFF_KEY);
}

/* ==================================================================
 *  DESIGN NOTE 412: TUTORIAL MODE IS OPT-IN, AND NOTHING ELSE IS
 * ==================================================================
 *
 * REPORTED: clicking End Turn in an Operating Round yanks the player to the
 * Stock Market tab. It should only do that in a tutorial.
 *
 * The redirect is design note #44's, and its reasoning is sound for the
 * player it was written about: a first-time president watches their share
 * price move left, has no idea why, and reads it as their own mistake. The
 * lesson is about a number on another screen, so the tutorial navigates
 * there and opens on top of it.
 *
 * What it lacked was a way to say "I am not that player". Its three guards
 * -- is a president, first Operating Round, tutorial not already seen --
 * are all about the SITUATION, and every experienced player passes through
 * that situation exactly once per game while wanting none of it. Hijacking
 * the tab mid-turn is the most disruptive thing this app does to a player
 * who did not ask for it, which is why "they can dismiss the modal" is not
 * an answer: the navigation happens before the modal is on screen, and
 * dismissing it does not put the board back.
 *
 * THE POLARITY IS DELIBERATE. This is a THIRD flag rather than a reuse of
 * `tutorialsDisabled`, and the difference is the default. The off switch
 * defaults to false, so `!tutorialsDisabled()` is TRUE for everyone who has
 * never touched the setting -- which would leave the redirect firing for
 * exactly the standard play the requirement says to disable it for, while
 * looking as though it had been gated. Tutorial mode defaults to FALSE and
 * has to be turned on, so standard play is standard play without anyone
 * opting out of anything.
 *
 * THE MODAL ITSELF IS UNAFFECTED, and that split is the point. The
 * explainer still arms and still opens under its own existing rules; it is
 * a panel over the current screen and costs a player who does not want it
 * one click. Only the NAVIGATION is gated, because only the navigation
 * moves someone off the board they were looking at. */
export function tutorialModeEnabled(): boolean {
  return readFlag(TUTORIAL_MODE_KEY);
}

/** Turns tutorial mode on or off. Exported for a settings screen, and for
 *  symmetry with `resetTutorials` -- a flag with no writer is a flag that
 *  can only ever hold its default. */
export function setTutorialMode(enabled: boolean): void {
  writeFlag(TUTORIAL_MODE_KEY, enabled);
}

/** Clears both the global off switch and every per-topic seen flag, so the
 *  explainers come back. Nothing calls this yet -- exported so a settings
 *  screen can, rather than leaving players with a one-way door. */
export function resetTutorials(topicKeys: readonly string[]): void {
  writeFlag(TUTORIALS_OFF_KEY, false);
  for (const key of topicKeys) writeFlag(SEEN_PREFIX + key, false);
}

/* ==================================================================
 *  DESIGN NOTE 159: FORGETTING IS NOT THE SAME AS BEING TOLD TO STOP
 * ==================================================================
 *
 * REPORTED: the tutorials do not appear on the zero-state sandbox, which
 * is precisely where they should, because that scenario exists to be
 * experienced the way a new player would.
 *
 * The trigger was never broken -- `isWaterfallPhase` is true there and the
 * modal opens on it. What stops it is the SEEN flag, which persists in
 * `localStorage` across sessions by design, and which anyone who has run
 * this sandbox once has already set. The zero state resets the game and
 * had no way to reset the teaching.
 *
 * THIS DELIBERATELY DOES NOT CLEAR THE GLOBAL OFF SWITCH, which is the
 * whole reason it exists beside `resetTutorials` rather than reusing it.
 * The two flags record different things:
 *
 *   the SEEN flag   -- "I have read this one." A fact about progress
 *                      through a game, and starting a new game invalidates
 *                      it exactly as it invalidates the board.
 *   the OFF switch  -- "Stop showing me these." A standing preference
 *                      about the APPLICATION, which no in-game action
 *                      should quietly overturn.
 *
 * Clearing both would mean a player who ticked "turn tutorials off" gets
 * them back every time they open a fresh sandbox, which is the behaviour
 * that checkbox exists to prevent. */
export function replayTutorials(topicKeys: readonly string[]): void {
  for (const key of topicKeys) writeFlag(SEEN_PREFIX + key, false);
}

export interface TutorialPage {
  title: string;
  body: string;
}

/** The Waterfall Auction explainer -- design note #0's "consequences, not
 *  controls" rule applied: each page is a thing the auction does to you. */
export const WATERFALL_AUCTION_TUTORIAL: readonly TutorialPage[] = [
  {
    title: "Your three options",
    body:
      "In a waterfall auction, you either buy the lowest face-value private company at face value, " +
      "place a bid on a higher face-value company, or pass.",
  },
  {
    title: "The cascade",
    body:
      "When the lowest company is bought, the waterfall cascades. If a higher company has only one " +
      "bid, that player buys it. If it has multiple bids, a mini-auction begins.",
  },
  {
    title: "Where it stops",
    body:
      "This cascade continues until a company with no bids is reached, returning to normal " +
      "waterfall actions.",
  },
  {
    title: "When everybody passes",
    body:
      "Passing does not stall the auction — it moves it. If every player passes in a row " +
      "without anyone buying or bidding, three things happen before your turn comes back " +
      "around:\n" +
      "• The face value of the lowest unowned private company drops by $5. The auction is " +
      "designed to keep getting cheaper until somebody finally wants it.\n" +
      "• Every private company already owned immediately pays its printed revenue to its " +
      "owner. Passing is not free for the players still waiting: it pays the players who " +
      "already bought.\n" +
      "• If that price ever reaches $0, the player whose turn it is has no choice — they must " +
      "take the company for free.",
  },
  {
    title: "So passing has a cost",
    body:
      "Those two facts together are the whole tension of this phase. Waiting makes the cheapest " +
      "company cheaper, which is good for you — but it also hands income to everyone who " +
      "already committed, which is good for them. A private you keep refusing eventually " +
      "becomes free, and then it becomes yours whether you wanted it or not.",
  },
  {
    title: "Watch your cash",
    body:
      "You start this Auction with a set amount of personal cash (e.g., $600 in a 4-player " +
      "game). Be careful not to spend all of your cash in this Auction, or you won't have any " +
      "means to buy shares in public corporations in the upcoming Stock Round.",
  },
];

/** The Stock Round explainer. Design note #0's "consequences, not controls"
 *  rule holds: none of these pages tell you which button to press, they
 *  tell you what buying a first share, floating a company, or selling into
 *  the pool DOES to you. */
export const STOCK_ROUND_TUTORIAL: readonly TutorialPage[] = [
  {
    title: "The rhythm of the game",
    body:
      "Now that the Private Company auction is complete, the rest of the game will alternate " +
      "between Stock Rounds, when players buy and sell shares in railroad corporations, and " +
      "Operating Rounds, when those railroad corporations run.",
  },
  {
    title: "Buying shares",
    body:
      "In the Stock Round, you can choose to Buy 1 10% share of a corporation. If you are the " +
      "first to purchase a share in that corporation, you will buy the President's Share worth " +
      "20%, select a corporate IPO value, and pay double the IPO for the President's 20% share. " +
      "All other 10% shares will be sold at the IPO price.",
  },
  {
    title: "Floating a corporation",
    body:
      "Corporations only “float” when 60% of their shares have been purchased from the " +
      "IPO. By floating, the corporation receives 10 x IPO into its treasury and begins laying " +
      "tracks, buying trains, running routes, and paying dividends in the Operating Rounds. Be " +
      "sure not to stretch yourself too thin in the first Stock Round so that you can operate a " +
      "corporation in the first or second Operating Rounds.",
  },
  {
    title: "Selling shares",
    body:
      "Instead of buying shares, players can Sell shares to the Bank Pool:\n" +
      "• Selling stock drops the corporation's market value by 1 vertical cell per share " +
      "sold (down to any ledge/plateau). The seller receives the market price before the drop.\n" +
      "• Selling shares in a corporation prohibits you from buying shares in that " +
      "corporation for the rest of the Stock Round!\n" +
      "• The Bank Pool can never hold more than 50% of any corporation.\n" +
      "• You cannot sell shares if it would trigger a presidency change and no other player " +
      "holds at least 20%.",
  },
  {
    title: "Presidency & Market Mechanics",
    body:
      "• A player must hold the plurality of shares to be President. Ties preserve the " +
      "incumbent, but if another player exceeds your holdings, they claim the Presidency.\n" +
      "• End-of-Round Market Rise: If 100% of a corporation's shares are held by players at " +
      "the end of the Stock Round (both IPO and Bank Pool are completely empty), its stock price " +
      "rises vertically by 1 cell!",
  },
  {
    title: "Passing is not permanent",
    body:
      "Passing gives up your current turn, not the rest of the round. The moment any other " +
      "player buys or sells, the round keeps going and the turn comes back around to you — and " +
      "you are free to act on it, having just watched what everyone else did.\n" +
      "This makes an early pass a real tactic rather than a surrender: you can decline to " +
      "commit, see whether a rival floats the corporation you were eyeing, and still buy in " +
      "on your next turn.",
  },
  {
    title: "How a Stock Round actually ends",
    body:
      "A Stock Round ends only when EVERY player passes consecutively, with no buy or sell in " +
      "between. One purchase anywhere resets that count to zero and the round continues.\n" +
      "So the round does not run for a fixed number of turns — it runs until nobody in the " +
      "room wants to do anything else. If you are waiting for the round to end, remember that " +
      "one more purchase by anyone starts the whole counting over.",
  },
  {
    title: "The Priority Deal",
    body:
      "Whoever holds the Priority Deal acts FIRST in the next Stock Round — first pick of the " +
      "IPO, first chance to open a corporation at the par value you want. Look for the cyan " +
      "#1 beside a player's name in the Player Index and in Game Ledger > Player Assets.\n" +
      "It is not a reward for passing, and it is not random. At the end of a Stock Round the " +
      "Priority Deal moves to the player seated immediately to the LEFT of whoever took the " +
      "last action of that round. Acting last therefore hands the next round's opening move to " +
      "your neighbour — which is sometimes a price worth paying, and sometimes exactly the " +
      "mistake that loses you the corporation you were building toward.",
  },
];

/** The Operating Round explainer. Every page after the first uses hard line
 *  breaks to keep its numbered steps and bullets on separate lines -- see
 *  design note #4 for how the modal renders them. */
export const OPERATING_ROUND_TUTORIAL: readonly TutorialPage[] = [
  {
    title: "The turn sequence",
    body:
      "In the Operating Round, Presidents operate their corporations in stock price order. Each " +
      "round follows this exact sequence:\n" +
      "1. Buy Private Companies (Phase 3+ only)\n" +
      "2. Lay Track\n" +
      "3. Place Stations\n" +
      "4. Run Trains\n" +
      "5. Dividends\n" +
      "6. Buy Trains\n" +
      "Some steps are optional, but Run Trains and Dividends are mandatory if a corporation owns " +
      "a train and has a valid route. Corporations with no trains must buy a train during Step 6.",
  },
  {
    title: "Steps 1 and 2",
    body:
      "1. Buy Private Companies: Corporations may purchase private companies from players (at " +
      "50%\u2013200% face value) once Phase 3 begins.\n" +
      "2. Lay Track: Place yellow tiles or upgrade existing tiles following strict color " +
      "progression (Yellow -> Green -> Brown).\n" +
      "\u2022 Upgrade tiles must preserve all existing track connections.\n" +
      "\u2022 Laid tracks can never be downgraded or exchanged for other tracks of the same " +
      "type. Be careful when laying track to ensure your routes go where you want!",
  },
  {
    title: "Terrain Costs",
    body:
      "Terrain Costs: Some hexes have terrain obstacles (mountains, rivers). These terrain costs " +
      "are paid directly out of the Corporation's Treasury, NOT your personal player funds.",
  },
  {
    title: "Step 3: Place Stations",
    body:
      "3. Place Stations: Home stations are placed for free upon floating. Subsequent stations " +
      "cost $40 or $100 (limit 1 station per corporation per Operating Round turn). Stations " +
      "extend route connectivity. When all token slots in a city are occupied, only tokened " +
      "corporations may pass through; rival trains are blocked!",
  },
  {
    title: "Step 4: Run Trains",
    body:
      "4. Run Trains: Trains come in various sizes (2, 3, 4, 5, 6, and Diesel). These trains " +
      "generate revenue by running through a number of revenue centers up to their limit. (A " +
      "2-train runs through 2 centers; a Diesel runs through an unlimited number, blocked only " +
      "by rival stations).",
  },
  {
    title: "Revenue centers",
    body:
      "Revenue centers come in two types:\n" +
      "\u2022 Large Cities (White circles/pills): Hold station tokens. Payouts scale up to $90 " +
      "over time.\n" +
      "\u2022 Small Towns (Small black circles): Only ever pay out $10.\n" +
      "Both count equally toward your train's limit.",
  },
  {
    title: "Routing Rules",
    body:
      "1. A train cannot re-enter the same hex on a single run.\n" +
      "2. If you own multiple trains, they must use completely distinct routes (they cannot " +
      "share track).\n" +
      "Using the 'Autopath' button will automatically calculate the highest possible legal " +
      "revenue for your trains.",
  },
  {
    title: "Steps 5 and 6",
    body:
      "5. Dividends: Choose whether to Pay Out or Withhold revenue.\n" +
      "\u2022 Pay Out: Distributes revenue to shareholders ($ per 10% share) and advances the " +
      "stock price 1 cell to the right.\n" +
      "\u2022 Withhold: Retains 100% of revenue in the corporate treasury and drops the stock " +
      "price 1 cell to the left. Withholding is vital to build capital for trains, but paying " +
      "out increases player net worth to win the game!\n" +
      "6. Buy Trains: Purchase trains from the Bank Depot at face value, or from other " +
      "corporations at negotiated prices ($1+). Both are paid out of the Corporation's " +
      "Treasury, not your personal cash. You cannot buy a train that exceeds your train limit!",
  },
  {
    title: "Train Obsolescence & Rusting Rules",
    body:
      "• First 4-Train bought: All 2-Trains permanently rust and are removed from play!\n" +
      "• First 6-Train bought: All 3-Trains permanently rust!\n" +
      "• First Diesel bought: All 4-Trains permanently rust!\n" +
      "• 5-Trains, 6-Trains, and Diesels never rust (permanent).",
  },
  {
    title: "Emergency Train Purchases",
    body:
      "Emergency Train Purchases: If all your trains rust or you otherwise have no trains and " +
      "your Corporation Treasury is unable to afford one from the Bank or another corporation, " +
      "then you are personally liable for the Corporation's train purchase and must use your " +
      "personal cash and/or sell your shares to cover the train purchase. Watch out! You need " +
      "to keep an eye on trains rusting and maintain a viable fleet to prevent financial " +
      "misadventure.",
  },
  {
    title: "Phase Evolution & Limits",
    body:
      "• Purchasing larger trains advances the game era and unlocks tile upgrades (Green and " +
      "Brown).\n" +
      "• Phase changes DECREASE train limits per corporation (Phase 2 & 3: Limit 4 -> Phase " +
      "4: Limit 3 -> Phase 5+: Limit 2).\n" +
      "• All Private Companies close permanently when the first 5-Train is purchased.",
  },
];

/** The Stock Market explainer, shown on a FORCED navigation to the market
 *  chart the moment a president finishes their first Operating Round -- see
 *  `App.tsx` design note #44 for the trigger and why it is that moment.
 *
 *  Page 2 is written in the second person about something that has just
 *  happened, which is the whole reason this tutorial interrupts rather than
 *  waiting to be found: a first-time president watching their share price
 *  drop with no explanation reasonably concludes they played badly. */
export const STOCK_MARKET_TUTORIAL: readonly TutorialPage[] = [
  {
    title: "How prices move",
    body:
      "A corporation's stock price moves on this matrix based on its actions:\n" +
      "\u2022 1 cell Right: When it pays out dividends.\n" +
      "\u2022 1 cell Left: When it withholds dividends.\n" +
      "\u2022 1 cell Up: At the end of a Stock Round if 100% of its shares are held by " +
      "players.\n" +
      "\u2022 1 cell Down: For every single share sold by a player during a Stock Round.",
  },
  {
    title: "Why yours just moved left",
    body:
      "Because you just finished your first Operating Round, your stock price has moved one " +
      "space left. This is because your corporation did not own a train and could not pay out " +
      "revenue. Don't be alarmed: every corporation's share price moves left on its first turn " +
      "in 1830!",
  },
  {
    title: "Cliffs and ledges",
    body:
      "Notice the boundaries of the board. A cliff is a side edge of the matrix. If a price is " +
      "against a right cliff and would move right, it moves UP instead. If against a left cliff " +
      "and would move left, it moves DOWN instead. A ledge is the bottom of the matrix. If a " +
      "price sits on a ledge, it cannot drop any lower, even if more shares are sold.\n" +
      "Prices cannot move below the $10 floor or above the $350 ceiling.",
  },
];

/** Every topic key this app registers, so `resetTutorials()` can clear the
 *  whole set without a caller having to remember the list. */
/* ===================================================================
 *  DESIGN NOTE 158: THE TUTORIALS HAD NO FRONT DOOR
 * ===================================================================
 *
 * Every tutorial in this file opens exactly once -- automatically, when its
 * phase first becomes active, if the player has not seen it and has not
 * switched tutorials off. That is a good default and a terrible only
 * option: dismiss the Operating Round explainer while you think you have
 * understood it, discover ten minutes later that you have not, and there is
 * no way back to it. The content exists and is unreachable.
 *
 * `TUTORIAL_LIBRARY` gives it a front door. It is the same four page sets,
 * addressed by name instead of by phase, and it deliberately does NOT
 * consult the "seen" flags or the global off switch -- those exist to stop
 * tutorials INTERRUPTING, and a player who clicked "Tutorials" is not being
 * interrupted, they are asking.
 */
export interface TutorialTopic {
  topicKey: string;
  heading: string;
  /** One line on the picker, so a player can tell which of the four
   *  answers the question they actually have. */
  blurb: string;
  pages: readonly TutorialPage[];
}

export const TUTORIAL_LIBRARY: readonly TutorialTopic[] = [
  {
    topicKey: "waterfall-auction",
    heading: "Waterfall Auction",
    blurb: "How the private companies are bid for before the game proper starts.",
    pages: WATERFALL_AUCTION_TUTORIAL,
  },
  {
    topicKey: "stock-round",
    heading: "Stock Round",
    blurb: "Buying and selling shares, floating a corporation, and the Priority Deal.",
    pages: STOCK_ROUND_TUTORIAL,
  },
  {
    topicKey: "operating-round",
    heading: "Operating Round",
    blurb: "A corporation's turn: track, tokens, routes, dividends and trains.",
    pages: OPERATING_ROUND_TUTORIAL,
  },
  {
    topicKey: "stock-market",
    heading: "The Stock Market",
    blurb: "How share prices move, and what the zones on the chart mean.",
    pages: STOCK_MARKET_TUTORIAL,
  },
];

export const ALL_TUTORIAL_TOPICS: readonly string[] = [
  "waterfall-auction",
  "stock-round",
  "operating-round",
  "stock-market",
];

/* ------------------------------------------------------------------ */
/* The on-demand library -- design note #158                          */
/* ------------------------------------------------------------------ */

export interface TutorialLibraryProps {
  open: boolean;
  onClose: () => void;
}

/** The Tutorials front door: pick a topic, read it, come back to the list.
 *
 *  Renders the SAME page shell `TutorialModal` does, via `TutorialPager`
 *  below, so a tutorial read from here is not a second, subtly different
 *  presentation of the same words. What differs is only how you get in and
 *  what happens when you leave: no "seen" flag is written and no
 *  "turn tutorials off" checkbox is offered, because neither applies to
 *  content the player went looking for. */
export function TutorialLibrary({ open, onClose }: TutorialLibraryProps) {
  const [topicKey, setTopicKey] = useState<string | null>(null);

  // Escape backs out one level -- to the list from a topic, and out of the
  // library from the list. Matching the modal's own convention that Escape
  // never traps you, while still not throwing away your place in one step.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setTopicKey((current) => {
        if (current === null) onClose();
        return null;
      });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Reopening the library should land on the list, not wherever it was left.
  useEffect(() => {
    if (!open) setTopicKey(null);
  }, [open]);

  if (!open) return null;

  const topic = TUTORIAL_LIBRARY.find((entry) => entry.topicKey === topicKey) ?? null;

  return (
    <div
      style={styles.backdrop}
      role="dialog"
      aria-modal="true"
      aria-label={topic ? topic.heading : "Tutorials"}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div style={styles.card}>
        {topic ? (
          <TutorialPager
            heading={topic.heading}
            pages={topic.pages}
            onDone={() => setTopicKey(null)}
            doneLabel="Back to tutorials"
          />
        ) : (
          <>
            <div style={styles.header}>
              <span style={styles.heading}>Tutorials</span>
            </div>
            <div style={styles.body}>
              <p style={styles.pageBody}>
                Read any of these at any time. Opening one from here does not change whether it
                still appears automatically when its phase begins.
              </p>
              {TUTORIAL_LIBRARY.map((entry) => (
                <button
                  key={entry.topicKey}
                  type="button"
                  onClick={() => setTopicKey(entry.topicKey)}
                  style={styles.libraryRow}
                >
                  <span style={styles.libraryRowHeading}>{entry.heading}</span>
                  <span style={styles.libraryRowBlurb}>{entry.blurb}</span>
                  <span style={styles.libraryRowCount}>{entry.pages.length} pages</span>
                </button>
              ))}
            </div>
            <div style={styles.footer}>
              <button type="button" onClick={onClose} style={styles.primaryButton}>
                Close
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** The page-turner shell, shared by the auto-opening modal and the library
 *  so the two cannot drift into two different readers for one set of
 *  words. */
function TutorialPager({
  heading,
  pages,
  onDone,
  doneLabel,
  footerExtra,
}: {
  heading: string;
  pages: readonly TutorialPage[];
  onDone: () => void;
  doneLabel: string;
  /** The auto-opening modal's "turn tutorials off" control. The library
   *  passes nothing -- see `TutorialLibrary`'s own note. */
  footerExtra?: React.ReactNode;
}) {
  const [pageIndex, setPageIndex] = useState(0);
  const page = pages[Math.min(pageIndex, pages.length - 1)];
  const isLast = pageIndex >= pages.length - 1;
  if (!page) return null;

  return (
    <>
      <div style={styles.header}>
        <span style={styles.heading}>{heading}</span>
        <span style={styles.stepCount}>
          {pageIndex + 1} / {pages.length}
        </span>
      </div>

      <div style={styles.body}>
        <span style={styles.pageTitle}>{page.title}</span>
        {/* Design note #4: bodies may carry hard line breaks. The Operating
            Round pages are numbered step lists and bullet lists, and
            collapsing them into one run-on paragraph would undo the only
            structure they have. Split rather than `white-space: pre-line`
            so blank lines cannot open ragged vertical gaps, and so each
            line is a real block with its own spacing. */}
        {page.body.split("\n").map((line, index) => (
          <p key={index} style={styles.pageBody}>
            {line}
          </p>
        ))}
      </div>

      {/* Dots double as navigation -- a player who wants to re-read page 1
          should not have to click Back twice. */}
      <div style={styles.dots}>
        {pages.map((entry, index) => (
          <button
            key={entry.title}
            type="button"
            aria-label={`Go to step ${index + 1}`}
            aria-current={index === pageIndex}
            onClick={() => setPageIndex(index)}
            style={{ ...styles.dot, ...(index === pageIndex ? styles.dotActive : {}) }}
          />
        ))}
      </div>

      {footerExtra}

      <div style={styles.footer}>
        <button
          type="button"
          onClick={() => setPageIndex((index) => Math.max(0, index - 1))}
          disabled={pageIndex === 0}
          style={{
            ...styles.secondaryButton,
            // Inline styles cannot express `:disabled` (Lobby.tsx design
            // note #3), so the disabled look is computed.
            ...(pageIndex === 0 ? styles.buttonDisabled : {}),
          }}
        >
          Back
        </button>
        {isLast ? (
          <button type="button" onClick={onDone} style={styles.primaryButton}>
            {doneLabel}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => setPageIndex((index) => Math.min(pages.length - 1, index + 1))}
            style={styles.primaryButton}
          >
            Next
          </button>
        )}
      </div>
    </>
  );
}

export interface TutorialModalProps {
  /** Stable topic id -- also the per-topic "already seen" storage key. */
  topicKey: string;
  heading: string;
  pages: readonly TutorialPage[];
  /** Whether the phase this explains is currently active. The modal only
   *  ever appears while this is true. */
  active: boolean;
}

export function TutorialModal({ topicKey, heading, pages, active }: TutorialModalProps) {
  const seenKey = SEEN_PREFIX + topicKey;
  const [open, setOpen] = useState(false);
  const [turnOff, setTurnOff] = useState(false);

  // Opens once, when the phase becomes active, if tutorials are on and this
  // topic has not been seen. Keyed on `active` alone so re-renders during
  // the phase never re-open a modal the player has dismissed.
  useEffect(() => {
    if (!active) return;
    if (tutorialsDisabled() || readFlag(seenKey)) return;
    setOpen(true);
  }, [active, seenKey]);

  const dismiss = useCallback(() => {
    writeFlag(seenKey, true);
    if (turnOff) writeFlag(TUTORIALS_OFF_KEY, true);
    setOpen(false);
  }, [seenKey, turnOff]);

  // Escape closes, the same as Done. A modal that traps you until you find
  // its button is a modal people resent.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") dismiss();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, dismiss]);

  if (!open || pages.length === 0) return null;

  return (
    <div
      style={styles.backdrop}
      role="dialog"
      aria-modal="true"
      aria-label={heading}
      // Clicking the backdrop dismisses, matching Escape. The check keeps a
      // click that started inside the card from closing it on release.
      onClick={(event) => {
        if (event.target === event.currentTarget) dismiss();
      }}
    >
      <div style={styles.card}>
        {/* Design note #158: the page-turner is `TutorialPager`, shared with
            `TutorialLibrary`. It was inlined here until that note added the
            on-demand reader, at which point keeping it inline would have
            meant two independently-maintained copies of the same
            dots/Back/Next shell -- two readers for one set of words.

            `pageIndex` moved into the pager with it, which is why this
            component no longer holds one. */}
        <TutorialPager
          heading={heading}
          pages={pages}
          onDone={dismiss}
          doneLabel="Got it"
          footerExtra={
            <label style={styles.turnOffRow}>
              <input
                type="checkbox"
                checked={turnOff}
                onChange={(event) => setTurnOff(event.target.checked)}
              />
              <span>Turn tutorials off</span>
            </label>
          }
        />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Inline styles                                                      */
/* ------------------------------------------------------------------ */

const styles: Record<string, React.CSSProperties> = {
  backdrop: {
    position: "fixed",
    inset: 0,
    zIndex: 2000,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "24px",
    backgroundColor: "rgba(6, 8, 12, 0.72)",
    fontFamily: FONT_FAMILY,
  },
  card: {
    display: "flex",
    flexDirection: "column",
    gap: "14px",
    width: "min(560px, 100%)",
    padding: "22px 24px",
    borderRadius: "14px",
    backgroundColor: "#1b2130",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "#3a4055",
    boxShadow: "0 24px 64px rgba(0,0,0,0.6)",
    color: "#e6e8ef",
    boxSizing: "border-box",
  },
  header: { display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: "12px" },
  heading: { fontSize: FONT_SIZE.heading, fontWeight: 800 },
  stepCount: { fontSize: FONT_SIZE.small, color: "#8a90a0", fontVariantNumeric: "tabular-nums" },
  body: {
    display: "flex",
    flexDirection: "column",
    gap: "6px",
    // Design note #4: the Operating Round pages are several times longer
    // than the auction's. A fixed height would clip them; `maxHeight` plus
    // scroll keeps the modal a consistent size on short pages and readable
    // on long ones, instead of the card resizing under the player's cursor
    // every time they press Next.
    minHeight: "112px",
    maxHeight: "46vh",
    overflowY: "auto",
  },
  pageTitle: { fontSize: FONT_SIZE.strong, fontWeight: 700, color: "#c9a94c" },
  pageBody: { margin: 0, fontSize: FONT_SIZE.body, lineHeight: LINE_HEIGHT.normal, color: "#c7cbd4" },
  dots: { display: "flex", gap: "6px", justifyContent: "center" },
  dot: {
    width: "9px",
    height: "9px",
    padding: 0,
    borderRadius: "50%",
    border: "none",
    backgroundColor: "#3a4055",
    cursor: "pointer",
  },
  dotActive: { backgroundColor: "#c9a94c" },
  turnOffRow: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    fontSize: FONT_SIZE.small,
    color: "#9aa0ac",
    cursor: "pointer",
  },
  footer: { display: "flex", justifyContent: "flex-end", gap: "8px" },
  libraryRow: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: "3px",
    width: "100%",
    textAlign: "left",
    padding: "10px 12px",
    marginTop: "8px",
    borderRadius: "8px",
    border: "1px solid #3a4150",
    backgroundColor: "#1b2130",
    color: "#e2e6ee",
    fontFamily: "inherit",
    cursor: "pointer",
  },
  libraryRowHeading: { fontSize: FONT_SIZE.strong, fontWeight: 700 },
  libraryRowBlurb: { fontSize: FONT_SIZE.small, color: "#9aa0ac", lineHeight: 1.4 },
  libraryRowCount: {
    fontSize: FONT_SIZE.micro,
    color: "#6f7480",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  },
  primaryButton: {
    fontSize: FONT_SIZE.control,
    fontWeight: 700,
    padding: CONTROL_PADDING.button,
    borderRadius: "8px",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "#7a5aa8",
    backgroundColor: "#3a2a56",
    color: "#e8d8ff",
    cursor: "pointer",
  },
  secondaryButton: {
    fontSize: FONT_SIZE.control,
    fontWeight: 600,
    padding: CONTROL_PADDING.button,
    borderRadius: "8px",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "#3a4055",
    backgroundColor: "transparent",
    color: "#c7cbd4",
    cursor: "pointer",
  },
  buttonDisabled: { opacity: 0.4, cursor: "not-allowed" },
};

export default TutorialModal;
