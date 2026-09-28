// frontend/src/utils/escrow3bCosmosTxParity.test.ts
//
// ==================================================================
//  ESCROW-3B: THE SERVER'S HAND-ENCODED COSMOS TRANSACTION AND ITS KEYS, BYTE FOR BYTE AGAINST COSMJS
// ==================================================================
//
// The Juno relayer (`server/src/escrow/juno/`) carries no chain library: it encodes its one transaction shape
// (MsgExecuteContract, SIGN_MODE_DIRECT, a timeout height) and signs with its own RFC 6979 secp256k1. This suite pins
// every byte of that against the libraries the frontend already carries -- cosmjs-types for the protobuf, @cosmjs/
// proto-signing for the SignDoc, @cosmjs/crypto for the signatures and the HD path, @cosmjs/encoding for bech32 -- so
// a divergence in any field order, zero-omission, varint or signature fails here by name. Nothing is broadcast.

import { createHash } from "crypto";
import { Secp256k1, Secp256k1Signature, Bip39, EnglishMnemonic, Slip10, Slip10Curve, stringToPath, sha256 } from "@cosmjs/crypto";
import { toBech32 } from "@cosmjs/encoding";
import { rawSecp256k1PubkeyToRawAddress } from "@cosmjs/amino";
import { makeSignBytes, makeSignDoc, encodePubkey } from "@cosmjs/proto-signing";
import { encodeSecp256k1Pubkey } from "@cosmjs/amino";
import { TxRaw, TxBody, AuthInfo, Fee, SignerInfo } from "cosmjs-types/cosmos/tx/v1beta1/tx";
import { SignMode } from "cosmjs-types/cosmos/tx/signing/v1beta1/signing";
import { MsgExecuteContract } from "cosmjs-types/cosmwasm/wasm/v1/tx";

import { addressOfPublicKey, assembleTx, encodeAuthInfo, encodeMsgExecuteContract, encodeTxBody, prepareExecuteTx, txHashOf } from "../../../server/src/escrow/juno/cosmosTx";
import { publicKeyOf, signDigest, verifyDigest } from "../../../server/src/escrow/juno/secp256k1";
import { secretFromKeyText } from "../../../server/src/escrow/juno/signer";
import { RELAYER_EXECUTE } from "../../../server/src/escrow/juno/junoContract";
import { variantsDigestV1 } from "../gameEngine/escrow/variantsDigest";

const sha = (text: string) => createHash("sha256").update(text).digest();

const CASES = [
  { chainId: "uni-7", accountNumber: "12", sequence: "0", gasLimit: "180000", fee: "13500", timeoutHeight: "1234567", memo: "", msg: RELAYER_EXECUTE.finalize("7") },
  { chainId: "juno-1", accountNumber: "0", sequence: "18446744073709551615", gasLimit: "1500000", fee: "112500", timeoutHeight: "0", memo: "", msg: RELAYER_EXECUTE.start("18446744073709551615", "ab".repeat(32)) },
  { chainId: "uni-7", accountNumber: "300", sequence: "127", gasLimit: "128", fee: "1", timeoutHeight: "128", memo: "escrow-3b", msg: RELAYER_EXECUTE.settle("3", { version: 1 } as never, "cd".repeat(64)) },
];

describe("ESCROW-3B: the relayer's transaction bytes equal CosmJS's", () => {
  it.each(CASES.map((c, i) => [i, c] as const))("case %i: MsgExecuteContract, TxBody, AuthInfo, SignDoc, TxRaw and the tx hash", (_, c) => {
    const secret = sha(`relayer-${c.chainId}-${c.sequence}`);
    const publicKey = publicKeyOf(secret);
    const sender = addressOfPublicKey(publicKey, "juno");
    const contract = addressOfPublicKey(publicKeyOf(sha("contract")), "juno");

    const ours = encodeMsgExecuteContract({ sender, contract, msg: Buffer.from(c.msg, "utf8") });
    const theirs = MsgExecuteContract.encode(MsgExecuteContract.fromPartial({ sender, contract, msg: Buffer.from(c.msg, "utf8"), funds: [] })).finish();
    expect(Buffer.from(ours).toString("hex")).toBe(Buffer.from(theirs).toString("hex"));

    const body = encodeTxBody({ messages: [{ typeUrl: "/cosmwasm.wasm.v1.MsgExecuteContract", value: ours }], memo: c.memo, timeoutHeight: BigInt(c.timeoutHeight) });
    const theirBody = TxBody.encode(TxBody.fromPartial({ messages: [{ typeUrl: "/cosmwasm.wasm.v1.MsgExecuteContract", value: theirs }], memo: c.memo, timeoutHeight: BigInt(c.timeoutHeight) })).finish();
    expect(Buffer.from(body).toString("hex")).toBe(Buffer.from(theirBody).toString("hex"));

    const authInfo = encodeAuthInfo({ publicKey, sequence: BigInt(c.sequence), fee: [{ denom: "ujunox", amount: c.fee }], gasLimit: BigInt(c.gasLimit) });
    const theirAuth = AuthInfo.encode(
      AuthInfo.fromPartial({
        signerInfos: [SignerInfo.fromPartial({ publicKey: encodePubkey(encodeSecp256k1Pubkey(publicKey)), modeInfo: { single: { mode: SignMode.SIGN_MODE_DIRECT } }, sequence: BigInt(c.sequence) })],
        fee: Fee.fromPartial({ amount: [{ denom: "ujunox", amount: c.fee }], gasLimit: BigInt(c.gasLimit) }),
      }),
    ).finish();
    expect(Buffer.from(authInfo).toString("hex")).toBe(Buffer.from(theirAuth).toString("hex"));

    const prepared = prepareExecuteTx({ chainId: c.chainId, accountNumber: c.accountNumber, sequence: c.sequence, sender, contract, msgJson: c.msg, publicKey, gasLimit: c.gasLimit, fee: { denom: "ujunox", amount: c.fee }, timeoutHeight: c.timeoutHeight, memo: c.memo });
    const theirSignBytes = makeSignBytes(makeSignDoc(theirBody, theirAuth, c.chainId, Number(c.accountNumber)));
    expect(Buffer.from(prepared.signDoc).toString("hex")).toBe(Buffer.from(theirSignBytes).toString("hex"));
    expect(Buffer.from(prepared.digest).toString("hex")).toBe(Buffer.from(sha256(theirSignBytes)).toString("hex"));

    const signature = signDigest(secret, prepared.digest);
    const signed = assembleTx(prepared, signature);
    const theirRaw = TxRaw.encode(TxRaw.fromPartial({ bodyBytes: theirBody, authInfoBytes: theirAuth, signatures: [signature] })).finish();
    expect(signed.txBytes.toString("hex")).toBe(Buffer.from(theirRaw).toString("hex"));
    expect(signed.txHash).toBe(Buffer.from(sha256(theirRaw)).toString("hex").toUpperCase());
    expect(txHashOf(theirRaw)).toBe(signed.txHash);
  });

  it("signatures: RFC 6979 low-s identical to @cosmjs/crypto's, and verified both ways", async () => {
    for (let n = 0; n < 6; n += 1) {
      const secret = sha(`k${n}`);
      const digest = sha(`d${n}`);
      const ours = signDigest(secret, digest);
      const theirs = await Secp256k1.createSignature(digest, secret);
      expect(Buffer.from(ours).toString("hex")).toBe(Buffer.from(theirs.toFixedLength()).toString("hex").slice(0, 128));
      const keypair = await Secp256k1.makeKeypair(secret);
      expect(Buffer.from(publicKeyOf(secret)).toString("hex")).toBe(Buffer.from(Secp256k1.compressPubkey(keypair.pubkey)).toString("hex"));
      expect(await Secp256k1.verifySignature(Secp256k1Signature.fromFixedLength(ours), digest, keypair.pubkey)).toBe(true);
      expect(verifyDigest(publicKeyOf(secret), digest, Buffer.from(theirs.toFixedLength().slice(0, 64)))).toBe(true);
    }
  });

  it("the address a key controls and the HD path equal CosmJS's (m/44'/118'/0'/0/0)", async () => {
    /* jsdom has no TextEncoder; @cosmjs/encoding needs one for the mnemonic. */
    const g = globalThis as unknown as { TextEncoder?: unknown; TextDecoder?: unknown };
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const util = require("util") as { TextEncoder: unknown; TextDecoder: unknown };
    g.TextEncoder = g.TextEncoder ?? util.TextEncoder;
    g.TextDecoder = g.TextDecoder ?? util.TextDecoder;
    const words = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    const seed = await Bip39.mnemonicToSeed(new EnglishMnemonic(words));
    const { privkey } = Slip10.derivePath(Slip10Curve.Secp256k1, seed, stringToPath("m/44'/118'/0'/0/0"));
    expect(secretFromKeyText(words).toString("hex")).toBe(Buffer.from(privkey).toString("hex"));
    for (let n = 0; n < 4; n += 1) {
      const publicKey = publicKeyOf(sha(`addr${n}`));
      expect(addressOfPublicKey(publicKey, "juno")).toBe(toBech32("juno", rawSecp256k1PubkeyToRawAddress(publicKey)));
    }
  });

  it("variantsDigestV1 is canonical (key order, undefined) and tag-separated", () => {
    const a = variantsDigestV1({ length: "standard", mode: "live", rules: 1 });
    expect(variantsDigestV1({ rules: 1, mode: "live", length: "standard", extra: undefined })).toBe(a);
    expect(variantsDigestV1({ length: "standard", mode: "async", rules: 1 })).not.toBe(a);
    expect(a).toBe(createHash("sha256").update(`18COSMOS/VARIANTS/v1\n{"length":"standard","mode":"live","rules":1}`).digest("hex"));
    expect(() => variantsDigestV1(null)).toThrow();
  });
});
