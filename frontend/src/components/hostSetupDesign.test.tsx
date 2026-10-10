/** @jest-environment jsdom */
// frontend/src/components/hostSetupDesign.test.tsx -- PLAY HOST A GAME (approved design, "play-host-waiting-handoff" §3):
// the live Departures row above the steps follows every choice; choosing the table resets step two to its recommended
// defaults while the pace (step one) is kept; Any is first and the default; the Variants grid carries its tags.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { ModalLayerHost } from "./ModalPortal";
import HostSetupCard from "./HostSetupCard";
import { installSessionPort } from "../utils/sessionBootstrap";
import { resetPinnedDeploymentForTests } from "../money/escrowDeployment";
import { scriptedPort, TEST_CONTRACT, TEST_PIN } from "../money/moneyTestSupport";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let layerHost: HTMLDivElement;
let layerRoot: Root;
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  layerHost = document.createElement("div");
  document.body.appendChild(layerHost);
  layerRoot = createRoot(layerHost);
  act(() => layerRoot.render(<ModalLayerHost />));
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  process.env.REACT_APP_ESCROW_DEPLOYMENT = JSON.stringify(TEST_PIN);
  resetPinnedDeploymentForTests();
  const port = scriptedPort();
  port.answer("money/config", 200, {
    ok: true,
    enabled: true,
    why: null,
    reason: null,
    deployment: { backend: "juno-cosmwasm", chainId: "uni-7", networkClass: "testnet", contract: TEST_CONTRACT, codeChecksum: TEST_PIN.codeChecksum, denom: "ujunox", symbol: "JUNOX", exponent: 6 },
    feeBps: 250,
    minAnte: "1000",
  });
  installSessionPort(port);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  act(() => layerRoot.unmount());
  layerHost.remove();
  installSessionPort(null);
  delete process.env.REACT_APP_ESCROW_DEPLOYMENT;
  resetPinnedDeploymentForTests();
});

const settle = async () => {
  await act(async () => {
    for (let n = 0; n < 40; n += 1) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};
const byTestId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const click = (id: string) => act(() => byTestId(id)?.click());
const flap = (id: string) => byTestId(id)?.getAttribute("data-text");

describe("PLAY HOST A GAME: the live Departures row, and the two steps", () => {
  it("builds the row from the choices: edition and bank, host and mode, seats Any or Exactly, the ante", async () => {
    act(() => root.render(<HostSetupCard busy={false} error={null} onClose={() => undefined} onCreate={() => undefined} />));
    await settle();
    const preview = () => byTestId("host-preview")?.textContent ?? "";
    expect(preview()).toContain("How your table will appear on Departures");
    expect(preview()).toContain("(Standard)");
    expect(preview()).toContain("ModeLive");
    expect(preview()).toContain("Any count");
    expect(flap("host-preview-seats")).toBe("1/6");
    click("host-deadline-172800");
    expect(preview()).toContain("ModeAsync: 2d");
    click("host-type-levelPlayingField");
    expect(preview()).toContain("(Long)");
    expect(flap("host-preview-seats")).toBe("1/7");
    click("host-continue");
    await settle();
    click("host-players-4");
    expect(flap("host-preview-seats")).toBe("1/4");
    expect(preview()).toContain("Exactly");
    expect(byTestId("host-preview-ante")?.textContent).toBe("Ante—");
    const input = byTestId("host-stake-amount") as HTMLInputElement;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "10");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(byTestId("host-preview-ante")?.textContent).toBe("Ante10 JUNOX");
    expect(byTestId("host-stake-summary")?.textContent).toBe("Each seat deposits 10 JUNOX; the 2.5% developer fee (0.25 JUNOX) isn't refunded. You can change the ante in the waiting room until the first deposit.");
    expect(byTestId("host-create-why")?.textContent).toBe("Creating the table moves no money. You open it on Juno with your own ante from the waiting room.");
  });

  it("offers Any first and by default, exact counts to the board's seats, and the tagged Variants", async () => {
    act(() => root.render(<HostSetupCard busy={false} error={null} onClose={() => undefined} onCreate={() => undefined} />));
    await settle();
    click("host-type-plus");
    click("host-continue");
    await settle();
    const counts = Array.from(byTestId("host-player-count")!.querySelectorAll('[role="radio"]')).map((node) => node.getAttribute("data-testid"));
    expect(counts).toEqual(["host-players-any", "host-players-2", "host-players-3", "host-players-4", "host-players-5", "host-players-6"]);
    expect(byTestId("host-players-any")?.getAttribute("aria-checked")).toBe("true");
    expect(byTestId("host-players-any")?.textContent).toBe("Anyup to 6");
    /* 18XX+ recommends the tile tray, and it is on. */
    expect((byTestId("host-plus-tiles") as HTMLInputElement).checked).toBe(true);
    expect(document.querySelector(".rh-toggle .rh-vt.rh-recommended")?.textContent).toBe("recommended");
    expect(Array.from(document.querySelectorAll(".rh-toggle .rh-vt")).map((tag) => tag.textContent)).toEqual(["recommended", "easier", "riskier", "harder", "chaotic"]);
    expect(Array.from(byTestId("host-bank-size")!.querySelectorAll("small")).map((s) => s.textContent)).toEqual(["Short", "Standard", "Long"]);
  });

  it("resets step two to the table's recommended defaults when the table changes, and keeps the pace", async () => {
    act(() => root.render(<HostSetupCard busy={false} error={null} onClose={() => undefined} onCreate={() => undefined} />));
    await settle();
    click("host-deadline-604800");
    click("host-continue");
    await settle();
    click("host-bank-short");
    act(() => byTestId("host-rule-gentleRust")?.click());
    expect(byTestId("host-bank-short")?.getAttribute("aria-checked")).toBe("true");
    act(() => (Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "Back") as HTMLButtonElement).click());
    await settle();
    /* The same table again changes nothing. */
    click("host-type-standard");
    click("host-continue");
    await settle();
    expect(byTestId("host-bank-short")?.getAttribute("aria-checked")).toBe("true");
    act(() => (Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "Back") as HTMLButtonElement).click());
    await settle();
    click("host-type-levelPlayingField");
    expect(byTestId("host-pace-async")?.getAttribute("aria-checked")).toBe("true");
    expect(byTestId("host-deadline-604800")?.getAttribute("aria-checked")).toBe("true");
    click("host-continue");
    await settle();
    expect(byTestId("host-bank-long")?.getAttribute("aria-checked")).toBe("true");
    expect(byTestId("host-bank-long")?.textContent).toBe("$20,000Long · recommended");
    expect((byTestId("host-rule-gentleRust") as HTMLInputElement).checked).toBe(false);
    expect(byTestId("host-plus-tiles")).toBeNull();
    expect(document.body.textContent).toContain("The Level Playing Field brings its own tile tray.");
  });
});
