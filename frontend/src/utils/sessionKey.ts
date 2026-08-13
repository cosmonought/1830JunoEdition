// frontend/src/utils/sessionKey.ts
//
// Milestone 2: the ephemeral browser session key -- generation, safe
// sessionStorage caching, and the authz-wrapped executor that routes every
// in-game gameplay message through it with gas paid by the developer
// FeeGrant address. See ../context/WalletContext.tsx for the master-wallet
// side of the same handshake (the MsgGrant this key depends on).
//
// Design notes:
// 1. Key generation uses @cosmjs/crypto's `Random`/`Secp256k1` (a CSPRNG
//    wrapper + curve validation), then wraps the raw scalar in a
//    @cosmjs/proto-signing `DirectSecp256k1Wallet` for actual tx signing.
//    @cosmjs/amino's `Secp256k1Wallet` is the equivalent choice for
//    amino-style signing (what Keplr's own injected signer typically uses)
//    -- direct (protobuf) signing was chosen here instead because it's the
//    simpler, more standard path for a locally generated key that never
//    touches Keplr's UI, and CosmWasm's MsgExecuteContract/MsgExec are
//    natively protobuf messages either way.
// 2. The private key lives in `sessionStorage`, not `localStorage`: it
//    should not survive a browser restart or be shared across tabs once
//    this tab closes. A stolen session key can only ever do what its authz
//    grant allows (see WalletContext.tsx's ContractExecutionAuthorization +
//    AcceptedMessageKeysFilter scoping) and spend whatever the developer
//    FeeGrant is willing to cover -- never move the player's real JUNO --
//    which is the whole point of keeping it this narrowly scoped.
// 3. `GAMEPLAY_MESSAGE_KEYS` below is the single source of truth for which
//    `ExecuteMsg` variants the session key is allowed to submit.
//    WalletContext.tsx imports this exact array into the on-chain grant's
//    `AcceptedMessageKeysFilter` so the client-side allow-list and the
//    on-chain enforcement can never drift apart. `execViaSessionKey` also
//    asserts against it locally, so a coding mistake fails fast in the
//    browser instead of as an opaque on-chain rejection.
// 4. IMPORTANT wire-format correction vs. frontend_blueprint.md Section 2:
//    `msg.rs`'s `ExecuteMsg` has no `#[serde(rename_all = ...)]`, so it
//    serializes with serde's default *externally tagged* representation --
//    the JSON key is the exact Rust variant name, e.g. `{"BuyStock": {...}}`,
//    NOT `{"buy_stock": {...}}`. `SharePurchaseSource` is the same story:
//    `{"Ipo"}`/`{"Bank"}`, not lowercase. The blueprint's inline call-site
//    examples used the wrong casing; `GameplayExecuteMsg` below is the
//    corrected, exact-cased type, and it's what should be used going
//    forward instead of those examples.
// 5. `MsgExec`'s `msgs` field is `repeated google.protobuf.Any`, and `Any`
//    is a real protobuf wrapper (`{ typeUrl, value: Uint8Array }`) -- the
//    inner `MsgExecuteContract` MUST be encoded to bytes with
//    `.encode(...).finish()` before being placed in that array. Passing a
//    decoded/plain object as `Any.value` (as an earlier sketch did) encodes
//    successfully client-side but fails to decode on-chain, since the
//    chain's Any unpacking expects real protobuf bytes, not JSON. Every
//    inner message in this file's `execViaSessionKey` is encoded this way.

import { Random, Secp256k1 } from "@cosmjs/crypto";
import { DirectSecp256k1Wallet, Registry } from "@cosmjs/proto-signing";
import { SigningCosmWasmClient, wasmTypes } from "@cosmjs/cosmwasm-stargate";
import {
  GasPrice,
  defaultRegistryTypes,
  type Coin,
  type DeliverTxResponse,
} from "@cosmjs/stargate";
import { fromHex, toHex } from "@cosmjs/encoding";
import { MsgExec, MsgGrant, MsgRevoke } from "cosmjs-types/cosmos/authz/v1beta1/tx";
import { MsgExecuteContract } from "cosmjs-types/cosmwasm/wasm/v1/tx";
import type { Any } from "cosmjs-types/google/protobuf/any";

// --- Deployment config -------------------------------------------------
// F-4: the TODO that stood here is RESOLVED, and so is the placeholder that
// was the actual bug. `DEVELOPER_FEE_GRANTER_ADDRESS` used to be the literal
// string "juno1...devfeegrantaddress...", which is not valid bech32 -- and
// since every gameplay transaction below routes `granter: feeGranter`, EVERY
// session-key transaction would have failed at fee-grant resolution the
// moment this pointed at a live chain. Nothing caught it earlier because
// nothing validated it: the failure surfaced at broadcast, as far from the
// mistake as it is possible to get.
//
// `../config` now reads all four from the environment and throws at import
// on anything that is not a plausible address, so the app cannot start in
// that state. It is also the single definition shared with
// `../context/WalletContext.tsx`, which matters specifically for
// `CONTRACT_ADDRESS`: this file's copy scopes the authz grant's
// `ContractExecutionAuthorization` while that file's copy signs it, and two
// drifting copies would authorize a contract the app never calls.
import {
  JUNO_PREFIX,
  requireContractAddress,
  requireFeeGranterAddress,
  requireRpcEndpoint,
} from "../config";

const SESSION_STORAGE_KEY = "18cosmos.session_key.v1";

// --- Gameplay message allow-list ---------------------------------------
// Deliberately EXCLUDES CreateGameRoom, JoinGameRoom, and
// EndGameAndDistribute -- those move real JUNO and stay Keplr-signed
// through WalletContext.tsx's `signingClient`, per frontend_blueprint.md
// Section 0. Every other `ExecuteMsg` variant is pure VGP/gameplay state
// and is safe to delegate to the session key.
export const GAMEPLAY_MESSAGE_KEYS = [
  "BuyStock",
  "SellStock",
  "DeclareDividends",
  "BidOnPrivate",
  "BuyPrivateCompany",
  "ExecuteOperatingRound",
  "BeginOperatingRound",
  "AdvanceOperatingSubPhase",
  "LayTile",
  "BuyHardwareFromPool",
  "EmergencyBuyHardware",
  "PassTurn",
  "UndoLastAction",
  // Pre-Game Waterfall Auction (`waterfall.rs`) -- pure VGP/gameplay state,
  // same as every other entry above; none of these move real JUNO.
  "WaterfallBuyLowest",
  "WaterfallBidHigher",
  "WaterfallPass",
  "WaterfallMiniAuctionRaise",
  "WaterfallMiniAuctionPass",
] as const;

export type GameplayMessageKey = (typeof GAMEPLAY_MESSAGE_KEYS)[number];

/** One public corporation's Operating Round distribute/retain choice --
 *  mirrors `msg.rs`'s `PublicCompanyPayoutChoice` exactly. */
export interface PublicCompanyPayoutChoiceDto {
  company_id: number;
  payout: boolean;
}

/** Exact-cased TypeScript mirror of `msg.rs`'s `ExecuteMsg`, restricted to
 *  the session-key-eligible (non-JUNO-moving) variants in
 *  `GAMEPLAY_MESSAGE_KEYS`. See design note #4 above for why the variant
 *  keys are PascalCase while their fields stay snake_case (fields are
 *  serialized as literally named in the Rust struct, which is already
 *  snake_case in `msg.rs`; only the enum's own externally-tagged variant
 *  name follows serde's PascalCase default). */
export type GameplayExecuteMsg =
  // Audit G-14: advances a corporation past its current Operating Round
  // sub-phase without acting in it. The six OR actions are gated on-chain
  // against a persisted cursor, so this is the only way to get past a phase
  // the corporation has nothing to do in -- and every skip is a recorded,
  // replayable event rather than a client-side jump.
  | { AdvanceOperatingSubPhase: { game_id: number; protocol_id: number } }
  | {
      BuyStock: {
        game_id: number;
        protocol_id: number;
        source: "Ipo" | "Bank";
        par_value: string | null;
      };
    }
  | { SellStock: { game_id: number; protocol_id: number; percentage: number } }
  | {
      DeclareDividends: {
        game_id: number;
        protocol_id: number;
        revenue_amount: string;
        distribute: boolean;
      };
    }
  | { BidOnPrivate: { game_id: number; private_id: number; bid_amount: string } }
  // Phase-Gated Corporate Purchase Protocol (`trading.rs` module doc
  // comment #17): a corporation buying a player-owned private company's
  // wrapper into its own treasury, once Phase 3 (the 3-train era) has
  // launched. `price` is a string for the same big-int-safety reason every
  // other `Uint128` field here is (`bid_amount`, `revenue_amount`, etc.).
  | {
      BuyPrivateCompany: {
        game_id: number;
        protocol_id: number;
        private_id: number;
        price: string;
      };
    }
  | {
      ExecuteOperatingRound: {
        game_id: number;
        public_company_choices: PublicCompanyPayoutChoiceDto[];
      };
    }
  | { BeginOperatingRound: { game_id: number } }
  // STRUCTURAL FIX: `orientation` is now a required, explicit, player-chosen
  // field (mirrors `msg.rs`'s `ExecuteMsg::LayTile`, updated the same pass)
  // -- a prior version of this contract auto-picked the lowest legal
  // rotation server-side and took no `orientation` input at all, which
  // silently removed a real 1830 strategic choice (which direction a route
  // extends). `TileSelectionPopup.tsx` is the only caller and always sends
  // the player's actually-selected orientation, not just the lowest legal
  // one.
  | {
      LayTile: {
        game_id: number;
        protocol_id: number;
        q: number;
        r: number;
        tile_id: number;
        orientation: number;
      };
    }
  | { BuyHardwareFromPool: { game_id: number; protocol_id: number } }
  | { EmergencyBuyHardware: { game_id: number; protocol_id: number } }
  | { PassTurn: { game_id: number } }
  | { UndoLastAction: { game_id: number } }
  // Pre-Game Waterfall Auction (`waterfall.rs`) -- mirrors `msg.rs`'s five
  // `Waterfall*` `ExecuteMsg` variants exactly. See `WaterfallAuctionDashboard.tsx`
  // for the only caller of these.
  | { WaterfallBuyLowest: { game_id: number } }
  | {
      WaterfallBidHigher: {
        game_id: number;
        private_id: number;
        bid_amount: string;
      };
    }
  | { WaterfallPass: { game_id: number } }
  | { WaterfallMiniAuctionRaise: { game_id: number; bid_amount: string } }
  | { WaterfallMiniAuctionPass: { game_id: number } };

/** Extends CosmWasm's default message registry with the full set of
 *  `x/authz` message types used across the wallet/session-key layer:
 *  `MsgExec` (session key, this file) and `MsgGrant`/`MsgRevoke` (master
 *  wallet, WalletContext.tsx). Neither client works without this -- a
 *  `SigningCosmWasmClient` built with the plain default registry throws
 *  "Unregistered type url" the moment it tries to encode any of these,
 *  which only surfaces at broadcast time, not at connection time. Both
 *  signing clients in this codebase MUST be constructed with this same
 *  factory rather than two independently-assembled registries, precisely
 *  so this list can't drift out of sync with what each client actually
 *  needs to send. */
export function createExtendedRegistry(): Registry {
  const registry = new Registry([...defaultRegistryTypes, ...wasmTypes]);
  registry.register("/cosmos.authz.v1beta1.MsgExec", MsgExec);
  registry.register("/cosmos.authz.v1beta1.MsgGrant", MsgGrant);
  registry.register("/cosmos.authz.v1beta1.MsgRevoke", MsgRevoke);
  return registry;
}

/** Generates a fresh, curve-validated random Secp256k1 private key. Loops
 *  (astronomically unlikely to iterate more than once) in case the raw
 *  random bytes don't land on a valid scalar for the curve. */
async function generateSessionPrivateKey(): Promise<Uint8Array> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = Random.getBytes(32);
    try {
      await Secp256k1.makeKeypair(candidate);
      return candidate;
    } catch {
      // Invalid scalar (out of curve order) -- retry with fresh bytes.
    }
  }
  throw new Error("Failed to generate a valid session private key after 5 attempts.");
}

/** Loads the cached session private key from `sessionStorage`, or
 *  generates and caches a new one. See design note #2 above for why
 *  `sessionStorage` and not `localStorage`. */
async function loadOrCreateSessionPrivateKey(): Promise<Uint8Array> {
  const cached = sessionStorage.getItem(SESSION_STORAGE_KEY);
  if (cached) {
    return fromHex(cached);
  }
  const generated = await generateSessionPrivateKey();
  sessionStorage.setItem(SESSION_STORAGE_KEY, toHex(generated));
  return generated;
}

/** True if a session key is already cached for this browser session. */
export function hasCachedSessionKey(): boolean {
  return sessionStorage.getItem(SESSION_STORAGE_KEY) !== null;
}

/** Discards the cached session key. Callers should also broadcast a
 *  `MsgRevoke` (see WalletContext.tsx's `revokeSessionKey`) if the
 *  corresponding authz grant should stop working immediately -- clearing
 *  the cache alone only forgets the key locally, it doesn't invalidate
 *  the on-chain grant. */
export function clearSessionKey(): void {
  sessionStorage.removeItem(SESSION_STORAGE_KEY);
}

/** Materializes the cached (or newly generated) session key as a signing
 *  wallet, along with its derived `juno...` address. */
export async function getSessionWallet(): Promise<{
  wallet: DirectSecp256k1Wallet;
  address: string;
}> {
  const privkey = await loadOrCreateSessionPrivateKey();
  const wallet = await DirectSecp256k1Wallet.fromKey(privkey, JUNO_PREFIX);
  const [account] = await wallet.getAccounts();
  return { wallet, address: account.address };
}

/** Builds a `SigningCosmWasmClient` for the session key, wired to the
 *  extended registry (see `createExtendedRegistry`) so it can broadcast
 *  `MsgExec`. */
export async function createSessionSigningClient(
  rpcEndpoint: string = requireRpcEndpoint(),
): Promise<{ client: SigningCosmWasmClient; address: string }> {
  const { wallet, address } = await getSessionWallet();
  const client = await SigningCosmWasmClient.connectWithSigner(rpcEndpoint, wallet, {
    gasPrice: GasPrice.fromString("0.025ujuno"),
    registry: createExtendedRegistry(),
  });
  return { client, address };
}

export interface ExecViaSessionKeyOptions {
  sessionClient: SigningCosmWasmClient;
  sessionAddress: string;
  /** The player's master wallet address -- becomes `info.sender` inside
   *  the contract once `MsgExec` re-dispatches the inner message, since
   *  authz executes on behalf of the granter, not the signer. */
  masterAddress: string;
  msg: GameplayExecuteMsg;
  funds?: Coin[];
  /** Defaults to `DEVELOPER_FEE_GRANTER_ADDRESS`. Overridable per-call in
   *  case a different subsidy pool is ever wired up (e.g. a per-tournament
   *  sponsor address), but every gameplay tx should set *some* feeGranter
   *  -- the session key itself is never expected to hold JUNO to pay gas
   *  with. */
  feeGranter?: string;
  gasLimit?: string;
  gasFeeAmount?: Coin;
  memo?: string;
}

/**
 * Executes a gameplay `ExecuteMsg` against the 18Cosmos contract, signed by
 * the browser session key but authorized on behalf of `masterAddress` via
 * `authz.MsgExec`, with gas covered by `feeGranter` (the developer subsidy
 * tank) instead of the session key's own -- deliberately empty -- balance.
 *
 * See this file's design note #5 for why the inner `MsgExecuteContract` is
 * manually protobuf-encoded before being wrapped as `Any`, rather than
 * handed to `MsgExec.fromPartial` as a plain decoded object.
 */
export async function execViaSessionKey(
  options: ExecViaSessionKeyOptions,
): Promise<DeliverTxResponse> {
  const {
    sessionClient,
    sessionAddress,
    masterAddress,
    msg,
    funds = [],
    feeGranter = requireFeeGranterAddress(),
    gasLimit = "300000",
    gasFeeAmount = { denom: "ujuno", amount: "5000" },
    memo = "18Cosmos move",
  } = options;

  const messageKey = Object.keys(msg)[0] as GameplayMessageKey;
  if (!GAMEPLAY_MESSAGE_KEYS.includes(messageKey)) {
    // Fails fast in the browser instead of as an opaque
    // "authorization not found" rejection from the chain -- this should
    // only ever trip on a coding mistake, since GameplayExecuteMsg's type
    // already restricts callers to this same key set.
    throw new Error(
      `execViaSessionKey: "${messageKey}" is not in GAMEPLAY_MESSAGE_KEYS. ` +
        `Real-JUNO-moving messages (CreateGameRoom, JoinGameRoom, ` +
        `EndGameAndDistribute) must be signed directly by the master ` +
        `wallet via WalletContext's signingClient, not routed through the ` +
        `session key.`,
    );
  }

  const innerAny: Any = {
    typeUrl: "/cosmwasm.wasm.v1.MsgExecuteContract",
    value: MsgExecuteContract.encode(
      MsgExecuteContract.fromPartial({
        sender: masterAddress, // the GRANTER -- what the contract sees as info.sender
        contract: requireContractAddress(),
        msg: new TextEncoder().encode(JSON.stringify(msg)),
        funds,
      }),
    ).finish(),
  };

  // Unlike `innerAny` above, this OUTER message is passed to
  // `signAndBroadcast` as a plain typeUrl/value EncodeObject -- the
  // extended registry (see `createExtendedRegistry`) encodes it
  // automatically. Only nested `Any` fields (like `MsgExec.msgs` here)
  // need to be pre-encoded to bytes by hand; the top-level message never
  // does.
  const execEncodeObject = {
    typeUrl: "/cosmos.authz.v1beta1.MsgExec",
    value: MsgExec.fromPartial({
      grantee: sessionAddress, // the SIGNER of this outer tx
      msgs: [innerAny],
    }),
  };

  const fee = {
    amount: [gasFeeAmount],
    gas: gasLimit,
    granter: feeGranter, // <-- this is the FeeGrant routing: session key never pays its own gas
  };

  const result = await sessionClient.signAndBroadcast(sessionAddress, [execEncodeObject], fee, memo);
  if (result.code !== 0) {
    throw new Error(`Transaction failed (code ${result.code}): ${result.rawLog}`);
  }
  return result;
}
