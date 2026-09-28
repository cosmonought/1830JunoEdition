// frontend/src/utils/moneyProtocol.ts
//
// ==================================================================
//  ESCROW-4: THE REAL-MONEY TABLE ON THE WIRE -- WHAT THE SERVER PROJECTS, WHAT THE CLIENT MAY BELIEVE OF IT
// ==================================================================
//
// PURE: types and small readers -- no socket, no storage, no window. The server (`server/src/escrow/moneyTables.ts`)
// builds these projections from ITS state (the GameRecord's money terms, the financial record, the wallet-ticket ledger
// and its last chain observation); the client renders them. `server/src/rooms/live2dCutover.test.ts` makes the server's
// `RoomView` and this file's shapes assignable in both directions, so the two ends cannot drift.
//
// WHAT THE CLIENT MAY AND MAY NOT BELIEVE. A projection is the server's statement of what it knows; it is never an
// authority for the browser's own money actions:
//   - "funded" is the server's reading of the CHAIN (a transaction hash is only ever a hint);
//   - the deployment (chain, contract, checksum, denom) is checked by the browser against the deployment PINNED IN ITS
//     BUILD before anything is signed -- a table naming another escrow is refused, whatever the server says;
//   - a wallet message is always built by the browser from these neutral fields (`junoWalletMessages.ts`), never from
//     bytes the server sent.
//
// NO PRINCIPAL, NO SESSION, NO FAMILY ID, NO SECRET appears here. The viewer's own join ticket appears only in the
// viewer's own `you` block (it is bound to that one wallet and public on chain once used). Other seats show a status.

/** A table's escrow network class. Mainnet money is not enabled in this phase (the server refuses to create one). */
export type MoneyNetworkClass = "mainnet" | "testnet" | "local";

/** The eight escrow states (GNOLAND-1), plus the two the server says before it has a chain game or a fresh read. */
export type MoneyEscrowState = "unbound" | "unknown" | "FUNDING" | "FUNDED" | "IN_PROGRESS" | "SETTLEABLE" | "DISPUTED" | "SETTLED" | "CANCELLED" | "ANNULLED";

/** What the deployment pin says (the browser compares every field with its own pinned deployment). */
export interface MoneyDeploymentView {
  backend: "juno-cosmwasm";
  chainId: string;
  networkClass: MoneyNetworkClass;
  contract: string;
  codeChecksum: string;
  denom: string;
  symbol: string;
  /** Display exponent (6); never used in arithmetic. */
  exponent: number;
}

/** A seat's funding, as the server reads the chain (never from a browser's claim). */
export type MoneySeatFunding =
  /** No wallet linked. */
  | "none"
  /** A proven wallet is linked; no deposit seen. */
  | "linked"
  /** A deposit was reported sent (a hint); the chain has not shown it yet. */
  | "sent"
  /** The chain shows this seat's deposit under its standing ticket. */
  | "funded"
  /** The chain shows a deposit from this seat's wallet whose ticket no longer stands (a security event ended it). */
  | "unlinked";

export interface MoneySeatView {
  playerId: string;
  funding: MoneySeatFunding;
}

/** Why the table cannot start yet (null: it can). */
export type MoneyStartBlocker =
  | "escrow-not-open"
  | "need-seats"
  | "need-funding"
  | "unknown-deposit"
  | "unlinked-deposit"
  | "deposit-in-flight"
  | "deadline-near"
  | "funding-closed"
  | "paused"
  | "chain-unavailable"
  | "backend-unavailable"
  | "held";

export interface MoneyStartView {
  /** not-ready: something is missing; ready: fully funded and bound; starting: the roster is frozen and the Start is on
   *  its way to Juno; started: the chain shows it (the deal follows); rolled-back: the chain proved the last Start can
   *  never land -- the table is back to its funded pre-Start state. */
  state: "not-ready" | "ready" | "starting" | "started" | "rolled-back";
  blocker: MoneyStartBlocker | null;
  /** Server ms after which any funded player may press Start if the host has not (null: not applicable yet). */
  anyoneMayStartAt: number | null;
  /** Whether THIS viewer may press Start now (the host when ready; a funded player after the grace). */
  canStart: boolean;
  /** How many rosters were ever frozen (a rolled-back one leaves it above zero). */
  epoch: number;
}

/** The financial status under the game result (the result itself is final before any of this completes). */
export type MoneySettlementStatus =
  | "none"
  | "preparing"
  | "submitted"
  | "recorded"
  | "release-available"
  | "paid"
  | "disputed"
  | "held"
  | "paused"
  | "annulled"
  | "refunded"
  | "cancelled";

export interface MoneySettlementView {
  status: MoneySettlementStatus;
  /** The server's financial phase (operator vocabulary; the UI words it from `status`). */
  phase: string;
  chainState: MoneyEscrowState;
  /** The stored settlement's seq (2L+1 for our terminal; a promoted checkpoint's 2L after a liveness exit). */
  seq: string | null;
  /** The stored settlement's SETTLE digest (lowercase hex), what a consent signs over (with the domain and seq). */
  settleDigest: string | null;
  /** The escrow's domain (lowercase hex; null before Start). */
  domain: string | null;
  source: "terminal_payload" | "liveness_checkpoint" | string | null;
  /** Server ms. */
  windowEnd: number | null;
  livenessAvailableAt: number | null;
  resolverTimeoutAt: number | null;
  consentedSeats: number[];
  /** false: the stored settlement's signer key was retired as compromised (only the resolver can move it). */
  payable: boolean | null;
  /** Per chain seat, once the escrow has paid out or refunded (base units). */
  amounts: string[] | null;
  route: string | null;
  /** The chain's trusted sequence (what an ANNUL signature binds). */
  trustedSeq: string | null;
  /** ANNUL signatures collected so far (chain seat indices), for the current trusted sequence. */
  annulSigned: number[];
  /** The escrow's challenge bond (base units): exactly what a Dispute attaches. Null before the chain's Start. */
  bond: string | null;
  lastCheckpoint: { seq: string; logLen: number; roundKey: string; confirmed: boolean } | null;
}

/** The viewer's own money seat. */
export interface MoneyYouView {
  playerId: string;
  /** The seat's standing link (a PROVEN wallet), or null. `ticket` is what this seat's CreateGame/Join carries. */
  link: {
    wallet: string;
    epoch: number;
    ticket: string;
    /** Server ms when the link was made. */
    linkedAt: number;
    /** Consent keys registered for this seat (the initial one at the link; replacements after "Confirm it's you"). */
    consentKeys: string[];
  } | null;
  funding: MoneySeatFunding;
  /** The chain seat this seat's deposit holds (null until funded). Positions move until the roster freezes. */
  chainSeatIndex: number | null;
  /** The wallet the chain pays this seat (the depositor), once funded. After the freeze it can never change. */
  payoutWallet: string | null;
  /** The seat's CURRENT consent key on chain (compare with the keys this browser holds). */
  chainConsentKey: string | null;
  /** A deposit from one of this seat's earlier (no longer standing) wallets is on chain: relink or withdraw it. */
  unlinkedDeposit: { wallet: string } | null;
  /** A join admission that can still land on chain (server ms): this seat cannot be released or moved until then. */
  admissionUntil: number | null;
  /** A deposit hint the chain has not resolved yet. */
  pending: { kind: MoneyHintKind; txHash: string; at: number } | null;
  /** What the server says is legal for this seat now (the UI shows exactly these; the server still decides each). */
  actions: MoneyAction[];
}

export type MoneyHintKind = "create" | "join" | "withdraw" | "cancel" | "set-consent-key" | "challenge" | "liveness-settle" | "finalize";

export type MoneyAction =
  | "link-wallet"
  | "open-escrow"
  | "deposit"
  | "withdraw"
  | "cancel-escrow"
  | "refund-after-deadline"
  | "relink"
  | "start"
  | "move-signing-key"
  | "approve-payout"
  | "challenge"
  | "release-payout"
  | "liveness-settle"
  | "annul";

export interface RoomMoneyView {
  deployment: MoneyDeploymentView;
  terms: {
    /** Base units. */
    anteGross: string;
    /** The contract's cut of each deposit (basis points): the game's own once bound, else the deployment's current. */
    feeBps: number | null;
    /** Base units, once bound (what reaches the pot per seat). */
    anteNet: string | null;
    /** Base units: every seat's net deposit, once bound. */
    pot: string | null;
    mode: "live" | "async";
    seats: number;
    /** The smallest ante the contract accepts (base units), when known. */
    minAnte: string | null;
    /** The rules engine this table's escrow commits to: its frozen money continuation identity, which the host's
     *  CreateGame must carry (W-13 binds nothing else). The browser also checks its own build plays it. Null: unknown. */
    rulesEngineVersion: number | null;
  };
  escrow: {
    chainGameId: string | null;
    state: MoneyEscrowState;
    paused: boolean;
    /** Server ms (from the chain's deadline). */
    fundingDeadline: number | null;
    /** Server ms of the chain read these come from (null: never read). */
    observedAt: number | null;
    fundedSeats: number;
    /** Chain seats no standing seat of this table claims (a wallet the server admitted under a ticket since ended). */
    foreignSeats: number;
    /** Server ms when the escrow became fully funded (the chain's last join), or null. */
    fullyFundedAt: number | null;
  };
  seats: MoneySeatView[];
  start: MoneyStartView;
  settlement: MoneySettlementView | null;
  you: MoneyYouView | null;
  /** The money is held for an operator: this server starts, pays and refunds nothing for the table until reviewed
   *  (Juno's own exits -- withdraw, cancel, dispute, the inactivity exit -- still work). */
  held: boolean;
}

/** The lobby's stake badge (public list entries). */
export interface RoomStakeSummary {
  anteGross: string;
  symbol: string;
  exponent: number;
  networkClass: MoneyNetworkClass;
  funded: number;
  seats: number;
}

/** "Your tables": a money table's line. */
export interface MyTableMoneySummary {
  anteGross: string;
  symbol: string;
  exponent: number;
  networkClass: MoneyNetworkClass;
  /** The one thing to say about this seat's money. */
  /** `linked`: a wallet is linked and the host hasn't opened the escrow yet (nothing to do). */
  status: "link-wallet" | "linked" | "deposit" | "sent" | "funded" | "unlinked" | "starting" | "playing" | "settling" | "settled" | "held" | "cancelled";
  actionNeeded: boolean;
}

/* ==================================================================
    "YOUR DEPOSITS": the way back to money whose table is awkward or gone
   ================================================================== */

export interface MoneyDepositEntry {
  /** The hosted table (it may be expired, cancelled or archived). */
  gameId: string;
  /** Whether the table can still be opened. */
  tableOpen: boolean;
  deployment: MoneyDeploymentView;
  chainGameId: string;
  /** The wallet holding this chain seat (the payee). */
  wallet: string;
  /** Base units deposited (gross) and refundable now (net), as the chain says. */
  grossDeposit: string;
  netDeposit: string;
  chainState: MoneyEscrowState;
  /** Server ms. */
  fundingDeadline: number | null;
  /** bound: this table's escrow; duplicate: another escrow the same host wallet opened for this table (A-4). */
  relation: "bound" | "duplicate" | "unlinked";
  /** The creator's wallet may cancel any time before Start; anyone may after the deadline. */
  creator: boolean;
  actions: Array<"withdraw" | "cancel-escrow" | "refund-after-deadline" | "relink" | "open-table">;
}

/* ==================================================================
    READERS
   ================================================================== */

/** The deployment fields a browser compares with its pinned deployment, in one place (so no field is forgotten). */
export const DEPLOYMENT_FIELDS: readonly (keyof MoneyDeploymentView)[] = Object.freeze(["backend", "chainId", "networkClass", "contract", "codeChecksum", "denom", "symbol", "exponent"]);

/** Whether two deployment descriptions name the same escrow (every field). */
export function sameDeployment(a: MoneyDeploymentView, b: MoneyDeploymentView): boolean {
  return DEPLOYMENT_FIELDS.every((field) => a[field] === b[field]);
}

/** "10 JUNOX" from base units and an exponent -- integer arithmetic only (no float ever touches an amount). */
export function formatAmount(base: string | bigint | null | undefined, exponent: number, symbol: string): string {
  const text = typeof base === "bigint" ? base.toString() : typeof base === "string" && /^[0-9]{1,40}$/.test(base) ? base.replace(/^0+(?=\d)/, "") : null;
  if (text === null) return `— ${symbol}`;
  const exp = Number.isInteger(exponent) && exponent >= 0 && exponent <= 18 ? exponent : 6;
  const padded = text.padStart(exp + 1, "0");
  const whole = padded.slice(0, padded.length - exp);
  const fraction = padded.slice(padded.length - exp).replace(/0+$/, "");
  return `${whole}${fraction ? `.${fraction}` : ""} ${symbol}`;
}

/** A decimal amount a person typed ("10", "0.5", "12.345678") as base units, or null when it is not one. Strict: no
 *  sign, no exponent, no separators, at most `exponent` places, and never "0" -- a malformed entry is refused, never
 *  turned into zero (preflight §0 item 14). */
export function parseAmountToBase(typed: string, exponent: number): string | null {
  const text = typeof typed === "string" ? typed.trim() : "";
  const match = /^([0-9]{1,24})(?:\.([0-9]+))?$/.exec(text);
  if (match === null) return null;
  const fraction = match[2] ?? "";
  if (fraction.length > exponent) return null;
  const base = `${match[1]}${fraction.padEnd(exponent, "0")}`.replace(/^0+(?=\d)/, "");
  return /^0+$/.test(base) ? null : base;
}

/** The fee on one deposit, in base units, as the contract computes it: floor(gross * bps / 10000). */
export function feeOf(anteGross: string, feeBps: number): string {
  if (!/^[0-9]{1,40}$/.test(anteGross) || !Number.isInteger(feeBps) || feeBps < 0 || feeBps > 10_000) return "0";
  return ((BigInt(anteGross) * BigInt(feeBps)) / BigInt(10_000)).toString();
}

/** What reaches the pot from one deposit (gross minus the fee). */
export function netOf(anteGross: string, feeBps: number): string {
  if (!/^[0-9]{1,40}$/.test(anteGross)) return "0";
  return (BigInt(anteGross) - BigInt(feeOf(anteGross, feeBps))).toString();
}

/** A short wallet for display: "juno1abcd…wxyz". */
export function shortWallet(wallet: string | null | undefined): string {
  if (typeof wallet !== "string" || wallet.length < 16) return wallet ?? "";
  return `${wallet.slice(0, 9)}…${wallet.slice(-4)}`;
}
