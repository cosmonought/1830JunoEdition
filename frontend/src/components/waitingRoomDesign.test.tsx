/** @jest-environment jsdom */
// frontend/src/components/waitingRoomDesign.test.tsx
//
// PLAY WAITING ROOM (approved design, "play-host-waiting-handoff" §4-§9): the screen, rendered. Your boarding pass
// carries everything you do before departure (§6) -- the status sentence, the guests' ante note, the action row (Ante;
// Start game once the host has anted; Withdraw deposit for a funded guest; the host's Change ante; Give up seat), the
// Terms link and the error line; the host's ante editor sends the new `set-ante` op (§12.1); the tear happens only at
// the moment of funding; Watching and Removed say so in their own panels; Game settings ends with Skip the titles,
// Report a player and the host's Cancel table; the waiting room offers no visibility or code control (§5, §16); and a
// one-button Ante names the Keplr approval it is waiting on, counted (§7).

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { SandboxWaitingRoom, type SandboxWaitingRoomProps } from "./SandboxWaitingRoom";
import { installMoneyServicesForTests, updateMoneySession } from "../money/moneySession";
import { linked, moneyView, testServices, T0, you } from "../money/moneyTestSupport";
import { resolveVariants } from "../gameEngine/gameVariants";
import type { RoomOpResult, RoomView } from "../utils/roomProtocol";
import type { RoomMoneyView } from "../utils/moneyProtocol";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
global.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let services: ReturnType<typeof testServices>;
beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  services = testServices();
  installMoneyServicesForTests(services);
  updateMoneySession({ wallet: "disconnected", address: null, confirmedUntil: null });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  installMoneyServicesForTests(null);
});

const settle = async () => {
  await act(async () => {
    for (let n = 0; n < 30; n += 1) await Promise.resolve();
  });
};
const byTestId = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const text = () => container.textContent ?? "";
const click = async (element: Element | null) => {
  expect(element).toBeTruthy();
  act(() => (element as HTMLElement).click());
  await settle();
};
const typeInto = (input: HTMLInputElement | null, value: string) => {
  expect(input).toBeTruthy();
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input!.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

function room(money: RoomMoneyView | undefined, over: Partial<RoomView> & { role?: "host" | "player"; me?: string | null } = {}): RoomView {
  const { role = "player", me = "p-me", ...rest } = over;
  return {
    gameId: "g_table",
    code: "JUNO-AAAA-BBBB",
    joinable: true,
    visibility: "public",
    status: "waiting",
    lifecycle: "waiting",
    closed: false,
    held: false,
    holdKind: null,
    hostId: role === "host" ? "p-me" : "p-other",
    players: [
      { id: "p-other", nickname: "Ana", isReady: false, online: true },
      { id: "p-me", nickname: "Brad", isReady: false, online: true },
    ],
    playerCount: 2,
    seatCap: 2,
    variants: resolveVariants({} as never),
    createdAtMs: T0,
    undoPolicy: { host_undo: "none" },
    you: { role: me === null ? "watcher" : role, playerId: me, kicked: false, canStart: false } as RoomView["you"],
    ...(money !== undefined ? { money } : {}),
    ...rest,
  } as RoomView;
}

type Handlers = Partial<SandboxWaitingRoomProps>;
const render = async (view: RoomView, handlers: Handlers = {}) => {
  const props: SandboxWaitingRoomProps = {
    roomCode: view.code ?? "Private game",
    room: view,
    localPlayerId: view.you.playerId ?? "",
    error: null,
    busy: false,
    onSetColor: () => undefined,
    onToggleReady: () => undefined,
    onStart: () => undefined,
    onLeave: () => undefined,
    onReleaseSeat: view.you.playerId ? () => undefined : undefined,
    onCancelRoom: view.you.role === "host" ? () => undefined : undefined,
    onKick: view.you.role === "host" ? () => undefined : undefined,
    ...handlers,
  };
  act(() => root.render(<SandboxWaitingRoom {...props} />));
  await settle();
  return props;
};

describe("§6: the host's pass before the first deposit", () => {
  const hostView = () => room(moneyView({ you: you({ actions: ["link-wallet"] }) }), { role: "host" });

  it("says what to do, offers the one Ante with Change ante and Give up seat beside it, the Terms under them", async () => {
    await render(hostView());
    expect(byTestId("room-lead")?.textContent).toBe("Ante 1 JUNOX to open the table on Juno. The others ante once it's open.");
    expect(byTestId("room-lead")?.getAttribute("role")).toBe("status");
    const row = byTestId("before-departure")!;
    const buttons = Array.from(row.querySelectorAll(".rm-p-foot button")).map((b) => b.textContent);
    expect(buttons).toEqual(["Ante 1 JUNOX", "Change ante", "Give up seat"]);
    expect(row.querySelector('[data-testid="waiting-room-terms-link"]')?.textContent).toBe("Terms of real-money play");
    /* Guests' note is a guests' note. */
    expect(text()).not.toContain("The host can still change the ante");
  });

  it("opens the ante editor in the Ante's place and sends the new set-ante op", async () => {
    const sent: Array<{ op: unknown; gameId: string | undefined }> = [];
    const sendOp = jest.fn(async (op: unknown, gameId?: string): Promise<RoomOpResult> => {
      sent.push({ op, gameId });
      return { ok: true } as RoomOpResult;
    });
    await render(hostView(), { sendOp: sendOp as never });
    await click(byTestId("ante-editor-open"));
    expect(byTestId("money-action-ante")).toBeNull();
    expect(byTestId("ante-editor")?.textContent).toContain("Ante per seat");
    expect((byTestId("ante-editor-input") as HTMLInputElement).value).toBe("1");
    expect(byTestId("ante-editor-keep")?.textContent).toBe("Keep 1 JUNOX");
    typeInto(byTestId("ante-editor-input") as HTMLInputElement, "2.5");
    expect(byTestId("ante-editor")?.textContent).toContain("Each seat deposits 2.5 JUNOX; the 1% developer fee (0.025 JUNOX) isn't refunded. You can change the ante until the first deposit.");
    await click(byTestId("ante-editor-set"));
    expect(sent).toEqual([{ op: { type: "set-ante", stake: "2500000" }, gameId: "g_table" }]);
    /* Accepted: the editor closes (the room view brings the new ante). */
    expect(byTestId("ante-editor")).toBeNull();
    expect(byTestId("money-action-ante")).toBeTruthy();
  });

  it("refuses a malformed amount without sending, and shows the server's refusal in the error line", async () => {
    const sendOp = jest.fn(async (): Promise<RoomOpResult> => ({ ok: false, code: "ante-fixed", reason: "A seat has already anted, so the ante is fixed." }) as RoomOpResult);
    await render(hostView(), { sendOp: sendOp as never });
    await click(byTestId("ante-editor-open"));
    typeInto(byTestId("ante-editor-input") as HTMLInputElement, "abc");
    expect(byTestId("ante-editor")?.textContent).toContain("Enter the ante in JUNOX, like 10 or 2.5 (above zero).");
    await click(byTestId("ante-editor-set"));
    expect(sendOp).not.toHaveBeenCalled();
    expect(byTestId("waiting-room-error")?.getAttribute("role")).toBe("alert");
    typeInto(byTestId("ante-editor-input") as HTMLInputElement, "3");
    await click(byTestId("ante-editor-set"));
    expect(byTestId("waiting-room-error")?.textContent).toBe("A seat has already anted, so the ante is fixed.");
    /* Keep closes it unchanged. */
    await click(byTestId("ante-editor-keep"));
    expect(byTestId("ante-editor")).toBeNull();
  });

  it("offers no ante editor once money may exist (the escrow is open)", async () => {
    await render(room(moneyView({ escrow: { chainGameId: "7", state: "FUNDING" }, you: linked([], { actions: ["open-escrow"] }) }), { role: "host" }));
    expect(byTestId("ante-editor-open")).toBeNull();
  });
});

describe("§6: a guest's pass", () => {
  it("before the host antes: the Ante is shown disabled, the sentence says why, and the host may still change the ante", async () => {
    await render(room(moneyView()));
    expect(byTestId("room-lead")?.textContent).toBe("Ana antes first, which opens the table on Juno. Your Ante button works once it's open.");
    const ante = byTestId("money-action-ante") as HTMLButtonElement;
    expect(ante.textContent).toBe("Ante 1 JUNOX");
    expect(ante.disabled).toBe(true);
    expect(text()).toContain("The host can still change the ante until the first deposit.");
    expect(byTestId("ante-editor-open")).toBeNull();
  });

  it("funded: Withdraw deposit in the Ante's place, the stub already torn on load -- and the tear animates only when a seat funds", async () => {
    const funded = (other: "none" | "funded") =>
      room(
        moneyView({
          escrow: { chainGameId: "7", state: "FUNDING", fundedSeats: other === "funded" ? 2 : 1 },
          seats: [
            { playerId: "p-me", funding: "funded" },
            { playerId: "p-other", funding: other },
          ],
          start: { blocker: other === "funded" ? null : "need-funding" },
          you: linked([], { funding: "funded", payoutWallet: "juno1me", actions: ["withdraw"] }),
        }),
      );
    await render(funded("none"));
    expect(byTestId("money-action-withdraw")?.textContent).toBe("Withdraw deposit");
    expect(byTestId("money-action-ante")).toBeNull();
    expect(byTestId("room-lead")?.textContent).toBe("You're on board. Waiting for 1 player to ante.");
    const mine = byTestId("room-your-pass")!;
    expect(mine.className).toContain("rm-torn");
    expect(mine.className).not.toContain("rm-tearing");
    expect(mine.textContent).toContain("Boarded");
    const other = byTestId("money-seat-p-other")!;
    expect(other.className).not.toContain("rm-torn");
    /* Ana is the host here, and her ante already opened the table, so her pass reads as any unfunded seat's. */
    expect(other.textContent).toContain("Not anted yet");
    await render(funded("funded"));
    const tore = byTestId("money-seat-p-other")!;
    expect(tore.className).toContain("rm-torn");
    expect(tore.className).toContain("rm-tearing");
    expect(tore.querySelector(".rm-stamp.rm-new")?.textContent).toBe("Boarded");
    expect(tore.textContent).toContain("Ante paid");
  });
});

describe("§6: the host's pass once anted", () => {
  const anted = (canStart: boolean) =>
    room(
      moneyView({
        escrow: { chainGameId: "7", state: canStart ? "FUNDED" : "FUNDING", fundedSeats: canStart ? 2 : 1 },
        seats: [
          { playerId: "p-me", funding: "funded" },
          { playerId: "p-other", funding: canStart ? "funded" : "none" },
        ],
        start: { state: canStart ? "ready" : "not-ready", blocker: canStart ? null : "need-funding", canStart },
        you: linked([], { funding: "funded", payoutWallet: "juno1me", actions: ["cancel-escrow"] }),
      }),
      { role: "host" },
    );

  it("puts Start game in the Ante's place, disabled until the table can start, with the sentence saying why", async () => {
    await render(anted(false));
    const start = byTestId("money-action-start") as HTMLButtonElement;
    expect(start.textContent).toBe("Start game");
    expect(start.disabled).toBe(true);
    expect(start.title).toBe("Locks the seats with the escrow and starts the game on Juno.");
    expect(byTestId("room-lead")?.textContent).toBe("Waiting for 1 player to ante.");
  });

  it("enables it once every seat has anted, and it is the room's own Start", async () => {
    const onStart = jest.fn();
    await render(anted(true), { onStart });
    expect(byTestId("room-lead")?.textContent).toBe("Every seat has anted. Start locks the seats and deals the game.");
    await click(byTestId("money-action-start"));
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it("cancels on Juno (CANCEL_FLOW), from Game settings, after asking -- naming that deposits come back", async () => {
    await render(anted(false));
    const settings = byTestId("game-settings")!;
    await click(settings.querySelector('[data-testid="cancel-room"]'));
    expect(settings.textContent).toContain("Close this table for everyone? Every deposit comes back to its wallet, minus the fee.");
    expect(settings.querySelector('[data-testid="cancel-room-confirm"]')?.textContent).toBe("Close the table for everyone");
  });
});

describe("§7: one Ante press, and the Keplr approval it waits on", () => {
  it("shows 'Approve in Keplr…' and names the approval Keplr is showing, counted against the plan", async () => {
    let release: () => void = () => undefined;
    services.wallet.connect = () =>
      new Promise((resolve) => {
        release = () => resolve({ ok: false, code: "rejected", reason: "You declined in Keplr. Nothing was signed." } as never);
      });
    await render(room(moneyView({ escrow: { chainGameId: "7", state: "FUNDING" }, start: { blocker: "need-funding" }, you: you({ actions: ["link-wallet"] }) })));
    await click(byTestId("money-action-ante"));
    expect(byTestId("money-action-ante")?.textContent).toBe("Approve in Keplr…");
    expect((byTestId("money-action-ante") as HTMLButtonElement).disabled).toBe(true);
    expect(byTestId("money-progress")?.getAttribute("role")).toBe("status");
    expect(byTestId("money-progress")?.textContent).toBe("Check Keplr: connect your wallet (1 of 3).");
    expect(byTestId("room-lead")?.textContent).toBe("Keplr shows each step before anything moves. Approve it there.");
    /* A decline returns the button to Ante X, with Play's sentence; nothing moved. */
    await act(async () => release());
    await settle();
    expect(byTestId("money-action-ante")?.textContent).toBe("Ante 1 JUNOX");
    expect(byTestId("money-progress")?.textContent).toBe("");
  });
});

describe("§6: Watching and Removed", () => {
  it("a watcher of an open table gets the dashed panel, Take a seat, and the line under it", async () => {
    const onTakeSeat = jest.fn();
    await render(room(moneyView({ you: null }), { me: null, players: [{ id: "p-other", nickname: "Ana", isReady: false, online: true }] }), { onTakeSeat });
    const panel = byTestId("waiting-room-watching")!;
    expect(panel.textContent).toContain("WatchingYou are watching this table. Take a seat to play.");
    expect(panel.textContent).toContain("Taking a seat holds it for you. You board by anteing 1 JUNOX.");
    expect(byTestId("room-your-pass")).toBeNull();
    await click(byTestId("take-seat"));
    expect(onTakeSeat).toHaveBeenCalledTimes(1);
  });

  it("a watcher of a full table is told so, with no button", async () => {
    await render(room(moneyView({ you: null }), { me: null }));
    const panel = byTestId("waiting-room-watching")!;
    expect(panel.textContent).toContain("You are watching this table. Every seat is taken.");
    expect(panel.textContent).toContain("You can keep watching; the game is shown here when it starts.");
    expect(byTestId("take-seat")).toBeNull();
  });

  it("a removed player gets the Removed panel and Play's sentence", async () => {
    const view = room(moneyView({ you: null }), { me: null });
    await render({ ...view, you: { ...view.you, kicked: true } });
    const panel = byTestId("waiting-room-removed")!;
    expect(panel.textContent).toContain("You no longer hold a seat at this table.");
    expect(panel.textContent).toContain("The host removed you from this table. You cannot rejoin it; leave and join or host another.");
  });
});

describe("§5, §9.1, §16: Game settings, and what the waiting room no longer offers", () => {
  it("lists the settings, then Skip the opening titles, Report a player and (host) Cancel table -- and no visibility or code control", async () => {
    const onCancelRoom = jest.fn();
    await render(room(moneyView({ you: you({ actions: ["link-wallet"] }) }), { role: "host", visibility: "private" }), {
      onCancelRoom,
      onSetVisibility: () => undefined,
      onRotateCode: () => undefined,
      onReport: async () => ({ ok: true }) as RoomOpResult,
    });
    const settings = byTestId("game-settings")!;
    /* "Report…" is Play's existing report control (`ReportPlayerControl`), placed here unchanged. */
    const order = ["Pace", "Visibility", "Bank", "Skip the opening titles", "Report…", "Cancel table"].map((label) => settings.textContent!.indexOf(label));
    expect(order.every((at, i) => at >= 0 && (i === 0 || at > order[i - 1]))).toBe(true);
    expect(settings.textContent).toContain("Fixed when the table opened");
    expect(settings.textContent).toContain("Private");
    for (const gone of ["Make private", "Make public", "Change code", "New code", "Before departure"]) expect([gone, text().includes(gone)]).toEqual([gone, false]);
    await click(settings.querySelector('[data-testid="cancel-room"]'));
    expect(settings.textContent).toContain("Close this table for everyone? Nobody has anted, so nothing moves.");
    await click(settings.querySelector('[data-testid="cancel-room-confirm"]'));
    expect(onCancelRoom).toHaveBeenCalledTimes(1);
  });

  it("puts the code on the sign's foot line with Copy code, and no name field anywhere", async () => {
    await render(room(moneyView()));
    expect(byTestId("waiting-room-code")?.textContent).toBe("JUNO-AAAA-BBBB");
    expect(byTestId("copy-code")?.textContent).toBe("Copy code");
    expect(container.querySelector('input[aria-label="Your nickname"]')).toBeNull();
    expect(text()).not.toContain("Set name");
  });
});

describe("§11: an Any-count table (a development build's no-ante table: no money table can be Any yet)", () => {
  it("reads Any count, offers optional open seats, never Final call, and keeps the development Ready", async () => {
    const onToggleReady = jest.fn();
    await render(room(undefined, { playerCount: null, seatCap: 6 }), { onToggleReady });
    expect(byTestId("room-sign")?.textContent).toContain("Any count, up to 6");
    expect(byTestId("boarding-count")?.textContent).toBe("2 seated · up to 6");
    expect(container.querySelectorAll(".rm-pass.rm-open")).toHaveLength(4);
    expect(byTestId("open-seat-3")?.textContent).toContain("Open seat · optional");
    expect(byTestId("room-status")?.getAttribute("data-text")).toBe("BOARDING");
    await click(byTestId("ready-toggle"));
    expect(onToggleReady).toHaveBeenCalledWith(true);
  });

  it("on an exact table with one seat left, it is Final call", async () => {
    await render(room(moneyView({ terms: { seats: 3 } }), { playerCount: 3, seatCap: 3 }));
    expect(byTestId("room-status")?.getAttribute("data-text")).toBe("FINAL CALL");
    expect(byTestId("room-sign")?.textContent).toContain("Exactly");
  });
});

describe("§9.4: departing", () => {
  it("flips the sign to DEPARTING, says so, and offers no action", async () => {
    await render(room(moneyView({ you: you({ actions: ["link-wallet"] }) }), { role: "host" }), { departing: true });
    expect(byTestId("room-status")?.getAttribute("data-text")).toBe("DEPARTING");
    expect(byTestId("room-lead")?.textContent).toBe("Departing.");
    expect(byTestId("money-action-ante")).toBeNull();
    expect(byTestId("ante-editor-open")).toBeNull();
    expect(byTestId("cancel-room")).toBeNull();
  });
});
