// frontend/src/utils/tableAccountGuard.ts
//
// ==================================================================
//  PHASE 3 FINAL (§9 / §12): AN OPEN TABLE NEVER BECOMES SOMEBODY ELSE SILENTLY
// ==================================================================
//
// The owner's model: THE PROFILE / ACCOUNT IS THE PLAYER. Who this tab plays as at a table is the server's answer for
// the browser's SESSION (session -> profile -> the seat bound to that profile). No wallet -- the Keplr account selected
// now, the one a seat deposited from, the Authorization Wallet -- ever answers it, and switching Keplr changes nothing
// here (the money panel re-reads Keplr only as the signer of the next signature).
//
// What CAN change under an open table is the browser's account: the cookie is per browser, so a sign-in, a sign-out or
// a "Forgot password?" in ANOTHER TAB replaces this tab's session too. Its sockets close 4401, re-bootstrap with the new
// cookie, and the room answers for the NEW account -- that account's seat, or a watcher's view. Correct as authority (the
// server decides by session, so nothing is ever done as the old account), but a player looking at "their" table would
// be shown someone else's seat, cash and turn with no word said. So the table remembers which account it was opened
// as, and when the browser's account differs it says so and asks -- "Continue as <new>" or "Back to the lobby" -- while
// the shell's send gate refuses every move until the player chooses.
//
// The key compares the account's USERNAME (told only to its own session); the always-ready development port has none,
// so its stand-in is keyed by name. "unknown" (bootstrapping) and "ended" (the session-ended notice's business) are not
// answers and change nothing.

import { useCallback, useEffect, useState } from "react";

import type { SessionAccount, SessionState } from "./sessionBootstrap";

/** Which account a session view is, or null while it isn't an answer (bootstrapping, ended). */
export function tableAccountKey(state: SessionState, account: SessionAccount | null): string | null {
  if (state === "unprofiled") return "visitor";
  if (state !== "ready" || account === null) return null;
  const username = account.username ?? "";
  return username !== "" ? `account:${username.normalize("NFKC").toLowerCase()}` : `name:${account.name}`;
}

/** The browser's account changed under the open table: who it was opened as, and who the browser is now. */
export interface TableAccountChange {
  /** The name the table was opened as (a display name), or null when it was opened signed out. */
  readonly from: string | null;
  /** The name the browser is signed in as now, or null when it is signed out now. */
  readonly to: string | null;
}

/** The sentence the send gate answers while a change is unanswered. */
export const ACCOUNT_CHANGED_NO_SEND = "This browser's account changed in another tab. Choose how to continue before you play.";

export interface TableAccountGuard {
  readonly change: TableAccountChange | null;
  /** Continue as the browser's account now (the table is re-read as theirs). */
  accept(): void;
}

interface Baseline {
  readonly key: string;
  readonly name: string | null;
}

/** The guard for one open table. `active` is false for a Watch tab (nobody plays there) and before a table is open. */
export function useTableAccountGuard(view: { state: SessionState; account: SessionAccount | null }, active: boolean): TableAccountGuard {
  const key = tableAccountKey(view.state, view.account);
  const name = view.state === "ready" && view.account !== null ? view.account.name : null;
  const [baseline, setBaseline] = useState<Baseline | null>(null);
  /* The first answer while the table is open is the account it was opened as. */
  useEffect(() => {
    if (!active) {
      setBaseline(null);
      return;
    }
    if (key !== null && baseline === null) setBaseline({ key, name });
  }, [active, key, name, baseline]);
  const accept = useCallback(() => {
    if (key !== null) setBaseline({ key, name });
  }, [key, name]);
  const change = active && baseline !== null && key !== null && key !== baseline.key ? { from: baseline.name, to: name } : null;
  return { change, accept };
}
