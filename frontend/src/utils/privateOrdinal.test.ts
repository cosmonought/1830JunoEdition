/** @jest-environment node */
//
// Design note #1370 (harness): a private's number is its auction position, not its catalog id.

import { clearPrivateOrder, numberedPrivate, privateOrdinal, setPrivateOrder } from "./privateOrdinal";
import { withLevelPlayingFieldPrivates, JK_PRIVATE_ID } from "./levelPlayingField";
import { readStripped } from "./sourceScan";

const printed = [
  { private_id: 1, name: "Schuylkill Valley", cost: "20" },
  { private_id: 2, name: "Champlain & St. Lawrence", cost: "40" },
  { private_id: 3, name: "Delaware & Hudson", cost: "70" },
  { private_id: 4, name: "Mohawk & Hudson", cost: "110" },
  { private_id: 5, name: "Camden & Amboy", cost: "160" },
  { private_id: 6, name: "Baltimore & Ohio", cost: "220" },
].map((entry) => ({ ...entry, owner: null, owner_protocol_id: null, closed: false, revenue_per_or: 0 }));

afterEach(() => clearPrivateOrder());

describe("privateOrdinal", () => {
  it("is the id when nothing is registered, and in the printed game", () => {
    expect(privateOrdinal(6)).toBe(6);
    setPrivateOrder(printed);
    for (const entry of printed) expect(privateOrdinal(entry.private_id)).toBe(entry.private_id);
  });

  it("on the Level Playing Field, the JK is fifth and the C&A and B&O move up one", () => {
    setPrivateOrder(withLevelPlayingFieldPrivates(printed as never));
    expect(privateOrdinal(JK_PRIVATE_ID)).toBe(5);
    expect(privateOrdinal(5)).toBe(6); // C&A
    expect(privateOrdinal(6)).toBe(7); // B&O
    expect(privateOrdinal(1)).toBe(1);
    expect(numberedPrivate(JK_PRIVATE_ID, "James River & Kanawha Company")).toBe("5. James River & Kanawha Company");
  });

  it("an id not in play still prints as itself rather than as nothing", () => {
    setPrivateOrder(printed);
    expect(privateOrdinal(42)).toBe(42);
  });
});

describe("every surface that names a private goes through it", () => {
  it.each([
    ["components/PlayerCards.tsx", "numberedPrivate(entry.privateId, entry.name)"],
    ["components/FinancialLedger.tsx", "numberedPrivate(priv.private_id, priv.name)"],
    ["components/PrivateTradePanel.tsx", "numberedPrivate(entry.private_id, entry.name)"],
    ["panels/ContextualActionBar.tsx", "numberedPrivate(priv.private_id, priv.name)"],
    ["components/WaterfallAuctionDashboard.tsx", "privateOrdinal(priv.private_id)"],
    ["components/PrivateRevenueModal.tsx", "privateOrdinal(line.privateId)"],
    ["utils/actionLog.ts", "numberedPrivate(entry.private_id, entry.name)"],
    ["utils/sandboxSession.ts", "numberedPrivate(payout.privateId, payout.privateName)"],
    ["App.tsx", "numberedPrivate(entry.privateId, entry.name)"],
  ])("%s", (file, call) => {
    const code = readStripped(file);
    expect(code).toContain(call);
    expect(code).not.toMatch(/\{(entry|priv|sold|line)\.private_?[iI]d\}\. \{/);
  });

  it("the shell publishes the order in play, during render", () => {
    const APP = readStripped("App.tsx");
    expect(APP).toContain("useMemo(() => setPrivateOrder(gameState?.private_companies ?? []), [privateOrderKey]);");
  });
});
