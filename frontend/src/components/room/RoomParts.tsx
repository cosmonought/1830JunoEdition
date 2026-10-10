// frontend/src/components/room/RoomParts.tsx
//
// PLAY HOST A GAME + WAITING ROOM (approved design, "play-host-waiting-handoff"): the parts the two screens share --
// the title lockup drawn in type (§2), "How the clock works" (§9.3), a boarding pass on rag paper with its stub, stamps
// and tear (§6), an open seat (§8), the player panel (§8) and the Ludum footer (§4). Presentation only: every fact
// arrives as a prop, and every action is the caller's.

import React, { useCallback, useEffect, useLayoutEffect, useRef } from "react";

import type { GameType } from "../../gameEngine/gameVariants";
import { EDITION_COLOR, historyLines, type PublicGameHistory } from "../../utils/lobbyBoard";
import { clockRules, cutsFor, paperOffset, passSeed, type PaceChoice } from "../../utils/roomDesign";
import AppFooter from "../AppFooter";
import { SeatTrustFacts, TRUST_FACTS_DISCLAIMER } from "../TrustFacts";

/* ------------------------------------------------------------------ the lockup */

/** The edition's colour token (the sign's stripe, the card names, the preview row). */
export const EDITION_TOKEN: Readonly<Record<GameType, string>> = { standard: "var(--rm-e-18xx)", plus: "var(--rm-e-plus)", levelPlayingField: "var(--rm-e-lpf)" };
export { EDITION_COLOR };

/** "18XX" with the raised plus of 18XX+, as the lockup and the edition names set it. */
export function EditionNumerals({ type }: { type: GameType }): JSX.Element {
  return type === "standard" ? (
    <>18XX</>
  ) : (
    <>
      18XX<span className="rm-plus">+</span>
    </>
  );
}

/** PROJECT over 18XX in gilt, and under the Level Playing Field its subtitle, sized to the numerals' width (§2). */
export function Lockup({ type, as = "span", id, className }: { type: GameType; as?: "span" | "h1" | "h2"; id?: string; className?: string }): JSX.Element {
  const root = useRef<HTMLElement | null>(null);
  const fit = useCallback(() => {
    const el = root.current;
    if (el === null) return;
    const sub = el.querySelector<HTMLElement>(".rm-sub");
    const num = el.querySelector<HTMLElement>(".rm-num");
    if (sub === null || num === null) return;
    const width = num.getBoundingClientRect().width;
    if (!(width > 0)) return;
    let lo = 3;
    let hi = 40;
    for (let i = 0; i < 16; i += 1) {
      const mid = (lo + hi) / 2;
      sub.style.fontSize = `${mid}px`;
      if (sub.getBoundingClientRect().width > width) hi = mid;
      else lo = mid;
    }
    sub.style.fontSize = `${lo}px`;
  }, []);
  useLayoutEffect(() => {
    if (type !== "levelPlayingField") return undefined;
    fit();
    const el = root.current;
    let observer: ResizeObserver | null = null;
    if (el !== null && typeof ResizeObserver === "function") {
      observer = new ResizeObserver(() => fit());
      const num = el.querySelector(".rm-num");
      if (num !== null) observer.observe(num);
    }
    const fonts = typeof document !== "undefined" ? (document as Document & { fonts?: { ready?: Promise<unknown> } }).fonts : undefined;
    void fonts?.ready?.then(() => fit());
    return () => observer?.disconnect();
  }, [type, fit]);
  const Tag = as;
  return (
    <Tag ref={root as React.Ref<HTMLHeadingElement & HTMLSpanElement>} className={`rm-lockup${className ? ` ${className}` : ""}`} id={id}>
      <span className="rm-name">Project</span>
      <span className="rm-num">
        <EditionNumerals type={type} />
      </span>
      {type === "levelPlayingField" ? <span className="rm-sub">A Level Playing Field</span> : null}
    </Tag>
  );
}

/* ------------------------------------------------------------------ how the clock works */

export function ClockRules({ pace, feeBps, open, onToggle, testId }: { pace: PaceChoice; feeBps: number | null | undefined; open: boolean; onToggle: (open: boolean) => void; testId?: string }): JSX.Element {
  return (
    <details className="rm-more" open={open} onToggle={(event) => onToggle((event.currentTarget as HTMLDetailsElement).open)} data-testid={testId}>
      <summary>How the clock works</summary>
      <ul className="rm-clockrules">
        {clockRules(pace, feeBps).map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </details>
  );
}

/* ------------------------------------------------------------------ the boarding pass */

export interface PassLook {
  readonly style: React.CSSProperties;
  readonly cutMain: string;
  readonly cutStub: string;
}

/** A pass's look: its seat colour and its own patch of the paper, and its tear (both seeded by the seat). */
export function passLook(seedText: string, color: string): React.CSSProperties {
  const seed = passSeed(seedText);
  const { x, y } = paperOffset(seed);
  const { main, stub } = cutsFor(seed);
  return { ["--c" as string]: color, ["--bx" as string]: `${x}px`, ["--by" as string]: `${y}px`, ["--cut-main" as string]: main, ["--cut-stub" as string]: stub } as React.CSSProperties;
}

export interface BoardingPassProps {
  readonly big?: boolean;
  readonly name: string;
  readonly seat: number;
  /** What seeds the paper and the tear (the seat's player id and seat number). */
  readonly seedText: string;
  readonly color: string;
  readonly host: boolean;
  readonly you: boolean;
  readonly away: boolean;
  /** The words under the name: the state on the Boarding board, the table's terms on your own pass. */
  readonly meta: string;
  /** The stub's ante (null on a table without one). */
  readonly ante: string | null;
  readonly torn: boolean;
  /** The tear is happening now (the moment of funding): the stub swings away and the stamp lands after it. */
  readonly tearing: boolean;
  readonly stamp: "sent" | "boarded" | null;
  readonly hideStamp?: boolean;
  readonly onName: (anchor: HTMLButtonElement) => void;
  readonly panelOpen: boolean;
  readonly testId?: string;
  /** Under the name: your colour (your pass), or the host's Remove (the Boarding board). */
  readonly children?: React.ReactNode;
  /** Your pass only (§6): the right half -- everything you do before departure. */
  readonly actions?: React.ReactNode;
}

const two = (n: number): string => String(n).padStart(2, "0");

export function BoardingPass(props: BoardingPassProps): JSX.Element {
  const { big = false } = props;
  const className = ["rm-pass", big ? "rm-big" : "", props.you ? "rm-you" : "", props.torn ? "rm-torn" : "", props.tearing ? "rm-tearing" : ""].filter(Boolean).join(" ");
  const Tag = big ? "div" : "li";
  return (
    <Tag className={className} style={passLook(props.seedText, props.color)} data-testid={props.testId} data-torn={props.torn ? "1" : undefined}>
      <div className="rm-p-main">
        <div className={big ? "rm-p-id" : "rm-p-flat"}>
        <span className="rm-p-kick">{big ? "Your boarding pass" : "Boarding pass"}</span>
        <div className="rm-p-who">
          <button type="button" className="rm-pname" aria-haspopup="dialog" aria-expanded={props.panelOpen} onClick={(event) => props.onName(event.currentTarget)} title={`${props.name}: game history`}>
            {props.name}
          </button>
          {props.host ? <span className="rm-tag">Host</span> : null}
          {props.you ? <span className="rm-tag rm-tag-you">You</span> : null}
          {props.away && !props.you ? (
            <span className="rm-tag rm-tag-away" title="This player has no table open right now.">
              Away
            </span>
          ) : null}
        </div>
        <span className="rm-p-meta">{props.meta}</span>
        {props.children}
        </div>
        {props.actions}
      </div>
      <div className="rm-p-stub">
        <span className="rm-lab">Seat</span>
        <b className="rm-seatnum">{two(props.seat)}</b>
        {props.ante !== null ? (
          <>
            <span className="rm-lab">Ante</span>
            <span className="rm-stub-amt">{props.ante}</span>
          </>
        ) : null}
      </div>
      {props.stamp !== null && !props.hideStamp ? (
        <span className={`rm-stamp${props.stamp === "sent" ? " rm-sent" : ""}${props.stamp === "boarded" && props.tearing ? " rm-new" : ""}`} aria-hidden="true">
          {props.stamp === "sent" ? "Sent" : "Boarded"}
        </span>
      ) : null}
    </Tag>
  );
}

/** An open seat: no ticket yet -- a dashed outline on the board (§8). */
export function OpenSeat({ seat, exact, ante }: { seat: number; exact: boolean; ante: string | null }): JSX.Element {
  return (
    <li className="rm-pass rm-open" data-testid={`open-seat-${seat}`}>
      <div className="rm-p-main">
        <span className="rm-p-kick">Boarding pass</span>
        <span className="rm-openlab" style={{ marginTop: "6px" }}>
          {exact ? "Open seat" : "Open seat · optional"}
        </span>
      </div>
      <div className="rm-p-stub" aria-hidden="true">
        <span className="rm-lab">Seat</span>
        <b className="rm-seatnum">{two(seat)}</b>
        {ante !== null ? (
          <>
            <span className="rm-lab">Ante</span>
            <span className="rm-stub-amt">{ante}</span>
          </>
        ) : null}
      </div>
    </li>
  );
}

/* ------------------------------------------------------------------ the player panel */

export type PanelHistory = { readonly state: "loading" } | { readonly state: "ok"; readonly history: PublicGameHistory | null } | { readonly state: "private" } | { readonly state: "error" };

export interface PlayerPanelProps {
  readonly name: string;
  readonly seat: number;
  readonly host: boolean;
  readonly playerId: string;
  readonly gameId: string;
  readonly history: PanelHistory;
  /** A seated viewer also sees the tablemate facts. */
  readonly seatedViewer: boolean;
  readonly anchor: HTMLElement | null;
  readonly onClose: () => void;
}

function HistoryFacts({ history }: { history: PanelHistory }): JSX.Element {
  if (history.state === "loading") return <p className="rm-pop-note">Reading the public game history…</p>;
  if (history.state === "private") return <p className="rm-pop-note">A private table isn't on Departures, so its players' public game history isn't shown here.</p>;
  if (history.state === "error" || history.history === null) return <p className="rm-pop-note">The public game history can't be read right now.</p>;
  const lines = historyLines(history.history);
  if (lines.none) {
    return (
      <dl className="rm-facts">
        <dt>Public game history</dt>
        <dd>No completed games yet.</dd>
      </dl>
    );
  }
  return (
    <dl className="rm-facts" data-testid="room-panel-history">
      <dt>Public game history</dt>
      <dd>{lines.summary}</dd>
      <dd>{lines.wins}</dd>
      <dt>Standings</dt>
      <dd className="rm-fin">
        {lines.standings.map((s) => (
          <span key={s}>{s}</span>
        ))}
      </dd>
      {lines.partial !== null ? <dd>{lines.partial}</dd> : null}
      {lines.recent.length > 0 ? <dt>Recent results</dt> : null}
      {lines.recent.map((r, i) => (
        <dd key={i} className="rm-res">
          <span>{r.day}</span>
          <span>{r.edition}</span>
          <b>{r.result}</b>
        </dd>
      ))}
    </dl>
  );
}

/** The lobby's player panel, for one seat: a labelled, non-modal dialog by the name (a bottom sheet on phones), closed
 *  by Escape, by its ×, or by pressing anywhere outside it; focus goes to it on open and back to the name on close. */
export function PlayerPanel(props: PlayerPanelProps): JSX.Element {
  const el = useRef<HTMLDivElement | null>(null);
  const { anchor, onClose } = props;
  const place = useCallback(() => {
    const pop = el.current;
    if (pop === null || anchor === null || !document.contains(anchor)) return;
    if (typeof window.matchMedia === "function" && window.matchMedia("(max-width: 760px)").matches) {
      pop.style.left = "";
      pop.style.top = "";
      return;
    }
    const r = anchor.getBoundingClientRect();
    pop.style.left = `${Math.max(16, Math.min(window.innerWidth - pop.offsetWidth - 16, r.left))}px`;
    const h = pop.offsetHeight;
    const below = r.bottom + 8;
    const above = r.top - 8 - h;
    pop.style.top = `${below + h <= window.innerHeight - 16 ? below : above >= 16 ? above : Math.max(16, window.innerHeight - h - 16)}px`;
  }, [anchor]);
  useLayoutEffect(() => {
    place();
  });
  useEffect(() => {
    el.current?.querySelector<HTMLButtonElement>("h3 button")?.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      onClose();
      anchor?.focus({ preventScroll: true });
    };
    const onDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target === null || el.current?.contains(target) || anchor?.contains(target)) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [anchor, onClose, place]);
  return (
    <div ref={el} className="rm-pop" role="dialog" aria-labelledby="rm-pop-h" data-testid="room-player-panel">
      <h3 id="rm-pop-h">
        <span>{props.name}</span>
        <small>
          Seat {two(props.seat)}
          {props.host ? " · host" : ""}
        </small>
        <button
          type="button"
          aria-label="Close"
          onClick={() => {
            onClose();
            anchor?.focus({ preventScroll: true });
          }}
        >
          ×
        </button>
      </h3>
      <HistoryFacts history={props.history} />
      {props.seatedViewer ? (
        <>
          <p className="rm-pop-sub">At this table · players only</p>
          <div className="rm-facts">
            <SeatTrustFacts gameId={props.gameId} playerId={props.playerId} />
          </div>
          <p>{TRUST_FACTS_DISCLAIMER}</p>
        </>
      ) : (
        <p>Completed games, results and standings from this server's records. Not a rating.</p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ the footer (the lobby's) */

export function RoomFooter(): JSX.Element {
  /* The Ludum link and a hairline, then Play's own Neta DAO credit UNCHANGED (`AppFooter` "meta": the animated mark).
     A <div>: the credit is the <footer> landmark. */
  return (
    <div className="rm-foot" data-testid="room-footer">
      <a href="https://ludum.netadao.org/projects/project-18xx/" target="_blank" rel="noopener noreferrer">
        <b className="rm-lw">LUDUM</b>
        <span>Project 18XX on Ludum ↗</span>
      </a>
      <i className="rm-sep" aria-hidden="true" />
      <AppFooter surface="meta" />
    </div>
  );
}
