// Forced sales, bankruptcy, and how a game of 1830 is scored when it stops.
//
// Design note #0: the funding cascade is an ORDER, not a total -- the whole
// corporate treasury, then the president's personal cash, then forced stock
// sales. A previous pass computed the shortfall correctly and then treated cash
// and shares as one pool of "resources", which is the right total and the wrong
// model: it cannot say which shares must be sold, or how many.
//
// Design note #1: two restrictions bound the forced sale and they bite
// differently. The president's certificate is CONDITIONAL, not banned (#6). And
// the bank pool caps at 50%, so what a player can sell depends on what OTHER
// players have already dumped there. The tighter one wins per company -- a
// president can be bankrupted holding a fortune in unsellable paper.
//
// Design note #6: the presidency CAN be dumped, under two conditions, both
// required. A SUCCESSOR EXISTS -- some other SINGLE player on 20%+, never a sum
// of two players on 10%. And THE POOL HAS ROOM FOR THE WHOLE BLOCK -- it is one
// certificate worth 20% and cannot be split, which a naive
// `min(held, poolRoom)` gets wrong. #1 originally reasoned the certificate could
// never move because a transfer "needs a buyer who already holds 20%"; the first
// half is right and the second does not follow.
//
// See docs/ai_architecture/stock_market.md, endgame.ts #0 / #1 / #6.

import type { GameStateResponse } from "./gameState";

/** 1830: no more than half of any company's shares may sit in the pool. */
export const BANK_POOL_CAP_PERCENT = 50;
/** The presidential block. ONE certificate worth 20%, indivisible -- design
 *  note #6. Also the minimum holding a successor needs to take it. */
export const PRESIDENT_BLOCK_PERCENT = 20;
/** One certificate. */
export const SHARE_BLOCK_PERCENT = 10;

/** One company's contribution to a forced sale. */
export interface SellableHolding {
  companyId: number;
  ticker: string;
  /** Everything this player holds, presidential block included. */
  heldPercent: number;
  /** What they may legally put into the pool -- design notes #1 and #6. */
  sellablePercent: number;
  /** Design note #6: whether the 20% block is part of `sellablePercent`.
   *  The UI says so out loud -- dumping a presidency is a much larger
   *  decision than selling a share, and a player should never discover
   *  they have done it from the board afterwards. */
  sellsPresidency: boolean;
  /** Certificates, not percent: `sellablePercent / 10`. */
  sellableCertificates: number;
  /** Market price per 10% certificate. `null` when the company has no
   *  position -- an unfloated company's shares have no price and cannot be
   *  sold at all, which is not the same as being worth nothing. */
  pricePerShare: number | null;
  /** What the sellable block would raise. `0` when unpriced. */
  proceeds: number;
  /** Why nothing (or less than everything) may be sold, for the UI. */
  restriction: string | null;
}

/** What `player` may legally sell right now, company by company.
 *
 *  `excludeCompanyId` drops the corporation being rescued: its president cannot
 *  sell its shares to fund its own train, and the presidency question makes the
 *  general case a contract matter rather than a UI one. */
export function sellableHoldings(
  state: GameStateResponse,
  player: string,
  priceForCompany: (companyId: number) => number | null,
  excludeCompanyId?: number,
): SellableHolding[] {
  const out: SellableHolding[] = [];

  for (const company of state.public_companies) {
    if (excludeCompanyId !== undefined && company.company_id === excludeCompanyId) continue;

    const held =
      company.player_holdings.find((entry) => entry.player === player)?.percentage ?? 0;
    if (held <= 0) continue;

    const isPresident = company.president === player;

    // Design note #1, restriction two: room left under the pool cap.
    const poolRoom = Math.max(0, BANK_POOL_CAP_PERCENT - company.bank_pool_percentage);

    /* Design note #6, condition one: some OTHER single player already holds
       enough to take the certificate. Per player, never a sum. */
    const successor = isPresident
      ? (company.player_holdings.find(
          (entry) => entry.player !== player && entry.percentage >= PRESIDENT_BLOCK_PERCENT,
        ) ?? null)
      : null;

    /* The ordinary shares first: everything except the presidential block,
       in whole 10% certificates, bounded by the pool. */
    const ordinaryHeld = isPresident ? Math.max(0, held - PRESIDENT_BLOCK_PERCENT) : held;
    const ordinaryPercent =
      Math.floor(Math.min(ordinaryHeld, poolRoom) / SHARE_BLOCK_PERCENT) * SHARE_BLOCK_PERCENT;

    /* Design note #6, condition two: the block goes WHOLE or not at all, and
       it competes for the same pool room the ordinary shares just used. */
    const roomAfterOrdinary = poolRoom - ordinaryPercent;
    const sellsPresidency =
      isPresident && successor !== null && roomAfterOrdinary >= PRESIDENT_BLOCK_PERCENT;

    const sellablePercent = ordinaryPercent + (sellsPresidency ? PRESIDENT_BLOCK_PERCENT : 0);

    const pricePerShare = priceForCompany(company.company_id);
    const certificates = sellablePercent / SHARE_BLOCK_PERCENT;

    out.push({
      companyId: company.company_id,
      ticker: company.ticker,
      heldPercent: held,
      sellablePercent,
      sellableCertificates: certificates,
      sellsPresidency,
      pricePerShare,
      proceeds: pricePerShare === null ? 0 : (sellablePercent / SHARE_BLOCK_PERCENT) * pricePerShare,
      restriction: describeRestriction({
        isPresident,
        held,
        ordinaryHeld,
        poolRoom,
        poolPercent: company.bank_pool_percentage,
        sellablePercent,
        sellsPresidency,
        hasSuccessor: successor !== null,
        pricePerShare,
      }),
    });
  }

  return out;
}

function describeRestriction(args: {
  isPresident: boolean;
  held: number;
  ordinaryHeld: number;
  poolRoom: number;
  poolPercent: number;
  sellablePercent: number;
  sellsPresidency: boolean;
  hasSuccessor: boolean;
  pricePerShare: number | null;
}): string | null {
  const {
    isPresident,
    held,
    ordinaryHeld,
    poolRoom,
    poolPercent,
    sellablePercent,
    sellsPresidency,
    hasSuccessor,
    pricePerShare,
  } = args;

  if (pricePerShare === null) return "No market price yet — these shares cannot be sold.";

  /* Design note #6: the presidency going is the biggest thing that can
     happen here, so it leads whatever else is true of the row. */
  if (sellsPresidency) {
    return `Includes the ${PRESIDENT_BLOCK_PERCENT}% President's Certificate — the presidency transfers.`;
  }

  if (sellablePercent === 0) {
    if (poolRoom === 0) {
      return `The Bank Pool is at ${poolPercent}% and caps at ${BANK_POOL_CAP_PERCENT}%.`;
    }
    if (isPresident && ordinaryHeld === 0) {
      /* Which of the two conditions failed, because they have different
         remedies: waiting for somebody to buy in, versus waiting for the
         pool to drain. A bare "cannot be sold" leaves the president
         guessing at a rule. */
      return hasSuccessor
        ? `President's Certificate needs ${PRESIDENT_BLOCK_PERCENT}% of Bank Pool room and there is ${poolRoom}%.`
        : `President's Certificate — no other player holds ${PRESIDENT_BLOCK_PERCENT}% to take it.`;
    }
    return "Nothing sellable here.";
  }

  if (isPresident && sellablePercent < held) {
    return hasSuccessor
      ? `${PRESIDENT_BLOCK_PERCENT}% President's Certificate withheld — the Bank Pool has ${poolRoom}% of room.`
      : `${PRESIDENT_BLOCK_PERCENT}% President's Certificate withheld — no successor holds ${PRESIDENT_BLOCK_PERCENT}%.`;
  }
  if (poolRoom < ordinaryHeld) {
    return `Bank Pool room: ${poolRoom}% (caps at ${BANK_POOL_CAP_PERCENT}%).`;
  }
  return null;
}

/* Design note #2: the three stages, resolved. Every figure is derived in the
   cascade's order so the UI can print the sequence rather than a total -- "the
   company pays $40, you pay $200, you must raise $60 more" is the sentence a
   president needs, and it cannot be recovered from a sum. */
export interface EmergencyFunding {
  trainCost: number;
  /** Stage 1. Capped at the price: a treasury larger than the train has no
   *  shortfall and this is not an emergency at all. */
  fromTreasury: number;
  /** Stage 2. What the president's own cash covers of what remains. */
  fromPlayerCash: number;
  /** Stage 3. What must still be raised by selling. */
  mustRaiseBySelling: number;
  /** The most those sales could possibly raise. */
  maxSaleProceeds: number;
  /** Stage 1 + 2 + the sale ceiling. */
  maxRaisable: number;
  /** `maxRaisable < trainCost`: the game ends. */
  bankrupt: boolean;
  holdings: SellableHolding[];
}

export function resolveEmergencyFunding(args: {
  trainCost: number;
  treasury: number;
  playerCash: number;
  holdings: SellableHolding[];
}): EmergencyFunding {
  const { trainCost, treasury, playerCash, holdings } = args;

  const fromTreasury = Math.min(Math.max(0, treasury), trainCost);
  const afterTreasury = Math.max(0, trainCost - fromTreasury);
  const fromPlayerCash = Math.min(Math.max(0, playerCash), afterTreasury);
  const mustRaiseBySelling = Math.max(0, afterTreasury - fromPlayerCash);

  const maxSaleProceeds = holdings.reduce((sum, entry) => sum + entry.proceeds, 0);
  const maxRaisable = fromTreasury + Math.max(0, playerCash) + maxSaleProceeds;

  return {
    trainCost,
    fromTreasury,
    fromPlayerCash,
    mustRaiseBySelling,
    maxSaleProceeds,
    maxRaisable,
    // Design note #1: a president can hold a fortune in unsellable paper
    // and still be bankrupt, which is why this compares the SELLABLE
    // ceiling rather than the portfolio.
    bankrupt: maxRaisable < trainCost,
    holdings,
  };
}

/* Design note #3: 1830 ranks players by NET WORTH -- personal cash plus the
   market value of every certificate held. Two things it does not count, and both
   are worth stating because both look like money: CORPORATE TREASURIES belong to
   the company, not the president; and UNFLOATED SHARES have no market price and
   count at zero, because par is what they COST, not what they are worth.

   PRIVATE COMPANIES count at face value -- the one asset here whose value is
   printed rather than derived. */
export interface PlayerStanding {
  address: string;
  label: string;
  cash: number;
  stockValue: number;
  privateValue: number;
  netWorth: number;
  /** 1-based, after sorting. Ties share a rank. */
  rank: number;
  isWinner: boolean;
  isBankrupt: boolean;
  /** Design note #4: this player's cut of the prize pool. */
  expectedPayout: number;
}

/** Placeholder ante for the payout column, per the brief. The real figure
 *  is the sum of every player's real-JUNO deposit and lives on the lobby's
 *  contract; $100 stands in until that is wired. */
export const PLACEHOLDER_TOTAL_ANTE = 100;

/* Design note #4: the payout column is proportional to net worth and it is a
   PLACEHOLDER. Proportional degrades sensibly -- no rules about places, sums to
   the ante by construction, and a bankrupt player gets nothing without a special
   case.

   IT IS NOT THE CONTRACT'S ANSWER. `total_juno_pool` is real money held by
   `lobby.rs`, and winner-takes-all and proportional are both defensible; the
   contract has not said which. The constant is named `PLACEHOLDER_*` so nobody
   mistakes it for a figure that came off the chain. */
export function rankPlayers(args: {
  state: GameStateResponse;
  priceForCompany: (companyId: number) => number | null;
  labelForAddress: (address: string) => string;
  bankruptAddress?: string | null;
  totalAnte?: number;
}): PlayerStanding[] {
  const {
    state,
    priceForCompany,
    labelForAddress,
    bankruptAddress = null,
    totalAnte = PLACEHOLDER_TOTAL_ANTE,
  } = args;

  const rows = state.player_addresses.map((address) => {
    const cash = Number(
      state.player_cash.find((entry) => entry.player === address)?.cash_vgp ?? 0,
    );
    const stockValue = state.public_companies.reduce((sum, company) => {
      const held =
        company.player_holdings.find((entry) => entry.player === address)?.percentage ?? 0;
      if (held <= 0) return sum;
      const price = priceForCompany(company.company_id);
      // Design note #3: unpriced shares score zero, not par.
      return price === null ? sum : sum + (held / SHARE_BLOCK_PERCENT) * price;
    }, 0);
    const privateValue = state.private_companies.reduce(
      (sum, priv) =>
        !priv.closed && priv.owner === address ? sum + (Number(priv.cost) || 0) : sum,
      0,
    );

    return {
      address,
      label: labelForAddress(address),
      cash: Number.isFinite(cash) ? cash : 0,
      stockValue: Math.round(stockValue),
      privateValue,
      netWorth: (Number.isFinite(cash) ? cash : 0) + Math.round(stockValue) + privateValue,
      isBankrupt: address === bankruptAddress,
    };
  });

  const sorted = [...rows].sort((a, b) => b.netWorth - a.netWorth);
  const total = sorted.reduce((sum, row) => sum + Math.max(0, row.netWorth), 0);

  /* Design note #5: somebody still wins. Expressing "the bankrupt cannot win" as
     `rank === 1 && not bankrupt` quietly produced games with NO winner whenever
     the bankrupt president also held the largest portfolio -- not a rare corner,
     because bankruptcy is about LIQUIDITY (#1) and the player most likely to be
     caught by a mandatory train is the one who spent everything on shares.

     The title passes to the highest-ranked player who is NOT bankrupt. Found by a
     harness assertion counting WINNER and BANKRUPT tags and getting one where it
     expected two. */
  const champion = sorted.find((row) => !row.isBankrupt) ?? null;

  return sorted.map((row, index) => {
    // Ties share a rank: two players on $900 are both first.
    const rank =
      index > 0 && sorted[index - 1].netWorth === row.netWorth
        ? // Walk back to the first row with this net worth.
          sorted.findIndex((entry) => entry.netWorth === row.netWorth) + 1
        : index + 1;
    return {
      ...row,
      rank,
      /* The bankrupt player never wins, even if their paper still ranks first --
         bankruptcy is about liquidity (design note #1), and a president can be unable
         to raise $180 while holding the largest portfolio at the table. Ranking them
         first and also telling them they lost would be two contradictory sentences in
         one modal. */
      isWinner: champion !== null && row.address === champion.address,
      expectedPayout:
        total <= 0 ? 0 : Math.round((Math.max(0, row.netWorth) / total) * totalAnte * 100) / 100,
    };
  });
}

/** The bank has broken -- 1830's other ending. */
export function bankIsBroken(state: GameStateResponse | null): boolean {
  if (!state) return false;
  const bank = Number(state.virtual_bank_vgp);
  return Number.isFinite(bank) && bank <= 0;
}
