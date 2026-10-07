// server/src/testSupport/authorizationWallets.ts
//
// PHASE 3 FINAL test support (never imported by production code): Keplr accounts that sign ADR-036 exactly as Keplr's
// `signArbitrary` does, and the steps a browser takes to CREATE an account with its Authorization Wallet, RECOVER one
// ("Forgot password?") and REPLACE its Authorization Wallet -- at the identity service, and over real HTTP.

import { createHash } from "crypto";

import { adr036SignDocJson } from "../../../frontend/src/gameEngine/escrow/walletLinkChallengeV1";
import { parseProfileAuthorization } from "../../../frontend/src/utils/profileAuthorizationV1";
import { addressOfPublicKey } from "../escrow/juno/cosmosTx";
import { publicKeyOf, signDigest } from "../escrow/juno/secp256k1";
import type { SessionCookieRead } from "../identity/cookies";
import type { CreateAccountOutcome, IdentityService, RecoverAccountOutcome, ReplaceWalletOutcome } from "../identity/sessions";

/** The allow-listed origin the identity tests mint texts for. */
export const TEST_SITE = "https://play.example";

/** A Keplr account: its key, its address, and an ADR-036 signer exactly as `signArbitrary` signs. */
export interface KeplrAccount {
  readonly secret: Buffer;
  readonly pubkey: Buffer;
  readonly address: string;
  /** `signArbitrary(chain, address, text)`: {pubKey, signature} (base64). */
  sign(text: string): { readonly pubKey: string; readonly signature: string };
}

export function keplrAccount(label: string): KeplrAccount {
  const secret = createHash("sha256").update(`18COSMOS/TEST/wallet/${label}`).digest();
  const pubkey = publicKeyOf(secret);
  const address = addressOfPublicKey(pubkey, "juno");
  return {
    secret,
    pubkey,
    address,
    sign(text) {
      const digest = createHash("sha256").update(Buffer.from(adr036SignDocJson(address, text), "utf8")).digest();
      return { pubKey: pubkey.toString("base64"), signature: signDigest(secret, digest).toString("base64") };
    },
  };
}

/** Sign one minted text with `account` (the test plays Keplr). */
export const signText = (account: KeplrAccount, text: string) => account.sign(text);

/* ------------------------------------------------------------------ */
/* At the identity service                                             */
/* ------------------------------------------------------------------ */

/** Mint a CREATE text for this browser and the username, signed by `wallet`: what `createAccount` takes. */
export function createProof(identity: IdentityService, read: SessionCookieRead, username: string, wallet: KeplrAccount, now: number): { operation: string; pubKey: string; signature: string } {
  const minted = identity.mintAuthorization(read, { purpose: "create", username, wallet: wallet.address, site: TEST_SITE }, now);
  if (minted.kind !== "ok") throw new Error(`mint create: ${minted.kind}`);
  const fields = parseProfileAuthorization(minted.texts[0].text);
  if (fields === null || fields.purpose !== "CREATE" || fields.signer !== wallet.address) throw new Error("mint create: not a CREATE text for this wallet");
  return { operation: minted.operation, ...wallet.sign(minted.texts[0].text) };
}

/** Create an account at the service (mint, sign, create). */
export async function createAccountWith(
  identity: IdentityService,
  read: SessionCookieRead,
  input: { username: string; password: string; displayName?: string; wallet: KeplrAccount },
  now: number,
): Promise<CreateAccountOutcome> {
  const authorization = createProof(identity, read, input.username, input.wallet, now);
  return identity.createAccount(read, { username: input.username, password: input.password, displayName: input.displayName ?? input.username.slice(0, 24), authorization }, now);
}

/** "Forgot password?" at the service: mint a RECOVER text for (username, wallet), sign it with `signer` (normally the same
 *  wallet), and recover. */
export async function recoverWith(
  identity: IdentityService,
  read: SessionCookieRead,
  input: { username: string; wallet: KeplrAccount; signer?: KeplrAccount; newPassword: string },
  now: number,
): Promise<RecoverAccountOutcome | { kind: "mint-refused"; why: string }> {
  const minted = identity.mintAuthorization(read, { purpose: "recover", username: input.username, wallet: input.wallet.address, site: TEST_SITE }, now);
  if (minted.kind !== "ok") return { kind: "mint-refused", why: minted.kind };
  const signed = (input.signer ?? input.wallet).sign(minted.texts[0].text);
  return identity.recoverAccount(read, { operation: minted.operation, ...signed, newPassword: input.newPassword }, now);
}

/** "Change Authorization Wallet" at the service (the session must hold an explicit "Confirm it's you"). */
export async function replaceWith(
  identity: IdentityService,
  read: SessionCookieRead,
  input: { current: KeplrAccount; next: KeplrAccount; approveSigner?: KeplrAccount; acceptSigner?: KeplrAccount },
  now: number,
): Promise<ReplaceWalletOutcome | { kind: "mint-refused"; why: string }> {
  const minted = identity.mintReplacement(read, { newWallet: input.next.address, site: TEST_SITE }, now);
  if (minted.kind !== "ok") return { kind: "mint-refused", why: minted.kind };
  const approve = (input.approveSigner ?? input.current).sign(minted.texts[0].text);
  const accept = (input.acceptSigner ?? input.next).sign(minted.texts[1].text);
  return identity.replaceAuthorizationWallet(read, { operation: minted.operation, approve, accept }, now);
}
