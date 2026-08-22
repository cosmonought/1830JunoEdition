// frontend/src/utils/autoPass.ts
//
// A standing instruction to pass, and the things that cancel it.
//
// Design note #717: AUTO-PASS, AND WHAT WAKES IT.
//
// REQUESTED, borrowing 18xx.games: "Auto Actions attempt to operate in a fail-safe mode, deactivating if
// other players take actions that would affect you." Auto-Pass passes a player's turn unless (i) shares are
// sold in a corporation of theirs or (ii) shares are bought in one they preside over but could be out-bought.
//
// THE FAIL-SAFE IS THE WHOLE DESIGN, and it is why this is a snapshot comparison rather than a rule about the
// current board. "Would affect you" is a statement about CHANGE: a corporation that was already 50% pooled
// when the instruction was given is not news, and a player who armed Auto-Pass knowing that is not asking to
// be woken by it. So arming records what the board looked like, and every later turn asks what moved.
//
// A TRIP DISARMS, it does not merely skip one turn. Waking a player for a threat and then passing them again
// next turn -- into the consequences of that same threat -- would be the opposite of fail-safe. The caller
// clears the arm; this module reports the reason so the caller can say why.
//
// TWO TOGGLES, AND ONE GUARANTEE. Reported: "if we are giving people toggles, then 1 and 2 would both be
// useful" -- so a SALE wakes on ANY corporation the player holds, or only on ones they PRESIDE over, as
// separate switches. They overlap deliberately: the wide one is about protecting a share price, the narrow one
// about defending a company, and a player may want the second without the noise of the first.
//
// A PRESIDENCY IS NOT A TOGGLE. Reported: "Auto-Pass should never allow a player to lose the presidency of a
// corporation -- that should be something they manually choose to do." That is an OUTCOME that must not
// happen, and an outcome cannot be left to a checkbox: an earlier draft made this condition (ii) and offered
// it switchable, which meant the off position permitted precisely the thing now forbidden. So it is no longer
// offered. It is a guarantee, stated in the modal rather than voted on.
//
// AND THE GUARANTEE READS THE BOARD, NOT THE DIFF. This is the one check here that cannot be a snapshot
// comparison, and the reason is turn order. A rival taking a presidency IS a change, so a diff would catch
// it -- on the player's NEXT turn, one turn after the company changed hands. By then there is nothing to
// decide. To stop a loss rather than report one, the question has to be asked BEFORE the pass, about the board
// as it stands: is this presidency takeable by the players who act between now and my next turn. The snapshot
// philosophy holds everywhere else and is wrong exactly here, because everywhere else the cost of being late
// is a missed opportunity and here it is a company.
//
// IT EXPIRES WITH THE STOCK ROUND. Reported: "it should only run until the end of a Stock Round: players
// should have to set it every Stock Round." A standing instruction that survives into a round whose board the
// player has never seen is exactly the kind of thing they would forget was on -- so the arm carries the round
// it was made in, and a different round is a wake in itself.
//
// NOT GAME STATE. This is one viewer's preference about their own client, not a move and not a fact any other
// player replays. It never enters the log. What DOES enter the log is the `PassTurn` it dispatches, which is
// an ordinary turn like any other -- authored by the player, undoable, indistinguishable after the fact from
// a pass they clicked. That is deliberate: the table should not be able to tell who was watching.
//
// See docs/ai_architecture/state_machine.md, autoPass.ts #717.

import type { GameStateResponse } from "./gameState";

/** A 10% certificate -- the smallest step a rival's holding can take. */
const SHARE_PERCENT = 10;

export interface AutoPassConditions {
  /** Wake when shares are sold into ANY corporation this player holds. */
  saleInHeld: boolean;
  /** Wake when shares are sold into one they PRESIDE over. Narrower, and useful without the first. */
  saleInPresided: boolean;
}

export const DEFAULT_AUTO_PASS_CONDITIONS: AutoPassConditions = {
  saleInHeld: true,
  saleInPresided: true,
};

/** What one corporation looked like when the instruction was given. */
interface CompanySnapshot {
  poolPercent: number;
  president: string | null;
  /** Every player's holding, so a rival's PURCHASE is visible as well as the pool's total. */
  holdings: Readonly<Record<string, number>>;
}

export interface AutoPassArm {
  player: string;
  /** The Stock Round this was armed in. A different one expires it. */
  macroRoundNumber: number;
  conditions: AutoPassConditions;
  snapshot: Readonly<Record<number, CompanySnapshot>>;
}

/** Photograph the board. Taken at ARM time and never refreshed while armed -- a snapshot that crept forward
 *  with each turn would only ever report the last player's action, and the point is to catch everything that
 *  happened while the player was not looking. */
export function snapshotForAutoPass(
  state: GameStateResponse,
): Readonly<Record<number, CompanySnapshot>> {
  const out: Record<number, CompanySnapshot> = {};
  for (const company of state.public_companies) {
    const holdings: Record<string, number> = {};
    for (const entry of company.player_holdings) holdings[entry.player] = entry.percentage;
    out[company.company_id] = {
      poolPercent: company.bank_pool_percentage,
      president: company.president ?? null,
      holdings,
    };
  }
  return out;
}

export function armAutoPass(
  state: GameStateResponse,
  player: string,
  conditions: AutoPassConditions,
): AutoPassArm {
  return {
    player,
    macroRoundNumber: state.macro_round_number,
    conditions,
    snapshot: snapshotForAutoPass(state),
  };
}

/** Whether this president could be overtaken in this corporation.
 *
 *  THE TEST IS ONE PURCHASE AWAY, not "could anybody ever catch up". A presidency passes to a player holding
 *  MORE than the president, so a rival at 30% against a president at 40% is one certificate from tying and two
 *  from taking it, while a rival already level is one certificate from taking it outright. `+ SHARE_PERCENT >
 *  mine` is that margin -- in ten-percent certificates it fires exactly when a rival has drawn LEVEL, which is
 *  the last moment a president can still act.
 *
 *  A TIE IS THE TRIGGER, AND A TIE IS NOT A LOSS. Confirmed in review: "Auto-Pass should never allow a player
 *  to lose the presidency of a corporation ... so I think cutting it on a tie is a good choice." The two halves
 *  fit: stopping at the tie leaves the president holding the company, with the turn in their hands, one
 *  purchase before it could go.
 *
 *  AND THERE MUST BE A SHARE TO BUY. With the IPO empty and the pool empty, nobody can move, and waking a
 *  player for a threat that cannot be executed is the noise this feature exists to remove. */
export function isInsecurePresidency(
  company: {
    president: string | null;
    ipo_pool_percentage: number;
    bank_pool_percentage: number;
    player_holdings: readonly { player: string; percentage: number }[];
  },
  player: string,
): boolean {
  if (company.president !== player) return false;
  const available = company.ipo_pool_percentage + company.bank_pool_percentage;
  if (available < SHARE_PERCENT) return false;
  const mine = company.player_holdings.find((entry) => entry.player === player)?.percentage ?? 0;
  return company.player_holdings.some(
    (entry) => entry.player !== player && entry.percentage + SHARE_PERCENT > mine,
  );
}

/** Every corporation this player presides over that could be taken before their next turn.
 *
 *  Read off the CURRENT board rather than a diff -- see the header. Returned as tickers because both callers
 *  want to name them: the decision puts one in a wake reason, and the modal lists them to explain why
 *  Auto-Pass will not start. */
export function exposedPresidencies(
  state: GameStateResponse,
  player: string,
): readonly string[] {
  return state.public_companies
    .filter((company) => isInsecurePresidency(company, player))
    .map((company) => company.ticker);
}

export interface AutoPassDecision {
  /** Dispatch the pass. */
  pass: boolean;
  /** Why not, when `pass` is false. `null` when passing. The caller shows it and disarms. */
  wakeReason: string | null;
}

const PASS: AutoPassDecision = { pass: true, wakeReason: null };

/** Whether this armed instruction still stands.
 *
 *  EVERY "NO" DISARMS. There is no state in which this returns `pass: false` and the caller should keep the
 *  instruction: an expired round, a board that moved, a corporation that changed hands -- each is a reason the
 *  player should look at the board themselves, and re-arming is one click. */
export function autoPassDecision(
  state: GameStateResponse,
  arm: AutoPassArm,
): AutoPassDecision {
  /* THE ROUND FIRST, because it is a reason to stop that has nothing to do with the board. */
  if (state.macro_round_number !== arm.macroRoundNumber) {
    return { pass: false, wakeReason: "Auto-Pass expired with the Stock Round — set it again to keep passing." };
  }

  /* THE GUARANTEE, ahead of every toggle and answerable by none of them. Passing a turn while a rival is one
     certificate from a presidency hands them the chance to take it, and losing a company is a thing a player
     chooses, never a thing a convenience does to them. */
  const exposed = exposedPresidencies(state, arm.player);
  if (exposed.length > 0) {
    const list = exposed.join(", ");
    return {
      pass: false,
      wakeReason:
        exposed.length === 1
          ? `Your ${list} presidency could be taken on the next purchase — that is a turn to play yourself.`
          : `Your ${list} presidencies could be taken on the next purchase — those are turns to play yourself.`,
    };
  }

  for (const company of state.public_companies) {
    const before = arm.snapshot[company.company_id];
    // A corporation that did not exist at arm time is news by itself, but not the kind these toggles name.
    if (!before) continue;

    const mine =
      company.player_holdings.find((entry) => entry.player === arm.player)?.percentage ?? 0;
    const held = mine > 0;
    const presides = company.president === arm.player;

    /* ---- (i) A SALE. Shares sold by anybody land in the bank pool, so the pool GROWING is the sale, whoever
       made it -- including this player's own earlier turn, which is why the snapshot is taken at arm time and
       the player is not expected to auto-pass through their own trading. */
    const poolGrew = company.bank_pool_percentage > before.poolPercent;
    if (poolGrew) {
      if (arm.conditions.saleInHeld && held) {
        return {
          pass: false,
          wakeReason: `Shares were sold into the ${company.ticker} pool, and you hold ${mine}%.`,
        };
      }
      if (arm.conditions.saleInPresided && presides) {
        return {
          pass: false,
          wakeReason: `Shares were sold into the ${company.ticker} pool, and you are its President.`,
        };
      }
    }

    /* ---- A PURCHASE INTO AN INSECURE PRESIDENCY was condition (ii) here, and switchable. It has moved above
       the loop and out of the player's hands: see the header. Nothing is lost by the move -- the old branch
       additionally required a rival's holding to have GROWN since the snapshot, which was a way of asking
       "is this news" about a situation where the only question that matters is "is it true now". */

    /* ---- THE PRESIDENCY ITSELF MOVED. The backstop behind the guarantee, not a substitute for it: this fires
       AFTER a company has changed hands, which is why the check above exists to make sure it never has to.
       Kept because a presidency can move by routes the exposure test does not model -- a dumped block, a
       liquidation, a player leaving -- and a player looking at a different game from the one they armed this in
       should be looking at it themselves. */
    if (before.president === arm.player && company.president !== arm.player) {
      return { pass: false, wakeReason: `You are no longer President of ${company.ticker}.` };
    }
  }

  return PASS;
}
