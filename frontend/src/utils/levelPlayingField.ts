// frontend/src/utils/levelPlayingField.ts
//
// What the Level Playing Field variant adds to a dealt game -- design note #1320.
//
// ==================================================================
//  DESIGN NOTE 1322: THE ROSTER GROWS AT THE DEAL, NOT IN THE FIXTURE
// ==================================================================
//
// `sandboxState.ts` is the frozen eight-corporation, six-private fixture every room boots from, and it stays
// exactly that: a standard game must never see a PMQ card or a JK in its auction. The variant's entities are
// added by the reducer's `SetupGame` arm, which is the one place that knows the variants and runs on every
// client and on the server (#1230: "the reducer owns the deal"). So the additions are pure functions of a
// state, defined here, and applied there.
//
// ORDER IS THE RULE. The auction offers privates by array position (`is_lowest_offered: index === 0`), so the
// JK is INSERTED after the M&H ($110) and before the C&A ($160), not appended. Corporations are appended: their
// order in `public_companies` is nothing a player sees (`CORPORATION_DISPLAY_ORDER` sorts the cards).

import { NW_COMPANY_ID, PMQ_COMPANY_ID } from "../components/hexBoardDataLpf";
import type { GameStateResponse, PrivateCompanyState, PublicCompanyState } from "./gameState";

/** ERIE's printed id, for the 20% certificate table below. */
export const ERIE_COMPANY_ID = 6;

/** The James River & Kanawha Company: $120 face, $20 revenue, id 7. Its power is the half-price lay beside
 *  Coal River (`kanawhaLicense.ts` #1323). */
export const JK_PRIVATE_ID = 7;
export const JK_PRIVATE: Readonly<Pick<PrivateCompanyState, "private_id" | "name" | "cost" | "revenue_per_or">> = {
  private_id: JK_PRIVATE_ID,
  name: "James River & Kanawha Company",
  cost: "120",
  revenue_per_or: "20",
};

/** The two corporations, with the same fields the fixture writes for the printed eight.
 *  PMQ homes at E5 and shares it as ERIE shares E11 (an OO hex, slot chosen at placement -- #560). N&W homes
 *  at Norfolk (L16), a two-slot gray city. Token allowances: PMQ 2, N&W 3. */
export const LPF_PUBLIC_COMPANIES: ReadonlyArray<
  Pick<PublicCompanyState, "company_id" | "ticker" | "home_hex_label" | "station_token_limit">
> = [
  { company_id: PMQ_COMPANY_ID, ticker: "PMQ", home_hex_label: "E5", station_token_limit: 2 },
  { company_id: NW_COMPANY_ID, ticker: "N&W", home_hex_label: "L16", station_token_limit: 3 },
];

/** An unstarted corporation, exactly as `withEmptyRoster` and the `SetupGame` arm leave the printed eight. */
function unstartedCorporation(
  entry: (typeof LPF_PUBLIC_COMPANIES)[number],
): PublicCompanyState {
  return {
    company_id: entry.company_id,
    ticker: entry.ticker,
    is_floated: false,
    treasury: "0",
    total_shares_issued: 0,
    par_value: null,
    last_route_revenue: "0",
    owned_trains: [],
    president: null,
    ipo_pool_percentage: 100,
    bank_pool_percentage: 0,
    player_holdings: [],
    home_hex_label: entry.home_hex_label,
    station_token_hexes: [],
    station_tokens: [],
    station_token_limit: entry.station_token_limit,
  };
}

/** The privates with the JK slotted in by face value. Idempotent: a list that already holds it is returned
 *  as it is, so a replayed or twice-applied deal cannot offer two of them. */
export function withLevelPlayingFieldPrivates(
  privates: readonly PrivateCompanyState[],
): PrivateCompanyState[] {
  if (privates.some((entry) => entry.private_id === JK_PRIVATE_ID)) return [...privates];
  const jk: PrivateCompanyState = { ...JK_PRIVATE, owner: null, owner_protocol_id: null, closed: false };
  const out = [...privates];
  /* AFTER the last private cheaper than it. Written as a scan over cost rather than a fixed index, so a
     fixture whose order changes still lands the JK where the auction expects it. */
  const cost = Number(jk.cost);
  let at = 0;
  while (at < out.length && Number(out[at].cost) < cost) at += 1;
  out.splice(at, 0, jk);
  return out;
}

/** The corporations with PMQ and N&W appended. Idempotent for the same reason. */
export function withLevelPlayingFieldCorporations(
  companies: readonly PublicCompanyState[],
): PublicCompanyState[] {
  const have = new Set(companies.map((company) => company.company_id));
  return [
    ...companies,
    ...LPF_PUBLIC_COMPANIES.filter((entry) => !have.has(entry.company_id)).map(unstartedCorporation),
  ];
}

/** Design note #1324: the two corporations whose IPO holds a 20% standard certificate. ERIE is the printed
 *  id 6; N&W is the variant's own. */
export const DOUBLE_CERTIFICATE_COMPANY_IDS: readonly number[] = [ERIE_COMPANY_ID, NW_COMPANY_ID];

/** The corporations with the 20% standard certificate seeded in the IPO where the variant prints one. */
export function withLevelPlayingFieldCertificates(
  companies: readonly PublicCompanyState[],
): PublicCompanyState[] {
  return companies.map((company) =>
    DOUBLE_CERTIFICATE_COMPANY_IDS.includes(company.company_id) && !company.double_certificate
      ? { ...company, double_certificate: { at: "Ipo" } }
      : company,
  );
}

/** The whole addition, for the `SetupGame` arm. */
export function withLevelPlayingFieldEntities(state: GameStateResponse): GameStateResponse {
  return {
    ...state,
    public_companies: withLevelPlayingFieldCertificates(
      withLevelPlayingFieldCorporations(state.public_companies),
    ),
    private_companies: withLevelPlayingFieldPrivates(state.private_companies),
  };
}
