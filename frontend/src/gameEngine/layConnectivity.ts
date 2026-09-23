// frontend/src/gameEngine/layConnectivity.ts
//
// ==================================================================
//  DESIGN NOTE 1692 (Stage 10.6, S6-5): THE NETWORK A LAY MUST JOIN, DERIVED ONCE, FOR EVERY ASKER
// ==================================================================
//
// FOUND BY THE STAGE-6 AUDIT (M4) AND CARRIED OPEN SINCE: the shell's tile picker refused a rotation that did not
// join the acting corporation's network (#6, #483 -- rule 6 of `filterSandboxPlacements`, `orientationJoinsNetwork`),
// and nothing else did. The server, the replay and the reducer handed `filterSandboxPlacements` no network, so a
// crafted `LayTile` that was geometrically legal but touched nothing the corporation could reach was appended and
// applied. A rule stated in one place and never asked in its sibling -- the shape #807 … #1683 keep finding.
//
// NO SECOND ALGORITHM. The network is the walk `trackReach.ts` already owns (`layableHexes` -> `reachableTrack`),
// rooted at `stationTokensOf` (which adds the 1830+ herald, #1302), walled by `cityBlockerFor` bound to the acting
// corporation (a tokened-out city, #729; Coal River for an unlicensed corporation, #1323) -- exactly the inputs
// `App.tsx`'s Lay Track focus assembled inline, and which it now takes from here. The JOIN is still rule 6 of
// `filterSandboxPlacements`: the network is handed to the injected board geometry (`LayNetwork` below), which
// passes it through as `networkHexes` / `networkPorts`. So the picker, both grid steps, the reducer and ingress ask
// one walk and one join.
//
// DERIVED FROM THE BOARD, NEVER FROM THE MESSAGE: the state names the corporation's tokens and licences, the grid
// names the track. A message cannot carry a network.
//
// "UNCONSTRAINED" IS KEPT, deliberately: a corporation with no token rooted on the board has no network, and
// `layableHexes` has always answered that case "everything the board allows" (#2). Since Slice 8.2 the home
// station is owed before a corporation may lay at all (the home hold), so the case is a fixture's rather than a
// live table's -- and inventing a stricter answer here would be a second rule.

import type { GameStateResponse } from "./gameState";
import type { MapGridResponse } from "../components/hexContractTypes";
import { tokenCityIndex, type StationTokenCompany } from "../components/hexContractTypes";
import { layableHexes, stationTokensOf, type LayableHexInput, type LayableHexResult } from "./trackReach";
import { cityBlockerFor } from "./cityBlocking";
import { citySlotCount } from "./stationTokens";
import { barredHexesFor } from "./kanawhaLicense";

/** The network a lay must join: the hexes the corporation's track reaches and the edges it arrives at (#483).
 *  Handed to the board geometry as `networkHexes` / `networkPorts` -- always together (#483's rule). */
export interface LayNetwork {
  hexes: ReadonlySet<string>;
  ports: ReadonlySet<string>;
}

/** The acting corporation's reach on `grid`, with the board's own walls -- the one assembly the shell's Lay Track
 *  focus and the authority share. `hasPlaceableTile` is the shell's glow test (#716) and optional; the authority
 *  never passes it (it does not change `network` / `ports`, only which extension candidates glow). */
export function layReachFor(
  state: GameStateResponse,
  grid: MapGridResponse,
  companyId: number,
  hasPlaceableTile?: LayableHexInput["hasPlaceableTile"],
): LayableHexResult {
  const corporation = state.public_companies.find((entry) => entry.company_id === companyId);
  return layableHexes({
    mapGrid: grid,
    // #686 / #1302: the recorded city travels with the token, and the herald is a root.
    stationHexes: corporation ? stationTokensOf(corporation) : [],
    // #729 / #1323: a tokened-out city, and Coal River without a licence, are walls -- bound to THIS corporation.
    blocksThrough: cityBlockerFor({
      actingCompanyId: companyId,
      companies: state.public_companies,
      slotsAt: (q, r, cityIndex) => citySlotCount(grid, q, r, cityIndex),
      cityOf: (holder, q, r) => tokenCityIndex(holder as unknown as StationTokenCompany, q, r),
      barredHexes: barredHexesFor(state, companyId),
    }),
    hasPlaceableTile,
  });
}

/** The network a lay by `companyId` must join on `grid`, or `null` when the corporation has no rooted token
 *  (`unconstrained`, #2) -- in which case connectivity is not asked, exactly as the picker never asked it. */
export function layNetworkFor(
  state: GameStateResponse,
  grid: MapGridResponse,
  companyId: number,
): LayNetwork | null {
  const reach = layReachFor(state, grid, companyId);
  if (reach.unconstrained) return null;
  return { hexes: reach.network, ports: reach.ports };
}
