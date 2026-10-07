// frontend/src/components/ConfirmItsYou.tsx
//
// ==================================================================
//  ESCROW-4 (brief §3): "CONFIRM IT'S YOU" -- ONE SURFACE, SHARED BY THE PROFILE MENU AND THE MONEY PANEL
// ==================================================================
//
// Enter the account's PASSWORD, choose Confirm, and `POST /gs/api/profile/reauth` grants THIS session a short window
// (five minutes on the server, bound to this session, its family and the account's internal credential epoch) in which a
// sensitive action may run. The password is sent once in a POST body and dropped from this component's state the moment
// it is sent; it is never logged, stored or put in a URL. The server alone decides; nothing here remembers the grant
// beyond telling the caller when it was given.
//
// Sensitive, and so behind this: signing out other devices and beginning an Authorization Wallet replacement (the
// profile menu), and -- ESCROW-4 -- linking or replacing a seat's wallet and making or moving a seat's signing key (the
// money panel). NOT behind it: relaying an already-valid CONSENT or ANNUL signature (the signature is the authority,
// owner ruling). Signing in counts as confirming for its first five minutes (the server's grant), so a player who just
// logged in is not asked for the ordinary sensitive actions -- the Authorization Wallet's replacement always asks.
//
// PHASE 3 FINAL: the password is the ONLY thing this asks for. There is no recovery key; the Authorization Wallet is never
// asked for here (ordinary play never prompts for it).
//
// W-16: typing the password must not become a reflex a look-alike page can exploit, so the money panel shows which app
// and which site is asking (`showOrigin`).

import React, { useState } from "react";

import { APP_NAME } from "../config";
import { profileErrorSentence, reauthenticateWithPassword } from "../utils/profileApi";
import { sessionPort, type SessionPort } from "../utils/sessionBootstrap";
import { disabledLook, profileStyles as styles } from "./profileStyles";

export interface ConfirmItsYouProps {
  /** Completes "…, enter your password." -- e.g. "To sign out your other devices". */
  purpose: string;
  port?: SessionPort;
  /** The server granted the window (`expiresAt`, server ms): run the action the player chose. */
  onConfirmed: (expiresAt: number) => void | Promise<void>;
  onCancel?: () => void;
  cancelLabel?: string;
  /** The ids a test reads: `${prefix}-key`, `${prefix}-confirm`. The profile menu keeps "profile-reauth". */
  testIdPrefix?: string;
  /** Say which app and site is asking (the money panel). */
  showOrigin?: boolean;
  /** The surrounding surface is busy (Confirm and Back are disabled meanwhile). */
  busy?: boolean;
  onBusyChange?: (busy: boolean) => void;
}

export function ConfirmItsYou({ purpose, port = sessionPort(), onConfirmed, onCancel, cancelLabel = "Back", testIdPrefix = "profile-reauth", showOrigin = false, busy = false, onBusyChange }: ConfirmItsYouProps): JSX.Element {
  /* The password: this view's state only, cleared the moment it is sent. */
  const [password, setPassword] = useState("");
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const blocked = busy || checking;
  const inputId = `${testIdPrefix}-key`;

  const confirm = async () => {
    const typed = password;
    setPassword("");
    setChecking(true);
    onBusyChange?.(true);
    setError(null);
    const result = await reauthenticateWithPassword(typed, port);
    setChecking(false);
    onBusyChange?.(false);
    if (!result.ok) {
      setError(profileErrorSentence(result, "password"));
      return;
    }
    await onConfirmed(result.expiresAt);
  };

  let origin = "";
  try {
    origin = window.location.origin;
  } catch {
    origin = "";
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (!blocked && password !== "") void confirm();
      }}
      data-testid={`${testIdPrefix}-form`}
    >
      <p style={styles.subheading}>Confirm it’s you</p>
      {showOrigin && origin !== "" ? (
        <p style={styles.label} data-testid={`${testIdPrefix}-origin`}>
          This is {APP_NAME} at {origin}. Only enter your password on this site.
        </p>
      ) : null}
      <label style={styles.label} htmlFor={inputId}>
        {`${purpose}, enter your password. It is checked once and not kept on this device.`}
      </label>
      <input
        id={inputId}
        type="password"
        autoComplete="current-password"
        style={styles.input}
        value={password}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        onChange={(event) => setPassword(event.target.value)}
        data-testid={`${testIdPrefix}-key`}
      />
      <div style={styles.row}>
        <button type="submit" style={disabledLook(styles.primary, blocked || password === "")} disabled={blocked || password === ""} data-testid={`${testIdPrefix}-confirm`}>
          {checking ? "Checking…" : "Confirm"}
        </button>
        {onCancel ? (
          <button type="button" style={disabledLook(styles.secondary, blocked)} disabled={blocked} onClick={onCancel}>
            {cancelLabel}
          </button>
        ) : null}
      </div>
      {error ? (
        <p role="alert" style={styles.error}>
          {error}
        </p>
      ) : null}
    </form>
  );
}

export default ConfirmItsYou;
