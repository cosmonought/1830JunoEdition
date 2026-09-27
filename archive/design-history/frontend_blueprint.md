# 18Cosmos Frontend Blueprint: React / TypeScript Interface Layer

This document maps out the client-side architecture for 18Cosmos: wallet and
session-key management, background transaction routing through Cosmos SDK
`authz` + `feegrant`, a 2D Canvas rendering layer for the hex map and stock
market grid, and the UX state machine tying it all together.

It assumes the finished, warning-free contract described in `src/`: the
`ExecuteMsg` variants in `msg.rs` (`BuyStock`, `SellStock`, `LayTile`,
`BuyHardwareFromPool`, `DeclareDividends`, `UndoLastAction`, etc.) and the
`QueryMsg` variants (`GetGameState`, `GetMarketGrid`, `GetMapGrid`,
`GetMapGridMarkdown`) and their response shapes exactly as defined there.

---

## 0. Why a session key at all?

1830-style games are chatty: a single Operating Round can involve a dozen or
more transactions per player (lay tile, buy Hardware, declare dividends,
trade stock, pass). Prompting Keplr's popup for every single one of those
would make the game unplayable. The standard pattern -- and the one this
blueprint follows -- is:

- The player's **master wallet** (Keplr) signs exactly two kinds of things:
  the initial `authz.MsgGrant` that authorizes a throwaway browser keypair to
  act on the master wallet's behalf against this one contract, and any
  transaction that moves real JUNO in or out of the lobby pool
  (`CreateGameRoom`, `JoinGameRoom`, `EndGameAndDistribute`'s payout claim).
- An **ephemeral session key**, generated in the browser and never seen by
  Keplr, signs every in-game gameplay message (`BuyStock`, `LayTile`,
  `DeclareDividends`, `PassTurn`, ...) silently, in the background, wrapped
  in an `authz.v1beta1.MsgExec`.
- A **developer `FeeGrant` address** pays the gas for every one of those
  session-key transactions, so the session key -- which holds zero JUNO --
  never needs to be funded.

The critical consequence, used throughout Section 2: when `MsgExec` re-
dispatches `MsgExecuteContract`, the contract's `info.sender` is the
**granter** (the player's master wallet address), not the session key. This
contract's turn-gating (`ensure_active_player`, President checks on
`LayTile`/`BuyHardwareFromPool`) already keys off `player_addresses` /
`PROTOCOL_PRESIDENT`, both of which store master wallet addresses -- so no
contract changes are needed to support this pattern. The session key is
purely a client + chain-level (`x/authz`, `x/feegrant`) concern.

---

## 1. React Context Providers

### 1.1 `WalletProvider`

Owns the single source of truth for the master Keplr connection: the
connected `Addr`, the `OfflineSigner`, and a `SigningCosmWasmClient` used
only for the small set of real-JUNO / grant-issuing transactions that must
be signed by Keplr directly.

```tsx
// src/providers/WalletProvider.tsx
import React, { createContext, useCallback, useContext, useMemo, useState } from "react";
import { SigningCosmWasmClient } from "@cosmjs/cosmwasm-stargate";
import { GasPrice } from "@cosmjs/stargate";
import type { OfflineSigner } from "@cosmjs/proto-signing";

const JUNO_CHAIN_ID = "juno-1";
const JUNO_RPC_ENDPOINT = "https://rpc-juno.itastakers.com"; // swap per environment

interface WalletContextValue {
  status: "disconnected" | "connecting" | "connected" | "error";
  address: string | null;
  signer: OfflineSigner | null;
  signingClient: SigningCosmWasmClient | null;
  error: string | null;
  connect: () => Promise<void>;
  disconnect: () => void;
}

const WalletContext = createContext<WalletContextValue | undefined>(undefined);

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<WalletContextValue["status"]>("disconnected");
  const [address, setAddress] = useState<string | null>(null);
  const [signer, setSigner] = useState<OfflineSigner | null>(null);
  const [signingClient, setSigningClient] = useState<SigningCosmWasmClient | null>(null);
  const [error, setError] = useState<string | null>(null);

  const connect = useCallback(async () => {
    setStatus("connecting");
    setError(null);
    try {
      if (!window.keplr) throw new Error("Keplr extension not found.");
      await window.keplr.enable(JUNO_CHAIN_ID);

      const offlineSigner = window.keplr.getOfflineSigner(JUNO_CHAIN_ID);
      const accounts = await offlineSigner.getAccounts();
      if (accounts.length === 0) throw new Error("Keplr returned no accounts.");

      const client = await SigningCosmWasmClient.connectWithSigner(
        JUNO_RPC_ENDPOINT,
        offlineSigner,
        { gasPrice: GasPrice.fromString("0.025ujuno") },
      );

      setSigner(offlineSigner);
      setSigningClient(client);
      setAddress(accounts[0].address);
      setStatus("connected");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown wallet error.");
      setStatus("error");
    }
  }, []);

  const disconnect = useCallback(() => {
    setSigner(null);
    setSigningClient(null);
    setAddress(null);
    setStatus("disconnected");
  }, []);

  const value = useMemo(
    () => ({ status, address, signer, signingClient, error, connect, disconnect }),
    [status, address, signer, signingClient, error, connect, disconnect],
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletContextValue {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error("useWallet must be used within a WalletProvider");
  return ctx;
}
```

`WalletProvider` is the outermost provider in the tree (`GameSessionProvider`
below reads `address` from it, since the session key's `authz` grant is
scoped to this specific granter address).

### 1.2 `GameSessionProvider`

Owns the ephemeral session keypair: generates it once per browser session,
caches it (see the storage note below), builds a lightweight
`SigningCosmWasmClient` wired to a `FeeGrant`-aware fee payer, and exposes
the `authz`-wrapped executor that Section 2 builds on.

```tsx
// src/providers/GameSessionProvider.tsx
import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import { DirectSecp256k1Wallet } from "@cosmjs/proto-signing";
import { SigningCosmWasmClient } from "@cosmjs/cosmwasm-stargate";
import { GasPrice } from "@cosmjs/stargate";
import { fromHex, toHex } from "@cosmjs/encoding";
import { useWallet } from "./WalletProvider";

const JUNO_RPC_ENDPOINT = "https://rpc-juno.itastakers.com";
const JUNO_PREFIX = "juno";

// Session keys never move real JUNO, so a plain, unguarded Secp256k1 key
// is an acceptable risk tradeoff -- worst case, an attacker who steals it
// can only spend whatever authz scope the player granted (see Section 2)
// and whatever the FeeGrant address is willing to pay in gas.
const SESSION_STORAGE_KEY = "18cosmos.session_key.v1";

interface GameSessionContextValue {
  status: "idle" | "ready" | "error";
  sessionAddress: string | null;
  sessionClient: SigningCosmWasmClient | null;
  isGrantActive: boolean; // has the master wallet issued the authz grant this session key needs?
  setGrantActive: (active: boolean) => void;
}

const GameSessionContext = createContext<GameSessionContextValue | undefined>(undefined);

export function GameSessionProvider({ children }: { children: React.ReactNode }) {
  const { address: masterAddress } = useWallet();
  const [status, setStatus] = useState<GameSessionContextValue["status"]>("idle");
  const [sessionAddress, setSessionAddress] = useState<string | null>(null);
  const [sessionClient, setSessionClient] = useState<SigningCosmWasmClient | null>(null);
  const [isGrantActive, setGrantActive] = useState(false);

  useEffect(() => {
    if (!masterAddress) return;

    let cancelled = false;
    (async () => {
      // sessionStorage, deliberately -- NOT localStorage. The key should
      // not survive across browser restarts or be readable by other tabs
      // once this tab closes; a fresh session key per browser session is
      // an intentional blast-radius limiter, not an oversight.
      const cached = sessionStorage.getItem(SESSION_STORAGE_KEY);
      const privkeyBytes = cached ? fromHex(cached) : crypto.getRandomValues(new Uint8Array(32));
      if (!cached) sessionStorage.setItem(SESSION_STORAGE_KEY, toHex(privkeyBytes));

      const wallet = await DirectSecp256k1Wallet.fromKey(privkeyBytes, JUNO_PREFIX);
      const [account] = await wallet.getAccounts();

      // No gasPrice needed for signing math here (the FeeGrant payer's
      // account covers the fee at broadcast time, see Section 2), but
      // CosmJS still wants a GasPrice instance to construct the client.
      const client = await SigningCosmWasmClient.connectWithSigner(
        JUNO_RPC_ENDPOINT,
        wallet,
        { gasPrice: GasPrice.fromString("0.025ujuno") },
      );

      if (cancelled) return;
      setSessionAddress(account.address);
      setSessionClient(client);
      setStatus("ready");
    })().catch(() => setStatus("error"));

    return () => {
      cancelled = true;
    };
  }, [masterAddress]);

  const value = useMemo(
    () => ({ status, sessionAddress, sessionClient, isGrantActive, setGrantActive }),
    [status, sessionAddress, sessionClient, isGrantActive],
  );

  return <GameSessionContext.Provider value={value}>{children}</GameSessionContext.Provider>;
}

export function useGameSession(): GameSessionContextValue {
  const ctx = useContext(GameSessionContext);
  if (!ctx) throw new Error("useGameSession must be used within a GameSessionProvider");
  return ctx;
}
```

**Design gap to flag:** `isGrantActive` is a client-side flag the app must
set only after confirming, on-chain, that the current `sessionAddress` has
an active `authz` grant from `masterAddress` scoped to this contract (query
`cosmos.authz.v1beta1.Query/GranteeGrants`, or simply attempt the first
`MsgExec` and catch the `authorization not found` error). This provider
does not perform that check itself -- wire it up in the app shell before
trusting `isGrantActive`, otherwise the UI can show "ready" while the first
background transaction is guaranteed to fail.

---

## 2. Background Transaction Routing: `authz.MsgExec`

### 2.1 One-time setup: the grant and the fee allowance

Both of these are signed by Keplr (the master wallet), not the session key,
and only need to happen once per session key (or on renewal/expiry):

```tsx
// src/authz/setupSessionGrants.ts
import { SigningCosmWasmClient } from "@cosmjs/cosmwasm-stargate";
import { GenericAuthorization } from "cosmjs-types/cosmos/authz/v1beta1/authz";
import { MsgGrant } from "cosmjs-types/cosmos/authz/v1beta1/tx";
import type { Any } from "cosmjs-types/google/protobuf/any";

const CONTRACT_ADDRESS = "juno1...eighteencosmos..."; // deployed contract
const GRANT_DURATION_SECONDS = 60 * 60 * 6; // 6 hours, renew as needed

/** Signed by Keplr. Authorizes `sessionAddress` to execute `MsgExecuteContract`
 *  against our contract, on the master wallet's behalf, until expiration. */
export async function grantSessionKeyExecuteAuthority(
  masterClient: SigningCosmWasmClient,
  masterAddress: string,
  sessionAddress: string,
): Promise<void> {
  const expiration = Math.floor(Date.now() / 1000) + GRANT_DURATION_SECONDS;

  // GenericAuthorization scopes by Msg type URL only (any MsgExecuteContract,
  // to any contract). For production, prefer authz's
  // ContractExecutionAuthorization, which cw-restricts the grant to this one
  // CONTRACT_ADDRESS and (optionally) an allow-list of message keys
  // ("buy_stock", "lay_tile", ...) -- see the design-gap note below.
  const authorizationValue = GenericAuthorization.encode(
    GenericAuthorization.fromPartial({ msg: "/cosmwasm.wasm.v1.MsgExecuteContract" }),
  ).finish();

  const grantMsg = {
    typeUrl: "/cosmos.authz.v1beta1.MsgGrant",
    value: MsgGrant.fromPartial({
      granter: masterAddress,
      grantee: sessionAddress,
      grant: {
        authorization: {
          typeUrl: "/cosmos.authz.v1beta1.GenericAuthorization",
          value: authorizationValue,
        } as Any,
        expiration: { seconds: BigInt(expiration), nanos: 0 },
      },
    }),
  };

  await masterClient.signAndBroadcast(masterAddress, [grantMsg], "auto", "18Cosmos session grant");
}
```

**Design gap to flag:** the sketch above uses `GenericAuthorization` for
brevity. It authorizes the session key to send *any* `MsgExecuteContract` to
*any* contract on behalf of the player -- broader than this game needs.
Before mainnet, switch to `ContractExecutionAuthorization`
(`cosmwasm.wasm.v1`), which lets the grant name this one `CONTRACT_ADDRESS`
and even restrict it to specific execute message keys, and add spend-limit
tracking if `authz` ever fronts anything besides gas.

The developer-side `FeeGrant` (issued once, off-chain, by a backend service
holding the developer's key -- never in client code) looks like:

```ts
// backend / ops script, NOT shipped to the browser
import { MsgGrantAllowance } from "cosmjs-types/cosmos/feegrant/v1beta1/tx";
import { BasicAllowance } from "cosmjs-types/cosmos/feegrant/v1beta1/feegrant";

const allowanceMsg = {
  typeUrl: "/cosmos.feegrant.v1beta1.MsgGrantAllowance",
  value: MsgGrantAllowance.fromPartial({
    granter: DEVELOPER_FEE_PAYER_ADDRESS,
    grantee: sessionAddress, // the fee payer covers THIS session key's gas
    allowance: {
      typeUrl: "/cosmos.feegrant.v1beta1.BasicAllowance",
      value: BasicAllowance.encode(
        BasicAllowance.fromPartial({
          spendLimit: [{ denom: "ujuno", amount: "500000" }], // e.g. 0.5 JUNO gas budget
          expiration: { seconds: BigInt(Math.floor(Date.now() / 1000) + 21_600), nanos: 0 },
        }),
      ).finish(),
    },
  }),
};
```

### 2.2 Routing an in-game message through `MsgExec`

Every gameplay action (`BuyStock`, `LayTile`, `SellStock`, `DeclareDividends`,
`PassTurn`, ...) goes through one shared executor. The session key signs; the
`FeeGrant` address (passed as `granter` on the fee, not the tx's `signer`)
pays.

```tsx
// src/authz/execViaSessionKey.ts
import { SigningCosmWasmClient } from "@cosmjs/cosmwasm-stargate";
import { MsgExec } from "cosmjs-types/cosmos/authz/v1beta1/tx";
import { MsgExecuteContract } from "cosmjs-types/cosmwasm/wasm/v1/tx";
import { toUtf8 } from "@cosmjs/encoding";
import type { StdFee } from "@cosmjs/stargate";
import type { ExecuteMsg } from "../types/contract"; // mirrors msg.rs's ExecuteMsg exactly

const CONTRACT_ADDRESS = "juno1...eighteencosmos...";
const DEVELOPER_FEE_PAYER_ADDRESS = "juno1...devfeegrantaddress...";

/**
 * Executes `msg` against the 18Cosmos contract, signed by the browser
 * session key but authorized on behalf of `masterAddress` via authz, with
 * gas covered by the developer's FeeGrant -- never the session key's own
 * (empty) balance.
 *
 * IMPORTANT: because MsgExec re-dispatches the inner MsgExecuteContract
 * with `info.sender == masterAddress`, every turn/ownership check inside
 * the contract (e.g. hexmap::execute_lay_tile's President check,
 * trading::ensure_active_player) evaluates against the PLAYER's address,
 * exactly as if they'd signed it themselves.
 */
export async function execViaSessionKey(
  sessionClient: SigningCosmWasmClient,
  sessionAddress: string,
  masterAddress: string,
  msg: ExecuteMsg,
  funds: { denom: string; amount: string }[] = [],
): Promise<void> {
  const innerMsg = {
    typeUrl: "/cosmwasm.wasm.v1.MsgExecuteContract",
    value: MsgExecuteContract.fromPartial({
      sender: masterAddress, // the GRANTER -- what the contract will see as info.sender
      contract: CONTRACT_ADDRESS,
      msg: toUtf8(JSON.stringify(msg)),
      funds,
    }),
  };

  const execMsg = {
    typeUrl: "/cosmos.authz.v1beta1.MsgExec",
    value: MsgExec.fromPartial({
      grantee: sessionAddress, // the SIGNER of this outer tx
      msgs: [innerMsg as any], // cosmjs-types Any-encodes registered msgs automatically
    }),
  };

  const fee: StdFee = {
    amount: [{ denom: "ujuno", amount: "5000" }],
    gas: "300000",
    granter: DEVELOPER_FEE_PAYER_ADDRESS, // <-- this is the FeeGrant routing
  };

  const result = await sessionClient.signAndBroadcast(sessionAddress, [execMsg], fee, "18Cosmos move");
  if (result.code !== 0) {
    throw new Error(`Transaction failed (code ${result.code}): ${result.rawLog}`);
  }
}
```

Call sites become one-liners, e.g. buying a certificate:

```ts
await execViaSessionKey(sessionClient, sessionAddress, masterAddress, {
  buy_stock: {
    game_id: gameId,
    protocol_id: protocolId,
    source: "ipo",
    par_value: parValue ?? null,
  },
});
```

and laying track:

```ts
await execViaSessionKey(sessionClient, sessionAddress, masterAddress, {
  lay_tile: { game_id: gameId, protocol_id: protocolId, q, r, tile_id: tileId },
});
```

Both mirror `ExecuteMsg`'s Rust field names exactly (snake_case, matching
serde's default derive, no `#[serde(rename_all)]` override anywhere in
`msg.rs`) -- the TypeScript `ExecuteMsg` union in `src/types/contract.ts`
should be hand-kept (or `ts-codegen`-generated from the contract's schema)
to stay in lockstep with `msg.rs`.

---

## 3. 2D Canvas Layer Mapping

### 3.1 Component structure

```
<GameCanvas>
├── useMapGridQuery(gameId)      // wraps QueryMsg::GetMapGrid
├── useMarketGridQuery(gameId)   // wraps QueryMsg::GetMarketGrid
├── <canvas ref={mapCanvasRef}>       -- layer 1: hex track board
├── <canvas ref={marketCanvasRef}>    -- layer 2: 2D stock matrix
└── <canvas ref={overlayCanvasRef}>   -- layer 3: hover/selection UI, always on top
```

Three stacked `<canvas>` elements (absolutely positioned, same
width/height) rather than one shared canvas: the map and market boards
redraw only when their query data changes, while the overlay (hover
highlight, selected-tile preview) redraws every pointer-move frame. Keeping
them separate avoids re-rasterizing the whole board on every mouse
movement.

```tsx
// src/canvas/GameCanvas.tsx
import React, { useEffect, useRef } from "react";
import { useMapGridQuery } from "../queries/useMapGridQuery";
import { useMarketGridQuery } from "../queries/useMarketGridQuery";
import { HexGridRenderer } from "./HexGridRenderer";
import { StockMarketRenderer } from "./StockMarketRenderer";

export function GameCanvas({ gameId }: { gameId: number }) {
  const mapCanvasRef = useRef<HTMLCanvasElement>(null);
  const marketCanvasRef = useRef<HTMLCanvasElement>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);

  const { data: mapGrid } = useMapGridQuery(gameId);       // MapGridResponse
  const { data: marketGrid } = useMarketGridQuery(gameId); // MarketGridResponse

  useEffect(() => {
    if (!mapCanvasRef.current || !mapGrid) return;
    const renderer = new HexGridRenderer(mapCanvasRef.current);
    renderer.draw(mapGrid.tiles); // MapTileEntry[]: { q, r, tile_id, orientation, landmark }
  }, [mapGrid]);

  useEffect(() => {
    if (!marketCanvasRef.current || !marketGrid) return;
    const renderer = new StockMarketRenderer(marketCanvasRef.current);
    renderer.draw(marketGrid.positions); // MarketPositionEntry[]: { company_id, ticker, x, y, price }
  }, [marketGrid]);

  return (
    <div className="game-canvas-stack">
      <canvas ref={mapCanvasRef} width={1200} height={900} className="layer layer-map" />
      <canvas ref={marketCanvasRef} width={1200} height={900} className="layer layer-market" />
      <canvas ref={overlayCanvasRef} width={1200} height={900} className="layer layer-overlay" />
    </div>
  );
}
```

### 3.2 `HexGridRenderer`: axial coordinates to pixels

`MapTileEntry.q`/`.r` are the contract's axial hex coordinates (see
`hexmap.rs`). The frontend owns real hex-to-pixel geometry independently of
the contract's own `render_ascii_grid` -- that function's doc comment in
`query.rs` is explicit that its square-grid ASCII sketch is "an
approximation, not true hex tiling," good only for eyeballing text output,
never meant to be the geometry source for a visual renderer.

```ts
// src/canvas/hexMath.ts
export const HEX_SIZE = 40; // pixel radius of one hex

/** Pointy-top axial (q, r) -> pixel center, per the standard axial layout. */
export function axialToPixel(q: number, r: number): { x: number; y: number } {
  const x = HEX_SIZE * (Math.sqrt(3) * q + (Math.sqrt(3) / 2) * r);
  const y = HEX_SIZE * (1.5 * r);
  return { x, y };
}

export function hexCorner(center: { x: number; y: number }, index: number) {
  const angle = (Math.PI / 180) * (60 * index - 30);
  return { x: center.x + HEX_SIZE * Math.cos(angle), y: center.y + HEX_SIZE * Math.sin(angle) };
}
```

```ts
// src/canvas/HexGridRenderer.ts
import { axialToPixel, hexCorner } from "./hexMath";
import type { MapTileEntry } from "../types/contract";

const LANDMARK_COLORS: Record<string, string> = {
  "New York": "#c0392b",
  Boston: "#2980b9",
  Baltimore: "#27ae60",
};

export class HexGridRenderer {
  private ctx: CanvasRenderingContext2D;

  constructor(private canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas context unavailable.");
    this.ctx = ctx;
  }

  draw(tiles: MapTileEntry[]) {
    const { ctx, canvas } = this;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.translate(canvas.width / 2, canvas.height / 2); // origin at board center

    for (const tile of tiles) {
      const center = axialToPixel(tile.q, tile.r);
      this.drawHex(center, tile);
    }

    ctx.restore();
  }

  private drawHex(center: { x: number; y: number }, tile: MapTileEntry) {
    const { ctx } = this;
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const corner = hexCorner(center, i);
      i === 0 ? ctx.moveTo(corner.x, corner.y) : ctx.lineTo(corner.x, corner.y);
    }
    ctx.closePath();
    ctx.fillStyle = tile.landmark ? (LANDMARK_COLORS[tile.landmark] ?? "#7f8c8d") : "#f4e9d8";
    ctx.fill();
    ctx.strokeStyle = "#333";
    ctx.stroke();

    // Track/edge connections would be drawn here, derived from tile_id +
    // orientation against the same TILE_CATALOG connection bitmask the
    // contract uses in hexmap.rs -- port that table to TypeScript so the
    // frontend's edge lines always agree with the on-chain legal-connection
    // rules, rather than re-deriving it visually by trial and error.

    ctx.fillStyle = "#111";
    ctx.font = "12px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(tile.landmark ?? `#${tile.tile_id}`, center.x, center.y);
  }
}
```

### 3.3 `StockMarketRenderer`: the 2D stock matrix

`MarketPositionEntry.x`/`.y` (see `msg.rs`) are already plain grid cell
indices (not axial hex coordinates), so this renderer is a simpler uniform
grid:

```ts
// src/canvas/StockMarketRenderer.ts
import type { MarketPositionEntry } from "../types/contract";

const CELL_SIZE = 64;

export class StockMarketRenderer {
  private ctx: CanvasRenderingContext2D;

  constructor(private canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas context unavailable.");
    this.ctx = ctx;
  }

  draw(positions: MarketPositionEntry[]) {
    const { ctx, canvas } = this;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Group by cell so multiple companies sharing a price cell (a very
    // normal 1830 occurrence) stack legibly instead of overlapping.
    const byCell = new Map<string, MarketPositionEntry[]>();
    for (const pos of positions) {
      const key = `${pos.x},${pos.y}`;
      byCell.set(key, [...(byCell.get(key) ?? []), pos]);
    }

    for (const [key, entries] of byCell) {
      const [gx, gy] = key.split(",").map(Number);
      const cx = gx * CELL_SIZE;
      const cy = gy * CELL_SIZE;

      ctx.strokeStyle = "#ccc";
      ctx.strokeRect(cx, cy, CELL_SIZE, CELL_SIZE);

      entries.forEach((entry, i) => {
        const offsetY = cy + 16 + i * 14;
        ctx.fillStyle = entry.price === null ? "#999" : "#111"; // null: see MarketGridResponse note
        ctx.font = "11px sans-serif";
        const priceLabel = entry.price !== null ? entry.price : "?";
        ctx.fillText(`${entry.ticker} $${priceLabel}`, cx + 4, offsetY);
      });
    }
  }
}
```

**Design gap to flag:** `MarketPositionEntry.price` is `Option<Uint128>` in
Rust and therefore `string | null` over JSON (CosmJS deserializes
`Uint128` as a decimal string, not a `bigint` -- convert with
`BigInt(entry.price)` or a decimal library before any arithmetic, never
`Number()`, to avoid precision loss on large VGP amounts). The renderer
above treats `null` as "unresolved," matching `query.rs`'s own note that
this is only a defensive case; it should never actually occur post-
`contract::instantiate`, but the frontend should not assume that invariant
either.

---

## 4. User Experience States

A single top-level state machine (sketched here with a `useReducer`-style
discriminated union; swap in XState if the transition count grows) drives
the whole game screen. It's deliberately decoupled from the two
provider-level `status` fields in Section 1 -- those describe wallet/session
plumbing, this describes what the *player* is looking at.

```ts
// src/state/gameUiState.ts
export type GameUiState =
  | { kind: "connecting_wallet" }
  | { kind: "awaiting_session_grant" } // authz MsgGrant not yet confirmed on-chain
  | { kind: "loading_game_state"; gameId: number }
  | { kind: "idle"; gameId: number } // it's someone's turn; UI is interactive
  | { kind: "submitting_action"; gameId: number; description: string } // optimistic, tx in flight
  | { kind: "rolling_back"; gameId: number; reason: string } // see 4.2
  | { kind: "action_failed"; gameId: number; error: string }
  | { kind: "game_over"; gameId: number } // see 4.3
  | { kind: "fatal_error"; error: string };
```

### 4.1 Loading states

```
connecting_wallet          Keplr popup open / awaiting approval
  → awaiting_session_grant Session key generated, MsgGrant broadcasting/confirming
    → loading_game_state   authz ready; fetching GetGameState + GetMapGrid + GetMarketGrid
      → idle                All three queries resolved; board is interactive
```

Each transition is driven by the corresponding provider status
(`useWallet().status`, `useGameSession().isGrantActive`) plus whether the
three game-state queries (react-query or equivalent) have resolved. Treat
`GetGameState`, `GetMapGrid`, and `GetMarketGrid` as three independent
queries polled/refetched together (see 4.2) rather than one combined call --
the contract exposes them as three separate `QueryMsg` variants for a
reason: a slow map render shouldn't block cash/ownership numbers from
appearing, and vice versa.

### 4.2 Handling on-chain rollback (`UndoLastAction`)

`ExecuteMsg::UndoLastAction` (see `msg.rs`) is available to *any* registered
player, not just whoever made the move -- so the frontend must treat every
piece of local game state as potentially stale at any time, not only right
after its own transactions. The contract's own approach is instructive:
`gamelog::execute_undo_last_action` doesn't compute an inverse operation, it
resets to genesis and replays `GAME_LOG` minus its last entry. The frontend
should mirror that "recompute from the source of truth" philosophy rather
than trying to hand-write inverse UI patches:

```ts
// src/state/useRollbackAwareGameState.ts
// Sketch: whenever ANY player's action (including this browser's own)
// lands, or the poll interval ticks, re-fetch and diff GameStateResponse
// against the currently-rendered snapshot. A shrinking `active_operating_order`,
// a reverted `active_player_index`, or a `GAME_LOG` sequence number that
// went DOWN are all signals an undo just happened.
export function detectRollback(previous: GameStateResponse, next: GameStateResponse): boolean {
  return (
    next.consecutive_passes < previous.consecutive_passes ||
    next.active_player_index !== previous.active_player_index && wasOptimisticallyAdvanced(previous) ||
    JSON.stringify(next.public_companies) !== JSON.stringify(previous.public_companies) &&
      !matchesLastSubmittedAction(next)
  );
}
```

UX-wise: when a rollback is detected, the UI moves to `rolling_back`,
briefly disables input, shows a toast ("Another player undid the last
action -- board updated"), discards any locally-held optimistic state, and
re-renders the Canvas layers directly from the freshly re-fetched
`GetMapGrid`/`GetMarketGrid`/`GetGameState` responses -- never by trying to
apply a computed "inverse" of whatever the local optimistic update was.

**Design gap to flag:** the contract has no push/event-subscription
mechanism today (no CosmWasm event the frontend can subscribe to over a
Tendermint WebSocket that specifically flags "an undo just happened" versus
any other state-changing tx). The sketch above relies on polling
`GetGameState` on an interval (and after every locally-submitted action) and
diffing. A cleaner solution -- subscribing to `NewBlock`/`Tx` events filtered
by `wasm._contract_address` and `wasm.action = 'undo_last_action'` via
CosmJS's `Tendermint34Client.subscribeTx` -- is possible today without any
contract change (`gamelog::execute_undo_last_action` would just need to
`.add_attribute("action", "undo_last_action")` on its `Response`, if it
doesn't already) and is worth prioritizing over polling once this UI layer
is otherwise working.

### 4.3 End-game payout screen

`ExecuteMsg::EndGameAndDistribute` is a real-JUNO-moving transaction, so
(per Section 0) it's signed by Keplr directly, not routed through the
session key. The UI flow:

```
idle (game_over conditions met, e.g. bank broken / all ORs complete)
  → "Confirm Final Standings" screen: client computes each player's final
    VGP net worth from the last GetGameState snapshot (cash + share value
    at current market price + treasury-adjusted holdings) and presents it
    for review before anyone signs anything on-chain.
  → Room creator submits EndGameAndDistribute (Keplr-signed, final_player_points
    built from the reviewed numbers) → submitting_action
  → On success: game_over screen, driven by a final GetGameState fetch
    where session.is_active === false. Render:
      - each player's VGP net worth (from the tx's own event attributes if
        emitted, else the final query) mapped to their proportional JUNO
        payout out of total_juno_pool
      - a permanent, read-only board snapshot (final GetMapGrid +
        GetMarketGrid render, Canvas layers frozen, no further input wired)
      - a link/export of GetMapGridMarkdown's rendered text as a shareable
        game recap
  → On failure: action_failed, with the reviewed standings preserved so the
    creator can retry without recomputing anything.
```

**Design gap to flag:** `EndGameAndDistribute` takes `final_player_points`
as caller-supplied input (`Vec<(Addr, Uint128)>`) rather than computing VGP
net worth on-chain from share holdings and market prices. That means the
contract trusts whatever the calling client submits -- there's no on-chain
recomputation to validate the numbers match `GameStateResponse`'s own
`public_companies`/`player_cash` data. Until that's tightened
(e.g. the contract deriving payout weights itself from its own stored
state), the frontend's "Confirm Final Standings" review step in the flow
above is not just good UX -- it is the *only* check standing between a
buggy or malicious client and an incorrect real-JUNO payout, so it should
require an explicit per-value confirmation, not just a single "Confirm"
button over a wall of numbers.

---

## Summary of flagged design gaps

1. **Authorization scope:** switch `GenericAuthorization` to
   `ContractExecutionAuthorization` (contract- and message-scoped) before
   mainnet; the sketch in Section 2.1 is intentionally the simpler starting
   point.
2. **Grant/allowance lifecycle:** neither the `authz` grant nor the
   `FeeGrant` allowance renew themselves; the frontend needs an expiry check
   and a re-grant/re-allowance flow (both Keplr-signed for the grant, both
   developer-signed for the allowance) before either one lapses mid-game.
3. **`Uint128` over JSON:** always parse contract-returned amounts with
   `BigInt(...)`, never `Number(...)` -- flagged concretely at the market
   renderer in Section 3.3, but applies everywhere `GameStateResponse`'s
   `Uint128` fields are consumed.
4. **No rollback event today:** Section 4.2's detection is poll-and-diff
   only; recommend adding an `action` event attribute to
   `gamelog::execute_undo_last_action`'s `Response` so the frontend can
   move to a real WebSocket subscription instead.
5. **Unauthenticated final payout numbers:** `EndGameAndDistribute` trusts
   client-submitted `final_player_points` with no on-chain recomputation
   against `GameStateResponse`'s own data (Section 4.3) -- the review step
   is currently the only safeguard.
