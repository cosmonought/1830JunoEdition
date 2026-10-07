/** @jest-environment jsdom */
// frontend/src/components/rulesReferenceOpenPersists.test.tsx
//
// CONSOLIDATED FINAL PRE-PLAYTEST INTEGRATION: "opening Rules Reference flickered once and immediately disappeared".
//
// REPRODUCED in a real Chromium against the integrated source (`npm start`, the CRA development server): the public
// Rules page's `<dialog>` was shown, closed and shown again within ~10 ms, and the `close` event the middle `close()`
// had QUEUED then arrived while the dialog was open again -- `NativeModal` read it as the reader's dismissal and the
// page was gone. The sequence is React 18 StrictMode's development-only effect re-run (mount, cleanup, mount), which
// wraps the whole app (`index.tsx`); a production build never re-runs effects, so it never showed there.
//
// The browser semantics that matter, modelled here exactly: `showModal()` sets `open`; `close()` clears it and only
// QUEUES the `close` event (a task), so a re-show can land between the two.

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { NativeModal } from "./NativeModal";
import { InfoPagesHost } from "./InfoPages";
import { ModalLayerHost } from "./ModalPortal";
import { openInfoPage, openInfoPageNow, resetInfoPagesForTests } from "../utils/infoPages";
import { resetScrollLockForTests } from "../utils/useScrollLock";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type DialogProto = { showModal?: () => void; close?: () => void };
const proto = window.HTMLDialogElement.prototype as unknown as DialogProto;
const saved = { showModal: proto.showModal, close: proto.close };

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  jest.useFakeTimers();
  proto.showModal = function showModal(this: HTMLDialogElement) {
    if (this.hasAttribute("open")) throw new DOMException("dialog already open", "InvalidStateError");
    this.setAttribute("open", "");
  };
  proto.close = function close(this: HTMLDialogElement) {
    if (!this.hasAttribute("open")) return;
    this.removeAttribute("open");
    /* As the HTML Standard: the `close` event is a QUEUED task, not fired inside `close()`. */
    setTimeout(() => this.dispatchEvent(new Event("close")), 0);
  };
  resetInfoPagesForTests();
  resetScrollLockForTests();
  host = document.createElement("div");
  document.body.appendChild(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  proto.showModal = saved.showModal;
  proto.close = saved.close;
  jest.useRealTimers();
});

const settle = () =>
  act(() => {
    jest.advanceTimersByTime(50);
  });

describe("consolidated integration: a dismissible NativeModal stays open until the reader closes it", () => {
  test("under React StrictMode (development's mount / cleanup / mount), the queued stale `close` does not dismiss", () => {
    const onDismiss = jest.fn();
    root = createRoot(host as HTMLDivElement);
    /* The modal layer first (the application mounts it beside the screen root), then the surface. */
    const tree = (open: boolean) => (
      <React.StrictMode>
        <ModalLayerHost />
        {open ? (
          <NativeModal name="Probe" dismissible onDismiss={onDismiss} restoreOpener={false} scrimStyle={{}} testId="probe">
            <p>content</p>
          </NativeModal>
        ) : null}
      </React.StrictMode>
    );
    act(() => root?.render(tree(false)));
    act(() => root?.render(tree(true)));
    settle();
    expect(onDismiss).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="probe"]')?.hasAttribute("open")).toBe(true);
  });

  test("the public Rules page opened from the lobby's Rules control stays OPEN through initialisation and re-renders, and closes only on Close", () => {
    root = createRoot(host as HTMLDivElement);
    act(() =>
      root?.render(
        <React.StrictMode>
          <ModalLayerHost />
          <InfoPagesHost />
        </React.StrictMode>,
      ),
    );
    act(() => openInfoPage("rules"));
    settle();
    expect(openInfoPageNow()).toBe("rules");
    const page = () => document.querySelector('[data-testid="rules-page"]');
    expect(page()?.hasAttribute("open")).toBe(true);
    /* A re-render of the host (another store notification) does not dismiss it either. */
    act(() => openInfoPage("rules"));
    settle();
    expect(page()?.hasAttribute("open")).toBe(true);
    /* The reader's Close is still the way out. */
    act(() => (document.querySelector('[data-testid="rules-close"]') as HTMLButtonElement).click());
    settle();
    expect(openInfoPageNow()).toBeNull();
    expect(page()).toBeNull();
  });

  test("a real close request (the dialog is closed when its event arrives) still dismisses", () => {
    const onDismiss = jest.fn();
    root = createRoot(host as HTMLDivElement);
    const tree = (open: boolean) => (
      <>
        <ModalLayerHost />
        {open ? (
          <NativeModal name="Probe" dismissible onDismiss={onDismiss} restoreOpener={false} scrimStyle={{}} testId="probe">
            <p>content</p>
          </NativeModal>
        ) : null}
      </>
    );
    act(() => root?.render(tree(false)));
    act(() => root?.render(tree(true)));
    settle();
    const dialog = document.querySelector('[data-testid="probe"]') as HTMLDialogElement;
    act(() => (dialog as unknown as { close: () => void }).close());
    settle();
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
