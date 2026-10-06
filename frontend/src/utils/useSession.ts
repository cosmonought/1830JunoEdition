// frontend/src/utils/useSession.ts
//
// LIVE-2E: the session port, as a React value. The snapshot is a string built from the port's own fields, so React's
// external-store check compares primitives (no object identity to keep stable) and a component re-renders exactly
// when the state, the reason or the account changes. It lives in memory only -- nothing here is stored.

import { useCallback, useSyncExternalStore } from "react";

import { sessionPort, type SessionAccount, type SessionPort, type SessionState } from "./sessionBootstrap";

export interface SessionView {
  state: SessionState;
  account: SessionAccount | null;
  endedReason: string | null;
}

const snapshotOf = (port: SessionPort): string =>
  JSON.stringify([port.state, port.endedReason, port.account?.name ?? null, port.account?.otherSessions ?? null, port.account?.development === true, port.account?.username ?? null]);

export function useSession(port: SessionPort = sessionPort()): SessionView {
  const subscribe = useCallback((notify: () => void) => port.subscribe(notify), [port]);
  useSyncExternalStore(subscribe, () => snapshotOf(port));
  return { state: port.state, account: port.account, endedReason: port.endedReason };
}
