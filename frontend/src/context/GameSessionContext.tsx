// The GameSessionProvider: the React boundary Milestones 1-2 never shipped.
// `WalletContext.tsx` and `utils/sessionKey.ts` only ever provided the
// utilities; App.tsx needs a provider to hold the session key/client across
// re-renders and expose one `execGameplay` call.
//
// 1. `initializeSessionKey` does two things in sequence: materialize (generating
//    if needed) the cached keypair and its signing client, then broadcast the
//    authz `MsgGrant` signed by the master wallet. BOTH must succeed -- a key
//    alone is granted nothing on-chain, and a grant for an uncached key is
//    unreachable from this browser.
// 2. Must render INSIDE `WalletProvider`; it calls `useWallet()` internally.
// 3. Safe to re-run (e.g. a mid-session reload): the key is reused from
//    `sessionStorage`, and re-broadcasting the same grant REPLACES the prior one
//    with a fresh expiration on `x/authz` rather than stacking a duplicate.
// 4. `execGameplay` fills in the session client/address and master address so
//    call sites only supply the `GameplayExecuteMsg`.
//
// See docs/ai_architecture/session_keys_wallet.md, GameSessionContext.tsx.

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
        throw new Error("Session key is not ready — call initializeSessionKey() first.");
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
