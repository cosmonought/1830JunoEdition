// server/src/rooms/roomAuthz.ts
//
// ==================================================================
//  LIVE-2C (LIVE-2 §6): ONE PURE, TABLE-DRIVEN AUTHORIZATION FUNCTION
// ==================================================================
//
// `authorize(op, ctx)` answers every room and gameplay operation from the CURRENT GameRecord (and the log facts the
// record caches), evaluated per frame -- never cached at `hello`. It reads no room document, no nickname, no
// client-sent player id, no presence and no PIN or token. §6 is its oracle, and `roomAuthz.test` checks every row
// against every role and every lifecycle stage.
//
// THE EVALUATION ORDER (§6.2) is what keeps a private room's existence secret from an outsider:
//   (schema and session are the transport's)  ->  resolve the game: nonexistent, or private and the caller is an
//   outsider -- `not-found`, the two indistinguishable; cancelled/expired/archived -- `gone`  ->  the role
//   (`forbidden`, or `not-seated` for game messages)  ->  the stage (`wrong-state`)  ->  op-specific checks
//   (`roomService.ts`).
//
// ROLES (§6.1), derived here and never from a frame:
//   U  no principal (never reaches a socket; kept for completeness)   V  authenticated, not seated, public room
//   O  not seated, not admitted, private room (a kicked principal of a private room is O)
//   M  admitted to a private room, not seated (read access only while waiting; lost at the deal)
//   S  seated                                                         H  seated in the host seat
// STAGES: W waiting, A active, C completed (closed or not), Hd held (runtime overlay on A or C), Z gone.

import { effectiveStatus, isAdmitted, isKicked, seatOf, type GameRecord, type LogFacts } from "./gameRecord";

export type Role = "U" | "V" | "O" | "M" | "S" | "H";
export type Stage = "W" | "A" | "C" | "Hd" | "Z";

export type RoomOp =
  | "read-view"
  | "read-log"
  | "join"
  | "take-seat"
  | "release-seat"
  | "leave"
  | "set-ready"
  | "set-profile"
  | "set-visibility"
  | "rotate-code"
  | "start-game"
  | "submit"
  | "chat"
  | "presence"
  | "kick"
  | "transfer-host"
  | "cancel-room"
  | "clock-pause"
  | "clock-resume";

export interface AuthzContext {
  /** `null`: no such game. */
  record: GameRecord | null;
  facts: LogFacts;
  /** `null`: unauthenticated. */
  principalId: string | null;
  now: number;
  /** The runtime hold overlay (the loaded engine does not support the deal's pin). */
  held: boolean;
}

export type AuthzCode = "not-found" | "gone" | "forbidden" | "not-seated" | "wrong-state";

export type AuthzResult =
  | { readonly ok: true; readonly role: Role; readonly stage: Stage }
  | { readonly ok: false; readonly code: AuthzCode; readonly reason: string; readonly role: Role; readonly stage: Stage };

const R = (...roles: Role[]) => roles;

/** THE TABLE (§6.3 / §6.4): per op, which roles may act in which stage. An op absent from a stage is `wrong-state`
 *  for a role allowed elsewhere; a role allowed nowhere is `forbidden` (or `not-seated`). */
export const AUTHZ_TABLE: Readonly<Record<RoomOp, { stages: Partial<Record<Stage, readonly Role[]>>; denial: "forbidden" | "not-seated" }>> = Object.freeze({
  /* #5 read the room view, chat, presence: public any; private seated (any status) or admitted while waiting. */
  "read-view": { stages: { W: R("V", "M", "S", "H"), A: R("V", "S", "H"), C: R("V", "S", "H"), Hd: R("V", "S", "H") }, denial: "forbidden" },
  /* #6 read the game log: as #5. */
  "read-log": { stages: { W: R("V", "M", "S", "H"), A: R("V", "S", "H"), C: R("V", "S", "H"), Hd: R("V", "S", "H") }, denial: "forbidden" },
  /* #8 join by code: waiting (a seat or admission), or a public game as a viewer. The code is the authorization, so
     an outsider O may present it; being already seated is `ok`. */
  join: { stages: { W: R("V", "O", "M", "S", "H"), A: R("V", "S", "H"), Hd: R("V", "S", "H") }, denial: "forbidden" },
  /* #9 take a seat: public any viewer, private an admitted member; waiting only. Already seated: `ok`. */
  "take-seat": { stages: { W: R("V", "M", "S", "H") }, denial: "forbidden" },
  /* #10 release a seat: waiting only (a dealt seat is never abandoned). */
  "release-seat": { stages: { W: R("S", "H") }, denial: "forbidden" },
  /* #11 leave: waiting releases seat and admission; later only unsubscribes. */
  leave: { stages: { W: R("V", "M", "S", "H"), A: R("V", "S", "H"), C: R("V", "S", "H"), Hd: R("V", "S", "H") }, denial: "forbidden" },
  /* #13 / #14 own seat, waiting. */
  "set-ready": { stages: { W: R("S", "H") }, denial: "forbidden" },
  "set-profile": { stages: { W: R("S", "H") }, denial: "forbidden" },
  /* #16 / #17 / #28 the host, waiting. */
  "set-visibility": { stages: { W: R("H") }, denial: "forbidden" },
  "rotate-code": { stages: { W: R("H") }, denial: "forbidden" },
  "cancel-room": { stages: { W: R("H") }, denial: "forbidden" },
  /* #18 start: the host, waiting, not held. */
  "start-game": { stages: { W: R("H") }, denial: "forbidden" },
  /* #19 / #25-27 gameplay (RevertTo, OpenStockRound, CloseRoom included): seated only, once dealt. Hd is answered
     `incompatible` by the session; C admits only what the board admits (CloseRoom; RV-3 refuses RevertTo). */
  submit: { stages: { A: R("S", "H"), C: R("S", "H"), Hd: R("S", "H") }, denial: "not-seated" },
  /* #21 chat: seated only (OD-L2-4: spectators never chat). */
  chat: { stages: { W: R("S", "H"), A: R("S", "H"), C: R("S", "H"), Hd: R("S", "H") }, denial: "forbidden" },
  /* #22 presence: seated, waiting or active. */
  presence: { stages: { W: R("S", "H"), A: R("S", "H") }, denial: "forbidden" },
  /* #23 kick: the host, waiting. */
  kick: { stages: { W: R("H") }, denial: "forbidden" },
  /* #24 transfer host: the host, waiting or active (held included: it never interprets the log). */
  "transfer-host": { stages: { W: R("H"), A: R("H"), Hd: R("H") }, denial: "forbidden" },
  /* Phase 3 lane A (AUD-11.04): pause / resume the gameplay CLOCK (never gameplay): the host, while the game is being
     played and not held. Who may pause is an owner decision still open; the host -- the table's existing authority for
     undo, kick and transfer -- is the conservative default, and no pause cap is applied (none is approved). */
  "clock-pause": { stages: { A: R("H") }, denial: "forbidden" },
  "clock-resume": { stages: { A: R("H") }, denial: "forbidden" },
});

/** The caller's role in this game, from the record alone. */
export function roleOf(record: GameRecord, principalId: string | null): Role {
  if (principalId === null) return "U";
  const seat = seatOf(record, principalId);
  if (seat !== null) return seat.player_id === record.host_player_id ? "H" : "S";
  if (record.visibility === "private") return isAdmitted(record, principalId) && !isKicked(record, principalId) ? "M" : "O";
  return "V";
}

/** The stage the game is in: the log first, then the record's lifecycle, then the hold overlay. */
export function stageOf(record: GameRecord, facts: LogFacts, now: number, held: boolean): Stage {
  if (record.archived_at !== null) return "Z";
  const status = effectiveStatus(record, facts, now);
  if (status === "cancelled" || status === "expired") return "Z";
  if (status === "waiting") return "W";
  if (held) return "Hd";
  return status === "active" ? "A" : "C";
}

const SENTENCES: Record<AuthzCode, string> = {
  "not-found": "There is no such game.",
  gone: "That game is over and gone.",
  forbidden: "You cannot do that in this game.",
  "not-seated": "You do not have a seat in this game.",
  "wrong-state": "That cannot be done at this point in the game.",
};

const refuse = (code: AuthzCode, role: Role, stage: Stage): AuthzResult => ({ ok: false, code, reason: SENTENCES[code], role, stage });

export function authorize(op: RoomOp, ctx: AuthzContext): AuthzResult {
  if (ctx.record === null) return refuse("not-found", "U", "Z");
  const record = ctx.record;
  const stage = stageOf(record, ctx.facts, ctx.now, ctx.held);
  let role = roleOf(record, ctx.principalId);
  /* A private room's admitted member loses read access at the deal (§7.3): from then on they are an outsider. */
  if (role === "M" && stage !== "W") role = "O";
  /* 4. RESOLVE: an outsider of a private room learns nothing -- the same answer as a game that does not exist. Only
        a join, whose code is the invitation, gets past this while the room waits. */
  if (role === "O" && !(op === "join" && stage === "W")) return refuse("not-found", role, stage);
  if (stage === "Z") return refuse("gone", role, stage);
  if (role === "U") return refuse("forbidden", role, stage);
  /* 5. ROLE, then 6. STAGE */
  const row = AUTHZ_TABLE[op];
  const anywhere = Object.values(row.stages).some((roles) => (roles ?? []).includes(role));
  if (!anywhere) return refuse(row.denial, role, stage);
  if (!(row.stages[stage] ?? []).includes(role)) return refuse("wrong-state", role, stage);
  return { ok: true, role, stage };
}
