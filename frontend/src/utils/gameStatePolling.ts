// frontend/src/utils/gameStatePolling.ts
//
// ==================================================================
//  DESIGN NOTE 1500: THE FOUR POLLING HOOKS, OUT OF THE STATE MODULE
// ==================================================================
//
// SPLIT OUT OF `gameState.ts` UNCHANGED when that module moved to `gameEngine/`. Not a rewrite: every
// function, constant and interface below is the same text it was, in the same order, and nothing about
// what any of them does was touched.
//
// WHY THE SPLIT HAD TO HAPPEN. `gameState.ts` held the state schema and its pure derivations alongside
// four React hooks, so `import { GameStateResponse }` pulled `react` into the importer's graph -- which
// is how the authoritative reducer came to reach `react` at all. Design note #1200 names this as the
// thing `replayCli` discovered and did not fix: "`applySandboxAction` imports `gameEngine/gameState.ts`, and
// that module holds the state types alongside a React hook -- so the reducer's own import graph reaches
// `react`." The types were the shared half; the hooks were the browser half; one file cannot be both.
//
// SO THE SEAM IS THE HOOK BOUNDARY, and it falls where the file's own section comments already put it.
// `QueryCapableClient` came with them: it describes a CosmJS query client, which is client networking and
// has no business in a server-side engine. Everything else -- `GameStateResponse`, `WaterfallStateResponse`,
// `TrainOfferEntry`, the certificate and net-worth derivations, `parPriceFor` -- stayed in the engine,
// because both halves of the app need them and none of them knows what a browser is.
//
// See `gameEngine/gameState.ts` for the state schema these hooks fetch.

import { useCallback, useEffect, useRef, useState } from "react";

import type {
  GameStateResponse,
  PlayerNetWorthResponse,
  TrainOfferEntry,
  TrainOffersResponse,
  WaterfallStateResponse,
} from "../gameEngine/gameState";

/** Structural query-client shape -- same pattern as
 *  `HexGridRenderer.tsx`'s `QueryCapableClient` (design note #7 there),
 *  re-declared locally rather than imported so this utils file has no
 *  dependency on a specific component. */
export interface QueryCapableClient {
  queryContractSmart(contractAddress: string, queryMsg: Record<string, unknown>): Promise<unknown>;
}

/* ------------------------------------------------------------------ */
/* Polling hook -- see design note #4                                 */
/* ------------------------------------------------------------------ */

export interface UseGameStatePollingResult {
  gameState: GameStateResponse | null;
  loading: boolean;
  /** Set on the most recent failed query; NOT cleared just because an earlier successful state is still being
   *  displayed -- callers wanting "stale but still show the last good state" can keep rendering while
   *  surfacing this as an inline note, matching this codebase's "never silently hide a failure" discipline. */
  error: string | null;
  refresh: () => void;
}

const DEFAULT_POLL_INTERVAL_MS = 6000;

/** Polls `QueryMsg::GetGameState` on a fixed interval -- design note #4. Returns `null` rather than throwing
 *  whenever `client` is absent, matching `HexGridRenderer.tsx`'s "omit the query props to keep this
 *  query-free" convention rather than forcing every caller to guard against a client-less render. */
export function useGameStatePolling(
  client: QueryCapableClient | null | undefined,
  /** OFFLINE-AWARE. `null`/`undefined` means the app has no configured contract, which is a supported state,
   *  not an error -- the same offline mode the tile-catalog fallback runs in. The hook clears state, stops
   *  loading and never queries. Typed optional rather than coerced to `""` at the call site, so the offline
   *  case cannot be mistaken for a real address that happens to be empty. */
  contractAddress: string | null | undefined,
  gameId: number,
  intervalMs: number = DEFAULT_POLL_INTERVAL_MS,
): UseGameStatePollingResult {
  const [gameState, setGameState] = useState<GameStateResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Monotonic guard against a slow, stale poll resolving after a newer one
  // already has -- same pattern as HexGridRenderer.tsx's click interceptor
  // (design note #7 there).
  const requestSeqRef = useRef(0);

  const refresh = useCallback(() => {
    if (!client || !contractAddress) {
      setGameState(null);
      setLoading(false);
      return;
    }
    const seq = ++requestSeqRef.current;
    setLoading(true);
    client
      .queryContractSmart(contractAddress, { GetGameState: { game_id: gameId } })
      .then((response) => {
        if (requestSeqRef.current !== seq) return;
        setGameState(response as GameStateResponse);
        setError(null);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (requestSeqRef.current !== seq) return;
        setError(e instanceof Error ? e.message : "Unknown error querying GetGameState.");
        setLoading(false);
      });
  }, [client, contractAddress, gameId]);

  useEffect(() => {
    refresh();
    if (!client) return;
    const handle = window.setInterval(refresh, intervalMs);
    return () => window.clearInterval(handle);
  }, [client, refresh, intervalMs]);

  return { gameState, loading, error, refresh };
}

/* ------------------------------------------------------------------ */
/* Player Net Worth polling hook -- see design note #6                */
/* ------------------------------------------------------------------ */

export interface UsePlayerNetWorthsResult {
  /** Keyed by player address -- absent for any address that hasn't
   *  resolved a `PlayerNetWorth` query yet (e.g. the very first render, or
   *  a brand-new player who just joined mid-poll-cycle). */
  netWorths: Record<string, PlayerNetWorthResponse>;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

const DEFAULT_NET_WORTH_POLL_INTERVAL_MS = 6000;

/** Polls `QueryMsg::PlayerNetWorth` for every address on a fixed interval -- design note #6 for why this is
 *  a distinct hook rather than a field on `GameStateResponse`. Every query fires concurrently via
 *  `Promise.all`, so this scales to a full player table in one round-trip-latency's worth of time, not N. */
export function usePlayerNetWorths(
  client: QueryCapableClient | null | undefined,
  contractAddress: string,
  gameId: number,
  playerAddresses: readonly string[],
  intervalMs: number = DEFAULT_NET_WORTH_POLL_INTERVAL_MS,
): UsePlayerNetWorthsResult {
  const [netWorths, setNetWorths] = useState<Record<string, PlayerNetWorthResponse>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Monotonic guard against a slow, stale poll resolving after a newer one
  // already has -- same pattern as `useGameStatePolling` above.
  const requestSeqRef = useRef(0);
  // See design note #6: keys `refresh`'s own identity off the ADDRESS SET,
  // not the `playerAddresses` array reference itself, so a same-content
  // re-parse of `GameStateResponse.player_addresses` (every poll, being
  // fresh JSON) doesn't rebuild this hook's interval every cycle.
  const playersKey = playerAddresses.join(",");

  const refresh = useCallback(() => {
    if (!client || playerAddresses.length === 0) {
      setNetWorths({});
      setLoading(false);
      return;
    }
    const seq = ++requestSeqRef.current;
    setLoading(true);
    Promise.all(
      playerAddresses.map((player) =>
        client
          .queryContractSmart(contractAddress, {
            PlayerNetWorth: { game_id: gameId, wallet_address: player },
          })
          .then((response) => [player, response as PlayerNetWorthResponse] as const),
      ),
    )
      .then((entries) => {
        if (requestSeqRef.current !== seq) return;
        setNetWorths(Object.fromEntries(entries));
        setError(null);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (requestSeqRef.current !== seq) return;
        setError(e instanceof Error ? e.message : "Unknown error querying PlayerNetWorth.");
        setLoading(false);
      });
    // `playerAddresses` itself is intentionally omitted below -- `playersKey`
    // (its joined content) is the real dependency; see this hook's own
    // design note #6 comment above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, contractAddress, gameId, playersKey]);

  useEffect(() => {
    refresh();
    if (!client) return;
    const handle = window.setInterval(refresh, intervalMs);
    return () => window.clearInterval(handle);
  }, [client, refresh, intervalMs]);

  return { netWorths, loading, error, refresh };
}

export interface UseWaterfallStatePollingResult {
  waterfallState: WaterfallStateResponse | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

const DEFAULT_WATERFALL_POLL_INTERVAL_MS = 4000;

/** Polls `QueryMsg::GetWaterfallState` -- design note #7. Callers should gate on `enabled` rather than
 *  polling every room forever; when it is `false` the hook tears down its interval and clears state rather
 *  than continuing to query a phase that is already over. */
export interface UseTrainOffersPollingResult {
  offers: TrainOfferEntry[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

/** Audit G-15: polls `GetTrainOffers`. Its own hook rather than a field on the main poll, following the
 *  pattern the waterfall hook established: offers change on a different rhythm from the board -- they appear
 *  and vanish on two players' actions rather than on turn boundaries -- and a seller needs to see one arrive
 *  while it is emphatically NOT their turn, so this cannot key off turn state. */
export function useTrainOffersPolling(
  client: QueryCapableClient | null | undefined,
  contractAddress: string | null | undefined,
  gameId: number,
  intervalMs: number = DEFAULT_POLL_INTERVAL_MS,
): UseTrainOffersPollingResult {
  const [offers, setOffers] = useState<TrainOfferEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestSeqRef = useRef(0);

  const refresh = useCallback(() => {
    if (!client || !contractAddress) {
      setOffers([]);
      setLoading(false);
      return;
    }
    const seq = ++requestSeqRef.current;
    setLoading(true);
    client
      .queryContractSmart(contractAddress, { GetTrainOffers: { game_id: gameId } })
      .then((response) => {
        if (requestSeqRef.current !== seq) return;
        setOffers((response as TrainOffersResponse).offers ?? []);
        setError(null);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (requestSeqRef.current !== seq) return;
        setError(e instanceof Error ? e.message : "Unknown error querying GetTrainOffers.");
        setLoading(false);
      });
  }, [client, contractAddress, gameId]);

  useEffect(() => {
    refresh();
    const handle = setInterval(refresh, intervalMs);
    return () => clearInterval(handle);
  }, [refresh, intervalMs]);

  return { offers, loading, error, refresh };
}

export function useWaterfallStatePolling(
  client: QueryCapableClient | null | undefined,
  /** OFFLINE-AWARE, exactly as the game-state hook is: no configured contract is a supported state, the hook
   *  clears and never queries, and the prop is typed optional rather than coerced to `""` so the offline case
   *  cannot be mistaken for a real address that happens to be empty. */
  contractAddress: string | null | undefined,
  gameId: number,
  enabled: boolean,
  intervalMs: number = DEFAULT_WATERFALL_POLL_INTERVAL_MS,
): UseWaterfallStatePollingResult {
  const [waterfallState, setWaterfallState] = useState<WaterfallStateResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestSeqRef = useRef(0);

  const refresh = useCallback(() => {
    if (!client || !enabled || !contractAddress) {
      setWaterfallState(null);
      setLoading(false);
      return;
    }
    const seq = ++requestSeqRef.current;
    setLoading(true);
    client
      .queryContractSmart(contractAddress, { GetWaterfallState: { game_id: gameId } })
      .then((response) => {
        if (requestSeqRef.current !== seq) return;
        setWaterfallState(response as WaterfallStateResponse);
        setError(null);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (requestSeqRef.current !== seq) return;
        setError(e instanceof Error ? e.message : "Unknown error querying GetWaterfallState.");
        setLoading(false);
      });
  }, [client, contractAddress, gameId, enabled]);

  useEffect(() => {
    refresh();
    if (!client || !enabled) return;
    const handle = window.setInterval(refresh, intervalMs);
    return () => window.clearInterval(handle);
  }, [client, enabled, refresh, intervalMs]);

  return { waterfallState, loading, error, refresh };
}
