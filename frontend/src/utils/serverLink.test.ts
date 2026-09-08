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
    room: "ROOM",
    build: "build-1",
    claim: "p-alice",
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
  it("says hello with the room, the build and what it has applied", () => {
    const { wire } = link();
    wire.open();
    expect(wire.frames()[0]).toMatchObject({
      kind: "hello",
      room: "ROOM",
      build: "build-1",
      claim: "p-alice",
      baseIndex: -1,
    });
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

describe("a burst, answered in order", () => {
  it("resolves three submissions with their own indices", async () => {
    /* THE SHELL DISPATCHES IN LOOPS (#941 records why), so several are outstanding at once and each caller
       is waiting for ITS index. FIFO is the mechanism; the nonce is the check. */
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
      });
    }
    await expect(Promise.all([a, b, c])).resolves.toEqual([0, 1, 2]);
  });

  it("reports rather than shrugs when a reply arrives out of order", async () => {
    /* IF THE ORDERING ASSUMPTION EVER BREAKS, resolving anyway hands this reply's index to a different
       dispatch -- a board disagreeing with its own log, and the hardest possible thing to trace back. */
    const { client, wire, errors } = link();
    wire.open();
    const first = client.submit({ PassTurn: { game_id: 0 } } as never);
    wire.deliver({
      kind: "applied",
      build: "build-1",
      digest: "0".repeat(16),
      entries: [entry(0, { submission_id: "n9" })],
    });
    await first;
    expect(errors.join(" ")).toContain("out of order");
  });
});

describe("the answers that are not an application", () => {
  it("passes a refusal to the player and settles the caller with null", async () => {
    /* `null`, NOT A THROW -- `appendSandboxAction`'s contract, so the shell's existing "the append did not
       happen" branch keeps working and the cutover stays a swap. */
    const { client, wire, refusals } = link();
    wire.open();
    const pending = client.submit({ PassTurn: { game_id: 0 } } as never);
    wire.deliver({ kind: "refused", build: "build-1", reason: "It is not your turn." });
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
    wire.deliver({ kind: "build-skew", clientBuild: "build-1", serverBuild: "build-2" });
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
    wire.deliver({ kind: "applied", build: "build-1", digest: "0".repeat(16), entries: [entry(1, { submission_id: "n1" })] });
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
