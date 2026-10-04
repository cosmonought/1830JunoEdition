// frontend/src/utils/roomNotices.ts
//
/* ==================================================================
    PHASE 3 W3-C (AUD-14.01, P3-N004): THE ROOM STRIP HAS TWO SLOTS -- THE CONNECTION AND THE REFUSAL
   ==================================================================
   The room strip had ONE error slot (`sandboxRoomError`) written by ~28 sites and cleared by EXACT-TEXT match: a
   writer that wanted to retire its own banner compared the slot with its constant and cleared it only if nothing had
   replaced it. Two facts of different kinds shared that slot, so each hid the other:
     - the CONNECTION: the wire is down, the tab is catching up or rebuilding, the room is paused, the build or the
       rules differ, the boards diverged -- facts about the link, true until the link says otherwise;
     - the REFUSAL: this tab's last move did not happen -- the turn gate, the server's `refused` / stale answer, a
       move that could not be sent, a room operation the server refused -- a fact about ONE action, true until a
       later action lands (P3-N004: a non-turn refusal used to stay up after the turn was played on).
   A reconnecting banner replaced a refusal the player had not read; a refusal replaced the reconnecting banner, which
   then never came back.

   SO THERE ARE TWO SLOTS, AND EVERY CLEAR NAMES A KIND, NOT A SENTENCE.
     - `connections` holds the link's notices, one per KIND (W3-J: it held one in all). `clear-connection` retires a kind -- the link's own `open` clears
       `reconnecting`, the drain's end clears `catching-up`, the room's `live` clears `room-status` -- whatever its
       text was (a server-written pause reason included).
     - `refusal` holds the last refusal's sentence. `submission-landed` (a later move of this tab was applied) clears
       it, and with it the two connection kinds a landed move contradicts (`catching-up`, `resync`); a reconnecting
       banner, a paused room, a build skew, an incompatible room and a divergence verdict are about other facts and
       stand (#1407's distinction, kept).
   NOTHING HERE DECIDES A REFUSAL. The sentences are the authorities' own -- the server's `refused` reason, the
   turn gate's `TURN_REFUSAL`, `refusalMessage(code)` for a room op -- passed through unchanged. */

/** #1253: the room-error banner while the link is between sockets. */
export const RECONNECTING_BANNER = "Connection to the room was lost — reconnecting…";
/** #1407: the turn refusal's one wording -- the client gate's and `turnAuthority`'s. */
export const TURN_REFUSAL = "It is not your turn.";
/** #1407: what a click during the reload's replay is told, in place of a turn refusal about a historical board. */
export const CATCHING_UP_BANNER = "Catching up with the room — try that again in a moment.";
/** LIVE-3A: while this tab rebuilds a room whose history it turned out not to share (`ahead` / `resync`). */
export const RESYNC_BANNER = "This tab's copy of the room did not match the server's — reloading the room's history.";
/** LIVE-3A: while the server holds the room (`status`) and gave no sentence of its own. */
export const ROOM_PAUSED_BANNER = "The game server has paused this room. It will resume on its own.";

export type ConnectionNoticeKind =
  | "reconnecting" // the wire is between sockets (#1253)
  | "catching-up" // the drain is replaying the log; a click now is about a historical board (#1407)
  | "resync" // the tab is rebuilding a history the room does not share (LIVE-3A)
  | "room-status" // the server is holding the room (LIVE-3A E-10)
  | "build-skew" // this tab's build and the server's differ (#1206)
  | "incompatible" // the server does not continue this room (#1520)
  | "divergence" // the client's board hashed differently from the server's (#1223)
  | "transport"; // the link's own error sentence

/** One connection notice: a fact about the link, with its kind. */
export interface ConnectionNotice {
  readonly kind: ConnectionNoticeKind;
  readonly text: string;
}

/* ==================================================================
    PHASE 3 W3-J (AUD-25.13, W3-C one-slot NIT): ONE CONNECTION NOTICE PER KIND, NOT ONE IN ALL
   ==================================================================
   W3-C's connection slot held ONE notice, so two true facts about the link replaced each other: a room the server had
   paused ("The game server has paused this room") lost its notice the moment the wire dropped ("reconnecting"), and
   when the wire came back the strip said nothing although the room was still paused. The slot now holds every
   standing connection notice, ONE PER KIND: a later notice of the same kind replaces the earlier one (a new
   divergence verdict, a new pause reason), a notice of another kind stands beside it, and each clear still retires
   exactly its own kind. The refusal slot is unchanged. */
export interface RoomNotices {
  /** Every standing connection notice, one per kind, in the order they arrived. */
  readonly connections: readonly ConnectionNotice[];
  readonly refusal: string | null;
}

export const NO_ROOM_NOTICES: RoomNotices = Object.freeze({ connections: Object.freeze([]) as readonly ConnectionNotice[], refusal: null });

export type RoomNoticeAction =
  | { type: "connection"; kind: ConnectionNoticeKind; text: string }
  | { type: "clear-connection"; kind: ConnectionNoticeKind }
  | { type: "refusal"; text: string }
  | { type: "clear-refusal" }
  /** A later move of this tab was applied by the room: the refusal it answers is retired, and so are the two
   *  connection notices a landed move contradicts. */
  | { type: "submission-landed" }
  /** Leaving / switching the room: nothing on the strip belongs to the next one. */
  | { type: "reset" };

/** Kinds a landed move proves over: the tab is caught up and its history is the room's. */
const RETIRED_BY_A_LANDED_MOVE: ReadonlySet<ConnectionNoticeKind> = new Set<ConnectionNoticeKind>(["catching-up", "resync"]);

/** The client's own pre-send line when the room link is between sockets (`runGameplayAction`'s link-down gate). */
export const LINK_DOWN_NOT_SENT = "The room link is reconnecting — try that again in a moment.";

/** The standing notice of `kind`, or `null`. */
export function connectionOf(notices: RoomNotices, kind: ConnectionNoticeKind): ConnectionNotice | null {
  return notices.connections.find((entry) => entry.kind === kind) ?? null;
}

const withoutKind = (connections: readonly ConnectionNotice[], kind: ConnectionNoticeKind) =>
  connections.filter((entry) => entry.kind !== kind);

export function roomNoticesReducer(state: RoomNotices, action: RoomNoticeAction): RoomNotices {
  switch (action.type) {
    case "connection": {
      const standing = connectionOf(state, action.kind);
      if (standing !== null && standing.text === action.text) return state;
      return { ...state, connections: [...withoutKind(state.connections, action.kind), { kind: action.kind, text: action.text }] };
    }
    case "clear-connection":
      return connectionOf(state, action.kind) === null ? state : { ...state, connections: withoutKind(state.connections, action.kind) };
    case "refusal":
      /* W3-J (AUD-25.10, NIT): the link-down pre-send line only restated the reconnecting banner standing beside it
         ("The room link is reconnecting" next to "Connection to the room was lost — reconnecting…"). While that banner
         stands it says everything the line would; without it (#1242's should-be-unreachable case) the line still shows. */
      if (action.text === LINK_DOWN_NOT_SENT && connectionOf(state, "reconnecting") !== null) return state;
      return state.refusal === action.text ? state : { ...state, refusal: action.text };
    case "clear-refusal":
      return state.refusal === null ? state : { ...state, refusal: null };
    case "submission-landed": {
      const connections = state.connections.filter((entry) => !RETIRED_BY_A_LANDED_MOVE.has(entry.kind));
      if (connections.length === state.connections.length && state.refusal === null) return state;
      return { connections, refusal: null };
    }
    case "reset":
      return state.connections.length === 0 && state.refusal === null ? state : NO_ROOM_NOTICES;
    default:
      return state;
  }
}

/** The kind a sentence written through the shell's one-string setter belongs to: the constants that are connection
 *  notices by construction, by identity; every other sentence is a refusal of an action. Used only by the writers that
 *  still hand a bare sentence (the turn gate, the send-failure lines, the room's own refusals). */
export function noticeActionFor(text: string): RoomNoticeAction {
  if (text === CATCHING_UP_BANNER) return { type: "connection", kind: "catching-up", text };
  if (text === RECONNECTING_BANNER) return { type: "connection", kind: "reconnecting", text };
  if (text === RESYNC_BANNER) return { type: "connection", kind: "resync", text };
  return { type: "refusal", text };
}

/** The order the strip and the one-line surfaces read standing connection notices in: what ends or freezes the room
 *  first, then what the board's state is, then the wire. Arrival order breaks no tie -- each kind appears once. */
const CONNECTION_PRIORITY: readonly ConnectionNoticeKind[] = [
  "incompatible",
  "build-skew",
  "divergence",
  "room-status",
  "reconnecting",
  "resync",
  "catching-up",
  "transport",
];
const priorityOf = (kind: ConnectionNoticeKind) => {
  const at = CONNECTION_PRIORITY.indexOf(kind);
  return at < 0 ? CONNECTION_PRIORITY.length : at;
};

/** Every standing connection notice, in the strip's reading order. */
export function standingConnections(notices: RoomNotices): readonly ConnectionNotice[] {
  return notices.connections.slice().sort((a, b) => priorityOf(a.kind) - priorityOf(b.kind));
}

/** One line, for the surfaces that have one slot (the waiting room, the gate pages).
 *  PHASE 3 W3-J (AUD-25.13, W3-C one-line NIT): it read the refusal FIRST AND ONLY, so a standing connection notice --
 *  a paused room, a reconnecting wire, a room this server does not continue -- vanished behind the answer to the
 *  player's last click. The line now says every standing connection notice, in the strip's order, and then the
 *  refusal; a sentence is never said twice. */
export function roomNoticeLine(notices: RoomNotices): string | null {
  const said: string[] = [];
  for (const entry of standingConnections(notices)) if (!said.includes(entry.text)) said.push(entry.text);
  if (notices.refusal !== null && !said.includes(notices.refusal)) said.push(notices.refusal);
  return said.length === 0 ? null : said.join(" ");
}
