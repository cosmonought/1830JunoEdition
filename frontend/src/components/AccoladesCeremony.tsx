// frontend/src/components/AccoladesCeremony.tsx
//
/* ==================================================================
    DESIGN NOTE 1417: THE CEREMONY -- ROWS OF LIVERY, AND CARDS THAT LAND ON THEM
   ==================================================================
   REPORTED of the first shelf: "displayed haphazardly: it's just a bunch of blocks that seem to be
   color-sorted but I don't immediately know what the colors represent." ASKED: the corporations as rows with
   their livery stripe fading out by 20-30% of the width (the Auto-Buy modal's stripe, #1384), each corporate
   accolade a badge along its row; the players below, the same; and an animated version -- each accolade
   appears centre-screen with its icon and description, then scales down onto its row, which fades in to claim
   it; corporate first, then the player rows sweep in staggered, then the player accolades; confetti.
   THE SETTLED PAGE IS THE ANIMATION'S LAST FRAME. One layout, drawn once; the animation is a script of steps
   (`present` this accolade, `land` it, `sweep` the player rows, `done`) driven by timers, and every step only
   changes which rows and badges are visible and where the presenting card is. Skip jumps to the last step;
   the settled page offers "Replay"; nothing else advances it (a stray click must not cost anyone a card).
   `prefers-reduced-motion` opens settled.
   THE LANDING IS MEASURED, NOT GUESSED. Each badge slot is in the row from the start (invisible), so at the
   moment of landing the card reads the slot's rectangle and translates itself there -- the same FLIP the
   money machines use. No layout thrash: rows do not move during the ceremony.
   CONFETTI IS A CANVAS, not a library: a hundred and fifty rectangles with gravity, gone in two seconds.
   `onCelebrate` fires with each burst so the shell can play whatever audio it is given later. */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { FONT_SIZE, RADIUS } from "../styles/typography";
import { bestContrastTextColor, corporationLiveryColor } from "../styles/corporationLivery";
import { CorporateLogo } from "./CorporateLogo";
import type { GameHistory } from "../utils/gameHistory";
import type { Accolade } from "../utils/accolades";
import type { CeremonyCue } from "../utils/ceremonySounds";
import { AccoladeGlyph } from "./accoladeGlyphs";

export interface AccoladesCeremonyProps {
  history: GameHistory;
  playerLabel: (address: string) => string;
  playerColor: (address: string) => string;
  /** Whether to run the animation on mount. The settled page is what it ends on either way. */
  animate?: boolean;
  /** #1419: fired at each moment of the ceremony -- the title, a card appearing, a card landing, the sweep,
   *  the finale -- so the shell can play the sound for it (`ceremonySoundFor`). */
  onCue?: (cue: CeremonyCue) => void;
  /** #1423: the sounds are loaded. Until true the ceremony sits on its title without starting the clock, so a
   *  cold cache cannot put the first cards ahead of their sounds. The caller caps the wait. */
  ready?: boolean;
}

type Step =
  | { kind: "title" }
  | { kind: "present"; key: Accolade["key"] }
  | { kind: "land"; key: Accolade["key"] }
  | { kind: "sweep" }
  | { kind: "done" };

/** Durations, in ms. The hold is the reading time for a card. The title's is the drumroll's length (#1419),
 *  so the roll runs out as the first card appears. */
export const CEREMONY_TIMING = {
  title: 2200,
  present: 2600, // #1420: "stay up a little longer for people to read them" -- +0.7s
  land: 520,
  sweep: 900,
  playerStagger: 140,
} as const;

/** The script, from the ceremony's order: every corporate accolade presented and landed, the sweep, then
 *  every player accolade. Exported so the order is testable without a renderer. */
export function ceremonyScript(ceremony: readonly Accolade[]): Step[] {
  const corporate = ceremony.filter((a) => a.scope === "corporation");
  const player = ceremony.filter((a) => a.scope === "player");
  const steps: Step[] = [{ kind: "title" }];
  for (const a of corporate) steps.push({ kind: "present", key: a.key }, { kind: "land", key: a.key });
  steps.push({ kind: "sweep" });
  for (const a of player) steps.push({ kind: "present", key: a.key }, { kind: "land", key: a.key });
  steps.push({ kind: "done" });
  return steps;
}

const reducedMotion = () =>
  typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function AccoladesCeremony({ history, playerLabel, playerColor, animate = true, onCue, ready = true }: AccoladesCeremonyProps) {
  const ceremony = history.ceremony;
  const script = useMemo(() => ceremonyScript(ceremony), [ceremony]);
  const byKey = useMemo(() => new Map(ceremony.map((a) => [a.key, a])), [ceremony]);

  /* The rows: corporations in the order they first earn something; every player, in seat order. */
  const corporations = useMemo(() => {
    const seen = new Map<number, { companyId: number; ticker: string; accolades: Accolade[] }>();
    for (const a of ceremony) {
      if (a.scope !== "corporation" || a.companyId === null) continue;
      const row = seen.get(a.companyId) ?? { companyId: a.companyId, ticker: a.ticker ?? `#${a.companyId}`, accolades: [] };
      row.accolades.push(a);
      seen.set(a.companyId, row);
    }
    return Array.from(seen.values());
  }, [ceremony]);
  const players = useMemo(
    () =>
      history.players.map((address) => ({
        address,
        accolades: ceremony.filter((a) => a.scope === "player" && a.holder === address),
      })),
    [ceremony, history.players],
  );

  const shouldAnimate = animate && !reducedMotion() && script.length > 2;
  const [at, setAt] = useState(shouldAnimate ? 0 : script.length - 1);
  const [runId, setRunId] = useState(0);
  const step = script[Math.min(at, script.length - 1)];
  const done = step.kind === "done";

  /* What is visible at this step: rows claimed, badges landed, the sweep begun. */
  const landed = useMemo(() => {
    const set = new Set<Accolade["key"]>();
    for (let i = 0; i < Math.min(at, script.length); i += 1) {
      const s = script[i];
      if (s.kind === "land") set.add(s.key);
    }
    return set;
  }, [at, script]);
  const landing = step.kind === "land" ? step.key : null;
  const presenting = step.kind === "present" || step.kind === "land" ? byKey.get(step.key) ?? null : null;
  const sweepAt = script.findIndex((s) => s.kind === "sweep");
  const swept = at >= sweepAt;
  const corporationClaimed = (companyId: number) =>
    corporations.find((c) => c.companyId === companyId)?.accolades.some((a) => landed.has(a.key) || (landing === a.key)) ?? false;

  /* The timers. One per step; a click advances early. */
  const advance = useCallback(() => setAt((current) => Math.min(current + 1, script.length - 1)), [script.length]);
  useEffect(() => {
    if (done || !ready) return undefined;
    const ms =
      step.kind === "title" ? CEREMONY_TIMING.title
      : step.kind === "present" ? CEREMONY_TIMING.present
      : step.kind === "land" ? CEREMONY_TIMING.land
      : CEREMONY_TIMING.sweep + CEREMONY_TIMING.playerStagger * players.length;
    const timer = window.setTimeout(advance, ms);
    return () => window.clearTimeout(timer);
  }, [at, step, done, advance, players.length, ready]);

  /* Confetti: on the title, and on the finale (the last presented accolade -- the Robber Baron). The cues
     for the sounds fire from the same place, one per step, with the ordinal of the card within its half so
     the player-side sounds can alternate (#1419). */
  const [bursts, setBursts] = useState(0);
  const lastPresent = useMemo(() => {
    for (let i = script.length - 1; i >= 0; i -= 1) if (script[i].kind === "present") return i;
    return -1;
  }, [script]);
  useEffect(() => {
    if (!shouldAnimate || done || !ready) return;
    const isFinale = step.kind === "present" && at === lastPresent;
    if (step.kind === "title" || isFinale) setBursts((n) => n + 1);
    if (!onCue) return;
    if (step.kind === "title") onCue({ kind: "title" });
    else if (step.kind === "sweep") onCue({ kind: "sweep" });
    else if (step.kind === "present" || step.kind === "land") {
      const accolade = byKey.get(step.key);
      if (!accolade) return;
      const ordinal = ceremony.filter((a) => a.scope === accolade.scope).findIndex((a) => a.key === accolade.key);
      if (isFinale) onCue({ kind: "finale", accolade });
      else onCue({ kind: step.kind, accolade, ordinal });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fires per step (and once the sounds are ready), not per callback identity
  }, [at, ready]);

  /* The landing: measure the badge slot and send the card there. */
  const slotRefs = useRef(new Map<string, HTMLElement>());
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [landTransform, setLandTransform] = useState<string | null>(null);
  useEffect(() => {
    if (step.kind !== "land") {
      setLandTransform(null);
      return;
    }
    const slot = slotRefs.current.get(step.key);
    const card = cardRef.current;
    if (!slot || !card) return;
    const from = card.getBoundingClientRect();
    const to = slot.getBoundingClientRect();
    const dx = to.left + to.width / 2 - (from.left + from.width / 2);
    const dy = to.top + to.height / 2 - (from.top + from.height / 2);
    const scale = Math.max(0.12, Math.min(to.height / from.height, 0.3));
    // Two frames: the card is at rest, then it goes.
    requestAnimationFrame(() => requestAnimationFrame(() => setLandTransform(`translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(${scale})`)));
  }, [step]);

  const replay = () => {
    setAt(0);
    setRunId((n) => n + 1);
  };
  const skip = () => setAt(script.length - 1);

  const badge = (a: Accolade, visible: boolean) => (
    <span
      key={a.key}
      ref={(node) => {
        if (node) slotRefs.current.set(a.key, node);
        else slotRefs.current.delete(a.key);
      }}
      style={{ ...styles.badge, opacity: visible ? 1 : 0, transform: visible ? "scale(1)" : "scale(0.6)" }}
      title={`${a.title} — ${a.detail}. ${a.blurb}`}
      data-testid={`badge-${a.key}`}
    >
      <span style={styles.badgeGlyph} aria-hidden="true"><AccoladeGlyph accoladeKey={a.key} size={18} /></span>
      <span style={styles.badgeText}>
        <span style={styles.badgeTitle}>{a.title}</span>
        <span style={styles.badgeDetail}>{a.detail}</span>
      </span>
    </span>
  );

  return (
    /* RULED: no click-to-advance -- "players can click on accident and then wonder what they missed." The
       only controls are the two buttons: Skip while it runs, Replay once it has settled. */
    <div style={styles.root} data-testid="accolades-ceremony" data-step={step.kind}>
      <Confetti bursts={bursts} />
      <style>{CEREMONY_CSS}</style>

      <div style={styles.header}>
        <h2 style={{ ...styles.title, opacity: at >= 0 ? 1 : 0 }}>Accolades</h2>
        <span style={styles.headerButtons}>
          {!done && (
            <button type="button" style={styles.quietButton} onClick={skip} data-testid="ceremony-skip">
              Skip
            </button>
          )}
          {done && shouldAnimate && (
            <button type="button" style={styles.quietButton} onClick={replay} data-testid="ceremony-replay">
              Replay
            </button>
          )}
        </span>
      </div>

      {/* ---- Corporations ---- */}
      <div style={styles.rows}>
        {corporations.map((row) => {
          const livery = corporationLiveryColor(row.companyId);
          const ink = bestContrastTextColor(livery);
          const claimed = corporationClaimed(row.companyId);
          return (
            <div
              key={`${runId}-${row.companyId}`}
              className="ceremony-row"
              style={{
                ...styles.row,
                background: `linear-gradient(90deg, ${livery} 0%, ${livery} 12%, transparent 28%)`,
                opacity: claimed ? 1 : 0,
              }}
              data-testid={`ceremony-corp-${row.ticker}`}
            >
              <span style={{ ...styles.rowIdentity, color: ink }}>
                <CorporateLogo ticker={row.ticker} size={26} color={ink} title={row.ticker} fallbackStyle={styles.heraldFallback} />
                <span style={styles.rowName}>{row.ticker}</span>
              </span>
              <span style={styles.badges}>{row.accolades.map((a) => badge(a, landed.has(a.key)))}</span>
            </div>
          );
        })}
      </div>

      <div style={styles.divider} />

      {/* ---- Players: swept in, staggered ---- */}
      <div style={styles.rows}>
        {players.map((row, index) => {
          const color = playerColor(row.address);
          const ink = bestContrastTextColor(color);
          return (
            <div
              key={`${runId}-${row.address}`}
              className={swept ? "ceremony-row ceremony-row-swept" : "ceremony-row"}
              style={{
                ...styles.row,
                background: `linear-gradient(90deg, ${color} 0%, ${color} 12%, transparent 28%)`,
                opacity: swept ? 1 : 0,
                transform: swept ? "translateX(0)" : "translateX(-40%)",
                transitionDelay: `${index * CEREMONY_TIMING.playerStagger}ms`,
              }}
              data-testid={`ceremony-player-${row.address}`}
            >
              <span style={{ ...styles.rowIdentity, color: ink }}>
                <span style={styles.rowName}>{playerLabel(row.address)}</span>
              </span>
              <span style={styles.badges}>{row.accolades.map((a) => badge(a, landed.has(a.key)))}</span>
            </div>
          );
        })}
      </div>

      {/* ---- The presenting card ---- */}
      {presenting && (
        <div
          ref={cardRef}
          className="ceremony-card"
          style={{
            ...styles.card,
            transform: landTransform ?? "translate(-50%, -50%) scale(1)",
            opacity: landTransform ? 0.15 : 1,
            transition: landTransform ? `transform ${CEREMONY_TIMING.land}ms cubic-bezier(.4,0,.2,1), opacity ${CEREMONY_TIMING.land}ms ease-in` : undefined,
          }}
          data-testid="ceremony-card"
        >
          <span style={styles.cardGlyph} aria-hidden="true"><AccoladeGlyph accoladeKey={presenting.key} size={52} /></span>
          <span style={styles.cardTitle}>{presenting.title}</span>
          <span style={styles.cardBlurb}>{presenting.blurb}</span>
          <span style={styles.cardHolder}>
            {presenting.scope === "corporation" && presenting.ticker ? `${presenting.ticker} · ` : ""}
            {presenting.holder ? playerLabel(presenting.holder) : ""}
          </span>
          <span style={styles.cardDetail}>{presenting.detail}</span>
        </div>
      )}
    </div>
  );
}

export default AccoladesCeremony;

/* ---- Confetti ---- a burst per increment of `bursts`. */
function Confetti({ bursts }: { bursts: number }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    if (bursts === 0) return undefined;
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const context = canvas.getContext("2d");
    if (!context) return undefined;
    const width = (canvas.width = canvas.clientWidth);
    const height = (canvas.height = canvas.clientHeight);
    const colours = ["#c9a227", "#e05a7a", "#4fa3e0", "#7ee0a1", "#f2f0eb", "#e0b062"];
    const pieces = Array.from({ length: 150 }, () => ({
      x: width / 2 + (Math.random() - 0.5) * 80,
      y: height * 0.4,
      vx: (Math.random() - 0.5) * 14,
      vy: -Math.random() * 12 - 4,
      w: 6 + Math.random() * 6,
      h: 3 + Math.random() * 4,
      a: Math.random() * Math.PI,
      va: (Math.random() - 0.5) * 0.3,
      c: colours[Math.floor(Math.random() * colours.length)],
    }));
    let frame = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const t = now - start;
      context.clearRect(0, 0, width, height);
      for (const p of pieces) {
        p.vy += 0.35;
        p.x += p.vx;
        p.y += p.vy;
        p.vx *= 0.99;
        p.a += p.va;
        context.save();
        context.translate(p.x, p.y);
        context.rotate(p.a);
        context.globalAlpha = Math.max(0, 1 - t / 2200);
        context.fillStyle = p.c;
        context.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        context.restore();
      }
      if (t < 2200) frame = requestAnimationFrame(tick);
      else context.clearRect(0, 0, width, height);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [bursts]);
  return <canvas ref={canvasRef} style={styles.confetti} aria-hidden="true" />;
}

const CEREMONY_CSS = `
.ceremony-row { transition: opacity 420ms ease, transform 420ms cubic-bezier(.2,.8,.2,1); }
.ceremony-card { animation: ceremony-card-in 320ms cubic-bezier(.2,.8,.2,1); }
@keyframes ceremony-card-in { from { opacity: 0; transform: translate(-50%, -50%) scale(0.6); } to { opacity: 1; transform: translate(-50%, -50%) scale(1); } }
@media (prefers-reduced-motion: reduce) { .ceremony-row, .ceremony-card { transition: none; animation: none; } }
`;

const styles: Record<string, React.CSSProperties> = {
  root: { position: "relative", display: "flex", flexDirection: "column", gap: "12px", flex: 1, minHeight: 0 },
  confetti: { position: "fixed", inset: 0, width: "100%", height: "100%", pointerEvents: "none", zIndex: 3 },
  header: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px" },
  title: { margin: 0, fontSize: "28px", fontWeight: 800, color: "#f0e2b8", letterSpacing: "0.04em", transition: "opacity 400ms ease" },
  headerButtons: { display: "flex", gap: "8px" },
  quietButton: {
    padding: "6px 12px",
    borderRadius: RADIUS.card,
    border: "1px solid #3a3a3a",
    backgroundColor: "transparent",
    color: "#c8c6c0",
    fontSize: FONT_SIZE.small,
    cursor: "pointer",
  },
  rows: { display: "flex", flexDirection: "column", gap: "8px" },
  divider: { height: "1px", backgroundColor: "#2a2a2a", margin: "4px 0" },
  row: {
    display: "flex",
    alignItems: "center",
    gap: "14px",
    minHeight: "56px",
    padding: "6px 14px",
    borderRadius: RADIUS.card,
    border: "1px solid #2a2a2a",
  },
  rowIdentity: { display: "flex", alignItems: "center", gap: "10px", width: "18%", minWidth: "140px", flexShrink: 0 },
  rowName: { fontSize: FONT_SIZE.strong, fontWeight: 800, letterSpacing: "0.02em", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
  heraldFallback: { fontSize: FONT_SIZE.micro, fontWeight: 800 },
  badges: { display: "flex", flexWrap: "wrap", gap: "8px", flex: 1, minWidth: 0 },
  badge: {
    display: "inline-flex",
    alignItems: "center",
    gap: "8px",
    padding: "5px 10px 5px 6px",
    borderRadius: RADIUS.pill,
    border: "1px solid #5a4a1e",
    backgroundColor: "#1a1710",
    transition: "opacity 300ms ease, transform 300ms ease",
  },
  badgeGlyph: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "30px",
    height: "30px",
    borderRadius: RADIUS.circle,
    backgroundColor: "#2a2410",
    border: "1px solid #c9a227",
    fontSize: "16px",
    lineHeight: 1,
  },
  badgeText: { display: "flex", flexDirection: "column", minWidth: 0 },
  badgeTitle: { fontSize: FONT_SIZE.micro, fontWeight: 800, letterSpacing: "0.08em", textTransform: "uppercase", color: "#c9a94c", whiteSpace: "nowrap" },
  badgeDetail: { fontSize: FONT_SIZE.micro, color: "#a8a6a0", whiteSpace: "nowrap" },
  card: {
    position: "fixed",
    left: "50%",
    top: "45%",
    zIndex: 4,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "8px",
    width: "min(460px, 90vw)",
    padding: "26px 28px",
    borderRadius: RADIUS.layer,
    border: "1px solid #c9a227",
    backgroundColor: "#141208",
    boxShadow: "0 22px 60px rgba(0,0,0,0.7), 0 0 0 6px rgba(201,162,39,0.12)",
    textAlign: "center",
    pointerEvents: "none",
    transformOrigin: "center",
  },
  cardGlyph: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "84px",
    height: "84px",
    borderRadius: RADIUS.circle,
    backgroundColor: "#2a2410",
    border: "2px solid #c9a227",
    fontSize: "44px",
    lineHeight: 1,
  },
  cardTitle: { fontSize: "26px", fontWeight: 800, color: "#f0e2b8", letterSpacing: "0.04em" },
  cardBlurb: { fontSize: FONT_SIZE.body, color: "#c8c6c0", lineHeight: 1.45 },
  cardHolder: { fontSize: FONT_SIZE.strong, fontWeight: 800, color: "#f2f0eb", marginTop: "4px" },
  cardDetail: { fontSize: FONT_SIZE.small, color: "#8a8a86" },
};
