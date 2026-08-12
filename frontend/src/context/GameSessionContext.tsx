// frontend/src/context/GameSessionContext.tsx
//
// The "GameSessionProvider" sketched in frontend_blueprint.md Section 1
// ("managing the ephemeral browser session key generation and local cache
// storage"), built here as App.tsx's second context boundary. DESIGN GAP
// being closed: Milestones 1-2 (WalletContext.tsx / ../utils/sessionKey.ts)
// only ever shipped the underlying *utilities* -- key generation/caching,
// the authz-wrapped executor, and the master wallet's `grantSessionKey`
// call -- never a Provider wrapping them into one piece of React state.
// App.tsx (Milestone 4) needs exactly that boundary to hold the session
// key/client across re-renders and expose a single `execGameplay` call
// its sidebar action buttons can use, so this file is that provider.
//
// Design notes:
// 1. `initializeSessionKey` does two things in sequence: (a) materializes
//    (generating if needed) the cached ephemeral session keypair and its
//    signing client via `sessionKey.ts`'s `createSessionSigningClient`,
//    then (b) broadcasts the authz `MsgGrant` that actually authorizes it,
//    signed by the connected master wallet via `useWallet().grantSessionKey`.
//    Both steps must succeed before `execGameplay` can work -- generating
//    the key alone grants it nothing on-chain, and a grant for an address
//    whose key was never generated/cached would be unreachable from this
//    browser.
// 2. This provider must render *inside* `WalletProvider` (see App.tsx) --
//    it calls `useWallet()` internally, and throws the same style of
//    "must be used within a Provider" error `useWallet`/`useGameSession`
//    each throw if nested the wrong way.
// 3. Re-running `initializeSessionKey` is safe to call again (e.g. the
//    player reloads mid-session): `getSessionWallet` reuses whatever key is
//    already cached in `sessionStorage` rather than generating a new one,
//    and re-broadcasting the same (contract, grantee, message-key-filter)
//    `MsgGrant` simply replaces the prior grant with a fresh expiration on
//    the Cosmos SDK's `x/authz` module rather than stacking a duplicate.
// 4. `execGameplay` is a thin wrapper over `sessionKey.ts`'s
//    `execViaSessionKey`, filling in the session client/address and the
//    connected master wallet's address automatically so call sites (see
//    App.tsx's sidebar handlers) only ever need to supply the
//    `GameplayExecuteMsg` itself.

import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import type { SigningCosmWasmClient } from "@cosmjs/cosmwasm-stargate";
import type { Coin, DeliverTxResponse } from "@cosmjs/stargate";

import { useWallet } from "./WalletContext";
import {
  clearSessionKey,
  createSessionSigningClient,
  execViaSessionKey,
  type GameplayExecuteMsg,
} from "../utils/sessionKey";

export type SessionKeyStatus = "uninitialized" | "initializing" | "ready" | "error";

interface GameSessionContextValue {
  sessionStatus: SessionKeyStatus;
  sessionAddress: string | null;
  sessionError: string | null;
  /** Generates/reuses the cached session key and grants it authz
   *  permission via the connected master wallet. Requires `WalletProvider`
   *  to already report a connected `address` -- sets `sessionStatus` to
   *  `"error"` (rather than throwing) if called before that. */
  initializeSessionKey: () => Promise<void>;
  /** Discards the cached session key and signing client locally. Does NOT
   *  revoke the on-chain grant -- pair with `useWallet().revokeSessionKey`
   *  for that, using the `sessionAddress` this hook held just before
   *  calling this. */
  forgetSessionKey: () => void;
  /** Executes a gameplay `ExecuteMsg` via the session key + authz
   *  `MsgExec`, gas routed through the developer FeeGrant. Rejects if the
   *  session key isn't `"ready"` yet. */
  execGameplay: (msg: GameplayExecuteMsg, funds?: Coin[]) => Promise<DeliverTxResponse>;
}

const GameSessionContext = createContext<GameSessionContextValue | undefined>(undefined);

export function GameSessionProvider({ children }: { children: React.ReactNode }) {
  const { address: masterAddress, grantSessionKey } = useWallet();

  const [sessionStatus, setSessionStatus] = useState<SessionKeyStatus>("uninitialized");
  const [sessionAddress, setSessionAddress] = useState<string | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);

  // Cached in a ref (not state) so `execGameplay` can reuse the same
  // connected signing client across calls instead of reconnecting to the
  // RPC endpoint on every single gameplay message.
  const sessionClientRef = useRef<SigningCosmWasmClient | null>(null);

  const initializeSessionKey = useCallback(async () => {
    if (!masterAddress) {
      setSessionError("Connect the master Keplr wallet before initializing a session key.");
      setSessionStatus("error");
      return;
    }

    setSessionStatus("initializing");
    setSessionError(null);
    try {
      const { client, address } = await createSessionSigningClient();
      sessionClientRef.current = client;
      setSessionAddress(address);

      await grantSessionKey(address);

      setSessionStatus("ready");
    } catch (e) {
      sessionClientRef.current = null;
      setSessionError(
        e instanceof Error ? e.message : "Unknown session key initialization error.",
      );
      setSessionStatus("error");
    }
  }, [masterAddress, grantSessionKey]);

  const forgetSessionKey = useCallback(() => {
    clearSessionKey();
    sessionClientRef.current = null;
    setSessionAddress(null);
    setSessionError(null);
    setSessionStatus("uninitialized");
  }, []);

  const execGameplay = useCallback(
    async (msg: GameplayExecuteMsg, funds?: Coin[]): Promise<DeliverTxResponse> => {
      if (
        sessionStatus !== "ready" ||
        !sessionClientRef.current ||
        !sessionAddress ||
        !masterAddress
      ) {
        throw new Error("Session key is not ready -- call initializeSessionKey() first.");
      }
      return execViaSessionKey({
        sessionClient: sessionClientRef.current,
        sessionAddress,
        masterAddress,
        msg,
        funds,
      });
    },
    [sessionStatus, sessionAddress, masterAddress],
  );

  const value = useMemo<GameSessionContextValue>(
    () => ({
      sessionStatus,
      sessionAddress,
      sessionError,
      initializeSessionKey,
      forgetSessionKey,
      execGameplay,
    }),
    [sessionStatus, sessionAddress, sessionError, initializeSessionKey, forgetSessionKey, execGameplay],
  );

  return <GameSessionContext.Provider value={value}>{children}</GameSessionContext.Provider>;
}

export function useGameSession(): GameSessionContextValue {
  const ctx = useContext(GameSessionContext);
  if (!ctx) throw new Error("useGameSession must be used within a GameSessionProvider");
  return ctx;
}
