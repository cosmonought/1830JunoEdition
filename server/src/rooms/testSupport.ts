// server/src/rooms/testSupport.ts
//
// LIVE-3A test support: a store the test controls, a raw socket client, and a probe session. Used by the
// `node --test` suites beside it (`npm test` in server/, after `npm run build`). Not imported by the server.

import { WebSocket } from "ws";

import { createGameServer, type GameServerOptions } from "../gameServer";
import type { LogStore } from "../fileLogStore";
import { StoreDefiniteError } from "../persistence/storeResult";
import { RoomSession, type ServerLogEntry } from "../../../frontend/src/utils/roomSession";
import {
  DEFAULT_SANDBOX_SCENARIO,
  sandboxReplayProviders,
  sandboxScenario,
  sandboxScenarioState,
  sandboxWaterfallState,
  waterfallForRoster,
  withEmptyRoster,
} from "../../../frontend/src/gameEngine";
import type { SandboxRoomDoc } from "../../../frontend/src/utils/sandboxRoom";

export const BUILD = "live3a-build";
export const ALICE = "p-alice";
export const BOB = "p-bob";
export const CAROL = "p-carol";
export const SETUP = {
  SetupGame: {
    players: [
      { id: ALICE, nickname: "Alice" },
      { id: BOB, nickname: "Bob" },
    ],
    variants: {},
  },
};
/** The seat on turn buys the cheapest private: legal for Alice after the deal, then Bob, then Alice... */
export const BUY = { WaterfallBuyLowest: { game_id: 0 } };
export const PASS = { PassTurn: { game_id: 0 } };

/** The server says a great deal in its window; a test only needs it when something is being debugged. */
export function quietConsole(): void {
  if (process.env.LIVE3A_VERBOSE === "1") return;
  const silent = () => undefined;
  console.log = silent;
  console.warn = silent;
  console.error = silent;
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function until(predicate: () => boolean, label: string, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(2);
  }
}

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export interface HeldAppend {
  room: string;
  entries: readonly ServerLogEntry[];
  release(): void;
  /** Reject the append. LIVE-3B: without `landed` it is a DEFINITE failure (nothing reached storage); with
   *  `landed` the entries are put in the store first and the rejection is UNCERTAIN (bytes reached the file, then an
   *  error the store could not settle by its redo). */
  fail(landed?: boolean): void;
}

export interface HeldSave {
  room: string;
  doc: SandboxRoomDoc;
  release(): void;
  /** A definite failure (before the rename): the previous document stands. */
  fail(): void;
}

/** An in-memory `LogStore` whose every call the test can hold, fail or slow. Its log only ever grows, exactly
 *  like a file: an entry that is in it has been "on disk" since it arrived. */
export function controlledStore() {
  const logs = new Map<string, ServerLogEntry[]>();
  const docs = new Map<string, string>();
  const calls = { loadLog: 0, appendLog: 0, loadRoomDoc: 0, saveRoomDoc: 0 };
  const control = {
    holdAppends: false,
    holdSaves: false,
    /** Immediate append failures, in order: `landed: false` is definite, `landed: true` uncertain (LIVE-3B). */
    failAppends: [] as Array<{ landed: boolean }>,
    /** Definite room-document failures (before the rename). */
    failSaves: 0,
    /** Uncertain room-document failures (after the rename), which the actor holds for a restart. */
    failSavesUncertain: 0,
    failLoads: 0,
    loadDelayMs: 0,
  };
  const heldAppends: HeldAppend[] = [];
  const heldSaves: HeldSave[] = [];
  const land = (room: string, entries: readonly ServerLogEntry[]) =>
    logs.set(room, [...(logs.get(room) ?? []), ...copy(entries)]);

  const store: LogStore = {
    async loadLog(room) {
      calls.loadLog += 1;
      if (control.loadDelayMs > 0) await sleep(control.loadDelayMs);
      if (control.failLoads > 0) {
        control.failLoads -= 1;
        throw new Error("injected read failure");
      }
      return copy(logs.get(room) ?? []);
    },
    appendLog(room, entries) {
      calls.appendLog += 1;
      if (control.holdAppends) {
        return new Promise<void>((resolve, reject) => {
          heldAppends.push({
            room,
            entries: copy(entries),
            release: () => {
              land(room, entries);
              resolve();
            },
            fail: (landed = false) => {
              if (landed) land(room, entries);
              reject(landed ? new Error("injected uncertain append failure") : new StoreDefiniteError("injected append failure"));
            },
          });
        });
      }
      const failure = control.failAppends.shift();
      if (failure) {
        if (failure.landed) land(room, entries);
        return Promise.reject(
          failure.landed ? new Error("injected uncertain append failure") : new StoreDefiniteError("injected append failure"),
        );
      }
      land(room, entries);
      return Promise.resolve();
    },
    async loadRoomDoc(room) {
      calls.loadRoomDoc += 1;
      const text = docs.get(room);
      return text === undefined ? null : (JSON.parse(text) as SandboxRoomDoc);
    },
    saveRoomDoc(room, doc) {
      calls.saveRoomDoc += 1;
      if (control.holdSaves) {
        return new Promise<void>((resolve, reject) => {
          heldSaves.push({
            room,
            doc: copy(doc),
            release: () => {
              docs.set(room, JSON.stringify(doc));
              resolve();
            },
            fail: () => reject(new StoreDefiniteError("injected save failure")),
          });
        });
      }
      if (control.failSaves > 0) {
        control.failSaves -= 1;
        return Promise.reject(new StoreDefiniteError("injected save failure"));
      }
      if (control.failSavesUncertain > 0) {
        // The rename landed, then an error the store could not settle: the new document IS stored.
        control.failSavesUncertain -= 1;
        docs.set(room, JSON.stringify(doc));
        return Promise.reject(new Error("injected uncertain save failure"));
      }
      docs.set(room, JSON.stringify(doc));
      return Promise.resolve();
    },
    async listRooms() {
      return [...docs.keys()];
    },
  };

  return {
    store,
    logs,
    docs,
    calls,
    control,
    heldAppends,
    heldSaves,
    log: (room: string): ServerLogEntry[] => logs.get(room) ?? [],
    indices: (room: string): number[] => (logs.get(room) ?? []).map((entry) => entry.index),
    doc: (room: string): SandboxRoomDoc | null => {
      const text = docs.get(room);
      return text === undefined ? null : (JSON.parse(text) as SandboxRoomDoc);
    },
    async nextHeldAppend(): Promise<HeldAppend> {
      await until(() => heldAppends.length > 0, "a held append");
      return heldAppends.shift() as HeldAppend;
    },
    async nextHeldSave(): Promise<HeldSave> {
      await until(() => heldSaves.length > 0, "a held room-document save");
      return heldSaves.shift() as HeldSave;
    },
  };
}

/** Believes the claim, without shouting about it on every connection. */
export const quietIdentity: GameServerOptions["resolveIdentity"] = async ({ claim }) =>
  typeof claim === "string" && claim !== "" ? claim : null;

export async function startServer(over: Partial<GameServerOptions> = {}) {
  const server = createGameServer({ port: 0, build: BUILD, resolveIdentity: quietIdentity, ...over });
  const port = await new Promise<number>((resolve) => {
    const read = () => {
      const address = server.http.address();
      resolve(typeof address === "object" && address !== null ? address.port : 0);
    };
    if (server.http.listening) read();
    else server.http.once("listening", read);
  });
  return { server, port };
}

export interface Frame {
  kind: string;
  [key: string]: unknown;
}

export interface SeenEntry {
  index: number;
  id: string;
  submission_id?: string;
  actor: string;
}

/** Every client a test opened and has not closed, so a failed assertion cannot leave a socket that keeps the
 *  server's `close()` waiting (it closes the LOG sockets it knows; a room-doc socket would hold `http.close`). */
const openClients = new Set<Client>();

/** Stop a server started by `startServer`, closing every client still open first. */
export async function stopServer(server: { close(): Promise<void> }): Promise<void> {
  for (const client of [...openClients]) client.socket.terminate();
  openClients.clear();
  await server.close();
}

/** A raw socket client: records every frame in order. */
export class Client {
  readonly frames: Frame[] = [];
  private cursor = 0;

  private constructor(
    readonly socket: WebSocket,
    readonly claim: string,
  ) {}

  static open(port: number, claim: string): Promise<Client> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}`);
      const client = new Client(socket, claim);
      openClients.add(client);
      socket.on("close", () => openClients.delete(client));
      socket.on("message", (raw) => client.frames.push(JSON.parse(String(raw)) as Frame));
      socket.once("error", reject);
      socket.once("open", () => resolve(client));
    });
  }

  send(frame: object): void {
    this.socket.send(JSON.stringify(frame));
  }

  hello(room: string, baseIndex = -1, baseId?: string): void {
    this.send({ kind: "hello", room, build: BUILD, claim: this.claim, baseIndex, ...(baseId ? { baseId } : {}) });
  }

  submit(msg: object, over: { baseIndex: number; submissionId?: string; baseId?: string }): void {
    this.send({ kind: "submit", build: BUILD, msg, ...over });
  }

  roomHello(room: string): void {
    this.send({ kind: "room-hello", room, build: BUILD, claim: this.claim });
  }

  roomWrite(room: string, write: object): void {
    this.send({ kind: "room-write", room, write });
  }

  /** The next frame after the cursor that matches, waiting for it if it has not arrived. */
  async next(predicate: (frame: Frame) => boolean = () => true, label = "a frame"): Promise<Frame> {
    const find = () => this.frames.findIndex((frame, at) => at >= this.cursor && predicate(frame));
    await until(() => find() !== -1, `${label} for ${this.claim} (saw ${this.frames.map((f) => f.kind).join(",")})`);
    const at = find();
    this.cursor = at + 1;
    return this.frames[at];
  }

  /** The direct answer to one submission. */
  answerTo(submissionId: string): Promise<Frame> {
    return this.next((frame) => frame.inReplyTo === submissionId, `the answer to ${submissionId}`);
  }

  of(kind: string): Frame[] {
    return this.frames.filter((frame) => frame.kind === kind);
  }

  /** Every entry this client has been handed, in arrival order, from every frame that carries entries. */
  seen(): SeenEntry[] {
    const out: SeenEntry[] = [];
    for (const frame of this.frames) {
      const batches: unknown[] = [];
      if (frame.kind === "applied" || frame.kind === "catch-up") batches.push(frame.entries);
      if (frame.kind === "refused" && frame.catchUp) batches.push((frame.catchUp as { entries: unknown }).entries);
      for (const batch of batches) for (const entry of (batch as SeenEntry[]) ?? []) out.push(entry);
    }
    return out;
  }

  get open(): boolean {
    return this.socket.readyState === WebSocket.OPEN;
  }

  close(): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) return Promise.resolve();
    return new Promise((resolve) => {
      this.socket.once("close", () => resolve());
      this.socket.close();
    });
  }
}

/** A session built exactly as the server builds one, for computing logs and boards outside it. */
export function probeSession(tag = "probe"): RoomSession {
  let n = 0;
  return new RoomSession({
    providers: sandboxReplayProviders(),
    seed: {
      state: withEmptyRoster(sandboxScenarioState(DEFAULT_SANDBOX_SCENARIO, 0, "default")),
      waterfall: waterfallForRoster(sandboxWaterfallState(sandboxScenario(DEFAULT_SANDBOX_SCENARIO).phase, 0, true), []),
    },
    build: BUILD,
    mintId: () => `${tag}-${(n += 1)}`,
    now: () => 1_000 + n,
  });
}

/** A stored log: the deal, and `buys` purchases alternating from the first seat. */
export function storedLog(buys = 0): ServerLogEntry[] {
  const session = probeSession("stored");
  session.submit({ actor: ALICE, build: BUILD, msg: SETUP as never, baseIndex: -1, submissionId: "stored-deal" });
  for (let n = 0; n < buys; n += 1) {
    const seat = session.state.player_addresses[n % 2];
    const result = session.submit({ actor: seat, build: BUILD, msg: BUY as never, baseIndex: session.nextIndex - 1, submissionId: `stored-buy-${n}` });
    if (result.kind !== "applied") throw new Error(`stored buy ${n} was ${result.kind}`);
  }
  return [...session.entries];
}
