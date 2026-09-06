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
  it("settles everything rather than leaving buttons disabled forever", async () => {
    /* A PROMISE THAT NEVER SETTLES IS A GAME THAT LOOKS CRASHED. And `null` is the honest answer here: #1209
       says the append is the commit point, so the move may well have landed -- "this client did not see it
       applied" is a different claim from "it did not happen", and only the first one is being made. */
    const { client, wire } = link();
    wire.open();
    const a = client.submit({ PassTurn: { game_id: 0 } } as never);
    const b = client.submit({ PassTurn: { game_id: 0 } } as never);
    wire.drop();
    await expect(Promise.all([a, b])).resolves.toEqual([null, null]);
  });
});
