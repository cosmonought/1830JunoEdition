// frontend/src/components/money/HostStakeSection.tsx
//
// ==================================================================
//  ESCROW-4 (brief §9): THE HOST'S STAKE -- OFFERED ONLY WHEN THE SERVER OPENS REAL-MONEY TABLES ON THIS BUILD'S ESCROW
// ==================================================================
//
// The host setup card's ante row. It becomes a real choice only when BOTH ends agree: the server says real-money tables
// can open (`POST /gs/api/money/config`: enabled -- the operator's switch, never mainnet, a verified escrow, rules
// certified for settlement) AND the server's escrow is the one pinned into this bundle. Otherwise the row is what it
// was (antes off). The ante is typed in the token's display unit and read by a STRICT parser: a malformed amount is
// refused, never turned into zero (`parseAmountToBase`, integers only). A real-money table needs an exact player
// count (the escrow is full only when every seat has deposited). Creating the table moves no money: the host opens it
// on Juno with their own deposit from the waiting room.

import React, { useEffect, useState } from "react";

import { formatAmount, parseAmountToBase, feeOf } from "../../utils/moneyProtocol";
import { deploymentMismatch, pinnedDeployment } from "../../money/escrowDeployment";
import { moneyConfig, type MoneyConfig } from "../../money/moneyApi";
import { bpsText } from "./MoneyPanel";
import { moneyStyles as styles } from "./moneyStyles";
import { TermsLink } from "../InfoPages"; // P3-ACCT (AUD-20.08): every money surface links the Terms

/** What the server offers this build (null: no real-money tables here). */
export function useMoneyTableOffer(): MoneyConfig | null {
  const [offer, setOffer] = useState<MoneyConfig | null>(null);
  useEffect(() => {
    const pinned = pinnedDeployment();
    if (!pinned.ok) return undefined;
    let live = true;
    void moneyConfig().then((answer) => {
      if (live && answer.ok && answer.value.enabled && deploymentMismatch(pinned.pin, answer.value.deployment) === null) setOffer(answer.value);
    });
    return () => {
      live = false;
    };
  }, []);
  return offer;
}

export interface StakeChoice {
  /** The stake in base units, when the typed amount is one. */
  readonly base: string | null;
  /** Why the table can't be created with this stake (null: it can). */
  readonly problem: string | null;
}

export function stakeChoice(offer: MoneyConfig | null, on: boolean, typed: string, playerCount: number | null): StakeChoice {
  if (offer === null || !on) return { base: null, problem: null };
  const base = parseAmountToBase(typed, offer.deployment.exponent);
  if (base === null) return { base: null, problem: `Enter the stake in ${offer.deployment.symbol}, like 10 or 2.5 (at most ${offer.deployment.exponent} decimals, above zero).` };
  if (offer.minAnte !== null && BigInt(base) < BigInt(offer.minAnte)) return { base, problem: `The smallest stake Juno's escrow accepts is ${formatAmount(offer.minAnte, offer.deployment.exponent, offer.deployment.symbol)}.` };
  if (playerCount === null) return { base, problem: "A real-money table needs an exact number of players (choose it under Player Count)." };
  return { base, problem: null };
}

export function HostStakeSection({ offer, on, onToggle, typed, onType, choice }: { offer: MoneyConfig; on: boolean; onToggle: (on: boolean) => void; typed: string; onType: (text: string) => void; choice: StakeChoice }): JSX.Element {
  const d = offer.deployment;
  const network = `${d.networkClass === "testnet" ? "Juno testnet" : d.networkClass === "local" ? "local Juno" : "Juno"} (${d.chainId})`;
  const fee = offer.feeBps === null || choice.base === null ? null : feeOf(choice.base, offer.feeBps);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "8px" }} data-testid="host-stake">
      <label style={styles.optIn}>
        <input type="checkbox" checked={on} onChange={(event) => onToggle(event.target.checked)} data-testid="host-stake-on" />
        Play for real {d.symbol} on {network}
      </label>
      {on ? (
        <>
          <input
            type="text"
            inputMode="decimal"
            value={typed}
            onChange={(event) => onType(event.target.value)}
            aria-label={`Stake per seat in ${d.symbol}`}
            placeholder={`Stake per seat, in ${d.symbol}`}
            style={styles.amount}
            data-testid="host-stake-amount"
          />
          {choice.base !== null ? (
            <p style={styles.detail} data-testid="host-stake-summary">
              Each seat deposits {formatAmount(choice.base, d.exponent, d.symbol)}
              {fee !== null && offer.feeBps !== null ? `; the escrow keeps ${formatAmount(fee, d.exponent, d.symbol)} of it (${bpsText(offer.feeBps)}), which isn't refunded` : ""}.
            </p>
          ) : null}
          {choice.problem !== null ? (
            <p style={styles.blocker} data-testid="host-stake-problem">
              {choice.problem}
            </p>
          ) : null}
          <p style={styles.faint}>
            Creating the table moves no money: you open it on Juno with your own deposit from the waiting room, and every player deposits with Keplr. Winnings are paid to each
            depositing wallet. Deposits on Juno are public. <TermsLink testId="host-stake-terms-link" />
          </p>
        </>
      ) : (
        <p style={styles.faint}>Without a stake the table is played for fun: nothing is deposited.</p>
      )}
    </div>
  );
}
