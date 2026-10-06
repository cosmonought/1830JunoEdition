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
  /* The same normalization as `sessionBootstrap.accountKeyOfUsername` (the key a page's own sign-in records). */
  return username !== "" ? `account:${username.trim().normalize("NFKC").toLowerCase()}` : `name:${account.name}`;
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
  /** The page's own account changes when this baseline was set (`SessionPort.localAccount.changes`). */
  readonly local: number;
}

/* Security review (L2): the baseline survives a reload of the table (a reload while the question is up, or after
   another tab switched account, must still ask) -- per game, in this tab's sessionStorage (`1830juno.` namespace: a
   stored key, not a label). Only the account KEY and its display name are kept; failures just mean "not kept". */
const BASELINE_STORAGE_KEY = "1830juno.table_account.v1";
const MAX_STORED_TABLES = 20;
/** This tab's sessionStorage, where the page may use it (never `localStorage`: a baseline is this tab's). */
const tabStorage = (): Storage | null => (typeof sessionStorage === "undefined" ? null : sessionStorage);

function storedBaselines(): Record<string, { key: string; name: string | null }> {
  try {
    const raw = tabStorage()?.getItem(BASELINE_STORAGE_KEY) ?? null;
    const parsed: unknown = raw === null ? null : JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, { key: string; name: string | null }>) : {};
  } catch {
    return {};
  }
}

function storedBaseline(gameId: string | null): { key: string; name: string | null } | null {
  if (gameId === null) return null;
  const entry = storedBaselines()[gameId];
  return entry !== undefined && typeof entry.key === "string" && (entry.name === null || typeof entry.name === "string") ? entry : null;
}

function storeBaseline(gameId: string | null, baseline: { key: string; name: string | null }): void {
  if (gameId === null) return;
  try {
    const all = storedBaselines();
    delete all[gameId];
    const kept = Object.entries(all).slice(-(MAX_STORED_TABLES - 1));
    tabStorage()?.setItem(BASELINE_STORAGE_KEY, JSON.stringify(Object.fromEntries([...kept, [gameId, { key: baseline.key, name: baseline.name }]])));
  } catch {
    /* private browsing: the guard still works for this page's life */
  }
}

/** This page's own latest account change (after `since`) is to the account the browser holds now. */
function ownChange(changes: number, localKey: string | null, key: string | null, since: number): boolean {
  return changes > since && localKey !== null && key === localKey;
}

/** The guard for one open table. `active` is false for a Watch tab (nobody plays there) and before a table is open.
 *  `context.gameId` keys the persisted baseline; `context.local` is the session port's record of the account changes
 *  THIS PAGE made (`SessionPort.localAccount`): a change to exactly the account this page itself signed in to (its own
 *  "Log in" at this table) is the player's own choice and is taken at once; a same-account change of its own (a password
 *  change) only moves the record on; any OTHER change -- another tab's, or one that lands while this page's own sign-in
 *  is on the wire -- is asked about (security re-review NEW-1). */
export function useTableAccountGuard(
  view: { state: SessionState; account: SessionAccount | null },
  active: boolean,
  context: { readonly gameId?: string | null; readonly local?: { readonly changes: number; readonly key: string | null } } = {},
): TableAccountGuard {
  const key = tableAccountKey(view.state, view.account);
  const name = view.state === "ready" && view.account !== null ? view.account.name : null;
  const gameId = context.gameId ?? null;
  const changes = context.local?.changes ?? 0;
  const localKey = context.local?.key ?? null;
  const [baseline, setBaseline] = useState<Baseline | null>(null);
  useEffect(() => {
    if (!active) {
      setBaseline(null);
      return;
    }
    if (key === null) return;
    if (baseline === null) {
      /* The first answer while the table is open is the account it was opened as -- unless this tab already opened this
         table as someone (a reload, or back from the lobby): then that is the baseline, unless this page itself has since
         signed in to the account it holds now. */
      const stored = storedBaseline(gameId);
      const next = stored !== null && !(stored.key !== key && ownChange(changes, localKey, key, 0)) ? { ...stored, local: changes } : { key, name, local: changes };
      setBaseline(next);
      if (stored === null || next.key !== stored.key) storeBaseline(gameId, next);
      return;
    }
    if (changes > baseline.local) {
      if (key === baseline.key) setBaseline({ ...baseline, local: changes });
      else if (ownChange(changes, localKey, key, baseline.local)) {
        const next = { key, name, local: changes };
        setBaseline(next);
        storeBaseline(gameId, next);
      }
    }
  }, [active, key, name, baseline, gameId, changes, localKey]);
  const accept = useCallback(() => {
    if (key === null) return;
    const next = { key, name, local: changes };
    setBaseline(next);
    storeBaseline(gameId, next);
  }, [key, name, gameId, changes]);
  const change = active && baseline !== null && key !== null && key !== baseline.key && !ownChange(changes, localKey, key, baseline.local) ? { from: baseline.name, to: name } : null;
  return { change, accept };
}
