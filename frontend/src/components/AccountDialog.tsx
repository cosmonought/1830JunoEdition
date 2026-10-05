// frontend/src/components/AccountDialog.tsx
//
// ==================================================================
//  PHASE 3 (P3-ACCT): LOG IN / CREATE ACCOUNT -- ONE DIALOG, OPENED WHERE AN ACCOUNT IS NEEDED
// ==================================================================
//
// Replaces LIVE-2E's `ProfileGate`, which held the whole app behind "a profile is required to play". The app is public
// now (the homepage, the public tables, the rules, Watch); this dialog opens when a visitor presses something that needs
// an account (`utils/accountPrompt.ts` `requireAccount`) or one of the homepage's own Log in / Create account buttons.
//
//   Log in           username + password -> the same account on this browser, every table and seat with it.
//   Create account   username + password + the name other players see. Nothing else: no recovery key is made or
//                    shown, and nothing has to be written down.
//   Other ways in    (collapsed) the two LIVE-2E ways for a profile made before accounts: its recovery key, or a code
//                    from a device that is still signed in. Kept so no older profile is orphaned; it can set a
//                    username and password from its profile menu.
//
// A sign-in REPLACES this browser's session (session fixation: whatever cookie it had, it now has a fresh one). The
// API call re-bootstraps the port before it resolves, so by the time `accountSignedIn` runs the port is "ready"; it then
// renews the page's sockets and resumes the action that asked.
//
// NEVER RESUMED AS SOMEONE ELSE (independent review M1, L2). Two cases stop at a question instead of resuming:
//   * the server answers that this browser is ALREADY signed in (another tab signed in meanwhile -- possibly as a
//     different account than the one just typed): the dialog says who it is signed in as and asks "Continue as …?";
//     nothing runs until the player says so;
//   * the sign-in was accepted but this page could not reach the server afterwards: the action does not run on a
//     session the page cannot confirm; the dialog says so and "Continue" re-checks first.
//
// CREDENTIALS: the fields live in this component's state for as long as the dialog is up and no longer; the password
// is cleared the moment it is sent, whatever the answer. The form is `method="post"` with no action, so even a submit
// that escaped the handler could never put a credential in a URL. Nothing is logged or stored (the browser's own
// password manager may offer to save it -- that is the player's choice, and why the fields say `autocomplete`).

import React, { useEffect, useRef, useState } from "react";

import { NativeModal } from "./NativeModal";
import { disabledLook, profileStyles as styles } from "./profileStyles";
import {
  PASSWORD_MIN_LENGTH,
  PROFILE_NAME_MAX,
  USERNAME_MAX,
  createAccount,
  linkProfile,
  logIn,
  profileErrorSentence,
  recoverProfile,
  type ProfileFailure,
} from "../utils/profileApi";
import { accountDialogClosed, accountSignedIn, closeAccountDialog, registerAccountPromptHost, setAccountMode, useAccountPrompt, type AccountMode } from "../utils/accountPrompt";
import { renewRoomLinks } from "../utils/roomLink";
import { sessionPort, type SessionPort } from "../utils/sessionBootstrap";
import { SANDBOX_TEXT } from "../styles/palette";

type Other = "none" | "recovery-key" | "link-code";

/** Review L9: where the code comes from, in the profile menu's own words (it lives under "Older sign-in options"). */
export const LINK_CODE_HOW = "On a device that is still signed in, open your name → “Older sign-in options” → “Link another device”, and enter the code it shows.";

/** The question asked instead of resuming: who this browser is signed in as (null: not known yet). */
type Pending = { readonly kind: "already"; readonly name: string | null } | { readonly kind: "unconfirmed" };

export interface AccountDialogProps {
  mode: AccountMode;
  reason: string | null;
  port?: SessionPort;
  onModeChange: (mode: AccountMode) => void;
  /** Signed in (the port is "ready"). */
  onSignedIn: () => void;
  onClose: () => void;
}

export function AccountDialog({ mode, reason, port = sessionPort(), onModeChange, onSignedIn, onClose }: AccountDialogProps): JSX.Element {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [other, setOther] = useState<Other>("none");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const first = useRef<HTMLInputElement | null>(null);
  const continueRef = useRef<HTMLButtonElement | null>(null);
  /* Closed while a sign-in was on its way: its answer still moves this page's sockets to the new session, but resumes
     nothing (the player closed the dialog -- that dropped the action). */
  const live = useRef(true);
  useEffect(
    () => () => {
      live.current = false;
    },
    [],
  );

  useEffect(() => {
    if (pending === null) first.current?.focus();
  }, [mode, other, pending]);
  useEffect(() => {
    if (pending !== null) continueRef.current?.focus();
  }, [pending]);

  const switchTo = (next: AccountMode) => {
    setError(null);
    setPassword("");
    setOther("none");
    setSecret("");
    onModeChange(next);
  };

  /** Signed in: resume, but only on a session this page has confirmed ("ready"). This browser ALREADY signed in
   *  (another tab got there first, perhaps as another account): ask first, naming it -- never resume on its own. */
  const finish = (result: { ok: true } | ProfileFailure, context: "login" | "account" | "credential"): void => {
    if (!live.current) {
      if (result.ok) renewRoomLinks();
      return;
    }
    if (result.ok) {
      if (port.state === "ready") onSignedIn();
      else setPending({ kind: "unconfirmed" });
      return;
    }
    if (result.error === "already-profiled") {
      /* Re-review N2: another tab replaced this browser's session -- this page's sockets move to it now (whatever the
         player answers below), so nothing it reads next goes out on a socket the server is closing. */
      if (port.state === "ready") renewRoomLinks();
      setPending({ kind: "already", name: port.state === "ready" ? (port.account?.name ?? null) : null });
      return;
    }
    setError(profileErrorSentence(result, context));
  };

  /** "Continue": re-check the session, then resume (or say why not). */
  const proceed = async () => {
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      const now = await port.ensure(true);
      /* Closed while checking: the player dropped the action -- nothing resumes (re-review NIT). */
      if (!live.current) return;
      if (now === "ready") {
        /* Re-review N2: never resumed as an account the player hasn't been shown -- name it first, then Continue. */
        const name = port.account?.name ?? null;
        if (pending !== null && (pending.kind !== "already" || pending.name !== name) && name !== null) {
          setPending({ kind: "already", name });
          return;
        }
        onSignedIn();
        return;
      }
      setError(now === "unprofiled" ? "This browser isn't signed in after all. Log in again." : "This page can't reach the game server just now. Try again in a moment.");
      if (now === "unprofiled") setPending(null);
    } finally {
      setBusy(false);
    }
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      if (other !== "none") {
        const typed = secret;
        setSecret("");
        finish(other === "recovery-key" ? await recoverProfile(typed, port) : await linkProfile(typed, port), "credential");
        return;
      }
      const typed = password;
      setPassword("");
      if (mode === "login") finish(await logIn({ username, password: typed }, port), "login");
      else finish(await createAccount({ username, password: typed, name }, port), "account");
    } finally {
      setBusy(false);
    }
  };

  const title = pending !== null ? "Already signed in" : other !== "none" ? "Sign in another way" : mode === "login" ? "Log in" : "Create account";
  const pendingName = pending?.kind === "already" ? pending.name : pending?.kind === "unconfirmed" ? (port.account?.name ?? null) : null;

  return (
    <NativeModal name={title} dismissible onDismiss={onClose} onScrimClick={busy ? undefined : onClose} restoreOpener scrimStyle={dialogStyles.scrim} testId="account-dialog">
      <div style={dialogStyles.card} onClick={(event) => event.stopPropagation()}>
        <div style={dialogStyles.header}>
          <h2 style={styles.heading}>{title}</h2>
          {/* Review M3: always closable (Escape too) -- closing drops the action that asked; a sign-in still on its way
              finishes on its own, bounded by the port's timeout. */}
          <button type="button" style={dialogStyles.close} onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        {pending !== null ? (
          <div data-testid="account-pending">
            <p style={styles.lead} data-testid="account-pending-sentence">
              {pending.kind === "already"
                ? pendingName !== null
                  ? `This browser is already signed in as ${pendingName} (from another tab or window).`
                  : "This browser is already signed in (from another tab or window)."
                : "You're signed in, but this page couldn't confirm it with the game server yet."}
            </p>
            <div style={styles.row}>
              <button ref={continueRef} type="button" style={disabledLook(styles.primary, busy)} disabled={busy} onClick={() => void proceed()} data-testid="account-continue">
                {busy ? "Checking…" : pendingName !== null ? `Continue as ${pendingName}` : "Continue"}
              </button>
              <button type="button" style={disabledLook(styles.secondary, busy)} disabled={busy} onClick={onClose} data-testid="account-pending-close">
                Not now
              </button>
            </div>
            {error ? (
              <p role="alert" style={styles.error} data-testid="account-error">
                {error}
              </p>
            ) : null}
          </div>
        ) : null}
        {pending === null && reason !== null ? (
          <p style={styles.lead} data-testid="account-reason">
            {reason}
          </p>
        ) : null}
        {pending === null && other === "none" ? (
          <div role="group" aria-label="Log in or create an account" style={styles.choices}>
            {(
              [
                ["login", "Log in"],
                ["create", "Create account"],
              ] as const
            ).map(([value, label]) => (
              <button key={value} type="button" aria-pressed={mode === value} style={mode === value ? styles.tabSelected : styles.tab} onClick={() => switchTo(value)} disabled={busy} data-testid={`account-tab-${value}`}>
                {label}
              </button>
            ))}
          </div>
        ) : null}
        {pending === null ? (
          <form method="post" style={styles.form} onSubmit={(event) => void submit(event)} data-testid="account-form">
            {other === "none" ? (
              <>
                <label style={styles.label} htmlFor="account-username">
                  Username
                </label>
                <input
                  id="account-username"
                  ref={first}
                  name="username"
                  autoComplete="username"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  maxLength={USERNAME_MAX * 2}
                  style={styles.input}
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  data-testid="account-username"
                />
                <label style={styles.label} htmlFor="account-password">
                  Password{mode === "create" ? ` (at least ${PASSWORD_MIN_LENGTH} characters)` : ""}
                </label>
                <input
                  id="account-password"
                  name="password"
                  type="password"
                  autoComplete={mode === "login" ? "current-password" : "new-password"}
                  style={styles.input}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  data-testid="account-password"
                />
                {mode === "create" ? (
                  <>
                    <label style={styles.label} htmlFor="account-name">
                      Display name (what other players see; you can change it at each table)
                    </label>
                    <input id="account-name" name="nickname" autoComplete="nickname" maxLength={PROFILE_NAME_MAX} style={styles.input} value={name} onChange={(event) => setName(event.target.value)} data-testid="account-name" />
                  </>
                ) : null}
                <button type="submit" style={disabledLook(styles.primary, busy)} disabled={busy} data-testid="account-submit">
                  {busy ? (mode === "login" ? "Logging in…" : "Creating…") : mode === "login" ? "Log in" : "Create account"}
                </button>
              </>
            ) : (
              <>
                <label style={styles.label} htmlFor="account-secret">
                  {other === "recovery-key" ? "Paste the recovery key you saved when you created the profile." : LINK_CODE_HOW}
                </label>
                <input
                  id="account-secret"
                  ref={first}
                  type={other === "recovery-key" ? "password" : "text"}
                  autoComplete="off"
                  autoCapitalize={other === "link-code" ? "characters" : "off"}
                  autoCorrect="off"
                  spellCheck={false}
                  style={styles.monoInput}
                  value={secret}
                  onChange={(event) => setSecret(event.target.value)}
                  data-testid="account-secret"
                />
                <div style={styles.row}>
                  <button type="submit" style={disabledLook(styles.primary, busy)} disabled={busy} data-testid="account-secret-submit">
                    {busy ? "Signing in…" : other === "recovery-key" ? "Sign in with the recovery key" : "Link this device"}
                  </button>
                  <button type="button" style={disabledLook(styles.secondary, busy)} disabled={busy} onClick={() => switchTo(mode)}>
                    Back
                  </button>
                </div>
              </>
            )}
            {error ? (
              <p role="alert" style={styles.error} data-testid="account-error">
                {error}
              </p>
            ) : null}
          </form>
        ) : null}
        {pending === null && other === "none" ? (
          <details style={dialogStyles.other} data-testid="account-other-ways">
            <summary style={dialogStyles.summary}>Made a profile before accounts? Other ways to sign in</summary>
            <div style={{ ...styles.row, marginTop: "8px" }}>
              <button type="button" style={styles.secondary} onClick={() => setOther("recovery-key")} disabled={busy} data-testid="account-other-recovery">
                Recovery key
              </button>
              <button type="button" style={styles.secondary} onClick={() => setOther("link-code")} disabled={busy} data-testid="account-other-link">
                Code from a signed-in device
              </button>
            </div>
          </details>
        ) : null}
      </div>
    </NativeModal>
  );
}

/** The one mounted dialog, driven by `utils/accountPrompt.ts`. */
export function AccountPromptHost({ port }: { port?: SessionPort }): JSX.Element | null {
  const prompt = useAccountPrompt();
  useEffect(() => registerAccountPromptHost(), []);
  /* Re-review L8: after the commit that removed the dialog (its own focus restore done), the resume runs. */
  useEffect(() => {
    if (!prompt.open) accountDialogClosed();
  }, [prompt.open]);
  if (!prompt.open) return null;
  return <AccountDialog mode={prompt.mode} reason={prompt.reason} port={port} onModeChange={setAccountMode} onSignedIn={() => accountSignedIn()} onClose={closeAccountDialog} />;
}

export default AccountDialog;

const dialogStyles: Record<"scrim" | "card" | "header" | "close" | "other" | "summary", React.CSSProperties> = {
  scrim: {
    position: "fixed",
    inset: 0,
    pointerEvents: "auto",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "16px",
    boxSizing: "border-box",
    backgroundColor: "rgba(0, 0, 0, 0.6)",
    overflowY: "auto",
  },
  card: { ...styles.card, maxHeight: "calc(100vh - 32px)", overflowY: "auto" },
  header: { display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "12px" },
  close: { ...styles.secondary, padding: "2px 10px", lineHeight: 1.2 },
  other: { marginTop: "16px", fontSize: "13px", color: SANDBOX_TEXT },
  summary: { cursor: "pointer" },
};
