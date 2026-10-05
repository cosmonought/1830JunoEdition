// The two decisions the auction can leave behind, in one card: the B&O's par
// price and the handoff into the Stock Round that follows it (Stock Round 1 in
// the standard game; a later one under the Delayed Auction -- DA-6, DA-F8b).
//
// Modal and undismissable FOR THE ACTOR -- the private is already won and the
// certificate already owed, so there is no legal state on the other side of
// cancelling.
//
// Phase 3 W2-H (OD-1, H5): only the actor gets this card -- the B&O par's owner,
// or, for the handoff, a seated player once nothing is owed. It is a
// `NativeModal` now: H5's blocker (a handoff card with zero tabbable controls)
// is gone, because a viewer who cannot act no longer gets the card at all. Every
// other viewer gets the non-modal `WaitingStatusBanner`, with no control.
// `parPending` and `handoffPending` are independent booleans rendering
// independent sections, so the three cases (par only / handoff only / both)
// merge without any internal step state. The par ladder is the Stock Round's
// own exported constant, not a retyped copy.
//
// See docs/ai_architecture/contract_economy.md, AuctionPromptModal.tsx #399
// and #547.

import React, { useCallback, useEffect, useRef, useState } from "react";

import { FONT_SIZE, RADIUS } from "../styles/typography";
import { NativeModal } from "./NativeModal";
import { NativeModalTurn } from "./NativeModalTurn";
import { PAR_VALUE_LADDER } from "./StockRoundPanel";
import { WaitingStatusBanner } from "./WaitingStatusBanner";
import type { LinkQueueState } from "../utils/serverLink";
import { LINK_QUEUED_NOTE } from "../utils/useLinkQueue";

/* ==================================================================
    6.5-B (H-02): THE PROMPT FOLLOWS THE BOARD, SO THE BUTTON HOLDS ITS OWN PRESS
   ==================================================================
   The par prompt used to vanish on click (the shell cleared a latch before sending), which is what stranded a
   player whose `SetBoPar` never landed. It now stays for exactly as long as the board owes the par -- and so a
   second press while the first is still travelling would send a second `SetBoPar` for the authority to refuse.
   The confirm is therefore held while ITS OWN send is in flight. It is released:
     - at once, when the board stops owing the par (the send landed: the par card simply goes away);
     - `PAR_SETTLE_GRACE_MS` after the send settles without that happening -- a refusal, or a send the link dropped
       at the door. The grace covers the moment between the server's answer and the drain applying the entry, so a
       send that DID land is not offered a second press;
     - and in any case after `PAR_SEND_HOLD_MS`, so a send that never answers can never leave the owner without the
       control.
   A release while the par is still owed says so ("not reached the table yet"), because the reason itself -- the
   link's banner or the refusal -- is drawn under this modal's backdrop.
   This is a debounce of one button, not an obligation: whether the prompt shows is still only the board's.

   PHASE 3 W3-I (AUD-02.05 / I-1, AUD-02.06 / I-2, AUD-19.01): WITH A ROOM LINK, THE LINK SAYS WHEN THE PRESS IS DONE.
     - I-1: a par sent while the link was reconnecting waits on the link, and the 4 s hold used to hand the owner a
       second press anyway; that second `SetBoPar` landed after the first and was refused. Now nothing releases the
       press while the link still holds a submission (`linkQueue.unsettled > 0`), and while it waits for a socket the
       card says so: "Queued — will send on reconnect." The link itself settles everything when it gives up (a resync,
       a close), so this can never hold for ever.
     - I-2: the note "not reached the table yet" used to fire on a timer, so a send that DID land but whose entry the
       drain had not applied within the grace was told to press again. Now it fires only after the landing signal:
       the link settled this press and reported it NOT applied (or nothing was sent at all). A press the link reports
       APPLIED keeps the card held until the board stops owing the par -- the card then goes away by itself -- and, as
       the last resort the old cap was, is released silently after another `PAR_SEND_HOLD_MS`.
   Without a room link (`linkQueue` absent: the Firestore / hotseat path) the behaviour above the line is unchanged. */
export const PAR_SEND_HOLD_MS = 4000;
export const PAR_SETTLE_GRACE_MS = 1500;
export const PAR_NOT_LANDED_NOTE = "Your par price has not reached the table yet — press again to retry.";

export interface AuctionPromptModalProps {
  /* Design note #543: `parPending` means "THIS viewer sets the par", never "a
     par is outstanding somewhere". Every client applies every action (#522), so
     the prompt is raised on all screens; the identity test lives in `App.tsx` and
     arrives here already resolved. `awaitingParFrom` carries the other half. */
  parPending: boolean;
  /** The winner's name, for the heading. Only read when `parPending`. */
  parWinnerLabel: string;
  /** 6.5-B (H-02): may return the submission's promise, so the button is held while that one send is in flight
   *  (at most `PAR_SEND_HOLD_MS`). The prompt itself stays until the board stops owing the par. */
  onConfirmPar: (parValue: string) => void | Promise<unknown>;

  /** The auction is over and the round has to be handed to the Stock Round. */
  handoffPending: boolean;
  /** Somebody OTHER than this viewer still owes the B&O a par price, by
   *  name. Blocks the handoff -- a corporation with a president and no price
   *  cannot be carried into a Stock Round. `null` when nothing is owed. */
  awaitingParFrom: string | null;
  onProceed: () => void;
  /* DA-6 (DA-F8b): the Stock Round the handoff opens -- `macro_round_number`, the slot the auction occupies (#905;
     the Activity Log's handoff line reads the same number). It said "Stock Round 1" at the end of EVERY auction,
     which under the Delayed Auction named a round the table played long ago. Absent reads as 1, the standard game. */
  nextStockRound?: number;
  /** DA-6: the table plays the Delayed Auction, so the auction is not "the Waterfall Auction" that opened the game. */
  delayedAuction?: boolean;
  /** Phase 3 W2-H (OD-1): may THIS viewer open the Stock Round? Any seated player may (the server's `submit` row is
   *  "seated only"); a watcher or spectator may not, and reads a status instead of the card. Decided in `App.tsx`
   *  by `viewerIsSeatedPlayer`. Defaults `true` so an existing caller is unaffected. */
  viewerActsOnHandoff?: boolean;
  /** Phase 3 W3-I: the room link's read-only queue state (`useLinkQueue`), or absent on a path with no room link. */
  linkQueue?: LinkQueueState;
}

export function AuctionPromptModal({
  parPending,
  parWinnerLabel,
  onConfirmPar,
  handoffPending,
  awaitingParFrom,
  onProceed,
  nextStockRound = 1,
  delayedAuction = false,
  viewerActsOnHandoff = true,
  linkQueue,
}: AuctionPromptModalProps) {
  /* Seeded at the top of the ladder rather than left blank. Every rung is
     legal, so there is no "unset" state worth representing -- and a
     pre-selected value means the player can confirm in one click if they do
     not care, rather than being made to choose before they can proceed. */
  const [selected, setSelected] = useState<string>(
    PAR_VALUE_LADDER[PAR_VALUE_LADDER.length - 1],
  );
  /* 6.5-B (H-02): the one send in flight, by a token so a late settle of an older press cannot release a newer
     one. `null` when nothing is travelling. `notLanded`: the last press was released with the par still owed. */
  const [sending, setSending] = useState<number | null>(null);
  const [notLanded, setNotLanded] = useState(false);
  const sendSerial = useRef(0);
  const activeToken = useRef<number | null>(null);
  /* Phase 3 W3-I: the link's queue, read by the timers below at the moment they fire, and its settlement count at the
     press, so "this press settled" is told apart from "something settled earlier". */
  const queueRef = useRef<LinkQueueState | undefined>(linkQueue);
  queueRef.current = linkQueue;
  const settledAtPress = useRef(0);
  /** Whether a landed press has already had its one extra hold. */
  const landedGrace = useRef(false);
  /** What the link says about the press now: still held, landed (an index was allocated), or not applied / unknown. */
  const linkVerdict = useCallback((): "held" | "landed" | "not-landed" => {
    const queue = queueRef.current;
    if (!queue) return "not-landed";
    if (queue.unsettled > 0) return "held";
    if (queue.settled > settledAtPress.current && queue.lastOutcome === "applied") return "landed";
    return "not-landed";
  }, []);
  const release = useCallback((token: number, note = true) => {
    if (activeToken.current !== token) return;
    activeToken.current = null;
    setSending(null);
    setNotLanded(note);
  }, []);
  /* The hold. With a room link it never releases while the link still holds the press (I-1) -- it re-arms -- and a
     press the link reports landed is released without the note (I-2). */
  const [holdRound, setHoldRound] = useState(0);
  useEffect(() => {
    if (sending === null) return undefined;
    const timer = window.setTimeout(() => {
      const verdict = linkVerdict();
      if (verdict === "held") {
        setHoldRound((round) => round + 1);
        return;
      }
      /* Landed: the drain will apply the entry and the board will stop owing the par. Give it one more hold, then let
         go silently -- never with the note, which would invite a second press of a par that has landed. */
      if (verdict === "landed" && !landedGrace.current) {
        landedGrace.current = true;
        setHoldRound((round) => round + 1);
        return;
      }
      release(sending, verdict !== "landed");
    }, PAR_SEND_HOLD_MS);
    return () => window.clearTimeout(timer);
  }, [sending, release, linkVerdict, holdRound]);
  // The par is no longer this viewer's to set (it landed, or was never theirs): nothing is in flight any more.
  useEffect(() => {
    if (parPending) return;
    activeToken.current = null;
    setSending(null);
    setNotLanded(false);
  }, [parPending]);

  /* W3-I (I-1): a submission the link still holds -- this press's, or one made before this card was (re)mounted -- is
     never followed by a second press. */
  const linkHolds = linkQueue !== undefined && linkQueue.unsettled > 0;
  const confirmHeld = sending !== null || linkHolds;
  const confirmPar = () => {
    if (confirmHeld) return;
    sendSerial.current += 1;
    const token = sendSerial.current;
    activeToken.current = token;
    settledAtPress.current = queueRef.current?.settled ?? 0;
    landedGrace.current = false;
    setSending(token);
    setNotLanded(false);
    const result = onConfirmPar(selected);
    const settled = () => {
      window.setTimeout(() => {
        /* W3-I (I-2): the note only after the landing signal says it did NOT land. Still held -> the hold above waits;
           landed -> the board will stop owing the par and the card goes away (the hold's cap is the backstop). */
        if (linkVerdict() !== "not-landed") return;
        release(token);
      }, PAR_SETTLE_GRACE_MS);
    };
    if (result && typeof (result as Promise<unknown>).then === "function") {
      (result as Promise<unknown>).then(settled, settled);
    } else {
      settled();
    }
  };

  const blocked = awaitingParFrom !== null;
  const stockRound = `Stock Round ${nextStockRound}`;
  const completeHeading = delayedAuction ? "The private company auction is complete" : "The Waterfall Auction is complete";

  /* ==================================================================
      PHASE 3 W2-H (OD-1, H5): THE ACTOR GETS THE CARD; EVERYONE ELSE GETS A STATUS
     ==================================================================
     WAS: every seat got the full-screen card. A seat that did not owe the par got the handoff half with a DISABLED
     Proceed -- the modal audit's H5, a scrim with zero tabbable controls -- and a seatless watcher got a live Proceed
     the server refuses. Now there are exactly two actors and one waiting surface:
       - the par's owner (`parPending`): the ladder and the confirm, as before;
       - with nothing owed, a seated player (`viewerActsOnHandoff`): the handoff and its Proceed, always live;
       - anyone else -- a seat while somebody else owes the par, or a watcher -- reads who the table is waiting on.
     TIMING THAT IS TRUE: the par is owed BEFORE anything else happens (`auctionHandoffRefusal` /
     `boParRefusal`: "before the Stock Round opens", "before the auction goes on"), and the Stock Round opens when a
     seated player proceeds, not by itself. */
  const parActor = parPending;
  const handoffActor = !parPending && handoffPending && !blocked && viewerActsOnHandoff;

  if (!parActor && !handoffActor) {
    if (blocked) {
      return (
        <WaitingStatusBanner
          heading={handoffPending ? completeHeading : "The B&O par comes first"}
          testId="auction-waiting"
        >
          {/* Design note #547: named, because "waiting" without a name is indistinguishable from being stuck. */}
          Waiting for {awaitingParFrom} to set the B&amp;O&rsquo;s par price.{" "}
          {handoffPending ? (
            <>Every private company has been allocated; {stockRound} can open once the par is set.</>
          ) : (
            <>The auction goes on once the par is set.</>
          )}
        </WaitingStatusBanner>
      );
    }
    if (handoffPending) {
      return (
        <WaitingStatusBanner heading={completeHeading} testId="auction-waiting">
          Every private company has been allocated. Waiting for a player to open {stockRound}.
        </WaitingStatusBanner>
      );
    }
    return null;
  }

  return (
    /* W3-A (AUD-13.07): opens itself, so it waits until no other native dialog is open (`NativeModalTurn`). */
    <NativeModalTurn>
    <NativeModal
      name={parActor ? "Set the B&O par value" : completeHeading}
      /* Forced: there is no legal state on the other side of closing (see the file note). */
      dismissible={false}
      /* The forced prompts never restored focus (batch 4B stopped short of choosing a target), and the player's
         next stop is the Stock Round, not the control that was focused before the card. */
      restoreOpener={false}
      scrimStyle={styles.backdrop}
      testId="auction-prompt"
    >
      <div style={styles.card}>
        {parActor ? (
          <>
            <span style={styles.heading}>
              {parWinnerLabel} wins the Baltimore &amp; Ohio
            </span>
            <p style={styles.body}>
              The B&amp;O private hands you the 20% President&rsquo;s Certificate free of
              charge. Set the price the B&amp;O floats at &mdash; every other share will be
              bought from its IPO at this price.
            </p>

            <div style={styles.ladder} role="group" aria-label="Par value">
              {PAR_VALUE_LADDER.map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={selected === value}
                  style={{
                    ...styles.rung,
                    ...(selected === value ? styles.rungActive : {}),
                  }}
                  onClick={() => setSelected(value)}
                >
                  ${value}
                </button>
              ))}
            </div>

            {/* The consequence of the choice, stated in money. A par is an
                abstract number until it is multiplied by ten, which is what
                the treasury receives at float (design note #134). */}
            <span style={styles.consequence}>
              Floats with ${Number(selected) * 10} in its treasury once 60% is sold.
            </span>

            <button
              type="button"
              style={{ ...styles.confirm, ...(confirmHeld ? styles.confirmDisabled : {}) }}
              onClick={confirmPar}
              disabled={confirmHeld}
              title={confirmHeld ? (linkQueue !== undefined && linkQueue.unsent > 0 ? LINK_QUEUED_NOTE : "Sending your par price — one moment.") : undefined}
            >
              {confirmHeld
                ? "Sending…"
                : <>Take the President&rsquo;s Certificate at ${selected}</>}
            </button>
            {/* Phase 3 W3-I (I-1): the press is waiting for the link to reconnect -- said, and no second press. */}
            {linkQueue !== undefined && linkQueue.unsent > 0 && (
              <span style={styles.waiting} role="status" data-testid="par-link-queued">
                {LINK_QUEUED_NOTE}
              </span>
            )}
            {!confirmHeld && notLanded && (
              <span style={styles.waiting} role="status">
                {PAR_NOT_LANDED_NOTE}
              </span>
            )}
          </>
        ) : (
          <>
            <span style={styles.heading}>{completeHeading}</span>
            <p style={styles.body}>
              {delayedAuction ? (
                <>
                  Every private company has been allocated. {stockRound} opens next, and the B&amp;O is now
                  open for trading like any other corporation.
                </>
              ) : (
                <>
                  Every private company has been allocated. {stockRound} opens next &mdash;
                  corporations can be started and shares bought from their IPOs.
                </>
              )}
            </p>

            {/* W2-H: never disabled. A viewer who cannot proceed (a par still owed, or a watcher) is on the waiting
               status above and never reaches this button. */}
            <button
              type="button"
              style={styles.confirm}
              onClick={onProceed}
              title={`Close the auction and open ${stockRound}.`}
            >
              Proceed to {stockRound} &#8250;
            </button>
          </>
        )}
      </div>
    </NativeModal>
    </NativeModalTurn>
  );
}

const styles: Record<string, React.CSSProperties> = {
  /* W2-H: a `<dialog>` in the top layer now (`NativeModal`), so the `zIndex: 4000` that stood here decides nothing
     and is gone, as on every other migrated surface (#1651). */
  backdrop: {
    position: "fixed",
    inset: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "24px",
    backgroundColor: "rgba(8, 10, 16, 0.72)",
  },
  card: {
    display: "flex",
    flexDirection: "column",
    gap: "12px",
    width: "min(460px, 100%)",
    padding: "18px 20px",
    borderRadius: RADIUS.layer,
    border: "1px solid #3a3a3a",
    backgroundColor: "#1c1c1c",
    color: "#f2f0eb",
    boxShadow: "0 18px 48px rgba(0,0,0,0.5)",
  },
  heading: { fontSize: FONT_SIZE.heading, fontWeight: 800 },
  body: { margin: 0, fontSize: FONT_SIZE.body, lineHeight: 1.5, color: "#a8a6a0" },
  ladder: { display: "flex", flexWrap: "wrap", gap: "6px" },
  rung: {
    flex: "1 1 auto",
    padding: "9px 4px",
    borderRadius: RADIUS.control,
    border: "1px solid #3a3a3a",
    backgroundColor: "#141414",
    color: "#f2f0eb",
    font: "inherit",
    fontWeight: 700,
    fontVariantNumeric: "tabular-nums",
    cursor: "pointer",
  },
  // #1449: the shorthand, not `borderColor` -- the base is `1px solid #3a3a3a`.
  rungActive: { border: "1px solid #4d8ee0", backgroundColor: "#1d3a55", color: "#f2f0eb" },
  consequence: {
    fontSize: FONT_SIZE.micro,
    color: "#a8a6a0",
    fontVariantNumeric: "tabular-nums",
  },
  waiting: {
    fontSize: FONT_SIZE.small,
    color: "#d9c08a",
    fontWeight: 700,
  },
  confirm: {
    padding: "11px 16px",
    borderRadius: RADIUS.card,
    border: "1px solid #4d8ee0",
    backgroundColor: "#2f6fb2",
    color: "#f2f0eb",
    font: "inherit",
    fontWeight: 800,
    fontSize: FONT_SIZE.strong,
    cursor: "pointer",
  },
  confirmDisabled: { opacity: 0.45, cursor: "not-allowed" },
};

export default AuctionPromptModal;
