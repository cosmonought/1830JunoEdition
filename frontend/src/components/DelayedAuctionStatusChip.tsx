// frontend/src/components/DelayedAuctionStatusChip.tsx
//
/* PHASE 3 W2-I (AUD-02.08): the room strip's standing Delayed Auction status -- "owed" until the auction runs, or
   "cancelled" once the first 5-train has cancelled it (D-55). The status is `delayedAuctionStatus`'s reading of the
   board's own fields; this component only draws it, and draws nothing when that reading is `null`. */

import React from "react";

import { styles } from "../styles/appStyles";
import { DELAYED_AUCTION_STATUS_COPY, delayedAuctionStatus } from "../utils/delayedAuctionStatus";

export function DelayedAuctionStatusChip({ board }: { board: Parameters<typeof delayedAuctionStatus>[0] }) {
  const status = delayedAuctionStatus(board);
  if (status === null) return null;
  const copy = DELAYED_AUCTION_STATUS_COPY[status];
  return (
    <span style={styles.forcedSignChip} title={copy.title} data-testid="delayed-auction-status" data-status={status}>
      {copy.label}
    </span>
  );
}

export default DelayedAuctionStatusChip;
