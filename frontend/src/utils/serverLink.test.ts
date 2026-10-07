/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 1212 (harness): THE CLIENT HALF, WITHOUT A SOCKET
// ==================================================================
//
// `smokeTest.ts` proves a real socket carries a real frame to a real room. What it cannot do cheaply is the
// awkward orderings -- a dispatch made before the connection opens, a burst of three answered out of turn, a
// socket that closes with work outstanding. Those get a fake socket and exact control here.
//
// THE PROPERTY WORTH MOST is that a caller's promise always settles. A `submit` that never resolves is a
// button that stays disabled forever, which is indistinguishable to a player from the game having crashed --
// and it is exactly what a lost frame or a closed socket would cause if nobody had thought about it.

export {};

const { connectServerLink } = require("./serverLink") as typeof import("./serverLink");

type SocketLike = import("./serverLink").SocketLike;

/** LIVE-2D: the link is keyed by the server-minted game id, never a room code. */
const GAME = "g_0123456789abcdefghjkmnpqr0";

/** A socket the test drives by hand. */
function fakeSocket() {
  const sent: string[] = [];
  const socket: SocketLike = {
    send: (data) => sent.push(data),
    close: () => socket.onclose?.({}),
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  };
  return {
    socket,
    sent,
    frames: () => sent.map((text) => JSON.parse(text) as Record<string, unknown>),
    open: () => socket.onopen?.({}),
    deliver: (frame: unknown) => socket.onmessage?.({ data: JSON.stringify(frame) }),
    drop: () => socket.onclose?.({}),
    closeWith: (code: number) => socket.onclose?.({ code }),
  };
}

function link(over: Partial<Parameters<typeof connectServerLink>[0]> = {}) {
  const wire = fakeSocket();
  const entries: unknown[][] = [];
  const refusals: string[] = [];
  const errors: string[] = [];
  let ids = 0;
  const client = connectServerLink({
    url: "ws://test",
    gameId: GAME,
    build: "build-1",
    onEntries: (batch) => entries.push([...batch]),
    onRefused: (reason) => refusals.push(reason),
    onError: (message) => errors.push(message),
    socketFactory: () => wire.socket,
    mintSubmissionId: () => `n${(ids += 1)}`,
    ...over,
  });
  return { client, wire, entries, refusals, errors };
}

const entry = (index: number, over: Record<string, unknown> = {}) => ({
  index,
  id: `e${index}`,
  actor: "p-alice",
  payload: "{}",
  ...over,
});

describe("connecting", () => {
  it("says hello with the game id, the build and what it has applied -- and no identity (LIVE-2B: that is the upgrade's)", () => {
    const { wire } = link();
    wire.open();
    expect(wire.frames()[0]).toMatchObject({
      kind: "hello",
      gameId: GAME,
      build: "build-1",
      baseIndex: -1,
    });
    /* LIVE-2D: no room code, no claim, no seat PIN, no seat token -- who this socket is was settled at the upgrade,
       and which seat it plays is the server's to derive for every move. */
    for (const field of ["room", "claim", "pin", "token", "playerId", "actor"]) {
      expect(wire.frames()[0]).not.toHaveProperty(field);
    }
  });

  it("never names an actor on a submission: the server derives who moved (LIVE-2D)", () => {
    const { client, wire } = link();
    wire.open();
    void client.submit({ PassTurn: { game_id: 0 } } as never);
    const submit = wire.frames().find((frame) => frame.kind === "submit") as Record<string, unknown>;
    expect(Object.keys(submit).sort()).toEqual(["baseIndex", "build", "kind", "msg", "submissionId"]);
    for (const field of ["actor", "playerId", "claim", "pin", "token", "room"]) expect(submit).not.toHaveProperty(field);
  });

  it("holds a dispatch made before the socket opens, and sends it after hello", () => {
    /* A REAL CASE, NOT A HYPOTHETICAL: nothing stops a player clicking while the connection is still being
       made, and a submission dropped on the floor there would look like a button that did nothing. */
    const { client, wire } = link();
    void client.submit({ PassTurn: { game_id: 0 } } as never);
    expect(wire.frames()).toHaveLength(0);

    wire.open();
    const frames = wire.frames();
    expect(frames[0].kind).toBe("hello");
    expect(frames[1]).toMatchObject({ kind: "submit", submissionId: "n1", baseIndex: -1 });
  });
});

describe("applying what comes back", () => {
  it("hands entries to the reducer and resolves the caller with its index", async () => {
    const { client, wire, entries } = link();
    wire.open();
    const pending = client.submit({ PassTurn: { game_id: 0 } } as never);
    wire.deliver({
      kind: "applied",
      build: "build-1",
      digest: "0".repeat(16),
      entries: [entry(0, { submission_id: "n1" })],
      inReplyTo: "n1",
    });
    await expect(pending).resolves.toBe(0);
    expect(entries).toEqual([[entry(0, { submission_id: "n1" })]]);
  });

  it("applies another player's move without resolving anything", async () => {
    /* THE WATCHER CASE ARRIVES AS THE SAME FRAME (#1210: the fan-out carries what was appended, because it
       is the same news). The queue is what tells them apart -- and a client with nothing outstanding must
       not consume a promise that does not exist. */
    const { client, wire, entries } = link();
    wire.open();
    wire.deliver({
      kind: "applied",
      build: "build-1",
      digest: "0".repeat(16),
      entries: [entry(0)],
    });
    expect(entries).toHaveLength(1);
    expect(client.appliedIndex).toBe(0);
  });

  it("tracks the applied index so the next submission says where it is", async () => {
    const { client, wire } = link();
    wire.open();
    wire.deliver({
      kind: "applied",
      build: "build-1",
      digest: "0".repeat(16),
      entries: [entry(0), entry(1)],
    });
    void client.submit({ PassTurn: { game_id: 0 } } as never);
    const last = wire.frames()[wire.frames().length - 1];
    expect(last).toMatchObject({ kind: "submit", baseIndex: 1 });
  });
});

describe("a burst, each answer naming its own submission", () => {
  it("resolves three submissions with their own indices", async () => {
    /* THE SHELL DISPATCHES IN LOOPS (#941 records why), so several are outstanding at once and each caller
       is waiting for ITS index. LIVE-2D: the answer's `inReplyTo` is the mechanism -- the FIFO fallback for a
       server older than LIVE-3A is deleted. */
    const { client, wire } = link();
    wire.open();
    const a = client.submit({ PassTurn: { game_id: 0 } } as never);
    const b = client.submit({ PassTurn: { game_id: 0 } } as never);
    const c = client.submit({ PassTurn: { game_id: 0 } } as never);

    for (const [n, id] of [[0, "n1"], [1, "n2"], [2, "n3"]] as const) {
      wire.deliver({
        kind: "applied",
        build: "build-1",
        digest: "0".repeat(16),
        entries: [entry(n, { submission_id: id })],
        inReplyTo: id,
      });
    }
    await expect(Promise.all([a, b, c])).resolves.toEqual([0, 1, 2]);
  });

  it("an answer naming a submission this client does not hold resolves nobody else's", async () => {
    /* Resolving anyway would hand this reply's index to a different dispatch -- a board disagreeing with its own
       log. With FIFO gone the link cannot even be tempted: an answer settles exactly the submission it names. */
    const { client, wire } = link();
    wire.open();
    const first = client.submit({ PassTurn: { game_id: 0 } } as never);
    let settled = false;
    void first.then(() => {
      settled = true;
    });
    wire.deliver({
      kind: "applied",
      build: "build-1",
      digest: "0".repeat(16),
      entries: [entry(0, { submission_id: "n9" })],
      inReplyTo: "n9",
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    wire.deliver({ kind: "applied", build: "build-1", digest: "0".repeat(16), entries: [entry(1, { submission_id: "n1" })], inReplyTo: "n1" });
    await expect(first).resolves.toBe(1);
  });
});

describe("the answers that are not an application", () => {
  it("passes a refusal to the player and settles the caller with null", async () => {
    /* `null`, NOT A THROW -- `appendSandboxAction`'s contract, so the shell's existing "the append did not
       happen" branch keeps working and the cutover stays a swap. */
    const { client, wire, refusals } = link();
    wire.open();
    const pending = client.submit({ PassTurn: { game_id: 0 } } as never);
    wire.deliver({ kind: "refused", build: "build-1", reason: "It is not your turn.", inReplyTo: "n1" });
    await expect(pending).resolves.toBeNull();
    expect(refusals).toEqual(["It is not your turn."]);
  });

  it("settles a retry answered with a catch-up, using this client's own entry", async () => {
    /* #1209 answers a duplicate submission with a catch-up rather than an application. The caller is still
       waiting, and its move DID land -- so it gets the index its own entry carries. */
    const { client, wire } = link();
    wire.open();
    /* #1253: THE HELLO IS ANSWERED FIRST, always -- the server reads frames in order -- and that answer is a
       catch-up too. The link reads the first catch-up after a hello as the hello's, so a test that skipped it
       would have its submission's answer taken for the hello's; the real wire never does that. */
    wire.deliver({ kind: "catch-up", build: "build-1", digest: "0".repeat(16), entries: [] });
    const pending = client.submit({ PassTurn: { game_id: 0 } } as never);
    wire.deliver({
      kind: "catch-up",
      build: "build-1",
      digest: "0".repeat(16),
      entries: [entry(0, { submission_id: "n1" })],
      inReplyTo: "n1",
    });
    await expect(pending).resolves.toBe(0);
  });

  it("reports a build skew and does not leave the caller waiting", async () => {
    const skews: Array<[string, string]> = [];
    const { client, wire } = link({
      onBuildSkew: (clientBuild, serverBuild) => skews.push([clientBuild, serverBuild]),
    });
    wire.open();
    const pending = client.submit({ PassTurn: { game_id: 0 } } as never);
    wire.deliver({ kind: "build-skew", clientBuild: "build-1", serverBuild: "build-2", inReplyTo: "n1" });
    await expect(pending).resolves.toBeNull();
    expect(skews).toEqual([["build-1", "build-2"]]);
  });
});

describe("a socket that closes with work outstanding", () => {
  it("settles everything when the LINK is closed on purpose", async () => {
    /* A PROMISE THAT NEVER SETTLES IS A GAME THAT LOOKS CRASHED. And `null` is the honest answer here: #1209
       says the append is the commit point, so the move may well have landed -- "this client did not see it
       applied" is a different claim from "it did not happen", and only the first one is being made.
       #1253: THIS IS NOW THE `close()` CASE ONLY. A socket that drops on its own is reconnected, and what was
       in flight is settled by the hello's catch-up instead -- see the block below. */
    const { client, wire } = link();
    wire.open();
    const a = client.submit({ PassTurn: { game_id: 0 } } as never);
    const b = client.submit({ PassTurn: { game_id: 0 } } as never);
    client.close();
    await expect(Promise.all([a, b])).resolves.toEqual([null, null]);
  });
});

describe("reconnection, #1253", () => {
  /* The factory hands back the same fake socket each time, so a "new socket" is the old object re-wired --
     which is enough: what is under test is the link's bookkeeping across the boundary, not the browser's. */
  const reconnecting = () => {
    const scheduled: Array<{ callback: () => void; delayMs: number }> = [];
    const statuses: string[] = [];
    const stale: number[] = [];
    const made = link({
      schedule: (callback, delayMs) => scheduled.push({ callback, delayMs }),
      onStatus: (status) => statuses.push(status),
      onStale: () => stale.push(1),
    });
    const fire = () => {
      const next = scheduled.shift();
      if (!next) throw new Error("nothing scheduled");
      next.callback();
    };
    return { ...made, scheduled, statuses, stale, fire };
  };
  const catchUp = (entries: unknown[]) => ({ kind: "catch-up", build: "build-1", digest: "0".repeat(16), entries });

  it("reconnects after a backoff and says hello with what it has applied", () => {
    const { wire, scheduled, statuses, fire } = reconnecting();
    wire.open();
    wire.deliver(catchUp([entry(0), entry(1)]));
    wire.sent.length = 0;

    wire.drop();
    expect(statuses).toEqual(["reconnecting"]);
    expect(scheduled[0].delayMs).toBe(500);
    fire();
    wire.open();
    expect(wire.frames()[0]).toMatchObject({ kind: "hello", baseIndex: 1 });
    expect(statuses).toEqual(["reconnecting", "open"]);
  });

  it("backs off, doubling to a cap, and stops once closed on purpose", () => {
    const { client, wire, scheduled, fire } = reconnecting();
    wire.open();
    const delays: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      wire.drop();
      delays.push(scheduled[0].delayMs);
      fire();
    }
    expect(delays).toEqual([500, 1000, 2000, 4000, 8000, 8000]);
    client.close();
    wire.drop();
    expect(scheduled).toHaveLength(0);
  });

  it("a move that was in the air and LANDED resolves with its index from the hello's catch-up", async () => {
    const { client, wire, fire, stale } = reconnecting();
    wire.open();
    wire.deliver(catchUp([]));
    const flying = client.submit({ PassTurn: { game_id: 0 } } as never);
    wire.drop();
    fire();
    wire.open();
    // The server had applied it before the wire went; the catch-up carries it with this client's nonce.
    wire.deliver(catchUp([entry(0, { submission_id: "n1" })]));
    await expect(flying).resolves.toBe(0);
    expect(stale).toHaveLength(0);
  });

  it("a move that was in the air and DID NOT land resolves null as stale, and is never re-sent", async () => {
    const { client, wire, fire, stale } = reconnecting();
    wire.open();
    wire.deliver(catchUp([]));
    const flying = client.submit({ PassTurn: { game_id: 0 } } as never);
    wire.drop();
    fire();
    wire.sent.length = 0;
    wire.open();
    wire.deliver(catchUp([entry(0, { actor: "p-bob" })])); // somebody else moved; ours is not there
    await expect(flying).resolves.toBeNull();
    expect(stale).toHaveLength(1);
    expect(wire.frames().filter((frame) => frame.kind === "submit")).toHaveLength(0);
  });

  it("a move queued while the wire was down is sent behind the hello with the current baseIndex", async () => {
    const { client, wire, fire } = reconnecting();
    wire.open();
    wire.deliver(catchUp([entry(0)]));
    wire.drop();
    const queued = client.submit({ PassTurn: { game_id: 0 } } as never);
    expect(wire.frames().filter((frame) => frame.kind === "submit")).toHaveLength(0);
    fire();
    wire.sent.length = 0;
    wire.open();
    const frames = wire.frames();
    expect(frames[0].kind).toBe("hello");
    expect(frames[1]).toMatchObject({ kind: "submit", submissionId: "n1", baseIndex: 0 });
    // The hello's catch-up settles nothing of this one; its own answer does.
    wire.deliver(catchUp([]));
    wire.deliver({ kind: "applied", build: "build-1", digest: "0".repeat(16), entries: [entry(1, { submission_id: "n1" })], inReplyTo: "n1" });
    await expect(queued).resolves.toBe(1);
  });
});

describe("a batch says whether it is live or history, #1238", () => {
  /* REPORTED: one player got the private-payout modal at the round change and the other did not. The shell
     decided "is this live play?" by COUNTING new entries -- `pending === 1` -- which was Firestore's proxy and
     is wrong on the server path, where a settle-point burst is several entries and the drain coalesces frames.
     The link knows which frame kind carried a batch; now it says so, and the shell stops counting. */
  const sources = () => {
    const seen: string[] = [];
    const made = link({ onEntries: (_batch, _digest, _fields, source) => seen.push(source) });
    return { ...made, seen };
  };

  it("marks an applied frame as live", () => {
    const { wire, seen } = sources();
    wire.open();
    wire.deliver({ kind: "applied", entries: [entry(0)], digest: "d", build: "build-1" });
    expect(seen).toEqual(["applied"]);
  });

  it("marks a catch-up as history, even when it carries only one entry", () => {
    /* THE CASE THE OLD PROXY GOT BACKWARDS: a reconnect that missed exactly one action would have counted as
       live play and announced a minutes-old event as news. */
    const { wire, seen } = sources();
    wire.open();
    wire.deliver({ kind: "catch-up", entries: [entry(0)], digest: "d", build: "build-1" });
    expect(seen).toEqual(["catch-up"]);
  });

  it("marks a multi-entry applied burst as live, which is the case that was being silenced", () => {
    const { wire, seen } = sources();
    wire.open();
    wire.deliver({
      kind: "applied",
      entries: [entry(0), entry(1, { derived: true }), entry(2, { derived: true })],
      digest: "d",
      build: "build-1",
    });
    expect(seen).toEqual(["applied"]);
  });
});

/* ==================================================================
    LIVE-3A (L3-3): THE ANSWER NAMES ITS SUBMISSION
   ==================================================================
   The server now runs a room's submissions one at a time, so another player's fan-out reaches this socket BEFORE
   this client's own queued answer -- deterministically. FIFO then took the other player's index for this
   client's move (LIVE-3 P4). A LIVE-3A server marks its hello answer with `inFlight`; from then on a frame WITH
   `inReplyTo` settles exactly that submission and a frame without one is history. */
describe("LIVE-3A: answers are matched by the submission they name", () => {
  const PASS = { PassTurn: { game_id: 0 } } as never;
  const digest = "0".repeat(16);
  const hello = (entries: unknown[] = [], inFlight: string[] = []) => ({ kind: "catch-up", build: "build-1", digest, entries, inFlight });
  const applied = (entries: unknown[], inReplyTo?: string) => ({
    kind: "applied",
    build: "build-1",
    digest,
    entries,
    ...(inReplyTo === undefined ? {} : { inReplyTo }),
  });
  const live = (over: Partial<Parameters<typeof connectServerLink>[0]> = {}) => {
    const scheduled: Array<() => void> = [];
    const stale: number[] = [];
    const resyncs: string[] = [];
    const statuses: Array<[string, string | undefined]> = [];
    const made = link({
      schedule: (callback) => scheduled.push(callback),
      onStale: () => stale.push(1),
      onResync: (reason) => resyncs.push(reason),
      onRoomStatus: (state, reason) => statuses.push([state, reason]),
      ...over,
    });
    const reconnect = () => {
      made.wire.drop();
      const next = scheduled.shift();
      if (!next) throw new Error("nothing scheduled");
      next();
      made.wire.sent.length = 0;
      made.wire.open();
    };
    return { ...made, stale, resyncs, statuses, reconnect };
  };
  const settledYet = async (promise: Promise<unknown>) => {
    let done = false;
    void promise.then(() => {
      done = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    return done;
  };

  it("P4: another player's fan-out that arrives first does not resolve this client's submission", async () => {
    const { client, wire, errors, stale } = live();
    wire.open();
    wire.deliver(hello([entry(0)]));
    const mine = client.submit(PASS); // n1, sent from index 0
    // Alice's move committed first, so her fan-out reaches this socket before the answer to n1.
    const alices = entry(1, { actor: "p-alice", submission_id: "alice-7" });
    wire.deliver(applied([alices]));
    expect(await settledYet(mine)).toBe(false);
    // The real answer: n1 was behind. It names n1 and resolves exactly it.
    wire.deliver({ kind: "catch-up", build: "build-1", digest, entries: [alices], inReplyTo: "n1" });
    await expect(mine).resolves.toBeNull();
    expect(stale).toEqual([1]);
    expect(errors).toEqual([]); // no "out of order": nothing is out of order any more
  });

  it("settles each submission by the id its answer names, in whatever order the answers arrive", async () => {
    const { client, wire, refusals } = live();
    wire.open();
    wire.deliver(hello());
    const a = client.submit(PASS);
    const b = client.submit(PASS);
    const c = client.submit(PASS);
    wire.deliver(applied([entry(1, { submission_id: "n2" })], "n2"));
    wire.deliver({ kind: "refused", build: "build-1", reason: "It is not your turn.", inReplyTo: "n3" });
    wire.deliver(applied([entry(0, { submission_id: "n1" })], "n1"));
    await expect(Promise.all([a, b, c])).resolves.toEqual([0, 1, null]);
    expect(refusals).toEqual(["It is not your turn."]);
  });

  it("a frame that names no submission is history and settles nothing", async () => {
    const { client, wire, entries } = live();
    wire.open();
    wire.deliver(hello());
    const mine = client.submit(PASS);
    wire.deliver(applied([entry(0, { actor: "p-bob", submission_id: "bob-1" })]));
    wire.deliver({ kind: "refused", build: "build-1", reason: "an answer to nobody" });
    expect(await settledYet(mine)).toBe(false);
    expect(entries.flat()).toEqual([entry(0, { actor: "p-bob", submission_id: "bob-1" })]);
    wire.deliver(applied([entry(1, { submission_id: "n1" })], "n1"));
    await expect(mine).resolves.toBe(1);
  });

  it("names the anchor: every submit and the next hello carry the id of the entry at baseIndex", () => {
    const { client, wire, reconnect } = live();
    wire.open();
    expect(wire.frames()[0]).toMatchObject({ kind: "hello", baseIndex: -1 });
    expect(wire.frames()[0].baseId).toBeUndefined();
    wire.deliver(hello([entry(0), entry(1)]));
    void client.submit(PASS);
    expect(wire.frames()[wire.frames().length - 1]).toMatchObject({ kind: "submit", baseIndex: 1, baseId: "e1" });
    reconnect();
    expect(wire.frames()[0]).toMatchObject({ kind: "hello", baseIndex: 1, baseId: "e1" });
  });

  it("a stale answer's catch-up does not hand the shell entries it already has", () => {
    const { client, wire, entries } = live();
    wire.open();
    wire.deliver(hello([entry(0)]));
    void client.submit(PASS);
    wire.deliver(applied([entry(1, { actor: "p-bob" })])); // the move that made n1 stale
    wire.deliver({ kind: "catch-up", build: "build-1", digest, entries: [entry(1, { actor: "p-bob" })], inReplyTo: "n1" });
    expect(entries).toEqual([[entry(0)], [entry(1, { actor: "p-bob" })], []]);
  });

  it("only an identical entry ID is a duplicate: the same index with a DIFFERENT id is handed on, never dropped", () => {
    const { wire, entries } = live();
    wire.open();
    wire.deliver(hello([entry(0), entry(1)]));
    // The very same entry again (same id): suppressed -- it would be applied twice.
    wire.deliver(applied([entry(1)]));
    // A DIFFERENT entry claiming index 1 is not a duplicate. It is a divergence the shell must see (its id-prefix
    // check rebuilds), so it is delivered -- a client never silently keeps one history because the index matched.
    const other = entry(1, { id: "e1-other", actor: "p-bob" });
    wire.deliver(applied([other]));
    expect(entries).toEqual([[entry(0), entry(1)], [], [other]]);
  });

  it("a reconnect keeps an IN-FLIGHT submission pending, and settles it when its entry lands", async () => {
    const { client, wire, stale, reconnect } = live();
    wire.open();
    wire.deliver(hello());
    const flying = client.submit(PASS);
    reconnect();
    // The server is still committing n1: not in the catch-up, but named in `inFlight`.
    wire.deliver(hello([], ["n1"]));
    expect(await settledYet(flying)).toBe(false);
    expect(stale).toEqual([]);
    expect(wire.frames().filter((frame) => frame.kind === "submit")).toHaveLength(0); // never re-sent
    // It lands: the fan-out (no inReplyTo -- this socket did not send it) carries its entry.
    wire.deliver(applied([entry(0, { submission_id: "n1" })]));
    await expect(flying).resolves.toBe(0);
    expect(stale).toEqual([]);
  });

  it("an in-flight submission that ends without committing is `abandoned`: null, and the board is current", async () => {
    const { client, wire, stale, reconnect } = live();
    wire.open();
    wire.deliver(hello());
    const flying = client.submit(PASS);
    reconnect();
    wire.deliver(hello([], ["n1"]));
    wire.deliver({ kind: "abandoned", inReplyTo: "n1", reason: "not recorded" });
    await expect(flying).resolves.toBeNull();
    expect(stale).toEqual([1]);
  });

  it("an orphan the server does NOT call in flight is settled by the catch-up as before", async () => {
    const { client, wire, stale, reconnect } = live();
    wire.open();
    wire.deliver(hello());
    const flying = client.submit(PASS);
    reconnect();
    wire.deliver(hello([], []));
    await expect(flying).resolves.toBeNull();
    expect(stale).toEqual([1]);
  });

  it("`unavailable` keeps the submission pending until the room resumes and says whether it landed", async () => {
    const { client, wire, refusals, statuses } = live();
    wire.open();
    wire.deliver(hello());
    const unsure = client.submit(PASS);
    wire.deliver({ kind: "refused", build: "build-1", code: "unavailable", reason: "could not confirm", inReplyTo: "n1" });
    wire.deliver({ kind: "status", state: "unavailable", reason: "paused" });
    expect(await settledYet(unsure)).toBe(false);
    expect(refusals).toEqual(["could not confirm"]);
    wire.deliver(applied([entry(0, { submission_id: "n1" })]));
    wire.deliver({ kind: "status", state: "live" });
    await expect(unsure).resolves.toBe(0);
    expect(statuses).toEqual([
      ["unavailable", "paused"],
      ["live", undefined],
    ]);
  });

  it("`ahead`: the history is dropped, the link rejoins from -1 on the same socket, and the fresh catch-up settles what was pending", async () => {
    /* PHASE 3 W3-J (AUD-25.06): what was on the wire is no longer settled `null` AT the resync (with the stale sentence
       beside the resync notice) -- each is an orphan the fresh catch-up reconciles, so a move that landed resolves with
       its index (`phase3W3JLink.test.ts`). Here neither is in the fresh history, so both resolve null after it. */
    const { client, wire, stale, resyncs, entries } = live();
    wire.open();
    wire.deliver(hello([entry(0), entry(1)]));
    const a = client.submit(PASS);
    const b = client.submit(PASS);
    wire.sent.length = 0;
    wire.deliver({ kind: "refused", build: "build-1", code: "ahead", watermark: 0, reason: "ahead", inReplyTo: "n1" });
    expect(await settledYet(a)).toBe(false);
    expect(stale).toEqual([]);
    expect(resyncs).toEqual(["ahead"]);
    expect(client.resyncs).toBe(1);
    expect(client.appliedIndex).toBe(-1);
    expect(wire.frames()).toHaveLength(1);
    expect(wire.frames()[0]).toMatchObject({ kind: "hello", baseIndex: -1 });
    expect(wire.frames()[0].baseId).toBeUndefined();
    // Anything before the fresh catch-up is in it, so it is dropped rather than applied twice.
    const before = entries.length;
    wire.deliver(applied([entry(1)]));
    wire.deliver({ kind: "refused", build: "build-1", reason: "late", inReplyTo: "n2" });
    expect(entries).toHaveLength(before);
    // The fresh catch-up is the room's history, delivered whole -- including ids delivered before the resync.
    wire.deliver(hello([entry(0)]));
    expect(entries[entries.length - 1]).toEqual([entry(0)]);
    expect(client.appliedIndex).toBe(0);
    await expect(Promise.all([a, b])).resolves.toEqual([null, null]);
    expect(stale.length).toBeGreaterThan(0); // said once the tab has caught up, not beside the resync notice
  });

  it("a hello answered `error{code:\"resync\"}` takes the same path", () => {
    const { client, wire, resyncs, reconnect } = live();
    wire.open();
    wire.deliver(hello([entry(0), entry(1)]));
    // A reconnect's hello names index 1 and its anchor; the room no longer holds that history.
    reconnect();
    expect(wire.frames()[0]).toMatchObject({ kind: "hello", baseIndex: 1, baseId: "e1" });
    wire.sent.length = 0;
    wire.deliver({ kind: "error", code: "resync", reason: "diverged", watermark: 0 });
    expect(resyncs).toEqual(["diverged"]);
    expect(client.appliedIndex).toBe(-1);
    expect(wire.frames()[0]).toMatchObject({ kind: "hello", baseIndex: -1 });
    wire.deliver(hello([entry(0)]));
    expect(client.appliedIndex).toBe(0);
  });

  it("LIVE-2D: a hello answer without `inFlight` does not bring FIFO back -- an unnamed answer is still history", async () => {
    /* The fallback for a server older than LIVE-3A is DELETED: every server this client can reach names the
       submission it answers, so a frame without `inReplyTo` never settles anybody's move. */
    const { client, wire } = live();
    wire.open();
    wire.deliver({ kind: "catch-up", build: "build-1", digest, entries: [] });
    const first = client.submit(PASS);
    wire.deliver(applied([entry(0, { submission_id: "n1" })]));
    expect(await settledYet(first)).toBe(false);
    wire.deliver(applied([entry(1, { submission_id: "n1" })], "n1"));
    await expect(first).resolves.toBe(1);
  });
});

/* ==================================================================
    LIVE-2D: ACCESS LOST IS TERMINAL
   ==================================================================
   A server that says this tab may not read the game (`not-found`, `gone`, `forbidden`, `room-full` at the hello, or
   a 4410 close when access is removed mid-game) is answered once, through `onAccessLost`, and the link stops: a
   reconnect would earn the same answer, so looping on it is the one wrong response. */
describe("LIVE-2D: access lost is terminal", () => {
  const PASS = { PassTurn: { game_id: 0 } } as never;
  const terminal = () => {
    const scheduled: Array<() => void> = [];
    const lost: Array<[string, string]> = [];
    const made = link({
      schedule: (callback) => scheduled.push(callback),
      onAccessLost: (code, reason) => lost.push([code, reason]),
    });
    return { ...made, scheduled, lost };
  };

  it.each(["not-found", "gone", "forbidden", "room-full"])("a hello refused `%s` is said once, settles what was pending, and never reconnects", async (code) => {
    const { client, wire, scheduled, lost, errors } = terminal();
    wire.open();
    const pending = client.submit(PASS);
    wire.deliver({ kind: "error", code, reason: "You cannot read that game." });
    await expect(pending).resolves.toBeNull();
    expect(lost).toEqual([[code, "You cannot read that game."]]);
    expect(errors).toEqual([]);
    // The close that follows is ours: nothing is scheduled, and a second refusal is not said twice.
    wire.drop();
    wire.deliver({ kind: "error", code, reason: "again" });
    expect(scheduled).toHaveLength(0);
    expect(lost).toHaveLength(1);
  });

  it("a 4410 close mid-game (kicked, cancelled, a private deal without this tab) is terminal too", async () => {
    const { client, wire, scheduled, lost } = terminal();
    wire.open();
    wire.deliver({ kind: "catch-up", build: "build-1", digest: "0".repeat(16), entries: [entry(0)] });
    const pending = client.submit(PASS);
    wire.closeWith(4410);
    await expect(pending).resolves.toBeNull();
    expect(lost).toEqual([["not-found", "You no longer have access to this game."]]);
    expect(scheduled).toHaveLength(0);
  });

  it("an ordinary drop still reconnects -- only a refusal of ACCESS stops the link", () => {
    const { wire, scheduled, lost } = terminal();
    wire.open();
    wire.closeWith(1006);
    expect(scheduled).toHaveLength(1);
    expect(lost).toEqual([]);
  });

  it("a refusal that is not about access is reported and is not terminal", () => {
    const { wire, scheduled, lost, errors } = terminal();
    wire.open();
    wire.deliver({ kind: "error", code: "bad-frame", reason: "The server did not accept that request." });
    expect(lost).toEqual([]);
    expect(errors).toEqual(["The server did not accept that request."]);
    wire.drop();
    expect(scheduled).toHaveLength(1);
  });
});

describe("Phase 3 final clocks (owner ruling, 2026-10-07): a long history is caught up in pages", () => {
  it("says it reassembles pages in its hello", () => {
    const { wire } = link();
    wire.open();
    expect(wire.frames()[0]).toMatchObject({ kind: "hello", pages: 1 });
  });

  it("holds every page, then hands the WHOLE catch-up over once -- in order, as history, with the last page's digest -- and settles a submission that landed in an early page", async () => {
    const digests: Array<string | null> = [];
    const sources: string[] = [];
    const { client, wire, entries } = link({
      onEntries: (batch, digest, _fields, source) => {
        entries.push([...batch]);
        digests.push(digest);
        sources.push(source);
      },
    });
    const pending = client.submit({ PassTurn: { game_id: 0 } } as never);
    wire.open();
    wire.drop(); // the move was on the wire when the socket dropped: the next hello's catch-up settles it
    wire.open();
    wire.deliver({ kind: "catch-up", entries: [entry(0), entry(1, { submission_id: "n1", actor: "p-alice" })], digest: "", build: "b", more: true });
    wire.deliver({ kind: "catch-up", entries: [entry(2), entry(3)], digest: "", build: "b", more: true });
    expect(entries).toHaveLength(0);
    wire.deliver({ kind: "catch-up", entries: [entry(4)], digest: "d-final", build: "b", inFlight: [] });
    expect(entries).toEqual([[entry(0), entry(1, { submission_id: "n1", actor: "p-alice" }), entry(2), entry(3), entry(4)]]);
    expect(digests).toEqual(["d-final"]);
    expect(sources).toEqual(["catch-up"]);
    await expect(pending).resolves.toBe(1);
    /* The next hello names the last entry of the reassembled history. */
    wire.drop();
    wire.open();
    const hellos = wire.frames().filter((frame) => frame.kind === "hello");
    expect(hellos[hellos.length - 1]).toMatchObject({ baseIndex: 4, baseId: "e4", pages: 1 });
  });

  it("drops the pages of a catch-up cut off with its socket: the next hello's catch-up is taken whole, never appended to a fragment", () => {
    const { wire, entries } = link();
    wire.open();
    wire.deliver({ kind: "catch-up", entries: [entry(0), entry(1)], digest: "", build: "b", more: true });
    wire.drop();
    wire.open();
    wire.deliver({ kind: "catch-up", entries: [entry(0), entry(1), entry(2)], digest: "d", build: "b", inFlight: [] });
    expect(entries).toEqual([[entry(0), entry(1), entry(2)]]);
  });

  it("REVIEW: pages that answer a submission while a resync is pending are dropped WHOLE with their answer -- never put in front of the resync's own catch-up", () => {
    const { client, wire, entries } = link();
    wire.open();
    wire.deliver({ kind: "catch-up", entries: [entry(0), entry(1), entry(2)], digest: "d0", build: "build-1", inFlight: [] });
    const PASS = { PassTurn: { game_id: 0 } } as never;
    void client.submit(PASS);
    void client.submit(PASS);
    wire.deliver({ kind: "refused", build: "build-1", code: "ahead", watermark: 0, reason: "ahead", inReplyTo: "n1" });
    /* n2's answer: a long stale-submit catch-up, in pages, its answer on the last page. */
    wire.deliver({ kind: "catch-up", entries: [entry(3), entry(4)], digest: "", build: "build-1", more: true });
    wire.deliver({ kind: "catch-up", entries: [entry(5)], digest: "d5", build: "build-1", inReplyTo: "n2", inFlight: [] });
    const before = entries.length;
    /* The resync's own catch-up, in pages too: delivered in order, exactly once. */
    wire.deliver({ kind: "catch-up", entries: [entry(0), entry(1), entry(2)], digest: "", build: "build-1", more: true });
    wire.deliver({ kind: "catch-up", entries: [entry(3), entry(4), entry(5)], digest: "d5", build: "build-1", inFlight: [] });
    expect(entries.length).toBe(before + 1);
    expect((entries[entries.length - 1] as Array<{ index: number }>).map((e) => e.index)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(client.appliedIndex).toBe(5);
  });

  it("a short history is still one frame (no page)", () => {
    const { wire, entries } = link();
    wire.open();
    wire.deliver({ kind: "catch-up", entries: [entry(0)], digest: "d", build: "b", inFlight: [] });
    expect(entries).toEqual([[entry(0)]]);
  });
});
