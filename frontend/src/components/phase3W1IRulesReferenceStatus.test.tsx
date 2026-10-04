/** @jest-environment jsdom */
//
// ==================================================================
//  PHASE 3 W1-I: THE RULES REFERENCE'S STATUS FACTS ARE TRUE
// ==================================================================
//
// AUD-06.07 -- while the operating corporation owes its home station, the shell's cursor reads Lay Track, and the
// reference used to mark Lay Track CURRENT. Rulebook 6.1 / 6.3.1 put the home station before step 1. With
// `homeStationOwed`, the reference marks the home-station pre-step (breadcrumb, Overview note, Operating Round
// aside) and no numbered step; once it is placed, the cursor's step is marked exactly as before.
//
// AUD-01.08 -- the header's build stamp reads the deploy's own id (`CLIENT_BUILD_ID`), not `UI_BUILD_NOTE = 640`.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import RulesReference, { type RulesReferenceProps } from "./RulesReference";
import { CLIENT_BUILD_ID } from "../config";
import { buildStampLabel, UI_BUILD_ID, UI_BUILD_LABEL } from "../utils/buildStamp";
import { readShell, readStripped, sliceBetween } from "../utils/sourceScan";

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
});

const PHASE_2: RulesReferenceProps["phase"] = { label: "Phase 2", tier: "2", trainLimit: 4 };
const OR_AT_TRACK: RulesReferenceProps = {
  roundType: "OperatingRound",
  operatingSubPhase: "Track",
  roundLabel: "OR 1.1",
  activeCorporation: { ticker: "PRR" },
  phase: PHASE_2,
};

function mount(props: RulesReferenceProps) {
  act(() => root.render(<RulesReference {...props} />));
}

const byTestId = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const required = (id: string) => {
  const found = byTestId(id);
  if (!found) throw new Error(`missing ${id}`);
  return found;
};
const crumbs = () => container.querySelector(".rr-crumbs")?.textContent ?? "";
const currentSteps = () => Array.from(container.querySelectorAll('[aria-current="step"]'));
const openOperatingPage = () => act(() => required("rules-page-operating").click());
/** The Operating Round page's numbered stages that carry the CURRENT pill. */
const liveStages = () =>
  Array.from(required("rules-operating-flow").querySelectorAll("button")).filter((stage) =>
    (stage.textContent ?? "").includes("Current"),
  );

describe("while the home station is owed (AUD-06.07)", () => {
  beforeEach(() => mount({ ...OR_AT_TRACK, homeStationOwed: true }));

  it("names the pre-step in the CURRENT breadcrumb, not Lay Track", () => {
    expect(crumbs()).toContain("PRR");
    expect(crumbs()).toContain("Place Home Station");
    expect(crumbs()).not.toContain("Lay Track");
  });

  it("marks the Overview's home-station note as the current step, and nothing else", () => {
    const note = required("rules-overview-home-station");
    expect(note.getAttribute("data-live")).toBe("true");
    expect(note.getAttribute("aria-current")).toBe("step");
    expect(note.textContent).toContain("Current");
    expect(currentSteps()).toEqual([note]);
  });

  it("marks the Operating Round page's home-station aside, and no numbered stage", () => {
    openOperatingPage();
    const aside = required("rules-operating-home-station");
    expect(aside.getAttribute("aria-current")).toBe("step");
    expect(aside.textContent).toContain("Current");
    expect(liveStages()).toHaveLength(0);
  });
});

describe("once it is placed, the cursor's step is marked as before", () => {
  beforeEach(() => mount({ ...OR_AT_TRACK, homeStationOwed: false }));

  it("names Lay Track in the breadcrumb", () => {
    expect(crumbs()).toContain("Lay Track");
    expect(crumbs()).not.toContain("Place Home Station");
  });

  it("leaves the home-station note unmarked", () => {
    const note = required("rules-overview-home-station");
    expect(note.getAttribute("data-live")).toBeNull();
    expect(note.getAttribute("aria-current")).toBeNull();
    expect(note.textContent).not.toContain("Current");
    expect(currentSteps().length).toBeGreaterThan(0);
    expect(currentSteps()).not.toContain(note);
  });

  it("marks Lay Track on the Operating Round page", () => {
    openOperatingPage();
    expect(required("rules-operating-home-station").getAttribute("aria-current")).toBeNull();
    const live = liveStages();
    expect(live).toHaveLength(1);
    expect(live[0].getAttribute("aria-label")).toBe("Jump to Lay Track");
  });

  it("treats an omitted prop as not owed (an existing caller is unaffected)", () => {
    mount(OR_AT_TRACK);
    expect(crumbs()).toContain("Lay Track");
    expect(required("rules-overview-home-station").getAttribute("aria-current")).toBeNull();
  });
});

describe("outside an Operating Round the flag marks nothing", () => {
  it("is ignored in a Stock Round", () => {
    mount({ roundType: "StockRound", roundLabel: "SR2", phase: PHASE_2, homeStationOwed: true });
    expect(crumbs()).not.toContain("Place Home Station");
    expect(byTestId("rules-overview-home-station")).toBeNull();
  });
});

describe("App passes the debt through the mount", () => {
  it("derives it from the same `pendingHomeToken` the prompt reads", () => {
    const MOUNT = sliceBetween(readShell(), "<RulesReference", "roundLabel=");
    expect(MOUNT).toContain("operatingSubPhase={orSubPhase}");
    expect(MOUNT).toContain("homeStationOwed={pendingHomeToken !== null}");
  });
});

describe("the build stamp is the deploy's own id (AUD-01.08)", () => {
  it("renders the label derived from CLIENT_BUILD_ID", () => {
    mount({});
    const stamp = required("rules-build-stamp");
    expect(UI_BUILD_ID).toBe(CLIENT_BUILD_ID);
    expect(stamp.textContent).toBe(UI_BUILD_LABEL);
    expect(stamp.textContent).toBe(buildStampLabel(CLIENT_BUILD_ID));
    expect(stamp.getAttribute("title")).toContain(CLIENT_BUILD_ID);
    expect(stamp.textContent).not.toContain("#640");
  });

  it("shortens a commit SHA for the label and keeps any other id whole", () => {
    expect(buildStampLabel("0123456789abcdef0123456789abcdef01234567")).toBe("Build 0123456789ab");
    expect(buildStampLabel("dev")).toBe("Build dev");
    expect(buildStampLabel("release-2026.10.03")).toBe("Build release-2026.10.03");
  });

  it("has retired the hand-bumped constant", () => {
    expect(readStripped("utils/buildStamp.ts")).not.toContain("UI_BUILD_NOTE");
    expect(readStripped("utils/buildStamp.ts")).toContain("buildStampLabel(UI_BUILD_ID)");
  });
});
