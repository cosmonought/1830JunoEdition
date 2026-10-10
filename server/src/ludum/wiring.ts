// server/src/ludum/wiring.ts
//
// ==================================================================
//  LUDUM v1 (Lane A): THE ONE PRODUCTION `LudumPorts` (§9) -- READ-ONLY VIEWS OF WHAT THE SERVER ALREADY HOLDS
// ==================================================================
//
//   records()                  the room host's record index (a snapshot: `RoomHost.records`)
//   seatOf                     `rooms/gameRecord.ts`'s own `seatOf`
//   financial(gameId)          the money layer's financial record (`MoneyTables.financialRecord`); null without money
//   financialByChainGameId     the money record whose binding names that chain game: a scan of the money tables' records
//                              (O(money tables)); a match is remembered, because a binding is write-once
//   terminalEvidence(gameId)   the financial record's `intent` -- the terminal settlement evidence, derived once
//   chainGame(chainGameId)     the escrow game from the chain (`MoneyTables.ludumChain.game`): a quorum read where two or
//                              more endpoints are configured (`chain-confirmed`), else one endpoint's (`chain-observed`,
//                              with its height); null when the chain has no such game
//   escrowPin()                the pinned deployment -- null without money, or when its denom is not `ujunox`
//   product()                  { key: "project-18xx", name: APP_NAME }
//   chainIntents(gameId)       v1.1: the money layer's relayed chain intents (`MoneyTables.ludumChain.intents`)
//   members                    v1.1: `createLudumMemberPorts` -- the caller's own display name and facts, and the conduct
//                              reviewers' service (bound at startup; Play's conduct routes are untouched)
//
// Nothing here caches a chain fact; principals stay on the server (the handlers see `LudumCaller.principalId` and these
// ports only). The only writes (v1.1) are the members port's: the identity service's own display-name change and the
// conduct service's own decision, each under that service's rules.

import { APP_NAME } from "../../../frontend/src/config";
import { seatOf, type GameRecord } from "../rooms/gameRecord";
import type { FinancialGameRecord } from "../escrow/moneyLifecycle";
import type { MoneyTables } from "../escrow/moneyTables";
import type { ConductService } from "../conduct/conductService";
import type { IdentityService } from "../identity/sessions";
import type { TrustFacts } from "../rooms/trustFacts";
import type { ServerLogEntry } from "../../../frontend/src/utils/roomSession";
import type { Product } from "./contract";
import type { LudumMemberPorts, LudumPorts } from "./ports";
import { ludumConfirmUrl } from "./session";

const CHAIN_GAME_ID = /^[1-9][0-9]{0,19}$/;

/** The product key of a display name: lower case, words joined by `-` ("Project 18XX" -> "project-18xx"). */
export const productKeyOf = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/** INTEGRATION (archived-history gap, docs/ludum/LUDUM_PLATFORM_ARCHITECTURE.md §12): `records()` is the room host's
 *  in-memory index, which is complete only after startup discovery listed every record without a store fault. While it is
 *  not, `records()` THROWS this (the ingress answers 503 `unavailable`) -- a partial index is never served as an
 *  account's whole history. */
export class LudumIndexIncomplete extends Error {}

export type LudumIndexState = { readonly complete: true } | { readonly complete: false; readonly reason: string };

export interface LudumWiringDeps {
  /** `RoomHost.records`. */
  readonly records: () => readonly GameRecord[];
  /** Whether `records` is the whole durable record set (absent: assumed complete -- tests and tools only). */
  readonly index?: () => LudumIndexState;
  /** The money layer, or null when this server has none (every money port then answers null). */
  readonly money: () => MoneyTables | null;
  readonly now: () => number;
  readonly product?: Product;
  /** v1.1: the account and reviewer ports (absent: those routes answer 503). */
  readonly members?: LudumMemberPorts;
  /** v1.1: an account's current unique display name (the public case record's seat names). */
  readonly displayNameOf?: (principalId: string) => string | null;
}

/** v1.1: where an account's seats stand, from the record index -- `playing` once any table it sits at has started (its
 *  first game: the one change is then gone), `seated` at a table still waiting, else `none`. Throws `LudumIndexIncomplete`
 *  while the index is not the whole record set (never guessed from a partial one). */
export function seatStateOf(records: () => Iterable<GameRecord>, principalId: string): "none" | "seated" | "playing" {
  let seated = false;
  for (const record of records()) {
    if (seatOf(record, principalId) === null) continue;
    if (record.started_at !== null || record.status === "active" || record.status === "completed") return "playing";
    if (record.status === "waiting") seated = true;
  }
  return seated ? "seated" : "none";
}

export interface LudumMemberDeps {
  readonly identity: IdentityService;
  /** The record index, complete (`createLudumPorts`'s guarded `records`, or the same guard). */
  readonly records: () => Iterable<GameRecord>;
  readonly trustFacts: (principalId: string) => Promise<TrustFacts | null>;
  readonly conduct: () => ConductService | null;
  /** The principals bound at startup to the configured reviewer usernames (`gameServer.ts`). */
  readonly reviewers: ReadonlySet<string>;
  readonly readLog: (gameId: string) => Promise<readonly ServerLogEntry[] | null>;
  readonly playOrigin: string;
  readonly now: () => number;
}

export function createLudumMemberPorts(deps: LudumMemberDeps): LudumMemberPorts {
  const seat = (principalId: string) => seatStateOf(deps.records, principalId);
  const service = (): ConductService => {
    const conduct = deps.conduct();
    if (conduct === null || !conduct.enabled) throw new Error("the conduct service is not enabled");
    return conduct;
  };
  return {
    displayName(principalId) {
      const name = deps.identity.profileName(principalId);
      if (name === null) return null;
      const state = deps.identity.displayNameState(principalId, seat(principalId));
      return state === null ? null : { name, state };
    },
    changeDisplayName: (principalId, name) => deps.identity.changeDisplayName(principalId, name, () => seat(principalId), deps.now()),
    tablemateFacts: (principalId) => deps.trustFacts(principalId),
    isReviewer(principalId) {
      const conduct = deps.conduct();
      return deps.reviewers.has(principalId) && conduct !== null && conduct.enabled;
    },
    queue: (principalId) => service().queue(principalId),
    caseView: (caseId, principalId) => service().caseView(caseId, principalId, deps.readLog),
    decide: (input) => service().decide(input, deps.readLog),
    confirmUrl: (returnPath) => ludumConfirmUrl(deps.playOrigin, returnPath),
  };
}

export function createLudumPorts(deps: LudumWiringDeps): LudumPorts {
  const product: Product = Object.freeze(deps.product ?? { key: productKeyOf(APP_NAME), name: APP_NAME });
  /** chain game id -> game id, for bindings already found (a binding never changes once written). */
  const byChain = new Map<string, string>();

  const financial = async (gameId: string): Promise<FinancialGameRecord | null> => {
    const money = deps.money();
    return money === null ? null : money.financialRecord(gameId);
  };
  const chainIdOf = (record: FinancialGameRecord | null): string | null => record?.binding?.escrow?.chain_game_id ?? null;

  const records = (): readonly GameRecord[] => {
    const state = deps.index?.() ?? { complete: true as const };
    if (!state.complete) throw new LudumIndexIncomplete(state.reason);
    return deps.records();
  };

  return {
    records,
    seatOf: (record, principalId) => seatOf(record, principalId),
    financial,
    async financialByChainGameId(chainGameId) {
      if (!CHAIN_GAME_ID.test(chainGameId) || deps.money() === null) return null;
      const known = byChain.get(chainGameId);
      if (known !== undefined) {
        const record = await financial(known);
        if (chainIdOf(record) === chainGameId) return record;
        byChain.delete(chainGameId);
      }
      for (const game of records()) {
        if (game.money === null) continue;
        const record = await financial(game.game_id);
        const bound = chainIdOf(record);
        if (bound !== null) byChain.set(bound, game.game_id);
        if (bound === chainGameId) return record;
      }
      return null;
    },
    async terminalEvidence(gameId) {
      return (await financial(gameId))?.intent ?? null;
    },
    async chainGame(chainGameId) {
      const money = deps.money();
      if (money === null || !CHAIN_GAME_ID.test(chainGameId)) return null;
      return money.ludumChain.game(chainGameId);
    },
    escrowPin() {
      const money = deps.money();
      if (money === null) return null;
      const pin = money.ludumChain.pin();
      if (pin.denom !== "ujunox") return null;
      return { contract: pin.contract, chainId: pin.chainId, denom: "ujunox" };
    },
    product: () => product,
    now: () => deps.now(),
    async chainIntents(gameId) {
      const money = deps.money();
      return money === null ? [] : money.ludumChain.intents(gameId);
    },
    ...(deps.members !== undefined ? { members: deps.members } : {}),
    ...(deps.displayNameOf !== undefined ? { accountDisplayName: deps.displayNameOf } : {}),
  };
}
