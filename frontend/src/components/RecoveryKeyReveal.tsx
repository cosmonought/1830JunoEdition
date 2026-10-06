// frontend/src/components/RecoveryKeyReveal.tsx
//
// LIVE-2E: THE RECOVERY KEY, SHOWN ONCE. The server hands the key out exactly once -- on "Create profile" and on
// "Rotate recovery key" (P3-ACCT POLICY: and on "Create account") -- and this is the one screen that holds it.
//
// P3-ACCT POLICY (owner rulings 2026-10-05): for an account with a password (`purpose: "account"`) the key is ACCOUNT
// RECOVERY -- it lets the player choose a new password if they forget theirs. It is not needed to sign in, to play, to
// host or join, or to ante; nobody is ever asked to type it back. Losing both the password and the key means there is
// no automated way back (there is no email reset). The wording says exactly that. It offers Copy and "Save as file" (a Blob
// download whose object URL is revoked right after the click), says plainly what the key is for and who else could
// use it, and will not continue until the player ticks that they have saved it. The key lives in the caller's state
// only while this screen is up; nothing here logs it, stores it or puts it in a URL.

import React, { useState } from "react";

import { APP_NAME } from "../config";
import { disabledLook, profileStyles as styles } from "./profileStyles";

/** The download's name. */
export const RECOVERY_KEY_FILE = "18cosmos-recovery-key.txt";

export type RecoveryKeyPurpose = "account" | "legacy";

function keyFileText(recoveryKey: string, purpose: RecoveryKeyPurpose): string {
  return [
    `${APP_NAME} — recovery key`,
    "",
    recoveryKey,
    "",
    ...(purpose === "account"
      ? [
          "If you forget your password, this key lets you choose a new one (Log in → “Forgot password?”).",
          "Anyone with it can reset your password. Keep it private. There is no email reset: without your password and this key the account cannot be recovered.",
        ]
      : ["This key is the only way back into your profile if you lose this browser and have no other signed-in device.", "Anyone with it can sign in as you. Keep it private."]),
    "",
  ].join("\n");
}

/** A text file download. The object URL lives only until the click has been handled (LIVE-2E review I1: revoking it
 *  in the same task can abort the download in some browsers). */
function saveKeyFile(recoveryKey: string, purpose: RecoveryKeyPurpose): boolean {
  if (typeof URL.createObjectURL !== "function") return false;
  const url = URL.createObjectURL(new Blob([keyFileText(recoveryKey, purpose)], { type: "text/plain;charset=utf-8" }));
  try {
    const link = document.createElement("a");
    link.href = url;
    link.download = RECOVERY_KEY_FILE;
    link.rel = "noopener";
    link.style.display = "none";
    document.body.appendChild(link);
    link.click();
    link.remove();
    return true;
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

export function RecoveryKeyReveal({
  recoveryKey,
  onContinue,
  heading = "Save your recovery key",
  continueLabel = "Continue to the lobby",
  notice,
  purpose = "legacy",
  embedded = false,
}: {
  recoveryKey: string;
  onContinue: () => void;
  heading?: string;
  continueLabel?: string;
  /** A line above the key (e.g. "Your old recovery key no longer works."). */
  notice?: string;
  /** P3-ACCT POLICY: "account" -- the key of an account with a password (account recovery); "legacy" -- a profile made
   *  before accounts, for which the key is still a way to sign in. */
  purpose?: RecoveryKeyPurpose;
  /** Inside a surface that is already a dialog (the account dialog): a labelled group, not a second dialog. */
  embedded?: boolean;
}): JSX.Element {
  const [saved, setSaved] = useState(false);
  const [said, setSaid] = useState<string | null>(null);

  const copy = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("no clipboard");
      await navigator.clipboard.writeText(recoveryKey);
      setSaid("Copied.");
    } catch {
      setSaid("This browser would not copy it. Select the key and copy it yourself.");
    }
  };
  const save = () => {
    let ok = false;
    try {
      ok = saveKeyFile(recoveryKey, purpose);
    } catch {
      ok = false;
    }
    setSaid(ok ? `Saved as ${RECOVERY_KEY_FILE}.` : "This browser would not save a file. Copy the key instead.");
  };

  return (
    <div role={embedded ? "group" : "dialog"} aria-labelledby="recovery-key-title" data-testid="recovery-key-reveal">
      <h2 id="recovery-key-title" style={styles.heading}>
        {heading}
      </h2>
      {notice ? <p style={styles.notice}>{notice}</p> : null}
      {purpose === "account" ? (
        <p style={styles.text} data-testid="recovery-key-purpose">
          Save this recovery key somewhere safe. If you ever forget your password, it lets you choose a new one. You
          don't need it to log in or to play. It is shown once — it will not be shown again.
        </p>
      ) : (
        <p style={styles.text} data-testid="recovery-key-purpose">
          This is your recovery key. It is the only way back into your profile if you lose this browser and have no
          other signed-in device. It is shown once — it will not be shown again.
        </p>
      )}
      <code style={styles.secret} data-testid="recovery-key-value">
        {recoveryKey}
      </code>
      <div style={styles.row}>
        <button type="button" style={styles.secondary} onClick={() => void copy()}>
          Copy
        </button>
        <button type="button" style={styles.secondary} onClick={save}>
          Save as file
        </button>
        {said ? (
          <span role="status" style={styles.label}>
            {said}
          </span>
        ) : null}
      </div>
      {purpose === "account" ? (
        <p style={styles.text}>
          Anyone with this key can reset your password. Keep it private: store it in a password manager or a file only
          you can open, and never share it. There is no email reset — if you lose both your password and this key, the
          account cannot be recovered.
        </p>
      ) : (
        <p style={styles.text}>
          Anyone with this key can sign in as you. Keep it private: store it in a password manager or a file only you
          can open, and never share it.
        </p>
      )}
      <label style={styles.check}>
        <input type="checkbox" checked={saved} onChange={(event) => setSaved(event.target.checked)} data-testid="recovery-key-saved" />
        I have saved my recovery key somewhere safe
      </label>
      <button
        type="button"
        style={disabledLook(styles.primary, !saved)}
        disabled={!saved}
        onClick={onContinue}
        data-testid="recovery-key-continue"
      >
        {continueLabel}
      </button>
    </div>
  );
}
