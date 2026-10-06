// frontend/src/components/ProfileMenu.tsx
//
// ==================================================================
//  LIVE-2E / P3-ACCT: THE ACCOUNT CORNER -- "LOG IN" AND "CREATE ACCOUNT", OR THE ACCOUNT'S OWN MENU
// ==================================================================
//
// In the lobby's account corner and in the table's top bar. SIGNED OUT (a visitor, P3-ACCT public first): two buttons,
// Log in and Create account, opening the account dialog (`AccountDialog.tsx`). SIGNED IN: a chip with the account's
// name; its menu shows
//
//   who            the name, the username (this account's own sessions only) and the day it was made
//   wallet         the payout wallet this account PROVED it controls (P3-ACCT: kept across games, so another game
//                  asks Keplr to sign, never the password), with "Forget this wallet" (sensitive)
//   facts          what other players see about this account (`TrustFacts.tsx`: facts, never a score)
//   password &     P3-ACCT POLICY (owner rulings 2026-10-05): "Change password" -- the current password, or the
//   recovery key   recovery key, in the request itself, and the new one (12+ characters); every other device is
//                  signed out and this one stays signed in. "Make a new recovery key" -- for every account: it asks
//                  "Confirm it's you" (the password; a legacy profile's key) even right after signing in, shows the
//                  new key once, and the old key stops working at once.
//   sign out       other devices (asked first, with how many), or this one (asked first; the account and its
//                  seats are kept)
//   older options  for a profile made before accounts only: set a username and password (sensitive: its recovery
//                  key confirms it), link another device with a code -- collapsed, so the old ceremony never leads
//
// SENSITIVE actions (ESCROW-3A §10B) answer 403 `reauth-required`; the menu shows the shared "Confirm it's you"
// (`ConfirmItsYou`: the password, or a legacy profile's recovery key) and runs the chosen action again at once.
//
// ESCROW-4 (F-3, preflight OD-4-6): "Sign out this device" says so when this browser holds real-money signing keys, and
// removes them by default (a box, ticked) -- deposits and payouts don't depend on them.
//
// A development-identity build has no credentials to manage: the chip says "Development profile (this tab)" and
// offers nothing. Codes, keys and passwords live in this component's state while their view is up; closing the menu
// drops them. Nothing is logged, stored or put in a URL.

import { forgetActiveTable } from "../utils/activeGame";
import React, { useCallback, useEffect, useRef, useState } from "react";

import { sessionPort, type SessionPort } from "../utils/sessionBootstrap";
import { useSession } from "../utils/useSession";
import { useDialogDismissal } from "../utils/useDialogDismissal";
import {
  LINK_CODE_LIFETIME_MS,
  PASSWORD_MIN_LENGTH,
  USERNAME_MAX,
  accountDetails,
  changePassword,
  createLinkCode,
  establishCredentials,
  forgetWallet,
  profileErrorSentence,
  rotateRecoveryKey,
  signOutOtherDevices,
  signOutThisDevice,
  type AccountDetails,
} from "../utils/profileApi";
import { openAccountDialog } from "../utils/accountPrompt";
import { renewRoomLinks } from "../utils/roomLink";
import { RecoveryKeyReveal } from "./RecoveryKeyReveal";
import { ConfirmItsYou } from "./ConfirmItsYou";
import { MyTrustFacts } from "./TrustFacts";
import { conductRole } from "../utils/conductApi";
import { openInfoPage } from "../utils/infoPages";
import { browserConsentKeys } from "../money/consentKeys";
import { disabledLook, profileStyles as styles } from "./profileStyles";
import { SANDBOX_INK, SANDBOX_RAISED, SANDBOX_RULE_STRONG, SANDBOX_TEXT } from "../styles/palette";
import { CONTROL_PADDING, FONT_FAMILY, FONT_SIZE, RADIUS } from "../styles/typography";

type Then = "rotate" | "others" | "credentials" | "forget-wallet";

type View =
  | { kind: "menu" }
  | { kind: "link"; code: string | null; deadline: number }
  | { kind: "rotate-confirm" }
  | { kind: "others-confirm" }
  | { kind: "others-done"; signedOut: number }
  | { kind: "signout-confirm" }
  /** P3-ACCT: a legacy profile chooses a username and password. */
  | { kind: "credentials" }
  | { kind: "credentials-done"; username: string }
  /** P3-ACCT: forget the verified wallet (asked first). */
  | { kind: "forget-wallet-confirm" }
  /** P3-ACCT POLICY: change the password (the current password or the recovery key, and the new one). */
  | { kind: "password" }
  | { kind: "password-done"; signedOut: number }
  /** ESCROW-3A: the server asked this session to confirm it's you before `then` runs. */
  | { kind: "reauth"; then: Then };

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
      <p style={styles.text}>On the other device, press Log in, then “Made a profile before accounts? Other ways to sign in” → “Code from a signed-in device”, and enter this code. It works once, for 10 minutes.</p>
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

const dayOf = (ms: number): string => {
  try {
    return new Date(ms).toISOString().slice(0, 10);
  } catch {
    return "";
  }
};
const shortAddress = (address: string): string => (address.length > 16 ? `${address.slice(0, 10)}…${address.slice(-4)}` : address);

function MenuPanel({ port, name, otherSessions, onClose }: { port: SessionPort; name: string; otherSessions: number; onClose: () => void }): JSX.Element {
  const [view, setView] = useState<View>({ kind: "menu" });
  const [reveal, setReveal] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /* P3-ACCT: the account as its own session reads it (username, wallet, member since); null until it answers. */
  const [details, setDetails] = useState<AccountDetails | null>(null);
  /* P3-ACCT: a legacy profile's chosen username and password -- this view's state only, the password cleared on send. */
  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  /* P3-ACCT POLICY "Change password": the current secret (password, or the recovery key) -- cleared on send. */
  const [currentSecret, setCurrentSecret] = useState("");
  const [usingKey, setUsingKey] = useState(false);
  /* ESCROW-4: how many real-money signing keys this browser holds, and whether signing out removes them (default). */
  const [signingKeys, setSigningKeys] = useState(0);
  const [removeKeys, setRemoveKeys] = useState(true);
  useDialogDismissal({ onDismiss: onClose, dismissible: !busy && reveal === null });

  const refresh = useCallback(() => {
    void accountDetails(port).then((answer) => setDetails(answer.ok ? answer.account : null));
  }, [port]);
  useEffect(() => {
    refresh();
  }, [refresh]);
  /* Phase 3 (P3-N032): only an account the server names as a conduct reviewer sees the review entry. */
  const [reviewer, setReviewer] = useState(false);
  useEffect(() => {
    let live = true;
    void conductRole(port)
      .then((answer) => {
        if (live) setReviewer(answer);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [port]);

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

  /* P3-ACCT: a legacy profile sets a username and password (its recovery key confirms it). */
  const saveCredentials = async () => {
    const typed = newPassword;
    setNewPassword("");
    setBusy(true);
    setError(null);
    const result = await establishCredentials({ username: newUsername, password: typed }, port);
    setBusy(false);
    if (!result.ok) {
      if (result.error === "reauth-required") {
        /* Keep the password only for the immediate retry after "Confirm it's you" (still this view's state). */
        setNewPassword(typed);
        return go({ kind: "reauth", then: "credentials" });
      }
      setError(profileErrorSentence(result, "account"));
      return;
    }
    setNewUsername("");
    setView({ kind: "credentials-done", username: result.username });
    refresh();
  };

  /* P3-ACCT POLICY: change the password -- the credential travels in the request; this browser gets a fresh session
     (the port re-bootstraps before the call resolves) and its sockets move to it. */
  const savePassword = async () => {
    /* Review NIT 8: a too-short password is said before anything is cleared. */
    if (Array.from(newPassword).length < PASSWORD_MIN_LENGTH) {
      setError(profileErrorSentence({ ok: false, error: "bad-password", problem: "too-short" }));
      return;
    }
    const current = currentSecret;
    const chosen = newPassword;
    setCurrentSecret("");
    setNewPassword("");
    setBusy(true);
    setError(null);
    const result = await changePassword({ current: usingKey ? { recoveryKey: current } : { password: current }, newPassword: chosen }, port);
    setBusy(false);
    if (!result.ok) {
      setError(profileErrorSentence(result, "change"));
      return;
    }
    renewRoomLinks();
    setUsingKey(false);
    setView({ kind: "password-done", signedOut: result.signedOut });
    refresh();
  };

  const forget = async () => {
    setBusy(true);
    setError(null);
    const result = await forgetWallet(port);
    setBusy(false);
    if (!result.ok) {
      if (result.error === "reauth-required") return go({ kind: "reauth", then: "forget-wallet" });
      setError(profileErrorSentence(result));
      return;
    }
    setView({ kind: "menu" });
    refresh();
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
            purpose={details !== null && details.username === null ? "legacy" : "account"}
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
    <button
      type="button"
      style={disabledLook(styles.secondary, busy)}
      disabled={busy}
      onClick={() => {
        /* Review NIT 11: typed secrets do not outlive the view. */
        setCurrentSecret("");
        setNewPassword("");
        go({ kind: "menu" });
      }}
    >
      Back
    </button>
  );
  const legacy = details !== null && details.username === null;
  const reauthPurpose: Record<Then, string> = {
    rotate: "To make a new recovery key",
    others: "To sign out your other devices",
    credentials: "To set a username and password",
    "forget-wallet": "To forget your verified wallet",
  };

  return (
    <div role="dialog" aria-labelledby="profile-menu-title" style={menuStyles.panel} data-testid="profile-menu-panel">
      <h2 id="profile-menu-title" style={styles.subheading}>
        Signed in as {name}
      </h2>
      {details !== null ? (
        <p style={menuStyles.facts} data-testid="profile-menu-account">
          {details.username !== null ? `Username ${details.username} · ` : ""}Member since {dayOf(details.memberSince)}
        </p>
      ) : null}
      {view.kind === "menu" ? (
        <div style={menuStyles.list}>
          {details !== null ? (
            <div style={menuStyles.section} data-testid="profile-menu-wallet">
              <p style={menuStyles.sectionLabel}>Payout wallet</p>
              {details.wallet !== null ? (
                <>
                  <p style={menuStyles.facts}>
                    {shortAddress(details.wallet.address)} · verified {dayOf(details.wallet.verifiedAt)}. Your next real-money table asks Keplr to sign for it — never your password.
                  </p>
                  <button type="button" style={disabledLook(styles.secondary, busy)} disabled={busy} onClick={() => go({ kind: "forget-wallet-confirm" })} data-testid="profile-menu-forget-wallet">
                    Forget this wallet
                  </button>
                </>
              ) : (
                <p style={menuStyles.facts}>None yet. Your first real-money ante verifies the wallet you deposit from.</p>
              )}
            </div>
          ) : null}
          <MyTrustFacts port={port} />
          {reviewer ? (
            <button
              type="button"
              style={styles.secondary}
              onClick={() => {
                onClose();
                openInfoPage("conduct-review");
              }}
              data-testid="profile-menu-conduct-review"
            >
              Review conduct reports
            </button>
          ) : null}
          {legacy ? (
            <button type="button" style={styles.primary} onClick={() => go({ kind: "credentials" })} data-testid="profile-menu-credentials">
              Set a username and password
            </button>
          ) : null}
          {details !== null && !legacy ? (
            <button
              type="button"
              style={styles.secondary}
              onClick={() => {
                setCurrentSecret("");
                setNewPassword("");
                setUsingKey(false);
                go({ kind: "password" });
              }}
              data-testid="profile-menu-password"
            >
              Change password
            </button>
          ) : null}
          {details !== null ? (
            <>
              <button type="button" style={styles.secondary} onClick={() => go({ kind: "rotate-confirm" })} data-testid="profile-menu-rotate">
                Make a new recovery key
              </button>
              <p style={styles.label} data-testid="profile-menu-key-note">
                {legacy
                  ? "Your recovery key signs this profile in on another device."
                  : details.recoveryKey
                    ? "Your recovery key lets you choose a new password if you forget yours. You never need it to log in or play. Lost it, or never saved it? Make a new one."
                    : "This account has no recovery key yet. Make one so a forgotten password can be reset."}
              </p>
            </>
          ) : null}
          <button type="button" style={styles.secondary} onClick={confirmOthers} data-testid="profile-menu-others">
            Sign out other devices
          </button>
          <p style={styles.label} data-testid="profile-menu-others-count">
            {otherSessions === 0 ? "No other devices are signed in." : `${devices(otherSessions)} signed in.`}
          </p>
          <button type="button" style={styles.secondary} onClick={() => go({ kind: "signout-confirm" })} data-testid="profile-menu-signout">
            Sign out this device
          </button>
          {legacy ? (
            <details style={menuStyles.older} data-testid="profile-menu-older">
              <summary style={menuStyles.summary}>Older sign-in options</summary>
              <div style={{ ...menuStyles.list, marginTop: "8px" }}>
                <button type="button" style={disabledLook(styles.secondary, busy)} disabled={busy} onClick={() => void makeCode()} data-testid="profile-menu-link">
                  {busy ? "Making a code…" : "Link another device"}
                </button>
              </div>
            </details>
          ) : null}
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
          <p style={styles.text}>
            Make a new recovery key? Your current recovery key stops working immediately, and the new one is shown once. Your verified payout wallet is forgotten too, and a wallet linked at a real-money table that hasn't started has to be linked again (one Keplr signature).{legacy ? "" : " You'll confirm with your password first."}
          </p>
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
              ? "No other devices are signed in to this account right now."
              : `${devices(otherSessions)} ${otherSessions === 1 ? "is" : "are"} signed in to this account.`}{" "}
            Signing them out ends their sessions at once; to sign back in they log in again.
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
      {view.kind === "credentials" ? (
        <form
          method="post"
          style={styles.form}
          onSubmit={(event) => {
            event.preventDefault();
            if (!busy) void saveCredentials();
          }}
          data-testid="profile-credentials-form"
        >
          <p style={styles.text}>Choose a username and password to log in with from now on. Your recovery key keeps working too.</p>
          <label style={styles.label} htmlFor="profile-new-username">
            Username
          </label>
          <input id="profile-new-username" name="username" autoComplete="username" autoCapitalize="off" autoCorrect="off" spellCheck={false} maxLength={USERNAME_MAX * 2} style={styles.input} value={newUsername} onChange={(event) => setNewUsername(event.target.value)} data-testid="profile-new-username" />
          <label style={styles.label} htmlFor="profile-new-password">
            Password (at least {PASSWORD_MIN_LENGTH} characters)
          </label>
          <input id="profile-new-password" name="password" type="password" autoComplete="new-password" style={styles.input} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} data-testid="profile-new-password" />
          <div style={styles.row}>
            <button type="submit" style={disabledLook(styles.primary, busy)} disabled={busy} data-testid="profile-credentials-save">
              {busy ? "Saving…" : "Save"}
            </button>
            {back}
          </div>
        </form>
      ) : null}
      {view.kind === "credentials-done" ? (
        <>
          <p style={styles.text} role="status" data-testid="profile-credentials-done">
            Done. Log in as {view.username} with your new password from now on.
          </p>
          <div style={styles.row}>{back}</div>
        </>
      ) : null}
      {view.kind === "password" ? (
        <form
          method="post"
          style={styles.form}
          onSubmit={(event) => {
            event.preventDefault();
            if (!busy) void savePassword();
          }}
          data-testid="profile-password-form"
        >
          <p style={styles.text}>Every other device signed in to this account is signed out. This one stays signed in.</p>
          <label style={styles.label} htmlFor="profile-current-secret">
            {usingKey ? "Your recovery key" : "Current password"}
          </label>
          <input
            id="profile-current-secret"
            name={usingKey ? "recovery-key" : "current-password"}
            type="password"
            autoComplete={usingKey ? "off" : "current-password"}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            style={usingKey ? styles.monoInput : styles.input}
            value={currentSecret}
            onChange={(event) => setCurrentSecret(event.target.value)}
            data-testid="profile-current-secret"
          />
          <button
            type="button"
            style={disabledLook(menuStyles.link, busy)}
            disabled={busy}
            onClick={() => {
              setCurrentSecret("");
              setError(null);
              setUsingKey(!usingKey);
            }}
            data-testid="profile-password-use-key"
          >
            {usingKey ? "Use your current password instead" : "Forgot it? Use your recovery key instead"}
          </button>
          <label style={styles.label} htmlFor="profile-changed-password">
            New password (at least {PASSWORD_MIN_LENGTH} characters)
          </label>
          <input
            id="profile-changed-password"
            name="new-password"
            type="password"
            autoComplete="new-password"
            style={styles.input}
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
            data-testid="profile-changed-password"
          />
          <div style={styles.row}>
            <button type="submit" style={disabledLook(styles.primary, busy)} disabled={busy} data-testid="profile-password-save">
              {busy ? "Changing…" : "Change password"}
            </button>
            {back}
          </div>
        </form>
      ) : null}
      {view.kind === "password-done" ? (
        <>
          <p style={styles.text} role="status" data-testid="profile-password-done">
            Password changed. {view.signedOut === 0 ? "No other devices were signed in." : `Signed out ${devices(view.signedOut)}.`} This device stays signed in.
          </p>
          {details !== null && details.wallet !== null ? (
            /* Security review M2 (residual): the verified wallet is kept by a password change -- shown here, so a wallet the
               player doesn't recognise is forgotten at once. */
            <p style={styles.label} data-testid="profile-password-wallet">
              Your verified payout wallet is still {shortAddress(details.wallet.address)}. Not yours?{" "}
              <button type="button" style={disabledLook(menuStyles.link, busy)} disabled={busy} onClick={() => go({ kind: "forget-wallet-confirm" })} data-testid="profile-password-forget-wallet">
                Forget this wallet
              </button>
            </p>
          ) : null}
          <div style={styles.row}>{back}</div>
        </>
      ) : null}
      {view.kind === "forget-wallet-confirm" ? (
        <>
          <p style={styles.text} data-testid="profile-forget-wallet-summary">
            Forget your verified wallet? Seats already linked keep their wallet. Your next real-money table asks you to confirm it's you before a wallet is verified again.
          </p>
          <div style={styles.row}>
            <button type="button" style={disabledLook(styles.primary, busy)} disabled={busy} onClick={() => void forget()} data-testid="profile-forget-wallet-confirm">
              {busy ? "Forgetting…" : "Forget this wallet"}
            </button>
            {back}
          </div>
        </>
      ) : null}
      {view.kind === "reauth" ? (
        /* ESCROW-4: the shared "Confirm it's you"; the action the player chose runs again once it is granted. Setting a
           username is a legacy profile's own step, so its recovery key confirms it. */
        <ConfirmItsYou
          purpose={reauthPurpose[view.then]}
          port={port}
          busy={busy}
          onBusyChange={setBusy}
          {...(view.then === "credentials" || (view.then === "rotate" && legacy) ? { method: "recovery-key" as const } : view.then === "rotate" ? { method: "password" as const } : {})}
          onConfirmed={() => {
            switch (view.then) {
              case "rotate":
                return rotate();
              case "others":
                return signOutOthers();
              case "credentials":
                setView({ kind: "credentials" });
                return saveCredentials();
              default:
                return forget();
            }
          }}
          onCancel={() => {
            setNewPassword("");
            setCurrentSecret("");
            go({ kind: "menu" });
          }}
        />
      ) : null}
      {view.kind === "signout-confirm" ? (
        <>
          <p style={styles.text}>Sign out this device? Your account and its seats are kept. To come back on this browser, log in again.</p>
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
  const { state, account } = useSession(port);
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

  if (account === null || state !== "ready") {
    /* P3-ACCT (public first): a visitor -- or a page whose bootstrap hasn't answered yet -- sees the two ways in. An
       ended session is `SessionEndedNotice`'s to explain first. */
    if (state === "ended") return null;
    return (
      <span style={menuStyles.anchor} data-testid="account-buttons">
        <button type="button" style={menuStyles.chip} onClick={() => openAccountDialog("login")} data-testid="account-login">
          Log in
        </button>
        <button type="button" style={menuStyles.create} onClick={() => openAccountDialog("create")} data-testid="account-create">
          Create account
        </button>
      </span>
    );
  }
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
        title="Your account"
        data-testid="profile-chip"
      >
        {account.name}
      </button>
      {open ? <MenuPanel port={port} name={account.name} otherSessions={account.otherSessions} onClose={close} /> : null}
    </span>
  );
}

const menuStyles: Record<"anchor" | "chip" | "create" | "panel" | "list" | "footer" | "facts" | "section" | "sectionLabel" | "older" | "summary" | "link", React.CSSProperties> = {
  anchor: { position: "relative", display: "inline-flex", flexWrap: "wrap", gap: "8px" },
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
  /* P3-ACCT: "Create account" is the corner's call to action -- the paper slab the lobby's primary controls use. */
  create: {
    fontSize: FONT_SIZE.small,
    fontWeight: 700,
    padding: CONTROL_PADDING.buttonSmall,
    borderRadius: RADIUS.pill,
    border: "1px solid transparent",
    backgroundColor: "#f2f0eb",
    color: "#080808",
    fontFamily: FONT_FAMILY,
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  facts: { margin: "0 0 4px", fontSize: FONT_SIZE.small, color: SANDBOX_TEXT, lineHeight: 1.4 },
  section: { display: "flex", flexDirection: "column", gap: "4px", padding: "8px 0", borderTop: `1px solid ${SANDBOX_RULE_STRONG}`, borderBottom: `1px solid ${SANDBOX_RULE_STRONG}` },
  sectionLabel: { margin: 0, fontSize: FONT_SIZE.small, fontWeight: 700, color: SANDBOX_INK },
  older: { marginTop: "4px", fontSize: FONT_SIZE.small, color: SANDBOX_TEXT },
  summary: { cursor: "pointer" },
  link: { alignSelf: "flex-start", background: "none", border: "none", padding: "2px 0", color: SANDBOX_TEXT, textDecoration: "underline", cursor: "pointer", fontSize: FONT_SIZE.small, fontFamily: FONT_FAMILY },
};
