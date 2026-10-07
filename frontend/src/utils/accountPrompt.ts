// frontend/src/utils/accountPrompt.ts
//
// ==================================================================
//  PHASE 3 (P3-ACCT): "LOG IN OR CREATE AN ACCOUNT" -- ASKED AT THE ACTION, THEN THE ACTION RESUMES
// ==================================================================
//
// The owner's direction (2026-10-05): PUBLIC FIRST. A visitor sees the homepage, browses the public tables, reads the
// rules and watches any public table (OD-19: Watch is read-only for everyone) without an account. An account is asked
// for exactly when the visitor does something that needs one -- Host, Join, a seat, anything with money -- and once
// they are signed in, THAT action carries on by itself: nobody is sent back to press it again.
//
//   requireAccount(intent, reason)   signed in: `intent()` now. Signed out: the account dialog opens, saying `reason`;
//                                    a successful sign-in closes it, renews this page's sockets on the new session
//                                    (`renewRoomLinks`) and THEN runs `intent()`. Closing the dialog drops the intent.
//   openAccountDialog(mode)          the homepage's own Log in / Create account buttons (nothing to resume).
//
// A small store (no router, no state library): the dialog host (`components/AccountDialog.tsx`) subscribes to it. The
// intent is a callback held in memory for as long as the dialog is up -- never stored, never put in a URL, and it
// carries no credential (the dialog's fields live in the dialog's own state).

import { useSyncExternalStore } from "react";

import { renewRoomLinks } from "./roomLink";
import { sessionPort, type SessionPort } from "./sessionBootstrap";

export type AccountMode = "login" | "create";

export interface AccountPromptState {
  readonly open: boolean;
  readonly mode: AccountMode;
  /** What the visitor was doing, said at the top of the dialog ("Log in or create an account to host a game."). */
  readonly reason: string | null;
}

const CLOSED: AccountPromptState = Object.freeze({ open: false, mode: "login", reason: null });

let state: AccountPromptState = CLOSED;
let intent: (() => void) | null = null;
/* Review L8: what had keyboard focus when the dialog was asked for (the Host button, say) -- where focus goes back to
   after a sign-in, so the resumed action's own dialog returns there when it closes. Never a credential. */
let origin: Element | null = null;
/* Re-review N6: the request pressed while this page did not know yet whether it is signed in (one at a time). */
let waiting: { run: () => void; reason: string; mode?: AccountMode } | null = null;
/* Re-review L8: the account dialog's host (mounted in `index.tsx`) resumes the action only AFTER the dialog has left
   the page -- while a modal <dialog> is open everything behind it is inert, so focus could not be placed. */
let hosts = 0;
let afterClose: (() => void) | null = null;
const captureOrigin = (): void => {
  origin = typeof document === "undefined" ? null : document.activeElement;
};
const listeners = new Set<() => void>();

function set(next: AccountPromptState): void {
  state = next;
  listeners.forEach((listener) => listener());
}

export function accountPromptState(): AccountPromptState {
  return state;
}

export function subscribeAccountPrompt(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useAccountPrompt(): AccountPromptState {
  return useSyncExternalStore(subscribeAccountPrompt, accountPromptState, accountPromptState);
}

/** Whether this page is signed in (a profiled session; the development port always is). */
export function isSignedIn(port: SessionPort = sessionPort()): boolean {
  return port.state === "ready" && port.account !== null;
}

/** Run `run` now when signed in; otherwise ask for an account first and run it after a successful sign-in. Returns
 *  whether it ran now. A second request while the dialog is up replaces the first (the last thing pressed is what
 *  resumes).
 *
 *  Review L6: while this page does not know yet ("unknown": the first bootstrap still in flight, or failed), it asks
 *  the port first -- a signed-in player pressing Join a moment after load is never shown "Log in" -- and decides on
 *  the answer. */
export function requireAccount(run: () => void, reason: string, options: { port?: SessionPort; mode?: AccountMode } = {}): boolean {
  const port = options.port ?? sessionPort();
  if (isSignedIn(port)) {
    run();
    return true;
  }
  if (port.state === "unknown") {
    /* Re-review N6: presses while the answer is pending are ONE request -- the last one pressed is what runs. */
    const first = waiting === null;
    waiting = { run, reason, mode: options.mode };
    if (first) {
      void port.ensure().then(() => {
        const last = waiting;
        waiting = null;
        if (last === null) return;
        if (isSignedIn(port)) last.run();
        else ask(last.run, last.reason, last.mode);
      });
    }
    return false;
  }
  ask(run, reason, options.mode);
  return false;
}

function ask(run: () => void, reason: string, mode: AccountMode = "login"): void {
  intent = run;
  captureOrigin();
  set({ open: true, mode, reason });
}

/** The homepage's Log in / Create account (nothing resumes). */
export function openAccountDialog(mode: AccountMode): void {
  intent = null;
  captureOrigin();
  set({ open: true, mode, reason: null });
}

/** Switch the open dialog between its two forms (the intent is kept). */
export function setAccountMode(mode: AccountMode): void {
  if (state.open) set({ ...state, mode });
}

/** Closed without signing in: the intent is dropped (the visitor chose not to). */
export function closeAccountDialog(): void {
  intent = null;
  origin = null;
  afterClose = null;
  set(CLOSED);
}

/** The signed-in page's stable anchor: the account chip (it replaces the Log in button the visitor pressed). */
const ANCHOR_SELECTOR = '[data-testid="profile-chip"]';

/** Review L8: keyboard focus goes back to where the player was -- or, when that control is gone (the homepage's own Log
 *  in button, replaced by the chip), to the account chip -- never left on <body>. True only when focus really landed
 *  there (re-review L8: a focus() on an inert element does nothing). */
function refocus(target: Element | null): boolean {
  if (typeof document === "undefined") return false;
  const element = target instanceof HTMLElement && target.isConnected && target !== document.body ? target : (document.querySelector(ANCHOR_SELECTOR) as HTMLElement | null);
  if (element === null) return false;
  element.focus();
  return document.activeElement === element;
}

/** The dialog host registers itself (so a sign-in resumes after the dialog has unmounted). */
export function registerAccountPromptHost(): () => void {
  hosts += 1;
  return () => {
    hosts -= 1;
  };
}

/** Called by the host once the dialog is gone: the pending resume (focus, then the action), if any. */
export function accountDialogClosed(): void {
  const resume = afterClose;
  afterClose = null;
  resume?.();
}

/** The dialog signed this browser in (its call already re-bootstrapped the port). The sockets move to the new session
 *  first, so the resumed action does not go out on a socket the server is about to close; then it runs, once. */
export function accountSignedIn(options: { renew?: () => void } = {}): void {
  const run = intent;
  const from = origin;
  intent = null;
  origin = null;
  const resume = () => {
    /* Focus first, so a dialog the resumed action opens takes THIS as the control to return to when it closes. */
    const placed = refocus(from);
    if (run !== null) run();
    /* The chip may only appear on the next render: place focus then if nothing holds it. */
    if (!placed && typeof window !== "undefined") {
      window.setTimeout(() => {
        if (document.activeElement === null || document.activeElement === document.body) refocus(null);
      }, 0);
    }
  };
  /* With the dialog's host mounted, the resume waits for the dialog to leave the page (`accountDialogClosed`). */
  if (hosts > 0) afterClose = resume;
  set(CLOSED);
  (options.renew ?? renewRoomLinks)();
  if (hosts === 0) resume();
}

/** Tests only. */
export function resetAccountPromptForTests(): void {
  intent = null;
  origin = null;
  waiting = null;
  afterClose = null;
  state = CLOSED;
  listeners.clear();
}
