// frontend/src/utils/privateExchange.ts
//
// THE PRIVATE THAT TURNS INTO A SHARE, and the one that arrives as one.
//
// ==================================================================
//  DESIGN NOTE 573: A BUTTON THAT SAYS "USED" HAS TO HAVE DONE SOMETHING
// ==================================================================
//
// REPORTED: clicking "Exchange for PRR" greyed the button to "Used" and did
// not grant the share. Same for the Mohawk & Hudson's NYC exchange.
//
// Neither ever could. `handleUsePrivateAbility`'s fallback branch added the
// action to `usedPrivateAbilities` and wrote a log line, and that was the
// whole implementation -- exactly the failure design note #444 records for
// the D&H's Place Station button: "this handler marked the ability spent and
// wrote a log line. There was no dispatch, no placement and no navigation --
// the button reported an action it had not performed."
//
// The two hex-targeting powers were fixed then. The two EXCHANGES were left
// on the fallback, so the same bug survived in the two places that were
// hardest to notice: a share arriving silently is easy to miss, and the
// private staying in the panel looks like it is merely spent rather than
// like nothing happened.
//
// ==================================================================
//  DESIGN NOTE 573a: EXCHANGED IS NOT SPENT
// ==================================================================
//
// "Used" was also the wrong VOCABULARY, and the report says so precisely:
// "since the private company is EXCHANGED, it should be removed from the
// player's Private Powers (not simply 'Used') as well as their
// certificates/inventory."
//
// The D&H's two powers are spent -- the company stays, the ability is gone,
// and a greyed row is the honest rendering. An exchange consumes the COMPANY:
// it is handed back and becomes a share certificate. A closed private that
// goes on sitting in the panel greyed out is claiming the player still owns
// something they traded away, and it goes on counting toward their
// certificate total and their assets.
//
// So `closed` is set, which every reader already honours -- the panel filters
// on it, the ledger drops it, and `playerPrivateCompanies` stops returning
// it. One field, and the company leaves every surface at once.
//
// ==================================================================
//  DESIGN NOTE 573b: A REFUSAL IS NOT A USE
// ==================================================================
//
// REPORTED, as a hypothesis for why nothing happened: "this might be because
// the player is already at the ownership limit (60%), but in that case the
// Exchange button should return an error that they are at the limit and the
// power should be maintained for a subsequent round."
//
// That is the right shape whatever the cause, and it is the half a
// mark-it-used implementation can never get right: the power is not spent by
// ATTEMPTING it. A player at 60% now may be under it next round, and burning
// the ability on a refused click destroys a real asset.
//
// So legality is decided BEFORE anything is written, the reason comes back
// as a sentence the panel can show, and nothing is marked on a refusal.

import type { GameStateResponse } from "./gameState";

/** 1830: no player may hold more than 60% of one corporation. */
export const PLAYER_HOLDING_CAP_PERCENT = 60;
/** One certificate. */
export const EXCHANGE_SHARE_PERCENT = 10;

/* ==================================================================
 *  DESIGN NOTE 576: THE CAMDEN & AMBOY WAS NEVER AN EXCHANGE
 * ==================================================================
 *
 * REPORTED: "Private Company 5 is supposed to come with a 10% share of a
 * corporation; however, the winner of that auction does not receive
 * anything."
 *
 * Correct, and this table was mine and wrong. The previous pass built the
 * exchange machinery for BOTH the Mohawk & Hudson and the Camden & Amboy,
 * on the strength of `PrivatePowerPanel`'s design note #350 -- "the owner
 * may exchange this private for a 10% share of the PRR. The exchange closes
 * this private permanently."
 *
 * `privateCatalog.ts` said the opposite, in a line THIS SAME AUTHOR had
 * rewritten two passes earlier (design note #548): "Whoever buys it out of
 * the auction is handed a 10% PRR share at once and at no further cost.
 * Nothing is triggered and the company stays open." That is 1830's actual
 * rule, and design note #360 had recorded it explicitly as one of the four
 * things an older paraphrase got wrong: "C&A was described as an ability
 * the owner triggers. It is not: the share arrives on PURCHASE and the
 * private stays open."
 *
 * So the fact existed in two places, the two disagreed, and the build
 * followed the wrong one -- the TD-1 failure this codebase keeps recording,
 * committed while writing a note about it. Two consequences worth naming:
 * the share never arrived (the panel's button was in a round the auction
 * had already left), and had it ever fired it would have CLOSED a company
 * 1830 keeps open and paying $25 a round.
 *
 * ONE ENTRY NOW. The M&H genuinely is an exchange -- a player trades the
 * company away for the certificate, and it closes. The C&A is a purchase
 * bonus and is granted where the auction resolves, not from a button.
 */
export const PRIVATE_EXCHANGES: Readonly<
  Record<number, { ticker: string; corporationName: string }>
> = {
  4: { ticker: "NYC", corporationName: "New York Central" },
};

/** Design note #576: the Camden & Amboy's purchase bonus. Not an exchange --
 *  the company stays open and goes on paying, and the share is free. */
export const CA_PRIVATE_ID = 5;
export const CA_BONUS_TICKER = "PRR";

export interface ExchangeRefusal {
  ok: false;
  /** A whole sentence, for the player. */
  reason: string;
}

export interface ExchangeGrant {
  ok: true;
  privateId: number;
  companyId: number;
  ticker: string;
  player: string;
  /** Where the certificate comes from -- the IPO first, then the pool. */
  source: "Ipo" | "Bank";
  /** Design note #576: the C&A's bonus leaves the company open and paying.
   *  Default (absent/false) closes it, which is the M&H's exchange. */
  keepOpen?: boolean;
}

export type ExchangeOutcome = ExchangeRefusal | ExchangeGrant;

/** Can this player exchange this private right now, and for what?
 *
 *  PURE, and separate from the state change on purpose: the panel wants to
 *  show the reason on a disabled button BEFORE the click, and the dispatch
 *  wants the same answer at the moment it fires. One function asked twice
 *  cannot drift the way a disabled-check and a guard would. */
export function resolvePrivateExchange(
  state: GameStateResponse | null,
  privateId: number,
  player: string,
): ExchangeOutcome {
  const target = PRIVATE_EXCHANGES[privateId];
  if (!target) return { ok: false, reason: "This private cannot be exchanged." };
  if (!state) return { ok: false, reason: "No game state yet." };

  const priv = state.private_companies.find((entry) => entry.private_id === privateId);
  if (!priv) return { ok: false, reason: "That private company is not in this game." };
  if (priv.closed) return { ok: false, reason: `The ${priv.name} has already been exchanged.` };
  if (priv.owner !== player) {
    return { ok: false, reason: `The ${priv.name} is not yours to exchange.` };
  }

  const company = state.public_companies.find((entry) => entry.ticker === target.ticker);
  if (!company) {
    return { ok: false, reason: `The ${target.corporationName} is not in this game.` };
  }

  const held = company.player_holdings
    .filter((entry) => entry.player === player)
    .reduce((sum, entry) => sum + entry.percentage, 0);
  if (held + EXCHANGE_SHARE_PERCENT > PLAYER_HOLDING_CAP_PERCENT) {
    /* Design note #573b: the reason names the NUMBER, because "you are at
       the limit" leaves the player checking it themselves -- and says the
       power survives, because the whole point of refusing rather than
       spending is that they can come back to it. */
    return {
      ok: false,
      reason:
        `You already hold ${held}% of the ${target.ticker} and no player may exceed ` +
        `${PLAYER_HOLDING_CAP_PERCENT}%. Sell a share first — the exchange stays available.`,
    };
  }

  /* IPO FIRST, THEN THE POOL. 1830's exchange takes a certificate from the
     bank or the pool, and the IPO is the pile that exists from the start --
     taking from the pool while the IPO still holds shares would quietly
     shrink the supply a player can buy at par. */
  const source: "Ipo" | "Bank" | null =
    company.ipo_pool_percentage >= EXCHANGE_SHARE_PERCENT
      ? "Ipo"
      : company.bank_pool_percentage >= EXCHANGE_SHARE_PERCENT
        ? "Bank"
        : null;
  if (source === null) {
    return {
      ok: false,
      reason:
        `No ${target.ticker} certificate is available in the IPO or the bank pool. ` +
        `The exchange stays available.`,
    };
  }

  return {
    ok: true,
    privateId,
    companyId: company.company_id,
    ticker: target.ticker,
    player,
    source,
  };
}

/** Performs the exchange: the share arrives, the private closes.
 *
 *  Returns the state unchanged when the grant does not apply, so a replayed
 *  duplicate is a no-op rather than a second certificate. */
export function applyPrivateExchange(
  state: GameStateResponse,
  grant: ExchangeGrant,
): GameStateResponse {
  const priv = state.private_companies.find((entry) => entry.private_id === grant.privateId);
  if (!priv || priv.closed) return state;

  return {
    ...state,
    public_companies: state.public_companies.map((company) => {
      if (company.company_id !== grant.companyId) return company;
      const existing = company.player_holdings.find((entry) => entry.player === grant.player);
      return {
        ...company,
        player_holdings: existing
          ? company.player_holdings.map((entry) =>
              entry.player === grant.player
                ? { ...entry, percentage: entry.percentage + EXCHANGE_SHARE_PERCENT }
                : entry,
            )
          : [...company.player_holdings, { player: grant.player, percentage: EXCHANGE_SHARE_PERCENT }],
        /* The certificate leaves whichever pile it came from. Not both, and
           not neither -- a share that appears in a hand without leaving a
           pile is a share this game has one too many of. */
        ipo_pool_percentage:
          grant.source === "Ipo"
            ? Math.max(0, company.ipo_pool_percentage - EXCHANGE_SHARE_PERCENT)
            : company.ipo_pool_percentage,
        bank_pool_percentage:
          grant.source === "Bank"
            ? Math.max(0, company.bank_pool_percentage - EXCHANGE_SHARE_PERCENT)
            : company.bank_pool_percentage,
      };
    }),
    /* Design note #573a: CLOSED, and the owner released with it. Every
       reader already honours `closed`, so the company leaves the powers
       panel, the ledger and the certificate count in one write. */
    /* Design note #576: `keepOpen` is the Camden & Amboy, whose share is a
       purchase bonus rather than a trade -- closing it would cost its owner
       $25 an Operating Round for the rest of the game. Everything else is
       the Mohawk & Hudson's exchange, which does consume the company. */
    private_companies: grant.keepOpen
      ? state.private_companies
      : state.private_companies.map((entry) =>
          entry.private_id === grant.privateId
            ? { ...entry, closed: true, owner: null, owner_protocol_id: null }
            : entry,
        ),
  };
}
