// frontend/src/money/useMoneyTable.ts
//
// ==================================================================
//  ESCROW-4: ONE HOOK BEHIND EVERY MONEY SURFACE OF A TABLE (WAITING ROOM, IN-GAME STRIP, RESULT BAND)
// ==================================================================
//
// It re-derives the seat's state on every render (`moneyFlow.ts`) from the server's view, this browser's pending
// transaction and signing keys, and this page's wallet connection and grant -- so a reload, another tab or another
// device lands in the right state with nothing to restore. It runs the one action the player pressed
// (`moneyActions.ts`) with single flight, keeps the outcome's sentence, and watches the chain for this browser's
// pending transactions (dropping one Juno included or that can no longer land). Nothing here decides "funded".

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { GameStateResponse } from "../gameEngine/gameState";
import type { GameVariants } from "../gameEngine/gameVariants";
import type { HashableLogEntry } from "../gameEngine/logHash";
import type { RoomMoneyView } from "../utils/moneyProtocol";
import type { SessionPort } from "../utils/sessionBootstrap";
import {
  agreeToAnnul,
  approveDeposit,
  approvePayout,
  connectWallet,
  escrowExit,
  linkWallet,
  moveSigningKeyHere,
  reconcilePending,
  resendPending,
  settleLandedDeposits,
  settlementTx,
  verifyRecordedSettlement,
  type ActionOutcome,
  type TableContext,
  type Verification,
} from "./moneyActions";
import { seatFlow, settlementFlow, type ActionKind, type SeatFlow, type SettlementActionKind, type SettlementFlow, type WalletState } from "./moneyFlow";
import { bumpLocal, isConfirmed, moneyServices, updateMoneySession, useMoneySession, type MoneyServices } from "./moneySession";
import type { PendingWalletTx } from "./pendingTx";

export type MoneyActionKind = ActionKind | SettlementActionKind;

export interface MoneyTableInput {
  readonly gameId: string;
  readonly view: RoomMoneyView | null;
  readonly variants: GameVariants;
  readonly isHost: boolean;
  /** For the result band's own check of the recorded payout: this device's log and board. */
  readonly log?: readonly HashableLogEntry[] | null;
  readonly board?: GameStateResponse | null;
  readonly port?: SessionPort;
  readonly services?: MoneyServices;
  /** The room's own Start (`room-op start-game`): the money panel's Start presses it. */
  readonly onStart?: () => void;
}

export interface MoneyTable {
  readonly view: RoomMoneyView | null;
  readonly flow: SeatFlow | null;
  readonly settlement: SettlementFlow | null;
  /** This hook's clock (ticks every 15 s): the instant a render's money times are judged from (W2-K). */
  readonly now: number;
  readonly wallet: WalletState;
  readonly pending: PendingWalletTx | null;
  readonly holdsChainKey: boolean;
  readonly verification: Verification | null;
  /** The action in flight (single flight), or null. */
  readonly busy: MoneyActionKind | null;
  readonly notice: string | null;
  readonly error: string | null;
  /** A step the player must take before the action can run: "Confirm it's you", or the wallet replacement question. */
  readonly needs: { readonly kind: "confirm"; readonly then: MoneyActionKind | null } | { readonly kind: "replace" } | null;
  /** The review card is open (deposit terms shown before "Approve in Keplr"). */
  readonly reviewing: boolean;
  run(kind: MoneyActionKind): Promise<void>;
  openReview(): void;
  closeReview(): void;
  /** "Confirm it's you" was granted: continue with what was asked. */
  confirmed(expiresAt: number): Promise<void>;
  cancelNeeds(): void;
  dismiss(): void;
}

export function useMoneyTable(input: MoneyTableInput): MoneyTable {
  const services = input.services ?? moneyServices();
  const session = useMoneySession();
  const view = input.view;
  const [busy, setBusy] = useState<MoneyActionKind | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [needs, setNeeds] = useState<MoneyTable["needs"]>(null);
  const [reviewing, setReviewing] = useState(false);
  const [pending, setPending] = useState<PendingWalletTx | null>(null);
  const [holdsChainKey, setHoldsChainKey] = useState(false);
  const [verification, setVerification] = useState<Verification | null>(null);
  const [now, setNow] = useState(() => services.now());
  const busyRef = useRef<MoneyActionKind | null>(null);
  const latest = useRef(input);
  latest.current = input;

  const pinned = services.pin();
  /* The wallet as the flows see it. It is made of three values and nothing else: why this build has no pin (null when
     it has one), and the page's connection and account from the money session, which the effects below and the
     actions keep current. Memoised on exactly those, it changes when one of them does and keeps its identity
     otherwise, so the seat flow's memo re-derives on a real change instead of on every render; it closes over no
     other state, so it cannot go stale. */
  const noPinReason = pinned.ok ? null : pinned.reason;
  const wallet = useMemo(
    (): WalletState =>
      noPinReason !== null
        ? { kind: "no-pin", reason: noPinReason }
        : session.wallet === "unavailable"
          ? { kind: "unavailable" }
          : session.wallet === "connecting"
            ? { kind: "connecting" }
            : session.wallet === "connected" && session.address !== null
              ? { kind: "connected", address: session.address }
              : { kind: "disconnected" },
    [noPinReason, session.wallet, session.address],
  );

  /* Is Keplr here at all? (Once per page; a later Connect re-checks.) */
  useEffect(() => {
    if (session.wallet !== "unknown") return;
    let live = true;
    void services.wallet.ready().then((present) => {
      if (live && present === false) updateMoneySession({ wallet: "unavailable" });
      else if (live) updateMoneySession({ wallet: "disconnected" });
    });
    return () => {
      live = false;
    };
  }, [services, session.wallet]);

  /* Keplr switched accounts: re-read (nothing is signed for a wallet it isn't on). */
  useEffect(() => {
    if (!pinned.ok) return undefined;
    return services.wallet.onAccountChange(() => {
      void services.wallet.account(pinned.pin).then((account) => updateMoneySession(account.ok ? { wallet: "connected", address: account.value.address } : { wallet: "disconnected", address: null }));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [services, pinned.ok]);

  /* This browser's local truth for the seat: its newest pending transaction, and whether it holds the chain's key. */
  const you = view?.you ?? null;
  const senders = useMemo(() => new Set([you?.link?.wallet, you?.payoutWallet, you?.unlinkedDeposit?.wallet].filter((value): value is string => typeof value === "string")), [you?.link?.wallet, you?.payoutWallet, you?.unlinkedDeposit?.wallet]);
  useEffect(() => {
    let live = true;
    /* A deposit Juno included is kept until this view shows it; then its record is done. */
    if (settleLandedDeposits(input.gameId, view, services)) {
      bumpLocal();
      return undefined;
    }
    const records = services.pending.all().filter((record) => record.gameId === input.gameId && ((you !== null && record.playerId === you.playerId) || senders.has(record.sender)));
    setPending(records[0] ?? null);
    const key = you?.chainConsentKey ?? null;
    void services.keys.holds(key).then((held) => {
      if (live) setHoldsChainKey(held);
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [services, input.gameId, you, senders, session.localVersion, view?.escrow.state, view?.start.state]);

  /* The chain's answer about this browser's pending transactions, every 12 s while one exists. */
  useEffect(() => {
    if (pending === null) return undefined;
    let live = true;
    const check = async () => {
      const said = await reconcilePending(input.gameId, services, input.port);
      if (live && said !== null) setNotice(said);
    };
    void check();
    const timer = setInterval(() => void check(), 12_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [pending, input.gameId, input.port, services]);

  /* A clock for the time-based parts (deadlines, windows, the grant): every 15 s. */
  useEffect(() => {
    const timer = setInterval(() => setNow(services.now()), 15_000);
    return () => clearInterval(timer);
  }, [services]);

  /* The result band's own check of the recorded payout (once per recorded settlement digest). */
  const settleDigest = view?.settlement?.settleDigest ?? null;
  const settleStatus = view?.settlement?.status ?? null;
  /* Checked again when this device's copy of the game grows (the log may still be arriving), and every 30 s while it
     couldn't be checked (a failed read must not cost early approval for the whole window). */
  const logLength = input.log?.length ?? 0;
  const [recheck, setRecheck] = useState(0);
  useEffect(() => {
    if (view === null || settleDigest === null || (settleStatus !== "recorded" && settleStatus !== "release-available")) {
      setVerification(null);
      return undefined;
    }
    let live = true;
    void verifyRecordedSettlement(input.gameId, view, latest.current.log ?? null, latest.current.board ?? null, input.port, services).then((result) => {
      if (live) setVerification(result);
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input.gameId, settleDigest, settleStatus, logLength, recheck]);
  useEffect(() => {
    if (verification === null || verification.result !== "unavailable" || settleStatus !== "recorded") return undefined;
    const timer = setTimeout(() => setRecheck((count) => count + 1), 30_000);
    return () => clearTimeout(timer);
  }, [verification, settleStatus]);

  const confirmedNow = isConfirmed(session, now);
  const flow = useMemo(
    () => (view === null ? null : seatFlow({ view, isHost: input.isHost, wallet, confirmed: confirmedNow, pending, holdsChainKey, ui: busy === "approve" ? "approving" : reviewing ? "review" : "idle", now })),
    [view, input.isHost, wallet, confirmedNow, pending, holdsChainKey, busy, reviewing, now],
  );
  /* A check is about ONE recorded payout: a result for another digest (the view moved on) counts as none. */
  const checked = verification !== null && verification.settleDigest === settleDigest ? verification : null;
  const settlement = useMemo(() => (view === null ? null : settlementFlow({ view, holdsChainKey, verification: checked?.result ?? "unavailable", now, keplr: wallet.kind !== "unavailable" && wallet.kind !== "no-pin" })), [view, holdsChainKey, checked, now, wallet.kind]);

  const context = (): TableContext | null => {
    const current = latest.current;
    if (current.view === null) return null;
    return { gameId: current.gameId, view: current.view, variants: current.variants, isHost: current.isHost, port: current.port, services };
  };

  const perform = useCallback(
    async (kind: MoneyActionKind): Promise<ActionOutcome> => {
      const ctx = context();
      if (kind === "connect") return connectWallet(services);
      if (ctx === null) return { ok: false, reason: "This table's money isn't known yet." };
      switch (kind) {
        case "confirm":
          setNeeds({ kind: "confirm", then: null });
          return { ok: true };
        case "link":
        case "relink":
          return linkWallet(ctx);
        case "replace-link":
          return linkWallet(ctx, { replace: true });
        case "open-review":
          setReviewing(true);
          return { ok: true };
        case "approve": {
          const outcome = await approveDeposit(ctx);
          if (outcome.ok) setReviewing(false);
          return outcome;
        }
        case "resend": {
          const record = pending;
          return record === null ? { ok: true } : resendPending(record, services, ctx.port);
        }
        case "withdraw":
        case "cancel-escrow":
        case "refund-after-deadline":
          return escrowExit(ctx, kind);
        case "start":
          latest.current.onStart?.();
          return { ok: true };
        case "move-signing-key":
          return moveSigningKeyHere(ctx);
        case "approve-payout":
          return checked === null ? { ok: false, reason: "The recorded payout hasn't been checked on this device yet." } : approvePayout(ctx, checked);
        case "annul":
          return agreeToAnnul(ctx);
        case "challenge":
        case "release-payout":
        case "liveness-settle":
          return settlementTx(ctx, kind, { log: latest.current.log ?? null, board: latest.current.board ?? null });
        default:
          return { ok: false, reason: "That isn't something this panel can do." };
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [services, pending, checked],
  );

  const run = useCallback(
    async (kind: MoneyActionKind) => {
      if (busyRef.current !== null) return; // single flight
      busyRef.current = kind;
      setBusy(kind);
      setError(null);
      setNotice(null);
      try {
        const outcome = await perform(kind);
        if (outcome.ok) {
          if (outcome.notice) setNotice(outcome.notice);
          if (kind !== "confirm") setNeeds(null);
        } else {
          setError(outcome.reason);
          if (outcome.needs === "confirm") setNeeds({ kind: "confirm", then: kind });
          else if (outcome.needs === "replace") setNeeds({ kind: "replace" });
          else if (outcome.needs === "connect") updateMoneySession({ wallet: "disconnected", address: null });
        }
      } catch (thrown) {
        /* Nothing here should throw; if something does, say so plainly (and nothing was signed after a throw). */
        setError(`That didn't finish (${thrown instanceof Error ? thrown.message.slice(0, 120) : "an unexpected error"}). Nothing was sent after it stopped.`);
      } finally {
        busyRef.current = null;
        setBusy(null);
        bumpLocal();
      }
    },
    [perform],
  );

  /* Named apart from `seatFlow`'s `confirmed:` input above: the flow memo passes `confirmedNow` under that KEY and
     never reads this binding, but `memoDeadZone.test.ts` matches names textually, so a later binding called
     `confirmed` would read as a dead-zone read by that memo. The hook's result still calls it `confirmed`. */
  const continueAfterConfirm = useCallback(
    async (expiresAt: number) => {
      updateMoneySession({ confirmedUntil: Math.min(expiresAt, services.now() + 5 * 60 * 1000) });
      const then = needs !== null && needs.kind === "confirm" ? needs.then : null;
      setNeeds(null);
      setError(null);
      if (then !== null) await run(then);
    },
    [needs, run, services],
  );

  return {
    view,
    flow,
    settlement,
    now,
    wallet,
    pending,
    holdsChainKey,
    verification: checked,
    busy,
    notice,
    error,
    needs,
    reviewing,
    run,
    openReview: () => setReviewing(true),
    closeReview: () => setReviewing(false),
    confirmed: continueAfterConfirm,
    cancelNeeds: () => setNeeds(null),
    dismiss: () => {
      setNotice(null);
      setError(null);
    },
  };
}
