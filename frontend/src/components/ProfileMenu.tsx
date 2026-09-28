// frontend/src/components/ProfileMenu.tsx
//
// ==================================================================
//  LIVE-2E: THE PROFILE MENU
// ==================================================================
//
// A chip with the profile's name, in the lobby's account corner and in the table's top bar. Opening it offers the
// four things a profile can do from a signed-in browser:
//
//   Link another device       a single-use code, shown large with Copy and a live countdown (10 minutes)
//   Rotate recovery key       asked first -- the old key stops working at once -- then the new key, shown once
//   Sign out other devices    asked first, with how many are signed in; then how many were signed out
//   Sign out this device      asked first -- the profile and its seats are kept -- then this browser reloads to
//                             the profile gate
//
// ESCROW-3A (§10B): rotating the key and signing out other devices are SENSITIVE -- the server asks this session to
// re-enter the recovery key first (403 `reauth-required`, always: the menu has no exception -- the one lost-create-response
// rescue belongs to the profile gate's own page). The menu then shows "Confirm it's you": paste the recovery key, choose
// Confirm, and the action the player already chose runs again at once. ESCROW-4: that view is the shared
// `ConfirmItsYou` (the money panel uses the same one); the key lives in its state only while it is up.
//
// ESCROW-4 (F-3, preflight OD-4-6): "Sign out this device" says so when this browser holds real-money signing keys, and
// removes them by default (a box, ticked) -- deposits and payouts don't depend on them.
//
// A development-identity build has no credentials to manage: the chip says "Development profile (this tab)" and
// offers nothing. The code and the key live in this component's state while their view is up; closing the menu
// drops them. Nothing is logged, stored or put in a URL.

import { forgetActiveTable } from "../utils/activeGame";
import React, { useCallback, useEffect, useRef, useState } from "react";

import { sessionPort, type SessionPort } from "../utils/sessionBootstrap";
import { useSession } from "../utils/useSession";
import { useDialogDismissal } from "../utils/useDialogDismissal";
import {
  LINK_CODE_LIFETIME_MS,
  createLinkCode,
  profileErrorSentence,
  rotateRecoveryKey,
  signOutOtherDevices,
  signOutThisDevice,
} from "../utils/profileApi";
import { RecoveryKeyReveal } from "./RecoveryKeyReveal";
import { ConfirmItsYou } from "./ConfirmItsYou";
import { browserConsentKeys } from "../money/consentKeys";
import { disabledLook, profileStyles as styles } from "./profileStyles";
import { SANDBOX_INK, SANDBOX_RAISED, SANDBOX_RULE_STRONG } from "../styles/palette";
import { CONTROL_PADDING, FONT_FAMILY, FONT_SIZE, RADIUS } from "../styles/typography";

type View =
  | { kind: "menu" }
  | { kind: "link"; code: string | null; deadline: number }
  | { kind: "rotate-confirm" }
  | { kind: "others-confirm" }
  | { kind: "others-done"; signedOut: number }
  | { kind: "signout-confirm" }
  /** ESCROW-3A: the server asked this session to confirm the recovery key before `then` runs. */
  | { kind: "reauth"; then: "rotate" | "others" };

const devices = (count: number) => `${count} other device${count === 1 ? "" : "s"}`;

/** When the code stops working, on THIS device's clock: the server's instant when the two clocks roughly agree, the
 *  full lifetime from now when they do not (a countdown that starts expired would be worse than a slightly long one). */
export function linkCodeDeadline(expiresAt: number, receivedAt: number): number {
  const left = expiresAt - receivedAt;
  return left > 0 && left <= LINK_CODE_LIFETIME_MS ? expiresAt : receivedAt + LINK_CODE_LIFETIME_MS;
}

/** `m:ss`. */
export function countdownText(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function LinkCodeView({ code, deadline, onNew, busy }: { code: string; deadline: number; onNew: () => void; busy: boolean }): JSX.Element {
  const [now, setNow] = useState(() => Date.now());
  const [said, setSaid] = useState<string | null>(null);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const left = deadline - now;
  const expired = left <= 0;
  const copy = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("no clipboard");
      await navigator.clipboard.writeText(code);
      setSaid("Copied.");
    } catch {
      setSaid("This browser would not copy it. Type it on the other device instead.");
    }
  };
  return (
    <>
      <p style={styles.text}>On the other device, choose “Link existing profile” and enter this code. It works once, for 10 minutes.</p>
      {expired ? (
        <p role="alert" style={styles.notice}>
          This code has expired.
        </p>
      ) : (
        <>
          <code style={styles.code} data-testid="link-code-value">
            {code}
          </code>
          <p style={styles.label} data-testid="link-code-countdown" aria-live="off">
            Expires in {countdownText(left)}
          </p>
        </>
      )}
      <div style={styles.row}>
        {expired ? null : (
          <button type="button" style={styles.secondary} onClick={() => void copy()}>
            Copy
          </button>
        )}
        <button type="button" style={disabledLook(styles.secondary, busy)} disabled={busy} onClick={onNew}>
          Make a new code
        </button>
        {said ? (
          <span role="status" style={styles.label}>
            {said}
          </span>
        ) : null}
      </div>
    </>
  );
}

function MenuPanel({ port, name, otherSessions, onClose }: { port: SessionPort; name: string; otherSessions: number; onClose: () => void }): JSX.Element {
  const [view, setView] = useState<View>({ kind: "menu" });
  const [reveal, setReveal] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /* ESCROW-4: how many real-money signing keys this browser holds, and whether signing out removes them (default). */
  const [signingKeys, setSigningKeys] = useState(0);
  const [removeKeys, setRemoveKeys] = useState(true);
  useDialogDismissal({ onDismiss: onClose, dismissible: !busy && reveal === null });

  const go = (next: View) => {
    setError(null);
    setView(next);
    if (next.kind === "signout-confirm") {
      setRemoveKeys(true);
      void browserConsentKeys()
        .count()
        .then(setSigningKeys, () => setSigningKeys(0));
    }
  };

  const makeCode = useCallback(async () => {
    setBusy(true);
    setError(null);
    const result = await createLinkCode(port);
    setBusy(false);
    if (!result.ok) {
      setError(profileErrorSentence(result));
      setView({ kind: "menu" });
      return;
    }
    setView({ kind: "link", code: result.code, deadline: linkCodeDeadline(result.expiresAt, Date.now()) });
  }, [port]);

  const rotate = async () => {
    setBusy(true);
    setError(null);
    const result = await rotateRecoveryKey(port);
    setBusy(false);
    if (!result.ok) {
      if (result.error === "reauth-required") return go({ kind: "reauth", then: "rotate" });
      setError(profileErrorSentence(result));
      return;
    }
    setView({ kind: "menu" });
    setReveal(result.recoveryKey);
  };

  const confirmOthers = () => {
    go({ kind: "others-confirm" });
    /* The count on the confirm is the server's latest. */
    if (port.refreshable) void port.ensure(true);
  };

  const signOutOthers = async () => {
    setBusy(true);
    setError(null);
    const result = await signOutOtherDevices(port);
    setBusy(false);
    if (!result.ok) {
      if (result.error === "reauth-required") return go({ kind: "reauth", then: "others" });
      setError(profileErrorSentence(result));
      return;
    }
    setView({ kind: "others-done", signedOut: result.signedOut });
  };

  const signOut = async () => {
    setBusy(true);
    setError(null);
    /* ESCROW-4: the signing keys go first (the player chose it, and it was the default); a failure keeps them. */
    if (signingKeys > 0 && removeKeys) await browserConsentKeys().removeAll();
    const result = await signOutThisDevice(port);
    if (result.ok) {
      forgetActiveTable();
      window.location.reload();
      return;
    }
    setBusy(false);
    setError(profileErrorSentence(result));
  };

  if (reveal !== null) {
    return (
      <div style={styles.overlay}>
        <div style={{ ...styles.card, maxHeight: "90vh", overflowY: "auto" }}>
          <RecoveryKeyReveal
            recoveryKey={reveal}
            heading="Your new recovery key"
            notice="Your old recovery key no longer works."
            continueLabel="Done"
            onContinue={() => {
              setReveal(null);
              onClose();
            }}
          />
        </div>
      </div>
    );
  }

  const back = (
    <button type="button" style={disabledLook(styles.secondary, busy)} disabled={busy} onClick={() => go({ kind: "menu" })}>
      Back
    </button>
  );

  return (
    <div role="dialog" aria-labelledby="profile-menu-title" style={menuStyles.panel} data-testid="profile-menu-panel">
      <h2 id="profile-menu-title" style={styles.subheading}>
        Signed in as {name}
      </h2>
      {view.kind === "menu" ? (
        <div style={menuStyles.list}>
          <button type="button" style={disabledLook(styles.secondary, busy)} disabled={busy} onClick={() => void makeCode()} data-testid="profile-menu-link">
            {busy ? "Making a code…" : "Link another device"}
          </button>
          <button type="button" style={styles.secondary} onClick={() => go({ kind: "rotate-confirm" })} data-testid="profile-menu-rotate">
            Rotate recovery key
          </button>
          <button type="button" style={styles.secondary} onClick={confirmOthers} data-testid="profile-menu-others">
            Sign out other devices
          </button>
          <p style={styles.label} data-testid="profile-menu-others-count">
            {otherSessions === 0 ? "No other devices are signed in." : `${devices(otherSessions)} signed in.`}
          </p>
          <button type="button" style={styles.secondary} onClick={() => go({ kind: "signout-confirm" })} data-testid="profile-menu-signout">
            Sign out this device
          </button>
        </div>
      ) : null}
      {view.kind === "link" && view.code !== null ? (
        <>
          <p style={styles.subheading}>Link another device</p>
          <LinkCodeView code={view.code} deadline={view.deadline} busy={busy} onNew={() => void makeCode()} />
          <div style={styles.row}>{back}</div>
        </>
      ) : null}
      {view.kind === "rotate-confirm" ? (
        <>
          <p style={styles.text}>Make a new recovery key? Your current recovery key stops working immediately.</p>
          <div style={styles.row}>
            <button type="button" style={disabledLook(styles.primary, busy)} disabled={busy} onClick={() => void rotate()} data-testid="profile-rotate-confirm">
              {busy ? "Making a key…" : "Make a new recovery key"}
            </button>
            {back}
          </div>
        </>
      ) : null}
      {view.kind === "others-confirm" ? (
        <>
          <p style={styles.text} data-testid="profile-others-summary">
            {otherSessions === 0
              ? "No other devices are signed in to this profile right now."
              : `${devices(otherSessions)} ${otherSessions === 1 ? "is" : "are"} signed in to this profile.`}{" "}
            Signing them out ends their sessions at once; to sign back in they will need your recovery key or a link
            code from this device.
          </p>
          <div style={styles.row}>
            <button type="button" style={disabledLook(styles.primary, busy)} disabled={busy} onClick={() => void signOutOthers()} data-testid="profile-others-confirm">
              {busy ? "Signing out…" : "Sign out other devices"}
            </button>
            {back}
          </div>
        </>
      ) : null}
      {view.kind === "others-done" ? (
        <>
          <p style={styles.text} role="status" data-testid="profile-others-done">
            {view.signedOut === 0 ? "No other devices were signed in." : `Signed out ${devices(view.signedOut)}.`}
          </p>
          <div style={styles.row}>{back}</div>
        </>
      ) : null}
      {view.kind === "reauth" ? (
        /* ESCROW-4: the shared "Confirm it's you"; the action the player chose runs again once it is granted. */
        <ConfirmItsYou
          purpose={view.then === "rotate" ? "To make a new recovery key" : "To sign out your other devices"}
          port={port}
          busy={busy}
          onBusyChange={setBusy}
          onConfirmed={() => (view.then === "rotate" ? rotate() : signOutOthers())}
          onCancel={() => go({ kind: "menu" })}
        />
      ) : null}
      {view.kind === "signout-confirm" ? (
        <>
          <p style={styles.text}>
            Sign out this device? Your profile and its seats are kept. To come back on this browser you will need your
            recovery key, or a link code from another signed-in device.
          </p>
          {signingKeys > 0 ? (
            <>
              <p style={styles.notice} data-testid="profile-signout-keys">
                This browser holds the signing key{signingKeys === 1 ? "" : "s"} for {signingKeys} real-money seat{signingKeys === 1 ? "" : "s"}. Signing out ends the wallet links made here for
                tables that haven't started (relink them free from another device). Your deposits stay yours: payouts still arrive through each table's
                challenge window, and another device can take over signing (“Use this device for signing”).
              </p>
              <label style={styles.check}>
                <input type="checkbox" checked={removeKeys} onChange={(event) => setRemoveKeys(event.target.checked)} data-testid="profile-signout-remove-keys" />
                Remove this device's signing keys
              </label>
            </>
          ) : null}
          <div style={styles.row}>
            <button type="button" style={disabledLook(styles.primary, busy)} disabled={busy} onClick={() => void signOut()} data-testid="profile-signout-confirm">
              {busy ? "Signing out…" : "Sign out this device"}
            </button>
            {back}
          </div>
        </>
      ) : null}
      {error ? (
        <p role="alert" style={styles.error}>
          {error}
        </p>
      ) : null}
      <div style={menuStyles.footer}>
        <button type="button" style={disabledLook(styles.secondary, busy)} disabled={busy} onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}

export function ProfileMenu({ port = sessionPort() }: { port?: SessionPort }): JSX.Element | null {
  const { account } = useSession(port);
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLSpanElement | null>(null);
  const close = useCallback(() => setOpen(false), []);

  /* A click anywhere outside the chip and its panel closes it (the reveal overlay is inside the anchor). */
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (event: MouseEvent) => {
      if (anchor.current && event.target instanceof Node && !anchor.current.contains(event.target)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  if (account === null) return null;
  if (account.development) {
    return (
      <span style={menuStyles.chip} data-testid="profile-chip" title="This build names each tab's profile itself.">
        Development profile (this tab)
      </span>
    );
  }
  return (
    <span ref={anchor} style={menuStyles.anchor}>
      <button
        type="button"
        style={menuStyles.chip}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
        title="Your profile"
        data-testid="profile-chip"
      >
        {account.name}
      </button>
      {open ? <MenuPanel port={port} name={account.name} otherSessions={account.otherSessions} onClose={close} /> : null}
    </span>
  );
}

const menuStyles: Record<"anchor" | "chip" | "panel" | "list" | "footer", React.CSSProperties> = {
  anchor: { position: "relative", display: "inline-flex" },
  chip: {
    fontSize: FONT_SIZE.small,
    fontWeight: 700,
    padding: CONTROL_PADDING.buttonSmall,
    borderRadius: RADIUS.pill,
    border: `1px solid ${SANDBOX_RULE_STRONG}`,
    backgroundColor: SANDBOX_RAISED,
    color: SANDBOX_INK,
    fontFamily: FONT_FAMILY,
    cursor: "pointer",
    maxWidth: "220px",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  panel: {
    position: "absolute",
    top: "calc(100% + 6px)",
    right: 0,
    zIndex: 9000,
    width: "min(340px, calc(100vw - 32px))",
    padding: "16px",
    borderRadius: RADIUS.layer,
    border: `1px solid ${SANDBOX_RULE_STRONG}`,
    backgroundColor: SANDBOX_RAISED,
    color: SANDBOX_INK,
    fontFamily: FONT_FAMILY,
    boxShadow: "0 12px 32px rgba(0, 0, 0, 0.45)",
    textAlign: "left",
    whiteSpace: "normal",
  },
  list: { display: "flex", flexDirection: "column", gap: "8px" },
  footer: { display: "flex", justifyContent: "flex-end", marginTop: "12px" },
};
