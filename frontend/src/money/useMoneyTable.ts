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
import type { RoomClockView } from "../utils/clockProtocol";
import { sessionPort, type SessionPort } from "../utils/sessionBootstrap";
import {
  agreeToAnnul,
  anteNow,
  approveDeposit,
  disputeChainFacts,
  approvePayout,
  connectWallet,
  escrowExit,
  linkWallet,
  moveSigningKeyHere,
  prepareReplace,
  reconcilePending,
  resendPending,
  settleLandedDeposits,
  settlementTx,
  verifyRecordedSettlement,
  type ActionOutcome,
  type TableContext,
  type Verification,
} from "./moneyActions";
import { proofAgedOut, seatFlow, WALLET_PROOF_MAX_AGE_MS, settlementFlow, type ActionKind, type DisputeRead, type SeatFlow, type SettlementActionKind, type SettlementFlow, type WalletState } from "./moneyFlow";
import { bumpLocal, isConfirmed, moneyServices, moneySession, proofKey, updateMoneySession, useMoneySession, type MoneyServices } from "./moneySession";
import { browserKeplrLock, KEPLR_BUSY_SENTENCE } from "./keplrLock";
import type { PendingWalletTx } from "./pendingTx";
import { browserSameWalletAcks, sameWalletAccountKey } from "./sameWalletAck";

/** `replace-confirmed`: the player answered "Replace wallet" to the question "Change wallet" asked first (W2-M). */
export type MoneyActionKind = ActionKind | SettlementActionKind | "replace-confirmed";

/** W1-K (AUD-19.02): the actions that may open Keplr (a connect, a message signature, a transaction) -- each runs
 *  inside the cross-tab Keplr lock. The rest (local signing keys, the review, Start, a re-send of kept bytes) don't. */
export const KEPLR_ACTIONS: ReadonlySet<MoneyActionKind> = new Set<MoneyActionKind>([
  "connect",
  "link",
  "relink",
  "reprove",
  "replace-link",
  "replace-confirmed",
  "approve",
  "ante",
  "verify",
  "withdraw",
  "cancel-escrow",
  "refund-after-deadline",
  "move-signing-key",
  "challenge",
  "release-payout",
  "liveness-settle",
]);

/** How often Ante looks at the newest view while it waits for the server to show a link. */
const VIEW_POLL_MS = 150;

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
  /** W2-M: read Juno's dispute record for this surface (the result's band); false where it is never shown (the bar). */
  readonly disputeRecord?: boolean;
  /** Phase 3 final clocks: the table clock (`RoomView.clock`): the deadline a deposit funds the escrow under, and this
   *  seat's No-deadline acknowledgement. */
  readonly clock?: RoomClockView | null;
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
  /** P3-ACCT: where a running Ante is ("Connecting wallet…", "Verifying wallet…", "Waiting for deposit…"), or null. */
  readonly progress: string | null;
  readonly notice: string | null;
  readonly error: string | null;
  /** A step the player must take before the action can run: "Confirm it's you", or the wallet replacement question
   *  (W2-M: asked BEFORE Keplr signs, naming the linked wallet and the one Keplr is on, when they are known). */
  readonly needs:
    | { readonly kind: "confirm"; readonly then: MoneyActionKind | null }
    | { readonly kind: "replace"; readonly from: string | null; readonly to: string | null; readonly again: boolean; readonly said: string | null }
    /** Owner ruling 2026-10-07: the wallet about to be bound is the account's Authorization Wallet -- warned once,
     *  allowed; `then` is the action the player pressed, run again once they continue. */
    | { readonly kind: "same-wallet"; readonly wallet: string; readonly then: MoneyActionKind }
    | null;
  /** W2-M (AUD-20.07, JX-6E): Juno's dispute facts for the dispute confirm (read when it opens), or null. */
  readonly disputeTerms: DisputeRead | null;
  /** W2-M (AUD-20.07, JX-6E): Juno's dispute record for the band (read while disputed or once a resolver route
   *  closed it), or null when there is none to read. */
  readonly disputeRecord: DisputeRead | null;
  /** Read Juno's dispute facts for the confirm the band is about to show (W2-M). */
  readDisputeTerms(): void;
  /** The review card is open (deposit terms shown before "Approve in Keplr"). */
  readonly reviewing: boolean;
  run(kind: MoneyActionKind): Promise<void>;
  openReview(): void;
  closeReview(): void;
  /** "Confirm it's you" was granted: continue with what was asked. */
  confirmed(expiresAt: number): Promise<void>;
  /** Owner ruling 2026-10-07: "Continue with this wallet" -- keep the account's acknowledgement, then run the pressed
   *  action again (never a wallet chosen for the player). */
  acknowledgeSameWallet(): Promise<void>;
  cancelNeeds(): void;
  dismiss(): void;
}

export function useMoneyTable(input: MoneyTableInput): MoneyTable {
  const services = input.services ?? moneyServices();
  const session = useMoneySession();
  const view = input.view;
  const [busy, setBusy] = useState<MoneyActionKind | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [needs, setNeeds] = useState<MoneyTable["needs"]>(null);
  const [reviewing, setReviewing] = useState(false);
  const [pending, setPending] = useState<PendingWalletTx | null>(null);
  const [holdsChainKey, setHoldsChainKey] = useState(false);
  const [verification, setVerification] = useState<Verification | null>(null);
  const [now, setNow] = useState(() => services.now());
  /* W2-M (AUD-20.02): the server refused a deposit's approval for want of a fresh proof -- for THIS link (wallet and
     epoch); a later accepted link clears it. */
  const [proofRefusedFor, setProofRefusedFor] = useState<string | null>(null);
  const [disputeTerms, setDisputeTerms] = useState<DisputeRead | null>(null);
  const [disputeRecord, setDisputeRecord] = useState<DisputeRead | null>(null);
  /* W2-M (AUD-20.03): the wallet the player agreed to replace the link with (what "Replace wallet" links, or nothing). */
  const replaceTo = useRef<string | null>(null);
  /* ...and the linked wallet the question named (Replace refuses if the link moved meanwhile). */
  const replaceFrom = useRef<string | null>(null);
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

  /* W2-M (AUD-20.02): can this seat's wallet proof be counted on for a deposit? The newest proof this page knows of is
     the link's own (`linkedAt`) or one this page had accepted since (the session's record); the server's refusal is
     its own word. Nothing here says a proof is fresh that the server hasn't accepted. */
  const link = you?.link ?? null;
  const linkTag = link === null ? null : `${link.wallet}#${link.epoch}`;
  const renewedAt = link === null || you === null ? undefined : session.proofRenewedAt[proofKey(input.gameId, you.playerId, link.wallet)];
  /* W2-M (AUD-20.13): the server's own record of when the proof was verified, when it sends it, is the authority -- a
     proof it shows as past the limit is the server's word ("refused" wording: it needs a fresh proof); only without
     it does the page infer from the link's own time ("aged": the deposit stays offered beside the re-proof). */
  const verifiedAt = link !== null && typeof link.proofVerifiedAt === "number" && Number.isFinite(link.proofVerifiedAt) ? link.proofVerifiedAt : null;
  const proof: "aged" | "refused" | null =
    link === null
      ? null
      : proofRefusedFor !== null && proofRefusedFor === linkTag
        ? "refused"
        : verifiedAt !== null
          ? /* Past the server's limit by its time (judged on this device's clock): its word. Inside the last five
               minutes: an inference, so the deposit stays beside the re-proof and the server decides. (A clock hours
               ahead still reads a proof as past the limit: one free re-proof, never a deposit taken.) */
            now - Math.max(verifiedAt, renewedAt ?? Number.NEGATIVE_INFINITY) >= WALLET_PROOF_MAX_AGE_MS
            ? "refused"
            : proofAgedOut(Math.max(verifiedAt, renewedAt ?? Number.NEGATIVE_INFINITY), now)
              ? "aged"
              : null
          : proofAgedOut(Math.max(link.linkedAt, renewedAt ?? Number.NEGATIVE_INFINITY), now)
            ? "aged"
            : null;

  /* P3-ACCT: what the Ante reads of the proof when it runs (a ref: the action outlives the render that started it). */
  const proofNow = useRef(proof);
  proofNow.current = proof;
  const confirmedNow = isConfirmed(session, now);
  const flow = useMemo(
    () => (view === null ? null : seatFlow({ view, isHost: input.isHost, wallet, confirmed: confirmedNow, pending, holdsChainKey, ui: busy === "approve" ? "approving" : reviewing ? "review" : "idle", now, proof })),
    [view, input.isHost, wallet, confirmedNow, pending, holdsChainKey, busy, reviewing, now, proof],
  );

  /* W2-M (AUD-20.07, JX-6E): the band's dispute record, read from Juno while the payout is disputed, and once a
     resolver route (or its timeout) closed it -- again whenever the status or route moves, and every 30 s while it
     couldn't be read. */
  const chainGameId = view?.escrow.chainGameId ?? null;
  const settleRoute = view?.settlement?.route ?? null;
  const wantsRecord = input.disputeRecord !== false && view !== null && view.you !== null && chainGameId !== null && (settleStatus === "disputed" || (settleRoute !== null && settleRoute.startsWith("resolver_")));
  const [recordRetry, setRecordRetry] = useState(0);
  useEffect(() => {
    if (!wantsRecord) {
      setDisputeRecord(null);
      return undefined;
    }
    let live = true;
    setDisputeRecord((current) => current ?? { kind: "loading" });
    void disputeChainFacts(latest.current.view as RoomMoneyView, services).then((read) => {
      if (live) setDisputeRecord(read);
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantsRecord, chainGameId, settleStatus, settleRoute, recordRetry]);
  useEffect(() => {
    /* Read again while it couldn't be read -- or while the view says disputed and Juno's answer (through this page's
       endpoint, which may lag the server's) has no record yet. */
    const again = disputeRecord !== null && (disputeRecord.kind === "unavailable" || (disputeRecord.kind === "read" && disputeRecord.dispute === null && settleStatus === "disputed"));
    if (!again || !wantsRecord) return undefined;
    const timer = setTimeout(() => setRecordRetry((count) => count + 1), 30_000);
    return () => clearTimeout(timer);
  }, [disputeRecord, wantsRecord, settleStatus]);
  /* A check is about ONE recorded payout: a result for another digest (the view moved on) counts as none. */
  const checked = verification !== null && verification.settleDigest === settleDigest ? verification : null;
  const settlement = useMemo(() => (view === null ? null : settlementFlow({ view, holdsChainKey, verification: checked?.result ?? "unavailable", now, keplr: wallet.kind !== "unavailable" && wallet.kind !== "no-pin" })), [view, holdsChainKey, checked, now, wallet.kind]);

  const context = (): TableContext | null => {
    const current = latest.current;
    if (current.view === null) return null;
    const clock = current.clock ?? null;
    const me = current.view.you?.playerId ?? null;
    const deadline = clock === null ? null : { deadline: clock.deadline, paceSecs: clock.paceSecs, acknowledged: me !== null && clock.noDeadlineAcks.includes(me) };
    return { gameId: current.gameId, view: current.view, variants: current.variants, isHost: current.isHost, port: current.port, services, deadline };
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
        case "reprove": {
          /* W2-M (AUD-20.02): the SAME linked wallet, proven again -- never another one. */
          const wallet = ctx.view.you?.link?.wallet;
          return wallet === undefined ? { ok: false, reason: "This seat has no linked wallet to prove again." } : linkWallet(ctx, { expectWallet: wallet, reprove: true });
        }
        case "replace-link": {
          /* W2-M (AUD-20.03): ask first, sign once. Nothing is asked of Keplr here but its current account. */
          const asked = await prepareReplace(ctx);
          if (!asked.ok) return asked.outcome;
          replaceTo.current = asked.to;
          replaceFrom.current = asked.from;
          setNeeds({ kind: "replace", from: asked.from, to: asked.to, again: false, said: null });
          return { ok: true };
        }
        case "replace-confirmed": {
          const to = replaceTo.current;
          if (to === null) return { ok: false, reason: "The wallet to link isn't known, so nothing was signed. Start again." };
          /* The question named the link it replaces: if the seat's link has moved since (the server's challenge answer
             says, before Keplr signs), the player is asked again rather than a wallet they weren't asked about replaced. */
          const from = replaceFrom.current;
          return linkWallet(ctx, { replace: true, expectWallet: to, ...(from !== null ? { expectReplaces: from } : {}) });
        }
        case "open-review":
          setReviewing(true);
          return { ok: true };
        case "approve": {
          const outcome = await approveDeposit(ctx);
          if (outcome.ok) setReviewing(false);
          return outcome;
        }
        case "ante":
        case "verify":
          /* P3-ACCT: the one button. The hooks give it the newest view as the server pushes it (this table's only), and
             its status line; "verify" stops at the wallet's proof (money review M2). */
          return anteNow(ctx, {
            status: setProgress,
            latest: () => (latest.current.gameId === ctx.gameId ? latest.current.view : null),
            proof: proofNow.current,
            verifyOnly: kind === "verify",
            onReproved: () => setProofRefusedFor(null),
            waitFor: async (predicate, ms) => {
              /* Counted in polls, not read off a clock (a test's clock may stand still). */
              for (let polls = Math.ceil(ms / VIEW_POLL_MS); ; polls -= 1) {
                const current = latest.current.gameId === ctx.gameId ? latest.current.view : null;
                if (current !== null && predicate(current)) return current;
                if (polls <= 0) return null;
                await new Promise((resolve) => setTimeout(resolve, VIEW_POLL_MS));
              }
            },
          });
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
        case "request-review":
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
      if (busyRef.current !== null) return; // single flight (this panel)
      busyRef.current = kind;
      setBusy(kind);
      setError(null);
      setNotice(null);
      setProgress(null);
      try {
        /* W1-K (AUD-19.02): one Keplr conversation at a time across every tab of this site. Another tab holding it is
           said at once (never queued): pressing again later re-reads everything. */
        let outcome: ActionOutcome;
        if (KEPLR_ACTIONS.has(kind)) {
          const locked = await (services.keplrLock ?? browserKeplrLock()).withLock(() => perform(kind));
          outcome = locked.kind === "ran" ? locked.value : { ok: false, reason: KEPLR_BUSY_SENTENCE };
        } else {
          outcome = await perform(kind);
        }
        if (outcome.ok) {
          if (outcome.notice) setNotice(outcome.notice);
          /* "Change wallet" opens its question (the replacement); every other success closes any. */
          if (kind !== "confirm" && kind !== "replace-link") setNeeds(null);
          if (kind === "link" || kind === "relink" || kind === "reprove" || kind === "replace-confirmed") {
            setProofRefusedFor(null);
            if (kind === "replace-confirmed") {
              replaceTo.current = null;
              replaceFrom.current = null;
            }
          }
        } else if (outcome.needs === "replace" && outcome.replace !== undefined) {
          /* W2-M (AUD-20.14): the server's challenge answer named the standing wallet before Keplr signed: ask first,
             naming both; nothing was signed, so the replacement is one signature. */
          replaceTo.current = outcome.replace.to;
          replaceFrom.current = outcome.replace.from;
          setNeeds({ kind: "replace", from: outcome.replace.from, to: outcome.replace.to, again: false, said: null });
        } else if (outcome.needs === "same-wallet" && outcome.sameWallet !== undefined) {
          /* Owner ruling 2026-10-07: nothing was signed or linked; the panel shows the warning (not an error). */
          setNeeds({ kind: "same-wallet", wallet: outcome.sameWallet.wallet, then: kind });
        } else if (outcome.needs === "replace") {
          /* The server asked only after Keplr signed (a server that doesn't name the standing wallet beforehand, or a
             link made between the challenge and the signature): its answer spent that request, so Keplr signs once
             more. The question carries the server's own sentence: one surface, not an error beside it. */
          replaceTo.current = moneySession().address;
          replaceFrom.current = null;
          setNeeds({ kind: "replace", from: null, to: replaceTo.current, again: true, said: outcome.reason });
        } else {
          setError(outcome.reason);
          if (outcome.needs === "confirm") setNeeds({ kind: "confirm", then: kind });
          else if (outcome.needs === "connect") updateMoneySession({ wallet: "disconnected", address: null });
          else if (outcome.needs === "reprove") {
            const current = latest.current.view?.you?.link ?? null;
            setProofRefusedFor(current === null ? null : `${current.wallet}#${current.epoch}`);
          }
        }
      } catch (thrown) {
        /* Nothing here should throw; if something does, say so plainly (and nothing was signed after a throw). */
        setError(`That didn't finish (${thrown instanceof Error ? thrown.message.slice(0, 120) : "an unexpected error"}). Nothing was sent after it stopped.`);
      } finally {
        busyRef.current = null;
        setBusy(null);
        setProgress(null);
        bumpLocal();
      }
    },
    [perform, services],
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

  /* Owner ruling 2026-10-07: "Continue with this wallet" -- the account's acknowledgement is kept (`sameWalletAck.ts`:
     this account x this Authorization Wallet, on this browser), then the action the player pressed runs again. It
     selects no wallet: the run re-reads Keplr's account, and another account there is simply linked instead. */
  const acknowledgeSameWallet = useCallback(async () => {
    if (needs === null || needs.kind !== "same-wallet") return;
    const named = needs.wallet;
    const then = needs.then;
    setNeeds(null);
    setError(null);
    /* "Continue with THIS wallet": if Keplr has moved to another account since the card was shown, nothing is
       acknowledged and nothing runs -- the player presses again for the wallet Keplr is on now (asked as usual). */
    const pinned = services.pin();
    if (pinned.ok) {
      const now = await services.wallet.account(pinned.pin);
      if (now.ok && now.value.address !== named) {
        setError(`Keplr is on ${now.value.address} now, not ${named}. Nothing was signed or linked; press the button again to use the wallet Keplr is on.`);
        return;
      }
    }
    const acks = services.sameWalletAcks ?? browserSameWalletAcks();
    acks.acknowledge(sameWalletAccountKey((latest.current.port ?? sessionPort()).account?.username), named);
    await run(then);
  }, [needs, run, services]);

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
    progress,
    notice,
    error,
    needs,
    reviewing,
    run,
    openReview: () => setReviewing(true),
    closeReview: () => setReviewing(false),
    confirmed: continueAfterConfirm,
    acknowledgeSameWallet,
    disputeTerms,
    disputeRecord,
    readDisputeTerms: () => {
      const current = latest.current.view;
      if (current === null) return;
      setDisputeTerms({ kind: "loading" });
      void disputeChainFacts(current, services).then(setDisputeTerms);
    },
    cancelNeeds: () => {
      replaceTo.current = null;
      replaceFrom.current = null;
      setNeeds(null);
    },
    dismiss: () => {
      setNotice(null);
      setError(null);
    },
  };
}
