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
import { DOUBLE_CERTIFICATE_PERCENT, doubleCertificateAt } from "./doubleCertificate";

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
  /* DA-5 (DA-F6): A CERTIFICATE THE PILE DOES NOT HOLD IS NOT GRANTED. The two subtractions below are floored at
     zero, so a pile short of 10% gave the holder a share and removed less than one -- probe Q2's PRR at 110%, the
     board SET-0A's appraiser refuses. Every caller now names a pile it has checked (`resolvePrivateExchange`,
     `camdenGrantSource`); this is the boundary that makes minting impossible rather than merely avoided. */
  const target = state.public_companies.find((company) => company.company_id === grant.companyId);
  const pile = grant.source === "Ipo" ? target?.ipo_pool_percentage : target?.bank_pool_percentage;
  if (!target || !(Number(pile) >= EXCHANGE_SHARE_PERCENT)) return state;

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

/* ==================================================================
    DA-5 (D-52, DA-F6): THE C&A'S PRR CERTIFICATE -- RESERVED UNDER THE DELAYED AUCTION, GRANTED WITHOUT MINTING
   ==================================================================
   OWNER RULING D-52 (OD-DA-1): "Reserve one specific 10% PRR certificate from setup until C&A's initial purchase.
   It is unavailable for ordinary stock purchase while reserved. When C&A is acquired, transfer that reserved
   certificate to the buyer and run the ordinary post-share consequences, including float and presidency
   reconciliation if applicable. The reserved certificate counts as sold only when granted."

   THE SMALLEST REPRESENTATION: the certificate stays in the PRR's IPO and the IPO says one of its certificates is
   held back (`reserved_certificate`). So the bank still owns it -- the float measure (`100 - ipo`) counts it unsold,
   the sold-out rise sees the IPO non-empty, holdings + IPO + pool stay 100% -- and `ordinaryPercentAvailable` keeps
   every ordinary purchase off it. Granting moves exactly that 10% from the IPO and lifts the reservation; D-55
   lifts it without moving anything when the C&A closes unsold. Nothing is created and nothing is duplicated.

   THE STANDARD GAME HAS NO RESERVATION: its auction precedes every Stock Round, so the PRR's IPO holds the whole
   corporation when the C&A sells and the certificate comes from it, as it always did. The old "IPO if it holds
   10%, otherwise the Bank Pool" fallback is kept only for that no-reservation path, and asks for an ORDINARY
   certificate in either pile; a pile without one grants nothing rather than floor itself below zero (DA-F6). */

/** D-52: the reserved certificate's size -- one ordinary PRR certificate. */
export const CA_RESERVED_PERCENT = EXCHANGE_SHARE_PERCENT;

/** D-52: the Delayed Auction's deal holds one ordinary PRR certificate back for the C&A. Identity when there is no
 *  PRR or it is already reserved. */
export function withCamdenReservation(state: GameStateResponse): GameStateResponse {
  const prr = state.public_companies.find((company) => company.ticker === CA_BONUS_TICKER);
  if (!prr || prr.reserved_certificate) return state;
  return {
    ...state,
    public_companies: state.public_companies.map((company) =>
      company.company_id === prr.company_id
        ? { ...company, reserved_certificate: { private_id: CA_PRIVATE_ID, percentage: CA_RESERVED_PERCENT } }
        : company,
    ),
  };
}

/** D-55: every certificate held back for a private that can no longer be sold goes back to ordinary supply -- the
 *  reservation is lifted; the certificate never left the IPO. Identity when nothing is reserved. */
export function releaseReservedCertificates(state: GameStateResponse): GameStateResponse {
  if (!state.public_companies.some((company) => company.reserved_certificate)) return state;
  return {
    ...state,
    public_companies: state.public_companies.map((company) =>
      company.reserved_certificate ? { ...company, reserved_certificate: undefined } : company,
    ),
  };
}

/** DA-5 (D-52, DA-F6): the pile the C&A's PRR certificate comes from, or `null` when no certificate exists to give. */
export function camdenGrantSource(
  state: GameStateResponse,
): { companyId: number; source: "Ipo" | "Bank"; reserved: boolean } | null {
  const prr = state.public_companies.find((company) => company.ticker === CA_BONUS_TICKER);
  if (!prr) return null;
  const reserved = prr.reserved_certificate;
  if (reserved && reserved.private_id === CA_PRIVATE_ID) {
    return prr.ipo_pool_percentage >= reserved.percentage
      ? { companyId: prr.company_id, source: "Ipo", reserved: true }
      : null;
  }
  const double = (pool: "Ipo" | "Bank") => (doubleCertificateAt(prr) === pool ? DOUBLE_CERTIFICATE_PERCENT : 0);
  const ipoOrdinary = prr.ipo_pool_percentage - (prr.president === null ? 20 : 0) - double("Ipo");
  if (ipoOrdinary >= EXCHANGE_SHARE_PERCENT) return { companyId: prr.company_id, source: "Ipo", reserved: false };
  const poolOrdinary = prr.bank_pool_percentage - double("Bank");
  if (poolOrdinary >= EXCHANGE_SHARE_PERCENT) return { companyId: prr.company_id, source: "Bank", reserved: false };
  return null;
}

/** DA-5: the SHARE half of a private company's purchase benefit -- the C&A's PRR certificate, the one private whose
 *  purchase grants a share -- moved and conserved, the reservation lifted when it was the reserved certificate.
 *  The consequences of the share (float, presidency) are the caller's, through the machinery a purchase uses.
 *  Identity for any other private, and when there is no certificate to give. */
export function applyPrivateBenefitGrant(
  state: GameStateResponse,
  privateId: number,
  player: string,
): GameStateResponse {
  if (privateId !== CA_PRIVATE_ID) return state;
  const grant = camdenGrantSource(state);
  if (!grant) return state;
  const moved = applyPrivateExchange(state, {
    ok: true,
    privateId,
    companyId: grant.companyId,
    ticker: CA_BONUS_TICKER,
    player,
    source: grant.source,
    keepOpen: true,
  });
  if (moved === state || !grant.reserved) return moved;
  return {
    ...moved,
    public_companies: moved.public_companies.map((company) =>
      company.company_id === grant.companyId ? { ...company, reserved_certificate: undefined } : company,
    ),
  };
}
