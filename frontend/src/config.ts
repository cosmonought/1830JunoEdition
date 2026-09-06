// Deployment configuration -- the single source of truth for every chain-facing
// address and endpoint (F-4).
//
// Design note #0: READING config never throws; unset values are `undefined`,
// which legitimately means "offline". REQUIRING config throws, and only at the
// moment an operation needs a chain. The first version validated at module
// scope, which crashed the whole bundle before React mounted on an unset `.env`
// and made `HexGridRenderer`'s documented offline mode (#120) unreachable. The
// bug it was aimed at -- the `"juno1...devfeegrantaddress..."` placeholder -- is
// still caught, just at the point of use.
//
// Design note #1: `WalletContext.tsx` and `utils/sessionKey.ts` each carried
// their own copy. Not merely untidy: sessionKey's copy SCOPES the authz grant
// while WalletContext's SIGNS it, so drift would authorize a contract the app
// never calls.
//
// Design note #2: CRA substitutes `process.env.REACT_APP_FOO` textually, so the
// reads must be full literal expressions -- destructuring or dynamic indexing is
// NOT substituted and silently yields `undefined` in a production bundle.
// Changing a variable needs a REBUILD.
//
// Design note #3: validation is SHAPE-ONLY (prefix, charset, length). No bech32
// checksum -- the failure guarded against is a shipped placeholder or an unset
// variable, not a one-character typo, and the chain catches the latter clearly.
// NOTHING SECRET GOES HERE; everything ships to the browser in plain text.
//
// See docs/ai_architecture/session_keys_wallet.md, config.ts #0 - #3.

/** Bech32 human-readable prefix for the target chain. */
export const JUNO_PREFIX = "juno";

/** The chain's native fee/stake denom, and the exponent converting it to its
 *  display unit. `ujuno` -> `JUNO` is 6 decimals, matching the fixed-point
 *  scale the contract uses for VGP (`juno_developer_spec.md` §1). */
export const NATIVE_DENOM = "ujuno";
/** The application's own name, as a player and their wallet see it.
 *
 *  Design note #708: ONE PLACE, because it was in five and drifting was invisible. The wallet's signature
 *  prompts, the room-creation prompt, the join prompt and the transaction memo all spelled it out
 *  independently, so renaming meant finding every literal -- and a prompt that disagrees with the one before
 *  it is exactly the kind of thing a cautious user reads as a phishing attempt.
 *  BRANDING ONLY. The rules sentences elsewhere name the game in PROSE ("Project 18XX has no $0 dividend"),
 *  and reading those from a constant would make an ordinary sentence a template for no benefit. */
export const APP_NAME = "Project 18XX";

export const NATIVE_DENOM_DISPLAY = "JUNO";
export const NATIVE_DENOM_EXPONENT = 6;

/** Shape check for a bech32 address on `JUNO_PREFIX` -- see design note #3. */
function looksLikeJunoAddress(value: string): boolean {
  // `1` separator, then bech32's data charset, which excludes `1`, `b`, `i`
  // and `o` so they cannot be confused with `l`, `8`, `1` and `0`. A
  // placeholder like "juno1...eighteencosmos..." fails on the literal dots.
  return /^juno1[02-9ac-hj-np-z]{38,58}$/.test(value);
}

/** Reads a build-time value, normalising unset/blank to `undefined`. Never throws
 *  -- see design note #0.
 *
 *  EXPORTED for `config/firebase.ts`, which applies the identical deferred-read
 *  discipline to the `REACT_APP_FIREBASE_*` variables. If the definition of
 *  "unset" ever changes (say, treating the literal string "undefined" as blank --
 *  a real hazard when CI interpolates a missing variable), it must change in one
 *  place or the two config modules will disagree about whether the app is
 *  configured. Takes the already-read VALUE, never the name -- design note #2. */
export function readOptional(value: string | undefined): string | undefined {
  const trimmed = (value ?? "").trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/* ------------------------------------------------------------------ */
/* Raw values. Reading these NEVER throws. `undefined` means offline.   */
/* ------------------------------------------------------------------ */

/** The deployed 18Cosmos contract, or `undefined` when unconfigured.
 *
 *  `undefined` is a supported, meaningful state: `HexGridRenderer` takes it as
 *  the signal to run its offline tile-catalog fallback. Pass it straight through;
 *  do not coerce it to `""`. */
export const CONTRACT_ADDRESS = readOptional(process.env.REACT_APP_CONTRACT_ADDRESS);

/** The developer treasury that pays gas for session-key transactions.
 *
 *  MUST equal the contract's own `GameConfig::developer_treasury`. The contract
 *  funds this account from a percentage of every lobby deposit and this account
 *  grants fees back to players -- point these at two different addresses and the
 *  treasury fills while every player's transaction fails for want of a grant. */
export const DEVELOPER_FEE_GRANTER_ADDRESS = readOptional(process.env.REACT_APP_FEE_GRANTER);

/** Chain id for `keplr.enable` / `getOfflineSigner`. */
export const JUNO_CHAIN_ID = readOptional(process.env.REACT_APP_CHAIN_ID);

/** RPC endpoint both signing clients connect to. */
export const JUNO_RPC_ENDPOINT = readOptional(process.env.REACT_APP_RPC_ENDPOINT);

/** ==================================================================
 *   DESIGN NOTE 1213: THE CUTOVER IS A SETTING, NOT A REWRITE
 *  ==================================================================
 *
 * WHERE THE AUTHORITATIVE GAME SERVER LIVES, or `undefined` for the Firestore path this app has always used.
 *
 * ABSENT IS THE OLD BEHAVIOUR, EXACTLY. Every live room today appends to Firestore and reads it back
 * (#1026's transactional allocation, #522's "the log is the game"). That path is untouched while this is
 * unset, which is what makes the cutover something to try rather than something to bet on -- there is no way
 * to verify a browser transport from a test suite, and the honest response to that is a switch rather than
 * confidence.
 *
 * SET, AND THE ROOM ROUTES THROUGH THE SERVER: intents in, log entries out, the server allocating indices
 * and generating the game's own actions (#1209). The client still applies everything locally, because that
 * is what keeps the divergence check alive (#1207) -- it is not a thin renderer, it is a second opinion.
 *
 * A `ws://` OR `wss://` URL. `wss://` in anything public: the frames carry moves, and a room whose transport
 * can be read can be tampered with. */
export const GAME_SERVER_URL = readOptional(process.env.REACT_APP_GAME_SERVER_URL);

/** What build this client is, for #1206's skew check.
 *
 *  THE DIGEST COVERS THE WHOLE STATE, so a client one field behind the server disagrees about something that
 *  is not a divergence at all. Without a build on the wire that arrives as a phantom desync -- the exact
 *  thing this migration exists to stop people chasing.
 *
 *  FALLS BACK TO A CONSTANT rather than to a timestamp or a random value: two clients from one deploy must
 *  agree, and a value that changed per load would report skew against itself. Vercel sets
 *  `REACT_APP_VERCEL_GIT_COMMIT_SHA` when it is available. */
export const CLIENT_BUILD_ID =
  readOptional(process.env.REACT_APP_BUILD_ID) ??
  readOptional(process.env.REACT_APP_VERCEL_GIT_COMMIT_SHA) ??
  "dev";

/* ------------------------------------------------------------------ */
/* Required accessors. These throw, at the point of USE.                */
/* ------------------------------------------------------------------ */

function missing(name: string): never {
  throw new Error(
    `[config] ${name} is not set, so this app cannot talk to a chain. ` +
      "Add it to frontend/.env (see .env.example) and RESTART the dev server — " +
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
 *  `false` means offline mode: the tile catalog is browsable, wallet connection
 *  and transactions are unavailable. Use this to LABEL the UI honestly rather
 *  than to hide errors -- a user who sees "Offline" and a reason is informed; one
 *  who sees a dead Connect button is not. */
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
 *  INTEGER STRING MATH ONLY -- never `Number(amount) / 1e6`. `ujuno` amounts are
 *  `Uint128`, and any balance above 2^53 base units silently loses precision as
 *  an IEEE-754 double, showing the player the wrong amount of their own money.
 *
 *  Returns `"0.000000"` for malformed input rather than `NaN`, so a surprising
 *  RPC response degrades to an obviously-wrong-but-harmless zero. */
export function formatNativeAmount(baseAmount: string): string {
  const digits = baseAmount.trim();
  if (!/^\d+$/.test(digits)) return `0.${"0".repeat(NATIVE_DENOM_EXPONENT)}`;
  const padded = digits.padStart(NATIVE_DENOM_EXPONENT + 1, "0");
  const whole = padded.slice(0, padded.length - NATIVE_DENOM_EXPONENT);
  const fraction = padded.slice(padded.length - NATIVE_DENOM_EXPONENT);
  return `${whole.replace(/^0+(?=\d)/, "")}.${fraction}`;
}

/** `formatNativeAmount` with trailing fraction zeros trimmed: `40000000` ->
 *  `"40"`, `40500000` -> `"40.5"`, `1` -> `"0.000001"`.
 *
 *  For places reporting a POOL rather than a wallet balance. A wallet wants fixed
 *  decimals so successive balances line up in a column; a headline figure reading
 *  "40.000000 JUNO" is six characters of noise around the number.
 *
 *  Built on `formatNativeAmount` rather than dividing, so the no-floats
 *  discipline holds -- this only ever trims a string it was handed. */
export function formatNativeAmountCompact(baseAmount: string): string {
  const fixed = formatNativeAmount(baseAmount);
  if (!fixed.includes(".")) return fixed;
  // Trim the zeros, then the point itself if nothing survived it.
  return fixed.replace(/0+$/, "").replace(/\.$/, "");
}
