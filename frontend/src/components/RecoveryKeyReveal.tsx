// frontend/src/components/RecoveryKeyReveal.tsx
//
// LIVE-2E: THE RECOVERY KEY, SHOWN ONCE. The server hands the key out exactly once -- on "Create profile" and on
// "Rotate recovery key" -- and this is the one screen that holds it. It offers Copy and "Save as file" (a Blob
// download whose object URL is revoked right after the click), says plainly what the key is for and who else could
// use it, and will not continue until the player ticks that they have saved it. The key lives in the caller's state
// only while this screen is up; nothing here logs it, stores it or puts it in a URL.

import React, { useState } from "react";

import { APP_NAME } from "../config";
import { disabledLook, profileStyles as styles } from "./profileStyles";

/** The download's name. */
export const RECOVERY_KEY_FILE = "18cosmos-recovery-key.txt";

function keyFileText(recoveryKey: string): string {
  return [
    `${APP_NAME} — recovery key`,
    "",
    recoveryKey,
    "",
    "This key is the only way back into your profile if you lose this browser and have no other signed-in device.",
    "Anyone with it can sign in as you. Keep it private.",
    "",
  ].join("\n");
}

/** A text file download. The object URL lives only until the click has been handled (LIVE-2E review I1: revoking it
 *  in the same task can abort the download in some browsers). */
function saveKeyFile(recoveryKey: string): boolean {
  if (typeof URL.createObjectURL !== "function") return false;
  const url = URL.createObjectURL(new Blob([keyFileText(recoveryKey)], { type: "text/plain;charset=utf-8" }));
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
}: {
  recoveryKey: string;
  onContinue: () => void;
  heading?: string;
  continueLabel?: string;
  /** A line above the key (e.g. "Your old recovery key no longer works."). */
  notice?: string;
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
      ok = saveKeyFile(recoveryKey);
    } catch {
      ok = false;
    }
    setSaid(ok ? `Saved as ${RECOVERY_KEY_FILE}.` : "This browser would not save a file. Copy the key instead.");
  };

  return (
    <div role="dialog" aria-labelledby="recovery-key-title" data-testid="recovery-key-reveal">
      <h2 id="recovery-key-title" style={styles.heading}>
        {heading}
      </h2>
      {notice ? <p style={styles.notice}>{notice}</p> : null}
      <p style={styles.text}>
        This is your recovery key. It is the only way back into your profile if you lose this browser and have no
        other signed-in device. It is shown once — it will not be shown again.
      </p>
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
      <p style={styles.text}>
        Anyone with this key can sign in as you. Keep it private: store it in a password manager or a file only you
        can open, and never share it.
      </p>
      <label style={styles.check}>
        <input type="checkbox" checked={saved} onChange={(event) => setSaved(event.target.checked)} data-testid="recovery-key-saved" />
        I have saved my recovery key
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
