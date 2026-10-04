/** @jest-environment jsdom */
/**
 * Phase 3 W3-I — queued-submission visibility and form retention.
 *
 *   AUD-19.01 (I-1 / R4)  the forms show that a submission is still queued on the link, and take no second press:
 *                         a read-only queue accessor on `serverLink.ts`, one hook (`useLinkQueue`), outside the drain.
 *   AUD-02.05 (I-1)       the B&O par: a press queued while the link reconnects is never followed by a second press.
 *   AUD-02.06 (I-2)       "not reached the table yet" fires only after the landing signal says the press did NOT land.
 *   AUD-03.11 (R4)        the typed offer form is kept until the proposal lands.
 *
 * Everything runs against the REAL link (`connectServerLink`) over a hand-driven socket, read through the REAL hook --
 * the shell's own composition -- so "queued", "held" and "landed" are the link's answers, never a test's invention.
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { AuctionPromptModal, PAR_NOT_LANDED_NOTE, PAR_SEND_HOLD_MS, PAR_SETTLE_GRACE_MS } from "./AuctionPromptModal";
import { ModalLayerHost } from "./ModalPortal";
import { PrivateCompaniesSection } from "./PrivateCompaniesSection";
import { ProposePrivatePurchase } from "./PrivateTradePanel";
import TrainPurchasePanel, { type TrainPurchaseCompany } from "./TrainPurchasePanel";
import type { GameStateResponse } from "../gameEngine/gameState";
import { depotInventory, openDepotTiers } from "../gameEngine/gamePhase";
import {
  connectServerLink,
  getActiveLinkQueue,
  IDLE_LINK_QUEUE,
  type LinkQueueState,
  type SocketLike,
} from "../utils/serverLink";
import { IDLE_LINK_QUEUE_VIEW, LINK_QUEUED_NOTE, LINK_SENDING_NOTE, linkQueueView, useLinkQueue } from "../utils/useLinkQueue";
import { BO, CA, DH, MH, NYC, operatingBoard, P1, P2, P3, PRR, stockRoundBoard } from "../utils/offerFixtures74";
import { apply, M } from "../utils/offerMatrix74Support";
import { privateTradeProposalRefusal, privateTradeSectionModel } from "../utils/stockRoundPrivateTrade";
import { privateProposalRefusal, trainOfferRefusal } from "../utils/offerAuthorityView";
import { readStripped, sliceBetween } from "../utils/sourceScan";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
global.IS_REACT_ACT_ENVIRONMENT = true;

const LABELS: Record<string, string> = { [P1]: "Ann", [P2]: "Ben", [P3]: "Cy" };
const labelFor = (address: string) => LABELS[address] ?? address;
const noop = () => undefined;

/* ---- a real link over hand-driven sockets ------------------------------------------------------------------------ */

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
    frames: () => sent.map((text) => JSON.parse(text) as Record<string, unknown>),
    open: () => socket.onopen?.({}),
    deliver: (frame: unknown) => socket.onmessage?.({ data: JSON.stringify(frame) }),
    drop: () => socket.onclose?.({}),
  };
}
const entry = (index: number, over: Record<string, unknown> = {}) => ({ index, id: `e${index}`, actor: "p-ann", payload: "{}", ...over });

/** A link whose sockets are made on demand and whose reconnect timer the test fires by hand. */
function roomLink() {
  const wires: Array<ReturnType<typeof fakeSocket>> = [];
  const timers: Array<() => void> = [];
  let ids = 0;
  const client = connectServerLink({
    url: "ws://test",
    gameId: "g_0123456789abcdefghjkmnpqr0",
    build: "build-1",
    onEntries: noop,
    socketFactory: () => {
      const wire = fakeSocket();
      wires.push(wire);
      return wire.socket;
    },
    mintSubmissionId: () => `n${(ids += 1)}`,
    schedule: (callback) => {
      timers.push(callback);
    },
  });
  const wire = () => wires[wires.length - 1];
  /** Fire the pending reconnect and open the new socket. */
  const reconnect = () => {
    const due = timers.splice(0);
    for (const callback of due) callback();
    act(() => wire().open());
  };
  return { client, wire, reconnect, wires };
}
const submits = (wire: ReturnType<typeof fakeSocket>) => wire.frames().filter((frame) => frame.kind === "submit");

let links: Array<{ close(): void }> = [];
afterEach(() => {
  for (const link of links) act(() => link.close());
  links = [];
});
function live() {
  const made = roomLink();
  links.push(made.client);
  return made;
}

/* ================================================================================================================ */
describe("AUD-19.01: a read-only queue accessor on the link, outside the drain", () => {
  it("reports queued (unsent) while the socket is down, in flight once sent, and the outcome when it settles", async () => {
    const { client, wire } = live();
    expect(client.queue).toEqual(IDLE_LINK_QUEUE);
    act(() => wire().open());
    // The socket drops; a press made now waits for the next hello.
    act(() => wire().drop());
    let settled: number | null | undefined;
    act(() => {
      void client.submit({ PassTurn: { game_id: 0 } } as never).then((index) => (settled = index));
    });
    expect(client.queue).toMatchObject({ unsent: 1, unsettled: 1, settled: 0, lastOutcome: null });
    expect(getActiveLinkQueue()).toBe(client.queue);
  });

  it("the outcome is the landing signal: an allocated index is `applied`; a refusal is `not-applied`", async () => {
    const { client, wire } = live();
    act(() => wire().open());
    let landed: Promise<number | null> = Promise.resolve(null);
    act(() => {
      landed = client.submit({ PassTurn: { game_id: 0 } } as never);
    });
    expect(client.queue).toMatchObject({ unsent: 0, unsettled: 1 });
    act(() => wire().deliver({ kind: "applied", build: "build-1", digest: "0".repeat(16), entries: [entry(0, { submission_id: "n1" })], inReplyTo: "n1" }));
    await expect(landed).resolves.toBe(0);
    expect(client.queue).toEqual({ unsent: 0, unsettled: 0, settled: 1, lastOutcome: "applied" });

    let refused: Promise<number | null> = Promise.resolve(0);
    act(() => {
      refused = client.submit({ PassTurn: { game_id: 0 } } as never);
    });
    act(() => wire().deliver({ kind: "refused", build: "build-1", reason: "It is not your turn.", inReplyTo: "n2" }));
    await expect(refused).resolves.toBeNull();
    expect(client.queue).toEqual({ unsent: 0, unsettled: 0, settled: 2, lastOutcome: "not-applied" });
  });

  it("reading it changes nothing on the wire: one submit frame, sent after the reconnect's hello", () => {
    const { client, wire, reconnect } = live();
    act(() => wire().open());
    act(() => wire().drop());
    act(() => {
      void client.submit({ PassTurn: { game_id: 0 } } as never);
    });
    for (let i = 0; i < 3; i += 1) void client.queue; // read, repeatedly
    reconnect();
    const frames = wire().frames();
    expect(frames[0].kind).toBe("hello");
    expect(submits(wire())).toHaveLength(1);
    expect(client.queue).toMatchObject({ unsent: 0, unsettled: 1 });
  });

  it("is identity-stable while nothing changes, and returns to idle when the link closes", () => {
    const { client, wire } = live();
    act(() => wire().open());
    act(() => {
      void client.submit({ PassTurn: { game_id: 0 } } as never);
    });
    const first = client.queue;
    expect(client.queue).toBe(first);
    expect(getActiveLinkQueue()).toBe(first);
    act(() => client.close());
    expect(getActiveLinkQueue()).toBe(IDLE_LINK_QUEUE);
  });

  it("the view: idle says nothing; queued says it will send on reconnect; in flight says it is sending", () => {
    expect(linkQueueView(IDLE_LINK_QUEUE)).toBe(IDLE_LINK_QUEUE_VIEW);
    expect(linkQueueView({ unsent: 1, unsettled: 1, settled: 0, lastOutcome: null })).toEqual({ blocked: true, queued: true, reason: LINK_QUEUED_NOTE });
    expect(linkQueueView({ unsent: 0, unsettled: 1, settled: 3, lastOutcome: "applied" })).toEqual({ blocked: true, queued: false, reason: LINK_SENDING_NOTE });
    expect(LINK_QUEUED_NOTE).toBe("Queued — will send on reconnect.");
  });
});

/* ================================================================================================================ */
describe("AUD-02.05 / AUD-02.06: the B&O par prompt reads the link", () => {
  let host: HTMLDivElement;
  let root: Root;
  let layerHost: HTMLDivElement;
  let layerRoot: Root;
  beforeEach(() => {
    jest.useFakeTimers();
    layerHost = document.createElement("div");
    document.body.appendChild(layerHost);
    layerRoot = createRoot(layerHost);
    act(() => layerRoot.render(<ModalLayerHost />));
    host = document.createElement("div");
    document.body.appendChild(host);
    act(() => {
      root = createRoot(host);
    });
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    act(() => layerRoot.unmount());
    layerHost.remove();
    jest.useRealTimers();
  });

  /** The prompt as the shell mounts it on the server path: the hook's live queue, the owner's card. */
  function Prompt({ owed, onConfirmPar }: { owed: boolean; onConfirmPar: (par: string) => Promise<unknown> }) {
    const linkQueue = useLinkQueue();
    return (
      <AuctionPromptModal
        parPending={owed}
        parWinnerLabel="Ann"
        onConfirmPar={onConfirmPar}
        handoffPending={false}
        awaitingParFrom={null}
        onProceed={noop}
        linkQueue={linkQueue}
      />
    );
  }
  const confirm = () =>
    Array.from(document.body.querySelectorAll<HTMLButtonElement>("button")).find((button) => /President|Sending/.test(button.textContent ?? ""))!;
  const click = (button: HTMLButtonElement) => act(() => button.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  const text = () => document.body.textContent ?? "";
  const advance = (ms: number) => act(() => jest.advanceTimersByTime(ms));
  const flush = async () => {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  };

  it("I-1: a press queued while the link reconnects says so, and no second press is taken -- past the old 4 s release", () => {
    const { client, wire, reconnect } = live();
    act(() => wire().open());
    act(() => wire().drop()); // the link is reconnecting
    let presses = 0;
    const send = (par: string) => {
      presses += 1;
      return client.submit({ SetBoPar: { player: P1, par_value: par } } as never);
    };
    act(() => root.render(<Prompt owed onConfirmPar={send} />));
    click(confirm());
    expect(presses).toBe(1);
    expect(document.body.querySelector('[data-testid="par-link-queued"]')?.textContent).toBe(LINK_QUEUED_NOTE);
    // Well past the 4 s hold that used to hand back a second press:
    advance(PAR_SEND_HOLD_MS * 3);
    expect(confirm().disabled).toBe(true);
    expect(text()).not.toContain(PAR_NOT_LANDED_NOTE);
    click(confirm());
    expect(presses).toBe(1);
    // The link comes back: the one queued par goes, exactly once.
    reconnect();
    expect(submits(wire())).toHaveLength(1);
    expect(document.body.querySelector('[data-testid="par-link-queued"]')).toBeNull();
    expect(confirm().disabled).toBe(true); // still the link's: sent, not yet answered
  });

  it("I-2: a press the link reports APPLIED never shows the note, however slow the drain -- the card goes when the board stops owing it", async () => {
    const { client, wire } = live();
    act(() => wire().open());
    const send = (par: string) => client.submit({ SetBoPar: { player: P1, par_value: par } } as never);
    act(() => root.render(<Prompt owed onConfirmPar={send} />));
    click(confirm());
    act(() => wire().deliver({ kind: "applied", build: "build-1", digest: "0".repeat(16), entries: [entry(0, { submission_id: "n1" })], inReplyTo: "n1" }));
    await flush();
    // The drain has not applied the entry yet: the board still owes the par, beyond the grace and the hold.
    advance(PAR_SETTLE_GRACE_MS + PAR_SEND_HOLD_MS - 1);
    expect(text()).not.toContain(PAR_NOT_LANDED_NOTE);
    expect(confirm().disabled).toBe(true);
    // The backstop: one more hold, then it lets go SILENTLY -- never inviting a second press of a par that landed.
    advance(PAR_SEND_HOLD_MS + 1);
    expect(text()).not.toContain(PAR_NOT_LANDED_NOTE);
    expect(confirm().disabled).toBe(false);
    // The board catches up: the card goes away by itself.
    act(() => root.render(<Prompt owed={false} onConfirmPar={send} />));
    expect(text()).not.toContain("wins the Baltimore");
  });

  it("I-2: a press the link reports NOT applied (refused) shows the note after the grace, and the owner may press again", async () => {
    const { client, wire } = live();
    act(() => wire().open());
    let presses = 0;
    const send = (par: string) => {
      presses += 1;
      return client.submit({ SetBoPar: { player: P1, par_value: par } } as never);
    };
    act(() => root.render(<Prompt owed onConfirmPar={send} />));
    click(confirm());
    act(() => wire().deliver({ kind: "refused", build: "build-1", reason: "Not now.", inReplyTo: "n1" }));
    await flush();
    expect(text()).not.toContain(PAR_NOT_LANDED_NOTE);
    advance(PAR_SETTLE_GRACE_MS);
    expect(text()).toContain(PAR_NOT_LANDED_NOTE);
    expect(confirm().disabled).toBe(false);
    click(confirm());
    expect(presses).toBe(2);
  });

  it("with no room link (the prompt's own timers), the 4 s release and the note behave exactly as before", () => {
    act(() =>
      root.render(
        <AuctionPromptModal
          parPending
          parWinnerLabel="Ann"
          onConfirmPar={() => new Promise(noop)}
          handoffPending={false}
          awaitingParFrom={null}
          onProceed={noop}
        />,
      ),
    );
    click(confirm());
    expect(confirm().disabled).toBe(true);
    advance(PAR_SEND_HOLD_MS);
    expect(confirm().disabled).toBe(false);
    expect(text()).toContain(PAR_NOT_LANDED_NOTE);
  });
});

/* ================================================================================================================ */
describe("AUD-03.11 (R4) + AUD-19.01: the Private Companies offer form is kept until the proposal lands", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    act(() => {
      root = createRoot(host);
    });
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });
  const q = <T extends HTMLElement = HTMLElement>(id: string) => host.querySelector<T>(`[data-testid="${id}"]`);
  const press = (node: HTMLElement | null) => act(() => node!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  const typeInto = (input: HTMLInputElement, value: string) =>
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

  const srBoard = () =>
    stockRoundBoard({
      corps: [{ id: PRR, ticker: "PRR", president: P1, trains: ["3"], treasury: "500", holdings: [[P1, 30], [P2, 20]], ipo: 50 }],
      privates: [
        { id: DH, owner: P2, cost: "70" },
        { id: CA, owner: P3, cost: "160" },
        { id: MH, owner: P1, cost: "110" },
      ],
    });
  function Section({ board, onPropose, actionInFlight = false }: { board: GameStateResponse; onPropose: (intent: unknown) => void; actionInFlight?: boolean }) {
    const view = linkQueueView(useLinkQueue());
    return (
      <PrivateCompaniesSection
        model={privateTradeSectionModel(board, P1, labelFor)!}
        viewer={P1}
        proposalRefusal={(intent) => privateTradeProposalRefusal(board, P1, intent, labelFor)}
        onPropose={onPropose}
        onAnswer={noop}
        onRescind={noop}
        sessionReady
        actionInFlight={actionInFlight}
        linkQueue={view}
      />
    );
  }
  /** Opens the buy form on Ben's D&H and types a price. */
  function openAndType(price: string) {
    press(q(`private-trade-buy-${DH}`));
    typeInto(q<HTMLInputElement>("private-trade-price")!, price);
  }

  it("a send the link holds: the form stays with what was typed, says it is queued, and takes no second press", () => {
    const { client, wire, reconnect } = live();
    act(() => wire().open());
    act(() => wire().drop());
    const sent: unknown[] = [];
    const propose = (intent: unknown) => {
      sent.push(intent);
      void client.submit({ ProposePrivateTrade: intent } as never);
    };
    act(() => root.render(<Section board={srBoard()} onPropose={propose} />));
    openAndType("40");
    press(q("private-trade-send"));
    expect(sent).toHaveLength(1);
    // Kept, with the typed price, and greyed with the link's own sentence.
    expect(q(`private-trade-form-${DH}`)).not.toBeNull();
    expect(q<HTMLInputElement>("private-trade-price")!.value).toBe("40");
    expect(q("private-trade-refusal")?.textContent).toBe(LINK_QUEUED_NOTE);
    expect(q<HTMLButtonElement>("private-trade-send")!.disabled).toBe(true);
    press(q("private-trade-send"));
    expect(sent).toHaveLength(1);
    reconnect();
    expect(submits(wire())).toHaveLength(1);
    expect(q("private-trade-refusal")?.textContent).toBe(LINK_SENDING_NOTE);
  });

  it("a send that does not land (dropped / refused) leaves the form live with what was typed -- nothing to retype", async () => {
    const { client, wire } = live();
    act(() => wire().open());
    let pending: Promise<number | null> = Promise.resolve(null);
    const propose = (intent: unknown) => {
      pending = client.submit({ ProposePrivateTrade: intent } as never);
    };
    act(() => root.render(<Section board={srBoard()} onPropose={propose} />));
    openAndType("40");
    press(q("private-trade-send"));
    expect(q<HTMLButtonElement>("private-trade-send")!.disabled).toBe(true);
    act(() => wire().deliver({ kind: "refused", build: "build-1", reason: "Not now.", inReplyTo: "n1" }));
    await act(async () => {
      await pending;
    });
    expect(q<HTMLInputElement>("private-trade-price")!.value).toBe("40");
    expect(q<HTMLButtonElement>("private-trade-send")!.disabled).toBe(false);
  });

  it("a send that lands closes the form: the standing offer withdraws the openers (the board, not the press)", () => {
    const sent: unknown[] = [];
    const board = srBoard();
    act(() => root.render(<Section board={board} onPropose={(intent) => sent.push(intent)} actionInFlight={false} />));
    openAndType("40");
    press(q("private-trade-send"));
    expect(q(`private-trade-form-${DH}`)).not.toBeNull(); // not closed by the press itself
    const landed = apply(board, M.proposeTrade(DH, P2, P1, 40), P1);
    act(() => root.render(<Section board={landed} onPropose={(intent) => sent.push(intent)} />));
    expect(q(`private-trade-form-${DH}`)).toBeNull();
    expect(sent).toHaveLength(1);
  });

  it("two presses before React commits send one proposal (the form no longer closes to stop the second)", () => {
    const sent: unknown[] = [];
    act(() => root.render(<Section board={srBoard()} onPropose={(intent) => sent.push(intent)} />));
    openAndType("40");
    const send = q<HTMLButtonElement>("private-trade-send")!;
    act(() => {
      send.click();
      send.click();
    });
    expect(sent).toHaveLength(1);
  });
});

/* ================================================================================================================ */
describe("AUD-19.01: the corporate offer forms take no second press while the link holds the last submission", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    act(() => {
      root = createRoot(host);
    });
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });
  const textOf = (node: Element) => (node.textContent ?? "").replace(/\s+/g, " ").trim();
  const button = (label: string | RegExp) =>
    Array.from(host.querySelectorAll("button")).find((node) => (typeof label === "string" ? textOf(node).startsWith(label) : label.test(textOf(node))))!;
  const press = (node: HTMLButtonElement) => act(() => node.click());
  const board = (): GameStateResponse =>
    operatingBoard({
      privates: [
        { id: DH, owner: P2, cost: "70" },
        { id: CA, owner: null, ownerCorp: NYC, cost: "160" },
        { id: MH, owner: P1, cost: "110" },
        { id: BO, owner: P2, cost: "100" },
      ],
    });
  const bound = (state: GameStateResponse) => ({ state, actor: P1, buyerId: PRR, labelFor });

  it("Buy Private Company: queued -> the submit is dead with the queued sentence; idle -> live as before", () => {
    const sent: number[] = [];
    const panel = (queue: LinkQueueState) => (
      <ProposePrivatePurchase
        embedded
        open
        buyerTicker="PRR"
        privates={board().private_companies}
        treasury={500}
        labelForAddress={labelFor}
        onPropose={(id) => sent.push(id)}
        onClose={noop}
        proposalRefusal={(privateId, price) => privateProposalRefusal(bound(board()), privateId, price)}
        linkQueue={linkQueueView(queue)}
      />
    );
    act(() => root.render(panel({ unsent: 1, unsettled: 1, settled: 0, lastOutcome: null })));
    press(button(/Delaware & Hudson/));
    const submit = button("Propose Purchase to Ben") as HTMLButtonElement;
    expect([submit.disabled, submit.title]).toEqual([true, LINK_QUEUED_NOTE]);
    expect(host.querySelector('[data-testid="private-offer-link-queued"]')?.textContent).toBe(LINK_QUEUED_NOTE);
    press(submit);
    expect(sent).toEqual([]);
    act(() => root.render(panel(IDLE_LINK_QUEUE)));
    expect((button("Propose Purchase to Ben") as HTMLButtonElement).disabled).toBe(false);
    expect(host.querySelector('[data-testid="private-offer-link-queued"]')).toBeNull();
    press(button("Propose Purchase to Ben") as HTMLButtonElement);
    expect(sent).toEqual([DH]);
  });

  it("Buy Trains from a Corporation: queued -> Send Offer is dead and says why; idle -> live as before", () => {
    const sent: unknown[] = [];
    const state = board();
    const companies = state.public_companies as unknown as TrainPurchaseCompany[];
    const roster = (queue: LinkQueueState) => (
      <TrainPurchasePanel
        depot={depotInventory(state)}
        buyer={companies.find((entry) => entry.company_id === PRR) ?? null}
        companies={companies}
        sessionReady
        canAct
        blockedReason={null}
        onBuyFromBank={noop}
        openTiers={openDepotTiers(state)}
        onProposeTrade={(proposal) => sent.push(proposal)}
        offerRefusal={(offer) => trainOfferRefusal(bound(state), offer)}
        linkQueue={linkQueueView(queue)}
        labelForAddress={labelFor}
        defaultCorporateOpen
      />
    );
    act(() => root.render(roster({ unsent: 1, unsettled: 1, settled: 0, lastOutcome: null })));
    const rows = Array.from(host.querySelectorAll("div")).filter((node) => node.querySelector("button") !== null && textOf(node).startsWith("NYC"));
    press(rows[rows.length - 1].querySelector("button") as HTMLButtonElement);
    const input = host.querySelector<HTMLInputElement>("#trade-price")!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "150");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const submit = button(/^(Buy Now|Send Offer)$/) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    expect(host.querySelector('[data-testid="train-offer-link-queued"]')?.textContent).toBe(LINK_QUEUED_NOTE);
    press(submit);
    expect(sent).toEqual([]);
    act(() => root.render(roster(IDLE_LINK_QUEUE)));
    expect((button(/^(Buy Now|Send Offer)$/) as HTMLButtonElement).disabled).toBe(false);
    expect(host.querySelector('[data-testid="train-offer-link-queued"]')).toBeNull();
  });
});

/* ================================================================================================================ */
describe("the shell's wiring (source pins): one hook, outside the drain, handed to each form", () => {
  const APP = readStripped("App.tsx");
  it("reads the link's queue through the one hook, and nowhere inside the link callbacks", () => {
    expect(APP.split("useLinkQueue()").length - 1).toBe(1);
    expect(APP).toContain("const linkQueueNote = useMemo(() => linkQueueView(linkQueue), [linkQueue]);");
    expect(sliceBetween(APP, "const link = connectServerLink({", "serverLinkRef.current = link;")).not.toContain("linkQueue");
  });
  it("hands the raw queue to the par prompt (server path only) and the view to the three offer forms", () => {
    expect(sliceBetween(APP, "<AuctionPromptModal", "/>")).toContain("linkQueue={GAME_SERVER_URL ? linkQueue : undefined}");
    expect(sliceBetween(APP, "<StockRoundPanel", "/>")).toContain("linkQueue={linkQueueNote}");
    expect(APP.split("linkQueue: linkQueueNote,").length - 1).toBe(2); // privatePurchase + trainPurchase
  });
});
