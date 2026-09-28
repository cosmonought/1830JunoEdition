// frontend/src/money/walletChecks.ts
//
// ==================================================================
//  ESCROW-4: WHAT THE BROWSER CHECKS FOR ITSELF BEFORE KEPLR SIGNS ANYTHING, AND THE MESSAGES IT BUILDS
// ==================================================================
//
// PURE. The server is the authority for the table; it is never the authority for what THIS browser signs. Every
// wallet message is built here from neutral fields (`gameEngine/escrow/junoWalletMessages.ts`, the one spelling the
// server's own relayer shares), against the deployment pinned into this bundle, after checking that:
//
//   the link challenge   names this site, the pinned network and contract, this table, this seat, the account Keplr
//                        is on, and a future expiry -- and is otherwise exactly the v1 text (a server cannot get a
//                        link for another table, another site or another wallet signed through this page);
//   the table            is on the pinned escrow (every deployment field), with a canonical ante, an exact seat
//                        count and a rules engine this page plays and settlement certifies;
//   a CreateGame         carries the variants digest this browser computes from the table's own variants, the
//                        table's frozen rules version, its exact seat count and pace, this seat's ticket and a
//                        signing key this browser holds;
//   a Join admission     names the pinned chain and contract, the table's bound escrow game, the wallet Keplr will
//                        send from, this seat's ticket, and has time left; its signature is checked against the key it
//                        names (a consistency check -- the contract checks it against its own configuration);
//   the chain game       (read by this browser from the pinned RPC) is FUNDING with the table's exact terms before a
//                        Join is signed, so a deposit is never sent into an escrow that disagrees with the table.
//
// A failed check is a sentence a player can read, and nothing is signed.

import { Secp256k1, Secp256k1Signature } from "@cosmjs/crypto";
import { fromHex } from "@cosmjs/encoding";

import { parseWalletLinkChallenge, WALLET_LINK_TAG_V1, type WalletLinkChallengeFields } from "../gameEngine/escrow/walletLinkChallengeV1";
import { WALLET_EXECUTE, WALLET_MESSAGE_FUNDS, JunoAbiError, type WalletMessageKind } from "../gameEngine/escrow/junoWalletMessages";
import { joinAdmissionDigestV1 } from "../gameEngine/escrow/junoJoinAdmissionV1";
import { variantsDigestV1 } from "../gameEngine/escrow/variantsDigest";
import { SUPPORTED_RULES_ENGINE_VERSIONS } from "../gameEngine/rulesVersion";
import { SETTLEMENT_CERTIFIED_RULES_ENGINE_VERSIONS } from "../gameEngine/settlementAppraisal";
import type { GameVariants } from "../gameEngine/gameVariants";
import type { MoneyHintKind, RoomMoneyView } from "../utils/moneyProtocol";
import { deploymentMismatch, type PinnedEscrowDeployment } from "./escrowDeployment";
import type { JoinAdmission } from "./moneyApi";

export type Checked<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string };
const no = <T>(reason: string): Checked<T> => ({ ok: false, reason });
const yes = <T>(value: T): Checked<T> => ({ ok: true, value });

const DECIMAL = /^[1-9][0-9]{0,29}$/;
const U64 = /^[1-9][0-9]{0,19}$/;
const HEX32 = /^[0-9a-f]{64}$/;
const PUBKEY = /^0[23][0-9a-f]{64}$/;
/** A Join admission needs at least this long left, so the transaction lands before it lapses. */
export const ADMISSION_MIN_LEFT_MS = 60_000;

/* ==================================================================
    THE LINK CHALLENGE
   ================================================================== */

export interface LinkExpectation {
  readonly appName: string;
  /** This page's origin (`window.location.origin`). */
  readonly site: string;
  readonly pin: PinnedEscrowDeployment;
  readonly gameId: string;
  readonly playerId: string;
  /** The account Keplr is on (the wallet being linked). */
  readonly wallet: string;
  readonly now: number;
}

/** The challenge text, parsed, when it is exactly the v1 text for THIS request (else a sentence, and nothing signed). */
export function checkLinkChallenge(text: string, expect: LinkExpectation): Checked<WalletLinkChallengeFields> {
  const fields = parseWalletLinkChallenge(text);
  if (fields === null) return no(`The link message isn't a ${WALLET_LINK_TAG_V1} message, so it wasn't signed.`);
  if (fields.appName !== expect.appName) return no("The link message names another app, so it wasn't signed.");
  if (fields.site !== expect.site) return no(`The link message names another site (${fields.site}), so it wasn't signed.`);
  if (fields.chainId !== expect.pin.chainId) return no(`The link message names another network (${fields.chainId}), so it wasn't signed.`);
  if (fields.contract !== expect.pin.contract) return no("The link message names another escrow contract, so it wasn't signed.");
  if (fields.gameId !== expect.gameId) return no("The link message names another table, so it wasn't signed.");
  if (fields.playerId !== expect.playerId) return no("The link message names another seat, so it wasn't signed.");
  if (fields.wallet !== expect.wallet) return no("The link message names another wallet than the one Keplr is on, so it wasn't signed.");
  if (fields.expiresAt <= expect.now) return no("The link message has already expired. Start the link again.");
  return yes(fields);
}

/* ==================================================================
    THE TABLE
   ================================================================== */

/** Why this browser won't sign for this table at all (null: it may). */
export function tableSigningProblem(pin: PinnedEscrowDeployment, view: RoomMoneyView): string | null {
  const field = deploymentMismatch(pin, view.deployment);
  if (field !== null) return `This table points at an escrow this app wasn't built for (its ${field} differs), so nothing will be signed for it here.`;
  if (!DECIMAL.test(view.terms.anteGross)) return "This table's stake isn't a whole amount, so nothing will be signed for it.";
  if (!Number.isInteger(view.terms.seats) || view.terms.seats < 2 || view.terms.seats > 6) return "This table's seat count isn't one an escrow can hold, so nothing will be signed for it.";
  if (view.terms.mode !== "live" && view.terms.mode !== "async") return "This table's pace isn't one an escrow knows, so nothing will be signed for it.";
  return null;
}

/** The rules engine a CreateGame must commit to: the table's frozen one, and one this page both plays and settles. */
export function rulesVersionForEscrow(view: RoomMoneyView): Checked<number> {
  const version = view.terms.rulesEngineVersion;
  if (version === null || !Number.isSafeInteger(version)) return no("The table's rules version isn't known yet. Try again in a moment.");
  if (!SUPPORTED_RULES_ENGINE_VERSIONS.includes(version)) return no("This table plays a rules version this page doesn't. Reload the page to get the current version.");
  if (!SETTLEMENT_CERTIFIED_RULES_ENGINE_VERSIONS.includes(version)) return no("This table's rules version isn't certified for real-money settlement, so nothing will be signed.");
  return yes(version);
}

/* ==================================================================
    THE MESSAGES (built here, never taken from a server)
   ================================================================== */

export interface WalletMessage {
  readonly kind: WalletMessageKind;
  /** The deposit-hint kind the server is told after the broadcast. */
  readonly hint: MoneyHintKind;
  /** The exact execute JSON (the contract's ABI; `chain_game_id` a JSON integer). */
  readonly msgJson: string;
  readonly funds: readonly { readonly denom: string; readonly amount: string }[];
  readonly chainGameId: string | null;
  /** The signing key the message carries (CreateGame, Join, SetConsentKey), or null. */
  readonly consentKey: string | null;
}

const HINT_OF: Readonly<Record<WalletMessageKind, MoneyHintKind>> = Object.freeze({
  createGame: "create",
  join: "join",
  withdraw: "withdraw",
  cancel: "cancel",
  setConsentKey: "set-consent-key",
  challenge: "challenge",
  livenessSettle: "liveness-settle",
  finalize: "finalize",
});

function message(kind: WalletMessageKind, msgJson: string, pin: PinnedEscrowDeployment, amounts: { ante?: string; bond?: string | null }, chainGameId: string | null, consentKey: string | null): Checked<WalletMessage> {
  const rule = WALLET_MESSAGE_FUNDS[kind];
  let funds: WalletMessage["funds"] = [];
  if (rule === "ante") {
    if (amounts.ante === undefined || !DECIMAL.test(amounts.ante)) return no("The deposit amount isn't a whole amount, so nothing was signed.");
    funds = [{ denom: pin.denom, amount: amounts.ante }];
  } else if (rule === "bond") {
    /* The game's frozen bond, exactly; a zero bond means no funds at all (the contract refuses any then). */
    if (amounts.bond === "0") funds = [];
    else if (typeof amounts.bond !== "string" || !DECIMAL.test(amounts.bond)) return no("The escrow's dispute bond isn't known yet, so nothing was signed.");
    else funds = [{ denom: pin.denom, amount: amounts.bond }];
  }
  return yes(Object.freeze({ kind, hint: HINT_OF[kind], msgJson, funds: Object.freeze(funds), chainGameId, consentKey }));
}

const guard = <T>(build: () => T): Checked<T> => {
  try {
    return yes(build());
  } catch (error) {
    return no(error instanceof JunoAbiError ? `The message couldn't be built (${error.message}), so nothing was signed.` : "The message couldn't be built, so nothing was signed.");
  }
};

/** The host's CreateGame: the host's own deposit opens the table's escrow (the host is chain seat 0). */
export function createGameMessage(pin: PinnedEscrowDeployment, view: RoomMoneyView, variants: GameVariants, consentKey: string): Checked<WalletMessage> {
  const table = tableSigningProblem(pin, view);
  if (table !== null) return no(table);
  const link = view.you?.link ?? null;
  if (link === null) return no("Link your wallet to this seat first.");
  if (!PUBKEY.test(consentKey)) return no("This browser's signing key isn't valid, so nothing was signed.");
  const rules = rulesVersionForEscrow(view);
  if (!rules.ok) return rules;
  let digest: string;
  try {
    digest = variantsDigestV1(variants);
  } catch {
    return no("This table's rules can't be committed to an escrow, so nothing was signed.");
  }
  const json = guard(() =>
    WALLET_EXECUTE.createGame({ maxPlayers: view.terms.seats, mode: view.terms.mode === "live" ? 0 : 1, rulesEngineVersion: rules.value, variantsDigest: digest, consentPubkey: consentKey, joinTicket: link.ticket }),
  );
  if (!json.ok) return json;
  return message("createGame", json.value, pin, { ante: view.terms.anteGross }, null, consentKey);
}

/** Why an admission must not be used for this Join (null: it may). Checks every field against what THIS browser
 *  expects, then the signature against the key the admission names over the digest recomputed here. */
export async function admissionProblem(
  pin: PinnedEscrowDeployment,
  view: RoomMoneyView,
  admission: JoinAdmission,
  /** `admissionKey`: the key the escrow's own configuration on Juno names (read through the pinned endpoint). */
  expect: { readonly wallet: string; readonly now: number; readonly admissionKey: string | null },
): Promise<string | null> {
  const link = view.you?.link ?? null;
  const chainGameId = view.escrow.chainGameId;
  if (link === null) return "Link your wallet to this seat first.";
  if (chainGameId === null) return "The host hasn't opened the table on Juno yet.";
  if (admission.chain_id !== pin.chainId) return "The join approval names another network, so it wasn't used.";
  if (admission.contract !== pin.contract) return "The join approval names another escrow contract, so it wasn't used.";
  if (admission.chain_game_id !== chainGameId) return "The join approval names another escrow game than this table's, so it wasn't used.";
  if (admission.wallet !== expect.wallet || admission.wallet !== link.wallet) return "The join approval is for another wallet than the one Keplr is on, so it wasn't used.";
  if (admission.join_ticket !== link.ticket) return "The join approval is for another seat ticket, so it wasn't used.";
  if (!U64.test(admission.expires_at) || !/^[0-9a-f]{128}$/.test(admission.signature) || !PUBKEY.test(admission.admission_pubkey)) return "The join approval isn't well formed, so it wasn't used.";
  /* The contract verifies a Join against ITS admission key: an approval under any other key -- the server's word for
     which key that is included -- can only fail on chain (and cost the network fee). */
  if (expect.admissionKey === null || admission.admission_pubkey.toLowerCase() !== expect.admissionKey) return "The join approval isn't signed by the key Juno's escrow trusts, so it wasn't used.";
  const expiresMs = Number(admission.expires_at) * 1000;
  if (!Number.isSafeInteger(expiresMs) || expiresMs - expect.now < ADMISSION_MIN_LEFT_MS) return "The join approval is about to expire. Ask for a new one (Deposit again).";
  let digest: string;
  try {
    digest = joinAdmissionDigestV1({ chain_id: pin.chainId, contract_addr: pin.contract, chain_game_id: BigInt(chainGameId), wallet: expect.wallet, join_ticket: link.ticket, expires_at: BigInt(admission.expires_at) });
  } catch {
    return "The join approval couldn't be checked, so it wasn't used.";
  }
  try {
    const valid = await Secp256k1.verifySignature(Secp256k1Signature.fromFixedLength(fromHex(admission.signature)), fromHex(digest), fromHex(expect.admissionKey));
    if (!valid) return "The join approval's signature doesn't check out, so it wasn't used.";
  } catch {
    return "The join approval's signature doesn't check out, so it wasn't used.";
  }
  return null;
}

/** A seat's Join, carrying the server's admission (checked first by `admissionProblem`). */
export function joinMessage(pin: PinnedEscrowDeployment, view: RoomMoneyView, admission: JoinAdmission, consentKey: string): Checked<WalletMessage> {
  const table = tableSigningProblem(pin, view);
  if (table !== null) return no(table);
  const link = view.you?.link ?? null;
  if (link === null) return no("Link your wallet to this seat first.");
  if (!PUBKEY.test(consentKey)) return no("This browser's signing key isn't valid, so nothing was signed.");
  const json = guard(() => WALLET_EXECUTE.join(admission.chain_game_id, consentKey, link.ticket, { expiresAt: admission.expires_at, signature: admission.signature }));
  if (!json.ok) return json;
  return message("join", json.value, pin, { ante: view.terms.anteGross }, admission.chain_game_id, consentKey);
}

const chainGame = (chainGameId: string | null | undefined): Checked<string> => (typeof chainGameId === "string" && U64.test(chainGameId) ? yes(chainGameId) : no("This table has no escrow on Juno yet."));

export function withdrawMessage(pin: PinnedEscrowDeployment, chainGameId: string | null): Checked<WalletMessage> {
  const id = chainGame(chainGameId);
  if (!id.ok) return id;
  return message("withdraw", WALLET_EXECUTE.withdraw(id.value), pin, {}, id.value, null);
}

export function cancelMessage(pin: PinnedEscrowDeployment, chainGameId: string | null): Checked<WalletMessage> {
  const id = chainGame(chainGameId);
  if (!id.ok) return id;
  return message("cancel", WALLET_EXECUTE.cancel(id.value), pin, {}, id.value, null);
}

export function setConsentKeyMessage(pin: PinnedEscrowDeployment, chainGameId: string | null, newKey: string): Checked<WalletMessage> {
  const id = chainGame(chainGameId);
  if (!id.ok) return id;
  if (!PUBKEY.test(newKey)) return no("This browser's new signing key isn't valid, so nothing was signed.");
  return message("setConsentKey", WALLET_EXECUTE.setConsentKey(id.value, newKey), pin, {}, id.value, newKey);
}

export function challengeMessage(pin: PinnedEscrowDeployment, chainGameId: string | null, evidenceHash: string, bond: string | null): Checked<WalletMessage> {
  const id = chainGame(chainGameId);
  if (!id.ok) return id;
  if (!HEX32.test(evidenceHash)) return no("The dispute's evidence couldn't be recorded, so nothing was signed.");
  return message("challenge", WALLET_EXECUTE.challenge(id.value, evidenceHash), pin, { bond }, id.value, null);
}

/** The liveness exit with no checkpoint of this browser's own: the chain promotes the best checkpoint it holds. */
export function livenessSettleMessage(pin: PinnedEscrowDeployment, chainGameId: string | null): Checked<WalletMessage> {
  const id = chainGame(chainGameId);
  if (!id.ok) return id;
  return message("livenessSettle", WALLET_EXECUTE.livenessSettle(id.value, null), pin, {}, id.value, null);
}

export function finalizeMessage(pin: PinnedEscrowDeployment, chainGameId: string | null): Checked<WalletMessage> {
  const id = chainGame(chainGameId);
  if (!id.ok) return id;
  return message("finalize", WALLET_EXECUTE.finalize(id.value), pin, {}, id.value, null);
}

/* ==================================================================
    THE CHAIN, READ BY THIS BROWSER
   ================================================================== */

/** The fields of a chain `Game` answer this browser checks (read from the pinned RPC, never from the server). */
export interface ChainGameFacts {
  readonly state: string;
  readonly creator: string;
  readonly maxPlayers: number;
  readonly mode: "live" | "async";
  readonly rulesEngineVersion: number;
  readonly variantsDigest: string;
  readonly denom: string;
  readonly anteGross: string;
  readonly seats: readonly { readonly wallet: string; readonly joinTicket: string; readonly consentPubkey: string }[];
  /** Server-independent: the chain's own deadline (ms), or null. */
  readonly fundingDeadlineMs: number | null;
  readonly paused: boolean;
  /** The game's settlement domain (lowercase hex; it commits to this chain, contract and escrow game), once started. */
  readonly domain: string | null;
  /** The highest sequence the escrow trusts (decimal), for ANNUL. */
  readonly trustedSeq: string | null;
  /** The settlement Juno stores for the game, if any: its sequence and payload digest (review S-H1: what a device
   *  approves is what the chain holds, read here). */
  readonly settlement: { readonly seq: string; readonly payloadDigest: string } | null;
}

const nanosToMs = (value: unknown): number | null => (typeof value === "string" && /^[0-9]{1,30}$/.test(value) ? Number(BigInt(value) / BigInt(1_000_000)) : null);

/** A chain `GameResponse`, read tolerantly for the checked fields only (null: not one). */
export function chainGameFactsOf(raw: unknown): ChainGameFacts | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const g = r.game as Record<string, unknown> | undefined;
  const d = r.deadlines as Record<string, unknown> | undefined;
  if (typeof g !== "object" || g === null || typeof d !== "object" || d === null) return null;
  if (typeof g.state !== "string" || typeof g.creator !== "string" || typeof g.max_players !== "number" || (g.mode !== "live" && g.mode !== "async")) return null;
  if (typeof g.rules_engine_version !== "number" || typeof g.variants_digest !== "string" || typeof g.denom !== "string" || typeof g.ante_gross !== "string" || !Array.isArray(g.seats)) return null;
  const seats = g.seats.map((seat) => {
    const s = seat as Record<string, unknown>;
    return { wallet: String(s?.wallet ?? ""), joinTicket: String(s?.join_ticket ?? "").toLowerCase(), consentPubkey: String(s?.consent_pubkey ?? "").toLowerCase() };
  });
  const hex32 = (value: unknown): string | null => (typeof value === "string" && /^[0-9a-fA-F]{64}$/.test(value) ? value.toLowerCase() : null);
  const decimal = (value: unknown): string | null => (typeof value === "string" && /^(0|[1-9][0-9]{0,19})$/.test(value) ? value : null);
  const stored = g.settlement as Record<string, unknown> | null | undefined;
  const payload = typeof stored === "object" && stored !== null ? (stored.payload as Record<string, unknown> | undefined) : undefined;
  const storedSeq = typeof payload === "object" && payload !== null ? decimal(payload.seq) : null;
  const storedDigest = typeof payload === "object" && payload !== null ? hex32(payload.payload_digest) : null;
  return {
    state: g.state.toUpperCase(),
    creator: g.creator,
    maxPlayers: g.max_players,
    mode: g.mode,
    rulesEngineVersion: g.rules_engine_version,
    variantsDigest: g.variants_digest.toLowerCase(),
    denom: g.denom,
    anteGross: g.ante_gross,
    seats,
    fundingDeadlineMs: nanosToMs(d.funding_deadline),
    paused: r.paused === true,
    domain: hex32(g.domain),
    trustedSeq: decimal(r.trusted_seq),
    settlement: storedSeq !== null && storedDigest !== null ? { seq: storedSeq, payloadDigest: storedDigest } : null,
  };
}

/** Why a Join must not be sent into this chain game (null: it matches the table exactly and is taking deposits). */
export function chainGameProblemForJoin(pin: PinnedEscrowDeployment, view: RoomMoneyView, variants: GameVariants, facts: ChainGameFacts, wallet: string, now: number): string | null {
  if (facts.state !== "FUNDING") return "The table's escrow on Juno isn't taking deposits right now, so nothing was sent.";
  if (facts.paused) return "Deposits are paused on Juno right now, so nothing was sent. Try again later.";
  if (facts.fundingDeadlineMs !== null && facts.fundingDeadlineMs <= now) return "Funding for this table has closed on Juno, so nothing was sent.";
  if (facts.denom !== pin.denom || facts.anteGross !== view.terms.anteGross) return "The escrow on Juno asks for a different deposit than this table shows, so nothing was sent.";
  if (facts.maxPlayers !== view.terms.seats || facts.mode !== view.terms.mode) return "The escrow on Juno is for a different table (seats or pace), so nothing was sent.";
  if (view.terms.rulesEngineVersion === null || facts.rulesEngineVersion !== view.terms.rulesEngineVersion) return "The escrow on Juno commits to a different rules version than this table, so nothing was sent.";
  let digest: string;
  try {
    digest = variantsDigestV1(variants);
  } catch {
    return "This table's rules can't be checked against Juno, so nothing was sent.";
  }
  if (facts.variantsDigest !== digest) return "The escrow on Juno commits to different house rules than this table, so nothing was sent.";
  if (facts.seats.some((seat) => seat.wallet === wallet)) return "This wallet already holds a seat on this table's escrow.";
  if (facts.seats.length >= facts.maxPlayers) return "The table's escrow on Juno is already full, so nothing was sent.";
  return null;
}

/* ==================================================================
    WORDS
   ================================================================== */

/** A short, honest description of what a wallet message does (the confirm line above "Approve in Keplr"). */
export function walletMessagePurpose(kind: WalletMessageKind): string {
  switch (kind) {
    case "createGame":
      return "Open this table's escrow on Juno with your deposit";
    case "join":
      return "Deposit into this table's escrow on Juno";
    case "withdraw":
      return "Withdraw your deposit (minus the fee)";
    case "cancel":
      return "Cancel the table's escrow on Juno (every deposit comes back minus the fee)";
    case "setConsentKey":
      return "Move this seat's signing key to this device";
    case "challenge":
      return "Dispute the payout recorded on Juno (the bond is attached)";
    case "livenessSettle":
      return "Close the stalled table on Juno and pay from the last recorded standings";
    case "finalize":
      return "Release the payout recorded on Juno";
    default:
      return "Sign a transaction";
  }
}
