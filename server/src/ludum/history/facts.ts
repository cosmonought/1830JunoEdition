// LUDUM v1 -- player history (Lane C): the §4 provenance vocabulary as code.
//
// Every value the history routes send is a `Fact`, and a Fact says where it came from. These helpers are the only way
// this directory builds one, so the §4 rules hold by construction:
//   * `value` is null iff the provenance is "unavailable", and an unavailable Fact always carries a `reason`;
//   * a chain Fact carries the read's `height` (quorum, "chain-confirmed") or `observedAt` (single endpoint,
//     "chain-observed") -- exactly what `LudumPorts.chainGame` reported, never invented;
//   * a figure built from several inputs takes the WEAKEST input's provenance (`weakest`).

import type { Fact, Junox, Provenance } from "../contract";

/** Strongest first. A combined figure is only as good as its weakest input. */
const STRENGTH: readonly Provenance[] = ["chain-confirmed", "chain-observed", "server-recorded", "pending", "unavailable"];

/** Where a chain read came from (`LudumPorts.chainGame`). */
export interface ChainSource {
  readonly provenance: "chain-confirmed" | "chain-observed";
  readonly height?: string;
  readonly observedAt: string;
}

export const unavailable = <T>(reason: string): Fact<T> => ({ value: null, provenance: "unavailable", reason });
export const serverRecorded = <T>(value: T): Fact<T> => ({ value, provenance: "server-recorded" });
export const pending = <T>(value: T, reason?: string): Fact<T> => ({ value, provenance: "pending", ...(reason !== undefined ? { reason } : {}) });

/** A chain fact, stamped with the read it came from: `height` for a quorum read, `observedAt` for a single endpoint. */
export function chainFact<T>(value: T, source: ChainSource): Fact<T> {
  return source.provenance === "chain-confirmed" && source.height !== undefined
    ? { value, provenance: "chain-confirmed", height: source.height, observedAt: source.observedAt }
    : { value, provenance: "chain-observed", observedAt: source.observedAt };
}

/** The weakest of the given provenances ("chain-confirmed" for an empty list). */
export function weakest(provenances: readonly Provenance[]): Provenance {
  let worst = 0;
  for (const provenance of provenances) worst = Math.max(worst, STRENGTH.indexOf(provenance));
  return STRENGTH[worst];
}

/** Base units, always a canonical integer string (never a JS number). */
export const junox = (amount: bigint): Junox => ({ amount: amount.toString(), denom: "ujunox" });

/** Whole seconds since the epoch (a chain clock) as an ISO instant, or null when it is not representable. */
export function isoOfSecs(secs: bigint): string | null {
  const ms = secs * BigInt(1000);
  if (secs < BigInt(0) || ms > BigInt(8.64e15)) return null;
  return new Date(Number(ms)).toISOString();
}

/** Server milliseconds as an ISO instant, or null. */
export const isoOfMs = (ms: number | null): string | null => (ms === null || !Number.isSafeInteger(ms) || ms < 0 ? null : new Date(ms).toISOString());
