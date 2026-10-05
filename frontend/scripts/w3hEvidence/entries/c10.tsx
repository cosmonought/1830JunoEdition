// W3-H evidence, VF/C-10: the VF-1 roster row glide (useRosterReorderFlip) in a real layout engine.
// Fixture: stockCardFocus.test.tsx's "a buy that takes the presidency" (BOB buys 20% from the pool, reaches
// 50% against ALICE's 40%, takes the crown), with a third holder (CAROL, 10%) who must not move.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { StockRoundPanel, type StockTransactionEvent } from "../../../src/components/StockRoundPanel";
import * as transfer from "../../../src/components/stockTransferFocus";
import type { OwnershipSnapshot } from "../../../src/utils/stockTransaction";
import type { RoundType } from "../../../src/gameEngine/gameState";
import { corporation, holdingRows, ALICE, BOB, CAROL } from "../fixtures";

(window as any).__transfer = transfer;

const snap = (president: string | null, holdings: Record<string, number>, pools: { ipo: number; bank: number }): OwnershipSnapshot => ({
  ipo_pool_percentage: pools.ipo,
  bank_pool_percentage: pools.bank,
  player_holdings: holdingRows(holdings),
  president,
  double_certificate: undefined,
});

const PRR = 1;
const committed = [
  corporation(PRR, { [ALICE]: 40, [BOB]: 50, [CAROL]: 10 }, BOB, { ipo: 0, bank: 0 }),
  corporation(4, { [ALICE]: 40 }, ALICE, { ipo: 40, bank: 20 }),
];
const takeover = (token: number): StockTransactionEvent => ({
  token,
  companyId: PRR,
  ticker: "PRR",
  kind: "buy",
  transfer: { from: "Bank", to: BOB, percentage: 20 },
  presidency: { from: ALICE, to: BOB },
  before: snap(ALICE, { [ALICE]: 40, [BOB]: 30, [CAROL]: 10 }, { ipo: 0, bank: 20 }),
  after: snap(BOB, { [ALICE]: 40, [BOB]: 50, [CAROL]: 10 }, { ipo: 0, bank: 0 }),
} as StockTransactionEvent);

function Shell() {
  const [transaction, setTransaction] = useState<StockTransactionEvent | null>(null);
  (window as any).__run = (token: number) => setTransaction(takeover(token));
  (window as any).__clear = () => setTransaction(null);
  return (
    <div style={{ padding: 12, width: 840 }}>
      <StockRoundPanel
        onPresidencyCue={() => ((window as any).__cues = ((window as any).__cues ?? 0) + 1)}
        publicCompanies={committed}
        parValueFor={() => "90"}
        onSelectParValue={() => undefined}
        onBuyShare={() => undefined}
        onSellShares={() => undefined}
        sessionReady
        isMyTurn={false}
        connectedAddress={null}
        roundType={"StockRound" as RoundType}
        transaction={transaction}
      />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Shell />);
(window as any).__ready = true;
