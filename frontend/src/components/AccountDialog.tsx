// frontend/src/components/AccountDialog.tsx
//
// ==================================================================
//  LOG IN / CREATE ACCOUNT / FORGOT PASSWORD -- ONE DIALOG, OPENED WHERE AN ACCOUNT IS NEEDED
// ==================================================================
//
// The app is public (the homepage, the public tables, the rules, Watch); this dialog opens when a visitor presses
// something that needs an account (`utils/accountPrompt.ts` `requireAccount`) or one of the homepage's own Log in /
// Create account buttons.
//
// THE MODEL (PHASE 3 FINAL, owner ruling 2026-10-06): THE PROFILE / ACCOUNT IS THE PLAYER. An account is a username, a
// password and ONE designated AUTHORIZATION WALLET.
//   Log in           username + password -> the same account on this browser, every table and seat with it. Keplr is
//                    never asked for: signing in is not a wallet action.
//   Create account   username + password + the name other players see + the Authorization Wallet: Keplr connects, the
//                    page shows which wallet will be designated, and that wallet signs the CREATE text the server minted
//                    for this browser and this username (ADR-036: no transaction, no funds, no spending permission).
//                    The account is created with its Authorization Wallet in ONE step -- none exists without one.
//   Forgot password? the username + the account's Authorization Wallet (Keplr signs a RECOVER text) + a new password ->
//                    signed in on this browser, every other device signed out. No recovery key, no email.
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
// THE WALLET KEPLR IS ON IS NOT THE ACCOUNT. It is read only to say which wallet will sign (and re-read before every
// signature); it never signs anyone in, never names an account and is never stored here.
//
// CREDENTIALS: the fields live in this component's state for as long as the dialog is up and no longer; the password
// is cleared the moment it is sent, whatever the answer. The form is `method="post"` with no action, so even a submit
// that escaped the handler could never put a credential in a URL. Nothing is logged or stored.

import React, { useEffect, useRef, useState } from "react";

import { NativeModal } from "./NativeModal";
import { KeplrMark, KeplrWordmark } from "./money/KeplrMark";
import { disabledLook, profileStyles as styles } from "./profileStyles";
import {
  PASSWORD_MIN_LENGTH,
  PROFILE_NAME_MAX,
  USERNAME_MAX,
  createAccount,
  logIn,
  mintAuthorization,
  profileErrorSentence,
  recoverAccount,
  usernameProblem,
  type ProfileFailure,
} from "../utils/profileApi";
import { keplrAccountNow, shortWallet, signAuthorization } from "../utils/authorizationWalletFlow";
import { accountDialogClosed, accountSignedIn, closeAccountDialog, registerAccountPromptHost, setAccountMode, useAccountPrompt, type AccountMode } from "../utils/accountPrompt";
import { renewRoomLinks } from "../utils/roomLink";
import { sessionPort, type SessionPort } from "../utils/sessionBootstrap";
import { SANDBOX_TEXT, SANDBOX_TITLE } from "../styles/palette";
import { APP_NAME } from "../config";

/** The question asked instead of resuming: who this browser is signed in as (null: not known yet). */
type Pending = { readonly kind: "already"; readonly name: string | null } | { readonly kind: "unconfirmed" };

/** PHASE 3 FINAL §4: what the Authorization Wallet is, said plainly at account creation (owner's substance; the site is
 *  named by the app's own name, as everywhere else on it). */
export const AUTHORIZATION_WALLET_EXPLAINED = [
  `This wallet proves ownership of your account and lets you recover it if you forget your password. It does not need to be your main wallet. ${APP_NAME} never controls it and cannot access its funds — the private key and seed phrase never leave Keplr.`,
  "You may prefer a dedicated Keplr wallet just for account authorization, and other wallets for your games. Signing is free: it is not a transaction and moves nothing.",
] as const;

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
  const [forgot, setForgot] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  /* "Forgot password?": the new password. Cleared the moment it is sent. */
  const [newPassword, setNewPassword] = useState("");
  /* The wallet Keplr is on, as last read (transient signer state: re-read before every signature, never an identity). */
  const [keplr, setKeplr] = useState<string | null>(null);
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
  }, [mode, forgot, pending]);
  useEffect(() => {
    if (pending !== null) continueRef.current?.focus();
  }, [pending]);

  const switchTo = (next: AccountMode) => {
    setError(null);
    setPassword("");
    setNewPassword("");
    setForgot(false);
    onModeChange(next);
  };

  /** Signed in: resume, but only on a session this page has confirmed ("ready"). This browser ALREADY signed in
   *  (another tab got there first, perhaps as another account): ask first, naming it -- never resume on its own. */
  const finish = (result: { ok: true } | ProfileFailure, context: "login" | "account" | "recover"): void => {
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
    if (busy !== null) return;
    setError(null);
    setBusy("checking");
    try {
      const now = await port.ensure(true);
      /* Closed while checking: the player dropped the action -- nothing resumes (re-review NIT). */
      if (!live.current) return;
      if (now === "ready") {
        /* Re-review N2: never resumed as an account the player hasn't been shown -- name it first, then Continue. */
        const named = port.account?.name ?? null;
        if (pending !== null && (pending.kind !== "already" || pending.name !== named) && named !== null) {
          setPending({ kind: "already", name: named });
          return;
        }
        onSignedIn();
        return;
      }
      setError(now === "unprofiled" ? "This browser isn't signed in after all. Log in again." : "This page can't reach the game server just now. Try again in a moment.");
      if (now === "unprofiled") setPending(null);
    } finally {
      setBusy(null);
    }
  };

  /** "Connect Keplr" (an explicit press): read the wallet Keplr is on, to show which one will sign. */
  const connectKeplr = async () => {
    if (busy !== null) return;
    setError(null);
    setBusy("connecting");
    try {
      const now = await keplrAccountNow(true);
      if (!live.current) return;
      if (now.ok) setKeplr(now.address);
      else setError(now.reason);
    } finally {
      setBusy(null);
    }
  };

  /** The wallet Keplr is on NOW, which must be the one this page showed (else it is shown, and nothing is signed). */
  const signerNow = async (): Promise<string | null> => {
    const now = await keplrAccountNow(keplr === null);
    if (!now.ok) {
      setError(now.reason);
      return null;
    }
    if (keplr !== now.address) {
      setKeplr(now.address);
      setError(`Keplr is now on ${shortWallet(now.address)}. Check that's the wallet you mean, then press the button again.`);
      return null;
    }
    return now.address;
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy !== null) return;
    setError(null);
    try {
      if (forgot) {
        /* Review NIT 8: a too-short password is said before anything is cleared or signed. */
        if (Array.from(newPassword).length < PASSWORD_MIN_LENGTH) {
          setError(profileErrorSentence({ ok: false, error: "bad-password", problem: "too-short" }));
          return;
        }
        if (usernameProblem(username) !== null) {
          setError("Enter the account's username.");
          return;
        }
        setBusy("keplr");
        const wallet = await signerNow();
        if (wallet === null) return;
        const minted = await mintAuthorization({ purpose: "recover", username, wallet }, port);
        if (!minted.ok) return finish(minted, "recover");
        const signed = await signAuthorization(minted.minted.texts[0].text, { purpose: "RECOVER", account: username, signer: wallet, authorizationWallet: wallet });
        if (!signed.ok) {
          setError(signed.reason);
          return;
        }
        setBusy("recovering");
        const chosen = newPassword;
        setNewPassword("");
        finish(await recoverAccount({ operation: minted.minted.operation, signed: signed.signed, newPassword: chosen }, port), "recover");
        return;
      }
      if (mode === "login") {
        setBusy("login");
        const typed = password;
        setPassword("");
        finish(await logIn({ username, password: typed }, port), "login");
        return;
      }
      /* CREATE: everything the player typed is checked first (no signature is asked for a form that can't succeed). */
      const problem = usernameProblem(username);
      if (problem !== null) return setError(profileErrorSentence(problem, "account"));
      if (Array.from(password).length < PASSWORD_MIN_LENGTH) return setError(profileErrorSentence({ ok: false, error: "bad-password", problem: "too-short" }));
      if (name.trim() === "" || name.trim().length > PROFILE_NAME_MAX) return setError(profileErrorSentence({ ok: false, error: "bad-name" }));
      if (keplr === null) return setError("Connect Keplr first: the account needs its Authorization Wallet.");
      setBusy("keplr");
      const wallet = await signerNow();
      if (wallet === null) return;
      const minted = await mintAuthorization({ purpose: "create", username, wallet }, port);
      if (!minted.ok) return finish(minted, "account");
      const signed = await signAuthorization(minted.minted.texts[0].text, { purpose: "CREATE", account: username, signer: wallet, authorizationWallet: wallet });
      if (!signed.ok) {
        setError(signed.reason);
        return;
      }
      setBusy("creating");
      const typed = password;
      setPassword("");
      finish(await createAccount({ username, password: typed, name, operation: minted.minted.operation, signed: signed.signed }, port), "account");
    } finally {
      if (live.current) setBusy(null);
    }
  };

  const title = pending !== null ? "Already signed in" : forgot ? "Forgot password" : mode === "login" ? "Log in" : "Create account";
  const pendingName = pending?.kind === "already" ? pending.name : pending?.kind === "unconfirmed" ? (port.account?.name ?? null) : null;
  const working = busy !== null;
  /* A create or recovery on its way cannot be closed (its answer signs this browser in). */
  const locked = busy === "creating" || busy === "recovering";
  const submitLabel =
    busy === "keplr"
      ? "Waiting for Keplr…"
      : busy === "creating"
        ? "Creating…"
        : busy === "recovering"
          ? "Recovering…"
          : busy === "login"
            ? "Logging in…"
            : forgot
              ? "Sign with Keplr and set the new password"
              : mode === "login"
                ? "Log in"
                : "Sign with Keplr and create account";

  /** The Authorization Wallet step (create) / the account's wallet (forgot): connect, and which wallet will sign. */
  const walletStep = (purpose: "create" | "recover") => (
    <div style={dialogStyles.wallet} data-testid={purpose === "create" ? "account-wallet-step" : "account-forgot-wallet-step"}>
      <p style={styles.subheading}>
        <KeplrWordmark size={18} />
        {purpose === "create" ? "Authorization Wallet" : "Your account's Authorization Wallet"}
      </p>
      {purpose === "create" ? (
        AUTHORIZATION_WALLET_EXPLAINED.map((line, at) => (
          <p key={at} style={dialogStyles.explain} data-testid={at === 0 ? "account-wallet-explain" : "account-wallet-explain-more"}>
            {line}
          </p>
        ))
      ) : (
        <p style={dialogStyles.explain} data-testid="account-forgot-explain">
          Switch Keplr to the Authorization Wallet you chose when you created the account — a wallet you only used for games can't recover it. Every other device signed in to the account is signed out; your seats, tables and game wallets don't change.
        </p>
      )}
      <div style={styles.row}>
        <button type="button" style={disabledLook(styles.secondary, working)} disabled={working} onClick={() => void connectKeplr()} data-testid={purpose === "create" ? "account-wallet-connect" : "account-forgot-connect"}>
          <KeplrMark />
          {busy === "connecting" ? "Connecting Keplr…" : keplr === null ? "Connect Keplr" : "Use the wallet Keplr is on now"}
        </button>
      </div>
      {keplr !== null ? (
        <p style={dialogStyles.chosen} data-testid={purpose === "create" ? "account-wallet-address" : "account-forgot-address"}>
          {purpose === "create" ? "Will be designated: " : "Keplr is on: "}
          <span style={dialogStyles.address} title={keplr}>
            {shortWallet(keplr)}
          </span>
        </p>
      ) : null}
    </div>
  );

  return (
    <NativeModal name={title} dismissible={!locked} onDismiss={locked ? () => undefined : onClose} onScrimClick={working ? undefined : onClose} restoreOpener scrimStyle={dialogStyles.scrim} testId="account-dialog">
      <div style={dialogStyles.card} onClick={(event) => event.stopPropagation()}>
        <div style={dialogStyles.header}>
          <h2 style={styles.heading}>{title}</h2>
          {/* Review M3: always closable (Escape too) -- closing drops the action that asked; a sign-in still on its way
              finishes on its own, bounded by the port's timeout. A create or recovery already sent stays open. */}
          <button type="button" style={disabledLook(dialogStyles.close, locked)} disabled={locked} onClick={onClose} aria-label="Close">
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
              <button ref={continueRef} type="button" style={disabledLook(styles.primary, working)} disabled={working} onClick={() => void proceed()} data-testid="account-continue">
                {busy === "checking" ? "Checking…" : pendingName !== null ? `Continue as ${pendingName}` : "Continue"}
              </button>
              <button type="button" style={disabledLook(styles.secondary, working)} disabled={working} onClick={onClose} data-testid="account-pending-close">
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
        {pending === null && !forgot ? (
          <div role="group" aria-label="Log in or create an account" style={styles.choices}>
            {(
              [
                ["login", "Log in"],
                ["create", "Create account"],
              ] as const
            ).map(([value, label]) => (
              <button key={value} type="button" aria-pressed={mode === value} style={mode === value ? styles.tabSelected : styles.tab} onClick={() => switchTo(value)} disabled={working} data-testid={`account-tab-${value}`}>
                {label}
              </button>
            ))}
          </div>
        ) : null}
        {pending === null ? (
          <form method="post" style={styles.form} onSubmit={(event) => void submit(event)} data-testid="account-form">
            <label style={styles.label} htmlFor={forgot ? "account-forgot-username" : "account-username"}>
              Username
            </label>
            <input
              id={forgot ? "account-forgot-username" : "account-username"}
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
              data-testid={forgot ? "account-forgot-username" : "account-username"}
            />
            {forgot ? (
              <>
                {walletStep("recover")}
                <label style={styles.label} htmlFor="account-forgot-password">
                  New password (at least {PASSWORD_MIN_LENGTH} characters)
                </label>
                <input
                  id="account-forgot-password"
                  name="new-password"
                  type="password"
                  autoComplete="new-password"
                  style={styles.input}
                  value={newPassword}
                  onChange={(event) => setNewPassword(event.target.value)}
                  data-testid="account-forgot-password"
                />
                <div style={styles.row}>
                  <button type="submit" style={disabledLook(styles.primary, working)} disabled={working} data-testid="account-forgot-submit">
                    {submitLabel}
                  </button>
                  <button type="button" style={disabledLook(styles.secondary, working)} disabled={working} onClick={() => switchTo("login")}>
                    Back
                  </button>
                </div>
                <p style={styles.label} data-testid="account-forgot-nowallet">
                  There is no email reset and no recovery key: without your password and your Authorization Wallet, the account can't be recovered.
                </p>
              </>
            ) : (
              <>
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
                    {walletStep("create")}
                  </>
                ) : null}
                <button type="submit" style={disabledLook(styles.primary, working)} disabled={working} data-testid="account-submit">
                  {submitLabel}
                </button>
                {mode === "login" ? (
                  <button
                    type="button"
                    style={disabledLook(dialogStyles.link, working)}
                    disabled={working}
                    onClick={() => {
                      setError(null);
                      setPassword("");
                      setForgot(true);
                    }}
                    data-testid="account-forgot"
                  >
                    Forgot password?
                  </button>
                ) : null}
              </>
            )}
            {error ? (
              <p role="alert" style={styles.error} data-testid="account-error">
                {error}
              </p>
            ) : null}
          </form>
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

const dialogStyles: Record<"scrim" | "card" | "header" | "close" | "link" | "wallet" | "explain" | "chosen" | "address", React.CSSProperties> = {
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
  /* "Forgot password?": a quiet text button under Log in. */
  link: { alignSelf: "flex-start", background: "none", border: "none", padding: "2px 0", color: SANDBOX_TEXT, textDecoration: "underline", cursor: "pointer", fontSize: "13px", fontFamily: "inherit" },
  /* The Authorization Wallet step: a quiet inset, not a warning. */
  wallet: { margin: "6px 0 4px", padding: "12px 12px 2px", borderRadius: "8px", border: `1px solid rgba(255, 255, 255, 0.12)` },
  explain: { margin: "0 0 8px", fontSize: "13px", lineHeight: 1.5, color: SANDBOX_TEXT },
  chosen: { margin: "0 0 10px", fontSize: "13px", color: SANDBOX_TITLE },
  address: { fontFamily: "monospace" },
};
