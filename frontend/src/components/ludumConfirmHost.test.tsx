// frontend/src/components/ludumConfirmHost.test.tsx
//
// LUDUM v1.1: `?ludum=confirm&return=<path>` -- Play's own "Confirm it's you", naming the app and site that asks; "Stay
// on Play" closes it without leaving. (The redirect rule itself: utils/ludumReturn.test.ts.)

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { LudumConfirmHost } from "./LudumConfirmHost";
import { ModalLayerHost } from "./ModalPortal";
import { closeLudumConfirm, handleLudumConfirm } from "../utils/ludumReturn";
import { readySessionPort } from "../utils/sessionBootstrap";

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
  closeLudumConfirm();
});

describe("LUDUM v1.1: LudumConfirmHost", () => {
  it("nothing until a confirmation is asked for; then the password form, with the origin notice; Stay on Play closes it", () => {
    const went: string[] = [];
    act(() =>
      root.render(
        <>
          <ModalLayerHost />
          <LudumConfirmHost port={readySessionPort()} navigate={(url) => went.push(url)} />
        </>,
      ),
    );
    expect(document.querySelector('[data-testid="ludum-confirm-form"]')).toBeNull();
    act(() => {
      handleLudumConfirm({ search: "?ludum=confirm&return=/moderation/", navigate: (url) => went.push(url), port: readySessionPort() });
    });
    expect(document.querySelector('[data-testid="ludum-confirm-form"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="ludum-confirm-origin"]')?.textContent).toMatch(/Only enter your password on this site/);
    const stay = Array.from(document.querySelectorAll("button")).find((button) => button.textContent === "Stay on Play") as HTMLButtonElement;
    act(() => stay.click());
    expect(document.querySelector('[data-testid="ludum-confirm-form"]')).toBeNull();
    expect(went).toEqual([]);
  });
});
