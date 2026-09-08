// frontend/src/components/MoneyMachinePanel.tsx
//
// The one panel both money machines draw: a stripe, a line that moves, a line that settles.
//
// ==================================================================
//  DESIGN NOTE 1291: ONE PANEL, ONE MERGE, ONE CORNER
// ==================================================================
//
// REPORTED, in three parts on the same evening:
//   16  "the Dividends payout animation ... shows the payout amount, but instead of merging-summing into the
//       treasury value below it, it simply slides out and the slide-out panel narrows to the updated value."
//   14  "The Treasury payment slide-out does not actually merge the numbers and does not stay out after it
//       completes the change."
//   17  "these cash/treasury slide-outs being in different places is too much cognitive work ... the
//       slide-outs should be happening at the same place (bottom right) and we need to immediately cue
//       players to which it is."
//
// THE MERGE WAS NEVER A MERGE. #1082 built the "fall" as a 26px drop-and-fade of the whole payer row while
// its grid track collapsed to zero (#1163). Built to the letter of the spec, and what the eye sees is a row
// disappearing and a panel getting shorter -- the report, exactly. A merge is a FIGURE travelling into
// another figure. So the amount itself now flies: measured from where it sits to where the total sits, moved
// there over the fall, fading as it arrives, and the total flips to the new value on impact. The row's height
// never changes; nothing narrows. Downward for a payout into cash, upward for a spend out of a treasury
// (16a) -- the same flight, read from the same two rectangles, with the sign in the colour.
//
// `left`/`top`, NOT A TRANSFORM. #1289 found that a translate inside the chrome zoom lands in the wrong
// pixel space; the rectangles here are measured in screen pixels and divided back into layout pixels
// (#1144), then applied as offsets on a relatively positioned span, which are layout lengths and zoom
// exactly as the panel does.
//
// THE CUE FOR WHICH MONEY THIS IS (17), ruled:
//   - the corporation's panel wears the corporation's card header -- livery, herald, ticker -- and says
//     TREASURY; the player's wears the seat stripe with the name and says CASH. Heralds appear on
//     corporation surfaces only, so the herald alone is the fast read;
//   - square corners for the player's, rounded for the corporation's -- the same rule every player and
//     corporation card in the app now follows (#1291a);
//   - the spend merges upward, the payout downward.
// Both sit bottom right. When both are up at once the caller stacks the second above the first.

import React, { useEffect, useRef, useState } from "react";
import { FONT_SIZE, RADIUS } from "../styles/typography";
import { CARD_BORDER, CARD_DIVIDER, CARD_INK, CARD_INK_MUTED, CARD_SURFACE } from "../styles/palette";
import { getUiScale } from "../utils/uiScale";
import { CorporateLogo } from "./CorporateLogo";
import { MONEY_MACHINE_FALL_MS, MONEY_MACHINE_SLIDE_MS } from "./moneyMachineSchedule";

export type MoneyMachinePhase = "holding" | "falling" | "merged" | "leaving";

export interface MoneyMachinePanelProps {
  /** Fresh per event, so identical events remount (#1060). */
  token: number;
  phase: MoneyMachinePhase;
  /** Whose money. Decides the corner treatment and the header's vocabulary. */
  kind: "player" | "corporation";
  header: {
    label: string;
    /** The stripe's fill -- a seat colour or a livery. `null` draws the neutral band. */
    fill: string | null;
    ink: string;
    /** Corporation only: the herald beside the ticker. */
    heraldTicker?: string;
  };
  mover: {
    label: React.ReactNode;
    /** Already signed and formatted: "+$54", "−$180". */
    amountText: string;
    ink: string;
  };
  holder: {
    /** "Cash" or "Treasury". */
    label: string;
    before: number;
    after: number;
  };
  /** Which panel in the corner: 0 is the corner itself, 1 sits above it. */
  stackIndex?: number;
  /** Phase class names the caller wants on the mover row (kept for the callers' own pins). */
  moverClassName?: string;
}

/** The flight: the amount span travels to the total span over the fall and fades as it lands. */
function useMergeFlight(
  phase: MoneyMachinePhase,
  amountRef: React.RefObject<HTMLSpanElement | null>,
  totalRef: React.RefObject<HTMLSpanElement | null>,
): void {
  const flightRef = useRef<Animation | null>(null);
  useEffect(() => {
    flightRef.current?.cancel();
    flightRef.current = null;
    if (phase !== "falling") return undefined;
    const amount = amountRef.current;
    const total = totalRef.current;
    if (!amount || !total || typeof amount.animate !== "function") return undefined;
    const from = amount.getBoundingClientRect();
    const to = total.getBoundingClientRect();
    // Right edges meet: both figures are right-aligned, so the digits land on the digits.
    const scale = getUiScale(); // #1294: the scale at the moment of measurement
    const dx = (to.right - from.right) / scale;
    const dy = (to.top + to.height / 2 - (from.top + from.height / 2)) / scale;
    flightRef.current = amount.animate(
      [
        { left: "0px", top: "0px", opacity: 1 },
        { left: `${dx}px`, top: `${dy}px`, opacity: 0.15 },
      ],
      { duration: MONEY_MACHINE_FALL_MS, easing: "cubic-bezier(0.55, 0, 0.9, 0.55)", fill: "forwards" },
    );
    return () => {
      flightRef.current?.cancel();
      flightRef.current = null;
    };
  }, [phase, amountRef, totalRef]);
}

export function MoneyMachinePanel({
  token,
  phase,
  kind,
  header,
  mover,
  holder,
  stackIndex = 0,
  moverClassName,
}: MoneyMachinePanelProps) {
  const amountRef = useRef<HTMLSpanElement | null>(null);
  const totalRef = useRef<HTMLSpanElement | null>(null);
  useMergeFlight(phase, amountRef, totalRef);
  /* The amount is gone once it has LANDED -- which only happens after a flight. A reduced-motion reader
     never sees a flight (the machine starts at `merged`), and for them the figure stays beside the total as a
     static statement: #606's rule, "the information is the number, never the movement". The row keeps its
     height either way, so the panel does not reflow. */
  const flewRef = useRef(false);
  const [landed, setLanded] = useState(false);
  useEffect(() => {
    if (phase === "falling") flewRef.current = true;
    if (phase === "holding") flewRef.current = false;
    setLanded(flewRef.current && (phase === "merged" || phase === "leaving"));
  }, [phase]);

  const shown = phase === "holding" || phase === "falling" ? holder.before : holder.after;
  const corporation = kind === "corporation";
  /* The divider sits between the two rows, whichever order they take. */
  const moverRow = (
    <div style={{ ...styles.row, ...(corporation ? styles.secondRow : null) }} className={moverClassName}>
      <span style={styles.rowLabel}>{mover.label}</span>
      <span
        ref={amountRef}
        style={{
          ...styles.amount,
          color: mover.ink,
          ...(landed ? styles.amountLanded : null),
        }}
      >
        {mover.amountText}
      </span>
    </div>
  );
  const holderRow = (
    <div style={{ ...styles.row, ...(corporation ? null : styles.secondRow) }}>
      <span style={styles.holderLabel}>{holder.label}</span>
      <span ref={totalRef} style={styles.holderTotal}>
        ${shown}
      </span>
    </div>
  );

  return (
    <>
      <style>{MACHINE_CSS}</style>
      <div
        key={token}
        style={{
          ...styles.panel,
          borderRadius: corporation ? RADIUS.card : 0,
          bottom: `${CORNER_BOTTOM_PX + stackIndex * STACK_STEP_PX}px`,
        }}
        className={phase === "leaving" ? "app-money-panel app-money-panel-out" : "app-money-panel"}
        role="status"
        aria-live="polite"
      >
        <header
          style={{
            ...styles.stripe,
            ...(header.fill ? { backgroundColor: header.fill, color: header.ink } : styles.stripeUnknown),
          }}
        >
          {header.heraldTicker !== undefined && (
            <CorporateLogo
              ticker={header.heraldTicker}
              size={16}
              color={header.fill ? header.ink : CARD_INK}
              title={`${header.heraldTicker} herald`}
              fallbackStyle={{ ...styles.heraldFallback, color: header.fill ? header.ink : CARD_INK }}
            />
          )}
          <span style={styles.stripeLabel}>{header.label}</span>
        </header>
        {/* Design note #1291: a payout falls onto cash; a spend rises out of a treasury. */}
        {corporation ? holderRow : moverRow}
        {corporation ? moverRow : holderRow}
      </div>
    </>
  );
}

export default MoneyMachinePanel;

/** The corner both panels share, and the step the second one sits above the first. */
export const CORNER_BOTTOM_PX = 84;
export const STACK_STEP_PX = 118;

const MACHINE_CSS = `
@keyframes app-money-panel-in {
  from { right: -280px; opacity: 0; }
  to   { right: 24px; opacity: 1; }
}
.app-money-panel {
  animation: app-money-panel-in ${MONEY_MACHINE_SLIDE_MS}ms cubic-bezier(0.2, 0.8, 0.3, 1);
}
.app-money-panel-out {
  opacity: 0;
  transition: opacity ${MONEY_MACHINE_SLIDE_MS}ms ease;
}
@media (prefers-reduced-motion: reduce) {
  .app-money-panel { animation: none; }
  .app-money-panel-out { transition: none; opacity: 1; }
}
`;

const styles: Record<string, React.CSSProperties> = {
  panel: {
    position: "fixed",
    right: "24px",
    zIndex: 4100,
    display: "flex",
    flexDirection: "column",
    gap: "2px",
    minWidth: "210px",
    padding: "0 0 9px",
    border: `1px solid ${CARD_BORDER}`,
    overflow: "hidden",
    backgroundColor: CARD_SURFACE,
    boxShadow: "0 10px 28px rgba(0,0,0,0.55)",
    color: CARD_INK,
    fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif",
    pointerEvents: "none",
  },
  stripe: {
    display: "flex",
    alignItems: "center",
    gap: "7px",
    padding: "5px 13px",
    fontSize: FONT_SIZE.small,
    fontWeight: 800,
    letterSpacing: "0.2px",
    overflow: "hidden",
    whiteSpace: "nowrap",
  },
  stripeUnknown: { backgroundColor: CARD_DIVIDER, color: CARD_INK },
  stripeLabel: { overflow: "hidden", textOverflow: "ellipsis" },
  heraldFallback: { fontSize: FONT_SIZE.micro, fontWeight: 700 },
  row: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "12px",
    padding: "7px 13px 0",
  },
  rowLabel: {
    display: "inline-flex",
    alignItems: "center",
    gap: "6px",
    fontSize: FONT_SIZE.small,
    fontWeight: 700,
    color: CARD_INK_MUTED,
    letterSpacing: "0.03em",
    minWidth: 0,
  },
  amount: {
    /* Relative, so the flight's `left`/`top` are layout offsets from here (#1289). */
    position: "relative",
    fontSize: FONT_SIZE.strong,
    fontWeight: 800,
    fontVariantNumeric: "tabular-nums",
    flex: "none",
  },
  amountLanded: { opacity: 0 },
  secondRow: {
    marginTop: "4px",
    paddingTop: "5px",
    borderTop: `1px solid ${CARD_DIVIDER}`,
  },
  holderLabel: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 700,
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    color: CARD_INK_MUTED,
  },
  holderTotal: {
    fontSize: FONT_SIZE.strong,
    fontWeight: 800,
    fontVariantNumeric: "tabular-nums",
    flex: "none",
  },
};
