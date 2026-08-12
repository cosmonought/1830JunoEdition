// frontend/src/context/WalletContext.tsx
//
// Milestone 1: the master Keplr wallet connection, plus the one-time authz
// grant that hands the ephemeral session key (see ../utils/sessionKey.ts)
// permission to act on this wallet's behalf against the 18Cosmos contract.
//
// Design notes:
// 1. The master wallet's `OfflineSigner`/`SigningCosmWasmClient` here are
//    used for exactly the things Section 0 of frontend_blueprint.md scopes
//    to Keplr: `CreateGameRoom` / `JoinGameRoom` / `EndGameAndDistribute`
//    (real JUNO movement) and issuing/revoking the session key's authz
//    grant. Every in-game gameplay message goes through
//    ../utils/sessionKey.ts's `execViaSessionKey` instead.
// 2. The grant is scoped with `ContractExecutionAuthorization` +
//    `AcceptedMessageKeysFilter`, restricted to this one CONTRACT_ADDRESS
//    and to `GAMEPLAY_MESSAGE_KEYS` (imported from sessionKey.ts, which is
//    the single source of truth for that list, since the two files must
//    never drift). This corrects and supersedes the broader
//    `GenericAuthorization` sketch in frontend_blueprint.md Section 2.1,
//    which that document already flagged as a pre-mainnet gap.
// 3. Only the master wallet's public `juno...` address is ever cached to
//    `sessionStorage` (purely so the UI can show "reconnect as juno1..."
//    without re-deriving anything) -- never key material. Keplr itself
//    custodies the actual signing key; this app never touches it.
// 4. `MsgGrant`/`MsgExec`/`MsgRevoke` are not part of
//    `SigningCosmWasmClient`'s default message registry, so both this file
//    and sessionKey.ts must construct their signing clients with the
//    extended registry from `createExtendedRegistry()` -- omitting it is a
//    common, silent failure mode (the client throws "Unregistered type url"
//    only at broadcast time, not at connection time).
// 5. VERSION CAVEAT: the int64 fields below (`Grant.expiration.seconds`,
//    `MaxCallsLimit.remaining`) are built with plain `BigInt(...)`, which
//    matches recent `cosmjs-types` releases (0.9+) that target native
//    `bigint` for int64. Older `cosmjs-types` versions represented these
//    with the `Long` class from the `long` package instead, which would
//    need `Long.fromNumber(value)` here instead of `BigInt(value)`. This
//    file was written and syntax-checked without network access to a real
//    `node_modules` (sandbox constraint) -- confirm against your installed
//    `cosmjs-types` version's generated `.d.ts` before shipping, and adjust
//    both this file and sessionKey.ts's `execViaSessionKey` if it's on the
//    older `Long`-based generation.

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { SigningCosmWasmClient } from "@cosmjs/cosmwasm-stargate";
import { GasPrice, type DeliverTxResponse } from "@cosmjs/stargate";
import type { OfflineSigner } from "@cosmjs/proto-signing";
import { MsgGrant, MsgRevoke } from "cosmjs-types/cosmos/authz/v1beta1/tx";
import {
  ContractExecutionAuthorization,
  AcceptedMessageKeysFilter,
  MaxCallsLimit,
} from "cosmjs-types/cosmwasm/wasm/v1/authz";
import type { Any } from "cosmjs-types/google/protobuf/any";

import { createExtendedRegistry, GAMEPLAY_MESSAGE_KEYS } from "../utils/sessionKey";

// --- Deployment config -------------------------------------------------
// TODO(design gap): duplicated in ../utils/sessionKey.ts. Both files need
// the same chain/contract constants; extract to a shared
// `frontend/src/config.ts` once a third consumer shows up rather than
// keep copy-pasting these across the wallet and session-key layers.
const JUNO_CHAIN_ID = "juno-1";
const JUNO_RPC_ENDPOINT = "https://rpc-juno.itastakers.com"; // swap per environment
export const CONTRACT_ADDRESS = "juno1...eighteencosmos..."; // deployed 18Cosmos contract

const SESSION_GRANT_DURATION_SECONDS = 60 * 60 * 6; // 6 hours; renew before expiry
const MAX_SESSION_CALLS = 100_000; // MaxCallsLimit safety valve, not a real budget cap

const CACHED_ADDRESS_STORAGE_KEY = "18cosmos.master_address.v1";

// Minimal ambient typing for the injected Keplr provider. Swap for
// `@keplr-wallet/types`'s `Keplr` interface if/when that dependency is
// added -- kept loose here so this file has zero new package requirements.
declare global {
  interface Window {
    keplr?: {
      enable: (chainId: string) => Promise<void>;
      getOfflineSigner: (chainId: string) => OfflineSigner;
    };
  }
}

export type SessionGrantStatus = "none" | "granting" | "granted" | "revoking" | "error";

interface WalletContextValue {
  status: "disconnected" | "connecting" | "connected" | "error";
  address: string | null;
  signer: OfflineSigner | null;
  signingClient: SigningCosmWasmClient | null;
  error: string | null;
  connect: () => Promise<void>;
  disconnect: () => void;
  sessionGrantStatus: SessionGrantStatus;
  sessionGrantError: string | null;
  /** Signs and broadcasts the authz MsgGrant that lets `sessionAddress`
   *  execute 18Cosmos gameplay messages on this wallet's behalf. Returns
   *  the broadcast tx hash. */
  grantSessionKey: (sessionAddress: string) => Promise<string>;
  /** Signs and broadcasts an authz MsgRevoke, immediately invalidating
   *  whatever grant `sessionAddress` currently holds for this contract. */
  revokeSessionKey: (sessionAddress: string) => Promise<string>;
}

const WalletContext = createContext<WalletContextValue | undefined>(undefined);

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<WalletContextValue["status"]>("disconnected");
  const [address, setAddress] = useState<string | null>(null);
  const [signer, setSigner] = useState<OfflineSigner | null>(null);
  const [signingClient, setSigningClient] = useState<SigningCosmWasmClient | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [sessionGrantStatus, setSessionGrantStatus] = useState<SessionGrantStatus>("none");
  const [sessionGrantError, setSessionGrantError] = useState<string | null>(null);

  // Guards against a stale account switch: if Keplr's active account
  // changes out from under us mid-session, every subsequent signature
  // would silently be attributed to the wrong player. Tracked in a ref
  // (not state) purely so the keystorechange listener below always reads
  // the latest `disconnect` without re-subscribing on every render.
  const disconnectRef = useRef<() => void>(() => {});

  const connect = useCallback(async () => {
    setStatus("connecting");
    setError(null);
    try {
      if (!window.keplr) {
        throw new Error("Keplr extension not found. Install it from keplr.app to continue.");
      }
      await window.keplr.enable(JUNO_CHAIN_ID);

      const offlineSigner = window.keplr.getOfflineSigner(JUNO_CHAIN_ID);
      const accounts = await offlineSigner.getAccounts();
      if (accounts.length === 0) {
        throw new Error("Keplr returned no accounts for juno-1.");
      }

      const client = await SigningCosmWasmClient.connectWithSigner(
        JUNO_RPC_ENDPOINT,
        offlineSigner,
        {
          gasPrice: GasPrice.fromString("0.025ujuno"),
          registry: createExtendedRegistry(),
        },
      );

      const masterAddress = accounts[0].address;
      setSigner(offlineSigner);
      setSigningClient(client);
      setAddress(masterAddress);
      setStatus("connected");

      // Public data only -- see design note #3 above.
      sessionStorage.setItem(CACHED_ADDRESS_STORAGE_KEY, masterAddress);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown wallet connection error.");
      setStatus("error");
    }
  }, []);

  const disconnect = useCallback(() => {
    setSigner(null);
    setSigningClient(null);
    setAddress(null);
    setStatus("disconnected");
    setSessionGrantStatus("none");
    setSessionGrantError(null);
    sessionStorage.removeItem(CACHED_ADDRESS_STORAGE_KEY);
  }, []);

  useEffect(() => {
    disconnectRef.current = disconnect;
  }, [disconnect]);

  // If the user switches accounts inside Keplr itself, our cached
  // `address`/`signingClient` are instantly stale. Force a clean
  // disconnect rather than let a mismatched signer keep signing -- the UI
  // layer is expected to prompt the user to reconnect afterward.
  useEffect(() => {
    const handleKeystoreChange = () => disconnectRef.current();
    window.addEventListener("keplr_keystorechange", handleKeystoreChange);
    return () => window.removeEventListener("keplr_keystorechange", handleKeystoreChange);
  }, []);

  const grantSessionKey = useCallback(
    async (sessionAddress: string): Promise<string> => {
      if (!signingClient || !address) {
        throw new Error("Cannot grant session key authority before the master wallet is connected.");
      }

      setSessionGrantStatus("granting");
      setSessionGrantError(null);
      try {
        const expirationSeconds = Math.floor(Date.now() / 1000) + SESSION_GRANT_DURATION_SECONDS;

        const limitAny: Any = {
          typeUrl: "/cosmwasm.wasm.v1.MaxCallsLimit",
          value: MaxCallsLimit.encode(
            MaxCallsLimit.fromPartial({ remaining: BigInt(MAX_SESSION_CALLS) }),
          ).finish(),
        };

        const filterAny: Any = {
          typeUrl: "/cosmwasm.wasm.v1.AcceptedMessageKeysFilter",
          value: AcceptedMessageKeysFilter.encode(
            AcceptedMessageKeysFilter.fromPartial({ keys: [...GAMEPLAY_MESSAGE_KEYS] }),
          ).finish(),
        };

        const authorizationAny: Any = {
          typeUrl: "/cosmwasm.wasm.v1.ContractExecutionAuthorization",
          value: ContractExecutionAuthorization.encode(
            ContractExecutionAuthorization.fromPartial({
              grants: [
                {
                  contract: CONTRACT_ADDRESS,
                  limit: limitAny,
                  filter: filterAny,
                },
              ],
            }),
          ).finish(),
        };

        const grantMsg = {
          typeUrl: "/cosmos.authz.v1beta1.MsgGrant",
          value: MsgGrant.fromPartial({
            granter: address,
            grantee: sessionAddress,
            grant: {
              authorization: authorizationAny,
              expiration: { seconds: BigInt(expirationSeconds), nanos: 0 },
            },
          }),
        };

        const fee = {
          amount: [{ denom: "ujuno", amount: "5000" }],
          gas: "250000",
          // Note: NOT feeGranter'd -- this is a Keplr-signed setup
          // transaction the player pays for themselves, same as
          // CreateGameRoom/JoinGameRoom. The developer FeeGrant subsidy
          // (see ../utils/sessionKey.ts) covers gameplay moves only.
        };

        const result: DeliverTxResponse = await signingClient.signAndBroadcast(
          address,
          [grantMsg],
          fee,
          "18Cosmos: authorize session key",
        );

        if (result.code !== 0) {
          throw new Error(`MsgGrant failed (code ${result.code}): ${result.rawLog}`);
        }

        setSessionGrantStatus("granted");
        return result.transactionHash;
      } catch (e) {
        const message = e instanceof Error ? e.message : "Unknown session grant error.";
        setSessionGrantError(message);
        setSessionGrantStatus("error");
        throw e;
      }
    },
    [signingClient, address],
  );

  const revokeSessionKey = useCallback(
    async (sessionAddress: string): Promise<string> => {
      if (!signingClient || !address) {
        throw new Error("Cannot revoke session key authority before the master wallet is connected.");
      }

      setSessionGrantStatus("revoking");
      setSessionGrantError(null);
      try {
        const revokeMsg = {
          typeUrl: "/cosmos.authz.v1beta1.MsgRevoke",
          value: MsgRevoke.fromPartial({
            granter: address,
            grantee: sessionAddress,
            msgTypeUrl: "/cosmwasm.wasm.v1.MsgExecuteContract",
          }),
        };

        const fee = {
          amount: [{ denom: "ujuno", amount: "5000" }],
          gas: "200000",
        };

        const result: DeliverTxResponse = await signingClient.signAndBroadcast(
          address,
          [revokeMsg],
          fee,
          "18Cosmos: revoke session key",
        );

        if (result.code !== 0) {
          throw new Error(`MsgRevoke failed (code ${result.code}): ${result.rawLog}`);
        }

        setSessionGrantStatus("none");
        return result.transactionHash;
      } catch (e) {
        const message = e instanceof Error ? e.message : "Unknown session revoke error.";
        setSessionGrantError(message);
        setSessionGrantStatus("error");
        throw e;
      }
    },
    [signingClient, address],
  );

  const value = useMemo<WalletContextValue>(
    () => ({
      status,
      address,
      signer,
      signingClient,
      error,
      connect,
      disconnect,
      sessionGrantStatus,
      sessionGrantError,
      grantSessionKey,
      revokeSessionKey,
    }),
    [
      status,
      address,
      signer,
      signingClient,
      error,
      connect,
      disconnect,
      sessionGrantStatus,
      sessionGrantError,
      grantSessionKey,
      revokeSessionKey,
    ],
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletContextValue {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error("useWallet must be used within a WalletProvider");
  return ctx;
}
