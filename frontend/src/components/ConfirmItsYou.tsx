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
//
// P3-ACCT: an account with a username asks for its PASSWORD (`POST /gs/api/profile/reauth {password}`); a profile made
// before accounts asks for its recovery key, as before. Which one is read from the account itself (`account/me`) when
// the caller doesn't say. P3-ACCT POLICY: an account with a password confirms with the PASSWORD only -- its recovery key
// is account recovery ("Forgot password?", "Change password"), never a confirmation (the server refuses it here).
// Signing in counts as confirming for its first five minutes (the server's grant), so a player who just logged in is
// not asked at all -- except to replace a credential (a new recovery key), which always asks.

import React, { useEffect, useState } from "react";

import { APP_NAME } from "../config";
import { accountDetails, profileErrorSentence, reauthenticate, reauthenticateWithPassword } from "../utils/profileApi";
import { sessionPort, type SessionPort } from "../utils/sessionBootstrap";
import { disabledLook, profileStyles as styles } from "./profileStyles";

export type ConfirmMethod = "password" | "recovery-key";

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
  /** P3-ACCT: which secret confirms (absent: read from the account -- a password when it has a username). */
  method?: ConfirmMethod;
}

export function ConfirmItsYou({ purpose, port = sessionPort(), onConfirmed, onCancel, cancelLabel = "Back", testIdPrefix = "profile-reauth", showOrigin = false, busy = false, onBusyChange, method }: ConfirmItsYouProps): JSX.Element {
  /* The secret: this view's state only, cleared the moment it is sent. */
  const [key, setKey] = useState("");
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /* P3-ACCT: password unless the account says it has none (a legacy profile). P3-ACCT POLICY: never a choice -- the
     password when the account has one, the key only for a profile that has none. */
  const [using, setUsing] = useState<ConfirmMethod>(method ?? "password");
  useEffect(() => {
    if (method !== undefined) return undefined;
    let live = true;
    void accountDetails(port).then((answer) => {
      if (!live || !answer.ok) return;
      setUsing(answer.account.username === null ? "recovery-key" : "password");
    });
    return () => {
      live = false;
    };
  }, [method, port]);
  const blocked = busy || checking;
  const inputId = `${testIdPrefix}-key`;

  const confirm = async () => {
    const typed = key;
    setKey("");
    setChecking(true);
    onBusyChange?.(true);
    setError(null);
    const result = using === "password" ? await reauthenticateWithPassword(typed, port) : await reauthenticate(typed, port);
    setChecking(false);
    onBusyChange?.(false);
    if (!result.ok) {
      setError(profileErrorSentence(result, using === "password" ? "password" : "reauth"));
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
          This is {APP_NAME} at {origin}. Only enter your {using === "password" ? "password" : "recovery key"} on this site.
        </p>
      ) : null}
      <label style={styles.label} htmlFor={inputId}>
        {using === "password" ? `${purpose}, enter your password. It is checked once and not kept on this device.` : `${purpose}, paste your current recovery key. It is checked once and not kept on this device.`}
      </label>
      <input
        id={inputId}
        type="password"
        autoComplete={using === "password" ? "current-password" : "off"}
        style={using === "password" ? styles.input : styles.monoInput}
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
