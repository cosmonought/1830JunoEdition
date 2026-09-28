// frontend/src/components/ProfileGate.tsx
//
// ==================================================================
//  LIVE-2E: A PROFILE IS REQUIRED TO PLAY
// ==================================================================
//
// OWNER-AUTHORIZED: there is no anonymous play. The gate sits AROUND the app (`index.tsx`) and renders it only when
// the session port says "ready" -- a PROFILED session. Before the first bootstrap answers it says "Connecting to the
// game server…" (with Retry once a bootstrap has failed); for an unprofiled browser it is the mandatory choice:
//
//   Create profile             a name -> the recovery key, shown ONCE (`RecoveryKeyReveal`), then the lobby
//   Recover existing profile   paste the recovery key
//   Link existing profile      the code a signed-in device shows under Profile -> "Link another device"
//
// A CREATE THAT ANSWERS 409 already-profiled is a retry after a lost response (or another tab got there first): the
// profile exists and its key never arrived here, so the gate re-bootstraps, lets the player through, and says so once
// -- offering "Make a new recovery key" (rotate, then the reveal). ESCROW-3A (owner review): that rotation is allowed
// without the key only because this gate sent a CREATION RECEIPT with its create (random, in this component's memory
// alone, the same one on every retry) and presents it again: the server's one-time rescue for the session that
// created the profile, before its page acknowledged the key. Another tab's gate, a reload, or a restarted server has
// no open rescue, and the notice then says what to do instead.
//
// WHILE AN ACTION IS IN FLIGHT THE GATE HOLDS ITS SCREEN. The action re-bootstraps before it resolves, so the port can
// turn "ready" a moment before the recovery key is in hand; holding keeps the app (and its sockets) from mounting
// under the reveal. The key and the typed credentials live in component state for as long as their screen shows and
// no longer -- never in storage, a URL or the console.
//
// "ended" is `SessionEndedNotice`'s. An app that was already running stays mounted behind that notice; a page that
// loads into "ended" shows nothing else until the player chooses.

import React, { useCallback, useEffect, useRef, useState } from "react";

import { sessionPort, type SessionPort } from "../utils/sessionBootstrap";
import { useSession } from "../utils/useSession";
import {
  PROFILE_NAME_MAX,
  createProfile,
  linkProfile,
  mintCreationReceipt,
  profileErrorSentence,
  recoverProfile,
  rotateRecoveryKey,
} from "../utils/profileApi";
import { RecoveryKeyReveal } from "./RecoveryKeyReveal";
import { disabledLook, profileStyles as styles } from "./profileStyles";

type Choice = "create" | "recover" | "link";

const CHOICES: ReadonlyArray<[Choice, string]> = [
  ["create", "Create profile"],
  ["recover", "Recover existing profile"],
  ["link", "Link existing profile"],
];

/** The three ways in. Each handler resolves the sentence to show, or `null` when the gate moves on. */
function ProfileChoice({
  busy,
  onCreate,
  onRecover,
  onLink,
}: {
  busy: boolean;
  onCreate: (name: string) => Promise<string | null>;
  onRecover: (key: string) => Promise<string | null>;
  onLink: (code: string) => Promise<string | null>;
}): JSX.Element {
  const [choice, setChoice] = useState<Choice>("create");
  const [name, setName] = useState("");
  const [recoveryKey, setRecoveryKey] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);

  const pick = (next: Choice) => {
    setChoice(next);
    setError(null);
    /* A credential typed on one screen is not carried to another. */
    setRecoveryKey("");
    setCode("");
  };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setError(null);
    if (choice === "create") {
      setError(await onCreate(name));
      return;
    }
    if (choice === "recover") {
      const said = await onRecover(recoveryKey);
      if (said === null) setRecoveryKey("");
      setError(said);
      return;
    }
    const said = await onLink(code);
    if (said === null) setCode("");
    setError(said);
  };

  return (
    <div data-testid="profile-gate">
      <h1 style={styles.heading}>A profile is required to play</h1>
      <p style={styles.lead}>
        Every seat at a table belongs to a profile. Create one, or sign this browser in to the profile you already have.
      </p>
      <div role="tablist" aria-label="How to sign in" style={styles.choices}>
        {CHOICES.map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={choice === value}
            style={choice === value ? styles.tabSelected : styles.tab}
            onClick={() => pick(value)}
            data-testid={`profile-choice-${value}`}
          >
            {label}
          </button>
        ))}
      </div>
      <form style={styles.form} onSubmit={(event) => void submit(event)} autoComplete="off">
        {choice === "create" ? (
          <>
            <label style={styles.label} htmlFor="profile-name">
              Profile name (the name other players see; you can change it at each table)
            </label>
            <input
              id="profile-name"
              autoComplete="nickname"
              style={styles.input}
              value={name}
              maxLength={PROFILE_NAME_MAX}
              onChange={(event) => setName(event.target.value)}
              data-testid="profile-name"
            />
            <button type="submit" style={disabledLook(styles.primary, busy)} disabled={busy} data-testid="profile-create">
              {busy ? "Creating…" : "Create profile"}
            </button>
          </>
        ) : choice === "recover" ? (
          <>
            <label style={styles.label} htmlFor="profile-recovery-key">
              Paste the recovery key you saved when you created the profile.
            </label>
            <input
              id="profile-recovery-key"
              autoComplete="off"
              style={styles.monoInput}
              value={recoveryKey}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              onChange={(event) => setRecoveryKey(event.target.value)}
              data-testid="profile-recovery-key"
            />
            <button type="submit" style={disabledLook(styles.primary, busy)} disabled={busy} data-testid="profile-recover">
              {busy ? "Signing in…" : "Recover profile"}
            </button>
          </>
        ) : (
          <>
            <label style={styles.label} htmlFor="profile-link-code">
              On a device that is already signed in, open Profile → “Link another device” and enter the code it shows.
            </label>
            <input
              id="profile-link-code"
              autoComplete="off"
              style={styles.monoInput}
              value={code}
              placeholder="XXXX-XXXX-XXXX-XXXX-XXXX"
              spellCheck={false}
              autoCapitalize="characters"
              autoCorrect="off"
              onChange={(event) => setCode(event.target.value)}
              data-testid="profile-link-code"
            />
            <button type="submit" style={disabledLook(styles.primary, busy)} disabled={busy} data-testid="profile-link">
              {busy ? "Linking…" : "Link this device"}
            </button>
          </>
        )}
        {error ? (
          <p role="alert" style={styles.error}>
            {error}
          </p>
        ) : null}
      </form>
    </div>
  );
}

/** ESCROW-3A: the missed-key notice when the server has no rescue for this page (another tab created the profile, the
 *  page was reloaded, the server restarted, or ten minutes passed): nothing here can replace the key without it. */
export const MISSED_KEY_NO_RESCUE =
  "This page can't replace the key without the current one. If another tab of this browser created the profile, its key was shown there. Otherwise keep this browser signed in and link a second device (your name → “Link another device”), so losing one browser cannot lose the profile.";

/** A create that answered already-profiled: the player is through, but the key never reached this browser. */
function MissedKeyNotice({ name, onRotate, onContinue }: { name: string | null; onRotate: () => Promise<string | null>; onContinue: () => void }): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rotate = async () => {
    setBusy(true);
    setError(null);
    const said = await onRotate();
    setBusy(false);
    setError(said);
  };
  return (
    <div role="dialog" aria-labelledby="missed-key-title" data-testid="missed-key-notice">
      <h2 id="missed-key-title" style={styles.heading}>
        Your profile is ready
      </h2>
      <p style={styles.text}>
        This browser is signed in{name ? ` as ${name}` : ""}, but the profile's recovery key did not arrive here. Without
        it, losing this browser could lose the profile.
      </p>
      <p style={styles.text}>Make a new recovery key now. Any earlier key stops working.</p>
      <div style={styles.row}>
        <button type="button" style={disabledLook(styles.primary, busy)} disabled={busy} onClick={() => void rotate()} data-testid="missed-key-rotate">
          {busy ? "Making a key…" : "Make a new recovery key"}
        </button>
        <button type="button" style={disabledLook(styles.secondary, busy)} disabled={busy} onClick={onContinue}>
          Continue to the lobby
        </button>
      </div>
      {error ? (
        <p role="alert" style={styles.error}>
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function ProfileGate({ port = sessionPort(), children }: { port?: SessionPort; children?: React.ReactNode }): JSX.Element {
  const { state, account } = useSession(port);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [everReady, setEverReady] = useState(state === "ready");
  /* The recovery key, for exactly as long as its reveal is up. */
  const [reveal, setReveal] = useState<string | null>(null);
  const [missedKey, setMissedKey] = useState(false);
  /* ESCROW-3A: this page's creation receipt -- made at the first create, the same on every retry, memory only, and
     dropped once the key has reached this page. */
  const receipt = useRef<string | null>(null);

  const bootstrap = useCallback(
    (force = false) => {
      setFailed(false);
      void port.ensure(force).then((next) => {
        if (next === "unknown") setFailed(true);
      });
    },
    [port],
  );

  useEffect(() => {
    bootstrap();
  }, [bootstrap]);

  useEffect(() => {
    if (state === "ready") setEverReady(true);
  }, [state]);

  /* Another tab of this browser may have created or recovered the profile meanwhile (they share the cookie): look
     again when this one comes back into view. */
  useEffect(() => {
    if (state !== "unprofiled" || typeof document === "undefined") return undefined;
    const onVisible = () => {
      if (document.visibilityState === "visible" && !busy) void port.ensure(true);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [state, busy, port]);

  const onCreate = useCallback(
    async (name: string): Promise<string | null> => {
      setBusy(true);
      if (receipt.current === null) receipt.current = mintCreationReceipt();
      const result = await createProfile(name, port, receipt.current);
      setBusy(false);
      if (result.ok) {
        receipt.current = null; // the key is here (and acknowledged): the receipt has nothing left to do
        setReveal(result.recoveryKey);
        return null;
      }
      if (result.error === "already-profiled" && port.state === "ready") {
        setMissedKey(true);
        return null;
      }
      return profileErrorSentence(result, "create");
    },
    [port],
  );

  const signIn = useCallback(
    async (attempt: Promise<Awaited<ReturnType<typeof recoverProfile>>>): Promise<string | null> => {
      setBusy(true);
      const result = await attempt;
      setBusy(false);
      /* Signed in -- or this browser already was (another tab): either way the re-bootstrap has the answer. */
      if (result.ok || (result.error === "already-profiled" && port.state === "ready")) return null;
      return profileErrorSentence(result, "credential");
    },
    [port],
  );
  const onRecover = useCallback((key: string) => signIn(recoverProfile(key, port)), [signIn, port]);
  const onLink = useCallback((code: string) => signIn(linkProfile(code, port)), [signIn, port]);

  const onRotate = useCallback(async (): Promise<string | null> => {
    const result = await rotateRecoveryKey(port, receipt.current);
    if (!result.ok) return result.error === "reauth-required" ? MISSED_KEY_NO_RESCUE : profileErrorSentence(result);
    receipt.current = null;
    setMissedKey(false);
    setReveal(result.recoveryKey);
    return null;
  }, [port]);

  if (reveal !== null) {
    return (
      <div style={styles.screen}>
        <div style={styles.card}>
          <RecoveryKeyReveal recoveryKey={reveal} onContinue={() => setReveal(null)} />
        </div>
      </div>
    );
  }
  if (missedKey && state === "ready") {
    return (
      <div style={styles.screen}>
        <div style={styles.card}>
          <MissedKeyNotice name={account?.name ?? null} onRotate={onRotate} onContinue={() => setMissedKey(false)} />
        </div>
      </div>
    );
  }
  if (!busy && (state === "ready" || (state === "ended" && everReady))) return <>{children}</>;
  if (state === "unprofiled" || busy) {
    return (
      <div style={styles.screen}>
        <div style={styles.card}>
          <ProfileChoice busy={busy} onCreate={onCreate} onRecover={onRecover} onLink={onLink} />
        </div>
      </div>
    );
  }
  if (state === "ended") return <div style={styles.screen} data-testid="profile-gate-ended" />;
  return (
    <div style={styles.screen}>
      <div style={styles.card} role="status" data-testid="profile-gate-connecting">
        <p style={styles.text}>Connecting to the game server…</p>
        {failed ? (
          <>
            <p style={styles.text}>The game server did not answer.</p>
            <button type="button" style={styles.primary} onClick={() => bootstrap()}>
              Retry
            </button>
          </>
        ) : null}
      </div>
    </div>
  );
}
