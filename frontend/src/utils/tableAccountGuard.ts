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
  /** The page's own account changes when this baseline was set (`SessionPort.localChanges`). */
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

/** The guard for one open table. `active` is false for a Watch tab (nobody plays there) and before a table is open.
 *  `context.gameId` keys the persisted baseline; `context.localChanges` is the session port's count of account changes
 *  THIS PAGE made -- a change it made itself (a sign-in through this tab's own "Log in" at this table) is the player's
 *  own choice and is taken at once; only a change from ANOTHER tab is asked about. */
export function useTableAccountGuard(
  view: { state: SessionState; account: SessionAccount | null },
  active: boolean,
  context: { readonly gameId?: string | null; readonly localChanges?: number } = {},
): TableAccountGuard {
  const key = tableAccountKey(view.state, view.account);
  const name = view.state === "ready" && view.account !== null ? view.account.name : null;
  const gameId = context.gameId ?? null;
  const local = context.localChanges ?? 0;
  const [baseline, setBaseline] = useState<Baseline | null>(null);
  /* The first answer while the table is open is the account it was opened as -- unless this tab already opened this
     table as someone (a reload): then that is the baseline. A change this page made itself is taken at once. */
  useEffect(() => {
    if (!active) {
      setBaseline(null);
      return;
    }
    if (key === null) return;
    if (baseline === null) {
      const stored = storedBaseline(gameId);
      const next = stored !== null ? { ...stored, local } : { key, name, local };
      setBaseline(next);
      if (stored === null) storeBaseline(gameId, next);
      return;
    }
    if (key !== baseline.key && local > baseline.local) {
      const next = { key, name, local };
      setBaseline(next);
      storeBaseline(gameId, next);
    }
  }, [active, key, name, baseline, gameId, local]);
  const accept = useCallback(() => {
    if (key === null) return;
    const next = { key, name, local };
    setBaseline(next);
    storeBaseline(gameId, next);
  }, [key, name, gameId, local]);
  const change = active && baseline !== null && key !== null && key !== baseline.key && !(local > baseline.local) ? { from: baseline.name, to: name } : null;
  return { change, accept };
}
