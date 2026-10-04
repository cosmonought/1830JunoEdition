/** @jest-environment node */
//
// ==================================================================
//  PHASE 3 W3-J: THE ROOM LINK'S ANSWERS (AUD-25.06 resync, AUD-25.07 unaddressed internal error)
// ==================================================================
//
// AUD-25.06 (with W3-C's accepted LOW (b)): a resync settled every submission on the wire `null` at once and raised the
//   stale sentence ("this tab has caught up. Try that again.") beside the resync notice ("reloading the room's
//   history") -- two contradictory sentences, about a move that may have landed (the shell then rolled back a landed
//   move's state). Now the sent submissions are orphans the fresh catch-up reconciles: landed resolves with its index;
//   only one that did not land resolves `null`, and the stale sentence comes after the tab has caught up.
// AUD-25.07: a server `internal` error with no `inReplyTo` left the submission pending until the next reconnect. Now the
//   link asks the room (a hello on the same socket) and the catch-up settles it; the sentence is a refusal.
//
// Everything here drives the REAL `connectServerLink` through an injected socket.

export {};

const { connectServerLink } = require("./serverLink") as typeof import("./serverLink");
type SocketLike = import("./serverLink").SocketLike;

const BUILD = "build-1";
const DIGEST = "0".repeat(16);
const entry = (index: number, submissionId?: string) => ({
  index,
  id: `e${index}`,
  actor: "p-alice",
  payload: "{}",
  ...(submissionId ? { submission_id: submissionId } : {}),
});

function harness() {
  const sent: Array<Record<string, unknown>> = [];
  const events: string[] = [];
  const socket: SocketLike = {
    send: (data) => sent.push(JSON.parse(data) as Record<string, unknown>),
    close: () => socket.onclose?.({}),
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  };
  let ids = 0;
  const link = connectServerLink({
    url: "ws://test",
    gameId: "g_0123456789abcdefghjkmnpqr0",
    build: BUILD,
    socketFactory: () => socket,
    mintSubmissionId: () => `n${(ids += 1)}`,
    onEntries: (entries) => events.push(`entries:${entries.map((item) => item.index).join(",")}`),
    onRefused: (reason) => events.push(`refused:${reason}`),
    onStale: () => events.push("stale"),
    onResync: () => events.push("resync"),
    onError: (message) => events.push(`error:${message}`),
  });
  socket.onopen?.({});
  const deliver = (frame: unknown) => socket.onmessage?.({ data: JSON.stringify(frame) });
  // The hello's catch-up: the room holds e0, e1.
  deliver({ kind: "catch-up", build: BUILD, digest: DIGEST, entries: [entry(0), entry(1)] });
  events.length = 0;
  const hellos = () => sent.filter((frame) => frame.kind === "hello");
  return { link, sent, events, deliver, hellos };
}

/** Resolves on the next macrotask; a settled promise's value, or "pending". */
async function peek<T>(promise: Promise<T>): Promise<T | "pending"> {
  return Promise.race([promise, new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 0))]);
}

describe("W3-J AUD-25.06: a resync does not settle what was on the wire, and says one thing at a time", () => {
  it("a submission that LANDED resolves with its index after the fresh catch-up -- never refused, no stale sentence", async () => {
    const h = harness();
    const move = h.link.submit({ BuyStock: { game_id: 0 } } as never);
    // The room says this tab's history is not its own (an unaddressed `resync` error at a push, say).
    h.deliver({ kind: "error", code: "resync", reason: "history mismatch" });
    expect(h.events).toEqual(["resync"]); // the resync notice alone -- no stale refusal beside it
    expect(await peek(move)).toBe("pending");
    expect(h.hellos().at(-1)).toMatchObject({ kind: "hello", baseIndex: -1 });
    // The fresh catch-up: the whole log, and the move is in it (it landed before the resync).
    h.deliver({ kind: "catch-up", build: BUILD, digest: DIGEST, entries: [entry(0), entry(1), entry(2, "n1")] });
    expect(await move).toBe(2);
    expect(h.events).not.toContain("stale");
    expect(h.link.queue.unsettled).toBe(0);
  });

  it("a submission that did NOT land resolves null, and the stale sentence comes only after the tab has caught up", async () => {
    const h = harness();
    const move = h.link.submit({ BuyStock: { game_id: 0 } } as never);
    // The submit itself is answered `ahead` -- refused before it ran.
    h.deliver({ kind: "refused", code: "ahead", reason: "ahead of the room", build: BUILD, inReplyTo: "n1" });
    expect(h.events).toEqual(["resync"]);
    expect(await peek(move)).toBe("pending");
    h.deliver({ kind: "catch-up", build: BUILD, digest: DIGEST, entries: [entry(0), entry(1)] });
    expect(await move).toBeNull();
    expect(h.events).toEqual(["resync", "entries:0,1", "stale"]);
  });

  it("a submission the room is still committing stays pending (in flight), then lands", async () => {
    const h = harness();
    const move = h.link.submit({ BuyStock: { game_id: 0 } } as never);
    h.deliver({ kind: "error", code: "resync", reason: "history mismatch" });
    h.deliver({ kind: "catch-up", build: BUILD, digest: DIGEST, entries: [entry(0), entry(1)], inFlight: ["n1"] });
    expect(await peek(move)).toBe("pending");
    h.deliver({ kind: "applied", build: BUILD, digest: DIGEST, entries: [entry(2, "n1")] });
    expect(await move).toBe(2);
    expect(h.events).not.toContain("stale");
  });
});

describe("W3-J AUD-25.07: an `internal` error that names no submission does not leave one pending", () => {
  it("the link asks the room (a hello from where it stands) and the catch-up settles a move that did not land", async () => {
    const h = harness();
    const move = h.link.submit({ BuyStock: { game_id: 0 } } as never);
    const helloCount = h.hellos().length;
    h.deliver({ kind: "error", code: "internal", reason: "The server could not process that request." });
    // The sentence answers this tab's action: a refusal (the next landed move retires it), not a `transport` notice.
    expect(h.events).toEqual(["refused:The server could not process that request."]);
    expect(h.hellos()).toHaveLength(helloCount + 1);
    expect(h.hellos().at(-1)).toMatchObject({ kind: "hello", baseIndex: 1, baseId: "e1" });
    expect(await peek(move)).toBe("pending");
    expect(h.link.queue.unsettled).toBe(1);
    h.deliver({ kind: "catch-up", build: BUILD, digest: DIGEST, entries: [] });
    expect(await move).toBeNull();
    // Not followed by the stale sentence: the error's own sentence already explained it.
    expect(h.events).not.toContain("stale");
    expect(h.link.queue.unsettled).toBe(0);
  });

  it("a move that WAS committed before the throw resolves with its index -- an accepted move is never reported refused", async () => {
    const h = harness();
    const move = h.link.submit({ BuyStock: { game_id: 0 } } as never);
    h.deliver({ kind: "error", code: "internal", reason: "The server could not process that request." });
    h.deliver({ kind: "catch-up", build: BUILD, digest: DIGEST, entries: [entry(2, "n1")] });
    expect(await move).toBe(2);
  });

  it("a later submission answered in its own turn is not swept up in the reconciliation", async () => {
    const h = harness();
    const first = h.link.submit({ BuyStock: { game_id: 0 } } as never);
    const second = h.link.submit({ PassTurn: { game_id: 0 } } as never);
    h.deliver({ kind: "error", code: "internal", reason: "The server could not process that request." });
    // The server handled the second submit before the hello: its own answer arrives first.
    h.deliver({ kind: "applied", build: BUILD, digest: DIGEST, entries: [entry(2, "n2")], inReplyTo: "n2" });
    expect(await second).toBe(2);
    h.deliver({ kind: "catch-up", build: BUILD, digest: DIGEST, entries: [entry(2, "n2")] });
    expect(await first).toBeNull();
  });

  it("with nothing on the wire, or while a hello is outstanding, the error is the link's notice, as before -- and no second hello", () => {
    const h = harness();
    const helloCount = h.hellos().length;
    h.deliver({ kind: "error", code: "internal", reason: "The server could not process that request." });
    expect(h.events).toEqual(["error:The server could not process that request."]);
    expect(h.hellos()).toHaveLength(helloCount);
  });

  it("an `internal` answer to the reconciling hello itself is not answered with another hello (no loop)", () => {
    const h = harness();
    void h.link.submit({ BuyStock: { game_id: 0 } } as never);
    h.deliver({ kind: "error", code: "internal", reason: "boom" });
    const helloCount = h.hellos().length;
    h.deliver({ kind: "error", code: "internal", reason: "boom again" });
    expect(h.hellos()).toHaveLength(helloCount);
    expect(h.events).toEqual(["refused:boom", "error:boom again"]);
  });

  it("an error that NAMES its submission is settled exactly as before", async () => {
    const h = harness();
    const move = h.link.submit({ BuyStock: { game_id: 0 } } as never);
    const helloCount = h.hellos().length;
    h.deliver({ kind: "error", code: "internal", reason: "say hello first", inReplyTo: "n1" });
    expect(await move).toBeNull();
    expect(h.hellos()).toHaveLength(helloCount);
  });
});
