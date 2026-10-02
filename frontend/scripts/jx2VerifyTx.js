#!/usr/bin/env node
// frontend/scripts/jx2VerifyTx.js
//
// JX-2A (Phase 5 preparation): THE INDEPENDENT, OFFLINE CHECK OF ONE RELAYER TRANSACTION'S BYTES -- READ ONLY.
//
//   node scripts/jx2VerifyTx.js --tx-base64 <TxRaw base64> | --tx-file <file holding the base64>
//        --chain-id uni-7 --account-number <N> --pubkey <33-byte compressed hex> [--hash <64 upper-hex>]
//        [--contract <juno1...>] [--sequence <N>] [--fee <amount>] [--denom ujunox] [--gas-limit <N>]
//
// It never signs, never broadcasts and never opens a network connection. It reads the bytes a node holds for the
// relayer's transaction (CometBFT RPC `/tx?hash=0x<HASH>` -> `result.tx`, or the intent record's `tx_bytes`) and checks
// them with libraries the relayer does NOT use -- cosmjs-types (protobuf), @cosmjs/proto-signing (the SignDoc rebuilt
// from the DECODED bytes, as the chain does), @cosmjs/crypto and Node's OpenSSL (the signature) -- so the server's
// hand encoder and its own secp256k1 are not grading themselves:
//
//   SHA-256(bytes) = --hash; one MsgExecuteContract, no funds, to --contract, from the address --pubkey controls; the
//   AuthInfo's one signer is --pubkey (secp256k1, SIGN_MODE_DIRECT) at --sequence; the fee and gas limit as given; one
//   64-byte low-s signature that verifies over SignDoc(body, auth_info, --chain-id, --account-number), and does NOT verify
//   under another chain id.
//
// Prints one JSON object (the decoded fields and each check) and exits 0 only if every check passed.

/* global BigInt */
const crypto = require("crypto");
const fs = require("fs");
const { Secp256k1, Secp256k1Signature, sha256 } = require("@cosmjs/crypto");
const { toBech32 } = require("@cosmjs/encoding");
const { rawSecp256k1PubkeyToRawAddress } = require("@cosmjs/amino");
const { makeSignBytes, makeSignDoc } = require("@cosmjs/proto-signing");
const { TxRaw, TxBody, AuthInfo } = require("cosmjs-types/cosmos/tx/v1beta1/tx");
const { SignMode } = require("cosmjs-types/cosmos/tx/signing/v1beta1/signing");
const { PubKey } = require("cosmjs-types/cosmos/crypto/secp256k1/keys");
const { MsgExecuteContract } = require("cosmjs-types/cosmwasm/wasm/v1/tx");

const N = BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141");
const SPKI_PREFIX = Buffer.from("3056301006072a8648ce3d020106052b8104000a034200", "hex");

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith("--") || argv[i + 1] === undefined) throw new Error(`unexpected argument ${argv[i]}`);
    out[argv[i].slice(2)] = argv[i + 1];
  }
  return out;
}

async function verifyTx(input) {
  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok: ok === true, ...(detail === undefined ? {} : { detail }) });
  const bytes = Buffer.from(input.txBase64.trim(), "base64");
  const hash = Buffer.from(sha256(bytes)).toString("hex").toUpperCase();
  if (input.hash !== undefined) check("hash = SHA-256(TxRaw bytes)", hash === input.hash.toUpperCase(), hash);
  const raw = TxRaw.decode(bytes);
  check("re-encoding the decoded TxRaw gives the same bytes (canonical)", Buffer.from(TxRaw.encode(raw).finish()).equals(bytes));
  const body = TxBody.decode(raw.bodyBytes);
  const auth = AuthInfo.decode(raw.authInfoBytes);
  check("one message", body.messages.length === 1);
  check("MsgExecuteContract", body.messages[0]?.typeUrl === "/cosmwasm.wasm.v1.MsgExecuteContract", body.messages[0]?.typeUrl);
  const msg = MsgExecuteContract.decode(body.messages[0].value);
  const pubkey = Buffer.from(input.pubkey, "hex");
  const address = toBech32("juno", rawSecp256k1PubkeyToRawAddress(pubkey));
  check("sender = the address the public key controls", msg.sender === address, `${msg.sender} vs ${address}`);
  if (input.contract !== undefined) check("contract", msg.contract === input.contract, msg.contract);
  check("no funds attached", msg.funds.length === 0);
  let execute = null;
  try {
    execute = JSON.parse(Buffer.from(msg.msg).toString("utf8"));
  } catch {
    /* reported below */
  }
  check("execute message is one JSON route", execute !== null && typeof execute === "object" && Object.keys(execute).length === 1, execute === null ? "unparseable" : Object.keys(execute)[0]);
  check("no extension options", body.extensionOptions.length === 0 && body.nonCriticalExtensionOptions.length === 0);
  check("one signer", auth.signerInfos.length === 1);
  const info = auth.signerInfos[0];
  check("signer key type secp256k1", info.publicKey?.typeUrl === "/cosmos.crypto.secp256k1.PubKey", info.publicKey?.typeUrl);
  check("signer key = --pubkey", Buffer.from(PubKey.decode(info.publicKey.value).key).equals(pubkey));
  check("SIGN_MODE_DIRECT", info.modeInfo?.single?.mode === SignMode.SIGN_MODE_DIRECT);
  if (input.sequence !== undefined) check("sequence", info.sequence === BigInt(input.sequence), info.sequence.toString());
  const fee = auth.fee;
  if (input.fee !== undefined) check("fee amount", fee.amount.length === 1 && fee.amount[0].amount === input.fee, JSON.stringify(fee.amount));
  if (input.denom !== undefined) check("fee denom", fee.amount.length === 1 && fee.amount[0].denom === input.denom);
  if (input.gasLimit !== undefined) check("gas limit", fee.gasLimit === BigInt(input.gasLimit), fee.gasLimit.toString());
  check("no fee payer / granter", fee.payer === "" && fee.granter === "");
  check("one 64-byte signature", raw.signatures.length === 1 && raw.signatures[0].length === 64);
  const signature = Buffer.from(raw.signatures[0]);
  check("low-s", BigInt(`0x${signature.subarray(32).toString("hex")}`) <= N / BigInt(2));
  const signBytes = makeSignBytes(makeSignDoc(raw.bodyBytes, raw.authInfoBytes, input.chainId, Number(input.accountNumber)));
  const cosmjsOk = await Secp256k1.verifySignature(Secp256k1Signature.fromFixedLength(signature), sha256(signBytes), pubkey);
  check("signature verifies (CosmJS) over the SignDoc rebuilt from the decoded bytes", cosmjsOk);
  const key = crypto.createPublicKey({ key: Buffer.concat([SPKI_PREFIX, Buffer.from(Secp256k1.uncompressPubkey(pubkey))]), format: "der", type: "spki" });
  check("signature verifies (OpenSSL)", crypto.verify("sha256", signBytes, { key, dsaEncoding: "ieee-p1363" }, signature));
  const otherChain = makeSignBytes(makeSignDoc(raw.bodyBytes, raw.authInfoBytes, input.chainId === "juno-1" ? "uni-7" : "juno-1", Number(input.accountNumber)));
  check("does NOT verify under another chain id", !crypto.verify("sha256", otherChain, { key, dsaEncoding: "ieee-p1363" }, signature));
  return {
    verdict: checks.every((c) => c.ok) ? "PASS" : "FAIL",
    hash,
    decoded: {
      sender: msg.sender,
      contract: msg.contract,
      route: execute === null ? null : Object.keys(execute)[0],
      memo: body.memo,
      timeout_height: body.timeoutHeight.toString(),
      sequence: info.sequence.toString(),
      fee: fee.amount.map((c) => `${c.amount}${c.denom}`),
      gas_limit: fee.gasLimit.toString(),
    },
    checks,
  };
}

module.exports = { verifyTx };

if (require.main === module) {
  (async () => {
    const a = args(process.argv.slice(2));
    const txBase64 = a["tx-base64"] ?? (a["tx-file"] !== undefined ? fs.readFileSync(a["tx-file"], "utf8") : undefined);
    if (txBase64 === undefined || a["chain-id"] === undefined || a["account-number"] === undefined || a.pubkey === undefined) {
      process.stderr.write("usage: node scripts/jx2VerifyTx.js (--tx-base64 B64 | --tx-file F) --chain-id ID --account-number N --pubkey HEX33 [--hash H] [--contract A] [--sequence N] [--fee AMT] [--denom D] [--gas-limit N]\n");
      process.exit(2);
    }
    const result = await verifyTx({ txBase64, chainId: a["chain-id"], accountNumber: a["account-number"], pubkey: a.pubkey, hash: a.hash, contract: a.contract, sequence: a.sequence, fee: a.fee, denom: a.denom, gasLimit: a["gas-limit"] });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exit(result.verdict === "PASS" ? 0 : 1);
  })().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  });
}
