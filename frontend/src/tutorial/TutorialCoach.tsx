// frontend/src/tutorial/TutorialCoach.tsx
//
/* ==================================================================
    PHASE 3 FINAL PLAY TUTORIAL: THE COACH -- A NON-MODAL CARD AND AN OPTIONAL SPOTLIGHT
   ==================================================================
   NOT A DIALOG THE GAME WAITS ON. The old tutorial was a full-screen scrim; a `NativeModal` would be worse still for
   this job, because `showModal()` makes the whole board inert and a contextual lesson exists to point INTO the live
   board. So the coach is a compact card with no scrim: the board stays usable, the player may act while it is up,
   and nothing about a legal move changes.

   THE SPOTLIGHT NEVER TAKES INPUT. It is a ring drawn over the target with `pointer-events: none` and
   `aria-hidden`, so a click on the highlighted control reaches the control. What it highlights is also said in words
   on the card ("Highlighted: ...").

   ACCESSIBILITY. A region labelled "Tutorial", never `aria-modal`, never a focus trap, and it does not steal focus
   when it appears: the always-mounted polite live region in `TutorialLayer` announces each new lesson instead.
   Keyboard: Alt+Shift+T moves focus to the coach (and back out to where it came from when the lesson is answered);
   Escape while focus is INSIDE the coach answers it -- and is consumed there (`preventDefault`), so it can never also
   close some other layer, and an Escape anywhere else is never the coach's.

   RENDERED OUTSIDE THE ZOOMED SHELL (a portal to `document.body`, as the cinematics are), so the viewport rectangles
   `placement.ts` works in are the coach's own pixels. The card's CONTENT still follows the player's UI scale: the
   positioned box is sized in viewport pixels and its inner column is zoomed, so text grows with the rest of the app
   while the geometry stays in one coordinate space. */

import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CONTROL_PADDING, FONT_FAMILY, FONT_SIZE, LINE_HEIGHT, RADIUS } from "../styles/typography";
import { SANDBOX_INK, SANDBOX_RAISED, SANDBOX_RULE_STRONG } from "../styles/palette";
import { lessonById, lessonText, type LessonId, type LessonScope, type RulesPageId } from "./lessons";
import { anchorSelector, presentationFor } from "./presentation";
import { coachWidth, placeCoach, type Box, type Placement } from "./placement";
import { useUiScale } from "../utils/useUiScale";

/** The coach's stacking order: above the shell's status dock (3000) and waiting banner (3900), below toasts (4000)
 *  and popovers. Every native dialog is in the top layer above it -- and the coordinator never shows a coach while
 *  one is open. */
export const COACH_Z_INDEX = 3950;
/** Alt+Shift+T: move keyboard focus to the coach. */
export const COACH_FOCUS_SHORTCUT = "Alt+Shift+T";

export interface TutorialCoachProps {
  readonly lessonId: LessonId;
  readonly subject?: number;
  readonly scope: LessonScope;
  readonly onAcknowledge: () => void;
  readonly onTurnOff: () => void;
  readonly onOpenLibrary: () => void;
  /** Opens the Stock Market chart; offered only by lessons about a price move, never taken automatically. */
  readonly onShowMarket?: () => void;
  readonly onOpenRules?: (page: RulesPageId, anchor?: string) => void;
  /** Where focus goes when the coach that held it goes away and nothing else is waiting for it (the game-screen
   *  heading, as the notice chain uses). */
  readonly fallbackFocus?: () => HTMLElement | null;
}

/** Whether focus is in a field where Alt+Shift+T may be typing a character. */
function editableFocused(): boolean {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return false;
  return active.isContentEditable || active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || active instanceof HTMLSelectElement;
}

function visibleBox(element: Element | null): Box | null {
  if (!element || !element.isConnected) return null;
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  if (rect.bottom <= 0 || rect.right <= 0 || rect.top >= viewportHeight || rect.left >= viewportWidth) return null;
  return { top: rect.top, left: rect.left, width: rect.width, height: rect.height };
}

/** The first of a lesson's anchors that is mounted and on screen, or `null` (an unanchored card). */
export function resolveAnchorBox(anchors: readonly string[], root: ParentNode = document): Box | null {
  for (const anchor of anchors) {
    for (const element of Array.from(root.querySelectorAll(anchorSelector(anchor)))) {
      const box = visibleBox(element);
      if (box) return box;
    }
  }
  return null;
}

/** The fixed chrome to keep clear of: the sticky action dock, the bottom status dock, the waiting banner (which also
 *  carries the emergency waiting card) and the action toast. */
function chromeBoxes(): Box[] {
  const boxes: Box[] = [];
  for (const selector of ["[data-sticky-dock]", "[data-status-dock]", "[data-waiting-status]", "[data-action-toast]"]) {
    for (const element of Array.from(document.querySelectorAll(selector))) {
      const box = visibleBox(element);
      if (box) boxes.push(box);
    }
  }
  return boxes;
}

export function TutorialCoach({
  lessonId,
  subject,
  scope,
  onAcknowledge,
  onTurnOff,
  onOpenLibrary,
  onShowMarket,
  onOpenRules,
  fallbackFocus,
}: TutorialCoachProps) {
  const lesson = lessonById(lessonId);
  const presentation = presentationFor(lessonId, subject);
  const cardRef = useRef<HTMLElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const headingId = useId();
  const eyebrowId = useId();
  const uiScale = useUiScale();
  const [expanded, setExpanded] = useState(false);
  const [target, setTarget] = useState<Box | null>(null);
  const [placement, setPlacement] = useState<Placement | null>(null);

  useEffect(() => setExpanded(false), [lessonId]);

  const measure = useCallback(() => {
    const anchorBox = resolveAnchorBox(presentation.anchors);
    const card = cardRef.current;
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const visual = card ? card.getBoundingClientRect().height || card.offsetHeight : 0;
    const size = { width: coachWidth(viewport.width, 12, uiScale), height: visual > 0 ? visual : 180 };
    const next = placeCoach({ target: anchorBox, card: size, viewport, avoid: chromeBoxes() });
    setTarget((current) => (sameBox(current, anchorBox) ? current : anchorBox));
    setPlacement((current) =>
      current && current.top === next.top && current.left === next.left && current.side === next.side ? current : next,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presentation.anchors.join("|"), uiScale]);

  useLayoutEffect(() => {
    measure();
  }, [measure, expanded, lessonId]);

  /* Resize, scroll (any scroller), and a slow poll for the things no event announces: a tab switch mounting the
     target, the UI scale changing the shell under a fixed window. */
  useEffect(() => {
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    const timer = window.setInterval(measure, 500);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
      window.clearInterval(timer);
    };
  }, [measure]);

  /* Leaving the coach by its own controls: if focus was inside it, it goes back where Alt+Shift+T took it from, or --
     when focus arrived by Tab, or that place is gone -- to the shell's fallback, never to <body>. */
  const leave = useCallback(
    (action: () => void) => {
      const card = cardRef.current;
      const focusInside = card !== null && card.contains(document.activeElement);
      const back = returnFocusRef.current;
      returnFocusRef.current = null;
      action();
      if (!focusInside) return;
      const target = back && back.isConnected ? back : fallbackFocus?.() ?? null;
      target?.focus({ preventScroll: true });
    },
    [fallbackFocus],
  );
  const acknowledge = useCallback(() => leave(onAcknowledge), [leave, onAcknowledge]);

  /* Alt+Shift+T: into the coach. Physical key, so a layout or Option-key character cannot hide it. */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.altKey && event.shiftKey && event.code === "KeyT")) return;
      const card = cardRef.current;
      if (!card || editableFocused()) return;
      event.preventDefault();
      const active = document.activeElement;
      if (active instanceof HTMLElement && !card.contains(active)) returnFocusRef.current = active;
      card.querySelector<HTMLElement>("button")?.focus({ preventScroll: true });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!lesson) return null;
  const text = lessonText(lesson, scope);
  const width = coachWidth(typeof window === "undefined" ? 1024 : window.innerWidth, 12, uiScale);
  const position: React.CSSProperties = placement
    ? { top: `${placement.top}px`, left: `${placement.left}px` }
    : { right: "12px", bottom: "12px" };
  const rules = lesson.rules;

  return createPortal(
    <>
      {target && (
        <div
          data-tutorial-spotlight=""
          aria-hidden="true"
          style={{
            ...styles.spotlight,
            top: `${target.top - 4}px`,
            left: `${target.left - 4}px`,
            width: `${target.width + 8}px`,
            height: `${target.height + 8}px`,
          }}
        />
      )}
      <section
        ref={cardRef}
        data-tutorial-coach=""
        data-lesson={lessonId}
        data-placement={placement?.side ?? "floating"}
        /* A labelled <section> IS a region (its implicit role); never a dialog, never aria-modal. */
        aria-labelledby={`${eyebrowId} ${headingId}`}
        aria-keyshortcuts={COACH_FOCUS_SHORTCUT}
        style={{ ...styles.card, ...position, width: `${width}px`, maxWidth: "calc(100vw - 24px)" }}
        onKeyDown={(event) => {
          if (event.key !== "Escape" || event.defaultPrevented) return;
          event.preventDefault();
          event.stopPropagation();
          acknowledge();
        }}
      >
        <div style={{ ...styles.column, zoom: uiScale, width: `${width / uiScale}px` } as React.CSSProperties}>
        <span id={eyebrowId} style={styles.eyebrow}>
          Tutorial
        </span>
        <h2 id={headingId} style={styles.title}>
          {text.title}
        </h2>
        <p style={styles.summary}>{text.summary}</p>
        {expanded && text.detail && text.detail.length > 0 && (
          <div style={styles.detail} id={`${headingId}-more`}>
            {text.detail.map((line) => (
              <p key={line} style={styles.detailLine}>
                {line}
              </p>
            ))}
          </div>
        )}
        {target && presentation.describe && <p style={styles.highlighted}>Highlighted: {presentation.describe}</p>}
        <div style={styles.primaryRow}>
          <button type="button" style={styles.primaryButton} onClick={acknowledge} data-testid="tutorial-coach-ok">
            Got it
          </button>
          {text.detail && text.detail.length > 0 && (
            <button
              type="button"
              style={styles.secondaryButton}
              aria-expanded={expanded}
              aria-controls={`${headingId}-more`}
              onClick={() => setExpanded((open) => !open)}
            >
              {expanded ? "Less" : "More"}
            </button>
          )}
          {presentation.showMarket && onShowMarket && (
            <button type="button" style={styles.secondaryButton} onClick={onShowMarket} data-testid="tutorial-coach-market">
              Show the Stock Market
            </button>
          )}
        </div>
        <div style={styles.linkRow}>
          {rules && onOpenRules && (
            <button type="button" style={styles.linkButton} onClick={() => onOpenRules(rules.page, rules.anchor)}>
              Rules Reference
            </button>
          )}
          <button type="button" style={styles.linkButton} onClick={onOpenLibrary}>
            Tutorials
          </button>
          <button type="button" style={styles.linkButton} onClick={() => leave(onTurnOff)} data-testid="tutorial-coach-off">
            Turn off automatic tutorials
          </button>
        </div>
        </div>
      </section>
    </>,
    document.body,
  );
}

function sameBox(a: Box | null, b: Box | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.top === b.top && a.left === b.left && a.width === b.width && a.height === b.height;
}

const VISUALLY_HIDDEN: React.CSSProperties = {
  position: "absolute",
  width: "1px",
  height: "1px",
  padding: 0,
  margin: "-1px",
  overflow: "hidden",
  clip: "rect(0, 0, 0, 0)",
  whiteSpace: "nowrap",
  border: 0,
};

/** The always-mounted half: the polite announcement of each new lesson, plus the coach while one is presented. A
 *  live region must exist before its text changes to be announced, which is why it does not mount with the card. */
export function TutorialLayer({
  presented,
  ...rest
}: Omit<TutorialCoachProps, "lessonId" | "subject"> & {
  readonly presented: { readonly id: LessonId; readonly subject?: number } | null;
}) {
  /* Each lesson is announced ONCE per mount: a lesson suspended under a dialog and then restored is not read out again
     every time some other dialog opens and closes. Set a tick after mount, so a region that mounts with a lesson
     already presented still changes and is announced. */
  const announcedRef = useRef(new Set<string>());
  const [announcement, setAnnouncement] = useState("");
  const presentedId = presented?.id ?? null;
  useEffect(() => {
    if (!presentedId || announcedRef.current.has(presentedId)) return undefined;
    const lesson = lessonById(presentedId);
    if (!lesson) return undefined;
    const text = lessonText(lesson, rest.scope);
    const timer = window.setTimeout(() => {
      announcedRef.current.add(presentedId);
      setAnnouncement(`Tutorial: ${text.title}. ${text.summary} Press ${COACH_FOCUS_SHORTCUT} to reach it.`);
    }, 50);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presentedId]);
  return (
    <>
      <div role="status" aria-live="polite" style={VISUALLY_HIDDEN} data-testid="tutorial-announcer">
        {announcement}
      </div>
      {presented && <TutorialCoach key={presented.id} lessonId={presented.id} subject={presented.subject} {...rest} />}
    </>
  );
}

const styles: Record<string, React.CSSProperties> = {
  spotlight: {
    position: "fixed",
    zIndex: COACH_Z_INDEX - 1,
    pointerEvents: "none",
    borderRadius: RADIUS.card,
    border: "2px solid #c9a94c",
    boxShadow: "0 0 0 4px rgba(201, 169, 76, 0.28), 0 0 18px rgba(201, 169, 76, 0.45)",
    boxSizing: "border-box",
  },
  column: { display: "flex", flexDirection: "column", gap: "8px", padding: "14px 16px", boxSizing: "border-box" },
  card: {
    position: "fixed",
    zIndex: COACH_Z_INDEX,
    maxHeight: "70vh",
    overflowY: "auto",
    overflowX: "hidden",
    boxSizing: "border-box",
    borderRadius: RADIUS.layer,
    border: "1px solid #c9a94c",
    backgroundColor: "#141414",
    color: "#f2f0eb",
    boxShadow: "0 16px 40px rgba(0,0,0,0.55)",
    fontFamily: FONT_FAMILY,
  },
  eyebrow: { fontSize: FONT_SIZE.micro, letterSpacing: "0.08em", textTransform: "uppercase", color: "#c9a94c", fontWeight: 700 },
  title: { margin: 0, fontSize: FONT_SIZE.strong, fontWeight: 800, color: "#f2f0eb" },
  summary: { margin: 0, fontSize: FONT_SIZE.body, lineHeight: LINE_HEIGHT.normal, color: "#e2e0da" },
  detail: { display: "flex", flexDirection: "column", gap: "4px" },
  detailLine: { margin: 0, fontSize: FONT_SIZE.small, lineHeight: LINE_HEIGHT.normal, color: "#c8c6c0" },
  highlighted: { margin: 0, fontSize: FONT_SIZE.small, color: "#a8a6a0", fontStyle: "italic" },
  primaryRow: { display: "flex", flexWrap: "wrap", gap: "8px", marginTop: "2px" },
  linkRow: { display: "flex", flexWrap: "wrap", gap: "4px 12px" },
  primaryButton: {
    fontSize: FONT_SIZE.control,
    fontWeight: 700,
    padding: CONTROL_PADDING.button,
    borderRadius: RADIUS.card,
    border: `1px solid ${SANDBOX_RULE_STRONG}`,
    backgroundColor: SANDBOX_RAISED,
    color: SANDBOX_INK,
    cursor: "pointer",
  },
  secondaryButton: {
    fontSize: FONT_SIZE.control,
    fontWeight: 600,
    padding: CONTROL_PADDING.button,
    borderRadius: RADIUS.card,
    border: "1px solid #3a3a3a",
    backgroundColor: "transparent",
    color: "#c8c6c0",
    cursor: "pointer",
  },
  linkButton: {
    padding: 0,
    border: "none",
    background: "none",
    color: "#a8a6a0",
    fontSize: FONT_SIZE.small,
    textDecoration: "underline",
    cursor: "pointer",
    fontFamily: "inherit",
  },
};
