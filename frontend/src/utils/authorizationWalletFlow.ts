// frontend/src/utils/authorizationWalletFlow.ts
//
// ==================================================================
//  PHASE 3 FINAL: THE AUTHORIZATION WALLET IN THE BROWSER -- CONNECT, CHECK, SIGN (KEPLR, ADR-036)
// ==================================================================
//
// The account's AUTHORIZATION WALLET signs only three account actions: creating the account, "Forgot password?" and
// approving its own replacement (`utils/profileAuthorizationV1.ts` has the texts; `utils/profileApi.ts` the routes). This
// file is the Keplr half, through the same adapter the money seats use (`money/keplrWallet.ts`, on this build's pinned
// Juno network) and inside the same cross-tab Keplr lock (`money/keplrLock.ts`):
//
//   keplrAccountNow   connect Keplr if asked (an explicit press only) and read the account it is on NOW -- what can sign
//                     right now, and nothing more. The answer is never stored as anyone's identity: it is transient
//                     signer state, re-read before every signature.
//   signAuthorization check the server's text against exactly what this page asked for (the purpose, this site, the
//                     account, the signer Keplr is on, the wallet being designated), and only then ask Keplr to sign it.
//
// Nothing here moves funds, asks for a transaction, or touches the seed phrase: an ADR-036 signature has an empty chain
// id and a `sign/MsgSignData` message, so it can never be a transaction, and Keplr keeps the private key.

import { KEPLR_BUSY_SENTENCE, browserKeplrLock } from "../money/keplrLock";
import { moneyServices } from "../money/moneySession";
import type { WalletFailure } from "../money/keplrWallet";
import { checkProfileAuthorization, type ProfileAuthorizationExpectation } from "./profileAuthorizationV1";

export type KeplrNow = { readonly ok: true; readonly address: string } | { readonly ok: false; readonly reason: string; readonly code?: string };
export type SignedAuthorization = { readonly ok: true; readonly signed: { readonly pubKey: string; readonly signature: string } } | { readonly ok: false; readonly reason: string };

/** The site a text must name: this page's own origin. */
export function currentSite(): string {
  return typeof window !== "undefined" && window.location ? window.location.origin : "";
}

/** A Keplr failure, in account words. */
function sentenceOf(failure: WalletFailure, doing: "connect" | "sign"): string {
  switch (failure.code) {
    case "not-installed":
      return "Keplr isn't available in this browser. Install the Keplr extension (or open this site in the Keplr app's browser) to continue.";
    case "rejected":
      return doing === "connect" ? "Keplr didn't connect. Nothing was shared." : "You declined the signature in Keplr. Nothing was changed.";
    case "wrong-account":
      return "Keplr signed with another account than the one shown. Nothing was changed — check which account Keplr is on and try again.";
    case "unsupported":
      return "This Keplr account can't sign a message (for example, some hardware wallets). Use another Keplr account.";
    case "no-account":
      return "Keplr has no account for this network. Add one in Keplr, then try again.";
    default:
      return failure.reason;
  }
}

/** Connect (when `connect`) and read the Keplr account this browser is on now. Inside the cross-tab Keplr lock. */
export async function keplrAccountNow(connect: boolean): Promise<KeplrNow> {
  const services = moneyServices();
  const pinned = services.pin();
  if (!pinned.ok) return { ok: false, reason: "This site isn't set up for a Juno network yet, so Keplr can't be used here." };
  const locked = await (services.keplrLock ?? browserKeplrLock()).withLock(async (): Promise<KeplrNow> => {
    const answer = connect ? await services.wallet.connect(pinned.pin) : await services.wallet.account(pinned.pin);
    return answer.ok ? { ok: true, address: answer.value.address } : { ok: false, reason: sentenceOf(answer, "connect"), code: answer.code };
  });
  return locked.kind === "ran" ? locked.value : { ok: false, reason: KEPLR_BUSY_SENTENCE };
}

/** Check one minted text against what this page asked for, then have Keplr sign it with `expected.signer`. */
export async function signAuthorization(text: string, expected: Omit<ProfileAuthorizationExpectation, "now" | "site">): Promise<SignedAuthorization> {
  const services = moneyServices();
  const pinned = services.pin();
  if (!pinned.ok) return { ok: false, reason: "This site isn't set up for a Juno network yet, so Keplr can't be used here." };
  const refusal = checkProfileAuthorization(text, { ...expected, site: currentSite(), now: services.now() });
  if (refusal !== null) return { ok: false, reason: refusal };
  const locked = await (services.keplrLock ?? browserKeplrLock()).withLock(async (): Promise<SignedAuthorization> => {
    const signed = await services.wallet.signLink(pinned.pin, expected.signer, text);
    return signed.ok ? { ok: true, signed: signed.value } : { ok: false, reason: sentenceOf(signed, "sign") };
  });
  return locked.kind === "ran" ? locked.value : { ok: false, reason: KEPLR_BUSY_SENTENCE };
}

/** A wallet address, shortened for a sentence (`juno1abcd…wxyz`). */
export function shortWallet(address: string): string {
  return address.length > 16 ? `${address.slice(0, 10)}…${address.slice(-6)}` : address;
}
