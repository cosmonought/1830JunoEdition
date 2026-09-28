// frontend/src/gameEngine/escrow/junoWalletMessages.ts
//
// ==================================================================
//  ESCROW-4: THE ESCROW CONTRACT'S WALLET MESSAGES -- ONE SPELLING, SHARED BY THE SERVER AND THE BROWSER
// ==================================================================
//
// The frozen escrow 2.0.0 contract (`contracts/escrow/src/msg.rs`) takes these execute messages from a PLAYER'S wallet:
//
//   create_game       the creator's own deposit (the ante is the attached funds; the creator is chain seat 0)
//   join              a seat's deposit, carrying the hosted server's ADMISSION for this wallet (ESCROW-JOIN)
//   withdraw          a seat's own pre-Start refund of its NET deposit (the fee is never returned)
//   cancel            before Start: the creator at any time, anyone from the funding deadline on
//   set_consent_key   the seat's wallet replaces its consent key (FUNDING .. SETTLEABLE)
//   challenge         a seat disputes the stored settlement inside its window (the bond attached)
//   liveness_settle   a seat closes a stalled escrow (optionally carrying a newer signed checkpoint)
//   finalize          anyone, once the challenge window has closed (the same JSON the relayer sends)
//
// ESCROW-3B wrote these builders on the server (`server/src/escrow/juno/junoContract.ts`, which re-exports them from
// here). ESCROW-4 moves them here, unchanged byte for byte, because the BROWSER is what builds and signs them: the
// server never signs a wallet message, and the browser never signs bytes the server made (brief §11, §22). One module,
// so the two ends can never spell a message differently (`escrow3bCosmosTxParity.test.ts` and `junoCrypto.test.ts`
// pin the JSON).
//
// `chain_game_id` is a JSON INTEGER in the ABI (`u64` in msg.rs); it is spliced from its decimal string and never goes
// through a JavaScript number (a u64 does not fit one). Every hex field is checked for lowercase and exact length; a
// malformed field throws `JunoAbiError` rather than producing a message the contract would refuse.

import type { SettlementPayloadV1Wire } from "./settlementCoreV1";

export class JunoAbiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JunoAbiError";
  }
}

const DECIMAL = /^(0|[1-9][0-9]{0,19})$/;
const U64_MAX = (BigInt(1) << BigInt(64)) - BigInt(1);

/** Lowercase hex of exactly `bytes` bytes. */
export const hexOfLength = (bytes: number): RegExp => new RegExp(`^[0-9a-f]{${bytes * 2}}$`);
const HEX32 = hexOfLength(32);
const HEX33 = hexOfLength(33);
const HEX64 = hexOfLength(64);

/** A u64 decimal, checked, for writing as a bare JSON integer. */
export function u64Json(value: string, where: string): string {
  if (typeof value !== "string" || !DECIMAL.test(value) || BigInt(value) > U64_MAX) throw new JunoAbiError(`${where}=${String(value)} is not a u64 decimal`);
  return value;
}

export const hexField = (value: string, re: RegExp, where: string): string => {
  if (typeof value !== "string" || !re.test(value)) throw new JunoAbiError(`${where} is not lowercase hex of the right length`);
  return value;
};

/** `{"<variant>":{<fields>}}` with `chain_game_id` spliced as an integer (no JavaScript number in between). */
export function junoExecuteJson(variant: string, chainGameId: string | null, fields: Record<string, unknown>): string {
  const rest = JSON.stringify(fields);
  const inner = chainGameId === null ? rest : rest === "{}" ? `{"chain_game_id":${chainGameId}}` : `{"chain_game_id":${chainGameId},${rest.slice(1)}`;
  return `{"${variant}":${inner}}`;
}

/** The escrow's `mode` enum, from the neutral 0 (live) / 1 (async). */
export type JunoEscrowMode = 0 | 1;

/** Wallet execute messages: the PLAYER's wallet signs and pays for these; the server never signs them. */
export const WALLET_EXECUTE = Object.freeze({
  createGame: (a: { maxPlayers: number; mode: JunoEscrowMode; rulesEngineVersion: number; variantsDigest: string; consentPubkey: string; joinTicket: string }) => {
    if (!Number.isInteger(a.maxPlayers) || a.maxPlayers < 2 || a.maxPlayers > 7) throw new JunoAbiError("max_players");
    if (!Number.isInteger(a.rulesEngineVersion) || a.rulesEngineVersion < 0 || a.rulesEngineVersion > 0xffffffff) throw new JunoAbiError("rules_engine_version");
    return junoExecuteJson("create_game", null, {
      max_players: a.maxPlayers,
      mode: a.mode === 0 ? "live" : "async",
      rules_engine_version: a.rulesEngineVersion,
      variants_digest: hexField(a.variantsDigest, HEX32, "variants_digest"),
      consent_pubkey: hexField(a.consentPubkey, HEX33, "consent_pubkey"),
      join_ticket: hexField(a.joinTicket, HEX32, "join_ticket"),
    });
  },
  /** ESCROW-JOIN: the admission is the server's signature for THIS wallet (the transaction's sender), this game and this
   *  ticket until `expiresAt` (Unix seconds, a decimal string: a Uint64 on the wire). Without it the contract refuses. */
  join: (chainGameId: string, consentPubkey: string, joinTicket: string, admission: { readonly expiresAt: string; readonly signature: string }) =>
    junoExecuteJson("join", u64Json(chainGameId, "chain_game_id"), {
      consent_pubkey: hexField(consentPubkey, HEX33, "consent_pubkey"),
      join_ticket: hexField(joinTicket, HEX32, "join_ticket"),
      admission: { expires_at: u64Json(admission.expiresAt, "admission.expires_at"), signature: hexField(admission.signature, HEX64, "admission.signature") },
    }),
  withdraw: (chainGameId: string) => junoExecuteJson("withdraw", u64Json(chainGameId, "chain_game_id"), {}),
  cancel: (chainGameId: string) => junoExecuteJson("cancel", u64Json(chainGameId, "chain_game_id"), {}),
  setConsentKey: (chainGameId: string, newPubkey: string) => junoExecuteJson("set_consent_key", u64Json(chainGameId, "chain_game_id"), { new_pubkey: hexField(newPubkey, HEX33, "new_pubkey") }),
  challenge: (chainGameId: string, evidenceHash: string) => junoExecuteJson("challenge", u64Json(chainGameId, "chain_game_id"), { evidence_hash: hexField(evidenceHash, HEX32, "evidence_hash") }),
  livenessSettle: (chainGameId: string, checkpoint: { payload: SettlementPayloadV1Wire; signature: string } | null) =>
    junoExecuteJson("liveness_settle", u64Json(chainGameId, "chain_game_id"), { checkpoint: checkpoint === null ? null : { payload: checkpoint.payload, signature: hexField(checkpoint.signature, HEX64, "signature") } }),
  /** ESCROW-4: "Release payout" -- permissionless once the challenge window has closed; the very JSON the relayer's
   *  `finalize` sends (a player whose relayer is down pays the gas and releases everyone's payout). */
  finalize: (chainGameId: string) => junoExecuteJson("finalize", u64Json(chainGameId, "chain_game_id"), {}),
});

/** The wallet messages a browser may build, by name (the client's closed list: nothing outside it is ever signed). */
export type WalletMessageKind = keyof typeof WALLET_EXECUTE;
export const WALLET_MESSAGE_KINDS: readonly WalletMessageKind[] = Object.freeze(Object.keys(WALLET_EXECUTE) as WalletMessageKind[]);

/** Which wallet messages attach funds, and which funds: the deposit (the gross ante), the challenge bond, or none. The
 *  contract refuses funds on every other route (`NonPayable`), so a browser attaches nothing anywhere else. */
export const WALLET_MESSAGE_FUNDS: Readonly<Record<WalletMessageKind, "ante" | "bond" | "none">> = Object.freeze({
  createGame: "ante",
  join: "ante",
  withdraw: "none",
  cancel: "none",
  setConsentKey: "none",
  challenge: "bond",
  livenessSettle: "none",
  finalize: "none",
});
