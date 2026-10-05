/** @jest-environment jsdom */
// frontend/src/components/noticeChain.test.tsx -- W3-A / OD-5(b)+(c)+(d): AUD-01.03, AUD-01.06, AUD-13.02, AUD-13.07.
//
// THE REAL NOTICES, DRIVEN BY THE REAL CHAIN. `useNoticeChain` and the five notice components below are the shell's
// own, mounted the way the shell mounts them: each one handed its notice only when the chain presents it, the
// heading beside them, and a tutorial mounted as the shell mounts it -- OUTSIDE the chain (owner ruling OD-5: the
// forced-notice chain is Emergency, Fleet Loss, Private Revenue, Phase Three, Herald; Tutorial is not part of it.
// The consolidated integration, 2026-10-05, removed the sixth entry W3-A had added). No test in this repository renders `AppShell`
// (it needs a room, a link and a reducer); `noticeChainShellWiring` below pins that the shell is wired exactly this
// way, which is the one part a render here cannot see.
//
// THE EMERGENCY IS A STAND-IN: the real `EmergencyTrainPurchaseModal` needs a v13 funding plan to render at all.
// The stand-in is the same `NativeModal` contract the real one uses -- non-dismissible, no restore, `chainedNotice`
// -- which is everything the chain reads. Its own behaviour is W2-G's suites'.
//
// jsdom 16.7 has `HTMLDialogElement` without `showModal` / `close`, so they are stubbed to toggle `open`, as
// `nativeModalBoundary.test.tsx` does.

import React, { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";

import { ModalLayerHost } from "./ModalPortal";
import { NativeModal } from "./NativeModal";
import FleetLossModal from "./FleetLossModal";
import PrivateRevenueModal from "./PrivateRevenueModal";
import PhaseThreeNoticeModal from "./PhaseThreeNoticeModal";
import HeraldHomeFloatModal from "./HeraldHomeFloatModal";
import TutorialModal from "./TutorialModal";
import GameScreenHeading, { GAME_SCREEN_HEADING_TEXT } from "./GameScreenHeading";
import BoardBehindNotice from "./BoardBehindNotice";
import GameOverModal from "./GameOverModal";
import { NativeModalTurn } from "./NativeModalTurn";
import { useNoticeChain } from "../utils/useNoticeChain";
import { NOTICE_PRIORITY } from "../utils/noticeChain";
import { openNativeModalCount } from "../utils/nativeModalRegistry";
import { readShell, readStripped, sliceBetween } from "../utils/sourceScan";
import type { FleetLossNotice } from "../utils/fleetLossNotice";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
global.IS_REACT_ACT_ENVIRONMENT = true;

type DialogStubProto = { showModal?: () => void; close?: () => void };
const proto = window.HTMLDialogElement.prototype as unknown as DialogStubProto;
beforeAll(() => {
  proto.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  proto.close = function close(this: HTMLDialogElement) {
    this.removeAttribute("open");
  };
});
afterAll(() => {
  delete proto.showModal;
  delete proto.close;
});

const FLEET: FleetLossNotice = { companyId: 3, ticker: "PRR", cause: "rust", trains: ["2"], arrivingTier: "4", trainLimit: null };
const ROUND = {
  viewerName: "Ann",
  viewerSeatColor: null,
  lines: [{ privateId: 1, label: "Schuylkill Valley", value: "$5" }],
  total: 5,
  cashBefore: 100,
  cashAfter: 105,
  others: [],
};
const HERALD = { companyId: 3, ticker: "PRR", hexLabel: "H12", place: "Altoona (H12)", revenue: 10, firstTokenCost: 40 };
const TOPIC = "w3a-test-topic";
const TUTORIAL_HEADING = "A test tutorial";

type Due = {
  emergency: boolean;
  fleet: FleetLossNotice | null;
  revenue: typeof ROUND | null;
  phaseThree: boolean;
  herald: typeof HERALD | null;
  tutorialActive: boolean;
  foreign: boolean;
  gameOver: boolean;
  selfOpening: boolean;
  /** The consolidated integration's pins: the shell covered by a cinematic takeover (`inert`), and W3-J's stale-board
   *  notice standing. */
  covered: boolean;
  boardBehind: boolean;
  tick: number;
};
const NOTHING: Due = {
  emergency: false,
  fleet: null,
  revenue: null,
  phaseThree: false,
  herald: null,
  tutorialActive: false,
  foreign: false,
  gameOver: false,
  selfOpening: false,
  covered: false,
  boardBehind: false,
  tick: 0,
};

let update: (patch: Partial<Due>) => void = () => undefined;

function Shell({ initial }: { initial: Due }) {
  const [due, setDue] = useState(initial);
  update = (patch) => setDue((current) => ({ ...current, ...patch }));
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const { presented } = useNoticeChain(
    {
      emergency: due.emergency,
      fleetLoss: due.fleet !== null,
      privateRevenue: due.revenue !== null,
      phaseThree: due.phaseThree,
      herald: due.herald !== null,
    },
    headingRef,
  );
  return (
    <>
      <button type="button" data-testid="board-control" data-tick={due.tick}>
        Lay track
      </button>
      {/* As the shell: the heading inside the root W3-D makes `inert` while a cinematic takeover covers it. */}
      <div {...(due.covered ? { inert: "" } : {})} data-testid="shell-root">
        <GameScreenHeading ref={headingRef} />
      </div>
      <BoardBehindNotice
        notice={due.boardBehind ? "This board is behind the room." : null}
        onReload={() => update({ boardBehind: false })}
        onLeave={() => update({ boardBehind: false })}
      />
      {due.foreign && (
        <NativeModal name="Market peek" dismissible onDismiss={() => update({ foreign: false })} restoreOpener scrimStyle={{}}>
          <button type="button" onClick={() => update({ foreign: false })}>
            Close peek
          </button>
        </NativeModal>
      )}
      <GameOverModal
        reason={due.gameOver ? "bank-broken" : null}
        standings={[]}
        viewerAddress={null}
        bankruptLabel={null}
        onDismiss={() => update({ gameOver: false })}
        onCloseRoom={null}
        autoCloseIn={null}
        roomClosed={false}
      />
      {due.selfOpening && (
        <NativeModalTurn>
          <NativeModal name="Set the B&O par value" dismissible={false} restoreOpener={false} scrimStyle={{}}>
            <p>Par</p>
          </NativeModal>
        </NativeModalTurn>
      )}
      {presented === "emergency" && (
        <NativeModal name="Emergency Train Purchase" dismissible={false} restoreOpener={false} chainedNotice scrimStyle={{}}>
          <p>Mandatory</p>
        </NativeModal>
      )}
      <FleetLossModal notice={presented === "fleetLoss" ? due.fleet : null} onAcknowledge={() => update({ fleet: null })} />
      <PrivateRevenueModal
        round={presented === "privateRevenue" ? due.revenue : null}
        roundLabel="OR 2.1"
        onAcknowledge={() => update({ revenue: null })}
      />
      <PhaseThreeNoticeModal open={presented === "phaseThree"} onAcknowledge={() => update({ phaseThree: false })} />
      <HeraldHomeFloatModal
        notice={presented === "herald" ? due.herald : null}
        liveryColor="#000"
        liveryInk="#fff"
        onDismiss={() => update({ herald: null })}
      />
      <TutorialModal
        topicKey={TOPIC}
        heading={TUTORIAL_HEADING}
        pages={[{ title: "One", body: "The only page." }]}
        active={due.tutorialActive}
      />
    </>
  );
}

let host: HTMLDivElement;
let root: Root;

/** The layer first, in its own commit -- `ModalPortal` looks the layer up while it renders, and `GameRouter` has
 *  always rendered it before any table exists. */
function render(initial: Due) {
  act(() => {
    root.render(
      <>
        <ModalLayerHost />
      </>,
    );
  });
  act(() => {
    root.render(
      <>
        <ModalLayerHost />
        <Shell initial={initial} />
      </>,
    );
  });
}

/** Every surface on screen that covers the page: open native dialogs and ARIA modal divs (the tutorial). */
function surfaces(): string[] {
  const native = Array.from(document.querySelectorAll<HTMLDialogElement>("dialog[open]")).map(
    (node) => node.getAttribute("aria-label") ?? "(unnamed dialog)",
  );
  const aria = Array.from(document.querySelectorAll<HTMLElement>("[role='dialog'][aria-modal='true']")).map(
    (node) => node.getAttribute("aria-label") ?? "(unnamed modal)",
  );
  return [...native, ...aria];
}

function click(label: RegExp) {
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((node) => label.test(node.textContent ?? ""));
  if (!button) throw new Error(`no button matching ${label}`);
  act(() => {
    button.click();
  });
}

const heading = () => document.querySelector<HTMLHeadingElement>("[data-testid='game-screen-heading']");

beforeEach(() => {
  window.localStorage.clear();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  expect(openNativeModalCount()).toBe(0); // every registration was released
});

describe("AUD-01.03 / OD-5(b): the game screen has a stable, accessible heading", () => {
  it("is a real level-1 heading, programmatically focusable, never a Tab stop, out of the layout", () => {
    render(NOTHING);
    const node = heading();
    expect(node?.tagName).toBe("H1");
    expect(node?.textContent).toBe(GAME_SCREEN_HEADING_TEXT);
    expect(node?.tabIndex).toBe(-1);
    expect(node?.style.position).toBe("absolute");
    expect(node?.style.width).toBe("1px");
    act(() => node?.focus());
    expect(document.activeElement).toBe(node);
  });
});

describe("8-10. AUD-13.07 / OD-5(c): forced notices present one at a time, in the ruled order", () => {
  it("is the ruled order -- five forced notices; Tutorial is not one of them (owner ruling OD-5)", () => {
    expect([...NOTICE_PRIORITY]).toEqual(["emergency", "fleetLoss", "privateRevenue", "phaseThree", "herald"]);
    expect(NOTICE_PRIORITY as readonly string[]).not.toContain("tutorial");
  });

  it("with all five due at once, presents each alone and advances on each answer", () => {
    render({ ...NOTHING, emergency: true, fleet: FLEET, revenue: ROUND, phaseThree: true, herald: HERALD });
    const seen: string[][] = [];
    seen.push(surfaces());
    act(() => update({ emergency: false })); // the obligation is met: nothing to click on a forced workflow
    seen.push(surfaces());
    click(/Continue to PRR's turn/);
    seen.push(surfaces());
    click(/Begin operations/);
    seen.push(surfaces());
    click(/^Got it$/);
    seen.push(surfaces());
    click(/Understood/);
    seen.push(surfaces());
    expect(seen.map((step) => step.length)).toEqual([1, 1, 1, 1, 1, 0]);
    expect(seen[0]).toEqual(["Emergency Train Purchase"]);
    expect(seen[1]).toEqual(["PRR lost one train to rust"]); // Fleet Loss names itself by its headline
    expect(seen[2]).toEqual(["Private company payouts"]);
    expect(seen[3]).toEqual(["Phase 3: private companies are for sale"]);
    expect(seen[4]).toEqual(["PRR has floated"]);
  });

  it("a higher notice raised while a lower one is up takes the screen; the lower one waits, unanswered", () => {
    render({ ...NOTHING, phaseThree: true });
    expect(surfaces()).toEqual(["Phase 3: private companies are for sale"]);
    act(() => update({ fleet: FLEET }));
    expect(surfaces()).toHaveLength(1);
    expect(surfaces()[0]).toMatch(/PRR/);
    click(/Continue to PRR's turn/);
    expect(surfaces()).toEqual(["Phase 3: private companies are for sale"]);
  });

  it("a tutorial is not part of the chain: the chain neither holds it nor waits for it (owner ruling OD-5)", () => {
    /* The consolidated integration's correction of W3-A's sixth entry. A tutorial keeps the presentation it had before
       W3-A -- it opens on its own arming -- until the final tutorial pass replaces it. The co-presence below is that
       pre-W3-A presentation, asserted only to prove the chain neither holds nor waits for the tutorial; it is not a
       design for how a tutorial and a forced notice should share the screen (the final tutorial pass decides that). */
    render({ ...NOTHING, herald: HERALD, tutorialActive: true });
    expect(surfaces()).toContain("PRR has floated");
    expect(surfaces()).toContain(TUTORIAL_HEADING);
    click(/Understood/);
    expect(surfaces()).toEqual([TUTORIAL_HEADING]); // the chain ended; the tutorial is still the player's to answer
    expect(window.localStorage.getItem(`1830juno.tutorial_seen.v1.${TOPIC}`)).toBeNull();
  });
});

describe("10. AUD-13.07: no notice stacks with another native dialog", () => {
  it("every notice -- the emergency included -- waits while a dialog that is not a notice is open", () => {
    render({ ...NOTHING, foreign: true, emergency: true, fleet: FLEET });
    expect(surfaces()).toEqual(["Market peek"]);
    click(/Close peek/);
    expect(surfaces()).toEqual(["Emergency Train Purchase"]);
  });

  it("a notice on screen gives way to a dialog that opens over it, and comes back unanswered", () => {
    render({ ...NOTHING, revenue: ROUND });
    expect(surfaces()).toEqual(["Private company payouts"]);
    act(() => update({ foreign: true }));
    expect(surfaces()).toEqual(["Market peek"]);
    click(/Close peek/);
    expect(surfaces()).toEqual(["Private company payouts"]);
  });
});

describe("10. AUD-13.07: a dialog that opens itself waits for the screen (NativeModalTurn)", () => {
  it("Game Over arriving over a dialog the player opened waits, then opens alone", () => {
    render({ ...NOTHING, foreign: true });
    act(() => update({ gameOver: true }));
    expect(surfaces()).toEqual(["Market peek"]);
    click(/Close peek/);
    expect(surfaces()).toEqual(["Game Over"]);
  });

  it("two dialogs that open themselves in the same moment do not stack: the first claims, the second waits", () => {
    render({ ...NOTHING, gameOver: true, selfOpening: true });
    expect(surfaces()).toHaveLength(1);
    expect(surfaces()[0]).toBe("Game Over");
  });

  it("a self-opening dialog and a forced notice due together never share the screen, and the notice comes back", () => {
    render({ ...NOTHING, selfOpening: true, phaseThree: true });
    expect(surfaces()).toHaveLength(1);
    act(() => update({ selfOpening: false }));
    expect(surfaces()).toEqual(["Phase 3: private companies are for sale"]);
  });

  it("a notice already on screen keeps it; the self-opening dialog waits for its answer", () => {
    render({ ...NOTHING, phaseThree: true });
    act(() => update({ gameOver: true }));
    expect(surfaces()).toEqual(["Phase 3: private companies are for sale"]);
    click(/^Got it$/);
    expect(surfaces()).toEqual(["Game Over"]);
  });
});

describe("11-12. AUD-13.02 / OD-5(b): where focus lands, and when it does not move", () => {
  it("after the chain is exhausted, focus is on the game-screen heading", () => {
    render({ ...NOTHING, fleet: FLEET, revenue: ROUND });
    expect(document.activeElement?.textContent).toMatch(/Continue to PRR's turn/); // the notice's own autoFocus
    click(/Continue to PRR's turn/);
    expect(document.activeElement).not.toBe(heading()); // the chain is not over: the payout is up
    click(/Begin operations/);
    expect(document.activeElement).toBe(heading());
  });

  it("lands on the heading after a notice that restores its opener, too (Phase 3, Herald)", () => {
    render(NOTHING);
    const control = document.querySelector<HTMLButtonElement>("[data-testid='board-control']");
    act(() => control?.focus());
    act(() => update({ herald: HERALD }));
    click(/Understood/);
    expect(document.activeElement).toBe(heading());
  });

  it("a notice that is only held behind another dialog has not ended the chain", () => {
    render({ ...NOTHING, revenue: ROUND });
    act(() => update({ foreign: true }));
    expect(document.activeElement).not.toBe(heading());
    click(/Close peek/);
    click(/Begin operations/);
    expect(document.activeElement).toBe(heading());
  });

  it("mounting the table takes no focus, and neither does a notice that came and went while held", () => {
    const outside = document.createElement("button");
    outside.textContent = "Lobby control";
    document.body.appendChild(outside);
    outside.focus();
    render(NOTHING);
    expect(document.activeElement).toBe(outside);
    // A notice due only while a foreign dialog is up, then no longer due: it was never shown, so nothing ended.
    act(() => update({ foreign: true, herald: HERALD }));
    act(() => update({ herald: null }));
    click(/Close peek/);
    expect(document.activeElement).not.toBe(heading());
    outside.remove();
  });

  it("ordinary gameplay never takes focus: nothing shown, nothing moved -- and a finished chain does not move it again", () => {
    render(NOTHING);
    const control = document.querySelector<HTMLButtonElement>("[data-testid='board-control']");
    act(() => control?.focus());
    for (let tick = 1; tick <= 5; tick += 1) act(() => update({ tick }));
    expect(document.activeElement).toBe(control);
    act(() => update({ phaseThree: true }));
    click(/^Got it$/);
    expect(document.activeElement).toBe(heading());
    act(() => control?.focus());
    for (let tick = 6; tick <= 10; tick += 1) act(() => update({ tick }));
    expect(document.activeElement).toBe(control);
  });
});

describe("6-7. AUD-01.06 (INTERIM): the zero-state auto-reset is gone -- not the tutorial redesign", () => {
  /* W3-A removed design note #301's effect, which cleared every tutorial's seen flag on each zero-state mount (the
     default scenario). That removal is kept; it is a known bad auto-reset gone, nothing more. The tutorial system and
     its re-arm policy are the FINAL tutorial pass's (owner ruling OD-5): the existing seen flags simply stay set. */
  it("an answered tutorial does not come back on a zero-state remount, nor when its round becomes active again", () => {
    render({ ...NOTHING, tutorialActive: true });
    expect(surfaces()).toEqual([TUTORIAL_HEADING]);
    click(/^Got it$/);
    expect(surfaces()).toEqual([]);
    // A remount of the shell in its zero state -- what every table, reload and remount used to be.
    act(() => root.unmount());
    root = createRoot(host);
    render({ ...NOTHING, tutorialActive: true });
    expect(surfaces()).toEqual([]);
    // A later game: the round becomes active again in a fresh shell.
    act(() => update({ tutorialActive: false }));
    act(() => update({ tutorialActive: true }));
    expect(surfaces()).toEqual([]);
  });
});

describe("consolidated integration (2026-10-05): surfaces the chain did not meet on W3-A's branch", () => {
  it("the chain ending while an interim tutorial is still up does not move focus behind it", () => {
    /* Tutorial left the forced-notice chain (owner ruling OD-5), so the chain can end with a tutorial's aria-modal card
       on screen. Focusing the heading then would put focus BEHIND that card. */
    render({ ...NOTHING, herald: HERALD, tutorialActive: true });
    click(/Understood/);
    expect(surfaces()).toEqual([TUTORIAL_HEADING]);
    expect(document.activeElement).not.toBe(heading());
  });

  it("the chain ending while a cinematic takeover makes the shell inert does not focus into the inert subtree", () => {
    render({ ...NOTHING, covered: true, herald: HERALD });
    click(/Understood/);
    expect(heading()?.closest("[inert]")).not.toBeNull();
    expect(document.activeElement).not.toBe(heading());
  });

  it("the chain still moves focus once when nothing else has the screen", () => {
    render({ ...NOTHING, herald: HERALD });
    click(/Understood/);
    expect(document.activeElement).toBe(heading());
  });

  it("the stale-board notice is the one deliberate exception: foreign, it holds every forced notice, the emergency included", () => {
    render({ ...NOTHING, boardBehind: true, emergency: true, herald: HERALD });
    // The stale-board dialog is named by its heading (`aria-labelledby`), so `surfaces()` reads it unnamed.
    expect(surfaces()).toEqual(["(unnamed dialog)"]);
    expect(document.getElementById("board-behind-title")?.closest("dialog[open]")).not.toBeNull();
    click(/Reload/);
    expect(surfaces()).toEqual(["Emergency Train Purchase"]);
  });

  it("the stale-board notice opens at once, over a dialog that already holds the screen (fail-closed, OD-19)", () => {
    render({ ...NOTHING, foreign: true });
    act(() => update({ boardBehind: true }));
    expect(surfaces()).toEqual(["Market peek", "(unnamed dialog)"]);
    expect(document.getElementById("board-behind-title")?.closest("dialog[open]")).not.toBeNull();
  });
});

describe("noticeChainShellWiring: the shell mounts every forced notice through the chain", () => {
  /* SHELL WIRING, the one part a render here cannot reach (see the header). Read through `readShell()`. */
  const APP = readShell();

  it("asks the chain, hands each notice its turn, and puts the heading on the game screen", () => {
    expect(APP).toContain("const { presented: presentedNotice } = useNoticeChain(");
    expect(APP).toContain('plan={presentedNotice === "emergency" ? emergencyModalPlan : null}');
    expect(APP).toContain('notice={presentedNotice === "fleetLoss" ? dueFleetNotice : null}');
    expect(APP).toContain('round={presentedNotice === "privateRevenue" ? privatePayoutPhase : null}');
    expect(APP).toContain('open={presentedNotice === "phaseThree"}');
    expect(APP).toContain('notice={presentedNotice === "herald" ? heraldFloatNotice : null}');
    expect(APP).toContain("<GameScreenHeading ref={gameScreenHeadingRef} />");
  });

  it("does not put the tutorials in the chain (owner ruling OD-5; the consolidated integration's correction)", () => {
    expect(APP).not.toContain("presentedTutorial");
    expect(APP).not.toContain("TUTORIAL_CHAIN_ORDER");
    expect(APP).not.toContain("handleTutorialOpenChange");
    const modal = readStripped("components/TutorialModal.tsx");
    expect(modal).not.toContain("onOpenChange");
    expect(modal).not.toContain("held?: boolean");
  });

  it("feeds the chain the ruled due notices, an answered one never due", () => {
    const chain = sliceBetween(APP, "const { presented: presentedNotice } = useNoticeChain(", "gameScreenHeadingRef,\n  );");
    expect(chain).toContain('emergency: emergencyModalPlan !== null && emergencyModalPlan.stage !== "legacy"');
    expect(chain).toContain("!noticeLedger.isAcknowledged(noticeDismissKey(dueFleetNotice))");
    expect(chain).toContain("!noticeLedger.isAcknowledged(privateRevenueNoticeKey(privatePayoutPhase.roundLabel))");
    expect(chain).toContain("!noticeLedger.isAcknowledged(PHASE_THREE_NOTICE_KEY)");
    expect(chain).toContain("!noticeLedger.isAcknowledged(heraldFloatNoticeKey(heraldFloatNotice.companyId))");
    expect(chain).not.toContain("tutorial:");
  });

  it("review fixes: cross-tab answers drop from the fleet queue; nothing is stored before the record is known; Phase 3 is armed after the load", () => {
    const storage = sliceBetween(APP, "const onStorage = (event: StorageEvent) => {", 'window.addEventListener("storage", onStorage);');
    expect(storage).toContain("!noticeLedger.isAcknowledged(noticeDismissKey(notice))");
    expect(storage).toContain("setPendingFleetNotices(open);");
    expect(APP).toMatch(/if \(!noticeLedgerStorageKey\) return;\s*for \(const notice of pendingFleetNotices\)/);
    expect(APP).toContain("payload: privateRevenuePayloadForStorage(");
    expect(APP).toContain("if (president !== null && viewerAddress !== null && president !== viewerAddress) continue;");
    expect(APP).toContain("if (!phaseThreeEdgeArmedRef.current) return;");
    const arming = sliceBetween(APP, "initialHistoryLoadRef.current = sandboxRoomCode !== null && sandboxAppliedCount === 0;", "}, [sandboxRoomCode, sandboxAppliedCount, currentPhase]);");
    expect(arming).toContain("phaseThreeEdgeArmedRef.current = true;");
    expect(arming).toContain("previousPhaseTier.current = currentPhase?.known ? currentPhase.tier : null;");
  });

  it("the dialogs that open themselves wait for the screen", () => {
    for (const file of ["components/GameOverModal.tsx", "components/AuctionPromptModal.tsx", "components/PrivatePowerFlowModal.tsx"]) {
      expect([file, readStripped(file).includes("<NativeModalTurn>")]).toEqual([file, true]);
    }
  });

  it("AUD-01.06: nothing in the shell re-arms the tutorials", () => {
    expect(APP).not.toMatch(/replayTutorials\s*\(/);
    expect(APP).not.toMatch(/resetTutorials\s*\(/);
  });

  it("every forced notice's dialog is marked as the chain's own, so it is not taken for a foreign dialog", () => {
    for (const file of [
      "components/EmergencyTrainPurchaseModal.tsx",
      "components/FleetLossModal.tsx",
      "components/PrivateRevenueModal.tsx",
      "components/PhaseThreeNoticeModal.tsx",
      "components/HeraldHomeFloatModal.tsx",
    ]) {
      expect([file, readStripped(file).includes("chainedNotice")]).toEqual([file, true]);
    }
  });
});

void React;
