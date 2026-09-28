// frontend/src/components/ConfirmItsYou.tsx
//
// ==================================================================
//  ESCROW-4 (brief §3): "CONFIRM IT'S YOU" -- ONE SURFACE, SHARED BY THE PROFILE MENU AND THE MONEY PANEL
// ==================================================================
//
// Extracted from the profile menu's re-authentication view (ESCROW-3A §10B), unchanged in what it does: paste the
// recovery key, choose Confirm, and `POST /gs/api/profile/reauth` grants THIS session a short window (five minutes on
// the server, bound to this session, its family and its recovery selector) in which a sensitive action may run. The
// key is sent once in a POST body and dropped from this component's state the moment it is sent; it is never logged,
// stored or put in a URL. The 3A security model is untouched: the server alone decides, and nothing here remembers
// the grant beyond telling the caller when it was given.
//
// Sensitive, and so behind this: rotating the recovery key and signing out other devices (the profile menu), and --
// ESCROW-4 -- linking or replacing a seat's wallet and making or moving a seat's signing key (the money panel). NOT
// behind it: relaying an already-valid CONSENT or ANNUL signature (the signature is the authority, owner ruling).
//
// W-16: pasting the root key must not become a reflex a look-alike page can exploit, so the money panel shows which
// app and which site is asking (`showOrigin`).

import React, { useState } from "react";

import { APP_NAME } from "../config";
import { profileErrorSentence, reauthenticate } from "../utils/profileApi";
import { sessionPort, type SessionPort } from "../utils/sessionBootstrap";
import { disabledLook, profileStyles as styles } from "./profileStyles";

export interface ConfirmItsYouProps {
  /** Completes "…, paste your current recovery key." -- e.g. "To make a new recovery key". */
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
  /* The recovery key: this view's state only, cleared the moment it is sent. */
  const [key, setKey] = useState("");
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const blocked = busy || checking;
  const inputId = `${testIdPrefix}-key`;

  const confirm = async () => {
    const typed = key;
    setKey("");
    setChecking(true);
    onBusyChange?.(true);
    setError(null);
    const result = await reauthenticate(typed, port);
    setChecking(false);
    onBusyChange?.(false);
    if (!result.ok) {
      setError(profileErrorSentence(result, "reauth"));
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
        if (!blocked && key.trim() !== "") void confirm();
      }}
      data-testid={`${testIdPrefix}-form`}
    >
      <p style={styles.subheading}>Confirm it’s you</p>
      {showOrigin && origin !== "" ? (
        <p style={styles.label} data-testid={`${testIdPrefix}-origin`}>
          This is {APP_NAME} at {origin}. Only paste your recovery key into this site.
        </p>
      ) : null}
      <label style={styles.label} htmlFor={inputId}>
        {purpose}, paste your current recovery key. It is checked once and not kept on this device.
      </label>
      <input
        id={inputId}
        type="password"
        autoComplete="off"
        style={styles.monoInput}
        value={key}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        onChange={(event) => setKey(event.target.value)}
        data-testid={`${testIdPrefix}-key`}
      />
      <div style={styles.row}>
        <button type="submit" style={disabledLook(styles.primary, blocked || key.trim() === "")} disabled={blocked || key.trim() === ""} data-testid={`${testIdPrefix}-confirm`}>
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
