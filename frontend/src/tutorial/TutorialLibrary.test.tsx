/** @jest-environment jsdom */
// frontend/src/tutorial/TutorialLibrary.test.tsx -- PHASE 3 FINAL PLAY TUTORIAL: the library and its two settings,
// plus the shell hook's SETTINGS behaviour (`useTutorialSystem`).

import React, { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ModalLayerHost } from "../components/ModalPortal";
import { TutorialLibrary } from "./TutorialLibrary";
import { LIBRARY_TOPICS, lessonById } from "./lessons";
import { useTutorialSystem, type TutorialSystem } from "./useTutorialSystem";
import { TUTORIAL_AUTO_KEY, TUTORIAL_STORAGE_PREFIX } from "./tutorialLedger";
import type { TutorialBlockers } from "./coordinator";
import type { GameStateResponse } from "../gameEngine/gameState";

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

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  window.localStorage.clear();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root.render(
      <>
        <ModalLayerHost />
      </>,
    ),
  );
});
/** As the shell: the modal layer is committed first, and stays put while surfaces mount beside it. */
function mount(node: React.ReactNode) {
  act(() =>
    root.render(
      <>
        <ModalLayerHost />
        {node}
      </>,
    ),
  );
}
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const button = (label: RegExp) =>
  Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((node) => label.test(node.textContent ?? ""))!;
const byTestId = <T extends HTMLElement>(id: string) => document.querySelector<T>(`[data-testid='${id}']`)!;

describe("the library", () => {
  function Library({ onRestart }: { onRestart: (() => void) | null }) {
    const [auto, setAuto] = useState(true);
    const [open, setOpen] = useState(true);
    return (
      <>
        <TutorialLibrary
          open={open}
          onClose={() => setOpen(false)}
          scope={{}}
          auto={auto}
          onSetAuto={setAuto}
          onRestart={onRestart}
          restartUnavailableReason="Watchers can read every topic here."
        />
      </>
    );
  }

  it("is a native dialog listing every topic; a topic shows the registry's own lessons", () => {
    mount(<Library onRestart={() => undefined} />);
    const dialog = document.querySelector("dialog[open]")!;
    expect(dialog.getAttribute("aria-label")).toBe("Tutorials");
    for (const topic of LIBRARY_TOPICS) expect(byTestId(`tutorial-topic-${topic.id}`).textContent).toContain(topic.heading);
    act(() => byTestId("tutorial-topic-operating").click());
    const shown = Array.from(document.querySelectorAll("[data-lesson]")).map((node) => node.getAttribute("data-lesson"));
    expect(shown).toEqual(LIBRARY_TOPICS.find((topic) => topic.id === "operating")!.lessons);
    expect(byTestId("tutorial-library-topic").textContent).toContain(lessonById("operating.primer")!.summary);
    act(() => button(/^All topics$/).click());
    expect(byTestId("tutorial-topic-money")).not.toBeNull();
  });

  it("reading acknowledges nothing and writes nothing", () => {
    mount(<Library onRestart={() => undefined} />);
    act(() => byTestId("tutorial-topic-stock").click());
    expect(Object.keys(window.localStorage)).toEqual([]);
  });

  it("automatic tutorials: On, Off and On again", () => {
    mount(<Library onRestart={() => undefined} />);
    const toggle = () => byTestId<HTMLInputElement>("tutorial-auto-toggle");
    expect(toggle().checked).toBe(true);
    expect(document.body.textContent).toContain("Automatic tutorials: On");
    act(() => toggle().click());
    expect(document.body.textContent).toContain("Automatic tutorials: Off");
    act(() => toggle().click());
    expect(document.body.textContent).toContain("Automatic tutorials: On");
  });

  it("restart is offered to a seated player, and explained away for a watcher", () => {
    const restarts: number[] = [];
    mount(<Library onRestart={() => restarts.push(1)} />);
    act(() => byTestId("tutorial-restart").click());
    expect(restarts).toEqual([1]);
    expect(document.body.textContent).toContain("Restarted: the tutorials for this game begin again.");
    mount(<Library onRestart={null} />);
    expect(byTestId<HTMLButtonElement>("tutorial-restart").disabled).toBe(true);
    expect(document.body.textContent).toContain("Watchers can read every topic here.");
  });

  it("closes from its Close button", () => {
    mount(<Library onRestart={() => undefined} />);
    act(() => byTestId("tutorial-library-close").click());
    expect(document.querySelector("dialog[open]")).toBeNull();
  });
});

/* ---------------------------------------------------------------- the shell hook: SETTINGS */

const KEY = `${TUTORIAL_STORAGE_PREFIX}g_test.seat0`;
const CLEAR: TutorialBlockers = { cinematic: false, nativeDialogOpen: false, forcedNoticeDue: false, boardInteraction: false, scrubbing: false };
let system: TutorialSystem;

function Harness({ seated = true, state = null }: { seated?: boolean; state?: GameStateResponse | null }) {
  system = useTutorialSystem({ storageKey: KEY, seated, viewer: "p-owner", state, blockers: CLEAR });
  return <span data-testid="presented">{system.presented?.id ?? ""}</span>;
}
const presented = () => byTestId("presented").textContent;

describe("useTutorialSystem: settings", () => {
  it("automatic tutorials default ON and a raised lesson shows", () => {
    mount(<Harness />);
    expect(system.auto).toBe(true);
    act(() => system.raise([{ id: "orientation.goal" }]));
    expect(presented()).toBe("orientation.goal");
  });

  it("turning them off hides and withdraws what waits, ignores new lessons, and can be turned back on", () => {
    mount(<Harness />);
    act(() => system.raise([{ id: "orientation.goal" }]));
    act(() => system.setAuto(false));
    expect(presented()).toBe("");
    expect(window.localStorage.getItem(TUTORIAL_AUTO_KEY)).toBe("off");
    act(() => system.raise([{ id: "orientation.flow" }]));
    act(() => system.setAuto(true));
    expect(presented()).toBe(""); // nothing skipped comes back as a backlog
    act(() => system.raise([{ id: "orientation.flow" }]));
    expect(presented()).toBe("orientation.flow");
    expect(system.ledger.isAcknowledged("orientation.goal")).toBe(false); // off is not "answered"
  });

  it("acknowledging moves to the next lesson; restart brings the orientation back for this game", () => {
    mount(<Harness />);
    act(() => system.raise([{ id: "orientation.goal" }, { id: "orientation.flow" }]));
    act(() => system.acknowledge());
    expect(presented()).toBe("orientation.flow");
    act(() => system.acknowledge());
    expect(presented()).toBe("");
    act(() => system.raise([{ id: "orientation.goal" }]));
    expect(presented()).toBe(""); // answered once, never again in this game
    act(() => system.restart());
    expect(presented()).toBe("orientation.goal");
  });

  it("a watcher is never raised anything", () => {
    mount(<Harness seated={false} />);
    act(() => system.raise([{ id: "orientation.goal" }]));
    expect(presented()).toBe("");
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  it("another tab's answer reaches this one", () => {
    mount(<Harness />);
    act(() => system.raise([{ id: "orientation.goal" }]));
    const stored = JSON.parse(window.localStorage.getItem(KEY)!);
    window.localStorage.setItem(KEY, JSON.stringify({ ...stored, acknowledged: ["orientation.goal"], pending: [] }));
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: KEY }));
    });
    expect(presented()).toBe("");
  });
});
