// frontend/src/components/LobbyRoomList.tsx
//
/* ==================================================================
    DESIGN NOTE 1440: THE PUBLIC GAMES ARE BROWSED ON THE LOBBY; THE CODE BOX IS FOR THE UNLISTED ROOM
   ==================================================================
   RULED: "public games are browsed on the Lobby; Join Game is for entering a room code for an unlisted/private
   game ... scrolling through two dozen games inside a modal is the wrong primary flow."
   #1415 PUT THE LIST IN THE MODAL AND WAS RIGHT ABOUT THE DATA AND WRONG ABOUT THE ROOM. Its own note says the
   list "is the server's `rooms` frame, pushed on every room write" -- a thing that changes while you look at
   it -- and then mounted it behind a button, over a backdrop, in a 640px box with its own scrollbar. A modal is
   for a decision with a beginning and an end; a room list is a page.
   SO THE LIST IS FLOW CONTENT AND THE CODE BOX IS THE MODAL, which is the division the feature always had:
   a public room is something you FIND, a private room is something you were TOLD.
   ONE MARKUP AT BOTH WIDTHS, by `display: contents`. The facts wrapper is transparent to the desktop grid --
   its five children take tracks of their own -- and becomes a wrapping flex row under the name at narrow
   widths. Rendering the row twice and hiding one is how two layouts drift apart; this way there is one row
   and the only thing the breakpoint changes is where its parts sit.
   NOT A CARD PER ROOM. #1415's cards were right for four rooms in a dialog and wrong for twenty-four on a
   page: twenty-four bordered boxes is a page with no hierarchy at all. A row, a hairline, and the type doing
   the ranking -- the Rules Reference's treatment, without its round-specific hues, which mean nothing here.
   THE VARIANTS GO THROUGH `resolveVariants`. The server stores `write.variants ?? STANDARD_VARIANTS` verbatim
   (`gameServer.ts`), so the one field this list formats as a number -- the bank -- arrives unchecked. The
   normaliser that every replay already runs is the right guard, rather than a second opinion about what a
   valid length is. */

import React, { useMemo, useState } from "react";

import { FONT_SIZE, RADIUS } from "../styles/typography";
import { INK_TEXT, INK_TEXT_DIM, INK_TEXT_FAINT, INK_TEXT_MUTED } from "../styles/palette";
import {
  GAME_MODE_COPY,
  GAME_TYPE_COPY,
  bankSizeLabel,
  gameTypeOf,
  resolveVariants,
  type GameMode,
  type GameVariants,
} from "../gameEngine/gameVariants";
import type { SandboxRoomSummary } from "../utils/sandboxRoomSummary";
import { formatJuno } from "../utils/anteMath";

/** The rule variants a row names, in the house-rules order, by their short titles (#1415). */
const RULE_TITLES: ReadonlyArray<{
  key: "gentleRust" | "dynamicStockMarket" | "delayedAuction" | "unpredictableRevenue" | "plusTiles";
  title: string;
}> = [
  { key: "plusTiles", title: "18XX+ tiles" },
  { key: "gentleRust", title: "Gentle Rust" },
  { key: "dynamicStockMarket", title: "Dynamic Market" },
  { key: "delayedAuction", title: "Delayed Auction" },
  { key: "unpredictableRevenue", title: "Unpredictable Routes" },
];

/** The house rules in force, as titles. The bank is a column of its own, so it is not repeated here. */
export function ruleTitlesFor(variants: GameVariants): string[] {
  const titles: string[] = [];
  for (const rule of RULE_TITLES) {
    /* The tray is the type's own under the Level Playing Field; naming it there says nothing. */
    if (rule.key === "plusTiles" && variants.levelPlayingField) continue;
    if (variants[rule.key]) titles.push(rule.title);
  }
  return titles;
}

/** What one row shows, derived once so the sort, the filter and the render read the same facts. */
export interface PublicRoomRow {
  code: string;
  hostNickname: string;
  status: SandboxRoomSummary["status"];
  variants: GameVariants;
  typeLabel: string;
  paceLabel: string;
  bankLabel: string;
  anteLabel: string | null;
  seated: number;
  seatCap: number;
  exactCount: boolean;
  full: boolean;
  rules: string[];
  createdAtMs: number;
}

export function publicRoomRow(room: SandboxRoomSummary): PublicRoomRow {
  const variants = resolveVariants(room.variants);
  const seated = room.players.length;
  return {
    code: room.code,
    hostNickname: room.hostNickname,
    status: room.status,
    variants,
    typeLabel: GAME_TYPE_COPY[gameTypeOf(variants)].label,
    paceLabel: GAME_MODE_COPY[variants.mode].label,
    bankLabel: bankSizeLabel(variants.length),
    /* The ante is off for the playtest (#1415) and a column of "0 JUNO" twenty-four times is not a fact
       anybody is choosing on. Shown only once there is one. */
    anteLabel: room.anteUjuno === "0" ? null : formatJuno(room.anteUjuno),
    seated,
    seatCap: room.seatCap,
    exactCount: room.playerCount !== null,
    full: seated >= room.seatCap,
    rules: ruleTitlesFor(variants),
    createdAtMs: room.createdAtMs,
  };
}

/* ==================================================================
    DESIGN NOTE 1441: EVERY PUBLIC ROOM CAN BE WATCHED, AND ONE OF THEM CAN BE SAT AT
   ==================================================================
   RULED: "A public waiting room with an available seat offers Join as its primary action and Watch as a
   secondary action. A public waiting room that is full offers Watch, not a disabled Full control. 'Full' may
   remain visible as status text."
   #1440 ASKED THE SERVER WHAT IT WOULD ALLOW AND THEN OFFERED LESS THAN THE ANSWER. `gameServer.ts` refuses a
   SEAT past the cap and refuses a SEAT once a game is dealt, but it refuses a WATCHER only for a private room
   after the deal -- so a public table has always been watchable at every point in its life, and the Host
   card has always promised exactly that: "Listed on the Lobby. Anyone can join, and anyone can watch."
   A DISABLED BUTTON WAS THE WORST OF THE THREE ANSWERS. It occupied the one place a control can be, said no,
   and hid the thing the room could still do. "Full" is a fact about the table, so it is written as one;
   Watch is a door, so it is drawn as one.
   THE TWO ACTIONS ARE RANKED RATHER THAN MATCHED. Join is filled and 700; Watch is an outline at 600 in the
   muted ink -- so a player reaching for a seat does not land on the rail. Join always comes first. */
export type PaceFilter = "all" | GameMode;

export function filterByPace(rows: readonly PublicRoomRow[], pace: PaceFilter): PublicRoomRow[] {
  return rows.filter((row) => pace === "all" || row.variants.mode === pace);
}

/** Newest first -- the order the server builds the frame in -- with a row whose only action is disabled
 *  pushed below the rows that can be acted on. */
export function sortRooms(rows: readonly PublicRoomRow[]): PublicRoomRow[] {
  return rows.slice().sort((a, b) => {
    if (a.full !== b.full) return a.full ? 1 : -1;
    return b.createdAtMs - a.createdAtMs;
  });
}

export interface LobbyRoomListProps {
  rooms: readonly SandboxRoomSummary[];
  loading: boolean;
  /** The list's own error -- the server could not be reached. */
  error: string | null;
  /** False when this build has no game server; the section explains and offers nothing. */
  available: boolean;
  busy: boolean;
  /** Design note #1440: the last join's verdict, and the room it was about, so the row says it rather than
   *  the button row at the top of the page. */
  refusal: { code: string; reason: string } | null;
  onJoin: (code: string) => void;
  onWatch: (code: string) => void;
}

export function LobbyRoomList({ rooms, loading, error, available, busy, refusal, onJoin, onWatch }: LobbyRoomListProps) {
  const [pace, setPace] = useState<PaceFilter>("all");

  const all = useMemo(() => rooms.map(publicRoomRow), [rooms]);
  const shown = useMemo(() => filterByPace(all, pace), [all, pace]);
  const open = useMemo(() => sortRooms(shown.filter((row) => row.status === "waiting")), [shown]);
  const ongoing = useMemo(() => sortRooms(shown.filter((row) => row.status === "playing")), [shown]);

  /* ==================================================================
      DESIGN NOTE 1440: NO SERVER, NO SECTION -- #521a's RULE, EXPRESSED ONCE
     ==================================================================
     "With Firestore unconfigured the controls are HIDDEN rather than disabled. A disabled control invites the
     player to work out how to enable it; this is a deployment fact they cannot act on from inside the game."
     A heading over a sentence about a build variable is the same invitation in prose. `SandboxRoomBar` already
     says what this build cannot do, once, where the two doors would have been.
     THE GATE LIVES HERE RATHER THAN AT THE MOUNT, so the section owns the whole of its own absence: a caller
     that forgets the condition cannot produce a "Public games" heading with nothing behind it. */
  if (!available) return null;

  const status = error
    ? error
      : loading
        ? "Looking for public games…"
        : all.length === 0
          ? "No public games right now. Host one, or join a private game by its code."
          : shown.length === 0
            ? `No ${GAME_MODE_COPY[pace === "async" ? "async" : "live"].label.toLowerCase()} games right now.`
            : null;

  return (
    <section style={styles.section} aria-labelledby="lobby-public-games" data-testid="lobby-public-games">
      <style>{LOBBY_ROOMS_CSS}</style>
      <div style={styles.head}>
        <h2 id="lobby-public-games" style={styles.heading}>
          Public games
        </h2>
        {all.length > 0 && (
          <span style={styles.count} data-testid="lobby-rooms-count">
            {all.length}
          </span>
        )}
        {/* The one axis a room can be unusable on whatever else it offers: a game played over days is not a
            game you can sit down at now. Everything else a player weighs is in the row already. */}
        {all.length > 0 && (
          <div style={styles.filter} role="radiogroup" aria-label="Pace">
            {(["all", "live", "async"] as const).map((candidate) => (
              <button
                key={candidate}
                type="button"
                role="radio"
                aria-checked={pace === candidate}
                className="lobby-rooms-filter"
                style={{ ...styles.filterButton, ...(pace === candidate ? styles.filterButtonOn : {}) }}
                onClick={() => setPace(candidate)}
                data-testid={`lobby-pace-${candidate}`}
              >
                {candidate === "all" ? "Any pace" : GAME_MODE_COPY[candidate].label}
              </button>
            ))}
          </div>
        )}
      </div>

      {status !== null ? (
        <p style={error ? styles.warning : styles.status} data-testid="lobby-rooms-status">
          {status}
        </p>
      ) : (
        <>
          <RoomGroup
            id="open"
            title="Open"
            subtitle="waiting rooms"
            rows={open}
            busy={busy}
            refusal={refusal}
            onJoin={onJoin}
            onWatch={onWatch}
          />
          <RoomGroup
            id="ongoing"
            title="Under way"
            subtitle="games in progress"
            rows={ongoing}
            busy={busy}
            refusal={refusal}
            onJoin={onJoin}
            onWatch={onWatch}
          />
        </>
      )}
    </section>
  );
}

export default LobbyRoomList;

function RoomGroup({
  id,
  title,
  subtitle,
  rows,
  busy,
  refusal,
  onJoin,
  onWatch,
}: {
  id: string;
  title: string;
  subtitle: string;
  rows: readonly PublicRoomRow[];
  busy: boolean;
  refusal: { code: string; reason: string } | null;
  onJoin: (code: string) => void;
  onWatch: (code: string) => void;
}) {
  if (rows.length === 0) return null;
  return (
    <div style={styles.group} data-testid={`lobby-group-${id}`}>
      <h3 style={styles.groupHeading}>
        {title}
        <span style={styles.groupCount}>
          {rows.length} {subtitle}
        </span>
      </h3>
      {/* The column names, for the width that has columns. Hidden from assistive technology because each
          cell below says what it is in its own accessible name -- a header row with no table is furniture. */}
      <div className="lobby-rooms-row lobby-rooms-head" style={styles.headRow} aria-hidden="true">
        <span>Game</span>
        <span className="lobby-rooms-facts">
          <span>Pace</span>
          <span style={styles.numberCell}>Seats</span>
          <span style={styles.numberCell}>Bank</span>
          <span>House rules</span>
        </span>
        <span />
      </div>
      <ul style={styles.list}>
        {rows.map((row) => (
          <React.Fragment key={row.code}>
            <RoomRow row={row} busy={busy} onJoin={onJoin} onWatch={onWatch} />
            {refusal !== null && refusal.code === row.code && (
              <li style={styles.refusal} role="status" data-testid={`lobby-refusal-${row.code}`}>
                {refusal.reason}
              </li>
            )}
          </React.Fragment>
        ))}
      </ul>
    </div>
  );
}

function RoomRow({
  row,
  busy,
  onJoin,
  onWatch,
}: {
  row: PublicRoomRow;
  busy: boolean;
  onJoin: (code: string) => void;
  onWatch: (code: string) => void;
}) {
  const seats = `${row.seated}/${row.seatCap}${row.exactCount ? " exactly" : ""}`;
  const table = `${row.hostNickname}’s table, ${row.code}`;
  return (
    <li className="lobby-rooms-row" style={styles.row} data-testid={`lobby-room-${row.code}`}>
      <span style={styles.main}>
        <span style={styles.name}>{row.typeLabel}</span>
        <span style={styles.meta}>
          <span style={styles.code}>{row.code}</span> · {row.hostNickname}
          {row.anteLabel !== null ? ` · ante ${row.anteLabel}` : ""}
        </span>
      </span>
      <span className="lobby-rooms-facts">
        <span style={styles.fact}>{row.paceLabel}</span>
        <span style={{ ...styles.fact, ...styles.numberCell }} title={row.exactCount ? "This table starts at exactly this many players." : undefined}>
          {seats}
        </span>
        <span style={{ ...styles.fact, ...styles.numberCell }}>{row.bankLabel}</span>
        <span style={styles.rules}>{row.rules.length > 0 ? row.rules.join(" · ") : "—"}</span>
      </span>
      <span className="lobby-rooms-action" style={styles.action}>
        {row.status === "waiting" &&
          (row.full ? (
            /* #1441: a fact about the table, written as one. It is not a control and never was -- the
               disabled button it replaces could only ever say no. */
            <span style={styles.fullTag} data-testid={`lobby-full-${row.code}`}>
              Full
            </span>
          ) : (
            <button
              type="button"
              style={{ ...styles.joinButton, ...(busy ? styles.disabled : {}) }}
              disabled={busy}
              onClick={() => onJoin(row.code)}
              aria-label={`Join ${table}`}
              title={`Take a seat at ${table}.`}
              data-testid={`lobby-join-${row.code}`}
            >
              Join
            </button>
          ))}
        <button
          type="button"
          style={{ ...styles.watchButton, ...(busy ? styles.disabled : {}) }}
          disabled={busy}
          onClick={() => onWatch(row.code)}
          aria-label={`Watch ${table}`}
          title="Watch this game. You will not have a seat."
          data-testid={`lobby-watch-${row.code}`}
        >
          Watch
        </button>
      </span>
    </li>
  );
}

/* ==================================================================
    DESIGN NOTE 1440: ONE ROW, TWO SHAPES, NO SECOND MARKUP
   ==================================================================
   `display: contents` is what makes the single markup possible: on the wide grid the facts wrapper is not a
   box at all and its four children take tracks two to five; under the breakpoint it becomes a real flex row
   in the second line, under the name, with the action spanning both lines.
   THE TRACKS ARE `minmax(0, ...)` AND THE CELLS WRAP. A grid track's default `min-width: auto` is the widest
   word in it, which is how a long host name or a four-rule game would push a page-wide scrollbar out of a
   column nobody could see -- the fault this project has now chased twice on the Game Ledger (#1436). */
const LOBBY_ROOMS_CSS = `
.lobby-rooms-row {
  display: grid;
  grid-template-columns: minmax(0, 1.7fr) 62px 96px 84px minmax(0, 1.5fr) max-content;
  column-gap: 14px;
  align-items: baseline;
}
.lobby-rooms-facts { display: contents; }
.lobby-rooms-filter { transition: color 90ms ease, border-color 90ms ease; }
@media (hover: hover) and (pointer: fine) {
  .lobby-rooms-filter:hover:not([aria-checked="true"]) { color: #f2f0eb; }
  .lobby-rooms-row button:hover:not(:disabled) { border-color: #6f6f6f; }
}
.lobby-rooms-row button:focus-visible,
.lobby-rooms-filter:focus-visible { outline: 2px solid #8a8a86; outline-offset: 2px; }
@media (max-width: 899px) {
  .lobby-rooms-head { display: none; }
  .lobby-rooms-row {
    grid-template-columns: minmax(0, 1fr) max-content;
    row-gap: 3px;
  }
  .lobby-rooms-row > :first-child { grid-column: 1; grid-row: 1; }
  .lobby-rooms-facts {
    display: flex;
    flex-wrap: wrap;
    gap: 2px 10px;
    grid-column: 1;
    grid-row: 2;
    min-width: 0;
  }
  .lobby-rooms-action {
    grid-column: 2;
    grid-row: 1 / span 2;
    align-self: center;
  }
  /* A row's one control is the whole point of the row, and 28px of it is a thumb's worth of guessing. The
     row is 73px tall here, so the button can take a real target without changing the layout at all. */
  /* "!important" because these override INLINE declarations, which outrank an ordinary rule however
     specific it is -- see the note in Lobby.tsx (#1441). */
  .lobby-rooms-action { gap: 6px !important; }
  .lobby-rooms-action button {
    min-height: 44px;
    padding-left: 14px !important;
    padding-right: 14px !important;
  }
  .lobby-rooms-filter { min-height: 32px; }
}
`;

const styles: Record<string, React.CSSProperties> = {
  section: {
    display: "flex",
    flexDirection: "column",
    gap: "10px",
    width: "100%",
    minWidth: 0,
  },
  head: { display: "flex", alignItems: "baseline", flexWrap: "wrap", gap: "8px 12px" },
  heading: { margin: 0, fontSize: FONT_SIZE.heading, fontWeight: 800, letterSpacing: "0.01em", color: INK_TEXT },
  count: {
    fontSize: FONT_SIZE.small,
    fontWeight: 700,
    fontVariantNumeric: "tabular-nums",
    color: INK_TEXT_MUTED,
    padding: "1px 8px",
    borderRadius: RADIUS.pill,
    border: "1px solid #2a2a2a",
  },
  filter: { display: "flex", gap: "2px", marginLeft: "auto" },
  filterButton: {
    padding: "4px 11px",
    borderRadius: RADIUS.control,
    border: "1px solid transparent",
    backgroundColor: "transparent",
    color: INK_TEXT_MUTED,
    fontSize: FONT_SIZE.small,
    fontWeight: 700,
    cursor: "pointer",
  },
  // #1449: the shorthand, not `borderColor` -- the base is `1px solid transparent`, so the longhand left a
  // BLACK ring on the filter the player had just moved off.
  filterButtonOn: { border: "1px solid #3a3a3a", backgroundColor: "#1a1a1a", color: INK_TEXT },
  status: { margin: 0, fontSize: FONT_SIZE.small, color: INK_TEXT_MUTED, lineHeight: 1.5 },
  warning: { margin: 0, fontSize: FONT_SIZE.small, color: "#e0b062", lineHeight: 1.5 },
  group: { display: "flex", flexDirection: "column", minWidth: 0 },
  groupHeading: {
    margin: "6px 0 2px",
    display: "flex",
    alignItems: "baseline",
    gap: "8px",
    fontSize: FONT_SIZE.small,
    fontWeight: 800,
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    color: INK_TEXT_DIM,
  },
  groupCount: { fontWeight: 600, letterSpacing: "0.02em", textTransform: "none", color: INK_TEXT_FAINT },
  headRow: {
    padding: "6px 0 5px",
    borderBottom: "1px solid #2a2a2a",
    fontSize: FONT_SIZE.micro,
    fontWeight: 700,
    letterSpacing: "0.07em",
    textTransform: "uppercase",
    color: INK_TEXT_FAINT,
  },
  list: { listStyle: "none", margin: 0, padding: 0, minWidth: 0 },
  row: { padding: "9px 0", borderBottom: "1px solid #1d1d1a", minWidth: 0 },
  main: { display: "flex", flexDirection: "column", gap: "1px", minWidth: 0 },
  name: { fontSize: FONT_SIZE.body, fontWeight: 800, color: INK_TEXT, overflowWrap: "anywhere" },
  meta: { fontSize: FONT_SIZE.micro, color: INK_TEXT_FAINT, overflowWrap: "anywhere" },
  code: { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", letterSpacing: "0.04em" },
  fact: { fontSize: FONT_SIZE.small, color: INK_TEXT_DIM, whiteSpace: "nowrap" },
  numberCell: { fontVariantNumeric: "tabular-nums" },
  rules: { fontSize: FONT_SIZE.small, color: INK_TEXT_MUTED, minWidth: 0, overflowWrap: "anywhere" },
  action: { display: "flex", justifyContent: "flex-end", alignItems: "center", gap: "8px" },
  /* #1441: status, not a control -- so it takes the group-head treatment rather than a button's. */
  fullTag: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 700,
    letterSpacing: "0.07em",
    textTransform: "uppercase",
    color: INK_TEXT_FAINT,
    whiteSpace: "nowrap",
  },
  joinButton: {
    padding: "6px 15px",
    borderRadius: RADIUS.control,
    border: "1px solid #3f7a55",
    backgroundColor: "#1d4030",
    color: "#e6f5ec",
    fontSize: FONT_SIZE.small,
    fontWeight: 700,
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  /* #1441: the secondary of the pair. An outline at 600 in the muted ink, beside a filled 700 Join -- the
     difference has to be legible at a glance, because the cost of confusing them is a player on the rail of a
     game they meant to sit down at. */
  watchButton: {
    padding: "6px 13px",
    borderRadius: RADIUS.control,
    border: "1px solid #2e2e2e",
    backgroundColor: "transparent",
    color: INK_TEXT_MUTED,
    fontSize: FONT_SIZE.small,
    fontWeight: 600,
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  refusal: {
    listStyle: "none",
    margin: 0,
    padding: "0 0 9px",
    borderBottom: "1px solid #1d1d1a",
    fontSize: FONT_SIZE.small,
    color: "#e0b062",
    lineHeight: 1.5,
  },
  // #1449: the shorthand, not `borderColor` -- both bases (`joinButton`, `watchButton`) declare `border`.
  disabled: { border: "1px solid #2a2a2a", backgroundColor: "transparent", color: "#6e6c68", cursor: "not-allowed" },
};
