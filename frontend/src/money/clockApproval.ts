// frontend/src/money/clockApproval.ts
//
// PHASE 3 FINAL CLOCKS: the table clock's money YES, bound to the table's money context. The clock chip asks for a
// REMEDY-APPROVE only through this (a free table has none: it votes without a signature).

import type { ClockApprovalSigner } from "../components/GameClockChip";
import type { RoomView } from "../utils/roomProtocol";
import { signRemedyApproval } from "./moneyActions";

export function clockApprovalSigner(room: Pick<RoomView, "gameId" | "money" | "variants" | "you"> | null | undefined): ClockApprovalSigner | undefined {
  const money = room?.money ?? null;
  if (room === null || room === undefined || money === null) return undefined;
  return async (input) => {
    const signed = await signRemedyApproval({ gameId: room.gameId, view: money, variants: room.variants, isHost: room.you.role === "host" }, input);
    if (signed.ok) return signed;
    return { ok: false, reason: signed.outcome.ok ? "The approval wasn't signed." : signed.outcome.reason };
  };
}
