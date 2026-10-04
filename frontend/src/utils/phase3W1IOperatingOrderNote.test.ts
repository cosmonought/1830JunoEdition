/** @jest-environment node */
//
// PHASE 3 W1-I (P3-N016): `operatingOrderView.ts`'s note no longer claims the operating queue is "frozen for the
// whole round, which is 1830's rule". The engine re-sorts the waiting corporations when a share value moves
// (#1600, `settleOperatingQueue`), and whether that matches the printed game is the Phase-4 playtest row U-34. The
// claim lives in a comment, so the absence is asserted on the RAW text (#490a's other half).

import { readSource, readStripped } from "./sourceScan";

const RAW = readSource("utils/operatingOrderView.ts");

describe("the operating-order note says what the engine does", () => {
  it("drops the frozen-queue claim and the rules attribution", () => {
    expect(RAW).not.toContain("frozen for the whole round");
    expect(RAW).not.toContain("1830's rule");
    expect(RAW).not.toContain("round's frozen queue");
  });

  it("names the settle point that re-sorts the waiting corporations, and the open playtest row", () => {
    expect(RAW).toContain("settleOperatingQueue");
    expect(RAW).toContain("U-34");
  });

  it("is still a reader of the queue (the fix the note defends)", () => {
    expect(readStripped("gameEngine/operatingOrder.ts")).toContain("export function settleOperatingQueue(");
    expect(readStripped("utils/operatingOrderView.ts")).toContain("(state.active_operating_order ?? []).forEach(");
  });
});
