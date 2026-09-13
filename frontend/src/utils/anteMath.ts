// frontend/src/utils/anteMath.ts -- design note #1415.
//
// THE ANTE'S ARITHMETIC, IN INTEGER ujuno. The project's rule for anything that is money: no floating point,
// six decimal places, fixed-point on integers -- the contract will do this sum in `Uint128` and every client
// must show the same figure it will settle. `BigInt` rather than `number` so a whale's ante cannot lose a digit
// past 2^53; no bigint literals, because the frontend targets ES5 (`BigInt(...)` calls compile, `10n` does not).
//
// THE SUBSIDY IS THE PROJECT'S GAS RULE: a small, configurable share of every lobby deposit goes to the
// developer treasury that funds players' transaction-fee grants. Basis points, so "2.5%" is an integer.

/** The share of each ante that funds fee grants, in basis points (1/100 of a percent). Placeholder until the
 *  contract's config is read; the contract's figure is the one that settles. */
export const DEV_SUBSIDY_BPS = 250;

const BPS_DENOMINATOR = BigInt(10_000);
const UJUNO_PER_JUNO = BigInt(1_000_000);

export interface AnteBreakdown {
  /** What the seat deposits, in ujuno. */
  anteUjuno: string;
  /** The treasury's share, in ujuno -- floored, so the pool is never short. */
  subsidyUjuno: string;
  /** What reaches the lobby pool, in ujuno. */
  netUjuno: string;
  subsidyBps: number;
}

/** A digit string or nothing -> a non-negative BigInt. Anything malformed is zero, never a throw. */
export function parseUjuno(raw: string | null | undefined): bigint {
  return typeof raw === "string" && /^\d{1,30}$/.test(raw) ? BigInt(raw) : BigInt(0);
}

export function anteBreakdown(anteUjuno: string | null | undefined, subsidyBps = DEV_SUBSIDY_BPS): AnteBreakdown {
  const ante = parseUjuno(anteUjuno);
  const bps = BigInt(Math.max(0, Math.min(10_000, Math.floor(subsidyBps))));
  const subsidy = (ante * bps) / BPS_DENOMINATOR;
  return {
    anteUjuno: ante.toString(),
    subsidyUjuno: subsidy.toString(),
    netUjuno: (ante - subsidy).toString(),
    subsidyBps: Number(bps),
  };
}

/** "1.5 JUNO", "0 JUNO", "0.000001 JUNO" -- trailing zeros trimmed, never more than six places. */
export function formatJuno(ujuno: string | bigint | null | undefined): string {
  const value = typeof ujuno === "bigint" ? ujuno : parseUjuno(ujuno);
  const whole = value / UJUNO_PER_JUNO;
  const fraction = (value % UJUNO_PER_JUNO).toString().padStart(6, "0").replace(/0+$/, "");
  return `${whole.toString()}${fraction ? `.${fraction}` : ""} JUNO`;
}

/** "2.5%" from basis points, for the line that says where the fee goes. */
export function formatBps(bps: number): string {
  const whole = Math.floor(bps / 100);
  const hundredths = bps % 100;
  return `${whole}${hundredths ? `.${String(hundredths).padStart(2, "0").replace(/0$/, "")}` : ""}%`;
}
