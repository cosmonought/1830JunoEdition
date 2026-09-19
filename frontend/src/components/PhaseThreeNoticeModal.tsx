// frontend/src/components/PhaseThreeNoticeModal.tsx
//
/* ==================================================================
    DESIGN NOTE 1441: THE PHASE 3 NOTICE -- PRIVATES ARE FOR SALE, UNTIL THE FIRST 5-TRAIN
   ==================================================================
   ASKED: "Since there isn't a specific subphase for these purchases, players may not be aware they can buy
   them. We need to add a modal notification as soon as Phase 3 is triggered, alerting all players that
   corporations can now buy private companies at any time during their turn. Remind them also the Private
   companies close at the start of Phase 5 when the first 5-train is purchased."
   ONE NOTICE, ON THE EDGE. The shell raises this when the derived phase goes from 2 to 3 while the log is
   live (the same seeded-edge pattern as the outro, #1418): a tab that loads a Phase 3 game sees no edge and
   gets no notice. Every player sees it, not just the one whose purchase turned the phase -- the rule is
   about what everybody's corporations may now do. Dismissed by its one button; nothing is pending behind it,
   so it is not blocking the way the fleet-loss modal is, and the backdrop click closes it too. */

import React from "react";

import { FONT_SIZE, RADIUS } from "../styles/typography";
import { NativeModal } from "./NativeModal";

export interface PhaseThreeNoticeModalProps {
  open: boolean;
  onAcknowledge: () => void;
}

/* ==================================================================
    DESIGN NOTE 1645: BATCH 4A -- ESCAPE MIRRORS THE BACKDROP, AND ONLY THE BACKDROP
   ==================================================================
   The modal audit (`claude/modal-audit-2026-09-18.md`) listed four acknowledge-style notices with no Escape
   (H3). They are not one group, and the split is a product decision rather than a mechanical one: an Escape
   on a surface whose only exit ADVANCES THE GAME would be a keypress that acts, not a keypress that closes.

   THIS ONE IS ELIGIBLE, and the evidence is measured rather than assumed: its backdrop already dismisses, and
   it dismisses through `onAcknowledge` -- the identical callback the visible control uses, with the identical
   state effect. In `App.tsx` that callback is `setPhaseThreeNotice(false)` and nothing else: the notice is a
   statement about a rule that has already changed, so hiding it changes no game state. So Escape here mirrors a route the player already has; it invents nothing.

   `PrivateRevenueModal` AND `FleetLossModal` ARE NOT, and this batch deliberately leaves them alone. Measured:
   their backdrops are `no-op` -- they have no dismissal route at all, only an acknowledgment button that
   advances play. "Close the overlay" and "perform its sole action" are different semantics, and a later pass
   may give those two guarded RESTORATION without Escape. `components/noticeModalDismissal.test.tsx` guards
   that boundary.

   THE HOOK LIVES IN A CHILD, as #1643 established: `open` here is a RENDER switch, not a mount switch --
   this component returns `null` when it is falsy and `App.tsx` keeps it mounted. A hook in the body would
   capture an opener when the game shell mounted and never run its restore on a close. The child mounts and
   unmounts with the dialog.
   AND ITS POSITION IN THE JSX IS LOAD-BEARING HERE. React 18 applies `autoFocus` in the commit's LAYOUT phase
   (`commitMount`), ordered by fiber position -- so the child must be rendered BEFORE the card for its capture
   to record the real opener rather than this notice's own "Got it" button. Measured both ways; a case in
   `components/noticeModalDismissal.test.tsx` asserts the order by asserting where focus lands. */
/* #1651: `DismissalLifecycle` stood here. It existed because a hook in the component body would have captured
   an opener when the game shell mounted and never run its restore on a close -- the render switch keeps the
   component mounted all session. `NativeModal` is only RENDERED past that switch, so it mounts and unmounts
   with the dialog, which is the lifecycle the contract was written against. */

export function PhaseThreeNoticeModal({ open, onAcknowledge }: PhaseThreeNoticeModalProps) {
  if (!open) return null;
  return (
    <NativeModal
      name="Phase 3: private companies are for sale"
      /* #1645, carried forward by #1651: Escape performs the same dismissal the backdrop already performs --
         which on this surface IS the acknowledgment, because the backdrop already acknowledged. It does not
         reach for a control that advances the game; there is none here but "Got it", which is this same
         `onAcknowledge`. */
      dismissible
      onDismiss={onAcknowledge}
      onScrimClick={(event) => {
        if (event.target === event.currentTarget) onAcknowledge();
      }}
      restoreOpener
      scrimStyle={styles.backdrop}
      testId="phase-three-notice"
    >
      <div style={styles.card}>
        <div style={styles.header}>
          <span style={styles.chip}>PHASE 3</span>
          <span style={styles.heading}>Private companies are for sale</span>
        </div>
        <p style={styles.body}>
          The first 3-train has been bought. From now on a corporation may buy a private company from any player{" "}
          <strong>at any time during its turn</strong> — use the <strong>Buy Private Company</strong> button on
          the action bar. The price must be between half and twice the private's face value, and the holder has
          to agree.
        </p>
        <p style={styles.body}>
          Private companies <strong>close at the start of Phase 5</strong>, when the first 5-train is bought. Keep
          that in mind if you want to use a private company's special power — it goes with the company.
        </p>
        <div style={styles.footer}>
          {/* #1645: `autoFocus` STAYS, and that is a measurement rather than an oversight. Batches 1 and 2
              replaced native autofocus because it beat the opener capture; here it does not. Verified by
              mutation: swapping it for an explicit ref-and-layout-effect changed no behaviour at all, and what
              DOES break the restore is moving the lifecycle child after this card. The initial-focus target
              and its mechanism are therefore left exactly as they were. */}
          <button type="button" style={styles.primaryButton} onClick={onAcknowledge} autoFocus data-testid="phase-three-notice-ok">
            Got it
          </button>
        </div>
      </div>
    </NativeModal>
  );
}

export default PhaseThreeNoticeModal;

const styles: Record<string, React.CSSProperties> = {
  backdrop: {
    position: "fixed",
    inset: 0,
    /* Under the fleet-loss modal (3800) -- a rusting is a precondition of a turn; this is a notice. */
    /* #1651: the `zIndex: 3700` that stood here is gone -- this scrim is a `<dialog>` in the top layer, which
       is above the whole document by definition, so the number decided nothing. */
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "24px",
    backgroundColor: "rgba(6, 9, 15, 0.72)",
  },
  card: {
    width: "min(540px, 100%)",
    display: "flex",
    flexDirection: "column",
    gap: "10px",
    padding: "18px 20px",
    borderRadius: RADIUS.layer,
    border: "1px solid #4a5a3a",
    backgroundColor: "#141914",
    boxShadow: "0 12px 40px rgba(0,0,0,0.6)",
    color: "#f2f0eb",
    fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif",
  },
  header: { display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" },
  chip: {
    padding: "2px 8px",
    borderRadius: RADIUS.pill,
    border: "1px solid #5a8a3a",
    backgroundColor: "#22331a",
    color: "#cfeabc",
    fontSize: FONT_SIZE.micro,
    fontWeight: 800,
    letterSpacing: "0.08em",
  },
  heading: { fontSize: FONT_SIZE.strong, fontWeight: 800 },
  body: { fontSize: FONT_SIZE.small, color: "#f2f0eb", lineHeight: 1.5, margin: 0 },
  footer: { display: "flex", justifyContent: "flex-end", gap: "8px", marginTop: "6px" },
  primaryButton: {
    padding: "7px 14px",
    borderRadius: RADIUS.card,
    border: "1px solid #3f7a55",
    backgroundColor: "#1d4030",
    color: "#e6f5ec",
    fontSize: FONT_SIZE.small,
    fontWeight: 700,
    cursor: "pointer",
  },
};
