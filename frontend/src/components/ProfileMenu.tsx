// frontend/src/components/ProfileMenu.tsx
//
// ==================================================================
//  THE ACCOUNT CORNER -- "LOG IN" AND "CREATE ACCOUNT", OR THE ACCOUNT'S OWN MENU
// ==================================================================
//
// In the lobby's account corner and in the table's top bar. SIGNED OUT (a visitor, public first): two buttons, Log in and
// Create account, opening the account dialog (`AccountDialog.tsx`). SIGNED IN: a chip with the account's name; its menu
// shows
//
//   who            the name, the username (this account's own sessions only) and the day it was made
//   Authorization  PHASE 3 FINAL (owner ruling 2026-10-06): the account's ONE designated Authorization Wallet (shortened)
//   Wallet         and since when -- the wallet that recovers the account ("Forgot password?") and approves its own
//                  replacement. It is NOT a game wallet: each table binds the wallet its ante came from, and the wallet
//                  Keplr happens to have selected is neither. "Change Authorization Wallet" asks "Confirm it's you" (the
//                  password, always), then the NEW wallet accepts and the CURRENT one approves -- two Keplr signatures.
//   facts          what other players see about this account (`TrustFacts.tsx`: facts, never a score)
//   password       "Change password" -- the current password and the new one (12+ characters); every other device is
//                  signed out and this one stays signed in. (Forgot it? Sign out, then "Forgot password?" with the
//                  Authorization Wallet.)
//   sign out       other devices (asked first, with how many), or this one (asked first; the account and its seats are
//                  kept)
//
// There is NO recovery key and NO "link another device" code: a second device logs in.
//
// SENSITIVE actions (ESCROW-3A §10B) answer 403 `reauth-required`; the menu shows the shared "Confirm it's you"
// (`ConfirmItsYou`: the password) and runs the chosen action again at once.
//
// ESCROW-4 (F-3, preflight OD-4-6): "Sign out this device" says so when this browser holds real-money signing keys, and
// removes them by default (a box, ticked) -- deposits and payouts don't depend on them.
//
// A development-identity build has no credentials to manage: the chip says "Development profile (this tab)" and offers
// nothing. Passwords live in this component's state while their view is up; closing the menu drops them. Nothing is
// logged, stored or put in a URL.

import { forgetActiveTable } from "../utils/activeGame";
import React, { useCallback, useEffect, useRef, useState } from "react";

import { sessionPort, type SessionPort } from "../utils/sessionBootstrap";
import { useSession } from "../utils/useSession";
import { useDialogDismissal } from "../utils/useDialogDismissal";
import {
  PASSWORD_MIN_LENGTH,
  accountDetails,
  changePassword,
  mintAuthorization,
  profileErrorSentence,
  recoverAccount,
  replaceAuthorizationWallet,
  replacementChallenge,
  signOutOtherDevices,
  signOutThisDevice,
  type AccountDetails,
  type AuthorizationSignature,
  type MintedAuthorization,
} from "../utils/profileApi";
import { keplrAccountNow, shortWallet, signAuthorization } from "../utils/authorizationWalletFlow";
import { openAccountDialog } from "../utils/accountPrompt";
import { renewRoomLinks } from "../utils/roomLink";
import { ConfirmItsYou } from "./ConfirmItsYou";
import { KeplrMark } from "./money/KeplrMark";
import { MyTrustFacts } from "./TrustFacts";
import { conductRole } from "../utils/conductApi";
import { openInfoPage } from "../utils/infoPages";
import { browserConsentKeys } from "../money/consentKeys";
import { disabledLook, profileStyles as styles } from "./profileStyles";
import { SANDBOX_INK, SANDBOX_RAISED, SANDBOX_RULE_STRONG, SANDBOX_TEXT } from "../styles/palette";
import { CONTROL_PADDING, FONT_FAMILY, FONT_SIZE, RADIUS } from "../styles/typography";

type Then = "others" | "replace";

/** "Change Authorization Wallet", step by step (after "Confirm it's you"). */
type Replace =
  /** Switch Keplr to the NEW wallet and use it. */
  | { step: "new"; candidate: string | null }
  /** The NEW wallet signed its acceptance; switch Keplr to the CURRENT one and approve. */
  | { step: "approve"; minted: MintedAuthorization; next: string; accept: AuthorizationSignature }
  | { step: "done"; wallet: string };

type View =
  | { kind: "menu" }
  | { kind: "others-confirm" }
  | { kind: "others-done"; signedOut: number }
  | { kind: "signout-confirm" }
  /** Change the password (the current password and the new one). */
  | { kind: "password" }
  | { kind: "password-done"; signedOut: number }
  /** PHASE 4: "Forgot current password?" while signed in -- the Authorization Wallet approves it in Keplr. */
  | { kind: "forgot" }
  | { kind: "forgot-done"; signedOut: number }
  /** PHASE 3 FINAL: change the Authorization Wallet. */
  | { kind: "replace"; state: Replace }
  /** ESCROW-3A: the server asked this session to confirm it's you before `then` runs. */
  | { kind: "reauth"; then: Then };

const devices = (count: number) => `${count} other device${count === 1 ? "" : "s"}`;

const dayOf = (ms: number): string => {
  try {
    return new Date(ms).toISOString().slice(0, 10);
  } catch {
    return "";
  }
};

function MenuPanel({ port, name, otherSessions, onClose }: { port: SessionPort; name: string; otherSessions: number; onClose: () => void }): JSX.Element {
  const [view, setView] = useState<View>({ kind: "menu" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /* The account as its own session reads it (username, Authorization Wallet, member since); null until it answers. */
  const [details, setDetails] = useState<AccountDetails | null>(null);
  /* "Change password": the current password and the new one -- this view's state only, cleared on send. */
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  /* ESCROW-4: how many real-money signing keys this browser holds, and whether signing out removes them (default). */
  const [signingKeys, setSigningKeys] = useState(0);
  const [removeKeys, setRemoveKeys] = useState(true);
  useDialogDismissal({ onDismiss: onClose, dismissible: !busy });

  const refresh = useCallback(() => {
    void accountDetails(port).then((answer) => setDetails(answer.ok ? answer.account : null));
  }, [port]);
  useEffect(() => {
    refresh();
  }, [refresh]);
  /* Phase 3 (P3-N035): only an account the server names as a conduct reviewer sees the review entry. */
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

  /* "Change password": the credential travels in the request; this browser gets a fresh session (the port re-bootstraps
     before the call resolves) and its sockets move to it. */
  const savePassword = async () => {
    /* Review NIT 8: a too-short password is said before anything is cleared. */
    if (Array.from(newPassword).length < PASSWORD_MIN_LENGTH) {
      setError(profileErrorSentence({ ok: false, error: "bad-password", problem: "too-short" }));
      return;
    }
    const current = currentPassword;
    const chosen = newPassword;
    setCurrentPassword("");
    setNewPassword("");
    setBusy(true);
    setError(null);
    const result = await changePassword({ currentPassword: current, newPassword: chosen }, port);
    setBusy(false);
    if (!result.ok) {
      setError(profileErrorSentence(result, "change"));
      return;
    }
    renewRoomLinks();
    setView({ kind: "password-done", signedOut: result.signedOut });
    refresh();
  };

  /* PHASE 4: "Forgot current password?" -- signed in, without the old password and without signing out first. The
     account's Authorization Wallet signs the same RECOVER text as signed-out recovery (checked before Keplr signs: this
     site, this account, that wallet); the server accepts it for THIS account only. This browser stays signed in on a
     fresh session; every other device is signed out; seats, games, deposits and wallets are unchanged. */
  const resetForgotten = async () => {
    if (details === null) return;
    if (Array.from(newPassword).length < PASSWORD_MIN_LENGTH) {
      setError(profileErrorSentence({ ok: false, error: "bad-password", problem: "too-short" }));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const wallet = await readKeplr();
      if (wallet === null) return;
      const authority = details.authorizationWallet.address;
      if (wallet !== authority) {
        setError(`Keplr is on ${shortWallet(wallet)}. Switch Keplr to your Authorization Wallet (${shortWallet(authority)}) and try again. Nothing was signed.`);
        return;
      }
      const minted = await mintAuthorization({ purpose: "recover", username: details.username, wallet }, port);
      if (!minted.ok) {
        setError(profileErrorSentence(minted, "recover"));
        return;
      }
      const signed = await signAuthorization(minted.minted.texts[0].text, { purpose: "RECOVER", account: details.username, signer: wallet, authorizationWallet: authority });
      if (!signed.ok) {
        setError(signed.reason);
        return;
      }
      const chosen = newPassword;
      setNewPassword("");
      const result = await recoverAccount({ operation: minted.minted.operation, signed: signed.signed, newPassword: chosen }, port);
      if (!result.ok) {
        setError(profileErrorSentence(result, "recover"));
        return;
      }
      renewRoomLinks();
      setView({ kind: "forgot-done", signedOut: result.signedOut });
      refresh();
    } finally {
      setBusy(false);
    }
  };

  /* ---------------- "Change Authorization Wallet" ---------------- */

  /** Read the wallet Keplr is on now (connecting on the first press). */
  const readKeplr = async (): Promise<string | null> => {
    const now = await keplrAccountNow(true);
    if (!now.ok) {
      setError(now.reason);
      return null;
    }
    return now.address;
  };

  /** Step 1: the NEW wallet (Keplr is on it): mint the two texts, and the new wallet signs its acceptance at once. */
  const acceptNewWallet = async () => {
    if (details === null) return;
    setBusy(true);
    setError(null);
    try {
      const next = await readKeplr();
      if (next === null) return;
      if (next === details.authorizationWallet.address) {
        setView({ kind: "replace", state: { step: "new", candidate: next } });
        return setError(profileErrorSentence({ ok: false, error: "same-wallet" }));
      }
      const minted = await replacementChallenge(next, port);
      if (!minted.ok) {
        if (minted.error === "reauth-required") return go({ kind: "reauth", then: "replace" });
        return setError(profileErrorSentence(minted, "replace"));
      }
      const accept = minted.minted.texts[1];
      const signed = await signAuthorization(accept.text, {
        purpose: "REPLACE-ACCEPT",
        account: details.username,
        signer: next,
        authorizationWallet: next,
        replaces: details.authorizationWallet.address,
        operation: minted.minted.operation,
      });
      if (!signed.ok) {
        setView({ kind: "replace", state: { step: "new", candidate: next } });
        return setError(signed.reason);
      }
      setView({ kind: "replace", state: { step: "approve", minted: minted.minted, next, accept: signed.signed } });
    } finally {
      setBusy(false);
    }
  };

  /** Step 2: the CURRENT Authorization Wallet approves; then the replacement is sent with both signatures. */
  const approveWithCurrent = async (state: Extract<Replace, { step: "approve" }>) => {
    if (details === null) return;
    setBusy(true);
    setError(null);
    try {
      const current = details.authorizationWallet.address;
      const on = await readKeplr();
      if (on === null) return;
      if (on !== current) return setError(`Keplr is on ${shortWallet(on)}. Switch Keplr to your current Authorization Wallet, ${shortWallet(current)}, to approve.`);
      const approve = state.minted.texts[0];
      const signed = await signAuthorization(approve.text, {
        purpose: "REPLACE-APPROVE",
        account: details.username,
        signer: current,
        authorizationWallet: state.next,
        replaces: current,
        operation: state.minted.operation,
      });
      if (!signed.ok) return setError(signed.reason);
      const replaced = await replaceAuthorizationWallet({ operation: state.minted.operation, approve: signed.signed, accept: state.accept }, port);
      if (!replaced.ok) {
        setView({ kind: "replace", state: { step: "new", candidate: null } });
        return setError(profileErrorSentence(replaced, "replace"));
      }
      setView({ kind: "replace", state: { step: "done", wallet: replaced.authorizationWallet.address } });
      refresh();
    } finally {
      setBusy(false);
    }
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

  const back = (
    <button
      type="button"
      style={disabledLook(styles.secondary, busy)}
      disabled={busy}
      onClick={() => {
        /* Review NIT 11: typed secrets do not outlive the view. */
        setCurrentPassword("");
        setNewPassword("");
        go({ kind: "menu" });
      }}
    >
      Back
    </button>
  );
  const reauthPurpose: Record<Then, string> = {
    others: "To sign out your other devices",
    replace: "To change your Authorization Wallet",
  };
  const replace = view.kind === "replace" ? view.state : null;

  return (
    <div role="dialog" aria-labelledby="profile-menu-title" style={menuStyles.panel} data-testid="profile-menu-panel">
      <h2 id="profile-menu-title" style={styles.subheading}>
        Signed in as {name}
      </h2>
      {details !== null ? (
        <p style={menuStyles.facts} data-testid="profile-menu-account">
          Username {details.username} · Member since {dayOf(details.memberSince)}
        </p>
      ) : null}
      {view.kind === "menu" ? (
        <div style={menuStyles.list}>
          {details !== null ? (
            <div style={menuStyles.section} data-testid="profile-menu-authorization">
              <p style={menuStyles.sectionLabel}>Authorization Wallet</p>
              <p style={menuStyles.facts} data-testid="profile-menu-authorization-wallet">
                <span title={details.authorizationWallet.address}>{shortWallet(details.authorizationWallet.address)}</span> · since {dayOf(details.authorizationWallet.since)}
              </p>
              <p style={menuStyles.facts} data-testid="profile-menu-authorization-note">
                It recovers this account if you forget your password. It isn't a game wallet: each table pays out to the wallet you anted with there, and the wallet Keplr has selected never changes who you are.
              </p>
              <button type="button" style={disabledLook(styles.secondary, busy)} disabled={busy} onClick={() => go({ kind: "reauth", then: "replace" })} data-testid="profile-menu-replace-wallet">
                <KeplrMark />
                Change Authorization Wallet
              </button>
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
          {details !== null ? (
            <div style={menuStyles.section} data-testid="profile-menu-passwords">
              <p style={menuStyles.sectionLabel}>Password</p>
              <button
                type="button"
                style={styles.secondary}
                onClick={() => {
                  setCurrentPassword("");
                  setNewPassword("");
                  go({ kind: "password" });
                }}
                data-testid="profile-menu-password"
              >
                Change password
              </button>
              <button
                type="button"
                style={styles.secondary}
                onClick={() => {
                  setCurrentPassword("");
                  setNewPassword("");
                  go({ kind: "forgot" });
                }}
                data-testid="profile-menu-forgot"
              >
                Forgot current password?
              </button>
              <p style={menuStyles.facts} data-testid="profile-menu-password-note">
                Change it if you know your current password. If you don't, your Authorization Wallet approves a new one in Keplr -- you stay signed in.
              </p>
            </div>
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
        </div>
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
            Current password
          </label>
          <input
            id="profile-current-secret"
            name="current-password"
            type="password"
            autoComplete="current-password"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            style={styles.input}
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
            data-testid="profile-current-secret"
          />
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
          <p style={styles.label} data-testid="profile-password-forgot-note">
            Don't know your current password?{" "}
            <button
              type="button"
              style={menuStyles.linkButton}
              onClick={() => {
                setCurrentPassword("");
                setNewPassword("");
                go({ kind: "forgot" });
              }}
              data-testid="profile-password-to-forgot"
            >
              Reset it with your Authorization Wallet
            </button>
          </p>
        </form>
      ) : null}
      {view.kind === "forgot" && details !== null ? (
        <form
          method="post"
          style={styles.form}
          onSubmit={(event) => {
            event.preventDefault();
            if (!busy) void resetForgotten();
          }}
          data-testid="profile-forgot-form"
        >
          <p style={styles.subheading}>Reset a forgotten password</p>
          <p style={styles.text} data-testid="profile-forgot-explain">
            You don't need your current password. Your Authorization Wallet ({shortWallet(details.authorizationWallet.address)}) approves the new one in Keplr -- a message, not a
            transaction; nothing moves. You stay signed in here; every other device signed in to this account is signed out. Your games, seats and deposits don't change.
          </p>
          <label style={styles.label} htmlFor="profile-forgot-new">
            New password (at least {PASSWORD_MIN_LENGTH} characters)
          </label>
          <input
            id="profile-forgot-new"
            name="new-password"
            type="password"
            autoComplete="new-password"
            style={styles.input}
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
            data-testid="profile-forgot-new"
          />
          <div style={styles.row}>
            <button type="submit" style={disabledLook(styles.primary, busy)} disabled={busy} data-testid="profile-forgot-save">
              <KeplrMark />
              {busy ? "Approve in Keplr…" : "Approve in Keplr and set password"}
            </button>
            {back}
          </div>
        </form>
      ) : null}
      {view.kind === "forgot-done" ? (
        <>
          <p style={styles.text} role="status" data-testid="profile-forgot-done">
            New password set. {view.signedOut === 0 ? "No other devices were signed in." : `Signed out ${devices(view.signedOut)}.`} This device stays signed in.
          </p>
          <div style={styles.row}>{back}</div>
        </>
      ) : null}
      {view.kind === "password-done" ? (
        <>
          <p style={styles.text} role="status" data-testid="profile-password-done">
            Password changed. {view.signedOut === 0 ? "No other devices were signed in." : `Signed out ${devices(view.signedOut)}.`} This device stays signed in.
          </p>
          <div style={styles.row}>{back}</div>
        </>
      ) : null}
      {replace !== null && details !== null ? (
        <div data-testid="profile-replace-wallet">
          <p style={styles.subheading}>Change Authorization Wallet</p>
          {replace.step === "new" ? (
            <>
              <p style={styles.text} data-testid="profile-replace-step-new">
                1. In Keplr, switch to the wallet you want as your new Authorization Wallet, then press the button. It signs once to accept (free: not a transaction). Your current one, {shortWallet(details.authorizationWallet.address)}, approves next.
              </p>
              <div style={styles.row}>
                <button type="button" style={disabledLook(styles.primary, busy)} disabled={busy} onClick={() => void acceptNewWallet()} data-testid="profile-replace-use-new">
                  <KeplrMark />
                  {busy ? "Waiting for Keplr…" : "Use the wallet Keplr is on now"}
                </button>
                {back}
              </div>
            </>
          ) : null}
          {replace.step === "approve" ? (
            <>
              <p style={styles.text} data-testid="profile-replace-step-approve">
                2. The new wallet, {shortWallet(replace.next)}, accepted. Now switch Keplr back to your current Authorization Wallet, {shortWallet(details.authorizationWallet.address)}, and approve the change.
              </p>
              <div style={styles.row}>
                <button type="button" style={disabledLook(styles.primary, busy)} disabled={busy} onClick={() => void approveWithCurrent(replace)} data-testid="profile-replace-approve">
                  <KeplrMark />
                  {busy ? "Waiting for Keplr…" : "Approve with the current wallet"}
                </button>
                {back}
              </div>
            </>
          ) : null}
          {replace.step === "done" ? (
            <>
              <p style={styles.text} role="status" data-testid="profile-replace-done">
                Your Authorization Wallet is now {shortWallet(replace.wallet)}. The old one can no longer recover this account. Your tables, seats and game wallets haven't changed.
              </p>
              <div style={styles.row}>{back}</div>
            </>
          ) : null}
        </div>
      ) : null}
      {view.kind === "reauth" ? (
        /* ESCROW-4: the shared "Confirm it's you" (the password); the action the player chose runs once it is granted. */
        <ConfirmItsYou
          purpose={reauthPurpose[view.then]}
          port={port}
          busy={busy}
          onBusyChange={setBusy}
          onConfirmed={() => {
            if (view.then === "replace") {
              setView({ kind: "replace", state: { step: "new", candidate: null } });
              return undefined;
            }
            return signOutOthers();
          }}
          onCancel={() => {
            setNewPassword("");
            setCurrentPassword("");
            go({ kind: "menu" });
          }}
        />
      ) : null}
      {view.kind === "signout-confirm" ? (
        <>
          <p style={styles.text}>Sign out this device? Your account, games, seats and deposits are kept. To come back on this browser, log in again.</p>
          {signingKeys > 0 ? (
            <>
              {/* PHASE 4: plain words. These are key RECORDS this browser stored (it can't tell from them whether any table
                  is still funded), so they are never called funded seats. */}
              <p style={styles.notice} data-testid="profile-signout-keys">
                This browser also stores {signingKeys === 1 ? "a game signing key" : `${signingKeys} game signing keys`} it made when you anted. They let this browser approve game
                results. Removing them is safe: your seat's wallet can approve a new key on any device, in Keplr, when one is needed.
              </p>
              <label style={styles.check}>
                <input type="checkbox" checked={removeKeys} onChange={(event) => setRemoveKeys(event.target.checked)} data-testid="profile-signout-remove-keys" />
                Also remove this browser's game signing keys (recommended on a shared computer)
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

  /* A click anywhere outside the chip and its panel closes it. */
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

const menuStyles: Record<"anchor" | "chip" | "create" | "panel" | "list" | "footer" | "facts" | "section" | "sectionLabel" | "linkButton", React.CSSProperties> = {
  /* PHASE 4: an inline text button ("Reset it with your Authorization Wallet"). */
  linkButton: { background: "none", border: "none", padding: 0, font: "inherit", color: SANDBOX_TEXT, textDecoration: "underline", cursor: "pointer" },
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
};
