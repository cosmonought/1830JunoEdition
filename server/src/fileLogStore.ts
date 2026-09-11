// server/src/fileLogStore.ts
//
// A room's history on disk: one append-only file per room, synced before anybody is told.
//
// ==================================================================
//  DESIGN NOTE 1250: THE APPEND IS THE COMMIT POINT, SO THE APPEND HAS TO REACH A DISK
// ==================================================================
//
// #1209 made the append the commit point and the response news: "a move whose answer was lost has still
// happened." That was true of memory. `start.ts` said in as many words that "a restart starts an empty room",
// and the audit (§7, triage 3.3a) named it: "a restart erases a money game ... or 'the append is the commit
// point' is a claim about memory." This is the store that makes it a claim about a file.
//
// ONE FILE PER ROOM, ONE LINE PER ENTRY, APPENDED AND SYNCED. JSON Lines rather than a rewritten document,
// because the log is append-only by construction (#1026, #1233: a revert is an entry, not an erasure) and a
// store that rewrote the whole history on every move would have a window in which the file held half a game.
// `fsync` before the promise resolves, because a write the operating system is still holding in a buffer is
// exactly the memory this note is about. The server awaits this BEFORE it answers the submitter and before
// it fans out (#1250 in `gameServer.ts`), so no client ever applies an entry the disk does not have.
//
// THE ROOM DOCUMENT GOES IN A SIDECAR, REWRITTEN WHOLE. It is last-write-wins and never replayed (#1215), so a
// rewrite is its natural shape; and without it a restart would restore a game whose roster nobody could
// name -- host, nicknames and colours live there. Written to a temporary name and renamed, so a crash
// mid-write leaves the previous document rather than half of the new one.
//
// NOT FIRESTORE, AND DELIBERATELY SO. The migration plan had Firestore as "the log's home" for Phase 2, and
// the playtests have been running with Firestore unreachable (the console's `Cross-Origin Request Blocked`
// lines) -- a store that cannot be reached is not a store. A directory on the machine the server runs on is
// reachable by definition, survives a restart, and is what the operator can `cat`. The seam is the same
// three functions either way; a Firestore-backed one implements this interface when there is a reason to.
//
// WHAT THIS DOES NOT DO: it does not make the file tamper-evident (that is 2.5f's hash), does not sign
// anything (2.5b), and does not replicate. A disk on one machine is durability against a process dying,
// which is the failure that has actually happened.

import { promises as fs } from "fs";
import * as path from "path";

import type { ServerLogEntry } from "../../frontend/src/utils/roomSession";
import type { SandboxRoomDoc } from "../../frontend/src/utils/sandboxRoom";
import type { RoomChatEntry } from "../../frontend/src/utils/roomDocLink";
import type { StagingRoomRecord } from "../../frontend/src/utils/lobbyProtocol";

export interface LogStore {
  /** Everything appended to this room so far, in file order. Empty for a room never written. */
  loadLog(room: string): Promise<readonly ServerLogEntry[]>;
  /** Resolves only once the entries are on disk and synced. Rejects if they are not. */
  appendLog(room: string, entries: readonly ServerLogEntry[]): Promise<void>;
  loadRoomDoc(room: string): Promise<SandboxRoomDoc | null>;
  saveRoomDoc(room: string, doc: SandboxRoomDoc): Promise<void>;
  /** Design note #1355: every room this store holds a document for, so a seat can be found by its PIN
   *  without the player naming the room. Optional: an in-memory store answers with what it has. */
  listRooms?(): Promise<readonly string[]>;
  /* ==================================================================
      DESIGN NOTE 1361: THE TRANSCRIPT AND THE STAGING LOBBY, ON THE SAME DISK
     ==================================================================
     Chat left Firestore for the server (#1361a). A playtest spans hours and the server restarts between
     fixes, so a transcript held only in memory would vanish on every rebuild -- which is exactly the moment a
     table is asking each other "did you see my last message". One append-only sidecar per room, the log's
     shape (`<code>.chat.jsonl`), unsynced: a lost chat line is not a lost move.
     The staging lobby (#1361b) is one small document rewritten whole, like the room document. Optional on
     the interface, because the in-memory store the tests and the smoke run use has no reason to keep either. */
  loadChat?(room: string): Promise<readonly RoomChatEntry[]>;
  appendChat?(room: string, entry: RoomChatEntry): Promise<void>;
  loadLobby?(): Promise<readonly StagingRoomRecord[]>;
  saveLobby?(records: readonly StagingRoomRecord[]): Promise<void>;
}

/** A room code becomes a file name. Codes are `JUNO-XXX` in practice; anything else is reduced to a safe
 *  character set so a code cannot name a path outside the directory. */
function safeName(room: string): string {
  const cleaned = room.replace(/[^A-Za-z0-9_-]/g, "_");
  return cleaned === "" ? "_" : cleaned;
}

export function createFileLogStore(directory: string): LogStore {
  const logPath = (room: string) => path.join(directory, `${safeName(room)}.log.jsonl`);
  const docPath = (room: string) => path.join(directory, `${safeName(room)}.room.json`);
  const chatPath = (room: string) => path.join(directory, `${safeName(room)}.chat.jsonl`);
  const lobbyPath = path.join(directory, "lobby.json");

  const ready = fs.mkdir(directory, { recursive: true });

  return {
    async loadLog(room) {
      await ready;
      let text: string;
      try {
        text = await fs.readFile(logPath(room), "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
      const entries: ServerLogEntry[] = [];
      for (const line of text.split("\n")) {
        if (line.trim() === "") continue;
        /* A LINE THAT DOES NOT PARSE STOPS THE LOAD, LOUDLY. It is the tail of a file the process died while
           writing (the sync below makes that a partial LAST line at worst), and everything before it is
           whole. Loading the whole part and refusing the rest is the honest reading; silently skipping a
           middle line would hand the reducer a history with a hole in it. */
        try {
          entries.push(JSON.parse(line) as ServerLogEntry);
        } catch {
          break;
        }
      }
      return entries;
    },

    async appendLog(room, entries) {
      if (entries.length === 0) return;
      await ready;
      const handle = await fs.open(logPath(room), "a");
      try {
        await handle.write(entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
        await handle.sync();
      } finally {
        await handle.close();
      }
    },

    async listRooms() {
      await ready;
      const names = await fs.readdir(directory);
      return names.filter((name) => name.endsWith(".room.json")).map((name) => name.slice(0, -".room.json".length));
    },
    async loadRoomDoc(room) {
      await ready;
      try {
        return JSON.parse(await fs.readFile(docPath(room), "utf8")) as SandboxRoomDoc;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },

    async saveRoomDoc(room, doc) {
      await ready;
      const target = docPath(room);
      const temporary = `${target}.tmp`;
      await fs.writeFile(temporary, JSON.stringify(doc), "utf8");
      await fs.rename(temporary, target);
    },

    async loadChat(room) {
      await ready;
      let text: string;
      try {
        text = await fs.readFile(chatPath(room), "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
      const entries: RoomChatEntry[] = [];
      for (const line of text.split("\n")) {
        if (line.trim() === "") continue;
        try {
          entries.push(JSON.parse(line) as RoomChatEntry);
        } catch {
          break; // a partial last line, as with the log
        }
      }
      return entries;
    },

    async appendChat(room, entry) {
      await ready;
      await fs.appendFile(chatPath(room), `${JSON.stringify(entry)}\n`, "utf8");
    },

    async loadLobby() {
      await ready;
      try {
        const parsed = JSON.parse(await fs.readFile(lobbyPath, "utf8")) as unknown;
        return Array.isArray(parsed) ? (parsed as StagingRoomRecord[]) : [];
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
    },

    async saveLobby(records) {
      await ready;
      const temporary = `${lobbyPath}.tmp`;
      await fs.writeFile(temporary, JSON.stringify(records), "utf8");
      await fs.rename(temporary, lobbyPath);
    },
  };
}
