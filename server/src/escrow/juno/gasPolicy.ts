// server/src/escrow/juno/gasPolicy.ts
//
// ==================================================================
//  ESCROW-3B: GAS AND FEES -- MEASURED BY SIMULATION, BOUNDED BY POLICY, INTEGERS ONLY
// ==================================================================
//
// The relayer never invents a gas figure and never trusts one blindly. Each attempt is SIMULATED on the node (the
// contract runs; nothing is signed or spent), and the answer is bounded:
//
//   gas_limit = ceil(gas_used · multiplier)          multiplier a ratio of integers (default 13/10)
//   refused   when gas_used is 0, or gas_limit > max_gas (default 1,500,000: ESCROW-B2's largest modelled path, the
//             carried-checkpoint LivenessSettle at the 64-checkpoint cap, is ≈0.67M SDK gas before ante costs; a
//             relayer route is far below it) -- an absurd answer from a remote node FAILS CLOSED (the intent is held),
//             it never becomes a transaction
//   fee       = ceil(gas_limit · gas_price)          gas_price a ratio of integers in the fee denomination's base
//             units (e.g. 75/1000 ujuno per gas); refused above max_fee (default 500,000 base units = 0.5 JUNO)
//
// So no single transaction can drain the relayer account because a node answered nonsense: the worst a lying node can
// cause is a held intent. The escrow's own economics (the configured basis-point subsidy on EVERY deposit, the
// treasury, the dust) are the contract's and are not touched here: relayer routes carry no funds at all.

export interface GasPolicy {
  readonly multiplierNum: bigint;
  readonly multiplierDen: bigint;
  readonly minGas: bigint;
  readonly maxGas: bigint;
  /** Base units of `feeDenom` per unit of gas, as a ratio of integers. */
  readonly gasPriceNum: bigint;
  readonly gasPriceDen: bigint;
  readonly maxFee: bigint;
  readonly feeDenom: string;
}

export const DEFAULT_GAS_POLICY = Object.freeze({
  multiplierNum: BigInt(13),
  multiplierDen: BigInt(10),
  minGas: BigInt(80_000),
  maxGas: BigInt(1_500_000),
  gasPriceNum: BigInt(75),
  gasPriceDen: BigInt(1000),
  maxFee: BigInt(500_000),
});

/** ceil(a / b) for non-negative bigints and a positive divisor (integers only). Exported for the deploy tools' relayer
 *  reserve (`aws/deploy/junoChain.ts` `perTransactionFeeCap`), which must round exactly as `decideGas` does. */
export const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - BigInt(1)) / b;

export type GasDecision = { readonly ok: true; readonly gasLimit: bigint; readonly fee: bigint } | { readonly ok: false; readonly reason: string };

export function decideGas(simulatedGasUsed: string, policy: GasPolicy): GasDecision {
  if (!/^(0|[1-9][0-9]{0,19})$/.test(simulatedGasUsed)) return { ok: false, reason: `the node's simulated gas ${JSON.stringify(simulatedGasUsed)} is not a number` };
  const used = BigInt(simulatedGasUsed);
  if (used === BigInt(0)) return { ok: false, reason: "the node simulated zero gas" };
  let gasLimit = ceilDiv(used * policy.multiplierNum, policy.multiplierDen);
  if (gasLimit < policy.minGas) gasLimit = policy.minGas;
  if (gasLimit > policy.maxGas) return { ok: false, reason: `the node simulated ${used.toString()} gas; with the margin that is ${gasLimit.toString()}, over the cap of ${policy.maxGas.toString()}` };
  const fee = ceilDiv(gasLimit * policy.gasPriceNum, policy.gasPriceDen);
  if (fee > policy.maxFee) return { ok: false, reason: `the fee ${fee.toString()} ${policy.feeDenom} is over the cap of ${policy.maxFee.toString()}` };
  return { ok: true, gasLimit, fee };
}

export function checkGasPolicy(policy: GasPolicy): void {
  const positive = (value: bigint, name: string) => {
    if (typeof value !== "bigint" || value <= BigInt(0)) throw new Error(`gas policy: ${name} must be a positive integer`);
  };
  positive(policy.multiplierNum, "multiplier numerator");
  positive(policy.multiplierDen, "multiplier denominator");
  positive(policy.minGas, "min gas");
  positive(policy.maxGas, "max gas");
  positive(policy.gasPriceNum, "gas price numerator");
  positive(policy.gasPriceDen, "gas price denominator");
  positive(policy.maxFee, "max fee");
  if (policy.multiplierNum < policy.multiplierDen) throw new Error("gas policy: the multiplier must be at least 1");
  if (policy.minGas > policy.maxGas) throw new Error("gas policy: min gas above max gas");
  if (policy.maxGas > BigInt(10_000_000)) throw new Error("gas policy: max gas above 10,000,000 is never a relayer transaction");
  if (!/^[a-zA-Z][a-zA-Z0-9/:._-]{2,127}$/.test(policy.feeDenom)) throw new Error("gas policy: the fee denomination is not a Cosmos denomination");
}
