/** @jest-environment jsdom */
//
// ==================================================================
//  PHASE 3 W1-I (AUD-01.04 / A-14, P3-N015): THE DOCK OBSERVER'S LIFECYCLE, AND THE DOCK'S LANDMARK
// ==================================================================
//
// THE BUG WAS A LIFECYCLE, so this suite drives one. A room's shell renders a gate page first; the old effect ran
// once (`[]`) while the dock did not exist and never attached. The harness below renders exactly that order --
// gate, then dock -- with a recording `ResizeObserver`, and asserts the observer attaches to the dock when it
// appears, reports its height, compensates the scroll only for a real growth, disconnects when the dock goes, and
// attaches afresh to a new dock.
//
// jsdom has no layout and no ResizeObserver, so both are stubbed: the stub records `observe` / `disconnect` and lets
// the test fire the callback; `getBoundingClientRect` is set per node.

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { STATUS_DOCK_DEFAULT_HEIGHT, useStatusDockHeight } from "./useStatusDockHeight";
import { readShell, readStripped, sliceBetween } from "./sourceScan";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
global.IS_REACT_ACT_ENVIRONMENT = true;

class RecordingObserver {
  static instances: RecordingObserver[] = [];
  observed: Element[] = [];
  disconnected = false;
  constructor(readonly callback: ResizeObserverCallback) {
    RecordingObserver.instances.push(this);
  }
  observe(target: Element) {
    this.observed.push(target);
  }
  unobserve() {}
  disconnect() {
    this.disconnected = true;
  }
  fire() {
    this.callback([], this as unknown as ResizeObserver);
  }
}

const setHeight = (node: Element, height: number) => {
  (node as HTMLElement).getBoundingClientRect = () => ({ height } as DOMRect);
};

let lastHeight = -1;
function Shell({ gate, dockKey = "a" }: { gate: boolean; dockKey?: string }) {
  const { dockRef, dockHeight } = useStatusDockHeight();
  lastHeight = dockHeight;
  /* The room's early return: no dock in the tree at all. */
  if (gate) return <p>Joining the table…</p>;
  return <div key={dockKey} ref={dockRef} data-testid="dock" />;
}

describe("the status-dock observer attaches when the dock exists", () => {
  let container: HTMLDivElement;
  let root: Root;
  let scrollBy: jest.Mock;
  const originalObserver = (global as { ResizeObserver?: unknown }).ResizeObserver;

  beforeEach(() => {
    RecordingObserver.instances = [];
    (global as { ResizeObserver?: unknown }).ResizeObserver = RecordingObserver;
    scrollBy = jest.fn();
    window.scrollBy = scrollBy as unknown as typeof window.scrollBy;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    (global as { ResizeObserver?: unknown }).ResizeObserver = originalObserver;
  });

  const dock = () => container.querySelector('[data-testid="dock"]') as HTMLElement;

  it("does not observe anything while the gate is up, and keeps the default height", () => {
    act(() => root.render(<Shell gate />));
    expect(RecordingObserver.instances).toHaveLength(0);
    expect(lastHeight).toBe(STATUS_DOCK_DEFAULT_HEIGHT);
  });

  it("attaches to the dock when it appears after the gate -- the A-14 regression", () => {
    act(() => root.render(<Shell gate />));
    act(() => root.render(<Shell gate={false} />));
    expect(RecordingObserver.instances).toHaveLength(1);
    expect(RecordingObserver.instances[0].observed).toEqual([dock()]);
  });

  it("tracks the measured height, and scrolls only by a real growth after the baseline", () => {
    act(() => root.render(<Shell gate />));
    act(() => root.render(<Shell gate={false} />));
    const observer = RecordingObserver.instances[0];

    setHeight(dock(), 140);
    act(() => observer.fire());
    expect(lastHeight).toBe(140);
    /* The first reading is a baseline, not a growth. */
    expect(scrollBy).not.toHaveBeenCalled();

    setHeight(dock(), 300);
    act(() => observer.fire());
    expect(lastHeight).toBe(300);
    expect(scrollBy).toHaveBeenCalledWith(0, 160);

    /* Sub-pixel churn is ignored. */
    setHeight(dock(), 300.4);
    act(() => observer.fire());
    expect(lastHeight).toBe(300);
    expect(scrollBy).toHaveBeenCalledTimes(1);
  });

  it("disconnects when the dock goes, and attaches afresh to the next one with a new baseline", () => {
    act(() => root.render(<Shell gate={false} />));
    const first = RecordingObserver.instances[0];
    setHeight(dock(), 120);
    act(() => first.fire());

    act(() => root.render(<Shell gate />));
    expect(first.disconnected).toBe(true);

    act(() => root.render(<Shell gate={false} dockKey="b" />));
    expect(RecordingObserver.instances).toHaveLength(2);
    const second = RecordingObserver.instances[1];
    expect(second.observed).toEqual([dock()]);
    setHeight(dock(), 400);
    act(() => second.fire());
    expect(lastHeight).toBe(400);
    /* A new dock's first reading is not a 280 px "growth" against the old one. */
    expect(scrollBy).not.toHaveBeenCalled();
  });

  it("disconnects on unmount", () => {
    act(() => root.render(<Shell gate={false} />));
    const observer = RecordingObserver.instances[0];
    act(() => root.unmount());
    expect(observer.disconnected).toBe(true);
    root = createRoot(container);
  });
});

describe("the shell wires the hook and names the dock", () => {
  const APP = readShell();

  it("measures the status dock through the hook, not an `[]` effect on a plain ref", () => {
    expect(APP).toContain("const { dockRef: statusDockRef, dockHeight: statusDockHeight } = useStatusDockHeight();");
    expect(APP).toContain("<div ref={statusDockRef} style={styles.statusLineDock} data-status-dock=\"\">");
    expect(APP).not.toContain("useState(96)");
    expect(APP).not.toContain("measuredDockHeightRef");
  });

  it("keeps the observer effect keyed on the node", () => {
    const HOOK = readStripped("utils/useStatusDockHeight.ts");
    expect(HOOK).toContain("const dockRef = useCallback((node: HTMLDivElement | null) => setDockNode(node), []);");
    expect(HOOK).toContain("}, [dockNode]);");
  });

  it("gives the action dock a landmark role and a name (P3-N015)", () => {
    const DOCK = sliceBetween(APP, "<div style={styles.actionDock}", ">");
    expect(DOCK).toContain('role="region"');
    expect(DOCK).toContain('aria-label="Game actions"');
  });
});
