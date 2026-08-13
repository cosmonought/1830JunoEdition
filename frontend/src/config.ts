// frontend/src/config.ts
//
// Deployment configuration -- the single source of truth for every
// chain-facing address and endpoint (F-4).
//
// ===================================================================
//  DESIGN NOTE 0: WHY THIS FILE DOES NOT THROW AT IMPORT
// ===================================================================
//
// The first version of this file validated at module scope:
//
//     export const CONTRACT_ADDRESS = requireAddress(...);   // WRONG
//
// That crashed the entire app at startup with an unset `.env` -- the throw
// happened during `import`, before React ever mounted, so there was no UI
// left to display the error in. `config.ts` is imported by `sessionKey.ts`,
// which is imported by `WalletContext.tsx`, which is imported by `App.tsx`:
// one missing variable took down the whole bundle.
//
// It was also wrong on the merits, not just the timing. This app has a real
// OFFLINE MODE -- `HexGridRenderer`'s design note #120 tile-picker fallback,
// which reads `localCatalogPlacements` and reports `status: "offline"`
// whenever `contractAddress` is `undefined`. Offline mode needs no contract,
// no fee granter, no RPC endpoint and no wallet; it exists precisely to
// inspect the tile catalog without a chain. Making an unset contract address
// fatal made that documented mode unreachable.
//
// So the rule here is:
//
//   - READING config never throws. Unset values are `undefined`, which is a
//     legitimate state meaning "offline".
//   - REQUIRING config throws, and only at the moment an operation genuinely
//     needs a chain: connecting a wallet, granting a session key, sending a
//     transaction. That is still fail-loud -- the error names the exact
//     variable -- but it fails at the point of use, where the UI is alive to
//     show it and where the user has actually asked for something that needs
//     it.
//
// The bug the original fail-loud check was aimed at is still caught. That bug
// was a placeholder that LOOKS like an address:
//
//     const DEVELOPER_FEE_GRANTER_ADDRESS = "juno1...devfeegrantaddress...";
//
// Not valid bech32, and every gameplay transaction routes `granter:
// feeGranter`, so every session-key transaction would have failed at
// fee-grant resolution against a live chain -- surfacing as far from the
// mistake as possible. `requireAddress` below still rejects exactly that, and
// still names the variable. It just does it when you try to transact rather
// than when you open the page.
//
// ===================================================================
//  DESIGN NOTE 1: WHY A SHARED MODULE AT ALL
// ===================================================================
//
// `WalletContext.tsx` and `utils/sessionKey.ts` each carried their own copy
// of the RPC endpoint and contract address, each with a matching
// `TODO(design gap)` acknowledging the duplication. Those are resolved here.
//
// The duplication was not merely untidy. `sessionKey.ts`'s copy of the
// contract address scopes the session key's authz
// `ContractExecutionAuthorization`, while `WalletContext.tsx`'s copy signs
// it. Two drifting copies would authorize a contract the app never calls, and
// every session-key transaction would fail authorization at broadcast with no
// hint as to why.
//
// ===================================================================
//  DESIGN NOTE 2: CRA SUBSTITUTES REACT_APP_* AT BUILD TIME
// ===================================================================
//
// `react-scripts` replaces `process.env.REACT_APP_FOO` textually at build
// time. Two consequences worth stating rather than discovering:
//
//   - the reads below MUST be full literal `process.env.REACT_APP_FOO`
//     expressions. Destructuring (`const { REACT_APP_FOO } = process.env`) or
//     dynamic indexing (`process.env[name]`) is NOT substituted and silently
//     yields `undefined` in a production bundle. That is why `readOptional`
//     takes the already-read VALUE and uses the name only for messages.
//   - changing a variable needs a REBUILD, not just a dev-server restart.
//
// ===================================================================
//  DESIGN NOTE 3: VALIDATION IS SHAPE-ONLY
// ===================================================================
//
// This checks the bech32 prefix, character set and length. It deliberately
// does NOT verify the bech32 checksum: that would pull `@cosmjs/encoding`
// into this module for no real gain, since the failure being guarded against
// is "someone shipped the placeholder" or "someone left it unset", not
// "someone typo'd one character of an otherwise real address". A checksum
// failure is caught by the chain with a clear error; a placeholder was not,
// which is the whole reason for this check.
//
// NOTHING SECRET GOES HERE. Everything ships to the browser in plain text.

/** Bech32 human-readable prefix for the target chain. */
export const JUNO_PREFIX = "juno";

/** The chain's native fee/stake denom, and the exponent converting it to its
 *  display unit. `ujuno` -> `JUNO` is 6 decimals, matching the fixed-point
 *  scale the contract uses for VGP (`juno_developer_spec.md` §1). */
export const NATIVE_DENOM = "ujuno";
export const NATIVE_DENOM_DISPLAY = "JUNO";
export const NATIVE_DENOM_EXPONENT = 6;

/** Shape check for a bech32 address on `JUNO_PREFIX` -- see design note #3. */
function looksLikeJunoAddress(value: string): boolean {
  // `1` separator, then bech32's data charset, which excludes `1`, `b`, `i`
  // and `o` so they cannot be confused with `l`, `8`, `1` and `0`. A
  // placeholder like "juno1...eighteencosmos..." fails on the literal dots.
  return /^juno1[02-9ac-hj-np-z]{38,58}$/.test(value);
}

/** Reads a build-time value, normalising unset/blank to `undefined`. Never
 *  throws -- see design note #0. */
function readOptional(value: string | undefined): string | undefined {
  const trimmed = (value ?? "").trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/* ------------------------------------------------------------------ */
/* Raw values. Reading these NEVER throws. `undefined` means offline.   */
/* ------------------------------------------------------------------ */

/** The deployed 18Cosmos contract, or `undefined` when unconfigured.
 *
 *  `undefined` is a supported, meaningful state: `HexGridRenderer` takes it
 *  as the signal to run its offline tile-catalog fallback rather than query a
 *  chain. Pass it straight through; do not coerce it to `""`. */
export const CONTRACT_ADDRESS = readOptional(process.env.REACT_APP_CONTRACT_ADDRESS);

/** The developer treasury that pays gas for session-key transactions.
 *
 *  MUST equal the contract's own `GameConfig::developer_treasury`. The
 *  contract funds this account from a percentage of every lobby deposit, and
 *  this account then grants fees back to players. Point these at two
 *  different addresses and the treasury fills while every player's
 *  transaction fails for want of a grant. */
export const DEVELOPER_FEE_GRANTER_ADDRESS = readOptional(process.env.REACT_APP_FEE_GRANTER);

/** Chain id for `keplr.enable` / `getOfflineSigner`. */
export const JUNO_CHAIN_ID = readOptional(process.env.REACT_APP_CHAIN_ID);

/** RPC endpoint both signing clients connect to. */
export const JUNO_RPC_ENDPOINT = readOptional(process.env.REACT_APP_RPC_ENDPOINT);

/* ------------------------------------------------------------------ */
/* Required accessors. These throw, at the point of USE.                */
/* ------------------------------------------------------------------ */

function missing(name: string): never {
  throw new Error(
    `[config] ${name} is not set, so this app cannot talk to a chain. ` +
      "Add it to frontend/.env (see .env.example) and RESTART the dev server -- " +
      "react-scripts substitutes REACT_APP_* at build time. " +
      "Offline mode (tile catalog inspection) works without it.",
  );
}

function requireAddress(name: string, value: string | undefined): string {
  if (value === undefined) missing(name);
  if (!looksLikeJunoAddress(value)) {
    throw new Error(
      `[config] ${name} is set to "${value}", which is not a valid ${JUNO_PREFIX} bech32 ` +
        "address. This is almost always a leftover placeholder. A real address is the " +
        "prefix, then '1', then 38-58 bech32 characters.",
    );
  }
  return value;
}

/** The contract address, or throw. Call only from a path that is about to
 *  touch the chain -- never at module scope, and never on a render path that
 *  offline mode also takes. */
export function requireContractAddress(): string {
  return requireAddress("REACT_APP_CONTRACT_ADDRESS", CONTRACT_ADDRESS);
}

export function requireFeeGranterAddress(): string {
  return requireAddress("REACT_APP_FEE_GRANTER", DEVELOPER_FEE_GRANTER_ADDRESS);
}

export function requireChainId(): string {
  return JUNO_CHAIN_ID ?? missing("REACT_APP_CHAIN_ID");
}

export function requireRpcEndpoint(): string {
  return JUNO_RPC_ENDPOINT ?? missing("REACT_APP_RPC_ENDPOINT");
}

/* ------------------------------------------------------------------ */
/* Diagnostics                                                          */
/* ------------------------------------------------------------------ */

/** Whether every chain-facing value is present AND well-formed.
 *
 *  `false` means the app runs in offline mode: the tile catalog is browsable,
 *  wallet connection and all transactions are unavailable. Use this to label
 *  the UI honestly rather than to hide errors -- a user who sees "Offline"
 *  and a reason is informed; one who sees a dead Connect button is not. */
export function isChainConfigured(): boolean {
  return chainConfigError() === null;
}

/** A human-readable reason the app cannot reach a chain, or `null` if it can.
 *  Safe to call anywhere -- it catches its own throws. */
export function chainConfigError(): string | null {
  try {
    requireContractAddress();
    requireFeeGranterAddress();
    requireChainId();
    requireRpcEndpoint();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/* ------------------------------------------------------------------ */
/* Display helpers                                                      */
/* ------------------------------------------------------------------ */

/** Formats a base-denom integer string (`"12500000"` ujuno) for display
 *  (`"12.500000"` JUNO).
 *
 *  INTEGER STRING MATH ONLY -- never `Number(amount) / 1e6`. This mirrors the
 *  contract's own no-floating-point discipline for the same reason it holds
 *  itself to it: `ujuno` amounts are `Uint128`, and any balance above 2^53
 *  base units silently loses precision the moment it becomes an IEEE-754
 *  double. The player would simply be shown the wrong amount of their own
 *  money, which is the least acceptable place to be quietly wrong.
 *
 *  Returns `"0.000000"` for malformed input rather than `NaN`, so a
 *  surprising RPC response degrades to an obviously-wrong-but-harmless zero
 *  instead of rendering "NaN JUNO". */
export function formatNativeAmount(baseAmount: string): string {
  const digits = baseAmount.trim();
  if (!/^\d+$/.test(digits)) return `0.${"0".repeat(NATIVE_DENOM_EXPONENT)}`;
  const padded = digits.padStart(NATIVE_DENOM_EXPONENT + 1, "0");
  const whole = padded.slice(0, padded.length - NATIVE_DENOM_EXPONENT);
  const fraction = padded.slice(padded.length - NATIVE_DENOM_EXPONENT);
  return `${whole.replace(/^0+(?=\d)/, "")}.${fraction}`;
}
