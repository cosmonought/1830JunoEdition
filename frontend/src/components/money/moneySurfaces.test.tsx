/** @jest-environment jsdom */
//
// ESCROW-4 (brief §9, §15, §24): the smaller money surfaces.
//   - The host's stake is read by a strict parser: a malformed or too-small amount, or no exact player count, is a
//     problem sentence (never a silent zero); off means no stake at all.
//   - The lobby row and "Your tables" say what a real-money table is and where this seat's money is; a no-money table
//     says nothing new.
//   - "Your deposits" lists the server's answer with only the exits each deposit allows, falls back to this browser's
//     own sent deposits when the server can't answer, and hides itself when there is nothing (or no pinned escrow).

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { stakeChoice } from "./HostStakeSection";
import { YourDeposits } from "./YourDeposits";
import { publicRoomRow } from "../LobbyRoomList";
import { myTableMoneyLine } from "../MyTablesList";
import type { MoneyConfig } from "../../money/moneyApi";
import { installMoneyServicesForTests } from "../../money/moneySession";
import { scriptedPort, T0, TEST_CONTRACT, TEST_PIN, TEST_WALLET, testServices } from "../../money/moneyTestSupport";
import { STANDARD_VARIANTS } from "../../gameEngine/gameVariants";
import type { RoomSummary } from "../../utils/roomProtocol";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
global.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
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
const all = (id: string) => Array.from(container.querySelectorAll(`[data-testid="${id}"]`)) as HTMLElement[];

const deployment = { backend: "juno-cosmwasm", chainId: "uni-7", networkClass: "testnet", contract: TEST_CONTRACT, codeChecksum: TEST_PIN.codeChecksum, denom: "ujunox", symbol: "JUNOX", exponent: 6 } as const;
const offer: MoneyConfig = { enabled: true, why: null, reason: null, deployment, feeBps: 100, minAnte: "1000" };

describe("ESCROW-4: the host's stake", () => {
  it("is exact or it is a sentence -- never a silent zero", () => {
    expect(stakeChoice(null, true, "10", 4)).toEqual({ base: null, problem: null });
    expect(stakeChoice(offer, false, "10", 4)).toEqual({ base: null, problem: null });
    expect(stakeChoice(offer, true, "2.5", 4)).toEqual({ base: "2500000", problem: null });
    for (const typed of ["", "abc", "1e3", "-1", "0", "1.0000001", "1,5"]) {
      expect(stakeChoice(offer, true, typed, 4)).toMatchObject({ base: null, problem: expect.stringMatching(/^Enter the stake in JUNOX/) });
    }
    expect(stakeChoice(offer, true, "0.0001", 4)).toEqual({ base: "100", problem: "The smallest stake Juno's escrow accepts is 0.001 JUNOX." });
    expect(stakeChoice(offer, true, "10", null)).toEqual({ base: "10000000", problem: expect.stringMatching(/needs an exact number of players/) });
  });
});

describe("ESCROW-4: the lobby row and 'Your tables'", () => {
  const summary = (stake?: RoomSummary["stake"]): RoomSummary => ({
    gameId: "g_1",
    code: "JUNO-1A1",
    status: "waiting",
    hostNickname: "p0",
    nicknames: ["p0"],
    readyCount: 0,
    seated: 1,
    seatCap: 6,
    playerCount: 2,
    variants: STANDARD_VARIANTS,
    createdAtMs: 0,
    ...(stake !== undefined ? { stake } : {}),
  });

  it("names a real-money table's stake and funding; a no-money row has none", () => {
    expect(publicRoomRow(summary()).stake).toBeNull();
    expect(publicRoomRow(summary({ anteGross: "10000000", symbol: "JUNOX", exponent: 6, networkClass: "testnet", funded: 1, seats: 2 })).stake).toEqual({ label: "10 JUNOX · testnet", funded: "1/2 funded" });
  });

  it("says where this seat's money is, and marks what needs this player", () => {
    const base = { anteGross: "10000000", symbol: "JUNOX", exponent: 6, networkClass: "testnet" as const };
    expect(myTableMoneyLine({ ...base, status: "deposit", actionNeeded: true })).toMatch(/^10 JUNOX table · Action needed: /);
    expect(myTableMoneyLine({ ...base, status: "funded", actionNeeded: false })).not.toMatch(/Action needed/);
  });
});

describe("ESCROW-4: 'Your deposits'", () => {
  const entry = (over: Record<string, unknown> = {}) => ({
    gameId: "g_1",
    tableOpen: false,
    deployment,
    chainGameId: "7",
    wallet: TEST_WALLET,
    grossDeposit: "1000000",
    netDeposit: "990000",
    chainState: "FUNDING",
    fundingDeadline: null,
    relation: "bound",
    creator: false,
    actions: ["withdraw"],
    ...over,
  });

  it("lists the server's deposits with only the exits each one allows", async () => {
    const services = testServices();
    installMoneyServicesForTests(services);
    const port = scriptedPort();
    port.answer("money/deposits", 200, { ok: true, deposits: [entry(), entry({ chainGameId: "8", creator: true, actions: ["withdraw", "cancel-escrow", "open-table"], tableOpen: true })] });
    const opened: string[] = [];
    act(() => root.render(<YourDeposits onOpen={(gameId) => opened.push(gameId)} port={port} services={services} />));
    await settle();
    const rows = all("your-deposit");
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toMatch(/1 JUNOX from juno12gdm…783a · escrow game 7 on uni-7 · funding/);
    expect(rows[0].textContent).toMatch(/Its table is closed; the deposit is still yours on Juno\. Refundable now: 0\.99 JUNOX \(the fee isn't refunded\)\./);
    expect(all("your-deposit-withdraw")).toHaveLength(2);
    expect(all("your-deposit-cancel-escrow")).toHaveLength(1);
    expect(all("your-deposit-refund-after-deadline")).toHaveLength(0);
    act(() => all("your-deposit-open")[0].click());
    expect(opened).toEqual(["g_1"]);
  });

  it("falls back to this browser's own sent deposits when the server can't answer", async () => {
    const services = testServices();
    installMoneyServicesForTests(services);
    services.pending.put({ v: 1, gameId: "g_1", playerId: "p-me", kind: "join", chainId: "uni-7", contract: TEST_CONTRACT, sender: TEST_WALLET, chainGameId: "7", txHash: "AB".repeat(32), txBytes: "AAAA", timeoutHeight: "1100", createdAt: T0, stage: "sent", consentKey: null });
    const port = scriptedPort(); /* nothing scripted: the network is down */
    act(() => root.render(<YourDeposits onOpen={() => undefined} port={port} services={services} />));
    await settle();
    expect(all("your-deposit-local")[0]?.textContent).toMatch(/This browser sent a deposit from juno12gdm…783a to escrow game 7/);
    expect(container.textContent).toMatch(/didn't answer/);
  });

  it("a transaction this browser signed but never sent can be sent again from here; the creator's own deposit is cancelled, not withdrawn", async () => {
    const services = testServices();
    installMoneyServicesForTests(services);
    services.pending.put({ v: 1, gameId: "g_2", playerId: "wallet:juno1x", kind: "withdraw", chainId: "uni-7", contract: TEST_CONTRACT, sender: TEST_WALLET, chainGameId: "8", txHash: "BC".repeat(32), txBytes: "AAAA", timeoutHeight: "1100", createdAt: T0, stage: "signed", consentKey: null });
    services.pending.put({ v: 1, gameId: "g_1", playerId: "p-me", kind: "create", chainId: "uni-7", contract: TEST_CONTRACT, sender: TEST_WALLET, chainGameId: "7", txHash: "AB".repeat(32), txBytes: "AAAA", timeoutHeight: "1100", createdAt: T0, stage: "sent", consentKey: null });
    const port = scriptedPort(); /* the server doesn't answer */
    port.answer("money/deposit-sent", 202, { ok: true, accepted: true });
    act(() => root.render(<YourDeposits onOpen={() => undefined} port={port} services={services} />));
    await settle();
    expect(all("your-deposit-unsent")[0]?.textContent).toMatch(/signed a withdrawal from juno12gdm…783a .* may not have reached Juno/);
    expect(all("your-deposit-local")[0]?.textContent).toMatch(/Cancel escrow/);
    expect(all("your-deposit-local")[0]?.textContent).not.toMatch(/Withdraw/);
    act(() => all("your-deposit-resend")[0].click());
    await settle();
    expect(services.wallet.calls).toContain("broadcast");
    expect(services.pending.all().find((record) => record.txHash === "BC".repeat(32))?.stage).toBe("sent");
  });

  it("is absent when there is nothing, and in a build with no pinned escrow", async () => {
    const services = testServices();
    installMoneyServicesForTests(services);
    const port = scriptedPort();
    port.answer("money/deposits", 200, { ok: true, deposits: [] });
    act(() => root.render(<YourDeposits onOpen={() => undefined} port={port} services={services} />));
    await settle();
    expect(container.innerHTML).toBe("");
    const unpinned = testServices({ pinned: false });
    const quiet = scriptedPort();
    act(() => root.render(<YourDeposits onOpen={() => undefined} port={quiet} services={unpinned} />));
    await settle();
    expect(container.innerHTML).toBe("");
    expect(quiet.requests).toEqual([]);
  });
});
