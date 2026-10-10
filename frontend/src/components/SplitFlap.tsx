// frontend/src/components/SplitFlap.tsx
//
// PLAY LOBBY (approved design §4 "Split-flap"): a row of flap cells. Each cell steps through the drum to its new
// character -- 55 ms a step, at most 14 steps, cells staggered 40 ms left to right, a half-cell fold on every step.
// Reduced motion (the OS setting, or the page's `motion` choice): the new character simply appears.
//
// The cells are driven directly (textContent and a class), not through React state: a status change is up to fourteen
// steps on ten cells, and none of that is the application's state. The accessible text is the whole word, once.

import React, { useEffect, useRef } from "react";

import { FLAP_STAGGER_MS, FLAP_STEP_MS, flapPath, flapText } from "../utils/lobbyBoard";

export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined") return true;
  if (document.documentElement.dataset.motion === "reduced") return true;
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export interface SplitFlapProps {
  text: string;
  width: number;
  className?: string;
  /** What a screen reader hears (the cells themselves are hidden from it). */
  label?: string;
  title?: string;
  testId?: string;
}

export function SplitFlap({ text, width, className, label, title, testId }: SplitFlapProps) {
  const host = useRef<HTMLSpanElement | null>(null);
  const want = flapText(text, width);
  useEffect(() => {
    const root = host.current;
    if (root === null) return;
    const cells = Array.from(root.querySelectorAll<HTMLSpanElement>(".lb-cell"));
    const reduce = prefersReducedMotion();
    const timers: Array<ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>> = [];
    cells.forEach((cell, i) => {
      const to = want[i] ?? " ";
      if (cell.dataset.want === to) return;
      const from = cell.textContent && cell.textContent.length > 0 ? cell.textContent : " ";
      cell.dataset.want = to;
      if (reduce) {
        cell.textContent = to;
        return;
      }
      const path = flapPath(from, to);
      let k = 0;
      timers.push(
        setTimeout(() => {
          const step = setInterval(() => {
            if (k >= path.length) {
              clearInterval(step);
              cell.textContent = to;
              cell.classList.remove("lb-flip");
              return;
            }
            cell.textContent = path[k];
            k += 1;
            cell.classList.remove("lb-flip");
            void cell.offsetWidth;
            cell.classList.add("lb-flip");
          }, FLAP_STEP_MS);
          timers.push(step);
        }, i * FLAP_STAGGER_MS),
      );
    });
    return () => {
      for (const t of timers) {
        clearTimeout(t as ReturnType<typeof setTimeout>);
        clearInterval(t as ReturnType<typeof setInterval>);
      }
      /* An interrupted change lands on its character at once (the next change starts from there). */
      cells.forEach((cell) => {
        if (cell.dataset.want !== undefined && cell.textContent !== cell.dataset.want) {
          cell.textContent = cell.dataset.want;
          cell.classList.remove("lb-flip");
        }
      });
    };
  }, [want]);
  return (
    <span className={`lb-flap${className ? ` ${className}` : ""}`} title={title} data-testid={testId} data-text={want.trim()}>
      {label !== undefined && <span className="lb-sr">{label}</span>}
      <span ref={host} className="lb-cells" aria-hidden="true">
        {Array.from({ length: width }, (_, i) => (
          <span key={i} className="lb-cell" />
        ))}
      </span>
    </span>
  );
}

export default SplitFlap;
