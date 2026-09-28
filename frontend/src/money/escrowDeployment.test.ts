/** @jest-environment node */
// ESCROW-4: the build's pinned escrow -- read field by field, never half-read; mainnet signs nothing in this phase; a
// table naming any other escrow is refused by name of the differing field.

import { deploymentMismatch, explorerLink, parsePinnedDeployment } from "./escrowDeployment";

const CONTRACT = "juno14hj2tavq8fpesdwxxcu44rty3hh90vhujrvcmstl4zr3txmfvw9skjuwg8";
const PIN = {
  backend: "juno-cosmwasm",
  chainId: "uni-7",
  networkClass: "testnet",
  contract: CONTRACT,
  codeChecksum: "5ecc302221a2dab4bb4f0f71b632f2beeafe9523ebd7b33bd0e94d017b8d09e8",
  denom: "ujunox",
  symbol: "JUNOX",
  exponent: 6,
  rpc: "https://rpc.uni.example",
  rest: "https://api.uni.example",
  chainName: "Juno testnet",
  gasPrice: "0.075",
  explorerTx: "https://explorer.example/tx/{hash}",
};

describe("ESCROW-4: the pinned deployment", () => {
  it("reads a complete pin, and refuses none, an unreadable one, and every bad field by name", () => {
    const ok = parsePinnedDeployment(JSON.stringify(PIN));
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.pin.contract).toBe(CONTRACT);
    expect(parsePinnedDeployment(undefined)).toEqual({ ok: false, reason: expect.stringMatching(/no Juno escrow configured/) });
    expect(parsePinnedDeployment("{not json")).toEqual({ ok: false, reason: expect.stringMatching(/isn't readable/) });
    const bad = (over: Record<string, unknown>, field: string) => {
      const answer = parsePinnedDeployment(JSON.stringify({ ...PIN, ...over }));
      expect([field, answer.ok ? "accepted" : answer.reason]).toEqual([field, expect.stringContaining(`\`${field}\``)]);
    };
    bad({ backend: "gno" }, "backend");
    bad({ chainId: "UNI 7" }, "chainId");
    bad({ networkClass: "devnet" }, "networkClass");
    bad({ contract: "cosmos1abc" }, "contract");
    bad({ codeChecksum: "XYZ" }, "codeChecksum");
    bad({ denom: "U" }, "denom");
    bad({ exponent: 18 }, "exponent");
    bad({ rpc: "http://rpc.uni.example" }, "rpc"); // plain http only on a local chain
    bad({ rest: "https://user:pw@api.example" }, "rest");
    bad({ gasPrice: "0" }, "gasPrice"); // a zero price only on a local chain
    bad({ gasPrice: "1e-3" }, "gasPrice");
    bad({ explorerTx: "https://explorer.example/tx/" }, "explorerTx");
    bad({ extra: 1 }, "extra");
    const local = parsePinnedDeployment(JSON.stringify({ ...PIN, networkClass: "local", rpc: "http://127.0.0.1:26657", rest: "http://127.0.0.1:1317", gasPrice: "0" }));
    expect(local.ok).toBe(true);
  });

  it("a mainnet pin signs nothing in this phase", () => {
    const answer = parsePinnedDeployment(JSON.stringify({ ...PIN, chainId: "juno-1", networkClass: "mainnet", denom: "ujuno", symbol: "JUNO" }));
    expect(answer).toEqual({ ok: false, reason: expect.stringMatching(/mainnet isn't open/) });
    /* A pin that calls Juno's mainnet a testnet is refused by its chain id (review S-L4). */
    expect(parsePinnedDeployment(JSON.stringify({ ...PIN, chainId: "juno-1" }))).toEqual({ ok: false, reason: expect.stringMatching(/mainnet isn't open/) });
  });

  it("a table's deployment is compared on every field; the first difference is named", () => {
    const answer = parsePinnedDeployment(JSON.stringify(PIN));
    if (!answer.ok) throw new Error(answer.reason);
    const view = { backend: "juno-cosmwasm" as const, chainId: "uni-7", networkClass: "testnet" as const, contract: CONTRACT, codeChecksum: PIN.codeChecksum, denom: "ujunox", symbol: "JUNOX", exponent: 6 };
    expect(deploymentMismatch(answer.pin, view)).toBeNull();
    expect(deploymentMismatch(answer.pin, { ...view, contract: "juno1other" })).toBe("contract");
    expect(deploymentMismatch(answer.pin, { ...view, codeChecksum: "0".repeat(64) })).toBe("codeChecksum");
    expect(deploymentMismatch(answer.pin, { ...view, chainId: "juno-1" })).toBe("chainId");
    expect(explorerLink(answer.pin, "ab".repeat(32))).toBe(`https://explorer.example/tx/${"AB".repeat(32)}`);
    expect(explorerLink(answer.pin, "nope")).toBeNull();
  });
});
