// Milestone 2: the ephemeral browser session key -- generation, safe
// `sessionStorage` caching, and the authz-wrapped executor that routes every
// in-game gameplay message through it with gas paid by the developer FeeGrant
// address. See ../context/WalletContext.tsx for the MsgGrant side.
//
// 1. Generation uses `@cosmjs/crypto`'s `Random`/`Secp256k1`, wrapped in a
//    `DirectSecp256k1Wallet`. Direct (protobuf) signing rather than amino: the
//    simpler path for a key that never touches Keplr's UI, and
//    `MsgExecuteContract`/`MsgExec` are natively protobuf either way.
// 2. The private key lives in `sessionStorage`, not `localStorage`. A stolen
//    session key can only do what its authz grant allows and spend what the
//    FeeGrant covers -- never move the player's real JUNO.
// 3. `GAMEPLAY_MESSAGE_KEYS` is the single source of truth for which variants
//    the key may submit; `WalletContext.tsx` imports this exact array into the
//    on-chain `AcceptedMessageKeysFilter`, so client and chain cannot drift.
//    `execViaSessionKey` also asserts locally, so a mistake fails fast in the
//    browser instead of as an opaque on-chain rejection.
// 4. WIRE FORMAT vs. frontend_blueprint.md Section 2: `msg.rs`'s `ExecuteMsg`
//    has no `#[serde(rename_all)]`, so it is EXTERNALLY TAGGED with the exact
//    Rust variant name -- `{"BuyStock": {...}}`, not `{"buy_stock": {...}}`.
//    `SharePurchaseSource` likewise: `{"Ipo"}`/`{"Bank"}`. The blueprint's
//    examples used the wrong casing; `GameplayExecuteMsg` is the corrected type.
// 5. `MsgExec.msgs` is `repeated Any`, so the inner `MsgExecuteContract` MUST be
//    `.encode(...).finish()`-ed to bytes first. Passing a plain object as
//    `Any.value` encodes fine client-side and fails to decode on-chain.
//
// See docs/ai_architecture/session_keys_wallet.md, sessionKey.ts #1 - #5.

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

// Deployment config. F-4: `DEVELOPER_FEE_GRANTER_ADDRESS` used to be the literal
// `"juno1...devfeegrantaddress..."`, which is not valid bech32 -- and since every
// gameplay transaction routes `granter: feeGranter`, EVERY session-key
// transaction would have failed at fee-grant resolution against a live chain,
// surfacing at broadcast, as far from the mistake as possible.
//
// `../config` now reads all four from the environment and is the single
// definition shared with `WalletContext.tsx` -- which matters specifically for
// `CONTRACT_ADDRESS`: this file's copy SCOPES the authz grant while that file's
// copy SIGNS it, and two drifting copies would authorize a contract the app
// never calls.
import {
  JUNO_PREFIX,
  requireContractAddress,
  requireFeeGranterAddress,
  requireRpcEndpoint,
  APP_NAME,
} from "../config";

const SESSION_STORAGE_KEY = "18cosmos.session_key.v1";

// Gameplay message allow-list. Deliberately EXCLUDES `CreateGameRoom`,
// `JoinGameRoom` and `EndGameAndDistribute` -- those move real JUNO and stay
// Keplr-signed through `WalletContext.tsx`'s `signingClient`, per
// frontend_blueprint.md Section 0. Every other variant is pure VGP/gameplay
// state and is safe to delegate.
export const GAMEPLAY_MESSAGE_KEYS = [
  "BuyStock",
  "SellStock",
  "DeclareDividends",
  "BidOnPrivate",
  "BuyPrivateCompany",
  "ExecuteOperatingRound",
  "BeginOperatingRound",
  "AdvanceOperatingSubPhase",
  "BuyTrainFromCorporation",
  "AcceptTrainOffer",
  "RejectTrainOffer",
  "RescindTrainOffer",
  "LayTile",
  // Station Tokens. Present in the contract's `ExecuteMsg` since the Station
  // Token feature landed, but never mirrored here -- so this frontend could
  // not place a token on chain OR in the sandbox, on any code path. Pure
  // VGP/gameplay state like every other entry.
  "PlaceStationToken",
  // Step 4.5 Batch 3, item 1: the President submits an explicit route
  // instead of leaning on the automatic tracer. Pure VGP/gameplay state --
  // it moves no real JUNO -- so it belongs on the session key like every
  // other entry here.
  "RunManualRoute",
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

/** One stop on a manually-declared route -- the exact mirror of `msg.rs`'s
 *  `RouteWaypoint` (Step 4.5 Batch 3, item 1).
 *
 *  THE UNIT OF A ROUTE IS A STATION, NOT A HEX. That became load-bearing when the
 *  contract's pathfinder moved its path history to `(hex, city_node)` keys: a
 *  route can legally serve BOTH stations of a two-city hex (New York's #62, every
 *  OO tile). The old `hex_path: string[]` could not say which of the two a stop
 *  meant, so the contract had to refuse any repeated hex label outright.
 *
 *  `city_node` is OPTIONAL and omitting it is the normal case -- "this hex has
 *  one stop, or none", which is almost the whole board. Indexed like the
 *  contract's own city registries (`0` first, `1` second); naming a city the hex
 *  does not have is rejected with `NoSuchCityOnHex` rather than coerced. */
export interface RouteWaypointDto {
  hex: string;
  city_node?: number;
  /** Design note #808: WHICH ARM OF A FORKED HEX, and A FIELD THE CONTRACT DOES NOT HAVE YET.
   *
   *  Flagged loudly rather than added quietly, because every other field in this file is a mirror of a real
   *  `msg.rs` struct and this one is a mirror of nothing. Altoona (H12) prints two tracks joining the same two
   *  edges -- one through its station, one around it -- so a waypoint naming only the hex is ambiguous there,
   *  and `pathfinding.rs` will need this same distinction before manual routes can be validated on chain.
   *  Until then the sandbox reducer is the authority and reads it (`sandboxSession.ts` #737): a bypassed hex
   *  pays nothing and spends no stop.
   *  OMITTED unless true, so every route that does not touch H12's bow is byte-identical to what this app has
   *  always sent -- which is what keeps the gap from being a change to the wire format for anybody else.
   *  Same shape of gap, and the same treatment, as `PrivateTradePanel.tsx` #0's missing offer message. */
  bypass?: boolean;
}

/** Distribute Yield vs Slash/Retain Yield -- mirrors `msg.rs`'s
 *  `PayoutStrategy`, whose unit variants serialize as their bare PascalCase
 *  names under serde's default externally-tagged representation. */
export type PayoutStrategyDto = "DeclareDividends" | "Withhold";

/** Exact-cased TypeScript mirror of `msg.rs`'s `ExecuteMsg`, restricted to the
 *  session-key-eligible (non-JUNO-moving) variants in `GAMEPLAY_MESSAGE_KEYS`.
 *  See design note #4 for why the variant keys are PascalCase while their fields
 *  stay snake_case -- fields serialize as literally named in the Rust struct;
 *  only the enum's externally-tagged variant name follows serde's default. */
export type GameplayExecuteMsg =
  // Audit G-14: advances a corporation past its current Operating Round sub-phase
  // without acting in it. The six OR actions are gated on-chain against a
  // persisted cursor, so this is the only way past a phase the corporation has
  // nothing to do in -- and every skip is a recorded, replayable event rather than
  // a client-side jump.
  | { AdvanceOperatingSubPhase: { game_id: number; protocol_id: number } }
  // Audit G-15: corporation-to-corporation train sales. `price` is a STRING
  // for the same big-int-safety reason every other `Uint128` field here is.
  | {
      BuyTrainFromCorporation: {
        game_id: number;
        buyer_protocol_id: number;
        seller_protocol_id: number;
        model_type: string;
        price: string;
      };
    }
  | { AcceptTrainOffer: { game_id: number; offer_id: number } }
  | { RejectTrainOffer: { game_id: number; offer_id: number } }
  | { RescindTrainOffer: { game_id: number; offer_id: number } }
  | {
      BuyStock: {
        game_id: number;
        protocol_id: number;
        source: "Ipo" | "Bank";
        par_value: string | null;
        /** Design note #712: HOW MANY CERTIFICATES, so a Brown-zone pool multi-buy is ONE turn rather than
         *  several. It used to be several: `handleBuyShare` looped and dispatched N messages, and every
         *  `BuyStock` calls `advanceSeat` -- so buying three pool shares passed the turn three times and the
         *  second and third landed on whoever was next.
         *  OPTIONAL, and absent means one. Every existing log entry and every contract dispatch omits it, and
         *  a replay of an older room must keep meaning exactly what it meant when it was written. */
        quantity?: number;
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
  // Phase-Gated Corporate Purchase Protocol (`trading.rs` module doc #17): a
  // corporation buying a player-owned private company's wrapper into its own
  // treasury, once Phase 3 has launched. `price` is a string for the same
  // big-int-safety reason as every other `Uint128` field here.
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
  // STRUCTURAL FIX: `orientation` is a required, explicit, player-chosen field
  // (mirroring `msg.rs`'s `ExecuteMsg::LayTile`). A prior contract version
  // auto-picked the lowest legal rotation server-side and took no `orientation`
  // input at all, silently removing a real 1830 strategic choice -- which
  // direction a route extends. `TileSelectionPopup.tsx` is the only caller and
  // always sends the player's actual selection.
  | {
      LayTile: {
        game_id: number;
        protocol_id: number;
        q: number;
        r: number;
        tile_id: number;
        orientation: number;
        /** Design note #776: THIS LAY IS IN ADDITION TO THE ORDINARY ONE. Set only by the Champlain & St.
         *  Lawrence's power, whose lay is a bonus rather than a substitute -- reported as "using its power
         *  advanced the Lay Track subphase completely", because the sub-phase cursor ended the Track step on
         *  every `LayTile` alike and the cursor is what withdraws the controls.
         *  THE SHELL KNOWS WHICH BUTTON WAS PRESSED and now says so, rather than the reducer inferring it
         *  from the hex: a CONNECTED B-20 lay can legitimately be the corporation's ordinary placement, and
         *  a reducer that assumed otherwise would grant a free second tile in that case.
         *  OPTIONAL, and absent means ordinary (#712's rule for `quantity`) -- every entry already in a log
         *  omits it and must keep meaning what it meant when it was written.
         *  NOT FOR THE D&H, whose lay CONSUMES the placement; only its token is free (#548). */
        bonus_lay?: boolean;
      };
    }
  // Step 4.5 Batch 3, item 1: Manual Route Validation. `path` replaced the
  // deprecated `hex_path: string[]` -- see `RouteWaypointDto` for why a bare label
  // was not enough. Only `protocol_id`'s registered President may send this, and
  // it requires `BeginOperatingRound` to have populated the Operating Round
  // Corporation Turn Queue first.
  | {
      RunManualRoute: {
        game_id: number;
        protocol_id: number;
        path: RouteWaypointDto[];
        payout_strategy: PayoutStrategyDto;
      };
    }
  // Station Tokens. `city_index` is OPTIONAL and additive: a hex carrying two
  // separate cities (New York #54/#62, the OO tiles) needs it to be answerable at
  // all, while on a single-city hex the only valid value is `0`. Omitting the key
  // makes the contract resolve the lowest-indexed city with a free slot -- always
  // a legal placement rather than a rejection.
  | {
      PlaceStationToken: {
        game_id: number;
        protocol_id: number;
        q: number;
        r: number;
        city_index?: number;
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

/** Extends CosmWasm's default message registry with the full `x/authz` set used
 *  across the wallet/session-key layer: `MsgExec` (this file) and
 *  `MsgGrant`/`MsgRevoke` (WalletContext.tsx).
 *
 *  Neither client works without this -- a `SigningCosmWasmClient` built with the
 *  plain default registry throws "Unregistered type url" the moment it encodes
 *  any of these, and that only surfaces at broadcast time, not at connection
 *  time. Both signing clients MUST use this same factory rather than two
 *  independently-assembled registries, so the list cannot drift. */
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

/** Discards the cached session key. Callers should also broadcast a `MsgRevoke`
 *  (`WalletContext.tsx`'s `revokeSessionKey`) if the corresponding authz grant
 *  should stop working immediately -- clearing the cache alone only forgets the
 *  key locally. */
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
  /** Defaults to `DEVELOPER_FEE_GRANTER_ADDRESS`. Overridable per-call in case a
   *  different subsidy pool is ever wired up, but every gameplay tx should set
   *  *some* feeGranter -- the session key itself is never expected to hold JUNO to
   *  pay gas with. */
  feeGranter?: string;
  gasLimit?: string;
  gasFeeAmount?: Coin;
  memo?: string;
}

/** Executes a gameplay `ExecuteMsg` against the 18Cosmos contract, signed by the
 *  browser session key but authorized on behalf of `masterAddress` via
 *  `authz.MsgExec`, with gas covered by `feeGranter` (the developer subsidy tank)
 *  instead of the session key's own -- deliberately empty -- balance.
 *
 *  See design note #5 for why the inner `MsgExecuteContract` is manually
 *  protobuf-encoded before being wrapped as `Any`. */
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
    memo = `${APP_NAME} move`,
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

  // Unlike `innerAny` above, this OUTER message is passed to `signAndBroadcast` as
  // a plain typeUrl/value `EncodeObject` -- the extended registry encodes it
  // automatically. Only nested `Any` fields need pre-encoding by hand.
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
