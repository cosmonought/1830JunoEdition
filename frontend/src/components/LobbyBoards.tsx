// frontend/src/components/LobbyBoards.tsx
//
// ==================================================================
//  PLAY LOBBY (approved design, "play-lobby-handoff"): DEPARTURES AND UNDER WAY
// ==================================================================
//
// The public tables as two boards (design §4): Departures -- tables taking seats, oldest first, new tables joining the
// bottom -- and Under way -- games in progress, by start time, foldable. Edition and mode filters apply to both. A row
// never moves because its contents changed: it flashes its edition colour. A table that starts flaps to UNDER WAY,
// holds 1.9 s, folds away and joins the bottom of Under way. Reduced motion: no flaps, flashes or folds.
//
// The seats button opens the seated list (§5): each seated player's public (account) name, the host, each seat's ante
// funding where the table has an ante, open seats, and each player's public game history on a tap -- read from
// `POST /gs/api/lobby/players`, which answers only the approved facts (`server/src/rooms/publicHistory.ts`).
//
// THE DATA IS PLAY'S OWN: the server's `rooms-watch` list (`usePublicRooms`), pushed on every change. The RULES ARE
// PLAY'S OWN: Join only where `canJoin` says (#1441; PHASE 3 FINAL §13 -- a no-ante table is watched, never sat at, on a
// production build), Watch always; both go through the Lobby's existing handlers (account first, refusal on the row).

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { RoomSummary } from "../utils/roomProtocol";
import { sessionPort } from "../utils/sessionBootstrap";
import {
  EDITION_COLOR,
  EDITION_NAME,
  EDITIONS,
  STATUS_WORD,
  anteOf,
  anteTimes,
  boardRowOf,
  boardTime,
  canJoin,
  clockText,
  departuresOrder,
  diffSnapshots,
  historyLines,
  publicPlayersOf,
  shown,
  statusOf,
  underWayOrder,
  type BoardRow,
  type EditionFilter,
  type ModeFilter,
  type PublicSeatHistory,
} from "../utils/lobbyBoard";
import { SplitFlap, prefersReducedMotion } from "./SplitFlap";

export const DEPART_HOLD_MS = 1_900;
export const DEPART_FOLD_MS = 470;

export interface LobbyBoardsProps {
  rooms: readonly RoomSummary[];
  loading: boolean;
  error: string | null;
  available: boolean;
  busy: boolean;
  refusal: { code: string; reason: string } | null;
  onJoin: (code: string) => void;
  onWatch: (gameId: string) => void;
  /** PHASE 3 FINAL (§13): whether a no-ante table offers a seat (`utils/tablePolicy.ts`). */
  noAnteSeats?: boolean;
  /** Tests: the players reader (the session port's `lobby/players` by default). */
  readPlayers?: (gameId: string) => Promise<PublicSeatHistory[] | null>;
}

async function defaultReadPlayers(gameId: string): Promise<PublicSeatHistory[] | null> {
  const answer = await sessionPort().api("lobby/players", { gameId });
  if (answer.kind !== "answered" || answer.status !== 200) return null;
  return publicPlayersOf(answer.body);
}

/** "18XX+" with the + raised, as the design sets it. */
function EditionName({ name }: { name: string }) {
  const parts = name.split("+");
  return (
    <span className="lb-nm">
      {parts.map((part, i) => (
        <React.Fragment key={i}>
          {part}
          {i < parts.length - 1 && <span className="lb-plus">+</span>}
        </React.Fragment>
      ))}
    </span>
  );
}

function BoardClock() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, []);
  return (
    <span className="lb-clock" role="timer" aria-label="Time now, UTC" data-testid="lobby-clock">
      {clockText(now)}
    </span>
  );
}

function Segments<T extends string>({ label, value, options, onChange, testPrefix }: { label: string; value: T; options: Array<{ v: T; text: string; color?: string }>; onChange: (v: T) => void; testPrefix: string }) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  return (
    <div className="lb-seg" role="radiogroup" aria-label={label}>
      {options.map((option, i) => (
        <button
          key={option.v}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="radio"
          aria-checked={value === option.v}
          tabIndex={value === option.v ? 0 : -1}
          style={option.color ? ({ "--ed": option.color } as React.CSSProperties) : undefined}
          onClick={() => onChange(option.v)}
          onKeyDown={(event) => {
            const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
            if (step === 0) return;
            event.preventDefault();
            const next = (i + step + options.length) % options.length;
            onChange(options[next].v);
            refs.current[next]?.focus();
          }}
          data-testid={`${testPrefix}-${option.v}`}
        >
          {option.color && <i aria-hidden="true" />}
          {option.text}
        </button>
      ))}
    </div>
  );
}

function TableCell({ row }: { row: BoardRow }) {
  return (
    <span className="lb-tbl">
      <span className="lb-ed">
        <EditionName name={row.editionName} />
        <span className="lb-bank">({row.bank})</span>
      </span>
      <span className="lb-meta">
        <span>
          <em>Host</em>
          {row.host}
        </span>
        <span>
          <em>Mode</em>
          {row.modeLabel}
        </span>
      </span>
      {row.rules.length > 0 && (
        <span className="lb-meta">
          <span>
            <em>Variants</em>
            {row.rules.join(", ")}
          </span>
        </span>
      )}
    </span>
  );
}

function Pips({ row }: { row: BoardRow }) {
  return (
    <span className="lb-pips" aria-hidden="true">
      {Array.from({ length: Math.max(row.capacity, row.seated) }, (_, i) => (
        <i key={i} className={i < row.seated ? "lb-on" : undefined} />
      ))}
    </span>
  );
}

export function LobbyBoards({ rooms, loading, error, available, busy, refusal, onJoin, onWatch, noAnteSeats = true, readPlayers = defaultReadPlayers }: LobbyBoardsProps) {
  const [edition, setEdition] = useState<EditionFilter>("all");
  const [mode, setMode] = useState<ModeFilter>("all");
  const [underOpen, setUnderOpen] = useState(true);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const rows = useMemo(() => rooms.map(boardRowOf), [rooms]);

  /* ---- changes between snapshots: flashes and departures ---- */
  const rowEls = useRef(new Map<string, HTMLLIElement>());
  const previous = useRef<Map<string, BoardRow> | null>(null);
  const [departing, setDeparting] = useState<Map<string, { row: BoardRow; folding: boolean }>>(() => new Map());
  const pendingPings = useRef(new Set<string>());
  const timers = useRef<Array<ReturnType<typeof setTimeout>>>([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  const ping = useCallback((gameId: string) => {
    const el = rowEls.current.get(gameId);
    if (el === undefined || prefersReducedMotion()) return;
    el.classList.remove("lb-ping");
    void el.offsetWidth;
    el.classList.add("lb-ping");
  }, []);

  useEffect(() => {
    const before = previous.current;
    const { changed, departed } = diffSnapshots(before, rows);
    previous.current = new Map(rows.map((row) => [row.gameId, row]));
    const reduce = prefersReducedMotion();
    Array.from(changed).forEach((gameId) => ping(gameId));
    if (reduce || before === null || departed.size === 0) {
      Array.from(departed).forEach((gameId) => pendingPings.current.add(gameId));
      return;
    }
    setDeparting((current) => {
      const next = new Map(current);
      Array.from(departed).forEach((gameId) => next.set(gameId, { row: before.get(gameId) as BoardRow, folding: false }));
      return next;
    });
    Array.from(departed).forEach((gameId) => {
      timers.current.push(
        setTimeout(() => {
          setDeparting((current) => {
            const entry = current.get(gameId);
            if (entry === undefined) return current;
            const next = new Map(current);
            next.set(gameId, { ...entry, folding: true });
            return next;
          });
        }, DEPART_HOLD_MS),
        setTimeout(() => {
          pendingPings.current.add(gameId);
          setDeparting((current) => {
            if (!current.has(gameId)) return current;
            const next = new Map(current);
            next.delete(gameId);
            return next;
          });
        }, DEPART_HOLD_MS + DEPART_FOLD_MS),
      );
    });
  }, [rows, ping]);

  /* A folding row: height, padding and opacity to 0 over 450 ms (the design's departure). */
  useLayoutEffect(() => {
    Array.from(departing.entries()).forEach(([gameId, entry]) => {
      if (!entry.folding) return;
      const el = rowEls.current.get(`dep:${gameId}`);
      if (el === undefined || el.classList.contains("lb-leaving")) return;
      el.style.height = `${el.offsetHeight}px`;
      el.classList.add("lb-leaving");
      void el.offsetWidth;
      el.style.height = "0px";
      el.style.opacity = "0";
      el.style.paddingTop = "0px";
      el.style.paddingBottom = "0px";
    });
  }, [departing]);
  /* A departed table arriving at the bottom of Under way flashes there. */
  useLayoutEffect(() => {
    Array.from(pendingPings.current).forEach((gameId) => {
      if (departing.has(gameId)) return;
      pendingPings.current.delete(gameId);
      ping(gameId);
    });
  });

  /* ---- the two lists ---- */
  const waiting = useMemo(() => {
    const live = rows.filter((row) => row.status === "waiting" && !departing.has(row.gameId));
    const leaving = Array.from(departing.values()).map((entry) => entry.row);
    return departuresOrder([...live, ...leaving].filter((row) => shown(row, edition, mode)));
  }, [rows, departing, edition, mode]);
  const playing = useMemo(() => underWayOrder(rows.filter((row) => row.status === "playing" && !departing.has(row.gameId) && shown(row, edition, mode))), [rows, departing, edition, mode]);
  const waitingCount = rows.filter((row) => row.status === "waiting").length;
  const playingCount = rows.filter((row) => row.status === "playing").length;

  /* ---- the seated list ---- */
  const [pop, setPop] = useState<{ gameId: string; anchor: HTMLButtonElement } | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [histories, setHistories] = useState<Map<string, { state: "loading" | "ok" | "error"; players: PublicSeatHistory[]; at: number }>>(() => new Map());
  const popEl = useRef<HTMLDivElement | null>(null);

  const load = useCallback(
    (gameId: string, force = false) => {
      const known = histories.get(gameId);
      if (!force && known !== undefined && (known.state === "loading" || Date.now() - known.at < 60_000)) return;
      setHistories((current) => new Map(current).set(gameId, { state: "loading", players: known?.players ?? [], at: Date.now() }));
      void readPlayers(gameId).then(
        (players) => setHistories((current) => new Map(current).set(gameId, players === null ? { state: "error", players: [], at: Date.now() } : { state: "ok", players, at: Date.now() })),
        () => setHistories((current) => new Map(current).set(gameId, { state: "error", players: [], at: Date.now() })),
      );
    },
    [histories, readPlayers],
  );

  const close = useCallback((returnFocus = true) => {
    setPop((current) => {
      if (current !== null && returnFocus) current.anchor.focus({ preventScroll: true });
      return null;
    });
  }, []);
  const open = useCallback(
    (gameId: string, anchor: HTMLButtonElement) => {
      if (pop?.gameId === gameId) {
        close();
        return;
      }
      setPop({ gameId, anchor });
      load(gameId);
    },
    [pop, close, load],
  );
  const popRow = pop === null ? undefined : (departing.get(pop.gameId)?.row ?? rows.find((row) => row.gameId === pop.gameId));
  useEffect(() => {
    if (pop !== null && popRow === undefined) setPop(null);
  }, [pop, popRow]);
  /* A seat changed hands since the history was read: read it again. */
  const history = pop === null ? undefined : histories.get(pop.gameId);
  useEffect(() => {
    if (pop === null || popRow === undefined || history?.state !== "ok") return;
    const names = popRow.seats.map((seat) => seat.name).join("\u0000");
    if (names !== history.players.map((p) => p.name).join("\u0000")) load(pop.gameId, true);
  }, [pop, popRow, history, load]);

  const place = useCallback(() => {
    const el = popEl.current;
    if (el === null || pop === null) return;
    if (window.matchMedia?.("(max-width: 640px)").matches) {
      el.style.left = "";
      el.style.top = "";
      return;
    }
    const r = pop.anchor.getBoundingClientRect();
    el.style.left = `${Math.max(16, Math.min(window.innerWidth - el.offsetWidth - 16, r.left))}px`;
    const h = el.offsetHeight;
    const below = r.bottom + 8;
    const above = r.top - 8 - h;
    el.style.top = `${below + h <= window.innerHeight - 16 ? below : above >= 16 ? above : Math.max(16, window.innerHeight - h - 16)}px`;
  }, [pop]);
  useLayoutEffect(() => {
    place();
  });
  const opened = useRef<string | null>(null);
  useEffect(() => {
    if (pop === null) {
      opened.current = null;
      return;
    }
    if (opened.current !== pop.gameId) {
      opened.current = pop.gameId;
      popEl.current?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
    }
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    const down = (event: PointerEvent) => {
      const target = event.target as Node;
      if (popEl.current?.contains(target) || pop.anchor.contains(target)) return;
      close(false);
    };
    window.addEventListener("keydown", key);
    document.addEventListener("pointerdown", down);
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("keydown", key);
      document.removeEventListener("pointerdown", down);
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [pop, close, place]);

  if (!available) return null;

  const setRowEl = (key: string) => (el: HTMLLIElement | null) => {
    if (el === null) rowEls.current.delete(key);
    else rowEls.current.set(key, el);
  };
  const tableName = (row: BoardRow) => `${row.editionName}, hosted by ${row.host}`;
  const statusLine = error ? error : loading ? "Looking for public tables…" : null;

  return (
    <section aria-label="Public tables" data-testid="lobby-public-games">
      {/* ---------------- Departures ---------------- */}
      <section className="lb-board lb-dep" aria-labelledby="lb-dep-h">
        <div className="lb-head">
          <h2 id="lb-dep-h">
            Departures{" "}
            <span className="lb-count" data-testid="lobby-rooms-count">
              {waitingCount} {waitingCount === 1 ? "table" : "tables"}
            </span>
          </h2>
          <div className="lb-tools">
            <Segments
              label="Edition"
              value={edition}
              onChange={setEdition}
              testPrefix="lobby-edition"
              options={[{ v: "all" as EditionFilter, text: "All" }, ...EDITIONS.map((e) => ({ v: e as EditionFilter, text: EDITION_NAME[e], color: EDITION_COLOR[e] }))]}
            />
            <Segments
              label="Mode"
              value={mode}
              onChange={setMode}
              testPrefix="lobby-pace"
              options={[
                { v: "all" as ModeFilter, text: "Any mode" },
                { v: "live" as ModeFilter, text: "Live" },
                { v: "async" as ModeFilter, text: "Async" },
              ]}
            />
            <BoardClock />
          </div>
        </div>
        {statusLine !== null ? (
          <p className={`lb-status${error ? " lb-warn" : ""}`} data-testid="lobby-rooms-status" role={error ? "alert" : "status"}>
            {statusLine}
          </p>
        ) : (
          <>
            <div className="lb-cols" aria-hidden="true">
              <span>Opened</span>
              <span>Table</span>
              <span>Seats</span>
              <span className="lb-c-ante">Ante</span>
              <span>Status</span>
              <span className="lb-c-act" />
            </div>
            <ol className="lb-rows" aria-label="Tables taking seats" data-testid="lobby-group-open">
              {waiting.length === 0 && (
                <li className="lb-empty" data-testid="lobby-rooms-empty">
                  {waitingCount === 0 ? "No tables taking seats right now. Host one, or join a private game by its code." : "No tables taking seats match these filters."}
                </li>
              )}
              {waiting.map((row) => {
                const leaving = departing.has(row.gameId);
                const status = statusOf(row, leaving);
                const join = canJoin(row, noAnteSeats, leaving);
                return (
                  <React.Fragment key={row.gameId}>
                    <li
                      ref={setRowEl(leaving ? `dep:${row.gameId}` : row.gameId)}
                      className="lb-row"
                      style={{ "--ed": row.color } as React.CSSProperties}
                      data-testid={`lobby-room-${row.code}`}
                      onAnimationEnd={(event) => event.currentTarget.classList.remove("lb-ping")}
                    >
                      <span className="lb-when">
                        <span className="lb-time" title="Opened (UTC)">
                          {boardTime(row.createdAtMs, now)}
                        </span>
                        <SplitFlap className="lb-f-code" text={row.codeTail} width={4} label={`Code ending ${row.codeTail}`} title="Last four characters of the table code" />
                      </span>
                      <TableCell row={row} />
                      <span className="lb-seats">
                        <button
                          type="button"
                          className="lb-seatbtn"
                          aria-haspopup="dialog"
                          aria-expanded={pop?.gameId === row.gameId}
                          aria-label={`${row.seated} of ${row.capacity} seats taken. Show who is seated.`}
                          onClick={(event) => open(row.gameId, event.currentTarget)}
                          data-testid={`lobby-seats-${row.code}`}
                        >
                          <SplitFlap className="lb-sm" text={`${row.seated}/${row.capacity}`} width={3} />
                          <Pips row={row} />
                          <span className="lb-lab">{row.exactCount ? "Exactly" : "Any count"}</span>
                        </button>
                      </span>
                      {row.stake !== null ? (
                        <span className="lb-ante">
                          <span className="lb-amt">
                            <em>Ante</em>
                            {row.stake.ante}
                          </span>
                          <small>
                            {row.stake.funded}/{row.stake.seats} funded
                          </small>
                        </span>
                      ) : (
                        <span className="lb-ante lb-none">No ante</span>
                      )}
                      <span className="lb-st">
                        <SplitFlap className={`lb-st-${status}`} text={STATUS_WORD[status]} width={10} label={STATUS_WORD[status]} testId={status === "full" ? `lobby-full-${row.code}` : `lobby-status-${row.code}`} />
                      </span>
                      <span className="lb-act">
                        {join ? (
                          <button type="button" className="lb-join" disabled={busy} onClick={() => onJoin(row.code)} aria-label={`Join ${tableName(row)}`} title={`Take a seat at ${row.host}’s table, ${row.code}.`} data-testid={`lobby-join-${row.code}`}>
                            Join
                          </button>
                        ) : row.status === "waiting" && !leaving && !row.full && row.stake === null && !noAnteSeats ? (
                          /* PHASE 3 FINAL (§13): every player game is anted -- a no-ante table is watched, never sat at. */
                          <span className="lb-only" data-testid={`lobby-no-ante-${row.code}`}>
                            Watch only
                          </span>
                        ) : null}
                        <button type="button" className="lb-watch" disabled={busy} onClick={() => onWatch(row.gameId)} aria-label={`Watch ${tableName(row)}`} title="Watch this game. You will not have a seat." data-testid={`lobby-watch-${row.code}`}>
                          Watch
                        </button>
                      </span>
                    </li>
                    {refusal !== null && refusal.code === row.code && (
                      <li className="lb-refusal" role="status" data-testid={`lobby-refusal-${row.code}`}>
                        {refusal.reason}
                      </li>
                    )}
                  </React.Fragment>
                );
              })}
            </ol>
          </>
        )}
        <div className="lb-foot-note">
          <span>Oldest tables first; new tables join the bottom. Times in UTC.</span>
          <span>A private table is joined by its code.</span>
        </div>
      </section>

      {/* ---------------- Under way ---------------- */}
      <section className="lb-board lb-under" data-open={String(underOpen)} aria-labelledby="lb-und-h" data-testid="lobby-group-ongoing">
        <div className="lb-head">
          <h2 id="lb-und-h">
            Under way{" "}
            <span className="lb-count" data-testid="lobby-under-count">
              {playingCount} {playingCount === 1 ? "game" : "games"}
            </span>
          </h2>
          <div className="lb-tools">
            <button type="button" className="lb-toggle" aria-expanded={underOpen} aria-controls="lb-und-body" onClick={() => setUnderOpen((v) => !v)} data-testid="lobby-under-toggle">
              {underOpen ? "Hide" : "Show"}
            </button>
          </div>
        </div>
        <div className="lb-body" id="lb-und-body">
          <div className="lb-cols" aria-hidden="true">
            <span>Started</span>
            <span>Table</span>
            <span>Players</span>
            <span className="lb-c-ante">Ante</span>
            <span />
          </div>
          <ol className="lb-rows" aria-label="Games in progress">
            {playing.length === 0 && <li className="lb-empty">{playingCount === 0 ? "No games under way." : "No games under way match these filters."}</li>}
            {playing.map((row) => (
              <li
                key={row.gameId}
                ref={setRowEl(row.gameId)}
                className="lb-row"
                style={{ "--ed": row.color } as React.CSSProperties}
                data-testid={`lobby-room-${row.code}`}
                onAnimationEnd={(event) => event.currentTarget.classList.remove("lb-ping")}
              >
                <span className="lb-when">
                  <span className="lb-time" title={row.startedAtMs !== null ? "Started (UTC)" : "Opened (UTC)"}>
                    {boardTime(row.startedAtMs ?? row.createdAtMs, now)}
                  </span>
                  <SplitFlap className="lb-f-code" text={row.codeTail} width={4} label={`Code ending ${row.codeTail}`} title="Last four characters of the table code" />
                </span>
                <TableCell row={row} />
                <span className="lb-seats">
                  <button
                    type="button"
                    className="lb-seatbtn"
                    aria-haspopup="dialog"
                    aria-expanded={pop?.gameId === row.gameId}
                    aria-label={`${row.seated} players. Show who is playing.`}
                    onClick={(event) => open(row.gameId, event.currentTarget)}
                    data-testid={`lobby-seats-${row.code}`}
                  >
                    <Pips row={row} />
                    <span className="lb-lab">{row.seated} players</span>
                  </button>
                </span>
                {row.stake !== null ? (
                  <span className="lb-ante">
                    <span className="lb-amt">
                      <em>Ante</em>
                      {row.stake.ante}
                    </span>
                    <small>
                      {anteTimes(row.stake, row.seated)} across {row.seated} seats
                    </small>
                  </span>
                ) : (
                  <span className="lb-ante lb-none">No ante</span>
                )}
                <span className="lb-act">
                  <button type="button" className="lb-watch" disabled={busy} onClick={() => onWatch(row.gameId)} aria-label={`Watch ${tableName(row)}`} title="Watch this game. You will not have a seat." data-testid={`lobby-watch-${row.code}`}>
                    Watch
                  </button>
                </span>
              </li>
            ))}
          </ol>
          <div className="lb-foot-note">
            <span>Every public game can be watched.</span>
          </div>
        </div>
      </section>

      {/* ---------------- the seated list ---------------- */}
      {pop !== null && popRow !== undefined && (
        <div ref={popEl} className="lb-pop" role="dialog" aria-modal="false" aria-labelledby="lb-pop-h" data-testid="lobby-seated">
          <SeatedList
            row={popRow}
            departing={departing.has(popRow.gameId)}
            history={history}
            expanded={expanded}
            onToggle={(key) =>
              setExpanded((current) => {
                const next = new Set(current);
                if (next.has(key)) next.delete(key);
                else next.add(key);
                return next;
              })
            }
            onRetry={() => load(popRow.gameId, true)}
            onClose={() => close()}
          />
        </div>
      )}
    </section>
  );
}

function SeatedList({
  row,
  departing,
  history,
  expanded,
  onToggle,
  onRetry,
  onClose,
}: {
  row: BoardRow;
  departing: boolean;
  history: { state: "loading" | "ok" | "error"; players: PublicSeatHistory[] } | undefined;
  expanded: ReadonlySet<string>;
  onToggle: (key: string) => void;
  onRetry: () => void;
  onClose: () => void;
}) {
  const playing = row.status === "playing" || departing;
  const stake = row.stake;
  const fundedSeats = row.seats.filter((seat) => seat.funded === true).length;
  return (
    <>
      <h3 id="lb-pop-h">
        {playing ? `Playing · ${row.seated}` : `Seated · ${row.seated} of ${row.capacity}`}
        <button type="button" aria-label="Close" onClick={onClose} data-testid="lobby-seated-close">
          ×
        </button>
      </h3>
      {stake !== null &&
        (playing ? (
          <p className="lb-agg">
            <em>Antes</em>
            {stake.ante} × {row.seated} seats = {anteTimes(stake, row.seated)}
          </p>
        ) : (
          <p className="lb-agg">
            <em>Antes funded</em>
            {stake.funded} of {stake.seats} seats · {anteOf(stake, stake.funded, stake.seats)}
          </p>
        ))}
      <ul>
        {row.seats.map((seat, i) => {
          const key = `${row.gameId}:${i}`;
          const isOpen = expanded.has(key);
          const mine = history?.players.find((p) => p.seat === i && p.name === seat.name);
          return (
            <li key={key}>
              <button type="button" className="lb-who" aria-expanded={isOpen} onClick={() => onToggle(key)} data-testid={`lobby-seated-${i}`}>
                <b>{seat.name}</b>
                {seat.host && <span className="lb-tag">host</span>}
                {stake !== null && !playing && seat.funded !== null && <span className={`lb-fund${seat.funded ? " lb-paid" : ""}`}>{seat.funded ? "ante paid" : "not funded"}</span>}
              </button>
              {isOpen && <HistoryFacts history={history} mine={mine} onRetry={onRetry} />}
            </li>
          );
        })}
        {!playing && row.exactCount && Array.from({ length: Math.max(0, row.capacity - row.seated) }, (_, i) => <li key={`open-${i}`} className="lb-open">Open seat</li>)}
      </ul>
      {!playing && !row.exactCount && <p>Seats stay open until the host starts. Up to {row.capacity}.</p>}
      {stake !== null && !playing && fundedSeats !== stake.funded && row.seats.some((seat) => seat.funded === null) && <p>Each seat’s funding shows once the escrow has been read.</p>}
      <p className="lb-disc">Tap a name for their public game history: completed games, results and standings from this server’s records. Not a rating.</p>
    </>
  );
}

function HistoryFacts({ history, mine, onRetry }: { history: { state: "loading" | "ok" | "error" } | undefined; mine: PublicSeatHistory | undefined; onRetry: () => void }) {
  if (history === undefined || history.state === "loading") {
    return (
      <dl className="lb-facts" aria-busy="true">
        <dt>Public game history</dt>
        <dd>Reading…</dd>
      </dl>
    );
  }
  if (history.state === "error" || mine === undefined) {
    return (
      <dl className="lb-facts">
        <dt>Public game history</dt>
        <dd>
          Could not be read just now.{" "}
          <button type="button" className="lb-watch" style={{ padding: "3px 8px", fontSize: 12 }} onClick={onRetry}>
            Try again
          </button>
        </dd>
      </dl>
    );
  }
  const lines = historyLines(mine.history);
  if (lines.none) {
    return (
      <dl className="lb-facts" data-testid="lobby-history">
        <dt>Public game history</dt>
        <dd>No completed games yet.</dd>
      </dl>
    );
  }
  return (
    <dl className="lb-facts" data-testid="lobby-history">
      <dt>Public game history</dt>
      <dd>{lines.summary}</dd>
      <dd>{lines.wins}</dd>
      <dt>Standings</dt>
      <dd className="lb-fin">
        {lines.standings.map((s) => (
          <span key={s}>{s}</span>
        ))}
      </dd>
      {lines.partial !== null && <dd>{lines.partial}</dd>}
      {lines.recent.length > 0 && <dt>Recent results</dt>}
      {lines.recent.map((r, i) => (
        <dd key={i} className="lb-res">
          <span>{r.day}</span>
          <span>{r.edition}</span>
          <b>{r.result}</b>
        </dd>
      ))}
    </dl>
  );
}

export default LobbyBoards;
