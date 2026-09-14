// The private that turns into a share, and the one that arrives as one.
//
// Design note #573: `handleUsePrivateAbility`'s fallback branch marked the
// ability spent and wrote a log line, and that was the whole implementation --
// the same failure design note #444 records for the D&H's Place Station button.
// The two hex-targeting powers were fixed then; the two EXCHANGES were left on
// the fallback, surviving in the two places hardest to notice.
//
// Design note #573a: EXCHANGED IS NOT SPENT. The D&H's powers are spent -- the
// company stays and a greyed row is honest. An exchange consumes the COMPANY, so
// `closed` is set and it leaves the powers panel, the ledger and the certificate
// count in one write.
//
// Design note #573b: A REFUSAL IS NOT A USE. The power is not spent by
// ATTEMPTING it -- a player at 60% now may be under it next round, and burning
// the ability on a refused click destroys a real asset. Legality is decided
// BEFORE anything is written and nothing is marked on a refusal.
//
// See docs/ai_architecture/contract_economy.md, privateExchange.ts #573.

import type { GameStateResponse } from "./gameState";

/** 1830: no player may hold more than 60% of one corporation. */
export const PLAYER_HOLDING_CAP_PERCENT = 60;
/** One certificate. */
export const EXCHANGE_SHARE_PERCENT = 10;

/* Design note #576: the Camden & Amboy was never an exchange. The previous pass
   built exchange machinery for both it and the Mohawk & Hudson on the strength
   of `PrivatePowerPanel`'s design note #350, while `privateCatalog.ts` said the
   opposite in a line this same author had rewritten two passes earlier (#548):
   the C&A's 10% PRR share "arrives on PURCHASE and the private stays open"
   (#360). The fact existed in two places, the two disagreed, and the build
   followed the wrong one.

   Two consequences: the share never arrived, and had the button ever fired it
   would have CLOSED a company 1830 keeps open and paying $25 a round. ONE ENTRY
   NOW -- the M&H genuinely is an exchange; the C&A is a purchase bonus granted
   where the auction resolves. */
/** The Mohawk & Hudson. Named here rather than inline in the shell for the reason `DH_PRIVATE_ID` is named
 *  in `dhPower.ts`: a bare `4` in a condition is a fact nobody can grep for. */
export const MH_PRIVATE_ID = 4;

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
 *  PURE, and separate from the state change on purpose: the panel wants the
 *  reason on a disabled button BEFORE the click, and the dispatch wants the same
 *  answer at the moment it fires. One function asked twice cannot drift the way a
 *  disabled-check and a guard would. */
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
    /* Design note #573a: CLOSED, and the owner released with it -- every reader
       already honours `closed`, so the company leaves the powers panel, the ledger
       and the certificate count in one write.
       Design note #576: `keepOpen` is the Camden & Amboy, whose share is a purchase
       bonus rather than a trade -- closing it would cost its owner $25 an Operating
       Round for the rest of the game. */
    private_companies: grant.keepOpen
      ? state.private_companies
      : state.private_companies.map((entry) =>
          entry.private_id === grant.privateId
            ? { ...entry, closed: true, owner: null, owner_protocol_id: null }
            : entry,
        ),
  };
}
