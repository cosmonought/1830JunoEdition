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
  /* ==================================================================
      DESIGN NOTE 968: A TURN'S ROUTES ARE ONE MESSAGE
     ==================================================================
     REPORTED, from a live room: "B&O ran 3 trains. On a later turn, it ran 4 trains. In both cases, only 1
     train's revenue actually paid out."
     AND THE DISPATCH WAS N MESSAGES FOR ONE DECISION, which is what made the whole class possible. Each
     `RunManualRoute` is appended at `appliedIndexRef.current`, and the snapshot handler REASSIGNS that ref
     from the last action it can see -- so a snapshot carrying only the first append rewinds the cursor while
     the second and third are still in flight, and they land on an index already taken. `effectiveActions`
     keys on `index`, so entries that collide there stop being distinguishable.
     ONE MESSAGE MAKES THAT UNREACHABLE rather than better-guarded. There is one append, one index, one
     document and one reducer transition; no ordering, no cursor and no snapshot timing can drop a route,
     because there is nothing left to interleave.
     AND IT IS ALSO THE HONEST SHAPE. #941 already made the die ONE roll per turn on the aggregated revenue --
     the dispatch was the last surface still pretending a turn was several independent events. */
  "RunMultipleRoutes",
  /* Design note #1046: the Yellow Sign's mechanical half. Pure VGP/gameplay state like every entry here -- it
     deletes a train and moves virtual game points; it moves no real JUNO. */
  "YellowSignEvent",
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
        /** Design note #1204: WHICH PRIVATE POWER THIS LAY SPENT, if any -- `"dh-tile"` or `"csl-tile"`.
         *
         *  THE HEX CANNOT ANSWER THIS. A corporation may lay on F16 using the D&H's power or in spite of it,
         *  and the two have opposite consequences: one spends the power, the other FORFEITS it
         *  (`dhPowerState`: `forfeited = hexBuilt && !layUsed`). #817 is the report from getting it wrong --
         *  "I placed a tile that was not the F16 one, and it seems the DH power was consumed."
         *  SO IT IS A CHOICE, AND #550 PUTS CHOICES IN THE LOG. `PlaceHomeStation` already carries
         *  `kind: "dh"` for the same reason; this is its twin on the lay.
         *  OPTIONAL, per #232: absent means "this build did not say", which is every log written before the
         *  note -- not "no power was used". */
        ability_key?: string;
        /** Design note #824: WHERE THE TOKEN GOES, and A FIELD THE CONTRACT DOES NOT HAVE YET.
         *
         *  `tokenMigration.ts` #1 declared the destination un-sendable and preserved the index instead: "a UI
         *  letting the president pick would collect an answer it cannot send and the contract would apply its
         *  own rule regardless -- the worst of the three outcomes, because the player would have been asked."
         *  That reasoning was right and the conclusion has an expiry: the answer becomes sendable the moment
         *  the message carries it.
         *
         *  ONLY MEANINGFUL ON AN UNLAID PREPRINTED DOUBLE CITY, where nothing on the cardboard distinguishes
         *  the two cities and the physical game resolves it by lifting the marker off before laying. Every
         *  other upgrade preserves the index and omits this, so a route that never touches Dunkirk & Buffalo
         *  or New York is byte-identical to what this app has always sent -- the same containment #808's
         *  `bypass` has.
         *
         *  `pathfinding.rs` / `hexmap.rs` will need the same field before manual lays can be validated on
         *  chain. Flagged loudly rather than added quietly, as `PrivateTradePanel.tsx` #0 flags its own gap. */
        token_city?: number;
        /* ==================================================================
            DESIGN NOTE 880: ONE INDEX CANNOT SEAT TWO TOKENS
           ==================================================================
           ASKED: "If a tile has multiple stations and a corporation upgrades it, it is necessary that all the
           stations maintain their connectivity, not just the one whose corporation is upgrading."
           EXACTLY, AND `token_city` ABOVE CANNOT EXPRESS IT. It is a single number applied to every token on
           the hex, which is right for the one case #824 built it for -- ERIE's home, where in practice only
           one token stands -- and wrong the moment two corporations share an OO hex: both would be stacked
           into the same city. Its absence is worse still, because "unchanged" is what an ordinary upgrade
           sends, and unchanged is precisely what a token that must MOVE cities cannot be.
           SO THE MESSAGE CARRIES A MAP: `[company_id, city_index]` per token standing on the hex, derived
           from connectivity (#878) rather than chosen. `token_city` is kept and still read, because logs
           written before this exist and "the log is the game" (#522) -- a replay of an old lay must land
           where it landed then.
           THE RUST SIDE STILL NEEDS THIS. `pathfinding.rs` / `hexmap.rs` carry neither field; the sandbox
           reducer is the authority today and this is flagged in the same breath as `token_city` above and
           #808's `bypass`. */
        token_cities?: ReadonlyArray<readonly [number, number]>;
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
  /* Design note #968: the whole turn's running, atomically. `routes` is an array of the same waypoint lists
   *  `RunManualRoute` carries one of -- deliberately the same shape, so the reducer's pricing is one function
   *  applied N times rather than a second implementation for the bulk case.
   *  `RunManualRoute` SURVIVES and is not deprecated away: every game already logged contains them, and #902's
   *  rule is that an old log replays to the game it was played as. The reducer keeps both arms. */
  /* ==================================================================
      DESIGN NOTE 1046: THE EASTER EGG BECOMES AN ACTION
     ==================================================================
     BATCHES 46 AND 47 KEPT IT COSMETIC, so it could be derived in the shell and no action was needed. This
     one DELETES A TRAIN AND MOVES MONEY, and board state in this app is what the reducer writes while
     replaying the log -- a shell that mutated a corporation would change one browser's board, be lost on
     reload, and be unreachable by Undo.
     THE DECISION STAYS IN THE SHELL AND THE CONSEQUENCE MOVES HERE, which is how every other action already
     works: the acting client decides, dispatches, and everybody replays the recorded decision. That also
     removes #1044's determinism burden entirely -- the roll no longer has to be reproducible on every client,
     because only one client ever makes it and the answer is in the log.
     THE FIGURES ARE CARRIED, NOT RECOMPUTED. `train` and `cash` are what the acting client decided; a reducer
     that re-derived them from the fleet would read a fleet that later actions had already changed. */
  | {
      YellowSignEvent: {
        game_id: number;
        protocol_id: number;
        /* Design note #1092: THREE STAGES ON THE WIRE. "fog" takes the gifted train back, an OR set after its
         clock started -- the third and last thing the Yellow Sign does to a corporation. */
      stage: "mark" | "carcosa" | "fog";
        /** Stage 1: the model taken. Stage 2: the model gifted. */
        model: string;
        /** Stage 1 only: the treasury award, already halved and floored. */
        cash?: string;
      };
    }
  | {
      RunMultipleRoutes: {
        game_id: number;
        protocol_id: number;
        routes: RouteWaypointDto[][];
        /** Design note #1020: which train ran `routes[i]`, for the narration.
         *
         *  OPTIONAL AND PARALLEL, not folded into the route element. Every action already in a saved log
         *  carries `routes` as an array of paths and this game is rebuilt by replaying that log, so changing
         *  the element type would make historical entries unreadable. Absent means "this log does not say",
         *  which is #232's rule and the case the narration falls back for. */
        trains?: readonly string[];
        /** Design note #1031: WHICH TRAIN OF THE FLEET, where `trains[i]` says only which MODEL.
         *
         *  THE MODEL CANNOT IDENTIFY A TRAIN. A corporation may own two 5-trains, and #1020 put the model on
         *  the wire for a sentence -- "ran a $200 route with a 5-train" -- where either 5-train makes the
         *  sentence true. A per-train figure joined back to a chip cannot use it: the two chips would both
         *  match the first entry.
         *
         *  SO THE FLEET INDEX RIDES ALONGSIDE, on the same parallel-array terms and for the same reason
         *  #1020 chose them: `train_indices[i]` describes `routes[i]`, the element type of `routes` does not
         *  change, and every log written before this field replays exactly as it did. Absent is #232's "the
         *  log does not say", which is what the chip's presence and pricing fallbacks are for. */
        train_indices?: readonly number[];
        /** ==================================================================
         *   DESIGN NOTE 1051: THE DIE THIS TURN ACTUALLY ROLLED
         *  ==================================================================
         *
         * THE FACE USED TO BE COMPUTED, from an FNV hash of (round, sub-round, corporation) -- which meant it
         * was the same in every game ever played, and a player with the browser console open could read the
         * whole game's table off a function that ships to their machine. See `gameVariants.ts` #1051 for the
         * measurement and for why the hash was there in the first place.
         *
         * SO THE ROLL TRAVELS INSTEAD OF BEING DERIVED. The acting client draws a uniform 32-bit integer when
         * it dispatches the run and writes it here; every other client reads it back out of the log, so the
         * table still agrees about the figure without anybody being able to predict it.
         *
         * `revenue_turn` IS THE KEY, NOT DECORATION. After an undo the run is re-dispatched, and the new
         * dispatch must find the earlier draw rather than take a fresh one -- otherwise undo becomes a
         * re-roll, which is the one thing this feature was explicitly required not to be. The scan happens
         * over the raw log (`turnSeed.ts` #1051), where `protocol_id` identifies the corporation but nothing
         * identifies the ROUND: that lives in the state, which a log scan does not have. So the turn says its
         * own name.
         *
         * OPTIONAL AND ADDITIVE, on `trains`' and `train_indices`' exact terms. Every entry already in a saved
         * log lacks both, and #232's rule covers the absence: a log that does not say what it rolled is a log
         * that does not say, and the reducer falls back to `legacyTurnSeed` so historical games still rebuild
         * to the board they were played on rather than throwing or drawing fresh numbers per client. */
        revenue_seed?: number;
        /** The turn `revenue_seed` belongs to -- see above. `turnSeed.ts`'s `turnSeedKey` builds it. */
        revenue_turn?: string;
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
